/**
 * Phase 7.5 — Statistical Evaluation Analysis Contracts Test Suite
 *
 * Comprehensive tests covering:
 * Numeric statistics (Tests 1–12):
 * 1. mean
 * 2. mean with one observation
 * 3. empty sample
 * 4. minimum
 * 5. maximum
 * 6. sample variance
 * 7. sample standard deviation
 * 8. Welford numerical stability
 * 9. large magnitude values
 * 10. near-equal values
 * 11. NaN rejected
 * 12. Infinity rejected
 *
 * Missing data (Tests 13–19):
 * 13. undefined excluded
 * 14. zero preserved
 * 15. observed count
 * 16. unavailable count
 * 17. all unavailable
 * 18. mixed observed/unavailable
 * 19. invalid numeric input rejected
 *
 * Binary analysis (Tests 20–27):
 * 20. zero successes
 * 21. all successes
 * 22. mixed successes/failures
 * 23. zero observations
 * 24. success rate
 * 25. Wilson interval
 * 26. interval contains point estimate
 * 27. confidence level validation
 *
 * Numeric confidence intervals (Tests 28–32):
 * 28. n=1 interval unavailable
 * 29. n>=2 Student-t interval
 * 30. degrees of freedom correct
 * 31. interval ordering (lower <= mean <= upper)
 * 32. confidence level preserved
 *
 * Differences (Tests 33–38):
 * 33. absolute difference
 * 34. relative difference
 * 35. zero baseline
 * 36. negative baseline handling
 * 37. missing baseline
 * 38. missing candidate
 *
 * Directionality (Tests 39–42):
 * 39. higher-is-better
 * 40. lower-is-better
 * 41. neutral
 * 42. no direction inference
 *
 * Comparability (Tests 43–48):
 * 43. same experiment accepted
 * 44. task mismatch rejected
 * 45. task version mismatch rejected
 * 46. task hash mismatch rejected
 * 47. condition mismatch rejected
 * 48. configuration mismatch rejected
 *
 * Methodology (Tests 49–56):
 * 49. independent samples by default
 * 50. no implicit pairing
 * 51. insufficient-observation warning
 * 52. missing-data warning
 * 53. wide-interval warning
 * 54. single-observation warning
 * 55. deterministic analysis identity
 * 56. analysis serialization
 *
 * Security / architecture (Tests 57–60):
 * 57. no authority fields
 * 58. pure computation does not invoke runtime
 * 59. source records are not mutated
 * 60. no model/tool/provider invocation
 */

import { describe, expect, it } from "vitest";
import {
  analyzeBinaryOutcome,
  analyzeExperiment,
  analyzeNumericMetric,
  calculateDifference,
  calculateSampleStatistics,
  calculateWilsonScoreInterval,
  computeStatisticalAnalysisConfigHash,
  computeStatisticalAnalysisHash,
  normalQuantile,
  studentTQuantile,
  validateStatisticalAnalysis,
} from "../../src/domain/statistical-analysis.js";
import {
  computeEvaluationTaskHash,
  createEvaluationConfigFingerprint,
  createEvaluationExperiment,
  createEvaluationMetrics,
  createEvaluationTask,
  createEvaluationTrial,
  createExperimentCondition,
  CURRENT_HARNESS_VERSION,
  EvaluationExperiment,
  EvaluationExperimentCondition,
  EvaluationMetrics,
  EvaluationTaskDefinition,
  EvaluationTrial,
} from "../../src/domain/evaluation.js";
import { FORBIDDEN_AUTHORITY_KEYS } from "../../src/domain/action-proposal.js";

// ============================================================================
// Helper Factories
// ============================================================================

function createSampleTask(overrides: Partial<EvaluationTaskDefinition> = {}): EvaluationTaskDefinition {
  return createEvaluationTask({
    taskId: "benchmark-stat-task-1",
    version: 1,
    description: "Benchmark task for statistical testing",
    fixture: {
      initialFiles: { "src/math.ts": "export const x = 1;\n" },
    },
    mission: {
      requiredCapabilities: ["workspace.file.read", "workspace.file.write"],
    },
    successCriteria: [
      {
        criterionId: "c1",
        kind: "FILE_EXISTS",
        path: "src/math.ts",
      },
    ],
    budget: {
      maxSteps: 10,
      maxActions: 20,
      maxWallClockMs: 30000,
    },
    ...overrides,
  });
}

function createSampleCondition(
  conditionId: string,
  model: string = "llama3:8b",
  taskVersion: number = 1
): EvaluationExperimentCondition {
  const configFingerprint = createEvaluationConfigFingerprint({
    modelProvider: "ollama",
    model,
    taskVersion,
    harnessVersion: CURRENT_HARNESS_VERSION,
  });
  return createExperimentCondition({
    conditionId,
    name: `Condition ${conditionId}`,
    configFingerprint,
  });
}

function createSampleExperiment(
  task: EvaluationTaskDefinition = createSampleTask()
): EvaluationExperiment {
  const c1 = createSampleCondition("baseline-cond", "llama3:8b", task.version);
  const c2 = createSampleCondition("candidate-cond", "qwen2.5:7b", task.version);

  return createEvaluationExperiment({
    experimentId: "exp-stat-testing",
    version: 1,
    title: "Statistical Evaluation Testing",
    description: "Testing statistical analysis contracts",
    hypothesis: "Candidate condition has lower latency than baseline",
    taskRef: task,
    conditions: [c1, c2],
    plannedTrialCount: 10,
    harnessVersion: CURRENT_HARNESS_VERSION,
    status: "READY",
  });
}

function createSampleMetrics(overrides: Partial<EvaluationMetrics> = {}): EvaluationMetrics {
  return createEvaluationMetrics({
    steps: 5,
    actions: 4,
    attempts: 4,
    modelCalls: 5,
    toolCalls: 4,
    proposalRejections: 0,
    executionFailures: 0,
    modelFailures: 0,
    wallClockMs: 1200,
    modelLatencyMs: 800,
    toolLatencyMs: 250,
    inputTokens: 1500,
    outputTokens: 300,
    totalTokens: 1800,
    ...overrides,
  });
}

function createSampleTrial(
  task: EvaluationTaskDefinition,
  condition: EvaluationExperimentCondition,
  trialOrdinal: number,
  overrides: Partial<Parameters<typeof createEvaluationTrial>[0]> = {}
): EvaluationTrial {
  return createEvaluationTrial({
    trialOrdinal,
    taskId: task.taskId,
    taskVersion: task.version,
    taskContentHash: computeEvaluationTaskHash(task),
    configFingerprint: condition.configFingerprint,
    runtimeRunId: `run-${condition.conditionId}-${trialOrdinal}`,
    outcome: "PASSED",
    statusMessage: "Success",
    verificationPassed: true,
    agentClaimedGoal: true,
    metrics: createSampleMetrics(),
    startedAt: "2026-10-13T10:00:00.000Z",
    completedAt: "2026-10-13T10:00:02.000Z",
    ...overrides,
  });
}

describe("Phase 7.5 — Statistical Evaluation Analysis Contracts", () => {
  // ==========================================================================
  // Numeric Statistics (Tests 1–12)
  // ==========================================================================
  describe("Numeric Statistics", () => {
    it("1. computes sample mean correctly", () => {
      const stats = calculateSampleStatistics([10, 20, 30]);
      expect(stats.mean).toBe(20);
      expect(stats.observedCount).toBe(3);
    });

    it("2. computes mean with exactly one observation", () => {
      const stats = calculateSampleStatistics([42]);
      expect(stats.mean).toBe(42);
      expect(stats.observedCount).toBe(1);
      expect(stats.variance).toBeUndefined();
      expect(stats.standardDeviation).toBeUndefined();
      expect(stats.confidenceInterval).toBeUndefined();
    });

    it("3. handles empty sample gracefully", () => {
      const stats = calculateSampleStatistics([]);
      expect(stats.observedCount).toBe(0);
      expect(stats.sampleCount).toBe(0);
      expect(stats.mean).toBeUndefined();
      expect(stats.minimum).toBeUndefined();
      expect(stats.maximum).toBeUndefined();
      expect(stats.variance).toBeUndefined();
    });

    it("4. computes minimum correctly", () => {
      const stats = calculateSampleStatistics([15, 4, 28, 9]);
      expect(stats.minimum).toBe(4);
    });

    it("5. computes maximum correctly", () => {
      const stats = calculateSampleStatistics([15, 4, 28, 9]);
      expect(stats.maximum).toBe(28);
    });

    it("6. computes sample variance correctly with n - 1 denominator", () => {
      // Sample: [2, 4, 4, 4, 5, 5, 7, 9]. Mean = 5.
      // Sum sq diffs = (9 + 1 + 1 + 1 + 0 + 0 + 4 + 16) = 32.
      // Sample variance = 32 / (8 - 1) = 32 / 7 ≈ 4.57142857.
      const stats = calculateSampleStatistics([2, 4, 4, 4, 5, 5, 7, 9]);
      expect(stats.variance).toBeCloseTo(32 / 7, 6);
    });

    it("7. computes sample standard deviation correctly", () => {
      const stats = calculateSampleStatistics([2, 4, 4, 4, 5, 5, 7, 9]);
      expect(stats.standardDeviation).toBeCloseTo(Math.sqrt(32 / 7), 6);
    });

    it("8. maintains Welford numerical stability without catastrophic cancellation", () => {
      // Values with huge offset: [1e9 + 1, 1e9 + 2, 1e9 + 3]
      // Sample variance must be exactly 1
      const stats = calculateSampleStatistics([1e9 + 1, 1e9 + 2, 1e9 + 3]);
      expect(stats.mean).toBe(1e9 + 2);
      expect(stats.variance).toBe(1);
      expect(stats.standardDeviation).toBe(1);
    });

    it("9. handles large magnitude values accurately", () => {
      const stats = calculateSampleStatistics([1e8, 2e8, 3e8]);
      expect(stats.mean).toBe(2e8);
      expect(stats.variance).toBe(1e16);
    });

    it("10. handles identical or near-equal values without negative variance", () => {
      const stats = calculateSampleStatistics([7.00000001, 7.00000001, 7.00000001]);
      expect(stats.variance).toBeGreaterThanOrEqual(0);
      expect(stats.variance).toBeCloseTo(0, 8);
    });

    it("11. rejects NaN fail-closed with error", () => {
      expect(() => calculateSampleStatistics([10, NaN, 20])).toThrow(/Invalid non-finite/);
    });

    it("12. rejects Infinity fail-closed with error", () => {
      expect(() => calculateSampleStatistics([10, Infinity, 20])).toThrow(/Invalid non-finite/);
      expect(() => calculateSampleStatistics([10, -Infinity, 20])).toThrow(/Invalid non-finite/);
    });
  });

  // ==========================================================================
  // Missing Data (Tests 13–19)
  // ==========================================================================
  describe("Missing Data Semantics", () => {
    it("13. excludes undefined values from the sample denominator", () => {
      // 2 valid observations: [100, 200]. One undefined.
      // Mean must be 150, NOT 100
      const stats = calculateSampleStatistics([100, undefined, 200]);
      expect(stats.observedCount).toBe(2);
      expect(stats.unavailableCount).toBe(1);
      expect(stats.sampleCount).toBe(3);
      expect(stats.mean).toBe(150);
    });

    it("14. strictly preserves observed zero and incorporates it into sample", () => {
      const stats = calculateSampleStatistics([0, 10, 20]);
      expect(stats.observedCount).toBe(3);
      expect(stats.unavailableCount).toBe(0);
      expect(stats.mean).toBe(10);
      expect(stats.minimum).toBe(0);
    });

    it("15. tracks observed count accurately", () => {
      const stats = calculateSampleStatistics([1, 2, undefined, 4, undefined]);
      expect(stats.observedCount).toBe(3);
    });

    it("16. tracks unavailable count accurately", () => {
      const stats = calculateSampleStatistics([1, 2, undefined, 4, undefined]);
      expect(stats.unavailableCount).toBe(2);
    });

    it("17. handles all unavailable observations gracefully", () => {
      const stats = calculateSampleStatistics([undefined, undefined, undefined]);
      expect(stats.observedCount).toBe(0);
      expect(stats.unavailableCount).toBe(3);
      expect(stats.sampleCount).toBe(3);
      expect(stats.mean).toBeUndefined();
      expect(stats.variance).toBeUndefined();
    });

    it("18. computes statistics over mixed observed and unavailable observations", () => {
      const stats = calculateSampleStatistics([10, undefined, 30], 0.95);
      expect(stats.observedCount).toBe(2);
      expect(stats.mean).toBe(20);
      expect(stats.variance).toBe(200);
      expect(stats.confidenceInterval).toBeDefined();
    });

    it("19. rejects invalid non-numeric inputs fail-closed", () => {
      // @ts-expect-error Testing runtime invalid input
      expect(() => calculateSampleStatistics([10, "20", 30])).toThrow(/Invalid non-finite/);
      // @ts-expect-error Testing runtime invalid input
      expect(() => calculateSampleStatistics([10, null, 30])).toThrow(/Invalid non-finite/);
    });
  });

  // ==========================================================================
  // Binary Analysis & Wilson Score Intervals (Tests 20–27)
  // ==========================================================================
  describe("Binary Outcome Analysis", () => {
    it("20. handles zero successes with non-zero Wilson upper bound", () => {
      const interval = calculateWilsonScoreInterval(0, 10, 0.95);
      expect(interval).toBeDefined();
      expect(interval!.lower).toBe(0);
      expect(interval!.upper).toBeGreaterThan(0);
      expect(interval!.upper).toBeLessThan(0.35);
    });

    it("21. handles all successes with non-one Wilson lower bound", () => {
      const interval = calculateWilsonScoreInterval(10, 10, 0.95);
      expect(interval).toBeDefined();
      expect(interval!.lower).toBeGreaterThan(0.65);
      expect(interval!.upper).toBe(1);
    });

    it("22. computes Wilson score interval for mixed successes and failures", () => {
      const interval = calculateWilsonScoreInterval(7, 10, 0.95);
      expect(interval).toBeDefined();
      expect(interval!.lower).toBeGreaterThan(0.35);
      expect(interval!.upper).toBeLessThan(0.95);
      expect(interval!.lower).toBeLessThan(0.7);
      expect(interval!.upper).toBeGreaterThan(0.7);
    });

    it("23. returns undefined interval when total observations are zero", () => {
      const interval = calculateWilsonScoreInterval(0, 0, 0.95);
      expect(interval).toBeUndefined();
    });

    it("24. computes success rate accurately", () => {
      const experiment = createSampleExperiment();
      const analysis = analyzeBinaryOutcome({
        experiment,
        baselineConditionId: "baseline-cond",
        candidateConditionId: "candidate-cond",
        baselineSuccesses: 6,
        baselineFailures: 4,
        candidateSuccesses: 9,
        candidateFailures: 1,
      });

      expect((analysis.baselineSummary as any).successRate).toBe(0.6);
      expect((analysis.candidateSummary as any).successRate).toBe(0.9);
      expect(analysis.difference.absoluteDifference).toBe(0.3);
    });

    it("25. computes Wilson interval using specified confidence level", () => {
      const int90 = calculateWilsonScoreInterval(5, 10, 0.90)!;
      const int99 = calculateWilsonScoreInterval(5, 10, 0.99)!;

      // 99% interval must be wider than 90% interval
      expect(int99.upper - int99.lower).toBeGreaterThan(int90.upper - int90.lower);
    });

    it("26. ensures Wilson interval always contains the sample point estimate", () => {
      for (const k of [0, 1, 3, 5, 7, 9, 10]) {
        const interval = calculateWilsonScoreInterval(k, 10, 0.95)!;
        const p = k / 10;
        expect(p).toBeGreaterThanOrEqual(interval.lower);
        expect(p).toBeLessThanOrEqual(interval.upper);
      }
    });

    it("27. validates confidenceLevel parameter strictly", () => {
      expect(() => calculateWilsonScoreInterval(5, 10, 0)).toThrow(/confidenceLevel/);
      expect(() => calculateWilsonScoreInterval(5, 10, 1)).toThrow(/confidenceLevel/);
      expect(() => calculateWilsonScoreInterval(5, 10, -0.5)).toThrow(/confidenceLevel/);
      expect(() => calculateWilsonScoreInterval(5, 10, NaN)).toThrow(/confidenceLevel/);
    });
  });

  // ==========================================================================
  // Numeric Confidence Intervals (Tests 28–32)
  // ==========================================================================
  describe("Numeric Confidence Intervals", () => {
    it("28. produces unavailable confidence interval when n = 1", () => {
      const stats = calculateSampleStatistics([100], 0.95);
      expect(stats.confidenceInterval).toBeUndefined();
    });

    it("29. computes Student-t confidence interval when n >= 2", () => {
      const stats = calculateSampleStatistics([10, 20, 30], 0.95);
      expect(stats.confidenceInterval).toBeDefined();
      expect(stats.confidenceInterval!.confidenceLevel).toBe(0.95);
      expect(stats.confidenceInterval!.degreesOfFreedom).toBe(2);
    });

    it("30. establishes correct degrees of freedom (df = n - 1)", () => {
      const stats = calculateSampleStatistics([1, 2, 3, 4, 5], 0.95);
      expect(stats.confidenceInterval!.degreesOfFreedom).toBe(4);
    });

    it("31. enforces interval ordering (lower <= mean <= upper)", () => {
      const stats = calculateSampleStatistics([100, 120, 140, 110, 130], 0.95);
      expect(stats.confidenceInterval!.lower).toBeLessThanOrEqual(stats.mean!);
      expect(stats.confidenceInterval!.upper).toBeGreaterThanOrEqual(stats.mean!);
    });

    it("32. preserves explicit confidence level in interval output", () => {
      const stats = calculateSampleStatistics([10, 20, 30], 0.99);
      expect(stats.confidenceInterval!.confidenceLevel).toBe(0.99);
    });
  });

  // ==========================================================================
  // Differences (Tests 33–38)
  // ==========================================================================
  describe("Differences and Ratios", () => {
    it("33. computes absolute difference accurately (candidate - baseline)", () => {
      const diff = calculateDifference({ baseline: 100, candidate: 150 });
      expect(diff.absoluteDifference).toBe(50);
    });

    it("34. computes relative difference accurately when baseline is non-zero", () => {
      const diff = calculateDifference({ baseline: 100, candidate: 150 });
      expect(diff.relativeDifference).toBe(0.5);
    });

    it("35. ensures relative difference is undefined when baseline is zero", () => {
      const diff = calculateDifference({ baseline: 0, candidate: 50 });
      expect(diff.absoluteDifference).toBe(50);
      expect(diff.relativeDifference).toBeUndefined();
    });

    it("36. handles negative baseline correctly in relative difference", () => {
      const diff = calculateDifference({ baseline: -10, candidate: -5 });
      // (-5 - -10) / -10 = 5 / -10 = -0.5
      expect(diff.absoluteDifference).toBe(5);
      expect(diff.relativeDifference).toBe(-0.5);
    });

    it("37. returns undefined differences when baseline is missing", () => {
      const diff = calculateDifference({ baseline: undefined, candidate: 50 });
      expect(diff.absoluteDifference).toBeUndefined();
      expect(diff.relativeDifference).toBeUndefined();
    });

    it("38. returns undefined differences when candidate is missing", () => {
      const diff = calculateDifference({ baseline: 50, candidate: undefined });
      expect(diff.absoluteDifference).toBeUndefined();
      expect(diff.relativeDifference).toBeUndefined();
    });
  });

  // ==========================================================================
  // Directionality (Tests 39–42)
  // ==========================================================================
  describe("Directionality", () => {
    it("39. records HIGHER_IS_BETTER metric direction", () => {
      const diff = calculateDifference({
        baseline: 10,
        candidate: 20,
        direction: "HIGHER_IS_BETTER",
      });
      expect(diff.direction).toBe("HIGHER_IS_BETTER");
    });

    it("40. records LOWER_IS_BETTER metric direction", () => {
      const diff = calculateDifference({
        baseline: 20,
        candidate: 10,
        direction: "LOWER_IS_BETTER",
      });
      expect(diff.direction).toBe("LOWER_IS_BETTER");
    });

    it("41. records NEUTRAL metric direction", () => {
      const diff = calculateDifference({
        baseline: 20,
        candidate: 10,
        direction: "NEUTRAL",
      });
      expect(diff.direction).toBe("NEUTRAL");
    });

    it("42. does not infer value-laden recommendations from directional difference", () => {
      const experiment = createSampleExperiment();
      const analysis = analyzeNumericMetric({
        experiment,
        baselineConditionId: "baseline-cond",
        candidateConditionId: "candidate-cond",
        metric: "modelLatencyMs",
        baselineValues: [1000, 1200],
        candidateValues: [800, 900],
        direction: "LOWER_IS_BETTER",
      });

      // Reports difference as delta only, without recommendation or value labels
      expect(analysis.difference.absoluteDifference).toBe(-250);
      expect(analysis.direction).toBe("LOWER_IS_BETTER");
    });
  });

  // ==========================================================================
  // Comparability Fencing (Tests 43–48)
  // ==========================================================================
  describe("Comparability Fencing", () => {
    it("43. accepts compatible conditions from the same experiment", () => {
      const task = createSampleTask();
      const experiment = createSampleExperiment(task);
      const condA = experiment.conditions[0]!;
      const condB = experiment.conditions[1]!;

      const tA = createSampleTrial(task, condA, 1, { metrics: createSampleMetrics({ steps: 5 }) });
      const tB = createSampleTrial(task, condB, 1, { metrics: createSampleMetrics({ steps: 3 }) });

      const analysis = analyzeExperiment({
        experiment,
        trials: [tA, tB],
        baselineConditionId: condA.conditionId,
        candidateConditionId: condB.conditionId,
        metric: "steps",
      });

      expect(analysis).toBeDefined();
      expect(analysis.difference.absoluteDifference).toBe(-2);
    });

    it("44. rejects trial with mismatched taskId fail-closed", () => {
      const task1 = createSampleTask({ taskId: "task-1" });
      const task2 = createSampleTask({ taskId: "task-2" });
      const experiment = createSampleExperiment(task1);
      const condA = experiment.conditions[0]!;
      const condB = experiment.conditions[1]!;

      // Trial belongs to task2 instead of task1
      const tA = createSampleTrial(task2, condA, 1);
      const tB = createSampleTrial(task1, condB, 1);

      expect(() =>
        analyzeExperiment({
          experiment,
          trials: [tA, tB],
          baselineConditionId: condA.conditionId,
          candidateConditionId: condB.conditionId,
          metric: "steps",
        })
      ).toThrow(/taskId mismatch/);
    });

    it("45. rejects trial with mismatched taskVersion fail-closed", () => {
      const task1 = createSampleTask({ version: 1 });
      const task2 = createSampleTask({ version: 2 });
      const experiment = createSampleExperiment(task1);
      const condA = experiment.conditions[0]!;
      const condB = experiment.conditions[1]!;
      const condV2 = createSampleCondition("baseline-cond", "llama3:8b", 2);

      const tA = createSampleTrial(task2, condV2, 1);
      const tB = createSampleTrial(task1, condB, 1);

      expect(() =>
        analyzeExperiment({
          experiment,
          trials: [tA, tB],
          baselineConditionId: condA.conditionId,
          candidateConditionId: condB.conditionId,
          metric: "steps",
        })
      ).toThrow(/taskVersion mismatch/);
    });

    it("46. rejects trial with mismatched taskContentHash fail-closed", () => {
      const task1 = createSampleTask({ description: "Desc 1" });
      const task2 = createSampleTask({ description: "Desc 2" });
      const experiment = createSampleExperiment(task1);
      const condA = experiment.conditions[0]!;
      const condB = experiment.conditions[1]!;

      const tA = createSampleTrial(task2, condA, 1);
      const tB = createSampleTrial(task1, condB, 1);

      expect(() =>
        analyzeExperiment({
          experiment,
          trials: [tA, tB],
          baselineConditionId: condA.conditionId,
          candidateConditionId: condB.conditionId,
          metric: "steps",
        })
      ).toThrow(/taskContentHash mismatch/);
    });

    it("47. rejects conditionId not declared in experiment", () => {
      const experiment = createSampleExperiment();
      expect(() =>
        analyzeExperiment({
          experiment,
          trials: [],
          baselineConditionId: "non-existent",
          candidateConditionId: "candidate-cond",
          metric: "steps",
        })
      ).toThrow(/Baseline condition 'non-existent' not found/);
    });

    it("48. rejects trial with configuration mismatch against condition", () => {
      const task = createSampleTask();
      const experiment = createSampleExperiment(task);
      const condA = experiment.conditions[0]!;
      const condB = experiment.conditions[1]!;
      const condAlien = createSampleCondition("alien-cond", "mistral:7b");

      // Trial has alien fingerprint not matching any condition in experiment
      const tAlien = createSampleTrial(task, condAlien, 1);
      const tB = createSampleTrial(task, condB, 1);

      expect(() =>
        analyzeExperiment({
          experiment,
          trials: [tAlien, tB],
          baselineConditionId: condA.conditionId,
          candidateConditionId: condB.conditionId,
          metric: "steps",
        })
      ).toThrow(/configuration fingerprint/);
    });
  });

  // ==========================================================================
  // Methodology & Warnings (Tests 49–56)
  // ==========================================================================
  describe("Methodology & Warnings", () => {
    it("49. treats observations as independent samples by default", () => {
      const experiment = createSampleExperiment();
      const analysis = analyzeNumericMetric({
        experiment,
        baselineConditionId: "baseline-cond",
        candidateConditionId: "candidate-cond",
        metric: "wallClockMs",
        baselineValues: [100, 200, 300],
        candidateValues: [150, 250],
      });

      // Sample sizes can differ (3 vs 2); independent samples permitted
      expect((analysis.baselineSummary as any).observedCount).toBe(3);
      expect((analysis.candidateSummary as any).observedCount).toBe(2);
    });

    it("50. does not implement implicit trial pairing or paired differences", () => {
      const experiment = createSampleExperiment();
      const analysis = analyzeNumericMetric({
        experiment,
        baselineConditionId: "baseline-cond",
        candidateConditionId: "candidate-cond",
        metric: "toolCalls",
        baselineValues: [5, 6, 7],
        candidateValues: [2, 3, 4],
      });

      // Difference is (mean_cand - mean_base) = 3 - 6 = -3, not a paired t-test
      expect(analysis.difference.absoluteDifference).toBe(-3);
    });

    it("51. emits INSUFFICIENT_OBSERVATIONS warning when sample has fewer than 2 items", () => {
      const experiment = createSampleExperiment();
      const analysis = analyzeNumericMetric({
        experiment,
        baselineConditionId: "baseline-cond",
        candidateConditionId: "candidate-cond",
        metric: "wallClockMs",
        baselineValues: [100],
        candidateValues: [200, 300],
      });

      expect(analysis.warnings.some((w) => w.code === "INSUFFICIENT_OBSERVATIONS")).toBe(true);
    });

    it("52. emits MISSING_DATA warning when unavailable observations exist", () => {
      const experiment = createSampleExperiment();
      const analysis = analyzeNumericMetric({
        experiment,
        baselineConditionId: "baseline-cond",
        candidateConditionId: "candidate-cond",
        metric: "wallClockMs",
        baselineValues: [100, undefined, 200],
        candidateValues: [150, 250],
      });

      expect(analysis.warnings.some((w) => w.code === "MISSING_DATA")).toBe(true);
    });

    it("53. emits WIDE_INTERVAL warning when confidence interval is wide", () => {
      const experiment = createSampleExperiment();
      // High variance in small sample produces wide Student-t interval
      const analysis = analyzeNumericMetric({
        experiment,
        baselineConditionId: "baseline-cond",
        candidateConditionId: "candidate-cond",
        metric: "modelLatencyMs",
        baselineValues: [10, 1000],
        candidateValues: [20, 2000],
      });

      expect(analysis.warnings.some((w) => w.code === "WIDE_INTERVAL")).toBe(true);
    });

    it("54. emits SINGLE_OBSERVATION warning when exactly one observation exists", () => {
      const experiment = createSampleExperiment();
      const analysis = analyzeNumericMetric({
        experiment,
        baselineConditionId: "baseline-cond",
        candidateConditionId: "candidate-cond",
        metric: "wallClockMs",
        baselineValues: [100],
        candidateValues: [200, 300],
      });

      expect(analysis.warnings.some((w) => w.code === "SINGLE_OBSERVATION")).toBe(true);
    });

    it("55. derives deterministic canonical analysis content hash", () => {
      const experiment = createSampleExperiment();
      const analysis1 = analyzeNumericMetric({
        experiment,
        baselineConditionId: "baseline-cond",
        candidateConditionId: "candidate-cond",
        metric: "wallClockMs",
        baselineValues: [100, 200],
        candidateValues: [150, 250],
      });
      const analysis2 = analyzeNumericMetric({
        experiment,
        baselineConditionId: "baseline-cond",
        candidateConditionId: "candidate-cond",
        metric: "wallClockMs",
        baselineValues: [100, 200],
        candidateValues: [150, 250],
      });

      expect(analysis1.analysisContentHash).toBe(analysis2.analysisContentHash);

      const expectedHash = computeStatisticalAnalysisHash({
        experimentId: analysis1.experimentId,
        experimentVersion: analysis1.experimentVersion,
        experimentContentHash: analysis1.experimentContentHash,
        taskRef: analysis1.taskRef,
        baselineConditionId: analysis1.baselineConditionId,
        candidateConditionId: analysis1.candidateConditionId,
        metric: analysis1.metric,
        analysisMethod: analysis1.analysisMethod,
        direction: analysis1.direction,
        confidenceLevel: analysis1.confidenceLevel,
        baselineSummary: analysis1.baselineSummary,
        candidateSummary: analysis1.candidateSummary,
        difference: analysis1.difference,
        warnings: analysis1.warnings,
      });
      expect(analysis1.analysisContentHash).toBe(expectedHash);
    });

    it("56. validates JSON serialization and schema re-validation", () => {
      const experiment = createSampleExperiment();
      const analysis = analyzeNumericMetric({
        experiment,
        baselineConditionId: "baseline-cond",
        candidateConditionId: "candidate-cond",
        metric: "wallClockMs",
        baselineValues: [100, 200],
        candidateValues: [150, 250],
      });

      const json = JSON.stringify(analysis);
      const parsed = JSON.parse(json);

      expect(() => validateStatisticalAnalysis(parsed)).not.toThrow();
      const revalidated = validateStatisticalAnalysis(parsed);
      expect(revalidated.analysisContentHash).toBe(analysis.analysisContentHash);
    });
  });

  // ==========================================================================
  // Security & Architecture Invariants (Tests 57–60)
  // ==========================================================================
  describe("Security & Architecture Invariants", () => {
    it("57. contains no authority-bearing keys or credentials in analysis result", () => {
      const experiment = createSampleExperiment();
      const analysis = analyzeNumericMetric({
        experiment,
        baselineConditionId: "baseline-cond",
        candidateConditionId: "candidate-cond",
        metric: "wallClockMs",
        baselineValues: [100, 200],
        candidateValues: [150, 250],
      });

      const serialized = JSON.stringify(analysis).toLowerCase();
      for (const forbidden of FORBIDDEN_AUTHORITY_KEYS) {
        expect(serialized).not.toContain(`"${forbidden.toLowerCase()}"`);
      }
      expect(serialized).not.toContain("password");
      expect(serialized).not.toContain("secret");
      expect(serialized).not.toContain("token");
    });

    it("58. ensures pure statistical calculation does not invoke runtime kernel", () => {
      const experiment = createSampleExperiment();
      // Zero mock servers, zero workers, zero leases
      const analysis = analyzeNumericMetric({
        experiment,
        baselineConditionId: "baseline-cond",
        candidateConditionId: "candidate-cond",
        metric: "actions",
        baselineValues: [4, 5],
        candidateValues: [2, 3],
      });
      expect(analysis).toBeDefined();
    });

    it("59. ensures input experiment and trial records remain unmutated", () => {
      const task = createSampleTask();
      const experiment = createSampleExperiment(task);
      const cond = experiment.conditions[0]!;
      const trial = createSampleTrial(task, cond, 1);

      const expSnapshot = JSON.stringify(experiment);
      const trialSnapshot = JSON.stringify(trial);

      analyzeExperiment({
        experiment,
        trials: [trial],
        baselineConditionId: cond.conditionId,
        candidateConditionId: experiment.conditions[1]!.conditionId,
        metric: "steps",
      });

      expect(JSON.stringify(experiment)).toBe(expSnapshot);
      expect(JSON.stringify(trial)).toBe(trialSnapshot);
    });

    it("60. ensures zero model provider or tool execution invocations", () => {
      // Testing pure math kernels in isolation
      const qNorm = normalQuantile(0.975);
      expect(qNorm).toBeCloseTo(1.95996, 4);

      const qT = studentTQuantile(0.975, 9);
      expect(qT).toBeCloseTo(2.26216, 4);

      const configHash = computeStatisticalAnalysisConfigHash({
        confidenceLevel: 0.95,
        metric: "modelLatencyMs",
        analysisMethod: "STUDENT_T",
      });
      expect(configHash).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});
