import { PrismaClient, PaymentStatus, OutboxStatus } from '@prisma/client';
import { isValidTransition } from '../modules/state-machine';
import { withSpan } from '../observability/tracing';

// ─── Configuration ─────────────────────────────────────────────────────────────

export interface WorkerConfig {
  /** How often to poll for pending events (ms). Default: 5000 */
  pollIntervalMs: number;
  /** Maximum number of retry attempts before dead-lettering. Default: 5 */
  maxAttempts: number;
  /** Base delay for exponential backoff (ms). Default: 1000 */
  baseDelayMs: number;
  /** Maximum backoff delay (ms). Default: 60000 */
  maxDelayMs: number;
  /** Simulated settlement failure rate (0–1). Default: 0.2 */
  failureRate: number;
  /** Simulated settlement latency (ms). Default: 200 */
  settlementLatencyMs: number;
  /** Batch size — how many events to process per poll cycle. Default: 10 */
  batchSize: number;
}

export const DEFAULT_CONFIG: WorkerConfig = {
  pollIntervalMs: 5000,
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 60000,
  failureRate: 0.2,
  settlementLatencyMs: 200,
  batchSize: 10,
};

// ─── Logger interface ──────────────────────────────────────────────────────────

export interface WorkerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Optional metrics hooks — injected by the entrypoint so the worker core stays testable.
 */
export interface WorkerMetrics {
  onQueueDepth(depth: number): void;
  onProcessingDuration(durationSeconds: number): void;
  onRetry(): void;
  onDeadLetter(): void;
  onSettled(): void;
}

const noopMetrics: WorkerMetrics = {
  onQueueDepth: () => {},
  onProcessingDuration: () => {},
  onRetry: () => {},
  onDeadLetter: () => {},
  onSettled: () => {},
};

// ─── Settlement simulation ─────────────────────────────────────────────────────

export class SettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementError';
  }
}

/**
 * Simulates an external settlement call.
 * In production this would call a downstream banking/PSP API.
 */
export async function simulateSettlement(
  config: Pick<WorkerConfig, 'failureRate' | 'settlementLatencyMs'>,
): Promise<void> {
  // Simulate network latency
  await new Promise((resolve) => setTimeout(resolve, config.settlementLatencyMs));

  // Random failure to exercise retry logic
  if (Math.random() < config.failureRate) {
    throw new SettlementError('Settlement service unavailable (simulated)');
  }
}

// ─── Backoff calculation ───────────────────────────────────────────────────────

/**
 * Calculates the next retry delay using exponential backoff with full jitter.
 * Formula: random(0, min(maxDelay, baseDelay * 2^attempt))
 */
export function calculateBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
  // Full jitter: uniform random between 0 and the exponential cap
  return Math.floor(Math.random() * exponentialDelay);
}

// ─── Worker class ──────────────────────────────────────────────────────────────

export class SettlementWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopping = false;
  private processing = false;
  private readonly metrics: WorkerMetrics;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: WorkerLogger,
    private readonly config: WorkerConfig = DEFAULT_CONFIG,
    metrics?: WorkerMetrics,
  ) {
    this.metrics = metrics || noopMetrics;
  }

  /**
   * Starts the polling loop.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    this.logger.info({ config: this.config }, 'Settlement worker starting');

    // Immediately run one cycle, then poll on interval
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.config.pollIntervalMs);
  }

  /**
   * Gracefully stops the worker. Allows in-flight processing to complete.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Wait for any in-progress poll to finish
    while (this.processing) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.logger.info({}, 'Settlement worker stopped');
  }

  /**
   * Single poll cycle: fetch pending events and process them.
   * Can be called directly for one-off processing, or by the internal polling loop.
   */
  async poll(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      const events = await this.prisma.outboxEvent.findMany({
        where: {
          status: OutboxStatus.pending,
          nextAttemptAt: { lte: new Date() },
        },
        orderBy: { createdAt: 'asc' },
        take: this.config.batchSize,
      });

      if (events.length > 0) {
        this.logger.info(
          { count: events.length },
          'Processing outbox events',
        );
      }

      this.metrics.onQueueDepth(events.length);

      for (const event of events) {
        if (this.stopping) break;
        await this.processEvent(event);
      }
    } catch (err) {
      this.logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'Error during poll cycle',
      );
    } finally {
      this.processing = false;
    }
  }

  /**
   * Processes a single outbox event: attempts settlement and transitions the payment.
   */
  private async processEvent(event: {
    id: string;
    paymentId: string;
    eventType: string;
    payload: unknown;
    status: OutboxStatus;
    attempts: number;
    nextAttemptAt: Date;
  }): Promise<void> {
    const payload = event.payload as Record<string, unknown>;
    const correlationId = (payload.correlation_id as string) || 'unknown';
    const attempt = event.attempts + 1;

    const logContext = {
      eventId: event.id,
      paymentId: event.paymentId,
      eventType: event.eventType,
      correlationId,
      attempt,
    };

    await withSpan('settlement.process_event', {
      'payment.id': event.paymentId,
      'event.id': event.id,
      'correlation.id': correlationId,
      'settlement.attempt': attempt,
    }, async () => {
    const startTime = process.hrtime.bigint();

    // Mark as processing
    await this.prisma.outboxEvent.update({
      where: { id: event.id },
      data: { status: OutboxStatus.processing },
    });

    try {
      // Simulate settlement call
      await simulateSettlement(this.config);

      // Settlement succeeded — transition payment to settled
      await this.settlePayment(event.paymentId, correlationId);

      // Mark outbox event as done
      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: OutboxStatus.done,
          attempts: attempt,
        },
      });

      this.logger.info(logContext, 'Settlement succeeded');
      this.metrics.onSettled();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      if (attempt >= this.config.maxAttempts) {
        // Dead letter
        await this.prisma.outboxEvent.update({
          where: { id: event.id },
          data: {
            status: OutboxStatus.dead_letter,
            attempts: attempt,
          },
        });

        this.logger.error(
          { ...logContext, error: errorMessage, maxAttempts: this.config.maxAttempts },
          'Settlement failed permanently — moved to dead letter',
        );
        this.metrics.onDeadLetter();
      } else {
        // Schedule retry with exponential backoff + jitter
        const backoffMs = calculateBackoff(
          attempt,
          this.config.baseDelayMs,
          this.config.maxDelayMs,
        );
        const nextAttemptAt = new Date(Date.now() + backoffMs);

        await this.prisma.outboxEvent.update({
          where: { id: event.id },
          data: {
            status: OutboxStatus.pending,
            attempts: attempt,
            nextAttemptAt,
          },
        });

        this.logger.warn(
          { ...logContext, error: errorMessage, nextAttemptAt: nextAttemptAt.toISOString(), backoffMs },
          'Settlement failed — scheduling retry',
        );
        this.metrics.onRetry();
      }
    } finally {
      this.metrics.onProcessingDuration(Number(process.hrtime.bigint() - startTime) / 1e9);
    }
    }); // end withSpan
  }

  /**
   * Transitions a payment from captured to settled within a transaction,
   * including the audit trail entry.
   */
  private async settlePayment(paymentId: string, correlationId: string): Promise<void> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });

    if (!payment) {
      this.logger.warn(
        { paymentId, correlationId },
        'Payment not found during settlement — skipping',
      );
      return;
    }

    // Only transition if still in captured state (idempotent)
    if (payment.status !== PaymentStatus.captured) {
      if (payment.status === PaymentStatus.settled) {
        // Already settled — treat as success (idempotent)
        this.logger.info(
          { paymentId, correlationId, currentStatus: payment.status },
          'Payment already settled — no-op',
        );
        return;
      }

      // Payment is in an unexpected state
      if (!isValidTransition(payment.status, PaymentStatus.settled)) {
        this.logger.warn(
          { paymentId, correlationId, currentStatus: payment.status },
          'Cannot settle payment — invalid state transition',
        );
        return;
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: paymentId },
        data: { status: PaymentStatus.settled },
      });

      await tx.paymentStateTransition.create({
        data: {
          paymentId,
          fromStatus: payment.status,
          toStatus: PaymentStatus.settled,
          actor: 'system:settlement-worker',
          correlationId,
        },
      });
    });
  }
}
