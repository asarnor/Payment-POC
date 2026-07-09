import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { fetchPaymentDetail } from '../api';
import type { PaymentDetail as PaymentDetailType } from '../api';
import { StatusBadge } from '../components/StatusBadge';

export function PaymentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [payment, setPayment] = useState<PaymentDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchPaymentDetail(id!);
        setPayment(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load payment');
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, [id]);

  function formatAmount(minorUnits: number, currency: string): string {
    const major = (minorUnits / 100).toFixed(2);
    return `${currency} ${major}`;
  }

  if (loading) return <div className="page"><div className="loading">Loading…</div></div>;
  if (error) return <div className="page"><div className="error-banner">{error}</div></div>;
  if (!payment) return <div className="page"><div className="empty-state">Payment not found</div></div>;

  return (
    <div className="page">
      <button className="btn-back" onClick={() => navigate('/')}>
        ← Back to payments
      </button>

      <div className="detail-header">
        <h1>Payment Details</h1>
        <StatusBadge status={payment.status} />
      </div>

      <div className="detail-card">
        <div className="detail-grid">
          <div className="detail-field">
            <label>Payment ID</label>
            <span className="mono">{payment.id}</span>
          </div>
          <div className="detail-field">
            <label>Merchant ID</label>
            <span className="mono">{payment.merchant_id}</span>
          </div>
          <div className="detail-field">
            <label>Amount</label>
            <span>{formatAmount(payment.amount_minor_units, payment.currency)}</span>
          </div>
          <div className="detail-field">
            <label>Currency</label>
            <span>{payment.currency}</span>
          </div>
          <div className="detail-field">
            <label>Payment Method Token</label>
            <span className="mono">{payment.payment_method_token}</span>
          </div>
          <div className="detail-field">
            <label>Idempotency Key</label>
            <span className="mono">{payment.idempotency_key}</span>
          </div>
          <div className="detail-field">
            <label>Created</label>
            <span>{new Date(payment.created_at).toLocaleString()}</span>
          </div>
          <div className="detail-field">
            <label>Updated</label>
            <span>{new Date(payment.updated_at).toLocaleString()}</span>
          </div>
        </div>
      </div>

      <h2>State Transition Audit Trail</h2>

      {payment.state_transitions.length === 0 ? (
        <div className="empty-state">No state transitions recorded</div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>From</th>
                <th>To</th>
                <th>Actor</th>
                <th>Reason</th>
                <th>Correlation ID</th>
              </tr>
            </thead>
            <tbody>
              {payment.state_transitions.map((transition) => (
                <tr key={transition.id}>
                  <td>{new Date(transition.created_at).toLocaleString()}</td>
                  <td><code>{transition.from_status}</code></td>
                  <td><code>{transition.to_status}</code></td>
                  <td className="mono">{transition.actor}</td>
                  <td>{transition.reason || '—'}</td>
                  <td className="mono">{transition.correlation_id.slice(0, 8)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
