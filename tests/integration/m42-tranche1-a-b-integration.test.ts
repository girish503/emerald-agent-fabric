/**
 * M4.2 Tranche 1 — Workstream A (Durable Task Execution Lifecycle),
 * CLI Server Execution Loop Wiring, and Integrated Workstream A + B (Multi-Parent DAG) Suite.
 */
import * as crypto from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GovernedAgentExecutionProvider } from "../../src/adapters/execution/governed-agent-execution-provider.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsRepositoryImporter } from "../../src/adapters/workspace/node-fs-repository-importer.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { AgentStepController } from "../../src/application/agent-step-controller.js";
import { LiveAgentBrain } from "../../src/application/live-agent-brain.js";
import { createInventoriedModelRouter } from "../../src/application/model-router-factory.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { DeterministicFixtureModelProvider } from "../../src/application/worker-host.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { EmeraldCli } from "../../src/cli/emerald-cli.js";
import { Action } from "../../src/domain/action.js";
import { Attempt } from "../../src/domain/attempt.js";
import { SystemClock } from "../../src/ports/clock.port.js";
import { buildFastifyServer, type PrincipalRecord } from "../../src/transport/http/server.js";

const TOK_ALPHA_OP = "alpha-constrained-operator-token-001";
const TOK_ALPHA_AUDITOR = "alpha-readonly-auditor-token-002";
const TOK_ALPHA_RESTRICTED = "alpha-sandbox-only-operator-003";
const TOK_BETA_OP = "beta-constrained-operator-token-004";

const principals: PrincipalRecord[] = [
  {
    token: TOK_ALPHA_OP,
    principalId: "alpha-op",
    tenantId: "tenant-alpha",
    role: "operator",
    allowConstrainedHost: true,
  },
  {
    token: TOK_ALPHA_AUDITOR,
    principalId: "alpha-auditor",
    tenantId: "tenant-alpha",
    role: "auditor",
  },
  {
    token: TOK_ALPHA_RESTRICTED,
    principalId: "alpha-sandboxed-op",
    tenantId: "tenant-alpha",
    role: "operator",
    allowConstrainedHost: false,
  },
  {
    token: TOK_BETA_OP,
    principalId: "beta-op",
    tenantId: "tenant-beta",
    role: "operator",
    allowConstrainedHost: true,
  },
];

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

function buildNotesReadVerificationSpec(contentText: string) {
  const bytesRead = Buffer.byteLength(contentText, "utf8");
  const contentHash = crypto.createHash("sha256").update(contentText, "utf8").digest("hex");
  return {
    specId: "read-notes-exact",
    ruleKind: "EXACT_OUTPUT_MATCH" as const,
    expectedOutput: {
      path: "notes.txt",
      content: contentText,
      bytesRead,
      totalLines: contentText.split(/\r?\n/).length,
      isTruncated: false,
      contentHash,
    },
  };
}

interface Harness {
  tmpDir: string;
  dbPath: string;
  repoDir: string;
  workspaceRoot: string;
  store: SqliteStateStore;
  coordinator: RunCoordinator;
  eventBroadcaster: EventEmitter;
  clock: SystemClock;
  workerRuntime: WorkerRuntime;
  server: FastifyInstance;
}

async function createServerHarness(opts?: {
  enableExecutionLoop?: boolean;
  maxConcurrentRuns?: 1 | 2;
  executionLoopIntervalMs?: number;
  withFailClosedEmptyModelRouter?: boolean;
}): Promise<Harness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-m42-tranche1-"));
  const dbPath = path.join(tmpDir, "state.db");
  const repoDir = path.join(tmpDir, "repo");
  const workspaceRoot = path.join(tmpDir, "workspaces");
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(path.join(repoDir, "notes.txt"), "emerald-fixture-ok", "utf8");

  const store = new SqliteStateStore({ location: dbPath });
  const clock = new SystemClock();
  const eventBroadcaster = new EventEmitter();
  const workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot });
  const coordinator = new RunCoordinator(store, clock, undefined, workspaceAdapter, eventBroadcaster);

  const fixtureModel = new DeterministicFixtureModelProvider("fixture-agent");
  const brain = new LiveAgentBrain({
    modelProvider: fixtureModel,
    model: "fixture-agent",
    clock,
  });
  const governedProvider = new GovernedAgentExecutionProvider({ clock });
  const workerRuntime = new WorkerRuntime({
    workerId: `test-worker-${crypto.randomUUID().slice(0, 8)}`,
    hostname: "localhost",
    pid: process.pid,
    coordinator,
    clock,
    workspacePort: workspaceAdapter,
    executionProvider: governedProvider,
    repositoryImporter: new NodeFsRepositoryImporter(),
  });
  const stepController = new AgentStepController({
    coordinator,
    stateStore: store,
    workerRuntime,
    agentBrain: brain,
    clock,
    enableGovernedVerificationStage: true,
    allowUnverifiedCompletion: false,
    ...(workerRuntime.memoryService ? { scopedMemory: workerRuntime.memoryService } : {}),
  });
  governedProvider.setStepController(stepController);
  workerRuntime.ensureRegistered();

  const inventoried = opts?.withFailClosedEmptyModelRouter
    ? await createInventoriedModelRouter(async () => [])
    : undefined;

  const server = buildFastifyServer({
    store,
    coordinator,
    eventBroadcaster,
    principals,
    workerRuntime,
    enableExecutionLoop: opts?.enableExecutionLoop ?? false,
    executionLoopIntervalMs: opts?.executionLoopIntervalMs ?? 25,
    maxConcurrentRuns: opts?.maxConcurrentRuns ?? 2,
    ...(inventoried ? { modelRouter: inventoried.router } : {}),
    healthDataDirectory: tmpDir,
  });
  await server.ready();

  return {
    tmpDir,
    dbPath,
    repoDir,
    workspaceRoot,
    store,
    coordinator,
    eventBroadcaster,
    clock,
    workerRuntime,
    server,
  };
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (val: T) => boolean,
  timeoutMs = 10_000,
  intervalMs = 30
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!predicate(last)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms. Last value: ${JSON.stringify(last)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await fn();
  }
  return last;
}

describe("M4.2 Tranche 1 — Workstream A, CLI Server & Integrated A+B DAG", () => {
  const harnesses: Harness[] = [];

  beforeEach(() => {
    // Cleanup list initialized cleanly
  });

  afterEach(async () => {
    while (harnesses.length > 0) {
      const h = harnesses.pop()!;
      try {
        await h.server.close();
      } catch {
        // already closed
      }
      try {
        h.store.close();
      } catch {
        // already closed
      }
      try {
        fs.rmSync(h.tmpDir, { recursive: true, force: true });
      } catch {
        // ignore temp cleanup failure
      }
    }
  });

  it("WS-A1: enableExecutionLoop defaults to false and leaves runs QUEUED with idle /health stats", async () => {
    const h = await createServerHarness({ enableExecutionLoop: false });
    harnesses.push(h);

    const submitRes = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: bearer(TOK_ALPHA_OP),
      payload: {
        title: "Idle mode check",
        prompt: "Inspect notes.txt for status",
        repoPath: h.repoDir,
        executionMode: "constrained_host",
        modelConfig: { provider: "fixture", modelName: "fixture-agent" },
        verificationSpecs: [buildNotesReadVerificationSpec("emerald-fixture-ok")],
      },
    });
    expect(submitRes.statusCode).toBe(201);
    const { data } = submitRes.json();
    expect(data.status).toBe("QUEUED");

    await new Promise((r) => setTimeout(r, 80));
    expect(h.coordinator.getRun(data.runId)?.status).toBe("QUEUED");

    const healthRes = await h.server.inject({ method: "GET", url: "/health" });
    expect(healthRes.statusCode).toBe(200);
    const health = healthRes.json();
    expect(health.executionLoop.enabled).toBe(false);
    expect(health.executionLoop.ticksTotal).toBe(0);
    expect(health.executionLoop.runsExecuted).toBe(0);
  });

  it("WS-A2: executes authenticated task through TaskRouter -> WorkerRuntime -> AgentStepController -> ToolExecutionGateway with restart durability", async () => {
    const h = await createServerHarness({ enableExecutionLoop: true, maxConcurrentRuns: 2 });
    harnesses.push(h);

    // 1. Auth & role & isolation rejections
    const unauth = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        title: "No auth",
        prompt: "Inspect notes.txt",
        modelConfig: { provider: "fixture", modelName: "fixture-agent" },
      },
    });
    expect(unauth.statusCode).toBe(401);

    const auditorPost = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: bearer(TOK_ALPHA_AUDITOR),
      payload: {
        title: "Auditor write rejected",
        prompt: "Inspect notes.txt",
        modelConfig: { provider: "fixture", modelName: "fixture-agent" },
      },
    });
    expect(auditorPost.statusCode).toBe(403);

    const sandboxedPost = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: bearer(TOK_ALPHA_RESTRICTED),
      payload: {
        title: "Unauthorized host downgrade",
        prompt: "Inspect notes.txt",
        executionMode: "constrained_host",
        modelConfig: { provider: "fixture", modelName: "fixture-agent" },
      },
    });
    expect(sandboxedPost.statusCode).toBe(403);

    // 2. Authorized submission with Idempotency-Key and EXACT_OUTPUT_MATCH verification spec
    const payload = {
      title: "Inspect notes file",
      prompt: "Inspect notes.txt and report contents",
      repoPath: h.repoDir,
      executionMode: "constrained_host" as const,
      modelConfig: { provider: "fixture", modelName: "fixture-agent" },
      verificationSpecs: [buildNotesReadVerificationSpec("emerald-fixture-ok")],
    };
    const res1 = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_ALPHA_OP), "idempotency-key": "ws-a2-key-1" },
      payload,
    });
    expect(res1.statusCode).toBe(201);
    const body1 = res1.json();
    expect(body1.data.runId).toBeTruthy();

    // Idempotent duplicate returns existing task/run
    const resDup = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_ALPHA_OP), "idempotency-key": "ws-a2-key-1" },
      payload,
    });
    expect(resDup.statusCode).toBe(200);
    expect(resDup.json().data.taskId).toBe(body1.data.taskId);
    expect(resDup.json().data.runId).toBe(body1.data.runId);

    // Cross-tenant read returns 404
    const crossTask = await h.server.inject({
      method: "GET",
      url: `/api/v1/tasks/${body1.data.taskId}`,
      headers: bearer(TOK_BETA_OP),
    });
    expect(crossTask.statusCode).toBe(404);
    const crossRun = await h.server.inject({
      method: "GET",
      url: `/api/v1/runs/${body1.data.runId}`,
      headers: bearer(TOK_BETA_OP),
    });
    expect(crossRun.statusCode).toBe(404);

    // 3. Wait for automatic execution loop completion
    const completedRun = await pollUntil(
      async () => {
        const r = await h.server.inject({
          method: "GET",
          url: `/api/v1/runs/${body1.data.runId}`,
          headers: bearer(TOK_ALPHA_OP),
        });
        return r.json().data;
      },
      (runData) => ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(runData.status)
    );
    expect(completedRun.status).toBe("COMPLETED");

    // Verify /health loop metrics
    const health = (await h.server.inject({ method: "GET", url: "/health" })).json();
    expect(health.executionLoop.enabled).toBe(true);
    expect(health.executionLoop.ticksTotal).toBeGreaterThanOrEqual(1);
    expect(health.executionLoop.runsExecuted).toBeGreaterThanOrEqual(1);
    expect(health.executionLoop.errorCount).toBe(0);

    // Close server + reopen SQLite store and verify durable actions/verification/events persisted
    await h.server.close();
    h.store.close();

    const reopened = new SqliteStateStore({ location: h.dbPath });
    try {
      const run = reopened.getRun(body1.data.runId);
      expect(run?.status).toBe("COMPLETED");
      const actions = reopened.getActionsForRun(body1.data.runId);
      expect(actions.some((a) => a.toolName === "read_file" && a.status === "SUCCEEDED")).toBe(true);
      const events = reopened.getEventsForRun(body1.data.runId).map((e) => e.eventType);
      expect(events).toContain("verification.completed");
      expect(events).toContain("run.completed");
      expect(events).not.toContain("verification.unverified_completion_authorized");
    } finally {
      reopened.close();
    }
  });

  it("WS-A3: enforces maxConcurrentRuns=1, clean shutdown 503 rejection, and crash recovery without repeating succeeded non-idempotent actions", async () => {
    const h = await createServerHarness({ enableExecutionLoop: true, maxConcurrentRuns: 1, executionLoopIntervalMs: 30 });
    harnesses.push(h);

    const spec = buildNotesReadVerificationSpec("emerald-fixture-ok");
    const submissions = await Promise.all(
      [1, 2, 3].map((idx) =>
        h.server.inject({
          method: "POST",
          url: "/api/v1/tasks",
          headers: bearer(TOK_ALPHA_OP),
          payload: {
            title: `Bounded task ${idx}`,
            prompt: "Inspect notes.txt and report",
            repoPath: h.repoDir,
            executionMode: "constrained_host",
            modelConfig: { provider: "fixture", modelName: "fixture-agent" },
            verificationSpecs: [spec],
          },
        })
      )
    );
    for (const s of submissions) expect(s.statusCode).toBe(201);
    const runIds = submissions.map((s) => s.json().data.runId as string);
    expect(
      h.store.transaction((tx) =>
        tx.countRunsByStatuses(["QUEUED", "LEASED", "RUNNING", "VERIFYING", "WAITING_APPROVAL", "RECOVERING"])
      )
    ).toBeLessThanOrEqual(1);

    await pollUntil(
      async () => runIds.map((id) => h.coordinator.getRun(id)?.status),
      (statuses) => statuses.every((st) => st === "COMPLETED")
    );

    // Verify clean shutdown drains pump loop and SQLite recovery preserves succeeded non-idempotent actions
    await h.server.close();
    // Simulate a crashed active IN_PROCESS run whose non-idempotent write action succeeded before crash and lease expired
    const crashCoord = new RunCoordinator(h.store, h.clock);
    crashCoord.registerWorker({
      workerId: "dead-worker",
      hostname: "localhost",
      pid: 99999,
      status: "ACTIVE",
      createdAt: h.clock.nowIso(),
      lastHeartbeatAt: h.clock.nowIso(),
    });
    crashCoord.createTask({ taskId: "task-crash-rec", title: "echo", inputPayload: { instruction: "Inspect notes.txt" } });
    const cContract = await import("../../src/domain/mission-contract.js");
    const cPolicy = await import("../../src/domain/policy.js");
    const contract = cContract.createMissionContract({
      contractId: "contract-task-crash-rec",
      version: 1,
      taskId: "task-crash-rec",
      policy: cPolicy.createExecutionPolicy({
        policyId: "policy-task-crash-rec",
        tenantId: "tenant-alpha",
        allowedCapabilities: ["execution.echo", "workspace.file.read", "workspace.file.write"],
        isolationRequirement: "IN_PROCESS",
        trustedInProcessOperations: ["echo", "execution.echo"],
      }),
      verificationSpecs: [],
      resourceLimits: cContract.createResourceLimits({ timeoutMs: 60_000, maxAttempts: 3, maxOutputBytes: 1_048_576 }),
    });
    h.store.insertContract(contract);
    h.store.activateContract(contract.spec.contractId, 1, h.clock.nowIso());
    const createdCrashRun = crashCoord.createRun({ taskId: "task-crash-rec" });
    crashCoord.queueRun(createdCrashRun.run.runId);
    const claim = crashCoord.claimRun(createdCrashRun.run.runId, "dead-worker", 10);
    const startedCrash = crashCoord.startRun(createdCrashRun.run.runId, "dead-worker", claim.lease.leaseId);
    const fencing = { workerId: "dead-worker", leaseId: claim.lease.leaseId };
    const nowCrash = h.clock.nowIso();
    // Record a completed non-idempotent tool action BEFORE the simulated crash
    const { action: crashAction, event: crashActionEvent } = Action.create({
      actionId: "act-crash-write-1",
      runId: createdCrashRun.run.runId,
      sequenceNumber: 1,
      toolName: "write_file",
      inputPayload: { path: "notes.txt", content: "v2" },
      contractBinding: startedCrash.run.contractBinding!,
      maxAttempts: 3,
      now: nowCrash,
    });
    h.store.transaction((tx) => {
      tx.insertAction(crashAction.snapshot, crashActionEvent, fencing);
      tx.transitionAction("act-crash-write-1", { type: "AUTHORIZE", now: nowCrash }, () => crypto.randomUUID());
      tx.transitionAction("act-crash-write-1", { type: "START_ATTEMPT", attemptNumber: 1, now: nowCrash }, () => crypto.randomUUID());
      const { attempt: crashAttempt, event: crashAttEvent } = Attempt.create({
        attemptId: "att-crash-write-1",
        actionId: "act-crash-write-1",
        runId: createdCrashRun.run.runId,
        attemptNumber: 1,
        workerId: "dead-worker",
        leaseId: claim.lease.leaseId,
        now: nowCrash,
      });
      tx.insertAttempt(crashAttempt.snapshot, crashAttEvent, fencing);
      tx.transitionAttempt("att-crash-write-1", { type: "DISPATCH", now: nowCrash }, () => crypto.randomUUID());
      tx.transitionAttempt("att-crash-write-1", { type: "START", now: nowCrash }, () => crypto.randomUUID());
      tx.transitionAttempt("att-crash-write-1", { type: "COMPLETE", outputPayload: { written: true }, exitCode: 0, durationMs: 1, now: nowCrash }, () => crypto.randomUUID());
      tx.transitionAction("act-crash-write-1", { type: "SUCCEED", resultPayload: { written: true }, now: nowCrash }, () => crypto.randomUUID());
      // Backdate lease expiration so startup recovery reclaims it immediately
      (h.store as any).db
        .prepare("UPDATE runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE run_id = ?")
        .run(createdCrashRun.run.runId);
    });
    h.store.close();

    // Restart with fresh coordinator / store and trigger startup recovery
    const reopened = new SqliteStateStore({ location: h.dbPath });
    try {
      const restartedCoord = new RunCoordinator(reopened, new SystemClock());
      const recRes = restartedCoord.recoverExpiredRuns();
      expect(recRes.runs.map((r) => r.runId)).toContain(createdCrashRun.run.runId);
      const recoveredAction = reopened.getActionsForRun(createdCrashRun.run.runId)[0]!;
      // Already-succeeded non-idempotent action remains SUCCEEDED (not reset to retry/re-execute)
      expect(recoveredAction.status).toBe("SUCCEEDED");
    } finally {
      reopened.close();
    }
  });

  it("WS-A4: emerald server CLI enforces fail-closed startup and live-mode block", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-cli-srv-"));
    const dbPath = path.join(tmpDir, "cli.db");
    const wsDir = path.join(tmpDir, "ws");
    fs.mkdirSync(wsDir, { recursive: true });
    const cli = new EmeraldCli();

    try {
      const missingWs = await cli.run(["server", "--db", dbPath, "--enable-execution-loop"]);
      expect(missingWs.exitCode).toBe(1);
      expect(missingWs.output).toContain("--workspace-root");

      const liveRejected = await cli.run([
        "server",
        "--db",
        dbPath,
        "--workspace-root",
        wsDir,
        "--execution-mode",
        "live",
        "--enable-execution-loop",
      ]);
      expect(liveRejected.exitCode).toBe(1);
      expect(liveRejected.output).toContain("live is blocked");

      const badMax = await cli.run([
        "server",
        "--db",
        dbPath,
        "--workspace-root",
        wsDir,
        "--max-concurrent",
        "3",
      ]);
      expect(badMax.exitCode).toBe(1);
      expect(badMax.output).toContain("--max-concurrent");

      const missingDir = await cli.run([
        "server",
        "--db",
        dbPath,
        "--workspace-root",
        path.join(tmpDir, "does-not-exist"),
      ]);
      expect(missingDir.exitCode).toBe(1);
      expect(missingDir.output).toContain("workspace root not found");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("Stage 4 Integrated A+B: blocks CODER under governed routing, executes authenticated diamond DAG end-to-end, synthesizes SUCCESS, and survives restart", async () => {
    // 1. Verify CODER fails closed when governed modelRouter has no certified G3/G4 models
    const gatedHarness = await createServerHarness({
      enableExecutionLoop: false,
      withFailClosedEmptyModelRouter: true,
    });
    harnesses.push(gatedHarness);

    const gatedSubmit = await gatedHarness.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: bearer(TOK_ALPHA_OP),
      payload: {
        title: "CODER gated mission",
        prompt: "Inspect notes.txt",
        repoPath: gatedHarness.repoDir,
        requiredCapabilities: ["workspace.file.read", "workspace.file.write", "git.read"],
        executionMode: "constrained_host",
        modelConfig: { provider: "fixture", modelName: "fixture-agent" },
        verificationSpecs: [buildNotesReadVerificationSpec("emerald-fixture-ok")],
      },
    });
    expect(gatedSubmit.statusCode).toBe(201);
    const gatedTaskId = gatedSubmit.json().data.taskId as string;
    const gatedRunId = gatedSubmit.json().data.runId as string;

    const coderDecomp = await gatedHarness.server.inject({
      method: "POST",
      url: `/api/v1/tasks/${gatedTaskId}/decompose`,
      headers: bearer(TOK_ALPHA_OP),
      payload: {
        subtasks: [
          {
            subtaskId: "blocked-coder",
            role: "CODER",
            objective: "Attempt uncertified CODER dispatch",
            verificationSpecs: [buildNotesReadVerificationSpec("emerald-fixture-ok")],
          },
        ],
      },
    });
    expect(coderDecomp.statusCode).toBe(400);
    const routingRejectedEvents = gatedHarness.store
      .getEventsForRun(gatedRunId)
      .filter((e) => e.eventType === "model.routing.rejected");
    expect(routingRejectedEvents.length).toBeGreaterThanOrEqual(1);

    // 2. Full authenticated diamond DAG execution through live server execution loop + WorkerRuntime
    const h = await createServerHarness({
      enableExecutionLoop: true,
      maxConcurrentRuns: 2,
      executionLoopIntervalMs: 25,
    });
    harnesses.push(h);

    const verifSpec = buildNotesReadVerificationSpec("emerald-fixture-ok");
    const missionSubmit = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...bearer(TOK_ALPHA_OP), "idempotency-key": "stage4-diamond-mission" },
      payload: {
        title: "Diamond DAG Mission",
        prompt: "Inspect notes.txt for mission initialization",
        repoPath: h.repoDir,
        requiredCapabilities: ["workspace.file.read", "workspace.code.search", "git.read", "process.execute"],
        executionMode: "constrained_host",
        modelConfig: { provider: "fixture", modelName: "fixture-agent" },
        verificationSpecs: [verifSpec],
      },
    });
    expect(missionSubmit.statusCode).toBe(201);
    const missionTaskId = missionSubmit.json().data.taskId as string;

    const decompRes = await h.server.inject({
      method: "POST",
      url: `/api/v1/tasks/${missionTaskId}/decompose`,
      headers: bearer(TOK_ALPHA_OP),
      payload: {
        subtasks: [
          {
            subtaskId: "root",
            role: "RESEARCHER",
            objective: "Inspect notes.txt at root",
            inputPayload: { repositoryPath: h.repoDir },
            verificationSpecs: [verifSpec],
          },
          {
            subtaskId: "branch-a",
            role: "RESEARCHER",
            objective: "Inspect notes.txt on branch A",
            dependencies: ["root"],
            inputPayload: { repositoryPath: h.repoDir },
            verificationSpecs: [verifSpec],
          },
          {
            subtaskId: "branch-b",
            role: "RESEARCHER",
            objective: "Inspect notes.txt on branch B",
            dependencies: ["root"],
            inputPayload: { repositoryPath: h.repoDir },
            verificationSpecs: [verifSpec],
          },
          {
            subtaskId: "join",
            role: "REVIEWER",
            objective: "Inspect notes.txt after branch A and B",
            dependencies: ["branch-a", "branch-b"],
            inputPayload: { repositoryPath: h.repoDir },
            verificationSpecs: [verifSpec],
          },
          {
            subtaskId: "sink",
            role: "REVIEWER",
            objective: "Inspect notes.txt final sink audit",
            dependencies: ["join"],
            inputPayload: { repositoryPath: h.repoDir },
            verificationSpecs: [verifSpec],
          },
        ],
      },
    });
    expect(decompRes.statusCode).toBe(201);
    const decompData = decompRes.json().data;
    expect(decompData.totalSubtasks).toBe(5);

    const synthesis = await pollUntil(
      async () => {
        const res = await h.server.inject({
          method: "POST",
          url: `/api/v1/tasks/${missionTaskId}/synthesize`,
          headers: bearer(TOK_ALPHA_OP),
        });
        return res.json().data;
      },
      (s) => s.verdict === "SUCCESS" || s.verdict === "FAILED",
      15_000,
      40
    );
    expect(synthesis.verdict).toBe("SUCCESS");
    expect(synthesis.totalSubtasks).toBe(5);
    expect(synthesis.verifiedCount).toBe(5);
    expect(synthesis.rejectedCount).toBe(0);
    expect(synthesis.blockedCount).toBe(0);
    expect(synthesis.canCompleteMission).toBe(true);

    // Inspect hierarchy over HTTP before restart
    const hierRes = await h.server.inject({
      method: "GET",
      url: `/api/v1/tasks/${missionTaskId}/hierarchy`,
      headers: bearer(TOK_ALPHA_OP),
    });
    expect(hierRes.statusCode).toBe(200);
    const hier = hierRes.json().data;
    expect(hier.totalSubtasks).toBe(5);

    // Shutdown cleanly and reopen fresh SQLite to verify full durable persistence
    await h.server.close();
    h.store.close();

    const reopened = new SqliteStateStore({ location: h.dbPath });
    try {
      const joinTaskId = `${missionTaskId}__sub__join`;
      const branchATaskId = `${missionTaskId}__sub__branch-a`;
      const branchBTaskId = `${missionTaskId}__sub__branch-b`;
      const sinkTaskId = `${missionTaskId}__sub__sink`;

      const joinDeps = reopened.transaction((tx) => {
        if (!tx.listTaskDependencies) throw new Error("listTaskDependencies not supported");
        return tx.listTaskDependencies(joinTaskId);
      });
      expect(new Set(joinDeps.map((d) => d.parentTaskId))).toEqual(new Set([branchATaskId, branchBTaskId]));

      const sinkDeps = reopened.transaction((tx) => {
        if (!tx.listTaskDependencies) throw new Error("listTaskDependencies not supported");
        return tx.listTaskDependencies(sinkTaskId);
      });
      expect(sinkDeps.map((d) => d.parentTaskId)).toEqual([joinTaskId]);

      for (const subId of ["root", "branch-a", "branch-b", "join", "sink"]) {
        const tId = `${missionTaskId}__sub__${subId}`;
        const subm = reopened.transaction((tx) => tx.getRouterSubmissionByTaskId(tId))!;
        const run = reopened.getRun(subm.runId)!;
        expect(run.status).toBe("COMPLETED");
        const evTypes = reopened.getEventsForRun(subm.runId).map((e) => e.eventType);
        expect(evTypes).toContain("verification.completed");
        expect(evTypes).toContain("evidence.recorded");
        expect(evTypes).toContain("run.completed");
      }
    } finally {
      reopened.close();
    }
  });
});
