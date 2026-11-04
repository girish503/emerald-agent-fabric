/**
 * Milestone 2.16-A — PostPassVerificationLatch Snapshot and Reconstruction Test Suite
 *
 * Requirements verified:
 * 1. Empty event history: produces clean, unlatched state.
 * 2. One valid verification event: activates latch and protects target file.
 * 3. Multiple relevant events in deterministic order: aggregates protected paths and clean-room results.
 * 4. Duplicate events: idempotent processing without duplicate paths or corrupted activation event.
 * 5. Conflicting or malformed event data: non-zero exit codes ignored, malformed payloads fail closed, later terminal outcomes override earlier.
 * 6. Wrong-run events: filtered out when scoping to a specific runId.
 * 7. Snapshot serialization and round-trip: getSnapshot() safely serializes to JSON and restores identical state.
 * 8. Repeated reconstruction: replaying same event stream clears prior state and produces identical snapshot.
 * 9. Existing latch behavior: mutation prohibition, path normalization, and clean-room result tracking remain intact.
 */

import { describe, expect, it } from "vitest";
import {
  PostPassVerificationLatch,
  PostPassLatchSnapshot,
  ReconstructibleEvent,
  AmbiguousRunReconstructionError,
  InvalidLatchSnapshotError,
  normalizeLatchPath,
} from "../../src/application/post-pass-verification-latch.js";

describe("Milestone 2.16-A — PostPassVerificationLatch Reconstruction & Snapshot", () => {
  const runId = "run-216a-test-1";

  // Helper to create a standard verification.latched event
  function makeLatchedEvent(options: {
    runId?: string;
    path: string;
    stepNumber?: number;
    sequence?: number;
    timestamp?: string;
    f2pExitCode?: number;
    p2pExitCode?: number;
    targetHash?: string;
    cleanRoomSpecId?: string;
    taskId?: string;
  }): ReconstructibleEvent {
    return {
      eventId: `evt-latched-${options.path.replace(/[^a-zA-Z0-9]/g, "_")}`,
      runId: options.runId ?? runId,
      sequence: options.sequence ?? 1,
      timestamp: options.timestamp ?? "2026-11-04T12:00:00.000Z",
      eventType: "verification.latched",
      payload: {
        stepNumber: options.stepNumber ?? 1,
        protectedPath: options.path,
        f2pExitCode: options.f2pExitCode ?? 0,
        p2pExitCode: options.p2pExitCode ?? 0,
        targetHash: options.targetHash ?? "hash-1234",
        cleanRoomSpecId: options.cleanRoomSpecId ?? "spec-1",
        taskId: options.taskId ?? "task-1",
      },
    };
  }

  // Helper to create a verification.completed event
  function makeCompletedEvent(options: {
    runId?: string;
    status: "VERIFIED" | "FAILED";
    sequence?: number;
    timestamp?: string;
    message?: string;
  }): ReconstructibleEvent {
    return {
      eventId: `evt-completed-${options.sequence ?? 2}`,
      runId: options.runId ?? runId,
      sequence: options.sequence ?? 2,
      timestamp: options.timestamp ?? "2026-11-04T12:01:00.000Z",
      eventType: "verification.completed",
      payload: {
        runId: options.runId ?? runId,
        verifierId: "clean-room-verifier",
        specId: "spec-1",
        status: options.status,
        evidenceIds: ["ev-1"],
        message: options.message ?? (options.status === "VERIFIED" ? "Dual-gate passed" : "Regression detected"),
        verifiedAt: options.timestamp ?? "2026-11-04T12:01:00.000Z",
      },
    };
  }

  // --------------------------------------------------------------------------
  // 1. Empty event history
  // --------------------------------------------------------------------------
  describe("1. Empty event history", () => {
    it("produces clean unlatched state when event list is empty", () => {
      const latch = PostPassVerificationLatch.reconstructFromEvents([]);
      expect(latch.isLatched).toBe(false);
      expect(latch.protectedPaths).toEqual([]);
      expect(latch.cleanRoomVerified).toBe(false);
      expect(latch.cleanRoomStatus).toBeUndefined();
      expect(latch.activationEvent).toBeUndefined();

      const snapshot = latch.getSnapshot();
      expect(snapshot).toEqual({
        schemaVersion: 1,
        isLatched: false,
        protectedPaths: [],
        cleanRoomVerified: false,
      });
    });

    it("clears previously latched instance when reconstructed with empty list", () => {
      const latch = new PostPassVerificationLatch();
      latch.activate({
        stepNumber: 1,
        timestamp: "2026-11-04T12:00:00Z",
        protectedPath: "src/calc.js",
        f2pExitCode: 0,
        p2pExitCode: 0,
      });
      expect(latch.isLatched).toBe(true);

      latch.reconstructFromEvents([]);
      expect(latch.isLatched).toBe(false);
      expect(latch.protectedPaths).toEqual([]);
      expect(latch.activationEvent).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // 2. One valid verification event
  // --------------------------------------------------------------------------
  describe("2. One valid verification event", () => {
    it("activates latch and locks protected path from verification.latched event", () => {
      const event = makeLatchedEvent({ path: "src/calc.js", stepNumber: 1 });
      const latch = PostPassVerificationLatch.reconstructFromEvents([event]);

      expect(latch.isLatched).toBe(true);
      expect(latch.protectedPaths).toEqual(["src/calc.js"]);
      expect(latch.isTargetProtected("src/calc.js")).toBe(true);
      expect(latch.isTargetProtected("./src/calc.js")).toBe(true);
      expect(latch.isTargetProtected("src/other.js")).toBe(false);

      expect(latch.activationEvent).toBeDefined();
      expect(latch.activationEvent?.stepNumber).toBe(1);
      expect(latch.activationEvent?.protectedPath).toBe("src/calc.js");
      expect(latch.activationEvent?.targetHash).toBe("hash-1234");
      expect(latch.cleanRoomVerified).toBe(false);
    });

    it("records clean-room verification outcome from standalone verification.completed event", () => {
      const event = makeCompletedEvent({ status: "VERIFIED", message: "All tests green" });
      const latch = PostPassVerificationLatch.reconstructFromEvents([event]);

      expect(latch.cleanRoomVerified).toBe(true);
      expect(latch.cleanRoomStatus).toBe("VERIFIED");
      expect(latch.isLatched).toBe(false); // Only verification.latched locks target mutations
      expect(latch.protectedPaths).toEqual([]);
    });

    it("records clean_room.verified event correctly", () => {
      const event: ReconstructibleEvent = {
        eventId: "cr-1",
        runId,
        sequence: 1,
        timestamp: "2026-11-04T12:00:00Z",
        eventType: "clean_room.verified",
        payload: { message: "Clean room verified" },
      };
      const latch = PostPassVerificationLatch.reconstructFromEvents([event]);
      expect(latch.cleanRoomVerified).toBe(true);
      expect(latch.cleanRoomStatus).toBe("VERIFIED");
    });
  });

  // --------------------------------------------------------------------------
  // 3. Multiple relevant events in deterministic order
  // --------------------------------------------------------------------------
  describe("3. Multiple relevant events in deterministic order", () => {
    it("correctly aggregates multiple targets and sorts by sequence regardless of input order", () => {
      const e1 = makeLatchedEvent({ path: "src/auth.ts", sequence: 10, stepNumber: 1 });
      const e2 = makeLatchedEvent({ path: "src/crypto.ts", sequence: 20, stepNumber: 2 });
      const e3 = makeCompletedEvent({ status: "VERIFIED", sequence: 30 });

      // Pass in reverse order to verify internal sequence sorting
      const latch = PostPassVerificationLatch.reconstructFromEvents([e3, e1, e2]);

      expect(latch.isLatched).toBe(true);
      expect(latch.protectedPaths).toEqual(["src/auth.ts", "src/crypto.ts"]);
      expect(latch.isTargetProtected("src/auth.ts")).toBe(true);
      expect(latch.isTargetProtected("src/crypto.ts")).toBe(true);
      expect(latch.cleanRoomVerified).toBe(true);
      expect(latch.cleanRoomStatus).toBe("VERIFIED");

      // Activation event reflects the earliest event (auth.ts at step 1)
      expect(latch.activationEvent?.protectedPath).toBe("src/auth.ts");
      expect(latch.activationEvent?.stepNumber).toBe(1);
    });

    it("sorts by timestamp when sequence numbers are absent", () => {
      const e1: ReconstructibleEvent = {
        eventType: "verification.latched",
        runId,
        timestamp: "2026-11-04T10:00:00Z",
        payload: { protectedPath: "src/first.ts", stepNumber: 1, f2pExitCode: 0, p2pExitCode: 0 },
      };
      const e2: ReconstructibleEvent = {
        eventType: "verification.latched",
        runId,
        timestamp: "2026-11-04T11:00:00Z",
        payload: { protectedPath: "src/second.ts", stepNumber: 2, f2pExitCode: 0, p2pExitCode: 0 },
      };

      const latch = PostPassVerificationLatch.reconstructFromEvents([e2, e1]);
      expect(latch.activationEvent?.protectedPath).toBe("src/first.ts");
      expect(latch.protectedPaths).toEqual(["src/first.ts", "src/second.ts"]);
    });
  });

  // --------------------------------------------------------------------------
  // 4. Duplicate events
  // --------------------------------------------------------------------------
  describe("4. Duplicate events", () => {
    it("handles duplicate verification.latched events idempotently without duplicating paths", () => {
      const e1 = makeLatchedEvent({ path: "src/calc.js", sequence: 1 });
      const e1Duplicate = makeLatchedEvent({ path: "src/calc.js", sequence: 1 });
      const e1LaterStep = makeLatchedEvent({ path: "src/calc.js", sequence: 2, stepNumber: 2 });

      const latch = PostPassVerificationLatch.reconstructFromEvents([e1, e1Duplicate, e1LaterStep]);

      expect(latch.isLatched).toBe(true);
      expect(latch.protectedPaths).toEqual(["src/calc.js"]);
      expect(latch.activationEvent?.stepNumber).toBe(1); // Keeps first activation event
    });

    it("handles duplicate verification.completed events idempotently", () => {
      const e1 = makeCompletedEvent({ status: "VERIFIED", sequence: 1 });
      const e2 = makeCompletedEvent({ status: "VERIFIED", sequence: 2 });

      const latch = PostPassVerificationLatch.reconstructFromEvents([e1, e2]);
      expect(latch.cleanRoomVerified).toBe(true);
      expect(latch.cleanRoomStatus).toBe("VERIFIED");
    });
  });

  // --------------------------------------------------------------------------
  // 5. Conflicting or malformed event data
  // --------------------------------------------------------------------------
  describe("5. Conflicting or malformed event data", () => {
    it("ignores verification.latched with non-zero exit codes (failed intermediate tests)", () => {
      const failedF2P = makeLatchedEvent({ path: "src/bad.js", f2pExitCode: 1 });
      const failedP2P = makeLatchedEvent({ path: "src/bad2.js", p2pExitCode: 1 });

      const latch = PostPassVerificationLatch.reconstructFromEvents([failedF2P, failedP2P]);
      expect(latch.isLatched).toBe(false);
      expect(latch.protectedPaths).toEqual([]);
      expect(latch.activationEvent).toBeUndefined();
    });

    it("ignores events with malformed or missing protectedPath", () => {
      const noPath: ReconstructibleEvent = {
        eventType: "verification.latched",
        runId,
        payload: { stepNumber: 1, f2pExitCode: 0, p2pExitCode: 0 },
      };
      const blankPath: ReconstructibleEvent = {
        eventType: "verification.latched",
        runId,
        payload: { protectedPath: "   ", stepNumber: 1, f2pExitCode: 0, p2pExitCode: 0 },
      };
      const nonStringPath: ReconstructibleEvent = {
        eventType: "verification.latched",
        runId,
        payload: { protectedPath: 12345, stepNumber: 1, f2pExitCode: 0, p2pExitCode: 0 },
      };

      const latch = PostPassVerificationLatch.reconstructFromEvents([noPath, blankPath, nonStringPath]);
      expect(latch.isLatched).toBe(false);
      expect(latch.protectedPaths).toEqual([]);
    });

    it("ignores events with null or non-object payloads", () => {
      const nullPayload: ReconstructibleEvent = {
        eventType: "verification.latched",
        runId,
        payload: null,
      };
      const stringPayload: ReconstructibleEvent = {
        eventType: "verification.completed",
        runId,
        payload: "VERIFIED",
      };

      const latch = PostPassVerificationLatch.reconstructFromEvents([nullPayload, stringPayload]);
      expect(latch.isLatched).toBe(false);
      expect(latch.cleanRoomVerified).toBe(false);
    });

    it("handles conflicting verification outcomes: later failed outcome overrides earlier pass", () => {
      const pass = makeCompletedEvent({ status: "VERIFIED", sequence: 1 });
      const fail = makeCompletedEvent({ status: "FAILED", sequence: 2, message: "Regressed in clean room" });

      const latch = PostPassVerificationLatch.reconstructFromEvents([pass, fail]);
      expect(latch.cleanRoomVerified).toBe(false);
      expect(latch.cleanRoomStatus).toBe("FAILED");
      expect(latch.getSnapshot().cleanRoomMessage).toBe("Regressed in clean room");
    });

    it("handles verification.rejected after clean-room verified", () => {
      const pass = makeCompletedEvent({ status: "VERIFIED", sequence: 1 });
      const rejected: ReconstructibleEvent = {
        eventType: "verification.rejected",
        runId,
        sequence: 2,
        timestamp: "2026-11-04T12:02:00Z",
        payload: { message: "Completion rejected: outstanding requirements" },
      };

      const latch = PostPassVerificationLatch.reconstructFromEvents([pass, rejected]);
      expect(latch.cleanRoomVerified).toBe(false);
      expect(latch.cleanRoomStatus).toBe("FAILED");
    });

    it("Check 1.1: sequence collision with conflicting verification outcomes fails closed", () => {
      // Both events have sequence: 5, but one claims VERIFIED and one claims FAILED
      const pass = makeCompletedEvent({ status: "VERIFIED", sequence: 5 });
      const fail = makeCompletedEvent({ status: "FAILED", sequence: 5, message: "Concurrent sweeper detected regression" });

      const latch = PostPassVerificationLatch.reconstructFromEvents([pass, fail]);
      expect(latch.cleanRoomVerified).toBe(false);
      expect(latch.cleanRoomStatus).toBe("FAILED");
    });

    it("Check 1.2: mixed sequenced failure and unsequenced pass fails closed", () => {
      // Authoritative sequenced failure vs unsequenced pass
      const sequencedFailure = makeCompletedEvent({ status: "FAILED", sequence: 10 });
      const unsequencedPass: ReconstructibleEvent = {
        eventId: "unsequenced-pass",
        runId,
        timestamp: "2026-11-04T12:05:00Z",
        eventType: "verification.completed",
        payload: { status: "VERIFIED", message: "Unsequenced pass claim" },
      };

      const latch = PostPassVerificationLatch.reconstructFromEvents([sequencedFailure, unsequencedPass]);
      expect(latch.cleanRoomVerified).toBe(false);
      expect(latch.cleanRoomStatus).toBe("FAILED");
    });

    it("Check 1.3: pure timestamp collision with no sequence numbers fails closed", () => {
      const pass: ReconstructibleEvent = {
        eventId: "evt-pass-ts",
        runId,
        timestamp: "2026-11-04T12:00:00.000Z",
        eventType: "verification.completed",
        payload: { status: "VERIFIED", message: "Pass" },
      };
      const rejected: ReconstructibleEvent = {
        eventId: "evt-rej-ts",
        runId,
        timestamp: "2026-11-04T12:00:00.000Z",
        eventType: "verification.rejected",
        payload: { message: "Rejected" },
      };

      const latch = PostPassVerificationLatch.reconstructFromEvents([pass, rejected]);
      expect(latch.cleanRoomVerified).toBe(false);
      expect(latch.cleanRoomStatus).toBe("FAILED");
    });
  });

  // --------------------------------------------------------------------------
  // 6. Wrong-run events
  // --------------------------------------------------------------------------
  describe("6. Wrong-run events", () => {
    it("fails closed (throws AmbiguousRunReconstructionError) when an event runId mismatches options.runId", () => {
      const eThisRun = makeLatchedEvent({ runId: "target-run", path: "src/mine.js", sequence: 1 });
      const eOtherRun = makeLatchedEvent({ runId: "other-run", path: "src/theirs.js", sequence: 2 });

      expect(() => {
        PostPassVerificationLatch.reconstructFromEvents([eThisRun, eOtherRun], {
          runId: "target-run",
        });
      }).toThrow(AmbiguousRunReconstructionError);
    });

    it("fails closed (throws AmbiguousRunReconstructionError) when payload.runId mismatches options.runId", () => {
      const mismatchedPayload: ReconstructibleEvent = {
        eventType: "verification.latched",
        runId: "target-run",
        payload: {
          runId: "alien-run",
          protectedPath: "src/evil.js",
          stepNumber: 1,
          f2pExitCode: 0,
          p2pExitCode: 0,
        },
      };

      expect(() => {
        PostPassVerificationLatch.reconstructFromEvents([mismatchedPayload], {
          runId: "target-run",
        });
      }).toThrow(AmbiguousRunReconstructionError);
    });

    it("fails closed (throws AmbiguousRunReconstructionError) on mixed-run input when options.runId is omitted", () => {
      const e1 = makeLatchedEvent({ runId: "first-run", path: "src/first.js", sequence: 1 });
      const e2 = makeLatchedEvent({ runId: "second-run", path: "src/second.js", sequence: 2 });

      expect(() => {
        PostPassVerificationLatch.reconstructFromEvents([e1, e2]);
      }).toThrow(AmbiguousRunReconstructionError);
    });

    it("unambiguously reconstructs when all events share a single runId without explicit options.runId", () => {
      const e1 = makeLatchedEvent({ runId: "single-run", path: "src/first.js", sequence: 1 });
      const e2 = makeLatchedEvent({ runId: "single-run", path: "src/second.js", sequence: 2 });

      const latch = PostPassVerificationLatch.reconstructFromEvents([e1, e2]);
      expect(latch.isLatched).toBe(true);
      expect(latch.protectedPaths).toEqual(["src/first.js", "src/second.js"]);
    });
  });

  // --------------------------------------------------------------------------
  // 7. Snapshot serialization and round-trip
  // --------------------------------------------------------------------------
  describe("7. Snapshot serialization and round-trip", () => {
    it("serializes to JSON cleanly and reconstitutes identical state via fromSnapshot()", () => {
      const latch = new PostPassVerificationLatch();
      latch.activate({
        stepNumber: 3,
        timestamp: "2026-11-04T12:00:00.000Z",
        protectedPath: "src/domain/policy.ts",
        f2pExitCode: 0,
        p2pExitCode: 0,
        targetHash: "sha256-abcdef",
        cleanRoomSpecId: "spec-dual-gate",
        taskId: "task-repair-42",
      });
      latch.recordCleanRoomResult({
        status: "VERIFIED",
        evidence: {} as any,
        payload: {} as any,
        verificationResult: {} as any,
        message: "Clean room dual gate passed",
      });

      const snapshot = latch.getSnapshot();
      const serialized = JSON.stringify(snapshot);
      const deserialized: PostPassLatchSnapshot = JSON.parse(serialized);

      const restoredLatch = PostPassVerificationLatch.fromSnapshot(deserialized);
      expect(restoredLatch.getSnapshot()).toEqual(snapshot);

      // Verify restored latch behavioral methods
      expect(restoredLatch.isTargetProtected("src/domain/policy.ts")).toBe(true);
      expect(restoredLatch.isTargetProtected("./src/domain/policy.ts")).toBe(true);
      expect(restoredLatch.isMutationProhibited("write_file", "src/domain/policy.ts").prohibited).toBe(true);
      expect(restoredLatch.isMutationProhibited("edit_file", "src/domain/policy.ts").prohibited).toBe(true);
      expect(restoredLatch.isMutationProhibited("read_file", "src/domain/policy.ts").prohibited).toBe(false);
      expect(restoredLatch.cleanRoomVerified).toBe(true);
    });

    it("restoreFromSnapshot() overwrites existing latch state completely", () => {
      const latch = new PostPassVerificationLatch();
      latch.activate({
        stepNumber: 1,
        timestamp: "2026-11-04T10:00:00Z",
        protectedPath: "src/old.js",
        f2pExitCode: 0,
        p2pExitCode: 0,
      });

      const newSnapshot: PostPassLatchSnapshot = {
        isLatched: true,
        protectedPaths: ["src/new.js"],
        activationEvent: {
          stepNumber: 2,
          timestamp: "2026-11-04T11:00:00Z",
          protectedPath: "src/new.js",
          f2pExitCode: 0,
          p2pExitCode: 0,
        },
        cleanRoomVerified: true,
        cleanRoomStatus: "VERIFIED",
        cleanRoomMessage: "Clean room passed",
      };

      latch.restoreFromSnapshot(newSnapshot);
      expect(latch.isTargetProtected("src/old.js")).toBe(false);
      expect(latch.isTargetProtected("src/new.js")).toBe(true);
      expect(latch.cleanRoomVerified).toBe(true);
    });

    it("validates snapshot fail-closed: throws InvalidLatchSnapshotError on unsupported schemaVersion", () => {
      expect(() => {
        PostPassVerificationLatch.fromSnapshot({
          schemaVersion: 99,
          isLatched: false,
          protectedPaths: [],
          cleanRoomVerified: false,
        });
      }).toThrow(InvalidLatchSnapshotError);
    });

    it("validates snapshot fail-closed: throws InvalidLatchSnapshotError when isLatched is true but activationEvent is missing", () => {
      expect(() => {
        PostPassVerificationLatch.fromSnapshot({
          isLatched: true,
          protectedPaths: ["src/file.js"],
          cleanRoomVerified: false,
          // activationEvent missing
        });
      }).toThrow(InvalidLatchSnapshotError);
    });

    it("validates snapshot fail-closed: throws InvalidLatchSnapshotError when activationEvent.protectedPath is missing from protectedPaths", () => {
      expect(() => {
        PostPassVerificationLatch.fromSnapshot({
          isLatched: true,
          protectedPaths: ["src/fileA.js"],
          cleanRoomVerified: false,
          activationEvent: {
            stepNumber: 1,
            timestamp: "2026-11-04T12:00:00Z",
            protectedPath: "src/fileB.js", // Mismatch: fileB is not in protectedPaths
            f2pExitCode: 0,
            p2pExitCode: 0,
          },
        });
      }).toThrow(InvalidLatchSnapshotError);
    });

    it("validates snapshot fail-closed: throws InvalidLatchSnapshotError when isLatched is false but activationEvent is present", () => {
      expect(() => {
        PostPassVerificationLatch.fromSnapshot({
          isLatched: false,
          protectedPaths: [],
          cleanRoomVerified: false,
          activationEvent: {
            stepNumber: 1,
            timestamp: "2026-11-04T12:00:00Z",
            protectedPath: "src/file.js",
            f2pExitCode: 0,
            p2pExitCode: 0,
          },
        });
      }).toThrow(InvalidLatchSnapshotError);
    });

    it("validates snapshot fail-closed: throws InvalidLatchSnapshotError when cleanRoomMessage is defined but cleanRoomStatus is undefined", () => {
      expect(() => {
        PostPassVerificationLatch.fromSnapshot({
          isLatched: false,
          protectedPaths: [],
          cleanRoomVerified: false,
          cleanRoomMessage: "Orphaned message",
        });
      }).toThrow(InvalidLatchSnapshotError);
    });

    it("validates snapshot fail-closed: throws InvalidLatchSnapshotError on invalid activationEvent fields (empty timestamp, negative step)", () => {
      // Empty timestamp
      expect(() => {
        PostPassVerificationLatch.fromSnapshot({
          isLatched: true,
          protectedPaths: ["src/file.js"],
          cleanRoomVerified: false,
          activationEvent: {
            stepNumber: 1,
            timestamp: "   ",
            protectedPath: "src/file.js",
            f2pExitCode: 0,
            p2pExitCode: 0,
          },
        });
      }).toThrow(InvalidLatchSnapshotError);

      // Negative stepNumber
      expect(() => {
        PostPassVerificationLatch.fromSnapshot({
          isLatched: true,
          protectedPaths: ["src/file.js"],
          cleanRoomVerified: false,
          activationEvent: {
            stepNumber: -1,
            timestamp: "2026-11-04T12:00:00Z",
            protectedPath: "src/file.js",
            f2pExitCode: 0,
            p2pExitCode: 0,
          },
        });
      }).toThrow(InvalidLatchSnapshotError);
    });

    it("validates snapshot fail-closed: throws InvalidLatchSnapshotError on contradictory clean-room state", () => {
      // cleanRoomVerified true but cleanRoomStatus FAILED
      expect(() => {
        PostPassVerificationLatch.fromSnapshot({
          isLatched: false,
          protectedPaths: [],
          cleanRoomVerified: true,
          cleanRoomStatus: "FAILED",
        });
      }).toThrow(InvalidLatchSnapshotError);

      // cleanRoomVerified true but cleanRoomStatus missing
      expect(() => {
        PostPassVerificationLatch.fromSnapshot({
          isLatched: false,
          protectedPaths: [],
          cleanRoomVerified: true,
        });
      }).toThrow(InvalidLatchSnapshotError);
    });

    it("validates snapshot fail-closed: throws InvalidLatchSnapshotError on inconsistent latch paths", () => {
      // isLatched true but empty protectedPaths
      expect(() => {
        PostPassVerificationLatch.fromSnapshot({
          isLatched: true,
          protectedPaths: [],
          cleanRoomVerified: false,
        });
      }).toThrow(InvalidLatchSnapshotError);

      // isLatched false but non-empty protectedPaths
      expect(() => {
        PostPassVerificationLatch.fromSnapshot({
          isLatched: false,
          protectedPaths: ["src/locked.js"],
          cleanRoomVerified: false,
        });
      }).toThrow(InvalidLatchSnapshotError);
    });

    it("validates snapshot fail-closed: throws InvalidLatchSnapshotError on non-zero activation exit codes", () => {
      expect(() => {
        PostPassVerificationLatch.fromSnapshot({
          isLatched: true,
          protectedPaths: ["src/valid.js"],
          cleanRoomVerified: false,
          activationEvent: {
            stepNumber: 1,
            timestamp: "2026-11-04T12:00:00Z",
            protectedPath: "src/valid.js",
            f2pExitCode: 1, // Invalid: failing exit code
            p2pExitCode: 0,
          },
        });
      }).toThrow(InvalidLatchSnapshotError);
    });
  });

  // --------------------------------------------------------------------------
  // 8. Repeated reconstruction producing identical state
  // --------------------------------------------------------------------------
  describe("8. Repeated reconstruction producing identical state", () => {
    it("produces strictly identical snapshots when replayed multiple times on same instance", () => {
      const events = [
        makeLatchedEvent({ path: "src/moduleA.ts", sequence: 1, stepNumber: 1 }),
        makeLatchedEvent({ path: "src/moduleB.ts", sequence: 2, stepNumber: 2 }),
        makeCompletedEvent({ status: "VERIFIED", sequence: 3 }),
      ];

      const latch = new PostPassVerificationLatch();

      latch.reconstructFromEvents(events);
      const snapshot1 = latch.getSnapshot();

      latch.reconstructFromEvents(events);
      const snapshot2 = latch.getSnapshot();

      latch.reconstructFromEvents(events);
      const snapshot3 = latch.getSnapshot();

      expect(snapshot1).toEqual(snapshot2);
      expect(snapshot2).toEqual(snapshot3);
      expect(snapshot1.protectedPaths).toEqual(["src/moduleA.ts", "src/moduleB.ts"]);
    });

    it("two distinct instances reconstructed with the same events have deeply equal snapshots", () => {
      const events = [
        makeLatchedEvent({ path: "src/core.ts", sequence: 1 }),
        makeCompletedEvent({ status: "VERIFIED", sequence: 2 }),
      ];

      const latch1 = PostPassVerificationLatch.reconstructFromEvents(events);
      const latch2 = PostPassVerificationLatch.reconstructFromEvents(events);

      expect(latch1.getSnapshot()).toEqual(latch2.getSnapshot());
    });
  });

  // --------------------------------------------------------------------------
  // 9. Existing latch behavior remaining unchanged
  // --------------------------------------------------------------------------
  describe("9. Existing latch behavior remaining unchanged", () => {
    it("mutation prohibition rule: write_file and edit_file prohibited on protected target, read_file permitted", () => {
      const latch = new PostPassVerificationLatch();
      latch.activate({
        stepNumber: 1,
        timestamp: "2026-11-04T12:00:00Z",
        protectedPath: "src/repair.ts",
        f2pExitCode: 0,
        p2pExitCode: 0,
      });

      // Mutating tools on protected path prohibited
      expect(latch.isMutationProhibited("write_file", "src/repair.ts").prohibited).toBe(true);
      expect(latch.isMutationProhibited("edit_file", "src/repair.ts").prohibited).toBe(true);
      expect(latch.isMutationProhibited("edit_file", "./src/repair.ts").prohibited).toBe(true);
      expect(latch.isMutationProhibited("edit_file", "src\\repair.ts").prohibited).toBe(true);

      // Mutating tools on unlatched path permitted
      expect(latch.isMutationProhibited("write_file", "src/other.ts").prohibited).toBe(false);

      // Non-mutating tools on protected path permitted
      expect(latch.isMutationProhibited("read_file", "src/repair.ts").prohibited).toBe(false);
      expect(latch.isMutationProhibited("search_code", "src/repair.ts").prohibited).toBe(false);
      expect(latch.isMutationProhibited("git_status", "src/repair.ts").prohibited).toBe(false);
      expect(latch.isMutationProhibited("git_diff", "src/repair.ts").prohibited).toBe(false);
      expect(latch.isMutationProhibited("run_command", "src/repair.ts").prohibited).toBe(false);
    });

    it("normalizeLatchPath handles backslashes, leading ./ and whitespace", () => {
      expect(normalizeLatchPath("src\\dir\\file.ts")).toBe("src/dir/file.ts");
      expect(normalizeLatchPath("./src/dir/file.ts")).toBe("src/dir/file.ts");
      expect(normalizeLatchPath("  src/dir/file.ts  ")).toBe("src/dir/file.ts");
      expect(normalizeLatchPath("")).toBe("");
      expect(normalizeLatchPath(null as any)).toBe("");
    });
  });
});
