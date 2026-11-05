/**
 * Milestone 3.1A — Write-stagnation protection in the governed step loop
 *
 * Repeating the same successful write_file (same path and requested content) changes nothing, so the loop
 * advises the model once and then halts with STAGNATION, exactly as it already does for identical reads.
 *
 * Explicit limits (not proven here, by design):
 * - Only write_file is tracked; edit_file already has its own ineffective-edit budget.
 * - Writes that FAIL do not count toward this budget (they count toward the consecutive-failure budget).
 * - The guard bounds wasted steps; it does not judge whether the final file content is correct.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import {
  AgentStepController,
  DEFAULT_MAX_CONSECUTIVE_IDENTICAL_WRITES,
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
import { createAndActivateContract } from "./test-helpers.js";

class ScriptableAgentBrain implements AgentBrainPort {
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

describe("Milestone 3.1A — write-stagnation protection", () => {
  let tempDir: string;
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;
  let clock: SettableClock;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let brain: ScriptableAgentBrain;
  let stepController: AgentStepController;
  const workerId = "worker-write-stagnation";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-write-stagnation-"));
    store = new SqliteStateStore();
    clock = new SettableClock(new Date().toISOString());
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: tempDir });
    coordinator = new RunCoordinator(store, clock);
    const workerRuntime = new WorkerRuntime({ workerId, coordinator, clock, workspacePort: workspaceAdapter });
    const proposalValidator = new ProposalValidator({
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
    store.transaction((tx) => {
      tx.insertWorker({
        workerId,
        hostname: "localhost",
        pid: 7777,
        status: "ACTIVE",
        createdAt: clock.nowIso(),
        lastHeartbeatAt: clock.nowIso(),
      });
    });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function setupGovernedRun() {
    const task = coordinator.createTask({
      title: "Write stagnation task",
      description: "Testing write stagnation",
      inputPayload: { target: "test" },
    });
    createAndActivateContract(store, task.taskId, {
      policy: createExecutionPolicy({
        policyId: `policy-${task.taskId}`,
        allowedCapabilities: ["workspace.file.read", "workspace.file.write", "workspace.code.search"],
        isolationRequirement: "ISOLATED",
      }),
      timeoutMs: 30000,
      maxOutputBytes: 1048576,
      maxAttempts: 3,
    });
    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);
    const claim = coordinator.claimRun(run.runId, workerId, 60000);
    coordinator.startRun(run.runId, workerId, claim.lease.leaseId);
    const workspace = await workspaceAdapter.provisionWorkspace({
      workspaceId: `ws-${run.runId}`,
      runId: run.runId,
      taskId: task.taskId,
      maxWorkspaceBytes: 50 * 1024 * 1024,
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
    return { runId: run.runId, leaseId: claim.lease.leaseId, workspace };
  }

  const write = (id: string, filePath: string, content: string) => (req: AgentBrainRequest): AgentBrainResult => ({
    proposal: {
      proposalId: id,
      toolName: "write_file",
      inputPayload: { path: filePath, content, overwrite: true },
      contextSnapshotHash: req.contextSnapshot.contextHash,
    },
    finishReason: "ACTION_PROPOSED",
  });

  const read = (id: string, filePath: string) => (req: AgentBrainRequest): AgentBrainResult => ({
    proposal: {
      proposalId: id,
      toolName: "read_file",
      inputPayload: { path: filePath },
      contextSnapshotHash: req.contextSnapshot.contextHash,
    },
    finishReason: "ACTION_PROPOSED",
  });

  it("exports the default ceiling and includes it in the default budget", () => {
    expect(DEFAULT_MAX_CONSECUTIVE_IDENTICAL_WRITES).toBe(3);
    expect(DEFAULT_STEP_CONTROLLER_BUDGET.maxConsecutiveIdenticalWrites).toBe(3);
  });

  it("halts with STAGNATION after 3 identical successful writes and never reaches the next step", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();
    let step4Invoked = false;
    brain
      .queueStep(write("w1", "out.txt", "same"))
      .queueStep(write("w2", "out.txt", "same"))
      .queueStep(write("w3", "out.txt", "same"))
      .queueStep(() => {
        step4Invoked = true;
        return { finishReason: "GOAL_REACHED" };
      });

    const result = await stepController.runStepLoop({ runId, workerId, leaseId, workspace });

    expect(result.terminalReason).toBe("STAGNATION");
    expect(result.terminalMessage).toContain(
      "Execution loop halted due to stagnation: 3 consecutive identical successful writes of 'out.txt' without progress"
    );
    expect(result.totalActions).toBe(3);
    expect(step4Invoked).toBe(false);
    expect(fs.readFileSync(path.join(workspace.hostPath, "out.txt"), "utf8")).toBe("same");
  });

  it("injects exactly one observable advisory after the second identical write", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();
    const advisoryCounts: number[] = [];
    const countAdvisories = (req: AgentBrainRequest): number =>
      req.contextSnapshot.observations.filter(
        (o) => o.category === "SYSTEM_EVENT" && o.content.feedbackKind === "REPEATED_IDENTICAL_WRITE"
      ).length;

    brain
      .queueStep(write("w1", "out.txt", "same"))
      .queueStep(write("w2", "out.txt", "same"))
      .queueStep((req) => {
        advisoryCounts.push(countAdvisories(req));
        return write("w3", "out.txt", "same")(req);
      })
      .queueStep((req) => {
        advisoryCounts.push(countAdvisories(req));
        return { finishReason: "GOAL_REACHED" };
      });

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxConsecutiveIdenticalWrites: 5 },
    });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.transcript[1]!.progressAdvisory).toContain("same write_file request");
    expect(advisoryCounts).toEqual([1, 0]);
  });

  it("does not count writes of different content to the same path", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();
    brain
      .queueStep(write("w1", "out.txt", "A"))
      .queueStep(write("w2", "out.txt", "B"))
      .queueStep(write("w3", "out.txt", "A"))
      .queueStep(write("w4", "out.txt", "B"))
      .queueStep(write("w5", "out.txt", "A"))
      .queueStep(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxSteps: 20, maxActions: 20 },
    });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.totalActions).toBe(5);
  });

  it("counts only consecutive repeats: an intervening action resets the counter", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();
    brain
      .queueStep(write("w1", "out.txt", "same"))
      .queueStep(write("w2", "out.txt", "same"))
      .queueStep(read("r1", "out.txt"))
      .queueStep(write("w3", "out.txt", "same"))
      .queueStep(write("w4", "out.txt", "same"))
      .queueStep(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxSteps: 20, maxActions: 20 },
    });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.totalActions).toBe(5);
  });

  it("honors a stricter configured ceiling", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();
    brain
      .queueStep(write("w1", "out.txt", "same"))
      .queueStep(write("w2", "out.txt", "same"))
      .queueStep(write("w3", "out.txt", "same"));

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxConsecutiveIdenticalWrites: 2 },
    });

    expect(result.terminalReason).toBe("STAGNATION");
    expect(result.terminalMessage).toContain("2 consecutive identical successful writes of 'out.txt'");
    expect(result.totalActions).toBe(2);
  });
});
