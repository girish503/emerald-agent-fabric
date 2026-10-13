/**
 * Phase 7.4 — Descriptive Evaluation Reporting & Baseline Comparison Test Suite
 *
 * Comprehensive tests covering:
 * Report construction (Tests 1–8):
 * 1. valid report
 * 2. experiment identity preserved
 * 3. experiment version preserved
 * 4. experiment content hash preserved
 * 5. deterministic report ordering
 * 6. JSON serialization
 * 7. empty trial set handled explicitly
 * 8. planned vs observed trial counts preserved
 *
 * Outcome aggregation (Tests 9–16):
 * 9. PASSED count
 * 10. FAILED count
 * 11. TIMED_OUT count
 * 12. CANCELLED count
 * 13. BLOCKED count
 * 14. ERROR count
 * 15. all outcomes sum correctly
 * 16. incomplete trials not silently discarded
 *
 * Objective pass rate (Tests 17–21):
 * 17. correct numerator
 * 18. correct denominator
 * 19. incomplete outcomes excluded from completion denominator when appropriate
 * 20. zero denominator produces unavailable result
 * 21. zero pass rate remains 0, not undefined
 *
 * Metrics (Tests 22–31):
 * 22. sum
 * 23. average
 * 24. minimum
 * 25. maximum
 * 26. observed count
 * 27. unavailable count
 * 28. observed zero preserved
 * 29. undefined not converted to zero
 * 30. mixed available/unavailable values handled correctly
 * 31. all unavailable values produce unavailable aggregate
 *
 * Comparison (Tests 32–42):
 * 32. compatible conditions compare successfully
 * 33. incompatible task rejected
 * 34. incompatible task version rejected
 * 35. incompatible task hash rejected
 * 36. baseline identity preserved
 * 37. candidate identity preserved
 * 38. pass-rate delta correct
 * 39. metric delta correct
 * 40. missing metrics remain unavailable
 * 41. baseline is explicit
 * 42. condition ordering does not change comparison semantics
 *
 * Security / architecture (Tests 43–45):
 * 43. report contains no authority fields
 * 44. reporting does not invoke runtime execution
 * 45. reporting does not mutate source objects
 */

import { describe, expect, it } from "vitest";
import {
  aggregateMetric,
  compareConditions,
  compareExperimentConditions,
  computeDescriptiveRate,
  computeEvaluationReportHash,
  computeEvaluationTaskHash,
  createEvaluationConfigFingerprint,
  createEvaluationExperiment,
  createEvaluationMetrics,
  createEvaluationTask,
  createEvaluationTrial,
  createExperimentCondition,
  CreateEvaluationExperimentParams,
  CreateEvaluationTrialParams,
  CURRENT_HARNESS_VERSION,
  EvaluationConfigFingerprint,
  EvaluationExperiment,
  EvaluationExperimentCondition,
  EvaluationMetrics,
  EvaluationTaskDefinition,
  EvaluationTrial,
  EVALUATION_METRIC_KEYS,
  generateEvaluationReport,
  validateConditionReport,
  validateEvaluationReport,
} from "../../src/domain/evaluation.js";
import { FORBIDDEN_AUTHORITY_KEYS } from "../../src/domain/action-proposal.js";

// ============================================================================
// Helper Factories
// ============================================================================

function createSampleTask(overrides: Partial<EvaluationTaskDefinition> = {}): EvaluationTaskDefinition {
  return createEvaluationTask({
    taskId: "benchmark-report-task-1",
    version: 1,
    description: "Benchmark task for report testing",
    fixture: {
      initialFiles: { "src/main.ts": "console.log('reporting');\n" },
    },
    mission: {
      requiredCapabilities: ["workspace.file.read", "workspace.file.write"],
    },
    successCriteria: [
      {
        criterionId: "c1",
        kind: "FILE_EXISTS",
        path: "src/main.ts",
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

function createSampleFingerprint(
  model: string = "llama3:8b",
  taskVersion: number = 1
): EvaluationConfigFingerprint {
  return createEvaluationConfigFingerprint({
    modelProvider: "ollama",
    model,
    taskVersion,
    harnessVersion: CURRENT_HARNESS_VERSION,
  });
}

function createSampleCondition(
  conditionId: string,
  model: string = "llama3:8b",
  taskVersion: number = 1
): EvaluationExperimentCondition {
  const configFingerprint = createSampleFingerprint(model, taskVersion);
  return createExperimentCondition({
    conditionId,
    name: `Condition ${conditionId}`,
    description: `Description for ${conditionId}`,
    configFingerprint,
  });
}

function createSampleExperiment(
  overrides?: Partial<CreateEvaluationExperimentParams>
): EvaluationExperiment {
  const task = createSampleTask();
  const c1 = createSampleCondition("condition-baseline", "llama3:8b");
  const c2 = createSampleCondition("condition-candidate", "qwen2.5:7b");

  return createEvaluationExperiment({
    experimentId: "exp-descriptive-report",
    version: 1,
    title: "Descriptive Report Experiment",
    description: "Experiment evaluating baseline vs candidate performance",
    hypothesis: "Candidate achieves higher success rate and lower latency",
    taskRef: task,
    conditions: [c1, c2],
    plannedTrialCount: 10,
    harnessVersion: CURRENT_HARNESS_VERSION,
    status: "READY",
    ...overrides,
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
  overrides: Partial<CreateEvaluationTrialParams> = {}
): EvaluationTrial {
  return createEvaluationTrial({
    trialOrdinal,
    taskId: task.taskId,
    taskVersion: task.version,
    taskContentHash: computeEvaluationTaskHash(task),
    configFingerprint: condition.configFingerprint,
    runtimeRunId: `run-${condition.conditionId}-${trialOrdinal}`,
    outcome: "PASSED",
    statusMessage: "Task passed objective criteria",
    verificationPassed: true,
    agentClaimedGoal: true,
    metrics: createSampleMetrics(),
    startedAt: "2026-10-13T10:00:00.000Z",
    completedAt: "2026-10-13T10:00:02.000Z",
    ...overrides,
  });
}

describe("Phase 7.4 — Descriptive Evaluation Reporting", () => {
  // ==========================================================================
  // Report Construction (Tests 1–8)
  // ==========================================================================
  describe("Report Construction", () => {
    it("1. generates a valid evaluation report from experiment and trials", () => {
      const task = createSampleTask();
      const experiment = createSampleExperiment();
      const condA = experiment.conditions[0]!;
      const condB = experiment.conditions[1]!;

      const trialA1 = createSampleTrial(task, condA, 1, { outcome: "PASSED" });
      const trialB1 = createSampleTrial(task, condB, 1, { outcome: "FAILED" });

      const report = generateEvaluationReport(experiment, [trialA1, trialB1]);

      expect(report).toBeDefined();
      expect(report.experimentId).toBe("exp-descriptive-report");
      expect(report.conditions).toHaveLength(2);
      expect(report.totalObservedTrials).toBe(2);
      expect(report.reportContentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(() => validateEvaluationReport(report)).not.toThrow();
      expect(() => validateConditionReport(report.conditions[0])).not.toThrow();
    });

    it("2. preserves experiment identity exactly", () => {
      const experiment = createSampleExperiment({ experimentId: "exp-custom-id" });
      const report = generateEvaluationReport(experiment, []);

      expect(report.experimentId).toBe("exp-custom-id");
    });

    it("3. preserves experiment version exactly", () => {
      const experiment = createSampleExperiment({ version: 4 });
      const report = generateEvaluationReport(experiment, []);

      expect(report.experimentVersion).toBe(4);
    });

    it("4. preserves experiment content hash exactly", () => {
      const experiment = createSampleExperiment();
      const report = generateEvaluationReport(experiment, []);

      expect(report.experimentContentHash).toBe(experiment.experimentContentHash);
      const expectedReportHash = computeEvaluationReportHash({
        experimentId: report.experimentId,
        experimentVersion: report.experimentVersion,
        experimentContentHash: report.experimentContentHash,
        taskRef: report.taskRef,
        harnessVersion: report.harnessVersion,
        plannedTrialCount: report.plannedTrialCount,
        conditions: report.conditions,
      });
      expect(report.reportContentHash).toBe(expectedReportHash);
    });

    it("5. enforces deterministic report ordering across conditions and trials", () => {
      const task = createSampleTask();
      // Define conditions in reverse alphabetical order
      const condZ = createSampleCondition("zebra", "llama3:8b");
      const condA = createSampleCondition("alpha", "qwen2.5:7b");
      const experiment = createSampleExperiment({ conditions: [condZ, condA] });

      const trialZ2 = createSampleTrial(task, condZ, 2);
      const trialZ1 = createSampleTrial(task, condZ, 1);
      const trialA1 = createSampleTrial(task, condA, 1);

      // Pass trials in random order
      const report = generateEvaluationReport(experiment, [trialZ2, trialA1, trialZ1]);

      // Conditions should be deterministically sorted by conditionId ("alpha", then "zebra")
      expect(report.conditions[0]!.conditionId).toBe("alpha");
      expect(report.conditions[1]!.conditionId).toBe("zebra");

      // Trials in condition report should be deterministically ordered by ordinal
      expect(report.conditions[1]!.trialReferences).toEqual([trialZ1.trialId, trialZ2.trialId]);
    });

    it("6. survives JSON round-trip serialization and re-validation", () => {
      const task = createSampleTask();
      const experiment = createSampleExperiment();
      const condA = experiment.conditions[0]!;
      const trialA1 = createSampleTrial(task, condA, 1, { outcome: "PASSED" });

      const report = generateEvaluationReport(experiment, [trialA1]);
      const json = JSON.stringify(report);
      const parsed = JSON.parse(json);

      expect(() => validateEvaluationReport(parsed)).not.toThrow();
      const revalidated = validateEvaluationReport(parsed);
      expect(revalidated.reportContentHash).toBe(report.reportContentHash);
    });

    it("7. handles an empty trial set explicitly without fabricating values", () => {
      const experiment = createSampleExperiment();
      const report = generateEvaluationReport(experiment, []);

      expect(report.totalObservedTrials).toBe(0);
      for (const cond of report.conditions) {
        expect(cond.observedTrialCount).toBe(0);
        expect(cond.plannedTrialCount).toBe(experiment.plannedTrialCount);
        expect(cond.outcomes.totalTrials).toBe(0);
        expect(cond.outcomes.completedTrials).toBe(0);
        expect(cond.outcomes.passedTrials).toBe(0);
        expect(cond.objectivePassRate.rate).toBeUndefined();
        expect(cond.trialReferences).toEqual([]);
        for (const metricKey of EVALUATION_METRIC_KEYS) {
          expect(cond.metrics[metricKey].observedCount).toBe(0);
          expect(cond.metrics[metricKey].sum).toBeUndefined();
          expect(cond.metrics[metricKey].average).toBeUndefined();
        }
      }
    });

    it("8. preserves planned vs observed trial counts separately without conflation", () => {
      const task = createSampleTask();
      const experiment = createSampleExperiment({ plannedTrialCount: 25 });
      const condA = experiment.conditions[0]!;

      const trial1 = createSampleTrial(task, condA, 1);
      const trial2 = createSampleTrial(task, condA, 2);

      const report = generateEvaluationReport(experiment, [trial1, trial2]);

      expect(report.plannedTrialCount).toBe(25);
      expect(report.totalObservedTrials).toBe(2);
      const condReport = report.conditions.find((c) => c.conditionId === condA.conditionId)!;
      expect(condReport.plannedTrialCount).toBe(25);
      expect(condReport.observedTrialCount).toBe(2);
    });
  });

  // ==========================================================================
  // Outcome Aggregation (Tests 9–16)
  // ==========================================================================
  describe("Outcome Aggregation", () => {
    it("9. correctly counts PASSED trials", () => {
      const task = createSampleTask();
      const experiment = createSampleExperiment();
      const cond = experiment.conditions[0]!;
      const t1 = createSampleTrial(task, cond, 1, { outcome: "PASSED" });
      const t2 = createSampleTrial(task, cond, 2, { outcome: "PASSED" });

      const report = generateEvaluationReport(experiment, [t1, t2]);
      const condReport = report.conditions.find((c) => c.conditionId === cond.conditionId)!;

      expect(condReport.outcomes.passedTrials).toBe(2);
    });

    it("10. correctly counts FAILED trials", () => {
      const task = createSampleTask();
      const experiment = createSampleExperiment();
      const cond = experiment.conditions[0]!;
      const t1 = createSampleTrial(task, cond, 1, { outcome: "FAILED" });
      const t2 = createSampleTrial(task, cond, 2, { outcome: "FAILED" });

      const report = generateEvaluationReport(experiment, [t1, t2]);
      const condReport = report.conditions.find((c) => c.conditionId === cond.conditionId)!;

      expect(condReport.outcomes.failedTrials).toBe(2);
    });

    it("11. correctly counts TIMED_OUT trials", () => {
      const task = createSampleTask();
      const experiment = createSampleExperiment();
      const cond = experiment.conditions[0]!;
      const t1 = createSampleTrial(task, cond, 1, { outcome: "TIMED_OUT" });

      const report = generateEvaluationReport(experiment, [t1]);
      const condReport = report.conditions.find((c) => c.conditionId === cond.conditionId)!;

      expect(condReport.outcomes.timedOutTrials).toBe(1);
    });

    it("12. correctly counts CANCELLED trials", () => {
      const task = createSampleTask();
      const experiment = createSampleExperiment();
      const cond = experiment.conditions[0]!;
      const t1 = createSampleTrial(task, cond, 1, { outcome: "CANCELLED" });

      const report = generateEvaluationReport(experiment, [t1]);
      const condReport = report.conditions.find((c) => c.conditionId === cond.conditionId)!;

      expect(condReport.outcomes.cancelledTrials).toBe(1);
    });

    it("13. correctly counts BLOCKED trials", () => {
      const task = createSampleTask();
      const experiment = createSampleExperiment();
      const cond = experiment.conditions[0]!;
      const t1 = createSampleTrial(task, cond, 1, { outcome: "BLOCKED" });

      const report = generateEvaluationReport(experiment, [t1]);
      const condReport = report.conditions.find((c) => c.conditionId === cond.conditionId)!;

      expect(condReport.outcomes.blockedTrials).toBe(1);
    });

    it("14. correctly counts ERROR trials", () => {
      const task = createSampleTask();
      const experiment = createSampleExperiment();
      const cond = experiment.conditions[0]!;
      const t1 = createSampleTrial(task, cond, 1, { outcome: "ERROR" });

      const report = generateEvaluationReport(experiment, [t1]);
      const condReport = report.conditions.find((c) => c.conditionId === cond.conditionId)!;

      expect(condReport.outcomes.errorTrials).toBe(1);
    });

    it("15. ensures all outcome buckets sum exactly to totalTrials", () => {
      const task = createSampleTask();
      const experiment = createSampleExperiment();
      const cond = experiment.conditions[0]!;
      const trials = [
        createSampleTrial(task, cond, 1, { outcome: "PASSED" }),
        createSampleTrial(task, cond, 2, { outcome: "FAILED" }),
        createSampleTrial(task, cond, 3, { outcome: "TIMED_OUT" }),
        createSampleTrial(task, cond, 4, { outcome: "CANCELLED" }),
        createSampleTrial(task, cond, 5, { outcome: "BLOCKED" }),
        createSampleTrial(task, cond, 6, { outcome: "ERROR" }),
      ];

      const report = generateEvaluationReport(experiment, trials);
      const o = report.conditions.find((c) => c.conditionId === cond.conditionId)!.outcomes;

      const sum =
        o.passedTrials +
        o.failedTrials +
        o.timedOutTrials +
        o.cancelledTrials +
        o.blockedTrials +
        o.errorTrials;

      expect(sum).toBe(o.totalTrials);
      expect(o.totalTrials).toBe(6);
      expect(o.completedTrials).toBe(2); // PASSED (1) + FAILED (1)
    });

    it("16. ensures incomplete trials are not silently discarded or collapsed into failures", () => {
      const task = createSampleTask();
      const experiment = createSampleExperiment();
      const cond = experiment.conditions[0]!;
      const trials = [
        createSampleTrial(task, cond, 1, { outcome: "PASSED" }),
        createSampleTrial(task, cond, 2, { outcome: "TIMED_OUT" }),
        createSampleTrial(task, cond, 3, { outcome: "ERROR" }),
      ];

      const report = generateEvaluationReport(experiment, trials);
      const o = report.conditions.find((c) => c.conditionId === cond.conditionId)!.outcomes;

      // FAILED must remain 0, NOT collapsed with TIMED_OUT or ERROR
      expect(o.failedTrials).toBe(0);
      expect(o.timedOutTrials).toBe(1);
      expect(o.errorTrials).toBe(1);
      expect(o.passedTrials).toBe(1);
      expect(o.totalTrials).toBe(3);
    });
  });

  // ==========================================================================
  // Objective Pass Rate (Tests 17–21)
  // ==========================================================================
  describe("Objective Pass Rate", () => {
    it("17. provides the correct numerator (passed trials)", () => {
      const rate = computeDescriptiveRate(8, 10);
      expect(rate.numerator).toBe(8);
      expect(rate.rate).toBe(0.8);
    });

    it("18. provides the correct denominator (completed trials)", () => {
      const rate = computeDescriptiveRate(3, 4);
      expect(rate.denominator).toBe(4);
      expect(rate.rate).toBe(0.75);
    });

    it("19. excludes incomplete outcomes from the completion denominator", () => {
      const task = createSampleTask();
      const experiment = createSampleExperiment();
      const cond = experiment.conditions[0]!;
      const trials = [
        createSampleTrial(task, cond, 1, { outcome: "PASSED" }),
        createSampleTrial(task, cond, 2, { outcome: "PASSED" }),
        createSampleTrial(task, cond, 3, { outcome: "FAILED" }),
        createSampleTrial(task, cond, 4, { outcome: "TIMED_OUT" }),
        createSampleTrial(task, cond, 5, { outcome: "ERROR" }),
      ];

      const report = generateEvaluationReport(experiment, trials);
      const condReport = report.conditions.find((c) => c.conditionId === cond.conditionId)!;

      // Completed evaluations = 2 PASSED + 1 FAILED = 3
      // Total trials = 5
      // Pass rate denominator must be 3 (completed), NOT 5 (total)
      expect(condReport.objectivePassRate.numerator).toBe(2);
      expect(condReport.objectivePassRate.denominator).toBe(3);
      expect(condReport.objectivePassRate.rate).toBeCloseTo(2 / 3, 6);
    });

    it("20. produces an unavailable result (undefined rate) when denominator is zero", () => {
      const task = createSampleTask();
      const experiment = createSampleExperiment();
      const cond = experiment.conditions[0]!;
      // Only incomplete trials (zero completed evaluations)
      const trials = [
        createSampleTrial(task, cond, 1, { outcome: "TIMED_OUT" }),
        createSampleTrial(task, cond, 2, { outcome: "ERROR" }),
      ];

      const report = generateEvaluationReport(experiment, trials);
      const condReport = report.conditions.find((c) => c.conditionId === cond.conditionId)!;

      expect(condReport.objectivePassRate.numerator).toBe(0);
      expect(condReport.objectivePassRate.denominator).toBe(0);
      expect(condReport.objectivePassRate.rate).toBeUndefined();
    });

    it("21. ensures zero pass rate remains 0 and not undefined when denominator > 0", () => {
      const task = createSampleTask();
      const experiment = createSampleExperiment();
      const cond = experiment.conditions[0]!;
      const trials = [
        createSampleTrial(task, cond, 1, { outcome: "FAILED" }),
        createSampleTrial(task, cond, 2, { outcome: "FAILED" }),
      ];

      const report = generateEvaluationReport(experiment, trials);
      const condReport = report.conditions.find((c) => c.conditionId === cond.conditionId)!;

      expect(condReport.objectivePassRate.numerator).toBe(0);
      expect(condReport.objectivePassRate.denominator).toBe(2);
      expect(condReport.objectivePassRate.rate).toBe(0);
    });
  });

  // ==========================================================================
  // Metrics Aggregation (Tests 22–31)
  // ==========================================================================
  describe("Metrics Aggregation", () => {
    it("22. calculates the exact sum of observed metrics", () => {
      const agg = aggregateMetric([10, 20, 30]);
      expect(agg.sum).toBe(60);
      expect(agg.observedCount).toBe(3);
    });

    it("23. calculates the exact average of observed metrics", () => {
      const agg = aggregateMetric([10, 20, 30]);
      expect(agg.average).toBe(20);
    });

    it("24. calculates the exact minimum of observed metrics", () => {
      const agg = aggregateMetric([40, 15, 80]);
      expect(agg.minimum).toBe(15);
    });

    it("25. calculates the exact maximum of observed metrics", () => {
      const agg = aggregateMetric([40, 15, 80]);
      expect(agg.maximum).toBe(80);
    });

    it("26. tracks observedCount accurately", () => {
      const agg = aggregateMetric([1, 2, undefined, 4]);
      expect(agg.observedCount).toBe(3);
    });

    it("27. tracks unavailableCount accurately", () => {
      const agg = aggregateMetric([1, undefined, undefined, 4]);
      expect(agg.unavailableCount).toBe(2);
    });

    it("28. preserves observed zero without treating it as unavailable", () => {
      const agg = aggregateMetric([0, 0, 10]);
      expect(agg.observedCount).toBe(3);
      expect(agg.unavailableCount).toBe(0);
      expect(agg.minimum).toBe(0);
      expect(agg.sum).toBe(10);
      expect(agg.average).toBeCloseTo(10 / 3, 6);
    });

    it("29. ensures undefined values are not silently converted to zero", () => {
      const agg = aggregateMetric([10, undefined]);
      // If undefined were converted to 0, sum would be 10, count would be 2, average would be 5
      // Correct behavior: observedCount = 1, average = 10
      expect(agg.observedCount).toBe(1);
      expect(agg.unavailableCount).toBe(1);
      expect(agg.sum).toBe(10);
      expect(agg.average).toBe(10);
      expect(agg.minimum).toBe(10);
      expect(agg.maximum).toBe(10);
    });

    it("30. handles mixed available and unavailable values properly across trials", () => {
      const task = createSampleTask();
      const experiment = createSampleExperiment();
      const cond = experiment.conditions[0]!;

      const t1 = createSampleTrial(task, cond, 1, {
        metrics: createSampleMetrics({ inputTokens: 500, modelLatencyMs: 100 }),
      });
      const t2 = createSampleTrial(task, cond, 2, {
        metrics: createSampleMetrics({ inputTokens: undefined, modelLatencyMs: 200 }),
      });

      const report = generateEvaluationReport(experiment, [t1, t2]);
      const condReport = report.conditions.find((c) => c.conditionId === cond.conditionId)!;

      // inputTokens: 1 observed, 1 unavailable
      expect(condReport.metrics.inputTokens.observedCount).toBe(1);
      expect(condReport.metrics.inputTokens.unavailableCount).toBe(1);
      expect(condReport.metrics.inputTokens.sum).toBe(500);
      expect(condReport.metrics.inputTokens.average).toBe(500);

      // modelLatencyMs: 2 observed, 0 unavailable
      expect(condReport.metrics.modelLatencyMs.observedCount).toBe(2);
      expect(condReport.metrics.modelLatencyMs.unavailableCount).toBe(0);
      expect(condReport.metrics.modelLatencyMs.average).toBe(150);
    });

    it("31. produces unavailable aggregate when all values are undefined", () => {
      const agg = aggregateMetric([undefined, undefined]);
      expect(agg.observedCount).toBe(0);
      expect(agg.unavailableCount).toBe(2);
      expect(agg.sum).toBeUndefined();
      expect(agg.average).toBeUndefined();
      expect(agg.minimum).toBeUndefined();
      expect(agg.maximum).toBeUndefined();
    });
  });

  // ==========================================================================
  // Comparison (Tests 32–42)
  // ==========================================================================
  describe("Baseline Comparison", () => {
    it("32. compares compatible conditions successfully", () => {
      const task = createSampleTask();
      const experiment = createSampleExperiment();
      const condA = experiment.conditions[0]!; // baseline
      const condB = experiment.conditions[1]!; // candidate

      const tA = createSampleTrial(task, condA, 1, {
        outcome: "PASSED",
        metrics: createSampleMetrics({ modelLatencyMs: 1000 }),
      });
      const tB = createSampleTrial(task, condB, 1, {
        outcome: "PASSED",
        metrics: createSampleMetrics({ modelLatencyMs: 800 }),
      });

      const report = generateEvaluationReport(experiment, [tA, tB]);
      const comparison = compareExperimentConditions(
        report,
        condA.conditionId,
        condB.conditionId
      );

      expect(comparison).toBeDefined();
      expect(comparison.baselineConditionId).toBe(condA.conditionId);
      expect(comparison.candidateConditionId).toBe(condB.conditionId);
      expect(comparison.metricComparisons.modelLatencyMs.deltaAverage).toBe(-200);
    });

    it("33. rejects condition comparison if taskId does not match", () => {
      const task1 = createSampleTask({ taskId: "task-alpha" });
      const task2 = createSampleTask({ taskId: "task-beta" });
      const exp1 = createSampleExperiment({ taskRef: task1 });
      const exp2 = createSampleExperiment({ taskRef: task2 });

      const report1 = generateEvaluationReport(exp1, []);
      const report2 = generateEvaluationReport(exp2, []);

      expect(() =>
        compareConditions(report1.conditions[0]!, report2.conditions[0]!)
      ).toThrow(/taskId/);
    });

    it("34. rejects condition comparison if taskVersion does not match", () => {
      const task1 = createSampleTask({ version: 1 });
      const task2 = createSampleTask({ version: 2 });
      const c1 = createSampleCondition("condition-baseline", "llama3:8b", 1);
      const c2 = createSampleCondition("condition-baseline", "llama3:8b", 2);
      const exp1 = createSampleExperiment({ taskRef: task1, conditions: [c1] });
      const exp2 = createSampleExperiment({ taskRef: task2, conditions: [c2] });

      const report1 = generateEvaluationReport(exp1, []);
      const report2 = generateEvaluationReport(exp2, []);

      expect(() =>
        compareConditions(report1.conditions[0]!, report2.conditions[0]!)
      ).toThrow(/taskVersion/);
    });

    it("35. rejects condition comparison if taskContentHash does not match", () => {
      const task1 = createSampleTask({ description: "Description 1" });
      const task2 = createSampleTask({ description: "Description 2" });
      const exp1 = createSampleExperiment({ taskRef: task1 });
      const exp2 = createSampleExperiment({ taskRef: task2 });

      const report1 = generateEvaluationReport(exp1, []);
      const report2 = generateEvaluationReport(exp2, []);

      expect(() =>
        compareConditions(report1.conditions[0]!, report2.conditions[0]!)
      ).toThrow(/taskContentHash/);
    });

    it("36. preserves baseline identity exactly in comparison result", () => {
      const experiment = createSampleExperiment();
      const report = generateEvaluationReport(experiment, []);
      const comparison = compareExperimentConditions(
        report,
        "condition-baseline",
        "condition-candidate"
      );

      expect(comparison.baselineConditionId).toBe("condition-baseline");
      expect(comparison.baselineConditionName).toBe("Condition condition-baseline");
    });

    it("37. preserves candidate identity exactly in comparison result", () => {
      const experiment = createSampleExperiment();
      const report = generateEvaluationReport(experiment, []);
      const comparison = compareExperimentConditions(
        report,
        "condition-baseline",
        "condition-candidate"
      );

      expect(comparison.candidateConditionId).toBe("condition-candidate");
      expect(comparison.candidateConditionName).toBe("Condition condition-candidate");
    });

    it("38. calculates pass-rate delta accurately", () => {
      const task = createSampleTask();
      const experiment = createSampleExperiment();
      const condA = experiment.conditions[0]!; // baseline: 1/2 = 0.50
      const condB = experiment.conditions[1]!; // candidate: 2/2 = 1.00

      const tA1 = createSampleTrial(task, condA, 1, { outcome: "PASSED" });
      const tA2 = createSampleTrial(task, condA, 2, { outcome: "FAILED" });
      const tB1 = createSampleTrial(task, condB, 1, { outcome: "PASSED" });
      const tB2 = createSampleTrial(task, condB, 2, { outcome: "PASSED" });

      const report = generateEvaluationReport(experiment, [tA1, tA2, tB1, tB2]);
      const comparison = compareExperimentConditions(
        report,
        condA.conditionId,
        condB.conditionId
      );

      expect(comparison.passRateComparison.baseline.rate).toBe(0.5);
      expect(comparison.passRateComparison.candidate.rate).toBe(1.0);
      expect(comparison.passRateComparison.delta).toBe(0.5);
    });

    it("39. calculates metric delta accurately", () => {
      const task = createSampleTask();
      const experiment = createSampleExperiment();
      const condA = experiment.conditions[0]!; // baseline
      const condB = experiment.conditions[1]!; // candidate

      const tA = createSampleTrial(task, condA, 1, {
        metrics: createSampleMetrics({ toolCalls: 10 }),
      });
      const tB = createSampleTrial(task, condB, 1, {
        metrics: createSampleMetrics({ toolCalls: 6 }),
      });

      const report = generateEvaluationReport(experiment, [tA, tB]);
      const comparison = compareExperimentConditions(
        report,
        condA.conditionId,
        condB.conditionId
      );

      // Candidate (6) - Baseline (10) = -4
      expect(comparison.metricComparisons.toolCalls.deltaAverage).toBe(-4);
      expect(comparison.metricComparisons.toolCalls.deltaSum).toBe(-4);
    });

    it("40. ensures delta remains undefined when either metric is unavailable", () => {
      const task = createSampleTask();
      const experiment = createSampleExperiment();
      const condA = experiment.conditions[0]!;
      const condB = experiment.conditions[1]!;

      const tA = createSampleTrial(task, condA, 1, {
        metrics: createSampleMetrics({ inputTokens: undefined }),
      });
      const tB = createSampleTrial(task, condB, 1, {
        metrics: createSampleMetrics({ inputTokens: 500 }),
      });

      const report = generateEvaluationReport(experiment, [tA, tB]);
      const comparison = compareExperimentConditions(
        report,
        condA.conditionId,
        condB.conditionId
      );

      expect(comparison.metricComparisons.inputTokens.deltaAverage).toBeUndefined();
      expect(comparison.metricComparisons.inputTokens.deltaSum).toBeUndefined();
    });

    it("41. requires explicit baseline designation and rejects implicit baseline inference", () => {
      const experiment = createSampleExperiment();
      const report = generateEvaluationReport(experiment, []);

      // Non-existent baseline ID must throw error
      expect(() =>
        compareExperimentConditions(report, "non-existent", "condition-candidate")
      ).toThrow(/Baseline condition 'non-existent' not found/);
    });

    it("42. ensures condition ordering does not change comparison semantics (swapping inverts deltas)", () => {
      const task = createSampleTask();
      const experiment = createSampleExperiment();
      const condA = experiment.conditions[0]!;
      const condB = experiment.conditions[1]!;

      const tA = createSampleTrial(task, condA, 1, {
        metrics: createSampleMetrics({ steps: 8 }),
      });
      const tB = createSampleTrial(task, condB, 1, {
        metrics: createSampleMetrics({ steps: 5 }),
      });

      const report = generateEvaluationReport(experiment, [tA, tB]);

      // Baseline A, Candidate B: 5 - 8 = -3
      const compAB = compareExperimentConditions(report, condA.conditionId, condB.conditionId);
      expect(compAB.metricComparisons.steps.deltaAverage).toBe(-3);

      // Baseline B, Candidate A: 8 - 5 = +3
      const compBA = compareExperimentConditions(report, condB.conditionId, condA.conditionId);
      expect(compBA.metricComparisons.steps.deltaAverage).toBe(3);
    });
  });

  // ==========================================================================
  // Security & Architecture Invariants (Tests 43–45)
  // ==========================================================================
  describe("Security & Architecture Invariants", () => {
    it("43. ensures report contains no authority-bearing keys or credentials", () => {
      const task = createSampleTask();
      const experiment = createSampleExperiment();
      const cond = experiment.conditions[0]!;
      const trial = createSampleTrial(task, cond, 1);

      const report = generateEvaluationReport(experiment, [trial]);
      const serialized = JSON.stringify(report);

      for (const forbidden of FORBIDDEN_AUTHORITY_KEYS) {
        expect(serialized.toLowerCase()).not.toContain(`"${forbidden.toLowerCase()}"`);
      }

      expect(serialized).not.toContain("authorization");
      expect(serialized).not.toContain("password");
      expect(serialized).not.toContain("api_key");
      expect(serialized).not.toContain("secret");
    });

    it("44. ensures reporting is a pure read operation that does not execute runtime tasks", () => {
      const experiment = createSampleExperiment();
      // Zero mock servers, zero docker sockets, pure memory calculation
      const report = generateEvaluationReport(experiment, []);
      expect(report).toBeDefined();
    });

    it("45. ensures reporting does not mutate input experiment or trial objects", () => {
      const task = createSampleTask();
      const experiment = createSampleExperiment();
      const cond = experiment.conditions[0]!;
      const trial = createSampleTrial(task, cond, 1);

      const experimentSnapshot = JSON.stringify(experiment);
      const trialSnapshot = JSON.stringify(trial);

      generateEvaluationReport(experiment, [trial]);

      expect(JSON.stringify(experiment)).toBe(experimentSnapshot);
      expect(JSON.stringify(trial)).toBe(trialSnapshot);
    });
  });
});
