import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DockerExecutionProvider } from "../../src/adapters/execution/docker-execution-provider.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { RunCoordinator, WorkerRuntime } from "../../src/application/index.js";
import {
  createDefaultDockerPolicy,
  createDefaultInProcessPolicy,
} from "../../src/domain/policy.js";
import { createVerificationSpec } from "../../src/domain/verification.js";
import { WorkspaceSpec } from "../../src/domain/workspace.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "../../src/ports/execution-provider.port.js";
import { WorkspacePort } from "../../src/ports/workspace.port.js";
import { createAndActivateContract } from "./test-helpers.js";

/**
 * Counting mock ExecutionProvider for tracking provider invocations.
 */
class CountingExecutionProvider implements ExecutionProvider {
  readonly name: string;
  readonly invocations: ExecutionRequest[] = [];
  private readonly outcome: { status: "SUCCESS" | "FAILED" | "TIMED_OUT"; output?: unknown; error?: unknown };

  constructor(name: string = "in-process", outcome?: unknown) {
    this.name = name;
    if (outcome && typeof outcome === "object" && "status" in outcome) {
      this.outcome = outcome as { status: "SUCCESS" | "FAILED" | "TIMED_OUT"; output?: unknown; error?: unknown };
    } else {
      this.outcome = { status: "SUCCESS", output: outcome ?? { ok: true } };
    }
  }

  get providerInvocationCount(): number {
    return this.invocations.length;
  }

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocations.push(request);
    return {
      status: this.outcome.status,
      output: this.outcome.output as TOutput,
      error: this.outcome.error as any,
      durationMs: 10,
      providerMetadata: { provider: this.name, exitCode: this.outcome.status === "SUCCESS" ? 0 : 1 },
    };
  }
}

describe("Task 3.3 — Workspace Runtime Integration & Docker Mount Confinement", { timeout: 30000 }, () => {
  let testRoot: string;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let isDockerAvailable = false;

  beforeEach(async () => {
    testRoot = path.join(os.tmpdir(), `emerald-test-ws-${crypto.randomUUID()}`);
    await fs.mkdir(testRoot, { recursive: true, mode: 0o700 });
    testRoot = await fs.realpath(testRoot);
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: testRoot });

    const probe = await DockerExecutionProvider.isAvailable();
    isDockerAvailable = probe.available;
  });

  afterEach(async () => {
    try {
      await fs.rm(testRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error in test tearDown
    }
  });

  // =========================================================================
  // 1. Workspace Lifecycle Integration
  // =========================================================================
  describe("1. Workspace Lifecycle & Event Sequence", () => {
    it("provisions, leases, cleans, and disposes workspace across governed run lifecycle", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock, undefined, workspaceAdapter);
      const provider = new CountingExecutionProvider("in-process", { done: true });
      const runtime = new WorkerRuntime({
        coordinator,
        clock,
        executionProvider: provider,
        workspacePort: workspaceAdapter,
      });

      const task = coordinator.createTask({
        title: "echo",
        inputPayload: { foo: "bar" },
      });
      createAndActivateContract(store, task.taskId, {
        policy: createDefaultInProcessPolicy("test-policy"),
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);
      const result = await runtime.runOnce(run.runId);

      expect(result.status).toBe("COMPLETED");
      expect(provider.providerInvocationCount).toBe(1);

      // Verify workspace mount was passed to provider
      const requestPassed = provider.invocations[0]!;
      expect(requestPassed.workspace).toBeDefined();
      expect(requestPassed.workspace?.hostPath).toContain(testRoot);
      expect(requestPassed.workspace?.containerMountPath).toBe("/workspace");

      // Verify workspace lifecycle events in audit log
      const events = store.getEventsForRun(run.runId);
      const wsEvents = events.filter((e) => e.eventType.startsWith("workspace."));
      const eventTypes = wsEvents.map((e) => e.eventType);

      expect(eventTypes).toEqual([
        "workspace.provisioning",
        "workspace.ready",
        "workspace.leased",
        "workspace.cleaning",
        "workspace.disposed",
      ]);

      // Verify workspace directory was deleted after successful completion
      const hostPath = requestPassed.workspace!.hostPath;
      await expect(fs.stat(hostPath)).rejects.toThrow();
    });

    it("ensures workspace ID is distinct from run ID", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process", { done: true });
      const runtime = new WorkerRuntime({
        coordinator,
        clock,
        executionProvider: provider,
        workspacePort: workspaceAdapter,
      });

      const task = coordinator.createTask({
        title: "echo",
        inputPayload: {},
      });
      createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);
      await runtime.runOnce(run.runId);

      const wsRequest = provider.invocations[0]?.workspace;
      expect(wsRequest?.workspaceId).toBeDefined();
      expect(wsRequest?.workspaceId).not.toBe(run.runId);
      expect(wsRequest?.workspaceId).toMatch(/^ws-/);
    });
  });

  // =========================================================================
  // 2. Docker Execution Mount & Confinement
  // =========================================================================
  describe("2. Docker Execution Mount Confinement", () => {
    it("executes through WorkerRuntime with DockerExecutionProvider and mounts workspace", async () => {
      if (!isDockerAvailable) {
        return; // Skip if Docker not available in environment
      }

      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock, undefined, workspaceAdapter);
      const dockerProvider = new DockerExecutionProvider();
      const runtime = new WorkerRuntime({
        coordinator,
        clock,
        executionProvider: dockerProvider,
        workspacePort: workspaceAdapter,
      });

      const task = coordinator.createTask({
        title: "echo",
        inputPayload: { message: "emerald in container" },
      });
      createAndActivateContract(store, task.taskId, {
        policy: createDefaultDockerPolicy("docker-ws-policy"),
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);
      const result = await runtime.runOnce(run.runId);

      expect(result.status).toBe("COMPLETED");
      if (result.status === "COMPLETED") {
        expect(result.output).toEqual({ message: "emerald in container" });
      }
    });

    it("verifies container confinement via Docker provider: read-only rootfs, no docker socket, workspace present", async () => {
      if (!isDockerAvailable) {
        return;
      }

      const dockerProvider = new DockerExecutionProvider();
      const wsHandle = await workspaceAdapter.provisionWorkspace({
        workspaceId: `ws-confine-${crypto.randomUUID().slice(0, 8)}`,
        runId: "run-confine-test",
        taskId: "task-confine-test",
        maxWorkspaceBytes: 100000,
        maxFileSizeBytes: 10000,
      });

      const request: ExecutionRequest = {
        runId: "run-confine-test",
        taskId: "task-confine-test",
        operationName: "workspace-assert-confinement",
        inputPayload: {},
        idempotencyToken: "tok-confine",
        attemptNumber: 0,
        timeoutMs: 10000,
        workspace: {
          workspaceId: wsHandle.workspaceId,
          hostPath: wsHandle.hostPath,
          containerMountPath: "/workspace",
        },
      };

      const result = await dockerProvider.execute(request);
      expect(result.status).toBe("SUCCESS");
      if (result.status === "SUCCESS") {
        const out = result.output as { rootWritable: boolean; hasDockerSock: boolean; workspaceExists: boolean };
        expect(out.workspaceExists).toBe(true);
        expect(out.hasDockerSock).toBe(false);
        expect(out.rootWritable).toBe(false); // Rootfs is strictly read-only
      }

      await workspaceAdapter.disposeWorkspace(wsHandle.workspaceId);
    });

    it("verifies container writes to /workspace persist to host workspace directory", async () => {
      if (!isDockerAvailable) {
        return;
      }

      const dockerProvider = new DockerExecutionProvider();
      const wsHandle = await workspaceAdapter.provisionWorkspace({
        workspaceId: `ws-write-${crypto.randomUUID().slice(0, 8)}`,
        runId: "run-write-test",
        taskId: "task-write-test",
        maxWorkspaceBytes: 100000,
        maxFileSizeBytes: 10000,
      });

      const request: ExecutionRequest = {
        runId: "run-write-test",
        taskId: "task-write-test",
        operationName: "workspace-write",
        inputPayload: { filename: "hello.txt", content: "emerald confined content" },
        idempotencyToken: "tok-write",
        attemptNumber: 0,
        timeoutMs: 10000,
        workspace: {
          workspaceId: wsHandle.workspaceId,
          hostPath: wsHandle.hostPath,
          containerMountPath: "/workspace",
        },
      };

      const result = await dockerProvider.execute(request);
      expect(result.status).toBe("SUCCESS");

      // Verify file appeared in host workspace directory
      const hostFile = path.join(wsHandle.hostPath, "hello.txt");
      const contentOnHost = await fs.readFile(hostFile, "utf8");
      expect(contentOnHost).toBe("emerald confined content");

      await workspaceAdapter.disposeWorkspace(wsHandle.workspaceId);
    });

    it("refuses to mount sensitive host directories in DockerExecutionProvider", async () => {
      const dockerProvider = new DockerExecutionProvider();
      const maliciousRequests: ExecutionRequest[] = [
        {
          runId: "r1",
          taskId: "t1",
          operationName: "echo",
          inputPayload: {},
          idempotencyToken: "tok-1",
          attemptNumber: 0,
          timeoutMs: 5000,
          workspace: { hostPath: path.parse(process.cwd()).root }, // Host root
        },
        {
          runId: "r2",
          taskId: "t2",
          operationName: "echo",
          inputPayload: {},
          idempotencyToken: "tok-2",
          attemptNumber: 0,
          timeoutMs: 5000,
          workspace: { hostPath: os.homedir() }, // User home directory
        },
        {
          runId: "r3",
          taskId: "t3",
          operationName: "echo",
          inputPayload: {},
          idempotencyToken: "tok-3",
          attemptNumber: 0,
          timeoutMs: 5000,
          workspace: { hostPath: process.cwd() }, // Repo root / cwd
        },
        {
          runId: "r4",
          taskId: "t4",
          operationName: "echo",
          inputPayload: {},
          idempotencyToken: "tok-4",
          attemptNumber: 0,
          timeoutMs: 5000,
          workspace: { hostPath: path.join(os.homedir(), ".ssh") }, // .ssh directory
        },
      ];

      for (const req of maliciousRequests) {
        const res = await dockerProvider.execute(req);
        expect(res.status).toBe("FAILED");
        expect(res.error?.message).toMatch(/Security violation|Refusing to mount/);
      }
    });
  });

  // =========================================================================
  // 3. Cross-Run Isolation & Containment
  // =========================================================================
  describe("3. Cross-Run Isolation & Containment", () => {
    it("ensures Run A and Run B receive completely isolated workspaces", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const providerA = new CountingExecutionProvider("in-process", { run: "A" });
      const providerB = new CountingExecutionProvider("in-process", { run: "B" });

      const runtimeA = new WorkerRuntime({
        coordinator,
        clock,
        executionProvider: providerA,
        workspacePort: workspaceAdapter,
      });

      const runtimeB = new WorkerRuntime({
        coordinator,
        clock,
        executionProvider: providerB,
        workspacePort: workspaceAdapter,
      });

      const taskA = coordinator.createTask({ title: "echo", inputPayload: {} });
      const taskB = coordinator.createTask({ title: "echo", inputPayload: {} });
      createAndActivateContract(store, taskA.taskId);
      createAndActivateContract(store, taskB.taskId);

      const { run: runA } = coordinator.createRun({ taskId: taskA.taskId });
      const { run: runB } = coordinator.createRun({ taskId: taskB.taskId });
      coordinator.queueRun(runA.runId);
      coordinator.queueRun(runB.runId);

      await runtimeA.runOnce(runA.runId);
      await runtimeB.runOnce(runB.runId);

      const wsA = providerA.invocations[0]?.workspace!;
      const wsB = providerB.invocations[0]?.workspace!;

      expect(wsA.workspaceId).not.toBe(wsB.workspaceId);
      expect(wsA.hostPath).not.toBe(wsB.hostPath);
      expect(path.dirname(wsA.hostPath)).toBe(path.dirname(wsB.hostPath)); // Both children of testRoot
    });
  });

  // =========================================================================
  // 4. Governance Boundaries & Provider Invocation Invariant
  // =========================================================================
  describe("4. Governance & Pre-Dispatch Failures", () => {
    it("ensures providerInvocationCount === 0 when contract is REVOKED", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider();
      const runtime = new WorkerRuntime({
        coordinator,
        clock,
        executionProvider: provider,
        workspacePort: workspaceAdapter,
      });

      const task = coordinator.createTask({ title: "echo", inputPayload: {} });
      const contract = createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      // Contract revoked before worker execution
      store.revokeContract(contract.spec.contractId, contract.spec.version, "Test revocation");

      const result = await runtime.runOnce(run.runId);

      expect(result.status).toBe("FAILED");
      expect(provider.providerInvocationCount).toBe(0);
    });

    it("ensures providerInvocationCount === 0 when workspace provisioning fails", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider();

      // Mock workspace port that fails provisioning
      const failingWsPort: WorkspacePort = {
        async provisionWorkspace() {
          throw new Error("Disk quota exhausted during provisioning");
        },
        async resolvePath() {
          return "";
        },
        async disposeWorkspace() {},
        async cleanupOrphanedWorkspaces() {
          return [];
        },
      };

      const runtime = new WorkerRuntime({
        coordinator,
        clock,
        executionProvider: provider,
        workspacePort: failingWsPort,
      });

      const task = coordinator.createTask({ title: "echo", inputPayload: {} });
      createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);
      const result = await runtime.runOnce(run.runId);

      expect(result.status).toBe("FAILED");
      expect(provider.providerInvocationCount).toBe(0); // Invariant maintained

      const runRecord = store.getRun(run.runId);
      expect(runRecord?.status).toBe("FAILED");
      expect((runRecord?.errorPayload as { code?: string })?.code).toBe("WORKSPACE_PROVISIONING_FAILED");

      // Verify workspace.failed event was logged
      const events = store.getEventsForRun(run.runId);
      expect(events.some((e) => e.eventType === "workspace.failed")).toBe(true);
    });

    it("ensures providerInvocationCount === 0 when workspace boundary check fails", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider();

      // Malicious adapter returning invalid handle
      const badWsPort: WorkspacePort = {
        async provisionWorkspace(spec: WorkspaceSpec) {
          return {
            workspaceId: "different-ws-id", // Identity mismatch!
            runId: spec.runId,
            hostPath: testRoot,
            containerMountPath: "/workspace",
            createdAt: new Date().toISOString(),
            maxWorkspaceBytes: 1000,
          };
        },
        async resolvePath() {
          return "";
        },
        async disposeWorkspace() {},
        async cleanupOrphanedWorkspaces() {
          return [];
        },
      };

      const runtime = new WorkerRuntime({
        coordinator,
        clock,
        executionProvider: provider,
        workspacePort: badWsPort,
      });

      const task = coordinator.createTask({ title: "echo", inputPayload: {} });
      createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);
      const result = await runtime.runOnce(run.runId);

      expect(result.status).toBe("FAILED");
      expect(provider.providerInvocationCount).toBe(0);

      const runRecord = store.getRun(run.runId);
      expect((runRecord?.errorPayload as { code?: string })?.code).toBe("WORKSPACE_BOUNDARY_FAILURE");
    });
  });

  // =========================================================================
  // 5. Cleanup on Failures, Timeouts & Cancellations
  // =========================================================================
  describe("5. Cleanup on Abnormal Termination Paths", () => {
    it("unconditionally cleans up workspace when provider fails", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const failingProvider = new CountingExecutionProvider("in-process", {
        status: "FAILED",
        error: { code: "EXEC_FAIL", message: "computation error" },
      });

      let provisionedPath: string | null = null;
      const trackingWsPort: WorkspacePort = {
        async provisionWorkspace(spec: WorkspaceSpec) {
          const handle = await workspaceAdapter.provisionWorkspace(spec);
          provisionedPath = handle.hostPath;
          return handle;
        },
        resolvePath: (wsId, rel) => workspaceAdapter.resolvePath(wsId, rel),
        disposeWorkspace: (wsId) => workspaceAdapter.disposeWorkspace(wsId),
        cleanupOrphanedWorkspaces: (active) => workspaceAdapter.cleanupOrphanedWorkspaces(active),
      };

      const runtime = new WorkerRuntime({
        coordinator,
        clock,
        executionProvider: failingProvider,
        workspacePort: trackingWsPort,
      });

      const task = coordinator.createTask({ title: "echo", inputPayload: {} });
      createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);
      const result = await runtime.runOnce(run.runId);

      expect(result.status).toBe("FAILED");
      expect(provisionedPath).not.toBeNull();
      // Host directory should be deleted
      await expect(fs.stat(provisionedPath!)).rejects.toThrow();

      // Audit log has workspace.disposed
      const events = store.getEventsForRun(run.runId);
      expect(events.some((e) => e.eventType === "workspace.disposed")).toBe(true);
    });

    it("unconditionally cleans up workspace when verification fails", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process", { unexpected: "output" });

      let provisionedPath: string | null = null;
      const trackingWsPort: WorkspacePort = {
        async provisionWorkspace(spec: WorkspaceSpec) {
          const handle = await workspaceAdapter.provisionWorkspace(spec);
          provisionedPath = handle.hostPath;
          return handle;
        },
        resolvePath: (wsId, rel) => workspaceAdapter.resolvePath(wsId, rel),
        disposeWorkspace: (wsId) => workspaceAdapter.disposeWorkspace(wsId),
        cleanupOrphanedWorkspaces: (active) => workspaceAdapter.cleanupOrphanedWorkspaces(active),
      };

      const runtime = new WorkerRuntime({
        coordinator,
        clock,
        executionProvider: provider,
        workspacePort: trackingWsPort,
      });

      const task = coordinator.createTask({ title: "echo", inputPayload: {} });
      const vSpec = createVerificationSpec({
        specId: "exact-match-spec",
        ruleKind: "EXACT_OUTPUT_MATCH",
        expectedValue: { expected: "output" },
      });
      createAndActivateContract(store, task.taskId, {
        verificationSpecs: [vSpec],
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);
      const result = await runtime.runOnce(run.runId);

      expect(result.status).toBe("FAILED");
      expect(provisionedPath).not.toBeNull();
      await expect(fs.stat(provisionedPath!)).rejects.toThrow();
    });

    it("fails run closed if workspace cleanup fails after successful execution", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);
      const provider = new CountingExecutionProvider("in-process", { ok: true });

      const failingDisposalPort: WorkspacePort = {
        provisionWorkspace: (spec) => workspaceAdapter.provisionWorkspace(spec),
        resolvePath: (wsId, rel) => workspaceAdapter.resolvePath(wsId, rel),
        async disposeWorkspace() {
          throw new Error("Device I/O lock prevented deletion");
        },
        cleanupOrphanedWorkspaces: (active) => workspaceAdapter.cleanupOrphanedWorkspaces(active),
      };

      const runtime = new WorkerRuntime({
        coordinator,
        clock,
        executionProvider: provider,
        workspacePort: failingDisposalPort,
      });

      const task = coordinator.createTask({ title: "echo", inputPayload: {} });
      createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);
      const result = await runtime.runOnce(run.runId);

      // Must NOT be marked COMPLETED!
      expect(result.status).toBe("FAILED");
      const runRecord = store.getRun(run.runId);
      expect(runRecord?.status).toBe("FAILED");
      expect((runRecord?.errorPayload as { code?: string })?.code).toBe("WORKSPACE_CLEANUP_FAILED");
    });
  });

  // =========================================================================
  // 6. Crash Recovery & Safe Orphan Detection
  // =========================================================================
  describe("6. Sweeper Crash Recovery & Authoritative Orphan Defense", () => {
    it("sweeper safely cleans crashed worker's workspace during lease expiry recovery", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock, undefined, workspaceAdapter);

      coordinator.registerWorker({
        workerId: "worker-1",
        hostname: "localhost",
        pid: 1234,
        status: "ACTIVE",
        lastHeartbeatAt: clock.nowIso(),
        createdAt: clock.nowIso(),
      });

      const task = coordinator.createTask({ title: "echo", inputPayload: {} });
      createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      // Worker starts run and provisions workspace
      const claim = coordinator.claimRun(run.runId, "worker-1", 1000);
      coordinator.startRun(run.runId, "worker-1", claim.lease.leaseId);

      const wsSpec: WorkspaceSpec = {
        workspaceId: `ws-crash-${crypto.randomUUID().slice(0, 8)}`,
        runId: run.runId,
        taskId: task.taskId,
        maxWorkspaceBytes: 10000,
        maxFileSizeBytes: 1000,
      };
      const wsHandle = await workspaceAdapter.provisionWorkspace(wsSpec);
      coordinator.recordWorkspaceEvent({
        eventId: crypto.randomUUID(),
        runId: run.runId,
        timestamp: clock.nowIso(),
        eventType: "workspace.ready",
        schemaVersion: 1,
        producer: "domain.workspace",
        payload: { workspaceId: wsSpec.workspaceId, runId: run.runId },
      });

      // Confirm directory exists
      await expect(fs.stat(wsHandle.hostPath)).resolves.toBeDefined();

      // Worker-1 crashes! Time advances past lease expiration
      clock.advanceMs(5000);

      // Sweeper runs recovery
      const recovered = coordinator.recoverExpiredRuns();
      expect(recovered.recoveredCount).toBe(1);

      // Crashed workspace directory was safely disposed
      await expect(fs.stat(wsHandle.hostPath)).rejects.toThrow();

      // Event stream records workspace.disposed from sweeper
      const events = store.getEventsForRun(run.runId);
      expect(events.some((e) => e.eventType === "workspace.disposed" && e.producer === "coordinator.sweeper")).toBe(true);
    });

    it("authoritative orphan cleanup never deletes an active run's workspace", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock, undefined, workspaceAdapter);

      const task = coordinator.createTask({ title: "echo", inputPayload: {} });
      createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);
      const wsSpec: WorkspaceSpec = {
        workspaceId: `ws-active-${crypto.randomUUID().slice(0, 8)}`,
        runId: run.runId,
        taskId: task.taskId,
        maxWorkspaceBytes: 10000,
        maxFileSizeBytes: 1000,
      };
      const wsHandle = await workspaceAdapter.provisionWorkspace(wsSpec);

      // Record workspace ready event for the active/queued run
      coordinator.recordWorkspaceEvent({
        eventId: crypto.randomUUID(),
        runId: run.runId,
        timestamp: clock.nowIso(),
        eventType: "workspace.ready",
        schemaVersion: 1,
        producer: "domain.workspace",
        payload: { workspaceId: wsSpec.workspaceId, runId: run.runId },
      });

      // Create an actual orphan directory unlinked to any run
      const orphanDir = path.join(testRoot, "ws-unlinked-orphan");
      await fs.mkdir(orphanDir, { mode: 0o700 });

      // Run authoritative orphan cleanup
      const reclaimed = await coordinator.cleanupOrphanedWorkspacesSafely({ reclaimUnowned: true });

      expect(reclaimed).toContain("ws-unlinked-orphan");
      expect(reclaimed).not.toContain(wsSpec.workspaceId);

      // Active workspace still exists!
      await expect(fs.stat(wsHandle.hostPath)).resolves.toBeDefined();
      // Orphan directory deleted!
      await expect(fs.stat(orphanDir)).rejects.toThrow();
    });
  });
});
