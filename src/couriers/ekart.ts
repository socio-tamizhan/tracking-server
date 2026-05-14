import type { CourierAdapter, TrackingEvent, TrackingResult } from '../types.js';
import { BROWSER_HEADERS, daysInTransit, emptyResult, isFinal, normalizeStatus, statusLabel } from './base.js';
import axios from 'axios';

export const ekart: CourierAdapter = {
  slug: 'ekart',
  name: 'Ekart',
  patterns: [/^FMPC\d{10}$/i, /^KS\d{9,11}$/i],

  async track(awb: string): Promise<TrackingResult> {
    const res = await axios.post(
      'https://ekartlogistics.com/ws/getTrackingDetails',
      { tracking_id: awb },
      {
        timeout: 15000,
        headers: {
          ...BROWSER_HEADERS,
          'Content-Type': 'application/json',
          Origin: 'https://ekartlogistics.com',
          Referer: 'https://ekartlogistics.com/',
        },
      },
    );

    const data = res.data;
    // Ekart may wrap in array or return directly
    const payload = Array.isArray(data) ? data[0] : data;

    if (!payload || (!payload.shipmentTrackingDetails && !payload.trackingDetails)) {
      throw new Error('NOT_FOUND');
    }

    const result = emptyResult(awb, 'ekart', 'Ekart');
    result.courier.confidence = 'high';
    result.raw = payload;

    // Normalise field names — Ekart has returned different shapes over time
    const rawStatus: string =
      payload.currentStatus ?? payload.status ?? payload.shipmentStatus ?? '';
    const statusCode = normalizeStatus(rawStatus);
    result.status = {
      code: statusCode,
      label: statusLabel(statusCode),
      description: rawStatus,
      is_final: isFinal(statusCode),
    };

    // Timeline — Ekart rarely provides EDD
    const deliveredDate: string | null = payload.deliveredDate ?? payload.deliveryDate ?? null;
    const pickupDate: string | null = payload.pickupDate ?? null;
    result.timeline = {
      pickup_date: pickupDate,
      estimated_delivery: payload.expectedDeliveryDate ?? payload.edd ?? null,
      actual_delivery: statusCode === 'DELIVERED' ? deliveredDate : null,
      days_in_transit: daysInTransit(pickupDate),
    };

    // Events — normalise both known shapes
    const rawEvents: Array<Record<string, string>> =
      payload.shipmentTrackingDetails ?? payload.trackingDetails ?? [];
    result.events = rawEvents.map((e): TrackingEvent => {
      const desc = e.activity ?? e.status ?? e.description ?? '';
      const ts = e.statusDateTime ?? (e.date && e.time ? `${e.date} ${e.time}` : e.date ?? null);
      const code = normalizeStatus(desc);
      return {
        timestamp: ts ?? null,
        status: code,
        description: desc,
        location: e.location ?? e.city ?? null,
        city: e.city ?? e.location?.split(',')[0]?.trim() ?? null,
        state: null,
      };
    });

    // Location from most recent event
    if (result.events.length > 0) {
      result.location.current_city = result.events[0].city;
      result.location.current_state = result.events[0].state;
    }

    result.flags.is_rto = statusCode === 'RTO' || statusCode === 'RTO_DELIVERED';

    return result;
  },
};
