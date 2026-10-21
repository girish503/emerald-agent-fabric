/**
 * Phase 92: Working-Tree Reconciler
 *
 * Implements the cross-agent mutation protocol, lost-update prevention,
 * and 4 reconciliation policies (A–D).
 *
 * CRITICAL INVARIANTS:
 * 1. LostUpdateRate = 0 (silent overwriting of concurrent mutations is strictly prevented).
 * 2. Reconciliation result is RECONCILED, never VERIFIED or TERMINAL_SUCCESS (M14, M15).
 * 3. Base revision and tree digest fencing must validate current state before applying mutations.
 */

import {
  MutationProposal,
  WorkingTreeConflict,
  WorkingTreeReconciliationPolicy,
  WorkingTreeReconciliationResult,
  WorkingTreeState,
  computeTreeDigest,
} from "../domain/working-tree-state.js";
import { sha256Hex } from "../domain/canonical-hash.js";

export interface ReconcileProposalsParams {
  readonly currentState: WorkingTreeState;
  readonly proposals: readonly MutationProposal[];
  readonly policy: WorkingTreeReconciliationPolicy;
  readonly dependencyGraphEdges?: ReadonlyArray<{ readonly from: string; readonly to: string }>;
}

export class WorkingTreeReconciler {
  /**
   * Evaluates and reconciles concurrent mutation proposals against the current working tree state.
   */
  public static reconcileProposals(
    params: ReconcileProposalsParams
  ): WorkingTreeReconciliationResult {
    const { currentState, proposals, policy, dependencyGraphEdges = [] } = params;
    const reconciliationId = `wtr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();

    if (proposals.length === 0) {
      return {
        reconciliationId,
        status: "REJECTED",
        policy,
        baseRevision: currentState.baseRevision,
        initialTreeDigest: currentState.treeDigest,
        mergedProposals: Object.freeze([]),
        conflicts: Object.freeze([]),
        rebasedProposals: Object.freeze([]),
        rejectedProposals: Object.freeze([]),
        authoritative: false,
        terminalAuthority: false,
        verificationAuthority: false,
        reconciledAt: now,
      };
    }

    const conflicts: WorkingTreeConflict[] = [];
    const mergedProposals: string[] = [];
    const rebasedProposals: string[] = [];
    const rejectedProposals: string[] = [];

    // Track working file digests
    const workingFileDigests = { ...currentState.fileDigests };
    const changedFilesSet = new Set<string>(currentState.changedFiles);
    const changedSymbolsSet = new Set<string>(currentState.changedSymbols);

    // Track file modifications across proposals in this batch
    const fileToProposalMap = new Map<string, string>();
    const symbolToProposalMap = new Map<string, string>();

    for (const proposal of proposals) {
      // 1. Base Revision and Tree Digest Fencing
      const isBaseRevisionCurrent = proposal.baseRevision === currentState.baseRevision;
      const isTreeDigestCurrent = proposal.treeDigest === currentState.treeDigest;

      if (!isBaseRevisionCurrent || !isTreeDigestCurrent) {
        // Proposal is based on stale state!
        // In FAIL_FAST, reject immediately.
        if (policy === "FAIL_FAST") {
          conflicts.push({
            conflictType: !isBaseRevisionCurrent
              ? "BASE_REVISION_CONFLICT"
              : "TREE_DIGEST_CONFLICT",
            fileOrSymbol: Object.keys(proposal.affectedFileDigests).join(", "),
            proposalAId: proposal.proposalId,
            proposalBId: "CURRENT_WORKING_TREE",
            details: `Proposal stale: baseRev=${proposal.baseRevision} (current=${currentState.baseRevision}), treeDigest=${proposal.treeDigest} (current=${currentState.treeDigest})`,
            detectedAt: now,
          });
          rejectedProposals.push(proposal.proposalId);
          continue;
        }

        // Under other policies, check if rebase is possible
        // Rebase is possible only if the files affected by proposal do not overlap with changes in current state
        const proposalFiles = Object.keys(proposal.affectedFileDigests);
        const hasOverlapWithWorkingChanges = proposalFiles.some((f) =>
          changedFilesSet.has(f)
        );

        if (hasOverlapWithWorkingChanges) {
          conflicts.push({
            conflictType: "FILE_CONFLICT",
            fileOrSymbol: proposalFiles.filter((f) => changedFilesSet.has(f)).join(", "),
            proposalAId: proposal.proposalId,
            proposalBId: "CURRENT_WORKING_TREE",
            details: "Stale proposal modifies files that were already modified in current revision",
            detectedAt: now,
          });
          rejectedProposals.push(proposal.proposalId);
          continue;
        } else {
          // Rebase is permitted: non-overlapping files
          rebasedProposals.push(proposal.proposalId);
        }
      }

      // 2. Intra-batch Overlap Conflict Detection
      const proposalFiles = Object.keys(proposal.affectedFileDigests);
      let batchConflict = false;

      for (const file of proposalFiles) {
        const priorProposalId = fileToProposalMap.get(file);
        if (priorProposalId && priorProposalId !== proposal.proposalId) {
          conflicts.push({
            conflictType: "FILE_CONFLICT",
            fileOrSymbol: file,
            proposalAId: priorProposalId,
            proposalBId: proposal.proposalId,
            details: `Concurrent proposals both modify file ${file}`,
            detectedAt: now,
          });
          batchConflict = true;
        }
      }

      // Symbol overlap check
      const proposalSymbols = Object.keys(proposal.affectedSymbolDigests);
      for (const symbol of proposalSymbols) {
        const priorProposalId = symbolToProposalMap.get(symbol);
        if (priorProposalId && priorProposalId !== proposal.proposalId) {
          conflicts.push({
            conflictType: "SYMBOL_CONFLICT",
            fileOrSymbol: symbol,
            proposalAId: priorProposalId,
            proposalBId: proposal.proposalId,
            details: `Concurrent proposals both modify symbol ${symbol}`,
            detectedAt: now,
          });
          batchConflict = true;
        }
      }

      // Dependency-aware check for POLICY C & D
      if (policy === "DEPENDENCY_AWARE_MERGE" || policy === "GOVERNED_ADAPTIVE") {
        for (const file of proposalFiles) {
          for (const edge of dependencyGraphEdges) {
            if (
              (edge.from === file && changedFilesSet.has(edge.to)) ||
              (edge.to === file && changedFilesSet.has(edge.from))
            ) {
              conflicts.push({
                conflictType: "DEPENDENCY_CONFLICT",
                fileOrSymbol: `${edge.from} -> ${edge.to}`,
                proposalAId: proposal.proposalId,
                proposalBId: "DEPENDENCY_EDGE",
                details: `Dependency conflict between ${edge.from} and ${edge.to}`,
                detectedAt: now,
              });
              batchConflict = true;
            }
          }
        }
      }

      if (batchConflict) {
        rejectedProposals.push(proposal.proposalId);
        continue;
      }

      // Non-conflicting: record mapping and apply to working tree
      for (const file of proposalFiles) {
        fileToProposalMap.set(file, proposal.proposalId);
        changedFilesSet.add(file);
        const digest = proposal.affectedFileDigests[file];
        if (digest !== undefined) {
          workingFileDigests[file] = digest;
        }
      }
      for (const symbol of proposalSymbols) {
        symbolToProposalMap.set(symbol, proposal.proposalId);
        changedSymbolsSet.add(symbol);
      }

      mergedProposals.push(proposal.proposalId);
    }

    // Determine final status
    let status: "RECONCILED" | "CONFLICT_DETECTED" | "REBASE_REQUIRED" | "REJECTED";
    if (mergedProposals.length === proposals.length && conflicts.length === 0) {
      status = "RECONCILED";
    } else if (rebasedProposals.length > 0 && conflicts.length === 0) {
      status = "RECONCILED";
    } else if (conflicts.length > 0) {
      status = "CONFLICT_DETECTED";
    } else {
      status = "REJECTED";
    }

    // Compute resulting tree digest
    const resultingTreeDigest = computeTreeDigest(
      workingFileDigests,
      currentState.baseRevision
    );

    return {
      reconciliationId,
      status,
      policy,
      baseRevision: currentState.baseRevision,
      initialTreeDigest: currentState.treeDigest,
      resultingTreeDigest: status === "RECONCILED" ? resultingTreeDigest : undefined,
      mergedProposals: Object.freeze(mergedProposals),
      conflicts: Object.freeze(conflicts),
      rebasedProposals: Object.freeze(rebasedProposals),
      rejectedProposals: Object.freeze(rejectedProposals),
      authoritative: false,
      terminalAuthority: false,
      verificationAuthority: false,
      reconciledAt: now,
    };
  }

  /**
   * Applies a reconciled mutation batch to produce a new WorkingTreeState.
   * Does NOT mark the state as VERIFIED or terminal.
   */
  public static applyReconciliation(
    currentState: WorkingTreeState,
    reconciliation: WorkingTreeReconciliationResult,
    proposals: readonly MutationProposal[],
    newRevision = `rev-${currentState.stateVersion + 1}`
  ): WorkingTreeState {
    if (reconciliation.status !== "RECONCILED" || !reconciliation.resultingTreeDigest) {
      throw new Error(`Cannot apply non-reconciled result with status ${reconciliation.status}`);
    }

    const mergedSet = new Set(reconciliation.mergedProposals);
    const updatedFileDigests = { ...currentState.fileDigests };
    const changedFiles = new Set(currentState.changedFiles);
    const changedSymbols = new Set(currentState.changedSymbols);

    for (const proposal of proposals) {
      if (mergedSet.has(proposal.proposalId)) {
        for (const [file, digest] of Object.entries(proposal.affectedFileDigests)) {
          updatedFileDigests[file] = digest;
          changedFiles.add(file);
        }
        for (const symbol of Object.keys(proposal.affectedSymbolDigests)) {
          changedSymbols.add(symbol);
        }
      }
    }

    const newTreeDigest = computeTreeDigest(updatedFileDigests, newRevision);

    return {
      repositoryId: currentState.repositoryId,
      workspaceId: currentState.workspaceId,
      baseRevision: newRevision,
      treeDigest: newTreeDigest,
      fileDigests: Object.freeze(updatedFileDigests),
      changedFiles: Object.freeze(Array.from(changedFiles).sort()),
      changedSymbols: Object.freeze(Array.from(changedSymbols).sort()),
      actionSequence: currentState.actionSequence + proposals.length,
      agentId: "WORKING_TREE_RECONCILER",
      stateVersion: currentState.stateVersion + 1,
      provenanceRoot: sha256Hex(
        `${currentState.provenanceRoot}:${reconciliation.reconciliationId}:${newTreeDigest}`
      ),
      createdAt: new Date().toISOString(),
    };
  }
}
