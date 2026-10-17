/**
 * Phase 12 — Two-Step Governed Agent Loop Live Smoke Experiment Runner.
 *
 * Demonstrates the core Phase 12 capability with local llama3.2:3b via Ollama:
 *
 * Step 1:
 * Model Proposal (git_status) -> Governance -> Real Execution -> Real Observation
 *
 * Step 2:
 * ContextEngine builds ContextSnapshot(2) with Step 1 TOOL_RESULT observation ->
 * Model receives real observation in prompt ->
 * Model produces governed decision (isGoalReached=true or next valid tool) ->
 * Controlled execution / termination ->
 * Trajectory and evidence persisted.
 *
 * Invariants & Constraints:
 * 1. Model: llama3.2:3b via local Ollama (http://127.0.0.1:11434).
 * 2. CPU execution with realistic timeouts (300s per step, 600s loop budget).
 * 3. All historical artifacts (Phases 9, 10, 11) verified byte-for-byte intact.
 * 4. Zero parallel execution paths; passes exclusively through AgentStepController / WorkerRuntime.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { OllamaModelProvider } from "../src/adapters/models/ollama-model-provider.js";
import { SqliteStateStore } from "../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../src/adapters/workspace/node-fs-workspace-adapter.js";
import {
  AgentStepController,
  DEFAULT_STEP_CONTROLLER_BUDGET,
} from "../src/application/agent-step-controller.js";
import { ContextEngine } from "../src/application/context/context-engine.js";
import { ContextSource } from "../src/application/context/context-source.js";
import { LiveAgentBrain } from "../src/application/live-agent-brain.js";
import { ProposalValidator } from "../src/application/proposal-validator.js";
import { RunCoordinator } from "../src/application/run-coordinator.js";
import { WorkerRuntime } from "../src/application/worker-runtime.js";
import { createExecutionPolicy } from "../src/domain/policy.js";
import { staticToolRegistry } from "../src/domain/tool.js";
import { SystemClock } from "../src/ports/clock.port.js";
import { createMockGitRepository } from "../tests/adapters/tools/git-test-helper.js";
import { createAndActivateContract } from "../tests/application/test-helpers.js";

// ============================================================================
// 1. Historical Artifact Protection
// ============================================================================

const SCRATCH_DIR = path.resolve(
  "C:/Users/Adusumalli Girish/.gemini/antigravity/brain/543bddec-0a19-44a7-9818-72be776b138b/scratch"
);

const HISTORICAL_HASHES: Readonly<Record<string, string>> = Object.freeze({
  "phase9-4b-summary.json": "FC81ED4C9E0FA60D2232104DC0CCFA57C4FB26BCDAB79E6D17D52F3FE575D92E",
  "phase10a-summary.json": "3D7AB05E40E7F5B7CC62175D9FF5A49BC4A81373EEF01DA0FDB30B9B1FFDA9AB",
  "phase10b-structured-output-diagnostic.json": "6A86F522ADD8ACB6F7A5D3D7CB560346FFED9E15982F84C97AA25AD539D35A24",
  "phase10c-schema-union-diagnostic.json": "BDF5275841FD46F31890964B941832AA11F0E1EFC2396FAFA0375FF1C99D1A4A",
  "phase10e-summary.json": "6D0DEB0E1685FDBF06882A90AF4A0AD27CA68DEEFE03F37CC36FEC6632A37136",
  "phase10f-tool-input-diagnostic.json": "46F0B3EE24FFFCCA06CDA3133A9199FE3096E23A063F2293FF5813D6F2424DE0",
  "phase10h-tool-contract-diagnostic.json": "6DF83F1792D1AD10649393DC86DF4451AC27BA495844B292B947FCB131BC8961",
  "phase11-smoke-evidence.json": "8F2B71B6604794952F2DFDA6777206D68A274E50CD489FA32BE61BE4294A0021",
});

function verifyHistoricalArtifactsPreserved(): void {
  for (const [filename, expectedSha256] of Object.entries(HISTORICAL_HASHES)) {
    const fullPath = path.join(SCRATCH_DIR, filename);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Historical artifact missing: ${filename}`);
    }
    const buf = fs.readFileSync(fullPath);
    const actualSha256 = crypto.createHash("sha256").update(buf).digest("hex").toUpperCase();
    if (actualSha256 !== expectedSha256.toUpperCase()) {
      throw new Error(
        `Historical artifact corrupted! ${filename} expected ${expectedSha256}, got ${actualSha256}`
      );
    }
  }
  console.log("[PREFLIGHT] All 8 historical evaluation artifacts verified byte-for-byte intact.");
}

// ============================================================================
// 2. Main Live Multi-Step Smoke Runner
// ============================================================================

async function main() {
  console.log("======================================================================");
  console.log("EMERALD AGENT FABRIC — PHASE 12 MULTI-STEP GOVERNED AGENT LOOP");
  console.log("======================================================================");

  // 1. Invariant verification
  verifyHistoricalArtifactsPreserved();

  // 2. Verify Ollama connectivity
  const baseUrl = "http://127.0.0.1:11434";
  const modelName = "llama3.2:3b";
  try {
    const res = await fetch(`${baseUrl}/api/tags`);
    if (!res.ok) {
      throw new Error(`Ollama returned status ${res.status}`);
    }
    const tags = (await res.json()) as any;
    const hasModel = tags.models?.some((m: any) => m.name === modelName || m.model === modelName);
    if (!hasModel) {
      throw new Error(`Required model '${modelName}' not found in Ollama.`);
    }
    console.log(`[PREFLIGHT] Ollama live at ${baseUrl} with model ${modelName}`);
  } catch (err: unknown) {
    console.error(`[FATAL] Ollama preflight failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // 3. Provision isolated test environment
  const tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-phase12-live-"));
  const workspaceRootDir = path.join(tempBaseDir, "workspaces");
  fs.mkdirSync(workspaceRootDir, { recursive: true });

  const store = new SqliteStateStore();
  const clock = new SystemClock();
  const workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: workspaceRootDir });
  const coordinator = new RunCoordinator(store, clock);

  const workerId = "worker-phase12-live";
  const leaseTtlMs = 600_000; // 10 minutes lease for 2 CPU inference steps

  // Register worker
  store.transaction((tx) => {
    tx.insertWorker({
      workerId,
      hostname: "localhost",
      pid: process.pid,
      status: "ACTIVE",
      createdAt: clock.nowIso(),
      lastHeartbeatAt: clock.nowIso(),
    });
  });

  const workerRuntime = new WorkerRuntime({
    workerId,
    coordinator,
    clock,
    workspacePort: workspaceAdapter,
  });

  const proposalValidator = new ProposalValidator({
    coordinator,
    stateStore: store,
    toolRegistry: staticToolRegistry,
    clock,
  });

  // 4. Configure LiveAgentBrain with Ollama and standardized tool projection catalog
  const modelProvider = new OllamaModelProvider({
    baseUrl,
    defaultModel: modelName,
  });

  const liveBrain = new LiveAgentBrain({
    modelProvider,
    model: modelName,
    timeoutMs: 300_000, // 5 minutes timeout per model call on CPU
    generationOptions: {
      temperature: 0.0,
      maxOutputTokens: 1024,
    },
    clock,
  });

  const stepController = new AgentStepController({
    coordinator,
    stateStore: store,
    workerRuntime,
    agentBrain: liveBrain,
    proposalValidator,
    toolRegistry: staticToolRegistry,
    clock,
  });

  // 5. Setup Task, Contract, Run, and authentic Git Repository
  // Causal directive: Step 1 inspects status. If clean, Step 2 should conclude goal reached.
  const taskDirective =
    "Inspect the repository status. If the repository is clean, report completion (isGoalReached: true); otherwise inspect the diff.";
  const task = coordinator.createTask({
    title: "Inspect Repository and Complete if Clean",
    description: taskDirective,
    inputPayload: { directive: taskDirective },
  });

  const contract = createAndActivateContract(store, task.taskId, {
    policy: createExecutionPolicy({
      policyId: `policy-${task.taskId}`,
      allowedCapabilities: ["git.read", "workspace.file.read", "git.diff"],
      isolationRequirement: "ISOLATED",
    }),
    timeoutMs: 120_000,
    maxOutputBytes: 1048576,
    maxAttempts: 3,
  });

  const { run } = coordinator.createRun({ taskId: task.taskId });
  coordinator.queueRun(run.runId);
  const claimResult = coordinator.claimRun(run.runId, workerId, leaseTtlMs);
  coordinator.startRun(run.runId, workerId, claimResult.lease.leaseId);

  const ws = await workspaceAdapter.provisionWorkspace({
    workspaceId: `ws-${run.runId}`,
    runId: run.runId,
    taskId: task.taskId,
    maxWorkspaceBytes: 50 * 1024 * 1024,
    maxFileSizeBytes: 10 * 1024 * 1024,
  });

  // Create clean Git repository on disk inside workspace
  const repoInfo = await createMockGitRepository(ws.hostPath, [
    { path: "README.md", content: "# Phase 12 Multi-Step Governed Execution Proof\n" },
    { path: "src/main.ts", content: "console.log('Phase 12 Clean Working Tree');\n" },
  ]);

  console.log(`[SETUP] Task: ${task.taskId}`);
  console.log(`[SETUP] Contract: ${contract.spec.contractId} (v${contract.spec.version})`);
  console.log(`[SETUP] Run: ${run.runId}`);
  console.log(`[SETUP] Lease: ${claimResult.lease.leaseId}`);
  console.log(`[SETUP] Workspace: ${ws.hostPath}`);
  console.log(`[SETUP] Initial Git Commit: ${repoInfo.commitSha}`);

  // 6. Execute Governed Step Loop (up to 2 steps)
  console.log("\n[EXEC] Initiating Governed Multi-Step Loop (budget: maxSteps=2)...");
  const wallClockStart = performance.now();

  const stepResult = await stepController.runStepLoop({
    runId: run.runId,
    leaseId: claimResult.lease.leaseId,
    workerId,
    workspace: ws,
    budget: {
      ...DEFAULT_STEP_CONTROLLER_BUDGET,
      maxSteps: 2,
      maxWallClockMs: 600_000,
    },
  });

  const wallClockTotalMs = Math.round(performance.now() - wallClockStart);
  console.log(
    `[EXEC] Loop finished with terminalReason: ${stepResult.terminalReason} (totalSteps: ${stepResult.totalSteps}, totalActions: ${stepResult.totalActions}) in ${wallClockTotalMs}ms`
  );

  // 7. Extract Multi-Step Evidence
  const transcript = stepResult.transcript;
  const step1 = transcript[0];
  const step2 = transcript[1];

  const actions = store.getActionsForRun(run.runId);
  const action1 = actions.find((a) => a.sequenceNumber === 1);
  const action2 = actions.find((a) => a.sequenceNumber === 2);

  const attemptsAction1 = action1 ? store.getAttemptsForAction(action1.actionId) : [];
  const attemptsAction2 = action2 ? store.getAttemptsForAction(action2.actionId) : [];

  const contextSource = new ContextSource(store);
  const currentObservations = await contextSource.gatherCandidateObservations(run.runId);
  const step1ToolResultObs = currentObservations.find((o) => o.category === "TOOL_RESULT");

  const evidence = {
    runId: run.runId,
    taskId: task.taskId,
    model: modelName,
    totalSteps: stepResult.totalSteps,
    totalActions: stepResult.totalActions,
    terminalReason: stepResult.terminalReason,
    terminalMessage: stepResult.terminalMessage,

    // Step 1 Details
    step1: {
      stepNumber: step1?.stepNumber,
      proposal: {
        proposalId: step1?.proposalId,
        toolName: step1?.toolName,
        inputPayload: step1?.inputPayload,
        rationale: step1?.rationale,
        finishReason: step1?.finishReason,
      },
      proposalValidation: {
        valid: step1?.proposalValid,
        rejectionReason: step1?.proposalRejectionReason ?? null,
      },
      reflexResult: {
        decision: step1?.reflexDecision,
        reasonCode: step1?.reflexReasonCode,
      },
      actionId: action1?.actionId ?? null,
      attemptId: attemptsAction1[0]?.attemptId ?? null,
      actionStatus: action1?.status ?? null,
      attemptStatus: attemptsAction1[0]?.status ?? null,
      physicalResult: step1?.actionOutput ?? null,
      toolExecutionLatencyMs: attemptsAction1[0]?.durationMs ?? 0,
      stepDurationMs: step1?.durationMs ?? 0,
      contextBytes: step1?.contextBytes ?? 0,
    },

    // Step 2 Details
    step2: step2
      ? {
          stepNumber: step2.stepNumber,
          proposal: {
            proposalId: step2.proposalId,
            toolName: step2.toolName ?? null,
            inputPayload: step2.inputPayload ?? null,
            rationale: step2.rationale,
            finishReason: step2.finishReason,
          },
          proposalValidation: {
            valid: step2.proposalValid,
            rejectionReason: step2.proposalRejectionReason ?? null,
          },
          reflexResult: {
            decision: step2.reflexDecision ?? null,
            reasonCode: step2.reflexReasonCode ?? null,
          },
          actionId: action2?.actionId ?? null,
          attemptId: attemptsAction2[0]?.attemptId ?? null,
          actionStatus: action2?.status ?? null,
          attemptStatus: attemptsAction2[0]?.status ?? null,
          physicalResult: step2.actionOutput ?? null,
          toolExecutionLatencyMs: attemptsAction2[0]?.durationMs ?? 0,
          stepDurationMs: step2.durationMs,
          contextBytes: step2.contextBytes,
        }
      : null,

    // Observation Propagation Evidence
    observationPropagation: {
      step1ObservationId: step1ToolResultObs?.observationId ?? null,
      step1ObservationCategory: step1ToolResultObs?.category ?? null,
      step1ObservationContent: step1ToolResultObs?.content ?? null,
      presentInFinalContextSnapshot: Boolean(
        stepResult.lastContextSnapshot?.observations.some((o) => o.category === "TOOL_RESULT")
      ),
    },

    // Trajectory & Persistence
    trajectory: {
      totalActionsPersisted: actions.length,
      action1Status: action1?.status ?? null,
      action2Status: action2?.status ?? null,
      attemptsCountAction1: attemptsAction1.length,
      attemptsCountAction2: attemptsAction2.length,
      relationalIntegrity:
        actions.length >= 1 &&
        attemptsAction1.length === 1 &&
        attemptsAction1[0].actionId === action1?.actionId &&
        attemptsAction1[0].runId === run.runId,
    },

    // Latency & Performance Breakdown
    metrics: {
      step1ModelLatencyMs: step1 ? step1.durationMs - (attemptsAction1[0]?.durationMs ?? 0) : null,
      step1ToolLatencyMs: attemptsAction1[0]?.durationMs ?? 0,
      step2ModelLatencyMs: step2 ? step2.durationMs - (attemptsAction2[0]?.durationMs ?? 0) : null,
      step2ToolLatencyMs: attemptsAction2[0]?.durationMs ?? 0,
      totalWallClockMs: wallClockTotalMs,
      step1ContextBytes: step1?.contextBytes ?? 0,
      step2ContextBytes: step2?.contextBytes ?? 0,
      modelCallsCount: transcript.length,
    },
  };

  // 8. Gate Determination
  const gateChecks = [
    { name: "Step 1 Generated Proposal", passed: Boolean(evidence.step1.proposal.toolName) },
    { name: "Step 1 Expected Tool is git_status", passed: evidence.step1.proposal.toolName === "git_status" },
    { name: "Step 1 Proposal Validated", passed: evidence.step1.proposalValidation.valid === true },
    { name: "Step 1 Action & Attempt Persisted in SQLite", passed: Boolean(evidence.step1.actionId && evidence.step1.attemptId) },
    { name: "Step 1 Physical Execution Succeeded (clean=true)", passed: (evidence.step1.physicalResult as any)?.clean === true },
    { name: "Step 1 Observation Generated (TOOL_RESULT)", passed: Boolean(evidence.observationPropagation.step1ObservationId) },
    { name: "Step 2 Executed (at least 2 model decisions occur)", passed: Boolean(evidence.step2) },
    { name: "Step 2 Decision Is Valid Proposal or Goal Reached", passed: Boolean(evidence.step2 && (evidence.step2.proposal.finishReason === "GOAL_REACHED" || evidence.step2.proposalValidation.valid)) },
    { name: "Context Snapshot Expanded with Tool Output", passed: (evidence.step2?.contextBytes ?? 0) > evidence.step1.contextBytes },
    { name: "Relational Trajectory Integrity Preserved", passed: evidence.trajectory.relationalIntegrity === true },
    { name: "Step Loop Concluded Within Budget (<= 2 steps)", passed: evidence.totalSteps <= 2 },
  ];

  const allPassed = gateChecks.every((c) => c.passed);
  const gateStatus = allPassed ? "PASSED" : "BLOCKED";

  // 9. Save Artifact
  const artifactPath = path.join(SCRATCH_DIR, "phase12-smoke-evidence.json");
  const summaryPayload = {
    phase: "Phase 12",
    model: modelName,
    gateStatus,
    timestamp: new Date().toISOString(),
    gateChecks,
    evidence,
  };
  fs.writeFileSync(artifactPath, JSON.stringify(summaryPayload, null, 2), "utf8");
  console.log(`\n[ARTIFACT] Evidence persisted to: ${artifactPath}`);

  // 10. Print Summary
  console.log("\n======================================================================");
  console.log(`PHASE 12 GATE DETERMINATION: ${gateStatus}`);
  console.log("======================================================================");
  for (const check of gateChecks) {
    console.log(`  [${check.passed ? "PASS" : "FAIL"}] ${check.name}`);
  }
  console.log("\n--- METRICS ---");
  console.log(`  Step 1 Model Latency:   ${evidence.metrics.step1ModelLatencyMs ?? "N/A"} ms`);
  console.log(`  Step 1 Tool Latency:    ${evidence.metrics.step1ToolLatencyMs} ms`);
  console.log(`  Step 1 Context Size:    ${evidence.metrics.step1ContextBytes} bytes`);
  console.log(`  Step 2 Model Latency:   ${evidence.metrics.step2ModelLatencyMs ?? "N/A"} ms`);
  console.log(`  Step 2 Tool Latency:    ${evidence.metrics.step2ToolLatencyMs} ms`);
  console.log(`  Step 2 Context Size:    ${evidence.metrics.step2ContextBytes} bytes`);
  console.log(`  Total Wall Clock:       ${evidence.metrics.totalWallClockMs} ms`);
  console.log(`  Model Calls Count:      ${evidence.metrics.modelCallsCount}`);
  console.log("======================================================================\n");

  // Cleanup temp files
  try {
    store.close();
    fs.rmSync(tempBaseDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  if (!allPassed) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[FATAL] Phase 12 Multi-Step Smoke Experiment failed:", err);
  process.exit(1);
});
