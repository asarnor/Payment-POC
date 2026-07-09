import request from 'supertest';
import express from 'express';
import { correlationId, authMiddleware, errorHandler } from '../middleware';
import { createPaymentRoutes } from './payments';

// ─── Mock Prisma ────────────────────────────────────────────────────────────────

// In-memory store to simulate DB for integration tests
let payments: Record<string, any> = {};
let stateTransitions: any[] = [];
let idempotencyRecords: Record<string, any> = {};
let outboxEvents: any[] = [];
let idCounter = 0;

function resetStore() {
  payments = {};
  stateTransitions = [];
  idempotencyRecords = {};
  outboxEvents = [];
  idCounter = 0;
}

function generateId() {
  idCounter++;
  return `pay-${String(idCounter).padStart(4, '0')}`;
}

const mockPrisma = {
  payment: {
    create: jest.fn(async ({ data }: any) => {
      const id = generateId();
      const now = new Date();
      const payment = {
        id,
        merchantId: data.merchantId,
        amountMinorUnits: data.amountMinorUnits,
        currency: data.currency,
        status: data.status,
        paymentMethodToken: data.paymentMethodToken,
        idempotencyKey: data.idempotencyKey,
        createdAt: now,
        updatedAt: now,
      };
      payments[id] = payment;
      return payment;
    }),
    findUnique: jest.fn(async ({ where }: any) => {
      return payments[where.id] || null;
    }),
    findMany: jest.fn(async () => Object.values(payments)),
    count: jest.fn(async () => Object.keys(payments).length),
    update: jest.fn(async ({ where, data }: any) => {
      const payment = payments[where.id];
      if (!payment) throw new Error('Payment not found');
      Object.assign(payment, data, { updatedAt: new Date() });
      return payment;
    }),
  },
  paymentStateTransition: {
    create: jest.fn(async ({ data }: any) => {
      const transition = { id: `tr-${stateTransitions.length + 1}`, ...data, createdAt: new Date() };
      stateTransitions.push(transition);
      return transition;
    }),
    findMany: jest.fn(async ({ where }: any) => {
      return stateTransitions.filter(t => t.paymentId === where.paymentId);
    }),
  },
  idempotencyRecord: {
    findUnique: jest.fn(async ({ where }: any) => {
      return idempotencyRecords[where.idempotencyKey] || null;
    }),
    upsert: jest.fn(async ({ where, create, update }: any) => {
      if (idempotencyRecords[where.idempotencyKey]) {
        Object.assign(idempotencyRecords[where.idempotencyKey], update);
        return idempotencyRecords[where.idempotencyKey];
      }
      idempotencyRecords[where.idempotencyKey] = create;
      return create;
    }),
  },
  outboxEvent: {
    create: jest.fn(async ({ data }: any) => {
      const event = { id: `evt-${outboxEvents.length + 1}`, ...data, createdAt: new Date() };
      outboxEvents.push(event);
      return event;
    }),
  },
  $transaction: jest.fn(async (fn: (tx: any) => Promise<any>) => {
    return fn(mockPrisma);
  }),
} as any;

// ─── App setup ──────────────────────────────────────────────────────────────────

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(correlationId);
  app.use('/payments', authMiddleware, createPaymentRoutes(mockPrisma));
  app.use(errorHandler);
  return app;
}

// ─── Test constants ─────────────────────────────────────────────────────────────

const API_KEY = 'test-api-key';
const MERCHANT_ID = 'merchant-001';

function authHeaders(idempotencyKey?: string) {
  const headers: Record<string, string> = {
    Authorization: ['Bearer', API_KEY].join(' '),
    'X-Merchant-Id': MERCHANT_ID,
  };
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }
  return headers;
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe('Payment API Integration Tests', () => {
  let app: express.Application;

  beforeAll(() => {
    process.env.API_KEY = API_KEY;
  });

  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
    app = createApp();
  });

  // ─── POST /payments ─────────────────────────────────────────────────────────

  describe('POST /payments', () => {
    const validPayload = {
      amount_minor_units: 5000,
      currency: 'USD',
      payment_method_token: 'tok_visa_4242',
    };

    it('creates a payment and returns 201', async () => {
      const res = await request(app)
        .post('/payments')
        .set(authHeaders('idem-create-1'))
        .send(validPayload);

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        id: expect.any(String),
        merchant_id: MERCHANT_ID,
        amount_minor_units: 5000,
        currency: 'USD',
        status: 'pending',
        payment_method_token: '****4242',
        idempotency_key: 'idem-create-1',
      });
    });

    it('returns 400 when Idempotency-Key header is missing', async () => {
      const res = await request(app)
        .post('/payments')
        .set({ Authorization: ['Bearer', API_KEY].join(' '), 'X-Merchant-Id': MERCHANT_ID })
        .send(validPayload);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MISSING_IDEMPOTENCY_KEY');
    });

    it('returns 400 on invalid body', async () => {
      const res = await request(app)
        .post('/payments')
        .set(authHeaders('idem-invalid-body'))
        .send({ amount_minor_units: -100, currency: 'TOOLONG' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 401 without auth', async () => {
      const res = await request(app)
        .post('/payments')
        .send(validPayload);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 with invalid API key', async () => {
      const res = await request(app)
        .post('/payments')
        .set({ Authorization: ['Bearer', 'wrong-key'].join(' '), 'X-Merchant-Id': MERCHANT_ID, 'Idempotency-Key': 'k1' })
        .send(validPayload);

      expect(res.status).toBe(401);
    });

    it('returns the same response for duplicate idempotency key with same payload', async () => {
      // First request
      const res1 = await request(app)
        .post('/payments')
        .set(authHeaders('idem-dup-1'))
        .send(validPayload);

      expect(res1.status).toBe(201);

      // Second request with same idempotency key — should replay
      const res2 = await request(app)
        .post('/payments')
        .set(authHeaders('idem-dup-1'))
        .send(validPayload);

      expect(res2.status).toBe(201);
      expect(res2.body.id).toBe(res1.body.id);
    });

    it('returns 422 when idempotency key is reused with different payload', async () => {
      // First request
      await request(app)
        .post('/payments')
        .set(authHeaders('idem-conflict'))
        .send(validPayload);

      // Second request with same key, different body
      const res = await request(app)
        .post('/payments')
        .set(authHeaders('idem-conflict'))
        .send({ ...validPayload, amount_minor_units: 9999 });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    });
  });

  // ─── GET /payments ──────────────────────────────────────────────────────────

  describe('GET /payments', () => {
    it('returns paginated list of payments', async () => {
      // Create two payments
      await request(app)
        .post('/payments')
        .set(authHeaders('idem-list-1'))
        .send({ amount_minor_units: 1000, currency: 'USD', payment_method_token: 'tok_1' });

      await request(app)
        .post('/payments')
        .set(authHeaders('idem-list-2'))
        .send({ amount_minor_units: 2000, currency: 'GBP', payment_method_token: 'tok_2' });

      const res = await request(app)
        .get('/payments')
        .set(authHeaders());

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.pagination).toMatchObject({
        page: 1,
        per_page: 20,
        total: 2,
        total_pages: 1,
      });
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/payments');
      expect(res.status).toBe(401);
    });

    it('returns 403 when querying another merchant', async () => {
      const res = await request(app)
        .get('/payments?merchant_id=other-merchant')
        .set(authHeaders());

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  // ─── GET /payments/:id ──────────────────────────────────────────────────────

  describe('GET /payments/:id', () => {
    it('returns payment details with state transitions', async () => {
      const createRes = await request(app)
        .post('/payments')
        .set(authHeaders('idem-detail-1'))
        .send({ amount_minor_units: 3000, currency: 'EUR', payment_method_token: 'tok_detail' });

      const paymentId = createRes.body.id;

      const res = await request(app)
        .get(`/payments/${paymentId}`)
        .set(authHeaders());

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(paymentId);
      expect(res.body.state_transitions).toBeInstanceOf(Array);
      expect(res.body.state_transitions.length).toBeGreaterThanOrEqual(1);
      expect(res.body.state_transitions[0]).toMatchObject({
        from_status: 'initial',
        to_status: 'pending',
      });
    });

    it('returns 404 for non-existent payment', async () => {
      const res = await request(app)
        .get('/payments/non-existent-id')
        .set(authHeaders());

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 404 for payment belonging to another merchant', async () => {
      // Create payment as merchant-001
      const createRes = await request(app)
        .post('/payments')
        .set(authHeaders('idem-other-merchant'))
        .send({ amount_minor_units: 1000, currency: 'USD', payment_method_token: 'tok_x' });

      const paymentId = createRes.body.id;

      // Manually change merchant to simulate another merchant's payment
      payments[paymentId].merchantId = 'other-merchant';

      const res = await request(app)
        .get(`/payments/${paymentId}`)
        .set(authHeaders());

      expect(res.status).toBe(404);
    });
  });

  // ─── POST /payments/:id/capture ─────────────────────────────────────────────

  describe('POST /payments/:id/capture', () => {
    it('captures an authorized payment', async () => {
      // Create and manually set to authorized
      const createRes = await request(app)
        .post('/payments')
        .set(authHeaders('idem-capture-setup'))
        .send({ amount_minor_units: 5000, currency: 'USD', payment_method_token: 'tok_cap' });

      const paymentId = createRes.body.id;
      payments[paymentId].status = 'authorized';

      const res = await request(app)
        .post(`/payments/${paymentId}/capture`)
        .set(authHeaders('idem-capture-1'));

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('captured');
    });

    it('returns 409 for invalid state transition (pending → captured)', async () => {
      const createRes = await request(app)
        .post('/payments')
        .set(authHeaders('idem-capture-invalid'))
        .send({ amount_minor_units: 5000, currency: 'USD', payment_method_token: 'tok_inv' });

      const paymentId = createRes.body.id;

      const res = await request(app)
        .post(`/payments/${paymentId}/capture`)
        .set(authHeaders('idem-capture-invalid-2'));

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('writes an outbox event in the same transaction as capture', async () => {
      const createRes = await request(app)
        .post('/payments')
        .set(authHeaders('idem-outbox-test'))
        .send({ amount_minor_units: 7000, currency: 'GBP', payment_method_token: 'tok_outbox' });

      const paymentId = createRes.body.id;
      payments[paymentId].status = 'authorized';

      await request(app)
        .post(`/payments/${paymentId}/capture`)
        .set(authHeaders('idem-outbox-capture'));

      // Verify outbox event was created
      expect(mockPrisma.outboxEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          paymentId,
          eventType: 'payment.captured',
          payload: expect.objectContaining({
            payment_id: paymentId,
            correlation_id: expect.any(String),
          }),
        }),
      });
    });

    it('capture is idempotent with same idempotency key', async () => {
      const createRes = await request(app)
        .post('/payments')
        .set(authHeaders('idem-cap-idem-setup'))
        .send({ amount_minor_units: 2000, currency: 'USD', payment_method_token: 'tok_idem' });

      const paymentId = createRes.body.id;
      payments[paymentId].status = 'authorized';

      const res1 = await request(app)
        .post(`/payments/${paymentId}/capture`)
        .set(authHeaders('idem-cap-repeat'));

      expect(res1.status).toBe(200);

      // Second capture with same key — should replay
      const res2 = await request(app)
        .post(`/payments/${paymentId}/capture`)
        .set(authHeaders('idem-cap-repeat'));

      expect(res2.status).toBe(200);
      expect(res2.body.id).toBe(res1.body.id);
    });
  });

  // ─── POST /payments/:id/refund ──────────────────────────────────────────────

  describe('POST /payments/:id/refund', () => {
    it('refunds a captured payment', async () => {
      const createRes = await request(app)
        .post('/payments')
        .set(authHeaders('idem-refund-setup'))
        .send({ amount_minor_units: 4000, currency: 'USD', payment_method_token: 'tok_ref' });

      const paymentId = createRes.body.id;
      payments[paymentId].status = 'captured';

      const res = await request(app)
        .post(`/payments/${paymentId}/refund`)
        .set(authHeaders('idem-refund-1'))
        .send({ reason: 'Customer requested' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('refunded');
    });

    it('refunds a settled payment', async () => {
      const createRes = await request(app)
        .post('/payments')
        .set(authHeaders('idem-refund-settled'))
        .send({ amount_minor_units: 6000, currency: 'EUR', payment_method_token: 'tok_sref' });

      const paymentId = createRes.body.id;
      payments[paymentId].status = 'settled';

      const res = await request(app)
        .post(`/payments/${paymentId}/refund`)
        .set(authHeaders('idem-refund-settled-1'));

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('refunded');
    });

    it('returns 409 for invalid state transition (pending → refunded)', async () => {
      const createRes = await request(app)
        .post('/payments')
        .set(authHeaders('idem-refund-invalid'))
        .send({ amount_minor_units: 3000, currency: 'USD', payment_method_token: 'tok_rinv' });

      const paymentId = createRes.body.id;

      const res = await request(app)
        .post(`/payments/${paymentId}/refund`)
        .set(authHeaders('idem-refund-invalid-2'));

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('returns 404 for non-existent payment', async () => {
      const res = await request(app)
        .post('/payments/no-such-payment/refund')
        .set(authHeaders('idem-refund-404'));

      expect(res.status).toBe(404);
    });
  });

  // ─── Correlation ID propagation ─────────────────────────────────────────────

  describe('Correlation ID', () => {
    it('echoes X-Request-Id in response when provided', async () => {
      const res = await request(app)
        .post('/payments')
        .set({ ...authHeaders('idem-corr-1'), 'X-Request-Id': 'my-trace-id' })
        .send({ amount_minor_units: 1000, currency: 'USD', payment_method_token: 'tok_corr' });

      expect(res.headers['x-request-id']).toBe('my-trace-id');
    });

    it('generates X-Request-Id when not provided', async () => {
      const res = await request(app)
        .post('/payments')
        .set(authHeaders('idem-corr-2'))
        .send({ amount_minor_units: 1000, currency: 'USD', payment_method_token: 'tok_corr2' });

      expect(res.headers['x-request-id']).toBeDefined();
      expect(res.headers['x-request-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });

  // ─── Security: Token masking ────────────────────────────────────────────────

  describe('Security', () => {
    it('never exposes full payment_method_token in responses', async () => {
      const res = await request(app)
        .post('/payments')
        .set(authHeaders('idem-sec-1'))
        .send({ amount_minor_units: 1000, currency: 'USD', payment_method_token: 'tok_sensitive_1234' });

      expect(res.body.payment_method_token).toBe('****1234');
      expect(res.body.payment_method_token).not.toContain('sensitive');
    });
  });
});
