import axios, { AxiosInstance } from 'axios';
import type { StatusCode, TrackingResult } from '../types.js';

export { TokenCache } from '../cache.js';

export const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
};

export function createHttpClient(baseURL?: string): AxiosInstance {
  return axios.create({
    baseURL,
    timeout: 15000,
    headers: BROWSER_HEADERS,
    ...(process.env.HTTP_PROXY
      ? { proxy: false } // handled by env at OS level or pass httpsAgent
      : {}),
  });
}

// Maps a raw status string from any courier to a canonical StatusCode.
export function normalizeStatus(raw: string): StatusCode {
  const s = raw.toLowerCase().trim();

  if (/rto.?deliver|return.?deliver/.test(s)) return 'RTO_DELIVERED';
  if (/rto|return.?to.?origin|return.?initiat|returning/.test(s)) return 'RTO';
  if (/deliver/.test(s) && !/un|fail|attempt/.test(s)) return 'DELIVERED';
  if (/out.?for.?deliver|ofd|with delivery agent|dispatch.*hub/.test(s)) return 'OUT_FOR_DELIVERY';
  if (/undeliver|failed.?deliver|delivery.?attempt|not.?deliver|ndr/.test(s)) return 'EXCEPTION';
  if (/exception|delay|damage|misroute|held/.test(s)) return 'EXCEPTION';
  if (
    /in.?transit|transit|reached|arrived|departed|dispatched|picked.?up|manifest|shipped|hub|sort|gateway|processing/.test(
      s,
    )
  )
    return 'IN_TRANSIT';
  if (/pickup.?pending|pending.*pickup|booked|order.?placed|created|registered/.test(s))
    return 'PICKUP_PENDING';
  if (/pending/.test(s)) return 'PENDING';

  return 'UNKNOWN';
}

export function statusLabel(code: StatusCode): string {
  const labels: Record<StatusCode, string> = {
    PENDING: 'Order Placed',
    PICKUP_PENDING: 'Awaiting Pickup',
    IN_TRANSIT: 'In Transit',
    OUT_FOR_DELIVERY: 'Out for Delivery',
    DELIVERED: 'Delivered',
    EXCEPTION: 'Delivery Exception',
    RTO: 'Return to Origin',
    RTO_DELIVERED: 'Returned to Seller',
    TRACKING_LINK_REQUIRED: 'Tracking Link Required',
    UNKNOWN: 'Status Unknown',
  };
  return labels[code];
}

export function isFinal(code: StatusCode): boolean {
  return code === 'DELIVERED' || code === 'RTO_DELIVERED';
}

export function emptyResult(awb: string, slug: string, name: string): TrackingResult {
  return {
    tracking_number: awb,
    courier: { detected: name, confidence: 'medium', slug },
    status: { code: 'UNKNOWN', label: 'Status Unknown', description: '', is_final: false },
    timeline: { pickup_date: null, estimated_delivery: null, actual_delivery: null, days_in_transit: null },
    location: {
      current_city: null, current_state: null, current_pincode: null,
      origin_city: null, origin_state: null,
      destination_city: null, destination_state: null, destination_pincode: null,
    },
    events: [],
    delivery_attempts: { count: null, last_attempt_date: null, failure_reason: null },
    shipment_details: { weight_kg: null, dimensions: null, product_description: null, pieces: null },
    parties: { shipper_name: null, consignee_name: null, consignee_phone_masked: null },
    flags: { is_rto: false, is_ndr: false, requires_otp: false, is_express: null, cod_amount: null },
    raw: {},
  };
}

export function daysInTransit(pickupDate: string | null): number | null {
  if (!pickupDate) return null;
  const pickup = new Date(pickupDate);
  if (isNaN(pickup.getTime())) return null;
  return Math.floor((Date.now() - pickup.getTime()) / 86_400_000);
}
