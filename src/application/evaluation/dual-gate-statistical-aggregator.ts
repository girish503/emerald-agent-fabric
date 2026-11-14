/**
 * Dual-Gate Statistical Aggregator and Certification Authority for Emerald Agent Fabric.
 *
 * Implements statistical acceptance and certification for Capability Gates:
 * 1. Sample Size Checks:
 *    - Rejects certifying any capability with fewer trials than gate threshold (e.g. 5-10 trials).
 *    - Classifies small samples as INSUFFICIENT_EVIDENCE.
 * 2. Statistical Aggregation:
 *    - Calculates total trials, pass/fail counts, success rate, timeout rate.
 *    - Computes min, median, p90, and max latencies.
 * 3. Authority Certification:
 *    - Produces authoritative CapabilityGateEvidence records ONLY when both sample size and pass rates
 *      meet or exceed gate thresholds.
 *    - Binds evidence immutably to the verified modelDigest and evaluationVersion.
 */

import {
  DualGateTrialResult,
  EvaluationExecutionMode,
  GATE_EVALUATION_THRESHOLDS,
  GateStatisticalSummary,
} from "../../domain/dual-gate-evaluation.js";
import {
  CAPABILITY_GATE_DEFINITIONS,
  CapabilityCertificationStatus,
  CapabilityGateEvidence,
  ModelCapabilityGateId,
} from "../../domain/model-routing.js";
import { EVALUATION_HARNESS_VERSION } from "./dual-gate-eval-harness.js";

export class DualGateStatisticalAggregator {
  /**
   * Aggregates trial results for a specific gate and model, computing statistical acceptance.
   */
  public static aggregateTrials(
    gateId: ModelCapabilityGateId,
    modelId: string,
    modelDigest: string,
    trials: readonly DualGateTrialResult[],
    _now: Date = new Date()
  ): GateStatisticalSummary {
    const matchingTrials = trials.filter(
      (t) => t.gateId === gateId && t.modelId === modelId && t.modelDigest === modelDigest
    );

    // Security hardening: deduplicate trials by trialId and (taskId, trialIndex)
    // to prevent replay attacks or duplicate submission from artificially inflating sample counts.
    const seenTrialIds = new Set<string>();
    const seenTaskIndices = new Set<string>();
    const relevantTrials: DualGateTrialResult[] = [];
    for (const t of matchingTrials) {
      const taskIndexKey = `${t.taskId}:${t.trialIndex}`;
      if (seenTrialIds.has(t.trialId) || seenTaskIndices.has(taskIndexKey)) {
        continue;
      }
      seenTrialIds.add(t.trialId);
      seenTaskIndices.add(taskIndexKey);
      relevantTrials.push(t);
    }

    const threshold = GATE_EVALUATION_THRESHOLDS[gateId];
    const totalTrials = relevantTrials.length;
    const reasons: string[] = [];

    // Mode determination: if any trial is FIXTURE_VALIDATION, summary is FIXTURE_VALIDATION
    const isFixture = relevantTrials.some((t) => t.evaluationMode === "FIXTURE_VALIDATION");
    const evaluationMode: EvaluationExecutionMode = isFixture ? "FIXTURE_VALIDATION" : "LIVE_MODEL_EVALUATION";

    if (totalTrials === 0) {
      return {
        gateId,
        modelId,
        modelDigest,
        harnessVersion: EVALUATION_HARNESS_VERSION,
        evaluationMode: "LIVE_MODEL_EVALUATION",
        totalTrials: 0,
        passedTrials: 0,
        failedTrials: 0,
        timedOutTrials: 0,
        gateAPassCount: 0,
        gateBPassCount: 0,
        successRate: 0.0,
        minLatencyMs: 0,
        medianLatencyMs: 0,
        p90LatencyMs: 0,
        maxLatencyMs: 0,
        status: "UNVERIFIED",
        reasons: ["Zero evaluation trials recorded"],
      };
    }

    const passedTrials = relevantTrials.filter((t) => t.overallPassed).length;
    const failedTrials = totalTrials - passedTrials;
    const timedOutTrials = relevantTrials.filter((t) => t.failureClassification === "TIMEOUT").length;
    const gateAPassCount = relevantTrials.filter((t) => t.gateA.passed).length;
    const gateBPassCount = relevantTrials.filter((t) => t.gateB.passed).length;
    const successRate = passedTrials / totalTrials;
    const timeoutRate = timedOutTrials / totalTrials;

    const latencies = relevantTrials.map((t) => t.durationMs).sort((a, b) => a - b);
    const minLatencyMs = latencies[0] ?? 0;
    const maxLatencyMs = latencies[latencies.length - 1] ?? 0;
    const medianLatencyMs = latencies[Math.floor(latencies.length / 2)] ?? 0;
    const p90Idx = Math.floor(latencies.length * 0.9);
    const p90LatencyMs = latencies[p90Idx] ?? maxLatencyMs;

    const failureBreakdown: Record<string, number> = {};
    const rootCauseBreakdown: Record<string, number> = {};

    for (const t of relevantTrials) {
      if (t.failureClassification) {
        failureBreakdown[t.failureClassification] = (failureBreakdown[t.failureClassification] ?? 0) + 1;
      }
      if (t.diagnosticRootCause) {
        rootCauseBreakdown[t.diagnosticRootCause] = (rootCauseBreakdown[t.diagnosticRootCause] ?? 0) + 1;
      }
    }

    let status: CapabilityCertificationStatus;

    if (totalTrials < threshold.minTrials) {
      status = "INSUFFICIENT_EVIDENCE";
      reasons.push(
        `Trial count (${totalTrials}) is below minimum threshold (${threshold.minTrials}) for gate ${gateId}`
      );
    } else if (timeoutRate > threshold.maxTimeoutRate) {
      status = "FAILED";
      reasons.push(
        `Timeout rate (${(timeoutRate * 100).toFixed(1)}%) exceeds maximum allowed threshold (${(threshold.maxTimeoutRate * 100).toFixed(1)}%)`
      );
    } else if (successRate < threshold.minPassRate) {
      status = "FAILED";
      reasons.push(
        `Success rate (${(successRate * 100).toFixed(1)}%) is below required threshold (${(threshold.minPassRate * 100).toFixed(1)}%)`
      );
    } else {
      status = "PASSED";
      reasons.push(
        `Statistical criteria met: ${passedTrials}/${totalTrials} passed (${(successRate * 100).toFixed(1)}% >= ${(threshold.minPassRate * 100).toFixed(1)}%)`
      );
    }

    return {
      gateId,
      modelId,
      modelDigest,
      harnessVersion: relevantTrials[0]?.harnessVersion ?? EVALUATION_HARNESS_VERSION,
      evaluationMode,
      totalTrials,
      passedTrials,
      failedTrials,
      timedOutTrials,
      gateAPassCount,
      gateBPassCount,
      successRate,
      minLatencyMs,
      medianLatencyMs,
      p90LatencyMs,
      maxLatencyMs,
      status,
      reasons,
      failureBreakdown,
      rootCauseBreakdown,
    };
  }

  /**
   * Generates a validated CapabilityGateEvidence record if statistical summary passes.
   * Fails closed and returns null if status is not PASSED.
   */
  public static createEvidenceRecord(
    summary: GateStatisticalSummary,
    evaluationVersion: string = EVALUATION_HARNESS_VERSION,
    now: Date = new Date()
  ): CapabilityGateEvidence | null {
    if (summary.status !== "PASSED") {
      return null;
    }

    const gateDef = CAPABILITY_GATE_DEFINITIONS[summary.gateId];
    const revalidationDays = gateDef?.revalidationDays ?? 90;
    const observedAt = now.toISOString();
    const expiresDate = new Date(now.getTime() + revalidationDays * 24 * 60 * 60 * 1000);
    const expiresAt = expiresDate.toISOString();

    const summaryText =
      `Clean-room dual-gate evaluation: ${summary.passedTrials}/${summary.totalTrials} passed ` +
      `(${(summary.successRate * 100).toFixed(1)}%). Median latency: ${summary.medianLatencyMs} ms. ` +
      `Gate A pass: ${summary.gateAPassCount}/${summary.totalTrials}, Gate B pass: ${summary.gateBPassCount}/${summary.totalTrials}.`;

    return {
      gateId: summary.gateId,
      outcome: "PASSED",
      modelId: summary.modelId,
      modelDigest: summary.modelDigest,
      evaluationVersion,
      evaluationMode: summary.evaluationMode,
      evidenceRef: `eval-trials-${summary.gateId}-${summary.modelId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${summary.modelDigest.slice(0, 12)}`,
      summary: summaryText,
      observedAt,
      expiresAt,
    };
  }
}
