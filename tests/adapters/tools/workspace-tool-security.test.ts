import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspaceToolAdapterRegistry } from "../../../src/adapters/tools/tool-adapter-registry.factory.js";
import { NodeFsWorkspaceAdapter } from "../../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { SqliteStateStore } from "../../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../../src/application/run-coordinator.js";
import {
  ToolExecutionGateway,
  TrustedToolInvocationContext,
} from "../../../src/application/tool-execution-gateway.js";
import { createExecutionPolicy } from "../../../src/domain/policy.js";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "../../../src/ports/execution-provider.port.js";
import { SettableClock } from "../../../src/ports/clock.port.js";
import { createAndActivateContract } from "../../application/test-helpers.js";
import { createMockGitRepository } from "./git-test-helper.js";

class CountingExecutionProvider implements ExecutionProvider {
  readonly name = "counting-provider";
  invocationCount = 0;

  async execute<TInput = unknown, TOutput = unknown>(
    _request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocationCount++;
    throw new Error("CRITICAL SECURITY VIOLATION: ExecutionProvider was called!");
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }
}

describe("Workspace Tool Security Invariants & Adapter Registry", () => {
  let tempBaseDir: string;
  let workspaceRootDir: string;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;
  let clock: SettableClock;
  let countingProvider: CountingExecutionProvider;
  let gateway: ToolExecutionGateway;

  const workspaceId = "ws-sec-1";
  let workspaceHostPath: string;
  let invocationContext: TrustedToolInvocationContext;

  beforeAll(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "sec-tool-test-"));
    workspaceRootDir = path.join(tempBaseDir, "workspaces");
    await fs.mkdir(workspaceRootDir, { recursive: true });

    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: workspaceRootDir });
    clock = new SettableClock("2026-03-30T10:00:00.000Z");
    store = new SqliteStateStore();
    coordinator = new RunCoordinator(store, clock);
    countingProvider = new CountingExecutionProvider();

    store.transaction((tx) => {
      tx.insertWorker({
        workerId: "worker-1",
        hostname: "localhost",
        pid: 1234,
        status: "ACTIVE",
        createdAt: clock.nowIso(),
        lastHeartbeatAt: clock.nowIso(),
      });
    });

    const task = coordinator.createTask({
      title: "security-tool-task",
      description: "Task for testing workspace tools security invariants",
      inputPayload: { test: true },
    });

    const policy = createExecutionPolicy({
      policyId: `policy-${task.taskId}`,
      allowedCapabilities: [
        "workspace.file.read",
        "workspace.file.write",
        "workspace.code.search",
        "git.read",
        "process.execute",
      ],
      isolationRequirement: "ISOLATED",
    });

    createAndActivateContract(store, task.taskId, {
      policy,
      timeoutMs: 30000,
      maxOutputBytes: 1048576,
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);
    const claimResult = coordinator.claimRun(run.runId, "worker-1", 10000);
    coordinator.startRun(run.runId, "worker-1", claimResult.lease.leaseId);

    const ws = await workspaceAdapter.provisionWorkspace({
      workspaceId,
      runId: run.runId,
      taskId: task.taskId,
      maxWorkspaceBytes: 50 * 1024 * 1024,
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
    workspaceHostPath = ws.hostPath;

    await createMockGitRepository(workspaceHostPath, [
      { path: "tracked.txt", content: "initial content\n" },
    ]);

    invocationContext = {
      runId: run.runId,
      taskId: task.taskId,
      workerId: "worker-1",
      leaseId: claimResult.lease.leaseId,
      workspace: {
        workspaceId,
        hostPath: workspaceHostPath,
        containerMountPath: "/workspace",
      },
    };

    const registry = createWorkspaceToolAdapterRegistry(workspaceAdapter);

    gateway = new ToolExecutionGateway({
      coordinator,
      stateStore: store,
      adapterRegistry: registry,
      clock,
    });
  });

  afterAll(async () => {
    if (tempBaseDir) {
      await fs.rm(tempBaseDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("registers exactly 5 deterministic tools and explicitly excludes run_command", () => {
    const registry = createWorkspaceToolAdapterRegistry(workspaceAdapter);

    expect(registry.hasAdapter("read_file")).toBe(true);
    expect(registry.hasAdapter("write_file")).toBe(true);
    expect(registry.hasAdapter("search_code")).toBe(true);
    expect(registry.hasAdapter("git_status")).toBe(true);
    expect(registry.hasAdapter("git_diff")).toBe(true);

    expect(registry.hasAdapter("run_command")).toBe(false);
    expect(registry.getAdapter("run_command")).toBeNull();
  });

  it("executes all 5 workspace tools with ZERO provider invocations (providerInvocationCount === 0)", async () => {
    expect(countingProvider.invocationCount).toBe(0);

    // 1. write_file
    const writeRes = await gateway.execute(
      {
        requestId: "req-1",
        runId: invocationContext.runId,
        toolName: "write_file",
        input: { path: "hello.txt", content: "World", overwrite: true },
      },
      invocationContext
    );
    expect(writeRes.status).toBe("SUCCESS");

    // 2. read_file
    const readRes = await gateway.execute(
      {
        requestId: "req-2",
        runId: invocationContext.runId,
        toolName: "read_file",
        input: { path: "hello.txt", offsetLine: 1, limitLines: 500 },
      },
      invocationContext
    );
    expect(readRes.status).toBe("SUCCESS");
    expect((readRes.output as any).content).toBe("World");

    // 3. search_code
    const searchRes = await gateway.execute(
      {
        requestId: "req-3",
        runId: invocationContext.runId,
        toolName: "search_code",
        input: {
          query: "World",
          path: ".",
          isRegex: false,
          filePattern: "*",
          maxResults: 50,
        },
      },
      invocationContext
    );
    expect(searchRes.status).toBe("SUCCESS");
    expect((searchRes.output as any).totalMatches).toBe(1);

    // 4. git_status
    const statusRes = await gateway.execute(
      {
        requestId: "req-4",
        runId: invocationContext.runId,
        toolName: "git_status",
        input: { path: "." },
      },
      invocationContext
    );
    expect(statusRes.status).toBe("SUCCESS");
    expect((statusRes.output as any).untracked).toContain("hello.txt");

    // 5. git_diff
    const diffRes = await gateway.execute(
      {
        requestId: "req-5",
        runId: invocationContext.runId,
        toolName: "git_diff",
        input: { path: ".", staged: false },
      },
      invocationContext
    );
    expect(diffRes.status).toBe("SUCCESS");

    // Invariant: Provider was NEVER invoked for any of the 5 workspace tools
    expect(countingProvider.invocationCount).toBe(0);
  });

  it("fails run_command as TOOL_PROVIDER_UNAVAILABLE because it is not registered in adapter registry", async () => {
    const res = await gateway.execute(
      {
        requestId: "req-cmd",
        runId: invocationContext.runId,
        toolName: "run_command",
        input: { argv: ["echo", "test"], cwd: "." },
      },
      invocationContext
    );

    expect(res.status).toBe("FAILED");
    expect(res.error?.code).toBe("TOOL_PROVIDER_UNAVAILABLE");
    expect(countingProvider.invocationCount).toBe(0);
  });

  it("never discloses host absolute paths in output or error messages", async () => {
    const res = await gateway.execute(
      {
        requestId: "req-escape",
        runId: invocationContext.runId,
        toolName: "read_file",
        input: { path: "../../../etc/shadow", offsetLine: 1, limitLines: 500 },
      },
      invocationContext
    );

    expect(res.status).toBe("FAILED");
    expect(res.error).toBeDefined();
    expect(res.error?.message).not.toContain(workspaceRootDir);
    expect(res.error?.message).not.toContain(workspaceHostPath);
  });
});
