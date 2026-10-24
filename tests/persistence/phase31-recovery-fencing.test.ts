import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { Action } from "../../src/domain/action.js";
import { Attempt } from "../../src/domain/attempt.js";
import {
  AttemptNotOwnedError,
  LeaseExpiredError,
  LeaseLostError,
  TerminalStateError,
} from "../../src/domain/errors.js";
import {
  createMissionContract,
  createDefaultInProcessPolicy,
  createResourceLimits,
  createVerificationSpec,
  MissionContract,
} from "../../src/domain/index.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { ExecutionProvider, ExecutionRequest, ExecutionResult } from "../../src/ports/execution-provider.port.js";

class MockCountingProvider implements ExecutionProvider {
  readonly name = "mock-counting-provider";
  readonly invocations: ExecutionRequest[] = [];
  nextResult?: ExecutionResult;

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocations.push(request);
    if (this.nextResult) {
      return this.nextResult as ExecutionResult<TOutput>;
    }
    return {
      status: "SUCCESS",
      output: { exitCode: 0, stdout: "ok", durationMs: 10 } as unknown as TOutput,
      durationMs: 10,
    };
  }
}

describe("Phase 31 — Deterministic Multi-Attempt Recovery & Durable Worker Lease Fencing", () => {
  let tempDir: string;
  let dbPath: string;
  let store: SqliteStateStore;
  let clock: SettableClock;
  let coordinator: RunCoordinator;
  let provider: MockCountingProvider;
  let boundContract: MissionContract;

  const runId = "run-p31-main";
  const taskId = "task-p31-main";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-phase31-test-"));
    dbPath = path.join(tempDir, "phase31.db");
    store = new SqliteStateStore({ location: dbPath });
    clock = new SettableClock("2026-10-18T12:00:00.000Z");
    coordinator = new RunCoordinator(store, clock);
    provider = new MockCountingProvider();

    store.transaction((tx) => {
      tx.insertTask({
        taskId,
        title: "Phase 31 Fencing & Recovery Task",
        description: "Testing deterministic multi-attempt recovery and worker lease fencing",
        inputPayload: { query: "fencing-test" },
        createdAt: clock.nowIso(),
        updatedAt: clock.nowIso(),
      });

      boundContract = createMissionContract({
        contractId: "contract-p31",
        version: 1,
        taskId,
        policy: createDefaultInProcessPolicy("policy-p31"),
        verificationSpecs: [
          createVerificationSpec({
            specId: "vspec-p31",
            ruleKind: "EXACT_OUTPUT_MATCH",
            expectedValue: { exitCode: 0 },
          }),
        ],
        resourceLimits: createResourceLimits({
          timeoutMs: 30000,
          maxAttempts: 3,
          maxOutputBytes: 65536,
        }),
        credentialScopes: ["workspace:read", "workspace:write"],
      });
      tx.insertContract(boundContract);
      tx.activateContract(boundContract.spec.contractId, boundContract.spec.version, clock.nowIso());

      tx.insertWorker({
        workerId: "worker-A",
        hostname: "node-1",
        pid: 1001,
        status: "ACTIVE",
        lastHeartbeatAt: clock.nowIso(),
        createdAt: clock.nowIso(),
      });

      tx.insertWorker({
        workerId: "worker-B",
        hostname: "node-2",
        pid: 1002,
        status: "ACTIVE",
        lastHeartbeatAt: clock.nowIso(),
        createdAt: clock.nowIso(),
      });

      tx.insertWorker({
        workerId: "worker-C",
        hostname: "node-3",
        pid: 1003,
        status: "ACTIVE",
        lastHeartbeatAt: clock.nowIso(),
        createdAt: clock.nowIso(),
      });
    });

    const { run } = coordinator.createRun({ runId, taskId });
    coordinator.queueRun(run.runId);
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  // -------------------------------------------------------------------------
  // T1: Acquire valid lease
  // -------------------------------------------------------------------------
  it("T1: acquires a valid worker lease on a queued run and records authoritative state", () => {
    const claim = coordinator.claimRun(runId, "worker-A", 10000);
    expect(claim.run.status).toBe("LEASED");
    expect(claim.run.currentWorkerId).toBe("worker-A");
    expect(claim.run.leaseId).toBe(claim.lease.leaseId);
    expect(claim.lease.state).toBe("ACTIVE");
    expect(claim.lease.expiresAt).toBe("2026-10-18T12:00:10.000Z");

    const fetchedLease = store.getLease(claim.lease.leaseId);
    expect(fetchedLease?.state).toBe("ACTIVE");
    expect(fetchedLease?.workerId).toBe("worker-A");
  });

  // -------------------------------------------------------------------------
  // T2: Renew valid lease
  // -------------------------------------------------------------------------
  it("T2: successfully renews an active valid lease before expiry", () => {
    const claim = coordinator.claimRun(runId, "worker-A", 10000);
    coordinator.startRun(runId, "worker-A", claim.lease.leaseId);

    // Advance clock 5 seconds (before 10s expiry)
    clock.advanceMs(5000);

    const renewed = coordinator.renewLease(runId, claim.lease.leaseId, 15000);
    expect(renewed.expiresAt).toBe("2026-10-18T12:00:20.000Z");

    const run = store.getRun(runId);
    expect(run?.leaseExpiresAt).toBe("2026-10-18T12:00:20.000Z");
  });

  // -------------------------------------------------------------------------
  // T3: Reject expired lease
  // -------------------------------------------------------------------------
  it("T3: rejects renewal and attempt mutations when lease has expired", () => {
    const claim = coordinator.claimRun(runId, "worker-A", 10000);
    coordinator.startRun(runId, "worker-A", claim.lease.leaseId);

    // Advance clock past 10s expiry
    clock.advanceMs(12000);

    // Renewal must be rejected with LeaseExpiredError
    expect(() => {
      coordinator.renewLease(runId, claim.lease.leaseId, 10000);
    }).toThrow(LeaseExpiredError);

    // Worker A attempting to create an Action after expiry must be rejected
    const { action, event: actEvt } = Action.create({
      actionId: "act-expired-test",
      runId,
      sequenceNumber: 1,
      toolName: "read_file",
      inputPayload: { path: "test.txt" },
      contractBinding: store.getRun(runId)!.contractBinding!,
      maxAttempts: 3,
      now: clock.nowIso(),
    });

    expect(() => {
      store.transaction((tx) => {
        tx.insertAction(action.snapshot, actEvt, {
          workerId: "worker-A",
          leaseId: claim.lease.leaseId,
          nowIso: clock.nowIso(),
        });
      });
    }).toThrow(LeaseExpiredError);
  });

  // -------------------------------------------------------------------------
  // T4: Reject stale lease after takeover
  // -------------------------------------------------------------------------
  it("T4: rejects mutations from stale lease after run has been reassigned to a new worker", () => {
    const claimA = coordinator.claimRun(runId, "worker-A", 10000);
    coordinator.startRun(runId, "worker-A", claimA.lease.leaseId);

    // Advance clock to expire Worker A's lease
    clock.advanceMs(12000);

    // Sweeper recovers expired run
    coordinator.recoverExpiredRuns();

    // Worker B claims the run with a new lease
    const claimB = coordinator.claimRun(runId, "worker-B", 15000);
    coordinator.startRun(runId, "worker-B", claimB.lease.leaseId);

    expect(store.getRun(runId)?.currentWorkerId).toBe("worker-B");
    expect(store.getRun(runId)?.leaseId).toBe(claimB.lease.leaseId);

    // Stale Worker A wakes up and attempts mutation with old lease A
    const { action, event: actEvt } = Action.create({
      actionId: "act-stale-takeover",
      runId,
      sequenceNumber: 1,
      toolName: "read_file",
      inputPayload: { path: "test.txt" },
      contractBinding: store.getRun(runId)!.contractBinding!,
      maxAttempts: 3,
      now: clock.nowIso(),
    });

    expect(() => {
      store.transaction((tx) => {
        tx.insertAction(action.snapshot, actEvt, {
          workerId: "worker-A",
          leaseId: claimA.lease.leaseId,
        });
      });
    }).toThrow(LeaseLostError);

    // Authoritative state is uncorrupted
    expect(store.getAction("act-stale-takeover")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // T5: Reject wrong worker / lease combination
  // -------------------------------------------------------------------------
  it("T5: rejects attempt advancement when wrong worker presents mismatched lease or does not own attempt", () => {
    const claimA = coordinator.claimRun(runId, "worker-A", 20000);
    coordinator.startRun(runId, "worker-A", claimA.lease.leaseId);

    const actionId = "act-t5";
    const attemptId = "att-t5-1";

    const { action, event: actEvt } = Action.create({
      actionId,
      runId,
      sequenceNumber: 1,
      toolName: "read_file",
      inputPayload: { path: "test.txt" },
      contractBinding: store.getRun(runId)!.contractBinding!,
      maxAttempts: 3,
      now: clock.nowIso(),
    });

    const { attempt, event: attEvt } = Attempt.create({
      attemptId,
      actionId,
      runId,
      attemptNumber: 1,
      workerId: "worker-A",
      leaseId: claimA.lease.leaseId,
      now: clock.nowIso(),
    });

    store.transaction((tx) => {
      tx.insertAction(action.snapshot, actEvt, {
        workerId: "worker-A",
        leaseId: claimA.lease.leaseId,
      });
      tx.transitionAction(actionId, { type: "AUTHORIZE", now: clock.nowIso() }, () => "e1");
      tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 1, now: clock.nowIso() }, () => "e2");
      tx.insertAttempt(attempt.snapshot, attEvt, {
        workerId: "worker-A",
        leaseId: claimA.lease.leaseId,
      });
      tx.transitionAttempt(attemptId, { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
      tx.transitionAttempt(attemptId, { type: "START", now: clock.nowIso() }, () => "e4");
    });

    // Worker B attempts to complete Attempt 1 using Worker A's leaseId (mismatched workerId)
    expect(() => {
      store.transaction((tx) => {
        tx.transitionAttempt(
          attemptId,
          { type: "COMPLETE", outputPayload: { ok: true }, now: clock.nowIso() },
          () => "e-mismatch",
          { workerId: "worker-B", leaseId: claimA.lease.leaseId }
        );
      });
    }).toThrow(LeaseLostError);

    // Attempt remains RUNNING
    expect(store.getAttempt(attemptId)?.status).toBe("RUNNING");
  });

  // -------------------------------------------------------------------------
  // T6: Accept valid attempt completion
  // -------------------------------------------------------------------------
  it("T6: accepts valid attempt completion from the authorized leaseholder", () => {
    const claimA = coordinator.claimRun(runId, "worker-A", 20000);
    coordinator.startRun(runId, "worker-A", claimA.lease.leaseId);

    const actionId = "act-t6";
    const attemptId = "att-t6-1";

    const { action, event: actEvt } = Action.create({
      actionId,
      runId,
      sequenceNumber: 1,
      toolName: "read_file",
      inputPayload: { path: "test.txt" },
      contractBinding: store.getRun(runId)!.contractBinding!,
      maxAttempts: 3,
      now: clock.nowIso(),
    });

    const { attempt, event: attEvt } = Attempt.create({
      attemptId,
      actionId,
      runId,
      attemptNumber: 1,
      workerId: "worker-A",
      leaseId: claimA.lease.leaseId,
      now: clock.nowIso(),
    });

    store.transaction((tx) => {
      tx.insertAction(action.snapshot, actEvt, {
        workerId: "worker-A",
        leaseId: claimA.lease.leaseId,
      });
      tx.transitionAction(actionId, { type: "AUTHORIZE", now: clock.nowIso() }, () => "e1");
      tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 1, now: clock.nowIso() }, () => "e2");
      tx.insertAttempt(attempt.snapshot, attEvt, {
        workerId: "worker-A",
        leaseId: claimA.lease.leaseId,
      });
      tx.transitionAttempt(attemptId, { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
      tx.transitionAttempt(attemptId, { type: "START", now: clock.nowIso() }, () => "e4");

      // Valid completion
      tx.transitionAttempt(
        attemptId,
        { type: "COMPLETE", outputPayload: { content: "hello" }, exitCode: 0, now: clock.nowIso() },
        () => "e5",
        { workerId: "worker-A", leaseId: claimA.lease.leaseId }
      );
      tx.transitionAction(
        actionId,
        { type: "SUCCEED", resultPayload: { content: "hello" }, now: clock.nowIso() },
        () => "e6",
        { workerId: "worker-A", leaseId: claimA.lease.leaseId }
      );
    });

    const completedAttempt = store.getAttempt(attemptId);
    expect(completedAttempt?.status).toBe("SUCCEEDED");
    expect(completedAttempt?.exitCode).toBe(0);

    const completedAction = store.getAction(actionId);
    expect(completedAction?.status).toBe("SUCCEEDED");
    expect(completedAction?.resultPayload).toEqual({ content: "hello" });
  });

  // -------------------------------------------------------------------------
  // T7: Reject duplicate completion idempotently
  // -------------------------------------------------------------------------
  it("T7: returns existing authoritative outcome when duplicate completion message arrives without adding duplicate events", () => {
    const claimA = coordinator.claimRun(runId, "worker-A", 20000);
    coordinator.startRun(runId, "worker-A", claimA.lease.leaseId);

    const actionId = "act-t7";
    const attemptId = "att-t7-1";

    const { action, event: actEvt } = Action.create({
      actionId,
      runId,
      sequenceNumber: 1,
      toolName: "read_file",
      inputPayload: { path: "test.txt" },
      contractBinding: store.getRun(runId)!.contractBinding!,
      maxAttempts: 3,
      now: clock.nowIso(),
    });

    const { attempt, event: attEvt } = Attempt.create({
      attemptId,
      actionId,
      runId,
      attemptNumber: 1,
      workerId: "worker-A",
      leaseId: claimA.lease.leaseId,
      now: clock.nowIso(),
    });

    store.transaction((tx) => {
      tx.insertAction(action.snapshot, actEvt, {
        workerId: "worker-A",
        leaseId: claimA.lease.leaseId,
      });
      tx.transitionAction(actionId, { type: "AUTHORIZE", now: clock.nowIso() }, () => "e1");
      tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 1, now: clock.nowIso() }, () => "e2");
      tx.insertAttempt(attempt.snapshot, attEvt, {
        workerId: "worker-A",
        leaseId: claimA.lease.leaseId,
      });
      tx.transitionAttempt(attemptId, { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
      tx.transitionAttempt(attemptId, { type: "START", now: clock.nowIso() }, () => "e4");

      tx.transitionAttempt(
        attemptId,
        { type: "COMPLETE", outputPayload: { content: "hello" }, exitCode: 0, now: clock.nowIso() },
        () => "att-comp-evt",
        { workerId: "worker-A", leaseId: claimA.lease.leaseId }
      );
      tx.transitionAction(
        actionId,
        { type: "SUCCEED", resultPayload: { content: "hello" }, now: clock.nowIso() },
        () => "act-comp-evt",
        { workerId: "worker-A", leaseId: claimA.lease.leaseId }
      );
    });

    const eventCountBefore = store.getEventsForRun(runId).length;

    // Resubmit duplicate completion
    const duplicateRes = store.transaction((tx) => {
      const attRes = tx.transitionAttempt(
        attemptId,
        { type: "COMPLETE", outputPayload: { content: "hello" }, exitCode: 0, now: clock.nowIso() },
        () => "duplicate-evt-id",
        { workerId: "worker-A", leaseId: claimA.lease.leaseId }
      );
      const actRes = tx.transitionAction(
        actionId,
        { type: "SUCCEED", resultPayload: { content: "hello" }, now: clock.nowIso() },
        () => "duplicate-act-evt-id",
        { workerId: "worker-A", leaseId: claimA.lease.leaseId }
      );
      return { attRes, actRes };
    });

    expect(duplicateRes.attRes.snapshot.status).toBe("SUCCEEDED");
    expect(duplicateRes.actRes.snapshot.status).toBe("SUCCEEDED");

    // Invariant: Zero duplicate events inserted!
    const eventCountAfter = store.getEventsForRun(runId).length;
    expect(eventCountAfter).toBe(eventCountBefore);

    // And WorkerRuntime.executeAction enforces terminal-state immutability
    const runtime = new WorkerRuntime({
      workerId: "worker-A",
      coordinator,
      clock,
      executionProvider: provider,
    });

    return expect(
      runtime.executeAction({
        runId,
        actionId,
        leaseId: claimA.lease.leaseId,
      })
    ).rejects.toThrow(TerminalStateError);
  });

  // -------------------------------------------------------------------------
  // T8: Recover expired attempt
  // -------------------------------------------------------------------------
  it("T8: recovers an expired running attempt to UNKNOWN without corrupting action history", () => {
    const claimA = coordinator.claimRun(runId, "worker-A", 10000);
    coordinator.startRun(runId, "worker-A", claimA.lease.leaseId);

    const actionId = "act-t8";
    const attemptId = "att-t8-1";

    const { action, event: actEvt } = Action.create({
      actionId,
      runId,
      sequenceNumber: 1,
      toolName: "read_file",
      inputPayload: { path: "test.txt" },
      contractBinding: store.getRun(runId)!.contractBinding!,
      maxAttempts: 3,
      now: clock.nowIso(),
    });

    const { attempt, event: attEvt } = Attempt.create({
      attemptId,
      actionId,
      runId,
      attemptNumber: 1,
      workerId: "worker-A",
      leaseId: claimA.lease.leaseId,
      now: clock.nowIso(),
    });

    store.transaction((tx) => {
      tx.insertAction(action.snapshot, actEvt, {
        workerId: "worker-A",
        leaseId: claimA.lease.leaseId,
      });
      tx.transitionAction(actionId, { type: "AUTHORIZE", now: clock.nowIso() }, () => "e1");
      tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 1, now: clock.nowIso() }, () => "e2");
      tx.insertAttempt(attempt.snapshot, attEvt, {
        workerId: "worker-A",
        leaseId: claimA.lease.leaseId,
      });
      tx.transitionAttempt(attemptId, { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
      tx.transitionAttempt(attemptId, { type: "START", now: clock.nowIso() }, () => "e4");
    });

    // Advance clock past expiry
    clock.advanceMs(15000);

    const recovery = coordinator.recoverExpiredRuns();
    expect(recovery.recoveredCount).toBe(1);

    const recoveredAttempt = store.getAttempt(attemptId);
    expect(recoveredAttempt?.status).toBe("UNKNOWN");
    expect(recoveredAttempt?.errorPayload).toEqual(
      expect.objectContaining({
        code: "EXECUTION_UNCERTAIN",
        reasonCode: "LEASE_EXPIRED_DURING_EXECUTION",
      })
    );
  });

  // -------------------------------------------------------------------------
  // T9: Create Attempt N+1 without mutating Attempt N
  // -------------------------------------------------------------------------
  it("T9: preserves Attempt 1 as immutable evidence when Attempt 2 is created on retry", () => {
    const claimA = coordinator.claimRun(runId, "worker-A", 15000);
    coordinator.startRun(runId, "worker-A", claimA.lease.leaseId);

    const actionId = "act-t9";
    const attempt1Id = "att-t9-1";

    const { action, event: actEvt } = Action.create({
      actionId,
      runId,
      sequenceNumber: 1,
      toolName: "read_file",
      inputPayload: { path: "test.txt" },
      contractBinding: store.getRun(runId)!.contractBinding!,
      maxAttempts: 3,
      now: clock.nowIso(),
    });

    const { attempt: att1, event: att1Evt } = Attempt.create({
      attemptId: attempt1Id,
      actionId,
      runId,
      attemptNumber: 1,
      workerId: "worker-A",
      leaseId: claimA.lease.leaseId,
      now: clock.nowIso(),
    });

    store.transaction((tx) => {
      tx.insertAction(action.snapshot, actEvt, {
        workerId: "worker-A",
        leaseId: claimA.lease.leaseId,
      });
      tx.transitionAction(actionId, { type: "AUTHORIZE", now: clock.nowIso() }, () => "e1");
      tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 1, now: clock.nowIso() }, () => "e2");
      tx.insertAttempt(att1.snapshot, att1Evt, {
        workerId: "worker-A",
        leaseId: claimA.lease.leaseId,
      });
      tx.transitionAttempt(attempt1Id, { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
      tx.transitionAttempt(attempt1Id, { type: "START", now: clock.nowIso() }, () => "e4");

      // Attempt 1 fails deterministically
      tx.transitionAttempt(
        attempt1Id,
        { type: "FAIL", errorPayload: { message: "not found" }, exitCode: 1, now: clock.nowIso() },
        () => "e5",
        { workerId: "worker-A", leaseId: claimA.lease.leaseId }
      );
      // Action enters RETRYING
      tx.transitionAction(
        actionId,
        { type: "PREPARE_RETRY", errorPayload: { message: "not found" }, now: clock.nowIso() },
        () => "e6",
        { workerId: "worker-A", leaseId: claimA.lease.leaseId }
      );
    });

    // Create Attempt 2
    const attempt2Id = "att-t9-2";
    const { attempt: att2, event: att2Evt } = Attempt.create({
      attemptId: attempt2Id,
      actionId,
      runId,
      attemptNumber: 2,
      workerId: "worker-A",
      leaseId: claimA.lease.leaseId,
      now: clock.nowIso(),
    });

    store.transaction((tx) => {
      tx.transitionAction(
        actionId,
        { type: "START_ATTEMPT", attemptNumber: 2, now: clock.nowIso() },
        () => "e7",
        { workerId: "worker-A", leaseId: claimA.lease.leaseId }
      );
      tx.insertAttempt(att2.snapshot, att2Evt, {
        workerId: "worker-A",
        leaseId: claimA.lease.leaseId,
      });
      tx.transitionAttempt(attempt2Id, { type: "DISPATCH", now: clock.nowIso() }, () => "e8");
      tx.transitionAttempt(attempt2Id, { type: "START", now: clock.nowIso() }, () => "e9");
    });

    // Verify Attempt 1 remains intact
    const fetchedAtt1 = store.getAttempt(attempt1Id);
    expect(fetchedAtt1?.status).toBe("FAILED");
    expect(fetchedAtt1?.attemptNumber).toBe(1);
    expect(fetchedAtt1?.exitCode).toBe(1);

    // Verify Attempt 2 is RUNNING
    const fetchedAtt2 = store.getAttempt(attempt2Id);
    expect(fetchedAtt2?.status).toBe("RUNNING");
    expect(fetchedAtt2?.attemptNumber).toBe(2);

    // Both attempts exist in history
    const allAttempts = store.getAttemptsForAction(actionId);
    expect(allAttempts.length).toBe(2);
  });

  // -------------------------------------------------------------------------
  // T10: Preserve monotonic attempt numbering
  // -------------------------------------------------------------------------
  it("T10: rejects attempt number gaps or duplicate attempt numbers", () => {
    const claimA = coordinator.claimRun(runId, "worker-A", 15000);
    coordinator.startRun(runId, "worker-A", claimA.lease.leaseId);

    const actionId = "act-t10";

    const { action, event: actEvt } = Action.create({
      actionId,
      runId,
      sequenceNumber: 1,
      toolName: "read_file",
      inputPayload: { path: "test.txt" },
      contractBinding: store.getRun(runId)!.contractBinding!,
      maxAttempts: 3,
      now: clock.nowIso(),
    });

    store.transaction((tx) => {
      tx.insertAction(action.snapshot, actEvt, {
        workerId: "worker-A",
        leaseId: claimA.lease.leaseId,
      });
      tx.transitionAction(actionId, { type: "AUTHORIZE", now: clock.nowIso() }, () => "e1");
    });

    // Attempting to insert Attempt 2 without Attempt 1 must be rejected
    const { attempt: attSkip, event: attSkipEvt } = Attempt.create({
      attemptId: "att-skip-1",
      actionId,
      runId,
      attemptNumber: 2, // Gap!
      workerId: "worker-A",
      leaseId: claimA.lease.leaseId,
      now: clock.nowIso(),
    });

    expect(() => {
      store.transaction((tx) => {
        tx.insertAttempt(attSkip.snapshot, attSkipEvt, {
          workerId: "worker-A",
          leaseId: claimA.lease.leaseId,
        });
      });
    }).toThrow(/Attempt number gap/);
  });

  // -------------------------------------------------------------------------
  // T11: Prevent two workers from advancing the same attempt
  // -------------------------------------------------------------------------
  it("T11: prevents two workers from advancing the same active attempt", () => {
    const claimA = coordinator.claimRun(runId, "worker-A", 20000);
    coordinator.startRun(runId, "worker-A", claimA.lease.leaseId);

    const actionId = "act-t11";
    const attemptId = "att-t11-1";

    const { action, event: actEvt } = Action.create({
      actionId,
      runId,
      sequenceNumber: 1,
      toolName: "read_file",
      inputPayload: { path: "test.txt" },
      contractBinding: store.getRun(runId)!.contractBinding!,
      maxAttempts: 3,
      now: clock.nowIso(),
    });

    const { attempt, event: attEvt } = Attempt.create({
      attemptId,
      actionId,
      runId,
      attemptNumber: 1,
      workerId: "worker-A",
      leaseId: claimA.lease.leaseId,
      now: clock.nowIso(),
    });

    store.transaction((tx) => {
      tx.insertAction(action.snapshot, actEvt, {
        workerId: "worker-A",
        leaseId: claimA.lease.leaseId,
      });
      tx.transitionAction(actionId, { type: "AUTHORIZE", now: clock.nowIso() }, () => "e1");
      tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 1, now: clock.nowIso() }, () => "e2");
      tx.insertAttempt(attempt.snapshot, attEvt, {
        workerId: "worker-A",
        leaseId: claimA.lease.leaseId,
      });
      tx.transitionAttempt(attemptId, { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
      tx.transitionAttempt(attemptId, { type: "START", now: clock.nowIso() }, () => "e4");
    });

    // Worker B attempts to complete Worker A's attempt with invalid lease
    expect(() => {
      store.transaction((tx) => {
        tx.transitionAttempt(
          attemptId,
          { type: "COMPLETE", outputPayload: { ok: true }, now: clock.nowIso() },
          () => "e-fail",
          { workerId: "worker-B", leaseId: "lease-B" }
        );
      });
    }).toThrow(LeaseLostError);

    // If Worker B claims run on retry, attempting to advance Worker A's attempt throws AttemptNotOwnedError
    clock.advanceMs(25000);
    coordinator.recoverExpiredRuns();
    const claimB = coordinator.claimRun(runId, "worker-B", 15000);
    coordinator.startRun(runId, "worker-B", claimB.lease.leaseId);

    expect(() => {
      store.transaction((tx) => {
        tx.transitionAttempt(
          attemptId,
          { type: "COMPLETE", outputPayload: { ok: true }, now: clock.nowIso() },
          () => "e-fail",
          { workerId: "worker-B", leaseId: claimB.lease.leaseId }
        );
      });
    }).toThrow(AttemptNotOwnedError);
  });

  // -------------------------------------------------------------------------
  // T12: Preserve gapless event sequencing
  // -------------------------------------------------------------------------
  it("T12: preserves strictly monotonic gapless per-run event sequencing across transitions and rejected operations", () => {
    const claimA = coordinator.claimRun(runId, "worker-A", 20000);
    coordinator.startRun(runId, "worker-A", claimA.lease.leaseId);

    const actionId = "act-t12";
    const attemptId = "att-t12-1";

    const { action, event: actEvt } = Action.create({
      actionId,
      runId,
      sequenceNumber: 1,
      toolName: "read_file",
      inputPayload: { path: "test.txt" },
      contractBinding: store.getRun(runId)!.contractBinding!,
      maxAttempts: 3,
      now: clock.nowIso(),
    });

    const { attempt, event: attEvt } = Attempt.create({
      attemptId,
      actionId,
      runId,
      attemptNumber: 1,
      workerId: "worker-A",
      leaseId: claimA.lease.leaseId,
      now: clock.nowIso(),
    });

    store.transaction((tx) => {
      tx.insertAction(action.snapshot, actEvt, {
        workerId: "worker-A",
        leaseId: claimA.lease.leaseId,
      });
      tx.transitionAction(actionId, { type: "AUTHORIZE", now: clock.nowIso() }, () => "e1");
      tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 1, now: clock.nowIso() }, () => "e2");
      tx.insertAttempt(attempt.snapshot, attEvt, {
        workerId: "worker-A",
        leaseId: claimA.lease.leaseId,
      });
      tx.transitionAttempt(attemptId, { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
      tx.transitionAttempt(attemptId, { type: "START", now: clock.nowIso() }, () => "e4");
    });

    // Rejected attempt mutation must NOT increment event sequence
    try {
      store.transaction((tx) => {
        tx.transitionAttempt(
          attemptId,
          { type: "COMPLETE", outputPayload: {}, now: clock.nowIso() },
          () => "e-bad",
          { workerId: "worker-B", leaseId: "lease-B" }
        );
      });
    } catch {
      // Expected failure
    }

    // Now valid completion
    store.transaction((tx) => {
      tx.transitionAttempt(
        attemptId,
        { type: "COMPLETE", outputPayload: { ok: true }, now: clock.nowIso() },
        () => "e5",
        { workerId: "worker-A", leaseId: claimA.lease.leaseId }
      );
      tx.transitionAction(
        actionId,
        { type: "SUCCEED", resultPayload: { ok: true }, now: clock.nowIso() },
        () => "e6",
        { workerId: "worker-A", leaseId: claimA.lease.leaseId }
      );
    });

    const events = store.getEventsForRun(runId);
    expect(events.length).toBeGreaterThanOrEqual(8);

    for (let i = 0; i < events.length; i++) {
      expect(events[i]?.sequence).toBe(i + 1);
    }
  });

  // -------------------------------------------------------------------------
  // T13: Preserve Action / Attempt consistency
  // -------------------------------------------------------------------------
  it("T13: guarantees Action SUCCEEDED state matches authoritative Attempt SUCCEEDED state", () => {
    const claimA = coordinator.claimRun(runId, "worker-A", 20000);
    coordinator.startRun(runId, "worker-A", claimA.lease.leaseId);

    const actionId = "act-t13";
    const attemptId = "att-t13-1";

    const { action, event: actEvt } = Action.create({
      actionId,
      runId,
      sequenceNumber: 1,
      toolName: "read_file",
      inputPayload: { path: "test.txt" },
      contractBinding: store.getRun(runId)!.contractBinding!,
      maxAttempts: 3,
      now: clock.nowIso(),
    });

    const { attempt, event: attEvt } = Attempt.create({
      attemptId,
      actionId,
      runId,
      attemptNumber: 1,
      workerId: "worker-A",
      leaseId: claimA.lease.leaseId,
      now: clock.nowIso(),
    });

    store.transaction((tx) => {
      tx.insertAction(action.snapshot, actEvt, {
        workerId: "worker-A",
        leaseId: claimA.lease.leaseId,
      });
      tx.transitionAction(actionId, { type: "AUTHORIZE", now: clock.nowIso() }, () => "e1");
      tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 1, now: clock.nowIso() }, () => "e2");
      tx.insertAttempt(attempt.snapshot, attEvt, {
        workerId: "worker-A",
        leaseId: claimA.lease.leaseId,
      });
      tx.transitionAttempt(attemptId, { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
      tx.transitionAttempt(attemptId, { type: "START", now: clock.nowIso() }, () => "e4");

      // Attempt fails
      tx.transitionAttempt(
        attemptId,
        { type: "FAIL", errorPayload: { err: "failed" }, now: clock.nowIso() },
        () => "e5",
        { workerId: "worker-A", leaseId: claimA.lease.leaseId }
      );
    });

    // Action cannot be SUCCEEDED if Attempt is FAILED
    const act = store.getAction(actionId)!;
    expect(act.status).not.toBe("SUCCEEDED");
  });

  // -------------------------------------------------------------------------
  // T14: UNKNOWN attempt follows existing retry/idempotency policy
  // -------------------------------------------------------------------------
  it("T14: fails closed for non-idempotent UNKNOWN attempts without blind automatic retry", () => {
    const claimA = coordinator.claimRun(runId, "worker-A", 10000);
    coordinator.startRun(runId, "worker-A", claimA.lease.leaseId);

    const actionId = "act-t14-write";
    const attemptId = "att-t14-1";

    // write_file is NON_IDEMPOTENT
    const { action, event: actEvt } = Action.create({
      actionId,
      runId,
      sequenceNumber: 1,
      toolName: "write_file",
      inputPayload: { path: "output.txt", content: "data" },
      contractBinding: store.getRun(runId)!.contractBinding!,
      maxAttempts: 3,
      now: clock.nowIso(),
    });

    const { attempt, event: attEvt } = Attempt.create({
      attemptId,
      actionId,
      runId,
      attemptNumber: 1,
      workerId: "worker-A",
      leaseId: claimA.lease.leaseId,
      now: clock.nowIso(),
    });

    store.transaction((tx) => {
      tx.insertAction(action.snapshot, actEvt, {
        workerId: "worker-A",
        leaseId: claimA.lease.leaseId,
      });
      tx.transitionAction(actionId, { type: "AUTHORIZE", now: clock.nowIso() }, () => "e1");
      tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 1, now: clock.nowIso() }, () => "e2");
      tx.insertAttempt(attempt.snapshot, attEvt, {
        workerId: "worker-A",
        leaseId: claimA.lease.leaseId,
      });
      tx.transitionAttempt(attemptId, { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
      tx.transitionAttempt(attemptId, { type: "START", now: clock.nowIso() }, () => "e4");
    });

    // Lease expires
    clock.advanceMs(15000);

    coordinator.recoverExpiredRuns();

    const att = store.getAttempt(attemptId);
    expect(att?.status).toBe("UNKNOWN");

    const act = store.getAction(actionId);
    expect(act?.status).toBe("FAILED"); // Fail closed!
  });

  // -------------------------------------------------------------------------
  // T15: Crash -> lease expiry -> deterministic recovery
  // -------------------------------------------------------------------------
  it("T15: deterministically recovers from worker crash and lease expiration", () => {
    const claimA = coordinator.claimRun(runId, "worker-A", 10000);
    coordinator.startRun(runId, "worker-A", claimA.lease.leaseId);

    // Worker crashes, lease expires
    clock.advanceMs(20000);

    const rec = coordinator.recoverExpiredRuns();
    expect(rec.recoveredCount).toBe(1);

    const run = store.getRun(runId);
    expect(run?.status).toBe("QUEUED");
    expect(run?.attemptCount).toBe(1);
    expect(run?.currentWorkerId).toBeNull();
    expect(run?.leaseId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // T16: Stale worker resumes after recovery
  // -------------------------------------------------------------------------
  it("T16: rejects zombie worker that resumes execution after sweeper recovery has reassigned run", () => {
    const claimA = coordinator.claimRun(runId, "worker-A", 10000);
    coordinator.startRun(runId, "worker-A", claimA.lease.leaseId);

    // Lease expires
    clock.advanceMs(15000);

    coordinator.recoverExpiredRuns();

    // Worker B claims the run
    const claimB = coordinator.claimRun(runId, "worker-B", 15000);
    coordinator.startRun(runId, "worker-B", claimB.lease.leaseId);

    // Stale Worker A resumes and tries to complete run
    expect(() => {
      coordinator.completeRun(runId, "worker-A", claimA.lease.leaseId, { output: "zombie" });
    }).toThrow(LeaseLostError);

    // Run remains actively leased to Worker B
    const run = store.getRun(runId);
    expect(run?.currentWorkerId).toBe("worker-B");
    expect(run?.leaseId).toBe(claimB.lease.leaseId);
  });

  // -------------------------------------------------------------------------
  // T17: Lease renewal race with expiry
  // -------------------------------------------------------------------------
  it("T17: rejects renewal when clock passes lease expiration timestamp", () => {
    const claimA = coordinator.claimRun(runId, "worker-A", 5000);
    coordinator.startRun(runId, "worker-A", claimA.lease.leaseId);

    // Advance clock past 5000ms
    clock.advanceMs(6000);

    expect(() => {
      coordinator.renewLease(runId, claimA.lease.leaseId, 5000);
    }).toThrow(LeaseExpiredError);
  });

  // -------------------------------------------------------------------------
  // T18: Concurrent completion race
  // -------------------------------------------------------------------------
  it("T18: permits only the authorized leaseholder to complete an attempt", () => {
    const claimA = coordinator.claimRun(runId, "worker-A", 20000);
    coordinator.startRun(runId, "worker-A", claimA.lease.leaseId);

    const actionId = "act-t18";
    const attemptId = "att-t18-1";

    const { action, event: actEvt } = Action.create({
      actionId,
      runId,
      sequenceNumber: 1,
      toolName: "read_file",
      inputPayload: { path: "test.txt" },
      contractBinding: store.getRun(runId)!.contractBinding!,
      maxAttempts: 3,
      now: clock.nowIso(),
    });

    const { attempt, event: attEvt } = Attempt.create({
      attemptId,
      actionId,
      runId,
      attemptNumber: 1,
      workerId: "worker-A",
      leaseId: claimA.lease.leaseId,
      now: clock.nowIso(),
    });

    store.transaction((tx) => {
      tx.insertAction(action.snapshot, actEvt, {
        workerId: "worker-A",
        leaseId: claimA.lease.leaseId,
      });
      tx.transitionAction(actionId, { type: "AUTHORIZE", now: clock.nowIso() }, () => "e1");
      tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 1, now: clock.nowIso() }, () => "e2");
      tx.insertAttempt(attempt.snapshot, attEvt, {
        workerId: "worker-A",
        leaseId: claimA.lease.leaseId,
      });
      tx.transitionAttempt(attemptId, { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
      tx.transitionAttempt(attemptId, { type: "START", now: clock.nowIso() }, () => "e4");
    });

    // Concurrent Worker B attempt to complete must fail
    expect(() => {
      store.transaction((tx) => {
        tx.transitionAttempt(
          attemptId,
          { type: "COMPLETE", outputPayload: { from: "worker-B" }, now: clock.nowIso() },
          () => "e-race-b",
          { workerId: "worker-B", leaseId: "lease-B" }
        );
      });
    }).toThrow(LeaseLostError);

    // Worker A succeeds
    const resA = store.transaction((tx) => {
      return tx.transitionAttempt(
        attemptId,
        { type: "COMPLETE", outputPayload: { from: "worker-A" }, now: clock.nowIso() },
        () => "e-race-a",
        { workerId: "worker-A", leaseId: claimA.lease.leaseId }
      );
    });

    expect(resA.snapshot.status).toBe("SUCCEEDED");
    expect(resA.snapshot.outputPayload).toEqual({ from: "worker-A" });
  });
});
