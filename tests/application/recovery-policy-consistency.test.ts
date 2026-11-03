/**
 * Milestone 2.12A — Unified Recovery Policy
 *
 * Drives the same durable states through both recovery entry points and asserts the outcome:
 * - sweeper:    WorkerRuntime.recoverStaleExecutions (RunCoordinator.recoverStaleExecutions + retry execution)
 * - supervisor: RunCoordinator.recoverMission, after which the recovered worker runs any replacement Attempt
 *
 * The one intentional difference: an uncertain IDEMPOTENT Attempt (DISPATCHED / RUNNING / UNKNOWN) is
 * retried only on the supervisor path, whose supervisor lease is fenced and whose tenant-quiescence
 * requirement has already been enforced. The sweeper has neither proof, so it fails closed.
 *
 * Explicit limits (not proven here, by design):
 * - Delivery stays at-least-once; no exactly-once claim is made.
 * - Lease expiry is not treated as proof the earlier process stopped.
 * - Retrying an IDEMPOTENT tool follows its declared classification, not proof that it has no side effects.
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
import { LeaseLostError, TenantQuiescenceRequiredError } from "../../src/domain/errors.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import type { ExtendedToolName } from "../../src/domain/tool.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { StaticToolAdapterRegistry } from "../../src/ports/tool-adapter.port.js";
import type { ToolAdapter } from "../../src/ports/tool-adapter.port.js";
import { createAndActivateContract } from "./test-helpers.js";

// ============================================================================
// Counting adapters (real file side effect for the NON_IDEMPOTENT tool)
// ============================================================================

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

// ============================================================================
// Fixture
// ============================================================================

type SeedState = "CREATED" | "DISPATCHED" | "RUNNING" | "UNKNOWN" | "SUCCEEDED" | "FAILED";
type Idem = "IDEMPOTENT" | "NON_IDEMPOTENT";

const RECOVERED_LEASE = "lease-recovered-2-12a";

function setupFixture(isolation: "ISOLATED" | "IN_PROCESS" = "IN_PROCESS") {
  const clock = new SettableClock(new Date().toISOString());
  const store = new SqliteStateStore();
  const coordinator = new RunCoordinator(store, clock);
  const workerId = "worker-policy";

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
    title: "policy-task",
    description: "Recovery policy consistency",
    inputPayload: { target: "test" },
  });

  createAndActivateContract(store, task.taskId, {
    policy: createExecutionPolicy({
      policyId: `policy-${task.taskId}`,
      allowedCapabilities: ["workspace.file.read", "workspace.file.write"],
      isolationRequirement: isolation,
    }),
    timeoutMs: 10000,
    maxOutputBytes: 1048576,
    maxAttempts: 3,
  });

  const { run } = coordinator.createRun({ taskId: task.taskId });
  coordinator.queueRun(run.runId);
  const claim = coordinator.claimRun(run.runId, workerId, 10000);
  const started = coordinator.startRun(run.runId, workerId, claim.lease.leaseId);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-policy-"));
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

  function seed(idem: Idem, state: SeedState, actionStatus: "RUNNING" | "TERMINAL" = "RUNNING") {
    const toolName: ExtendedToolName = idem === "IDEMPOTENT" ? "read_file" : "write_file";
    const inputPayload = idem === "IDEMPOTENT" ? { path: "data.txt" } : { path: "critical-state.txt", content: "data" };
    const actionId = "act-policy-1";
    const attemptId = "att-policy-1";
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
    const gen = () => crypto.randomUUID();
    store.transaction((tx) => {
      tx.insertAction(action.snapshot, event, fencing);
      tx.transitionAction(actionId, { type: "AUTHORIZE", now }, gen);
      tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 1, now }, gen);
      tx.insertAttempt(attempt.snapshot, attEvent, fencing);
      if (state === "CREATED") return;
      tx.transitionAttempt(attemptId, { type: "DISPATCH", now }, gen);
      if (state === "DISPATCHED") return;
      tx.transitionAttempt(attemptId, { type: "START", now }, gen);
      if (state === "RUNNING") return;
      if (state === "UNKNOWN") {
        tx.transitionAttempt(
          attemptId,
          { type: "MARK_UNKNOWN", reason: "interrupted", reasonCode: "LEASE_EXPIRED_DURING_EXECUTION", now },
          gen
        );
      } else if (state === "SUCCEEDED") {
        tx.transitionAttempt(
          attemptId,
          { type: "COMPLETE", outputPayload: { ok: true }, exitCode: 0, durationMs: 1, now },
          gen
        );
      } else {
        tx.transitionAttempt(
          attemptId,
          { type: "FAIL", errorPayload: { code: "TOOL_EXECUTION_FAILED" }, exitCode: null, durationMs: 1, now },
          gen
        );
      }
      if (actionStatus === "TERMINAL") {
        if (state === "SUCCEEDED") {
          tx.transitionAction(actionId, { type: "SUCCEED", resultPayload: { ok: true }, now }, gen);
        } else {
          tx.transitionAction(
            actionId,
            { type: "FAIL", errorPayload: { code: "EXECUTION_UNCERTAIN" }, now },
            gen
          );
        }
      }
    });
    return { actionId, attemptId };
  }

  /** WorkerRuntime sweeper: reconcile, then execute eligible RETRYING actions. */
  async function recoverViaSweeper() {
    return runtime.recoverStaleExecutions({ runId, executeRetries: true });
  }

  /** Supervisor path: recoverMission, then the recovered worker runs any replacement Attempt. */
  let supervisorLease: { leaseId: string } | null = null;
  async function recoverViaSupervisor() {
    if (!supervisorLease) {
      clock.advanceMs(15000);
      supervisorLease = coordinator.claimSupervisorLease({ runId, supervisorId: "supervisor-1", ttlMs: 600000 });
    }
    const sup = supervisorLease;
    const result = coordinator.recoverMission({
      runId,
      supervisorId: "supervisor-1",
      supervisorLeaseId: sup.leaseId,
      newWorkerId: workerId,
      newWorkerLeaseId: RECOVERED_LEASE,
    });
    for (const action of store.getActionsForRun(runId)) {
      const open = store.getAttemptsForAction(action.actionId).some((a) => a.status === "CREATED");
      if (open && action.status === "RUNNING") {
        await runtime.executeAction({ runId, leaseId: RECOVERED_LEASE, actionId: action.actionId });
      }
    }
    return { result, supLeaseId: sup.leaseId };
  }

  function outcome(actionId: string) {
    return {
      action: store.getAction(actionId)?.status,
      attempts: store.getAttemptsForAction(actionId).map((a) => `${a.attemptNumber}:${a.status}`),
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
    clock,
    store,
    coordinator,
    runtime,
    runId,
    workerId,
    fencing,
    seed,
    recoverViaSweeper,
    recoverViaSupervisor,
    outcome,
    expectOrderedEvents,
    eventTypes: () => store.getEventsForRun(runId).map((e) => e.eventType),
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

// ============================================================================
// Expected outcomes (shared policy decision table)
// ============================================================================

interface Expected {
  readonly action: string;
  readonly attempts: readonly string[];
  /** Adapter invocations of the seeded Action's tool after recovery. */
  readonly calls: number;
}

const FAIL_CLOSED = (attempt: string): Expected => ({ action: "FAILED", attempts: [attempt], calls: 0 });
const RETRIED = (first: string): Expected => ({
  action: "SUCCEEDED",
  attempts: [first, "2:SUCCEEDED"],
  calls: 1,
});

interface Case {
  readonly state: SeedState;
  readonly idem: Idem;
  readonly sweeper: Expected;
  readonly supervisor: Expected;
}

const CASES: readonly Case[] = [
  // Never dispatched: the Attempt is cancelled; only IDEMPOTENT work is retried.
  { state: "CREATED", idem: "NON_IDEMPOTENT", sweeper: FAIL_CLOSED("1:CANCELLED"), supervisor: FAIL_CLOSED("1:CANCELLED") },
  { state: "CREATED", idem: "IDEMPOTENT", sweeper: RETRIED("1:CANCELLED"), supervisor: RETRIED("1:CANCELLED") },
  // May have reached the adapter: NON_IDEMPOTENT never retried; IDEMPOTENT retried only with supervisor evidence.
  { state: "DISPATCHED", idem: "NON_IDEMPOTENT", sweeper: FAIL_CLOSED("1:UNKNOWN"), supervisor: FAIL_CLOSED("1:UNKNOWN") },
  { state: "DISPATCHED", idem: "IDEMPOTENT", sweeper: FAIL_CLOSED("1:UNKNOWN"), supervisor: RETRIED("1:UNKNOWN") },
  { state: "RUNNING", idem: "NON_IDEMPOTENT", sweeper: FAIL_CLOSED("1:UNKNOWN"), supervisor: FAIL_CLOSED("1:UNKNOWN") },
  { state: "RUNNING", idem: "IDEMPOTENT", sweeper: FAIL_CLOSED("1:UNKNOWN"), supervisor: RETRIED("1:UNKNOWN") },
  // Already UNKNOWN under an open Action: uncertainty is preserved, never converted to failure or success.
  { state: "UNKNOWN", idem: "NON_IDEMPOTENT", sweeper: FAIL_CLOSED("1:UNKNOWN"), supervisor: FAIL_CLOSED("1:UNKNOWN") },
  { state: "UNKNOWN", idem: "IDEMPOTENT", sweeper: FAIL_CLOSED("1:UNKNOWN"), supervisor: RETRIED("1:UNKNOWN") },
  // Terminal Attempt under an open Action (crash before the Action was updated): reconcile, never replay a success.
  { state: "SUCCEEDED", idem: "NON_IDEMPOTENT", sweeper: { action: "SUCCEEDED", attempts: ["1:SUCCEEDED"], calls: 0 }, supervisor: { action: "SUCCEEDED", attempts: ["1:SUCCEEDED"], calls: 0 } },
  { state: "SUCCEEDED", idem: "IDEMPOTENT", sweeper: { action: "SUCCEEDED", attempts: ["1:SUCCEEDED"], calls: 0 }, supervisor: { action: "SUCCEEDED", attempts: ["1:SUCCEEDED"], calls: 0 } },
  { state: "FAILED", idem: "NON_IDEMPOTENT", sweeper: FAIL_CLOSED("1:FAILED"), supervisor: FAIL_CLOSED("1:FAILED") },
  { state: "FAILED", idem: "IDEMPOTENT", sweeper: RETRIED("1:FAILED"), supervisor: RETRIED("1:FAILED") },
];

describe("Milestone 2.12A — both recovery entry points follow one policy", () => {
  for (const c of CASES) {
    for (const entry of ["sweeper", "supervisor"] as const) {
      it(`${entry}: ${c.state} + ${c.idem}`, async () => {
        const f = setupFixture();
        try {
          const prior = f.seed(c.idem, c.state);
          if (entry === "sweeper") await f.recoverViaSweeper();
          else await f.recoverViaSupervisor();

          const expected = c[entry];
          const got = f.outcome(prior.actionId);
          expect(got.action).toBe(expected.action);
          expect(got.attempts).toEqual(expected.attempts);
          const calls = c.idem === "IDEMPOTENT" ? got.readCalls : got.writeCalls;
          expect(calls).toBe(expected.calls);
          if (c.idem === "NON_IDEMPOTENT") {
            // A NON_IDEMPOTENT adapter is never invoked by recovery, so no side effect can appear.
            expect(f.effectFiles()).toEqual([]);
          }
          f.expectOrderedEvents();
        } finally {
          f.cleanup();
        }
      });
    }
  }
});

describe("Milestone 2.12A — terminal Actions are not reopened", () => {
  for (const [state, label] of [
    ["SUCCEEDED", "SUCCEEDED"],
    ["UNKNOWN", "FAILED after UNKNOWN"],
  ] as const) {
    for (const idem of ["IDEMPOTENT", "NON_IDEMPOTENT"] as const) {
      for (const entry of ["sweeper", "supervisor"] as const) {
        it(`${entry}: ${label} Action (${idem}) is unchanged`, async () => {
          const f = setupFixture();
          try {
            const prior = f.seed(idem, state, "TERMINAL");
            const before = f.outcome(prior.actionId);
            const eventsBefore = f.store.getEventsForRun(f.runId).length;

            if (entry === "sweeper") await f.recoverViaSweeper();
            else await f.recoverViaSupervisor();

            expect(f.outcome(prior.actionId)).toEqual(before);
            expect(f.store.getEventsForRun(f.runId).length).toBe(eventsBefore);
            f.expectOrderedEvents();
          } finally {
            f.cleanup();
          }
        });
      }
    }
  }
});

describe("Milestone 2.12A — repeated recovery is safe", () => {
  for (const c of CASES) {
    for (const entry of ["sweeper", "supervisor"] as const) {
      it(`${entry}: running recovery twice after ${c.state} + ${c.idem} adds no Attempts or terminal events`, async () => {
        const f = setupFixture();
        try {
          const prior = f.seed(c.idem, c.state);
          const run = async () => {
            if (entry === "sweeper") await f.recoverViaSweeper();
            else await f.recoverViaSupervisor();
          };
          await run();
          const afterFirst = f.outcome(prior.actionId);
          const eventsAfterFirst = f.eventTypes();

          await run();

          expect(f.outcome(prior.actionId)).toEqual(afterFirst);
          expect(f.eventTypes()).toEqual(eventsAfterFirst);
          const terminalEvents = f
            .eventTypes()
            .filter((t) => t === "action.completed" || t === "action.failed");
          expect(terminalEvents.length).toBeLessThanOrEqual(1);
          f.expectOrderedEvents();
        } finally {
          f.cleanup();
        }
      });
    }
  }
});

describe("Milestone 2.12A — fencing and quiescence", () => {
  it("a stale worker cannot write after supervisor recovery rebinds the run", async () => {
    const f = setupFixture();
    try {
      const prior = f.seed("IDEMPOTENT", "RUNNING");
      await f.recoverViaSupervisor();

      expect(() =>
        f.store.transaction((tx) =>
          tx.transitionAction(
            prior.actionId,
            { type: "FAIL", errorPayload: { stale: true }, now: f.clock.nowIso() },
            () => crypto.randomUUID(),
            f.fencing
          )
        )
      ).toThrow(LeaseLostError);
      expect(f.outcome(prior.actionId).action).toBe("SUCCEEDED");
      f.expectOrderedEvents();
    } finally {
      f.cleanup();
    }
  });

  for (const idem of ["IDEMPOTENT", "NON_IDEMPOTENT"] as const) {
    it(`an isolated run's supervisor recovery without a QUIESCED gate mutates nothing (${idem})`, () => {
      const f = setupFixture("ISOLATED");
      try {
        const prior = f.seed(idem, "RUNNING");
        f.clock.advanceMs(15000);
        const sup = f.coordinator.claimSupervisorLease({
          runId: f.runId,
          supervisorId: "supervisor-1",
          ttlMs: 600000,
        });
        const before = f.outcome(prior.actionId);
        const eventsBefore = f.store.getEventsForRun(f.runId).length;

        expect(() =>
          f.coordinator.recoverMission({
            runId: f.runId,
            supervisorId: "supervisor-1",
            supervisorLeaseId: sup.leaseId,
          })
        ).toThrow(TenantQuiescenceRequiredError);

        expect(f.outcome(prior.actionId)).toEqual(before);
        expect(f.store.getEventsForRun(f.runId).length).toBe(eventsBefore);
        expect(f.effectFiles()).toEqual([]);
      } finally {
        f.cleanup();
      }
    });
  }
});
