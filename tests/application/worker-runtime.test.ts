import { describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import {
  RunCoordinator,
  WorkerRuntime,
} from "../../src/application/index.js";
import { LeaseLostError } from "../../src/domain/errors.js";
import { createAndActivateContract } from "./test-helpers.js";
import {
  DeterministicOperation,
  EchoOperation,
  OperationContext,
  OperationResult,
  SumOperation,
} from "../../src/domain/operation.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { createVerificationSpec } from "../../src/domain/verification.js";

class FailingOperation implements DeterministicOperation<unknown, unknown> {
  readonly name = "failing";

  execute(_input: unknown, _context: OperationContext): OperationResult<unknown> {
    throw new Error("Simulated computation failure in deterministic worker");
  }
}

describe("Application Runtime & Lease Coordination", () => {
  it("Scenario 1: Happy path vertical slice (Task -> Run -> Queue -> Worker -> Complete)", async () => {
    const clock = new SettableClock("2026-03-30T10:00:00.000Z");
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const worker = new WorkerRuntime({
      workerId: "worker-1",
      coordinator,
      clock,
      leaseTtlMs: 10000,
      operations: [new EchoOperation()],
    });

    // 1. Create task
    const task = coordinator.createTask({
      title: "echo",
      description: "Echo input payload",
      inputPayload: { message: "Deterministic hello world", count: 42 },
    });
    expect(task.taskId).toBeDefined();
    createAndActivateContract(store, task.taskId, {
      verificationSpecs: [createVerificationSpec({ specId: "vspec-echo-1", ruleKind: "EXACT_OUTPUT_MATCH", expectedValue: { message: "Deterministic hello world", count: 42 } })],
    });

    // 2. Create run
    const createResult = coordinator.createRun({
      taskId: task.taskId,
      maxAttempts: 3,
      timeoutMs: 30000,
      idempotencyKey: "idem-key-1",
    });
    expect(createResult.run.status).toBe("CREATED");
    expect(createResult.run.version).toBe(1);

    // 3. Queue run
    clock.advanceMs(100);
    const queueResult = coordinator.queueRun(createResult.run.runId);
    expect(queueResult.run.status).toBe("QUEUED");
    expect(queueResult.run.version).toBe(2);

    // 4. Worker executes runOnce
    clock.advanceMs(100);
    const result = await worker.runOnce();
    expect(result.status).toBe("COMPLETED");
    if (result.status === "COMPLETED") {
      expect(result.output).toEqual({ message: "Deterministic hello world", count: 42 });
    }

    // 5. Verify final persisted run state
    const completedRun = coordinator.getRun(createResult.run.runId);
    expect(completedRun).not.toBeNull();
    expect(completedRun!.status).toBe("COMPLETED");
    expect(completedRun!.resultPayload).toEqual({ message: "Deterministic hello world", count: 42 });
    expect(completedRun!.currentWorkerId).toBe("worker-1");
    expect(completedRun!.leaseExpiresAt).toBeNull(); // Terminal state clears active lease expiry

    // 6. Verify lease record is RELEASED
    const lease = coordinator.getLease(completedRun!.leaseId!);
    expect(lease).not.toBeNull();
    expect(lease!.state).toBe("RELEASED");
    expect(lease!.releasedAt).toBeDefined();

    // 7. Verify gapless event sequence
    const events = coordinator.getEventsForRun(createResult.run.runId);
    expect(events).toHaveLength(8);
    expect(events.map((e) => e.eventType)).toEqual([
      "run.created",
      "run.queued",
      "worker.claimed",
      "run.started",
      "policy.evaluated",
      "evidence.recorded",
      "verification.completed",
      "run.completed",
    ]);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    store.close();
  });

  it("Scenario 1b: Happy path with SumOperation", async () => {
    const clock = new SettableClock("2026-03-30T10:00:00.000Z");
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const worker = new WorkerRuntime({
      workerId: "sum-worker",
      coordinator,
      clock,
      operations: [new SumOperation()],
    });

    const task = coordinator.createTask({
      title: "sum",
      inputPayload: [10, 20, 30, 40],
    });
    createAndActivateContract(store, task.taskId, {
      verificationSpecs: [createVerificationSpec({ specId: "vspec-sum-1b", ruleKind: "EXACT_OUTPUT_MATCH", expectedValue: 100 })],
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const result = await worker.runOnce(run.runId);
    expect(result.status).toBe("COMPLETED");
    if (result.status === "COMPLETED") {
      expect(result.output).toBe(100);
    }

    const completed = coordinator.getRun(run.runId);
    expect(completed!.resultPayload).toBe(100);
    expect(completed!.status).toBe("COMPLETED");

    store.close();
  });

  it("Scenario 2: Operation failure (RUNNING -> FAILED with error payload)", async () => {
    const clock = new SettableClock("2026-03-30T10:00:00.000Z");
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const worker = new WorkerRuntime({
      workerId: "worker-fail",
      coordinator,
      clock,
      operations: [new FailingOperation()],
    });

    const task = coordinator.createTask({
      title: "failing",
      inputPayload: { foo: "bar" },
    });
    createAndActivateContract(store, task.taskId);

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const result = await worker.runOnce();
    expect(result.status).toBe("FAILED");
    if (result.status === "FAILED") {
      expect((result.error as { message: string }).message).toContain("Simulated computation failure");
    }

    const failedRun = coordinator.getRun(run.runId);
    expect(failedRun!.status).toBe("FAILED");
    expect((failedRun!.errorPayload as { message: string }).message).toContain("Simulated computation failure");

    // Lease should be released on failure
    const lease = coordinator.getLease(failedRun!.leaseId!);
    expect(lease!.state).toBe("RELEASED");

    // Events sequence ends with run.failed
    const events = coordinator.getEventsForRun(run.runId);
    expect(events.map((e) => e.eventType)).toEqual([
      "run.created",
      "run.queued",
      "worker.claimed",
      "run.started",
      "policy.evaluated",
      "run.failed",
    ]);

    store.close();
  });

  it("Scenario 3: Stale worker fencing simulation (Lease reassignment -> LeaseLostError)", async () => {
    const clock = new SettableClock("2026-03-30T10:00:00.000Z");
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);

    const worker1 = new WorkerRuntime({
      workerId: "worker-1",
      coordinator,
      clock,
      leaseTtlMs: 5000,
    });
    const worker2 = new WorkerRuntime({
      workerId: "worker-2",
      coordinator,
      clock,
      leaseTtlMs: 5000,
    });

    worker1.ensureRegistered();
    worker2.ensureRegistered();

    const task = coordinator.createTask({
      title: "echo",
      inputPayload: "payload",
    });
    createAndActivateContract(store, task.taskId);

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    // Worker 1 claims and starts the run
    const claim1 = coordinator.claimRun(run.runId, "worker-1", 5000);
    coordinator.startRun(run.runId, "worker-1", claim1.lease.leaseId);

    // Simulate clock advancing past lease TTL
    clock.advanceMs(6000);

    // Sweeper recovers expired run
    const recovery = coordinator.recoverExpiredRuns();
    expect(recovery.recoveredCount).toBe(1);

    // Worker 2 claims the recovered run with a new lease
    const claim2 = coordinator.claimRun(run.runId, "worker-2", 5000);
    expect(claim2.lease.leaseId).not.toBe(claim1.lease.leaseId);
    coordinator.startRun(run.runId, "worker-2", claim2.lease.leaseId);

    // Worker 1 now tries to complete using its stale lease
    expect(() => {
      coordinator.completeRun(run.runId, "worker-1", claim1.lease.leaseId, "stale-output");
    }).toThrow(LeaseLostError);

    // Run remains actively assigned to worker-2 in RUNNING status
    const currentRun = coordinator.getRun(run.runId);
    expect(currentRun!.status).toBe("RUNNING");
    expect(currentRun!.currentWorkerId).toBe("worker-2");
    expect(currentRun!.leaseId).toBe(claim2.lease.leaseId);

    // Worker 2 completes normally
    coordinator.completeRun(run.runId, "worker-2", claim2.lease.leaseId, "valid-output");
    const finalRun = coordinator.getRun(run.runId);
    expect(finalRun!.status).toBe("COMPLETED");
    expect(finalRun!.resultPayload).toBe("valid-output");

    store.close();
  });

  it("Scenario 4: Expired lease recovery (RUNNING -> RECOVERING -> QUEUED with attempt increment)", async () => {
    const clock = new SettableClock("2026-03-30T10:00:00.000Z");
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);

    const worker = new WorkerRuntime({
      workerId: "worker-crash",
      coordinator,
      clock,
      leaseTtlMs: 5000,
    });
    worker.ensureRegistered();

    const task = coordinator.createTask({
      title: "echo",
      inputPayload: "test",
    });
    createAndActivateContract(store, task.taskId);

    const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3 });
    coordinator.queueRun(run.runId);

    const claim = coordinator.claimRun(run.runId, "worker-crash", 5000);
    coordinator.startRun(run.runId, "worker-crash", claim.lease.leaseId);

    const runningRun = coordinator.getRun(run.runId);
    expect(runningRun!.status).toBe("RUNNING");
    expect(runningRun!.attemptCount).toBe(0);

    // Advance clock past lease expiration
    clock.advanceMs(6000);

    // Sweeper triggers recovery
    const recoveryResult = coordinator.recoverExpiredRuns();
    expect(recoveryResult.recoveredCount).toBe(1);

    const recoveredRun = coordinator.getRun(run.runId);
    expect(recoveredRun!.status).toBe("QUEUED");
    expect(recoveredRun!.attemptCount).toBe(1); // Incremented attempt count
    expect(recoveredRun!.currentWorkerId).toBeNull();
    expect(recoveredRun!.leaseId).toBeNull();
    expect(recoveredRun!.leaseExpiresAt).toBeNull();

    // Verify lease marked EXPIRED
    const expiredLease = coordinator.getLease(claim.lease.leaseId);
    expect(expiredLease!.state).toBe("EXPIRED");

    // Verify event sequence contains lease.expired followed by run.recovered
    const events = coordinator.getEventsForRun(run.runId);
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain("lease.expired");
    expect(eventTypes).toContain("run.recovered");

    store.close();
  });

  it("Scenario 5: Retry budget exhaustion (RECOVERING -> FAILED with retriesExhausted)", async () => {
    const clock = new SettableClock("2026-03-30T10:00:00.000Z");
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);

    const worker = new WorkerRuntime({
      workerId: "worker-retry",
      coordinator,
      clock,
      leaseTtlMs: 2000,
    });
    worker.ensureRegistered();

    const task = coordinator.createTask({
      title: "echo",
      inputPayload: "budget-test",
    });
    createAndActivateContract(store, task.taskId);

    // Max attempts = 1
    const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 1 });
    coordinator.queueRun(run.runId);

    // Attempt 1: Worker claims, starts, and lease expires
    const claim1 = coordinator.claimRun(run.runId, "worker-retry", 2000);
    coordinator.startRun(run.runId, "worker-retry", claim1.lease.leaseId);

    clock.advanceMs(3000);

    // Recovery runs: attemptCount was 0. Increments to 1 < maxAttempts(1) is false (1 >= 1)
    // Wait: if attemptCount is 0, attemptCount < maxAttempts (0 < 1 is true), so attempt 1 is allowed.
    const recovery1 = coordinator.recoverExpiredRuns();
    expect(recovery1.recoveredCount).toBe(1);
    const recoveredRun1 = coordinator.getRun(run.runId);
    expect(recoveredRun1!.status).toBe("QUEUED");
    expect(recoveredRun1!.attemptCount).toBe(1);

    // Claim attempt 2 (which is attemptCount = 1, matching maxAttempts)
    const claim2 = coordinator.claimRun(run.runId, "worker-retry", 2000);
    coordinator.startRun(run.runId, "worker-retry", claim2.lease.leaseId);

    clock.advanceMs(3000);

    // Recovery runs again: attemptCount is 1, maxAttempts is 1. Budget exhausted!
    const recovery2 = coordinator.recoverExpiredRuns();
    expect(recovery2.recoveredCount).toBe(1);

    const exhaustedRun = coordinator.getRun(run.runId);
    expect(exhaustedRun!.status).toBe("FAILED");
    expect(exhaustedRun!.attemptCount).toBe(1);
    expect((exhaustedRun!.errorPayload as { code: string }).code).toBe("RETRIES_EXHAUSTED");

    // Cannot be retried anymore
    const next = coordinator.getNextQueuedRun();
    expect(next).toBeNull();

    store.close();
  });

  it("Scenario 6: Logical timeout detection (RUNNING -> TIMED_OUT)", async () => {
    const clock = new SettableClock("2026-03-30T10:00:00.000Z");
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);

    const worker = new WorkerRuntime({
      workerId: "timeout-worker",
      coordinator,
      clock,
      leaseTtlMs: 60000,
    });
    worker.ensureRegistered();

    const task = coordinator.createTask({
      title: "echo",
      inputPayload: "timeout-payload",
    });
    createAndActivateContract(store, task.taskId);

    const { run } = coordinator.createRun({ taskId: task.taskId, timeoutMs: 5000 });
    coordinator.queueRun(run.runId);

    const claim = coordinator.claimRun(run.runId, "timeout-worker", 60000);
    coordinator.startRun(run.runId, "timeout-worker", claim.lease.leaseId);

    // Wall-clock exceeds run timeoutMs
    clock.advanceMs(6000);

    coordinator.timeoutRun(run.runId, "Wall-clock timeout of 5000ms exceeded");

    const timedOutRun = coordinator.getRun(run.runId);
    expect(timedOutRun!.status).toBe("TIMED_OUT");
    expect((timedOutRun!.errorPayload as { reason: string }).reason).toContain("5000ms exceeded");

    // Lease is released
    const lease = coordinator.getLease(claim.lease.leaseId);
    expect(lease!.state).toBe("RELEASED");

    const events = coordinator.getEventsForRun(run.runId);
    expect(events[events.length - 1]!.eventType).toBe("run.timed_out");

    store.close();
  });

  it("Scenario 7: Administrative cancellation (QUEUED or RUNNING -> CANCELLED)", async () => {
    const clock = new SettableClock("2026-03-30T10:00:00.000Z");
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);

    const task = coordinator.createTask({
      title: "echo",
      inputPayload: "cancel-payload",
    });
    createAndActivateContract(store, task.taskId);

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    // Cancel while QUEUED
    coordinator.cancelRun(run.runId, "Operator cancelled via admin console");

    const cancelledRun = coordinator.getRun(run.runId);
    expect(cancelledRun!.status).toBe("CANCELLED");
    expect((cancelledRun!.errorPayload as { reason: string }).reason).toBe("Operator cancelled via admin console");

    const events = coordinator.getEventsForRun(run.runId);
    expect(events[events.length - 1]!.eventType).toBe("run.cancelled");

    store.close();
  });

  it("Scenario 8: Worker crash mid-execution and seamless recovery by second worker", async () => {
    const clock = new SettableClock("2026-03-30T10:00:00.000Z");
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);

    const workerCrash = new WorkerRuntime({
      workerId: "crashed-worker",
      coordinator,
      clock,
      leaseTtlMs: 5000,
    });
    const workerBackup = new WorkerRuntime({
      workerId: "backup-worker",
      coordinator,
      clock,
      leaseTtlMs: 5000,
    });

    workerCrash.ensureRegistered();
    workerBackup.ensureRegistered();

    const task = coordinator.createTask({
      title: "echo",
      inputPayload: { resilient: true },
    });
    createAndActivateContract(store, task.taskId, {
      verificationSpecs: [createVerificationSpec({ specId: "vspec-resilient", ruleKind: "EXACT_OUTPUT_MATCH", expectedValue: { resilient: true } })],
    });

    const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3 });
    coordinator.queueRun(run.runId);

    // Worker 1 claims and starts the run
    const claim1 = coordinator.claimRun(run.runId, "crashed-worker", 5000);
    coordinator.startRun(run.runId, "crashed-worker", claim1.lease.leaseId);

    // Worker 1 simulation: process abruptly crashes, advances time 10s without reporting completion
    clock.advanceMs(10000);

    // Run is still safely recorded as RUNNING in DB (not corrupted)
    const midState = coordinator.getRun(run.runId);
    expect(midState!.status).toBe("RUNNING");

    // Sweeper detects expired lease and recovers run
    const sweeperResult = coordinator.recoverExpiredRuns();
    expect(sweeperResult.recoveredCount).toBe(1);

    // Run is now QUEUED again
    const queuedAgain = coordinator.getRun(run.runId);
    expect(queuedAgain!.status).toBe("QUEUED");
    expect(queuedAgain!.attemptCount).toBe(1);

    // Worker 2 runs runOnce and picks up the recovered run
    const worker2Result = await workerBackup.runOnce();
    expect(worker2Result.status).toBe("COMPLETED");
    if (worker2Result.status === "COMPLETED") {
      expect(worker2Result.output).toEqual({ resilient: true });
    }

    // Final state is COMPLETED under worker-backup
    const finalRun = coordinator.getRun(run.runId);
    expect(finalRun!.status).toBe("COMPLETED");
    expect(finalRun!.currentWorkerId).toBe("backup-worker");
    expect(finalRun!.attemptCount).toBe(1);

    store.close();
  });

  it("Scenario 9: Idle worker returns IDLE when no runs are queued", async () => {
    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const worker = new WorkerRuntime({
      workerId: "idle-worker",
      coordinator,
      clock,
    });

    const result = await worker.runOnce();
    expect(result.status).toBe("IDLE");

    store.close();
  });

  it("Scenario 10: Lease renewal extends lease expiration and run leaseExpiresAt", () => {
    const clock = new SettableClock("2026-03-30T10:00:00.000Z");
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);

    const worker = new WorkerRuntime({ workerId: "worker-renew", coordinator, clock });
    worker.ensureRegistered();

    const task = coordinator.createTask({ title: "echo", inputPayload: 1 });
    createAndActivateContract(store, task.taskId);
    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const claim = coordinator.claimRun(run.runId, "worker-renew", 5000);
    expect(claim.lease.expiresAt).toBe("2026-03-30T10:00:05.000Z");

    // Advance 3s
    clock.advanceMs(3000);

    // Renew lease for another 5s
    const renewed = coordinator.renewLease(run.runId, claim.lease.leaseId, 5000);
    expect(renewed.expiresAt).toBe("2026-03-30T10:00:08.000Z");

    const updatedRun = coordinator.getRun(run.runId);
    expect(updatedRun!.leaseExpiresAt).toBe("2026-03-30T10:00:08.000Z");

    store.close();
  });
});
