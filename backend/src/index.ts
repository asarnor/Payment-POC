import express from 'express';
import prisma from './prisma';
import { correlationId, authMiddleware, errorHandler } from './middleware';
import { createPaymentRoutes } from './routes/payments';

const app = express();
const port = process.env.PORT ?? 3000;

// ─── Global middleware ──────────────────────────────────────────────────────
app.use(express.json());
app.use(correlationId);

// ─── Public routes (no auth) ────────────────────────────────────────────────
app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

// ─── Authenticated routes ───────────────────────────────────────────────────
app.use('/payments', authMiddleware, createPaymentRoutes(prisma));

// ─── Global error handler ───────────────────────────────────────────────────
app.use(errorHandler);

// ─── Start server ───────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

export default app;
