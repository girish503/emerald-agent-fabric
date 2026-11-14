import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { EmeraldCli } from "../../src/cli/emerald-cli.js";
import {
  inspectInferenceTelemetry,
} from "../../src/application/operator-observability.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import { createMissionContract } from "../../src/domain/mission-contract.js";
import { createContractBinding } from "../../src/domain/invariants.js";
import type { ModelInferenceTelemetryPayload } from "../../src/domain/events.js";

const sha256File = (filePath: string): string =>
  createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");

describe("Milestone 2.28 Phase 5 Step 5 — Read-Only Inference Telemetry Inspection", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-telemetry-inspect-"));
    dbPath = path.join(tmpDir, "fabric.db");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function setupDatabaseWithRun(options?: { tenantId?: string }) {
    const store = new SqliteStateStore({ location: dbPath });
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const taskId = `task-${Date.now()}`;
    const nowIso = new Date().toISOString();

    const contractPolicy = createExecutionPolicy({
      isolationRequirement: "IN_PROCESS",
      allowedCapabilities: ["read_file", "write_file", "run_command"],
      ...(options?.tenantId ? { tenantId: options.tenantId, trustClassification: "MULTI_TENANT_WORKLOAD" } : {}),
    });

    const contract = createMissionContract({
      contractId: `contract-${taskId}`,
      version: 1,
      taskId,
      policy: contractPolicy,
      resourceLimits: {
        timeoutMs: 30000,
        maxAttempts: 3,
        maxOutputBytes: 65536,
      },
      verificationSpecs: [],
    });

    let contractBinding: any;

    store.transaction((tx) => {
      tx.insertTask({
        taskId,
        title: "Telemetry task",
        description: "Test task",
        inputPayload: {},
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      tx.insertContract(contract);
      const activatedContract = tx.activateContract(contract.spec.contractId, contract.spec.version);
      contractBinding = createContractBinding({
        contractId: activatedContract.spec.contractId,
        version: activatedContract.spec.version,
        contentHash: activatedContract.contentHash,
      });

      tx.insertRun(
        {
          runId,
          taskId,
          status: "QUEUED",
          attemptCount: 1,
          maxAttempts: 3,
          timeoutMs: 60000,
          idempotencyKey: `idemp-${runId}`,
          currentWorkerId: null,
          leaseId: null,
          leaseExpiresAt: null,
          resultPayload: null,
          errorPayload: null,
          contractBinding,
          maxOutputBytes: 65536,
          createdAt: nowIso,
          updatedAt: nowIso,
          version: 1,
        },
        {
          eventId: `evt-created-${runId}`,
          runId,
          timestamp: nowIso,
          eventType: "run.created",
          schemaVersion: 1,
          producer: "test",
          payload: { taskId, maxAttempts: 3, timeoutMs: 60000, idempotencyKey: null, maxOutputBytes: 65536 },
        }
      );
    });

    return { store, runId, taskId, contractBinding };
  }

  function appendTelemetryEvent(
    store: SqliteStateStore,
    runId: string,
    taskId: string,
    payloadOverrides: Partial<ModelInferenceTelemetryPayload> = {},
    eventOverrides: { schemaVersion?: number; payloadRaw?: string } = {}
  ) {
    const defaultPayload: ModelInferenceTelemetryPayload = {
      runId,
      taskId,
      stepNumber: 1,
      workerId: "worker-1",
      leaseId: "lease-1",
      requestId: `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      model: "qwen2.5-coder:1.5b",
      provider: "ollama",
      outcome: "SUCCESS",
      startedAt: new Date(Date.now() - 500).toISOString(),
      completedAt: new Date().toISOString(),
      wallClockDurationMs: 500,
      totalDurationNs: 500000000,
      loadDurationNs: 25000000,
      promptEvalDurationNs: 175000000,
      evalDurationNs: 300000000,
      promptEvalCount: 200,
      evalCount: 50,
      doneReason: "stop",
      finishReason: "STOP",
      modelParameters: { keepAlive: "15m", numCtx: 4096, temperature: 0.2 },
      ...payloadOverrides,
    };

    if (eventOverrides.payloadRaw !== undefined || eventOverrides.schemaVersion !== undefined) {
      // Direct SQL insert for malformed or unsupported version scenarios
      const db = (store as any).db;
      const seqStmt = db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM run_events WHERE run_id = ?");
      const sequence = seqStmt.get(runId).next_seq;
      db.prepare(
        "INSERT INTO run_events (event_id, run_id, sequence, timestamp, event_type, schema_version, producer, payload, dedup_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        runId,
        sequence,
        new Date().toISOString(),
        "model.inference.telemetry",
        eventOverrides.schemaVersion ?? 1,
        "application.agent_step_controller",
        eventOverrides.payloadRaw !== undefined ? eventOverrides.payloadRaw : JSON.stringify(defaultPayload),
        `inference-telemetry:${defaultPayload.requestId}`
      );
      return;
    }

    store.appendEvent(
      {
        eventId: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        runId,
        timestamp: defaultPayload.completedAt,
        eventType: "model.inference.telemetry",
        schemaVersion: 1,
        producer: "application.agent_step_controller",
        payload: defaultPayload,
      },
      `inference-telemetry:${defaultPayload.requestId}`
    );
  }

  // 1. Authorized operator can inspect telemetry for an owned run
  it("Scenario 1: Authorized operator can inspect telemetry for an owned run", async () => {
    const { store, runId, taskId } = setupDatabaseWithRun({ tenantId: "tenant-acme" });
    appendTelemetryEvent(store, runId, taskId, {
      requestId: "req-acme-1",
      wallClockDurationMs: 400,
      totalDurationNs: 400000000,
    });
    store.close();

    const cli = new EmeraldCli();
    const res = await cli.run([
      "run",
      "inference-telemetry",
      "--db",
      dbPath,
      "--run-id",
      runId,
      "--tenant-id",
      "tenant-acme",
      "--json",
    ]);

    expect(res.exitCode).toBe(0);
    const report = JSON.parse(res.output);
    expect(report.runId).toBe(runId);
    expect(report.tenantId).toBe("tenant-acme");
    expect(report.totalRecords).toBe(1);
    expect(report.records[0].payload.requestId).toBe("req-acme-1");
  });

  // 2. Cross-tenant inspection is rejected without information disclosure
  it("Scenario 2: Cross-tenant inspection is rejected without disclosing run existence", async () => {
    const { store, runId, taskId } = setupDatabaseWithRun({ tenantId: "tenant-alpha" });
    appendTelemetryEvent(store, runId, taskId);
    store.close();

    const cli = new EmeraldCli();
    const res = await cli.run([
      "run",
      "inference-telemetry",
      "--db",
      dbPath,
      "--run-id",
      runId,
      "--tenant-id",
      "tenant-beta", // Cross-tenant
    ]);

    expect(res.exitCode).toBe(1);
    // Indistinguishable from not found
    expect(res.output).toContain(`Run not found: ${runId}`);
    expect(res.output).not.toContain("tenant-alpha");
  });

  // 3. Unknown run behavior
  it("Scenario 3: Unknown run returns clean error without leaking database structure", async () => {
    const store = new SqliteStateStore({ location: dbPath });
    store.close();

    const cli = new EmeraldCli();
    const res = await cli.run([
      "run",
      "inference-telemetry",
      "--db",
      dbPath,
      "--run-id",
      "run-does-not-exist",
    ]);

    expect(res.exitCode).toBe(1);
    expect(res.output).toContain("Run not found: run-does-not-exist");
  });

  // 4. Run with no telemetry
  it("Scenario 4: Run with no telemetry returns empty result gracefully without error", async () => {
    const { store, runId } = setupDatabaseWithRun();
    store.close();

    const cli = new EmeraldCli();
    const res = await cli.run([
      "run",
      "inference-telemetry",
      "--db",
      dbPath,
      "--run-id",
      runId,
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.output).toContain(`Inference Telemetry: ${runId}`);
    expect(res.output).toContain("(No inference telemetry recorded for run:");

    // JSON format
    const jsonRes = await cli.run([
      "run",
      "inference-telemetry",
      "--db",
      dbPath,
      "--run-id",
      runId,
      "--json",
    ]);
    expect(jsonRes.exitCode).toBe(0);
    const parsed = JSON.parse(jsonRes.output);
    expect(parsed.totalRecords).toBe(0);
    expect(parsed.records).toEqual([]);
    expect(parsed.performanceSummary).toBeNull();
  });

  // 5. Multiple telemetry records in deterministic order
  it("Scenario 5: Multiple telemetry records returned in deterministic sequence order", async () => {
    const { store, runId, taskId } = setupDatabaseWithRun();
    appendTelemetryEvent(store, runId, taskId, { requestId: "req-step-1", stepNumber: 1 });
    appendTelemetryEvent(store, runId, taskId, { requestId: "req-step-2", stepNumber: 2 });
    appendTelemetryEvent(store, runId, taskId, { requestId: "req-step-3", stepNumber: 3 });
    store.close();

    const report = inspectInferenceTelemetry({ dbPath, runId });
    expect(report.totalRecords).toBe(3);
    expect(report.records.length).toBe(3);
    expect(report.records[0]!.sequence).toBeLessThan(report.records[1]!.sequence);
    expect(report.records[1]!.sequence).toBeLessThan(report.records[2]!.sequence);
    expect(report.records[0]!.payload?.requestId).toBe("req-step-1");
    expect(report.records[1]!.payload?.requestId).toBe("req-step-2");
    expect(report.records[2]!.payload?.requestId).toBe("req-step-3");
  });

  // 6. Bounded result behavior (--limit)
  it("Scenario 6: Bounded result behavior enforces --limit correctly", async () => {
    const { store, runId, taskId } = setupDatabaseWithRun();
    for (let i = 1; i <= 5; i++) {
      appendTelemetryEvent(store, runId, taskId, { requestId: `req-bound-${i}`, stepNumber: i });
    }
    store.close();

    const cli = new EmeraldCli();
    const res = await cli.run([
      "run",
      "inference-telemetry",
      "--db",
      dbPath,
      "--run-id",
      runId,
      "--limit",
      "2",
      "--json",
    ]);

    expect(res.exitCode).toBe(0);
    const report = JSON.parse(res.output);
    expect(report.totalRecords).toBe(5);
    expect(report.returnedRecords).toBe(2);
    expect(report.records.length).toBe(2);
    expect(report.limit).toBe(2);
  });

  // 7. Missing timing values remain distinguishable from zero
  it("Scenario 7: Missing timing values remain null/N/A and distinct from zero", async () => {
    const { store, runId, taskId } = setupDatabaseWithRun();
    // Record with missing timing fields (e.g. timeout or provider omission)
    appendTelemetryEvent(store, runId, taskId, {
      requestId: "req-missing-1",
      outcome: "TIMEOUT",
      loadDurationNs: null,
      evalDurationNs: null,
      totalDurationNs: null,
    });
    // Record with zero duration
    appendTelemetryEvent(store, runId, taskId, {
      requestId: "req-zero-1",
      outcome: "SUCCESS",
      loadDurationNs: 0,
      evalDurationNs: 0,
      totalDurationNs: 0,
    });
    store.close();

    const cli = new EmeraldCli();
    const res = await cli.run([
      "run",
      "inference-telemetry",
      "--db",
      dbPath,
      "--run-id",
      runId,
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.output).toContain("Load=N/A");
    expect(res.output).toContain("Load=0 ns (0.00 ms)");
  });

  // 8. Nanosecond precision is preserved
  it("Scenario 8: Nanosecond precision is preserved in output without truncation", async () => {
    const { store, runId, taskId } = setupDatabaseWithRun();
    const exactNs = 1234567891;
    appendTelemetryEvent(store, runId, taskId, {
      requestId: "req-precision-1",
      totalDurationNs: exactNs,
      loadDurationNs: 12345678,
    });
    store.close();

    const cli = new EmeraldCli();
    const jsonRes = await cli.run([
      "run",
      "inference-telemetry",
      "--db",
      dbPath,
      "--run-id",
      runId,
      "--json",
    ]);

    const report = JSON.parse(jsonRes.output);
    expect(report.records[0].payload.totalDurationNs).toBe(exactNs);
    expect(report.records[0].payload.loadDurationNs).toBe(12345678);

    const textRes = await cli.run([
      "run",
      "inference-telemetry",
      "--db",
      dbPath,
      "--run-id",
      runId,
    ]);
    expect(textRes.output).toContain("1,234,567,891 ns (1234.57 ms)");
  });

  // 9. Malformed telemetry handling
  it("Scenario 9: Malformed JSON telemetry record is reported safely without throwing", async () => {
    const { store, runId, taskId } = setupDatabaseWithRun();
    appendTelemetryEvent(
      store,
      runId,
      taskId,
      {},
      { payloadRaw: "CORRUPTED{NOT_VALID_JSON" }
    );
    store.close();

    const report = inspectInferenceTelemetry({ dbPath, runId });
    expect(report.totalRecords).toBe(1);
    expect(report.records.length).toBe(1);
    expect(report.records[0]!.isValidPayload).toBe(false);
    expect(report.records[0]!.error).toContain("Malformed payload JSON");

    const cli = new EmeraldCli();
    const res = await cli.run([
      "run",
      "inference-telemetry",
      "--db",
      dbPath,
      "--run-id",
      runId,
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.output).toContain("[MALFORMED PAYLOAD:");
  });

  // 10. Unsupported schema-version handling
  it("Scenario 10: Unsupported schema version is reported clearly and safely", async () => {
    const { store, runId, taskId } = setupDatabaseWithRun();
    appendTelemetryEvent(store, runId, taskId, {}, { schemaVersion: 99 });
    store.close();

    const report = inspectInferenceTelemetry({ dbPath, runId });
    expect(report.totalRecords).toBe(1);
    expect(report.records[0]!.isSupportedSchema).toBe(false);
    expect(report.records[0]!.schemaVersion).toBe(99);

    const cli = new EmeraldCli();
    const res = await cli.run([
      "run",
      "inference-telemetry",
      "--db",
      dbPath,
      "--run-id",
      runId,
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.output).toContain("[UNSUPPORTED SCHEMA VERSION: 99]");
  });

  // 11. Read-only database behavior
  it("Scenario 11: Database handle strictly enforces query_only = ON preventing writes", async () => {
    const { store } = setupDatabaseWithRun();
    store.close();

    // Verify openReadOnlyDatabase rejects writes
    const { openReadOnlyDatabase } = await import("../../src/application/operator-observability.js");
    const handle = openReadOnlyDatabase(dbPath);
    try {
      expect(() => {
        handle.db.exec("INSERT INTO run_events (event_id, run_id, sequence, timestamp, event_type, schema_version, producer, payload) VALUES ('e', 'r', 1, 't', 't', 1, 'p', '{}')");
      }).toThrow(/not authorized|readonly|attempt to write a readonly database/i);
    } finally {
      handle.close();
    }
  });

  // 12. No prompt, output, secret, or host-path disclosure
  it("Scenario 12: Zero disclosure of prompts, generated outputs, secrets, or host paths", async () => {
    const { store, runId, taskId } = setupDatabaseWithRun();
    appendTelemetryEvent(store, runId, taskId, {
      requestId: "req-safe-1",
      modelParameters: { keepAlive: "10m", numCtx: 2048 },
    });
    store.close();

    const cli = new EmeraldCli();
    const res = await cli.run([
      "run",
      "inference-telemetry",
      "--db",
      dbPath,
      "--run-id",
      runId,
      "--json",
    ]);

    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.output);
    expect(parsed.records[0].payload.prompt).toBeUndefined();
    expect(parsed.records[0].payload.systemInstruction).toBeUndefined();
    expect(parsed.records[0].payload.outputText).toBeUndefined();
    const jsonStr = res.output;
    expect(jsonStr).not.toContain("systemInstruction");
    expect(jsonStr).not.toContain("outputText");
    expect(jsonStr).not.toContain("Bearer");
    expect(jsonStr).not.toContain("password");
    expect(jsonStr).not.toContain(process.cwd());
  });

  // 13. Existing operator CLI authentication/dispatching remains enforced
  it("Scenario 13: CLI dispatching enforces required flags and handles positional runId", async () => {
    const { store, runId, taskId } = setupDatabaseWithRun();
    appendTelemetryEvent(store, runId, taskId);
    store.close();

    const cli = new EmeraldCli();

    // Missing --db
    const missingDb = await cli.run(["run", "inference-telemetry", "--run-id", runId]);
    expect(missingDb.exitCode).toBe(1);
    expect(missingDb.output).toContain("Error: --db and runId are required");

    // Positional runId: emerald run inference-telemetry <runId> --db <file>
    const positional = await cli.run(["run", "inference-telemetry", runId, "--db", dbPath]);
    expect(positional.exitCode).toBe(0);
    expect(positional.output).toContain(`Inference Telemetry: ${runId}`);

    // Invalid limit
    const badLimit = await cli.run(["run", "inference-telemetry", "--db", dbPath, "--run-id", runId, "--limit", "-5"]);
    expect(badLimit.exitCode).toBe(1);
    expect(badLimit.output).toContain("Error: --limit must be a positive integer");
  });

  // 14. Inspection cannot mutate run, task, attempt, lease, or verification state
  it("Scenario 14: Inspection is strictly side-effect free and preserves exact database bytes", async () => {
    const { store, runId, taskId } = setupDatabaseWithRun();
    appendTelemetryEvent(store, runId, taskId);
    store.close();

    const hashBefore = sha256File(dbPath);

    const cli = new EmeraldCli();
    const res = await cli.run([
      "run",
      "inference-telemetry",
      "--db",
      dbPath,
      "--run-id",
      runId,
    ]);
    expect(res.exitCode).toBe(0);

    const hashAfter = sha256File(dbPath);
    expect(hashAfter).toBe(hashBefore);
  });

  // 15. Existing Phase 5 Step 4 telemetry tests remain passing
  it("Scenario 15: Confirms Phase 5 Step 4 telemetry contract remains fully compatible", () => {
    const { store, runId, taskId } = setupDatabaseWithRun();
    appendTelemetryEvent(store, runId, taskId, {
      requestId: "req-step4-compat",
      totalDurationNs: 888000000,
      loadDurationNs: 12000000,
      promptEvalDurationNs: 350000000,
      evalDurationNs: 526000000,
      promptEvalCount: 300,
      evalCount: 75,
    });

    const telemetryEvents = store.getInferenceTelemetryForRun(runId);
    expect(telemetryEvents.length).toBe(1);
    expect(telemetryEvents[0]!.payload.totalDurationNs).toBe(888000000);
    expect(telemetryEvents[0]!.payload.evalCount).toBe(75);
    store.close();
  });
});
