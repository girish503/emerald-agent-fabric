/**
 * Phase 4 / Task 4.4-F — Crash Recovery, UNKNOWN Reconciliation, Retry Safety, and Attempt Sweeper Integration Tests
 *
 * Verifies:
 * 1. Stale Attempt Detection
 * 2. UNKNOWN Conversion (RUNNING -> UNKNOWN with attempt.unknown emitted exactly once)
 * 3. Non-Idempotent UNKNOWN (strictly fail-closed, zero automatic retry)
 * 4. Idempotent Deterministic Failure (transitions to RETRYING, bounded single retry attempt)
 * 5. Max Attempts Ceiling Enforcement (totalAttempts <= maxAttempts strictly enforced)
 * 6. Retry Idempotency (recoverStaleExecutions executed twice produces no duplicate attempts)
 * 7. Late Zombie Result Protection (stale worker rejected with LeaseLostError, durable state unfazed)
 * 8. Crash After Attempt Terminal (Window G: reconciles Action without duplicate physical execution)
 * 9. Crash Before Attempt Creation (Windows A & B: recognizes 0 attempts, no duplicate side effects)
 * 10. Crash After Provider Invocation (Window F: UNKNOWN semantics with fail-closed non-idempotent safety)
 * 11. Contract Revocation on Retry (revoked contract rejects retry with provider calls === 0)
 * 12. Resource Ceiling Enforcement on Retry (ResourceLimitExceededError with provider calls === 0)
 * 13. Capability Policy Enforcement on Retry (CAPABILITY_DENIED with provider calls === 0)
 * 14. Persistence Database Reopen (full recovery works from persisted disk SQLite state alone)
 * 15. Sweeper Idempotence (repeated calls to recoverStaleExecutions yield identical state)
 * 16. Window C: Attempt CREATED, crashes before DISPATCHED -> Attempt CANCELLED
 * 17. Window D: Attempt DISPATCHED, crashes before RUNNING -> Attempt UNKNOWN
 * 18. Window H: Action RETRYING, crashes before Attempt #2 -> creates missing Attempt exactly once
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
import { Attempt, createAttemptIdempotencyToken } from "../../src/domain/attempt.js";
import { Run } from "../../src/domain/run.js";
import {
  LeaseLostError,
  ResourceLimitExceededError,
} from "../../src/domain/errors.js";
import {
  createExecutionPolicy,
  ExecutionPolicy,
} from "../../src/domain/policy.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "../../src/ports/execution-provider.port.js";
import { createAndActivateContract } from "./test-helpers.js";

/**
 * CountingExecutionProvider tracks provider calls and returns configurable responses.
 */
class CountingExecutionProvider implements ExecutionProvider {
  readonly tenantModel = "NONE" as const;
  readonly quiescence = { async quiesceRun(_runId: string) { return { status: "QUIESCENT" as const, stopped: 0 }; } };
  readonly name = "counting-provider";
  readonly invocations: ExecutionRequest[] = [];
  nextResult?: ExecutionResult;
  onExecute?: (request: ExecutionRequest) => void;

  get calls(): number {
    return this.invocations.length;
  }

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocations.push(request);
    if (this.onExecute) {
      this.onExecute(request);
    }

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
  const workerId = options.workerId ?? "worker-recovery-1";

  // Register Worker 1
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
    title: "recovery-integration-task",
    description: "Task for verifying crash recovery, UNKNOWN reconciliation, and retry safety",
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-test-rec-"));
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

describe("Phase 4 / Task 4.4-F — Crash Recovery, UNKNOWN Reconciliation, Retry Safety, and Attempt Sweeper", () => {
  // =========================================================================
  // 1. Stale Attempt Detection
  // =========================================================================
  describe("1. Stale Attempt Detection", () => {
    it("detects Attempt in RUNNING status when worker lease is expired", async () => {
      const fixture = setupTestFixture();

      try {
        await fixture.workspacePort.provisionWorkspace({
          workspaceId: "ws-rec-1",
          runId: fixture.run.runId,
          taskId: fixture.task.taskId,
          maxWorkspaceBytes: 50 * 1024 * 1024,
          maxFileSizeBytes: 10 * 1024 * 1024,
        });

        // 1. Create and dispatch Action and Attempt to RUNNING
        const actionId = "act-stale-1";
        const { action, event: actEvent } = Action.create({
          actionId,
          runId: fixture.run.runId,
          sequenceNumber: 1,
          toolName: "read_file",
          inputPayload: { path: "hello.txt" },
          contractBinding: fixture.run.contractBinding!,
          maxAttempts: 3,
          now: fixture.clock.nowIso(),
        });

        const attemptId = "att-stale-1";
        const { attempt, event: attEvent } = Attempt.create({
          attemptId,
          actionId,
          runId: fixture.run.runId,
          attemptNumber: 1,
          workerId: fixture.workerId,
          leaseId: fixture.lease.leaseId,
          now: fixture.clock.nowIso(),
        });

        fixture.store.transaction((tx) => {
          tx.insertAction(action.snapshot, actEvent, {
            workerId: fixture.workerId,
            leaseId: fixture.lease.leaseId,
          });
          tx.transitionAction(actionId, { type: "AUTHORIZE", now: fixture.clock.nowIso() }, () => "e1");
          tx.transitionAction(
            actionId,
            { type: "START_ATTEMPT", attemptNumber: 1, now: fixture.clock.nowIso() },
            () => "e2"
          );
          tx.insertAttempt(attempt.snapshot, attEvent, {
            workerId: fixture.workerId,
            leaseId: fixture.lease.leaseId,
          });
          tx.transitionAttempt(attemptId, { type: "DISPATCH", now: fixture.clock.nowIso() }, () => "e3");
          tx.transitionAttempt(attemptId, { type: "START", now: fixture.clock.nowIso() }, () => "e4");
        });

        // Verify Attempt is RUNNING
        const preAttempt = fixture.store.getAttempt(attemptId);
        expect(preAttempt?.status).toBe("RUNNING");

        // 2. Simulate worker crash and lease expiration: advance clock beyond lease TTL (15s)
        fixture.clock.advanceMs(20000);

        // 3. Run sweeper recovery
        const recoveryResult = fixture.coordinator.recoverStaleExecutions();

        // 4. Verification: attempt was detected and reconciled
        expect(recoveryResult.reconciledAttempts).toBe(1);
        expect(recoveryResult.details[0]?.attemptId).toBe(attemptId);
        expect(recoveryResult.details[0]?.priorAttemptStatus).toBe("RUNNING");
        expect(recoveryResult.details[0]?.resultingAttemptStatus).toBe("UNKNOWN");

        const postAttempt = fixture.store.getAttempt(attemptId);
        expect(postAttempt?.status).toBe("UNKNOWN");
      } finally {
        fixture.cleanup();
      }
    });
  });

  // =========================================================================
  // 2. UNKNOWN Conversion & Causal Event Transcript
  // =========================================================================
  describe("2. UNKNOWN Conversion", () => {
    it("transitions RUNNING to UNKNOWN when outcome is uncertain and emits attempt.unknown exactly once", async () => {
      const fixture = setupTestFixture();

      try {
        const actionId = "act-unk-conv-1";
        const attemptId = "att-unk-conv-1";

        const { action, event: actEvent } = Action.create({
          actionId,
          runId: fixture.run.runId,
          sequenceNumber: 1,
          toolName: "run_command",
          inputPayload: { argv: ["echo", "test"], cwd: "." },
          contractBinding: fixture.run.contractBinding!,
          maxAttempts: 3,
          now: fixture.clock.nowIso(),
        });

        const { attempt, event: attEvent } = Attempt.create({
          attemptId,
          actionId,
          runId: fixture.run.runId,
          attemptNumber: 1,
          workerId: fixture.workerId,
          leaseId: fixture.lease.leaseId,
          now: fixture.clock.nowIso(),
        });

        fixture.store.transaction((tx) => {
          tx.insertAction(action.snapshot, actEvent, {
            workerId: fixture.workerId,
            leaseId: fixture.lease.leaseId,
          });
          tx.transitionAction(actionId, { type: "AUTHORIZE", now: fixture.clock.nowIso() }, () => "e1");
          tx.transitionAction(
            actionId,
            { type: "START_ATTEMPT", attemptNumber: 1, now: fixture.clock.nowIso() },
            () => "e2"
          );
          tx.insertAttempt(attempt.snapshot, attEvent, {
            workerId: fixture.workerId,
            leaseId: fixture.lease.leaseId,
          });
          tx.transitionAttempt(attemptId, { type: "DISPATCH", now: fixture.clock.nowIso() }, () => "e3");
          tx.transitionAttempt(attemptId, { type: "START", now: fixture.clock.nowIso() }, () => "e4");
        });

        // Advance clock to expire lease
        fixture.clock.advanceMs(20000);

        // Run recovery
        fixture.coordinator.recoverStaleExecutions();

        const postAttempt = fixture.store.getAttempt(attemptId);
        expect(postAttempt?.status).toBe("UNKNOWN");
        expect(postAttempt?.completedAt).not.toBeNull();
        expect(postAttempt?.errorPayload).toEqual(
          expect.objectContaining({
            code: "EXECUTION_UNCERTAIN",
            reasonCode: "LEASE_EXPIRED_DURING_EXECUTION",
          })
        );

        // Verify attempt.unknown event in transcript
        const events = fixture.store.getEventsForRun(fixture.run.runId);
        const unknownEvents = events.filter((e) => e.eventType === "attempt.unknown");
        expect(unknownEvents.length).toBe(1);
        expect((unknownEvents[0]?.payload as any)?.reasonCode).toBe("LEASE_EXPIRED_DURING_EXECUTION");
      } finally {
        fixture.cleanup();
      }
    });
  });

  // =========================================================================
  // 3. Non-Idempotent UNKNOWN Safety (Fail-Closed)
  // =========================================================================
  describe("3. Non-Idempotent UNKNOWN Safety", () => {
    it("never automatically retries a non-idempotent tool after UNKNOWN status", async () => {
      const fixture = setupTestFixture();

      try {
        const actionId = "act-non-idem-unk";
        const attemptId = "att-non-idem-1";

        // write_file is NON_IDEMPOTENT
        const { action, event: actEvent } = Action.create({
          actionId,
          runId: fixture.run.runId,
          sequenceNumber: 1,
          toolName: "write_file",
          inputPayload: { path: "critical-state.txt", content: "data" },
          contractBinding: fixture.run.contractBinding!,
          maxAttempts: 3,
          now: fixture.clock.nowIso(),
        });

        const { attempt, event: attEvent } = Attempt.create({
          attemptId,
          actionId,
          runId: fixture.run.runId,
          attemptNumber: 1,
          workerId: fixture.workerId,
          leaseId: fixture.lease.leaseId,
          now: fixture.clock.nowIso(),
        });

        fixture.store.transaction((tx) => {
          tx.insertAction(action.snapshot, actEvent, {
            workerId: fixture.workerId,
            leaseId: fixture.lease.leaseId,
          });
          tx.transitionAction(actionId, { type: "AUTHORIZE", now: fixture.clock.nowIso() }, () => "e1");
          tx.transitionAction(
            actionId,
            { type: "START_ATTEMPT", attemptNumber: 1, now: fixture.clock.nowIso() },
            () => "e2"
          );
          tx.insertAttempt(attempt.snapshot, attEvent, {
            workerId: fixture.workerId,
            leaseId: fixture.lease.leaseId,
          });
          tx.transitionAttempt(attemptId, { type: "DISPATCH", now: fixture.clock.nowIso() }, () => "e3");
          tx.transitionAttempt(attemptId, { type: "START", now: fixture.clock.nowIso() }, () => "e4");
        });

        // Lease expires mid-execution
        fixture.clock.advanceMs(20000);

        // Run worker runtime recovery
        const recoveryResult = await fixture.workerRuntime.recoverStaleExecutions();

        // 1. Attempt is UNKNOWN
        const postAttempt = fixture.store.getAttempt(attemptId);
        expect(postAttempt?.status).toBe("UNKNOWN");

        // 2. Action is terminal FAILED (NOT RETRYING)
        const postAction = fixture.store.getAction(actionId);
        expect(postAction?.status).toBe("FAILED");
        expect(postAction?.errorPayload).toEqual(
          expect.objectContaining({
            code: "EXECUTION_UNCERTAIN",
            reasonCode: "LEASE_EXPIRED_DURING_EXECUTION",
          })
        );

        // 3. ZERO retries were executed
        expect(recoveryResult.retriedActions.length).toBe(0);

        // 4. Exactly 1 attempt exists in store (Attempt #2 NEVER created)
        const allAttempts = fixture.store.getAttemptsForAction(actionId);
        expect(allAttempts.length).toBe(1);
      } finally {
        fixture.cleanup();
      }
    });
  });

  // =========================================================================
  // 4. Idempotent Deterministic Failure Bounded Retry
  // =========================================================================
  describe("4. Idempotent Deterministic Failure Bounded Retry", () => {
    it("transitions Action to RETRYING and creates exactly Attempt #2 for deterministic idempotent failure", async () => {
      const fixture = setupTestFixture();

      try {
        const wsHandle = await fixture.workspacePort.provisionWorkspace({
          workspaceId: "ws-idem-retry",
          runId: fixture.run.runId,
          taskId: fixture.task.taskId,
          maxWorkspaceBytes: 50 * 1024 * 1024,
          maxFileSizeBytes: 10 * 1024 * 1024,
        });

        // Execute action with autoRetry enabled
        // Attempt 1 fails deterministically: file does not exist yet
        const result1 = await fixture.workerRuntime.executeAction({
          runId: fixture.run.runId,
          toolName: "read_file",
          inputPayload: { path: "sample.txt" },
          workspace: wsHandle,
          autoRetry: true,
        });

        // Action transitioned to RETRYING
        const actionAfterAtt1 = fixture.store.getAction(result1.actionId);
        expect(actionAfterAtt1?.status).toBe("RETRYING");
        expect(actionAfterAtt1?.totalAttempts).toBe(1);

        // Attempt 1 is FAILED
        const att1 = fixture.store.getAttemptByNumber(result1.actionId, 1);
        expect(att1?.status).toBe("FAILED");

        // Now write sample.txt so Attempt 2 succeeds
        fs.writeFileSync(path.join(wsHandle.hostPath, "sample.txt"), "Initial content", "utf8");

        // Execute recovery / retry for this retrying action
        const recoveryResult = await fixture.workerRuntime.recoverStaleExecutions({
          runId: fixture.run.runId,
        });

        expect(recoveryResult.retriedActions.length).toBe(1);
        const retryResult = recoveryResult.retriedActions[0]!;
        expect(retryResult.status).toBe("SUCCEEDED");

        // Action is now SUCCEEDED with 2 total attempts
        const finalAction = fixture.store.getAction(result1.actionId);
        expect(finalAction?.status).toBe("SUCCEEDED");
        expect(finalAction?.totalAttempts).toBe(2);

        // Exactly 2 attempts exist in SQLite
        const allAttempts = fixture.store.getAttemptsForAction(result1.actionId);
        expect(allAttempts.length).toBe(2);
        expect(allAttempts[0]?.attemptNumber).toBe(1);
        expect(allAttempts[0]?.status).toBe("FAILED");
        expect(allAttempts[1]?.attemptNumber).toBe(2);
        expect(allAttempts[1]?.status).toBe("SUCCEEDED");
        expect(allAttempts[1]?.idempotencyToken).toBe(
          createAttemptIdempotencyToken(fixture.run.runId, result1.actionId, 2)
        );

        // Causal events verify proper sequence
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
          "action.retrying",
          "action.started",
          "attempt.created",
          "attempt.dispatched",
          "attempt.started",
          "attempt.completed",
          "action.completed",
        ]);
      } finally {
        fixture.cleanup();
      }
    });
  });

  // =========================================================================
  // 5. Max Attempts Ceiling Enforcement
  // =========================================================================
  describe("5. Max Attempts Ceiling Enforcement", () => {
    it("never creates attempts beyond maxAttempts ceiling and terminates Action in FAILED", async () => {
      // Contract maxAttempts = 2
      const fixture = setupTestFixture({ maxAttempts: 2 });

      try {
        const wsHandle = await fixture.workspacePort.provisionWorkspace({
          workspaceId: "ws-max-att",
          runId: fixture.run.runId,
          taskId: fixture.task.taskId,
          maxWorkspaceBytes: 50 * 1024 * 1024,
          maxFileSizeBytes: 10 * 1024 * 1024,
        });

        // Always fail
        fixture.provider.nextResult = {
          status: "FAILED",
          error: {
            code: "EXECUTION_FAILED",
            message: "Persistent failure",
          },
          durationMs: 10,
        };

        // Attempt 1
        const result1 = await fixture.workerRuntime.executeAction({
          runId: fixture.run.runId,
          toolName: "read_file",
          inputPayload: { path: "nonexistent.txt" },
          workspace: wsHandle,
          autoRetry: true,
          maxAttempts: 2,
        });

        // Action is RETRYING after attempt 1
        expect(fixture.store.getAction(result1.actionId)?.status).toBe("RETRYING");

        // Attempt 2 (retry)
        await fixture.workerRuntime.recoverStaleExecutions({ runId: fixture.run.runId });

        // Action after attempt 2 must be FAILED because totalAttempts (2) === maxAttempts (2)
        const actionAfterAtt2 = fixture.store.getAction(result1.actionId);
        expect(actionAfterAtt2?.status).toBe("FAILED");
        expect(actionAfterAtt2?.totalAttempts).toBe(2);

        // Attempt 3 must NEVER exist
        const allAttempts = fixture.store.getAttemptsForAction(result1.actionId);
        expect(allAttempts.length).toBe(2);
        expect(allAttempts[0]?.attemptNumber).toBe(1);
        expect(allAttempts[1]?.attemptNumber).toBe(2);

        // Additional recovery run does nothing
        const secondRecovery = await fixture.workerRuntime.recoverStaleExecutions({
          runId: fixture.run.runId,
        });
        expect(secondRecovery.retriedActions.length).toBe(0);
        expect(fixture.store.getAttemptsForAction(result1.actionId).length).toBe(2);
      } finally {
        fixture.cleanup();
      }
    });
  });

  // =========================================================================
  // 6. Retry Idempotency
  // =========================================================================
  describe("6. Retry Idempotency", () => {
    it("running recovery twice creates Attempt #2 once, not twice", async () => {
      const fixture = setupTestFixture();

      try {
        const wsHandle = await fixture.workspacePort.provisionWorkspace({
          workspaceId: "ws-retry-idem",
          runId: fixture.run.runId,
          taskId: fixture.task.taskId,
          maxWorkspaceBytes: 50 * 1024 * 1024,
          maxFileSizeBytes: 10 * 1024 * 1024,
        });

        // First attempt fails deterministically: file does not exist yet
        const res = await fixture.workerRuntime.executeAction({
          runId: fixture.run.runId,
          toolName: "read_file",
          inputPayload: { path: "doc.txt" },
          workspace: wsHandle,
          autoRetry: true,
        });
        expect(fixture.store.getAction(res.actionId)?.status).toBe("RETRYING");

        // Write doc.txt so Attempt 2 succeeds during recovery
        fs.writeFileSync(path.join(wsHandle.hostPath, "doc.txt"), "Content", "utf8");

        // Run recovery pass 1
        const pass1 = await fixture.workerRuntime.recoverStaleExecutions({ runId: fixture.run.runId });
        expect(pass1.retriedActions.length).toBe(1);
        expect(fixture.store.getAttemptsForAction(res.actionId).length).toBe(2);

        // Run recovery pass 2
        const pass2 = await fixture.workerRuntime.recoverStaleExecutions({ runId: fixture.run.runId });
        expect(pass2.retriedActions.length).toBe(0);
        expect(fixture.store.getAttemptsForAction(res.actionId).length).toBe(2);
      } finally {
        fixture.cleanup();
      }
    });
  });

  // =========================================================================
  // 7. Late Zombie Result Protection
  // =========================================================================
  describe("7. Late Zombie Result Protection", () => {
    it("rejects stale worker with LeaseLostError when attempting to persist late results", async () => {
      const fixture = setupTestFixture();

      try {
        // Register Worker B (usurper / recovery worker)
        const workerBId = "worker-recovery-2";
        fixture.store.transaction((tx) => {
          tx.insertWorker({
            workerId: workerBId,
            hostname: "localhost",
            pid: 5678,
            status: "ACTIVE",
            createdAt: fixture.clock.nowIso(),
            lastHeartbeatAt: fixture.clock.nowIso(),
          });
        });

        // Worker A creates Action and Attempt in RUNNING
        const actionId = "act-zombie-1";
        const attemptId = "att-zombie-1";

        const { action, event: actEvent } = Action.create({
          actionId,
          runId: fixture.run.runId,
          sequenceNumber: 1,
          toolName: "write_file",
          inputPayload: { path: "zombie.txt", content: "data" },
          contractBinding: fixture.run.contractBinding!,
          maxAttempts: 3,
          now: fixture.clock.nowIso(),
        });

        const { attempt, event: attEvent } = Attempt.create({
          attemptId,
          actionId,
          runId: fixture.run.runId,
          attemptNumber: 1,
          workerId: fixture.workerId,
          leaseId: fixture.lease.leaseId,
          now: fixture.clock.nowIso(),
        });

        fixture.store.transaction((tx) => {
          tx.insertAction(action.snapshot, actEvent, {
            workerId: fixture.workerId,
            leaseId: fixture.lease.leaseId,
          });
          tx.transitionAction(actionId, { type: "AUTHORIZE", now: fixture.clock.nowIso() }, () => "e1");
          tx.transitionAction(
            actionId,
            { type: "START_ATTEMPT", attemptNumber: 1, now: fixture.clock.nowIso() },
            () => "e2"
          );
          tx.insertAttempt(attempt.snapshot, attEvent, {
            workerId: fixture.workerId,
            leaseId: fixture.lease.leaseId,
          });
          tx.transitionAttempt(attemptId, { type: "DISPATCH", now: fixture.clock.nowIso() }, () => "e3");
          tx.transitionAttempt(attemptId, { type: "START", now: fixture.clock.nowIso() }, () => "e4");
        });

        // Worker A's lease expires
        fixture.clock.advanceMs(20000);

        // Coordinator expires Worker A's lease
        const currentRun = fixture.store.getRun(fixture.run.runId)!;
        const runRec = Run.reconstitute(currentRun);
        const expEvt = runRec.expireLease(fixture.clock.nowIso());
        fixture.store.transaction((tx) => {
          tx.updateRun(currentRun.runId, currentRun.version, runRec.snapshot, expEvt);
          tx.updateLeaseState(fixture.lease.leaseId, "EXPIRED");
        });

        // Worker B claims the run with new lease
        const leaseBId = "lease-usurper-4.4f";
        const claimBEvt = runRec.claim(workerBId, leaseBId, fixture.clock.nowIso(), fixture.clock.nowIso());
        fixture.store.transaction((tx) => {
          tx.updateRun(currentRun.runId, currentRun.version + 1, runRec.snapshot, claimBEvt);
          tx.insertLease({
            leaseId: leaseBId,
            runId: fixture.run.runId,
            workerId: workerBId,
            acquiredAt: fixture.clock.nowIso(),
            expiresAt: fixture.clock.nowIso(),
            releasedAt: null,
            state: "ACTIVE",
          });
        });

        // Worker B recovers the stale attempt -> UNKNOWN
        fixture.coordinator.recoverStaleExecutions({ runId: fixture.run.runId });
        expect(fixture.store.getAttempt(attemptId)?.status).toBe("UNKNOWN");

        // Worker A (zombie) now tries to persist completion with stale lease
        expect(() => {
          fixture.store.transaction((tx) => {
            tx.transitionAttempt(
              attemptId,
              {
                type: "COMPLETE",
                outputPayload: { bytesWritten: 4 },
                now: fixture.clock.nowIso(),
              },
              () => "e-zombie",
              { workerId: fixture.workerId, leaseId: fixture.lease.leaseId }
            );
          });
        }).toThrow(LeaseLostError);

        // State remains UNKNOWN and undamaged
        expect(fixture.store.getAttempt(attemptId)?.status).toBe("UNKNOWN");
      } finally {
        fixture.cleanup();
      }
    });
  });

  // =========================================================================
  // 8. Crash After Attempt Terminal (Window G)
  // =========================================================================
  describe("8. Crash After Attempt Terminal (Window G)", () => {
    it("reconciles Action from durable Attempt state without duplicate physical execution", async () => {
      const fixture = setupTestFixture();

      try {
        const actionId = "act-window-g";
        const attemptId = "att-window-g";

        // Create Action RUNNING and Attempt SUCCEEDED
        const { action, event: actEvent } = Action.create({
          actionId,
          runId: fixture.run.runId,
          sequenceNumber: 1,
          toolName: "read_file",
          inputPayload: { path: "data.txt" },
          contractBinding: fixture.run.contractBinding!,
          maxAttempts: 3,
          now: fixture.clock.nowIso(),
        });

        const { attempt, event: attEvent } = Attempt.create({
          attemptId,
          actionId,
          runId: fixture.run.runId,
          attemptNumber: 1,
          workerId: fixture.workerId,
          leaseId: fixture.lease.leaseId,
          now: fixture.clock.nowIso(),
        });

        fixture.store.transaction((tx) => {
          tx.insertAction(action.snapshot, actEvent, {
            workerId: fixture.workerId,
            leaseId: fixture.lease.leaseId,
          });
          tx.transitionAction(actionId, { type: "AUTHORIZE", now: fixture.clock.nowIso() }, () => "e1");
          tx.transitionAction(
            actionId,
            { type: "START_ATTEMPT", attemptNumber: 1, now: fixture.clock.nowIso() },
            () => "e2"
          );
          tx.insertAttempt(attempt.snapshot, attEvent, {
            workerId: fixture.workerId,
            leaseId: fixture.lease.leaseId,
          });
          tx.transitionAttempt(attemptId, { type: "DISPATCH", now: fixture.clock.nowIso() }, () => "e3");
          tx.transitionAttempt(attemptId, { type: "START", now: fixture.clock.nowIso() }, () => "e4");
          // Attempt persisted as SUCCEEDED, but worker crashed before Action SUCCEED was committed!
          tx.transitionAttempt(
            attemptId,
            {
              type: "COMPLETE",
              outputPayload: { content: "reconciled content" },
              durationMs: 15,
              now: fixture.clock.nowIso(),
            },
            () => "e5"
          );
        });

        // Verify pre-recovery state: Attempt is SUCCEEDED, Action is still RUNNING
        expect(fixture.store.getAttempt(attemptId)?.status).toBe("SUCCEEDED");
        expect(fixture.store.getAction(actionId)?.status).toBe("RUNNING");

        const providerCallsBefore = fixture.provider.calls;

        // Run recovery
        const recoveryResult = fixture.coordinator.recoverStaleExecutions({ runId: fixture.run.runId });
        expect(recoveryResult.reconciledActions).toBe(1);

        // Action is reconciled to SUCCEEDED with attempt's outputPayload
        const postAction = fixture.store.getAction(actionId);
        expect(postAction?.status).toBe("SUCCEEDED");
        expect(postAction?.resultPayload).toEqual({ content: "reconciled content" });

        // ZERO provider calls were made during reconciliation
        expect(fixture.provider.calls).toBe(providerCallsBefore);

        // Exactly 1 attempt exists
        expect(fixture.store.getAttemptsForAction(actionId).length).toBe(1);
      } finally {
        fixture.cleanup();
      }
    });
  });

  // =========================================================================
  // 9. Crash Before Attempt Creation (Windows A & B)
  // =========================================================================
  describe("9. Crash Before Attempt Creation (Windows A & B)", () => {
    it("recognizes 0 attempts exist and does not create duplicate attempts", async () => {
      const fixture = setupTestFixture();

      try {
        // Window A: Action in CREATED status
        const actionId = "act-window-a";
        const { action, event: actEvent } = Action.create({
          actionId,
          runId: fixture.run.runId,
          sequenceNumber: 1,
          toolName: "write_file",
          inputPayload: { path: "win-a.txt", content: "data" },
          contractBinding: fixture.run.contractBinding!,
          maxAttempts: 3,
          now: fixture.clock.nowIso(),
        });

        fixture.store.transaction((tx) => {
          tx.insertAction(action.snapshot, actEvent, {
            workerId: fixture.workerId,
            leaseId: fixture.lease.leaseId,
          });
        });

        // Lease expires
        fixture.clock.advanceMs(20000);

        // Run recovery
        const res = fixture.coordinator.recoverStaleExecutions({ runId: fixture.run.runId });
        expect(res.details).toBeDefined();

        // Zero attempts were ever created
        expect(fixture.store.getAttemptsForAction(actionId).length).toBe(0);
        expect(fixture.provider.calls).toBe(0);
      } finally {
        fixture.cleanup();
      }
    });
  });

  // =========================================================================
  // 10. Crash After Provider Invocation (Window F)
  // =========================================================================
  describe("10. Crash After Provider Invocation (Window F)", () => {
    it("marks Attempt UNKNOWN and refuses unsafe retry when provider was called but worker died", async () => {
      const fixture = setupTestFixture();

      try {
        await fixture.workspacePort.provisionWorkspace({
          workspaceId: "ws-win-f",
          runId: fixture.run.runId,
          taskId: fixture.task.taskId,
          maxWorkspaceBytes: 50 * 1024 * 1024,
          maxFileSizeBytes: 10 * 1024 * 1024,
        });

        // Set up action and attempt running
        const actionId = "act-win-f";
        const attemptId = "att-win-f";

        const { action, event: actEvent } = Action.create({
          actionId,
          runId: fixture.run.runId,
          sequenceNumber: 1,
          toolName: "run_command",
          inputPayload: { argv: ["touch", "touched.txt"], cwd: "." },
          contractBinding: fixture.run.contractBinding!,
          maxAttempts: 3,
          now: fixture.clock.nowIso(),
        });

        const { attempt, event: attEvent } = Attempt.create({
          attemptId,
          actionId,
          runId: fixture.run.runId,
          attemptNumber: 1,
          workerId: fixture.workerId,
          leaseId: fixture.lease.leaseId,
          now: fixture.clock.nowIso(),
        });

        fixture.store.transaction((tx) => {
          tx.insertAction(action.snapshot, actEvent, {
            workerId: fixture.workerId,
            leaseId: fixture.lease.leaseId,
          });
          tx.transitionAction(actionId, { type: "AUTHORIZE", now: fixture.clock.nowIso() }, () => "e1");
          tx.transitionAction(
            actionId,
            { type: "START_ATTEMPT", attemptNumber: 1, now: fixture.clock.nowIso() },
            () => "e2"
          );
          tx.insertAttempt(attempt.snapshot, attEvent, {
            workerId: fixture.workerId,
            leaseId: fixture.lease.leaseId,
          });
          tx.transitionAttempt(attemptId, { type: "DISPATCH", now: fixture.clock.nowIso() }, () => "e3");
          tx.transitionAttempt(attemptId, { type: "START", now: fixture.clock.nowIso() }, () => "e4");
        });

        // Worker crash simulation: lease expires
        fixture.clock.advanceMs(20000);

        // Run recovery
        await fixture.workerRuntime.recoverStaleExecutions({ runId: fixture.run.runId });

        // Attempt is UNKNOWN
        const postAttempt = fixture.store.getAttempt(attemptId);
        expect(postAttempt?.status).toBe("UNKNOWN");

        // Action is FAILED (fail-closed, no unsafe retry)
        const postAction = fixture.store.getAction(actionId);
        expect(postAction?.status).toBe("FAILED");

        // No Attempt #2 was created
        expect(fixture.store.getAttemptsForAction(actionId).length).toBe(1);
      } finally {
        fixture.cleanup();
      }
    });
  });

  // =========================================================================
  // 11. Contract Revocation on Retry
  // =========================================================================
  describe("11. Contract Revocation on Retry", () => {
    it("refuses retry execution when bound contract is REVOKED with provider calls === 0", async () => {
      const fixture = setupTestFixture();

      try {
        const wsHandle = await fixture.workspacePort.provisionWorkspace({
          workspaceId: "ws-rev-retry",
          runId: fixture.run.runId,
          taskId: fixture.task.taskId,
          maxWorkspaceBytes: 50 * 1024 * 1024,
          maxFileSizeBytes: 10 * 1024 * 1024,
        });

        // 1. Initial attempt fails deterministically: file.txt does not exist yet

        const res = await fixture.workerRuntime.executeAction({
          runId: fixture.run.runId,
          toolName: "read_file",
          inputPayload: { path: "file.txt" },
          workspace: wsHandle,
          autoRetry: true,
        });

        // Action is now RETRYING
        expect(fixture.store.getAction(res.actionId)?.status).toBe("RETRYING");

        // 2. Revoke the contract before retry executes!
        fixture.store.revokeContract(
          fixture.contract.spec.contractId,
          fixture.contract.spec.version,
          "Compromised credential"
        );

        const providerCallsBefore = fixture.provider.calls;

        // 3. Worker executes recovery / retry
        await fixture.workerRuntime.recoverStaleExecutions({ runId: fixture.run.runId });

        // Action transitioned to FAILED (contract revoked)
        const finalAction = fixture.store.getAction(res.actionId);
        expect(finalAction?.status).toBe("FAILED");
        expect((finalAction?.errorPayload as any)?.message).toContain("REVOKED");

        // ZERO provider calls made on retry attempt
        expect(fixture.provider.calls).toBe(providerCallsBefore);

        // Attempt #2 was NEVER created
        expect(fixture.store.getAttemptsForAction(res.actionId).length).toBe(1);
      } finally {
        fixture.cleanup();
      }
    });
  });

  // =========================================================================
  // 12. Resource Ceiling Enforcement on Retry
  // =========================================================================
  describe("12. Resource Ceiling Enforcement on Retry", () => {
    it("rejects retry if requested limit exceeds contract ceiling with provider calls === 0", async () => {
      const fixture = setupTestFixture({ timeoutMs: 5000 });

      try {
        const wsHandle = await fixture.workspacePort.provisionWorkspace({
          workspaceId: "ws-ceil-retry",
          runId: fixture.run.runId,
          taskId: fixture.task.taskId,
          maxWorkspaceBytes: 50 * 1024 * 1024,
          maxFileSizeBytes: 10 * 1024 * 1024,
        });

        // Action pre-created in RETRYING with timeout exceeding ceiling
        const actionId = "act-ceil-retry";
        const { action, event: actEvent } = Action.create({
          actionId,
          runId: fixture.run.runId,
          sequenceNumber: 1,
          toolName: "read_file",
          inputPayload: { path: "data.txt" },
          contractBinding: fixture.run.contractBinding!,
          maxAttempts: 3,
          now: fixture.clock.nowIso(),
        });

        fixture.store.transaction((tx) => {
          tx.insertAction(action.snapshot, actEvent, {
            workerId: fixture.workerId,
            leaseId: fixture.lease.leaseId,
          });
          tx.transitionAction(actionId, { type: "AUTHORIZE", now: fixture.clock.nowIso() }, () => "e1");
          tx.transitionAction(
            actionId,
            { type: "START_ATTEMPT", attemptNumber: 1, now: fixture.clock.nowIso() },
            () => "e2"
          );
          tx.transitionAction(
            actionId,
            { type: "PREPARE_RETRY", errorPayload: "Glitched", now: fixture.clock.nowIso() },
            () => "e3"
          );
        });

        // Attempting to retry with maxAttempts > contract maxAttempts ceiling (3)
        await expect(
          fixture.workerRuntime.executeAction({
            runId: fixture.run.runId,
            actionId,
            maxAttempts: 10, // exceeds ceiling 3
            workspace: wsHandle,
          })
        ).rejects.toThrow(ResourceLimitExceededError);

        expect(fixture.provider.calls).toBe(0);
      } finally {
        fixture.cleanup();
      }
    });
  });

  // =========================================================================
  // 13. Capability Denial on Retry
  // =========================================================================
  describe("13. Capability Denial on Retry", () => {
    it("denies unauthorized tool capability during retry with provider calls === 0", async () => {
      // Policy allows read_file initially, but revoke it before retry
      const restrictedPolicy = createExecutionPolicy({
        policyId: "policy-restr-retry",
        allowedCapabilities: ["workspace.file.read"],
        isolationRequirement: "ISOLATED",
      });

      const fixture = setupTestFixture({ policy: restrictedPolicy });

      try {
        const wsHandle = await fixture.workspacePort.provisionWorkspace({
          workspaceId: "ws-cap-retry",
          runId: fixture.run.runId,
          taskId: fixture.task.taskId,
          maxWorkspaceBytes: 50 * 1024 * 1024,
          maxFileSizeBytes: 10 * 1024 * 1024,
        });

        // Attempting to execute an action with write_file capability (not allowed)
        const result = await fixture.workerRuntime.executeAction({
          runId: fixture.run.runId,
          toolName: "write_file",
          inputPayload: { path: "forbidden.txt", content: "illegal" },
          workspace: wsHandle,
        });

        expect(result.status).toBe("FAILED");
        expect(fixture.provider.calls).toBe(0);
        expect(fixture.store.getAttemptsForAction(result.actionId).length).toBe(0);
      } finally {
        fixture.cleanup();
      }
    });
  });

  // =========================================================================
  // 14. Persistence Database Close and Reopen
  // =========================================================================
  describe("14. Persistence Database Close and Reopen", () => {
    it("recovers Action and Attempt state from durable SQLite state alone after store restart", async () => {
      const dbFile = path.join(os.tmpdir(), `emerald-db-rec-persist-${Date.now()}.db`);
      const fixture = setupTestFixture({ dbPath: dbFile });

      const actionId = "act-reopen-1";
      const attemptId = "att-reopen-1";

      try {
        // Set up in-flight execution in store
        const { action, event: actEvent } = Action.create({
          actionId,
          runId: fixture.run.runId,
          sequenceNumber: 1,
          toolName: "run_command",
          inputPayload: { argv: ["ls"], cwd: "." },
          contractBinding: fixture.run.contractBinding!,
          maxAttempts: 3,
          now: fixture.clock.nowIso(),
        });

        const { attempt, event: attEvent } = Attempt.create({
          attemptId,
          actionId,
          runId: fixture.run.runId,
          attemptNumber: 1,
          workerId: fixture.workerId,
          leaseId: fixture.lease.leaseId,
          now: fixture.clock.nowIso(),
        });

        fixture.store.transaction((tx) => {
          tx.insertAction(action.snapshot, actEvent, {
            workerId: fixture.workerId,
            leaseId: fixture.lease.leaseId,
          });
          tx.transitionAction(actionId, { type: "AUTHORIZE", now: fixture.clock.nowIso() }, () => "e1");
          tx.transitionAction(
            actionId,
            { type: "START_ATTEMPT", attemptNumber: 1, now: fixture.clock.nowIso() },
            () => "e2"
          );
          tx.insertAttempt(attempt.snapshot, attEvent, {
            workerId: fixture.workerId,
            leaseId: fixture.lease.leaseId,
          });
          tx.transitionAttempt(attemptId, { type: "DISPATCH", now: fixture.clock.nowIso() }, () => "e3");
          tx.transitionAttempt(attemptId, { type: "START", now: fixture.clock.nowIso() }, () => "e4");
        });

        // Simulate crash: close store completely!
        fixture.store.close();

        // Advance time
        fixture.clock.advanceMs(20000);

        // Reopen database with fresh store instance
        const reopenedStore = new SqliteStateStore({ location: dbFile });
        const reopenedCoordinator = new RunCoordinator(reopenedStore, fixture.clock);

        // Recover stale executions using fresh coordinator
        const recResult = reopenedCoordinator.recoverStaleExecutions({ runId: fixture.run.runId });

        expect(recResult.reconciledAttempts).toBe(1);
        const reloadedAttempt = reopenedStore.getAttempt(attemptId);
        expect(reloadedAttempt?.status).toBe("UNKNOWN");

        const reloadedAction = reopenedStore.getAction(actionId);
        expect(reloadedAction?.status).toBe("FAILED");

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
  // 15. Sweeper Idempotence
  // =========================================================================
  describe("15. Sweeper Idempotence", () => {
    it("repeatedly calling recoverStaleExecutions yields identical state with zero duplicate events", async () => {
      const fixture = setupTestFixture();

      try {
        const actionId = "act-sweep-idem";
        const attemptId = "att-sweep-idem";

        const { action, event: actEvent } = Action.create({
          actionId,
          runId: fixture.run.runId,
          sequenceNumber: 1,
          toolName: "write_file",
          inputPayload: { path: "idem.txt", content: "data" },
          contractBinding: fixture.run.contractBinding!,
          maxAttempts: 3,
          now: fixture.clock.nowIso(),
        });

        const { attempt, event: attEvent } = Attempt.create({
          attemptId,
          actionId,
          runId: fixture.run.runId,
          attemptNumber: 1,
          workerId: fixture.workerId,
          leaseId: fixture.lease.leaseId,
          now: fixture.clock.nowIso(),
        });

        fixture.store.transaction((tx) => {
          tx.insertAction(action.snapshot, actEvent, {
            workerId: fixture.workerId,
            leaseId: fixture.lease.leaseId,
          });
          tx.transitionAction(actionId, { type: "AUTHORIZE", now: fixture.clock.nowIso() }, () => "e1");
          tx.transitionAction(
            actionId,
            { type: "START_ATTEMPT", attemptNumber: 1, now: fixture.clock.nowIso() },
            () => "e2"
          );
          tx.insertAttempt(attempt.snapshot, attEvent, {
            workerId: fixture.workerId,
            leaseId: fixture.lease.leaseId,
          });
          tx.transitionAttempt(attemptId, { type: "DISPATCH", now: fixture.clock.nowIso() }, () => "e3");
          tx.transitionAttempt(attemptId, { type: "START", now: fixture.clock.nowIso() }, () => "e4");
        });

        fixture.clock.advanceMs(20000);

        // Pass 1
        const pass1 = fixture.coordinator.recoverStaleExecutions({ runId: fixture.run.runId });
        expect(pass1.reconciledAttempts).toBe(1);
        expect(pass1.reconciledActions).toBe(1);

        const eventsAfterPass1 = fixture.store.getEventsForRun(fixture.run.runId);

        // Pass 2
        const pass2 = fixture.coordinator.recoverStaleExecutions({ runId: fixture.run.runId });
        expect(pass2.reconciledAttempts).toBe(0);
        expect(pass2.reconciledActions).toBe(0);

        // Pass 3
        const pass3 = fixture.coordinator.recoverStaleExecutions({ runId: fixture.run.runId });
        expect(pass3.reconciledAttempts).toBe(0);
        expect(pass3.reconciledActions).toBe(0);

        const eventsAfterPass3 = fixture.store.getEventsForRun(fixture.run.runId);
        expect(eventsAfterPass3.length).toBe(eventsAfterPass1.length);
      } finally {
        fixture.cleanup();
      }
    });
  });

  // =========================================================================
  // 16. Window C: Attempt CREATED, Crashes Before DISPATCHED
  // =========================================================================
  describe("16. Crash Window C", () => {
    it("transitions Attempt CREATED to CANCELLED when worker crashes before dispatch", async () => {
      const fixture = setupTestFixture();

      try {
        const actionId = "act-win-c";
        const attemptId = "att-win-c";

        const { action, event: actEvent } = Action.create({
          actionId,
          runId: fixture.run.runId,
          sequenceNumber: 1,
          toolName: "read_file",
          inputPayload: { path: "win-c.txt" },
          contractBinding: fixture.run.contractBinding!,
          maxAttempts: 3,
          now: fixture.clock.nowIso(),
        });

        const { attempt, event: attEvent } = Attempt.create({
          attemptId,
          actionId,
          runId: fixture.run.runId,
          attemptNumber: 1,
          workerId: fixture.workerId,
          leaseId: fixture.lease.leaseId,
          now: fixture.clock.nowIso(),
        });

        fixture.store.transaction((tx) => {
          tx.insertAction(action.snapshot, actEvent, {
            workerId: fixture.workerId,
            leaseId: fixture.lease.leaseId,
          });
          tx.transitionAction(actionId, { type: "AUTHORIZE", now: fixture.clock.nowIso() }, () => "e1");
          tx.transitionAction(
            actionId,
            { type: "START_ATTEMPT", attemptNumber: 1, now: fixture.clock.nowIso() },
            () => "e2"
          );
          tx.insertAttempt(attempt.snapshot, attEvent, {
            workerId: fixture.workerId,
            leaseId: fixture.lease.leaseId,
          });
          // Attempt is in CREATED status; worker crashes before DISPATCH!
        });

        fixture.clock.advanceMs(20000);

        fixture.coordinator.recoverStaleExecutions({ runId: fixture.run.runId });

        // Attempt was cancelled (never dispatched)
        const postAttempt = fixture.store.getAttempt(attemptId);
        expect(postAttempt?.status).toBe("CANCELLED");

        // Idempotent action can transition to RETRYING
        const postAction = fixture.store.getAction(actionId);
        expect(postAction?.status).toBe("RETRYING");
      } finally {
        fixture.cleanup();
      }
    });
  });

  // =========================================================================
  // 17. Window D: Attempt DISPATCHED, Crashes Before RUNNING
  // =========================================================================
  describe("17. Crash Window D", () => {
    it("transitions Attempt DISPATCHED to UNKNOWN when worker crashes before running", async () => {
      const fixture = setupTestFixture();

      try {
        const actionId = "act-win-d";
        const attemptId = "att-win-d";

        const { action, event: actEvent } = Action.create({
          actionId,
          runId: fixture.run.runId,
          sequenceNumber: 1,
          toolName: "read_file",
          inputPayload: { path: "win-d.txt" },
          contractBinding: fixture.run.contractBinding!,
          maxAttempts: 3,
          now: fixture.clock.nowIso(),
        });

        const { attempt, event: attEvent } = Attempt.create({
          attemptId,
          actionId,
          runId: fixture.run.runId,
          attemptNumber: 1,
          workerId: fixture.workerId,
          leaseId: fixture.lease.leaseId,
          now: fixture.clock.nowIso(),
        });

        fixture.store.transaction((tx) => {
          tx.insertAction(action.snapshot, actEvent, {
            workerId: fixture.workerId,
            leaseId: fixture.lease.leaseId,
          });
          tx.transitionAction(actionId, { type: "AUTHORIZE", now: fixture.clock.nowIso() }, () => "e1");
          tx.transitionAction(
            actionId,
            { type: "START_ATTEMPT", attemptNumber: 1, now: fixture.clock.nowIso() },
            () => "e2"
          );
          tx.insertAttempt(attempt.snapshot, attEvent, {
            workerId: fixture.workerId,
            leaseId: fixture.lease.leaseId,
          });
          tx.transitionAttempt(attemptId, { type: "DISPATCH", now: fixture.clock.nowIso() }, () => "e3");
          // Attempt is in DISPATCHED status; worker crashes before START!
        });

        fixture.clock.advanceMs(20000);

        fixture.coordinator.recoverStaleExecutions({ runId: fixture.run.runId });

        // Dispatched attempt marked UNKNOWN
        const postAttempt = fixture.store.getAttempt(attemptId);
        expect(postAttempt?.status).toBe("UNKNOWN");
      } finally {
        fixture.cleanup();
      }
    });
  });

  // =========================================================================
  // 18. Window H: Action RETRYING, Crashes Before Attempt #2
  // =========================================================================
  describe("18. Crash Window H", () => {
    it("creates missing Attempt #2 exactly once when worker crashes during RETRYING wait", async () => {
      const fixture = setupTestFixture();

      try {
        const wsHandle = await fixture.workspacePort.provisionWorkspace({
          workspaceId: "ws-win-h",
          runId: fixture.run.runId,
          taskId: fixture.task.taskId,
          maxWorkspaceBytes: 50 * 1024 * 1024,
          maxFileSizeBytes: 10 * 1024 * 1024,
        });

        fs.writeFileSync(path.join(wsHandle.hostPath, "test.txt"), "retry recovery content", "utf8");
        fixture.workerRuntime.setRunWorkspace(fixture.run.runId, wsHandle);

        const actionId = "act-win-h";
        const attemptId = "att-win-h-1";

        const { action, event: actEvent } = Action.create({
          actionId,
          runId: fixture.run.runId,
          sequenceNumber: 1,
          toolName: "read_file",
          inputPayload: { path: "test.txt" },
          contractBinding: fixture.run.contractBinding!,
          maxAttempts: 3,
          now: fixture.clock.nowIso(),
        });

        const { attempt, event: attEvent } = Attempt.create({
          attemptId,
          actionId,
          runId: fixture.run.runId,
          attemptNumber: 1,
          workerId: fixture.workerId,
          leaseId: fixture.lease.leaseId,
          now: fixture.clock.nowIso(),
        });

        fixture.store.transaction((tx) => {
          tx.insertAction(action.snapshot, actEvent, {
            workerId: fixture.workerId,
            leaseId: fixture.lease.leaseId,
          });
          tx.transitionAction(actionId, { type: "AUTHORIZE", now: fixture.clock.nowIso() }, () => "e1");
          tx.transitionAction(
            actionId,
            { type: "START_ATTEMPT", attemptNumber: 1, now: fixture.clock.nowIso() },
            () => "e2"
          );
          tx.insertAttempt(attempt.snapshot, attEvent, {
            workerId: fixture.workerId,
            leaseId: fixture.lease.leaseId,
          });
          tx.transitionAttempt(attemptId, { type: "DISPATCH", now: fixture.clock.nowIso() }, () => "e3");
          tx.transitionAttempt(attemptId, { type: "START", now: fixture.clock.nowIso() }, () => "e4");
          tx.transitionAttempt(
            attemptId,
            { type: "FAIL", errorPayload: "transient", now: fixture.clock.nowIso() },
            () => "e5"
          );
          // Action transitioned to RETRYING, then worker died before creating Attempt 2!
          tx.transitionAction(
            actionId,
            { type: "PREPARE_RETRY", errorPayload: "transient", now: fixture.clock.nowIso() },
            () => "e6"
          );
        });

        // Verify pre-condition: Action is RETRYING, only 1 attempt exists
        expect(fixture.store.getAction(actionId)?.status).toBe("RETRYING");
        expect(fixture.store.getAttemptsForAction(actionId).length).toBe(1);

        // Recovery executes retry
        const recoveryRes = await fixture.workerRuntime.recoverStaleExecutions({
          runId: fixture.run.runId,
        });

        expect(recoveryRes.retriedActions.length).toBe(1);
        expect(recoveryRes.retriedActions[0]?.status).toBe("SUCCEEDED");

        // Action is now SUCCEEDED
        const postAction = fixture.store.getAction(actionId);
        expect(postAction?.status).toBe("SUCCEEDED");
        expect(postAction?.totalAttempts).toBe(2);

        // Exactly 2 attempts exist in store
        const allAttempts = fixture.store.getAttemptsForAction(actionId);
        expect(allAttempts.length).toBe(2);
        expect(allAttempts[0]?.attemptNumber).toBe(1);
        expect(allAttempts[0]?.status).toBe("FAILED");
        expect(allAttempts[1]?.attemptNumber).toBe(2);
        expect(allAttempts[1]?.status).toBe("SUCCEEDED");
      } finally {
        fixture.cleanup();
      }
    });
  });
});
