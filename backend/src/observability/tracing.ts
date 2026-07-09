import { NodeSDK } from '@opentelemetry/sdk-node';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';
import { trace, context, SpanStatusCode, Span } from '@opentelemetry/api';

// ─── SDK initialization ─────────────────────────────────────────────────────

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME || 'payment-poc',
  traceExporter: new ConsoleSpanExporter(),
});

/**
 * Initialize OpenTelemetry. Call once at application startup.
 * Structured so an OTLP exporter is a drop-in swap later:
 *   - Replace ConsoleSpanExporter with OTLPTraceExporter
 *   - Set OTEL_EXPORTER_OTLP_ENDPOINT env var
 */
export function initTracing(): void {
  if (process.env.NODE_ENV === 'test') return;
  sdk.start();
}

export async function shutdownTracing(): Promise<void> {
  await sdk.shutdown();
}

// ─── Tracer for the application ─────────────────────────────────────────────

const tracer = trace.getTracer('payment-poc', '1.0.0');

// ─── Helper: wrap an async function in a span ───────────────────────────────

export async function withSpan<T>(
  spanName: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(spanName, async (span) => {
    try {
      for (const [key, value] of Object.entries(attributes)) {
        span.setAttribute(key, value);
      }
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  });
}

export { tracer, trace, context, SpanStatusCode };
