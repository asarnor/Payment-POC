import express from 'express';
import prisma from './prisma';
import { correlationId, authMiddleware, errorHandler } from './middleware';
import { createPaymentRoutes } from './routes/payments';
import {
  logger,
  httpLogger,
  tracingMiddleware,
  metricsMiddleware,
  metricsHandler,
  initTracing,
  shutdownTracing,
} from './observability';

// ─── Initialize OpenTelemetry ───────────────────────────────────────────────
initTracing();

const app = express();
const port = process.env.PORT ?? 3000;

// ─── Global middleware ──────────────────────────────────────────────────────
app.use(express.json());
app.use(correlationId);
app.use(tracingMiddleware);
app.use(httpLogger);
app.use(metricsMiddleware);

// ─── Public routes (no auth) ────────────────────────────────────────────────

/** Liveness probe — always returns 200 if the process is running. */
app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

/** Readiness probe — checks DB connectivity; returns 503 if unreachable. */
app.get('/readyz', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok' });
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Readiness check failed');
    res.status(503).json({ status: 'unavailable', error: 'Database unreachable' });
  }
});

/** Prometheus metrics endpoint. */
app.get('/metrics', metricsHandler);

// ─── Authenticated routes ───────────────────────────────────────────────────
app.use('/payments', authMiddleware, createPaymentRoutes(prisma));

// ─── Global error handler ───────────────────────────────────────────────────
app.use(errorHandler);

// ─── Start server ───────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(port, () => {
    logger.info({ port }, 'Server running');
  });

  // ─── Graceful shutdown ──────────────────────────────────────────────────
  async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, 'Received shutdown signal');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await shutdownTracing();
    await prisma.$disconnect();
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

export default app;
