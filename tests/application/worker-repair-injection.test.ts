/**
 * Tests for repair controller/orchestrator injection in WorkerRuntime and WorkerHost.
 *
 * Requirements:
 * 1. A task that fails verification once then passes on repair must end COMPLETED with the
 *    repair attempts in evidence.
 * 2. A task that keeps failing must end FAILED after the ceiling, not hang.
 * 3. Non-idempotent operations must not be auto-retried/re-executed on verification failure.
 * 4. WorkerHost automatically constructs BoundedRepairLoopController and passes it into WorkerRuntime.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import {
  RunCoordinator,
  WorkerRuntime,
} from "../../src/application/index.js";
import { BoundedRepairLoopController } from "../../src/application/bounded-repair-loop.js";
import { runWorkerHost } from "../../src/application/worker-host.js";
import { submitDurableTask } from "../../src/application/durable-submission.js";
import { createDefaultInProcessPolicy } from "../../src/domain/policy.js";
import { createVerificationSpec } from "../../src/domain/verification.js";
import { SettableClock, SystemClock } from "../../src/ports/clock.port.js";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "../../src/ports/execution-provider.port.js";
import { createAndActivateContract } from "./test-helpers.js";

/**
 * Execution provider that can return different outputs across sequential attempts.
 */
class StateRepairExecutionProvider implements ExecutionProvider {
  readonly name = "in-process";
  readonly role = "PHYSICAL" as const;
  readonly tenantModel = "NONE" as const;

  public callCount = 0;
  public requests: ExecutionRequest[] = [];

  constructor(private readonly outputs: readonly unknown[]) {}

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.requests.push(request as ExecutionRequest);
    const index = Math.min(this.callCount, this.outputs.length - 1);
    const output = this.outputs[index];
    this.callCount++;

    return {
      status: "SUCCESS",
      output: output as TOutput,
      durationMs: 5,
      providerMetadata: { exitCode: 0 },
    };
  }
}

function registerWorker(
  coordinator: RunCoordinator,
  workerId: string,
  clock: SettableClock
): void {
  coordinator.registerWorker({
    workerId,
    hostname: "localhost",
    pid: process.pid,
    status: "ACTIVE",
    lastHeartbeatAt: clock.nowIso(),
    createdAt: clock.nowIso(),
  });
}

describe("WorkerRuntime & WorkerHost Repair Controller Injection", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-repair-injection-"));
    dbPath = path.join(tmpDir, "test.sqlite");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("completes run when task fails verification once then passes on repair, recording repair evidence", async () => {
    const clock = new SettableClock("2026-03-30T10:00:00.000Z");
    const store = new SqliteStateStore({ location: dbPath });
    const coordinator = new RunCoordinator(store, clock);

    // Attempt 1 returns { count: 1 }, Attempt 2 returns { count: 2 }
    const provider = new StateRepairExecutionProvider([{ count: 1 }, { count: 2 }]);
    const repairController = new BoundedRepairLoopController({
      maxRepairIterations: 3,
      maxCumulativeActions: 10,
    });

    registerWorker(coordinator, "w-repair-pass", clock);

    const task = coordinator.createTask({
      title: "echo",
      inputPayload: { initial: 1 },
    });

    createAndActivateContract(store, task.taskId, {
      policy: createDefaultInProcessPolicy(`policy-${task.taskId}`),
      verificationSpecs: [
        createVerificationSpec({
          specId: "vspec-count-2",
          ruleKind: "EXACT_OUTPUT_MATCH",
          expectedValue: { count: 2 },
        }),
      ],
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const worker = new WorkerRuntime({
      workerId: "w-repair-pass",
      coordinator,
      clock,
      executionProvider: provider,
      repairController,
    });

    const result = await worker.runOnce();

    expect(result.status).toBe("COMPLETED");
    if (result.status === "COMPLETED") {
      expect(result.runId).toBe(run.runId);
      expect(result.output).toEqual({ count: 2 });
    }

    // Provider was called twice (initial + 1 repair)
    expect(provider.callCount).toBe(2);

    const completedRun = coordinator.getRun(run.runId);
    expect(completedRun?.status).toBe("COMPLETED");
    expect(completedRun?.resultPayload).toEqual({ count: 2 });

    // Assert repair evidence is recorded in coordinator
    const events = coordinator.getEventsForRun(run.runId);
    const evidenceEvents = events.filter((e) => e.eventType === "evidence.recorded");
    const hasRepairAttemptEvidence = evidenceEvents.some((e) => {
      const payload = e.payload as Record<string, unknown>;
      const summary = payload?.summary as Record<string, unknown>;
      return summary?.type === "REPAIR_ATTEMPT" && summary?.iteration === 1;
    });
    expect(hasRepairAttemptEvidence).toBe(true);

    // Verification must have concluded with status VERIFIED
    expect(events.some((e) => e.eventType === "verification.completed")).toBe(true);
    expect(events.some((e) => e.eventType === "run.completed")).toBe(true);
    expect(events.some((e) => e.eventType === "run.failed")).toBe(false);

    store.close();
  });

  it("halts and fails closed with VERIFICATION_FAILED_REPAIR_EXHAUSTED when repair keeps failing", async () => {
    const clock = new SettableClock("2026-03-30T10:00:00.000Z");
    const store = new SqliteStateStore({ location: dbPath });
    const coordinator = new RunCoordinator(store, clock);

    // Provider always returns { count: 0 }, never reaching expected { count: 42 }
    const provider = new StateRepairExecutionProvider([{ count: 0 }]);
    const repairController = new BoundedRepairLoopController({
      maxRepairIterations: 2,
      maxCumulativeActions: 5,
    });

    registerWorker(coordinator, "w-repair-exhaust", clock);

    const task = coordinator.createTask({
      title: "echo",
      inputPayload: { initial: 0 },
    });

    createAndActivateContract(store, task.taskId, {
      policy: createDefaultInProcessPolicy(`policy-${task.taskId}`),
      verificationSpecs: [
        createVerificationSpec({
          specId: "vspec-count-42",
          ruleKind: "EXACT_OUTPUT_MATCH",
          expectedValue: { count: 42 },
        }),
      ],
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const worker = new WorkerRuntime({
      workerId: "w-repair-exhaust",
      coordinator,
      clock,
      executionProvider: provider,
      repairController,
    });

    const result = await worker.runOnce();

    expect(result.status).toBe("FAILED");
    const failedRun = coordinator.getRun(run.runId);
    expect(failedRun?.status).toBe("FAILED");

    const err = (result as { status: "FAILED"; error?: any }).error;
    expect(err.code).toBe("VERIFICATION_FAILED_REPAIR_EXHAUSTED");
    expect(err.details.repairIterations).toBe(2);

    // Initial attempt + 2 repair iterations = 3 provider calls total
    expect(provider.callCount).toBe(3);

    const events = coordinator.getEventsForRun(run.runId);
    expect(events.some((e) => e.eventType === "run.failed")).toBe(true);
    expect(events.some((e) => e.eventType === "run.completed")).toBe(false);

    store.close();
  });

  it("refuses to auto-repair non-idempotent operations fail-closed without re-execution", async () => {
    const clock = new SettableClock("2026-03-30T10:00:00.000Z");
    const store = new SqliteStateStore({ location: dbPath });
    const coordinator = new RunCoordinator(store, clock);

    const provider = new StateRepairExecutionProvider([{ status: "partial" }, { status: "full" }]);
    const repairController = new BoundedRepairLoopController({
      maxRepairIterations: 3,
    });

    registerWorker(coordinator, "w-non-idempotent", clock);

    const task = coordinator.createTask({
      title: "echo",
      inputPayload: { idempotency: "NON_IDEMPOTENT" },
    });

    createAndActivateContract(store, task.taskId, {
      policy: createDefaultInProcessPolicy(`policy-${task.taskId}`),
      verificationSpecs: [
        createVerificationSpec({
          specId: "vspec-mutation-check",
          ruleKind: "EXACT_OUTPUT_MATCH",
          expectedValue: { status: "full" },
        }),
      ],
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const worker = new WorkerRuntime({
      workerId: "w-non-idempotent",
      coordinator,
      clock,
      executionProvider: provider,
      repairController,
    });

    const result = await worker.runOnce();

    expect(result.status).toBe("FAILED");
    const err = (result as { status: "FAILED"; error?: any }).error;
    expect(err.code).toBe("VERIFICATION_FAILED_REPAIR_EXHAUSTED");
    expect(err.message).toContain("NON_IDEMPOTENT");

    // Must NOT auto-retry: provider called exactly once
    expect(provider.callCount).toBe(1);

    store.close();
  });

  it("runWorkerHost automatically constructs and injects BoundedRepairLoopController", async () => {
    const store = new SqliteStateStore({ location: dbPath });
    const clock = new SystemClock();
    const coordinator = new RunCoordinator(store, clock);

    // Submit durable task expecting sum 10, but provided with numbers [5, 5] = 10
    const { runId } = submitDurableTask(store, coordinator, {
      operation: "sum",
      input: [5, 5],
      verificationSpecs: [
        createVerificationSpec({
          specId: "vspec-sum-10",
          ruleKind: "EXACT_OUTPUT_MATCH",
          expectedValue: 10,
        }),
      ],
    });

    store.close();

    const controller = new AbortController();
    const hostResult = await runWorkerHost({
      dbPath,
      workerId: "w-host-injected",
      once: true,
      signal: controller.signal,
      log: () => {},
    });

    expect(hostResult.runsProcessed).toBe(1);
    expect(hostResult.errors).toBe(0);

    const verifyStore = new SqliteStateStore({ location: dbPath });
    const verifyCoordinator = new RunCoordinator(verifyStore, clock);
    const run = verifyCoordinator.getRun(runId);
    expect(run?.status).toBe("COMPLETED");
    expect(run?.resultPayload).toBe(10);

    verifyStore.close();
  });
});
