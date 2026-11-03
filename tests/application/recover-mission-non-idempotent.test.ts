/**
 * Milestone 2.11A.3 — RunCoordinator.recoverMission and NON_IDEMPOTENT Actions
 *
 * When recovery reconciles an in-flight Attempt to UNKNOWN, a NON_IDEMPOTENT Action is failed closed
 * with EXECUTION_UNCERTAIN and receives no new Attempt. IDEMPOTENT Actions keep the existing behavior.
 *
 * Explicit limits (not proven here, by design):
 * - Delivery stays at-least-once; no exactly-once claim is made.
 * - Lease expiry is not treated as proof the earlier process stopped or that the side effect did not occur.
 * - Tenant-quiescence enforcement is covered by tests/recovery/direct-recovery-safety-boundary.test.ts;
 *   this contract uses IN_PROCESS isolation, which needs no quiescence gate.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { Action } from "../../src/domain/action.js";
import { Attempt } from "../../src/domain/attempt.js";
import {
  createMissionContract,
  createDefaultInProcessPolicy,
  createResourceLimits,
  createVerificationSpec,
  MissionContract,
} from "../../src/domain/index.js";
import { SettableClock } from "../../src/ports/clock.port.js";

describe("Milestone 2.11A.3 — recoverMission fails closed for UNKNOWN NON_IDEMPOTENT actions", () => {
  let tempDir: string;
  let store: SqliteStateStore;
  let clock: SettableClock;
  let coordinator: RunCoordinator;
  let boundContract: MissionContract;

  const runId = "run-r2113";
  const taskId = "task-r2113";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-recover-nonidem-"));
    store = new SqliteStateStore({ location: path.join(tempDir, "recover.db") });
    // The store floors lease time at the wall clock, so the test clock must start at the real current time.
    clock = new SettableClock(new Date().toISOString());
    coordinator = new RunCoordinator(store, clock);

    store.transaction((tx) => {
      tx.insertTask({
        taskId,
        title: "recoverMission non-idempotent",
        description: "recoverMission must not retry an UNKNOWN non-idempotent action",
        inputPayload: { target: "recover-test" },
        createdAt: clock.nowIso(),
        updatedAt: clock.nowIso(),
      });

      boundContract = createMissionContract({
        contractId: "contract-r2113",
        version: 1,
        taskId,
        policy: createDefaultInProcessPolicy("policy-r2113"),
        verificationSpecs: [
          createVerificationSpec({
            specId: "vspec-r2113",
            ruleKind: "EXACT_OUTPUT_MATCH",
            expectedValue: { exitCode: 0 },
          }),
        ],
        resourceLimits: createResourceLimits({
          timeoutMs: 30000,
          maxAttempts: 3,
          maxOutputBytes: 65536,
        }),
        credentialScopes: ["workspace:read", "workspace:write"],
      });

      tx.insertContract(boundContract);
      tx.activateContract(boundContract.spec.contractId, boundContract.spec.version, clock.nowIso());

      tx.insertWorker({
        workerId: "worker-A",
        hostname: "node-1",
        pid: 2001,
        status: "ACTIVE",
        lastHeartbeatAt: clock.nowIso(),
        createdAt: clock.nowIso(),
      });
    });

    const { run } = coordinator.createRun({ runId, taskId });
    coordinator.queueRun(run.runId);
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  function seedInFlight(
    toolName: "write_file" | "read_file",
    inputPayload: unknown,
    attemptState: "DISPATCHED" | "RUNNING"
  ) {
    const workerClaim = coordinator.claimRun(runId, "worker-A", 10000);
    coordinator.startRun(runId, "worker-A", workerClaim.lease.leaseId);
    const actionId = "act-r2113-1";
    const attemptId = "att-r2113-1";
    const fencing = { workerId: "worker-A", leaseId: workerClaim.lease.leaseId };
    const { action, event: actEvt } = Action.create({
      actionId,
      runId,
      sequenceNumber: 1,
      toolName,
      inputPayload,
      contractBinding: {
        contractId: boundContract.spec.contractId,
        version: boundContract.spec.version,
        contentHash: boundContract.contentHash,
      },
      maxAttempts: 3,
      now: clock.nowIso(),
    });
    const { attempt, event: attEvt } = Attempt.create({
      attemptId,
      actionId,
      runId,
      attemptNumber: 1,
      workerId: "worker-A",
      leaseId: workerClaim.lease.leaseId,
      now: clock.nowIso(),
    });
    store.transaction((tx) => {
      tx.insertAction(action.snapshot, actEvt, fencing);
      tx.transitionAction(actionId, { type: "AUTHORIZE", now: clock.nowIso() }, () => crypto.randomUUID());
      tx.transitionAction(
        actionId,
        { type: "START_ATTEMPT", attemptNumber: 1, now: clock.nowIso() },
        () => crypto.randomUUID()
      );
      tx.insertAttempt(attempt.snapshot, attEvt, fencing);
      tx.transitionAttempt(attemptId, { type: "DISPATCH", now: clock.nowIso() }, () => crypto.randomUUID());
      if (attemptState === "RUNNING") {
        tx.transitionAttempt(attemptId, { type: "START", now: clock.nowIso() }, () => crypto.randomUUID());
      }
    });
    clock.advanceMs(15000);
    const supLease = coordinator.claimSupervisorLease({ runId, supervisorId: "supervisor-1", ttlMs: 600000 });
    return { actionId, workerLeaseId: workerClaim.lease.leaseId, supLease };
  }

  function fileExists(name: string): boolean {
    const walk = (dir: string): boolean =>
      fs.readdirSync(dir, { withFileTypes: true }).some((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : e.name === name
      );
    return walk(tempDir);
  }

  for (const state of ["RUNNING", "DISPATCHED"] as const) {
    it(`NON_IDEMPOTENT with a ${state} attempt: Action FAILED/EXECUTION_UNCERTAIN, attempt UNKNOWN, no new attempt, no dispatch`, async () => {
      const s = seedInFlight("write_file", { path: "critical-state.txt", content: "data" }, state);

      const recovery = coordinator.recoverMission({
        runId,
        supervisorId: "supervisor-1",
        supervisorLeaseId: s.supLease.leaseId,
      });

      expect(recovery.previousAttempt?.status).toBe("UNKNOWN");
      expect(recovery.newAttempt).toBeNull();
      const action = store.getAction(s.actionId);
      expect(action?.status).toBe("FAILED");
      expect(action?.errorPayload).toMatchObject({ code: "EXECUTION_UNCERTAIN" });
      const attempts = store.getAttemptsForAction(s.actionId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.status).toBe("UNKNOWN");

      const workspacePort = new NodeFsWorkspaceAdapter({ workspaceRoot: tempDir });
      const runtime = new WorkerRuntime({ workerId: "worker-A", coordinator, clock, workspacePort });
      await expect(
        runtime.executeAction({ runId, leaseId: s.workerLeaseId, actionId: s.actionId })
      ).rejects.toThrow();
      expect(store.getAttemptsForAction(s.actionId)).toHaveLength(1);
      expect(fileExists("critical-state.txt")).toBe(false);
    });
  }

  it("IDEMPOTENT action keeps the existing recovery: attempt UNKNOWN, Action RUNNING with attempt 2", () => {
    const s = seedInFlight("read_file", { path: "data.txt" }, "RUNNING");

    const recovery = coordinator.recoverMission({
      runId,
      supervisorId: "supervisor-1",
      supervisorLeaseId: s.supLease.leaseId,
    });

    expect(recovery.previousAttempt?.status).toBe("UNKNOWN");
    expect(recovery.newAttempt?.attemptNumber).toBe(2);
    expect(store.getAttemptsForAction(s.actionId)).toHaveLength(2);
    expect(store.getAction(s.actionId)?.status).toBe("RUNNING");
  });

  it("supervisor fencing is still enforced: a wrong supervisor lease changes nothing for a NON_IDEMPOTENT action", () => {
    const s = seedInFlight("write_file", { path: "critical-state.txt", content: "data" }, "RUNNING");

    expect(() =>
      coordinator.recoverMission({
        runId,
        supervisorId: "supervisor-1",
        supervisorLeaseId: "lease-does-not-exist",
      })
    ).toThrow();

    expect(store.getAction(s.actionId)?.status).toBe("RUNNING");
    const attempts = store.getAttemptsForAction(s.actionId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("RUNNING");
  });
});
