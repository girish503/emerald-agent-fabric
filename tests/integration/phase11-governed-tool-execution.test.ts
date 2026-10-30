/**
 * Phase 11 — First Governed Real Tool Execution Path Integration Tests
 *
 * Verifies end-to-end governed tool execution for read-only `git_status` tool:
 * Model Proposal -> ProposalValidator -> Reflex -> Policy -> ToolExecutionGateway -> Physical Tool Execution -> Action/Attempt Persistence -> Observation
 *
 * Required Test Matrix:
 * 1. Test 1 — Governed happy path (Valid git_status proposal -> SUCCESS -> 1 Action, 1 Attempt, physical execution, observation returned)
 * 2. Test 2 — Invalid tool input (Invalid payload -> ProposalValidator rejects -> Gateway NEVER called -> 0 physical executions)
 * 3. Test 3 — Policy denial (Missing git.read capability -> Policy rejects -> Gateway NEVER called -> 0 physical executions)
 * 4. Test 4 — Physical tool failure (Non-git directory -> Gateway/adapter produces controlled tool failure -> Attempt FAILED -> Action FAILED -> error observation)
 * 5. Test 5 — Persistence invariant (1 Action -> 1 Attempt -> 1 physical execution, valid foreign keys and status)
 * 6. Test 6 — Security invariants (Model cannot choose workerId, leaseId, capability, contract authority; cannot bypass policy or gateway)
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import {
  AgentStepController,
  DEFAULT_STEP_CONTROLLER_BUDGET,
} from "../../src/application/agent-step-controller.js";
import { ContextEngine } from "../../src/application/context/context-engine.js";
import { ContextSource } from "../../src/application/context/context-source.js";
import { ProposalValidator } from "../../src/application/proposal-validator.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import { staticToolRegistry } from "../../src/domain/tool.js";
import {
  AgentBrainPort,
  AgentBrainRequest,
  AgentBrainResult,
} from "../../src/ports/agent-brain.port.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { createMockGitRepository } from "../adapters/tools/git-test-helper.js";
import { createAndActivateContract } from "../application/test-helpers.js";

/**
 * Scriptable Agent Brain test double strictly kept inside test boundary.
 */
class ScriptableAgentBrain implements AgentBrainPort {
  readonly requests: AgentBrainRequest[] = [];
  private steps: ((req: AgentBrainRequest) => AgentBrainResult | Promise<AgentBrainResult>)[] = [];

  queueStep(step: (req: AgentBrainRequest) => AgentBrainResult | Promise<AgentBrainResult>): this {
    this.steps.push(step);
    return this;
  }

  async proposeAction(request: AgentBrainRequest): Promise<AgentBrainResult> {
    this.requests.push(request);
    const next = this.steps.shift();
    if (next) {
      return await next(request);
    }
    return {
      finishReason: "GOAL_REACHED",
    };
  }
}

describe("Phase 11 — Governed Real Tool Execution Path Integration", () => {
  let tempBaseDir: string;
  let workspaceRootDir: string;
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;
  let clock: SettableClock;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let workerRuntime: WorkerRuntime;
  let proposalValidator: ProposalValidator;
  let brain: ScriptableAgentBrain;
  let stepController: AgentStepController;
  let initialCommitSha: string;

  const workerId = "worker-phase11-test";
  const leaseTtlMs = 60_000;

  beforeEach(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "emerald-phase11-test-"));
    workspaceRootDir = path.join(tempBaseDir, "workspaces");
    await fs.mkdir(workspaceRootDir, { recursive: true });

    store = new SqliteStateStore();
    clock = new SettableClock(new Date("2026-10-17T12:00:00Z"));
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: workspaceRootDir });
    coordinator = new RunCoordinator(store, clock);

    workerRuntime = new WorkerRuntime({
      workerId,
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
    });

    proposalValidator = new ProposalValidator({
      coordinator,
      stateStore: store,
      toolRegistry: staticToolRegistry,
      clock,
    });

    brain = new ScriptableAgentBrain();

    stepController = new AgentStepController({
      coordinator,
      stateStore: store,
      workerRuntime,
      agentBrain: brain,
      proposalValidator,
      toolRegistry: staticToolRegistry,
      clock,
    });

    // Ensure worker registration in state store
    store.transaction((tx) => {
      tx.insertWorker({
        workerId,
        hostname: "localhost",
        pid: 11111,
        status: "ACTIVE",
        createdAt: clock.nowIso(),
        lastHeartbeatAt: clock.nowIso(),
      });
    });
  });

  afterEach(async () => {
    store.close();
    if (tempBaseDir) {
      await fs.rm(tempBaseDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  interface GovernedSetupOptions {
    allowedCapabilities?: string[];
    initializeGitRepo?: boolean;
    initialFiles?: { path: string; content: string }[];
  }

  async function setupGovernedRun(options: GovernedSetupOptions = {}) {
    const task = coordinator.createTask({
      title: "Inspect Git Repository Status",
      description: "Inspect the current Git repository status using the available tool.",
      inputPayload: { directive: "Inspect Git repository working tree status." },
    });

    const allowedCaps = options.allowedCapabilities ?? [
      "git.read",
      "workspace.file.read",
    ];

    const contract = createAndActivateContract(store, task.taskId, {
      policy: createExecutionPolicy({
        policyId: `policy-${task.taskId}`,
        allowedCapabilities: allowedCaps,
        isolationRequirement: "ISOLATED",
      }),
      timeoutMs: 30000,
      maxOutputBytes: 1048576,
      maxAttempts: 3,
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);
    const claimResult = coordinator.claimRun(run.runId, workerId, leaseTtlMs);
    coordinator.startRun(run.runId, workerId, claimResult.lease.leaseId);

    const ws = await workspaceAdapter.provisionWorkspace({
      workspaceId: `ws-${run.runId}`,
      runId: run.runId,
      taskId: task.taskId,
      maxWorkspaceBytes: 50 * 1024 * 1024,
      maxFileSizeBytes: 10 * 1024 * 1024,
    });

    if (options.initializeGitRepo !== false) {
      const files = options.initialFiles ?? [
        { path: "README.md", content: "# Emerald Phase 11 Test Repo\n" },
        { path: "src/index.ts", content: "console.log('Phase 11');\n" },
      ];
      const repoInfo = await createMockGitRepository(ws.hostPath, files);
      initialCommitSha = repoInfo.commitSha;
    }

    return {
      task,
      contract,
      runId: run.runId,
      leaseId: claimResult.lease.leaseId,
      workspace: ws,
    };
  }

  // =========================================================================
  // Test 1 — Governed happy path
  // =========================================================================
  it("Test 1 — Governed happy path: valid git_status proposal executes physically through gateway with 1 Action and 1 Attempt", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    brain
      .queueStep((req) => ({
        proposal: {
          proposalId: "prop-git-status-1",
          toolName: "git_status",
          inputPayload: { path: "." },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "Step 1: Inspect repository status",
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep(() => ({
        finishReason: "GOAL_REACHED",
      }));

    const result = await stepController.runStepLoop({
      runId,
      leaseId,
      workerId,
      workspace,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 2 },
    });

    // 1. Step loop completed successfully
    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.totalSteps).toBe(2);
    expect(result.totalActions).toBe(1);
    expect(result.totalProposalRejections).toBe(0);

    // 2. Transcript records governed execution
    const step1 = result.transcript[0]!;
    expect(step1.proposalValid).toBe(true);
    expect(step1.toolName).toBe("git_status");
    expect(step1.actionStatus).toBe("SUCCEEDED");
    expect(step1.actionOutput).toBeDefined();

    // 3. Tool actually executed physically on disk
    const toolOutput = step1.actionOutput as any;
    expect(toolOutput.clean).toBe(true);
    expect(toolOutput.currentCommit).toBe(initialCommitSha);
    expect(toolOutput.modified).toEqual([]);
    expect(toolOutput.added).toEqual([]);
    expect(toolOutput.deleted).toEqual([]);
    expect(toolOutput.untracked).toEqual([]);

    // 4. Persistence invariant: Exactly one Action and one Attempt
    const actions = store.getActionsForRun(runId);
    expect(actions).toHaveLength(1);
    const action = actions[0]!;
    expect(action.actionId).toBe(step1.actionId);
    expect(action.toolName).toBe("git_status");
    expect(action.status).toBe("SUCCEEDED");
    expect(action.sequenceNumber).toBe(1);
    expect(action.totalAttempts).toBe(1);

    const attempts = store.getAttemptsForAction(action.actionId);
    expect(attempts).toHaveLength(1);
    const attempt = attempts[0]!;
    expect(attempt.actionId).toBe(action.actionId);
    expect(attempt.runId).toBe(runId);
    expect(attempt.attemptNumber).toBe(1);
    expect(attempt.status).toBe("SUCCEEDED");
    expect(attempt.workerId).toBe(workerId);
    expect(attempt.leaseId).toBe(leaseId);
    expect(attempt.outputPayload).toEqual(toolOutput);
    expect(attempt.durationMs).toBeGreaterThanOrEqual(0);

    // 5. Final observation returned to the runtime
    const contextSource = new ContextSource(store);
    const candidateObs = await contextSource.gatherCandidateObservations(runId);
    const toolResultObs = candidateObs.find((o) => o.category === "TOOL_RESULT");
    expect(toolResultObs).toBeDefined();
    expect(toolResultObs?.content).toMatchObject({
      actionId: action.actionId,
      attemptId: attempt.attemptId,
      toolName: "git_status",
      output: toolOutput,
    });
  });

  // =========================================================================
  // Test 2 — Invalid tool input
  // =========================================================================
  it("Test 2 — Invalid tool input: malformed or invented fields rejected by ProposalValidator, 0 gateway calls, 0 executions", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    brain.queueStep((req) => ({
      proposal: {
        proposalId: "prop-invalid-1",
        toolName: "git_status",
        // Invented fields that violate .strict() closed schema
        inputPayload: { pattern: "*.ts", filePaths: ["src/index.ts"] },
        contextSnapshotHash: req.contextSnapshot.contextHash,
        rationale: "Invented arguments should fail validation closed",
      },
      finishReason: "ACTION_PROPOSED",
    }));

    const result = await stepController.runStepLoop({
      runId,
      leaseId,
      workerId,
      workspace,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 5, maxProposalRejections: 1 },
    });

    // 1. ProposalValidator rejected the proposal
    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");
    expect(result.totalProposalRejections).toBe(1);
    expect(result.totalActions).toBe(0);

    const step1 = result.transcript[0]!;
    expect(step1.proposalValid).toBe(false);
    expect(step1.proposalRejectionReason).toBe("INVALID_TOOL_INPUT");
    expect(step1.proposalRejectionMessage).toMatch(/unrecognized/i);

    // 2. ZERO physical executions or actions persisted
    const actions = store.getActionsForRun(runId);
    expect(actions).toHaveLength(0);
  });

  // =========================================================================
  // Test 3 — Policy denial
  // =========================================================================
  it("Test 3 — Policy denial: valid git_status proposal denied when policy omits git.read capability, 0 gateway dispatches", async () => {
    // Intentionally omit "git.read" from allowed capabilities
    const { runId, leaseId, workspace } = await setupGovernedRun({
      allowedCapabilities: ["workspace.file.read"],
    });

    brain.queueStep((req) => ({
      proposal: {
        proposalId: "prop-denied-1",
        toolName: "git_status",
        inputPayload: { path: "." },
        contextSnapshotHash: req.contextSnapshot.contextHash,
        rationale: "Should be denied by capability policy",
      },
      finishReason: "ACTION_PROPOSED",
    }));

    const result = await stepController.runStepLoop({
      runId,
      leaseId,
      workerId,
      workspace,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 5, maxProposalRejections: 1 },
    });

    // 1. Policy rejection boundary: rejected before gateway
    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");
    expect(result.totalProposalRejections).toBe(1);
    expect(result.totalActions).toBe(0);

    const step1 = result.transcript[0]!;
    expect(step1.proposalValid).toBe(false);
    expect(step1.proposalRejectionReason).toBe("UNAUTHORIZED_CAPABILITY");
    expect(step1.proposalRejectionMessage).toContain("git.read");

    // 2. Gateway never invoked, 0 actions or attempts in DB
    const actions = store.getActionsForRun(runId);
    expect(actions).toHaveLength(0);
  });

  // =========================================================================
  // Test 4 — Physical tool failure
  // =========================================================================
  it("Test 4 — Physical tool failure: non-git workspace produces controlled tool failure, Attempt FAILED, failure preserved in runtime", async () => {
    // Do NOT initialize git repository in the workspace
    const { runId, leaseId, workspace } = await setupGovernedRun({
      initializeGitRepo: false,
    });

    brain
      .queueStep((req) => ({
        proposal: {
          proposalId: "prop-fail-1",
          toolName: "git_status",
          inputPayload: { path: "." },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "Execute git_status on non-git directory to test controlled failure",
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep(() => ({
        finishReason: "GOAL_REACHED",
      }));

    const result = await stepController.runStepLoop({
      runId,
      leaseId,
      workerId,
      workspace,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 2 },
    });

    // 1. Loop recorded the failed action
    expect(result.totalActions).toBe(1);
    const step1 = result.transcript[0]!;
    expect(step1.proposalValid).toBe(true);
    expect(step1.actionStatus).toBe("FAILED");
    expect(step1.actionError).toBeDefined();

    const err = step1.actionError as any;
    expect(err.code).toBe("TOOL_EXECUTION_FAILED");
    expect(err.message).toContain("Not a git repository");

    // 2. Persistence invariant: 1 Action -> 1 Attempt, both in FAILED state
    const actions = store.getActionsForRun(runId);
    expect(actions).toHaveLength(1);
    const action = actions[0]!;
    expect(action.status).toBe("FAILED");
    expect(action.totalAttempts).toBe(1);

    const attempts = store.getAttemptsForAction(action.actionId);
    expect(attempts).toHaveLength(1);
    const attempt = attempts[0]!;
    expect(attempt.status).toBe("FAILED");
    expect(attempt.outputPayload).toBeNull();
    expect(attempt.errorPayload).toEqual(err);

    // 3. Observation returned to runtime as TOOL_ERROR
    const contextSource = new ContextSource(store);
    const candidateObs = await contextSource.gatherCandidateObservations(runId);
    const toolErrorObs = candidateObs.find((o) => o.category === "TOOL_ERROR");
    expect(toolErrorObs).toBeDefined();
    expect(toolErrorObs?.content).toMatchObject({
      actionId: action.actionId,
      attemptId: attempt.attemptId,
      toolName: "git_status",
      status: "FAILED",
    });
  });

  // =========================================================================
  // Test 5 — Persistence Invariant: 1 Action -> 1 Attempt -> 1 Physical Execution
  // =========================================================================
  it("Test 5 — Persistence Invariant: exactly 1 Action -> 1 Attempt -> 1 physical execution with relational integrity", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    brain.queueStep((req) => ({
      proposal: {
        proposalId: "prop-persist-1",
        toolName: "git_status",
        inputPayload: { path: "." },
        contextSnapshotHash: req.contextSnapshot.contextHash,
        rationale: "Single execution for persistence invariant audit",
      },
      finishReason: "ACTION_PROPOSED",
    }));

    await stepController.runStepLoop({
      runId,
      leaseId,
      workerId,
      workspace,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 1 },
    });

    const actions = store.getActionsForRun(runId);
    expect(actions).toHaveLength(1);

    const action = actions[0]!;
    expect(action.runId).toBe(runId);
    expect(action.status).toBe("SUCCEEDED");
    expect(action.activeAttemptNumber).toBeNull();
    expect(action.totalAttempts).toBe(1);

    const attempts = store.getAttemptsForAction(action.actionId);
    expect(attempts).toHaveLength(1);

    const attempt = attempts[0]!;
    expect(attempt.actionId).toBe(action.actionId);
    expect(attempt.runId).toBe(runId);
    expect(attempt.attemptNumber).toBe(1);
    expect(attempt.status).toBe("SUCCEEDED");
    expect(attempt.workerId).toBe(workerId);
    expect(attempt.leaseId).toBe(leaseId);
    expect(attempt.idempotencyToken).toBe(`${runId}:${action.actionId}:1`);
  });

  // =========================================================================
  // Test 6 — Security Invariants
  // =========================================================================
  it("Test 6 — Security Invariants: model cannot choose workerId, leaseId, capability, or contract authority", async () => {
    const { runId, leaseId, workspace, contract } = await setupGovernedRun();

    // Adversarial proposal attempting to forge authority fields
    const adversarialProposal = {
      proposalId: "prop-adversarial-1",
      toolName: "git_status" as const,
      inputPayload: { path: "." },
      contextSnapshotHash: "dummy-hash",
      rationale: "Adversarial authority injection attempt",
      // Injected authority fields that the model might try to forge
      workerId: "attacker-worker-666",
      leaseId: "stolen-lease-999",
      requiredCapability: "system.superuser",
      contractId: "forged-contract",
    };

    // The validator strips or rejects untrusted authority fields
    // and binds strictly to the active Run's authoritative context
    const currentRun = store.getRun(runId)!;
    const candidates = await new ContextSource(store).gatherCandidateObservations(runId);
    const contextSnapshot = ContextEngine.build({
      runId,
      taskId: currentRun.taskId,
      candidates,
      createdAt: clock.nowIso(),
    });

    const validationResult = proposalValidator.validate(
      {
        ...adversarialProposal,
        contextSnapshotHash: contextSnapshot.contextHash,
      } as any,
      {
        runId,
        contextSnapshot,
        workerId,
        leaseId,
        run: currentRun,
        contract,
      }
    );

    // 1. ProposalValidator MUST reject untrusted authority fields right at the gate
    expect(validationResult.valid).toBe(false);
    if (!validationResult.valid) {
      expect(validationResult.reason).toBe("FORBIDDEN_AUTHORITY_FIELD");
      expect(validationResult.violations).toEqual(
        expect.arrayContaining(["workerId", "leaseId", "requiredCapability", "contractId"])
      );
    }

    // 2. Now submit a clean valid proposal without authority fields
    const validProposal = {
      proposalId: "prop-valid-clean-1",
      toolName: "git_status" as const,
      inputPayload: { path: "." },
      contextSnapshotHash: contextSnapshot.contextHash,
      rationale: "Clean valid proposal without authority fields",
    };

    const cleanValidationResult = proposalValidator.validate(
      validProposal,
      {
        runId,
        contextSnapshot,
        workerId,
        leaseId,
        run: currentRun,
        contract,
      }
    );
    expect(cleanValidationResult.valid).toBe(true);
    if (!cleanValidationResult.valid) {
      throw new Error("Clean validation must succeed");
    }

    const { action } = proposalValidator.createActionFromProposal(
      cleanValidationResult,
      currentRun,
      { now: clock.nowIso() }
    );

    // Assert authority fields were derived strictly from trusted runtime, NOT the model
    expect((action as any).workerId).toBeUndefined(); // Action aggregate does not store untrusted workerId
    expect(action.contractBinding.contractId).toBe(contract.spec.contractId); // Bound to active contract
    expect(action.contractBinding.version).toBe(contract.spec.version);
    expect(action.contractBinding.contentHash).toBe(contract.contentHash);

    // Execute through worker runtime
    const actionResult = await workerRuntime.executeAction({
      runId,
      actionId: action.actionId,
      sequenceNumber: action.sequenceNumber,
      toolName: action.toolName,
      inputPayload: action.inputPayload,
      leaseId,
      workspace,
    });

    expect(actionResult.status).toBe("SUCCEEDED");

    // Verify Attempt aggregate was bound strictly to trusted workerId and leaseId
    const attempts = store.getAttemptsForAction(action.actionId);
    expect(attempts).toHaveLength(1);
    const attempt = attempts[0]!;
    expect(attempt.workerId).toBe(workerId);
    expect(attempt.workerId).not.toBe("attacker-worker-666");
    expect(attempt.leaseId).toBe(leaseId);
    expect(attempt.leaseId).not.toBe("stolen-lease-999");
  });
});
