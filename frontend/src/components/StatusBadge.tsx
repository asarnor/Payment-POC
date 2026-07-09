import type { PaymentStatus } from '../api';

const STATUS_COLORS: Record<PaymentStatus, string> = {
  pending: '#f59e0b',
  authorized: '#3b82f6',
  captured: '#8b5cf6',
  settled: '#10b981',
  failed: '#ef4444',
  refunded: '#6b7280',
};

interface StatusBadgeProps {
  status: PaymentStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '12px',
        fontSize: '0.75rem',
        fontWeight: 600,
        textTransform: 'uppercase',
        color: '#fff',
        backgroundColor: STATUS_COLORS[status] || '#6b7280',
      }}
    >
      {status}
    </span>
  );
}
