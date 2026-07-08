import {
  checkIdempotency,
  storeIdempotencyRecord,
  computeRequestHash,
  IdempotencyKeyConflictError,
} from './idempotency';

// Mock PrismaClient
const mockFindUnique = jest.fn();
const mockUpsert = jest.fn();

const mockPrisma = {
  idempotencyRecord: {
    findUnique: mockFindUnique,
    upsert: mockUpsert,
  },
} as any;

describe('Idempotency Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('computeRequestHash', () => {
    it('produces a consistent hash for the same body', () => {
      const body = { amount: 1000, currency: 'USD', merchantId: 'merchant-1' };
      const hash1 = computeRequestHash(body);
      const hash2 = computeRequestHash(body);
      expect(hash1).toBe(hash2);
    });

    it('produces the same hash regardless of key order', () => {
      const body1 = { amount: 1000, currency: 'USD' };
      const body2 = { currency: 'USD', amount: 1000 };
      expect(computeRequestHash(body1)).toBe(computeRequestHash(body2));
    });

    it('produces different hashes for different bodies', () => {
      const body1 = { amount: 1000, currency: 'USD' };
      const body2 = { amount: 2000, currency: 'USD' };
      expect(computeRequestHash(body1)).not.toBe(computeRequestHash(body2));
    });

    it('returns a hex string of length 64 (SHA-256)', () => {
      const hash = computeRequestHash({ foo: 'bar' });
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('checkIdempotency', () => {
    const endpoint = 'POST /payments';
    const requestBody = { amount: 5000, currency: 'GBP' };
    const idempotencyKey = 'idem-key-123';

    it('returns isDuplicate: false when no record exists', async () => {
      mockFindUnique.mockResolvedValue(null);

      const result = await checkIdempotency(mockPrisma, idempotencyKey, endpoint, requestBody);

      expect(result.isDuplicate).toBe(false);
      expect(result.responseSnapshot).toBeUndefined();
    });

    it('returns isDuplicate: true with stored response when key and hash match', async () => {
      const storedResponse = { id: 'pay-1', status: 'pending' };
      mockFindUnique.mockResolvedValue({
        idempotencyKey,
        endpoint,
        requestHash: computeRequestHash(requestBody),
        responseSnapshot: { statusCode: 201, body: storedResponse },
        status: 'completed',
      });

      const result = await checkIdempotency(mockPrisma, idempotencyKey, endpoint, requestBody);

      expect(result.isDuplicate).toBe(true);
      expect(result.responseSnapshot).toEqual(storedResponse);
      expect(result.statusCode).toBe(201);
    });

    it('throws IdempotencyKeyConflictError when hash differs', async () => {
      mockFindUnique.mockResolvedValue({
        idempotencyKey,
        endpoint,
        requestHash: 'different-hash-value',
        responseSnapshot: { statusCode: 201, body: {} },
        status: 'completed',
      });

      await expect(
        checkIdempotency(mockPrisma, idempotencyKey, endpoint, requestBody),
      ).rejects.toThrow(IdempotencyKeyConflictError);
    });

    it('throws IdempotencyKeyConflictError when endpoint differs', async () => {
      mockFindUnique.mockResolvedValue({
        idempotencyKey,
        endpoint: 'POST /payments/pay-1/capture',
        requestHash: computeRequestHash(requestBody),
        responseSnapshot: { statusCode: 200, body: {} },
        status: 'completed',
      });

      await expect(
        checkIdempotency(mockPrisma, idempotencyKey, endpoint, requestBody),
      ).rejects.toThrow(IdempotencyKeyConflictError);
    });

    it('thrown error has correct code property', async () => {
      mockFindUnique.mockResolvedValue({
        idempotencyKey,
        endpoint,
        requestHash: 'different-hash',
        responseSnapshot: { statusCode: 201, body: {} },
        status: 'completed',
      });

      try {
        await checkIdempotency(mockPrisma, idempotencyKey, endpoint, requestBody);
        fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(IdempotencyKeyConflictError);
        expect((err as IdempotencyKeyConflictError).code).toBe('IDEMPOTENCY_KEY_CONFLICT');
      }
    });
  });

  describe('storeIdempotencyRecord', () => {
    it('stores a record with the correct shape', async () => {
      mockUpsert.mockResolvedValue({});

      const params = {
        idempotencyKey: 'key-abc',
        endpoint: 'POST /payments',
        requestBody: { amount: 1000, currency: 'USD' },
        responseSnapshot: { id: 'pay-1', status: 'pending' },
        statusCode: 201,
      };

      await storeIdempotencyRecord(mockPrisma, params);

      expect(mockUpsert).toHaveBeenCalledTimes(1);
      const call = mockUpsert.mock.calls[0][0];
      expect(call.where.idempotencyKey).toBe('key-abc');
      expect(call.create.idempotencyKey).toBe('key-abc');
      expect(call.create.endpoint).toBe('POST /payments');
      expect(call.create.requestHash).toBe(computeRequestHash(params.requestBody));
      expect(call.create.responseSnapshot).toEqual({
        statusCode: 201,
        body: { id: 'pay-1', status: 'pending' },
      });
      expect(call.create.status).toBe('completed');
    });

    it('uses upsert to handle race conditions gracefully', async () => {
      mockUpsert.mockResolvedValue({});

      await storeIdempotencyRecord(mockPrisma, {
        idempotencyKey: 'key-race',
        endpoint: 'POST /payments',
        requestBody: { amount: 500 },
        responseSnapshot: { id: 'pay-2' },
        statusCode: 201,
      });

      const call = mockUpsert.mock.calls[0][0];
      expect(call.update).toBeDefined();
      expect(call.update.responseSnapshot).toEqual({
        statusCode: 201,
        body: { id: 'pay-2' },
      });
    });
  });
});
