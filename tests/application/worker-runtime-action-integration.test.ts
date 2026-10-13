/**
 * Phase 4 / Task 4.4-E — WorkerRuntime ↔ Action/Attempt ↔ ToolExecutionGateway Lifecycle Integration Tests
 *
 * Verifies the complete deterministic execution lifecycle:
 * WorkerRuntime
 *     ↓
 * Action
 *     ↓
 * Attempt
 *     ↓
 * ToolExecutionGateway
 *     ↓
 * ToolAdapter
 *     ↓
 * ExecutionProvider (where required)
 *     ↓
 * Attempt result
 *     ↓
 * Action result
 *
 * Adheres strictly to the architectural constraints:
 * - Mission Contract authority
 * - Capability policy governance
 * - Non-clamping resource ceilings
 * - Workspace sandbox containment
 * - Worker lease fencing
 * - Action/Attempt state machines
 * - Durable operational state + event atomicity in single transaction
 * - Idempotency identity
 * - Deterministic failure, timeout, cancellation, and UNKNOWN propagation
 * - No automatic retries
 * - Zero provider execution on governance/pre-dispatch rejections
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
import { Run } from "../../src/domain/run.js";
import { createAttemptIdempotencyToken } from "../../src/domain/attempt.js";
import {
  LeaseLostError,
  ResourceLimitExceededError,
  TerminalStateError,
} from "../../src/domain/errors.js";
import {
  createExecutionPolicy,
  ExecutionPolicy,
} from "../../src/domain/policy.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import {
  ExecutionErrorCode,
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "../../src/ports/execution-provider.port.js";
import { createAndActivateContract } from "./test-helpers.js";

/**
 * CountingExecutionProvider tracks provider calls and returns configurable responses.
 */
class CountingExecutionProvider implements ExecutionProvider {
  readonly name = "counting-provider";
  readonly invocations: ExecutionRequest[] = [];
  nextResult?: ExecutionResult;

  get calls(): number {
    return this.invocations.length;
  }

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocations.push(request);

    if (this.nextResult) {
      return this.nextResult as ExecutionResult<TOutput>;
    }

    return {
      status: "SUCCESS",
      output: {
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        durationMs: 15,
        outputTruncated: false,
      } as unknown as TOutput,
      durationMs: 15,
    };
  }
}

interface TestFixtureOptions {
  readonly policy?: ExecutionPolicy;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxAttempts?: number;
  readonly workerId?: string;
  readonly dbPath?: string;
}

function setupTestFixture(options: TestFixtureOptions = {}) {
  const clock = new SettableClock("2026-10-12T10:00:00.000Z");
  const store = new SqliteStateStore(
    options.dbPath ? { location: options.dbPath } : undefined
  );
  const coordinator = new RunCoordinator(store, clock);
  const provider = new CountingExecutionProvider();
  const workerId = options.workerId ?? "worker-action-1";

  // Register worker
  store.transaction((tx) => {
    tx.insertWorker({
      workerId,
      hostname: "localhost",
      pid: 1234,
      status: "ACTIVE",
      createdAt: clock.nowIso(),
      lastHeartbeatAt: clock.nowIso(),
    });
  });

  const task = coordinator.createTask({
    title: "action-integration-task",
    description: "Task for verifying Action and Attempt execution lifecycle",
    inputPayload: { target: "test" },
  });

  const policy =
    options.policy ??
    createExecutionPolicy({
      policyId: `policy-${task.taskId}`,
      allowedCapabilities: [
        "workspace.file.read",
        "workspace.file.write",
        "workspace.code.search",
        "git.read",
        "process.execute",
      ],
      isolationRequirement: "ISOLATED",
    });

  const contract = createAndActivateContract(store, task.taskId, {
    policy,
    timeoutMs: options.timeoutMs ?? 10000,
    maxOutputBytes: options.maxOutputBytes ?? 1048576,
    maxAttempts: options.maxAttempts ?? 3,
  });

  const { run } = coordinator.createRun({ taskId: task.taskId });
  coordinator.queueRun(run.runId);
  const claimResult = coordinator.claimRun(run.runId, workerId, 15000);
  const startResult = coordinator.startRun(run.runId, workerId, claimResult.lease.leaseId);

  // Setup temp directory for workspace
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-test-act-"));
  const workspacePort = new NodeFsWorkspaceAdapter({ workspaceRoot: tempDir });

  const workerRuntime = new WorkerRuntime({
    workerId,
    coordinator,
    clock,
    executionProvider: provider,
    workspacePort,
  });

  return {
    clock,
    store,
    coordinator,
    provider,
    workerId,
    task,
    contract,
    run: startResult.run,
    lease: claimResult.lease,
    workspacePort,
    tempDir,
    workerRuntime,
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

describe("WorkerRuntime ↔ Action/Attempt ↔ ToolExecutionGateway Lifecycle Integration (Task 4.4-E)", () => {
  // =========================================================================
  // 1. Successful Action Lifecycle
  // =========================================================================
  describe("1. Successful Action Execution", () => {
    it("executes write_file -> Action SUCCEEDED and Attempt SUCCEEDED through complete lifecycle", async () => {
      const fixture = setupTestFixture();

      try {
        // Provision workspace for run
        const wsHandle = await fixture.workspacePort.provisionWorkspace({
          workspaceId: "ws-act-1",
          runId: fixture.run.runId,
          taskId: fixture.task.taskId,
          maxWorkspaceBytes: 50 * 1024 * 1024,
          maxFileSizeBytes: 10 * 1024 * 1024,
        });

        const actionResult = await fixture.workerRuntime.executeAction({
          runId: fixture.run.runId,
          toolName: "write_file",
          inputPayload: {
            path: "greeting.txt",
            content: "Hello Emerald Agent Fabric",
            overwrite: true,
          },
          workspace: wsHandle,
        });

        // 1. Return result assertions
        expect(actionResult.status).toBe("SUCCEEDED");
        expect(actionResult.runId).toBe(fixture.run.runId);
        expect(actionResult.actionId).toBeDefined();
        expect(actionResult.attemptId).toBeDefined();
        expect(actionResult.output).toEqual(
          expect.objectContaining({
            path: "greeting.txt",
            bytesWritten: Buffer.byteLength("Hello Emerald Agent Fabric", "utf8"),
          })
        );

        // 2. Persisted Action assertions
        const persistedAction = fixture.store.getAction(actionResult.actionId);
        expect(persistedAction).not.toBeNull();
        expect(persistedAction?.status).toBe("SUCCEEDED");
        expect(persistedAction?.toolName).toBe("write_file");
        expect(persistedAction?.sequenceNumber).toBe(1);
        expect(persistedAction?.totalAttempts).toBe(1);
        expect(persistedAction?.activeAttemptNumber).toBeNull();
        expect(persistedAction?.resultPayload).toEqual(actionResult.output);
        expect(persistedAction?.errorPayload).toBeNull();
        expect(persistedAction?.completedAt).not.toBeNull();
        expect(persistedAction?.contractBinding.contractId).toBe(fixture.contract.spec.contractId);
        expect(persistedAction?.contractBinding.version).toBe(fixture.contract.spec.version);

        // 3. Persisted Attempt assertions
        const persistedAttempts = fixture.store.getAttemptsForAction(actionResult.actionId);
        expect(persistedAttempts.length).toBe(1);

        const attempt = persistedAttempts[0]!;
        expect(attempt.attemptId).toBe(actionResult.attemptId);
        expect(attempt.attemptNumber).toBe(1);
        expect(attempt.status).toBe("SUCCEEDED");
        expect(attempt.workerId).toBe(fixture.workerId);
        expect(attempt.leaseId).toBe(fixture.lease.leaseId);
        expect(attempt.idempotencyToken).toBe(
          createAttemptIdempotencyToken(fixture.run.runId, actionResult.actionId, 1)
        );
        expect(attempt.exitCode).toBe(0);
        expect(attempt.outputPayload).toEqual(actionResult.output);
        expect(attempt.errorPayload).toBeNull();
        expect(attempt.completedAt).not.toBeNull();

        // 4. File actually written to disk in workspace
        const resolvedPath = await fixture.workspacePort.resolvePath("ws-act-1", "greeting.txt");
        const writtenContent = fs.readFileSync(resolvedPath, "utf8");
        expect(writtenContent).toBe("Hello Emerald Agent Fabric");

        // 5. Causal Event History in exact monotonic sequence
        const events = fixture.store.getEventsForRun(fixture.run.runId);
        const actionAndAttemptEvents = events.filter((e) =>
          e.eventType.startsWith("action.") || e.eventType.startsWith("attempt.")
        );

        const eventTypes = actionAndAttemptEvents.map((e) => e.eventType);
        expect(eventTypes).toEqual([
          "action.created",
          "action.authorized",
          "action.started",
          "attempt.created",
          "attempt.dispatched",
          "attempt.started",
          "attempt.completed",
          "action.completed",
        ]);

        // Verify sequence monotonicity
        for (let i = 1; i < actionAndAttemptEvents.length; i++) {
          expect(actionAndAttemptEvents[i]!.sequence).toBeGreaterThan(
            actionAndAttemptEvents[i - 1]!.sequence
          );
        }
      } finally {
        fixture.cleanup();
      }
    });

    it("executes read_file after write_file with monotonic action sequence numbers", async () => {
      const fixture = setupTestFixture();

      try {
        const wsHandle = await fixture.workspacePort.provisionWorkspace({
          workspaceId: "ws-multi-act",
          runId: fixture.run.runId,
          taskId: fixture.task.taskId,
          maxWorkspaceBytes: 50 * 1024 * 1024,
          maxFileSizeBytes: 10 * 1024 * 1024,
        });

        // Action 1: write_file
        const act1 = await fixture.workerRuntime.executeAction({
          runId: fixture.run.runId,
          toolName: "write_file",
          inputPayload: { path: "data.txt", content: "Line 1\nLine 2\nLine 3" },
          workspace: wsHandle,
        });
        expect(act1.status).toBe("SUCCEEDED");

        // Action 2: read_file
        const act2 = await fixture.workerRuntime.executeAction({
          runId: fixture.run.runId,
          toolName: "read_file",
          inputPayload: { path: "data.txt", offsetLine: 1, limitLines: 10 },
          workspace: wsHandle,
        });
        expect(act2.status).toBe("SUCCEEDED");

        const action1Snapshot = fixture.store.getAction(act1.actionId);
        const action2Snapshot = fixture.store.getAction(act2.actionId);

        expect(action1Snapshot?.sequenceNumber).toBe(1);
        expect(action2Snapshot?.sequenceNumber).toBe(2);

        expect(act2.output).toEqual(
          expect.objectContaining({
            content: "Line 1\nLine 2\nLine 3",
            totalLines: 3,
            isTruncated: false,
          })
        );
      } finally {
        fixture.cleanup();
      }
    });

    it("executes run_command through CountingExecutionProvider returning command output", async () => {
      const fixture = setupTestFixture();

      try {
        const wsHandle = await fixture.workspacePort.provisionWorkspace({
          workspaceId: "ws-cmd-1",
          runId: fixture.run.runId,
          taskId: fixture.task.taskId,
          maxWorkspaceBytes: 50 * 1024 * 1024,
          maxFileSizeBytes: 10 * 1024 * 1024,
        });

        fixture.provider.nextResult = {
          status: "SUCCESS",
          output: {
            exitCode: 0,
            stdout: "Build succeeded\n",
            stderr: "",
            durationMs: 42,
            outputTruncated: false,
          },
          durationMs: 42,
        };

        const result = await fixture.workerRuntime.executeAction({
          runId: fixture.run.runId,
          toolName: "run_command",
          inputPayload: { argv: ["npm", "run", "build"], cwd: "." },
          workspace: wsHandle,
        });

        expect(result.status).toBe("SUCCEEDED");
        expect(fixture.provider.calls).toBe(1);

        const attempt = fixture.store.getAttemptsForAction(result.actionId)[0]!;
        expect(attempt.status).toBe("SUCCEEDED");
        expect(attempt.exitCode).toBe(0);
        expect(attempt.outputPayload).toEqual(
          expect.objectContaining({
            stdout: "Build succeeded\n",
          })
        );
      } finally {
        fixture.cleanup();
      }
    });
  });

  // =========================================================================
  // 2. Deterministic Tool Failure Propagation
  // =========================================================================
  describe("2. Deterministic Tool Failure", () => {
    it("propagates tool execution failure to Attempt FAILED and Action FAILED with no retry", async () => {
      const fixture = setupTestFixture();

      try {
        const wsHandle = await fixture.workspacePort.provisionWorkspace({
          workspaceId: "ws-fail-1",
          runId: fixture.run.runId,
          taskId: fixture.task.taskId,
          maxWorkspaceBytes: 50 * 1024 * 1024,
          maxFileSizeBytes: 10 * 1024 * 1024,
        });

        // Reading a non-existent file causes adapter failure
        const result = await fixture.workerRuntime.executeAction({
          runId: fixture.run.runId,
          toolName: "read_file",
          inputPayload: { path: "does-not-exist.txt" },
          workspace: wsHandle,
        });

        expect(result.status).toBe("FAILED");
        expect(result.error).toBeDefined();

        // 1. Attempt failed
        const attempts = fixture.store.getAttemptsForAction(result.actionId);
        expect(attempts.length).toBe(1); // EXACTLY ONE ATTEMPT - NO RETRY
        expect(attempts[0]!.status).toBe("FAILED");
        expect(attempts[0]!.errorPayload).toBeDefined();

        // 2. Action failed
        const action = fixture.store.getAction(result.actionId);
        expect(action?.status).toBe("FAILED");
        expect(action?.totalAttempts).toBe(1);
        expect(action?.activeAttemptNumber).toBeNull();
        expect(action?.errorPayload).toBeDefined();

        // 3. Events
        const events = fixture.store.getEventsForRun(fixture.run.runId);
        const eventTypes = events
          .filter((e) => e.eventType.startsWith("action.") || e.eventType.startsWith("attempt."))
          .map((e) => e.eventType);

        expect(eventTypes).toEqual([
          "action.created",
          "action.authorized",
          "action.started",
          "attempt.created",
          "attempt.dispatched",
          "attempt.started",
          "attempt.failed",
          "action.failed",
        ]);
      } finally {
        fixture.cleanup();
      }
    });
  });

  // =========================================================================
  // 3. Timeout Propagation
  // =========================================================================
  describe("3. Timeout Propagation", () => {
    it("marks Attempt TIMED_OUT and Action TIMED_OUT with zero automated retries", async () => {
      const fixture = setupTestFixture();

      try {
        const wsHandle = await fixture.workspacePort.provisionWorkspace({
          workspaceId: "ws-timeout-1",
          runId: fixture.run.runId,
          taskId: fixture.task.taskId,
          maxWorkspaceBytes: 50 * 1024 * 1024,
          maxFileSizeBytes: 10 * 1024 * 1024,
        });

        fixture.provider.nextResult = {
          status: "TIMED_OUT",
          error: {
            code: "EXECUTION_TIMEOUT",
            message: "Process timed out after 5000ms",
          },
          durationMs: 5000,
        };

        const result = await fixture.workerRuntime.executeAction({
          runId: fixture.run.runId,
          toolName: "run_command",
          inputPayload: { argv: ["sleep", "10"], cwd: ".", timeoutMs: 5000 },
          workspace: wsHandle,
        });

        expect(result.status).toBe("TIMED_OUT");

        // Exactly one attempt
        const attempts = fixture.store.getAttemptsForAction(result.actionId);
        expect(attempts.length).toBe(1);
        expect(attempts[0]!.status).toBe("TIMED_OUT");
        expect(attempts[0]!.errorPayload).toEqual(
          expect.objectContaining({ code: "TOOL_TIMEOUT" })
        );

        // Action timed out
        const action = fixture.store.getAction(result.actionId);
        expect(action?.status).toBe("TIMED_OUT");
        expect(action?.totalAttempts).toBe(1);

        // Events
        const events = fixture.store.getEventsForRun(fixture.run.runId);
        const eventTypes = events
          .filter((e) => e.eventType.startsWith("action.") || e.eventType.startsWith("attempt."))
          .map((e) => e.eventType);

        expect(eventTypes).toContain("attempt.timed_out");
        expect(eventTypes).toContain("action.timed_out");
        expect(eventTypes).not.toContain("action.retrying");
      } finally {
        fixture.cleanup();
      }
    });
  });

  // =========================================================================
  // 4. Cancellation Propagation
  // =========================================================================
  describe("4. Cancellation Propagation", () => {
    it("marks Attempt CANCELLED and Action CANCELLED when AbortSignal fires", async () => {
      const fixture = setupTestFixture();

      try {
        const wsHandle = await fixture.workspacePort.provisionWorkspace({
          workspaceId: "ws-cancel-1",
          runId: fixture.run.runId,
          taskId: fixture.task.taskId,
          maxWorkspaceBytes: 50 * 1024 * 1024,
          maxFileSizeBytes: 10 * 1024 * 1024,
        });

        const abortController = new AbortController();
        abortController.abort(new Error("User cancelled"));

        const result = await fixture.workerRuntime.executeAction({
          runId: fixture.run.runId,
          toolName: "read_file",
          inputPayload: { path: "data.txt" },
          workspace: wsHandle,
          abortSignal: abortController.signal,
        });

        expect(result.status).toBe("CANCELLED");

        const attempts = fixture.store.getAttemptsForAction(result.actionId);
        expect(attempts.length).toBe(1);
        expect(attempts[0]!.status).toBe("CANCELLED");

        const action = fixture.store.getAction(result.actionId);
        expect(action?.status).toBe("CANCELLED");

        const events = fixture.store.getEventsForRun(fixture.run.runId);
        const eventTypes = events
          .filter((e) => e.eventType.startsWith("action.") || e.eventType.startsWith("attempt."))
          .map((e) => e.eventType);

        expect(eventTypes).toContain("attempt.cancelled");
        expect(eventTypes).toContain("action.cancelled");
      } finally {
        fixture.cleanup();
      }
    });
  });

  // =========================================================================
  // 5. Governance Denial (Zero Provider Invocations)
  // =========================================================================
  describe("5. Governance Denial", () => {
    it("denies unauthorized tool capability with provider calls === 0 and Action FAILED", async () => {
      // Create policy that only allows read_file
      const restrictedPolicy = createExecutionPolicy({
        policyId: "policy-restricted",
        allowedCapabilities: ["workspace.file.read"],
        isolationRequirement: "ISOLATED",
      });

      const fixture = setupTestFixture({ policy: restrictedPolicy });

      try {
        const wsHandle = await fixture.workspacePort.provisionWorkspace({
          workspaceId: "ws-denied-1",
          runId: fixture.run.runId,
          taskId: fixture.task.taskId,
          maxWorkspaceBytes: 50 * 1024 * 1024,
          maxFileSizeBytes: 10 * 1024 * 1024,
        });

        // Attempt write_file (workspace.file.write is NOT allowed)
        const result = await fixture.workerRuntime.executeAction({
          runId: fixture.run.runId,
          toolName: "write_file",
          inputPayload: { path: "unauthorized.txt", content: "illegal" },
          workspace: wsHandle,
        });

        // 1. Result is FAILED
        expect(result.status).toBe("FAILED");
        expect((result.error as any)?.code).toBe("CAPABILITY_DENIED");

        // 2. ZERO PROVIDER CALLS
        expect(fixture.provider.calls).toBe(0);

        // 3. ZERO ATTEMPTS CREATED
        const attempts = fixture.store.getAttemptsForAction(result.actionId);
        expect(attempts.length).toBe(0);

        // 4. Action failed from CREATED state
        const action = fixture.store.getAction(result.actionId);
        expect(action?.status).toBe("FAILED");
        expect(action?.totalAttempts).toBe(0);

        // 5. Events: action.created -> action.failed
        const events = fixture.store.getEventsForRun(fixture.run.runId);
        const eventTypes = events
          .filter((e) => e.eventType.startsWith("action.") || e.eventType.startsWith("attempt."))
          .map((e) => e.eventType);

        expect(eventTypes).toEqual(["action.created", "action.failed"]);
      } finally {
        fixture.cleanup();
      }
    });
  });

  // =========================================================================
  // 6. Contract Revocation (Zero Provider Invocations)
  // =========================================================================
  describe("6. Contract Revocation", () => {
    it("refuses execution when bound contract is REVOKED with provider calls === 0", async () => {
      const fixture = setupTestFixture();

      try {
        const wsHandle = await fixture.workspacePort.provisionWorkspace({
          workspaceId: "ws-revoked-1",
          runId: fixture.run.runId,
          taskId: fixture.task.taskId,
          maxWorkspaceBytes: 50 * 1024 * 1024,
          maxFileSizeBytes: 10 * 1024 * 1024,
        });

        // Revoke the contract
        fixture.store.revokeContract(
          fixture.contract.spec.contractId,
          fixture.contract.spec.version,
          "Compromised credential"
        );

        const result = await fixture.workerRuntime.executeAction({
          runId: fixture.run.runId,
          toolName: "read_file",
          inputPayload: { path: "test.txt" },
          workspace: wsHandle,
        });

        expect(result.status).toBe("FAILED");
        expect((result.error as any)?.message).toContain("REVOKED");

        // ZERO provider calls
        expect(fixture.provider.calls).toBe(0);

        // ZERO attempts created
        const attempts = fixture.store.getAttemptsForAction(result.actionId);
        expect(attempts.length).toBe(0);

        // Action failed
        const action = fixture.store.getAction(result.actionId);
        expect(action?.status).toBe("FAILED");
        expect(action?.totalAttempts).toBe(0);

        // Events
        const events = fixture.store.getEventsForRun(fixture.run.runId);
        const eventTypes = events
          .filter((e) => e.eventType.startsWith("action.") || e.eventType.startsWith("attempt."))
          .map((e) => e.eventType);

        expect(eventTypes).toEqual(["action.created", "action.failed"]);
      } finally {
        fixture.cleanup();
      }
    });
  });

  // =========================================================================
  // 7. Resource Ceiling Violation (Zero Provider Invocations)
  // =========================================================================
  describe("7. Resource Ceiling Enforcement", () => {
    it("rejects request when requested resource exceeds contract ceiling with provider calls === 0", async () => {
      // Contract ceiling: timeoutMs = 5000
      const fixture = setupTestFixture({ timeoutMs: 5000 });

      try {
        const wsHandle = await fixture.workspacePort.provisionWorkspace({
          workspaceId: "ws-ceiling-1",
          runId: fixture.run.runId,
          taskId: fixture.task.taskId,
          maxWorkspaceBytes: 50 * 1024 * 1024,
          maxFileSizeBytes: 10 * 1024 * 1024,
        });

        // Request timeoutMs = 8000 (> 5000 ceiling)
        const result = await fixture.workerRuntime.executeAction({
          runId: fixture.run.runId,
          toolName: "run_command",
          inputPayload: { argv: ["echo", "test"], cwd: ".", timeoutMs: 8000 },
          workspace: wsHandle,
        });

        expect(result.status).toBe("FAILED");
        expect((result.error as any)?.code).toBe("TOOL_TIMEOUT");

        // ZERO provider calls
        expect(fixture.provider.calls).toBe(0);

        // ZERO attempts
        const attempts = fixture.store.getAttemptsForAction(result.actionId);
        expect(attempts.length).toBe(0);

        // Action failed
        const action = fixture.store.getAction(result.actionId);
        expect(action?.status).toBe("FAILED");
        expect(action?.totalAttempts).toBe(0);
      } finally {
        fixture.cleanup();
      }
    });

    it("throws ResourceLimitExceededError when maxAttempts exceeds contract ceiling", async () => {
      // Contract ceiling: maxAttempts = 2
      const fixture = setupTestFixture({ maxAttempts: 2 });

      try {
        await expect(
          fixture.workerRuntime.executeAction({
            runId: fixture.run.runId,
            toolName: "read_file",
            inputPayload: { path: "test.txt" },
            maxAttempts: 5, // > 2
          })
        ).rejects.toThrow(ResourceLimitExceededError);

        expect(fixture.provider.calls).toBe(0);
      } finally {
        fixture.cleanup();
      }
    });
  });

  // =========================================================================
  // 8. Stale Lease Fencing
  // =========================================================================
  describe("8. Stale Worker Lease Fencing", () => {
    it("rejects mutation with LeaseLostError when worker lease was stolen", async () => {
      const fixture = setupTestFixture();

      try {
        const wsHandle = await fixture.workspacePort.provisionWorkspace({
          workspaceId: "ws-fenced-1",
          runId: fixture.run.runId,
          taskId: fixture.task.taskId,
          maxWorkspaceBytes: 50 * 1024 * 1024,
          maxFileSizeBytes: 10 * 1024 * 1024,
        });

        // Register Worker B
        fixture.store.transaction((tx) => {
          tx.insertWorker({
            workerId: "worker-usurper",
            hostname: "localhost",
            pid: 9999,
            status: "ACTIVE",
            createdAt: fixture.clock.nowIso(),
            lastHeartbeatAt: fixture.clock.nowIso(),
          });
        });

        // Simulate lease theft: expire old lease and steal run by Worker B
        fixture.clock.advanceMs(20000);
        const currentRun = fixture.store.getRun(fixture.run.runId)!;
        const runRecovered = Run.reconstitute(currentRun);
        const expireEvent = runRecovered.expireLease();
        fixture.store.transaction((tx) => {
          tx.updateRun(runRecovered.runId, currentRun.version, runRecovered.snapshot, expireEvent);
          tx.updateLeaseState(fixture.lease.leaseId, "EXPIRED");
        });

        const claimB = runRecovered.claim("worker-usurper", "lease-usurper-new", fixture.clock.nowIso());
        fixture.store.transaction((tx) => {
          tx.updateRun(runRecovered.runId, currentRun.version + 1, runRecovered.snapshot, claimB);
          tx.insertLease({
            leaseId: "lease-usurper-new",
            runId: fixture.run.runId,
            workerId: "worker-usurper",
            acquiredAt: fixture.clock.nowIso(),
            expiresAt: fixture.clock.nowIso(),
            releasedAt: null,
            state: "ACTIVE",
          });
        });

        // Worker A attempts to execute action
        await expect(
          fixture.workerRuntime.executeAction({
            runId: fixture.run.runId,
            toolName: "read_file",
            inputPayload: { path: "test.txt" },
            workspace: wsHandle,
          })
        ).rejects.toThrow(LeaseLostError);

        // Verify no actions were created for this run
        const actions = fixture.store.getActionsForRun(fixture.run.runId);
        expect(actions.length).toBe(0);
      } finally {
        fixture.cleanup();
      }
    });
  });

  // =========================================================================
  // 9. Execution Uncertainty (UNKNOWN) Semantics
  // =========================================================================
  describe("9. Execution Uncertainty (UNKNOWN) Semantics", () => {
    it("preserves Attempt UNKNOWN status without translating to FAILED", async () => {
      const fixture = setupTestFixture();

      try {
        const wsHandle = await fixture.workspacePort.provisionWorkspace({
          workspaceId: "ws-unk-1",
          runId: fixture.run.runId,
          taskId: fixture.task.taskId,
          maxWorkspaceBytes: 50 * 1024 * 1024,
          maxFileSizeBytes: 10 * 1024 * 1024,
        });

        fixture.provider.nextResult = {
          status: "FAILED",
          error: {
            code: "PROVIDER_RESULT_UNAVAILABLE" as unknown as ExecutionErrorCode,
            message: "Docker daemon connection severed unexpectedly mid-execution",
          },
          durationMs: 120,
        };

        const result = await fixture.workerRuntime.executeAction({
          runId: fixture.run.runId,
          toolName: "run_command",
          inputPayload: { argv: ["echo", "test"], cwd: "." },
          workspace: wsHandle,
        });

        expect(result.status).toBe("UNKNOWN");

        // Attempt is UNKNOWN (NOT FAILED)
        const attempt = fixture.store.getAttemptsForAction(result.actionId)[0]!;
        expect(attempt.status).toBe("UNKNOWN");
        expect(attempt.errorPayload).toEqual(
          expect.objectContaining({
            code: "EXECUTION_UNCERTAIN",
            reasonCode: "PROVIDER_RESULT_UNAVAILABLE",
          })
        );

        // Action is FAILED (terminal outcome of uncertain trial)
        const action = fixture.store.getAction(result.actionId);
        expect(action?.status).toBe("FAILED");

        // Event transcript carries attempt.unknown
        const events = fixture.store.getEventsForRun(fixture.run.runId);
        const eventTypes = events
          .filter((e) => e.eventType.startsWith("action.") || e.eventType.startsWith("attempt."))
          .map((e) => e.eventType);

        expect(eventTypes).toContain("attempt.unknown");
        expect(eventTypes).toContain("action.failed");
      } finally {
        fixture.cleanup();
      }
    });
  });

  // =========================================================================
  // 10. Persistence & Reopen
  // =========================================================================
  describe("10. Persistence & Database Reopen", () => {
    it("persists Action and Attempt state across database close and reopen", async () => {
      const dbFile = path.join(os.tmpdir(), `emerald-db-persist-${Date.now()}.db`);
      const fixture = setupTestFixture({ dbPath: dbFile });

      let actionId: string;
      let attemptId: string;

      try {
        const wsHandle = await fixture.workspacePort.provisionWorkspace({
          workspaceId: "ws-persist-1",
          runId: fixture.run.runId,
          taskId: fixture.task.taskId,
          maxWorkspaceBytes: 50 * 1024 * 1024,
          maxFileSizeBytes: 10 * 1024 * 1024,
        });

        const result = await fixture.workerRuntime.executeAction({
          runId: fixture.run.runId,
          toolName: "write_file",
          inputPayload: { path: "persist.txt", content: "Durable state" },
          workspace: wsHandle,
        });

        expect(result.status).toBe("SUCCEEDED");
        actionId = result.actionId;
        attemptId = result.attemptId!;

        // Close store
        fixture.store.close();

        // Reopen with fresh store
        const reopenedStore = new SqliteStateStore({ location: dbFile });

        const reloadedAction = reopenedStore.getAction(actionId);
        expect(reloadedAction).not.toBeNull();
        expect(reloadedAction?.status).toBe("SUCCEEDED");
        expect(reloadedAction?.totalAttempts).toBe(1);

        const reloadedAttempts = reopenedStore.getAttemptsForAction(actionId);
        expect(reloadedAttempts.length).toBe(1);
        expect(reloadedAttempts[0]?.attemptId).toBe(attemptId);
        expect(reloadedAttempts[0]?.status).toBe("SUCCEEDED");

        const reloadedEvents = reopenedStore.getEventsForRun(fixture.run.runId);
        expect(reloadedEvents.length).toBeGreaterThanOrEqual(8);

        reopenedStore.close();
      } finally {
        fixture.cleanup();
        try {
          fs.rmSync(dbFile, { force: true });
        } catch {}
      }
    });
  });

  // =========================================================================
  // 11. Pre-Created Action Execution
  // =========================================================================
  describe("11. Pre-Created Action Execution", () => {
    it("executes an Action previously created in SQLite without duplicating action.created", async () => {
      const fixture = setupTestFixture();

      try {
        const wsHandle = await fixture.workspacePort.provisionWorkspace({
          workspaceId: "ws-precreated-1",
          runId: fixture.run.runId,
          taskId: fixture.task.taskId,
          maxWorkspaceBytes: 50 * 1024 * 1024,
          maxFileSizeBytes: 10 * 1024 * 1024,
        });

        // 1. Pre-create Action in store
        const actionId = "act-precreated-001";
        const { action, event: createdEvent } = Action.create({
          actionId,
          runId: fixture.run.runId,
          sequenceNumber: 1,
          toolName: "write_file",
          inputPayload: { path: "pre.txt", content: "Pre-created content" },
          contractBinding: fixture.run.contractBinding!,
          maxAttempts: 3,
          now: fixture.clock.nowIso(),
        });

        fixture.store.transaction((tx) => {
          tx.insertAction(action.snapshot, createdEvent, {
            workerId: fixture.workerId,
            leaseId: fixture.lease.leaseId,
          });
        });

        // 2. Pass actionId to workerRuntime.executeAction
        const result = await fixture.workerRuntime.executeAction({
          runId: fixture.run.runId,
          actionId,
          workspace: wsHandle,
        });

        expect(result.status).toBe("SUCCEEDED");
        expect(result.actionId).toBe(actionId);

        // 3. Exactly ONE action.created event
        const events = fixture.store.getEventsForRun(fixture.run.runId);
        const createdEvents = events.filter((e) => e.eventType === "action.created");
        expect(createdEvents.length).toBe(1);

        // 4. File exists on disk
        const resolvedPath = await fixture.workspacePort.resolvePath("ws-precreated-1", "pre.txt");
        expect(fs.readFileSync(resolvedPath, "utf8")).toBe("Pre-created content");
      } finally {
        fixture.cleanup();
      }
    });
  });

  // =========================================================================
  // 12. Terminal State Immutability
  // =========================================================================
  describe("12. Terminal State Immutability", () => {
    it("throws TerminalStateError when attempting to re-execute an already completed Action", async () => {
      const fixture = setupTestFixture();

      try {
        const wsHandle = await fixture.workspacePort.provisionWorkspace({
          workspaceId: "ws-term-1",
          runId: fixture.run.runId,
          taskId: fixture.task.taskId,
          maxWorkspaceBytes: 50 * 1024 * 1024,
          maxFileSizeBytes: 10 * 1024 * 1024,
        });

        const result = await fixture.workerRuntime.executeAction({
          runId: fixture.run.runId,
          toolName: "write_file",
          inputPayload: { path: "terminal.txt", content: "Initial" },
          workspace: wsHandle,
        });
        expect(result.status).toBe("SUCCEEDED");

        // Attempting to re-execute the same completed actionId
        await expect(
          fixture.workerRuntime.executeAction({
            runId: fixture.run.runId,
            actionId: result.actionId,
            workspace: wsHandle,
          })
        ).rejects.toThrow(TerminalStateError);
      } finally {
        fixture.cleanup();
      }
    });
  });
});
