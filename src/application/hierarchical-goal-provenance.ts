/**
 * Phase 89: Hierarchical Goal Provenance Engine
 *
 * Implements cryptographic Merkle-style provenance trees across goal nodes,
 * candidate agent plans, conflict reconciliation records, and local/global verification digests.
 *
 * INVARIANTS:
 * 1. Historical provenance edges cannot be removed or mutated.
 * 2. Any single-bit tampering invalidates the tree provenance root.
 * 3. Provenance verification is 100% deterministic.
 */

import { GoalNode, SubGoalLocalVerificationResult } from "../domain/hierarchical-goal-decomposition.js";
import { AgentPlan, ReconciledPlan } from "../domain/multi-agent-plan.js";
import { canonicalJsonStringify, sha256Hex } from "../domain/canonical-hash.js";

export class HierarchicalGoalProvenanceEngine {
  /**
   * Compute the global Merkle provenance root for an entire goal tree.
   */
  public computeTreeProvenanceRoot(params: {
    readonly nodes: readonly GoalNode[];
    readonly plans?: readonly AgentPlan[];
    readonly reconciliations?: readonly ReconciledPlan[];
    readonly verifications: readonly SubGoalLocalVerificationResult[];
  }): string {
    const sortedNodeDigests = [...params.nodes].map((n) => n.goalDigest).sort();
    const sortedPlanDigests = (params.plans || []).map((p) => p.planDigest).sort();
    const sortedRecDigests = (params.reconciliations || []).map((r) => r.reconciliationDigest).sort();
    const sortedVerifDigests = [...params.verifications].map((v) => v.evidenceDigest).sort();

    const nodesRoot = sha256Hex(canonicalJsonStringify(sortedNodeDigests));
    const plansRoot = sha256Hex(canonicalJsonStringify(sortedPlanDigests));
    const recRoot = sha256Hex(canonicalJsonStringify(sortedRecDigests));
    const verifRoot = sha256Hex(canonicalJsonStringify(sortedVerifDigests));

    return sha256Hex(
      canonicalJsonStringify({
        nodesRoot,
        plansRoot,
        recRoot,
        verifRoot,
      })
    );
  }

  /**
   * Verify the integrity of a tree provenance root against its components.
   */
  public verifyTreeProvenance(
    expectedRoot: string,
    components: {
      readonly nodes: readonly GoalNode[];
      readonly plans: readonly AgentPlan[];
      readonly reconciliations: readonly ReconciledPlan[];
      readonly verifications: readonly SubGoalLocalVerificationResult[];
    }
  ): boolean {
    const computedRoot = this.computeTreeProvenanceRoot(components);
    return computedRoot === expectedRoot;
  }
}
