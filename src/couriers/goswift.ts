import axios from 'axios';
import type { CourierAdapter, TrackingEvent, TrackingResult } from '../types.js';
import { BROWSER_HEADERS, daysInTransit, emptyResult, isFinal, normalizeStatus, statusLabel } from './base.js';
import { withPage } from '../scraper/browser.js';

const TRACKING_URL = 'https://checkout.goswift.in/tracking';

async function tryXHR(awb: string): Promise<TrackingResult | null> {
  // Goswift uses an SPA; attempt a couple of likely API shapes
  const candidates = [
    { method: 'GET' as const, url: `https://checkout.goswift.in/api/v1/track/${awb}` },
    { method: 'POST' as const, url: `https://checkout.goswift.in/api/v1/shipments/track`, body: { trackingId: awb } },
    { method: 'GET' as const, url: `https://app.goswift.in/api/v1/track/${awb}` },
  ];

  for (const candidate of candidates) {
    try {
      const res =
        candidate.method === 'GET'
          ? await axios.get(candidate.url, {
              timeout: 10000,
              headers: { ...BROWSER_HEADERS, Origin: 'https://checkout.goswift.in', Referer: TRACKING_URL },
            })
          : await axios.post(candidate.url, candidate.body, {
              timeout: 10000,
              headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/json', Origin: 'https://checkout.goswift.in', Referer: TRACKING_URL },
            });

      const data = res.data;
      if (data && (data.status || data.current_status || data.trackingDetails)) {
        return parseGoswiftResponse(awb, data);
      }
    } catch { /* try next */ }
  }
  return null;
}

function parseGoswiftResponse(awb: string, data: Record<string, unknown>): TrackingResult {
  const result = emptyResult(awb, 'goswift', 'Goswift');
  result.courier.confidence = 'high';
  result.raw = data;

  const rawStatus = String(data.status ?? data.current_status ?? data.shipmentStatus ?? '');
  const statusCode = normalizeStatus(rawStatus);
  result.status = {
    code: statusCode,
    label: statusLabel(statusCode),
    description: rawStatus,
    is_final: isFinal(statusCode),
  };

  const pickupDate = String(data.pickupDate ?? data.pickup_date ?? '') || null;
  result.timeline = {
    pickup_date: pickupDate,
    estimated_delivery: String(data.edd ?? data.expectedDelivery ?? '') || null,
    actual_delivery: statusCode === 'DELIVERED' ? (String(data.deliveredDate ?? data.delivered_at ?? '') || null) : null,
    days_in_transit: daysInTransit(pickupDate),
  };

  const rawEvents: Array<Record<string, string>> =
    (data.trackingDetails as Array<Record<string, string>>) ??
    (data.events as Array<Record<string, string>>) ??
    (data.activities as Array<Record<string, string>>) ?? [];

  result.events = rawEvents.map((e): TrackingEvent => {
    const desc = e.status ?? e.activity ?? e.description ?? e.event ?? '';
    const code = normalizeStatus(desc);
    return {
      timestamp: e.timestamp ?? e.date ?? e.createdAt ?? null,
      status: code,
      description: desc,
      location: e.location ?? e.city ?? null,
      city: e.city ?? e.location?.split(',')[0]?.trim() ?? null,
      state: null,
    };
  });

  if (result.events.length > 0) {
    result.location.current_city = result.events[0].city;
  }

  result.flags.is_rto = statusCode === 'RTO' || statusCode === 'RTO_DELIVERED';
  return result;
}

async function scrapePlaywright(awb: string): Promise<TrackingResult> {
  return withPage(async (page) => {
    let interceptedData: Record<string, unknown> | null = null;

    page.on('response', async (response) => {
      const url = response.url();
      if (/track|shipment|order/i.test(url) && response.status() === 200) {
        try {
          const ct = response.headers()['content-type'] ?? '';
          if (ct.includes('json')) {
            const json = await response.json();
            if (json?.status || json?.trackingDetails || json?.current_status) {
              interceptedData = json;
            }
          }
        } catch { /* not JSON */ }
      }
    });

    await page.goto(`${TRACKING_URL}?trackingId=${awb}`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    if (!interceptedData) {
      // Try filling the tracking form if present
      const input = await page.$('input[placeholder*="track"], input[placeholder*="AWB"], input[type="text"]');
      if (input) {
        await input.fill(awb);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(3000);
      }
    }

    if (interceptedData) return parseGoswiftResponse(awb, interceptedData);

    // DOM fallback
    const result = emptyResult(awb, 'goswift', 'Goswift');
    result.courier.confidence = 'high';
    result.raw = { source: 'playwright_dom' };

    const events: TrackingEvent[] = [];
    const rows = await page.$$eval(
      '[class*="track"] [class*="event"], [class*="timeline"] li, table tbody tr',
      (els) => els.map((el) => el.textContent?.trim() ?? ''),
    );
    rows.forEach((text) => {
      if (!text) return;
      const code = normalizeStatus(text);
      events.push({ timestamp: null, status: code, description: text, location: null, city: null, state: null });
    });

    if (events.length === 0) throw new Error('NOT_FOUND');
    result.events = events;
    result.status = { code: events[0].status, label: statusLabel(events[0].status), description: events[0].description, is_final: isFinal(events[0].status) };

    return result;
  });
}

export const goswift: CourierAdapter = {
  slug: 'goswift',
  name: 'Goswift',
  patterns: [/^GS[A-Z0-9]{8,14}$/i],

  async track(awb: string): Promise<TrackingResult> {
    const xhrResult = await tryXHR(awb);
    if (xhrResult) return xhrResult;
    return scrapePlaywright(awb);
  },
};
