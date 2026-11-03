/**
 * Recovery decision policy (Milestone 2.12A).
 *
 * One pure decision table shared by RunCoordinator.recoverStaleExecutions (the sweeper) and
 * RunCoordinator.recoverMission (the supervisor). It decides what happens to the latest Attempt and its
 * Action; the callers perform the persisted transitions and build their own error payloads.
 *
 * Safety rules encoded here:
 * - A terminal Action is never reopened.
 * - A CREATED Attempt never reached the adapter (the runtime dispatches and starts an Attempt before it
 *   invokes the adapter), so it is cancelled. Only IDEMPOTENT work is retried; NON_IDEMPOTENT work is
 *   failed closed and any further attempt must come from a new proposal.
 * - A DISPATCHED, RUNNING or UNKNOWN Attempt may have reached the adapter. Nothing is inferred about
 *   whether a side effect occurred. NON_IDEMPOTENT work is never retried. IDEMPOTENT work is retried only
 *   with supervisor evidence: a fenced supervisor lease and any required tenant quiescence. Lease expiry
 *   alone is not such evidence.
 * - A terminal Attempt under an open Action (the worker stopped before updating the Action) is reconciled
 *   to the Attempt's outcome. A SUCCEEDED Attempt is never replayed.
 *
 * Delivery stays at-least-once; this policy makes no exactly-once claim.
 */

import { type ActionStatus, isTerminalActionStatus } from "../domain/action.js";
import type { AttemptStatus } from "../domain/attempt.js";

export type RecoveryIdempotency = "IDEMPOTENT" | "NON_IDEMPOTENT";

export interface RecoveryEvidence {
  /** The caller holds an unexpired, fenced supervisor lease for the run. */
  readonly supervisorFenced: boolean;
  /** Any required tenant quiescence is proven (or the run's isolation does not require it). */
  readonly quiescenceSatisfied: boolean;
}

/** Evidence available to the stale-execution sweeper: none beyond the durable state. */
export const SWEEPER_EVIDENCE: RecoveryEvidence = Object.freeze({
  supervisorFenced: false,
  quiescenceSatisfied: false,
});

/** Evidence available inside recoverMission, which has validated supervisor fencing and quiescence. */
export const SUPERVISOR_EVIDENCE: RecoveryEvidence = Object.freeze({
  supervisorFenced: true,
  quiescenceSatisfied: true,
});

export interface RecoveryDecisionInput {
  readonly idempotency: RecoveryIdempotency;
  readonly actionStatus: ActionStatus;
  /** The Attempt recovery is reconciling: the in-flight one, else the latest. Null when none exists. */
  readonly attemptStatus: AttemptStatus | null;
  readonly totalAttempts: number;
  readonly maxAttempts: number;
  readonly evidence: RecoveryEvidence;
}

export type RecoveryAttemptTransition = "NONE" | "CANCEL" | "MARK_UNKNOWN";

export type RecoveryActionTransition =
  | "NONE"
  | "SUCCEED"
  | "FAIL"
  | "TIMEOUT"
  | "CANCEL"
  | "PREPARE_RETRY";

/** Why an Action is failed, so callers can attach an honest error payload. */
export type RecoveryFailureKind = "NOT_DISPATCHED" | "UNCERTAIN" | "FROM_ATTEMPT";

export interface RecoveryDecision {
  readonly attemptTransition: RecoveryAttemptTransition;
  readonly actionTransition: RecoveryActionTransition;
  readonly failureKind?: RecoveryFailureKind;
  /** True when a replacement Attempt may be created for this Action (the Action is, or becomes, RETRYING). */
  readonly retry: boolean;
  /** True when execution may have reached the adapter, so a physical side effect cannot be ruled out. */
  readonly mayHaveReachedAdapter: boolean;
}

const NO_ACTION: RecoveryDecision = Object.freeze({
  attemptTransition: "NONE",
  actionTransition: "NONE",
  retry: false,
  mayHaveReachedAdapter: false,
});

export function decideRecovery(input: RecoveryDecisionInput): RecoveryDecision {
  if (isTerminalActionStatus(input.actionStatus) || input.attemptStatus === null) {
    return NO_ACTION;
  }

  const idempotent = input.idempotency === "IDEMPOTENT";
  const attemptsRemaining = input.totalAttempts < input.maxAttempts;
  const alreadyRetrying = input.actionStatus === "RETRYING";

  const retryOrFail = (
    permitted: boolean,
    attemptTransition: RecoveryAttemptTransition,
    failureKind: RecoveryFailureKind,
    mayHaveReachedAdapter: boolean
  ): RecoveryDecision =>
    permitted
      ? {
          attemptTransition,
          actionTransition: alreadyRetrying ? "NONE" : "PREPARE_RETRY",
          retry: true,
          mayHaveReachedAdapter,
        }
      : { attemptTransition, actionTransition: "FAIL", failureKind, retry: false, mayHaveReachedAdapter };

  switch (input.attemptStatus) {
    case "CREATED":
      return retryOrFail(idempotent && attemptsRemaining, "CANCEL", "NOT_DISPATCHED", false);

    case "DISPATCHED":
    case "RUNNING":
    case "UNKNOWN": {
      const attemptTransition = input.attemptStatus === "UNKNOWN" ? "NONE" : "MARK_UNKNOWN";
      const permitted =
        idempotent &&
        attemptsRemaining &&
        input.evidence.supervisorFenced &&
        input.evidence.quiescenceSatisfied;
      return retryOrFail(permitted, attemptTransition, "UNCERTAIN", true);
    }

    case "FAILED":
      return retryOrFail(idempotent && attemptsRemaining, "NONE", "FROM_ATTEMPT", false);

    case "SUCCEEDED":
      return alreadyRetrying ? NO_ACTION : { ...NO_ACTION, actionTransition: "SUCCEED" };

    case "TIMED_OUT":
      return alreadyRetrying ? NO_ACTION : { ...NO_ACTION, actionTransition: "TIMEOUT" };

    case "CANCELLED":
      return alreadyRetrying ? NO_ACTION : { ...NO_ACTION, actionTransition: "CANCEL" };

    default:
      return NO_ACTION;
  }
}
