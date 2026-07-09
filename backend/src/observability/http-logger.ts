import pinoHttp from 'pino-http';
import { logger } from './logger';
import { Request } from 'express';

/**
 * HTTP request/response logging middleware powered by pino-http.
 * Attaches correlation ID to every log line for end-to-end traceability.
 */
export const httpLogger = pinoHttp({
  logger,
  // Generate request ID from correlation middleware (already set by correlationId middleware)
  genReqId: (req) => (req as Request).correlationId || req.headers['x-request-id'] as string || 'unknown',
  // Custom log message
  customSuccessMessage: (req, res) => {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  customErrorMessage: (req, res) => {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  // Don't log health check endpoints to avoid noise
  autoLogging: {
    ignore: (req) => {
      const url = req.url || '';
      return url === '/healthz' || url === '/readyz';
    },
  },
  // Custom attributes added to every request log
  customProps: (req) => ({
    correlationId: (req as Request).correlationId,
    merchantId: (req as Request).merchantId,
  }),
});
