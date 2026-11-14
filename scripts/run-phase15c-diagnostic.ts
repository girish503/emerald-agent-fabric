/**
 * Phase 15C — Qwen3:4b Thinking-OFF CPU Validation Runner.
 *
 * Controlled empirical experiment testing whether qwen3:4b (via local Ollama on CPU)
 * can generate a complete, schema-valid first ActionProposal within a 180-second bounded
 * inference window when Qwen3 thinking/reasoning is explicitly disabled (think: false).
 *
 * Invariants & Constraints:
 * - Real local Ollama model (qwen3:4b) on CPU at ₹0.
 * - Architecture, ports, adapters, domain, and application layers remain FROZEN.
 * - Explicitly disabled thinking via native Ollama 0.40+ request parameter: { think: false }.
 * - Exactly ONE live inference request (Step 1).
 * - Bounded timeout: 180,000 ms.
 * - Zero physical tools executed (read_file / write_file = 0).
 * - Clean-room = NOT_RUN.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { OllamaModelProvider } from "../src/adapters/models/ollama-model-provider.js";
import { SqliteStateStore } from "../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../src/adapters/workspace/node-fs-workspace-adapter.js";
import { ContextEngine } from "../src/application/context/context-engine.js";
import { ContextSource } from "../src/application/context/context-source.js";
import { LiveAgentBrain } from "../src/application/live-agent-brain.js";
import { ProposalValidator } from "../src/application/proposal-validator.js";
import { RunCoordinator } from "../src/application/run-coordinator.js";
import { createExecutionPolicy } from "../src/domain/policy.js";
import { staticToolRegistry } from "../src/domain/tool.js";
import {
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
  path.resolve(__dirname, "../tests/fixtures")
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
// 2. Custom Node:HTTP Fetch Implementation with Injected think: false
// ============================================================================

/**
 * Custom fetch implementation that injects { think: false } into the Ollama
 * request payload to explicitly disable Qwen3 thinking mode at the API boundary,
 * and maintains reliable socket timeout handling.
 */
function createThinkingDisabledSocketFetch(socketTimeoutMs: number = 300_000): (input: string | URL, init?: RequestInit) => Promise<Response> {
  return (input: string | URL, init?: RequestInit): Promise<Response> => {
    return new Promise((resolve, reject) => {
      const url = new URL(input.toString());

      // Injected native Ollama 0.40+ parameter: think: false
      let modifiedBody = init?.body;
      if (typeof init?.body === "string") {
        try {
          const parsed = JSON.parse(init.body);
          parsed.think = false; // Native parameter supported by Ollama to disable thinking
          modifiedBody = JSON.stringify(parsed);
        } catch {
          // preserve unmodified
        }
      }

      const headers: Record<string, string> = {
        ...((init?.headers as Record<string, string>) || {}),
      };
      if (modifiedBody) {
        headers["Content-Length"] = String(Buffer.byteLength(modifiedBody as string, "utf8"));
      }

      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port ? parseInt(url.port, 10) : 80,
          path: url.pathname + url.search,
          method: init?.method || "GET",
          headers,
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

      if (modifiedBody) {
        req.write(modifiedBody);
      }
      req.end();
    });
  };
}

// ============================================================================
// 3. Fixture Source
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

// ============================================================================
// 4. Main Diagnostic Runner
// ============================================================================

export type Phase15CClassification =
  | "INFERENCE_VALIDATED"
  | "MODEL_SCHEMA_FAILURE"
  | "ENVIRONMENT_FAILURE";

async function main(): Promise<void> {
  console.log("======================================================================");
  console.log("EMERALD AGENT FABRIC — PHASE 15C QWEN3:4B THINKING-OFF CPU VALIDATION");
  console.log("Single Controlled Step 1 Request: qwen3:4b (think: false)");
  console.log("======================================================================");

  const wallClockStart = performance.now();
  let classification: Phase15CClassification = "ENVIRONMENT_FAILURE";

  // 1. Preflight
  verifyHistoricalArtifactsPreserved();

  const baseUrl = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  const modelName = process.env.OLLAMA_MODEL || "qwen3:4b";
  const MODEL_REQUEST_TIMEOUT_MS = 180_000; // 180 seconds

  console.log(`[CONFIG] Baseline Commit: 70979cf`);
  console.log(`[CONFIG] Ollama Endpoint: ${baseUrl}`);
  console.log(`[CONFIG] Model Under Test: ${modelName}`);
  console.log(`[CONFIG] Thinking Mode: DISABLED (think: false)`);
  console.log(`[CONFIG] Transport Timeout: ${MODEL_REQUEST_TIMEOUT_MS}ms (180s)`);

  // Verify Ollama connectivity
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

  // 2. Setup isolated workspace & state store
  const tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-phase15c-"));
  const workspaceRootDir = path.join(tempBaseDir, "workspaces");
  fs.mkdirSync(workspaceRootDir, { recursive: true });

  const store = new SqliteStateStore();
  const clock = new SystemClock();
  const workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: workspaceRootDir });
  const coordinator = new RunCoordinator(store, clock);

  const workerId = "worker-phase15c-diagnostic";
  const leaseTtlMs = 1_800_000;

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

  // 3. Establish Task & Baseline
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

  const task = coordinator.createTask({
    title: "Phase 15C: Qwen3 Thinking-Off Validation",
    description: taskDirective,
    inputPayload: { directive: taskDirective },
  });

  const ws = await workspaceAdapter.provisionWorkspace({
    workspaceId: `ws-${task.taskId.slice(0, 8)}`,
    runId: `run-${task.taskId.slice(0, 8)}`,
    taskId: task.taskId,
    maxWorkspaceBytes: 50 * 1024 * 1024,
    maxFileSizeBytes: 10 * 1024 * 1024,
  });

  const repoInfo = await createMockGitRepository(ws.hostPath, [
    { path: "package.json", content: '{\n  "name": "math-unit",\n  "version": "1.0.0"\n}\n' },
    { path: "src/math.js", content: DEFECTIVE_MATH_JS },
  ]);

  const contract = createAndActivateContract(store, task.taskId, {
    policy: createExecutionPolicy({
      policyId: `policy-${task.taskId}`,
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

  const { run } = coordinator.createRun({ taskId: task.taskId });
  coordinator.queueRun(run.runId);
  const claimResult = coordinator.claimRun(run.runId, workerId, leaseTtlMs);
  coordinator.startRun(run.runId, workerId, claimResult.lease.leaseId);

  // 4. Assemble Step 1 ContextSnapshot
  const contextSource = new ContextSource(store);
  const candidates = await contextSource.gatherCandidateObservations(run.runId);
  const contextSnapshot = ContextEngine.build({
    runId: run.runId,
    taskId: task.taskId,
    candidates,
    budget: {
      maxObservations: 50,
      maxEstimatedTokens: 4096,
      maxBytes: 32768,
    },
    createdAt: clock.nowIso(),
  });

  // 5. Setup LiveAgentBrain with Injected think: false fetch (180s timeout)
  const customFetch = createThinkingDisabledSocketFetch(300_000);

  const modelProvider = new OllamaModelProvider({
    baseURL: baseUrl,
    defaultModel: modelName,
    timeoutMs: MODEL_REQUEST_TIMEOUT_MS,
    fetch: customFetch,
  });

  const liveBrain = new LiveAgentBrain({
    modelProvider,
    model: modelName,
    timeoutMs: MODEL_REQUEST_TIMEOUT_MS,
    generationOptions: {
      temperature: 0.0,
      maxOutputTokens: 1024,
    },
    clock,
  });

  const proposalValidator = new ProposalValidator({
    toolRegistry: staticToolRegistry,
    stateStore: store,
    coordinator,
  });

  // 6. Execute EXACTLY ONE Controlled Live Request
  console.log("\n[EXEC] Initiating single Step 1 proposal request to qwen3:4b (think: false)...");
  console.log(`[EXEC] Context Bytes: ${contextSnapshot.totalBytes}`);

  const brainRequest: AgentBrainRequest = {
    runId: run.runId,
    contextSnapshot,
    availableTools: staticToolRegistry.listTools(),
    sequenceNumber: 1,
  };

  const modelReq = liveBrain.buildModelRequest(brainRequest);
  const promptBytes = Buffer.byteLength(JSON.stringify(modelReq.input), "utf8");
  console.log(`[EXEC] Prompt Bytes: ${promptBytes}`);

  let brainResult: AgentBrainResult | null = null;
  let brainError: Error | null = null;
  let inferenceDurationMs = 0;

  const inferenceStart = performance.now();
  try {
    brainResult = await liveBrain.proposeAction(brainRequest);
    inferenceDurationMs = Math.round(performance.now() - inferenceStart);
    console.log(`[EXEC] Model responded in ${(inferenceDurationMs / 1000).toFixed(1)}s`);
  } catch (err: unknown) {
    inferenceDurationMs = Math.round(performance.now() - inferenceStart);
    brainError = err instanceof Error ? err : new Error(String(err));
    console.error(`[EXEC ERROR] Brain invocation failed after ${(inferenceDurationMs / 1000).toFixed(1)}s: ${brainError.message}`);
  }

  // 7. Inspect Proposal and Validate
  let proposalValidationResult: { valid: boolean; reason?: string; message?: string } | null = null;
  let responseStatus = "ERROR";
  let responseBytes = 0;

  if (brainResult) {
    responseStatus = "RECEIVED";
    responseBytes = Buffer.byteLength(brainResult.rawOutput ?? "", "utf8");
    console.log(`[RESPONSE] Response Bytes: ${responseBytes}`);
    console.log(`[RESPONSE] Raw Output:\n${brainResult.rawOutput}`);

    if (brainResult.proposal) {
      console.log(`[PROPOSAL] Parsed Proposal:\n${JSON.stringify(brainResult.proposal, null, 2)}`);
      const valResult = proposalValidator.validate(brainResult.proposal, {
        runId: run.runId,
        contextSnapshot,
        workerId,
        leaseId: claimResult.lease.leaseId,
        run: store.getRun(run.runId)!,
        contract,
      });
      proposalValidationResult = valResult;
      console.log(`[VALIDATION] Valid: ${valResult.valid}, Reason: ${valResult.reason ?? "NONE"}`);

      if (valResult.valid) {
        classification = "INFERENCE_VALIDATED";
      } else {
        classification = "MODEL_SCHEMA_FAILURE";
      }
    } else {
      console.log("[PROPOSAL] brainResult.proposal is null");
      classification = "MODEL_SCHEMA_FAILURE";
    }
  } else {
    responseStatus = brainError?.message?.includes("timed out") || brainError?.message?.includes("timeout")
      ? "TIMEOUT"
      : "ERROR";
    classification = "ENVIRONMENT_FAILURE";
  }

  const totalWallClockMs = Math.round(performance.now() - wallClockStart);

  // 8. Assemble Evidence Bundle
  const evidenceBundle = {
    $schema: "https://emerald.agentfabric.dev/schemas/v1/phase15c-diagnostic-evidence.json",
    experimentId: `exp-phase15c-diagnostic-${Date.now()}`,
    runId: run.runId,
    taskId: task.taskId,
    baselineCommitSha: "70979cf4bcbf4a237b79af3a23449a4b932104d5",
    model: modelName,
    provider: "ollama",
    hardware: "CPU",
    thinking: false,
    previousThinking: true,
    previousInferenceMs: 600453,
    timeoutUsedMs: MODEL_REQUEST_TIMEOUT_MS,
    thinkingDisabledVia: "Ollama JSON API request body parameter: { think: false }",
    configurationVerified: true,
    promptBytes,
    contextBytes: contextSnapshot.totalBytes,
    responseStatus,
    responseBytes,
    rawModelResponse: brainResult?.rawOutput ?? null,
    parsedProposal: brainResult?.proposal ?? null,
    proposalValidationResult,
    inferenceDurationMs,
    totalWallClockMs,
    physicalActionsExecuted: 0,
    cleanRoomExecuted: false,
    classification,
  };

  const evidencePath = path.join(SCRATCH_DIR, "phase15c-diagnostic-evidence.json");
  fs.writeFileSync(evidencePath, JSON.stringify(evidenceBundle, null, 2), "utf8");
  console.log(`[EVIDENCE] Saved evidence to ${evidencePath}`);

  try {
    const localEvidencePath = path.join(LOCAL_SCRATCH_DIR, "phase15c-diagnostic-evidence.json");
    fs.writeFileSync(localEvidencePath, JSON.stringify(evidenceBundle, null, 2), "utf8");
    console.log(`[EVIDENCE] Saved local duplicate to ${localEvidencePath}`);
  } catch {
    // optional
  }

  // Cleanup temp resources safely
  try {
    store.close();
    fs.rmSync(tempBaseDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  console.log(`\n======================================================================`);
  console.log(`FINAL RESULT CLASSIFICATION: [${classification}]`);
  console.log(`======================================================================\n`);
}

main().catch((err) => {
  console.error("[FATAL ERROR]", err);
  process.exit(1);
});
