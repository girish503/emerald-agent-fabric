import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteStateStore, SqliteTraceStore } from "../../src/adapters/persistence/index.js";
import {
  TRACE_FORMAT_VERSION,
  TRACE_GUARDRAIL_RULES,
  RunTrace,
  validateTraceReplayReport,
} from "../../src/domain/index.js";
import { TraceReplayRunner, TraceStubModelProvider } from "../../src/evidence/index.js";
import { generateSyntheticTraceFixtures } from "../fixtures/trace-fixtures.js";

describe("Idea 3 Phase 3 — Offline Trace Replay Runner, Stub Provider, and Guardrails", () => {
  let tmpDir: string;
  let dbPath: string;
  let store: SqliteStateStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-replay-p3-"));
    dbPath = path.join(tmpDir, "emerald-replay.db");
    store = new SqliteStateStore({ location: dbPath });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      store.close();
    } catch {
      // ignore if closed inside persistence test
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("1. Stub provider & verbatim offline LLM output replay", () => {
    it("walks spans in recorded order and returns recorded LLM output verbatim without network calls", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const fixtures = generateSyntheticTraceFixtures();
      const trace02 = fixtures.find((t) => t.traceId === "trace-02-ollama-1.5b-success-patch")!;

      const stub = new TraceStubModelProvider(trace02.spans);
      const r1 = await stub.generate({
        requestId: "req-1",
        model: "qwen2.5:1.5b",
        input: [{ role: "user", content: "step 1" }],
        timeoutMs: 1000,
      });
      const r2 = await stub.generate({
        requestId: "req-2",
        model: "qwen2.5:1.5b",
        input: [{ role: "user", content: "step 2" }],
        timeoutMs: 1000,
      });

      expect(r1.outputText).toBe(JSON.stringify({ proposedTool: "edit_file" }));
      expect(r2.outputText).toBe(JSON.stringify({ proposedTool: "run_command" }));
      expect(r1.durationMs).toBe(3000);
      expect(r2.durationMs).toBe(2000);
      expect(r1.providerMetadata?.stubReplay).toBe(true);
      await expect(
        stub.generate({
          requestId: "req-3",
          model: "qwen2.5:1.5b",
          input: [{ role: "user", content: "step 3" }],
          timeoutMs: 1000,
        })
      ).rejects.toThrow(/No recorded llm span remaining/);
      expect(fetchSpy).not.toHaveBeenCalled();

      const runner = new TraceReplayRunner();
      const report = await runner.replay(trace02);
      expect(report.llmOutputs).toHaveLength(2);
      expect(report.llmOutputs[0]!.stubOutputText).toBe(
        JSON.stringify({ proposedTool: "edit_file" })
      );
      expect(report.llmOutputs[1]!.stubOutputText).toBe(
        JSON.stringify({ proposedTool: "run_command" })
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("2. Replay all 20 synthetic fixtures", () => {
    it("replays all 20 fixtures from store by traceId, passes success fixtures, flags poisoning, and preserves verdicts", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const fixtures = generateSyntheticTraceFixtures();
      expect(fixtures).toHaveLength(20);

      const traceStore = store.getTraceStore();
      for (const fixture of fixtures) {
        traceStore.writeTrace(fixture, "2026-11-26T12:00:00.000Z");
      }

      const runner = new TraceReplayRunner({ traceStore });
      const reportsById = new Map<string, Awaited<ReturnType<TraceReplayRunner["replay"]>>>();

      for (const fixture of fixtures) {
        const report = await runner.replay(fixture.traceId, {
          persist: true,
          recordedAt: "2026-11-26T12:05:00.000Z",
        });
        expect(() => validateTraceReplayReport(report)).not.toThrow();
        expect(report.formatVersion).toBe(TRACE_FORMAT_VERSION);
        expect(report.checks).toHaveLength(TRACE_GUARDRAIL_RULES.length);
        expect(report.checksPassed + report.checksFailed).toBe(TRACE_GUARDRAIL_RULES.length);
        expect(report.spansWalked).toBe(fixture.spans.length);
        reportsById.set(fixture.traceId, report);
      }

      // 1) Success fixtures pass all 7 guardrail checks
      const successTraceIds = [
        "trace-01-stub-success-echo",
        "trace-02-ollama-1.5b-success-patch",
        "trace-04-approval-pause-approved-resumed",
        "trace-06-verification-failure-repair-success",
        "trace-08-multi-parent-dag-fanin",
        "trace-09-restart-recovery-lease-expiry",
        "trace-10-restart-recovery-checkpoint-resume",
        "trace-11-tenant-isolation-allowed",
        "trace-14-secret-redaction-tool-tokens",
        "trace-16-empty-patch-no-changes",
      ];
      for (const id of successTraceIds) {
        const r = reportsById.get(id)!;
        expect(r.passed, `${id} expected 7/7 pass, got violations: ${JSON.stringify(r.violations)}`).toBe(
          true
        );
        expect(r.checksPassed).toBe(7);
        expect(r.checksFailed).toBe(0);
        expect(r.violations).toEqual([]);
      }

      // 2) Poisoning fixture flags the provenance rule
      const poisonReport = reportsById.get("trace-13-tool-output-poisoning-untrusted")!;
      expect(poisonReport.checks.find((c) => c.rule === "provenance")?.passed).toBe(false);
      expect(
        poisonReport.violations.some(
          (v) => v.rule === "provenance" && v.spanId === "span-13-tool-blocked"
        )
      ).toBe(true);

      // 3) Secret fixtures observe redaction markers cleanly on stored schema-valid spans
      const secretTokensReport = reportsById.get("trace-14-secret-redaction-tool-tokens")!;
      expect(secretTokensReport.redactionObservations).toEqual([
        "span-14-agent",
        "span-14-tool-read",
      ]);
      const secretEnvReport = reportsById.get("trace-15-secret-redaction-env-dump")!;
      expect(secretEnvReport.redactionObservations).toEqual(["span-15-tool-read"]);
      // Fixture 15 records COMPLETED with empty verificationVerdicts -> verification guardrail catches it
      expect(secretEnvReport.checks.find((c) => c.rule === "verification")?.passed).toBe(false);

      // 4) Approval fixtures show zero executions past a pause
      for (const approvalId of [
        "trace-03-approval-pause-pending",
        "trace-04-approval-pause-approved-resumed",
        "trace-05-approval-pause-rejected",
      ]) {
        const ar = reportsById.get(approvalId)!;
        expect(ar.approvalSummary.executionAfterPauseCount).toBe(0);
        expect(ar.checks.find((c) => c.rule === "approval")?.passed).toBe(true);
      }

      // 5) Empty-patch and timeout fixtures replay cleanly with verdicts intact
      for (const edgeId of [
        "trace-16-empty-patch-no-changes",
        "trace-17-empty-patch-false-completion-rejected",
        "trace-18-timeout-llm-inference",
        "trace-19-timeout-tool-execution",
        "trace-20-cancelled-by-operator",
      ]) {
        const fixture = fixtures.find((t) => t.traceId === edgeId)!;
        const r = reportsById.get(edgeId)!;
        expect(r.passed).toBe(true);
        expect(r.verdictsIntact).toEqual(fixture.verificationVerdicts);
      }

      // Persisted reports beside traces survive DB reopen with intact hashes
      expect(traceStore.listReplayReports()).toHaveLength(20);
      store.close();
      const reopened = new SqliteTraceStore({ location: dbPath });
      try {
        const persisted02 = reopened.readReplayReportByTraceId("trace-02-ollama-1.5b-success-patch");
        expect(persisted02).toEqual(reportsById.get("trace-02-ollama-1.5b-success-patch"));
      } finally {
        reopened.close();
      }

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("3. Guardrail violation detection (non-crashing)", () => {
    it("(a) schema_valid flags unknown formatVersion and broken span structure without throwing", async () => {
      const base = generateSyntheticTraceFixtures()[0]!;
      const runner = new TraceReplayRunner();
      const badTrace = { ...base, formatVersion: "emerald-trace-v999" };

      const report = await runner.replay(badTrace);
      expect(report.passed).toBe(false);
      expect(report.checks.find((c) => c.rule === "schema_valid")?.passed).toBe(false);
      expect(report.violations.some((v) => v.rule === "schema_valid")).toBe(true);
    });

    it("(c) redaction flags raw secret-shaped strings and sensitive keys in stored spans", async () => {
      const fixtures = generateSyntheticTraceFixtures();
      const fx14 = fixtures.find((t) => t.traceId === "trace-14-secret-redaction-tool-tokens")!;
      const fx15 = fixtures.find((t) => t.traceId === "trace-15-secret-redaction-env-dump")!;
      const runner = new TraceReplayRunner();

      const leaky14: Record<string, unknown> = {
        ...fx14,
        spans: fx14.spans.map((s) =>
          s.spanId === "span-14-tool-read"
            ? {
                ...s,
                resultSummary: {
                  stdout: "Found sk-proj-abcdefghijklmnopqrstuvwxyz1234",
                  apiKey: "sk-ant-secretvalue1234567890",
                },
              }
            : s
        ),
      };
      const leaky15: Record<string, unknown> = {
        ...fx15,
        spans: fx15.spans.map((s) =>
          s.spanId === "span-15-tool-read"
            ? { ...s, resultSummary: { content: "DB_PASSWORD=supersecretpass" } }
            : s
        ),
      };

      const r14 = await runner.replay(leaky14);
      expect(r14.checks.find((c) => c.rule === "redaction")?.passed).toBe(false);
      expect(
        r14.violations.some((v) => v.rule === "redaction" && v.spanId === "span-14-tool-read")
      ).toBe(true);

      const r15 = await runner.replay(leaky15);
      expect(r15.checks.find((c) => c.rule === "redaction")?.passed).toBe(false);
      expect(
        r15.violations.some((v) => v.rule === "redaction" && v.spanId === "span-15-tool-read")
      ).toBe(true);
    });

    it("(d) capability flags tool spans outside allowed task capabilities", async () => {
      const base = generateSyntheticTraceFixtures()[1]!;
      const runner = new TraceReplayRunner();

      const report = await runner.replay(base, {
        allowedCapabilities: ["read_file", "git_status"],
      });
      expect(report.checks.find((c) => c.rule === "capability")?.passed).toBe(false);
      expect(
        report.violations.some(
          (v) => v.rule === "capability" && v.spanId === "span-02-tool-edit"
        )
      ).toBe(true);
      expect(
        report.violations.some(
          (v) => v.rule === "capability" && v.spanId === "span-02-tool-test"
        )
      ).toBe(true);
    });

    it("(e) approval flags execution spans occurring after pending pause or before approval decision", async () => {
      const fx03 = generateSyntheticTraceFixtures().find(
        (t) => t.traceId === "trace-03-approval-pause-pending"
      )!;
      const runner = new TraceReplayRunner();

      const rogueAfterPause: RunTrace = {
        ...fx03,
        spans: [
          ...fx03.spans,
          {
            spanId: "span-03-rogue-tool",
            parentSpanId: "span-03-agent",
            kind: "tool",
            name: "run_command",
            startedAt: "2026-11-26T10:00:25.000Z",
            endedAt: "2026-11-26T10:00:26.000Z",
            latencyMs: 1000,
            tokensIn: null,
            tokensOut: null,
            costUsd: null,
            status: "OK",
            provenance: "trusted",
            argsSummary: { command: "git push --force" },
            resultSummary: { executed: true },
          },
        ],
      };

      const report = await runner.replay(rogueAfterPause);
      expect(report.checks.find((c) => c.rule === "approval")?.passed).toBe(false);
      expect(report.approvalSummary.executionAfterPauseCount).toBe(1);
      expect(
        report.violations.some(
          (v) => v.rule === "approval" && v.spanId === "span-03-rogue-tool"
        )
      ).toBe(true);
    });

    it("(f) verification flags COMPLETED trace with no verdict or unresolved FAILED verdict", async () => {
      const fx07 = generateSyntheticTraceFixtures().find(
        (t) => t.traceId === "trace-07-verification-failure-repair-exhausted"
      )!;
      const runner = new TraceReplayRunner();

      const completedAfterFail: RunTrace = {
        ...fx07,
        status: "COMPLETED",
      };
      const report = await runner.replay(completedAfterFail);
      expect(report.checks.find((c) => c.rule === "verification")?.passed).toBe(false);
      expect(
        report.violations.some(
          (v) => v.rule === "verification" && v.spanId === "span-07-verify"
        )
      ).toBe(true);
    });

    it("(g) llm_telemetry flags LLM span missing costUsd or invalid latencyMs", async () => {
      const fx02 = generateSyntheticTraceFixtures()[1]!;
      const runner = new TraceReplayRunner();

      const missingCostTrace: Record<string, unknown> = {
        ...fx02,
        spans: fx02.spans.map((s) =>
          s.spanId === "span-02-llm-1" ? { ...s, costUsd: null, latencyMs: -5 } : s
        ),
      };

      const report = await runner.replay(missingCostTrace);
      expect(report.checks.find((c) => c.rule === "llm_telemetry")?.passed).toBe(false);
      expect(
        report.violations.some(
          (v) => v.rule === "llm_telemetry" && v.spanId === "span-02-llm-1"
        )
      ).toBe(true);
    });
  });

  describe("4. Determinism guarantee", () => {
    it("replaying the same trace twice yields deep-equal reports and identical reportHash", async () => {
      const fixtures = generateSyntheticTraceFixtures();
      const runner = new TraceReplayRunner();

      for (const idx of [0, 1, 5, 7, 12, 16, 17]) {
        const trace = fixtures[idx]!;
        const reportA = await runner.replay(trace);
        const reportB = await runner.replay(trace);

        expect(reportA).toEqual(reportB);
        expect(reportA.reportHash).toBe(reportB.reportHash);
        expect(reportA.reportHash).toMatch(/^[0-9a-f]{64}$/);
      }
    });
  });
});
