/**
 * Milestone 2.25 Phase 4 — Evaluation Metrics, Aggregation, and Reporting Tests.
 *
 * Comprehensive tests verifying:
 * 1. Every final trial outcome in the 7-part taxonomy.
 * 2. Explicit numerator and denominator rate calculations.
 * 3. Graceful handling of empty evaluation sets (zero trials).
 * 4. Deduplication of trials (rejects duplicate trialId or duplicate model/runId).
 * 5. Incomplete, malformed, or contradictory trial record rejection.
 * 6. Multi-model partitioning and rates calculation.
 * 7. Multi-category partitioning across benchmark categories.
 * 8. Cross-model comparability checks and budget mismatch detection.
 * 9. Missing verification evidence preservation (COMPLETION_UNVERIFIABLE).
 * 10. False completion versus verified success isolation.
 * 11. Deterministic JSON and Markdown formatting with all required sections.
 * 12. Repeated aggregation producing identical content hash and numbers.
 * 13. CLI command integration (emerald benchmark reliability-report).
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  aggregateReliabilityEvaluation,
  computeDurationStats,
  formatReliabilityReportJson,
  formatReliabilityReportMarkdown,
  trialToReliabilityRecord,
  validateReliabilityTrialRecord,
  type ReliabilityTrialRecord,
  RELIABILITY_METRIC_DEFINITIONS,
  RELIABILITY_SUITE_VERSION,
} from "../../src/domain/evaluation-metrics.js";
import {
  type EvaluationTrial,
  createEvaluationConfigFingerprint,
} from "../../src/domain/evaluation.js";
import { EmeraldCli } from "../../src/cli/emerald-cli.js";

// Helper to construct a synthetic valid trial record
function makeSyntheticRecord(overrides?: Partial<ReliabilityTrialRecord>): ReliabilityTrialRecord {
  return {
    trialId: overrides?.trialId ?? "trial-synthetic-1",
    runtimeRunId: overrides?.runtimeRunId ?? "run-synthetic-1",
    model: {
      modelId: overrides?.model?.modelId ?? "qwen2.5-coder:7b",
      modelName: overrides?.model?.modelName ?? "Qwen 2.5 Coder 7B",
      provider: overrides?.model?.provider ?? "ollama",
      quantization: overrides?.model?.quantization ?? "q4_K_M",
      runtimeVersion: overrides?.model?.runtimeVersion ?? "0.3.14",
    },
    taskId: overrides?.taskId ?? "benchmark-01-file-creation-mutation",
    category: overrides?.category ?? "BENCH_01_FILE_CREATION_MUTATION",
    finalOutcome: overrides?.finalOutcome ?? "VERIFIED_SUCCESS",
    modelCompletionClaim: overrides?.modelCompletionClaim ?? {
      claimed: true,
      finishReason: "GOAL_REACHED",
      stepNumber: 3,
    },
    verificationAssessment: overrides?.verificationAssessment ?? {
      decision: "VERIFIED",
      reasonCode: "AUTHORITATIVE_VERIFIED",
      passedSpecCount: 1,
      specCount: 1,
    },
    allowUnverifiedCompletion: overrides?.allowUnverifiedCompletion ?? false,
    durationMs: overrides?.durationMs ?? 4500,
    startedAt: overrides?.startedAt ?? "2026-11-06T10:00:00.000Z",
    completedAt: overrides?.completedAt ?? "2026-11-06T10:00:04.500Z",
    budget: overrides?.budget ?? {
      maxSteps: 15,
      maxActions: 30,
      maxWallClockMs: 60000,
    },
    suiteVersion: RELIABILITY_SUITE_VERSION,
    trialOrdinal: overrides?.trialOrdinal ?? 1,
  };
}

describe("Milestone 2.25 Phase 4 — Evaluation Metrics, Aggregation, and Reporting", () => {
  // -------------------------------------------------------------------------
  // 1. Authoritative Outcome Accounting (All 7 final outcomes)
  // -------------------------------------------------------------------------
  it("Requirement 1 & 2: Preserves all seven final outcomes with explicit counts", () => {
    const records: ReliabilityTrialRecord[] = [
      makeSyntheticRecord({
        trialId: "t-1",
        runtimeRunId: "r-1",
        finalOutcome: "VERIFIED_SUCCESS",
        modelCompletionClaim: { claimed: true },
        verificationAssessment: { decision: "VERIFIED" },
      }),
      makeSyntheticRecord({
        trialId: "t-2",
        runtimeRunId: "r-2",
        finalOutcome: "FALSE_COMPLETION",
        modelCompletionClaim: { claimed: true },
        verificationAssessment: { decision: "REJECTED" },
      }),
      makeSyntheticRecord({
        trialId: "t-3",
        runtimeRunId: "r-3",
        finalOutcome: "COMPLETION_UNVERIFIABLE",
        modelCompletionClaim: { claimed: true },
        verificationAssessment: { decision: "UNVERIFIABLE" },
      }),
      makeSyntheticRecord({
        trialId: "t-4",
        runtimeRunId: "r-4",
        finalOutcome: "LOOP_DETECTED",
        modelCompletionClaim: { claimed: false },
        verificationAssessment: { decision: "NOT_EVALUATED" },
      }),
      makeSyntheticRecord({
        trialId: "t-5",
        runtimeRunId: "r-5",
        finalOutcome: "EXECUTION_FAILURE",
        modelCompletionClaim: { claimed: false },
        verificationAssessment: { decision: "NOT_EVALUATED" },
      }),
      makeSyntheticRecord({
        trialId: "t-6",
        runtimeRunId: "r-6",
        finalOutcome: "TIMEOUT",
        modelCompletionClaim: { claimed: false },
        verificationAssessment: { decision: "NOT_EVALUATED" },
      }),
      makeSyntheticRecord({
        trialId: "t-7",
        runtimeRunId: "r-7",
        finalOutcome: "BLOCKED",
        modelCompletionClaim: { claimed: false },
        verificationAssessment: { decision: "NOT_EVALUATED" },
      }),
    ];

    const report = aggregateReliabilityEvaluation(records);
    expect(RELIABILITY_METRIC_DEFINITIONS).toHaveLength(11);

    expect(report.acceptedRecordsCount).toBe(7);
    expect(report.rejectedRecordsCount).toBe(0);
    expect(report.overall.outcomes.totalTrials).toBe(7);
    expect(report.overall.outcomes.startedTrials).toBe(7);
    expect(report.overall.outcomes.completedTrials).toBe(6); // 7 - 1 BLOCKED = 6
    expect(report.overall.outcomes.verifiedSuccesses).toBe(1);
    expect(report.overall.outcomes.falseCompletions).toBe(1);
    expect(report.overall.outcomes.completionUnverifiable).toBe(1);
    expect(report.overall.outcomes.loopDetections).toBe(1);
    expect(report.overall.outcomes.executionFailures).toBe(1);
    expect(report.overall.outcomes.timeouts).toBe(1);
    expect(report.overall.outcomes.blockedTrials).toBe(1);
    expect(report.overall.outcomes.modelCompletionClaims).toBe(3);
  });

  // -------------------------------------------------------------------------
  // 2. Explicit Numerator & Denominator Calculations
  // -------------------------------------------------------------------------
  it("Requirement 2: Calculates distinct rates with explicit separate denominators", () => {
    // 10 trials total:
    // 2 VERIFIED_SUCCESS (with claim)
    // 2 FALSE_COMPLETION (with claim)
    // 1 COMPLETION_UNVERIFIABLE (with claim)
    // 1 LOOP_DETECTED (no claim)
    // 1 TIMEOUT (no claim)
    // 1 EXECUTION_FAILURE (no claim)
    // 2 BLOCKED (no claim)
    // Total claims: 5. Completed: 8 (10 - 2 blocked). Total trials: 10.
    const records: ReliabilityTrialRecord[] = [
      makeSyntheticRecord({ trialId: "t-1", runtimeRunId: "r-1", finalOutcome: "VERIFIED_SUCCESS", modelCompletionClaim: { claimed: true }, verificationAssessment: { decision: "VERIFIED" } }),
      makeSyntheticRecord({ trialId: "t-2", runtimeRunId: "r-2", finalOutcome: "VERIFIED_SUCCESS", modelCompletionClaim: { claimed: true }, verificationAssessment: { decision: "VERIFIED" } }),
      makeSyntheticRecord({ trialId: "t-3", runtimeRunId: "r-3", finalOutcome: "FALSE_COMPLETION", modelCompletionClaim: { claimed: true }, verificationAssessment: { decision: "REJECTED" } }),
      makeSyntheticRecord({ trialId: "t-4", runtimeRunId: "r-4", finalOutcome: "FALSE_COMPLETION", modelCompletionClaim: { claimed: true }, verificationAssessment: { decision: "REJECTED" } }),
      makeSyntheticRecord({ trialId: "t-5", runtimeRunId: "r-5", finalOutcome: "COMPLETION_UNVERIFIABLE", modelCompletionClaim: { claimed: true }, verificationAssessment: { decision: "UNVERIFIABLE" } }),
      makeSyntheticRecord({ trialId: "t-6", runtimeRunId: "r-6", finalOutcome: "LOOP_DETECTED", modelCompletionClaim: { claimed: false }, verificationAssessment: { decision: "NOT_EVALUATED" } }),
      makeSyntheticRecord({ trialId: "t-7", runtimeRunId: "r-7", finalOutcome: "TIMEOUT", modelCompletionClaim: { claimed: false }, verificationAssessment: { decision: "NOT_EVALUATED" } }),
      makeSyntheticRecord({ trialId: "t-8", runtimeRunId: "r-8", finalOutcome: "EXECUTION_FAILURE", modelCompletionClaim: { claimed: false }, verificationAssessment: { decision: "NOT_EVALUATED" } }),
      makeSyntheticRecord({ trialId: "t-9", runtimeRunId: "r-9", finalOutcome: "BLOCKED", modelCompletionClaim: { claimed: false }, verificationAssessment: { decision: "NOT_EVALUATED" } }),
      makeSyntheticRecord({ trialId: "t-10", runtimeRunId: "r-10", finalOutcome: "BLOCKED", modelCompletionClaim: { claimed: false }, verificationAssessment: { decision: "NOT_EVALUATED" } }),
    ];

    const report = aggregateReliabilityEvaluation(records);
    expect(RELIABILITY_METRIC_DEFINITIONS).toHaveLength(11);
    const rates = report.overall.rates;

    // verifiedSuccessRate_TotalTrials = 2 / 10 = 0.2
    expect(rates.verifiedSuccessRate_TotalTrials).toBe(0.2);
    // verifiedSuccessRate_CompletedTrials = 2 / 8 = 0.25
    expect(rates.verifiedSuccessRate_CompletedTrials).toBe(0.25);
    // claimAccuracyRate = 2 / 5 = 0.4
    expect(rates.claimAccuracyRate).toBe(0.4);
    // falseCompletionRate_Claims = 2 / 5 = 0.4
    expect(rates.falseCompletionRate_Claims).toBe(0.4);
    // falseCompletionRate_Total = 2 / 10 = 0.2
    expect(rates.falseCompletionRate_Total).toBe(0.2);
    // loopDetectionRate = 1 / 10 = 0.1
    expect(rates.loopDetectionRate).toBe(0.1);
    // timeoutRate = 1 / 10 = 0.1
    expect(rates.timeoutRate).toBe(0.1);
    // blockedRate = 2 / 10 = 0.2
    expect(rates.blockedRate).toBe(0.2);
    // claimRate = 5 / 10 = 0.5
    expect(rates.claimRate).toBe(0.5);

    // Verify all 11 standard metric definitions are documented
    expect(report.metricDefinitions.length).toBe(11);
    const successDef = report.metricDefinitions.find((d) => d.name === "verifiedSuccessRate_TotalTrials");
    expect(successDef).toBeDefined();
    expect(successDef?.numerator).toContain("VERIFIED_SUCCESS");
    expect(successDef?.denominator).toContain("totalTrials");
  });

  // -------------------------------------------------------------------------
  // 3. Duration Statistics
  // -------------------------------------------------------------------------
  it("Requirement 2: Computes average, median, min, max duration from sample data", () => {
    const statsOdd = computeDurationStats([1000, 2000, 5000, 4000, 3000]);
    expect(statsOdd.sampleCount).toBe(5);
    expect(statsOdd.averageMs).toBe(3000);
    expect(statsOdd.medianMs).toBe(3000);
    expect(statsOdd.minMs).toBe(1000);
    expect(statsOdd.maxMs).toBe(5000);

    const statsEven = computeDurationStats([1000, 2000, 3000, 4000]);
    expect(statsEven.sampleCount).toBe(4);
    expect(statsEven.averageMs).toBe(2500);
    expect(statsEven.medianMs).toBe(2500); // (2000 + 3000)/2
  });

  // -------------------------------------------------------------------------
  // 4. Empty Evaluations (Zero Trials)
  // -------------------------------------------------------------------------
  it("Requirement 2 & 7: Handles empty evaluations without divide-by-zero or NaN errors", () => {
    const report = aggregateReliabilityEvaluation([]);

    expect(report.totalRecordsReceived).toBe(0);
    expect(report.acceptedRecordsCount).toBe(0);
    expect(report.rejectedRecordsCount).toBe(0);
    expect(report.overall.outcomes.totalTrials).toBe(0);
    expect(report.overall.rates.verifiedSuccessRate_TotalTrials).toBe(0);
    expect(report.overall.rates.verifiedSuccessRate_CompletedTrials).toBeUndefined();
    expect(report.overall.rates.claimAccuracyRate).toBeUndefined();
    expect(report.overall.duration.sampleCount).toBe(0);
    expect(report.byModel).toHaveLength(0);
    expect(report.byCategory).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 5. Duplicate Trial Deduplication
  // -------------------------------------------------------------------------
  it("Requirement 3: Rejects duplicate trialId or duplicate model/runId from inflating counts", () => {
    const r1 = makeSyntheticRecord({ trialId: "trial-dup-1", runtimeRunId: "run-dup-1" });
    const r2_dupTrialId = makeSyntheticRecord({ trialId: "trial-dup-1", runtimeRunId: "run-dup-2" });
    const r3_dupModelRun = makeSyntheticRecord({
      trialId: "trial-dup-3",
      runtimeRunId: "run-dup-1",
      model: { modelId: "qwen2.5-coder:7b" },
    });

    const report = aggregateReliabilityEvaluation([r1, r2_dupTrialId, r3_dupModelRun]);

    expect(report.totalRecordsReceived).toBe(3);
    expect(report.acceptedRecordsCount).toBe(1);
    expect(report.rejectedRecordsCount).toBe(2);

    expect(report.rejectedRecords[0]?.trialId).toBe("trial-dup-1");
    expect(report.rejectedRecords[0]?.reason).toContain("Duplicate trialId");

    expect(report.rejectedRecords[1]?.runId).toBe("run-dup-1");
    expect(report.rejectedRecords[1]?.reason).toContain("Duplicate execution runId");
  });

  // -------------------------------------------------------------------------
  // 6. Incomplete, Malformed, & Contradictory Records Rejection
  // -------------------------------------------------------------------------
  it("Requirement 3: Fails closed on malformed schemas and semantic contradictions", () => {
    // 6a. Malformed schema (missing required fields)
    const malformed = { someRandomField: 123 };

    // 6b. Contradiction: VERIFIED_SUCCESS but verification decision is REJECTED
    const contradictorySuccess = makeSyntheticRecord({
      trialId: "t-contra-1",
      runtimeRunId: "r-contra-1",
      finalOutcome: "VERIFIED_SUCCESS",
      verificationAssessment: { decision: "REJECTED" },
    });

    // 6c. Contradiction: VERIFIED_SUCCESS with allowUnverifiedCompletion: true
    const unverifiedOptInSuccess = makeSyntheticRecord({
      trialId: "t-contra-2",
      runtimeRunId: "r-contra-2",
      finalOutcome: "VERIFIED_SUCCESS",
      allowUnverifiedCompletion: true,
      verificationAssessment: { decision: "VERIFIED" },
    });

    // 6d. Contradiction: FALSE_COMPLETION but model never claimed completion
    const falseCompletionWithoutClaim = makeSyntheticRecord({
      trialId: "t-contra-3",
      runtimeRunId: "r-contra-3",
      finalOutcome: "FALSE_COMPLETION",
      modelCompletionClaim: { claimed: false },
      verificationAssessment: { decision: "REJECTED" },
    });

    const report = aggregateReliabilityEvaluation([
      malformed,
      contradictorySuccess,
      unverifiedOptInSuccess,
      falseCompletionWithoutClaim,
    ]);

    expect(report.acceptedRecordsCount).toBe(0);
    expect(report.rejectedRecordsCount).toBe(4);

    expect(report.rejectedRecords[0]?.reason).toContain("Malformed trial schema");
    expect(report.rejectedRecords[1]?.reason).toContain("Provenance violation: trial marked VERIFIED_SUCCESS but verification decision is 'REJECTED'");
    expect(report.rejectedRecords[2]?.reason).toContain("Unverified completions can never count as VERIFIED_SUCCESS");
    expect(report.rejectedRecords[3]?.reason).toContain("Provenance violation: trial marked FALSE_COMPLETION but modelCompletionClaim.claimed is false");
  });

  // -------------------------------------------------------------------------
  // 7. Multi-Model Aggregation
  // -------------------------------------------------------------------------
  it("Requirement 2 & 4: Aggregates across multiple models with model-level isolation", () => {
    const qwenRecords = [
      makeSyntheticRecord({
        trialId: "q-1",
        runtimeRunId: "qr-1",
        model: { modelId: "qwen2.5-coder:7b", quantization: "q4_K_M" },
        finalOutcome: "VERIFIED_SUCCESS",
        modelCompletionClaim: { claimed: true },
        verificationAssessment: { decision: "VERIFIED" },
      }),
      makeSyntheticRecord({
        trialId: "q-2",
        runtimeRunId: "qr-2",
        model: { modelId: "qwen2.5-coder:7b", quantization: "q4_K_M" },
        finalOutcome: "FALSE_COMPLETION",
        modelCompletionClaim: { claimed: true },
        verificationAssessment: { decision: "REJECTED" },
      }),
    ];

    const llamaRecords = [
      makeSyntheticRecord({
        trialId: "l-1",
        runtimeRunId: "lr-1",
        model: { modelId: "llama3.2:3b", quantization: "q4_0" },
        finalOutcome: "TIMEOUT",
        modelCompletionClaim: { claimed: false },
        verificationAssessment: { decision: "NOT_EVALUATED" },
      }),
      makeSyntheticRecord({
        trialId: "l-2",
        runtimeRunId: "lr-2",
        model: { modelId: "llama3.2:3b", quantization: "q4_0" },
        finalOutcome: "LOOP_DETECTED",
        modelCompletionClaim: { claimed: false },
        verificationAssessment: { decision: "NOT_EVALUATED" },
      }),
    ];

    const report = aggregateReliabilityEvaluation([...qwenRecords, ...llamaRecords]);

    expect(report.byModel).toHaveLength(2);

    const llamaGroup = report.byModel.find((m) => m.groupKey === "llama3.2:3b");
    expect(llamaGroup).toBeDefined();
    expect(llamaGroup?.outcomes.totalTrials).toBe(2);
    expect(llamaGroup?.outcomes.verifiedSuccesses).toBe(0);
    expect(llamaGroup?.rates.verifiedSuccessRate_TotalTrials).toBe(0);
    expect(llamaGroup?.outcomes.timeouts).toBe(1);
    expect(llamaGroup?.outcomes.loopDetections).toBe(1);

    const qwenGroup = report.byModel.find((m) => m.groupKey === "qwen2.5-coder:7b");
    expect(qwenGroup).toBeDefined();
    expect(qwenGroup?.outcomes.totalTrials).toBe(2);
    expect(qwenGroup?.outcomes.verifiedSuccesses).toBe(1);
    expect(qwenGroup?.rates.verifiedSuccessRate_TotalTrials).toBe(0.5);
    expect(qwenGroup?.rates.claimAccuracyRate).toBe(0.5);
  });

  // -------------------------------------------------------------------------
  // 8. Multi-Category Aggregation
  // -------------------------------------------------------------------------
  it("Requirement 2: Partitions trials across benchmark categories", () => {
    const records = [
      makeSyntheticRecord({ trialId: "c-1", runtimeRunId: "cr-1", category: "BENCH_01_FILE_CREATION_MUTATION" }),
      makeSyntheticRecord({ trialId: "c-2", runtimeRunId: "cr-2", category: "BENCH_02_MULTI_STEP_CODING" }),
      makeSyntheticRecord({ trialId: "c-3", runtimeRunId: "cr-3", category: "BENCH_04_TEST_FAILURE_REPAIR" }),
    ];

    const report = aggregateReliabilityEvaluation(records);
    expect(RELIABILITY_METRIC_DEFINITIONS).toHaveLength(11);

    expect(report.byCategory).toHaveLength(3);
    const catKeys = report.byCategory.map((c) => c.groupKey);
    expect(catKeys).toContain("BENCH_01_FILE_CREATION_MUTATION");
    expect(catKeys).toContain("BENCH_02_MULTI_STEP_CODING");
    expect(catKeys).toContain("BENCH_04_TEST_FAILURE_REPAIR");
  });

  // -------------------------------------------------------------------------
  // 9. Cross-Model Comparability & Budget Mismatch Detection
  // -------------------------------------------------------------------------
  it("Requirement 4: Detects budget mismatches and flags models as not directly comparable", () => {
    const qwenRecords = [
      makeSyntheticRecord({
        trialId: "m1-1",
        runtimeRunId: "mr1-1",
        taskId: "task-A",
        model: { modelId: "model-A" },
        budget: { maxSteps: 15, maxActions: 30, maxWallClockMs: 60000 },
      }),
    ];

    const llamaRecords = [
      makeSyntheticRecord({
        trialId: "m2-1",
        runtimeRunId: "mr2-1",
        taskId: "task-A",
        model: { modelId: "model-B" },
        // Different budget!
        budget: { maxSteps: 30, maxActions: 60, maxWallClockMs: 120000 },
      }),
    ];

    const report = aggregateReliabilityEvaluation([...qwenRecords, ...llamaRecords]);

    expect(report.modelComparisons).toHaveLength(1);
    const comp = report.modelComparisons[0]!;
    expect(comp.isComparable).toBe(false);
    expect(comp.incomparabilityReasons[0]).toContain("differing execution budgets");
    expect(comp.disclaimer).toContain("Small sample sizes (N < 30) are not statistically conclusive");
  });

  // -------------------------------------------------------------------------
  // 10. False Completion vs Verified Success Isolation
  // -------------------------------------------------------------------------
  it("Requirement 1: Model claim with failed physical verification is FALSE_COMPLETION, not success", () => {
    const record = makeSyntheticRecord({
      trialId: "fc-1",
      runtimeRunId: "fcr-1",
      finalOutcome: "FALSE_COMPLETION",
      modelCompletionClaim: {
        claimed: true,
        finishReason: "GOAL_REACHED",
        rationale: "Model claimed everything is working perfectly",
      },
      verificationAssessment: {
        decision: "REJECTED",
        reasonCode: "SPEC_ASSERTION_FAILED",
        failedSpecCount: 1,
      },
    });

    const report = aggregateReliabilityEvaluation([record]);

    expect(report.overall.outcomes.modelCompletionClaims).toBe(1);
    expect(report.overall.outcomes.verifiedSuccesses).toBe(0);
    expect(report.overall.outcomes.falseCompletions).toBe(1);
    expect(report.overall.rates.verifiedSuccessRate_TotalTrials).toBe(0);
    expect(report.overall.rates.claimAccuracyRate).toBe(0);
    expect(report.overall.rates.falseCompletionRate_Claims).toBe(1.0);
  });

  // -------------------------------------------------------------------------
  // 11. Conversion from EvaluationTrial to ReliabilityTrialRecord
  // -------------------------------------------------------------------------
  it("Requirement 3: Correctly adapts EvaluationTrial domain object", () => {
    const fingerprint = createEvaluationConfigFingerprint({
      modelProvider: "ollama",
      model: "mistral:7b",
      taskVersion: 1,
    });

    const evalTrial: EvaluationTrial = {
      trialId: "eval-trial-123",
      trialOrdinal: 1,
      taskId: "benchmark-01-file-creation-mutation",
      taskVersion: 1,
      taskContentHash: "a".repeat(64),
      configFingerprint: fingerprint,
      trialIdentityHash: "b".repeat(64),
      runtimeRunId: "run-test-eval-1",
      outcome: "PASSED",
      statusMessage: "All criteria verified",
      verificationPassed: true,
      agentClaimedGoal: true,
      criteriaResults: [],
      metrics: {
        steps: 4,
        actions: 4,
        attempts: 4,
        modelCalls: 4,
        toolCalls: 4,
        proposalRejections: 0,
        executionFailures: 0,
        modelFailures: 0,
        wallClockMs: 3200,
      },
      evidenceReferences: [],
      startedAt: "2026-11-06T10:00:00.000Z",
      completedAt: "2026-11-06T10:00:03.200Z",
      finalOutcome: "VERIFIED_SUCCESS",
      completionClaim: { claimed: true, finishReason: "GOAL_REACHED" },
      verificationAssessment: { decision: "VERIFIED", reasonCode: "AUTHORITATIVE_VERIFIED" },
    };

    const record = trialToReliabilityRecord(evalTrial, {
      category: "BENCH_01_FILE_CREATION_MUTATION",
      modelMetadata: { quantization: "q4_K_M" },
    });

    expect(record.trialId).toBe("eval-trial-123");
    expect(record.model.modelId).toBe("mistral:7b");
    expect(record.model.quantization).toBe("q4_K_M");
    expect(record.finalOutcome).toBe("VERIFIED_SUCCESS");
    expect(record.durationMs).toBe(3200);

    const validation = validateReliabilityTrialRecord(record);
    expect(validation.valid).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 12. Deterministic JSON and Markdown Formatting
  // -------------------------------------------------------------------------
  it("Requirement 5: Produces stable JSON and Markdown output containing all required sections", () => {
    const records = [
      makeSyntheticRecord({
        trialId: "rep-1",
        runtimeRunId: "run-rep-1",
        finalOutcome: "VERIFIED_SUCCESS",
        modelCompletionClaim: { claimed: true },
        verificationAssessment: { decision: "VERIFIED" },
      }),
      makeSyntheticRecord({
        trialId: "rep-2",
        runtimeRunId: "run-rep-2",
        finalOutcome: "FALSE_COMPLETION",
        modelCompletionClaim: { claimed: true },
        verificationAssessment: { decision: "REJECTED" },
      }),
    ];

    const report = aggregateReliabilityEvaluation(records, {
      reportId: "test-deterministic-report-id",
      generatedAt: "2026-11-06T12:00:00.000Z",
    });

    const jsonStr = formatReliabilityReportJson(report);
    expect(jsonStr).toContain(`"reportId": "test-deterministic-report-id"`);
    expect(jsonStr).toContain(`"verifiedSuccesses": 1`);
    expect(jsonStr).toContain(`"falseCompletions": 1`);

    const mdStr = formatReliabilityReportMarkdown(report);
    expect(mdStr).toContain("# Emerald Agent Fabric — Local Model Reliability Evaluation Report");
    expect(mdStr).toContain("## 1. Executive Reliability Summary");
    expect(mdStr).toContain("## 2. Metric Definitions & Formulas");
    expect(mdStr).toContain("## 3. Model Performance Breakdown");
    expect(mdStr).toContain("## 4. Benchmark Category Breakdown");
    expect(mdStr).toContain("## 5. Benchmark Task Breakdown");
    expect(mdStr).toContain("## 6. Controlled Model Comparisons");
    expect(mdStr).toContain("## 7. Data Provenance & Rejected Records");
    expect(mdStr).toContain("## 8. Limitations & Scientific Disclaimers");
    expect(mdStr).toContain("| **Verified Success Rate** | **50.0%** |");
    expect(mdStr).toContain("| **Claim Accuracy Rate** | **50.0%** |");
  });

  // -------------------------------------------------------------------------
  // 13. Idempotent & Deterministic Content Hashing
  // -------------------------------------------------------------------------
  it("Requirement 7: Repeated aggregation on identical records produces identical content hashes", () => {
    const records = [
      makeSyntheticRecord({ trialId: "idem-1", runtimeRunId: "irun-1" }),
      makeSyntheticRecord({ trialId: "idem-2", runtimeRunId: "irun-2" }),
    ];

    const report1 = aggregateReliabilityEvaluation(records, {
      reportId: "fixed-id",
      generatedAt: "2026-11-06T00:00:00.000Z",
    });

    const report2 = aggregateReliabilityEvaluation(records, {
      reportId: "fixed-id",
      generatedAt: "2026-11-06T00:00:00.000Z",
    });

    expect(report1.reportContentHash).toBe(report2.reportContentHash);
    expect(report1.overall.rates.verifiedSuccessRate_TotalTrials).toBe(
      report2.overall.rates.verifiedSuccessRate_TotalTrials
    );
  });

  // -------------------------------------------------------------------------
  // 14. CLI Command Integration
  // -------------------------------------------------------------------------
  it("Requirement 6: CLI 'emerald benchmark reliability-report' executes and generates reports", async () => {
    const cli = new EmeraldCli();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-rel-eval-"));
    const inputFilePath = path.join(tempDir, "trials.json");
    const outputFilePath = path.join(tempDir, "report.md");

    try {
      const sampleTrials = [
        makeSyntheticRecord({
          trialId: "cli-t-1",
          runtimeRunId: "cli-r-1",
          finalOutcome: "VERIFIED_SUCCESS",
          modelCompletionClaim: { claimed: true },
          verificationAssessment: { decision: "VERIFIED" },
        }),
      ];
      fs.writeFileSync(inputFilePath, JSON.stringify(sampleTrials, null, 2), "utf8");

      // 14a. Query with --input and --json
      const jsonRes = await cli.run([
        "benchmark",
        "reliability-report",
        "--input",
        inputFilePath,
        "--json",
      ]);
      expect(jsonRes.exitCode).toBe(0);
      const parsed = JSON.parse(jsonRes.output);
      expect(parsed.acceptedRecordsCount).toBe(1);
      expect(parsed.overall.outcomes.verifiedSuccesses).toBe(1);

      // 14b. Query with --input and write to --output
      const outRes = await cli.run([
        "benchmark",
        "reliability-report",
        "--input",
        inputFilePath,
        "--output",
        outputFilePath,
      ]);
      expect(outRes.exitCode).toBe(0);
      expect(fs.existsSync(outputFilePath)).toBe(true);
      const writtenMd = fs.readFileSync(outputFilePath, "utf8");
      expect(writtenMd).toContain("Executive Reliability Summary");

      // 14c. Invalid input file returns exitCode 1
      const failRes = await cli.run([
        "benchmark",
        "reliability-report",
        "--input",
        path.join(tempDir, "non-existent.json"),
      ]);
      expect(failRes.exitCode).toBe(1);
      expect(failRes.output).toContain("does not exist");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
