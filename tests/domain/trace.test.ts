import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TRACE_FORMAT_VERSION,
  RunTrace,
  RunTraceSchema,
  containsSecretShapedString,
  createExecutionPolicy,
  createMissionContract,
  createResourceLimits,
  createVerificationSpec,
  redactTraceString,
  redactTraceValue,
  safeValidateRunTrace,
  toRedactedTraceSummary,
  validateRunTrace,
} from "../../src/domain/index.js";
import { SqliteStateStore, SqliteTraceStore } from "../../src/adapters/persistence/index.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { ClockPort } from "../../src/ports/clock.port.js";
import { Action } from "../../src/domain/action.js";
import { Attempt } from "../../src/domain/attempt.js";
import { TRACE_FIXTURE_NAMES, generateSyntheticTraceFixtures } from "../fixtures/trace-fixtures.js";

class DeterministicClock implements ClockPort {
  private currentMs: number;
  constructor(startIso: string = "2026-11-26T10:00:00.000Z") {
    this.currentMs = Date.parse(startIso);
  }
  now(): Date {
    return new Date(this.currentMs);
  }
  nowIso(): string {
    return new Date(this.currentMs).toISOString();
  }
  advanceMs(ms: number): void {
    this.currentMs += ms;
  }
}

describe("Idea 3 Phase 1 — Versioned Trace Format, Redaction, Storage, and Recording", () => {
  let tmpDir: string;
  let dbPath: string;
  let store: SqliteStateStore;
  let clock: DeterministicClock;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-trace-p1-"));
    dbPath = path.join(tmpDir, "emerald-trace.db");
    store = new SqliteStateStore({ location: dbPath });
    clock = new DeterministicClock();
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // ignore already-closed handles in persistence tests
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("1. Schema validation (valid and invalid traces)", () => {
    it("accepts a valid stub trace (model: null) and pinned Ollama trace", () => {
      const fixtures = generateSyntheticTraceFixtures();
      expect(() => validateRunTrace(fixtures[0])).not.toThrow();
      expect(() => validateRunTrace(fixtures[1])).not.toThrow();
      expect(fixtures[0]!.formatVersion).toBe(TRACE_FORMAT_VERSION);
      expect(fixtures[0]!.model).toBeNull();
      expect(fixtures[1]!.model).toEqual({
        provider: "ollama",
        model: "qwen2.5:1.5b",
        temperature: 0,
        seed: 42,
        toolList: ["edit_file", "git_diff", "git_status", "read_file", "run_command", "search_code"],
        retryBudget: 3,
      });
    });

    it("rejects wrong formatVersion", () => {
      const base = generateSyntheticTraceFixtures()[0]!;
      const bad = { ...base, formatVersion: "emerald-trace-v999" };
      const res = safeValidateRunTrace(bad);
      expect(res.success).toBe(false);
    });

    it("rejects a tool span missing provenance ('trusted' | 'untrusted')", () => {
      const base = generateSyntheticTraceFixtures()[0]!;
      const bad: RunTrace = {
        ...base,
        spans: base.spans.map((s) => (s.kind === "tool" ? { ...s, provenance: null } : s)),
      };
      const res = safeValidateRunTrace(bad);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues.some((i) => i.message.includes("provenance"))).toBe(true);
      }
    });

    it("rejects duplicate spanIds and dangling parentSpanId / parentSpanIds", () => {
      const base = generateSyntheticTraceFixtures()[0]!;
      const duplicateSpan: RunTrace = {
        ...base,
        spans: [base.spans[0]!, base.spans[0]!],
      };
      expect(safeValidateRunTrace(duplicateSpan).success).toBe(false);

      const danglingParent: RunTrace = {
        ...base,
        spans: [
          base.spans[0]!,
          { ...base.spans[1]!, parentSpanId: "non-existent-span" },
        ],
      };
      expect(safeValidateRunTrace(danglingParent).success).toBe(false);

      const danglingMultiParent: RunTrace = {
        ...base,
        spans: [
          base.spans[0]!,
          { ...base.spans[1]!, parentSpanIds: ["span-01-agent", "missing-parent"] },
        ],
      };
      expect(safeValidateRunTrace(danglingMultiParent).success).toBe(false);
    });

    it("rejects traces containing unredacted secret keys or secret-shaped strings", () => {
      const base = generateSyntheticTraceFixtures()[0]!;

      const withSensitiveKey: RunTrace = {
        ...base,
        spans: [
          {
            ...base.spans[0]!,
            resultSummary: { apiKey: "raw-unredacted-value" },
          },
        ],
      };
      expect(safeValidateRunTrace(withSensitiveKey).success).toBe(false);

      const secretPayloads = [
        "output sk-proj-abcdefghijklmnopqrstuvwxyz1234",
        "token ghp_abcdefghijklmnopqrstuvwxyz1234",
        "Authorization: Bearer abcdefghijklmnop123456",
        "AIzaSyDummyKeyValue1234567890abcd",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAK\n-----END RSA PRIVATE KEY-----",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturepart123",
      ];

      for (const secretText of secretPayloads) {
        const badToolSpan: RunTrace = {
          ...base,
          spans: [
            base.spans[0]!,
            {
              ...base.spans[1]!,
              resultSummary: { output: secretText },
            },
          ],
        };
        expect(safeValidateRunTrace(badToolSpan).success).toBe(false);
      }
    });
  });

  describe("2. Redaction guarantees", () => {
    it("redacts secret-shaped strings and sensitive object keys without retaining raw secrets", () => {
      const rawSecrets = [
        "sk-proj-TestSecretKey1234567890",
        "ghp_TestGitHubToken12345678901234",
        "AKIAIOSFODNN7EXAMPLE",
        "AIzaSyTestGoogleApiKey1234567890123",
        "Bearer my-secret-bearer-token-value",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.sig1234567890",
        "superSecretEnvPassword123",
      ];

      const input = {
        command: "cat .env",
        apiKey: rawSecrets[0],
        stdout: `keys: ${rawSecrets[0]} | ${rawSecrets[1]} | ${rawSecrets[2]} | ${rawSecrets[3]} | ${rawSecrets[4]} | ${rawSecrets[5]} | DB_PASSWORD=${rawSecrets[6]}`,
      };

      const summary = toRedactedTraceSummary(input);
      const serialized = JSON.stringify(summary);

      for (const secret of rawSecrets) {
        expect(serialized).not.toContain(secret);
      }
      expect(containsSecretShapedString(summary)).toBe(false);
      expect((summary as Record<string, unknown>).apiKey).toBe("[REDACTED]");
      expect(redactTraceString("Bearer xyz123456789")).toBe("Bearer [REDACTED]");
      expect(redactTraceValue({ nested: { secret: "abc" } })).toEqual({
        nested: { secret: "[REDACTED]" },
      });
    });
  });

  describe("3. 20 synthetic localhost fixtures", () => {
    it("generates exactly 20 distinct traces covering all required categories and all validate", () => {
      const fixtures = generateSyntheticTraceFixtures();
      expect(fixtures).toHaveLength(20);
      expect(TRACE_FIXTURE_NAMES).toHaveLength(20);

      const traceIds = new Set(fixtures.map((f) => f.traceId));
      const runIds = new Set(fixtures.map((f) => f.runId));
      expect(traceIds.size).toBe(20);
      expect(runIds.size).toBe(20);

      for (const trace of fixtures) {
        expect(() => RunTraceSchema.parse(trace)).not.toThrow();
        expect(trace.formatVersion).toBe(TRACE_FORMAT_VERSION);
        expect(containsSecretShapedString(trace)).toBe(false);
      }

      // Coverage assertions across the 20 fixtures
      expect(fixtures.some((t) => t.status === "COMPLETED" && t.model === null)).toBe(true);
      expect(fixtures.some((t) => t.status === "COMPLETED" && t.model?.model === "qwen2.5:1.5b")).toBe(true);
      expect(fixtures.some((t) => t.status === "WAITING_APPROVAL" && t.approvalEvents.length > 0)).toBe(true);
      expect(fixtures.some((t) => t.repairAttempts.length > 0 && t.verificationVerdicts.length >= 2)).toBe(true);
      expect(fixtures.some((t) => (t.parentTaskIds?.length ?? 0) >= 2 && t.spans.some((s) => (s.parentSpanIds?.length ?? 0) >= 2))).toBe(true);
      expect(fixtures.some((t) => t.traceId.includes("recovery"))).toBe(true);
      expect(fixtures.some((t) => t.tenantId !== "default-tenant")).toBe(true);
      expect(fixtures.some((t) => t.spans.some((s) => s.kind === "tool" && s.provenance === "untrusted"))).toBe(true);
      expect(fixtures.some((t) => t.traceId.includes("secret-redaction"))).toBe(true);
      expect(fixtures.some((t) => t.traceId.includes("empty-patch"))).toBe(true);
      expect(fixtures.some((t) => t.status === "TIMED_OUT")).toBe(true);
    });
  });

  describe("4. SQLite WAL round-trip storage", () => {
    it("writes and reads back all 20 traces with strict deep-equality and persists across reopen", () => {
      const fixtures = generateSyntheticTraceFixtures();
      const traceStore = store.getTraceStore();

      for (const trace of fixtures) {
        const written = traceStore.writeTrace(trace, "2026-11-26T12:00:00.000Z");
        expect(written).toEqual(trace);

        const byRun = traceStore.readTraceByRunId(trace.runId);
        expect(byRun).toEqual(trace);

        const byId = traceStore.readTraceById(trace.traceId);
        expect(byId).toEqual(trace);

        const spans = traceStore.readSpansForTrace(trace.traceId);
        expect(spans).toEqual(trace.spans);
      }

      expect(traceStore.listTraces()).toHaveLength(20);
      expect(traceStore.listTraces({ tenantId: "tenant-alpha" })).toHaveLength(2);
      expect(traceStore.listTraces({ status: "TIMED_OUT" })).toHaveLength(2);

      // Reopen the WAL SQLite file independently and verify durability
      store.close();
      const reopenedStore = new SqliteTraceStore({ location: dbPath });
      try {
        expect(reopenedStore.listTraces()).toHaveLength(20);
        for (const trace of fixtures) {
          expect(reopenedStore.readTraceByRunId(trace.runId)).toEqual(trace);
        }
      } finally {
        reopenedStore.close();
      }
    });
  });

  describe("5. Recording from real RunCoordinator / run_events lifecycle", () => {
    it("automatically captures a redacted, schema-valid trace when RunCoordinator completes a run", () => {
      const coordinator = new RunCoordinator(store, clock);

      coordinator.createTask({
        taskId: "task-rec-1",
        title: "Record trace on completion",
        inputPayload: { goal: "verify non-invasive trace recording" },
      });

      const spec = {
        taskId: "task-rec-1",
        policy: createExecutionPolicy({
          policyId: "policy-rec-1",
          tenantId: "tenant-recorded",
          allowedCapabilities: ["read_file", "run_command"],
          isolationRequirement: "IN_PROCESS" as const,
          trustedInProcessOperations: ["read_file", "run_command"],
        }),
        resourceLimits: createResourceLimits({
          timeoutMs: 30000,
          maxAttempts: 3,
          maxOutputBytes: 1048576,
        }),
        verificationSpecs: [
          createVerificationSpec({
            specId: "spec-rec-exit-0",
            ruleKind: "EXIT_CODE_ZERO",
            expectedValue: { toolName: "run_command" },
          }),
        ],
        credentialScopes: ["repo:read"],
      };

      const draft = createMissionContract(spec);
      store.insertContract(draft);
      store.activateContract(draft.spec.contractId, draft.spec.version, clock.nowIso());

      const { run } = coordinator.createRun({
        taskId: "task-rec-1",
        maxAttempts: 3,
        timeoutMs: 30000,
      });

      coordinator.queueRun(run.runId);
      coordinator.registerWorker({
        workerId: "worker-rec-1",
        hostname: "localhost",
        pid: 4242,
        status: "ACTIVE",
        lastHeartbeatAt: clock.nowIso(),
        createdAt: clock.nowIso(),
      });
      const claim = coordinator.claimRun(run.runId, "worker-rec-1", 30000);
      coordinator.startRun(run.runId, "worker-rec-1", claim.lease.leaseId);

      // Append realistic model telemetry + tool action/attempt with secret-shaped string + verification
      clock.advanceMs(500);
      store.appendEvent({
        eventId: "evt-llm-1",
        runId: run.runId,
        timestamp: clock.nowIso(),
        eventType: "model.inference.telemetry",
        schemaVersion: 1,
        producer: "agent-step-controller",
        payload: {
          runId: run.runId,
          taskId: "task-rec-1",
          stepNumber: 1,
          workerId: "worker-rec-1",
          leaseId: claim.lease.leaseId,
          requestId: "req-ollama-1",
          model: "qwen2.5:1.5b",
          provider: "ollama",
          outcome: "SUCCESS",
          startedAt: "2026-11-26T10:00:00.000Z",
          completedAt: clock.nowIso(),
          wallClockDurationMs: 500,
          promptEvalCount: 120,
          evalCount: 40,
          modelParameters: { temperature: 0, seed: 42 },
        },
      });

      const { action, event: actEvt } = Action.create({
        actionId: "act-rec-1",
        runId: run.runId,
        sequenceNumber: 1,
        toolName: "run_command",
        inputPayload: { command: "echo ok", apiKey: "sk-proj-SecretInputShouldRedact1234" },
        contractBinding: run.contractBinding!,
        maxAttempts: 3,
        now: clock.nowIso(),
      });

      const { attempt, event: attEvt } = Attempt.create({
        attemptId: "att-rec-1",
        actionId: action.snapshot.actionId,
        runId: run.runId,
        attemptNumber: 1,
        workerId: "worker-rec-1",
        leaseId: claim.lease.leaseId,
        now: clock.nowIso(),
      });

      store.transaction((tx) => {
        const fencing = { workerId: "worker-rec-1", leaseId: claim.lease.leaseId };
        tx.insertAction(action.snapshot, actEvt, fencing);
        tx.transitionAction(action.snapshot.actionId, { type: "AUTHORIZE", now: clock.nowIso() }, () => "evt-act-auth");
        tx.transitionAction(action.snapshot.actionId, { type: "START_ATTEMPT", attemptNumber: 1, now: clock.nowIso() }, () => "evt-act-start");
        tx.insertAttempt(attempt.snapshot, attEvt, fencing);
        tx.transitionAttempt(attempt.snapshot.attemptId, { type: "DISPATCH", now: clock.nowIso() }, () => "evt-att-disp");
        tx.transitionAttempt(attempt.snapshot.attemptId, { type: "START", now: clock.nowIso() }, () => "evt-att-start");
        clock.advanceMs(100);
        tx.transitionAttempt(
          attempt.snapshot.attemptId,
          {
            type: "COMPLETE",
            outputPayload: { stdout: "token ghp_SecretOutputToken1234567890abcdef" },
            exitCode: 0,
            now: clock.nowIso(),
          },
          () => "evt-att-done"
        );
        tx.transitionAction(
          action.snapshot.actionId,
          { type: "SUCCEED", resultPayload: { exitCode: 0 }, now: clock.nowIso() },
          () => "evt-act-done"
        );
      });

      store.appendEvent({
        eventId: "evt-verif-1",
        runId: run.runId,
        timestamp: clock.nowIso(),
        eventType: "verification.completed",
        schemaVersion: 1,
        producer: "sovereign-verifier",
        payload: {
          runId: run.runId,
          verifierId: "sovereign-verifier",
          specId: "spec-rec-exit-0",
          status: "VERIFIED",
          evidenceIds: ["evi-rec-1"],
          message: "Exit code 0 verified.",
          verifiedAt: clock.nowIso(),
        },
      });

      clock.advanceMs(100);
      const completed = coordinator.completeRun(run.runId, "worker-rec-1", claim.lease.leaseId, {
        ok: true,
      });
      expect(completed.run.status).toBe("COMPLETED");

      // Trace must now exist in SQLite WAL storage
      const recorded = store.getTraceStore().readTraceByRunId(run.runId);
      expect(recorded).not.toBeNull();
      expect(() => RunTraceSchema.parse(recorded)).not.toThrow();
      expect(recorded!.formatVersion).toBe(TRACE_FORMAT_VERSION);
      expect(recorded!.tenantId).toBe("tenant-recorded");
      expect(recorded!.model).toEqual({
        provider: "ollama",
        model: "qwen2.5:1.5b",
        temperature: 0,
        seed: 42,
        toolList: ["read_file", "run_command"],
        retryBudget: 3,
      });
      expect(recorded!.verificationVerdicts).toHaveLength(1);
      expect(recorded!.verificationVerdicts[0]!.verdict).toBe("VERIFIED");

      const toolSpan = recorded!.spans.find((s) => s.kind === "tool");
      expect(toolSpan).toBeDefined();
      expect(toolSpan!.provenance).toBe("trusted");

      // Secret-shaped values must never appear raw in the persisted trace
      const serialized = JSON.stringify(recorded);
      expect(serialized).not.toContain("sk-proj-SecretInputShouldRedact1234");
      expect(serialized).not.toContain("ghp_SecretOutputToken1234567890abcdef");
      expect(containsSecretShapedString(recorded)).toBe(false);
    });
  });
});
