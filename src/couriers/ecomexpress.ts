import axios from 'axios';
import type { CourierAdapter, TrackingEvent, TrackingResult } from '../types.js';
import { BROWSER_HEADERS, daysInTransit, emptyResult, isFinal, normalizeStatus, statusLabel } from './base.js';
import { withPage } from '../scraper/browser.js';

// NOTE: Ecom Express was acquired by Delhivery in April 2025.
// The API endpoint is still operational but may be deprecated.
// If this adapter throws NOT_FOUND consistently, the AWB may have
// migrated to Delhivery's system — the courier registry retries with Delhivery.

async function tryPublicEndpoint(awb: string): Promise<TrackingResult | null> {
  try {
    const res = await axios.get(`https://ecomexpress.in/tracking/?awb_field=${awb}`, {
      timeout: 12000,
      headers: {
        ...BROWSER_HEADERS,
        Accept: 'application/json, text/html, */*',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: 'https://ecomexpress.in/tracking/',
      },
    });

    const data = res.data;
    // Site returns JSON when XHR header is present
    if (typeof data === 'object' && data !== null) {
      const payload = Array.isArray(data) ? data[0] : data;
      if (payload?.awb_number || payload?.tracking_details) {
        return parseEcomResponse(awb, payload);
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function tryApiEndpoint(awb: string): Promise<TrackingResult | null> {
  // Their documented API — may require credentials for prod but returns
  // limited data for public AWBs on staging
  try {
    const res = await axios.get(
      `https://api.ecomexpress.in/apiv2/track_me/?awb=${awb}`,
      {
        timeout: 12000,
        headers: { ...BROWSER_HEADERS, Referer: 'https://ecomexpress.in/' },
      },
    );
    const data = res.data;
    if (!data || data.success === false) return null;
    const payload = Array.isArray(data) ? data[0] : data;
    return parseEcomResponse(awb, payload);
  } catch {
    return null;
  }
}

function parseEcomResponse(awb: string, data: Record<string, unknown>): TrackingResult {
  const result = emptyResult(awb, 'ecomexpress', 'Ecom Express');
  result.courier.confidence = 'low'; // 10-digit numeric is ambiguous
  result.raw = data;

  const rawStatus = String(data.current_status ?? data.status ?? '');
  const statusCode = normalizeStatus(rawStatus);
  result.status = { code: statusCode, label: statusLabel(statusCode), description: rawStatus, is_final: isFinal(statusCode) };

  const pickupDate = String(data.pickup_date ?? '') || null;
  result.timeline = {
    pickup_date: pickupDate,
    estimated_delivery: String(data.expected_delivery_date ?? data.edd ?? '') || null,
    actual_delivery: statusCode === 'DELIVERED' ? (String(data.delivered_date ?? '') || null) : null,
    days_in_transit: daysInTransit(pickupDate),
  };

  const scanDetails: Array<Record<string, string>> =
    (data.scans as Array<Record<string, string>>) ??
    (data.tracking_details as Array<Record<string, string>>) ?? [];

  result.events = scanDetails.map((s): TrackingEvent => {
    const desc = s.activity ?? s.status ?? s.remarks ?? '';
    const code = normalizeStatus(desc);
    return {
      timestamp: s.updated_on ?? s.scan_date ?? s.date ?? null,
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

  result.location.destination_city = String(data.consignee_city ?? '') || null;
  result.shipment_details.weight_kg = data.weight ? Number(data.weight) : null;

  const ndrCount = scanDetails.filter((s) =>
    /undeliver|ndr|failed|attempt/i.test(s.activity ?? s.status ?? ''),
  ).length;
  result.delivery_attempts = { count: ndrCount || null, last_attempt_date: scanDetails[0]?.scan_date ?? null, failure_reason: null };

  result.flags.is_rto = statusCode === 'RTO' || statusCode === 'RTO_DELIVERED';
  result.flags.is_ndr = ndrCount > 0;
  result.flags.cod_amount = data.cod_amount ? Number(data.cod_amount) : null;

  return result;
}

async function scrapePlaywright(awb: string): Promise<TrackingResult> {
  return withPage(async (page) => {
    let interceptedData: Record<string, unknown> | null = null;

    page.on('response', async (response) => {
      if (/track|awb/i.test(response.url()) && response.status() === 200) {
        try {
          const ct = response.headers()['content-type'] ?? '';
          if (ct.includes('json')) {
            const json = await response.json();
            if (json?.awb_number || json?.tracking_details || json?.current_status) {
              interceptedData = Array.isArray(json) ? json[0] : json;
            }
          }
        } catch { /* skip */ }
      }
    });

    await page.goto('https://ecomexpress.in/tracking/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    const input = await page.$('input[name*="awb"], input[placeholder*="AWB"], input[id*="awb"]');
    if (input) {
      await input.fill(awb);
      await page.click('button[type="submit"], button:has-text("Track"), input[type="submit"]');
      await page.waitForTimeout(3000);
    }

    if (interceptedData) return parseEcomResponse(awb, interceptedData);

    // DOM fallback
    const result = emptyResult(awb, 'ecomexpress', 'Ecom Express');
    result.courier.confidence = 'low';
    result.raw = { source: 'playwright_dom' };

    const events: TrackingEvent[] = [];
    const rows = await page.$$eval('table tbody tr, .tracking-steps li', (els) =>
      els.map((el) => ({
        text: el.textContent?.trim() ?? '',
        cells: Array.from(el.querySelectorAll('td')).map((td) => (td as HTMLElement).textContent?.trim() ?? ''),
      })),
    );
    rows.forEach(({ text, cells }) => {
      const desc = cells[2] ?? cells[1] ?? text;
      if (!desc) return;
      const code = normalizeStatus(desc);
      events.push({ timestamp: cells[0] ?? null, status: code, description: desc, location: cells[1] ?? null, city: cells[1]?.split(',')[0]?.trim() ?? null, state: null });
    });

    if (events.length === 0) throw new Error('NOT_FOUND');
    result.events = events;
    result.status = { code: events[0].status, label: statusLabel(events[0].status), description: events[0].description, is_final: isFinal(events[0].status) };
    result.location.current_city = events[0].city;

    return result;
  });
}

export const ecomexpress: CourierAdapter = {
  slug: 'ecomexpress',
  name: 'Ecom Express',
  patterns: [/^\d{10}$/],

  async track(awb: string): Promise<TrackingResult> {
    const publicResult = await tryPublicEndpoint(awb);
    if (publicResult) return publicResult;

    const apiResult = await tryApiEndpoint(awb);
    if (apiResult) return apiResult;

    return scrapePlaywright(awb);
  },
};
