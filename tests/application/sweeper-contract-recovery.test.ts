import { describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator, WorkerRuntime } from "../../src/application/index.js";
import { LeaseLostError } from "../../src/domain/errors.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "../../src/ports/execution-provider.port.js";
import { createAndActivateContract } from "./test-helpers.js";

/**
 * Invocation-counting test provider.
 * Critical test fixture verifying providerInvocationCount === 0 on governance failures.
 */
class CountingExecutionProvider implements ExecutionProvider {
  readonly tenantModel = "NONE" as const;
  readonly quiescence = { async quiesceRun(_runId: string) { return { status: "QUIESCENT" as const, stopped: 0 }; } };
  readonly name: string;
  readonly invocations: ExecutionRequest[] = [];
  private readonly mockOutput: unknown;

  constructor(name: string = "in-process", mockOutput: unknown = { ok: true }) {
    this.name = name;
    this.mockOutput = mockOutput;
  }

  get providerInvocationCount(): number {
    return this.invocations.length;
  }

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocations.push(request);
    return {
      status: "SUCCESS",
      output: this.mockOutput as TOutput,
      durationMs: 5,
      providerMetadata: { provider: this.name, exitCode: 0 },
    };
  }
}

/**
 * Runs whose bound contract is missing or that have no binding are treated as possibly isolated, so recovery holds them
 * until a durable QUIESCED gate exists under the recovering supervisor. These tests target the governance failure that follows
 * quiescence, so they establish that gate first and name the supervisor on the retry sweep.
 */
function recoverUnderQuiescence(coordinator: RunCoordinator, store: SqliteStateStore, clock: SettableClock, runId: string) {
  const supervisorId = "sup-governance-test";
  const gate = store.acquireTenantLaunchGate({ runId, holderType: "RECOVERY", holderId: supervisorId, leaseId: "lease-gov", nowIso: clock.nowIso(), ttlMs: 30_000, ownerPid: process.pid });
  store.markQuiescentTenantLaunchGate({ runId, token: gate.token, nowIso: clock.nowIso() });
  return coordinator.recoverExpiredRuns({ supervisorId, quiescedGateTokens: new Map([[runId, gate.token]]) });
}

function registerWorker(coordinator: RunCoordinator, workerId: string, clock: SettableClock): void {
  coordinator.registerWorker({
    workerId,
    hostname: "localhost",
    pid: process.pid,
    status: "ACTIVE",
    lastHeartbeatAt: clock.nowIso(),
    createdAt: clock.nowIso(),
  });
}

describe("RunCoordinator — MissionContract-Aware Sweeper & Recovery (Task 1.8C-5)", () => {
  // =========================================================================
  // 1. Valid Recovery
  // =========================================================================
  describe("Valid Recovery with ACTIVE Contract", () => {
    it("1. Expired lease + ACTIVE matching contract -> existing recovery path succeeds", async () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process", { sum: 42 });

      registerWorker(coordinator, "worker-1", clock);

      const task = coordinator.createTask({ title: "echo", inputPayload: { val: 1 } });
      createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({
        taskId: task.taskId,
        maxAttempts: 3,
        timeoutMs: 15000,
        maxOutputBytes: 1048576,
      });
      coordinator.queueRun(run.runId);

      const claim = coordinator.claimRun(run.runId, "worker-1", 5000);
      coordinator.startRun(run.runId, "worker-1", claim.lease.leaseId);

      // Advance clock past lease expiry
      clock.advanceMs(6000);

      // Recover
      const recovery = coordinator.recoverExpiredRuns();
      expect(recovery.recoveredCount).toBe(1);

      const recovered = coordinator.getRun(run.runId);
      expect(recovered!.status).toBe("QUEUED");
      expect(recovered!.attemptCount).toBe(1);
      expect(recovered!.currentWorkerId).toBeNull();
      expect(recovered!.leaseId).toBeNull();
      expect(recovered!.leaseExpiresAt).toBeNull();

      // Now worker 2 executes recovered run to completion
      const worker2 = new WorkerRuntime({
        workerId: "worker-2",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker2.runOnce();
      expect(result.status).toBe("COMPLETED");
      expect(provider.providerInvocationCount).toBe(1);

      store.close();
    });

    it("2. Exact contract binding preserved during recovery", () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);

      registerWorker(coordinator, "worker-1", clock);

      const task = coordinator.createTask({ title: "echo", inputPayload: "abc" });
      const contract = createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3 });
      coordinator.queueRun(run.runId);

      const claim = coordinator.claimRun(run.runId, "worker-1", 5000);
      coordinator.startRun(run.runId, "worker-1", claim.lease.leaseId);

      clock.advanceMs(6000);
      coordinator.recoverExpiredRuns();

      const recovered = coordinator.getRun(run.runId);
      expect(recovered!.contractBinding).not.toBeNull();
      expect(recovered!.contractBinding!.contractId).toBe(contract.spec.contractId);
      expect(recovered!.contractBinding!.version).toBe(contract.spec.version);
      expect(recovered!.contractBinding!.contentHash).toBe(contract.contentHash);

      store.close();
    });

    it("3. Attempt count preserved and incremented according to existing recovery semantics", () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);

      registerWorker(coordinator, "w-1", clock);

      const task = coordinator.createTask({ title: "echo", inputPayload: 123 });
      createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3 });
      coordinator.queueRun(run.runId);

      // Attempt 0
      const claim1 = coordinator.claimRun(run.runId, "w-1", 5000);
      coordinator.startRun(run.runId, "w-1", claim1.lease.leaseId);

      expect(coordinator.getRun(run.runId)!.attemptCount).toBe(0);

      clock.advanceMs(6000);
      coordinator.recoverExpiredRuns();

      // After recovery: attemptCount is 1
      expect(coordinator.getRun(run.runId)!.attemptCount).toBe(1);

      store.close();
    });

    it("4. Idempotency key preserved across recovery", () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);

      registerWorker(coordinator, "w-1", clock);

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({
        taskId: task.taskId,
        idempotencyKey: "biz-key-unique-99",
        maxAttempts: 3,
      });
      coordinator.queueRun(run.runId);

      const claim = coordinator.claimRun(run.runId, "w-1", 5000);
      coordinator.startRun(run.runId, "w-1", claim.lease.leaseId);

      clock.advanceMs(6000);
      coordinator.recoverExpiredRuns();

      const recovered = coordinator.getRun(run.runId);
      expect(recovered!.idempotencyKey).toBe("biz-key-unique-99");

      store.close();
    });

    it("5. Resource limits preserved across recovery", () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);

      registerWorker(coordinator, "w-1", clock);

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      createAndActivateContract(store, task.taskId, {
        timeoutMs: 60000,
        maxAttempts: 5,
        maxOutputBytes: 524288,
      });

      const { run } = coordinator.createRun({
        taskId: task.taskId,
        timeoutMs: 45000,
        maxAttempts: 4,
        maxOutputBytes: 262144,
      });
      coordinator.queueRun(run.runId);

      const claim = coordinator.claimRun(run.runId, "w-1", 5000);
      coordinator.startRun(run.runId, "w-1", claim.lease.leaseId);

      clock.advanceMs(6000);
      coordinator.recoverExpiredRuns();

      const recovered = coordinator.getRun(run.runId);
      expect(recovered!.timeoutMs).toBe(45000);
      expect(recovered!.maxAttempts).toBe(4);
      expect(recovered!.maxOutputBytes).toBe(262144);

      store.close();
    });

    it("6. Lease fencing remains enforced after recovery", () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);

      registerWorker(coordinator, "worker-1", clock);
      registerWorker(coordinator, "worker-2", clock);

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3 });
      coordinator.queueRun(run.runId);

      // Worker 1 claims and starts
      const claim1 = coordinator.claimRun(run.runId, "worker-1", 5000);
      coordinator.startRun(run.runId, "worker-1", claim1.lease.leaseId);

      // Lease expires, recovered
      clock.advanceMs(6000);
      coordinator.recoverExpiredRuns();

      // Worker 2 claims recovered run
      const claim2 = coordinator.claimRun(run.runId, "worker-2", 5000);
      coordinator.startRun(run.runId, "worker-2", claim2.lease.leaseId);

      // Stale worker 1 attempts to complete run
      expect(() => {
        coordinator.completeRun(run.runId, "worker-1", claim1.lease.leaseId, "stale-result");
      }).toThrow(LeaseLostError);

      const currentRun = coordinator.getRun(run.runId);
      expect(currentRun!.status).toBe("RUNNING");
      expect(currentRun!.currentWorkerId).toBe("worker-2");

      store.close();
    });
  });

  // =========================================================================
  // 2. Revocation During Recovery
  // =========================================================================
  describe("Contract Revocation During Recovery", () => {
    it("7. Contract revoked before recovery -> FAILED / CONTRACT_REVOKED", () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);

      registerWorker(coordinator, "worker-1", clock);

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      const contract = createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3 });
      coordinator.queueRun(run.runId);

      const claim = coordinator.claimRun(run.runId, "worker-1", 5000);
      coordinator.startRun(run.runId, "worker-1", claim.lease.leaseId);

      // Worker crashes / lease expires
      clock.advanceMs(6000);

      // Contract is revoked before sweeper recovers the run
      store.revokeContract(contract.spec.contractId, contract.spec.version, "Security breach discovered");

      // Sweeper runs
      const recovery = coordinator.recoverExpiredRuns();
      expect(recovery.recoveredCount).toBe(1);

      const failedRun = coordinator.getRun(run.runId);
      expect(failedRun!.status).toBe("FAILED");
      const err = failedRun!.errorPayload as { code: string; message: string; details: any };
      expect(err.code).toBe("CONTRACT_REVOKED");
      expect(err.message).toContain("Security breach discovered");
      expect(err.details.status).toBe("REVOKED");
      expect(err.details.revocationReason).toBe("Security breach discovered");

      // Exact binding preserved
      expect(failedRun!.contractBinding!.contractId).toBe(contract.spec.contractId);
      expect(failedRun!.contractBinding!.version).toBe(contract.spec.version);
      expect(failedRun!.contractBinding!.contentHash).toBe(contract.contentHash);

      store.close();
    });

    it("8. Revoked v1 + active v2 -> recovery still fails with CONTRACT_REVOKED; never uses v2", () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);

      registerWorker(coordinator, "worker-1", clock);

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      const contractV1 = createAndActivateContract(store, task.taskId, { version: 1 });

      const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3 });
      coordinator.queueRun(run.runId);

      const claim = coordinator.claimRun(run.runId, "worker-1", 5000);
      coordinator.startRun(run.runId, "worker-1", claim.lease.leaseId);

      clock.advanceMs(6000);

      // Revoke v1 and create/activate v2 for the same task
      store.revokeContract(contractV1.spec.contractId, 1, "V1 deprecated");
      const contractV2 = createAndActivateContract(store, task.taskId, { version: 2 });
      expect(contractV2.lifecycle.status).toBe("ACTIVE");

      // Sweeper runs
      const recovery = coordinator.recoverExpiredRuns();
      expect(recovery.recoveredCount).toBe(1);

      const failedRun = coordinator.getRun(run.runId);
      expect(failedRun!.status).toBe("FAILED");
      expect((failedRun!.errorPayload as { code: string }).code).toBe("CONTRACT_REVOKED");

      // Invariant: Recovery MUST NOT substitute v2
      expect(failedRun!.contractBinding!.version).toBe(1);
      expect(failedRun!.contractBinding!.contractId).toBe(contractV1.spec.contractId);

      store.close();
    });

    it("9. Critical safety: providerInvocationCount === 0 after revoked-contract recovery failure", async () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process");

      registerWorker(coordinator, "w-1", clock);

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      const contract = createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const claim = coordinator.claimRun(run.runId, "w-1", 5000);
      coordinator.startRun(run.runId, "w-1", claim.lease.leaseId);

      clock.advanceMs(6000);
      store.revokeContract(contract.spec.contractId, contract.spec.version, "Emergency freeze");

      coordinator.recoverExpiredRuns();

      // Worker runs runOnce
      const worker = new WorkerRuntime({
        workerId: "w-sweeper-safety",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("IDLE"); // Run was FAILED, not QUEUED, so queue is empty
      expect(provider.providerInvocationCount).toBe(0);

      store.close();
    });
  });

  // =========================================================================
  // 3. Missing Contract During Recovery
  // =========================================================================
  describe("Missing Contract During Recovery", () => {
    it("10. Bound contract missing -> FAILED / MISSING_BOUND_CONTRACT", () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);

      registerWorker(coordinator, "w-1", clock);

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      const contract = createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const claim = coordinator.claimRun(run.runId, "w-1", 5000);
      coordinator.startRun(run.runId, "w-1", claim.lease.leaseId);

      clock.advanceMs(6000);

      // Contract deleted with foreign_keys OFF
      (store as any).db.exec("PRAGMA foreign_keys = OFF;");
      (store as any).db.prepare("DELETE FROM mission_contracts WHERE contract_id = ? AND version = ?")
        .run(contract.spec.contractId, contract.spec.version);
      (store as any).db.exec("PRAGMA foreign_keys = ON;");

      const recovery = recoverUnderQuiescence(coordinator, store, clock, run.runId);
      expect(recovery.recoveredCount).toBe(1);

      const failedRun = coordinator.getRunRaw(run.runId);
      expect(failedRun!.status).toBe("FAILED");
      const err = failedRun!.errorPayload as { code: string };
      expect(err.code).toBe("MISSING_BOUND_CONTRACT");

      store.close();
    });

    it("11. Missing v1 + active v2 -> recovery still fails with MISSING_BOUND_CONTRACT; never uses v2", () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);

      registerWorker(coordinator, "w-1", clock);

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      const contractV1 = createAndActivateContract(store, task.taskId, { version: 1 });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const claim = coordinator.claimRun(run.runId, "w-1", 5000);
      coordinator.startRun(run.runId, "w-1", claim.lease.leaseId);

      clock.advanceMs(6000);

      // Delete v1 and activate v2
      (store as any).db.exec("PRAGMA foreign_keys = OFF;");
      (store as any).db.prepare("DELETE FROM mission_contracts WHERE contract_id = ? AND version = 1")
        .run(contractV1.spec.contractId);
      (store as any).db.exec("PRAGMA foreign_keys = ON;");

      const contractV2 = createAndActivateContract(store, task.taskId, { version: 2 });
      expect(contractV2.lifecycle.status).toBe("ACTIVE");

      recoverUnderQuiescence(coordinator, store, clock, run.runId);

      const failedRun = coordinator.getRunRaw(run.runId);
      expect(failedRun!.status).toBe("FAILED");
      expect((failedRun!.errorPayload as { code: string }).code).toBe("MISSING_BOUND_CONTRACT");
      expect(failedRun!.contractBinding!.version).toBe(1); // Did not substitute v2

      store.close();
    });

    it("11b. Critical safety: providerInvocationCount === 0 after missing-contract recovery failure", async () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process");

      registerWorker(coordinator, "w-1", clock);

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      const contract = createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const claim = coordinator.claimRun(run.runId, "w-1", 5000);
      coordinator.startRun(run.runId, "w-1", claim.lease.leaseId);

      clock.advanceMs(6000);

      (store as any).db.exec("PRAGMA foreign_keys = OFF;");
      (store as any).db.prepare("DELETE FROM mission_contracts WHERE contract_id = ? AND version = ?")
        .run(contract.spec.contractId, contract.spec.version);
      (store as any).db.exec("PRAGMA foreign_keys = ON;");

      coordinator.recoverExpiredRuns();

      const worker = new WorkerRuntime({
        workerId: "w-missing-safety",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("IDLE");
      expect(provider.providerInvocationCount).toBe(0);

      store.close();
    });
  });

  // =========================================================================
  // 4. Contract Integrity During Recovery
  // =========================================================================
  describe("Contract Integrity Verification During Recovery", () => {
    it("12. Contract canonical spec tampered -> FAILED / CONTRACT_INTEGRITY_MISMATCH", () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);

      registerWorker(coordinator, "w-1", clock);

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      const contract = createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const claim = coordinator.claimRun(run.runId, "w-1", 5000);
      coordinator.startRun(run.runId, "w-1", claim.lease.leaseId);

      clock.advanceMs(6000);

      // Tamper canonical_spec in DB directly
      const tamperedSpec = JSON.stringify({ ...contract.spec, taskId: "tampered-task-id" });
      (store as any).db.prepare("UPDATE mission_contracts SET canonical_spec = ? WHERE contract_id = ? AND version = ?")
        .run(tamperedSpec, contract.spec.contractId, contract.spec.version);

      recoverUnderQuiescence(coordinator, store, clock, run.runId);

      const failedRun = coordinator.getRunRaw(run.runId);
      expect(failedRun!.status).toBe("FAILED");
      const err = failedRun!.errorPayload as { code: string };
      expect(err.code).toBe("CONTRACT_INTEGRITY_MISMATCH");

      store.close();
    });

    it("12b. Tampered contract holds only its own run (no abort) and later runs still recover", () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      registerWorker(coordinator, "w-1", clock);
      registerWorker(coordinator, "w-2", clock);

      const startRun = (workerId: string) => {
        const task = coordinator.createTask({ title: "echo", inputPayload: null });
        const contract = createAndActivateContract(store, task.taskId);
        const { run } = coordinator.createRun({ taskId: task.taskId });
        coordinator.queueRun(run.runId);
        const claim = coordinator.claimRun(run.runId, workerId, 5000);
        coordinator.startRun(run.runId, workerId, claim.lease.leaseId);
        return { run, contract };
      };
      const bad = startRun("w-1");
      const good = startRun("w-2");
      clock.advanceMs(6000);

      const tamperedSpec = JSON.stringify({ ...bad.contract.spec, taskId: "tampered-task-id" });
      (store as any).db.prepare("UPDATE mission_contracts SET canonical_spec = ? WHERE contract_id = ? AND version = ?")
        .run(tamperedSpec, bad.contract.spec.contractId, bad.contract.spec.version);

      const result = coordinator.recoverExpiredRuns();
      expect(result.heldForQuiescenceRunIds).toContain(bad.run.runId);
      expect(coordinator.getRunRaw(bad.run.runId)!.status).toBe("RUNNING");
      expect(coordinator.getRun(good.run.runId)!.status).not.toBe("RUNNING");

      store.close();
    });

    it("13. Contract contentHash differs from Run binding -> FAILED / CONTRACT_INTEGRITY_MISMATCH", () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);

      registerWorker(coordinator, "w-1", clock);

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const claim = coordinator.claimRun(run.runId, "w-1", 5000);
      coordinator.startRun(run.runId, "w-1", claim.lease.leaseId);

      clock.advanceMs(6000);

      // Tamper contract_hash on runs table directly
      const fakeHash = "f".repeat(64);
      (store as any).db.prepare("UPDATE runs SET contract_hash = ? WHERE run_id = ?")
        .run(fakeHash, run.runId);

      coordinator.recoverExpiredRuns();

      const failedRun = coordinator.getRunRaw(run.runId);
      expect(failedRun!.status).toBe("FAILED");
      const err = failedRun!.errorPayload as { code: string };
      expect(err.code).toBe("CONTRACT_INTEGRITY_MISMATCH");

      store.close();
    });

    it("14. Integrity failure does not retry (remains FAILED, attemptCount unchanged)", () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);

      registerWorker(coordinator, "w-1", clock);

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const claim = coordinator.claimRun(run.runId, "w-1", 5000);
      coordinator.startRun(run.runId, "w-1", claim.lease.leaseId);

      clock.advanceMs(6000);

      const fakeHash = "e".repeat(64);
      (store as any).db.prepare("UPDATE runs SET contract_hash = ? WHERE run_id = ?")
        .run(fakeHash, run.runId);

      coordinator.recoverExpiredRuns();

      const failedRun = coordinator.getRunRaw(run.runId);
      expect(failedRun!.status).toBe("FAILED");
      expect(failedRun!.attemptCount).toBe(0); // Did not consume attempt, did not increment

      // Verify no queued runs available
      const next = coordinator.getNextQueuedRun();
      expect(next).toBeNull();

      store.close();
    });

    it("14b. Critical safety: providerInvocationCount === 0 after integrity failure", async () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process");

      registerWorker(coordinator, "w-1", clock);

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const claim = coordinator.claimRun(run.runId, "w-1", 5000);
      coordinator.startRun(run.runId, "w-1", claim.lease.leaseId);

      clock.advanceMs(6000);

      const fakeHash = "d".repeat(64);
      (store as any).db.prepare("UPDATE runs SET contract_hash = ? WHERE run_id = ?")
        .run(fakeHash, run.runId);

      coordinator.recoverExpiredRuns();

      const worker = new WorkerRuntime({
        workerId: "w-integrity-safety",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("IDLE");
      expect(provider.providerInvocationCount).toBe(0);

      store.close();
    });
  });

  // =========================================================================
  // 5. Task Mismatch During Recovery
  // =========================================================================
  describe("Task Association Mismatch During Recovery", () => {
    it("15. Bound contract belongs to another task -> FAILED / MISSION_CONTRACT_TASK_MISMATCH", () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);

      registerWorker(coordinator, "w-1", clock);

      const taskA = coordinator.createTask({ title: "echo", inputPayload: null });
      const taskB = coordinator.createTask({ title: "echo", inputPayload: null });

      createAndActivateContract(store, taskA.taskId);
      const contractB = createAndActivateContract(store, taskB.taskId);

      const { run } = coordinator.createRun({ taskId: taskA.taskId });
      coordinator.queueRun(run.runId);

      const claim = coordinator.claimRun(run.runId, "w-1", 5000);
      coordinator.startRun(run.runId, "w-1", claim.lease.leaseId);

      clock.advanceMs(6000);

      // Tamper run to point to contract B (which belongs to taskB, but run is for taskA)
      (store as any).db.prepare(
        "UPDATE runs SET contract_id = ?, contract_version = ?, contract_hash = ? WHERE run_id = ?"
      ).run(contractB.spec.contractId, contractB.spec.version, contractB.contentHash, run.runId);

      coordinator.recoverExpiredRuns();

      const failedRun = coordinator.getRun(run.runId);
      expect(failedRun!.status).toBe("FAILED");
      const err = failedRun!.errorPayload as { code: string };
      expect(err.code).toBe("MISSION_CONTRACT_TASK_MISMATCH");

      store.close();
    });

    it("15b. Critical safety: providerInvocationCount === 0 after task mismatch failure", async () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process");

      registerWorker(coordinator, "w-1", clock);

      const taskA = coordinator.createTask({ title: "echo", inputPayload: null });
      const taskB = coordinator.createTask({ title: "echo", inputPayload: null });

      createAndActivateContract(store, taskA.taskId);
      const contractB = createAndActivateContract(store, taskB.taskId);

      const { run } = coordinator.createRun({ taskId: taskA.taskId });
      coordinator.queueRun(run.runId);

      const claim = coordinator.claimRun(run.runId, "w-1", 5000);
      coordinator.startRun(run.runId, "w-1", claim.lease.leaseId);

      clock.advanceMs(6000);

      (store as any).db.prepare(
        "UPDATE runs SET contract_id = ?, contract_version = ?, contract_hash = ? WHERE run_id = ?"
      ).run(contractB.spec.contractId, contractB.spec.version, contractB.contentHash, run.runId);

      coordinator.recoverExpiredRuns();

      const worker = new WorkerRuntime({
        workerId: "w-mismatch-safety",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("IDLE");
      expect(provider.providerInvocationCount).toBe(0);

      store.close();
    });
  });

  // =========================================================================
  // 6. Legacy Unbound Runs
  // =========================================================================
  describe("Legacy Unbound Run Handling", () => {
    it("16. Legacy terminal Run remains untouched and readable", () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);

      registerWorker(coordinator, "old-worker", clock);

      const task = coordinator.createTask({ title: "echo", inputPayload: null });

      // Directly insert historical legacy COMPLETED run (pre-1.8C)
      const legacyRunId = "legacy-completed-run-001";
      (store as any).db.prepare(`
        INSERT INTO runs (
          run_id, task_id, status, version, attempt_count, max_attempts,
          timeout_ms, idempotency_key, current_worker_id, lease_id, lease_expires_at,
          result_payload, error_payload, created_at, updated_at,
          contract_id, contract_version, contract_hash, max_output_bytes
        ) VALUES (
          ?, ?, 'COMPLETED', 2, 0, 3,
          30000, NULL, 'old-worker', NULL, NULL,
          '{"legacy":true}', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z',
          NULL, NULL, NULL, NULL
        )
      `).run(legacyRunId, task.taskId);

      // Verify readable as snapshot
      const snapshot = coordinator.getRun(legacyRunId);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.status).toBe("COMPLETED");
      expect(snapshot!.contractBinding).toBeNull();
      expect(snapshot!.maxOutputBytes).toBeNull();
      expect(snapshot!.resultPayload).toEqual({ legacy: true });

      // Sweeper runs: does NOT touch terminal run
      const recovery = coordinator.recoverExpiredRuns();
      expect(recovery.recoveredCount).toBe(0);

      const unchanged = coordinator.getRun(legacyRunId);
      expect(unchanged!.status).toBe("COMPLETED");

      store.close();
    });

    it("17. Legacy nonterminal Run fails closed on lease expiration recovery (UNBOUND_RUN_EXECUTION_DISALLOWED)", () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);

      registerWorker(coordinator, "old-worker", clock);

      const task = coordinator.createTask({ title: "echo", inputPayload: null });

      // Insert legacy RUNNING run with expired lease
      const legacyRunId = "legacy-running-run-002";
      (store as any).db.prepare(`
        INSERT INTO runs (
          run_id, task_id, status, version, attempt_count, max_attempts,
          timeout_ms, idempotency_key, current_worker_id, lease_id, lease_expires_at,
          result_payload, error_payload, created_at, updated_at,
          contract_id, contract_version, contract_hash, max_output_bytes
        ) VALUES (
          ?, ?, 'RUNNING', 1, 0, 3,
          30000, NULL, 'old-worker', 'legacy-lease-002', '2026-03-30T10:00:05.000Z',
          NULL, NULL, '2026-03-30T10:00:00.000Z', '2026-03-30T10:00:00.000Z',
          NULL, NULL, NULL, NULL
        )
      `).run(legacyRunId, task.taskId);

      // Advance clock past lease expiry
      clock.advanceMs(10000);

      // Sweeper discovers expired legacy run
      const recovery = recoverUnderQuiescence(coordinator, store, clock, legacyRunId);
      expect(recovery.recoveredCount).toBe(1);

      const failedRun = coordinator.getRun(legacyRunId);
      expect(failedRun!.status).toBe("FAILED");
      const err = failedRun!.errorPayload as { code: string };
      expect(err.code).toBe("UNBOUND_RUN_EXECUTION_DISALLOWED");
      expect(failedRun!.contractBinding).toBeNull(); // Never fabricated contract history

      store.close();
    });

    it("18. Legacy nonterminal Run never binds to current active contract", () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);

      registerWorker(coordinator, "old-worker", clock);

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      // Active contract exists for the task
      createAndActivateContract(store, task.taskId);

      // Insert legacy RUNNING run with expired lease
      const legacyRunId = "legacy-running-run-003";
      (store as any).db.prepare(`
        INSERT INTO runs (
          run_id, task_id, status, version, attempt_count, max_attempts,
          timeout_ms, idempotency_key, current_worker_id, lease_id, lease_expires_at,
          result_payload, error_payload, created_at, updated_at,
          contract_id, contract_version, contract_hash, max_output_bytes
        ) VALUES (
          ?, ?, 'RUNNING', 1, 0, 3,
          30000, NULL, 'old-worker', 'legacy-lease-003', '2026-03-30T10:00:05.000Z',
          NULL, NULL, '2026-03-30T10:00:00.000Z', '2026-03-30T10:00:00.000Z',
          NULL, NULL, NULL, NULL
        )
      `).run(legacyRunId, task.taskId);

      clock.advanceMs(10000);

      recoverUnderQuiescence(coordinator, store, clock, legacyRunId);

      const failedRun = coordinator.getRun(legacyRunId);
      expect(failedRun!.status).toBe("FAILED");
      expect(failedRun!.contractBinding).toBeNull(); // Invariant: did NOT silently bind to activeContract

      store.close();
    });

    it("18b. Critical safety: providerInvocationCount === 0 for legacy unbound run", async () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process");

      registerWorker(coordinator, "old-worker", clock);

      const task = coordinator.createTask({ title: "echo", inputPayload: null });

      const legacyRunId = "legacy-running-run-004";
      (store as any).db.prepare(`
        INSERT INTO runs (
          run_id, task_id, status, version, attempt_count, max_attempts,
          timeout_ms, idempotency_key, current_worker_id, lease_id, lease_expires_at,
          result_payload, error_payload, created_at, updated_at,
          contract_id, contract_version, contract_hash, max_output_bytes
        ) VALUES (
          ?, ?, 'RUNNING', 1, 0, 3,
          30000, NULL, 'old-worker', 'legacy-lease-004', '2026-03-30T10:00:05.000Z',
          NULL, NULL, '2026-03-30T10:00:00.000Z', '2026-03-30T10:00:00.000Z',
          NULL, NULL, NULL, NULL
        )
      `).run(legacyRunId, task.taskId);

      clock.advanceMs(10000);
      coordinator.recoverExpiredRuns();

      const worker = new WorkerRuntime({
        workerId: "w-legacy-safety",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("IDLE");
      expect(provider.providerInvocationCount).toBe(0);

      store.close();
    });
  });

  // =========================================================================
  // 7. Retry Semantics
  // =========================================================================
  describe("Retry Semantics & Governance Failures", () => {
    it("19. Governance failures do not consume normal execution retry budget", () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);

      registerWorker(coordinator, "w-1", clock);

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      const contract = createAndActivateContract(store, task.taskId, { maxAttempts: 5 });

      const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 5 });
      coordinator.queueRun(run.runId);

      const claim = coordinator.claimRun(run.runId, "w-1", 5000);
      coordinator.startRun(run.runId, "w-1", claim.lease.leaseId);

      clock.advanceMs(6000);

      // Contract revoked
      store.revokeContract(contract.spec.contractId, contract.spec.version, "Revoked for audit");

      coordinator.recoverExpiredRuns();

      const failedRun = coordinator.getRun(run.runId);
      expect(failedRun!.status).toBe("FAILED");
      expect(failedRun!.attemptCount).toBe(0); // Invariant: did NOT consume retry, attempt count remains 0

      store.close();
    });

    it("20. Valid recovery preserves existing retry exhaustion semantics", () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);

      registerWorker(coordinator, "w-1", clock);

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      createAndActivateContract(store, task.taskId);

      // Max attempts = 1
      const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 1 });
      coordinator.queueRun(run.runId);

      // Attempt 1 (attemptCount: 0)
      const claim1 = coordinator.claimRun(run.runId, "w-1", 2000);
      coordinator.startRun(run.runId, "w-1", claim1.lease.leaseId);

      clock.advanceMs(3000);
      // Recovery 1: attemptCount becomes 1, status becomes QUEUED
      const rec1 = coordinator.recoverExpiredRuns();
      expect(rec1.recoveredCount).toBe(1);
      expect(coordinator.getRun(run.runId)!.status).toBe("QUEUED");
      expect(coordinator.getRun(run.runId)!.attemptCount).toBe(1);

      // Attempt 2 starts (attemptCount = 1)
      const claim2 = coordinator.claimRun(run.runId, "w-1", 2000);
      coordinator.startRun(run.runId, "w-1", claim2.lease.leaseId);

      clock.advanceMs(3000);
      // Recovery 2: attemptCount is 1, maxAttempts is 1 -> RETRIES_EXHAUSTED -> FAILED
      const rec2 = coordinator.recoverExpiredRuns();
      expect(rec2.recoveredCount).toBe(1);

      const exhaustedRun = coordinator.getRun(run.runId);
      expect(exhaustedRun!.status).toBe("FAILED");
      expect((exhaustedRun!.errorPayload as { code: string }).code).toBe("RETRIES_EXHAUSTED");

      store.close();
    });
  });

  // =========================================================================
  // 8. Concurrency & Fencing
  // =========================================================================
  describe("Concurrency & Lease Fencing During Recovery", () => {
    it("21. Stale worker cannot recover after lease ownership changes", () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);

      registerWorker(coordinator, "worker-stale", clock);
      registerWorker(coordinator, "worker-fresh", clock);

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3 });
      coordinator.queueRun(run.runId);

      const claim1 = coordinator.claimRun(run.runId, "worker-stale", 2000);
      coordinator.startRun(run.runId, "worker-stale", claim1.lease.leaseId);

      clock.advanceMs(3000);
      coordinator.recoverExpiredRuns();

      // Worker fresh claims recovered run
      const claim2 = coordinator.claimRun(run.runId, "worker-fresh", 5000);
      coordinator.startRun(run.runId, "worker-fresh", claim2.lease.leaseId);

      // Stale worker tries to complete with stale leaseId
      expect(() => {
        coordinator.completeRun(run.runId, "worker-stale", claim1.lease.leaseId, { ok: false });
      }).toThrow(LeaseLostError);

      const currentRun = coordinator.getRun(run.runId);
      expect(currentRun!.currentWorkerId).toBe("worker-fresh");
      expect(currentRun!.leaseId).toBe(claim2.lease.leaseId);

      store.close();
    });

    it("22. Concurrent recovery attempts remain protected by existing OCC/lease fencing", () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);

      registerWorker(coordinator, "w-1", clock);

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3 });
      coordinator.queueRun(run.runId);

      const claim = coordinator.claimRun(run.runId, "w-1", 2000);
      coordinator.startRun(run.runId, "w-1", claim.lease.leaseId);

      clock.advanceMs(3000);

      // First recovery run
      const recovery1 = coordinator.recoverExpiredRuns();
      expect(recovery1.recoveredCount).toBe(1);

      // Second immediate recovery run: run is already QUEUED, not RUNNING/LEASED
      const recovery2 = coordinator.recoverExpiredRuns();
      expect(recovery2.recoveredCount).toBe(0);

      const recovered = coordinator.getRun(run.runId);
      expect(recovered!.status).toBe("QUEUED");
      expect(recovered!.attemptCount).toBe(1);

      store.close();
    });
  });
});
