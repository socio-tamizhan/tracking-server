import axios from 'axios';
import type { CourierAdapter, TrackingEvent, TrackingResult } from '../types.js';
import { BROWSER_HEADERS, daysInTransit, emptyResult, isFinal, normalizeStatus, statusLabel } from './base.js';
import { withPage } from '../scraper/browser.js';

const TRACKING_PAGE = 'https://www.xpressbees.com/shipment/tracking';
const XHR_ENDPOINT = 'https://shipment.xpressbees.com/api/shipments2/track';

async function tryXHR(awb: string): Promise<TrackingResult | null> {
  try {
    const res = await axios.post(
      XHR_ENDPOINT,
      { awb_number: awb },
      {
        timeout: 12000,
        headers: {
          ...BROWSER_HEADERS,
          'Content-Type': 'application/json',
          Origin: 'https://www.xpressbees.com',
          Referer: TRACKING_PAGE,
        },
      },
    );
    const data = res.data;
    if (!data || data.status === false || (!data.data && !data.shipment)) return null;
    return parseXpressbeesResponse(awb, data.data ?? data.shipment ?? data);
  } catch {
    return null;
  }
}

function parseXpressbeesResponse(awb: string, data: Record<string, unknown>): TrackingResult {
  const result = emptyResult(awb, 'xpressbees', 'Xpressbees');
  result.courier.confidence = 'high';
  result.raw = data;

  const rawStatus = String(data.current_status ?? data.status ?? '');
  const statusCode = normalizeStatus(rawStatus);
  result.status = {
    code: statusCode,
    label: statusLabel(statusCode),
    description: rawStatus,
    is_final: isFinal(statusCode),
  };

  const pickupDate = String(data.pickup_date ?? data.pickedup_date ?? '') || null;
  result.timeline = {
    pickup_date: pickupDate,
    estimated_delivery: String(data.edd ?? data.expected_date ?? '') || null,
    actual_delivery: statusCode === 'DELIVERED' ? (String(data.delivered_date ?? '') || null) : null,
    days_in_transit: daysInTransit(pickupDate),
  };

  const scans: Array<Record<string, string>> =
    (data.scans as Array<Record<string, string>>) ??
    (data.tracking_details as Array<Record<string, string>>) ?? [];

  result.events = scans.map((s): TrackingEvent => {
    const desc = s.status_description ?? s.status ?? s.activity ?? '';
    const code = normalizeStatus(desc);
    return {
      timestamp: s.updated_on ?? s.timestamp ?? s.date ?? null,
      status: code,
      description: desc,
      location: s.location ?? s.city ?? null,
      city: s.city ?? s.location?.split(',')[0]?.trim() ?? null,
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
    await page.goto(TRACKING_PAGE, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const input = await page.waitForSelector(
      'input[placeholder*="AWB"], input[placeholder*="tracking"], input[name*="awb"], input[type="text"]',
      { timeout: 10000 },
    );
    await input.fill(awb);

    await page.click('button[type="submit"], button:has-text("Track"), button:has-text("Search")');

    // Wait for results to appear
    await page.waitForSelector(
      '.tracking-result, .shipment-status, table.track-table, [class*="track"]',
      { timeout: 15000 },
    );

    const result = emptyResult(awb, 'xpressbees', 'Xpressbees');
    result.courier.confidence = 'high';

    // Try to intercept JSON from network response
    const events: TrackingEvent[] = [];

    await page.$$eval(
      'tr[class*="track"], .timeline-item, [class*="event-row"], table tbody tr',
      (rows) =>
        rows.map((r) => ({
          text: r.textContent?.trim() ?? '',
          cells: Array.from(r.querySelectorAll('td')).map((td) => (td as HTMLElement).textContent?.trim() ?? ''),
        })),
    ).then((rows) => {
      rows.forEach((row) => {
        if (!row.text) return;
        const desc = row.cells[2] ?? row.cells[1] ?? row.text;
        const ts = row.cells[0] ?? null;
        const loc = row.cells[row.cells.length - 1] ?? null;
        const code = normalizeStatus(desc);
        events.push({ timestamp: ts, status: code, description: desc, location: loc, city: loc?.split(',')[0]?.trim() ?? null, state: null });
      });
    });

    if (events.length === 0) throw new Error('NOT_FOUND');
    result.events = events;
    result.status = { code: events[0].status, label: statusLabel(events[0].status), description: events[0].description, is_final: isFinal(events[0].status) };
    result.location.current_city = events[0].city;

    return result;
  });
}

export const xpressbees: CourierAdapter = {
  slug: 'xpressbees',
  name: 'Xpressbees',
  patterns: [/^XB\d{11,14}$/i],

  async track(awb: string): Promise<TrackingResult> {
    const xhrResult = await tryXHR(awb);
    if (xhrResult) return xhrResult;
    return scrapePlaywright(awb);
  },
};
