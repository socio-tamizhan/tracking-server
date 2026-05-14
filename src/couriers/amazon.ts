import type { CourierAdapter, TrackingEvent, TrackingResult } from '../types.js';
import { emptyResult, isFinal, normalizeStatus, statusLabel } from './base.js';
import { withPage } from '../scraper/browser.js';

// Amazon AMZL India (ZX prefix) tracking options:
//   1. Tokenized tracking links from Amazon SMS/email — scraped via Playwright (works)
//   2. Bare ZX AWB numbers — no public endpoint; return graceful degradation

function buildGracefulResult(awb: string): TrackingResult {
  const result = emptyResult(awb, 'amazon', 'Amazon Delivery');
  result.courier.confidence = 'high';
  result.status = {
    code: 'TRACKING_LINK_REQUIRED',
    label: 'Tracking Link Required',
    description:
      'Amazon does not provide a public tracking API. Use the link from your Amazon order confirmation email or SMS.',
    is_final: false,
  };
  result.raw = {
    note: 'AMZL India (ZX prefix) requires an authenticated Amazon session or a tokenized tracking link.',
    tracking_url: `https://www.amazon.in/progress-tracker/package?ref_=pe_3036200_518584440`,
  };
  return result;
}

async function scrapeTokenizedLink(token: string, awb: string): Promise<TrackingResult> {
  return withPage(async (page) => {
    const url = `https://track.amazon.in/tracking/${token}`;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Amazon's tracking page is server-rendered — wait for status section
    await page.waitForSelector(
      '[class*="status"], [data-testid*="status"], [class*="PackageTracker"], [class*="step"]',
      { timeout: 15000 },
    );

    const result = emptyResult(awb || token, 'amazon', 'Amazon Delivery');
    result.courier.confidence = 'high';
    result.raw = { source: 'tokenized_link', token };

    // Extract current status
    const statusText = await page
      .$eval(
        '[class*="deliveryStatus"], [data-testid="delivery-status"], h1[class*="status"], [class*="PackageStatus"]',
        (el) => el.textContent?.trim() ?? '',
      )
      .catch(() => '');

    const statusCode = normalizeStatus(statusText);
    result.status = {
      code: statusCode,
      label: statusLabel(statusCode),
      description: statusText,
      is_final: isFinal(statusCode),
    };

    // Extract EDD
    const eddText = await page
      .$eval(
        '[class*="edd"], [class*="delivery-date"], [data-testid*="edd"], [class*="EstimatedDelivery"]',
        (el) => el.textContent?.trim() ?? '',
      )
      .catch(() => '');
    result.timeline.estimated_delivery = eddText || null;

    // Extract tracking events / steps
    const events: TrackingEvent[] = [];
    await page
      .$$eval(
        '[class*="step"], [class*="milestone"], [class*="trackingEvent"], [class*="ProgressStep"]',
        (els) =>
          els.map((el) => ({
            text: el.textContent?.trim() ?? '',
            time: (el.querySelector('[class*="time"], [class*="date"]') as HTMLElement)?.textContent?.trim() ?? '',
          })),
      )
      .then((steps) => {
        steps.forEach(({ text, time }) => {
          if (!text) return;
          const code = normalizeStatus(text);
          events.push({ timestamp: time || null, status: code, description: text, location: null, city: null, state: null });
        });
      })
      .catch(() => {});

    result.events = events;

    return result;
  });
}

export const amazon: CourierAdapter = {
  slug: 'amazon',
  name: 'Amazon Delivery',
  patterns: [/^ZX[0-9A-Z]{10,15}$/i],

  async track(awbOrToken: string): Promise<TrackingResult> {
    const upper = awbOrToken.trim().toUpperCase();

    // If it looks like a ZX AWB (no token), return graceful degradation
    if (/^ZX[0-9A-Z]{10,15}$/i.test(upper)) {
      return buildGracefulResult(upper);
    }

    // Otherwise treat it as a tokenized tracking link token
    return scrapeTokenizedLink(awbOrToken, '');
  },
};

// Export a helper so the route layer can detect a full tracking URL
export function extractAmazonToken(input: string): string | null {
  const match = input.match(/track\.amazon\.in\/tracking\/([A-Za-z0-9\-_]+)/);
  return match?.[1] ?? null;
}
