import { Router, Request, Response } from 'express';
import type { TrackError, TrackingResult } from '../types.js';
import { detectCourier, isAmbiguous } from '../detector.js';
import { ALL_COURIERS, COURIER_BY_SLUG, resolveCourierSlug } from '../couriers/index.js';
import { extractAmazonToken } from '../couriers/amazon.js';
import { TTLCache } from '../cache.js';

const router = Router();
const cache = new TTLCache<TrackingResult>(
  Number(process.env.CACHE_TTL_SECONDS ?? 300),
);

async function resolveAndTrack(
  awbInput: string,
  courierHint?: string,
): Promise<TrackingResult> {
  const awb = awbInput.trim().toUpperCase();

  // Check if it's an Amazon tracking URL — extract token
  const amazonToken = extractAmazonToken(awbInput);
  if (amazonToken) {
    const amazon = COURIER_BY_SLUG.get('amazon')!;
    return amazon.track(amazonToken);
  }

  // User provided a courier hint
  if (courierHint) {
    const slug = resolveCourierSlug(courierHint);
    const courier = COURIER_BY_SLUG.get(slug);
    if (!courier) {
      const err: TrackError = {
        error: 'INVALID_INPUT',
        message: `Unknown courier: "${courierHint}". Valid slugs: ${ALL_COURIERS.map((c) => c.slug).join(', ')}`,
      };
      throw Object.assign(new Error(err.message), { trackError: err });
    }
    return courier.track(awb);
  }

  // Auto-detect
  const matches = detectCourier(awb);

  if (matches.length === 0) {
    // No pattern matched — try every courier in parallel and take first success
    const results = await Promise.allSettled(
      ALL_COURIERS.map((c) => c.track(awb)),
    );
    const success = results.find((r): r is PromiseFulfilledResult<TrackingResult> => r.status === 'fulfilled');
    if (success) return success.value;

    const err: TrackError = { error: 'NOT_FOUND', message: 'Tracking number not found with any courier', tracking_number: awb };
    throw Object.assign(new Error(err.message), { trackError: err });
  }

  // Try pattern-matched couriers first (high confidence wins immediately)
  const matchedSlugs = new Set(matches.map((m) => m.slug));
  const matchedCouriers = matches.map((m) => COURIER_BY_SLUG.get(m.slug)!).filter(Boolean);

  // For a single high-confidence match, try it and fall through on failure
  // For ambiguous/medium, probe matched couriers in parallel first
  const firstRound = await Promise.allSettled(matchedCouriers.map((c) => c.track(awb)));
  const firstHit = firstRound.find((r): r is PromiseFulfilledResult<TrackingResult> => r.status === 'fulfilled');
  if (firstHit) return firstHit.value;

  // None of the pattern-matched couriers found it — try all remaining couriers
  const remaining = ALL_COURIERS.filter((c) => !matchedSlugs.has(c.slug));
  const secondRound = await Promise.allSettled(remaining.map((c) => c.track(awb)));
  const secondHit = secondRound.find((r): r is PromiseFulfilledResult<TrackingResult> => r.status === 'fulfilled');
  if (secondHit) return secondHit.value;

  const err: TrackError = { error: 'NOT_FOUND', message: 'Tracking number not found with any courier', tracking_number: awb };
  throw Object.assign(new Error(err.message), { trackError: err });
}

// ── POST /track ───────────────────────────────────────────────────────────
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const { tracking_number, courier } = req.body as { tracking_number?: string; courier?: string };

  if (!tracking_number || typeof tracking_number !== 'string' || !tracking_number.trim()) {
    res.status(400).json({ error: 'INVALID_INPUT', message: 'tracking_number is required' });
    return;
  }

  const cacheKey = `${tracking_number.trim().toUpperCase()}:${courier ?? ''}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT').json(cached);
    return;
  }

  try {
    const result = await resolveAndTrack(tracking_number, courier);
    cache.set(cacheKey, result);
    res.setHeader('X-Cache', 'MISS').json(result);
  } catch (err: unknown) {
    const trackError = (err as { trackError?: TrackError }).trackError;
    if (trackError) {
      const statusMap: Record<string, number> = {
        NOT_FOUND: 404, AMBIGUOUS: 300, INVALID_INPUT: 400,
        COURIER_UNAVAILABLE: 503, UPSTREAM_ERROR: 502,
      };
      res.status(statusMap[trackError.error] ?? 500).json(trackError);
    } else {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      if (msg === 'NOT_FOUND') {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Tracking number not found', tracking_number });
      } else {
        console.error('[track] upstream error:', msg);
        res.status(502).json({ error: 'UPSTREAM_ERROR', message: msg });
      }
    }
  }
});

// ── GET /track/:awb ───────────────────────────────────────────────────────
router.get('/:awb', async (req: Request, res: Response): Promise<void> => {
  const awb = req.params.awb;
  const courier = req.query.courier as string | undefined;

  const cacheKey = `${awb.trim().toUpperCase()}:${courier ?? ''}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT').json(cached);
    return;
  }

  try {
    const result = await resolveAndTrack(awb, courier);
    cache.set(cacheKey, result);
    res.setHeader('X-Cache', 'MISS').json(result);
  } catch (err: unknown) {
    const trackError = (err as { trackError?: TrackError }).trackError;
    if (trackError) {
      const statusMap: Record<string, number> = {
        NOT_FOUND: 404, AMBIGUOUS: 300, INVALID_INPUT: 400,
        COURIER_UNAVAILABLE: 503, UPSTREAM_ERROR: 502,
      };
      res.status(statusMap[trackError.error] ?? 500).json(trackError);
    } else {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      if (msg === 'NOT_FOUND') {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Tracking number not found', tracking_number: awb });
      } else {
        console.error('[track] upstream error:', msg);
        res.status(502).json({ error: 'UPSTREAM_ERROR', message: msg });
      }
    }
  }
});

export default router;
