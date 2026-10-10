import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { DockerExecutionProvider } from "../../src/adapters/execution/docker-execution-provider.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator, WorkerRuntime } from "../../src/application/index.js";
import { LeaseLostError } from "../../src/domain/errors.js";
import { createVerificationSpec } from "../../src/domain/verification.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { ExecutionRequest } from "../../src/ports/execution-provider.port.js";

const execFileAsync = promisify(execFile);

describe("DockerExecutionProvider — Isolated Execution Boundary", { timeout: 25000 }, () => {
  let isDockerAvailable = false;

  beforeAll(async () => {
    const probe = await DockerExecutionProvider.isAvailable();
    isDockerAvailable = probe.available;
  });

  describe("Provider-level Isolation & Controls", () => {
    it("reports PROVIDER_UNAVAILABLE when Docker binary is missing or invalid", async () => {
      const invalidProvider = new DockerExecutionProvider({
        dockerBinary: "non-existent-docker-binary-xyz",
      });

      const request: ExecutionRequest = {
        runId: "test-unavailable-run",
        taskId: "test-task",
        operationName: "echo",
        inputPayload: { a: 1 },
        idempotencyToken: "tok-1",
        attemptNumber: 0,
        timeoutMs: 5000,
      };

      const result = await invalidProvider.execute(request);
      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("PROVIDER_UNAVAILABLE");
    });

    it("rejects unknown operations not in the mechanical registry without invoking Docker", async () => {
      const provider = new DockerExecutionProvider();
      const request: ExecutionRequest = {
        runId: "test-unknown-run",
        taskId: "test-task",
        operationName: "unauthorized_rm_rf",
        inputPayload: null,
        idempotencyToken: "tok-2",
        attemptNumber: 0,
        timeoutMs: 5000,
      };

      const result = await provider.execute(request);
      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("OPERATION_NOT_FOUND");
      expect(result.error?.message).toContain("unauthorized_rm_rf");
    });

    it("executes deterministic echo operation in container with strict isolation", async () => {
      if (!isDockerAvailable) {
        console.warn("Docker unavailable, skipping live container test");
        return;
      }

      const provider = new DockerExecutionProvider({
        image: "node:22-alpine",
        memoryLimit: "256m",
        cpuLimit: "0.5",
        networkDisabled: true,
        readOnlyRootfs: true,
      });

      const request: ExecutionRequest = {
        runId: "docker-run-echo",
        taskId: "task-echo",
        operationName: "echo",
        inputPayload: { message: "Hello from ephemeral container", count: 123 },
        idempotencyToken: "idem-echo",
        attemptNumber: 0,
        timeoutMs: 20000,
      };

      const result = await provider.execute(request);
      expect(result.status).toBe("SUCCESS");
      expect(result.output).toEqual({ message: "Hello from ephemeral container", count: 123 });
      expect(result.durationMs).toBeGreaterThan(0);
      expect(result.providerMetadata?.provider).toBe("docker");
      expect(result.providerMetadata?.networkDisabled).toBe(true);
      expect(result.providerMetadata?.memoryLimit).toBe("256m");
      expect(result.providerMetadata?.cpuLimit).toBe("0.5");
    });

    it("executes deterministic sum operation in container", async () => {
      if (!isDockerAvailable) return;

      const provider = new DockerExecutionProvider();
      const request: ExecutionRequest = {
        runId: "docker-run-sum",
        taskId: "task-sum",
        operationName: "sum",
        inputPayload: [10, 20, 30, 40],
        idempotencyToken: "idem-sum",
        attemptNumber: 0,
        timeoutMs: 10000,
      };

      const result = await provider.execute(request);
      expect(result.status).toBe("SUCCESS");
      expect(result.output).toBe(100);
    });

    it("produces deterministic output across consecutive isolated runs", async () => {
      if (!isDockerAvailable) return;

      const provider = new DockerExecutionProvider();
      const request: ExecutionRequest = {
        runId: "docker-run-det",
        taskId: "task-det",
        operationName: "sum",
        inputPayload: [1, 2, 3, 4, 5],
        idempotencyToken: "idem-det",
        attemptNumber: 0,
        timeoutMs: 10000,
      };

      const result1 = await provider.execute(request);
      const result2 = await provider.execute(request);

      expect(result1.status).toBe("SUCCESS");
      expect(result2.status).toBe("SUCCESS");
      expect(result1.output).toBe(15);
      expect(result2.output).toBe(15);
      expect(result1.output).toEqual(result2.output);
    });

    it("captures non-zero exit failure and stderr from container", async () => {
      if (!isDockerAvailable) return;

      const provider = new DockerExecutionProvider();
      const request: ExecutionRequest = {
        runId: "docker-run-fail",
        taskId: "task-fail",
        operationName: "fail",
        inputPayload: null,
        idempotencyToken: "idem-fail",
        attemptNumber: 0,
        timeoutMs: 10000,
      };

      const result = await provider.execute(request);
      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("EXECUTION_FAILED");
      expect(result.error?.message).toContain("Deterministic computation failure in container");
    });

    it("enforces output limit and terminates container on excess output", async () => {
      if (!isDockerAvailable) return;

      const provider = new DockerExecutionProvider({
        maxOutputBytes: 1024, // 1 KB ceiling
      });

      const request: ExecutionRequest = {
        runId: "docker-run-flood",
        taskId: "task-flood",
        operationName: "output-flood",
        inputPayload: null,
        idempotencyToken: "idem-flood",
        attemptNumber: 0,
        timeoutMs: 10000,
      };

      const result = await provider.execute(request);
      expect(result.status).toBe("FAILED");
      expect(result.error?.message).toContain("Output limit of 1024 bytes exceeded");
    });

    it("handles timeout with attempted physical container termination", async () => {
      if (!isDockerAvailable) return;

      const provider = new DockerExecutionProvider();
      const request: ExecutionRequest = {
        runId: "docker-run-slow",
        taskId: "task-slow",
        operationName: "slow",
        inputPayload: null,
        idempotencyToken: "idem-slow",
        attemptNumber: 0,
        timeoutMs: 1500, // 1.5s timeout
      };

      const result = await provider.execute(request);
      expect(result.status).toBe("TIMED_OUT");
      expect(result.error?.code).toBe("EXECUTION_TIMEOUT");
      expect(result.error?.message).toContain("physical container termination attempted");
      expect(result.providerMetadata?.physicalTerminationAttempted).toBe(true);
    });

    it("guarantees container cleanup after execution", async () => {
      if (!isDockerAvailable) return;

      const provider = new DockerExecutionProvider();
      const runId = "cleanup-check-" + crypto.randomUUID().slice(0, 6);
      const request: ExecutionRequest = {
        runId,
        taskId: "task-clean",
        operationName: "echo",
        inputPayload: { clean: true },
        idempotencyToken: "idem-clean",
        attemptNumber: 0,
        timeoutMs: 5000,
      };

      await provider.execute(request);

      // Verify no container named with this runId lingers in `docker ps -a`
      const { stdout } = await execFileAsync("docker", ["ps", "-a", "--filter", `name=${runId}`, "--format", "{{.Names}}"]);
      expect(stdout.trim()).toBe("");
    });
  });

  describe("Runtime Integration with DockerExecutionProvider", () => {
    it("executes successful run through WorkerRuntime and RunCoordinator", async () => {
      if (!isDockerAvailable) return;

      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const dockerProvider = new DockerExecutionProvider();

      const worker = new WorkerRuntime({
        workerId: "docker-worker-1",
        coordinator,
        clock,
        executionProvider: dockerProvider,
      });

      const task = coordinator.createTask({
        title: "sum",
        inputPayload: [100, 200, 300],
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const result = await worker.runOnce();
      expect(result.status).toBe("COMPLETED");
      if (result.status === "COMPLETED") {
        expect(result.output).toBe(600);
      }

      // Verify Run state in SQLite
      const completedRun = coordinator.getRun(run.runId);
      expect(completedRun!.status).toBe("COMPLETED");
      expect(completedRun!.resultPayload).toBe(600);

      // Verify events stream
      const events = coordinator.getEventsForRun(run.runId);
      expect(events.map((e) => e.eventType)).toEqual([
        "run.created",
        "run.queued",
        "worker.claimed",
        "run.started",
        "run.completed",
      ]);

      store.close();
    });

    it("transitions run to FAILED when container operation fails", async () => {
      if (!isDockerAvailable) return;

      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const dockerProvider = new DockerExecutionProvider();

      const worker = new WorkerRuntime({
        workerId: "docker-fail-worker",
        coordinator,
        clock,
        executionProvider: dockerProvider,
      });

      const task = coordinator.createTask({
        title: "fail",
        inputPayload: null,
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const result = await worker.runOnce();
      expect(result.status).toBe("FAILED");

      const failedRun = coordinator.getRun(run.runId);
      expect(failedRun!.status).toBe("FAILED");
      expect(failedRun!.errorPayload).toBeDefined();

      store.close();
    });

    it("transitions run to TIMED_OUT when container execution exceeds timeout", async () => {
      if (!isDockerAvailable) return;

      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const dockerProvider = new DockerExecutionProvider();

      const worker = new WorkerRuntime({
        workerId: "docker-timeout-worker",
        coordinator,
        clock,
        executionProvider: dockerProvider,
      });

      const task = coordinator.createTask({
        title: "slow",
        inputPayload: null,
      });

      const { run } = coordinator.createRun({ taskId: task.taskId, timeoutMs: 1500 });
      coordinator.queueRun(run.runId);

      const result = await worker.runOnce();
      expect(result.status).toBe("TIMED_OUT");

      const timedOutRun = coordinator.getRun(run.runId);
      expect(timedOutRun!.status).toBe("TIMED_OUT");

      store.close();
    });

    it("Recovery Experiment: Worker A disappears mid-run -> Sweeper recovers -> Worker B completes via Docker", async () => {
      if (!isDockerAvailable) return;

      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);

      const providerA = new DockerExecutionProvider();
      const providerB = new DockerExecutionProvider();

      const workerA = new WorkerRuntime({
        workerId: "worker-A-docker",
        coordinator,
        clock,
        leaseTtlMs: 3000,
        executionProvider: providerA,
      });

      const workerB = new WorkerRuntime({
        workerId: "worker-B-docker",
        coordinator,
        clock,
        leaseTtlMs: 3000,
        executionProvider: providerB,
      });

      workerA.ensureRegistered();
      workerB.ensureRegistered();

      const task = coordinator.createTask({
        title: "sum",
        inputPayload: [7, 14, 21],
      });

      const { run } = coordinator.createRun({
        taskId: task.taskId,
        idempotencyKey: "docker-reentrant-key-01",
        maxAttempts: 3,
      });
      coordinator.queueRun(run.runId);

      // 1. Worker A claims and starts run
      const claimA = coordinator.claimRun(run.runId, "worker-A-docker", 3000);
      coordinator.startRun(run.runId, "worker-A-docker", claimA.lease.leaseId);

      // 2. Provider A executes in container
      const execResultA = await providerA.execute({
        runId: run.runId,
        taskId: task.taskId,
        operationName: "sum",
        inputPayload: task.inputPayload,
        idempotencyToken: "docker-reentrant-key-01",
        attemptNumber: 0,
        timeoutMs: 10000,
      });
      expect(execResultA.status).toBe("SUCCESS");
      expect(execResultA.output).toBe(42);

      // 3. Worker A disappears before completion (lease expires)
      clock.advanceMs(4000);

      // Verify run remains in RUNNING status in SQLite
      const midState = coordinator.getRun(run.runId);
      expect(midState!.status).toBe("RUNNING");
      expect(midState!.currentWorkerId).toBe("worker-A-docker");

      // 4. Sweeper detects expired lease and recovers run
      const recovery = coordinator.recoverExpiredRuns();
      expect(recovery.recoveredCount).toBe(1);

      const recoveredRun = coordinator.getRun(run.runId);
      expect(recoveredRun!.status).toBe("QUEUED");
      expect(recoveredRun!.attemptCount).toBe(1);

      // 5. Worker B claims the run and executes via Docker provider B
      const resultB = await workerB.runOnce();
      expect(resultB.status).toBe("COMPLETED");
      if (resultB.status === "COMPLETED") {
        expect(resultB.output).toBe(42);
      }

      // 6. Final durable state verified
      const finalRun = coordinator.getRun(run.runId);
      expect(finalRun!.status).toBe("COMPLETED");
      expect(finalRun!.currentWorkerId).toBe("worker-B-docker");
      expect(finalRun!.resultPayload).toBe(42);

      store.close();
    });

    it("Fencing token protects run when stale worker attempts to commit container result", async () => {
      if (!isDockerAvailable) return;

      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const dockerProvider = new DockerExecutionProvider();

      const worker1 = new WorkerRuntime({
        workerId: "worker-stale",
        coordinator,
        clock,
        leaseTtlMs: 2000,
        executionProvider: dockerProvider,
      });
      worker1.ensureRegistered();

      const task = coordinator.createTask({
        title: "echo",
        inputPayload: { fenced: true },
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      // Worker 1 claims and starts run
      const claim1 = coordinator.claimRun(run.runId, "worker-stale", 2000);
      coordinator.startRun(run.runId, "worker-stale", claim1.lease.leaseId);

      // Lease expires, sweeper recovers
      clock.advanceMs(3000);
      coordinator.recoverExpiredRuns();

      // Worker 2 takes over
      const worker2 = new WorkerRuntime({
        workerId: "worker-fresh",
        coordinator,
        clock,
        executionProvider: dockerProvider,
      });
      worker2.ensureRegistered();

      const claim2 = coordinator.claimRun(run.runId, "worker-fresh", 5000);
      coordinator.startRun(run.runId, "worker-fresh", claim2.lease.leaseId);

      // Worker 1 tries to commit using stale lease token
      expect(() => {
        coordinator.completeRun(run.runId, "worker-stale", claim1.lease.leaseId, { fenced: false });
      }).toThrow(LeaseLostError);

      // Verify run is still under worker-fresh
      const currentRun = coordinator.getRun(run.runId);
      expect(currentRun!.currentWorkerId).toBe("worker-fresh");
      expect(currentRun!.leaseId).toBe(claim2.lease.leaseId);

      store.close();
    });

    it("Retry budget exhaustion transitions run to FAILED with retriesExhausted", async () => {
      if (!isDockerAvailable) return;

      const clock = new SettableClock("2026-03-30T10:00:00.000Z");
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const dockerProvider = new DockerExecutionProvider();

      const worker = new WorkerRuntime({
        workerId: "worker-exhaust",
        coordinator,
        clock,
        leaseTtlMs: 2000,
        executionProvider: dockerProvider,
      });
      worker.ensureRegistered();

      const task = coordinator.createTask({
        title: "echo",
        inputPayload: "exhaust-test",
      });

      // Max attempts = 1
      const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 1 });
      coordinator.queueRun(run.runId);

      // Attempt 1: Worker claims and starts
      const claim1 = coordinator.claimRun(run.runId, "worker-exhaust", 2000);
      coordinator.startRun(run.runId, "worker-exhaust", claim1.lease.leaseId);

      // Expire and recover attempt 1 (attemptCount becomes 1)
      clock.advanceMs(3000);
      coordinator.recoverExpiredRuns();

      // Attempt 2 starts (attemptCount = 1)
      const claim2 = coordinator.claimRun(run.runId, "worker-exhaust", 2000);
      coordinator.startRun(run.runId, "worker-exhaust", claim2.lease.leaseId);

      // Expire attempt 2
      clock.advanceMs(3000);
      const recovery2 = coordinator.recoverExpiredRuns();
      expect(recovery2.recoveredCount).toBe(1);

      const exhaustedRun = coordinator.getRun(run.runId);
      expect(exhaustedRun!.status).toBe("FAILED");
      expect((exhaustedRun!.errorPayload as { code: string }).code).toBe("RETRIES_EXHAUSTED");

      store.close();
    });

    it("verifies container execution output through WorkerRuntime against VerificationSpec", async () => {
      if (!isDockerAvailable) return;

      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const dockerProvider = new DockerExecutionProvider();

      const verificationSpec = createVerificationSpec({
        specId: "docker-verify-sum-15",
        ruleKind: "EXACT_OUTPUT_MATCH",
        expectedValue: 15,
      });

      const worker = new WorkerRuntime({
        workerId: "docker-verifier-worker",
        coordinator,
        clock,
        executionProvider: dockerProvider,
        verificationSpec,
      });

      const task = coordinator.createTask({
        title: "sum",
        inputPayload: [7, 8],
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const result = await worker.runOnce();

      expect(result.status).toBe("COMPLETED");
      if (result.status === "COMPLETED") {
        expect(result.output).toBe(15);
      }

      const events = coordinator.getEventsForRun(run.runId);
      const eventTypes = events.map((e) => e.eventType);

      expect(eventTypes).toContain("evidence.recorded");
      expect(eventTypes).toContain("verification.completed");
      expect(eventTypes).toContain("run.completed");

      const verifEvent = events.find((e) => e.eventType === "verification.completed");
      expect((verifEvent!.payload as { status: string }).status).toBe("VERIFIED");

      store.close();
    });
  });
});
