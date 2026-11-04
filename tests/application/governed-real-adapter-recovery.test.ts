/**
 * Milestone 2.13A — Real governed execution path, interruption, and the idempotency-token boundary
 *
 * Unlike the seeded-state recovery tests, these run the real WorkerRuntime.executeAction through the
 * real ToolExecutionGateway and the real read_file / write_file adapters against an actual temporary
 * workspace. Only the interruption is injected: a decorator performs the real write and then blocks on
 * an explicit barrier, so the worker is "interrupted" after the side effect and before any outcome is
 * persisted. No sleeps and no process kills are used.
 *
 * Explicit limits (not proven here, by design):
 * - Delivery stays at-least-once; no exactly-once claim is made.
 * - Interruption is simulated in-process; there is no cross-process crash test.
 * - Lease expiry is not treated as proof the earlier process stopped.
 * - The token tests document the CURRENT boundary: the Attempt token is persisted and unique per
 *   Attempt row, but is not passed to any adapter, so no adapter deduplicates side effects with it.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkspaceToolAdapterRegistry } from "../../src/adapters/tools/tool-adapter-registry.factory.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import {
  REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT,
  WorkerRuntime,
} from "../../src/application/worker-runtime.js";
import { Action } from "../../src/domain/action.js";
import { Attempt, createAttemptIdempotencyToken } from "../../src/domain/attempt.js";
import { DuplicateAttemptTokenError, TenantQuiescenceRequiredError } from "../../src/domain/errors.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { StaticToolAdapterRegistry } from "../../src/ports/tool-adapter.port.js";
import type { ToolAdapter, ToolExecutionContext } from "../../src/ports/tool-adapter.port.js";
import { createAndActivateContract } from "./test-helpers.js";

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

/**
 * Wraps the REAL write_file adapter. It records the context it was given, performs the real write,
 * and optionally blocks afterwards so the caller can interrupt before any outcome is persisted.
 */
class InterruptibleRealWriteAdapter implements ToolAdapter<"write_file"> {
  readonly toolName = "write_file" as const;
  invocations = 0;
  contextKeys: string[] = [];
  readonly entered = deferred();
  readonly release = deferred();

  constructor(
    private readonly inner: ToolAdapter<"write_file">,
    private readonly holdAfterEffect: boolean
  ) {}

  async execute(context: ToolExecutionContext, input: Parameters<ToolAdapter<"write_file">["execute"]>[1]) {
    this.invocations++;
    this.contextKeys = Object.keys(context);
    const output = await this.inner.execute(context, input);
    this.entered.resolve();
    if (this.holdAfterEffect) await this.release.promise;
    return output;
  }
}

function setupFixture(options: { holdAfterEffect?: boolean; workerLeaseTtlMs?: number } = {}) {
  const clock = new SettableClock(new Date().toISOString());
  const store = new SqliteStateStore();
  const coordinator = new RunCoordinator(store, clock);
  const workerId = "worker-real-governed";

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
    title: "real-governed-task",
    description: "Real governed execution validation",
    inputPayload: { target: "test" },
  });
  createAndActivateContract(store, task.taskId, {
    policy: createExecutionPolicy({
      policyId: `policy-${task.taskId}`,
      allowedCapabilities: ["workspace.file.read", "workspace.file.write"],
      isolationRequirement: "ISOLATED",
    }),
    timeoutMs: 10000,
    maxOutputBytes: 1048576,
    maxAttempts: 3,
  });

  const { run } = coordinator.createRun({ taskId: task.taskId });
  coordinator.queueRun(run.runId);
  const claim = coordinator.claimRun(run.runId, workerId, options.workerLeaseTtlMs ?? 60000);
  coordinator.startRun(run.runId, workerId, claim.lease.leaseId);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-real-governed-"));
  const workspacePort = new NodeFsWorkspaceAdapter({ workspaceRoot: tempDir });
  const real = createWorkspaceToolAdapterRegistry(workspacePort);
  const writeAdapter = new InterruptibleRealWriteAdapter(
    real.getAdapter("write_file")!,
    options.holdAfterEffect ?? false
  );
  const runtime = new WorkerRuntime({
    workerId,
    coordinator,
    clock,
    workspacePort,
    toolAdapterRegistry: new StaticToolAdapterRegistry([writeAdapter, real.getAdapter("read_file")!]),
  });

  const runId = run.runId;

  /** The real file the real adapter wrote, wherever the workspace placed it. */
  function findFile(name: string): string | null {
    const walk = (dir: string): string | null => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          const hit = walk(full);
          if (hit) return hit;
        } else if (e.name === name) {
          return full;
        }
      }
      return null;
    };
    return walk(tempDir);
  }

  function eventTypes(): string[] {
    return store.getEventsForRun(runId).map((e) => e.eventType);
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
    leaseId: claim.lease.leaseId,
    writeAdapter,
    findFile,
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

function settle<T>(p: Promise<T>) {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
}

const writeInput = { path: "report.txt", content: "real governed content" };

describe("Milestone 2.13A — real governed execution (no interruption)", () => {
  it("a file mutation and a read-only operation both succeed through the real gateway and adapters", async () => {
    const f = setupFixture();
    try {
      const written = await f.runtime.executeAction({
        runId: f.runId,
        leaseId: f.leaseId,
        toolName: "write_file",
        inputPayload: writeInput,
      });
      expect(written.status).toBe("SUCCEEDED");
      expect(written.output).toMatchObject({
        path: "report.txt",
        created: true,
        contentHash: crypto.createHash("sha256").update(writeInput.content, "utf8").digest("hex"),
      });
      const file = f.findFile("report.txt");
      expect(file).not.toBeNull();
      expect(fs.readFileSync(file!, "utf8")).toBe(writeInput.content);

      const read = await f.runtime.executeAction({
        runId: f.runId,
        leaseId: f.leaseId,
        toolName: "read_file",
        inputPayload: { path: "report.txt" },
      });
      expect(read.status).toBe("SUCCEEDED");
      expect(read.output).toMatchObject({ path: "report.txt", content: writeInput.content });

      expect(f.writeAdapter.invocations).toBe(1);
      for (const r of [written, read]) {
        expect(f.store.getAttemptsForAction(r.actionId)).toHaveLength(1);
        expect(f.store.getAttemptsForAction(r.actionId)[0]?.status).toBe("SUCCEEDED");
      }
      f.expectOrderedEvents();
    } finally {
      f.cleanup();
    }
  });
});

describe("Milestone 2.13A — real write, then interruption before the outcome is persisted", () => {
  it("recovery keeps the Attempt UNKNOWN, the real file stays, the same write is replay-gated, and the stale worker cannot overwrite", async () => {
    const f = setupFixture({ holdAfterEffect: true });
    try {
      const inFlight = settle(
        f.runtime.executeAction({
          runId: f.runId,
          leaseId: f.leaseId,
          toolName: "write_file",
          inputPayload: writeInput,
        })
      );
      await f.writeAdapter.entered.promise;

      // The real side effect is already on disk; nothing has been persisted about the outcome.
      const file = f.findFile("report.txt");
      expect(file).not.toBeNull();
      expect(fs.readFileSync(file!, "utf8")).toBe(writeInput.content);
      const action = f.store.getActionsForRun(f.runId)[0]!;
      expect(action.status).toBe("RUNNING");
      expect(f.store.getAttemptsForAction(action.actionId)[0]?.status).toBe("RUNNING");

      const recovery = f.coordinator.recoverStaleExecutions({ runId: f.runId });
      expect(recovery.details[0]).toMatchObject({
        resultingAttemptStatus: "UNKNOWN",
        resultingActionStatus: "FAILED",
        retryEligible: false,
      });
      expect(f.store.getAction(action.actionId)?.errorPayload).toMatchObject({ code: "EXECUTION_UNCERTAIN" });

      // Same proposal re-submitted: refused by the replay gate, the adapter is not called again.
      const resubmitted = await f.runtime.executeAction({
        runId: f.runId,
        leaseId: f.leaseId,
        toolName: "write_file",
        inputPayload: writeInput,
      });
      expect(resubmitted.error).toMatchObject({ code: REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT });
      expect(f.writeAdapter.invocations).toBe(1);

      // The stale worker finally returns; its terminal write is rejected.
      f.writeAdapter.release.resolve();
      expect((await inFlight).ok).toBe(false);
      expect(f.store.getAction(action.actionId)?.status).toBe("FAILED");
      expect(f.store.getAttemptsForAction(action.actionId)).toHaveLength(1);
      expect(f.store.getAttemptsForAction(action.actionId)[0]?.status).toBe("UNKNOWN");
      const types = f.eventTypes();
      expect(types.filter((t) => t === "attempt.unknown")).toHaveLength(1);
      expect(types.filter((t) => t === "attempt.completed")).toHaveLength(0);
      expect(types.filter((t) => t === "action.completed")).toHaveLength(0);
      expect(fs.readFileSync(file!, "utf8")).toBe(writeInput.content);
      f.expectOrderedEvents();
    } finally {
      f.writeAdapter.release.resolve();
      f.cleanup();
    }
  });

  it("supervisor recovery of this isolated run is refused without a QUIESCED gate, and nothing changes", async () => {
    const f = setupFixture({ holdAfterEffect: true, workerLeaseTtlMs: 10000 });
    try {
      const inFlight = settle(
        f.runtime.executeAction({
          runId: f.runId,
          leaseId: f.leaseId,
          toolName: "write_file",
          inputPayload: writeInput,
        })
      );
      await f.writeAdapter.entered.promise;
      const action = f.store.getActionsForRun(f.runId)[0]!;

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

      expect(f.store.getAction(action.actionId)?.status).toBe("RUNNING");
      expect(f.store.getAttemptsForAction(action.actionId)).toHaveLength(1);
      expect(f.store.getAttemptsForAction(action.actionId)[0]?.status).toBe("RUNNING");
      expect(f.store.getEventsForRun(f.runId).length).toBe(eventsBefore);
      expect(f.writeAdapter.invocations).toBe(1);

      f.writeAdapter.release.resolve();
      await inFlight;
    } finally {
      f.writeAdapter.release.resolve();
      f.cleanup();
    }
  });
});

describe("Milestone 2.13A — idempotency-token boundary (current behavior)", () => {
  it("the token is deterministic and persisted per Attempt, but is not visible to the adapter", async () => {
    const f = setupFixture();
    try {
      const res = await f.runtime.executeAction({
        runId: f.runId,
        leaseId: f.leaseId,
        toolName: "write_file",
        inputPayload: writeInput,
      });
      expect(res.status).toBe("SUCCEEDED");

      const attempt = f.store.getAttemptsForAction(res.actionId)[0]!;
      expect(attempt.idempotencyToken).toBe(createAttemptIdempotencyToken(f.runId, res.actionId, 1));
      expect(attempt.idempotencyToken).toBe(`${f.runId}:${res.actionId}:1`);

      // No adapter deduplicates with the token: the adapter's context carries no token at all.
      expect(f.writeAdapter.contextKeys.length).toBeGreaterThan(0);
      expect(f.writeAdapter.contextKeys.some((k) => /idempot|token/i.test(k))).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it("the store rejects an Attempt row that reuses another Attempt's token (record-level uniqueness only)", async () => {
    const f = setupFixture();
    try {
      const res = await f.runtime.executeAction({
        runId: f.runId,
        leaseId: f.leaseId,
        toolName: "write_file",
        inputPayload: writeInput,
      });
      const first = f.store.getAttemptsForAction(res.actionId)[0]!;
      const run = f.store.getRun(f.runId)!;

      // A second, open Action: its own Attempt row may not reuse the first Attempt's token.
      const now = f.clock.nowIso();
      const { action, event: actEvent } = Action.create({
        actionId: "act-token-reuse",
        runId: f.runId,
        sequenceNumber: 2,
        toolName: "write_file",
        inputPayload: { path: "other.txt", content: "other" },
        contractBinding: run.contractBinding!,
        maxAttempts: 3,
        now,
      });
      const fencing = { workerId: f.workerId, leaseId: f.leaseId };
      f.store.transaction((tx) => {
        tx.insertAction(action.snapshot, actEvent, fencing);
        tx.transitionAction("act-token-reuse", { type: "AUTHORIZE", now }, () => crypto.randomUUID());
        tx.transitionAction(
          "act-token-reuse",
          { type: "START_ATTEMPT", attemptNumber: 1, now },
          () => crypto.randomUUID()
        );
      });
      const { attempt, event } = Attempt.create({
        attemptId: crypto.randomUUID(),
        actionId: "act-token-reuse",
        runId: f.runId,
        attemptNumber: 1,
        workerId: f.workerId,
        leaseId: f.leaseId,
        idempotencyToken: first.idempotencyToken,
        now,
      });

      expect(() =>
        f.store.transaction((tx) => tx.insertAttempt(attempt.snapshot, event, fencing))
      ).toThrow(DuplicateAttemptTokenError);
      expect(f.store.getAttemptsForAction("act-token-reuse")).toHaveLength(0);
      // This prevents a duplicate Attempt record. It does not prevent a duplicate physical side effect.
      expect(f.writeAdapter.invocations).toBe(1);
    } finally {
      f.cleanup();
    }
  });

  it("the store rejects a second Attempt row while the Action has an active one", async () => {
    const f = setupFixture({ holdAfterEffect: true });
    try {
      const inFlight = settle(
        f.runtime.executeAction({
          runId: f.runId,
          leaseId: f.leaseId,
          toolName: "write_file",
          inputPayload: writeInput,
        })
      );
      await f.writeAdapter.entered.promise;
      const action = f.store.getActionsForRun(f.runId)[0]!;
      const { attempt, event } = Attempt.create({
        attemptId: crypto.randomUUID(),
        actionId: action.actionId,
        runId: f.runId,
        attemptNumber: 2,
        workerId: f.workerId,
        leaseId: f.leaseId,
        now: f.clock.nowIso(),
      });

      expect(() =>
        f.store.transaction((tx) =>
          tx.insertAttempt(attempt.snapshot, event, { workerId: f.workerId, leaseId: f.leaseId })
        )
      ).toThrow(/already has an active attempt/);
      expect(f.store.getAttemptsForAction(action.actionId)).toHaveLength(1);
      expect(f.writeAdapter.invocations).toBe(1);

      f.writeAdapter.release.resolve();
      await inFlight;
    } finally {
      f.writeAdapter.release.resolve();
      f.cleanup();
    }
  });
});
