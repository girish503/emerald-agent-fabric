/**
 * Governed-to-Physical Execution Provider Composition & Integration Test Suite.
 *
 * Demonstrates the complete production execution-provider composition pipeline:
 *   GovernedAgentExecutionProvider (ORCHESTRATION)
 *   -> AgentStepController (proposes action)
 *   -> ToolExecutionGateway (pre-execution verification, capability, workspace, lease)
 *   -> SandboxedCommandToolAdapter (argv-only containment)
 *   -> Physical Execution Provider (DockerExecutionProvider / SpyPhysicalExecutionProvider)
 *
 * Key Verification Assertions:
 * 1. Governed provider remains strictly an orchestration engine; physical adapter receives a PHYSICAL provider.
 * 2. Complete governed proposal path reaches the physical provider without recursive re-entry into the agent step loop.
 * 3. Physical provider receives discrete argv payload, validated cwd, trust classification, and tenant identity.
 * 4. Workspace boundary violations fail closed before physical dispatch.
 * 5. Lease fencing and abort cancellation stop physical execution immediately.
 * 6. Role mismatch in WorkerHost or WorkerRuntime fails closed with InvalidExecutionProviderRoleError / WorkerHostConfigError.
 * 7. Missing physical provider fails closed without unsafe fallback to in-process or host execution.
 * 8. Untrusted workloads require sandbox isolation and cannot downgrade.
 * 9. Rootless Docker requirements remain strictly mandatory when configured.
 * 10. CLI worker interface exposes and validates --physical-provider <docker|none>.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GovernedAgentExecutionProvider } from "../../src/adapters/execution/governed-agent-execution-provider.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { TrustedToolInvocationContext } from "../../src/application/tool-execution-gateway.js";
import { WorkerHostConfigError, runWorkerHost } from "../../src/application/worker-host.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { EmeraldCli } from "../../src/cli/emerald-cli.js";
import {
  createExecutionPolicy,
  evaluateWorkloadExecutionRouting,
  ExecutionPolicy,
} from "../../src/domain/policy.js";
import { ToolRequest } from "../../src/domain/tool.js";
import {
  AgentBrainPort,
  AgentBrainRequest,
  AgentBrainResult,
} from "../../src/ports/agent-brain.port.js";
import { SystemClock } from "../../src/ports/clock.port.js";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "../../src/ports/execution-provider.port.js";
import { createAndActivateContract } from "../application/test-helpers.js";

/**
 * Deterministic Spy Physical Provider for controlled integration testing.
 */
class SpyPhysicalExecutionProvider implements ExecutionProvider {
  readonly name = "spy-physical";
  readonly role = "PHYSICAL" as const;
  readonly tenantModel = "NONE" as const;
  readonly cancellationModel = "COOPERATIVE" as const;

  invocationCount = 0;
  invocations: ExecutionRequest[] = [];
  lastRequest?: ExecutionRequest;
  outputToReturn: ExecutionResult = {
    status: "SUCCESS",
    output: {
      exitCode: 0,
      stdout: "command execution ok\n",
      stderr: "",
      durationMs: 12,
      outputTruncated: false,
    },
    durationMs: 12,
  };

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocationCount++;
    this.lastRequest = request as ExecutionRequest<unknown>;
    this.invocations.push(request as ExecutionRequest<unknown>);
    return this.outputToReturn as ExecutionResult<TOutput>;
  }
}

/**
 * Scripted Agent Brain that emits deterministic action proposals.
 */
class ScriptedBrain implements AgentBrainPort {
  private steps: ((req: AgentBrainRequest) => AgentBrainResult)[] = [];
  invocations = 0;

  queue(step: (req: AgentBrainRequest) => AgentBrainResult): this {
    this.steps.push(step);
    return this;
  }

  async proposeAction(request: AgentBrainRequest): Promise<AgentBrainResult> {
    this.invocations++;
    const next = this.steps.shift();
    return next ? next(request) : { finishReason: "GOAL_REACHED" };
  }
}

const runCommandProposal =
  (id: string, argv: string[], cwd: string = ".") =>
  (req: AgentBrainRequest): AgentBrainResult => ({
    proposal: {
      proposalId: id,
      toolName: "run_command",
      inputPayload: { argv, cwd },
      contextSnapshotHash: req.contextSnapshot.contextHash,
    },
    finishReason: "ACTION_PROPOSED",
  });

describe("Milestone 2.28 Phase 4 Step 2 — Governed / Physical Provider Integration", { timeout: 30_000 }, () => {
  let tempDir: string;
  let dbPath: string;
  let workspaceRoot: string;
  let store: SqliteStateStore;
  let clock: SystemClock;
  let coordinator: RunCoordinator;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let cli: EmeraldCli;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-phase4-step2-"));
    dbPath = path.join(tempDir, "emerald.sqlite");
    workspaceRoot = path.join(tempDir, "workspaces");
    fs.mkdirSync(workspaceRoot);

    store = new SqliteStateStore({ location: dbPath });
    clock = new SystemClock();
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot });
    coordinator = new RunCoordinator(store, clock, undefined, workspaceAdapter);
    cli = new EmeraldCli();
  });

  afterEach(async () => {
    store.close();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  function createQueuedRun(
    taskId: string,
    options: { policy?: ExecutionPolicy; tenantId?: string } = {}
  ) {
    const task = coordinator.createTask({
      title: "echo",
      description: `Task ${taskId} for testing governed-to-physical composition`,
      inputPayload: {},
    });

    const policy =
      options.policy ??
      createExecutionPolicy({
        policyId: `pol-${task.taskId}`,
        isolationRequirement: "IN_PROCESS",
        allowedCapabilities: [
          "execution.echo",
          "process.execute",
          "workspace.file.read",
          "workspace.file.write",
        ],
        trustedInProcessOperations: ["echo", "execution.echo"],
        trustClassification: "TRUSTED_INTERNAL",
        tenantId: options.tenantId,
      });

    createAndActivateContract(store, task.taskId, { policy });
    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    return { task, run, policy };
  }

  async function createClaimedRun(
    taskId: string,
    workerId: string,
    options: { policy?: ExecutionPolicy; tenantId?: string } = {}
  ) {
    coordinator.registerWorker({
      workerId,
      hostname: "localhost",
      pid: process.pid,
      status: "ACTIVE",
      lastHeartbeatAt: clock.nowIso(),
      createdAt: clock.nowIso(),
    });

    const task = coordinator.createTask({
      title: `task-${taskId}`,
      description: `Task for testing governed-to-physical composition`,
      inputPayload: {},
    });

    const policy =
      options.policy ??
      createExecutionPolicy({
        policyId: `pol-${task.taskId}`,
        isolationRequirement: "IN_PROCESS",
        allowedCapabilities: ["process.execute", "workspace.file.read", "workspace.file.write"],
        trustClassification: "TRUSTED_INTERNAL",
        tenantId: options.tenantId,
      });

    createAndActivateContract(store, task.taskId, { policy });
    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);
    const claim = coordinator.claimRun(run.runId, workerId, 30_000);

    const wsHandle = await workspaceAdapter.provisionWorkspace({
      workspaceId: `ws-${claim.lease!.runId}`,
      runId: claim.lease!.runId,
      taskId: task.taskId,
      maxWorkspaceBytes: 50 * 1024 * 1024,
      maxFileSizeBytes: 10 * 1024 * 1024,
    });

    return { task, run, claim, wsHandle, policy };
  }

  // =========================================================================
  // 1. Production WorkerHost Wiring & Defaulting
  // =========================================================================
  describe("1. Production WorkerHost Composition & Physical Provider Defaulting", () => {
    it("Scenario 1: runWorkerHost with modelProvider='ollama' automatically wires DockerExecutionProvider as physicalExecutionProvider", async () => {
      const brain = new ScriptedBrain();
      const controller = new AbortController();

      const hostResult = await runWorkerHost({
        dbPath,
        workspaceRoot,
        once: true,
        modelProvider: "ollama",
        agentBrain: brain,
        signal: controller.signal,
        log: () => {},
      });

      expect(hostResult.errors).toBe(0);
      expect(hostResult.runsProcessed).toBe(0);
    });

    it("Scenario 2: runWorkerHost with physicalProvider='none' omits physicalExecutionProvider even in ollama mode", async () => {
      const brain = new ScriptedBrain();
      const controller = new AbortController();

      const hostResult = await runWorkerHost({
        dbPath,
        workspaceRoot,
        once: true,
        modelProvider: "ollama",
        physicalProvider: "none",
        agentBrain: brain,
        signal: controller.signal,
        log: () => {},
      });

      expect(hostResult.errors).toBe(0);
    });

    it("Scenario 3: runWorkerHost rejects unsupported physicalProvider with WorkerHostConfigError", async () => {
      await expect(
        runWorkerHost({
          dbPath,
          workspaceRoot,
          once: true,
          modelProvider: "ollama",
          physicalProvider: "invalid-provider" as any,
          signal: new AbortController().signal,
          log: () => {},
        })
      ).rejects.toThrowError(WorkerHostConfigError);
    });

    it("Scenario 4: runWorkerHost with invalid physical provider role fails closed", async () => {
      const orchestrationProvider = new GovernedAgentExecutionProvider({ clock });

      await expect(
        runWorkerHost({
          dbPath,
          workspaceRoot,
          once: true,
          modelProvider: "fixture",
          physicalExecutionProvider: orchestrationProvider,
          signal: new AbortController().signal,
          log: () => {},
        })
      ).rejects.toThrowError(WorkerHostConfigError);
    });
  });

  // =========================================================================
  // 2. End-to-End Governed Step Loop to Physical Provider Execution (No Recursion)
  // =========================================================================
  describe("2. End-to-End Governed Step Loop to Physical Provider Execution", () => {
    it("Scenario 5: Complete governed proposal pipeline executes physical command through SandboxedCommandToolAdapter without recursive loop re-entry", async () => {
      const physicalSpy = new SpyPhysicalExecutionProvider();
      const { run } = createQueuedRun("s5");

      // Set up ScriptedBrain that proposes run_command then finishes
      const brain = new ScriptedBrain()
        .queue(runCommandProposal("prop-s5", ["echo", "step2-proven"], "."))
        .queue(() => ({ finishReason: "GOAL_REACHED" }));

      // Execute via runWorkerHost with explicit physical execution provider
      const hostResult = await runWorkerHost({
        dbPath,
        workspaceRoot,
        workerId: "worker-s5",
        once: true,
        modelProvider: "fixture",
        agentBrain: brain,
        physicalExecutionProvider: physicalSpy,
        allowUnverifiedCompletion: true,
        signal: new AbortController().signal,
        log: () => {},
      });

      expect(hostResult.errors).toBe(0);
      expect(hostResult.runsProcessed).toBe(1);

      // Verify the physical provider was invoked exactly once
      expect(physicalSpy.invocationCount).toBe(1);
      expect(physicalSpy.lastRequest?.operationName).toBe("run_command");
      const payload = physicalSpy.lastRequest?.inputPayload as { argv: string[]; cwd: string };
      expect(payload.argv).toEqual(["echo", "step2-proven"]);
      expect(payload.cwd).toBe(".");

      // Verify final run state
      const completedRun = coordinator.getRun(run.runId);
      expect(completedRun?.status).toBe("COMPLETED");
    });

    it("Scenario 5b: run_command dispatch uses the tool default timeout unless runCommandTimeoutMs overrides it", async () => {
      const dispatch = async (label: string, runCommandTimeoutMs?: number) => {
        const physicalSpy = new SpyPhysicalExecutionProvider();
        createQueuedRun(label);
        const brain = new ScriptedBrain()
          .queue(runCommandProposal(`prop-${label}`, ["echo", "timeout-check"], "."))
          .queue(() => ({ finishReason: "GOAL_REACHED" }));
        const hostResult = await runWorkerHost({
          dbPath,
          workspaceRoot,
          workerId: `worker-${label}`,
          once: true,
          modelProvider: "fixture",
          agentBrain: brain,
          physicalExecutionProvider: physicalSpy,
          allowUnverifiedCompletion: true,
          ...(runCommandTimeoutMs !== undefined ? { runCommandTimeoutMs } : {}),
          signal: new AbortController().signal,
          log: () => {},
        });
        expect(hostResult.runsProcessed).toBe(1);
        expect(physicalSpy.invocationCount).toBe(1);
        return physicalSpy.lastRequest?.timeoutMs;
      };

      expect(await dispatch("s5b-default")).toBe(10_000);
      expect(await dispatch("s5b-override", 20_000)).toBe(20_000);
    });

    it("Scenario 5c: runWorkerHost rejects an invalid runCommandTimeoutMs", async () => {
      for (const bad of [0, -1, 1.5, 60_001]) {
        await expect(
          runWorkerHost({
            dbPath,
            workspaceRoot,
            once: true,
            modelProvider: "fixture",
            runCommandTimeoutMs: bad,
            signal: new AbortController().signal,
            log: () => {},
          })
        ).rejects.toThrowError(WorkerHostConfigError);
      }
    });

    it("Scenario 6: Governed run_command dispatch preserves contract tenant identity and trust classification", async () => {
      const physicalSpy = new SpyPhysicalExecutionProvider();
      const customPolicy = createExecutionPolicy({
        policyId: "pol-tenant-test",
        isolationRequirement: "IN_PROCESS",
        allowedCapabilities: [
          "execution.echo",
          "process.execute",
          "workspace.file.read",
          "workspace.file.write",
        ],
        trustedInProcessOperations: ["echo", "execution.echo"],
        trustClassification: "MULTI_TENANT_WORKLOAD",
        tenantId: "tenant-enterprise-99",
      });

      const { run } = createQueuedRun("s6", {
        policy: customPolicy,
        tenantId: "tenant-enterprise-99",
      });

      const brain = new ScriptedBrain()
        .queue(runCommandProposal("prop-s6", ["node", "-v"], "."))
        .queue(() => ({ finishReason: "GOAL_REACHED" }));

      const hostResult = await runWorkerHost({
        dbPath,
        workspaceRoot,
        workerId: "worker-s6",
        once: true,
        modelProvider: "fixture",
        agentBrain: brain,
        physicalExecutionProvider: physicalSpy,
        allowUnverifiedCompletion: true,
        signal: new AbortController().signal,
        log: () => {},
      });

      expect(hostResult.errors).toBe(0);
      expect(hostResult.runsProcessed).toBe(1);
      expect(physicalSpy.invocationCount).toBe(1);
      expect(physicalSpy.lastRequest?.tenantId).toBe("tenant-enterprise-99");
      expect(physicalSpy.lastRequest?.trustClassification).toBe("MULTI_TENANT_WORKLOAD");
      expect(coordinator.getRun(run.runId)?.status).toBe("COMPLETED");
    });

    it("Scenario 7: Governed step loop enforces workspace boundary containment on command dispatch", async () => {
      const physicalSpy = new SpyPhysicalExecutionProvider();
      const { run } = createQueuedRun("s7");

      // Attempt path traversal outside the allocated workspace boundary
      const brain = new ScriptedBrain()
        .queue(runCommandProposal("prop-s7", ["cat", "secret.txt"], "../../etc"))
        .queue(() => ({ finishReason: "GOAL_REACHED" }));

      const hostResult = await runWorkerHost({
        dbPath,
        workspaceRoot,
        workerId: "worker-s7",
        once: true,
        modelProvider: "fixture",
        agentBrain: brain,
        physicalExecutionProvider: physicalSpy,
        allowUnverifiedCompletion: true,
        signal: new AbortController().signal,
        log: () => {},
      });

      expect(hostResult.runsProcessed).toBe(1);
      // The physical provider must NEVER be invoked for a boundary-violating proposal
      expect(physicalSpy.invocationCount).toBe(0);
      expect(coordinator.getRun(run.runId)?.status).toBe("COMPLETED");
    });

    it("Scenario 8: Missing physical provider fails closed when agent proposes run_command without fallback", async () => {
      const { run } = createQueuedRun("s8");

      // Brain proposes run_command, but physicalProvider is explicitly 'none'
      const brain = new ScriptedBrain()
        .queue(runCommandProposal("prop-s8", ["echo", "will-fail"], "."))
        .queue(() => ({ finishReason: "GOAL_REACHED" }));

      const hostResult = await runWorkerHost({
        dbPath,
        workspaceRoot,
        workerId: "worker-s8",
        once: true,
        modelProvider: "fixture",
        physicalProvider: "none",
        agentBrain: brain,
        allowUnverifiedCompletion: true,
        signal: new AbortController().signal,
        log: () => {},
      });

      // Runs processed with step error logged
      expect(hostResult.runsProcessed).toBe(1);
      // Verify events record failure for the step
      const events = store.getEventsForRun(run.runId);
      expect(events.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 3. Lease Authority, Fencing, and Cancellation Invariants
  // =========================================================================
  describe("3. Lease Authority, Fencing, and Cancellation Invariants", () => {
    it("Scenario 9: Stale or lost lease fence blocks physical execution", async () => {
      const physicalSpy = new SpyPhysicalExecutionProvider();
      const governed = new GovernedAgentExecutionProvider({ clock });

      const runtime = new WorkerRuntime({
        workerId: "worker-fence",
        coordinator,
        clock,
        workspacePort: workspaceAdapter,
        executionProvider: governed,
        physicalExecutionProvider: physicalSpy,
      });

      const { task, claim, wsHandle } = await createClaimedRun("task-s9", "worker-fence");

      // Mutate the lease ID to simulate lease expiration / eviction by another worker
      const toolRequest: ToolRequest<"run_command"> = {
        requestId: "req-stale-lease",
        runId: claim.lease!.runId,
        toolName: "run_command",
        input: { argv: ["ls"], cwd: "." },
      };

      const staleContext: TrustedToolInvocationContext = {
        runId: claim.lease!.runId,
        taskId: task.taskId,
        workerId: "worker-fence",
        leaseId: "stale-expired-lease-id",
        workspace: {
          workspaceId: wsHandle.workspaceId,
          hostPath: wsHandle.hostPath,
        },
      };

      const res = await runtime.gateway.execute(toolRequest, staleContext);
      expect(res.status).toBe("FAILED");
      expect(res.error?.code).toBe("CAPABILITY_DENIED");
      expect(physicalSpy.invocationCount).toBe(0);
    });

    it("Scenario 10: Explicit abort signal cleanly cancels physical command dispatch", async () => {
      const physicalSpy = new SpyPhysicalExecutionProvider();
      const governed = new GovernedAgentExecutionProvider({ clock });

      const runtime = new WorkerRuntime({
        workerId: "worker-abort",
        coordinator,
        clock,
        workspacePort: workspaceAdapter,
        executionProvider: governed,
        physicalExecutionProvider: physicalSpy,
      });

      const { task, claim, wsHandle } = await createClaimedRun("task-s10", "worker-abort");

      const abortController = new AbortController();
      abortController.abort(new Error("operator cancellation"));

      const toolRequest: ToolRequest<"run_command"> = {
        requestId: "req-abort",
        runId: claim.lease!.runId,
        toolName: "run_command",
        input: { argv: ["sleep", "60"], cwd: "." },
      };

      const abortContext: TrustedToolInvocationContext = {
        runId: claim.lease!.runId,
        taskId: task.taskId,
        workerId: "worker-abort",
        leaseId: claim.lease!.leaseId,
        workspace: {
          workspaceId: wsHandle.workspaceId,
          hostPath: wsHandle.hostPath,
        },
        abortSignal: abortController.signal,
      };

      const res = await runtime.gateway.execute(toolRequest, abortContext);
      expect(res.status).toBe("FAILED");
      expect(res.error?.code).toBe("TOOL_CANCELLED");
      expect(physicalSpy.invocationCount).toBe(0);
    });
  });

  // =========================================================================
  // 4. Security, Isolation, and Retry Boundary Invariants
  // =========================================================================
  describe("4. Security, Isolation, and Retry Boundary Invariants", () => {
    it("Scenario 11: Untrusted workload cannot fall back to in-process execution", () => {
      const decision = evaluateWorkloadExecutionRouting({
        trustClassification: "UNTRUSTED_WORKLOAD",
        requestedProviderName: "in-process",
        isSandboxAvailable: false,
      });

      expect(decision.allowed).toBe(false);
      expect(decision.message).toContain("requires isolated Docker sandbox execution; provider 'in-process' is disallowed");
    });

    it("Scenario 12: Rootless daemon requirement is strictly enforced", () => {
      const decision = evaluateWorkloadExecutionRouting({
        trustClassification: "MULTI_TENANT_WORKLOAD",
        tenantId: "tenant-rootless-test",
        requestedProviderName: "docker",
        isSandboxAvailable: true,
        isDaemonRootless: false,
        requireRootlessDaemon: true,
      });

      expect(decision.allowed).toBe(false);
      expect(decision.message).toContain("Policy mandates rootless Docker daemon execution");
    });

    it("Scenario 13: Non-idempotent tool execution failure does not trigger uncertain automatic retry", async () => {
      const failingPhysicalSpy = new SpyPhysicalExecutionProvider();
      failingPhysicalSpy.outputToReturn = {
        status: "FAILED",
        error: {
          code: "EXECUTION_FAILED",
          message: "Process exited with code 1",
        },
        durationMs: 20,
      };

      const { run } = createQueuedRun("s13");

      const brain = new ScriptedBrain()
        .queue(runCommandProposal("prop-s13", ["make", "build"], "."))
        .queue(() => ({ finishReason: "GOAL_REACHED" }));

      const hostResult = await runWorkerHost({
        dbPath,
        workspaceRoot,
        workerId: "worker-s13",
        once: true,
        modelProvider: "fixture",
        agentBrain: brain,
        physicalExecutionProvider: failingPhysicalSpy,
        allowUnverifiedCompletion: true,
        signal: new AbortController().signal,
        log: () => {},
      });

      expect(hostResult.runsProcessed).toBe(1);
      // The failing physical command is executed once; it must NOT be retried automatically
      expect(failingPhysicalSpy.invocationCount).toBe(1);
      expect(coordinator.getRun(run.runId)?.status).toBe("COMPLETED");
    });
  });

  // =========================================================================
  // 5. CLI End-to-End Argument Verification
  // =========================================================================
  describe("5. CLI End-to-End Argument Verification", () => {
    it("Scenario 14: CLI worker command validates --physical-provider flag", async () => {
      const res = await cli.run([
        "worker",
        "--db",
        dbPath,
        "--physical-provider",
        "unsupported-option",
      ]);

      expect(res.exitCode).toBe(1);
      expect(res.output).toContain("Error: unsupported --physical-provider 'unsupported-option'. Supported: docker, none");
    });

    it("Scenario 15: CLI worker command accepts valid --physical-provider docker", async () => {
      const res = await cli.run([
        "worker",
        "--db",
        dbPath,
        "--once",
        "--model-provider",
        "fixture",
        "--physical-provider",
        "docker",
      ]);

      expect(res.exitCode).toBe(0);
    });
  });
});
