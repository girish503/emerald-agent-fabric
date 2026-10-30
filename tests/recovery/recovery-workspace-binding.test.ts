/**
 * Emerald Agent Fabric — Recovery workspace binding (Phase 48AG.4.1 findings F1–F3)
 *
 * Recovery must never guess which workspace belongs to a run. Unresolved or
 * conflicting workspace identity fails closed before any state or filesystem change.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { DurableRollbackEngine } from "../../src/recovery/durable-rollback-engine.js";
import { RecoverySupervisor } from "../../src/recovery/recovery-supervisor.js";
import {
  WorkspaceBindingConflictError,
  WorkspaceResolutionError,
} from "../../src/domain/errors.js";

describe("RecoverySupervisor workspace binding (fail closed)", () => {
  let store: SqliteStateStore;
  let engine: DurableRollbackEngine;
  let wsA: string;
  let wsB: string;
  const nowIso = new Date().toISOString();

  beforeEach(() => {
    store = new SqliteStateStore();
    engine = new DurableRollbackEngine(store);
    wsA = fs.mkdtempSync(path.join(os.tmpdir(), "ws-bind-a-"));
    wsB = fs.mkdtempSync(path.join(os.tmpdir(), "ws-bind-b-"));
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // ignore
    }
    for (const d of [wsA, wsB]) fs.rmSync(d, { recursive: true, force: true });
  });

  function createExpiredRun(runId: string): void {
    const past = new Date(Date.now() - 60_000).toISOString();
    store.transaction((tx) => {
      tx.insertTask({
        taskId: "task-" + runId,
        title: "t",
        description: "d",
        inputPayload: {},
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      tx.insertWorker({
        workerId: "w-" + runId,
        hostname: "localhost",
        pid: process.pid,
        status: "ACTIVE",
        lastHeartbeatAt: nowIso,
        createdAt: nowIso,
      });
      tx.insertRun(
        {
          runId,
          taskId: "task-" + runId,
          status: "RUNNING",
          version: 1,
          attemptCount: 1,
          maxAttempts: 3,
          timeoutMs: 30000,
          idempotencyKey: null,
          currentWorkerId: "w-" + runId,
          leaseId: "l-" + runId,
          leaseExpiresAt: past,
          resultPayload: null,
          errorPayload: null,
          createdAt: nowIso,
          updatedAt: nowIso,
          contractBinding: null,
          maxOutputBytes: null,
        },
        {
          eventId: "evt-" + runId,
          runId,
          timestamp: nowIso,
          eventType: "run.created",
          schemaVersion: 1,
          producer: "test",
          payload: {},
        }
      );
      tx.insertLease({
        leaseId: "l-" + runId,
        workerId: "w-" + runId,
        runId,
        state: "ACTIVE",
        acquiredAt: nowIso,
        expiresAt: past,
        releasedAt: null,
      });
    });
  }

  function makeSupervisor(workspaceResolver?: (id: string) => string | undefined) {
    return new RecoverySupervisor({
      stateStore: store,
      rollbackEngine: engine,
      supervisorId: "sup-ws",
      workspaceResolver,
    });
  }

  it("F1: unresolved workspace fails closed without touching run state or leases", async () => {
    createExpiredRun("run-unresolved");
    const before = store.getRun("run-unresolved");

    await expect(makeSupervisor().recoverRun("run-unresolved")).rejects.toBeInstanceOf(
      WorkspaceResolutionError
    );

    const after = store.getRun("run-unresolved");
    expect(after?.status).toBe("RUNNING");
    expect(after?.version).toBe(before?.version);
    expect(store.getSupervisorLeasesForRun("run-unresolved")).toHaveLength(0);
    expect(store.getRunWorkspaceBinding("run-unresolved")).toBeNull();
  });

  it("F1: a resolver returning nothing does not fall back to process.cwd()", async () => {
    createExpiredRun("run-empty-resolver");
    await expect(
      makeSupervisor(() => undefined).recoverRun("run-empty-resolver")
    ).rejects.toBeInstanceOf(WorkspaceResolutionError);
    expect(store.getRun("run-empty-resolver")?.status).toBe("RUNNING");
  });

  it("F2: scanAndRecover reports unresolved runs as failed and leaves them unmodified", async () => {
    createExpiredRun("run-scan");
    const result = await makeSupervisor().scanAndRecover();
    expect(result.recoveredCount).toBe(0);
    expect(result.failedCount).toBe(1);
    expect(store.getRun("run-scan")?.status).toBe("RUNNING");
  });

  it("F2: scanAndRecover recovers a run through its persisted binding", async () => {
    createExpiredRun("run-scan-bound");
    store.bindRunWorkspace("run-scan-bound", fs.realpathSync(wsA), nowIso);
    const result = await makeSupervisor().scanAndRecover();
    expect(result.recoveredCount).toBe(0); // zero-intent run: closed out but unverified
    expect(result.unverifiedCount).toBe(1);
    expect(store.getRun("run-scan-bound")?.status).toBe("RECOVERING"); // handed off for coordinator retry
  });

  it("F3: a conflicting explicit workspace is rejected against the persisted binding", async () => {
    createExpiredRun("run-conflict");
    store.bindRunWorkspace("run-conflict", fs.realpathSync(wsA), nowIso);

    await expect(
      makeSupervisor().recoverRun("run-conflict", { workspaceRoot: wsB })
    ).rejects.toBeInstanceOf(WorkspaceBindingConflictError);
    expect(store.getRun("run-conflict")?.status).toBe("RUNNING");
  });

  it("F3: a conflicting resolver result is rejected against the persisted binding", async () => {
    createExpiredRun("run-conflict-resolver");
    store.bindRunWorkspace("run-conflict-resolver", fs.realpathSync(wsA), nowIso);

    await expect(
      makeSupervisor(() => wsB).recoverRun("run-conflict-resolver")
    ).rejects.toBeInstanceOf(WorkspaceBindingConflictError);
  });

  it("F3: rebinding a run to a different workspace is refused; same root is idempotent", () => {
    createExpiredRun("run-rebind");
    const a = fs.realpathSync(wsA);
    expect(store.bindRunWorkspace("run-rebind", a, nowIso)).toBe(a);
    expect(store.bindRunWorkspace("run-rebind", a, nowIso)).toBe(a);
    expect(() => store.bindRunWorkspace("run-rebind", fs.realpathSync(wsB), nowIso)).toThrow(
      WorkspaceBindingConflictError
    );
    expect(store.getRunWorkspaceBinding("run-rebind")).toBe(a);
  });

  it("F3: first explicit workspace for an unbound run is persisted and then enforced", async () => {
    createExpiredRun("run-first-bind");
    const outcome = await makeSupervisor().recoverRun("run-first-bind", { workspaceRoot: wsA });
    expect(outcome.status).toBe("RECOVERED_UNVERIFIED");
    expect(store.getRunWorkspaceBinding("run-first-bind")).toBe(fs.realpathSync(wsA));
  });

  it("rejects relative, missing, non-directory and filesystem-root workspaces", async () => {
    createExpiredRun("run-bad-root");
    const file = path.join(wsA, "file.txt");
    fs.writeFileSync(file, "x");
    const sup = makeSupervisor();
    for (const bad of [
      "relative/path",
      path.join(wsA, "does-not-exist"),
      file,
      path.parse(wsA).root,
    ]) {
      await expect(sup.recoverRun("run-bad-root", { workspaceRoot: bad })).rejects.toBeInstanceOf(
        WorkspaceResolutionError
      );
    }
    expect(store.getRun("run-bad-root")?.status).toBe("RUNNING");
    expect(store.getRunWorkspaceBinding("run-bad-root")).toBeNull();
  });
});
