import * as crypto from "node:crypto";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DockerExecutionProvider } from "../../src/adapters/execution/docker-execution-provider.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import {
  InvalidWorkspaceError,
  LeaseLostError,
  WorkspacePathOutsideBoundaryError,
} from "../../src/domain/errors.js";
import { ClockPort } from "../../src/ports/clock.port.js";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "../../src/ports/execution-provider.port.js";

class SettableClock implements ClockPort {
  private currentMs: number;

  constructor(initialMs: number = Date.now()) {
    this.currentMs = initialMs;
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  nowIso(): string {
    return new Date(this.currentMs).toISOString();
  }

  nowMs(): number {
    return this.currentMs;
  }

  tick(ms: number): void {
    this.currentMs += ms;
  }
}

import { createAndActivateContract } from "./test-helpers.js";

class TestCountingExecutionProvider implements ExecutionProvider {
  readonly tenantModel = "NONE" as const;
  readonly quiescence = { async quiesceRun(_runId: string) { return { status: "QUIESCENT" as const, stopped: 0 }; } };
  readonly name: string;
  providerInvocationCount = 0;
  invocations: ExecutionRequest[] = [];
  private outcome: { status: "SUCCESS" | "FAILED" | "TIMED_OUT" | "CANCELLED"; output?: unknown; error?: unknown };

  constructor(
    name: string = "in-process",
    outcome: { status: "SUCCESS" | "FAILED" | "TIMED_OUT" | "CANCELLED"; output?: unknown; error?: unknown } = {
      status: "SUCCESS",
      output: { ok: true },
    }
  ) {
    this.name = name;
    this.outcome = outcome;
  }

  setOutcome(outcome: { status: "SUCCESS" | "FAILED" | "TIMED_OUT" | "CANCELLED"; output?: unknown; error?: unknown }): void {
    this.outcome = outcome;
  }

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.providerInvocationCount++;
    this.invocations.push(request as ExecutionRequest);

    if (this.outcome.status === "SUCCESS") {
      return {
        status: "SUCCESS",
        output: this.outcome.output as TOutput,
        durationMs: 10,
        providerMetadata: { provider: this.name, exitCode: 0 },
      };
    }

    return {
      status: this.outcome.status,
      output: this.outcome.output as TOutput,
      error: this.outcome.error as any,
      durationMs: 10,
      providerMetadata: { provider: this.name, exitCode: 1 },
    };
  }
}

describe("Task 3.4 — Workspace Crash Recovery, Orphan Reclamation & Sandbox Security Closure", { timeout: 30000 }, () => {
  let testRoot: string;
  let workspaceAdapter: NodeFsWorkspaceAdapter;

  beforeEach(async () => {
    testRoot = path.join(os.tmpdir(), `emerald-test-ws-3-4-${crypto.randomUUID()}`);
    await fs.mkdir(testRoot, { recursive: true, mode: 0o700 });
    testRoot = await fs.realpath(testRoot);
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: testRoot });
  });

  afterEach(async () => {
    try {
      await fs.rm(testRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error in test tearDown
    }
  });

  // =========================================================================
  // 1. Authority & Current Durable Runtime State Invariants
  // =========================================================================
  describe("1. Authority Invariants (Audit History != Current Authority)", () => {
    it("proves that historical audit events cannot override current terminal Run state", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock, undefined, workspaceAdapter);
      const provider = new TestCountingExecutionProvider("in-process", { status: "SUCCESS", output: { result: 1 } });
      const runtime = new WorkerRuntime({
        coordinator,
        clock,
        executionProvider: provider,
        workspacePort: workspaceAdapter,
      });

      const task = coordinator.createTask({ title: "echo", inputPayload: { x: 1 } });
      createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      // Execute run to completion
      const result = await runtime.runOnce(run.runId);
      expect(result.status).toBe("COMPLETED");

      // Verify audit history contains workspace events
      const events = store.getEventsForRun(run.runId);
      const leasedEvent = events.find((e) => e.eventType === "workspace.leased");
      expect(leasedEvent).toBeDefined();
      const wsId = (leasedEvent?.payload as any)?.workspaceId;
      expect(wsId).toBeDefined();

      // Now create a dummy workspace directory on disk imitating a leftover
      const leftoverDir = path.join(testRoot, wsId);
      await fs.mkdir(leftoverDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(leftoverDir, ".emerald-workspace.json"), JSON.stringify({ runId: run.runId, workspaceId: wsId }));

      // Current durable state of run is COMPLETED (terminal).
      // Audit history has workspace.leased, BUT current authority says Run is terminal!
      expect(coordinator.isWorkspaceAuthoritativelyActive(wsId)).toBe(false);

      // Safe orphan reclamation must reclaim this terminal run's leftover workspace
      const reclaimed = await coordinator.cleanupOrphanedWorkspacesSafely({ reclaimUnowned: true });
      expect(reclaimed).toContain(wsId);
      expect(syncFs.existsSync(leftoverDir)).toBe(false);
    });

    it("proves that historical audit events cannot override expired lease state", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock, undefined, workspaceAdapter);

      const task = coordinator.createTask({ title: "echo", inputPayload: { x: 1 } });
      createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      // Register worker-1
      coordinator.registerWorker({
        workerId: "worker-1",
        hostname: "localhost",
        pid: process.pid,
        status: "ACTIVE",
        lastHeartbeatAt: clock.nowIso(),
        createdAt: clock.nowIso(),
      });

      // Claim run with 5-second lease
      const claim = coordinator.claimRun(run.runId, "worker-1", 5000);
      coordinator.startRun(run.runId, "worker-1", claim.lease.leaseId);

      // Provision workspace
      const wsSpec = {
        workspaceId: "ws-expired-lease",
        runId: run.runId,
        taskId: task.taskId,
        maxWorkspaceBytes: 50 * 1024 * 1024,
        maxFileSizeBytes: 5 * 1024 * 1024,
      };
      await workspaceAdapter.provisionWorkspace(wsSpec);

      // Record workspace leased event in audit history
      coordinator.recordWorkspaceEvent({
        eventId: crypto.randomUUID(),
        runId: run.runId,
        timestamp: clock.nowIso(),
        eventType: "workspace.leased",
        schemaVersion: 1,
        producer: "test",
        payload: { workspaceId: "ws-expired-lease", runId: run.runId },
      });

      // While lease is active, isWorkspaceAuthoritativelyActive returns true
      expect(coordinator.isWorkspaceAuthoritativelyActive("ws-expired-lease")).toBe(true);

      // Advance clock past lease expiration (e.g. 10 seconds)
      clock.tick(10000);

      // Current authority check: lease has expired!
      // Event history still has workspace.leased, but current authority says NOT active
      expect(coordinator.isWorkspaceAuthoritativelyActive("ws-expired-lease")).toBe(false);

      // Safe orphan reclamation reclaims the workspace whose lease expired
      const reclaimed = await coordinator.cleanupOrphanedWorkspacesSafely({ reclaimUnowned: true });
      expect(reclaimed).toContain("ws-expired-lease");
    });

    it("protects old active, old leased, and queued workspaces from orphan reclamation (age alone never establishes orphan)", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock, undefined, workspaceAdapter);

      const task = coordinator.createTask({ title: "echo", inputPayload: { x: 1 } });
      createAndActivateContract(store, task.taskId);

      // Register workers
      coordinator.registerWorker({
        workerId: "worker-active",
        hostname: "localhost",
        pid: process.pid,
        status: "ACTIVE",
        lastHeartbeatAt: clock.nowIso(),
        createdAt: clock.nowIso(),
      });
      coordinator.registerWorker({
        workerId: "worker-leased",
        hostname: "localhost",
        pid: process.pid,
        status: "ACTIVE",
        lastHeartbeatAt: clock.nowIso(),
        createdAt: clock.nowIso(),
      });

      // 1. Old Active Running Run (lease valid for 24 hours)
      const { run: runActive } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(runActive.runId);
      const claimActive = coordinator.claimRun(runActive.runId, "worker-active", 24 * 3600 * 1000);
      coordinator.startRun(runActive.runId, "worker-active", claimActive.lease.leaseId);
      const wsActiveHandle = await workspaceAdapter.provisionWorkspace({
        workspaceId: "ws-old-running",
        runId: runActive.runId,
        taskId: task.taskId,
        maxWorkspaceBytes: 50 * 1024 * 1024,
        maxFileSizeBytes: 5 * 1024 * 1024,
      });

      // 2. Old Leased Run (not yet started, but actively leased)
      const { run: runLeased } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(runLeased.runId);
      coordinator.claimRun(runLeased.runId, "worker-leased", 24 * 3600 * 1000);
      await workspaceAdapter.provisionWorkspace({
        workspaceId: "ws-old-leased",
        runId: runLeased.runId,
        taskId: task.taskId,
        maxWorkspaceBytes: 50 * 1024 * 1024,
        maxFileSizeBytes: 5 * 1024 * 1024,
      });

      // 3. Truly orphaned workspace (directory exists on disk, no owning run exists in DB)
      const orphanDir = path.join(testRoot, "ws-true-orphan");
      await fs.mkdir(orphanDir, { recursive: true, mode: 0o700 });

      // Advance clock by 10 hours (workspaces are now 10 hours old, but leases remain valid!)
      clock.tick(10 * 3600 * 1000);

      // Verify authoritative status
      expect(coordinator.isWorkspaceAuthoritativelyActive("ws-old-running")).toBe(true);
      expect(coordinator.isWorkspaceAuthoritativelyActive("ws-old-leased")).toBe(true);
      expect(coordinator.isWorkspaceAuthoritativelyActive("ws-true-orphan")).toBe(false);

      // Run orphan cleanup
      const reclaimed = await coordinator.cleanupOrphanedWorkspacesSafely({ reclaimUnowned: true });

      // Invariant: Active running and leased workspaces are NEVER deleted!
      expect(reclaimed).not.toContain("ws-old-running");
      expect(reclaimed).not.toContain("ws-old-leased");
      expect(syncFs.existsSync(wsActiveHandle.hostPath)).toBe(true);

      // True orphan without active authority IS reclaimed
      expect(reclaimed).toContain("ws-true-orphan");
      expect(syncFs.existsSync(orphanDir)).toBe(false);
    });
  });

  // =========================================================================
  // 2. Stale Worker Fencing & Race Conditions
  // =========================================================================
  describe("2. Stale Worker Fencing & Race Defense", () => {
    it("fences stale Worker A from renewing lease, completing, failing, or disposing Workspace B", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock, undefined, workspaceAdapter);

      const task = coordinator.createTask({ title: "echo", inputPayload: { x: 1 } });
      createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      // Register workers
      coordinator.registerWorker({
        workerId: "worker-a",
        hostname: "localhost",
        pid: process.pid,
        status: "ACTIVE",
        lastHeartbeatAt: clock.nowIso(),
        createdAt: clock.nowIso(),
      });
      coordinator.registerWorker({
        workerId: "worker-b",
        hostname: "localhost",
        pid: process.pid,
        status: "ACTIVE",
        lastHeartbeatAt: clock.nowIso(),
        createdAt: clock.nowIso(),
      });

      // Worker A claims Run with short lease
      const claimA = coordinator.claimRun(run.runId, "worker-a", 1000);
      coordinator.startRun(run.runId, "worker-a", claimA.lease.leaseId);

      const wsA = await workspaceAdapter.provisionWorkspace({
        workspaceId: "ws-worker-a",
        runId: run.runId,
        taskId: task.taskId,
        maxWorkspaceBytes: 50 * 1024 * 1024,
        maxFileSizeBytes: 5 * 1024 * 1024,
      });

      coordinator.recordWorkspaceEvent(
        {
          eventId: crypto.randomUUID(),
          runId: run.runId,
          timestamp: clock.nowIso(),
          eventType: "workspace.ready",
          schemaVersion: 1,
          producer: "worker-a",
          payload: {
            workspaceId: wsA.workspaceId,
            runId: run.runId,
            hostPath: wsA.hostPath,
          },
        },
        { workerId: "worker-a", leaseId: claimA.lease.leaseId }
      );

      // Worker A crashes / lease expires
      clock.tick(5000);

      // Sweeper recovers expired run
      const recovery = coordinator.recoverExpiredRuns();
      expect(recovery.recoveredCount).toBe(1);
      expect(recovery.runs[0]!.status).toBe("QUEUED");

      // Sweeper cleaned Workspace A
      expect(syncFs.existsSync(wsA.hostPath)).toBe(false);

      // Worker B claims the recovered run with new lease
      const claimB = coordinator.claimRun(run.runId, "worker-b", 10000);
      coordinator.startRun(run.runId, "worker-b", claimB.lease.leaseId);

      const wsB = await workspaceAdapter.provisionWorkspace({
        workspaceId: "ws-worker-b",
        runId: run.runId,
        taskId: task.taskId,
        maxWorkspaceBytes: 50 * 1024 * 1024,
        maxFileSizeBytes: 5 * 1024 * 1024,
      });
      expect(syncFs.existsSync(wsB.hostPath)).toBe(true);

      // 1. Worker A attempts stale heartbeat (renewLease) -> FENCED
      expect(() => {
        coordinator.renewLease(run.runId, claimA.lease.leaseId, 5000);
      }).toThrow(/Cannot renew lease.*EXPIRED/);

      // 2. Worker A attempts stale completion -> FENCED
      expect(() => {
        coordinator.completeRun(run.runId, "worker-a", claimA.lease.leaseId, { ok: true });
      }).toThrow(LeaseLostError);

      // 3. Worker A attempts stale failure -> FENCED
      expect(() => {
        coordinator.failRun(run.runId, { code: "ERROR" }, "worker-a", claimA.lease.leaseId);
      }).toThrow(LeaseLostError);

      // 4. Worker A attempts stale workspace event emission -> FENCED
      expect(() => {
        coordinator.recordWorkspaceEvent(
          {
            eventId: crypto.randomUUID(),
            runId: run.runId,
            timestamp: clock.nowIso(),
            eventType: "workspace.cleaning",
            schemaVersion: 1,
            producer: "worker-a",
            payload: { workspaceId: "ws-worker-b", runId: run.runId },
          },
          { workerId: "worker-a", leaseId: claimA.lease.leaseId }
        );
      }).toThrow(LeaseLostError);

      // 5. Worker A attempts stale workspace disposal via coordinator -> FENCED
      expect(() => {
        coordinator.disposeRunWorkspace({
          runId: run.runId,
          workerId: "worker-a",
          leaseId: claimA.lease.leaseId,
          workspaceId: "ws-worker-b",
        });
      }).toThrow(LeaseLostError);

      // Invariant: Worker B's Workspace B remains completely intact and unharmed!
      expect(syncFs.existsSync(wsB.hostPath)).toBe(true);
      expect(coordinator.isWorkspaceAuthoritativelyActive("ws-worker-b")).toBe(true);
    });
  });

  // =========================================================================
  // 3. Filesystem Sandbox Isolation, Symlink & Boundary Closure
  // =========================================================================
  describe("3. Filesystem Sandbox Isolation & Path Traversal Closure", () => {
    it("rejects cross-run workspace access", async () => {
      const handleA = await workspaceAdapter.provisionWorkspace({
        workspaceId: "ws-run-alpha",
        runId: "run-alpha",
        taskId: "task-alpha",
        maxWorkspaceBytes: 50 * 1024 * 1024,
        maxFileSizeBytes: 5 * 1024 * 1024,
      });

      const handleB = await workspaceAdapter.provisionWorkspace({
        workspaceId: "ws-run-beta",
        runId: "run-beta",
        taskId: "task-beta",
        maxWorkspaceBytes: 50 * 1024 * 1024,
        maxFileSizeBytes: 5 * 1024 * 1024,
      });

      expect(handleA.workspaceId).not.toBe(handleB.workspaceId);
      expect(handleA.hostPath).not.toBe(handleB.hostPath);

      // Attempt to access Run B from Run A's sandbox boundary
      await expect(
        workspaceAdapter.resolvePath("ws-run-alpha", "../ws-run-beta/data.txt")
      ).rejects.toThrow();
    });

    it("defends against symlink substitution during workspace disposal (unlinks symlink only)", async () => {
      // Create a secret host directory outside the workspace sandbox
      const secretOutsideDir = path.join(os.tmpdir(), `emerald-secret-target-${crypto.randomUUID()}`);
      await fs.mkdir(secretOutsideDir, { recursive: true });
      const secretFile = path.join(secretOutsideDir, "critical_secret.pem");
      await fs.writeFile(secretFile, "TOP_SECRET_CREDENTIALS", "utf8");

      // Replace or create a malicious workspace entry pointing to the secret directory
      const evilWorkspaceId = "ws-symlink-attack";
      const evilSymlinkPath = path.join(testRoot, evilWorkspaceId);
      try {
        syncFs.symlinkSync(secretOutsideDir, evilSymlinkPath, "junction");
      } catch {
        syncFs.symlinkSync(secretOutsideDir, evilSymlinkPath, "dir");
      }

      // Execute disposal on the symlink
      await workspaceAdapter.disposeWorkspace(evilWorkspaceId);

      // The symlink itself should be unlinked
      expect(syncFs.existsSync(evilSymlinkPath)).toBe(false);

      // Invariant: The external target directory and its contents MUST NOT be deleted!
      expect(syncFs.existsSync(secretOutsideDir)).toBe(true);
      expect(syncFs.existsSync(secretFile)).toBe(true);
      expect(await fs.readFile(secretFile, "utf8")).toBe("TOP_SECRET_CREDENTIALS");

      // Clean up secret directory
      await fs.rm(secretOutsideDir, { recursive: true, force: true });
    });

    it("rejects malicious workspace IDs with directory traversal syntax", async () => {
      await expect(
        workspaceAdapter.provisionWorkspace({
          workspaceId: "../../evil-escape",
          runId: "run-1",
          taskId: "task-1",
          maxWorkspaceBytes: 10 * 1024 * 1024,
          maxFileSizeBytes: 1 * 1024 * 1024,
        })
      ).rejects.toThrow(InvalidWorkspaceError);

      await expect(
        workspaceAdapter.disposeWorkspace("../outside")
      ).rejects.toThrow(InvalidWorkspaceError);
    });

    it("rejects symlinks inside workspace that point outside the sandbox boundary", async () => {
      const handle = await workspaceAdapter.provisionWorkspace({
        workspaceId: "ws-symlink-traversal",
        runId: "run-symlink",
        taskId: "task-symlink",
        maxWorkspaceBytes: 50 * 1024 * 1024,
        maxFileSizeBytes: 5 * 1024 * 1024,
      });

      // Create an outside target
      const outsideDir = path.join(os.tmpdir(), `emerald-outside-${crypto.randomUUID()}`);
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(path.join(outsideDir, "secret.txt"), "forbidden", "utf8");

      // Create symlink inside workspace pointing outside
      const symlinkPath = path.join(handle.hostPath, "escape_link");
      try {
        syncFs.symlinkSync(outsideDir, symlinkPath, "junction");
      } catch {
        syncFs.symlinkSync(outsideDir, symlinkPath, "dir");
      }

      // Attempting to resolve a path through the escaping symlink must fail closed
      await expect(
        workspaceAdapter.resolvePath("ws-symlink-traversal", "escape_link/secret.txt")
      ).rejects.toThrow(WorkspacePathOutsideBoundaryError);

      await fs.rm(outsideDir, { recursive: true, force: true });
    });
  });

  // =========================================================================
  // 4. Hardened Recovery Across All Execution Failure Pathways
  // =========================================================================
  describe("4. Terminal Failure Pathways & Guaranteed Workspace Cleanup", () => {
    it("cleans up workspace unconditionally when provider execution throws", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock, undefined, workspaceAdapter);

      class ExplodingProvider implements ExecutionProvider {
  readonly tenantModel = "NONE" as const;
  readonly quiescence = { async quiesceRun(_runId: string) { return { status: "QUIESCENT" as const, stopped: 0 }; } };
        readonly name = "in-process";
        async execute<TInput = unknown, TOutput = unknown>(_request: ExecutionRequest<TInput>): Promise<ExecutionResult<TOutput>> {
          throw new Error("Physical provider daemon crashed");
        }
      }

      const runtime = new WorkerRuntime({
        coordinator,
        clock,
        executionProvider: new ExplodingProvider(),
        workspacePort: workspaceAdapter,
      });

      const task = coordinator.createTask({ title: "echo", inputPayload: { x: 1 } });
      createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      await expect(runtime.runOnce(run.runId)).rejects.toThrow("Physical provider daemon crashed");

      // Verify workspace was cleaned up and no leak occurs
      const rootEntries = await fs.readdir(testRoot);
      expect(rootEntries.filter((e) => e.startsWith("ws-"))).toHaveLength(0);
    });

    it("cleans up workspace and records TIMED_OUT when provider times out", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock, undefined, workspaceAdapter);
      const provider = new TestCountingExecutionProvider("in-process", {
        status: "TIMED_OUT",
        error: { code: "EXECUTION_TIMEOUT", message: "Timeout" },
      });
      const runtime = new WorkerRuntime({
        coordinator,
        clock,
        executionProvider: provider,
        workspacePort: workspaceAdapter,
      });

      const task = coordinator.createTask({ title: "echo", inputPayload: { x: 1 } });
      createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId, timeoutMs: 1000 });
      coordinator.queueRun(run.runId);

      const result = await runtime.runOnce(run.runId);
      expect(result.status).toBe("TIMED_OUT");

      const finalRun = store.getRun(run.runId);
      expect(finalRun?.status).toBe("TIMED_OUT");

      // Verify workspace was cleaned up
      const rootEntries = await fs.readdir(testRoot);
      expect(rootEntries.filter((e) => e.startsWith("ws-"))).toHaveLength(0);
    });

    it("cleans up workspace and records CANCELLED on cancellation", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock, undefined, workspaceAdapter);
      const provider = new TestCountingExecutionProvider("in-process", {
        status: "CANCELLED",
        error: { code: "EXECUTION_CANCELLED", message: "Aborted by supervisor" },
      });
      const runtime = new WorkerRuntime({
        coordinator,
        clock,
        executionProvider: provider,
        workspacePort: workspaceAdapter,
      });

      const task = coordinator.createTask({ title: "echo", inputPayload: { x: 1 } });
      createAndActivateContract(store, task.taskId);

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const result = await runtime.runOnce(run.runId);
      expect(result.status).toBe("CANCELLED");

      const finalRun = store.getRun(run.runId);
      expect(finalRun?.status).toBe("CANCELLED");

      // Verify workspace was cleaned up
      const rootEntries = await fs.readdir(testRoot);
      expect(rootEntries.filter((e) => e.startsWith("ws-"))).toHaveLength(0);
    });

    it("cleans up workspace and fails closed when contract is revoked during execution (never substitutes v2)", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock, undefined, workspaceAdapter);

      const task = coordinator.createTask({ title: "echo", inputPayload: { x: 1 } });
      const contract1 = createAndActivateContract(store, task.taskId, { contractId: "contract-1", version: 1 });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      // Custom provider that revokes v1 and creates an active v2 during execution
      class RevokingProvider implements ExecutionProvider {
  readonly tenantModel = "NONE" as const;
  readonly quiescence = { async quiesceRun(_runId: string) { return { status: "QUIESCENT" as const, stopped: 0 }; } };
        readonly name = "in-process";
        async execute<TInput = unknown, TOutput = unknown>(_request: ExecutionRequest<TInput>): Promise<ExecutionResult<TOutput>> {
          // Revoke v1
          store.revokeContract(contract1.spec.contractId, 1, "Emergency governance revocation mid-execution");

          // Create active v2
          createAndActivateContract(store, task.taskId, { contractId: contract1.spec.contractId, version: 2 });

          return {
            status: "SUCCESS",
            output: { answer: 42 } as TOutput,
            durationMs: 20,
            providerMetadata: { provider: "in-process", exitCode: 0 },
          };
        }
      }

      const runtime = new WorkerRuntime({
        coordinator,
        clock,
        executionProvider: new RevokingProvider(),
        workspacePort: workspaceAdapter,
      });

      const result = await runtime.runOnce(run.runId);
      expect(result.status).toBe("FAILED");
      if (result.status === "FAILED") {
        expect((result.error as any)?.code).toBe("CONTRACT_REVOKED");
      }

      const finalRun = store.getRun(run.runId);
      expect(finalRun?.status).toBe("FAILED");
      // Must still be bound to exact v1, NOT v2
      expect(finalRun?.contractBinding?.version).toBe(1);

      // Workspace cleaned up
      const rootEntries = await fs.readdir(testRoot);
      expect(rootEntries.filter((e) => e.startsWith("ws-"))).toHaveLength(0);
    });
  });

  // =========================================================================
  // 5. Network Posture & Docker Mount Confinement
  // =========================================================================
  describe("5. Network Security Posture & Docker Mount Confinement", () => {
    it("explicitly rejects networkDisabled: false with governance boundary error", () => {
      expect(() => {
        new DockerExecutionProvider({
          networkDisabled: false,
        });
      }).toThrow(/Network access is not available: Phase 3 enforces network = NONE/);
    });

    it("verifies DockerExecutionProvider defaults networkDisabled to true", () => {
      const provider = new DockerExecutionProvider();
      expect(provider.config.networkDisabled).toBe(true);
    });

    it("refuses to mount sensitive host directories in DockerExecutionProvider", async () => {
      const provider = new DockerExecutionProvider();
      const forbiddenPaths = [
        path.parse(process.cwd()).root, // host root
        os.homedir(), // user home
        process.cwd(), // repo cwd
        path.join(os.homedir(), ".ssh"),
        path.join(os.homedir(), ".aws"),
        path.join(os.homedir(), ".docker"),
        "/var/run/docker.sock",
      ];

      for (const forbidden of forbiddenPaths) {
        const result = await provider.execute({
          runId: "mount-test",
          taskId: "task-1",
          operationName: "echo",
          inputPayload: {},
          idempotencyToken: "test",
          attemptNumber: 0,
          timeoutMs: 5000,
          workspace: {
            hostPath: forbidden,
            containerMountPath: "/workspace",
          },
        });

        expect(result.status).toBe("FAILED");
        expect(result.error?.message).toMatch(/Security violation/);
      }
    });

    it("refuses to mount arbitrary containerMountPaths other than /workspace", async () => {
      const provider = new DockerExecutionProvider();
      const result = await provider.execute({
        runId: "mount-test",
        taskId: "task-1",
        operationName: "echo",
        inputPayload: {},
        idempotencyToken: "test",
        attemptNumber: 0,
        timeoutMs: 5000,
        workspace: {
          hostPath: testRoot,
          containerMountPath: "/etc",
        },
      });

      expect(result.status).toBe("FAILED");
      expect(result.error?.message).toMatch(/Security violation: Container mount path must be \/workspace/);
    });
  });
});
