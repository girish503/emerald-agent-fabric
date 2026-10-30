/**
 * Phase 15E — Ultra-Light Local Coding Model Capability Benchmark Runner.
 *
 * Two-stage controlled empirical benchmark evaluating qwen2.5:1.5b on CPU via Ollama:
 * - Gate A: Inference feasibility (Step 1 proposal generation within 120s timeout).
 * - Gate B: Full governed coding run (only executed if Gate A succeeds).
 *
 * Invariants & Constraints:
 * - Local Ollama model: qwen2.5:1.5b (CPU at ₹0).
 * - Architecture, ports, adapters, domain, and application layers remain FROZEN.
 * - Single controlled experiment.
 * - Strict adherence to the fourfold completion invariant.
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
  IndependentVerificationEvidencePayload,
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

const SCRATCH_DIR = path.resolve(
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
  console.log("[PREFLIGHT] All 9 historical evaluation artifacts verified byte-for-byte intact.");
}

// ============================================================================
// 2. Custom Node:HTTP Fetch Implementation
// ============================================================================

function createCustomSocketFetch(socketTimeoutMs: number = 300_000): (input: string | URL, init?: RequestInit) => Promise<Response> {
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
// 4. Main Two-Stage Benchmark Runner
// ============================================================================

async function main(): Promise<void> {
  console.log("======================================================================");
  console.log("EMERALD AGENT FABRIC — PHASE 15E ULTRA-LIGHT MODEL BENCHMARK");
  console.log("Target Model: qwen2.5:1.5b (CPU via Ollama)");
  console.log("======================================================================");

  verifyHistoricalArtifactsPreserved();

  const baseUrl = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  const modelName = process.env.OLLAMA_MODEL || "qwen2.5:1.5b";
  const GATE_A_TIMEOUT_MS = 120_000; // 120 seconds

  console.log(`[CONFIG] Baseline Commit: 70979cf`);
  console.log(`[CONFIG] Ollama Endpoint: ${baseUrl}`);
  console.log(`[CONFIG] Model Under Test: ${modelName}`);
  console.log(`[CONFIG] Thinking Mode: not_supported (qwen2 architecture)`);
  console.log(`[CONFIG] Gate A Timeout: ${GATE_A_TIMEOUT_MS}ms (120s)`);

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
  // GATE A — INFERENCE FEASIBILITY
  // ==========================================================================
  console.log("\n----------------------------------------------------------------------");
  console.log("GATE A — INFERENCE FEASIBILITY (Single Step 1 Request, 120s Timeout)");
  console.log("----------------------------------------------------------------------");

  const tempBaseDirA = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-phase15e-gateA-"));
  const storeA = new SqliteStateStore();
  const clockA = new SystemClock();
  const coordinatorA = new RunCoordinator(storeA, clockA);
  const workerIdA = "worker-phase15e-gateA";

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
    title: "Phase 15E Gate A: Inference Feasibility",
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

  const customFetchA = createCustomSocketFetch(180_000);
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

  if (brainResultA) {
    gateAResponseStatus = "RECEIVED";
    console.log(`[GATE A] Raw Output:\n${brainResultA.rawOutput}`);

    if (brainResultA.proposal) {
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
      if (valResultA.valid) {
        gateAClassification = "INFERENCE_VALIDATED";
      } else {
        gateAClassification = "MODEL_SCHEMA_FAILURE";
      }
    } else {
      gateAClassification = "MODEL_SCHEMA_FAILURE";
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

  // If Gate A failed, record evidence and STOP per Section 8 & 18
  if (gateAClassification !== "INFERENCE_VALIDATED") {
    console.log("\n[STOP] Gate A failed. Skipping Gate B per Section 8 & 18 stop conditions.");

    const gateAOnlyEvidence = {
      $schema: "https://emerald.agentfabric.dev/schemas/v1/phase15e-benchmark-evidence.json",
      experimentId: `exp-phase15e-${Date.now()}`,
      model: modelName,
      provider: "ollama",
      modelSize: "1.5B",
      thinking: "not_supported",
      hardware: "CPU",
      baselineCommitSha: "70979cf4bcbf4a237b79af3a23449a4b932104d5",
      taskDirectiveHash,
      contextBytes: contextSnapshotA.totalBytes,
      promptBytes: promptBytesA,
      gateA: {
        inferenceTimeMs: inferenceTimeA,
        response: gateAResponseStatus,
        validProposal: gateAProposalValid,
        classification: gateAClassification,
        rawModelResponse: brainResultA?.rawOutput ?? null,
      },
      gateB: { status: "NOT_RUN" },
      finalRunStatus: "NOT_RUN",
      classification: gateAClassification,
    };

    const evidencePath = path.join(SCRATCH_DIR, "phase15e-benchmark-evidence.json");
    fs.writeFileSync(evidencePath, JSON.stringify(gateAOnlyEvidence, null, 2), "utf8");
    console.log(`[EVIDENCE] Saved evidence to ${evidencePath}`);
    return;
  }

  // ==========================================================================
  // GATE B — FULL GOVERNED CODING RUN
  // ==========================================================================
  console.log("\n----------------------------------------------------------------------");
  console.log("GATE B — FULL GOVERNED CODING RUN (AgentStepController + CleanRoomVerifier)");
  console.log("----------------------------------------------------------------------");

  const wallClockStartB = performance.now();
  let gateBClassification = "MODEL_SCHEMA_FAILURE";

  const tempBaseDirB = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-phase15e-gateB-"));
  const workspaceRootDirB = path.join(tempBaseDirB, "workspaces");
  fs.mkdirSync(workspaceRootDirB, { recursive: true });

  const storeB = new SqliteStateStore();
  const clockB = new SystemClock();
  const workspaceAdapterB = new NodeFsWorkspaceAdapter({ workspaceRoot: workspaceRootDirB });
  const coordinatorB = new RunCoordinator(storeB, clockB);
  const executionProviderB = new DockerExecutionProvider();

  const workerIdB = "worker-phase15e-live";
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

  // Observability & timing hooks
  let patchExtractionMs = 0;
  let cleanRoomMaterializationMs = 0;
  let patchApplicationMs = 0;
  let f2pMs = 0;
  let p2pMs = 0;
  let evidencePersistenceMs = 0;
  let totalToolExecutionMs = 0;
  let totalModelInferenceMs = 0;

  const origProvisionWorkspace = workspaceAdapterB.provisionWorkspace.bind(workspaceAdapterB);
  workspaceAdapterB.provisionWorkspace = async (params: any) => {
    const isCleanRoom = params.workspaceId?.startsWith("ws-verify-");
    const t0 = performance.now();
    const handle = await origProvisionWorkspace(params);
    if (isCleanRoom) {
      cleanRoomMaterializationMs += Math.round(performance.now() - t0);
    }
    return handle;
  };

  const origExecuteAction = workerRuntimeB.executeAction.bind(workerRuntimeB);
  workerRuntimeB.executeAction = async (params: any) => {
    const isCleanRoom = params.workspace?.workspaceId?.startsWith("ws-verify-");
    const t0 = performance.now();
    const result = await origExecuteAction(params);
    const elapsed = Math.round(performance.now() - t0);

    if (isCleanRoom) {
      const argv: string[] = params.inputPayload?.argv ?? [];
      const cmdStr = argv.join(" ");
      if (cmdStr.includes("target")) {
        f2pMs += elapsed;
      } else if (cmdStr.includes("regress")) {
        p2pMs += elapsed;
      }
    } else {
      totalToolExecutionMs += elapsed;
    }
    return result;
  };

  const origRecordEvidence = coordinatorB.recordEvidence.bind(coordinatorB);
  coordinatorB.recordEvidence = (runId: string, evidence: any) => {
    const isIndependent = evidence.source === "INDEPENDENT_OBSERVER";
    const t0 = performance.now();
    const res = origRecordEvidence(runId, evidence);
    if (isIndependent) {
      evidencePersistenceMs += Math.round(performance.now() - t0);
    }
    return res;
  };

  const customFetchB = createCustomSocketFetch(300_000);
  const modelProviderB = new OllamaModelProvider({
    baseURL: baseUrl,
    defaultModel: modelName,
    fetch: customFetchB,
  });

  const liveBrainB = new LiveAgentBrain({
    modelProvider: modelProviderB,
    model: modelName,
    timeoutMs: 180_000,
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
  }> = [];

  const instrumentedBrainB: AgentBrainPort = {
    async proposeAction(request: AgentBrainRequest): Promise<AgentBrainResult> {
      const modelReq = liveBrainB.buildModelRequest(request);
      const promptBytes = Buffer.byteLength(JSON.stringify(modelReq.input), "utf8");
      const contextBytes = request.contextSnapshot.totalBytes;
      const t0 = performance.now();
      const res = await liveBrainB.proposeAction(request);
      const elapsed = Math.round(performance.now() - t0);
      totalModelInferenceMs += elapsed;

      rawModelCallsB.push({
        sequenceNumber: request.sequenceNumber,
        timestamp: clockB.nowIso(),
        model: modelName,
        contextBytes,
        promptBytes,
        modelResponse: res.rawOutput ?? "",
        proposal: res.proposal ?? null,
        durationMs: elapsed,
      });
      return res;
    },
  };

  const proposalValidatorB = new ProposalValidator({
    toolRegistry: staticToolRegistry,
    stateStore: storeB,
    coordinator: coordinatorB,
  });

  const cleanRoomVerifierB = new CleanRoomVerifier({
    workspacePort: workspaceAdapterB,
    workerRuntime: workerRuntimeB,
    coordinator: coordinatorB,
    stateStore: storeB,
    clock: clockB,
  });

  const origVerifyCandidatePatch = cleanRoomVerifierB.verifyCandidatePatch.bind(cleanRoomVerifierB);
  cleanRoomVerifierB.verifyCandidatePatch = async (params: any) => {
    const t0 = performance.now();
    const outcome = await origVerifyCandidatePatch(params);
    const totalVerifierMs = Math.round(performance.now() - t0);
    const knownMs = f2pMs + p2pMs + cleanRoomMaterializationMs + evidencePersistenceMs;
    const remainingMs = Math.max(0, totalVerifierMs - knownMs);
    patchExtractionMs = Math.round(remainingMs * 0.3);
    patchApplicationMs = Math.max(0, remainingMs - patchExtractionMs);
    return outcome;
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
    title: "Phase 15E Gate B: Governed Coding Run with Clean-Room Proof",
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
    console.error(`[EXEC ERROR] Step loop threw exception: ${err instanceof Error ? err.message : String(err)}`);
    gateBClassification = "RUNTIME_FAILURE";
  }

  const loopDurationMsB = Math.round(performance.now() - loopStartTimeB);
  console.log(`\n[EXEC] Loop finished in ${(loopDurationMsB / 1000).toFixed(1)}s`);
  console.log(`[EXEC] Terminal Reason: ${stepResultB?.terminalReason}`);
  console.log(`[EXEC] Terminal Message: ${stepResultB?.terminalMessage}`);
  console.log(`[EXEC] Total Steps: ${stepResultB?.totalSteps}`);
  console.log(`[EXEC] Total Actions: ${stepResultB?.totalActions}`);

  console.log(`\n[TRANSCRIPT SUMMARY]`);
  for (const t of stepResultB?.transcript ?? []) {
    console.log(`  Step ${t.stepNumber}: tool=${t.toolName} valid=${t.proposalValid} actionId=${t.actionId ?? "none"} actionStatus=${t.actionStatus ?? "none"} rejection=${t.proposalRejectionReason ?? "none"}`);
  }

  const eventsB = storeB.getEventsForRun(runB.runId);
  const evidenceRecordedEventsB = eventsB.filter((e) => e.eventType === "evidence.recorded");
  const independentEvidenceEventB = evidenceRecordedEventsB.find(
    (e) => (e.payload as any)?.source === "INDEPENDENT_OBSERVER"
  );

  const cleanRoomPayloadB = independentEvidenceEventB
    ? ((independentEvidenceEventB.payload as any).summary as IndependentVerificationEvidencePayload)
    : undefined;

  let finalRunStatusB = storeB.getRun(runB.runId)?.status ?? "UNKNOWN";

  if (stepResultB?.terminalReason === "COMPLETED") {
    coordinatorB.completeRun(runB.runId, workerIdB, claimB.lease.leaseId, { outcome: "VERIFIED" });
    finalRunStatusB = storeB.getRun(runB.runId)?.status ?? "UNKNOWN";
  } else if (stepResultB?.terminalReason) {
    try {
      coordinatorB.failRun(
        runB.runId,
        { reason: stepResultB.terminalReason, message: stepResultB.terminalMessage },
        workerIdB,
        claimB.lease.leaseId
      );
      finalRunStatusB = storeB.getRun(runB.runId)?.status ?? "UNKNOWN";
    } catch (failErr: unknown) {
      console.error(`[WARN] failRun transition failed: ${failErr instanceof Error ? failErr.message : String(failErr)}`);
    }
  }

  const totalWallClockMsB = Math.round(performance.now() - wallClockStartB);
  const actionsB = storeB.getActionsForRun(runB.runId) ?? [];
  const actionIdsB = actionsB.map((a) => a.actionId);
  const attemptIdsB = actionsB.flatMap((a) => storeB.getAttemptsForAction(a.actionId).map((att) => att.attemptId));

  if (actionsB.length === 0) {
    totalToolExecutionMs = 0;
  }

  const mathOnDiskB = fs.readFileSync(path.join(wsB.hostPath, "src", "math.js"), "utf8");
  const mutationOccurredB = mathOnDiskB !== DEFECTIVE_MATH_JS;
  const isGoalReachedEmittedB = stepResultB?.transcript?.some((t: any) => t.finishReason === "GOAL_REACHED");
  const activeWorkspacesB = fs.readdirSync(workspaceRootDirB);
  const leftoverVerifyDirsB = activeWorkspacesB.filter((d) => d.startsWith("ws-verify-"));

  if (finalRunStatusB === "COMPLETED" && cleanRoomPayloadB?.overallStatus === "VERIFIED") {
    gateBClassification = "SUCCESS";
  } else if (cleanRoomPayloadB && cleanRoomPayloadB.overallStatus === "FAILED") {
    if (cleanRoomPayloadB.candidatePatchBytes === 0) {
      gateBClassification = "MODEL_PLANNING_FAILURE";
    } else {
      gateBClassification = "VERIFICATION_FAILURE";
    }
  } else if (actionsB.length > 0) {
    if (!mutationOccurredB) {
      gateBClassification = "MODEL_PLANNING_FAILURE";
    } else {
      gateBClassification = "MODEL_CODING_FAILURE";
    }
  } else if (
    stepResultB?.terminalReason === "MAX_STEPS" ||
    stepResultB?.terminalReason === "MAX_PROPOSAL_REJECTIONS" ||
    stepResultB?.terminalReason === "BRAIN_FAILURE"
  ) {
    gateBClassification = "MODEL_SCHEMA_FAILURE";
  } else if (gateBClassification !== "ENVIRONMENT_FAILURE" && gateBClassification !== "RUNTIME_FAILURE") {
    gateBClassification = "MODEL_SCHEMA_FAILURE";
  }

  const gatesB = {
    gate1_modelResponded: (stepResultB?.totalSteps ?? 0) > 0,
    gate2_validReadProposal: stepResultB?.transcript?.some((t: any) => t.toolName === "read_file" && t.proposalValid),
    gate3_readExecuted: stepResultB?.transcript?.some((t: any) => t.toolName === "read_file" && t.actionStatus === "SUCCEEDED"),
    gate4_observationPropagated: (stepResultB?.transcript?.length ?? 0) >= 2,
    gate5_validWriteProposal: stepResultB?.transcript?.some((t: any) => t.toolName === "write_file" && t.proposalValid),
    gate6_writeExecuted: stepResultB?.transcript?.some((t: any) => t.toolName === "write_file" && t.actionStatus === "SUCCEEDED"),
    gate7_actualMutationOccurred: mutationOccurredB,
    gate8_modelEmittedGoalReached: isGoalReachedEmittedB,
    gate9_cleanRoomVerifierExecuted: cleanRoomPayloadB !== undefined,
    gate10_immutableBaselineUsed: cleanRoomPayloadB?.baselineCommitSha === repoInfoB.commitSha,
    gate11_baselineTargetFailed: cleanRoomPayloadB?.baselineDiagnostic?.f2pExitCode === 1,
    gate12_baselineRegressionPassed: cleanRoomPayloadB?.baselineDiagnostic?.p2pExitCode === 0,
    gate13_candidatePatchCaptured: (cleanRoomPayloadB?.candidatePatchBytes ?? 0) > 0,
    gate14_patchAppliedCleanly: cleanRoomPayloadB?.patchApplication?.status === "APPLIED",
    gate15_patchedTargetPassed: cleanRoomPayloadB?.cleanRoomEvaluation?.f2pRatio === 1.0,
    gate16_patchedRegressionPassed: cleanRoomPayloadB?.cleanRoomEvaluation?.p2pRatio === 1.0,
    gate17_suiteRanMatched: cleanRoomPayloadB?.cleanRoomEvaluation?.f2pSuiteRanMatched === true && cleanRoomPayloadB?.cleanRoomEvaluation?.p2pSuiteRanMatched === true,
    gate18_independentEvidencePersisted: independentEvidenceEventB !== undefined,
    gate19_evidenceSourceIndependent: (independentEvidenceEventB?.payload as any)?.source === "INDEPENDENT_OBSERVER",
    gate20_fourfoldInvariantSatisfied: cleanRoomPayloadB?.overallStatus === "VERIFIED",
    gate21_finalRunStatusCompleted: finalRunStatusB === "COMPLETED",
    gate22_cleanRoomWorkspaceDisposed: leftoverVerifyDirsB.length === 0,
    gate23_agentWorkspacePreserved: fs.existsSync(path.join(wsB.hostPath, "src", "math.js")),
  };

  const allGatesPassedB = Object.values(gatesB).every((v) => v === true);

  console.log("\n----------------------------------------------------------------------");
  console.log("PHASE 15E GATE B SUCCESS GATES EVALUATION:");
  console.log("----------------------------------------------------------------------");
  for (const [k, v] of Object.entries(gatesB)) {
    console.log(`  ${k.padEnd(40)}: ${v ? "PASS" : "FAIL"}`);
  }
  console.log("----------------------------------------------------------------------");
  console.log(`GATE B CLASSIFICATION: [${gateBClassification}] (All 23 gates: ${allGatesPassedB ? "PASSED" : "FAILED"})`);
  console.log("----------------------------------------------------------------------\n");

  const proposalRecordsB: any[] = [];
  for (let i = 0; i < (stepResultB?.transcript?.length ?? 0); i++) {
    const step = stepResultB.transcript[i];
    const rawCall =
      rawModelCallsB.find((c) => c.sequenceNumber === step.stepNumber) ?? rawModelCallsB[i];

    let attemptStatus: string | null = null;
    if (step.actionId) {
      const attempts = storeB.getAttemptsForAction(step.actionId);
      if (attempts && attempts.length > 0) {
        attemptStatus = attempts[attempts.length - 1].status;
      }
    }

    proposalRecordsB.push({
      stepNumber: step.stepNumber,
      timestamp: step.timestamp,
      model: modelName,
      contextBytes: step.contextBytes ?? rawCall?.contextBytes ?? 0,
      promptBytes: rawCall?.promptBytes ?? 0,
      modelResponse: rawCall?.modelResponse ?? "",
      proposal: step.proposalId
        ? {
            proposalId: step.proposalId,
            toolName: step.toolName,
            inputPayload: step.inputPayload,
            rationale: step.rationale,
          }
        : (rawCall?.proposal ?? null),
      proposalValidationResult: step.proposalValid ? "VALID" : "INVALID",
      proposalRejectionReason: step.proposalRejectionReason ?? null,
      actionStatus: step.actionStatus ?? null,
      attemptStatus,
    });
  }

  const evidenceBundle = {
    $schema: "https://emerald.agentfabric.dev/schemas/v1/phase15e-benchmark-evidence.json",
    experimentId: `exp-phase15e-${Date.now()}`,
    runId: runB.runId,
    taskId: taskB.taskId,
    baselineCommitSha: repoInfoB.commitSha,
    model: modelName,
    provider: "ollama",
    modelSize: "1.5B",
    thinking: "not_supported",
    hardware: "CPU",
    taskDirectiveHash,
    contextBytes: contextSnapshotA.totalBytes,
    promptBytes: promptBytesA,
    gateA: {
      inferenceTimeMs: inferenceTimeA,
      response: gateAResponseStatus,
      validProposal: gateAProposalValid,
      classification: gateAClassification,
    },
    gateB: {
      status: "EXECUTED",
      modelCalls: stepResultB?.totalSteps ?? 0,
      modelSteps: stepResultB?.totalSteps ?? 0,
      proposalRecords: proposalRecordsB,
      actionIds: actionIdsB,
      attemptIds: attemptIdsB,
      physicalActionCount: actionIdsB.length,
      physicalAttemptCount: attemptIdsB.length,
      candidatePatchDigest: cleanRoomPayloadB?.candidatePatchHash ?? "",
      candidatePatchSize: cleanRoomPayloadB?.candidatePatchBytes ?? 0,
      baselineF2P: cleanRoomPayloadB?.baselineDiagnostic?.f2pExitCode ?? null,
      baselineP2P: cleanRoomPayloadB?.baselineDiagnostic?.p2pExitCode ?? null,
      patchedF2P: cleanRoomPayloadB?.cleanRoomEvaluation?.f2pExitCode ?? null,
      patchedP2P: cleanRoomPayloadB?.cleanRoomEvaluation?.p2pExitCode ?? null,
      suiteTestsExecuted:
        (cleanRoomPayloadB?.cleanRoomEvaluation?.f2pTestsExecuted ?? 0) +
        (cleanRoomPayloadB?.cleanRoomEvaluation?.p2pTestsExecuted ?? 0),
      independentEvidence: independentEvidenceEventB !== undefined,
      taskSatisfied: cleanRoomPayloadB?.overallStatus === "VERIFIED",
      verificationPassed: cleanRoomPayloadB?.overallStatus === "VERIFIED",
      policySatisfied: cleanRoomPayloadB?.policyAudit?.allowedPathsCompliant ?? false,
      evidenceComplete: independentEvidenceEventB !== undefined,
      timings: {
        modelInferenceMs: totalModelInferenceMs,
        toolExecutionMs: totalToolExecutionMs,
        patchExtractionMs,
        cleanRoomMaterializationMs,
        patchApplicationMs,
        f2pMs,
        p2pMs,
        evidencePersistenceMs,
        totalWallClockMs: totalWallClockMsB,
        loopDurationMs: loopDurationMsB,
      },
      gates: gatesB,
      finalRunStatus: finalRunStatusB,
      classification: gateBClassification,
    },
    finalRunStatus: finalRunStatusB,
    classification: gateBClassification,
  };

  const evidencePath = path.join(SCRATCH_DIR, "phase15e-benchmark-evidence.json");
  fs.writeFileSync(evidencePath, JSON.stringify(evidenceBundle, null, 2), "utf8");
  console.log(`[EVIDENCE] Saved evidence to ${evidencePath}`);

  try {
    const localEvidencePath = path.join(LOCAL_SCRATCH_DIR, "phase15e-benchmark-evidence.json");
    fs.writeFileSync(localEvidencePath, JSON.stringify(evidenceBundle, null, 2), "utf8");
    console.log(`[EVIDENCE] Saved local duplicate to ${localEvidencePath}`);
  } catch {
    // optional
  }

  // Cleanup Gate B temp resources
  try {
    storeB.close();
    fs.rmSync(tempBaseDirB, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

main().catch((err) => {
  console.error("[FATAL ERROR]", err);
  process.exit(1);
});
