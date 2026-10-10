import { describe, expect, it } from "vitest";
import { InvalidContractBindingError, InvalidRunError } from "../../src/domain/errors.js";
import {
  ContractBinding,
  createContractBinding,
  RunSnapshot,
  validateRunInvariants,
} from "../../src/domain/invariants.js";

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
    contractBinding: null,
    maxOutputBytes: null,
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

  describe("ContractBinding Invariants", () => {
    const validBinding: ContractBinding = {
      contractId: "contract-test-01",
      version: 1,
      contentHash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    };

    it("accepts a valid ContractBinding and deeply freezes it", () => {
      const binding = createContractBinding(validBinding);
      expect(binding.contractId).toBe("contract-test-01");
      expect(binding.version).toBe(1);
      expect(binding.contentHash).toBe(validBinding.contentHash);
      expect(Object.isFrozen(binding)).toBe(true);
    });

    it("rejects empty or whitespace-only contractId", () => {
      expect(() =>
        createContractBinding({ ...validBinding, contractId: "" })
      ).toThrow(InvalidContractBindingError);
      expect(() =>
        createContractBinding({ ...validBinding, contractId: "   " })
      ).toThrow(InvalidContractBindingError);
    });

    it("rejects zero version", () => {
      expect(() =>
        createContractBinding({ ...validBinding, version: 0 })
      ).toThrow(InvalidContractBindingError);
    });

    it("rejects negative version", () => {
      expect(() =>
        createContractBinding({ ...validBinding, version: -1 })
      ).toThrow(InvalidContractBindingError);
    });

    it("rejects non-integer version", () => {
      expect(() =>
        createContractBinding({ ...validBinding, version: 1.5 })
      ).toThrow(InvalidContractBindingError);
    });

    it("rejects incorrect hash length (not 64 characters)", () => {
      expect(() =>
        createContractBinding({ ...validBinding, contentHash: "a".repeat(63) })
      ).toThrow(InvalidContractBindingError);
      expect(() =>
        createContractBinding({ ...validBinding, contentHash: "a".repeat(65) })
      ).toThrow(InvalidContractBindingError);
    });

    it("rejects uppercase hexadecimal characters in contentHash", () => {
      expect(() =>
        createContractBinding({
          ...validBinding,
          contentHash: "A".repeat(64),
        })
      ).toThrow(InvalidContractBindingError);
      expect(() =>
        createContractBinding({
          ...validBinding,
          contentHash: validBinding.contentHash.toUpperCase(),
        })
      ).toThrow(InvalidContractBindingError);
    });

    it("rejects non-hexadecimal characters in contentHash", () => {
      expect(() =>
        createContractBinding({
          ...validBinding,
          contentHash: "g".repeat(64),
        })
      ).toThrow(InvalidContractBindingError);
    });

    it("guarantees ContractBinding cannot be mutated after creation", () => {
      const binding = createContractBinding(validBinding);
      expect(() => {
        // @ts-expect-error mutating frozen object
        binding.contractId = "tampered";
      }).toThrow();
    });
  });

  describe("Run Governance & Operational Output Limit Invariants", () => {
    const validBinding: ContractBinding = {
      contractId: "contract-test-01",
      version: 1,
      contentHash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    };

    function createGovernedSnapshot(): RunSnapshot {
      return {
        ...createValidSnapshot(),
        contractBinding: validBinding,
        maxOutputBytes: 1048576,
      };
    }

    it("passes validation for a governed Run with valid contractBinding and maxOutputBytes", () => {
      const snapshot = createGovernedSnapshot();
      expect(() => validateRunInvariants(snapshot)).not.toThrow();
    });

    it("accepts maxOutputBytes = 1 for a governed Run", () => {
      const snapshot = { ...createGovernedSnapshot(), maxOutputBytes: 1 };
      expect(() => validateRunInvariants(snapshot)).not.toThrow();
    });

    it("rejects maxOutputBytes = 0 for a governed Run", () => {
      const snapshot = { ...createGovernedSnapshot(), maxOutputBytes: 0 };
      expect(() => validateRunInvariants(snapshot)).toThrow(InvalidRunError);
    });

    it("rejects negative maxOutputBytes for a governed Run", () => {
      const snapshot = { ...createGovernedSnapshot(), maxOutputBytes: -1 };
      expect(() => validateRunInvariants(snapshot)).toThrow(InvalidRunError);
    });

    it("rejects non-integer maxOutputBytes for a governed Run", () => {
      const snapshot = { ...createGovernedSnapshot(), maxOutputBytes: 1024.5 };
      expect(() => validateRunInvariants(snapshot)).toThrow(InvalidRunError);
    });

    it("rejects governed Run with null maxOutputBytes", () => {
      const snapshot = { ...createGovernedSnapshot(), maxOutputBytes: null };
      expect(() => validateRunInvariants(snapshot)).toThrow(InvalidRunError);
    });

    it("rejects legacy unbound Run with non-null maxOutputBytes", () => {
      const snapshot = {
        ...createValidSnapshot(),
        contractBinding: null,
        maxOutputBytes: 1024,
      };
      expect(() => validateRunInvariants(snapshot)).toThrow(InvalidRunError);
    });

    it("rejects governed Run with invalid contractBinding fields via validateRunInvariants", () => {
      const badBindingSnapshot = {
        ...createGovernedSnapshot(),
        contractBinding: {
          ...validBinding,
          contractId: "",
        },
      };
      expect(() => validateRunInvariants(badBindingSnapshot)).toThrow(InvalidRunError);
    });
  });
});
