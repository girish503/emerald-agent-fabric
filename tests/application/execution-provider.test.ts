import { describe, expect, it } from "vitest";
import { InProcessExecutionProvider } from "../../src/adapters/execution/in-process-execution-provider.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator, WorkerRuntime } from "../../src/application/index.js";
import { createAndActivateContract } from "./test-helpers.js";
import {
  DeterministicOperation,
  EchoOperation,
  OperationContext,
  OperationResult,
  SumOperation,
} from "../../src/domain/operation.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "../../src/ports/execution-provider.port.js";

class SlowOperation implements DeterministicOperation<unknown, string> {
  readonly name = "slow";

  constructor(private readonly delayMs: number) {}

  async execute(_input: unknown, _context: OperationContext): Promise<OperationResult<string>> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return { output: "slow-output" };
  }
}

class ExplodingOperation implements DeterministicOperation<unknown, never> {
  readonly name = "exploding";

  execute(_input: unknown, _context: OperationContext): OperationResult<never> {
    throw new Error("Mathematical divergence detected");
  }
}

class TrackingMockProvider implements ExecutionProvider {
  readonly name = "tracking-mock";
  readonly receivedRequests: ExecutionRequest[] = [];

  constructor(private readonly fixedOutput: unknown = "mock-result") {}

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.receivedRequests.push(request as ExecutionRequest);
    return {
      status: "SUCCESS",
      output: this.fixedOutput as TOutput,
      durationMs: 1,
      providerMetadata: { mock: true },
    };
  }
}

describe("Execution Provider Boundary", () => {
  it("Provider Execution: InProcessExecutionProvider executes deterministic operations directly", async () => {
    const provider = new InProcessExecutionProvider([
      new EchoOperation(),
      new SumOperation(),
    ]);

    // 1. Test EchoOperation
    const echoRequest: ExecutionRequest = {
      runId: "run-echo-1",
      taskId: "task-echo-1",
      operationName: "echo",
      inputPayload: { message: "Hello via Provider", data: [1, 2, 3] },
      idempotencyToken: "idem-echo-1",
      attemptNumber: 0,
      timeoutMs: 5000,
    };

    const echoResult = await provider.execute(echoRequest);
    expect(echoResult.status).toBe("SUCCESS");
    expect(echoResult.output).toEqual({ message: "Hello via Provider", data: [1, 2, 3] });
    expect(echoResult.durationMs).toBeGreaterThanOrEqual(0);
    expect(echoResult.providerMetadata?.provider).toBe("in-process");
    expect(echoResult.providerMetadata?.operation).toBe("echo");

    // 2. Test SumOperation
    const sumRequest: ExecutionRequest = {
      runId: "run-sum-1",
      taskId: "task-sum-1",
      operationName: "sum",
      inputPayload: [10, 20, 30, 40, 50],
      idempotencyToken: "idem-sum-1",
      attemptNumber: 0,
      timeoutMs: 5000,
    };

    const sumResult = await provider.execute(sumRequest);
    expect(sumResult.status).toBe("SUCCESS");
    expect(sumResult.output).toBe(150);

    // 3. Test Unknown Operation
    const unknownRequest: ExecutionRequest = {
      runId: "run-unk-1",
      taskId: "task-unk-1",
      operationName: "non-existent-op",
      inputPayload: null,
      idempotencyToken: "idem-unk-1",
      attemptNumber: 0,
      timeoutMs: 5000,
    };

    const unknownResult = await provider.execute(unknownRequest);
    expect(unknownResult.status).toBe("FAILED");
    expect(unknownResult.error?.code).toBe("OPERATION_NOT_FOUND");
    expect(unknownResult.error?.message).toContain("non-existent-op");
  });

  it("Worker Isolation: WorkerRuntime depends strictly on ExecutionProvider interface", async () => {
    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const mockProvider = new TrackingMockProvider("decoupled-output-payload");

    const worker = new WorkerRuntime({
      workerId: "isolated-worker",
      coordinator,
      clock,
      executionProvider: mockProvider,
    });

    const task = coordinator.createTask({
      title: "any-arbitrary-operation",
      inputPayload: { payload: 999 },
    });
    createAndActivateContract(store, task.taskId);

    const { run } = coordinator.createRun({
      taskId: task.taskId,
      idempotencyKey: "test-idempotency-token-xyz",
    });
    coordinator.queueRun(run.runId);

    // Execute runOnce
    const runResult = await worker.runOnce();
    expect(runResult.status).toBe("COMPLETED");
    if (runResult.status === "COMPLETED") {
      expect(runResult.output).toBe("decoupled-output-payload");
    }

    // Verify mock provider received strictly structured ExecutionRequest
    expect(mockProvider.receivedRequests).toHaveLength(1);
    const captured = mockProvider.receivedRequests[0]!;
    expect(captured.runId).toBe(run.runId);
    expect(captured.taskId).toBe(task.taskId);
    expect(captured.operationName).toBe("any-arbitrary-operation");
    expect(captured.inputPayload).toEqual({ payload: 999 });
    expect(captured.idempotencyToken).toBe("test-idempotency-token-xyz");
    expect(captured.attemptNumber).toBe(0);

    // Verify Run is COMPLETED with output in SQLite
    const completedRun = coordinator.getRun(run.runId);
    expect(completedRun!.status).toBe("COMPLETED");
    expect(completedRun!.resultPayload).toBe("decoupled-output-payload");

    store.close();
  });

  it("Deterministic Result: Same input produces identical output across executions", async () => {
    const provider = new InProcessExecutionProvider([new SumOperation()]);
    const request: ExecutionRequest = {
      runId: "run-det-1",
      taskId: "task-det-1",
      operationName: "sum",
      inputPayload: [1, 2, 3, 4],
      idempotencyToken: "token-1",
      attemptNumber: 0,
      timeoutMs: 5000,
    };

    const result1 = await provider.execute(request);
    const result2 = await provider.execute(request);

    expect(result1.output).toBe(10);
    expect(result2.output).toBe(10);
    expect(result1.output).toEqual(result2.output);
  });

  it("Failure Propagation: Provider failure translates into coordinator FAILED run", async () => {
    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const provider = new InProcessExecutionProvider([new ExplodingOperation()]);

    const worker = new WorkerRuntime({
      workerId: "fail-worker",
      coordinator,
      clock,
      executionProvider: provider,
    });

    const task = coordinator.createTask({
      title: "exploding",
      inputPayload: null,
    });
    createAndActivateContract(store, task.taskId);

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const result = await worker.runOnce();
    expect(result.status).toBe("FAILED");
    if (result.status === "FAILED") {
      expect((result.error as { code: string }).code).toBe("EXECUTION_FAILED");
      expect((result.error as { message: string }).message).toContain("Mathematical divergence detected");
    }

    const failedRun = coordinator.getRun(run.runId);
    expect(failedRun!.status).toBe("FAILED");
    expect((failedRun!.errorPayload as { code: string }).code).toBe("EXECUTION_FAILED");

    store.close();
  });

  it("Logical Timeout: Provider detects logical timeout and translates to TIMED_OUT run", async () => {
    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);

    // Operation takes 50ms, timeout limit is 10ms
    const slowOp = new SlowOperation(50);
    const provider = new InProcessExecutionProvider([slowOp]);

    const worker = new WorkerRuntime({
      workerId: "timeout-worker",
      coordinator,
      clock,
      executionProvider: provider,
    });

    const task = coordinator.createTask({
      title: "slow",
      inputPayload: null,
    });
    createAndActivateContract(store, task.taskId);

    // Run configured with 10ms timeout
    const { run } = coordinator.createRun({ taskId: task.taskId, timeoutMs: 10 });
    coordinator.queueRun(run.runId);

    const result = await worker.runOnce();
    expect(result.status).toBe("TIMED_OUT");
    if (result.status === "TIMED_OUT") {
      expect((result.error as { code: string }).code).toBe("EXECUTION_TIMEOUT");
      expect((result.error as { message: string }).message).toContain("exceeded logical timeout");
    }

    const timedOutRun = coordinator.getRun(run.runId);
    expect(timedOutRun!.status).toBe("TIMED_OUT");
    expect((timedOutRun!.errorPayload as { reason: string }).reason).toContain("exceeded logical timeout");

    store.close();
  });

  it("Idempotency Token: Logical execution token remains identical across retries while attemptNumber increments", async () => {
    const clock = new SettableClock("2026-03-30T10:00:00.000Z");
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const mockProvider = new TrackingMockProvider("result-ok");

    const worker = new WorkerRuntime({
      workerId: "retry-worker",
      coordinator,
      clock,
      leaseTtlMs: 2000,
      executionProvider: mockProvider,
    });

    const task = coordinator.createTask({
      title: "test-task",
      inputPayload: { attemptData: true },
    });
    createAndActivateContract(store, task.taskId);

    const { run } = coordinator.createRun({
      taskId: task.taskId,
      idempotencyKey: "business-idempotency-key-001",
      maxAttempts: 3,
    });
    coordinator.queueRun(run.runId);

    // Attempt 0: Worker claims and executes
    await worker.runOnce(run.runId);
    expect(mockProvider.receivedRequests).toHaveLength(1);
    expect(mockProvider.receivedRequests[0]!.idempotencyToken).toBe("business-idempotency-key-001");
    expect(mockProvider.receivedRequests[0]!.attemptNumber).toBe(0);

    // Simulate recovery to trigger Attempt 1
    // Reconstitute run back to RUNNING with expired lease to simulate uncompleted attempt
    clock.advanceMs(5000);
    coordinator.recoverExpiredRuns();
    // Since attempt 0 completed, no run was expired. Now create a scenario with interrupted attempt:
    const { run: run2 } = coordinator.createRun({
      taskId: task.taskId,
      idempotencyKey: "interrupted-key-002",
      maxAttempts: 3,
    });
    coordinator.queueRun(run2.runId);

    // Claim run2, start it, but do NOT complete
    const claim2 = coordinator.claimRun(run2.runId, "retry-worker", 2000);
    coordinator.startRun(run2.runId, "retry-worker", claim2.lease.leaseId);

    // Lease expires
    clock.advanceMs(3000);
    const recoveryResult = coordinator.recoverExpiredRuns();
    expect(recoveryResult.recoveredCount).toBe(1);

    // Now Worker claims the recovered run for Attempt 1
    const runResult2 = await worker.runOnce(run2.runId);
    expect(runResult2.status).toBe("COMPLETED");

    // Check request 2 received by mock provider
    const secondReq = mockProvider.receivedRequests[mockProvider.receivedRequests.length - 1]!;
    expect(secondReq.runId).toBe(run2.runId);
    expect(secondReq.idempotencyToken).toBe("interrupted-key-002");
    expect(secondReq.attemptNumber).toBe(1); // attempt count incremented

    store.close();
  });

  it("Scenario 12 Recovery: Worker A disappears mid-execution -> Sweeper recovers -> Worker B re-executes safely", async () => {
    const clock = new SettableClock("2026-03-30T10:00:00.000Z");
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);

    const providerA = new InProcessExecutionProvider([new SumOperation()]);
    const providerB = new InProcessExecutionProvider([new SumOperation()]);

    const workerA = new WorkerRuntime({
      workerId: "worker-A",
      coordinator,
      clock,
      leaseTtlMs: 3000,
      executionProvider: providerA,
    });

    const workerB = new WorkerRuntime({
      workerId: "worker-B",
      coordinator,
      clock,
      leaseTtlMs: 3000,
      executionProvider: providerB,
    });

    workerA.ensureRegistered();
    workerB.ensureRegistered();

    const task = coordinator.createTask({
      title: "sum",
      inputPayload: [5, 15, 25],
    });
    createAndActivateContract(store, task.taskId);

    const { run } = coordinator.createRun({
      taskId: task.taskId,
      idempotencyKey: "reentrant-run-key",
      maxAttempts: 3,
    });
    coordinator.queueRun(run.runId);

    // Step 1: Worker A claims run and starts execution
    const claimA = coordinator.claimRun(run.runId, "worker-A", 3000);
    coordinator.startRun(run.runId, "worker-A", claimA.lease.leaseId);

    // Step 2: Provider A executes operation
    const requestA: ExecutionRequest = {
      runId: run.runId,
      taskId: task.taskId,
      operationName: "sum",
      inputPayload: task.inputPayload,
      idempotencyToken: "reentrant-run-key",
      attemptNumber: 0,
      timeoutMs: 10000,
    };
    const resultA = await providerA.execute(requestA);
    expect(resultA.status).toBe("SUCCESS");
    expect(resultA.output).toBe(45);

    // Step 3: Worker A abruptly crashes / disappears before calling completeRun!
    // No state transition to COMPLETED occurs. The lease expires.
    clock.advanceMs(4000);

    // Verify run remains in RUNNING status in SQLite (not corrupted, provider has zero DB access)
    const midState = coordinator.getRun(run.runId);
    expect(midState!.status).toBe("RUNNING");
    expect(midState!.currentWorkerId).toBe("worker-A");

    // Step 4: Sweeper detects expired lease and recovers run
    const recovery = coordinator.recoverExpiredRuns();
    expect(recovery.recoveredCount).toBe(1);

    const recoveredRun = coordinator.getRun(run.runId);
    expect(recoveredRun!.status).toBe("QUEUED");
    expect(recoveredRun!.attemptCount).toBe(1);

    // Step 5: Worker B picks up the queued run and executes via provider B
    const resultB = await workerB.runOnce();
    expect(resultB.status).toBe("COMPLETED");
    if (resultB.status === "COMPLETED") {
      expect(resultB.output).toBe(45);
    }

    // Step 6: Verify final durable state
    const finalRun = coordinator.getRun(run.runId);
    expect(finalRun!.status).toBe("COMPLETED");
    expect(finalRun!.currentWorkerId).toBe("worker-B");
    expect(finalRun!.resultPayload).toBe(45);

    store.close();
  });

  it("Performance & Overhead: Initial local microbenchmark observation of provider overhead", async () => {
    // Note: This test captures an initial local microbenchmark observation only,
    // NOT a production performance guarantee. Production performance evaluations
    // must report at least p50, p95, and p99 percentiles along with explicit
    // workload, hardware, and environment specifications.
    const provider = new InProcessExecutionProvider([new EchoOperation()]);
    const request: ExecutionRequest = {
      runId: "bench-run",
      taskId: "bench-task",
      operationName: "echo",
      inputPayload: { x: 1 },
      idempotencyToken: "bench-token",
      attemptNumber: 0,
      timeoutMs: 1000,
    };

    // Warmup
    await provider.execute(request);

    // Microbenchmark iterations
    const iterations = 100;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      await provider.execute(request);
    }
    const elapsed = performance.now() - start;
    const avgLatencyMs = elapsed / iterations;

    // Direct invocation without provider boundary
    const directOp = new EchoOperation();
    const directStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      directOp.execute({ x: 1 }, { runId: "b", taskId: "t", idempotencyToken: "tok", timestamp: "now" });
    }
    const directElapsed = performance.now() - directStart;
    const avgDirectLatencyMs = directElapsed / iterations;

    const overheadMs = Math.max(0, avgLatencyMs - avgDirectLatencyMs);

    // Initial local observation assertion: boundary does not introduce unexpected gross stalls
    expect(avgLatencyMs).toBeLessThan(1.0);
    expect(overheadMs).toBeLessThan(1.0);
  });
});
