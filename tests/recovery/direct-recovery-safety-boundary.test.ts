/**
 * Emerald Agent Fabric — Recovery Safety Boundary Remediation Tests (Milestone 2.4A.9).
 *
 * Verifies that:
 * 1. Direct calls to RetryCoordinator.recoverExpiredRuns cannot dispose workspaces or requeue runs
 *    when tenant quiescence has not been affirmatively established (Invariant A).
 * 2. Direct calls to RecoverySupervisor.scanAndRecover / recoverRun cannot roll back workspaces
 *    without affirmative tenant quiescence verification (Invariant A).
 * 3. Quarantine status in tenant_launch_gates durably blocks worker execution attempts (Invariant C & D).
 * 4. Gate expiration does not allow workers to steal quarantined or unresolved gates (Invariant B & E).
 * 5. Stale gate owners cannot release another owner's gate (Invariant E).
 * 6. Crashes during recovery preserve fail-closed invariants on subsequent attempts (Invariant F).
 * 7. Affirmative proof of quiescence unlocks recovery safely and idempotently.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { SqliteTenantLaunchCoordinator, InMemoryTenantLaunchCoordinator } from "../../src/adapters/coordination/sqlite-tenant-launch-coordinator.js";
import { RunCoordinator } from "../../src/application/index.js";
import { createExecutionPolicy, createDefaultInProcessPolicy } from "../../src/domain/policy.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import type { QuiescenceResult, TenantQuiescencePort } from "../../src/ports/tenant-quiescence.port.js";
import { MissingMutationAuthorityError, TenantLaunchGateConflictError, TenantLaunchGateTimeoutError, TenantQuiescenceRequiredError, WorkspaceBindingConflictError } from "../../src/domain/errors.js";
import { DurableRollbackEngine } from "../../src/recovery/durable-rollback-engine.js";
import { RecoverySupervisor } from "../../src/recovery/recovery-supervisor.js";
import { RecoverySweeper } from "../../src/recovery/recovery-sweeper.js";
import { runTenantQuiescencePrePass, tenantModelFromContract } from "../../src/recovery/tenant-quiescence-gate.js";
import { createAndActivateContract } from "../application/test-helpers.js";

describe("Milestone 2.4A.9: Recovery Safety Boundary Remediation", () => {
  let tempDir: string;
  let root: string;
  let clock: SettableClock;
  let store: SqliteStateStore;
  let adapter: NodeFsWorkspaceAdapter;
  let coordinator: RunCoordinator;
  let launchCoordinator: SqliteTenantLaunchCoordinator;
  let quiescenceVerdict: QuiescenceResult;
  const quiescenceQueries: string[] = [];

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "emerald-recovery-boundary-")));
    root = path.join(tempDir, "workspaces");
    fs.mkdirSync(root, { recursive: true });
    clock = new SettableClock(new Date().toISOString());
    store = new SqliteStateStore(undefined, { isProcessAlive: () => false });
    adapter = new NodeFsWorkspaceAdapter({ workspaceRoot: root });
    coordinator = new RunCoordinator(store, clock, undefined, adapter);
    launchCoordinator = new SqliteTenantLaunchCoordinator(store, clock);
    quiescenceVerdict = { status: "UNVERIFIED", reason: "container still active in daemon" };
    quiescenceQueries.length = 0;
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const mockQuiescencePort: TenantQuiescencePort = {
    quiesceRun: async (runId: string): Promise<QuiescenceResult> => {
      quiescenceQueries.push(runId);
      return quiescenceVerdict;
    },
  };

  function createIsolatedRun(taskIdSuffix: string) {
    const task = coordinator.createTask({ title: `task-${taskIdSuffix}`, inputPayload: { mode: "isolated" } });
    createAndActivateContract(store, task.taskId, {
      policy: createExecutionPolicy({
        policyId: `p-${taskIdSuffix}`,
        allowedCapabilities: ["execution.echo"],
        isolationRequirement: "ISOLATED",
        trustedInProcessOperations: [],
      }),
    });
    const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3, timeoutMs: 15_000 });
    return { task, run };
  }

  async function provisionAndStartRun(runId: string, workerId = "worker-1", ttlMs = 5000) {
    coordinator.registerWorker({
      workerId,
      hostname: "localhost",
      pid: process.pid,
      status: "ACTIVE",
      lastHeartbeatAt: clock.nowIso(),
      createdAt: clock.nowIso(),
    });
    coordinator.queueRun(runId);
    const claim = coordinator.claimRun(runId, workerId, ttlMs);
    coordinator.startRun(runId, workerId, claim.lease.leaseId);

    const ws = await adapter.provisionWorkspace(
      { workspaceId: `ws-${runId}`, runId, taskId: "task", maxWorkspaceBytes: 1048576, maxFileSizeBytes: 1048576 } as never,
      { runId, leaseId: claim.lease.leaseId }
    );
    fs.writeFileSync(path.join(ws.hostPath, "active_data.txt"), "live tenant mutation");
    return { claim, ws };
  }

  // 1. Direct recoverExpiredRuns invocation with UNVERIFIED quiescence does not dispose workspace or requeue
  it("Scenario 1: Direct recoverExpiredRuns invocation without quiescence proof does not dispose workspace or requeue", async () => {
    const { run } = createIsolatedRun("sc1");
    const { ws } = await provisionAndStartRun(run.runId);

    // Lease expires
    clock.advanceMs(6000);

    // Direct invocation without quiescedRunIds
    const result = coordinator.recoverExpiredRuns();

    // Must be held, not recovered
    expect(result.recoveredCount).toBe(0);
    expect(result.heldForQuiescenceRunIds).toContain(run.runId);

    // Run must remain in RUNNING status in DB
    const freshRun = coordinator.getRun(run.runId);
    expect(freshRun!.status).toBe("RUNNING");

    // Workspace MUST be preserved on disk
    expect(fs.existsSync(path.join(ws.hostPath, "active_data.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(ws.hostPath, "active_data.txt"), "utf8")).toBe("live tenant mutation");
  });

  // 2. Direct scanAndRecover invocation with UNVERIFIED quiescence does not execute rollback
  it("Scenario 2: Direct scanAndRecover invocation without quiescence proof does not execute rollback", async () => {
    const { run } = createIsolatedRun("sc2");
    const { ws, claim } = await provisionAndStartRun(run.runId);

    // Record an active mutation intent
    store.recordIntent({
      mutationId: "mut-sc2",
      runId: run.runId,
      workerLeaseId: claim.lease.leaseId,
      relativePath: "file.txt",
      canonicalPath: path.join(ws.hostPath, "file.txt"),
      pathMutationVersion: 1,
      parentMutationId: null,
      baseDigest: "0".repeat(64),
      expectedResultingDigest: "1".repeat(64),
      snapshotRef: "snap-1",
      recoveryDedupToken: "2".repeat(64),
      lifecycleStatus: "RECORDED",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    clock.advanceMs(6000);

    const supervisor = new RecoverySupervisor({
      stateStore: store,
      rollbackEngine: new DurableRollbackEngine(store),
      clock,
      supervisorId: "sup-sc2",
    });

    // Direct invocation without quiescedRunIds
    const scan = await supervisor.scanAndRecover();

    expect(scan.recoveredCount).toBe(0);
    expect(scan.outcomes.some((o) => o.runId === run.runId && o.status === "SKIPPED_TENANTS_NOT_QUIESCED")).toBe(true);

    // Workspace remains intact
    expect(fs.existsSync(path.join(ws.hostPath, "active_data.txt"))).toBe(true);
  });

  // 3. A worker cannot acquire execution authorization for a tenant/run while an unresolved prior attempt is quarantined
  it("Scenario 3: Worker cannot acquire execution authorization while run is quarantined", async () => {
    const { run } = createIsolatedRun("sc3");

    // Place the gate into QUARANTINED state
    store.quarantineTenantLaunchGate({
      runId: run.runId,
      nowIso: clock.nowIso(),
      reason: "Prior container termination unverified",
    });

    // Direct store acquisition MUST reject with TenantLaunchGateConflictError
    expect(() =>
      store.acquireTenantLaunchGate({
        runId: run.runId,
        holderType: "WORKER",
        holderId: "worker-new",
        leaseId: "lease-new",
        ttlMs: 30000,
        nowIso: clock.nowIso(),
      })
    ).toThrow(TenantLaunchGateConflictError);

    // Worker attempts to acquire launch gate through coordinator (times out fail-closed with quarantine error)
    await expect(
      launchCoordinator.acquire({
        runId: run.runId,
        holderType: "WORKER",
        holderId: "worker-new",
        leaseId: "lease-new",
        ttlMs: 30000,
        timeoutMs: 100,
      })
    ).rejects.toThrow(/QUARANTINED/);
  });

  // 4. Gate expiry does not automatically bypass unresolved execution safety
  it("Scenario 4: Gate expiry does not allow worker lock stealing for quarantined execution", async () => {
    const { run } = createIsolatedRun("sc4");

    // Quarantine the gate
    store.quarantineTenantLaunchGate({
      runId: run.runId,
      nowIso: clock.nowIso(),
      reason: "Unresolved background container",
    });

    // Advance clock past nominal 30s TTL
    clock.advanceMs(100_000);

    // Direct store acquisition MUST still reject with TenantLaunchGateConflictError
    expect(() =>
      store.acquireTenantLaunchGate({
        runId: run.runId,
        holderType: "WORKER",
        holderId: "worker-late",
        leaseId: "lease-late",
        ttlMs: 30000,
        nowIso: clock.nowIso(),
      })
    ).toThrow(TenantLaunchGateConflictError);

    // Worker coordinator acquisition MUST still fail closed
    await expect(
      launchCoordinator.acquire({
        runId: run.runId,
        holderType: "WORKER",
        holderId: "worker-late",
        leaseId: "lease-late",
        ttlMs: 30000,
        timeoutMs: 100,
      })
    ).rejects.toThrow(/QUARANTINED/);
  });

  // 5. A stale gate owner cannot release a newer owner's gate
  it("Scenario 5: Stale gate owner cannot release another owner's gate", async () => {
    const { run } = createIsolatedRun("sc5");

    // Owner 1 acquires
    const gate1 = await launchCoordinator.acquire({
      runId: run.runId,
      holderType: "RECOVERY",
      holderId: "supervisor-1",
      leaseId: "lease-1",
      ttlMs: 1000,
      timeoutMs: 500,
    });

    // Owner 1 expires, Owner 2 reclaims
    clock.advanceMs(2000);
    const gate2 = await launchCoordinator.acquire({
      runId: run.runId,
      holderType: "RECOVERY",
      holderId: "supervisor-2",
      leaseId: "lease-2",
      ttlMs: 30000,
      timeoutMs: 500,
    });

    expect(gate2.token).not.toBe(gate1.token);

    // Stale owner 1 attempts release
    await launchCoordinator.release(gate1);

    // Gate must remain ACQUIRED by supervisor-2
    const currentGate = store.getTenantLaunchGate(run.runId);
    expect(currentGate!.state).toBe("ACQUIRED");
    expect(currentGate!.token).toBe(gate2.token);
    expect(currentGate!.holderId).toBe("supervisor-2");
  });

  // 6. Recovery crash during quiescence preserves workspace safety on next recovery attempt
  it("Scenario 6: Recovery crash during quiescence preserves workspace safety", async () => {
    const { run } = createIsolatedRun("sc6");
    const { ws } = await provisionAndStartRun(run.runId);
    clock.advanceMs(6000);

    const throwingPort: TenantQuiescencePort = {
      quiesceRun: async () => {
        throw new Error("Simulated recovery crash mid-quiescence");
      },
    };

    const sweeper = new RecoverySweeper({
      supervisor: new RecoverySupervisor({
        stateStore: store,
        rollbackEngine: new DurableRollbackEngine(store),
        clock,
        supervisorId: "sup-sc6",
      }),
      coordinator,
      tenantQuiescence: {
        tenantModelOf: tenantModelFromContract((id, v) => coordinator.getContract(id, v)),
        port: throwingPort,
      },
    });

    const result = await sweeper.sweepOnce();
    expect(result.heldForTenantsRunIds).toContain(run.runId);

    // Run untouched
    expect(coordinator.getRun(run.runId)!.status).toBe("RUNNING");
    expect(fs.readFileSync(path.join(ws.hostPath, "active_data.txt"), "utf8")).toBe("live tenant mutation");

    // Gate was quarantined
    const gate = store.getTenantLaunchGate(run.runId);
    expect(gate!.state).toBe("QUARANTINED");
  });

  // 7. Recovery crash after quiescence but before durable transition causes next attempt to re-establish
  it("Scenario 7: Interrupted recovery re-establishes required safety conditions", async () => {
    const { run } = createIsolatedRun("sc7");
    await provisionAndStartRun(run.runId);
    clock.advanceMs(6000);

    // Simulate pre-pass proved QUIESCENT, but supervisor/sweeper crashed before run commit
    // Gate remains held by previous recovery process
    await launchCoordinator.acquire({
      runId: run.runId,
      holderType: "RECOVERY",
      holderId: "crashed-recovery",
      leaseId: "rec-lease-1",
      ttlMs: 5000,
      timeoutMs: 1000,
      ownerPid: 99999999, // dead PID
    });

    clock.advanceMs(6000);

    // Next sweep starts fresh with live supervisor
    let reProbed = false;
    const rePort: TenantQuiescencePort = {
      quiesceRun: async () => {
        reProbed = true;
        return { status: "QUIESCENT", stopped: 0 };
      },
    };

    const sweeper = new RecoverySweeper({
      supervisor: new RecoverySupervisor({
        stateStore: store,
        rollbackEngine: new DurableRollbackEngine(store),
        clock,
        supervisorId: "sup-fresh",
      }),
      coordinator,
      tenantQuiescence: {
        tenantModelOf: tenantModelFromContract((id, v) => coordinator.getContract(id, v)),
        port: rePort,
      },
    });

    const result = await sweeper.sweepOnce();
    expect(reProbed).toBe(true);
    expect(result.heldForTenantsRunIds).toEqual([]);
    expect(coordinator.getRun(run.runId)!.status).toBe("QUEUED");
  });

  // 8. Subsequent sweep that establishes quiescence safely resumes recovery
  it("Scenario 8: Subsequent sweep establishing quiescence safely resumes recovery", async () => {
    const { run } = createIsolatedRun("sc8");
    const { ws } = await provisionAndStartRun(run.runId);
    clock.advanceMs(6000);

    // Sweep 1: UNVERIFIED
    quiescenceVerdict = { status: "UNVERIFIED", reason: "container busy" };
    const sweeper1 = new RecoverySweeper({
      supervisor: new RecoverySupervisor({ stateStore: store, rollbackEngine: new DurableRollbackEngine(store), clock, supervisorId: "sup-sc8" }),
      coordinator,
      tenantQuiescence: { tenantModelOf: tenantModelFromContract((id, v) => coordinator.getContract(id, v)), port: mockQuiescencePort },
    });

    const res1 = await sweeper1.sweepOnce();
    expect(res1.heldForTenantsRunIds).toContain(run.runId);
    expect(fs.existsSync(path.join(ws.hostPath, "active_data.txt"))).toBe(true);

    // Sweep 2: QUIESCENT
    quiescenceVerdict = { status: "QUIESCENT", stopped: 1 };
    const res2 = await sweeper1.sweepOnce();
    expect(res2.heldForTenantsRunIds).toEqual([]);
    expect(coordinator.getRun(run.runId)!.status).toBe("QUEUED");
    expect(fs.existsSync(ws.hostPath)).toBe(false); // cleanly disposed
  });

  // 9. Docker daemon errors, malformed output, unknown process liveness fail closed
  it("Scenario 9: Quiescence adapter failures fail closed and quarantine run", async () => {
    const { run } = createIsolatedRun("sc9");
    const { ws } = await provisionAndStartRun(run.runId);
    clock.advanceMs(6000);

    quiescenceVerdict = { status: "UNVERIFIED", reason: "Docker daemon socket ECONNREFUSED" };
    const sweeper = new RecoverySweeper({
      supervisor: new RecoverySupervisor({ stateStore: store, rollbackEngine: new DurableRollbackEngine(store), clock, supervisorId: "sup-sc9" }),
      coordinator,
      tenantQuiescence: { tenantModelOf: tenantModelFromContract((id, v) => coordinator.getContract(id, v)), port: mockQuiescencePort },
    });

    const result = await sweeper.sweepOnce();
    expect(result.heldForTenantsRunIds).toContain(run.runId);
    expect(coordinator.getRun(run.runId)!.status).toBe("RUNNING");
    expect(fs.existsSync(path.join(ws.hostPath, "active_data.txt"))).toBe(true);

    const gate = store.getTenantLaunchGate(run.runId);
    expect(gate!.state).toBe("QUARANTINED");
  });

  // 10. Existing clean-cancellation and successful-recovery paths remain compatible
  it("Scenario 10: In-process runs recover cleanly without requiring external quiescence port", async () => {
    const task = coordinator.createTask({ title: "in-proc", inputPayload: {} });
    createAndActivateContract(store, task.taskId, {
      policy: createDefaultInProcessPolicy("p-inproc"),
    });
    const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3, timeoutMs: 15_000 });
    const { ws } = await provisionAndStartRun(run.runId);
    clock.advanceMs(6000);

    // Direct invocation without options
    const recovery = coordinator.recoverExpiredRuns();
    expect(recovery.recoveredCount).toBe(1);
    expect(coordinator.getRun(run.runId)!.status).toBe("QUEUED");
    expect(fs.existsSync(ws.hostPath)).toBe(false);
  });

  // 11. Concurrent recovery calls cannot both mutate or requeue the same run
  it("Scenario 11: Concurrent recovery callers are serialized by launch gate", async () => {
    const { run } = createIsolatedRun("sc11");
    await provisionAndStartRun(run.runId);
    clock.advanceMs(6000);

    quiescenceVerdict = { status: "QUIESCENT", stopped: 1 };
    const sweeperA = new RecoverySweeper({
      supervisor: new RecoverySupervisor({ stateStore: store, rollbackEngine: new DurableRollbackEngine(store), clock, supervisorId: "sup-A" }),
      coordinator,
      tenantQuiescence: { tenantModelOf: tenantModelFromContract((id, v) => coordinator.getContract(id, v)), port: mockQuiescencePort },
    });

    // Run two sweeps in parallel
    const [resA, resB] = await Promise.allSettled([
      sweeperA.sweepOnce(),
      sweeperA.sweepOnce(),
    ]);

    // One succeeds, second rejected by concurrency guard
    const succeeded = [resA, resB].filter((r) => r.status === "fulfilled");
    const rejected = [resA, resB].filter((r) => r.status === "rejected");
    expect(succeeded.length).toBe(1);
    expect(rejected.length).toBe(1);
  });

  // 12. No test relies solely on an in-memory heldRunIds set as proof of durable safety
  it("Scenario 12: Durable safety does not rely on in-memory state across process restart", async () => {
    const { run } = createIsolatedRun("sc12");
    const { ws } = await provisionAndStartRun(run.runId);

    // Gate quarantined durably in SQLite
    store.quarantineTenantLaunchGate({
      runId: run.runId,
      nowIso: clock.nowIso(),
      reason: "Prior attempt unverified",
    });

    clock.advanceMs(6000);

    // Simulate new process instance with fresh memory
    const freshCoordinator = new RunCoordinator(store, clock, undefined, adapter);

    // Direct recovery call in fresh process
    const result = freshCoordinator.recoverExpiredRuns();

    // Must be held, not requeued
    expect(result.recoveredCount).toBe(0);
    expect(result.heldForQuiescenceRunIds).toContain(run.runId);
    expect(freshCoordinator.getRun(run.runId)!.status).toBe("RUNNING");
    expect(fs.existsSync(path.join(ws.hostPath, "active_data.txt"))).toBe(true);
  });

  // 13. (F-01 Remediation) Worker cannot reclaim or steal a gate previously held by a crashed recovery supervisor
  it("Scenario 13: Worker cannot reclaim gate previously held by crashed recovery supervisor", async () => {
    const { run } = createIsolatedRun("sc13");
    await provisionAndStartRun(run.runId);
    clock.advanceMs(6000);

    // Prior recovery supervisor acquired the gate and subsequently crashed
    await launchCoordinator.acquire({
      runId: run.runId,
      holderType: "RECOVERY",
      holderId: "crashed-supervisor-1",
      leaseId: "rec-lease-1",
      ttlMs: 2000,
      ownerPid: 99999999, // dead PID
    });

    // Advance clock past supervisor gate nominal TTL
    clock.advanceMs(4000);

    // Direct store acquisition by a WORKER must be refused fail-closed (F-01)
    expect(() =>
      store.acquireTenantLaunchGate({
        runId: run.runId,
        holderType: "WORKER",
        holderId: "worker-thief",
        leaseId: "lease-thief",
        ttlMs: 30000,
        nowIso: clock.nowIso(),
      })
    ).toThrow(TenantLaunchGateConflictError);

    // Coordinator acquisition by a WORKER must also fail closed
    await expect(
      launchCoordinator.acquire({
        runId: run.runId,
        holderType: "WORKER",
        holderId: "worker-thief",
        leaseId: "lease-thief",
        ttlMs: 30000,
        timeoutMs: 100,
      })
    ).rejects.toThrow();

    // Conversely, a new live RECOVERY supervisor is permitted to reclaim the gate
    const liveRecGate = await launchCoordinator.acquire({
      runId: run.runId,
      holderType: "RECOVERY",
      holderId: "live-supervisor-2",
      leaseId: "rec-lease-2",
      ttlMs: 30000,
      ownerPid: process.pid,
    });
    expect(liveRecGate.holderId).toBe("live-supervisor-2");
    expect(liveRecGate.holderType).toBe("RECOVERY");
    await launchCoordinator.release(liveRecGate);
  });

  // 14. (F-02 Remediation) RunCoordinator.recoverMission() requires affirmative tenant quiescence verification
  it("Scenario 14: Direct recoverMission() without quiescent gate throws TenantQuiescenceRequiredError", async () => {
    const { run } = createIsolatedRun("sc14");
    await provisionAndStartRun(run.runId);
    clock.advanceMs(6000);

    const supLease = coordinator.claimSupervisorLease({
      runId: run.runId,
      supervisorId: "sup-sc14",
      ttlMs: 15000,
    });

    // Direct invocation without QUIESCED gate MUST fail closed with TenantQuiescenceRequiredError
    expect(() =>
      coordinator.recoverMission({
        runId: run.runId,
        supervisorId: "sup-sc14",
        supervisorLeaseId: supLease.leaseId,
      })
    ).toThrow(TenantQuiescenceRequiredError);

    // Acquire gate as RECOVERY and mark it QUIESCED (authoritative durable proof)
    const gate = await launchCoordinator.acquire({
      runId: run.runId,
      holderType: "RECOVERY",
      holderId: "sup-sc14",
      leaseId: supLease.leaseId,
      ttlMs: 30000,
    });
    await launchCoordinator.markQuiescent(gate);

    // Now recoverMission succeeds, bound to the gate generation this supervisor acquired
    const recResult = coordinator.recoverMission({
      runId: run.runId,
      supervisorId: "sup-sc14",
      supervisorLeaseId: supLease.leaseId,
      gateToken: gate.token,
    });
    expect(recResult.run.runId).toBe(run.runId);
    expect(recResult.checkpoint).toBeDefined();

    // Cleanup gate
    await launchCoordinator.release(gate);
  });

  // 15. (F-03 Remediation) Public recovery methods reject fabricated quiescedRunIds without durable QUIESCED gate
  it("Scenario 15: Public recovery methods reject caller-supplied quiescedRunIds without durable QUIESCED gate", async () => {
    const { run } = createIsolatedRun("sc15");
    const { ws, claim } = await provisionAndStartRun(run.runId);

    // Record an active mutation intent
    store.recordIntent({
      mutationId: "mut-sc15",
      runId: run.runId,
      workerLeaseId: claim.lease.leaseId,
      relativePath: "file.txt",
      canonicalPath: path.join(ws.hostPath, "file.txt"),
      pathMutationVersion: 1,
      parentMutationId: null,
      baseDigest: "0".repeat(64),
      expectedResultingDigest: "1".repeat(64),
      snapshotRef: "snap-15",
      recoveryDedupToken: "2".repeat(64),
      lifecycleStatus: "RECORDED",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    clock.advanceMs(6000);

    // Adversarial caller fabricates quiescedRunIds pointing to run.runId
    // but the gate in SQLite is NOT QUIESCED
    const supervisor = new RecoverySupervisor({
      stateStore: store,
      rollbackEngine: new DurableRollbackEngine(store),
      clock,
      supervisorId: "sup-sc15",
    });

    const scanOutcome = await supervisor.recoverRun(run.runId, {
      quiescedRunIds: new Set([run.runId]),
    });
    expect(scanOutcome.status).toBe("SKIPPED_TENANTS_NOT_QUIESCED");

    // Similarly for recoverExpiredRuns
    const retryResult = coordinator.recoverExpiredRuns({
      quiescedRunIds: new Set([run.runId]),
    });
    expect(retryResult.recoveredCount).toBe(0);
    expect(retryResult.heldForQuiescenceRunIds).toContain(run.runId);

    // Workspace remains intact
    expect(fs.existsSync(path.join(ws.hostPath, "active_data.txt"))).toBe(true);
  });

  // 16. Full lifecycle: sweep transitions gate to QUIESCED, executes rollback, releases gate, and allows Attempt 2
  it("Scenario 16: Legitimate quiescence flow transitions gate to QUIESCED, releases gate, and permits subsequent worker", async () => {
    const { run } = createIsolatedRun("sc16");
    await provisionAndStartRun(run.runId);
    clock.advanceMs(6000);

    quiescenceVerdict = { status: "QUIESCENT", stopped: 1 };
    const sweeper = new RecoverySweeper({
      supervisor: new RecoverySupervisor({
        stateStore: store,
        rollbackEngine: new DurableRollbackEngine(store),
        clock,
        supervisorId: "sup-sc16",
      }),
      coordinator,
      tenantQuiescence: {
        tenantModelOf: tenantModelFromContract((id, v) => coordinator.getContract(id, v)),
        port: mockQuiescencePort,
      },
    });

    const sweepResult = await sweeper.sweepOnce();
    expect(sweepResult.heldForTenantsRunIds).toEqual([]);
    expect(sweepResult.retry.recoveredCount).toBe(1);

    // Gate must be RELEASED in SQLite after recovery completes
    const gateInStore = store.getTenantLaunchGate(run.runId);
    expect(gateInStore?.state).toBe("RELEASED");

    // Run is QUEUED for Attempt 2
    const freshRun = coordinator.getRun(run.runId);
    expect(freshRun!.status).toBe("QUEUED");
    expect(freshRun!.attemptCount).toBe(1);

    // Worker 2 can now acquire the gate cleanly for Attempt 2
    coordinator.registerWorker({
      workerId: "worker-2",
      hostname: "localhost",
      pid: process.pid,
      status: "ACTIVE",
      lastHeartbeatAt: clock.nowIso(),
      createdAt: clock.nowIso(),
    });
    const claim2 = coordinator.claimRun(run.runId, "worker-2", 5000);
    const worker2Gate = await launchCoordinator.acquire({
      runId: run.runId,
      holderType: "WORKER",
      holderId: "worker-2",
      leaseId: claim2.lease.leaseId,
      ttlMs: 5000,
    });
    expect(worker2Gate.state).toBe("ACQUIRED");
    expect(worker2Gate.holderId).toBe("worker-2");
    await launchCoordinator.release(worker2Gate);
  });

  // 17. (Milestone 2.4A.15 Finding-01) Recovery supervisor takeover of QUIESCED gate enforces process liveness and lease fencing
  it("Scenario 17: Second recovery supervisor cannot steal a QUIESCED gate after nominal TTL while the first supervisor is alive or holds an active lease", async () => {
    const { run } = createIsolatedRun("sc17");

    const livePids = new Set<number>([11111]);
    (store as any).isProcessAlive = (pid: number) => livePids.has(pid);

    const gateA = await launchCoordinator.acquire({
      runId: run.runId,
      holderType: "RECOVERY",
      holderId: "sup-A",
      leaseId: "lease-sup-A",
      ownerPid: 11111,
      ttlMs: 2000,
    });
    await launchCoordinator.markQuiescent(gateA);

    // Active lease for sup-A
    store.acquireSupervisorLease({
      runId: run.runId,
      supervisorId: "sup-A",
      ttlMs: 10_000,
      nowIso: clock.nowIso(),
    });

    // Advance clock past gate TTL (2000ms) but within supervisor lease (10000ms)
    clock.advanceMs(3000);

    // sup-B attempts takeover via direct store call (throws TenantLaunchGateConflictError)
    expect(() =>
      store.acquireTenantLaunchGate({
        runId: run.runId,
        holderType: "RECOVERY",
        holderId: "sup-B",
        leaseId: "lease-sup-B",
        ownerPid: 22222,
        ttlMs: 5000,
        nowIso: clock.nowIso(),
      })
    ).toThrow(TenantLaunchGateConflictError);

    // sup-B attempts takeover via launchCoordinator (times out with TenantLaunchGateTimeoutError)
    await expect(
      launchCoordinator.acquire({
        runId: run.runId,
        holderType: "RECOVERY",
        holderId: "sup-B",
        leaseId: "lease-sup-B",
        ownerPid: 22222,
        ttlMs: 5000,
        timeoutMs: 50,
      })
    ).rejects.toThrow(TenantLaunchGateTimeoutError);

    // Even if sup-A's process is dead, an active supervisor lease still blocks takeover
    livePids.clear();
    expect(() =>
      store.acquireTenantLaunchGate({
        runId: run.runId,
        holderType: "RECOVERY",
        holderId: "sup-B",
        leaseId: "lease-sup-B",
        ownerPid: 22222,
        ttlMs: 5000,
        nowIso: clock.nowIso(),
      })
    ).toThrow(TenantLaunchGateConflictError);

    // Advance clock past supervisor lease as well, but resurrect PID 11111
    clock.advanceMs(10_000);
    livePids.add(11111);
    expect(() =>
      store.acquireTenantLaunchGate({
        runId: run.runId,
        holderType: "RECOVERY",
        holderId: "sup-B",
        leaseId: "lease-sup-B",
        ownerPid: 22222,
        ttlMs: 5000,
        nowIso: clock.nowIso(),
      })
    ).toThrow(TenantLaunchGateConflictError);
  });

  // 18. (Milestone 2.4A.15 Finding-01) Recovery takeover of a QUIESCED gate succeeds when prior supervisor is dead and lease expired
  it("Scenario 18: Recovery takeover of a QUIESCED gate succeeds when previous supervisor process is confirmed dead and lease expired", async () => {
    const { run } = createIsolatedRun("sc18");

    (store as any).isProcessAlive = () => false; // PID confirmed dead

    const gateA = await launchCoordinator.acquire({
      runId: run.runId,
      holderType: "RECOVERY",
      holderId: "sup-A",
      leaseId: "lease-sup-A",
      ownerPid: 33333,
      ttlMs: 2000,
    });
    await launchCoordinator.markQuiescent(gateA);
    store.acquireSupervisorLease({
      runId: run.runId,
      supervisorId: "sup-A",
      ttlMs: 3000,
      nowIso: clock.nowIso(),
    });

    // Advance clock past both gate TTL and supervisor lease
    clock.advanceMs(4000);

    // sup-B acquires gate
    const gateB = await launchCoordinator.acquire({
      runId: run.runId,
      holderType: "RECOVERY",
      holderId: "sup-B",
      leaseId: "lease-sup-B",
      ownerPid: 44444,
      ttlMs: 5000,
    });

    expect(gateB.holderId).toBe("sup-B");
    expect(gateB.holderType).toBe("RECOVERY");
    expect(gateB.state).toBe("ACQUIRED");
    expect(gateB.token).not.toBe(gateA.token);

    await launchCoordinator.release(gateB);
  });

  // 19. (Milestone 2.4A.15 Finding-03) markQuiescent rejects calls on RELEASED gate but is idempotent on QUIESCED gate
  it("Scenario 19: markQuiescent rejects calls on already-released gates but succeeds idempotently on QUIESCED gates", async () => {
    const { run } = createIsolatedRun("sc19");

    const gate = await launchCoordinator.acquire({
      runId: run.runId,
      holderType: "RECOVERY",
      holderId: "sup-sc19",
      leaseId: "lease-sc19",
      ttlMs: 10_000,
    });

    // First markQuiescent succeeds
    await launchCoordinator.markQuiescent(gate);
    let currentGate = store.getTenantLaunchGate(run.runId);
    expect(currentGate?.state).toBe("QUIESCED");

    // Second markQuiescent with same token succeeds idempotently
    await expect(launchCoordinator.markQuiescent(gate)).resolves.not.toThrow();
    currentGate = store.getTenantLaunchGate(run.runId);
    expect(currentGate?.state).toBe("QUIESCED");

    // Release the gate
    await launchCoordinator.release(gate);
    currentGate = store.getTenantLaunchGate(run.runId);
    expect(currentGate?.state).toBe("RELEASED");

    // Attempting markQuiescent on RELEASED gate must throw TenantLaunchGateConflictError
    await expect(launchCoordinator.markQuiescent(gate)).rejects.toThrow(TenantLaunchGateConflictError);
  });

  // 20. (Milestone 2.4A.15 Finding-04) recoverMission binds QUIESCED gate holder to supervisorId
  it("Scenario 20: recoverMission rejects caller when QUIESCED gate is held by a different recovery supervisor", async () => {
    const { run } = createIsolatedRun("sc20");
    await provisionAndStartRun(run.runId);
    clock.advanceMs(6000);

    // sup-A holds the QUIESCED gate
    const gateA = await launchCoordinator.acquire({
      runId: run.runId,
      holderType: "RECOVERY",
      holderId: "sup-A",
      leaseId: "lease-sup-A",
      ttlMs: 30_000,
    });
    await launchCoordinator.markQuiescent(gateA);

    // sup-B acquires a supervisor lease
    const supLeaseB = store.acquireSupervisorLease({
      runId: run.runId,
      supervisorId: "sup-B",
      ttlMs: 5000,
      nowIso: clock.nowIso(),
    });

    // sup-B calls recoverMission while gate is held by sup-A
    expect(() =>
      coordinator.recoverMission({
        runId: run.runId,
        supervisorId: "sup-B",
        supervisorLeaseId: supLeaseB.leaseId,
      })
    ).toThrow(TenantQuiescenceRequiredError);

    // Advance clock past sup-B's supervisor lease so sup-A can acquire an active lease
    clock.advanceMs(6000);

    // sup-A acquires its own supervisor lease and calls recoverMission
    const supLeaseA = store.acquireSupervisorLease({
      runId: run.runId,
      supervisorId: "sup-A",
      ttlMs: 10_000,
      nowIso: clock.nowIso(),
    });
    const recResult = coordinator.recoverMission({
      runId: run.runId,
      supervisorId: "sup-A",
      supervisorLeaseId: supLeaseA.leaseId,
      gateToken: gateA.token,
    });
    expect(recResult.run.runId).toBe(run.runId);
    expect(recResult.checkpoint).toBeDefined();

    await launchCoordinator.release(gateA);
  });

  // 21. (Milestone 2.4A.15 Finding-02) InMemoryTenantLaunchCoordinator enforces TTL and owner fencing on QUIESCED gates
  it("Scenario 21: InMemoryTenantLaunchCoordinator enforces TTL and owner fencing on QUIESCED gates", async () => {
    const inMem = new InMemoryTenantLaunchCoordinator(clock, 5);
    const runId = "run-inmem-sc21";

    const gateA = await inMem.acquire({
      runId,
      holderType: "RECOVERY",
      holderId: "sup-A",
      leaseId: "lease-A",
      ownerPid: process.pid,
      ttlMs: 2000,
    });
    await inMem.markQuiescent(gateA);

    // Worker acquisition rejected immediately
    await expect(
      inMem.acquire({
        runId,
        holderType: "WORKER",
        holderId: "worker-1",
        leaseId: "lease-w1",
        ttlMs: 5000,
        timeoutMs: 50,
      })
    ).rejects.toThrow(TenantLaunchGateConflictError);

    // sup-B acquisition before TTL expires fails with timeout
    await expect(
      inMem.acquire({
        runId,
        holderType: "RECOVERY",
        holderId: "sup-B",
        leaseId: "lease-B",
        ttlMs: 5000,
        timeoutMs: 50,
      })
    ).rejects.toThrow(TenantLaunchGateTimeoutError);

    // Advance past TTL (2000ms), but sup-A ownerPid is process.pid (alive!)
    clock.advanceMs(3000);
    await expect(
      inMem.acquire({
        runId,
        holderType: "RECOVERY",
        holderId: "sup-B",
        leaseId: "lease-B",
        ttlMs: 5000,
        timeoutMs: 50,
      })
    ).rejects.toThrow(TenantLaunchGateConflictError);

    // Release gate and verify markQuiescent on released gate throws
    await inMem.release(gateA);
    await expect(inMem.markQuiescent(gateA)).rejects.toThrow(TenantLaunchGateConflictError);
  });

  // 22. (Milestone 2.4A.18 Finding A) RecoverySupervisor.recoverRun rejects invocation by another supervisor
  it("Scenario 22: RecoverySupervisor.recoverRun rejects invocation when QUIESCED gate is held by a different supervisor", async () => {
    const { run } = createIsolatedRun("sc22");
    const { ws } = await provisionAndStartRun(run.runId);
    clock.advanceMs(6000);

    // sup-A holds the QUIESCED gate
    const gateA = await launchCoordinator.acquire({
      runId: run.runId,
      holderType: "RECOVERY",
      holderId: "sup-A",
      leaseId: "lease-sup-A",
      ttlMs: 30_000,
      ownerPid: process.pid,
    });
    await launchCoordinator.markQuiescent(gateA);

    const snapshotBefore = store.getRun(run.runId)!;
    const actionsBefore = store.getActionsForRun(run.runId);
    const checkpointsBefore = store.getCheckpoints(run.runId);

    // sup-B attempts recoverRun
    const supervisorB = new RecoverySupervisor({
      stateStore: store,
      rollbackEngine: new DurableRollbackEngine(store),
      clock,
      supervisorId: "sup-B",
      workspaceResolver: () => root,
    });

    const outcomeB = await supervisorB.recoverRun(run.runId);
    expect(outcomeB.status).toBe("SKIPPED_TENANTS_NOT_QUIESCED");
    expect(outcomeB.details).toContain("QUIESCED under supervisor 'sup-A'");
    expect(outcomeB.details).toContain("recovery refused for supervisor 'sup-B'");

    // Verify all operational state remains untouched:
    const snapshotAfterB = store.getRun(run.runId)!;
    expect(snapshotAfterB.status).toBe(snapshotBefore.status);
    expect(snapshotAfterB.version).toBe(snapshotBefore.version);

    const actionsAfterB = store.getActionsForRun(run.runId);
    expect(actionsAfterB.length).toBe(actionsBefore.length);

    const checkpointsAfterB = store.getCheckpoints(run.runId);
    expect(checkpointsAfterB.length).toBe(checkpointsBefore.length);

    // Workspace file still exists (no rollback occurred)
    expect(fs.existsSync(path.join(ws.hostPath, "active_data.txt"))).toBe(true);

    // Also verify scanAndRecover filters outcome identically
    const scanResultB = await supervisorB.scanAndRecover();
    const scanOutcomeB = scanResultB.outcomes.find((o) => o.runId === run.runId);
    expect(scanOutcomeB).toBeDefined();
    expect(scanOutcomeB!.status).toBe("SKIPPED_TENANTS_NOT_QUIESCED");

    // Legitimate supervisor sup-A can successfully recover the run
    const supervisorA = new RecoverySupervisor({
      stateStore: store,
      rollbackEngine: new DurableRollbackEngine(store),
      clock,
      supervisorId: "sup-A",
      workspaceResolver: () => root,
    });
    const outcomeA = await supervisorA.recoverRun(run.runId, { gateToken: gateA.token });
    expect(outcomeA.statusAfter).toBe("RECOVERING");

    await launchCoordinator.release(gateA);
  });

  // 23. (Milestone 2.4A.18 Finding B) InMemoryTenantLaunchCoordinator fails closed on missing, live, or indeterminate PID
  it("Scenario 23: InMemoryTenantLaunchCoordinator fails closed on missing, live, or indeterminate PID", async () => {
    const inMem = new InMemoryTenantLaunchCoordinator(clock, 5);

    // 1. Missing PID fails closed
    const gateMissingPid = await inMem.acquire({
      runId: "run-missing-pid",
      holderType: "RECOVERY",
      holderId: "sup-A",
      leaseId: "lease-A",
      ttlMs: 1000,
      // ownerPid omitted
    });
    await inMem.markQuiescent(gateMissingPid);
    clock.advanceMs(2000);

    await expect(
      inMem.acquire({
        runId: "run-missing-pid",
        holderType: "RECOVERY",
        holderId: "sup-B",
        leaseId: "lease-B",
        ttlMs: 5000,
        timeoutMs: 50,
      })
    ).rejects.toThrow(TenantLaunchGateConflictError);

    // Verify token and holder remain unchanged
    const gateAfterFail = inMem.getGate("run-missing-pid");
    expect(gateAfterFail?.holderId).toBe("sup-A");
    expect(gateAfterFail?.token).toBe(gateMissingPid.token);
    expect(gateAfterFail?.state).toBe("QUIESCED");

    // 2. Indeterminate PID (EPERM / error) fails closed
    const gateIndeterminate = await inMem.acquire({
      runId: "run-indet-pid",
      holderType: "RECOVERY",
      holderId: "sup-A",
      leaseId: "lease-A",
      ownerPid: 54321,
      ttlMs: 1000,
    });
    await inMem.markQuiescent(gateIndeterminate);
    clock.advanceMs(2000);

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err: any = new Error("EPERM: operation not permitted");
      err.code = "EPERM";
      throw err;
    });

    try {
      await expect(
        inMem.acquire({
          runId: "run-indet-pid",
          holderType: "RECOVERY",
          holderId: "sup-B",
          leaseId: "lease-B",
          ttlMs: 5000,
          timeoutMs: 50,
        })
      ).rejects.toThrow(TenantLaunchGateConflictError);
    } finally {
      killSpy.mockRestore();
    }

    // 3. Confirmed-dead PID (ESRCH) allows takeover
    const killSpyDead = vi.spyOn(process, "kill").mockImplementation(() => {
      const err: any = new Error("ESRCH: no such process");
      err.code = "ESRCH";
      throw err;
    });

    try {
      const gateSuccessor = await inMem.acquire({
        runId: "run-indet-pid",
        holderType: "RECOVERY",
        holderId: "sup-B",
        leaseId: "lease-B",
        ownerPid: 98765,
        ttlMs: 5000,
        timeoutMs: 50,
      });
      expect(gateSuccessor.state).toBe("ACQUIRED");
      expect(gateSuccessor.holderId).toBe("sup-B");
      expect(gateSuccessor.token).not.toBe(gateIndeterminate.token);
    } finally {
      killSpyDead.mockRestore();
    }
  });

  // 24. (Milestone M1) In-memory expired ACQUIRED takeover has SQLite parity: owner must be confirmed dead
  it("Scenario 24: InMemoryTenantLaunchCoordinator refuses expired ACQUIRED takeover unless owner PID is confirmed dead", async () => {
    const inMem = new InMemoryTenantLaunchCoordinator(clock, 5);
    const takeover = (runId: string, holderType: "WORKER" | "RECOVERY" = "RECOVERY") =>
      inMem.acquire({ runId, holderType, holderId: "new-owner", leaseId: "lease-new", ttlMs: 5000, timeoutMs: 50, ownerPid: 98765 });
    const seed = async (runId: string, holderType: "WORKER" | "RECOVERY", ownerPid?: number) =>
      inMem.acquire({ runId, holderType, holderId: "old-owner", leaseId: "lease-old", ttlMs: 1000, ownerPid });
    const killWith = (code: string) =>
      vi.spyOn(process, "kill").mockImplementation(() => {
        const err: any = new Error(code);
        err.code = code;
        throw err;
      });

    for (const holderType of ["WORKER", "RECOVERY"] as const) {
      // Missing PID, live PID and indeterminate (EPERM) are all refused; gate is unchanged.
      const missing = await seed(`run-${holderType}-missing`, holderType);
      clock.advanceMs(2000);
      await expect(takeover(`run-${holderType}-missing`)).rejects.toThrow(TenantLaunchGateConflictError);
      expect(inMem.getGate(`run-${holderType}-missing`)?.token).toBe(missing.token);

      const live = await seed(`run-${holderType}-live`, holderType, process.pid);
      clock.advanceMs(2000);
      await expect(takeover(`run-${holderType}-live`)).rejects.toThrow(TenantLaunchGateConflictError);
      expect(inMem.getGate(`run-${holderType}-live`)?.token).toBe(live.token);

      const indet = await seed(`run-${holderType}-eperm`, holderType, 54321);
      clock.advanceMs(2000);
      const epermSpy = killWith("EPERM");
      try {
        await expect(takeover(`run-${holderType}-eperm`)).rejects.toThrow(TenantLaunchGateConflictError);
      } finally {
        epermSpy.mockRestore();
      }
      expect(inMem.getGate(`run-${holderType}-eperm`)?.token).toBe(indet.token);

      // Confirmed dead (ESRCH) allows takeover with a fresh token.
      const dead = await seed(`run-${holderType}-dead`, holderType, 54322);
      clock.advanceMs(2000);
      const esrchSpy = killWith("ESRCH");
      try {
        const successor = await takeover(`run-${holderType}-dead`);
        expect(successor.holderId).toBe("new-owner");
        expect(successor.token).not.toBe(dead.token);
      } finally {
        esrchSpy.mockRestore();
      }
    }

    // A worker still cannot take a gate from an expired recovery holder, even with a dead PID.
    await seed("run-recovery-to-worker", "RECOVERY", 54323);
    clock.advanceMs(2000);
    const spy = killWith("ESRCH");
    try {
      await expect(takeover("run-recovery-to-worker", "WORKER")).rejects.toThrow(TenantLaunchGateConflictError);
    } finally {
      spy.mockRestore();
    }

    // Same-holder re-acquire after expiry is unchanged (no liveness proof required).
    await seed("run-same-holder", "WORKER", process.pid);
    clock.advanceMs(2000);
    const again = await inMem.acquire({ runId: "run-same-holder", holderType: "WORKER", holderId: "old-owner", leaseId: "lease-old2", ttlMs: 1000, ownerPid: process.pid });
    expect(again.state).toBe("ACQUIRED");
  });

  // 25. (Milestone M2) recoverExpiredRuns is bound to the supervisor that holds the QUIESCED gate
  it("Scenario 25: recoverExpiredRuns holds an isolated run unless the QUIESCED gate belongs to the stated supervisor", async () => {
    const { run } = createIsolatedRun("sc25");
    const { ws } = await provisionAndStartRun(run.runId);
    clock.advanceMs(6000);

    const gateA = await launchCoordinator.acquire({
      runId: run.runId,
      holderType: "RECOVERY",
      holderId: "sup-A",
      leaseId: "lease-sup-A",
      ttlMs: 30_000,
      ownerPid: process.pid,
    });
    await launchCoordinator.markQuiescent(gateA);

    const before = store.getRun(run.runId)!;
    const eventsBefore = store.getEventsForRun(run.runId).length;

    const tokens = new Map([[run.runId, gateA.token]]);
    for (const opts of [{ supervisorId: "sup-B", quiescedGateTokens: tokens }, { quiescedGateTokens: tokens }]) {
      const result = coordinator.recoverExpiredRuns(opts);
      expect(result.recoveredCount).toBe(0);
      expect(result.heldForQuiescenceRunIds).toContain(run.runId);
      const after = store.getRun(run.runId)!;
      expect(after.status).toBe(before.status);
      expect(after.version).toBe(before.version);
      expect(store.getEventsForRun(run.runId).length).toBe(eventsBefore);
      expect(fs.existsSync(path.join(ws.hostPath, "active_data.txt"))).toBe(true);
    }

    // The gate owner is admitted past the quiescence check.
    const owner = coordinator.recoverExpiredRuns({ supervisorId: "sup-A", quiescedGateTokens: tokens });
    expect(owner.heldForQuiescenceRunIds ?? []).not.toContain(run.runId);

    await launchCoordinator.release(gateA);
  });

  // 26. (Milestone M1.2) In-memory: invalid owner PIDs never authorize takeover (QUIESCED and expired ACQUIRED)
  it("Scenario 26: InMemoryTenantLaunchCoordinator refuses takeover for missing or invalid owner PIDs on QUIESCED and expired ACQUIRED gates", async () => {
    const invalidPids: Array<number | undefined> = [undefined, 0, -7, -1, 1.5, Number.NaN];
    const branches = [
      { label: "QUIESCED", holderType: "RECOVERY" as const, quiesce: true },
      { label: "ACQUIRED/RECOVERY", holderType: "RECOVERY" as const, quiesce: false },
      { label: "ACQUIRED/WORKER", holderType: "WORKER" as const, quiesce: false },
    ];

    for (const { label, holderType, quiesce } of branches) {
      for (const bad of invalidPids) {
        const inMem = new InMemoryTenantLaunchCoordinator(clock, 5);
        const runId = `run-sc26-${label}-${String(bad)}`;
        const original = await inMem.acquire({ runId, holderType, holderId: "old-owner", leaseId: "lease-old", ttlMs: 1000, ownerPid: bad });
        if (quiesce) await inMem.markQuiescent(original);
        clock.advanceMs(2000);

        // A liveness result of ESRCH ("dead") would authorize takeover if it were consulted.
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
          throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        });
        try {
          await expect(
            inMem.acquire({ runId, holderType: "RECOVERY", holderId: "new-owner", leaseId: "lease-new", ttlMs: 5000, timeoutMs: 50, ownerPid: 98765 }),
            `${label} ownerPid=${String(bad)}`
          ).rejects.toThrow(TenantLaunchGateConflictError);
          expect(killSpy).not.toHaveBeenCalled();
        } finally {
          killSpy.mockRestore();
        }

        const gate = inMem.getGate(runId)!;
        expect(gate.holderId).toBe("old-owner");
        expect(gate.holderType).toBe(holderType);
        expect(gate.state).toBe(quiesce ? "QUIESCED" : "ACQUIRED");
        expect(gate.token).toBe(original.token);
      }
    }
  });

  // ---------------------------------------------------------------------------------------------------------------
  // 27. F-3 (approved requirement): an expired QUIESCED gate is not current authority for recovery, even when the holder ID
  // matches. Recovery must refuse and mutate nothing; quiescence has to be re-verified (a fresh sweep re-acquires the gate).
  // Behavior before this change (expiry ignored; workspace disposed/requeued) was recorded by the earlier characterization.
  // ---------------------------------------------------------------------------------------------------------------
  describe("Scenario 27: F-3 expired QUIESCED gate does not authorize recovery", () => {
    async function setupQuiescedGate(suffix: string, ttlMs: number, advanceMs: number) {
      const { run } = createIsolatedRun(suffix);
      const { ws } = await provisionAndStartRun(run.runId);
      const gate = await launchCoordinator.acquire({
        runId: run.runId,
        holderType: "RECOVERY",
        holderId: "sup-A",
        leaseId: "lease-sup-A",
        ttlMs,
        ownerPid: process.pid,
      });
      await launchCoordinator.markQuiescent(gate);
      clock.advanceMs(advanceMs);
      return { run, ws, gate };
    }

    function observe(runId: string, wsPath: string) {
      const r = store.getRun(runId)!;
      const g = store.getTenantLaunchGate(runId)!;
      return {
        status: r.status,
        version: r.version,
        attemptCount: r.attemptCount,
        leaseId: r.leaseId,
        eventTypes: store.getEventsForRun(runId).map((e) => e.eventType),
        checkpoints: store.getCheckpoints(runId).length,
        gate: { state: g.state, holderId: g.holderId, token: g.token, expiresAt: g.expiresAt },
        workspaceFileExists: fs.existsSync(path.join(wsPath, "active_data.txt")),
      };
    }

    function newSupervisor() {
      return new RecoverySupervisor({
        stateStore: store,
        rollbackEngine: new DurableRollbackEngine(store),
        clock,
        supervisorId: "sup-A",
        workspaceResolver: () => root,
      });
    }

    it("A: recoverExpiredRuns holds the run and neither disposes the workspace nor requeues", async () => {
      const { run, ws, gate } = await setupQuiescedGate("sc27a", 2000, 6000); // gate expired 4s ago
      const before = observe(run.runId, ws.hostPath);
      expect(new Date(before.gate.expiresAt).getTime()).toBeLessThan(new Date(clock.nowIso()).getTime());

      const result = coordinator.recoverExpiredRuns({ supervisorId: "sup-A", quiescedGateTokens: new Map([[run.runId, gate.token]]) });

      expect(result.recoveredCount).toBe(0);
      expect(result.heldForQuiescenceRunIds).toContain(run.runId);
      expect(observe(run.runId, ws.hostPath)).toEqual(before);
      expect(before.workspaceFileExists).toBe(true);
    });

    it("B: RecoverySupervisor.recoverRun is SKIPPED_TENANTS_NOT_QUIESCED with an expiry explanation and mutates nothing", async () => {
      const { run, ws, gate } = await setupQuiescedGate("sc27b", 2000, 6000);
      const before = observe(run.runId, ws.hostPath);

      const outcome = await newSupervisor().recoverRun(run.runId, { gateToken: gate.token });

      expect(outcome.status).toBe("SKIPPED_TENANTS_NOT_QUIESCED");
      expect(outcome.details).toContain("expired");
      expect(observe(run.runId, ws.hostPath)).toEqual(before);
    });

    it("C: recoverMission throws TenantQuiescenceRequiredError and writes no checkpoint", async () => {
      const { run, ws, gate } = await setupQuiescedGate("sc27c", 2000, 6000);
      const supLease = store.acquireSupervisorLease({ runId: run.runId, supervisorId: "sup-A", ttlMs: 10_000, nowIso: clock.nowIso() });
      const before = observe(run.runId, ws.hostPath);

      expect(() =>
        coordinator.recoverMission({ runId: run.runId, supervisorId: "sup-A", supervisorLeaseId: supLease.leaseId, gateToken: gate.token })
      ).toThrow(TenantQuiescenceRequiredError);

      expect(observe(run.runId, ws.hostPath)).toEqual(before);
    });

    it("boundary: a gate with 1ms of validity left is accepted; at exactly its expiry it is refused", async () => {
      // Worker lease is 5000ms, so advance 6000ms and size the gate TTL to leave exactly 1ms / 0ms.
      const fresh = await setupQuiescedGate("sc27d", 6001, 6000);
      expect(new Date(store.getTenantLaunchGate(fresh.run.runId)!.expiresAt).getTime() - new Date(clock.nowIso()).getTime()).toBe(1);
      const accepted = coordinator.recoverExpiredRuns({ supervisorId: "sup-A", quiescedGateTokens: new Map([[fresh.run.runId, fresh.gate.token]]) });
      expect(accepted.recoveredCount).toBe(1);
      expect(observe(fresh.run.runId, fresh.ws.hostPath).status).toBe("QUEUED");

      const edge = await setupQuiescedGate("sc27e", 6000, 6000);
      expect(new Date(store.getTenantLaunchGate(edge.run.runId)!.expiresAt).getTime()).toBe(new Date(clock.nowIso()).getTime());
      const before = observe(edge.run.runId, edge.ws.hostPath);
      const refused = coordinator.recoverExpiredRuns({ supervisorId: "sup-A", quiescedGateTokens: new Map([[edge.run.runId, edge.gate.token]]) });
      expect(refused.heldForQuiescenceRunIds).toContain(edge.run.runId);
      expect(observe(edge.run.runId, edge.ws.hostPath)).toEqual(before);
    });

    it("D: recoverRun with recorded mutation intents refuses an expired QUIESCED gate before any rollback, cleanup or durable change (fresh-gate control proceeds)", async () => {
      const seed = async (suffix: string, gateTtlMs: number) => {
        const { run } = createIsolatedRun(suffix);
        const { ws, claim } = await provisionAndStartRun(run.runId, `worker-${suffix}`);
        const target = path.join(ws.hostPath, "file.txt");
        fs.writeFileSync(target, `original-${suffix}`);
        store.recordIntent({
          mutationId: `mut-${suffix}`,
          runId: run.runId,
          workerLeaseId: claim.lease.leaseId,
          relativePath: "file.txt",
          canonicalPath: target,
          pathMutationVersion: 1,
          parentMutationId: null,
          baseDigest: "0".repeat(64),
          expectedResultingDigest: "1".repeat(64),
          snapshotRef: `snap-${suffix}`,
          recoveryDedupToken: Buffer.from(suffix).toString("hex").padEnd(64, "0").slice(0, 64),
          lifecycleStatus: "RECORDED",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        const gate = await launchCoordinator.acquire({
          runId: run.runId,
          holderType: "RECOVERY",
          holderId: "sup-A",
          leaseId: "lease-sup-A",
          ttlMs: gateTtlMs,
          ownerPid: process.pid,
        });
        await launchCoordinator.markQuiescent(gate);
        return { run, ws, gateToken: gate.token };
      };

      const capture = (runId: string, wsDir: string) => {
        const r = store.getRun(runId)!;
        return JSON.parse(
          JSON.stringify({
            run: { status: r.status, version: r.version, attemptCount: r.attemptCount, leaseId: r.leaseId, currentWorkerId: r.currentWorkerId, leaseExpiresAt: r.leaseExpiresAt },
            events: store.getEventsForRun(runId).map((e) => ({ eventId: e.eventId, eventType: e.eventType, sequence: (e as any).sequence })),
            checkpoints: store.getCheckpoints(runId),
            intents: store.getIntentsForRun(runId),
            rollback: store.getRunRollback(runId),
            gate: store.getTenantLaunchGate(runId),
            supervisorLeases: store.getSupervisorLeasesForRun(runId),
            workspace: fs.existsSync(wsDir)
              ? fs.readdirSync(wsDir).sort().map((name) => [name, fs.readFileSync(path.join(wsDir, name), "utf8")])
              : null,
          })
        );
      };

      const expired = await seed("sc27d-expired", 2000); // gate TTL 2s
      const control = await seed("sc27d-control", 30_000); // gate TTL 30s
      clock.advanceMs(6000); // worker leases (5s) expired for both; only the first gate is expired

      const expiredGate = store.getTenantLaunchGate(expired.run.runId)!;
      expect(expiredGate.holderId).toBe("sup-A");
      expect(expiredGate.state).toBe("QUIESCED");
      expect(new Date(expiredGate.expiresAt).getTime()).toBeLessThan(new Date(clock.nowIso()).getTime());
      expect(new Date(store.getTenantLaunchGate(control.run.runId)!.expiresAt).getTime()).toBeGreaterThan(new Date(clock.nowIso()).getTime());

      const engine = new DurableRollbackEngine(store);
      const executeRollback = vi.spyOn(engine, "executeRollback");
      const supervisor = new RecoverySupervisor({ stateStore: store, rollbackEngine: engine, clock, supervisorId: "sup-A", workspaceResolver: () => root });

      const before = capture(expired.run.runId, expired.ws.hostPath);
      expect(before.run.status).toBe("RUNNING");
      expect(before.intents).toHaveLength(1);
      expect(before.workspace).toEqual(
        expect.arrayContaining([["active_data.txt", "live tenant mutation"], ["file.txt", "original-sc27d-expired"]])
      );

      const outcome = await supervisor.recoverRun(expired.run.runId, { gateToken: expired.gateToken });

      // 1. skipped / not-quiesced outcome (with an expiry explanation)
      expect(outcome.status).toBe("SKIPPED_TENANTS_NOT_QUIESCED");
      expect(outcome.statusAfter).toBe("RUNNING");
      expect(outcome.details).toContain("expired");
      // 2. rollback engine never invoked
      expect(executeRollback).not.toHaveBeenCalled();
      // 3-9. workspace, run, attempt/lease, events, checkpoints, intents, rollback aggregate, gate, supervisor leases: unchanged
      expect(capture(expired.run.runId, expired.ws.hostPath)).toEqual(before);

      // Control: with a fresh gate the same fixture proceeds into the rollback engine, so the refusal above is attributable to expiry.
      const controlOutcome = await supervisor.recoverRun(control.run.runId, { gateToken: control.gateToken });
      expect(controlOutcome.status).not.toBe("SKIPPED_TENANTS_NOT_QUIESCED");
      expect(executeRollback).toHaveBeenCalledTimes(1);
      expect(executeRollback.mock.calls[0]![0].runId).toBe(control.run.runId);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // 28. F3-R1: authority time is the injected clock. A caller-supplied nowIso is validated but can neither backdate an
  // expired gate/lease into looking current nor advance time to expire another supervisor's live lease.
  // ---------------------------------------------------------------------------------------------------------------
  describe("Scenario 28: F3-R1 caller-supplied nowIso cannot override authority time", () => {
    async function seedIsolated(suffix: string, gateTtlMs: number) {
      const { run } = createIsolatedRun(suffix);
      const { ws } = await provisionAndStartRun(run.runId, `worker-${suffix}`);
      const gate = await launchCoordinator.acquire({
        runId: run.runId,
        holderType: "RECOVERY",
        holderId: "sup-A",
        leaseId: "lease-sup-A",
        ttlMs: gateTtlMs,
        ownerPid: process.pid,
      });
      await launchCoordinator.markQuiescent(gate);
      return { run, ws, gateToken: gate.token };
    }

    function capture(runId: string, wsDir: string) {
      const r = store.getRun(runId)!;
      return JSON.parse(
        JSON.stringify({
          run: { status: r.status, version: r.version, attemptCount: r.attemptCount, leaseId: r.leaseId, currentWorkerId: r.currentWorkerId, leaseExpiresAt: r.leaseExpiresAt },
          events: store.getEventsForRun(runId).map((e) => ({ eventId: e.eventId, eventType: e.eventType, sequence: (e as any).sequence })),
          checkpoints: store.getCheckpoints(runId),
          intents: store.getIntentsForRun(runId),
          rollback: store.getRunRollback(runId),
          gate: store.getTenantLaunchGate(runId),
          supervisorLeases: store.getSupervisorLeasesForRun(runId),
          workspaceBinding: store.getRunWorkspaceBinding(runId),
          workspace: fs.readdirSync(wsDir).sort().map((name) => [name, fs.readFileSync(path.join(wsDir, name), "utf8")]),
        })
      );
    }

    const supervisorAs = (id: string) =>
      new RecoverySupervisor({ stateStore: store, rollbackEngine: new DurableRollbackEngine(store), clock, supervisorId: id, workspaceResolver: () => root });

    it("backdated nowIso cannot make an expired gate fresh (recoverRun and recoverMission)", async () => {
      // Gate TTL 8s, worker lease 5s; after 9s the gate is expired by 1s and the worker lease long expired.
      const a = await seedIsolated("sc28a", 8000);
      const b = await seedIsolated("sc28b", 8000);
      clock.advanceMs(9000);
      // A time between worker-lease expiry (t+5s) and gate expiry (t+8s): the gate looks fresh and the lease looks expired.
      const backdated = new Date(new Date(clock.nowIso()).getTime() - 1500).toISOString();
      expect(new Date(store.getTenantLaunchGate(a.run.runId)!.expiresAt).getTime()).toBeGreaterThan(new Date(backdated).getTime());
      expect(new Date(store.getTenantLaunchGate(a.run.runId)!.expiresAt).getTime()).toBeLessThan(new Date(clock.nowIso()).getTime());

      const beforeRun = capture(a.run.runId, a.ws.hostPath);
      const outcome = await supervisorAs("sup-A").recoverRun(a.run.runId, { nowIso: backdated, gateToken: a.gateToken });
      expect(outcome.status).toBe("SKIPPED_TENANTS_NOT_QUIESCED");
      expect(outcome.details).toContain("expired");
      expect(capture(a.run.runId, a.ws.hostPath)).toEqual(beforeRun);

      const supLease = store.acquireSupervisorLease({ runId: b.run.runId, supervisorId: "sup-A", ttlMs: 10_000, nowIso: clock.nowIso() });
      const beforeMission = capture(b.run.runId, b.ws.hostPath);
      expect(() =>
        coordinator.recoverMission({ runId: b.run.runId, supervisorId: "sup-A", supervisorLeaseId: supLease.leaseId, nowIso: backdated, gateToken: b.gateToken })
      ).toThrow(TenantQuiescenceRequiredError);
      expect(capture(b.run.runId, b.ws.hostPath)).toEqual(beforeMission);
    });

    it("invalid nowIso fails closed for recoverRun, scanAndRecover and recoverMission without touching state", async () => {
      const a = await seedIsolated("sc28c", 30_000); // fresh gate: the invalid time is the only reason to refuse
      clock.advanceMs(6000);
      const supLease = store.acquireSupervisorLease({ runId: a.run.runId, supervisorId: "sup-A", ttlMs: 10_000, nowIso: clock.nowIso() });
      const before = capture(a.run.runId, a.ws.hostPath);
      const supervisor = supervisorAs("sup-A");

      for (const bad of ["not-a-date", "", "2026-13-45T99:99:99Z"]) {
        await expect(supervisor.recoverRun(a.run.runId, { nowIso: bad }), `recoverRun '${bad}'`).rejects.toThrow(MissingMutationAuthorityError);
        await expect(supervisor.scanAndRecover({ nowIso: bad }), `scanAndRecover '${bad}'`).rejects.toThrow(MissingMutationAuthorityError);
        expect(
          () => coordinator.recoverMission({ runId: a.run.runId, supervisorId: "sup-A", supervisorLeaseId: supLease.leaseId, nowIso: bad }),
          `recoverMission '${bad}'`
        ).toThrow(MissingMutationAuthorityError);
      }
      expect(capture(a.run.runId, a.ws.hostPath)).toEqual(before);
    });

    it("future-dated nowIso cannot expire another supervisor's live supervisor lease", async () => {
      // In-process run (no gate requirement) so the supervisor lease is the only protection under test.
      const task = coordinator.createTask({ title: "task-sc28d", inputPayload: {} });
      createAndActivateContract(store, task.taskId, { policy: createDefaultInProcessPolicy("p-sc28d") });
      const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3, timeoutMs: 15_000 });
      const { ws } = await provisionAndStartRun(run.runId, "worker-sc28d");
      clock.advanceMs(6000); // worker lease expired
      const holder = store.acquireSupervisorLease({ runId: run.runId, supervisorId: "sup-A", ttlMs: 60_000, nowIso: clock.nowIso() });
      const before = capture(run.runId, ws.hostPath);
      expect(before.supervisorLeases).toHaveLength(1);

      const future = new Date(new Date(clock.nowIso()).getTime() + 3_600_000).toISOString();
      const outcome = await supervisorAs("sup-B").recoverRun(run.runId, { nowIso: future });

      expect(outcome.status).toBe("SKIPPED_LOCKED_BY_ANOTHER_SUPERVISOR");
      // Snapshot covers run row, events, checkpoints, intents, rollback aggregate, gate row, supervisor leases, workspace binding
      // and workspace files; sup-A's lease is still ACTIVE. It does not cover rows of other runs or path-progress tables.
      expect(capture(run.runId, ws.hostPath)).toEqual(before);
      expect(store.getSupervisorLeasesForRun(run.runId)[0]!.state).toBe("ACTIVE");
      expect(store.getSupervisorLeasesForRun(run.runId)[0]!.leaseId).toBe(holder.leaseId);
    });

    it("boundary: recoverRun and recoverMission treat a gate as fresh only while now < expiresAt (equality is expired)", async () => {
      const runEqual = await seedIsolated("sc28e", 6000);
      const runOneMs = await seedIsolated("sc28f", 6001);
      const missEqual = await seedIsolated("sc28g", 6000);
      const missOneMs = await seedIsolated("sc28h", 6001);
      clock.advanceMs(6000);
      const supervisor = supervisorAs("sup-A");

      const equalBefore = capture(runEqual.run.runId, runEqual.ws.hostPath);
      const refusedRun = await supervisor.recoverRun(runEqual.run.runId, { gateToken: runEqual.gateToken });
      expect(refusedRun.status).toBe("SKIPPED_TENANTS_NOT_QUIESCED");
      expect(capture(runEqual.run.runId, runEqual.ws.hostPath)).toEqual(equalBefore);
      const acceptedRun = await supervisor.recoverRun(runOneMs.run.runId, { gateToken: runOneMs.gateToken });
      expect(acceptedRun.status).not.toBe("SKIPPED_TENANTS_NOT_QUIESCED");

      const leaseFor = (runId: string) => store.acquireSupervisorLease({ runId, supervisorId: "sup-A", ttlMs: 10_000, nowIso: clock.nowIso() });
      const leaseEqual = leaseFor(missEqual.run.runId);
      expect(() => coordinator.recoverMission({ runId: missEqual.run.runId, supervisorId: "sup-A", supervisorLeaseId: leaseEqual.leaseId, gateToken: missEqual.gateToken })).toThrow(TenantQuiescenceRequiredError);
      const leaseOneMs = leaseFor(missOneMs.run.runId);
      const accepted = coordinator.recoverMission({ runId: missOneMs.run.runId, supervisorId: "sup-A", supervisorLeaseId: leaseOneMs.leaseId, gateToken: missOneMs.gateToken });
      expect(accepted.run.runId).toBe(missOneMs.run.runId);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // 29. F3-R2: a supervisor that does not obtain the supervisor lease must not persist a workspace binding.
  // The binding is authoritative ("first bind wins"), so only the lease holder may establish it.
  // ---------------------------------------------------------------------------------------------------------------
  describe("Scenario 29: F3-R2 lease-refused recoverRun leaves no workspace binding", () => {
    async function seedInProcessRun(suffix: string) {
      const task = coordinator.createTask({ title: `task-${suffix}`, inputPayload: {} });
      createAndActivateContract(store, task.taskId, { policy: createDefaultInProcessPolicy(`p-${suffix}`) });
      const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3, timeoutMs: 15_000 });
      const { ws } = await provisionAndStartRun(run.runId, `worker-${suffix}`);
      clock.advanceMs(6000); // worker lease expired, run eligible for recovery
      return { run, ws };
    }

    function capture(runId: string, wsDir: string) {
      const r = store.getRun(runId)!;
      return JSON.parse(
        JSON.stringify({
          run: { status: r.status, version: r.version, attemptCount: r.attemptCount, leaseId: r.leaseId, currentWorkerId: r.currentWorkerId, leaseExpiresAt: r.leaseExpiresAt },
          events: store.getEventsForRun(runId).map((e) => ({ eventId: e.eventId, eventType: e.eventType, sequence: (e as any).sequence })),
          checkpoints: store.getCheckpoints(runId),
          intents: store.getIntentsForRun(runId),
          rollback: store.getRunRollback(runId),
          gate: store.getTenantLaunchGate(runId),
          supervisorLeases: store.getSupervisorLeasesForRun(runId),
          workspaceBinding: store.getRunWorkspaceBinding(runId),
          workspace: fs.readdirSync(wsDir).sort().map((name) => [name, fs.readFileSync(path.join(wsDir, name), "utf8")]),
        })
      );
    }

    const supervisorAs = (id: string) =>
      new RecoverySupervisor({ stateStore: store, rollbackEngine: new DurableRollbackEngine(store), clock, supervisorId: id, workspaceResolver: () => root });

    it("unbound run: a refused supervisor (resolver or explicit root) persists no binding; the lease holder later binds", async () => {
      const { run, ws } = await seedInProcessRun("sc29a");
      store.acquireSupervisorLease({ runId: run.runId, supervisorId: "sup-A", ttlMs: 60_000, nowIso: clock.nowIso() });
      const before = capture(run.runId, ws.hostPath);
      expect(before.workspaceBinding).toBeNull();

      const viaResolver = await supervisorAs("sup-B").recoverRun(run.runId);
      expect(viaResolver.status).toBe("SKIPPED_LOCKED_BY_ANOTHER_SUPERVISOR");
      expect(store.getRunWorkspaceBinding(run.runId)).toBeNull();

      const viaExplicit = await supervisorAs("sup-B").recoverRun(run.runId, { workspaceRoot: root });
      expect(viaExplicit.status).toBe("SKIPPED_LOCKED_BY_ANOTHER_SUPERVISOR");

      expect(capture(run.runId, ws.hostPath)).toEqual(before);

      // Control: once sup-A's lease has expired the same supervisor obtains the lease and binds.
      clock.advanceMs(61_000);
      const recovered = await supervisorAs("sup-B").recoverRun(run.runId);
      expect(recovered.status).not.toBe("SKIPPED_LOCKED_BY_ANOTHER_SUPERVISOR");
      expect(store.getRunWorkspaceBinding(run.runId)).toBe(fs.realpathSync(root));
    });

    it("pre-bound run: a refused supervisor leaves the existing binding and all other state unchanged", async () => {
      const { run, ws } = await seedInProcessRun("sc29b");
      store.bindRunWorkspace(run.runId, fs.realpathSync(root), clock.nowIso());
      store.acquireSupervisorLease({ runId: run.runId, supervisorId: "sup-A", ttlMs: 60_000, nowIso: clock.nowIso() });
      const before = capture(run.runId, ws.hostPath);
      expect(before.workspaceBinding).toBe(fs.realpathSync(root));

      const outcome = await supervisorAs("sup-B").recoverRun(run.runId);

      expect(outcome.status).toBe("SKIPPED_LOCKED_BY_ANOTHER_SUPERVISOR");
      expect(capture(run.runId, ws.hostPath)).toEqual(before);
    });

    // The three tests below use deterministic seams only: the workspaceResolver callback runs after the (still unbound)
    // binding was read and before the lease is acquired, so a bind performed inside it is a controlled concurrent writer;
    // store.releaseSupervisorLease is spied to fail; a crash after lease acquisition is the lease row left behind.
    const competingRoot = () => fs.realpathSync(fs.mkdtempSync(path.join(tempDir, "competing-")));
    const racingSupervisor = (id: string, other: string) =>
      new RecoverySupervisor({
        stateStore: store,
        rollbackEngine: new DurableRollbackEngine(store),
        clock,
        supervisorId: id,
        workspaceResolver: async (runId) => {
          store.bindRunWorkspace(runId, other, clock.nowIso()); // concurrent actor binds a different root first
          return root;
        },
      });

    it("A: binding failure after lease acquisition propagates the original error, releases the lease and does nothing else", async () => {
      const { run, ws } = await seedInProcessRun("sc29c");
      const other = competingRoot();
      const before = capture(run.runId, ws.hostPath);
      expect(before.workspaceBinding).toBeNull();
      expect(before.supervisorLeases).toHaveLength(0);

      await expect(racingSupervisor("sup-A", other).recoverRun(run.runId)).rejects.toThrow(WorkspaceBindingConflictError);

      const after = capture(run.runId, ws.hostPath);
      // The only binding is the competitor's; the recovering supervisor persisted none of its own.
      expect(after.workspaceBinding).toBe(other);
      // The lease it acquired was released (not left ACTIVE), and it is the only lease row.
      expect(after.supervisorLeases).toHaveLength(1);
      expect(after.supervisorLeases[0].supervisorId).toBe("sup-A");
      expect(after.supervisorLeases[0].state).toBe("RELEASED");
      // No run transition, event, checkpoint, intent, rollback, gate or workspace-file change.
      expect({ ...after, workspaceBinding: before.workspaceBinding, supervisorLeases: before.supervisorLeases }).toEqual(before);
    });

    it("B: when the lease release also fails, the original binding error still propagates, nothing else changes, and the lease stays ACTIVE until its TTL", async () => {
      const { run, ws } = await seedInProcessRun("sc29d");
      const other = competingRoot();
      const before = capture(run.runId, ws.hostPath);

      const releaseSpy = vi.spyOn(store, "releaseSupervisorLease").mockImplementation(() => {
        throw new Error("release failed: database is locked");
      });
      let thrown: unknown;
      let releaseCalls = -1;
      try {
        await racingSupervisor("sup-A", other).recoverRun(run.runId);
      } catch (err) {
        thrown = err;
      } finally {
        releaseCalls = releaseSpy.mock.calls.length; // read before restore, which clears the call record
        releaseSpy.mockRestore();
      }

      // Original error is primary; the secondary release failure is swallowed (existing behavior).
      expect(thrown).toBeInstanceOf(WorkspaceBindingConflictError);
      expect((thrown as Error).message).not.toContain("release failed");
      expect(releaseCalls).toBe(1);
      const after = capture(run.runId, ws.hostPath);
      expect(after.supervisorLeases).toHaveLength(1);
      expect(after.supervisorLeases[0].state).toBe("ACTIVE"); // residual lease: release failed
      expect({ ...after, workspaceBinding: before.workspaceBinding, supervisorLeases: before.supervisorLeases }).toEqual(before);

      // Documented retry delay: the same supervisor id is refused while the leaked lease is unexpired...
      const sameId = new RecoverySupervisor({ stateStore: store, rollbackEngine: new DurableRollbackEngine(store), clock, supervisorId: "sup-A" });
      const refused = await sameId.recoverRun(run.runId, { workspaceRoot: other });
      expect(refused.status).toBe("SKIPPED_LOCKED_BY_ANOTHER_SUPERVISOR");
      expect(refused.details).toContain("already holds an unexpired lease");

      // ...and recovers once the lease TTL (30s default) has elapsed.
      clock.advanceMs(31_000);
      const resumed = await sameId.recoverRun(run.runId, { workspaceRoot: other });
      expect(resumed.status).not.toBe("SKIPPED_LOCKED_BY_ANOTHER_SUPERVISOR");
      expect(store.getRunWorkspaceBinding(run.runId)).toBe(other);
    });

    it("C: crash after lease acquisition and before binding leaves no binding; the same id is refused until expiry, then recovers and binds", async () => {
      const { run, ws } = await seedInProcessRun("sc29e");
      // The state a crash at that point leaves behind: an ACTIVE supervisor lease, no binding.
      store.acquireSupervisorLease({ runId: run.runId, supervisorId: "sup-A", ttlMs: 30_000, nowIso: clock.nowIso() });
      const before = capture(run.runId, ws.hostPath);
      expect(before.workspaceBinding).toBeNull();

      const restarted = supervisorAs("sup-A"); // same supervisor id after "restart"
      const refused = await restarted.recoverRun(run.runId);
      expect(refused.status).toBe("SKIPPED_LOCKED_BY_ANOTHER_SUPERVISOR");
      expect(capture(run.runId, ws.hostPath)).toEqual(before);

      clock.advanceMs(31_000);
      const recovered = await restarted.recoverRun(run.runId);
      expect(recovered.status).not.toBe("SKIPPED_LOCKED_BY_ANOTHER_SUPERVISOR");
      expect(store.getRunWorkspaceBinding(run.runId)).toBe(fs.realpathSync(root));
      const leases = store.getSupervisorLeasesForRun(run.runId);
      expect(leases[0]!.state).toBe("EXPIRED"); // the crashed holder's lease was fenced out
      expect(new Set(leases.map((l) => l.leaseId)).size).toBe(leases.length); // new lease id for the new attempt
    });
  });

  // 30. F-4.1: in-memory coordinator mirrors SQLite -- owner identity is (holderId, ownerPid).
  describe("Scenario 30: same-ID gate ownership requires the recorded process or a liveness-proven takeover (in-memory)", () => {
    const OLD_PID = 6001;
    const NEW_PID = 6002;
    type GateState = "QUIESCED" | "ACQUIRED";

    // "missing" means no PID recorded (an explicit undefined would fall back to the default parameter value).
    async function seed(state: GateState, holderType: "WORKER" | "RECOVERY" = "RECOVERY", ownerPid: number | "missing" = OLD_PID) {
      const inMem = new InMemoryTenantLaunchCoordinator(clock, 5);
      const runId = `run-sc30-${state}-${holderType}-${String(ownerPid)}`;
      const gate = await inMem.acquire({ runId, holderType, holderId: "sup-A", leaseId: "lease-A", ttlMs: 1000, ownerPid: ownerPid === "missing" ? undefined : ownerPid });
      if (state === "QUIESCED") await inMem.markQuiescent(gate);
      return { inMem, runId, gate };
    }
    const contend = (inMem: InMemoryTenantLaunchCoordinator, runId: string, pid: number | undefined = NEW_PID, holderId = "sup-A") =>
      inMem.acquire({ runId, holderType: "RECOVERY", holderId, leaseId: "lease-B", ttlMs: 5000, timeoutMs: 50, ownerPid: pid });
    const kill = (code: string | null) =>
      vi.spyOn(process, "kill").mockImplementation(() => {
        if (code === null) return true; // process exists
        throw Object.assign(new Error(code), { code });
      });
    const unchanged = (inMem: InMemoryTenantLaunchCoordinator, runId: string, original: { token: string; holderId: string; state: string; ownerPid?: number }) => {
      const g = inMem.getGate(runId)!;
      expect({ token: g.token, holderId: g.holderId, state: g.state, ownerPid: g.ownerPid }).toEqual({
        token: original.token,
        holderId: original.holderId,
        state: original.state,
        ownerPid: original.ownerPid,
      });
    };

    for (const state of ["QUIESCED", "ACQUIRED"] as const) {
      it(`${state}: same ID from a different PID is refused while the recorded owner is alive, and succeeds only after ESRCH with a new token`, async () => {
        const { inMem, runId, gate } = await seed(state);
        clock.advanceMs(2000); // gate expired

        const alive = kill(null);
        try {
          await expect(contend(inMem, runId)).rejects.toThrow(TenantLaunchGateConflictError);
          expect(alive).toHaveBeenCalledWith(OLD_PID, 0);
        } finally {
          alive.mockRestore();
        }
        unchanged(inMem, runId, { token: gate.token, holderId: "sup-A", state: gate.state === "ACQUIRED" && state === "QUIESCED" ? "QUIESCED" : state, ownerPid: OLD_PID });

        const eperm = kill("EPERM");
        try {
          await expect(contend(inMem, runId)).rejects.toThrow(TenantLaunchGateConflictError);
        } finally {
          eperm.mockRestore();
        }

        const dead = kill("ESRCH");
        try {
          const taken = await contend(inMem, runId);
          expect(taken.holderId).toBe("sup-A");
          expect(taken.ownerPid).toBe(NEW_PID);
          expect(taken.state).toBe("ACQUIRED");
          expect(taken.token).not.toBe(gate.token);
        } finally {
          dead.mockRestore();
        }
      });

      it(`${state}: missing or invalid recorded owner PID is never proof of death (liveness not consulted, gate unchanged)`, async () => {
        for (const bad of ["missing", 0, -7, 1.5, Number.NaN] as const) {
          for (const contenderPid of [NEW_PID, OLD_PID]) {
            const { inMem, runId, gate } = await seed(state, "RECOVERY", bad);
            clock.advanceMs(2000);
            const spy = kill("ESRCH"); // would authorize if consulted
            try {
              await expect(contend(inMem, runId, contenderPid), `ownerPid=${String(bad)} contender=${contenderPid}`).rejects.toThrow(TenantLaunchGateConflictError);
              expect(spy).not.toHaveBeenCalled();
            } finally {
              spy.mockRestore();
            }
            expect(inMem.getGate(runId)!.token).toBe(gate.token);
            expect(inMem.getGate(runId)!.state).toBe(state);
          }
        }
      });

      it(`${state}: malformed expiry with the same ID never authorizes takeover from a different PID`, async () => {
        const { inMem, runId, gate } = await seed(state);
        (inMem as any).gates.set(runId, { ...inMem.getGate(runId)!, expiresAt: "not-a-date" });
        clock.advanceMs(2000);
        const spy = kill("ESRCH");
        try {
          await expect(contend(inMem, runId)).rejects.toThrow(TenantLaunchGateConflictError);
          expect(spy).not.toHaveBeenCalled();
        } finally {
          spy.mockRestore();
        }
        expect(inMem.getGate(runId)!.token).toBe(gate.token);
      });
    }

    it("same-process re-entry: the recorded PID may reacquire its own QUIESCED gate and its own expired ACQUIRED gate without a liveness probe", async () => {
      const spy = kill(null);
      try {
        const q = await seed("QUIESCED");
        const re = await contend(q.inMem, q.runId, OLD_PID); // unexpired QUIESCED, same ID, same PID
        expect(re.ownerPid).toBe(OLD_PID);
        expect(re.token).not.toBe(q.gate.token);

        const a = await seed("ACQUIRED");
        clock.advanceMs(2000);
        const again = await contend(a.inMem, a.runId, OLD_PID);
        expect(again.ownerPid).toBe(OLD_PID);
        expect(again.token).not.toBe(a.gate.token);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it("different-holder takeover is unchanged: refused while the owner is alive, allowed after ESRCH", async () => {
      for (const state of ["QUIESCED", "ACQUIRED"] as const) {
        const { inMem, runId, gate } = await seed(state);
        clock.advanceMs(2000);
        const alive = kill(null);
        try {
          await expect(contend(inMem, runId, NEW_PID, "sup-B")).rejects.toThrow(TenantLaunchGateConflictError);
        } finally {
          alive.mockRestore();
        }
        const dead = kill("ESRCH");
        try {
          const taken = await contend(inMem, runId, NEW_PID, "sup-B");
          expect(taken.holderId).toBe("sup-B");
          expect(taken.token).not.toBe(gate.token);
        } finally {
          dead.mockRestore();
        }
      }
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // 31. F-4.3: isolated recovery is authorized by the exact gate GENERATION (token) obtained when quiescence was
  // established, not by the holder name. Gate state/type/holder/freshness checks stay in force alongside the token.
  // ---------------------------------------------------------------------------------------------------------------
  describe("Scenario 31: F-4.3 gate-token fencing of isolated recovery", () => {
    async function seed(suffix: string, gateTtlMs = 30_000) {
      const { run } = createIsolatedRun(suffix);
      const { ws } = await provisionAndStartRun(run.runId, `worker-${suffix}`);
      const gate = await launchCoordinator.acquire({
        runId: run.runId,
        holderType: "RECOVERY",
        holderId: "sup-A",
        leaseId: "lease-sup-A",
        ttlMs: gateTtlMs,
        ownerPid: process.pid,
      });
      await launchCoordinator.markQuiescent(gate);
      return { run, ws, gate };
    }

    function capture(runId: string, wsDir: string) {
      const r = store.getRun(runId)!;
      return JSON.parse(
        JSON.stringify({
          run: { status: r.status, version: r.version, attemptCount: r.attemptCount, leaseId: r.leaseId, currentWorkerId: r.currentWorkerId, leaseExpiresAt: r.leaseExpiresAt },
          events: store.getEventsForRun(runId).map((e) => ({ eventId: e.eventId, eventType: e.eventType, sequence: (e as any).sequence })),
          checkpoints: store.getCheckpoints(runId),
          intents: store.getIntentsForRun(runId),
          rollback: store.getRunRollback(runId),
          gate: store.getTenantLaunchGate(runId),
          // Supervisor leases are deliberately not part of this snapshot: the recoverMission harness acquires one itself.
          // A refused recovery must still leave run, events, checkpoints, intents, rollback, gate, binding and files untouched.
          workspaceBinding: store.getRunWorkspaceBinding(runId),
          workspace: fs.readdirSync(wsDir).sort().map((name) => [name, fs.readFileSync(path.join(wsDir, name), "utf8")]),
        })
      );
    }

    const supervisor = () =>
      new RecoverySupervisor({ stateStore: store, rollbackEngine: new DurableRollbackEngine(store), clock, supervisorId: "sup-A", workspaceResolver: () => root });

    // One uniform way to attempt each of the three recovery paths with a given token (undefined = none supplied).
    type Path = "recoverRun" | "recoverExpiredRuns" | "recoverMission";
    const PATHS: Path[] = ["recoverRun", "recoverExpiredRuns", "recoverMission"];
    async function attempt(path_: Path, runId: string, token: string | undefined): Promise<"AUTHORIZED" | "REFUSED"> {
      if (path_ === "recoverRun") {
        const outcome = await supervisor().recoverRun(runId, { gateToken: token });
        return outcome.status === "SKIPPED_TENANTS_NOT_QUIESCED" ? "REFUSED" : "AUTHORIZED";
      }
      if (path_ === "recoverExpiredRuns") {
        const result = coordinator.recoverExpiredRuns({
          supervisorId: "sup-A",
          ...(token !== undefined ? { quiescedGateTokens: new Map([[runId, token]]) } : {}),
        });
        return (result.heldForQuiescenceRunIds ?? []).includes(runId) ? "REFUSED" : "AUTHORIZED";
      }
      const lease = store.acquireSupervisorLease({ runId, supervisorId: "sup-A", ttlMs: 10_000, nowIso: clock.nowIso() });
      try {
        coordinator.recoverMission({ runId, supervisorId: "sup-A", supervisorLeaseId: lease.leaseId, ...(token !== undefined ? { gateToken: token } : {}) });
        return "AUTHORIZED";
      } catch (err) {
        if (err instanceof TenantQuiescenceRequiredError) return "REFUSED";
        throw err;
      }
    }

    for (const p of PATHS) {
      it(`${p}: correct token authorizes; missing and wrong tokens fail closed and change nothing`, async () => {
        const missing = await seed(`sc31-${p}-missing`);
        const wrong = await seed(`sc31-${p}-wrong`);
        const right = await seed(`sc31-${p}-right`);
        clock.advanceMs(6000);

        const beforeMissing = capture(missing.run.runId, missing.ws.hostPath);
        expect(await attempt(p, missing.run.runId, undefined)).toBe("REFUSED");
        expect(capture(missing.run.runId, missing.ws.hostPath)).toEqual(beforeMissing);

        const beforeWrong = capture(wrong.run.runId, wrong.ws.hostPath);
        expect(await attempt(p, wrong.run.runId, "not-the-gate-token")).toBe("REFUSED");
        expect(capture(wrong.run.runId, wrong.ws.hostPath)).toEqual(beforeWrong);

        expect(await attempt(p, right.run.runId, right.gate.token)).toBe("AUTHORIZED");
      });

      it(`${p}: same-holder reacquisition issues a new token and invalidates the previous authorization`, async () => {
        const stale = await seed(`sc31-${p}-stale`);
        const fresh = await seed(`sc31-${p}-fresh`);
        clock.advanceMs(6000);
        for (const s_ of [stale, fresh]) {
          // Same holder id, same process: legitimate re-entry (F-4.1) that replaces the gate generation.
          const again = await launchCoordinator.acquire({
            runId: s_.run.runId,
            holderType: "RECOVERY",
            holderId: "sup-A",
            leaseId: "lease-sup-A2",
            ttlMs: 30_000,
            ownerPid: process.pid,
          });
          expect(again.token).not.toBe(s_.gate.token);
          await launchCoordinator.markQuiescent(again);
          (s_ as any).current = again;
        }

        const before = capture(stale.run.runId, stale.ws.hostPath);
        expect(await attempt(p, stale.run.runId, stale.gate.token)).toBe("REFUSED"); // previous generation
        expect(capture(stale.run.runId, stale.ws.hostPath)).toEqual(before);
        expect(await attempt(p, fresh.run.runId, (fresh as any).current.token)).toBe("AUTHORIZED"); // current generation
      });

      it(`${p}: released, quarantined, expired and differently-held gates are rejected even with the matching token`, async () => {
        const cases: Array<{ label: string; build: () => Promise<{ run: { runId: string }; ws: { hostPath: string }; token: string }> }> = [
          {
            label: "released",
            build: async () => {
              const g = await seed(`sc31-${p}-rel`);
              await launchCoordinator.release(g.gate);
              return { run: g.run, ws: g.ws, token: g.gate.token };
            },
          },
          {
            label: "quarantined",
            build: async () => {
              const g = await seed(`sc31-${p}-quar`);
              await launchCoordinator.quarantine(g.gate, "test");
              return { run: g.run, ws: g.ws, token: g.gate.token };
            },
          },
          {
            label: "expired",
            build: async () => {
              const g = await seed(`sc31-${p}-exp`, 2000);
              return { run: g.run, ws: g.ws, token: g.gate.token };
            },
          },
          {
            label: "held by another supervisor",
            build: async () => {
              const { run } = createIsolatedRun(`sc31-${p}-foreign`);
              const { ws } = await provisionAndStartRun(run.runId, `worker-sc31-${p}-foreign`);
              const gate = await launchCoordinator.acquire({
                runId: run.runId,
                holderType: "RECOVERY",
                holderId: "sup-B",
                leaseId: "lease-sup-B",
                ttlMs: 30_000,
                ownerPid: process.pid,
              });
              await launchCoordinator.markQuiescent(gate);
              return { run, ws, token: gate.token };
            },
          },
        ];
        const built = [];
        for (const c of cases) built.push({ label: c.label, ...(await c.build()) });
        clock.advanceMs(6000);

        for (const b of built) {
          const before = capture(b.run.runId, b.ws.hostPath);
          expect(await attempt(p, b.run.runId, b.token), `${p} / ${b.label}`).toBe("REFUSED");
          expect(capture(b.run.runId, b.ws.hostPath), `${p} / ${b.label} unchanged`).toEqual(before);
        }
      });
    }

    it("a second sweeper's pre-pass (same supervisor id and PID) replaces the generation; the first generation can no longer authorize in-flight recovery", async () => {
      const { run, ws } = await seed("sc31-sweepers");
      // seed() left a QUIESCED gate; release it so both pre-passes below acquire through the real flow.
      await launchCoordinator.release((await launchCoordinator.acquire({ runId: run.runId, holderType: "RECOVERY", holderId: "sup-A", leaseId: "x", ttlMs: 30_000, ownerPid: process.pid })));
      clock.advanceMs(6000);
      const config = {
        tenantModelOf: tenantModelFromContract((id: string, v: number) => coordinator.getContract(id, v)),
        port: { quiesceRun: async () => ({ status: "QUIESCENT" as const, stopped: 0 }) },
        launchCoordinator,
        supervisorId: "sup-A",
        supervisorPid: process.pid,
      };

      const first = await runTenantQuiescencePrePass([store.getRun(run.runId)!], config);
      const second = await runTenantQuiescencePrePass([store.getRun(run.runId)!], config); // same id + pid: re-entry, new generation
      const t1 = first.quiescedGateTokens.get(run.runId)!;
      const t2 = second.quiescedGateTokens.get(run.runId)!;
      expect(t1).toBeTruthy();
      expect(t2).toBeTruthy();
      expect(t2).not.toBe(t1);

      const before = capture(run.runId, ws.hostPath);
      const staleScan = await supervisor().scanAndRecover({ quiescedRunIds: new Set(first.quiescedRunIds), quiescedGateTokens: first.quiescedGateTokens });
      expect(staleScan.outcomes.find((o) => o.runId === run.runId)!.status).toBe("SKIPPED_TENANTS_NOT_QUIESCED");
      const staleRetry = coordinator.recoverExpiredRuns({ supervisorId: "sup-A", quiescedRunIds: new Set(first.quiescedRunIds), quiescedGateTokens: first.quiescedGateTokens });
      expect(staleRetry.heldForQuiescenceRunIds).toContain(run.runId);
      expect(capture(run.runId, ws.hostPath)).toEqual(before);

      const currentScan = await supervisor().scanAndRecover({ quiescedRunIds: new Set(second.quiescedRunIds), quiescedGateTokens: second.quiescedGateTokens });
      expect(currentScan.outcomes.find((o) => o.runId === run.runId)!.status).not.toBe("SKIPPED_TENANTS_NOT_QUIESCED");
    });

    it("token propagates end to end through RecoverySweeper.sweepOnce and authorizes both recovery halves", async () => {
      const { run } = createIsolatedRun("sc31-e2e");
      await provisionAndStartRun(run.runId, "worker-sc31-e2e");
      clock.advanceMs(6000);
      quiescenceVerdict = { status: "QUIESCENT", stopped: 1 };

      const sup = new RecoverySupervisor({ stateStore: store, rollbackEngine: new DurableRollbackEngine(store), clock, supervisorId: "sup-e2e" });
      const scanSpy = vi.spyOn(sup, "scanAndRecover");
      const retrySpy = vi.spyOn(coordinator, "recoverExpiredRuns");
      const sweeper = new RecoverySweeper({
        supervisor: sup,
        coordinator,
        tenantQuiescence: { tenantModelOf: tenantModelFromContract((id, v) => coordinator.getContract(id, v)), port: mockQuiescencePort },
      });

      const result = await sweeper.sweepOnce();

      const scanTokens = scanSpy.mock.calls[0]![0]!.quiescedGateTokens!;
      const retryTokens = retrySpy.mock.calls[0]![0]!.quiescedGateTokens!;
      expect(scanTokens.get(run.runId)).toBeTruthy();
      expect(retryTokens.get(run.runId)).toBe(scanTokens.get(run.runId));
      // The propagated token is the generation recorded durably on the gate row (which is RELEASED after the sweep).
      expect(store.getTenantLaunchGate(run.runId)!.token).toBe(scanTokens.get(run.runId));
      expect(result.heldForTenantsRunIds).toEqual([]);
      expect(result.retry.recoveredCount).toBe(1);
      expect(coordinator.getRun(run.runId)!.status).toBe("QUEUED");
    });

    it("in-process recovery needs no gate token and is unchanged", async () => {
      const task = coordinator.createTask({ title: "task-sc31-inproc", inputPayload: {} });
      createAndActivateContract(store, task.taskId, { policy: createDefaultInProcessPolicy("p-sc31-inproc") });
      const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3, timeoutMs: 15_000 });
      await provisionAndStartRun(run.runId, "worker-sc31-inproc");
      clock.advanceMs(6000);

      const outcome = await supervisor().recoverRun(run.runId); // no gate, no token
      expect(outcome.status).not.toBe("SKIPPED_TENANTS_NOT_QUIESCED");
      const retry = coordinator.recoverExpiredRuns(); // no gate, no token, no supervisor id
      expect(retry.heldForQuiescenceRunIds ?? []).not.toContain(run.runId);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // 32. F-5.3: Gate-Generation Fencing: In-Flight Recovery Interception
  // ---------------------------------------------------------------------------------------------------------------
  describe("Scenario 32: Gate-Generation Fencing: In-Flight Recovery Interception (F-5.3)", () => {
    async function seed(suffix: string, gateTtlMs = 30_000) {
      const { run } = createIsolatedRun(suffix);
      const { ws, claim } = await provisionAndStartRun(run.runId, `worker-${suffix}`);
      const gate = await launchCoordinator.acquire({
        runId: run.runId,
        holderType: "RECOVERY",
        holderId: "sup-A",
        leaseId: "lease-sup-A",
        ttlMs: gateTtlMs,
        ownerPid: process.pid,
      });
      await launchCoordinator.markQuiescent(gate);
      return { run, ws, claim, gate };
    }

    it("in-flight recovery holds an active supervisor lease; concurrent same-owner or takeover gate acquisition is refused fail-closed (Approach B)", async () => {
      const { run, gate } = await seed("sc32-approach-b");
      clock.advanceMs(6000);

      const rollbackEngine = new DurableRollbackEngine(store);
      const supervisor = new RecoverySupervisor({
        stateStore: store,
        rollbackEngine,
        clock,
        supervisorId: "sup-A",
        workspaceResolver: (runId) => path.join(root, `ws-${runId}`),
      });

      let intercepted = false;
      const realExecuteRollback = rollbackEngine.executeRollback.bind(rollbackEngine);
      vi.spyOn(rollbackEngine, "executeRollback").mockImplementation(async (options) => {
        intercepted = true;
        // Recovery is in-flight: supervisor lease is held!
        // Same-owner, same-PID re-entry attempt must be rejected fail-closed.
        expect(() => {
          store.acquireTenantLaunchGate({
            runId: run.runId,
            holderType: "RECOVERY",
            holderId: "sup-A",
            leaseId: "lease-sup-A-second",
            nowIso: clock.nowIso(),
            ttlMs: 30_000,
            ownerPid: process.pid,
          });
        }).toThrow(TenantLaunchGateConflictError);

        // Different-owner takeover attempt must also be rejected fail-closed.
        expect(() => {
          store.acquireTenantLaunchGate({
            runId: run.runId,
            holderType: "RECOVERY",
            holderId: "sup-B",
            leaseId: "lease-sup-B",
            nowIso: clock.nowIso(),
            ttlMs: 30_000,
            ownerPid: 99999,
          });
        }).toThrow(TenantLaunchGateConflictError);

        // Worker launch gate acquisition must also be rejected fail-closed.
        expect(() => {
          store.acquireTenantLaunchGate({
            runId: run.runId,
            holderType: "WORKER",
            holderId: "worker-contender",
            leaseId: "lease-worker-contender",
            nowIso: clock.nowIso(),
            ttlMs: 30_000,
            ownerPid: 99998,
          });
        }).toThrow(TenantLaunchGateConflictError);

        return realExecuteRollback(options);
      });

      const outcome = await supervisor.recoverRun(run.runId, { gateToken: gate.token });
      expect(intercepted).toBe(true);
      expect(outcome.status).toBe("RECOVERED_UNVERIFIED");
    });

    it("if gate token is replaced/diverged mid-recovery before destructive filesystem write, assertAuthorityActive aborts with MissingMutationAuthorityError (Approach A/C)", async () => {
      const { run, ws, claim, gate } = await seed("sc32-token-replaced");
      const target = path.join(ws.hostPath, "created_by_worker.txt");
      fs.writeFileSync(target, "content before rollback");
      const sha = createHash("sha256").update("content before rollback").digest("hex");

      store.recordIntent({
        mutationId: "mut-sc32-token",
        runId: run.runId,
        workerLeaseId: claim.lease.leaseId,
        relativePath: "created_by_worker.txt",
        canonicalPath: target,
        parentMutationId: null,
        pathMutationVersion: 1,
        baseDigest: "ABSENT",
        expectedResultingDigest: sha,
        snapshotRef: path.join(ws.hostPath, "dummy.snap"),
        recoveryDedupToken: createHash("sha256").update("dedup-sc32-token").digest("hex"),
        lifecycleStatus: "COMMITTED",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      clock.advanceMs(6000);

      const rollbackEngine = new DurableRollbackEngine(store);
      const supervisor = new RecoverySupervisor({
        stateStore: store,
        rollbackEngine,
        clock,
        supervisorId: "sup-A",
        workspaceResolver: (runId) => path.join(root, `ws-${runId}`),
      });

      const realExecuteRollback = rollbackEngine.executeRollback.bind(rollbackEngine);
      vi.spyOn(rollbackEngine, "executeRollback").mockImplementation(async (options) => {
        // Simulate out-of-band token divergence in SQLite while in-flight recovery is paused
        (store as any).db.prepare(`UPDATE tenant_launch_gates SET token = 'superseded-token' WHERE run_id = ?`).run(run.runId);
        return realExecuteRollback(options);
      });

      const outcome = await supervisor.recoverRun(run.runId, { gateToken: gate.token });
      expect(outcome.status).toBe("FAILED");
      expect(outcome.details).toContain("Rollback aborted fail-closed");
      expect(outcome.error).toContain("Tenant launch gate authority invalidated");

      // Verify destructive write was blocked: target file still exists on disk!
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.readFileSync(target, "utf8")).toBe("content before rollback");
    });

    it("if supervisor lease expires mid-recovery before destructive write, rollback aborts fail-closed", async () => {
      const { run, ws, claim, gate } = await seed("sc32-lease-expired");
      const target = path.join(ws.hostPath, "created_by_worker.txt");
      fs.writeFileSync(target, "preserved content");
      const sha = createHash("sha256").update("preserved content").digest("hex");

      store.recordIntent({
        mutationId: "mut-sc32-lease",
        runId: run.runId,
        workerLeaseId: claim.lease.leaseId,
        relativePath: "created_by_worker.txt",
        canonicalPath: target,
        parentMutationId: null,
        pathMutationVersion: 1,
        baseDigest: "ABSENT",
        expectedResultingDigest: sha,
        snapshotRef: path.join(ws.hostPath, "dummy.snap"),
        recoveryDedupToken: createHash("sha256").update("dedup-sc32-lease").digest("hex"),
        lifecycleStatus: "COMMITTED",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      clock.advanceMs(6000);

      const rollbackEngine = new DurableRollbackEngine(store);
      const supervisor = new RecoverySupervisor({
        stateStore: store,
        rollbackEngine,
        clock,
        supervisorId: "sup-A",
        leaseTtlMs: 30_000,
        workspaceResolver: () => root,
      });

      const realExecuteRollback = rollbackEngine.executeRollback.bind(rollbackEngine);
      vi.spyOn(rollbackEngine, "executeRollback").mockImplementation(async (options) => {
        // Advance clock past supervisor lease expiry while recovery is paused before rollback
        clock.advanceMs(40_000);
        return realExecuteRollback(options);
      });

      const outcome = await supervisor.recoverRun(run.runId, { gateToken: gate.token });
      expect(outcome.status).toBe("FAILED");
      expect(outcome.details).toContain("Rollback aborted fail-closed");

      // Target file remains untouched
      expect(fs.existsSync(target)).toBe(true);
    });

    it("if QUIESCED gate expires mid-recovery before destructive write, rollback aborts fail-closed", async () => {
      // Gate TTL 10_000 ms, supervisor lease 60_000 ms
      const { run, ws, claim, gate } = await seed("sc32-gate-expired", 10_000);
      const target = path.join(ws.hostPath, "created_by_worker.txt");
      fs.writeFileSync(target, "preserved content");
      const sha = createHash("sha256").update("preserved content").digest("hex");

      store.recordIntent({
        mutationId: "mut-sc32-gate-exp",
        runId: run.runId,
        workerLeaseId: claim.lease.leaseId,
        relativePath: "created_by_worker.txt",
        canonicalPath: target,
        parentMutationId: null,
        pathMutationVersion: 1,
        baseDigest: "ABSENT",
        expectedResultingDigest: sha,
        snapshotRef: path.join(ws.hostPath, "dummy.snap"),
        recoveryDedupToken: createHash("sha256").update("dedup-sc32-gate-exp").digest("hex"),
        lifecycleStatus: "COMMITTED",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      // Advance clock so worker lease (5000ms) expires while gate (10000ms) remains active
      clock.advanceMs(6000);

      const rollbackEngine = new DurableRollbackEngine(store);
      const supervisor = new RecoverySupervisor({
        stateStore: store,
        rollbackEngine,
        clock,
        supervisorId: "sup-A",
        leaseTtlMs: 60_000,
        workspaceResolver: (runId) => path.join(root, `ws-${runId}`),
      });

      const realExecuteRollback = rollbackEngine.executeRollback.bind(rollbackEngine);
      vi.spyOn(rollbackEngine, "executeRollback").mockImplementation(async (options) => {
        // Advance clock past gate expiry (10s) but within supervisor lease (60s)
        clock.advanceMs(10_000);
        return realExecuteRollback(options);
      });

      const outcome = await supervisor.recoverRun(run.runId, { gateToken: gate.token });
      expect(outcome.status).toBe("FAILED");
      expect(outcome.details).toContain("Rollback aborted fail-closed");
      expect(outcome.error).toContain("Tenant launch gate authority invalidated");

      // Target file remains untouched
      expect(fs.existsSync(target)).toBe(true);
    });

    it("if gate state transitions to QUARANTINED mid-recovery before destructive write, rollback aborts fail-closed", async () => {
      const { run, ws, claim, gate } = await seed("sc32-gate-quarantined");
      const target = path.join(ws.hostPath, "created_by_worker.txt");
      fs.writeFileSync(target, "preserved content");
      const sha = createHash("sha256").update("preserved content").digest("hex");

      store.recordIntent({
        mutationId: "mut-sc32-gate-quar",
        runId: run.runId,
        workerLeaseId: claim.lease.leaseId,
        relativePath: "created_by_worker.txt",
        canonicalPath: target,
        parentMutationId: null,
        pathMutationVersion: 1,
        baseDigest: "ABSENT",
        expectedResultingDigest: sha,
        snapshotRef: path.join(ws.hostPath, "dummy.snap"),
        recoveryDedupToken: createHash("sha256").update("dedup-sc32-gate-quar").digest("hex"),
        lifecycleStatus: "COMMITTED",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      clock.advanceMs(6000);

      const rollbackEngine = new DurableRollbackEngine(store);
      const supervisor = new RecoverySupervisor({
        stateStore: store,
        rollbackEngine,
        clock,
        supervisorId: "sup-A",
        workspaceResolver: (runId) => path.join(root, `ws-${runId}`),
      });

      const realExecuteRollback = rollbackEngine.executeRollback.bind(rollbackEngine);
      vi.spyOn(rollbackEngine, "executeRollback").mockImplementation(async (options) => {
        (store as any).db.prepare(`UPDATE tenant_launch_gates SET state = 'QUARANTINED' WHERE run_id = ?`).run(run.runId);
        return realExecuteRollback(options);
      });

      const outcome = await supervisor.recoverRun(run.runId, { gateToken: gate.token });
      expect(outcome.status).toBe("FAILED");
      expect(outcome.details).toContain("Rollback aborted fail-closed");
      expect(outcome.error).toContain("Tenant launch gate authority invalidated");

      expect(fs.existsSync(target)).toBe(true);
    });

    it("if gate row is removed mid-recovery before destructive write, rollback aborts fail-closed", async () => {
      const { run, ws, claim, gate } = await seed("sc32-gate-deleted");
      const target = path.join(ws.hostPath, "created_by_worker.txt");
      fs.writeFileSync(target, "preserved content");
      const sha = createHash("sha256").update("preserved content").digest("hex");

      store.recordIntent({
        mutationId: "mut-sc32-gate-del",
        runId: run.runId,
        workerLeaseId: claim.lease.leaseId,
        relativePath: "created_by_worker.txt",
        canonicalPath: target,
        parentMutationId: null,
        pathMutationVersion: 1,
        baseDigest: "ABSENT",
        expectedResultingDigest: sha,
        snapshotRef: path.join(ws.hostPath, "dummy.snap"),
        recoveryDedupToken: createHash("sha256").update("dedup-sc32-gate-del").digest("hex"),
        lifecycleStatus: "COMMITTED",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      clock.advanceMs(6000);

      const rollbackEngine = new DurableRollbackEngine(store);
      const supervisor = new RecoverySupervisor({
        stateStore: store,
        rollbackEngine,
        clock,
        supervisorId: "sup-A",
        workspaceResolver: (runId) => path.join(root, `ws-${runId}`),
      });

      const realExecuteRollback = rollbackEngine.executeRollback.bind(rollbackEngine);
      vi.spyOn(rollbackEngine, "executeRollback").mockImplementation(async (options) => {
        (store as any).db.prepare(`DELETE FROM tenant_launch_gates WHERE run_id = ?`).run(run.runId);
        return realExecuteRollback(options);
      });

      const outcome = await supervisor.recoverRun(run.runId, { gateToken: gate.token });
      expect(outcome.status).toBe("FAILED");
      expect(outcome.details).toContain("Rollback aborted fail-closed");
      expect(outcome.error).toContain("Tenant launch gate authority invalidated");

      expect(fs.existsSync(target)).toBe(true);
    });

    it("valid recovery with unchanged gate generation and active lease completes cleanly", async () => {
      const { run, ws, claim, gate } = await seed("sc32-valid-rollback");
      const hostReal = fs.realpathSync(ws.hostPath);
      const target = path.join(hostReal, "created_by_worker.txt");
      fs.writeFileSync(target, "content to rollback");
      const sha = createHash("sha256").update("content to rollback").digest("hex");

      store.recordIntent({
        mutationId: "mut-sc32-valid",
        runId: run.runId,
        workerLeaseId: claim.lease.leaseId,
        relativePath: "created_by_worker.txt",
        canonicalPath: target,
        parentMutationId: null,
        pathMutationVersion: 1,
        baseDigest: "ABSENT",
        expectedResultingDigest: sha,
        snapshotRef: path.join(hostReal, "dummy.snap"),
        recoveryDedupToken: createHash("sha256").update("dedup-sc32-valid").digest("hex"),
        lifecycleStatus: "COMMITTED",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      clock.advanceMs(6000);

      const rollbackEngine = new DurableRollbackEngine(store);
      const supervisor = new RecoverySupervisor({
        stateStore: store,
        rollbackEngine,
        clock,
        supervisorId: "sup-A",
        workspaceResolver: (runId) => fs.realpathSync(path.join(root, `ws-${runId}`)),
      });

      const outcome = await supervisor.recoverRun(run.runId, { gateToken: gate.token, workspaceRoot: hostReal });
      expect(outcome.error).toBeUndefined();
      expect(outcome.status).toBe("RECOVERED");
      expect(outcome.rollbackStatus).toBe("COMPLETED");

      // Target was rolled back and deleted
      expect(fs.existsSync(target)).toBe(false);
    });
  });
});
