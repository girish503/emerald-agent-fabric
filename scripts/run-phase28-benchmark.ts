/**
 * Phase 28 — SmolLM2 1.7B Controlled Recovery Experiment.
 * Target Model: smollm2:1.7b (Local CPU via Ollama)
 *
 * Invariants & Governance:
 * - Emerald architecture, ports, adapters, domain, and application layers remain FROZEN.
 * - Project constraint: ₹0-cost, open-source / open-weight models ONLY.
 * - Zero proprietary / cloud APIs (OpenAI, Anthropic, Gemini strictly rejected).
 * - Target Model: smollm2:1.7b (Digest: cef4a1e09247, Q8_0, 1.7B, CPU at ₹0).
 * - Standardized task: src/math.js repair (hash 649544ffe153f3ec8ecb2d40c8c35788d03398b08ed525417f9507a6e41c9c58).
 * - Gate A: 120,000 ms ceiling (single Step 1 request).
 * - Gate B-D: Full governed coding loop executed ONLY if Gate A passes.
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
import {
  createMissionContract,
  createResourceLimits,
  MissionContract,
} from "../src/domain/mission-contract.js";
import { ExecutionPolicy } from "../src/domain/policy.js";
import { VerificationSpec } from "../src/domain/verification.js";
import { StateStorePort } from "../src/ports/state-store.port.js";

function createAndActivateContract(
  store: StateStorePort,
  taskId: string,
  options: {
    readonly contractId?: string;
    readonly version?: number;
    readonly policy?: ExecutionPolicy;
    readonly verificationSpecs?: readonly VerificationSpec[];
    readonly timeoutMs?: number;
    readonly maxAttempts?: number;
    readonly maxOutputBytes?: number;
    readonly scopes?: readonly string[];
  } = {}
): MissionContract {
  const contractId = options.contractId ?? `contract-${taskId}`;
  const version = options.version ?? 1;
  const timeoutMs = options.timeoutMs ?? 30000;
  const maxAttempts = options.maxAttempts ?? 3;
  const maxOutputBytes = options.maxOutputBytes ?? 1048576;
  const scopes = options.scopes ?? ["test:scope"];
  const policy = options.policy ?? createExecutionPolicy({
    policyId: `policy-${taskId}`,
    allowedCapabilities: ["process.execute"],
    isolationRequirement: "NONE",
  });
  const verificationSpecs = options.verificationSpecs ? [...options.verificationSpecs] : [];

  const contract = createMissionContract({
    contractId,
    version,
    taskId,
    policy,
    verificationSpecs,
    resourceLimits: createResourceLimits({
      timeoutMs,
      maxAttempts,
      maxOutputBytes,
    }),
    credentialScopes: scopes,
  });

  store.insertContract(contract);
  return store.activateContract(contractId, version);
}


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
          res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          res.on("end", () => {
            const bodyBuffer = Buffer.concat(chunks);
            const response = new Response(bodyBuffer, {
              status: res.statusCode || 200,
              statusText: res.statusMessage || "",
              headers: res.headers as unknown as HeadersInit,
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
// 4. Markdown Report Generator Helper
// ============================================================================

function generateMarkdownReport(results: any): string {
  const compRows = results.comparison
    .map(
      (c: any) =>
        `| \`${c.model}\` | ${c.params} | ${c.gateALatency} | ${c.initialProposal} | ${c.mutation} | ${c.recovery} | ${c.verification} | \`${c.finalStatus}\` |`
    )
    .join("\n");

  return `# Phase 28: SmolLM2 1.7B Controlled Recovery Experiment Report

## Executive Summary

- **Phase**: 28
- **Timestamp**: ${results.timestamp}
- **Baseline Git SHA**: \`${results.baseline}\`
- **Project Policy**: **₹0-cost, open-source / open-weight models ONLY.**
- **Evaluated Model**: \`${results.model.name}\` (${results.model.parameters}, ${results.model.quantization}, ${results.model.size})
- **Model Digest**: \`${results.model.digest}\`
- **Gate A Outcome**: **${results.gateA.classification}** (${(results.gateA.inferenceDurationMs / 1000).toFixed(1)}s)
- **Capability Level Reached**: **${results.capabilityLevel.level}** (${results.capabilityLevel.description})
- **Primary Failure Classification**: **\`${results.failureClassification.primary}\`**
- **Secondary Failures**: ${results.failureClassification.secondary.length > 0 ? results.failureClassification.secondary.join(", ") : "None"}

---

## 1. Experimental Result

SmolLM2-1.7B was evaluated under Emerald's frozen architecture to test whether synthetic multi-turn tool-calling and alignment SFT allows a sub-2B model to achieve closed-loop recovery after validator rejection.

- **Gate A Latency**: ${(results.gateA.inferenceDurationMs / 1000).toFixed(1)}s (Operational ceiling: 120.0s)
- **Gate A Classification**: \`${results.gateA.classification}\`
- **Gate B Status**: \`${results.gateB.status}\`
- **Physical Code Mutation Occurred**: ${results.coding.physicalMutationOccurred ? "YES" : "NO"}
- **Correct Math Repair**: ${results.coding.correctMathRepair ? "YES" : "NO"}
- **Clean-Room Verification**: ${results.verification.cleanRoomVerified ? "PASSED" : (results.verification.cleanRoomReached ? "FAILED" : "NOT REACHED")}

---

## 2. Gate A

| Metric | Measured Value | Threshold / Standard | Status |
| :--- | :--- | :--- | :--- |
| **Response Latency** | **${results.gateA.inferenceDurationMs} ms (${(results.gateA.inferenceDurationMs / 1000).toFixed(1)}s)** | 120,000 ms | ${results.gateA.inferenceDurationMs <= 120000 ? "PASS" : "FAIL"} |
| **Response Status** | \`${results.gateA.responseStatus}\` | \`RECEIVED\` | ${results.gateA.responseStatus === "RECEIVED" ? "PASS" : "FAIL"} |
| **Raw Response Bytes** | ${results.gateA.responseBytes} bytes | >0 bytes | ${results.gateA.responseBytes > 0 ? "PASS" : "FAIL"} |
| **Selected Tool** | \`${results.gateA.selectedTool ?? "None"}\` | Valid registered tool | ${results.gateA.proposalValid ? "PASS" : "FAIL"} |
| **Proposal Validity** | \`${results.gateA.proposalValid}\` | \`true\` | ${results.gateA.proposalValid ? "PASS" : "FAIL"} |
| **Validation Reason** | \`${results.gateA.rejectionReason ?? "NONE"}\` | \`NONE\` | ${results.gateA.proposalValid ? "PASS" : "FAIL"} |
| **Gate A Classification** | **\`${results.gateA.classification}\`** | \`INFERENCE_VALIDATED\` | ${results.gateA.classification === "INFERENCE_VALIDATED" ? "PASS" : "FAIL"} |

---

## 3. Capability Level

- **Assigned Level**: **${results.capabilityLevel.level}**
- **Description**: ${results.capabilityLevel.description}

---

## 4. Tool Argument Grounding

- **Inspected Before Edit**: ${results.toolGrounding.inspectedBeforeEdit ? "YES (`read_file` called first)" : "NO"}
- **Used \`path\` Not \`filePath\`**: ${results.toolGrounding.usedPathNotFilePath ? "YES" : "NO"}
- **Preserved Argument Names**: ${results.toolGrounding.preservedArgumentNames ? "YES" : "NO"}
- **Respected Integer Bounds**: ${results.toolGrounding.respectedIntegerBounds ? "YES" : "NO"}
- **Notes**: ${results.toolGrounding.groundingNotes}

---

## 5. Observation vs Input Separation

- **Treated Metadata As Input (\`contentHash\` leakage)**: ${results.stateTracking.treatedMetadataAsInput ? "YES (FAILED)" : "NO (PASSED)"}
- **State Notes**: ${results.stateTracking.observationNotes}

---

## 6. Recovery Result

- **Total Rejections**: ${results.recovery.totalRejections}
- **Recovery Attempts**: ${results.recovery.recoveryAttempts}
- **Successful Recovery Events**: **${results.recovery.successfulRecoveryEvents}**
- **Repeated Proposal Count**: ${results.recovery.repeatedProposalCount}
- **Distinct Corrective Proposal Count**: ${results.recovery.distinctCorrectiveProposalCount}
- **Recovery Status**: ${results.recovery.notes}

---

## 7. Coding Result

- **Physical Mutation Occurred**: ${results.coding.physicalMutationOccurred ? "YES" : "NO"}
- **Correct Math Repair (\`a + b\`)**: ${results.coding.correctMathRepair ? "YES" : "NO"}
- **Preserved Multiply Function**: ${results.coding.preservedMultiply ? "YES" : "NO"}
- **Candidate Patch Snippet**:
\`\`\`javascript
${results.coding.patchSnippet ?? "// No code patch generated"}
\`\`\`

---

## 8. Independent Verification

- **Clean-Room Reached**: ${results.verification.cleanRoomReached ? "YES" : "NO"}
- **Clean-Room Verified**: ${results.verification.cleanRoomVerified ? "YES" : "NO"}
- **FAIL_TO_PASS Rate**: ${results.verification.failToPass ?? "N/A"}
- **PASS_TO_PASS Rate**: ${results.verification.passToPass ?? "N/A"}
- **Fourfold Completion Passed**: ${results.verification.fourfoldPassed ? "YES" : "NO"}

---

## 9. Hypothesis Evaluation

| Hypothesis | Expected Prediction | Classification | Measured Evidence |
| :--- | :--- | :--- | :--- |
| **H1 — CPU FEASIBILITY** | Valid proposal $\le 120$s | **\`${results.hypotheses.H1}\`** | Gate A completed in ${(results.gateA.inferenceDurationMs / 1000).toFixed(1)}s. |
| **H2 — TOOL GROUNDING** | Valid multi-step arguments | **\`${results.hypotheses.H2}\`** | Argument validity across turns: ${results.toolGrounding.groundingNotes}. |
| **H3 — RECOVERY** | Rejection $\rightarrow$ Differentiated valid proposal | **\`${results.hypotheses.H3}\`** | Recovery successes: ${results.recovery.successfulRecoveryEvents}. |
| **H4 — STATE DISTINCTION** | Separates tool output from input | **\`${results.hypotheses.H4}\`** | Metadata leakage: ${results.stateTracking.treatedMetadataAsInput}. |
| **H5 — CODE REPAIR** | Correct arithmetic repair | **\`${results.hypotheses.H5}\`** | Mutation: ${results.coding.physicalMutationOccurred}, Repair: ${results.coding.correctMathRepair}. |
| **H6 — END-TO-END GOVERNED EXECUTION** | Clean-room verification & fourfold pass | **\`${results.hypotheses.H6}\`** | Verification passed: ${results.verification.cleanRoomVerified}. |

---

## 10. Comparison With Previous Models

| Model | Parameters | Gate A Latency | Initial Proposal | Physical Mutation | Recovery | Verification | Final Status |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
${compRows}

---

## 11. Primary Failure Classification

- **Primary Classification**: **\`${results.failureClassification.primary}\`**
- **Description**: ${results.failureClassification.primaryDescription}
- **Secondary Classifications**: ${results.failureClassification.secondary.length > 0 ? results.failureClassification.secondary.join(", ") : "None"}

---

## 12. Scientific Conclusion

${results.scientificConclusion}

---

## 13. Phase 29 Recommendation

${results.nextRecommendation}
`;
}

// ============================================================================
// 5. Main Benchmark Execution
// ============================================================================

async function main(): Promise<void> {
  console.log("======================================================================");
  console.log("EMERALD AGENT FABRIC — PHASE 28 CONTROLLED RECOVERY EXPERIMENT");
  console.log("Target Model: smollm2:1.7b (HuggingFaceTB/SmolLM2-1.7B-Instruct)");
  console.log("======================================================================");

  verifyHistoricalArtifactsPreserved();

  const baseUrl = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  const modelName = "smollm2:1.7b";
  const GATE_A_TIMEOUT_MS = 120_000;

  // Preflight check
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

  console.log(`[PREFLIGHT] Task Directive SHA-256: ${taskDirectiveHash}`);
  if (taskDirectiveHash !== "649544ffe153f3ec8ecb2d40c8c35788d03398b08ed525417f9507a6e41c9c58") {
    console.error(
      `[FATAL] Task directive hash mismatch! Expected 649544ffe153f3ec8ecb2d40c8c35788d03398b08ed525417f9507a6e41c9c58, got ${taskDirectiveHash}`
    );
    process.exit(1);
  }

  const modelMetadata = {
    name: modelName,
    digest: "cef4a1e09247f018ca0c482ad4c2ce1474aba5e87f245dacf97f07948d05d8b4",
    parameters: "1.7B",
    quantization: "Q8_0",
    size: "1.82 GB (1,820,428,533 bytes)",
    architecture: "llama",
    contextLength: 8192,
    license: "Apache License 2.0 (Permissive open-source, ₹0 cost)",
    category: "Synthetic multi-turn tool-calling open-weight model",
    provider: "ollama (local)",
  };

  const hardwareTelemetry = {
    cpu: "Intel Core i3-N305 (8 physical/logical E-cores, AVX2)",
    ramTotalMb: 7813,
    ramFreeMb: 1441,
    gpu: "Intel UHD Graphics (integrated, CPU-only execution)",
    ollamaVersion: "0.40.6",
    freeDiskGb: 191.87,
  };

  // Historical comparisons
  const historicalComparisons = [
    {
      model: "gemma3:1b",
      params: "~1B",
      gateALatency: "57.4s",
      initialProposal: "Premature GOAL_REACHED",
      mutation: "No",
      recovery: "No",
      verification: "Failed",
      finalStatus: "MODEL_SCHEMA_FAILURE",
    },
    {
      model: "qwen2.5:1.5b",
      params: "~1.5B",
      gateALatency: "69.4s",
      initialProposal: "write_file",
      mutation: "Yes",
      recovery: "No (6 rejections)",
      verification: "Not reached",
      finalStatus: "MODEL_RECOVERY_FAILURE",
    },
    {
      model: "qwen2.5-coder:1.5b",
      params: "~1.5B",
      gateALatency: "64.4s",
      initialProposal: "read_file",
      mutation: "No",
      recovery: "No (6 rejections)",
      verification: "Not reached",
      finalStatus: "MODEL_RECOVERY_FAILURE",
    },
    {
      model: "granite3-dense:2b",
      params: "~2.6B",
      gateALatency: "120.1s (timeout)",
      initialProposal: "None (timeout)",
      mutation: "No",
      recovery: "No",
      verification: "Not reached",
      finalStatus: "ENVIRONMENT_FAILURE",
    },
  ];

  // ==========================================================================
  // GATE A — INITIAL PROPOSAL (Single Step 1 Request, 120s Timeout)
  // ==========================================================================
  console.log("\n----------------------------------------------------------------------");
  console.log("GATE A — INITIAL PROPOSAL (Single Step 1 Request, 120s Timeout)");
  console.log("----------------------------------------------------------------------");

  const tempBaseDirA = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-phase28-gateA-"));
  const storeA = new SqliteStateStore();
  const clockA = new SystemClock();
  const coordinatorA = new RunCoordinator(storeA, clockA);
  const workerIdA = "worker-phase28-gateA";

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
    title: "Phase 28 Gate A: smollm2:1.7b Initial Proposal",
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

  let gateAClassification:
    | "INFERENCE_VALIDATED"
    | "MODEL_SCHEMA_FAILURE"
    | "ENVIRONMENT_FAILURE" = "ENVIRONMENT_FAILURE";
  let gateAProposalValid = false;
  let gateAResponseStatus = "ERROR";
  let gateARawOutput: string | null = null;
  let gateAProposal: any = null;
  let gateAValidationReason: string | null = null;
  let isPrematureGoalReached = false;
  let responseBytesA = 0;

  if (brainResultA) {
    gateAResponseStatus = "RECEIVED";
    gateARawOutput = brainResultA.rawOutput ?? null;
    responseBytesA = gateARawOutput ? Buffer.byteLength(gateARawOutput, "utf8") : 0;
    console.log(`[GATE A] Raw Output (${responseBytesA} bytes):\n${brainResultA.rawOutput}`);

    if (brainResultA.proposal) {
      gateAProposal = brainResultA.proposal;
      console.log(`[GATE A] Parsed Proposal:\n${JSON.stringify(brainResultA.proposal, null, 2)}`);

      if (gateAProposal.isGoalReached === true) {
        isPrematureGoalReached = true;
        console.warn("[GATE A WARNING] Model emitted premature isGoalReached: true without prior physical actions.");
        gateAClassification = "MODEL_SCHEMA_FAILURE";
        gateAValidationReason = "PREMATURE_GOAL_REACHED";
      } else {
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
    gateAValidationReason = "CPU_INFERENCE_LATENCY_BOUNDARY";
  }

  console.log(`[GATE A RESULT] ${gateAClassification}`);

  // Cleanup Gate A temporary store
  try {
    storeA.close();
    fs.rmSync(tempBaseDirA, { recursive: true, force: true });
  } catch {
    // ignore
  }

  // If Gate A failed, record evidence and STOP per Section 8
  if (gateAClassification !== "INFERENCE_VALIDATED") {
    console.log("\n[STOP] Gate A failed. Halting before Gate B per Section 8 stop conditions.");

    const primaryFailure = gateAClassification === "ENVIRONMENT_FAILURE"
      ? "ENVIRONMENT_FAILURE"
      : "MODEL_SCHEMA_FAILURE";
    const primaryDesc = gateAClassification === "ENVIRONMENT_FAILURE"
      ? "SmolLM2-1.7B inference exceeded the 120,000ms CPU feasibility boundary on the Intel i3-N305."
      : `SmolLM2-1.7B failed proposal schema validation: ${gateAValidationReason ?? "MALFORMED_OUTPUT"}`;

    const smollm2Comparison = {
      model: "SmolLM2 1.7B",
      params: "1.7B",
      gateALatency: `${(inferenceTimeA / 1000).toFixed(1)}s`,
      initialProposal: gateAProposal ? gateAProposal.toolName ?? "Invalid" : "None",
      mutation: "No",
      recovery: "No",
      verification: "Not reached",
      finalStatus: primaryFailure,
    };

    const resultsPayload = {
      phase: "28",
      timestamp: new Date().toISOString(),
      baseline: "70979cf4bcbf4a237b79af3a23449a4b932104d5",
      taskHash: "649544ffe153f3ec8ecb2d40c8c35788d03398b08ed525417f9507a6e41c9c58",
      model: modelMetadata,
      hardware: hardwareTelemetry,
      capabilityLevel: {
        level: "LEVEL 0",
        description: "No valid initial proposal within latency boundary.",
      },
      gateA: {
        inferenceDurationMs: inferenceTimeA,
        responseStatus: gateAResponseStatus,
        responseBytes: responseBytesA,
        promptBytes: promptBytesA,
        contextBytes: contextSnapshotA.totalBytes,
        proposalValid: gateAProposalValid,
        selectedTool: gateAProposal?.toolName ?? null,
        rejectionReason: gateAValidationReason,
        classification: gateAClassification,
        rawModelResponse: gateARawOutput,
        proposal: gateAProposal,
      },
      gateB: { status: "NOT_RUN" },
      toolGrounding: {
        inspectedBeforeEdit: false,
        usedPathNotFilePath: false,
        preservedArgumentNames: false,
        respectedIntegerBounds: false,
        groundingNotes: "Gate A failed.",
      },
      recovery: {
        totalRejections: 0,
        recoveryAttempts: 0,
        successfulRecoveryEvents: 0,
        repeatedProposalCount: 0,
        distinctCorrectiveProposalCount: 0,
        notes: "Gate B was not executed because Gate A failed.",
      },
      stateTracking: {
        treatedMetadataAsInput: false,
        observationNotes: "No observation generated.",
      },
      coding: {
        physicalMutationOccurred: false,
        correctMathRepair: false,
        preservedMultiply: false,
        patchSnippet: null,
      },
      verification: {
        cleanRoomReached: false,
        cleanRoomVerified: false,
        failToPass: null,
        passToPass: null,
        fourfoldPassed: false,
      },
      hypotheses: {
        H1: gateAClassification === "ENVIRONMENT_FAILURE" ? "NOT_SUPPORTED" : "SUPPORTED",
        H2: "NOT_TESTABLE",
        H3: "NOT_TESTABLE",
        H4: "NOT_TESTABLE",
        H5: "NOT_TESTABLE",
        H6: "NOT_SUPPORTED",
      },
      failureClassification: {
        primary: primaryFailure,
        primaryDescription: primaryDesc,
        secondary: [],
      },
      comparison: [...historicalComparisons, smollm2Comparison],
      scientificConclusion: `SmolLM2-1.7B evaluated at 1.7B parameters failed Gate A feasibility with classification ${primaryFailure} (${(inferenceTimeA / 1000).toFixed(1)}s). The model could not produce a valid initial action proposal within the 120s feasibility ceiling on the Intel Core i3-N305.`,
      nextRecommendation: "Reassess whether Q8_0 quantization level is responsible for CPU latency or evaluate an alternative sub-2B candidate.",
    };

    const jsonPath = path.join(LOCAL_SCRATCH_DIR, "phase28-smollm2-results.json");
    fs.writeFileSync(jsonPath, JSON.stringify(resultsPayload, null, 2), "utf8");
    const mdPath = path.join(LOCAL_SCRATCH_DIR, "phase28-smollm2-report.md");
    fs.writeFileSync(mdPath, generateMarkdownReport(resultsPayload), "utf8");

    console.log(`[EVIDENCE] Saved Phase 28 results to ${jsonPath} and ${mdPath}`);
    return;
  }

  // ==========================================================================
  // GATE B — FULL GOVERNED LOOP (AgentStepController + CleanRoomVerifier)
  // ==========================================================================
  console.log("\n----------------------------------------------------------------------");
  console.log("GATE B — FULL GOVERNED LOOP (AgentStepController + CleanRoomVerifier)");
  console.log("----------------------------------------------------------------------");

  const wallClockStartB = performance.now();
  const tempBaseDirB = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-phase28-gateB-"));
  const workspaceRootDirB = path.join(tempBaseDirB, "workspaces");
  fs.mkdirSync(workspaceRootDirB, { recursive: true });

  const storeB = new SqliteStateStore();
  const clockB = new SystemClock();
  const workspaceAdapterB = new NodeFsWorkspaceAdapter({ workspaceRoot: workspaceRootDirB });
  const coordinatorB = new RunCoordinator(storeB, clockB);
  const executionProviderB = new DockerExecutionProvider();

  const workerIdB = "worker-phase28-live";
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
    title: "Phase 28 Gate B: smollm2:1.7b Governed Loop",
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

  // Recovery analysis
  let totalRejections = 0;
  let recoveryAttempts = 0;
  let successfulRecoveryEvents = 0;
  let repeatedProposalCount = 0;
  let distinctCorrectiveProposalCount = 0;

  for (let i = 0; i < enrichedRecords.length; i++) {
    const current = enrichedRecords[i];
    if (!current.proposalValid) {
      totalRejections++;
      if (i + 1 < enrichedRecords.length) {
        recoveryAttempts++;
        const next = enrichedRecords[i + 1];
        const isIdentical =
          JSON.stringify(current.proposal?.inputPayload) ===
          JSON.stringify(next.proposal?.inputPayload);

        if (isIdentical) {
          repeatedProposalCount++;
        } else {
          distinctCorrectiveProposalCount++;
        }

        if (next.proposalValid && !isIdentical) {
          successfulRecoveryEvents++;
        }
      }
    }
  }

  // Tool argument grounding & observation analysis
  const inspectedBeforeEdit = enrichedRecords.some(
    (r, idx) => r.proposal?.toolName === "read_file" && r.proposalValid && idx === 0
  );
  const usedPathNotFilePath = enrichedRecords.some(
    (r) => r.proposal?.inputPayload && "path" in r.proposal.inputPayload && !("filePath" in r.proposal.inputPayload)
  );
  const preservedArgumentNames = !enrichedRecords.some(
    (r) => r.proposal?.inputPayload && "filePath" in r.proposal.inputPayload
  );
  const respectedIntegerBounds = !enrichedRecords.some(
    (r) => r.proposal?.inputPayload?.offsetLine === 0 || r.proposal?.inputPayload?.limitLines === 0
  );
  const treatedMetadataAsInput = enrichedRecords.some((r) => r.hasContentHashInput);

  const correctMathRepair = candidatePatchContent.includes("a + b") && !candidatePatchContent.includes("a - b");
  const preservedMultiply = candidatePatchContent.includes("multiply") && candidatePatchContent.includes("a * b");

  // Determine Success Level (0 through 6)
  let capabilityLevel = {
    level: "LEVEL 1",
    description: "Valid structured proposal.",
  };
  if (finalStatus === "COMPLETED" && cleanRoomOutcome?.verified) {
    capabilityLevel = {
      level: "LEVEL 6",
      description: "Complete fourfold governed success (TaskSatisfied, VerificationPassed, PolicySatisfied, EvidenceComplete).",
    };
  } else if (cleanRoomReached && cleanRoomOutcome?.verified) {
    capabilityLevel = {
      level: "LEVEL 5",
      description: "Independent clean-room verification passes.",
    };
  } else if (actualMutationOccurredB && correctMathRepair) {
    capabilityLevel = {
      level: "LEVEL 4",
      description: "Successful physical code mutation.",
    };
  } else if (successfulRecoveryEvents > 0) {
    capabilityLevel = {
      level: "LEVEL 3",
      description: "Successful recovery after validator rejection.",
    };
  } else if (physicalActionCount > 0) {
    capabilityLevel = {
      level: "LEVEL 2",
      description: "Valid physical tool execution.",
    };
  }

  // Determine Primary & Secondary Failure Classification
  let primaryFailure = "MODEL_TOOL_GROUNDING_FAILURE";
  let primaryDesc = "";
  const secondaryFailures: string[] = [];

  if (loopThrewError) {
    primaryFailure = "ENVIRONMENT_FAILURE";
    primaryDesc = "Step controller execution loop threw unhandled error.";
  } else if (finalStatus === "COMPLETED" && cleanRoomOutcome?.verified) {
    primaryFailure = "NONE (SUCCESS)";
    primaryDesc = "Mission verified and completed.";
  } else if (cleanRoomReached && !cleanRoomOutcome?.verified) {
    primaryFailure = "VERIFICATION_FAILURE";
    primaryDesc = "Clean-room verification tests failed.";
  } else if (stepResultB?.terminalReason === "MAX_PROPOSAL_REJECTIONS") {
    primaryFailure = "MODEL_RECOVERY_FAILURE";
    primaryDesc = "Model failed to recover after receiving structured rejection feedback; reached rejection ceiling (6 >= 6).";
    if (!usedPathNotFilePath) secondaryFailures.push("MODEL_TOOL_GROUNDING_FAILURE");
    if (!actualMutationOccurredB) secondaryFailures.push("MODEL_CODING_FAILURE");
  } else if (!actualMutationOccurredB) {
    primaryFailure = "MODEL_CODING_FAILURE";
    primaryDesc = "Model did not mutate the defective source file.";
  } else if (!correctMathRepair) {
    primaryFailure = "MODEL_CODING_FAILURE";
    primaryDesc = "Model modified code but failed to repair the arithmetic defect.";
  }

  // Evaluate Hypotheses
  const h1Result = inferenceTimeA <= 120000 ? "SUPPORTED" : "NOT_SUPPORTED";
  const h2Result = usedPathNotFilePath && preservedArgumentNames ? "SUPPORTED" : (enrichedRecords.length > 0 ? "PARTIALLY_SUPPORTED" : "NOT_TESTABLE");
  const h3Result = totalRejections === 0 ? "NOT_TESTABLE" : (successfulRecoveryEvents > 0 ? "SUPPORTED" : "NOT_SUPPORTED");
  const h4Result = !treatedMetadataAsInput ? "SUPPORTED" : "NOT_SUPPORTED";
  const h5Result = actualMutationOccurredB ? (correctMathRepair && preservedMultiply ? "SUPPORTED" : "NOT_SUPPORTED") : "NOT_TESTABLE";
  const h6Result = finalStatus === "COMPLETED" && cleanRoomOutcome?.verified ? "SUPPORTED" : "NOT_SUPPORTED";

  const smollm2Comparison = {
    model: "SmolLM2 1.7B",
    params: "1.7B",
    gateALatency: `${(inferenceTimeA / 1000).toFixed(1)}s`,
    initialProposal: gateAProposal ? gateAProposal.toolName ?? "Invalid" : "None",
    mutation: actualMutationOccurredB ? "Yes" : "No",
    recovery: successfulRecoveryEvents > 0 ? `Yes (${successfulRecoveryEvents})` : (totalRejections > 0 ? "No (repeated)" : "N/A"),
    verification: cleanRoomReached ? (cleanRoomOutcome?.verified ? "Passed" : "Failed") : "Not reached",
    finalStatus: primaryFailure,
  };

  const resultsPayload = {
    phase: "28",
    timestamp: new Date().toISOString(),
    baseline: "70979cf4bcbf4a237b79af3a23449a4b932104d5",
    taskHash: "649544ffe153f3ec8ecb2d40c8c35788d03398b08ed525417f9507a6e41c9c58",
    model: modelMetadata,
    hardware: hardwareTelemetry,
    capabilityLevel,
    gateA: {
      inferenceDurationMs: inferenceTimeA,
      responseStatus: gateAResponseStatus,
      responseBytes: responseBytesA,
      promptBytes: promptBytesA,
      contextBytes: contextSnapshotA.totalBytes,
      proposalValid: gateAProposalValid,
      selectedTool: gateAProposal?.toolName ?? null,
      rejectionReason: gateAValidationReason,
      classification: gateAClassification,
      rawModelResponse: gateARawOutput,
      proposal: gateAProposal,
    },
    gateB: {
      status: "EXECUTED",
      wallClockMs: loopDurationMsB,
      terminalReason: stepResultB?.terminalReason,
      terminalMessage: stepResultB?.terminalMessage,
      totalSteps: stepResultB?.totalSteps,
      totalActions: stepResultB?.totalActions,
      physicalActionCount,
    },
    toolGrounding: {
      inspectedBeforeEdit,
      usedPathNotFilePath,
      preservedArgumentNames,
      respectedIntegerBounds,
      groundingNotes: `Path preserved: ${usedPathNotFilePath}, Bounds respected: ${respectedIntegerBounds}`,
    },
    recovery: {
      totalRejections,
      recoveryAttempts,
      successfulRecoveryEvents,
      repeatedProposalCount,
      distinctCorrectiveProposalCount,
      notes: totalRejections > 0
        ? `Observed ${totalRejections} rejections with ${successfulRecoveryEvents} successful recoveries and ${repeatedProposalCount} repetitions.`
        : "RECOVERY_TRIGGER_NOT_OBSERVED",
    },
    stateTracking: {
      treatedMetadataAsInput,
      observationNotes: treatedMetadataAsInput
        ? "Model injected observation metadata (contentHash) into tool input."
        : "Model correctly avoided injecting observation metadata into tool inputs.",
    },
    coding: {
      physicalMutationOccurred: actualMutationOccurredB,
      correctMathRepair,
      preservedMultiply,
      patchSnippet: candidatePatchContent || null,
    },
    verification: {
      cleanRoomReached,
      cleanRoomVerified: Boolean(cleanRoomOutcome?.verified),
      failToPass: cleanRoomOutcome?.details?.failToPassRate ?? null,
      passToPass: cleanRoomOutcome?.details?.passToPassRate ?? null,
      fourfoldPassed: finalStatus === "COMPLETED" && Boolean(cleanRoomOutcome?.verified),
    },
    hypotheses: {
      H1: h1Result,
      H2: h2Result,
      H3: h3Result,
      H4: h4Result,
      H5: h5Result,
      H6: h6Result,
    },
    failureClassification: {
      primary: primaryFailure,
      primaryDescription: primaryDesc,
      secondary: secondaryFailures,
    },
    comparison: [...historicalComparisons, smollm2Comparison],
    scientificConclusion: `SmolLM2-1.7B demonstrated ${capabilityLevel.level} (${capabilityLevel.description}). Gate A executed in ${(inferenceTimeA / 1000).toFixed(1)}s. Full loop resulted in ${primaryFailure}.`,
    nextRecommendation: "Synthesize findings in Phase 29 to determine whether further small-model testing is warranted.",
  };

  const jsonPath = path.join(LOCAL_SCRATCH_DIR, "phase28-smollm2-results.json");
  fs.writeFileSync(jsonPath, JSON.stringify(resultsPayload, null, 2), "utf8");
  const mdPath = path.join(LOCAL_SCRATCH_DIR, "phase28-smollm2-report.md");
  fs.writeFileSync(mdPath, generateMarkdownReport(resultsPayload), "utf8");

  console.log(`[EVIDENCE] Saved Phase 28 results to ${jsonPath} and ${mdPath}`);

  // Cleanup Gate B
  try {
    storeB.close();
    fs.rmSync(tempBaseDirB, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

main().catch((err) => {
  console.error(`[FATAL] Benchmark script failed: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
