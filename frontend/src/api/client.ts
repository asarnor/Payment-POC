import type { PaymentsListResponse, PaymentDetail, ListPaymentsParams } from './types';

const API_BASE = '/api';
const MERCHANT_ID = 'merchant-001';

function getApiKey(): string {
  const key = import.meta.env.VITE_API_KEY;
  if (!key) {
    console.warn('VITE_API_KEY is not set. API requests may fail authentication.');
    return '';
  }
  return key as string;
}

function headers(): HeadersInit {
  const key = getApiKey();
  return {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + key,
    'X-Merchant-Id': MERCHANT_ID,
  };
}

export async function fetchPayments(params: ListPaymentsParams = {}): Promise<PaymentsListResponse> {
  const searchParams = new URLSearchParams();

  if (params.status) searchParams.set('status', params.status);
  if (params.from) searchParams.set('from', params.from);
  if (params.to) searchParams.set('to', params.to);
  if (params.page) searchParams.set('page', String(params.page));
  if (params.per_page) searchParams.set('per_page', String(params.per_page));

  const qs = searchParams.toString();
  const url = `${API_BASE}/payments${qs ? '?' + qs : ''}`;

  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    throw new Error(`Failed to fetch payments: ${res.status}`);
  }
  return res.json() as Promise<PaymentsListResponse>;
}

export async function fetchPaymentDetail(id: string): Promise<PaymentDetail> {
  const res = await fetch(`${API_BASE}/payments/${id}`, { headers: headers() });
  if (!res.ok) {
    throw new Error(`Failed to fetch payment: ${res.status}`);
  }
  return res.json() as Promise<PaymentDetail>;
}
