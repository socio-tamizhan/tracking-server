import axios from 'axios';
import type { CourierAdapter, TrackingEvent, TrackingResult } from '../types.js';
import { BROWSER_HEADERS, TokenCache, daysInTransit, emptyResult, isFinal, normalizeStatus, statusLabel } from './base.js';
import { withPage } from '../scraper/browser.js';

const tokenCache = new TokenCache();

async function getDHLToken(): Promise<string> {
  const cached = tokenCache.get();
  if (cached) return cached;

  const clientId = process.env.DHL_CLIENT_ID;
  const clientSecret = process.env.DHL_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('DHL credentials not configured');

  const res = await axios.post(
    'https://api-eu.dhl.com/oauth/token',
    'grant_type=client_credentials',
    {
      auth: { username: clientId, password: clientSecret },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    },
  );

  const token: string = res.data.access_token;
  const expiresIn: number = res.data.expires_in ?? 3600;
  tokenCache.set(token, expiresIn);
  return token;
}

function mapDHLStatus(dhlStatus: string): ReturnType<typeof normalizeStatus> {
  const map: Record<string, ReturnType<typeof normalizeStatus>> = {
    'pre-transit': 'PICKUP_PENDING',
    transit: 'IN_TRANSIT',
    'out-for-delivery': 'OUT_FOR_DELIVERY',
    delivered: 'DELIVERED',
    failure: 'EXCEPTION',
    unknown: 'UNKNOWN',
  };
  return map[dhlStatus.toLowerCase()] ?? normalizeStatus(dhlStatus);
}

async function tryDHLApi(awb: string): Promise<TrackingResult | null> {
  try {
    const token = await getDHLToken();

    const res = await axios.get('https://api-eu.dhl.com/track/shipments', {
      params: { trackingNumber: awb },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });

    const shipments = res.data?.shipments;
    if (!shipments || shipments.length === 0) return null;

    const ship = shipments[0];
    const result = emptyResult(awb, 'bluedart', 'Bluedart');
    result.courier.confidence = 'low';
    result.raw = ship;

    const rawStatus: string = ship.status?.status ?? '';
    const statusCode = mapDHLStatus(rawStatus);
    result.status = {
      code: statusCode,
      label: statusLabel(statusCode),
      description: ship.status?.description ?? rawStatus,
      is_final: isFinal(statusCode),
    };

    const pickupDate: string | null =
      [...(ship.events ?? [])].reverse().find((e: Record<string, unknown>) =>
        /picked|manifest/i.test(String(e.description ?? '')),
      )?.timestamp ?? null;
    result.timeline = {
      pickup_date: pickupDate,
      estimated_delivery: ship.estimatedTimeOfDelivery ?? null,
      actual_delivery: statusCode === 'DELIVERED' ? (ship.status?.timestamp ?? null) : null,
      days_in_transit: daysInTransit(pickupDate),
    };

    const origin = ship.origin;
    const dest = ship.destination;
    result.location = {
      current_city: ship.status?.location?.address?.addressLocality ?? null,
      current_state: null,
      current_pincode: null,
      origin_city: origin?.address?.addressLocality ?? null,
      origin_state: null,
      destination_city: dest?.address?.addressLocality ?? null,
      destination_state: null,
      destination_pincode: dest?.address?.postalCode ?? null,
    };

    const events: Array<Record<string, unknown>> = ship.events ?? [];
    result.events = events.map((e): TrackingEvent => {
      const desc = String(e.description ?? '');
      const code = mapDHLStatus(String(e.status ?? ''));
      return {
        timestamp: String(e.timestamp ?? ''),
        status: code,
        description: desc,
        location: (e.location as Record<string, unknown>)?.address
          ? String(((e.location as Record<string, unknown>).address as Record<string, unknown>).addressLocality ?? '')
          : null,
        city: String(((e.location as Record<string, unknown>)?.address as Record<string, unknown>)?.addressLocality ?? '') || null,
        state: null,
      };
    });

    result.flags.is_express = true;
    result.flags.is_rto = statusCode === 'RTO' || statusCode === 'RTO_DELIVERED';

    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'DHL credentials not configured') throw err; // propagate config error for fallback logic
    return null;
  }
}

async function tryBluedartXHR(awb: string): Promise<TrackingResult | null> {
  // Bluedart's tracking page fires a JSON XHR we can replicate
  try {
    const res = await axios.get(
      `https://www.bluedart.com/trackdartresult`,
      {
        params: { trackFor: awb },
        timeout: 12000,
        headers: {
          ...BROWSER_HEADERS,
          Accept: 'application/json, text/plain, */*',
          Referer: 'https://www.bluedart.com/tracking',
          'X-Requested-With': 'XMLHttpRequest',
        },
      },
    );
    const data = res.data;
    if (!data || typeof data !== 'object') return null;
    const payload = Array.isArray(data) ? data[0] : data;
    if (!payload?.Shipment && !payload?.ShipmentDetails && !payload?.Status) return null;
    return parseBluedartDOM(awb, payload);
  } catch {
    return null;
  }
}

function parseBluedartDOM(awb: string, data: Record<string, unknown>): TrackingResult {
  const result = emptyResult(awb, 'bluedart', 'Bluedart');
  result.courier.confidence = 'low';
  result.raw = data;

  const ship = (data.Shipment ?? data.ShipmentDetails ?? data) as Record<string, unknown>;
  const rawStatus = String(ship.Status ?? ship.CurrentStatus ?? data.Status ?? '');
  const statusCode = normalizeStatus(rawStatus);
  result.status = { code: statusCode, label: statusLabel(statusCode), description: rawStatus, is_final: isFinal(statusCode) };

  const pickupDate = String(ship.PickUpDate ?? ship.BookingDate ?? '') || null;
  result.timeline = {
    pickup_date: pickupDate,
    estimated_delivery: String(ship.ExpectedDelivery ?? ship.EDD ?? '') || null,
    actual_delivery: statusCode === 'DELIVERED' ? (String(ship.DeliveredDate ?? '') || null) : null,
    days_in_transit: daysInTransit(pickupDate),
  };

  result.location.destination_city = String(ship.Destination ?? ship.DestinationCity ?? '') || null;

  const scans = (ship.Scans ?? ship.ScanDetails ?? []) as Array<Record<string, string>>;
  result.events = scans.map((s): TrackingEvent => {
    const desc = s.ScanDetail ?? s.Activity ?? s.Status ?? '';
    const code = normalizeStatus(desc);
    return {
      timestamp: s.ScanDate ?? s.Date ?? null,
      status: code,
      description: desc,
      location: s.ScannedLocation ?? s.Location ?? null,
      city: s.ScannedLocation?.split(',')[0]?.trim() ?? null,
      state: null,
    };
  });

  if (result.events.length > 0) result.location.current_city = result.events[0].city;
  result.flags.is_express = true;
  result.flags.is_rto = statusCode === 'RTO' || statusCode === 'RTO_DELIVERED';
  return result;
}

async function scrapePlaywright(awb: string): Promise<TrackingResult> {
  return withPage(async (page) => {
    let interceptedData: Record<string, unknown> | null = null;

    page.on('response', async (response) => {
      const url = response.url();
      if (/track|shipment|dart/i.test(url) && response.status() === 200) {
        try {
          const ct = response.headers()['content-type'] ?? '';
          if (ct.includes('json')) {
            const json = await response.json();
            const payload = Array.isArray(json) ? json[0] : json;
            if (payload?.Shipment || payload?.Status || payload?.ScanDetails || payload?.CurrentStatus) {
              interceptedData = payload;
            }
          }
        } catch { /* skip */ }
      }
    });

    await page.goto(`https://www.bluedart.com/tracking`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Fill the tracking input — use a visible selector
    try {
      const input = await page.waitForSelector(
        'input[placeholder*="Waybill"], input[placeholder*="AWB"], input[placeholder*="waybill"], textarea[placeholder*="waybill"], input[id*="track"], input[name*="track"]:visible',
        { timeout: 8000, state: 'visible' },
      );
      if (input) {
        await input.fill(awb);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(4000);
      }
    } catch {
      // Input not found — site structure changed, rely on intercepted response
    }

    if (interceptedData) return parseBluedartDOM(awb, interceptedData);

    // DOM fallback — parse status table
    const result = emptyResult(awb, 'bluedart', 'Bluedart');
    result.courier.confidence = 'low';
    result.raw = { source: 'playwright_dom' };

    const events: TrackingEvent[] = [];
    const rows = await page.$$eval('table tbody tr, .trackingdetails tr', (els) =>
      els.map((el) => ({
        text: el.textContent?.trim() ?? '',
        cells: Array.from(el.querySelectorAll('td')).map((td) => (td as HTMLElement).textContent?.trim() ?? ''),
      })),
    );
    rows.forEach(({ cells, text }) => {
      const desc = cells[2] ?? cells[1] ?? text;
      if (!desc) return;
      const code = normalizeStatus(desc);
      events.push({ timestamp: cells[0] ?? null, status: code, description: desc, location: cells[1] ?? null, city: cells[1]?.split(',')[0]?.trim() ?? null, state: null });
    });

    if (events.length === 0) throw new Error('NOT_FOUND');
    result.events = events;
    result.status = { code: events[0].status, label: statusLabel(events[0].status), description: events[0].description, is_final: isFinal(events[0].status) };
    result.location.current_city = events[0].city;
    result.flags.is_express = true;

    return result;
  });
}

export const bluedart: CourierAdapter = {
  slug: 'bluedart',
  name: 'Bluedart',
  patterns: [/^\d{8,11}$/],

  async track(awb: string): Promise<TrackingResult> {
    // Try DHL API first (requires creds)
    try {
      const dhlResult = await tryDHLApi(awb);
      if (dhlResult) return dhlResult;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      // If it's a config error, fall through to scraping
      if (msg !== 'DHL credentials not configured') throw err;
    }

    // Try Bluedart's own XHR endpoint
    const xhrResult = await tryBluedartXHR(awb);
    if (xhrResult) return xhrResult;

    // Playwright scrape
    return scrapePlaywright(awb);
  },
};
