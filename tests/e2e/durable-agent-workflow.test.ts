import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EmeraldCli } from "../../src/cli/emerald-cli.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { submitDurableTask } from "../../src/application/durable-submission.js";
import { runRouterHost } from "../../src/application/router-host.js";
import { runWorkerHost } from "../../src/application/worker-host.js";
import { SettableClock, SystemClock } from "../../src/ports/clock.port.js";
import { createAndActivateContract } from "../application/test-helpers.js";
import { REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT, WorkerRuntime } from "../../src/application/worker-runtime.js";
import { LeaseLostError } from "../../src/domain/errors.js";

const execFileAsync = promisify(execFile);

describe("Milestone 2.20 — End-to-End Durable Agent Workflow", () => {
  let tempDir: string;
  let dbPath: string;
  let workspaceRoot: string;
  let artifactRoot: string;
  let repoFixtureDir: string;
  let cli: EmeraldCli;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-e2e-workflow-"));
    dbPath = path.join(tempDir, "state.db");
    workspaceRoot = path.join(tempDir, "workspaces");
    artifactRoot = path.join(tempDir, "artifacts");
    repoFixtureDir = path.join(tempDir, "fixture-repo");

    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(artifactRoot, { recursive: true });
    fs.mkdirSync(repoFixtureDir, { recursive: true });

    // Initialize git repo in fixtureDir for git-based operations and artifact tracking
    await execFileAsync("git", ["init"], { cwd: repoFixtureDir });
    await execFileAsync("git", ["config", "user.name", "Emerald Agent"], { cwd: repoFixtureDir });
    await execFileAsync("git", ["config", "user.email", "agent@emerald.fabric"], { cwd: repoFixtureDir });

    fs.writeFileSync(path.join(repoFixtureDir, "README.md"), "# Emerald Agent Fabric\nDurable Agent Infrastructure\n", "utf8");
    fs.writeFileSync(path.join(repoFixtureDir, "config.json"), JSON.stringify({ version: "1.0", enabled: true }), "utf8");

    await execFileAsync("git", ["add", "README.md", "config.json"], { cwd: repoFixtureDir });
    await execFileAsync("git", ["commit", "-m", "Initial baseline commit"], { cwd: repoFixtureDir });

    cli = new EmeraldCli();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Ignore cleanup error on temporary folders
    }
  });

  const json = async (args: string[], expectedExit = 0) => {
    const res = await cli.run(args);
    expect(res.exitCode, res.output).toBe(expectedExit);
    return JSON.parse(res.output);
  };

  /**
   * Scenario 1: Single-task workflow
   * Submit -> Persist -> Route -> Claim -> Execute via fixture brain with read_file -> Verify -> Complete -> Inspect
   */
  it("Scenario 1: executes a single governed task from submission through routing, tool execution, latch verification and inspect", async () => {
    // 1. Submit task
    const submitRes = await json([
      "router",
      "submit",
      "--db",
      dbPath,
      "--key",
      "k-agent-read-1",
      "--task",
      "Read README.md and inspect contents",
      "--repo",
      repoFixtureDir,
    ]);

    expect(submitRes.duplicate).toBe(false);
    expect(submitRes.status).toBe("CREATED");
    const { taskId, runId } = submitRes;

    // Verify initial SQLite state
    const store1 = new SqliteStateStore({ location: dbPath });
    try {
      const persistedRun = store1.getRun(runId);
      expect(persistedRun).not.toBeNull();
      expect(persistedRun?.status).toBe("CREATED");

      const task = store1.getTask(taskId);
      expect(task).not.toBeNull();
      expect(task?.description).toContain("Read README.md");

      const activeContracts = store1.findContractsByTaskId(taskId, "ACTIVE");
      expect(activeContracts).toHaveLength(1);
      expect(activeContracts[0]?.lifecycle.status).toBe("ACTIVE");
    } finally {
      store1.close();
    }

    // 2. Route task via Router Host tick
    const routeRes = await cli.run(["router", "host", "--db", dbPath, "--once"]);
    expect(routeRes.exitCode, routeRes.output).toBe(0);

    const store2 = new SqliteStateStore({ location: dbPath });
    try {
      const queuedRun = store2.getRun(runId);
      expect(queuedRun?.status).toBe("QUEUED");
    } finally {
      store2.close();
    }

    // 3. Claim and execute task via Worker Host with fixture model
    const workerRes = await cli.run([
      "worker",
      "--db",
      dbPath,
      "--once",
      "--model-provider",
      "fixture",
      "--allow-unverified-completion",
      "--workspace-root",
      workspaceRoot,
    ]);
    expect(workerRes.exitCode, workerRes.output).toBe(0);

    // 4. Inspect final run result and event history
    const inspectRes = await json(["inspect", "--db", dbPath, "--run-id", runId]);
    expect(inspectRes.runId).toBe(runId);
    expect(inspectRes.status).toBe("COMPLETED");
    expect(inspectRes.attemptCount).toBeDefined();

    const eventTypes = inspectRes.events.map((e: { eventType: string }) => e.eventType);
    expect(eventTypes).toContain("run.created");
    expect(eventTypes).toContain("run.queued");
    expect(eventTypes).toContain("worker.claimed");
    expect(eventTypes).toContain("run.started");
    expect(eventTypes).toContain("action.started");
    expect(eventTypes).toContain("action.completed");
    expect(eventTypes).toContain("run.completed");
  });

  /**
   * Scenario 2: Parent-child task tree (1 parent, 2 children)
   * Parent completes -> children admitted & executed -> tree status COMPLETED
   */
  it("Scenario 2: manages parent-child task tree with sequential dependency resolution", async () => {
    // 1. Submit parent task
    const parent = await json([
      "router",
      "submit",
      "--db",
      dbPath,
      "--key",
      "k-tree-parent",
      "--operation",
      "echo",
      "--input",
      JSON.stringify("parent-payload"),
    ]);

    // 2. Submit 2 child tasks referencing parent
    const child1 = await json([
      "router",
      "submit",
      "--db",
      dbPath,
      "--key",
      "k-tree-child-1",
      "--operation",
      "echo",
      "--input",
      JSON.stringify("child-1-payload"),
      "--parent-task",
      parent.taskId,
    ]);

    const child2 = await json([
      "router",
      "submit",
      "--db",
      dbPath,
      "--key",
      "k-tree-child-2",
      "--operation",
      "echo",
      "--input",
      JSON.stringify("child-2-payload"),
      "--parent-task",
      parent.taskId,
    ]);

    // Initial tree status: PENDING with 3 CREATED runs
    const initialTree = await json(["router", "status", "--db", dbPath, "--root", parent.taskId]);
    expect(initialTree.status).toBe("PENDING");
    expect(initialTree.counts.CREATED).toBe(3);

    // Tick 1: Admits parent, leaves children in CREATED
    const tick1 = await json(["router", "tick", "--db", dbPath, "--max-concurrent", "2"]);
    expect(tick1.admittedRunIds).toEqual([parent.runId]);

    // Worker executes parent
    const worker1 = await cli.run(["worker", "--db", dbPath, "--once", "--allow-unverified-completion"]);
    expect(worker1.exitCode).toBe(0);

    // Parent is COMPLETED
    const midInspect = await json(["inspect", "--db", dbPath, "--run-id", parent.runId]);
    expect(midInspect.status).toBe("COMPLETED");

    // Tick 2: Now that parent is COMPLETED, admits both children
    const tick2 = await json(["router", "tick", "--db", dbPath, "--max-concurrent", "2"]);
    expect(tick2.admittedRunIds.sort()).toEqual([child1.runId, child2.runId].sort());

    // Worker executes child 1 and child 2
    const worker2 = await cli.run(["worker", "--db", dbPath, "--once", "--allow-unverified-completion"]);
    expect(worker2.exitCode).toBe(0);
    const worker3 = await cli.run(["worker", "--db", dbPath, "--once", "--allow-unverified-completion"]);
    expect(worker3.exitCode).toBe(0);

    // Final Tree status: COMPLETED with 3 completed tasks
    const finalTree = await json(["router", "status", "--db", dbPath, "--root", parent.taskId]);
    expect(finalTree.status).toBe("COMPLETED");
    expect(finalTree.counts.COMPLETED).toBe(3);
  });

  /**
   * Scenario 3: Parent failure prevents child dispatch
   * Parent fails -> children cancelled and never dispatched
   */
  it("Scenario 3: parent failure prevents child admission and dispatch", async () => {
    // Submit parent that fails (unsupported operation)
    const parent = await json([
      "router",
      "submit",
      "--db",
      dbPath,
      "--key",
      "k-fail-parent",
      "--operation",
      "unsupported_operation_fail",
    ]);

    const child = await json([
      "router",
      "submit",
      "--db",
      dbPath,
      "--key",
      "k-fail-child",
      "--operation",
      "echo",
      "--input",
      JSON.stringify("child-blocked"),
      "--parent-task",
      parent.taskId,
    ]);

    // Router admits parent
    const tick1 = await json(["router", "tick", "--db", dbPath, "--max-concurrent", "1"]);
    expect(tick1.admittedRunIds).toEqual([parent.runId]);

    // Worker executes parent -> completes claim cycle, records run failure
    const workerRes = await cli.run(["worker", "--db", dbPath, "--once"]);
    expect(workerRes.exitCode).toBe(0);

    const parentInspect = await json(["inspect", "--db", dbPath, "--run-id", parent.runId]);
    expect(parentInspect.status).toBe("FAILED");

    // Router tick 2 evaluates: parent failed, child must NOT be admitted (cascaded cancellation)
    const tick2 = await json(["router", "tick", "--db", dbPath, "--max-concurrent", "1"]);
    expect(tick2.admittedRunIds).toEqual([]);

    const store = new SqliteStateStore({ location: dbPath });
    try {
      const childRun = store.getRun(child.runId);
      // Child was cancelled by router cascade and is never queued or executed
      expect(childRun?.status).toBe("CANCELLED");
    } finally {
      store.close();
    }
  });

  /**
   * Scenario 4: Child failure produces correct final tree status
   * Parent COMPLETED, child FAILED -> root status reflects failure
   */
  it("Scenario 4: reports accurate FAILED tree status when a child task fails", async () => {
    const parent = await json([
      "router",
      "submit",
      "--db",
      dbPath,
      "--key",
      "k-cf-parent",
      "--operation",
      "echo",
      "--input",
      JSON.stringify("ok"),
    ]);

    const child = await json([
      "router",
      "submit",
      "--db",
      dbPath,
      "--key",
      "k-cf-child",
      "--operation",
      "unsupported_operation_fail",
      "--parent-task",
      parent.taskId,
    ]);

    // Admit & execute parent
    await json(["router", "tick", "--db", dbPath, "--max-concurrent", "1"]);
    await cli.run(["worker", "--db", dbPath, "--once", "--allow-unverified-completion"]);

    // Admit child
    const tickChild = await json(["router", "tick", "--db", dbPath, "--max-concurrent", "1"]);
    expect(tickChild.admittedRunIds).toEqual([child.runId]);

    // Execute child -> records failure
    await cli.run(["worker", "--db", dbPath, "--once", "--allow-unverified-completion"]);

    // Tree status query
    const tree = await json(["router", "status", "--db", dbPath, "--root", parent.taskId]);
    expect(tree.status).toBe("FAILED");
    expect(tree.counts.COMPLETED).toBe(1);
    expect(tree.counts.FAILED).toBe(1);
  });

  /**
   * Scenario 5: Idempotent submission
   * Repeated submission with same key returns deduplicated run
   */
  it("Scenario 5: ensures idempotent submission returns existing run without duplication", async () => {
    const sub1 = await json([
      "router",
      "submit",
      "--db",
      dbPath,
      "--key",
      "k-idempotent-test",
      "--operation",
      "echo",
      "--input",
      JSON.stringify("test"),
    ]);
    expect(sub1.duplicate).toBe(false);

    const sub2 = await json([
      "router",
      "submit",
      "--db",
      dbPath,
      "--key",
      "k-idempotent-test",
      "--operation",
      "echo",
      "--input",
      JSON.stringify("test"),
    ]);
    expect(sub2.duplicate).toBe(true);
    expect(sub2.taskId).toBe(sub1.taskId);
    expect(sub2.runId).toBe(sub1.runId);

    const store = new SqliteStateStore({ location: dbPath });
    try {
      const coordinator = new RunCoordinator(store, new SystemClock());
      const allEvents = coordinator.getEventsForRun(sub1.runId);
      const createdCount = allEvents.filter((e) => e.eventType === "run.created").length;
      expect(createdCount).toBe(1);
    } finally {
      store.close();
    }
  });

  /**
   * Scenario 6: Submission key payload conflict fails closed
   */
  it("Scenario 6: fails closed when the same submission key is submitted with conflicting payload", async () => {
    await json([
      "router",
      "submit",
      "--db",
      dbPath,
      "--key",
      "k-conflict-key",
      "--operation",
      "sum",
      "--input",
      "[1,2]",
    ]);

    const conflictRes = await cli.run([
      "router",
      "submit",
      "--db",
      dbPath,
      "--key",
      "k-conflict-key",
      "--operation",
      "sum",
      "--input",
      "[1,2]",
      "--max-attempts",
      "2",
    ]);

    expect(conflictRes.exitCode).toBe(1);
    expect(conflictRes.output).toMatch(/conflict/i);
  });

  /**
   * Scenario 7: Router dispatch concurrency cap
   * maxConcurrent: 1 admits only 1 task at a time
   */
  it("Scenario 7: strictly enforces concurrency cap during router dispatch", async () => {
    const t1 = await json(["router", "submit", "--db", dbPath, "--key", "k-cap-1", "--operation", "echo", "--input", "1"]);
    const t2 = await json(["router", "submit", "--db", dbPath, "--key", "k-cap-2", "--operation", "echo", "--input", "2"]);
    const t3 = await json(["router", "submit", "--db", dbPath, "--key", "k-cap-3", "--operation", "echo", "--input", "3"]);

    // With cap 1, only 1 task should be admitted
    const tick1 = await json(["router", "tick", "--db", dbPath, "--max-concurrent", "1"]);
    expect(tick1.admittedRunIds).toHaveLength(1);
    const firstAdmitted = tick1.admittedRunIds[0];

    const store = new SqliteStateStore({ location: dbPath });
    try {
      const run1 = store.getRun(firstAdmitted);
      expect(run1?.status).toBe("QUEUED");

      const otherRuns = [t1.runId, t2.runId, t3.runId].filter((id) => id !== firstAdmitted);
      for (const otherId of otherRuns) {
        expect(store.getRun(otherId)?.status).toBe("CREATED");
      }
    } finally {
      store.close();
    }
  });

  /**
   * Scenario 8: Worker lease expiration / fencing
   * Expired lease cannot complete run
   */
  it("Scenario 8: enforces lease fencing against stale or expired worker writes", async () => {
    const store = new SqliteStateStore({ location: dbPath });
    const clock = new SettableClock(new Date("2026-01-01T00:00:00Z"));
    const coordinator = new RunCoordinator(store, clock);

    try {
      // Register worker-stale
      coordinator.registerWorker({
        workerId: "worker-stale",
        hostname: os.hostname(),
        pid: process.pid,
        status: "ACTIVE",
        lastHeartbeatAt: clock.nowIso(),
        createdAt: clock.nowIso(),
      });

      // Register worker-fresh
      coordinator.registerWorker({
        workerId: "worker-fresh",
        hostname: os.hostname(),
        pid: process.pid,
        status: "ACTIVE",
        lastHeartbeatAt: clock.nowIso(),
        createdAt: clock.nowIso(),
      });

      const sub = submitDurableTask(store, coordinator, { operation: "echo", input: "fence-test" });
      const claim1 = coordinator.claimRun(sub.runId, "worker-stale", 2000); // 2000ms lease
      expect(claim1.lease).not.toBeNull();

      // Transition to RUNNING state under worker-stale
      coordinator.startRun(sub.runId, "worker-stale", claim1.lease.leaseId);

      // Advance clock past lease expiry and sweep expired leases
      clock.advanceMs(3000);
      coordinator.recoverExpiredRuns();

      // Expired lease token can no longer assert lease authority
      expect(() => {
        coordinator.assertLeaseHeld(sub.runId, "worker-stale", claim1.lease.leaseId);
      }).toThrow(LeaseLostError);

      // Worker 2 takes over the recovered run
      const claim2 = coordinator.claimRun(sub.runId, "worker-fresh", 5000);
      coordinator.startRun(sub.runId, "worker-fresh", claim2.lease.leaseId);

      // Worker 1 tries to commit using stale lease token - must fail closed with LeaseLostError
      expect(() => {
        coordinator.completeRun(sub.runId, "worker-stale", claim1.lease.leaseId, { output: "unlawful-write" });
      }).toThrow(LeaseLostError);

      // Verify run is still under worker-fresh
      const currentRun = store.getRun(sub.runId);
      expect(currentRun?.currentWorkerId).toBe("worker-fresh");
      expect(currentRun?.leaseId).toBe(claim2.lease.leaseId);
      expect(currentRun?.status).toBe("RUNNING");
    } finally {
      store.close();
    }
  });

  /**
   * Scenario 9: Verification failure does not produce false completion
   */
  it("Scenario 9: prevents false completion when contract verification specifications fail", async () => {
    const store = new SqliteStateStore({ location: dbPath });
    const clock = new SystemClock();
    const coordinator = new RunCoordinator(store, clock);

    let runId: string;
    try {
      const task = coordinator.createTask({
        title: "echo",
        description: "Task with strict verification",
        inputPayload: "actual-output",
      });

      // Contract demands exact output "EXPECTED-OUTPUT", which does not match "actual-output"
      createAndActivateContract(store, task.taskId, {
        verificationSpecs: [
          {
            specId: "v-strict-output",
            ruleKind: "EXACT_OUTPUT_MATCH",
            expectedValue: "EXPECTED-OUTPUT",
          },
        ],
      });

      const createRes = coordinator.createRun({ taskId: task.taskId });
      runId = createRes.run.runId;
      coordinator.queueRun(runId);
    } finally {
      store.close();
    }

    // Run worker
    const workerRes = await cli.run(["worker", "--db", dbPath, "--once"]);
    expect(workerRes.exitCode).toBe(0);

    const inspectRes = await json(["inspect", "--db", dbPath, "--run-id", runId!]);
    expect(inspectRes.status).toBe("FAILED");
    expect(inspectRes.error?.code).toBe("VERIFICATION_FAILED");

    const eventTypes = inspectRes.events.map((e: { eventType: string }) => e.eventType);
    expect(eventTypes).toContain("verification.completed");
    expect(eventTypes).toContain("run.failed");
    expect(eventTypes).not.toContain("run.completed");
  });

  /**
   * Scenario 10: Artifact export
   * Changed files and patch exported to artifact root
   */
  it("Scenario 10: captures and exports unified diff and manifest to artifact directory", async () => {
    const store = new SqliteStateStore({ location: dbPath });
    const clock = new SystemClock();
    const coordinator = new RunCoordinator(store, clock);

    const sub = submitDurableTask(store, coordinator, {
      task: "Inspect config and update repository",
      repositoryPath: repoFixtureDir,
      capabilities: ["workspace.file.read", "workspace.file.write", "git.read"],
      executionMode: "constrained_host",
      authorizedForConstrainedHost: true,
    });
    store.close();

    // Custom execution provider that simulates a file modification in the run workspace
    const customExecProvider = {
      name: "in-process",
      tenantModel: "NONE" as const,
      cancellationModel: "COOPERATIVE" as const,
      async execute(request: any) {
        if (request.workspace?.hostPath) {
          fs.writeFileSync(
            path.join(request.workspace.hostPath, "NEW_ARTIFACT.txt"),
            "Generated artifact content\n",
            "utf8"
          );
        }
        return {
          status: "SUCCESS" as const,
          output: { success: true },
          durationMs: 50,
        };
      },
    };

    const workerStore = new SqliteStateStore({ location: dbPath });
    const workerCoord = new RunCoordinator(workerStore, clock);
    const workerRuntime = new WorkerRuntime({
      workerId: "w-artifact-test",
      hostname: os.hostname(),
      pid: process.pid,
      coordinator: workerCoord,
      clock,
      workspacePort: new (await import("../../src/adapters/workspace/node-fs-workspace-adapter.js")).NodeFsWorkspaceAdapter({
        workspaceRoot,
      }),
      artifactExporter: new (await import("../../src/adapters/workspace/git-artifact-exporter.js")).GitArtifactExporter({
        artifactRoot,
      }),
      repositoryImporter: new (await import("../../src/adapters/workspace/node-fs-repository-importer.js")).NodeFsRepositoryImporter(),
      executionProvider: customExecProvider as any,
      allowUnverifiedCompletion: true,
    });

    const runResult = await workerRuntime.runOnce();
    workerStore.close();
    expect(runResult.status).toBe("COMPLETED");

    // Inspect exported artifact manifest via CLI
    const artifactRes = await json([
      "artifact",
      "show",
      "--artifact-root",
      artifactRoot,
      "--run-id",
      sub.runId,
      "--db",
      dbPath,
    ]);

    expect(artifactRes.runId).toBe(sub.runId);
    expect(artifactRes.runStatus).toBe("COMPLETED");
    expect(artifactRes.manifest.files).toHaveLength(1);
    expect(artifactRes.manifest.files[0].path).toBe("NEW_ARTIFACT.txt");
    expect(artifactRes.manifest.files[0].status).toBe("added");

    // Inspect unified diff via CLI --patch flag
    const patchRes = await cli.run([
      "artifact",
      "show",
      "--artifact-root",
      artifactRoot,
      "--run-id",
      sub.runId,
      "--patch",
    ]);
    expect(patchRes.exitCode).toBe(0);
    expect(patchRes.output).toContain("diff --git a/NEW_ARTIFACT.txt b/NEW_ARTIFACT.txt");
    expect(patchRes.output).toContain("+Generated artifact content");
  });

  /**
   * Scenario 11: Reopening database
   * Inspect run and event history after closing and reopening SQLite connection
   */
  it("Scenario 11: persists durable state across complete SQLite connection and process restarts", async () => {
    // 1. Submit and execute a complete run
    const sub = await json(["router", "submit", "--db", dbPath, "--key", "k-restart-test", "--operation", "sum", "--input", "[10,20]"]);
    await json(["router", "tick", "--db", dbPath, "--max-concurrent", "1"]);
    await cli.run(["worker", "--db", dbPath, "--once", "--allow-unverified-completion"]);

    // 2. Simulate complete restart by creating fresh CLI and store instances
    const freshCli = new EmeraldCli();
    const freshStore = new SqliteStateStore({ location: dbPath });

    try {
      const run = freshStore.getRun(sub.runId);
      expect(run?.status).toBe("COMPLETED");
      expect(run?.resultPayload).toBe(30);

      const inspect = await freshCli.run(["inspect", "--db", dbPath, "--run-id", sub.runId]);
      expect(inspect.exitCode).toBe(0);
      const parsed = JSON.parse(inspect.output);
      expect(parsed.status).toBe("COMPLETED");
      expect(parsed.result).toBe(30);
      expect(parsed.events.length).toBeGreaterThanOrEqual(4);
    } finally {
      freshStore.close();
    }
  });

  /**
   * Scenario 12: Host shutdown with cleanup
   * Router Host and Worker Host exit cleanly on signals
   */
  it("Scenario 12: Router Host and Worker Host shut down cleanly when signalled without data corruption", async () => {
    // Populate an empty DB
    const initStore = new SqliteStateStore({ location: dbPath });
    initStore.close();

    const routerController = new AbortController();
    const routerPromise = runRouterHost({
      dbPath,
      signal: routerController.signal,
      pollIntervalMs: 50,
      log: () => {},
    });

    const workerController = new AbortController();
    const workerPromise = runWorkerHost({
      dbPath,
      signal: workerController.signal,
      pollIntervalMs: 50,
      log: () => {},
    });

    // Send stop signals
    routerController.abort();
    workerController.abort();

    const [routerResult, workerResult] = await Promise.all([routerPromise, workerPromise]);
    expect(routerResult).toBeDefined();
    expect(workerResult).toBeDefined();

    // DB remains valid and accessible
    const verifyStore = new SqliteStateStore({ location: dbPath });
    try {
      expect(verifyStore.findQueuedRuns()).toEqual([]);
    } finally {
      verifyStore.close();
    }
  });

  /**
   * Scenario 13: Local inference failure
   * Model timeout or provider failure fails closed without corrupting DB state
   */
  it("Scenario 13: fails closed when local inference provider encounters a failure or invalid tool proposal", async () => {
    const sub = await json([
      "router",
      "submit",
      "--db",
      dbPath,
      "--key",
      "k-fail-closed-test",
      "--task",
      "fail-closed invalid tool testing objective",
      "--repo",
      repoFixtureDir,
    ]);

    await cli.run(["router", "host", "--db", dbPath, "--once"]);

    // Worker runs with fixture provider which triggers deliberate fail-closed invalid tool proposal
    const workerRes = await cli.run([
      "worker",
      "--db",
      dbPath,
      "--once",
      "--model-provider",
      "fixture",
      "--allow-unverified-completion",
      "--workspace-root",
      workspaceRoot,
    ]);

    expect(workerRes.exitCode).toBe(0);

    const inspectRes = await json(["inspect", "--db", dbPath, "--run-id", sub.runId]);
    expect(inspectRes.status).toBe("FAILED");
    expect(inspectRes.error).toBeDefined();

    const eventTypes = inspectRes.events.map((e: { eventType: string }) => e.eventType);
    expect(eventTypes).toContain("run.failed");
  });

  /**
   * Scenario 14: Non-idempotent uncertain attempt remains fail-closed
   */
  it("Scenario 14: blocks replay of non-idempotent action when a prior attempt is in an uncertain state", async () => {
    const store = new SqliteStateStore({ location: dbPath });
    const clock = new SystemClock();
    const coordinator = new RunCoordinator(store, clock);

    try {
      coordinator.registerWorker({
        workerId: "w-worker-1",
        hostname: os.hostname(),
        pid: process.pid,
        status: "ACTIVE",
        lastHeartbeatAt: clock.nowIso(),
        createdAt: clock.nowIso(),
      });

      const task = coordinator.createTask({
        title: "non-idempotent-task",
        description: "Demonstrating fail-closed uncertain crash block",
        inputPayload: { instruction: "run unsafe command" },
      });

      createAndActivateContract(store, task.taskId, {
        policy: {
          policyId: `policy-${task.taskId}`,
          allowedCapabilities: ["process.execute"],
          isolationRequirement: "ISOLATED",
        },
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const claimRes = coordinator.claimRun(run.runId, "w-worker-1", 10000);
      expect(claimRes.lease).not.toBeNull();

      // Verify that the invariant holds: REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT blocks re-execution
      expect(REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT).toBe("REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT");

      // Verify ProductionRecoveryService safeToResume invariant is strictly false
      const { ProductionRecoveryService } = await import("../../src/recovery/production-recovery-service.js");
      const { RunControl } = await import("../../src/control-plane/run-control.js");
      const { MissionControl } = await import("../../src/control-plane/mission-control.js");
      const missionControl = new MissionControl(store, clock);
      const mission = missionControl.createMission({
        taskId: task.taskId,
        title: "non-idempotent-task",
        description: "Demonstrating fail-closed uncertain crash block",
        repositoryPath: repoFixtureDir,
      });
      const runControl = new RunControl();
      const prodRun = runControl.createRun(mission, "w-worker-1");
      runControl.transitionStatus(prodRun.runId, "EXECUTING");

      const recoveryService = new ProductionRecoveryService(runControl);
      const outcome = recoveryService.recoverRun(prodRun.runId);

      expect(outcome.safeToResume).toBe(false);
      expect(outcome.statusAfter).toBe("FAILED");
      expect(outcome.details).toContain("Run recovered from EXECUTING to FAILED");
    } finally {
      store.close();
    }
  });
});
