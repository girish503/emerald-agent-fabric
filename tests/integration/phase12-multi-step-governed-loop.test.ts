/**
 * Phase 12 — Multi-Step Governed Agent Loop Integration Tests
 *
 * Verifies that real observations from Step N become context for Step N+1,
 * allowing governed multi-step reasoning, bounded proposal recovery, causal
 * observation flow, loop limits, trajectory persistence, and security invariance.
 *
 * Test Matrix:
 * 1. Test 1 — Observation propagation (Step N observation appears in Step N+1 context)
 * 2. Test 2 — Two-step governed execution (Two valid decisions execute through governance)
 * 3. Test 3 — Causal observation-dependent next decision (Distinctive marker in Step 1 tool observation reaches Step 2)
 * 4. Test 4 — Invalid proposal recovery (Bounded requery after invalid proposal)
 * 5. Test 5 — Invalid proposal causes zero physical execution (No tool dispatch or state mutation for rejected proposal)
 * 6. Test 6 — Goal termination (isGoalReached=true terminates without extra action/attempt)
 * 7. Test 7 — Loop bounds (AgentStepController limits prevent unbounded loops)
 * 8. Test 8 — Multi-step trajectory persistence (Run -> Action 1 -> Attempt 1 -> Action 2 -> Attempt 1)
 * 9. Test 9 — Security invariants across multiple steps (Model cannot forge authority in either step)
 * 10. Test 10 — Cancellation/failure handling (AbortSignal or failure terminates safely without false success)
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

describe("Phase 12 — Multi-Step Governed Agent Loop Integration", () => {
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

  const workerId = "worker-phase12-test";
  const leaseTtlMs = 120_000;

  beforeEach(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "emerald-phase12-test-"));
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
      allowUnverifiedCompletion: true, // loop-behavior test: no verification specs declared
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
        pid: 22222,
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
    initialFiles?: { path: string; content: string }[];
  }

  async function setupGovernedRun(options: GovernedSetupOptions = {}) {
    const task = coordinator.createTask({
      title: "Multi-Step Inspection and Verification",
      description: "Inspect repository status, read files, and report completion.",
      inputPayload: { directive: "Inspect repository and verify contents." },
    });

    const allowedCaps = options.allowedCapabilities ?? [
      "git.read",
      "workspace.file.read",
      "workspace.code.search",
    ];

    const contract = createAndActivateContract(store, task.taskId, {
      policy: createExecutionPolicy({
        policyId: `policy-${task.taskId}`,
        allowedCapabilities: allowedCaps,
        isolationRequirement: "ISOLATED",
      }),
      timeoutMs: 60000,
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

    const files = options.initialFiles ?? [
      { path: "README.md", content: "# Emerald Phase 12\nDeterministic multi-step testing.\n" },
      { path: "src/calculator.ts", content: "export function add(a: number, b: number): number { return a + b; }\n" },
    ];
    const repoInfo = await createMockGitRepository(ws.hostPath, files);
    initialCommitSha = repoInfo.commitSha;

    return {
      task,
      contract,
      runId: run.runId,
      leaseId: claimResult.lease.leaseId,
      workspace: ws,
    };
  }

  // =========================================================================
  // Test 1 — Observation propagation
  // =========================================================================
  it("Test 1 — Observation propagation: Step 1 physical tool observation appears in Step 2 ContextSnapshot", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    brain
      .queueStep((req) => {
        expect(req.sequenceNumber).toBe(1);
        return {
          proposal: {
            proposalId: "prop-step1",
            toolName: "git_status",
            inputPayload: { path: "." },
            contextSnapshotHash: req.contextSnapshot.contextHash,
            rationale: "Step 1: Check git status",
          },
          finishReason: "ACTION_PROPOSED",
        };
      })
      .queueStep((req) => {
        expect(req.sequenceNumber).toBe(2);

        // Assert Step 2 receives the exact TOOL_RESULT observation from Step 1
        const toolResultObs = req.contextSnapshot.observations.find((o) => o.category === "TOOL_RESULT");
        expect(toolResultObs).toBeDefined();
        expect(toolResultObs!.provenance.entityKind).toBe("Attempt");
        expect(toolResultObs!.provenance.sequenceNumber).toBe(1);
        expect(toolResultObs!.freshness).toBe("RECENT");

        const content = toolResultObs!.content as any;
        expect(content.toolName).toBe("git_status");
        expect(content.output.clean).toBe(true);
        expect(content.output.currentCommit).toBe(initialCommitSha);

        return {
          finishReason: "GOAL_REACHED",
        };
      });

    const result = await stepController.runStepLoop({
      runId,
      leaseId,
      workerId,
      workspace,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 2 },
    });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.totalSteps).toBe(2);
    expect(result.totalActions).toBe(1);
  });

  // =========================================================================
  // Test 2 — Two-step governed execution
  // =========================================================================
  it("Test 2 — Two-step governed execution: git_status (Step 1) -> read_file (Step 2) -> GOAL_REACHED (Step 3)", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    brain
      .queueStep((req) => ({
        proposal: {
          proposalId: "prop-step1-git",
          toolName: "git_status",
          inputPayload: { path: "." },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "Step 1: Inspect git status",
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep((req) => ({
        proposal: {
          proposalId: "prop-step2-read",
          toolName: "read_file",
          inputPayload: { path: "README.md" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "Step 2: Read README.md",
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
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 3 },
    });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.totalSteps).toBe(3);
    expect(result.totalActions).toBe(2);
    expect(result.totalProposalRejections).toBe(0);

    // Verify transcript records both executed actions
    expect(result.transcript[0]!.toolName).toBe("git_status");
    expect(result.transcript[0]!.actionStatus).toBe("SUCCEEDED");
    expect(result.transcript[1]!.toolName).toBe("read_file");
    expect(result.transcript[1]!.actionStatus).toBe("SUCCEEDED");
    expect((result.transcript[1]!.actionOutput as any).content).toContain("Emerald Phase 12");
  });

  // =========================================================================
  // Test 3 — Causal observation-dependent next decision
  // =========================================================================
  it("Test 3 — Causal observation test: distinctive marker in Step 1 tool observation causes Step 2 decision", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    // Create an untracked file containing the distinctive marker
    const markerFileName = "OBSERVATION_MARKER_PHASE12.txt";
    const markerHostPath = path.join(workspace.hostPath, markerFileName);
    await fs.writeFile(markerHostPath, "Marker Content 42\n", "utf8");

    let markerObservedInStep2 = false;

    brain
      .queueStep((req) => ({
        proposal: {
          proposalId: "prop-causal-1",
          toolName: "git_status",
          inputPayload: { path: "." },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "Step 1: Check status to locate marker file",
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep((req) => {
        // Find Step 1's tool result observation
        const toolResultObs = req.contextSnapshot.observations.find((o) => o.category === "TOOL_RESULT");
        expect(toolResultObs).toBeDefined();

        const statusOutput = (toolResultObs!.content as any).output;
        expect(statusOutput.untracked).toContain(markerFileName);
        markerObservedInStep2 = true;

        // Causally propose reading the discovered marker file
        return {
          proposal: {
            proposalId: "prop-causal-2",
            toolName: "read_file",
            inputPayload: { path: markerFileName },
            contextSnapshotHash: req.contextSnapshot.contextHash,
            rationale: `Step 2: Read discovered marker file '${markerFileName}'`,
          },
          finishReason: "ACTION_PROPOSED",
        };
      })
      .queueStep(() => ({
        finishReason: "GOAL_REACHED",
      }));

    const result = await stepController.runStepLoop({
      runId,
      leaseId,
      workerId,
      workspace,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 3 },
    });

    expect(markerObservedInStep2).toBe(true);
    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.totalActions).toBe(2);

    const step2Output = result.transcript[1]!.actionOutput as any;
    expect(step2Output.content).toContain("Marker Content 42");
  });

  // =========================================================================
  // Test 4 — Invalid proposal recovery
  // =========================================================================
  it("Test 4 — Invalid proposal recovery: invalid proposal rejected, bounded requery produces valid proposal", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    brain
      .queueStep((req) => ({
        proposal: {
          proposalId: "prop-invalid-attempt",
          toolName: "git_status",
          // Invalid payload with invented fields
          inputPayload: { pattern: "*.ts", inventedField: true },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "Erroneous proposal that must be rejected",
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep((req) => ({
        proposal: {
          proposalId: "prop-valid-corrected",
          toolName: "git_status",
          // Corrected payload
          inputPayload: { path: "." },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "Corrected proposal conforming to schema",
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
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 3, maxProposalRejections: 3 },
    });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.totalProposalRejections).toBe(1);
    expect(result.totalActions).toBe(1);

    // Step 1: Rejected
    expect(result.transcript[0]!.proposalValid).toBe(false);
    expect(result.transcript[0]!.proposalRejectionReason).toBe("INVALID_TOOL_INPUT");

    // Step 2: Valid and executed
    expect(result.transcript[1]!.proposalValid).toBe(true);
    expect(result.transcript[1]!.actionStatus).toBe("SUCCEEDED");
  });

  // =========================================================================
  // Test 5 — Invalid proposal causes zero physical execution
  // =========================================================================
  it("Test 5 — Invalid proposal causes zero physical execution: no tool dispatch or state mutation for rejected proposal", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    brain.queueStep((req) => ({
      proposal: {
        proposalId: "prop-fail-only",
        toolName: "read_file",
        inputPayload: { wrongKey: 123 },
        contextSnapshotHash: req.contextSnapshot.contextHash,
        rationale: "Schema violation",
      },
      finishReason: "ACTION_PROPOSED",
    }));

    const result = await stepController.runStepLoop({
      runId,
      leaseId,
      workerId,
      workspace,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 2, maxProposalRejections: 1 },
    });

    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");
    expect(result.totalActions).toBe(0);

    // Verify zero Actions or Attempts in database
    const actions = store.getActionsForRun(runId);
    expect(actions).toHaveLength(0);
  });

  // =========================================================================
  // Test 6 — Goal termination
  // =========================================================================
  it("Test 6 — Goal termination: isGoalReached=true terminates without extra action or attempt", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    brain
      .queueStep((req) => ({
        proposal: {
          proposalId: "prop-single-tool",
          toolName: "git_status",
          inputPayload: { path: "." },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "Inspect repo status",
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

    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.totalSteps).toBe(2);
    expect(result.totalActions).toBe(1);

    // Exactly one Action and Attempt persisted
    const actions = store.getActionsForRun(runId);
    expect(actions).toHaveLength(1);
    const attempts = store.getAttemptsForAction(actions[0]!.actionId);
    expect(attempts).toHaveLength(1);
  });

  // =========================================================================
  // Test 7 — Loop bounds
  // =========================================================================
  it("Test 7 — Loop bounds: repeated proposals halt when maxSteps or maxActions ceilings are reached", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    // Infinite tool proposal generator
    brain.queueStep((req) => ({
      proposal: {
        proposalId: "prop-repeat-1",
        toolName: "git_status",
        inputPayload: { path: "." },
        contextSnapshotHash: req.contextSnapshot.contextHash,
        rationale: "Repeated action",
      },
      finishReason: "ACTION_PROPOSED",
    })).queueStep((req) => ({
      proposal: {
        proposalId: "prop-repeat-2",
        toolName: "git_status",
        inputPayload: { path: "." },
        contextSnapshotHash: req.contextSnapshot.contextHash,
        rationale: "Repeated action",
      },
      finishReason: "ACTION_PROPOSED",
    })).queueStep((req) => ({
      proposal: {
        proposalId: "prop-repeat-3",
        toolName: "git_status",
        inputPayload: { path: "." },
        contextSnapshotHash: req.contextSnapshot.contextHash,
        rationale: "Repeated action",
      },
      finishReason: "ACTION_PROPOSED",
    }));

    // Bounded to exactly 2 actions
    const result = await stepController.runStepLoop({
      runId,
      leaseId,
      workerId,
      workspace,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxActions: 2, maxSteps: 5 },
    });

    expect(result.terminalReason).toBe("MAX_ACTIONS");
    expect(result.totalActions).toBe(2);
  });

  // =========================================================================
  // Test 8 — Multi-step trajectory persistence
  // =========================================================================
  it("Test 8 — Multi-step trajectory persistence: preserves Run -> Action 1 -> Attempt 1 and Action 2 -> Attempt 1", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    brain
      .queueStep((req) => ({
        proposal: {
          proposalId: "prop-traj-1",
          toolName: "git_status",
          inputPayload: { path: "." },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "Action 1",
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep((req) => ({
        proposal: {
          proposalId: "prop-traj-2",
          toolName: "read_file",
          inputPayload: { path: "README.md" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "Action 2",
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep(() => ({
        finishReason: "GOAL_REACHED",
      }));

    await stepController.runStepLoop({
      runId,
      leaseId,
      workerId,
      workspace,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 3 },
    });

    const actions = store.getActionsForRun(runId);
    expect(actions).toHaveLength(2);

    // Action 1
    const act1 = actions.find((a) => a.sequenceNumber === 1)!;
    expect(act1).toBeDefined();
    expect(act1.toolName).toBe("git_status");
    expect(act1.status).toBe("SUCCEEDED");
    const atts1 = store.getAttemptsForAction(act1.actionId);
    expect(atts1).toHaveLength(1);
    expect(atts1[0]!.attemptNumber).toBe(1);
    expect(atts1[0]!.status).toBe("SUCCEEDED");
    expect(atts1[0]!.idempotencyToken).toBe(`${runId}:${act1.actionId}:1`);

    // Action 2
    const act2 = actions.find((a) => a.sequenceNumber === 2)!;
    expect(act2).toBeDefined();
    expect(act2.toolName).toBe("read_file");
    expect(act2.status).toBe("SUCCEEDED");
    const atts2 = store.getAttemptsForAction(act2.actionId);
    expect(atts2).toHaveLength(1);
    expect(atts2[0]!.attemptNumber).toBe(1);
    expect(atts2[0]!.status).toBe("SUCCEEDED");
    expect(atts2[0]!.idempotencyToken).toBe(`${runId}:${act2.actionId}:1`);
  });

  // =========================================================================
  // Test 9 — Security invariants across multiple steps
  // =========================================================================
  it("Test 9 — Security invariants: model cannot forge authority in Step 1 or Step 2", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    // Adversarial proposal in Step 1
    brain
      .queueStep((req) => ({
        proposal: {
          proposalId: "prop-sec-adv-1",
          toolName: "git_status",
          inputPayload: { path: "." },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "Injecting stolen authority",
          workerId: "rogue-worker",
          leaseId: "stolen-lease",
          contractId: "counterfeit-contract",
        } as any,
        finishReason: "ACTION_PROPOSED",
      }))
      // Step 2 tries again
      .queueStep((req) => ({
        proposal: {
          proposalId: "prop-sec-adv-2",
          toolName: "read_file",
          inputPayload: { path: "README.md" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "Second authority injection attempt",
          requiredCapability: "system.admin",
        } as any,
        finishReason: "ACTION_PROPOSED",
      }));

    const result = await stepController.runStepLoop({
      runId,
      leaseId,
      workerId,
      workspace,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 3, maxProposalRejections: 2 },
    });

    // Both adversarial attempts were rejected with FORBIDDEN_AUTHORITY_FIELD
    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");
    expect(result.totalProposalRejections).toBe(2);
    expect(result.totalActions).toBe(0);

    expect(result.transcript[0]!.proposalRejectionReason).toBe("FORBIDDEN_AUTHORITY_FIELD");
    expect(result.transcript[1]!.proposalRejectionReason).toBe("FORBIDDEN_AUTHORITY_FIELD");

    // Zero actions or attempts in DB
    expect(store.getActionsForRun(runId)).toHaveLength(0);
  });

  // =========================================================================
  // Test 10 — Cancellation/failure handling
  // =========================================================================
  it("Test 10 — Cancellation/failure: AbortSignal during Step 2 halts cleanly without creating false success", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();
    const abortController = new AbortController();

    brain
      .queueStep((req) => ({
        proposal: {
          proposalId: "prop-step1-ok",
          toolName: "git_status",
          inputPayload: { path: "." },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "Step 1 executes successfully",
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep((req) => {
        // Trigger abort before step 2 executes
        abortController.abort();
        return {
          proposal: {
            proposalId: "prop-step2-aborted",
            toolName: "read_file",
            inputPayload: { path: "README.md" },
            contextSnapshotHash: req.contextSnapshot.contextHash,
            rationale: "Step 2 should be cancelled",
          },
          finishReason: "ACTION_PROPOSED",
        };
      });

    const result = await stepController.runStepLoop({
      runId,
      leaseId,
      workerId,
      workspace,
      abortSignal: abortController.signal,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 5 },
    });

    expect(result.terminalReason).toBe("CANCELLED");
    expect(result.totalActions).toBe(1); // Only step 1 executed

    // Step 1 remains SUCCEEDED in SQLite
    const actions = store.getActionsForRun(runId);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.status).toBe("SUCCEEDED");
  });
});
