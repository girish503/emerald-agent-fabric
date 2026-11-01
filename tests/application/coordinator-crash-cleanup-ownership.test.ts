import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { issueOwnership } from "../../src/adapters/workspace/owner-marker.js";
import { RunCoordinator, WorkerRuntime } from "../../src/application/index.js";
import { createDefaultInProcessPolicy } from "../../src/domain/policy.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { ExecutionProvider } from "../../src/ports/execution-provider.port.js";
import { createAndActivateContract } from "./test-helpers.js";

const exists = (p: string) => fs.stat(p).then(() => true, () => false);
const MARKER = ".emerald-owner.json";

/**
 * Coordinator crash cleanup (`recoverExpiredRuns` -> workspacePort.disposeWorkspaceSync) with a REAL workspace adapter:
 * a worker crashes mid-run (its provider never returns), the lease expires, and the coordinator discards the crashed
 * attempt's workspace - but only if the directory still belongs to that attempt.
 */
describe("Coordinator crash cleanup honours workspace ownership", { timeout: 30000 }, () => {
  let root: string;
  let adapter: NodeFsWorkspaceAdapter;

  beforeEach(async () => {
    root = path.join(os.tmpdir(), `emerald-crash-clean-${crypto.randomUUID()}`);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    root = await fs.realpath(root);
    adapter = new NodeFsWorkspaceAdapter({ workspaceRoot: root });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  async function crashedRun() {
    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock, undefined, adapter);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const provider: ExecutionProvider = {
      name: "in-process",
      tenantModel: "NONE", // explicitly no separate tenant processes — no quiescence port needed (ADR-0037)
      async execute() {
        started();
        await gate; // the "crash": the worker is stuck and never renews
        throw new Error("released after the test");
      },
    };
    const worker = new WorkerRuntime({
      workerId: "worker-A", coordinator, clock, executionProvider: provider, workspacePort: adapter,
      leaseRenewal: { scheduler: { schedule: () => ({ cancel: () => {} }) } },
    });
    const task = coordinator.createTask({ title: "echo", inputPayload: { n: 1 } });
    createAndActivateContract(store, task.taskId, { policy: createDefaultInProcessPolicy("test-policy") });
    const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3 });
    coordinator.queueRun(run.runId);
    const running = worker.runOnce(run.runId).catch(() => undefined);
    await startedP;
    const dir = path.join(root, `ws-${run.runId}`);
    expect(await exists(path.join(dir, MARKER))).toBe(true);
    clock.advanceMs(11_000); // lease expired
    return { coordinator, store, runId: run.runId, dir, finish: async () => { release(); await running; store.close(); } };
  }

  it("the crashed attempt's own workspace is discarded and cleanup is not reported as failed", async () => {
    const t = await crashedRun();
    const result = t.coordinator.recoverExpiredRuns();
    expect(result.workspaceCleanupFailedRunIds ?? []).toEqual([]);
    expect(await exists(t.dir)).toBe(false);
    await t.finish();
  });

  it("a directory now owned by a NEWER lease survives, and the cleanup failure is surfaced for the operator", async () => {
    const t = await crashedRun();
    await fs.writeFile(
      path.join(t.dir, MARKER),
      issueOwnership(root, path.basename(t.dir), { runId: t.runId, leaseId: "lease-of-the-newer-attempt" })
    );
    await fs.writeFile(path.join(t.dir, "newer-work.txt"), "newer attempt's data");

    const result = t.coordinator.recoverExpiredRuns();

    expect(result.workspaceCleanupFailedRunIds).toContain(t.runId);
    expect(await fs.readFile(path.join(t.dir, "newer-work.txt"), "utf8")).toBe("newer attempt's data");
    await t.finish();
  });

  it("a corrupt marker is unprovable ownership: the directory survives and cleanup is reported as failed", async () => {
    const t = await crashedRun();
    await fs.writeFile(path.join(t.dir, MARKER), "{garbage");
    await fs.writeFile(path.join(t.dir, "keep.txt"), "keep");

    const result = t.coordinator.recoverExpiredRuns();

    expect(result.workspaceCleanupFailedRunIds).toContain(t.runId);
    expect(await fs.readFile(path.join(t.dir, "keep.txt"), "utf8")).toBe("keep");
    await t.finish();
  });

  it("a genuinely marker-less (legacy) workspace is still cleaned up", async () => {
    const t = await crashedRun();
    await fs.rm(path.join(t.dir, MARKER));

    const result = t.coordinator.recoverExpiredRuns();

    expect(result.workspaceCleanupFailedRunIds ?? []).toEqual([]);
    expect(await exists(t.dir)).toBe(false);
    await t.finish();
  });
  /** Corrupt/raw data: the crashed run no longer records which lease it held. */
  function forgetLease(t: { store: SqliteStateStore; runId: string }) {
    (t.store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db
      .prepare("UPDATE runs SET lease_id = NULL WHERE run_id = ?")
      .run(t.runId);
  }

  it("a RUNNING run that has lost its lease id cannot be recovered at all (domain invariant): recovery fails closed and the workspace is untouched", async () => {
    // The null-lease branch of crash cleanup is therefore unreachable through the state machine (it needs corrupt data);
    // the `unknownLease` semantics themselves are covered at adapter level (node-fs-workspace-owned-disposal.test.ts).
    const t = await crashedRun();
    forgetLease(t);
    await fs.writeFile(path.join(t.dir, "keep.txt"), "keep");

    expect(() => t.coordinator.recoverExpiredRuns()).toThrow(/requires leaseId/);

    expect(await fs.readFile(path.join(t.dir, "keep.txt"), "utf8")).toBe("keep");
    await t.finish();
  });
});
