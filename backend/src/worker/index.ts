import prisma from '../prisma';
import { SettlementWorker, DEFAULT_CONFIG, WorkerLogger } from './settlement-worker';

// ─── Logger (structured JSON via console for now; pino will be added in Stage 5) ─

const logger: WorkerLogger = {
  info(obj, msg) {
    console.log(JSON.stringify({ level: 'info', msg, ...obj, timestamp: new Date().toISOString() }));
  },
  warn(obj, msg) {
    console.log(JSON.stringify({ level: 'warn', msg, ...obj, timestamp: new Date().toISOString() }));
  },
  error(obj, msg) {
    console.error(JSON.stringify({ level: 'error', msg, ...obj, timestamp: new Date().toISOString() }));
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

const worker = new SettlementWorker(prisma, logger, config);

worker.start();

// ─── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Received shutdown signal');
  await worker.stop();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
