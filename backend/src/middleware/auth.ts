import { Request, Response, NextFunction } from 'express';
import { buildErrorEnvelope } from './error-envelope';

/**
 * Simple API-key authentication middleware.
 *
 * Expects: Authorization: ******
 *
 * In a real system this would validate a JWT or session token and extract
 * tenant information. Here we accept a single API key from env and derive
 * merchant_id from a custom header (X-Merchant-Id) to simulate multi-tenant access.
 *
 * Security note: merchant_id is derived from the authenticated principal
 * (simulated via header after auth), never trusted from the request body.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.correlationId || 'unknown';
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json(buildErrorEnvelope('UNAUTHORIZED', 'Missing or invalid Authorization header', requestId));
    return;
  }

  const token = authHeader.slice(7);
  const expectedKey = process.env.API_KEY;

  if (!expectedKey || token !== expectedKey) {
    res.status(401).json(buildErrorEnvelope('UNAUTHORIZED', 'Invalid API key', requestId));
    return;
  }

  // Derive merchant_id from the authenticated principal.
  // In production this would come from the token claims.
  const merchantId = req.headers['x-merchant-id'] as string;
  if (!merchantId) {
    res.status(400).json(buildErrorEnvelope('MISSING_MERCHANT_ID', 'X-Merchant-Id header is required', requestId));
    return;
  }

  req.merchantId = merchantId;
  next();
}
