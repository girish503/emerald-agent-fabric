/**
 * Phase 93: Governed Cross-Agent Speculative Execution Domain Model
 *
 * Encapsulates speculative branch states, isolated working-tree snapshots,
 * asynchronous verification states, and rollback dependency graphs.
 *
 * CRITICAL INVARIANTS:
 * 1. Speculation may expand the search space. It must never expand authority.
 * 2. SPECULATIVE_SUCCESS != VERIFIED != TERMINAL_SUCCESS.
 * 3. Speculative state is strictly isolated from authoritative repository state.
 * 4. Speculative branch records have authoritative = false, terminalAuthority = false.
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";

export type SpeculativeBranchStatus =
  | "PROPOSED"
  | "AUTHORIZED_FOR_SPECULATION"
  | "MATERIALIZING"
  | "EXECUTING"
  | "AWAITING_VERIFICATION"
  | "VERIFIED"
  | "FAILED"
  | "INVALIDATED"
  | "ROLLING_BACK"
  | "ROLLED_BACK"
  | "QUARANTINED"
  | "EXPIRED"
  | "CANCELLED";

export type SpeculativeTrustClass =
  | "UNTRUSTED_SPECULATION"
  | "PROVENANCE_BOUND_SPECULATION"
  | "LOCALLY_VERIFIED_SPECULATION"
  | "SOVEREIGN_VERIFIED_RESULT";

export type SpeculativeVerificationState =
  | "NOT_SUBMITTED"
  | "PENDING"
  | "PASSED"
  | "FAILED"
  | "STALE"
  | "INVALIDATED"
  | "QUARANTINED"
  | "REJECTED";

export type SpeculativeRollbackState =
  | "NONE"
  | "PENDING"
  | "ROLLING_BACK"
  | "ROLLED_BACK"
  | "FAILED";

export type SpeculativeConflictType =
  | "SPECULATIVE_FILE_CONFLICT"
  | "SPECULATIVE_SYMBOL_CONFLICT"
  | "SPECULATIVE_API_CONFLICT"
  | "SPECULATIVE_SCHEMA_CONFLICT"
  | "SPECULATIVE_DEPENDENCY_CONFLICT"
  | "SPECULATIVE_BASE_REVISION_CONFLICT"
  | "SPECULATIVE_TREE_DIGEST_CONFLICT"
  | "SPECULATIVE_BRANCH_CONFLICT"
  | "SPECULATIVE_VERIFICATION_CONFLICT"
  | "SPECULATIVE_PROVENANCE_CONFLICT"
  | "SPECULATIVE_CONTRACT_CONFLICT"
  | "SPECULATIVE_GOAL_CONFLICT"
  | "SPECULATION_RECONCILIATION_BLOCKED";

export interface SpeculativeBranch {
  readonly branchId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly goalId: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly parentBranchId?: string;
  readonly baseRevision: string;
  readonly baseTreeDigest: string;
  readonly speculativeTreeDigest: string;
  readonly strategyDigest: string;
  readonly goalDigest: string;
  readonly missionContractId: string;
  readonly missionContractHash: string;
  readonly creationSequence: number;
  readonly stateVersion: number;
  readonly status: SpeculativeBranchStatus;
  readonly provenanceRoot: string;
  readonly verificationState: SpeculativeVerificationState;
  readonly rollbackState: SpeculativeRollbackState;
  readonly trustClass: SpeculativeTrustClass;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly authoritative: false;
  readonly terminalAuthority: false;
  readonly verificationAuthority: false;
  readonly policyAuthority: false;
  readonly affectedFiles: readonly string[];
  readonly affectedSymbols: readonly string[];
  readonly dependencyBranchIds: readonly string[];
}

export interface SpeculativeSnapshot {
  readonly branchId: string;
  readonly baseRevision: string;
  readonly baseTreeDigest: string;
  readonly speculativeTreeDigest: string;
  readonly affectedFileDigests: Readonly<Record<string, string>>;
  readonly affectedSymbolDigests: Readonly<Record<string, string>>;
  readonly strategyDigest: string;
  readonly goalDigest: string;
  readonly missionContractHash: string;
  readonly provenanceRoot: string;
  readonly createdAt: string;
}

export const VALID_SPECULATIVE_STATUS_TRANSITIONS: ReadonlyMap<
  SpeculativeBranchStatus,
  readonly SpeculativeBranchStatus[]
> = new Map([
  ["PROPOSED", ["AUTHORIZED_FOR_SPECULATION", "ROLLING_BACK", "CANCELLED", "QUARANTINED"]],
  ["AUTHORIZED_FOR_SPECULATION", ["MATERIALIZING", "EXECUTING", "ROLLING_BACK", "CANCELLED", "QUARANTINED"]],
  ["MATERIALIZING", ["EXECUTING", "FAILED", "ROLLING_BACK", "CANCELLED"]],
  ["EXECUTING", ["AWAITING_VERIFICATION", "FAILED", "ROLLING_BACK", "CANCELLED"]],
  [
    "AWAITING_VERIFICATION",
    ["VERIFIED", "FAILED", "INVALIDATED", "ROLLING_BACK", "QUARANTINED", "EXPIRED"],
  ],
  ["VERIFIED", ["INVALIDATED", "ROLLING_BACK"]], // If an upstream ancestor is subsequently invalidated
  ["FAILED", ["ROLLING_BACK", "ROLLED_BACK"]],
  ["INVALIDATED", ["ROLLING_BACK", "ROLLED_BACK"]],
  ["ROLLING_BACK", ["ROLLED_BACK", "FAILED"]],
  ["ROLLED_BACK", []],
  ["QUARANTINED", ["ROLLING_BACK", "CANCELLED"]],
  ["EXPIRED", ["ROLLING_BACK", "ROLLED_BACK"]],
  ["CANCELLED", []],
]);

export function canTransitionSpeculativeStatus(
  from: SpeculativeBranchStatus,
  to: SpeculativeBranchStatus
): boolean {
  const allowed = VALID_SPECULATIVE_STATUS_TRANSITIONS.get(from);
  return allowed !== undefined && allowed.includes(to);
}

export function computeSpeculativeBranchDigest(
  branch: Omit<
    SpeculativeBranch,
    | "status"
    | "verificationState"
    | "rollbackState"
    | "updatedAt"
    | "authoritative"
    | "terminalAuthority"
    | "verificationAuthority"
    | "policyAuthority"
  >
): string {
  const payload = {
    branchId: branch.branchId,
    runId: branch.runId,
    taskId: branch.taskId,
    agentId: branch.agentId,
    goalId: branch.goalId,
    repositoryId: branch.repositoryId,
    workspaceId: branch.workspaceId,
    parentBranchId: branch.parentBranchId,
    baseRevision: branch.baseRevision,
    baseTreeDigest: branch.baseTreeDigest,
    speculativeTreeDigest: branch.speculativeTreeDigest,
    strategyDigest: branch.strategyDigest,
    goalDigest: branch.goalDigest,
    missionContractId: branch.missionContractId,
    missionContractHash: branch.missionContractHash,
    creationSequence: branch.creationSequence,
    stateVersion: branch.stateVersion,
    provenanceRoot: branch.provenanceRoot,
    trustClass: branch.trustClass,
    createdAt: branch.createdAt,
    affectedFiles: branch.affectedFiles,
    affectedSymbols: branch.affectedSymbols,
    dependencyBranchIds: branch.dependencyBranchIds,
    authoritative: false,
    terminalAuthority: false,
    verificationAuthority: false,
    policyAuthority: false,
  };
  return sha256Hex(canonicalJsonStringify(payload));
}

export function validateSpeculativeBranchIntegrity(branch: SpeculativeBranch): {
  readonly valid: boolean;
  readonly errors: readonly string[];
} {
  const errors: string[] = [];

  if (!branch.branchId || typeof branch.branchId !== "string") {
    errors.push("Missing or invalid branchId");
  }
  if (!branch.agentId || typeof branch.agentId !== "string") {
    errors.push("Missing or invalid agentId");
  }
  if (!branch.goalId || typeof branch.goalId !== "string") {
    errors.push("Missing or invalid goalId");
  }
  if (!branch.repositoryId || typeof branch.repositoryId !== "string") {
    errors.push("Missing or invalid repositoryId");
  }
  if (!branch.workspaceId || typeof branch.workspaceId !== "string") {
    errors.push("Missing or invalid workspaceId");
  }
  if (!branch.baseRevision || typeof branch.baseRevision !== "string") {
    errors.push("Missing or invalid baseRevision");
  }
  if (!branch.baseTreeDigest || typeof branch.baseTreeDigest !== "string") {
    errors.push("Missing or invalid baseTreeDigest");
  }
  if (!branch.speculativeTreeDigest || typeof branch.speculativeTreeDigest !== "string") {
    errors.push("Missing or invalid speculativeTreeDigest");
  }
  if (!branch.provenanceRoot || typeof branch.provenanceRoot !== "string") {
    errors.push("Missing or invalid provenanceRoot");
  }
  if (!branch.missionContractHash || typeof branch.missionContractHash !== "string") {
    errors.push("Missing or invalid missionContractHash");
  }

  // Non-authority invariants
  if (branch.authoritative !== false) {
    errors.push("Invariant violation: branch cannot have authoritative = true");
  }
  if (branch.terminalAuthority !== false) {
    errors.push("Invariant violation: branch cannot have terminalAuthority = true");
  }
  if (branch.verificationAuthority !== false) {
    errors.push("Invariant violation: branch cannot have verificationAuthority = true");
  }
  if (branch.policyAuthority !== false) {
    errors.push("Invariant violation: branch cannot have policyAuthority = true");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function createSpeculativeBranch(params: {
  readonly branchId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly goalId: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly parentBranchId?: string;
  readonly baseRevision: string;
  readonly baseTreeDigest: string;
  readonly speculativeTreeDigest: string;
  readonly strategyDigest: string;
  readonly goalDigest: string;
  readonly missionContractId: string;
  readonly missionContractHash: string;
  readonly creationSequence: number;
  readonly stateVersion?: number;
  readonly status?: SpeculativeBranchStatus;
  readonly provenanceRoot: string;
  readonly verificationState?: SpeculativeVerificationState;
  readonly rollbackState?: SpeculativeRollbackState;
  readonly trustClass?: SpeculativeTrustClass;
  readonly createdAt?: string;
  readonly affectedFiles?: readonly string[];
  readonly affectedSymbols?: readonly string[];
  readonly dependencyBranchIds?: readonly string[];
}): SpeculativeBranch {
  const now = params.createdAt ?? "2026-10-21T12:00:00.000Z";
  return {
    branchId: params.branchId,
    runId: params.runId,
    taskId: params.taskId,
    agentId: params.agentId,
    goalId: params.goalId,
    repositoryId: params.repositoryId,
    workspaceId: params.workspaceId,
    parentBranchId: params.parentBranchId,
    baseRevision: params.baseRevision,
    baseTreeDigest: params.baseTreeDigest,
    speculativeTreeDigest: params.speculativeTreeDigest,
    strategyDigest: params.strategyDigest,
    goalDigest: params.goalDigest,
    missionContractId: params.missionContractId,
    missionContractHash: params.missionContractHash,
    creationSequence: params.creationSequence,
    stateVersion: params.stateVersion ?? 1,
    status: params.status ?? "PROPOSED",
    provenanceRoot: params.provenanceRoot,
    verificationState: params.verificationState ?? "NOT_SUBMITTED",
    rollbackState: params.rollbackState ?? "NONE",
    trustClass: params.trustClass ?? "UNTRUSTED_SPECULATION",
    createdAt: now,
    updatedAt: now,
    authoritative: false,
    terminalAuthority: false,
    verificationAuthority: false,
    policyAuthority: false,
    affectedFiles: params.affectedFiles ? [...params.affectedFiles] : [],
    affectedSymbols: params.affectedSymbols ? [...params.affectedSymbols] : [],
    dependencyBranchIds: params.dependencyBranchIds
      ? [...params.dependencyBranchIds]
      : [],
  };
}
