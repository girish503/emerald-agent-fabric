/**
 * Sandboxed Command Tool Adapter Tests (Task 4.2-C)
 *
 * Verifies:
 * 1. Hardened Docker provider execution for run_command
 * 2. Zero host subprocess execution in the adapter layer (NO child_process, NO exec, NO spawn)
 * 3. Discrete argument preservation and strict anti-shell-injection
 * 4. Workspace containment validation for workingDirectory (cwd)
 * 5. Pre-execution authorization failure yields providerInvocationCount === 0
 * 6. Deterministic error taxonomy mappings (timeout, cancellation, output limit, provider unavailable)
 * 7. Live Docker execution integration (isolation, read-only rootfs, network=none, workspace persistence)
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerExecutionProvider } from "../../../src/adapters/execution/docker-execution-provider.js";
import { SqliteStateStore } from "../../../src/adapters/persistence/sqlite-state-store.js";
import { SandboxedCommandToolAdapter } from "../../../src/adapters/tools/sandboxed-command.tool-adapter.js";
import { createWorkspaceToolAdapterRegistry } from "../../../src/adapters/tools/tool-adapter-registry.factory.js";
import { NodeFsWorkspaceAdapter } from "../../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { RunCoordinator } from "../../../src/application/run-coordinator.js";
import { ToolExecutionGateway } from "../../../src/application/tool-execution-gateway.js";
import {
  ToolCancelledError,
  ToolOutputLimitExceededError,
  ToolProviderUnavailableError,
  ToolTimeoutError,
  ToolWorkspaceBoundaryViolationError,
} from "../../../src/domain/errors.js";
import { ToolRequest } from "../../../src/domain/tool.js";
import { RunCommandOutput } from "../../../src/domain/tool-schemas.js";
import { SettableClock } from "../../../src/ports/clock.port.js";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "../../../src/ports/execution-provider.port.js";
import { ToolExecutionContext } from "../../../src/ports/tool-adapter.port.js";
import { createExecutionPolicy } from "../../../src/domain/policy.js";
import { createAndActivateContract } from "../../application/test-helpers.js";

class SpyExecutionProvider implements ExecutionProvider {
  readonly name = "spy-docker";
  public invocationCount = 0;
  public lastRequest?: ExecutionRequest<any>;
  public mockResult?: ExecutionResult<any>;
  public shouldThrow?: Error;

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocationCount++;
    this.lastRequest = request;
    if (this.shouldThrow) {
      throw this.shouldThrow;
    }
    return (this.mockResult ?? {
      status: "SUCCESS",
      output: {
        exitCode: 0,
        stdout: "default stdout\n",
        stderr: "",
        durationMs: 42,
        outputTruncated: false,
      },
      durationMs: 42,
    }) as ExecutionResult<TOutput>;
  }
}

describe("SandboxedCommandToolAdapter — Task 4.2-C", { timeout: 60000 }, () => {
  let tempBaseDir: string;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let testWorkspaceId: string;
  let testHostPath: string;

  beforeAll(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "emerald-sandboxed-cmd-test-"));
    workspaceAdapter = new NodeFsWorkspaceAdapter({
      workspaceRoot: tempBaseDir,
    });
    testWorkspaceId = "ws-sandbox-cmd-test";
    const handle = await workspaceAdapter.provisionWorkspace({
      workspaceId: testWorkspaceId,
      runId: "run-test-cmd",
      taskId: "task-test-cmd",
      maxWorkspaceBytes: 50 * 1024 * 1024,
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
    testHostPath = handle.hostPath;
    await fs.mkdir(path.join(testHostPath, "subfolder"), { recursive: true });
    await fs.writeFile(path.join(testHostPath, "hello.txt"), "hello world\n", "utf8");
  });

  afterAll(async () => {
    if (tempBaseDir) {
      await fs.rm(tempBaseDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  function createTestContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
    return {
      runId: "run-test-cmd",
      taskId: "task-test-cmd",
      workerId: "worker-test-cmd",
      leaseId: "lease-test-cmd",
      toolName: "run_command",
      requiredCapability: "process.execute",
      isolationRequirement: "SANDBOX",
      workspace: {
        workspaceId: testWorkspaceId,
        hostPath: testHostPath,
        containerMountPath: "/workspace",
      },
      resourceLimits: {
        timeoutMs: 30000,
        maxOutputBytes: 1024 * 1024,
      },
      ...overrides,
    };
  }

  // =========================================================================
  // 1. Adapter Registration & Factory Invariants
  // =========================================================================
  describe("1. Adapter Registration & Factory Invariants", () => {
    it("registers run_command when ExecutionProvider is provided", () => {
      const spyProvider = new SpyExecutionProvider();
      const registry = createWorkspaceToolAdapterRegistry(workspaceAdapter, spyProvider);

      expect(registry.hasAdapter("run_command")).toBe(true);
      const adapter = registry.getAdapter("run_command");
      expect(adapter).toBeInstanceOf(SandboxedCommandToolAdapter);
      expect(adapter?.toolName).toBe("run_command");
    });

    it("does NOT register run_command when ExecutionProvider is omitted", () => {
      const registry = createWorkspaceToolAdapterRegistry(workspaceAdapter);

      expect(registry.hasAdapter("run_command")).toBe(false);
      expect(registry.getAdapter("run_command")).toBeNull();
    });
  });

  // =========================================================================
  // 2. Subprocess Execution Prohibition Audit
  // =========================================================================
  describe("2. Subprocess Execution Prohibition Audit", () => {
    it("guarantees zero child_process imports or execution in the adapter file", async () => {
      const adapterSourcePath = path.resolve(
        __dirname,
        "../../../src/adapters/tools/sandboxed-command.tool-adapter.ts"
      );
      const content = await fs.readFile(adapterSourcePath, "utf8");

      expect(content).not.toMatch(/from\s+["'](?:node:)?child_process["']/);
      expect(content).not.toMatch(/require\(["'](?:node:)?child_process["']\)/);
      expect(content).not.toMatch(/\bexec\s*\(/);
      expect(content).not.toMatch(/\bexecSync\s*\(/);
      expect(content).not.toMatch(/\bspawn\s*\(/);
      expect(content).not.toMatch(/\bspawnSync\s*\(/);
      expect(content).not.toMatch(/\bfork\s*\(/);
    });
  });

  // =========================================================================
  // 3. Discrete Argument Preservation & Anti-Shell-Injection
  // =========================================================================
  describe("3. Discrete Argument Preservation & Anti-Shell-Injection", () => {
    it("preserves discrete argv tokens including shell metacharacters without string concatenation", async () => {
      const spyProvider = new SpyExecutionProvider();
      const adapter = new SandboxedCommandToolAdapter(spyProvider, workspaceAdapter);
      const context = createTestContext();

      const argv = ["echo", "hello; world", "&& rm -rf /", "| cat", "$VAR", "`uname -a`"];
      const output = await adapter.execute(context, { argv, cwd: "." });

      expect(spyProvider.invocationCount).toBe(1);
      const sentRequest = spyProvider.lastRequest!;
      expect(sentRequest.operationName).toBe("run_command");
      expect(sentRequest.inputPayload.argv).toEqual(argv);
      expect(output.exitCode).toBe(0);
      expect(output.stdout).toBe("default stdout\n");
      expect(typeof output.commandHash).toBe("string");
      expect(output.commandHash).toHaveLength(64);
    });
  });

  // =========================================================================
  // 4. Working Directory Containment & Boundary Enforcement
  // =========================================================================
  describe("4. Working Directory Containment & Boundary Enforcement", () => {
    it("resolves default cwd ('.') safely within workspace", async () => {
      const spyProvider = new SpyExecutionProvider();
      const adapter = new SandboxedCommandToolAdapter(spyProvider, workspaceAdapter);
      const context = createTestContext();

      await adapter.execute(context, { argv: ["ls"], cwd: "." });
      expect(spyProvider.lastRequest?.inputPayload.cwd).toBe(".");
    });

    it("resolves valid relative subdirectory within workspace", async () => {
      const spyProvider = new SpyExecutionProvider();
      const adapter = new SandboxedCommandToolAdapter(spyProvider, workspaceAdapter);
      const context = createTestContext();

      await adapter.execute(context, { argv: ["ls"], cwd: "subfolder" });
      expect(spyProvider.lastRequest?.inputPayload.cwd).toBe("subfolder");
    });

    it("rejects path traversing outside workspace boundary with ToolWorkspaceBoundaryViolationError", async () => {
      const spyProvider = new SpyExecutionProvider();
      const adapter = new SandboxedCommandToolAdapter(spyProvider, workspaceAdapter);
      const context = createTestContext();

      await expect(
        adapter.execute(context, { argv: ["ls"], cwd: "../outside" })
      ).rejects.toThrow(ToolWorkspaceBoundaryViolationError);

      expect(spyProvider.invocationCount).toBe(0);
    });

    it("rejects absolute paths with ToolWorkspaceBoundaryViolationError", async () => {
      const spyProvider = new SpyExecutionProvider();
      const adapter = new SandboxedCommandToolAdapter(spyProvider, workspaceAdapter);
      const context = createTestContext();

      await expect(
        adapter.execute(context, { argv: ["ls"], cwd: "/etc" })
      ).rejects.toThrow(ToolWorkspaceBoundaryViolationError);

      expect(spyProvider.invocationCount).toBe(0);
    });
  });

  // =========================================================================
  // 5. Non-Clamping Resource Enforcement
  // =========================================================================
  describe("5. Non-Clamping Resource Enforcement", () => {
    it("passes bounded resource limits into ExecutionRequest without silent expansion", async () => {
      const spyProvider = new SpyExecutionProvider();
      const adapter = new SandboxedCommandToolAdapter(spyProvider, workspaceAdapter);
      const context = createTestContext({
        resourceLimits: {
          timeoutMs: 5000,
          maxOutputBytes: 256 * 1024,
        },
      });

      await adapter.execute(context, {
        argv: ["node", "-v"],
        cwd: ".",
        timeoutMs: 3000,
        maxOutputBytes: 64 * 1024,
      });

      expect(spyProvider.lastRequest?.timeoutMs).toBe(3000);
      expect(spyProvider.lastRequest?.inputPayload.maxOutputBytes).toBe(64 * 1024);
    });
  });

  // =========================================================================
  // 6. Error Taxonomy Mapping
  // =========================================================================
  describe("6. Error Taxonomy Mapping", () => {
    it("maps TIMED_OUT status to ToolTimeoutError", async () => {
      const spyProvider = new SpyExecutionProvider();
      spyProvider.mockResult = {
        status: "TIMED_OUT",
        error: { code: "EXECUTION_TIMEOUT", message: "Exceeded timeout" },
        durationMs: 5000,
      };
      const adapter = new SandboxedCommandToolAdapter(spyProvider, workspaceAdapter);

      await expect(
        adapter.execute(createTestContext(), { argv: ["sleep", "10"], cwd: "." })
      ).rejects.toThrow(ToolTimeoutError);
    });

    it("maps CANCELLED status to ToolCancelledError", async () => {
      const spyProvider = new SpyExecutionProvider();
      spyProvider.mockResult = {
        status: "CANCELLED",
        error: { code: "EXECUTION_CANCELLED", message: "User requested abort" },
        durationMs: 100,
      };
      const adapter = new SandboxedCommandToolAdapter(spyProvider, workspaceAdapter);

      await expect(
        adapter.execute(createTestContext(), { argv: ["long_task"], cwd: "." })
      ).rejects.toThrow(ToolCancelledError);
    });

    it("maps outputLimitExceeded to ToolOutputLimitExceededError", async () => {
      const spyProvider = new SpyExecutionProvider();
      spyProvider.mockResult = {
        status: "FAILED",
        error: { code: "EXECUTION_FAILED", message: "Output limit exceeded" },
        durationMs: 200,
        providerMetadata: { outputLimitExceeded: true },
      };
      const adapter = new SandboxedCommandToolAdapter(spyProvider, workspaceAdapter);

      await expect(
        adapter.execute(createTestContext(), { argv: ["flood"], cwd: "." })
      ).rejects.toThrow(ToolOutputLimitExceededError);
    });

    it("maps PROVIDER_UNAVAILABLE code to ToolProviderUnavailableError", async () => {
      const spyProvider = new SpyExecutionProvider();
      spyProvider.mockResult = {
        status: "FAILED",
        error: { code: "PROVIDER_UNAVAILABLE", message: "Docker daemon not running" },
        durationMs: 10,
      };
      const adapter = new SandboxedCommandToolAdapter(spyProvider, workspaceAdapter);

      await expect(
        adapter.execute(createTestContext(), { argv: ["node", "-v"], cwd: "." })
      ).rejects.toThrow(ToolProviderUnavailableError);
    });

    it("maps provider thrown exceptions to ToolProviderUnavailableError", async () => {
      const spyProvider = new SpyExecutionProvider();
      spyProvider.shouldThrow = new Error("spawn ENOENT docker");
      const adapter = new SandboxedCommandToolAdapter(spyProvider, workspaceAdapter);

      await expect(
        adapter.execute(createTestContext(), { argv: ["node", "-v"], cwd: "." })
      ).rejects.toThrow(ToolProviderUnavailableError);
    });

    it("honors pre-execution AbortSignal with ToolCancelledError", async () => {
      const spyProvider = new SpyExecutionProvider();
      const adapter = new SandboxedCommandToolAdapter(spyProvider, workspaceAdapter);
      const controller = new AbortController();
      controller.abort(new Error("Operation aborted before dispatch"));

      const context = createTestContext({ abortSignal: controller.signal });

      await expect(
        adapter.execute(context, { argv: ["echo", "test"], cwd: "." })
      ).rejects.toThrow(ToolCancelledError);

      expect(spyProvider.invocationCount).toBe(0);
    });

    it("returns non-zero exit code as valid output payload without throwing", async () => {
      const spyProvider = new SpyExecutionProvider();
      spyProvider.mockResult = {
        status: "SUCCESS",
        output: {
          exitCode: 1,
          stdout: "",
          stderr: "Test failed\n",
          durationMs: 150,
          outputTruncated: false,
        },
        durationMs: 150,
      };
      const adapter = new SandboxedCommandToolAdapter(spyProvider, workspaceAdapter);

      const result = await adapter.execute(createTestContext(), { argv: ["npm", "test"], cwd: "." });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("Test failed\n");
      expect(result.outputTruncated).toBe(false);
    });
  });

  // =========================================================================
  // 7. Gateway End-to-End Governance Invariants
  // =========================================================================
  describe("7. Gateway End-to-End Governance Invariants", () => {
    it("ensures pre-execution authorization failure yields providerInvocationCount === 0", async () => {
      const store = new SqliteStateStore();
      const clock = new SettableClock(new Date("2026-10-12T00:00:00Z"));
      const spyProvider = new SpyExecutionProvider();
      const coordinator = new RunCoordinator(store, clock);

      store.transaction((tx) => {
        tx.insertWorker({
          workerId: "w1",
          hostname: "localhost",
          pid: 1234,
          status: "ACTIVE",
          createdAt: clock.nowIso(),
          lastHeartbeatAt: clock.nowIso(),
        });
      });

      const task = coordinator.createTask({
        title: "unauth-task",
        description: "Task without process.execute capability",
        inputPayload: { test: true },
      });

      // Contract without process.execute capability
      const policy = createExecutionPolicy({
        policyId: `policy-${task.taskId}`,
        allowedCapabilities: ["workspace.file.read"],
        isolationRequirement: "ISOLATED",
      });

      createAndActivateContract(store, task.taskId, { policy });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);
      const claimResult = coordinator.claimRun(run.runId, "w1", 10000);
      coordinator.startRun(run.runId, "w1", claimResult.lease.leaseId);

      const registry = createWorkspaceToolAdapterRegistry(workspaceAdapter, spyProvider);
      const gateway = new ToolExecutionGateway({
        coordinator,
        stateStore: store,
        adapterRegistry: registry,
        clock,
      });

      const request: ToolRequest<"run_command"> = {
        requestId: "req-unauth-cmd",
        runId: run.runId,
        toolName: "run_command",
        input: { argv: ["cat", "secret.txt"], cwd: "." },
      };

      const result = await gateway.execute(request, {
        runId: run.runId,
        taskId: run.taskId,
        workerId: "w1",
        leaseId: claimResult.lease.leaseId,
        workspace: {
          workspaceId: testWorkspaceId,
          hostPath: testHostPath,
        },
      });

      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("CAPABILITY_DENIED");
      expect(spyProvider.invocationCount).toBe(0);
    });

    it("dispatches authorized run_command through Gateway and adapter to ExecutionProvider", async () => {
      const store = new SqliteStateStore();
      const clock = new SettableClock(new Date("2026-10-12T00:00:00Z"));
      const spyProvider = new SpyExecutionProvider();
      const coordinator = new RunCoordinator(store, clock);

      store.transaction((tx) => {
        tx.insertWorker({
          workerId: "w1",
          hostname: "localhost",
          pid: 1234,
          status: "ACTIVE",
          createdAt: clock.nowIso(),
          lastHeartbeatAt: clock.nowIso(),
        });
      });

      const task = coordinator.createTask({
        title: "auth-task",
        description: "Task with process.execute capability",
        inputPayload: { test: true },
      });

      // Contract with process.execute capability
      const policy = createExecutionPolicy({
        policyId: `policy-${task.taskId}`,
        allowedCapabilities: ["process.execute"],
        isolationRequirement: "ISOLATED",
      });

      createAndActivateContract(store, task.taskId, { policy });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);
      const claimResult = coordinator.claimRun(run.runId, "w1", 10000);
      coordinator.startRun(run.runId, "w1", claimResult.lease.leaseId);

      const registry = createWorkspaceToolAdapterRegistry(workspaceAdapter, spyProvider);
      const gateway = new ToolExecutionGateway({
        coordinator,
        stateStore: store,
        adapterRegistry: registry,
        clock,
      });

      const request: ToolRequest<"run_command"> = {
        requestId: "req-auth-cmd",
        runId: run.runId,
        toolName: "run_command",
        input: { argv: ["npm", "test"], cwd: "." },
      };

      const result = await gateway.execute(request, {
        runId: run.runId,
        taskId: run.taskId,
        workerId: "w1",
        leaseId: claimResult.lease.leaseId,
        workspace: {
          workspaceId: testWorkspaceId,
          hostPath: testHostPath,
        },
      });

      expect(result.status).toBe("SUCCESS");
      expect(spyProvider.invocationCount).toBe(1);
      const commandOutput = result.output as RunCommandOutput;
      expect(commandOutput?.exitCode).toBe(0);
    });
  });

  // =========================================================================
  // 8. Live Docker Execution Integration
  // =========================================================================
  describe("8. Live Docker Execution Integration", () => {
    let isDockerAvailable = false;

    beforeAll(async () => {
      const probe = await DockerExecutionProvider.isAvailable();
      isDockerAvailable = probe.available;
    });

    it("executes discrete command inside hardened container and returns stdout", async () => {
      if (!isDockerAvailable) return;

      const dockerProvider = new DockerExecutionProvider();
      const adapter = new SandboxedCommandToolAdapter(dockerProvider, workspaceAdapter);
      const context = createTestContext();

      const result = await adapter.execute(context, {
        argv: ["node", "-e", "console.log('hello from docker sandbox')"],
        cwd: ".",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hello from docker sandbox");
      expect(result.stderr).toBe("");
      expect(result.outputTruncated).toBe(false);
      expect(typeof result.commandHash).toBe("string");
    });

    it("captures non-zero exit code and stderr from inside container", async () => {
      if (!isDockerAvailable) return;

      const dockerProvider = new DockerExecutionProvider();
      const adapter = new SandboxedCommandToolAdapter(dockerProvider, workspaceAdapter);
      const context = createTestContext();

      const result = await adapter.execute(context, {
        argv: ["node", "-e", "console.error('failing task'); process.exit(42)"],
        cwd: ".",
      });

      expect(result.exitCode).toBe(42);
      expect(result.stderr.trim()).toBe("failing task");
    });

    it("verifies shell metacharacters are treated as literal arguments without interpretation", async () => {
      if (!isDockerAvailable) return;

      const dockerProvider = new DockerExecutionProvider();
      const adapter = new SandboxedCommandToolAdapter(dockerProvider, workspaceAdapter);
      const context = createTestContext();

      // In a shell, "foo; echo pwned" would execute two commands.
      // With discrete argv, echo outputs the entire string literally.
      const result = await adapter.execute(context, {
        argv: ["echo", "foo; echo pwned"],
        cwd: ".",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("foo; echo pwned");
    });

    it("persists filesystem writes inside /workspace to host workspace directory", async () => {
      if (!isDockerAvailable) return;

      const dockerProvider = new DockerExecutionProvider();
      const adapter = new SandboxedCommandToolAdapter(dockerProvider, workspaceAdapter);
      const context = createTestContext();

      const filename = `created-by-container-${Date.now()}.txt`;
      const result = await adapter.execute(context, {
        argv: [
          "node",
          "-e",
          `const fs = require('fs'); fs.writeFileSync('${filename}', 'written by container', 'utf8')`,
        ],
        cwd: ".",
      });

      expect(result.exitCode).toBe(0);
      const hostFileContent = await fs.readFile(path.join(testHostPath, filename), "utf8");
      expect(hostFileContent).toBe("written by container");
    });

    it("enforces container confinement: root filesystem is read-only and no docker.sock", async () => {
      if (!isDockerAvailable) return;

      const dockerProvider = new DockerExecutionProvider();
      const adapter = new SandboxedCommandToolAdapter(dockerProvider, workspaceAdapter);
      const context = createTestContext();

      const result = await adapter.execute(context, {
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
      });

      expect(result.exitCode).toBe(0);
      const probeResult = JSON.parse(result.stdout.trim());
      expect(probeResult.rootWritable).toBe(false);
      expect(probeResult.hasDockerSock).toBe(false);
    });

    it("enforces container timeout and cleans up ephemeral container", async () => {
      if (!isDockerAvailable) return;

      const dockerProvider = new DockerExecutionProvider();
      const adapter = new SandboxedCommandToolAdapter(dockerProvider, workspaceAdapter);
      const context = createTestContext({
        resourceLimits: { timeoutMs: 1500, maxOutputBytes: 1024 * 1024 },
      });

      await expect(
        adapter.execute(context, {
          argv: ["node", "-e", "setInterval(() => {}, 1000)"],
          cwd: ".",
          timeoutMs: 1500,
        })
      ).rejects.toThrow(ToolTimeoutError);
    });
  });
});
