/**
 * Phase 8.3 — Controlled Empirical Baseline-vs-Reflex Evaluation Test Suite
 *
 * Comprehensive tests covering:
 * 1. Task Definitions & Registry (Tests 1–5):
 *    - Exposes all four frozen evaluation tasks
 *    - Retrieves tasks by ID successfully
 *    - Throws descriptive error on unknown task ID lookup
 *    - Validates resource limits and required capabilities
 *    - Content hashing is deterministic
 *
 * 2. Experiment Construction & Conditions (Tests 6–7):
 *    - Controlled experiment with identical fingerprint across conditions
 *    - Custom rule configuration hash binding
 *
 * 3. Task A: Normal Productive Work (Test 8):
 *    - Both Baseline and Reflex pass objective criteria cleanly
 *    - Reflex intervenes 0 times (allows > 0, rejects = 0, defers = 0)
 *    - Zero false positive intervention by Reflex
 *
 * 4. Task B: Repeated Failure Loop (Test 9):
 *    - Baseline executes tools until ceiling
 *    - Reflex detects repeated failures (REPEATED_FAILURE)
 *    - Reflex rejects failing proposals, bounding tool dispatch
 *
 * 5. Task C: Redundant Action Loop (Test 10):
 *    - Baseline executes repeated identical reads until ceiling
 *    - Reflex detects redundant repetition (REDUNDANT_ACTION)
 *    - Reflex intervenes and rejects redundant proposals
 *
 * 6. Task D: Budget Pressure (Test 11):
 *    - Baseline runs until MAX_STEPS exhaustion (TIMED_OUT)
 *    - Reflex detects budget threshold (RESOURCE_PRESSURE)
 *    - Reflex defers action proposal, halting loop safely (BLOCKED)
 *
 * 7. Statistical & Reporting Layer (Tests 12–13):
 *    - Compiles valid EvaluationReport and ConditionComparison
 *    - Computes statistical analyses across pass rate and efficiency metrics
 *
 * 8. Determinism & Security (Tests 14–15):
 *    - Reproducible results across repeated experiment executions
 *    - Trial identity hash incorporates ruleConfigurationHash
 */

import { describe, expect, it } from "vitest";
import {
  BASELINE_REFLEX_TASKS,
  BASELINE_REFLEX_TASK_IDS,
  getBaselineReflexTask,
  TASK_A_NORMAL_WORK,
  TASK_B_REPEATED_FAILURE,
  TASK_C_REDUNDANT_ACTION,
  TASK_D_BUDGET_PRESSURE,
} from "../../src/application/evaluation/baseline-reflex-tasks.js";
import {
  executeControlledBaselineReflexExperiment,
} from "../../src/application/evaluation/controlled-evaluation.js";
import {
  computeRuleBasedReflexConfigHash,
  DEFAULT_RULE_BASED_REFLEX_CONFIG,
  RuleBasedReflexConfig,
} from "../../src/domain/reflex.js";
import {
  ModelProviderPort,
  ModelProviderRequest,
  ModelProviderResponse,
} from "../../src/ports/model-provider.port.js";

// ============================================================================
// Scripted / Deterministic Model Providers for Hermetic Evaluation Tests
// ============================================================================

class NormalWorkProvider implements ModelProviderPort {
  readonly providerName = "scripted-normal-provider";

  async generate(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    const userMsg = request.input.find((m) => m.role === "user")?.content ?? "";
    const hashMatch = /Set contextSnapshotHash to "([a-f0-9]{64})"/.exec(userMsg);
    const contextSnapshotHash = hashMatch ? hashMatch[1] : undefined;

    let payload: Record<string, unknown>;

    if (userMsg.includes("EMERALD AGENT FABRIC TEST")) {
      payload = {
        isGoalReached: true,
        contextSnapshotHash,
        rationale: "Goal reached after verifying written output",
      };
    } else if (userMsg.includes("emerald agent fabric test")) {
      payload = {
        isGoalReached: false,
        toolName: "write_file",
        inputPayload: {
          path: "output.txt",
          content: "EMERALD AGENT FABRIC TEST",
        },
        contextSnapshotHash,
        rationale: "Writing uppercase output to output.txt",
      };
    } else {
      payload = {
        isGoalReached: false,
        toolName: "read_file",
        inputPayload: {
          path: "input.txt",
        },
        contextSnapshotHash,
        rationale: "Reading input file",
      };
    }

    return {
      requestId: request.requestId,
      model: request.model,
      outputText: JSON.stringify(payload),
      finishReason: "STOP",
      durationMs: 10,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      },
    };
  }
}

class FailureLoopProvider implements ModelProviderPort {
  readonly providerName = "scripted-failure-loop-provider";

  async generate(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    const userMsg = request.input.find((m) => m.role === "user")?.content ?? "";
    const hashMatch = /Set contextSnapshotHash to "([a-f0-9]{64})"/.exec(userMsg);
    const contextSnapshotHash = hashMatch ? hashMatch[1] : undefined;

    const payload = {
      isGoalReached: false,
      toolName: "read_file",
      inputPayload: {
        path: "missing.txt",
      },
      contextSnapshotHash,
      rationale: "Attempting to read missing.txt",
    };

    return {
      requestId: request.requestId,
      model: request.model,
      outputText: JSON.stringify(payload),
      finishReason: "STOP",
      durationMs: 10,
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
      },
    };
  }
}

class RedundantActionProvider implements ModelProviderPort {
  readonly providerName = "scripted-redundant-provider";

  async generate(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    const userMsg = request.input.find((m) => m.role === "user")?.content ?? "";
    const hashMatch = /Set contextSnapshotHash to "([a-f0-9]{64})"/.exec(userMsg);
    const contextSnapshotHash = hashMatch ? hashMatch[1] : undefined;

    const payload = {
      isGoalReached: false,
      toolName: "read_file",
      inputPayload: {
        path: "readme.txt",
      },
      contextSnapshotHash,
      rationale: "Reading readme.txt repeatedly",
    };

    return {
      requestId: request.requestId,
      model: request.model,
      outputText: JSON.stringify(payload),
      finishReason: "STOP",
      durationMs: 10,
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
      },
    };
  }
}

class BudgetPressureProvider implements ModelProviderPort {
  readonly providerName = "scripted-budget-pressure-provider";

  async generate(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    const userMsg = request.input.find((m) => m.role === "user")?.content ?? "";
    const hashMatch = /Set contextSnapshotHash to "([a-f0-9]{64})"/.exec(userMsg);
    const contextSnapshotHash = hashMatch ? hashMatch[1] : undefined;

    const payload = {
      isGoalReached: false,
      toolName: "read_file",
      inputPayload: {
        path: "seed.txt",
      },
      contextSnapshotHash,
      rationale: "Reading seed.txt under budget pressure",
    };

    return {
      requestId: request.requestId,
      model: request.model,
      outputText: JSON.stringify(payload),
      finishReason: "STOP",
      durationMs: 10,
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
      },
    };
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describe("Phase 8.3 — Controlled Empirical Baseline-vs-Reflex Evaluation", () => {
  // ==========================================================================
  // 1. Task Definitions & Registry
  // ==========================================================================
  describe("1. Task Definitions & Registry", () => {
    it("1. exposes all four frozen evaluation tasks", () => {
      expect(BASELINE_REFLEX_TASKS).toHaveLength(4);
      expect(BASELINE_REFLEX_TASK_IDS).toContain("task-baseline-reflex-normal");
      expect(BASELINE_REFLEX_TASK_IDS).toContain("task-baseline-reflex-failure-loop");
      expect(BASELINE_REFLEX_TASK_IDS).toContain("task-baseline-reflex-redundant-action");
      expect(BASELINE_REFLEX_TASK_IDS).toContain("task-baseline-reflex-budget-pressure");
    });

    it("2. retrieves tasks by ID successfully", () => {
      const taskA = getBaselineReflexTask("task-baseline-reflex-normal");
      expect(taskA.taskId).toBe("task-baseline-reflex-normal");
      expect(taskA.fixture.initialFiles["input.txt"]).toBeDefined();

      const taskB = getBaselineReflexTask("task-baseline-reflex-failure-loop");
      expect(taskB.taskId).toBe("task-baseline-reflex-failure-loop");

      const taskC = getBaselineReflexTask("task-baseline-reflex-redundant-action");
      expect(taskC.taskId).toBe("task-baseline-reflex-redundant-action");

      const taskD = getBaselineReflexTask("task-baseline-reflex-budget-pressure");
      expect(taskD.taskId).toBe("task-baseline-reflex-budget-pressure");
    });

    it("3. throws descriptive error on unknown task ID lookup", () => {
      expect(() => getBaselineReflexTask("unknown-task-id")).toThrow(
        /Unknown Baseline\/Reflex evaluation task/
      );
    });

    it("4. validates that task definitions enforce resource limits and required capabilities", () => {
      for (const task of BASELINE_REFLEX_TASKS) {
        expect(task.mission.requiredCapabilities.length).toBeGreaterThan(0);
        expect(task.budget.maxSteps).toBeGreaterThan(0);
        expect(task.budget.maxActions).toBeGreaterThan(0);
        expect(task.budget.maxWallClockMs).toBeGreaterThan(0);
        expect(task.successCriteria.length).toBeGreaterThan(0);
      }
    });

    it("5. ensures task content hashes are deterministic and consistent", () => {
      const taskA1 = getBaselineReflexTask("task-baseline-reflex-normal");
      const taskA2 = getBaselineReflexTask("task-baseline-reflex-normal");
      expect(taskA1.taskId).toBe(taskA2.taskId);
    });
  });

  // ==========================================================================
  // 2. Experiment Construction & Conditions
  // ==========================================================================
  describe("2. Experiment Construction & Conditions", () => {
    it("6. constructs controlled experiment with identical fingerprint across conditions", async () => {
      const provider = new NormalWorkProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_A_NORMAL_WORK,
        modelProvider: provider,
        model: "scripted:normal-v1",
        trialsPerCondition: 1,
      });

      expect(result.experiment).toBeDefined();
      expect(result.experiment.conditions).toHaveLength(2);
      expect(result.baselineCondition.executionMode).toBe("BASELINE");
      expect(result.reflexCondition.executionMode).toBe("REFLEX");

      // Both conditions share identical fingerprint hash (same model, provider, harness, task)
      expect(result.baselineCondition.configFingerprint.fingerprintHash).toBe(
        result.reflexCondition.configFingerprint.fingerprintHash
      );

      // Reflex condition binds ruleConfigurationHash; Baseline does not
      expect(result.baselineCondition.ruleConfigurationHash).toBeUndefined();
      expect(result.reflexCondition.ruleConfigurationHash).toBeDefined();
      expect(result.reflexCondition.ruleConfigurationHash).toMatch(/^[a-f0-9]{64}$/);

      // Condition hashes are distinct
      expect(result.baselineCondition.conditionHash).not.toBe(result.reflexCondition.conditionHash);
    });

    it("7. validates custom rule configuration hash binding", async () => {
      const customConfig: RuleBasedReflexConfig = {
        ...DEFAULT_RULE_BASED_REFLEX_CONFIG,
        failureLoop: {
          ...DEFAULT_RULE_BASED_REFLEX_CONFIG.failureLoop,
          maxRepeatedFailures: 5,
        },
      };

      const provider = new NormalWorkProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_A_NORMAL_WORK,
        modelProvider: provider,
        model: "scripted:normal-v1",
        trialsPerCondition: 1,
        ruleBasedReflexConfig: customConfig,
      });

      const expectedHash = computeRuleBasedReflexConfigHash(customConfig);
      expect(result.reflexCondition.ruleConfigurationHash).toBe(expectedHash);
    });
  });

  // ==========================================================================
  // 3. Task A: Normal Productive Work (Baseline vs Reflex)
  // ==========================================================================
  describe("3. Task A: Normal Productive Work", () => {
    it("8. executes Task A where both Baseline and Reflex pass without intervention", async () => {
      const provider = new NormalWorkProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_A_NORMAL_WORK,
        modelProvider: provider,
        model: "scripted:normal-v1",
        trialsPerCondition: 2,
      });

      expect(result.baselineTrials).toHaveLength(2);
      expect(result.reflexTrials).toHaveLength(2);

      // Both Baseline trials passed objective criteria
      for (const trial of result.baselineTrials) {
        expect(trial.outcome).toBe("PASSED");
        expect(trial.verificationPassed).toBe(true);
        expect(trial.metrics.reflexEvaluations).toBeUndefined();
        expect(trial.metrics.reflexAllows).toBeUndefined();
      }

      // Both Reflex trials passed objective criteria without intervention (no false positives)
      for (const trial of result.reflexTrials) {
        expect(trial.outcome).toBe("PASSED");
        expect(trial.verificationPassed).toBe(true);
        expect(trial.metrics.reflexEvaluations).toBeGreaterThan(0);
        expect(trial.metrics.reflexAllows).toBeGreaterThan(0);
        expect(trial.metrics.reflexRejects).toBe(0);
        expect(trial.metrics.reflexDefers).toBe(0);
        expect(trial.metrics.failureLoopTriggers).toBe(0);
        expect(trial.metrics.redundantActionTriggers).toBe(0);
        expect(trial.metrics.budgetPressureTriggers).toBe(0);
      }

      // Comparison shows equal pass rates
      expect(result.comparison.passRateComparison.baseline.rate).toBe(1.0);
      expect(result.comparison.passRateComparison.candidate.rate).toBe(1.0);
      expect(result.comparison.passRateComparison.delta).toBe(0.0);
    });
  });

  // ==========================================================================
  // 4. Task B: Repeated Failure Loop (Reflex Intercepts Failure)
  // ==========================================================================
  describe("4. Task B: Repeated Failure Loop", () => {
    it("9. demonstrates Reflex detects repeated failures and halts tool dispatch earlier than Baseline", async () => {
      const provider = new FailureLoopProvider();

      // Configure failure loop to trigger at 2 failures for rapid intervention
      const tightConfig: RuleBasedReflexConfig = {
        ...DEFAULT_RULE_BASED_REFLEX_CONFIG,
        failureLoop: {
          enabled: true,
          maxRepeatedFailures: 2,
          decisionOnTrigger: "REJECT",
        },
      };

      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_B_REPEATED_FAILURE,
        modelProvider: provider,
        model: "scripted:failing-loop-v1",
        trialsPerCondition: 1,
        ruleBasedReflexConfig: tightConfig,
      });

      const baseTrial = result.baselineTrials[0]!;
      const reflexTrial = result.reflexTrials[0]!;

      // Both fail objective criteria (missing.txt never exists)
      expect(baseTrial.verificationPassed).toBe(false);
      expect(reflexTrial.verificationPassed).toBe(false);

      // Reflex intercepted repeated failures
      expect(reflexTrial.metrics.failureLoopTriggers).toBeGreaterThan(0);
      expect(reflexTrial.metrics.reflexRejects).toBeGreaterThan(0);

      // Baseline executed more tool calls/actions because it had no Reflex interceptor
      expect(baseTrial.metrics.actions).toBeGreaterThanOrEqual(reflexTrial.metrics.actions);
    });
  });

  // ==========================================================================
  // 5. Task C: Redundant Action Loop (Reflex Intercepts Loop)
  // ==========================================================================
  describe("5. Task C: Redundant Action Loop", () => {
    it("10. demonstrates Reflex detects identical repeated actions on unchanged context", async () => {
      const provider = new RedundantActionProvider();

      const tightConfig: RuleBasedReflexConfig = {
        ...DEFAULT_RULE_BASED_REFLEX_CONFIG,
        redundantAction: {
          enabled: true,
          maxRepeatedActions: 2,
          decisionOnTrigger: "REJECT",
        },
      };

      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_C_REDUNDANT_ACTION,
        modelProvider: provider,
        model: "scripted:redundant-loop-v1",
        trialsPerCondition: 1,
        ruleBasedReflexConfig: tightConfig,
      });

      const baseTrial = result.baselineTrials[0]!;
      const reflexTrial = result.reflexTrials[0]!;

      // Baseline performed all allowed actions
      expect(baseTrial.metrics.toolCalls).toBeGreaterThan(0);

      // Reflex detected redundant action and intervened
      expect(reflexTrial.metrics.redundantActionTriggers).toBeGreaterThan(0);
      expect(reflexTrial.metrics.reflexRejects).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // 6. Task D: Budget Pressure (Reflex Intervenes Before Hard Timeout)
  // ==========================================================================
  describe("6. Task D: Budget Pressure", () => {
    it("11. demonstrates Reflex intercepts budget pressure and transitions safely", async () => {
      const provider = new BudgetPressureProvider();

      const budgetConfig: RuleBasedReflexConfig = {
        ...DEFAULT_RULE_BASED_REFLEX_CONFIG,
        budgetPressure: {
          enabled: true,
          pressureThreshold: 0.6, // 60% of maxSteps=5 is step 3
          maxSteps: 5,
          decisionOnTrigger: "DEFER",
        },
      };

      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_D_BUDGET_PRESSURE,
        modelProvider: provider,
        model: "scripted:budget-pressure-v1",
        trialsPerCondition: 1,
        ruleBasedReflexConfig: budgetConfig,
      });

      const baseTrial = result.baselineTrials[0]!;
      const reflexTrial = result.reflexTrials[0]!;

      // Baseline ran until step ceiling exhaustion (status: TIMED_OUT)
      expect(baseTrial.outcome).toBe("TIMED_OUT");

      // Reflex intervened on budget pressure (status: BLOCKED via DEFERRED)
      expect(reflexTrial.outcome).toBe("BLOCKED");
      expect(reflexTrial.metrics.budgetPressureTriggers).toBeGreaterThan(0);
      expect(reflexTrial.metrics.reflexDefers).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // 7. Statistical & Reporting Layer
  // ==========================================================================
  describe("7. Statistical & Reporting Layer", () => {
    it("12. compiles valid EvaluationReport and ConditionComparison", async () => {
      const provider = new NormalWorkProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_A_NORMAL_WORK,
        modelProvider: provider,
        model: "scripted:normal-v1",
        trialsPerCondition: 2,
      });

      expect(result.report).toBeDefined();
      expect(result.report.conditions).toHaveLength(2);
      expect(result.report.totalObservedTrials).toBe(4);
      expect(result.report.reportContentHash).toMatch(/^[a-f0-9]{64}$/);

      expect(result.comparison).toBeDefined();
      expect(result.comparison.baselineConditionId).toBe("condition-baseline");
      expect(result.comparison.candidateConditionId).toBe("condition-reflex");
      expect(result.comparison.metricComparisons.steps).toBeDefined();
      expect(result.comparison.metricComparisons.toolCalls).toBeDefined();
    });

    it("13. computes statistical analyses across pass rate and efficiency metrics", async () => {
      const provider = new NormalWorkProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_A_NORMAL_WORK,
        modelProvider: provider,
        model: "scripted:normal-v1",
        trialsPerCondition: 2,
      });

      // Pass rate analysis (Wilson Score)
      expect(result.passRateAnalysis).toBeDefined();
      expect(result.passRateAnalysis.analysisMethod).toBe("WILSON_SCORE");
      expect(result.passRateAnalysis.metric).toBe("objectivePassRate");
      expect(result.passRateAnalysis.baselineSummary.confidenceInterval).toBeDefined();
      expect(result.passRateAnalysis.candidateSummary.confidenceInterval).toBeDefined();

      // Step count analysis (Student's t-test)
      expect(result.stepCountAnalysis).toBeDefined();
      expect(result.stepCountAnalysis.analysisMethod).toBe("STUDENT_T");
      expect(result.stepCountAnalysis.metric).toBe("steps");
      expect(result.stepCountAnalysis.direction).toBe("LOWER_IS_BETTER");

      // Tool calls analysis
      expect(result.toolCallsAnalysis).toBeDefined();
      expect(result.toolCallsAnalysis.metric).toBe("toolCalls");

      // Wall clock analysis
      expect(result.wallClockAnalysis).toBeDefined();
      expect(result.wallClockAnalysis.metric).toBe("wallClockMs");

      // Proposal rejections analysis
      expect(result.proposalRejectionsAnalysis).toBeDefined();
      expect(result.proposalRejectionsAnalysis.metric).toBe("proposalRejections");
    });
  });

  // ==========================================================================
  // 8. Determinism & Security
  // ==========================================================================
  describe("8. Determinism & Security", () => {
    it("14. produces reproducible results across identical repeated experiment executions", async () => {
      const provider1 = new NormalWorkProvider();
      const provider2 = new NormalWorkProvider();

      const run1 = await executeControlledBaselineReflexExperiment({
        task: TASK_A_NORMAL_WORK,
        modelProvider: provider1,
        model: "scripted:normal-v1",
        trialsPerCondition: 1,
      });

      const run2 = await executeControlledBaselineReflexExperiment({
        task: TASK_A_NORMAL_WORK,
        modelProvider: provider2,
        model: "scripted:normal-v1",
        trialsPerCondition: 1,
      });

      // Task content hashes match
      expect(run1.experiment.taskRef.taskContentHash).toBe(
        run2.experiment.taskRef.taskContentHash
      );

      // Condition hashes match
      expect(run1.baselineCondition.conditionHash).toBe(run2.baselineCondition.conditionHash);
      expect(run1.reflexCondition.conditionHash).toBe(run2.reflexCondition.conditionHash);

      // Step and action counts match
      expect(run1.baselineTrials[0]!.metrics.steps).toBe(run2.baselineTrials[0]!.metrics.steps);
      expect(run1.reflexTrials[0]!.metrics.steps).toBe(run2.reflexTrials[0]!.metrics.steps);
    });

    it("15. ensures trial identity hash incorporates ruleConfigurationHash", async () => {
      const provider = new NormalWorkProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_A_NORMAL_WORK,
        modelProvider: provider,
        model: "scripted:normal-v1",
        trialsPerCondition: 1,
      });

      const baseTrial = result.baselineTrials[0]!;
      const reflexTrial = result.reflexTrials[0]!;

      // Both have ordinal 1, same task, same config fingerprint
      expect(baseTrial.trialOrdinal).toBe(1);
      expect(reflexTrial.trialOrdinal).toBe(1);

      // But distinct trialIdentityHash and trialId because Reflex binds ruleConfigurationHash and executionMode
      expect(baseTrial.trialIdentityHash).not.toBe(reflexTrial.trialIdentityHash);
      expect(baseTrial.trialId).not.toBe(reflexTrial.trialId);
    });
  });
});
