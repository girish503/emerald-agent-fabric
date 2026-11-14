/**
 * Targeted Integration & Regression Tests for Authoritative Workload Trust Routing (Track E)
 *
 * Verifies:
 * 1. Policy creation enforces mandatory rootless daemon for untrusted/adversarial/multi-tenant workloads.
 * 2. Multi-tenant policy creation rejects missing tenantId.
 * 3. evaluateWorkloadExecutionRouting() rejects UNKNOWN trust classification and missing tenantId.
 * 4. ToolExecutionGateway evaluates workload routing in Stage 10 and propagates tenantId and trustClassification.
 * 5. SandboxedCommandToolAdapter propagates tenantId and trustClassification to ExecutionRequest.
 * 6. WorkerRuntime fails closed when trust routing or isolation posture is violated.
 */

import { describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { SandboxedCommandToolAdapter } from "../../src/adapters/tools/sandboxed-command.tool-adapter.js";
import { RunCoordinator, WorkerRuntime } from "../../src/application/index.js";
import { ToolExecutionGateway, TrustedToolInvocationContext } from "../../src/application/tool-execution-gateway.js";
import {
  createExecutionPolicy,
  evaluateWorkloadExecutionRouting,
} from "../../src/domain/policy.js";
import { ToolRequest } from "../../src/domain/tool.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "../../src/ports/execution-provider.port.js";
import { createAndActivateContract } from "./test-helpers.js";
import { createVerificationSpec } from "../../src/domain/verification.js";

describe("Track E — Authoritative Workload Trust Routing & Runtime Enforcement", () => {
  describe("Policy Derivation & Invariant Enforcement", () => {
    it("authoritatively forces requireRootlessDaemon=true for UNTRUSTED_WORKLOAD", () => {
      const policy = createExecutionPolicy({
        policyId: "untrusted-policy",
        allowedCapabilities: ["process.execute"],
        isolationRequirement: "ISOLATED",
        trustClassification: "UNTRUSTED_WORKLOAD",
        requireRootlessDaemon: false, // Caller attempts to disable
      });

      expect(policy.requireRootlessDaemon).toBe(true);
      expect(policy.trustClassification).toBe("UNTRUSTED_WORKLOAD");
    });

    it("authoritatively forces requireRootlessDaemon=true for ADVERSARIAL_WORKLOAD", () => {
      const policy = createExecutionPolicy({
        policyId: "adversarial-policy",
        allowedCapabilities: ["process.execute"],
        isolationRequirement: "ISOLATED",
        trustClassification: "ADVERSARIAL_WORKLOAD",
        requireRootlessDaemon: false,
      });

      expect(policy.requireRootlessDaemon).toBe(true);
    });

    it("authoritatively forces requireRootlessDaemon=true for MULTI_TENANT_WORKLOAD", () => {
      const policy = createExecutionPolicy({
        policyId: "multi-tenant-policy",
        allowedCapabilities: ["process.execute"],
        isolationRequirement: "ISOLATED",
        trustClassification: "MULTI_TENANT_WORKLOAD",
        tenantId: "tenant-beta",
        requireRootlessDaemon: false,
      });

      expect(policy.requireRootlessDaemon).toBe(true);
      expect(policy.tenantId).toBe("tenant-beta");
    });

    it("rejects MULTI_TENANT_WORKLOAD if tenantId is missing or blank", () => {
      expect(() => {
        createExecutionPolicy({
          policyId: "invalid-mt-policy",
          allowedCapabilities: ["process.execute"],
          isolationRequirement: "ISOLATED",
          trustClassification: "MULTI_TENANT_WORKLOAD",
        });
      }).toThrow(/requires an explicit non-empty tenantId/);

      expect(() => {
        createExecutionPolicy({
          policyId: "invalid-mt-policy-blank",
          allowedCapabilities: ["process.execute"],
          isolationRequirement: "ISOLATED",
          trustClassification: "MULTI_TENANT_WORKLOAD",
          tenantId: "   ",
        });
      }).toThrow(/requires an explicit non-empty tenantId/);
    });

    it("defaults ISOLATED policy to MULTI_TENANT_WORKLOAD when tenantId is supplied", () => {
      const policy = createExecutionPolicy({
        policyId: "auto-mt-policy",
        allowedCapabilities: ["process.execute"],
        isolationRequirement: "ISOLATED",
        tenantId: "tenant-auto",
      });

      expect(policy.trustClassification).toBe("MULTI_TENANT_WORKLOAD");
      expect(policy.tenantId).toBe("tenant-auto");
      expect(policy.requireRootlessDaemon).toBe(true);
    });

    it("defaults ISOLATED policy to UNTRUSTED_WORKLOAD when tenantId is omitted", () => {
      const policy = createExecutionPolicy({
        policyId: "auto-untrusted-policy",
        allowedCapabilities: ["process.execute"],
        isolationRequirement: "ISOLATED",
      });

      expect(policy.trustClassification).toBe("UNTRUSTED_WORKLOAD");
      expect(policy.requireRootlessDaemon).toBe(true);
    });
  });

  describe("evaluateWorkloadExecutionRouting() Authoritative Seam", () => {
    it("rejects UNKNOWN trust classification fail-closed", () => {
      const decision = evaluateWorkloadExecutionRouting({
        trustClassification: "UNKNOWN",
        requestedProviderName: "docker",
        isSandboxAvailable: true,
      });

      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe("UNKNOWN_TRUST_CLASSIFICATION");
    });

    it("rejects MULTI_TENANT_WORKLOAD when tenantId is absent", () => {
      const decision = evaluateWorkloadExecutionRouting({
        trustClassification: "MULTI_TENANT_WORKLOAD",
        requestedProviderName: "docker",
        isSandboxAvailable: true,
      });

      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe("INVALID_REQUEST");
    });

    it("rejects in-process host provider when workload is UNTRUSTED_WORKLOAD", () => {
      const decision = evaluateWorkloadExecutionRouting({
        trustClassification: "UNTRUSTED_WORKLOAD",
        requestedProviderName: "in-process",
        isSandboxAvailable: true,
      });

      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe("HOST_FALLBACK_DISALLOWED");
      expect(decision.message).toContain("no host fallback");
    });

    it("rejects untrusted workload when Docker is unavailable", () => {
      const decision = evaluateWorkloadExecutionRouting({
        trustClassification: "UNTRUSTED_WORKLOAD",
        requestedProviderName: "docker",
        isSandboxAvailable: false,
      });

      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe("DOCKER_UNAVAILABLE");
    });

    it("authorizes untrusted workload for isolated Docker execution when rootless daemon verified", () => {
      const decision = evaluateWorkloadExecutionRouting({
        trustClassification: "UNTRUSTED_WORKLOAD",
        requestedProviderName: "docker",
        isSandboxAvailable: true,
        isDaemonRootless: true,
      });

      expect(decision.allowed).toBe(true);
      expect(decision.requiredProvider).toBe("docker");
    });
  });

  describe("ToolExecutionGateway Stage 10 Routing & Stage 11 Context Propagation", () => {
    it("authorizes SANDBOX tool, evaluates routing, and propagates tenantId and trustClassification", async () => {
      const store = new SqliteStateStore();
      const clock = new SettableClock(new Date("2026-11-07T12:00:00Z"));
      const coordinator = new RunCoordinator(store, clock);

      // Create Task and Run
      const task = coordinator.createTask({
        title: "test command",
        inputPayload: {},
      });

      const policy = createExecutionPolicy({
        policyId: "policy-mt-gw",
        allowedCapabilities: ["process.execute"],
        isolationRequirement: "ISOLATED",
        trustClassification: "MULTI_TENANT_WORKLOAD",
        tenantId: "tenant-gateway-123",
      });

      createAndActivateContract(store, task.taskId, {
        policy,
        verificationSpecs: [createVerificationSpec({ specId: "vspec-orch", ruleKind: "EXACT_OUTPUT_MATCH", expectedValue: { terminalReason: "COMPLETED" } })],
      });
      const { run } = coordinator.createRun({
        taskId: task.taskId,
      });

      coordinator.queueRun(run.runId);

      // Register worker, claim run, and start run
      coordinator.registerWorker({
        workerId: "worker-gw-1",
        hostname: "localhost",
        pid: process.pid,
        status: "ACTIVE",
        lastHeartbeatAt: clock.nowIso(),
        createdAt: clock.nowIso(),
      });
      const claim = coordinator.claimRun(run.runId, "worker-gw-1", 30000);
      expect(claim.run.status).toBe("LEASED");
      coordinator.startRun(run.runId, "worker-gw-1", claim.lease.leaseId);

      const gateway = new ToolExecutionGateway({
        coordinator,
        stateStore: store,
        clock,
        isIsolationAvailable: async () => true,
      });

      const request: ToolRequest<"run_command"> = {
        requestId: "req-cmd-1",
        runId: run.runId,
        toolName: "run_command",
        input: { argv: ["echo", "hello"], cwd: "." },
      };

      const context: TrustedToolInvocationContext = {
        runId: run.runId,
        taskId: task.taskId,
        workerId: "worker-gw-1",
        leaseId: claim.lease!.leaseId,
        workspace: {
          workspaceId: "ws-1",
          hostPath: "C:\\emerald\\ws-1",
          containerMountPath: "/workspace",
        },
      };

      const decision = await gateway.authorize(request, context);
      expect(decision.status).toBe("AUTHORIZED");
      expect(decision.executionContext).toBeDefined();
      expect(decision.executionContext?.tenantId).toBe("tenant-gateway-123");
      expect(decision.executionContext?.trustClassification).toBe("MULTI_TENANT_WORKLOAD");
    });

    it("denies SANDBOX tool when UNKNOWN trust classification is provided", async () => {
      const store = new SqliteStateStore();
      const clock = new SettableClock(new Date("2026-11-07T12:00:00Z"));
      const coordinator = new RunCoordinator(store, clock);

      const task = coordinator.createTask({
        title: "test command",
        inputPayload: {},
      });

      const policy = createExecutionPolicy({
        policyId: "policy-unknown-gw",
        allowedCapabilities: ["process.execute"],
        isolationRequirement: "ISOLATED",
        trustClassification: "TRUSTED_INTERNAL", // Base policy valid
      });

      createAndActivateContract(store, task.taskId, {
        policy,
        verificationSpecs: [createVerificationSpec({ specId: "vspec-untrusted", ruleKind: "EXACT_OUTPUT_MATCH", expectedValue: { terminalReason: "COMPLETED" } })],
      });
      const { run } = coordinator.createRun({
        taskId: task.taskId,
      });

      coordinator.queueRun(run.runId);
      coordinator.registerWorker({
        workerId: "worker-gw-2",
        hostname: "localhost",
        pid: process.pid,
        status: "ACTIVE",
        lastHeartbeatAt: clock.nowIso(),
        createdAt: clock.nowIso(),
      });
      const claim = coordinator.claimRun(run.runId, "worker-gw-2", 30000);
      coordinator.startRun(run.runId, "worker-gw-2", claim.lease.leaseId);

      const gateway = new ToolExecutionGateway({
        coordinator,
        stateStore: store,
        clock,
        isIsolationAvailable: async () => true,
      });

      const request: ToolRequest<"run_command"> = {
        requestId: "req-unknown-1",
        runId: run.runId,
        toolName: "run_command",
        input: { argv: ["echo", "hello"], cwd: "." },
      };

      const context: TrustedToolInvocationContext = {
        runId: run.runId,
        taskId: task.taskId,
        workerId: "worker-gw-2",
        leaseId: claim.lease!.leaseId,
        workspace: {
          workspaceId: "ws-1",
          hostPath: "C:\\emerald\\ws-1",
        },
        trustClassification: "UNKNOWN", // Injected UNKNOWN classification
      };

      const decision = await gateway.authorize(request, context);
      expect(decision.status).toBe("DENIED");
      expect(decision.errorPayload?.message).toContain("UNKNOWN");
    });
  });

  describe("SandboxedCommandToolAdapter Propagation", () => {
    it("propagates tenantId and trustClassification from ToolExecutionContext to ExecutionRequest", async () => {
      let capturedRequest: ExecutionRequest | undefined;

      const mockProvider: ExecutionProvider = {
        name: "docker",
        async execute<TInput, TOutput>(request: ExecutionRequest<TInput>): Promise<ExecutionResult<TOutput>> {
          capturedRequest = request as unknown as ExecutionRequest;
          return {
            status: "SUCCESS",
            output: { exitCode: 0, stdout: "ok", stderr: "" } as unknown as TOutput,
            durationMs: 10,
          };
        },
      };

      const adapter = new SandboxedCommandToolAdapter(mockProvider);

      await adapter.execute(
        {
          runId: "run-prop-test",
          taskId: "task-prop-test",
          workerId: "worker-prop",
          leaseId: "lease-prop",
          toolName: "run_command",
          requiredCapability: "process.execute",
          isolationRequirement: "SANDBOX",
          workspace: {
            workspaceId: "ws-prop",
            hostPath: "C:\\emerald\\data\\tenants\\tenant-prop\\ws",
            containerMountPath: "/workspace",
          },
          resourceLimits: {
            timeoutMs: 10000,
            maxOutputBytes: 1048576,
          },
          tenantId: "tenant-prop",
          trustClassification: "MULTI_TENANT_WORKLOAD",
        },
        { argv: ["pwd"], cwd: "." }
      );

      expect(capturedRequest).toBeDefined();
      expect(capturedRequest?.tenantId).toBe("tenant-prop");
      expect(capturedRequest?.trustClassification).toBe("MULTI_TENANT_WORKLOAD");
      expect(capturedRequest?.operationName).toBe("run_command");
    });
  });

  describe("WorkerRuntime Fail-Closed Integration", () => {
    it("fails closed when workload requires ISOLATED execution but provider is in-process (HOST_FALLBACK_DISALLOWED)", async () => {
      const store = new SqliteStateStore();
      const clock = new SettableClock(new Date("2026-11-07T12:00:00Z"));
      const coordinator = new RunCoordinator(store, clock);

      const task = coordinator.createTask({
        title: "echo",
        inputPayload: { text: "hello" },
      });

      const policy = createExecutionPolicy({
        policyId: "policy-untrusted-isolated",
        allowedCapabilities: ["execution.echo"],
        isolationRequirement: "ISOLATED",
        trustClassification: "UNTRUSTED_WORKLOAD",
      });

      createAndActivateContract(store, task.taskId, {
        policy,
        verificationSpecs: [createVerificationSpec({ specId: "vspec-untrusted", ruleKind: "EXACT_OUTPUT_MATCH", expectedValue: { terminalReason: "COMPLETED" } })],
      });
      const { run } = coordinator.createRun({
        taskId: task.taskId,
      });

      coordinator.queueRun(run.runId);

      // Configure WorkerRuntime with an IN-PROCESS execution provider
      const inProcessProvider: ExecutionProvider = {
        name: "in-process",
        async execute<TInput, TOutput>(_request: ExecutionRequest<TInput>): Promise<ExecutionResult<TOutput>> {
          return { status: "SUCCESS", durationMs: 0 } as ExecutionResult<TOutput>;
        },
      };

      const runtime = new WorkerRuntime({
        coordinator,
        clock,
        executionProvider: inProcessProvider,
        workerId: "worker-inproc-fallback",
      });

      const result = await runtime.runOnce();
      expect(result.status).toBe("FAILED");
      if ("error" in result) {
        expect((result.error as any)?.code).toBe("POLICY_DENIED");
        expect((result.error as any)?.message).toContain("no host fallback");
      }

      // Check run terminal state
      const finalRun = coordinator.getRun(run.runId);
      expect(finalRun?.status).toBe("FAILED");
    });

    it("allows governed-agent orchestrator with role ORCHESTRATION to execute isolated task control loop without rejection on provider name", async () => {
      const store = new SqliteStateStore();
      const clock = new SettableClock(new Date("2026-11-07T12:00:00Z"));
      const coordinator = new RunCoordinator(store, clock);

      const task = coordinator.createTask({
        title: "echo",
        inputPayload: { instruction: "Write result.txt" },
      });

      const policy = createExecutionPolicy({
        policyId: "policy-untrusted-agent",
        allowedCapabilities: ["execution.echo", "workspace.file.read", "workspace.file.write"],
        isolationRequirement: "ISOLATED",
        trustClassification: "UNTRUSTED_WORKLOAD",
      });

      createAndActivateContract(store, task.taskId, { policy });
      const { run } = coordinator.createRun({
        taskId: task.taskId,
      });

      coordinator.queueRun(run.runId);

      let executed = false;
      const orchestratorProvider: ExecutionProvider = {
        name: "governed-agent",
        role: "ORCHESTRATION",
        tenantModel: "NONE",
        async execute<TInput, TOutput>(_request: ExecutionRequest<TInput>): Promise<ExecutionResult<TOutput>> {
          executed = true;
          return {
            status: "SUCCESS",
            output: { terminalReason: "COMPLETED" } as unknown as TOutput,
            durationMs: 15,
          };
        },
      };

      const runtime = new WorkerRuntime({
        coordinator,
        clock,
        executionProvider: orchestratorProvider,
        workerId: "worker-orchestrator",
        allowUnverifiedCompletion: true,
      });

      const result = await runtime.runOnce();
      expect(result.status).toBe("COMPLETED");
      expect(executed).toBe(true);

      const finalRun = coordinator.getRun(run.runId);
      expect(finalRun?.status).toBe("COMPLETED");
    });

    it("strictly rejects physical in-process provider for ADVERSARIAL_WORKLOAD and MULTI_TENANT_WORKLOAD", async () => {
      const store = new SqliteStateStore();
      const clock = new SettableClock(new Date("2026-11-07T12:00:00Z"));
      const coordinator = new RunCoordinator(store, clock);

      const inProcessProvider: ExecutionProvider = {
        name: "in-process",
        role: "PHYSICAL",
        async execute<TInput, TOutput>(_req: ExecutionRequest<TInput>): Promise<ExecutionResult<TOutput>> {
          return { status: "SUCCESS", durationMs: 0 } as ExecutionResult<TOutput>;
        },
      };

      const runtime = new WorkerRuntime({
        coordinator,
        clock,
        executionProvider: inProcessProvider,
        workerId: "worker-inproc-adv",
      });

      // 1. Adversarial workload
      const task1 = coordinator.createTask({ title: "echo", inputPayload: { text: "adv" } });
      const policy1 = createExecutionPolicy({
        policyId: "adv-policy",
        allowedCapabilities: ["execution.echo"],
        isolationRequirement: "ISOLATED",
        trustClassification: "ADVERSARIAL_WORKLOAD",
      });
      createAndActivateContract(store, task1.taskId, { policy: policy1 });
      const { run: run1 } = coordinator.createRun({ taskId: task1.taskId });
      coordinator.queueRun(run1.runId);

      const res1 = await runtime.runOnce();
      expect(res1.status).toBe("FAILED");
      expect((res1 as any).error?.code).toBe("POLICY_DENIED");
      expect((res1 as any).error?.message).toContain("no host fallback");

      // 2. Multi-tenant workload
      const task2 = coordinator.createTask({ title: "echo", inputPayload: { text: "mt" } });
      const policy2 = createExecutionPolicy({
        policyId: "mt-policy",
        allowedCapabilities: ["execution.echo"],
        isolationRequirement: "ISOLATED",
        trustClassification: "MULTI_TENANT_WORKLOAD",
        tenantId: "tenant-delta",
      });
      createAndActivateContract(store, task2.taskId, { policy: policy2 });
      const { run: run2 } = coordinator.createRun({ taskId: task2.taskId });
      coordinator.queueRun(run2.runId);

      const res2 = await runtime.runOnce();
      expect(res2.status).toBe("FAILED");
      expect((res2 as any).error?.code).toBe("POLICY_DENIED");
      expect((res2 as any).error?.message).toContain("no host fallback");
    });
  });
});
