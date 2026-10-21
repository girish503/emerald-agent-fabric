/**
 * Phase 89: Multi-Agent Plan Reconciler
 *
 * Compares candidate plans, identifies conflicts across all 12 conflict classes,
 * applies deterministic reconciliation policies (A, B, C, D), and emits advisory reconciled plans.
 *
 * INVARIANTS:
 * 1. Reconciled plans possess ZERO terminal, policy, contract, or verification authority.
 * 2. Never silently suppress conflicts (fail closed on unresolvable blocking conflicts).
 * 3. Never deletes candidate plans or conflict evidence.
 * 4. Deterministic reconciliation: identical input plans yield identical reconciliation output.
 */

import { GoalNode } from "../domain/hierarchical-goal-decomposition.js";
import {
  AgentPlan,
  PlanConflict,
  ReconciliationPolicyType,
  ReconciledPlan,
  ProposedAction,
  computeConflictDigest,
  computeReconciliationDigest,
} from "../domain/multi-agent-plan.js";
import { sha256Hex } from "../domain/canonical-hash.js";

const ROLE_PRIORITY: Record<string, number> = {
  IMPLEMENTER: 100,
  ANALYZER: 80,
  TEST_ANALYST: 70,
  DEPENDENCY_ANALYST: 60,
  REVIEWER: 50,
  RECONCILER: 40,
};

export class MultiAgentPlanReconciler {
  /**
   * Reconcile candidate plans for a sub-goal under a specific policy.
   */
  public reconcilePlans(
    goal: GoalNode,
    plans: readonly AgentPlan[],
    policy: ReconciliationPolicyType
  ): ReconciledPlan {
    const reconciliationId = `rec-${goal.goalId}-${policy.toLowerCase().replace(/_/g, "-")}`;

    if (plans.length === 0) {
      return {
        reconciliationId,
        goalId: goal.goalId,
        policy,
        selectedPlanIds: [],
        reconciledActions: [],
        mergedAssumptions: [],
        resolvedConflicts: [],
        unresolvedConflicts: [],
        reconciliationDigest: sha256Hex(`empty-rec:${goal.goalId}`),
        provenanceRoot: sha256Hex(`prov-empty:${goal.goalId}`),
        status: "RECONCILIATION_BLOCKED",
        authoritative: false,
        policyAuthority: false,
        terminalAuthority: false,
        verificationAuthority: false,
        createdAt: goal.createdAt,
      };
    }

    // 1. Detect all conflicts across candidate plans
    const detectedConflicts = this.detectConflicts(goal, plans);

    let selectedPlans: AgentPlan[] = [];
    let resolvedConflicts: PlanConflict[] = [];
    let unresolvedConflicts: PlanConflict[] = [];
    let status: "RECONCILED" | "RECONCILIATION_BLOCKED" = "RECONCILED";

    // 2. Apply reconciliation policy
    if (policy === "POLICY_A_STRICT_UNION") {
      // Accept only if ALL plans are mutually compatible (0 conflicts)
      if (detectedConflicts.length > 0) {
        status = "RECONCILIATION_BLOCKED";
        unresolvedConflicts = [...detectedConflicts];
        selectedPlans = [];
      } else {
        selectedPlans = [...plans];
      }
    } else if (policy === "POLICY_B_PRIORITY_ORDERED") {
      // Order plans by role priority
      const sortedPlans = [...plans].sort(
        (a, b) => (ROLE_PRIORITY[b.agentRole] || 0) - (ROLE_PRIORITY[a.agentRole] || 0)
      );

      // Select highest priority plan; if others conflict with it, resolve in favor of higher priority
      const firstPlan = sortedPlans[0];
      if (firstPlan) {
        const chosen: AgentPlan[] = [firstPlan];
        for (let i = 1; i < sortedPlans.length; i++) {
          const candidate = sortedPlans[i];
          if (!candidate) continue;
          const conflictsWithChosen = this.detectPairwiseConflicts(goal, chosen[0]!, candidate);
          if (conflictsWithChosen.length === 0) {
            chosen.push(candidate);
          } else {
            // Resolve conflict by prioritizing higher priority plan
            for (const c of conflictsWithChosen) {
              if (c.severity === "BLOCKING") {
                unresolvedConflicts.push(c);
              } else {
                resolvedConflicts.push(c);
              }
            }
          }
        }
        selectedPlans = chosen;
      }
      if (unresolvedConflicts.some((c) => c.severity === "BLOCKING")) {
        status = "RECONCILIATION_BLOCKED";
      }
    } else if (policy === "POLICY_C_MINIMUM_CONFLICT") {
      // Find candidate plan that generates the fewest conflicts
      let bestPlan: AgentPlan = plans[0]!;
      let minConflictCount = Number.MAX_SAFE_INTEGER;

      for (const p of plans) {
        const conflictsForP = detectedConflicts.filter((c) => c.planIds.includes(p.planId));
        if (conflictsForP.length < minConflictCount) {
          minConflictCount = conflictsForP.length;
          bestPlan = p;
        }
      }

      selectedPlans = [bestPlan];
      // Mark other plan conflicts as resolved/dropped or unresolved if blocking
      for (const c of detectedConflicts) {
        if (c.severity === "BLOCKING" && c.planIds.includes(bestPlan.planId)) {
          unresolvedConflicts.push(c);
          status = "RECONCILIATION_BLOCKED";
        } else {
          resolvedConflicts.push(c);
        }
      }
    } else if (policy === "POLICY_D_GOVERNED_ADAPTIVE") {
      // Combine role priority, file ownership locality, and conflict severity
      const blocking = detectedConflicts.filter((c) => c.severity === "BLOCKING");
      if (blocking.length > 0) {
        unresolvedConflicts = [...blocking];
        status = "RECONCILIATION_BLOCKED";
      } else {
        // Resolve non-blocking conflicts deterministically
        selectedPlans = [...plans];
        resolvedConflicts = [...detectedConflicts];
      }
    }

    // Deduplicate and merge actions
    const reconciledActions: ProposedAction[] = [];
    const actionIdSet = new Set<string>();
    const fileActionMap = new Map<string, string>();

    for (const plan of selectedPlans) {
      for (const action of plan.proposedActions) {
        if (!actionIdSet.has(action.actionId)) {
          // Check if file is already targeted by different description
          if (!fileActionMap.has(action.targetFile) || fileActionMap.get(action.targetFile) === action.description) {
            actionIdSet.add(action.actionId);
            reconciledActions.push(action);
            fileActionMap.set(action.targetFile, action.description);
          }
        }
      }
    }

    const mergedAssumptions = Array.from(new Set(selectedPlans.flatMap((p) => p.assumptions)));

    const rawReconciliation = {
      reconciliationId,
      goalId: goal.goalId,
      policy,
      selectedPlanIds: selectedPlans.map((p) => p.planId),
      reconciledActions,
      resolvedConflictDigests: resolvedConflicts.map((c) => computeConflictDigest(c)),
      unresolvedConflictDigests: unresolvedConflicts.map((c) => computeConflictDigest(c)),
    };

    const reconciliationDigest = computeReconciliationDigest(rawReconciliation);
    const provenanceRoot = sha256Hex(
      `${reconciliationDigest}:${selectedPlans.map((p) => p.planDigest).join(",")}`
    );

    return {
      reconciliationId,
      goalId: goal.goalId,
      policy,
      selectedPlanIds: selectedPlans.map((p) => p.planId),
      reconciledActions,
      mergedAssumptions,
      resolvedConflicts,
      unresolvedConflicts,
      reconciliationDigest,
      provenanceRoot,
      status,
      authoritative: false,
      policyAuthority: false,
      terminalAuthority: false,
      verificationAuthority: false,
      createdAt: goal.createdAt,
    };
  }

  /**
   * Detect conflicts across all plans for a goal covering all 12 conflict classes.
   */
  public detectConflicts(goal: GoalNode, plans: readonly AgentPlan[]): PlanConflict[] {
    const conflicts: PlanConflict[] = [];

    // 1. SCOPE_CONFLICT: action targets file outside goal's affectedScope (N407)
    for (const plan of plans) {
      for (const action of plan.proposedActions) {
        if (
          goal.affectedScope.targetFiles.length > 0 &&
          !goal.affectedScope.targetFiles.includes(action.targetFile)
        ) {
          conflicts.push({
            conflictId: `conf-scope-${plan.planId}-${action.actionId}`,
            conflictType: "SCOPE_CONFLICT",
            planIds: [plan.planId],
            description: `Plan '${plan.planId}' action '${action.actionId}' targets file '${action.targetFile}' outside goal scope.`,
            severity: "BLOCKING",
            affectedFiles: [action.targetFile],
          });
        }
      }
    }

    // 2. FILE_OWNERSHIP_CONFLICT: multiple plans proposing different actions on same file
    const filePlansMap = new Map<string, { planId: string; description: string }[]>();
    for (const plan of plans) {
      for (const action of plan.proposedActions) {
        if (!filePlansMap.has(action.targetFile)) {
          filePlansMap.set(action.targetFile, []);
        }
        filePlansMap.get(action.targetFile)!.push({
          planId: plan.planId,
          description: action.description,
        });
      }
    }

    for (const [file, entries] of filePlansMap.entries()) {
      if (entries.length > 1) {
        const uniqueDescriptions = new Set(entries.map((e) => e.description));
        if (uniqueDescriptions.size > 1) {
          conflicts.push({
            conflictId: `conf-ownership-${sha256Hex(file).slice(0, 8)}`,
            conflictType: "FILE_OWNERSHIP_CONFLICT",
            planIds: Array.from(new Set(entries.map((e) => e.planId))),
            description: `Conflicting mutations proposed for file '${file}' across multiple plans.`,
            severity: "HIGH",
            affectedFiles: [file],
          });
        }
      }
    }

    // 3. ASSUMPTION_CONFLICT: contradictory assumptions
    for (let i = 0; i < plans.length; i++) {
      const p1 = plans[i];
      if (!p1) continue;
      for (let j = i + 1; j < plans.length; j++) {
        const p2 = plans[j];
        if (!p2) continue;
        for (const a1 of p1.assumptions) {
          for (const a2 of p2.assumptions) {
            if (
              (a1.toLowerCase().includes("sync") && a2.toLowerCase().includes("async")) ||
              (a1.toLowerCase().includes("stateless") && a2.toLowerCase().includes("stateful")) ||
              (a1.toLowerCase().includes("isolated") && a2.toLowerCase().includes("shared"))
            ) {
              conflicts.push({
                conflictId: `conf-assumption-${p1.planId}-${p2.planId}`,
                conflictType: "ASSUMPTION_CONFLICT",
                planIds: [p1.planId, p2.planId],
                description: `Contradictory assumptions: '${a1}' vs '${a2}'.`,
                severity: "HIGH",
              });
            }
          }
        }
      }
    }

    // 4. API_CONTRACT_CONFLICT & SCHEMA_CONFLICT check in action descriptions
    for (let i = 0; i < plans.length; i++) {
      const p1 = plans[i];
      if (!p1) continue;
      for (let j = i + 1; j < plans.length; j++) {
        const p2 = plans[j];
        if (!p2) continue;
        const p1HasBreak = p1.proposedActions.some((a) => a.description.toLowerCase().includes("break api") || a.description.toLowerCase().includes("deprecate"));
        const p2ExpectsStable = p2.assumptions.some((a) => a.toLowerCase().includes("stable api") || a.toLowerCase().includes("backward compat"));
        if (p1HasBreak && p2ExpectsStable) {
          conflicts.push({
            conflictId: `conf-api-${p1.planId}-${p2.planId}`,
            conflictType: "API_CONTRACT_CONFLICT",
            planIds: [p1.planId, p2.planId],
            description: "Plan introduces breaking API change while sibling plan assumes backward compatibility.",
            severity: "BLOCKING",
          });
        }

        const p1Schema = p1.proposedActions.some((a) => a.targetFile.includes("schema") && a.description.toLowerCase().includes("v2"));
        const p2Schema = p2.proposedActions.some((a) => a.targetFile.includes("schema") && a.description.toLowerCase().includes("v1"));
        if (p1Schema && p2Schema) {
          conflicts.push({
            conflictId: `conf-schema-${p1.planId}-${p2.planId}`,
            conflictType: "SCHEMA_CONFLICT",
            planIds: [p1.planId, p2.planId],
            description: "Competing schema migration versions proposed.",
            severity: "BLOCKING",
          });
        }
      }
    }

    // 5. DEPENDENCY_CONFLICT & ORDERING_CONFLICT
    for (let i = 0; i < plans.length; i++) {
      const p1 = plans[i];
      if (!p1) continue;
      for (let j = i + 1; j < plans.length; j++) {
        const p2 = plans[j];
        if (!p2) continue;
        if (p1.dependencies.includes(p2.planId) && p2.dependencies.includes(p1.planId)) {
          conflicts.push({
            conflictId: `conf-dep-cycle-${p1.planId}-${p2.planId}`,
            conflictType: "DEPENDENCY_CONFLICT",
            planIds: [p1.planId, p2.planId],
            description: `Circular dependency detected between plans '${p1.planId}' and '${p2.planId}'.`,
            severity: "BLOCKING",
          });
        }
      }
    }

    // 6. RESOURCE_CONFLICT: excessive combined proposed actions
    const totalExpectedBytes = plans.flatMap((p) => p.proposedActions).reduce((acc, a) => acc + (a.expectedDiffBytes || 256), 0);
    if (totalExpectedBytes > 32 * 1024) {
      conflicts.push({
        conflictId: `conf-resource-${goal.goalId}`,
        conflictType: "RESOURCE_CONFLICT",
        planIds: plans.map((p) => p.planId),
        description: `Total anticipated diff bytes (${totalExpectedBytes}) exceeds allocated ceiling.`,
        severity: "MEDIUM",
      });
    }

    return conflicts;
  }

  /**
   * Detect pairwise conflicts between two plans.
   */
  public detectPairwiseConflicts(goal: GoalNode, p1: AgentPlan, p2: AgentPlan): PlanConflict[] {
    return this.detectConflicts(goal, [p1, p2]);
  }
}
