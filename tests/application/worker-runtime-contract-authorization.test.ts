import { describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator, WorkerRuntime } from "../../src/application/index.js";
import { createAndActivateContract } from "./test-helpers.js";
import {
  createDefaultInProcessPolicy,
  createExecutionPolicy,
} from "../../src/domain/policy.js";
import { createVerificationSpec } from "../../src/domain/verification.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "../../src/ports/execution-provider.port.js";

/**
 * Spy ExecutionProvider tracking provider invocation count.
 * Critical test fixture asserting zero executions occur on governance failures.
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

describe("WorkerRuntime — MissionContract Pre-Dispatch Authorization Boundary (Task 1.8C-4)", () => {
  // =========================================================================
  // Contract Resolution (Tests 1–8)
  // =========================================================================
  describe("Contract Resolution & Integrity Verification", () => {
    it("1. Governed Run resolves exact bound contract", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process", { sum: 42 });

      const task = coordinator.createTask({
        title: "sum",
        inputPayload: [20, 22],
      });
      const contract = createAndActivateContract(store, task.taskId, {
        verificationSpecs: [createVerificationSpec({ specId: "vspec-sum-42", ruleKind: "EXACT_OUTPUT_MATCH", expectedValue: { sum: 42 } })],
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const worker = new WorkerRuntime({
        workerId: "w-resolves-exact",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("COMPLETED");
      expect(provider.providerInvocationCount).toBe(1);

      const completedRun = coordinator.getRun(run.runId);
      expect(completedRun!.contractBinding!.contractId).toBe(contract.spec.contractId);
      expect(completedRun!.contractBinding!.version).toBe(contract.spec.version);
      expect(completedRun!.contractBinding!.contentHash).toBe(contract.contentHash);

      store.close();
    });

    it("2. Worker never performs latest-contract lookup", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process", { echoed: true });

      const task = coordinator.createTask({
        title: "echo",
        inputPayload: { val: 1 },
      });

      // Contract v1 is active
      const contractV1 = createAndActivateContract(store, task.taskId, {
        version: 1,
        contractId: `contract-${task.taskId}-v1`,
      });

      // Run is bound to v1
      const { run } = coordinator.createRun({ taskId: task.taskId });
      expect(run.contractBinding!.version).toBe(1);
      coordinator.queueRun(run.runId);

      // Now revoke v1 and activate a different contract v2 for the same task
      store.revokeContract(contractV1.spec.contractId, 1, "superseded");
      createAndActivateContract(store, task.taskId, {
        version: 2,
        contractId: `contract-${task.taskId}-v2`,
      });

      // Worker executes Run. Run is bound to v1 (now REVOKED), so it MUST fail on v1
      // and NOT silently switch to the latest active v2!
      const worker = new WorkerRuntime({
        workerId: "w-no-latest-lookup",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("FAILED");
      if (result.status === "FAILED") {
        const err = result.error as { code: string };
        expect(err.code).toBe("CONTRACT_REVOKED");
      }
      expect(provider.providerInvocationCount).toBe(0);

      store.close();
    });

    it("3. Missing bound contract → fail closed", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process");

      const task = coordinator.createTask({
        title: "echo",
        inputPayload: null,
      });
      const contract = createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      // Delete the contract from SQLite directly with foreign_keys OFF to simulate missing bound contract
      (store as any).db.exec("PRAGMA foreign_keys = OFF;");
      (store as any).db.prepare("DELETE FROM mission_contracts WHERE contract_id = ? AND version = ?")
        .run(contract.spec.contractId, contract.spec.version);
      (store as any).db.exec("PRAGMA foreign_keys = ON;");

      const worker = new WorkerRuntime({
        workerId: "w-missing-contract",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("FAILED");
      if (result.status === "FAILED") {
        const err = result.error as { code: string };
        expect(err.code).toBe("MISSING_BOUND_CONTRACT");
      }
      expect(provider.providerInvocationCount).toBe(0);

      store.close();
    });

    it("4. Wrong contract version → fail closed", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process");

      const task = coordinator.createTask({
        title: "echo",
        inputPayload: null,
      });
      createAndActivateContract(store, task.taskId, { version: 1 });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      // Modify run's binding in DB to non-existent version 99 with foreign_keys OFF
      (store as any).db.exec("PRAGMA foreign_keys = OFF;");
      (store as any).db.prepare("UPDATE runs SET contract_version = 99 WHERE run_id = ?")
        .run(run.runId);
      (store as any).db.exec("PRAGMA foreign_keys = ON;");

      const worker = new WorkerRuntime({
        workerId: "w-wrong-version",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("FAILED");
      if (result.status === "FAILED") {
        const err = result.error as { code: string };
        expect(err.code).toBe("MISSING_BOUND_CONTRACT");
      }
      expect(provider.providerInvocationCount).toBe(0);

      store.close();
    });

    it("5. Wrong contract ID → fail closed", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process");

      const task = coordinator.createTask({
        title: "echo",
        inputPayload: null,
      });
      createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      // Modify run's binding in DB to wrong contractId with foreign_keys OFF
      (store as any).db.exec("PRAGMA foreign_keys = OFF;");
      (store as any).db.prepare("UPDATE runs SET contract_id = 'wrong-contract-id' WHERE run_id = ?")
        .run(run.runId);
      (store as any).db.exec("PRAGMA foreign_keys = ON;");

      const worker = new WorkerRuntime({
        workerId: "w-wrong-id",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("FAILED");
      if (result.status === "FAILED") {
        const err = result.error as { code: string };
        expect(err.code).toBe("MISSING_BOUND_CONTRACT");
      }
      expect(provider.providerInvocationCount).toBe(0);

      store.close();
    });

    it("6. Contract task mismatch → fail closed", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process");

      const taskA = coordinator.createTask({ title: "echo", inputPayload: null });
      const taskB = coordinator.createTask({ title: "echo", inputPayload: null });

      // Create contract for task B
      const contractB = createAndActivateContract(store, taskB.taskId);

      // Create run for task A, but forge/tamper its binding to contract B
      createAndActivateContract(store, taskA.taskId);
      const { run } = coordinator.createRun({ taskId: taskA.taskId });
      coordinator.queueRun(run.runId);

      // Tamper run to point to contract B
      (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } })
        .db.prepare(
          "UPDATE runs SET contract_id = ?, contract_version = ?, contract_hash = ? WHERE run_id = ?"
        )
        .run(contractB.spec.contractId, contractB.spec.version, contractB.contentHash, run.runId);

      const worker = new WorkerRuntime({
        workerId: "w-task-mismatch",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("FAILED");
      if (result.status === "FAILED") {
        const err = result.error as { code: string };
        expect(err.code).toBe("MISSION_CONTRACT_TASK_MISMATCH");
      }
      expect(provider.providerInvocationCount).toBe(0);

      store.close();
    });

    it("7. Contract hash mismatch → fail closed", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process");

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      // Tamper run's bound hash
      const fakeHash = "a".repeat(64);
      (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } })
        .db.prepare("UPDATE runs SET contract_hash = ? WHERE run_id = ?")
        .run(fakeHash, run.runId);

      const worker = new WorkerRuntime({
        workerId: "w-hash-mismatch",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce(run.runId);
      expect(result.status).toBe("FAILED");
      if (result.status === "FAILED") {
        const err = result.error as { code: string };
        expect(err.code).toBe("CONTRACT_INTEGRITY_MISMATCH");
      }
      expect(provider.providerInvocationCount).toBe(0);

      store.close();
    });

    it("8. Tampered contract specification in database → fail closed", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process");

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      const contract = createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      // Tamper the stored canonical_spec JSON in mission_contracts table without updating content_hash
      const tamperedSpec = {
        ...contract.spec,
        resourceLimits: { timeoutMs: 999999, maxAttempts: 99, maxOutputBytes: 99999999 },
      };
      (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } })
        .db.prepare("UPDATE mission_contracts SET canonical_spec = ? WHERE contract_id = ?")
        .run(JSON.stringify(tamperedSpec), contract.spec.contractId);

      const worker = new WorkerRuntime({
        workerId: "w-tampered-spec",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce(run.runId);
      expect(result.status).toBe("FAILED");
      if (result.status === "FAILED") {
        const err = result.error as { code: string };
        expect(err.code).toBe("CONTRACT_INTEGRITY_MISMATCH");
      }
      expect(provider.providerInvocationCount).toBe(0);

      store.close();
    });
  });

  // =========================================================================
  // Lifecycle Authorization (Tests 9–12)
  // =========================================================================
  describe("Lifecycle Authorization", () => {
    it("9. ACTIVE contract → execution allowed", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process", { ok: true });

      const task = coordinator.createTask({ title: "echo", inputPayload: { active: true } });
      createAndActivateContract(store, task.taskId, {
        verificationSpecs: [createVerificationSpec({ specId: "vspec-ok", ruleKind: "EXACT_OUTPUT_MATCH", expectedValue: { ok: true } })],
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const worker = new WorkerRuntime({
        workerId: "w-active-allowed",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("COMPLETED");
      expect(provider.providerInvocationCount).toBe(1);

      store.close();
    });

    it("10. DRAFT contract → execution rejected", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process");

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      const contract = createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      // Now set contract in DB to DRAFT
      (store as any).db
        .prepare("UPDATE mission_contracts SET status = 'DRAFT', activated_at = NULL WHERE contract_id = ?")
        .run(contract.spec.contractId);

      const worker = new WorkerRuntime({
        workerId: "w-draft-rejected",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("FAILED");
      if (result.status === "FAILED") {
        const err = result.error as { code: string };
        expect(err.code).toBe("CONTRACT_NOT_ACTIVE");
      }
      expect(provider.providerInvocationCount).toBe(0);

      store.close();
    });

    it("11. REVOKED contract → execution rejected", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process");

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      const contract = createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      // Revoke the contract before execution
      store.revokeContract(contract.spec.contractId, contract.spec.version, "Security incident detected");

      const worker = new WorkerRuntime({
        workerId: "w-revoked-rejected",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("FAILED");
      if (result.status === "FAILED") {
        const err = result.error as { code: string; message: string };
        expect(err.code).toBe("CONTRACT_REVOKED");
        expect(err.message).toContain("Security incident detected");
      }
      expect(provider.providerInvocationCount).toBe(0);

      store.close();
    });

    it("12. Revoked contract does not switch execution to a newer ACTIVE contract", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process");

      const task = coordinator.createTask({ title: "echo", inputPayload: null });

      // Contract v1
      const cV1 = createAndActivateContract(store, task.taskId, {
        contractId: `gov-${task.taskId}-1`,
        version: 1,
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      // Revoke v1
      store.revokeContract(cV1.spec.contractId, 1, "revoked v1");

      // Activate new contract v2
      createAndActivateContract(store, task.taskId, {
        contractId: `gov-${task.taskId}-2`,
        version: 2,
      });

      const worker = new WorkerRuntime({
        workerId: "w-no-switch-v2",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("FAILED");
      if (result.status === "FAILED") {
        const err = result.error as { code: string };
        expect(err.code).toBe("CONTRACT_REVOKED");
      }
      expect(provider.providerInvocationCount).toBe(0);

      store.close();
    });
  });

  // =========================================================================
  // Policy Authorization (Tests 13–16)
  // =========================================================================
  describe("Policy Authorization", () => {
    it("13. Allowed capability → policy passes", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process", { echoed: 123 });

      const policy = createExecutionPolicy({
        policyId: "allow-echo-policy",
        allowedCapabilities: ["execution.echo"],
        isolationRequirement: "IN_PROCESS",
        trustedInProcessOperations: ["echo", "execution.echo"],
      });

      const task = coordinator.createTask({ title: "echo", inputPayload: 123 });
      createAndActivateContract(store, task.taskId, {
        policy,
        verificationSpecs: [createVerificationSpec({ specId: "vspec-echo-123", ruleKind: "EXACT_OUTPUT_MATCH", expectedValue: { echoed: 123 } })],
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const worker = new WorkerRuntime({
        workerId: "w-allowed-cap",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("COMPLETED");
      expect(provider.providerInvocationCount).toBe(1);

      const events = coordinator.getEventsForRun(run.runId);
      const policyEvt = events.find((e) => e.eventType === "policy.evaluated");
      expect(policyEvt).toBeDefined();
      expect((policyEvt!.payload as { allowed: boolean }).allowed).toBe(true);

      store.close();
    });

    it("14. Denied capability → no provider call", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process");

      // Policy allows only sum, task is echo
      const policy = createExecutionPolicy({
        policyId: "sum-only-policy",
        allowedCapabilities: ["execution.sum"],
        isolationRequirement: "IN_PROCESS",
        trustedInProcessOperations: ["sum"],
      });

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      createAndActivateContract(store, task.taskId, {
        policy,
        verificationSpecs: [createVerificationSpec({ specId: "vspec-docker", ruleKind: "EXACT_OUTPUT_MATCH", expectedValue: { isolatedResult: true } })],
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const worker = new WorkerRuntime({
        workerId: "w-denied-cap",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("FAILED");
      if (result.status === "FAILED") {
        const err = result.error as { code: string };
        expect(err.code).toBe("POLICY_DENIED");
      }
      expect(provider.providerInvocationCount).toBe(0);

      store.close();
    });

    it("15. Agent/request cannot expand capabilities", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process");

      const policy = createExecutionPolicy({
        policyId: "echo-only",
        allowedCapabilities: ["execution.echo"],
        isolationRequirement: "IN_PROCESS",
        trustedInProcessOperations: ["echo"],
      });

      // Task tries to self-declare or request unauthorized capability in payload
      const task = coordinator.createTask({
        title: "sum", // Requires execution.sum which contract denies
        inputPayload: {
          requestedCapabilities: ["execution.sum", "execution.admin"],
          overridePolicy: true,
        },
      });
      createAndActivateContract(store, task.taskId, { policy });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const worker = new WorkerRuntime({
        workerId: "w-cannot-expand",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("FAILED");
      if (result.status === "FAILED") {
        const err = result.error as { code: string };
        expect(err.code).toBe("POLICY_DENIED");
      }
      expect(provider.providerInvocationCount).toBe(0);

      store.close();
    });

    it("16. Agent/request cannot weaken isolation", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      // Provider is in-process, but contract demands ISOLATED
      const provider = new CountingExecutionProvider("in-process");

      const policy = createExecutionPolicy({
        policyId: "isolated-policy",
        allowedCapabilities: ["execution.echo"],
        isolationRequirement: "ISOLATED",
      });

      // Task attempts to downgrade isolation via payload
      const task = coordinator.createTask({
        title: "echo",
        inputPayload: { isolationRequirement: "IN_PROCESS" },
      });
      createAndActivateContract(store, task.taskId, { policy });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const worker = new WorkerRuntime({
        workerId: "w-cannot-weaken-isolation",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("FAILED");
      if (result.status === "FAILED") {
        const err = result.error as { code: string; details: { reasonCode: string } };
        expect(err.code).toBe("POLICY_DENIED");
        expect(err.details.reasonCode).toBe("ISOLATION_REQUIREMENT_NOT_MET");
      }
      expect(provider.providerInvocationCount).toBe(0);

      store.close();
    });
  });

  // =========================================================================
  // Isolation Requirement (Tests 17–19)
  // =========================================================================
  describe("Isolation Requirement Enforcement", () => {
    it("17. ISOLATED requirement + isolated provider → allowed", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const dockerProvider = new CountingExecutionProvider("docker", { isolatedResult: true });

      const policy = createExecutionPolicy({
        policyId: "isolated-docker-policy",
        allowedCapabilities: ["execution.echo"],
        isolationRequirement: "ISOLATED",
      });

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      createAndActivateContract(store, task.taskId, {
        policy,
        verificationSpecs: [createVerificationSpec({ specId: "vspec-docker", ruleKind: "EXACT_OUTPUT_MATCH", expectedValue: { isolatedResult: true } })],
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const worker = new WorkerRuntime({
        workerId: "w-isolated-ok",
        coordinator,
        clock,
        executionProvider: dockerProvider,
        isIsolationAvailable: true,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("COMPLETED");
      expect(dockerProvider.providerInvocationCount).toBe(1);

      store.close();
    });

    it("18. ISOLATED requirement + in-process provider → rejected", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const inProcessProvider = new CountingExecutionProvider("in-process");

      const policy = createExecutionPolicy({
        policyId: "isolated-policy-2",
        allowedCapabilities: ["execution.echo"],
        isolationRequirement: "ISOLATED",
      });

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      createAndActivateContract(store, task.taskId, {
        policy,
        verificationSpecs: [createVerificationSpec({ specId: "vspec-docker", ruleKind: "EXACT_OUTPUT_MATCH", expectedValue: { isolatedResult: true } })],
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const worker = new WorkerRuntime({
        workerId: "w-isolated-inproc-rejected",
        coordinator,
        clock,
        executionProvider: inProcessProvider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("FAILED");
      if (result.status === "FAILED") {
        const err = result.error as { code: string; details: { reasonCode: string } };
        expect(err.code).toBe("POLICY_DENIED");
        expect(err.details.reasonCode).toBe("ISOLATION_REQUIREMENT_NOT_MET");
      }
      expect(inProcessProvider.providerInvocationCount).toBe(0);

      store.close();
    });

    it("19. No fallback from isolated to in-process", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const dockerProvider = new CountingExecutionProvider("docker");

      const policy = createExecutionPolicy({
        policyId: "strict-isolated-no-fallback",
        allowedCapabilities: ["execution.echo"],
        isolationRequirement: "ISOLATED",
      });

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      createAndActivateContract(store, task.taskId, {
        policy,
        verificationSpecs: [createVerificationSpec({ specId: "vspec-docker", ruleKind: "EXACT_OUTPUT_MATCH", expectedValue: { isolatedResult: true } })],
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const worker = new WorkerRuntime({
        workerId: "w-no-fallback",
        coordinator,
        clock,
        executionProvider: dockerProvider,
        isIsolationAvailable: false, // Docker unavailable
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("FAILED");
      if (result.status === "FAILED") {
        const err = result.error as { code: string; details: { reasonCode: string } };
        expect(err.code).toBe("POLICY_DENIED");
        expect(err.details.reasonCode).toBe("ISOLATION_REQUIREMENT_NOT_MET");
      }
      expect(dockerProvider.providerInvocationCount).toBe(0);

      store.close();
    });
  });

  // =========================================================================
  // Verification (Tests 20–23)
  // =========================================================================
  describe("Verification Specifications Governance", () => {
    it("20. MissionContract verification specification is used", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process", 42);

      const vSpec = createVerificationSpec({
        specId: "vspec-exact-42",
        ruleKind: "EXACT_OUTPUT_MATCH",
        expectedValue: 42,
      });

      const task = coordinator.createTask({ title: "sum", inputPayload: [21, 21] });
      createAndActivateContract(store, task.taskId, {
        verificationSpecs: [vSpec],
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const worker = new WorkerRuntime({
        workerId: "w-vspec-used",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("COMPLETED");
      expect(provider.providerInvocationCount).toBe(1);

      const events = coordinator.getEventsForRun(run.runId);
      const vEvent = events.find((e) => e.eventType === "verification.completed");
      expect(vEvent).toBeDefined();
      expect((vEvent!.payload as { status: string }).status).toBe("VERIFIED");

      store.close();
    });

    it("21. Request cannot replace verification requirements", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      // Provider returns 999
      const provider = new CountingExecutionProvider("in-process", 999);

      // Contract requires 42
      const contractVSpec = createVerificationSpec({
        specId: "contract-vspec-42",
        ruleKind: "EXACT_OUTPUT_MATCH",
        expectedValue: 42,
      });

      // Task tries to self-declare expectedValue: 999
      const task = coordinator.createTask({
        title: "sum",
        inputPayload: {
          numbers: [1, 2],
          verificationSpec: { expectedValue: 999 },
        },
      });
      createAndActivateContract(store, task.taskId, {
        verificationSpecs: [contractVSpec],
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const worker = new WorkerRuntime({
        workerId: "w-req-cannot-replace-vspec",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("FAILED");
      if (result.status === "FAILED") {
        const err = result.error as { code: string; details: { specId: string } };
        expect(err.code).toBe("VERIFICATION_FAILED");
        expect(err.details.specId).toBe("contract-vspec-42");
      }
      expect(provider.providerInvocationCount).toBe(1);

      store.close();
    });

    it("22. Existing verification success behavior remains valid", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process", { status: "ready" });

      const vSpec = createVerificationSpec({
        specId: "vspec-ready-check",
        ruleKind: "EXACT_OUTPUT_MATCH",
        expectedValue: { status: "ready" },
      });

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      createAndActivateContract(store, task.taskId, {
        verificationSpecs: [vSpec],
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const worker = new WorkerRuntime({
        workerId: "w-verif-success",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("COMPLETED");

      const events = coordinator.getEventsForRun(run.runId);
      const eventTypes = events.map((e) => e.eventType);

      expect(eventTypes).toContain("evidence.recorded");
      expect(eventTypes).toContain("verification.completed");
      expect(eventTypes).toContain("run.completed");

      const vEvt = events.find((e) => e.eventType === "verification.completed");
      expect((vEvt!.payload as { status: string }).status).toBe("VERIFIED");

      store.close();
    });

    it("23. Existing verification failure behavior remains valid", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      // Provider returns unexpected output
      const provider = new CountingExecutionProvider("in-process", { status: "corrupted" });

      const vSpec = createVerificationSpec({
        specId: "vspec-integrity-check",
        ruleKind: "EXACT_OUTPUT_MATCH",
        expectedValue: { status: "ready" },
      });

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      createAndActivateContract(store, task.taskId, {
        verificationSpecs: [vSpec],
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const worker = new WorkerRuntime({
        workerId: "w-verif-fail",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("FAILED");
      if (result.status === "FAILED") {
        const err = result.error as { code: string };
        expect(err.code).toBe("VERIFICATION_FAILED");
      }

      const events = coordinator.getEventsForRun(run.runId);
      const eventTypes = events.map((e) => e.eventType);

      expect(eventTypes).toContain("evidence.recorded");
      expect(eventTypes).toContain("verification.completed");
      expect(eventTypes).toContain("run.failed");
      expect(eventTypes).not.toContain("run.completed");

      const vEvt = events.find((e) => e.eventType === "verification.completed");
      expect((vEvt!.payload as { status: string }).status).toBe("FAILED");

      store.close();
    });
  });

  // =========================================================================
  // Provider Boundary & Invariant Proofs (Tests 24–25)
  // =========================================================================
  describe("Provider Boundary Invariant Verification", () => {
    it("24. Every governance failure produces zero provider invocations", async () => {
      // Test matrix:
      // a) Ephemeral policy on governed run
      // b) Ephemeral verificationSpec on governed run
      // c) Contract hash mismatch
      // d) Revoked contract
      // e) Capability denied
      // f) Isolation mismatch
      const failureScenarios = [
        async function testEphemeralPolicy() {
          const clock = new SettableClock();
          const store = new SqliteStateStore();
          const coordinator = new RunCoordinator(store, clock);
          const provider = new CountingExecutionProvider();
          const task = coordinator.createTask({ title: "echo", inputPayload: null });
          createAndActivateContract(store, task.taskId);
          const { run } = coordinator.createRun({ taskId: task.taskId });
          coordinator.queueRun(run.runId);
          const worker = new WorkerRuntime({
            coordinator,
            clock,
            executionProvider: provider,
            policy: createDefaultInProcessPolicy(),
          });
          const res = await worker.runOnce();
          expect(res.status).toBe("FAILED");
          expect(provider.providerInvocationCount).toBe(0);
          store.close();
        },
        async function testEphemeralVerificationSpec() {
          const clock = new SettableClock();
          const store = new SqliteStateStore();
          const coordinator = new RunCoordinator(store, clock);
          const provider = new CountingExecutionProvider();
          const task = coordinator.createTask({ title: "echo", inputPayload: null });
          createAndActivateContract(store, task.taskId);
          const { run } = coordinator.createRun({ taskId: task.taskId });
          coordinator.queueRun(run.runId);
          const worker = new WorkerRuntime({
            coordinator,
            clock,
            executionProvider: provider,
            verificationSpec: createVerificationSpec({ specId: "v", ruleKind: "EXIT_CODE_ZERO" }),
          });
          const res = await worker.runOnce();
          expect(res.status).toBe("FAILED");
          expect(provider.providerInvocationCount).toBe(0);
          store.close();
        },
        async function testRevokedContract() {
          const clock = new SettableClock();
          const store = new SqliteStateStore();
          const coordinator = new RunCoordinator(store, clock);
          const provider = new CountingExecutionProvider();
          const task = coordinator.createTask({ title: "echo", inputPayload: null });
          const c = createAndActivateContract(store, task.taskId);
          const { run } = coordinator.createRun({ taskId: task.taskId });
          coordinator.queueRun(run.runId);
          store.revokeContract(c.spec.contractId, c.spec.version);
          const worker = new WorkerRuntime({ coordinator, clock, executionProvider: provider });
          const res = await worker.runOnce();
          expect(res.status).toBe("FAILED");
          expect(provider.providerInvocationCount).toBe(0);
          store.close();
        },
        async function testDeniedCapability() {
          const clock = new SettableClock();
          const store = new SqliteStateStore();
          const coordinator = new RunCoordinator(store, clock);
          const provider = new CountingExecutionProvider();
          const task = coordinator.createTask({ title: "echo", inputPayload: null });
          const policy = createExecutionPolicy({
            allowedCapabilities: ["execution.sum"],
            isolationRequirement: "IN_PROCESS",
            trustedInProcessOperations: ["sum"],
          });
          createAndActivateContract(store, task.taskId, { policy });
          const { run } = coordinator.createRun({ taskId: task.taskId });
          coordinator.queueRun(run.runId);
          const worker = new WorkerRuntime({ coordinator, clock, executionProvider: provider });
          const res = await worker.runOnce();
          expect(res.status).toBe("FAILED");
          expect(provider.providerInvocationCount).toBe(0);
          store.close();
        },
      ];

      for (const scenario of failureScenarios) {
        await scenario();
      }
    });

    it("25. Successful governance gate invokes provider exactly once for the normal execution path", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process", { normal: "path" });

      const task = coordinator.createTask({ title: "echo", inputPayload: { normal: true } });
      createAndActivateContract(store, task.taskId, {
        verificationSpecs: [createVerificationSpec({ specId: "vspec-normal", ruleKind: "EXACT_OUTPUT_MATCH", expectedValue: { normal: "path" } })],
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const worker = new WorkerRuntime({
        workerId: "w-normal-path",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("COMPLETED");
      expect(provider.providerInvocationCount).toBe(1);

      store.close();
    });
  });
});
