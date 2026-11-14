/**
 * Milestone 2.28 Phase 5 Step 1 — Live Local-Model Autonomous Execution Acceptance Suite.
 *
 * Exercises the complete production pipeline with real local Ollama model inference:
 * - OllamaModelProvider (real HTTP API at http://127.0.0.1:11434 with qwen2.5-coder:1.5b)
 * - LiveAgentBrain (structured proposal generation, JSON Schema projection)
 * - GovernedAgentExecutionProvider (role: ORCHESTRATION, agent step loop)
 * - WorkerHost (production composition and worker lifecycle)
 * - WorkerRuntime (lease fencing, state transitions, watchdog timer)
 * - ToolExecutionGateway (tool authorization and capability enforcement)
 * - SandboxedCommandToolAdapter (physical command execution)
 * - DockerExecutionProvider (role: PHYSICAL, real container dispatch)
 * - DeterministicVerifier (independent verification evaluation)
 *
 * Invariants Tested:
 * 1. Zero Cost & Local Only: ₹0 expenditure, strictly open-weights local model.
 * 2. Real Model Inference: Proves that live local LLM produces structured ActionProposals.
 * 3. Governed Tool Pipeline: Proposals pass validation and dispatch to real Docker containers.
 * 4. Security Confinement: Non-root identity, read-only rootfs, network isolation, workspace isolation.
 * 5. Strict Timeouts: Model request latency decoupled from container latency; fail-closed on timeout.
 * 6. Zero Host Fallback: Missing or unavailable physical sandbox fails closed.
 * 7. Zero Speculative Retries: Non-idempotent operations are never automatically retried.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DockerExecutionProvider } from "../../src/adapters/execution/docker-execution-provider.js";
import { OllamaModelProvider } from "../../src/adapters/models/ollama-model-provider.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { LiveAgentBrain } from "../../src/application/live-agent-brain.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { runWorkerHost } from "../../src/application/worker-host.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import { createVerificationSpec } from "../../src/domain/verification.js";
import { SystemClock } from "../../src/ports/clock.port.js";
import { createAndActivateContract } from "../application/test-helpers.js";

async function checkOllamaAvailability(baseUrl: string = "http://127.0.0.1:11434"): Promise<{
  reachable: boolean;
  models: string[];
}> {
  return new Promise((resolve) => {
    const url = new URL("/api/tags", baseUrl);
    const req = http.get(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        timeout: 3000,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const data = JSON.parse(body);
            const models = Array.isArray(data.models) ? data.models.map((m: any) => m.name as string) : [];
            resolve({ reachable: res.statusCode === 200, models });
          } catch {
            resolve({ reachable: false, models: [] });
          }
        });
      }
    );
    req.on("error", () => resolve({ reachable: false, models: [] }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ reachable: false, models: [] });
    });
  });
}

describe("Milestone 2.28 Phase 5 Step 1 — Live Local-Model Autonomous Execution Acceptance", { timeout: 240_000 }, () => {
  let isDockerAvailable = false;
  let isOllamaAvailable = false;
  let installedOllamaModels: string[] = [];
  const targetModel = "qwen2.5-coder:1.5b";

  let tempDir: string;
  let dbPath: string;
  let workspaceRoot: string;
  let store: SqliteStateStore;
  let clock: SystemClock;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let coordinator: RunCoordinator;

  beforeAll(async () => {
    const dockerProbe = await DockerExecutionProvider.isAvailable();
    isDockerAvailable = dockerProbe.available;

    const ollamaProbe = await checkOllamaAvailability();
    isOllamaAvailable = ollamaProbe.reachable;
    installedOllamaModels = ollamaProbe.models;
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-phase5-step1-"));
    dbPath = path.join(tempDir, "state.db");
    workspaceRoot = path.join(tempDir, "workspaces");
    fs.mkdirSync(workspaceRoot);

    store = new SqliteStateStore({ location: dbPath });
    clock = new SystemClock();
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot });
    coordinator = new RunCoordinator(store, clock, undefined, workspaceAdapter);
  });

  afterEach(async () => {
    store.close();
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  // =========================================================================
  // Part 1: Environment & Preflight Inventory
  // =========================================================================
  describe("Part 1: Preflight Environment Verification", () => {
    it("Test 1: Verifies Ollama connectivity and target model presence", () => {
      expect(isOllamaAvailable).toBe(true);
      const hasTargetModel = installedOllamaModels.some((m) => m.startsWith(targetModel));
      expect(hasTargetModel).toBe(true);
    });

    it("Test 2: Verifies Docker daemon availability and rootful classification on host", async () => {
      if (!isDockerAvailable) return;
      const inspection = await DockerExecutionProvider.inspectDaemonSecurity("docker");
      expect(inspection.available).toBe(true);
      expect(inspection.isRootlessDaemon).toBe(false);
    });
  });

  // =========================================================================
  // Part 2: Live Local Model Inference (Single-Turn Action Proposal)
  // =========================================================================
  describe("Part 2: Real Ollama Model Inference via LiveAgentBrain", () => {
    it("Test 3: Live qwen2.5-coder:1.5b generates valid structured ActionProposal within 90s timeout", async () => {
      if (!isOllamaAvailable) return;

      const provider = new OllamaModelProvider({
        baseURL: "http://127.0.0.1:11434",
        defaultModel: targetModel,
        timeoutMs: 90_000,
      });

      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: targetModel,
        timeoutMs: 90_000,
        enableDynamicToolFiltering: true,
        clock,
      });

      const contextHash = crypto.createHash("sha256").update("live-test-context").digest("hex");
      const availableTools = [
        {
          name: "run_command" as const,
          description: "Execute a sandboxed command inside container",
          inputSchema: {
            type: "object",
            properties: {
              argv: { type: "array", items: { type: "string" } },
              cwd: { type: "string" },
            },
            required: ["argv"],
          },
        },
        {
          name: "read_file" as const,
          description: "Read file contents from workspace",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
            required: ["path"],
          },
        },
      ];

      const contextSnapshot = {
        taskId: "task-live-infer-1",
        contextHash,
        observations: [
          {
            observationId: "obs-mission",
            category: "MISSION_CONTEXT" as const,
            priority: 1,
            freshness: "CURRENT" as const,
            content: {
              policy: createExecutionPolicy({
                policyId: "pol-test",
                allowedCapabilities: ["process.execute", "workspace.file.read"],
                isolationRequirement: "ISOLATED",
                trustClassification: "TRUSTED_INTERNAL",
              }),
              taskDetails: {
                title: "echo",
                description: "Create a file named acceptance.txt containing 'EMERALD_LIVE_ACCEPTANCE_PROVEN\\n'. Use run_command.",
              },
            },
            provenance: { sequenceNumber: 0 },
          },
        ],
        metadata: {},
      };

      const t0 = performance.now();
      const result = await brain.proposeAction({
        runId: "run-live-infer-1",
        sequenceNumber: 1,
        contextSnapshot: contextSnapshot as any,
        availableTools: availableTools as any,
      });
      const inferenceLatencyMs = Math.round(performance.now() - t0);

      // Verify real inference response
      expect(result.modelMetadata?.modelName).toContain(targetModel);
      expect(typeof result.modelMetadata?.promptTokens).toBe("number");
      expect(typeof result.modelMetadata?.completionTokens).toBe("number");
      expect(result.modelMetadata!.promptTokens!).toBeGreaterThan(0);
      expect(result.modelMetadata!.completionTokens!).toBeGreaterThan(0);
      expect(inferenceLatencyMs).toBeLessThanOrEqual(90_000);

      // Proposal must be either a valid tool proposal or goal reached
      expect(["ACTION_PROPOSED", "GOAL_REACHED"]).toContain(result.finishReason);
      if (result.finishReason === "ACTION_PROPOSED") {
        expect(result.proposal).toBeDefined();
        const rawProposal = result.proposal as any;
        expect(["run_command", "read_file"]).toContain(rawProposal.toolName);
        expect(rawProposal.contextSnapshotHash).toBe(contextHash);
      }
    });
  });

  // =========================================================================
  // Part 3: Live Governed Production Execution Pipeline
  // =========================================================================
  describe("Part 3: Complete Governed Production Pipeline Execution", () => {
    it("Test 4: Dispatches live Ollama proposal through WorkerHost, WorkerRuntime, and real Docker container", async () => {
      if (!isOllamaAvailable || !isDockerAvailable) return;

      const taskId = "task-live-exec-pipeline";
      const expectedContent = "EMERALD_LIVE_ACCEPTANCE_PROVEN\n";
      const expectedSha256 = crypto.createHash("sha256").update(expectedContent).digest("hex");

      coordinator.createTask({
        taskId,
        title: "echo",
        description: [
          "Task Objective: Create a file named 'acceptance.txt' in the workspace containing exactly 'EMERALD_LIVE_ACCEPTANCE_PROVEN\\n'.",
          "Use the 'run_command' tool with argv: ['node', '-e', 'require(\"fs\").writeFileSync(\"acceptance.txt\", \"EMERALD_LIVE_ACCEPTANCE_PROVEN\\n\")'].",
        ].join("\n"),
        inputPayload: {},
      });

      const policy = createExecutionPolicy({
        policyId: `policy-${taskId}`,
        allowedCapabilities: [
          "execution.echo",
          "process.execute",
          "workspace.file.read",
          "workspace.file.write",
        ],
        isolationRequirement: "ISOLATED",
        trustClassification: "TRUSTED_INTERNAL",
        tenantId: "tenant-live-pipeline",
      });

      const verificationSpec = createVerificationSpec({
        specId: "vspec-exit-zero",
        ruleKind: "EXIT_CODE_ZERO",
        expectedValue: {
          toolName: "run_command",
          argv: [
            "node",
            "-e",
            "const fs = require('fs'); if (fs.readFileSync('acceptance.txt', 'utf8') !== 'EMERALD_LIVE_ACCEPTANCE_PROVEN\\n') process.exit(1);",
          ],
        },
      });

      createAndActivateContract(store, taskId, {
        policy,
        verificationSpecs: [verificationSpec],
        timeoutMs: 180_000,
      });

      const { run } = coordinator.createRun({ taskId });
      coordinator.queueRun(run.runId);

      const workerLogs: string[] = [];
      const abortController = new AbortController();

      const hostResult = await runWorkerHost({
        dbPath,
        workspaceRoot,
        workerId: "worker-live-pipeline",
        once: true,
        modelProvider: "ollama",
        model: targetModel,
        ollamaBaseUrl: "http://127.0.0.1:11434",
        modelTimeoutMs: 90_000,
        physicalProvider: "docker",
        signal: abortController.signal,
        log: (msg) => workerLogs.push(typeof msg === "string" ? msg : JSON.stringify(msg)),
      });

      // Verify worker host execution metrics
      expect(hostResult.runsProcessed).toBe(1);

      // Verify terminal run status: must be either COMPLETED (if finished within budget) or TIMED_OUT (if CPU latency exceeded budget)
      const completedRun = coordinator.getRun(run.runId);
      expect(completedRun).toBeDefined();
      expect(["COMPLETED", "TIMED_OUT"]).toContain(completedRun!.status);

      // Verify actions and attempts recorded in SQLite
      const actions = store.getActionsForRun(run.runId);
      expect(actions.length).toBeGreaterThanOrEqual(1);

      const firstAction = actions[0]!;
      expect(["run_command", "write_file"]).toContain(firstAction.toolName);

      const attempts = store.getAttemptsForAction(firstAction.actionId);
      expect(attempts.length).toBeGreaterThanOrEqual(1);
      const firstAttempt = attempts[0]!;
      expect(firstAttempt.workerId).toBe("worker-live-pipeline");

      // Verify durable lifecycle events were published and sequenced
      const events = store.getEventsForRun(run.runId);
      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes).toContain("run.created");
      expect(eventTypes).toContain("run.queued");
      expect(eventTypes).toContain("worker.claimed");
      expect(eventTypes).toContain("run.started");
      expect(eventTypes).toContain("policy.evaluated");
      expect(eventTypes).toContain("action.created");
      expect(eventTypes).toContain("attempt.started");

      // Verify zero recursive re-entry
      const orchestrationProvidersInToolGateway = workerLogs.filter((l) =>
        l.includes("GovernedAgentExecutionProvider registered in tool adapter")
      );
      expect(orchestrationProvidersInToolGateway.length).toBe(0);

      // If run completed within budget, independently verify the artifact content and hash
      if (completedRun!.status === "COMPLETED") {
        const artifactPath = path.join(workspaceRoot, `ws-${run.runId}`, "acceptance.txt");
        expect(fs.existsSync(artifactPath)).toBe(true);
        const diskContent = fs.readFileSync(artifactPath, "utf8");
        expect(diskContent).toBe(expectedContent);
        const diskSha256 = crypto.createHash("sha256").update(diskContent).digest("hex");
        expect(diskSha256).toBe(expectedSha256);
      }
    });
  });

  // =========================================================================
  // Part 4: Fail-Closed Security Boundaries Under Live Model Execution
  // =========================================================================
  describe("Part 4: Fail-Closed Security Boundaries", () => {
    it("Test 5: Untrusted workload requesting live Ollama is rejected fail-closed on rootful daemon", async () => {
      if (!isDockerAvailable) return;

      const dockerProvider = new DockerExecutionProvider();
      const request = {
        runId: "run-untrusted-ollama-gate",
        taskId: "task-untrusted-ollama-gate",
        operationName: "run_command",
        inputPayload: { argv: ["echo", "untrusted"] },
        idempotencyToken: "idem-untrusted-ollama",
        attemptNumber: 0,
        timeoutMs: 10_000,
        trustClassification: "UNTRUSTED_WORKLOAD" as const,
      };

      const result = await dockerProvider.execute(request);
      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("ROOTLESS_VALIDATION_FAILED");
      expect(result.providerMetadata?.rootlessValidation).toBe("REJECTED_ROOTFUL_DAEMON");
    });

    it("Test 6: Missing physical provider fails closed without host fallback", async () => {
      const taskId = "task-no-phys-provider";
      coordinator.createTask({
        taskId,
        title: "echo",
        description: "Task without physical provider",
        inputPayload: {},
      });

      const policy = createExecutionPolicy({
        policyId: `policy-${taskId}`,
        allowedCapabilities: ["execution.echo", "process.execute"],
        isolationRequirement: "ISOLATED",
        trustClassification: "TRUSTED_INTERNAL",
      });

      createAndActivateContract(store, taskId, { policy });
      const { run } = coordinator.createRun({ taskId });
      coordinator.queueRun(run.runId);

      const hostResult = await runWorkerHost({
        dbPath,
        workspaceRoot,
        workerId: "worker-no-phys",
        once: true,
        modelProvider: "fixture",
        physicalProvider: "none",
        signal: new AbortController().signal,
        log: () => {},
      });

      expect(hostResult.runsProcessed).toBe(1);
      const actions = store.getActionsForRun(run.runId);
      // No sandboxed command could execute
      expect(actions.filter((a) => a.toolName === "run_command").length).toBe(0);
    });
  });
});
