import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { Action } from "../../src/domain/action.js";
import { Attempt } from "../../src/domain/attempt.js";
import {
  ContractIntegrityError,
  CheckpointVersionConflictError,
  InvalidMissionContractError,
  LeaseLostError,
  SupervisorLeaseExpiredError,
  SupervisorLeaseLostError,
} from "../../src/domain/errors.js";
import {
  createMissionContract,
  createDefaultInProcessPolicy,
  createResourceLimits,
  createVerificationSpec,
  MissionContract,
} from "../../src/domain/index.js";
import { SettableClock } from "../../src/ports/clock.port.js";

describe("Phase 32 — Mission Contract Checkpointing & Supervisor Heartbeat Fencing", () => {
  let tempDir: string;
  let dbPath: string;
  let store: SqliteStateStore;
  let clock: SettableClock;
  let coordinator: RunCoordinator;
  let boundContract: MissionContract;

  const runId = "run-p32-main";
  const taskId = "task-p32-main";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-phase32-test-"));
    dbPath = path.join(tempDir, "phase32.db");
    store = new SqliteStateStore({ location: dbPath });
    clock = new SettableClock("2026-10-18T14:00:00.000Z");
    coordinator = new RunCoordinator(store, clock);

    store.transaction((tx) => {
      tx.insertTask({
        taskId,
        title: "Phase 32 Checkpointing & Supervisor Task",
        description: "Testing contract checkpointing, supervisor leases, and multi-attempt recovery",
        inputPayload: { target: "checkpoint-test" },
        createdAt: clock.nowIso(),
        updatedAt: clock.nowIso(),
      });

      boundContract = createMissionContract({
        contractId: "contract-p32",
        version: 1,
        taskId,
        policy: createDefaultInProcessPolicy("policy-p32"),
        verificationSpecs: [
          createVerificationSpec({
            specId: "vspec-p32",
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
        pid: 2001,
        status: "ACTIVE",
        lastHeartbeatAt: clock.nowIso(),
        createdAt: clock.nowIso(),
      });

      tx.insertWorker({
        workerId: "worker-B",
        hostname: "node-2",
        pid: 2002,
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
  // T1: Exact contract binding
  // -------------------------------------------------------------------------
  it("T1: preserves exact contract binding on run inception and query", () => {
    const run = store.getRun(runId);
    expect(run).not.toBeNull();
    expect(run?.contractBinding).toEqual({
      contractId: boundContract.spec.contractId,
      version: boundContract.spec.version,
      contentHash: boundContract.contentHash,
    });
  });

  // -------------------------------------------------------------------------
  // T2: Contract hash mismatch
  // -------------------------------------------------------------------------
  it("T2: fails closed on recovery when contract content hash mismatches", () => {
    const claim = coordinator.claimSupervisorLease({ runId, supervisorId: "supervisor-1", ttlMs: 10000 });

    // Tamper with contract content hash directly in the database
    (store as any).db.prepare(
      `UPDATE mission_contracts SET content_hash = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' WHERE contract_id = ?`
    ).run(boundContract.spec.contractId);

    expect(() => {
      coordinator.recoverMission({
        runId,
        supervisorId: "supervisor-1",
        supervisorLeaseId: claim.leaseId,
      });
    }).toThrow(ContractIntegrityError);
  });

  // -------------------------------------------------------------------------
  // T3: Contract revocation
  // -------------------------------------------------------------------------
  it("T3: fails closed on recovery when bound contract has been revoked", () => {
    const claim = coordinator.claimSupervisorLease({ runId, supervisorId: "supervisor-1", ttlMs: 10000 });

    // Revoke contract
    store.transaction((tx) => {
      tx.revokeContract(boundContract.spec.contractId, boundContract.spec.version, "Security violation", clock.nowIso());
    });

    expect(() => {
      coordinator.recoverMission({
        runId,
        supervisorId: "supervisor-1",
        supervisorLeaseId: claim.leaseId,
      });
    }).toThrow(InvalidMissionContractError);
  });

  // -------------------------------------------------------------------------
  // T4: Checkpoint persistence
  // -------------------------------------------------------------------------
  it("T4: persists durable checkpoint that survives database close and reload", () => {
    const checkpoint = coordinator.saveCheckpoint({
      runId,
      checkpointVersion: 1,
      durableState: { step: "initialized", testCount: 42 },
    });

    expect(checkpoint.checkpointVersion).toBe(1);

    // Close and reopen database
    store.close();
    const reopenedStore = new SqliteStateStore({ location: dbPath });

    const latest = reopenedStore.getLatestCheckpoint(runId);
    expect(latest).not.toBeNull();
    expect(latest?.checkpointVersion).toBe(1);
    expect(latest?.durableState).toEqual({ step: "initialized", testCount: 42 });
    expect(latest?.contractBinding).toEqual(boundContract.contentHash ? {
      contractId: boundContract.spec.contractId,
      version: boundContract.spec.version,
      contentHash: boundContract.contentHash,
    } : expect.anything());

    reopenedStore.close();
    // Reopen original store handle for afterEach
    store = new SqliteStateStore({ location: dbPath });
  });

  // -------------------------------------------------------------------------
  // T5: Checkpoint monotonicity
  // -------------------------------------------------------------------------
  it("T5: rejects non-monotonic or regression checkpoint versions", () => {
    coordinator.saveCheckpoint({
      runId,
      checkpointVersion: 1,
      durableState: { progress: 10 },
    });

    coordinator.saveCheckpoint({
      runId,
      checkpointVersion: 2,
      durableState: { progress: 20 },
    });

    // Attempting to overwrite with version 1 or 2 must throw CheckpointVersionConflictError
    expect(() => {
      coordinator.saveCheckpoint({
        runId,
        checkpointVersion: 2,
        durableState: { progress: 25 },
      });
    }).toThrow(CheckpointVersionConflictError);

    expect(() => {
      coordinator.saveCheckpoint({
        runId,
        checkpointVersion: 1,
        durableState: { progress: 5 },
      });
    }).toThrow(CheckpointVersionConflictError);
  });

  // -------------------------------------------------------------------------
  // T6: Supervisor lease acquisition
  // -------------------------------------------------------------------------
  it("T6: allows valid supervisor to acquire an active supervisor lease", () => {
    const lease = coordinator.claimSupervisorLease({
      runId,
      supervisorId: "supervisor-alpha",
      ttlMs: 15000,
    });

    expect(lease.supervisorId).toBe("supervisor-alpha");
    expect(lease.state).toBe("ACTIVE");
    expect(lease.runId).toBe(runId);

    const active = coordinator.findActiveSupervisorLease(runId);
    expect(active?.leaseId).toBe(lease.leaseId);
  });

  // -------------------------------------------------------------------------
  // T7: Valid heartbeat
  // -------------------------------------------------------------------------
  it("T7: extends supervisor lease when valid heartbeat is sent before expiry", () => {
    const lease = coordinator.claimSupervisorLease({
      runId,
      supervisorId: "supervisor-alpha",
      ttlMs: 10000,
    });

    clock.advanceMs(5000);

    const renewed = coordinator.heartbeatSupervisor({
      runId,
      supervisorId: "supervisor-alpha",
      leaseId: lease.leaseId,
      ttlMs: 15000,
    });

    expect(new Date(renewed.expiresAt).getTime()).toBeGreaterThan(new Date(lease.expiresAt).getTime());
    expect(renewed.state).toBe("ACTIVE");
  });

  // -------------------------------------------------------------------------
  // T8: Expired heartbeat
  // -------------------------------------------------------------------------
  it("T8: rejects heartbeat and marks lease EXPIRED when lease duration has elapsed", () => {
    const lease = coordinator.claimSupervisorLease({
      runId,
      supervisorId: "supervisor-alpha",
      ttlMs: 5000,
    });

    // Advance clock past expiration
    clock.advanceMs(6000);

    expect(() => {
      coordinator.heartbeatSupervisor({
        runId,
        supervisorId: "supervisor-alpha",
        leaseId: lease.leaseId,
        ttlMs: 5000,
      });
    }).toThrow(SupervisorLeaseExpiredError);

    const storedLease = coordinator.getSupervisorLease(lease.leaseId);
    expect(storedLease?.state).toBe("EXPIRED");
  });

  // -------------------------------------------------------------------------
  // T9: Wrong supervisor heartbeat
  // -------------------------------------------------------------------------
  it("T9: rejects heartbeat when presented by an unauthorized supervisor", () => {
    const lease = coordinator.claimSupervisorLease({
      runId,
      supervisorId: "supervisor-alpha",
      ttlMs: 10000,
    });

    expect(() => {
      coordinator.heartbeatSupervisor({
        runId,
        supervisorId: "supervisor-beta", // Imposter
        leaseId: lease.leaseId,
      });
    }).toThrow(SupervisorLeaseLostError);
  });

  // -------------------------------------------------------------------------
  // T10: Wrong lease heartbeat
  // -------------------------------------------------------------------------
  it("T10: rejects heartbeat presented with nonexistent or wrong lease ID", () => {
    coordinator.claimSupervisorLease({
      runId,
      supervisorId: "supervisor-alpha",
      ttlMs: 10000,
    });

    expect(() => {
      coordinator.heartbeatSupervisor({
        runId,
        supervisorId: "supervisor-alpha",
        leaseId: "nonexistent-lease-uuid",
      });
    }).toThrow(SupervisorLeaseLostError);
  });

  // -------------------------------------------------------------------------
  // T11: Supervisor takeover
  // -------------------------------------------------------------------------
  it("T11: permits new supervisor to take over authority after existing lease expires", () => {
    const leaseA = coordinator.claimSupervisorLease({
      runId,
      supervisorId: "supervisor-alpha",
      ttlMs: 5000,
    });

    // Advance clock past leaseA expiration
    clock.advanceMs(6000);

    // Supervisor Beta can now claim the lease
    const leaseB = coordinator.claimSupervisorLease({
      runId,
      supervisorId: "supervisor-beta",
      ttlMs: 10000,
    });

    expect(leaseB.supervisorId).toBe("supervisor-beta");
    expect(leaseB.state).toBe("ACTIVE");

    // Old leaseA is expired
    const oldLease = coordinator.getSupervisorLease(leaseA.leaseId);
    expect(oldLease?.state).toBe("EXPIRED");
  });

  // -------------------------------------------------------------------------
  // T12: Stale supervisor recovery
  // -------------------------------------------------------------------------
  it("T12: prevents old supervisor from performing recovery after takeover", () => {
    const leaseA = coordinator.claimSupervisorLease({
      runId,
      supervisorId: "supervisor-alpha",
      ttlMs: 5000,
    });

    clock.advanceMs(6000);

    // Supervisor Beta takes over
    const leaseB = coordinator.claimSupervisorLease({
      runId,
      supervisorId: "supervisor-beta",
      ttlMs: 10000,
    });

    // Stale Supervisor Alpha attempts recovery
    expect(() => {
      coordinator.recoverMission({
        runId,
        supervisorId: "supervisor-alpha",
        supervisorLeaseId: leaseA.leaseId,
      });
    }).toThrow(SupervisorLeaseLostError);

    // Supervisor Beta can recover successfully
    const res = coordinator.recoverMission({
      runId,
      supervisorId: "supervisor-beta",
      supervisorLeaseId: leaseB.leaseId,
    });
    expect(res.checkpoint).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // T13: Recovery creates Attempt N+1
  // -------------------------------------------------------------------------
  it("T13: creates distinct Attempt N+1 with incremented attempt number during recovery", () => {
    const workerClaim = coordinator.claimRun(runId, "worker-A", 10000);
    coordinator.startRun(runId, "worker-A", workerClaim.lease.leaseId);

    const actionId = "act-p32-1";
    const { action, event: actEvt } = Action.create({
      actionId,
      runId,
      sequenceNumber: 1,
      toolName: "read_file",
      inputPayload: { path: "data.txt" },
      contractBinding: boundContract.contentHash ? {
        contractId: boundContract.spec.contractId,
        version: boundContract.spec.version,
        contentHash: boundContract.contentHash,
      } : expect.anything(),
      maxAttempts: 3,
      now: clock.nowIso(),
    });

    const { attempt: att1, event: att1Evt } = Attempt.create({
      attemptId: "att-p32-1",
      actionId,
      runId,
      attemptNumber: 1,
      workerId: "worker-A",
      leaseId: workerClaim.lease.leaseId,
      now: clock.nowIso(),
    });

    store.transaction((tx) => {
      tx.insertAction(action.snapshot, actEvt, { workerId: "worker-A", leaseId: workerClaim.lease.leaseId });
      tx.transitionAction(actionId, { type: "AUTHORIZE", now: clock.nowIso() }, () => "e1");
      tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 1, now: clock.nowIso() }, () => "e2");
      tx.insertAttempt(att1.snapshot, att1Evt, { workerId: "worker-A", leaseId: workerClaim.lease.leaseId });
      tx.transitionAttempt("att-p32-1", { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
      tx.transitionAttempt("att-p32-1", { type: "START", now: clock.nowIso() }, () => "e4");
    });

    // Advance clock and acquire supervisor lease
    clock.advanceMs(15000);
    const supLease = coordinator.claimSupervisorLease({ runId, supervisorId: "supervisor-1", ttlMs: 15000 });

    const recovery = coordinator.recoverMission({
      runId,
      supervisorId: "supervisor-1",
      supervisorLeaseId: supLease.leaseId,
    });

    expect(recovery.previousAttempt?.attemptNumber).toBe(1);
    expect(recovery.previousAttempt?.status).toBe("UNKNOWN");
    expect(recovery.newAttempt).not.toBeNull();
    expect(recovery.newAttempt?.attemptNumber).toBe(2);
    expect(recovery.newAttempt?.attemptId).not.toBe("att-p32-1");
  });

  // -------------------------------------------------------------------------
  // T14: Attempt N immutability
  // -------------------------------------------------------------------------
  it("T14: preserves Attempt 1 as frozen historical record after Attempt 2 creation", () => {
    const workerClaim = coordinator.claimRun(runId, "worker-A", 10000);
    coordinator.startRun(runId, "worker-A", workerClaim.lease.leaseId);

    const actionId = "act-p32-t14";
    const { action, event: actEvt } = Action.create({
      actionId,
      runId,
      sequenceNumber: 1,
      toolName: "read_file",
      inputPayload: { path: "data.txt" },
      contractBinding: boundContract.contentHash ? {
        contractId: boundContract.spec.contractId,
        version: boundContract.spec.version,
        contentHash: boundContract.contentHash,
      } : expect.anything(),
      maxAttempts: 3,
      now: clock.nowIso(),
    });

    const { attempt: att1, event: att1Evt } = Attempt.create({
      attemptId: "att-p32-t14-1",
      actionId,
      runId,
      attemptNumber: 1,
      workerId: "worker-A",
      leaseId: workerClaim.lease.leaseId,
      now: clock.nowIso(),
    });

    store.transaction((tx) => {
      tx.insertAction(action.snapshot, actEvt, { workerId: "worker-A", leaseId: workerClaim.lease.leaseId });
      tx.transitionAction(actionId, { type: "AUTHORIZE", now: clock.nowIso() }, () => "e1");
      tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 1, now: clock.nowIso() }, () => "e2");
      tx.insertAttempt(att1.snapshot, att1Evt, { workerId: "worker-A", leaseId: workerClaim.lease.leaseId });
      tx.transitionAttempt("att-p32-t14-1", { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
      tx.transitionAttempt("att-p32-t14-1", { type: "START", now: clock.nowIso() }, () => "e4");
    });

    clock.advanceMs(15000);
    const supLease = coordinator.claimSupervisorLease({ runId, supervisorId: "supervisor-1", ttlMs: 15000 });
    coordinator.recoverMission({ runId, supervisorId: "supervisor-1", supervisorLeaseId: supLease.leaseId });

    // Inspect Attempt 1
    const storedAtt1 = store.getAttempt("att-p32-t14-1");
    expect(storedAtt1?.status).toBe("UNKNOWN");
    expect(storedAtt1?.attemptNumber).toBe(1);
    expect(storedAtt1?.workerId).toBe("worker-A");
    expect(storedAtt1?.leaseId).toBe(workerClaim.lease.leaseId);
  });

  // -------------------------------------------------------------------------
  // T15: Contract continuity across recovery
  // -------------------------------------------------------------------------
  it("T15: guarantees recovered Attempt N+1 inherits the exact run contract binding", () => {
    const workerClaim = coordinator.claimRun(runId, "worker-A", 10000);
    coordinator.startRun(runId, "worker-A", workerClaim.lease.leaseId);

    const actionId = "act-p32-t15";
    const { action, event: actEvt } = Action.create({
      actionId,
      runId,
      sequenceNumber: 1,
      toolName: "read_file",
      inputPayload: { path: "data.txt" },
      contractBinding: boundContract.contentHash ? {
        contractId: boundContract.spec.contractId,
        version: boundContract.spec.version,
        contentHash: boundContract.contentHash,
      } : expect.anything(),
      maxAttempts: 3,
      now: clock.nowIso(),
    });

    const { attempt: att1, event: att1Evt } = Attempt.create({
      attemptId: "att-p32-t15-1",
      actionId,
      runId,
      attemptNumber: 1,
      workerId: "worker-A",
      leaseId: workerClaim.lease.leaseId,
      now: clock.nowIso(),
    });

    store.transaction((tx) => {
      tx.insertAction(action.snapshot, actEvt, { workerId: "worker-A", leaseId: workerClaim.lease.leaseId });
      tx.transitionAction(actionId, { type: "AUTHORIZE", now: clock.nowIso() }, () => "e1");
      tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 1, now: clock.nowIso() }, () => "e2");
      tx.insertAttempt(att1.snapshot, att1Evt, { workerId: "worker-A", leaseId: workerClaim.lease.leaseId });
      tx.transitionAttempt("att-p32-t15-1", { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
      tx.transitionAttempt("att-p32-t15-1", { type: "START", now: clock.nowIso() }, () => "e4");
    });

    clock.advanceMs(15000);
    const supLease = coordinator.claimSupervisorLease({ runId, supervisorId: "supervisor-1", ttlMs: 15000 });
    const recovery = coordinator.recoverMission({ runId, supervisorId: "supervisor-1", supervisorLeaseId: supLease.leaseId });

    expect(recovery.checkpoint.contractBinding).toEqual({
      contractId: boundContract.spec.contractId,
      version: boundContract.spec.version,
      contentHash: boundContract.contentHash,
    });

    const storedAction = store.getAction(actionId);
    expect(storedAction?.contractBinding).toEqual({
      contractId: boundContract.spec.contractId,
      version: boundContract.spec.version,
      contentHash: boundContract.contentHash,
    });
  });

  // -------------------------------------------------------------------------
  // T16: Concurrent recovery
  // -------------------------------------------------------------------------
  it("T16: rejects losing supervisor in concurrent recovery race with deterministic fencing error", () => {
    const supLeaseA = coordinator.claimSupervisorLease({ runId, supervisorId: "supervisor-A", ttlMs: 10000 });

    // Supervisor B attempts to claim lease while Supervisor A's lease is active
    expect(() => {
      coordinator.claimSupervisorLease({ runId, supervisorId: "supervisor-B", ttlMs: 10000 });
    }).toThrow(SupervisorLeaseLostError);

    // Supervisor A performs recovery
    const recoveryA = coordinator.recoverMission({
      runId,
      supervisorId: "supervisor-A",
      supervisorLeaseId: supLeaseA.leaseId,
    });
    expect(recoveryA.checkpoint).not.toBeNull();

    // Supervisor B cannot recover with a bogus or lost lease
    expect(() => {
      coordinator.recoverMission({
        runId,
        supervisorId: "supervisor-B",
        supervisorLeaseId: "lost-lease-b",
      });
    }).toThrow(SupervisorLeaseLostError);
  });

  // -------------------------------------------------------------------------
  // T17: Crash-safe recovery transaction
  // -------------------------------------------------------------------------
  it("T17: rolls back transaction completely upon failure, leaving no partial recovery state", () => {
    const supLease = coordinator.claimSupervisorLease({ runId, supervisorId: "supervisor-1", ttlMs: 10000 });

    // Inject failure during transaction by setting a bad contract version
    expect(() => {
      store.transaction((tx) => {
        (tx as any).validateSupervisorFencing(runId, {
          supervisorId: "supervisor-1",
          leaseId: supLease.leaseId,
          nowIso: clock.nowIso(),
        });
        tx.insertCheckpoint({
          checkpointId: "ckpt-corrupt",
          runId,
          checkpointVersion: 999,
          contractBinding: {
            contractId: "nonexistent-contract",
            version: 1,
            contentHash: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          },
          durableState: {},
          eventSequence: 1,
          createdAt: clock.nowIso(),
          updatedAt: clock.nowIso(),
        });
      });
    }).toThrow(ContractIntegrityError);

    // Verify no checkpoint was persisted
    const ckpts = store.getCheckpoints(runId);
    expect(ckpts.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // T18: Event gaplessness
  // -------------------------------------------------------------------------
  it("T18: preserves strictly monotonic gapless event sequencing across recovery and rejected operations", () => {
    const claimA = coordinator.claimRun(runId, "worker-A", 10000);
    coordinator.startRun(runId, "worker-A", claimA.lease.leaseId);

    // Cause a rejected supervisor operation
    expect(() => {
      coordinator.heartbeatSupervisor({
        runId,
        supervisorId: "supervisor-imposter",
        leaseId: "bad-lease",
      });
    }).toThrow(SupervisorLeaseLostError);

    // Valid supervisor lease and recovery
    clock.advanceMs(15000);
    const supLease = coordinator.claimSupervisorLease({ runId, supervisorId: "supervisor-1", ttlMs: 10000 });
    coordinator.recoverMission({ runId, supervisorId: "supervisor-1", supervisorLeaseId: supLease.leaseId });

    const events = store.getEventsForRun(runId);
    expect(events.length).toBeGreaterThan(0);
    for (let i = 0; i < events.length; i++) {
      expect(events[i]?.sequence).toBe(i + 1);
    }
  });

  // -------------------------------------------------------------------------
  // T19: Duplicate recovery
  // -------------------------------------------------------------------------
  it("T19: is idempotent when repeating the same recovery request without creating extra attempts", () => {
    const workerClaim = coordinator.claimRun(runId, "worker-A", 10000);
    coordinator.startRun(runId, "worker-A", workerClaim.lease.leaseId);

    const actionId = "act-p32-t19";
    const { action, event: actEvt } = Action.create({
      actionId,
      runId,
      sequenceNumber: 1,
      toolName: "read_file",
      inputPayload: { path: "data.txt" },
      contractBinding: boundContract.contentHash ? {
        contractId: boundContract.spec.contractId,
        version: boundContract.spec.version,
        contentHash: boundContract.contentHash,
      } : expect.anything(),
      maxAttempts: 3,
      now: clock.nowIso(),
    });

    const { attempt: att1, event: att1Evt } = Attempt.create({
      attemptId: "att-p32-t19-1",
      actionId,
      runId,
      attemptNumber: 1,
      workerId: "worker-A",
      leaseId: workerClaim.lease.leaseId,
      now: clock.nowIso(),
    });

    store.transaction((tx) => {
      tx.insertAction(action.snapshot, actEvt, { workerId: "worker-A", leaseId: workerClaim.lease.leaseId });
      tx.transitionAction(actionId, { type: "AUTHORIZE", now: clock.nowIso() }, () => "e1");
      tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 1, now: clock.nowIso() }, () => "e2");
      tx.insertAttempt(att1.snapshot, att1Evt, { workerId: "worker-A", leaseId: workerClaim.lease.leaseId });
      tx.transitionAttempt("att-p32-t19-1", { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
      tx.transitionAttempt("att-p32-t19-1", { type: "START", now: clock.nowIso() }, () => "e4");
    });

    clock.advanceMs(15000);
    const supLease = coordinator.claimSupervisorLease({ runId, supervisorId: "supervisor-1", ttlMs: 15000 });

    const rec1 = coordinator.recoverMission({ runId, supervisorId: "supervisor-1", supervisorLeaseId: supLease.leaseId });
    expect(rec1.newAttempt?.attemptNumber).toBe(2);

    // Second recovery invocation with same state
    const rec2 = coordinator.recoverMission({ runId, supervisorId: "supervisor-1", supervisorLeaseId: supLease.leaseId });
    expect(rec2.newAttempt?.attemptNumber).toBe(2);
    expect(rec2.newAttempt?.attemptId).toBe(rec1.newAttempt?.attemptId);

    // Total attempts for action remains 2, not 3
    const attempts = store.getAttemptsForAction(actionId);
    expect(attempts.length).toBe(2);
  });

  // -------------------------------------------------------------------------
  // T20: Checkpoint/recovery atomicity
  // -------------------------------------------------------------------------
  it("T20: guarantees checkpoint and recovery state advance together atomically", () => {
    const supLease = coordinator.claimSupervisorLease({ runId, supervisorId: "supervisor-1", ttlMs: 10000 });
    const recovery = coordinator.recoverMission({ runId, supervisorId: "supervisor-1", supervisorLeaseId: supLease.leaseId });

    const latestCheckpoint = store.getLatestCheckpoint(runId);
    expect(latestCheckpoint?.checkpointId).toBe(recovery.checkpoint.checkpointId);
    expect(latestCheckpoint?.checkpointVersion).toBe(recovery.checkpoint.checkpointVersion);
  });

  // -------------------------------------------------------------------------
  // T21: UNKNOWN attempt fail-closed
  // -------------------------------------------------------------------------
  it("T21: marks in-flight crashed attempt as UNKNOWN without altering historical execution record", () => {
    const workerClaim = coordinator.claimRun(runId, "worker-A", 10000);
    coordinator.startRun(runId, "worker-A", workerClaim.lease.leaseId);

    const actionId = "act-p32-t21";
    const { action, event: actEvt } = Action.create({
      actionId,
      runId,
      sequenceNumber: 1,
      toolName: "run_command",
      inputPayload: { command: "touch /tmp/side-effect" },
      contractBinding: boundContract.contentHash ? {
        contractId: boundContract.spec.contractId,
        version: boundContract.spec.version,
        contentHash: boundContract.contentHash,
      } : expect.anything(),
      maxAttempts: 3,
      now: clock.nowIso(),
    });

    const { attempt: att1, event: att1Evt } = Attempt.create({
      attemptId: "att-p32-t21-1",
      actionId,
      runId,
      attemptNumber: 1,
      workerId: "worker-A",
      leaseId: workerClaim.lease.leaseId,
      now: clock.nowIso(),
    });

    store.transaction((tx) => {
      tx.insertAction(action.snapshot, actEvt, { workerId: "worker-A", leaseId: workerClaim.lease.leaseId });
      tx.transitionAction(actionId, { type: "AUTHORIZE", now: clock.nowIso() }, () => "e1");
      tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 1, now: clock.nowIso() }, () => "e2");
      tx.insertAttempt(att1.snapshot, att1Evt, { workerId: "worker-A", leaseId: workerClaim.lease.leaseId });
      tx.transitionAttempt("att-p32-t21-1", { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
      tx.transitionAttempt("att-p32-t21-1", { type: "START", now: clock.nowIso() }, () => "e4");
    });

    clock.advanceMs(15000);
    const supLease = coordinator.claimSupervisorLease({ runId, supervisorId: "supervisor-1", ttlMs: 15000 });
    coordinator.recoverMission({ runId, supervisorId: "supervisor-1", supervisorLeaseId: supLease.leaseId });

    const att = store.getAttempt("att-p32-t21-1");
    expect(att?.status).toBe("UNKNOWN");
    expect(att?.errorPayload).toEqual(
      expect.objectContaining({
        reasonCode: "LEASE_EXPIRED_DURING_EXECUTION",
      })
    );
  });

  // -------------------------------------------------------------------------
  // T22: Lease fencing integration
  // -------------------------------------------------------------------------
  it("T22: ensures Phase 31 worker lease fencing rejects stale worker mutations after supervisor recovery", () => {
    const claimA = coordinator.claimRun(runId, "worker-A", 10000);
    coordinator.startRun(runId, "worker-A", claimA.lease.leaseId);

    const actionId = "act-p32-t22";
    const { action, event: actEvt } = Action.create({
      actionId,
      runId,
      sequenceNumber: 1,
      toolName: "read_file",
      inputPayload: { path: "data.txt" },
      contractBinding: boundContract.contentHash ? {
        contractId: boundContract.spec.contractId,
        version: boundContract.spec.version,
        contentHash: boundContract.contentHash,
      } : expect.anything(),
      maxAttempts: 3,
      now: clock.nowIso(),
    });

    const { attempt: att1, event: att1Evt } = Attempt.create({
      attemptId: "att-p32-t22-1",
      actionId,
      runId,
      attemptNumber: 1,
      workerId: "worker-A",
      leaseId: claimA.lease.leaseId,
      now: clock.nowIso(),
    });

    store.transaction((tx) => {
      tx.insertAction(action.snapshot, actEvt, { workerId: "worker-A", leaseId: claimA.lease.leaseId });
      tx.transitionAction(actionId, { type: "AUTHORIZE", now: clock.nowIso() }, () => "e1");
      tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 1, now: clock.nowIso() }, () => "e2");
      tx.insertAttempt(att1.snapshot, att1Evt, { workerId: "worker-A", leaseId: claimA.lease.leaseId });
      tx.transitionAttempt("att-p32-t22-1", { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
      tx.transitionAttempt("att-p32-t22-1", { type: "START", now: clock.nowIso() }, () => "e4");
    });

    clock.advanceMs(15000);
    const supLease = coordinator.claimSupervisorLease({ runId, supervisorId: "supervisor-1", ttlMs: 15000 });
    coordinator.recoverMission({ runId, supervisorId: "supervisor-1", supervisorLeaseId: supLease.leaseId });

    // Stale Worker A attempts to complete Attempt 1 using its expired worker lease
    expect(() => {
      store.transaction((tx) => {
        tx.transitionAttempt(
          "att-p32-t22-1",
          { type: "COMPLETE", outputPayload: { ok: true }, now: clock.nowIso() },
          () => "e-fail",
          { workerId: "worker-A", leaseId: claimA.lease.leaseId, nowIso: clock.nowIso() }
        );
      });
    }).toThrow(LeaseLostError);
  });

  // -------------------------------------------------------------------------
  // T23: Contract binding survives restart
  // -------------------------------------------------------------------------
  it("T23: verifies contract binding and checkpoint survive database close and reopen", () => {
    coordinator.saveCheckpoint({
      runId,
      checkpointVersion: 1,
      durableState: { stage: "persist-check" },
    });

    store.close();

    const reopenedStore = new SqliteStateStore({ location: dbPath });
    const run = reopenedStore.getRun(runId);
    expect(run?.contractBinding).toEqual({
      contractId: boundContract.spec.contractId,
      version: boundContract.spec.version,
      contentHash: boundContract.contentHash,
    });

    const ckpt = reopenedStore.getLatestCheckpoint(runId);
    expect(ckpt?.contractBinding).toEqual(run?.contractBinding);

    reopenedStore.close();
    store = new SqliteStateStore({ location: dbPath });
  });

  // -------------------------------------------------------------------------
  // T24: Full multi-attempt chain
  // -------------------------------------------------------------------------
  it("T24: executes full multi-attempt chain: Attempt 1 -> recovery -> Attempt 2 -> recovery -> Attempt 3", () => {
    const claimA = coordinator.claimRun(runId, "worker-A", 10000);
    coordinator.startRun(runId, "worker-A", claimA.lease.leaseId);

    const actionId = "act-chain-1";
    const { action, event: actEvt } = Action.create({
      actionId,
      runId,
      sequenceNumber: 1,
      toolName: "read_file",
      inputPayload: { path: "source.txt" },
      contractBinding: boundContract.contentHash ? {
        contractId: boundContract.spec.contractId,
        version: boundContract.spec.version,
        contentHash: boundContract.contentHash,
      } : expect.anything(),
      maxAttempts: 3,
      now: clock.nowIso(),
    });

    const { attempt: att1, event: att1Evt } = Attempt.create({
      attemptId: "att-chain-1",
      actionId,
      runId,
      attemptNumber: 1,
      workerId: "worker-A",
      leaseId: claimA.lease.leaseId,
      now: clock.nowIso(),
    });

    store.transaction((tx) => {
      tx.insertAction(action.snapshot, actEvt, { workerId: "worker-A", leaseId: claimA.lease.leaseId });
      tx.transitionAction(actionId, { type: "AUTHORIZE", now: clock.nowIso() }, () => "e1");
      tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 1, now: clock.nowIso() }, () => "e2");
      tx.insertAttempt(att1.snapshot, att1Evt, { workerId: "worker-A", leaseId: claimA.lease.leaseId });
      tx.transitionAttempt("att-chain-1", { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
      tx.transitionAttempt("att-chain-1", { type: "START", now: clock.nowIso() }, () => "e4");
    });

    // 1. Worker A crashes -> Supervisor 1 recovers -> Creates Attempt 2
    clock.advanceMs(15000);
    const supLease1 = coordinator.claimSupervisorLease({ runId, supervisorId: "supervisor-1", ttlMs: 15000 });
    const rec1 = coordinator.recoverMission({ runId, supervisorId: "supervisor-1", supervisorLeaseId: supLease1.leaseId });
    expect(rec1.newAttempt?.attemptNumber).toBe(2);

    // 2. Attempt 2 runs and fails
    clock.advanceMs(5000);
    store.transaction((tx) => {
      tx.transitionAttempt(
        rec1.newAttempt!.attemptId,
        { type: "DISPATCH", now: clock.nowIso() },
        () => "e-disp-2"
      );
      tx.transitionAttempt(
        rec1.newAttempt!.attemptId,
        { type: "START", now: clock.nowIso() },
        () => "e-start-2"
      );
      tx.transitionAttempt(
        rec1.newAttempt!.attemptId,
        { type: "FAIL", errorPayload: { message: "File locked" }, exitCode: 1, now: clock.nowIso() },
        () => "e-fail-2"
      );
    });

    // 3. Supervisor 1 recovers again -> Creates Attempt 3
    const rec2 = coordinator.recoverMission({ runId, supervisorId: "supervisor-1", supervisorLeaseId: supLease1.leaseId });
    expect(rec2.newAttempt?.attemptNumber).toBe(3);

    // 4. Verify full multi-attempt chain integrity
    const allAttempts = store.getAttemptsForAction(actionId);
    expect(allAttempts.length).toBe(3);
    expect(allAttempts[0]?.attemptNumber).toBe(1);
    expect(allAttempts[0]?.status).toBe("UNKNOWN");
    expect(allAttempts[1]?.attemptNumber).toBe(2);
    expect(allAttempts[1]?.status).toBe("FAILED");
    expect(allAttempts[2]?.attemptNumber).toBe(3);
    expect(allAttempts[2]?.status).toBe("CREATED");

    // Verify all checkpoints exist and are monotonic
    const ckpts = store.getCheckpoints(runId);
    expect(ckpts.length).toBe(2);
    expect(ckpts[0]?.checkpointVersion).toBe(1);
    expect(ckpts[1]?.checkpointVersion).toBe(2);

    // Verify events are strictly gapless
    const events = store.getEventsForRun(runId);
    expect(events.length).toBeGreaterThan(0);
    for (let i = 0; i < events.length; i++) {
      expect(events[i]?.sequence).toBe(i + 1);
    }
  });
});
