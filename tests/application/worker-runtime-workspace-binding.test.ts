import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { RunCoordinator, WorkerRuntime } from "../../src/application/index.js";
import { createDefaultInProcessPolicy } from "../../src/domain/policy.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { ExecutionProvider, ExecutionRequest, ExecutionResult } from "../../src/ports/execution-provider.port.js";
import { createAndActivateContract } from "./test-helpers.js";

class RecordingProvider implements ExecutionProvider {
  readonly name = "in-process";
  readonly tenantModel = "NONE" as const;
  readonly quiescence = { async quiesceRun(_runId: string) { return { status: "QUIESCENT" as const, stopped: 0 }; } };
  readonly invocations: ExecutionRequest[] = [];
  async execute<TInput = unknown, TOutput = unknown>(request: ExecutionRequest<TInput>): Promise<ExecutionResult<TOutput>> {
    this.invocations.push(request);
    return { status: "SUCCESS", output: { ok: true } as TOutput, durationMs: 1, providerMetadata: { provider: this.name, exitCode: 0 } };
  }
}

describe("Run workspace ownership is bound when the workspace is provisioned (one workspace per run)", { timeout: 30000 }, () => {
  let testRoot: string;
  let adapter: NodeFsWorkspaceAdapter;

  beforeEach(async () => {
    testRoot = path.join(os.tmpdir(), `emerald-ws-bind-${crypto.randomUUID()}`);
    await fs.mkdir(testRoot, { recursive: true, mode: 0o700 });
    testRoot = await fs.realpath(testRoot);
    adapter = new NodeFsWorkspaceAdapter({ workspaceRoot: testRoot });
  });

  afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true }).catch(() => {});
  });

  function setup() {
    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock, undefined, adapter);
    const provider = new RecordingProvider();
    const runtime = new WorkerRuntime({ coordinator, clock, executionProvider: provider, workspacePort: adapter });
    const task = coordinator.createTask({ title: "echo", inputPayload: { foo: "bar" } });
    createAndActivateContract(store, task.taskId, { policy: createDefaultInProcessPolicy("test-policy") });
    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);
    return { store, coordinator, provider, runtime, run };
  }

  it("persists the canonical workspace root for the run and uses a stable per-run workspace id", async () => {
    const { store, provider, runtime, run } = setup();

    const result = await runtime.runOnce(run.runId);

    expect(result.status).toBe("COMPLETED");
    const hostPath = provider.invocations[0]!.workspace!.hostPath;
    expect(store.getRunWorkspaceBinding(run.runId)).toBe(hostPath);
    expect(provider.invocations[0]!.workspace!.workspaceId).toBe(`ws-${run.runId}`);
    expect(path.basename(hostPath)).toBe(`ws-${run.runId}`);
  });

  it("the binding survives workspace disposal so later recovery still knows what the run owned", async () => {
    const { store, provider, runtime, run } = setup();
    await runtime.runOnce(run.runId);

    const hostPath = provider.invocations[0]!.workspace!.hostPath;
    await expect(fs.stat(hostPath)).rejects.toThrow(); // disposed on completion
    expect(store.getRunWorkspaceBinding(run.runId)).toBe(hostPath);
  });

  it("a run already bound to a different workspace fails closed: no execution, workspace disposed", async () => {
    const { store, provider, runtime, run } = setup();
    store.bindRunWorkspace(run.runId, path.join(testRoot, "some-other-owner"), new Date().toISOString());

    const result = await runtime.runOnce(run.runId);

    expect(result.status).toBe("FAILED");
    expect(provider.invocations).toHaveLength(0);
    expect(JSON.stringify(result)).toMatch(/WORKSPACE_BOUNDARY_FAILURE/);
    await expect(fs.stat(path.join(testRoot, `ws-${run.runId}`))).rejects.toThrow();
    expect(store.getRunWorkspaceBinding(run.runId)).toBe(path.join(testRoot, "some-other-owner"));
  });

  it("a later attempt of the same run provisions the identical workspace path and keeps the same binding", async () => {
    const { store, provider, runtime, run } = setup();
    await runtime.runOnce(run.runId);
    const firstPath = provider.invocations[0]!.workspace!.hostPath;

    // Same run, next attempt: the adapter hands back the same path for the same run
    const handle = await adapter.provisionWorkspace({
      workspaceId: `ws-${run.runId}`,
      runId: run.runId,
      taskId: "t",
      maxWorkspaceBytes: 1024,
      maxFileSizeBytes: 1024,
    } as never);

    expect(handle.hostPath).toBe(firstPath);
    expect(store.bindRunWorkspace(run.runId, handle.hostPath, new Date().toISOString())).toBe(firstPath);
  });
});
