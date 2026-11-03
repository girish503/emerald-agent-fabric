/**
 * Milestone 2.11B — End-to-End Recovery Safety Verification
 *
 * Deterministic integration tests across execution interruption boundaries. Interruption is
 * modelled without sleeps:
 * - "in-flight" scenarios run the real WorkerRuntime.executeAction against a controllable adapter
 *   that blocks on explicit barriers. The call is left pending (the worker is "interrupted"),
 *   recovery runs against the durable state, and only then is the barrier released.
 * - "pre-adapter" scenarios (CREATED, DISPATCHED) seed the durable state an interrupted worker
 *   would have left, because no seam exists between the runtime's own transitions.
 *
 * Explicit limits (not proven here, by design):
 * - Delivery stays at-least-once; no exactly-once claim is made.
 * - A DISPATCHED Attempt is treated as uncertain even though, by code order, the adapter may not
 *   have run yet; the runtime cannot tell, and neither do these tests.
 * - Missing persistence is never read as proof that a side effect did not happen. Scenarios 3 and 4
 *   show a side effect landing after recovery has already marked the Attempt UNKNOWN.
 * - Recovery here uses RunCoordinator.recoverStaleExecutions, which does not consult lease expiry
 *   or tenant quiescence; quiescence is exercised separately through recoverMission.
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
  RESUME_BLOCKED_PRIOR_DISPATCH,
  WorkerRuntime,
} from "../../src/application/worker-runtime.js";
import { Action } from "../../src/domain/action.js";
import { Attempt } from "../../src/domain/attempt.js";
import {
  LeaseLostError,
  TenantQuiescenceRequiredError,
  TerminalStateError,
} from "../../src/domain/errors.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import type { ExtendedToolName } from "../../src/domain/tool.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { StaticToolAdapterRegistry } from "../../src/ports/tool-adapter.port.js";
import type { ToolAdapter } from "../../src/ports/tool-adapter.port.js";
import { createAndActivateContract } from "./test-helpers.js";

// ============================================================================
// Barriers and controllable adapters
// ============================================================================

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type HoldPoint = "none" | "before_effect" | "after_effect";

/** NON_IDEMPOTENT adapter that performs a real file side effect and can block around it. */
class ControlledWriteAdapter implements ToolAdapter<"write_file"> {
  readonly toolName = "write_file" as const;
  invocations = 0;
  effects = 0;
  readonly entered = deferred();
  readonly release = deferred();

  constructor(
    private readonly effectsDir: string,
    private readonly holdAt: HoldPoint
  ) {}

  async execute(_context: unknown, input: { path: string; content: string }) {
    this.invocations++;
    this.entered.resolve();
    if (this.holdAt === "before_effect") await this.release.promise;
    fs.writeFileSync(path.join(this.effectsDir, input.path), input.content);
    this.effects++;
    if (this.holdAt === "after_effect") await this.release.promise;
    return {
      path: input.path,
      bytesWritten: Buffer.byteLength(input.content, "utf8"),
      created: true,
    };
  }
}

/** IDEMPOTENT adapter (no side effect) that can block before returning. */
class ControlledReadAdapter implements ToolAdapter<"read_file"> {
  readonly toolName = "read_file" as const;
  invocations = 0;
  readonly entered = deferred();
  readonly release = deferred();

  constructor(private readonly hold: boolean) {}

  async execute(_context: unknown, input: { path: string }) {
    this.invocations++;
    this.entered.resolve();
    if (this.hold) await this.release.promise;
    return { path: input.path, content: "x", bytesRead: 1, isTruncated: false };
  }
}

// ============================================================================
// Fixture
// ============================================================================

type SeedState = "CREATED" | "DISPATCHED" | "RUNNING";

interface FixtureOptions {
  readonly writeHold?: HoldPoint;
  readonly readHold?: boolean;
  readonly isolation?: "ISOLATED" | "IN_PROCESS";
  readonly workerLeaseTtlMs?: number;
}

function setupFixture(options: FixtureOptions = {}) {
  const clock = new SettableClock(new Date().toISOString());
  const store = new SqliteStateStore();
  const coordinator = new RunCoordinator(store, clock);
  const workerId = "worker-lifecycle";
  const isolated = (options.isolation ?? "ISOLATED") === "ISOLATED";

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
    title: "lifecycle-task",
    description: "Recovery lifecycle verification",
    inputPayload: { target: "test" },
  });

  createAndActivateContract(store, task.taskId, {
    ...(isolated
      ? {
          policy: createExecutionPolicy({
            policyId: `policy-${task.taskId}`,
            allowedCapabilities: ["workspace.file.read", "workspace.file.write"],
            isolationRequirement: "ISOLATED",
          }),
        }
      : {}),
    timeoutMs: 10000,
    maxOutputBytes: 1048576,
    maxAttempts: 3,
  });

  const { run } = coordinator.createRun({ taskId: task.taskId });
  coordinator.queueRun(run.runId);
  const claim = coordinator.claimRun(run.runId, workerId, options.workerLeaseTtlMs ?? 60000);
  const started = coordinator.startRun(run.runId, workerId, claim.lease.leaseId);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-lifecycle-"));
  const effectsDir = path.join(tempDir, "effects");
  fs.mkdirSync(effectsDir);
  const workspacePort = new NodeFsWorkspaceAdapter({ workspaceRoot: path.join(tempDir, "ws") });

  const writeAdapter = new ControlledWriteAdapter(effectsDir, options.writeHold ?? "none");
  const readAdapter = new ControlledReadAdapter(options.readHold ?? false);
  const runtime = new WorkerRuntime({
    workerId,
    coordinator,
    clock,
    workspacePort,
    toolAdapterRegistry: new StaticToolAdapterRegistry([writeAdapter, readAdapter]),
  });

  const fencing = { workerId, leaseId: claim.lease.leaseId };
  const runId = run.runId;

  /** Seeds the durable state an interrupted worker would have left for one Action. */
  function seed(toolName: ExtendedToolName, inputPayload: unknown, state: SeedState) {
    const actionId = "act-lifecycle-1";
    const attemptId = "att-lifecycle-1";
    const now = clock.nowIso();
    const { action, event } = Action.create({
      actionId,
      runId,
      sequenceNumber: 1,
      toolName,
      inputPayload,
      contractBinding: started.run.contractBinding!,
      maxAttempts: 3,
      now,
    });
    const { attempt, event: attEvent } = Attempt.create({
      attemptId,
      actionId,
      runId,
      attemptNumber: 1,
      workerId,
      leaseId: claim.lease.leaseId,
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
      tx.insertAttempt(attempt.snapshot, attEvent, fencing);
      if (state === "CREATED") return;
      tx.transitionAttempt(attemptId, { type: "DISPATCH", now }, () => crypto.randomUUID());
      if (state === "DISPATCHED") return;
      tx.transitionAttempt(attemptId, { type: "START", now }, () => crypto.randomUUID());
    });
    return { actionId, attemptId };
  }

  function effectFiles(): string[] {
    return fs.readdirSync(effectsDir).sort();
  }

  function eventTypes(): string[] {
    return store.getEventsForRun(runId).map((e) => e.eventType);
  }

  /** Events are strictly ordered, gapless, and uniquely identified. */
  function expectOrderedEvents(): void {
    const events = store.getEventsForRun(runId);
    const ids = new Set(events.map((e) => e.eventId));
    expect(ids.size).toBe(events.length);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.sequence).toBe(events[i - 1]!.sequence + 1);
    }
  }

  return {
    clock,
    store,
    coordinator,
    runtime,
    runId,
    leaseId: claim.lease.leaseId,
    workerId,
    fencing,
    writeAdapter,
    readAdapter,
    seed,
    effectFiles,
    eventTypes,
    expectOrderedEvents,
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

const writePayload = { path: "critical-state.txt", content: "data" };

/** Settles an in-flight executeAction without leaving an unhandled rejection. */
function settle<T>(p: Promise<T>) {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
}

// ============================================================================
// Scenario 1 — interruption while the Attempt is CREATED (known not dispatched)
// ============================================================================

describe("Milestone 2.11B — Scenario 1: interrupted while Attempt is CREATED", () => {
  it("NON_IDEMPOTENT: Attempt CANCELLED, Action FAILED (WORKER_CRASHED), no replacement Attempt, adapter never invoked", () => {
    const f = setupFixture();
    try {
      const prior = f.seed("write_file", writePayload, "CREATED");

      const result = f.coordinator.recoverStaleExecutions({ runId: f.runId });

      expect(result.details).toHaveLength(1);
      expect(result.details[0]).toMatchObject({
        priorAttemptStatus: "CREATED",
        resultingAttemptStatus: "CANCELLED",
        priorActionStatus: "RUNNING",
        resultingActionStatus: "FAILED",
      });
      expect(f.store.getAction(prior.actionId)?.status).toBe("FAILED");
      expect(f.store.getAction(prior.actionId)?.errorPayload).toMatchObject({ code: "WORKER_CRASHED" });
      const attempts = f.store.getAttemptsForAction(prior.actionId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.status).toBe("CANCELLED");
      expect(f.writeAdapter.invocations).toBe(0);
      expect(f.effectFiles()).toEqual([]);
      f.expectOrderedEvents();
    } finally {
      f.cleanup();
    }
  });

  it("IDEMPOTENT: Attempt CANCELLED, Action RETRYING, and the retry is executed exactly once as Attempt 2", async () => {
    const f = setupFixture();
    try {
      const prior = f.seed("read_file", { path: "data.txt" }, "CREATED");

      const result = await f.runtime.recoverStaleExecutions({ runId: f.runId, executeRetries: true });

      expect(result.coordinatorResult.details[0]).toMatchObject({
        resultingAttemptStatus: "CANCELLED",
        resultingActionStatus: "RETRYING",
        retryEligible: true,
      });
      expect(result.retriedActions).toHaveLength(1);
      expect(result.retriedActions[0]?.status).toBe("SUCCEEDED");
      const attempts = f.store.getAttemptsForAction(prior.actionId);
      expect(attempts.map((a) => [a.attemptNumber, a.status])).toEqual([
        [1, "CANCELLED"],
        [2, "SUCCEEDED"],
      ]);
      expect(f.readAdapter.invocations).toBe(1);
      f.expectOrderedEvents();
    } finally {
      f.cleanup();
    }
  });
});

// ============================================================================
// Scenario 2 — interruption after DISPATCHED is durable
// ============================================================================

describe("Milestone 2.11B — Scenario 2: interrupted after DISPATCHED is recorded", () => {
  it("NON_IDEMPOTENT: Attempt UNKNOWN, Action FAILED (EXECUTION_UNCERTAIN); re-submission is replay-gated and never dispatches", async () => {
    const f = setupFixture();
    try {
      const prior = f.seed("write_file", writePayload, "DISPATCHED");

      const result = f.coordinator.recoverStaleExecutions({ runId: f.runId });

      expect(result.details[0]).toMatchObject({
        priorAttemptStatus: "DISPATCHED",
        resultingAttemptStatus: "UNKNOWN",
        resultingActionStatus: "FAILED",
        retryEligible: false,
      });
      expect(f.store.getAction(prior.actionId)?.errorPayload).toMatchObject({ code: "EXECUTION_UNCERTAIN" });
      expect(f.store.getAttemptsForAction(prior.actionId)[0]?.status).toBe("UNKNOWN");

      const resubmitted = await f.runtime.executeAction({
        runId: f.runId,
        leaseId: f.leaseId,
        toolName: "write_file",
        inputPayload: writePayload,
      });
      expect(resubmitted.status).toBe("FAILED");
      expect(resubmitted.error).toMatchObject({ code: REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT });
      expect(f.store.getAttemptsForAction(prior.actionId)).toHaveLength(1);
      expect(f.store.getAttemptsForAction(resubmitted.actionId)).toHaveLength(0);
      expect(f.writeAdapter.invocations).toBe(0);
      expect(f.effectFiles()).toEqual([]);
      f.expectOrderedEvents();
    } finally {
      f.cleanup();
    }
  });

  it("IDEMPOTENT: the sweeper is also fail-closed on UNKNOWN (Action FAILED, no automatic retry)", async () => {
    const f = setupFixture();
    try {
      const prior = f.seed("read_file", { path: "data.txt" }, "DISPATCHED");

      const result = await f.runtime.recoverStaleExecutions({ runId: f.runId, executeRetries: true });

      expect(result.coordinatorResult.details[0]).toMatchObject({
        resultingAttemptStatus: "UNKNOWN",
        resultingActionStatus: "FAILED",
      });
      expect(result.retriedActions).toHaveLength(0);
      expect(f.store.getAttemptsForAction(prior.actionId)).toHaveLength(1);
      expect(f.readAdapter.invocations).toBe(0);
    } finally {
      f.cleanup();
    }
  });
});

// ============================================================================
// Scenario 3 — interruption while the adapter is executing (before its side effect)
// ============================================================================

describe("Milestone 2.11B — Scenario 3: interrupted while the adapter is executing", () => {
  it("NON_IDEMPOTENT: re-entry is blocked, recovery marks UNKNOWN, and the late completion cannot overwrite it", async () => {
    const f = setupFixture({ writeHold: "before_effect" });
    try {
      const inFlight = settle(
        f.runtime.executeAction({
          runId: f.runId,
          leaseId: f.leaseId,
          toolName: "write_file",
          inputPayload: writePayload,
        })
      );
      await f.writeAdapter.entered.promise;

      const action = f.store.getActionsForRun(f.runId)[0]!;
      expect(action.status).toBe("RUNNING");
      expect(f.store.getAttemptsForAction(action.actionId)[0]?.status).toBe("RUNNING");

      // Re-entry while the first call is still in flight: no second adapter call.
      const blocked = await f.runtime.executeAction({
        runId: f.runId,
        leaseId: f.leaseId,
        actionId: action.actionId,
      });
      expect(blocked.status).toBe("FAILED");
      expect(blocked.error).toMatchObject({ code: RESUME_BLOCKED_PRIOR_DISPATCH });
      expect(f.store.getAction(action.actionId)?.status).toBe("RUNNING");
      expect(f.writeAdapter.invocations).toBe(1);

      // Recovery is not blocked forever: the sweeper resolves the open Action to UNKNOWN/FAILED.
      const result = f.coordinator.recoverStaleExecutions({ runId: f.runId });
      expect(result.details[0]).toMatchObject({
        resultingAttemptStatus: "UNKNOWN",
        resultingActionStatus: "FAILED",
      });
      const eventCountAtRecovery = f.store.getEventsForRun(f.runId).length;

      // The interrupted adapter was never stopped: it now performs its side effect.
      f.writeAdapter.release.resolve();
      const late = await inFlight;

      expect(late.ok).toBe(false);
      expect(f.writeAdapter.invocations).toBe(1);
      expect(f.writeAdapter.effects).toBe(1);
      expect(f.effectFiles()).toEqual(["critical-state.txt"]);
      expect(f.store.getAction(action.actionId)?.status).toBe("FAILED");
      expect(f.store.getAttemptsForAction(action.actionId)).toHaveLength(1);
      expect(f.store.getAttemptsForAction(action.actionId)[0]?.status).toBe("UNKNOWN");
      expect(f.store.getEventsForRun(f.runId).length).toBe(eventCountAtRecovery);
      f.expectOrderedEvents();
    } finally {
      f.writeAdapter.release.resolve();
      f.cleanup();
    }
  });

  it("IDEMPOTENT: the sweeper does not retry an in-flight read; the Action fails closed", async () => {
    const f = setupFixture({ readHold: true });
    try {
      const inFlight = settle(
        f.runtime.executeAction({
          runId: f.runId,
          leaseId: f.leaseId,
          toolName: "read_file",
          inputPayload: { path: "data.txt" },
        })
      );
      await f.readAdapter.entered.promise;
      const action = f.store.getActionsForRun(f.runId)[0]!;

      const result = f.coordinator.recoverStaleExecutions({ runId: f.runId });
      expect(result.details[0]).toMatchObject({
        resultingAttemptStatus: "UNKNOWN",
        resultingActionStatus: "FAILED",
      });

      f.readAdapter.release.resolve();
      expect((await inFlight).ok).toBe(false);
      expect(f.readAdapter.invocations).toBe(1);
      expect(f.store.getAttemptsForAction(action.actionId)).toHaveLength(1);
      expect(f.store.getAttemptsForAction(action.actionId)[0]?.status).toBe("UNKNOWN");
    } finally {
      f.readAdapter.release.resolve();
      f.cleanup();
    }
  });
});

// ============================================================================
// Scenario 4 — side effect performed, worker interrupted before terminal persistence
// ============================================================================

describe("Milestone 2.11B — Scenario 4: side effect done, outcome not yet persisted", () => {
  it("NON_IDEMPOTENT: the effect exists but recovery records uncertainty, never failure; the same request is never replayed", async () => {
    const f = setupFixture({ writeHold: "after_effect" });
    try {
      const inFlight = settle(
        f.runtime.executeAction({
          runId: f.runId,
          leaseId: f.leaseId,
          toolName: "write_file",
          inputPayload: writePayload,
        })
      );
      await f.writeAdapter.entered.promise;
      // The side effect has happened before any result was persisted.
      expect(f.effectFiles()).toEqual(["critical-state.txt"]);
      const action = f.store.getActionsForRun(f.runId)[0]!;
      expect(f.store.getAttemptsForAction(action.actionId)[0]?.status).toBe("RUNNING");

      const result = f.coordinator.recoverStaleExecutions({ runId: f.runId });
      expect(result.details[0]).toMatchObject({
        resultingAttemptStatus: "UNKNOWN",
        resultingActionStatus: "FAILED",
        retryEligible: false,
      });
      // Honest uncertainty: the Action error is EXECUTION_UNCERTAIN, not a tool failure code.
      expect(f.store.getAction(action.actionId)?.errorPayload).toMatchObject({ code: "EXECUTION_UNCERTAIN" });
      const eventsAtRecovery = f.eventTypes();
      expect(eventsAtRecovery.filter((t) => t === "attempt.unknown")).toHaveLength(1);

      // The same proposal re-submitted after recovery is replay-gated.
      const resubmitted = await f.runtime.executeAction({
        runId: f.runId,
        leaseId: f.leaseId,
        toolName: "write_file",
        inputPayload: writePayload,
      });
      expect(resubmitted.error).toMatchObject({ code: REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT });

      // The stale worker finally returns: its terminal write is rejected and changes nothing.
      f.writeAdapter.release.resolve();
      const late = await inFlight;
      expect(late.ok).toBe(false);
      expect(f.store.getAction(action.actionId)?.status).toBe("FAILED");
      expect(f.store.getAttemptsForAction(action.actionId)).toHaveLength(1);
      expect(f.store.getAttemptsForAction(action.actionId)[0]?.status).toBe("UNKNOWN");
      const types = f.eventTypes();
      expect(types.filter((t) => t === "attempt.completed")).toHaveLength(0);
      expect(types.filter((t) => t === "action.completed")).toHaveLength(0);
      expect(types.filter((t) => t === "attempt.unknown")).toHaveLength(1);
      expect(f.writeAdapter.invocations).toBe(1);
      expect(f.writeAdapter.effects).toBe(1);
      expect(f.effectFiles()).toEqual(["critical-state.txt"]);
      f.expectOrderedEvents();
    } finally {
      f.writeAdapter.release.resolve();
      f.cleanup();
    }
  });
});

// ============================================================================
// Scenario 5 — interruption after successful terminal persistence
// ============================================================================

describe("Milestone 2.11B — Scenario 5: interrupted after successful terminal persistence", () => {
  it("recovery leaves a SUCCEEDED Action untouched: no new attempt, no new events, no re-dispatch", async () => {
    const f = setupFixture();
    try {
      const done = await f.runtime.executeAction({
        runId: f.runId,
        leaseId: f.leaseId,
        toolName: "write_file",
        inputPayload: writePayload,
      });
      expect(done.status).toBe("SUCCEEDED");
      const eventsBefore = f.store.getEventsForRun(f.runId).length;

      const result = f.coordinator.recoverStaleExecutions({ runId: f.runId });

      expect(result.details).toHaveLength(0);
      expect(f.store.getAction(done.actionId)?.status).toBe("SUCCEEDED");
      expect(f.store.getAttemptsForAction(done.actionId)).toHaveLength(1);
      expect(f.store.getEventsForRun(f.runId).length).toBe(eventsBefore);
      await expect(
        f.runtime.executeAction({ runId: f.runId, leaseId: f.leaseId, actionId: done.actionId })
      ).rejects.toBeInstanceOf(TerminalStateError);
      expect(f.writeAdapter.invocations).toBe(1);
      expect(f.effectFiles()).toEqual(["critical-state.txt"]);
      f.expectOrderedEvents();
    } finally {
      f.cleanup();
    }
  });
});

// ============================================================================
// Fencing and tenant quiescence
// ============================================================================

describe("Milestone 2.11B — fencing and quiescence", () => {
  it("a worker whose lease was superseded by supervisor recovery cannot write (IDEMPOTENT retry rebinds the run)", () => {
    const f = setupFixture({ isolation: "IN_PROCESS", workerLeaseTtlMs: 10000 });
    try {
      const prior = f.seed("read_file", { path: "data.txt" }, "RUNNING");
      f.clock.advanceMs(15000);
      const sup = f.coordinator.claimSupervisorLease({
        runId: f.runId,
        supervisorId: "supervisor-1",
        ttlMs: 600000,
      });

      const recovery = f.coordinator.recoverMission({
        runId: f.runId,
        supervisorId: "supervisor-1",
        supervisorLeaseId: sup.leaseId,
      });
      expect(recovery.previousAttempt?.status).toBe("UNKNOWN");
      expect(recovery.newAttempt?.attemptNumber).toBe(2);

      expect(() =>
        f.store.transaction((tx) =>
          tx.transitionAction(
            prior.actionId,
            { type: "SUCCEED", resultPayload: { stale: true }, now: f.clock.nowIso() },
            () => crypto.randomUUID(),
            f.fencing
          )
        )
      ).toThrow(LeaseLostError);
      expect(f.store.getAction(prior.actionId)?.status).toBe("RUNNING");
      expect(f.store.getAttemptsForAction(prior.actionId)).toHaveLength(2);
      f.expectOrderedEvents();
    } finally {
      f.cleanup();
    }
  });

  it("an isolated run's recoverMission without a QUIESCED gate throws and changes nothing", () => {
    const f = setupFixture({ isolation: "ISOLATED", workerLeaseTtlMs: 10000 });
    try {
      const prior = f.seed("write_file", writePayload, "RUNNING");
      f.clock.advanceMs(15000);
      const sup = f.coordinator.claimSupervisorLease({
        runId: f.runId,
        supervisorId: "supervisor-1",
        ttlMs: 600000,
      });
      const eventsBefore = f.store.getEventsForRun(f.runId).length;

      expect(() =>
        f.coordinator.recoverMission({
          runId: f.runId,
          supervisorId: "supervisor-1",
          supervisorLeaseId: sup.leaseId,
        })
      ).toThrow(TenantQuiescenceRequiredError);

      expect(f.store.getAction(prior.actionId)?.status).toBe("RUNNING");
      const attempts = f.store.getAttemptsForAction(prior.actionId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.status).toBe("RUNNING");
      expect(f.store.getEventsForRun(f.runId).length).toBe(eventsBefore);
      expect(f.writeAdapter.invocations).toBe(0);
      expect(f.effectFiles()).toEqual([]);
    } finally {
      f.cleanup();
    }
  });
});
