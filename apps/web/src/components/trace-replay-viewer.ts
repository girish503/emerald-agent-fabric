/**
 * Emerald Agent Fabric — Read-Only Trace Replay, Diff & Scorecard Viewer (Idea 3, Phase 5)
 *
 * Pure functional HTML renderer and deterministic state builder for:
 * (a) Combined Trace List (backend store + 20 synthetic fixtures)
 * (b) Trace Detail (ordered span timeline + 7 guardrail outcomes & violations)
 * (c) Trace Diff View (span-level same/changed/added/removed + field changes + deltas)
 * (d) Full-Set Scorecard & Delta View (all counts + explicit latency scope labeling)
 *
 * Invariants:
 * 1. Read-Only: Zero mutating actions, zero model calls, zero network calls during render.
 * 2. Safe Escaping: All dynamic values pass through `escapeHtml`.
 * 3. Explicit Latency Scope: Every displayed latency metric states its exact scope
 *    (`all-span-total`, `llm-only`, or `span-only`). Never shows an unlabeled latency number.
 */

import type { RunTrace, TraceSpan } from "../../../../src/domain/trace.js";
import {
  TRACE_GUARDRAIL_RULES,
  type TraceReplayReport,
  type TraceReplayReportBody,
  computeTraceReplayReportHash,
} from "../../../../src/domain/trace-replay.js";
import type {
  ReplayReportDiff,
  ScorecardDelta,
  TraceDiff,
  TraceSetScorecard,
} from "../../../../src/domain/trace-diff.js";
import { evaluateTraceGuardrails } from "../../../../src/evidence/trace-replay-runner.js";
import { diffReplayReports, diffTraces } from "../../../../src/evidence/trace-differ.js";
import { compareScorecards, scoreTraceSet } from "../../../../src/evidence/trace-scorecard.js";
import { generateSyntheticTraceFixtures } from "../../../../tests/fixtures/trace-fixtures.js";
import { escapeHtml } from "./dashboard-view.js";

export type TraceLatencyScope = "all-span-total" | "llm-only";

export interface TraceReplayPanelState {
  readonly traces: readonly RunTrace[];
  readonly traceSources: Readonly<Record<string, "store" | "fixture">>;
  readonly storeTraceCount: number;
  readonly fixtureTraceCount: number;
  readonly selectedTraceId?: string;
  readonly replayReportsById: Readonly<Record<string, TraceReplayReport>>;
  readonly diffOldTraceId?: string;
  readonly diffNewTraceId?: string;
  readonly traceDiff?: TraceDiff | null;
  readonly reportDiff?: ReplayReportDiff | null;
  readonly scorecardLatencyScope: TraceLatencyScope;
  readonly scorecard: TraceSetScorecard;
  readonly scorecardBefore: TraceSetScorecard;
  readonly scorecardAfter: TraceSetScorecard;
  readonly scorecardDelta: ScorecardDelta;
  readonly loading?: boolean;
  readonly error?: string;
}

function buildOfflineReplayReport(trace: RunTrace): TraceReplayReport {
  const evaluation = evaluateTraceGuardrails(trace);
  const llmOutputs = evaluation.spans
    .filter((s) => s.kind === "llm")
    .map((span) => {
      const slashIdx = span.name.indexOf("/");
      const model =
        span.name.startsWith("llm:") && slashIdx !== -1 && slashIdx + 1 < span.name.length
          ? span.name.slice(slashIdx + 1)
          : evaluation.defaultModelName;
      const stubOutputText =
        typeof span.resultSummary === "string"
          ? span.resultSummary
          : JSON.stringify(span.resultSummary ?? null);
      return {
        spanId: span.spanId,
        model,
        recordedResultSummary: span.resultSummary ?? null,
        stubOutputText,
        costUsd: typeof span.costUsd === "number" ? span.costUsd : null,
        latencyMs: typeof span.latencyMs === "number" && span.latencyMs >= 0 ? span.latencyMs : 0,
      };
    });

  const body: TraceReplayReportBody = {
    traceId: evaluation.traceId,
    runId: evaluation.runId,
    missionId: evaluation.missionId,
    formatVersion: evaluation.formatVersion,
    traceStatus: evaluation.traceStatus,
    mode: "stub-replay",
    spansWalked: evaluation.spans.length,
    llmOutputs,
    verdictsIntact: [...evaluation.verificationVerdicts],
    approvalSummary: evaluation.approvalSummary,
    redactionObservations: [...evaluation.redactionObservations],
    checks: [...evaluation.checks],
    checksPassed: evaluation.checksPassed,
    checksFailed: evaluation.checksFailed,
    passed: evaluation.passed,
    violations: [...evaluation.violations],
  };

  return {
    ...body,
    reportHash: computeTraceReplayReportHash(body),
  };
}

function scoreWithScope(
  traces: readonly RunTrace[],
  reportsById: Readonly<Record<string, TraceReplayReport>>,
  scope: TraceLatencyScope,
  scorecardId: string
): TraceSetScorecard {
  if (scope === "llm-only") {
    const reports = traces.map((t) => reportsById[t.traceId] ?? buildOfflineReplayReport(t));
    return scoreTraceSet(reports, { scorecardId });
  }
  return scoreTraceSet(traces, { scorecardId });
}

function buildScorecardComparisonPair(
  traces: readonly RunTrace[],
  reportsById: Readonly<Record<string, TraceReplayReport>>,
  scope: TraceLatencyScope
): {
  readonly before: TraceSetScorecard;
  readonly after: TraceSetScorecard;
  readonly delta: ScorecardDelta;
} {
  const before = scoreWithScope(traces, reportsById, scope, `before-${scope}`);
  const verifiedSample = traces.find((t) => t.verificationVerdicts.length > 0)?.verificationVerdicts;
  const remediatedTraces = traces.map((t) => {
    if (t.status === "COMPLETED" && t.verificationVerdicts.length === 0 && verifiedSample) {
      return { ...t, verificationVerdicts: verifiedSample };
    }
    return t;
  });
  const remediatedReportsById: Record<string, TraceReplayReport> = {};
  for (const t of remediatedTraces) {
    remediatedReportsById[t.traceId] = buildOfflineReplayReport(t);
  }
  const after = scoreWithScope(remediatedTraces, remediatedReportsById, scope, `after-${scope}`);
  return {
    before,
    after,
    delta: compareScorecards(before, after),
  };
}

export interface BuildTraceReplayStateOptions {
  readonly storeTraces?: readonly RunTrace[];
  readonly includeFixtures?: boolean;
  readonly selectedTraceId?: string;
  readonly diffOldTraceId?: string;
  readonly diffNewTraceId?: string;
  readonly latencyScope?: TraceLatencyScope;
  readonly loading?: boolean;
  readonly error?: string;
}

/**
 * Builds deterministic initial or updated `TraceReplayPanelState` combining store traces
 * and the 20 synthetic fixtures with zero model calls.
 */
export function buildTraceReplayState(
  options: BuildTraceReplayStateOptions = {}
): TraceReplayPanelState {
  const {
    storeTraces = [],
    includeFixtures = true,
    latencyScope = "all-span-total",
    loading = false,
    error,
  } = options;

  const byId = new Map<string, RunTrace>();
  const traceSources: Record<string, "store" | "fixture"> = {};
  let storeTraceCount = 0;
  let fixtureTraceCount = 0;

  for (const t of storeTraces) {
    if (!byId.has(t.traceId)) {
      storeTraceCount += 1;
    }
    byId.set(t.traceId, t);
    traceSources[t.traceId] = "store";
  }

  if (includeFixtures) {
    for (const fx of generateSyntheticTraceFixtures()) {
      fixtureTraceCount += 1;
      if (!byId.has(fx.traceId)) {
        byId.set(fx.traceId, fx);
        traceSources[fx.traceId] = "fixture";
      }
    }
  }

  const traces = Array.from(byId.values());
  const replayReportsById: Record<string, TraceReplayReport> = {};
  for (const trace of traces) {
    replayReportsById[trace.traceId] = buildOfflineReplayReport(trace);
  }

  const selectedTraceId =
    options.selectedTraceId && byId.has(options.selectedTraceId)
      ? options.selectedTraceId
      : traces[0]?.traceId;

  const defaultOldId =
    traces.find((t) => t.traceId === "trace-02-ollama-1.5b-success-patch")?.traceId ??
    traces[0]?.traceId;
  const defaultNewId =
    traces.find((t) => t.traceId === "trace-06-verification-failure-repair-success")?.traceId ??
    traces[1]?.traceId ??
    traces[0]?.traceId;

  const diffOldTraceId =
    options.diffOldTraceId && byId.has(options.diffOldTraceId) ? options.diffOldTraceId : defaultOldId;
  const diffNewTraceId =
    options.diffNewTraceId && byId.has(options.diffNewTraceId) ? options.diffNewTraceId : defaultNewId;

  const oldTrace = diffOldTraceId ? byId.get(diffOldTraceId) : undefined;
  const newTrace = diffNewTraceId ? byId.get(diffNewTraceId) : undefined;
  const traceDiff = oldTrace && newTrace ? diffTraces(oldTrace, newTrace) : null;
  const oldRep = diffOldTraceId ? replayReportsById[diffOldTraceId] : undefined;
  const newRep = diffNewTraceId ? replayReportsById[diffNewTraceId] : undefined;
  const reportDiff = oldRep && newRep ? diffReplayReports(oldRep, newRep) : null;

  const scorecard = scoreWithScope(traces, replayReportsById, latencyScope, `traces-${traces.length}-${latencyScope}`);
  const comparison = buildScorecardComparisonPair(traces, replayReportsById, latencyScope);

  return {
    traces,
    traceSources,
    storeTraceCount,
    fixtureTraceCount,
    selectedTraceId,
    replayReportsById,
    diffOldTraceId,
    diffNewTraceId,
    traceDiff,
    reportDiff,
    scorecardLatencyScope: latencyScope,
    scorecard,
    scorecardBefore: comparison.before,
    scorecardAfter: comparison.after,
    scorecardDelta: comparison.delta,
    loading,
    error,
  };
}

function summarizeTraceVerdict(trace: RunTrace): string {
  if (trace.verificationVerdicts.length === 0) {
    return trace.status === "COMPLETED" ? "COMPLETED_WITHOUT_VERDICT" : "NO_VERDICT";
  }
  return trace.verificationVerdicts[trace.verificationVerdicts.length - 1]!.verdict;
}

function formatStatusClass(status: string): string {
  switch (status) {
    case "COMPLETED":
    case "OK":
    case "VERIFIED":
      return "badge-green";
    case "WAITING_APPROVAL":
    case "PAUSED":
    case "TIMED_OUT":
      return "badge-yellow";
    case "FAILED":
    case "ERROR":
    case "DENIED":
    case "REJECTED":
    case "QUARANTINED":
      return "badge-red";
    default:
      return "badge-gray";
  }
}

function renderSpanSummaryPreview(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function renderTraceDetailSection(
  trace: RunTrace | undefined,
  report: TraceReplayReport | undefined
): string {
  if (!trace || !report) {
    return `<div id="trace-detail-panel" class="trace-subpanel"><p class="empty-hint">Select a trace to inspect its span timeline and 7 guardrail checks.</p></div>`;
  }

  const spanRows = trace.spans
    .map((span: TraceSpan, idx: number) => {
      const costText = span.costUsd === null ? "n/a" : `$${span.costUsd}`;
      const provText = span.provenance ?? "n/a";
      return `
        <tr data-span-id="${escapeHtml(span.spanId)}" class="trace-span-row">
          <td>${idx + 1}</td>
          <td class="font-mono">${escapeHtml(span.spanId)}</td>
          <td><span class="badge badge-blue">${escapeHtml(span.kind)}</span></td>
          <td>${escapeHtml(span.name)}</td>
          <td><span class="badge ${formatStatusClass(span.status)}">${escapeHtml(span.status)}</span></td>
          <td>${span.latencyMs} ms <span class="scope-tag">(span-only)</span></td>
          <td>${escapeHtml(costText)}</td>
          <td>${escapeHtml(provText)}</td>
          <td class="font-mono trace-summary-cell">${escapeHtml(renderSpanSummaryPreview(span.resultSummary))}</td>
        </tr>
      `.trim();
    })
    .join("");

  const checkCards = report.checks
    .map((check) => {
      const badgeClass = check.passed ? "badge-green" : "badge-red";
      const label = check.passed ? "PASS" : `FAIL (${check.violationCount})`;
      return `
        <div class="trace-check-pill" data-guardrail-rule="${escapeHtml(check.rule)}">
          <span class="font-mono">${escapeHtml(check.rule)}</span>
          <span class="badge ${badgeClass}">${escapeHtml(label)}</span>
        </div>
      `.trim();
    })
    .join("");

  const violationsHtml =
    report.violations.length === 0
      ? `<p class="trace-clean-msg">Zero guardrail violations detected.</p>`
      : `<ul id="trace-guardrail-violations" class="trace-violations-list">${report.violations
          .map(
            (v) => `
            <li data-violation-span="${escapeHtml(v.spanId)}" data-violation-rule="${escapeHtml(v.rule)}">
              <strong class="font-mono">[${escapeHtml(v.rule)}]</strong>
              <span class="font-mono">${escapeHtml(v.spanId)}</span>:
              ${escapeHtml(v.message)}
            </li>
          `.trim()
          )
          .join("")}</ul>`;

  const modelLabel = trace.model
    ? `${trace.model.provider}/${trace.model.model} (temp=${trace.model.temperature ?? "default"}, seed=${trace.model.seed ?? "null"})`
    : "stub (model: null)";

  const redactionNote =
    report.redactionObservations.length > 0
      ? `<p class="trace-redaction-note">Redaction markers observed in spans: <code class="font-mono">${escapeHtml(report.redactionObservations.join(", "))}</code></p>`
      : "";

  return `
    <div id="trace-detail-panel" class="trace-subpanel">
      <div class="trace-detail-header">
        <div>
          <h3>Trace Detail: <code class="font-mono">${escapeHtml(trace.traceId)}</code></h3>
          <div class="trace-meta-row">
            <span>Run: <code class="font-mono">${escapeHtml(trace.runId)}</code></span>
            <span>Format: <code class="font-mono">${escapeHtml(trace.formatVersion)}</code></span>
            <span>Status: <span class="badge ${formatStatusClass(trace.status)}">${escapeHtml(trace.status)}</span></span>
            <span>Model: <code class="font-mono">${escapeHtml(modelLabel)}</code></span>
            <span>Report Hash: <code class="font-mono">${escapeHtml(report.reportHash.slice(0, 16))}</code></span>
          </div>
          ${redactionNote}
        </div>
      </div>

      <h4>Guardrail Checks (${report.checksPassed}/${TRACE_GUARDRAIL_RULES.length} Passed)</h4>
      <div id="trace-guardrail-checks" class="trace-checks-grid">${checkCards}</div>
      ${violationsHtml}

      <h4>Span Timeline in Recorded Order (${trace.spans.length} spans)</h4>
      <div class="trace-table-scroll">
        <table id="trace-span-timeline" class="trace-data-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Span ID</th>
              <th>Kind</th>
              <th>Name</th>
              <th>Status</th>
              <th>Latency (span-only)</th>
              <th>Cost</th>
              <th>Provenance</th>
              <th>Redacted Result</th>
            </tr>
          </thead>
          <tbody>${spanRows}</tbody>
        </table>
      </div>
    </div>
  `.trim();
}

function renderTraceDiffSection(state: TraceReplayPanelState): string {
  const optionsHtmlOld = state.traces
    .map(
      (t) =>
        `<option value="${escapeHtml(t.traceId)}"${t.traceId === state.diffOldTraceId ? " selected" : ""}>${escapeHtml(t.traceId)} (${escapeHtml(t.status)})</option>`
    )
    .join("");
  const optionsHtmlNew = state.traces
    .map(
      (t) =>
        `<option value="${escapeHtml(t.traceId)}"${t.traceId === state.diffNewTraceId ? " selected" : ""}>${escapeHtml(t.traceId)} (${escapeHtml(t.status)})</option>`
    )
    .join("");

  const diff = state.traceDiff;
  const repDiff = state.reportDiff;
  if (!diff) {
    return `<div id="trace-diff-panel" class="trace-subpanel"><p class="empty-hint">Select two traces to inspect structural and guardrail differences.</p></div>`;
  }

  const spanDiffRows = diff.spans
    .map(
      (s) => `
      <tr data-diff-span-id="${escapeHtml(s.spanId)}" data-diff-change="${escapeHtml(s.change)}">
        <td class="font-mono">${escapeHtml(s.spanId)}</td>
        <td>${escapeHtml(s.kind)}</td>
        <td><span class="badge ${s.change === "same" ? "badge-gray" : s.change === "added" ? "badge-green" : s.change === "removed" ? "badge-red" : "badge-yellow"}">${escapeHtml(s.change)}</span></td>
        <td class="font-mono">${s.changedFields.length > 0 ? escapeHtml(s.changedFields.join(", ")) : "—"}</td>
      </tr>
    `.trim()
    )
    .join("");

  const verdictRows =
    diff.verdictTransitions.length === 0
      ? `<span class="trace-muted">None</span>`
      : diff.verdictTransitions
          .map(
            (v) =>
              `<code class="font-mono">${escapeHtml(v.specId)}: ${escapeHtml(v.oldVerdict ?? "none")} -> ${escapeHtml(v.newVerdict ?? "none")} (${escapeHtml(v.change)})</code>`
          )
          .join("; ");

  const ruleRows =
    repDiff && repDiff.ruleOutcomeChanges.length > 0
      ? repDiff.ruleOutcomeChanges
          .map(
            (rc) =>
              `<span class="badge ${rc.direction === "improved" ? "badge-green" : rc.direction === "regressed" ? "badge-red" : "badge-gray"}">${escapeHtml(rc.rule)}: ${rc.oldPassed ? "PASS" : "FAIL"} -> ${rc.newPassed ? "PASS" : "FAIL"} (${escapeHtml(rc.direction)})</span>`
          )
          .join(" ")
      : `<span class="trace-muted">No guardrail rule changes</span>`;

  return `
    <div id="trace-diff-panel" class="trace-subpanel">
      <h3>Trace Diff View (Read-Only)</h3>
      <div class="trace-diff-controls">
        <label for="diff-old-select">Old Trace:
          <select id="diff-old-select" data-action="select-diff-old">${optionsHtmlOld}</select>
        </label>
        <label for="diff-new-select">New Trace:
          <select id="diff-new-select" data-action="select-diff-new">${optionsHtmlNew}</select>
        </label>
      </div>
      <div class="trace-meta-row">
        <span>Diff Empty: <strong>${diff.isEmpty ? "YES" : "NO"}</strong></span>
        <span>Diff Hash: <code class="font-mono">${escapeHtml(diff.diffHash.slice(0, 16))}</code></span>
        <span>Spans: same=${diff.summary.sameCount}, changed=${diff.summary.changedCount}, added=${diff.summary.addedCount}, removed=${diff.summary.removedCount}</span>
        <span>Cost Delta: $${diff.oldTotalCostUsd} -&gt; $${diff.newTotalCostUsd} (delta $${diff.costDeltaUsd})</span>
        <span>Latency Delta (all-span-total): ${diff.oldTotalLatencyMs} ms -&gt; ${diff.newTotalLatencyMs} ms (delta ${diff.latencyDeltaMs} ms)</span>
      </div>
      <p><strong>Verdict Transitions:</strong> ${verdictRows}</p>
      <p><strong>Guardrail Rule Outcome Changes:</strong> ${ruleRows}</p>
      <div class="trace-table-scroll">
        <table id="trace-diff-spans" class="trace-data-table">
          <thead>
            <tr>
              <th>Span ID</th>
              <th>Kind</th>
              <th>Change</th>
              <th>Changed Fields</th>
            </tr>
          </thead>
          <tbody>${spanDiffRows}</tbody>
        </table>
      </div>
    </div>
  `.trim();
}

function renderScorecardSection(state: TraceReplayPanelState): string {
  const sc = state.scorecard;
  const scopeLabel =
    state.scorecardLatencyScope === "llm-only"
      ? "Latency Scope: llm-only (LLM inference spans only)"
      : "Latency Scope: all-span-total (non-agent execution spans)";

  const ruleRows = sc.guardrailRuleCounts
    .map(
      (r) => `
      <tr data-scorecard-rule="${escapeHtml(r.rule)}">
        <td class="font-mono">${escapeHtml(r.rule)}</td>
        <td>${r.passedCount}</td>
        <td>${r.failedCount}</td>
      </tr>
    `.trim()
    )
    .join("");

  const verdictEntries = Object.entries(sc.verdictCounts)
    .map(
      ([k, v]) =>
        `<span class="trace-stat-chip" data-verdict-outcome="${escapeHtml(k)}"><strong>${escapeHtml(k)}:</strong> ${v}</span>`
    )
    .join(" ");

  const taxonomyEntries = Object.entries(sc.failureTaxonomyCounts)
    .map(
      ([k, v]) =>
        `<span class="trace-stat-chip" data-taxonomy="${escapeHtml(k)}"><strong>${escapeHtml(k)}:</strong> ${v}</span>`
    )
    .join(" ");

  const deltaRows = state.scorecardDelta.metrics
    .filter((m) => m.direction !== "unchanged" || m.metric === "tracesAllPassedCount")
    .map(
      (m) => `
      <tr>
        <td class="font-mono">${escapeHtml(m.metric)}</td>
        <td>${m.before}</td>
        <td>${m.after}</td>
        <td>${m.delta}</td>
        <td><span class="badge ${m.direction === "improved" ? "badge-green" : m.direction === "regressed" ? "badge-red" : "badge-gray"}">${escapeHtml(m.direction)}</span></td>
      </tr>
    `.trim()
    )
    .join("");

  return `
    <div id="trace-scorecard-panel" class="trace-subpanel">
      <div class="trace-detail-header">
        <h3>Full-Set Scorecard (${sc.totalTraces} traces counted)</h3>
        <div class="trace-diff-controls">
          <label for="scorecard-latency-scope-select">Latency Scope:
            <select id="scorecard-latency-scope-select" data-action="change-scorecard-scope">
              <option value="all-span-total"${state.scorecardLatencyScope === "all-span-total" ? " selected" : ""}>all-span-total</option>
              <option value="llm-only"${state.scorecardLatencyScope === "llm-only" ? " selected" : ""}>llm-only</option>
            </select>
          </label>
        </div>
      </div>

      <p id="scorecard-latency-scope-label" class="badge badge-blue">${escapeHtml(scopeLabel)}</p>

      <div class="trace-meta-row">
        <span>Total Traces: <strong id="scorecard-total-traces">${sc.totalTraces}</strong></span>
        <span>All Guardrails Passed: <strong>${sc.tracesAllPassedCount}</strong></span>
        <span>With Violations: <strong>${sc.tracesWithViolationsCount}</strong></span>
        <span>COMPLETED_WITHOUT_VERDICT: <strong id="scorecard-completed-without-verdict">${sc.completedWithoutVerdictCount}</strong></span>
        <span>Cost Total / Mean: <strong>$${sc.totalCostUsd} / $${sc.meanCostUsd}</strong></span>
        <span id="scorecard-latency-totals">Latency (${escapeHtml(state.scorecardLatencyScope)}): <strong>total=${sc.totalLatencyMs} ms, mean=${sc.meanLatencyMs} ms</strong></span>
        <span>Scorecard Hash: <code class="font-mono">${escapeHtml(sc.scorecardHash.slice(0, 16))}</code></span>
      </div>

      <h4>Guardrail Rule Pass &amp; Fail Counts</h4>
      <div class="trace-table-scroll">
        <table id="scorecard-rule-counts" class="trace-data-table">
          <thead>
            <tr><th>Rule</th><th>Passed</th><th>Failed</th></tr>
          </thead>
          <tbody>${ruleRows}</tbody>
        </table>
      </div>

      <h4>Verdict Outcomes (All ${sc.totalTraces} Traces Counted)</h4>
      <div id="scorecard-verdict-counts" class="trace-chips-row">${verdictEntries}</div>

      <h4>Failure Taxonomy Counts</h4>
      <div id="scorecard-failure-taxonomy" class="trace-chips-row">${taxonomyEntries}</div>

      <h4>Scorecard Delta (Before -&gt; After Remediation Preview, Raw Counts Only)</h4>
      <div id="scorecard-delta-panel" class="trace-table-scroll">
        <p class="trace-muted">Improved: ${state.scorecardDelta.improvedCount}, Regressed: ${state.scorecardDelta.regressedCount}, Unchanged: ${state.scorecardDelta.unchangedCount}</p>
        <table class="trace-data-table">
          <thead>
            <tr><th>Metric</th><th>Before</th><th>After</th><th>Delta</th><th>Direction</th></tr>
          </thead>
          <tbody>${deltaRows}</tbody>
        </table>
      </div>
    </div>
  `.trim();
}

/**
 * Main pure functional HTML renderer for the Phase 5 Trace, Replay, Diff & Scorecard workbench.
 */
export function renderTraceReplayPanel(state: TraceReplayPanelState): string {
  const selectedTrace = state.traces.find((t) => t.traceId === state.selectedTraceId) ?? state.traces[0];
  const selectedReport = selectedTrace ? state.replayReportsById[selectedTrace.traceId] : undefined;

  const traceRows = state.traces
    .map((trace) => {
      const report = state.replayReportsById[trace.traceId];
      const source = state.traceSources[trace.traceId] ?? "fixture";
      const verdict = summarizeTraceVerdict(trace);
      const isSelected = trace.traceId === selectedTrace?.traceId;
      const guardLabel = report ? `${report.checksPassed}/${TRACE_GUARDRAIL_RULES.length}` : "n/a";
      const guardClass = report?.passed ? "badge-green" : "badge-yellow";

      return `
        <tr data-trace-row-id="${escapeHtml(trace.traceId)}" class="${isSelected ? "selected" : ""}">
          <td class="font-mono">${escapeHtml(trace.traceId)}</td>
          <td>${escapeHtml(source)}</td>
          <td><span class="badge ${formatStatusClass(trace.status)}">${escapeHtml(trace.status)}</span></td>
          <td><span class="badge ${formatStatusClass(verdict)}">${escapeHtml(verdict)}</span></td>
          <td><span class="badge ${guardClass}">${escapeHtml(guardLabel)}</span></td>
          <td>
            <button type="button" class="btn-secondary" data-action="select-trace" data-trace-id="${escapeHtml(trace.traceId)}">
              ${isSelected ? "Inspecting" : "Inspect"}
            </button>
          </td>
        </tr>
      `.trim();
    })
    .join("");

  const errorHtml = state.error
    ? `<div class="error-banner" role="alert">${escapeHtml(state.error)}</div>`
    : "";

  return `
    <section id="trace-replay-workbench" class="trace-replay-workbench" aria-labelledby="trace-workbench-heading">
      <div class="section-header">
        <div>
          <h2 id="trace-workbench-heading">Trace Replay, Diff &amp; Scorecard Workbench</h2>
          <p class="trace-muted">Read-Only Offline Inspection &bull; Store: ${state.storeTraceCount} &bull; Synthetic Fixtures: ${state.fixtureTraceCount} &bull; Total: ${state.traces.length} &bull; Zero Live Model Calls</p>
        </div>
        <div>
          <button type="button" class="btn-secondary" data-action="refresh-traces"${state.loading ? " disabled" : ""}>
            ${state.loading ? "Refreshing..." : "Refresh Store Traces"}
          </button>
        </div>
      </div>
      ${errorHtml}

      <div id="trace-list-panel" class="trace-subpanel">
        <h3>Recorded Traces &amp; Synthetic Fixtures (${state.traces.length})</h3>
        <div class="trace-table-scroll">
          <table class="trace-data-table">
            <thead>
              <tr>
                <th>Trace ID</th>
                <th>Source</th>
                <th>Status</th>
                <th>Verdict</th>
                <th>Guardrails</th>
                <th>Inspect</th>
              </tr>
            </thead>
            <tbody>${traceRows}</tbody>
          </table>
        </div>
      </div>

      ${renderTraceDetailSection(selectedTrace, selectedReport)}
      ${renderTraceDiffSection(state)}
      ${renderScorecardSection(state)}
    </section>
  `.trim();
}
