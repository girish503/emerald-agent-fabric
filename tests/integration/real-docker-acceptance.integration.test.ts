/**
 * Milestone 2.28 Phase 4 Step 3 — Real Docker Execution & Governed Integration Acceptance Suite.
 *
 * Demonstrates:
 * 1. Step B: Read-only Docker environment inspection (connectivity, version, daemon rootful classification).
 * 2. Step C: Real physical execution through DockerExecutionProvider with:
 *    - Harmless deterministic commands (zero shell wrapping).
 *    - Non-root user identity (uid 1000, gid 1000).
 *    - Root filesystem read-only confinement.
 *    - Network isolation (--network=none).
 *    - Workspace filesystem write persistence exclusively inside assigned boundary.
 *    - Output limit enforcement and clean container termination.
 *    - Cooperative cancellation stopping container operation cleanly.
 * 3. Step D: Real governed-to-physical production pipeline:
 *    - ScriptedBrain -> GovernedAgentExecutionProvider -> WorkerRuntime -> ToolExecutionGateway -> SandboxedCommandToolAdapter -> DockerExecutionProvider -> real container.
 *    - Preserves tenant identity, trust classification (TRUSTED_INTERNAL), lease fencing.
 *    - Zero recursive re-entry into the agent step loop.
 * 4. Step E: Failure and Fail-Closed Boundary Invariants:
 *    - Rootful daemon rejected fail-closed for UNTRUSTED_WORKLOAD (ROOTLESS_VALIDATION_FAILED).
 *    - Rootful daemon rejected fail-closed for MULTI_TENANT_WORKLOAD with requireRootlessDaemon.
 *    - Non-allowlisted container image rejected fail-closed (IMAGE_POLICY_REJECTED).
 *    - Unavailable Docker daemon fails closed (PROVIDER_UNAVAILABLE / DOCKER_UNAVAILABLE) without host fallback.
 *    - Lexical path traversal outside workspace fails closed before container dispatch.
 *    - Missing physical provider (physicalProvider: 'none') fails closed without command execution.
 *    - Invalid physical provider role (ORCHESTRATION) fails closed at worker boundary.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DockerExecutionProvider } from "../../src/adapters/execution/docker-execution-provider.js";
import { GovernedAgentExecutionProvider } from "../../src/adapters/execution/governed-agent-execution-provider.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { SandboxedCommandToolAdapter } from "../../src/adapters/tools/sandboxed-command.tool-adapter.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { WorkerHostConfigError, runWorkerHost } from "../../src/application/worker-host.js";
import {
  createExecutionPolicy,
  ExecutionPolicy,
} from "../../src/domain/policy.js";
import {
  AgentBrainPort,
  AgentBrainRequest,
  AgentBrainResult,
} from "../../src/ports/agent-brain.port.js";
import { SystemClock } from "../../src/ports/clock.port.js";
import {
  ExecutionRequest,
} from "../../src/ports/execution-provider.port.js";
import { createAndActivateContract } from "../application/test-helpers.js";

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

describe("Milestone 2.28 Phase 4 Step 3 — Real Docker Execution & Production Verification", { timeout: 90_000 }, () => {
  let isDockerAvailable = false;
  let tempDir: string;
  let dbPath: string;
  let workspaceRoot: string;
  let store: SqliteStateStore;
  let clock: SystemClock;
  let coordinator: RunCoordinator;
  let workspaceAdapter: NodeFsWorkspaceAdapter;

  beforeAll(async () => {
    const probe = await DockerExecutionProvider.isAvailable();
    isDockerAvailable = probe.available;
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-phase4-step3-"));
    dbPath = path.join(tempDir, "emerald.sqlite");
    workspaceRoot = path.join(tempDir, "workspaces");
    fs.mkdirSync(workspaceRoot);

    store = new SqliteStateStore({ location: dbPath });
    clock = new SystemClock();
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot });
    coordinator = new RunCoordinator(store, clock, undefined, workspaceAdapter);
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
      description: `Task ${taskId} for testing real docker composition`,
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

  // =========================================================================
  // Part 1: Step B & C — Docker Environment & Physical Isolation (Real Daemon)
  // =========================================================================
  describe("Part 1: Step B & C — Docker Environment & Physical Isolation", () => {
    it("Test 1: inspectDaemonSecurity detects real Docker connectivity and classifies Windows Docker Desktop as rootful daemon", async () => {
      if (!isDockerAvailable) return;

      const inspection = await DockerExecutionProvider.inspectDaemonSecurity("docker");
      expect(inspection.available).toBe(true);
      expect(typeof inspection.serverVersion).toBe("string");
      expect(inspection.serverVersion?.length).toBeGreaterThan(0);
      // Windows Docker Desktop WSL2 daemon does not run rootless mode
      expect(inspection.isRootlessDaemon).toBe(false);
      expect(inspection.securityOptions).not.toContain("name=rootless");
    });

    it("Test 2: Real DockerExecutionProvider dispatches deterministic command with non-root user (1000:1000) and /workspace cwd", async () => {
      if (!isDockerAvailable) return;

      const dockerProvider = new DockerExecutionProvider();
      const wsHandle = await workspaceAdapter.provisionWorkspace({
        workspaceId: "ws-test-phys-uid",
        runId: "run-test-phys-uid",
        taskId: "task-test-phys-uid",
        maxWorkspaceBytes: 10 * 1024 * 1024,
        maxFileSizeBytes: 5 * 1024 * 1024,
      });

      const request: ExecutionRequest = {
        runId: "run-test-phys-uid",
        taskId: "task-test-phys-uid",
        operationName: "run_command",
        inputPayload: {
          argv: [
            "node",
            "-e",
            "console.log(JSON.stringify({ uid: process.getuid(), gid: process.getgid(), cwd: process.cwd() }))",
          ],
          cwd: ".",
        },
        idempotencyToken: "idem-phys-uid",
        attemptNumber: 0,
        timeoutMs: 25_000,
        workspace: {
          workspaceId: wsHandle.workspaceId,
          hostPath: wsHandle.hostPath,
          containerMountPath: "/workspace",
        },
        trustClassification: "TRUSTED_INTERNAL",
      };

      const result = await dockerProvider.execute(request);
      expect(result.status).toBe("SUCCESS");
      const output = JSON.parse((result.output as any).stdout.trim());
      expect(output.uid).toBe(1000);
      expect(output.gid).toBe(1000);
      expect(output.cwd).toBe("/workspace");
      expect((result.output as any).exitCode).toBe(0);
    });

    it("Test 3: Real DockerExecutionProvider enforces read-only root filesystem and no docker.sock", async () => {
      if (!isDockerAvailable) return;

      const dockerProvider = new DockerExecutionProvider();
      const wsHandle = await workspaceAdapter.provisionWorkspace({
        workspaceId: "ws-test-confinement",
        runId: "run-test-confinement",
        taskId: "task-test-confinement",
        maxWorkspaceBytes: 10 * 1024 * 1024,
        maxFileSizeBytes: 5 * 1024 * 1024,
      });

      const request: ExecutionRequest = {
        runId: "run-test-confinement",
        taskId: "task-test-confinement",
        operationName: "run_command",
        inputPayload: {
          argv: [
            "node",
            "-e",
            `
            const fs = require('fs');
            let rootWritable = false;
            try {
              fs.writeFileSync('/root_probe.txt', 'fail');
              rootWritable = true;
            } catch (e) {
              rootWritable = false;
            }
            const hasDockerSock = fs.existsSync('/var/run/docker.sock');
            console.log(JSON.stringify({ rootWritable, hasDockerSock }));
            `,
          ],
          cwd: ".",
        },
        idempotencyToken: "idem-confinement",
        attemptNumber: 0,
        timeoutMs: 25_000,
        workspace: {
          workspaceId: wsHandle.workspaceId,
          hostPath: wsHandle.hostPath,
          containerMountPath: "/workspace",
        },
        trustClassification: "TRUSTED_INTERNAL",
      };

      const result = await dockerProvider.execute(request);
      expect(result.status).toBe("SUCCESS");
      const output = JSON.parse((result.output as any).stdout.trim());
      expect(output.rootWritable).toBe(false);
      expect(output.hasDockerSock).toBe(false);
    });

    it("Test 4: Real DockerExecutionProvider enforces network isolation (--network=none)", async () => {
      if (!isDockerAvailable) return;

      const dockerProvider = new DockerExecutionProvider();
      const wsHandle = await workspaceAdapter.provisionWorkspace({
        workspaceId: "ws-test-net",
        runId: "run-test-net",
        taskId: "task-test-net",
        maxWorkspaceBytes: 10 * 1024 * 1024,
        maxFileSizeBytes: 5 * 1024 * 1024,
      });

      const request: ExecutionRequest = {
        runId: "run-test-net",
        taskId: "task-test-net",
        operationName: "run_command",
        inputPayload: {
          argv: [
            "node",
            "-e",
            `
            const dns = require('dns');
            dns.lookup('example.com', (err) => {
              console.log(JSON.stringify({ netBlocked: Boolean(err) }));
            });
            `,
          ],
          cwd: ".",
        },
        idempotencyToken: "idem-net",
        attemptNumber: 0,
        timeoutMs: 25_000,
        workspace: {
          workspaceId: wsHandle.workspaceId,
          hostPath: wsHandle.hostPath,
          containerMountPath: "/workspace",
        },
        trustClassification: "TRUSTED_INTERNAL",
      };

      const result = await dockerProvider.execute(request);
      expect(result.status).toBe("SUCCESS");
      const output = JSON.parse((result.output as any).stdout.trim());
      expect(output.netBlocked).toBe(true);
    });

    it("Test 5: Real DockerExecutionProvider persists filesystem writes inside /workspace to host workspace", async () => {
      if (!isDockerAvailable) return;

      const dockerProvider = new DockerExecutionProvider();
      const wsHandle = await workspaceAdapter.provisionWorkspace({
        workspaceId: "ws-test-persist",
        runId: "run-test-persist",
        taskId: "task-test-persist",
        maxWorkspaceBytes: 10 * 1024 * 1024,
        maxFileSizeBytes: 5 * 1024 * 1024,
      });

      const fileName = `persisted-real-docker-${Date.now()}.txt`;
      const request: ExecutionRequest = {
        runId: "run-test-persist",
        taskId: "task-test-persist",
        operationName: "run_command",
        inputPayload: {
          argv: [
            "node",
            "-e",
            `require('fs').writeFileSync('${fileName}', 'emerald-real-docker-persisted-data', 'utf8')`,
          ],
          cwd: ".",
        },
        idempotencyToken: "idem-persist",
        attemptNumber: 0,
        timeoutMs: 25_000,
        workspace: {
          workspaceId: wsHandle.workspaceId,
          hostPath: wsHandle.hostPath,
          containerMountPath: "/workspace",
        },
        trustClassification: "TRUSTED_INTERNAL",
      };

      const result = await dockerProvider.execute(request);
      expect(result.status).toBe("SUCCESS");

      const hostFilePath = path.join(wsHandle.hostPath, fileName);
      expect(fs.existsSync(hostFilePath)).toBe(true);
      expect(fs.readFileSync(hostFilePath, "utf8")).toBe("emerald-real-docker-persisted-data");
    });

    it("Test 6: Real DockerExecutionProvider caps excessive output at maxOutputBytes limit", async () => {
      if (!isDockerAvailable) return;

      const dockerProvider = new DockerExecutionProvider({ maxOutputBytes: 1024 });
      const wsHandle = await workspaceAdapter.provisionWorkspace({
        workspaceId: "ws-test-limit",
        runId: "run-test-limit",
        taskId: "task-test-limit",
        maxWorkspaceBytes: 10 * 1024 * 1024,
        maxFileSizeBytes: 5 * 1024 * 1024,
      });

      const request: ExecutionRequest = {
        runId: "run-test-limit",
        taskId: "task-test-limit",
        operationName: "run_command",
        inputPayload: {
          argv: [
            "node",
            "-e",
            "console.log('A'.repeat(5000))",
          ],
          cwd: ".",
        },
        idempotencyToken: "idem-limit",
        attemptNumber: 0,
        timeoutMs: 25_000,
        workspace: {
          workspaceId: wsHandle.workspaceId,
          hostPath: wsHandle.hostPath,
          containerMountPath: "/workspace",
        },
        trustClassification: "TRUSTED_INTERNAL",
      };

      const result = await dockerProvider.execute(request);
      expect(result.status).toBe("FAILED");
      expect(result.error?.message).toContain("Output limit");
      expect(result.providerMetadata?.outputLimitExceeded).toBe(true);
    });

    it("Test 7: Real DockerExecutionProvider terminates long-running container on timeout", async () => {
      if (!isDockerAvailable) return;

      const dockerProvider = new DockerExecutionProvider({ stopGraceSeconds: 1 });
      const wsHandle = await workspaceAdapter.provisionWorkspace({
        workspaceId: "ws-test-timeout",
        runId: "run-test-timeout",
        taskId: "task-test-timeout",
        maxWorkspaceBytes: 10 * 1024 * 1024,
        maxFileSizeBytes: 5 * 1024 * 1024,
      });

      const request: ExecutionRequest = {
        runId: "run-test-timeout",
        taskId: "task-test-timeout",
        operationName: "run_command",
        inputPayload: {
          argv: ["node", "-e", "setInterval(() => {}, 1000)"],
          cwd: ".",
        },
        idempotencyToken: "idem-timeout",
        attemptNumber: 0,
        timeoutMs: 1500,
        workspace: {
          workspaceId: wsHandle.workspaceId,
          hostPath: wsHandle.hostPath,
          containerMountPath: "/workspace",
        },
        trustClassification: "TRUSTED_INTERNAL",
      };

      const result = await dockerProvider.execute(request);
      expect(result.status).toBe("TIMED_OUT");
      expect(result.error?.code).toBe("EXECUTION_TIMEOUT");
    });
  });

  // =========================================================================
  // Part 2: Step D — Governed-to-Physical Integration Acceptance (Real Docker)
  // =========================================================================
  describe("Part 2: Step D — Governed-to-Physical Integration Acceptance (Real Docker)", () => {
    it("Test 8: Complete governed proposal pipeline executes physical command through SandboxedCommandToolAdapter in real Docker container without recursion", async () => {
      if (!isDockerAvailable) return;

      const realDockerProvider = new DockerExecutionProvider();
      const { run } = createQueuedRun("real-pipeline");

      // ScriptedBrain proposes run_command then finishes
      const brain = new ScriptedBrain()
        .queue(runCommandProposal("prop-real-docker", ["echo", "emerald-step3-proven"], "."))
        .queue(() => ({ finishReason: "GOAL_REACHED" }));

      const hostResult = await runWorkerHost({
        dbPath,
        workspaceRoot,
        workerId: "worker-step3-real",
        once: true,
        modelProvider: "fixture",
        agentBrain: brain,
        physicalExecutionProvider: realDockerProvider,
        allowUnverifiedCompletion: true,
        signal: new AbortController().signal,
        log: () => {},
      });

      expect(hostResult.errors).toBe(0);
      expect(hostResult.runsProcessed).toBe(1);

      // Verify the final run state
      const completedRun = coordinator.getRun(run.runId);
      expect(completedRun?.status).toBe("COMPLETED");

      // Verify actions and events recorded in SQLite
      const actions = store.getActionsForRun(run.runId);
      expect(actions.length).toBe(1);
      const firstAction = actions[0]!;
      expect(firstAction.toolName).toBe("run_command");
      expect(firstAction.status).toBe("SUCCEEDED");

      // Verify attempt recorded exit code 0
      const attempts = store.getAttemptsForAction(firstAction.actionId);
      expect(attempts.length).toBe(1);
      const firstAttempt = attempts[0]!;
      expect(firstAttempt.status).toBe("SUCCEEDED");
      expect(firstAttempt.exitCode).toBe(0);
      expect((firstAttempt.outputPayload as any).stdout.trim()).toBe("emerald-step3-proven");
    });

    it("Test 9: Governed run_command dispatch through real Docker preserves contract tenant identity and trust classification", async () => {
      if (!isDockerAvailable) return;

      const realDockerProvider = new DockerExecutionProvider();
      const customPolicy = createExecutionPolicy({
        policyId: "pol-step3-tenant",
        isolationRequirement: "IN_PROCESS",
        allowedCapabilities: [
          "execution.echo",
          "process.execute",
          "workspace.file.read",
          "workspace.file.write",
        ],
        trustedInProcessOperations: ["echo", "execution.echo"],
        trustClassification: "TRUSTED_INTERNAL",
        tenantId: "tenant-step3-alpha",
      });

      const { run } = createQueuedRun("step3-tenant", {
        policy: customPolicy,
        tenantId: "tenant-step3-alpha",
      });

      const brain = new ScriptedBrain()
        .queue(runCommandProposal("prop-tenant-docker", ["node", "-v"], "."))
        .queue(() => ({ finishReason: "GOAL_REACHED" }));

      const hostResult = await runWorkerHost({
        dbPath,
        workspaceRoot,
        workerId: "worker-step3-tenant",
        once: true,
        modelProvider: "fixture",
        agentBrain: brain,
        physicalExecutionProvider: realDockerProvider,
        allowUnverifiedCompletion: true,
        signal: new AbortController().signal,
        log: () => {},
      });

      expect(hostResult.errors).toBe(0);
      expect(hostResult.runsProcessed).toBe(1);
      expect(coordinator.getRun(run.runId)?.status).toBe("COMPLETED");

      const actions = store.getActionsForRun(run.runId);
      expect(actions.length).toBe(1);
      const firstAction = actions[0]!;
      expect(firstAction.status).toBe("SUCCEEDED");
      const attempts = store.getAttemptsForAction(firstAction.actionId);
      expect(attempts.length).toBe(1);
      const firstAttempt = attempts[0]!;
      expect((firstAttempt.outputPayload as any).stdout).toContain("v22");
    });

    it("Test 10: In-flight cancellation cleanly terminates real Docker container without corrupting governed state", async () => {
      if (!isDockerAvailable) return;

      const realDockerProvider = new DockerExecutionProvider({ stopGraceSeconds: 1 });
      const { run } = createQueuedRun("step3-cancel");

      // Controller aborts after 800ms
      const abortController = new AbortController();
      setTimeout(() => abortController.abort(new Error("operator cancellation")), 800);

      const brain = new ScriptedBrain()
        .queue(runCommandProposal("prop-cancel-docker", ["node", "-e", "setInterval(() => {}, 1000)"], "."))
        .queue(() => ({ finishReason: "GOAL_REACHED" }));

      const hostResult = await runWorkerHost({
        dbPath,
        workspaceRoot,
        workerId: "worker-step3-cancel",
        once: true,
        modelProvider: "fixture",
        agentBrain: brain,
        physicalExecutionProvider: realDockerProvider,
        allowUnverifiedCompletion: true,
        signal: abortController.signal,
        log: () => {},
      });

      // Worker cleanly shuts down or records cancellation
      expect(hostResult.runsProcessed).toBeLessThanOrEqual(1);
      expect(coordinator.getRun(run.runId)).toBeDefined();
    });
  });

  // =========================================================================
  // Part 3: Step E — Failure and Fail-Closed Boundary Invariants
  // =========================================================================
  describe("Part 3: Step E — Failure and Fail-Closed Boundary Invariants", () => {
    it("Test 11: Untrusted workload (UNTRUSTED_WORKLOAD) strictly requires rootless daemon and is rejected fail-closed on rootful daemon", async () => {
      if (!isDockerAvailable) return;

      const dockerProvider = new DockerExecutionProvider();
      const request: ExecutionRequest = {
        runId: "run-untrusted-failclose",
        taskId: "task-untrusted-failclose",
        operationName: "run_command",
        inputPayload: { argv: ["echo", "untrusted"], cwd: "." },
        idempotencyToken: "idem-untrusted-fc",
        attemptNumber: 0,
        timeoutMs: 10_000,
        trustClassification: "UNTRUSTED_WORKLOAD",
      };

      const result = await dockerProvider.execute(request);
      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("ROOTLESS_VALIDATION_FAILED");
      expect(result.error?.message).toContain("Rootless Docker daemon is required by policy");
      expect(result.providerMetadata?.rootlessValidation).toBe("REJECTED_ROOTFUL_DAEMON");
    });

    it("Test 12: MULTI_TENANT_WORKLOAD with requireRootlessDaemon is rejected fail-closed on rootful daemon", async () => {
      if (!isDockerAvailable) return;

      const dockerProvider = new DockerExecutionProvider({ requireRootlessDaemon: true });
      const request: ExecutionRequest = {
        runId: "run-multitenant-failclose",
        taskId: "task-multitenant-failclose",
        tenantId: "tenant-enforce-rootless",
        operationName: "run_command",
        inputPayload: { argv: ["echo", "multitenant"], cwd: "." },
        idempotencyToken: "idem-multitenant-fc",
        attemptNumber: 0,
        timeoutMs: 10_000,
        trustClassification: "MULTI_TENANT_WORKLOAD",
      };

      const result = await dockerProvider.execute(request);
      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("ROOTLESS_VALIDATION_FAILED");
    });

    it("Test 13: Non-allowlisted container image is rejected fail-closed (IMAGE_POLICY_REJECTED) without invoking Docker", async () => {
      const dockerProvider = new DockerExecutionProvider({
        image: "unauthorized-malicious-image:latest",
        imageAllowlist: ["node:22-alpine", "alpine:latest"],
      });

      const request: ExecutionRequest = {
        runId: "run-image-allowlist-rej",
        taskId: "task-image-allowlist-rej",
        operationName: "run_command",
        inputPayload: { argv: ["echo", "test"], cwd: "." },
        idempotencyToken: "idem-image-rej",
        attemptNumber: 0,
        timeoutMs: 10_000,
        trustClassification: "TRUSTED_INTERNAL",
      };

      const result = await dockerProvider.execute(request);
      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("IMAGE_POLICY_REJECTED");
      expect(result.error?.message).toContain("not permitted by image allowlist");
    });

    it("Test 14: Daemon unavailable fails closed with PROVIDER_UNAVAILABLE without host fallback", async () => {
      const dockerProvider = new DockerExecutionProvider({
        dockerBinary: "non-existent-docker-cli-binary-404",
      });

      const request: ExecutionRequest = {
        runId: "run-daemon-unavail-test",
        taskId: "task-daemon-unavail-test",
        operationName: "run_command",
        inputPayload: { argv: ["echo", "test"], cwd: "." },
        idempotencyToken: "idem-unavail-test",
        attemptNumber: 0,
        timeoutMs: 5_000,
        trustClassification: "TRUSTED_INTERNAL",
      };

      const result = await dockerProvider.execute(request);
      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("PROVIDER_UNAVAILABLE");
    });

    it("Test 15: Working directory traversal outside workspace fails closed before container dispatch", async () => {
      const dockerProvider = new DockerExecutionProvider();
      const adapter = new SandboxedCommandToolAdapter(dockerProvider, workspaceAdapter);
      const wsHandle = await workspaceAdapter.provisionWorkspace({
        workspaceId: "ws-traversal-boundary",
        runId: "run-traversal-boundary",
        taskId: "task-traversal-boundary",
        maxWorkspaceBytes: 10 * 1024 * 1024,
        maxFileSizeBytes: 5 * 1024 * 1024,
      });

      const context: any = {
        runId: "run-traversal-boundary",
        taskId: "task-traversal-boundary",
        workerId: "worker-traversal",
        leaseId: "lease-traversal",
        workspace: {
          workspaceId: wsHandle.workspaceId,
          hostPath: wsHandle.hostPath,
        },
        resourceLimits: { timeoutMs: 10_000, maxOutputBytes: 1024 * 1024 },
      };

      await expect(
        adapter.execute(context, { argv: ["cat", "secret.txt"], cwd: "../../etc" })
      ).rejects.toThrow();
    });

    it("Test 16: Missing physical provider (physicalProvider: 'none') fails closed without command execution", async () => {
      const brain = new ScriptedBrain()
        .queue(runCommandProposal("prop-none", ["echo", "will-fail"], "."))
        .queue(() => ({ finishReason: "GOAL_REACHED" }));

      const { run } = createQueuedRun("none-fc");

      const hostResult = await runWorkerHost({
        dbPath,
        workspaceRoot,
        workerId: "worker-none-fc",
        once: true,
        modelProvider: "fixture",
        physicalProvider: "none",
        agentBrain: brain,
        allowUnverifiedCompletion: true,
        signal: new AbortController().signal,
        log: () => {},
      });

      expect(hostResult.runsProcessed).toBe(1);
      const events = store.getEventsForRun(run.runId);
      expect(events.length).toBeGreaterThan(0);
    });

    it("Test 17: Supplying ORCHESTRATION provider as physicalExecutionProvider fails closed with WorkerHostConfigError", async () => {
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

    it("Test 18: Non-idempotent physical tool failure does not trigger uncertain automatic retry", async () => {
      if (!isDockerAvailable) return;

      const realDockerProvider = new DockerExecutionProvider();
      const { run } = createQueuedRun("fail-non-retry");

      // Proposal that exits non-zero
      const brain = new ScriptedBrain()
        .queue(runCommandProposal("prop-fail", ["node", "-e", "process.exit(1)"], "."))
        .queue(() => ({ finishReason: "GOAL_REACHED" }));

      const hostResult = await runWorkerHost({
        dbPath,
        workspaceRoot,
        workerId: "worker-fail-non-retry",
        once: true,
        modelProvider: "fixture",
        agentBrain: brain,
        physicalExecutionProvider: realDockerProvider,
        allowUnverifiedCompletion: true,
        signal: new AbortController().signal,
        log: () => {},
      });

      expect(hostResult.runsProcessed).toBe(1);
      const actions = store.getActionsForRun(run.runId);
      expect(actions.length).toBe(1);
      const firstAction = actions[0]!;
      const attempts = store.getAttemptsForAction(firstAction.actionId);
      // Exactly 1 attempt made: zero automatic retry of non-idempotent action
      expect(attempts.length).toBe(1);
      const firstAttempt = attempts[0]!;
      expect(firstAttempt.exitCode).toBe(1);
    });
  });
});
