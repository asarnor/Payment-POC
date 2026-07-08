import { Request, Response, NextFunction } from 'express';
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('payment-poc-http', '1.0.0');

/**
 * Express middleware that wraps each request in an OpenTelemetry span.
 * The span name is `HTTP {method} {route}` and carries correlation_id
 * as an attribute so traces connect back to the originating request.
 */
export function tracingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const spanName = `HTTP ${req.method} ${req.path}`;

  const span = tracer.startSpan(spanName, {
    attributes: {
      'http.method': req.method,
      'http.url': req.originalUrl,
      'http.target': req.path,
      'correlation.id': req.correlationId || 'unknown',
    },
  });

  // Attach span info on response finish
  res.on('finish', () => {
    span.setAttribute('http.status_code', res.statusCode);

    if (res.statusCode >= 400) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${res.statusCode}` });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }

    // Set the normalized route if available
    if (req.route?.path) {
      span.setAttribute('http.route', `${req.baseUrl}${req.route.path}`);
      span.updateName(`HTTP ${req.method} ${req.baseUrl}${req.route.path}`);
    }

    span.end();
  });

  next();
}
