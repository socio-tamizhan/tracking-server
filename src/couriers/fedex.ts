import axios from 'axios';
import type { CourierAdapter, StatusCode, TrackingEvent, TrackingResult } from '../types.js';
import { BROWSER_HEADERS, TokenCache, daysInTransit, emptyResult, isFinal, normalizeStatus, statusLabel } from './base.js';
import { withPage } from '../scraper/browser.js';

const BASE = 'https://apis.fedex.com';
const tokenCache = new TokenCache();

async function getToken(): Promise<string> {
  const cached = tokenCache.get();
  if (cached) return cached;

  const clientId = process.env.FEDEX_CLIENT_ID;
  const clientSecret = process.env.FEDEX_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('FedEx credentials not configured');

  const res = await axios.post(
    `${BASE}/oauth/token`,
    `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 },
  );

  const token: string = res.data.access_token;
  tokenCache.set(token, res.data.expires_in ?? 3600);
  return token;
}

function mapFedExStatus(eventType: string): StatusCode {
  const map: Record<string, StatusCode> = {
    DL: 'DELIVERED',
    OD: 'OUT_FOR_DELIVERY',
    IP: 'IN_TRANSIT',
    IT: 'IN_TRANSIT',
    PU: 'IN_TRANSIT',
    PX: 'EXCEPTION',
    DE: 'EXCEPTION',
    HL: 'EXCEPTION',
    RS: 'RTO',
    RP: 'RTO',
    OC: 'PICKUP_PENDING',
    PL: 'PICKUP_PENDING',
  };
  return map[eventType.toUpperCase()] ?? 'UNKNOWN';
}

async function tryFedExApi(awb: string): Promise<TrackingResult | null> {
  try {
    const token = await getToken();

    const res = await axios.post(
      `${BASE}/track/v1/trackingnumbers`,
      {
        trackingInfo: [{ trackingNumberInfo: { trackingNumber: awb } }],
        includeDetailedScans: true,
      },
      {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 15000,
      },
    );

    const trackResults = res.data?.output?.completeTrackResults?.[0]?.trackResults;
    if (!trackResults || trackResults.length === 0) return null;

    const track = trackResults[0];
    if (track.error || track.trackingNumberInfo?.trackingNumberUniqueId === null) return null;

    const result = emptyResult(awb, 'fedex', 'FedEx');
    result.courier.confidence = 'medium';
    result.raw = track;

    const latestStatus = track.latestStatusDetail;
    const statusCode = mapFedExStatus(latestStatus?.code ?? '');
    result.status = {
      code: statusCode,
      label: statusLabel(statusCode),
      description: latestStatus?.statusByLocale ?? latestStatus?.description ?? '',
      is_final: isFinal(statusCode),
    };

    const dateTimes: Array<{ type: string; dateTime: string }> = track.dateAndTimes ?? [];
    const getDate = (type: string) => dateTimes.find((d) => d.type === type)?.dateTime ?? null;

    const pickupDate = getDate('ACTUAL_PICKUP') ?? getDate('SHIP');
    result.timeline = {
      pickup_date: pickupDate,
      estimated_delivery:
        track.estimatedDeliveryTimeWindow?.window?.ends ?? getDate('ESTIMATED_DELIVERY') ?? null,
      actual_delivery: statusCode === 'DELIVERED' ? (getDate('ACTUAL_DELIVERY') ?? null) : null,
      days_in_transit: daysInTransit(pickupDate),
    };

    const scanLoc = latestStatus?.scanLocation;
    result.location = {
      current_city: scanLoc?.city ?? null,
      current_state: scanLoc?.stateOrProvinceCode ?? null,
      current_pincode: scanLoc?.postalCode ?? null,
      origin_city: track.shipperInformation?.address?.city ?? null,
      origin_state: track.shipperInformation?.address?.stateOrProvinceCode ?? null,
      destination_city: track.recipientInformation?.address?.city ?? null,
      destination_state: track.recipientInformation?.address?.stateOrProvinceCode ?? null,
      destination_pincode: track.recipientInformation?.address?.postalCode ?? null,
    };

    const scanEvents: Array<Record<string, unknown>> = track.scanEvents ?? [];
    result.events = scanEvents.map((e): TrackingEvent => {
      const code = mapFedExStatus(String(e.eventType ?? ''));
      const loc = e.scanLocation as Record<string, string> | undefined;
      return {
        timestamp: String(e.date ?? ''),
        status: code,
        description: String(e.eventDescription ?? ''),
        location: loc ? `${loc.city ?? ''}, ${loc.stateOrProvinceCode ?? ''}`.replace(/^,\s*/, '') : null,
        city: loc?.city ?? null,
        state: loc?.stateOrProvinceCode ?? null,
      };
    });

    const pkg = track.packageDetails;
    result.shipment_details = {
      weight_kg: pkg?.weightAndDimensions?.weight?.[0]?.value
        ? Number(pkg.weightAndDimensions.weight[0].value)
        : null,
      dimensions: null,
      product_description: null,
      pieces: pkg?.count ? Number(pkg.count) : null,
    };

    result.flags.is_express = true;
    result.flags.is_rto = statusCode === 'RTO' || statusCode === 'RTO_DELIVERED';

    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'FedEx credentials not configured') throw err;
    return null;
  }
}

async function tryFedExWebXHR(awb: string): Promise<TrackingResult | null> {
  // FedEx web tracking fires a GraphQL or REST call we can attempt to replicate
  try {
    const res = await axios.post(
      'https://www.fedex.com/trackingCal/track',
      {
        data: JSON.stringify({
          TrackPackagesRequest: {
            appType: 'WTRK',
            appDeviceType: 'DESKTOP',
            supportHTML: true,
            supportCurrentLocation: true,
            uniqueKey: '',
            processingParameters: {},
            trackingInfoList: [{ trackNumberInfo: { trackingNumber: awb, trackingCarrier: '', trackingQualifier: '' } }],
          },
        }),
        action: 'trackpackages',
        locale: 'en_IN',
        version: '1',
        format: 'json',
      },
      {
        timeout: 15000,
        headers: {
          ...BROWSER_HEADERS,
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'https://www.fedex.com',
          Referer: `https://www.fedex.com/fedextrack/?trknbr=${awb}`,
        },
      },
    );

    const pkg = res.data?.TrackPackagesResponse?.packageList?.[0];
    if (!pkg || pkg.errorList?.length > 0) return null;

    return parseFedExWeb(awb, pkg);
  } catch {
    return null;
  }
}

function parseFedExWeb(awb: string, pkg: Record<string, unknown>): TrackingResult {
  const result = emptyResult(awb, 'fedex', 'FedEx');
  result.courier.confidence = 'medium';
  result.raw = pkg;

  const rawStatus = String(pkg.statusDescription ?? pkg.keyStatus ?? '');
  const statusCode = normalizeStatus(rawStatus);
  result.status = { code: statusCode, label: statusLabel(statusCode), description: rawStatus, is_final: isFinal(statusCode) };

  const pickupDate = String(pkg.shipDate ?? '') || null;
  result.timeline = {
    pickup_date: pickupDate,
    estimated_delivery: String(pkg.displayEstimatedDeliveryDate ?? pkg.estimatedDeliveryTime ?? '') || null,
    actual_delivery: statusCode === 'DELIVERED' ? (String(pkg.deliveryDate ?? '') || null) : null,
    days_in_transit: daysInTransit(pickupDate),
  };

  result.location = {
    current_city: String(pkg.actualDeliveryCity ?? pkg.statusCity ?? '') || null,
    current_state: String(pkg.actualDeliveryStateCD ?? '') || null,
    current_pincode: null,
    origin_city: String(pkg.originCity ?? '') || null,
    origin_state: String(pkg.originStateCD ?? '') || null,
    destination_city: String(pkg.destCity ?? '') || null,
    destination_state: String(pkg.destStateCD ?? '') || null,
    destination_pincode: String(pkg.destZip ?? '') || null,
  };

  const scanList = (pkg.scanEventList ?? []) as Array<Record<string, string>>;
  result.events = scanList.map((s): TrackingEvent => {
    const desc = s.statusDescription ?? s.status ?? '';
    const code = normalizeStatus(desc);
    return {
      timestamp: s.date ? `${s.date} ${s.time ?? ''}`.trim() : null,
      status: code,
      description: desc,
      location: s.scanLocation ?? null,
      city: s.city ?? s.scanLocation?.split(',')[0]?.trim() ?? null,
      state: s.stateCD ?? null,
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
      if (/trackingCal|track\/v|trackingnumber/i.test(url) && response.status() === 200) {
        try {
          const ct = response.headers()['content-type'] ?? '';
          if (ct.includes('json')) {
            const json = await response.json();
            const pkg = json?.TrackPackagesResponse?.packageList?.[0];
            if (pkg && !pkg.errorList?.length) {
              interceptedData = pkg;
            }
          }
        } catch { /* skip */ }
      }
    });

    await page.goto(`https://www.fedex.com/fedextrack/?trknbr=${awb}`, {
      waitUntil: 'networkidle',
      timeout: 35000,
    });

    if (interceptedData) return parseFedExWeb(awb, interceptedData);
    // FedEx is a React SPA — if we couldn't intercept the JSON response, the AWB is not found
    throw new Error('NOT_FOUND');
  });
}

export const fedex: CourierAdapter = {
  slug: 'fedex',
  name: 'FedEx',
  patterns: [/^\d{12}$/, /^\d{15}$/, /^\d{20,22}$/, /^JD\d{18}$/],

  async track(awb: string): Promise<TrackingResult> {
    // Try official API first (requires creds)
    try {
      const apiResult = await tryFedExApi(awb);
      if (apiResult) return apiResult;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg !== 'FedEx credentials not configured') throw err;
    }

    // Try FedEx web tracking XHR
    const webResult = await tryFedExWebXHR(awb);
    if (webResult) return webResult;

    // Playwright scrape of fedex.com
    return scrapePlaywright(awb);
  },
};
