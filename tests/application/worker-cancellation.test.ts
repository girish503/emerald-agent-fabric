import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { SqliteTenantLaunchCoordinator } from "../../src/adapters/coordination/sqlite-tenant-launch-coordinator.js";
import { InProcessExecutionProvider } from "../../src/adapters/execution/in-process-execution-provider.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { RunCoordinator, WorkerRuntime } from "../../src/application/index.js";
import { LeaseLostError } from "../../src/domain/errors.js";
import { DeterministicOperation, OperationContext, OperationResult } from "../../src/domain/operation.js";
import { createDefaultDockerPolicy } from "../../src/domain/policy.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
  resolveProviderCancellationModel,
} from "../../src/ports/execution-provider.port.js";
import {
  AcquireGateParams,
  TenantLaunchCoordinatorPort,
  TenantLaunchGate,
} from "../../src/ports/tenant-launch-coordinator.port.js";
import { createAndActivateContract } from "./test-helpers.js";
import { createVerificationSpec } from "../../src/domain/verification.js";

function manualScheduler() {
  let pending: (() => void) | null = null;
  return {
    scheduler: {
      schedule(fn: () => void, _delayMs: number) {
        pending = fn;
        return {
          cancel() {
            pending = null;
          },
        };
      },
    },
    fire() {
      const fn = pending;
      pending = null;
      fn?.();
    },
  };
}

describe("Milestone 2.3: In-Process Execution Cancellation and Lifecycle Safety", () => {
  // Scenario 1: Pre-aborted signal prevents operation invocation
  it("Scenario 1: Pre-aborted signal prevents operation invocation", async () => {
    let invoked = false;
    class TrackedOp implements DeterministicOperation<unknown, string> {
      readonly name = "echo";
      execute(_input: unknown, _ctx: OperationContext): OperationResult<string> {
        invoked = true;
        return { output: "executed" };
      }
    }

    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const provider = new InProcessExecutionProvider([new TrackedOp()]);
    const worker = new WorkerRuntime({
      workerId: "worker-preaborted",
      coordinator,
      clock,
      executionProvider: provider,
    });

    const task = coordinator.createTask({ title: "echo", inputPayload: null });
    createAndActivateContract(store, task.taskId, {
      verificationSpecs: [createVerificationSpec({ specId: "vspec-fast", ruleKind: "EXACT_OUTPUT_MATCH", expectedValue: "fast-ok" })],
    });
    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const controller = new AbortController();
    controller.abort(new Error("Pre-aborted before start"));

    const result = await worker.runOnce(run.runId, { signal: controller.signal });
    expect(result.status).toBe("CANCELLED");
    expect(invoked).toBe(false);

    const persistedRun = coordinator.getRun(run.runId);
    expect(persistedRun!.status).toBe("CANCELLED");
    store.close();
  });

  // Scenario 2: Timeout requests cancellation
  it("Scenario 2: Timeout requests cancellation", async () => {
    class SlowCooperativeOp implements DeterministicOperation<unknown, string> {
      readonly name = "slow";
      async execute(_input: unknown, _ctx: OperationContext): Promise<OperationResult<string>> {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { output: "finished-late" };
      }
    }

    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const provider = new InProcessExecutionProvider([new SlowCooperativeOp()]);
    const worker = new WorkerRuntime({
      workerId: "worker-timeout",
      coordinator,
      clock,
      executionProvider: provider,
    });

    const task = coordinator.createTask({ title: "slow", inputPayload: null });
    createAndActivateContract(store, task.taskId);
    const { run } = coordinator.createRun({ taskId: task.taskId, timeoutMs: 25 });
    coordinator.queueRun(run.runId);

    const result = await worker.runOnce(run.runId);
    expect(result.status).toBe("TIMED_OUT");
    if (result.status === "TIMED_OUT") {
      expect((result.error as { code: string }).code).toBe("EXECUTION_TIMEOUT");
    }

    const persistedRun = coordinator.getRun(run.runId);
    expect(persistedRun!.status).toBe("TIMED_OUT");
    store.close();
  });

  // Scenario 3: Lease loss triggers onLeaseLost and aborts signal
  it("Scenario 3: Lease loss triggers onLeaseLost and aborts signal", async () => {
    let capturedSignal: AbortSignal | undefined;
    let onLeaseLostFired = false;
    let releaseOp: () => void = () => {};

    const timer = manualScheduler();

    const provider: ExecutionProvider = {
      name: "in-process",
      tenantModel: "NONE",
      cancellationModel: "COOPERATIVE",
      async execute<TInput = unknown, TOutput = unknown>(
        request: ExecutionRequest<TInput>
      ): Promise<ExecutionResult<TOutput>> {
        capturedSignal = request.signal;
        return new Promise<ExecutionResult<TOutput>>((resolve) => {
          releaseOp = () => {
            resolve({ status: "SUCCESS", output: "done" as TOutput, durationMs: 1 });
          };
        });
      },
    };

    const clock = new SettableClock("2026-03-30T10:00:00.000Z");
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const usurperWorker = new WorkerRuntime({ workerId: "worker-usurper", coordinator, clock });
    usurperWorker.ensureRegistered();

    const worker = new WorkerRuntime({
      workerId: "worker-leaseloss",
      coordinator,
      clock,
      executionProvider: provider,
      leaseTtlMs: 9000,
      leaseRenewal: {
        scheduler: timer.scheduler,
        onLeaseLost: (_err) => {
          onLeaseLostFired = true;
        },
      },
    });

    const task = coordinator.createTask({ title: "echo", inputPayload: null });
    createAndActivateContract(store, task.taskId, {
      verificationSpecs: [createVerificationSpec({ specId: "vspec-legacy", ruleKind: "EXACT_OUTPUT_MATCH", expectedValue: { receivedOperation: "echo" } })],
    });
    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const runPromise = worker.runOnce(run.runId);
    // Wait until provider starts executing
    while (!capturedSignal) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(capturedSignal.aborted).toBe(false);

    // Advance clock past lease TTL and recover run
    clock.advanceMs(10000);
    const recoveryResult = coordinator.recoverExpiredRuns();
    expect(recoveryResult.recoveredCount).toBe(1);

    // Another worker reclaims the lease from QUEUED
    coordinator.claimRun(run.runId, "worker-usurper", 10000);

    // Manually fire heartbeat tick
    timer.fire();

    expect(onLeaseLostFired).toBe(true);
    expect(capturedSignal.aborted).toBe(true);

    releaseOp();
    const result = await runPromise;
    expect(result.status).toBe("FENCED");
    store.close();
  });

  // Scenario 4: Stale worker after lease loss returns FENCED and cannot commit late success
  it("Scenario 4: Stale worker after lease loss returns FENCED and cannot commit late success", async () => {
    let releaseProvider: () => void = () => {};

    const provider: ExecutionProvider = {
      name: "in-process",
      tenantModel: "NONE",
      cancellationModel: "COOPERATIVE",
      async execute<TInput = unknown, TOutput = unknown>(
        _request?: ExecutionRequest<TInput>
      ): Promise<ExecutionResult<TOutput>> {
        return new Promise((resolve) => {
          releaseProvider = () => {
            resolve({ status: "SUCCESS", output: "stale-output-payload" as TOutput, durationMs: 10 });
          };
        });
      },
    };

    const clock = new SettableClock("2026-03-30T10:00:00.000Z");
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);

    const worker2 = new WorkerRuntime({ workerId: "worker-2", coordinator, clock });
    worker2.ensureRegistered();

    const worker1 = new WorkerRuntime({
      workerId: "worker-1",
      coordinator,
      clock,
      executionProvider: provider,
      leaseTtlMs: 2000,
    });

    const task = coordinator.createTask({ title: "echo", inputPayload: null });
    createAndActivateContract(store, task.taskId, {
      verificationSpecs: [createVerificationSpec({ specId: "vspec-fast", ruleKind: "EXACT_OUTPUT_MATCH", expectedValue: "fast-ok" })],
    });
    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const worker1Promise = worker1.runOnce(run.runId);
    await new Promise((r) => setTimeout(r, 10));

    // Advance past lease TTL and recover run
    clock.advanceMs(3000);
    const recovery = coordinator.recoverExpiredRuns();
    expect(recovery.recoveredCount).toBe(1);

    // Worker 2 reclaims the recovered run
    coordinator.claimRun(run.runId, "worker-2", 15000);

    // Worker 1 finishes late and returns SUCCESS
    releaseProvider();
    const worker1Result = await worker1Promise;

    expect(worker1Result.status).toBe("FENCED");
    if (worker1Result.status === "FENCED") {
      expect(worker1Result.error).toBeInstanceOf(LeaseLostError);
    }

    // Run record in coordinator still belongs to worker-2 and is NOT COMPLETED by worker-1
    const currentRun = coordinator.getRun(run.runId);
    expect(currentRun!.currentWorkerId).toBe("worker-2");
    expect(currentRun!.status).toBe("LEASED");
    expect(currentRun!.resultPayload).toBeNull();
    store.close();
  });

  // Scenario 5: Normal success before abort commits COMPLETED
  it("Scenario 5: Normal success before abort commits COMPLETED", async () => {
    class FastOp implements DeterministicOperation<unknown, string> {
      readonly name = "echo";
      execute(_input: unknown, _ctx: OperationContext): OperationResult<string> {
        return { output: "fast-ok" };
      }
    }

    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const provider = new InProcessExecutionProvider([new FastOp()]);
    const worker = new WorkerRuntime({
      workerId: "worker-fast",
      coordinator,
      clock,
      executionProvider: provider,
    });

    const task = coordinator.createTask({ title: "echo", inputPayload: null });
    createAndActivateContract(store, task.taskId, {
      verificationSpecs: [createVerificationSpec({ specId: "vspec-fast", ruleKind: "EXACT_OUTPUT_MATCH", expectedValue: "fast-ok" })],
    });
    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const result = await worker.runOnce(run.runId);
    expect(result.status).toBe("COMPLETED");
    if (result.status === "COMPLETED") {
      expect(result.output).toBe("fast-ok");
    }

    const persisted = coordinator.getRun(run.runId);
    expect(persisted!.status).toBe("COMPLETED");
    expect(persisted!.resultPayload).toBe("fast-ok");
    store.close();
  });

  // Scenario 6: Operation cooperating with abort settles as CANCELLED
  it("Scenario 6: Operation cooperating with abort settles as CANCELLED", async () => {
    class CoopOp implements DeterministicOperation<unknown, string> {
      readonly name = "slow";
      async execute(_input: unknown, _ctx: OperationContext): Promise<OperationResult<string>> {
        await new Promise((r) => setTimeout(r, 60));
        return { output: "late" };
      }
    }

    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const provider = new InProcessExecutionProvider([new CoopOp()]);
    const worker = new WorkerRuntime({
      workerId: "worker-coop",
      coordinator,
      clock,
      executionProvider: provider,
    });

    const task = coordinator.createTask({ title: "slow", inputPayload: null });
    createAndActivateContract(store, task.taskId);
    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const controller = new AbortController();
    const runPromise = worker.runOnce(run.runId, { signal: controller.signal });

    // Abort midway through execution
    setTimeout(() => {
      controller.abort("User cancelled execution");
    }, 15);

    const result = await runPromise;
    expect(result.status).toBe("CANCELLED");

    const persisted = coordinator.getRun(run.runId);
    expect(persisted!.status).toBe("CANCELLED");
    store.close();
  });

  // Scenario 7: Operation ignoring cancellation settles safely without premature gate release
  it("Scenario 7: Operation ignoring cancellation settles safely without premature gate release", async () => {
    const events: string[] = [];
    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const durableCoordinator = new SqliteTenantLaunchCoordinator(store, clock);

    const mockLaunchCoordinator: TenantLaunchCoordinatorPort = {
      store,
      async acquire(params: AcquireGateParams): Promise<TenantLaunchGate> {
        events.push("gate_acquired");
        return durableCoordinator.acquire(params);
      },
      async release(gate: TenantLaunchGate): Promise<void> {
        events.push("gate_released");
        return durableCoordinator.release(gate);
      },
    };

    let startPromiseResolve: () => void = () => {};
    const startPromise = new Promise<void>((r) => {
      startPromiseResolve = r;
    });

    const mockProvider: ExecutionProvider = {
      name: "docker",
      tenantModel: "ISOLATED_PROCESSES",
      cancellationModel: "NONE",
      quiescence: {
        async quiesceRun(_runId: string) {
          return { status: "QUIESCENT", stopped: 0 };
        },
      },
      async execute<TInput = unknown, TOutput = unknown>(
        _request: ExecutionRequest<TInput>
      ): Promise<ExecutionResult<TOutput>> {
        events.push("execute_start");
        startPromiseResolve();
        // Completely ignores cancellation and sleeps 50ms
        await new Promise((r) => setTimeout(r, 50));
        events.push("execute_end");
        return { status: "SUCCESS", output: "stubborn-result" as TOutput, durationMs: 50 };
      },
    };

    const coordinator = new RunCoordinator(store, clock);
    const worker = new WorkerRuntime({
      workerId: "worker-stubborn",
      coordinator,
      clock,
      executionProvider: mockProvider,
      launchCoordinator: mockLaunchCoordinator,
      isIsolationAvailable: true,
    });

    const task = coordinator.createTask({ title: "echo", inputPayload: null });
    createAndActivateContract(store, task.taskId, {
      policy: createDefaultDockerPolicy("test-docker-policy"),
    });
    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const controller = new AbortController();
    const runPromise = worker.runOnce(run.runId, { signal: controller.signal });

    // Wait until execute starts before aborting
    await startPromise;
    events.push("abort_triggered");
    controller.abort("Cancel request");

    const result = await runPromise;
    // Cancellation takes precedence over late success
    expect(result.status).toBe("CANCELLED");

    // Verify ordering: execute_end occurred BEFORE gate_released!
    expect(events.indexOf("execute_start")).toBeLessThan(events.indexOf("abort_triggered"));
    expect(events.indexOf("abort_triggered")).toBeLessThan(events.indexOf("execute_end"));
    expect(events.indexOf("execute_end")).toBeLessThan(events.indexOf("gate_released"));
    store.close();
  });

  // Scenario 8: Provider rejection during abort maps to CANCELLED without unhandled rejection
  it("Scenario 8: Provider rejection during abort maps to CANCELLED without unhandled rejection", async () => {
    let startResolve: () => void = () => {};
    const started = new Promise<void>((r) => {
      startResolve = r;
    });

    const explodingProvider: ExecutionProvider = {
      name: "in-process",
      tenantModel: "NONE",
      cancellationModel: "COOPERATIVE",
      async execute<TInput = unknown, TOutput = unknown>(
        request: ExecutionRequest<TInput>
      ): Promise<ExecutionResult<TOutput>> {
        return new Promise((_resolve, reject) => {
          startResolve();
          request.signal?.addEventListener("abort", () => {
            reject(new Error("Subprocess abruptly killed by abort signal"));
          });
        });
      },
    };

    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const worker = new WorkerRuntime({
      workerId: "worker-reject",
      coordinator,
      clock,
      executionProvider: explodingProvider,
    });

    const task = coordinator.createTask({ title: "echo", inputPayload: null });
    createAndActivateContract(store, task.taskId, {
      verificationSpecs: [createVerificationSpec({ specId: "vspec-fast", ruleKind: "EXACT_OUTPUT_MATCH", expectedValue: "fast-ok" })],
    });
    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const controller = new AbortController();
    const runPromise = worker.runOnce(run.runId, { signal: controller.signal });

    await started;
    controller.abort(new Error("Force cancel"));

    const result = await runPromise;
    expect(result.status).toBe("CANCELLED");

    const persisted = coordinator.getRun(run.runId);
    expect(persisted!.status).toBe("CANCELLED");
    store.close();
  });

  // Scenario 9: Launch gate remains held through workspace disposal
  it("Scenario 9: Launch gate remains held through workspace disposal", async () => {
    const ordering: string[] = [];
    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const durableCoordinator = new SqliteTenantLaunchCoordinator(store, clock);

    const mockLaunchCoordinator: TenantLaunchCoordinatorPort = {
      store,
      async acquire(params: AcquireGateParams): Promise<TenantLaunchGate> {
        ordering.push("gate_acquired");
        return durableCoordinator.acquire(params);
      },
      async release(gate: TenantLaunchGate): Promise<void> {
        ordering.push("gate_released");
        return durableCoordinator.release(gate);
      },
    };

    const testRoot = path.join(os.tmpdir(), `emerald-cancel-s9-${crypto.randomUUID()}`);
    await fs.mkdir(testRoot, { recursive: true, mode: 0o700 });
    const realRoot = await fs.realpath(testRoot);
    const realWorkspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: realRoot });

    // Wrap disposeWorkspace to capture timing in ordering array while preserving prototype methods
    const originalDispose = realWorkspaceAdapter.disposeWorkspace.bind(realWorkspaceAdapter);
    realWorkspaceAdapter.disposeWorkspace = async (workspaceId, fencing) => {
      ordering.push("workspace_disposed");
      return originalDispose(workspaceId, fencing);
    };

    const mockProvider: ExecutionProvider = {
      name: "docker",
      tenantModel: "ISOLATED_PROCESSES",
      cancellationModel: "COOPERATIVE",
      quiescence: {
        async quiesceRun(_runId: string) {
          return { status: "QUIESCENT", stopped: 0 };
        },
      },
      async execute<TInput = unknown, TOutput = unknown>(
        _request: ExecutionRequest<TInput>
      ): Promise<ExecutionResult<TOutput>> {
        ordering.push("provider_executed");
        return { status: "SUCCESS", output: { ok: true } as TOutput, durationMs: 5 };
      },
    };

    const coordinator = new RunCoordinator(store, clock);
    const worker = new WorkerRuntime({
      workerId: "worker-g9",
      coordinator,
      clock,
      executionProvider: mockProvider,
      launchCoordinator: mockLaunchCoordinator,
      workspacePort: realWorkspaceAdapter,
      isIsolationAvailable: true,
    });

    const task = coordinator.createTask({ title: "echo", inputPayload: null });
    createAndActivateContract(store, task.taskId, {
      policy: createDefaultDockerPolicy("test-docker-policy-9"),
      verificationSpecs: [createVerificationSpec({ specId: "vspec-ok", ruleKind: "EXACT_OUTPUT_MATCH", expectedValue: { ok: true } })],
    });
    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const result = await worker.runOnce(run.runId);
    expect(result.status).toBe("COMPLETED");

    // Strictly assert workspace_disposed comes BEFORE gate_released
    expect(ordering).toEqual([
      "gate_acquired",
      "provider_executed",
      "workspace_disposed",
      "gate_released",
    ]);

    await fs.rm(realRoot, { recursive: true, force: true }).catch(() => {});
    store.close();
  });

  // Scenario 10: Providers without cancellation declaration remain backward-compatible
  it("Scenario 10: Providers without cancellation declaration remain backward-compatible", async () => {
    const legacyProvider: ExecutionProvider = {
      name: "in-process",
      tenantModel: "NONE",
      // cancellationModel omitted deliberately
      async execute<TInput = unknown, TOutput = unknown>(
        request: ExecutionRequest<TInput>
      ): Promise<ExecutionResult<TOutput>> {
        return {
          status: "SUCCESS",
          output: { receivedOperation: request.operationName } as TOutput,
          durationMs: 1,
        };
      },
    };

    expect(resolveProviderCancellationModel(legacyProvider)).toBe("NONE");

    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const worker = new WorkerRuntime({
      workerId: "worker-legacy",
      coordinator,
      clock,
      executionProvider: legacyProvider,
    });

    const task = coordinator.createTask({ title: "echo", inputPayload: null });
    createAndActivateContract(store, task.taskId, {
      verificationSpecs: [createVerificationSpec({ specId: "vspec-legacy", ruleKind: "EXACT_OUTPUT_MATCH", expectedValue: { receivedOperation: "echo" } })],
    });
    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const result = await worker.runOnce(run.runId);
    expect(result.status).toBe("COMPLETED");
    if (result.status === "COMPLETED") {
      expect(result.output).toEqual({ receivedOperation: "echo" });
    }

    const persisted = coordinator.getRun(run.runId);
    expect(persisted!.status).toBe("COMPLETED");
    store.close();
  });
});
