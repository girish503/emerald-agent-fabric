import { describe, expect, it } from "vitest";
import {
  Attempt,
  AttemptSnapshot,
  applyAttemptTransition,
  createAttemptIdempotencyToken,
  isTerminalAttemptStatus,
  validateAttemptInvariants,
} from "../../src/domain/attempt.js";
import {
  InvalidAttemptError,
  InvalidAttemptTransitionError,
} from "../../src/domain/errors.js";

describe("Attempt Domain Aggregate & State Machine (Task 4.4-B)", () => {
  describe("1. Attempt Construction & Identity", () => {
    it("creates a valid Attempt with default values and deterministic idempotency token", () => {
      const attempt = Attempt.create({
        actionId: "act-101",
        runId: "run-202",
        attemptNumber: 1,
        workerId: "worker-node-1",
        leaseId: "lease-xyz",
      });

      expect(attempt.attemptId).toBeDefined();
      expect(typeof attempt.attemptId).toBe("string");
      expect(attempt.actionId).toBe("act-101");
      expect(attempt.runId).toBe("run-202");
      expect(attempt.attemptNumber).toBe(1);
      expect(attempt.workerId).toBe("worker-node-1");
      expect(attempt.leaseId).toBe("lease-xyz");
      expect(attempt.idempotencyToken).toBe("run-202:act-101:1");
      expect(attempt.status).toBe("CREATED");
      expect(attempt.startedAt).toBeDefined();
      expect(attempt.completedAt).toBeNull();
      expect(attempt.durationMs).toBeNull();
      expect(attempt.exitCode).toBeNull();
      expect(attempt.outputPayload).toBeNull();
      expect(attempt.errorPayload).toBeNull();
      expect(attempt.evidenceIds).toEqual([]);
      expect(attempt.providerMetadata).toBeNull();
    });

    it("accepts custom attemptId and custom idempotencyToken", () => {
      const attempt = Attempt.create({
        attemptId: "att-custom-99",
        actionId: "act-101",
        runId: "run-202",
        attemptNumber: 2,
        workerId: "worker-node-2",
        leaseId: "lease-abc",
        idempotencyToken: "custom-token-xyz",
      });

      expect(attempt.attemptId).toBe("att-custom-99");
      expect(attempt.idempotencyToken).toBe("custom-token-xyz");
      expect(attempt.attemptNumber).toBe(2);
    });

    it("creates deterministic idempotency tokens via createAttemptIdempotencyToken", () => {
      const token1 = createAttemptIdempotencyToken("run-A", "act-1", 1);
      const token2 = createAttemptIdempotencyToken("run-A", "act-1", 2);
      expect(token1).toBe("run-A:act-1:1");
      expect(token2).toBe("run-A:act-1:2");
      expect(token1).not.toBe(token2);
    });

    it("rejects invalid attemptNumber (0, negative, float)", () => {
      expect(() => {
        Attempt.create({
          actionId: "act-101",
          runId: "run-202",
          attemptNumber: 0,
          workerId: "w1",
          leaseId: "l1",
        });
      }).toThrow(InvalidAttemptError);

      expect(() => {
        Attempt.create({
          actionId: "act-101",
          runId: "run-202",
          attemptNumber: -1,
          workerId: "w1",
          leaseId: "l1",
        });
      }).toThrow(InvalidAttemptError);

      expect(() => {
        Attempt.create({
          actionId: "act-101",
          runId: "run-202",
          attemptNumber: 1.2,
          workerId: "w1",
          leaseId: "l1",
        });
      }).toThrow(InvalidAttemptError);
    });

    it("rejects empty actionId, runId, workerId, or leaseId", () => {
      expect(() => {
        Attempt.create({
          actionId: " ",
          runId: "run-1",
          attemptNumber: 1,
          workerId: "w1",
          leaseId: "l1",
        });
      }).toThrow(InvalidAttemptError);

      expect(() => {
        Attempt.create({
          actionId: "act-1",
          runId: "",
          attemptNumber: 1,
          workerId: "w1",
          leaseId: "l1",
        });
      }).toThrow(InvalidAttemptError);

      expect(() => {
        Attempt.create({
          actionId: "act-1",
          runId: "run-1",
          attemptNumber: 1,
          workerId: "",
          leaseId: "l1",
        });
      }).toThrow(InvalidAttemptError);

      expect(() => {
        Attempt.create({
          actionId: "act-1",
          runId: "run-1",
          attemptNumber: 1,
          workerId: "w1",
          leaseId: "  ",
        });
      }).toThrow(InvalidAttemptError);
    });
  });

  describe("2. Immutability of Attempt Snapshot", () => {
    it("ensures attempt snapshot is deeply frozen", () => {
      const attempt = Attempt.create({
        actionId: "act-101",
        runId: "run-202",
        attemptNumber: 1,
        workerId: "w1",
        leaseId: "l1",
      });

      const snap = attempt.snapshot;
      expect(Object.isFrozen(snap)).toBe(true);
      expect(Object.isFrozen(snap.evidenceIds)).toBe(true);

      expect(() => {
        (snap as any).attemptNumber = 99;
      }).toThrow();
    });
  });

  describe("3. Attempt State Machine Transitions", () => {
    it("executes standard happy path: CREATED -> DISPATCHED -> RUNNING -> SUCCEEDED", () => {
      const attempt = Attempt.create({
        actionId: "act-101",
        runId: "run-202",
        attemptNumber: 1,
        workerId: "w1",
        leaseId: "l1",
      });

      expect(attempt.status).toBe("CREATED");

      attempt.dispatch("2026-10-12T10:00:01Z");
      expect(attempt.status).toBe("DISPATCHED");
      expect(attempt.startedAt).toBe("2026-10-12T10:00:01Z");

      attempt.start("2026-10-12T10:00:02Z");
      expect(attempt.status).toBe("RUNNING");

      attempt.complete({
        outputPayload: { stdout: "success" },
        exitCode: 0,
        evidenceIds: ["evi-1", "evi-2"],
        durationMs: 450,
        providerMetadata: { containerId: "c-123" },
        now: "2026-10-12T10:00:03Z",
      });

      expect(attempt.status).toBe("SUCCEEDED");
      expect(attempt.outputPayload).toEqual({ stdout: "success" });
      expect(attempt.exitCode).toBe(0);
      expect(attempt.evidenceIds).toEqual(["evi-1", "evi-2"]);
      expect(attempt.durationMs).toBe(450);
      expect(attempt.providerMetadata).toEqual({ containerId: "c-123" });
      expect(attempt.completedAt).toBe("2026-10-12T10:00:03Z");
      expect(isTerminalAttemptStatus(attempt.status)).toBe(true);
    });

    it("executes quick completion directly from DISPATCHED (synchronous in-memory adapter)", () => {
      const attempt = Attempt.create({
        actionId: "act-101",
        runId: "run-202",
        attemptNumber: 1,
        workerId: "w1",
        leaseId: "l1",
      });

      attempt.dispatch();
      attempt.complete({
        outputPayload: { content: "file data" },
        durationMs: 5,
      });

      expect(attempt.status).toBe("SUCCEEDED");
      expect(attempt.outputPayload).toEqual({ content: "file data" });
      expect(attempt.durationMs).toBe(5);
      expect(attempt.completedAt).toBeDefined();
    });

    it("executes failure from RUNNING with error details and non-zero exit code", () => {
      const attempt = Attempt.create({
        actionId: "act-101",
        runId: "run-202",
        attemptNumber: 1,
        workerId: "w1",
        leaseId: "l1",
      });

      attempt.dispatch();
      attempt.start();
      attempt.fail({
        errorPayload: { message: "Command failed with code 1" },
        exitCode: 1,
        durationMs: 1200,
        now: "2026-10-12T10:00:05Z",
      });

      expect(attempt.status).toBe("FAILED");
      expect(attempt.exitCode).toBe(1);
      expect(attempt.errorPayload).toEqual({ message: "Command failed with code 1" });
      expect(attempt.durationMs).toBe(1200);
      expect(attempt.completedAt).toBe("2026-10-12T10:00:05Z");
      expect(isTerminalAttemptStatus(attempt.status)).toBe(true);
    });

    it("executes timeout transition from RUNNING", () => {
      const attempt = Attempt.create({
        actionId: "act-101",
        runId: "run-202",
        attemptNumber: 1,
        workerId: "w1",
        leaseId: "l1",
      });

      attempt.dispatch();
      attempt.start();
      attempt.timeout({
        errorPayload: "Exceeded 5000ms deadline",
        durationMs: 5001,
      });

      expect(attempt.status).toBe("TIMED_OUT");
      expect(attempt.errorPayload).toBe("Exceeded 5000ms deadline");
      expect(attempt.durationMs).toBe(5001);
      expect(attempt.completedAt).toBeDefined();
    });

    it("executes cancellation from CREATED, DISPATCHED, or RUNNING", () => {
      const att1 = Attempt.create({
        actionId: "act-1",
        runId: "run-1",
        attemptNumber: 1,
        workerId: "w1",
        leaseId: "l1",
      });
      att1.cancel({ reason: "Aborted before dispatch" });
      expect(att1.status).toBe("CANCELLED");
      expect(att1.errorPayload).toBe("Aborted before dispatch");

      const att2 = Attempt.create({
        actionId: "act-2",
        runId: "run-1",
        attemptNumber: 1,
        workerId: "w1",
        leaseId: "l1",
      });
      att2.dispatch();
      att2.cancel({ reason: "Aborted while dispatched" });
      expect(att2.status).toBe("CANCELLED");

      const att3 = Attempt.create({
        actionId: "act-3",
        runId: "run-1",
        attemptNumber: 1,
        workerId: "w1",
        leaseId: "l1",
      });
      att3.dispatch();
      att3.start();
      att3.cancel({ reason: "Aborted while running" });
      expect(att3.status).toBe("CANCELLED");
    });
  });

  describe("4. Critical UNKNOWN State & Crash Semantics", () => {
    it("transitions from DISPATCHED to UNKNOWN when marked by crash sweeper", () => {
      const attempt = Attempt.create({
        actionId: "act-101",
        runId: "run-202",
        attemptNumber: 1,
        workerId: "w1",
        leaseId: "l1",
      });

      attempt.dispatch();
      attempt.markUnknown({
        reason: "Worker lease expired while attempt was dispatched",
        now: "2026-10-12T10:05:00Z",
      });

      expect(attempt.status).toBe("UNKNOWN");
      expect(attempt.errorPayload).toEqual({
        code: "EXECUTION_UNCERTAIN",
        reason: "Worker lease expired while attempt was dispatched",
      });
      expect(attempt.completedAt).toBe("2026-10-12T10:05:00Z");
      expect(isTerminalAttemptStatus(attempt.status)).toBe(true);
    });

    it("transitions from RUNNING to UNKNOWN when worker crashes mid-execution", () => {
      const attempt = Attempt.create({
        actionId: "act-101",
        runId: "run-202",
        attemptNumber: 1,
        workerId: "w1",
        leaseId: "l1",
      });

      attempt.dispatch();
      attempt.start();
      attempt.markUnknown({
        reason: "Worker process heartbeat lost mid-execution",
      });

      expect(attempt.status).toBe("UNKNOWN");
      expect(isTerminalAttemptStatus(attempt.status)).toBe(true);
    });

    it("strictly prohibits resuming or transitioning an UNKNOWN attempt to any state", () => {
      const attempt = Attempt.create({
        actionId: "act-101",
        runId: "run-202",
        attemptNumber: 1,
        workerId: "w1",
        leaseId: "l1",
      });

      attempt.dispatch();
      attempt.start();
      attempt.markUnknown({ reason: "Crash" });

      // UNKNOWN is permanently terminal; cannot resume or guess outcome
      expect(() => attempt.start()).toThrow(InvalidAttemptTransitionError);
      expect(() => attempt.complete()).toThrow(InvalidAttemptTransitionError);
      expect(() => attempt.fail({ errorPayload: "err" })).toThrow(InvalidAttemptTransitionError);
      expect(() => attempt.dispatch()).toThrow(InvalidAttemptTransitionError);
      expect(() => attempt.timeout()).toThrow(InvalidAttemptTransitionError);
      expect(() => attempt.cancel()).toThrow(InvalidAttemptTransitionError);
      expect(() => attempt.markUnknown({ reason: "repeat" })).toThrow(InvalidAttemptTransitionError);
    });

    it("prohibits transitions from all terminal states", () => {
      const attempt = Attempt.create({
        actionId: "act-101",
        runId: "run-202",
        attemptNumber: 1,
        workerId: "w1",
        leaseId: "l1",
      });

      attempt.dispatch();
      attempt.complete({ outputPayload: "ok" });

      expect(() => attempt.start()).toThrow(InvalidAttemptTransitionError);
      expect(() => attempt.dispatch()).toThrow(InvalidAttemptTransitionError);
      expect(() => attempt.complete()).toThrow(InvalidAttemptTransitionError);
      expect(() => attempt.fail({ errorPayload: "err" })).toThrow(InvalidAttemptTransitionError);
    });
  });

  describe("5. Reconstitution", () => {
    it("reconstitutes an Attempt accurately from a valid snapshot", () => {
      const original = Attempt.create({
        attemptId: "att-orig-1",
        actionId: "act-1",
        runId: "run-1",
        attemptNumber: 2,
        workerId: "worker-A",
        leaseId: "lease-B",
      });
      original.dispatch();
      original.start();

      const reconstituted = Attempt.reconstitute(original.snapshot);
      expect(reconstituted.attemptId).toBe("att-orig-1");
      expect(reconstituted.attemptNumber).toBe(2);
      expect(reconstituted.workerId).toBe("worker-A");
      expect(reconstituted.leaseId).toBe("lease-B");
      expect(reconstituted.status).toBe("RUNNING");
      expect(reconstituted.snapshot).toEqual(original.snapshot);
    });

    it("fails reconstitution if snapshot violates invariants", () => {
      const corruptedSnapshot: AttemptSnapshot = {
        attemptId: "att-bad",
        actionId: "act-1",
        runId: "run-1",
        attemptNumber: 0, // Invalid: must be >= 1
        workerId: "w1",
        leaseId: "l1",
        idempotencyToken: "token",
        status: "CREATED",
        startedAt: "2026-10-12T00:00:00Z",
        completedAt: null,
        durationMs: null,
        exitCode: null,
        outputPayload: null,
        errorPayload: null,
        evidenceIds: [],
        providerMetadata: null,
      };

      expect(() => Attempt.reconstitute(corruptedSnapshot)).toThrow(InvalidAttemptError);
    });

    it("directly invokes validateAttemptInvariants and applyAttemptTransition", () => {
      const attempt = Attempt.create({
        actionId: "act-1",
        runId: "run-1",
        attemptNumber: 1,
        workerId: "w1",
        leaseId: "l1",
      });

      // validateAttemptInvariants should pass without error
      expect(() => validateAttemptInvariants(attempt.snapshot)).not.toThrow();

      // applyAttemptTransition should transition purely without mutating original
      const dispatchedSnapshot = applyAttemptTransition(attempt.snapshot, {
        type: "DISPATCH",
        now: "2026-10-12T10:00:00Z",
      });
      expect(dispatchedSnapshot.status).toBe("DISPATCHED");
      expect(attempt.status).toBe("CREATED");
    });
  });
});
