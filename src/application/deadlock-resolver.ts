/**
 * Phase 97: Deadlock Resolver
 *
 * Implements governed cycle breaking strategies under the Minimum-Intervention Principle:
 * WAIT_EDGE_REMOVAL, RESOURCE_REORDERING, PRIORITY_INHERITANCE, WORKLOAD_HANDOFF,
 * GOVERNED_PREEMPTION, SPECULATIVE_BRANCH_TERMINATION, LEASE_RECOVERY, HUMAN_REVIEW_REQUIRED.
 *
 * ABSOLUTE GOVERNING PRINCIPLE:
 * Deadlock may change execution relationships. Deadlock resolution must never change authority.
 */

import { ClockPort, SystemClock } from "../ports/clock.port.js";
import { sha256Hex } from "../domain/canonical-hash.js";
import {
  CycleWitness,
  CycleBreakingStrategy,
  DeadlockResolution,
  INTERVENTION_STRATEGY_COSTS,
  computeDeadlockResolutionHash,
} from "../domain/deadlock-detection.js";
import { DeadlockDetector } from "./deadlock-detector.js";

export interface ResolveCycleResult {
  readonly success: boolean;
  readonly resolution: DeadlockResolution;
  readonly brokenEdgeId?: string;
  readonly affectedNodeId: string;
  readonly reason: string;
}

export class DeadlockResolver {
  private readonly resolutions: Map<string, DeadlockResolution> = new Map();
  private recursionDepth: number = 0;
  private readonly MAX_RECURSION_DEPTH: number = 5;

  constructor(
    private readonly detector: DeadlockDetector,
    private readonly clock: ClockPort = new SystemClock(),
  ) {}

  /**
   * Determine the minimal safe intervention strategy for a cycle witness.
   * Invariant D4: UNKNOWN classification fails closed to HUMAN_REVIEW_REQUIRED.
   * Section 14: Minimum-Intervention ordering.
   */
  public selectStrategy(witness: CycleWitness): {
    strategy: CycleBreakingStrategy;
    targetNodeId: string;
    targetEdgeId?: string;
    rationale: string;
  } {
    // 1. If not a true deadlock (e.g. transient contention), do not intervene
    if (witness.classification === "TRANSIENT_CONTENTION") {
      return {
        strategy: "NO_INTERVENTION",
        targetNodeId: witness.nodeIds[0],
        rationale: "Transient contention is resolving asynchronously; no intervention required",
      };
    }

    // 2. Fail-closed on UNKNOWN
    if (witness.classification === "UNKNOWN") {
      return {
        strategy: "HUMAN_REVIEW_REQUIRED",
        targetNodeId: witness.nodeIds[0],
        rationale: "Cycle classification is UNKNOWN; fail-closed quarantine required (D4, N646)",
      };
    }

    // 3. Priority Inversion -> Temporary Priority Inheritance
    if (witness.classification === "PRIORITY_INVERSION") {
      return {
        strategy: "PRIORITY_INHERITANCE",
        targetNodeId: witness.nodeIds[0],
        rationale: "Priority inversion detected; apply non-authoritative priority inheritance boost",
      };
    }

    // 4. Stale or Failed Lease -> Lease Recovery
    if (witness.classification === "RECOVERABLE_LEASE_FAILURE" || witness.classification === "STALE_DEPENDENCY") {
      return {
        strategy: "LEASE_RECOVERY",
        targetNodeId: witness.nodeIds[0],
        rationale: "Stale dependency or expired lease detected; trigger bounded lease fencing recovery (D12)",
      };
    }

    // 5. Check if any edge in the cycle is optional -> WAIT_EDGE_REMOVAL (Lowest cost active intervention)
    for (const edgeId of witness.edgeIds) {
      const edge = this.detector.getEdge(edgeId);
      if (edge?.isOptional) {
        return {
          strategy: "WAIT_EDGE_REMOVAL",
          targetNodeId: edge.fromNodeId,
          targetEdgeId: edge.edgeId,
          rationale: `Removed non-essential optional wait edge ${edge.edgeId} (Cost 10, Minimum-Intervention)`,
        };
      }
    }

    // 6. Check for speculative branch participating in cycle -> SPECULATIVE_BRANCH_TERMINATION
    for (const nodeId of witness.nodeIds) {
      const node = this.detector.getNode(nodeId);
      if (node?.nodeType === "SPECULATIVE_BRANCH" || node?.branchId) {
        return {
          strategy: "SPECULATIVE_BRANCH_TERMINATION",
          targetNodeId: nodeId,
          rationale: `Terminated non-sovereign speculative branch ${nodeId} to clear confirmed execution path (D17)`,
        };
      }
    }

    // 7. Check for resource-ordered reordering (pure resource deadlock)
    if (witness.classification === "RESOURCE_EXHAUSTION") {
      return {
        strategy: "RESOURCE_REORDERING",
        targetNodeId: witness.nodeIds[0],
        rationale: "Resource exhaustion cycle broken via deterministic acquisition reordering",
      };
    }

    // 8. Check for advisory role cycle -> WORKLOAD_HANDOFF
    const hasRoleNodes = witness.nodeIds.some((id) => this.detector.getNode(id)?.nodeType === "AGENT");
    if (hasRoleNodes) {
      return {
        strategy: "WORKLOAD_HANDOFF",
        targetNodeId: witness.nodeIds[1] || witness.nodeIds[0],
        rationale: "Advisory role handoff breaks execution deadlock without contract mutation (D15)",
      };
    }

    // 9. Standard TRUE_DEADLOCK -> GOVERNED_PREEMPTION with durable checkpoint
    return {
      strategy: "GOVERNED_PREEMPTION",
      targetNodeId: witness.nodeIds[witness.nodeIds.length - 1], // Suspend lowest or tail participant
      rationale: "Governed pre-emption with durable working-tree checkpoint breaks cyclic wait (D14, P6)",
    };
  }

  /**
   * Execute cycle breaking intervention for a verified CycleWitness.
   * Guarantees bounded recursion depth (N658, D20).
   */
  public resolveCycle(witness: CycleWitness): ResolveCycleResult {
    this.recursionDepth++;
    if (this.recursionDepth > this.MAX_RECURSION_DEPTH) {
      this.recursionDepth--;
      throw new Error(`Deadlock resolution recursion limit (${this.MAX_RECURSION_DEPTH}) exceeded (N658, D20)`);
    }

    try {
      const { strategy, targetNodeId, targetEdgeId, rationale } = this.selectStrategy(witness);
      const interventionCost = INTERVENTION_STRATEGY_COSTS[strategy];
      const resolutionId = `res-${witness.cycleId}-${sha256Hex(strategy + targetNodeId).slice(0, 8)}`;
      const resolvedAt = this.clock.now().toISOString();

      const rawResolution: Omit<DeadlockResolution, "resolutionDigest"> = {
        resolutionId,
        cycleId: witness.cycleId,
        strategy,
        targetNodeId,
        targetEdgeId,
        interventionCost,
        rationale,
        resolvedAt,
        authoritative: false,
      };

      const resolutionDigest = computeDeadlockResolutionHash(rawResolution);
      const resolution: DeadlockResolution = { ...rawResolution, resolutionDigest };
      this.resolutions.set(resolution.resolutionId, resolution);

      // Execute strategy-specific state mutations
      let brokenEdgeId = targetEdgeId;

      switch (strategy) {
        case "NO_INTERVENTION":
          // No mutation
          break;

        case "WAIT_EDGE_REMOVAL":
          if (targetEdgeId) {
            this.detector.removeEdge(targetEdgeId);
          }
          break;

        case "RESOURCE_REORDERING":
        case "PRIORITY_INHERITANCE":
        case "WORKLOAD_HANDOFF":
          // Break the closing edge in the graph representation
          if (witness.edgeIds.length > 0) {
            brokenEdgeId = witness.edgeIds[witness.edgeIds.length - 1];
            this.detector.removeEdge(brokenEdgeId);
          }
          break;

        case "GOVERNED_PREEMPTION":
        case "SPECULATIVE_BRANCH_TERMINATION":
        case "LEASE_RECOVERY":
          // Break the inbound edge to target node
          if (witness.edgeIds.length > 0) {
            brokenEdgeId = witness.edgeIds[0];
            this.detector.removeEdge(brokenEdgeId);
          }
          break;

        case "HUMAN_REVIEW_REQUIRED":
          // Quarantined; edge remains intact for human review
          break;
      }

      return {
        success: strategy !== "HUMAN_REVIEW_REQUIRED",
        resolution,
        brokenEdgeId,
        affectedNodeId: targetNodeId,
        reason: rationale,
      };
    } finally {
      this.recursionDepth--;
    }
  }

  /**
   * Resolve all detected cycles in the graph under Minimum-Intervention Principle.
   */
  public resolveAllDeadlocks(): ResolveCycleResult[] {
    const witnesses = this.detector.detectAllDeadlocks();
    const results: ResolveCycleResult[] = [];

    for (const witness of witnesses) {
      const res = this.resolveCycle(witness);
      results.push(res);
    }

    return results;
  }

  public getResolution(resolutionId: string): DeadlockResolution | undefined {
    return this.resolutions.get(resolutionId);
  }

  public getAllResolutions(): DeadlockResolution[] {
    return Array.from(this.resolutions.values());
  }

  public clear(): void {
    this.resolutions.clear();
    this.recursionDepth = 0;
  }
}
