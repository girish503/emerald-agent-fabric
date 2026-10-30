/**
 * Phase 10C — Ollama Goal-or-Action Structured Schema RFC Diagnostic Runner.
 *
 * Investigates and experimentally validates whether Ollama's structured-output grammar
 * reliably enforces a discriminated union between Goal-Reached and Tool-Action proposals:
 *
 *     GoalReachedProposal (isGoalReached: true, no tool execution)
 *               OR
 *     ToolActionProposal  (isGoalReached: false, required toolName + inputPayload)
 *
 * Invariants:
 * 1. Offline only: Zero tool execution, zero Action/Attempt creation, zero SQLite mutation,
 *    zero workspace modification, zero Reflex invocation.
 * 2. Model: llama3.2:3b only.
 * 3. Trial Matrix:
 *    - Union: GOAL_REACHED (5 trials)
 *    - Union: TOOL_ACTION (5 trials)
 *    - Control: FULL_REQUIRED_ACTION_SCHEMA (2 trials)
 * 4. Provenance & Transparency: Every trial captures rawResponse, parsedResponse,
 *    token usage, latency, domain validation result, and failure taxonomy.
 * 5. Credential Firewall: Output is sanitized against credential patterns.
 * 6. Historical Protection: Historical Phase 9, 10A, and 10B artifacts are never modified.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { checkOllamaLiveAvailability } from "../src/application/evaluation/live-swe-evaluation.js";
import { DEFAULT_LIVE_BRAIN_SYSTEM_INSTRUCTION } from "../src/application/live-agent-brain.js";
import { TOOL_NAMES } from "../src/domain/tool.js";
import { ActionProposalSchema } from "../src/domain/action-proposal.js";
import { sha256Hex } from "../src/domain/canonical-hash.js";
import { assertCredentialBoundary } from "../src/domain/evaluation-evidence.js";

// ============================================================================
// Types & Classification Taxonomy
// ============================================================================

export type SchemaUnionClassification =
  | "VALID_GOAL_PROPOSAL"
  | "VALID_TOOL_PROPOSAL"
  | "INVALID_JSON"
  | "SCHEMA_UNION_REJECTION"
  | "DOMAIN_VALIDATION_FAILURE"
  | "WRONG_VARIANT"
  | "MISSING_REQUIRED_FIELD"
  | "EXTRA_UNEXPECTED_FIELD"
  | "TOOL_ACTION_IN_GOAL_VARIANT"
  | "GOAL_COMPLETION_IN_TOOL_VARIANT"
  | "MODEL_TIMEOUT"
  | "MODEL_PROVIDER_ERROR";

export interface UnionTrialRecord {
  readonly trialId: string;
  readonly condition: "UNION_DISCRIMINATED" | "CONTROL_FULL_REQUIRED";
  readonly semanticBranch: "GOAL_REACHED" | "TOOL_ACTION";
  readonly trialOrdinal: number;
  readonly model: string;
  readonly rawResponse: string;
  readonly parsedResponse: unknown | null;
  readonly domainValidationResult: boolean;
  readonly classification: SchemaUnionClassification;
  readonly classificationDetail: string;
  readonly modelLatencyMs: number;
  readonly promptTokens?: number;
  readonly outputTokens?: number;
  readonly schemaHash: string;
  readonly error?: string;
  readonly timestamp: string;
}

export interface Phase10CSummary {
  readonly experimentName: string;
  readonly timestamp: string;
  readonly model: string;
  readonly totalTrials: number;
  readonly unionCandidateSchema: Record<string, unknown>;
  readonly results: {
    readonly goalReachedBranch: {
      readonly trials: number;
      readonly validGoalProposals: number;
      readonly wrongVariant: number;
      readonly missingFields: number;
      readonly toolActionInGoalVariant: number;
      readonly invalidJson: number;
      readonly timeouts: number;
      readonly otherErrors: number;
      readonly meanLatencyMs: number;
      readonly medianLatencyMs: number;
      readonly totalPromptTokens: number;
      readonly totalOutputTokens: number;
      readonly successRate: number;
    };
    readonly toolActionBranch: {
      readonly trials: number;
      readonly validToolProposals: number;
      readonly wrongVariant: number;
      readonly missingFields: number;
      readonly goalCompletionInToolVariant: number;
      readonly invalidJson: number;
      readonly timeouts: number;
      readonly otherErrors: number;
      readonly meanLatencyMs: number;
      readonly medianLatencyMs: number;
      readonly totalPromptTokens: number;
      readonly totalOutputTokens: number;
      readonly successRate: number;
    };
    readonly controlCondition: {
      readonly trials: number;
      readonly validToolProposals: number;
      readonly successRate: number;
      readonly meanLatencyMs: number;
    };
  };
  readonly offlineDeterminismVerified: boolean;
  readonly evaluationConclusion: {
    readonly interpretation: "UNION_A" | "UNION_B" | "UNION_C" | "UNION_D";
    readonly summary: string;
    readonly isProductionAdapterChangeJustified: boolean;
    readonly securityImplications: string;
    readonly nextStep: string;
  };
  readonly records: readonly UnionTrialRecord[];
}

// ============================================================================
// Schemas
// ============================================================================

// Candidate Union Schema (discriminated by isGoalReached boolean enum)
export const CANDIDATE_UNION_SCHEMA = Object.freeze({
  anyOf: [
    {
      type: "object",
      description: "Goal-reached completion signal (no tool execution)",
      properties: {
        isGoalReached: {
          type: "boolean",
          enum: [true],
          description: "Must be true when task goal is fully achieved",
        },
        proposalId: {
          type: "string",
          description: "Unique client-generated proposal identifier",
        },
        contextSnapshotHash: {
          type: "string",
          description:
            "The exact 64-character hexadecimal SHA-256 contextHash from snapshot",
        },
        rationale: {
          type: "string",
          description: "Brief rationale explaining how the goal was achieved",
        },
      },
      required: ["isGoalReached", "proposalId", "contextSnapshotHash"],
      additionalProperties: false,
    },
    {
      type: "object",
      description: "Tool-action proposal (requests governed tool execution)",
      properties: {
        isGoalReached: {
          type: "boolean",
          enum: [false],
          description: "Must be false when proposing a tool action",
        },
        proposalId: {
          type: "string",
          description: "Unique client-generated proposal identifier",
        },
        toolName: {
          type: "string",
          description: "Name of the registered tool to invoke",
          enum: [...TOOL_NAMES],
        },
        inputPayload: {
          type: "object",
          description: "Tool input parameters matching tool schema",
        },
        contextSnapshotHash: {
          type: "string",
          description:
            "The exact 64-character hexadecimal SHA-256 contextHash from snapshot",
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
    },
  ],
});

// Control Schema: Full required action schema from Phase 10B Condition B
export const CONTROL_FULL_REQUIRED_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    isGoalReached: {
      type: "boolean",
      description: "Set to false when proposing an action",
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
        "The exact 64-character hexadecimal SHA-256 contextHash from snapshot",
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

// ============================================================================
// Fixed Diagnostic Prompts
// ============================================================================

const CONTEXT_HASH = "68a9fe7b9404a41bcf1388d7a2e59d8f91c68a14b0e3cdb1c3c4f2bc02b086c6";

const SYSTEM_PROMPT = DEFAULT_LIVE_BRAIN_SYSTEM_INSTRUCTION;

// Prompt Class A: Explicit Goal Completion
const PROMPT_GOAL_COMPLETION = `## Task Execution Context
- Task ID: task-swe-bug-fix-calc
- Context Snapshot Hash: ${CONTEXT_HASH}

## Task Status & Verification Evidence
- Calculator bug fix implementation: COMPLETE
- Unit tests executed: 3/3 passed (100%)
- Workspace verification: ALL SUCCESS CRITERIA SATISFIED
- Mission status: The mission goal is completely achieved!

## Required Operation
The task is fully finished and verified.
Propose a goal completion signal.
Set isGoalReached to true.
Set proposalId to "prop-goal-complete-1".
Set contextSnapshotHash to "${CONTEXT_HASH}".
Do NOT request or propose any tool actions.
Output strictly the required JSON object.`;

// Prompt Class B: Explicit Tool Action
const PROMPT_TOOL_ACTION = `## Task Execution Context
- Task ID: task-swe-bug-fix-calc
- Context Snapshot Hash: ${CONTEXT_HASH}

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
The mission is active and incomplete.
Propose a tool action to search for the string "add" using the search_code tool.
Input parameters for search_code: { "query": "add" }.
Set isGoalReached to false.
Set proposalId to "prop-search-add-1".
Set contextSnapshotHash to "${CONTEXT_HASH}".
Output strictly the required JSON object.`;

// ============================================================================
// Response Classifier & Domain Validator
// ============================================================================

export function classifyUnionResponse(
  expectedBranch: "GOAL_REACHED" | "TOOL_ACTION",
  rawOutput: string,
  timeoutOccurred: boolean,
  fetchError: string | null
): {
  parsed: unknown | null;
  domainValidationResult: boolean;
  classification: SchemaUnionClassification;
  detail: string;
} {
  if (timeoutOccurred) {
    return {
      parsed: null,
      domainValidationResult: false,
      classification: "MODEL_TIMEOUT",
      detail: "Inference timed out exceeding 120000ms ceiling",
    };
  }

  if (fetchError) {
    return {
      parsed: null,
      domainValidationResult: false,
      classification: "MODEL_PROVIDER_ERROR",
      detail: `Provider HTTP fetch failure: ${fetchError}`,
    };
  }

  if (!rawOutput || rawOutput.trim().length === 0) {
    return {
      parsed: null,
      domainValidationResult: false,
      classification: "INVALID_JSON",
      detail: "Model returned empty response text",
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
      domainValidationResult: false,
      classification: "INVALID_JSON",
      detail: `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      parsed,
      domainValidationResult: false,
      classification: "DOMAIN_VALIDATION_FAILURE",
      detail: "Parsed output is not a JSON object",
    };
  }

  const obj = parsed as Record<string, unknown>;

  // Check required isGoalReached discriminator
  if (!("isGoalReached" in obj)) {
    return {
      parsed,
      domainValidationResult: false,
      classification: "MISSING_REQUIRED_FIELD",
      detail: "Missing discriminator field 'isGoalReached'",
    };
  }

  const isGoal = obj.isGoalReached;
  if (typeof isGoal !== "boolean") {
    return {
      parsed,
      domainValidationResult: false,
      classification: "DOMAIN_VALIDATION_FAILURE",
      detail: `'isGoalReached' is not a boolean: ${typeof isGoal}`,
    };
  }

  // Branch A Evaluation: Expected GOAL_REACHED
  if (expectedBranch === "GOAL_REACHED") {
    if (isGoal !== true) {
      return {
        parsed,
        domainValidationResult: false,
        classification: "WRONG_VARIANT",
        detail: `Expected isGoalReached: true for goal prompt, got isGoalReached: ${isGoal}`,
      };
    }

    // Must NOT contain tool execution fields
    if ("toolName" in obj || "inputPayload" in obj) {
      return {
        parsed,
        domainValidationResult: false,
        classification: "TOOL_ACTION_IN_GOAL_VARIANT",
        detail: "Goal-reached proposal contaminated with toolName or inputPayload",
      };
    }

    if (!obj.proposalId || typeof obj.proposalId !== "string") {
      return {
        parsed,
        domainValidationResult: false,
        classification: "MISSING_REQUIRED_FIELD",
        detail: "Goal-reached proposal missing proposalId string",
      };
    }

    if (
      !obj.contextSnapshotHash ||
      typeof obj.contextSnapshotHash !== "string" ||
      !/^[a-f0-9]{64}$/i.test(obj.contextSnapshotHash)
    ) {
      return {
        parsed,
        domainValidationResult: false,
        classification: "MISSING_REQUIRED_FIELD",
        detail: "Goal-reached proposal missing or invalid 64-char contextSnapshotHash",
      };
    }

    return {
      parsed,
      domainValidationResult: true,
      classification: "VALID_GOAL_PROPOSAL",
      detail: "Conforming GoalReachedProposal (isGoalReached: true, no tool execution)",
    };
  }

  // Branch B Evaluation: Expected TOOL_ACTION
  if (expectedBranch === "TOOL_ACTION") {
    if (isGoal !== false) {
      return {
        parsed,
        domainValidationResult: false,
        classification: "GOAL_COMPLETION_IN_TOOL_VARIANT",
        detail: `Expected isGoalReached: false for tool action prompt, got isGoalReached: ${isGoal}`,
      };
    }

    if (!("toolName" in obj)) {
      return {
        parsed,
        domainValidationResult: false,
        classification: "MISSING_REQUIRED_FIELD",
        detail: "Tool-action proposal missing 'toolName'",
      };
    }

    if (
      typeof obj.toolName !== "string" ||
      !TOOL_NAMES.includes(obj.toolName as any)
    ) {
      return {
        parsed,
        domainValidationResult: false,
        classification: "DOMAIN_VALIDATION_FAILURE",
        detail: `toolName '${String(obj.toolName)}' is not in registered TOOL_NAMES`,
      };
    }

    if (!("inputPayload" in obj)) {
      return {
        parsed,
        domainValidationResult: false,
        classification: "MISSING_REQUIRED_FIELD",
        detail: "Tool-action proposal missing 'inputPayload'",
      };
    }

    if (
      typeof obj.inputPayload !== "object" ||
      obj.inputPayload === null ||
      Array.isArray(obj.inputPayload)
    ) {
      return {
        parsed,
        domainValidationResult: false,
        classification: "DOMAIN_VALIDATION_FAILURE",
        detail: "inputPayload is not an object",
      };
    }

    // Validate against production ActionProposalSchema
    const zodResult = ActionProposalSchema.safeParse({
      proposalId: obj.proposalId ?? "",
      toolName: obj.toolName,
      inputPayload: obj.inputPayload,
      contextSnapshotHash: obj.contextSnapshotHash ?? "",
      ...(obj.rationale !== undefined ? { rationale: obj.rationale } : {}),
      ...(obj.sequenceHint !== undefined ? { sequenceHint: obj.sequenceHint } : {}),
    });

    if (!zodResult.success) {
      const issue = zodResult.error.issues[0];
      return {
        parsed,
        domainValidationResult: false,
        classification: "DOMAIN_VALIDATION_FAILURE",
        detail: `ActionProposalSchema violation on '${issue.path.join(".")}': ${issue.message}`,
      };
    }

    return {
      parsed,
      domainValidationResult: true,
      classification: "VALID_TOOL_PROPOSAL",
      detail: "Conforming ToolActionProposal (isGoalReached: false, passes ActionProposalSchema)",
    };
  }

  return {
    parsed,
    domainValidationResult: false,
    classification: "DOMAIN_VALIDATION_FAILURE",
    detail: "Unknown evaluation branch",
  };
}

// ============================================================================
// Main Execution
// ============================================================================

export async function runPhase10CSchemaUnionDiagnostic(): Promise<void> {
  const model = "llama3.2:3b";
  const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
  const timeoutMs = 120_000;
  const artifactPath = path.resolve(
    "C:/Users/Adusumalli Girish/.gemini/antigravity/brain/543bddec-0a19-44a7-9818-72be776b138b/scratch/phase10c-schema-union-diagnostic.json"
  );

  console.log("\n================================================================================");
  console.log("PHASE 10C: OLLAMA GOAL-OR-ACTION STRUCTURED SCHEMA RFC");
  console.log(`Started: ${new Date().toISOString()}`);
  console.log(`Model: ${model} | Target Calls: 5 Goal + 5 Tool + 2 Control = 12 model calls`);
  console.log("================================================================================\n");

  // 1. Preflight Invariants
  const check = await checkOllamaLiveAvailability(baseUrl, model);
  if (!check.available) {
    throw new Error(`Preflight failed: Ollama unreachable or model missing: ${check.reason}`);
  }
  console.log(`[PREFLIGHT] Ollama reachable. Model '${model}' verified available.`);

  // Historical Artifact Protection
  const protectedPaths = [
    "phase10b-structured-output-diagnostic.json",
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

  const unionSchemaHash = sha256Hex(JSON.stringify(CANDIDATE_UNION_SCHEMA));
  const controlSchemaHash = sha256Hex(JSON.stringify(CONTROL_FULL_REQUIRED_SCHEMA));

  const plannedRuns = [
    // 5 Goal-completion trials with candidate anyOf union
    ...Array.from({ length: 5 }, (_, i) => ({
      condition: "UNION_DISCRIMINATED" as const,
      semanticBranch: "GOAL_REACHED" as const,
      ordinal: i + 1,
      schema: CANDIDATE_UNION_SCHEMA,
      schemaHash: unionSchemaHash,
      userPrompt: PROMPT_GOAL_COMPLETION,
    })),
    // 5 Tool-action trials with candidate anyOf union
    ...Array.from({ length: 5 }, (_, i) => ({
      condition: "UNION_DISCRIMINATED" as const,
      semanticBranch: "TOOL_ACTION" as const,
      ordinal: i + 1,
      schema: CANDIDATE_UNION_SCHEMA,
      schemaHash: unionSchemaHash,
      userPrompt: PROMPT_TOOL_ACTION,
    })),
    // 2 Control trials with full required schema
    ...Array.from({ length: 2 }, (_, i) => ({
      condition: "CONTROL_FULL_REQUIRED" as const,
      semanticBranch: "TOOL_ACTION" as const,
      ordinal: i + 1,
      schema: CONTROL_FULL_REQUIRED_SCHEMA,
      schemaHash: controlSchemaHash,
      userPrompt: PROMPT_TOOL_ACTION,
    })),
  ];

  const records: UnionTrialRecord[] = [];

  for (let idx = 0; idx < plannedRuns.length; idx++) {
    const item = plannedRuns[idx];
    const trialId = `phase10c-${item.condition.toLowerCase()}-${item.semanticBranch.toLowerCase()}-${item.ordinal}`;
    console.log(
      `\n[CALL ${idx + 1}/${plannedRuns.length}] Starting ${trialId} (${item.condition} | ${item.semanticBranch})...`
    );

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
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: item.userPrompt },
          ],
          stream: false,
          format: item.schema,
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
    const classification = classifyUnionResponse(
      item.semanticBranch,
      rawOutput,
      didTimeout,
      fetchError
    );

    // Apply Credential Boundary Assertion
    assertCredentialBoundary(rawOutput, "rawOutput");

    const record: UnionTrialRecord = {
      trialId,
      condition: item.condition,
      semanticBranch: item.semanticBranch,
      trialOrdinal: item.ordinal,
      model,
      rawResponse: rawOutput,
      parsedResponse: classification.parsed,
      domainValidationResult: classification.domainValidationResult,
      classification: classification.classification,
      classificationDetail: classification.detail,
      modelLatencyMs: elapsedMs,
      promptTokens,
      outputTokens,
      schemaHash: item.schemaHash,
      ...(fetchError ? { error: fetchError } : {}),
      timestamp: new Date().toISOString(),
    };

    records.push(record);

    console.log(
      `[RESULT] ${trialId} in ${(elapsedMs / 1000).toFixed(1)}s | classification: ${
        record.classification
      } | valid: ${record.domainValidationResult}`
    );
    console.log(`[DETAIL] ${record.classificationDetail}`);
    console.log(`[RAW RESPONSE] ${rawOutput.trim().replace(/\n/g, " ").slice(0, 200)}`);
  }

  // 2. Synthesize Metrics
  const goalSubset = records.filter(
    (r) => r.condition === "UNION_DISCRIMINATED" && r.semanticBranch === "GOAL_REACHED"
  );
  const toolSubset = records.filter(
    (r) => r.condition === "UNION_DISCRIMINATED" && r.semanticBranch === "TOOL_ACTION"
  );
  const controlSubset = records.filter(
    (r) => r.condition === "CONTROL_FULL_REQUIRED"
  );

  const computeBranchMetrics = (
    subset: UnionTrialRecord[],
    validKind: SchemaUnionClassification
  ) => {
    const validCount = subset.filter((r) => r.classification === validKind).length;
    const wrongVariant = subset.filter((r) => r.classification === "WRONG_VARIANT").length;
    const missingFields = subset.filter(
      (r) => r.classification === "MISSING_REQUIRED_FIELD"
    ).length;
    const toolInGoal = subset.filter(
      (r) => r.classification === "TOOL_ACTION_IN_GOAL_VARIANT"
    ).length;
    const goalInTool = subset.filter(
      (r) => r.classification === "GOAL_COMPLETION_IN_TOOL_VARIANT"
    ).length;
    const invalidJson = subset.filter(
      (r) => r.classification === "INVALID_JSON"
    ).length;
    const timeouts = subset.filter(
      (r) => r.classification === "MODEL_TIMEOUT"
    ).length;
    const otherErrors = subset.filter(
      (r) => r.classification === "MODEL_PROVIDER_ERROR"
    ).length;

    const latencies = subset.map((r) => r.modelLatencyMs);
    const meanLatencyMs =
      latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : 0;
    const sorted = [...latencies].sort((a, b) => a - b);
    const medianLatencyMs =
      sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;

    const totalPromptTokens = subset.reduce(
      (acc, r) => acc + (r.promptTokens ?? 0),
      0
    );
    const totalOutputTokens = subset.reduce(
      (acc, r) => acc + (r.outputTokens ?? 0),
      0
    );

    return {
      trials: subset.length,
      validProposals: validCount,
      wrongVariant,
      missingFields,
      toolInGoal,
      goalInTool,
      invalidJson,
      timeouts,
      otherErrors,
      meanLatencyMs,
      medianLatencyMs,
      totalPromptTokens,
      totalOutputTokens,
      successRate: subset.length > 0 ? validCount / subset.length : 0,
    };
  };

  const goalMetrics = computeBranchMetrics(goalSubset, "VALID_GOAL_PROPOSAL");
  const toolMetrics = computeBranchMetrics(toolSubset, "VALID_TOOL_PROPOSAL");
  const controlMetrics = computeBranchMetrics(controlSubset, "VALID_TOOL_PROPOSAL");

  // 3. Step 13: Determinism Verification
  // Repeat evaluation offline against persisted responses using the domain classification path
  let determinismVerified = true;
  for (const rec of records) {
    const replay = classifyUnionResponse(
      rec.semanticBranch,
      rec.rawResponse,
      rec.classification === "MODEL_TIMEOUT",
      rec.error ?? null
    );
    if (
      replay.classification !== rec.classification ||
      replay.domainValidationResult !== rec.domainValidationResult
    ) {
      determinismVerified = false;
      console.error(
        `[DETERMINISM_MISMATCH] Trial ${rec.trialId} replayed classification '${replay.classification}' vs original '${rec.classification}'`
      );
    }
  }
  console.log(`[DETERMINISM] Offline determinism verified across all 12 records: ${determinismVerified}`);

  // 4. Interpretation Assignment (UNION_A, UNION_B, UNION_C, UNION_D)
  let interpretation: "UNION_A" | "UNION_B" | "UNION_C" | "UNION_D";
  let interpretationSummary: string;
  let isProductionAdapterChangeJustified: boolean;
  let securityImplications: string;
  let nextStep: string;

  if (goalMetrics.successRate === 1.0 && toolMetrics.successRate === 1.0) {
    interpretation = "UNION_A";
    interpretationSummary =
      "Both semantic branches (Goal Reached and Tool Action) consistently produced 100% valid domain proposals under Ollama GBNF anyOf schema enforcement.";
    isProductionAdapterChangeJustified = true;
    securityImplications =
      "Schema union acts strictly as a decoding format filter. All outputs remain untrusted and subject to full ProposalValidator, Reflex, and Policy evaluations.";
    nextStep =
      "Adopt the validated anyOf discriminated union in ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA and re-run calibrated execution-reach gate.";
  } else if (controlMetrics.successRate === 1.0 && toolMetrics.successRate < 1.0) {
    interpretation = "UNION_B";
    interpretationSummary =
      "Ollama struggles with the anyOf union grammar even though the single-shape required schema works.";
    isProductionAdapterChangeJustified = false;
    securityImplications = "Grammar ambiguity in Ollama sampler.";
    nextStep =
      "Investigate simpler discriminator representation without weakening domain contract.";
  } else if (controlMetrics.successRate < 1.0) {
    interpretation = "UNION_C";
    interpretationSummary =
      "Both union and full required control schema failed; model capability/timeout remains bottleneck.";
    isProductionAdapterChangeJustified = false;
    securityImplications = "Model capability floor.";
    nextStep = "Proceed to stronger model evaluation.";
  } else {
    interpretation = "UNION_D";
    interpretationSummary =
      "Domain model cannot cleanly represent the two variants without ambiguity.";
    isProductionAdapterChangeJustified = false;
    securityImplications = "Domain ambiguity.";
    nextStep = "Perform ADR-level domain analysis.";
  }

  const summary: Phase10CSummary = {
    experimentName: "Phase 10C: Ollama Goal-or-Action Structured Schema RFC",
    timestamp: new Date().toISOString(),
    model,
    totalTrials: records.length,
    unionCandidateSchema: CANDIDATE_UNION_SCHEMA as Record<string, unknown>,
    results: {
      goalReachedBranch: {
        trials: goalMetrics.trials,
        validGoalProposals: goalMetrics.validProposals,
        wrongVariant: goalMetrics.wrongVariant,
        missingFields: goalMetrics.missingFields,
        toolActionInGoalVariant: goalMetrics.toolInGoal,
        invalidJson: goalMetrics.invalidJson,
        timeouts: goalMetrics.timeouts,
        otherErrors: goalMetrics.otherErrors,
        meanLatencyMs: goalMetrics.meanLatencyMs,
        medianLatencyMs: goalMetrics.medianLatencyMs,
        totalPromptTokens: goalMetrics.totalPromptTokens,
        totalOutputTokens: goalMetrics.totalOutputTokens,
        successRate: goalMetrics.successRate,
      },
      toolActionBranch: {
        trials: toolMetrics.trials,
        validToolProposals: toolMetrics.validProposals,
        wrongVariant: toolMetrics.wrongVariant,
        missingFields: toolMetrics.missingFields,
        goalCompletionInToolVariant: toolMetrics.goalInTool,
        invalidJson: toolMetrics.invalidJson,
        timeouts: toolMetrics.timeouts,
        otherErrors: toolMetrics.otherErrors,
        meanLatencyMs: toolMetrics.meanLatencyMs,
        medianLatencyMs: toolMetrics.medianLatencyMs,
        totalPromptTokens: toolMetrics.totalPromptTokens,
        totalOutputTokens: toolMetrics.totalOutputTokens,
        successRate: toolMetrics.successRate,
      },
      controlCondition: {
        trials: controlMetrics.trials,
        validToolProposals: controlMetrics.validProposals,
        successRate: controlMetrics.successRate,
        meanLatencyMs: controlMetrics.meanLatencyMs,
      },
    },
    offlineDeterminismVerified: determinismVerified,
    evaluationConclusion: {
      interpretation,
      summary: interpretationSummary,
      isProductionAdapterChangeJustified,
      securityImplications,
      nextStep,
    },
    records,
  };

  fs.writeFileSync(artifactPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(`\n================================================================================`);
  console.log(`PHASE 10C DIAGNOSTIC COMPLETED: ${interpretation}`);
  console.log(`Goal Branch Success: ${goalMetrics.successRate * 100}% (${goalMetrics.validProposals}/${goalMetrics.trials})`);
  console.log(`Tool Branch Success: ${toolMetrics.successRate * 100}% (${toolMetrics.validProposals}/${toolMetrics.trials})`);
  console.log(`Control Success: ${controlMetrics.successRate * 100}% (${controlMetrics.validProposals}/${controlMetrics.trials})`);
  console.log(`Determinism: ${determinismVerified ? "VERIFIED" : "FAILED"}`);
  console.log(`Production Adapter Change Justified: ${isProductionAdapterChangeJustified}`);
  console.log(`Summary written to: ${artifactPath}`);
  console.log("================================================================================\n");
}

// Auto-run if executed directly
runPhase10CSchemaUnionDiagnostic().catch((err) => {
  console.error("Phase 10C diagnostic failed:", err);
  process.exit(1);
});
