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
import type { AnyRunEvent } from "../domain/events.js";
import type { RunSnapshot } from "../domain/invariants.js";

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
  /**
   * True when the Action recorded a started Attempt whose row was never inserted (see
   * isStartedAttemptRowMissing). That Attempt never reached the adapter and the Action's own state
   * already points at it, so an IDEMPOTENT Action is left for an explicit executeAction re-entry.
   */
  readonly startedAttemptRowMissing?: boolean;
  /**
   * True when a verification event (clean_room.verified or verification.completed with status VERIFIED)
   * was persisted for this run after this Action started, proving the action outcome was verified.
   */
  readonly verifiedEventAfterAction?: boolean;
}

/**
 * A RUNNING Action whose activeAttemptNumber is beyond the latest Attempt row recorded START_ATTEMPT
 * but stopped before inserting that Attempt. When the numbers are equal, the Attempt exists and the
 * Action simply was not updated after it finished.
 */
export function isStartedAttemptRowMissing(
  action: { readonly status: ActionStatus; readonly activeAttemptNumber: number | null },
  latestAttemptNumber: number | null
): boolean {
  return (
    action.status === "RUNNING" &&
    action.activeAttemptNumber !== null &&
    action.activeAttemptNumber > (latestAttemptNumber ?? 0)
  );
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
  if (input.startedAttemptRowMissing === true && idempotent) {
    return NO_ACTION;
  }
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
      if (input.verifiedEventAfterAction) {
        return {
          attemptTransition: "NONE",
          actionTransition: "SUCCEED",
          retry: false,
          mayHaveReachedAdapter: true,
        };
      }
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

// ============================================================================
// Scenario 12: Verified Run Recovery Decision (Milestone 2.16-E)
// ============================================================================

export interface GenericEventLike {
  readonly eventId: string;
  readonly runId: string;
  readonly timestamp: string;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly producer: string;
  readonly payload?: unknown;
}

export type AnyEventInput = AnyRunEvent | GenericEventLike;

export type VerifiedRunRecoveryDecision =
  | {
      readonly action: "COMPLETE_FROM_VERIFIED_EVENT";
      readonly verificationEvent: AnyEventInput;
      readonly resultPayload: unknown;
    }
  | {
      readonly action: "FAIL_CLOSED";
      readonly reasonCode: string;
      readonly message: string;
      readonly details?: unknown;
    }
  | {
      readonly action: "PROCEED_TO_RETRY";
    };

export interface EvaluateVerifiedRunRecoveryInput {
  readonly runSnapshot: RunSnapshot;
  readonly events: readonly AnyEventInput[];
  readonly actions?: readonly { readonly status: string; readonly actionId: string; readonly createdAt?: string }[];
  readonly attempts?: readonly { readonly status: string; readonly attemptId: string; readonly attemptNumber: number; readonly createdAt?: string }[];
}

/**
 * Pure policy evaluation for Scenario 12:
 * A run whose lease expired while RUNNING or RECOVERING had a successful verification event
 * (clean_room.verified or verification.completed with status VERIFIED) recorded in run_events
 * before the worker crashed.
 *
 * Guarantees:
 * 1. Checks that the verification event occurred after the latest action.started (or for current attempt).
 * 2. Validates run identity, attempt number, contract binding, and consistency.
 * 3. Fails closed on any mismatch or uncertainty.
 * 4. Ensures idempotent decisioning.
 */
export function decideVerifiedRunRecovery(input: EvaluateVerifiedRunRecoveryInput): VerifiedRunRecoveryDecision {
  const { runSnapshot, events } = input;

  // Only runs in RUNNING or RECOVERING are eligible for recovery
  if (runSnapshot.status !== "RUNNING" && runSnapshot.status !== "RECOVERING") {
    return { action: "PROCEED_TO_RETRY" };
  }

  // Scan events for candidate verification events
  let lastVerIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (
      (e.eventType as string) === "clean_room.verified" ||
      (e.eventType === "verification.completed" && (e.payload as any)?.status === "VERIFIED")
    ) {
      lastVerIdx = i;
      break;
    }
  }

  if (lastVerIdx === -1) {
    return { action: "PROCEED_TO_RETRY" };
  }

  const verEvent = events[lastVerIdx]!;
  const verPayload = (verEvent.payload as Record<string, unknown>) ?? {};

  // 1. Run ID verification
  if (verEvent.runId !== runSnapshot.runId || (verPayload.runId && verPayload.runId !== runSnapshot.runId)) {
    return {
      action: "FAIL_CLOSED",
      reasonCode: "VERIFICATION_RUN_MISMATCH",
      message: `Verification event runId '${verEvent.runId}' does not match run '${runSnapshot.runId}'`,
      details: { eventRunId: verEvent.runId, runId: runSnapshot.runId },
    };
  }

  // 2. Attempt identity verification
  const eventAttempt =
    typeof verPayload.attemptNumber === "number"
      ? verPayload.attemptNumber
      : typeof verPayload.attempt === "number"
        ? verPayload.attempt
        : typeof (verPayload.details as any)?.attemptNumber === "number"
          ? (verPayload.details as any).attemptNumber
          : typeof (verPayload.details as any)?.attempt === "number"
            ? (verPayload.details as any).attempt
            : undefined;

  if (eventAttempt !== undefined) {
    const matchesCurrent =
      eventAttempt === runSnapshot.attemptCount ||
      eventAttempt === runSnapshot.attemptCount + 1;

    if (!matchesCurrent) {
      // If the verification event belongs to an older attempt, it is stale and cannot verify the current attempt
      if (eventAttempt < runSnapshot.attemptCount) {
        return { action: "PROCEED_TO_RETRY" };
      }
      // If the attempt is ahead or invalid, fail closed
      return {
        action: "FAIL_CLOSED",
        reasonCode: "VERIFICATION_ATTEMPT_MISMATCH",
        message: `Verification event attempt ${eventAttempt} does not match current run attempt ${runSnapshot.attemptCount}`,
        details: { eventAttempt, runAttempt: runSnapshot.attemptCount },
      };
    }
  }

  // 3. Contract binding verification
  if (!runSnapshot.contractBinding) {
    return {
      action: "FAIL_CLOSED",
      reasonCode: "UNBOUND_RUN_EXECUTION_DISALLOWED",
      message: `Recovery of unbound run '${runSnapshot.runId}' is disallowed.`,
      details: { runId: runSnapshot.runId },
    };
  }

  const eventContractId =
    (typeof verPayload.contractId === "string" ? verPayload.contractId : undefined) ??
    (typeof (verPayload.details as any)?.contractId === "string" ? (verPayload.details as any).contractId : undefined);
  if (eventContractId && eventContractId !== runSnapshot.contractBinding.contractId) {
    return {
      action: "FAIL_CLOSED",
      reasonCode: "CONTRACT_INTEGRITY_MISMATCH",
      message: `Verification event contractId '${eventContractId}' does not match bound contract '${runSnapshot.contractBinding.contractId}'`,
      details: { eventContractId, boundContractId: runSnapshot.contractBinding.contractId },
    };
  }

  const eventContractVersion =
    (typeof verPayload.contractVersion === "number" ? verPayload.contractVersion : undefined) ??
    (typeof (verPayload.details as any)?.contractVersion === "number" ? (verPayload.details as any).contractVersion : undefined);
  if (eventContractVersion !== undefined && eventContractVersion !== runSnapshot.contractBinding.version) {
    return {
      action: "FAIL_CLOSED",
      reasonCode: "CONTRACT_INTEGRITY_MISMATCH",
      message: `Verification event contractVersion '${eventContractVersion}' does not match bound contract version '${runSnapshot.contractBinding.version}'`,
      details: { eventContractVersion, boundContractVersion: runSnapshot.contractBinding.version },
    };
  }

  // 4. Scan events occurring AFTER the verification event
  for (let i = lastVerIdx + 1; i < events.length; i++) {
    const e = events[i]!;
    if (
      e.eventType === "action.started" ||
      e.eventType === "action.created" ||
      e.eventType === "attempt.started" ||
      e.eventType === "attempt.dispatched"
    ) {
      // Work was initiated after verification: the verification is stale
      return { action: "PROCEED_TO_RETRY" };
    }
    if (
      e.eventType === "verification.rejected" ||
      (e.eventType === "verification.completed" && (e.payload as any)?.status !== "VERIFIED")
    ) {
      return {
        action: "FAIL_CLOSED",
        reasonCode: "SUBSEQUENT_VERIFICATION_REJECTED",
        message: "Run verification was subsequently rejected or failed after initial verification",
        details: { rejectedEventType: e.eventType, rejectedEventId: e.eventId },
      };
    }
    if (e.eventType === "workspace.failed") {
      return {
        action: "FAIL_CLOSED",
        reasonCode: "WORKSPACE_FAILED",
        message: "Workspace failed after verification was completed",
        details: { workspaceEventId: e.eventId },
      };
    }
  }

  // 5. Uncertain attempt guard: a verified event cannot retroactively confirm a tool action whose
  //    side effect remains uncertain. Any attempt still in UNKNOWN, RUNNING, or DISPATCHED status
  //    means execution outcome is unresolved — do not complete the run from verification evidence alone.
  if (input.attempts && input.attempts.length > 0) {
    const uncertainAttempts = input.attempts.filter(
      (a) => a.status === "UNKNOWN" || a.status === "RUNNING" || a.status === "DISPATCHED"
    );
    if (uncertainAttempts.length > 0) {
      return {
        action: "FAIL_CLOSED",
        reasonCode: "UNCERTAIN_ATTEMPT_PREVENTS_COMPLETION",
        message: `Run has ${uncertainAttempts.length} attempt(s) with uncertain execution status; verification evidence cannot safely authorise completion`,
        details: { uncertainAttemptIds: uncertainAttempts.map((a) => a.attemptId) },
      };
    }
  }

  // 6. Build authoritative completion result payload
  const resultPayload =
    (verPayload.details as any)?.result ??
    verPayload.result ??
    {
      verified: true,
      verificationEventId: verEvent.eventId,
      verifierId: verPayload.verifierId ?? "clean_room",
      specId: verPayload.specId,
      verifiedAt: verPayload.verifiedAt ?? verEvent.timestamp,
      evidenceIds: Array.isArray(verPayload.evidenceIds) ? [...verPayload.evidenceIds] : [],
      status: "VERIFIED",
      details: verPayload.details ? { ...(verPayload.details as any) } : undefined,
    };

  return {
    action: "COMPLETE_FROM_VERIFIED_EVENT",
    verificationEvent: verEvent,
    resultPayload,
  };
}
