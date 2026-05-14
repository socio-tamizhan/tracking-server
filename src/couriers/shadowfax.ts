import axios from 'axios';
import type { CourierAdapter, TrackingEvent, TrackingResult } from '../types.js';
import { BROWSER_HEADERS, daysInTransit, emptyResult, isFinal, normalizeStatus, statusLabel } from './base.js';
import { withPage } from '../scraper/browser.js';

const TRACKING_BASE = 'https://shadowfax.in';

async function tryXHR(awb: string): Promise<TrackingResult | null> {
  try {
    // Step 1: Get session cookies from the tracking page
    const pageRes = await axios.get(`${TRACKING_BASE}/tracking/?order_id=${awb}`, {
      timeout: 12000,
      headers: { ...BROWSER_HEADERS },
      maxRedirects: 5,
    });

    const cookies = (pageRes.headers['set-cookie'] ?? [])
      .map((c: string) => c.split(';')[0])
      .join('; ');

    // Step 2: Call the API with the session cookie
    const apiRes = await axios.get(`${TRACKING_BASE}/api/v1/track/?order_id=${awb}`, {
      timeout: 12000,
      headers: {
        ...BROWSER_HEADERS,
        Cookie: cookies,
        Referer: `${TRACKING_BASE}/tracking/?order_id=${awb}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
    });

    const data = apiRes.data;
    if (!data || !data.status) return null;
    return parseShadowfaxResponse(awb, data);
  } catch {
    return null;
  }
}

function parseShadowfaxResponse(awb: string, data: Record<string, unknown>): TrackingResult {
  const result = emptyResult(awb, 'shadowfax', 'Shadowfax');
  result.courier.confidence = 'high';
  result.raw = data;

  const rawStatus = String(data.status ?? data.current_status ?? '');
  const statusCode = normalizeStatus(rawStatus);
  result.status = {
    code: statusCode,
    label: statusLabel(statusCode),
    description: rawStatus,
    is_final: isFinal(statusCode),
  };

  const pickupDate = String(data.pickup_time ?? data.pickup_date ?? '') || null;
  result.timeline = {
    pickup_date: pickupDate,
    estimated_delivery: String(data.expected_delivery_time ?? data.edd ?? '') || null,
    actual_delivery: statusCode === 'DELIVERED' ? (String(data.delivered_at ?? '') || null) : null,
    days_in_transit: daysInTransit(pickupDate),
  };

  const tracking: Array<Record<string, string>> =
    (data.tracking as Array<Record<string, string>>) ??
    (data.events as Array<Record<string, string>>) ?? [];

  result.events = tracking.map((e): TrackingEvent => {
    const desc = e.status ?? e.description ?? e.event ?? '';
    const code = normalizeStatus(desc);
    return {
      timestamp: e.created_at ?? e.timestamp ?? e.time ?? null,
      status: code,
      description: desc,
      location: e.location ?? null,
      city: e.city ?? e.location?.split(',')[0]?.trim() ?? null,
      state: null,
    };
  });

  if (result.events.length > 0) {
    result.location.current_city = result.events[0].city;
  }

  const attempts = tracking.filter((e) =>
    /undeliver|failed|ndr/i.test(e.status ?? e.event ?? ''),
  );
  result.delivery_attempts = {
    count: attempts.length || null,
    last_attempt_date: attempts[0]?.created_at ?? null,
    failure_reason: null,
  };

  result.flags.is_rto = statusCode === 'RTO' || statusCode === 'RTO_DELIVERED';
  result.flags.is_ndr = attempts.length > 0;

  return result;
}

async function scrapePlaywright(awb: string): Promise<TrackingResult> {
  return withPage(async (page) => {
    // Intercept API responses during page load
    let interceptedData: Record<string, unknown> | null = null;
    page.on('response', async (response) => {
      const url = response.url();
      if (/api.*track|track.*api/i.test(url) && response.status() === 200) {
        try {
          const json = await response.json();
          if (json?.status || json?.current_status) interceptedData = json;
        } catch { /* not JSON */ }
      }
    });

    await page.goto(`${TRACKING_BASE}/tracking/?order_id=${awb}`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    if (interceptedData) return parseShadowfaxResponse(awb, interceptedData);

    // Fallback: parse DOM
    const result = emptyResult(awb, 'shadowfax', 'Shadowfax');
    result.courier.confidence = 'high';

    const events: TrackingEvent[] = [];
    await page.$$eval(
      '.tracking-event, .timeline-item, [class*="event"], table tbody tr',
      (els) => els.map((el) => ({ text: el.textContent?.trim() ?? '', ts: (el.querySelector('[class*="time"], [class*="date"]') as HTMLElement)?.textContent?.trim() ?? '' })),
    ).then((items) => {
      items.forEach(({ text, ts }) => {
        if (!text) return;
        const code = normalizeStatus(text);
        events.push({ timestamp: ts || null, status: code, description: text, location: null, city: null, state: null });
      });
    });

    if (events.length === 0) throw new Error('NOT_FOUND');
    result.events = events;
    result.status = { code: events[0].status, label: statusLabel(events[0].status), description: events[0].description, is_final: isFinal(events[0].status) };

    return result;
  });
}

export const shadowfax: CourierAdapter = {
  slug: 'shadowfax',
  name: 'Shadowfax',
  patterns: [/^SFX\d{8,}$/i, /^SX\d{10,}$/i],

  async track(awb: string): Promise<TrackingResult> {
    const xhrResult = await tryXHR(awb);
    if (xhrResult) return xhrResult;
    return scrapePlaywright(awb);
  },
};
