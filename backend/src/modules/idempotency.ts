import { Prisma, PrismaClient } from '@prisma/client';
import crypto from 'crypto';

export interface IdempotencyResult {
  /** True if this is a replay of an existing request */
  isDuplicate: boolean;
  /** The stored response snapshot (only present when isDuplicate is true) */
  responseSnapshot?: unknown;
  /** HTTP status code from the original response (only present when isDuplicate is true) */
  statusCode?: number;
}

export interface StoreIdempotencyParams {
  idempotencyKey: string;
  endpoint: string;
  requestBody: unknown;
  responseSnapshot: unknown;
  statusCode: number;
}

/**
 * Recursively sorts object keys to produce a deterministic structure.
 */
function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Computes a SHA-256 hash of the request body for comparison.
 * Ensures deterministic serialization via recursively sorted keys.
 */
export function computeRequestHash(body: unknown): string {
  const serialized = JSON.stringify(sortKeys(body));
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

/**
 * Checks whether a request with the given idempotency key has already been processed.
 *
 * If a record exists:
 * - If the request hash matches, returns the stored response (replay).
 * - If the request hash differs, throws an error (key reuse with different payload).
 *
 * If no record exists, returns { isDuplicate: false }.
 */
export async function checkIdempotency(
  prisma: PrismaClient,
  idempotencyKey: string,
  endpoint: string,
  requestBody: unknown,
): Promise<IdempotencyResult> {
  const record = await prisma.idempotencyRecord.findUnique({
    where: { idempotencyKey },
  });

  if (!record) {
    return { isDuplicate: false };
  }

  const currentHash = computeRequestHash(requestBody);

  if (record.requestHash !== currentHash) {
    throw new IdempotencyKeyConflictError(
      `Idempotency key '${idempotencyKey}' has already been used with a different request body`,
    );
  }

  if (record.endpoint !== endpoint) {
    throw new IdempotencyKeyConflictError(
      `Idempotency key '${idempotencyKey}' has already been used on a different endpoint`,
    );
  }

  const snapshot = record.responseSnapshot as { statusCode?: number; body?: unknown };

  return {
    isDuplicate: true,
    responseSnapshot: snapshot.body ?? snapshot,
    statusCode: snapshot.statusCode ?? 200,
  };
}

/**
 * Stores an idempotency record after a successful (or terminal) response.
 */
export async function storeIdempotencyRecord(
  prisma: PrismaClient,
  params: StoreIdempotencyParams,
): Promise<void> {
  const requestHash = computeRequestHash(params.requestBody);

  const snapshot = {
    statusCode: params.statusCode,
    body: params.responseSnapshot,
  } as unknown as Prisma.InputJsonValue;

  await prisma.idempotencyRecord.upsert({
    where: { idempotencyKey: params.idempotencyKey },
    create: {
      idempotencyKey: params.idempotencyKey,
      endpoint: params.endpoint,
      requestHash,
      responseSnapshot: snapshot,
      status: 'completed',
    },
    update: {
      responseSnapshot: snapshot,
      status: 'completed',
    },
  });
}

/**
 * Error thrown when an idempotency key is reused with a different payload or endpoint.
 */
export class IdempotencyKeyConflictError extends Error {
  public readonly code = 'IDEMPOTENCY_KEY_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyKeyConflictError';
  }
}
