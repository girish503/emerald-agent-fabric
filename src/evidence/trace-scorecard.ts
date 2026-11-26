/**
 * Deterministic Trace-Set Scorecard & Delta Evaluator (Idea 3, Phase 4).
 *
 * Counts EVERY trace in the supplied set with zero sampling and zero dropping,
 * including `COMPLETED_WITHOUT_VERDICT` as an explicit first-class outcome.
 * Reports raw deterministic counts and deltas only (never p-values or significance labels).
 */

import {
  FAILURE_TAXONOMY_CATEGORIES,
  TRACE_VERDICT_OUTCOMES,
  FailureTaxonomyCategory,
  GuardrailRuleScore,
  ScorecardDelta,
  ScorecardDeltaBody,
  ScorecardMetricDelta,
  TraceSetScorecard,
  TraceSetScorecardBody,
  TraceVerdictOutcome,
  computeScorecardDeltaHash,
  computeScorecardHash,
} from "../domain/trace-diff.js";
import type { RunTrace, TraceSpan, TraceVerificationVerdict } from "../domain/trace.js";
import { TRACE_GUARDRAIL_RULES, TraceReplayReport } from "../domain/trace-replay.js";
import { evaluateTraceGuardrails } from "./trace-replay-runner.js";

export type ScoreableTraceItem = RunTrace | TraceReplayReport;

export interface ScoreTraceSetOptions {
  readonly scorecardId?: string;
}

function isReplayReport(item: ScoreableTraceItem): item is TraceReplayReport {
  return (item as TraceReplayReport).mode === "stub-replay" && Array.isArray((item as TraceReplayReport).checks);
}

function classifyVerdictOutcome(
  traceStatus: string,
  verdicts: readonly TraceVerificationVerdict[]
): TraceVerdictOutcome {
  if (verdicts.length === 0) {
    return traceStatus === "COMPLETED" ? "COMPLETED_WITHOUT_VERDICT" : "NO_VERDICT_NON_COMPLETED";
  }
  const ordered = [...verdicts].sort((a, b) => Date.parse(a.verifiedAt) - Date.parse(b.verifiedAt));
  const finalVerdict = ordered[ordered.length - 1]!.verdict;

  if (traceStatus === "COMPLETED") {
    return finalVerdict === "VERIFIED" ? "COMPLETED_VERIFIED" : "COMPLETED_NON_VERIFIED";
  }
  return finalVerdict;
}

function sumSpanCost(spans: readonly TraceSpan[]): number {
  const nonAgent = spans.filter((s) => s.kind !== "agent");
  const target = nonAgent.length > 0 ? nonAgent : spans;
  return target.reduce((acc, s) => acc + (typeof s.costUsd === "number" ? s.costUsd : 0), 0);
}

function sumSpanLatency(spans: readonly TraceSpan[]): number {
  const nonAgent = spans.filter((s) => s.kind !== "agent");
  const target = nonAgent.length > 0 ? nonAgent : spans;
  return target.reduce((acc, s) => acc + (typeof s.latencyMs === "number" ? s.latencyMs : 0), 0);
}

function serializedLower(value: unknown): string {
  return JSON.stringify(value ?? "").toLowerCase();
}

function classifyFailureTaxonomy(
  trace: RunTrace | null,
  report: TraceReplayReport | null,
  verdictOutcome: TraceVerdictOutcome
): FailureTaxonomyCategory {
  const status = trace ? trace.status : report!.traceStatus;
  if (status === "TIMED_OUT") {
    const hasLlmTimeout = trace
      ? trace.spans.some((s) => s.kind === "llm" && s.status === "TIMED_OUT")
      : (report?.llmOutputs.length ?? 0) > 0;
    return hasLlmTimeout ? "TIMEOUT_LLM" : "TIMEOUT_TOOL";
  }
  if (status === "CANCELLED") {
    return "OPERATOR_CANCELLED";
  }
  if (status === "WAITING_APPROVAL") {
    return "APPROVAL_PENDING";
  }
  if (status === "QUARANTINED") {
    return "PROMPT_INJECTION_POISONING";
  }

  if (trace) {
    if (trace.approvalEvents.some((a) => a.status === "REJECTED" || a.status === "EXPIRED")) {
      return "APPROVAL_REJECTED";
    }
    if (status !== "COMPLETED" && trace.repairAttempts.some((r) => r.status === "EXHAUSTED")) {
      return "REPAIR_EXHAUSTED";
    }
    const textBlob = serializedLower({
      spans: trace.spans,
      verdicts: trace.verificationVerdicts,
    });
    if (textBlob.includes("cross_tenant") || textBlob.includes("tenant_boundary_violation")) {
      return "TENANT_ISOLATION_DENIED";
    }
    if (textBlob.includes("empty_patch") || textBlob.includes("unverified_completion_claim")) {
      return "EMPTY_PATCH_REJECTED";
    }
  } else if (report) {
    if (report.approvalSummary.rejectedCount > 0) {
      return "APPROVAL_REJECTED";
    }
    const provCheck = report.checks.find((c) => c.rule === "provenance");
    if (provCheck && !provCheck.passed) {
      return "PROMPT_INJECTION_POISONING";
    }
    const verdictBlob = serializedLower(report.verdictsIntact);
    if (verdictBlob.includes("tenant")) {
      return "TENANT_ISOLATION_DENIED";
    }
    if (verdictBlob.includes("empty") || verdictBlob.includes("0 changed files")) {
      return "EMPTY_PATCH_REJECTED";
    }
  }

  if (
    verdictOutcome === "COMPLETED_WITHOUT_VERDICT" ||
    verdictOutcome === "COMPLETED_NON_VERIFIED"
  ) {
    return "UNVERIFIED_COMPLETION";
  }

  if (status === "COMPLETED") {
    return "NONE";
  }

  return "OTHER_FAILURE";
}

/**
 * Computes a complete deterministic scorecard across ALL supplied traces or replay reports
 * without sampling or dropping any item.
 */
export function scoreTraceSet(
  items: readonly ScoreableTraceItem[],
  options: ScoreTraceSetOptions = {}
): TraceSetScorecard {
  const statusMap = new Map<string, number>();
  const rulePassMap = new Map<string, number>(TRACE_GUARDRAIL_RULES.map((r) => [r, 0]));
  const ruleFailMap = new Map<string, number>(TRACE_GUARDRAIL_RULES.map((r) => [r, 0]));

  const verdictCounts = Object.fromEntries(
    TRACE_VERDICT_OUTCOMES.map((v) => [v, 0])
  ) as Record<TraceVerdictOutcome, number>;
  const failureTaxonomyCounts = Object.fromEntries(
    FAILURE_TAXONOMY_CATEGORIES.map((c) => [c, 0])
  ) as Record<FailureTaxonomyCategory, number>;

  let tracesAllPassedCount = 0;
  let tracesWithViolationsCount = 0;
  let totalCostUsd = 0;
  let totalLatencyMs = 0;

  for (const item of items) {
    if (isReplayReport(item)) {
      statusMap.set(item.traceStatus, (statusMap.get(item.traceStatus) ?? 0) + 1);
      for (const check of item.checks) {
        if (check.passed) {
          rulePassMap.set(check.rule, (rulePassMap.get(check.rule) ?? 0) + 1);
        } else {
          ruleFailMap.set(check.rule, (ruleFailMap.get(check.rule) ?? 0) + 1);
        }
      }
      if (item.passed) {
        tracesAllPassedCount += 1;
      } else {
        tracesWithViolationsCount += 1;
      }

      const verdictOutcome = classifyVerdictOutcome(item.traceStatus, item.verdictsIntact);
      verdictCounts[verdictOutcome] += 1;

      const tax = classifyFailureTaxonomy(null, item, verdictOutcome);
      failureTaxonomyCounts[tax] += 1;

      totalCostUsd += item.llmOutputs.reduce((acc, o) => acc + (o.costUsd ?? 0), 0);
      totalLatencyMs += item.llmOutputs.reduce((acc, o) => acc + o.latencyMs, 0);
    } else {
      const evaluation = evaluateTraceGuardrails(item);
      statusMap.set(evaluation.traceStatus, (statusMap.get(evaluation.traceStatus) ?? 0) + 1);
      for (const check of evaluation.checks) {
        if (check.passed) {
          rulePassMap.set(check.rule, (rulePassMap.get(check.rule) ?? 0) + 1);
        } else {
          ruleFailMap.set(check.rule, (ruleFailMap.get(check.rule) ?? 0) + 1);
        }
      }
      if (evaluation.passed) {
        tracesAllPassedCount += 1;
      } else {
        tracesWithViolationsCount += 1;
      }

      const verdictOutcome = classifyVerdictOutcome(
        evaluation.traceStatus,
        evaluation.verificationVerdicts
      );
      verdictCounts[verdictOutcome] += 1;

      const tax = classifyFailureTaxonomy(item, null, verdictOutcome);
      failureTaxonomyCounts[tax] += 1;

      totalCostUsd += sumSpanCost(evaluation.spans);
      totalLatencyMs += sumSpanLatency(evaluation.spans);
    }
  }

  const totalTraces = items.length;
  const statusCounts: Record<string, number> = {};
  for (const key of [...statusMap.keys()].sort()) {
    statusCounts[key] = statusMap.get(key)!;
  }

  const guardrailRuleCounts: GuardrailRuleScore[] = TRACE_GUARDRAIL_RULES.map((rule) => ({
    rule,
    passedCount: rulePassMap.get(rule) ?? 0,
    failedCount: ruleFailMap.get(rule) ?? 0,
  }));

  const body: TraceSetScorecardBody = {
    scorecardId: options.scorecardId ?? `scorecard-${totalTraces}`,
    totalTraces,
    statusCounts,
    guardrailRuleCounts,
    tracesAllPassedCount,
    tracesWithViolationsCount,
    verdictCounts,
    completedWithoutVerdictCount: verdictCounts.COMPLETED_WITHOUT_VERDICT,
    totalCostUsd,
    meanCostUsd: totalTraces > 0 ? totalCostUsd / totalTraces : 0,
    totalLatencyMs,
    meanLatencyMs: totalTraces > 0 ? totalLatencyMs / totalTraces : 0,
    failureTaxonomyCounts,
  };

  return {
    ...body,
    scorecardHash: computeScorecardHash(body),
  };
}

function classifyMetricDirection(
  before: number,
  after: number,
  higherIsBetter: boolean
): "improved" | "regressed" | "unchanged" {
  if (after === before) return "unchanged";
  if (higherIsBetter) {
    return after > before ? "improved" : "regressed";
  }
  return after < before ? "improved" : "regressed";
}

/**
 * Compares two scorecards strictly using raw deterministic count/sum deltas
 * and improved/regressed/unchanged directions (no p-values or significance labels).
 */
export function compareScorecards(
  before: TraceSetScorecard,
  after: TraceSetScorecard
): ScorecardDelta {
  const specs: Array<{
    readonly metric: string;
    readonly beforeVal: number;
    readonly afterVal: number;
    readonly higherIsBetter: boolean;
  }> = [
    {
      metric: "tracesAllPassedCount",
      beforeVal: before.tracesAllPassedCount,
      afterVal: after.tracesAllPassedCount,
      higherIsBetter: true,
    },
    {
      metric: "tracesWithViolationsCount",
      beforeVal: before.tracesWithViolationsCount,
      afterVal: after.tracesWithViolationsCount,
      higherIsBetter: false,
    },
    {
      metric: "completedVerifiedCount",
      beforeVal: before.verdictCounts.COMPLETED_VERIFIED,
      afterVal: after.verdictCounts.COMPLETED_VERIFIED,
      higherIsBetter: true,
    },
    {
      metric: "completedWithoutVerdictCount",
      beforeVal: before.completedWithoutVerdictCount,
      afterVal: after.completedWithoutVerdictCount,
      higherIsBetter: false,
    },
    {
      metric: "totalCostUsd",
      beforeVal: before.totalCostUsd,
      afterVal: after.totalCostUsd,
      higherIsBetter: false,
    },
    {
      metric: "meanCostUsd",
      beforeVal: before.meanCostUsd,
      afterVal: after.meanCostUsd,
      higherIsBetter: false,
    },
    {
      metric: "totalLatencyMs",
      beforeVal: before.totalLatencyMs,
      afterVal: after.totalLatencyMs,
      higherIsBetter: false,
    },
    {
      metric: "meanLatencyMs",
      beforeVal: before.meanLatencyMs,
      afterVal: after.meanLatencyMs,
      higherIsBetter: false,
    },
  ];

  const afterRulesByName = new Map(after.guardrailRuleCounts.map((r) => [r.rule, r]));
  for (const bRule of before.guardrailRuleCounts) {
    const aRule = afterRulesByName.get(bRule.rule);
    if (!aRule) continue;
    specs.push({
      metric: `rule.${bRule.rule}.passedCount`,
      beforeVal: bRule.passedCount,
      afterVal: aRule.passedCount,
      higherIsBetter: true,
    });
    specs.push({
      metric: `rule.${bRule.rule}.failedCount`,
      beforeVal: bRule.failedCount,
      afterVal: aRule.failedCount,
      higherIsBetter: false,
    });
  }

  const metrics: ScorecardMetricDelta[] = specs.map((s) => ({
    metric: s.metric,
    before: s.beforeVal,
    after: s.afterVal,
    delta: s.afterVal - s.beforeVal,
    direction: classifyMetricDirection(s.beforeVal, s.afterVal, s.higherIsBetter),
  }));

  const body: ScorecardDeltaBody = {
    beforeScorecardHash: before.scorecardHash,
    afterScorecardHash: after.scorecardHash,
    metrics,
    improvedCount: metrics.filter((m) => m.direction === "improved").length,
    regressedCount: metrics.filter((m) => m.direction === "regressed").length,
    unchangedCount: metrics.filter((m) => m.direction === "unchanged").length,
  };

  return {
    ...body,
    deltaHash: computeScorecardDeltaHash(body),
  };
}

/**
 * Plain-text human-readable summary of a `TraceSetScorecard`.
 */
export function formatScorecardText(scorecard: TraceSetScorecard): string {
  const lines: string[] = [
    `Scorecard ${scorecard.scorecardId} (total=${scorecard.totalTraces}, hash=${scorecard.scorecardHash.slice(0, 12)})`,
    `Guardrails: allPassed=${scorecard.tracesAllPassedCount}, withViolations=${scorecard.tracesWithViolationsCount}`,
    `Completed without verdict: ${scorecard.completedWithoutVerdictCount}`,
    `Cost USD: total=${scorecard.totalCostUsd}, mean=${scorecard.meanCostUsd}`,
    `Latency ms: total=${scorecard.totalLatencyMs}, mean=${scorecard.meanLatencyMs}`,
  ];
  for (const r of scorecard.guardrailRuleCounts) {
    lines.push(`  [${r.rule}] passed=${r.passedCount} failed=${r.failedCount}`);
  }
  return lines.join("\n");
}

/**
 * Plain-text human-readable summary of a `ScorecardDelta` (raw counts only).
 */
export function formatScorecardDeltaText(delta: ScorecardDelta): string {
  const lines: string[] = [
    `ScorecardDelta improved=${delta.improvedCount} regressed=${delta.regressedCount} unchanged=${delta.unchangedCount} (hash=${delta.deltaHash.slice(0, 12)})`,
  ];
  for (const m of delta.metrics) {
    if (m.direction !== "unchanged") {
      lines.push(`  [${m.direction}] ${m.metric}: ${m.before} -> ${m.after} (delta ${m.delta})`);
    }
  }
  return lines.join("\n");
}
