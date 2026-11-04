/**
 * Emerald Agent Fabric — Milestone 2.16-C: Recovery Supervisor Lease Fencing Tests
 *
 * Verifies durable, exclusive recovery-supervisor lease fencing:
 * 1. Two supervisors competing to acquire recovery authority.
 * 2. Atomic acquisition under concurrent requests.
 * 3. Stale owner attempting a recovery mutation after ownership replacement.
 * 4. Stale owner attempting to release the current owner's gate.
 * 5. Current owner successfully releasing the gate.
 * 6. Supervisor crash and safe reclamation.
 * 7. Unknown or unverifiable process liveness.
 * 8. Lease expiry while recovery work is still active.
 * 9. Gate acquisition failure preventing recovery mutations.
 * 10. Recovery gate contention preserving durable run/action/attempt state.
 * 11. Existing tenant-quiescence and worker-lease fencing compatibility.
 * 12. Scenario 12 compatibility.
 * 13. Checkpoint restoration compatibility.
 * 14. Recovery audit/event consistency.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteClient } from "../../src/adapters/persistence/sqlite-client.js";
import { migrateDatabase } from "../../src/adapters/persistence/schema.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RecoverySupervisor } from "../../src/recovery/recovery-supervisor.js";
import { DurableRollbackEngine } from "../../src/recovery/durable-rollback-engine.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import {
  ActiveWorkerLeaseFencingError,
  SupervisorLeaseLostError,
} from "../../src/domain/errors.js";
import { inProcessBinding } from "./in-process-binding.js";
import { Action } from "../../src/domain/action.js";
import { Attempt, type AttemptSnapshot } from "../../src/domain/attempt.js";
import { reconcileCheckpointWithDurableEvidence } from "../../src/application/step-loop-checkpoint.js";
import { PostPassVerificationLatch } from "../../src/application/post-pass-verification-latch.js";
import type { ClockPort } from "../../src/ports/clock.port.js";
import type { RunSnapshot } from "../../src/domain/invariants.js";

const sha256 = (c: string) => createHash("sha256").update(c).digest("hex");

function createControlledClock(initialIso: string = "2026-11-04T12:00:00.000Z"): ClockPort & {
  advance(ms: number): void;
  set(iso: string): void;
  nowMs(): number;
} {
  let currentMs = new Date(initialIso).getTime();
  return {
    now: () => new Date(currentMs),
    nowIso: () => new Date(currentMs).toISOString(),
    nowMs: () => currentMs,
    advance: (ms: number) => {
      currentMs += ms;
    },
    set: (iso: string) => {
      currentMs = new Date(iso).getTime();
    },
  };
}

describe("Milestone 2.16-C: Recovery Supervisor Lease Fencing", () => {
  let db: DatabaseSync;
  let store: SqliteStateStore;
  let engine: DurableRollbackEngine;
  let coordinator: RunCoordinator;
  let clock: ReturnType<typeof createControlledClock>;
  let tempDir: string;
  let wsRoot: string;
  let processAliveMap: Map<number, boolean>;

  const RUN_1 = "run-fencing-01";
  const RUN_2 = "run-fencing-02";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eaf-lease-fencing-"));
    wsRoot = path.join(tempDir, "workspace");
    fs.mkdirSync(wsRoot, { recursive: true });

    clock = createControlledClock("2026-11-04T12:00:00.000Z");
    processAliveMap = new Map<number, boolean>();

    const mockIsProcessAlive = (pid: number): boolean => {
      if (processAliveMap.has(pid)) {
        return processAliveMap.get(pid)!;
      }
      return false;
    };

    db = createSqliteClient({ location: ":memory:" });
    migrateDatabase(db);
    store = new SqliteStateStore(db, { isProcessAlive: mockIsProcessAlive });
    engine = new DurableRollbackEngine(store);
    coordinator = new RunCoordinator(store, clock);

    seedRun(RUN_1);
    seedRun(RUN_2);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function seedRun(runId: string, options?: { leaseExpiresAt?: string; status?: string }) {
    const nowIso = clock.nowIso();
    const expiresAt = options?.leaseExpiresAt ?? new Date(clock.nowMs() + 30000).toISOString();
    const status = (options?.status ?? "RUNNING") as any;

    store.transaction((tx) => {
      tx.insertTask({
        taskId: `t-${runId}`,
        title: `Task for ${runId}`,
        description: "Test task",
        inputPayload: {},
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      tx.insertWorker({
        workerId: `w-${runId}`,
        hostname: "node-1",
        pid: 1000,
        status: "ACTIVE",
        lastHeartbeatAt: nowIso,
        createdAt: nowIso,
      });

      const snapshot: RunSnapshot = {
        runId,
        taskId: `t-${runId}`,
        status,
        version: 1,
        attemptCount: 1,
        maxAttempts: 3,
        timeoutMs: 60000,
        idempotencyKey: null,
        currentWorkerId: `w-${runId}`,
        leaseId: `l-${runId}`,
        leaseExpiresAt: expiresAt,
        resultPayload: null,
        errorPayload: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        contractBinding: inProcessBinding(tx, `t-${runId}`),
        maxOutputBytes: 1048576,
      };

      tx.insertRun(snapshot, {
        eventId: `evt-created-${runId}`,
        runId,
        timestamp: nowIso,
        eventType: "run.created",
        schemaVersion: 1,
        producer: "test",
        payload: {},
      });

      tx.insertLease({
        leaseId: `l-${runId}`,
        workerId: `w-${runId}`,
        runId,
        state: "ACTIVE",
        acquiredAt: nowIso,
        expiresAt,
        releasedAt: null,
      });
    });

    store.bindRunWorkspace(runId, wsRoot, nowIso);
  }

  // ---------------------------------------------------------------------------
  // 1. Two supervisors competing to acquire recovery authority
  // ---------------------------------------------------------------------------
  it("Scenario 1: Two supervisors competing to acquire recovery authority", () => {
    const supA = "sup-alpha";
    const supB = "sup-beta";

    const leaseA = store.acquireSupervisorLease({
      runId: RUN_1,
      supervisorId: supA,
      ttlMs: 30000,
      nowIso: clock.nowIso(),
      ownerPid: 2001,
    });

    expect(leaseA.leaseId).toBeDefined();
    expect(leaseA.supervisorId).toBe(supA);
    expect(leaseA.state).toBe("ACTIVE");

    // Sup B tries to acquire while Sup A's lease is active and unexpired
    expect(() =>
      store.acquireSupervisorLease({
        runId: RUN_1,
        supervisorId: supB,
        ttlMs: 30000,
        nowIso: clock.nowIso(),
        ownerPid: 2002,
      })
    ).toThrow(SupervisorLeaseLostError);

    // Authority is exclusively held by Sup A
    const active = store.findActiveSupervisorLease(RUN_1, clock.nowIso());
    expect(active?.leaseId).toBe(leaseA.leaseId);
    expect(active?.supervisorId).toBe(supA);
  });

  // ---------------------------------------------------------------------------
  // 2. Atomic acquisition under concurrent requests
  // ---------------------------------------------------------------------------
  it("Scenario 2: Atomic acquisition under concurrent requests", () => {
    // Database enforces UNIQUE(run_id) WHERE state = 'ACTIVE'
    const acquired: string[] = [];
    const errors: Error[] = [];

    const attemptAcquisition = (supId: string) => {
      try {
        const lease = store.acquireSupervisorLease({
          runId: RUN_1,
          supervisorId: supId,
          ttlMs: 30000,
          nowIso: clock.nowIso(),
          ownerPid: 2001,
        });
        acquired.push(lease.supervisorId);
      } catch (err: unknown) {
        errors.push(err as Error);
      }
    };

    attemptAcquisition("sup-concurrent-1");
    attemptAcquisition("sup-concurrent-2");

    expect(acquired).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SupervisorLeaseLostError);

    const activeRows = db
      .prepare(`SELECT * FROM supervisor_leases WHERE run_id = ? AND state = 'ACTIVE'`)
      .all(RUN_1);
    expect(activeRows).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // 3. Stale owner attempting a recovery mutation after ownership replacement
  // ---------------------------------------------------------------------------
  it("Scenario 3: Stale owner attempting a recovery mutation after ownership replacement", async () => {
    processAliveMap.set(1001, false); // Sup A will crash
    processAliveMap.set(1002, true);  // Sup B will be alive

    const leaseA = store.acquireSupervisorLease({
      runId: RUN_1,
      supervisorId: "sup-A",
      ttlMs: 10000,
      nowIso: clock.nowIso(),
      ownerPid: 1001,
    });

    // Advance clock past leaseA expiry, Sup A is dead
    clock.advance(15000);

    // Sup B acquires fresh authority
    const leaseB = store.acquireSupervisorLease({
      runId: RUN_1,
      supervisorId: "sup-B",
      ttlMs: 30000,
      nowIso: clock.nowIso(),
      ownerPid: 1002,
    });
    expect(leaseB.leaseId).not.toBe(leaseA.leaseId);

    // 3a. Stale Sup A attempts recoverMission -> rejected
    expect(() =>
      coordinator.recoverMission({
        runId: RUN_1,
        supervisorId: "sup-A",
        supervisorLeaseId: leaseA.leaseId,
        nowIso: clock.nowIso(),
      })
    ).toThrow(SupervisorLeaseLostError);

    // 3b. Stale Sup A attempts saveCheckpoint -> rejected
    expect(() =>
      coordinator.saveCheckpoint({
        runId: RUN_1,
        checkpointVersion: 1,
        durableState: { state: "stale" },
        supervisorFencing: {
          supervisorId: "sup-A",
          leaseId: leaseA.leaseId,
        },
        nowIso: clock.nowIso(),
      })
    ).toThrow(SupervisorLeaseLostError);

    // 3c. Stale Sup A attempts executeRollback -> rejected
    await expect(
      engine.executeRollback({
        runId: RUN_1,
        workspaceRoot: wsRoot,
        authorityContext: {
          authority: "SUPERVISOR",
          supervisorFencing: {
            supervisorId: "sup-A",
            leaseId: leaseA.leaseId,
            nowIso: clock.nowIso(),
          },
        },
      })
    ).rejects.toBeInstanceOf(SupervisorLeaseLostError);

    // 3d. Stale Sup A attempts transitionMutationStatus -> rejected
    const snapFile = path.join(tempDir, "snap-01.snap");
    fs.writeFileSync(snapFile, "snapshot content");
    db.prepare(`UPDATE leases SET expires_at = '2099-01-01T00:00:00.000Z' WHERE lease_id = ?`).run(`l-${RUN_1}`);
    store.recordIntent({
      mutationId: "mut-01",
      runId: RUN_1,
      workerLeaseId: `l-${RUN_1}`,
      relativePath: "file.txt",
      canonicalPath: path.join(wsRoot, "file.txt"),
      pathMutationVersion: 1,
      parentMutationId: null,
      baseDigest: "ABSENT",
      expectedResultingDigest: sha256("HASH"),
      snapshotRef: snapFile,
      lifecycleStatus: "RECORDED",
      recoveryDedupToken: sha256("token-01"),
      conflictDetails: null,
      createdAt: clock.nowMs(),
      updatedAt: clock.nowMs(),
    });

    expect(() =>
      store.transitionMutationStatus({
        mutationId: "mut-01",
        fromStatus: "RECORDED",
        toStatus: "ABORTED_UNMUTATED",
        nextDedupToken: sha256("token-stale"),
        event: {
          eventId: "evt-stale",
          runId: RUN_1,
          timestamp: clock.nowIso(),
          eventType: "file.mutation_aborted",
          schemaVersion: 1,
          producer: "SUPERVISOR",
          payload: {},
        },
        authorityContext: {
          authority: "SUPERVISOR",
          supervisorFencing: {
            supervisorId: "sup-A",
            leaseId: leaseA.leaseId,
            nowIso: clock.nowIso(),
          },
        },
      })
    ).toThrow(SupervisorLeaseLostError);
  });

  // ---------------------------------------------------------------------------
  // 4. Stale owner attempting to release the current owner's gate
  // ---------------------------------------------------------------------------
  it("Scenario 4: Stale owner attempting to release the current owner's gate", () => {
    processAliveMap.set(1001, false);
    processAliveMap.set(1002, true);

    const leaseA = store.acquireSupervisorLease({
      runId: RUN_1,
      supervisorId: "sup-A",
      ttlMs: 5000,
      nowIso: clock.nowIso(),
      ownerPid: 1001,
    });

    clock.advance(10000);

    const leaseB = store.acquireSupervisorLease({
      runId: RUN_1,
      supervisorId: "sup-B",
      ttlMs: 30000,
      nowIso: clock.nowIso(),
      ownerPid: 1002,
    });

    // 4a. Stale owner attempts to release its own expired lease -> throws
    expect(() =>
      store.releaseSupervisorLease(leaseA.leaseId, clock.nowIso(), {
        supervisorId: "sup-A",
        leaseId: leaseA.leaseId,
      })
    ).toThrow(SupervisorLeaseLostError);

    // 4b. Stale owner attempts to release current owner B's lease using A's identity -> throws mismatch
    expect(() =>
      store.releaseSupervisorLease(leaseB.leaseId, clock.nowIso(), {
        supervisorId: "sup-A",
        leaseId: leaseB.leaseId,
      })
    ).toThrow(SupervisorLeaseLostError);

    // Sup B's lease remains ACTIVE
    const active = store.getSupervisorLease(leaseB.leaseId);
    expect(active?.state).toBe("ACTIVE");
  });

  // ---------------------------------------------------------------------------
  // 5. Current owner successfully releasing the gate
  // ---------------------------------------------------------------------------
  it("Scenario 5: Current owner successfully releasing the gate", () => {
    const lease = store.acquireSupervisorLease({
      runId: RUN_1,
      supervisorId: "sup-current",
      ttlMs: 30000,
      nowIso: clock.nowIso(),
      ownerPid: 2001,
    });

    expect(lease.state).toBe("ACTIVE");

    store.releaseSupervisorLease(lease.leaseId, clock.nowIso(), {
      supervisorId: "sup-current",
      leaseId: lease.leaseId,
    });

    const released = store.getSupervisorLease(lease.leaseId);
    expect(released?.state).toBe("RELEASED");
    expect(released?.releasedAt).toBe(clock.nowIso());

    // After release, no active lease exists
    const active = store.findActiveSupervisorLease(RUN_1, clock.nowIso());
    expect(active).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 6. Supervisor crash and safe reclamation
  // ---------------------------------------------------------------------------
  it("Scenario 6: Supervisor crash and safe reclamation", () => {
    const crashedPid = 5001;
    const newPid = 5002;

    processAliveMap.set(crashedPid, false); // Crashed (ESRCH)
    processAliveMap.set(newPid, true);

    const leaseOld = store.acquireSupervisorLease({
      runId: RUN_1,
      supervisorId: "sup-crashed",
      ttlMs: 10000,
      nowIso: clock.nowIso(),
      ownerPid: crashedPid,
    });

    clock.advance(15000); // Expired

    // New supervisor reclaims cleanly
    const leaseNew = store.acquireSupervisorLease({
      runId: RUN_1,
      supervisorId: "sup-recovered",
      ttlMs: 30000,
      nowIso: clock.nowIso(),
      ownerPid: newPid,
    });

    expect(leaseNew.leaseId).not.toBe(leaseOld.leaseId);
    expect(leaseNew.supervisorId).toBe("sup-recovered");
    expect(leaseNew.ownerPid).toBe(newPid);

    const oldAfter = store.getSupervisorLease(leaseOld.leaseId);
    expect(oldAfter?.state).toBe("EXPIRED");
  });

  // ---------------------------------------------------------------------------
  // 7. Unknown or unverifiable process liveness
  // ---------------------------------------------------------------------------
  it("Scenario 7: Unknown or unverifiable process liveness fails closed", () => {
    // 7a. Missing owner_pid (legacy/unrecorded) on expired lease -> fails closed
    store.transaction((tx) => {
      (tx as any).db
        .prepare(
          `INSERT INTO supervisor_leases (lease_id, run_id, supervisor_id, acquired_at, expires_at, state, owner_pid)
           VALUES ('l-unrecorded', ?, 'sup-legacy', ?, ?, 'ACTIVE', NULL)`
        )
        .run(
          RUN_1,
          new Date(clock.nowMs() - 20000).toISOString(),
          new Date(clock.nowMs() - 10000).toISOString()
        );
    });

    expect(() =>
      store.acquireSupervisorLease({
        runId: RUN_1,
        supervisorId: "sup-usurper",
        ttlMs: 30000,
        nowIso: clock.nowIso(),
        ownerPid: 9001,
      })
    ).toThrow(/process identity is unknown or unrecorded/i);

    // 7b. Invalid PID (<= 0) -> fails closed
    store.transaction((tx) => {
      (tx as any).db
        .prepare(`UPDATE supervisor_leases SET owner_pid = -1 WHERE lease_id = 'l-unrecorded'`)
        .run();
    });

    expect(() =>
      store.acquireSupervisorLease({
        runId: RUN_1,
        supervisorId: "sup-usurper",
        ttlMs: 30000,
        nowIso: clock.nowIso(),
        ownerPid: 9001,
      })
    ).toThrow(/process identity is unknown or unrecorded/i);
  });

  // ---------------------------------------------------------------------------
  // 8. Lease expiry while recovery work is still active
  // ---------------------------------------------------------------------------
  it("Scenario 8: Lease expiry while recovery work is still active refuses stealing", () => {
    const livePid = 7001;
    processAliveMap.set(livePid, true); // Still running work!

    store.acquireSupervisorLease({
      runId: RUN_1,
      supervisorId: "sup-active-worker",
      ttlMs: 5000,
      nowIso: clock.nowIso(),
      ownerPid: livePid,
    });

    clock.advance(10000); // TTL elapsed, but process is still alive

    // Second supervisor attempts to steal -> refused!
    expect(() =>
      store.acquireSupervisorLease({
        runId: RUN_1,
        supervisorId: "sup-thief",
        ttlMs: 30000,
        nowIso: clock.nowIso(),
        ownerPid: 7002,
      })
    ).toThrow(/is still alive; supervisor lease stealing refused/i);
  });

  // ---------------------------------------------------------------------------
  // 9. Gate acquisition failure preventing recovery mutations
  // ---------------------------------------------------------------------------
  it("Scenario 9: Gate acquisition failure preventing recovery mutations", async () => {
    // Expire worker lease so run is recovery-eligible
    store.transaction((tx) => {
      tx.updateRunLeaseExpiresAt(RUN_1, new Date(clock.nowMs() - 5000).toISOString());
    });

    // Sup A locks the run
    store.acquireSupervisorLease({
      runId: RUN_1,
      supervisorId: "sup-owner",
      ttlMs: 30000,
      nowIso: clock.nowIso(),
      ownerPid: 2001,
    });

    const supB = new RecoverySupervisor({
      stateStore: store,
      rollbackEngine: engine,
      clock,
      supervisorId: "sup-competitor",
    });

    const outcome = await supB.recoverRun(RUN_1, { workspaceRoot: wsRoot });
    expect(outcome.status).toBe("SKIPPED_LOCKED_BY_ANOTHER_SUPERVISOR");

    // Run was untouched by Sup B
    const currentRun = store.getRun(RUN_1);
    expect(currentRun?.status).toBe("RUNNING");
    expect(currentRun?.version).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 10. Recovery gate contention preserving durable run/action/attempt state
  // ---------------------------------------------------------------------------
  it("Scenario 10: Recovery gate contention preserving durable run/action/attempt state", () => {
    // Seed an action and attempt
    store.transaction((tx) => {
      const run = tx.getRun(RUN_1)!;
      const { action: act, event: actEvt } = Action.create({
        actionId: "act-10",
        runId: RUN_1,
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: { path: "test.txt" },
        contractBinding: run.contractBinding!,
        maxAttempts: 2,
        now: clock.nowIso(),
      });
      tx.insertAction(act.snapshot, actEvt);
    });

    // Sup A acquires lease
    store.acquireSupervisorLease({
      runId: RUN_1,
      supervisorId: "sup-A",
      ttlMs: 30000,
      nowIso: clock.nowIso(),
      ownerPid: 2001,
    });

    // Multiple competitors attempt acquisition and fail
    for (const competitorId of ["sup-B", "sup-C", "sup-D"]) {
      expect(() =>
        store.acquireSupervisorLease({
          runId: RUN_1,
          supervisorId: competitorId,
          ttlMs: 30000,
          nowIso: clock.nowIso(),
          ownerPid: 2002,
        })
      ).toThrow(SupervisorLeaseLostError);
    }

    // Action record remains intact
    const action = store.getAction("act-10");
    expect(action?.status).toBe("CREATED");
    expect(action?.toolName).toBe("read_file");
  });

  // ---------------------------------------------------------------------------
  // 11. Existing tenant-quiescence and worker-lease fencing compatibility
  // ---------------------------------------------------------------------------
  it("Scenario 11: Existing worker-lease fencing and quiescence guards remain active", async () => {
    // 11a: Worker lease still active -> ActiveWorkerLeaseFencingError
    const sup = new RecoverySupervisor({
      stateStore: store,
      rollbackEngine: engine,
      clock,
      supervisorId: "sup-fencer",
    });

    await expect(sup.recoverRun(RUN_1, { workspaceRoot: wsRoot })).rejects.toBeInstanceOf(
      ActiveWorkerLeaseFencingError
    );

    // 11b: Expire worker lease
    clock.advance(35000);

    // Run requires tenant quiescence if contract isolation is isolated
    // In-process binding has IN_PROCESS isolation, so it doesn't require tenant launch gate quiescence
    const run = store.getRun(RUN_1)!;
    expect(sup.runRequiresTenantQuiescence(run)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 12. Scenario 12 compatibility
  // ---------------------------------------------------------------------------
  it("Scenario 12: Verified run recovery succeeds when verified, fails closed on uncertain attempt", () => {
    clock.advance(35000); // Expire worker lease

    // Append clean_room.verified event
    store.transaction((tx) => {
      tx.appendEvent({
        eventId: "evt-clean-room-verified",
        runId: RUN_1,
        timestamp: clock.nowIso(),
        eventType: "clean_room.verified",
        schemaVersion: 1,
        producer: "clean_room",
        payload: {
          status: "VERIFIED",
          verifierId: "clean_room",
          verifiedAt: clock.nowIso(),
        },
      });
    });

    // 12a. Clean verified run recovers to COMPLETED
    const sweepResult = coordinator.recoverExpiredRuns();
    expect(sweepResult.recoveredCount).toBe(2);
    const run1 = sweepResult.runs.find((r) => r.runId === RUN_1);
    expect(run1?.status).toBe("COMPLETED");

    // 12b. Run with uncertain attempt fails closed on recovery
    seedRun("run-uncertain");
    store.transaction((tx) => {
      const run = tx.getRun("run-uncertain")!;
      tx.appendEvent({
        eventId: "evt-ver-uncertain",
        runId: "run-uncertain",
        timestamp: clock.nowIso(),
        eventType: "clean_room.verified",
        schemaVersion: 1,
        producer: "clean_room",
        payload: { status: "VERIFIED", verifierId: "clean_room", verifiedAt: clock.nowIso() },
      });

      const { action: act, event: actEvt } = Action.create({
        actionId: "act-unc",
        runId: "run-uncertain",
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: { path: "test.txt" },
        contractBinding: run.contractBinding!,
        maxAttempts: 2,
        now: clock.nowIso(),
      });
      act.authorize(clock.nowIso());
      act.startAttempt(1, clock.nowIso());
      tx.insertAction(act.snapshot, actEvt);

      const { attempt: att, event: attEvt } = Attempt.create({
        attemptId: "att-unc",
        actionId: "act-unc",
        runId: "run-uncertain",
        attemptNumber: 1,
        workerId: "w-run-uncertain",
        leaseId: "l-run-uncertain",
        now: clock.nowIso(),
      });
      const unknownAttempt: AttemptSnapshot = {
        ...att.snapshot,
        status: "UNKNOWN",
        errorPayload: { code: "EXECUTION_UNCERTAIN", reason: "uncertain failure" },
        completedAt: clock.nowIso(),
      };
      tx.insertAttempt(unknownAttempt, attEvt);
    });

    // Expire the lease for run-uncertain
    db.prepare(`UPDATE leases SET expires_at = ? WHERE run_id = ?`).run(
      new Date(clock.nowMs() - 1000).toISOString(),
      "run-uncertain"
    );
    db.prepare(`UPDATE runs SET lease_expires_at = ? WHERE run_id = ?`).run(
      new Date(clock.nowMs() - 1000).toISOString(),
      "run-uncertain"
    );

    coordinator.recoverExpiredRuns();
    const uncRun = store.getRun("run-uncertain");
    // Fails closed to FAILED, not completed
    expect(uncRun?.status).not.toBe("COMPLETED");
  });

  // ---------------------------------------------------------------------------
  // 13. Checkpoint restoration compatibility
  // ---------------------------------------------------------------------------
  it("Scenario 13: Checkpoint restoration respects supervisor fencing and evidence", () => {
    const lease = store.acquireSupervisorLease({
      runId: RUN_1,
      supervisorId: "sup-ckpt",
      ttlMs: 30000,
      nowIso: clock.nowIso(),
      ownerPid: 2001,
    });

    // Save checkpoint with valid supervisor fencing
    const latch = new PostPassVerificationLatch();
    const ckpt = coordinator.saveCheckpoint({
      runId: RUN_1,
      checkpointVersion: 1,
      durableState: {
        schemaVersion: 1,
        runId: RUN_1,
        stepCount: 5,
        actionCount: 0,
        consecutiveFailures: 0,
        proposalRejections: 0,
        consecutiveIdenticalReads: 0,
        consecutiveIdenticalWrites: 0,
        consecutiveIneffectiveEdits: 0,
        postPassLatchSnapshot: latch.getSnapshot(),
      },
      supervisorFencing: {
        supervisorId: "sup-ckpt",
        leaseId: lease.leaseId,
      },
      nowIso: clock.nowIso(),
    });
    expect(ckpt.checkpointVersion).toBe(1);

    // Reconcile checkpoint with durable evidence
    const run = store.getRun(RUN_1)!;
    const contract = store.getContract(run.contractBinding!.contractId, run.contractBinding!.version)!;
    const reconciled = reconcileCheckpointWithDurableEvidence({
      checkpoint: ckpt,
      runSnapshot: run,
      contract,
      actions: [],
      attempts: [],
      events: store.getEventsForRun(RUN_1),
      clock,
    });

    expect(reconciled.reconciledStepCount).toBe(5);
    expect(reconciled.reconciledActionCount).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 14. Recovery audit/event consistency
  // ---------------------------------------------------------------------------
  it("Scenario 14: Recovery audit/event consistency and producer traceability", () => {
    store.transaction((tx) => {
      const run = tx.getRun(RUN_1)!;
      const { action: act, event: actEvt } = Action.create({
        actionId: "act-14",
        runId: RUN_1,
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: { path: "test.txt" },
        contractBinding: run.contractBinding!,
        maxAttempts: 2,
        now: clock.nowIso(),
      });
      act.authorize(clock.nowIso());
      act.startAttempt(1, clock.nowIso());
      tx.insertAction(act.snapshot, actEvt);

      const { attempt: att, event: attEvt } = Attempt.create({
        attemptId: "att-14",
        actionId: "act-14",
        runId: RUN_1,
        attemptNumber: 1,
        workerId: `w-${RUN_1}`,
        leaseId: `l-${RUN_1}`,
        now: clock.nowIso(),
      });
      tx.insertAttempt(att.snapshot, attEvt);
    });

    const lease = store.acquireSupervisorLease({
      runId: RUN_1,
      supervisorId: "sup-auditor",
      ttlMs: 30000,
      nowIso: clock.nowIso(),
      ownerPid: 2001,
    });

    // Perform recoverMission under supervisor authority
    const result = coordinator.recoverMission({
      runId: RUN_1,
      supervisorId: "sup-auditor",
      supervisorLeaseId: lease.leaseId,
      newWorkerId: "worker-next",
      newWorkerLeaseId: "lease-next",
      nowIso: clock.nowIso(),
    });

    expect(result.checkpoint).toBeDefined();

    const events = store.getEventsForRun(RUN_1);
    const recoveryEvent = events.find((e) => e.eventType === "run.recovered");

    expect(recoveryEvent).toBeDefined();
    expect(recoveryEvent?.producer).toBe("supervisor.sup-auditor");
    expect((recoveryEvent?.payload as any)?.newWorkerId).toBe("worker-next");

    // Monotonic sequences
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.sequence).toBeGreaterThan(events[i - 1]!.sequence);
    }
  });

  // ---------------------------------------------------------------------------
  // 15. Atomic mutation fencing against preflight-to-write race condition
  // ---------------------------------------------------------------------------
  it("Scenario 15: Preflight-validated lease becoming stale before delayed mutation fails atomically inside the transaction", () => {
    processAliveMap.set(3001, false); // Sup A will crash after preflight
    processAliveMap.set(3002, true);  // Sup B will be alive

    // Step 1: Supervisor A acquires recovery authority
    const leaseA = store.acquireSupervisorLease({
      runId: RUN_1,
      supervisorId: "sup-A",
      ttlMs: 10000,
      nowIso: clock.nowIso(),
      ownerPid: 3001,
    });

    // Step 2: Supervisor A validates its lease via preflight check
    expect(() =>
      store.validateSupervisorFencing(RUN_1, {
        supervisorId: "sup-A",
        leaseId: leaseA.leaseId,
        nowIso: clock.nowIso(),
      })
    ).not.toThrow();

    // Step 3: Time advances past leaseA expiry and Sup A crashes/stalls
    clock.advance(15000);

    // Step 4: Supervisor B reclaims the expired lease and acquires recovery authority
    const leaseB = store.acquireSupervisorLease({
      runId: RUN_1,
      supervisorId: "sup-B",
      ttlMs: 30000,
      nowIso: clock.nowIso(),
      ownerPid: 3002,
    });
    expect(leaseB.leaseId).not.toBe(leaseA.leaseId);
    expect(leaseB.supervisorId).toBe("sup-B");

    // Step 5: Supervisor A attempts delayed mutations relying on its earlier preflight validation
    // 5a. Delayed saveCheckpoint must fail atomically inside the transaction
    expect(() =>
      coordinator.saveCheckpoint({
        runId: RUN_1,
        checkpointVersion: 1,
        durableState: {
          schemaVersion: 1,
          runId: RUN_1,
          stepCount: 1,
          actionCount: 0,
          consecutiveFailures: 0,
          proposalRejections: 0,
          consecutiveIdenticalReads: 0,
          consecutiveIdenticalWrites: 0,
          consecutiveIneffectiveEdits: 0,
        },
        supervisorFencing: {
          supervisorId: "sup-A",
          leaseId: leaseA.leaseId,
        },
        nowIso: clock.nowIso(),
      })
    ).toThrow(SupervisorLeaseLostError);

    // 5b. Delayed recoverMission must fail atomically inside the transaction
    expect(() =>
      coordinator.recoverMission({
        runId: RUN_1,
        supervisorId: "sup-A",
        supervisorLeaseId: leaseA.leaseId,
        newWorkerId: "worker-stale",
        newWorkerLeaseId: "lease-stale",
        nowIso: clock.nowIso(),
      })
    ).toThrow(SupervisorLeaseLostError);

    // 5c. Delayed releaseSupervisorLease must fail atomically inside the transaction
    expect(() =>
      store.releaseSupervisorLease(leaseA.leaseId, clock.nowIso(), {
        supervisorId: "sup-A",
        leaseId: leaseA.leaseId,
        nowIso: clock.nowIso(),
      })
    ).toThrow(SupervisorLeaseLostError);

    // Step 6: Verify atomic transaction isolation - zero state polluted by stale Sup A
    expect(store.getCheckpoints(RUN_1)).toHaveLength(0);
    const activeLease = store.findActiveSupervisorLease(RUN_1, clock.nowIso());
    expect(activeLease).not.toBeNull();
    expect(activeLease!.supervisorId).toBe("sup-B");
    expect(activeLease!.leaseId).toBe(leaseB.leaseId);

    // Step 7: Supervisor B can successfully perform recovery mutations
    const ckptB = coordinator.saveCheckpoint({
      runId: RUN_1,
      checkpointVersion: 1,
      durableState: {
        schemaVersion: 1,
        runId: RUN_1,
        stepCount: 1,
        actionCount: 0,
        consecutiveFailures: 0,
        proposalRejections: 0,
        consecutiveIdenticalReads: 0,
        consecutiveIdenticalWrites: 0,
        consecutiveIneffectiveEdits: 0,
      },
      supervisorFencing: {
        supervisorId: "sup-B",
        leaseId: leaseB.leaseId,
      },
      nowIso: clock.nowIso(),
    });
    expect(ckptB.checkpointVersion).toBe(1);
    expect(store.getCheckpoints(RUN_1)).toHaveLength(1);
  });
});
