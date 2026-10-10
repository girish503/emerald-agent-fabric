import { describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator, WorkerRuntime } from "../../src/application/index.js";
import { createAndActivateContract } from "./test-helpers.js";
import {
  createDenyAllPolicy,
  createExecutionPolicy,
} from "../../src/domain/policy.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { ExecutionProvider, ExecutionRequest, ExecutionResult } from "../../src/ports/execution-provider.port.js";

/**
 * Spy ExecutionProvider that records all execution invocations.
 */
class SpyExecutionProvider implements ExecutionProvider {
  readonly name: string;
  readonly invocations: ExecutionRequest[] = [];
  private readonly mockOutput: unknown;

  constructor(name: string = "spy-provider", mockOutput: unknown = { ok: true }) {
    this.name = name;
    this.mockOutput = mockOutput;
  }

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocations.push(request);
    return {
      status: "SUCCESS",
      output: this.mockOutput as TOutput,
      durationMs: 5,
      providerMetadata: { provider: this.name },
    };
  }
}

describe("WorkerRuntime — Policy Enforcement & Capability Boundary", () => {
  it("Allowed Request: Evaluates policy -> ALLOWED -> Provider executes -> Run completes", async () => {
    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const spyProvider = new SpyExecutionProvider("in-process", { echoed: 123 });

    const policy = createExecutionPolicy({
      policyId: "allow-echo-in-process",
      allowedCapabilities: ["execution.echo"],
      isolationRequirement: "IN_PROCESS",
      trustedInProcessOperations: ["echo", "execution.echo"],
    });

    const worker = new WorkerRuntime({
      workerId: "policy-worker",
      coordinator,
      clock,
      executionProvider: spyProvider,
    });

    const task = coordinator.createTask({
      title: "echo",
      inputPayload: { msg: "hello" },
    });
    createAndActivateContract(store, task.taskId, { policy });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const result = await worker.runOnce();

    expect(result.status).toBe("COMPLETED");
    expect(spyProvider.invocations).toHaveLength(1);
    expect(spyProvider.invocations[0]!.operationName).toBe("echo");

    // Verify events stream contains policy.evaluated followed by run.completed
    const events = coordinator.getEventsForRun(run.runId);
    const eventTypes = events.map((e) => e.eventType);

    expect(eventTypes).toContain("policy.evaluated");
    expect(eventTypes).toContain("run.completed");

    const policyEvent = events.find((e) => e.eventType === "policy.evaluated");
    expect(policyEvent).toBeDefined();
    expect((policyEvent!.payload as { allowed: boolean }).allowed).toBe(true);

    store.close();
  });

  it("CRITICAL INVARIANT: Denied Request -> POLICY DENY -> Provider is NOT called (0 executions)", async () => {
    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const spyProvider = new SpyExecutionProvider("in-process");

    // Policy permits sum, but task will request echo
    const policy = createExecutionPolicy({
      policyId: "sum-only-policy",
      allowedCapabilities: ["execution.sum"],
      isolationRequirement: "IN_PROCESS",
      trustedInProcessOperations: ["sum"],
    });

    const worker = new WorkerRuntime({
      workerId: "strict-worker",
      coordinator,
      clock,
      executionProvider: spyProvider,
    });

    const task = coordinator.createTask({
      title: "echo", // Not permitted!
      inputPayload: null,
    });
    createAndActivateContract(store, task.taskId, { policy });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const result = await worker.runOnce();

    // 1. Result is FAILED with POLICY_DENIED code
    expect(result.status).toBe("FAILED");
    if (result.status === "FAILED") {
      const err = result.error as { code: string; details: { reasonCode: string } };
      expect(err.code).toBe("POLICY_DENIED");
      expect(err.details.reasonCode).toBe("CAPABILITY_NOT_GRANTED");
    }

    // 2. CRITICAL: Provider was NEVER called!
    expect(spyProvider.invocations).toHaveLength(0);

    // 3. Database state transitions to FAILED
    const failedRun = coordinator.getRun(run.runId);
    expect(failedRun!.status).toBe("FAILED");
    expect((failedRun!.errorPayload as { code: string }).code).toBe("POLICY_DENIED");

    // 4. Lease was safely released
    const lease = coordinator.getLease(failedRun!.leaseId!);
    expect(lease!.state).toBe("RELEASED");

    // 5. Auditable policy.evaluated and run.failed events exist
    const events = coordinator.getEventsForRun(run.runId);
    const policyEvent = events.find((e) => e.eventType === "policy.evaluated");
    expect(policyEvent).toBeDefined();
    expect((policyEvent!.payload as { allowed: boolean; reasonCode: string }).allowed).toBe(false);
    expect((policyEvent!.payload as { reasonCode: string }).reasonCode).toBe("CAPABILITY_NOT_GRANTED");

    const failedEvent = events.find((e) => e.eventType === "run.failed");
    expect(failedEvent).toBeDefined();

    store.close();
  });

  it("SECURITY REGRESSION: ISOLATED required -> Docker unavailable -> DENY / FAIL CLOSED -> NO IN_PROCESS FALLBACK", async () => {
    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const spyDockerProvider = new SpyExecutionProvider("docker");

    const policy = createExecutionPolicy({
      policyId: "strict-isolated-policy",
      allowedCapabilities: ["execution.echo"],
      isolationRequirement: "ISOLATED",
    });

    const worker = new WorkerRuntime({
      workerId: "fail-closed-worker",
      coordinator,
      clock,
      executionProvider: spyDockerProvider,
      // Simulate Docker daemon down / unreachable
      isIsolationAvailable: false,
    });

    const task = coordinator.createTask({
      title: "echo",
      inputPayload: { test: true },
    });
    createAndActivateContract(store, task.taskId, { policy });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const result = await worker.runOnce();

    expect(result.status).toBe("FAILED");
    if (result.status === "FAILED") {
      const err = result.error as { code: string; details: { reasonCode: string } };
      expect(err.code).toBe("POLICY_DENIED");
      expect(err.details.reasonCode).toBe("ISOLATION_REQUIREMENT_NOT_MET");
    }

    // Zero execution occurred
    expect(spyDockerProvider.invocations).toHaveLength(0);

    // Run is in terminal FAILED state
    const failedRun = coordinator.getRun(run.runId);
    expect(failedRun!.status).toBe("FAILED");

    store.close();
  });

  it("Deny-All Policy: Automatically fails closed for all tasks without provider invocation", async () => {
    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const spyProvider = new SpyExecutionProvider("in-process");

    const worker = new WorkerRuntime({
      workerId: "deny-all-worker",
      coordinator,
      clock,
      executionProvider: spyProvider,
    });

    const task = coordinator.createTask({
      title: "echo",
      inputPayload: null,
    });
    createAndActivateContract(store, task.taskId, { policy: createDenyAllPolicy() });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const result = await worker.runOnce();

    expect(result.status).toBe("FAILED");
    expect(spyProvider.invocations).toHaveLength(0);

    store.close();
  });

  it("Retry Safety: Policy denial does not cause an unsafe retry loop", async () => {
    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const spyProvider = new SpyExecutionProvider("in-process");

    const worker = new WorkerRuntime({
      workerId: "no-retry-worker",
      coordinator,
      clock,
      executionProvider: spyProvider,
    });

    const task = coordinator.createTask({
      title: "echo",
      inputPayload: null,
    });
    createAndActivateContract(store, task.taskId, { maxAttempts: 5, policy: createDenyAllPolicy() });

    const { run } = coordinator.createRun({
      taskId: task.taskId,
      maxAttempts: 5, // High retry budget
    });
    coordinator.queueRun(run.runId);

    // First worker pass
    const result1 = await worker.runOnce();
    expect(result1.status).toBe("FAILED");

    // Recover sweep attempts to find expired runs
    clock.advanceMs(100000);
    const recoverResult = coordinator.recoverExpiredRuns();
    expect(recoverResult.recoveredCount).toBe(0); // FAILED is terminal; never retried!

    // Second worker pass finds no queued runs
    const result2 = await worker.runOnce();
    expect(result2.status).toBe("IDLE");

    store.close();
  });

  it("SECURITY REGRESSION: ISOLATED required -> InProcess provider -> DENY / FAIL CLOSED (no silent downgrade)", async () => {
    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const spyInProcessProvider = new SpyExecutionProvider("in-process");

    const policy = createExecutionPolicy({
      policyId: "strict-isolated-policy",
      allowedCapabilities: ["execution.echo"],
      isolationRequirement: "ISOLATED",
    });

    const worker = new WorkerRuntime({
      workerId: "no-downgrade-worker",
      coordinator,
      clock,
      executionProvider: spyInProcessProvider,
    });

    const task = coordinator.createTask({
      title: "echo",
      inputPayload: { test: true },
    });
    createAndActivateContract(store, task.taskId, { policy });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const result = await worker.runOnce();

    expect(result.status).toBe("FAILED");
    if (result.status === "FAILED") {
      const err = result.error as { code: string; details: { reasonCode: string } };
      expect(err.code).toBe("POLICY_DENIED");
      expect(err.details.reasonCode).toBe("ISOLATION_REQUIREMENT_NOT_MET");
    }

    // Zero execution occurred
    expect(spyInProcessProvider.invocations).toHaveLength(0);

    // Run is in terminal FAILED state
    const failedRun = coordinator.getRun(run.runId);
    expect(failedRun!.status).toBe("FAILED");

    store.close();
  });

  it("WorkerRuntime derives policy authority from MissionContract when constructor options omit policy", async () => {
    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const spyProvider = new SpyExecutionProvider("in-process", { default: "ok" });

    // No ephemeral policy in WorkerRuntime constructor options
    const worker = new WorkerRuntime({
      workerId: "contract-policy-worker",
      coordinator,
      clock,
      executionProvider: spyProvider,
    });

    const task = coordinator.createTask({
      title: "echo",
      inputPayload: { foo: "bar" },
    });
    createAndActivateContract(store, task.taskId);

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const result = await worker.runOnce();

    expect(result.status).toBe("COMPLETED");
    expect(spyProvider.invocations).toHaveLength(1);

    const events = coordinator.getEventsForRun(run.runId);
    const policyEvents = events.filter((e) => e.eventType === "policy.evaluated");
    expect(policyEvents).toHaveLength(1);
    expect((policyEvents[0]!.payload as { allowed: boolean }).allowed).toBe(true);

    store.close();
  });
});

