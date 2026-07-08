import client from 'prom-client';
import { Request, Response, NextFunction } from 'express';

// ─── Default metrics (process CPU, memory, event loop, etc.) ────────────────

client.collectDefaultMetrics();

// ─── RED metrics for HTTP ───────────────────────────────────────────────────

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
});

export const httpRequestDurationSeconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const httpRequestErrorsTotal = new client.Counter({
  name: 'http_request_errors_total',
  help: 'Total number of HTTP request errors (5xx)',
  labelNames: ['method', 'route', 'status_code'] as const,
});

// ─── Business counters ──────────────────────────────────────────────────────

export const paymentsCreatedTotal = new client.Counter({
  name: 'payments_created_total',
  help: 'Total number of payments created',
});

export const paymentsCapturedTotal = new client.Counter({
  name: 'payments_captured_total',
  help: 'Total number of payments captured',
});

export const paymentsSettledTotal = new client.Counter({
  name: 'payments_settled_total',
  help: 'Total number of payments settled',
});

export const paymentsRefundedTotal = new client.Counter({
  name: 'payments_refunded_total',
  help: 'Total number of payments refunded',
});

export const paymentsFailedTotal = new client.Counter({
  name: 'payments_failed_total',
  help: 'Total number of payments failed',
});

// ─── Worker metrics ─────────────────────────────────────────────────────────

export const outboxQueueDepth = new client.Gauge({
  name: 'outbox_queue_depth',
  help: 'Current number of pending outbox events',
});

export const outboxProcessingDurationSeconds = new client.Histogram({
  name: 'outbox_processing_duration_seconds',
  help: 'Duration of outbox event processing in seconds',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
});

export const outboxRetryTotal = new client.Counter({
  name: 'outbox_retry_total',
  help: 'Total number of outbox event retries',
});

export const outboxDeadLetterTotal = new client.Counter({
  name: 'outbox_dead_letter_total',
  help: 'Total number of outbox events moved to dead letter',
});

// ─── HTTP metrics middleware ────────────────────────────────────────────────

/**
 * Normalizes Express route paths to avoid high-cardinality labels.
 */
function normalizeRoute(req: Request): string {
  if (req.route?.path) {
    // Reconstruct full route path from baseUrl + route.path
    return `${req.baseUrl}${req.route.path}`;
  }
  // Fallback for unmatched routes
  return req.path;
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationSeconds = durationNs / 1e9;
    const route = normalizeRoute(req);
    const labels = {
      method: req.method,
      route,
      status_code: String(res.statusCode),
    };

    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, durationSeconds);

    if (res.statusCode >= 500) {
      httpRequestErrorsTotal.inc(labels);
    }
  });

  next();
}

// ─── Metrics endpoint handler ───────────────────────────────────────────────

export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
}

export { client as promClient };
