import { describe, expect, it } from "vitest";
import {
  Action,
  ActionSnapshot,
  applyActionTransition,
  evaluateRetryEligibility,
  isTerminalActionStatus,
  validateActionInvariants,
} from "../../src/domain/action.js";
import { computeCanonicalHash } from "../../src/domain/canonical-hash.js";
import {
  InvalidActionError,
  InvalidActionTransitionError,
} from "../../src/domain/errors.js";
import { ContractBinding } from "../../src/domain/invariants.js";

describe("Action Domain Aggregate & State Machine (Task 4.4-B)", () => {
  const sampleBinding: ContractBinding = Object.freeze({
    contractId: "contract-123",
    version: 1,
    contentHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  });

  const samplePayload = Object.freeze({ path: "src/index.ts", lines: [1, 10] });
  const samplePayloadHash = computeCanonicalHash(samplePayload).contentHash;

  describe("1. Action Construction & Invariants", () => {
    it("creates a valid Action with computed canonical hash and default values", () => {
      const { action, event } = Action.create({
        runId: "run-001",
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: samplePayload,
        contractBinding: sampleBinding,
      });

      expect(action.actionId).toBeDefined();
      expect(typeof action.actionId).toBe("string");
      expect(action.runId).toBe("run-001");
      expect(action.sequenceNumber).toBe(1);
      expect(action.toolName).toBe("read_file");
      expect(action.idempotency).toBe("IDEMPOTENT");
      expect(action.inputHash).toBe(samplePayloadHash);
      expect(action.contractBinding).toEqual(sampleBinding);
      expect(action.status).toBe("CREATED");
      expect(action.maxAttempts).toBe(3);
      expect(action.totalAttempts).toBe(0);
      expect(action.activeAttemptNumber).toBeNull();
      expect(action.resultPayload).toBeNull();
      expect(action.errorPayload).toBeNull();
      expect(action.completedAt).toBeNull();
      expect(action.createdAt).toBeDefined();
      expect(action.updatedAt).toBe(action.createdAt);

      expect(event.eventType).toBe("action.created");
      expect(event.runId).toBe("run-001");
      expect(event.payload.toolName).toBe("read_file");
      expect(event.payload.inputHash).toBe(samplePayloadHash);
    });

    it("accepts an explicit matching inputHash", () => {
      const { action } = Action.create({
        actionId: "act-custom-id",
        runId: "run-001",
        sequenceNumber: 2,
        toolName: "write_file",
        inputPayload: { path: "hello.txt", content: "world" },
        inputHash: computeCanonicalHash({ path: "hello.txt", content: "world" }).contentHash,
        contractBinding: sampleBinding,
        maxAttempts: 5,
      });

      expect(action.actionId).toBe("act-custom-id");
      expect(action.toolName).toBe("write_file");
      expect(action.idempotency).toBe("NON_IDEMPOTENT");
      expect(action.maxAttempts).toBe(5);
    });

    it("rejects mismatched inputHash", () => {
      expect(() => {
        Action.create({
          runId: "run-001",
          sequenceNumber: 1,
          toolName: "read_file",
          inputPayload: samplePayload,
          inputHash: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          contractBinding: sampleBinding,
        });
      }).toThrow(InvalidActionError);
    });

    it("rejects invalid sequenceNumber (0, negative, non-integer)", () => {
      expect(() => {
        Action.create({
          runId: "run-001",
          sequenceNumber: 0,
          toolName: "read_file",
          inputPayload: samplePayload,
          contractBinding: sampleBinding,
        });
      }).toThrow(InvalidActionError);

      expect(() => {
        Action.create({
          runId: "run-001",
          sequenceNumber: -1,
          toolName: "read_file",
          inputPayload: samplePayload,
          contractBinding: sampleBinding,
        });
      }).toThrow(InvalidActionError);

      expect(() => {
        Action.create({
          runId: "run-001",
          sequenceNumber: 1.5,
          toolName: "read_file",
          inputPayload: samplePayload,
          contractBinding: sampleBinding,
        });
      }).toThrow(InvalidActionError);
    });

    it("rejects empty runId", () => {
      expect(() => {
        Action.create({
          runId: "   ",
          sequenceNumber: 1,
          toolName: "read_file",
          inputPayload: samplePayload,
          contractBinding: sampleBinding,
        });
      }).toThrow(InvalidActionError);
    });

    it("rejects unknown toolName", () => {
      expect(() => {
        Action.create({
          runId: "run-001",
          sequenceNumber: 1,
          toolName: "arbitrary_nonexistent_tool" as any,
          inputPayload: samplePayload,
          contractBinding: sampleBinding,
        });
      }).toThrow(InvalidActionError);
    });

    it("rejects invalid contractBinding", () => {
      expect(() => {
        Action.create({
          runId: "run-001",
          sequenceNumber: 1,
          toolName: "read_file",
          inputPayload: samplePayload,
          contractBinding: {
            contractId: "",
            version: 0,
            contentHash: "short",
          },
        });
      }).toThrow();
    });

    it("rejects invalid maxAttempts (0, negative)", () => {
      expect(() => {
        Action.create({
          runId: "run-001",
          sequenceNumber: 1,
          toolName: "read_file",
          inputPayload: samplePayload,
          contractBinding: sampleBinding,
          maxAttempts: 0,
        });
      }).toThrow(InvalidActionError);
    });
  });

  describe("2. Immutability of Intent & Snapshot", () => {
    it("ensures snapshot and its objects are deeply frozen", () => {
      const { action } = Action.create({
        runId: "run-001",
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: { a: 1, nested: { b: 2 } },
        contractBinding: sampleBinding,
      });

      const snap = action.snapshot;
      expect(Object.isFrozen(snap)).toBe(true);
      expect(Object.isFrozen(snap.contractBinding)).toBe(true);

      // In strict mode, modifying frozen object throws
      expect(() => {
        (snap as any).sequenceNumber = 999;
      }).toThrow();
    });

    it("retains immutable intent across state transitions", () => {
      const { action } = Action.create({
        actionId: "act-immutable-1",
        runId: "run-001",
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: samplePayload,
        contractBinding: sampleBinding,
      });

      const initialHash = action.inputHash;
      action.authorize();
      expect(action.status).toBe("AUTHORIZED");
      expect(action.actionId).toBe("act-immutable-1");
      expect(action.sequenceNumber).toBe(1);
      expect(action.inputHash).toBe(initialHash);
      expect(action.toolName).toBe("read_file");

      action.startAttempt(1);
      expect(action.status).toBe("RUNNING");
      expect(action.activeAttemptNumber).toBe(1);
      expect(action.totalAttempts).toBe(1);

      action.succeed({ content: "hello" });
      expect(action.status).toBe("SUCCEEDED");
      expect(action.actionId).toBe("act-immutable-1");
      expect(action.sequenceNumber).toBe(1);
      expect(action.inputHash).toBe(initialHash);
    });
  });

  describe("3. Deterministic State Machine Transitions", () => {
    it("executes standard happy-path lifecycle: CREATED -> AUTHORIZED -> RUNNING -> SUCCEEDED", () => {
      const { action } = Action.create({
        runId: "run-001",
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: samplePayload,
        contractBinding: sampleBinding,
      });

      action.authorize("2026-10-12T10:00:01Z");
      expect(action.status).toBe("AUTHORIZED");
      expect(action.updatedAt).toBe("2026-10-12T10:00:01Z");

      action.startAttempt(1, "2026-10-12T10:00:02Z");
      expect(action.status).toBe("RUNNING");
      expect(action.activeAttemptNumber).toBe(1);
      expect(action.totalAttempts).toBe(1);
      expect(action.updatedAt).toBe("2026-10-12T10:00:02Z");

      action.succeed({ linesRead: 10 }, "2026-10-12T10:00:03Z");
      expect(action.status).toBe("SUCCEEDED");
      expect(action.resultPayload).toEqual({ linesRead: 10 });
      expect(action.activeAttemptNumber).toBeNull();
      expect(action.completedAt).toBe("2026-10-12T10:00:03Z");
      expect(isTerminalActionStatus(action.status)).toBe(true);
    });

    it("executes failure transition from CREATED", () => {
      const { action } = Action.create({
        runId: "run-001",
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: samplePayload,
        contractBinding: sampleBinding,
      });

      action.fail({ code: "POLICY_DENIED", message: "Capability not granted" }, "2026-10-12T10:00:01Z");
      expect(action.status).toBe("FAILED");
      expect(action.errorPayload).toEqual({ code: "POLICY_DENIED", message: "Capability not granted" });
      expect(action.completedAt).toBe("2026-10-12T10:00:01Z");
    });

    it("executes cancellation from CREATED or AUTHORIZED", () => {
      const { action: action1 } = Action.create({
        runId: "run-001",
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: samplePayload,
        contractBinding: sampleBinding,
      });
      action1.cancel("User cancelled");
      expect(action1.status).toBe("CANCELLED");
      expect(action1.errorPayload).toBe("User cancelled");

      const { action: action2 } = Action.create({
        runId: "run-001",
        sequenceNumber: 2,
        toolName: "read_file",
        inputPayload: samplePayload,
        contractBinding: sampleBinding,
      });
      action2.authorize();
      action2.cancel("Run aborted");
      expect(action2.status).toBe("CANCELLED");
    });

    it("executes timeout from RUNNING", () => {
      const { action } = Action.create({
        runId: "run-001",
        sequenceNumber: 1,
        toolName: "run_command",
        inputPayload: { argv: ["sleep", "100"] },
        contractBinding: sampleBinding,
      });

      action.authorize();
      action.startAttempt(1);
      action.timeout("Command exceeded 10000ms");
      expect(action.status).toBe("TIMED_OUT");
      expect(action.errorPayload).toBe("Command exceeded 10000ms");
      expect(action.activeAttemptNumber).toBeNull();
      expect(action.completedAt).toBeDefined();
    });

    it("executes retry loop: RUNNING -> RETRYING -> RUNNING -> SUCCEEDED", () => {
      const { action } = Action.create({
        runId: "run-001",
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: samplePayload,
        contractBinding: sampleBinding,
        maxAttempts: 3,
      });

      action.authorize();
      action.startAttempt(1);
      expect(action.status).toBe("RUNNING");
      expect(action.activeAttemptNumber).toBe(1);
      expect(action.totalAttempts).toBe(1);

      // Attempt 1 failed, prepare retry
      action.prepareRetry({ error: "Transient lock conflict" });
      expect(action.status).toBe("RETRYING");
      expect(action.activeAttemptNumber).toBeNull();
      expect(action.totalAttempts).toBe(1);
      expect(action.errorPayload).toEqual({ error: "Transient lock conflict" });

      // Start Attempt 2
      action.startAttempt(2);
      expect(action.status).toBe("RUNNING");
      expect(action.activeAttemptNumber).toBe(2);
      expect(action.totalAttempts).toBe(2);

      // Attempt 2 succeeds
      action.succeed({ content: "read successfully" });
      expect(action.status).toBe("SUCCEEDED");
      expect(action.totalAttempts).toBe(2);
    });

    it("rejects preparing retry when maxAttempts ceiling is already reached", () => {
      const { action } = Action.create({
        runId: "run-001",
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: samplePayload,
        contractBinding: sampleBinding,
        maxAttempts: 1,
      });

      action.authorize();
      action.startAttempt(1);
      expect(() => {
        action.prepareRetry();
      }).toThrow(InvalidActionTransitionError);
    });

    it("rejects starting attempt with invalid attempt number from AUTHORIZED or RETRYING", () => {
      const { action } = Action.create({
        runId: "run-001",
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: samplePayload,
        contractBinding: sampleBinding,
      });

      action.authorize();
      // From AUTHORIZED, attemptNumber must be 1
      expect(() => {
        action.startAttempt(2);
      }).toThrow(InvalidActionTransitionError);

      action.startAttempt(1);
      action.prepareRetry();

      // From RETRYING with totalAttempts=1, next attemptNumber must be 2
      expect(() => {
        action.startAttempt(1);
      }).toThrow(InvalidActionTransitionError);

      expect(() => {
        action.startAttempt(3);
      }).toThrow(InvalidActionTransitionError);
    });

    it("prohibits any transitions from terminal states", () => {
      const { action } = Action.create({
        runId: "run-001",
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: samplePayload,
        contractBinding: sampleBinding,
      });

      action.authorize();
      action.startAttempt(1);
      action.succeed("result");

      expect(() => action.authorize()).toThrow(InvalidActionTransitionError);
      expect(() => action.startAttempt(2)).toThrow(InvalidActionTransitionError);
      expect(() => action.fail("error")).toThrow(InvalidActionTransitionError);
      expect(() => action.timeout("timeout")).toThrow(InvalidActionTransitionError);
      expect(() => action.cancel("cancel")).toThrow(InvalidActionTransitionError);
      expect(() => action.prepareRetry()).toThrow(InvalidActionTransitionError);
    });
  });

  describe("4. Retry Eligibility Semantics (evaluateRetryEligibility)", () => {
    it("evaluates IDEMPOTENT + FAILED as eligible when attempts remain", () => {
      const { action } = Action.create({
        runId: "run-001",
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: samplePayload,
        contractBinding: sampleBinding,
        maxAttempts: 3,
      });
      action.authorize();
      action.startAttempt(1);
      action.prepareRetry();

      const result = evaluateRetryEligibility(action.snapshot, { status: "FAILED" });
      expect(result.eligible).toBe(true);
      expect(result.reasonCode).toBe("ELIGIBLE");
    });

    it("evaluates IDEMPOTENT + UNKNOWN as eligible when attempts remain", () => {
      const { action } = Action.create({
        runId: "run-001",
        sequenceNumber: 1,
        toolName: "search_code",
        inputPayload: { pattern: "test" },
        contractBinding: sampleBinding,
        maxAttempts: 3,
      });
      action.authorize();
      action.startAttempt(1);
      action.prepareRetry();

      const result = evaluateRetryEligibility(action.snapshot, { status: "UNKNOWN" });
      expect(result.eligible).toBe(true);
      expect(result.reasonCode).toBe("ELIGIBLE");
    });

    it("evaluates NON_IDEMPOTENT + FAILED as NOT eligible (fails closed)", () => {
      const { action } = Action.create({
        runId: "run-001",
        sequenceNumber: 1,
        toolName: "write_file",
        inputPayload: { path: "test.txt", content: "data" },
        contractBinding: sampleBinding,
        maxAttempts: 3,
      });
      action.authorize();
      action.startAttempt(1);
      action.prepareRetry();

      const result = evaluateRetryEligibility(action.snapshot, { status: "FAILED" });
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("NON_IDEMPOTENT_FAILED");
    });

    it("evaluates NON_IDEMPOTENT + UNKNOWN as NOT eligible (fails closed on uncertainty)", () => {
      const { action } = Action.create({
        runId: "run-001",
        sequenceNumber: 1,
        toolName: "run_command",
        inputPayload: { argv: ["rm", "-rf", "temp"] },
        contractBinding: sampleBinding,
        maxAttempts: 3,
      });
      action.authorize();
      action.startAttempt(1);
      action.prepareRetry();

      const result = evaluateRetryEligibility(action.snapshot, { status: "UNKNOWN" });
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("NON_IDEMPOTENT_UNKNOWN");
      expect(result.message).toContain("fail-closed");
    });

    it("evaluates retry as ineligible when maxAttempts are exhausted", () => {
      const { action } = Action.create({
        runId: "run-001",
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: samplePayload,
        contractBinding: sampleBinding,
        maxAttempts: 1,
      });
      action.authorize();
      action.startAttempt(1);

      const result = evaluateRetryEligibility(action.snapshot, { status: "FAILED" });
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("MAX_ATTEMPTS_EXHAUSTED");
    });

    it("evaluates retry as ineligible when action is already terminal", () => {
      const { action } = Action.create({
        runId: "run-001",
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: samplePayload,
        contractBinding: sampleBinding,
      });
      action.authorize();
      action.startAttempt(1);
      action.succeed("done");

      const result = evaluateRetryEligibility(action.snapshot);
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("TERMINAL_STATE");
    });

    it("evaluates retry as ineligible when an attempt is still running", () => {
      const { action } = Action.create({
        runId: "run-001",
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: samplePayload,
        contractBinding: sampleBinding,
      });
      action.authorize();
      action.startAttempt(1);

      const result = evaluateRetryEligibility(action.snapshot);
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("ATTEMPT_STILL_ACTIVE");
    });
  });

  describe("5. Reconstitution", () => {
    it("reconstitutes an Action accurately from a valid snapshot", () => {
      const { action: original } = Action.create({
        actionId: "act-orig",
        runId: "run-orig",
        sequenceNumber: 4,
        toolName: "git_diff",
        inputPayload: {},
        contractBinding: sampleBinding,
      });
      original.authorize();

      const reconstituted = Action.reconstitute(original.snapshot);
      expect(reconstituted.actionId).toBe("act-orig");
      expect(reconstituted.sequenceNumber).toBe(4);
      expect(reconstituted.status).toBe("AUTHORIZED");
      expect(reconstituted.snapshot).toEqual(original.snapshot);
    });

    it("fails reconstitution if snapshot violates invariants", () => {
      const corruptedSnapshot: ActionSnapshot = {
        actionId: "act-corrupted",
        runId: "run-001",
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: samplePayload,
        inputHash: "0000000000000000000000000000000000000000000000000000000000000000", // Bogus hash
        idempotency: "IDEMPOTENT",
        contractBinding: sampleBinding,
        maxAttempts: 3,
        createdAt: "2026-10-12T00:00:00Z",
        status: "CREATED",
        activeAttemptNumber: null,
        totalAttempts: 0,
        resultPayload: null,
        errorPayload: null,
        updatedAt: "2026-10-12T00:00:00Z",
        completedAt: null,
      };

      expect(() => Action.reconstitute(corruptedSnapshot)).toThrow(InvalidActionError);
    });

    it("directly invokes validateActionInvariants and applyActionTransition", () => {
      const { action } = Action.create({
        runId: "run-001",
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: samplePayload,
        contractBinding: sampleBinding,
      });

      // validateActionInvariants should pass without error
      expect(() => validateActionInvariants(action.snapshot)).not.toThrow();

      // applyActionTransition should transition purely without mutating original
      const { nextSnapshot: authorizedSnapshot } = applyActionTransition(action.snapshot, {
        type: "AUTHORIZE",
        now: "2026-10-12T10:00:00Z",
      });
      expect(authorizedSnapshot.status).toBe("AUTHORIZED");
      expect(action.status).toBe("CREATED");
    });
  });
});
