/**
 * Phase 88: Repair Strategy Search Provenance Engine
 *
 * Implements cryptographic provenance tracking across search trees, branches,
 * candidates, and backtrack events.
 *
 * Invariants:
 * 1. Every strategy node produces an immutable cryptographic digest.
 * 2. Backtracking ADDS provenance edges; it never removes historical edges.
 * 3. Final provenance root Merkle-binds all nodes (failed, pruned, succeeded).
 * 4. Tampering with any historical branch or removing a failed branch invalidates the root.
 */

import {
  StrategySearchNode,
  RepairCandidate,
  BacktrackPoint,
  computeSearchTreeProvenanceRoot,
} from "../domain/repair-strategy-search.js";
import { sha256Hex, canonicalJsonStringify } from "../domain/canonical-hash.js";

export interface SearchProvenanceEntry {
  readonly type: "NODE" | "CANDIDATE" | "BACKTRACK";
  readonly id: string;
  readonly digest: string;
  readonly parentId?: string;
  readonly status: string;
  readonly timestamp: string;
}

export class RepairStrategyProvenanceEngine {
  /**
   * Compute evidence digest for a search tree node.
   */
  public computeNodeEvidenceDigest(node: StrategySearchNode): string {
    const raw = {
      nodeId: node.nodeId,
      parentNodeId: node.parentNodeId,
      searchId: node.searchId,
      strategyId: node.strategyId,
      depth: node.depth,
      branchIndex: node.branchIndex,
      workspaceSnapshotDigest: node.workspaceSnapshotDigest,
      inputEvidenceDigest: node.inputEvidenceDigest,
      outputEvidenceDigest: node.outputEvidenceDigest,
      compositionDigest: node.compositionDigest,
      status: node.status,
    };
    return sha256Hex(canonicalJsonStringify(raw));
  }

  /**
   * Compute evidence digest for a generated repair candidate.
   */
  public computeCandidateEvidenceDigest(candidate: RepairCandidate): string {
    const raw = {
      candidateId: candidate.candidateId,
      searchId: candidate.searchId,
      strategyId: candidate.strategyId,
      nodeId: candidate.nodeId,
      patchDigest: candidate.patchDigest,
      affectedScope: candidate.affectedScope,
      status: candidate.status,
    };
    return sha256Hex(canonicalJsonStringify(raw));
  }

  /**
   * Compute evidence digest for a backtrack point.
   */
  public computeBacktrackEvidenceDigest(backtrack: BacktrackPoint): string {
    const raw = {
      searchId: backtrack.searchId,
      backtrackId: backtrack.backtrackId,
      nodeId: backtrack.nodeId,
      parentNodeId: backtrack.parentNodeId,
      workspaceSnapshotDigest: backtrack.workspaceSnapshotDigest,
      evidenceDigest: backtrack.evidenceDigest,
      strategyDigest: backtrack.strategyDigest,
      actionSequenceBoundary: backtrack.actionSequenceBoundary,
      reason: backtrack.reason,
    };
    return sha256Hex(canonicalJsonStringify(raw));
  }

  /**
   * Calculate complete Merkle provenance root across all search entities.
   */
  public computeSearchProvenanceRoot(
    nodes: readonly StrategySearchNode[],
    candidates: readonly RepairCandidate[] = [],
    backtrackPoints: readonly BacktrackPoint[] = []
  ): string {
    const digests: string[] = [];

    for (const node of nodes) {
      digests.push(this.computeNodeEvidenceDigest(node));
    }
    for (const cand of candidates) {
      digests.push(this.computeCandidateEvidenceDigest(cand));
    }
    for (const bt of backtrackPoints) {
      digests.push(this.computeBacktrackEvidenceDigest(bt));
    }

    return computeSearchTreeProvenanceRoot(digests);
  }

  /**
   * Verify whether claimed provenance root matches the exact historical search records.
   */
  public verifySearchProvenanceChain(
    nodes: readonly StrategySearchNode[],
    candidates: readonly RepairCandidate[],
    backtrackPoints: readonly BacktrackPoint[],
    claimedRoot: string
  ): boolean {
    if (!claimedRoot || nodes.length === 0) {
      return false;
    }
    const recomputed = this.computeSearchProvenanceRoot(nodes, candidates, backtrackPoints);
    return recomputed === claimedRoot;
  }
}
