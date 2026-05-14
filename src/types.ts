export type StatusCode =
  | 'PENDING'
  | 'PICKUP_PENDING'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'EXCEPTION'
  | 'RTO'
  | 'RTO_DELIVERED'
  | 'TRACKING_LINK_REQUIRED'
  | 'UNKNOWN';

export interface TrackingEvent {
  timestamp: string | null;
  status: StatusCode;
  description: string;
  location: string | null;
  city: string | null;
  state: string | null;
}

export interface TrackingResult {
  tracking_number: string;
  courier: {
    detected: string;
    confidence: 'high' | 'medium' | 'low';
    slug: string;
  };
  status: {
    code: StatusCode;
    label: string;
    description: string;
    is_final: boolean;
  };
  timeline: {
    pickup_date: string | null;
    estimated_delivery: string | null;
    actual_delivery: string | null;
    days_in_transit: number | null;
  };
  location: {
    current_city: string | null;
    current_state: string | null;
    current_pincode: string | null;
    origin_city: string | null;
    origin_state: string | null;
    destination_city: string | null;
    destination_state: string | null;
    destination_pincode: string | null;
  };
  events: TrackingEvent[];
  delivery_attempts: {
    count: number | null;
    last_attempt_date: string | null;
    failure_reason: string | null;
  };
  shipment_details: {
    weight_kg: number | null;
    dimensions: { length_cm: number; width_cm: number; height_cm: number } | null;
    product_description: string | null;
    pieces: number | null;
  };
  parties: {
    shipper_name: string | null;
    consignee_name: string | null;
    consignee_phone_masked: string | null;
  };
  flags: {
    is_rto: boolean;
    is_ndr: boolean;
    requires_otp: boolean;
    is_express: boolean | null;
    cod_amount: number | null;
  };
  raw: Record<string, unknown>;
}

export interface CourierAdapter {
  readonly slug: string;
  readonly name: string;
  readonly patterns: RegExp[];
  track(awb: string): Promise<TrackingResult>;
}

export interface TrackRequest {
  tracking_number: string;
  courier?: string;
}

export interface TrackError {
  error: 'NOT_FOUND' | 'AMBIGUOUS' | 'COURIER_UNAVAILABLE' | 'INVALID_INPUT' | 'UPSTREAM_ERROR';
  message: string;
  tracking_number?: string;
  candidates?: string[];
  tracking_url?: string;
}
