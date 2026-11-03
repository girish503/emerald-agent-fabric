/**
 * Milestone 2.11A — Re-dispatch guard for a re-entered NON_IDEMPOTENT Action
 *
 * Verifies that WorkerRuntime.executeAction does not invoke the adapter a second time when the
 * Action's own Attempt is already DISPATCHED or RUNNING. Adapter invocation is observed through the
 * real write_file adapter's filesystem effect; the persisted Attempt count is asserted alongside it.
 *
 * Explicit limits (not proven here, by design):
 * - Delivery stays at-least-once; no exactly-once or universal at-most-once claim is made.
 * - The blocked Attempt is left non-terminal; resolving it to UNKNOWN is recovery's job and is not
 *   inferred from lease expiry here.
 * - A blocked re-entry reports FAILED but leaves the Action RUNNING; callers must not treat it as terminal.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import {
  RESUME_BLOCKED_PRIOR_DISPATCH,
  WorkerRuntime,
} from "../../src/application/worker-runtime.js";
import { Action } from "../../src/domain/action.js";
import { Attempt } from "../../src/domain/attempt.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import type { ExtendedToolName } from "../../src/domain/tool.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { createAndActivateContract } from "./test-helpers.js";

function setupFixture() {
  const clock = new SettableClock("2026-11-03T10:00:00.000Z");
  const store = new SqliteStateStore();
  const coordinator = new RunCoordinator(store, clock);
  const workerId = "worker-resume-guard";

  store.transaction((tx) => {
    tx.insertWorker({
      workerId,
      hostname: "localhost",
      pid: 4321,
      status: "ACTIVE",
      createdAt: clock.nowIso(),
      lastHeartbeatAt: clock.nowIso(),
    });
  });

  const task = coordinator.createTask({
    title: "resume-guard-task",
    description: "Tier-1 replay gate verification",
    inputPayload: { target: "test" },
  });

  createAndActivateContract(store, task.taskId, {
    policy: createExecutionPolicy({
      policyId: `policy-${task.taskId}`,
      allowedCapabilities: ["workspace.file.read", "workspace.file.write", "process.execute"],
      isolationRequirement: "ISOLATED",
    }),
    timeoutMs: 10000,
    maxOutputBytes: 1048576,
    maxAttempts: 3,
  });

  const { run } = coordinator.createRun({ taskId: task.taskId });
  coordinator.queueRun(run.runId);
  const claim = coordinator.claimRun(run.runId, workerId, 60000);
  const started = coordinator.startRun(run.runId, workerId, claim.lease.leaseId);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-resume-guard-"));
  const workspacePort = new NodeFsWorkspaceAdapter({ workspaceRoot: tempDir });
  const workerRuntime = new WorkerRuntime({
    workerId,
    coordinator,
    clock,
    workspacePort,
  });

  const fencing = { workerId, leaseId: claim.lease.leaseId };
  const runSnapshot = started.run;

  /** Seeds an Action in RUNNING whose single Attempt is in the requested durable state. */
  function seedRunning(
    toolName: ExtendedToolName,
    inputPayload: unknown,
    attemptState: "CREATED" | "DISPATCHED" | "RUNNING" | "UNKNOWN"
  ): { actionId: string; attemptId: string } {
    const actionId = "act-resume-1";
    const attemptId = "att-resume-1";
    const now = clock.nowIso();
    const { action, event } = Action.create({
      actionId,
      runId: run.runId,
      sequenceNumber: 1,
      toolName,
      inputPayload,
      contractBinding: runSnapshot.contractBinding!,
      maxAttempts: 3,
      now,
    });
    store.transaction((tx) => {
      tx.insertAction(action.snapshot, event, fencing);
      tx.transitionAction(actionId, { type: "AUTHORIZE", now }, () => crypto.randomUUID());
      tx.transitionAction(
        actionId,
        { type: "START_ATTEMPT", attemptNumber: 1, now },
        () => crypto.randomUUID()
      );
      const { attempt, event: attEvent } = Attempt.create({
        attemptId,
        actionId,
        runId: run.runId,
        attemptNumber: 1,
        workerId,
        leaseId: claim.lease.leaseId,
        now,
      });
      tx.insertAttempt(attempt.snapshot, attEvent, fencing);
      if (attemptState === "CREATED") return;
      tx.transitionAttempt(attemptId, { type: "DISPATCH", now }, () => crypto.randomUUID());
      if (attemptState === "DISPATCHED") return;
      tx.transitionAttempt(attemptId, { type: "START", now }, () => crypto.randomUUID());
      if (attemptState === "RUNNING") return;
      tx.transitionAttempt(
        attemptId,
        {
          type: "MARK_UNKNOWN",
          reason: "Worker crashed or lease expired during execution",
          reasonCode: "LEASE_EXPIRED_DURING_EXECUTION",
          now,
        },
        () => crypto.randomUUID()
      );
    });
    return { actionId, attemptId };
  }

  function fileExistsAnywhere(name: string): boolean {
    const walk = (dir: string): boolean =>
      fs.readdirSync(dir, { withFileTypes: true }).some((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : e.name === name
      );
    return walk(tempDir);
  }

  return {
    clock,
    store,
    coordinator,
    workerRuntime,
    runId: run.runId,
    leaseId: claim.lease.leaseId,
    seedRunning,
    fileExistsAnywhere,
    cleanup: () => {
      try {
        store.close();
      } catch {}
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

describe("Milestone 2.11A — Re-dispatch guard", () => {
  const payload = { path: "critical-state.txt", content: "data" };

  for (const state of ["RUNNING", "DISPATCHED"] as const) {
    it(`blocks re-dispatch of a NON_IDEMPOTENT action whose attempt is ${state}: zero adapter calls, no new attempt`, async () => {
      const f = setupFixture();
      try {
        const prior = f.seedRunning("write_file", payload, state);
        const res = await f.workerRuntime.executeAction({
          runId: f.runId,
          leaseId: f.leaseId,
          actionId: prior.actionId,
        });

        expect(res.status).toBe("FAILED");
        expect(res.error).toMatchObject({
          code: RESUME_BLOCKED_PRIOR_DISPATCH,
          details: { toolName: "write_file", attemptStatus: state },
        });
        expect(JSON.stringify(res.error)).not.toContain("data");
        expect(f.fileExistsAnywhere("critical-state.txt")).toBe(false);
        expect(f.store.getAttemptsForAction(prior.actionId)).toHaveLength(1);
        expect(f.store.getAttemptsForAction(prior.actionId)[0]?.status).toBe(state);
        expect(f.store.getAction(prior.actionId)?.status).toBe("RUNNING");
      } finally {
        f.cleanup();
      }
    });
  }

  it("an UNKNOWN attempt on a re-entered NON_IDEMPOTENT action is not re-dispatched and stays UNKNOWN", async () => {
    const f = setupFixture();
    try {
      const prior = f.seedRunning("write_file", payload, "UNKNOWN");
      const res = await f.workerRuntime.executeAction({
        runId: f.runId,
        leaseId: f.leaseId,
        actionId: prior.actionId,
      });

      expect(res.status).toBe("FAILED");
      expect(res.error).toMatchObject({
        code: RESUME_BLOCKED_PRIOR_DISPATCH,
        details: { toolName: "write_file", attemptStatus: "UNKNOWN" },
      });
      expect(JSON.stringify(res.error)).not.toContain("data");
      expect(f.fileExistsAnywhere("critical-state.txt")).toBe(false);
      const attempts = f.store.getAttemptsForAction(prior.actionId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.status).toBe("UNKNOWN");
      expect(f.store.getAction(prior.actionId)?.status).toBe("RUNNING");
    } finally {
      f.cleanup();
    }
  });

  it("repeated re-entry stays blocked and never dispatches", async () => {
    const f = setupFixture();
    try {
      const prior = f.seedRunning("write_file", payload, "RUNNING");
      for (let i = 0; i < 3; i++) {
        const res = await f.workerRuntime.executeAction({
          runId: f.runId,
          leaseId: f.leaseId,
          actionId: prior.actionId,
        });
        expect(res.error).toMatchObject({ code: RESUME_BLOCKED_PRIOR_DISPATCH });
      }
      expect(f.fileExistsAnywhere("critical-state.txt")).toBe(false);
      expect(f.store.getAttemptsForAction(prior.actionId)).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  });

  it("an attempt that was never dispatched (CREATED) proceeds and succeeds once", async () => {
    const f = setupFixture();
    try {
      const prior = f.seedRunning("write_file", payload, "CREATED");
      const res = await f.workerRuntime.executeAction({
        runId: f.runId,
        leaseId: f.leaseId,
        actionId: prior.actionId,
      });
      expect(res.status).toBe("SUCCEEDED");
      expect(f.fileExistsAnywhere("critical-state.txt")).toBe(true);
      expect(f.store.getAttemptsForAction(prior.actionId)).toHaveLength(1);
      expect(f.store.getAttemptsForAction(prior.actionId)[0]?.status).toBe("SUCCEEDED");
    } finally {
      f.cleanup();
    }
  });

  it("IDEMPOTENT tools are not blocked on re-entry", async () => {
    const f = setupFixture();
    try {
      const prior = f.seedRunning("read_file", { path: "missing.txt" }, "RUNNING");
      const res = await f.workerRuntime.executeAction({
        runId: f.runId,
        leaseId: f.leaseId,
        actionId: prior.actionId,
      });
      expect((res.error as { code?: string } | undefined)?.code).not.toBe(RESUME_BLOCKED_PRIOR_DISPATCH);
    } finally {
      f.cleanup();
    }
  });
});
