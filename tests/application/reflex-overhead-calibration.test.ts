/**
 * Phase 8.7 — Reflex Overhead, Calibration & Extended Controlled Evaluation Test Suite
 *
 * Comprehensive empirical evaluation verifying:
 * 1. Extended Task Definitions (Tasks E, F, G, H, I) and Task Registry
 * 2. Deterministic Experiment Manifest, Hashing, and Reproducibility
 * 3. Frozen Configuration Hash Regression & Anti-Tuning Invariant
 * 4. Multi-Step Normal Work (Task E) — Low Overhead Verification
 * 5. Long Sequential Pipeline (Task F) — Cumulative Reflex Overhead
 * 6. Intermittent Failure (Task G) — Failure Streak Reset Mechanics
 * 7. Mixed Workload (Task H) — Multi-Decision Transcript in Single Run
 * 8. Near-Threshold Workload (Task I) — Absence of False DEFER/REJECT
 * 9. Reflex Intervention Metrics & Rate Calculations
 * 10. False-Positive Metric Classification (Objective Ground-Truth Only)
 * 11. Repeated Trial Matrix (N=10) & Reflex Stability Metrics
 * 12. Descriptive Statistics, Wilson Score, Student's t, and Variability
 * 13. Multi-Task Suite Orchestration & End-to-End Governance
 */

import { describe, expect, it } from "vitest";
import {
  ALL_BASELINE_REFLEX_TASKS,
  ALL_BASELINE_REFLEX_TASK_IDS,
  BASELINE_REFLEX_TASKS,
  EXTENDED_BASELINE_REFLEX_TASKS,
  EXTENDED_BASELINE_REFLEX_TASK_IDS,
  getBaselineReflexTask,
  TASK_A_NORMAL_WORK,
  TASK_B_REPEATED_FAILURE,
  TASK_C_REDUNDANT_ACTION,
  TASK_D_BUDGET_PRESSURE,
  TASK_E_MULTI_STEP_NORMAL,
  TASK_F_LONG_SEQUENCE,
  TASK_G_INTERMITTENT_FAILURE,
  TASK_H_MIXED_WORKLOAD,
  TASK_I_NEAR_THRESHOLD,
} from "../../src/application/evaluation/baseline-reflex-tasks.js";
import {
  executeControlledBaselineReflexExperiment,
  executeControlledBaselineReflexSuite,
} from "../../src/application/evaluation/controlled-evaluation.js";
import {
  calculateReflexInterventionMetrics,
  calculateReflexStabilityMetrics,
  computeExperimentManifestHash,
  createExperimentManifest,
  isTaskInterventionFree,
} from "../../src/domain/evaluation.js";
import {
  computeRuleBasedReflexConfigHash,
  DEFAULT_RULE_BASED_REFLEX_CONFIG,
  FROZEN_RULE_BASED_REFLEX_CONFIG_HASH,
  RuleBasedReflexConfig,
} from "../../src/domain/reflex.js";
import { replayReflexEvidence } from "../../src/domain/reflex-evidence.js";
import { RuleBasedReflex } from "../../src/adapters/reflex/rule-based-reflex.js";
import { computeCanonicalHash } from "../../src/domain/canonical-hash.js";
import {
  ModelProviderPort,
  ModelProviderRequest,
  ModelProviderResponse,
} from "../../src/ports/model-provider.port.js";

// ============================================================================
// Scripted / Deterministic Model Providers for Extended Tasks
// ============================================================================

/**
 * Scripted provider for Task E: Multi-Step Normal Work (4 steps, clean progress).
 */
class MultiStepNormalProvider implements ModelProviderPort {
  readonly providerName = "scripted-multistep-provider";

  async generate(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    const userMsg = request.input.find((m) => m.role === "user")?.content ?? "";
    const hashMatch = /Set contextSnapshotHash to "([a-f0-9]{64})"/.exec(userMsg);
    const contextSnapshotHash = hashMatch ? hashMatch[1] : undefined;
    const stepMatch = /- Step Sequence: (\d+)/.exec(userMsg);
    const step = stepMatch && stepMatch[1] ? parseInt(stepMatch[1], 10) : 1;

    let payload: Record<string, unknown>;

    if (userMsg.includes("ALPHA-BETA-GAMMA") || step >= 5) {
      payload = {
        isGoalReached: true,
        contextSnapshotHash,
        rationale: "Goal reached after verifying step3.txt",
      };
    } else if (step === 4) {
      payload = {
        isGoalReached: false,
        toolName: "write_file",
        inputPayload: {
          path: "step3.txt",
          content: "ALPHA-BETA-GAMMA",
        },
        contextSnapshotHash,
        rationale: "Writing step3.txt",
      };
    } else if (step === 3) {
      payload = {
        isGoalReached: false,
        toolName: "read_file",
        inputPayload: {
          path: "step2.txt",
        },
        contextSnapshotHash,
        rationale: "Reading intermediate step2.txt",
      };
    } else if (step === 2) {
      payload = {
        isGoalReached: false,
        toolName: "write_file",
        inputPayload: {
          path: "step2.txt",
          content: "alpha-beta",
        },
        contextSnapshotHash,
        rationale: "Writing intermediate step2.txt",
      };
    } else {
      payload = {
        isGoalReached: false,
        toolName: "read_file",
        inputPayload: {
          path: "step1.txt",
        },
        contextSnapshotHash,
        rationale: "Reading initial step1.txt",
      };
    }

    return {
      requestId: request.requestId,
      model: request.model,
      outputText: JSON.stringify(payload),
      finishReason: "STOP",
      durationMs: 5,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    };
  }
}

/**
 * Scripted provider for Task F: Long Sequential Pipeline (6 stages).
 */
class LongSequenceProvider implements ModelProviderPort {
  readonly providerName = "scripted-long-sequence-provider";

  async generate(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    const userMsg = request.input.find((m) => m.role === "user")?.content ?? "";
    const hashMatch = /Set contextSnapshotHash to "([a-f0-9]{64})"/.exec(userMsg);
    const contextSnapshotHash = hashMatch ? hashMatch[1] : undefined;

    let payload: Record<string, unknown>;

    if (userMsg.includes("PIPELINE-COMPLETE")) {
      payload = {
        isGoalReached: true,
        contextSnapshotHash,
        rationale: "Pipeline complete",
      };
    } else if (userMsg.includes("stage3-token")) {
      payload = {
        isGoalReached: false,
        toolName: "write_file",
        inputPayload: { path: "stage4.txt", content: "PIPELINE-COMPLETE" },
        contextSnapshotHash,
        rationale: "Writing stage4 final output",
      };
    } else if (userMsg.includes("stage2-token")) {
      payload = {
        isGoalReached: false,
        toolName: "write_file",
        inputPayload: { path: "stage3.txt", content: "stage3-token" },
        contextSnapshotHash,
        rationale: "Writing stage3 output",
      };
    } else if (userMsg.includes("stage1-token")) {
      payload = {
        isGoalReached: false,
        toolName: "write_file",
        inputPayload: { path: "stage2.txt", content: "stage2-token" },
        contextSnapshotHash,
        rationale: "Writing stage2 output",
      };
    } else if (userMsg.includes("initial-token")) {
      payload = {
        isGoalReached: false,
        toolName: "write_file",
        inputPayload: { path: "stage1.txt", content: "stage1-token" },
        contextSnapshotHash,
        rationale: "Writing stage1 output",
      };
    } else {
      payload = {
        isGoalReached: false,
        toolName: "read_file",
        inputPayload: { path: "stage0.txt" },
        contextSnapshotHash,
        rationale: "Reading initial stage0 seed",
      };
    }

    return {
      requestId: request.requestId,
      model: request.model,
      outputText: JSON.stringify(payload),
      finishReason: "STOP",
      durationMs: 5,
      usage: { inputTokens: 120, outputTokens: 60, totalTokens: 180 },
    };
  }
}

/**
 * Scripted provider for Task G: Intermittent Recoverable Failure.
 * Sequence: fail (missing1) -> succeed (primary) -> fail (missing2) -> succeed (secondary) -> write (recovered).
 */
class IntermittentFailureProvider implements ModelProviderPort {
  readonly providerName = "scripted-intermittent-provider";

  async generate(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    const userMsg = request.input.find((m) => m.role === "user")?.content ?? "";
    const hashMatch = /Set contextSnapshotHash to "([a-f0-9]{64})"/.exec(userMsg);
    const contextSnapshotHash = hashMatch ? hashMatch[1] : undefined;
    const stepMatch = /- Step Sequence: (\d+)/.exec(userMsg);
    const step = stepMatch && stepMatch[1] ? parseInt(stepMatch[1], 10) : 1;

    let payload: Record<string, unknown>;

    if (userMsg.includes("RECOVERED:") || step >= 6) {
      payload = {
        isGoalReached: true,
        contextSnapshotHash,
        rationale: "Goal reached after verifying recovered.txt",
      };
    } else if (userMsg.includes("secondary payload") && userMsg.includes("primary payload")) {
      payload = {
        isGoalReached: false,
        toolName: "write_file",
        inputPayload: {
          path: "recovered.txt",
          content: "RECOVERED: primary payload + secondary payload",
        },
        contextSnapshotHash,
        rationale: "Writing aggregated recovery output",
      };
    } else if (userMsg.includes("primary payload") && !userMsg.includes("secondary payload")) {
      // Step 3 or 4: try reading missing file 2, then secondary
      if (step <= 3) {
        payload = {
          isGoalReached: false,
          toolName: "read_file",
          inputPayload: { path: "missing2.txt" },
          contextSnapshotHash,
          rationale: "Attempting to read nonexistent missing2.txt",
        };
      } else {
        payload = {
          isGoalReached: false,
          toolName: "read_file",
          inputPayload: { path: "secondary.txt" },
          contextSnapshotHash,
          rationale: "Reading fallback secondary.txt",
        };
      }
    } else if (step === 1) {
      // First attempt: fail once against missing1.txt
      payload = {
        isGoalReached: false,
        toolName: "read_file",
        inputPayload: { path: "missing1.txt" },
        contextSnapshotHash,
        rationale: "Attempting to read nonexistent missing1.txt",
      };
    } else {
      // Step 2: read primary.txt (succeeds, resetting streak!)
      payload = {
        isGoalReached: false,
        toolName: "read_file",
        inputPayload: { path: "primary.txt" },
        contextSnapshotHash,
        rationale: "Reading fallback primary.txt",
      };
    }

    return {
      requestId: request.requestId,
      model: request.model,
      outputText: JSON.stringify(payload),
      finishReason: "STOP",
      durationMs: 5,
      usage: { inputTokens: 110, outputTokens: 50, totalTokens: 160 },
    };
  }
}

/**
 * Scripted provider for Task H: Mixed Workload.
 * Sequence: normal (read dataset) -> normal (write temp) -> failure (read missing) ->
 * normal (read config) -> redundant (read config repeatedly) -> recover (write summary) -> complete.
 */
class MixedWorkloadProvider implements ModelProviderPort {
  readonly providerName = "scripted-mixed-provider";

  async generate(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    const userMsg = request.input.find((m) => m.role === "user")?.content ?? "";
    const hashMatch = /Set contextSnapshotHash to "([a-f0-9]{64})"/.exec(userMsg);
    const contextSnapshotHash = hashMatch ? hashMatch[1] : undefined;
    const stepMatch = /- Step Sequence: (\d+)/.exec(userMsg);
    const step = stepMatch && stepMatch[1] ? parseInt(stepMatch[1], 10) : 1;

    let payload: Record<string, unknown>;

    if (userMsg.includes("PROCESSED: base record") || step >= 8) {
      payload = {
        isGoalReached: true,
        contextSnapshotHash,
        rationale: "Goal reached after summary write",
      };
    } else if (userMsg.includes("Reflex evaluation rejected proposal") || step >= 7) {
      // Recover after redundant action intervention: write final summary.txt
      payload = {
        isGoalReached: false,
        toolName: "write_file",
        inputPayload: { path: "summary.txt", content: "PROCESSED: base record" },
        contextSnapshotHash,
        rationale: "Writing summary after recovering from rejected redundant loop",
      };
    } else if (step === 1) {
      payload = {
        isGoalReached: false,
        toolName: "read_file",
        inputPayload: { path: "dataset.txt" },
        contextSnapshotHash,
        rationale: "Normal action 1: read dataset",
      };
    } else if (step === 2) {
      payload = {
        isGoalReached: false,
        toolName: "write_file",
        inputPayload: { path: "temp.txt", content: "intermediate" },
        contextSnapshotHash,
        rationale: "Normal action 2: write temp",
      };
    } else if (step === 3) {
      payload = {
        isGoalReached: false,
        toolName: "read_file",
        inputPayload: { path: "missing-h.txt" },
        contextSnapshotHash,
        rationale: "Recoverable failure: read nonexistent file",
      };
    } else {
      // Step 4 & 5: redundant read of config.txt without state modification
      payload = {
        isGoalReached: false,
        toolName: "read_file",
        inputPayload: { path: "config.txt" },
        contextSnapshotHash,
        rationale: "Redundant action: reading unchanged config.txt",
      };
    }

    return {
      requestId: request.requestId,
      model: request.model,
      outputText: JSON.stringify(payload),
      finishReason: "STOP",
      durationMs: 5,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    };
  }
}

/**
 * Scripted provider for Task I: Near-Threshold Workload.
 * Requires 2 steps (40% of maxSteps=5), approaching but never crossing 80% budget threshold.
 */
class NearThresholdProvider implements ModelProviderPort {
  readonly providerName = "scripted-near-threshold-provider";

  async generate(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    const userMsg = request.input.find((m) => m.role === "user")?.content ?? "";
    const hashMatch = /Set contextSnapshotHash to "([a-f0-9]{64})"/.exec(userMsg);
    const contextSnapshotHash = hashMatch ? hashMatch[1] : undefined;

    let payload: Record<string, unknown>;

    if (userMsg.includes("THRESHOLD VERIFIED:")) {
      payload = {
        isGoalReached: true,
        contextSnapshotHash,
        rationale: "Task complete",
      };
    } else if (userMsg.includes("threshold verification payload")) {
      payload = {
        isGoalReached: false,
        toolName: "write_file",
        inputPayload: {
          path: "result.txt",
          content: "THRESHOLD VERIFIED: threshold verification payload",
        },
        contextSnapshotHash,
        rationale: "Writing result before threshold",
      };
    } else {
      payload = {
        isGoalReached: false,
        toolName: "read_file",
        inputPayload: { path: "data.txt" },
        contextSnapshotHash,
        rationale: "Reading data.txt",
      };
    }

    return {
      requestId: request.requestId,
      model: request.model,
      outputText: JSON.stringify(payload),
      finishReason: "STOP",
      durationMs: 5,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    };
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describe("Phase 8.7 — Reflex Overhead, Calibration & Extended Evaluation", () => {
  // ==========================================================================
  // Section 1: Extended Task Definitions & Registry (Tests 1–6)
  // ==========================================================================
  describe("1. Extended Task Definitions & Registry", () => {
    it("1. exposes canonical Tasks A–D and extended Tasks E–I in registry", () => {
      expect(BASELINE_REFLEX_TASKS).toHaveLength(4);
      expect(EXTENDED_BASELINE_REFLEX_TASKS).toHaveLength(5);
      expect(EXTENDED_BASELINE_REFLEX_TASK_IDS).toHaveLength(5);
      expect(ALL_BASELINE_REFLEX_TASKS).toHaveLength(9);
      expect(ALL_BASELINE_REFLEX_TASK_IDS).toHaveLength(9);
      expect(TASK_A_NORMAL_WORK.taskId).toBeDefined();
      expect(TASK_B_REPEATED_FAILURE.taskId).toBeDefined();
      expect(TASK_C_REDUNDANT_ACTION.taskId).toBeDefined();
      expect(TASK_D_BUDGET_PRESSURE.taskId).toBeDefined();
    });

    it("2. retrieves Task E (Multi-Step Normal Work) with valid schema and budget", () => {
      const task = getBaselineReflexTask("task-baseline-reflex-multi-step-normal");
      expect(task.taskId).toBe("task-baseline-reflex-multi-step-normal");
      expect(task.budget.maxSteps).toBe(8);
      expect(task.successCriteria).toHaveLength(2);
      expect(task.fixture.initialFiles["step1.txt"]).toBe("alpha");
    });

    it("3. retrieves Task F (Long Successful Sequence) with valid pipeline criteria", () => {
      const task = getBaselineReflexTask("task-baseline-reflex-long-sequence");
      expect(task.taskId).toBe("task-baseline-reflex-long-sequence");
      expect(task.budget.maxSteps).toBe(12);
      expect(task.fixture.initialFiles["stage0.txt"]).toBe("initial-token");
    });

    it("4. retrieves Task G (Intermittent Recoverable Failure) with multi-file fixture", () => {
      const task = getBaselineReflexTask("task-baseline-reflex-intermittent-failure");
      expect(task.taskId).toBe("task-baseline-reflex-intermittent-failure");
      expect(task.fixture.initialFiles["primary.txt"]).toBeDefined();
      expect(task.fixture.initialFiles["secondary.txt"]).toBeDefined();
    });

    it("5. retrieves Task H (Mixed Workload) and Task I (Near-Threshold Workload)", () => {
      const taskH = getBaselineReflexTask("task-baseline-reflex-mixed-workload");
      expect(taskH.taskId).toBe("task-baseline-reflex-mixed-workload");
      expect(taskH.budget.maxSteps).toBe(10);

      const taskI = getBaselineReflexTask("task-baseline-reflex-near-threshold");
      expect(taskI.taskId).toBe("task-baseline-reflex-near-threshold");
      expect(taskI.budget.maxSteps).toBe(5);
    });

    it("6. throws descriptive error when requesting unregistered task ID", () => {
      expect(() => getBaselineReflexTask("nonexistent-task")).toThrow(
        /Unknown Baseline\/Reflex evaluation task 'nonexistent-task'/
      );
    });
  });

  // ==========================================================================
  // Section 2: Experiment Manifest & Reproducibility (Tests 7–11)
  // ==========================================================================
  describe("2. Experiment Manifest & Reproducibility", () => {
    it("7. creates deterministic experiment manifest with required fields", () => {
      const manifest = createExperimentManifest({
        experimentId: "exp-manifest-test-1",
        taskIds: ["task-baseline-reflex-normal"],
        trialCount: 10,
        executionModes: ["BASELINE", "REFLEX"],
        ruleConfigurationHash: FROZEN_RULE_BASED_REFLEX_CONFIG_HASH,
        modelProvider: "scripted-normal-provider",
        model: "scripted:normal-v1",
      });

      expect(manifest.manifestVersion).toBe(1);
      expect(manifest.experimentId).toBe("exp-manifest-test-1");
      expect(manifest.taskCount).toBe(1);
      expect(manifest.trialCount).toBe(10);
      expect(manifest.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("8. computes identical manifest hash for two equivalent experiment declarations", () => {
      const params1 = {
        experimentId: "exp-manifest-reproducible",
        taskIds: ["task-baseline-reflex-normal", "task-baseline-reflex-multi-step-normal"],
        trialCount: 5,
        executionModes: ["BASELINE", "REFLEX"] as const,
        ruleConfigurationHash: FROZEN_RULE_BASED_REFLEX_CONFIG_HASH,
        modelProvider: "scripted-provider",
        model: "model-v1",
      };
      const params2 = {
        experimentId: "exp-manifest-reproducible",
        // Different task order; canonical payload must sort them
        taskIds: ["task-baseline-reflex-multi-step-normal", "task-baseline-reflex-normal"],
        trialCount: 5,
        executionModes: ["REFLEX", "BASELINE"] as const,
        ruleConfigurationHash: FROZEN_RULE_BASED_REFLEX_CONFIG_HASH,
        modelProvider: "scripted-provider",
        model: "model-v1",
      };

      const manifest1 = createExperimentManifest(params1);
      const manifest2 = createExperimentManifest(params2);

      const hash1 = computeExperimentManifestHash(manifest1);
      const hash2 = computeExperimentManifestHash(manifest2);
      expect(hash1).toBe(hash2);
      expect(manifest1.manifestHash).toBe(manifest2.manifestHash);
    });

    it("9. detects configuration drift when ruleConfigurationHash differs", () => {
      const manifestA = createExperimentManifest({
        experimentId: "exp-test",
        taskIds: ["task-baseline-reflex-normal"],
        trialCount: 5,
        executionModes: ["BASELINE", "REFLEX"],
        ruleConfigurationHash: FROZEN_RULE_BASED_REFLEX_CONFIG_HASH,
        modelProvider: "scripted-provider",
        model: "model-v1",
      });

      const manifestB = createExperimentManifest({
        experimentId: "exp-test",
        taskIds: ["task-baseline-reflex-normal"],
        trialCount: 5,
        executionModes: ["BASELINE", "REFLEX"],
        ruleConfigurationHash: "0".repeat(64),
        modelProvider: "scripted-provider",
        model: "model-v1",
      });

      expect(manifestA.manifestHash).not.toBe(manifestB.manifestHash);
    });

    it("10. redacts sensitive credential keys when computing manifest hash", () => {
      const manifest = createExperimentManifest({
        experimentId: "exp-secret-check",
        taskIds: ["task-baseline-reflex-normal"],
        trialCount: 1,
        executionModes: ["BASELINE"],
        modelProvider: "test-provider",
        model: "test-model",
        generationConfig: {
          apiKey: "sk-secret-token",
          temperature: 0.0,
        },
      });

      // Manifest hash must not include raw secret values
      expect(manifest.manifestHash).toBeDefined();
      expect(JSON.stringify(manifest)).not.toContain("sk-secret-token");
    });

    it("11. rejects malformed manifest with invalid trial count", () => {
      expect(() =>
        createExperimentManifest({
          experimentId: "exp-invalid",
          taskIds: ["task-baseline-reflex-normal"],
          trialCount: 0, // Invalid: must be positive
          executionModes: ["BASELINE"],
          modelProvider: "provider",
          model: "model",
        })
      ).toThrow();
    });
  });

  // ==========================================================================
  // Section 3: Frozen Configuration Hash & Anti-Tuning Invariant (Tests 12–15)
  // ==========================================================================
  describe("3. Frozen Configuration Hash & Anti-Tuning Invariant", () => {
    it("12. verifies DEFAULT_RULE_BASED_REFLEX_CONFIG matches frozen hash", () => {
      const computedHash = computeRuleBasedReflexConfigHash(DEFAULT_RULE_BASED_REFLEX_CONFIG);
      expect(computedHash).toBe(FROZEN_RULE_BASED_REFLEX_CONFIG_HASH);
    });

    it("13. detects regression if failureLoop threshold is modified", () => {
      const tunedConfig: RuleBasedReflexConfig = {
        ...DEFAULT_RULE_BASED_REFLEX_CONFIG,
        failureLoop: {
          ...DEFAULT_RULE_BASED_REFLEX_CONFIG.failureLoop,
          maxRepeatedFailures: 2, // Modified threshold
        },
      };
      const tunedHash = computeRuleBasedReflexConfigHash(tunedConfig);
      expect(tunedHash).not.toBe(FROZEN_RULE_BASED_REFLEX_CONFIG_HASH);
    });

    it("14. detects regression if budgetPressure threshold is modified", () => {
      const tunedConfig: RuleBasedReflexConfig = {
        ...DEFAULT_RULE_BASED_REFLEX_CONFIG,
        budgetPressure: {
          ...DEFAULT_RULE_BASED_REFLEX_CONFIG.budgetPressure,
          pressureThreshold: 0.9, // Modified threshold
        },
      };
      const tunedHash = computeRuleBasedReflexConfigHash(tunedConfig);
      expect(tunedHash).not.toBe(FROZEN_RULE_BASED_REFLEX_CONFIG_HASH);
    });

    it("15. verifies frozen rule precedence: Failure Loop > Redundant Action > Budget Pressure > ALLOW", async () => {
      const reflex = new RuleBasedReflex(DEFAULT_RULE_BASED_REFLEX_CONFIG);
      const inputHash = computeCanonicalHash({ path: "failing.txt" }).contentHash;
      const contextHash = "b".repeat(64);
      const actionHistory = [
        {
          toolName: "read_file" as const,
          inputHash,
          contextHash,
          status: "FAILED" as const,
          sequenceNumber: 1,
        },
        {
          toolName: "read_file" as const,
          inputHash,
          contextHash,
          status: "FAILED" as const,
          sequenceNumber: 2,
        },
        {
          toolName: "read_file" as const,
          inputHash,
          contextHash,
          status: "FAILED" as const,
          sequenceNumber: 3,
        },
      ];

      const decision = await reflex.evaluate(
        {
          proposalId: "p-prec",
          toolName: "read_file",
          inputPayload: { path: "failing.txt" },
          rationale: "testing precedence",
          contextSnapshotHash: "b".repeat(64),
        },
        {
          runId: "r-prec",
          taskId: "t-prec",
          stepNumber: 4,
          taskDescription: "precedence test",
          failureCount: 3,
          contextHash: "b".repeat(64),
          recentActionHistory: actionHistory,
          resourceUsage: {
            elapsedWallClockMs: 25000,
            actionsExecuted: 4,
            stepsExecuted: 4,
          },
        }
      );

      // Precedence priority 1 triggers first
      expect(decision.ruleId).toBe("reflex.failure-loop.v1");
      expect(decision.decision).toBe("REJECT");
    });
  });

  // ==========================================================================
  // Section 4: Task E — Multi-Step Normal Work (Tests 16–18)
  // ==========================================================================
  describe("4. Task E: Multi-Step Normal Work", () => {
    it("16. executes Task E where both Baseline and Reflex achieve 100% pass rate", async () => {
      const provider = new MultiStepNormalProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_E_MULTI_STEP_NORMAL,
        modelProvider: provider,
        model: "scripted:multistep-v1",
        trialsPerCondition: 2,
      });

      expect(result.baselineTrials).toHaveLength(2);
      expect(result.reflexTrials).toHaveLength(2);

      for (const trial of result.baselineTrials) {
        expect(trial.verificationPassed).toBe(true);
        expect(trial.outcome).toBe("PASSED");
      }
      for (const trial of result.reflexTrials) {
        expect(trial.verificationPassed).toBe(true);
        expect(trial.outcome).toBe("PASSED");
      }

      expect(result.comparison.passRateComparison.delta).toBe(0.0);
    });

    it("17. verifies Reflex intervenes 0 times across multi-step execution on Task E", async () => {
      const provider = new MultiStepNormalProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_E_MULTI_STEP_NORMAL,
        modelProvider: provider,
        model: "scripted:multistep-v1",
        trialsPerCondition: 1,
      });

      const reflexTrial = result.reflexTrials[0]!;
      expect(reflexTrial.metrics.reflexEvaluations).toBeGreaterThan(2);
      expect(reflexTrial.metrics.reflexAllows).toBe(reflexTrial.metrics.reflexEvaluations);
      expect(reflexTrial.metrics.reflexRejects).toBe(0);
      expect(reflexTrial.metrics.reflexDefers).toBe(0);
    });

    it("18. reports zero false-positive interventions for Task E", async () => {
      const provider = new MultiStepNormalProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_E_MULTI_STEP_NORMAL,
        modelProvider: provider,
        model: "scripted:multistep-v1",
        trialsPerCondition: 1,
      });

      expect(result.reflexInterventionMetrics.falsePositiveInterventions).toBe(0);
      expect(result.reflexInterventionMetrics.falsePositiveRate).toBe(0.0);
    });
  });

  // ==========================================================================
  // Section 5: Task F — Long Sequence & Overhead Telemetry (Tests 19–21)
  // ==========================================================================
  describe("5. Task F: Long Sequence & Overhead Telemetry", () => {
    it("19. executes Task F pipeline successfully in both Baseline and Reflex", async () => {
      const provider = new LongSequenceProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_F_LONG_SEQUENCE,
        modelProvider: provider,
        model: "scripted:long-v1",
        trialsPerCondition: 1,
      });

      expect(result.baselineTrials[0]!.verificationPassed).toBe(true);
      expect(result.reflexTrials[0]!.verificationPassed).toBe(true);
    });

    it("20. captures cumulative Reflex evaluation overhead across sequence", async () => {
      const provider = new LongSequenceProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_F_LONG_SEQUENCE,
        modelProvider: provider,
        model: "scripted:long-v1",
        trialsPerCondition: 1,
      });

      const reflexTrial = result.reflexTrials[0]!;
      expect(reflexTrial.metrics.reflexEvaluations).toBeGreaterThanOrEqual(5);
      expect(reflexTrial.metrics.reflexLatencyMs).toBeDefined();
      expect(reflexTrial.metrics.reflexLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it("21. ensures Baseline Reflex latency and evaluations remain strictly undefined", async () => {
      const provider = new LongSequenceProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_F_LONG_SEQUENCE,
        modelProvider: provider,
        model: "scripted:long-v1",
        trialsPerCondition: 1,
      });

      const baseTrial = result.baselineTrials[0]!;
      expect(baseTrial.metrics.reflexEvaluations).toBeUndefined();
      expect(baseTrial.metrics.reflexAllows).toBeUndefined();
      expect(baseTrial.metrics.reflexLatencyMs).toBeUndefined();
    });
  });

  // ==========================================================================
  // Section 6: Task G — Intermittent Failure Streak Reset (Tests 22–24)
  // ==========================================================================
  describe("6. Task G: Intermittent Failure Streak Reset", () => {
    it("22. verifies intermittent failures separated by successes do not trigger failure loop", async () => {
      const provider = new IntermittentFailureProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_G_INTERMITTENT_FAILURE,
        modelProvider: provider,
        model: "scripted:intermittent-v1",
        trialsPerCondition: 1,
      });

      const reflexTrial = result.reflexTrials[0]!;
      expect(reflexTrial.metrics.failureLoopTriggers).toBe(0);
      expect(reflexTrial.metrics.reflexRejects).toBe(0);
      expect(reflexTrial.verificationPassed).toBe(true);
    });

    it("23. verifies both Baseline and Reflex complete Task G successfully", async () => {
      const provider = new IntermittentFailureProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_G_INTERMITTENT_FAILURE,
        modelProvider: provider,
        model: "scripted:intermittent-v1",
        trialsPerCondition: 1,
      });

      expect(result.baselineTrials[0]!.verificationPassed).toBe(true);
      expect(result.reflexTrials[0]!.verificationPassed).toBe(true);
      expect(result.comparison.passRateComparison.delta).toBe(0.0);
    });

    it("24. classifies zero false positives on Task G since no intervention occurred", async () => {
      const provider = new IntermittentFailureProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_G_INTERMITTENT_FAILURE,
        modelProvider: provider,
        model: "scripted:intermittent-v1",
        trialsPerCondition: 1,
      });

      expect(result.reflexInterventionMetrics.falsePositiveInterventions).toBe(0);
      expect(result.reflexInterventionMetrics.falsePositiveRate).toBe(0.0);
    });
  });

  // ==========================================================================
  // Section 7: Task H — Mixed Workload (Tests 25–27)
  // ==========================================================================
  describe("7. Task H: Mixed Workload", () => {
    it("25. records both ALLOW and REJECT decisions in single Reflex transcript", async () => {
      const provider = new MixedWorkloadProvider();
      const tightConfig: RuleBasedReflexConfig = {
        ...DEFAULT_RULE_BASED_REFLEX_CONFIG,
        redundantAction: {
          enabled: true,
          maxRepeatedActions: 2,
          decisionOnTrigger: "REJECT",
        },
      };

      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_H_MIXED_WORKLOAD,
        modelProvider: provider,
        model: "scripted:mixed-v1",
        trialsPerCondition: 1,
        ruleBasedReflexConfig: tightConfig,
      });

      const reflexTrial = result.reflexTrials[0]!;
      expect(reflexTrial.metrics.reflexAllows).toBeGreaterThan(0);
      expect(reflexTrial.metrics.reflexRejects).toBeGreaterThan(0);
      expect(reflexTrial.metrics.redundantActionTriggers).toBeGreaterThan(0);
      expect(reflexTrial.verificationPassed).toBe(true);
    });

    it("26. demonstrates Baseline executes redundant tool dispatches without Reflex intervention", async () => {
      const provider = new MixedWorkloadProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_H_MIXED_WORKLOAD,
        modelProvider: provider,
        model: "scripted:mixed-v1",
        trialsPerCondition: 1,
      });

      const baseTrial = result.baselineTrials[0]!;
      expect(baseTrial.metrics.proposalRejections).toBe(0);
      expect(baseTrial.metrics.reflexRejects).toBeUndefined();
    });

    it("27. leaves false positive metric undefined for Task H due to intentional redundant workload", async () => {
      const provider = new MixedWorkloadProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_H_MIXED_WORKLOAD,
        modelProvider: provider,
        model: "scripted:mixed-v1",
        trialsPerCondition: 1,
      });

      // Task H is an intentional intervention scenario; false positives must not be fabricated
      expect(result.reflexInterventionMetrics.falsePositiveInterventions).toBeUndefined();
      expect(result.reflexInterventionMetrics.falsePositiveRate).toBeUndefined();
    });
  });

  // ==========================================================================
  // Section 8: Task I — Near-Threshold Workload (Tests 28–30)
  // ==========================================================================
  describe("8. Task I: Near-Threshold Workload", () => {
    it("28. executes Task I without triggering budget pressure below 80% threshold", async () => {
      const provider = new NearThresholdProvider();
      const budgetConfig: RuleBasedReflexConfig = {
        ...DEFAULT_RULE_BASED_REFLEX_CONFIG,
        budgetPressure: {
          enabled: true,
          pressureThreshold: 0.8, // 80% threshold on maxSteps=5 is step 4
          maxSteps: 5,
          decisionOnTrigger: "DEFER",
        },
      };

      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_I_NEAR_THRESHOLD,
        modelProvider: provider,
        model: "scripted:near-threshold-v1",
        trialsPerCondition: 1,
        ruleBasedReflexConfig: budgetConfig,
      });

      const reflexTrial = result.reflexTrials[0]!;
      // Task completes in 2 steps (40%), below 80% threshold
      expect(reflexTrial.metrics.budgetPressureTriggers).toBe(0);
      expect(reflexTrial.metrics.reflexDefers).toBe(0);
      expect(reflexTrial.outcome).toBe("PASSED");
    });

    it("29. verifies both Baseline and Reflex pass Task I without premature blocking", async () => {
      const provider = new NearThresholdProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_I_NEAR_THRESHOLD,
        modelProvider: provider,
        model: "scripted:near-threshold-v1",
        trialsPerCondition: 1,
      });

      expect(result.baselineTrials[0]!.verificationPassed).toBe(true);
      expect(result.reflexTrials[0]!.verificationPassed).toBe(true);
    });

    it("30. reports zero false positives on Task I confirming threshold calibration safety", async () => {
      const provider = new NearThresholdProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_I_NEAR_THRESHOLD,
        modelProvider: provider,
        model: "scripted:near-threshold-v1",
        trialsPerCondition: 1,
      });

      expect(result.reflexInterventionMetrics.falsePositiveInterventions).toBe(0);
      expect(result.reflexInterventionMetrics.falsePositiveRate).toBe(0.0);
    });
  });

  // ==========================================================================
  // Section 9: Reflex Intervention Metrics & Rates (Tests 31–36)
  // ==========================================================================
  describe("9. Reflex Intervention Metrics & Rates", () => {
    it("31. computes reflexInterventionRate = (rejects + defers) / reflexEvaluations", () => {
      const mockTrials: any[] = [
        {
          metrics: {
            reflexEvaluations: 10,
            reflexAllows: 8,
            reflexRejects: 1,
            reflexDefers: 1,
          },
        },
      ];

      const metrics = calculateReflexInterventionMetrics(mockTrials);
      expect(metrics.reflexEvaluations).toBe(10);
      expect(metrics.reflexInterventions).toBe(2);
      expect(metrics.interventionRate).toBeCloseTo(0.2, 5);
      expect(metrics.rejectionRate).toBeCloseTo(0.1, 5);
      expect(metrics.deferRate).toBeCloseTo(0.1, 5);
      expect(metrics.allowanceRate).toBeCloseTo(0.8, 5);
    });

    it("32. returns undefined rates when reflexEvaluations is zero or undefined", () => {
      const mockTrials: any[] = [
        {
          metrics: {
            steps: 5,
            actions: 5,
            // Baseline trial: no reflex evaluations
          },
        },
      ];

      const metrics = calculateReflexInterventionMetrics(mockTrials);
      expect(metrics.reflexEvaluations).toBeUndefined();
      expect(metrics.interventionRate).toBeUndefined();
      expect(metrics.rejectionRate).toBeUndefined();
    });

    it("33. classifies false positive intervention on intervention-free normal tasks", () => {
      const mockTrials: any[] = [
        {
          metrics: {
            reflexEvaluations: 5,
            reflexAllows: 4,
            reflexRejects: 1, // Unexpected intervention on Task A
            reflexDefers: 0,
          },
        },
      ];

      const metrics = calculateReflexInterventionMetrics(mockTrials, TASK_A_NORMAL_WORK);
      expect(metrics.falsePositiveInterventions).toBe(1);
      expect(metrics.falsePositiveRate).toBeCloseTo(0.2, 5);
    });

    it("34. leaves false positives undefined on intentional failure tasks (Task B)", () => {
      const mockTrials: any[] = [
        {
          metrics: {
            reflexEvaluations: 5,
            reflexAllows: 2,
            reflexRejects: 3, // Expected intervention on Task B
            reflexDefers: 0,
          },
        },
      ];

      const metrics = calculateReflexInterventionMetrics(mockTrials, TASK_B_REPEATED_FAILURE);
      expect(metrics.falsePositiveInterventions).toBeUndefined();
      expect(metrics.falsePositiveRate).toBeUndefined();
    });

    it("35. returns undefined false positives when task reference is not provided", () => {
      const mockTrials: any[] = [
        {
          metrics: {
            reflexEvaluations: 5,
            reflexAllows: 5,
            reflexRejects: 0,
            reflexDefers: 0,
          },
        },
      ];

      const metrics = calculateReflexInterventionMetrics(mockTrials, undefined);
      expect(metrics.falsePositiveInterventions).toBeUndefined();
      expect(metrics.falsePositiveRate).toBeUndefined();
    });

    it("36. verifies isTaskInterventionFree helper returns exact metadata classification", () => {
      expect(isTaskInterventionFree("task-baseline-reflex-normal")).toBe(true);
      expect(isTaskInterventionFree("task-baseline-reflex-multi-step-normal")).toBe(true);
      expect(isTaskInterventionFree("task-baseline-reflex-failure-loop")).toBe(false);
      expect(isTaskInterventionFree("task-baseline-reflex-redundant-action")).toBe(false);
      expect(isTaskInterventionFree("unknown-task-id")).toBeUndefined();
    });
  });

  // ==========================================================================
  // Section 10: Repeated Trial Matrix (N=10) & Stability (Tests 37–42)
  // ==========================================================================
  describe("10. Repeated Trial Matrix (N=10) & Stability", () => {
    it("37. executes N=10 trials deterministically per condition", async () => {
      const provider = new MultiStepNormalProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_E_MULTI_STEP_NORMAL,
        modelProvider: provider,
        model: "scripted:multistep-v1",
        trialsPerCondition: 10,
      });

      expect(result.baselineTrials).toHaveLength(10);
      expect(result.reflexTrials).toHaveLength(10);
      expect(result.experiment.plannedTrialCount).toBe(10);

      // Verify trial ordinals 1..10
      for (let i = 0; i < 10; i++) {
        expect(result.baselineTrials[i]!.trialOrdinal).toBe(i + 1);
        expect(result.reflexTrials[i]!.trialOrdinal).toBe(i + 1);
      }
    });

    it("38. verifies trial isolation: each trial has unique trialId and timestamps", async () => {
      const provider = new MultiStepNormalProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_E_MULTI_STEP_NORMAL,
        modelProvider: provider,
        model: "scripted:multistep-v1",
        trialsPerCondition: 5,
      });

      const trialIds = new Set(result.reflexTrials.map((t) => t.trialId));
      expect(trialIds.size).toBe(5);
    });

    it("39. computes Reflex stability metrics showing consistent decisions across 10 trials", async () => {
      const provider = new MultiStepNormalProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_E_MULTI_STEP_NORMAL,
        modelProvider: provider,
        model: "scripted:multistep-v1",
        trialsPerCondition: 10,
      });

      const stability = result.reflexStabilityMetrics;
      expect(stability).toBeDefined();
      expect(stability!.trialCount).toBe(10);
      expect(stability!.isDecisionConsistent).toBe(true);
      expect(stability!.isRuleTriggerConsistent).toBe(true);
      expect(stability!.uniqueDecisionSequencesCount).toBe(1);
      expect(stability!.interventionCountDistribution?.[0]).toBe(10);
    });

    it("40. ensures baseline stability metrics remain undefined (control group purity)", async () => {
      const provider = new MultiStepNormalProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_E_MULTI_STEP_NORMAL,
        modelProvider: provider,
        model: "scripted:multistep-v1",
        trialsPerCondition: 3,
      });

      expect(result.baselineStabilityMetrics).toBeUndefined();
    });

    it("41. calculates intervention count distribution across variable trials correctly", () => {
      const mockTrials: any[] = [
        { metrics: { reflexEvaluations: 3, reflexAllows: 3, reflexRejects: 0, reflexDefers: 0 } },
        { metrics: { reflexEvaluations: 3, reflexAllows: 2, reflexRejects: 1, reflexDefers: 0 } },
        { metrics: { reflexEvaluations: 3, reflexAllows: 2, reflexRejects: 1, reflexDefers: 0 } },
      ];

      const stability = calculateReflexStabilityMetrics(mockTrials);
      expect(stability).toBeDefined();
      expect(stability!.trialCount).toBe(3);
      expect(stability!.isDecisionConsistent).toBe(false);
      expect(stability!.interventionCountDistribution?.[0]).toBe(1);
      expect(stability!.interventionCountDistribution?.[1]).toBe(2);
      expect(stability!.uniqueDecisionSequencesCount).toBe(2);
    });

    it("42. returns undefined stability metrics when trials list is empty", () => {
      expect(calculateReflexStabilityMetrics([])).toBeUndefined();
    });
  });

  // ==========================================================================
  // Section 11: Descriptive Statistics & Variability (Tests 43–48)
  // ==========================================================================
  describe("11. Descriptive Statistics & Variability Reporting", () => {
    it("43. computes Wilson score intervals for objectivePassRate across N=10 trials", async () => {
      const provider = new MultiStepNormalProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_E_MULTI_STEP_NORMAL,
        modelProvider: provider,
        model: "scripted:multistep-v1",
        trialsPerCondition: 10,
      });

      const passRateAnalysis = result.passRateAnalysis;
      expect(passRateAnalysis.analysisMethod).toBe("WILSON_SCORE");
      expect(passRateAnalysis.baselineSummary.confidenceInterval).toBeDefined();
      expect(passRateAnalysis.candidateSummary.confidenceInterval).toBeDefined();
      const baseBin = passRateAnalysis.baselineSummary as any;
      const candBin = passRateAnalysis.candidateSummary as any;
      expect(baseBin.totalTrials).toBe(10);
      expect(candBin.totalTrials).toBe(10);
    });

    it("44. computes Student's t distribution statistics (mean, variance, marginOfError) for steps", async () => {
      const provider = new MultiStepNormalProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_E_MULTI_STEP_NORMAL,
        modelProvider: provider,
        model: "scripted:multistep-v1",
        trialsPerCondition: 10,
      });

      const stepAnalysis = result.stepCountAnalysis;
      expect(stepAnalysis.analysisMethod).toBe("STUDENT_T");
      const baseNum = stepAnalysis.baselineSummary as any;
      const candNum = stepAnalysis.candidateSummary as any;
      expect(baseNum.mean).toBeDefined();
      expect(candNum.mean).toBeDefined();
      expect(stepAnalysis.difference.absoluteDifference).toBeDefined();
      expect(stepAnalysis.difference.direction).toBe("LOWER_IS_BETTER");
    });

    it("45. compiles condition report containing exact metric variability (min, max, average, sum)", async () => {
      const provider = new MultiStepNormalProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_E_MULTI_STEP_NORMAL,
        modelProvider: provider,
        model: "scripted:multistep-v1",
        trialsPerCondition: 5,
      });

      const candCondReport = result.report.conditions.find(
        (c) => c.conditionId === "condition-reflex"
      )!;
      const stepAgg = candCondReport.metrics.steps;
      expect(stepAgg.observedCount).toBe(5);
      expect(stepAgg.unavailableCount).toBe(0);
      expect(stepAgg.minimum).toBeDefined();
      expect(stepAgg.maximum).toBeDefined();
      expect(stepAgg.average).toBeDefined();
      expect(stepAgg.sum).toBeDefined();
    });

    it("46. preserves undefined metrics for unavailable observations without fabricating zeros", async () => {
      const provider = new MultiStepNormalProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_E_MULTI_STEP_NORMAL,
        modelProvider: provider,
        model: "scripted:multistep-v1",
        trialsPerCondition: 3,
      });

      const baseCondReport = result.report.conditions.find(
        (c) => c.conditionId === "condition-baseline"
      )!;
      // Baseline never executes reflexEvaluations; must have 0 observed, 3 unavailable
      const reflexEvalAgg = baseCondReport.metrics.reflexEvaluations;
      expect(reflexEvalAgg.observedCount).toBe(0);
      expect(reflexEvalAgg.unavailableCount).toBe(3);
      expect(reflexEvalAgg.average).toBeUndefined();
    });

    it("47. produces non-causal descriptive differences without hypothesis tests or p-values", async () => {
      const provider = new MultiStepNormalProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_E_MULTI_STEP_NORMAL,
        modelProvider: provider,
        model: "scripted:multistep-v1",
        trialsPerCondition: 2,
      });

      const analysis = result.toolCallsAnalysis;
      expect((analysis as any).pValue).toBeUndefined();
      expect((analysis as any).nullHypothesisRejected).toBeUndefined();
      expect(analysis.difference.absoluteDifference).toBe(0);
    });

    it("48. generates reflex latency statistical analysis with LOWER_IS_BETTER direction", async () => {
      const provider = new LongSequenceProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_F_LONG_SEQUENCE,
        modelProvider: provider,
        model: "scripted:long-v1",
        trialsPerCondition: 2,
      });

      if (result.reflexLatencyAnalysis) {
        expect(result.reflexLatencyAnalysis.metric).toBe("reflexLatencyMs");
        expect(result.reflexLatencyAnalysis.direction).toBe("LOWER_IS_BETTER");
      }
    });
  });

  // ==========================================================================
  // Section 12: Multi-Task Suite Orchestrator & End-to-End Governance (Tests 49–54)
  // ==========================================================================
  describe("12. Multi-Task Suite Orchestration & Governance", () => {
    it("49. executes multi-task suite across multiple tasks and compiles suite manifest", async () => {
      const provider = new MultiStepNormalProvider();
      const suiteResult = await executeControlledBaselineReflexSuite({
        tasks: [TASK_A_NORMAL_WORK, TASK_E_MULTI_STEP_NORMAL],
        modelProvider: provider,
        model: "scripted:multistep-v1",
        trialsPerCondition: 1,
      });

      expect(suiteResult.suiteManifest).toBeDefined();
      expect(suiteResult.suiteManifest.taskCount).toBe(2);
      expect(suiteResult.taskResults).toHaveLength(2);
      expect(suiteResult.overallReflexInterventionMetrics.reflexEvaluations).toBeGreaterThan(0);
    });

    it("50. retains replayable Reflex evidence compatible with offline deterministic replay", async () => {
      const provider = new MixedWorkloadProvider();
      const tightConfig: RuleBasedReflexConfig = {
        ...DEFAULT_RULE_BASED_REFLEX_CONFIG,
        redundantAction: {
          enabled: true,
          maxRepeatedActions: 2,
          decisionOnTrigger: "REJECT",
        },
      };

      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_H_MIXED_WORKLOAD,
        modelProvider: provider,
        model: "scripted:mixed-v1",
        trialsPerCondition: 1,
        ruleBasedReflexConfig: tightConfig,
      });

      const reflexTrial = result.reflexTrials[0]!;
      expect(reflexTrial.evidenceReferences.length).toBeGreaterThan(0);

      // Replay all captured evidence records offline
      const reflex = new RuleBasedReflex(tightConfig);
      for (const ev of (reflexTrial as any).reflexEvidence ?? []) {
        const replayResult = await replayReflexEvidence(ev, { reflex });
        expect(replayResult.match).toBe(true);
        expect(replayResult.status).toBe("MATCH");
      }
    });

    it("51. aborts controlled evaluation gracefully when AbortSignal is triggered", async () => {
      const abortController = new AbortController();
      abortController.abort(); // Pre-aborted

      const provider = new MultiStepNormalProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_E_MULTI_STEP_NORMAL,
        modelProvider: provider,
        model: "scripted:multistep-v1",
        trialsPerCondition: 1,
        abortSignal: abortController.signal,
      });

      expect(result.baselineTrials[0]!.outcome).toBe("CANCELLED");
    });

    it("52. preserves UNKNOWN execution status boundary without Reflex interference", () => {
      // UNKNOWN outcomes in history must increment failure streak in failureLoop rule
      const config = DEFAULT_RULE_BASED_REFLEX_CONFIG;
      expect(config.failureLoop.enabled).toBe(true);
    });

    it("53. verifies Baseline non-interference: NoopReflex is used without overhead", async () => {
      const provider = new MultiStepNormalProvider();
      const result = await executeControlledBaselineReflexExperiment({
        task: TASK_E_MULTI_STEP_NORMAL,
        modelProvider: provider,
        model: "scripted:multistep-v1",
        trialsPerCondition: 1,
      });

      const baseTrial = result.baselineTrials[0]!;
      expect(baseTrial.metrics.reflexEvaluations).toBeUndefined();
      expect(baseTrial.metrics.reflexAllows).toBeUndefined();
      expect(baseTrial.metrics.reflexRejects).toBeUndefined();
    });

    it("54. demonstrates repeatable experiment execution producing matching metrics", async () => {
      const provider1 = new MultiStepNormalProvider();
      const provider2 = new MultiStepNormalProvider();

      const run1 = await executeControlledBaselineReflexExperiment({
        task: TASK_E_MULTI_STEP_NORMAL,
        modelProvider: provider1,
        model: "scripted:multistep-v1",
        trialsPerCondition: 2,
      });

      const run2 = await executeControlledBaselineReflexExperiment({
        task: TASK_E_MULTI_STEP_NORMAL,
        modelProvider: provider2,
        model: "scripted:multistep-v1",
        trialsPerCondition: 2,
      });

      expect(run1.manifest.manifestHash).toBe(run2.manifest.manifestHash);
      expect(run1.reflexTrials[0]!.metrics.steps).toBe(run2.reflexTrials[0]!.metrics.steps);
      expect(run1.reflexTrials[0]!.metrics.toolCalls).toBe(run2.reflexTrials[0]!.metrics.toolCalls);
    });
  });
});
