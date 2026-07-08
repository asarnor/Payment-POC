import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { PrismaClient, PaymentStatus, Prisma } from '@prisma/client';
import {
  validateTransition,
  checkIdempotency,
  storeIdempotencyRecord,
} from '../modules';
import { AppError, buildErrorEnvelope } from '../middleware';

// ─── Zod Schemas ───────────────────────────────────────────────────────────────

const createPaymentSchema = z.object({
  amount_minor_units: z.number().int().positive(),
  currency: z.string().length(3),
  payment_method_token: z.string().min(1),
});

const listPaymentsQuerySchema = z.object({
  status: z.nativeEnum(PaymentStatus).optional(),
  merchant_id: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
});

// ─── Helper ────────────────────────────────────────────────────────────────────

function getRequestId(req: Request): string {
  return req.correlationId || 'unknown';
}

function getMerchantId(req: Request): string {
  if (!req.merchantId) {
    throw new AppError(401, 'UNAUTHORIZED', 'Merchant ID not resolved');
  }
  return req.merchantId;
}

// ─── Route Factory ─────────────────────────────────────────────────────────────

export function createPaymentRoutes(prisma: PrismaClient): Router {
  const router = Router();

  // ───────────────────────────────────────────────────────────────────────────
  // POST /payments — Create a new payment (Pending)
  // ───────────────────────────────────────────────────────────────────────────
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const requestId = getRequestId(req);
      const merchantId = getMerchantId(req);

      // Require Idempotency-Key header
      const idempotencyKey = req.headers['idempotency-key'] as string;
      if (!idempotencyKey) {
        res.status(400).json(
          buildErrorEnvelope('MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key header is required', requestId),
        );
        return;
      }

      // Validate body
      const parseResult = createPaymentSchema.safeParse(req.body);
      if (!parseResult.success) {
        const message = parseResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
        res.status(400).json(buildErrorEnvelope('VALIDATION_ERROR', message, requestId));
        return;
      }

      const { amount_minor_units, currency, payment_method_token } = parseResult.data;

      // Check idempotency
      const idempotencyResult = await checkIdempotency(prisma, idempotencyKey, 'POST /payments', req.body);
      if (idempotencyResult.isDuplicate) {
        res.status(idempotencyResult.statusCode!).json(idempotencyResult.responseSnapshot);
        return;
      }

      // Create payment + initial state transition in a transaction
      const payment = await prisma.$transaction(async (tx) => {
        const p = await tx.payment.create({
          data: {
            merchantId,
            amountMinorUnits: amount_minor_units,
            currency: currency.toUpperCase(),
            paymentMethodToken: payment_method_token,
            idempotencyKey,
            status: PaymentStatus.pending,
          },
        });

        await tx.paymentStateTransition.create({
          data: {
            paymentId: p.id,
            fromStatus: 'initial',
            toStatus: PaymentStatus.pending,
            actor: `merchant:${merchantId}`,
            correlationId: requestId,
          },
        });

        return p;
      });

      const responseBody = formatPaymentResponse(payment);

      // Store idempotency record
      await storeIdempotencyRecord(prisma, {
        idempotencyKey,
        endpoint: 'POST /payments',
        requestBody: req.body,
        responseSnapshot: responseBody,
        statusCode: 201,
      });

      res.status(201).json(responseBody);
    } catch (err) {
      next(err);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // GET /payments — Paginated list with filters
  // ───────────────────────────────────────────────────────────────────────────
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const requestId = getRequestId(req);
      const merchantId = getMerchantId(req);

      const parseResult = listPaymentsQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        const message = parseResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
        res.status(400).json(buildErrorEnvelope('VALIDATION_ERROR', message, requestId));
        return;
      }

      const { status, merchant_id, from, to, page, per_page } = parseResult.data;

      // Build filter — always scope to the authenticated merchant unless query specifies the same one
      const where: Record<string, unknown> = { merchantId };

      // Allow filtering by merchant_id only if it matches the authenticated merchant
      if (merchant_id && merchant_id !== merchantId) {
        res.status(403).json(
          buildErrorEnvelope('FORBIDDEN', 'Cannot query payments for another merchant', requestId),
        );
        return;
      }

      if (status) where.status = status;

      if (from || to) {
        const createdAt: Record<string, Date> = {};
        if (from) createdAt.gte = new Date(from);
        if (to) createdAt.lte = new Date(to);
        where.createdAt = createdAt;
      }

      const [payments, total] = await Promise.all([
        prisma.payment.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * per_page,
          take: per_page,
        }),
        prisma.payment.count({ where }),
      ]);

      res.json({
        data: payments.map(formatPaymentResponse),
        pagination: {
          page,
          per_page,
          total,
          total_pages: Math.ceil(total / per_page),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // GET /payments/:id — Details + full state-transition history
  // ───────────────────────────────────────────────────────────────────────────
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const requestId = getRequestId(req);
      const merchantId = getMerchantId(req);

      const payment = await prisma.payment.findUnique({
        where: { id: req.params.id as string },
      });

      if (!payment) {
        res.status(404).json(buildErrorEnvelope('NOT_FOUND', 'Payment not found', requestId));
        return;
      }

      // Ensure merchant can only view their own payments
      if (payment.merchantId !== merchantId) {
        res.status(404).json(buildErrorEnvelope('NOT_FOUND', 'Payment not found', requestId));
        return;
      }

      const transitions = await prisma.paymentStateTransition.findMany({
        where: { paymentId: payment.id },
        orderBy: { createdAt: 'asc' },
      });

      res.json({
        ...formatPaymentResponse(payment),
        state_transitions: transitions.map(t => ({
          id: t.id,
          from_status: t.fromStatus,
          to_status: t.toStatus,
          reason: t.reason,
          actor: t.actor,
          correlation_id: t.correlationId,
          created_at: t.createdAt.toISOString(),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // POST /payments/:id/capture — Authorized → Captured (Idempotent)
  // ───────────────────────────────────────────────────────────────────────────
  router.post('/:id/capture', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const requestId = getRequestId(req);
      const merchantId = getMerchantId(req);

      // Idempotency-Key is required for capture
      const idempotencyKey = req.headers['idempotency-key'] as string;
      if (!idempotencyKey) {
        res.status(400).json(
          buildErrorEnvelope('MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key header is required', requestId),
        );
        return;
      }

      // Check idempotency
      const idempotencyResult = await checkIdempotency(
        prisma, idempotencyKey, `POST /payments/${req.params.id as string}/capture`, req.body || {},
      );
      if (idempotencyResult.isDuplicate) {
        res.status(idempotencyResult.statusCode!).json(idempotencyResult.responseSnapshot);
        return;
      }

      const payment = await prisma.payment.findUnique({ where: { id: req.params.id as string } });

      if (!payment) {
        res.status(404).json(buildErrorEnvelope('NOT_FOUND', 'Payment not found', requestId));
        return;
      }

      if (payment.merchantId !== merchantId) {
        res.status(404).json(buildErrorEnvelope('NOT_FOUND', 'Payment not found', requestId));
        return;
      }

      // Validate state transition
      const transitionError = validateTransition(payment.status, PaymentStatus.captured, requestId);
      if (transitionError) {
        res.status(409).json(transitionError);
        return;
      }

      // Perform capture + outbox event in one transaction
      const updated = await prisma.$transaction(async (tx) => {
        const p = await tx.payment.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.captured },
        });

        await tx.paymentStateTransition.create({
          data: {
            paymentId: payment.id,
            fromStatus: payment.status,
            toStatus: PaymentStatus.captured,
            actor: `merchant:${merchantId}`,
            correlationId: requestId,
          },
        });

        // Transactional outbox: write settlement event in the same transaction
        await tx.outboxEvent.create({
          data: {
            paymentId: payment.id,
            eventType: 'payment.captured',
            payload: {
              payment_id: payment.id,
              merchant_id: merchantId,
              amount_minor_units: payment.amountMinorUnits,
              currency: payment.currency,
              correlation_id: requestId,
            },
          },
        });

        return p;
      });

      const responseBody = formatPaymentResponse(updated);

      await storeIdempotencyRecord(prisma, {
        idempotencyKey,
        endpoint: `POST /payments/${req.params.id as string}/capture`,
        requestBody: req.body || {},
        responseSnapshot: responseBody,
        statusCode: 200,
      });

      res.json(responseBody);
    } catch (err) {
      next(err);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // POST /payments/:id/refund — Captured/Settled → Refunded (Idempotent)
  // ───────────────────────────────────────────────────────────────────────────
  router.post('/:id/refund', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const requestId = getRequestId(req);
      const merchantId = getMerchantId(req);

      // Idempotency-Key is required for refund
      const idempotencyKey = req.headers['idempotency-key'] as string;
      if (!idempotencyKey) {
        res.status(400).json(
          buildErrorEnvelope('MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key header is required', requestId),
        );
        return;
      }

      // Check idempotency
      const idempotencyResult = await checkIdempotency(
        prisma, idempotencyKey, `POST /payments/${req.params.id as string}/refund`, req.body || {},
      );
      if (idempotencyResult.isDuplicate) {
        res.status(idempotencyResult.statusCode!).json(idempotencyResult.responseSnapshot);
        return;
      }

      const payment = await prisma.payment.findUnique({ where: { id: req.params.id as string } });

      if (!payment) {
        res.status(404).json(buildErrorEnvelope('NOT_FOUND', 'Payment not found', requestId));
        return;
      }

      if (payment.merchantId !== merchantId) {
        res.status(404).json(buildErrorEnvelope('NOT_FOUND', 'Payment not found', requestId));
        return;
      }

      // Validate state transition
      const transitionError = validateTransition(payment.status, PaymentStatus.refunded, requestId);
      if (transitionError) {
        res.status(409).json(transitionError);
        return;
      }

      const reason = req.body?.reason as string | undefined;

      const updated = await prisma.$transaction(async (tx) => {
        const p = await tx.payment.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.refunded },
        });

        await tx.paymentStateTransition.create({
          data: {
            paymentId: payment.id,
            fromStatus: payment.status,
            toStatus: PaymentStatus.refunded,
            reason: reason || null,
            actor: `merchant:${merchantId}`,
            correlationId: requestId,
          },
        });

        return p;
      });

      const responseBody = formatPaymentResponse(updated);

      await storeIdempotencyRecord(prisma, {
        idempotencyKey,
        endpoint: `POST /payments/${req.params.id as string}/refund`,
        requestBody: req.body || {},
        responseSnapshot: responseBody,
        statusCode: 200,
      });

      res.json(responseBody);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

// ─── Response Formatter ──────────────────────────────────────────────────────

function formatPaymentResponse(payment: {
  id: string;
  merchantId: string;
  amountMinorUnits: number;
  currency: string;
  status: PaymentStatus;
  paymentMethodToken: string;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: payment.id,
    merchant_id: payment.merchantId,
    amount_minor_units: payment.amountMinorUnits,
    currency: payment.currency,
    status: payment.status,
    payment_method_token: maskToken(payment.paymentMethodToken),
    idempotency_key: payment.idempotencyKey,
    created_at: payment.createdAt.toISOString(),
    updated_at: payment.updatedAt.toISOString(),
  };
}

/**
 * Masks a payment method token for security. Never exposes full token.
 */
function maskToken(token: string): string {
  if (token.length <= 4) return '****';
  return '****' + token.slice(-4);
}
