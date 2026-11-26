import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteStateStore, SqliteTraceStore } from "../../src/adapters/persistence/index.js";
import { RunTrace, TraceSpan } from "../../src/domain/index.js";
import {
  TraceReplayRunner,
  compareScorecards,
  diffReplayReports,
  diffTraces,
  formatScorecardDeltaText,
  formatScorecardText,
  formatTraceDiffText,
  scoreTraceSet,
} from "../../src/evidence/index.js";
import { generateSyntheticTraceFixtures } from "../fixtures/trace-fixtures.js";

describe("Idea 3 Phase 4 — Deterministic Trace Differ & Trace-Set Scorecard", () => {
  let tmpDir: string;
  let dbPath: string;
  let store: SqliteStateStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-diff-p4-"));
    dbPath = path.join(tmpDir, "emerald-diff.db");
    store = new SqliteStateStore({ location: dbPath });
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // ignore if already closed
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("1. Trace Differ & Replay Report Differ", () => {
    it("produces an empty diff for identical traces and identical replay reports", async () => {
      const fx02 = generateSyntheticTraceFixtures()[1]!;
      const emptyTraceDiff = diffTraces(fx02, fx02);

      expect(emptyTraceDiff.isEmpty).toBe(true);
      expect(emptyTraceDiff.changes).toEqual([]);
      expect(emptyTraceDiff.summary).toEqual({
        sameCount: fx02.spans.length,
        changedCount: 0,
        addedCount: 0,
        removedCount: 0,
      });
      expect(emptyTraceDiff.verdictTransitions).toEqual([]);
      expect(emptyTraceDiff.approvalDifferences).toEqual([]);
      expect(emptyTraceDiff.costDeltaUsd).toBe(0);
      expect(emptyTraceDiff.latencyDeltaMs).toBe(0);
      expect(emptyTraceDiff.ruleOutcomeChanges).toEqual([]);

      const runner = new TraceReplayRunner();
      const rep = await runner.replay(fx02);
      const emptyReportDiff = diffReplayReports(rep, rep);
      expect(emptyReportDiff.isEmpty).toBe(true);
      expect(emptyReportDiff.ruleOutcomeChanges).toEqual([]);
      expect(emptyReportDiff.verdictTransitions).toEqual([]);
      expect(emptyReportDiff.costDeltaUsd).toBe(0);
      expect(emptyReportDiff.latencyDeltaMs).toBe(0);
    });

    it("detects exact changed fields on one modified span (status, verdict, cost, latency, provenance, argsSummary)", () => {
      const fx02 = generateSyntheticTraceFixtures()[1]!;

      // 1) Cost & latency & status change on LLM span
      const modifiedLlm: RunTrace = {
        ...fx02,
        spans: fx02.spans.map((s) =>
          s.spanId === "span-02-llm-1"
            ? {
                ...s,
                status: "TIMED_OUT",
                costUsd: 0.025,
                latencyMs: 4200,
                argsSummary: { step: 1, endpoint: "http://127.0.0.1:11434", retry: 1 },
              }
            : s
        ),
      };
      const llmDiff = diffTraces(fx02, modifiedLlm);
      expect(llmDiff.isEmpty).toBe(false);
      expect(llmDiff.summary.changedCount).toBe(1);
      expect(llmDiff.summary.sameCount).toBe(fx02.spans.length - 1);
      const changedEntry = llmDiff.changes[0]!;
      expect(changedEntry.spanId).toBe("span-02-llm-1");
      expect(changedEntry.change).toBe("changed");
      expect(changedEntry.changedFields).toEqual(["status", "cost", "latency", "argsSummary"]);
      expect(llmDiff.costDeltaUsd).toBeCloseTo(0.025, 10);
      expect(llmDiff.latencyDeltaMs).toBe(1200);

      // 2) Provenance & verdict change
      const modifiedProvAndVerdict: RunTrace = {
        ...fx02,
        spans: fx02.spans.map((s) => {
          if (s.spanId === "span-02-tool-edit") {
            return { ...s, provenance: "untrusted" };
          }
          if (s.spanId === "span-02-verify") {
            return { ...s, resultSummary: { verdict: "FAILED" } };
          }
          return s;
        }),
      };
      const pvDiff = diffTraces(fx02, modifiedProvAndVerdict);
      const provChange = pvDiff.changes.find((c) => c.spanId === "span-02-tool-edit")!;
      expect(provChange.changedFields).toContain("provenance");
      const verdictChange = pvDiff.changes.find((c) => c.spanId === "span-02-verify")!;
      expect(verdictChange.changedFields).toContain("verdict");
    });

    it("detects added and removed spans without misclassifying untouched spans, and diffs verdicts/approvals/rules", async () => {
      const fixtures = generateSyntheticTraceFixtures();
      const fx03 = fixtures.find((t) => t.traceId === "trace-03-approval-pause-pending")!;
      const fx02 = fixtures[1]!;

      const extraToolSpan: TraceSpan = {
        spanId: "span-02-tool-lint",
        parentSpanId: "span-02-agent",
        kind: "tool",
        name: "read_file",
        startedAt: "2026-11-26T10:00:13.000Z",
        endedAt: "2026-11-26T10:00:13.100Z",
        latencyMs: 100,
        tokensIn: null,
        tokensOut: null,
        costUsd: null,
        status: "OK",
        provenance: "trusted",
        argsSummary: { path: "tsconfig.json" },
        resultSummary: { ok: true },
      };

      const withInserted: RunTrace = {
        ...fx02,
        spans: [fx02.spans[0]!, fx02.spans[1]!, extraToolSpan, ...fx02.spans.slice(2)],
      };
      const addedDiff = diffTraces(fx02, withInserted);
      expect(addedDiff.summary.addedCount).toBe(1);
      expect(addedDiff.summary.removedCount).toBe(0);
      expect(addedDiff.summary.changedCount).toBe(0);
      expect(addedDiff.summary.sameCount).toBe(fx02.spans.length);
      expect(addedDiff.changes[0]!.spanId).toBe("span-02-tool-lint");
      expect(addedDiff.changes[0]!.change).toBe("added");

      const removedDiff = diffTraces(withInserted, fx02);
      expect(removedDiff.summary.removedCount).toBe(1);
      expect(removedDiff.summary.addedCount).toBe(0);
      expect(removedDiff.summary.changedCount).toBe(0);
      expect(removedDiff.changes[0]!.spanId).toBe("span-02-tool-lint");
      expect(removedDiff.changes[0]!.change).toBe("removed");

      // Approval & verdict transition + diffReplayReports rule comparison
      const fx03Approved: RunTrace = {
        ...fx03,
        status: "COMPLETED",
        approvalEvents: [
          {
            ...fx03.approvalEvents[0]!,
            status: "CONSUMED",
            decidedAt: "2026-11-26T10:00:23.000Z",
            approver: "operator-alice",
          },
        ],
        verificationVerdicts: [
          {
            verifierId: "sovereign-verifier",
            specId: "spec-branch",
            verdict: "VERIFIED",
            verifiedAt: "2026-11-26T10:00:24.000Z",
            proofHash: "f".repeat(64),
            messageSummary: "Approved operation completed cleanly.",
            evidenceIds: ["evi-03b"],
          },
        ],
      };
      const approvalTraceDiff = diffTraces(fx03, fx03Approved);
      expect(approvalTraceDiff.approvalDifferences).toEqual([
        {
          approvalId: "appr-fx-03",
          operation: "delete_branch",
          oldStatus: "PENDING",
          newStatus: "CONSUMED",
          oldApprover: null,
          newApprover: "operator-alice",
          change: "changed",
        },
      ]);
      expect(approvalTraceDiff.verdictTransitions).toEqual([
        {
          verifierId: "sovereign-verifier",
          specId: "spec-branch",
          oldVerdict: null,
          newVerdict: "VERIFIED",
          change: "added",
        },
      ]);

      // Replay report rule outcome diff between fixture 15 (missing verification) and fixed 15
      const fx15 = fixtures.find((t) => t.traceId === "trace-15-secret-redaction-env-dump")!;
      const fx15Fixed: RunTrace = {
        ...fx15,
        verificationVerdicts: fx02.verificationVerdicts,
      };
      const runner = new TraceReplayRunner();
      const repOld = await runner.replay(fx15);
      const repNew = await runner.replay(fx15Fixed);
      const repDiff = diffReplayReports(repOld, repNew);
      expect(repDiff.isEmpty).toBe(false);
      expect(repDiff.checksPassedDelta).toBe(1);
      expect(repDiff.checksFailedDelta).toBe(-1);
      expect(repDiff.ruleOutcomeChanges).toEqual([
        {
          rule: "verification",
          oldPassed: false,
          newPassed: true,
          oldViolationCount: 1,
          newViolationCount: 0,
          direction: "improved",
        },
      ]);

      const diffText = formatTraceDiffText(approvalTraceDiff);
      expect(diffText).toContain("TraceDiff:");
      expect(diffText).toContain("Spans:");
    });
  });

  describe("2. Trace-Set Scorecard on all 20 fixtures & Delta", () => {
    it("counts all 20 fixtures with zero sampling and exact status, guardrail, verdict, and taxonomy counts", async () => {
      const fixtures = generateSyntheticTraceFixtures();
      expect(fixtures).toHaveLength(20);

      const runner = new TraceReplayRunner();
      const reports = [];
      for (const fx of fixtures) {
        reports.push(await runner.replay(fx));
      }

      const traceScorecard = scoreTraceSet(fixtures, { scorecardId: "fixtures-20-traces" });
      const reportScorecard = scoreTraceSet(reports, { scorecardId: "fixtures-20-reports" });

      expect(traceScorecard.totalTraces).toBe(20);
      expect(reportScorecard.totalTraces).toBe(20);

      expect(traceScorecard.statusCounts).toEqual({
        CANCELLED: 1,
        COMPLETED: 11,
        FAILED: 4,
        QUARANTINED: 1,
        TIMED_OUT: 2,
        WAITING_APPROVAL: 1,
      });
      expect(reportScorecard.statusCounts).toEqual(traceScorecard.statusCounts);

      expect(traceScorecard.tracesAllPassedCount).toBe(18);
      expect(traceScorecard.tracesWithViolationsCount).toBe(2);
      expect(traceScorecard.guardrailRuleCounts).toEqual([
        { rule: "schema_valid", passedCount: 20, failedCount: 0 },
        { rule: "provenance", passedCount: 19, failedCount: 1 },
        { rule: "redaction", passedCount: 20, failedCount: 0 },
        { rule: "capability", passedCount: 19, failedCount: 1 },
        { rule: "approval", passedCount: 20, failedCount: 0 },
        { rule: "verification", passedCount: 19, failedCount: 1 },
        { rule: "llm_telemetry", passedCount: 20, failedCount: 0 },
      ]);
      expect(reportScorecard.guardrailRuleCounts).toEqual(traceScorecard.guardrailRuleCounts);

      // Verdicts sum strictly to 20 and isolate COMPLETED_WITHOUT_VERDICT (fixture 15)
      expect(traceScorecard.completedWithoutVerdictCount).toBe(1);
      expect(traceScorecard.verdictCounts).toEqual({
        COMPLETED_VERIFIED: 10,
        COMPLETED_WITHOUT_VERDICT: 1,
        COMPLETED_NON_VERIFIED: 0,
        VERIFIED: 0,
        FAILED: 1,
        REJECTED: 3,
        UNVERIFIABLE: 0,
        NO_VERDICT_NON_COMPLETED: 5,
      });
      const verdictSum = Object.values(traceScorecard.verdictCounts).reduce((a, b) => a + b, 0);
      expect(verdictSum).toBe(20);
      expect(reportScorecard.verdictCounts).toEqual(traceScorecard.verdictCounts);

      // Failure taxonomy sums strictly to 20
      expect(traceScorecard.failureTaxonomyCounts).toEqual({
        NONE: 10,
        APPROVAL_PENDING: 1,
        APPROVAL_REJECTED: 1,
        REPAIR_EXHAUSTED: 1,
        TENANT_ISOLATION_DENIED: 1,
        PROMPT_INJECTION_POISONING: 1,
        UNVERIFIED_COMPLETION: 1,
        EMPTY_PATCH_REJECTED: 1,
        TIMEOUT_LLM: 1,
        TIMEOUT_TOOL: 1,
        OPERATOR_CANCELLED: 1,
        OTHER_FAILURE: 0,
      });
      const taxSum = Object.values(traceScorecard.failureTaxonomyCounts).reduce((a, b) => a + b, 0);
      expect(taxSum).toBe(20);

      // Means & totals present and never emit p-value / significance labels
      expect(traceScorecard.totalLatencyMs).toBeGreaterThan(0);
      expect(traceScorecard.meanLatencyMs).toBe(traceScorecard.totalLatencyMs / 20);
      const rendered = formatScorecardText(traceScorecard);
      expect(rendered.toLowerCase()).not.toContain("p-value");
      expect(rendered.toLowerCase()).not.toContain("significant");
    });

    it("handles COMPLETED-without-verdict cleanly in its own outcome without dropping or crashing", () => {
      const fx01 = generateSyntheticTraceFixtures()[0]!;
      const unverifiedCompletion: RunTrace = {
        ...fx01,
        traceId: "trace-completed-no-verdict",
        runId: "run-completed-no-verdict",
        status: "COMPLETED",
        verificationVerdicts: [],
      };
      const scorecard = scoreTraceSet([unverifiedCompletion]);
      expect(scorecard.totalTraces).toBe(1);
      expect(scorecard.completedWithoutVerdictCount).toBe(1);
      expect(scorecard.verdictCounts.COMPLETED_WITHOUT_VERDICT).toBe(1);
      expect(scorecard.failureTaxonomyCounts.UNVERIFIED_COMPLETION).toBe(1);
      expect(scorecard.guardrailRuleCounts.find((r) => r.rule === "verification")).toEqual({
        rule: "verification",
        passedCount: 0,
        failedCount: 1,
      });
    });

    it("computes accurate improved/regressed/unchanged scorecard delta directions with raw counts only", () => {
      const fixtures = generateSyntheticTraceFixtures();
      const before = scoreTraceSet(fixtures, { scorecardId: "before" });

      // Fix fixture 15 by attaching a VERIFIED verdict and cut latency on fixture 02
      const improvedFixtures = fixtures.map((fx) => {
        if (fx.traceId === "trace-15-secret-redaction-env-dump") {
          return {
            ...fx,
            verificationVerdicts: fixtures[0]!.verificationVerdicts,
          };
        }
        if (fx.traceId === "trace-02-ollama-1.5b-success-patch") {
          return {
            ...fx,
            spans: fx.spans.map((s) =>
              s.spanId === "span-02-llm-1" ? { ...s, latencyMs: 1000 } : s
            ),
          };
        }
        return fx;
      });
      const after = scoreTraceSet(improvedFixtures, { scorecardId: "after" });
      const delta = compareScorecards(before, after);

      const metricMap = new Map(delta.metrics.map((m) => [m.metric, m]));
      expect(metricMap.get("tracesAllPassedCount")?.direction).toBe("improved");
      expect(metricMap.get("tracesAllPassedCount")?.delta).toBe(1);
      expect(metricMap.get("tracesWithViolationsCount")?.direction).toBe("improved");
      expect(metricMap.get("tracesWithViolationsCount")?.delta).toBe(-1);
      expect(metricMap.get("completedVerifiedCount")?.direction).toBe("improved");
      expect(metricMap.get("completedWithoutVerdictCount")?.direction).toBe("improved");
      expect(metricMap.get("completedWithoutVerdictCount")?.delta).toBe(-1);
      expect(metricMap.get("rule.verification.passedCount")?.direction).toBe("improved");
      expect(metricMap.get("totalLatencyMs")?.direction).toBe("improved");
      expect(metricMap.get("totalLatencyMs")?.delta).toBe(-2000);
      expect(metricMap.get("rule.provenance.passedCount")?.direction).toBe("unchanged");
      expect(delta.regressedCount).toBe(0);

      // Reverse direction proves regression detection
      const regressedDelta = compareScorecards(after, before);
      const regMap = new Map(regressedDelta.metrics.map((m) => [m.metric, m]));
      expect(regMap.get("tracesAllPassedCount")?.direction).toBe("regressed");
      expect(regMap.get("totalLatencyMs")?.direction).toBe("regressed");
      expect(regressedDelta.improvedCount).toBe(0);

      const deltaText = formatScorecardDeltaText(delta);
      expect(deltaText.toLowerCase()).not.toContain("p-value");
      expect(deltaText.toLowerCase()).not.toContain("significant");
    });
  });

  describe("3. Determinism & SQLite WAL persistence", () => {
    it("produces identical diff, scorecard, delta, and hashes across repeated runs and persists in WAL DB", () => {
      const fixtures = generateSyntheticTraceFixtures();
      const d1 = diffTraces(fixtures[1]!, fixtures[5]!);
      const d2 = diffTraces(fixtures[1]!, fixtures[5]!);
      expect(d1).toEqual(d2);
      expect(d1.diffHash).toBe(d2.diffHash);

      const s1 = scoreTraceSet(fixtures, { scorecardId: "wal-20" });
      const s2 = scoreTraceSet(fixtures, { scorecardId: "wal-20" });
      expect(s1).toEqual(s2);
      expect(s1.scorecardHash).toBe(s2.scorecardHash);

      const cd1 = compareScorecards(s1, s2);
      const cd2 = compareScorecards(s1, s2);
      expect(cd1).toEqual(cd2);
      expect(cd1.deltaHash).toBe(cd2.deltaHash);
      expect(cd1.improvedCount).toBe(0);
      expect(cd1.regressedCount).toBe(0);

      const traceStore = store.getTraceStore();
      traceStore.writeTraceDiff(d1, "2026-11-26T13:00:00.000Z");
      traceStore.writeScorecard(s1, "2026-11-26T13:00:00.000Z");
      store.close();

      const reopened = new SqliteTraceStore({ location: dbPath });
      try {
        expect(reopened.readTraceDiffByHash(d1.diffHash)).toEqual(d1);
        expect(reopened.readScorecardById("wal-20")).toEqual(s1);
      } finally {
        reopened.close();
      }
    });
  });
});
