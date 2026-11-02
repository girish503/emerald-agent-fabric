/**
 * ADR-0038: Tenant Launch Coordination Gate Tests
 *
 * Deterministic unit and concurrency tests proving that:
 * 1. Worker paused after lease validation -> recovery wins coordination.
 * 2. Stale worker resumes -> denied launch after recovery advanced attempt.
 * 3. Worker obtains coordination first -> launches container -> recovery discovers and terminates it before mutation.
 * 4. Worker crashes while holding coordination -> gate expires -> recovery reclaims.
 * 5. Recovery crashes during quiescence -> gate expires -> next sweep reclaims.
 * 6. Coordination acquisition times out -> fails closed.
 * 7. Docker command times out or returns ambiguous failure -> fails closed.
 * 8. Two workers attempt launch for same run -> mutual exclusion enforced.
 * 9. Unrelated runs progress independently.
 * 10. In-process execution behavior remains unchanged.
 * 11. UNVERIFIED continues to preserve workspace contents.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteStateStore, defaultIsProcessAlive } from "../../src/adapters/persistence/sqlite-state-store.js";
import { SqliteTenantLaunchCoordinator, InMemoryTenantLaunchCoordinator } from "../../src/adapters/coordination/sqlite-tenant-launch-coordinator.js";
import { DockerTenantQuiescenceAdapter, SubprocessRunner } from "../../src/adapters/execution/docker-tenant-quiescence-adapter.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { RunCoordinator, WorkerRuntime } from "../../src/application/index.js";
import { TenantLaunchGateTimeoutError, TenantLaunchGateConflictError } from "../../src/domain/errors.js";
import { createDefaultInProcessPolicy, createDefaultDockerPolicy } from "../../src/domain/policy.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { ExecutionProvider, ExecutionRequest, ExecutionResult } from "../../src/ports/execution-provider.port.js";
import { TenantQuiescencePort } from "../../src/ports/tenant-quiescence.port.js";
import { DurableRollbackEngine } from "../../src/recovery/durable-rollback-engine.js";
import { RecoverySupervisor } from "../../src/recovery/recovery-supervisor.js";
import { RecoverySweeper } from "../../src/recovery/recovery-sweeper.js";
import { tenantModelFromContract } from "../../src/recovery/tenant-quiescence-gate.js";
import { createAndActivateContract } from "../application/test-helpers.js";

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

describe("ADR-0038: Tenant Launch Coordination Gate", () => {
  let testRoot: string;
  let workspaceAdapter: NodeFsWorkspaceAdapter;

  beforeEach(async () => {
    testRoot = path.join(os.tmpdir(), `emerald-launch-coord-${crypto.randomUUID()}`);
    await fs.mkdir(testRoot, { recursive: true, mode: 0o700 });
    testRoot = await fs.realpath(testRoot);
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: testRoot });
  });

  afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true }).catch(() => {});
  });

  function setupHarness(options?: {
    isolationRequirement?: "IN_PROCESS" | "ISOLATED";
    quiescencePort?: TenantQuiescencePort;
    onExecute?: (req: ExecutionRequest) => Promise<ExecutionResult>;
    isProcessAlive?: (pid: number) => boolean;
  }) {
    const clock = new SettableClock();
    const store = new SqliteStateStore(undefined, {
      isProcessAlive: options?.isProcessAlive ?? (() => false),
    });
    const coordinator = new RunCoordinator(store, clock, undefined, workspaceAdapter);
    const rollbackEngine = new DurableRollbackEngine(store);
    const supervisor = new RecoverySupervisor({
      stateStore: store,
      rollbackEngine,
      clock,
      workspaceResolver: () => testRoot,
    });
    const launchCoordinator = new SqliteTenantLaunchCoordinator(store, clock, { pollIntervalMs: 10 });

    // Title 'echo' matches allowed capability 'execution.echo' in default policies
    const task = coordinator.createTask({ title: "echo", inputPayload: { test: true } });
    const isolation = options?.isolationRequirement ?? "ISOLATED";
    const policy = isolation === "ISOLATED"
      ? createDefaultDockerPolicy("test-docker-policy")
      : createDefaultInProcessPolicy("test-inprocess-policy");

    createAndActivateContract(store, task.taskId, { policy });
    const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3 });
    coordinator.queueRun(run.runId);

    const fakeQuiescencePort: TenantQuiescencePort = options?.quiescencePort ?? {
      async quiesceRun() {
        return { status: "QUIESCENT", stopped: 0 };
      },
    };

    let executed = false;
    const provider: ExecutionProvider = {
      name: isolation === "ISOLATED" ? "docker" : "in-process",
      tenantModel: isolation === "ISOLATED" ? "ISOLATED_PROCESSES" : "NONE",
      quiescence: isolation === "ISOLATED" ? fakeQuiescencePort : undefined,
      async execute<TInput = unknown, TOutput = unknown>(req: ExecutionRequest<TInput>): Promise<ExecutionResult<TOutput>> {
        executed = true;
        if (options?.onExecute) {
          return (await options.onExecute(req as unknown as ExecutionRequest)) as ExecutionResult<TOutput>;
        }
        return { status: "SUCCESS", durationMs: 0, output: { ok: true } as unknown as TOutput };
      },
    };

    const sweeper = new RecoverySweeper({
      supervisor,
      coordinator,
      tenantQuiescence: {
        tenantModelOf: tenantModelFromContract((contractId, version) => coordinator.getContract(contractId, version)),
        port: fakeQuiescencePort,
        launchCoordinator,
      },
      launchCoordinator,
    });

    const registerWorker = (workerId: string, pid = 1234) => {
      const now = clock.nowIso();
      coordinator.registerWorker({
        workerId,
        hostname: "localhost",
        pid,
        status: "ACTIVE",
        lastHeartbeatAt: now,
        createdAt: now,
      });
    };

    const createWorker = (workerId: string, workerOpts?: { launchGateTimeoutMs?: number }) => {
      registerWorker(workerId);
      return new WorkerRuntime({
        workerId,
        coordinator,
        clock,
        workspacePort: workspaceAdapter,
        executionProvider: provider,
        launchCoordinator,
        isIsolationAvailable: true,
        leaseTtlMs: 5000,
        launchGateTimeoutMs: workerOpts?.launchGateTimeoutMs ?? 50,
      });
    };

    return {
      clock,
      store,
      coordinator,
      supervisor,
      sweeper,
      launchCoordinator,
      runId: run.runId,
      registerWorker,
      createWorker,
      hasExecuted: () => executed,
      workspaceDir: path.join(testRoot, `ws-${run.runId}`),
    };
  }

  // 1. Worker paused after lease validation -> recovery wins coordination
  it("Scenario 1: Worker paused after lease check fails to launch because recovery holds gate", async () => {
    const harness = setupHarness();
    const worker = harness.createWorker("worker-1", { launchGateTimeoutMs: 50 });

    // Pre-acquire the launch gate by RECOVERY (simulating recovery running while worker was paused)
    await harness.launchCoordinator.acquire({
      runId: harness.runId,
      holderType: "RECOVERY",
      holderId: "supervisor-1",
      leaseId: "recovery-lease",
      ttlMs: 30_000,
    });

    // Worker attempts to run; gate acquisition times out and fails closed
    const result = await worker.runOnce();
    expect(result.status).toBe("FAILED");
    expect((result as any).error?.code).toBe("TENANT_LAUNCH_GATE_ERROR");
    expect(harness.hasExecuted()).toBe(false);
  });

  // 2. Stale worker resumes -> denied launch after recovery advanced attempt
  it("Scenario 2: Stale worker resumes and is denied launch after recovery advanced attempt", async () => {
    const harness = setupHarness();
    harness.registerWorker("worker-1");

    // Worker claims the run initially
    const claim = harness.coordinator.claimRun(harness.runId, "worker-1", 5000);
    expect(claim.run.status).toBe("LEASED");

    // Time passes: worker lease expires
    harness.clock.advanceMs(10_000);

    // Recovery sweeps the expired run, acquires gate, rolls back, advances attempt, and requeues
    const sweep = await harness.sweeper.sweepOnce();
    expect(sweep.heldForTenantsRunIds).toHaveLength(0);

    // Now check coordinator state: attempt was requeued, lease cleared
    const runAfterSweep = harness.coordinator.getRun(harness.runId);
    expect(runAfterSweep?.status).toBe("QUEUED");
    expect(runAfterSweep?.leaseId).toBeNull();
    expect(runAfterSweep?.attemptCount).toBe(1);

    // Stale worker-1 tries to acquire gate with old leaseId; inside-gate check fails because lease changed
    const gate = await harness.launchCoordinator.acquire({
      runId: harness.runId,
      holderType: "WORKER",
      holderId: "worker-1",
      leaseId: claim.lease!.leaseId,
      ttlMs: 5000,
    });

    const current = harness.coordinator.getRun(harness.runId);
    const valid = current && current.status === "RUNNING" && current.leaseId === claim.lease!.leaseId && current.currentWorkerId === "worker-1";
    expect(valid).toBe(false); // Stale worker check MUST fail

    await harness.launchCoordinator.release(gate);
    expect(harness.hasExecuted()).toBe(false);
  });

  // 3. Worker obtains coordination first -> launches container -> recovery discovers and terminates it before mutation
  it("Scenario 3: Worker obtains coordination first; recovery discovers and terminates running container before mutation", async () => {
    let containerDiscovered = false;
    let containerKilled = false;

    const mockQuiescencePort: TenantQuiescencePort = {
      async quiesceRun(_runId: string) {
        containerDiscovered = true;
        containerKilled = true;
        return { status: "QUIESCENT", stopped: 1 };
      },
    };

    const harness = setupHarness({ quiescencePort: mockQuiescencePort });

    // Worker claims the run
    harness.registerWorker("worker-1");
    const claim = harness.coordinator.claimRun(harness.runId, "worker-1", 5000);
    expect(claim.run.status).toBe("LEASED");

    // Worker acquires gate
    const gate = await harness.launchCoordinator.acquire({
      runId: harness.runId,
      holderType: "WORKER",
      holderId: "worker-1",
      leaseId: claim.lease!.leaseId,
      ttlMs: 5000,
    });

    // Worker launches container (simulated) and releases launch gate
    await harness.launchCoordinator.release(gate);

    // Worker lease expires
    harness.clock.advanceMs(6000);

    // Recovery runs sweep: it acquires gate, calls quiesceRun, discovers & kills container
    const sweep = await harness.sweeper.sweepOnce();
    expect(containerDiscovered).toBe(true);
    expect(containerKilled).toBe(true);
    expect(sweep.scan.recoveredCount + sweep.retry.recoveredCount).toBeGreaterThanOrEqual(1);
  });

  // 4. Worker crashes while holding coordination -> gate expires -> recovery reclaims
  it("Scenario 4: Worker crashes while holding coordination; gate expires and recovery reclaims", async () => {
    const harness = setupHarness();

    // Claim run so it is eligible for recovery after expiration
    harness.registerWorker("crashed-worker");
    const claim = harness.coordinator.claimRun(harness.runId, "crashed-worker", 2000);
    expect(claim.run.status).toBe("LEASED");

    // Worker acquires gate with 2000ms TTL and crashes
    await harness.launchCoordinator.acquire({
      runId: harness.runId,
      holderType: "WORKER",
      holderId: "crashed-worker",
      leaseId: claim.lease!.leaseId,
      ttlMs: 2000,
    });

    // Advance clock past gate TTL and worker lease
    harness.clock.advanceMs(3000);

    // Recovery sweeps: should successfully claim the expired gate
    const sweep = await harness.sweeper.sweepOnce();
    expect(sweep.heldForTenantsRunIds).toHaveLength(0);

    // Verify gate was acquired by recovery and released in finally
    const gateInStore = harness.store.getTenantLaunchGate(harness.runId);
    expect(gateInStore?.state).toBe("RELEASED");
  });

  // 5. Recovery crashes during quiescence -> gate expires -> next sweep reclaims
  it("Scenario 5: Recovery crashes during quiescence; gate expires and next sweep reclaims", async () => {
    const harness = setupHarness();

    // Claim run and let lease expire so recovery scans it
    harness.registerWorker("worker-1");
    harness.coordinator.claimRun(harness.runId, "worker-1", 2000);

    // Prior recovery acquired gate and crashed without releasing it
    await harness.launchCoordinator.acquire({
      runId: harness.runId,
      holderType: "RECOVERY",
      holderId: "crashed-supervisor",
      leaseId: "rec-lease-1",
      ttlMs: 2000,
    });

    // Advance clock past expiration
    harness.clock.advanceMs(3000);

    // Second recovery sweep: successfully reclaims expired gate
    const sweep = await harness.sweeper.sweepOnce();
    expect(sweep.heldForTenantsRunIds).toHaveLength(0);

    const gateInStore = harness.store.getTenantLaunchGate(harness.runId);
    expect(gateInStore?.state).toBe("RELEASED");
  });

  // 6. Coordination acquisition times out -> fails closed
  it("Scenario 6: Coordination acquisition times out and fails closed", async () => {
    const harness = setupHarness();

    // Holder 1 acquires gate for 60 seconds
    const gate1 = await harness.launchCoordinator.acquire({
      runId: harness.runId,
      holderType: "WORKER",
      holderId: "worker-holder",
      leaseId: "lease-1",
      ttlMs: 60_000,
    });

    // Holder 2 tries to acquire with 50ms timeout
    await expect(
      harness.launchCoordinator.acquire({
        runId: harness.runId,
        holderType: "RECOVERY",
        holderId: "supervisor-2",
        leaseId: "rec-lease-2",
        ttlMs: 30_000,
        timeoutMs: 50,
      })
    ).rejects.toThrow(TenantLaunchGateTimeoutError);

    // Clean up
    await harness.launchCoordinator.release(gate1);
  });

  // 7. Docker command times out or returns ambiguous failure -> fails closed
  it("Scenario 7: Ambiguous Docker command failure returns UNVERIFIED and fails closed", async () => {
    const executedCommands: Array<{ file: string; args: readonly string[] }> = [];
    const runner: SubprocessRunner = async (file, args) => {
      executedCommands.push({ file, args });
      // Simulate Docker daemon socket timeout / ambiguous failure
      return { exitCode: 1, stdout: "", stderr: "Cannot connect to the Docker daemon. Is the daemon running?" };
    };

    const failingAdapter = new DockerTenantQuiescenceAdapter({ runner });
    const result = await failingAdapter.quiesceRun("run-failing-docker");

    // Must return UNVERIFIED (fail closed)
    expect(result.status).toBe("UNVERIFIED");
    if (result.status === "UNVERIFIED") {
      expect(result.reason).toContain("Cannot connect to the Docker daemon");
    }

    // In recovery pre-pass, UNVERIFIED holds the run
    const harness = setupHarness({ quiescencePort: failingAdapter });

    // Claim run so it becomes eligible for recovery sweep when lease expires
    harness.registerWorker("worker-1");
    harness.coordinator.claimRun(harness.runId, "worker-1", 5000);
    harness.clock.advanceMs(6000);

    const sweep = await harness.sweeper.sweepOnce();

    // Sweeper must hold the run
    expect(sweep.heldForTenantsRunIds).toContain(harness.runId);
  });

  // 8. Two workers attempt launch for same run -> mutual exclusion enforced
  it("Scenario 8: Mutual exclusion is enforced when two workers attempt launch for same run", async () => {
    const harness = setupHarness();

    const gateA = await harness.launchCoordinator.acquire({
      runId: harness.runId,
      holderType: "WORKER",
      holderId: "worker-A",
      leaseId: "lease-A",
      ttlMs: 30_000,
    });
    expect(gateA.runId).toBe(harness.runId);
    expect(gateA.holderId).toBe("worker-A");

    // Worker B attempts immediate acquisition with 20ms timeout
    await expect(
      harness.launchCoordinator.acquire({
        runId: harness.runId,
        holderType: "WORKER",
        holderId: "worker-B",
        leaseId: "lease-B",
        ttlMs: 30_000,
        timeoutMs: 20,
      })
    ).rejects.toThrow(TenantLaunchGateTimeoutError);

    // Release gate A
    await harness.launchCoordinator.release(gateA);

    // Worker B can now acquire successfully
    const gateB = await harness.launchCoordinator.acquire({
      runId: harness.runId,
      holderType: "WORKER",
      holderId: "worker-B",
      leaseId: "lease-B",
      ttlMs: 30_000,
      timeoutMs: 1000,
    });
    expect(gateB.holderId).toBe("worker-B");
    await harness.launchCoordinator.release(gateB);
  });

  // 9. Unrelated runs progress independently
  it("Scenario 9: Unrelated runs acquire coordination gates independently without blocking each other", async () => {
    const harness = setupHarness();

    // Create two distinct valid runs in coordinator with valid inputPayload and active contract
    const task = harness.coordinator.createTask({ title: "echo", inputPayload: { test: true } });
    createAndActivateContract(harness.store, task.taskId, { policy: createDefaultDockerPolicy("p-indep") });
    const { run: run1 } = harness.coordinator.createRun({ taskId: task.taskId });
    const { run: run2 } = harness.coordinator.createRun({ taskId: task.taskId });

    const gate1 = await harness.launchCoordinator.acquire({
      runId: run1.runId,
      holderType: "WORKER",
      holderId: "worker-1",
      leaseId: "lease-1",
      ttlMs: 30_000,
    });

    // run2 acquisition succeeds immediately without blocking
    const gate2 = await harness.launchCoordinator.acquire({
      runId: run2.runId,
      holderType: "WORKER",
      holderId: "worker-2",
      leaseId: "lease-2",
      ttlMs: 30_000,
      timeoutMs: 100,
    });

    expect(gate1.runId).toBe(run1.runId);
    expect(gate2.runId).toBe(run2.runId);

    await harness.launchCoordinator.release(gate1);
    await harness.launchCoordinator.release(gate2);
  });

  // 10. In-process execution behavior remains unchanged
  it("Scenario 10: In-process execution provider does not acquire launch gates and executes normally", async () => {
    const harness = setupHarness({ isolationRequirement: "IN_PROCESS" });
    const worker = harness.createWorker("in-process-worker");

    const result = await worker.runOnce();
    expect(result.status).toBe("COMPLETED");
    expect(harness.hasExecuted()).toBe(true);

    // No gate was created or left in store
    const gate = harness.store.getTenantLaunchGate(harness.runId);
    expect(gate).toBeNull();
  });

  // 11. UNVERIFIED continues to preserve workspace contents
  it("Scenario 11: UNVERIFIED quiescence holds run and preserves workspace directory contents", async () => {
    const unverifiedPort: TenantQuiescencePort = {
      async quiesceRun(_runId: string) {
        return { status: "UNVERIFIED", reason: "Simulated daemon failure", stopped: 0 };
      },
    };

    const harness = setupHarness({ quiescencePort: unverifiedPort });

    // Claim run so it is eligible for recovery sweep
    harness.registerWorker("worker-1");
    harness.coordinator.claimRun(harness.runId, "worker-1", 5000);

    // Create the workspace on disk with valuable evidence
    await fs.mkdir(harness.workspaceDir, { recursive: true });
    const evidencePath = path.join(harness.workspaceDir, "valuable_evidence.txt");
    await fs.writeFile(evidencePath, "preserved evidence content");

    // Advance clock so lease expires
    harness.clock.advanceMs(10_000);

    // Run recovery sweep
    const sweep = await harness.sweeper.sweepOnce();

    // Must be held for tenants
    expect(sweep.heldForTenantsRunIds).toContain(harness.runId);

    // Workspace must NOT be deleted
    expect(await exists(evidencePath)).toBe(true);
    const content = await fs.readFile(evidencePath, "utf-8");
    expect(content).toBe("preserved evidence content");
  });

  // 12. ADR-0038 Remediation (F-01 / F-02): Worker paused past 30s with live PID -> stealing refused
  it("Scenario 12: Worker paused past 30s with live PID; recovery refuses to steal gate and preserves workspace", async () => {
    // Live worker process that has paused (e.g. GC pause or OS preemption)
    const harness = setupHarness({ isProcessAlive: (pid) => pid === 1234 });
    harness.registerWorker("paused-worker", 1234);

    const claim = harness.coordinator.claimRun(harness.runId, "paused-worker", 5000);
    expect(claim.run.status).toBe("LEASED");

    // Create a sentinel file in the workspace to verify it remains completely untouched
    await fs.mkdir(harness.workspaceDir, { recursive: true });
    const sentinelFile = path.join(harness.workspaceDir, "preserved-tenant-work.txt");
    await fs.writeFile(sentinelFile, "must-not-be-deleted-by-recovery", "utf8");

    // Worker acquired launch gate with 30s TTL
    await harness.launchCoordinator.acquire({
      runId: harness.runId,
      holderType: "WORKER",
      holderId: "paused-worker",
      leaseId: claim.lease!.leaseId,
      ttlMs: 30_000,
    });

    // Time passes: clock advances past 30s (e.g. 35s)
    harness.clock.advanceMs(35_000);

    // Recovery sweeps: expired worker lease makes run eligible for recovery,
    // BUT the launch gate holder process is still alive.
    // Under ADR-0038 remediation, lock stealing is REFUSED.
    const sweep = await harness.sweeper.sweepOnce();

    // The run MUST be held: no rollback, no requeue, no workspace disposal!
    expect(sweep.heldForTenantsRunIds).toContain(harness.runId);
    expect(sweep.needsAttention).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: harness.runId,
          status: "TENANTS_NOT_QUIESCED",
          details: expect.stringContaining("still alive; tenant launch gate stealing refused"),
        }),
      ])
    );

    // Verify workspace file remains completely intact
    expect(await exists(sentinelFile)).toBe(true);

    // Run in store remains in its pre-recovery state (still LEASED, not requeued to attempt 2)
    const runInStore = harness.coordinator.getRun(harness.runId);
    expect(runInStore?.status).toBe("LEASED");
    expect(runInStore?.attemptCount).toBe(0);
  });

  // 13. ADR-0038 Remediation (F-03): WorkerRuntime throws if isolated provider lacks durable store/coordinator
  it("Scenario 13: WorkerRuntime throws at construction if isolated provider lacks durable store/coordinator", () => {
    const clock = new SettableClock();
    // Coordinator without an authoritative store (mock coordinator)
    const fakeCoordinator: any = {
      registerWorker: () => {},
      store: undefined,
    };
    const fakeIsolatedProvider: ExecutionProvider = {
      name: "docker",
      tenantModel: "ISOLATED_PROCESSES",
      quiescence: { async quiesceRun() { return { status: "QUIESCENT", stopped: 0 }; } },
      async execute() { return { status: "SUCCESS", durationMs: 0 }; },
    };

    expect(() => {
      new WorkerRuntime({
        workerId: "test-isolated-worker",
        coordinator: fakeCoordinator,
        clock,
        executionProvider: fakeIsolatedProvider,
      });
    }).toThrow(/Silent fallback to in-memory coordination is prohibited for isolated execution/);
  });

  // 13b. F-4.4: Isolated provider + coordinator store lacking durable gate operations is rejected
  it("Scenario 13b (F-4.4): Isolated provider + coordinator store lacking durable gate operations is rejected fail-closed", () => {
    const clock = new SettableClock();
    const fakeStoreLackingGates: any = {
      getRun: () => null,
      transaction: (op: any) => op({}),
    };
    const fakeCoordinator: any = {
      registerWorker: () => {},
      store: fakeStoreLackingGates,
    };
    const fakeIsolatedProvider: ExecutionProvider = {
      name: "docker",
      tenantModel: "ISOLATED_PROCESSES",
      quiescence: { async quiesceRun() { return { status: "QUIESCENT", stopped: 0 }; } },
      async execute() { return { status: "SUCCESS", durationMs: 0 }; },
    };

    expect(() => {
      new WorkerRuntime({
        workerId: "test-isolated-worker",
        coordinator: fakeCoordinator,
        clock,
        executionProvider: fakeIsolatedProvider,
      });
    }).toThrow(/Silent fallback to in-memory coordination is prohibited for isolated execution/);
  });

  // 13c. F-4.4: Isolated provider + explicitly injected InMemoryTenantLaunchCoordinator is rejected
  it("Scenario 13c (F-4.4): Isolated provider + explicitly injected in-memory coordinator is rejected", () => {
    const clock = new SettableClock();
    const store = new SqliteStateStore({ location: ":memory:" });
    const coordinator = new RunCoordinator(store, clock);
    const inMemoryCoordinator = new InMemoryTenantLaunchCoordinator(clock);
    const fakeIsolatedProvider: ExecutionProvider = {
      name: "docker",
      tenantModel: "ISOLATED_PROCESSES",
      quiescence: { async quiesceRun() { return { status: "QUIESCENT", stopped: 0 }; } },
      async execute() { return { status: "SUCCESS", durationMs: 0 }; },
    };

    expect(() => {
      new WorkerRuntime({
        workerId: "test-isolated-worker",
        coordinator,
        clock,
        executionProvider: fakeIsolatedProvider,
        launchCoordinator: inMemoryCoordinator,
      });
    }).toThrow(/explicit injection of an in-memory coordinator is prohibited for isolated execution/);
  });

  // 13d. F-4.4: Isolated provider + correctly wired durable coordinator and store is accepted
  it("Scenario 13d (F-4.4): Isolated provider + correctly wired durable coordinator/store is accepted", () => {
    const clock = new SettableClock();
    const store = new SqliteStateStore({ location: ":memory:" });
    const coordinator = new RunCoordinator(store, clock);
    const fakeIsolatedProvider: ExecutionProvider = {
      name: "docker",
      tenantModel: "ISOLATED_PROCESSES",
      quiescence: { async quiesceRun() { return { status: "QUIESCENT", stopped: 0 }; } },
      async execute() { return { status: "SUCCESS", durationMs: 0 }; },
    };

    // Case 1: Defaulted launch coordinator (backed by coordinator.store)
    const runtimeDefault = new WorkerRuntime({
      workerId: "test-isolated-worker-default",
      coordinator,
      clock,
      executionProvider: fakeIsolatedProvider,
    });
    expect(runtimeDefault).toBeInstanceOf(WorkerRuntime);

    // Case 2: Explicitly injected SqliteTenantLaunchCoordinator backed by the same store
    const durableCoordinator = new SqliteTenantLaunchCoordinator(store, clock);
    const runtimeExplicit = new WorkerRuntime({
      workerId: "test-isolated-worker-explicit",
      coordinator,
      clock,
      executionProvider: fakeIsolatedProvider,
      launchCoordinator: durableCoordinator,
    });
    expect(runtimeExplicit).toBeInstanceOf(WorkerRuntime);
  });

  // 13e. F-4.4: In-process provider with existing supported test configuration remains unchanged
  it("Scenario 13e (F-4.4): In-process provider with in-memory coordinator or no store remains supported and unchanged", () => {
    const clock = new SettableClock();
    const fakeCoordinator: any = {
      registerWorker: () => {},
      store: undefined,
    };
    const fakeInProcessProvider: ExecutionProvider = {
      name: "in-process",
      tenantModel: "NONE",
      async execute() { return { status: "SUCCESS", durationMs: 0 }; },
    };

    // Case 1: In-process with undefined store and defaulted launch coordinator
    const runtimeNoStore = new WorkerRuntime({
      workerId: "test-inprocess-worker-nostore",
      coordinator: fakeCoordinator,
      clock,
      executionProvider: fakeInProcessProvider,
    });
    expect(runtimeNoStore).toBeInstanceOf(WorkerRuntime);

    // Case 2: In-process with explicitly injected in-memory coordinator
    const inMemoryCoordinator = new InMemoryTenantLaunchCoordinator(clock);
    const runtimeInMemory = new WorkerRuntime({
      workerId: "test-inprocess-worker-inmemory",
      coordinator: fakeCoordinator,
      clock,
      executionProvider: fakeInProcessProvider,
      launchCoordinator: inMemoryCoordinator,
    });
    expect(runtimeInMemory).toBeInstanceOf(WorkerRuntime);
  });

  // 13f. F-4.4: Worker and launch coordinator using different stores is rejected
  it("Scenario 13f (F-4.4): Worker runtime rejects launch coordinator backed by a different store than worker coordinator", () => {
    const clock = new SettableClock();
    const storeA = new SqliteStateStore({ location: ":memory:" });
    const storeB = new SqliteStateStore({ location: ":memory:" });
    const coordinatorA = new RunCoordinator(storeA, clock);
    const launchCoordinatorB = new SqliteTenantLaunchCoordinator(storeB, clock);
    const fakeIsolatedProvider: ExecutionProvider = {
      name: "docker",
      tenantModel: "ISOLATED_PROCESSES",
      quiescence: { async quiesceRun() { return { status: "QUIESCENT", stopped: 0 }; } },
      async execute() { return { status: "SUCCESS", durationMs: 0 }; },
    };

    expect(() => {
      new WorkerRuntime({
        workerId: "test-mismatched-stores-worker",
        coordinator: coordinatorA,
        clock,
        executionProvider: fakeIsolatedProvider,
        launchCoordinator: launchCoordinatorB,
      });
    }).toThrow(/launch coordinator is backed by a different state store than the worker coordinator/);
  });

  // 14. defaultIsProcessAlive accurately reports liveness
  it("Scenario 14: defaultIsProcessAlive reports true for current process, true (unknown) for invalid PIDs, false only for an absent PID", () => {
    expect(defaultIsProcessAlive(process.pid)).toBe(true);
    // Invalid PIDs establish nothing about the owner: never reported as dead.
    for (const invalid of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(defaultIsProcessAlive(invalid)).toBe(true);
    }
    expect(defaultIsProcessAlive(2_147_483_647)).toBe(false);
  });

  // 15. ADR-0038 Remediation (F-05): Recovery owner liveness prevents gate stealing
  it("Scenario 15: Recovery Process A acquires gate; past TTL, when Process A is alive, Process B is refused stealing", async () => {
    const harness = setupHarness({ isProcessAlive: (pid) => pid === 5001 });
    const runId = harness.runId;

    // Recovery Supervisor A acquires launch gate with ownerPid: 5001 and 30s TTL
    const gateA = harness.store.acquireTenantLaunchGate({
      runId,
      holderType: "RECOVERY",
      holderId: "supervisor-A",
      leaseId: "sup-lease-A",
      nowIso: harness.clock.nowIso(),
      ttlMs: 30_000,
      ownerPid: 5001,
    });
    expect(gateA.state).toBe("ACQUIRED");
    expect(gateA.ownerPid).toBe(5001);

    // Clock advances past 30s TTL (e.g. 40s)
    harness.clock.advanceMs(40_000);

    // Recovery Supervisor B attempts to acquire gate.
    // Process 5001 is still alive. Stealing must be refused with TenantLaunchGateConflictError.
    expect(() => {
      harness.store.acquireTenantLaunchGate({
        runId,
        holderType: "RECOVERY",
        holderId: "supervisor-B",
        leaseId: "sup-lease-B",
        nowIso: harness.clock.nowIso(),
        ttlMs: 30_000,
        ownerPid: 5002,
      });
    }).toThrow(TenantLaunchGateConflictError);

    // Verify error message specifies that recovery supervisor PID 5001 is still alive
    try {
      harness.store.acquireTenantLaunchGate({
        runId,
        holderType: "RECOVERY",
        holderId: "supervisor-B",
        leaseId: "sup-lease-B",
        nowIso: harness.clock.nowIso(),
        ttlMs: 30_000,
        ownerPid: 5002,
      });
    } catch (err) {
      expect((err as Error).message).toMatch(
        /Recovery supervisor 'supervisor-A' \(PID 5001\) is still alive; tenant launch gate stealing refused/
      );
    }
  });

  // 16. ADR-0038 Remediation (F-05): Indeterminate liveness check on prior gate owner throws -> stealing refused fail-closed
  it("Scenario 16: Indeterminate liveness check on prior gate owner throws -> stealing refused fail-closed", async () => {
    const harness = setupHarness({
      isProcessAlive: () => {
        throw new Error("EPERM: cannot query process table");
      },
    });
    const runId = harness.runId;

    harness.store.acquireTenantLaunchGate({
      runId,
      holderType: "RECOVERY",
      holderId: "supervisor-A",
      leaseId: "sup-lease-A",
      nowIso: harness.clock.nowIso(),
      ttlMs: 30_000,
      ownerPid: 5001,
    });

    harness.clock.advanceMs(40_000);

    expect(() => {
      harness.store.acquireTenantLaunchGate({
        runId,
        holderType: "RECOVERY",
        holderId: "supervisor-B",
        leaseId: "sup-lease-B",
        nowIso: harness.clock.nowIso(),
        ttlMs: 30_000,
        ownerPid: 5002,
      });
    }).toThrow(TenantLaunchGateConflictError);
  });

  // 17. ADR-0038 Remediation (F-05): Confirmed-dead recovery owner -> Process B successfully reclaims gate
  it("Scenario 17: Prior recovery owner confirmed dead and supervisor lease expired -> Process B successfully reclaims gate", async () => {
    let alivePid = 5001;
    const harness = setupHarness({ isProcessAlive: (pid) => pid === alivePid });
    const runId = harness.runId;

    const gateA = harness.store.acquireTenantLaunchGate({
      runId,
      holderType: "RECOVERY",
      holderId: "supervisor-A",
      leaseId: "sup-lease-A",
      nowIso: harness.clock.nowIso(),
      ttlMs: 30_000,
      ownerPid: 5001,
    });
    expect(gateA.state).toBe("ACQUIRED");

    // Advance clock past 30s TTL
    harness.clock.advanceMs(40_000);

    // Process A crashes/terminates
    alivePid = -1;

    // Process B attempts acquisition
    const gateB = harness.store.acquireTenantLaunchGate({
      runId,
      holderType: "RECOVERY",
      holderId: "supervisor-B",
      leaseId: "sup-lease-B",
      nowIso: harness.clock.nowIso(),
      ttlMs: 30_000,
      ownerPid: 5002,
    });

    expect(gateB.state).toBe("ACQUIRED");
    expect(gateB.holderId).toBe("supervisor-B");
    expect(gateB.ownerPid).toBe(5002);
    expect(gateB.token).not.toBe(gateA.token);
  });

  // 18. ADR-0038 Remediation (F-05): Stale owner attempts to release reclaimed gate with old token -> gate remains active
  it("Scenario 18: Stale owner attempts to release reclaimed gate with old token -> gate remains active for new owner", async () => {
    let alivePid = 5001;
    const harness = setupHarness({ isProcessAlive: (pid) => pid === alivePid });
    const runId = harness.runId;

    const gateA = harness.store.acquireTenantLaunchGate({
      runId,
      holderType: "RECOVERY",
      holderId: "supervisor-A",
      leaseId: "sup-lease-A",
      nowIso: harness.clock.nowIso(),
      ttlMs: 30_000,
      ownerPid: 5001,
    });

    harness.clock.advanceMs(40_000);
    alivePid = -1; // Supervisor A dies

    // Supervisor B reclaims
    const gateB = harness.store.acquireTenantLaunchGate({
      runId,
      holderType: "RECOVERY",
      holderId: "supervisor-B",
      leaseId: "sup-lease-B",
      nowIso: harness.clock.nowIso(),
      ttlMs: 30_000,
      ownerPid: 5002,
    });

    // Supervisor A wakes up or delayed network/process call tries to release using old token A
    harness.store.releaseTenantLaunchGate({
      runId,
      token: gateA.token,
      nowIso: harness.clock.nowIso(),
    });

    // The gate MUST still be ACQUIRED by supervisor B!
    const currentGate = harness.store.getTenantLaunchGate(runId);
    expect(currentGate?.state).toBe("ACQUIRED");
    expect(currentGate?.holderId).toBe("supervisor-B");
    expect(currentGate?.token).toBe(gateB.token);
  });

  // 19. ADR-0038 Remediation (F-05): Missing owner PID -> stealing refused fail-closed
  it("Scenario 19: Prior gate record has null ownerPid -> stealing refused fail-closed", async () => {
    const harness = setupHarness();
    const runId = harness.runId;

    // Insert a gate record
    harness.store.acquireTenantLaunchGate({
      runId,
      holderType: "RECOVERY",
      holderId: "legacy-supervisor",
      leaseId: "legacy-lease",
      nowIso: harness.clock.nowIso(),
      ttlMs: 30_000,
    });

    // Explicitly update owner_pid to NULL in SQLite to simulate legacy record
    const db = (harness.store as any).db;
    db.prepare(`UPDATE tenant_launch_gates SET owner_pid = NULL WHERE run_id = ?`).run(runId);

    harness.clock.advanceMs(40_000);

    // Contender attempts to steal
    expect(() => {
      harness.store.acquireTenantLaunchGate({
        runId,
        holderType: "RECOVERY",
        holderId: "new-supervisor",
        leaseId: "new-lease",
        nowIso: harness.clock.nowIso(),
        ttlMs: 30_000,
        ownerPid: 9999,
      });
    }).toThrow(TenantLaunchGateConflictError);

    try {
      harness.store.acquireTenantLaunchGate({
        runId,
        holderType: "RECOVERY",
        holderId: "new-supervisor",
        leaseId: "new-lease",
        nowIso: harness.clock.nowIso(),
        ttlMs: 30_000,
        ownerPid: 9999,
      });
    } catch (err) {
      expect((err as Error).message).toMatch(
        /process identity is unknown or unrecorded; tenant launch gate stealing refused fail-closed/
      );
    }
  });

  // 20. M1.1: expired ACQUIRED takeover requires the owner to be positively established as dead
  describe("Scenario 20: expired ACQUIRED takeover fail-closed on owner liveness (injectable boundary)", () => {
    const OLD_PID = 5001;
    type Probe = (pid: number) => boolean;

    function seedExpired(holderType: "WORKER" | "RECOVERY", probe: Probe) {
      const calls: number[] = [];
      const harness = setupHarness({
        isProcessAlive: (pid) => {
          calls.push(pid);
          return probe(pid);
        },
      });
      const original = harness.store.acquireTenantLaunchGate({
        runId: harness.runId,
        holderType,
        holderId: "old-owner",
        leaseId: "old-lease",
        nowIso: harness.clock.nowIso(),
        ttlMs: 30_000,
        ownerPid: OLD_PID,
      });
      harness.clock.advanceMs(40_000);
      return { harness, original, calls };
    }

    function contend(harness: ReturnType<typeof setupHarness>) {
      return harness.store.acquireTenantLaunchGate({
        runId: harness.runId,
        holderType: "RECOVERY",
        holderId: "new-owner",
        leaseId: "new-lease",
        nowIso: harness.clock.nowIso(),
        ttlMs: 30_000,
        ownerPid: 7001,
      });
    }

    function expectGateUnchanged(harness: ReturnType<typeof setupHarness>, original: { token: string; holderId: string; holderType: string }) {
      const gate = harness.store.getTenantLaunchGate(harness.runId)!;
      expect(gate.state).toBe("ACQUIRED");
      expect(gate.holderId).toBe(original.holderId);
      expect(gate.holderType).toBe(original.holderType);
      expect(gate.token).toBe(original.token);
    }

    for (const holderType of ["WORKER", "RECOVERY"] as const) {
      it(`${holderType} owner with missing/invalid PID is treated as unknown; takeover refused without consulting liveness`, () => {
        for (const bad of [null, 0, -7, 1.5, Number.NaN]) {
          const { harness, original, calls } = seedExpired(holderType, () => false /* would say "dead" if consulted */);
          (harness.store as any).db
            .prepare(`UPDATE tenant_launch_gates SET owner_pid = ? WHERE run_id = ?`)
            .run(bad, harness.runId);

          expect(() => contend(harness), `owner_pid=${String(bad)}`).toThrow(TenantLaunchGateConflictError);
          expect(calls).toEqual([]);
          expectGateUnchanged(harness, original);
        }
      });

      it(`${holderType} owner: live PID, EPERM and unexpected liveness errors all refuse takeover and preserve the gate`, () => {
        const probes: Array<[string, Probe]> = [
          ["live", () => true],
          ["EPERM", () => { throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }); }],
          ["unexpected", () => { throw new Error("liveness backend exploded"); }],
        ];
        for (const [label, probe] of probes) {
          const { harness, original, calls } = seedExpired(holderType, probe);
          expect(() => contend(harness), label).toThrow(TenantLaunchGateConflictError);
          expect(calls).toEqual([OLD_PID]);
          expectGateUnchanged(harness, original);
        }
      });

      it(`${holderType} owner confirmed absent (ESRCH) permits takeover with a new owner and token`, () => {
        const { harness, original, calls } = seedExpired(holderType, () => false);
        const taken = contend(harness);
        expect(calls).toEqual([OLD_PID]);
        expect(taken.state).toBe("ACQUIRED");
        expect(taken.holderId).toBe("new-owner");
        expect(taken.ownerPid).toBe(7001);
        expect(taken.token).not.toBe(original.token);
        const stored = harness.store.getTenantLaunchGate(harness.runId)!;
        expect(stored.holderId).toBe("new-owner");
        expect(stored.token).toBe(taken.token);
        expect(stored.state).toBe("ACQUIRED");
      });
    }

    it("QUIESCED gate with missing/invalid owner PID refuses takeover before an injected probe can say 'dead'", () => {
      for (const bad of [null, 0, -7, 1.5, Number.NaN]) {
        const calls: number[] = [];
        const harness = setupHarness({ isProcessAlive: (pid) => { calls.push(pid); return false; } });
        const original = harness.store.acquireTenantLaunchGate({
          runId: harness.runId,
          holderType: "RECOVERY",
          holderId: "old-owner",
          leaseId: "old-lease",
          nowIso: harness.clock.nowIso(),
          ttlMs: 30_000,
          ownerPid: OLD_PID,
        });
        harness.store.markQuiescentTenantLaunchGate({ runId: harness.runId, token: original.token, nowIso: harness.clock.nowIso() });
        (harness.store as any).db
          .prepare(`UPDATE tenant_launch_gates SET owner_pid = ? WHERE run_id = ?`)
          .run(bad, harness.runId);
        harness.clock.advanceMs(40_000);

        expect(() => contend(harness), `owner_pid=${String(bad)}`).toThrow(TenantLaunchGateConflictError);
        expect(calls).toEqual([]);
        const gate = harness.store.getTenantLaunchGate(harness.runId)!;
        expect(gate.state).toBe("QUIESCED");
        expect(gate.holderId).toBe("old-owner");
        expect(gate.token).toBe(original.token);
      }
    });

    it("defaultIsProcessAlive maps ESRCH to dead and EPERM or any other error to alive", () => {
      const withKillError = (code: string | undefined, fn: () => void) => {
        const spy = vi.spyOn(process, "kill").mockImplementation(() => {
          throw Object.assign(new Error(code ?? "boom"), code ? { code } : {});
        });
        try {
          fn();
        } finally {
          spy.mockRestore();
        }
      };
      withKillError("ESRCH", () => expect(defaultIsProcessAlive(4242)).toBe(false));
      withKillError("EPERM", () => expect(defaultIsProcessAlive(4242)).toBe(true));
      withKillError("EINVAL", () => expect(defaultIsProcessAlive(4242)).toBe(true));
      withKillError(undefined, () => expect(defaultIsProcessAlive(4242)).toBe(true));
    });
  });

  // 21. F-4.1: owner identity is (holderId, ownerPid). The same holderId from a different process is a takeover.
  describe("Scenario 21: same-ID gate ownership requires the recorded process or a liveness-proven takeover (SQLite)", () => {
    const OLD_PID = 6001;
    const NEW_PID = 6002;
    type GateState = "QUIESCED" | "ACQUIRED";

    function seed(state: GateState, probe: (pid: number) => boolean, holderType: "WORKER" | "RECOVERY" = "RECOVERY") {
      const calls: number[] = [];
      const harness = setupHarness({
        isProcessAlive: (pid) => {
          calls.push(pid);
          return probe(pid);
        },
      });
      const gate = harness.store.acquireTenantLaunchGate({
        runId: harness.runId,
        holderType,
        holderId: "sup-A",
        leaseId: "lease-A",
        nowIso: harness.clock.nowIso(),
        ttlMs: 30_000,
        ownerPid: OLD_PID,
      });
      if (state === "QUIESCED") {
        harness.store.markQuiescentTenantLaunchGate({ runId: harness.runId, token: gate.token, nowIso: harness.clock.nowIso() });
      }
      return { harness, gate, calls };
    }

    type Harness = ReturnType<typeof setupHarness>;
    const contend = (h: Harness, pid: number = NEW_PID, holderType: "WORKER" | "RECOVERY" = "RECOVERY", holderId = "sup-A") =>
      h.store.acquireTenantLaunchGate({
        runId: h.runId,
        holderType,
        holderId,
        leaseId: "lease-B",
        nowIso: h.clock.nowIso(),
        ttlMs: 30_000,
        ownerPid: pid,
      });
    const snapshot = (h: Harness) => {
      const g = h.store.getTenantLaunchGate(h.runId)!;
      return { state: g.state, holderId: g.holderId, holderType: g.holderType, token: g.token, ownerPid: g.ownerPid, expiresAt: g.expiresAt };
    };
    const setColumn = (h: Harness, column: "owner_pid" | "expires_at", value: unknown) =>
      (h.store as any).db.prepare(`UPDATE tenant_launch_gates SET ${column} = ? WHERE run_id = ?`).run(value, h.runId);

    for (const state of ["QUIESCED", "ACQUIRED"] as const) {
      it(`${state}: same ID from a different PID is refused while the recorded owner is alive (unexpired and expired)`, () => {
        const { harness, calls } = seed(state, () => true);
        const before = snapshot(harness);

        expect(() => contend(harness)).toThrow(TenantLaunchGateConflictError); // unexpired: refused before any liveness probe
        expect(snapshot(harness)).toEqual(before);

        harness.clock.advanceMs(40_000);
        expect(() => contend(harness)).toThrow(TenantLaunchGateConflictError); // expired, but the owner is alive
        expect(calls).toEqual([OLD_PID]);
        expect(snapshot(harness)).toEqual(before);
      });

      it(`${state}: same ID from a different PID succeeds only after the recorded owner is confirmed dead; the token changes`, () => {
        const { harness, gate, calls } = seed(state, () => false);
        harness.clock.advanceMs(40_000);

        const taken = contend(harness);

        expect(calls).toEqual([OLD_PID]);
        expect(taken.state).toBe("ACQUIRED");
        expect(taken.holderId).toBe("sup-A");
        expect(taken.ownerPid).toBe(NEW_PID);
        expect(taken.token).not.toBe(gate.token);
        expect(snapshot(harness).token).toBe(taken.token);
      });

      it(`${state}: an active supervisor lease for the holder blocks a same-ID takeover even when the PID is dead`, () => {
        const { harness } = seed(state, () => false);
        harness.store.acquireSupervisorLease({ runId: harness.runId, supervisorId: "sup-A", ttlMs: 60_000, nowIso: harness.clock.nowIso() });
        const before = snapshot(harness);
        harness.clock.advanceMs(40_000); // gate expired, supervisor lease (60s) still active

        expect(() => contend(harness)).toThrow(TenantLaunchGateConflictError);
        expect(snapshot(harness)).toEqual(before);
      });

      it(`${state}: an active supervisor lease blocks same-owner, same-PID re-entry as well (F-5.3)`, () => {
        const { harness } = seed(state, () => true);
        harness.store.acquireSupervisorLease({ runId: harness.runId, supervisorId: "sup-A", ttlMs: 60_000, nowIso: harness.clock.nowIso() });
        const before = snapshot(harness);

        // Attempt re-entry with OLD_PID (same owner, same PID) while supervisor lease is active
        expect(() => contend(harness, OLD_PID)).toThrow(TenantLaunchGateConflictError);
        expect(snapshot(harness)).toEqual(before);
      });

      it(`${state}: missing or invalid recorded owner PID is never proof of death (probe not consulted, gate unchanged)`, () => {
        for (const bad of [null, 0, -7, 1.5, Number.NaN]) {
          for (const contenderPid of [NEW_PID, OLD_PID]) {
            const { harness, calls } = seed(state, () => false);
            setColumn(harness, "owner_pid", bad);
            const before = snapshot(harness);
            harness.clock.advanceMs(40_000);

            expect(() => contend(harness, contenderPid), `owner_pid=${String(bad)} contender=${contenderPid}`).toThrow(TenantLaunchGateConflictError);
            expect(calls).toEqual([]);
            expect(snapshot(harness)).toEqual(before);
          }
        }
      });

      it(`${state}: malformed expires_at with the same ID never authorizes takeover from a different PID`, () => {
        const { harness, calls } = seed(state, () => false);
        setColumn(harness, "expires_at", "not-a-date");
        const before = snapshot(harness);
        harness.clock.advanceMs(40_000);

        expect(() => contend(harness)).toThrow(TenantLaunchGateConflictError);
        expect(calls).toEqual([]);
        expect(snapshot(harness)).toEqual(before);
      });
    }

    it("ACQUIRED: the recorded process cannot re-enter a gate whose expiry is malformed (expiry cannot be proven)", () => {
      const { harness } = seed("ACQUIRED", () => true);
      setColumn(harness, "expires_at", "not-a-date");
      const before = snapshot(harness);
      expect(() => contend(harness, OLD_PID)).toThrow(TenantLaunchGateConflictError);
      expect(snapshot(harness)).toEqual(before);
    });

    it("same-process re-entry: the recorded PID may reacquire its own QUIESCED gate (any time) and its own expired ACQUIRED gate, without a liveness probe", () => {
      const quiesced = seed("QUIESCED", () => true);
      const reentered = contend(quiesced.harness, OLD_PID); // unexpired QUIESCED, same ID, same PID
      expect(reentered.state).toBe("ACQUIRED");
      expect(reentered.token).not.toBe(quiesced.gate.token);
      expect(reentered.ownerPid).toBe(OLD_PID);
      expect(quiesced.calls).toEqual([]);

      const acquired = seed("ACQUIRED", () => true);
      expect(() => contend(acquired.harness, OLD_PID)).toThrow(TenantLaunchGateConflictError); // still unexpired: existing refusal
      acquired.harness.clock.advanceMs(40_000);
      const again = contend(acquired.harness, OLD_PID);
      expect(again.ownerPid).toBe(OLD_PID);
      expect(again.token).not.toBe(acquired.gate.token);
      expect(acquired.calls).toEqual([]);
    });

    it("QUIESCED: malformed expires_at does not block the recorded process re-entering its own gate (re-entry is not a takeover)", () => {
      const { harness, calls } = seed("QUIESCED", () => true);
      setColumn(harness, "expires_at", "not-a-date");
      const again = contend(harness, OLD_PID);
      expect(again.ownerPid).toBe(OLD_PID);
      expect(calls).toEqual([]);
    });

    it("different-holder takeover is unchanged: refused while the owner is alive, allowed once confirmed dead", () => {
      for (const state of ["QUIESCED", "ACQUIRED"] as const) {
        const alive = seed(state, () => true);
        const before = snapshot(alive.harness);
        alive.harness.clock.advanceMs(40_000);
        expect(() => contend(alive.harness, NEW_PID, "RECOVERY", "sup-B"), `${state} alive`).toThrow(TenantLaunchGateConflictError);
        expect(snapshot(alive.harness)).toEqual(before);

        const dead = seed(state, () => false);
        dead.harness.clock.advanceMs(40_000);
        const taken = contend(dead.harness, NEW_PID, "RECOVERY", "sup-B");
        expect(taken.holderId).toBe("sup-B");
        expect(taken.ownerPid).toBe(NEW_PID);
        expect(taken.token).not.toBe(dead.gate.token);
      }
    });
  });
});
