import { describe, expect, it } from "vitest";
import { InvalidRunError } from "../../src/domain/errors.js";
import { RunSnapshot, validateRunInvariants } from "../../src/domain/invariants.js";

function createValidSnapshot(): RunSnapshot {
  return {
    runId: "run-valid-01",
    taskId: "task-valid-01",
    status: "CREATED",
    version: 1,
    attemptCount: 0,
    maxAttempts: 3,
    timeoutMs: 30000,
    idempotencyKey: "key-01",
    currentWorkerId: null,
    leaseId: null,
    leaseExpiresAt: null,
    resultPayload: null,
    errorPayload: null,
    createdAt: "2026-10-10T12:00:00.000Z",
    updatedAt: "2026-10-10T12:00:00.000Z",
  };
}

describe("Run Invariants", () => {
  it("passes validation for a structurally sound snapshot", () => {
    const snapshot = createValidSnapshot();
    expect(() => validateRunInvariants(snapshot)).not.toThrow();
  });

  describe("Identifier Validation", () => {
    it("rejects empty or whitespace runId", () => {
      const snapshot = { ...createValidSnapshot(), runId: "   " };
      expect(() => validateRunInvariants(snapshot)).toThrow(InvalidRunError);
    });

    it("rejects empty or whitespace taskId", () => {
      const snapshot = { ...createValidSnapshot(), taskId: "" };
      expect(() => validateRunInvariants(snapshot)).toThrow(InvalidRunError);
    });
  });

  describe("Version and Numeric Bounds", () => {
    it("rejects version < 1 or non-integer version", () => {
      expect(() => validateRunInvariants({ ...createValidSnapshot(), version: 0 })).toThrow(
        InvalidRunError
      );
      expect(() => validateRunInvariants({ ...createValidSnapshot(), version: 1.5 })).toThrow(
        InvalidRunError
      );
    });

    it("rejects negative attempt count", () => {
      expect(() => validateRunInvariants({ ...createValidSnapshot(), attemptCount: -1 })).toThrow(
        InvalidRunError
      );
    });

    it("rejects non-positive maxAttempts or timeoutMs", () => {
      expect(() => validateRunInvariants({ ...createValidSnapshot(), maxAttempts: 0 })).toThrow(
        InvalidRunError
      );
      expect(() => validateRunInvariants({ ...createValidSnapshot(), timeoutMs: -100 })).toThrow(
        InvalidRunError
      );
    });
  });

  describe("Lease Consistency for Active and Terminal States", () => {
    it("requires workerId, leaseId, and leaseExpiresAt when status is LEASED or RUNNING", () => {
      const leasedWithoutWorker = {
        ...createValidSnapshot(),
        status: "LEASED" as const,
        currentWorkerId: null,
        leaseId: "l1",
        leaseExpiresAt: "2026-10-10T12:05:00.000Z",
      };
      expect(() => validateRunInvariants(leasedWithoutWorker)).toThrow(InvalidRunError);

      const runningWithoutLease = {
        ...createValidSnapshot(),
        status: "RUNNING" as const,
        currentWorkerId: "w1",
        leaseId: null,
        leaseExpiresAt: "2026-10-10T12:05:00.000Z",
      };
      expect(() => validateRunInvariants(runningWithoutLease)).toThrow(InvalidRunError);
    });

    it("rejects active leaseExpiresAt on terminal state", () => {
      const completedWithActiveLease = {
        ...createValidSnapshot(),
        status: "COMPLETED" as const,
        leaseExpiresAt: "2026-10-10T12:05:00.000Z",
      };
      expect(() => validateRunInvariants(completedWithActiveLease)).toThrow(InvalidRunError);
    });
  });

  describe("Timestamp Ordering", () => {
    it("rejects updatedAt earlier than createdAt", () => {
      const invalidTimestamps = {
        ...createValidSnapshot(),
        createdAt: "2026-10-10T12:05:00.000Z",
        updatedAt: "2026-10-10T12:00:00.000Z",
      };
      expect(() => validateRunInvariants(invalidTimestamps)).toThrow(InvalidRunError);
    });

    it("rejects invalid date strings", () => {
      const badDate = {
        ...createValidSnapshot(),
        createdAt: "not-a-date",
      };
      expect(() => validateRunInvariants(badDate)).toThrow(InvalidRunError);
    });
  });
});
