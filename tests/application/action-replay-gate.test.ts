/**
 * Milestone 2.10C — Tier-1 Action Replay Gate
 *
 * Verifies that WorkerRuntime.executeAction refuses to dispatch a NON_IDEMPOTENT Action whose
 * (runId, toolName, inputHash) matches a prior Action with an UNKNOWN (or still non-terminal) Attempt.
 *
 * Explicit limits (not proven here, by design):
 * - The key is a candidate-equivalence match, not proof of an equivalent side effect.
 * - A different payload producing the same effect is not caught.
 * - Loop bounding for a repeatedly blocked proposal relies on existing step-controller budgets.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import {
  REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT,
  WorkerRuntime,
} from "../../src/application/worker-runtime.js";
import { Action } from "../../src/domain/action.js";
import { Attempt } from "../../src/domain/attempt.js";
import { LeaseLostError } from "../../src/domain/errors.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import type { ExtendedToolName } from "../../src/domain/tool.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { createAndActivateContract } from "./test-helpers.js";

type PriorState = "UNKNOWN" | "IN_FLIGHT" | "SUCCEEDED" | "FAILED" | "DENIED_BEFORE_DISPATCH";

function setupFixture() {
  const clock = new SettableClock("2026-11-03T10:00:00.000Z");
  const store = new SqliteStateStore();
  const coordinator = new RunCoordinator(store, clock);
  const workerId = "worker-replay-gate";

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
    title: "replay-gate-task",
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

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-replay-gate-"));
  const workspacePort = new NodeFsWorkspaceAdapter({ workspaceRoot: tempDir });
  const workerRuntime = new WorkerRuntime({
    workerId,
    coordinator,
    clock,
    workspacePort,
  });

  const fencing = { workerId, leaseId: claim.lease.leaseId };
  const runSnapshot = started.run;

  /** Seeds a prior Action/Attempt in the requested durable state, mirroring recovery-integration fixtures. */
  function seedPrior(
    toolName: ExtendedToolName,
    inputPayload: unknown,
    state: PriorState
  ): { actionId: string; attemptId: string } {
    const seq = store.getActionsForRun(run.runId).length + 1;
    const actionId = `act-prior-${seq}`;
    const attemptId = `att-prior-${seq}`;
    const now = clock.nowIso();

    const { action, event } = Action.create({
      actionId,
      runId: run.runId,
      sequenceNumber: seq,
      toolName,
      inputPayload,
      contractBinding: runSnapshot.contractBinding!,
      maxAttempts: 3,
      now,
    });

    store.transaction((tx) => {
      tx.insertAction(action.snapshot, event, fencing);
      if (state === "DENIED_BEFORE_DISPATCH") {
        tx.transitionAction(
          actionId,
          { type: "FAIL", errorPayload: { code: "CAPABILITY_DENIED" }, now },
          () => crypto.randomUUID()
        );
        return;
      }
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
      tx.transitionAttempt(attemptId, { type: "DISPATCH", now }, () => crypto.randomUUID());
      tx.transitionAttempt(attemptId, { type: "START", now }, () => crypto.randomUUID());

      if (state === "IN_FLIGHT") {
        return;
      }
      if (state === "UNKNOWN") {
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
        tx.transitionAction(
          actionId,
          {
            type: "FAIL",
            errorPayload: { code: "EXECUTION_UNCERTAIN", reasonCode: "LEASE_EXPIRED_DURING_EXECUTION" },
            now,
          },
          () => crypto.randomUUID()
        );
      } else if (state === "SUCCEEDED") {
        tx.transitionAttempt(
          attemptId,
          { type: "COMPLETE", outputPayload: { ok: true }, exitCode: 0, durationMs: 1, now },
          () => crypto.randomUUID()
        );
        tx.transitionAction(
          actionId,
          { type: "SUCCEED", resultPayload: { ok: true }, now },
          () => crypto.randomUUID()
        );
      } else {
        tx.transitionAttempt(
          attemptId,
          { type: "FAIL", errorPayload: { code: "TOOL_EXECUTION_FAILED" }, exitCode: null, durationMs: 1, now },
          () => crypto.randomUUID()
        );
        tx.transitionAction(
          actionId,
          { type: "FAIL", errorPayload: { code: "TOOL_EXECUTION_FAILED" }, now },
          () => crypto.randomUUID()
        );
      }
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
    seedPrior,
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

describe("Milestone 2.10C — Tier-1 Action Replay Gate", () => {
  const payload = { path: "critical-state.txt", content: "data" };

  it("T1: blocks the same NON_IDEMPOTENT proposal after an UNKNOWN prior attempt, with zero dispatch", async () => {
    const f = setupFixture();
    try {
      const prior = f.seedPrior("write_file", payload, "UNKNOWN");
      const before = f.store.getActionsForRun(f.runId).length;

      const res = await f.workerRuntime.executeAction({
        runId: f.runId,
        leaseId: f.leaseId,
        toolName: "write_file",
        inputPayload: payload,
      });

      expect(res.status).toBe("FAILED");
      expect(res.error).toMatchObject({
        code: REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT,
        details: {
          priorActionId: prior.actionId,
          priorAttemptId: prior.attemptId,
          priorAttemptStatus: "UNKNOWN",
          priorReasonCode: "LEASE_EXPIRED_DURING_EXECUTION",
        },
      });
      expect(f.store.getActionsForRun(f.runId).length).toBe(before + 1);
      expect(f.store.getAttemptsForAction(res.actionId)).toHaveLength(0);
      expect(f.store.getAction(res.actionId)?.status).toBe("FAILED");
      expect(f.fileExistsAnywhere("critical-state.txt")).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it("T2: allows a different proposal after an UNKNOWN prior attempt", async () => {
    const f = setupFixture();
    try {
      f.seedPrior("write_file", payload, "UNKNOWN");
      const res = await f.workerRuntime.executeAction({
        runId: f.runId,
        leaseId: f.leaseId,
        toolName: "write_file",
        inputPayload: { path: "critical-state.txt", content: "different" },
      });
      expect(res.status).toBe("SUCCEEDED");
    } finally {
      f.cleanup();
    }
  });

  it("T3: allows a repeated proposal after a confirmed success", async () => {
    const f = setupFixture();
    try {
      f.seedPrior("write_file", payload, "SUCCEEDED");
      const res = await f.workerRuntime.executeAction({
        runId: f.runId,
        leaseId: f.leaseId,
        toolName: "write_file",
        inputPayload: payload,
      });
      expect(res.status).toBe("SUCCEEDED");
    } finally {
      f.cleanup();
    }
  });

  it("T4: a prior deterministic FAILED attempt is not blocked (known limitation: an error does not prove no side effect)", async () => {
    const f = setupFixture();
    try {
      f.seedPrior("write_file", payload, "FAILED");
      const res = await f.workerRuntime.executeAction({
        runId: f.runId,
        leaseId: f.leaseId,
        toolName: "write_file",
        inputPayload: payload,
      });
      expect(res.status).toBe("SUCCEEDED");
    } finally {
      f.cleanup();
    }
  });

  it("T5: an Action rejected before dispatch (no Attempt) does not block the same proposal", async () => {
    const f = setupFixture();
    try {
      f.seedPrior("write_file", payload, "DENIED_BEFORE_DISPATCH");
      const res = await f.workerRuntime.executeAction({
        runId: f.runId,
        leaseId: f.leaseId,
        toolName: "write_file",
        inputPayload: payload,
      });
      expect(res.status).toBe("SUCCEEDED");
    } finally {
      f.cleanup();
    }
  });

  it("T6: still blocks when the workspace is fresh and previous local state is absent", async () => {
    const f = setupFixture();
    try {
      f.seedPrior("write_file", payload, "UNKNOWN");
      // No workspace supplied and none cached: executeAction provisions a brand-new workspace.
      const res = await f.workerRuntime.executeAction({
        runId: f.runId,
        leaseId: f.leaseId,
        toolName: "write_file",
        inputPayload: payload,
      });
      expect(res.status).toBe("FAILED");
      expect((res.error as { code: string }).code).toBe(REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT);
      expect(f.fileExistsAnywhere("critical-state.txt")).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it("T7: IDEMPOTENT tools are not gated", async () => {
    const f = setupFixture();
    try {
      f.seedPrior("read_file", { path: "missing.txt" }, "UNKNOWN");
      const res = await f.workerRuntime.executeAction({
        runId: f.runId,
        leaseId: f.leaseId,
        toolName: "read_file",
        inputPayload: { path: "missing.txt" },
      });
      expect((res.error as { code?: string } | undefined)?.code).not.toBe(
        REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT
      );
      // The tool was actually dispatched (an Attempt exists), whatever its outcome.
      expect(f.store.getAttemptsForAction(res.actionId).length).toBe(1);
    } finally {
      f.cleanup();
    }
  });

  it("T8: a stale lease is rejected by fencing before the gate writes anything", async () => {
    const f = setupFixture();
    try {
      f.seedPrior("write_file", payload, "UNKNOWN");
      const before = f.store.getActionsForRun(f.runId).length;
      await expect(
        f.workerRuntime.executeAction({
          runId: f.runId,
          leaseId: "stale-lease",
          toolName: "write_file",
          inputPayload: payload,
        })
      ).rejects.toBeInstanceOf(LeaseLostError);
      expect(f.store.getActionsForRun(f.runId).length).toBe(before);
    } finally {
      f.cleanup();
    }
  });

  it("T9: repeated blocked proposals never dispatch and never create attempts", async () => {
    const f = setupFixture();
    try {
      f.seedPrior("write_file", payload, "UNKNOWN");
      for (let i = 0; i < 5; i++) {
        const res = await f.workerRuntime.executeAction({
          runId: f.runId,
          leaseId: f.leaseId,
          toolName: "write_file",
          inputPayload: payload,
        });
        expect((res.error as { code: string }).code).toBe(REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT);
        expect(f.store.getAttemptsForAction(res.actionId)).toHaveLength(0);
      }
      expect(f.fileExistsAnywhere("critical-state.txt")).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it("T10: a still non-terminal prior attempt blocks (fail-closed, no quiescence inferred)", async () => {
    const f = setupFixture();
    try {
      f.seedPrior("write_file", payload, "IN_FLIGHT");
      const res = await f.workerRuntime.executeAction({
        runId: f.runId,
        leaseId: f.leaseId,
        toolName: "write_file",
        inputPayload: payload,
      });
      expect(res.status).toBe("FAILED");
      expect(res.error).toMatchObject({
        code: REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT,
        details: { priorAttemptStatus: "RUNNING", priorReasonCode: "ATTEMPT_NOT_TERMINAL" },
      });
    } finally {
      f.cleanup();
    }
  });

  it("T11: a blocked Action is terminal (never left in CREATED)", async () => {
    const f = setupFixture();
    try {
      f.seedPrior("write_file", payload, "UNKNOWN");
      const res = await f.workerRuntime.executeAction({
        runId: f.runId,
        leaseId: f.leaseId,
        toolName: "write_file",
        inputPayload: payload,
      });
      const blocked = f.store.getAction(res.actionId)!;
      expect(blocked.status).toBe("FAILED");
      expect(blocked.completedAt).not.toBeNull();
      expect(f.store.getActionsForRun(f.runId).some((a) => a.status === "CREATED")).toBe(false);
    } finally {
      f.cleanup();
    }
  });
});
