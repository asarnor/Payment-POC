import {
  calculateBackoff,
  simulateSettlement,
  SettlementError,
  SettlementWorker,
  WorkerConfig,
  WorkerLogger,
  DEFAULT_CONFIG,
} from './settlement-worker';

// ─── calculateBackoff ──────────────────────────────────────────────────────────

describe('calculateBackoff', () => {
  it('returns a value between 0 and min(maxDelay, baseDelay * 2^attempt)', () => {
    // Run multiple times to test randomness bounds
    for (let i = 0; i < 100; i++) {
      const result = calculateBackoff(3, 1000, 60000);
      // 2^3 * 1000 = 8000
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThan(8000);
    }
  });

  it('caps at maxDelayMs', () => {
    for (let i = 0; i < 100; i++) {
      const result = calculateBackoff(20, 1000, 5000);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThan(5000);
    }
  });

  it('attempt 0 has delay between 0 and baseDelayMs', () => {
    for (let i = 0; i < 100; i++) {
      const result = calculateBackoff(0, 1000, 60000);
      // 2^0 * 1000 = 1000
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThan(1000);
    }
  });
});

// ─── simulateSettlement ────────────────────────────────────────────────────────

describe('simulateSettlement', () => {
  it('resolves when failure rate is 0', async () => {
    await expect(
      simulateSettlement({ failureRate: 0, settlementLatencyMs: 0 }),
    ).resolves.toBeUndefined();
  });

  it('always throws when failure rate is 1', async () => {
    await expect(
      simulateSettlement({ failureRate: 1, settlementLatencyMs: 0 }),
    ).rejects.toThrow(SettlementError);
  });
});

// ─── SettlementWorker ──────────────────────────────────────────────────────────

describe('SettlementWorker', () => {
  const createMockLogger = (): WorkerLogger & {
    infoCalls: Array<[Record<string, unknown>, string]>;
    warnCalls: Array<[Record<string, unknown>, string]>;
    errorCalls: Array<[Record<string, unknown>, string]>;
  } => ({
    infoCalls: [],
    warnCalls: [],
    errorCalls: [],
    info(obj, msg) { this.infoCalls.push([obj, msg]); },
    warn(obj, msg) { this.warnCalls.push([obj, msg]); },
    error(obj, msg) { this.errorCalls.push([obj, msg]); },
  });

  const testConfig: WorkerConfig = {
    ...DEFAULT_CONFIG,
    pollIntervalMs: 100,
    failureRate: 0, // deterministic success for tests
    settlementLatencyMs: 0,
    maxAttempts: 3,
    batchSize: 5,
    baseDelayMs: 100,
    maxDelayMs: 1000,
  };

  it('processes a pending outbox event and settles the payment', async () => {
    const logger = createMockLogger();

    const mockEvent = {
      id: 'evt-1',
      paymentId: 'pay-1',
      eventType: 'payment.captured',
      payload: { payment_id: 'pay-1', merchant_id: 'merch-1', correlation_id: 'corr-1' },
      status: 'pending' as const,
      attempts: 0,
      nextAttemptAt: new Date(Date.now() - 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockPayment = {
      id: 'pay-1',
      merchantId: 'merch-1',
      amountMinorUnits: 5000,
      currency: 'USD',
      status: 'captured' as const,
      paymentMethodToken: 'tok_123',
      idempotencyKey: 'idem-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Build a mock prisma client
    const mockPrisma = {
      outboxEvent: {
        findMany: jest.fn().mockResolvedValue([mockEvent]),
        update: jest.fn().mockResolvedValue(mockEvent),
      },
      payment: {
        findUnique: jest.fn().mockResolvedValue(mockPayment),
        update: jest.fn().mockResolvedValue({ ...mockPayment, status: 'settled' }),
      },
      paymentStateTransition: {
        create: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        return fn({
          payment: { update: mockPrisma.payment.update },
          paymentStateTransition: { create: mockPrisma.paymentStateTransition.create },
        });
      }),
    } as unknown as jest.Mocked<any>;

    const worker = new SettlementWorker(mockPrisma, logger, testConfig);

    // Run one poll cycle
    await worker.poll();

    // Should have fetched pending events
    expect(mockPrisma.outboxEvent.findMany).toHaveBeenCalledTimes(1);

    // Should have marked event as processing, then done
    expect(mockPrisma.outboxEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'evt-1' }, data: { status: 'processing' } }),
    );
    expect(mockPrisma.outboxEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'evt-1' }, data: { status: 'done', attempts: 1 } }),
    );

    // Should have settled the payment
    expect(mockPrisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'pay-1' }, data: { status: 'settled' } }),
    );

    // Should have created an audit trail
    expect(mockPrisma.paymentStateTransition.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        paymentId: 'pay-1',
        fromStatus: 'captured',
        toStatus: 'settled',
        actor: 'system:settlement-worker',
        correlationId: 'corr-1',
      }),
    });

    expect(logger.infoCalls.some(([, msg]) => msg === 'Settlement succeeded')).toBe(true);
  });

  it('retries with backoff on settlement failure', async () => {
    const logger = createMockLogger();
    const failConfig: WorkerConfig = { ...testConfig, failureRate: 1 }; // always fail

    const mockEvent = {
      id: 'evt-2',
      paymentId: 'pay-2',
      eventType: 'payment.captured',
      payload: { payment_id: 'pay-2', correlation_id: 'corr-2' },
      status: 'pending' as const,
      attempts: 0,
      nextAttemptAt: new Date(Date.now() - 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockPrisma = {
      outboxEvent: {
        findMany: jest.fn().mockResolvedValue([mockEvent]),
        update: jest.fn().mockResolvedValue(mockEvent),
      },
      payment: {
        findUnique: jest.fn(),
      },
      $transaction: jest.fn(),
    } as unknown as jest.Mocked<any>;

    const worker = new SettlementWorker(mockPrisma, logger, failConfig);
    await worker.poll();

    // Should have scheduled retry (attempts=1 < maxAttempts=3)
    const updateCalls = mockPrisma.outboxEvent.update.mock.calls;
    const retryCall = updateCalls.find(
      (call: any) => call[0].data.status === 'pending' && call[0].data.attempts === 1,
    );
    expect(retryCall).toBeDefined();
    expect(retryCall[0].data.nextAttemptAt).toBeInstanceOf(Date);

    expect(logger.warnCalls.some(([, msg]) => msg === 'Settlement failed — scheduling retry')).toBe(true);
  });

  it('dead-letters after max attempts', async () => {
    const logger = createMockLogger();
    const failConfig: WorkerConfig = { ...testConfig, failureRate: 1, maxAttempts: 3 };

    const mockEvent = {
      id: 'evt-3',
      paymentId: 'pay-3',
      eventType: 'payment.captured',
      payload: { payment_id: 'pay-3', correlation_id: 'corr-3' },
      status: 'pending' as const,
      attempts: 2, // This will be attempt 3 (the max)
      nextAttemptAt: new Date(Date.now() - 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockPrisma = {
      outboxEvent: {
        findMany: jest.fn().mockResolvedValue([mockEvent]),
        update: jest.fn().mockResolvedValue(mockEvent),
      },
      payment: {
        findUnique: jest.fn(),
      },
      $transaction: jest.fn(),
    } as unknown as jest.Mocked<any>;

    const worker = new SettlementWorker(mockPrisma, logger, failConfig);
    await worker.poll();

    // Should have dead-lettered
    const updateCalls = mockPrisma.outboxEvent.update.mock.calls;
    const deadLetterCall = updateCalls.find(
      (call: any) => call[0].data.status === 'dead_letter',
    );
    expect(deadLetterCall).toBeDefined();
    expect(deadLetterCall[0].data.attempts).toBe(3);

    expect(
      logger.errorCalls.some(([, msg]) => msg === 'Settlement failed permanently — moved to dead letter'),
    ).toBe(true);
  });

  it('skips settlement when payment is already settled (idempotent)', async () => {
    const logger = createMockLogger();

    const mockEvent = {
      id: 'evt-4',
      paymentId: 'pay-4',
      eventType: 'payment.captured',
      payload: { payment_id: 'pay-4', correlation_id: 'corr-4' },
      status: 'pending' as const,
      attempts: 0,
      nextAttemptAt: new Date(Date.now() - 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockPayment = {
      id: 'pay-4',
      status: 'settled' as const, // Already settled
    };

    const mockPrisma = {
      outboxEvent: {
        findMany: jest.fn().mockResolvedValue([mockEvent]),
        update: jest.fn().mockResolvedValue(mockEvent),
      },
      payment: {
        findUnique: jest.fn().mockResolvedValue(mockPayment),
      },
      $transaction: jest.fn(),
    } as unknown as jest.Mocked<any>;

    const worker = new SettlementWorker(mockPrisma, logger, testConfig);
    await worker.poll();

    // Should NOT have called $transaction (no state change needed)
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();

    // Should still mark event as done
    expect(mockPrisma.outboxEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'evt-4' }, data: { status: 'done', attempts: 1 } }),
    );

    expect(logger.infoCalls.some(([, msg]) => msg === 'Payment already settled — no-op')).toBe(true);
  });

  it('start and stop lifecycle works', async () => {
    const logger = createMockLogger();

    const mockPrisma = {
      outboxEvent: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as unknown as jest.Mocked<any>;

    const worker = new SettlementWorker(mockPrisma, logger, { ...testConfig, pollIntervalMs: 50 });

    worker.start();
    // Should not throw when starting again (idempotent)
    worker.start();

    // Let a few poll cycles run
    await new Promise((resolve) => setTimeout(resolve, 150));

    await worker.stop();

    expect(logger.infoCalls.some(([, msg]) => msg === 'Settlement worker starting')).toBe(true);
    expect(logger.infoCalls.some(([, msg]) => msg === 'Settlement worker stopped')).toBe(true);
  });
});
