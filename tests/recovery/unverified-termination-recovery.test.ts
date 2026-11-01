/**
 * Narrow link between WorkerRuntime and RecoverySweeper.sweepOnce for a provider-reported TERMINATION_UNVERIFIED.
 * No Docker: a fake isolated provider returns the unverified result and a fake quiescence port stands in for the daemon.
 * Proves (with real SQLite state, real supervisor and coordinator): the worker leaves the run RUNNING with its workspace
 * intact, recovery HOLDS it while quiescence is unverified (status/events/workspace untouched), and once the port answers
 * QUIESCENT the next sweep recovers it. Does not prove anything about a real container or the daemon.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { RunCoordinator, WorkerRuntime } from "../../src/application/index.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import type { ExecutionProvider, ExecutionRequest, ExecutionResult } from "../../src/ports/execution-provider.port.js";
import type { QuiescenceResult, TenantQuiescencePort } from "../../src/ports/tenant-quiescence.port.js";
import { DurableRollbackEngine } from "../../src/recovery/durable-rollback-engine.js";
import { RecoverySupervisor } from "../../src/recovery/recovery-supervisor.js";
import { RecoverySweeper } from "../../src/recovery/recovery-sweeper.js";
import { tenantModelFromContract } from "../../src/recovery/tenant-quiescence-gate.js";
import { createAndActivateContract } from "../application/test-helpers.js";

describe("unverified termination remains eligible for recovery (worker -> sweepOnce)", () => {
  let tempDir: string;
  let root: string;
  let clock: SettableClock;
  let store: SqliteStateStore;
  let adapter: NodeFsWorkspaceAdapter;
  let coordinator: RunCoordinator;
  let verdict: QuiescenceResult;
  const asked: string[] = [];

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "emerald-unverified-")));
    root = path.join(tempDir, "workspaces");
    fs.mkdirSync(root);
    clock = new SettableClock(new Date().toISOString());
    store = new SqliteStateStore();
    adapter = new NodeFsWorkspaceAdapter({ workspaceRoot: root });
    coordinator = new RunCoordinator(store, clock, undefined, adapter);
    verdict = { status: "UNVERIFIED", reason: "container could not be proven gone" };
    asked.length = 0;
  });
  afterEach(() => {
    try {
      store.close();
    } catch {
      /* closed */
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const port: TenantQuiescencePort = {
    quiesceRun: async (id) => {
      asked.push(id);
      return verdict;
    },
  };

  it("worker returns TERMINATION_UNVERIFIED without finalising; the sweeper holds the run until quiescence is proven, then recovers it", async () => {
    const provider: ExecutionProvider = {
      name: "fake-isolated", // never "docker": that name makes the runtime probe the real daemon
      tenantModel: "ISOLATED_PROCESSES",
      quiescence: port,
      cancellationModel: "COOPERATIVE",
      async execute<TInput = unknown, TOutput = unknown>(r: ExecutionRequest<TInput>): Promise<ExecutionResult<TOutput>> {
        // The "container" is still writing into the bound workspace when the provider gives up on verifying it.
        fs.writeFileSync(path.join(r.workspace!.hostPath, "tenant.txt"), "tenant data");
        return { status: "FAILED", error: { code: "TERMINATION_UNVERIFIED", message: "survivor" }, durationMs: 1 };
      },
    };
    coordinator.registerWorker({ workerId: "w", hostname: "h", pid: process.pid, status: "ACTIVE", lastHeartbeatAt: clock.nowIso(), createdAt: clock.nowIso() });
    const worker = new WorkerRuntime({
      workerId: "w",
      coordinator,
      clock,
      workspacePort: adapter,
      executionProvider: provider,
      leaseTtlMs: 5_000,
      isIsolationAvailable: true,
    });
    const task = coordinator.createTask({ title: "echo", inputPayload: {} });
    createAndActivateContract(store, task.taskId, {
      policy: createExecutionPolicy({
        policyId: "p-unverified",
        allowedCapabilities: ["execution.echo"],
        isolationRequirement: "ISOLATED",
        trustedInProcessOperations: [],
      }),
    });
    const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3, timeoutMs: 15_000 });
    coordinator.queueRun(run.runId);

    const result = await worker.runOnce(run.runId);
    expect(result.status, JSON.stringify((result as { error?: unknown }).error)).toBe("TERMINATION_UNVERIFIED");
    const dir = path.join(root, `ws-${run.runId}`);
    expect(coordinator.getRun(run.runId)!.status).toBe("RUNNING");
    expect(fs.readFileSync(path.join(dir, "tenant.txt"), "utf8")).toBe("tenant data");

    // Lease lapses (no heartbeat); recovery must hold while unverified, changing nothing.
    clock.advanceMs(6_000);
    const events = coordinator.getEventsForRun(run.runId).length;
    const sweeper = () =>
      new RecoverySweeper({
        supervisor: new RecoverySupervisor({ stateStore: store, rollbackEngine: new DurableRollbackEngine(store), clock, supervisorId: "sup" }),
        coordinator,
        tenantQuiescence: { tenantModelOf: tenantModelFromContract((id, v) => coordinator.getContract(id, v)), port },
      });
    const held = await sweeper().sweepOnce();
    expect(held.heldForTenantsRunIds).toEqual([run.runId]);
    expect(coordinator.getRun(run.runId)!.status).toBe("RUNNING"); // not requeued, not failed
    expect(coordinator.getEventsForRun(run.runId).length).toBe(events);
    expect(fs.readFileSync(path.join(dir, "tenant.txt"), "utf8")).toBe("tenant data"); // workspace untouched

    // Quiescence is later proven: the SAME run recovers on the next sweep (never permanently excluded).
    verdict = { status: "QUIESCENT", stopped: 1 };
    const recovered = await sweeper().sweepOnce();
    expect(recovered.heldForTenantsRunIds).toEqual([]);
    expect(coordinator.getRun(run.runId)!.status).toBe("QUEUED");
    expect(asked).toEqual([run.runId, run.runId]);
  });
});
