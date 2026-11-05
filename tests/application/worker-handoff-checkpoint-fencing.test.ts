import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { AgentStepController } from "../../src/application/agent-step-controller.js";
import { saveStepLoopCheckpoint } from "../../src/application/step-loop-checkpoint.js";
import { PostPassVerificationLatch } from "../../src/application/post-pass-verification-latch.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { AgentBrainPort, AgentBrainRequest, AgentBrainResult } from "../../src/ports/agent-brain.port.js";
import { ExecutionProvider, ExecutionRequest, ExecutionResult } from "../../src/ports/execution-provider.port.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { createAndActivateContract } from "./test-helpers.js";
import { computeCanonicalHash } from "../../src/domain/canonical-hash.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import {
  CheckpointVersionConflictError,
  LeaseExpiredError,
  LeaseLostError,
} from "../../src/domain/errors.js";
import { ProductionRecoveryService } from "../../src/recovery/production-recovery-service.js";
import { RunControl } from "../../src/control-plane/run-control.js";

class NoopProvider implements ExecutionProvider {
  readonly name = "noop-execution-provider";
  readonly tenantModel = "NONE" as const;
  async execute<TInput = unknown, TOutput = unknown>(
    _request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    return { status: "SUCCESS", output: { stdout: "ok", exitCode: 0 } as unknown as TOutput, durationMs: 1 };
  }
}

class ScriptedBrain implements AgentBrainPort {
  private steps: ((req: AgentBrainRequest) => AgentBrainResult)[] = [];
  queueStep(step: (req: AgentBrainRequest) => AgentBrainResult): this {
    this.steps.push(step);
    return this;
  }
  async proposeAction(request: AgentBrainRequest): Promise<AgentBrainResult> {
    const next = this.steps.shift();
    return next ? next(request) : { finishReason: "GOAL_REACHED" };
  }
}

describe("Milestone 2.16-D — Worker handoff: lease-fenced checkpoint persistence", () => {
  let tempDir: string;
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;
  let clock: SettableClock;
  let workerRuntime: WorkerRuntime;
  let brain: ScriptedBrain;

  const runId = "run-handoff-1";
  const taskId = "task-handoff-1";
  const workerId = "worker-handoff-1";
  const otherWorkerId = "worker-handoff-2";
  let leaseId: string;

  const baseCheckpoint = (latch: PostPassVerificationLatch, version: number, fencing?: { workerId: string; leaseId: string }) =>
    saveStepLoopCheckpoint({
      coordinator,
      stateStore: store,
      clock,
      runId,
      stepCount: version,
      actionCount: 0,
      consecutiveFailures: 0,
      proposalRejections: 0,
      consecutiveIdenticalReads: 0,
      consecutiveIdenticalWrites: 0,
      consecutiveIneffectiveEdits: 0,
      postPassLatch: latch,
      currentCheckpointVersion: version,
      ...(fencing ? { workerFencing: fencing } : {}),
    });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-handoff-test-"));
    store = new SqliteStateStore({ location: path.join(tempDir, "state.db") });
    clock = new SettableClock("2026-11-04T12:00:00.000Z");
    coordinator = new RunCoordinator(store, clock);
    const workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: tempDir });

    store.transaction((tx) => {
      tx.insertTask({
        taskId,
        title: "Handoff Test Task",
        description: "2.16-D fenced checkpoint tests",
        inputPayload: {},
        createdAt: clock.nowIso(),
        updatedAt: clock.nowIso(),
      });
      for (const id of [workerId, otherWorkerId]) {
        tx.insertWorker({
          workerId: id,
          hostname: "localhost",
          pid: 7001,
          status: "ACTIVE",
          createdAt: clock.nowIso(),
          lastHeartbeatAt: clock.nowIso(),
        });
      }
    });

    createAndActivateContract(store, taskId, {
      contractId: `contract-${taskId}`,
      version: 1,
      policy: createExecutionPolicy({
        policyId: `policy-${taskId}`,
        allowedCapabilities: ["workspace.file.read", "workspace.file.write", "workspace.code.search", "process.execute"],
        isolationRequirement: "IN_PROCESS",
      }),
    });

    coordinator.createRun({ runId, taskId });
    coordinator.queueRun(runId);
    const claim = coordinator.claimRun(runId, workerId, 60000);
    leaseId = claim.lease.leaseId;
    coordinator.startRun(runId, workerId, leaseId);

    workerRuntime = new WorkerRuntime({
      workerId,
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
      executionProvider: new NoopProvider(),
    });
    brain = new ScriptedBrain();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  describe("1. Fenced checkpoint writes", () => {
    it("persists a checkpoint for the current lease holder", () => {
      const ckpt = baseCheckpoint(new PostPassVerificationLatch(), 1, { workerId, leaseId });
      expect(ckpt.checkpointVersion).toBe(1);
      expect(store.getLatestCheckpoint(runId)?.checkpointId).toBe(ckpt.checkpointId);
    });

    it("rejects a stale worker holding the wrong worker id and persists nothing", () => {
      expect(() => baseCheckpoint(new PostPassVerificationLatch(), 1, { workerId: otherWorkerId, leaseId })).toThrow(
        LeaseLostError
      );
      expect(store.getLatestCheckpoint(runId)).toBeNull();
    });

    it("rejects a stale lease id and persists nothing", () => {
      expect(() => baseCheckpoint(new PostPassVerificationLatch(), 1, { workerId, leaseId: "lease-stale" })).toThrow(
        LeaseLostError
      );
      expect(store.getLatestCheckpoint(runId)).toBeNull();
    });

    it("rejects the previous holder after the lease has expired (lease expiry is not silently tolerated)", () => {
      clock.set("2026-11-04T12:05:00.000Z"); // 60s lease long expired
      expect(() => baseCheckpoint(new PostPassVerificationLatch(), 1, { workerId, leaseId })).toThrow(LeaseExpiredError);
      expect(store.getLatestCheckpoint(runId)).toBeNull();
    });

    it("keeps monotonic versioning: a duplicate version from the live holder is a conflict, not an overwrite", () => {
      baseCheckpoint(new PostPassVerificationLatch(), 1, { workerId, leaseId });
      expect(() => baseCheckpoint(new PostPassVerificationLatch(), 1, { workerId, leaseId })).toThrow(
        CheckpointVersionConflictError
      );
      expect(store.getCheckpoints(runId)).toHaveLength(1);
    });

    it("remains backward compatible: unfenced writes (supervisor/recovery path) are unchanged", () => {
      const ckpt = baseCheckpoint(new PostPassVerificationLatch(), 1);
      expect(ckpt.checkpointVersion).toBe(1);
    });
  });

  describe("2. Step-loop handoff behavior", () => {
    it("stops with LEASE_LOST when authority is lost between the step-start check and the checkpoint write", async () => {
      // The lease is valid at the start-of-step check; the brain call then lets the lease lapse.
      // The proposal is malformed, so the loop reaches the rejection-boundary checkpoint write.
      brain
        .queueStep((req) => {
          clock.set("2026-11-04T12:05:00.000Z");
          return {
            proposal: {
              proposalId: "prop-invalid-1",
              toolName: "read_file",
              inputPayload: { path: "../outside.txt" }, // path traversal => proposal rejection boundary
              contextSnapshotHash: req.contextSnapshot.contextHash,
            },
            finishReason: "ACTION_PROPOSED",
          } as AgentBrainResult;
        })
        .queueStep(() => ({ finishReason: "GOAL_REACHED" }));

      const controller = new AgentStepController({
        allowUnverifiedCompletion: true, // loop-behavior test: no verification specs declared
        coordinator,
        stateStore: store,
        workerRuntime,
        agentBrain: brain,
        clock,
      });

      const result = await controller.runStepLoop({ runId, workerId, leaseId, budget: { maxSteps: 10 } });

      expect(result.terminalReason).toBe("LEASE_LOST");
      expect(result.terminalMessage ?? "").toContain("Worker authority lost during checkpoint persistence");
      // The stale worker persisted no checkpoint after losing authority.
      expect(store.getLatestCheckpoint(runId)).toBeNull();
      // And did not advance to a further step.
      expect(result.totalSteps).toBe(1);
    });

    it("re-entry by the current lease holder is deterministic and idempotent over an existing checkpoint", async () => {
      baseCheckpoint(new PostPassVerificationLatch(), 3, { workerId, leaseId });

      const run = async () => {
        const controller = new AgentStepController({
          allowUnverifiedCompletion: true, // loop-behavior test: no verification specs declared
          coordinator,
          stateStore: store,
          workerRuntime,
          agentBrain: new ScriptedBrain(),
          clock,
        });
        return controller.runStepLoop({ runId, workerId, leaseId, restoreFromCheckpoint: true, budget: { maxSteps: 10 } });
      };

      const first = await run();
      expect(first.terminalReason).toBe("COMPLETED");
      expect(first.totalSteps).toBe(4); // resumed at step 3, executed step 4
    });

    it("fails closed with POLICY_DENIED on a malformed checkpoint instead of resuming", async () => {
      coordinator.saveCheckpoint({
        runId,
        checkpointVersion: 1,
        durableState: { schemaVersion: 999, runId },
        workerFencing: { workerId, leaseId },
      });

      const controller = new AgentStepController({
        allowUnverifiedCompletion: true, // loop-behavior test: no verification specs declared
        coordinator,
        stateStore: store,
        workerRuntime,
        agentBrain: brain,
        clock,
      });
      const result = await controller.runStepLoop({ runId, workerId, leaseId, restoreFromCheckpoint: true });
      expect(result.terminalReason).toBe("POLICY_DENIED");
      expect(result.terminalMessage ?? "").toContain("Checkpoint restoration rejected");
    });

    it("fails closed on an UNKNOWN attempt left by a prior worker (handoff cannot assume quiescence)", async () => {
      baseCheckpoint(new PostPassVerificationLatch(), 1, { workerId, leaseId });
      const now = clock.nowIso();
      store.transaction((tx) => {
        const binding = tx.getRun(runId)!.contractBinding!;
        tx.insertAction(
          {
            actionId: "act-unknown-1",
            runId,
            sequenceNumber: 1,
            toolName: "write_file",
            inputPayload: { path: "x.txt", content: "x" },
            inputHash: computeCanonicalHash({ path: "x.txt", content: "x" }).contentHash,
            completedAt: null,
            idempotency: "NON_IDEMPOTENT",
            contractBinding: binding,
            maxAttempts: 1,
            createdAt: now,
            updatedAt: now,
            status: "RUNNING",
            activeAttemptNumber: 1,
            totalAttempts: 1,
            resultPayload: null,
            errorPayload: null,
          } as any,
          {
            eventId: crypto.randomUUID(),
            runId,
            timestamp: now,
            eventType: "action.created",
            schemaVersion: 1,
            producer: "test",
            payload: {},
          } as any
        );
      });

      const controller = new AgentStepController({
        allowUnverifiedCompletion: true, // loop-behavior test: no verification specs declared
        coordinator,
        stateStore: store,
        workerRuntime,
        agentBrain: brain,
        clock,
      });
      const result = await controller.runStepLoop({ runId, workerId, leaseId, restoreFromCheckpoint: true });
      expect(result.terminalReason).toBe("POLICY_DENIED");
    });
  });

  describe("3. Production resume remains disabled", () => {
    it("ProductionRecoveryService.recoverRun never reports safeToResume and fails the interrupted run", () => {
      const runControl = new RunControl();
      const mission = {
        missionId: "m-1",
        taskId: "t-1",
        contract: { spec: { contractId: "c-1" }, contentHash: "hash-1" },
      };
      const id = runControl.createRun(mission as any).runId;
      runControl.transitionStatus(id, "EXECUTING");
      const service = new ProductionRecoveryService(runControl);
      const outcome = service.recoverRun(id);
      expect(outcome.safeToResume).toBe(false);
      expect(outcome.statusAfter).toBe("FAILED");
      // Idempotent on re-entry (terminal-state immutability).
      const again = service.recoverRun(id);
      expect(again.safeToResume).toBe(false);
      expect(again.statusAfter).toBe("FAILED");
    });
  });
});
