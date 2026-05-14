import axios from 'axios';
import * as cheerio from 'cheerio';
import type { CourierAdapter, TrackingEvent, TrackingResult } from '../types.js';
import { BROWSER_HEADERS, TokenCache, daysInTransit, emptyResult, isFinal, normalizeStatus, statusLabel } from './base.js';

const BASE = 'https://apiv2.shiprocket.in/v1/external';
const tokenCache = new TokenCache();

async function getToken(): Promise<string> {
  const cached = tokenCache.get();
  if (cached) return cached;

  const email = process.env.SHIPROCKET_EMAIL;
  const password = process.env.SHIPROCKET_PASSWORD;
  if (!email || !password) throw new Error('Shiprocket credentials not configured');

  const res = await axios.post(`${BASE}/auth/login`, { email, password }, { timeout: 10000 });
  const token: string = res.data.token;
  tokenCache.set(token, 9 * 24 * 60 * 60);
  return token;
}

async function tryShiprocketApi(awb: string): Promise<TrackingResult | null> {
  try {
    const token = await getToken();

    const res = await axios.get(`${BASE}/courier/track/awb/${awb}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });

    const td = res.data?.tracking_data;
    if (!td || td.track_status === 0) return null;

    const shipTrack = td.shipment_track?.[0];
    if (!shipTrack) return null;

    return parseShiprocketResponse(awb, td, shipTrack);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'Shiprocket credentials not configured') throw err;
    return null;
  }
}

function parseShiprocketResponse(
  awb: string,
  td: Record<string, unknown>,
  shipTrack: Record<string, unknown>,
): TrackingResult {
  const result = emptyResult(awb, 'shiprocket', 'Shiprocket');
  result.courier.confidence = 'high';
  result.raw = td;

  const rawStatus = String(shipTrack.current_status ?? '');
  const statusCode = normalizeStatus(rawStatus);
  result.status = {
    code: statusCode,
    label: statusLabel(statusCode),
    description: rawStatus,
    is_final: isFinal(statusCode),
  };

  const pickupDate = String(shipTrack.pickup_date ?? '') || null;
  result.timeline = {
    pickup_date: pickupDate,
    estimated_delivery: String(shipTrack.edd ?? '') || null,
    actual_delivery: statusCode === 'DELIVERED' ? (String(shipTrack.delivered_date ?? '') || null) : null,
    days_in_transit: daysInTransit(pickupDate),
  };

  result.location = {
    current_city: null,
    current_state: null,
    current_pincode: null,
    origin_city: null,
    origin_state: null,
    destination_city: String(shipTrack.destination_city ?? '') || null,
    destination_state: null,
    destination_pincode: null,
  };

  const activities = (shipTrack.shipment_track_activities ?? []) as Array<Record<string, string>>;
  result.events = activities.map((a): TrackingEvent => {
    const desc = a.activity ?? a.status ?? '';
    const code = normalizeStatus(desc);
    return {
      timestamp: a.date ?? null,
      status: code,
      description: desc,
      location: a.location ?? null,
      city: a.location?.split(',')[0]?.trim() ?? null,
      state: null,
    };
  });

  if (result.events.length > 0) result.location.current_city = result.events[0].city;

  const ndrCount = activities.filter((a) => /undeliver|ndr|failed|attempt/i.test(a.activity ?? '')).length;
  result.delivery_attempts = {
    count: ndrCount || null,
    last_attempt_date: ndrCount ? (activities[0]?.date ?? null) : null,
    failure_reason: null,
  };

  result.flags.is_rto = statusCode === 'RTO' || statusCode === 'RTO_DELIVERED';
  result.flags.is_ndr = ndrCount > 0;

  if (shipTrack.courier_name) {
    result.courier.detected = `Shiprocket → ${String(shipTrack.courier_name)}`;
  }

  return result;
}

// Calls tracking-form-check → gets shiprocket.co/tracking/{awb} URL → parses SSR HTML
async function tryPublicHtmlTrack(awb: string): Promise<TrackingResult | null> {
  try {
    // Step 1: resolve the .co tracking URL
    const checkRes = await axios.get('https://apiv2.shiprocket.in/tracking-form-check', {
      params: { track_type: 'awb', track_id: awb },
      timeout: 10000,
      headers: {
        ...BROWSER_HEADERS,
        'X-Requested-With': 'XMLHttpRequest',
        Origin: 'https://www.shiprocket.in',
        Referer: `https://www.shiprocket.in/shipment-tracking/?awb=${awb}`,
      },
    });
    const trackingUrl: string = checkRes.data?.url;
    if (!trackingUrl) return null;

    // Step 2: fetch the SSR tracking page
    const pageRes = await axios.get(trackingUrl, {
      timeout: 15000,
      headers: { ...BROWSER_HEADERS },
      maxRedirects: 5,
    });

    return parseShiprocketHtml(awb, String(pageRes.data));
  } catch {
    return null;
  }
}

function parseShiprocketHtml(awb: string, html: string): TrackingResult | null {
  const $ = cheerio.load(html);

  const result = emptyResult(awb, 'shiprocket', 'Shiprocket');
  result.courier.confidence = 'high';
  result.raw = { source: 'shiprocket_html' };

  // Current status: inside #shipment_status span
  const rawStatus = $('#shipment_status span').first().text().trim();
  if (!rawStatus) return null;

  const statusCode = normalizeStatus(rawStatus);
  result.status = {
    code: statusCode,
    label: statusLabel(statusCode),
    description: rawStatus,
    is_final: isFinal(statusCode),
  };

  // EDD: #edd_date or #edd_undelivered_date
  const edd = $('#edd_date').text().trim() || $('#edd_undelivered_date').text().trim() || null;
  result.timeline.estimated_delivery = edd;

  // Parse events from the activity list
  const events: TrackingEvent[] = [];
  $('.delievery_list_wrap ul li, .tracking_activity_list li').each((_i, li) => {
    const actText = $(li).find('activity').first().text().trim();
    const locText = $(li).find('activity').eq(1).text().trim();
    const date = $(li).find("span.date").text().trim();
    const time = $(li).find("span.time").text().trim();
    if (!actText) return;
    const code = normalizeStatus(actText);
    events.push({
      timestamp: date ? `${date} ${time}`.trim() : null,
      status: code,
      description: actText,
      location: locText || null,
      city: locText?.split(',')[0]?.trim() || null,
      state: null,
    });
  });

  if (events.length === 0) return null;
  result.events = events;

  result.location.current_city = events[0].city;

  // Pickup date = last (oldest) event's timestamp
  const oldest = events[events.length - 1];
  result.timeline.pickup_date = oldest.timestamp;
  result.timeline.days_in_transit = daysInTransit(oldest.timestamp);

  if (statusCode === 'DELIVERED') {
    result.timeline.actual_delivery = events[0].timestamp;
  }

  const ndrCount = events.filter((e) => /undeliver|ndr|failed|attempt/i.test(e.description)).length;
  result.delivery_attempts = {
    count: ndrCount || null,
    last_attempt_date: ndrCount ? (events[0].timestamp ?? null) : null,
    failure_reason: null,
  };

  result.flags.is_rto = statusCode === 'RTO' || statusCode === 'RTO_DELIVERED';
  result.flags.is_ndr = ndrCount > 0;

  // Courier name from page if available
  const courierName = $('#courier_name').text().trim() || $('.courier_name').text().trim();
  if (courierName) result.courier.detected = `Shiprocket → ${courierName}`;

  return result;
}

export const shiprocket: CourierAdapter = {
  slug: 'shiprocket',
  name: 'Shiprocket',
  patterns: [],

  async track(awb: string): Promise<TrackingResult> {
    // Try authenticated API first
    try {
      const apiResult = await tryShiprocketApi(awb);
      if (apiResult) return apiResult;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg !== 'Shiprocket credentials not configured') throw err;
    }

    // Public HTML scrape via tracking-form-check → shiprocket.co/tracking/{awb}
    const htmlResult = await tryPublicHtmlTrack(awb);
    if (htmlResult) return htmlResult;

    throw new Error('NOT_FOUND');
  },
};
