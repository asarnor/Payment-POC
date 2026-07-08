import { PaymentStatus } from '@prisma/client';

/**
 * Payment state machine — the single source of truth for valid status transitions.
 * Maps each status to the set of statuses it may transition to.
 */
const VALID_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  [PaymentStatus.pending]: [PaymentStatus.authorized, PaymentStatus.failed],
  [PaymentStatus.authorized]: [PaymentStatus.captured, PaymentStatus.failed],
  [PaymentStatus.captured]: [PaymentStatus.settled, PaymentStatus.refunded, PaymentStatus.failed],
  [PaymentStatus.settled]: [PaymentStatus.refunded],
  [PaymentStatus.failed]: [],
  [PaymentStatus.refunded]: [],
};

export interface InvalidTransitionError {
  error: {
    code: 'INVALID_STATE_TRANSITION';
    message: string;
    request_id: string;
  };
}

/**
 * Returns true if the transition from `from` to `to` is valid.
 */
export function isValidTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

/**
 * Returns the list of valid next statuses from a given status.
 */
export function validNextStatuses(from: PaymentStatus): PaymentStatus[] {
  return [...VALID_TRANSITIONS[from]];
}

/**
 * Asserts that a transition is valid. If not, returns an error object
 * suitable for a 409 response.
 */
export function validateTransition(
  from: PaymentStatus,
  to: PaymentStatus,
  requestId: string,
): InvalidTransitionError | null {
  if (isValidTransition(from, to)) {
    return null;
  }

  return {
    error: {
      code: 'INVALID_STATE_TRANSITION',
      message: `Cannot transition from '${from}' to '${to}'`,
      request_id: requestId,
    },
  };
}
