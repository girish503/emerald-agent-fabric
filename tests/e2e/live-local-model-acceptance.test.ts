import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EmeraldCli } from "../../src/cli/emerald-cli.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";

const execFileAsync = promisify(execFile);

const LIVE_OLLAMA_ENABLED = process.env.EMERALD_LIVE_OLLAMA === "true";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const TARGET_MODEL = process.env.OLLAMA_MODEL || "qwen2.5-coder:3b";

/**
 * Probe local Ollama service to check availability and installed models.
 */
async function probeOllama(
  baseUrl: string,
  modelName: string
): Promise<{ reachable: boolean; modelAvailable: boolean; installedModels: string[] }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      return { reachable: false, modelAvailable: false, installedModels: [] };
    }
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    const installed = (data.models || []).map((m) => m.name);
    const targetPrefix = modelName.split(":")[0]?.toLowerCase() || "";
    const isAvailable = installed.some((name) => {
      const lower = name.toLowerCase();
      const modelLower = modelName.toLowerCase();
      return (
        lower === modelLower ||
        lower.startsWith(`${modelLower}:`) ||
        lower === `${modelLower}:latest` ||
        (targetPrefix.length > 0 && lower.split(":")[0] === targetPrefix)
      );
    });
    return { reachable: true, modelAvailable: isAvailable, installedModels: installed };
  } catch {
    return { reachable: false, modelAvailable: false, installedModels: [] };
  }
}

describe("Milestone 2.22 — Live Local Model Acceptance & Governed Agent Execution", () => {
  let tempDir: string;
  let dbPath: string;
  let workspaceRoot: string;
  let artifactRoot: string;
  let repoFixtureDir: string;
  let cli: EmeraldCli;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-live-acceptance-"));
    dbPath = path.join(tempDir, "state.db");
    workspaceRoot = path.join(tempDir, "workspaces");
    artifactRoot = path.join(tempDir, "artifacts");
    repoFixtureDir = path.join(tempDir, "fixture-repo");

    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(artifactRoot, { recursive: true });
    fs.mkdirSync(path.join(repoFixtureDir, "input"), { recursive: true });

    // Initialize git repository in fixture directory
    await execFileAsync("git", ["init"], { cwd: repoFixtureDir });
    await execFileAsync("git", ["config", "user.name", "Emerald Acceptance Agent"], { cwd: repoFixtureDir });
    await execFileAsync("git", ["config", "user.email", "acceptance@emerald.fabric"], { cwd: repoFixtureDir });

    // Populate project brief requirement
    const briefContent = [
      "# Project Brief: Emerald Agent Fabric Analysis",
      "",
      "## Background",
      "Emerald Agent Fabric is a zero-cost research-grade autonomous software-engineering execution infrastructure.",
      "",
      "## Requirements",
      "1. Architectural Independence: The domain core must remain strictly model-independent, provider-neutral, and free of vendor locks.",
      "2. Capability Security: All agent actions must be governed through typed policies, capability fencing, and latch verification before commitment.",
      "3. Durability & Observability: Execution state must persist durably with fencing tokens and complete event timeline auditability.",
      "",
      "## Implementation Risks",
      "- Context displacement in small local open-weight language models during multi-turn observation loops.",
      "- Lease expiration or worker contention during CPU-intensive local model inference.",
      "- Non-deterministic schema violations from local models without strict constrained decoding.",
      "",
      "## Implementation Recommendations",
      "- Employ dynamic tool filtering and contextual residency tracking to prevent repetitive tool invocations.",
      "- Enforce explicit latch verification on required deliverable paths before marking goals complete.",
      "- Maintain a zero-cost local inference posture using quantized open-weight models via Ollama.",
      "",
    ].join("\n");

    fs.writeFileSync(path.join(repoFixtureDir, "input", "project-brief.md"), briefContent, "utf8");
    fs.writeFileSync(path.join(repoFixtureDir, "README.md"), "# Acceptance Fixture\n", "utf8");

    await execFileAsync("git", ["add", "."], { cwd: repoFixtureDir });
    await execFileAsync("git", ["commit", "-m", "Baseline brief fixture"], { cwd: repoFixtureDir });

    cli = new EmeraldCli();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Ignore directory cleanup contention on Windows
    }
  });

  const json = async (args: string[], expectedExit = 0) => {
    const res = await cli.run(args);
    expect(res.exitCode, res.output).toBe(expectedExit);
    return JSON.parse(res.output);
  };

  /**
   * Scenario 1: Unreachable Ollama endpoint fails closed deterministically.
   * Proves that when Ollama is offline or on an invalid port, the worker and
   * step controller fail closed into FAILED without silent data loss or indefinite hangs.
   */
  it("Scenario 1: fails closed when local Ollama endpoint is unreachable", async () => {
    const unreachablePort = 65534;
    const unreachableUrl = `http://127.0.0.1:${unreachablePort}`;

    // 1. Submit task with governed read/write capabilities
    const submitRes = await json([
      "router",
      "submit",
      "--db",
      dbPath,
      "--key",
      "k-offline-probe-1",
      "--task",
      "Read input/project-brief.md and generate reports/project-analysis.md",
      "--repo",
      repoFixtureDir,
      "--capabilities",
      "workspace.file.read,workspace.file.write,workspace.code.search,git.read",
      "--timeout-ms",
      "10000",
    ]);

    expect(submitRes.duplicate).toBe(false);
    expect(submitRes.status).toBe("CREATED");
    const { runId, taskId } = submitRes;

    // 2. Route task to QUEUED
    const routeRes = await cli.run(["router", "host", "--db", dbPath, "--once"]);
    expect(routeRes.exitCode).toBe(0);

    // 3. Worker attempts execution against unreachable Ollama
    const workerRes = await cli.run([
      "worker",
      "--db",
      dbPath,
      "--once",
      "--model-provider",
      "ollama",
      "--ollama-base-url",
      unreachableUrl,
      "--model",
      TARGET_MODEL,
      "--model-timeout-ms",
      "2000",
      "--workspace-root",
      workspaceRoot,
    ]);
    expect(workerRes.exitCode).toBe(0);

    // 4. Verify durable persistence transitioned to FAILED
    const store = new SqliteStateStore({ location: dbPath });
    try {
      const persistedRun = store.getRun(runId);
      expect(persistedRun).not.toBeNull();
      expect(persistedRun?.status).toBe("FAILED");
      expect(persistedRun?.errorPayload).toBeDefined();

      const events = store.getEventsForRun(runId);
      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes).toContain("run.created");
      expect(eventTypes).toContain("run.queued");
      expect(eventTypes).toContain("worker.claimed");
      expect(eventTypes).toContain("run.failed");
    } finally {
      store.close();
    }

    // 5. Verify Operator Observability inspection captures failure
    const inspectRes = await json(["run", "inspect", "--db", dbPath, "--run-id", runId, "--json"]);
    expect(inspectRes.run.status).toBe("FAILED");
    expect(inspectRes.failure).not.toBeNull();

    const eventsRes = await json(["run", "events", "--db", dbPath, "--run-id", runId, "--json"]);
    expect(eventsRes.returnedCount).toBeGreaterThanOrEqual(4);

    const taskTreeRes = await json(["task", "tree", "--db", dbPath, "--task-id", taskId, "--json"]);
    expect(taskTreeRes.rootTaskId).toBe(taskId);
    expect(taskTreeRes.tree.runStatus).toBe("FAILED");
  });

  /**
   * Scenario 2: Non-existent model name fails closed when Ollama is running.
   */
  it("Scenario 2: fails closed when requested Ollama model does not exist", async () => {
    const probe = await probeOllama(OLLAMA_BASE_URL, TARGET_MODEL);
    if (!probe.reachable) {
      // When Ollama is offline in standard CI, test passes by skipping model-not-found test
      return;
    }

    const nonExistentModel = "non-existent-emerald-model-xyz-999";

    const submitRes = await json([
      "router",
      "submit",
      "--db",
      dbPath,
      "--key",
      "k-missing-model-1",
      "--task",
      "Read input/project-brief.md and generate reports/project-analysis.md",
      "--repo",
      repoFixtureDir,
      "--capabilities",
      "workspace.file.read,workspace.file.write,workspace.code.search,git.read",
      "--timeout-ms",
      "10000",
    ]);
    const { runId } = submitRes;

    await cli.run(["router", "host", "--db", dbPath, "--once"]);

    const workerRes = await cli.run([
      "worker",
      "--db",
      dbPath,
      "--once",
      "--model-provider",
      "ollama",
      "--ollama-base-url",
      OLLAMA_BASE_URL,
      "--model",
      nonExistentModel,
      "--model-timeout-ms",
      "5000",
      "--workspace-root",
      workspaceRoot,
    ]);
    expect(workerRes.exitCode).toBe(0);

    const store = new SqliteStateStore({ location: dbPath });
    try {
      const persistedRun = store.getRun(runId);
      expect(persistedRun?.status).toBe("FAILED");
    } finally {
      store.close();
    }
  });

  /**
   * Scenario 3: Full end-to-end acceptance with live local model (qwen2.5-coder:3b).
   * Gated behind EMERALD_LIVE_OLLAMA=true to keep baseline CI deterministic.
   *
   * STATUS: NOT PASSING with the current generic reminder. Three live reruns timed out at 600s after
   * read_file, write_file, write_file (the model repeated the write instead of concluding). The live path never
   * falls back to a fixture; this test reports the timeout truthfully. See
   * docs/research/live-local-model-acceptance.md.
   *
   * Verifies:
   * 1. Multi-turn autonomous reasoning:
   *    - Turn 1: Governed `read_file` on `input/project-brief.md`
   *    - Turn 2: Governed `write_file` creating `reports/project-analysis.md`
   *    - Turn 3: Concluding with `isGoalReached: true`
   * 2. Physical latch verification passes and run reaches COMPLETED.
   * 3. Report contains all four required sections.
   * 4. Milestone 2.21 Operator CLI commands (run inspect, run events, task tree) produce valid audit evidence.
   */
  it(
    "Scenario 3: executes full live governed workflow with local open-weight model",
    async () => {
      if (!LIVE_OLLAMA_ENABLED) {
        console.log("Skipping Scenario 3: EMERALD_LIVE_OLLAMA is not set to 'true'.");
        return;
      }

      const probe = await probeOllama(OLLAMA_BASE_URL, TARGET_MODEL);
      if (!probe.reachable) {
        throw new Error(
          `Local Ollama is not reachable at ${OLLAMA_BASE_URL}. Ensure Ollama is running before executing live acceptance tests.`
        );
      }
      if (!probe.modelAvailable) {
        throw new Error(
          `Target model '${TARGET_MODEL}' is not installed in local Ollama. Installed models: ${probe.installedModels.join(", ")}.`
        );
      }

      const taskDescription =
        "Read input/project-brief.md and generate a comprehensive analysis report in reports/project-analysis.md containing Project Objective, Three Key Requirements, Implementation Risks, and Implementation Recommendations.";

      // 1. Submit task durably
      const submitRes = await json([
        "router",
        "submit",
        "--db",
        dbPath,
        "--key",
        "k-live-acceptance-qwen-1",
        "--task",
        taskDescription,
        "--repo",
        repoFixtureDir,
        "--capabilities",
        "workspace.file.read,workspace.file.write,workspace.code.search,git.read",
        "--timeout-ms",
        "600000",
      ]);

      expect(submitRes.duplicate).toBe(false);
      expect(submitRes.status).toBe("CREATED");
      const { runId, taskId } = submitRes;

      // 2. Dispatch via Router Host
      const routeRes = await cli.run(["router", "host", "--db", dbPath, "--once"]);
      expect(routeRes.exitCode, routeRes.output).toBe(0);

      // 3. Execute via Worker Host with local Ollama model
      const workerRes = await cli.run([
        "worker",
        "--db",
        dbPath,
        "--once",
        "--model-provider",
        "ollama",
        "--model",
        TARGET_MODEL,
        "--ollama-base-url",
        OLLAMA_BASE_URL,
        "--model-timeout-ms",
        "180000",
        "--lease-ttl-ms",
        "600000",
        "--workspace-root",
        workspaceRoot,
        "--artifact-root",
        artifactRoot,
      ]);
      expect(workerRes.exitCode, workerRes.output).toBe(0);

      // 4. Verify SQLite state: Run status must be COMPLETED
      const store = new SqliteStateStore({ location: dbPath });
      let finalRun;
      let writeActionPayload: Record<string, unknown> | undefined;
      try {
        finalRun = store.getRun(runId);
        expect(finalRun).not.toBeNull();
        expect(finalRun?.status).toBe("COMPLETED");

        const actions = store.getActionsForRun(runId);
        const toolNames = actions.map((a) => a.toolName);
        expect(toolNames).toContain("read_file");
        expect(toolNames).toContain("write_file");

        const writeAction = actions.find((a) => a.toolName === "write_file");
        writeActionPayload = writeAction?.inputPayload as Record<string, unknown> | undefined;
      } finally {
        store.close();
      }

      // 5. Verify Deliverable Content & Required Sections
      const wsDir = fs.existsSync(path.join(workspaceRoot, `ws-${runId}`))
        ? path.join(workspaceRoot, `ws-${runId}`)
        : path.join(workspaceRoot, runId);

      let reportPath = path.join(wsDir, "reports", "project-analysis.md");
      if (!fs.existsSync(reportPath)) {
        const altPath = path.join(wsDir, "output", "report.md");
        if (fs.existsSync(altPath)) {
          reportPath = altPath;
        }
      }

      let reportContent = "";
      if (fs.existsSync(reportPath)) {
        reportContent = fs.readFileSync(reportPath, "utf8");
      } else {
        // Upon successful run completion, WorkerRuntime disposes temporary sandbox workspace
        // and exports the preserved patch diff and manifest to artifactRoot.
        const patchPath = path.join(artifactRoot, runId, "attempt-1", "patch.diff");
        if (fs.existsSync(patchPath)) {
          reportContent = fs.readFileSync(patchPath, "utf8");
        } else if (writeActionPayload?.content) {
          reportContent = String(writeActionPayload.content);
        }
      }

      expect(reportContent.length).toBeGreaterThan(100);

      // Verify all four required sections are present
      expect(reportContent).toMatch(/objective/i);
      expect(reportContent).toMatch(/requirement/i);
      expect(reportContent).toMatch(/risk/i);
      expect(reportContent).toMatch(/recommendation/i);

      // 6. Operator Observability Inspection (Milestone 2.21 CLI commands)
      const inspectRes = await json([
        "run",
        "inspect",
        "--db",
        dbPath,
        "--run-id",
        runId,
        "--artifact-root",
        artifactRoot,
        "--json",
      ]);
      expect(inspectRes.run.runId).toBe(runId);
      expect(inspectRes.run.status).toBe("COMPLETED");
      expect(inspectRes.run.attemptCount).toBeGreaterThanOrEqual(0);
      expect(inspectRes.failure).toBeNull();

      const eventsRes = await json([
        "run",
        "events",
        "--db",
        dbPath,
        "--run-id",
        runId,
        "--json",
      ]);
      expect(eventsRes.runId).toBe(runId);
      const eventTypes = eventsRes.events.map((e: { eventType: string }) => e.eventType);
      expect(eventTypes).toContain("run.created");
      expect(eventTypes).toContain("run.queued");
      expect(eventTypes).toContain("worker.claimed");
      expect(eventTypes).toContain("run.started");
      expect(eventTypes).toContain("action.started");
      expect(eventTypes).toContain("action.completed");
      expect(eventTypes).toContain("run.completed");

      const treeRes = await json([
        "task",
        "tree",
        "--db",
        dbPath,
        "--task-id",
        taskId,
        "--json",
      ]);
      expect(treeRes.rootTaskId).toBe(taskId);
      expect(treeRes.tree.runStatus).toBe("COMPLETED");
    },
    600_000 // 10 minute timeout for multi-turn CPU inference
  );
});
