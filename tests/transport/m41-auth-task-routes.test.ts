/**
 * Emerald Agent Fabric — M4.1 Workstreams C & D Verification Suite
 *
 * Covers:
 * - GET /api/v1/auth/whoami identity projection, Cache-Control: no-store, no token leaks
 * - Security response headers & opt-in webUiRoot CSP (no 'unsafe-inline' scripts) + traversal containment
 * - GET /api/v1/tasks/:taskId durable SQLite projection (real status, runId, contractId, hierarchy, cross-restart persistence, cross-tenant 404)
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import * as crypto from "node:crypto";
import { buildFastifyServer, type PrincipalRecord } from "../../src/transport/http/server.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { ApprovalControl } from "../../src/control-plane/approval-control.js";
import { CapabilityFenceEnforcer } from "../../src/application/capability-fence-enforcer.js";
import { CrossHarnessGateway } from "../../src/application/cross-harness-gateway.js";
import { ProductionGovernanceFacade } from "../../src/governance/production-governance-facade.js";
import { TaskRouterService } from "../../src/application/task-router.js";
import { MultiAgentOrchestrator } from "../../src/application/multi-agent-orchestrator.js";
import { computeCapabilityFenceHash, type CapabilityFence } from "../../src/domain/capability-fence.js";

const TOK_A_OP = "alpha-operator-token-aaaaaaaa1";
const TOK_A_AUD = "alpha-auditor-token-aaaaaaaaa2";
const TOK_B_OP = "beta-operator-token-bbbbbbbbb4";

const PRINCIPALS: PrincipalRecord[] = [
  { token: TOK_A_OP, principalId: "principal-alpha-op", tenantId: "tenant-alpha", role: "operator" },
  { token: TOK_A_AUD, principalId: "principal-alpha-aud", tenantId: "tenant-alpha", role: "auditor" },
  { token: TOK_B_OP, principalId: "principal-beta-op", tenantId: "tenant-beta", role: "operator" },
];

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe("M4.1 Auth Identity, Security Headers, webUiRoot & Durable GET /tasks/:taskId", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  function setupHarness(options?: { enableWebUiRoot?: boolean; webUiRootOverride?: string }) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-m41-cd-"));
    const dbPath = path.join(tmpDir, "state.db");
    const store = new SqliteStateStore({ location: dbPath });
    const clock = new SettableClock("2026-11-12T10:00:00.000Z");
    const broadcaster = new EventEmitter();
    const coordinator = new RunCoordinator(store, clock, undefined, undefined, broadcaster);

    const webUiRoot = options?.webUiRootOverride
      ? options.webUiRootOverride
      : options?.enableWebUiRoot
      ? path.resolve(process.cwd(), "apps/web")
      : undefined;

    const server = buildFastifyServer({
      store,
      coordinator,
      eventBroadcaster: broadcaster,
      principals: PRINCIPALS,
      corsOrigins: [],
      webUiRoot,
    });

    cleanups.push(async () => {
      await server.close().catch(() => {});
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    return { tmpDir, dbPath, store, clock, broadcaster, coordinator, server };
  }

  it("returns authenticated principal identity on GET /api/v1/auth/whoami without leaking bearer token", async () => {
    const { server } = setupHarness();

    const unauth = await server.inject({ method: "GET", url: "/api/v1/auth/whoami" });
    expect(unauth.statusCode).toBe(401);
    expect(unauth.headers["cache-control"]).toBe("no-store");
    expect(unauth.headers["x-content-type-options"]).toBe("nosniff");
    expect(unauth.headers["referrer-policy"]).toBe("no-referrer");
    expect(unauth.headers["x-frame-options"]).toBe("DENY");

    const badToken = await server.inject({
      method: "GET",
      url: "/api/v1/auth/whoami",
      headers: bearer("invalid-secret-token-value"),
    });
    expect(badToken.statusCode).toBe(401);

    const ok = await server.inject({
      method: "GET",
      url: "/api/v1/auth/whoami",
      headers: bearer(TOK_A_AUD),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect(ok.headers["x-content-type-options"]).toBe("nosniff");
    expect(ok.body).not.toContain(TOK_A_AUD);

    const body = ok.json();
    expect(body).toEqual({
      success: true,
      data: {
        principalId: "principal-alpha-aud",
        tenantId: "tenant-alpha",
        role: "auditor",
        allowConstrainedHost: false,
      },
    });
  });

  it("keeps static web UI routes disabled unless webUiRoot is configured", async () => {
    const { server } = setupHarness({ enableWebUiRoot: false });
    const resRoot = await server.inject({ method: "GET", url: "/" });
    const resIndex = await server.inject({ method: "GET", url: "/index.html" });
    const resBundle = await server.inject({ method: "GET", url: "/dist/bundle.js" });

    expect(resRoot.statusCode).toBe(404);
    expect(resIndex.statusCode).toBe(404);
    expect(resBundle.statusCode).toBe(404);
  });

  it("serves webUiRoot index.html & bundle.js with strict CSP (no inline script) and blocks path traversal", async () => {
    const { server } = setupHarness({ enableWebUiRoot: true });

    const htmlRes = await server.inject({ method: "GET", url: "/" });
    expect(htmlRes.statusCode).toBe(200);
    expect(htmlRes.headers["content-type"]).toContain("text/html");
    const csp = String(htmlRes.headers["content-security-policy"] ?? "");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(htmlRes.headers["x-frame-options"]).toBe("DENY");
    expect(htmlRes.headers["x-content-type-options"]).toBe("nosniff");
    expect(htmlRes.body).toContain('<script type="module" src="./dist/bundle.js"></script>');
    expect(htmlRes.body).not.toContain("import { mountDashboardApp");

    const bundleRes = await server.inject({ method: "GET", url: "/dist/bundle.js" });
    expect(bundleRes.statusCode).toBe(200);
    expect(bundleRes.headers["content-type"]).toContain("text/javascript");
    expect(bundleRes.headers["x-content-type-options"]).toBe("nosniff");

    const traversal = await server.inject({ method: "GET", url: "/dist/../../package.json" });
    expect(traversal.statusCode).toBe(404);
  });

  it("projects durable SQLite task status, run linkage, hierarchy counts, cross-restart state, and cross-tenant 404 on GET /api/v1/tasks/:taskId", async () => {
    const { dbPath, store, coordinator, server } = setupHarness();

    const submitRes = await server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: bearer(TOK_A_OP),
      payload: {
        title: "Inspect durable status projection",
        prompt: "Read src/index.ts and verify task projection.",
        modelConfig: {
          provider: "ollama",
          modelName: "qwen2.5-coder:7b",
        },
      },
    });
    expect(submitRes.statusCode).toBe(201);
    const created = submitRes.json().data;
    const taskId = created.taskId as string;
    const runId = created.runId as string;
    expect(typeof created.contractId).toBe("string");

    // Cancel the run via operator endpoint so durable run/task status transitions to CANCELLED
    const cancelRes = await server.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/cancel`,
      headers: bearer(TOK_A_OP),
      payload: { reason: "Verify durable status projection after cancel" },
    });
    expect([200, 202]).toContain(cancelRes.statusCode);

    // Create a second durable task via POST /api/v1/tasks and link as child via task_relations
    const childSubmitRes = await server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: bearer(TOK_A_OP),
      payload: {
        title: "Child subtask for durable count check",
        prompt: "Read package.json in child task.",
        modelConfig: {
          provider: "ollama",
          modelName: "qwen2.5-coder:7b",
        },
      },
    });
    expect(childSubmitRes.statusCode).toBe(201);
    const childTaskId = childSubmitRes.json().data.taskId as string;
    store.transaction((tx) => {
      tx.insertTaskRelation({
        childTaskId,
        parentTaskId: taskId,
        depth: 1,
        ordinal: 0,
        createdAt: "2026-11-12T10:05:00.000Z",
      });
    });

    // Cross-tenant access must return 404
    const crossTenant = await server.inject({
      method: "GET",
      url: `/api/v1/tasks/${taskId}`,
      headers: bearer(TOK_B_OP),
    });
    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.json().error.code).toBe("NOT_FOUND");

    // Same-tenant lookup on a fresh server instance sharing only the SQLite file (simulating restart)
    const storeRestarted = new SqliteStateStore({ location: dbPath });
    const coordRestarted = new RunCoordinator(storeRestarted, new SettableClock("2026-11-12T10:06:00.000Z"));
    const restartedServer = buildFastifyServer({
      store: storeRestarted,
      coordinator: coordRestarted,
      principals: PRINCIPALS,
      corsOrigins: [],
    });
    cleanups.push(async () => {
      await restartedServer.close().catch(() => {});
      storeRestarted.close();
    });

    const parentGet = await restartedServer.inject({
      method: "GET",
      url: `/api/v1/tasks/${taskId}`,
      headers: bearer(TOK_A_AUD),
    });
    expect(parentGet.statusCode).toBe(200);
    const parentBody = parentGet.json().data;
    expect(parentBody.taskId).toBe(taskId);
    expect(parentBody.status).toBe("CANCELLED");
    expect(parentBody.runId).toBe(runId);
    expect(parentBody.contractId).toBe(created.contractId);
    expect(parentBody.executionMode).toBe("sandboxed");
    expect(parentBody.parentTaskId).toBeUndefined();
    expect(parentBody.childTaskCount).toBe(1);

    const childGet = await restartedServer.inject({
      method: "GET",
      url: `/api/v1/tasks/${childTaskId}`,
      headers: bearer(TOK_A_OP),
    });
    expect(childGet.statusCode).toBe(200);
    expect(childGet.json().data.parentTaskId).toBe(taskId);
    expect(childGet.json().data.childTaskCount).toBeUndefined();
    expect(coordinator).toBeDefined();
  });

  it("fails closed (404) on contractless/tenantless SQLite tasks and runs across inspect/decompose/hierarchy/synthesize routes", async () => {
    const { store, coordinator, server } = setupHarness();

    // Seed a legacy/unscoped task & run directly into SQLite with no MissionContract and no tenantId
    coordinator.createTask({ taskId: "task-unscoped-1", title: "Unscoped task", inputPayload: {} });
    store.transaction((tx) => {
      tx.insertRun(
        {
          runId: "run-unscoped-1",
          taskId: "task-unscoped-1",
          status: "CREATED",
          version: 1,
          attemptCount: 0,
          maxAttempts: 1,
          timeoutMs: 30000,
          idempotencyKey: null,
          currentWorkerId: null,
          leaseId: null,
          leaseExpiresAt: null,
          resultPayload: null,
          errorPayload: null,
          createdAt: "2026-11-12T10:00:00.000Z",
          updatedAt: "2026-11-12T10:00:00.000Z",
          contractBinding: null,
        },
        {
          eventId: "evt-unscoped-1",
          runId: "run-unscoped-1",
          eventType: "run.created",
          timestamp: "2026-11-12T10:00:00.000Z",
          schemaVersion: "1.0.0",
          producer: "test-seed",
          payload: {
            taskId: "task-unscoped-1",
            attemptCount: 0,
            maxAttempts: 1,
            timeoutMs: 30000,
          },
        } as any
      );
    });

    const getTaskRes = await server.inject({
      method: "GET",
      url: "/api/v1/tasks/task-unscoped-1",
      headers: bearer(TOK_A_OP),
    });
    expect(getTaskRes.statusCode).toBe(404);

    const decomposeRes = await server.inject({
      method: "POST",
      url: "/api/v1/tasks/task-unscoped-1/decompose",
      headers: bearer(TOK_A_OP),
      payload: { strategy: "sequential", maxSubtasks: 2 },
    });
    expect(decomposeRes.statusCode).toBe(404);

    const hierarchyRes = await server.inject({
      method: "GET",
      url: "/api/v1/tasks/task-unscoped-1/hierarchy",
      headers: bearer(TOK_A_OP),
    });
    expect(hierarchyRes.statusCode).toBe(404);

    const synthRes = await server.inject({
      method: "POST",
      url: "/api/v1/tasks/task-unscoped-1/synthesize",
      headers: bearer(TOK_A_OP),
      payload: {},
    });
    expect(synthRes.statusCode).toBe(404);

    const getRunRes = await server.inject({
      method: "GET",
      url: "/api/v1/runs/run-unscoped-1",
      headers: bearer(TOK_A_OP),
    });
    expect(getRunRes.statusCode).toBe(404);
    expect(store.getTask("task-unscoped-1")).not.toBeNull();
  });

  it("sanitizes Content-Disposition filename for inMemoryStore artifact content downloads", async () => {
    const tasks = new Map<string, any>();
    const runs = new Map<string, any>();
    const artifacts = new Map<string, any[]>();
    const artifactContents = new Map<string, string | Buffer>();

    runs.set("run-mem-cd-1", {
      runId: "run-mem-cd-1",
      taskId: "task-mem-cd-1",
      tenantId: "tenant-alpha",
      status: "COMPLETED",
      attemptNumber: 1,
      currentStepIndex: 1,
      leaseExpiresAt: null,
      finalOutcome: "PASSED",
      metrics: { wallClockMs: 10, stepCount: 1, toolCallCount: 1 },
      createdAt: "2026-11-12T10:00:00.000Z",
      completedAt: "2026-11-12T10:01:00.000Z",
    });

    const content = "diff --git a/a.ts b/a.ts\n+const ok = true;\n";
    artifacts.set("run-mem-cd-1", [
      {
        artifactId: "art-cd-1",
        runId: "run-mem-cd-1",
        type: "patch_diff",
        relativePath: 'evil";filename="pwned.exe',
        sha256: undefined,
        bytes: Buffer.byteLength(content, "utf8"),
        createdAt: "2026-11-12T10:00:30.000Z",
      },
    ]);
    artifactContents.set("art-cd-1", content);

    const server = buildFastifyServer({
      principals: PRINCIPALS,
      corsOrigins: [],
      inMemoryStore: { tasks, runs, artifacts, artifactContents },
    });
    cleanups.push(async () => {
      await server.close().catch(() => {});
    });

    const res = await server.inject({
      method: "GET",
      url: "/api/v1/runs/run-mem-cd-1/artifacts/art-cd-1/content",
      headers: bearer(TOK_A_OP),
    });
    expect(res.statusCode).toBe(200);
    const cd = String(res.headers["content-disposition"] ?? "");
    expect(cd).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"$/);
    expect(cd).toBe('attachment; filename="evil__filename__pwned.exe"');
  });
});

describe("M4.1 Adversarial Tenant Authority Verification (9 Scenarios & INFO-1 / Idempotency Remediation)", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  function setupFullHarness() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-m41-tenant-"));
    const artifactRoot = path.join(tmpDir, "artifacts");
    fs.mkdirSync(artifactRoot, { recursive: true });
    const dbPath = path.join(tmpDir, "state.db");
    const store = new SqliteStateStore({ location: dbPath });
    const clock = new SettableClock("2026-11-12T10:00:00.000Z");
    const broadcaster = new EventEmitter();
    const coordinator = new RunCoordinator(store, clock, undefined, undefined, broadcaster);
    const taskRouter = new TaskRouterService(store, coordinator, clock, { maxConcurrentRuns: 1 });
    const orchestrator = new MultiAgentOrchestrator(store, coordinator, taskRouter, clock);

    const server = buildFastifyServer({
      store,
      coordinator,
      orchestrator,
      eventBroadcaster: broadcaster,
      artifactRoot,
      principals: PRINCIPALS,
      corsOrigins: [],
    });

    cleanups.push(async () => {
      await server.close().catch(() => {});
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    return { tmpDir, artifactRoot, dbPath, store, clock, broadcaster, coordinator, orchestrator, server };
  }

  it("Scenario 1 & 2: Rejects client tenantId on POST /tasks (400), ignores subtask inputPayload.tenantId spoofing, and never falls back to inputPayload.tenantId on GET /tasks/:id", async () => {
    const { store, coordinator, server } = setupFullHarness();

    // Scenario 1 & 2a: POST /api/v1/tasks strictly rejects caller-supplied tenantId (both matching and mismatched)
    for (const suppliedTenant of ["tenant-alpha", "tenant-beta"]) {
      const rejectedCreate = await server.inject({
        method: "POST",
        url: "/api/v1/tasks",
        headers: bearer(TOK_A_OP),
        payload: {
          title: "Spoof attempt",
          prompt: "Read README.md",
          tenantId: suppliedTenant,
          modelConfig: { provider: "ollama", modelName: "qwen2.5-coder:7b" },
        },
      });
      expect(rejectedCreate.statusCode).toBe(400);
      expect(rejectedCreate.json().error.code).toBe("BAD_REQUEST");
    }

    // Create legitimate parent task for tenant-alpha
    const parentRes = await server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: bearer(TOK_A_OP),
      payload: {
        title: "Authorized mission",
        prompt: "Inspect repo safely.",
        requiredCapabilities: ["workspace.file.read", "workspace.code.search", "git.read"],
        modelConfig: { provider: "ollama", modelName: "qwen2.5-coder:7b" },
      },
    });
    expect(parentRes.statusCode).toBe(201);
    const parentTaskId = parentRes.json().data.taskId as string;

    // Scenario 1 & 2b: Decompose with inputPayload.tenantId targeting both tenant-alpha and tenant-beta
    const decompRes = await server.inject({
      method: "POST",
      url: `/api/v1/tasks/${parentTaskId}/decompose`,
      headers: bearer(TOK_A_OP),
      payload: {
        subtasks: [
          {
            subtaskId: "sub-a",
            role: "RESEARCHER",
            objective: "Inspect files for alpha",
            inputPayload: { tenantId: "tenant-alpha" },
          },
          {
            subtaskId: "sub-b",
            role: "RESEARCHER",
            objective: "Attempt tenantId confusion toward beta",
            inputPayload: { tenantId: "tenant-beta" },
          },
        ],
      },
    });
    expect(decompRes.statusCode).toBe(201);
    const subtaskIds = decompRes.json().data.subtaskTaskIds as string[];
    const subBTaskId = subtaskIds.find((id) => id.endsWith("sub-b"))!;
    expect(subBTaskId).toBeDefined();

    // Child contract keeps parent's authenticated tenant-alpha; tenant-beta gets 404 despite inputPayload.tenantId
    const subBAsAlpha = await server.inject({
      method: "GET",
      url: `/api/v1/tasks/${subBTaskId}`,
      headers: bearer(TOK_A_OP),
    });
    expect(subBAsAlpha.statusCode).toBe(200);
    expect(subBAsAlpha.json().data.tenantId).toBe("tenant-alpha");

    const subBAsBeta = await server.inject({
      method: "GET",
      url: `/api/v1/tasks/${subBTaskId}`,
      headers: bearer(TOK_B_OP),
    });
    expect(subBAsBeta.statusCode).toBe(404);
    expect(subBAsBeta.json().error.code).toBe("NOT_FOUND");

    // Scenario 2c (INFO-1 remediation): Contractless SQLite task carrying inputPayload.tenantId MUST fail closed (404)
    coordinator.createTask({
      taskId: "task-payload-only-1",
      title: "Legacy contractless task",
      inputPayload: { tenantId: "tenant-alpha", spoofingBeta: "tenant-beta" },
    });
    const getPayloadOnlyA = await server.inject({
      method: "GET",
      url: "/api/v1/tasks/task-payload-only-1",
      headers: bearer(TOK_A_OP),
    });
    const getPayloadOnlyB = await server.inject({
      method: "GET",
      url: "/api/v1/tasks/task-payload-only-1",
      headers: bearer(TOK_B_OP),
    });
    expect(getPayloadOnlyA.statusCode).toBe(404);
    expect(getPayloadOnlyB.statusCode).toBe(404);
    expect(store.getTask("task-payload-only-1")).not.toBeNull();
  });

  it("Scenario 3 & 4: Derives tenantId strictly from server-side principal and fails closed when authenticated tenant context is missing", async () => {
    const { store, server } = setupFullHarness();

    // Scenario 3: Authenticated tenant A with no tenantId in payload derives tenant-alpha in response and durable contract
    const createRes = await server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: bearer(TOK_A_OP),
      payload: {
        title: "Normal task without tenant in body",
        prompt: "Inspect codebase status.",
        modelConfig: { provider: "ollama", modelName: "qwen2.5-coder:7b" },
      },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json().data;
    expect(created.tenantId).toBe("tenant-alpha");
    const contracts = store.findContractsByTaskId(created.taskId);
    expect(contracts).toHaveLength(1);
    expect(contracts[0]!.spec.policy.tenantId).toBe("tenant-alpha");

    // Scenario 4: Missing / empty / whitespace tenantId in principal configuration fails closed at startup
    for (const badTenant of ["", "   ", undefined]) {
      expect(() =>
        buildFastifyServer({
          principals: [
            {
              token: TOK_A_OP,
              principalId: "op-missing-tenant",
              tenantId: badTenant as string,
              role: "operator",
            },
          ],
          corsOrigins: [],
        })
      ).toThrow(/tenantId is required/);
    }
  });

  it("Scenario 5: Unauthenticated requests supplying tenantId in body or query fail closed with 401 UNAUTHORIZED", async () => {
    const { server } = setupFullHarness();

    const unauthPost = await server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { "content-type": "application/json" },
      payload: {
        title: "Unauth attempt",
        prompt: "Should fail 401 before schema",
        tenantId: "tenant-alpha",
        modelConfig: { provider: "ollama", modelName: "qwen2.5-coder:7b" },
      },
    });
    expect(unauthPost.statusCode).toBe(401);
    expect(unauthPost.json().error.code).toBe("UNAUTHORIZED");

    const unauthList = await server.inject({
      method: "GET",
      url: "/api/v1/tasks?tenantId=tenant-alpha",
    });
    expect(unauthList.statusCode).toBe(401);

    const unauthTaskGet = await server.inject({
      method: "GET",
      url: "/api/v1/tasks/task-any?tenantId=tenant-alpha",
    });
    expect(unauthTaskGet.statusCode).toBe(401);

    const unauthSse = await server.inject({
      method: "GET",
      url: "/api/v1/runs/run-any/events?tenantId=tenant-alpha",
    });
    expect(unauthSse.statusCode).toBe(401);

    const unauthArtifact = await server.inject({
      method: "GET",
      url: "/api/v1/runs/run-any/artifacts/art-1/content?tenantId=tenant-alpha",
    });
    expect(unauthArtifact.statusCode).toBe(401);
  });

  it("Scenario 6, 8 & 9: Blocks cross-tenant task, idempotency-key collision, artifact retrieval, and SSE subscription (404 / isolated creation)", async () => {
    const { artifactRoot, store, coordinator, server } = setupFullHarness();

    // Seed Tenant A task + run + artifact + event
    const sharedIdemKey = "shared-cross-tenant-idem-key-001";
    const createA = await server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_A_OP), "idempotency-key": sharedIdemKey },
      payload: {
        title: "Alpha isolated task",
        prompt: "Verify artifact & SSE isolation.",
        modelConfig: { provider: "ollama", modelName: "qwen2.5-coder:7b" },
      },
    });
    expect(createA.statusCode).toBe(201);
    const taskA = createA.json().data.taskId as string;
    const runA = createA.json().data.runId as string;

    // Cross-tenant Idempotency-Key check: Tenant B using the same key MUST NOT get Tenant A's taskId/runId
    const createB = await server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_B_OP), "idempotency-key": sharedIdemKey },
      payload: {
        title: "Beta independent task with same idem key",
        prompt: "Must create separate task for beta.",
        modelConfig: { provider: "ollama", modelName: "qwen2.5-coder:7b" },
      },
    });
    expect(createB.statusCode).toBe(201);
    expect(createB.json().data.tenantId).toBe("tenant-beta");
    expect(createB.json().data.taskId).not.toBe(taskA);
    expect(createB.json().data.runId).not.toBe(runA);

    // Same-tenant retry for Tenant A still deduplicates cleanly to Tenant A's run
    const retryA = await server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_A_OP), "idempotency-key": sharedIdemKey },
      payload: {
        title: "Alpha isolated task",
        prompt: "Verify artifact & SSE isolation.",
        modelConfig: { provider: "ollama", modelName: "qwen2.5-coder:7b" },
      },
    });
    expect(retryA.statusCode).toBe(200);
    expect(retryA.json().data.taskId).toBe(taskA);
    expect(retryA.json().data.runId).toBe(runA);

    // Create real artifact bundle under artifactRoot for runA matching discoverRunArtifacts manifest schema
    const attemptDir = path.join(artifactRoot, runA, "attempt-1");
    fs.mkdirSync(attemptDir, { recursive: true });
    const patchBytes = Buffer.from("diff --git a/x.ts b/x.ts\n+export const x = 1;\n", "utf8");
    const patchPath = path.join(attemptDir, "patch.diff");
    fs.writeFileSync(patchPath, patchBytes);
    const patchSha = crypto.createHash("sha256").update(patchBytes).digest("hex");
    fs.writeFileSync(
      path.join(attemptDir, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        runId: runA,
        attempt: 1,
        createdAt: "2026-11-12T10:01:00.000Z",
        disposalReason: "Run completed successfully",
        baselineCommit: "0123456789abcdef0123456789abcdef01234567",
        files: [{ path: "x.ts", status: "modified", linesAdded: 1, linesRemoved: 0, binary: false }],
        totals: { changedFiles: 1, added: 0, modified: 1, deleted: 0, linesAdded: 1, linesRemoved: 0 },
        patch: { file: "patch.diff", bytes: patchBytes.length, sha256: patchSha },
      })
    );
    const artListA = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${runA}/artifacts`,
      headers: bearer(TOK_A_OP),
    });
    expect(artListA.statusCode).toBe(200);
    const alphaArtifactId = artListA.json().data[0].artifactId as string;
    expect(typeof alphaArtifactId).toBe("string");

    // Scenario 6: Cross-tenant task & run access returns 404 (and tenant list excludes taskA)
    const listB = await server.inject({ method: "GET", url: "/api/v1/tasks", headers: bearer(TOK_B_OP) });
    expect(listB.statusCode).toBe(200);
    expect(listB.json().data.map((t: any) => t.taskId)).not.toContain(taskA);

    for (const check of [
      { method: "GET" as const, url: `/api/v1/tasks/${taskA}` },
      { method: "GET" as const, url: `/api/v1/tasks/${taskA}/hierarchy` },
      { method: "POST" as const, url: `/api/v1/tasks/${taskA}/synthesize`, payload: {} },
      { method: "POST" as const, url: `/api/v1/tasks/${taskA}/decompose`, payload: { subtasks: [{ subtaskId: "s1", role: "RESEARCHER", objective: "x" }] } },
      { method: "GET" as const, url: `/api/v1/runs/${runA}` },
      { method: "POST" as const, url: `/api/v1/runs/${runA}/cancel`, payload: { reason: "cross-tenant attempt" } },
    ]) {
      const res = await server.inject({
        method: check.method,
        url: check.url,
        headers: bearer(TOK_B_OP),
        ...(check.payload ? { payload: check.payload } : {}),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("NOT_FOUND");
    }

    // Scenario 8: Cross-tenant artifact discovery and content download fail closed (404 / 400 with query param)
    const artListB = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${runA}/artifacts`,
      headers: bearer(TOK_B_OP),
    });
    expect(artListB.statusCode).toBe(404);

    const artContentB = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${runA}/artifacts/${alphaArtifactId}/content`,
      headers: bearer(TOK_B_OP),
    });
    expect(artContentB.statusCode).toBe(404);

    const artContentSpoof = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${runA}/artifacts/${alphaArtifactId}/content?tenantId=tenant-alpha`,
      headers: bearer(TOK_B_OP),
    });
    expect([400, 404]).toContain(artContentSpoof.statusCode);

    // Tenant A legitimately downloads its own artifact
    const artContentA = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${runA}/artifacts/${alphaArtifactId}/content`,
      headers: bearer(TOK_A_OP),
    });
    expect(artContentA.statusCode).toBe(200);
    expect(artContentA.body).toContain("export const x = 1;");

    // Scenario 9: Cross-tenant SSE subscription fails closed (404)
    const sseB = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${runA}/events`,
      headers: bearer(TOK_B_OP),
    });
    expect(sseB.statusCode).toBe(404);
    expect(sseB.json().error.code).toBe("NOT_FOUND");

    const sseBSpoof = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${runA}/events?tenantId=tenant-alpha`,
      headers: { ...bearer(TOK_B_OP), "last-event-id": "1" },
    });
    expect(sseBSpoof.statusCode).toBe(404);
    expect(store).toBeDefined();
    expect(coordinator).toBeDefined();
  });

  it("Scenario 7: Cross-tenant approval access is blocked fail-closed (MISMATCH) without consuming Tenant A's durable single-use approval", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-m41-apv-tenant-"));
    const dbPath = path.join(tmpDir, "state.db");
    const store = new SqliteStateStore({ location: dbPath });
    const clock = new SettableClock("2026-11-12T10:00:00.000Z");
    cleanups.push(() => {
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const ac = new ApprovalControl(clock, store);
    const enforcer = new CapabilityFenceEnforcer(clock);
    const gateway = new CrossHarnessGateway(enforcer, clock);
    const facade = new ProductionGovernanceFacade(enforcer, gateway, ac, clock);

    const fenceBase: Omit<CapabilityFence, "hash"> = {
      fenceId: "fence-tenant-a-1",
      subjectId: "agent-exec-1",
      roleId: "tester",
      harnessId: "IMPLEMENTATION_HARNESS",
      allowedCapabilities: ["READ_WORKSPACE", "EXECUTE_ANALYSIS"],
      forbiddenCapabilities: ["WRITE_REPOSITORY"],
      scope: {
        allowedWorkspacePaths: [tmpDir],
        forbiddenWorkspacePaths: [".git"],
        allowedTools: ["read_file", "run_command"],
        maxOperations: 100,
        maxMemoryBytes: 1_000_000,
        networkAllowed: false,
        gitWriteAllowed: false,
      },
      trustLabel: "GOVERNED_OBSERVATION",
      status: "ACTIVE",
      delegatedFenceIds: [],
      version: 1,
      missionContractId: "contract-alpha-apv-1",
      missionContractHash: "contract-hash-alpha-1",
      authoritative: false,
      terminalAuthority: false,
      sovereignAuthority: false,
      createdAt: "2026-11-12T09:55:00.000Z",
      expiresAt: "2026-11-12T12:00:00.000Z",
    };
    enforcer.registerFence({ ...fenceBase, hash: computeCapabilityFenceHash(fenceBase) });

    const req = ac.requestApproval({
      runId: "run-alpha-apv-1",
      taskId: "task-alpha-apv-1",
      tenantId: "tenant-alpha",
      contractHash: "contract-hash-alpha-1",
      operation: "run_command",
      parameters: { command: "npm run deploy --env=staging" },
      riskLevel: "HIGH",
      justification: "Tenant A approval binding test",
    });
    ac.approve(req.approvalId, "principal-alpha-op");

    // Cross-tenant attempt (with explicit approvalId) must fail closed and leave approval unconsumed
    const crossWithId = facade.evaluateProposal({
      runId: "run-alpha-apv-1",
      taskId: "task-alpha-apv-1",
      tenantId: "tenant-beta",
      approvalId: req.approvalId,
      subjectId: "agent-exec-1",
      fenceId: "fence-tenant-a-1",
      harnessType: "IMPLEMENTATION_HARNESS",
      capability: "EXECUTE_ANALYSIS",
      toolName: "run_command",
      input: { command: "npm run deploy --env=staging" },
      workspacePath: tmpDir,
      missionContractHash: "contract-hash-alpha-1",
    });
    expect(crossWithId.authorized).toBe(false);
    expect(crossWithId.approvalStatus).toBe("MISMATCH");
    expect(ac.getApproval(req.approvalId)?.status).toBe("APPROVED");

    // Cross-tenant attempt omitting approvalId (matching by run + operation) must ALSO fail closed
    const crossByRunOp = facade.evaluateProposal({
      runId: "run-alpha-apv-1",
      taskId: "task-alpha-apv-1",
      tenantId: "tenant-beta",
      subjectId: "agent-exec-1",
      fenceId: "fence-tenant-a-1",
      harnessType: "IMPLEMENTATION_HARNESS",
      capability: "EXECUTE_ANALYSIS",
      toolName: "run_command",
      input: { command: "npm run deploy --env=staging" },
      workspacePath: tmpDir,
      missionContractHash: "contract-hash-alpha-1",
    });
    expect(crossByRunOp.authorized).toBe(false);
    expect(crossByRunOp.approvalStatus).toBe("MISMATCH");
    expect(ac.getApproval(req.approvalId)?.status).toBe("APPROVED");

    // Same-tenant Tenant A execution succeeds and consumes single-use approval once
    const authorizedA = facade.evaluateProposal({
      runId: "run-alpha-apv-1",
      taskId: "task-alpha-apv-1",
      tenantId: "tenant-alpha",
      approvalId: req.approvalId,
      subjectId: "agent-exec-1",
      fenceId: "fence-tenant-a-1",
      harnessType: "IMPLEMENTATION_HARNESS",
      capability: "EXECUTE_ANALYSIS",
      toolName: "run_command",
      input: { command: "npm run deploy --env=staging" },
      workspacePath: tmpDir,
      missionContractHash: "contract-hash-alpha-1",
    });
    expect(authorizedA.authorized).toBe(true);
    expect(authorizedA.approvalStatus).toBe("APPROVED");
    expect(ac.getApproval(req.approvalId)?.status).toBe("CONSUMED");
  });
});
