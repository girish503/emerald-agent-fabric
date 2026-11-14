/**
 * Phase 10H — Multi-Tool Argument Conformance Diagnostic Runner.
 *
 * Evaluates whether the ADR-0029 standardized model-facing tool projection
 * improves tool-input argument conformance across ALL six tools in the
 * Emerald Agent Fabric catalog for `llama3.2:3b` on CPU.
 *
 * Compares:
 *   BASELINE: Existing model-facing definitions from src/domain/tool.ts
 *   vs
 *   STANDARDIZED: ADR-0029 deterministic projection
 *
 * Invariants & Constraints:
 * 1. Model: llama3.2:3b via local Ollama (http://127.0.0.1:11434). Timeout: 120,000ms. Temp: 0.0.
 * 2. Zero execution: Executes no tools, accesses no workspace, touches no SQLite, invokes no Reflex.
 * 3. Matrix: 6 tools × 2 conditions × 3 trials = 36 total model calls (configurable via PHASE10H_TRIALS).
 * 4. Production Code Unmodified: Domain schemas, validators, governance, and Reflex remain frozen.
 * 5. Artifact Protection: Historical artifacts (phase9*, phase10a*, phase10b*, phase10c*, phase10e*, phase10f*)
 *    are verified and never overwritten. Target artifact: phase10h-tool-contract-diagnostic.json.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { OllamaModelProvider } from "../src/adapters/models/ollama-model-provider.js";
import { checkOllamaLiveAvailability } from "../src/application/evaluation/live-swe-evaluation.js";
import {
  ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA,
  DEFAULT_LIVE_BRAIN_SYSTEM_INSTRUCTION,
} from "../src/application/live-agent-brain.js";
import {
  INITIAL_TOOL_DEFINITIONS,
  ToolDefinition,
  ToolName,
} from "../src/domain/tool.js";
import {
  GitDiffInputSchema,
  GitStatusInputSchema,
  ReadFileInputSchema,
  RunCommandInputSchema,
  SearchCodeInputSchema,
  WriteFileInputSchema,
} from "../src/domain/tool-schemas.js";
import {
  ContextSnapshot,
  Observation,
} from "../src/domain/context.js";
import {
  ModelMessage,
  ModelProviderRequest,
} from "../src/ports/model-provider.port.js";
import { canonicalJsonStringify } from "../src/domain/canonical-hash.js";
import { ProposalValidator, ProposalValidationContext } from "../src/application/proposal-validator.js";
import { RunSnapshot } from "../src/domain/invariants.js";
import { MissionContract } from "../src/domain/mission-contract.js";

// ============================================================================
// 1. Paths & Historical Artifact Protection
// ============================================================================

const SCRATCH_DIR = path.resolve(
  path.resolve(__dirname, "../tests/fixtures")
);

const TARGET_ARTIFACT_PATH = path.join(SCRATCH_DIR, "phase10h-tool-contract-diagnostic.json");
const CHECKPOINT_PATH = path.join(SCRATCH_DIR, "phase10h-checkpoint.ndjson");

const HISTORICAL_HASHES: Readonly<Record<string, string>> = Object.freeze({
  "phase9-4b-summary.json": "FC81ED4C9E0FA60D2232104DC0CCFA57C4FB26BCDAB79E6D17D52F3FE575D92E",
  "phase10a-summary.json": "3D7AB05E40E7F5B7CC62175D9FF5A49BC4A81373EEF01DA0FDB30B9B1FFDA9AB",
  "phase10b-structured-output-diagnostic.json": "6A86F522ADD8ACB6F7A5D3D7CB560346FFED9E15982F84C97AA25AD539D35A24",
  "phase10c-schema-union-diagnostic.json": "BDF5275841FD46F31890964B941832AA11F0E1EFC2396FAFA0375FF1C99D1A4A",
  "phase10e-summary.json": "6D0DEB0E1685FDBF06882A90AF4A0AD27CA68DEEFE03F37CC36FEC6632A37136",
  "phase10f-tool-input-diagnostic.json": "46F0B3EE24FFFCCA06CDA3133A9199FE3096E23A063F2293FF5813D6F2424DE0",
});

function verifyHistoricalArtifactsPreserved(): void {
  for (const [filename, expectedSha256] of Object.entries(HISTORICAL_HASHES)) {
    const fullPath = path.join(SCRATCH_DIR, filename);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Preflight invariant violation: Historical artifact missing: ${filename}`);
    }
    const buf = fs.readFileSync(fullPath);
    const actualSha256 = crypto.createHash("sha256").update(buf).digest("hex").toUpperCase();
    if (actualSha256 !== expectedSha256.toUpperCase()) {
      throw new Error(
        `Preflight invariant violation: Historical artifact corrupted! ${filename} expected ${expectedSha256}, got ${actualSha256}`
      );
    }
  }
  console.log("[INVARIANT] All 6 historical evaluation artifacts verified byte-for-byte intact.");
}

// ============================================================================
// 2. Tool Description Renderers (Baseline vs ADR-0029 Standardized)
// ============================================================================

export type DiagnosticCondition = "BASELINE" | "STANDARDIZED";

function renderBaselineToolsDescription(): string {
  const lines: string[] = [];
  for (const tool of INITIAL_TOOL_DEFINITIONS) {
    lines.push(
      `- ${tool.name} (capability: ${tool.requiredCapability}, idempotency: ${tool.idempotency}): ${tool.description}`
    );
  }
  return lines.join("\n");
}

function renderStandardizedToolsDescription(): string {
  return [
    `### Tool: \`read_file\`
- **Purpose**: Reads UTF-8 text content from a file inside the workspace sandbox with line offset and line limit bounds.
- **Isolation Boundary**: WORKSPACE
- **Input Parameters (\`inputPayload\`)**:
  - \`path\` (string, **[REQUIRED]**): Workspace-relative path to target file (e.g. "src/index.ts"). Must be a child file path; cannot be empty, absolute, or contain parent traversal ('..').
  - \`offsetLine\` (integer, **[OPTIONAL]**, default: 1): 1-indexed starting line number (must be >= 1).
  - \`limitLines\` (integer, **[OPTIONAL]**, default: 500): Maximum number of lines to read (integer between 1 and 5000).
  - \`maxBytes\` (integer, **[OPTIONAL]**): Maximum byte ceiling to read.
- **Closed Schema Rule**: Additional or unrecognized fields are STRICTLY FORBIDDEN and cause immediate proposal rejection.
- **Valid Example**:
  \`\`\`json
  {
    "path": "src/calculator.ts",
    "offsetLine": 1,
    "limitLines": 100
  }
  \`\`\`
- **Invalid Field Warning**: Do NOT emit \`filePath\`, \`filename\`, \`startLine\`, or \`endLine\`. Use \`path\`, \`offsetLine\`, and \`limitLines\`.`,

    `### Tool: \`search_code\`
- **Purpose**: Performs literal text substring matching or regex pattern matching across workspace files.
- **Isolation Boundary**: WORKSPACE
- **Input Parameters (\`inputPayload\`)**:
  - \`query\` (string, **[REQUIRED]**): The text substring or regular expression pattern to search for (1 to 1000 characters).
  - \`isRegex\` (boolean, **[OPTIONAL]**, default: false): Set to true if \`query\` is a regular expression; false for literal substring search.
  - \`path\` (string, **[OPTIONAL]**, default: "."): Workspace-relative directory to search within ("." denotes workspace root). Cannot contain parent traversal ('..').
  - \`filePattern\` (string, **[OPTIONAL]**, default: "*"): Glob pattern to filter searched files (e.g. "*.ts", "*.json").
  - \`maxResults\` (integer, **[OPTIONAL]**, default: 50): Maximum number of matching lines to return (integer between 1 and 1000).
  - \`maxBytes\` (integer, **[OPTIONAL]**): Maximum output byte limit.
- **Closed Schema Rule**: Additional or unrecognized fields are STRICTLY FORBIDDEN and cause immediate proposal rejection.
- **Valid Example**:
  \`\`\`json
  {
    "query": "calculateTotal",
    "path": ".",
    "filePattern": "*.ts"
  }
  \`\`\`
- **Invalid Field Warning**: Do NOT emit \`pattern\`, \`filePaths\`, \`files\`, or \`directory\`. The search pattern parameter is strictly named \`query\`.`,

    `### Tool: \`git_status\`
- **Purpose**: Inspects Git working tree status, returning clean/dirty state and lists of modified, added, deleted, and untracked files.
- **Isolation Boundary**: WORKSPACE
- **Input Parameters (\`inputPayload\`)**:
  - \`path\` (string, **[OPTIONAL]**, default: "."): Workspace-relative directory path to scope git status inspection ("." for workspace root).
- **Closed Schema Rule**: Additional or unrecognized fields are STRICTLY FORBIDDEN and cause immediate proposal rejection.
- **Valid Example**:
  \`\`\`json
  {
    "path": "."
  }
  \`\`\`
- **Invalid Field Warning**: Do NOT emit \`options\`, \`staged\`, \`verbose\`, or flags. An empty object \`{}\` is valid.`,

    `### Tool: \`git_diff\`
- **Purpose**: Computes unified diff of working tree modifications against the baseline commit or staged index.
- **Isolation Boundary**: WORKSPACE
- **Input Parameters (\`inputPayload\`)**:
  - \`path\` (string, **[OPTIONAL]**): Workspace-relative path to scope diff to a specific file or subdirectory.
  - \`staged\` (boolean, **[OPTIONAL]**, default: false): When true, inspects staged changes; when false, inspects unstaged working tree changes.
  - \`maxBytes\` (integer, **[OPTIONAL]**): Maximum output byte limit for diff text.
- **Closed Schema Rule**: Additional or unrecognized fields are STRICTLY FORBIDDEN and cause immediate proposal rejection.
- **Valid Example**:
  \`\`\`json
  {
    "staged": false
  }
  \`\`\`
- **Invalid Field Warning**: Do NOT emit \`cached\`, \`commit\`, \`branch\`, or \`files\`. Use \`staged: true\` to inspect staged changes.`,

    `### Tool: \`write_file\`
- **Purpose**: Atomically creates or completely overwrites a text file within the workspace sandbox with full content.
- **Isolation Boundary**: WORKSPACE
- **Input Parameters (\`inputPayload\`)**:
  - \`path\` (string, **[REQUIRED]**): Workspace-relative path to target file (e.g. "src/calculator.ts"). Cannot be empty, absolute, or contain parent traversal ('..').
  - \`content\` (string, **[REQUIRED]**): Complete UTF-8 text content to write to the file.
  - \`overwrite\` (boolean, **[OPTIONAL]**, default: true): Set to true to overwrite existing file; false to fail if file already exists.
  - \`maxBytes\` (integer, **[OPTIONAL]**): Maximum allowed content byte size.
- **Closed Schema Rule**: Additional or unrecognized fields are STRICTLY FORBIDDEN and cause immediate proposal rejection.
- **Valid Example**:
  \`\`\`json
  {
    "path": "src/calculator.ts",
    "content": "export function add(a: number, b: number): number {\\n  return a + b;\\n}\\n",
    "overwrite": true
  }
  \`\`\`
- **Invalid Field Warning**: Do NOT emit \`filePath\`, \`text\`, \`data\`, \`append\`, or \`mode\`. File path must be \`path\` and file body must be \`content\`.`,

    `### Tool: \`run_command\`
- **Purpose**: Executes a specific non-interactive command inside the isolated container sandbox using discrete argument tokens.
- **Isolation Boundary**: SANDBOX (Container execution)
- **Input Parameters (\`inputPayload\`)**:
  - \`argv\` (array of string, **[REQUIRED]**): Non-empty array of discrete argument tokens where \`argv[0]\` is the executable command (e.g. ["npm", "test"]). Raw shell strings are categorically rejected.
  - \`cwd\` (string, **[OPTIONAL]**, default: "."): Relative workspace directory from which to execute the command ("." denotes workspace root).
  - \`timeoutMs\` (integer, **[OPTIONAL]**): Execution timeout in milliseconds (subject to mission contract ceiling).
  - \`maxOutputBytes\` (integer, **[OPTIONAL]**): Maximum stdout/stderr output bytes to capture.
- **Closed Schema Rule**: Additional or unrecognized fields are STRICTLY FORBIDDEN and cause immediate proposal rejection.
- **Valid Example**:
  \`\`\`json
  {
    "argv": ["npm", "test", "--", "-t", "calculator"],
    "cwd": "."
  }
  \`\`\`
- **Invalid Field Warning**: Do NOT emit a single shell command string like \`{"command": "npm test"}\` or \`{"cmd": "npm test"}\`. Arguments must be provided as an array of discrete tokens in \`argv\`.`,
  ].join("\n\n");
}

// ============================================================================
// 3. Task Directives for the 6 Tools
// ============================================================================

export interface ToolTestTask {
  readonly targetTool: ToolName;
  readonly directive: string;
  readonly inputSchema: any;
}

export const TOOL_TEST_TASKS: readonly ToolTestTask[] = Object.freeze([
  {
    targetTool: "read_file",
    directive: "Read lines 1 to 50 of the file 'src/domain/tool.ts'.",
    inputSchema: ReadFileInputSchema,
  },
  {
    targetTool: "search_code",
    directive: "Search the repository for occurrences of the function 'calculateTotal'.",
    inputSchema: SearchCodeInputSchema,
  },
  {
    targetTool: "git_status",
    directive: "Inspect the git working tree status to check for modified or untracked files.",
    inputSchema: GitStatusInputSchema,
  },
  {
    targetTool: "git_diff",
    directive: "Inspect the unstaged git diff of modifications in the repository.",
    inputSchema: GitDiffInputSchema,
  },
  {
    targetTool: "write_file",
    directive: "Create a new file 'src/domain/math_helper.ts' with the content 'export function square(n: number): number { return n * n; }'.",
    inputSchema: WriteFileInputSchema,
  },
  {
    targetTool: "run_command",
    directive: "Run the project test suite using the command 'npm test'.",
    inputSchema: RunCommandInputSchema,
  },
]);

// ============================================================================
// 4. Trial Classification & Validation Models
// ============================================================================

export type ResponseClassification =
  | "VALID_TOOL_INPUT"
  | "INVENTED_FIELD"
  | "MISSING_REQUIRED_FIELD"
  | "WRONG_PARAMETER_TYPE"
  | "WRONG_TOOL_SELECTED"
  | "SCHEMA_CONSTRAINT_VIOLATION"
  | "MALFORMED_OUTPUT"
  | "MODEL_TIMEOUT";

export interface TrialRecord {
  readonly trialIndex: number;
  readonly condition: DiagnosticCondition;
  readonly targetTool: ToolName;
  readonly trialNum: number;
  readonly promptBytes: number;
  readonly durationMs: number;
  readonly isTimeout: boolean;
  readonly rawOutput?: string;
  readonly parsedProposal?: any;
  readonly selectedTool?: string;
  readonly isValidToolInput: boolean;
  readonly isCorrectTool: boolean;
  readonly hasInventedField: boolean;
  readonly inventedFields: readonly string[];
  readonly hasMissingRequiredField: boolean;
  readonly missingFields: readonly string[];
  readonly hasWrongType: boolean;
  readonly classification: ResponseClassification;
  readonly validatorIssues: readonly string[];
  readonly proposalValidatorPassed: boolean;
}

// ============================================================================
// 5. Context Snapshot & Governance Mocks
// ============================================================================

function createDiagnosticContextSnapshot(targetTool: ToolName, directive: string): ContextSnapshot {
  const observations: Observation[] = [
    {
      observationId: `obs-task-${targetTool}`,
      category: "SYSTEM",
      content: { directive, targetOperation: targetTool },
      priority: 1,
      freshness: "FRESH",
      sequenceNumber: 1,
      createdAt: "2026-10-16T12:00:00.000Z",
    },
    {
      observationId: `obs-env-${targetTool}`,
      category: "ENVIRONMENT",
      content: { workspace: "/workspace", branch: "main", status: "ACTIVE" },
      priority: 2,
      freshness: "FRESH",
      sequenceNumber: 1,
      createdAt: "2026-10-16T12:00:00.000Z",
    },
  ];

  const contentToHash = canonicalJsonStringify({
    taskId: `task-swe-${targetTool}`,
    observations,
    omittedObservationsCount: 0,
  });

  const contextHash = crypto.createHash("sha256").update(contentToHash).digest("hex");

  return {
    taskId: `task-swe-${targetTool}`,
    contextHash,
    observations,
    omittedObservationsCount: 0,
    totalOriginalBytes: Buffer.byteLength(contentToHash, "utf8"),
    retainedBytes: Buffer.byteLength(contentToHash, "utf8"),
  };
}

function createDummyRunSnapshot(runId: string, contextHash: string): RunSnapshot {
  return {
    runId,
    taskId: "task-swe-benchmark",
    status: "RUNNING",
    leaseId: "lease-diag-10h",
    currentWorkerId: "worker-diag-10h",
    leaseExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    retryCount: 0,
    contractBinding: {
      contractId: "contract-swe-diag",
      version: 1,
      contentHash: "dummy-contract-hash",
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createDummyMissionContract(): MissionContract {
  return {
    spec: {
      contractId: "contract-swe-diag",
      version: 1,
      taskId: "task-swe-benchmark",
      policy: {
        policyId: "policy-swe-permissive",
        allowedCapabilities: [
          "workspace.file.read",
          "workspace.file.write",
          "workspace.code.search",
          "git.read",
          "process.execute",
        ],
        rules: [],
      },
      resourceLimits: {
        timeoutMs: 300_000,
        maxBytes: 10 * 1024 * 1024,
        maxOutputBytes: 10 * 1024 * 1024,
      },
      createdAt: new Date().toISOString(),
    },
    lifecycle: {
      status: "ACTIVE",
      activatedAt: new Date().toISOString(),
    },
    contentHash: "dummy-contract-hash",
  };
}

// ============================================================================
// 6. Model Request Construction
// ============================================================================

function buildDiagnosticModelRequest(
  condition: DiagnosticCondition,
  task: ToolTestTask,
  trialNum: number,
  timeoutMs: number,
  model: string
): { request: ModelProviderRequest; contextSnapshot: ContextSnapshot; promptBytes: number } {
  const contextSnapshot = createDiagnosticContextSnapshot(task.targetTool, task.directive);
  const runId = `run-phase10h-${condition.toLowerCase()}-${task.targetTool}-${trialNum}`;

  const sections: string[] = [];
  sections.push("## Task Execution Context");
  sections.push(`- Task ID: ${contextSnapshot.taskId}`);
  sections.push(`- Run ID: ${runId}`);
  sections.push(`- Step Sequence: 1`);
  sections.push(`- Context Snapshot Hash: ${contextSnapshot.contextHash}`);

  sections.push("\n## Available Tools");
  if (condition === "BASELINE") {
    sections.push(renderBaselineToolsDescription());
  } else {
    sections.push(renderStandardizedToolsDescription());
  }

  sections.push("\n## Context Observations");
  for (const obs of contextSnapshot.observations) {
    sections.push(`### [${obs.category}] Priority ${obs.priority} (${obs.freshness})\n${canonicalJsonStringify(obs.content)}`);
  }

  sections.push(
    `\n## Required Action\n` +
      `Propose the next logical tool action as a JSON object conforming to the action proposal schema.\n` +
      `Set contextSnapshotHash to "${contextSnapshot.contextHash}".\n` +
      `If the mission goal has been completely achieved, set isGoalReached: true.`
  );

  const userContent = sections.join("\n");
  const promptBytes = Buffer.byteLength(userContent, "utf8");

  const inputMessages: readonly ModelMessage[] = Object.freeze([
    Object.freeze({ role: "system" as const, content: DEFAULT_LIVE_BRAIN_SYSTEM_INSTRUCTION }),
    Object.freeze({ role: "user" as const, content: userContent }),
  ]);

  const request: ModelProviderRequest = Object.freeze({
    requestId: `req-diag-10h-${condition}-${task.targetTool}-${trialNum}`,
    model,
    input: inputMessages,
    generation: Object.freeze({
      temperature: 0.0,
      maxOutputTokens: 2048,
      structuredOutput: ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA,
    }),
    timeoutMs,
  });

  return { request, contextSnapshot, promptBytes };
}

// ============================================================================
// 7. Output Evaluation & Classification
// ============================================================================

function evaluateModelResponse(
  task: ToolTestTask,
  condition: DiagnosticCondition,
  trialNum: number,
  promptBytes: number,
  durationMs: number,
  isTimeout: boolean,
  rawOutput: string | undefined,
  contextSnapshot: ContextSnapshot,
  validator: ProposalValidator
): TrialRecord {
  if (isTimeout) {
    return {
      trialIndex: 0,
      condition,
      targetTool: task.targetTool,
      trialNum,
      promptBytes,
      durationMs,
      isTimeout: true,
      rawOutput,
      isValidToolInput: false,
      isCorrectTool: false,
      hasInventedField: false,
      inventedFields: [],
      hasMissingRequiredField: false,
      missingFields: [],
      hasWrongType: false,
      classification: "MODEL_TIMEOUT",
      validatorIssues: ["Model call exceeded 120s timeout limit"],
      proposalValidatorPassed: false,
    };
  }

  if (!rawOutput) {
    return {
      trialIndex: 0,
      condition,
      targetTool: task.targetTool,
      trialNum,
      promptBytes,
      durationMs,
      isTimeout: false,
      rawOutput,
      isValidToolInput: false,
      isCorrectTool: false,
      hasInventedField: false,
      inventedFields: [],
      hasMissingRequiredField: false,
      missingFields: [],
      hasWrongType: false,
      classification: "MALFORMED_OUTPUT",
      validatorIssues: ["Raw output was empty"],
      proposalValidatorPassed: false,
    };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawOutput);
  } catch (err: any) {
    return {
      trialIndex: 0,
      condition,
      targetTool: task.targetTool,
      trialNum,
      promptBytes,
      durationMs,
      isTimeout: false,
      rawOutput,
      isValidToolInput: false,
      isCorrectTool: false,
      hasInventedField: false,
      inventedFields: [],
      hasMissingRequiredField: false,
      missingFields: [],
      hasWrongType: false,
      classification: "MALFORMED_OUTPUT",
      validatorIssues: [`JSON parse failure: ${err.message}`],
      proposalValidatorPassed: false,
    };
  }

  const selectedTool = parsed?.toolName;
  const isCorrectTool = selectedTool === task.targetTool;
  const inputPayload = parsed?.inputPayload;

  // Run through ProposalValidator with dummy active run context
  const runSnapshot = createDummyRunSnapshot(`run-10h-${condition}-${task.targetTool}-${trialNum}`, contextSnapshot.contextHash);
  const contract = createDummyMissionContract();
  const valContext: ProposalValidationContext = {
    runId: runSnapshot.runId,
    contextSnapshot,
    run: runSnapshot,
    contract,
  };

  const propValResult = validator.validate(parsed, valContext);

  if (!isCorrectTool) {
    return {
      trialIndex: 0,
      condition,
      targetTool: task.targetTool,
      trialNum,
      promptBytes,
      durationMs,
      isTimeout: false,
      rawOutput,
      parsedProposal: parsed,
      selectedTool,
      isValidToolInput: false,
      isCorrectTool: false,
      hasInventedField: false,
      inventedFields: [],
      hasMissingRequiredField: false,
      missingFields: [],
      hasWrongType: false,
      classification: "WRONG_TOOL_SELECTED",
      validatorIssues: [`Selected tool '${selectedTool}' does not match expected target '${task.targetTool}'`],
      proposalValidatorPassed: false,
    };
  }

  // SafeParse input payload against target tool's schema
  const parseRes = task.inputSchema.safeParse(inputPayload);
  const validatorIssues: string[] = [];
  const inventedFields: string[] = [];
  const missingFields: string[] = [];
  let hasWrongType = false;

  if (!parseRes.success) {
    for (const issue of parseRes.error.issues) {
      const issueMsg = `${issue.path.join(".")}: ${issue.message}`;
      validatorIssues.push(issueMsg);
      if (issue.code === "unrecognized_keys") {
        for (const k of (issue as any).keys) {
          if (!inventedFields.includes(k)) inventedFields.push(k);
        }
      } else if (issue.message.toLowerCase().includes("required") || (issue as any).received === "undefined") {
        const fieldName = issue.path[0] ? String(issue.path[0]) : "unknown";
        if (!missingFields.includes(fieldName)) missingFields.push(fieldName);
      } else if (issue.code === "invalid_type") {
        hasWrongType = true;
      }
    }
  }

  const isValidToolInput = parseRes.success;
  const hasInventedField = inventedFields.length > 0;
  const hasMissingRequiredField = missingFields.length > 0;

  let classification: ResponseClassification;
  if (isValidToolInput) {
    classification = "VALID_TOOL_INPUT";
  } else if (hasInventedField) {
    classification = "INVENTED_FIELD";
  } else if (hasMissingRequiredField) {
    classification = "MISSING_REQUIRED_FIELD";
  } else if (hasWrongType) {
    classification = "WRONG_PARAMETER_TYPE";
  } else {
    classification = "SCHEMA_CONSTRAINT_VIOLATION";
  }

  return {
    trialIndex: 0,
    condition,
    targetTool: task.targetTool,
    trialNum,
    promptBytes,
    durationMs,
    isTimeout: false,
    rawOutput,
    parsedProposal: parsed,
    selectedTool,
    isValidToolInput,
    isCorrectTool: true,
    hasInventedField,
    inventedFields,
    hasMissingRequiredField,
    missingFields,
    hasWrongType,
    classification,
    validatorIssues,
    proposalValidatorPassed: propValResult.valid,
  };
}

// ============================================================================
// 8. Main Execution
// ============================================================================

export async function runPhase10HDiagnostic(): Promise<void> {
  console.log("\n================================================================================");
  console.log("PHASE 10H: MULTI-TOOL ARGUMENT CONFORMANCE DIAGNOSTIC (LLAMA 3.2:3B)");
  console.log(`Started: ${new Date().toISOString()}`);
  console.log("================================================================================\n");

  const model = "llama3.2:3b";
  const baseUrl = "http://127.0.0.1:11434";
  const timeoutMs = 120_000;
  const trialsPerCell = parseInt(process.env.PHASE10H_TRIALS || "3", 10);

  // 1. Preflight Invariants
  const check = await checkOllamaLiveAvailability(baseUrl, model);
  if (!check.available) {
    throw new Error(`Preflight failed: Ollama unreachable or model missing: ${check.reason}`);
  }
  console.log(`[PREFLIGHT] Ollama reachable at ${baseUrl}. Model '${model}' verified available.`);

  verifyHistoricalArtifactsPreserved();

  const totalTrials = TOOL_TEST_TASKS.length * 2 * trialsPerCell;
  console.log(`[PLAN] 6 tools × 2 conditions (BASELINE, STANDARDIZED) × ${trialsPerCell} trials = ${totalTrials} calls.\n`);

  const provider = new OllamaModelProvider({ baseUrl, defaultTimeoutMs: timeoutMs });
  const validator = new ProposalValidator();
  const records: TrialRecord[] = [];

  const existingCheckpointRecords: TrialRecord[] = [];
  if (fs.existsSync(CHECKPOINT_PATH)) {
    const lines = fs.readFileSync(CHECKPOINT_PATH, "utf8").trim().split("\n");
    for (const line of lines) {
      if (line.trim()) {
        try {
          existingCheckpointRecords.push(JSON.parse(line));
        } catch {}
      }
    }
    console.log(`[CHECKPOINT] Loaded ${existingCheckpointRecords.length} existing records from ${CHECKPOINT_PATH}`);
  }

  let globalIndex = 0;

  for (const condition of ["BASELINE", "STANDARDIZED"] as const) {
    console.log(`\n--------------------------------------------------------------------------------`);
    console.log(`CONDITION: ${condition}`);
    console.log(`--------------------------------------------------------------------------------`);

    for (const task of TOOL_TEST_TASKS) {
      console.log(`\n[TOOL] ${task.targetTool.toUpperCase()} — Directive: "${task.directive}"`);

      for (let trial = 1; trial <= trialsPerCell; trial++) {
        globalIndex++;
        const { request, contextSnapshot, promptBytes } = buildDiagnosticModelRequest(
          condition,
          task,
          trial,
          timeoutMs,
          model
        );

        // Check if already in checkpoint
        const existingRecord = existingCheckpointRecords.find(
          (r) => r.condition === condition && r.targetTool === task.targetTool && r.trialNum === trial
        );

        if (existingRecord) {
          const reusedRecord: TrialRecord = { ...existingRecord, trialIndex: globalIndex };
          records.push(reusedRecord);
          console.log(
            `  Trial ${trial}/${trialsPerCell} (Call ${globalIndex}/${totalTrials}) [REUSED FROM CHECKPOINT]: ${reusedRecord.classification} (${(reusedRecord.durationMs / 1000).toFixed(1)}s)`
          );
          continue;
        }

        console.log(
          `  Trial ${trial}/${trialsPerCell} (Call ${globalIndex}/${totalTrials}) [prompt: ${promptBytes} bytes] ...`
        );

        const startTime = Date.now();
        let isTimeout = false;
        let rawOutput: string | undefined;

        try {
          const resp = await provider.generate(request);
          rawOutput = resp.outputText;
        } catch (err: any) {
          if (
            err.name === "ModelRequestTimeoutError" ||
            err.name === "ModelTimeoutError" ||
            String(err).toLowerCase().includes("timeout") ||
            err.message?.toLowerCase().includes("timeout")
          ) {
            isTimeout = true;
          } else {
            console.error(`    Inference error: ${err.message}`);
          }
        }

        const durationMs = Date.now() - startTime;
        const record = evaluateModelResponse(
          task,
          condition,
          trial,
          promptBytes,
          durationMs,
          isTimeout,
          rawOutput,
          contextSnapshot,
          validator
        );

        (record as any).trialIndex = globalIndex;
        records.push(record);
        fs.appendFileSync(CHECKPOINT_PATH, JSON.stringify(record) + "\n", "utf8");

        const statusIcon = record.isValidToolInput ? "✔ VALID" : "✘ REJECTED";
        console.log(
          `    Result: ${statusIcon} [${record.classification}] (${(durationMs / 1000).toFixed(1)}s)` +
            (record.inventedFields.length > 0 ? ` (invented: ${record.inventedFields.join(", ")})` : "") +
            (record.missingFields.length > 0 ? ` (missing: ${record.missingFields.join(", ")})` : "")
        );
      }
    }
  }

  // ============================================================================
  // 9. Aggregation & Metrics
  // ============================================================================

  function aggregateCondition(cond: DiagnosticCondition) {
    const condRecords = records.filter((r) => r.condition === cond);
    const n = condRecords.length;
    const validCount = condRecords.filter((r) => r.isValidToolInput).length;
    const inventedCount = condRecords.filter((r) => r.hasInventedField).length;
    const missingCount = condRecords.filter((r) => r.hasMissingRequiredField).length;
    const wrongTypeCount = condRecords.filter((r) => r.hasWrongType).length;
    const wrongToolCount = condRecords.filter((r) => !r.isCorrectTool && !r.isTimeout).length;
    const timeoutCount = condRecords.filter((r) => r.isTimeout).length;

    const latencies = condRecords.map((r) => r.durationMs).sort((a, b) => a - b);
    const meanLatency = latencies.reduce((a, b) => a + b, 0) / (n || 1);
    const medianLatency = latencies[Math.floor(latencies.length / 2)] || 0;
    const meanPromptBytes = condRecords.map((r) => r.promptBytes).reduce((a, b) => a + b, 0) / (n || 1);

    const toolBreakdown: Record<string, any> = {};
    for (const t of TOOL_TEST_TASKS) {
      const toolRecords = condRecords.filter((r) => r.targetTool === t.targetTool);
      const toolValid = toolRecords.filter((r) => r.isValidToolInput).length;
      const toolInvented = toolRecords.filter((r) => r.hasInventedField).length;
      toolBreakdown[t.targetTool] = {
        totalTrials: toolRecords.length,
        validCount: toolValid,
        validRate: toolValid / (toolRecords.length || 1),
        inventedCount: toolInvented,
        inventedRate: toolInvented / (toolRecords.length || 1),
        meanLatencyMs: toolRecords.reduce((a, b) => a + b.durationMs, 0) / (toolRecords.length || 1),
      };
    }

    return {
      totalTrials: n,
      validToolInputCount: validCount,
      validToolInputRate: validCount / (n || 1),
      inventedFieldCount: inventedCount,
      inventedFieldRate: inventedCount / (n || 1),
      missingFieldCount: missingCount,
      missingFieldRate: missingCount / (n || 1),
      wrongTypeCount: wrongTypeCount,
      wrongTypeRate: wrongTypeCount / (n || 1),
      wrongToolCount: wrongToolCount,
      wrongToolRate: wrongToolCount / (n || 1),
      timeoutCount,
      timeoutRate: timeoutCount / (n || 1),
      meanPromptBytes,
      meanLatencyMs: meanLatency,
      medianLatencyMs: medianLatency,
      toolBreakdown,
    };
  }

  const baselineMetrics = aggregateCondition("BASELINE");
  const standardizedMetrics = aggregateCondition("STANDARDIZED");

  const promptByteOverhead = standardizedMetrics.meanPromptBytes - baselineMetrics.meanPromptBytes;
  const promptByteOverheadRatio = standardizedMetrics.meanPromptBytes / (baselineMetrics.meanPromptBytes || 1);
  const latencyDeltaMs = standardizedMetrics.meanLatencyMs - baselineMetrics.meanLatencyMs;

  let primaryOutcome: string;
  let outcomeInterpretation: string;

  if (standardizedMetrics.validToolInputRate >= 0.8 && standardizedMetrics.validToolInputRate > baselineMetrics.validToolInputRate + 0.3) {
    primaryOutcome = "STRONG_IMPROVEMENT";
    outcomeInterpretation = `Standardized projection materially resolved argument conformance across the catalog (${(standardizedMetrics.validToolInputRate * 100).toFixed(1)}% vs ${(baselineMetrics.validToolInputRate * 100).toFixed(1)}%). Proceed to production projection implementation.`;
  } else if (standardizedMetrics.validToolInputRate > baselineMetrics.validToolInputRate) {
    primaryOutcome = "MODERATE_IMPROVEMENT";
    outcomeInterpretation = `Standardized projection improved conformance (${(standardizedMetrics.validToolInputRate * 100).toFixed(1)}% vs ${(baselineMetrics.validToolInputRate * 100).toFixed(1)}%), but specific tool gaps remain.`;
  } else {
    primaryOutcome = "WEAK_OR_NO_IMPROVEMENT";
    outcomeInterpretation = `Standardized projection did not produce meaningful improvement (${(standardizedMetrics.validToolInputRate * 100).toFixed(1)}% vs ${(baselineMetrics.validToolInputRate * 100).toFixed(1)}%). Model capacity limits dominate.`;
  }

  const summary = {
    diagnosticName: "Phase 10H Multi-Tool Argument Conformance Diagnostic",
    timestamp: new Date().toISOString(),
    model,
    baseUrl,
    timeoutMs,
    trialsPerCell,
    totalModelCalls: records.length,
    conditionMetrics: {
      BASELINE: baselineMetrics,
      STANDARDIZED: standardizedMetrics,
    },
    overheadAnalysis: {
      baselineMeanPromptBytes: baselineMetrics.meanPromptBytes,
      standardizedMeanPromptBytes: standardizedMetrics.meanPromptBytes,
      promptByteOverhead,
      promptByteOverheadRatio,
      latencyDeltaMs,
    },
    interpretation: {
      primaryOutcome,
      outcomeInterpretation,
    },
    records,
  };

  fs.writeFileSync(TARGET_ARTIFACT_PATH, JSON.stringify(summary, null, 2), "utf8");
  console.log(`\n[ARTIFACT] Phase 10H diagnostic summary persisted to: ${TARGET_ARTIFACT_PATH}`);

  // Summary printout
  console.log("\n================================================================================");
  console.log("PHASE 10H DIAGNOSTIC SUMMARY REPORT");
  console.log("================================================================================");
  console.log(`Primary Metric (Valid Tool Input Rate):`);
  console.log(`  BASELINE:     ${(baselineMetrics.validToolInputRate * 100).toFixed(1)}% (${baselineMetrics.validToolInputCount}/${baselineMetrics.totalTrials})`);
  console.log(`  STANDARDIZED: ${(standardizedMetrics.validToolInputRate * 100).toFixed(1)}% (${standardizedMetrics.validToolInputCount}/${standardizedMetrics.totalTrials})`);
  console.log(`  Delta:        +${((standardizedMetrics.validToolInputRate - baselineMetrics.validToolInputRate) * 100).toFixed(1)}%`);
  console.log(`\nSecondary Metrics:`);
  console.log(`  Invented Field Rate:  BASELINE ${(baselineMetrics.inventedFieldRate * 100).toFixed(1)}% vs STANDARDIZED ${(standardizedMetrics.inventedFieldRate * 100).toFixed(1)}%`);
  console.log(`  Missing Field Rate:   BASELINE ${(baselineMetrics.missingFieldRate * 100).toFixed(1)}% vs STANDARDIZED ${(standardizedMetrics.missingFieldRate * 100).toFixed(1)}%`);
  console.log(`  Wrong Type Rate:      BASELINE ${(baselineMetrics.wrongTypeRate * 100).toFixed(1)}% vs STANDARDIZED ${(standardizedMetrics.wrongTypeRate * 100).toFixed(1)}%`);
  console.log(`  Wrong Tool Rate:      BASELINE ${(baselineMetrics.wrongToolRate * 100).toFixed(1)}% vs STANDARDIZED ${(standardizedMetrics.wrongToolRate * 100).toFixed(1)}%`);
  console.log(`  Timeout Rate:         BASELINE ${(baselineMetrics.timeoutRate * 100).toFixed(1)}% vs STANDARDIZED ${(standardizedMetrics.timeoutRate * 100).toFixed(1)}%`);
  console.log(`\nPer-Tool Valid Rate Comparison:`);
  for (const t of TOOL_TEST_TASKS) {
    const b = baselineMetrics.toolBreakdown[t.targetTool];
    const s = standardizedMetrics.toolBreakdown[t.targetTool];
    console.log(`  - ${t.targetTool.padEnd(12)}: BASELINE ${(b.validRate * 100).toFixed(0)}% (${b.validCount}/${b.totalTrials}) ──▶ STANDARDIZED ${(s.validRate * 100).toFixed(0)}% (${s.validCount}/${s.totalTrials})`);
  }
  console.log(`\nOverhead & Latency:`);
  console.log(`  Prompt Bytes: BASELINE ${baselineMetrics.meanPromptBytes.toFixed(0)}B vs STANDARDIZED ${standardizedMetrics.meanPromptBytes.toFixed(0)}B (+${promptByteOverhead.toFixed(0)}B, ${promptByteOverheadRatio.toFixed(2)}x)`);
  console.log(`  Mean Latency: BASELINE ${(baselineMetrics.meanLatencyMs / 1000).toFixed(1)}s vs STANDARDIZED ${(standardizedMetrics.meanLatencyMs / 1000).toFixed(1)}s (Delta: ${(latencyDeltaMs / 1000).toFixed(1)}s)`);
  console.log(`\nOutcome: [${primaryOutcome}]`);
  console.log(`  ${outcomeInterpretation}`);
  console.log("================================================================================\n");
}

runPhase10HDiagnostic().catch((err) => {
  console.error("FATAL: Phase 10H diagnostic aborted:", err);
  process.exit(1);
});
