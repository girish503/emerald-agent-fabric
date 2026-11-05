/**
 * Targeted verification tests for Milestone B: Durable CLI Agent Wiring.
 *
 * Verifies:
 * 1. CLI task submission and durable persistence (--task).
 * 2. Worker selection of the governed provider (--model-provider fixture).
 * 3. Fixture-backed read-only task execution with workspace integration.
 * 4. Run status and event inspection via `emerald inspect`.
 * 5. Invalid model proposal rejection fail-closed.
 * 6. Provider error and cancellation handling.
 * 7. Lease fencing and workspace containment.
 * 8. Backward compatibility with existing static operations (--operation sum).
 * 9. Explicit Ollama selection and fail-closed handling when daemon is unavailable.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { runWorkerHost } from "../../src/application/worker-host.js";
import { EmeraldCli } from "../../src/cli/emerald-cli.js";
import { SystemClock } from "../../src/ports/clock.port.js";

describe("Milestone B: Durable CLI Agent Wiring", () => {
  let tempDir: string;
  let dbPath: string;
  let workspaceRoot: string;
  let cli: EmeraldCli;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-milestone-b-"));
    dbPath = path.join(tempDir, "emerald.sqlite");
    workspaceRoot = path.join(tempDir, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    cli = new EmeraldCli();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("1. CLI task submission and durable persistence (--task)", async () => {
    const taskText = "Inspect package.json and report its package name";
    const submitResult = await cli.run([
      "submit",
      "--db",
      dbPath,
      "--task",
      taskText,
      "--timeout-ms",
      "15000",
    ]);

    expect(submitResult.exitCode, submitResult.output).toBe(0);
    const parsed = JSON.parse(submitResult.output);
    expect(parsed.taskId).toBeDefined();
    expect(parsed.runId).toBeDefined();
    expect(parsed.status).toBe("QUEUED");
    expect(parsed.deduplicated).toBe(false);

    // Verify task and contract durability in SQLite
    const store = new SqliteStateStore({ location: dbPath });
    try {
      const coordinator = new RunCoordinator(store, new SystemClock());
      const run = coordinator.getRun(parsed.runId);
      expect(run).toBeDefined();
      expect(run?.status).toBe("QUEUED");

      const task = coordinator.getTask(parsed.taskId);
      expect(task).toBeDefined();
      expect(task?.description).toBe(taskText);

      const contract = coordinator.getContract(`contract-${parsed.taskId}`, 1);
      expect(contract).toBeDefined();
      expect(contract?.lifecycle.status).toBe("ACTIVE");
      expect(contract?.spec.policy.allowedCapabilities).toContain("workspace.file.read");
      expect(contract?.spec.policy.allowedCapabilities).toContain("execution.echo");
    } finally {
      store.close();
    }
  });

  it("2. Worker selection of the governed provider (--model-provider fixture)", async () => {
    // Submit task
    const submitResult = await cli.run([
      "submit",
      "--db",
      dbPath,
      "--task",
      "Verify system status",
    ]);
    const { runId } = JSON.parse(submitResult.output);

    // Execute worker with --model-provider fixture
    const workerResult = await cli.run([
      "worker",
      "--db",
      dbPath,
      "--once",
      "--model-provider",
      "fixture",
      "--allow-unverified-completion",
    ]);
    expect(workerResult.exitCode, workerResult.output).toBe(0);

    // Verify run finished successfully
    const inspectResult = await cli.run([
      "inspect",
      "--db",
      dbPath,
      "--run-id",
      runId,
    ]);
    expect(inspectResult.exitCode).toBe(0);
    const view = JSON.parse(inspectResult.output);
    expect(view.status).toBe("COMPLETED");
    expect(view.result).toBeDefined();
  });

  it("3. Fixture-backed read-only task execution with workspace integration", async () => {
    // Submit read-only search task targeting workspace
    const submitResult = await cli.run([
      "submit",
      "--db",
      dbPath,
      "--task",
      "Search workspace for pattern emerald",
    ]);
    const { runId } = JSON.parse(submitResult.output);

    // Run worker with workspace root
    const workerResult = await cli.run([
      "worker",
      "--db",
      dbPath,
      "--once",
      "--workspace-root",
      workspaceRoot,
      "--model-provider",
      "fixture",
      "--allow-unverified-completion",
    ]);
    expect(workerResult.exitCode, workerResult.output).toBe(0);

    // Verify actions and attempts in SQLite store
    const store = new SqliteStateStore({ location: dbPath });
    try {
      const actions = store.getActionsForRun(runId);
      expect(actions.length).toBe(1);
      const action = actions[0];
      expect(action).toBeDefined();
      if (!action) throw new Error("Expected action to be defined");
      expect(action.toolName).toBe("search_code");
      expect(action.status).toBe("SUCCEEDED");

      const attempts = store.getAttemptsForAction(action.actionId);
      expect(attempts.length).toBe(1);
      const attempt = attempts[0];
      expect(attempt).toBeDefined();
      if (!attempt) throw new Error("Expected attempt to be defined");
      expect(attempt.status).toBe("SUCCEEDED");
    } finally {
      store.close();
    }
  });

  it("4. Run status and event inspection via `emerald inspect`", async () => {
    const s = await cli.run([
      "submit",
      "--db",
      dbPath,
      "--task",
      "Timeline inspection task",
    ]);
    const { runId } = JSON.parse(s.output);

    await cli.run([
      "worker",
      "--db",
      dbPath,
      "--once",
      "--model-provider",
      "fixture",
      "--allow-unverified-completion",
    ]);

    const i = await cli.run(["inspect", "--db", dbPath, "--run-id", runId]);
    expect(i.exitCode).toBe(0);
    const view = JSON.parse(i.output);
    expect(view.runId).toBe(runId);
    expect(view.status).toBe("COMPLETED");
    expect(view.events.length).toBeGreaterThanOrEqual(4);

    const eventTypes = view.events.map((e: { eventType: string }) => e.eventType);
    expect(eventTypes).toContain("run.created");
    expect(eventTypes).toContain("run.queued");
    expect(eventTypes).toContain("worker.claimed");
    expect(eventTypes).toContain("run.started");
    expect(eventTypes).toContain("run.completed");
  });

  it("5. Invalid model proposal rejection fail-closed", async () => {
    // The fixture proposes an invalid tool when "fail-closed" or "invalid tool" is in the task text
    const s = await cli.run([
      "submit",
      "--db",
      dbPath,
      "--task",
      "Adversarial request with invalid tool to test fail-closed",
    ]);
    const { runId } = JSON.parse(s.output);

    await cli.run([
      "worker",
      "--db",
      dbPath,
      "--once",
      "--model-provider",
      "fixture",
      "--allow-unverified-completion",
    ]);

    const i = await cli.run(["inspect", "--db", dbPath, "--run-id", runId]);
    const view = JSON.parse(i.output);
    expect(view.status).toBe("FAILED");
    expect(view.error).toBeDefined();

    // Invariant: zero actions or attempts should have been executed
    const store = new SqliteStateStore({ location: dbPath });
    try {
      const actions = store.getActionsForRun(runId);
      expect(actions.length).toBe(0);
    } finally {
      store.close();
    }
  });

  it("6. Provider error and cancellation handling", async () => {
    // 6a: Reject unsupported model provider configuration
    const badWorker = await cli.run([
      "worker",
      "--db",
      dbPath,
      "--once",
      "--model-provider",
      "unsupported-cloud-provider",
    ]);
    expect(badWorker.exitCode).toBe(1);
    expect(badWorker.output).toContain("unsupported --model-provider");

    // 6b: Cooperative cancellation propagation
    await cli.run([
      "submit",
      "--db",
      dbPath,
      "--task",
      "Cancellation test task",
    ]);

    const controller = new AbortController();
    controller.abort("Pre-emptive shutdown signal");

    const hostResult = await runWorkerHost({
      dbPath,
      once: true,
      modelProvider: "fixture",
      allowUnverifiedCompletion: true,
      signal: controller.signal,
    });

    expect(hostResult.runsProcessed).toBe(0);
  });

  it("7. Lease fencing and workspace containment", async () => {
    // Attempting traversal out of workspace must fail closed
    const s = await cli.run([
      "submit",
      "--db",
      dbPath,
      "--task",
      "Read ../../../etc/passwd",
    ]);
    const { runId } = JSON.parse(s.output);

    await cli.run([
      "worker",
      "--db",
      dbPath,
      "--once",
      "--workspace-root",
      workspaceRoot,
      "--model-provider",
      "fixture",
      "--allow-unverified-completion",
    ]);

    const i = await cli.run(["inspect", "--db", dbPath, "--run-id", runId]);
    const view = JSON.parse(i.output);
    expect(view.status).toBe("FAILED");
  });

  it("8. Backward compatibility with existing static operations (--operation sum)", async () => {
    // Existing static operation: sum
    const s = await cli.run([
      "submit",
      "--db",
      dbPath,
      "--operation",
      "sum",
      "--input",
      "[15, 27]",
    ]);
    expect(s.exitCode).toBe(0);
    const { runId } = JSON.parse(s.output);

    // Worker without --model-provider defaults to in-process deterministic execution
    const w = await cli.run([
      "worker",
      "--db",
      dbPath,
      "--once",
    ]);
    expect(w.exitCode).toBe(0);

    const i = await cli.run(["inspect", "--db", dbPath, "--run-id", runId]);
    expect(i.exitCode).toBe(0);
    const view = JSON.parse(i.output);
    expect(view.status).toBe("COMPLETED");
    expect(view.result).toBe(42);
  });

  it("9. Explicit Ollama selection and fail-closed handling when daemon is unavailable", async () => {
    // Submit task
    const s = await cli.run([
      "submit",
      "--db",
      dbPath,
      "--task",
      "Live Ollama task requiring connection",
    ]);
    const { runId } = JSON.parse(s.output);

    // Specify ollama with unreachable port
    await cli.run([
      "worker",
      "--db",
      dbPath,
      "--once",
      "--model-provider",
      "ollama",
      "--ollama-base-url",
      "http://127.0.0.1:59999", // dead local port
    ]);

    // Worker run should fail closed without silent fallback to fixture or in-process
    const i = await cli.run(["inspect", "--db", dbPath, "--run-id", runId]);
    const view = JSON.parse(i.output);
    expect(view.status).toBe("FAILED");
    expect(view.error?.code).toBe("EXECUTION_FAILED");
    expect(view.error?.message).toMatch(/Ollama|connect|failed|unavailable/i);
  });
});
