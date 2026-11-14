import { describe, expect, it } from "vitest";
import {
  InvalidStateTransitionError,
  LeaseLostError,
  TerminalStateError,
} from "../../src/domain/errors.js";
import { RunSnapshot, RunStatus, TERMINAL_STATES } from "../../src/domain/invariants.js";
import {
  applyTransition,
  canTransition,
  RunCommand,
} from "../../src/domain/state-machine.js";

function createMockSnapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "run-001",
    taskId: "task-001",
    status: "CREATED",
    version: 1,
    attemptCount: 0,
    maxAttempts: 3,
    timeoutMs: 30000,
    idempotencyKey: "idem-001",
    currentWorkerId: null,
    leaseId: null,
    leaseExpiresAt: null,
    resultPayload: null,
    errorPayload: null,
    createdAt: "2026-10-10T12:00:00.000Z",
    updatedAt: "2026-10-10T12:00:00.000Z",
    ...overrides,
  };
}

describe("RunStateMachine", () => {
  const now = "2026-10-10T12:01:00.000Z";

  describe("Valid Transition Flow (Happy Path)", () => {
    it("progresses sequentially: CREATED -> QUEUED -> LEASED -> RUNNING -> COMPLETED", () => {
      let snapshot = createMockSnapshot();
      expect(snapshot.status).toBe("CREATED");
      expect(snapshot.version).toBe(1);

      // CREATED -> QUEUED
      const queueRes = applyTransition(snapshot, { type: "QUEUE", now });
      expect(queueRes.nextSnapshot.status).toBe("QUEUED");
      expect(queueRes.nextSnapshot.version).toBe(2);
      expect(queueRes.event.eventType).toBe("run.queued");
      snapshot = queueRes.nextSnapshot;

      // QUEUED -> LEASED
      const leaseRes = applyTransition(snapshot, {
        type: "CLAIM",
        workerId: "worker-1",
        leaseId: "lease-101",
        leaseExpiresAt: "2026-10-10T12:05:00.000Z",
        now,
      });
      expect(leaseRes.nextSnapshot.status).toBe("LEASED");
      expect(leaseRes.nextSnapshot.version).toBe(3);
      expect(leaseRes.nextSnapshot.currentWorkerId).toBe("worker-1");
      expect(leaseRes.nextSnapshot.leaseId).toBe("lease-101");
      expect(leaseRes.event.eventType).toBe("worker.claimed");
      snapshot = leaseRes.nextSnapshot;

      // LEASED -> RUNNING
      const startRes = applyTransition(snapshot, {
        type: "START",
        workerId: "worker-1",
        leaseId: "lease-101",
        now,
      });
      expect(startRes.nextSnapshot.status).toBe("RUNNING");
      expect(startRes.nextSnapshot.version).toBe(4);
      expect(startRes.event.eventType).toBe("run.started");
      snapshot = startRes.nextSnapshot;

      // RUNNING -> COMPLETED
      const completeRes = applyTransition(snapshot, {
        type: "COMPLETE",
        workerId: "worker-1",
        leaseId: "lease-101",
        result: { value: 42 },
        now,
      });
      expect(completeRes.nextSnapshot.status).toBe("COMPLETED");
      expect(completeRes.nextSnapshot.version).toBe(5);
      expect(completeRes.nextSnapshot.resultPayload).toEqual({ value: 42 });
      expect(completeRes.nextSnapshot.leaseExpiresAt).toBeNull();
      expect(completeRes.event.eventType).toBe("run.completed");
    });
  });

  describe("Failure, Timeout, and Cancellation Transitions", () => {
    it("transitions from RUNNING to FAILED", () => {
      const snapshot = createMockSnapshot({
        status: "RUNNING",
        version: 5,
        currentWorkerId: "worker-1",
        leaseId: "lease-1",
        leaseExpiresAt: "2026-10-10T12:05:00.000Z",
      });

      const res = applyTransition(snapshot, {
        type: "FAIL",
        workerId: "worker-1",
        leaseId: "lease-1",
        error: { code: "TEST_ERROR", message: "Failed deliberately" },
        now,
      });

      expect(res.nextSnapshot.status).toBe("FAILED");
      expect(res.nextSnapshot.version).toBe(6);
      expect(res.nextSnapshot.errorPayload).toEqual({ code: "TEST_ERROR", message: "Failed deliberately" });
      expect(res.event.eventType).toBe("run.failed");
    });

    it("transitions from RUNNING to TIMED_OUT", () => {
      const snapshot = createMockSnapshot({
        status: "RUNNING",
        version: 4,
        currentWorkerId: "worker-1",
        leaseId: "lease-1",
        leaseExpiresAt: "2026-10-10T12:05:00.000Z",
      });

      const res = applyTransition(snapshot, {
        type: "TIMEOUT",
        reason: "Wall-clock time limit exceeded",
        now,
      });

      expect(res.nextSnapshot.status).toBe("TIMED_OUT");
      expect(res.nextSnapshot.version).toBe(5);
      expect(res.event.eventType).toBe("run.timed_out");
    });

    it("transitions from RUNNING to CANCELLED", () => {
      const snapshot = createMockSnapshot({
        status: "RUNNING",
        version: 4,
        currentWorkerId: "worker-1",
        leaseId: "lease-1",
        leaseExpiresAt: "2026-10-10T12:05:00.000Z",
      });

      const res = applyTransition(snapshot, {
        type: "CANCEL",
        reason: "Supervisor aborted",
        now,
      });

      expect(res.nextSnapshot.status).toBe("CANCELLED");
      expect(res.nextSnapshot.version).toBe(5);
      expect(res.event.eventType).toBe("run.cancelled");
    });
  });

  describe("Recovery and Retry Transitions", () => {
    it("recovers from expired lease: RUNNING -> RECOVERING -> QUEUED (retry)", () => {
      const snapshot = createMockSnapshot({
        status: "RUNNING",
        version: 4,
        attemptCount: 1,
        maxAttempts: 3,
        currentWorkerId: "worker-1",
        leaseId: "lease-1",
        leaseExpiresAt: "2026-10-10T12:02:00.000Z",
      });

      // Lease expires
      const expireRes = applyTransition(snapshot, { type: "EXPIRE_LEASE", now });
      expect(expireRes.nextSnapshot.status).toBe("RECOVERING");
      expect(expireRes.nextSnapshot.version).toBe(5);
      expect(expireRes.event.eventType).toBe("lease.expired");

      // Supervisor retries run
      const retryRes = applyTransition(expireRes.nextSnapshot, { type: "RETRY", now });
      expect(retryRes.nextSnapshot.status).toBe("QUEUED");
      expect(retryRes.nextSnapshot.version).toBe(6);
      expect(retryRes.nextSnapshot.attemptCount).toBe(2);
      expect(retryRes.nextSnapshot.currentWorkerId).toBeNull();
      expect(retryRes.nextSnapshot.leaseId).toBeNull();
      expect(retryRes.event.eventType).toBe("run.recovered");
    });

    it("transitions RECOVERING -> FAILED when retries are exhausted", () => {
      const snapshot = createMockSnapshot({
        status: "RECOVERING",
        version: 8,
        attemptCount: 3,
        maxAttempts: 3,
      });

      // Attempting RETRY when attempts reached maxAttempts must throw InvalidStateTransitionError
      expect(() => applyTransition(snapshot, { type: "RETRY", now })).toThrow(
        InvalidStateTransitionError
      );

      // Supervisor marks run FAIL_EXHAUSTED
      const failRes = applyTransition(snapshot, { type: "FAIL_EXHAUSTED", now });
      expect(failRes.nextSnapshot.status).toBe("FAILED");
      expect(failRes.nextSnapshot.version).toBe(9);
      expect(failRes.event.eventType).toBe("run.failed");
    });
  });

  describe("Fencing Token Checks (Stale Worker Prevention)", () => {
    it("rejects START if workerId or leaseId does not match active lease", () => {
      const snapshot = createMockSnapshot({
        status: "LEASED",
        version: 3,
        currentWorkerId: "worker-1",
        leaseId: "lease-current",
        leaseExpiresAt: "2026-10-10T12:05:00.000Z",
      });

      // Stale leaseId
      expect(() =>
        applyTransition(snapshot, {
          type: "START",
          workerId: "worker-1",
          leaseId: "lease-stale",
          now,
        })
      ).toThrow(LeaseLostError);

      // Wrong workerId
      expect(() =>
        applyTransition(snapshot, {
          type: "START",
          workerId: "worker-impostor",
          leaseId: "lease-current",
          now,
        })
      ).toThrow(LeaseLostError);
    });

    it("rejects COMPLETE if worker presents stale leaseId after recovery", () => {
      const snapshot = createMockSnapshot({
        status: "RUNNING",
        version: 5,
        currentWorkerId: "worker-2",
        leaseId: "lease-new",
        leaseExpiresAt: "2026-10-10T12:05:00.000Z",
      });

      expect(() =>
        applyTransition(snapshot, {
          type: "COMPLETE",
          workerId: "worker-1",
          leaseId: "lease-old",
          result: { done: true },
          now,
        })
      ).toThrow(LeaseLostError);
    });
  });

  describe("Invalid Transitions & Terminal State Immutability", () => {
    const invalidTransitions: Array<{ from: RunStatus; command: RunCommand; name: string }> = [
      { from: "CREATED", command: { type: "START", workerId: "w", leaseId: "l", now }, name: "CREATED -> START" },
      { from: "CREATED", command: { type: "COMPLETE", workerId: "w", leaseId: "l", result: {}, now }, name: "CREATED -> COMPLETE" },
      { from: "QUEUED", command: { type: "START", workerId: "w", leaseId: "l", now }, name: "QUEUED -> START (without lease)" },
      { from: "QUEUED", command: { type: "COMPLETE", workerId: "w", leaseId: "l", result: {}, now }, name: "QUEUED -> COMPLETE" },
      { from: "LEASED", command: { type: "COMPLETE", workerId: "w", leaseId: "l", result: {}, now }, name: "LEASED -> COMPLETE (without running)" },
    ];

    it.each(invalidTransitions)("rejects illegal transition: $name", ({ from, command }) => {
      const snapshot = createMockSnapshot({
        status: from,
        currentWorkerId: from === "LEASED" ? "w" : null,
        leaseId: from === "LEASED" ? "l" : null,
        leaseExpiresAt: from === "LEASED" ? "2026-10-10T12:05:00.000Z" : null,
      });

      expect(canTransition(from, command)).toBe(false);
      expect(() => applyTransition(snapshot, command)).toThrow(InvalidStateTransitionError);
    });

    it("ensures all terminal states reject any subsequent command", () => {
      const allCommands: RunCommand[] = [
        { type: "QUEUE", now },
        { type: "CLAIM", workerId: "w", leaseId: "l", leaseExpiresAt: now, now },
        { type: "START", workerId: "w", leaseId: "l", now },
        { type: "COMPLETE", workerId: "w", leaseId: "l", result: {}, now },
        { type: "FAIL", error: {}, now },
        { type: "TIMEOUT", now },
        { type: "CANCEL", now },
        { type: "EXPIRE_LEASE", now },
        { type: "RETRY", now },
        { type: "FAIL_EXHAUSTED", now },
        { type: "START_VERIFICATION", workerId: "w", leaseId: "l", now },
        { type: "REQUEST_APPROVAL", approvalId: "a", operation: "run_command", workerId: "w", leaseId: "l", now },
        { type: "APPROVE_RESUME", approvalId: "a", approver: "op", now },
        { type: "REJECT_APPROVAL", approvalId: "a", approver: "op", reason: "no", now },
      ];

      for (const terminal of TERMINAL_STATES) {
        const snapshot = createMockSnapshot({ status: terminal, version: 10 });
        for (const cmd of allCommands) {
          expect(canTransition(terminal, cmd)).toBe(false);
          expect(() => applyTransition(snapshot, cmd)).toThrow(TerminalStateError);
        }
      }
    });
  });

  describe("Version Monotonicity Property", () => {
    it("strictly advances version by exactly 1 on every successful transition", () => {
      const initialVersion = 17;
      const snapshot = createMockSnapshot({
        status: "CREATED",
        version: initialVersion,
      });

      const res = applyTransition(snapshot, { type: "QUEUE", now });
      expect(res.nextSnapshot.version).toBe(initialVersion + 1);
    });
  });

  describe("VERIFYING & WAITING_APPROVAL Transitions (M4.1)", () => {
    it("transitions RUNNING -> VERIFYING -> COMPLETED with active worker fencing", () => {
      const running = createMockSnapshot({
        status: "RUNNING",
        version: 4,
        currentWorkerId: "worker-1",
        leaseId: "lease-1",
        leaseExpiresAt: "2026-10-10T12:05:00.000Z",
      });
      const ver = applyTransition(running, { type: "START_VERIFICATION", workerId: "worker-1", leaseId: "lease-1", now });
      expect(ver.nextSnapshot.status).toBe("VERIFYING");
      expect(ver.nextSnapshot.version).toBe(5);
      expect(ver.event.eventType).toBe("verification.started");

      // Stale worker blocked during VERIFYING
      expect(() => applyTransition(ver.nextSnapshot, { type: "COMPLETE", workerId: "worker-2", leaseId: "lease-old", result: {}, now })).toThrow(LeaseLostError);

      const done = applyTransition(ver.nextSnapshot, { type: "COMPLETE", workerId: "worker-1", leaseId: "lease-1", result: { passed: true }, now });
      expect(done.nextSnapshot.status).toBe("COMPLETED");
      expect(done.nextSnapshot.version).toBe(6);
    });

    it("supports VERIFYING lease expiry recovery to RECOVERING", () => {
      const verifying = createMockSnapshot({
        status: "VERIFYING",
        version: 5,
        currentWorkerId: "worker-1",
        leaseId: "lease-1",
        leaseExpiresAt: "2026-10-10T12:05:00.000Z",
      });
      expect(canTransition("VERIFYING", { type: "EXPIRE_LEASE", now })).toBe(true);
      const exp = applyTransition(verifying, { type: "EXPIRE_LEASE", now });
      expect(exp.nextSnapshot.status).toBe("RECOVERING");
    });

    it("transitions RUNNING -> WAITING_APPROVAL -> QUEUED (approve) and WAITING_APPROVAL -> FAILED (reject) or CANCELLED", () => {
      const running = createMockSnapshot({
        status: "RUNNING",
        version: 4,
        currentWorkerId: "worker-1",
        leaseId: "lease-1",
        leaseExpiresAt: "2026-10-10T12:05:00.000Z",
      });
      const wait = applyTransition(running, {
        type: "REQUEST_APPROVAL",
        approvalId: "appr-1",
        operation: "run_command",
        workerId: "worker-1",
        leaseId: "lease-1",
        now,
      });
      expect(wait.nextSnapshot.status).toBe("WAITING_APPROVAL");
      expect(wait.nextSnapshot.leaseExpiresAt).toBeNull();
      expect(wait.event.eventType).toBe("run.waiting_approval");

      // Illegal to COMPLETE or START directly from WAITING_APPROVAL
      expect(canTransition("WAITING_APPROVAL", { type: "COMPLETE", workerId: "worker-1", leaseId: "lease-1", result: {}, now })).toBe(false);
      expect(canTransition("WAITING_APPROVAL", { type: "START", workerId: "worker-1", leaseId: "lease-1", now })).toBe(false);

      const resumed = applyTransition(wait.nextSnapshot, { type: "APPROVE_RESUME", approvalId: "appr-1", approver: "op-alice", now });
      expect(resumed.nextSnapshot.status).toBe("QUEUED");

      const rejected = applyTransition(wait.nextSnapshot, { type: "REJECT_APPROVAL", approvalId: "appr-1", approver: "op-bob", reason: "unsafe", now });
      expect(rejected.nextSnapshot.status).toBe("FAILED");

      const cancelled = applyTransition(wait.nextSnapshot, { type: "CANCEL", reason: "operator cancelled", now });
      expect(cancelled.nextSnapshot.status).toBe("CANCELLED");
    });
  });
});
