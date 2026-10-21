/**
 * Phase 89: Hierarchical Goal Decomposer
 *
 * Untrusted generator of candidate sub-goals and dependency structures.
 *
 * Invariants:
 * 1. Output is UNTRUSTED_OBSERVATION.
 * 2. Does NOT execute code or modify system state.
 * 3. Strips all authority-bearing keys (workerId, leaseId, credentials, terminalAuthority, policyApproval).
 * 4. Derives child scopes and capabilities as strict subsets of parent bounds.
 * 5. Computes GoalAtomicity metrics for every generated sub-goal.
 */

import {
  GoalNode,
  GoalScope,
  GoalAtomicity,
  SubGoalContract,
  GoalDependencyEdge,
  computeGoalDigest,
  computeSubGoalContractDigest,
  DEFAULT_GOAL_RESOURCE_LIMITS,
} from "../domain/hierarchical-goal-decomposition.js";
import { sha256Hex } from "../domain/canonical-hash.js";
import type { AllowedToolCapability } from "../domain/dynamic-tool.js";

export interface SubGoalProposal {
  readonly goalId?: string;
  readonly objective: string;
  readonly constraints?: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly dependencies?: readonly string[];
  readonly affectedScope: GoalScope;
  readonly requiredCapabilities?: readonly AllowedToolCapability[];
  readonly requiredEvidence: readonly string[];
  readonly expectedArtifacts?: readonly string[];
  readonly verificationRequirements?: readonly string[];
  readonly resourceBudget?: Partial<typeof DEFAULT_GOAL_RESOURCE_LIMITS>;
  readonly injectedAuthorityKeys?: Record<string, unknown>; // Test probe for N391, N405, etc.
}

export interface DecompositionResult {
  readonly parentGoalId: string;
  readonly rootGoalId: string;
  readonly subGoals: readonly GoalNode[];
  readonly contracts: readonly SubGoalContract[];
  readonly dependencyEdges: readonly GoalDependencyEdge[];
  readonly provenanceDigest: string;
}

export class HierarchicalGoalDecomposer {
  /**
   * Decompose a parent goal into candidate sub-goals.
   * Strips all authority keys and establishes strict subset relationships.
   */
  public decompose(
    parentGoal: GoalNode,
    proposals: readonly SubGoalProposal[]
  ): DecompositionResult {
    const parentDepth = parentGoal.depth;
    const childDepth = parentDepth + 1;
    const rootGoalId = parentGoal.rootGoalId;

    const subGoals: GoalNode[] = [];
    const contracts: SubGoalContract[] = [];
    const dependencyEdges: GoalDependencyEdge[] = [];

    for (let i = 0; i < proposals.length; i++) {
      const prop = proposals[i];
      if (!prop) continue;
      const sequenceNumber = i + 1;
      const goalId = prop.goalId || `goal-${parentGoal.goalId}-d${childDepth}-s${sequenceNumber}`;

      // Invariant H2: ChildCapabilities ⊆ ParentCapabilities
      const allowedCaps = prop.requiredCapabilities
        ? prop.requiredCapabilities.filter((c) => parentGoal.requiredCapabilities.includes(c))
        : parentGoal.requiredCapabilities;

      // Invariant H3: ChildScope ⊆ ParentScope
      const workspaceScopes = prop.affectedScope.workspaceScopes.filter((ws) =>
        parentGoal.affectedScope.workspaceScopes.includes(ws)
      );
      const repositoryScopes = prop.affectedScope.repositoryScopes.filter((repo) =>
        parentGoal.affectedScope.repositoryScopes.includes(repo)
      );
      const targetFiles = prop.affectedScope.targetFiles.filter(
        (f) =>
          parentGoal.affectedScope.targetFiles.length === 0 ||
          parentGoal.affectedScope.targetFiles.includes(f)
      );

      const constrainedScope: GoalScope = {
        workspaceScopes: workspaceScopes.length > 0 ? workspaceScopes : parentGoal.affectedScope.workspaceScopes,
        repositoryScopes: repositoryScopes.length > 0 ? repositoryScopes : parentGoal.affectedScope.repositoryScopes,
        targetFiles: targetFiles.length > 0 ? targetFiles : prop.affectedScope.targetFiles,
      };

      const constraints = prop.constraints ? [...prop.constraints] : [...parentGoal.constraints];
      const acceptanceCriteria = prop.acceptanceCriteria ? [...prop.acceptanceCriteria] : [];
      const dependencies = prop.dependencies ? [...prop.dependencies] : [];

      // Evaluate goal atomicity
      const atomicity = this.evaluateAtomicity(constrainedScope, acceptanceCriteria, prop.requiredEvidence, dependencies);

      const rawDigestData = {
        goalId,
        parentGoalId: parentGoal.goalId,
        rootGoalId,
        depth: childDepth,
        sequenceNumber,
        objective: prop.objective,
        constraints,
        acceptanceCriteria,
        dependencies,
        affectedScope: constrainedScope,
        requiredCapabilities: allowedCaps,
        requiredEvidence: [...prop.requiredEvidence],
      };

      const goalDigest = computeGoalDigest(rawDigestData);

      const node: GoalNode = {
        goalId,
        parentGoalId: parentGoal.goalId,
        rootGoalId,
        depth: childDepth,
        sequenceNumber,
        goalDigest,
        objective: prop.objective,
        constraints,
        acceptanceCriteria,
        dependencies,
        affectedScope: constrainedScope,
        requiredCapabilities: allowedCaps,
        requiredEvidence: [...prop.requiredEvidence],
        resourceBudget: {
          maxDepth: DEFAULT_GOAL_RESOURCE_LIMITS.maxDepth,
          maxTotalGoals: DEFAULT_GOAL_RESOURCE_LIMITS.maxTotalGoals,
          maxTotalWallTimeMs:
            prop.resourceBudget?.maxTotalWallTimeMs ??
            parentGoal.resourceBudget.maxTotalWallTimeMs ??
            DEFAULT_GOAL_RESOURCE_LIMITS.maxTotalWallTimeMs,
          maxTotalToolCalls:
            prop.resourceBudget?.maxTotalToolCalls ??
            parentGoal.resourceBudget.maxTotalToolCalls ??
            DEFAULT_GOAL_RESOURCE_LIMITS.maxTotalToolCalls,
        },
        status: "DECOMPOSED",
        provenance: sha256Hex(`prov-${parentGoal.goalDigest}:${goalDigest}`),
        atomicity,
        createdAt: parentGoal.createdAt,
      };

      subGoals.push(node);

      // Create formal sub-goal contract binding parent digest
      const rawContract = {
        goalId,
        parentGoalId: parentGoal.goalId,
        rootGoalId,
        objective: prop.objective,
        scope: constrainedScope,
        expectedArtifacts: prop.expectedArtifacts ? [...prop.expectedArtifacts] : ["DIFF", "TEST_REPORT"],
        acceptanceCriteria,
        dependencies,
        verificationRequirements: prop.verificationRequirements ? [...prop.verificationRequirements] : ["UNIT_TEST"],
        parentContractDigest: parentGoal.goalDigest,
      };

      const contractDigest = computeSubGoalContractDigest(rawContract);
      contracts.push({
        ...rawContract,
        resourceLimits: node.resourceBudget,
        contractDigest,
      });

      // Record dependency edges
      for (const depId of dependencies) {
        dependencyEdges.push({
          fromGoalId: depId,
          toGoalId: goalId,
        });
      }
    }

    const provenanceDigest = sha256Hex(
      subGoals.map((g) => g.goalDigest).join(":") + ":" + dependencyEdges.map((e) => `${e.fromGoalId}->${e.toGoalId}`).join(",")
    );

    return {
      parentGoalId: parentGoal.goalId,
      rootGoalId,
      subGoals,
      contracts,
      dependencyEdges,
      provenanceDigest,
    };
  }

  /**
   * Measure GoalAtomicity.
   */
  public evaluateAtomicity(
    scope: GoalScope,
    acceptanceCriteria: readonly string[],
    evidence: readonly string[],
    dependencies: readonly string[]
  ): GoalAtomicity {
    const affectedScopeBounded = scope.targetFiles.length > 0 && scope.targetFiles.length <= 5;
    const acceptanceCriteriaTestable = acceptanceCriteria.length > 0;
    const evidenceExplicit = evidence.length > 0;
    const dependenciesKnown = Array.isArray(dependencies);

    let score = 0;
    if (affectedScopeBounded) score += 30;
    if (acceptanceCriteriaTestable) score += 30;
    if (evidenceExplicit) score += 20;
    if (dependenciesKnown) score += 20;

    return {
      affectedScopeBounded,
      acceptanceCriteriaTestable,
      evidenceExplicit,
      dependenciesKnown,
      atomicityScore: score,
    };
  }
}
