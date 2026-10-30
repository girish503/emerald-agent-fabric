/**
 * Phase 10F — Tool-Input Schema Capability Diagnostic Runner.
 *
 * Investigates whether llama3.2:3b on CPU can reliably generate schema-compliant
 * tool arguments for `search_code` when the tool's input contract is made clearer
 * in the model-facing tool description, without changing the underlying tool contract,
 * validator, governance, or execution system.
 *
 * Invariants & Constraints:
 * 1. Model: llama3.2:3b via local Ollama (http://127.0.0.1:11434). Timeout: 120,000ms. Temp: 0.0.
 * 2. Zero execution: Executes no tools, accesses no workspace, touches no SQLite, invokes no Reflex.
 * 3. Matrix: Exactly 3 conditions (CURRENT, EXPLICIT, EXAMPLE_GUIDED) × 5 trials = 15 model calls.
 * 4. Production Schemas Frozen: SearchCodeInputSchema and ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA are unchanged.
 * 5. Artifact Protection: phase9*, phase10a*, phase10b*, phase10c*, phase10e* artifacts are never overwritten.
 * 6. Hard Stop: Immediately halt after the 15 trials. Do not modify production code.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { OllamaModelProvider } from "../src/adapters/models/ollama-model-provider.js";
import { checkOllamaLiveAvailability } from "../src/application/evaluation/live-swe-evaluation.js";
import {
  ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA,
  DEFAULT_LIVE_BRAIN_SYSTEM_INSTRUCTION,
  LiveAgentBrain,
} from "../src/application/live-agent-brain.js";
import {
  INITIAL_TOOL_DEFINITIONS,
  SEARCH_CODE_TOOL,
  ToolDefinition,
} from "../src/domain/tool.js";
import { SearchCodeInputSchema } from "../src/domain/tool-schemas.js";
import {
  ContextSnapshot,
  Observation,
} from "../src/domain/context.js";
import { AgentBrainRequest } from "../src/ports/agent-brain.port.js";
import { canonicalJsonStringify } from "../src/domain/canonical-hash.js";

// ============================================================================
// Paths & Artifact Protection
// ============================================================================

const SCRATCH_DIR = path.resolve(
  "C:/Users/Adusumalli Girish/.gemini/antigravity/brain/543bddec-0a19-44a7-9818-72be776b138b/scratch"
);

const TARGET_ARTIFACT_PATH = path.join(SCRATCH_DIR, "phase10f-tool-input-diagnostic.json");

const HISTORICAL_ARTIFACTS: readonly string[] = Object.freeze([
  "phase9-4b-checkpoint.ndjson",
  "phase9-4b-summary.json",
  "phase9-4-counterfactual-results.json",
  "phase10a-checkpoint.ndjson",
  "phase10a-summary.json",
  "phase10b-structured-output-diagnostic.json",
  "phase10c-schema-union-diagnostic.json",
  "phase10e-checkpoint.ndjson",
  "phase10e-summary.json",
]);

// ============================================================================
// Diagnostic Conditions
// ============================================================================

export type DiagnosticConditionId =
  | "CURRENT"
  | "EXPLICIT_SCHEMA"
  | "EXAMPLE_GUIDED";

export interface DiagnosticConditionSpec {
  readonly id: DiagnosticConditionId;
  readonly name: string;
  readonly description: string;
  readonly searchCodeDescription: string;
}

export const DIAGNOSTIC_CONDITIONS: readonly DiagnosticConditionSpec[] = Object.freeze([
  {
    id: "CURRENT",
    name: "Condition A — Current Production Description",
    description: "Exact current production description with zero schema guidance.",
    searchCodeDescription: SEARCH_CODE_TOOL.description,
  },
  {
    id: "EXPLICIT_SCHEMA",
    name: "Condition B — Explicit Input Schema",
    description: "Provides semantic contract with explicit query field requirement and invalid fields warning.",
    searchCodeDescription:
      "Performs regex or literal text pattern matching across workspace files.\n" +
      "Input schema:\n" +
      "{\n" +
      '  "query": string\n' +
      "}\n" +
      "Required field: query (the search text or pattern)\n" +
      "Do not use: pattern, filePath, filePaths, content, filename",
  },
  {
    id: "EXAMPLE_GUIDED",
    name: "Condition C — Concrete Minimal Example",
    description: "Provides input schema plus one minimal concrete valid example and invalid fields warning.",
    searchCodeDescription:
      "Performs regex or literal text pattern matching across workspace files.\n" +
      "Input schema:\n" +
      "{\n" +
      '  "query": string\n' +
      "}\n" +
      "Valid example:\n" +
      "{\n" +
      '  "query": "add"\n' +
      "}\n" +
      "Do not use: pattern, filePath, filePaths, content, filename",
  },
]);

// ============================================================================
// Classification Taxonomy
// ============================================================================

export type ResponseClassification =
  | "VALID_TOOL_INPUT"
  | "MISSING_INPUT_PAYLOAD"
  | "MISSING_QUERY"
  | "WRONG_QUERY_TYPE"
  | "INVENTED_PATTERN_FIELD"
  | "INVENTED_FILEPATH_FIELD"
  | "INVENTED_FILEPATHS_FIELD"
  | "OTHER_UNKNOWN_FIELD"
  | "WRONG_TOOL"
  | "MODEL_TIMEOUT"
  | "INVALID_JSON"
  | "OTHER_MODEL_ERROR";

export interface TrialRecord {
  readonly conditionId: DiagnosticConditionId;
  readonly trialOrdinal: number;
  readonly rawModelResponse?: string;
  readonly parsedProposal?: unknown;
  readonly toolName?: string;
  readonly inputPayload?: unknown;
  readonly inputHash?: string;
  readonly schemaValidation: {
    readonly valid: boolean;
    readonly errorMessages?: readonly string[];
  };
  readonly classification: ResponseClassification;
  readonly flags: {
    readonly isTimeout: boolean;
    readonly hasPatternField: boolean;
    readonly hasFilePathField: boolean;
    readonly hasFilePathsField: boolean;
    readonly hasUnknownField: boolean;
    readonly hasMissingQuery: boolean;
    readonly isValidToolInput: boolean;
  };
  readonly latencyMs: number;
  readonly promptTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export function classifyResponse(params: {
  isTimeout: boolean;
  modelError?: string;
  rawText?: string;
  parsedProposal?: any;
  toolName?: string;
  inputPayload?: any;
}): {
  classification: ResponseClassification;
  validationResult: { valid: boolean; errorMessages?: string[] };
  flags: {
    isTimeout: boolean;
    hasPatternField: boolean;
    hasFilePathField: boolean;
    hasFilePathsField: boolean;
    hasUnknownField: boolean;
    hasMissingQuery: boolean;
    isValidToolInput: boolean;
  };
} {
  const { isTimeout, modelError, parsedProposal, toolName, inputPayload } = params;

  if (isTimeout) {
    return {
      classification: "MODEL_TIMEOUT",
      validationResult: { valid: false, errorMessages: ["Model inference timed out"] },
      flags: {
        isTimeout: true,
        hasPatternField: false,
        hasFilePathField: false,
        hasFilePathsField: false,
        hasUnknownField: false,
        hasMissingQuery: false,
        isValidToolInput: false,
      },
    };
  }

  if (modelError && modelError.includes("Failed to parse model output as JSON")) {
    return {
      classification: "INVALID_JSON",
      validationResult: { valid: false, errorMessages: [modelError] },
      flags: {
        isTimeout: false,
        hasPatternField: false,
        hasFilePathField: false,
        hasFilePathsField: false,
        hasUnknownField: false,
        hasMissingQuery: false,
        isValidToolInput: false,
      },
    };
  }

  if (modelError && !parsedProposal) {
    return {
      classification: "OTHER_MODEL_ERROR",
      validationResult: { valid: false, errorMessages: [modelError] },
      flags: {
        isTimeout: false,
        hasPatternField: false,
        hasFilePathField: false,
        hasFilePathsField: false,
        hasUnknownField: false,
        hasMissingQuery: false,
        isValidToolInput: false,
      },
    };
  }

  if (toolName !== "search_code") {
    return {
      classification: "WRONG_TOOL",
      validationResult: { valid: false, errorMessages: [`Expected search_code, got ${toolName}`] },
      flags: {
        isTimeout: false,
        hasPatternField: false,
        hasFilePathField: false,
        hasFilePathsField: false,
        hasUnknownField: false,
        hasMissingQuery: false,
        isValidToolInput: false,
      },
    };
  }

  if (inputPayload === null || typeof inputPayload !== "object" || Array.isArray(inputPayload)) {
    return {
      classification: "MISSING_INPUT_PAYLOAD",
      validationResult: { valid: false, errorMessages: ["inputPayload is null or not an object"] },
      flags: {
        isTimeout: false,
        hasPatternField: false,
        hasFilePathField: false,
        hasFilePathsField: false,
        hasUnknownField: false,
        hasMissingQuery: true,
        isValidToolInput: false,
      },
    };
  }

  const payloadObj = inputPayload as Record<string, unknown>;
  const hasPattern = "pattern" in payloadObj;
  const hasFilePath = "filePath" in payloadObj;
  const hasFilePaths = "filePaths" in payloadObj;
  const hasQuery = "query" in payloadObj;
  const isQueryString = typeof payloadObj.query === "string";

  // Check against strict SearchCodeInputSchema
  const parseRes = SearchCodeInputSchema.safeParse(inputPayload);
  const errorMessages: string[] = [];
  let hasUnknown = false;

  if (!parseRes.success) {
    for (const issue of parseRes.error.issues) {
      errorMessages.push(`${issue.path.join(".")}: ${issue.message}`);
      if (issue.code === "unrecognized_keys") {
        hasUnknown = true;
      }
    }
  }

  const flags = {
    isTimeout: false,
    hasPatternField: hasPattern,
    hasFilePathField: hasFilePath,
    hasFilePathsField: hasFilePaths,
    hasUnknownField: hasUnknown,
    hasMissingQuery: !hasQuery,
    isValidToolInput: parseRes.success,
  };

  if (parseRes.success) {
    return {
      classification: "VALID_TOOL_INPUT",
      validationResult: { valid: true },
      flags,
    };
  }

  // Hierarchy of primary classification
  let primaryClassification: ResponseClassification;
  if (hasPattern) {
    primaryClassification = "INVENTED_PATTERN_FIELD";
  } else if (hasFilePaths) {
    primaryClassification = "INVENTED_FILEPATHS_FIELD";
  } else if (hasFilePath) {
    primaryClassification = "INVENTED_FILEPATH_FIELD";
  } else if (!hasQuery) {
    primaryClassification = "MISSING_QUERY";
  } else if (!isQueryString) {
    primaryClassification = "WRONG_QUERY_TYPE";
  } else if (hasUnknown) {
    primaryClassification = "OTHER_UNKNOWN_FIELD";
  } else {
    primaryClassification = "OTHER_MODEL_ERROR";
  }

  return {
    classification: primaryClassification,
    validationResult: { valid: false, errorMessages },
    flags,
  };
}

// ============================================================================
// Main Diagnostic Execution
// ============================================================================

export async function runPhase10FDiagnostic(): Promise<void> {
  console.log("\n================================================================================");
  console.log("PHASE 10F: TOOL-INPUT SCHEMA CAPABILITY DIAGNOSTIC (LLAMA 3.2:3B)");
  console.log(`Started: ${new Date().toISOString()}`);
  console.log("================================================================================\n");

  const model = "llama3.2:3b";
  const baseUrl = "http://127.0.0.1:11434";
  const timeoutMs = 120_000;
  const trialsPerCondition = 5;

  // 1. Preflight Invariants
  const check = await checkOllamaLiveAvailability(baseUrl, model);
  if (!check.available) {
    throw new Error(`Preflight failed: Ollama unreachable or model missing: ${check.reason}`);
  }
  console.log(`[PREFLIGHT] Ollama reachable at ${baseUrl}. Model '${model}' verified available.`);

  // Historical Artifact Protection
  for (const hist of HISTORICAL_ARTIFACTS) {
    const full = path.join(SCRATCH_DIR, hist);
    if (!fs.existsSync(full)) {
      throw new Error(`Preflight failed: Historical artifact missing: ${hist}`);
    }
  }
  console.log(`[PREFLIGHT] All ${HISTORICAL_ARTIFACTS.length} historical artifacts verified protected.`);

  // 2. Fixed Context Snapshot
  const contextSnapshotHash = "0".repeat(63) + "1";
  const fixedObservation: Observation = Object.freeze({
    observationId: "obs-diagnostic-search-directive",
    category: "MISSION_CONTEXT",
    priority: 100,
    freshness: "CURRENT",
    content: {
      instruction: "Search the repository for occurrences of the string 'add'.",
    },
    provenance: {
      entityKind: "MissionContract",
      entityId: "diagnostic-contract-phase10f",
      runId: "run-diagnostic-phase10f",
    },
    recordedAt: new Date().toISOString(),
  });

  const fixedContextSnapshot: ContextSnapshot = Object.freeze({
    snapshotId: "ctx-diagnostic-phase10f",
    taskId: "task-diagnostic-search-code",
    contextHash: contextSnapshotHash,
    observations: Object.freeze([fixedObservation]),
    totalEstimatedTokens: 50,
    totalBytes: 200,
    omittedObservationsCount: 0,
  });

  // 3. Instrumented Ollama Provider
  let callIndex = 0;
  const instrumentedFetch = async (
    url: string | URL,
    init?: RequestInit
  ): Promise<Response> => {
    callIndex++;
    const num = callIndex;
    const start = Date.now();
    console.log(`[${new Date().toISOString()}] [Call #${num}/15] START calling Ollama /api/chat...`);
    try {
      const res = await fetch(url, init);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const clone = res.clone();
      try {
        const body = await clone.json();
        console.log(
          `[${new Date().toISOString()}] [Call #${num}/15] DONE in ${elapsed}s | prompt_tok: ${body.prompt_eval_count ?? 0} | eval_tok: ${body.eval_count ?? 0}`
        );
      } catch {
        console.log(`[${new Date().toISOString()}] [Call #${num}/15] DONE in ${elapsed}s | status: ${res.status}`);
      }
      return res;
    } catch (err) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.error(`[${new Date().toISOString()}] [Call #${num}/15] FAILED in ${elapsed}s:`, err);
      throw err;
    }
  };

  const provider = new OllamaModelProvider({
    baseURL: baseUrl,
    defaultModel: model,
    timeoutMs,
    fetch: instrumentedFetch,
  });

  const brain = new LiveAgentBrain({
    modelProvider: provider,
    model,
    systemInstruction: DEFAULT_LIVE_BRAIN_SYSTEM_INSTRUCTION,
    generationOptions: {
      temperature: 0.0,
      maxOutputTokens: 512,
    },
    timeoutMs,
  });

  const records: TrialRecord[] = [];

  // 4. Execution of Trial Matrix: 3 conditions × 5 trials
  for (const condition of DIAGNOSTIC_CONDITIONS) {
    console.log(`\n--------------------------------------------------------------------------------`);
    console.log(`[CONDITION] ${condition.name} (${condition.id})`);
    console.log(`Description:\n${condition.searchCodeDescription}`);
    console.log(`--------------------------------------------------------------------------------`);

    // Build custom tool list replacing search_code description
    const customTools: ToolDefinition[] = INITIAL_TOOL_DEFINITIONS.map((tool) => {
      if (tool.name === "search_code") {
        return {
          ...tool,
          description: condition.searchCodeDescription,
        };
      }
      return tool;
    });

    for (let trial = 1; trial <= trialsPerCondition; trial++) {
      console.log(`\n[TRIAL] Condition: ${condition.id} | Trial: ${trial}/${trialsPerCondition}`);

      const request: AgentBrainRequest = {
        contextSnapshot: fixedContextSnapshot,
        availableTools: customTools,
        sequenceNumber: 1,
        runId: `run-diagnostic-${condition.id}-${trial}`,
      };

      const startMonotonic = performance.now();
      let isTimeout = false;
      let modelError: string | undefined;
      let brainResult: any;

      try {
        brainResult = await brain.proposeAction(request);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("ETIMEDOUT")) {
          isTimeout = true;
        } else {
          modelError = msg;
        }
      }

      const latencyMs = Math.round(performance.now() - startMonotonic);

      if (brainResult && brainResult.finishReason === "ERROR") {
        modelError = brainResult.error;
      }

      const proposal = brainResult?.proposal;
      const rawText = brainResult?.rawOutput;
      const toolName = proposal?.toolName;
      const inputPayload = proposal?.inputPayload;

      let inputHash: string | undefined;
      if (inputPayload && typeof inputPayload === "object") {
        inputHash = crypto
          .createHash("sha256")
          .update(canonicalJsonStringify(inputPayload))
          .digest("hex");
      }

      const { classification, validationResult, flags } = classifyResponse({
        isTimeout,
        modelError,
        rawText,
        parsedProposal: proposal,
        toolName,
        inputPayload,
      });

      console.log(`[RESULT] Classification: ${classification} | Valid: ${validationResult.valid} | Latency: ${(latencyMs / 1000).toFixed(1)}s`);
      if (inputPayload) {
        console.log(`[PAYLOAD] ${JSON.stringify(inputPayload)}`);
      }
      if (validationResult.errorMessages && validationResult.errorMessages.length > 0) {
        console.log(`[VALIDATION ERRORS] ${validationResult.errorMessages.join("; ")}`);
      }

      records.push({
        conditionId: condition.id,
        trialOrdinal: trial,
        rawModelResponse: rawText,
        parsedProposal: proposal,
        toolName,
        inputPayload,
        inputHash,
        schemaValidation: validationResult,
        classification,
        flags,
        latencyMs,
        promptTokens: brainResult?.modelMetadata?.promptTokens,
        outputTokens: brainResult?.modelMetadata?.completionTokens,
        totalTokens: brainResult?.modelMetadata?.totalTokens,
      });
    }
  }

  // 5. Synthesis & Metrics Computation per Condition
  const computeConditionMetrics = (condId: DiagnosticConditionId) => {
    const condRecords = records.filter((r) => r.conditionId === condId);
    const n = condRecords.length;
    const validCount = condRecords.filter((r) => r.flags.isValidToolInput).length;
    const patternCount = condRecords.filter((r) => r.flags.hasPatternField).length;
    const filePathCount = condRecords.filter((r) => r.flags.hasFilePathField).length;
    const filePathsCount = condRecords.filter((r) => r.flags.hasFilePathsField).length;
    const unknownCount = condRecords.filter((r) => r.flags.hasUnknownField).length;
    const timeoutCount = condRecords.filter((r) => r.flags.isTimeout).length;

    const latencies = condRecords.map((r) => r.latencyMs).sort((a, b) => a - b);
    const meanLatency = latencies.reduce((a, b) => a + b, 0) / (n || 1);
    const medianLatency = latencies.length > 0 ? latencies[Math.floor(latencies.length / 2)] : 0;

    return {
      totalTrials: n,
      validToolInputCount: validCount,
      validToolInputRate: n > 0 ? validCount / n : 0,
      invalidToolInputRate: n > 0 ? (n - validCount) / n : 0,
      patternFieldRate: n > 0 ? patternCount / n : 0,
      filePathFieldRate: n > 0 ? filePathCount / n : 0,
      filePathsFieldRate: n > 0 ? filePathsCount / n : 0,
      unknownFieldRate: n > 0 ? unknownCount / n : 0,
      timeoutRate: n > 0 ? timeoutCount / n : 0,
      meanLatencyMs: Math.round(meanLatency),
      medianLatencyMs: Math.round(medianLatency),
      classificationBreakdown: condRecords.reduce((acc, r) => {
        acc[r.classification] = (acc[r.classification] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    };
  };

  const currentMetrics = computeConditionMetrics("CURRENT");
  const explicitMetrics = computeConditionMetrics("EXPLICIT_SCHEMA");
  const exampleMetrics = computeConditionMetrics("EXAMPLE_GUIDED");

  // Determine Primary Interpretation Case
  let primaryCase: "CASE_A" | "CASE_B" | "CASE_C" | "CASE_D";
  let caseInterpretation: string;

  if (
    currentMetrics.validToolInputRate >= 0.8 &&
    explicitMetrics.validToolInputRate >= 0.8 &&
    exampleMetrics.validToolInputRate >= 0.8
  ) {
    primaryCase = "CASE_D";
    caseInterpretation =
      "All conditions achieved high validity under minimal diagnostic context. Phase 10E failures were driven by larger SWE context pressure rather than fundamental tool-schema adherence.";
  } else if (
    exampleMetrics.validToolInputRate > explicitMetrics.validToolInputRate &&
    exampleMetrics.validToolInputRate >= 0.6
  ) {
    primaryCase = "CASE_C";
    caseInterpretation =
      "Concrete example materially improved schema adherence over explicit schema description alone (EXAMPLE_GUIDED >> EXPLICIT). Few-shot grounding provides effective intervention.";
  } else if (explicitMetrics.validToolInputRate > currentMetrics.validToolInputRate && explicitMetrics.validToolInputRate >= 0.6) {
    primaryCase = "CASE_B";
    caseInterpretation =
      "Explicit schema description materially improved tool-input conformance over current description (EXPLICIT >> CURRENT). Tool-schema communication is a significant model-facing bottleneck.";
  } else {
    primaryCase = "CASE_A";
    caseInterpretation =
      "Schema guidance does not sufficiently resolve tool argument invalidity across conditions (CURRENT ≈ EXPLICIT ≈ EXAMPLE). Llama 3.2:3B exhibits insufficient parameter-schema adherence. Recommend evaluating a stronger local model.";
  }

  // Latency Analysis
  const allLatencies = records.map((r) => r.latencyMs);
  const totalTimeouts = records.filter((r) => r.flags.isTimeout).length;
  const overallMeanLatency = allLatencies.reduce((a, b) => a + b, 0) / (allLatencies.length || 1);

  const summary = {
    experimentName: "Phase 10F: Tool-Input Schema Capability Diagnostic",
    timestamp: new Date().toISOString(),
    model,
    trialsPerCondition,
    totalModelCalls: records.length,
    step1CurrentDescriptionAudit: {
      toolName: SEARCH_CODE_TOOL.name,
      currentDescription: SEARCH_CODE_TOOL.description,
      inputSchemaExposedToModel: false,
      requiredFieldsExposedToModel: [],
      examplesExposedToModel: [],
      serializedModelPromptSnippet:
        `- search_code (capability: ${SEARCH_CODE_TOOL.requiredCapability}, idempotency: ${SEARCH_CODE_TOOL.idempotency}): ${SEARCH_CODE_TOOL.description}`,
    },
    conditionMetrics: {
      CURRENT: currentMetrics,
      EXPLICIT_SCHEMA: explicitMetrics,
      EXAMPLE_GUIDED: exampleMetrics,
    },
    latencyAnalysis: {
      overallMeanLatencyMs: Math.round(overallMeanLatency),
      totalTimeouts,
      timeoutRate: records.length > 0 ? totalTimeouts / records.length : 0,
      observation:
        totalTimeouts === 0
          ? `Minimal diagnostic context eliminated CPU inference timeouts entirely (0/${records.length} timeouts, mean latency ${(overallMeanLatency / 1000).toFixed(1)}s vs 20/36 timeouts in Phase 10E).`
          : `${totalTimeouts}/${records.length} calls timed out even under minimal diagnostic context.`,
    },
    interpretation: {
      primaryCase,
      caseInterpretation,
    },
    records,
  };

  fs.writeFileSync(TARGET_ARTIFACT_PATH, JSON.stringify(summary, null, 2), "utf8");
  console.log(`\n================================================================================`);
  console.log(`[STORAGE] Diagnostic summary written to: ${TARGET_ARTIFACT_PATH}`);
  console.log(`[INTERPRETATION] Assigned: ${primaryCase}`);
  console.log(`[DETAILS] ${caseInterpretation}`);
  console.log("================================================================================\n");
}

// Auto-run if executed directly
runPhase10FDiagnostic().catch((err) => {
  console.error("Phase 10F diagnostic failed:", err);
  process.exit(1);
});
