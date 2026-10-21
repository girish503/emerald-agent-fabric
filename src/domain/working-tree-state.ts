/**
 * Phase 92: Working-Tree State and Cross-Agent Mutation Domain Model
 *
 * Encapsulates immutable working-tree state observations, mutation proposals,
 * conflict classifications, and reconciliation outcomes across concurrent agents.
 *
 * CRITICAL INVARIANTS:
 * 1. Working-tree mutations require current base state validation (no silent lost updates).
 * 2. Reconciliation success results in RECONCILED, never VERIFIED or TERMINAL_SUCCESS.
 * 3. Working-tree state is an immutable observation digest.
 * 4. Proposals based on stale base revision or tree digest must fail closed or rebase.
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";

export type WorkingTreeConflictType =
  | "FILE_CONFLICT"
  | "SYMBOL_CONFLICT"
  | "API_CONFLICT"
  | "SCHEMA_CONFLICT"
  | "DEPENDENCY_CONFLICT"
  | "TEST_CONFLICT"
  | "CONFIGURATION_CONFLICT"
  | "DELETE_MODIFY_CONFLICT"
  | "RENAME_CONFLICT"
  | "CROSS_REPO_CONFLICT"
  | "BASE_REVISION_CONFLICT"
  | "TREE_DIGEST_CONFLICT";

export type MutationProposalStatus =
  | "PROPOSED"
  | "APPLIED"
  | "REBASED"
  | "CONFLICTED"
  | "REJECTED";

export type WorkingTreeReconciliationStatus =
  | "RECONCILED"
  | "CONFLICT_DETECTED"
  | "REBASE_REQUIRED"
  | "REJECTED";

export type WorkingTreeReconciliationPolicy =
  | "FAIL_FAST"
  | "NON_OVERLAPPING_AUTO_MERGE"
  | "DEPENDENCY_AWARE_MERGE"
  | "GOVERNED_ADAPTIVE";

export interface WorkingTreeState {
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly baseRevision: string;
  readonly treeDigest: string;
  readonly fileDigests: Readonly<Record<string, string>>;
  readonly changedFiles: readonly string[];
  readonly changedSymbols: readonly string[];
  readonly actionSequence: number;
  readonly agentId: string;
  readonly stateVersion: number;
  readonly provenanceRoot: string;
  readonly createdAt: string;
}

export interface MutationProposal {
  readonly proposalId: string;
  readonly agentId: string;
  readonly goalId: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly baseRevision: string;
  readonly treeDigest: string;
  readonly affectedFileDigests: Readonly<Record<string, string>>;
  readonly affectedSymbolDigests: Readonly<Record<string, string>>;
  readonly diffContent: string;
  readonly strategyDigest: string;
  readonly goalDigest: string;
  readonly status: MutationProposalStatus;
  readonly authoritative: false;
  readonly terminalAuthority: false;
  readonly verificationAuthority: false;
  readonly createdAt: string;
}

export interface WorkingTreeConflict {
  readonly conflictType: WorkingTreeConflictType;
  readonly fileOrSymbol: string;
  readonly proposalAId: string;
  readonly proposalBId: string;
  readonly details: string;
  readonly detectedAt: string;
}

export interface WorkingTreeReconciliationResult {
  readonly reconciliationId: string;
  readonly status: WorkingTreeReconciliationStatus;
  readonly policy: WorkingTreeReconciliationPolicy;
  readonly baseRevision: string;
  readonly initialTreeDigest: string;
  readonly resultingTreeDigest?: string;
  readonly mergedProposals: readonly string[];
  readonly conflicts: readonly WorkingTreeConflict[];
  readonly rebasedProposals: readonly string[];
  readonly rejectedProposals: readonly string[];
  readonly authoritative: false;
  readonly terminalAuthority: false;
  readonly verificationAuthority: false;
  readonly reconciledAt: string;
}

export function computeTreeDigest(
  fileDigests: Readonly<Record<string, string>>,
  baseRevision: string
): string {
  const sortedKeys = Object.keys(fileDigests).sort();
  const sortedMap: Record<string, string> = {};
  for (const k of sortedKeys) {
    const val = fileDigests[k];
    if (val !== undefined) {
      sortedMap[k] = val;
    }
  }
  const payload = {
    baseRevision,
    fileDigests: sortedMap,
  };
  return sha256Hex(canonicalJsonStringify(payload));
}

export function computeMutationProposalDigest(
  proposal: Omit<MutationProposal, "status" | "authoritative" | "terminalAuthority" | "verificationAuthority">
): string {
  const payload = {
    proposalId: proposal.proposalId,
    agentId: proposal.agentId,
    goalId: proposal.goalId,
    repositoryId: proposal.repositoryId,
    workspaceId: proposal.workspaceId,
    baseRevision: proposal.baseRevision,
    treeDigest: proposal.treeDigest,
    affectedFileDigests: proposal.affectedFileDigests,
    affectedSymbolDigests: proposal.affectedSymbolDigests,
    diffContent: proposal.diffContent,
    strategyDigest: proposal.strategyDigest,
    goalDigest: proposal.goalDigest,
    createdAt: proposal.createdAt,
  };
  return sha256Hex(canonicalJsonStringify(payload));
}

export function createWorkingTreeState(params: {
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly baseRevision: string;
  readonly fileDigests: Readonly<Record<string, string>>;
  readonly changedFiles?: readonly string[];
  readonly changedSymbols?: readonly string[];
  readonly actionSequence: number;
  readonly agentId: string;
  readonly stateVersion: number;
  readonly provenanceRoot: string;
  readonly createdAt?: string;
}): WorkingTreeState {
  const treeDigest = computeTreeDigest(params.fileDigests, params.baseRevision);
  return {
    repositoryId: params.repositoryId,
    workspaceId: params.workspaceId,
    baseRevision: params.baseRevision,
    treeDigest,
    fileDigests: { ...params.fileDigests },
    changedFiles: params.changedFiles ? [...params.changedFiles] : [],
    changedSymbols: params.changedSymbols ? [...params.changedSymbols] : [],
    actionSequence: params.actionSequence,
    agentId: params.agentId,
    stateVersion: params.stateVersion,
    provenanceRoot: params.provenanceRoot,
    createdAt: params.createdAt ?? new Date().toISOString(),
  };
}

export function createMutationProposal(params: {
  readonly proposalId: string;
  readonly agentId: string;
  readonly goalId: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly baseRevision: string;
  readonly treeDigest: string;
  readonly affectedFileDigests: Readonly<Record<string, string>>;
  readonly affectedSymbolDigests?: Readonly<Record<string, string>>;
  readonly diffContent: string;
  readonly strategyDigest: string;
  readonly goalDigest: string;
  readonly createdAt?: string;
}): MutationProposal {
  return {
    proposalId: params.proposalId,
    agentId: params.agentId,
    goalId: params.goalId,
    repositoryId: params.repositoryId,
    workspaceId: params.workspaceId,
    baseRevision: params.baseRevision,
    treeDigest: params.treeDigest,
    affectedFileDigests: { ...params.affectedFileDigests },
    affectedSymbolDigests: params.affectedSymbolDigests
      ? { ...params.affectedSymbolDigests }
      : {},
    diffContent: params.diffContent,
    strategyDigest: params.strategyDigest,
    goalDigest: params.goalDigest,
    status: "PROPOSED",
    authoritative: false,
    terminalAuthority: false,
    verificationAuthority: false,
    createdAt: params.createdAt ?? new Date().toISOString(),
  };
}
