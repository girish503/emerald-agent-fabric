/**
 * Track B — Fastify transport: security and reliability regression suite.
 *
 * One group per finding of the Track B Final Security Acceptance Gate:
 *  1. Authentication (no default credential, digest comparison, all principals evaluated, uniform failures)
 *  2. Tenant isolation (no cross-tenant overwrite, indistinguishable not-found, atomic creation)
 *  3. Completion provenance (no public unverified-completion override, outcomes only from durable evidence)
 *  4. Cancellation authority (coordinator only, 409 mapping, roles, no fallback)
 *  5. SSE reliability (overflow signalling, contiguity, resume, boundary, cleanup, bounds)
 *  6. CORS and error handling (positive allowlist, sanitized errors, stable trace ids, diagnostics)
 *  7. Route inventory
 *
 * Tests that need run authority use the real RunCoordinator over a temporary SQLite database.
 * Records held in `inMemoryStore` are transport-local and NON-DURABLE; nothing here claims otherwise.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import http from "http";
import crypto from "crypto";
import { EventEmitter } from "events";
import {
  AuthConfigurationError,
  CorsConfigurationError,
  buildFastifyServer,
  type DiagnosticRecord,
  type PrincipalRecord,
} from "../../src/transport/http/server.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { VersionConflictError } from "../../src/domain/errors.js";
import { createAndActivateContract } from "../application/test-helpers.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const TOK_A_OP = "alpha-operator-token-aaaaaaaa1";
const TOK_A_AUD = "alpha-auditor-token-aaaaaaaaa2";
const TOK_A_ADM = "alpha-admin-token-aaaaaaaaaaa3";
const TOK_B_OP = "beta-operator-token-bbbbbbbbb4";
const TOK_B_ADM = "beta-admin-token-bbbbbbbbbbb5";

const principals: PrincipalRecord[] = [
  { token: TOK_A_OP, principalId: "a-op", tenantId: "tenant-alpha", role: "operator" },
  { token: TOK_A_AUD, principalId: "a-aud", tenantId: "tenant-alpha", role: "auditor" },
  { token: TOK_A_ADM, principalId: "a-adm", tenantId: "tenant-alpha", role: "admin" },
  { token: TOK_B_OP, principalId: "b-op", tenantId: "tenant-beta", role: "operator" },
  { token: TOK_B_ADM, principalId: "b-adm", tenantId: "tenant-beta", role: "admin" },
];

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const taskBody = { title: "Task", prompt: "Do it", modelConfig: { modelName: "qwen2.5-coder:3b" } };

function mk(extra: Record<string, unknown> = {}) {
  return buildFastifyServer({ principals, corsOrigins: [], inMemoryStore: {}, env: {}, ...extra } as never);
}

const shape = (body: any) => ({
  success: body.success,
  code: body.error?.code,
  message: body.error?.message,
  keys: Object.keys(body.error ?? {}).sort(),
});

interface Runtime {
  dir: string;
  store: SqliteStateStore;
  coordinator: RunCoordinator;
  clock: SettableClock;
  workerId: string;
}

function makeRuntime(): Runtime {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-trackb-"));
  const store = new SqliteStateStore({ location: path.join(dir, "state.db") });
  const clock = new SettableClock("2026-11-07T12:00:00.000Z");
  const coordinator = new RunCoordinator(store, clock);
  const workerId = "worker-trackb-1";
  store.transaction((tx) =>
    tx.insertWorker({ workerId, hostname: "localhost", pid: 4242, status: "ACTIVE", createdAt: clock.nowIso(), lastHeartbeatAt: clock.nowIso() })
  );
  return { dir, store, coordinator, clock, workerId };
}

function startRunning(rt: Runtime, taskId: string) {
  rt.coordinator.createTask({ taskId, title: taskId, inputPayload: {} });
  createAndActivateContract(rt.store, taskId);
  const { run } = rt.coordinator.createRun({ taskId });
  rt.coordinator.queueRun(run.runId);
  const claim = rt.coordinator.claimRun(run.runId, rt.workerId, 600_000);
  rt.coordinator.startRun(run.runId, rt.workerId, claim.lease.leaseId);
  return { runId: run.runId, leaseId: claim.lease.leaseId };
}

function seedOwnership(server: any, runId: string, tenantId: string, extra: Record<string, unknown> = {}) {
  server.inMemoryStore.runs.set(runId, { runId, taskId: "t", tenantId, status: "RUNNING", ...extra });
}

// ----------------------------------------------------------------------------
// 1. Authentication
// ----------------------------------------------------------------------------

describe("1. Authentication (default credential, digest comparison, uniform failure)", () => {
  it("fails closed: construction without credentials throws and names no default token", () => {
    expect(() => buildFastifyServer({ env: {} })).toThrow(AuthConfigurationError);
    expect(() => buildFastifyServer({ env: {} })).toThrow(/no principals configured/);
    expect(() => buildFastifyServer({ principals: [], env: {} })).toThrow(AuthConfigurationError);
  });

  it("reads principals from EMERALD_API_PRINCIPALS and validates them at startup", async () => {
    const env = { EMERALD_API_PRINCIPALS: JSON.stringify([{ token: TOK_A_OP, principalId: "p", tenantId: "t1", role: "operator" }]) };
    const server = buildFastifyServer({ env, inMemoryStore: {} });
    const ok = await server.inject({ method: "POST", url: "/api/v1/tasks", headers: bearer(TOK_A_OP), payload: taskBody });
    expect(ok.statusCode).toBe(201);
    expect(() => buildFastifyServer({ env: { EMERALD_API_PRINCIPALS: "{not json" } })).toThrow(AuthConfigurationError);
    expect(() => buildFastifyServer({ env: { EMERALD_API_PRINCIPALS: "{}" } })).toThrow(AuthConfigurationError);
  });

  it("rejects insecure principal configuration without echoing token values", () => {
    const base = { principalId: "p", tenantId: "t", role: "operator" as const };
    const bad: Array<[string, PrincipalRecord[]]> = [
      ["known default", [{ ...base, token: "test-emerald-token" }]],
      ["too short", [{ ...base, token: "short" }]],
      ["bad charset", [{ ...base, token: "has spaces and ! chars in token 123456" }]],
      ["duplicate", [{ ...base, token: TOK_A_OP }, { ...base, principalId: "q", token: TOK_A_OP }]],
      ["bad role", [{ ...base, token: TOK_A_OP, role: "root" as never }]],
      ["missing tenant", [{ ...base, token: TOK_A_OP, tenantId: "" }]],
    ];
    for (const [label, list] of bad) {
      let message = "";
      try {
        buildFastifyServer({ principals: list, env: {} });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, label).toMatch(/Authentication configuration invalid/);
      for (const p of list) expect(message).not.toContain(p.token);
    }
  });

  it("rejects the former default token when presented to a correctly configured server", async () => {
    const server = mk();
    const res = await server.inject({ method: "GET", url: "/api/v1/tasks/x", headers: bearer("test-emerald-token") });
    expect(res.statusCode).toBe(401);
  });

  it("returns an identical 401 for missing, malformed, wrong-length and equal-length invalid credentials", async () => {
    const server = mk();
    const equalLengthWrong = TOK_A_OP.slice(0, -1) + (TOK_A_OP.endsWith("1") ? "2" : "1");
    const cases: Array<Record<string, string>> = [
      {},
      { authorization: "Basic abcdef" },
      { authorization: "Bearer bad token!" },
      bearer("x"),
      bearer(TOK_A_OP + "extra-long-suffix-value-0123456789"),
      bearer(equalLengthWrong),
    ];
    const shapes = [];
    for (const headers of cases) {
      const res = await server.inject({ method: "GET", url: "/api/v1/tasks/x", headers });
      expect(res.statusCode).toBe(401);
      expect(res.headers["www-authenticate"]).toBe("Bearer");
      shapes.push(shape(res.json()));
    }
    for (const s of shapes) expect(s).toEqual(shapes[0]);
    expect(shapes[0]!.code).toBe("UNAUTHORIZED");
  });

  it("evaluates every configured principal on every request (no first-match short circuit)", async () => {
    const server = mk();
    const spy = vi.spyOn(crypto, "timingSafeEqual");
    try {
      const probes: Array<Record<string, string>> = [
        bearer(TOK_A_OP), // first principal
        bearer(TOK_B_ADM), // last principal
        bearer("not-a-configured-token-0000000"),
        {}, // missing
        { authorization: "garbage" }, // malformed
      ];
      for (const headers of probes) {
        spy.mockClear();
        await server.inject({ method: "GET", url: "/api/v1/tasks/x", headers });
        expect(spy).toHaveBeenCalledTimes(principals.length);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("authenticates the correct tenant and role for each configured principal", async () => {
    const server = mk();
    const created = await server.inject({ method: "POST", url: "/api/v1/tasks", headers: bearer(TOK_B_OP), payload: taskBody });
    expect(created.statusCode).toBe(201);
    expect(created.json().data.tenantId).toBe("tenant-beta");
    const aud = await server.inject({ method: "POST", url: "/api/v1/tasks", headers: bearer(TOK_A_AUD), payload: taskBody });
    expect(aud.statusCode).toBe(403); // auditor role: read-only
    const read = await server.inject({ method: "GET", url: `/api/v1/tasks/${created.json().data.taskId}`, headers: bearer(TOK_B_ADM) });
    expect(read.statusCode).toBe(200);
  });

  it("never places credentials in responses or diagnostics", async () => {
    const records: DiagnosticRecord[] = [];
    const rt = makeRuntime();
    try {
      const failing = { ...rt.coordinator, getRun: () => ({ status: "RUNNING" }), cancelRun: () => { throw new Error(`boom with Bearer ${TOK_A_OP}`); } };
      const server = mk({ coordinator: failing, diagnostics: (r: DiagnosticRecord) => records.push(r) });
      seedOwnership(server, "run-x", "tenant-alpha");
      const res = await server.inject({ method: "POST", url: "/api/v1/runs/run-x/cancel", headers: bearer(TOK_A_OP), payload: { reason: "r" } });
      expect(res.statusCode).toBe(500);
      const everything = JSON.stringify([res.body, res.headers, records]);
      for (const p of principals) expect(everything).not.toContain(p.token);
    } finally {
      rt.store.close();
      fs.rmSync(rt.dir, { recursive: true, force: true });
    }
  });
});

// ----------------------------------------------------------------------------
// 2. Tenant isolation and task creation
// ----------------------------------------------------------------------------

describe("2. Tenant isolation", () => {
  it("a tenant cannot overwrite another tenant's task by supplying its id", async () => {
    const server = mk();
    const a = await server.inject({ method: "POST", url: "/api/v1/tasks", headers: bearer(TOK_A_OP), payload: { ...taskBody, title: "A-original" } });
    const taskId = a.json().data.taskId as string;
    const snapshot = JSON.stringify((server as any).inMemoryStore.tasks.get(taskId));

    const b = await server.inject({ method: "POST", url: "/api/v1/tasks", headers: bearer(TOK_B_OP), payload: { ...taskBody, title: "B-overwrite", taskId } });
    expect(b.statusCode).toBe(400); // client-supplied ids are not accepted (strict schema)
    expect(JSON.stringify((server as any).inMemoryStore.tasks.get(taskId))).toBe(snapshot);

    const aGet = await server.inject({ method: "GET", url: `/api/v1/tasks/${taskId}`, headers: bearer(TOK_A_OP) });
    expect(aGet.statusCode).toBe(200);
    expect(aGet.json().data.title).toBe("A-original");
    expect(aGet.json().data.tenantId).toBe("tenant-alpha");
  });

  it("task ids are server-generated and unique", async () => {
    const server = mk();
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const r = await server.inject({ method: "POST", url: "/api/v1/tasks", headers: bearer(TOK_A_OP), payload: taskBody });
      ids.add(r.json().data.taskId);
    }
    expect(ids.size).toBe(5);
  });

  it("concurrent creations from two tenants never collide or rebind a task to another tenant", async () => {
    const server = mk();
    const jobs = Array.from({ length: 40 }, (_, i) =>
      server.inject({ method: "POST", url: "/api/v1/tasks", headers: bearer(i % 2 ? TOK_B_OP : TOK_A_OP), payload: { ...taskBody, title: `t${i}` } })
    );
    const results = await Promise.all(jobs);
    const seen = new Set<string>();
    results.forEach((r, i) => {
      expect(r.statusCode).toBe(201);
      const d = r.json().data;
      expect(seen.has(d.taskId)).toBe(false);
      seen.add(d.taskId);
      expect(d.tenantId).toBe(i % 2 ? "tenant-beta" : "tenant-alpha");
      expect((server as any).inMemoryStore.tasks.get(d.taskId).tenantId).toBe(d.tenantId);
    });
  });

  it("missing and foreign-tenant resources are externally indistinguishable on every route", async () => {
    const server = mk();
    const t = await server.inject({ method: "POST", url: "/api/v1/tasks", headers: bearer(TOK_A_OP), payload: taskBody });
    const foreignTask = t.json().data.taskId as string;
    seedOwnership(server, "run-foreign", "tenant-alpha");

    const routes: Array<[string, string, string, string, any?]> = [
      ["GET", `/api/v1/tasks/${foreignTask}`, "/api/v1/tasks/task-missing", "task"],
      ["GET", "/api/v1/runs/run-foreign", "/api/v1/runs/run-missing", "run"],
      ["GET", "/api/v1/runs/run-foreign/events", "/api/v1/runs/run-missing/events", "events"],
      ["GET", "/api/v1/runs/run-foreign/artifacts", "/api/v1/runs/run-missing/artifacts", "artifacts"],
      ["POST", "/api/v1/runs/run-foreign/cancel", "/api/v1/runs/run-missing/cancel", "cancel", { reason: "r" }],
    ];
    for (const [method, foreignUrl, missingUrl, label, payload] of routes) {
      const f = await server.inject({ method: method as "GET" | "POST", url: foreignUrl, headers: bearer(TOK_B_OP), payload });
      const m = await server.inject({ method: method as "GET" | "POST", url: missingUrl, headers: bearer(TOK_B_OP), payload });
      expect(f.statusCode, label).toBe(404);
      expect(m.statusCode, label).toBe(404);
      expect(shape(f.json()), label).toEqual(shape(m.json()));
      expect(f.body).not.toContain("run-foreign");
    }
  });

  it("task creation is unavailable (503) when no task adapter or service is configured", async () => {
    const server = buildFastifyServer({ principals, corsOrigins: [], env: {} });
    const res = await server.inject({ method: "POST", url: "/api/v1/tasks", headers: bearer(TOK_A_OP), payload: taskBody });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("TRANSIENT");
  });
});

// ----------------------------------------------------------------------------
// 3. Completion provenance
// ----------------------------------------------------------------------------

describe("3. Completion evidence provenance", () => {
  let rt: Runtime;
  beforeEach(() => {
    rt = makeRuntime();
  });
  afterEach(() => {
    rt.store.close();
    fs.rmSync(rt.dir, { recursive: true, force: true });
  });

  it("public callers cannot submit allowUnverifiedCompletion", async () => {
    const server = mk();
    for (const value of [true, false]) {
      const res = await server.inject({ method: "POST", url: "/api/v1/tasks", headers: bearer(TOK_A_OP), payload: { ...taskBody, allowUnverifiedCompletion: value } });
      expect(res.statusCode).toBe(400);
    }
    expect((server as any).inMemoryStore.tasks.size).toBe(0);
  });

  it("a transport-local COMPLETED record never reports a final outcome (no inference from in-memory status)", async () => {
    const server = mk();
    seedOwnership(server, "run-local", "tenant-alpha", { status: "COMPLETED", finalOutcome: "VERIFIED_SUCCESS", createdAt: new Date().toISOString() });
    const res = await server.inject({ method: "GET", url: "/api/v1/runs/run-local", headers: bearer(TOK_A_OP) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.finalOutcome).toBeNull();
    expect(res.headers["x-emerald-durability"]).toBe("transport-local-non-durable");
  });

  it("a worker-reported completion without verification evidence is not VERIFIED_SUCCESS", async () => {
    const { runId, leaseId } = startRunning(rt, "t-claim-only");
    rt.coordinator.completeRun(runId, rt.workerId, leaseId, { claimed: "done" }); // worker says done; no evidence recorded
    const server = mk({ coordinator: rt.coordinator });
    seedOwnership(server, runId, "tenant-alpha");
    const res = await server.inject({ method: "GET", url: `/api/v1/runs/${runId}`, headers: bearer(TOK_A_OP) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("COMPLETED");
    expect(res.json().data.finalOutcome).toBe("COMPLETION_UNVERIFIABLE");
    expect(res.json().data.finalOutcome).not.toBe("VERIFIED_SUCCESS");
    expect(res.headers["x-emerald-durability"]).toBe("durable-coordinator");
  });

  it("a completion backed by VERIFIED durable verification evidence reports VERIFIED_SUCCESS", async () => {
    const { runId, leaseId } = startRunning(rt, "t-verified");
    rt.coordinator.recordVerificationResult(runId, {
      status: "VERIFIED", verifierId: "deterministic-verifier-v1", specId: "spec-1", evidenceIds: [], message: "ok", verifiedAt: rt.clock.nowIso(),
    });
    rt.coordinator.completeRun(runId, rt.workerId, leaseId, { ok: true });
    const server = mk({ coordinator: rt.coordinator });
    seedOwnership(server, runId, "tenant-alpha");
    const res = await server.inject({ method: "GET", url: `/api/v1/runs/${runId}`, headers: bearer(TOK_A_OP) });
    expect(res.json().data.finalOutcome).toBe("VERIFIED_SUCCESS");
  });

  it("failed verification evidence cannot produce a successful outcome", async () => {
    const { runId, leaseId } = startRunning(rt, "t-failed-verification");
    rt.coordinator.recordVerificationResult(runId, {
      status: "FAILED", verifierId: "deterministic-verifier-v1", specId: "spec-1", evidenceIds: [], reasonCode: "ASSERTION_FAILED", message: "no", verifiedAt: rt.clock.nowIso(),
    });
    rt.coordinator.completeRun(runId, rt.workerId, leaseId, { ok: true });
    const server = mk({ coordinator: rt.coordinator });
    seedOwnership(server, runId, "tenant-alpha");
    const res = await server.inject({ method: "GET", url: `/api/v1/runs/${runId}`, headers: bearer(TOK_A_OP) });
    expect(res.json().data.finalOutcome).not.toBe("VERIFIED_SUCCESS");
  });
});

// ----------------------------------------------------------------------------
// 4. Cancellation authority and concurrency
// ----------------------------------------------------------------------------

describe("4. Cancellation (coordinator authority only)", () => {
  let rt: Runtime;
  beforeEach(() => {
    rt = makeRuntime();
  });
  afterEach(() => {
    rt.store.close();
    fs.rmSync(rt.dir, { recursive: true, force: true });
  });

  const cancel = (server: any, runId: string, token = TOK_A_OP) =>
    server.inject({ method: "POST", url: `/api/v1/runs/${runId}/cancel`, headers: bearer(token), payload: { reason: "operator abort" } });

  it("cancels through the coordinator and reports authoritative persisted state", async () => {
    const { runId } = startRunning(rt, "t-cancel-ok");
    const server = mk({ coordinator: rt.coordinator });
    seedOwnership(server, runId, "tenant-alpha");
    const before = rt.coordinator.getEventsForRun(runId).length;

    const res = await cancel(server, runId);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("CANCELLED");
    expect(rt.store.getRun(runId)?.status).toBe("CANCELLED");

    const events = rt.coordinator.getEventsForRun(runId);
    const cancelled = events.filter((e) => e.eventType === "run.cancelled");
    expect(cancelled).toHaveLength(1);
    expect(events).toHaveLength(before + 1);
    expect(res.json().data.cancelledAt).toBe(cancelled[0]!.timestamp); // persisted timestamp, not fabricated
    expect(res.headers["x-emerald-durability"]).toBe("durable-coordinator");
  });

  it("cancelling a terminal run returns 409 and leaves state, finalOutcome and events untouched", async () => {
    const { runId, leaseId } = startRunning(rt, "t-cancel-terminal");
    rt.coordinator.completeRun(runId, rt.workerId, leaseId, { ok: true });
    const eventsBefore = JSON.stringify(rt.coordinator.getEventsForRun(runId));
    const server = mk({ coordinator: rt.coordinator });
    seedOwnership(server, runId, "tenant-alpha");

    const res = await cancel(server, runId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
    expect(rt.store.getRun(runId)?.status).toBe("COMPLETED");
    expect(JSON.stringify(rt.coordinator.getEventsForRun(runId))).toBe(eventsBefore);
  });

  it("a cancel in a state the machine forbids (VERIFYING) returns 409", async () => {
    const { runId } = startRunning(rt, "t-cancel-verifying");
    (rt.store as any).db.exec(`UPDATE runs SET status = 'VERIFYING' WHERE run_id = '${runId}'`);
    const server = mk({ coordinator: rt.coordinator });
    seedOwnership(server, runId, "tenant-alpha");
    const res = await cancel(server, runId);
    expect(res.statusCode).toBe(409);
    expect(rt.store.getRun(runId)?.status).toBe("VERIFYING");
  });

  it("a completion that wins the race between the read and the cancel yields 409; the completion is preserved", async () => {
    const { runId, leaseId } = startRunning(rt, "t-race");
    const racing = Object.create(rt.coordinator) as RunCoordinator;
    (racing as any).cancelRun = (id: string, reason?: string) => {
      rt.coordinator.completeRun(runId, rt.workerId, leaseId, { ok: true }); // interleaved completion
      return rt.coordinator.cancelRun(id, reason);
    };
    const server = mk({ coordinator: racing });
    seedOwnership(server, runId, "tenant-alpha");
    const res = await cancel(server, runId);
    expect(res.statusCode).toBe(409);
    expect(rt.store.getRun(runId)?.status).toBe("COMPLETED");
    const terminal = rt.coordinator.getEventsForRun(runId).filter((e) => ["run.completed", "run.cancelled", "run.failed", "run.timed_out"].includes(e.eventType));
    expect(terminal.map((e) => e.eventType)).toEqual(["run.completed"]);
  });

  it("a stale version cannot cancel a newer state (VersionConflictError maps to 409)", async () => {
    const stale = {
      getRun: () => ({ status: "RUNNING" }),
      cancelRun: () => {
        throw new VersionConflictError("run-stale", 1, 2);
      },
    } as unknown as RunCoordinator;
    const server = mk({ coordinator: stale });
    seedOwnership(server, "run-stale", "tenant-alpha");
    const res = await cancel(server, "run-stale");
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
  });

  it("an auditor cannot cancel; the run is unchanged", async () => {
    const { runId } = startRunning(rt, "t-auditor");
    const server = mk({ coordinator: rt.coordinator });
    seedOwnership(server, runId, "tenant-alpha");
    const res = await cancel(server, runId, TOK_A_AUD);
    expect(res.statusCode).toBe(403);
    expect(rt.store.getRun(runId)?.status).toBe("RUNNING");
  });

  it("no role bypasses tenant isolation: another tenant's admin gets 404 and cannot cancel", async () => {
    const { runId } = startRunning(rt, "t-cross-tenant");
    const server = mk({ coordinator: rt.coordinator });
    seedOwnership(server, runId, "tenant-alpha");
    const res = await cancel(server, runId, TOK_B_ADM);
    expect(res.statusCode).toBe(404);
    expect(rt.store.getRun(runId)?.status).toBe("RUNNING");
  });

  it("without a coordinator cancellation is unavailable (503): no fallback mutation, no fabricated identities", async () => {
    const server = mk();
    seedOwnership(server, "run-local-only", "tenant-alpha", { status: "RUNNING" });
    const res = await cancel(server, "run-local-only");
    expect(res.statusCode).toBe(503);
    expect((server as any).inMemoryStore.runs.get("run-local-only").status).toBe("RUNNING");
    expect((server as any).inMemoryStore.runs.get("run-local-only").currentWorkerId).toBeUndefined();
    const src = fs.readFileSync(path.resolve("src/transport/http/server.ts"), "utf8");
    expect(src).not.toMatch(/worker-supervisor|lease-supervisor|Run\.reconstitute|runs\.set\(runId, updated/);
  });

  it("unexpected coordinator failures are a sanitized 500 with server-side diagnostics only", async () => {
    const records: DiagnosticRecord[] = [];
    const broken = {
      getRun: () => ({ status: "RUNNING" }),
      cancelRun: () => {
        throw new Error("sqlite: disk I/O error at /secret/path/state.db");
      },
    } as unknown as RunCoordinator;
    const server = mk({ coordinator: broken, diagnostics: (r: DiagnosticRecord) => records.push(r) });
    seedOwnership(server, "run-broken", "tenant-alpha");
    const res = await cancel(server, "run-broken");
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("secret");
    expect(res.body).not.toContain("sqlite");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ event: "http.unhandled_error", traceId: res.json().error.traceId, route: "/api/v1/runs/:runId/cancel" });
  });
});

// ----------------------------------------------------------------------------
// 5. SSE reliability (server level)
// ----------------------------------------------------------------------------

interface SseClient {
  ids: () => number[];
  frames: () => string[];
  raw: () => string;
  ended: Promise<void>;
  destroy: () => void;
  status: () => number;
  headers: () => http.IncomingHttpHeaders;
}

function sseConnect(port: number, urlPath: string, headers: Record<string, string>): SseClient {
  let buf = "";
  let status = 0;
  let resHeaders: http.IncomingHttpHeaders = {};
  let req!: http.ClientRequest;
  const ended = new Promise<void>((resolve) => {
    req = http.get({ host: "127.0.0.1", port, path: urlPath, headers }, (res) => {
      status = res.statusCode ?? 0;
      resHeaders = res.headers;
      res.on("data", (c: Buffer) => (buf += c.toString()));
      res.on("end", () => resolve());
      res.on("close", () => resolve());
    });
    req.on("error", () => resolve());
  });
  return {
    ids: () => [...buf.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1])),
    frames: () => buf.split("\n\n").filter((f) => f.trim().length > 0 && !f.startsWith(":")),
    raw: () => buf,
    ended,
    destroy: () => req.destroy(),
    status: () => status,
    headers: () => resHeaders,
  };
}

const ev = (runId: string, sequence: number, eventType = "action.created") => ({
  eventId: `evt-${runId}-${sequence}`, runId, sequence, timestamp: "2026-11-07T12:00:00.000Z", eventType, schemaVersion: 1, producer: "test", payload: { n: sequence },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("5. SSE reliability", () => {
  const servers: Array<{ close: () => Promise<unknown> }> = [];
  afterEach(async () => {
    while (servers.length) await servers.pop()!.close();
  });

  async function startSse(opts: { durable?: any[] | ((bc: EventEmitter) => any[]); bufferMax?: number; maxConnections?: number; terminalRun?: boolean }) {
    const broadcaster = new EventEmitter();
    const stateStore =
      opts.durable === undefined
        ? undefined
        : { getEventsForRun: () => (typeof opts.durable === "function" ? opts.durable(broadcaster) : opts.durable) } as any;
    const server = mk({
      eventBroadcaster: broadcaster,
      stateStore,
      sse: { maxBufferedEvents: opts.bufferMax ?? 1000, maxConnections: opts.maxConnections ?? 100 },
    });
    seedOwnership(server, "run-sse", "tenant-alpha", { status: opts.terminalRun ? "COMPLETED" : "RUNNING" });
    await server.listen({ port: 0, host: "127.0.0.1" });
    servers.push(server);
    return { server, broadcaster, port: (server.server.address() as any).port as number };
  }

  it("replays durable events in order and closes for a terminal run; reports its replay source", async () => {
    const durable = [ev("run-sse", 1, "run.created"), ev("run-sse", 2, "action.created"), ev("run-sse", 3, "run.completed")];
    const { port } = await startSse({ durable, terminalRun: true });
    const c = sseConnect(port, "/api/v1/runs/run-sse/events", bearer(TOK_A_OP));
    await c.ended;
    expect(c.status()).toBe(200);
    expect(c.ids()).toEqual([1, 2, 3]);
    expect(c.headers()["x-emerald-replay"]).toBe("durable");
  });

  it("resumes from Last-Event-ID: only newer events, in order, without duplicates", async () => {
    const durable = [1, 2, 3, 4, 5].map((n) => ev("run-sse", n, n === 5 ? "run.completed" : "action.created"));
    const { port } = await startSse({ durable, terminalRun: true });
    const c = sseConnect(port, "/api/v1/runs/run-sse/events", { ...bearer(TOK_A_OP), "last-event-id": "3" });
    await c.ended;
    expect(c.ids()).toEqual([4, 5]);
  });

  it("rejects a malformed Last-Event-ID instead of silently replaying from zero", async () => {
    const { server } = await startSse({ durable: [ev("run-sse", 1)] });
    for (const bad of ["abc", "-1", "1.5", "99999999999999999999"]) {
      const res = await server.inject({ method: "GET", url: "/api/v1/runs/run-sse/events", headers: { ...bearer(TOK_A_OP), "last-event-id": bad } });
      expect(res.statusCode, bad).toBe(400);
    }
  });

  it("fails explicitly when resume is requested but durable replay is unavailable", async () => {
    const { server } = await startSse({}); // no stateStore, no coordinator
    const res = await server.inject({ method: "GET", url: "/api/v1/runs/run-sse/events", headers: { ...bearer(TOK_A_OP), "last-event-id": "4" } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.message).toMatch(/durable event replay is not available/);
  });

  it("subscribe-before-replay: events published while history is read are neither lost nor duplicated", async () => {
    const { port } = await startSse({
      durable: (bc) => {
        // Published between subscription and the end of the history read (the boundary window).
        for (const n of [3, 4, 5]) bc.emit("run:run-sse", { ...ev("run-sse", n), event: "action.created", data: {} });
        bc.emit("run:run-sse", { ...ev("run-sse", 6, "run.completed"), event: "run.completed", data: {} });
        return [ev("run-sse", 1), ev("run-sse", 2), ev("run-sse", 3)]; // snapshot overlaps live event 3
      },
    });
    const c = sseConnect(port, "/api/v1/runs/run-sse/events", bearer(TOK_A_OP));
    await c.ended;
    expect(c.ids()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("live buffer overflow emits stream.overflow with the last delivered sequence and terminates; ids stay contiguous", async () => {
    const { port } = await startSse({
      bufferMax: 5,
      durable: (bc) => {
        for (let n = 1; n <= 20; n++) bc.emit("run:run-sse", { ...ev("run-sse", n), event: "action.created", data: {} });
        return [];
      },
    });
    const c = sseConnect(port, "/api/v1/runs/run-sse/events", bearer(TOK_A_OP));
    await c.ended;
    expect(c.ids()).toEqual([1, 2, 3, 4, 5]); // contiguous, nothing skipped
    const overflow = c.frames().find((f) => f.includes("event: stream.overflow"))!;
    expect(overflow).toBeDefined();
    expect(overflow).not.toMatch(/^id:/m); // control event must not move the client's cursor
    const payload = JSON.parse(overflow.split("data: ")[1]!);
    expect(payload).toMatchObject({ runId: "run-sse", lastDeliveredSequence: 5, reason: "LIVE_BUFFER_OVERFLOW" });
  });

  it("after an overflow, reconnecting from the last delivered id recovers every missing durable event in order", async () => {
    const all = Array.from({ length: 20 }, (_, i) => ev("run-sse", i + 1, i === 19 ? "run.completed" : "action.created"));
    const { port } = await startSse({ durable: all, terminalRun: true });
    const resumed = sseConnect(port, "/api/v1/runs/run-sse/events", { ...bearer(TOK_A_OP), "last-event-id": "5" });
    await resumed.ended;
    expect(resumed.ids()).toEqual(Array.from({ length: 15 }, (_, i) => i + 6));
  });

  it("the cursor never jumps over a sequence gap: a live gap produces an overflow notice, not an advanced id", async () => {
    const { port, broadcaster } = await startSse({ durable: [ev("run-sse", 1), ev("run-sse", 2)] });
    const c = sseConnect(port, "/api/v1/runs/run-sse/events", bearer(TOK_A_OP));
    await sleep(100);
    broadcaster.emit("run:run-sse", { ...ev("run-sse", 3), event: "action.created", data: {} });
    broadcaster.emit("run:run-sse", { ...ev("run-sse", 9), event: "action.created", data: {} }); // 4..8 never observed
    await c.ended;
    expect(c.ids()).toEqual([1, 2, 3]);
    const payload = JSON.parse(c.frames().find((f) => f.includes("stream.overflow"))!.split("data: ")[1]!);
    expect(payload).toMatchObject({ lastDeliveredSequence: 3, reason: "SEQUENCE_GAP" });
  });

  it("relays live events and ends the stream after a terminal event", async () => {
    const { port, broadcaster } = await startSse({ durable: [ev("run-sse", 1)] });
    const c = sseConnect(port, "/api/v1/runs/run-sse/events", bearer(TOK_A_OP));
    await sleep(100);
    broadcaster.emit("run:run-sse", { ...ev("run-sse", 2, "run.failed"), event: "run.failed", data: {} });
    await c.ended;
    expect(c.ids()).toEqual([1, 2]);
  });

  it("removes its subscription on client disconnect and releases the connection slot", async () => {
    const { port, broadcaster } = await startSse({ durable: [ev("run-sse", 1)], maxConnections: 1 });
    const c1 = sseConnect(port, "/api/v1/runs/run-sse/events", bearer(TOK_A_OP));
    await sleep(100);
    expect(broadcaster.listenerCount("run:run-sse")).toBe(1);
    c1.destroy();
    await c1.ended;
    await sleep(100);
    expect(broadcaster.listenerCount("run:run-sse")).toBe(0);
    const c2 = sseConnect(port, "/api/v1/runs/run-sse/events", bearer(TOK_A_OP));
    await sleep(100);
    expect(c2.status()).toBe(200); // slot was released
    c2.destroy();
  });

  it("bounds the number of concurrent streams (503 beyond the cap)", async () => {
    const { port } = await startSse({ durable: [ev("run-sse", 1)], maxConnections: 1 });
    const c1 = sseConnect(port, "/api/v1/runs/run-sse/events", bearer(TOK_A_OP));
    await sleep(100);
    const c2 = sseConnect(port, "/api/v1/runs/run-sse/events", bearer(TOK_A_OP));
    await c2.ended;
    expect(c2.status()).toBe(503);
    c1.destroy();
  });

  it("only the owning tenant may stream; auditors may read; unauthenticated callers are refused", async () => {
    const { port } = await startSse({ durable: [ev("run-sse", 1, "run.completed")], terminalRun: true });
    const other = sseConnect(port, "/api/v1/runs/run-sse/events", bearer(TOK_B_OP));
    await other.ended;
    expect(other.status()).toBe(404);
    const aud = sseConnect(port, "/api/v1/runs/run-sse/events", bearer(TOK_A_AUD));
    await aud.ended;
    expect(aud.status()).toBe(200);
    const anon = sseConnect(port, "/api/v1/runs/run-sse/events", {});
    await anon.ended;
    expect(anon.status()).toBe(401);
  });
});

// ----------------------------------------------------------------------------
// 6. CORS and error handling
// ----------------------------------------------------------------------------

describe("6. CORS and error handling", () => {
  it("rejects wildcard and malformed origins at startup without consulting NODE_ENV", () => {
    const bad = ["*", "https://*.example.com", "httpx://example.com", "ftp://example.com", "https://example.com/path", "https://example.com/", "not a url", "https://user:pw@example.com"];
    for (const origin of bad) {
      expect(() => buildFastifyServer({ principals, corsOrigins: [origin], env: {} }), origin).toThrow(CorsConfigurationError);
    }
    // Same result regardless of NODE_ENV being unset, "production" or "development".
    for (const nodeEnv of [undefined, "production", "development"]) {
      expect(() => buildFastifyServer({ principals, corsOrigins: ["*"], env: nodeEnv ? { NODE_ENV: nodeEnv } : {} })).toThrow(CorsConfigurationError);
    }
    expect(() => buildFastifyServer({ principals, env: { EMERALD_CORS_ORIGINS: "https://ok.example.com,*" } })).toThrow(CorsConfigurationError);
  });

  it("allows only explicitly listed origins, with credentials, and no CORS headers otherwise", async () => {
    const server = mk({ corsOrigins: ["https://app.example.com", "http://localhost:3000"] });
    const allowed = await server.inject({ method: "GET", url: "/api/v1/tasks/x", headers: { ...bearer(TOK_A_OP), origin: "https://app.example.com" } });
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://app.example.com");
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");
    const denied = await server.inject({ method: "GET", url: "/api/v1/tasks/x", headers: { ...bearer(TOK_A_OP), origin: "https://evil.example.com" } });
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    const preflight = await server.inject({ method: "OPTIONS", url: "/api/v1/tasks", headers: { origin: "https://app.example.com", "access-control-request-method": "POST" } });
    expect(preflight.statusCode).toBeLessThan(300);
    expect(preflight.headers["access-control-allow-origin"]).toBe("https://app.example.com");
  });

  it("with no configured origins no cross-origin access is granted by default", async () => {
    const server = mk();
    const res = await server.inject({ method: "GET", url: "/api/v1/tasks/x", headers: { ...bearer(TOK_A_OP), origin: "http://localhost:3000" } });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("CORS is not authorization: allowed origins and requests without an Origin still require credentials", async () => {
    const server = mk({ corsOrigins: ["https://app.example.com"] });
    const noOrigin = await server.inject({ method: "GET", url: "/api/v1/tasks/x" });
    expect(noOrigin.statusCode).toBe(401);
    const allowedOriginNoAuth = await server.inject({ method: "GET", url: "/api/v1/tasks/x", headers: { origin: "https://app.example.com" } });
    expect(allowedOriginNoAuth.statusCode).toBe(401);
  });

  it("internal exception details never reach responses; diagnostics are redacted and carry the trace id", async () => {
    const records: DiagnosticRecord[] = [];
    const broken = {
      getRun: () => ({ status: "RUNNING" }),
      cancelRun: () => {
        throw new Error("db at C:/secret/state.db failed; header was Bearer abc.def.ghi");
      },
    } as unknown as RunCoordinator;
    const server = mk({ coordinator: broken, diagnostics: (r: DiagnosticRecord) => records.push(r) });
    seedOwnership(server, "run-err", "tenant-alpha");
    const res = await server.inject({ method: "POST", url: "/api/v1/runs/run-err/cancel", headers: bearer(TOK_A_OP), payload: { reason: "r" } });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.message).toMatch(/internal server error/i);
    expect(res.body).not.toMatch(/secret|state\.db|abc\.def/);
    expect(JSON.stringify(records)).not.toContain("abc.def.ghi");
    expect(records[0]!.errorMessage).toContain("Bearer [REDACTED]");
    expect(records[0]!.traceId).toBe(res.json().error.traceId);
  });

  it("4xx responses use fixed messages (no framework or parser text)", async () => {
    const server = mk();
    const res = await server.inject({ method: "POST", url: "/api/v1/tasks", headers: { ...bearer(TOK_A_OP), "content-type": "application/json" }, payload: "{broken json" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe("Invalid request");
    expect(res.body).not.toMatch(/Unexpected|JSON|position/);
  });

  it("keeps one stable trace id per request across header and body, and rejects unsafe incoming ids", async () => {
    const server = mk();
    const r401 = await server.inject({ method: "GET", url: "/api/v1/tasks/x" });
    expect(r401.headers["x-trace-id"]).toBe(r401.json().error.traceId);
    const r404 = await server.inject({ method: "GET", url: "/api/v1/tasks/x", headers: bearer(TOK_A_OP) });
    expect(r404.headers["x-trace-id"]).toBe(r404.json().error.traceId);
    expect(r401.headers["x-trace-id"]).not.toBe(r404.headers["x-trace-id"]);

    const safe = await server.inject({ method: "GET", url: "/api/v1/tasks/x", headers: { ...bearer(TOK_A_OP), "x-trace-id": "client-trace_1.2" } });
    expect(safe.json().error.traceId).toBe("client-trace_1.2");
    for (const unsafe of ["has space", "inject\u0001ctrl", "a".repeat(129), "semi;colon", "tab\there"]) {
      const res = await server.inject({ method: "GET", url: "/api/v1/tasks/x", headers: { ...bearer(TOK_A_OP), "x-trace-id": unsafe } });
      const id = res.json().error.traceId as string;
      expect(id).not.toBe(unsafe);
      expect(id).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
    }
  });

  it("unmatched routes return the standard sanitized 404 shape", async () => {
    const server = mk();
    const res = await server.inject({ method: "GET", url: "/api/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
  });
});

// ----------------------------------------------------------------------------
// 7. Route inventory
// ----------------------------------------------------------------------------

describe("7. Route inventory", () => {
  it("registers exactly the six documented /api/v1 routes and no claim routes", () => {
    const server = mk();
    const expected: Array<["GET" | "POST", string]> = [
      ["POST", "/api/v1/tasks"],
      ["GET", "/api/v1/tasks/:taskId"],
      ["GET", "/api/v1/runs/:runId"],
      ["POST", "/api/v1/runs/:runId/cancel"],
      ["GET", "/api/v1/runs/:runId/events"],
      ["GET", "/api/v1/runs/:runId/artifacts"],
    ];
    for (const [method, url] of expected) expect(server.hasRoute({ method, url }), `${method} ${url}`).toBe(true);
    const tree = server.printRoutes({ commonPrefix: false });
    expect(tree.toLowerCase()).not.toContain("claim");
    for (const [method, url] of [["POST", "/api/v1/runs/:runId/claim"], ["POST", "/api/v1/claims"], ["GET", "/api/v1/claims/:claimId"]] as const) {
      expect(server.hasRoute({ method, url }), `${method} ${url}`).toBe(false);
    }
  });
});

// ----------------------------------------------------------------------------
// 8. Defect remediation regressions (adversarial review)
// ----------------------------------------------------------------------------

describe("8. Defect remediation regressions (adversarial review)", () => {
  it("unauthenticated request with malformed JSON receives 401 instead of 400", async () => {
    const server = mk();
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { "content-type": "application/json" },
      payload: "{broken json",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });

  it("unauthenticated request with oversized payload receives 401 instead of 413", async () => {
    const server = mk();
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ title: "a".repeat(2 * 1024 * 1024) }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });

  it("unauthenticated request with unsupported media type receives 401 instead of 415", async () => {
    const server = mk();
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { "content-type": "text/plain" },
      payload: "hello raw text",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });

  it("authenticated request with unsupported media type receives 415 UNSUPPORTED_MEDIA_TYPE", async () => {
    const server = mk();
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_A_OP), "content-type": "text/plain" },
      payload: "hello raw text",
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("authenticated request with oversized payload receives 413 PAYLOAD_TOO_LARGE", async () => {
    const server = mk();
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_A_OP), "content-type": "application/json" },
      payload: JSON.stringify({ title: "a".repeat(2 * 1024 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  describe("Token entropy validation", () => {
    it("rejects tokens consisting of a single repeated character", () => {
      expect(() =>
        buildFastifyServer({
          principals: [{ token: "a".repeat(32), principalId: "p", tenantId: "t", role: "operator" }],
          env: {},
        })
      ).toThrow(/insufficient entropy|single repeated character/);
    });

    it("rejects tokens with fewer than 8 distinct characters", () => {
      expect(() =>
        buildFastifyServer({
          principals: [{ token: "abababababababababababababababab", principalId: "p", tenantId: "t", role: "operator" }],
          env: {},
        })
      ).toThrow(/insufficient entropy/);
    });

    it("rejects tokens consisting purely of repeated dictionary words without entropy", () => {
      expect(() =>
        buildFastifyServer({
          principals: [{ token: "secretsecretsecretsecretsecret", principalId: "p", tenantId: "t", role: "operator" }],
          env: {},
        })
      ).toThrow(/predictable dictionary words/);
    });
  });

  describe("Cancellation and Recovery Authority", () => {
    it("rejects cancellation of run in RECOVERING state with 409 Conflict", async () => {
      const recoveringCoordinator = {
        getRun: (id: string) => ({ runId: id, taskId: "t1", status: "RECOVERING" }),
        cancelRun: () => {
          throw new Error("cancelRun should not be called on RECOVERING run");
        },
      } as unknown as RunCoordinator;
      const server = mk({ coordinator: recoveringCoordinator });
      seedOwnership(server, "run-rec", "tenant-alpha");
      const res = await server.inject({
        method: "POST",
        url: "/api/v1/runs/run-rec/cancel",
        headers: bearer(TOK_A_OP),
        payload: { reason: "cancel during recovery" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("CONFLICT");
      expect(res.json().error.message).toContain("recovery supervisor holds exclusive recovery authority");
    });

    it("cancellation response for active run includes process termination disclaimer note", async () => {
      const rt = makeRuntime();
      const { runId } = startRunning(rt, "t-cancel-disclaimer");
      const server = mk({ coordinator: rt.coordinator });
      seedOwnership(server, runId, "tenant-alpha");
      const res = await server.inject({
        method: "POST",
        url: `/api/v1/runs/${runId}/cancel`,
        headers: bearer(TOK_A_OP),
        payload: { reason: "operator requested cancellation" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.status).toBe("CANCELLED");
      expect(res.json().data.note).toContain("does not guarantee immediate termination of executing worker processes");
    });
  });

  describe("SSE Streaming failure handling, tenant limits & role projection", () => {
    it("pre-header history read failure returns 503 SERVICE_UNAVAILABLE", async () => {
      const failingStore = {
        getEventsForRun: () => {
          throw new Error("disk I/O error reading durable events");
        },
      };
      const server = mk({ stateStore: failingStore as any });
      seedOwnership(server, "run-failing-sse", "tenant-alpha");
      const res = await server.inject({
        method: "GET",
        url: "/api/v1/runs/run-failing-sse/events",
        headers: bearer(TOK_A_OP),
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("SERVICE_UNAVAILABLE");
      expect(res.json().error.message).toContain("Durable event store read failure");
    });

    it("serves X-Emerald-Live-Source header as durable-store-replay", async () => {
      const durable = [ev("run-sse", 1, "run.created"), ev("run-sse", 2, "run.completed")];
      const broadcaster = new EventEmitter();
      const stateStore = { getEventsForRun: () => durable } as any;
      const server = mk({ eventBroadcaster: broadcaster, stateStore });
      seedOwnership(server, "run-sse", "tenant-alpha", { status: "COMPLETED" });
      await server.listen({ port: 0, host: "127.0.0.1" });
      try {
        const port = (server.server.address() as any).port as number;
        const c = sseConnect(port, "/api/v1/runs/run-sse/events", bearer(TOK_A_OP));
        await c.ended;
        expect(c.headers()["x-emerald-live-source"]).toBe("durable-store-replay");
      } finally {
        await server.close();
      }
    });

    it("enforces tenant-level connection limits (maximum 5 concurrent streams per tenant)", async () => {
      const broadcaster = new EventEmitter();
      const stateStore = { getEventsForRun: () => [ev("run-sse", 1)] } as any;
      const server = mk({ eventBroadcaster: broadcaster, stateStore });
      seedOwnership(server, "run-sse", "tenant-alpha");
      await server.listen({ port: 0, host: "127.0.0.1" });
      const clients: SseClient[] = [];
      try {
        const port = (server.server.address() as any).port as number;
        // Open 5 concurrent connections for tenant-alpha
        for (let i = 0; i < 5; i++) {
          clients.push(sseConnect(port, "/api/v1/runs/run-sse/events", bearer(TOK_A_OP)));
        }
        await sleep(50);
        // 6th connection for tenant-alpha should receive 429
        const res6 = await server.inject({
          method: "GET",
          url: "/api/v1/runs/run-sse/events",
          headers: bearer(TOK_A_OP),
        });
        expect(res6.statusCode).toBe(429);
        expect(res6.json().error.code).toBe("TOO_MANY_REQUESTS");
        expect(res6.json().error.message).toContain("Too many active event streams for tenant 'tenant-alpha'");

        // But tenant-beta should still be allowed to connect
        seedOwnership(server, "run-beta", "tenant-beta");
        const cBeta = sseConnect(port, "/api/v1/runs/run-beta/events", bearer(TOK_B_OP));
        await sleep(100);
        expect(cBeta.status()).toBe(200);
        cBeta.destroy();
        await cBeta.ended;
      } finally {
        clients.forEach((c) => c.destroy());
        await server.close();
      }
    });

    it("projects event payload according to caller role (auditor redacts scripts, commands, and paths)", async () => {
      const sensitiveData = {
        rawScript: "echo 'sensitive execution script'",
        command: "npm test --secret=xyz",
        internalPaths: ["C:\\Users\\admin\\repo", "/tmp/scratch"],
        specId: "spec-001",
        passed: true,
        token: "token-12345",
      };
      const durable = [
        {
          eventId: "e1",
          runId: "run-proj",
          sequence: 1,
          timestamp: "2026-11-07T12:00:00.000Z",
          eventType: "verification.completed",
          schemaVersion: 1,
          producer: "verifier",
          payload: sensitiveData,
        },
        ev("run-proj", 2, "run.completed"),
      ];

      const broadcaster = new EventEmitter();
      const stateStore = { getEventsForRun: () => durable } as any;
      const server = mk({ eventBroadcaster: broadcaster, stateStore });
      seedOwnership(server, "run-proj", "tenant-alpha", { status: "COMPLETED" });
      await server.listen({ port: 0, host: "127.0.0.1" });
      try {
        const port = (server.server.address() as any).port as number;

        // Auditor connection:
        const audClient = sseConnect(port, "/api/v1/runs/run-proj/events", bearer(TOK_A_AUD));
        await audClient.ended;
        const audFrames = audClient.frames();
        expect(audFrames.length).toBeGreaterThan(0);
        const audPayload = audFrames[0]?.split("data: ")[1];
        expect(audPayload).toBeDefined();
        const audFirstEvent = JSON.parse(audPayload!);
        expect(audFirstEvent.data.specId).toBe("spec-001");
        expect(audFirstEvent.data.passed).toBe(true);
        expect(audFirstEvent.data.rawScript).toBeUndefined();
        expect(audFirstEvent.data.command).toBeUndefined();
        expect(audFirstEvent.data.internalPaths).toBeUndefined();
        expect(audFirstEvent.data.token).toBe("[REDACTED]");

        // Operator connection:
        const opClient = sseConnect(port, "/api/v1/runs/run-proj/events", bearer(TOK_A_OP));
        await opClient.ended;
        const opFrames = opClient.frames();
        expect(opFrames.length).toBeGreaterThan(0);
        const opPayload = opFrames[0]?.split("data: ")[1];
        expect(opPayload).toBeDefined();
        const opFirstEvent = JSON.parse(opPayload!);
        expect(opFirstEvent.data.specId).toBe("spec-001");
        expect(opFirstEvent.data.rawScript).toBe("echo 'sensitive execution script'");
        expect(opFirstEvent.data.command).toBe("npm test --secret=xyz");
        expect(opFirstEvent.data.token).toBe("[REDACTED]");
      } finally {
        await server.close();
      }
    });
  });
});
