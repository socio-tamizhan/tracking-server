import axios from 'axios';
import * as cheerio from 'cheerio';
import type { CourierAdapter, TrackingEvent, TrackingResult } from '../types.js';
import { BROWSER_HEADERS, daysInTransit, emptyResult, isFinal, normalizeStatus, statusLabel } from './base.js';
import { withPage } from '../scraper/browser.js';
import { solveRecaptchaOnPage, captchaAvailable } from '../scraper/captcha.js';

// T1: replicate the ASP.NET tracking endpoint DTDC's own site posts to
async function tryASPEndpoint(awb: string): Promise<TrackingResult | null> {
  try {
    const res = await axios.post(
      'https://www.dtdc.in/tracking/shipmenttracking_t.asp',
      `trkType=awb&strcnno=${encodeURIComponent(awb)}&buttonType=awb`,
      {
        timeout: 15000,
        headers: {
          ...BROWSER_HEADERS,
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: 'https://www.dtdc.in/track-order/',
          Origin: 'https://www.dtdc.in',
        },
      },
    );
    return parseDTDCHTML(awb, res.data);
  } catch {
    return null;
  }
}

// T1 alternative: newer JSON endpoint used by DTDC's updated site
async function tryJSONEndpoint(awb: string): Promise<TrackingResult | null> {
  try {
    const res = await axios.post(
      'https://tracking.dtdc.com/ctbs-tracking/customerInterface.tr',
      { awbNo: awb, intfType: 'CNNO' },
      {
        timeout: 15000,
        headers: {
          ...BROWSER_HEADERS,
          'Content-Type': 'application/json',
          Referer: 'https://www.dtdc.in/track-order/',
          Origin: 'https://www.dtdc.in',
        },
      },
    );
    const data = res.data;
    if (!data || data.errorCode) return null;
    return parseDTDCJSON(awb, data);
  } catch {
    return null;
  }
}

function parseDTDCJSON(awb: string, data: Record<string, unknown>): TrackingResult {
  const result = emptyResult(awb, 'dtdc', 'DTDC');
  result.courier.confidence = 'medium';
  result.raw = data;

  const trackDetails: Array<Record<string, string>> =
    (data.trackingDetails as Array<Record<string, string>>) ??
    (data.shipmentTrackDetails as Array<Record<string, string>>) ?? [];

  const rawStatus = trackDetails[0]?.status ?? String(data.currentStatus ?? '');
  const statusCode = normalizeStatus(rawStatus);
  result.status = { code: statusCode, label: statusLabel(statusCode), description: rawStatus, is_final: isFinal(statusCode) };

  result.events = trackDetails.map((e): TrackingEvent => {
    const desc = e.status ?? e.activity ?? '';
    const code = normalizeStatus(desc);
    return {
      timestamp: e.date ? `${e.date} ${e.time ?? ''}`.trim() : null,
      status: code,
      description: desc,
      location: e.location ?? e.origin ?? null,
      city: e.location?.split(' ')[0] ?? null,
      state: null,
    };
  });

  if (result.events.length > 0) {
    result.location.current_city = result.events[0].city;
  }

  const pickupDate = [...result.events].reverse().find((e: TrackingEvent) =>
    /pickup|manifest|booked/i.test(e.description),
  )?.timestamp ?? null;
  result.timeline = { pickup_date: pickupDate, estimated_delivery: null, actual_delivery: null, days_in_transit: daysInTransit(pickupDate) };
  result.flags.is_rto = statusCode === 'RTO' || statusCode === 'RTO_DELIVERED';

  return result;
}

function parseDTDCHTML(awb: string, html: string): TrackingResult | null {
  const $ = cheerio.load(html);
  const result = emptyResult(awb, 'dtdc', 'DTDC');
  result.courier.confidence = 'medium';
  result.raw = { source: 'asp_html' };

  const events: TrackingEvent[] = [];

  // DTDC result table structure
  $('table#shipmentResult tbody tr, table.tracking-table tbody tr, table tbody tr').each(
    (i, row) => {
      const cells = $(row).find('td');
      if (cells.length < 2) return;
      const date = $(cells[0]).text().trim();
      const loc = $(cells[1]).text().trim();
      const activity = $(cells[2] ?? cells[1]).text().trim();
      if (!activity && !date) return;

      const desc = activity || loc;
      const code = normalizeStatus(desc);
      events.push({
        timestamp: date || null,
        status: code,
        description: desc,
        location: loc || null,
        city: loc?.split(',')[0]?.trim() ?? null,
        state: null,
      });
    },
  );

  if (events.length === 0) return null; // page didn't return tracking data

  result.events = events;
  result.status = { code: events[0].status, label: statusLabel(events[0].status), description: events[0].description, is_final: isFinal(events[0].status) };
  result.location.current_city = events[0].city;

  const pickupDate = [...events].reverse().find((e: TrackingEvent) => /pickup|manifest|booked/i.test(e.description))?.timestamp ?? null;
  result.timeline = { pickup_date: pickupDate, estimated_delivery: null, actual_delivery: null, days_in_transit: daysInTransit(pickupDate) };
  result.flags.is_rto = result.status.code === 'RTO' || result.status.code === 'RTO_DELIVERED';

  return result;
}

async function scrapePlaywright(awb: string): Promise<TrackingResult> {
  return withPage(async (page) => {
    let interceptedData: Record<string, unknown> | null = null;

    page.on('response', async (response) => {
      const url = response.url();
      if (/track|ctbs|shipment/i.test(url) && response.status() === 200) {
        try {
          const ct = response.headers()['content-type'] ?? '';
          if (ct.includes('json')) {
            const json = await response.json();
            if (json?.trackingDetails || json?.shipmentTrackDetails || json?.currentStatus) {
              interceptedData = json;
            }
          }
        } catch { /* skip */ }
      }
    });

    await page.goto('https://www.dtdc.in/track-order/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Try various input selectors — DTDC changes their UI periodically
    const inputSel = [
      'input[id*="txtTrackNum"]',
      'input[name*="cnno"]',
      'input[placeholder*="AWB"]',
      'input[placeholder*="Consignment"]',
      'input[placeholder*="consignment"]',
      'input[placeholder*="tracking"]',
      'textarea[placeholder*="track"]',
      'input[type="text"]',
    ].join(', ');

    const input = await page.$(inputSel);
    if (input) {
      await input.fill(awb);

      const hasCaptcha = await page.$('[data-sitekey], .g-recaptcha, #captchaDiv') !== null;
      if (hasCaptcha && captchaAvailable()) await solveRecaptchaOnPage(page);

      await page.click('button[id*="btnTrack"], input[value*="Track"], button:has-text("Track"), button[type="submit"]');
      await page.waitForTimeout(4000);
    }

    if (interceptedData) return parseDTDCJSON(awb, interceptedData);

    const html = await page.content();
    const parsed = parseDTDCHTML(awb, html);
    if (parsed && parsed.events.length > 0) return parsed;

    throw new Error('NOT_FOUND');
  });
}

export const dtdc: CourierAdapter = {
  slug: 'dtdc',
  name: 'DTDC',
  patterns: [/^[ZDABM]\d{7,11}$/, /^[A-Z]{2}\d{6,10}$/i],

  async track(awb: string): Promise<TrackingResult> {
    const jsonResult = await tryJSONEndpoint(awb);
    if (jsonResult) return jsonResult;

    const aspResult = await tryASPEndpoint(awb);
    if (aspResult) return aspResult;

    return scrapePlaywright(awb);
  },
};
