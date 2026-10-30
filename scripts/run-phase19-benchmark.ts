/**
 * Phase 19 — Gemma3:1b Local Capability Lower-Bound Test.
 * Target Model: gemma3:1b (Local CPU via Ollama)
 *
 * Invariants & Governance:
 * - Emerald architecture, ports, adapters, domain, and application layers remain FROZEN.
 * - Runtime ProposalValidator, PolicyEvaluator, ToolGateway, and CleanRoomVerifier remain authoritative.
 * - Production model-facing interface remains exactly the frozen Phase 16 Condition A interface.
 * - Local Ollama model: gemma3:1b (ID: 83be9dbf9dd6, Q4_K_M, ~1B, CPU at ₹0).
 * - Gate A: 120,000 ms ceiling (single Step 1 request, no physical tools).
 * - Gate B: Full governed coding run (executed ONLY if Gate A passes).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { DockerExecutionProvider } from "../src/adapters/execution/docker-execution-provider.js";
import { OllamaModelProvider } from "../src/adapters/models/ollama-model-provider.js";
import { SqliteStateStore } from "../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../src/adapters/workspace/node-fs-workspace-adapter.js";
import {
  AgentStepController,
  DEFAULT_STEP_CONTROLLER_BUDGET,
} from "../src/application/agent-step-controller.js";
import { CleanRoomVerifier } from "../src/application/clean-room-verifier.js";
import { ContextEngine } from "../src/application/context/context-engine.js";
import { ContextSource } from "../src/application/context/context-source.js";
import { LiveAgentBrain } from "../src/application/live-agent-brain.js";
import { ProposalValidator } from "../src/application/proposal-validator.js";
import { RunCoordinator } from "../src/application/run-coordinator.js";
import { WorkerRuntime } from "../src/application/worker-runtime.js";
import { createExecutionPolicy } from "../src/domain/policy.js";
import { staticToolRegistry } from "../src/domain/tool.js";
import {
  CleanRoomVerificationSpec,
  createVerificationSpec,
} from "../src/domain/verification.js";
import {
  AgentBrainPort,
  AgentBrainRequest,
  AgentBrainResult,
} from "../src/ports/agent-brain.port.js";
import { SystemClock } from "../src/ports/clock.port.js";
import { createMockGitRepository } from "../tests/adapters/tools/git-test-helper.js";
import { createAndActivateContract } from "../tests/application/test-helpers.js";

// ============================================================================
// 1. Historical Artifact Protection
// ============================================================================

const BRAIN_SCRATCH_DIR = path.resolve(
  "C:/Users/Adusumalli Girish/.gemini/antigravity/brain/543bddec-0a19-44a7-9818-72be776b138b/scratch"
);
const LOCAL_SCRATCH_DIR = path.resolve("scratch");

const HISTORICAL_HASHES: Readonly<Record<string, string>> = Object.freeze({
  "phase9-4b-summary.json": "FC81ED4C9E0FA60D2232104DC0CCFA57C4FB26BCDAB79E6D17D52F3FE575D92E",
  "phase10a-summary.json": "3D7AB05E40E7F5B7CC62175D9FF5A49BC4A81373EEF01DA0FDB30B9B1FFDA9AB",
  "phase10b-structured-output-diagnostic.json": "6A86F522ADD8ACB6F7A5D3D7CB560346FFED9E15982F84C97AA25AD539D35A24",
  "phase10c-schema-union-diagnostic.json": "BDF5275841FD46F31890964B941832AA11F0E1EFC2396FAFA0375FF1C99D1A4A",
  "phase10e-summary.json": "6D0DEB0E1685FDBF06882A90AF4A0AD27CA68DEEFE03F37CC36FEC6632A37136",
  "phase10f-tool-input-diagnostic.json": "46F0B3EE24FFFCCA06CDA3133A9199FE3096E23A063F2293FF5813D6F2424DE0",
  "phase10h-tool-contract-diagnostic.json": "6DF83F1792D1AD10649393DC86DF4451AC27BA495844B292B947FCB131BC8961",
  "phase11-smoke-evidence.json": "8F2B71B6604794952F2DFDA6777206D68A274E50CD489FA32BE61BE4294A0021",
  "phase12-smoke-evidence.json": "19A58904795D2F908565C1BF38A70F15DCDA27884AA072695FE7128986C4ED32",
});

function verifyHistoricalArtifactsPreserved(): void {
  for (const [filename, expectedSha256] of Object.entries(HISTORICAL_HASHES)) {
    const fullPath = path.join(BRAIN_SCRATCH_DIR, filename);
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
  console.log("[PREFLIGHT] All 9 historical evaluation artifacts verified byte-for-byte intact.");
}

// ============================================================================
// 2. Custom Node:HTTP Fetch Implementation
// ============================================================================

function createCustomSocketFetch(socketTimeoutMs: number = 150_000): (input: string | URL, init?: RequestInit) => Promise<Response> {
  return (input: string | URL, init?: RequestInit): Promise<Response> => {
    return new Promise((resolve, reject) => {
      const url = new URL(input.toString());
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port ? parseInt(url.port, 10) : 80,
          path: url.pathname + url.search,
          method: init?.method || "GET",
          headers: (init?.headers as Record<string, string>) || {},
          timeout: socketTimeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const bodyBuffer = Buffer.concat(chunks);
            const response = new Response(bodyBuffer, {
              status: res.statusCode || 200,
              statusText: res.statusMessage || "OK",
              headers: res.headers as any,
            });
            resolve(response);
          });
        }
      );

      req.on("timeout", () => {
        req.destroy(new Error(`Socket timeout exceeded (${socketTimeoutMs}ms)`));
      });

      req.on("error", (err) => {
        reject(err);
      });

      if (init?.signal) {
        init.signal.addEventListener(
          "abort",
          () => {
            req.destroy(init.signal?.reason || new Error("Request aborted by AbortSignal"));
          },
          { once: true }
        );
      }

      if (init?.body) {
        req.write(init.body);
      }
      req.end();
    });
  };
}

// ============================================================================
// 3. Fixtures
// ============================================================================

const DEFECTIVE_MATH_JS = `/**
 * Math utilities.
 */

function add(a, b) {
  // Defect: subtracts instead of adds
  return a - b;
}

function multiply(a, b) {
  return a * b;
}

module.exports = { add, multiply };
`;

const TARGET_TEST_JS = `const assert = require("node:assert");
const { add } = require("../src/math.js");

try {
  assert.strictEqual(add(2, 3), 5, "add(2, 3) must equal 5");
  assert.strictEqual(add(-1, 1), 0, "add(-1, 1) must equal 0");
  console.log("PASS: 2 of 2 target tests passing");
  process.exit(0);
} catch (err) {
  console.error("FAIL target:", err.message);
  process.exit(1);
}
`;

const REGRESS_TEST_JS = `const assert = require("node:assert");
const { multiply } = require("../src/math.js");

try {
  assert.strictEqual(multiply(2, 3), 6, "multiply(2, 3) must equal 6");
  assert.strictEqual(multiply(0, 5), 0, "multiply(0, 5) must equal 0");
  assert.strictEqual(multiply(-2, 4), -8, "multiply(-2, 4) must equal -8");
  console.log("PASS: 3 of 3 regression tests passing");
  process.exit(0);
} catch (err) {
  console.error("FAIL regression:", err.message);
  process.exit(1);
}
`;

// ============================================================================
// 4. Capability Depth Evaluator
// ============================================================================

export interface CapabilityDepthResult {
  depth: number;
  description: string;
  step0_modelResponded: boolean;
  step1_validProposal: boolean;
  step2_firstToolExecuted: boolean;
  step3_obsIncorporated: boolean;
  step4_secondToolProposal: boolean;
  step5_physicalMutation: boolean;
  step6_correctGoalClaim: boolean;
  step7_independentVerification: boolean;
  step8_verifiedCompleted: boolean;
}

function evaluateCapabilityDepth(params: {
  records: any[];
  physicalActionCount: number;
  actualMutationOccurred: boolean;
  cleanRoomReached: boolean;
  finalRunStatus: string;
}): CapabilityDepthResult {
  const { records, physicalActionCount, actualMutationOccurred, cleanRoomReached, finalRunStatus } = params;

  const step0 = records.length > 0;
  const step1 = records.some((r) => r.proposalValid);
  const step2 = physicalActionCount > 0;

  const step2Record = records.find((r) => r.sequenceNumber === 2);
  const step3 = Boolean(step2Record && !step2Record.hasContentHashInput && step2Record.proposalValid);

  const validProposals = records.filter((r) => r.proposalValid);
  const step4 = validProposals.length >= 2;

  const step5 = actualMutationOccurred;
  const step6 = records.some((r) => r.proposal?.isGoalReached === true && actualMutationOccurred);
  const step7 = cleanRoomReached;
  const step8 = finalRunStatus === "COMPLETED";

  let depth = 0;
  if (step0) depth = 0;
  if (step1) depth = 1;
  if (step2) depth = 2;
  if (step3) depth = 3;
  if (step4) depth = 4;
  if (step5) depth = Math.max(depth, 5);
  if (step6) depth = 6;
  if (step7) depth = 7;
  if (step8) depth = 8;

  const descriptions: Record<number, string> = {
    0: "Model responded",
    1: "Valid action proposal generated",
    2: "First physical tool execution succeeded",
    3: "Observation correctly incorporated",
    4: "Second valid tool proposal generated",
    5: "Physical workspace mutation verified",
    6: "Correct completion goal claimed",
    7: "Clean-room independent verification executed",
    8: "Mission VERIFIED and COMPLETED",
  };

  return {
    depth,
    description: descriptions[depth] ?? `Step ${depth}`,
    step0_modelResponded: step0,
    step1_validProposal: step1,
    step2_firstToolExecuted: step2,
    step3_obsIncorporated: step3,
    step4_secondToolProposal: step4,
    step5_physicalMutation: step5,
    step6_correctGoalClaim: step6,
    step7_independentVerification: step7,
    step8_verifiedCompleted: step8,
  };
}

// ============================================================================
// 5. Main Execution
// ============================================================================

async function main(): Promise<void> {
  console.log("======================================================================");
  console.log("EMERALD AGENT FABRIC — PHASE 19 GEMMA3:1B LOWER-BOUND CAPABILITY TEST");
  console.log("Target Model: gemma3:1b (CPU via Ollama)");
  console.log("======================================================================");

  verifyHistoricalArtifactsPreserved();

  const baseUrl = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  const modelName = "gemma3:1b";
  const GATE_A_TIMEOUT_MS = 120_000; // 120 seconds (2 minutes)

  console.log(`[CONFIG] Baseline Commit: 70979cf4bcbf4a237b79af3a23449a4b932104d5`);
  console.log(`[CONFIG] Ollama Endpoint: ${baseUrl}`);
  console.log(`[CONFIG] Model Under Test: ${modelName} (83be9dbf9dd6, Q4_K_M, ~1B)`);
  console.log(`[CONFIG] Target Platform: Local CPU (₹0)`);
  console.log(`[CONFIG] Gate A Timeout Ceiling: ${GATE_A_TIMEOUT_MS}ms (120s)`);

  // Verify Ollama & Docker
  try {
    const res = await fetch(`${baseUrl}/api/tags`);
    if (!res.ok) throw new Error(`Ollama returned status ${res.status}`);
    const tags = (await res.json()) as any;
    const hasModel = tags.models?.some((m: any) => m.name === modelName || m.model === modelName);
    if (!hasModel) throw new Error(`Required model '${modelName}' not found in Ollama.`);
    console.log(`[PREFLIGHT] Ollama is ONLINE with model '${modelName}'`);
  } catch (err: unknown) {
    console.error(`[FATAL] Ollama preflight failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const dockerProbe = await DockerExecutionProvider.isAvailable();
  if (!dockerProbe.available) {
    console.error("[FATAL] Docker daemon is not available.");
    process.exit(1);
  }
  console.log("[PREFLIGHT] Docker daemon is online and responsive.");

  const taskDirective = [
    "Repair the failing math implementation in src/math.js.",
    "",
    "First read src/math.js using:",
    "",
    '{"path":"src/math.js"}',
    "",
    "Inspect the existing implementation.",
    "",
    "The required behavior is:",
    "",
    "add(2, 3) must return 5.",
    "",
    "Make the minimal code change required to fix the behavior.",
    "",
    "Use write_file on src/math.js.",
    "",
    "The content field must contain the actual JavaScript source code.",
    "",
    "Do not output placeholders.",
    "Do not output Markdown.",
    "Do not output an explanation instead of code.",
    "",
    "After making the repair, continue normally and only claim completion when the repair has actually been made.",
  ].join("\n");

  const taskDirectiveHash = crypto
    .createHash("sha256")
    .update(taskDirective, "utf8")
    .digest("hex");

  // ==========================================================================
  // GATE A — INFERENCE FEASIBILITY (Single Step 1 Request, 120s Timeout)
  // ==========================================================================
  console.log("\n----------------------------------------------------------------------");
  console.log("GATE A — INFERENCE FEASIBILITY (Single Step 1 Request, 120s Timeout)");
  console.log("----------------------------------------------------------------------");

  const tempBaseDirA = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-phase19-gateA-"));
  const storeA = new SqliteStateStore();
  const clockA = new SystemClock();
  const coordinatorA = new RunCoordinator(storeA, clockA);
  const workerIdA = "worker-phase19-gateA";

  storeA.transaction((tx) => {
    tx.insertWorker({
      workerId: workerIdA,
      hostname: "localhost",
      pid: process.pid,
      status: "ACTIVE",
      createdAt: clockA.nowIso(),
      lastHeartbeatAt: clockA.nowIso(),
    });
  });

  const taskA = coordinatorA.createTask({
    title: "Phase 19 Gate A: gemma3:1b Inference Feasibility",
    description: taskDirective,
    inputPayload: { directive: taskDirective },
  });

  const contractA = createAndActivateContract(storeA, taskA.taskId, {
    policy: createExecutionPolicy({
      policyId: `policy-${taskA.taskId}`,
      allowedCapabilities: [
        "workspace.file.read",
        "workspace.file.write",
        "workspace.code.search",
        "git.read",
        "process.execute",
      ],
      isolationRequirement: "ISOLATED",
    }),
    verificationSpecs: [],
    timeoutMs: 1_200_000,
    maxOutputBytes: 1048576,
    maxAttempts: 5,
  });

  const { run: runA } = coordinatorA.createRun({ taskId: taskA.taskId });
  coordinatorA.queueRun(runA.runId);
  const claimA = coordinatorA.claimRun(runA.runId, workerIdA, 1_800_000);
  coordinatorA.startRun(runA.runId, workerIdA, claimA.lease.leaseId);

  const contextSourceA = new ContextSource(storeA);
  const candidatesA = await contextSourceA.gatherCandidateObservations(runA.runId);
  const contextSnapshotA = ContextEngine.build({
    runId: runA.runId,
    taskId: taskA.taskId,
    candidates: candidatesA,
    budget: { maxObservations: 50, maxEstimatedTokens: 4096, maxBytes: 32768 },
    createdAt: clockA.nowIso(),
  });

  const customFetchA = createCustomSocketFetch(150_000);
  const modelProviderA = new OllamaModelProvider({
    baseURL: baseUrl,
    defaultModel: modelName,
    timeoutMs: GATE_A_TIMEOUT_MS,
    fetch: customFetchA,
  });

  const liveBrainA = new LiveAgentBrain({
    modelProvider: modelProviderA,
    model: modelName,
    timeoutMs: GATE_A_TIMEOUT_MS,
    generationOptions: { temperature: 0.0, maxOutputTokens: 1024 },
    clock: clockA,
  });

  const proposalValidatorA = new ProposalValidator({
    toolRegistry: staticToolRegistry,
    stateStore: storeA,
    coordinator: coordinatorA,
  });

  const brainRequestA: AgentBrainRequest = {
    runId: runA.runId,
    contextSnapshot: contextSnapshotA,
    availableTools: staticToolRegistry.listTools(),
    sequenceNumber: 1,
  };

  const modelReqA = liveBrainA.buildModelRequest(brainRequestA);
  const promptBytesA = Buffer.byteLength(JSON.stringify(modelReqA.input), "utf8");

  let brainResultA: AgentBrainResult | null = null;
  let brainErrorA: Error | null = null;
  let inferenceTimeA = 0;

  console.log(`[GATE A] Dispatching Step 1 inference request to '${modelName}' (timeout: 120s)...`);
  const t0A = performance.now();
  try {
    brainResultA = await liveBrainA.proposeAction(brainRequestA);
    inferenceTimeA = Math.round(performance.now() - t0A);
    console.log(`[GATE A] Model responded in ${(inferenceTimeA / 1000).toFixed(1)}s (${inferenceTimeA}ms)`);
  } catch (err: unknown) {
    inferenceTimeA = Math.round(performance.now() - t0A);
    brainErrorA = err instanceof Error ? err : new Error(String(err));
    console.error(`[GATE A ERROR] Inference failed after ${(inferenceTimeA / 1000).toFixed(1)}s: ${brainErrorA.message}`);
  }

  let gateAClassification: "INFERENCE_VALIDATED" | "MODEL_SCHEMA_FAILURE" | "ENVIRONMENT_FAILURE" = "ENVIRONMENT_FAILURE";
  let gateAProposalValid = false;
  let gateAResponseStatus = "ERROR";
  let gateARawOutput: string | null = null;
  let gateAProposal: any = null;
  let gateAValidationReason: string | null = null;

  if (brainResultA) {
    gateAResponseStatus = "RECEIVED";
    gateARawOutput = brainResultA.rawOutput ?? null;
    console.log(`[GATE A] Raw Output:\n${brainResultA.rawOutput}`);

    if (brainResultA.proposal) {
      gateAProposal = brainResultA.proposal;
      console.log(`[GATE A] Parsed Proposal:\n${JSON.stringify(brainResultA.proposal, null, 2)}`);
      const valResultA = proposalValidatorA.validate(brainResultA.proposal, {
        runId: runA.runId,
        contextSnapshot: contextSnapshotA,
        workerId: workerIdA,
        leaseId: claimA.lease.leaseId,
        run: storeA.getRun(runA.runId)!,
        contract: contractA,
      });
      console.log(`[GATE A] Proposal Valid: ${valResultA.valid}, Reason: ${valResultA.reason ?? "NONE"}`);
      gateAProposalValid = valResultA.valid;
      gateAValidationReason = valResultA.reason ?? null;
      if (valResultA.valid) {
        gateAClassification = "INFERENCE_VALIDATED";
      } else {
        gateAClassification = "MODEL_SCHEMA_FAILURE";
      }
    } else {
      gateAClassification = "MODEL_SCHEMA_FAILURE";
      gateAValidationReason = "NO_PROPOSAL_PARSED";
    }
  } else {
    gateAResponseStatus = brainErrorA?.message?.includes("timed out") || brainErrorA?.message?.includes("timeout")
      ? "TIMEOUT"
      : "ERROR";
    gateAClassification = "ENVIRONMENT_FAILURE";
  }

  console.log(`[GATE A RESULT] ${gateAClassification}`);

  // Cleanup Gate A temporary store
  try {
    storeA.close();
    fs.rmSync(tempBaseDirA, { recursive: true, force: true });
  } catch {
    // ignore
  }

  // If Gate A failed, record evidence and STOP
  if (gateAClassification !== "INFERENCE_VALIDATED") {
    console.log("\n[STOP] Gate A failed. Halting before Gate B per Section 5 stop conditions.");

    const gateAOnlyEvidence = {
      $schema: "https://emerald.agentfabric.dev/schemas/v1/phase19-gemma3-1b-report.json",
      experimentId: `exp-phase19-${Date.now()}`,
      timestamp: new Date().toISOString(),
      baselineCommitSha: "70979cf4bcbf4a237b79af3a23449a4b932104d5",
      model: {
        identifier: modelName,
        digest: "83be9dbf9dd6",
        size: "~1B",
        parameters: "999.89M",
        quantization: "Q4_K_M",
        architecture: "gemma3",
        contextLength: 32768,
        provider: "ollama",
        hardware: "CPU",
      },
      taskDirectiveHash,
      contextBytes: contextSnapshotA.totalBytes,
      promptBytes: promptBytesA,
      gateA: {
        inferenceTimeMs: inferenceTimeA,
        response: gateAResponseStatus,
        validProposal: gateAProposalValid,
        classification: gateAClassification,
        rawModelResponse: gateARawOutput,
        proposal: gateAProposal,
        validationReason: gateAValidationReason,
      },
      gateB: { status: "NOT_RUN" as const },
      finalRunStatus: "NOT_RUN",
      primaryClassification: gateAClassification,
    };

    const jsonReportPathLocal = path.join(LOCAL_SCRATCH_DIR, "phase19-gemma3-1b-report.json");
    fs.writeFileSync(jsonReportPathLocal, JSON.stringify(gateAOnlyEvidence, null, 2), "utf8");
    console.log(`[EVIDENCE] Saved Gate A evidence to ${jsonReportPathLocal}`);
    return;
  }

  // ==========================================================================
  // GATE B — FULL GOVERNED CODING RUN (AgentStepController + CleanRoomVerifier)
  // ==========================================================================
  console.log("\n----------------------------------------------------------------------");
  console.log("GATE B — FULL GOVERNED CODING RUN (AgentStepController + CleanRoomVerifier)");
  console.log("----------------------------------------------------------------------");

  const wallClockStartB = performance.now();
  let gateBClassification:
    | "MODEL_CAPABILITY_SUCCESS"
    | "MODEL_CODING_FAILURE"
    | "MODEL_SCHEMA_FAILURE"
    | "ENVIRONMENT_FAILURE"
    | "VERIFICATION_FAILURE"
    | "GOVERNANCE_FAILURE" = "MODEL_CODING_FAILURE";

  const tempBaseDirB = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-phase19-gateB-"));
  const workspaceRootDirB = path.join(tempBaseDirB, "workspaces");
  fs.mkdirSync(workspaceRootDirB, { recursive: true });

  const storeB = new SqliteStateStore();
  const clockB = new SystemClock();
  const workspaceAdapterB = new NodeFsWorkspaceAdapter({ workspaceRoot: workspaceRootDirB });
  const coordinatorB = new RunCoordinator(storeB, clockB);
  const executionProviderB = new DockerExecutionProvider();

  const workerIdB = "worker-phase19-live";
  const leaseTtlMsB = 1_800_000;

  storeB.transaction((tx) => {
    tx.insertWorker({
      workerId: workerIdB,
      hostname: "localhost",
      pid: process.pid,
      status: "ACTIVE",
      createdAt: clockB.nowIso(),
      lastHeartbeatAt: clockB.nowIso(),
    });
  });

  const workerRuntimeB = new WorkerRuntime({
    workerId: workerIdB,
    stateStore: storeB,
    coordinator: coordinatorB,
    toolRegistry: staticToolRegistry,
    workspacePort: workspaceAdapterB,
    executionProvider: executionProviderB,
    isIsolationAvailable: true,
    clock: clockB,
  });

  const customFetchB = createCustomSocketFetch(150_000);
  const modelProviderB = new OllamaModelProvider({
    baseURL: baseUrl,
    defaultModel: modelName,
    timeoutMs: GATE_A_TIMEOUT_MS,
    fetch: customFetchB,
  });

  const liveBrainB = new LiveAgentBrain({
    modelProvider: modelProviderB,
    model: modelName,
    timeoutMs: GATE_A_TIMEOUT_MS,
    generationOptions: { temperature: 0.0, maxOutputTokens: 1024 },
    clock: clockB,
  });

  const rawModelCallsB: Array<{
    sequenceNumber: number;
    timestamp: string;
    model: string;
    contextBytes: number;
    promptBytes: number;
    modelResponse: string;
    proposal: any;
    durationMs: number;
    hasContentHashInput: boolean;
  }> = [];

  const instrumentedBrainB: AgentBrainPort = {
    async proposeAction(request: AgentBrainRequest): Promise<AgentBrainResult> {
      const modelReq = liveBrainB.buildModelRequest(request);
      const promptBytes = Buffer.byteLength(JSON.stringify(modelReq.input), "utf8");
      const contextBytes = request.contextSnapshot.totalBytes;
      const t0 = performance.now();
      const res = await liveBrainB.proposeAction(request);
      const elapsed = Math.round(performance.now() - t0);

      let hasContentHash = false;
      if (res.proposal?.inputPayload && typeof res.proposal.inputPayload === "object") {
        hasContentHash = "contentHash" in res.proposal.inputPayload;
      }

      rawModelCallsB.push({
        sequenceNumber: request.sequenceNumber,
        timestamp: clockB.nowIso(),
        model: modelName,
        contextBytes,
        promptBytes,
        modelResponse: res.rawOutput ?? "",
        proposal: res.proposal ?? null,
        durationMs: elapsed,
        hasContentHashInput: hasContentHash,
      });
      return res;
    },
  };

  const proposalValidatorB = new ProposalValidator({
    toolRegistry: staticToolRegistry,
    stateStore: storeB,
    coordinator: coordinatorB,
  });

  let cleanRoomReached = false;
  let cleanRoomOutcome: any = null;
  const cleanRoomVerifierB = new CleanRoomVerifier({
    workspacePort: workspaceAdapterB,
    workerRuntime: workerRuntimeB,
    coordinator: coordinatorB,
    stateStore: storeB,
    clock: clockB,
  });

  const origVerifyCandidatePatch = cleanRoomVerifierB.verifyCandidatePatch.bind(cleanRoomVerifierB);
  cleanRoomVerifierB.verifyCandidatePatch = async (params: any) => {
    cleanRoomReached = true;
    cleanRoomOutcome = await origVerifyCandidatePatch(params);
    return cleanRoomOutcome;
  };

  const stepControllerB = new AgentStepController({
    coordinator: coordinatorB,
    stateStore: storeB,
    workerRuntime: workerRuntimeB,
    agentBrain: instrumentedBrainB,
    proposalValidator: proposalValidatorB,
    toolRegistry: staticToolRegistry,
    clock: clockB,
    cleanRoomVerifier: cleanRoomVerifierB,
  });

  const taskB = coordinatorB.createTask({
    title: "Phase 19 Gate B: gemma3:1b Governed Coding Run",
    description: taskDirective,
    inputPayload: { directive: taskDirective },
  });

  const wsB = await workspaceAdapterB.provisionWorkspace({
    workspaceId: `ws-${taskB.taskId.slice(0, 8)}`,
    runId: `run-${taskB.taskId.slice(0, 8)}`,
    taskId: taskB.taskId,
    maxWorkspaceBytes: 50 * 1024 * 1024,
    maxFileSizeBytes: 10 * 1024 * 1024,
  });

  const repoInfoB = await createMockGitRepository(wsB.hostPath, [
    { path: "package.json", content: '{\n  "name": "math-unit",\n  "version": "1.0.0"\n}\n' },
    { path: "src/math.js", content: DEFECTIVE_MATH_JS },
    { path: "test/math.target.test.js", content: TARGET_TEST_JS },
    { path: "test/math.regress.test.js", content: REGRESS_TEST_JS },
  ]);

  const cleanRoomSpecB: CleanRoomVerificationSpec = {
    specId: `spec-${taskB.taskId.slice(0, 8)}`,
    baselineCommitSha: repoInfoB.commitSha,
    failToPass: {
      testCommand: ["node", "test/math.target.test.js"],
      expectedBaselineExitCode: 1,
      expectedPatchedExitCode: 0,
      minTestCount: 2,
      suiteRanRegex: "PASS:?\\s*2\\s+of\\s+2",
    },
    passToPass: {
      testCommand: ["node", "test/math.regress.test.js"],
      expectedBaselineExitCode: 0,
      expectedPatchedExitCode: 0,
      minTestCount: 3,
      suiteRanRegex: "PASS:?\\s*3\\s+of\\s+3",
    },
    allowedPathPatterns: ["src/**/*.js"],
    timeoutMs: 30_000,
  };

  const verificationSpecB = createVerificationSpec({
    specId: cleanRoomSpecB.specId,
    ruleKind: "CLEAN_ROOM_DUAL_GATE",
    expectedValue: cleanRoomSpecB,
  });

  const contractB = createAndActivateContract(storeB, taskB.taskId, {
    policy: createExecutionPolicy({
      policyId: `policy-${taskB.taskId}`,
      allowedCapabilities: [
        "workspace.file.read",
        "workspace.file.write",
        "workspace.code.search",
        "git.read",
        "process.execute",
      ],
      isolationRequirement: "ISOLATED",
    }),
    verificationSpecs: [verificationSpecB],
    timeoutMs: 1_200_000,
    maxOutputBytes: 1048576,
    maxAttempts: 5,
  });

  const { run: runB } = coordinatorB.createRun({ taskId: taskB.taskId });
  coordinatorB.queueRun(runB.runId);
  const claimB = coordinatorB.claimRun(runB.runId, workerIdB, leaseTtlMsB);
  coordinatorB.startRun(runB.runId, workerIdB, claimB.lease.leaseId);

  console.log(`[SETUP] Task: ${taskB.taskId}`);
  console.log(`[SETUP] Contract: ${contractB.spec.contractId}`);
  console.log(`[SETUP] Run: ${runB.runId}`);
  console.log(`[SETUP] Lease: ${claimB.lease.leaseId}`);

  console.log("\n[EXEC] Initiating Governed Step Loop with Clean-Room Verification Gate...");
  const loopStartTimeB = performance.now();

  let stepResultB: any;
  let loopThrewError = false;
  try {
    stepResultB = await stepControllerB.runStepLoop({
      runId: runB.runId,
      leaseId: claimB.lease.leaseId,
      workerId: workerIdB,
      workspace: wsB,
      budget: {
        ...DEFAULT_STEP_CONTROLLER_BUDGET,
        maxSteps: 12,
        maxActions: 8,
        maxWallClockMs: 1_800_000,
        maxProposalRejections: 6,
      },
    });
  } catch (err: unknown) {
    loopThrewError = true;
    console.error(`[EXEC ERROR] Step loop threw exception: ${err instanceof Error ? err.message : String(err)}`);
  }

  const loopDurationMsB = Math.round(performance.now() - loopStartTimeB);
  console.log(`\n[EXEC] Loop finished in ${(loopDurationMsB / 1000).toFixed(1)}s`);
  console.log(`[EXEC] Terminal Reason: ${stepResultB?.terminalReason}`);
  console.log(`[EXEC] Terminal Message: ${stepResultB?.terminalMessage}`);
  console.log(`[EXEC] Total Steps: ${stepResultB?.totalSteps}`);
  console.log(`[EXEC] Total Actions: ${stepResultB?.totalActions}`);

  // Post-mortem state analysis
  const finalRunB = storeB.getRun(runB.runId);
  const actionsB = storeB.getActionsForRun(runB.runId);

  let actualMutationOccurredB = false;
  let candidatePatchContent = "";
  const currentMathJs = path.join(wsB.hostPath, "src/math.js");
  if (fs.existsSync(currentMathJs)) {
    const mathContent = fs.readFileSync(currentMathJs, "utf8");
    actualMutationOccurredB = mathContent.trim() !== DEFECTIVE_MATH_JS.trim();
    if (actualMutationOccurredB) {
      candidatePatchContent = mathContent;
    }
  }

  // Correlate telemetry with stepResult transcript
  const enrichedRecords: any[] = [];
  if (stepResultB?.transcript && Array.isArray(stepResultB.transcript)) {
    for (let i = 0; i < rawModelCallsB.length; i++) {
      const call = rawModelCallsB[i];
      const stepEntry = stepResultB.transcript[i];
      enrichedRecords.push({
        ...call,
        proposalValid: Boolean(stepEntry?.proposalValid),
        rejectionReason: stepEntry?.proposalRejectionReason ?? null,
        rejectionMessage: stepEntry?.proposalRejectionMessage ?? null,
      });
    }
  }

  const physicalActionCount = actionsB.filter((a) => a.status === "SUCCEEDED").length;
  const finalStatus = (finalRunB?.status ?? "FAILED") as "COMPLETED" | "FAILED";

  if (loopThrewError) {
    gateBClassification = "GOVERNANCE_FAILURE";
  } else if (finalStatus === "COMPLETED" && cleanRoomOutcome?.verified) {
    gateBClassification = "MODEL_CAPABILITY_SUCCESS";
  } else if (cleanRoomReached && !cleanRoomOutcome?.verified) {
    gateBClassification = "VERIFICATION_FAILURE";
  } else if (enrichedRecords.every((r) => !r.proposalValid)) {
    gateBClassification = "MODEL_SCHEMA_FAILURE";
  } else {
    gateBClassification = "MODEL_CODING_FAILURE";
  }

  const capabilityDepth = evaluateCapabilityDepth({
    records: enrichedRecords,
    physicalActionCount,
    actualMutationOccurred: actualMutationOccurredB,
    cleanRoomReached,
    finalRunStatus: finalStatus,
  });

  const totalProposals = enrichedRecords.length;
  const validProposals = enrichedRecords.filter((r) => r.proposalValid).length;
  const invalidProposals = totalProposals - validProposals;
  const validityRatePct = totalProposals > 0 ? Math.round((validProposals / totalProposals) * 1000) / 10 : 0;
  const hallucinatedContentHash = enrichedRecords.some((r) => r.hasContentHashInput);

  // Coding analysis
  const codingAnalysis = {
    inspectedMathJs: enrichedRecords.some((r) => r.proposal?.toolName === "read_file"),
    choseReadFile: enrichedRecords.some((r) => r.proposal?.toolName === "read_file" && r.proposalValid),
    skippedInspection: !enrichedRecords.some((r) => r.proposal?.toolName === "read_file"),
    producedJavascript: actualMutationOccurredB && candidatePatchContent.includes("function"),
    usedPlaceholders: candidatePatchContent.includes("<") && candidatePatchContent.includes(">"),
    hallucinatedToolParams: hallucinatedContentHash,
    claimedCompletionPrematurely: enrichedRecords.some(
      (r) => r.proposal?.isGoalReached === true && !actualMutationOccurredB
    ),
    preservedMultiply: actualMutationOccurredB && candidatePatchContent.includes("multiply"),
    correctAddFix: actualMutationOccurredB && candidatePatchContent.includes("a + b"),
  };

  // Step latencies
  const stepLatencies = rawModelCallsB.map((c) => ({
    sequenceNumber: c.sequenceNumber,
    durationMs: c.durationMs,
    durationS: Number((c.durationMs / 1000).toFixed(1)),
  }));

  const avgLatencyMs = rawModelCallsB.length > 0
    ? Math.round(rawModelCallsB.reduce((sum, c) => sum + c.durationMs, 0) / rawModelCallsB.length)
    : 0;

  const reportPayload = {
    $schema: "https://emerald.agentfabric.dev/schemas/v1/phase19-gemma3-1b-report.json",
    experimentId: `exp-phase19-${Date.now()}`,
    timestamp: new Date().toISOString(),
    baselineCommitSha: "70979cf4bcbf4a237b79af3a23449a4b932104d5",
    model: {
      identifier: modelName,
      digest: "83be9dbf9dd6",
      size: "~1B",
      parameters: "999.89M",
      quantization: "Q4_K_M",
      architecture: "gemma3",
      contextLength: 32768,
      provider: "ollama",
      hardware: "CPU",
    },
    taskDirectiveHash,
    gateA: {
      inferenceTimeMs: inferenceTimeA,
      response: gateAResponseStatus,
      validProposal: gateAProposalValid,
      classification: gateAClassification,
      rawModelResponse: gateARawOutput,
      proposal: gateAProposal,
      validationReason: gateAValidationReason,
    },
    gateB: {
      status: "EXECUTED",
      totalWallClockMs: Math.round(performance.now() - wallClockStartB),
      loopDurationMs: loopDurationMsB,
      terminalReason: stepResultB?.terminalReason,
      terminalMessage: stepResultB?.terminalMessage,
      totalProposals,
      validProposals,
      invalidProposals,
      validityRatePct,
      physicalActionCount,
      physicalMutationOccurred: actualMutationOccurredB,
      hallucinatedContentHash,
      cleanRoomReached,
      cleanRoomOutcome,
      capabilityDepth,
      codingAnalysis,
      stepLatencies,
      avgLatencyMs,
      candidatePatchContent,
      finalRunStatus: finalStatus,
      records: enrichedRecords,
    },
    primaryClassification: gateBClassification,
  };

  const jsonReportPathLocal = path.join(LOCAL_SCRATCH_DIR, "phase19-gemma3-1b-report.json");
  fs.writeFileSync(jsonReportPathLocal, JSON.stringify(reportPayload, null, 2), "utf8");

  console.log(`\n[ARTIFACT] Saved Phase 19 report to ${jsonReportPathLocal}`);

  // Summary output
  console.log("\n======================================================================");
  console.log("PHASE 19 SUMMARY");
  console.log("======================================================================");
  console.log(`Model:              ${modelName}`);
  console.log(`Gate A:             ${gateAClassification} (${(inferenceTimeA / 1000).toFixed(1)}s)`);
  console.log(`Gate B:             ${gateBClassification}`);
  console.log(`Total Proposals:    ${totalProposals}`);
  console.log(`Valid Proposals:    ${validProposals} (${validityRatePct}%)`);
  console.log(`Physical Actions:   ${physicalActionCount}`);
  console.log(`Mutation:           ${actualMutationOccurredB}`);
  console.log(`ContentHash Halluc: ${hallucinatedContentHash}`);
  console.log(`Clean-Room Reached: ${cleanRoomReached}`);
  console.log(`Capability Depth:   ${capabilityDepth.depth} — ${capabilityDepth.description}`);
  console.log(`Avg Latency:        ${(avgLatencyMs / 1000).toFixed(1)}s`);
  console.log(`Loop Duration:      ${(loopDurationMsB / 1000).toFixed(1)}s`);
  console.log(`Final Run Status:   ${finalStatus}`);
  console.log(`Classification:     ${gateBClassification}`);

  // Cleanup temporary workspace
  try {
    storeB.close();
    fs.rmSync(tempBaseDirB, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

main().catch((err) => {
  console.error(`[FATAL] Phase 19 Benchmark threw error: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
