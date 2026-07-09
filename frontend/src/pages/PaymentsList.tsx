import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchPayments } from '../api';
import type { Payment, PaymentStatus, PaginationInfo, ListPaymentsParams } from '../api';
import { StatusBadge } from '../components/StatusBadge';
import { Pagination } from '../components/Pagination';
import { formatAmount } from '../utils/format';

const STATUSES: PaymentStatus[] = ['pending', 'authorized', 'captured', 'settled', 'failed', 'refunded'];

export function PaymentsList() {
  const navigate = useNavigate();
  const [payments, setPayments] = useState<Payment[]>([]);
  const [pagination, setPagination] = useState<PaginationInfo>({ page: 1, per_page: 20, total: 0, total_pages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<PaymentStatus | ''>('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [page, setPage] = useState(1);

  const loadPayments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params: ListPaymentsParams = { page, per_page: 20 };
      if (statusFilter) params.status = statusFilter;
      if (fromDate) params.from = new Date(fromDate).toISOString();
      if (toDate) params.to = new Date(toDate).toISOString();

      const result = await fetchPayments(params);
      setPayments(result.data);
      setPagination(result.pagination);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load payments');
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, fromDate, toDate]);

  useEffect(() => {
    void loadPayments();
  }, [loadPayments]);

  function handleFilterSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
  }

  function handleReset() {
    setStatusFilter('');
    setFromDate('');
    setToDate('');
    setPage(1);
  }

  return (
    <div className="page">
      <h1>Payments</h1>

      <form className="filters" onSubmit={handleFilterSubmit}>
        <div className="filter-group">
          <label htmlFor="status-filter">Status</label>
          <select
            id="status-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as PaymentStatus | '')}
          >
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        <div className="filter-group">
          <label htmlFor="from-date">From</label>
          <input
            id="from-date"
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
          />
        </div>

        <div className="filter-group">
          <label htmlFor="to-date">To</label>
          <input
            id="to-date"
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
          />
        </div>

        <div className="filter-actions">
          <button type="submit">Apply</button>
          <button type="button" onClick={handleReset} className="btn-secondary">Reset</button>
        </div>
      </form>

      {error && <div className="error-banner">{error}</div>}

      {loading ? (
        <div className="loading">Loading…</div>
      ) : payments.length === 0 ? (
        <div className="empty-state">No payments found</div>
      ) : (
        <>
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Token</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr
                    key={payment.id}
                    onClick={() => navigate(`/payments/${payment.id}`)}
                    className="clickable-row"
                  >
                    <td className="mono">{payment.id.slice(0, 8)}…</td>
                    <td>{formatAmount(payment.amount_minor_units, payment.currency)}</td>
                    <td><StatusBadge status={payment.status} /></td>
                    <td className="mono">{payment.payment_method_token}</td>
                    <td>{new Date(payment.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination
            page={pagination.page}
            totalPages={pagination.total_pages}
            onPageChange={setPage}
          />

          <div className="result-count">
            Showing {payments.length} of {pagination.total} payments
          </div>
        </>
      )}
    </div>
  );
}
