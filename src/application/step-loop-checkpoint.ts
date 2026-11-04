/**
 * Governed Step Loop Checkpoint Manager for Emerald Agent Fabric (Milestone 2.16-B).
 *
 * Implements deterministic persistence, invariant validation, and fail-closed
 * reconciliation between durable MissionCheckpoints, SQLite Actions/Attempts,
 * PostPassVerificationLatch state, and authoritative run lifecycle events.
 *
 * Guarantees:
 * 1. Schema Versioning: Strictly typed schema version (v1); rejects unknown versions fail-closed.
 * 2. Invariant Validation: Rejects negative, corrupted, or contradictory counter states.
 * 3. Execution Reconciliation: Detects and rejects uncertain (UNKNOWN/RUNNING/DISPATCHED) attempts.
 * 4. Action Deduplication: Accurately reconciles completed durable actions, preventing double execution.
 * 5. Event Hierarchy: Durable lifecycle events supersede checkpoint state on conflict.
 * 6. Scenario 12 Preservation: Recognizes completed clean-room verification to avoid duplicate repair loops.
 * 7. Fail-Closed Recovery: Refuses to resume on any inconsistency, missing records, or revoked contract.
 */

import { ClockPort } from "../ports/clock.port.js";
import {
  MissionCheckpoint,
  PersistedEvent,
  StateStorePort,
} from "../ports/state-store.port.js";
import { RunSnapshot } from "../domain/invariants.js";
import { MissionContract } from "../domain/mission-contract.js";
import { ActionSnapshot } from "../domain/action.js";
import { AttemptSnapshot } from "../domain/attempt.js";
import { RunCoordinator } from "./run-coordinator.js";
import {
  PostPassLatchSnapshot,
  PostPassVerificationLatch,
} from "./post-pass-verification-latch.js";
import { decideVerifiedRunRecovery } from "./recovery-decision-policy.js";

// ============================================================================
// 1. Schema & Constants
// ============================================================================

export const STEP_LOOP_CHECKPOINT_SCHEMA_VERSION = 1;

export interface StepLoopDurableState {
  readonly schemaVersion: number;
  readonly runId: string;
  readonly stepCount: number;
  readonly actionCount: number;
  readonly consecutiveFailures: number;
  readonly proposalRejections: number;
  readonly consecutiveIdenticalReads: number;
  readonly consecutiveIdenticalWrites: number;
  readonly consecutiveIneffectiveEdits: number;
  readonly postPassLatchSnapshot?: PostPassLatchSnapshot;
  readonly lastActionId?: string | null;
  readonly lastAttemptNumber?: number | null;
  readonly lastSequenceNumber?: number;
}

// ============================================================================
// 2. Error Taxonomy
// ============================================================================

export class CheckpointSchemaValidationError extends Error {
  constructor(message: string, readonly details?: unknown) {
    super(`Checkpoint schema validation failed: ${message}`);
    this.name = "CheckpointSchemaValidationError";
  }
}

export class CheckpointReconciliationError extends Error {
  constructor(message: string, readonly details?: unknown) {
    super(`Checkpoint reconciliation failed: ${message}`);
    this.name = "CheckpointReconciliationError";
  }
}

export class UncertainAttemptReconciliationError extends CheckpointReconciliationError {
  constructor(
    readonly actionId: string,
    readonly attemptId: string,
    readonly status: string
  ) {
    super(
      `Cannot resume checkpoint with uncertain attempt: action '${actionId}', attempt '${attemptId}' in status '${status}'`
    );
    this.name = "UncertainAttemptReconciliationError";
  }
}

// ============================================================================
// 3. Validation Logic
// ============================================================================

/**
 * Validates the raw durableState object of a MissionCheckpoint against schema v1.
 * Fails closed on any type error, range error, or internal inconsistency.
 */
export function validateStepLoopDurableState(
  rawState: unknown,
  expectedRunId: string
): StepLoopDurableState {
  if (!rawState || typeof rawState !== "object") {
    throw new CheckpointSchemaValidationError("durableState must be a non-null object");
  }

  const state = rawState as Record<string, unknown>;

  // Schema version validation
  if (typeof state.schemaVersion !== "number" || state.schemaVersion !== STEP_LOOP_CHECKPOINT_SCHEMA_VERSION) {
    throw new CheckpointSchemaValidationError(
      `Unsupported or missing schemaVersion: expected ${STEP_LOOP_CHECKPOINT_SCHEMA_VERSION}, received ${state.schemaVersion}`
    );
  }

  // Run ID scoping
  if (typeof state.runId !== "string" || state.runId !== expectedRunId) {
    throw new CheckpointSchemaValidationError(
      `runId mismatch in durableState: expected '${expectedRunId}', received '${state.runId}'`
    );
  }

  // Integer range checks
  const checkNonNegativeInteger = (fieldName: string, value: unknown): number => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new CheckpointSchemaValidationError(
        `Field '${fieldName}' must be a non-negative integer, received ${value}`
      );
    }
    return value;
  };

  const stepCount = checkNonNegativeInteger("stepCount", state.stepCount);
  const actionCount = checkNonNegativeInteger("actionCount", state.actionCount);
  const consecutiveFailures = checkNonNegativeInteger("consecutiveFailures", state.consecutiveFailures);
  const proposalRejections = checkNonNegativeInteger("proposalRejections", state.proposalRejections);
  const consecutiveIdenticalReads = checkNonNegativeInteger("consecutiveIdenticalReads", state.consecutiveIdenticalReads);
  const consecutiveIdenticalWrites = checkNonNegativeInteger("consecutiveIdenticalWrites", state.consecutiveIdenticalWrites);
  const consecutiveIneffectiveEdits = checkNonNegativeInteger("consecutiveIneffectiveEdits", state.consecutiveIneffectiveEdits);

  // Cross-counter invariant checks
  if (actionCount > stepCount) {
    throw new CheckpointSchemaValidationError(
      `actionCount (${actionCount}) cannot exceed stepCount (${stepCount})`
    );
  }
  if (consecutiveFailures > actionCount) {
    throw new CheckpointSchemaValidationError(
      `consecutiveFailures (${consecutiveFailures}) cannot exceed actionCount (${actionCount})`
    );
  }
  if (proposalRejections > stepCount) {
    throw new CheckpointSchemaValidationError(
      `proposalRejections (${proposalRejections}) cannot exceed stepCount (${stepCount})`
    );
  }

  // Verification latch snapshot validation (if present)
  let postPassLatchSnapshot: PostPassLatchSnapshot | undefined;
  if (state.postPassLatchSnapshot !== undefined && state.postPassLatchSnapshot !== null) {
    if (typeof state.postPassLatchSnapshot !== "object") {
      throw new CheckpointSchemaValidationError("postPassLatchSnapshot must be an object");
    }
    try {
      // Validate via restoreFromSnapshot fail-closed validation
      const latch = new PostPassVerificationLatch();
      latch.restoreFromSnapshot(state.postPassLatchSnapshot as PostPassLatchSnapshot);
      postPassLatchSnapshot = state.postPassLatchSnapshot as PostPassLatchSnapshot;
    } catch (err: unknown) {
      throw new CheckpointSchemaValidationError(
        `Invalid postPassLatchSnapshot in durableState: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const lastActionId =
    typeof state.lastActionId === "string" ? state.lastActionId : state.lastActionId === null ? null : undefined;
  const lastAttemptNumber =
    typeof state.lastAttemptNumber === "number" ? state.lastAttemptNumber : state.lastAttemptNumber === null ? null : undefined;
  const lastSequenceNumber =
    typeof state.lastSequenceNumber === "number" ? state.lastSequenceNumber : undefined;

  return Object.freeze({
    schemaVersion: STEP_LOOP_CHECKPOINT_SCHEMA_VERSION,
    runId: expectedRunId,
    stepCount,
    actionCount,
    consecutiveFailures,
    proposalRejections,
    consecutiveIdenticalReads,
    consecutiveIdenticalWrites,
    consecutiveIneffectiveEdits,
    ...(postPassLatchSnapshot ? { postPassLatchSnapshot } : {}),
    lastActionId,
    lastAttemptNumber,
    lastSequenceNumber,
  });
}

// ============================================================================
// 4. Save Checkpoint Integration
// ============================================================================

export interface SaveStepLoopCheckpointParams {
  readonly coordinator: RunCoordinator;
  readonly stateStore: StateStorePort;
  readonly clock: ClockPort;
  readonly runId: string;
  readonly stepCount: number;
  readonly actionCount: number;
  readonly consecutiveFailures: number;
  readonly proposalRejections: number;
  readonly consecutiveIdenticalReads: number;
  readonly consecutiveIdenticalWrites: number;
  readonly consecutiveIneffectiveEdits: number;
  readonly postPassLatch: PostPassVerificationLatch;
  readonly lastActionId?: string | null;
  readonly lastAttemptNumber?: number | null;
  readonly currentCheckpointVersion: number;
}

/**
 * Persists a durable checkpoint at an explicitly defined safe step boundary.
 */
export function saveStepLoopCheckpoint(
  params: SaveStepLoopCheckpointParams
): MissionCheckpoint {
  const durableState: StepLoopDurableState = Object.freeze({
    schemaVersion: STEP_LOOP_CHECKPOINT_SCHEMA_VERSION,
    runId: params.runId,
    stepCount: params.stepCount,
    actionCount: params.actionCount,
    consecutiveFailures: params.consecutiveFailures,
    proposalRejections: params.proposalRejections,
    consecutiveIdenticalReads: params.consecutiveIdenticalReads,
    consecutiveIdenticalWrites: params.consecutiveIdenticalWrites,
    consecutiveIneffectiveEdits: params.consecutiveIneffectiveEdits,
    postPassLatchSnapshot: params.postPassLatch.getSnapshot(),
    lastActionId: params.lastActionId ?? null,
    lastAttemptNumber: params.lastAttemptNumber ?? null,
  });

  return params.coordinator.saveCheckpoint({
    runId: params.runId,
    checkpointVersion: params.currentCheckpointVersion,
    actionId: params.lastActionId ?? null,
    attemptNumber: params.lastAttemptNumber ?? null,
    durableState: durableState as unknown as Record<string, unknown>,
  });
}

// ============================================================================
// 5. Reconcile Checkpoint with Durable Evidence
// ============================================================================

export interface ReconcileCheckpointParams {
  readonly checkpoint: MissionCheckpoint;
  readonly runSnapshot: RunSnapshot;
  readonly contract: MissionContract;
  readonly actions: readonly ActionSnapshot[];
  readonly attempts?: readonly AttemptSnapshot[];
  readonly events: readonly PersistedEvent[];
  readonly clock: ClockPort;
}

export interface ReconciledStepLoopState {
  readonly status: "READY" | "ALREADY_VERIFIED" | "FAIL_CLOSED";
  readonly reason?: string;
  readonly durableState: StepLoopDurableState;
  readonly latestCheckpointVersion: number;
  readonly reconciledActionCount: number;
  readonly reconciledStepCount: number;
  readonly reconciledConsecutiveFailures: number;
}

/**
 * Reconciles a loaded MissionCheckpoint against authoritative SQLite action/attempt
 * records and run lifecycle events.
 *
 * Guarantees:
 * - Compares durable action identities, sequence numbers, statuses, and attempts.
 * - Refuses to resume on uncertain (UNKNOWN / RUNNING / DISPATCHED / CREATED) attempts.
 * - Reconciles actions completed after checkpoint save and adjusts stepCount and actionCount
 *   without re-executing completed work.
 * - Rejects checkpoints that conflict with authoritative events (e.g. later verification rejection
 *   or latch claiming verified without durable verification evidence).
 * - Honors Scenario 12: if durable verification exists, passes attempts to evaluate uncertain attempts,
 *   declaring ALREADY_VERIFIED only when authoritative evidence confirms completion.
 */
export function reconcileCheckpointWithDurableEvidence(
  params: ReconcileCheckpointParams
): ReconciledStepLoopState {
  const { checkpoint, runSnapshot, contract, actions, attempts = [], events } = params;

  // 1. Run identity check
  if (checkpoint.runId !== runSnapshot.runId) {
    throw new CheckpointReconciliationError(
      `Checkpoint runId '${checkpoint.runId}' does not match RunSnapshot '${runSnapshot.runId}'`
    );
  }

  // 2. Contract binding & status check
  if (!runSnapshot.contractBinding) {
    throw new CheckpointReconciliationError(
      `Run '${runSnapshot.runId}' has no bound Mission Contract`
    );
  }
  if (
    checkpoint.contractBinding.contractId !== runSnapshot.contractBinding.contractId ||
    checkpoint.contractBinding.version !== runSnapshot.contractBinding.version ||
    checkpoint.contractBinding.contentHash.toLowerCase() !== runSnapshot.contractBinding.contentHash.toLowerCase()
  ) {
    throw new CheckpointReconciliationError(
      `Checkpoint contract binding does not match RunSnapshot contract binding`
    );
  }
  if (contract.lifecycle.status !== "ACTIVE") {
    throw new CheckpointReconciliationError(
      `Bound MissionContract '${contract.spec.contractId}' v${contract.spec.version} is not ACTIVE (current status: '${contract.lifecycle.status}')`
    );
  }

  // 3. Validate durableState schema and invariants
  const validatedState = validateStepLoopDurableState(
    checkpoint.durableState,
    runSnapshot.runId
  );

  // 4. Action and Attempt Reconciliation
  // 4a. Check for uncertain and non-terminal attempts across all attempts associated with this run
  for (const attempt of attempts) {
    if (
      attempt.status === "UNKNOWN" ||
      attempt.status === "RUNNING" ||
      attempt.status === "DISPATCHED" ||
      attempt.status === "CREATED"
    ) {
      throw new UncertainAttemptReconciliationError(
        attempt.actionId,
        attempt.attemptId,
        attempt.status
      );
    }
  }

  // 4b. Verify strict sequence numbering and terminal statuses for all durable actions
  const validTerminalActionStatuses = ["SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED"];
  for (let i = 0; i < actions.length; i++) {
    const act = actions[i]!;
    if (act.sequenceNumber !== i + 1) {
      throw new CheckpointReconciliationError(
        `Durable action at index ${i} has sequenceNumber ${act.sequenceNumber}, expected ${i + 1} (sequence numbers must be strictly sequential 1..N)`
      );
    }
    if (!validTerminalActionStatuses.includes(act.status)) {
      throw new CheckpointReconciliationError(
        `Action '${act.actionId}' has un-fenced non-terminal status '${act.status}': cannot resume without process quiescence`
      );
    }
  }

  // 4c. Check action count consistency
  if (validatedState.actionCount > actions.length) {
    throw new CheckpointReconciliationError(
      `Checkpoint claims actionCount=${validatedState.actionCount}, but only ${actions.length} durable actions exist in SQLite`
    );
  }

  // 4d. Verify action identity and attempt correlation at the checkpoint boundary
  if (validatedState.actionCount > 0) {
    const checkpointLastAction = actions[validatedState.actionCount - 1]!;
    if (validatedState.lastActionId && checkpointLastAction.actionId !== validatedState.lastActionId) {
      throw new CheckpointReconciliationError(
        `Checkpoint lastActionId '${validatedState.lastActionId}' does not match durable action at sequence ${validatedState.actionCount} ('${checkpointLastAction.actionId}')`
      );
    }
    if (checkpoint.actionId && checkpointLastAction.actionId !== checkpoint.actionId) {
      throw new CheckpointReconciliationError(
        `MissionCheckpoint actionId '${checkpoint.actionId}' does not match durable action at sequence ${validatedState.actionCount} ('${checkpointLastAction.actionId}')`
      );
    }
    if (
      validatedState.lastSequenceNumber !== undefined &&
      checkpointLastAction.sequenceNumber !== validatedState.lastSequenceNumber
    ) {
      throw new CheckpointReconciliationError(
        `Checkpoint lastSequenceNumber ${validatedState.lastSequenceNumber} does not match durable action sequenceNumber ${checkpointLastAction.sequenceNumber}`
      );
    }
    if (validatedState.lastAttemptNumber !== undefined && validatedState.lastAttemptNumber !== null) {
      const hasMatchingAttempt = attempts.some(
        (att) =>
          att.actionId === checkpointLastAction.actionId &&
          att.attemptNumber === validatedState.lastAttemptNumber
      );
      if (!hasMatchingAttempt && attempts.length > 0) {
        throw new CheckpointReconciliationError(
          `Checkpoint lastAttemptNumber ${validatedState.lastAttemptNumber} for action '${checkpointLastAction.actionId}' not found in durable attempts`
        );
      }
    }
  } else {
    // actionCount is 0: checkpoint must not reference an executed action
    if (validatedState.lastActionId) {
      throw new CheckpointReconciliationError(
        `Checkpoint specifies lastActionId '${validatedState.lastActionId}' but actionCount is 0`
      );
    }
    if (checkpoint.actionId) {
      throw new CheckpointReconciliationError(
        `MissionCheckpoint specifies actionId '${checkpoint.actionId}' but actionCount is 0`
      );
    }
  }

  // 4e. Reconcile actions that completed durably beyond the checkpoint before a crash
  let reconciledActionCount = validatedState.actionCount;
  let reconciledStepCount = validatedState.stepCount;
  let reconciledConsecutiveFailures = validatedState.consecutiveFailures;

  if (actions.length > validatedState.actionCount) {
    for (let i = validatedState.actionCount; i < actions.length; i++) {
      const act = actions[i]!;
      if (act.status === "SUCCEEDED") {
        reconciledConsecutiveFailures = 0;
      } else if (act.status === "FAILED") {
        reconciledConsecutiveFailures++;
      }
    }
    reconciledActionCount = actions.length;
    // Step count must be at least actionCount to satisfy the actionCount <= stepCount invariant
    reconciledStepCount = Math.max(validatedState.stepCount, reconciledActionCount);
  }

  // 5. Event Sequence Reconciliation
  if (events.length > 0) {
    const maxEventSequence = events[events.length - 1]!.sequence;
    if (checkpoint.eventSequence > maxEventSequence) {
      throw new CheckpointReconciliationError(
        `Checkpoint eventSequence (${checkpoint.eventSequence}) exceeds highest durable event sequence (${maxEventSequence})`
      );
    }
  }

  // 6. Verification & Scenario 12 Reconciliation
  // 6a. Check authoritative event history via decideVerifiedRunRecovery policy (passing attempts for uncertain attempt fencing)
  const verifiedDecision = decideVerifiedRunRecovery({
    runSnapshot,
    events,
    attempts,
  });

  if (verifiedDecision.action === "COMPLETE_FROM_VERIFIED_EVENT") {
    return Object.freeze({
      status: "ALREADY_VERIFIED",
      reason: "Run already verified by authoritative verification evidence (Scenario 12)",
      durableState: validatedState,
      latestCheckpointVersion: checkpoint.checkpointVersion,
      reconciledActionCount,
      reconciledStepCount,
      reconciledConsecutiveFailures,
    });
  }

  if (verifiedDecision.action === "FAIL_CLOSED") {
    throw new CheckpointReconciliationError(
      `Authoritative event history indicates verification failed or was rejected: ${verifiedDecision.message ?? "FAIL_CLOSED"}`
    );
  }

  // 6b. Check if latch claims cleanRoomVerified: must have authoritative event proof and no subsequent rejection
  if (validatedState.postPassLatchSnapshot?.cleanRoomVerified) {
    const hasAuthoritativeVerifiedEvent = events.some(
      (e) =>
        e.eventType === "clean_room.verified" ||
        (e.eventType === "verification.completed" && (e.payload as any)?.status === "VERIFIED")
    );
    if (!hasAuthoritativeVerifiedEvent) {
      throw new CheckpointReconciliationError(
        "Checkpoint latch claims clean-room verified, but no authoritative verification event exists in durable event history"
      );
    }

    const hasSubsequentRejection = events.some(
      (e) =>
        e.sequence >= checkpoint.eventSequence &&
        (e.eventType === "verification.rejected" ||
          (e.eventType === "verification.completed" && (e.payload as any)?.status !== "VERIFIED"))
    );
    if (hasSubsequentRejection) {
      throw new CheckpointReconciliationError(
        "Checkpoint latch claims clean-room verified, but subsequent lifecycle events record verification rejection"
      );
    }
  }

  return Object.freeze({
    status: "READY",
    durableState: validatedState,
    latestCheckpointVersion: checkpoint.checkpointVersion,
    reconciledActionCount,
    reconciledStepCount,
    reconciledConsecutiveFailures,
  });
}
