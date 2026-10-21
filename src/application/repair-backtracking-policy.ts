/**
 * Phase 88: Repair Backtracking Policy
 *
 * Governs backtracking decisions and safe search continuations.
 *
 * Invariants:
 * 1. Backtracking preserves all prior node evidence and failure logs.
 * 2. Backtracking creates an explicit BacktrackPoint and adds a provenance edge.
 * 3. Prior nodes and strategy identities are never rewritten or reused.
 * 4. Failed branch state cannot contaminate subsequent branches (snapshot isolation).
 */

import {
  StrategySearchNode,
  RepairStrategy,
  BacktrackPoint,
  StrategySearchFailureClass,
  computeBacktrackDigest,
} from "../domain/repair-strategy-search.js";

export interface BacktrackEvaluation {
  readonly shouldBacktrack: boolean;
  readonly reason?: string;
  readonly failureClass?: StrategySearchFailureClass;
  readonly targetNodeId?: string;
}

export class RepairBacktrackingPolicy {
  /**
   * Determine whether the current strategy node should trigger backtracking.
   */
  public evaluateBacktrack(
    node: StrategySearchNode,
    _strategy: RepairStrategy,
    trigger: {
      readonly failureClass?: StrategySearchFailureClass;
      readonly failureReason?: string;
      readonly deltaScreenPassed?: boolean;
      readonly budgetExceeded?: boolean;
      readonly confidenceScore?: number;
    }
  ): BacktrackEvaluation {
    if (trigger.failureClass) {
      return {
        shouldBacktrack: true,
        reason: trigger.failureReason || `Failure class: ${trigger.failureClass}`,
        failureClass: trigger.failureClass,
        targetNodeId: node.parentNodeId,
      };
    }

    if (trigger.deltaScreenPassed === false) {
      return {
        shouldBacktrack: true,
        reason: "Delta verification screening rejected candidate repair.",
        failureClass: "DELTA_SCREEN_REJECTED",
        targetNodeId: node.parentNodeId,
      };
    }

    if (trigger.budgetExceeded) {
      return {
        shouldBacktrack: true,
        reason: "Search node exceeded allocated branch resource budget.",
        failureClass: "RESOURCE_LIMIT",
        targetNodeId: node.parentNodeId,
      };
    }

    if (trigger.confidenceScore !== undefined && trigger.confidenceScore < 20) {
      return {
        shouldBacktrack: true,
        reason: `Strategy advisory score (${trigger.confidenceScore}) fell below minimum exploration threshold.`,
        failureClass: "HYPOTHESIS_CONTRADICTED",
        targetNodeId: node.parentNodeId,
      };
    }

    return { shouldBacktrack: false };
  }

  /**
   * Create an immutable BacktrackPoint to anchor search continuation.
   */
  public createBacktrackPoint(params: {
    readonly searchId: string;
    readonly node: StrategySearchNode;
    readonly strategy: RepairStrategy;
    readonly reason: string;
    readonly cleanWorkspaceSnapshotDigest: string;
    readonly provenanceRoot: string;
  }): BacktrackPoint {
    const backtrackId = `bt-${params.searchId}-${params.node.nodeId}-${Date.now()}`;
    const rawData = {
      backtrackId,
      searchId: params.searchId,
      nodeId: params.node.nodeId,
      workspaceSnapshotDigest: params.cleanWorkspaceSnapshotDigest,
      evidenceDigest: params.node.outputEvidenceDigest || params.node.inputEvidenceDigest,
      strategyDigest: params.strategy.strategyDigest,
    };
    computeBacktrackDigest(rawData);

    return {
      searchId: params.searchId,
      backtrackId,
      nodeId: params.node.nodeId,
      parentNodeId: params.node.parentNodeId,
      workspaceSnapshotDigest: params.cleanWorkspaceSnapshotDigest,
      evidenceDigest: params.node.outputEvidenceDigest || params.node.inputEvidenceDigest,
      compositionDigest: params.strategy.toolCompositionDigest,
      strategyDigest: params.strategy.strategyDigest,
      actionSequenceBoundary: params.node.cumulativeAttempts,
      resourceAccounting: {
        wallTimeMs: params.node.cumulativeCost.wallTimeMs,
        attemptsUsed: params.node.cumulativeAttempts,
        toolInvocations: params.node.cumulativeCost.toolInvocations,
      },
      provenanceRoot: params.provenanceRoot,
      reason: params.reason,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Prove branch isolation: ensure candidate continuation uses clean snapshot digest
   * without inheriting unverified mutations from a failed branch.
   */
  public verifyBranchIsolation(
    failedNodeSnapshotDigest: string,
    resumedSnapshotDigest: string,
    cleanBaselineSnapshotDigest: string
  ): boolean {
    // If the failed branch altered the workspace, the resumed branch MUST match clean baseline
    if (resumedSnapshotDigest !== cleanBaselineSnapshotDigest) {
      return false;
    }
    // Cannot inherit the tampered/mutated failed snapshot
    if (failedNodeSnapshotDigest !== cleanBaselineSnapshotDigest && resumedSnapshotDigest === failedNodeSnapshotDigest) {
      return false;
    }
    return true;
  }
}
