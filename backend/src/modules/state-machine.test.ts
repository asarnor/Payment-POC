import { PaymentStatus } from '@prisma/client';
import {
  isValidTransition,
  validateTransition,
  validNextStatuses,
} from './state-machine';

describe('Payment State Machine', () => {
  describe('valid transitions', () => {
    const validCases: [PaymentStatus, PaymentStatus][] = [
      [PaymentStatus.pending, PaymentStatus.authorized],
      [PaymentStatus.pending, PaymentStatus.failed],
      [PaymentStatus.authorized, PaymentStatus.captured],
      [PaymentStatus.authorized, PaymentStatus.failed],
      [PaymentStatus.captured, PaymentStatus.settled],
      [PaymentStatus.captured, PaymentStatus.refunded],
      [PaymentStatus.captured, PaymentStatus.failed],
      [PaymentStatus.settled, PaymentStatus.refunded],
    ];

    it.each(validCases)(
      'allows transition from %s to %s',
      (from, to) => {
        expect(isValidTransition(from, to)).toBe(true);
      },
    );

    it.each(validCases)(
      'validateTransition returns null for %s -> %s',
      (from, to) => {
        expect(validateTransition(from, to, 'req-123')).toBeNull();
      },
    );
  });

  describe('invalid transitions', () => {
    const invalidCases: [PaymentStatus, PaymentStatus][] = [
      // Cannot skip states
      [PaymentStatus.pending, PaymentStatus.captured],
      [PaymentStatus.pending, PaymentStatus.settled],
      [PaymentStatus.pending, PaymentStatus.refunded],
      [PaymentStatus.authorized, PaymentStatus.settled],
      [PaymentStatus.authorized, PaymentStatus.refunded],
      // Terminal states cannot transition
      [PaymentStatus.failed, PaymentStatus.pending],
      [PaymentStatus.failed, PaymentStatus.authorized],
      [PaymentStatus.failed, PaymentStatus.captured],
      [PaymentStatus.failed, PaymentStatus.settled],
      [PaymentStatus.failed, PaymentStatus.refunded],
      [PaymentStatus.refunded, PaymentStatus.pending],
      [PaymentStatus.refunded, PaymentStatus.authorized],
      [PaymentStatus.refunded, PaymentStatus.captured],
      [PaymentStatus.refunded, PaymentStatus.settled],
      [PaymentStatus.refunded, PaymentStatus.failed],
      // Cannot go backwards
      [PaymentStatus.authorized, PaymentStatus.pending],
      [PaymentStatus.captured, PaymentStatus.authorized],
      [PaymentStatus.captured, PaymentStatus.pending],
      [PaymentStatus.settled, PaymentStatus.captured],
      [PaymentStatus.settled, PaymentStatus.pending],
      [PaymentStatus.settled, PaymentStatus.authorized],
      // Self-transitions not allowed
      [PaymentStatus.pending, PaymentStatus.pending],
      [PaymentStatus.authorized, PaymentStatus.authorized],
      [PaymentStatus.captured, PaymentStatus.captured],
      [PaymentStatus.settled, PaymentStatus.settled],
    ];

    it.each(invalidCases)(
      'rejects transition from %s to %s',
      (from, to) => {
        expect(isValidTransition(from, to)).toBe(false);
      },
    );

    it.each(invalidCases)(
      'validateTransition returns 409 error for %s -> %s',
      (from, to) => {
        const result = validateTransition(from, to, 'req-456');

        expect(result).not.toBeNull();
        expect(result!.error.code).toBe('INVALID_STATE_TRANSITION');
        expect(result!.error.message).toContain(from);
        expect(result!.error.message).toContain(to);
        expect(result!.error.request_id).toBe('req-456');
      },
    );
  });

  describe('validNextStatuses', () => {
    it('returns [authorized, failed] for pending', () => {
      expect(validNextStatuses(PaymentStatus.pending)).toEqual(
        expect.arrayContaining([PaymentStatus.authorized, PaymentStatus.failed]),
      );
      expect(validNextStatuses(PaymentStatus.pending)).toHaveLength(2);
    });

    it('returns empty array for terminal states', () => {
      expect(validNextStatuses(PaymentStatus.failed)).toEqual([]);
      expect(validNextStatuses(PaymentStatus.refunded)).toEqual([]);
    });

    it('returns [settled, refunded, failed] for captured', () => {
      const next = validNextStatuses(PaymentStatus.captured);
      expect(next).toEqual(
        expect.arrayContaining([PaymentStatus.settled, PaymentStatus.refunded, PaymentStatus.failed]),
      );
      expect(next).toHaveLength(3);
    });

    it('returns [refunded] for settled', () => {
      expect(validNextStatuses(PaymentStatus.settled)).toEqual([PaymentStatus.refunded]);
    });
  });
});
