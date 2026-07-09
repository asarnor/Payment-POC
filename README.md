# Payment Processing Platform — POC

A production-minded payment processing platform demonstrating depth in system design, code quality, and engineering tradeoffs. Built as a senior engineering take-home exercise prioritizing correctness and operational maturity over feature breadth.

## Setup

### Prerequisites

- Docker & Docker Compose (v3.9+)
- Node.js 18+ and npm (for local development)

### One-command start (recommended)

```bash
# Copy environment file and adjust if needed
cp .env.example .env

# Start all services (Postgres, backend API, frontend dashboard)
docker-compose up --build
```

Services will be available at:
- **Backend API**: http://localhost:3000
- **Frontend Dashboard**: http://localhost:5173
- **PostgreSQL**: localhost:5432

### Local development

```bash
# Start only the database
docker-compose up postgres

# Backend
cd backend
npm install
npx prisma migrate deploy
npm run dev          # API server on :3000
npm run worker       # Settlement worker (separate terminal)

# Frontend
cd frontend
npm install
npm run dev          # Vite dev server on :5173
```

### Running tests

```bash
cd backend
npm test             # Runs all unit + integration tests
npm run typecheck    # TypeScript type checking
```

### API authentication

All `/payments` endpoints require:
- `Authorization` header with a valid ****** (set `API_KEY` in `.env`)
- `X-Merchant-Id: <merchant_id>` header (simulates tenant context derived from auth token)

Example:
```bash
curl -X POST http://localhost:3000/payments \
  -H "Content-Type: application/json" \
  -H "Authorization: ******" \
  -H "X-Merchant-Id: merchant-001" \
  -H "Idempotency-Key: unique-key-123" \
  -d '{"amount_minor_units": 5000, "currency": "USD", "payment_method_token": "tok_visa_4242"}'
```

## Architectural overview

```
┌──────────────┐     ┌────────────────────────┐     ┌──────────────┐
│   Frontend   │────▶│     Backend API         │────▶│  PostgreSQL  │
│  React/Vite  │     │  Express + TypeScript   │     │   (Prisma)   │
└──────────────┘     └────────────────────────┘     └──────────────┘
                              │                              │
                              │                    ┌─────────┴────────┐
                              │                    │  outbox_events   │
                              │                    └─────────┬────────┘
                              │                              │
                     ┌────────┴──────────┐                   │
                     │ Settlement Worker │◀──────────────────┘
                     │  (polling loop)   │
                     └───────────────────┘
```

### Key components

- **State Machine** (`src/modules/state-machine.ts`): Single source of truth for valid payment status transitions. Enforces the flow: `pending → authorized → captured → settled/refunded`. Terminal states (`failed`, `refunded`) cannot transition further.

- **Idempotency Module** (`src/modules/idempotency.ts`): Request deduplication via SHA-256 hash of the request body + idempotency key. Prevents duplicate payment creation and double-captures/refunds.

- **Transactional Outbox** (`outbox_events` table): Ensures exactly-once delivery semantics. When a payment is captured, both the status update and the outbox event are written in a single database transaction — eliminating dual-write inconsistencies.

- **Settlement Worker** (`src/worker/settlement-worker.ts`): Polls the outbox for pending events, simulates settlement, and transitions payments from `captured → settled`. Implements exponential backoff with full jitter and dead-letter queue after N attempts.

- **Observability Stack**: Structured JSON logging (pino), Prometheus metrics (RED pattern + business counters + worker metrics), OpenTelemetry tracing with correlation ID propagation from API request through worker execution.

- **Auth Middleware**: API-key authentication with merchant isolation. `merchant_id` is derived from the authenticated principal, never from the request body — preventing cross-tenant access.

### Data model

| Table | Purpose |
|-------|---------|
| `payments` | Core payment records with status, amount, currency |
| `payment_state_transitions` | Append-only audit log of every status change |
| `idempotency_records` | Request deduplication with stored responses |
| `outbox_events` | Transactional outbox for async settlement processing |

## Tradeoffs

1. **DB-backed outbox over a message broker (Kafka/RabbitMQ)**: Trades throughput for simplicity and strong consistency. The transactional outbox pattern eliminates dual-write issues without infrastructure overhead. A message broker would be the next step at scale.

2. **Polling worker over change-data-capture (CDC)**: Simpler to implement and reason about. CDC (e.g., Debezium) would provide lower latency but adds significant operational complexity.

3. **Single API key auth over JWT/OAuth**: Keeps the focus on payment logic rather than auth infrastructure. In production, this would be replaced with proper JWT validation and tenant context extraction.

4. **In-memory mock Prisma for integration tests over a real test database**: Faster test execution, no Docker dependency for CI. Trades fidelity for speed — the 24 integration tests run in ~3 seconds. A real DB test suite is documented as future work.

5. **Amount stored as integer minor units over decimals/floats**: Eliminates floating-point precision issues inherent to money calculations. `5000` represents $50.00 (or £50.00, etc.).

6. **Exponential backoff with full jitter over fixed intervals**: Prevents thundering herd when the settlement service recovers after an outage. Randomization spreads retry load evenly.

7. **Masking payment tokens in responses**: Defense-in-depth. Even though tokens are pre-tokenized (not real PANs), we never expose full values in API responses or logs.

## Assumptions

- **Pre-tokenized payment methods**: The platform never handles raw card numbers (PAN/CVV). A PCI-compliant vendor tokenizes client-side before the token reaches our API.

- **Single-currency per payment**: Each payment operates in one currency. Multi-currency conversion is out of scope.

- **Merchant isolation via header**: In production, `merchant_id` would be extracted from a validated JWT claim. The `X-Merchant-Id` header simulates this post-authentication context.

- **Settlement is simulated**: The worker simulates an external PSP/banking call with configurable latency and failure rate. The interface is structured for a real HTTP client swap.

- **Sequential state machine**: Payments follow a linear progression (pending → authorized → captured → settled). Partial captures and split payments are not modeled.

- **Idempotency keys are client-generated**: The client is responsible for generating unique keys (UUIDs recommended). Keys are scoped per endpoint.

## Production considerations

- **Horizontal scaling**: The API layer is stateless and can scale horizontally behind a load balancer. The worker requires leader election or partitioned polling to avoid duplicate processing in multi-instance deployments.

- **Database**: Add connection pooling (PgBouncer), read replicas for the list/detail endpoints, and consider partitioning the `payment_state_transitions` table by date for large volumes.

- **Secrets management**: Replace `.env` files with a secrets manager (AWS Secrets Manager, HashiCorp Vault). The API key should be rotatable without downtime.

- **Rate limiting**: Add per-merchant rate limiting at the API gateway level to prevent abuse.

- **Monitoring & alerting**: The `/metrics` endpoint exposes Prometheus metrics ready for Grafana dashboards. Set alerts on: error rate spikes, `outbox_dead_letter_total` increasing, settlement duration P99 degradation.

- **OpenTelemetry**: Swap `ConsoleSpanExporter` for `OTLPTraceExporter` and point at Jaeger/Tempo for distributed tracing in production.

- **Dead letter queue processing**: Implement a separate reconciliation process or admin API to retry/investigate dead-lettered events.

- **Database migrations**: Use `prisma migrate deploy` in CI/CD. Consider blue-green deployments for schema changes that require backfills.

- **Graceful shutdown**: Both the API server and the settlement worker handle SIGTERM for zero-downtime deployments in Kubernetes.

- **Security hardening**: Add request body size limits, CORS configuration, security headers (Helmet), and input sanitization beyond Zod validation.

## Future improvements

- **Real database integration tests**: Add a test suite that spins up a PostgreSQL container (via testcontainers) for full-fidelity end-to-end API testing.

- **Webhook notifications**: Notify merchants of state changes (captured, settled, failed) via configurable webhook endpoints with retry logic.

- **Partial captures and refunds**: Support capturing/refunding a portion of the authorized amount.

- **Multi-currency support**: Add exchange rate handling and cross-currency settlement.

- **Admin API**: Expose endpoints for operations teams to query dead-letter events, retry failed settlements, and view system health dashboards.

- **API versioning**: Add `/v1/` prefix and content negotiation for backward-compatible evolution.

- **OpenAPI specification**: Generate an OpenAPI/Swagger doc from route definitions for client SDK generation.

- **Frontend testing**: Add React Testing Library tests for the dashboard components and Cypress/Playwright E2E tests.

- **Pagination cursor-based**: Replace offset pagination with cursor-based pagination for consistent results under concurrent writes.

- **Event sourcing**: Consider migrating from a state + audit log pattern to full event sourcing for richer temporal queries and replay capabilities.

- **Circuit breaker**: Add a circuit breaker pattern to the settlement worker to fast-fail when the downstream PSP is consistently unavailable.
