/**
 * Scenario 12 Verified Run Recovery Tests (Milestone 2.16-E).
 *
 * Verifies recovery correctness when a verification event (clean_room.verified or
 * verification.completed with status VERIFIED) was persisted in run_events, but the process
 * crashed before the final run.completed state transition was committed.
 *
 * Requirements verified:
 * 1. Detect verification event in run_events after latest action.started.
 * 2. Confirm event corresponds to current run, attempt identity, and same contract binding.
 * 3. Reconcile run to COMPLETED using existing evidence without re-invoking model or repeating verification.
 * 4. Preserve fail-closed behavior on mismatch/uncertainty.
 * 5. Ensure recovery is idempotent.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import {
  decideVerifiedRunRecovery,
} from "../../src/application/recovery-decision-policy.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { createAndActivateContract } from "../application/test-helpers.js";
import type { DomainEvent, VerificationCompletedPayload } from "../../src/domain/events.js";

describe("Scenario 12 — Verified Run Recovery Correctness", () => {
  let tempDir: string;
  let workspaceRoot: string;
  let clock: SettableClock;
  let store: SqliteStateStore;
  let adapter: NodeFsWorkspaceAdapter;
  let coordinator: RunCoordinator;

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "emerald-scenario12-")));
    workspaceRoot = path.join(tempDir, "workspaces");
    fs.mkdirSync(workspaceRoot);
    clock = new SettableClock(new Date().toISOString());
    store = new SqliteStateStore();
    adapter = new NodeFsWorkspaceAdapter({ workspaceRoot });
    coordinator = new RunCoordinator(store, clock, undefined, adapter);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* store closed */
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function setupRunningRun(options?: {
    workerId?: string;
    leaseTtlMs?: number;
    maxAttempts?: number;
  }) {
    const workerId = options?.workerId ?? "worker-1";
    const leaseTtlMs = options?.leaseTtlMs ?? 5_000;
    const maxAttempts = options?.maxAttempts ?? 3;

    coordinator.registerWorker({
      workerId,
      hostname: "worker-host",
      pid: process.pid,
      status: "ACTIVE",
      lastHeartbeatAt: clock.nowIso(),
      createdAt: clock.nowIso(),
    });

    const task = coordinator.createTask({ title: "scenario-12-task", inputPayload: {} });
    const contract = createAndActivateContract(store, task.taskId, {
      maxAttempts,
      policy: createExecutionPolicy({
        policyId: `p-${task.taskId}`,
        allowedCapabilities: ["execution.echo"],
        isolationRequirement: "IN_PROCESS",
        trustedInProcessOperations: [],
      }),
    });

    const { run } = coordinator.createRun({
      taskId: task.taskId,
      maxAttempts,
      timeoutMs: 30_000,
    });
    coordinator.queueRun(run.runId);

    const claimRes = coordinator.claimRun(run.runId, workerId, leaseTtlMs);
    coordinator.startRun(run.runId, workerId, claimRes.lease.leaseId);

    return {
      task,
      contract,
      runId: run.runId,
      workerId,
      leaseId: claimRes.lease.leaseId,
    };
  }

  describe("Pure Policy: decideVerifiedRunRecovery", () => {
    it("returns COMPLETE_FROM_VERIFIED_EVENT when verification.completed (VERIFIED) exists and is consistent", () => {
      const { runId, contract } = setupRunningRun();
      const snapshot = coordinator.getRun(runId)!;

      const verEvent: DomainEvent<VerificationCompletedPayload> = {
        eventId: "ver-evt-1",
        runId,
        timestamp: clock.nowIso(),
        eventType: "verification.completed",
        schemaVersion: 1,
        producer: "application.verifier",
        payload: {
          runId,
          verifierId: "clean_room_verifier",
          specId: "spec-1",
          status: "VERIFIED",
          evidenceIds: ["ev-1", "ev-2"],
          message: "All tests passed",
          verifiedAt: clock.nowIso(),
          details: {
            attemptNumber: 1,
            contractId: contract.spec.contractId,
            contractVersion: contract.spec.version,
            result: { output: "SUCCESSFUL_REPAIR" },
          },
        },
      };

      const decision = decideVerifiedRunRecovery({
        runSnapshot: snapshot,
        events: [verEvent],
      });

      expect(decision.action).toBe("COMPLETE_FROM_VERIFIED_EVENT");
      if (decision.action === "COMPLETE_FROM_VERIFIED_EVENT") {
        expect(decision.verificationEvent.eventId).toBe("ver-evt-1");
        expect(decision.resultPayload).toEqual({ output: "SUCCESSFUL_REPAIR" });
      }
    });

    it("returns COMPLETE_FROM_VERIFIED_EVENT for clean_room.verified event", () => {
      const { runId, contract } = setupRunningRun();
      const snapshot = coordinator.getRun(runId)!;

      const cleanRoomEvent: DomainEvent = {
        eventId: "cr-evt-1",
        runId,
        timestamp: clock.nowIso(),
        eventType: "clean_room.verified",
        schemaVersion: 1,
        producer: "application.clean_room",
        payload: {
          runId,
          patchSha256: "sha256-abc12345",
          evidenceIds: ["ev-cr-1"],
          attemptNumber: 1,
          contractId: contract.spec.contractId,
          contractVersion: contract.spec.version,
        },
      };

      const decision = decideVerifiedRunRecovery({
        runSnapshot: snapshot,
        events: [cleanRoomEvent],
      });

      expect(decision.action).toBe("COMPLETE_FROM_VERIFIED_EVENT");
    });

    it("returns PROCEED_TO_RETRY when no verification event exists", () => {
      const { runId } = setupRunningRun();
      const snapshot = coordinator.getRun(runId)!;

      const decision = decideVerifiedRunRecovery({
        runSnapshot: snapshot,
        events: [],
      });

      expect(decision.action).toBe("PROCEED_TO_RETRY");
    });

    it("returns PROCEED_TO_RETRY when verification event was for a prior attempt", () => {
      const { runId } = setupRunningRun();
      const snapshot = { ...coordinator.getRun(runId)!, attemptCount: 2 };

      const verEvent: DomainEvent = {
        eventId: "ver-old",
        runId,
        timestamp: clock.nowIso(),
        eventType: "verification.completed",
        schemaVersion: 1,
        producer: "application.verifier",
        payload: {
          runId,
          status: "VERIFIED",
          attemptNumber: 1, // older attempt!
        },
      };

      const decision = decideVerifiedRunRecovery({
        runSnapshot: snapshot,
        events: [verEvent],
      });

      expect(decision.action).toBe("PROCEED_TO_RETRY");
    });

    it("returns PROCEED_TO_RETRY when an action.started event occurred AFTER verification", () => {
      const { runId } = setupRunningRun();
      const snapshot = coordinator.getRun(runId)!;

      const verEvent: DomainEvent = {
        eventId: "ver-1",
        runId,
        timestamp: "2026-11-04T12:00:00.000Z",
        eventType: "verification.completed",
        schemaVersion: 1,
        producer: "application.verifier",
        payload: { runId, status: "VERIFIED" },
      };

      const actionStartedEvent: DomainEvent = {
        eventId: "act-start-1",
        runId,
        timestamp: "2026-11-04T12:01:00.000Z",
        eventType: "action.started",
        schemaVersion: 1,
        producer: "worker:w",
        payload: { actionId: "act-1" },
      };

      const decision = decideVerifiedRunRecovery({
        runSnapshot: snapshot,
        events: [verEvent, actionStartedEvent],
      });

      expect(decision.action).toBe("PROCEED_TO_RETRY");
    });

    it("returns FAIL_CLOSED when verification was subsequently rejected", () => {
      const { runId } = setupRunningRun();
      const snapshot = coordinator.getRun(runId)!;

      const verEvent: DomainEvent = {
        eventId: "ver-1",
        runId,
        timestamp: "2026-11-04T12:00:00.000Z",
        eventType: "verification.completed",
        schemaVersion: 1,
        producer: "application.verifier",
        payload: { runId, status: "VERIFIED" },
      };

      const rejectEvent: DomainEvent = {
        eventId: "ver-rej-1",
        runId,
        timestamp: "2026-11-04T12:01:00.000Z",
        eventType: "verification.rejected",
        schemaVersion: 1,
        producer: "application.verifier",
        payload: { runId, reason: "UNVERIFIED_COMPLETION_CLAIM" },
      };

      const decision = decideVerifiedRunRecovery({
        runSnapshot: snapshot,
        events: [verEvent, rejectEvent],
      });

      expect(decision.action).toBe("FAIL_CLOSED");
      if (decision.action === "FAIL_CLOSED") {
        expect(decision.reasonCode).toBe("SUBSEQUENT_VERIFICATION_REJECTED");
      }
    });

    it("returns FAIL_CLOSED when contract ID in verification event mismatches bound contract", () => {
      const { runId } = setupRunningRun();
      const snapshot = coordinator.getRun(runId)!;

      const verEvent: DomainEvent = {
        eventId: "ver-mismatch",
        runId,
        timestamp: clock.nowIso(),
        eventType: "verification.completed",
        schemaVersion: 1,
        producer: "application.verifier",
        payload: {
          runId,
          status: "VERIFIED",
          contractId: "wrong-contract-id",
        },
      };

      const decision = decideVerifiedRunRecovery({
        runSnapshot: snapshot,
        events: [verEvent],
      });

      expect(decision.action).toBe("FAIL_CLOSED");
      if (decision.action === "FAIL_CLOSED") {
        expect(decision.reasonCode).toBe("CONTRACT_INTEGRITY_MISMATCH");
      }
    });
  });

  describe("Integration: RunCoordinator.recoverExpiredRuns", () => {
    it("Scenario 12 Happy Path: reconciles verified run to COMPLETED without retry or re-verification", () => {
      const { runId } = setupRunningRun();

      // Record clean-room verification passing into run_events
      coordinator.recordVerificationResult(runId, {
        verifierId: "clean_room_verifier",
        specId: "spec-pass",
        status: "VERIFIED",
        evidenceIds: ["ev-proof-1"],
        message: "Clean room verification confirmed goal achieved",
        details: {
          candidatePatchHash: "sha256-patch-evidence",
          result: { success: true, message: "Task solved cleanly" },
        },
        verifiedAt: clock.nowIso(),
      });

      // Worker crashes! Lease expires without completeRun being committed
      clock.advanceMs(6_000);

      // Sweeper runs
      const sweepRes = coordinator.recoverExpiredRuns();

      expect(sweepRes.recoveredCount).toBe(1);
      const recoveredRun = sweepRes.runs[0]!;
      expect(recoveredRun.runId).toBe(runId);
      expect(recoveredRun.status).toBe("COMPLETED");
      expect(recoveredRun.attemptCount).toBe(0); // attempt was NOT incremented (remains initial attempt 0)
      expect(recoveredRun.resultPayload).toEqual({ success: true, message: "Task solved cleanly" });

      // In SQLite, status is COMPLETED
      const finalDbSnapshot = coordinator.getRun(runId)!;
      expect(finalDbSnapshot.status).toBe("COMPLETED");

      // Verify run.completed event was recorded
      const events = coordinator.getEventsForRun(runId);
      const completedEvent = events.find((e) => e.eventType === "run.completed");
      expect(completedEvent).toBeDefined();
      expect(completedEvent?.producer).toBe("coordinator.recovery");
    });

    it("Scenario 12 Happy Path with clean_room.verified event: reconciles to COMPLETED", () => {
      const { runId } = setupRunningRun();

      // Append clean_room.verified directly to run_events
      store.transaction((tx) => {
        tx.appendEvent({
          eventId: "cr-event-direct",
          runId,
          timestamp: clock.nowIso(),
          eventType: "clean_room.verified",
          schemaVersion: 1,
          producer: "verifier.clean_room",
          payload: {
            runId,
            status: "VERIFIED",
            patchSha256: "sha256-verified-patch",
            details: { outcome: "SOLVED" },
          },
        });
      });

      // Crash & expire lease
      clock.advanceMs(6_000);

      const sweepRes = coordinator.recoverExpiredRuns();
      expect(sweepRes.recoveredCount).toBe(1);
      expect(sweepRes.runs[0]!.status).toBe("COMPLETED");
    });

    it("re-queues when no verification event exists (normal recovery)", () => {
      setupRunningRun({ maxAttempts: 3 });

      // Crash & expire lease without verification
      clock.advanceMs(6_000);

      const sweepRes = coordinator.recoverExpiredRuns();
      expect(sweepRes.recoveredCount).toBe(1);
      const recoveredRun = sweepRes.runs[0]!;
      expect(recoveredRun.status).toBe("QUEUED");
      expect(recoveredRun.attemptCount).toBe(1); // Retried from initial attempt 0 to attempt 1
    });

    it("re-queues when verification event was for a prior attempt", () => {
      const { runId } = setupRunningRun({ maxAttempts: 3 });

      // Verification event recorded with attemptNumber: 1
      store.transaction((tx) => {
        tx.appendEvent({
          eventId: "ver-att-1",
          runId,
          timestamp: clock.nowIso(),
          eventType: "verification.completed",
          schemaVersion: 1,
          producer: "verifier",
          payload: {
            runId,
            status: "VERIFIED",
            attemptNumber: 1,
          },
        });
      });

      // Advance to attempt 2
      clock.advanceMs(6_000);
      // Manually set attempt count to 2 to simulate second attempt crashing
      store.transaction((tx) => {
        const snap = tx.getRun(runId)!;
        tx.updateRun(runId, snap.version, { ...snap, attemptCount: 2 }, {
          eventId: "evt-att-2",
          runId,
          timestamp: clock.nowIso(),
          eventType: "run.queued",
          schemaVersion: 1,
          producer: "test",
          payload: {},
        });
      });

      // Sweeper runs: attempt 1 verification must NOT complete attempt 2!
      const sweepRes = coordinator.recoverExpiredRuns();
      expect(sweepRes.recoveredCount).toBe(1);
      expect(sweepRes.runs[0]!.status).toBe("QUEUED");
      expect(sweepRes.runs[0]!.attemptCount).toBe(3);
    });

    it("fails closed when subsequent verification rejected event exists", () => {
      const { runId } = setupRunningRun();

      store.transaction((tx) => {
        tx.appendEvent({
          eventId: "ver-1",
          runId,
          timestamp: clock.nowIso(),
          eventType: "verification.completed",
          schemaVersion: 1,
          producer: "verifier",
          payload: { runId, status: "VERIFIED" },
        });

        clock.advanceMs(1_000);
        tx.appendEvent({
          eventId: "ver-rej-1",
          runId,
          timestamp: clock.nowIso(),
          eventType: "verification.rejected",
          schemaVersion: 1,
          producer: "verifier",
          payload: { runId, reason: "UNVERIFIED_COMPLETION_CLAIM" },
        });
      });

      // Expire lease
      clock.advanceMs(6_000);

      const sweepRes = coordinator.recoverExpiredRuns();
      expect(sweepRes.recoveredCount).toBe(1);
      expect(sweepRes.runs[0]!.status).toBe("FAILED");
      expect(sweepRes.runs[0]!.errorPayload).toMatchObject({
        code: "SUBSEQUENT_VERIFICATION_REJECTED",
      });
    });

    it("idempotency: repeated recovery sweeps on already-completed run are safe no-ops", () => {
      const { runId } = setupRunningRun();

      coordinator.recordVerificationResult(runId, {
        verifierId: "clean_room_verifier",
        specId: "spec-pass",
        status: "VERIFIED",
        evidenceIds: ["ev-proof-1"],
        message: "Clean room verification confirmed",
        verifiedAt: clock.nowIso(),
      });

      clock.advanceMs(6_000);

      // Sweep 1: completes the run
      const sweep1 = coordinator.recoverExpiredRuns();
      expect(sweep1.recoveredCount).toBe(1);
      expect(sweep1.runs[0]!.status).toBe("COMPLETED");

      // Sweep 2: no-op, run is already terminal
      const sweep2 = coordinator.recoverExpiredRuns();
      expect(sweep2.recoveredCount).toBe(0);
      expect(coordinator.getRun(runId)!.status).toBe("COMPLETED");
    });

    it("fails closed when UNKNOWN attempt exists alongside verified event (Property 2 guard)", () => {
      const { runId } = setupRunningRun();

      // Record verification passing
      coordinator.recordVerificationResult(runId, {
        verifierId: "clean_room_verifier",
        specId: "spec-pass",
        status: "VERIFIED",
        evidenceIds: ["ev-proof-1"],
        message: "Verification passed",
        verifiedAt: clock.nowIso(),
      });

      // Expire lease — sweeper will run
      clock.advanceMs(6_000);

      // Inject an UNKNOWN attempt record directly to simulate uncertain execution alongside
      // a verified event (the gap: verification cannot retroactively confirm uncertain execution)
      const snap = coordinator.getRun(runId)!;
      store.transaction((tx) => {
        // We append a synthetic action+attempt to represent a tool whose outcome is uncertain.
        // In production this is created by WorkerRuntime before model invocation.
        tx.appendEvent({
          eventId: "syn-action-created",
          runId,
          timestamp: clock.nowIso(),
          eventType: "action.created",
          schemaVersion: 1,
          producer: "test.synthetic",
          payload: { actionId: "syn-action-1" },
        });
      });

      // Use the pure policy directly with an UNKNOWN attempt to confirm the guard
      const verEvent = {
        eventId: "ver-1",
        runId,
        timestamp: clock.nowIso(),
        eventType: "verification.completed" as const,
        schemaVersion: 1 as const,
        producer: "verifier",
        payload: { runId, status: "VERIFIED" as const, verifierId: "v", specId: "s", message: "", evidenceIds: [], verifiedAt: clock.nowIso() },
      };
      const decision = decideVerifiedRunRecovery({
        runSnapshot: snap,
        events: [verEvent],
        attempts: [
          {
            status: "UNKNOWN",
            attemptId: "attempt-uncertain-1",
            attemptNumber: 1,
          },
        ],
      });

      expect(decision.action).toBe("FAIL_CLOSED");
      if (decision.action === "FAIL_CLOSED") {
        expect(decision.reasonCode).toBe("UNCERTAIN_ATTEMPT_PREVENTS_COMPLETION");
        expect((decision.details as any).uncertainAttemptIds).toContain("attempt-uncertain-1");
      }
    });

    it("DISPATCHED attempt alongside verified event → FAIL_CLOSED (uncertain execution)", () => {
      const { runId } = setupRunningRun();
      const snap = coordinator.getRun(runId)!;

      const verEvent = {
        eventId: "ver-dispatched",
        runId,
        timestamp: clock.nowIso(),
        eventType: "verification.completed" as const,
        schemaVersion: 1 as const,
        producer: "verifier",
        payload: { runId, status: "VERIFIED" as const, verifierId: "v", specId: "s", message: "", evidenceIds: [], verifiedAt: clock.nowIso() },
      };

      const decision = decideVerifiedRunRecovery({
        runSnapshot: snap,
        events: [verEvent],
        attempts: [{ status: "DISPATCHED", attemptId: "attempt-dispatched-1", attemptNumber: 1 }],
      });

      expect(decision.action).toBe("FAIL_CLOSED");
      if (decision.action === "FAIL_CLOSED") {
        expect(decision.reasonCode).toBe("UNCERTAIN_ATTEMPT_PREVENTS_COMPLETION");
      }
    });

    it("RUNNING attempt alongside verified event → FAIL_CLOSED (uncertain execution)", () => {
      const { runId } = setupRunningRun();
      const snap = coordinator.getRun(runId)!;

      const verEvent = {
        eventId: "ver-running",
        runId,
        timestamp: clock.nowIso(),
        eventType: "clean_room.verified" as const,
        schemaVersion: 1 as const,
        producer: "verifier.clean_room",
        payload: { runId, patchSha256: "sha256-abc" },
      };

      const decision = decideVerifiedRunRecovery({
        runSnapshot: snap,
        events: [verEvent],
        attempts: [{ status: "RUNNING", attemptId: "attempt-running-1", attemptNumber: 1 }],
      });

      expect(decision.action).toBe("FAIL_CLOSED");
      if (decision.action === "FAIL_CLOSED") {
        expect(decision.reasonCode).toBe("UNCERTAIN_ATTEMPT_PREVENTS_COMPLETION");
      }
    });

    it("SUCCEEDED attempts alongside verified event → COMPLETE_FROM_VERIFIED_EVENT (no uncertain attempt)", () => {
      const { runId } = setupRunningRun();
      const snap = coordinator.getRun(runId)!;

      const verEvent = {
        eventId: "ver-ok",
        runId,
        timestamp: clock.nowIso(),
        eventType: "verification.completed" as const,
        schemaVersion: 1 as const,
        producer: "verifier",
        payload: { runId, status: "VERIFIED" as const, verifierId: "v", specId: "s", message: "", evidenceIds: [], verifiedAt: clock.nowIso() },
      };

      const decision = decideVerifiedRunRecovery({
        runSnapshot: snap,
        events: [verEvent],
        attempts: [
          { status: "SUCCEEDED", attemptId: "attempt-ok-1", attemptNumber: 1 },
          { status: "CANCELLED", attemptId: "attempt-cancelled-1", attemptNumber: 0 },
        ],
      });

      // All attempts are terminal and certain — completion is safe
      expect(decision.action).toBe("COMPLETE_FROM_VERIFIED_EVENT");
    });

    it("ordinary worker run.complete is still lease-fenced (recovery sentinel is not reachable via completeRun)", () => {
      // Property 3 guard: completeRun() requires matching workerId+leaseId.
      // This verifies the normal non-recovery path still enforces fencing.
      const { runId } = setupRunningRun();

      // A different worker with a different lease cannot complete
      expect(() =>
        coordinator.completeRun(runId, "other-worker", "other-lease-id", { output: "bogus" })
      ).toThrow(); // LeaseLostError or similar fencing error
    });

    it("fencing: active unexpired worker lease is untouched", () => {
      const { runId } = setupRunningRun({ leaseTtlMs: 60_000 });

      coordinator.recordVerificationResult(runId, {
        verifierId: "clean_room_verifier",
        specId: "spec-pass",
        status: "VERIFIED",
        evidenceIds: ["ev-proof-1"],
        message: "Clean room verification confirmed",
        verifiedAt: clock.nowIso(),
      });

      // Lease is STILL ACTIVE (only 1s passed)
      clock.advanceMs(1_000);

      const sweepRes = coordinator.recoverExpiredRuns();
      expect(sweepRes.recoveredCount).toBe(0);
      expect(coordinator.getRun(runId)!.status).toBe("RUNNING");
    });
  });
});
