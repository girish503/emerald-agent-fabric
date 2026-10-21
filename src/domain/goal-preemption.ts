/**
 * Phase 96: Governed Hierarchical Goal Pre-emption Domain Model
 *
 * Implements pre-emption request entities, durable checkpoint structures,
 * resource pressure bands, suspension states, and checkpoint integrity validation.
 *
 * ABSOLUTE PRINCIPLES:
 * Work priority may change. Goal authority must not.
 * Preemption != Revocation. Suspension != Cancellation.
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";
import { GoalPriorityClass } from "./goal-priority.js";

/**
 * Pre-emption lifecycle states.
 */
export type PreemptionStatus =
  | "REQUESTED"
  | "VALIDATING"
  | "APPROVED"
  | "EXECUTING"
  | "CHECKPOINTED"
  | "SUSPENDED"
  | "RESUMABLE"
  | "REJECTED"
  | "CANCELLED"
  | "EXPIRED"
  | "QUARANTINED";

/**
 * Deterministic resource pressure bands.
 * Explicit intervals prevent floating-point scheduling instability.
 */
export type ResourcePressureBand =
  | "NORMAL"     // 0 - 50%
  | "ELEVATED"   // >50 - 70%
  | "HIGH"       // >70 - 85%
  | "CRITICAL"   // >85 - 95%
  | "EXHAUSTED"; // >95%

export function computeResourcePressureBand(pressurePercent: number): ResourcePressureBand {
  if (pressurePercent > 95) return "EXHAUSTED";
  if (pressurePercent > 85) return "CRITICAL";
  if (pressurePercent > 70) return "HIGH";
  if (pressurePercent > 50) return "ELEVATED";
  return "NORMAL";
}

/**
 * Pre-emption Request Entity.
 * Represents a governed proposal to temporarily interrupt or de-prioritize a goal.
 * A pre-emption request NEVER confers authority.
 */
export interface PreemptionRequest {
  readonly preemptionId: string;
  readonly goalId: string;
  readonly taskId: string;
  readonly workflowId: string;
  readonly currentPriority: GoalPriorityClass;
  readonly requestedPriority: GoalPriorityClass;
  readonly reason: string;
  readonly resourcePressure: number; // 0 - 100
  readonly pressureBand: ResourcePressureBand;
  readonly dependencyImpact: string;
  readonly checkpointId?: string;
  readonly branchId?: string;
  readonly actionId?: string;
  readonly attemptId?: string;
  readonly agentId: string;
  readonly workerId: string;
  readonly leaseId: string;
  readonly missionContractId: string;
  readonly missionContractHash: string;
  readonly provenanceRoot: string;
  readonly sequenceNumber: number;
  readonly status: PreemptionStatus;
  readonly timestamp: string;
  readonly authoritative: false;
  readonly terminalAuthority: false;
}

/**
 * Pre-emption Checkpoint Entity.
 * Captures complete durable state required to resume pre-empted work safely.
 * Invariant P15: Checkpoint provenance cannot be removed or forged.
 */
export interface PreemptionCheckpoint {
  readonly checkpointId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly goalId: string;
  readonly actionId: string;
  readonly attemptId: string;
  readonly agentId: string;
  readonly workerId: string;
  readonly leaseId: string;
  readonly missionContractId: string;
  readonly missionContractHash: string;
  readonly workingTreeDigest: string;
  readonly baseRevision: string;
  readonly affectedFiles: readonly string[];
  readonly speculativeBranchId?: string;
  readonly memoryReferences: readonly string[];
  readonly contextDigest: string;
  readonly resourceAccounting: Readonly<Record<string, number>>;
  readonly verificationState: string;
  readonly roleAssignment?: string;
  readonly priorityVersion: number;
  readonly provenanceRoot: string;
  readonly status: "ACTIVE" | "RESUMED" | "SUPERSEDED" | "QUARANTINED";
  readonly createdAt: string;
}

/**
 * Computes deterministic SHA-256 hash of a PreemptionRequest.
 */
export function computePreemptionRequestHash(
  request: Omit<PreemptionRequest, "authoritative" | "terminalAuthority">
): string {
  const payload = {
    preemptionId: request.preemptionId,
    goalId: request.goalId,
    taskId: request.taskId,
    workflowId: request.workflowId,
    currentPriority: request.currentPriority,
    requestedPriority: request.requestedPriority,
    reason: request.reason,
    resourcePressure: request.resourcePressure,
    pressureBand: request.pressureBand,
    dependencyImpact: request.dependencyImpact,
    checkpointId: request.checkpointId ?? null,
    branchId: request.branchId ?? null,
    actionId: request.actionId ?? null,
    attemptId: request.attemptId ?? null,
    agentId: request.agentId,
    workerId: request.workerId,
    leaseId: request.leaseId,
    missionContractId: request.missionContractId,
    missionContractHash: request.missionContractHash,
    provenanceRoot: request.provenanceRoot,
    sequenceNumber: request.sequenceNumber,
    status: request.status,
    timestamp: request.timestamp,
  };
  return sha256Hex(canonicalJsonStringify(payload));
}

/**
 * Computes deterministic SHA-256 hash of a PreemptionCheckpoint.
 */
export function computePreemptionCheckpointHash(
  checkpoint: PreemptionCheckpoint
): string {
  const payload = {
    checkpointId: checkpoint.checkpointId,
    runId: checkpoint.runId,
    taskId: checkpoint.taskId,
    goalId: checkpoint.goalId,
    actionId: checkpoint.actionId,
    attemptId: checkpoint.attemptId,
    agentId: checkpoint.agentId,
    workerId: checkpoint.workerId,
    leaseId: checkpoint.leaseId,
    missionContractId: checkpoint.missionContractId,
    missionContractHash: checkpoint.missionContractHash,
    workingTreeDigest: checkpoint.workingTreeDigest,
    baseRevision: checkpoint.baseRevision,
    affectedFiles: checkpoint.affectedFiles,
    speculativeBranchId: checkpoint.speculativeBranchId ?? null,
    memoryReferences: checkpoint.memoryReferences,
    contextDigest: checkpoint.contextDigest,
    resourceAccounting: checkpoint.resourceAccounting,
    verificationState: checkpoint.verificationState,
    roleAssignment: checkpoint.roleAssignment ?? null,
    priorityVersion: checkpoint.priorityVersion,
    provenanceRoot: checkpoint.provenanceRoot,
    status: checkpoint.status,
    createdAt: checkpoint.createdAt,
  };
  return sha256Hex(canonicalJsonStringify(payload));
}

/**
 * Validates PreemptionCheckpoint entity constraints and complete provenance.
 */
export function validatePreemptionCheckpoint(checkpoint: PreemptionCheckpoint): {
  readonly valid: boolean;
  readonly errors: readonly string[];
} {
  const errors: string[] = [];

  if (!checkpoint.checkpointId || checkpoint.checkpointId.trim() === "") {
    errors.push("Missing checkpointId");
  }
  if (!checkpoint.goalId || checkpoint.goalId.trim() === "") {
    errors.push("Missing goalId");
  }
  if (!checkpoint.actionId || checkpoint.actionId.trim() === "") {
    errors.push("Missing actionId (Invariant P12)");
  }
  if (!checkpoint.attemptId || checkpoint.attemptId.trim() === "") {
    errors.push("Missing attemptId (Invariant P13)");
  }
  if (!checkpoint.missionContractId || !checkpoint.missionContractHash) {
    errors.push("Missing mission contract binding (Invariant P2)");
  }
  if (!checkpoint.workingTreeDigest || checkpoint.workingTreeDigest.trim() === "") {
    errors.push("Missing workingTreeDigest");
  }
  if (!checkpoint.provenanceRoot || checkpoint.provenanceRoot.trim() === "") {
    errors.push("Missing provenanceRoot (Invariant P15)");
  }
  if (checkpoint.priorityVersion < 1) {
    errors.push("priorityVersion must be >= 1 (Invariant P10)");
  }

  return {
    valid: errors.length === 0,
    errors: Object.freeze(errors),
  };
}
