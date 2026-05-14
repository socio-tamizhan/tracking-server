import axios from 'axios';
import type { CourierAdapter, StatusCode, TrackingEvent, TrackingResult } from '../types.js';
import { BROWSER_HEADERS, daysInTransit, emptyResult, isFinal, normalizeStatus, statusLabel } from './base.js';

// Delhivery's new public tracking API (no auth required)
const UNIFIED_API = 'https://dlv-api.delhivery.com/v3/unified-tracking-new';

function mapDelhiveryStatus(statusCode: string, hqStatus: string): StatusCode {
  const code = statusCode.toUpperCase();
  const map: Record<string, StatusCode> = {
    PICKUP: 'IN_TRANSIT',
    UD: 'IN_TRANSIT',
    'IN TRANSIT': 'IN_TRANSIT',
    OFD: 'OUT_FOR_DELIVERY',
    DL: 'DELIVERED',
    DLVD: 'DELIVERED',
    RTO: 'RTO',
    'RTO DELIVERED': 'RTO_DELIVERED',
    OA: 'EXCEPTION',
    'PENDING PICKUP': 'PICKUP_PENDING',
    PP: 'PICKUP_PENDING',
  };
  if (map[code]) return map[code];
  // Fall back to hqStatus text
  return normalizeStatus(hqStatus || statusCode);
}

interface DelhiveryUnifiedShipment {
  awb: string;
  hqStatus: string;
  status: { instructions: string; status: string; statusDateTime: string; statusType: string };
  origin: string;
  destination: string;
  deliveryDate: string;
  packageType: string;
  currentFlow: string;
  referenceNo: string;
  consignee: string;
  consignor: string;
  trackingStates: Array<{
    label: string;
    date: string;
    scans: Array<{
      cityLocation: string;
      scan: string;
      scanDate: string;
      scanDateTime: string;
      scanNslRemark: string;
      scanType: string;
      scannedLocation: string;
    }>;
  }>;
}

function parseUnifiedResponse(awb: string, ship: DelhiveryUnifiedShipment): TrackingResult {
  const result = emptyResult(awb, 'delhivery', 'Delhivery');
  result.courier.confidence = 'high';
  result.raw = ship as unknown as Record<string, unknown>;

  const statusCode = mapDelhiveryStatus(ship.status?.status ?? '', ship.hqStatus ?? '');
  const rawStatus = ship.status?.instructions ?? ship.hqStatus ?? '';
  result.status = {
    code: statusCode,
    label: statusLabel(statusCode),
    description: rawStatus,
    is_final: isFinal(statusCode),
  };

  // Flatten all scans from trackingStates (newest first)
  const allScans = (ship.trackingStates ?? []).flatMap((ts) =>
    (ts.scans ?? []).map((s) => ({ ...s, stateLabel: ts.label })),
  );

  result.events = allScans.map((s): TrackingEvent => {
    const desc = s.scanNslRemark || s.scan || s.stateLabel || '';
    const code = mapDelhiveryStatus(s.scanType ?? '', s.scan ?? '');
    return {
      timestamp: s.scanDateTime || s.scanDate || null,
      status: code,
      description: desc,
      location: s.scannedLocation || s.cityLocation || null,
      city: s.cityLocation || s.scannedLocation?.split(',')[0]?.trim() || null,
      state: null,
    };
  });

  // Find pickup date from earliest event
  const earliestScan = allScans[allScans.length - 1];
  const latestScan = allScans[0];
  const pickupDate = earliestScan?.scanDateTime || earliestScan?.scanDate || null;

  result.timeline = {
    pickup_date: pickupDate,
    estimated_delivery: ship.deliveryDate || null,
    actual_delivery: statusCode === 'DELIVERED' ? (latestScan?.scanDateTime || null) : null,
    days_in_transit: daysInTransit(pickupDate),
  };

  result.location = {
    current_city: latestScan?.cityLocation || latestScan?.scannedLocation?.split(',')[0]?.trim() || null,
    current_state: null,
    current_pincode: null,
    origin_city: ship.origin || null,
    origin_state: null,
    destination_city: ship.destination || null,
    destination_state: null,
    destination_pincode: null,
  };

  const ndrScans = allScans.filter((s) => /undeliver|NDR|failed|attempt/i.test(s.scan ?? s.scanNslRemark ?? ''));
  result.delivery_attempts = {
    count: ndrScans.length || null,
    last_attempt_date: ndrScans[0]?.scanDateTime || null,
    failure_reason: null,
  };

  const isRto = ship.currentFlow === 'RTO' || statusCode === 'RTO' || statusCode === 'RTO_DELIVERED';
  result.flags.is_rto = isRto;
  result.flags.is_ndr = ndrScans.length > 0;
  result.flags.cod_amount = ship.packageType?.toLowerCase().includes('cod') ? 0 : null;

  result.parties.consignee_name = ship.consignee || null;
  result.parties.shipper_name = ship.consignor || null;

  return result;
}

async function tryUnifiedApi(awb: string): Promise<TrackingResult | null> {
  try {
    const res = await axios.get(UNIFIED_API, {
      params: { wbn: awb },
      timeout: 15000,
      headers: {
        ...BROWSER_HEADERS,
        Referer: `https://www.delhivery.com/track-v2/package/${awb}`,
        Origin: 'https://www.delhivery.com',
      },
    });

    const body = res.data;
    if (!body || body.statusCode !== 200) return null;
    const shipmentArr = body.data;
    if (!Array.isArray(shipmentArr) || shipmentArr.length === 0) return null;
    return parseUnifiedResponse(awb, shipmentArr[0] as DelhiveryUnifiedShipment);
  } catch {
    return null;
  }
}

export const delhivery: CourierAdapter = {
  slug: 'delhivery',
  name: 'Delhivery',
  patterns: [/^\d{16,22}$/, /^[A-Z]{3}\d{12,}$/i],

  async track(awb: string): Promise<TrackingResult> {
    const result = await tryUnifiedApi(awb);
    if (result) return result;
    throw new Error('NOT_FOUND');
  },
};
