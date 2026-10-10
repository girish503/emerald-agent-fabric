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

/**
 * Mock ExecutionProvider that returns configured output and metadata.
 */
class MockExecutionProvider implements ExecutionProvider {
  readonly name: string;
  readonly invocations: ExecutionRequest[] = [];
  private readonly mockOutput: unknown;
  private readonly exitCode?: number;

  constructor(
    name: string = "mock-provider",
    mockOutput: unknown = { ok: true },
    exitCode?: number
  ) {
    this.name = name;
    this.mockOutput = mockOutput;
    this.exitCode = exitCode;
  }

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocations.push(request);
    return {
      status: "SUCCESS",
      output: this.mockOutput as TOutput,
      durationMs: 5,
      providerMetadata: {
        provider: this.name,
        exitCode: this.exitCode ?? 0,
      },
    };
  }
}

describe("WorkerRuntime — Evidence & Verification Boundary", () => {
  it("Execution Success + Verification Success -> Run transitions to COMPLETED", async () => {
    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const mockProvider = new MockExecutionProvider("in-process", { sum: 5 });

    const verificationSpec = createVerificationSpec({
      specId: "spec-sum-5",
      ruleKind: "EXACT_OUTPUT_MATCH",
      expectedValue: { sum: 5 },
    });

    const worker = new WorkerRuntime({
      workerId: "verified-worker",
      coordinator,
      clock,
      executionProvider: mockProvider,
      policy: createDefaultInProcessPolicy(),
      verificationSpec,
    });

    const task = coordinator.createTask({
      title: "sum",
      inputPayload: [2, 3],
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const result = await worker.runOnce();

    expect(result.status).toBe("COMPLETED");
    expect(mockProvider.invocations).toHaveLength(1);

    // Verify event progression
    const events = coordinator.getEventsForRun(run.runId);
    const eventTypes = events.map((e) => e.eventType);

    expect(eventTypes).toEqual([
      "run.created",
      "run.queued",
      "worker.claimed",
      "run.started",
      "policy.evaluated",
      "evidence.recorded", // Output payload evidence
      "evidence.recorded", // Process exit evidence
      "verification.completed",
      "run.completed",
    ]);

    const verificationEvent = events.find((e) => e.eventType === "verification.completed");
    expect(verificationEvent).toBeDefined();
    expect((verificationEvent!.payload as { status: string }).status).toBe("VERIFIED");

    store.close();
  });

  it("CRITICAL INVARIANT: Provider says SUCCESS + Verification says FAILED -> NO run.completed event", async () => {
    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    // Provider claims output is { sum: 4 }, but expectation is { sum: 5 }
    const mockProvider = new MockExecutionProvider("in-process", { sum: 4 });

    const verificationSpec = createVerificationSpec({
      specId: "spec-expect-5",
      ruleKind: "EXACT_OUTPUT_MATCH",
      expectedValue: { sum: 5 },
    });

    const worker = new WorkerRuntime({
      workerId: "strict-verifier-worker",
      coordinator,
      clock,
      executionProvider: mockProvider,
      policy: createDefaultInProcessPolicy(),
      verificationSpec,
    });

    const task = coordinator.createTask({
      title: "sum",
      inputPayload: [2, 3],
    });

    const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3 });
    coordinator.queueRun(run.runId);

    const result = await worker.runOnce();

    // 1. Worker returns FAILED with VERIFICATION_FAILED
    expect(result.status).toBe("FAILED");
    if (result.status === "FAILED") {
      const err = result.error as { code: string; details: { reasonCode: string } };
      expect(err.code).toBe("VERIFICATION_FAILED");
      expect(err.details.reasonCode).toBe("ASSERTION_FAILED");
    }

    // 2. Run state in database is terminal FAILED
    const failedRun = coordinator.getRun(run.runId);
    expect(failedRun!.status).toBe("FAILED");
    expect((failedRun!.errorPayload as { code: string }).code).toBe("VERIFICATION_FAILED");

    // 3. Provider was called exactly ONCE (zero retry invocation)
    expect(mockProvider.invocations).toHaveLength(1);

    // 4. Lease was released
    const lease = coordinator.getLease(failedRun!.leaseId!);
    expect(lease!.state).toBe("RELEASED");

    // 5. CRITICAL: run.completed event was NEVER emitted!
    const events = coordinator.getEventsForRun(run.runId);
    const eventTypes = events.map((e) => e.eventType);

    expect(eventTypes).not.toContain("run.completed");
    expect(eventTypes).toContain("evidence.recorded");
    expect(eventTypes).toContain("verification.completed");
    expect(eventTypes).toContain("run.failed");

    const verifEvent = events.find((e) => e.eventType === "verification.completed");
    expect((verifEvent!.payload as { status: string }).status).toBe("FAILED");

    store.close();
  });

  it("Secret Redaction: Sensitive keys in execution output are redacted before persisting in evidence.recorded", async () => {
    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);

    // Provider output contains sensitive tokens
    const secretOutput = {
      result: 42,
      api_token: "super-secret-production-token-9999",
      credentials: {
        password: "super-secret-password-xyz",
      },
    };

    const mockProvider = new MockExecutionProvider("in-process", secretOutput);

    const verificationSpec = createVerificationSpec({
      specId: "spec-redacted",
      ruleKind: "EXACT_OUTPUT_MATCH",
      expectedValue: {
        result: 42,
        api_token: "[REDACTED]",
        credentials: {
          password: "[REDACTED]",
        },
      },
    });

    const worker = new WorkerRuntime({
      workerId: "redaction-worker",
      coordinator,
      clock,
      executionProvider: mockProvider,
      policy: createDefaultInProcessPolicy(),
      verificationSpec,
    });

    const task = coordinator.createTask({
      title: "echo",
      inputPayload: secretOutput,
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const result = await worker.runOnce();
    expect(result.status).toBe("COMPLETED");

    // Inspect persisted evidence events in the database
    const events = coordinator.getEventsForRun(run.runId);
    const evidenceEvent = events.find(
      (e) => e.eventType === "evidence.recorded" && (e.payload as { kind: string }).kind === "OUTPUT_PAYLOAD"
    );

    expect(evidenceEvent).toBeDefined();
    const payload = evidenceEvent!.payload as { summary: Record<string, unknown> };

    // Verified redacted values
    expect(payload.summary.api_token).toBe("[REDACTED]");
    expect((payload.summary.credentials as Record<string, unknown>).password).toBe("[REDACTED]");

    // Verify raw secret string never appears in evidence or verification event payloads
    const evidenceAndVerificationEvents = events.filter(
      (e) => e.eventType === "evidence.recorded" || e.eventType === "verification.completed"
    );
    const eventJson = JSON.stringify(evidenceAndVerificationEvents);
    expect(eventJson).not.toContain("super-secret-production-token-9999");
    expect(eventJson).not.toContain("super-secret-password-xyz");

    store.close();
  });

  it("EXIT_CODE_ZERO rule verification catches non-zero exit code", async () => {
    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);

    // Provider reports non-zero exitCode
    const mockProvider = new MockExecutionProvider("in-process", { ok: false }, 1);

    const verificationSpec = createVerificationSpec({
      specId: "spec-exit-zero",
      ruleKind: "EXIT_CODE_ZERO",
    });

    const worker = new WorkerRuntime({
      workerId: "exit-code-worker",
      coordinator,
      clock,
      executionProvider: mockProvider,
      policy: createDefaultInProcessPolicy(),
      verificationSpec,
    });

    const task = coordinator.createTask({
      title: "echo",
      inputPayload: null,
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const result = await worker.runOnce();

    expect(result.status).toBe("FAILED");
    if (result.status === "FAILED") {
      const err = result.error as { code: string; details: { reasonCode: string } };
      expect(err.code).toBe("VERIFICATION_FAILED");
      expect(err.details.reasonCode).toBe("ASSERTION_FAILED");
    }

    store.close();
  });

  it("Dynamic VerificationSpec resolver per execution request", async () => {
    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const mockProvider = new MockExecutionProvider("in-process", { sum: 10 });

    const worker = new WorkerRuntime({
      workerId: "dynamic-resolver-worker",
      coordinator,
      clock,
      executionProvider: mockProvider,
      policy: createDefaultInProcessPolicy(),
      verificationSpec: (req) => {
        if (req.operationName === "sum") {
          return createVerificationSpec({
            specId: "dynamic-sum-10",
            ruleKind: "EXACT_OUTPUT_MATCH",
            expectedValue: { sum: 10 },
          });
        }
        return undefined;
      },
    });

    const task = coordinator.createTask({
      title: "sum",
      inputPayload: [5, 5],
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const result = await worker.runOnce();
    expect(result.status).toBe("COMPLETED");

    store.close();
  });
});
