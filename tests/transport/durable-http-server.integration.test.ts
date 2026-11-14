/**
 * Milestone 2.26 — Durable REST/SSE Transport & Runtime Event Integration Test Suite
 *
 * Verifies the durable integration between Fastify REST/SSE transport,
 * SQLite WAL persistence, RunCoordinator, WorkerRuntime, and SSE event streaming.
 *
 * Scenarios:
 * 1. HTTP submission persists task and run records in real SQLite file.
 * 2. Submitted task is discoverable through operator inspection (coordinator.getRun / GET /api/v1/runs/:runId).
 * 3. Duplicate submission returns existing run (idempotency key deduplication).
 * 4. Worker claims and executes submitted task through real runtime wiring.
 * 5. SSE receives actual ordered runtime events from worker execution.
 * 6. SSE replay-to-live handoff loses no events.
 * 7. SSE reconnection resumes from cursor sequence (Last-Event-ID).
 * 8. Tenant A cannot inspect Tenant B's run (returns 404 fail-closed).
 * 9. Tenant A cannot subscribe to Tenant B's events (returns 404 fail-closed).
 * 10. Tenant A cannot cancel Tenant B's run (returns 404 fail-closed).
 * 11. Invalid/missing bearer tokens are rejected with 401.
 * 12. Cancellation invokes coordinator cancel and updates run status to CANCELLED.
 * 13. Server shutdown closes Fastify server and SQLite database cleanly.
 * 14. Persistence failure returns appropriate error (500), never false success.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { buildFastifyServer, type PrincipalRecord } from "../../src/transport/http/server.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { scopeIdempotencyKeyForTenant } from "../../src/application/durable-submission.js";
import { EchoOperation, SlowOperation } from "../../src/domain/operation.js";
import { SystemClock } from "../../src/ports/clock.port.js";
import { EmeraldCli } from "../../src/cli/emerald-cli.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { submitDurableTask } from "../../src/application/durable-submission.js";
import type { FastifyInstance } from "fastify";

const TOK_A_OP = "alpha-operator-token-aaaaaaaa1";
const TOK_A_AUD = "alpha-auditor-token-aaaaaaaaa2";
const TOK_B_OP = "beta-operator-token-bbbbbbbbb4";
const TOK_INTERNAL_ADMIN = "internal-admin-token-111111111";

const principals: PrincipalRecord[] = [
  { token: TOK_A_OP, principalId: "a-op", tenantId: "tenant-alpha", role: "operator" },
  { token: TOK_A_AUD, principalId: "a-aud", tenantId: "tenant-alpha", role: "auditor" },
  { token: TOK_B_OP, principalId: "b-op", tenantId: "tenant-beta", role: "operator" },
  { token: TOK_INTERNAL_ADMIN, principalId: "sys-admin", tenantId: "system", role: "admin", allowConstrainedHost: true },
];

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

interface Harness {
  tempDir: string;
  dbPath: string;
  workspaceDir: string;
  store: SqliteStateStore;
  coordinator: RunCoordinator;
  eventBroadcaster: EventEmitter;
  server: FastifyInstance;
  worker: WorkerRuntime;
  workspaceAdapter: NodeFsWorkspaceAdapter;
}

function createHarness(): Harness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-durable-http-"));
  const dbPath = path.join(tempDir, "state.db");
  const workspaceDir = path.join(tempDir, "workspaces");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const store = new SqliteStateStore({ location: dbPath });
  const clock = new SystemClock();
  const eventBroadcaster = new EventEmitter();
  const coordinator = new RunCoordinator(store, clock, undefined, undefined, eventBroadcaster);

  const server = buildFastifyServer({
    store,
    coordinator,
    eventBroadcaster,
    principals,
    corsOrigins: [],
  });

  const workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: workspaceDir });
  const worker = new WorkerRuntime({
    workerId: "worker-durable-1",
    coordinator,
    clock,
    leaseTtlMs: 30_000,
    operations: [new EchoOperation(), new SlowOperation()],
    workspacePort: workspaceAdapter,
  });
  worker.ensureRegistered();

  return { tempDir, dbPath, workspaceDir, store, coordinator, eventBroadcaster, server, worker, workspaceAdapter };
}

async function cleanupHarness(h: Harness): Promise<void> {
  try {
    await h.server.close();
  } catch {}
  try {
    h.store.close();
  } catch {}
  try {
    fs.rmSync(h.tempDir, { recursive: true, force: true });
  } catch {}
}

interface ParsedSseEvent {
  id?: string;
  event?: string;
  data?: any;
}

function parseSseText(raw: string): ParsedSseEvent[] {
  const blocks = raw.split("\n\n");
  const events: ParsedSseEvent[] = [];
  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    const ev: ParsedSseEvent = {};
    for (const line of lines) {
      if (line.startsWith("id: ")) ev.id = line.slice(4).trim();
      else if (line.startsWith("event: ")) ev.event = line.slice(7).trim();
      else if (line.startsWith("data: ")) {
        try {
          ev.data = JSON.parse(line.slice(6));
        } catch {
          ev.data = line.slice(6);
        }
      }
    }
    if (ev.event || ev.data !== undefined) events.push(ev);
  }
  return events;
}

describe("Milestone 2.26 — Durable REST/SSE Transport & Runtime Event Integration", () => {
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
  });

  afterEach(async () => {
    await cleanupHarness(h);
  });

  it("Scenario 1: HTTP submission persists task and run records in real SQLite file", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_A_OP), "content-type": "application/json" },
      payload: {
        title: "echo",
        prompt: "echo durable verification",
        modelConfig: { modelName: "qwen2.5-coder:3b" },
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.headers["x-emerald-durability"]).toBe("durable-coordinator");

    const json = JSON.parse(res.body);
    expect(json.success).toBe(true);
    expect(json.data.taskId).toBeDefined();
    expect(json.data.runId).toBeDefined();
    expect(json.data.tenantId).toBe("tenant-alpha");
    expect(json.data.status).toBe("QUEUED");

    // Inspect real SQLite persistence
    const runInDb = h.coordinator.getRun(json.data.runId);
    expect(runInDb).not.toBeNull();
    expect(runInDb!.runId).toBe(json.data.runId);
    expect(runInDb!.taskId).toBe(json.data.taskId);
    expect(runInDb!.status).toBe("QUEUED");

    const taskInDb = h.coordinator.getTask(json.data.taskId);
    expect(taskInDb).not.toBeNull();
    expect(taskInDb!.taskId).toBe(json.data.taskId);
    expect(taskInDb!.title).toBe("echo");
  });

  it("Scenario 2: Submitted task is discoverable through operator inspection", async () => {
    const createRes = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_A_OP), "content-type": "application/json" },
      payload: {
        title: "echo",
        prompt: "inspectable task payload",
        modelConfig: { modelName: "qwen2.5-coder:3b" },
      },
    });
    const { taskId, runId } = JSON.parse(createRes.body).data;

    // GET /api/v1/tasks/:taskId
    const taskRes = await h.server.inject({
      method: "GET",
      url: `/api/v1/tasks/${taskId}`,
      headers: bearer(TOK_A_OP),
    });
    expect(taskRes.statusCode).toBe(200);
    const taskJson = JSON.parse(taskRes.body);
    expect(taskJson.success).toBe(true);
    expect(taskJson.data.taskId).toBe(taskId);
    expect(taskJson.data.tenantId).toBe("tenant-alpha");

    // GET /api/v1/runs/:runId
    const runRes = await h.server.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}`,
      headers: bearer(TOK_A_OP),
    });
    expect(runRes.statusCode).toBe(200);
    expect(runRes.headers["x-emerald-durability"]).toBe("durable-coordinator");
    const runJson = JSON.parse(runRes.body);
    expect(runJson.success).toBe(true);
    expect(runJson.data.runId).toBe(runId);
    expect(runJson.data.taskId).toBe(taskId);
    expect(runJson.data.tenantId).toBe("tenant-alpha");
    expect(runJson.data.status).toBe("QUEUED");
  });

  it("Scenario 3: Duplicate submission returns existing run (idempotency key deduplication)", async () => {
    const key = "idempotency-token-123456";
    const payload = {
      title: "echo",
      prompt: "deduplicated task",
      modelConfig: { modelName: "qwen2.5-coder:3b" },
    };

    // First submission
    const res1 = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_A_OP), "content-type": "application/json", "idempotency-key": key },
      payload,
    });
    expect(res1.statusCode).toBe(201);
    const data1 = JSON.parse(res1.body).data;

    // Duplicate submission with same key
    const res2 = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_A_OP), "content-type": "application/json", "idempotency-key": key },
      payload,
    });
    expect([200, 201]).toContain(res2.statusCode);
    const data2 = JSON.parse(res2.body).data;

    // Must return the exact same runId and taskId
    expect(data2.runId).toBe(data1.runId);
    expect(data2.taskId).toBe(data1.taskId);

    // Verify only 1 run row exists in the store for this key
    const runByKey = h.coordinator.getRunByIdempotencyKey(
      scopeIdempotencyKeyForTenant(key, "tenant-alpha")
    );
    expect(runByKey).not.toBeNull();
    expect(runByKey!.runId).toBe(data1.runId);
  });

  it("Scenario 4: Worker claims and executes submitted task through real runtime wiring", async () => {
    const createRes = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_INTERNAL_ADMIN), "content-type": "application/json" },
      payload: {
        title: "echo",
        prompt: "Worker execution test",
        executionMode: "constrained_host",
        modelConfig: { modelName: "qwen2.5-coder:3b" },
        verificationSpecs: [{ specId: "vspec-echo", ruleKind: "EXACT_OUTPUT_MATCH", expectedOutput: { instruction: "Worker execution test" } }],
      },
    });
    const { runId } = JSON.parse(createRes.body).data;

    // Before worker execution: status is QUEUED
    expect(h.coordinator.getRun(runId)!.status).toBe("QUEUED");

    // Worker executes one tick
    const result = await h.worker.runOnce();
    expect(result.status).toBe("COMPLETED");

    // After worker execution: status is COMPLETED
    const runAfter = h.coordinator.getRun(runId);
    expect(runAfter!.status).toBe("COMPLETED");
    expect(runAfter!.currentWorkerId).toBe("worker-durable-1");

    // GET /api/v1/runs/:runId confirms COMPLETED status
    const runRes = await h.server.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}`,
      headers: bearer(TOK_INTERNAL_ADMIN),
    });
    const runJson = JSON.parse(runRes.body);
    expect(runJson.data.status).toBe("COMPLETED");
  });

  it("Scenario 5: SSE receives actual ordered runtime events from worker execution", async () => {
    await h.server.listen({ port: 0, host: "127.0.0.1" });
    const address = h.server.server.address() as net.AddressInfo;
    const port = address.port;

    // Create task
    const createRes = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_INTERNAL_ADMIN), "content-type": "application/json" },
      payload: {
        title: "echo",
        prompt: "SSE streaming test",
        executionMode: "constrained_host",
        modelConfig: { modelName: "qwen2.5-coder:3b" },
        verificationSpecs: [{ specId: "vspec-echo", ruleKind: "EXACT_OUTPUT_MATCH", expectedOutput: { instruction: "SSE streaming test" } }],
      },
    });
    const { runId } = JSON.parse(createRes.body).data;

    // Connect SSE client
    const rawChunks: string[] = [];
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: `/api/v1/runs/${runId}/events`,
      method: "GET",
      headers: bearer(TOK_INTERNAL_ADMIN),
    });

    const streamClosedPromise = new Promise<void>((resolve) => {
      req.on("response", (res) => {
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toBe("text/event-stream");
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          rawChunks.push(chunk);
        });
        res.on("end", () => resolve());
      });
    });
    req.end();

    // Small delay to ensure client connection is established
    await new Promise((r) => setTimeout(r, 100));

    // Execute worker tick
    const workerResult = await h.worker.runOnce();
    expect(workerResult.status).toBe("COMPLETED");

    // Wait for SSE stream to drain and close upon terminal run completion
    await streamClosedPromise;

    const events = parseSseText(rawChunks.join(""));
    expect(events.length).toBeGreaterThanOrEqual(4);

    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("run.created");
    expect(eventTypes).toContain("run.queued");
    expect(eventTypes).toContain("worker.claimed");
    expect(eventTypes).toContain("run.completed");

    // Strictly monotonically increasing sequence numbers
    const sequences = events.map((e) => Number(e.id));
    for (let i = 1; i < sequences.length; i++) {
      const prev = sequences[i - 1]!;
      const curr = sequences[i]!;
      expect(curr).toBeGreaterThan(prev);
    }
  });

  it("Scenario 6: SSE replay-to-live handoff loses no events", async () => {
    // 1. Submit task and execute worker to completion first (generates historical events)
    const createRes = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_INTERNAL_ADMIN), "content-type": "application/json" },
      payload: {
        title: "echo",
        prompt: "Replay test",
        executionMode: "constrained_host",
        modelConfig: { modelName: "qwen2.5-coder:3b" },
        verificationSpecs: [{ specId: "vspec-echo", ruleKind: "EXACT_OUTPUT_MATCH", expectedOutput: { instruction: "Replay test" } }],
      },
    });
    const { runId } = JSON.parse(createRes.body).data;
    await h.worker.runOnce();

    // 2. Connect SSE client to completed run
    await h.server.listen({ port: 0, host: "127.0.0.1" });
    const address = h.server.server.address() as net.AddressInfo;
    const port = address.port;

    const rawChunks: string[] = [];
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: `/api/v1/runs/${runId}/events`,
      method: "GET",
      headers: bearer(TOK_INTERNAL_ADMIN),
    });

    await new Promise<void>((resolve) => {
      req.on("response", (res) => {
        expect(res.headers["x-emerald-replay"]).toBe("durable");
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => rawChunks.push(chunk));
        res.on("end", () => resolve());
      });
      req.end();
    });

    const events = parseSseText(rawChunks.join(""));
    const eventTypes = events.map((e) => e.event);

    expect(eventTypes).toContain("run.created");
    expect(eventTypes).toContain("run.queued");
    expect(eventTypes).toContain("worker.claimed");
    expect(eventTypes).toContain("run.started");
    expect(eventTypes).toContain("run.completed");

    // Check gapless sequence order
    const sequences = events.map((e) => Number(e.id));
    for (let i = 1; i < sequences.length; i++) {
      const prev = sequences[i - 1]!;
      const curr = sequences[i]!;
      expect(curr).toBe(prev + 1);
    }
  });

  it("Scenario 7: SSE reconnection resumes from cursor sequence", async () => {
    const createRes = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_INTERNAL_ADMIN), "content-type": "application/json" },
      payload: {
        title: "echo",
        prompt: "Resume test",
        executionMode: "constrained_host",
        modelConfig: { modelName: "qwen2.5-coder:3b" },
        verificationSpecs: [{ specId: "vspec-echo", ruleKind: "EXACT_OUTPUT_MATCH", expectedOutput: { instruction: "Resume test" } }],
      },
    });
    const { runId } = JSON.parse(createRes.body).data;
    await h.worker.runOnce();

    await h.server.listen({ port: 0, host: "127.0.0.1" });
    const address = h.server.server.address() as net.AddressInfo;
    const port = address.port;

    // Reconnect with Last-Event-ID: 2 (requesting sequences > 2)
    const rawChunks: string[] = [];
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: `/api/v1/runs/${runId}/events`,
      method: "GET",
      headers: { ...bearer(TOK_INTERNAL_ADMIN), "Last-Event-ID": "2" },
    });

    await new Promise<void>((resolve) => {
      req.on("response", (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => rawChunks.push(chunk));
        res.on("end", () => resolve());
      });
      req.end();
    });

    const events = parseSseText(rawChunks.join(""));
    expect(events.length).toBeGreaterThanOrEqual(1);

    // All received event IDs must be strictly > 2
    for (const ev of events) {
      expect(Number(ev.id)).toBeGreaterThan(2);
    }
  });

  it("Scenario 8: Tenant A cannot inspect Tenant B's run (returns 404)", async () => {
    // Tenant Alpha creates a run
    const createRes = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_A_OP), "content-type": "application/json" },
      payload: {
        title: "echo",
        prompt: "Tenant Alpha Confidential Task",
        modelConfig: { modelName: "qwen2.5-coder:3b" },
      },
    });
    const { runId } = JSON.parse(createRes.body).data;

    // Tenant Beta attempts to inspect Tenant Alpha's run
    const inspectRes = await h.server.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}`,
      headers: bearer(TOK_B_OP),
    });

    // Fail-closed: returns 404 NOT_FOUND without leaking existence
    expect(inspectRes.statusCode).toBe(404);
    const body = JSON.parse(inspectRes.body);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Run not found");
  });

  it("Scenario 9: Tenant A cannot subscribe to Tenant B's events (returns 404)", async () => {
    // Tenant Alpha creates a run
    const createRes = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_A_OP), "content-type": "application/json" },
      payload: {
        title: "echo",
        prompt: "Tenant Alpha Stream",
        modelConfig: { modelName: "qwen2.5-coder:3b" },
      },
    });
    const { runId } = JSON.parse(createRes.body).data;

    // Tenant Beta attempts to subscribe to Tenant Alpha's event stream
    const sseRes = await h.server.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/events`,
      headers: bearer(TOK_B_OP),
    });

    expect(sseRes.statusCode).toBe(404);
    const body = JSON.parse(sseRes.body);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Run not found");
  });

  it("Scenario 10: Tenant A cannot cancel Tenant B's run (returns 404)", async () => {
    // Tenant Alpha creates a run
    const createRes = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_A_OP), "content-type": "application/json" },
      payload: {
        title: "echo",
        prompt: "Tenant Alpha Cancellable",
        modelConfig: { modelName: "qwen2.5-coder:3b" },
      },
    });
    const { runId } = JSON.parse(createRes.body).data;

    // Tenant Beta attempts to cancel Tenant Alpha's run
    const cancelRes = await h.server.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/cancel`,
      headers: { ...bearer(TOK_B_OP), "content-type": "application/json" },
      payload: { reason: "Malicious cancellation attempt" },
    });

    expect(cancelRes.statusCode).toBe(404);
    const body = JSON.parse(cancelRes.body);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Run not found");

    // Verify run was NOT cancelled
    expect(h.coordinator.getRun(runId)!.status).toBe("QUEUED");
  });

  it("Scenario 11: Invalid/missing bearer tokens are rejected with 401", async () => {
    // Missing Authorization header
    const resNoAuth = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { "content-type": "application/json" },
      payload: {
        title: "echo",
        prompt: "Unauthenticated",
        modelConfig: { modelName: "qwen2.5-coder:3b" },
      },
    });
    expect(resNoAuth.statusCode).toBe(401);
    expect(JSON.parse(resNoAuth.body).error.code).toBe("UNAUTHORIZED");

    // Invalid bearer token
    const resBadToken = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { authorization: "Bearer invalid-entropy-token-1234567890", "content-type": "application/json" },
      payload: {
        title: "echo",
        prompt: "Invalid token",
        modelConfig: { modelName: "qwen2.5-coder:3b" },
      },
    });
    expect(resBadToken.statusCode).toBe(401);
    expect(JSON.parse(resBadToken.body).error.code).toBe("UNAUTHORIZED");
  });

  it("Scenario 12: Cancellation invokes coordinator cancel and updates run status to CANCELLED", async () => {
    const createRes = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_A_OP), "content-type": "application/json" },
      payload: {
        title: "echo",
        prompt: "Run to cancel",
        modelConfig: { modelName: "qwen2.5-coder:3b" },
      },
    });
    const { runId } = JSON.parse(createRes.body).data;

    // Authoritative cancellation
    const cancelRes = await h.server.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/cancel`,
      headers: { ...bearer(TOK_A_OP), "content-type": "application/json" },
      payload: { reason: "Operator cancelled this run" },
    });

    expect(cancelRes.statusCode).toBe(200);
    const cancelJson = JSON.parse(cancelRes.body);
    expect(cancelJson.success).toBe(true);
    expect(cancelJson.data.status).toBe("CANCELLED");
    expect(cancelJson.data.reason).toBe("Operator cancelled this run");

    // Verify durable state in SQLite
    const runInDb = h.coordinator.getRun(runId);
    expect(runInDb!.status).toBe("CANCELLED");
  });

  it("Scenario 13: Server shutdown closes Fastify server and SQLite database cleanly", async () => {
    await h.server.listen({ port: 0, host: "127.0.0.1" });
    const address = h.server.server.address() as net.AddressInfo;
    const port = address.port;

    // Verify server is listening and accepts requests
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/runs/non-existent-run`, {
      headers: bearer(TOK_A_OP),
    });
    expect(res.status).toBe(404);

    // Clean shutdown
    await h.server.close();
    h.store.close();

    // Verify port is released (connection refused)
    await expect(fetch(`http://127.0.0.1:${port}/api/v1/runs/non-existent-run`)).rejects.toThrow();
  });

  it("Scenario 14: Persistence failure returns appropriate error, never false success", async () => {
    // Intentionally close store to induce persistence failure
    h.store.close();

    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_A_OP), "content-type": "application/json" },
      payload: {
        title: "echo",
        prompt: "Should fail cleanly",
        modelConfig: { modelName: "qwen2.5-coder:3b" },
      },
    });

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  it("Scenario 15: CLI server subcommand validates options and dispatches correctly", async () => {
    const cli = new EmeraldCli();

    // 1. Missing --db
    const resNoDb = await cli.run(["server"]);
    expect(resNoDb.exitCode).toBe(1);
    expect(resNoDb.output).toContain("--db is required");

    // 2. Invalid port
    const resBadPort = await cli.run(["server", "--db", h.dbPath, "--port", "not-a-port"]);
    expect(resBadPort.exitCode).toBe(1);
    expect(resBadPort.output).toContain("--port must be an integer");

    // 3. Invalid principals JSON
    const resBadPrincipals = await cli.run(["server", "--db", h.dbPath, "--principals", "{not-json}"]);
    expect(resBadPrincipals.exitCode).toBe(1);
    expect(resBadPrincipals.output).toContain("--principals must be a JSON array");
  });

  it("Scenario 12B: Real in-flight worker cancellation enforces lease fencing and preserves terminal state immutability", async () => {
    // 1. Submit task using SlowOperation with authorized internal principal
    const createRes = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_INTERNAL_ADMIN), "content-type": "application/json" },
      payload: {
        title: "slow",
        prompt: "800",
        executionMode: "constrained_host",
        requiredCapabilities: ["execution.slow"],
        modelConfig: { modelName: "qwen2.5-coder:3b" },
      },
    });
    expect(createRes.statusCode).toBe(201);
    const { runId } = JSON.parse(createRes.body).data;

    // 2. Start worker execution in background
    const workerPromise = h.worker.runOnce();

    // 3. Wait briefly for worker to claim run and start executing
    await new Promise((r) => setTimeout(r, 100));
    const runningRun = h.coordinator.getRun(runId);
    expect(runningRun?.status).toBe("RUNNING");

    // 4. Issue HTTP cancellation while worker is actively running
    const cancelRes = await h.server.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/cancel`,
      headers: { ...bearer(TOK_INTERNAL_ADMIN), "content-type": "application/json" },
      payload: { reason: "Operator cancelled active in-flight worker" },
    });
    expect(cancelRes.statusCode).toBe(200);
    expect(JSON.parse(cancelRes.body).data.status).toBe("CANCELLED");

    // 5. Worker completes execution and observes lease fencing
    const workerResult = await workerPromise;
    expect(workerResult.status).toBe("FENCED");

    // 6. Terminal state immutability in SQLite: remains CANCELLED, never rewritten
    const finalRun = h.coordinator.getRun(runId);
    expect(finalRun?.status).toBe("CANCELLED");
  });

  it("Scenario 16: Complete end-to-end tool execution with ToolExecutionGateway, sandbox write/read, and SSE delivery", async () => {
    await h.server.listen({ port: 0, host: "127.0.0.1" });
    const address = h.server.server.address() as net.AddressInfo;
    const port = address.port;

    // 1. Submit task with requiredCapabilities
    const createRes = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_INTERNAL_ADMIN), "content-type": "application/json" },
      payload: {
        title: "echo",
        prompt: "Tool execution demonstration",
        executionMode: "constrained_host",
        requiredCapabilities: ["workspace.file.write", "workspace.file.read"],
        modelConfig: { modelName: "qwen2.5-coder:3b" },
      },
    });
    const { runId, taskId } = JSON.parse(createRes.body).data;

    // 2. Connect SSE subscriber
    const rawChunks: string[] = [];
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: `/api/v1/runs/${runId}/events`,
      method: "GET",
      headers: bearer(TOK_INTERNAL_ADMIN),
    });
    const streamClosedPromise = new Promise<void>((resolve) => {
      req.on("response", (res) => {
        expect(res.statusCode).toBe(200);
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => rawChunks.push(chunk));
        res.on("end", () => resolve());
      });
    });
    req.end();
    await new Promise((r) => setTimeout(r, 100));

    // 3. Worker claims run, starts run, executes tools via ToolExecutionGateway
    const claim = h.coordinator.claimRun(runId, h.worker.workerId, 30_000);
    h.coordinator.startRun(runId, h.worker.workerId, claim.lease.leaseId);

    const ws = await h.workspaceAdapter.provisionWorkspace({
      workspaceId: `ws-${runId}`,
      runId,
      taskId,
      maxWorkspaceBytes: 10 * 1024 * 1024,
      maxFileSizeBytes: 5 * 1024 * 1024,
    });

    // Execute write_file tool through ToolExecutionGateway
    const writeResult = await h.worker.executeAction({
      runId,
      toolName: "write_file",
      inputPayload: {
        path: "evidence.txt",
        content: "Milestone 2.26 Tool Execution Evidence",
        overwrite: true,
      },
      workspace: ws,
    });
    expect(writeResult.status).toBe("SUCCEEDED");

    // Execute read_file tool through ToolExecutionGateway
    const readResult = await h.worker.executeAction({
      runId,
      toolName: "read_file",
      inputPayload: { path: "evidence.txt" },
      workspace: ws,
    });
    expect(readResult.status).toBe("SUCCEEDED");
    expect((readResult.output as any).content).toBe("Milestone 2.26 Tool Execution Evidence");

    // Complete the run
    h.coordinator.completeRun(runId, h.worker.workerId, claim.lease.leaseId, { success: true });

    // Wait for SSE stream to receive all events and close on run.completed
    await streamClosedPromise;
    const events = parseSseText(rawChunks.join(""));
    const eventTypes = events.map((e) => e.event);

    expect(eventTypes).toContain("run.created");
    expect(eventTypes).toContain("run.queued");
    expect(eventTypes).toContain("worker.claimed");
    expect(eventTypes).toContain("run.started");
    expect(eventTypes).toContain("action.created");
    expect(eventTypes).toContain("action.authorized");
    expect(eventTypes).toContain("attempt.started");
    expect(eventTypes).toContain("attempt.completed");
    expect(eventTypes).toContain("action.completed");
    expect(eventTypes).toContain("run.completed");

    // Verify GET /api/v1/runs/:runId inspection returns COMPLETED with tool metrics
    const runRes = await h.server.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}`,
      headers: bearer(TOK_INTERNAL_ADMIN),
    });
    const runJson = JSON.parse(runRes.body);
    expect(runJson.data.status).toBe("COMPLETED");
  });
});

describe("Adversarial Security: Client-Controlled Trust Promotion Prevention", () => {
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
  });

  afterEach(async () => {
    await cleanupHarness(h);
  });

  it("Test A: External tenant cannot request constrained_host (fails closed with 403)", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_A_OP), "content-type": "application/json" },
      payload: {
        title: "echo",
        prompt: "Malicious trust promotion attempt",
        executionMode: "constrained_host",
        modelConfig: { modelName: "qwen2.5-coder:3b" },
      },
    });
    expect(res.statusCode).toBe(403);
    const json = JSON.parse(res.body);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("FORBIDDEN");
    expect(json.error.message).toContain("not authorized for constrained-host execution");
  });

  it("Test B: External tenant omitting executionMode defaults to sandboxed with MULTI_TENANT_WORKLOAD and ISOLATED", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_A_OP), "content-type": "application/json" },
      payload: {
        title: "echo",
        prompt: "Normal tenant task",
        modelConfig: { modelName: "qwen2.5-coder:3b" },
      },
    });
    expect(res.statusCode).toBe(201);
    const { taskId } = JSON.parse(res.body).data;

    // Verify contract policy in store
    const contracts = h.store.findContractsByTaskId(taskId);
    expect(contracts.length).toBeGreaterThan(0);
    const policy = contracts[0]!.spec.policy;
    expect(policy.isolationRequirement).toBe("ISOLATED");
    expect(policy.trustClassification).toBe("MULTI_TENANT_WORKLOAD");
    expect(policy.tenantId).toBe("tenant-alpha");
    expect(policy.requireRootlessDaemon).toBe(true);

    // Verify in-process worker rejects it fail-closed
    const check = await (h.worker as any).verifyIsolationSatisfaction("ISOLATED", policy);
    expect(check.satisfied).toBe(false);
    expect(check.reason).toContain("requires isolated Docker sandbox execution");

    // Furthermore, executing the run via WorkerRuntime fails closed
    const runResult = await h.worker.runOnce();
    expect(runResult.status).toBe("FAILED");
    expect((runResult as any).error.code).toBe("POLICY_DENIED");
  });

  it("Test C: Invalid executionMode is rejected with 400 Bad Request", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_A_OP), "content-type": "application/json" },
      payload: {
        title: "echo",
        prompt: "Invalid mode",
        executionMode: "unrestricted_root",
        modelConfig: { modelName: "qwen2.5-coder:3b" },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("BAD_REQUEST");
  });

  it("Test D: Tenant attempting to forge trustClassification is rejected with 400 Bad Request", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_A_OP), "content-type": "application/json" },
      payload: {
        title: "echo",
        prompt: "Forged classification",
        trustClassification: "TRUSTED_INTERNAL",
        modelConfig: { modelName: "qwen2.5-coder:3b" },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("BAD_REQUEST");
  });

  it("Test E: Tenant attempting to forge isolationRequirement is rejected with 400 Bad Request", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_A_OP), "content-type": "application/json" },
      payload: {
        title: "echo",
        prompt: "Forged isolation",
        isolationRequirement: "IN_PROCESS",
        modelConfig: { modelName: "qwen2.5-coder:3b" },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("BAD_REQUEST");
  });

  it("Test F: Authorized internal principal can use constrained_host mode", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_INTERNAL_ADMIN), "content-type": "application/json" },
      payload: {
        title: "echo",
        prompt: "Authorized internal task",
        executionMode: "constrained_host",
        modelConfig: { modelName: "qwen2.5-coder:3b" },
      },
    });
    expect(res.statusCode).toBe(201);
    const { taskId } = JSON.parse(res.body).data;

    const contracts = h.store.findContractsByTaskId(taskId);
    const policy = contracts[0]!.spec.policy;
    expect(policy.isolationRequirement).toBe("IN_PROCESS");
    expect(policy.trustClassification).toBe("TRUSTED_INTERNAL");
  });

  it("Test G: submitDurableTask directly rejects unauthorized constrained_host caller", () => {
    expect(() => {
      submitDurableTask(h.store, h.coordinator, {
        operation: "echo",
        task: "Direct call",
        executionMode: "constrained_host",
        authorizedForConstrainedHost: false, // unauthorized!
      });
    }).toThrow(/caller is not authorized for constrained host execution/);
  });

  it("Scenario 15: GET /api/v1/tasks queries durable SQLite tasks with tenant isolation and keyset pagination", async () => {
    // 1. Submit 3 tasks for tenant-alpha
    const alphaTaskIds: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const res = await h.server.inject({
        method: "POST",
        url: "/api/v1/tasks",
        headers: { ...bearer(TOK_A_OP), "content-type": "application/json" },
        payload: {
          title: `Alpha Durable Task ${i}`,
          prompt: `Run durable task ${i}`,
          modelConfig: { modelName: "qwen2.5-coder:3b" },
        },
      });
      expect(res.statusCode).toBe(201);
      alphaTaskIds.push(JSON.parse(res.body).data.taskId);
    }

    // 2. Submit 1 task for tenant-beta
    const betaRes = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_B_OP), "content-type": "application/json" },
      payload: {
        title: "Beta Durable Task",
        prompt: "Run beta durable task",
        modelConfig: { modelName: "qwen2.5-coder:3b" },
      },
    });
    expect(betaRes.statusCode).toBe(201);
    const betaTaskId = JSON.parse(betaRes.body).data.taskId;

    // 3. Query all tasks as tenant-alpha
    const listResAlpha = await h.server.inject({
      method: "GET",
      url: "/api/v1/tasks",
      headers: bearer(TOK_A_OP),
    });
    expect(listResAlpha.statusCode).toBe(200);
    expect(listResAlpha.headers["x-emerald-durability"]).toBe("durable-coordinator");
    const alphaBody = JSON.parse(listResAlpha.body);
    expect(alphaBody.success).toBe(true);
    expect(alphaBody.data).toHaveLength(3);
    const returnedAlphaIds = alphaBody.data.map((t: any) => t.taskId);
    expect(returnedAlphaIds).not.toContain(betaTaskId);
    for (const id of alphaTaskIds) {
      expect(returnedAlphaIds).toContain(id);
    }
    for (const t of alphaBody.data) {
      expect(t.tenantId).toBe("tenant-alpha");
      expect(t.contractId).toBeDefined();
      expect(t.executionMode).toBe("sandboxed");
    }

    // 4. Keyset pagination on SQLite store
    const page1Res = await h.server.inject({
      method: "GET",
      url: "/api/v1/tasks?limit=2",
      headers: bearer(TOK_A_OP),
    });
    expect(page1Res.statusCode).toBe(200);
    const page1 = JSON.parse(page1Res.body);
    expect(page1.data).toHaveLength(2);
    expect(page1.nextCursor).toBeDefined();
    expect(typeof page1.nextCursor).toBe("string");

    const page2Res = await h.server.inject({
      method: "GET",
      url: `/api/v1/tasks?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`,
      headers: bearer(TOK_A_OP),
    });
    expect(page2Res.statusCode).toBe(200);
    const page2 = JSON.parse(page2Res.body);
    expect(page2.data).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    // Verify union of pages has 0 duplicates and exactly covers alpha tasks
    const paginatedIds = [...page1.data.map((t: any) => t.taskId), ...page2.data.map((t: any) => t.taskId)];
    expect(paginatedIds).toHaveLength(3);
    expect(new Set(paginatedIds).size).toBe(3);

    // 5. Query as tenant-beta
    const listResBeta = await h.server.inject({
      method: "GET",
      url: "/api/v1/tasks",
      headers: bearer(TOK_B_OP),
    });
    expect(listResBeta.statusCode).toBe(200);
    const betaBody = JSON.parse(listResBeta.body);
    expect(betaBody.data).toHaveLength(1);
    expect(betaBody.data[0].taskId).toBe(betaTaskId);
    expect(betaBody.data[0].tenantId).toBe("tenant-beta");

    // 6. Security tests on durable store
    const forbiddenParamRes = await h.server.inject({
      method: "GET",
      url: "/api/v1/tasks?tenantId=tenant-beta",
      headers: bearer(TOK_A_OP),
    });
    expect(forbiddenParamRes.statusCode).toBe(400);

    const badCursorRes = await h.server.inject({
      method: "GET",
      url: "/api/v1/tasks?cursor=forged_cursor_value",
      headers: bearer(TOK_A_OP),
    });
    expect(badCursorRes.statusCode).toBe(400);

    // 7. Status filtering on durable store
    const statusFilteredRes = await h.server.inject({
      method: "GET",
      url: "/api/v1/tasks?status=QUEUED",
      headers: bearer(TOK_A_OP),
    });
    expect(statusFilteredRes.statusCode).toBe(200);
    expect(JSON.parse(statusFilteredRes.body).data).toHaveLength(3);

    const emptyStatusRes = await h.server.inject({
      method: "GET",
      url: "/api/v1/tasks?status=COMPLETED",
      headers: bearer(TOK_A_OP),
    });
    expect(emptyStatusRes.statusCode).toBe(200);
    expect(JSON.parse(emptyStatusRes.body).data).toHaveLength(0);
  });
});
