/**
 * Deterministic Rule-Based Reflex Heuristics for Emerald Agent Fabric.
 *
 * Implements the ReflexPort interface using three pure, deterministic,
 * explainable, and configuration-addressable rules:
 *
 * 1. Failure Loop Rule (reflex.failure-loop.v1)
 *    Detects repeated failed attempts on identical tool + input combinations.
 * 2. Redundant Action Rule (reflex.redundant-action.v1)
 *    Detects repeated actions proposed without meaningful state or context change.
 * 3. Budget Pressure Rule (reflex.budget-pressure.v1)
 *    Detects when execution resource consumption approaches configured ceilings.
 *
 * Architectural Invariants:
 * 1. Monotonic Authority Reduction:
 *    EffectiveAuthorityAfterReflex ⊆ EffectiveAuthorityBeforeReflex.
 *    Reflex decisions (ALLOW, REJECT, DEFER) never expand authority or bypass policy.
 * 2. Absolute Determinism:
 *    Pure functions over (proposal, context, config). Zero randomness, zero timestamps,
 *    zero network calls, zero model calls, zero filesystem or Docker access.
 * 3. Strict Precedence:
 *    failure-loop -> redundant-action -> budget-pressure -> ALLOW.
 * 4. Zero State Mutation:
 *    Consumes immutable ReflexContext and outputs immutable ReflexDecision with structured evidence.
 */

import { computeCanonicalHash } from "../../domain/canonical-hash.js";
import type { ActionProposal } from "../../domain/action-proposal.js";
import {
  type ReflexContext,
  type ReflexDecision,
  type RuleBasedReflexConfig,
  DEFAULT_RULE_BASED_REFLEX_CONFIG,
  validateReflexContext,
  validateRuleBasedReflexConfig,
  computeRuleBasedReflexConfigHash,
} from "../../domain/reflex.js";
import type { ReflexPort } from "../../ports/reflex.port.js";

export class RuleBasedReflex implements ReflexPort {
  readonly name = "RuleBasedReflex";
  private readonly config: RuleBasedReflexConfig;
  private readonly configHash: string;

  constructor(config?: Partial<RuleBasedReflexConfig>) {
    this.config = validateRuleBasedReflexConfig({
      failureLoop: {
        ...DEFAULT_RULE_BASED_REFLEX_CONFIG.failureLoop,
        ...config?.failureLoop,
      },
      redundantAction: {
        ...DEFAULT_RULE_BASED_REFLEX_CONFIG.redundantAction,
        ...config?.redundantAction,
      },
      budgetPressure: {
        ...DEFAULT_RULE_BASED_REFLEX_CONFIG.budgetPressure,
        ...config?.budgetPressure,
      },
    });
    this.configHash = computeRuleBasedReflexConfigHash(this.config);
  }

  get activeConfig(): RuleBasedReflexConfig {
    return this.config;
  }

  get activeConfigHash(): string {
    return this.configHash;
  }

  async evaluate(
    proposal: ActionProposal,
    context: ReflexContext
  ): Promise<ReflexDecision> {
    // 0. Enforce contract validity on incoming context
    validateReflexContext(context);

    if (!proposal || typeof proposal !== "object" || !proposal.toolName || !proposal.inputPayload) {
      throw new Error("RuleBasedReflex evaluate requires a valid ActionProposal");
    }

    // Stable action input identity hash
    const inputHash = computeCanonicalHash(proposal.inputPayload).contentHash;
    const history = context.recentActionHistory ?? [];

    // ========================================================================
    // Priority 1: Failure Loop Rule (reflex.failure-loop.v1)
    // ========================================================================
    if (this.config.failureLoop.enabled) {
      let failureStreak = 0;

      for (let i = history.length - 1; i >= 0; i--) {
        const item = history[i]!;

        // A successful execution of the same action or an intervening modifying action
        // breaks the failure loop streak (state change prevents false loop)
        if (item.status === "SUCCEEDED") {
          break;
        }

        // If contextHash changed between this attempt and the proposal, environment state changed
        if (
          item.contextHash &&
          proposal.contextSnapshotHash &&
          item.contextHash !== proposal.contextSnapshotHash
        ) {
          break;
        }

        const sameTool = item.toolName === proposal.toolName;
        const sameInput = item.inputHash === undefined || item.inputHash === inputHash;

        if (sameTool && sameInput) {
          if (item.status === "FAILED" || item.status === "UNKNOWN" || item.status === "TIMED_OUT") {
            failureStreak++;
          }
        }
      }

      if (failureStreak >= this.config.failureLoop.maxRepeatedFailures) {
        const decisionKind = this.config.failureLoop.decisionOnTrigger ?? "REJECT";
        return Object.freeze({
          decision: decisionKind,
          reasonCode: "REPEATED_FAILURE",
          ruleId: "reflex.failure-loop.v1",
          observedCount: failureStreak,
          threshold: this.config.failureLoop.maxRepeatedFailures,
          rationale: `Repeated failure loop detected: tool '${proposal.toolName}' with identical input failed ${failureStreak} consecutive times (threshold: ${this.config.failureLoop.maxRepeatedFailures})`,
          evidence: Object.freeze({
            ruleId: "reflex.failure-loop.v1",
            reasonCode: "REPEATED_FAILURE",
            observedCount: failureStreak,
            threshold: this.config.failureLoop.maxRepeatedFailures,
            signal: `tool=${proposal.toolName}, inputHash=${inputHash.slice(0, 16)}`,
          }),
        });
      }
    }

    // ========================================================================
    // Priority 2: Redundant Action Rule (reflex.redundant-action.v1)
    // ========================================================================
    if (this.config.redundantAction.enabled) {
      let repetitionCount = 0;

      for (let i = history.length - 1; i >= 0; i--) {
        const item = history[i]!;

        // State-aware boundary check:
        // An intervening successful mutating action (write_file, run_command) changes state.
        // Therefore, repeating read_file after write_file is NOT redundant.
        const isModifyingTool =
          item.toolName === "write_file" || item.toolName === "run_command";

        if (
          isModifyingTool &&
          item.status === "SUCCEEDED" &&
          (item.toolName !== proposal.toolName || item.inputHash !== inputHash)
        ) {
          break;
        }

        // Context hash change indicates workspace/environment state modified
        if (
          item.contextHash &&
          proposal.contextSnapshotHash &&
          item.contextHash !== proposal.contextSnapshotHash
        ) {
          break;
        }

        const sameTool = item.toolName === proposal.toolName;
        const sameInput = item.inputHash === undefined || item.inputHash === inputHash;

        if (sameTool && sameInput) {
          repetitionCount++;
        }
      }

      if (repetitionCount >= this.config.redundantAction.maxRepeatedActions) {
        const decisionKind = this.config.redundantAction.decisionOnTrigger ?? "REJECT";
        return Object.freeze({
          decision: decisionKind,
          reasonCode: "REDUNDANT_ACTION",
          ruleId: "reflex.redundant-action.v1",
          observedCount: repetitionCount,
          threshold: this.config.redundantAction.maxRepeatedActions,
          rationale: `Redundant action detected: tool '${proposal.toolName}' with identical input executed ${repetitionCount} times under unchanged state (threshold: ${this.config.redundantAction.maxRepeatedActions})`,
          evidence: Object.freeze({
            ruleId: "reflex.redundant-action.v1",
            reasonCode: "REDUNDANT_ACTION",
            observedCount: repetitionCount,
            threshold: this.config.redundantAction.maxRepeatedActions,
            signal: `tool=${proposal.toolName}, inputHash=${inputHash.slice(0, 16)}`,
          }),
        });
      }
    }

    // ========================================================================
    // Priority 3: Budget Pressure Rule (reflex.budget-pressure.v1)
    // ========================================================================
    if (this.config.budgetPressure.enabled) {
      const pressureThreshold = this.config.budgetPressure.pressureThreshold;
      let triggered = false;
      let maxObservedRatio = 0;
      let pressureSignal = "";

      // 1. Steps budget pressure
      if (this.config.budgetPressure.maxSteps && this.config.budgetPressure.maxSteps > 0) {
        const currentSteps = context.resourceUsage?.stepsExecuted ?? context.stepNumber;
        const stepRatio = currentSteps / this.config.budgetPressure.maxSteps;
        if (stepRatio >= pressureThreshold) {
          triggered = true;
          if (stepRatio > maxObservedRatio) {
            maxObservedRatio = stepRatio;
            pressureSignal = `steps: ${currentSteps}/${this.config.budgetPressure.maxSteps} (${(stepRatio * 100).toFixed(1)}%)`;
          }
        }
      }

      // 2. Actions budget pressure
      if (this.config.budgetPressure.maxActions && this.config.budgetPressure.maxActions > 0) {
        const currentActions = context.resourceUsage?.actionsExecuted ?? 0;
        const actionRatio = currentActions / this.config.budgetPressure.maxActions;
        if (actionRatio >= pressureThreshold) {
          triggered = true;
          if (actionRatio > maxObservedRatio) {
            maxObservedRatio = actionRatio;
            pressureSignal = `actions: ${currentActions}/${this.config.budgetPressure.maxActions} (${(actionRatio * 100).toFixed(1)}%)`;
          }
        }
      }

      // 3. Wall clock budget pressure
      if (
        this.config.budgetPressure.maxWallClockMs &&
        this.config.budgetPressure.maxWallClockMs > 0
      ) {
        const elapsedMs = context.resourceUsage?.elapsedWallClockMs ?? 0;
        const clockRatio = elapsedMs / this.config.budgetPressure.maxWallClockMs;
        if (clockRatio >= pressureThreshold) {
          triggered = true;
          if (clockRatio > maxObservedRatio) {
            maxObservedRatio = clockRatio;
            pressureSignal = `wallClockMs: ${elapsedMs}/${this.config.budgetPressure.maxWallClockMs} (${(clockRatio * 100).toFixed(1)}%)`;
          }
        }
      }

      // 4. Model call budget pressure
      if (
        this.config.budgetPressure.maxModelCalls &&
        this.config.budgetPressure.maxModelCalls > 0
      ) {
        const modelCalls = context.resourceUsage?.modelCallsExecuted ?? 0;
        const modelRatio = modelCalls / this.config.budgetPressure.maxModelCalls;
        if (modelRatio >= pressureThreshold) {
          triggered = true;
          if (modelRatio > maxObservedRatio) {
            maxObservedRatio = modelRatio;
            pressureSignal = `modelCalls: ${modelCalls}/${this.config.budgetPressure.maxModelCalls} (${(modelRatio * 100).toFixed(1)}%)`;
          }
        }
      }

      if (triggered) {
        const decisionKind = this.config.budgetPressure.decisionOnTrigger ?? "DEFER";
        return Object.freeze({
          decision: decisionKind,
          reasonCode: "RESOURCE_PRESSURE",
          ruleId: "reflex.budget-pressure.v1",
          observedCount: maxObservedRatio,
          threshold: pressureThreshold,
          rationale: `Resource budget pressure threshold reached: ${pressureSignal} >= threshold ${(pressureThreshold * 100).toFixed(1)}%`,
          evidence: Object.freeze({
            ruleId: "reflex.budget-pressure.v1",
            reasonCode: "RESOURCE_PRESSURE",
            observedCount: maxObservedRatio,
            threshold: pressureThreshold,
            signal: pressureSignal,
          }),
        });
      }
    }

    // ========================================================================
    // Priority 4: Default ALLOW (NO_INTERVENTION)
    // ========================================================================
    return Object.freeze({
      decision: "ALLOW",
      reasonCode: "NO_INTERVENTION",
      rationale: "No intervention required",
    });
  }
}
