import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { issueOwnership } from "../../src/adapters/workspace/owner-marker.js";
import { RunCoordinator, WorkerRuntime } from "../../src/application/index.js";
import { LeaseLostError } from "../../src/domain/errors.js";
import { createDefaultInProcessPolicy } from "../../src/domain/policy.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { ExecutionProvider } from "../../src/ports/execution-provider.port.js";
import { createAndActivateContract } from "./test-helpers.js";

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

describe("Workspace disposal fails closed and never deletes a workspace this worker does not own", { timeout: 30000 }, () => {
  let testRoot: string;
  let adapter: NodeFsWorkspaceAdapter;

  beforeEach(async () => {
    testRoot = path.join(os.tmpdir(), `emerald-ws-dispose-${crypto.randomUUID()}`);
    await fs.mkdir(testRoot, { recursive: true, mode: 0o700 });
    testRoot = await fs.realpath(testRoot);
    adapter = new NodeFsWorkspaceAdapter({ workspaceRoot: testRoot });
  });

  afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true }).catch(() => {});
  });

  /**
   * The provider hook runs after the real workspace was provisioned. Throwing from the provider drives the
   * runtime's `disposeWorkspaceSafely` WITHOUT the post-provider ownership early-return, so these tests
   * exercise the disposal guard itself. The coordinator deliberately has no workspace port, so the only
   * thing that can delete the directory is the worker under test.
   */
  function setup(onExecute?: (ctx: { clock: SettableClock; coordinator: RunCoordinator; runId: string }) => void) {
    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const task = coordinator.createTask({ title: "echo", inputPayload: { foo: "bar" } });
    createAndActivateContract(store, task.taskId, { policy: createDefaultInProcessPolicy("test-policy") });
    const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3 });
    coordinator.queueRun(run.runId);

    const workspaceDir = path.join(testRoot, `ws-${run.runId}`);
    const provider: ExecutionProvider = {
      name: "in-process",
      async execute() {
        onExecute?.({ clock, coordinator, runId: run.runId });
        throw new Error("provider boom");
      },
    };
    const runtime = new WorkerRuntime({
      workerId: "worker-A",
      coordinator,
      clock,
      executionProvider: provider,
      workspacePort: adapter,
      leaseRenewal: { scheduler: { schedule: () => ({ cancel: () => {} }) } }, // no real timers
    });
    return { clock, store, coordinator, runtime, runId: run.runId, workspaceDir };
  }

  /** Sweeper reclaims A's run and worker-B claims and starts it (B owns the run; no workspace is provisioned for B). */
  function takeover(clock: SettableClock, coordinator: RunCoordinator, runId: string) {
    clock.advanceMs(11_000);
    expect(coordinator.recoverExpiredRuns().recoveredCount).toBe(1);
    coordinator.registerWorker({
      workerId: "worker-B", hostname: "localhost", pid: 2, status: "ACTIVE",
      lastHeartbeatAt: clock.nowIso(), createdAt: clock.nowIso(),
    });
    const claim = coordinator.claimRun(runId, "worker-B", 10_000);
    coordinator.startRun(runId, "worker-B", claim.lease.leaseId);
    return claim.lease.leaseId;
  }

  it("1. ownership read throws: the workspace is NOT deleted", async () => {
    let armed = false;
    const t = setup(() => {
      armed = true;
    });
    const realGetRun = t.coordinator.getRun.bind(t.coordinator);
    t.coordinator.getRun = (id: string) => {
      if (armed) throw new Error("state store unavailable");
      return realGetRun(id);
    };

    await expect(t.runtime.runOnce(t.runId)).rejects.toThrow("provider boom");
    expect(await exists(t.workspaceDir)).toBe(true);
  });

  it("1b. on the success path an unverifiable ownership surfaces as WORKSPACE_CLEANUP_FAILED and nothing is deleted", async () => {
    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const task = coordinator.createTask({ title: "echo", inputPayload: { foo: "bar" } });
    createAndActivateContract(store, task.taskId, { policy: createDefaultInProcessPolicy("test-policy") });
    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);
    let armed = false;
    const provider: ExecutionProvider = {
      name: "in-process",
      async execute() {
        armed = true; // from here on the ownership read of the disposal guard fails
        return { status: "SUCCESS", output: { ok: true }, durationMs: 1, providerMetadata: { provider: "in-process", exitCode: 0 } } as never;
      },
    };
    const runtime = new WorkerRuntime({ workerId: "worker-A", coordinator, clock, executionProvider: provider, workspacePort: adapter,
      leaseRenewal: { scheduler: { schedule: () => ({ cancel: () => {} }) } } });
    const realGetRun = coordinator.getRun.bind(coordinator);
    let reads = 0;
    coordinator.getRun = (id: string) => {
      // the first read after the provider is the post-provider ownership check; fail the disposal guard's read (the 2nd)
      if (armed && ++reads >= 2) throw new Error("state store unavailable");
      return realGetRun(id);
    };

    const result = await runtime.runOnce(run.runId);
    expect(JSON.stringify(result)).toMatch(/WORKSPACE_CLEANUP_FAILED/);
    expect(await exists(path.join(testRoot, `ws-${run.runId}`))).toBe(true);
  });

  it("2. recording the cleaning event throws an unexpected error: the workspace is NOT deleted", async () => {
    let armed = false;
    const t = setup(() => {
      armed = true;
    });
    const realRecord = t.coordinator.recordWorkspaceEvent.bind(t.coordinator);
    t.coordinator.recordWorkspaceEvent = (event, fencing) => {
      if (armed) throw new Error("event store failed");
      return realRecord(event, fencing);
    };

    await expect(t.runtime.runOnce(t.runId)).rejects.toThrow("provider boom");
    expect(await exists(t.workspaceDir)).toBe(true);
  });

  it("3. recording the cleaning event throws LeaseLostError: the workspace is NOT deleted", async () => {
    let armed = false;
    const t = setup(() => {
      armed = true;
    });
    const realRecord = t.coordinator.recordWorkspaceEvent.bind(t.coordinator);
    t.coordinator.recordWorkspaceEvent = (event, fencing) => {
      if (armed) throw new LeaseLostError(t.runId, "worker-A-lease", null);
      return realRecord(event, fencing);
    };

    await expect(t.runtime.runOnce(t.runId)).rejects.toThrow("provider boom");
    expect(await exists(t.workspaceDir)).toBe(true);
  });

  it("4. the run now belongs to a newer worker and lease: the stale worker does NOT delete, and B's run and lease are untouched", async () => {
    let bLease = "";
    const t = setup(({ clock, coordinator, runId }) => {
      bLease = takeover(clock, coordinator, runId);
    });

    await expect(t.runtime.runOnce(t.runId)).rejects.toThrow("provider boom");

    expect(await exists(t.workspaceDir)).toBe(true);
    const bRun = t.coordinator.getRun(t.runId)!;
    expect(bRun.status).toBe("RUNNING");
    expect(bRun.currentWorkerId).toBe("worker-B");
    expect(t.coordinator.getLease(bLease)!.state).toBe("ACTIVE");
  });

  it("5. legitimate current-owner disposal still deletes the workspace (provider exception path)", async () => {
    const t = setup();
    await expect(t.runtime.runOnce(t.runId)).rejects.toThrow("provider boom");
    expect(await exists(t.workspaceDir)).toBe(false);
  });

  it("5b. legitimate current-owner disposal still deletes the workspace (success path)", async () => {
    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const task = coordinator.createTask({ title: "echo", inputPayload: { foo: "bar" } });
    createAndActivateContract(store, task.taskId, { policy: createDefaultInProcessPolicy("test-policy") });
    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);
    const provider: ExecutionProvider = {
      name: "in-process",
      async execute() {
        return { status: "SUCCESS", output: { ok: true }, durationMs: 1, providerMetadata: { provider: "in-process", exitCode: 0 } } as never;
      },
    };
    const runtime = new WorkerRuntime({ workerId: "worker-A", coordinator, clock, executionProvider: provider, workspacePort: adapter,
      leaseRenewal: { scheduler: { schedule: () => ({ cancel: () => {} }) } } });
    expect((await runtime.runOnce(run.runId)).status).toBe("COMPLETED");
    expect(await exists(path.join(testRoot, `ws-${run.runId}`))).toBe(false);
  });

  it("6. a stale worker whose physical disposal fails does not write workspace.failed into the newer attempt's event stream", async () => {
    let afterCleaning = false;
    let bLease = "";
    const t = setup(() => {
      afterCleaning = true;
    });
    const realRecord = t.coordinator.recordWorkspaceEvent.bind(t.coordinator);
    t.coordinator.recordWorkspaceEvent = (event, fencing) => {
      const persisted = realRecord(event, fencing);
      if (afterCleaning && event.eventType === "workspace.cleaning") {
        afterCleaning = false;
        bLease = takeover(t.clock, t.coordinator, t.runId); // ownership changes right AFTER the cleaning event
      }
      return persisted;
    };
    adapter.disposeWorkspace = async () => {
      throw new Error("disk error");
    };

    // the provider-exception path swallows the disposal error and rethrows the provider's
    await expect(t.runtime.runOnce(t.runId)).rejects.toThrow("provider boom");

    const types = t.store.transaction((tx) => tx.getEventsForRun(t.runId)).map((e) => e.eventType);
    expect(types).not.toContain("workspace.failed");
    expect(t.coordinator.getLease(bLease)!.state).toBe("ACTIVE");
  });

  it("7. ownership lost after the cleaning event and the newer attempt provisioned its own workspace: the stale worker's delete is refused and the newer workspace survives", async () => {
    // Formerly a documented residual race (the port deleted unconditionally). Disposal is now ownership-aware:
    // the directory carries the owning lease id and is only deleted after being moved aside and re-verified.
    let afterCleaning = false;
    let bLease = "";
    const t = setup(() => {
      afterCleaning = true;
    });
    const realRecord = t.coordinator.recordWorkspaceEvent.bind(t.coordinator);
    t.coordinator.recordWorkspaceEvent = (event, fencing) => {
      const persisted = realRecord(event, fencing);
      if (afterCleaning && event.eventType === "workspace.cleaning") {
        afterCleaning = false;
        bLease = takeover(t.clock, t.coordinator, t.runId);
        // crash cleanup removed A's directory; B provisions its own at the same stable path
        fsSync.rmSync(t.workspaceDir, { recursive: true, force: true });
        fsSync.mkdirSync(t.workspaceDir, { mode: 0o700 });
        fsSync.writeFileSync(
          path.join(t.workspaceDir, ".emerald-owner.json"),
          issueOwnership(testRoot, path.basename(t.workspaceDir), { runId: t.runId, leaseId: bLease })
        );
        fsSync.writeFileSync(path.join(t.workspaceDir, "b-work.txt"), "B-data");
      }
      return persisted;
    };

    await expect(t.runtime.runOnce(t.runId)).rejects.toThrow("provider boom");

    expect(fsSync.readFileSync(path.join(t.workspaceDir, "b-work.txt"), "utf8")).toBe("B-data");
    expect(fsSync.readdirSync(testRoot).filter((n) => n.startsWith(".disposing-") || n.startsWith(".disposed-"))).toEqual([]);
    expect(t.coordinator.getLease(bLease)!.state).toBe("ACTIVE");
  });
});
