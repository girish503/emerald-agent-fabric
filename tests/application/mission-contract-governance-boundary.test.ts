import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const { DatabaseSync: NodeDatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSync };
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import {
  migrateDatabase,
  MigrationConflictError,
} from "../../src/adapters/persistence/schema.js";
import { RunCoordinator, WorkerRuntime } from "../../src/application/index.js";
import { computeCanonicalHash } from "../../src/domain/canonical-hash.js";
import {
  createMissionContract,
  createResourceLimits,
} from "../../src/domain/mission-contract.js";
import {
  createDefaultInProcessPolicy,
  createExecutionPolicy,
} from "../../src/domain/policy.js";
import { createVerificationSpec } from "../../src/domain/verification.js";
import {
  InvalidRunError,
  ResourceLimitExceededError,
} from "../../src/domain/errors.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "../../src/ports/execution-provider.port.js";
import { createAndActivateContract } from "./test-helpers.js";

/**
 * CountingExecutionProvider spies on execution requests to prove
 * the zero-provider-invocation invariant on pre-dispatch governance failures.
 */
class CountingExecutionProvider implements ExecutionProvider {
  readonly name: string;
  readonly invocations: ExecutionRequest[] = [];
  private readonly mockOutput: unknown;

  constructor(name: string = "in-process", mockOutput: unknown = { ok: true, result: 100 }) {
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
      durationMs: 10,
      providerMetadata: { provider: this.name, exitCode: 0 },
    };
  }
}

function registerWorker(
  coordinator: RunCoordinator,
  workerId: string,
  clock: SettableClock
): void {
  coordinator.registerWorker({
    workerId,
    hostname: "localhost",
    pid: process.pid,
    status: "ACTIVE",
    lastHeartbeatAt: clock.nowIso(),
    createdAt: clock.nowIso(),
  });
}

describe("MissionContract Governance Boundary — Final Invariant Verification (Task 1.8C-6)", () => {
  // =========================================================================
  // 1. Final MissionContract Governance Invariant (Section 1)
  // =========================================================================
  describe("1. Final MissionContract Governance Invariant", () => {
    it("Executable Run strictly satisfies all 8 governance gates", async () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process", { computed: 42 });

      registerWorker(coordinator, "w-gov-1", clock);

      const task = coordinator.createTask({ title: "echo", inputPayload: { x: 5, y: 7 } });
      createAndActivateContract(store, task.taskId, {
        policy: createDefaultInProcessPolicy("policy-echo"),
        verificationSpecs: [
          createVerificationSpec({
            specId: "v-spec-1",
            ruleKind: "EXACT_OUTPUT_MATCH",
            expectedValue: { computed: 42 },
          }),
        ],
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      // Gate 1: contractBinding != null
      expect(run.contractBinding).not.toBeNull();
      // Gate 2: exact contract exists
      const resolvedContract = coordinator.getContract(
        run.contractBinding!.contractId,
        run.contractBinding!.version
      );
      expect(resolvedContract).not.toBeNull();
      // Gate 3: contract hash is valid SHA-256
      expect(resolvedContract!.contentHash).toMatch(/^[0-9a-f]{64}$/);
      // Gate 4: contract hash == Run binding hash
      expect(resolvedContract!.contentHash).toBe(run.contractBinding!.contentHash);
      // Gate 5: contract.taskId == Run.taskId
      expect(resolvedContract!.spec.taskId).toBe(run.taskId);
      // Gate 6: contract.status == ACTIVE
      expect(resolvedContract!.lifecycle.status).toBe("ACTIVE");
      // Gate 7: policy authorizes requested capability (echo allowed)
      expect(resolvedContract!.spec.policy.allowedCapabilities).toContain("execution.echo");
      // Gate 8: required isolation is satisfied (IN_PROCESS matches provider)
      expect(resolvedContract!.spec.policy.isolationRequirement).toBe("IN_PROCESS");

      const worker = new WorkerRuntime({
        workerId: "w-gov-1",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("COMPLETED");
      expect(provider.providerInvocationCount).toBe(1);

      const completed = coordinator.getRun(run.runId);
      expect(completed!.status).toBe("COMPLETED");
      expect(completed!.contractBinding).toEqual(run.contractBinding);

      store.close();
    });
  });

  // =========================================================================
  // 2. Authority Non-Substitution Invariant (Section 2)
  // =========================================================================
  describe("2. Authority Non-Substitution Invariant", () => {
    it("Case A: Run -> Contract v1; v2 present -> continues using v1, never switches to v2", async () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process");

      registerWorker(coordinator, "w-nonsub-a", clock);

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      const contractV1 = createAndActivateContract(store, task.taskId, { version: 1 });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      // Create v2 DRAFT (cannot have two ACTIVE contracts in DB)
      const contractV2 = createMissionContract({
        contractId: contractV1.spec.contractId,
        version: 2,
        taskId: task.taskId,
        policy: createDefaultInProcessPolicy("policy-v2"),
        resourceLimits: createResourceLimits({ timeoutMs: 40000, maxAttempts: 4, maxOutputBytes: 2048 }),
        credentialScopes: ["scope:v2"],
      });
      store.insertContract(contractV2);

      const worker = new WorkerRuntime({
        workerId: "w-nonsub-a",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("COMPLETED");
      expect(provider.providerInvocationCount).toBe(1);

      // Invariant: Run retained exact v1 binding
      const completed = coordinator.getRun(run.runId);
      expect(completed!.contractBinding!.version).toBe(1);
      expect(completed!.contractBinding!.contentHash).toBe(contractV1.contentHash);

      store.close();
    });

    it("Case B: Run -> Contract v1; v1 REVOKED, v2 ACTIVE -> fails closed, v2 is NOT substituted", async () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process");

      registerWorker(coordinator, "w-nonsub-b", clock);

      const task = coordinator.createTask({ title: "revoked-v1", inputPayload: null });
      const contractV1 = createAndActivateContract(store, task.taskId, { version: 1 });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      // Revoke v1 and activate v2
      store.revokeContract(contractV1.spec.contractId, 1, "Superseded by v2");
      const contractV2 = createAndActivateContract(store, task.taskId, { version: 2 });
      expect(contractV2.lifecycle.status).toBe("ACTIVE");

      const worker = new WorkerRuntime({
        workerId: "w-nonsub-b",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("FAILED");
      expect(provider.providerInvocationCount).toBe(0);

      const failedRun = coordinator.getRun(run.runId);
      expect(failedRun!.status).toBe("FAILED");
      const err = failedRun!.errorPayload as { code: string; details?: { version?: number } };
      expect(err.code).toBe("CONTRACT_REVOKED");
      expect(failedRun!.contractBinding!.version).toBe(1); // Never substituted v2

      store.close();
    });

    it("Case C: Run -> Contract v1; v1 missing, v2 ACTIVE -> fails closed, v2 is NOT substituted", async () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process");

      registerWorker(coordinator, "w-nonsub-c", clock);

      const task = coordinator.createTask({ title: "missing-v1", inputPayload: null });
      const contractV1 = createAndActivateContract(store, task.taskId, { version: 1 });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      // Delete v1 while foreign keys are off to simulate missing v1
      (store as any).db.exec("PRAGMA foreign_keys = OFF;");
      (store as any).db.prepare("DELETE FROM mission_contracts WHERE contract_id = ? AND version = 1")
        .run(contractV1.spec.contractId);
      (store as any).db.exec("PRAGMA foreign_keys = ON;");

      // Activate v2
      const contractV2 = createAndActivateContract(store, task.taskId, { version: 2 });
      expect(contractV2.lifecycle.status).toBe("ACTIVE");

      const worker = new WorkerRuntime({
        workerId: "w-nonsub-c",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("FAILED");
      expect(provider.providerInvocationCount).toBe(0);

      // Verify v2 was never substituted
      if (result.status === "FAILED") {
        expect((result.error as { code: string }).code).toBe("MISSING_BOUND_CONTRACT");
      }

      store.close();
    });

    it("Case D: Run -> Contract v1; v1 hash mismatch, v2 ACTIVE -> fails closed, v2 is NOT substituted", async () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process");

      registerWorker(coordinator, "w-nonsub-d", clock);

      const task = coordinator.createTask({ title: "hash-mismatch-v1", inputPayload: null });
      const contractV1 = createAndActivateContract(store, task.taskId, { version: 1 });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      // Tamper v1's content_hash in DB
      const tamperedHash = "b".repeat(64);
      (store as any).db.prepare("UPDATE mission_contracts SET content_hash = ? WHERE contract_id = ? AND version = 1")
        .run(tamperedHash, contractV1.spec.contractId);

      const worker = new WorkerRuntime({
        workerId: "w-nonsub-d",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("FAILED");
      expect(provider.providerInvocationCount).toBe(0);
      if (result.status === "FAILED") {
        expect((result.error as { code: string }).code).toBe("CONTRACT_INTEGRITY_MISMATCH");
      }

      store.close();
    });
  });

  // =========================================================================
  // 3. Authority Expansion Invariant (Section 3)
  // =========================================================================
  describe("3. Authority Expansion Invariant", () => {
    it("Rejects ephemeral options attempting to override contract policy or verification", async () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process");

      registerWorker(coordinator, "w-expand", clock);

      const task = coordinator.createTask({ title: "no-expand", inputPayload: null });
      createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      // Caller attempts to pass broader ephemeral policy granting '*' operations
      const worker = new WorkerRuntime({
        workerId: "w-expand",
        coordinator,
        clock,
        executionProvider: provider,
        policy: createExecutionPolicy({
          policyId: "unauthorized-override",
          allowedCapabilities: ["*"],
          isolationRequirement: "IN_PROCESS",
        }),
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("FAILED");
      expect(provider.providerInvocationCount).toBe(0);
      if (result.status === "FAILED") {
        expect((result.error as { code: string }).code).toBe("EPHEMERAL_OVERRIDE_REJECTED");
      }

      const failedRun = coordinator.getRun(run.runId);
      expect(failedRun!.status).toBe("FAILED");

      store.close();
    });
  });

  // =========================================================================
  // 4. Contract Ceiling Invariant (Section 4)
  // =========================================================================
  describe("4. Contract Ceiling Invariant", () => {
    it("Allows equal and narrower values; rejects broader, zero, negative, and non-integer values", () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);

      const task = coordinator.createTask({ title: "ceilings", inputPayload: null });
      createAndActivateContract(store, task.taskId, {
        timeoutMs: 30000,
        maxAttempts: 3,
        maxOutputBytes: 1048576,
      });

      // 1. Equal values succeed
      const { run: runEqual } = coordinator.createRun({
        taskId: task.taskId,
        timeoutMs: 30000,
        maxAttempts: 3,
        maxOutputBytes: 1048576,
      });
      expect(runEqual.timeoutMs).toBe(30000);
      expect(runEqual.maxAttempts).toBe(3);
      expect(runEqual.maxOutputBytes).toBe(1048576);

      // 2. Narrower values succeed
      const { run: runNarrow } = coordinator.createRun({
        taskId: task.taskId,
        timeoutMs: 10000,
        maxAttempts: 1,
        maxOutputBytes: 524288,
      });
      expect(runNarrow.timeoutMs).toBe(10000);
      expect(runNarrow.maxAttempts).toBe(1);
      expect(runNarrow.maxOutputBytes).toBe(524288);

      // 3. Exceeding values fail closed (ResourceLimitExceededError)
      expect(() =>
        coordinator.createRun({ taskId: task.taskId, timeoutMs: 30001 })
      ).toThrow(ResourceLimitExceededError);

      expect(() =>
        coordinator.createRun({ taskId: task.taskId, maxAttempts: 4 })
      ).toThrow(ResourceLimitExceededError);

      expect(() =>
        coordinator.createRun({ taskId: task.taskId, maxOutputBytes: 1048577 })
      ).toThrow(ResourceLimitExceededError);

      // 4. Zero values fail closed (InvalidRunError)
      expect(() => coordinator.createRun({ taskId: task.taskId, timeoutMs: 0 })).toThrow(
        InvalidRunError
      );
      expect(() => coordinator.createRun({ taskId: task.taskId, maxAttempts: 0 })).toThrow(
        InvalidRunError
      );
      expect(() => coordinator.createRun({ taskId: task.taskId, maxOutputBytes: 0 })).toThrow(
        InvalidRunError
      );

      // 5. Negative values fail closed (InvalidRunError)
      expect(() => coordinator.createRun({ taskId: task.taskId, timeoutMs: -500 })).toThrow(
        InvalidRunError
      );
      expect(() => coordinator.createRun({ taskId: task.taskId, maxAttempts: -1 })).toThrow(
        InvalidRunError
      );
      expect(() => coordinator.createRun({ taskId: task.taskId, maxOutputBytes: -100 })).toThrow(
        InvalidRunError
      );

      // 6. Non-integer values fail closed (InvalidRunError)
      expect(() => coordinator.createRun({ taskId: task.taskId, timeoutMs: 12.34 })).toThrow(
        InvalidRunError
      );
      expect(() => coordinator.createRun({ taskId: task.taskId, maxAttempts: 2.5 })).toThrow(
        InvalidRunError
      );
      expect(() => coordinator.createRun({ taskId: task.taskId, maxOutputBytes: 1000.5 })).toThrow(
        InvalidRunError
      );

      store.close();
    });
  });

  // =========================================================================
  // 5. Provider Safety Invariant (Section 5)
  // =========================================================================
  describe("5. Provider Safety Invariant (Zero Invocations Across All Governance Failures)", () => {
    it.each([
      {
        scenario: "missing contract",
        setup: (store: SqliteStateStore, task: { taskId: string }, _run: { runId: string }) => {
          (store as any).db.exec("PRAGMA foreign_keys = OFF;");
          (store as any).db.prepare("DELETE FROM mission_contracts WHERE task_id = ?").run(task.taskId);
          (store as any).db.exec("PRAGMA foreign_keys = ON;");
        },
        expectedCode: "MISSING_BOUND_CONTRACT",
      },
      {
        scenario: "revoked contract",
        setup: (store: SqliteStateStore, task: { taskId: string }, _run: { runId: string }) => {
          const row = (store as any).db
            .prepare("SELECT contract_id, version FROM mission_contracts WHERE task_id = ?")
            .get(task.taskId) as { contract_id: string; version: number };
          store.revokeContract(row.contract_id, row.version, "Emergency revocation");
        },
        expectedCode: "CONTRACT_REVOKED",
      },
      {
        scenario: "DRAFT contract",
        setup: (store: SqliteStateStore, task: { taskId: string }, _run: { runId: string }) => {
          (store as any).db
            .prepare("UPDATE mission_contracts SET status = 'DRAFT', activated_at = NULL WHERE task_id = ?")
            .run(task.taskId);
        },
        expectedCode: "CONTRACT_NOT_ACTIVE",
      },
      {
        scenario: "hash mismatch",
        setup: (store: SqliteStateStore, _task: { taskId: string }, run: { runId: string }) => {
          (store as any).db
            .prepare("UPDATE runs SET contract_hash = ? WHERE run_id = ?")
            .run("c".repeat(64), run.runId);
        },
        expectedCode: "CONTRACT_INTEGRITY_MISMATCH",
      },
      {
        scenario: "task mismatch",
        setup: (store: SqliteStateStore, _task: { taskId: string }, run: { runId: string }) => {
          const otherTaskId = "task-other-owner";
          (store as any).db
            .prepare(
              "INSERT INTO tasks (task_id, title, input_payload, created_at, updated_at) VALUES (?, 'other', '{}', '2026-03-30T10:00:00.000Z', '2026-03-30T10:00:00.000Z')"
            )
            .run(otherTaskId);
          const otherContract = createAndActivateContract(store, otherTaskId);
          (store as any).db
            .prepare("UPDATE runs SET contract_id = ?, contract_version = ?, contract_hash = ? WHERE run_id = ?")
            .run(
              otherContract.spec.contractId,
              otherContract.spec.version,
              otherContract.contentHash,
              run.runId
            );
        },
        expectedCode: "MISSION_CONTRACT_TASK_MISMATCH",
      },
      {
        scenario: "capability denied",
        setup: (store: SqliteStateStore, task: { taskId: string }, _run: { runId: string }) => {
          // Contract policy only allows 'allowed-only-op'
          const row = (store as any).db
            .prepare("SELECT contract_id, canonical_spec FROM mission_contracts WHERE task_id = ?")
            .get(task.taskId) as { contract_id: string; canonical_spec: string };
          const spec = JSON.parse(row.canonical_spec);
          spec.policy = createExecutionPolicy({
            policyId: "restrictive-policy",
            allowedCapabilities: ["allowed-only-op"],
            isolationRequirement: "IN_PROCESS",
          });
          const { contentHash } = computeCanonicalHash(spec);
          (store as any).db
            .prepare("UPDATE mission_contracts SET canonical_spec = ?, content_hash = ? WHERE contract_id = ?")
            .run(JSON.stringify(spec), contentHash, row.contract_id);
          (store as any).db
            .prepare("UPDATE runs SET contract_hash = ? WHERE contract_id = ?")
            .run(contentHash, row.contract_id);
        },
        expectedCode: "POLICY_DENIED",
      },
    ])("Guarantees providerInvocationCount === 0 for $scenario", async ({ setup, expectedCode }) => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process");

      registerWorker(coordinator, "w-safety", clock);

      // Task requires operation "echo"
      const task = coordinator.createTask({ title: "echo", inputPayload: { message: "hi" } });
      createAndActivateContract(store, task.taskId, {
        policy: createDefaultInProcessPolicy("policy-echo"),
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      // Apply specific failure condition
      setup(store, task, run);

      const worker = new WorkerRuntime({
        workerId: "w-safety",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("FAILED");

      // Critical Invariant: Provider was never invoked
      expect(provider.providerInvocationCount).toBe(0);

      if (result.status === "FAILED") {
        const err = result.error as { code: string };
        expect(err.code).toBe(expectedCode);
      }

      store.close();
    });
  });

  // =========================================================================
  // 6. Recovery Safety Invariant (Section 6)
  // =========================================================================
  describe("6. Recovery Safety Invariant (Recovery Cannot Create Authority)", () => {
    it("Expired lease + revoked v1 + active v2 -> sweeper fails closed; never retries or invokes provider", async () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process");

      registerWorker(coordinator, "w-rec-safety", clock);

      const task = coordinator.createTask({ title: "rec-op", inputPayload: null });
      const contractV1 = createAndActivateContract(store, task.taskId, { version: 1 });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const claim = coordinator.claimRun(run.runId, "w-rec-safety", 5000);
      coordinator.startRun(run.runId, "w-rec-safety", claim.lease.leaseId);

      // Advance time beyond lease expiry
      clock.advanceMs(6000);

      // Revoke v1 and activate v2
      store.revokeContract(contractV1.spec.contractId, 1, "Revoked prior to recovery");
      const contractV2 = createAndActivateContract(store, task.taskId, { version: 2 });
      expect(contractV2.lifecycle.status).toBe("ACTIVE");

      // Sweeper runs
      const recovery = coordinator.recoverExpiredRuns();
      expect(recovery.recoveredCount).toBe(1);

      const failedRun = coordinator.getRun(run.runId);
      expect(failedRun!.status).toBe("FAILED");
      const err = failedRun!.errorPayload as { code: string };
      expect(err.code).toBe("CONTRACT_REVOKED");
      expect(failedRun!.attemptCount).toBe(0); // Did not consume retry attempts
      expect(failedRun!.contractBinding!.version).toBe(1); // Did not switch to v2

      // Worker tries to claim -> nothing queued
      const worker = new WorkerRuntime({
        workerId: "w-rec-safety",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const workerResult = await worker.runOnce();
      expect(workerResult.status).toBe("IDLE");
      expect(provider.providerInvocationCount).toBe(0);

      store.close();
    });

    it("Expired lease + tampered v1 + active v2 -> sweeper fails closed with CONTRACT_INTEGRITY_MISMATCH", () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);

      registerWorker(coordinator, "w-rec-tamper", clock);

      const task = coordinator.createTask({ title: "rec-tamper", inputPayload: null });
      const contractV1 = createAndActivateContract(store, task.taskId, { version: 1 });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const claim = coordinator.claimRun(run.runId, "w-rec-tamper", 5000);
      coordinator.startRun(run.runId, "w-rec-tamper", claim.lease.leaseId);

      clock.advanceMs(6000);

      // Tamper v1 canonical_spec JSON in DB
      (store as any).db.prepare("UPDATE mission_contracts SET canonical_spec = '{\"tampered\": true}' WHERE contract_id = ? AND version = 1")
        .run(contractV1.spec.contractId);

      coordinator.recoverExpiredRuns();

      const failedRun = coordinator.getRunRaw(run.runId);
      expect(failedRun!.status).toBe("FAILED");
      expect((failedRun!.errorPayload as { code: string }).code).toBe("CONTRACT_INTEGRITY_MISMATCH");
      expect(failedRun!.contractBinding!.version).toBe(1);

      store.close();
    });
  });

  // =========================================================================
  // 7. Legacy Run Invariant (Section 7)
  // =========================================================================
  describe("7. Legacy Run Invariant", () => {
    it("Terminal legacy Runs remain readable with null binding and no synthetic contracts", () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);

      const task = coordinator.createTask({ title: "legacy-terminal", inputPayload: null });

      // Insert legacy completed run directly into DB
      const legacyRunId = "legacy-run-completed";
      (store as any).db.prepare(`
        INSERT INTO runs (
          run_id, task_id, status, idempotency_key, current_worker_id,
          lease_id, lease_expires_at, attempt_count, max_attempts,
          timeout_ms, result_payload, error_payload, version,
          created_at, updated_at,
          contract_id, contract_version, contract_hash, max_output_bytes
        ) VALUES (?, ?, 'COMPLETED', NULL, NULL, NULL, NULL, 1, 3, 30000, '{"ok":true}', NULL, 1, ?, ?, NULL, NULL, NULL, NULL)
      `).run(legacyRunId, task.taskId, clock.nowIso(), clock.nowIso());

      // Also create an ACTIVE contract for this task
      createAndActivateContract(store, task.taskId);

      // Read back legacy run
      const loaded = coordinator.getRun(legacyRunId);
      expect(loaded).not.toBeNull();
      expect(loaded!.status).toBe("COMPLETED");
      expect(loaded!.contractBinding).toBeNull();
      expect(loaded!.maxOutputBytes).toBeNull();

      store.close();
    });

    it("Nonterminal legacy Run fails closed and never binds to currently ACTIVE contract", async () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process");

      registerWorker(coordinator, "w-legacy-reject", clock);

      const task = coordinator.createTask({ title: "legacy-queued", inputPayload: null });

      // An active contract exists for the task
      createAndActivateContract(store, task.taskId);

      // Insert legacy QUEUED run with null contract columns
      const legacyRunId = "legacy-run-queued";
      (store as any).db.prepare(`
        INSERT INTO runs (
          run_id, task_id, status, idempotency_key, current_worker_id,
          lease_id, lease_expires_at, attempt_count, max_attempts,
          timeout_ms, result_payload, error_payload, version,
          created_at, updated_at,
          contract_id, contract_version, contract_hash, max_output_bytes
        ) VALUES (?, ?, 'QUEUED', NULL, NULL, NULL, NULL, 0, 3, 30000, NULL, NULL, 1, ?, ?, NULL, NULL, NULL, NULL)
      `).run(legacyRunId, task.taskId, clock.nowIso(), clock.nowIso());

      const worker = new WorkerRuntime({
        workerId: "w-legacy-reject",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce(legacyRunId);
      expect(result.status).toBe("FAILED");
      expect(provider.providerInvocationCount).toBe(0);
      if (result.status === "FAILED") {
        expect((result.error as { code: string }).code).toBe("UNBOUND_RUN_EXECUTION_DISALLOWED");
      }

      const failedRun = coordinator.getRun(legacyRunId);
      expect(failedRun!.status).toBe("FAILED");
      expect(failedRun!.contractBinding).toBeNull(); // Never bound to activeContract

      store.close();
    });
  });

  // =========================================================================
  // 8. Migration Invariant (Section 8)
  // =========================================================================
  describe("8. Migration Invariant", () => {
    it("Clean migration, idempotency, duplicate ACTIVE conflict rejection, and historical preservation", () => {
      const db = new NodeDatabaseSync(":memory:");
      db.exec("PRAGMA foreign_keys = ON;");

      // 1. Setup pre-1.8C legacy schema
      db.exec(`
        CREATE TABLE tasks (
          task_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          input_payload TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE runs (
          run_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(task_id),
          status TEXT NOT NULL,
          idempotency_key TEXT UNIQUE,
          current_worker_id TEXT,
          lease_id TEXT,
          lease_expires_at TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          timeout_ms INTEGER NOT NULL DEFAULT 30000,
          result_payload TEXT,
          error_payload TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE mission_contracts (
          contract_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          task_id TEXT NOT NULL REFERENCES tasks(task_id),
          status TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          canonical_spec TEXT NOT NULL,
          created_at TEXT NOT NULL,
          activated_at TEXT,
          revoked_at TEXT,
          revocation_reason TEXT,
          PRIMARY KEY(contract_id, version)
        );
      `);

      db.exec(`INSERT INTO tasks VALUES ('t-1', 'title', NULL, '2026-03-30T10:00:00.000Z', '2026-03-30T10:00:00.000Z');`);
      db.exec(`INSERT INTO runs VALUES ('r-legacy-1', 't-1', 'COMPLETED', NULL, NULL, NULL, NULL, 1, 3, 30000, '{"ok":true}', NULL, 1, '2026-03-30T10:00:00.000Z', '2026-03-30T10:00:00.000Z');`);

      // Migration 1: Clean migration
      expect(() => migrateDatabase(db)).not.toThrow();

      // Check governance columns exist
      const tableInfo = db.prepare("PRAGMA table_info(runs)").all() as unknown as { name: string }[];
      const colNames = tableInfo.map((c) => c.name);
      expect(colNames).toContain("contract_id");
      expect(colNames).toContain("contract_version");
      expect(colNames).toContain("contract_hash");
      expect(colNames).toContain("max_output_bytes");

      // Historical preservation: legacy run columns remain null
      const legacyRow = db.prepare("SELECT contract_id, contract_version, max_output_bytes FROM runs WHERE run_id = 'r-legacy-1'").get() as any;
      expect(legacyRow.contract_id).toBeNull();
      expect(legacyRow.contract_version).toBeNull();
      expect(legacyRow.max_output_bytes).toBeNull();

      // Migration 2: Idempotency (running repeatedly produces same valid state)
      expect(() => migrateDatabase(db)).not.toThrow();
      expect(() => migrateDatabase(db)).not.toThrow();

      // Migration 3: Duplicate ACTIVE contracts fail closed
      const conflictDb = new NodeDatabaseSync(":memory:");
      conflictDb.exec(`
        CREATE TABLE tasks (task_id TEXT PRIMARY KEY);
        CREATE TABLE mission_contracts (
          contract_id TEXT, version INTEGER, task_id TEXT, status TEXT,
          content_hash TEXT, canonical_spec TEXT, created_at TEXT,
          PRIMARY KEY(contract_id, version)
        );
        INSERT INTO tasks VALUES ('t-conflict');
        INSERT INTO mission_contracts VALUES ('c-1', 1, 't-conflict', 'ACTIVE', 'hash1', '{}', '2026-03-30T10:00:00.000Z');
        INSERT INTO mission_contracts VALUES ('c-2', 2, 't-conflict', 'ACTIVE', 'hash2', '{}', '2026-03-30T10:00:00.000Z');
      `);

      expect(() => migrateDatabase(conflictDb)).toThrow(MigrationConflictError);

      conflictDb.close();
      db.close();
    });
  });

  // =========================================================================
  // 9. Single-ACTIVE Invariant (Section 9)
  // =========================================================================
  describe("9. Single-ACTIVE Invariant (COUNT(status = ACTIVE) <= 1 per task)", () => {
    it("Enforces at most one ACTIVE contract per task across lifecycle transitions", () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const task = coordinator.createTask({ title: "single-active", inputPayload: null });
      const taskId = task.taskId;

      // 1. Create DRAFT v1
      const c1 = createMissionContract({
        contractId: "contract-sa",
        version: 1,
        taskId,
        policy: createDefaultInProcessPolicy("p1"),
        resourceLimits: createResourceLimits({ timeoutMs: 30000, maxAttempts: 3, maxOutputBytes: 1048576 }),
      });
      store.insertContract(c1);

      // 2. Create DRAFT v2
      const c2 = createMissionContract({
        contractId: "contract-sa",
        version: 2,
        taskId,
        policy: createDefaultInProcessPolicy("p2"),
        resourceLimits: createResourceLimits({ timeoutMs: 30000, maxAttempts: 3, maxOutputBytes: 1048576 }),
      });
      store.insertContract(c2);

      // Multiple DRAFT contracts allowed
      const drafts = store.findContractsByTaskId(taskId, "DRAFT");
      expect(drafts.length).toBe(2);

      // 3. Activate v1
      store.activateContract("contract-sa", 1);
      expect(store.findContractsByTaskId(taskId, "ACTIVE").length).toBe(1);

      // 4. Attempt to activate v2 without revoking v1 -> fails
      expect(() => store.activateContract("contract-sa", 2)).toThrow();

      // 5. Confirm v1 remains ACTIVE
      const activeContracts = store.findContractsByTaskId(taskId, "ACTIVE");
      expect(activeContracts.length).toBe(1);
      expect(activeContracts[0]!.spec.version).toBe(1);

      // 6. Explicitly revoke v1
      store.revokeContract("contract-sa", 1, "Rotating to v2");
      expect(store.findContractsByTaskId(taskId, "ACTIVE").length).toBe(0);

      // 7. Activate v2
      store.activateContract("contract-sa", 2);

      // 8. Confirm v2 is now the only ACTIVE contract
      const activeAfterRotation = store.findContractsByTaskId(taskId, "ACTIVE");
      expect(activeAfterRotation.length).toBe(1);
      expect(activeAfterRotation[0]!.spec.version).toBe(2);

      // Multiple REVOKED contracts also allowed
      store.revokeContract("contract-sa", 2, "End of lifecycle");
      const revoked = store.findContractsByTaskId(taskId, "REVOKED");
      expect(revoked.length).toBe(2);

      store.close();
    });
  });

  // =========================================================================
  // 10. Hash Integrity Invariant (Section 10)
  // =========================================================================
  describe("10. Hash Integrity Invariant", () => {
    it("Verifies 3-way hash agreement; fails closed if spec, contentHash, or Run binding is tampered", async () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process");

      registerWorker(coordinator, "w-hash", clock);

      const task = coordinator.createTask({ title: "hash-test", inputPayload: null });
      const contract = createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      // 3-way agreement holds
      const { contentHash: canonicalHash } = computeCanonicalHash(contract.spec);
      expect(canonicalHash).toBe(contract.contentHash);
      expect(contract.contentHash).toBe(run.contractBinding!.contentHash);

      // Tamper Run contract_hash
      (store as any).db.prepare("UPDATE runs SET contract_hash = ? WHERE run_id = ?")
        .run("9".repeat(64), run.runId);

      const worker = new WorkerRuntime({
        workerId: "w-hash",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("FAILED");
      expect(provider.providerInvocationCount).toBe(0);
      if (result.status === "FAILED") {
        expect((result.error as { code: string }).code).toBe("CONTRACT_INTEGRITY_MISMATCH");
      }

      store.close();
    });
  });

  // =========================================================================
  // 11. Lifecycle Invariant (Section 11)
  // =========================================================================
  describe("11. Lifecycle Invariant (DRAFT -> ACTIVE -> REVOKED only)", () => {
    it("Enforces legal lifecycle progression and execution authority gates", async () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process");

      registerWorker(coordinator, "w-lifecycle", clock);

      const task = coordinator.createTask({ title: "lifecycle-op", inputPayload: null });
      const contract = createMissionContract({
        contractId: "contract-lc",
        version: 1,
        taskId: task.taskId,
        policy: createDefaultInProcessPolicy("p-lc"),
        resourceLimits: createResourceLimits({ timeoutMs: 30000, maxAttempts: 3, maxOutputBytes: 1048576 }),
      });
      store.insertContract(contract);

      // DRAFT cannot authorize Run creation
      expect(() => coordinator.createRun({ taskId: task.taskId })).toThrow();

      // Activate contract
      store.activateContract("contract-lc", 1);

      // ACTIVE can authorize Run creation and execution
      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      // Revoke contract
      store.revokeContract("contract-lc", 1, "Testing revocation gate");

      // REVOKED cannot authorize execution
      const worker = new WorkerRuntime({
        workerId: "w-lifecycle",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("FAILED");
      expect(provider.providerInvocationCount).toBe(0);
      if (result.status === "FAILED") {
        expect((result.error as { code: string }).code).toBe("CONTRACT_REVOKED");
      }

      // REVOKED cannot be reactivated
      expect(() => store.activateContract("contract-lc", 1)).toThrow();

      store.close();
    });
  });

  // =========================================================================
  // 12. Event Auditability (Section 12)
  // =========================================================================
  describe("12. Event Auditability", () => {
    it("Verifies complete governance identity and decision audit trail in event stream", async () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process", { verified: true });

      registerWorker(coordinator, "w-audit", clock);

      const task = coordinator.createTask({ title: "echo", inputPayload: null });
      const contract = createAndActivateContract(store, task.taskId, {
        policy: createDefaultInProcessPolicy("p-audit"),
        verificationSpecs: [
          createVerificationSpec({
            specId: "v-audit-1",
            ruleKind: "EXACT_OUTPUT_MATCH",
            expectedValue: { verified: true },
          }),
        ],
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const worker = new WorkerRuntime({
        workerId: "w-audit",
        coordinator,
        clock,
        executionProvider: provider,
      });

      await worker.runOnce();

      const events = coordinator.getEventsForRun(run.runId);
      const eventTypes = events.map((e) => e.eventType);

      // 1. run.created contains complete governance binding and operational limits
      const createdEvent = events.find((e) => e.eventType === "run.created");
      expect(createdEvent).toBeDefined();
      const createdPayload = createdEvent!.payload as any;
      expect(createdPayload.contractBinding.contractId).toBe(contract.spec.contractId);
      expect(createdPayload.contractBinding.version).toBe(contract.spec.version);
      expect(createdPayload.contractBinding.contentHash).toBe(contract.contentHash);
      expect(createdPayload.maxAttempts).toBe(contract.spec.resourceLimits.maxAttempts);
      expect(createdPayload.timeoutMs).toBe(contract.spec.resourceLimits.timeoutMs);
      expect(createdPayload.maxOutputBytes).toBe(contract.spec.resourceLimits.maxOutputBytes);

      // 2. policy.evaluated records authorization decision
      expect(eventTypes).toContain("policy.evaluated");
      const policyEvent = events.find((e) => e.eventType === "policy.evaluated");
      expect((policyEvent!.payload as any).allowed).toBe(true);

      // 3. verification.completed records verification result
      expect(eventTypes).toContain("verification.completed");
      const verEvent = events.find((e) => e.eventType === "verification.completed");
      expect((verEvent!.payload as any).status).toBe("VERIFIED");

      // 4. run.completed completes execution
      expect(eventTypes).toContain("run.completed");

      store.close();
    });
  });

  // =========================================================================
  // 13. End-to-End Happy Path (Section 13)
  // =========================================================================
  describe("13. End-to-End Happy Path", () => {
    it("Executes complete governed lifecycle: creation -> binding -> worker execution -> verification -> completion", async () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process", { sum: 99 });

      registerWorker(coordinator, "w-e2e-happy", clock);

      // 1. Create Task
      const task = coordinator.createTask({ title: "sum", inputPayload: [45, 54] });

      // 2. Create MissionContract DRAFT
      const draft = createMissionContract({
        contractId: "contract-e2e",
        version: 1,
        taskId: task.taskId,
        policy: createDefaultInProcessPolicy("p-e2e"),
        verificationSpecs: [
          createVerificationSpec({
            specId: "v-sum",
            ruleKind: "EXACT_OUTPUT_MATCH",
            expectedValue: { sum: 99 },
          }),
        ],
        resourceLimits: createResourceLimits({
          timeoutMs: 20000,
          maxAttempts: 2,
          maxOutputBytes: 65536,
        }),
        credentialScopes: ["scope:e2e"],
      });
      store.insertContract(draft);

      // 3. Activate Contract
      const activated = store.activateContract("contract-e2e", 1);
      expect(activated.lifecycle.status).toBe("ACTIVE");

      // 4. Create Run
      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      // 5. Run gets exact binding
      expect(run.contractBinding).toEqual({
        contractId: "contract-e2e",
        version: 1,
        contentHash: activated.contentHash,
      });

      // 6. Worker claims and executes
      const worker = new WorkerRuntime({
        workerId: "w-e2e-happy",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("COMPLETED");
      expect(provider.providerInvocationCount).toBe(1);

      // 7. Verify completed Run
      const completedRun = coordinator.getRun(run.runId);
      expect(completedRun!.status).toBe("COMPLETED");
      expect(completedRun!.resultPayload).toEqual({ sum: 99 });
      // Exact contract identity remains unchanged
      expect(completedRun!.contractBinding).toEqual(run.contractBinding);

      store.close();
    });
  });

  // =========================================================================
  // 14. End-to-End Revocation Path (Section 14)
  // =========================================================================
  describe("14. End-to-End Revocation Path", () => {
    it("Expired lease + contract revoked mid-flight -> sweeper fails closed; never substitutes v2", async () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process");

      registerWorker(coordinator, "w-e2e-revoke", clock);

      const task = coordinator.createTask({ title: "e2e-revocation", inputPayload: null });
      const contractV1 = createAndActivateContract(store, task.taskId, { version: 1 });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      // Worker claims run
      const claim = coordinator.claimRun(run.runId, "w-e2e-revoke", 5000);
      coordinator.startRun(run.runId, "w-e2e-revoke", claim.lease.leaseId);

      // Worker crashes / lease expires
      clock.advanceMs(6000);

      // Contract v1 revoked by governance operator
      store.revokeContract(contractV1.spec.contractId, 1, "Security breach in v1");

      // Governance operator activates v2
      const contractV2 = createAndActivateContract(store, task.taskId, { version: 2 });
      expect(contractV2.lifecycle.status).toBe("ACTIVE");

      // Sweeper runs recovery
      const recovery = coordinator.recoverExpiredRuns();
      expect(recovery.recoveredCount).toBe(1);

      const failedRun = coordinator.getRun(run.runId);
      expect(failedRun!.status).toBe("FAILED");
      const err = failedRun!.errorPayload as { code: string; details?: { status?: string } };
      expect(err.code).toBe("CONTRACT_REVOKED");
      expect(failedRun!.contractBinding!.version).toBe(1); // v2 is never substituted

      // Worker runtime attempts next claim -> nothing executable
      const worker = new WorkerRuntime({
        workerId: "w-e2e-revoke",
        coordinator,
        clock,
        executionProvider: provider,
      });
      const workerResult = await worker.runOnce();
      expect(workerResult.status).toBe("IDLE");
      expect(provider.providerInvocationCount).toBe(0);

      store.close();
    });
  });

  // =========================================================================
  // 15. End-to-End Tamper Path (Section 15)
  // =========================================================================
  describe("15. End-to-End Tamper Path", () => {
    it("Tampering persisted canonical_spec in DB causes fail-closed failure; zero provider invocations", async () => {
      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process");

      registerWorker(coordinator, "w-e2e-tamper", clock);

      const task = coordinator.createTask({ title: "e2e-tamper", inputPayload: null });
      const contract = createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      // Tamper persisted specification in mission_contracts table directly
      const tamperedSpec = {
        ...contract.spec,
        resourceLimits: { timeoutMs: 999999, maxAttempts: 99, maxOutputBytes: 99999999 },
      };
      (store as any).db.prepare("UPDATE mission_contracts SET canonical_spec = ? WHERE contract_id = ?")
        .run(JSON.stringify(tamperedSpec), contract.spec.contractId);

      // Worker tries to execute
      const worker = new WorkerRuntime({
        workerId: "w-e2e-tamper",
        coordinator,
        clock,
        executionProvider: provider,
      });

      const result = await worker.runOnce();
      expect(result.status).toBe("FAILED");
      expect(provider.providerInvocationCount).toBe(0);
      if (result.status === "FAILED") {
        expect((result.error as { code: string }).code).toBe("CONTRACT_INTEGRITY_MISMATCH");
      }

      // Verify DB was not repaired or mutated to an inconsistent valid state
      const reloadedContract = (store as any).db
        .prepare("SELECT canonical_spec FROM mission_contracts WHERE contract_id = ?")
        .get(contract.spec.contractId) as { canonical_spec: string };
      expect(reloadedContract.canonical_spec).toContain("999999");

      store.close();
    });
  });
});
