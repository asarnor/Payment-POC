import { Request, Response, NextFunction } from 'express';

/**
 * Standard error response envelope used across all endpoints.
 */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    request_id: string;
  };
}

/**
 * Application error base class with HTTP status code and error code.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * Builds a consistent error envelope.
 */
export function buildErrorEnvelope(code: string, message: string, requestId: string): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      request_id: requestId,
    },
  };
}

/**
 * Global error handler middleware — catches thrown errors and returns
 * a consistent JSON error envelope.
 */
export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const requestId = req.correlationId || 'unknown';

  if (err instanceof AppError) {
    res.status(err.statusCode).json(buildErrorEnvelope(err.code, err.message, requestId));
    return;
  }

  // IdempotencyKeyConflictError from the idempotency module
  if (err.name === 'IdempotencyKeyConflictError') {
    res.status(422).json(buildErrorEnvelope('IDEMPOTENCY_KEY_CONFLICT', err.message, requestId));
    return;
  }

  // Fallback: internal server error
  res.status(500).json(buildErrorEnvelope('INTERNAL_ERROR', 'An unexpected error occurred', requestId));
}
