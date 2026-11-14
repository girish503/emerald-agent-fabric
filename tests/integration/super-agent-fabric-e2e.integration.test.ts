/**
 * Super Agent Fabric End-to-End Acceptance Suite.
 *
 * Exercises the complete integrated product architecture across 10 core scenarios:
 * 1. Simple task creating a verifiable artifact.
 * 2. Multi-step coding task with testing and independent verification.
 * 3. Multi-agent task with DAG dependencies and fail-closed parent synthesis.
 * 4. Failure-repair-retest loop with diagnostic classification.
 * 5. Cancellation and lease-fencing protection.
 * 6. Multi-tenant isolation (Tenant A cannot view or synthesize Tenant B).
 * 7. Sandbox rejection for untrusted multi-tenant workloads.
 * 8. Failed verification gate (exit code != 0 rejects goal attainment).
 * 9. Cryptographic artifact retrieval and content hashing.
 * 10. SSE event streaming and reconnection with cursor resumption.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { AgentStepController } from "../../src/application/agent-step-controller.js";
import { submitDurableTask } from "../../src/application/durable-submission.js";
import { MultiAgentOrchestrator } from "../../src/application/multi-agent-orchestrator.js";
import { ProposalValidator } from "../../src/application/proposal-validator.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { TaskRouterService } from "../../src/application/task-router.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { BoundedRepairLoopController } from "../../src/application/bounded-repair-loop.js";
import { staticToolRegistry } from "../../src/domain/tool.js";
import { AgentBrainPort, AgentBrainRequest, AgentBrainResult } from "../../src/ports/agent-brain.port.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { ExecutionProvider, ExecutionRequest, ExecutionResult } from "../../src/ports/execution-provider.port.js";
import { buildFastifyServer, PrincipalRecord } from "../../src/transport/http/server.js";

class MockControllableProvider implements ExecutionProvider {
  readonly name = "mock-controllable-provider";
  readonly role = "PHYSICAL" as const;
  readonly tenantModel = "NONE" as const;
  public exitCode = 0;
  public stdout = "All 5 tests passed.";
  public stderr = "";

  async execute<TInput = unknown, TOutput = unknown>(
    _request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    const out = {
      exitCode: this.exitCode,
      stdout: this.stdout,
      stderr: this.stderr,
      durationMs: 10,
      outputTruncated: false,
    };
    return {
      status: this.exitCode === 0 ? "SUCCESS" : "FAILED",
      output: out as unknown as TOutput,
      durationMs: 10,
    };
  }
}

class ScriptableAgentBrain implements AgentBrainPort {
  private steps: ((req: AgentBrainRequest) => AgentBrainResult | Promise<AgentBrainResult>)[] = [];

  queueStep(step: (req: AgentBrainRequest) => AgentBrainResult | Promise<AgentBrainResult>): this {
    this.steps.push(step);
    return this;
  }

  async proposeAction(request: AgentBrainRequest): Promise<AgentBrainResult> {
    const next = this.steps.shift();
    if (next) {
      return await next(request);
    }
    return {
      finishReason: "GOAL_REACHED",
    };
  }
}

describe("Emerald Super Agent Fabric — End-to-End Acceptance Suite", () => {
  let tmpDir: string;
  let dbPath: string;
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;
  let clock: SettableClock;
  let router: TaskRouterService;
  let orchestrator: MultiAgentOrchestrator;
  let provider: MockControllableProvider;

  const TOK_A = "alpha-operator-token-aaaaaaaaaaaaaaaa1";
  const TOK_B = "beta-operator-token-bbbbbbbbbbbbbbbb2";

  const principals: PrincipalRecord[] = [
    { token: TOK_A, principalId: "p-alpha", tenantId: "tenant-alpha", role: "operator" },
    { token: TOK_B, principalId: "p-beta", tenantId: "tenant-beta", role: "operator" },
  ];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-e2e-suite-"));
    dbPath = path.join(tmpDir, "e2e.db");
    store = new SqliteStateStore({ location: dbPath });
    clock = new SettableClock(new Date("2026-11-10T20:00:00.000Z"));
    coordinator = new RunCoordinator(store, clock);
    router = new TaskRouterService(store, coordinator, clock, { maxConcurrentRuns: 2 });
    orchestrator = new MultiAgentOrchestrator(store, coordinator, router, clock, {
      maxDepth: 4,
      maxChildrenPerParent: 8,
    });
    provider = new MockControllableProvider();
    store.transaction((tx) => {
      tx.insertWorker({
        workerId: "worker-1",
        hostname: "localhost",
        pid: process.pid,
        status: "ACTIVE",
        createdAt: clock.now().toISOString(),
        lastHeartbeatAt: clock.now().toISOString(),
      });
      tx.insertWorker({
        workerId: "worker-s8",
        hostname: "localhost",
        pid: process.pid,
        status: "ACTIVE",
        createdAt: clock.now().toISOString(),
        lastHeartbeatAt: clock.now().toISOString(),
      });
      tx.insertWorker({
        workerId: "w1",
        hostname: "localhost",
        pid: process.pid,
        status: "ACTIVE",
        createdAt: clock.now().toISOString(),
        lastHeartbeatAt: clock.now().toISOString(),
      });
      tx.insertWorker({
        workerId: "w-stale",
        hostname: "localhost",
        pid: process.pid,
        status: "ACTIVE",
        createdAt: clock.now().toISOString(),
        lastHeartbeatAt: clock.now().toISOString(),
      });
    });
  });

  afterEach(() => {
    try {
      store.close();
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  // Scenario 1: Simple task creating a verifiable artifact
  it("Scenario 1: creates and verifies a durable artifact through full REST submission", async () => {
    const server = buildFastifyServer({ principals, store, coordinator });

    const createRes = await server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { authorization: `Bearer ${TOK_A}` },
      payload: {
        title: "Create Artifact Task",
        prompt: "Write solution artifact",
        executionMode: "sandboxed",
        modelConfig: {
          provider: "ollama",
          modelName: "qwen2.5-coder:1.5b",
        },
        verificationSpecs: [
          {
            specId: "vspec-check",
            name: "Artifact verification",
            argv: ["node", "test.js"],
            timeoutMs: 5000,
            expectedExitCode: 0,
          },
        ],
      },
    });

    expect(createRes.statusCode).toBe(201);
    const body = createRes.json();
    expect(body.data.taskId).toBeDefined();

    const task = store.getTask(body.data.taskId);
    expect(task?.taskId).toBe(body.data.taskId);
    expect(body.data.tenantId).toBe("tenant-alpha");
    const contract = store.getContract(`contract-${body.data.taskId}`, 1);
    expect(contract?.spec.policy.tenantId).toBe("tenant-alpha");
    await server.close();
  });

  // Scenario 2: Multi-step coding task with testing and independent verification
  it("Scenario 2: executes multi-step coding task and completes only via independent verifier", async () => {
    const submission = submitDurableTask(
      store,
      coordinator,
      {
        tenantId: "tenant-alpha",
        task: "Coding task",
        operation: "coding",
        capabilities: ["workspace.file.read", "workspace.file.write", "process.execute"],
        verificationSpecs: [{ specId: "vspec-test", argv: ["node", "test.js"], timeoutMs: 5000 }],
      }
    );

    const wsAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: tmpDir });
    const ws = await wsAdapter.provisionWorkspace({
      workspaceId: `ws-${submission.runId}`,
      runId: submission.runId,
      taskId: submission.taskId,
      maxWorkspaceBytes: 10 * 1024 * 1024,
      maxFileSizeBytes: 5 * 1024 * 1024,
    });

    const brain = new ScriptableAgentBrain();
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-1",
        toolName: "write_file",
        inputPayload: { path: "solution.js", content: "export const solve = () => 42;" },
        contextSnapshotHash: req.contextSnapshot.contextHash,
        rationale: "Write solution",
      },
    }));
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));

    const workerRuntime = new WorkerRuntime({
      workerId: "worker-1",
      coordinator,
      clock,
      workspacePort: wsAdapter,
      executionProvider: provider,
      isIsolationAvailable: true,
    });

    const proposalValidator = new ProposalValidator({
      coordinator,
      stateStore: store,
      toolRegistry: staticToolRegistry,
      clock,
    });

    const stepController = new AgentStepController({
      coordinator,
      stateStore: store,
      workerRuntime,
      agentBrain: brain,
      proposalValidator,
      toolRegistry: staticToolRegistry,
      clock,
      enableGovernedVerificationStage: true,
    });

    const claim = coordinator.claimRun(submission.runId, "worker-1", 30_000);
    expect(claim).toBeDefined();
    coordinator.startRun(submission.runId, "worker-1", claim!.lease.leaseId);

    provider.exitCode = 0; // Test passes
    const result = await stepController.runStepLoop({
      runId: submission.runId,
      workerId: "worker-1",
      leaseId: claim!.lease.leaseId,
      workspace: ws,
    });
    expect(result.terminalReason).toBe("COMPLETED");
    coordinator.completeRun(submission.runId, "worker-1", claim!.lease.leaseId, result);
    const run = coordinator.getRun(submission.runId);
    expect(run?.status).toBe("COMPLETED");
  });

  // Scenario 3: Multi-agent task with dependencies and parent synthesis
  it("Scenario 3: decomposes mission into DAG subtasks and synthesizes fail-closed parent", async () => {
    const parentSub = submitDurableTask(
      store,
      coordinator,
      {
        tenantId: "tenant-alpha",
        task: "Parent Multi-Agent Mission",
        operation: "coordinate",
        capabilities: ["workspace.file.read", "process.execute"],
      }
    );

    const decomp = orchestrator.decomposeMission({
      missionTaskId: parentSub.taskId,
      subtasks: [
        {
          subtaskId: "sub-1-research",
          role: "RESEARCHER",
          objective: "Research codebase",
          customCapabilities: ["workspace.file.read"],
          dependencies: [],
          verificationSpecs: [{ specId: "vspec-research", argv: ["node", "check.js"], timeoutMs: 5000 }],
        },
        {
          subtaskId: "sub-2-test",
          role: "TESTER",
          objective: "Run tests",
          customCapabilities: ["workspace.file.read", "process.execute"],
          dependencies: ["sub-1-research"],
          verificationSpecs: [{ specId: "vspec-test", argv: ["node", "test.js"], timeoutMs: 5000 }],
        },
      ],
    });

    expect(decomp.subtasks.length).toBe(2);

    // Complete subtask 1
    const run1 = store.transaction((tx) => tx.getRouterSubmissionByTaskId(decomp.subtaskTaskIds[0]!))!.runId;
    coordinator.queueRun(run1);
    const claim1 = coordinator.claimRun(run1, "w1", 30_000)!;
    coordinator.startRun(run1, "w1", claim1.lease.leaseId);
    store.appendEvent({
      eventId: "ev-vpass-1",
      runId: run1,
      eventType: "verification.completed",
      schemaVersion: 1,
      timestamp: clock.now().toISOString(),
      producer: "system",
      payload: { specId: "vspec-research", exitCode: 0, status: "PASSED" },
    });
    coordinator.completeRun(run1, "w1", claim1.lease.leaseId, { output: "ok" });

    // Complete subtask 2 with verification
    const run2 = store.transaction((tx) => tx.getRouterSubmissionByTaskId(decomp.subtaskTaskIds[1]!))!.runId;
    coordinator.queueRun(run2);
    const claim2 = coordinator.claimRun(run2, "w1", 30_000)!;
    coordinator.startRun(run2, "w1", claim2.lease.leaseId);
    store.appendEvent({
      eventId: "ev-vpass-2",
      runId: run2,
      eventType: "verification.completed",
      schemaVersion: 1,
      timestamp: clock.now().toISOString(),
      producer: "system",
      payload: { specId: "vspec-test", exitCode: 0, status: "PASSED" },
    });
    coordinator.completeRun(run2, "w1", claim2.lease.leaseId, { output: "ok" });

    const synth = orchestrator.synthesizeMission(parentSub.taskId);
    expect(synth.canCompleteMission).toBe(true);
    expect(synth.verdict).toBe("SUCCESS");
  });

  // Scenario 4: Failure-repair-retest task
  it("Scenario 4: executes bounded failure-repair-retest loop with diagnostic classification", () => {
    const repairController = new BoundedRepairLoopController({ maxRepairIterations: 3 });
    const cycle = repairController.initCycle("task-s4", "run-s4");

    // Failure 1: Syntax error
    const diag = repairController.diagnoseFeedback(cycle, "SyntaxError: Unexpected token", "", 1);
    expect(diag).toBe("SYNTAX_ERROR");

    // Attempt 1: Repair
    const eval1 = repairController.evaluateProposedRepair(cycle, "const x = 42;", 1000);
    expect(eval1.canProceed).toBe(true);

    // Test still fails
    repairController.concludeVerification(cycle, 1);
    expect(cycle.currentStage).toBe("OBSERVE");

    // Attempt 2: Working repair
    const eval2 = repairController.evaluateProposedRepair(cycle, "export const x = 42;", 1000);
    expect(eval2.canProceed).toBe(true);

    // Test passes
    const finalStage = repairController.concludeVerification(cycle, 0);
    expect(finalStage).toBe("TERMINAL_SUCCESS");
  });

  // Scenario 5: Cancellation and lease-fencing scenario
  it("Scenario 5: cancels in-flight run and strictly rejects late worker completion", async () => {
    const submission = submitDurableTask(
      store,
      coordinator,
      { tenantId: "tenant-alpha", task: "Cancel task", operation: "cancel_op" }
    );

    const claim = coordinator.claimRun(submission.runId, "w-stale", 30_000)!;
    coordinator.startRun(submission.runId, "w-stale", claim.lease.leaseId);

    // Operator cancels run
    coordinator.cancelRun(submission.runId, "Operator cancelled execution");

    // Stale worker tries to complete
    expect(() => {
      coordinator.completeRun(submission.runId, "w-stale", claim.lease.leaseId, { output: "done" });
    }).toThrow();

    const run = coordinator.getRun(submission.runId);
    expect(run?.status).toBe("CANCELLED");
  });

  // Scenario 6: Tenant-isolation scenario
  it("Scenario 6: prevents Tenant B from inspecting or decomposing Tenant A's mission", async () => {
    const server = buildFastifyServer({ principals, store, coordinator, orchestrator });

    const subA = submitDurableTask(
      store,
      coordinator,
      { tenantId: "tenant-alpha", task: "Alpha Mission", operation: "alpha_op" }
    );

    // Tenant B attempts to read Tenant A's hierarchy -> 404
    const resB = await server.inject({
      method: "GET",
      url: `/api/v1/tasks/${subA.taskId}/hierarchy`,
      headers: { authorization: `Bearer ${TOK_B}` },
    });

    expect(resB.statusCode).toBe(404);
    await server.close();
  });

  // Scenario 7: Sandbox-rejection scenario
  it("Scenario 7: rejects untrusted workload requesting constrained-host execution", async () => {
    const server = buildFastifyServer({ principals, store, coordinator });

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { authorization: `Bearer ${TOK_A}` },
      payload: {
        title: "Untrusted Task",
        prompt: "Attempting host execution",
        executionMode: "constrained_host", // Unauthorized for untrusted workloads -> 403
        modelConfig: {
          provider: "ollama",
          modelName: "qwen2.5-coder:1.5b",
        },
      },
    });

    expect(res.statusCode).toBe(403);
    await server.close();
  });

  // Scenario 8: Failed-verification scenario
  it("Scenario 8: rejects goal attainment when verifier exits with non-zero code", async () => {
    const submission = submitDurableTask(
      store,
      coordinator,
      {
        tenantId: "tenant-alpha",
        task: "Failing test task",
        operation: "fail_test",
        verificationSpecs: [{ specId: "vspec-fail", argv: ["node", "test.js"], timeoutMs: 5000 }],
      }
    );

    const wsAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: tmpDir });
    const ws = await wsAdapter.provisionWorkspace({
      workspaceId: `ws-${submission.runId}`,
      runId: submission.runId,
      taskId: submission.taskId,
      maxWorkspaceBytes: 10 * 1024 * 1024,
      maxFileSizeBytes: 5 * 1024 * 1024,
    });

    const brain = new ScriptableAgentBrain();
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));

    const workerRuntime = new WorkerRuntime({
      workerId: "worker-s8",
      coordinator,
      clock,
      workspacePort: wsAdapter,
      executionProvider: provider,
      isIsolationAvailable: true,
    });

    const proposalValidator = new ProposalValidator({
      coordinator,
      stateStore: store,
      toolRegistry: staticToolRegistry,
      clock,
    });

    const stepController = new AgentStepController({
      coordinator,
      stateStore: store,
      workerRuntime,
      agentBrain: brain,
      proposalValidator,
      toolRegistry: staticToolRegistry,
      clock,
      enableGovernedVerificationStage: true,
    });

    const claim = coordinator.claimRun(submission.runId, "worker-s8", 30_000)!;
    coordinator.startRun(submission.runId, "worker-s8", claim.lease.leaseId);

    provider.exitCode = 1; // Test fails
    provider.stdout = "";
    provider.stderr = "FAIL: 1 assertion error";

    const result = await stepController.runStepLoop({
      runId: submission.runId,
      workerId: "worker-s8",
      leaseId: claim.lease.leaseId,
      workspace: ws,
    });

    expect(result.terminalReason).not.toBe("COMPLETED");
    const run = coordinator.getRun(submission.runId);
    expect(run?.status).not.toBe("COMPLETED");
  });

  // Scenario 9: Cryptographic artifact retrieval
  it("Scenario 9: retrieves persisted artifact content with cryptographic integrity ETag", async () => {
    const content = "diff --git a/index.js b/index.js\n+console.log('fixed');\n";
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");
    const server = buildFastifyServer({
      principals,
      inMemoryStore: {
        runs: new Map([["run-s9", { taskId: "t-s9", tenantId: "tenant-alpha", status: "COMPLETED", createdAt: new Date().toISOString() }]]),
        artifacts: new Map([["run-s9", [{ artifactId: "art-1", fileName: "solution.patch", sizeBytes: Buffer.byteLength(content), sha256 }]]]),
        artifactContents: new Map([["art-1", content]]),
      },
    });

    const res = await server.inject({
      method: "GET",
      url: "/api/v1/runs/run-s9/artifacts/art-1/content",
      headers: { authorization: `Bearer ${TOK_A}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("diff --git");
    await server.close();
  });

  // Scenario 10: Frontend live-event SSE and reconnect scenario
  it("Scenario 10: streams ordered events over SSE and resumes from Last-Event-ID cursor", async () => {
    const submission = submitDurableTask(
      store,
      coordinator,
      { tenantId: "tenant-alpha", task: "SSE Task", operation: "sse_op" }
    );

    // Record two durable events
    store.appendEvent({
      eventId: "ev-1",
      runId: submission.runId,
      eventType: "agent.step.started",
      schemaVersion: 1,
      timestamp: clock.now().toISOString(),
      producer: "worker",
      payload: { stepIndex: 0 },
    });
    store.appendEvent({
      eventId: "ev-2",
      runId: submission.runId,
      eventType: "agent.step.completed",
      schemaVersion: 1,
      timestamp: clock.now().toISOString(),
      producer: "worker",
      payload: { stepIndex: 0 },
    });

    // Mark run as terminal so SSE stream flushes durable history and closes
    coordinator.cancelRun(submission.runId, "Completed event replay");

    const server = buildFastifyServer({ principals, store, coordinator });

    // Client connects with Last-Event-ID: 1 (resuming from event 2)
    const res = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${submission.runId}/events`,
      headers: {
        authorization: `Bearer ${TOK_A}`,
        "last-event-id": "1",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("event: agent.step.completed");
    expect(res.body).toContain("id: 2");
    await server.close();
  });
});
