export type PaymentStatus =
  | 'pending'
  | 'authorized'
  | 'captured'
  | 'settled'
  | 'failed'
  | 'refunded';

export interface Payment {
  id: string;
  merchant_id: string;
  amount_minor_units: number;
  currency: string;
  status: PaymentStatus;
  payment_method_token: string;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

export interface StateTransition {
  id: string;
  from_status: string;
  to_status: string;
  reason: string | null;
  actor: string;
  correlation_id: string;
  created_at: string;
}

export interface PaymentDetail extends Payment {
  state_transitions: StateTransition[];
}

export interface PaginationInfo {
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
}

export interface PaymentsListResponse {
  data: Payment[];
  pagination: PaginationInfo;
}

export interface ListPaymentsParams {
  status?: PaymentStatus;
  from?: string;
  to?: string;
  page?: number;
  per_page?: number;
}
