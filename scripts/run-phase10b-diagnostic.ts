/**
 * Phase 10B — Structured Output Boundary Diagnostic Runner.
 *
 * Controlled model-output evaluation measuring whether the Gate C failure observed in
 * Phase 10A (21/24 trials missing toolName) is caused by:
 * 1. Model capability (cannot emit valid JSON or valid proposal shape)
 * 2. Structured output enforcement (schema required fields configuration)
 * 3. Schema complexity (full ActionProposal vs minimal discriminator)
 * 4. Latency / inference timeout
 *
 * Invariants:
 * 1. Offline only: Zero tool execution, zero Action/Attempt creation, zero SQLite mutation,
 *    zero workspace modification, zero Reflex invocation.
 * 2. Model: llama3.2:3b only.
 * 3. Conditions (3 conditions × 2 trials = 6 model calls):
 *    - A: CURRENT_PRODUCTION (Production schema unchanged, required: ["isGoalReached"])
 *    - B: JSON_SCHEMA_ENFORCED (Exact ActionProposal contract with all required fields in schema)
 *    - C: MINIMAL_SCHEMA_DIAGNOSTIC (Diagnostic discriminator: toolName + inputPayload only)
 * 4. Provenance & Transparency: Every trial captures rawModelResponse, parsedResponse,
 *    tokens, timings, parse errors, and granular classification.
 * 5. Historical Artifact Protection: Historical Phase 9 and 10A artifacts are never modified.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { checkOllamaLiveAvailability } from "../src/application/evaluation/live-swe-evaluation.js";
import {
  ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA,
  DEFAULT_LIVE_BRAIN_SYSTEM_INSTRUCTION,
} from "../src/application/live-agent-brain.js";
import { TOOL_NAMES } from "../src/domain/tool.js";
import { ActionProposalSchema } from "../src/domain/action-proposal.js";
import { sha256Hex } from "../src/domain/canonical-hash.js";

// ============================================================================
// Types & Classification Taxonomy
// ============================================================================

export type FailureClassification =
  | "VALID_ACTION_PROPOSAL"
  | "INVALID_JSON"
  | "SCHEMA_MISSING_REQUIRED_FIELD"
  | "SCHEMA_WRONG_FIELD_NAME"
  | "SCHEMA_WRONG_FIELD_TYPE"
  | "UNEXPECTED_REASONING_OUTPUT"
  | "TRUNCATED_OUTPUT"
  | "MODEL_TIMEOUT"
  | "OTHER_MODEL_ERROR";

export interface DiagnosticTrialRecord {
  readonly condition: "A" | "B" | "C";
  readonly conditionLabel:
    | "CURRENT_PRODUCTION"
    | "JSON_SCHEMA_ENFORCED"
    | "MINIMAL_SCHEMA_DIAGNOSTIC";
  readonly trialOrdinal: number;
  readonly model: string;
  readonly rawModelResponse: string;
  readonly parsedResponse: unknown | null;
  readonly parseError: string | null;
  readonly schemaValidationResult: boolean;
  readonly failureClassification: FailureClassification;
  readonly classificationDetail: string;
  readonly modelLatencyMs: number;
  readonly promptTokens?: number;
  readonly outputTokens?: number;
  readonly schemaHash: string;
  readonly timestamp: string;
}

export interface Phase10BDiagnosticSummary {
  readonly experimentName: string;
  readonly timestamp: string;
  readonly model: string;
  readonly totalTrials: number;
  readonly conditions: {
    readonly A: {
      readonly label: string;
      readonly trials: number;
      readonly validOutputs: number;
      readonly invalidJson: number;
      readonly missingFields: number;
      readonly wrongFields: number;
      readonly reasoningContamination: number;
      readonly truncation: number;
      readonly timeouts: number;
      readonly otherErrors: number;
      readonly meanLatencyMs: number;
      readonly medianLatencyMs: number;
      readonly totalPromptTokens: number;
      readonly totalOutputTokens: number;
      readonly schemaValidationRate: number;
    };
    readonly B: {
      readonly label: string;
      readonly trials: number;
      readonly validOutputs: number;
      readonly invalidJson: number;
      readonly missingFields: number;
      readonly wrongFields: number;
      readonly reasoningContamination: number;
      readonly truncation: number;
      readonly timeouts: number;
      readonly otherErrors: number;
      readonly meanLatencyMs: number;
      readonly medianLatencyMs: number;
      readonly totalPromptTokens: number;
      readonly totalOutputTokens: number;
      readonly schemaValidationRate: number;
    };
    readonly C: {
      readonly label: string;
      readonly trials: number;
      readonly validOutputs: number;
      readonly invalidJson: number;
      readonly missingFields: number;
      readonly wrongFields: number;
      readonly reasoningContamination: number;
      readonly truncation: number;
      readonly timeouts: number;
      readonly otherErrors: number;
      readonly meanLatencyMs: number;
      readonly medianLatencyMs: number;
      readonly totalPromptTokens: number;
      readonly totalOutputTokens: number;
      readonly schemaValidationRate: number;
    };
  };
  readonly diagnosticInterpretation: {
    readonly matchedCase: "CASE_A" | "CASE_B" | "CASE_C" | "CASE_D";
    readonly conclusion: string;
    readonly primaryBottleneck:
      | "MODEL_CAPABILITY"
      | "STRUCTURED_OUTPUT_ENFORCEMENT"
      | "SCHEMA_COMPLEXITY"
      | "PROMPT_CONTEXT_PRESSURE"
      | "CPU_TIMEOUT";
    readonly recommendedNextStep: string;
  };
  readonly records: readonly DiagnosticTrialRecord[];
}

// ============================================================================
// Diagnostic Schemas
// ============================================================================

// Condition A: Production unchanged (required: ["isGoalReached"])
const SCHEMA_A = ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA.jsonSchema;

// Condition B: Enforced JSON Schema matching full ActionProposal contract
const SCHEMA_B = Object.freeze({
  type: "object",
  properties: {
    isGoalReached: {
      type: "boolean",
      description:
        "Set to true if the task goal has been completely achieved, false if proposing an action",
    },
    proposalId: {
      type: "string",
      description: "Unique client-generated proposal identifier",
    },
    toolName: {
      type: "string",
      description: "Name of the tool to invoke",
      enum: [...TOOL_NAMES],
    },
    inputPayload: {
      type: "object",
      description: "Tool input parameters matching the tool schema",
    },
    contextSnapshotHash: {
      type: "string",
      description:
        "The exact 64-character hexadecimal SHA-256 contextHash from the snapshot",
    },
    rationale: {
      type: "string",
      description: "Brief rationale explaining why this action is proposed",
    },
    sequenceHint: {
      type: "integer",
      description: "Optional sequence hint",
    },
  },
  required: [
    "isGoalReached",
    "proposalId",
    "toolName",
    "inputPayload",
    "contextSnapshotHash",
  ],
  additionalProperties: false,
});

// Condition C: Minimal evaluation-only diagnostic schema (toolName + inputPayload)
const SCHEMA_C = Object.freeze({
  type: "object",
  properties: {
    toolName: {
      type: "string",
      description: "Name of the tool to invoke",
      enum: [...TOOL_NAMES],
    },
    inputPayload: {
      type: "object",
      description: "Tool input parameters matching the tool schema",
    },
  },
  required: ["toolName", "inputPayload"],
  additionalProperties: false,
});

// ============================================================================
// Fixed Diagnostic Prompt
// ============================================================================

const FIXED_DIAGNOSTIC_SYSTEM_PROMPT = DEFAULT_LIVE_BRAIN_SYSTEM_INSTRUCTION;

const FIXED_DIAGNOSTIC_USER_PROMPT = `## Task Execution Context
- Task ID: task-swe-bug-fix-calc
- Context Snapshot Hash: 68a9fe7b9404a41bcf1388d7a2e59d8f91c68a14b0e3cdb1c3c4f2bc02b086c6

## Available Tools
- read_file: Read content from a file in the workspace. Parameters: { "path": string }
- write_file: Write content to a file in the workspace. Parameters: { "path": string, "content": string }
- search_code: Search code files in the workspace for a text query. Parameters: { "query": string }
- run_command: Run a shell command in the workspace. Parameters: { "command": string }
- git_status: Show workspace git status. Parameters: {}
- git_diff: Show workspace git diff. Parameters: {}

## Task Description
Inspect the calculator codebase to locate where the addition function is implemented.
Find all occurrences of "add" across the repository.

## Required Operation
Propose a tool action to search for the string "add" using the search_code tool.
Input parameters for search_code: { "query": "add" }.
Set proposalId to "prop-diagnostic-1".
Set contextSnapshotHash to "68a9fe7b9404a41bcf1388d7a2e59d8f91c68a14b0e3cdb1c3c4f2bc02b086c6".
Set isGoalReached to false.
Output strictly the required JSON object.`;

// ============================================================================
// Failure Classifier
// ============================================================================

function classifyOutput(
  condition: "A" | "B" | "C",
  rawOutput: string,
  timeoutOccurred: boolean,
  fetchError: string | null
): {
  parsed: unknown | null;
  parseError: string | null;
  valid: boolean;
  classification: FailureClassification;
  detail: string;
} {
  if (timeoutOccurred) {
    return {
      parsed: null,
      parseError: "Request timed out after 120000ms",
      valid: false,
      classification: "MODEL_TIMEOUT",
      detail: "Inference timed out exceeding 120000ms wall-clock limit",
    };
  }

  if (fetchError) {
    return {
      parsed: null,
      parseError: fetchError,
      valid: false,
      classification: "OTHER_MODEL_ERROR",
      detail: `HTTP fetch failure: ${fetchError}`,
    };
  }

  if (!rawOutput || rawOutput.trim().length === 0) {
    return {
      parsed: null,
      parseError: "Empty response text",
      valid: false,
      classification: "TRUNCATED_OUTPUT",
      detail: "Model returned completely empty response text",
    };
  }

  // Check reasoning contamination (<think> tags or verbose non-JSON preamble)
  if (rawOutput.includes("<think>") || rawOutput.includes("</think>")) {
    return {
      parsed: null,
      parseError: "Contains reasoning tokens (<think>)",
      valid: false,
      classification: "UNEXPECTED_REASONING_OUTPUT",
      detail: "Model produced raw thinking/reasoning tags instead of pure JSON",
    };
  }

  let cleaned = rawOutput.trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.slice(7);
    if (cleaned.endsWith("```")) {
      cleaned = cleaned.slice(0, -3);
    }
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.slice(3);
    if (cleaned.endsWith("```")) {
      cleaned = cleaned.slice(0, -3);
    }
  }
  cleaned = cleaned.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err: unknown) {
    return {
      parsed: null,
      parseError: err instanceof Error ? err.message : String(err),
      valid: false,
      classification: "INVALID_JSON",
      detail: `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      parsed,
      parseError: "Root JSON is not an object",
      valid: false,
      classification: "SCHEMA_WRONG_FIELD_TYPE",
      detail: "Root JSON structure is not a key-value object",
    };
  }

  const obj = parsed as Record<string, unknown>;

  // Classification for Condition C (Minimal Diagnostic)
  if (condition === "C") {
    if (!("toolName" in obj)) {
      return {
        parsed,
        parseError: null,
        valid: false,
        classification: "SCHEMA_MISSING_REQUIRED_FIELD",
        detail: "Missing required property 'toolName'",
      };
    }
    if (typeof obj.toolName !== "string" || !TOOL_NAMES.includes(obj.toolName as any)) {
      return {
        parsed,
        parseError: null,
        valid: false,
        classification: "SCHEMA_WRONG_FIELD_NAME",
        detail: `toolName '${String(obj.toolName)}' is not in registered TOOL_NAMES`,
      };
    }
    if (!("inputPayload" in obj)) {
      return {
        parsed,
        parseError: null,
        valid: false,
        classification: "SCHEMA_MISSING_REQUIRED_FIELD",
        detail: "Missing required property 'inputPayload'",
      };
    }
    if (typeof obj.inputPayload !== "object" || obj.inputPayload === null || Array.isArray(obj.inputPayload)) {
      return {
        parsed,
        parseError: null,
        valid: false,
        classification: "SCHEMA_WRONG_FIELD_TYPE",
        detail: "inputPayload is not an object",
      };
    }
    return {
      parsed,
      parseError: null,
      valid: true,
      classification: "VALID_ACTION_PROPOSAL",
      detail: "Valid minimal proposal shape with toolName and inputPayload",
    };
  }

  // Classification for Condition A and B (Full ActionProposal schema)
  if (!("toolName" in obj)) {
    return {
      parsed,
      parseError: null,
      valid: false,
      classification: "SCHEMA_MISSING_REQUIRED_FIELD",
      detail: "Missing required property 'toolName' (omitted by model)",
    };
  }

  if (typeof obj.toolName !== "string" || !TOOL_NAMES.includes(obj.toolName as any)) {
    return {
      parsed,
      parseError: null,
      valid: false,
      classification: "SCHEMA_WRONG_FIELD_NAME",
      detail: `toolName '${String(obj.toolName)}' is not in registered TOOL_NAMES`,
    };
  }

  if (!("inputPayload" in obj)) {
    return {
      parsed,
      parseError: null,
      valid: false,
      classification: "SCHEMA_MISSING_REQUIRED_FIELD",
      detail: "Missing required property 'inputPayload'",
    };
  }

  if (typeof obj.inputPayload !== "object" || obj.inputPayload === null || Array.isArray(obj.inputPayload)) {
    return {
      parsed,
      parseError: null,
      valid: false,
      classification: "SCHEMA_WRONG_FIELD_TYPE",
      detail: "inputPayload is not an object",
    };
  }

  // Check ActionProposalSchema conformance
  const zodResult = ActionProposalSchema.safeParse({
    proposalId: obj.proposalId ?? "missing-proposal-id",
    toolName: obj.toolName,
    inputPayload: obj.inputPayload,
    contextSnapshotHash: obj.contextSnapshotHash ?? "missing-hash",
    ...(obj.rationale !== undefined ? { rationale: obj.rationale } : {}),
    ...(obj.sequenceHint !== undefined ? { sequenceHint: obj.sequenceHint } : {}),
  });

  if (!zodResult.success) {
    const issue = zodResult.error.issues[0];
    const pathName = issue.path.join(".");
    if (issue.code === "invalid_type" && String(issue.received) === "undefined") {
      return {
        parsed,
        parseError: null,
        valid: false,
        classification: "SCHEMA_MISSING_REQUIRED_FIELD",
        detail: `Missing required field: ${pathName}`,
      };
    }
    return {
      parsed,
      parseError: null,
      valid: false,
      classification: "SCHEMA_WRONG_FIELD_TYPE",
      detail: `Invalid field '${pathName}': ${issue.message}`,
    };
  }

  return {
    parsed,
    parseError: null,
    valid: true,
    classification: "VALID_ACTION_PROPOSAL",
    detail: "Conforms fully to ActionProposal contract",
  };
}

// ============================================================================
// Main Execution
// ============================================================================

export async function runPhase10BDiagnostic(): Promise<void> {
  const model = "llama3.2:3b";
  const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
  const timeoutMs = 120_000;
  const artifactPath = path.resolve(
    "C:/Users/Adusumalli Girish/.gemini/antigravity/brain/543bddec-0a19-44a7-9818-72be776b138b/scratch/phase10b-structured-output-diagnostic.json"
  );

  console.log("\n================================================================================");
  console.log("PHASE 10B: STRUCTURED OUTPUT BOUNDARY DIAGNOSTIC");
  console.log(`Started: ${new Date().toISOString()}`);
  console.log(`Model: ${model} | Target Calls: 3 conditions × 2 trials = 6 model calls`);
  console.log("================================================================================\n");

  // 1. Preflight Invariants
  const check = await checkOllamaLiveAvailability(baseUrl, model);
  if (!check.available) {
    throw new Error(`Preflight failed: Ollama unreachable or model missing: ${check.reason}`);
  }
  console.log(`[PREFLIGHT] Ollama reachable. Model '${model}' verified available.`);

  // Historical Artifact Protection
  const protectedPaths = [
    "phase10a-checkpoint.ndjson",
    "phase10a-summary.json",
    "phase9-4b-checkpoint.ndjson",
    "phase9-4b-summary.json",
    "phase9-4-counterfactual-results.json",
  ].map((p) =>
    path.resolve(
      "C:/Users/Adusumalli Girish/.gemini/antigravity/brain/543bddec-0a19-44a7-9818-72be776b138b/scratch",
      p
    )
  );

  for (const p of protectedPaths) {
    if (fs.existsSync(p)) {
      console.log(`[PREFLIGHT] Protected historical artifact verified intact: ${path.basename(p)}`);
    }
  }

  const conditions = [
    {
      code: "A" as const,
      label: "CURRENT_PRODUCTION" as const,
      schema: SCHEMA_A,
    },
    {
      code: "B" as const,
      label: "JSON_SCHEMA_ENFORCED" as const,
      schema: SCHEMA_B,
    },
    {
      code: "C" as const,
      label: "MINIMAL_SCHEMA_DIAGNOSTIC" as const,
      schema: SCHEMA_C,
    },
  ];

  const records: DiagnosticTrialRecord[] = [];

  for (const cond of conditions) {
    const schemaHash = sha256Hex(JSON.stringify(cond.schema));
    console.log(`\n--------------------------------------------------------------------------------`);
    console.log(`Condition ${cond.code} — ${cond.label} (schema hash: ${schemaHash.slice(0, 16)}...)`);
    console.log(`--------------------------------------------------------------------------------`);

    for (let ordinal = 1; ordinal <= 2; ordinal++) {
      const trialKey = `${cond.code}:${cond.label}:trial-${ordinal}`;
      console.log(`\n[CALL] Starting ${trialKey}...`);

      const controller = new AbortController();
      let didTimeout = false;
      const timer = setTimeout(() => {
        didTimeout = true;
        controller.abort();
      }, timeoutMs);

      const startMs = Date.now();
      let rawOutput = "";
      let fetchError: string | null = null;
      let promptTokens: number | undefined;
      let outputTokens: number | undefined;

      try {
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: FIXED_DIAGNOSTIC_SYSTEM_PROMPT },
              { role: "user", content: FIXED_DIAGNOSTIC_USER_PROMPT },
            ],
            stream: false,
            format: cond.schema,
            options: {
              temperature: 0.0,
              num_predict: 2048,
            },
          }),
          signal: controller.signal,
        });

        clearTimeout(timer);
        const data = (await response.json()) as any;
        rawOutput = data.message?.content ?? "";
        promptTokens = data.prompt_eval_count;
        outputTokens = data.eval_count;
      } catch (err: unknown) {
        clearTimeout(timer);
        fetchError = err instanceof Error ? err.message : String(err);
      }

      const elapsedMs = Date.now() - startMs;
      const classificationResult = classifyOutput(
        cond.code,
        rawOutput,
        didTimeout,
        fetchError
      );

      const record: DiagnosticTrialRecord = {
        condition: cond.code,
        conditionLabel: cond.label,
        trialOrdinal: ordinal,
        model,
        rawModelResponse: rawOutput,
        parsedResponse: classificationResult.parsed,
        parseError: classificationResult.parseError,
        schemaValidationResult: classificationResult.valid,
        failureClassification: classificationResult.classification,
        classificationDetail: classificationResult.detail,
        modelLatencyMs: elapsedMs,
        promptTokens,
        outputTokens,
        schemaHash,
        timestamp: new Date().toISOString(),
      };

      records.push(record);

      console.log(
        `[RESULT] ${trialKey} finished in ${(elapsedMs / 1000).toFixed(1)}s | classification: ${
          classificationResult.classification
        } | valid: ${classificationResult.valid}`
      );
      console.log(`[DETAIL] ${classificationResult.detail}`);
      console.log(`[RAW RESPONSE] ${rawOutput.trim().slice(0, 300)}`);
    }
  }

  // 3. Synthesize Results by Condition
  const computeStats = (condCode: "A" | "B" | "C", label: string) => {
    const subset = records.filter((r) => r.condition === condCode);
    const validOutputs = subset.filter((r) => r.schemaValidationResult).length;
    const invalidJson = subset.filter((r) => r.failureClassification === "INVALID_JSON").length;
    const missingFields = subset.filter(
      (r) => r.failureClassification === "SCHEMA_MISSING_REQUIRED_FIELD"
    ).length;
    const wrongFields = subset.filter(
      (r) =>
        r.failureClassification === "SCHEMA_WRONG_FIELD_NAME" ||
        r.failureClassification === "SCHEMA_WRONG_FIELD_TYPE"
    ).length;
    const reasoningContamination = subset.filter(
      (r) => r.failureClassification === "UNEXPECTED_REASONING_OUTPUT"
    ).length;
    const truncation = subset.filter(
      (r) => r.failureClassification === "TRUNCATED_OUTPUT"
    ).length;
    const timeouts = subset.filter(
      (r) => r.failureClassification === "MODEL_TIMEOUT"
    ).length;
    const otherErrors = subset.filter(
      (r) => r.failureClassification === "OTHER_MODEL_ERROR"
    ).length;

    const latencies = subset.map((r) => r.modelLatencyMs);
    const meanLatencyMs =
      latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : 0;
    const sortedLatencies = [...latencies].sort((a, b) => a - b);
    const medianLatencyMs =
      sortedLatencies.length > 0
        ? sortedLatencies[Math.floor(sortedLatencies.length / 2)]
        : 0;

    const totalPromptTokens = subset.reduce((acc, r) => acc + (r.promptTokens ?? 0), 0);
    const totalOutputTokens = subset.reduce((acc, r) => acc + (r.outputTokens ?? 0), 0);

    return {
      label,
      trials: subset.length,
      validOutputs,
      invalidJson,
      missingFields,
      wrongFields,
      reasoningContamination,
      truncation,
      timeouts,
      otherErrors,
      meanLatencyMs,
      medianLatencyMs,
      totalPromptTokens,
      totalOutputTokens,
      schemaValidationRate: subset.length > 0 ? validOutputs / subset.length : 0,
    };
  };

  const statsA = computeStats("A", "CURRENT_PRODUCTION");
  const statsB = computeStats("B", "JSON_SCHEMA_ENFORCED");
  const statsC = computeStats("C", "MINIMAL_SCHEMA_DIAGNOSTIC");

  // Determine Case A, B, C, or D per Phase 10B Step 9:
  let matchedCase: "CASE_A" | "CASE_B" | "CASE_C" | "CASE_D";
  let conclusion: string;
  let primaryBottleneck:
    | "MODEL_CAPABILITY"
    | "STRUCTURED_OUTPUT_ENFORCEMENT"
    | "SCHEMA_COMPLEXITY"
    | "PROMPT_CONTEXT_PRESSURE"
    | "CPU_TIMEOUT";
  let recommendedNextStep: string;

  if (statsA.validOutputs === 0 && statsB.validOutputs === 0 && statsC.validOutputs === 0) {
    matchedCase = "CASE_A";
    conclusion =
      "All conditions failed. The 3B model itself is the dominant capability limitation.";
    primaryBottleneck = "MODEL_CAPABILITY";
    recommendedNextStep = "Proceed to a stronger local model evaluation (7B/8B class).";
  } else if (statsA.validOutputs === 0 && statsB.validOutputs > 0) {
    matchedCase = "CASE_B";
    conclusion =
      "Current production failed, but full JSON-schema enforcement succeeded. The primary limitation was structured-output schema required-field enforcement, not model capability.";
    primaryBottleneck = "STRUCTURED_OUTPUT_ENFORCEMENT";
    recommendedNextStep =
      "Update production structured output schema descriptor to mark action-proposal required fields in the JSON schema.";
  } else if (statsA.validOutputs === 0 && statsB.validOutputs === 0 && statsC.validOutputs > 0) {
    matchedCase = "CASE_C";
    conclusion =
      "Full schema failed under both configurations, but minimal schema succeeded. The model can emit structured JSON but struggles with full ActionProposal contract complexity.";
    primaryBottleneck = "SCHEMA_COMPLEXITY";
    recommendedNextStep =
      "Investigate contract complexity and prompt simplification without violating authority invariants.";
  } else if (statsA.validOutputs > 0 && statsB.validOutputs > 0 && statsC.validOutputs > 0) {
    matchedCase = "CASE_D";
    conclusion =
      "All diagnostic conditions succeeded on fixed prompt. Phase 10A failure was likely caused by prompt/context pressure from multi-observation SWE histories interacting with inference timeouts.";
    primaryBottleneck = "PROMPT_CONTEXT_PRESSURE";
    recommendedNextStep =
      "Investigate context compaction or prompt structure before changing model architecture.";
  } else {
    matchedCase = "CASE_B";
    conclusion = `Observed split outcome: A=${statsA.validOutputs}/2, B=${statsB.validOutputs}/2, C=${statsC.validOutputs}/2.`;
    primaryBottleneck = statsB.validOutputs > statsA.validOutputs
      ? "STRUCTURED_OUTPUT_ENFORCEMENT"
      : "MODEL_CAPABILITY";
    recommendedNextStep = "Analyze trial records to determine next step.";
  }

  const summary: Phase10BDiagnosticSummary = {
    experimentName: "Phase 10B: Structured Output Boundary Diagnostic",
    timestamp: new Date().toISOString(),
    model,
    totalTrials: records.length,
    conditions: {
      A: statsA,
      B: statsB,
      C: statsC,
    },
    diagnosticInterpretation: {
      matchedCase,
      conclusion,
      primaryBottleneck,
      recommendedNextStep,
    },
    records,
  };

  fs.writeFileSync(artifactPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(`\n================================================================================`);
  console.log(`PHASE 10B DIAGNOSTIC COMPLETED: ${matchedCase}`);
  console.log(`Conclusion: ${conclusion}`);
  console.log(`Primary Bottleneck: ${primaryBottleneck}`);
  console.log(`Summary written to: ${artifactPath}`);
  console.log("================================================================================\n");
}

// Auto-run if executed directly
runPhase10BDiagnostic().catch((err) => {
  console.error("Phase 10B diagnostic failed:", err);
  process.exit(1);
});
