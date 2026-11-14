/**
 * Tests for fail-closed verification spec enforcement in WorkerRuntime.
 *
 * Invariant: A task contract with zero verification specifications MUST NOT complete as
 * a verified success. WorkerRuntime must transition the run to FAILED with error code
 * NO_VERIFICATION_SPECS, record evidence, and reject completion. A contract with valid
 * specifications must continue to verify normally and complete as COMPLETED.
 */

import { describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator, WorkerRuntime } from "../../src/application/index.js";
import { createDefaultInProcessPolicy } from "../../src/domain/policy.js";
import { createVerificationSpec } from "../../src/domain/verification.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "../../src/ports/execution-provider.port.js";
import { createAndActivateContract } from "./test-helpers.js";

class SimpleExecutionProvider implements ExecutionProvider {
  readonly name = "in-process";
  readonly role = "PHYSICAL" as const;
  readonly tenantModel = "NONE" as const;

  constructor(private readonly mockOutput: unknown = { ok: true, result: 42 }) {}

  async execute<TInput = unknown, TOutput = unknown>(
    _request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    return {
      status: "SUCCESS",
      output: this.mockOutput as TOutput,
      durationMs: 10,
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

describe("WorkerRuntime Fail-Closed Verification Spec Gate", () => {
  it("fails closed when contract has zero verification specs (spec-less task)", async () => {
    const clock = new SettableClock("2026-03-30T10:00:00.000Z");
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const provider = new SimpleExecutionProvider({ ok: true, result: 42 });

    registerWorker(coordinator, "w-specless", clock);

    const task = coordinator.createTask({ title: "echo", inputPayload: null });
    createAndActivateContract(store, task.taskId, {
      policy: createDefaultInProcessPolicy(`policy-${task.taskId}`),
      verificationSpecs: [], // Zero verification specs
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const worker = new WorkerRuntime({
      workerId: "w-specless",
      coordinator,
      clock,
      executionProvider: provider,
    });

    const result = await worker.runOnce();

    // Must NOT complete as verified success
    expect(result.status).toBe("FAILED");
    if (result.status === "FAILED") {
      expect(result.runId).toBe(run.runId);
    }

    const failedRun = coordinator.getRun(run.runId);
    expect(failedRun).not.toBeNull();
    expect(failedRun!.status).toBe("FAILED");
    expect((failedRun!.errorPayload as { code: string }).code).toBe("NO_VERIFICATION_SPECS");

    // Evidence must be recorded into the coordinator
    const events = coordinator.getEventsForRun(run.runId);
    const evidenceEvents = events.filter((e) => e.eventType === "evidence.recorded");
    expect(evidenceEvents.length).toBeGreaterThan(0);

    // Event stream must record run.failed and never run.completed
    expect(events.some((e) => e.eventType === "run.failed")).toBe(true);
    expect(events.some((e) => e.eventType === "run.completed")).toBe(false);

    store.close();
  });

  it("verifies normally and completes when contract has valid verification specs", async () => {
    const clock = new SettableClock("2026-03-30T10:00:00.000Z");
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const provider = new SimpleExecutionProvider({ ok: true, result: 42 });

    registerWorker(coordinator, "w-specced", clock);

    const task = coordinator.createTask({ title: "echo", inputPayload: null });
    createAndActivateContract(store, task.taskId, {
      policy: createDefaultInProcessPolicy(`policy-${task.taskId}`),
      verificationSpecs: [
        createVerificationSpec({
          specId: "vspec-exact-42",
          ruleKind: "EXACT_OUTPUT_MATCH",
          expectedValue: { ok: true, result: 42 },
        }),
      ],
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const worker = new WorkerRuntime({
      workerId: "w-specced",
      coordinator,
      clock,
      executionProvider: provider,
    });

    const result = await worker.runOnce();

    // Must complete as verified success
    expect(result.status).toBe("COMPLETED");
    if (result.status === "COMPLETED") {
      expect(result.runId).toBe(run.runId);
    }

    const completedRun = coordinator.getRun(run.runId);
    expect(completedRun).not.toBeNull();
    expect(completedRun!.status).toBe("COMPLETED");
    expect(completedRun!.resultPayload).toEqual({ ok: true, result: 42 });

    // Events must record verification.completed and run.completed
    const events = coordinator.getEventsForRun(run.runId);
    expect(events.some((e) => e.eventType === "verification.completed")).toBe(true);
    expect(events.some((e) => e.eventType === "run.completed")).toBe(true);
    expect(events.some((e) => e.eventType === "run.failed")).toBe(false);

    store.close();
  });

  it("completes spec-less task when allowUnverifiedCompletion is explicitly authorized", async () => {
    const clock = new SettableClock("2026-03-30T10:00:00.000Z");
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const provider = new SimpleExecutionProvider({ ok: true, result: 99 });

    registerWorker(coordinator, "w-override", clock);

    const task = coordinator.createTask({
      title: "echo",
      inputPayload: { operatorId: "op-test-admin" },
    });
    createAndActivateContract(store, task.taskId, {
      policy: createDefaultInProcessPolicy(`policy-${task.taskId}`),
      verificationSpecs: [], // Zero verification specs
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const worker = new WorkerRuntime({
      workerId: "w-override",
      coordinator,
      clock,
      executionProvider: provider,
      allowUnverifiedCompletion: true,
    });

    const result = await worker.runOnce();

    expect(result.status).toBe("COMPLETED");
    const completedRun = coordinator.getRun(run.runId);
    expect(completedRun).not.toBeNull();
    expect(completedRun!.status).toBe("COMPLETED");

    // Events must contain verification.unverified_completion_authorized
    const events = coordinator.getEventsForRun(run.runId);
    const unverifiedAuth = events.find(
      (e) => e.eventType === "verification.unverified_completion_authorized"
    );
    expect(unverifiedAuth).toBeDefined();
    expect((unverifiedAuth!.payload as Record<string, unknown>).operator).toBe("op-test-admin");
    expect(events.some((e) => e.eventType === "run.completed")).toBe(true);
    expect(events.some((e) => e.eventType === "run.failed")).toBe(false);

    store.close();
  });
});
