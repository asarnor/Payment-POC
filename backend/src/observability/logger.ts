import pino from 'pino';

/**
 * Application-wide structured JSON logger.
 * Redacts sensitive fields (payment_method_token) to prevent PCI data leaks.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: ['payment_method_token', 'req.headers.authorization', 'req.headers["x-api-key"]'],
    censor: '[REDACTED]',
  },
  serializers: {
    ...pino.stdSerializers,
  },
  ...(process.env.NODE_ENV === 'test' ? { level: 'silent' } : {}),
});

export default logger;
