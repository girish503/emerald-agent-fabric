/**
 * Phase 89: Hierarchical Goal Policy
 *
 * Enforces strict governance invariants on goal decomposition, capability derivation,
 * scope containment, resource limits, DAG cycle prevention, and non-self-authorization.
 *
 * INVARIANTS:
 * 1. GoalAuthority ⊆ ParentAuthority
 * 2. GoalCapabilities ⊆ ParentCapabilities
 * 3. GoalScope ⊆ ParentScope
 * 4. GoalResources ≤ ParentRemainingResources
 * 5. Depth <= 4, Width <= 4, Total Goals <= 16, Dependencies <= 32
 * 6. DAG cycle prevention (no self loops, no cycles)
 * 7. No self-authorization from dynamic tools
 */

import {
  GoalNode,
  GoalTree,
  SubGoalContract,
  GoalDependencyEdge,
  DEFAULT_GOAL_RESOURCE_LIMITS,
  computeGoalDigest,
  computeSubGoalContractDigest,
} from "../domain/hierarchical-goal-decomposition.js";
import { canonicalJsonStringify, sha256Hex } from "../domain/canonical-hash.js";
import type { SearchWorkflowContext } from "../domain/repair-strategy-search.js";

export interface GoalValidationReport {
  readonly valid: boolean;
  readonly status: "AUTHORIZED_FOR_PLANNING" | "QUARANTINED";
  readonly diagnostics: readonly string[];
  readonly rejectedGoals: readonly string[];
  readonly detectedCycles: readonly string[];
  readonly validationDigest: string;
}

export class HierarchicalGoalPolicy {
  /**
   * Validate a proposed goal decomposition against all Phase 89 invariants.
   */
  public validateDecomposition(
    tree: GoalTree,
    parentGoal: GoalNode,
    subGoals: readonly GoalNode[],
    contracts: readonly SubGoalContract[],
    dependencyEdges: readonly GoalDependencyEdge[],
    workflowContext: SearchWorkflowContext
  ): GoalValidationReport {
    const diagnostics: string[] = [];
    const rejectedGoals: string[] = [];
    const detectedCycles: string[] = [];

    // 1. Self-authorization check (N391)
    if (workflowContext.isDynamicToolCaller || workflowContext.callerIdentity === "dynamic") {
      diagnostics.push("Self-authorization prohibited: dynamic tools cannot authorize goal decompositions.");
    }

    // 2. Payload size check
    const payloadBytes = Buffer.byteLength(
      canonicalJsonStringify({ parentGoal, subGoals, contracts, dependencyEdges }),
      "utf8"
    );
    if (payloadBytes > DEFAULT_GOAL_RESOURCE_LIMITS.maxPlanPayloadBytes) {
      diagnostics.push(
        `Decomposition payload (${payloadBytes} bytes) exceeds maximum allowed (${DEFAULT_GOAL_RESOURCE_LIMITS.maxPlanPayloadBytes} bytes).`
      );
    }

    // 3. Depth check (N398)
    for (const child of subGoals) {
      if (child.depth > DEFAULT_GOAL_RESOURCE_LIMITS.maxDepth || child.depth < 1) {
        diagnostics.push(`Goal '${child.goalId}' depth ${child.depth} exceeds max allowable depth ${DEFAULT_GOAL_RESOURCE_LIMITS.maxDepth}.`);
        rejectedGoals.push(child.goalId);
      }
      if (child.depth !== parentGoal.depth + 1) {
        diagnostics.push(`Goal '${child.goalId}' depth ${child.depth} is not parent depth + 1.`);
        rejectedGoals.push(child.goalId);
      }
    }

    // 4. Width check: children per node <= 4 (N399)
    if (subGoals.length > DEFAULT_GOAL_RESOURCE_LIMITS.maxChildrenPerNode) {
      diagnostics.push(
        `Child goal count (${subGoals.length}) exceeds maximum allowable children per node (${DEFAULT_GOAL_RESOURCE_LIMITS.maxChildrenPerNode}).`
      );
    }

    // 5. Total node count check: total goals <= 16 (N400)
    const existingNodeCount = Object.keys(tree.nodes).length;
    if (existingNodeCount + subGoals.length > DEFAULT_GOAL_RESOURCE_LIMITS.maxTotalGoals) {
      diagnostics.push(
        `Total goal count (${existingNodeCount + subGoals.length}) exceeds maximum allowable total goals (${DEFAULT_GOAL_RESOURCE_LIMITS.maxTotalGoals}).`
      );
    }

    // 6. Max dependency edges check: <= 32
    if (tree.dependencyEdges.length + dependencyEdges.length > DEFAULT_GOAL_RESOURCE_LIMITS.maxDependencyEdges) {
      diagnostics.push(
        `Dependency edge count exceeds maximum allowable limit (${DEFAULT_GOAL_RESOURCE_LIMITS.maxDependencyEdges}).`
      );
    }

    // 7. Duplicate goal detection
    const goalIdSet = new Set(Object.keys(tree.nodes));
    for (const child of subGoals) {
      if (goalIdSet.has(child.goalId)) {
        diagnostics.push(`Duplicate goal ID detected: '${child.goalId}'.`);
        rejectedGoals.push(child.goalId);
      }
      goalIdSet.add(child.goalId);
    }

    // 8. Individual child governance checks
    for (const child of subGoals) {
      // Check parent binding
      if (child.parentGoalId !== parentGoal.goalId) {
        diagnostics.push(`Child '${child.goalId}' parentGoalId does not match parent '${parentGoal.goalId}'.`);
        rejectedGoals.push(child.goalId);
      }
      if (child.rootGoalId !== parentGoal.rootGoalId) {
        diagnostics.push(`Child '${child.goalId}' rootGoalId does not match root '${parentGoal.rootGoalId}'.`);
        rejectedGoals.push(child.goalId);
      }

      // Check capability containment (N392)
      for (const cap of child.requiredCapabilities) {
        if (!parentGoal.requiredCapabilities.includes(cap)) {
          diagnostics.push(
            `Child goal '${child.goalId}' requests capability '${cap}' absent from parent capability scope.`
          );
          rejectedGoals.push(child.goalId);
        }
      }

      // Check workspace scope containment (N395)
      for (const ws of child.affectedScope.workspaceScopes) {
        if (!parentGoal.affectedScope.workspaceScopes.includes(ws)) {
          diagnostics.push(
            `Child goal '${child.goalId}' requests workspace '${ws}' outside parent workspace scope.`
          );
          rejectedGoals.push(child.goalId);
        }
      }

      // Check repository scope containment (N394)
      for (const repo of child.affectedScope.repositoryScopes) {
        if (!parentGoal.affectedScope.repositoryScopes.includes(repo)) {
          diagnostics.push(
            `Child goal '${child.goalId}' requests repository '${repo}' outside parent repository scope.`
          );
          rejectedGoals.push(child.goalId);
        }
      }

      // Check target file containment (N393)
      if (parentGoal.affectedScope.targetFiles.length > 0) {
        for (const file of child.affectedScope.targetFiles) {
          if (!parentGoal.affectedScope.targetFiles.includes(file)) {
            diagnostics.push(
              `Child goal '${child.goalId}' targets file '${file}' outside parent target file boundary.`
            );
            rejectedGoals.push(child.goalId);
          }
        }
      }

      // Check resource containment (N416)
      if (
        child.resourceBudget.maxTotalWallTimeMs &&
        parentGoal.resourceBudget.maxTotalWallTimeMs &&
        child.resourceBudget.maxTotalWallTimeMs > parentGoal.resourceBudget.maxTotalWallTimeMs
      ) {
        diagnostics.push(`Child goal '${child.goalId}' wallTime budget exceeds parent ceiling.`);
        rejectedGoals.push(child.goalId);
      }

      // Check acceptance criteria completeness
      if (!child.acceptanceCriteria || child.acceptanceCriteria.length === 0) {
        diagnostics.push(`Child goal '${child.goalId}' lacks testable acceptance criteria.`);
        rejectedGoals.push(child.goalId);
      }

      // Verify goal digest
      const expectedDigest = computeGoalDigest({
        goalId: child.goalId,
        parentGoalId: child.parentGoalId,
        rootGoalId: child.rootGoalId,
        depth: child.depth,
        sequenceNumber: child.sequenceNumber,
        objective: child.objective,
        constraints: child.constraints,
        acceptanceCriteria: child.acceptanceCriteria,
        dependencies: child.dependencies,
        affectedScope: child.affectedScope,
        requiredCapabilities: child.requiredCapabilities,
        requiredEvidence: child.requiredEvidence,
      });
      if (child.goalDigest !== expectedDigest) {
        diagnostics.push(`Child goal '${child.goalId}' digest mismatch.`);
        rejectedGoals.push(child.goalId);
      }

      // Contract binding verification (N396)
      const matchingContract = contracts.find((c) => c.goalId === child.goalId);
      if (!matchingContract) {
        diagnostics.push(`Child goal '${child.goalId}' lacks corresponding SubGoalContract.`);
        rejectedGoals.push(child.goalId);
      } else {
        if (matchingContract.parentContractDigest !== parentGoal.goalDigest) {
          diagnostics.push(
            `Child goal '${child.goalId}' contract does not bind parent goal digest '${parentGoal.goalDigest}'.`
          );
          rejectedGoals.push(child.goalId);
        }
        const expectedContractDigest = computeSubGoalContractDigest({
          goalId: matchingContract.goalId,
          parentGoalId: matchingContract.parentGoalId,
          rootGoalId: matchingContract.rootGoalId,
          objective: matchingContract.objective,
          scope: matchingContract.scope,
          expectedArtifacts: matchingContract.expectedArtifacts,
          acceptanceCriteria: matchingContract.acceptanceCriteria,
          dependencies: matchingContract.dependencies,
          verificationRequirements: matchingContract.verificationRequirements,
          parentContractDigest: matchingContract.parentContractDigest,
        });
        if (matchingContract.contractDigest !== expectedContractDigest) {
          diagnostics.push(`Child goal '${child.goalId}' contract digest mismatch.`);
          rejectedGoals.push(child.goalId);
        }
      }
    }

    // 9. Hidden dependency injection check (N402)
    // All dependencies must refer to known goals in the tree or the newly proposed children
    for (const child of subGoals) {
      for (const depId of child.dependencies) {
        if (!goalIdSet.has(depId)) {
          diagnostics.push(
            `Child goal '${child.goalId}' declares hidden dependency '${depId}' not present in tree.`
          );
          rejectedGoals.push(child.goalId);
        }
      }
    }

    // 10. Dependency cycle detection (N401)
    const allEdges = [...tree.dependencyEdges, ...dependencyEdges];
    const cycleReport = this.detectCycles(allEdges, Array.from(goalIdSet));
    if (cycleReport.hasCycle) {
      detectedCycles.push(...cycleReport.cycles);
      diagnostics.push(`Dependency cycle detected: ${cycleReport.cycles.join(", ")}`);
    }

    const valid = diagnostics.length === 0;
    const status = valid ? "AUTHORIZED_FOR_PLANNING" : "QUARANTINED";
    const validationDigest = sha256Hex(
      canonicalJsonStringify({
        parentGoalId: parentGoal.goalId,
        valid,
        status,
        diagnostics,
        rejectedGoals,
        detectedCycles,
      })
    );

    return {
      valid,
      status,
      diagnostics,
      rejectedGoals,
      detectedCycles,
      validationDigest,
    };
  }

  /**
   * Detect cycles in dependency graph using Tarjan's or DFS coloring algorithm.
   */
  public detectCycles(
    edges: readonly GoalDependencyEdge[],
    nodeIds: readonly string[]
  ): { hasCycle: boolean; cycles: string[] } {
    const adj: Map<string, string[]> = new Map();
    for (const id of nodeIds) {
      adj.set(id, []);
    }
    for (const edge of edges) {
      // Check self-loop (A -> A)
      if (edge.fromGoalId === edge.toGoalId) {
        return {
          hasCycle: true,
          cycles: [`SELF_LOOP: ${edge.fromGoalId} -> ${edge.toGoalId}`],
        };
      }
      if (!adj.has(edge.fromGoalId)) {
        adj.set(edge.fromGoalId, []);
      }
      adj.get(edge.fromGoalId)!.push(edge.toGoalId);
    }

    const visited: Map<string, number> = new Map(); // 0 = unvisited, 1 = visiting, 2 = visited
    const cycles: string[] = [];

    const dfs = (curr: string, path: string[]): boolean => {
      visited.set(curr, 1);
      const neighbors = adj.get(curr) || [];
      for (const n of neighbors) {
        if (visited.get(n) === 1) {
          // Cycle found
          const cyclePath = [...path, curr, n].join(" -> ");
          cycles.push(cyclePath);
          return true;
        }
        if (visited.get(n) !== 2) {
          if (dfs(n, [...path, curr])) {
            return true;
          }
        }
      }
      visited.set(curr, 2);
      return false;
    };

    for (const id of nodeIds) {
      if (!visited.has(id) || visited.get(id) === 0) {
        if (dfs(id, [])) {
          break;
        }
      }
    }

    return {
      hasCycle: cycles.length > 0,
      cycles,
    };
  }
}
