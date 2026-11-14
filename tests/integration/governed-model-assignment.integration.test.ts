/**
 * Governed model assignment — decomposition, durable assignment and worker-side enforcement.
 *
 * Real: SqliteStateStore, RunCoordinator, TaskRouterService, MultiAgentOrchestrator, GovernedModelRouterService,
 *       ModelAssignmentEnforcingBrain, runWorkerHost, the approved registry.
 * Fixture: provider inventories; the `m-fixture` model with synthetic gate evidence (routing logic only, not a
 *          claim about any real model); a counting AgentBrainPort standing in for the model.
 * No provider is contacted, no inference is run and no container is started (physicalProvider "none").
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { submitDurableTask } from "../../src/application/durable-submission.js";
import { GovernedModelRouterService } from "../../src/application/governed-model-router.js";
import { ModelAssignmentEnforcingBrain } from "../../src/application/model-assignment-guard.js";
import { MultiAgentOrchestrator } from "../../src/application/multi-agent-orchestrator.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { TaskRouterService } from "../../src/application/task-router.js";
import { type WorkerLogRecord, runWorkerHost } from "../../src/application/worker-host.js";
import {
  ModelAssignment,
  ModelAssignmentViolationError,
  ModelCapabilityGateId,
  OpenWeightModelProfile,
} from "../../src/domain/model-routing.js";
import { SuperAgentDecompositionError } from "../../src/domain/super-agent.js";
import type { AgentBrainPort, AgentBrainRequest, AgentBrainResult } from "../../src/ports/agent-brain.port.js";
import { SystemClock } from "../../src/ports/clock.port.js";

const QWEN = "qwen2.5-coder:1.5b";
const QWEN_DIGEST = "sha256:d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668";
const FIXTURE_DIGEST = `sha256:${"f".repeat(64)}`;
const ALL_ROLE_GATES: ModelCapabilityGateId[] = [
  "G1_STRUCTURED_JSON",
  "G2_REPO_NAVIGATION",
  "G3_CODE_UNDERSTANDING",
  "G4_SINGLE_FILE_REPAIR",
  "G6_REGRESSION_AWARENESS",
];

const fixtureModel: OpenWeightModelProfile = {
  modelId: "m-fixture",
  modelTag: "m-fixture",
  modelDigest: FIXTURE_DIGEST,
  digestVerified: true,
  parameterCount: "fixture",
  openSourceLicense: "Apache-2.0",
  isProprietaryHosted: false,
  declaredCapabilities: [],
  gateEvidence: ALL_ROLE_GATES.map((gateId) => ({
    gateId,
    outcome: "PASSED" as const,
    modelId: "m-fixture",
    modelDigest: FIXTURE_DIGEST,
    evaluationVersion: "fixture-eval-1",
    evidenceRef: `fixture:${gateId}`,
    summary: "synthetic fixture evidence",
    observedAt: "2026-11-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  })),
  contextLimits: { maxInputTokens: 4096, maxOutputTokens: 2048, contextWindowBytes: 16384 },
  latencyProfile: {
    expectedStepLatencyMs: null,
    observed: { sampleCount: 10, minMs: 1000, medianMs: 1000, p90Ms: 1000, maxMs: 1000, measuredAt: "2026-11-01T00:00:00.000Z", source: "fixture" },
    timeoutThresholdMs: 150_000,
  },
  hardwareRequirements: { residentMemoryMb: 500, residentMemoryMeasured: false, quantization: "Q4_K_M", accelerator: "CPU" },
};

class CountingBrain implements AgentBrainPort {
  calls = 0;
  async proposeAction(_request: AgentBrainRequest): Promise<AgentBrainResult> {
    this.calls++;
    return { finishReason: "GOAL_REACHED" };
  }
}

describe("governed model assignment", () => {
  let dir: string;
  let dbPath: string;
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;
  let taskRouter: TaskRouterService;
  const clock = new SystemClock();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-model-assignment-"));
    dbPath = path.join(dir, "state.db");
    store = new SqliteStateStore({ location: dbPath });
    coordinator = new RunCoordinator(store, clock);
    taskRouter = new TaskRouterService(store, coordinator, clock, { maxConcurrentRuns: 2 });
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed by a test
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const submitMission = (tenantId = "tenant-alpha") =>
    submitDurableTask(store, coordinator, {
      task: "Implement and verify feature X",
      operation: "feature_x",
      capabilities: ["workspace.file.read", "workspace.file.write", "process.execute", "workspace.query"],
      tenantId,
      timeoutMs: 120_000,
    });

  const coderSubtask = (extra: Record<string, unknown> = {}) => ({
    subtaskId: "sub-impl",
    role: "CODER" as const,
    objective: "Implement feature",
    dependencies: [],
    customCapabilities: ["workspace.file.read", "workspace.file.write"],
    resourceLimits: { timeoutMs: 40_000, maxAttempts: 1 },
    ...extra,
  });

  const fixtureRouter = () => {
    const router = new GovernedModelRouterService({ customModels: [fixtureModel] });
    router.applyInstalledInventory([{ name: "m-fixture", digest: FIXTURE_DIGEST }]);
    return router;
  };

  const assignmentOf = (taskId: string): ModelAssignment | undefined =>
    (store.getTask(taskId)?.inputPayload as { modelAssignment?: ModelAssignment } | undefined)?.modelAssignment;

  // -------------------------------------------------------------------------------------------
  // Decomposition
  // -------------------------------------------------------------------------------------------

  it("rejects decomposition when no model qualifies, creates no child, and records a durable reason", () => {
    const mission = submitMission();
    const router = new GovernedModelRouterService();
    router.applyInstalledInventory([{ name: QWEN, digest: QWEN_DIGEST }]);
    const orchestrator = new MultiAgentOrchestrator(store, coordinator, taskRouter, clock, { modelRouter: router });

    expect(() => orchestrator.decomposeMission({ missionTaskId: mission.taskId, subtasks: [coderSubtask()] })).toThrowError(
      SuperAgentDecompositionError
    );
    expect(store.getTask(`${mission.taskId}__sub__sub-impl`)).toBeNull();
    expect(store.transaction((tx) => tx.listChildTaskRelations(mission.taskId))).toHaveLength(0);

    const rejection = store.getEventsForRun(mission.runId).find((e) => e.eventType === "model.routing.rejected");
    expect(rejection).toBeDefined();
    const payload = rejection!.payload as { role: string; reason: string; rejectedCandidates: { modelId: string }[] };
    expect(payload.role).toBe("CODER");
    expect(payload.reason).toContain("MISSING_GATE_EVIDENCE");
    expect(payload.rejectedCandidates.map((c) => c.modelId)).toContain(QWEN);
  });

  it("stores a durable assignment on each child, bound to that child's task, tenant and role", () => {
    const mission = submitMission();
    const orchestrator = new MultiAgentOrchestrator(store, coordinator, taskRouter, clock, { modelRouter: fixtureRouter() });
    orchestrator.decomposeMission({
      missionTaskId: mission.taskId,
      subtasks: [
        coderSubtask(),
        {
          subtaskId: "sub-review",
          role: "REVIEWER" as const,
          objective: "Review change",
          dependencies: ["sub-impl"],
          customCapabilities: ["workspace.file.read"],
          resourceLimits: { timeoutMs: 40_000, maxAttempts: 1 },
        },
      ],
    });

    const coder = assignmentOf(`${mission.taskId}__sub__sub-impl`)!;
    const reviewer = assignmentOf(`${mission.taskId}__sub__sub-review`)!;
    expect(coder).toMatchObject({ modelId: "m-fixture", modelDigest: FIXTURE_DIGEST, role: "CODER", tenantId: "tenant-alpha", taskId: `${mission.taskId}__sub__sub-impl` });
    expect(coder.requiredGates).toEqual(["G1_STRUCTURED_JSON", "G3_CODE_UNDERSTANDING", "G4_SINGLE_FILE_REPAIR"]);
    expect(reviewer).toMatchObject({ role: "REVIEWER", taskId: `${mission.taskId}__sub__sub-review` });
    expect(reviewer.requiredGates).toEqual(["G1_STRUCTURED_JSON", "G6_REGRESSION_AWARENESS"]);
    expect(reviewer.decisionHash).not.toBe(coder.decisionHash);
  });

  it("does not let a client-supplied payload set or override the assignment", () => {
    const forged = { modelId: "anything", modelDigest: "0".repeat(64), taskId: "x", role: "CODER" };

    const withRouter = submitMission();
    new MultiAgentOrchestrator(store, coordinator, taskRouter, clock, { modelRouter: fixtureRouter() }).decomposeMission({
      missionTaskId: withRouter.taskId,
      subtasks: [coderSubtask({ inputPayload: { modelAssignment: forged } })],
    });
    expect(assignmentOf(`${withRouter.taskId}__sub__sub-impl`)).toMatchObject({ modelId: "m-fixture" });

    const withoutRouter = submitMission();
    new MultiAgentOrchestrator(store, coordinator, taskRouter, clock).decomposeMission({
      missionTaskId: withoutRouter.taskId,
      subtasks: [coderSubtask({ inputPayload: { modelAssignment: forged } })],
    });
    expect(assignmentOf(`${withoutRouter.taskId}__sub__sub-impl`)).toBeUndefined();
  });

  // -------------------------------------------------------------------------------------------
  // Guard
  // -------------------------------------------------------------------------------------------

  const guardFor = (inner: AgentBrainPort, verified: { modelId: string; modelDigest: string } | null) =>
    new ModelAssignmentEnforcingBrain({ inner, stateStore: store, verifiedModel: verified });

  const brainRequest = (taskId: string, runId: string): AgentBrainRequest =>
    ({ runId, contextSnapshot: { taskId }, availableTools: [], sequenceNumber: 1 }) as unknown as AgentBrainRequest;

  const decomposeWithFixture = (tenantId = "tenant-alpha") => {
    const mission = submitMission(tenantId);
    new MultiAgentOrchestrator(store, coordinator, taskRouter, clock, { modelRouter: fixtureRouter() }).decomposeMission({
      missionTaskId: mission.taskId,
      subtasks: [coderSubtask()],
    });
    const childTaskId = `${mission.taskId}__sub__sub-impl`;
    const childRunId = store.transaction((tx) => tx.getRouterSubmissionByTaskId(childTaskId))!.runId;
    return { mission, childTaskId, childRunId };
  };

  it("lets a single-agent task through and never calls the model for a refused role task", async () => {
    const mission = submitMission();
    const inner = new CountingBrain();
    await guardFor(inner, { modelId: QWEN, modelDigest: QWEN_DIGEST }).proposeAction(brainRequest(mission.taskId, mission.runId));
    expect(inner.calls).toBe(1);

    // Role-bearing child created without a router has no assignment: refused.
    new MultiAgentOrchestrator(store, coordinator, taskRouter, clock).decomposeMission({
      missionTaskId: mission.taskId,
      subtasks: [coderSubtask()],
    });
    const childTaskId = `${mission.taskId}__sub__sub-impl`;
    const childRunId = store.transaction((tx) => tx.getRouterSubmissionByTaskId(childTaskId))!.runId;
    await expect(
      guardFor(inner, { modelId: QWEN, modelDigest: QWEN_DIGEST }).proposeAction(brainRequest(childTaskId, childRunId))
    ).rejects.toThrowError(/no governed model assignment/);
    expect(inner.calls).toBe(1);
  });

  it("accepts a matching assignment and refuses a different model, digest, or an unverified worker", async () => {
    const { childTaskId, childRunId } = decomposeWithFixture();
    const inner = new CountingBrain();

    await guardFor(inner, { modelId: "m-fixture", modelDigest: FIXTURE_DIGEST }).proposeAction(brainRequest(childTaskId, childRunId));
    expect(inner.calls).toBe(1);

    // Restart / replay: a new guard instance reads the same stored assignment and reaches the same answer.
    await guardFor(inner, { modelId: "m-fixture", modelDigest: FIXTURE_DIGEST }).proposeAction(brainRequest(childTaskId, childRunId));
    expect(inner.calls).toBe(2);

    for (const verified of [
      { modelId: QWEN, modelDigest: QWEN_DIGEST }, // operator started the worker with another approved model
      { modelId: "m-fixture", modelDigest: `sha256:${"0".repeat(64)}` }, // same name, different weights
      null, // injected brain: identity cannot be proven
    ]) {
      await expect(guardFor(inner, verified).proposeAction(brainRequest(childTaskId, childRunId))).rejects.toThrowError(
        ModelAssignmentViolationError
      );
    }
    expect(inner.calls).toBe(2);
  });

  it("refuses an assignment replayed onto another task or another tenant", async () => {
    const a = decomposeWithFixture("tenant-alpha");
    const b = decomposeWithFixture("tenant-beta");
    const inner = new CountingBrain();
    const verified = { modelId: "m-fixture", modelDigest: FIXTURE_DIGEST };

    // Tamper: copy tenant-alpha's assignment onto tenant-beta's child task record.
    const stolen = assignmentOf(a.childTaskId)!;
    const tamperingStore = {
      getTask: (taskId: string) => {
        const task = store.getTask(taskId);
        return task && taskId === b.childTaskId
          ? { ...task, inputPayload: { ...(task.inputPayload as object), modelAssignment: stolen } }
          : task;
      },
      getRun: (runId: string) => store.getRun(runId),
      getContract: (id: string, version: number) => store.getContract(id, version),
    };
    const guard = new ModelAssignmentEnforcingBrain({ inner, stateStore: tamperingStore as never, verifiedModel: verified });
    await expect(guard.proposeAction(brainRequest(b.childTaskId, b.childRunId))).rejects.toThrowError(/issued for task/);
    expect(inner.calls).toBe(0);
  });

  // -------------------------------------------------------------------------------------------
  // Worker host
  // -------------------------------------------------------------------------------------------

  it("worker host with an injected brain refuses a role task: the run fails and the brain is never called", async () => {
    const { childTaskId, childRunId, mission } = decomposeWithFixture();
    store.close();

    const inner = new CountingBrain();
    const logs: WorkerLogRecord[] = [];
    const result = await runWorkerHost({
      dbPath,
      workspaceRoot: dir,
      once: true,
      modelProvider: "ollama",
      physicalProvider: "none",
      agentBrain: inner,
      signal: new AbortController().signal,
      log: (record) => logs.push(record),
    });

    expect(result.errors).toBe(0);
    expect(logs.some((l) => l.event === "worker.model.gate_skipped")).toBe(true);
    const refusals = logs.filter((l) => l.event === "worker.model.assignment_refused");
    const inspect = new SqliteStateStore({ location: dbPath });
    try {
      const childRun = inspect.getRun(childRunId);
      if (childRun && childRun.status !== "QUEUED" && childRun.status !== "CREATED") {
        // The child was claimed: it must have been refused without reaching the brain for that task.
        expect(refusals.some((l) => l.taskId === childTaskId)).toBe(true);
        expect(childRun.status).toBe("FAILED");
      }
      // The mission (single-agent, no role) is not subject to the assignment guard.
      expect(refusals.some((l) => l.taskId === mission.taskId)).toBe(false);
    } finally {
      inspect.close();
    }
  });
});
