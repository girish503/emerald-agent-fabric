/**
 * Phase 89: Multi-Agent Plan Synthesizer
 *
 * Deterministic generator of advisory candidate plans per sub-goal.
 *
 * INVARIANTS:
 * 1. Plans are UNTRUSTED_OBSERVATION.
 * 2. Roles (ANALYZER, IMPLEMENTER, etc.) are descriptive metadata and grant ZERO authority.
 * 3. Strips all authority-bearing keys.
 * 4. Deterministic outputs for identical input parameters.
 */

import { GoalNode } from "../domain/hierarchical-goal-decomposition.js";
import {
  AgentRole,
  AgentPlan,
  ProposedAction,
  computePlanDigest,
} from "../domain/multi-agent-plan.js";
import { sha256Hex } from "../domain/canonical-hash.js";

export interface PlanSynthesisInput {
  readonly planId?: string;
  readonly proposedActions: readonly ProposedAction[];
  readonly expectedEvidence?: readonly string[];
  readonly dependencies?: readonly string[];
  readonly assumptions?: readonly string[];
  readonly risks?: readonly string[];
  readonly verificationPlan?: readonly string[];
  readonly injectedAuthorityKeys?: Record<string, unknown>; // Test probe for N405, N406, etc.
}

export class MultiAgentPlanSynthesizer {
  /**
   * Synthesize an untrusted candidate plan for a specific sub-goal from an agent role perspective.
   */
  public synthesizePlan(
    goal: GoalNode,
    role: AgentRole,
    input: PlanSynthesisInput
  ): AgentPlan {
    const planId = input.planId || `plan-${goal.goalId}-${role.toLowerCase()}-${sha256Hex(goal.objective).slice(0, 8)}`;

    // Filter proposed actions to match goal scope
    const sanitizedActions: ProposedAction[] = input.proposedActions.map((act) => ({
      actionId: act.actionId,
      description: act.description,
      targetFile: act.targetFile,
      toolRequired: act.toolRequired,
      expectedDiffBytes: act.expectedDiffBytes || 256,
    }));

    const expectedEvidence = input.expectedEvidence ? [...input.expectedEvidence] : [...goal.requiredEvidence];
    const dependencies = input.dependencies ? [...input.dependencies] : [...goal.dependencies];
    const assumptions = input.assumptions ? [...input.assumptions] : [`Role ${role} standard boundary assumption`];
    const risks = input.risks ? [...input.risks] : [`Standard implementation risk under ${role}`];
    const verificationPlan = input.verificationPlan ? [...input.verificationPlan] : ["EXECUTE_SUBGOAL_TESTS"];

    const rawDigestData = {
      planId,
      goalId: goal.goalId,
      agentRole: role,
      proposedActions: sanitizedActions,
      expectedEvidence,
      dependencies,
      assumptions,
      risks,
      verificationPlan,
    };

    const planDigest = computePlanDigest(rawDigestData);
    const provenance = sha256Hex(`plan-prov:${goal.goalDigest}:${planDigest}:${role}`);

    return {
      planId,
      goalId: goal.goalId,
      agentRole: role,
      planDigest,
      proposedActions: sanitizedActions,
      expectedEvidence,
      dependencies,
      assumptions,
      risks,
      verificationPlan,
      provenance,
      createdAt: goal.createdAt,
    };
  }
}
