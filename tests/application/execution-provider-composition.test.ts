/**
 * Execution-Provider Composition Integrity Tests (Milestone 2.28 Phase 4 Step 1)
 *
 * Verifies:
 * 1. Provider Composition & Separation:
 *    - Governed orchestration provider is never injected as a physical command executor.
 *    - Physical command adapter receives a PHYSICAL provider.
 *    - ORCHESTRATION provider supplied to a physical adapter/registry is rejected fail-closed.
 *    - WorkerRuntime rejects ORCHESTRATION provider as physicalExecutionProvider.
 *    - Zero recursive re-entry into the agent step loop when executing a physical command.
 * 2. Tool Gateway & Policy:
 *    - Physical execution routes through the governed tool gateway.
 *    - Unauthorized tool proposals remain rejected.
 *    - Trust classification and tenant identity reach the physical provider unchanged.
 *    - Workspace and lexical execution constraints remain enforced.
 *    - Cancellation and timeout behavior remains intact.
 * 3. Isolation & Fallback:
 *    - Untrusted workloads require validated Docker sandbox provider.
 *    - Rootful Docker rejected where rootless is mandatory.
 *    - Missing Docker fails closed for untrusted workloads.
 *    - No in-process fallback occurs for untrusted/adversarial workloads.
 *    - Trusted internal evaluation fixtures continue to use permitted paths.
 *    - Zero host fallback is permitted.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GovernedAgentExecutionProvider } from "../../src/adapters/execution/governed-agent-execution-provider.js";
import { InProcessExecutionProvider } from "../../src/adapters/execution/in-process-execution-provider.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { SandboxedCommandToolAdapter } from "../../src/adapters/tools/sandboxed-command.tool-adapter.js";
import { createWorkspaceToolAdapterRegistry } from "../../src/adapters/tools/tool-adapter-registry.factory.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { ToolExecutionGateway, TrustedToolInvocationContext } from "../../src/application/tool-execution-gateway.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import {
  InvalidExecutionProviderRoleError,
  ToolCancelledError,
  ToolWorkspaceBoundaryViolationError,
} from "../../src/domain/errors.js";
import {
  createExecutionPolicy,
  evaluateWorkloadExecutionRouting,
  ExecutionPolicy,
} from "../../src/domain/policy.js";
import { ToolRequest } from "../../src/domain/tool.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "../../src/ports/execution-provider.port.js";
import { ToolExecutionContext } from "../../src/ports/tool-adapter.port.js";
import { createAndActivateContract } from "./test-helpers.js";

class SpyPhysicalExecutionProvider implements ExecutionProvider {
  readonly tenantModel = "NONE" as const;
  readonly quiescence = { async quiesceRun(_runId: string) { return { status: "QUIESCENT" as const, stopped: 0 }; } };
  readonly name = "spy-physical";
  readonly role = "PHYSICAL" as const;
  public invocationCount = 0;
  public lastRequest?: ExecutionRequest<any>;

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocationCount++;
    this.lastRequest = request;
    return {
      status: "SUCCESS",
      output: {
        exitCode: 0,
        stdout: "command output",
        stderr: "",
        durationMs: 5,
        timedOut: false,
      } as unknown as TOutput,
      durationMs: 5,
    };
  }
}

class SpyOrchestrationExecutionProvider implements ExecutionProvider {
  readonly tenantModel = "NONE" as const;
  readonly quiescence = { async quiesceRun(_runId: string) { return { status: "QUIESCENT" as const, stopped: 0 }; } };
  readonly name = "spy-orchestration";
  readonly role = "ORCHESTRATION" as const;
  public invocationCount = 0;

  async execute<TInput = unknown, TOutput = unknown>(
    _request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocationCount++;
    return {
      status: "SUCCESS",
      durationMs: 1,
    };
  }
}

describe("Milestone 2.28 Phase 4 Step 1 — Execution-Provider Composition Integrity", () => {
  let tempDir: string;
  let dbPath: string;
  let workspaceRoot: string;
  let stateStore: SqliteStateStore;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let coordinator: RunCoordinator;
  let clock: SettableClock;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "emerald-provider-comp-"));
    dbPath = path.join(tempDir, "state.db");
    workspaceRoot = path.join(tempDir, "workspaces");
    await fs.mkdir(workspaceRoot, { recursive: true });

    stateStore = new SqliteStateStore({ location: dbPath });
    clock = new SettableClock(new Date("2026-11-09T10:00:00.000Z"));
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot });
    coordinator = new RunCoordinator(stateStore, clock, undefined, workspaceAdapter);
  });

  afterAll(async () => {
    stateStore.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function setupClaimedRun(taskId: string, workerId: string, policy?: ExecutionPolicy) {
    coordinator.registerWorker({
      workerId,
      hostname: "localhost",
      pid: process.pid,
      status: "ACTIVE",
      lastHeartbeatAt: clock.nowIso(),
      createdAt: clock.nowIso(),
    });
    const task = coordinator.createTask({
      title: `title-${taskId}`,
      description: `desc-${taskId}`,
      inputPayload: {},
    });
    createAndActivateContract(stateStore, task.taskId, {
      policy:
        policy ??
        createExecutionPolicy({
          policyId: `pol-${task.taskId}`,
          isolationRequirement: "IN_PROCESS",
          allowedCapabilities: ["process.execute"],
          trustClassification: "TRUSTED_INTERNAL",
        }),
    });
    const createResult = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(createResult.run.runId);
    const claim = coordinator.claimRun(createResult.run.runId, workerId, 30000);
    const wsHandle = await workspaceAdapter.provisionWorkspace({
      workspaceId: `ws-${claim.lease!.runId}`,
      runId: claim.lease!.runId,
      taskId: task.taskId,
      maxWorkspaceBytes: 50 * 1024 * 1024,
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
    return { task, run: createResult.run, claim, wsHandle };
  }

  describe("1. Provider Composition & Separation", () => {
    it("Scenario 1: Governed orchestration provider is not injected as physical command executor", async () => {
      const governedProvider = new GovernedAgentExecutionProvider({ clock });

      const runtime = new WorkerRuntime({
        workerId: "worker-orch-only",
        coordinator,
        clock,
        workspacePort: workspaceAdapter,
        executionProvider: governedProvider,
        // physicalExecutionProvider is omitted
      });

      // Attempting to dispatch run_command via this runtime's toolGateway must fail closed
      // because SandboxedCommandToolAdapter was not registered with the orchestration provider.
      const { task, claim, wsHandle } = await setupClaimedRun("task-s1", "worker-orch-only");

      const toolRequest: ToolRequest<"run_command"> = {
        requestId: "req-s1",
        runId: claim.lease!.runId,
        toolName: "run_command",
        input: { argv: ["echo", "test"], cwd: "." },
      };

      const invocationContext: TrustedToolInvocationContext = {
        runId: claim.lease!.runId,
        taskId: task.taskId,
        workerId: "worker-orch-only",
        leaseId: claim.lease!.leaseId,
        workspace: {
          workspaceId: wsHandle.workspaceId,
          hostPath: wsHandle.hostPath,
        },
      };

      const result = await runtime["toolGateway"].execute(toolRequest, invocationContext);
      expect(result.status).toBe("FAILED");
      expect(result.error?.message).toContain("No adapter registered for tool 'run_command'");
    });

    it("Scenario 2: Physical command adapter accepts a PHYSICAL provider", () => {
      const physical = new SpyPhysicalExecutionProvider();
      expect(() => new SandboxedCommandToolAdapter(physical, workspaceAdapter)).not.toThrow();
    });

    it("Scenario 3: An ORCHESTRATION provider supplied to a physical adapter is rejected fail-closed", () => {
      const orchestration = new SpyOrchestrationExecutionProvider();
      expect(() => new SandboxedCommandToolAdapter(orchestration, workspaceAdapter)).toThrowError(
        InvalidExecutionProviderRoleError
      );
    });

    it("Scenario 4: createWorkspaceToolAdapterRegistry rejects an ORCHESTRATION provider", () => {
      const orchestration = new SpyOrchestrationExecutionProvider();
      expect(() =>
        createWorkspaceToolAdapterRegistry(workspaceAdapter, orchestration)
      ).toThrowError(InvalidExecutionProviderRoleError);
    });

    it("Scenario 5: WorkerRuntime rejects ORCHESTRATION provider as physicalExecutionProvider", () => {
      const governed = new GovernedAgentExecutionProvider({ clock });
      const orchestration = new SpyOrchestrationExecutionProvider();

      expect(
        () =>
          new WorkerRuntime({
            coordinator,
            clock,
            executionProvider: governed,
            physicalExecutionProvider: orchestration,
          })
      ).toThrowError(InvalidExecutionProviderRoleError);
    });

    it("Scenario 6: No recursive call into governed step loop occurs when tool proposal executes physical command", async () => {
      const governed = new GovernedAgentExecutionProvider({ clock });
      const physicalSpy = new SpyPhysicalExecutionProvider();

      const runtime = new WorkerRuntime({
        workerId: "worker-separate",
        coordinator,
        clock,
        workspacePort: workspaceAdapter,
        executionProvider: governed,
        physicalExecutionProvider: physicalSpy,
      });

      const { task, claim, wsHandle } = await setupClaimedRun("task-s6", "worker-separate");

      const toolRequest: ToolRequest<"run_command"> = {
        requestId: "req-s6",
        runId: claim.lease!.runId,
        toolName: "run_command",
        input: { argv: ["echo", "hello"], cwd: "." },
      };

      const invocationContext: TrustedToolInvocationContext = {
        runId: claim.lease!.runId,
        taskId: task.taskId,
        workerId: "worker-separate",
        leaseId: claim.lease!.leaseId,
        workspace: {
          workspaceId: wsHandle.workspaceId,
          hostPath: wsHandle.hostPath,
        },
      };

      const result = await runtime["toolGateway"].execute(toolRequest, invocationContext);
      expect(result.status).toBe("SUCCESS");
      expect(physicalSpy.invocationCount).toBe(1);
      expect(physicalSpy.lastRequest?.operationName).toBe("run_command");
    });
  });

  describe("2. Tool Gateway & Policy", () => {
    it("Scenario 7: Physical execution still occurs through the governed tool gateway", async () => {
      const physicalSpy = new SpyPhysicalExecutionProvider();
      const registry = createWorkspaceToolAdapterRegistry(workspaceAdapter, physicalSpy);
      const gateway = new ToolExecutionGateway({
        adapterRegistry: registry,
        coordinator,
        stateStore,
        clock,
        isIsolationAvailable: () => Promise.resolve(true),
      });

      const { task, claim, wsHandle } = await setupClaimedRun("task-s7", "worker-gw");

      const res = await gateway.execute(
        {
          requestId: "req-s7",
          runId: claim.lease!.runId,
          toolName: "run_command",
          input: { argv: ["ls", "-la"], cwd: "." },
        },
        {
          runId: claim.lease!.runId,
          taskId: task.taskId,
          workerId: "worker-gw",
          leaseId: claim.lease!.leaseId,
          workspace: {
            workspaceId: wsHandle.workspaceId,
            hostPath: wsHandle.hostPath,
          },
        }
      );

      expect(res.status).toBe("SUCCESS");
      expect(physicalSpy.invocationCount).toBe(1);
    });

    it("Scenario 8: Unauthorized tool proposals remain rejected", async () => {
      const physicalSpy = new SpyPhysicalExecutionProvider();
      const registry = createWorkspaceToolAdapterRegistry(workspaceAdapter, physicalSpy);
      const gateway = new ToolExecutionGateway({
        adapterRegistry: registry,
        coordinator,
        stateStore,
        clock,
        isIsolationAvailable: () => Promise.resolve(true),
      });

      // Contract does NOT allow SYSTEM_COMMAND_EXECUTE
      const { task, claim, wsHandle } = await setupClaimedRun(
        "task-s8",
        "worker-gw",
        createExecutionPolicy({
          policyId: "pol-unauth",
          isolationRequirement: "IN_PROCESS",
          allowedCapabilities: ["FILE_READ"],
          trustClassification: "TRUSTED_INTERNAL",
        })
      );

      const res = await gateway.execute(
        {
          requestId: "req-s8",
          runId: claim.lease!.runId,
          toolName: "run_command",
          input: { argv: ["echo", "fail"], cwd: "." },
        },
        {
          runId: claim.lease!.runId,
          taskId: task.taskId,
          workerId: "worker-gw",
          leaseId: claim.lease!.leaseId,
          workspace: {
            workspaceId: wsHandle.workspaceId,
            hostPath: wsHandle.hostPath,
          },
        }
      );

      expect(res.status).toBe("FAILED");
      expect(res.error?.code).toBe("CAPABILITY_DENIED");
      expect(physicalSpy.invocationCount).toBe(0);
    });

    it("Scenario 9: Trust classification reaches the physical provider unchanged", async () => {
      const physicalSpy = new SpyPhysicalExecutionProvider();
      const adapter = new SandboxedCommandToolAdapter(physicalSpy);

      const ctx: ToolExecutionContext = {
        runId: "run-trust",
        taskId: "task-trust",
        workerId: "w1",
        leaseId: "l1",
        toolName: "run_command",
        requiredCapability: "process.execute",
        isolationRequirement: "SANDBOX",
        workspace: { workspaceId: "ws-1", hostPath: "/tmp" },
        resourceLimits: { timeoutMs: 5000, maxOutputBytes: 1024 },
        trustClassification: "TRUSTED_INTERNAL",
      };

      await adapter.execute(ctx, { argv: ["whoami"], cwd: "." });
      expect(physicalSpy.lastRequest?.trustClassification).toBe("TRUSTED_INTERNAL");
    });

    it("Scenario 10: Tenant identity reaches the physical provider unchanged", async () => {
      const physicalSpy = new SpyPhysicalExecutionProvider();
      const adapter = new SandboxedCommandToolAdapter(physicalSpy);

      const ctx: ToolExecutionContext = {
        runId: "run-tenant",
        taskId: "task-tenant",
        workerId: "w1",
        leaseId: "l1",
        toolName: "run_command",
        requiredCapability: "process.execute",
        isolationRequirement: "SANDBOX",
        workspace: { workspaceId: "ws-1", hostPath: "/tmp" },
        resourceLimits: { timeoutMs: 5000, maxOutputBytes: 1024 },
        tenantId: "tenant-delta",
      };

      await adapter.execute(ctx, { argv: ["id"], cwd: "." });
      expect(physicalSpy.lastRequest?.tenantId).toBe("tenant-delta");
    });

    it("Scenario 11: Workspace boundary violations in command cwd remain strictly enforced", async () => {
      const physicalSpy = new SpyPhysicalExecutionProvider();
      const adapter = new SandboxedCommandToolAdapter(physicalSpy);

      const ctx: ToolExecutionContext = {
        runId: "run-esc",
        taskId: "task-esc",
        workerId: "w1",
        leaseId: "l1",
        toolName: "run_command",
        requiredCapability: "process.execute",
        isolationRequirement: "SANDBOX",
        workspace: { workspaceId: "ws-esc", hostPath: "/tmp" },
        resourceLimits: { timeoutMs: 5000, maxOutputBytes: 1024 },
      };

      await expect(
        adapter.execute(ctx, { argv: ["ls"], cwd: "../../etc" })
      ).rejects.toThrowError(ToolWorkspaceBoundaryViolationError);
      expect(physicalSpy.invocationCount).toBe(0);
    });

    it("Scenario 12: Existing cancellation signal cleanly aborts adapter without dispatch", async () => {
      const physicalSpy = new SpyPhysicalExecutionProvider();
      const adapter = new SandboxedCommandToolAdapter(physicalSpy);

      const abortController = new AbortController();
      abortController.abort(new Error("operator abort"));

      const ctx: ToolExecutionContext = {
        runId: "run-abort",
        taskId: "task-abort",
        workerId: "w1",
        leaseId: "l1",
        toolName: "run_command",
        requiredCapability: "process.execute",
        isolationRequirement: "SANDBOX",
        workspace: { workspaceId: "ws-abort", hostPath: "/tmp" },
        resourceLimits: { timeoutMs: 5000, maxOutputBytes: 1024 },
        abortSignal: abortController.signal,
      };

      await expect(adapter.execute(ctx, { argv: ["sleep", "10"], cwd: "." })).rejects.toThrowError(
        ToolCancelledError
      );
      expect(physicalSpy.invocationCount).toBe(0);
    });
  });

  describe("3. Isolation & Fallback", () => {
    it("Scenario 13: Untrusted workloads require the configured validated sandbox provider", () => {
      const decision = evaluateWorkloadExecutionRouting({
        trustClassification: "UNTRUSTED_WORKLOAD",
        requestedProviderName: "in-process",
        isSandboxAvailable: true,
      });

      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe("HOST_FALLBACK_DISALLOWED");
      expect(decision.requiredProvider).toBe("docker");
    });

    it("Scenario 14: Rootful Docker is rejected where rootless execution is mandatory", () => {
      const decision = evaluateWorkloadExecutionRouting({
        trustClassification: "UNTRUSTED_WORKLOAD",
        requestedProviderName: "docker",
        isSandboxAvailable: true,
        isDaemonRootless: false,
        requireRootlessDaemon: true,
      });

      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe("ROOTLESS_VALIDATION_FAILED");
    });

    it("Scenario 15: Missing Docker/OCI isolation fails closed for untrusted workloads", () => {
      const decision = evaluateWorkloadExecutionRouting({
        trustClassification: "UNTRUSTED_WORKLOAD",
        requestedProviderName: "docker",
        isSandboxAvailable: false,
      });

      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe("DOCKER_UNAVAILABLE");
    });

    it("Scenario 16: No in-process fallback occurs for untrusted/adversarial workloads", async () => {
      const inProcessProvider = new InProcessExecutionProvider();
      const runtime = new WorkerRuntime({
        coordinator,
        clock,
        executionProvider: inProcessProvider,
      });

      const adversarialCheck = await runtime["verifyIsolationSatisfaction"](
        "ISOLATED",
        createExecutionPolicy({
          policyId: "p-adv",
          isolationRequirement: "ISOLATED",
          allowedCapabilities: ["process.execute"],
          trustClassification: "ADVERSARIAL_WORKLOAD",
        })
      );
      expect(adversarialCheck.satisfied).toBe(false);

      const untrustedCheck = await runtime["verifyIsolationSatisfaction"](
        "ISOLATED",
        createExecutionPolicy({
          policyId: "p-untrusted",
          isolationRequirement: "ISOLATED",
          allowedCapabilities: ["process.execute"],
          trustClassification: "UNTRUSTED_WORKLOAD",
        })
      );
      expect(untrustedCheck.satisfied).toBe(false);
    });

    it("Scenario 17: Trusted internal evaluation fixtures continue to use their permitted execution path", () => {
      const decision = evaluateWorkloadExecutionRouting({
        trustClassification: "TRUSTED_INTERNAL",
        requestedProviderName: "in-process",
        isSandboxAvailable: false,
      });

      expect(decision.allowed).toBe(true);
      expect(decision.requiredProvider).toBe("in-process");
    });

    it("Scenario 18: No host fallback is introduced when sandbox is requested", () => {
      const adversarialDecision = evaluateWorkloadExecutionRouting({
        trustClassification: "ADVERSARIAL_WORKLOAD",
        isSandboxAvailable: false,
      });

      expect(adversarialDecision.allowed).toBe(false);
      expect(adversarialDecision.message).toContain("Host fallback is prohibited (FAIL CLOSED)");
    });
  });
});
