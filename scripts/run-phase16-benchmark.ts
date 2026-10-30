/**
 * Phase 16 — Model-Facing Interface Complexity / Capability Boundary Experiment.
 *
 * Controlled empirical experiment holding model capability constant (qwen2.5:1.5b on CPU)
 * while evaluating four model-facing interface projection conditions:
 * - Condition A: Production Interface (Control — reproduces Phase 15E)
 * - Condition B: Minimal Tool Surface (read_file + write_file only)
 * - Condition C: Minimal Schema Surface (read_file + write_file with stripped descriptions)
 * - Condition D: Minimal Task Context (Condition C + minimized task prompt)
 *
 * Invariants & Governance:
 * - Emerald architecture, ports, adapters, domain, and application layers remain FROZEN.
 * - Runtime ProposalValidator, PolicyEvaluator, ToolGateway, and CleanRoomVerifier remain authoritative.
 * - Local Ollama model: qwen2.5:1.5b (ID: 65ec06548149, Q4_K_M, CPU at ₹0).
 * - Zero modifications to production source code or tests.
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
import {
  ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA,
  DEFAULT_LIVE_BRAIN_SYSTEM_INSTRUCTION,
} from "../src/application/live-agent-brain.js";
import { ProposalValidator } from "../src/application/proposal-validator.js";
import { RunCoordinator } from "../src/application/run-coordinator.js";
import { WorkerRuntime } from "../src/application/worker-runtime.js";
import { ActionProposalSchema } from "../src/domain/action-proposal.js";
import { canonicalJsonStringify } from "../src/domain/canonical-hash.js";
import { createExecutionPolicy } from "../src/domain/policy.js";
import { staticToolRegistry, ToolDefinition } from "../src/domain/tool.js";
import { formatModelFacingToolCatalog } from "../src/domain/tool-projection.js";
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
import { ModelMessage, ModelProviderRequest } from "../src/domain/model-provider.js";
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
// 4. Condition Projection Brain Implementation
// ============================================================================

export type ConditionType = "A" | "B" | "C" | "D";

export interface StepTelemetryRecord {
  sequenceNumber: number;
  timestamp: string;
  condition: ConditionType;
  model: string;
  contextBytes: number;
  promptBytes: number;
  toolCatalogBytes: number;
  responseBytes: number;
  durationMs: number;
  rawOutput: string;
  proposal: any;
  proposalValid: boolean;
  rejectionReason: string | null;
  toolName: string | null;
  hasContentHashInput: boolean;
  actionStatus: string | null;
  attemptStatus: string | null;
}

export class Phase16ConditionBrain implements AgentBrainPort {
  constructor(
    readonly condition: ConditionType,
    private readonly modelProvider: OllamaModelProvider,
    private readonly model: string,
    private readonly timeoutMs: number,
    private readonly clock: SystemClock,
    private readonly taskDirective: string,
    private readonly onStepRecorded: (record: StepTelemetryRecord) => void
  ) {}

  buildModelRequest(request: AgentBrainRequest): {
    modelRequest: ModelProviderRequest;
    toolCatalogBytes: number;
    promptBytes: number;
  } {
    const { contextSnapshot, sequenceNumber, runId, abortSignal } = request;

    let systemInstruction = DEFAULT_LIVE_BRAIN_SYSTEM_INSTRUCTION;
    let toolCatalogText = "";
    let userContent = "";

    // Determine tool surface and schema projection
    if (this.condition === "A") {
      // Condition A: Production Interface (full tool catalog & standard projection)
      const allTools = staticToolRegistry.listTools();
      toolCatalogText = formatModelFacingToolCatalog(allTools);
    } else if (this.condition === "B") {
      // Condition B: Minimal Tool Surface (read_file & write_file with standard projection)
      const minimalTools = staticToolRegistry
        .listTools()
        .filter((t) => t.name === "read_file" || t.name === "write_file");
      toolCatalogText = formatModelFacingToolCatalog(minimalTools);
    } else if (this.condition === "C" || this.condition === "D") {
      // Condition C & D: Minimal Schema Surface (read_file & write_file with stripped descriptions)
      toolCatalogText = [
        "- read_file(path: string, offsetLine?: integer, limitLines?: integer): Read text from file.",
        "- write_file(path: string, content: string): Atomically create or overwrite a file with text.",
      ].join("\n");
    }

    const toolCatalogBytes = Buffer.byteLength(toolCatalogText, "utf8");

    if (this.condition === "D") {
      // Condition D: Minimal Task Context
      systemInstruction =
        "You are a reasoning component within Emerald Agent Fabric. Propose JSON action proposals to achieve the task. Output is untrusted and will be validated by the execution system.";

      const obsText =
        contextSnapshot.observations.length === 0
          ? "No observations available."
          : contextSnapshot.observations
              .map((obs) => `[${obs.category}]\n${canonicalJsonStringify(obs.content)}`)
              .join("\n\n");

      userContent = [
        "## Task",
        "Repair src/math.js so add(2, 3) returns 5.",
        "Inspect the file first, make the minimal change with write_file, and only claim completion when repaired.",
        "",
        "## Available Tools",
        toolCatalogText,
        "",
        "## Context Observations",
        obsText,
        "",
        "## Required Action",
        "Propose the next tool action as a JSON object conforming to the action proposal schema.",
        `Set contextSnapshotHash to "${contextSnapshot.contextHash}".`,
        "If the goal has been completely achieved, set isGoalReached: true.",
      ].join("\n");
    } else {
      // Conditions A, B, C: Standard task execution context structure
      const sections: string[] = [];
      sections.push("## Task Execution Context");
      sections.push(`- Task ID: ${contextSnapshot.taskId}`);
      sections.push(`- Run ID: ${runId}`);
      sections.push(`- Step Sequence: ${sequenceNumber}`);
      sections.push(`- Context Snapshot Hash: ${contextSnapshot.contextHash}`);

      sections.push("\n## Available Tools");
      sections.push(toolCatalogText);

      sections.push("\n## Context Observations");
      if (contextSnapshot.observations.length === 0) {
        sections.push("No observations available.");
      } else {
        for (const obs of contextSnapshot.observations) {
          const truncNote = obs.truncation?.isTruncated
            ? ` [Truncated: ${obs.truncation.retainedBytes}/${obs.truncation.originalBytes} bytes]`
            : "";
          sections.push(
            `### [${obs.category}] Priority ${obs.priority} (${obs.freshness})${truncNote}\n${canonicalJsonStringify(obs.content)}`
          );
        }
      }

      if (contextSnapshot.omittedObservationsCount > 0) {
        sections.push(
          `\n## Omitted Observations: ${contextSnapshot.omittedObservationsCount} item(s) omitted due to context budget limits.`
        );
      }

      sections.push(
        `\n## Required Action\n` +
          `Propose the next logical tool action as a JSON object conforming to the action proposal schema.\n` +
          `Set contextSnapshotHash to "${contextSnapshot.contextHash}".\n` +
          `If the mission goal has been completely achieved, set isGoalReached: true.`
      );

      userContent = sections.join("\n");
    }

    const inputMessages: readonly ModelMessage[] = Object.freeze([
      Object.freeze({
        role: "system" as const,
        content: systemInstruction,
      }),
      Object.freeze({
        role: "user" as const,
        content: userContent,
      }),
    ]);

    const requestId = crypto.randomUUID();
    const modelRequest: ModelProviderRequest = Object.freeze({
      requestId,
      model: this.model,
      input: inputMessages,
      generation: Object.freeze({
        temperature: 0.0,
        maxOutputTokens: 1024,
        structuredOutput: ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA,
      }),
      timeoutMs: this.timeoutMs,
      ...(abortSignal ? { abortSignal } : {}),
    });

    const promptBytes = Buffer.byteLength(JSON.stringify(modelRequest.input), "utf8");

    return { modelRequest, toolCatalogBytes, promptBytes };
  }

  async proposeAction(request: AgentBrainRequest): Promise<AgentBrainResult> {
    const { modelRequest, toolCatalogBytes, promptBytes } = this.buildModelRequest(request);
    const contextBytes = request.contextSnapshot.totalBytes;
    const t0 = performance.now();

    let providerResponse;
    try {
      providerResponse = await this.modelProvider.generate(modelRequest);
    } catch (err: unknown) {
      console.error(`[BRAIN ERROR in Condition ${this.condition}]`, err);
      throw err;
    }
    const durationMs = Math.round(performance.now() - t0);
    const rawOutput = providerResponse.outputText;
    const responseBytes = Buffer.byteLength(rawOutput, "utf8");

    let parsed: any = null;
    let parseError: string | null = null;
    try {
      parsed = JSON.parse(rawOutput);
    } catch (e: unknown) {
      parseError = e instanceof Error ? e.message : String(e);
    }

    let hasContentHashInput = false;
    let proposal: any = null;
    let finishReason: "TOOL_ACTION" | "GOAL_REACHED" | "ERROR" = "TOOL_ACTION";

    if (parsed && typeof parsed === "object") {
      if (parsed.isGoalReached === true) {
        finishReason = "GOAL_REACHED";
        proposal = undefined;
      } else {
        const rawInput = parsed.inputPayload ?? parsed.input ?? {};
        if (typeof rawInput === "object" && rawInput !== null) {
          hasContentHashInput = "contentHash" in rawInput;
        }
        proposal = {
          proposalId: typeof parsed.proposalId === "string" ? parsed.proposalId : crypto.randomUUID(),
          toolName: parsed.toolName,
          inputPayload: rawInput,
          contextSnapshotHash: typeof parsed.contextSnapshotHash === "string" ? parsed.contextSnapshotHash : request.contextSnapshot.contextHash,
          ...(parsed.rationale ? { rationale: String(parsed.rationale) } : {}),
          ...(typeof parsed.sequenceHint === "number" ? { sequenceHint: Math.floor(parsed.sequenceHint) } : {}),
        };
      }
    } else if (parseError) {
      finishReason = "ERROR";
    }

    // Record telemetry for this step
    this.onStepRecorded({
      sequenceNumber: request.sequenceNumber,
      timestamp: this.clock.nowIso(),
      condition: this.condition,
      model: this.model,
      contextBytes,
      promptBytes,
      toolCatalogBytes,
      responseBytes,
      durationMs,
      rawOutput,
      proposal,
      proposalValid: false, // will be enriched from stepResult.transcript
      rejectionReason: null,
      toolName: proposal?.toolName ?? null,
      hasContentHashInput,
      actionStatus: null,
      attemptStatus: null,
    });

    return {
      finishReason,
      proposal,
      rawOutput,
      modelMetadata: {
        providerName: "ollama",
        modelIdentifier: this.model,
        promptTokens: providerResponse.usage?.inputTokens,
        completionTokens: providerResponse.usage?.outputTokens,
        totalTokens: providerResponse.usage?.totalTokens,
        latencyMs: durationMs,
      },
    };
  }
}

// ============================================================================
// 5. Capability Depth Evaluator
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
  records: StepTelemetryRecord[];
  physicalActionCount: number;
  actualMutationOccurred: boolean;
  cleanRoomReached: boolean;
  finalRunStatus: string;
}): CapabilityDepthResult {
  const { records, physicalActionCount, actualMutationOccurred, cleanRoomReached, finalRunStatus } = params;

  const step0 = records.length > 0;
  const step1 = records.some((r) => r.proposalValid);
  const step2 = physicalActionCount > 0;

  // Step 3: Observation correctly incorporated
  // True if after step 1 executed, step 2 did NOT hallucinate contentHash or emit invalid tool schema
  const step1Record = records.find((r) => r.sequenceNumber === 1);
  const step2Record = records.find((r) => r.sequenceNumber === 2);
  const step3 = Boolean(step2Record && !step2Record.hasContentHashInput && step2Record.proposalValid);

  // Step 4: Second correct tool proposal
  const validProposals = records.filter((r) => r.proposalValid);
  const step4 = validProposals.length >= 2;

  // Step 5: Physical mutation
  const step5 = actualMutationOccurred;

  // Step 6: Correct completion claim (emitted goal reached when repaired)
  const step6 = records.some((r) => r.proposal?.isGoalReached === true && actualMutationOccurred);

  // Step 7: Independent verification reached
  const step7 = cleanRoomReached;

  // Step 8: Verified completed
  const step8 = finalRunStatus === "COMPLETED";

  let depth = 0;
  if (step0) depth = 0;
  if (step1) depth = 1;
  if (step2) depth = 2;
  if (step3) depth = 3;
  if (step4) depth = 4;
  if (step5) depth = Math.max(depth, 5); // physical mutation can happen at step 1
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
// 6. Condition Runner
// ============================================================================

export interface ConditionExecutionResult {
  condition: ConditionType;
  conditionName: string;
  status: "COMPLETED" | "FAILED" | "ENVIRONMENT_FAILURE";
  classification:
    | "MODEL_CAPABILITY_SUCCESS"
    | "MODEL_CODING_FAILURE"
    | "MODEL_SCHEMA_FAILURE"
    | "ENVIRONMENT_FAILURE"
    | "VERIFICATION_FAILURE"
    | "GOVERNANCE_FAILURE";
  firstResponseLatencyMs: number;
  totalDurationMs: number;
  promptBytesStep1: number;
  contextBytesStep1: number;
  toolCatalogBytes: number;
  totalProposals: number;
  validProposals: number;
  invalidProposals: number;
  proposalValidityRatePct: number;
  readSelected: boolean;
  readExecuted: boolean;
  writeSelected: boolean;
  writeExecuted: boolean;
  physicalActionCount: number;
  physicalMutationOccurred: boolean;
  hallucinatedContentHash: boolean;
  rejectionCount: number;
  recoveryOutcome: "RECOVERY_SUCCESS" | "RECOVERY_FAILURE" | "NO_REJECTION";
  terminalReason: string;
  cleanRoomReached: boolean;
  capabilityDepth: CapabilityDepthResult;
  records: StepTelemetryRecord[];
}

async function runCondition(params: {
  condition: ConditionType;
  baseUrl: string;
  modelName: string;
  taskDirective: string;
  cleanRoomSpec: CleanRoomVerificationSpec;
}): Promise<ConditionExecutionResult> {
  const { condition, baseUrl, modelName, taskDirective, cleanRoomSpec } = params;

  const conditionNames: Record<ConditionType, string> = {
    A: "Condition A — Production Interface (Control)",
    B: "Condition B — Minimal Tool Surface (read_file + write_file)",
    C: "Condition C — Minimal Schema Surface (stripped tool descriptions)",
    D: "Condition D — Minimal Task Context (minimized prompt)",
  };

  console.log("\n======================================================================");
  console.log(`RUNNING: ${conditionNames[condition]}`);
  console.log("======================================================================");

  const conditionStart = performance.now();
  const records: StepTelemetryRecord[] = [];

  const tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), `emerald-p16-cond${condition}-`));
  const workspaceRootDir = path.join(tempBaseDir, "workspaces");
  fs.mkdirSync(workspaceRootDir, { recursive: true });

  const store = new SqliteStateStore();
  const clock = new SystemClock();
  const workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: workspaceRootDir });
  const coordinator = new RunCoordinator(store, clock);
  const executionProvider = new DockerExecutionProvider();

  const workerId = `worker-phase16-cond${condition}`;
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

  const workerRuntime = new WorkerRuntime({
    workerId,
    stateStore: store,
    coordinator,
    toolRegistry: staticToolRegistry,
    workspacePort: workspaceAdapter,
    executionProvider,
    isIsolationAvailable: true,
    clock,
  });

  const customFetch = createCustomSocketFetch(180_000);
  const modelProvider = new OllamaModelProvider({
    baseURL: baseUrl,
    defaultModel: modelName,
    fetch: customFetch,
  });

  const conditionBrain = new Phase16ConditionBrain(
    condition,
    modelProvider,
    modelName,
    120_000,
    clock,
    taskDirective,
    (rec) => records.push(rec)
  );

  const proposalValidator = new ProposalValidator({
    toolRegistry: staticToolRegistry,
    stateStore: store,
    coordinator,
  });

  let cleanRoomReached = false;
  const cleanRoomVerifier = new CleanRoomVerifier({
    workspacePort: workspaceAdapter,
    workerRuntime,
    coordinator,
    stateStore: store,
    clock,
  });

  const origVerifyCandidatePatch = cleanRoomVerifier.verifyCandidatePatch.bind(cleanRoomVerifier);
  cleanRoomVerifier.verifyCandidatePatch = async (vParams: any) => {
    cleanRoomReached = true;
    return origVerifyCandidatePatch(vParams);
  };

  const stepController = new AgentStepController({
    coordinator,
    stateStore: store,
    workerRuntime,
    agentBrain: conditionBrain,
    proposalValidator,
    toolRegistry: staticToolRegistry,
    clock,
    cleanRoomVerifier,
  });

  const task = coordinator.createTask({
    title: `Phase 16 ${conditionNames[condition]}`,
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

  await createMockGitRepository(ws.hostPath, [
    { path: "package.json", content: '{\n  "name": "math-unit",\n  "version": "1.0.0"\n}\n' },
    { path: "src/math.js", content: DEFECTIVE_MATH_JS },
    { path: "test/math.target.test.js", content: TARGET_TEST_JS },
    { path: "test/math.regress.test.js", content: REGRESS_TEST_JS },
  ]);

  const verificationSpec = createVerificationSpec({
    specId: cleanRoomSpec.specId,
    ruleKind: "CLEAN_ROOM_DUAL_GATE",
    expectedValue: cleanRoomSpec,
  });

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
    verificationSpecs: [verificationSpec],
    timeoutMs: 1_200_000,
    maxOutputBytes: 1048576,
    maxAttempts: 5,
  });

  const { run } = coordinator.createRun({ taskId: task.taskId });
  coordinator.queueRun(run.runId);
  const claim = coordinator.claimRun(run.runId, workerId, leaseTtlMs);
  coordinator.startRun(run.runId, workerId, claim.lease.leaseId);

  let stepResult: any = null;
  let loopThrewError = false;
  try {
    stepResult = await stepController.runStepLoop({
      runId: run.runId,
      leaseId: claim.lease.leaseId,
      workerId,
      workspace: ws,
      budget: {
        ...DEFAULT_STEP_CONTROLLER_BUDGET,
        maxSteps: 12,
        maxActions: 8,
        maxWallClockMs: 1_800_000,
        maxProposalRejections: 6,
      },
    });
    console.log(`[EXEC] Terminal Reason: ${stepResult?.terminalReason}, Message: ${stepResult?.terminalMessage}`);
  } catch (err: unknown) {
    loopThrewError = true;
    console.error(`[EXEC ERROR] Step loop threw exception: ${err instanceof Error ? err.message : String(err)}`);
  }

  const totalDurationMs = Math.round(performance.now() - conditionStart);

  // Post-run state inspection
  const finalRun = store.getRun(run.runId);
  const actions = store.getActionsForRun(run.runId);

  // Check physical mutation
  let actualMutationOccurred = false;
  const currentMathJs = path.join(ws.hostPath, "src/math.js");
  if (fs.existsSync(currentMathJs)) {
    const mathContent = fs.readFileSync(currentMathJs, "utf8");
    actualMutationOccurred = mathContent.trim() !== DEFECTIVE_MATH_JS.trim();
  }

  // Cross-reference telemetry with stepResult transcript and actions
  if (stepResult?.transcript && Array.isArray(stepResult.transcript)) {
    for (let i = 0; i < records.length; i++) {
      const stepEntry = stepResult.transcript[i];
      if (stepEntry) {
        records[i].proposalValid = Boolean(stepEntry.proposalValid);
        records[i].rejectionReason = stepEntry.proposalRejectionReason ?? null;
      }
    }
  }

  for (let i = 0; i < records.length; i++) {
    const act = actions[i];
    if (act) {
      records[i].actionStatus = act.status;
    }
  }

  // Calculate metrics
  const totalProposals = records.length;
  const validProposals = records.filter((r) => r.proposalValid).length;
  const invalidProposals = totalProposals - validProposals;
  const proposalValidityRatePct =
    totalProposals > 0 ? Math.round((validProposals / totalProposals) * 1000) / 10 : 0;

  const firstResponseLatencyMs = records[0]?.durationMs ?? 0;
  const promptBytesStep1 = records[0]?.promptBytes ?? 0;
  const contextBytesStep1 = records[0]?.contextBytes ?? 0;
  const toolCatalogBytes = records[0]?.toolCatalogBytes ?? 0;

  const readSelected = records.some((r) => r.toolName === "read_file");
  const readExecuted = actions.some((a) => a.toolName === "read_file" && a.status === "SUCCEEDED");
  const writeSelected = records.some((r) => r.toolName === "write_file");
  const writeExecuted = actions.some((a) => a.toolName === "write_file" && a.status === "SUCCEEDED");

  const physicalActionCount = actions.filter((a) => a.status === "SUCCEEDED").length;
  const hallucinatedContentHash = records.some((r) => r.hasContentHashInput);
  const rejectionCount = records.filter((r) => !r.proposalValid).length;

  let recoveryOutcome: "RECOVERY_SUCCESS" | "RECOVERY_FAILURE" | "NO_REJECTION" = "NO_REJECTION";
  if (rejectionCount > 0) {
    // Look for whether an invalid proposal was followed by a subsequent valid proposal
    const firstInvalidIdx = records.findIndex((r) => !r.proposalValid);
    const subsequentValid = records.slice(firstInvalidIdx + 1).some((r) => r.proposalValid);
    recoveryOutcome = subsequentValid ? "RECOVERY_SUCCESS" : "RECOVERY_FAILURE";
  }

  const terminalReason = stepResult?.terminalReason ?? (loopThrewError ? "LOOP_ERROR" : "UNKNOWN");
  const finalStatus = (finalRun?.status ?? "FAILED") as "COMPLETED" | "FAILED";

  // Scientific classification
  let classification: ConditionExecutionResult["classification"] = "MODEL_CODING_FAILURE";
  if (loopThrewError) {
    classification = "GOVERNANCE_FAILURE";
  } else if (cleanRoomReached) {
    classification = finalStatus === "COMPLETED" ? "MODEL_CAPABILITY_SUCCESS" : "VERIFICATION_FAILURE";
  } else if (records.length === 0) {
    classification = "ENVIRONMENT_FAILURE";
  } else if (records.every((r) => !r.proposalValid)) {
    classification = "MODEL_SCHEMA_FAILURE";
  } else {
    classification = "MODEL_CODING_FAILURE";
  }

  const capabilityDepth = evaluateCapabilityDepth({
    records,
    physicalActionCount,
    actualMutationOccurred,
    cleanRoomReached,
    finalRunStatus: finalStatus,
  });

  console.log(`[CONDITION ${condition} RESULT] Status: ${finalStatus}, Depth: ${capabilityDepth.depth} (${capabilityDepth.description})`);
  console.log(`  First Latency: ${(firstResponseLatencyMs / 1000).toFixed(1)}s, Prompt: ${promptBytesStep1}B, Catalog: ${toolCatalogBytes}B`);
  console.log(`  Proposals: ${totalProposals} (Valid: ${validProposals}, Invalid: ${invalidProposals}, Validity: ${proposalValidityRatePct}%)`);
  console.log(`  Actions: ${physicalActionCount}, Mutation: ${actualMutationOccurred}, ContentHash Hallucination: ${hallucinatedContentHash}`);
  console.log(`  Terminal Reason: ${terminalReason}, Classification: ${classification}`);

  // Cleanup temporary workspace
  try {
    store.close();
    fs.rmSync(tempBaseDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  return {
    condition,
    conditionName: conditionNames[condition],
    status: finalStatus,
    classification,
    firstResponseLatencyMs,
    totalDurationMs,
    promptBytesStep1,
    contextBytesStep1,
    toolCatalogBytes,
    totalProposals,
    validProposals,
    invalidProposals,
    proposalValidityRatePct,
    readSelected,
    readExecuted,
    writeSelected,
    writeExecuted,
    physicalActionCount,
    physicalMutationOccurred: actualMutationOccurred,
    hallucinatedContentHash,
    rejectionCount,
    recoveryOutcome,
    terminalReason,
    cleanRoomReached,
    capabilityDepth,
    records,
  };
}

// ============================================================================
// 7. Main Benchmark Controller
// ============================================================================

async function main(): Promise<void> {
  console.log("======================================================================");
  console.log("EMERALD AGENT FABRIC — PHASE 16 INTERFACE COMPLEXITY EXPERIMENT");
  console.log("Holding Model Capability Constant: qwen2.5:1.5b (CPU via Ollama)");
  console.log("Conditions Tested: A (Control) -> B (Minimal Tools) -> C (Minimal Schema) -> D (Minimal Context)");
  console.log("======================================================================");

  verifyHistoricalArtifactsPreserved();

  const baseUrl = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  const modelName = process.env.OLLAMA_MODEL || "qwen2.5:1.5b";

  console.log(`[CONFIG] Baseline Commit: 70979cf4bcbf4a237b79af3a23449a4b932104d5`);
  console.log(`[CONFIG] Ollama Endpoint: ${baseUrl}`);
  console.log(`[CONFIG] Model Under Test: ${modelName} (65ec06548149, Q4_K_M)`);
  console.log(`[CONFIG] Target Platform: Local CPU (₹0)`);

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

  const cleanRoomSpec: CleanRoomVerificationSpec = {
    specId: `spec-phase16-master`,
    baselineCommitSha: "70979cf4bcbf4a237b79af3a23449a4b932104d5",
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

  const conditions: ConditionType[] = ["A", "B", "C", "D"];
  const results: Record<ConditionType, ConditionExecutionResult> = {} as any;

  for (const cond of conditions) {
    const result = await runCondition({
      condition: cond,
      baseUrl,
      modelName,
      taskDirective,
      cleanRoomSpec,
    });
    results[cond] = result;
  }

  // ==========================================================================
  // Comparative Synthesis & Overall Classification
  // ==========================================================================
  console.log("\n======================================================================");
  console.log("PHASE 16 COMPARATIVE EXPERIMENTAL SYNTHESIS");
  console.log("======================================================================");

  const resA = results.A;
  const resB = results.B;
  const resC = results.C;
  const resD = results.D;

  const depths = [resA.capabilityDepth.depth, resB.capabilityDepth.depth, resC.capabilityDepth.depth, resD.capabilityDepth.depth];
  const maxDepth = Math.max(...depths);
  const minDepth = Math.min(...depths);

  // Overall experiment classification per Section 14 & 15:
  // INTERFACE_COMPLEXITY_SUPPORTED: A/B/C/D show material improvement in valid tool use, multi-step depth, or verified completion
  // INTERFACE_COMPLEXITY_NOT_SUPPORTED: Minimal interfaces produce essentially the same failure mode and capability depth as production
  // MIXED_SIGNAL: Some metrics improve materially but reliable autonomous coding remains unavailable
  // INCONCLUSIVE: Environmental or experimental problems prevent meaningful comparison
  let overallClassification:
    | "INTERFACE_COMPLEXITY_SUPPORTED"
    | "INTERFACE_COMPLEXITY_NOT_SUPPORTED"
    | "MIXED_SIGNAL"
    | "INCONCLUSIVE";

  const anyVerifiedCompletion = [resA, resB, resC, resD].some((r) => r.status === "COMPLETED");
  const depthImprovement = maxDepth - resA.capabilityDepth.depth >= 1;
  const validityImprovement =
    Math.max(resB.proposalValidityRatePct, resC.proposalValidityRatePct, resD.proposalValidityRatePct) -
      resA.proposalValidityRatePct >=
    20;
  const rejectionReduction =
    resA.rejectionCount - Math.min(resB.rejectionCount, resC.rejectionCount, resD.rejectionCount) >= 2;

  if (anyVerifiedCompletion) {
    overallClassification = "INTERFACE_COMPLEXITY_SUPPORTED";
  } else if (depthImprovement || validityImprovement || rejectionReduction) {
    overallClassification = "MIXED_SIGNAL";
  } else {
    overallClassification = "INTERFACE_COMPLEXITY_NOT_SUPPORTED";
  }

  console.log(`[SYNTHESIS] Capability Depths: A=${resA.capabilityDepth.depth}, B=${resB.capabilityDepth.depth}, C=${resC.capabilityDepth.depth}, D=${resD.capabilityDepth.depth}`);
  console.log(`[SYNTHESIS] Valid Proposal Rates: A=${resA.proposalValidityRatePct}%, B=${resB.proposalValidityRatePct}%, C=${resC.proposalValidityRatePct}%, D=${resD.proposalValidityRatePct}%`);
  console.log(`[SYNTHESIS] First-Response Latencies: A=${(resA.firstResponseLatencyMs / 1000).toFixed(1)}s, B=${(resB.firstResponseLatencyMs / 1000).toFixed(1)}s, C=${(resC.firstResponseLatencyMs / 1000).toFixed(1)}s, D=${(resD.firstResponseLatencyMs / 1000).toFixed(1)}s`);
  console.log(`[SYNTHESIS] Overall Scientific Classification: [${overallClassification}]`);

  // ==========================================================================
  // Evidence Artifact Persistence
  // ==========================================================================
  const reportPayload = {
    $schema: "https://emerald.agentfabric.dev/schemas/v1/phase16-interface-complexity-report.json",
    experimentId: `exp-phase16-${Date.now()}`,
    timestamp: new Date().toISOString(),
    baselineCommitSha: "70979cf4bcbf4a237b79af3a23449a4b932104d5",
    model: {
      identifier: modelName,
      digest: "65ec06548149",
      size: "1.5B",
      quantization: "Q4_K_M",
      provider: "ollama",
      hardware: "CPU",
    },
    overallClassification,
    thresholds: {
      latencyImprovementThresholdPct: 20,
      proposalValidityThresholdPct: 20,
      capabilityDepthThresholdSteps: 1,
      rejectionReductionThresholdCount: 2,
    },
    comparativeMatrix: {
      metric: [
        "First-response latency (s)",
        "Prompt bytes (Step 1)",
        "Context bytes (Step 1)",
        "Tool catalog bytes",
        "Valid proposal rate (%)",
        "Total proposals",
        "Physical mutation occurred",
        "Rejection count",
        "Recovery outcome",
        "Hallucinated contentHash",
        "Capability depth (0-8)",
        "Clean-room reached",
        "Final completion",
        "Condition classification",
      ],
      conditionA: [
        (resA.firstResponseLatencyMs / 1000).toFixed(1),
        resA.promptBytesStep1,
        resA.contextBytesStep1,
        resA.toolCatalogBytes,
        `${resA.proposalValidityRatePct}%`,
        resA.totalProposals,
        resA.physicalMutationOccurred,
        resA.rejectionCount,
        resA.recoveryOutcome,
        resA.hallucinatedContentHash,
        resA.capabilityDepth.depth,
        resA.cleanRoomReached,
        resA.status === "COMPLETED",
        resA.classification,
      ],
      conditionB: [
        (resB.firstResponseLatencyMs / 1000).toFixed(1),
        resB.promptBytesStep1,
        resB.contextBytesStep1,
        resB.toolCatalogBytes,
        `${resB.proposalValidityRatePct}%`,
        resB.totalProposals,
        resB.physicalMutationOccurred,
        resB.rejectionCount,
        resB.recoveryOutcome,
        resB.hallucinatedContentHash,
        resB.capabilityDepth.depth,
        resB.cleanRoomReached,
        resB.status === "COMPLETED",
        resB.classification,
      ],
      conditionC: [
        (resC.firstResponseLatencyMs / 1000).toFixed(1),
        resC.promptBytesStep1,
        resC.contextBytesStep1,
        resC.toolCatalogBytes,
        `${resC.proposalValidityRatePct}%`,
        resC.totalProposals,
        resC.physicalMutationOccurred,
        resC.rejectionCount,
        resC.recoveryOutcome,
        resC.hallucinatedContentHash,
        resC.capabilityDepth.depth,
        resC.cleanRoomReached,
        resC.status === "COMPLETED",
        resC.classification,
      ],
      conditionD: [
        (resD.firstResponseLatencyMs / 1000).toFixed(1),
        resD.promptBytesStep1,
        resD.contextBytesStep1,
        resD.toolCatalogBytes,
        `${resD.proposalValidityRatePct}%`,
        resD.totalProposals,
        resD.physicalMutationOccurred,
        resD.rejectionCount,
        resD.recoveryOutcome,
        resD.hallucinatedContentHash,
        resD.capabilityDepth.depth,
        resD.cleanRoomReached,
        resD.status === "COMPLETED",
        resD.classification,
      ],
    },
    conditions: {
      A: resA,
      B: resB,
      C: resC,
      D: resD,
    },
  };

  const jsonReportPathBrain = path.join(BRAIN_SCRATCH_DIR, "phase16-interface-complexity-report.json");
  const jsonReportPathLocal = path.join(LOCAL_SCRATCH_DIR, "phase16-interface-complexity-report.json");

  fs.writeFileSync(jsonReportPathBrain, JSON.stringify(reportPayload, null, 2), "utf8");
  fs.writeFileSync(jsonReportPathLocal, JSON.stringify(reportPayload, null, 2), "utf8");

  console.log(`\n[ARTIFACT] Saved Phase 16 report to ${jsonReportPathBrain}`);
  console.log(`[ARTIFACT] Saved Phase 16 duplicate to ${jsonReportPathLocal}`);
}

main().catch((err) => {
  console.error(`[FATAL] Phase 16 Benchmark threw unhandled error: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
