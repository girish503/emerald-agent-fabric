/**
 * Deterministic Trace Differ & Replay Report Differ (Idea 3, Phase 4).
 *
 * Compares two `RunTrace` objects or two `TraceReplayReport` objects span by span
 * and rule by rule. Identical inputs produce an empty diff (`isEmpty: true`).
 * Zero model calls, zero tool executions, deterministic canonical `diffHash`.
 */

import { canonicalJsonStringify } from "../domain/canonical-hash.js";
import type {
  RunTrace,
  TraceApprovalEvent,
  TraceSpan,
  TraceVerificationVerdict,
} from "../domain/trace.js";
import type { GuardrailCheckOutcome, TraceReplayReport } from "../domain/trace-replay.js";
import {
  ApprovalDifference,
  GuardrailRuleOutcomeDiff,
  ReplayReportDiff,
  ReplayReportDiffBody,
  TraceDiff,
  TraceDiffBody,
  TraceSpanDiffEntry,
  TraceSpanDiffField,
  VerdictTransition,
  computeReplayReportDiffHash,
  computeTraceDiffHash,
} from "../domain/trace-diff.js";
import { evaluateTraceGuardrails } from "./trace-replay-runner.js";

function spanMatchKey(span: TraceSpan): string {
  return `${span.kind}::${span.spanId}`;
}

function extractSpanVerdict(span: TraceSpan): string | null {
  if (span.resultSummary && typeof span.resultSummary === "object" && !Array.isArray(span.resultSummary)) {
    const v = (span.resultSummary as Record<string, unknown>).verdict;
    if (typeof v === "string") return v;
  }
  return null;
}

function sumTraceCostUsd(spans: readonly TraceSpan[]): number {
  const nonAgent = spans.filter((s) => s.kind !== "agent");
  const target = nonAgent.length > 0 ? nonAgent : spans;
  return target.reduce((acc, s) => acc + (typeof s.costUsd === "number" ? s.costUsd : 0), 0);
}

function sumTraceLatencyMs(spans: readonly TraceSpan[]): number {
  const nonAgent = spans.filter((s) => s.kind !== "agent");
  const target = nonAgent.length > 0 ? nonAgent : spans;
  return target.reduce((acc, s) => acc + (typeof s.latencyMs === "number" ? s.latencyMs : 0), 0);
}

function diffVerdictArrays(
  oldVerdicts: readonly TraceVerificationVerdict[],
  newVerdicts: readonly TraceVerificationVerdict[]
): readonly VerdictTransition[] {
  const transitions: VerdictTransition[] = [];
  const verdictKey = (v: TraceVerificationVerdict, idxBySpec: Map<string, number>): string => {
    const base = `${v.verifierId}::${v.specId}`;
    const count = (idxBySpec.get(base) ?? 0) + 1;
    idxBySpec.set(base, count);
    return `${base}#${count}`;
  };

  const oldCounts = new Map<string, number>();
  const newCounts = new Map<string, number>();
  const oldMap = new Map<string, TraceVerificationVerdict>();
  const newMap = new Map<string, TraceVerificationVerdict>();

  for (const v of oldVerdicts) {
    oldMap.set(verdictKey(v, oldCounts), v);
  }
  for (const v of newVerdicts) {
    newMap.set(verdictKey(v, newCounts), v);
  }

  for (const [k, oldV] of oldMap) {
    const newV = newMap.get(k);
    if (!newV) {
      transitions.push({
        verifierId: oldV.verifierId,
        specId: oldV.specId,
        oldVerdict: oldV.verdict,
        newVerdict: null,
        change: "removed",
      });
    } else if (oldV.verdict !== newV.verdict) {
      transitions.push({
        verifierId: oldV.verifierId,
        specId: oldV.specId,
        oldVerdict: oldV.verdict,
        newVerdict: newV.verdict,
        change: "changed",
      });
    }
  }

  for (const [k, newV] of newMap) {
    if (!oldMap.has(k)) {
      transitions.push({
        verifierId: newV.verifierId,
        specId: newV.specId,
        oldVerdict: null,
        newVerdict: newV.verdict,
        change: "added",
      });
    }
  }

  return transitions;
}

function diffApprovals(
  oldApprovals: readonly TraceApprovalEvent[],
  newApprovals: readonly TraceApprovalEvent[]
): readonly ApprovalDifference[] {
  const diffs: ApprovalDifference[] = [];
  const oldMap = new Map(oldApprovals.map((a) => [a.approvalId, a]));
  const newMap = new Map(newApprovals.map((a) => [a.approvalId, a]));

  for (const oldA of oldApprovals) {
    const newA = newMap.get(oldA.approvalId);
    if (!newA) {
      diffs.push({
        approvalId: oldA.approvalId,
        operation: oldA.operation,
        oldStatus: oldA.status,
        newStatus: null,
        oldApprover: oldA.approver,
        newApprover: null,
        change: "removed",
      });
    } else if (oldA.status !== newA.status || oldA.approver !== newA.approver) {
      diffs.push({
        approvalId: oldA.approvalId,
        operation: newA.operation,
        oldStatus: oldA.status,
        newStatus: newA.status,
        oldApprover: oldA.approver,
        newApprover: newA.approver,
        change: "changed",
      });
    }
  }

  for (const newA of newApprovals) {
    if (!oldMap.has(newA.approvalId)) {
      diffs.push({
        approvalId: newA.approvalId,
        operation: newA.operation,
        oldStatus: null,
        newStatus: newA.status,
        oldApprover: null,
        newApprover: newA.approver,
        change: "added",
      });
    }
  }

  return diffs;
}

function diffGuardrailChecks(
  oldChecks: readonly GuardrailCheckOutcome[],
  newChecks: readonly GuardrailCheckOutcome[]
): readonly GuardrailRuleOutcomeDiff[] {
  const newByRule = new Map(newChecks.map((c) => [c.rule, c]));
  const changes: GuardrailRuleOutcomeDiff[] = [];

  for (const oldC of oldChecks) {
    const newC = newByRule.get(oldC.rule);
    if (!newC) continue;
    if (oldC.passed === newC.passed && oldC.violationCount === newC.violationCount) {
      continue;
    }

    let direction: "improved" | "regressed" | "unchanged" = "unchanged";
    if (!oldC.passed && newC.passed) {
      direction = "improved";
    } else if (oldC.passed && !newC.passed) {
      direction = "regressed";
    } else if (newC.violationCount < oldC.violationCount) {
      direction = "improved";
    } else if (newC.violationCount > oldC.violationCount) {
      direction = "regressed";
    }

    changes.push({
      rule: oldC.rule,
      oldPassed: oldC.passed,
      newPassed: newC.passed,
      oldViolationCount: oldC.violationCount,
      newViolationCount: newC.violationCount,
      direction,
    });
  }

  return changes;
}

/**
 * Compares two `RunTrace` records span-by-span (matched by `spanId`, `kind`, and relative order),
 * returning an empty diff when both traces match identically.
 */
export function diffTraces(oldTrace: RunTrace, newTrace: RunTrace): TraceDiff {
  const oldByKey = new Map<string, { readonly span: TraceSpan; readonly index: number }>();
  const newByKey = new Map<string, { readonly span: TraceSpan; readonly index: number }>();

  oldTrace.spans.forEach((span, index) => oldByKey.set(spanMatchKey(span), { span, index }));
  newTrace.spans.forEach((span, index) => newByKey.set(spanMatchKey(span), { span, index }));

  // Relative order among common spans so adding an upstream span does not shift downstream untouched spans.
  const oldCommonOrder = new Map<string, number>();
  const newCommonOrder = new Map<string, number>();
  let oldCommonPos = 0;
  for (const s of oldTrace.spans) {
    const k = spanMatchKey(s);
    if (newByKey.has(k)) {
      oldCommonOrder.set(k, oldCommonPos++);
    }
  }
  let newCommonPos = 0;
  for (const s of newTrace.spans) {
    const k = spanMatchKey(s);
    if (oldByKey.has(k)) {
      newCommonOrder.set(k, newCommonPos++);
    }
  }

  const spans: TraceSpanDiffEntry[] = [];

  for (let newIndex = 0; newIndex < newTrace.spans.length; newIndex++) {
    const newSpan = newTrace.spans[newIndex]!;
    const key = spanMatchKey(newSpan);
    const oldEntry = oldByKey.get(key);

    if (!oldEntry) {
      spans.push({
        spanId: newSpan.spanId,
        kind: newSpan.kind,
        name: newSpan.name,
        change: "added",
        oldIndex: null,
        newIndex,
        changedFields: [],
      });
      continue;
    }

    const oldSpan = oldEntry.span;
    const changedFields: TraceSpanDiffField[] = [];
    if (oldSpan.status !== newSpan.status) changedFields.push("status");
    if (extractSpanVerdict(oldSpan) !== extractSpanVerdict(newSpan)) changedFields.push("verdict");
    if ((oldSpan.costUsd ?? null) !== (newSpan.costUsd ?? null)) changedFields.push("cost");
    if (oldSpan.latencyMs !== newSpan.latencyMs) changedFields.push("latency");
    if (oldSpan.provenance !== newSpan.provenance) changedFields.push("provenance");
    if (canonicalJsonStringify(oldSpan.argsSummary) !== canonicalJsonStringify(newSpan.argsSummary)) {
      changedFields.push("argsSummary");
    }
    if (
      canonicalJsonStringify(oldSpan.resultSummary) !== canonicalJsonStringify(newSpan.resultSummary)
    ) {
      changedFields.push("resultSummary");
    }
    if (oldSpan.tokensIn !== newSpan.tokensIn || oldSpan.tokensOut !== newSpan.tokensOut) {
      changedFields.push("tokens");
    }
    if (oldCommonOrder.get(key) !== newCommonOrder.get(key)) {
      changedFields.push("order");
    }

    spans.push({
      spanId: newSpan.spanId,
      kind: newSpan.kind,
      name: newSpan.name,
      change: changedFields.length === 0 ? "same" : "changed",
      oldIndex: oldEntry.index,
      newIndex,
      changedFields,
    });
  }

  for (let oldIndex = 0; oldIndex < oldTrace.spans.length; oldIndex++) {
    const oldSpan = oldTrace.spans[oldIndex]!;
    const key = spanMatchKey(oldSpan);
    if (!newByKey.has(key)) {
      spans.push({
        spanId: oldSpan.spanId,
        kind: oldSpan.kind,
        name: oldSpan.name,
        change: "removed",
        oldIndex,
        newIndex: null,
        changedFields: [],
      });
    }
  }

  const changes = spans.filter((s) => s.change !== "same");
  const verdictTransitions = diffVerdictArrays(
    oldTrace.verificationVerdicts,
    newTrace.verificationVerdicts
  );
  const approvalDifferences = diffApprovals(oldTrace.approvalEvents, newTrace.approvalEvents);

  const oldTotalCostUsd = sumTraceCostUsd(oldTrace.spans);
  const newTotalCostUsd = sumTraceCostUsd(newTrace.spans);
  const oldTotalLatencyMs = sumTraceLatencyMs(oldTrace.spans);
  const newTotalLatencyMs = sumTraceLatencyMs(newTrace.spans);

  const oldGuardrails = evaluateTraceGuardrails(oldTrace);
  const newGuardrails = evaluateTraceGuardrails(newTrace);
  const ruleOutcomeChanges = diffGuardrailChecks(oldGuardrails.checks, newGuardrails.checks);

  const isEmpty =
    changes.length === 0 &&
    verdictTransitions.length === 0 &&
    approvalDifferences.length === 0 &&
    oldTrace.status === newTrace.status &&
    oldTotalCostUsd === newTotalCostUsd &&
    oldTotalLatencyMs === newTotalLatencyMs &&
    ruleOutcomeChanges.length === 0;

  const body: TraceDiffBody = {
    oldTraceId: oldTrace.traceId,
    newTraceId: newTrace.traceId,
    oldStatus: oldTrace.status,
    newStatus: newTrace.status,
    isEmpty,
    spans,
    changes,
    summary: {
      sameCount: spans.filter((s) => s.change === "same").length,
      changedCount: spans.filter((s) => s.change === "changed").length,
      addedCount: spans.filter((s) => s.change === "added").length,
      removedCount: spans.filter((s) => s.change === "removed").length,
    },
    verdictTransitions: [...verdictTransitions],
    approvalDifferences: [...approvalDifferences],
    oldTotalCostUsd,
    newTotalCostUsd,
    costDeltaUsd: newTotalCostUsd - oldTotalCostUsd,
    oldTotalLatencyMs,
    newTotalLatencyMs,
    latencyDeltaMs: newTotalLatencyMs - oldTotalLatencyMs,
    ruleOutcomeChanges: [...ruleOutcomeChanges],
  };

  return {
    ...body,
    diffHash: computeTraceDiffHash(body),
  };
}

/**
 * Compares two `TraceReplayReport` objects deterministically across guardrails,
 * verdicts, and recorded LLM cost/latency totals.
 */
export function diffReplayReports(
  oldReport: TraceReplayReport,
  newReport: TraceReplayReport
): ReplayReportDiff {
  const ruleOutcomeChanges = diffGuardrailChecks(oldReport.checks, newReport.checks);
  const verdictTransitions = diffVerdictArrays(oldReport.verdictsIntact, newReport.verdictsIntact);

  const oldTotalCostUsd = oldReport.llmOutputs.reduce((acc, o) => acc + (o.costUsd ?? 0), 0);
  const newTotalCostUsd = newReport.llmOutputs.reduce((acc, o) => acc + (o.costUsd ?? 0), 0);
  const oldTotalLatencyMs = oldReport.llmOutputs.reduce((acc, o) => acc + o.latencyMs, 0);
  const newTotalLatencyMs = newReport.llmOutputs.reduce((acc, o) => acc + o.latencyMs, 0);

  const checksPassedDelta = newReport.checksPassed - oldReport.checksPassed;
  const checksFailedDelta = newReport.checksFailed - oldReport.checksFailed;

  const isEmpty =
    oldReport.traceStatus === newReport.traceStatus &&
    oldReport.passed === newReport.passed &&
    checksPassedDelta === 0 &&
    checksFailedDelta === 0 &&
    ruleOutcomeChanges.length === 0 &&
    verdictTransitions.length === 0 &&
    oldTotalCostUsd === newTotalCostUsd &&
    oldTotalLatencyMs === newTotalLatencyMs;

  const body: ReplayReportDiffBody = {
    oldTraceId: oldReport.traceId,
    newTraceId: newReport.traceId,
    oldStatus: oldReport.traceStatus,
    newStatus: newReport.traceStatus,
    isEmpty,
    oldPassed: oldReport.passed,
    newPassed: newReport.passed,
    checksPassedDelta,
    checksFailedDelta,
    ruleOutcomeChanges: [...ruleOutcomeChanges],
    verdictTransitions: [...verdictTransitions],
    oldTotalCostUsd,
    newTotalCostUsd,
    costDeltaUsd: newTotalCostUsd - oldTotalCostUsd,
    oldTotalLatencyMs,
    newTotalLatencyMs,
    latencyDeltaMs: newTotalLatencyMs - oldTotalLatencyMs,
  };

  return {
    ...body,
    diffHash: computeReplayReportDiffHash(body),
  };
}

/**
 * Plain-text human-readable summary of a `TraceDiff`.
 */
export function formatTraceDiffText(diff: TraceDiff): string {
  const lines: string[] = [
    `TraceDiff: ${diff.oldTraceId} -> ${diff.newTraceId} (hash ${diff.diffHash.slice(0, 12)})`,
    `Status: ${diff.oldStatus} -> ${diff.newStatus} | Empty: ${String(diff.isEmpty)}`,
    `Spans: same=${diff.summary.sameCount} changed=${diff.summary.changedCount} added=${diff.summary.addedCount} removed=${diff.summary.removedCount}`,
    `Cost USD: ${diff.oldTotalCostUsd} -> ${diff.newTotalCostUsd} (delta ${diff.costDeltaUsd})`,
    `Latency ms: ${diff.oldTotalLatencyMs} -> ${diff.newTotalLatencyMs} (delta ${diff.latencyDeltaMs})`,
  ];
  for (const ch of diff.changes) {
    lines.push(
      `  [${ch.change}] ${ch.spanId} (${ch.kind}:${ch.name}) fields=[${ch.changedFields.join(",")}]`
    );
  }
  for (const rc of diff.ruleOutcomeChanges) {
    lines.push(
      `  [rule:${rc.rule}] ${rc.oldPassed}->${rc.newPassed} violations=${rc.oldViolationCount}->${rc.newViolationCount} (${rc.direction})`
    );
  }
  return lines.join("\n");
}
