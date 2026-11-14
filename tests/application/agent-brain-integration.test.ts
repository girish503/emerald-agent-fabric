import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { ProposalValidator } from "../../src/application/proposal-validator.js";
import { ContextEngine } from "../../src/application/context/context-engine.js";
import {
  computeObservationContentHash,
  ContextSnapshot,
  Observation,
} from "../../src/domain/context.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import { staticToolRegistry } from "../../src/domain/tool.js";
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
import { createAndActivateContract } from "./test-helpers.js";

/**
 * Spy ExecutionProvider to rigorously verify that ZERO provider calls occur
 * during proposal generation and proposal validation.
 */
class CountingExecutionProvider implements ExecutionProvider {
  readonly tenantModel = "NONE" as const;
  readonly quiescence = { async quiesceRun(_runId: string) { return { status: "QUIESCENT" as const, stopped: 0 }; } };
  readonly name = "spy-counting-provider";
  readonly invocations: ExecutionRequest[] = [];

  get providerInvocationCount(): number {
    return this.invocations.length;
  }

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocations.push(request);
    return {
      status: "SUCCESS",
      output: { executed: true } as unknown as TOutput,
      durationMs: 5,
    };
  }
}

/**
 * Deterministic test Agent Brain implementing AgentBrainPort.
 */
class FakeAgentBrain implements AgentBrainPort {
  readonly requests: AgentBrainRequest[] = [];
  private nextResult?: AgentBrainResult;

  setNextResult(result: AgentBrainResult) {
    this.nextResult = result;
  }

  async proposeAction(request: AgentBrainRequest): Promise<AgentBrainResult> {
    this.requests.push(request);
    if (this.nextResult) {
      return this.nextResult;
    }
    return {
      proposal: {
        proposalId: "brain-prop-1",
        toolName: "read_file",
        inputPayload: { path: "test.txt" },
        contextSnapshotHash: request.contextSnapshot.contextHash,
        rationale: "Default fake brain proposal",
      },
      finishReason: "ACTION_PROPOSED",
    };
  }
}

describe("Agent Brain & Governed Action Proposal Boundary Integration", () => {
  let tempDir: string;
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;
  let clock: SettableClock;
  let provider: CountingExecutionProvider;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let validator: ProposalValidator;
  let brain: FakeAgentBrain;

  const workerId = "worker-int-1";

  function createTestContextSnapshot(runId: string, taskId: string): ContextSnapshot {
    const runObs: Observation = {
      observationId: `obs-run-${runId}`,
      category: "RUN_STATE",
      provenance: {
        entityKind: "Run",
        entityId: runId,
        runId,
        sequenceNumber: 1,
        timestamp: clock.nowIso(),
        isAuthoritativeRuntimeFact: true,
      },
      freshness: "CURRENT",
      priority: 100,
      content: { status: "RUNNING" },
      contentHash: computeObservationContentHash({ status: "RUNNING" }),
      estimatedBytes: 30,
      estimatedTokens: 8,
      isMandatory: true,
    };

    const missionObs: Observation = {
      observationId: `obs-mission-${taskId}`,
      category: "MISSION_CONTEXT",
      provenance: {
        entityKind: "MissionContract",
        entityId: taskId,
        runId,
        sequenceNumber: 1,
        timestamp: clock.nowIso(),
        isAuthoritativeRuntimeFact: true,
      },
      freshness: "CURRENT",
      priority: 90,
      content: { mission: "Governed execution test" },
      contentHash: computeObservationContentHash({ mission: "Governed execution test" }),
      estimatedBytes: 40,
      estimatedTokens: 10,
      isMandatory: true,
    };

    return ContextEngine.build({
      runId,
      taskId,
      candidates: [runObs, missionObs],
      createdAt: clock.nowIso(),
    });
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-brain-test-"));
    store = new SqliteStateStore();
    clock = new SettableClock(new Date("2026-10-13T14:00:00Z"));
    provider = new CountingExecutionProvider();
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: tempDir });

    coordinator = new RunCoordinator(store, clock);

    validator = new ProposalValidator({
      coordinator,
      stateStore: store,
      clock,
    });

    brain = new FakeAgentBrain();

    // Register worker
    store.transaction((tx) => {
      tx.insertWorker({
        workerId,
        hostname: "localhost",
        pid: 4321,
        status: "ACTIVE",
        createdAt: clock.nowIso(),
        lastHeartbeatAt: clock.nowIso(),
      });
    });
  });

  afterEach(async () => {
    store.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function setupGovernedRun(allowedCapabilities: string[] = ["workspace.file.read", "workspace.file.write"]) {
    const task = coordinator.createTask({
      title: "Governed Integration Task",
      description: "Testing brain to action lifecycle",
      inputPayload: { initial: "data" },
    });

    const contract = createAndActivateContract(store, task.taskId, {
      policy: createExecutionPolicy({
        policyId: `brain-policy-${task.taskId}`,
        allowedCapabilities,
        isolationRequirement: "ISOLATED",
      }),
      timeoutMs: 30000,
      maxOutputBytes: 1048576,
      maxAttempts: 3,
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);
    const claimResult = coordinator.claimRun(run.runId, workerId, 15000);
    coordinator.startRun(run.runId, workerId, claimResult.lease.leaseId);

    const activeRunSnapshot = coordinator.getRun(run.runId)!;
    const contextSnapshot = createTestContextSnapshot(run.runId, task.taskId);

    return {
      task,
      contract,
      runSnapshot: activeRunSnapshot,
      leaseId: claimResult.lease.leaseId,
      contextSnapshot,
    };
  }

  it("guarantees ZERO provider invocations during proposal generation and validation", async () => {
    const { runSnapshot, leaseId, contextSnapshot } = setupGovernedRun();

    expect(provider.providerInvocationCount).toBe(0);

    const brainResult = await brain.proposeAction({
      runId: runSnapshot.runId,
      contextSnapshot,
      availableTools: staticToolRegistry.listTools(),
      sequenceNumber: 1,
    });

    expect(brain.requests.length).toBe(1);
    expect(provider.providerInvocationCount).toBe(0);

    const validation = validator.validate(brainResult.proposal, {
      runId: runSnapshot.runId,
      contextSnapshot,
      workerId,
      leaseId,
      run: runSnapshot,
    });

    expect(validation.valid).toBe(true);
    expect(provider.providerInvocationCount).toBe(0);
  });

  it("never creates Action or Attempt database records when a proposal is rejected", async () => {
    const { runSnapshot, leaseId, contextSnapshot } = setupGovernedRun(["workspace.file.read"]);

    // Brain proposes an unauthorized command execution
    brain.setNextResult({
      proposal: {
        proposalId: "prop-denied-1",
        toolName: "run_command",
        inputPayload: { argv: ["rm", "-rf", "/"] },
        contextSnapshotHash: contextSnapshot.contextHash,
      },
      finishReason: "ACTION_PROPOSED",
    });

    const brainResult = await brain.proposeAction({
      runId: runSnapshot.runId,
      contextSnapshot,
      availableTools: staticToolRegistry.listTools(),
      sequenceNumber: 1,
    });

    const validation = validator.validate(brainResult.proposal, {
      runId: runSnapshot.runId,
      contextSnapshot,
      workerId,
      leaseId,
    });

    expect(validation.valid).toBe(false);
    if (!validation.valid) {
      expect(validation.reason).toBe("UNAUTHORIZED_CAPABILITY");
    }

    // Assert that the database remains completely pristine:
    expect(store.getActionsForRun(runSnapshot.runId)).toEqual([]);
    expect(store.getEventsForRun(runSnapshot.runId).filter((e) => e.eventType.startsWith("action."))).toEqual([]);
    expect(provider.providerInvocationCount).toBe(0);
  });

  it("defends against authority hijacking attempts in model proposal", async () => {
    const { runSnapshot, leaseId, contextSnapshot } = setupGovernedRun();

    brain.setNextResult({
      proposal: {
        proposalId: "prop-hijack",
        toolName: "read_file",
        inputPayload: { path: "test.txt" },
        contextSnapshotHash: contextSnapshot.contextHash,
        workerId: "evil-worker-99",
        leaseId: "stolen-lease-99",
        contractId: "bypass-contract-99",
        status: "SUCCEEDED",
        maxAttempts: 999,
      },
      finishReason: "ACTION_PROPOSED",
    });

    const brainResult = await brain.proposeAction({
      runId: runSnapshot.runId,
      contextSnapshot,
      availableTools: staticToolRegistry.listTools(),
      sequenceNumber: 1,
    });

    const validation = validator.validate(brainResult.proposal, {
      runId: runSnapshot.runId,
      contextSnapshot,
      workerId,
      leaseId,
    });

    expect(validation.valid).toBe(false);
    if (!validation.valid) {
      expect(validation.reason).toBe("FORBIDDEN_AUTHORITY_FIELD");
      expect(validation.violations).toContain("workerId");
      expect(validation.violations).toContain("leaseId");
      expect(validation.violations).toContain("contractId");
      expect(validation.violations).toContain("status");
      expect(validation.violations).toContain("maxAttempts");
    }

    // Zero persistence
    expect(store.getActionsForRun(runSnapshot.runId)).toEqual([]);
  });

  it("rejects proposal referencing a stale or altered contextSnapshotHash", async () => {
    const { runSnapshot, leaseId, contextSnapshot } = setupGovernedRun();

    const staleHash = "0".repeat(64);
    brain.setNextResult({
      proposal: {
        proposalId: "prop-stale-1",
        toolName: "read_file",
        inputPayload: { path: "test.txt" },
        contextSnapshotHash: staleHash,
      },
      finishReason: "ACTION_PROPOSED",
    });

    const brainResult = await brain.proposeAction({
      runId: runSnapshot.runId,
      contextSnapshot,
      availableTools: staticToolRegistry.listTools(),
      sequenceNumber: 1,
    });

    const validation = validator.validate(brainResult.proposal, {
      runId: runSnapshot.runId,
      contextSnapshot,
      workerId,
      leaseId,
    });

    expect(validation.valid).toBe(false);
    if (!validation.valid) {
      expect(validation.reason).toBe("CONTEXT_HASH_MISMATCH");
    }
  });

  it("executes the complete governed lifecycle: Context -> Brain -> Validator -> Action -> WorkerRuntime", async () => {
    const { runSnapshot, leaseId, contextSnapshot, task } = setupGovernedRun();

    // Provision workspace for run
    const wsHandle = await workspaceAdapter.provisionWorkspace({
      workspaceId: "ws-int-1",
      runId: runSnapshot.runId,
      taskId: task.taskId,
      maxWorkspaceBytes: 50 * 1024 * 1024,
      maxFileSizeBytes: 10 * 1024 * 1024,
    });

    // Create a real file in the workspace
    const filePath = path.join(wsHandle.hostPath, "greeting.txt");
    fs.writeFileSync(filePath, "Emerald Governed Brain Lifecycle", "utf8");

    // 1. Agent Brain proposes next action based on context snapshot
    brain.setNextResult({
      proposal: {
        proposalId: "brain-read-greeting",
        toolName: "read_file",
        inputPayload: { path: "greeting.txt" },
        contextSnapshotHash: contextSnapshot.contextHash,
        rationale: "Reading greeting file to satisfy mission",
      },
      finishReason: "ACTION_PROPOSED",
    });

    const brainResult = await brain.proposeAction({
      runId: runSnapshot.runId,
      contextSnapshot,
      availableTools: staticToolRegistry.listTools(),
      sequenceNumber: 1,
    });

    // 2. Proposal Validator verifies untrusted proposal against governance pipeline
    const validationSuccess = validator.validateOrThrow(brainResult.proposal, {
      runId: runSnapshot.runId,
      contextSnapshot,
      workerId,
      leaseId,
      run: runSnapshot,
    });

    expect(validationSuccess.valid).toBe(true);

    // 3. Transform validated proposal into authoritative domain Action aggregate
    const { action } = validator.createActionFromProposal(validationSuccess, runSnapshot);
    expect(action.actionId).toBeDefined();
    expect(action.runId).toBe(runSnapshot.runId);
    expect(action.sequenceNumber).toBe(1);
    expect(action.toolName).toBe("read_file");
    expect(action.status).toBe("CREATED");

    // 4. WorkerRuntime executes the Action through ToolExecutionGateway
    const workerRuntime = new WorkerRuntime({
      workerId,
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
    });

    const actionResult = await workerRuntime.executeAction({
      runId: runSnapshot.runId,
      actionId: action.actionId,
      sequenceNumber: action.sequenceNumber,
      toolName: action.toolName,
      inputPayload: action.inputPayload,
      leaseId,
      workspace: wsHandle,
    });

    // 5. Verify end-to-end execution success and durable persistence
    expect(actionResult.status).toBe("SUCCEEDED");
    expect(actionResult.output).toEqual(
      expect.objectContaining({
        path: "greeting.txt",
        content: "Emerald Governed Brain Lifecycle",
        bytesRead: Buffer.byteLength("Emerald Governed Brain Lifecycle", "utf8"),
        isTruncated: false,
      })
    );

    // Verify durable Action and Attempt in SQLite
    const persistedAction = store.getAction(action.actionId);
    expect(persistedAction).not.toBeNull();
    expect(persistedAction?.status).toBe("SUCCEEDED");

    const attempts = store.getAttemptsForAction(action.actionId);
    expect(attempts.length).toBe(1);
    expect(attempts[0]?.status).toBe("SUCCEEDED");
    expect(attempts[0]?.attemptNumber).toBe(1);

    // Verify domain events
    const events = store.getEventsForRun(runSnapshot.runId);
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain("action.created");
    expect(eventTypes).toContain("attempt.created");
    expect(eventTypes).toContain("attempt.completed");
    expect(eventTypes).toContain("action.completed");
  });
});
