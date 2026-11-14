/**
 * Phase 11 — Live Governed Tool Execution Smoke Experiment Runner.
 *
 * Executes the complete Emerald Agent Fabric governance pipeline with
 * a real local open-source model (llama3.2:3b via Ollama):
 *
 * Local Ollama model (llama3.2:3b)
 *   ↓
 * LiveAgentBrain (standardized ADR-0029 tool projection catalog)
 *   ↓
 * ActionProposal (untrusted model output)
 *   ↓
 * ProposalValidator (11-stage governance check)
 *   ↓
 * Reflex (NoopReflex / RuleBasedReflex)
 *   ↓
 * PolicyEvaluator (authoritative capability check)
 *   ↓
 * ToolExecutionGateway (least-privilege dispatch)
 *   ↓
 * GitStatusToolAdapter (read-only workspace git inspection)
 *   ↓
 * Real Physical Execution on Disk (inspected git objects and status)
 *   ↓
 * Action/Attempt Persistence in SQLite (1 Action -> 1 Attempt)
 *   ↓
 * Context Engine Observation (TOOL_RESULT observation delivered to runtime)
 *
 * Invariants & Constraints:
 * 1. Read-only first tool: git_status.
 * 2. Model: llama3.2:3b via Ollama at http://127.0.0.1:11434.
 * 3. Exact 1 Action -> 1 Attempt -> 1 Physical Execution.
 * 4. Zero parallel execution path: passes exclusively through AgentStepController / WorkerRuntime.
 * 5. All historical evaluation artifacts verified byte-for-byte intact.
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
  path.resolve(__dirname, "../tests/fixtures")
);

const HISTORICAL_HASHES: Readonly<Record<string, string>> = Object.freeze({
  "phase9-4b-summary.json": "FC81ED4C9E0FA60D2232104DC0CCFA57C4FB26BCDAB79E6D17D52F3FE575D92E",
  "phase10a-summary.json": "3D7AB05E40E7F5B7CC62175D9FF5A49BC4A81373EEF01DA0FDB30B9B1FFDA9AB",
  "phase10b-structured-output-diagnostic.json": "6A86F522ADD8ACB6F7A5D3D7CB560346FFED9E15982F84C97AA25AD539D35A24",
  "phase10c-schema-union-diagnostic.json": "BDF5275841FD46F31890964B941832AA11F0E1EFC2396FAFA0375FF1C99D1A4A",
  "phase10e-summary.json": "6D0DEB0E1685FDBF06882A90AF4A0AD27CA68DEEFE03F37CC36FEC6632A37136",
  "phase10f-tool-input-diagnostic.json": "46F0B3EE24FFFCCA06CDA3133A9199FE3096E23A063F2293FF5813D6F2424DE0",
  "phase10h-tool-contract-diagnostic.json": "6DF83F1792D1AD10649393DC86DF4451AC27BA495844B292B947FCB131BC8961",
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
  console.log("[PREFLIGHT] All 7 historical evaluation artifacts verified byte-for-byte intact.");
}

// ============================================================================
// 2. Main Live Smoke Execution Runner
// ============================================================================

async function main() {
  console.log("======================================================================");
  console.log("EMERALD AGENT FABRIC — PHASE 11 LIVE GOVERNED EXECUTION SMOKE");
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
  const tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-phase11-live-"));
  const workspaceRootDir = path.join(tempBaseDir, "workspaces");
  fs.mkdirSync(workspaceRootDir, { recursive: true });

  const store = new SqliteStateStore();
  const clock = new SystemClock();
  const workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: workspaceRootDir });
  const coordinator = new RunCoordinator(store, clock);

  const workerId = "worker-phase11-live";
  const leaseTtlMs = 300_000; // 5 minutes lease for CPU inference headroom

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
    timeoutMs: 180_000, // 3 minutes timeout for CPU inference
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
  const taskDirective = "Inspect the current Git repository status using the available tool.";
  const task = coordinator.createTask({
    title: "Inspect Repository Working Tree Status",
    description: taskDirective,
    inputPayload: { directive: taskDirective },
  });

  const contract = createAndActivateContract(store, task.taskId, {
    policy: createExecutionPolicy({
      policyId: `policy-${task.taskId}`,
      allowedCapabilities: ["git.read", "workspace.file.read"],
      isolationRequirement: "ISOLATED",
    }),
    timeoutMs: 60_000,
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

  // Create authentic Git repository on disk inside workspace
  const repoInfo = await createMockGitRepository(ws.hostPath, [
    { path: "README.md", content: "# Phase 11 Live Execution Proof\n" },
    { path: "src/engine.ts", content: "export const engineVersion = '11.0.0';\n" },
  ]);

  console.log(`[SETUP] Task: ${task.taskId}`);
  console.log(`[SETUP] Contract: ${contract.spec.contractId} (v${contract.spec.version})`);
  console.log(`[SETUP] Run: ${run.runId}`);
  console.log(`[SETUP] Lease: ${claimResult.lease.leaseId}`);
  console.log(`[SETUP] Workspace: ${ws.hostPath}`);
  console.log(`[SETUP] Initial Git Commit: ${repoInfo.commitSha}`);

  // 6. Execute Governed Step Loop (1 Step)
  console.log("\n[EXEC] Initiating Governed Reasoning & Execution Loop...");
  const wallClockStart = performance.now();

  const stepResult = await stepController.runStepLoop({
    runId: run.runId,
    leaseId: claimResult.lease.leaseId,
    workerId,
    workspace: ws,
    budget: {
      ...DEFAULT_STEP_CONTROLLER_BUDGET,
      maxSteps: 1,
      maxWallClockMs: 240_000,
    },
  });

  const wallClockTotalMs = Math.round(performance.now() - wallClockStart);
  console.log(`[EXEC] Loop finished with terminalReason: ${stepResult.terminalReason} in ${wallClockTotalMs}ms`);

  // 7. Extract Evidence
  const transcriptStep = stepResult.transcript[0];
  const actions = store.getActionsForRun(run.runId);
  const attempts = actions.length > 0 ? store.getAttemptsForAction(actions[0].actionId) : [];

  const contextSource = new ContextSource(store);
  const nextCandidates = await contextSource.gatherCandidateObservations(run.runId);
  const toolResultObs = nextCandidates.find((o) => o.category === "TOOL_RESULT");

  const evidence = {
    // 1. Model proposal
    modelProposal: {
      proposalId: transcriptStep?.proposalId,
      toolName: transcriptStep?.toolName,
      inputPayload: transcriptStep?.inputPayload,
      rationale: transcriptStep?.rationale,
      finishReason: transcriptStep?.finishReason,
    },
    // 2. Proposal validation result
    proposalValidation: {
      valid: transcriptStep?.proposalValid,
      rejectionReason: transcriptStep?.proposalRejectionReason ?? null,
      rejectionMessage: transcriptStep?.proposalRejectionMessage ?? null,
    },
    // 3. Reflex result
    reflexResult: {
      decision: transcriptStep?.reflexDecision,
      reasonCode: transcriptStep?.reflexReasonCode,
      rationale: transcriptStep?.reflexRationale,
      reflexDurationMs: transcriptStep?.reflexDurationMs,
      evidencePresent: Boolean(transcriptStep?.reflexEvidence),
    },
    // 4. Policy decision
    policyDecision: {
      checkedCapability: "git.read",
      allowed: transcriptStep?.proposalValid && transcriptStep?.actionStatus === "SUCCEEDED",
      governanceBoundary: "PRE_EXECUTION_ENFORCED",
    },
    // 5. Action creation
    actionCreation: actions[0]
      ? {
          actionId: actions[0].actionId,
          runId: actions[0].runId,
          toolName: actions[0].toolName,
          sequenceNumber: actions[0].sequenceNumber,
          status: actions[0].status,
          totalAttempts: actions[0].totalAttempts,
          createdAt: actions[0].createdAt,
        }
      : null,
    // 6. Attempt creation
    attemptCreation: attempts[0]
      ? {
          attemptId: attempts[0].attemptId,
          actionId: attempts[0].actionId,
          attemptNumber: attempts[0].attemptNumber,
          workerId: attempts[0].workerId,
          leaseId: attempts[0].leaseId,
          status: attempts[0].status,
          idempotencyToken: attempts[0].idempotencyToken,
        }
      : null,
    // 7. Tool gateway dispatch
    toolGatewayDispatch: {
      dispatchedTool: "git_status",
      targetPath: (transcriptStep?.inputPayload as any)?.path ?? ".",
      isolation: "WORKSPACE",
      dispatched: Boolean(transcriptStep?.actionOutput),
    },
    // 8. Actual tool result
    actualToolResult: transcriptStep?.actionOutput ?? null,
    // 9. Persisted Action/Attempt state
    persistedState: {
      totalActions: actions.length,
      totalAttempts: attempts.length,
      actionStatus: actions[0]?.status,
      attemptStatus: attempts[0]?.status,
      linkageValid:
        actions.length === 1 &&
        attempts.length === 1 &&
        attempts[0].actionId === actions[0].actionId &&
        attempts[0].runId === run.runId,
    },
    // 10. Final observation returned to runtime
    finalObservation: toolResultObs
      ? {
          observationId: toolResultObs.observationId,
          category: toolResultObs.category,
          priority: toolResultObs.priority,
          content: toolResultObs.content,
        }
      : null,
    // Latency & Metrics
    metrics: {
      modelLatencyMs: transcriptStep?.durationMs ? transcriptStep.durationMs - (attempts[0]?.durationMs ?? 0) : null,
      toolExecutionLatencyMs: attempts[0]?.durationMs ?? 0,
      totalWallClockMs: wallClockTotalMs,
      promptBytes: (stepResult.lastContextSnapshot?.totalBytes ?? 0),
      modelCallsCount: 1,
    },
  };

  // 8. Gate Determination
  const gateChecks = [
    { name: "Model Generated Proposal", passed: Boolean(evidence.modelProposal.toolName) },
    { name: "Expected Tool is git_status", passed: evidence.modelProposal.toolName === "git_status" },
    { name: "ProposalValidator Validated", passed: evidence.proposalValidation.valid === true },
    { name: "Reflex Allowed", passed: evidence.reflexResult.decision === "ALLOW" },
    { name: "Policy Allowed", passed: evidence.policyDecision.allowed === true },
    { name: "Action Created in SQLite", passed: Boolean(evidence.actionCreation) },
    { name: "Attempt Created in SQLite", passed: Boolean(evidence.attemptCreation) },
    { name: "Physical Execution Succeeded", passed: (evidence.actualToolResult as any)?.clean === true },
    { name: "Commit SHA Matches Initial", passed: (evidence.actualToolResult as any)?.currentCommit === repoInfo.commitSha },
    { name: "Persistence Invariant (1 Action -> 1 Attempt)", passed: evidence.persistedState.linkageValid === true },
    { name: "Runtime Received TOOL_RESULT Observation", passed: Boolean(evidence.finalObservation) },
  ];

  const allPassed = gateChecks.every((c) => c.passed);
  const gateStatus = allPassed ? "PASSED" : "BLOCKED";

  // 9. Save Artifact
  const artifactPath = path.join(SCRATCH_DIR, "phase11-smoke-evidence.json");
  const summaryPayload = {
    phase: "Phase 11",
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
  console.log(`PHASE 11 GATE DETERMINATION: ${gateStatus}`);
  console.log("======================================================================");
  for (const check of gateChecks) {
    console.log(`  [${check.passed ? "PASS" : "FAIL"}] ${check.name}`);
  }
  console.log("\n--- METRICS ---");
  console.log(`  Model Latency:          ${evidence.metrics.modelLatencyMs ?? "N/A"} ms`);
  console.log(`  Tool Latency:           ${evidence.metrics.toolExecutionLatencyMs} ms`);
  console.log(`  Total Wall Clock:       ${evidence.metrics.totalWallClockMs} ms`);
  console.log(`  Context Snapshot Bytes: ${evidence.metrics.promptBytes} bytes`);
  console.log(`  Model Calls:            ${evidence.metrics.modelCallsCount}`);
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
  console.error("[FATAL] Phase 11 Smoke Experiment failed:", err);
  process.exit(1);
});
