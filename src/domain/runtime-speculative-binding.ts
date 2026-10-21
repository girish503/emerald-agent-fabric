/**
 * Phase 94: Governed Speculative Execution Runtime Integration Domain Model
 *
 * Implements Action/Attempt binding, subordinate runtime speculative states,
 * promotion outcomes, runtime authority invariants R1-R20, runtime race definitions,
 * and security control metadata N541-N570.
 *
 * ABSOLUTE PRINCIPLE:
 * Speculation may expand the search space. It must never expand authority.
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";

/**
 * Explicit binding between a speculative branch and an authoritative Action/Attempt record.
 * Required binding coordinates per Phase 94 Specification (Section 7).
 */
export interface RuntimeSpeculativeBinding {
  readonly runId: string;
  readonly taskId: string;
  readonly actionId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly workerId: string;
  readonly leaseId: string;
  readonly missionContractId: string;
  readonly missionContractHash: string;
  readonly goalId: string;
  readonly branchId: string;
  readonly branchVersion: number;
  readonly baseRevision: string;
  readonly baseTreeDigest: string;
}

/**
 * Subordinate runtime speculative states.
 * These states decorate the authoritative Action/Attempt/Run lifecycle
 * and MUST NEVER supersede ActionStatus, AttemptStatus, RunStatus, or LeaseStatus.
 */
export type RuntimeSpeculativeSubordinateState =
  | "NONE"
  | "PROPOSED"
  | "ACTIVE"
  | "AWAITING_VERIFICATION"
  | "PROMOTABLE"
  | "INVALIDATED"
  | "ROLLING_BACK"
  | "ROLLED_BACK";

/**
 * Status outcome of a promotion attempt at the SpeculativePromotionGate.
 */
export type PromotionOutcomeStatus = "PROMOTED" | "PROMOTION_REJECTED";

/**
 * Explicit rejection reasons for speculative branch promotion.
 * Maps directly to the 16 atomic promotion checks.
 */
export type PromotionRejectionReason =
  | "BRANCH_NOT_FOUND"
  | "INVALID_BRANCH_STATUS"
  | "BRANCH_EXPIRED"
  | "BRANCH_REVOKED"
  | "INVALID_WORKER_LEASE"
  | "INVALID_MISSION_CONTRACT"
  | "INVALID_GOAL"
  | "RESOURCE_ALLOCATION_EXCEEDED"
  | "AUTHORITATIVE_TREE_INCOMPATIBLE"
  | "BASE_REVISION_INCOMPATIBLE"
  | "TREE_DIGEST_MISMATCH"
  | "STALE_VERIFICATION_RESULT"
  | "VERIFICATION_BRANCH_MISMATCH"
  | "VERIFICATION_TREE_MISMATCH"
  | "SOVEREIGN_VERIFICATION_FAILED"
  | "GATEWAY_POLICY_DENIED"
  | "RUNTIME_RACE_DETECTED"
  | "RUN_TERMINATED_OR_CANCELLED"
  | "ATOMIC_PERSISTENCE_FAILED"
  | "DUPLICATE_PROMOTION_DETECTED";

/**
 * Classification of asynchronous runtime race conditions.
 * Includes Phase 93 Races A-G and Phase 94 Runtime Races H-L.
 */
export type RuntimeRaceType =
  | "RACE_A_SIMULTANEOUS_SPECULATIVE_MUTATION"
  | "RACE_B_LATE_VERIFICATION_AFTER_CANCELLATION"
  | "RACE_C_CASCADE_INVALIDATION_DURING_EXECUTION"
  | "RACE_D_DYNAMIC_CONTEXT_MODIFICATION"
  | "RACE_E_RESOURCE_STARVATION_DURING_SPECULATION"
  | "RACE_F_SOVEREIGN_VERIFICATION_AFTER_PARENT_ROLLBACK"
  | "RACE_G_WORKING_TREE_RECONCILIATION_COLLISION"
  | "RACE_H_LEASE_CHANGE_BEFORE_DISPATCH"
  | "RACE_I_TREE_MUTATION_BEFORE_PROMOTION"
  | "RACE_J_CANCELLATION_WHILE_VERIFICATION_PENDING"
  | "RACE_K_RUN_TERMINATION_WHILE_BRANCH_PENDING"
  | "RACE_L_WORKER_CRASH_BEFORE_PROMOTION";

/**
 * Runtime Authority Invariant definitions (R1-R20).
 */
export const RUNTIME_AUTHORITY_INVARIANTS = Object.freeze({
  R1: "Runtime speculation cannot grant authority",
  R2: "AgentStepController cannot bypass speculative policy",
  R3: "WorkerRuntime cannot bypass existing gateway policy",
  R4: "Speculation cannot bypass Action/Attempt identity",
  R5: "Speculation cannot bypass lease fencing",
  R6: "Speculation cannot bypass mission-contract fencing",
  R7: "Speculation cannot bypass resource accounting",
  R8: "Speculation cannot bypass workspace boundaries",
  R9: "Speculation cannot bypass repository boundaries",
  R10: "Speculative state cannot directly become authoritative state",
  R11: "Promotion requires sovereign verification",
  R12: "Promotion requires current authoritative-tree validation",
  R13: "Stale verification cannot promote",
  R14: "Lease loss prevents promotion",
  R15: "Contract revocation prevents promotion",
  R16: "Cancellation prevents later silent promotion",
  R17: "Run termination prevents later silent promotion",
  R18: "Promotion is idempotent",
  R19: "Rollback evidence cannot be deleted",
  R20: "Runtime speculation cannot issue terminal authority",
} as const);

export type RuntimeAuthorityInvariantKey = keyof typeof RUNTIME_AUTHORITY_INVARIANTS;

/**
 * Negative Security Controls N541-N570 definitions.
 */
export const SECURITY_CONTROLS_PHASE94 = Object.freeze({
  N541: "runtime speculative authority injection",
  N542: "AgentStepController speculation bypass",
  N543: "WorkerRuntime speculation bypass",
  N544: "speculative ToolGateway bypass",
  N545: "speculative lease bypass",
  N546: "speculative contract bypass",
  N547: "speculative resource bypass",
  N548: "speculative workspace bypass",
  N549: "speculative repository bypass",
  N550: "speculative Action/Attempt identity substitution",
  N551: "speculative idempotency substitution",
  N552: "stale speculative promotion",
  N553: "verification-before-current-state bypass",
  N554: "promotion without sovereign verification",
  N555: "promotion after lease loss",
  N556: "promotion after contract revocation",
  N557: "promotion after cancellation",
  N558: "promotion after run termination",
  N559: "crash-recovery promotion confusion",
  N560: "partial promotion",
  N561: "duplicate promotion",
  N562: "speculative resource double-accounting",
  N563: "speculative memory authority escalation",
  N564: "speculative context authority escalation",
  N565: "rollback bypass through runtime",
  N566: "runtime rollback evidence deletion",
  N567: "runtime branch ancestry substitution",
  N568: "runtime provenance substitution",
  N569: "runtime terminal escalation",
  N570: "runtime oracle/reference leakage",
} as const);

export type Phase94SecurityControlKey = keyof typeof SECURITY_CONTROLS_PHASE94;

/**
 * Computes deterministic SHA-256 hash of an Action/Attempt speculative binding.
 */
export function computeRuntimeSpeculativeBindingHash(binding: RuntimeSpeculativeBinding): string {
  const payload = {
    runId: binding.runId,
    taskId: binding.taskId,
    actionId: binding.actionId,
    attemptId: binding.attemptId,
    attemptNumber: binding.attemptNumber,
    workerId: binding.workerId,
    leaseId: binding.leaseId,
    missionContractId: binding.missionContractId,
    missionContractHash: binding.missionContractHash,
    goalId: binding.goalId,
    branchId: binding.branchId,
    branchVersion: binding.branchVersion,
    baseRevision: binding.baseRevision,
    baseTreeDigest: binding.baseTreeDigest,
  };
  return sha256Hex(canonicalJsonStringify(payload));
}

/**
 * Validates the syntactic and referential integrity of a RuntimeSpeculativeBinding.
 */
export function validateRuntimeSpeculativeBinding(binding: RuntimeSpeculativeBinding): {
  readonly valid: boolean;
  readonly errors: readonly string[];
} {
  const errors: string[] = [];

  if (!binding.runId || typeof binding.runId !== "string" || binding.runId.trim().length === 0) {
    errors.push("Missing or invalid runId");
  }
  if (!binding.taskId || typeof binding.taskId !== "string" || binding.taskId.trim().length === 0) {
    errors.push("Missing or invalid taskId");
  }
  if (!binding.actionId || typeof binding.actionId !== "string" || binding.actionId.trim().length === 0) {
    errors.push("Missing or invalid actionId");
  }
  if (!binding.attemptId || typeof binding.attemptId !== "string" || binding.attemptId.trim().length === 0) {
    errors.push("Missing or invalid attemptId");
  }
  if (typeof binding.attemptNumber !== "number" || binding.attemptNumber < 1) {
    errors.push("Invalid attemptNumber (must be positive integer)");
  }
  if (!binding.workerId || typeof binding.workerId !== "string" || binding.workerId.trim().length === 0) {
    errors.push("Missing or invalid workerId");
  }
  if (!binding.leaseId || typeof binding.leaseId !== "string" || binding.leaseId.trim().length === 0) {
    errors.push("Missing or invalid leaseId");
  }
  if (!binding.missionContractId || typeof binding.missionContractId !== "string" || binding.missionContractId.trim().length === 0) {
    errors.push("Missing or invalid missionContractId");
  }
  if (!binding.missionContractHash || typeof binding.missionContractHash !== "string" || binding.missionContractHash.trim().length === 0) {
    errors.push("Missing or invalid missionContractHash");
  }
  if (!binding.goalId || typeof binding.goalId !== "string" || binding.goalId.trim().length === 0) {
    errors.push("Missing or invalid goalId");
  }
  if (!binding.branchId || typeof binding.branchId !== "string" || binding.branchId.trim().length === 0) {
    errors.push("Missing or invalid branchId");
  }
  if (typeof binding.branchVersion !== "number" || binding.branchVersion < 1) {
    errors.push("Invalid branchVersion (must be positive integer)");
  }
  if (!binding.baseRevision || typeof binding.baseRevision !== "string") {
    errors.push("Missing or invalid baseRevision");
  }
  if (!binding.baseTreeDigest || typeof binding.baseTreeDigest !== "string") {
    errors.push("Missing or invalid baseTreeDigest");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
