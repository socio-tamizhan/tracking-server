import axios from 'axios';
import * as cheerio from 'cheerio';
import type { CourierAdapter, TrackingEvent, TrackingResult } from '../types.js';
import { BROWSER_HEADERS, emptyResult, isFinal, normalizeStatus, statusLabel } from './base.js';
import { solveRecaptchaOnPage, captchaAvailable } from '../scraper/captcha.js';
import { withPage } from '../scraper/browser.js';

// Speed Post prefixes: EE, EP, EU, EM (international EMS), RX (registered), CP/CX (parcel)
const SERVICE_LABELS: Record<string, string> = {
  EE: 'Speed Post (EMS Domestic)',
  EP: 'Speed Post (Premium)',
  EU: 'Speed Post (Economy)',
  EM: 'EMS (International)',
  RX: 'Registered Post',
  CP: 'Parcel',
  CX: 'Parcel (International)',
};

async function tryCommunitAPI(awb: string): Promise<TrackingResult | null> {
  // Note: india-post-tracker-api.captnemo.in is down (Heroku app deleted).
  // Kept for compatibility in case an alternative is configured via INDIA_POST_TRACKER_API env var.
  const base = process.env.INDIA_POST_TRACKER_API?.replace(/\/$/, '');
  if (!base) return null;
  try {
    const res = await axios.get(
      `${base}/track/${encodeURIComponent(awb)}`,
      { timeout: 10000, headers: { Accept: 'application/json' } },
    );
    const data = res.data;
    if (!data || (Array.isArray(data) && data.length === 0)) return null;

    const events: Array<Record<string, string>> = Array.isArray(data) ? data : [data];
    const result = emptyResult(awb, 'indiapost', 'India Post');
    result.courier.confidence = 'high';
    result.raw = { source: 'community_api', events: data };

    result.events = events.map((e): TrackingEvent => {
      const desc = e.event ?? e.status ?? e.description ?? '';
      const code = normalizeStatus(desc);
      return {
        timestamp: e.date ?? e.timestamp ?? null,
        status: code,
        description: desc,
        location: e.office ?? e.location ?? null,
        city: e.office?.split(' ')[0] ?? null,
        state: null,
      };
    });

    const latestEvent = result.events[0];
    if (latestEvent) {
      const code = latestEvent.status;
      result.status = {
        code,
        label: statusLabel(code),
        description: latestEvent.description,
        is_final: isFinal(code),
      };
      result.location.current_city = latestEvent.city;
      result.location.current_state = latestEvent.state;
    }

    const prefix = awb.slice(0, 2).toUpperCase();
    result.flags.is_express = prefix === 'EE' || prefix === 'EP';
    result.courier.detected = `India Post (${SERVICE_LABELS[prefix] ?? 'Postal Service'})`;

    return result;
  } catch {
    return null;
  }
}

async function tryOfficialPostDirect(awb: string): Promise<TrackingResult | null> {
  // Direct POST to the ASP.NET tracking endpoint — works when the server accepts connections
  try {
    const res = await axios.post(
      'https://www.indiapost.gov.in/_layouts/15/dop.portal.tracking/trackconsignment.aspx',
      new URLSearchParams({ 'ctl00$PlaceHolderMain$ucConsignment$btnSearch': 'Search', ConsignmentNumber: awb }),
      {
        headers: {
          ...BROWSER_HEADERS,
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: 'https://www.indiapost.gov.in/VAS/Pages/trackconsignment.aspx',
        },
        timeout: 20000,
      },
    );
    const result = parseIndiaPostHTML(awb, res.data);
    if (result.events.length === 0) return null;
    return result;
  } catch {
    return null;
  }
}

async function scrapeOfficialSite(awb: string): Promise<TrackingResult> {
  return withPage(async (page) => {
    let interceptedHTML = '';

    page.on('response', async (response) => {
      const url = response.url();
      if (/trackconsignment|track/i.test(url) && response.status() === 200) {
        try {
          const ct = response.headers()['content-type'] ?? '';
          if (ct.includes('html') || ct.includes('text')) {
            interceptedHTML = await response.text();
          }
        } catch { /* skip */ }
      }
    });

    await page.goto('https://www.indiapost.gov.in/VAS/Pages/trackconsignment.aspx', {
      waitUntil: captchaAvailable() ? 'networkidle' : 'domcontentloaded',
      timeout: 30000,
    });

    const input = await page.$('input[id*="TrackInput"], input[id*="Consignment"], input[type="text"]');
    if (input) {
      await input.fill(awb);
      if (captchaAvailable()) await solveRecaptchaOnPage(page);
      await page.click('input[value*="Track"], button[id*="Search"], input[type="submit"]');
      await page.waitForTimeout(3000);
    }

    const html = interceptedHTML || (await page.content());
    const result = parseIndiaPostHTML(awb, html);
    if (result.events.length === 0) throw new Error('NOT_FOUND');
    return result;
  });
}

function parseIndiaPostHTML(awb: string, html: string): TrackingResult {
  const $ = cheerio.load(html);
  const result = emptyResult(awb, 'indiapost', 'India Post');
  result.raw = { source: 'official_website' };

  const events: TrackingEvent[] = [];

  // The results table rows — India Post uses a GridView
  $('table[id*="GridView"] tr, table[id*="Result"] tr, .ms-rtestate-field table tr').each(
    (i, row) => {
      if (i === 0) return; // header
      const cells = $(row).find('td');
      if (cells.length < 3) return;

      const date = $(cells[0]).text().trim();
      const office = $(cells[1]).text().trim();
      const event = $(cells[2]).text().trim();
      if (!event) return;

      const code = normalizeStatus(event);
      events.push({
        timestamp: date || null,
        status: code,
        description: event,
        location: office || null,
        city: office?.split(' ')[0] ?? null,
        state: null,
      });
    },
  );

  result.events = events;

  const latest = events[0];
  if (latest) {
    result.status = {
      code: latest.status,
      label: statusLabel(latest.status),
      description: latest.description,
      is_final: isFinal(latest.status),
    };
    result.location.current_city = latest.city;
  }

  const prefix = awb.slice(0, 2).toUpperCase();
  result.flags.is_express = prefix === 'EE' || prefix === 'EP';
  result.courier.detected = `India Post (${SERVICE_LABELS[prefix] ?? 'Postal Service'})`;
  result.courier.confidence = 'high';

  return result;
}

export const indiapost: CourierAdapter = {
  slug: 'indiapost',
  name: 'India Post',
  patterns: [/^[A-Z]{2}\d{9}(IN|[A-Z]{2})$/i],

  async track(awb: string): Promise<TrackingResult> {
    const upper = awb.toUpperCase();

    const communityResult = await tryCommunitAPI(upper);
    if (communityResult) return communityResult;

    const directResult = await tryOfficialPostDirect(upper);
    if (directResult) return directResult;

    return scrapeOfficialSite(upper);
  },
};
