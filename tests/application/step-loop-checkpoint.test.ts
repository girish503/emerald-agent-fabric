import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { AgentStepController } from "../../src/application/agent-step-controller.js";
import {
  saveStepLoopCheckpoint,
  reconcileCheckpointWithDurableEvidence,
  validateStepLoopDurableState,
  STEP_LOOP_CHECKPOINT_SCHEMA_VERSION,
  CheckpointSchemaValidationError,
  UncertainAttemptReconciliationError,
  StepLoopDurableState,
} from "../../src/application/step-loop-checkpoint.js";
import { PostPassVerificationLatch } from "../../src/application/post-pass-verification-latch.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import {
  AgentBrainPort,
  AgentBrainRequest,
  AgentBrainResult,
} from "../../src/ports/agent-brain.port.js";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "../../src/ports/execution-provider.port.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { createAndActivateContract } from "./test-helpers.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import { MissionContract } from "../../src/domain/mission-contract.js";
import { PersistedEvent } from "../../src/ports/state-store.port.js";
import { ActionSnapshot } from "../../src/domain/action.js";
import { AttemptSnapshot } from "../../src/domain/attempt.js";
import type { CleanRoomVerificationOutcome } from "../../src/application/clean-room-verifier.js";

class MockExecutionProvider implements ExecutionProvider {
  readonly name = "mock-execution-provider";
  readonly tenantModel = "NONE" as const;
  readonly invocations: ExecutionRequest[] = [];

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocations.push(request);
    return {
      status: "SUCCESS",
      output: { stdout: "ok", exitCode: 0 } as unknown as TOutput,
      durationMs: 5,
    };
  }
}

class ScriptableBrain implements AgentBrainPort {
  private steps: ((req: AgentBrainRequest) => AgentBrainResult | Promise<AgentBrainResult>)[] = [];
  private fallback?: (req: AgentBrainRequest) => AgentBrainResult;

  queueStep(step: (req: AgentBrainRequest) => AgentBrainResult | Promise<AgentBrainResult>): this {
    this.steps.push(step);
    return this;
  }

  setFallback(fallback: (req: AgentBrainRequest) => AgentBrainResult): this {
    this.fallback = fallback;
    return this;
  }

  async proposeAction(request: AgentBrainRequest): Promise<AgentBrainResult> {
    const next = this.steps.shift();
    if (next) {
      return await next(request);
    }
    if (this.fallback) {
      return this.fallback(request);
    }
    return { finishReason: "GOAL_REACHED" };
  }
}

describe("Milestone 2.16-B — Durable Step Loop Checkpoint Integration", () => {
  let tempDir: string;
  let dbPath: string;
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;
  let clock: SettableClock;
  let contract: MissionContract;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let workerRuntime: WorkerRuntime;
  let brain: ScriptableBrain;
  let provider: MockExecutionProvider;

  const runId = "run-ckpt-test-1";
  const taskId = "task-ckpt-test-1";
  const workerId = "worker-ckpt-1";
  let leaseId = "lease-ckpt-1";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-ckpt-test-"));
    dbPath = path.join(tempDir, "state.db");
    store = new SqliteStateStore({ location: dbPath });
    clock = new SettableClock("2026-11-04T12:00:00.000Z");
    coordinator = new RunCoordinator(store, clock);
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: tempDir });
    provider = new MockExecutionProvider();

    // Create a real file in workspace for tool actions
    fs.writeFileSync(path.join(tempDir, "sample.txt"), "initial content\n", "utf8");

    // Initialize task and active contract
    store.transaction((tx) => {
      tx.insertTask({
        taskId,
        title: "Checkpoint Test Task",
        description: "Task for testing 2.16-B checkpoint persistence and reconciliation",
        inputPayload: {},
        createdAt: clock.nowIso(),
        updatedAt: clock.nowIso(),
      });
      tx.insertWorker({
        workerId,
        hostname: "localhost",
        pid: 7777,
        status: "ACTIVE",
        createdAt: clock.nowIso(),
        lastHeartbeatAt: clock.nowIso(),
      });
    });

    contract = createAndActivateContract(store, taskId, {
      contractId: `contract-${taskId}`,
      version: 1,
      policy: createExecutionPolicy({
        policyId: `policy-${taskId}`,
        allowedCapabilities: [
          "workspace.file.read",
          "workspace.file.write",
          "workspace.code.search",
          "process.execute",
        ],
        isolationRequirement: "IN_PROCESS",
      }),
    });

    // Create run, queue, claim, and start
    coordinator.createRun({
      runId,
      taskId,
    });
    coordinator.queueRun(runId);
    const claim = coordinator.claimRun(runId, workerId, 60000);
    leaseId = claim.lease.leaseId;
    coordinator.startRun(runId, workerId, leaseId);

    workerRuntime = new WorkerRuntime({
      workerId,
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
      executionProvider: provider,
    });

    brain = new ScriptableBrain();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  // ==========================================================================
  // Category 1: Checkpoint Save and Reload
  // ==========================================================================
  describe("1. Checkpoint save and reload", () => {
    it("persists a valid MissionCheckpoint in database with monotonic versioning", () => {
      const latch = new PostPassVerificationLatch();
      latch.activate({
        stepNumber: 1,
        timestamp: clock.nowIso(),
        protectedPath: "src/fix.ts",
        f2pExitCode: 0,
        p2pExitCode: 0,
      });

      const ckpt1 = saveStepLoopCheckpoint({
        coordinator,
        stateStore: store,
        clock,
        runId,
        stepCount: 1,
        actionCount: 1,
        consecutiveFailures: 0,
        proposalRejections: 0,
        consecutiveIdenticalReads: 0,
        consecutiveIdenticalWrites: 0,
        consecutiveIneffectiveEdits: 0,
        postPassLatch: latch,
        lastActionId: null,
        lastAttemptNumber: null,
        currentCheckpointVersion: 1,
      });

      expect(ckpt1.checkpointVersion).toBe(1);
      expect(ckpt1.runId).toBe(runId);

      const latest = store.getLatestCheckpoint(runId);
      expect(latest).not.toBeNull();
      expect(latest?.checkpointId).toBe(ckpt1.checkpointId);
      expect(latest?.checkpointVersion).toBe(1);

      const dState = latest?.durableState as unknown as StepLoopDurableState;
      expect(dState.schemaVersion).toBe(STEP_LOOP_CHECKPOINT_SCHEMA_VERSION);
      expect(dState.stepCount).toBe(1);
      expect(dState.actionCount).toBe(1);
      expect(dState.postPassLatchSnapshot?.isLatched).toBe(true);
      expect(dState.postPassLatchSnapshot?.protectedPaths).toEqual(["src/fix.ts"]);

      // Monotonic step 2 checkpoint
      const ckpt2 = saveStepLoopCheckpoint({
        coordinator,
        stateStore: store,
        clock,
        runId,
        stepCount: 2,
        actionCount: 2,
        consecutiveFailures: 0,
        proposalRejections: 0,
        consecutiveIdenticalReads: 0,
        consecutiveIdenticalWrites: 0,
        consecutiveIneffectiveEdits: 0,
        postPassLatch: latch,
        lastActionId: null,
        lastAttemptNumber: null,
        currentCheckpointVersion: 2,
      });

      expect(ckpt2.checkpointVersion).toBe(2);
      const latest2 = store.getLatestCheckpoint(runId);
      expect(latest2?.checkpointVersion).toBe(2);
    });

    it("round-trips durableState cleanly through validation without data loss", () => {
      const latch = new PostPassVerificationLatch();
      latch.activate({
        stepNumber: 3,
        timestamp: clock.nowIso(),
        protectedPath: "lib/engine.ts",
        f2pExitCode: 0,
        p2pExitCode: 0,
      });
      latch.recordCleanRoomResult({
        status: "VERIFIED",
        message: "Dual gate passed",
      } as unknown as CleanRoomVerificationOutcome);

      saveStepLoopCheckpoint({
        coordinator,
        stateStore: store,
        clock,
        runId,
        stepCount: 5,
        actionCount: 4,
        consecutiveFailures: 1,
        proposalRejections: 1,
        consecutiveIdenticalReads: 2,
        consecutiveIdenticalWrites: 1,
        consecutiveIneffectiveEdits: 1,
        postPassLatch: latch,
        lastActionId: "act-123",
        lastAttemptNumber: 1,
        currentCheckpointVersion: 1,
      });

      const loaded = store.getLatestCheckpoint(runId);
      expect(loaded).not.toBeNull();

      const validated = validateStepLoopDurableState(loaded!.durableState, runId);
      expect(validated.stepCount).toBe(5);
      expect(validated.actionCount).toBe(4);
      expect(validated.consecutiveFailures).toBe(1);
      expect(validated.proposalRejections).toBe(1);
      expect(validated.consecutiveIdenticalReads).toBe(2);
      expect(validated.consecutiveIdenticalWrites).toBe(1);
      expect(validated.consecutiveIneffectiveEdits).toBe(1);
      expect(validated.lastActionId).toBe("act-123");
      expect(validated.postPassLatchSnapshot?.cleanRoomVerified).toBe(true);
      expect(validated.postPassLatchSnapshot?.cleanRoomStatus).toBe("VERIFIED");
    });
  });

  // ==========================================================================
  // Category 2: Invalid and Unsupported Checkpoint Schemas
  // ==========================================================================
  describe("2. Invalid and unsupported checkpoint schemas", () => {
    it("fails closed on missing or unsupported schemaVersion", () => {
      expect(() => {
        validateStepLoopDurableState({ schemaVersion: 2, runId, stepCount: 1, actionCount: 1 }, runId);
      }).toThrow(CheckpointSchemaValidationError);

      expect(() => {
        validateStepLoopDurableState({ runId, stepCount: 1, actionCount: 1 }, runId);
      }).toThrow(CheckpointSchemaValidationError);
    });

    it("fails closed on runId mismatch", () => {
      expect(() => {
        validateStepLoopDurableState(
          {
            schemaVersion: 1,
            runId: "wrong-run-id",
            stepCount: 1,
            actionCount: 1,
            consecutiveFailures: 0,
            proposalRejections: 0,
            consecutiveIdenticalReads: 0,
            consecutiveIdenticalWrites: 0,
            consecutiveIneffectiveEdits: 0,
          },
          runId
        );
      }).toThrow(CheckpointSchemaValidationError);
    });

    it("fails closed on negative or non-integer counters", () => {
      const baseValid = {
        schemaVersion: 1,
        runId,
        stepCount: 1,
        actionCount: 1,
        consecutiveFailures: 0,
        proposalRejections: 0,
        consecutiveIdenticalReads: 0,
        consecutiveIdenticalWrites: 0,
        consecutiveIneffectiveEdits: 0,
      };

      expect(() => {
        validateStepLoopDurableState({ ...baseValid, stepCount: -1 }, runId);
      }).toThrow(CheckpointSchemaValidationError);

      expect(() => {
        validateStepLoopDurableState({ ...baseValid, actionCount: 1.5 }, runId);
      }).toThrow(CheckpointSchemaValidationError);
    });

    it("fails closed on contradictory cross-counter states", () => {
      const base = {
        schemaVersion: 1,
        runId,
        consecutiveIdenticalReads: 0,
        consecutiveIdenticalWrites: 0,
        consecutiveIneffectiveEdits: 0,
      };

      // actionCount > stepCount is impossible
      expect(() => {
        validateStepLoopDurableState(
          { ...base, stepCount: 2, actionCount: 5, consecutiveFailures: 0, proposalRejections: 0 },
          runId
        );
      }).toThrow(/actionCount.*cannot exceed stepCount/);

      // consecutiveFailures > actionCount is impossible
      expect(() => {
        validateStepLoopDurableState(
          { ...base, stepCount: 5, actionCount: 2, consecutiveFailures: 4, proposalRejections: 0 },
          runId
        );
      }).toThrow(/consecutiveFailures.*cannot exceed actionCount/);

      // proposalRejections > stepCount is impossible
      expect(() => {
        validateStepLoopDurableState(
          { ...base, stepCount: 2, actionCount: 1, consecutiveFailures: 0, proposalRejections: 5 },
          runId
        );
      }).toThrow(/proposalRejections.*cannot exceed stepCount/);
    });

    it("fails closed on corrupted postPassLatchSnapshot", () => {
      expect(() => {
        validateStepLoopDurableState(
          {
            schemaVersion: 1,
            runId,
            stepCount: 2,
            actionCount: 1,
            consecutiveFailures: 0,
            proposalRejections: 0,
            consecutiveIdenticalReads: 0,
            consecutiveIdenticalWrites: 0,
            consecutiveIneffectiveEdits: 0,
            postPassLatchSnapshot: {
              // Contradictory: latched is true but activationEvent is missing
              schemaVersion: 1,
              isLatched: true,
              protectedPaths: ["src/a.ts"],
            },
          },
          runId
        );
      }).toThrow(CheckpointSchemaValidationError);
    });
  });

  // ==========================================================================
  // Category 3: Restoration of Counters and Verification-Latch State
  // ==========================================================================
  describe("3. Restoration of counters and verification-latch state", () => {
    it("reconciles counters and restores latch state accurately", () => {
      const act1: ActionSnapshot = {
        actionId: "act-p3-1",
        runId,
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: { path: "sample.txt" },
        inputHash: "hash-1",
        idempotency: "IDEMPOTENT",
        contractBinding: {
          contractId: contract.spec.contractId,
          version: contract.spec.version,
          contentHash: contract.contentHash,
        },
        maxAttempts: 3,
        createdAt: clock.nowIso(),
        updatedAt: clock.nowIso(),
        completedAt: clock.nowIso(),
        status: "SUCCEEDED",
        activeAttemptNumber: null,
        totalAttempts: 1,
        resultPayload: {},
        errorPayload: null,
      };
      const act2: ActionSnapshot = {
        ...act1,
        actionId: "act-p3-2",
        sequenceNumber: 2,
      };
      const actions = [act1, act2];

      const latch = new PostPassVerificationLatch();
      latch.activate({
        stepNumber: 2,
        timestamp: clock.nowIso(),
        protectedPath: "src/fix.ts",
        f2pExitCode: 0,
        p2pExitCode: 0,
      });

      const ckpt = saveStepLoopCheckpoint({
        coordinator,
        stateStore: store,
        clock,
        runId,
        stepCount: 4,
        actionCount: 2,
        consecutiveFailures: 1,
        proposalRejections: 2,
        consecutiveIdenticalReads: 1,
        consecutiveIdenticalWrites: 1,
        consecutiveIneffectiveEdits: 1,
        postPassLatch: latch,
        lastActionId: "act-p3-2",
        currentCheckpointVersion: 1,
      });

      const runSnapshot = store.getRun(runId)!;
      const events = store.getEventsForRun(runId);

      const reconciled = reconcileCheckpointWithDurableEvidence({
        checkpoint: ckpt,
        runSnapshot,
        contract,
        actions,
        events,
        clock,
      });

      expect(reconciled.status).toBe("READY");
      expect(reconciled.durableState.stepCount).toBe(4);
      expect(reconciled.durableState.actionCount).toBe(2);
      expect(reconciled.durableState.proposalRejections).toBe(2);

      // Restore into fresh latch
      const restoredLatch = new PostPassVerificationLatch();
      restoredLatch.restoreFromSnapshot(reconciled.durableState.postPassLatchSnapshot!);
      expect(restoredLatch.isLatched).toBe(true);
      expect(restoredLatch.cleanRoomVerified).toBe(false);
      expect(restoredLatch.protectedPaths).toEqual(["src/fix.ts"]);
    });

    it("restores state seamlessly inside AgentStepController on startup", async () => {
      // 1. Manually insert a checkpoint representing an interrupted execution at step 3
      const latch = new PostPassVerificationLatch();
      latch.activate({
        stepNumber: 2,
        timestamp: clock.nowIso(),
        protectedPath: "src/fix.ts",
        f2pExitCode: 0,
        p2pExitCode: 0,
      });

      saveStepLoopCheckpoint({
        coordinator,
        stateStore: store,
        clock,
        runId,
        stepCount: 3,
        actionCount: 0,
        consecutiveFailures: 0,
        proposalRejections: 1,
        consecutiveIdenticalReads: 0,
        consecutiveIdenticalWrites: 0,
        consecutiveIneffectiveEdits: 0,
        postPassLatch: latch,
        currentCheckpointVersion: 1,
      });

      // 2. Initialize step controller
      brain.setFallback(() => ({ finishReason: "GOAL_REACHED" }));
      const controller = new AgentStepController({
        allowUnverifiedCompletion: true, // loop-behavior test: no verification specs declared
        coordinator,
        stateStore: store,
        workerRuntime,
        agentBrain: brain,
        clock,
      });

      // 3. Run step loop: it restores checkpoint, sees GOAL_REACHED at step 4, and exits
      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        restoreFromCheckpoint: true,
        budget: { maxSteps: 10 },
      });

      expect(result.terminalReason).toBe("COMPLETED");
      // Resumed from step 3: executed step 4
      expect(result.totalSteps).toBe(4);
      expect(result.totalActions).toBe(0);
      expect(result.totalProposalRejections).toBe(1);
      // Latch snapshot preserved
      expect(result.postPassLatchSnapshot?.isLatched).toBe(true);
      expect(result.postPassLatchSnapshot?.protectedPaths).toEqual(["src/fix.ts"]);
    });
  });

  // ==========================================================================
  // Category 4: Crash/Re-entry Boundaries Around Checkpoint Creation
  // ==========================================================================
  describe("4. Crash/re-entry boundaries around checkpoint creation", () => {
    it("safely reconciles when an action completed durably before crash but before checkpoint save", () => {
      const action: ActionSnapshot = {
        actionId: "act-crash-1",
        runId,
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: { path: "sample.txt" },
        inputHash: "hash-crash-1",
        idempotency: "IDEMPOTENT",
        contractBinding: {
          contractId: contract.spec.contractId,
          version: contract.spec.version,
          contentHash: contract.contentHash,
        },
        maxAttempts: 3,
        createdAt: clock.nowIso(),
        updatedAt: clock.nowIso(),
        completedAt: clock.nowIso(),
        status: "SUCCEEDED",
        activeAttemptNumber: null,
        totalAttempts: 1,
        resultPayload: {},
        errorPayload: null,
      };
      const actions = [action];

      // Checkpoint was saved before act-crash-1 completed (actionCount: 0)
      const latch = new PostPassVerificationLatch();
      const ckpt = coordinator.saveCheckpoint({
        runId,
        checkpointVersion: 1,
        eventSequence: 1,
        durableState: {
          schemaVersion: 1,
          runId,
          stepCount: 1,
          actionCount: 0,
          consecutiveFailures: 0,
          proposalRejections: 0,
          consecutiveIdenticalReads: 0,
          consecutiveIdenticalWrites: 0,
          consecutiveIneffectiveEdits: 0,
          postPassLatchSnapshot: latch.getSnapshot(),
        },
      });

      const runSnapshot = store.getRun(runId)!;
      const events = store.getEventsForRun(runId);

      const reconciled = reconcileCheckpointWithDurableEvidence({
        checkpoint: ckpt,
        runSnapshot,
        contract,
        actions,
        events,
        clock,
      });

      // Reconciled action count detects that action 1 completed cleanly, so reconciledActionCount = 1
      expect(reconciled.status).toBe("READY");
      expect(reconciled.reconciledActionCount).toBe(1);
    });
  });

  // ==========================================================================
  // Category 5: Reconciliation with Completed, Missing, or Uncertain Attempts
  // ==========================================================================
  describe("5. Reconciliation with completed, missing, or uncertain attempts", () => {
    it("fails closed with UncertainAttemptReconciliationError on UNKNOWN attempt", () => {
      const latch = new PostPassVerificationLatch();
      const ckpt = coordinator.saveCheckpoint({
        runId,
        checkpointVersion: 1,
        eventSequence: 1,
        durableState: {
          schemaVersion: 1,
          runId,
          stepCount: 1,
          actionCount: 0,
          consecutiveFailures: 0,
          proposalRejections: 0,
          consecutiveIdenticalReads: 0,
          consecutiveIdenticalWrites: 0,
          consecutiveIneffectiveEdits: 0,
          postPassLatchSnapshot: latch.getSnapshot(),
        },
      });

      const attemptSnapshot: AttemptSnapshot = {
        attemptId: "att-unknown-1",
        actionId: "act-1",
        runId,
        attemptNumber: 1,
        workerId,
        leaseId,
        idempotencyToken: "tok-1",
        status: "UNKNOWN" as const,
        startedAt: clock.nowIso(),
        completedAt: clock.nowIso(),
        outputPayload: null,
        errorPayload: { message: "lost connection" },
        durationMs: 10,
        exitCode: null,
        evidenceIds: [],
      };

      expect(() => {
        reconcileCheckpointWithDurableEvidence({
          checkpoint: ckpt,
          runSnapshot: store.getRun(runId)!,
          contract,
          actions: [],
          attempts: [attemptSnapshot],
          events: [],
          clock,
        });
      }).toThrow(UncertainAttemptReconciliationError);
    });

    it("fails closed with UncertainAttemptReconciliationError on RUNNING/DISPATCHED attempt", () => {
      const latch = new PostPassVerificationLatch();
      const ckpt = coordinator.saveCheckpoint({
        runId,
        checkpointVersion: 1,
        eventSequence: 1,
        durableState: {
          schemaVersion: 1,
          runId,
          stepCount: 1,
          actionCount: 0,
          consecutiveFailures: 0,
          proposalRejections: 0,
          consecutiveIdenticalReads: 0,
          consecutiveIdenticalWrites: 0,
          consecutiveIneffectiveEdits: 0,
          postPassLatchSnapshot: latch.getSnapshot(),
        },
      });

      const attemptSnapshot: AttemptSnapshot = {
        attemptId: "att-running-1",
        actionId: "act-1",
        runId,
        attemptNumber: 1,
        workerId,
        leaseId,
        idempotencyToken: "tok-1",
        status: "RUNNING" as const,
        startedAt: clock.nowIso(),
        completedAt: null,
        outputPayload: null,
        errorPayload: null,
        durationMs: 0,
        exitCode: null,
        evidenceIds: [],
      };

      expect(() => {
        reconcileCheckpointWithDurableEvidence({
          checkpoint: ckpt,
          runSnapshot: store.getRun(runId)!,
          contract,
          actions: [],
          attempts: [attemptSnapshot],
          events: [],
          clock,
        });
      }).toThrow(UncertainAttemptReconciliationError);
    });

    it("fails closed when checkpoint claims more actions than exist in durable storage", () => {
      const latch = new PostPassVerificationLatch();
      const ckpt = saveStepLoopCheckpoint({
        coordinator,
        stateStore: store,
        clock,
        runId,
        stepCount: 3,
        actionCount: 3,
        consecutiveFailures: 0,
        proposalRejections: 0,
        consecutiveIdenticalReads: 0,
        consecutiveIdenticalWrites: 0,
        consecutiveIneffectiveEdits: 0,
        postPassLatch: latch,
        currentCheckpointVersion: 1,
      });

      expect(() => {
        reconcileCheckpointWithDurableEvidence({
          checkpoint: ckpt,
          runSnapshot: store.getRun(runId)!,
          contract,
          actions: [], // 0 actions in DB, checkpoint claims 3
          events: [],
          clock,
        });
      }).toThrow(/claims actionCount=3, but only 0 durable actions exist/);
    });

    it("fails closed when bound contract is REVOKED", () => {
      const latch = new PostPassVerificationLatch();
      const ckpt = coordinator.saveCheckpoint({
        runId,
        checkpointVersion: 1,
        eventSequence: 1,
        durableState: {
          schemaVersion: 1,
          runId,
          stepCount: 1,
          actionCount: 0,
          consecutiveFailures: 0,
          proposalRejections: 0,
          consecutiveIdenticalReads: 0,
          consecutiveIdenticalWrites: 0,
          consecutiveIneffectiveEdits: 0,
          postPassLatchSnapshot: latch.getSnapshot(),
        },
      });

      // Revoke the contract
      store.revokeContract(contract.spec.contractId, contract.spec.version, "Test revocation");
      const revokedContract = store.getContract(contract.spec.contractId, contract.spec.version)!;

      expect(() => {
        reconcileCheckpointWithDurableEvidence({
          checkpoint: ckpt,
          runSnapshot: store.getRun(runId)!,
          contract: revokedContract,
          actions: [],
          events: [],
          clock,
        });
      }).toThrow(/is not ACTIVE \(current status: 'REVOKED'\)/);
    });
  });

  // ==========================================================================
  // Category 6: Preventing Duplicate Action Execution After Restoration
  // ==========================================================================
  describe("6. Preventing duplicate action execution after restoration", () => {
    it("ensures subsequent action receives next sequenceNumber and doesn't duplicate prior actions", async () => {
      // First run: execute step 1 proposing a read_file action
      brain.queueStep((req) => ({
        finishReason: "ACTION_PROPOSED",
        proposal: {
          proposalId: "prop-1",
          toolName: "read_file",
          inputPayload: { path: "sample.txt" },
          rationale: "Read sample file",
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
      }));

      const controller1 = new AgentStepController({
        allowUnverifiedCompletion: true, // loop-behavior test: no verification specs declared
        coordinator,
        stateStore: store,
        workerRuntime,
        agentBrain: brain,
        clock,
      });

      const res1 = await controller1.runStepLoop({
        runId,
        workerId,
        leaseId,
        workspace: { workspaceId: `ws-${runId}`, hostPath: tempDir },
        budget: { maxSteps: 1 },
      });

      expect(res1.terminalReason).toBe("MAX_STEPS");
      expect(res1.totalSteps).toBe(1);
      expect(res1.totalActions).toBe(1);

      // Checkpoint was saved automatically at step 1 boundary
      const ckpt1 = store.getLatestCheckpoint(runId);
      expect(ckpt1).not.toBeNull();
      expect(ckpt1?.checkpointVersion).toBe(1);

      // Actions in DB: 1 action with sequenceNumber 1
      const dbActions = store.getActionsForRun(runId);
      expect(dbActions.length).toBe(1);
      expect(dbActions[0]!.sequenceNumber).toBe(1);

      // Second run: resume from checkpoint and execute step 2
      const brain2 = new ScriptableBrain();
      brain2.queueStep((req) => ({
        finishReason: "ACTION_PROPOSED",
        proposal: {
          proposalId: "prop-2",
          toolName: "read_file",
          inputPayload: { path: "sample.txt" },
          rationale: "Read sample file again",
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
      }));

      const controller2 = new AgentStepController({
        allowUnverifiedCompletion: true, // loop-behavior test: no verification specs declared
        coordinator,
        stateStore: store,
        workerRuntime,
        agentBrain: brain2,
        clock,
      });

      const res2 = await controller2.runStepLoop({
        runId,
        workerId,
        leaseId,
        workspace: { workspaceId: `ws-${runId}`, hostPath: tempDir },
        restoreFromCheckpoint: true,
        budget: { maxSteps: 2 },
      });

      expect(res2.terminalReason).toBe("MAX_STEPS");
      expect(res2.totalSteps).toBe(2);
      expect(res2.totalActions).toBe(2);

      // Actions in DB: now 2 actions with sequences 1 and 2 (no duplicate action created)
      const dbActionsAfter = store.getActionsForRun(runId);
      expect(dbActionsAfter.length).toBe(2);
      expect(dbActionsAfter[0]!.sequenceNumber).toBe(1);
      expect(dbActionsAfter[1]!.sequenceNumber).toBe(2);
    });
  });

  // ==========================================================================
  // Category 7: Scenario 12 Compatibility
  // ==========================================================================
  describe("7. Scenario 12 compatibility", () => {
    it("terminates with COMPLETED immediately when durable verification evidence exists (Scenario 12)", async () => {
      // 1. Create a checkpoint at step 2
      const latch = new PostPassVerificationLatch();
      saveStepLoopCheckpoint({
        coordinator,
        stateStore: store,
        clock,
        runId,
        stepCount: 2,
        actionCount: 0,
        consecutiveFailures: 0,
        proposalRejections: 0,
        consecutiveIdenticalReads: 0,
        consecutiveIdenticalWrites: 0,
        consecutiveIneffectiveEdits: 0,
        postPassLatch: latch,
        currentCheckpointVersion: 1,
      });

      // 2. Append clean_room.verified event to run
      store.transaction((tx) => {
        tx.appendEvent({
          eventId: "evt-clean-room-1",
          runId,
          timestamp: clock.nowIso(),
          eventType: "clean_room.verified",
          schemaVersion: 1,
          producer: "clean_room_verifier",
          payload: {
            runId,
            attemptNumber: 1,
            cleanRoomSpecId: "dual-gate",
            message: "Clean room dual gate passed",
          },
        });
      });

      // 3. Run controller with checkpoint restore
      brain.setFallback(() => {
        throw new Error("Brain must NOT be invoked when run is already verified!");
      });

      const controller = new AgentStepController({
        allowUnverifiedCompletion: true, // loop-behavior test: no verification specs declared
        coordinator,
        stateStore: store,
        workerRuntime,
        agentBrain: brain,
        clock,
      });

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        restoreFromCheckpoint: true,
      });

      expect(result.terminalReason).toBe("COMPLETED");
      expect(result.terminalMessage).toContain("Scenario 12");
    });
  });

  // ==========================================================================
  // Category 8: Fail-Closed Behavior for Conflicting Checkpoint & Event Evidence
  // ==========================================================================
  describe("8. Fail-closed behavior for conflicting checkpoint and event evidence", () => {
    it("fails closed when checkpoint claims verified latch but subsequent event recorded verification rejection", () => {
      // 1. Checkpoint has verified latch snapshot at eventSequence 5
      const latch = new PostPassVerificationLatch();
      latch.activate({
        stepNumber: 2,
        timestamp: clock.nowIso(),
        protectedPath: "src/fix.ts",
        f2pExitCode: 0,
        p2pExitCode: 0,
      });
      latch.recordCleanRoomResult({
        status: "VERIFIED",
        message: "Clean room passed",
      } as unknown as CleanRoomVerificationOutcome);

      const ckpt = coordinator.saveCheckpoint({
        runId,
        checkpointVersion: 1,
        eventSequence: 5,
        durableState: {
          schemaVersion: 1,
          runId,
          stepCount: 2,
          actionCount: 0,
          consecutiveFailures: 0,
          proposalRejections: 0,
          consecutiveIdenticalReads: 0,
          consecutiveIdenticalWrites: 0,
          consecutiveIneffectiveEdits: 0,
          postPassLatchSnapshot: latch.getSnapshot(),
        },
      });

      // 2. Event stream has authoritative clean_room.verified at sequence 5, but subsequent event at sequence 6 rejects verification
      const runEvents: PersistedEvent[] = [
        {
          eventId: "evt-clean-1",
          runId,
          sequence: 5,
          timestamp: clock.nowIso(),
          eventType: "clean_room.verified",
          schemaVersion: 1,
          producer: "clean_room_verifier",
          payload: { runId, attemptNumber: 1, cleanRoomSpecId: "dual-gate" },
        },
        {
          eventId: "evt-rej-1",
          runId,
          sequence: 6,
          timestamp: clock.nowIso(),
          eventType: "verification.rejected",
          schemaVersion: 1,
          producer: "verifier",
          payload: { reason: "Regression discovered" },
        },
      ];

      expect(() => {
        reconcileCheckpointWithDurableEvidence({
          checkpoint: ckpt,
          runSnapshot: store.getRun(runId)!,
          contract,
          actions: [],
          events: runEvents,
          clock,
        });
      }).toThrow(/verification.*reject/i);
    });

    it("fails closed when checkpoint eventSequence exceeds highest durable event sequence", () => {
      const latch = new PostPassVerificationLatch();
      const ckpt = coordinator.saveCheckpoint({
        runId,
        checkpointVersion: 1,
        eventSequence: 999, // Ahead of anything in SQLite
        durableState: {
          schemaVersion: 1,
          runId,
          stepCount: 1,
          actionCount: 0,
          consecutiveFailures: 0,
          proposalRejections: 0,
          consecutiveIdenticalReads: 0,
          consecutiveIdenticalWrites: 0,
          consecutiveIneffectiveEdits: 0,
          postPassLatchSnapshot: latch.getSnapshot(),
        },
      });

      const runEvents: PersistedEvent[] = [
        {
          eventId: "evt-1",
          runId,
          sequence: 1,
          timestamp: clock.nowIso(),
          eventType: "run.created",
          schemaVersion: 1,
          producer: "coordinator",
          payload: {},
        },
      ];

      expect(() => {
        reconcileCheckpointWithDurableEvidence({
          checkpoint: ckpt,
          runSnapshot: store.getRun(runId)!,
          contract,
          actions: [],
          events: runEvents,
          clock,
        });
      }).toThrow(/eventSequence \(999\) exceeds highest durable event sequence/);
    });
  });

  // ==========================================================================
  // Category 9: Milestone 2.16-B.1 Safety Invariants and Boundary Checks
  // ==========================================================================
  describe("9. Milestone 2.16-B.1 Safety Invariants and Boundary Checks", () => {
    it("fails closed when durable actions have sequence gaps or non-monotonic sequence numbers", () => {
      const latch = new PostPassVerificationLatch();
      const ckpt = saveStepLoopCheckpoint({
        coordinator,
        stateStore: store,
        clock,
        runId,
        stepCount: 2,
        actionCount: 2,
        consecutiveFailures: 0,
        proposalRejections: 0,
        consecutiveIdenticalReads: 0,
        consecutiveIdenticalWrites: 0,
        consecutiveIneffectiveEdits: 0,
        postPassLatch: latch,
        lastActionId: "act-gap-2",
        currentCheckpointVersion: 1,
      });

      // Actions with gap: sequence 1 and sequence 3 (missing 2)
      const act1: ActionSnapshot = {
        actionId: "act-gap-1",
        runId,
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: { path: "sample.txt" },
        inputHash: "hash-gap-1",
        idempotency: "IDEMPOTENT",
        contractBinding: {
          contractId: contract.spec.contractId,
          version: contract.spec.version,
          contentHash: contract.contentHash,
        },
        maxAttempts: 3,
        createdAt: clock.nowIso(),
        updatedAt: clock.nowIso(),
        completedAt: clock.nowIso(),
        status: "SUCCEEDED",
        activeAttemptNumber: null,
        totalAttempts: 1,
        resultPayload: {},
        errorPayload: null,
      };
      const act2: ActionSnapshot = {
        ...act1,
        actionId: "act-gap-2",
        sequenceNumber: 3, // Gap: sequenceNumber 3 instead of 2
      };

      expect(() => {
        reconcileCheckpointWithDurableEvidence({
          checkpoint: ckpt,
          runSnapshot: store.getRun(runId)!,
          contract,
          actions: [act1, act2],
          attempts: [],
          events: [],
          clock,
        });
      }).toThrow(/expected 2 \(sequence numbers must be strictly sequential 1\.\.N\)/);
    });

    it("fails closed when checkpoint lastActionId contradicts the action identity at that sequence index", () => {
      const latch = new PostPassVerificationLatch();
      // Checkpoint claims actionCount 2, but lastActionId is "act-seq-1" (the first action, not the second!)
      const ckpt = saveStepLoopCheckpoint({
        coordinator,
        stateStore: store,
        clock,
        runId,
        stepCount: 2,
        actionCount: 2,
        consecutiveFailures: 0,
        proposalRejections: 0,
        consecutiveIdenticalReads: 0,
        consecutiveIdenticalWrites: 0,
        consecutiveIneffectiveEdits: 0,
        postPassLatch: latch,
        lastActionId: "act-seq-1",
        currentCheckpointVersion: 1,
      });

      const act1: ActionSnapshot = {
        actionId: "act-seq-1",
        runId,
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: { path: "sample.txt" },
        inputHash: "hash-seq-1",
        idempotency: "IDEMPOTENT",
        contractBinding: {
          contractId: contract.spec.contractId,
          version: contract.spec.version,
          contentHash: contract.contentHash,
        },
        maxAttempts: 3,
        createdAt: clock.nowIso(),
        updatedAt: clock.nowIso(),
        completedAt: clock.nowIso(),
        status: "SUCCEEDED",
        activeAttemptNumber: null,
        totalAttempts: 1,
        resultPayload: {},
        errorPayload: null,
      };
      const act2: ActionSnapshot = {
        ...act1,
        actionId: "act-seq-2",
        sequenceNumber: 2,
      };

      expect(() => {
        reconcileCheckpointWithDurableEvidence({
          checkpoint: ckpt,
          runSnapshot: store.getRun(runId)!,
          contract,
          actions: [act1, act2],
          attempts: [],
          events: [],
          clock,
        });
      }).toThrow(/does not match durable action at sequence 2/);
    });

    it("fails closed when an attempt is in CREATED status (un-dispatched or interrupted)", () => {
      const latch = new PostPassVerificationLatch();
      const ckpt = coordinator.saveCheckpoint({
        runId,
        checkpointVersion: 1,
        eventSequence: 1,
        durableState: {
          schemaVersion: 1,
          runId,
          stepCount: 1,
          actionCount: 0,
          consecutiveFailures: 0,
          proposalRejections: 0,
          consecutiveIdenticalReads: 0,
          consecutiveIdenticalWrites: 0,
          consecutiveIneffectiveEdits: 0,
          postPassLatchSnapshot: latch.getSnapshot(),
        },
      });

      const attemptSnapshot: AttemptSnapshot = {
        attemptId: "att-created-1",
        actionId: "act-1",
        runId,
        attemptNumber: 1,
        workerId,
        leaseId,
        idempotencyToken: "tok-created-1",
        status: "CREATED",
        startedAt: clock.nowIso(),
        completedAt: null,
        outputPayload: null,
        errorPayload: null,
        durationMs: 0,
        exitCode: null,
        evidenceIds: [],
      };

      expect(() => {
        reconcileCheckpointWithDurableEvidence({
          checkpoint: ckpt,
          runSnapshot: store.getRun(runId)!,
          contract,
          actions: [],
          attempts: [attemptSnapshot],
          events: [],
          clock,
        });
      }).toThrow(UncertainAttemptReconciliationError);
    });

    it("reconciles stepCount and consecutiveFailures when actions completed beyond checkpoint before crash", () => {
      const latch = new PostPassVerificationLatch();
      // Checkpoint was saved at step 1, action 1
      const ckpt = saveStepLoopCheckpoint({
        coordinator,
        stateStore: store,
        clock,
        runId,
        stepCount: 1,
        actionCount: 1,
        consecutiveFailures: 0,
        proposalRejections: 0,
        consecutiveIdenticalReads: 0,
        consecutiveIdenticalWrites: 0,
        consecutiveIneffectiveEdits: 0,
        postPassLatch: latch,
        lastActionId: "act-multi-1",
        currentCheckpointVersion: 1,
      });

      // In SQLite, action 2 and 3 executed before crash; action 2 succeeded, action 3 failed
      const act1: ActionSnapshot = {
        actionId: "act-multi-1",
        runId,
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: { path: "sample.txt" },
        inputHash: "hash-multi-1",
        idempotency: "IDEMPOTENT",
        contractBinding: {
          contractId: contract.spec.contractId,
          version: contract.spec.version,
          contentHash: contract.contentHash,
        },
        maxAttempts: 3,
        createdAt: clock.nowIso(),
        updatedAt: clock.nowIso(),
        completedAt: clock.nowIso(),
        status: "SUCCEEDED",
        activeAttemptNumber: null,
        totalAttempts: 1,
        resultPayload: {},
        errorPayload: null,
      };
      const act2: ActionSnapshot = {
        ...act1,
        actionId: "act-multi-2",
        sequenceNumber: 2,
        status: "SUCCEEDED",
      };
      const act3: ActionSnapshot = {
        ...act1,
        actionId: "act-multi-3",
        sequenceNumber: 3,
        status: "FAILED",
      };

      const reconciled = reconcileCheckpointWithDurableEvidence({
        checkpoint: ckpt,
        runSnapshot: store.getRun(runId)!,
        contract,
        actions: [act1, act2, act3],
        attempts: [],
        events: [],
        clock,
      });

      expect(reconciled.reconciledActionCount).toBe(3);
      // stepCount is raised to match actionCount (preserving actionCount <= stepCount invariant)
      expect(reconciled.reconciledStepCount).toBe(3);
      // consecutiveFailures accounts for subsequent action 3 failure
      expect(reconciled.reconciledConsecutiveFailures).toBe(1);
    });

    it("fails closed when latch claims cleanRoomVerified but no authoritative verification event exists in event history", () => {
      const latch = new PostPassVerificationLatch();
      latch.activate({
        stepNumber: 1,
        timestamp: clock.nowIso(),
        protectedPath: "src/fix.ts",
        f2pExitCode: 0,
        p2pExitCode: 0,
      });
      latch.recordCleanRoomResult({
        status: "VERIFIED",
        message: "Clean room passed",
      } as unknown as CleanRoomVerificationOutcome);

      const ckpt = coordinator.saveCheckpoint({
        runId,
        checkpointVersion: 1,
        eventSequence: 1,
        durableState: {
          schemaVersion: 1,
          runId,
          stepCount: 1,
          actionCount: 0,
          consecutiveFailures: 0,
          proposalRejections: 0,
          consecutiveIdenticalReads: 0,
          consecutiveIdenticalWrites: 0,
          consecutiveIneffectiveEdits: 0,
          postPassLatchSnapshot: latch.getSnapshot(),
        },
      });

      // Event stream only has run.created, NO clean_room.verified event
      const runEvents: PersistedEvent[] = [
        {
          eventId: "evt-1",
          runId,
          sequence: 1,
          timestamp: clock.nowIso(),
          eventType: "run.created",
          schemaVersion: 1,
          producer: "coordinator",
          payload: {},
        },
      ];

      expect(() => {
        reconcileCheckpointWithDurableEvidence({
          checkpoint: ckpt,
          runSnapshot: store.getRun(runId)!,
          contract,
          actions: [],
          events: runEvents,
          clock,
        });
      }).toThrow(/no authoritative verification event exists in durable event history/);
    });

    it("blocks Scenario 12 completion when an uncertain attempt exists even if clean_room.verified event is present", () => {
      const latch = new PostPassVerificationLatch();
      const ckpt = saveStepLoopCheckpoint({
        coordinator,
        stateStore: store,
        clock,
        runId,
        stepCount: 2,
        actionCount: 0,
        consecutiveFailures: 0,
        proposalRejections: 0,
        consecutiveIdenticalReads: 0,
        consecutiveIdenticalWrites: 0,
        consecutiveIneffectiveEdits: 0,
        postPassLatch: latch,
        currentCheckpointVersion: 1,
      });

      const runEvents: PersistedEvent[] = [
        {
          eventId: "evt-clean-1",
          runId,
          sequence: 5,
          timestamp: clock.nowIso(),
          eventType: "clean_room.verified",
          schemaVersion: 1,
          producer: "clean_room_verifier",
          payload: {
            runId,
            attemptNumber: 1,
            cleanRoomSpecId: "dual-gate",
          },
        },
      ];

      // Uncertain attempt present
      const attemptSnapshot: AttemptSnapshot = {
        attemptId: "att-running-blocked",
        actionId: "act-blocked",
        runId,
        attemptNumber: 1,
        workerId,
        leaseId,
        idempotencyToken: "tok-blocked",
        status: "RUNNING",
        startedAt: clock.nowIso(),
        completedAt: null,
        outputPayload: null,
        errorPayload: null,
        durationMs: 0,
        exitCode: null,
        evidenceIds: [],
      };

      expect(() => {
        reconcileCheckpointWithDurableEvidence({
          checkpoint: ckpt,
          runSnapshot: store.getRun(runId)!,
          contract,
          actions: [],
          attempts: [attemptSnapshot],
          events: runEvents,
          clock,
        });
      }).toThrow(UncertainAttemptReconciliationError);
    });
  });
});
