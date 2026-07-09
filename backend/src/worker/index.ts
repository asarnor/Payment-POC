import prisma from '../prisma';
import { SettlementWorker, DEFAULT_CONFIG, WorkerLogger } from './settlement-worker';
import { logger as pinoLogger } from '../observability/logger';
import { initTracing, shutdownTracing } from '../observability/tracing';
import {
  outboxQueueDepth,
  outboxProcessingDurationSeconds,
  outboxRetryTotal,
  outboxDeadLetterTotal,
  paymentsSettledTotal,
} from '../observability/metrics';

// ─── Initialize OpenTelemetry ──────────────────────────────────────────────────
initTracing();

// ─── Logger (structured JSON via pino) ─────────────────────────────────────────

const logger: WorkerLogger = {
  info(obj, msg) {
    pinoLogger.info(obj, msg);
  },
  warn(obj, msg) {
    pinoLogger.warn(obj, msg);
  },
  error(obj, msg) {
    pinoLogger.error(obj, msg);
  },
};

// ─── Configuration from environment ────────────────────────────────────────────

const config = {
  ...DEFAULT_CONFIG,
  pollIntervalMs: parseInt(process.env.WORKER_POLL_INTERVAL_MS || '5000', 10),
  maxAttempts: parseInt(process.env.WORKER_MAX_ATTEMPTS || '5', 10),
  baseDelayMs: parseInt(process.env.WORKER_BASE_DELAY_MS || '1000', 10),
  maxDelayMs: parseInt(process.env.WORKER_MAX_DELAY_MS || '60000', 10),
  failureRate: parseFloat(process.env.WORKER_FAILURE_RATE || '0.2'),
  settlementLatencyMs: parseInt(process.env.WORKER_SETTLEMENT_LATENCY_MS || '200', 10),
  batchSize: parseInt(process.env.WORKER_BATCH_SIZE || '10', 10),
};

// ─── Start worker ──────────────────────────────────────────────────────────────

import { WorkerMetrics } from './settlement-worker';

const metrics: WorkerMetrics = {
  onQueueDepth: (depth) => outboxQueueDepth.set(depth),
  onProcessingDuration: (seconds) => outboxProcessingDurationSeconds.observe(seconds),
  onRetry: () => outboxRetryTotal.inc(),
  onDeadLetter: () => outboxDeadLetterTotal.inc(),
  onSettled: () => paymentsSettledTotal.inc(),
};

const worker = new SettlementWorker(prisma, logger, config, metrics);

worker.start();

// ─── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Received shutdown signal');
  await worker.stop();
  await shutdownTracing();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
