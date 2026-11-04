/**
 * Milestone 2.13A — Recovery of Actions that have no Attempt (or a stale one)
 *
 * WorkerRuntime.executeAction persists an Action, its AUTHORIZE and START_ATTEMPT transitions, and the
 * Attempt row in separate transactions, so a worker can stop with an open Action that has no Attempt
 * row. Recovery must not invent an Attempt outcome, must not dispatch a tool, and must not reopen a
 * terminal Action. Only an explicit executeAction re-entry may continue such an Action; the runtime can
 * prove that it never reached the adapter because the adapter is only invoked after an Attempt row has
 * been inserted, dispatched and started.
 *
 * Explicit limits (not proven here, by design):
 * - Delivery stays at-least-once; no exactly-once claim is made.
 * - Lease expiry is not treated as proof the earlier process stopped.
 * - A recovered Action with no Attempt is left unchanged (open) by recovery itself; resolving it is the
 *   caller's explicit executeAction re-entry, not an automatic dispatch.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { Action } from "../../src/domain/action.js";
import { Attempt } from "../../src/domain/attempt.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import type { ExtendedToolName } from "../../src/domain/tool.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { StaticToolAdapterRegistry } from "../../src/ports/tool-adapter.port.js";
import type { ToolAdapter } from "../../src/ports/tool-adapter.port.js";
import { createAndActivateContract } from "./test-helpers.js";

class CountingWriteAdapter implements ToolAdapter<"write_file"> {
  readonly toolName = "write_file" as const;
  invocations = 0;
  constructor(private readonly effectsDir: string) {}
  async execute(_context: unknown, input: { path: string; content: string }) {
    this.invocations++;
    fs.writeFileSync(path.join(this.effectsDir, input.path), input.content);
    return { path: input.path, bytesWritten: Buffer.byteLength(input.content, "utf8"), created: true };
  }
}

class CountingReadAdapter implements ToolAdapter<"read_file"> {
  readonly toolName = "read_file" as const;
  invocations = 0;
  async execute(_context: unknown, input: { path: string }) {
    this.invocations++;
    return { path: input.path, content: "x", bytesRead: 1, isTruncated: false };
  }
}

type Idem = "IDEMPOTENT" | "NON_IDEMPOTENT";
type Stage = "CREATED" | "AUTHORIZED" | "RUNNING_NO_ROW";

function setupFixture() {
  const clock = new SettableClock(new Date().toISOString());
  const store = new SqliteStateStore();
  const coordinator = new RunCoordinator(store, clock);
  const workerId = "worker-missing-attempt";

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
    title: "missing-attempt-task",
    description: "Recovery of Actions without Attempts",
    inputPayload: { target: "test" },
  });
  createAndActivateContract(store, task.taskId, {
    policy: createExecutionPolicy({
      policyId: `policy-${task.taskId}`,
      allowedCapabilities: ["workspace.file.read", "workspace.file.write"],
      isolationRequirement: "IN_PROCESS",
    }),
    timeoutMs: 10000,
    maxOutputBytes: 1048576,
    maxAttempts: 3,
  });

  const { run } = coordinator.createRun({ taskId: task.taskId });
  coordinator.queueRun(run.runId);
  const claim = coordinator.claimRun(run.runId, workerId, 10000);
  const started = coordinator.startRun(run.runId, workerId, claim.lease.leaseId);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-missing-attempt-"));
  const effectsDir = path.join(tempDir, "effects");
  fs.mkdirSync(effectsDir);
  const writeAdapter = new CountingWriteAdapter(effectsDir);
  const readAdapter = new CountingReadAdapter();
  const runtime = new WorkerRuntime({
    workerId,
    coordinator,
    clock,
    workspacePort: new NodeFsWorkspaceAdapter({ workspaceRoot: path.join(tempDir, "ws") }),
    toolAdapterRegistry: new StaticToolAdapterRegistry([writeAdapter, readAdapter]),
  });

  const runId = run.runId;
  const fencing = { workerId, leaseId: claim.lease.leaseId };
  const gen = () => crypto.randomUUID();

  function createAction(idem: Idem) {
    const toolName: ExtendedToolName = idem === "IDEMPOTENT" ? "read_file" : "write_file";
    const inputPayload = idem === "IDEMPOTENT" ? { path: "data.txt" } : { path: "state.txt", content: "data" };
    const actionId = "act-missing-1";
    const { action, event } = Action.create({
      actionId,
      runId,
      sequenceNumber: 1,
      toolName,
      inputPayload,
      contractBinding: started.run.contractBinding!,
      maxAttempts: 3,
      now: clock.nowIso(),
    });
    store.transaction((tx) => tx.insertAction(action.snapshot, event, fencing));
    return actionId;
  }

  /** An open Action whose Attempt row was never inserted. */
  function seedNoAttempt(idem: Idem, stage: Stage) {
    const actionId = createAction(idem);
    const now = clock.nowIso();
    store.transaction((tx) => {
      if (stage === "CREATED") return;
      tx.transitionAction(actionId, { type: "AUTHORIZE", now }, gen);
      if (stage === "AUTHORIZED") return;
      tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 1, now }, gen);
    });
    return { actionId };
  }

  /** A terminal Action that was rejected before dispatch: zero Attempts. */
  function seedDeniedTerminal(idem: Idem) {
    const actionId = createAction(idem);
    store.transaction((tx) =>
      tx.transitionAction(
        actionId,
        { type: "FAIL", errorPayload: { code: "CAPABILITY_DENIED" }, now: clock.nowIso() },
        gen
      )
    );
    return { actionId };
  }

  /**
   * Attempt 1 FAILED, the Action was moved to RETRYING and START_ATTEMPT 2 was recorded, but the worker
   * stopped before inserting the Attempt 2 row. Attempt 2 therefore never reached the adapter.
   */
  function seedRetryWindow(idem: Idem) {
    const actionId = createAction(idem);
    const now = clock.nowIso();
    const attemptId = "att-missing-1";
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
      tx.transitionAction(actionId, { type: "AUTHORIZE", now }, gen);
      tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 1, now }, gen);
      tx.insertAttempt(attempt.snapshot, attEvent, fencing);
      tx.transitionAttempt(attemptId, { type: "DISPATCH", now }, gen);
      tx.transitionAttempt(attemptId, { type: "START", now }, gen);
      tx.transitionAttempt(
        attemptId,
        { type: "FAIL", errorPayload: { code: "TOOL_EXECUTION_FAILED" }, exitCode: null, durationMs: 1, now },
        gen
      );
      tx.transitionAction(actionId, { type: "PREPARE_RETRY", errorPayload: "retry", now }, gen);
      tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 2, now }, gen);
    });
    return { actionId };
  }

  async function recoverViaSweeper() {
    return runtime.recoverStaleExecutions({ runId, executeRetries: true });
  }

  let supervisorLease: { leaseId: string } | null = null;
  async function recoverViaSupervisor() {
    if (!supervisorLease) {
      clock.advanceMs(15000);
      supervisorLease = coordinator.claimSupervisorLease({ runId, supervisorId: "supervisor-1", ttlMs: 600000 });
    }
    return coordinator.recoverMission({
      runId,
      supervisorId: "supervisor-1",
      supervisorLeaseId: supervisorLease.leaseId,
    });
  }

  function snapshot(actionId: string) {
    const action = store.getAction(actionId);
    return {
      action: action?.status,
      activeAttemptNumber: action?.activeAttemptNumber,
      totalAttempts: action?.totalAttempts,
      attempts: store.getAttemptsForAction(actionId).map((a) => `${a.attemptNumber}:${a.status}`),
      events: store.getEventsForRun(runId).map((e) => e.eventType),
      writeCalls: writeAdapter.invocations,
      readCalls: readAdapter.invocations,
    };
  }

  function expectOrderedEvents(): void {
    const events = store.getEventsForRun(runId);
    expect(new Set(events.map((e) => e.eventId)).size).toBe(events.length);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.sequence).toBe(events[i - 1]!.sequence + 1);
    }
  }

  return {
    runtime,
    store,
    runId,
    fencing,
    leaseId: claim.lease.leaseId,
    seedNoAttempt,
    seedDeniedTerminal,
    seedRetryWindow,
    recoverViaSweeper,
    recoverViaSupervisor,
    snapshot,
    expectOrderedEvents,
    effectFiles: () => fs.readdirSync(effectsDir).sort(),
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

const ENTRIES = ["sweeper", "supervisor"] as const;

describe("Milestone 2.13A — an open Action with no Attempt row", () => {
  for (const idem of ["IDEMPOTENT", "NON_IDEMPOTENT"] as const) {
    for (const stage of ["CREATED", "AUTHORIZED", "RUNNING_NO_ROW"] as const) {
      for (const entry of ENTRIES) {
        it(`${entry}: ${stage} + ${idem} is left unchanged, nothing is dispatched, and repeating changes nothing`, async () => {
          const f = setupFixture();
          try {
            const prior = f.seedNoAttempt(idem, stage);
            const before = f.snapshot(prior.actionId);
            const run = async () => {
              if (entry === "sweeper") await f.recoverViaSweeper();
              else await f.recoverViaSupervisor();
            };

            await run();
            expect(f.snapshot(prior.actionId)).toEqual(before);
            expect(before.attempts).toEqual([]);

            await run();
            expect(f.snapshot(prior.actionId)).toEqual(before);
            expect(f.effectFiles()).toEqual([]);
            f.expectOrderedEvents();
          } finally {
            f.cleanup();
          }
        });
      }
    }

    it(`${idem}: an explicit executeAction re-entry continues a RUNNING Action with no Attempt row exactly once`, async () => {
      const f = setupFixture();
      try {
        const prior = f.seedNoAttempt(idem, "RUNNING_NO_ROW");

        const res = await f.runtime.executeAction({
          runId: f.runId,
          leaseId: f.leaseId,
          actionId: prior.actionId,
        });

        expect(res.status).toBe("SUCCEEDED");
        const after = f.snapshot(prior.actionId);
        expect(after.attempts).toEqual(["1:SUCCEEDED"]);
        expect(idem === "IDEMPOTENT" ? after.readCalls : after.writeCalls).toBe(1);
        f.expectOrderedEvents();
      } finally {
        f.cleanup();
      }
    });
  }
});

describe("Milestone 2.13A — a terminal Action with no Attempt", () => {
  for (const idem of ["IDEMPOTENT", "NON_IDEMPOTENT"] as const) {
    for (const entry of ENTRIES) {
      it(`${entry}: a denied (FAILED, zero Attempts) ${idem} Action is not reopened`, async () => {
        const f = setupFixture();
        try {
          const prior = f.seedDeniedTerminal(idem);
          const before = f.snapshot(prior.actionId);

          if (entry === "sweeper") await f.recoverViaSweeper();
          else await f.recoverViaSupervisor();
          if (entry === "sweeper") await f.recoverViaSweeper();
          else await f.recoverViaSupervisor();

          expect(f.snapshot(prior.actionId)).toEqual(before);
          expect(before.action).toBe("FAILED");
          expect(before.attempts).toEqual([]);
          f.expectOrderedEvents();
        } finally {
          f.cleanup();
        }
      });
    }
  }
});

describe("Milestone 2.13A — RETRYING window: START_ATTEMPT recorded, Attempt row missing", () => {
  for (const entry of ENTRIES) {
    it(`${entry}, IDEMPOTENT: recovery leaves the Action alone (Attempt 2 never reached the adapter); re-entry then runs it as Attempt 2`, async () => {
      const f = setupFixture();
      try {
        const prior = f.seedRetryWindow("IDEMPOTENT");
        const before = f.snapshot(prior.actionId);
        expect(before.action).toBe("RUNNING");
        expect(before.attempts).toEqual(["1:FAILED"]);

        // Recovery would previously convert this to RETRYING and compute Attempt 3, which the store's
        // gapless-numbering invariant rejects, leaving the Action stuck. It must now change nothing.
        for (let i = 0; i < 2; i++) {
          if (entry === "sweeper") await f.recoverViaSweeper();
          else await f.recoverViaSupervisor();
          expect(f.snapshot(prior.actionId)).toEqual(before);
        }
        expect(before.readCalls).toBe(0);

        // The supervisor variant advances the clock past the worker lease, so a re-entry there would
        // (correctly) be fenced as expired; the continuation is demonstrated on the sweeper variant.
        if (entry === "supervisor") {
          f.expectOrderedEvents();
          return;
        }

        const res = await f.runtime.executeAction({
          runId: f.runId,
          leaseId: f.leaseId,
          actionId: prior.actionId,
        });
        expect(res.status).toBe("SUCCEEDED");
        const after = f.snapshot(prior.actionId);
        expect(after.attempts).toEqual(["1:FAILED", "2:SUCCEEDED"]);
        expect(after.readCalls).toBe(1);
        f.expectOrderedEvents();
      } finally {
        f.cleanup();
      }
    });
  }

  it("sweeper, NON_IDEMPOTENT: failed closed, never dispatched", async () => {
    const f = setupFixture();
    try {
      const prior = f.seedRetryWindow("NON_IDEMPOTENT");

      await f.recoverViaSweeper();

      const after = f.snapshot(prior.actionId);
      expect(after.action).toBe("FAILED");
      expect(after.attempts).toEqual(["1:FAILED"]);
      expect(after.writeCalls).toBe(0);
      expect(f.effectFiles()).toEqual([]);
      f.expectOrderedEvents();
    } finally {
      f.cleanup();
    }
  });

  it("supervisor, NON_IDEMPOTENT: failed closed, no replacement Attempt", async () => {
    const f = setupFixture();
    try {
      const prior = f.seedRetryWindow("NON_IDEMPOTENT");

      await f.recoverViaSupervisor();

      const after = f.snapshot(prior.actionId);
      expect(after.action).toBe("FAILED");
      expect(after.attempts).toEqual(["1:FAILED"]);
      expect(after.writeCalls).toBe(0);
      f.expectOrderedEvents();
    } finally {
      f.cleanup();
    }
  });
});
