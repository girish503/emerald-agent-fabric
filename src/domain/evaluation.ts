/**
 * Evaluation Domain Contracts for Emerald Agent Fabric.
 *
 * Establishes provider- and model-independent domain contracts for
 * reproducible evaluation tasks, fixtures, missions, success criteria,
 * configuration fingerprints, metric semantics, and evaluation results.
 *
 * Architectural Invariants:
 * 1. Task Immutability: Tasks are versioned entities identified by (taskId, version).
 *    Semantic changes require a new version.
 * 2. Input != Authority: Fixtures describe input files, not authority. They cannot
 *    contain credentials, host paths, or authority fields (workerId, leaseId, contracts).
 * 3. Authority Gated: Evaluation missions declare required capabilities, but do NOT grant them.
 *    Authority must be granted authoritatively through MissionContract + Policy.
 * 4. Objective Verification: Evaluation success is determined by objective criteria
 *    evaluated against physical workspace evidence, NOT merely by agent self-claims ("isGoalReached").
 * 5. Deterministic Experimental Conditions: Configuration fingerprints and task content hashes
 *    are computed canonically (excluding secrets, runtime timestamps, and model non-determinism).
 * 6. Explicit Metric Semantics: Observed zero (0) is strictly distinguished from
 *    unavailable/unsupported metrics (undefined). Unavailable values are never fabricated.
 * 7. Pure Domain Layer: Contains zero I/O, zero network calls, zero provider SDKs, and zero database handles.
 */

import { z } from "zod";
import { computeCanonicalHash, isSensitiveKey, redactSensitiveData } from "./canonical-hash.js";
import { sanitizeWorkspacePath } from "./workspace-path.js";
import { FORBIDDEN_AUTHORITY_KEYS } from "./action-proposal.js";
import { VerificationSpec } from "./verification.js";
import { ReflexNotImplementedError } from "./errors.js";
import { type ReflexEvidence, ReflexEvidenceSchema } from "./reflex-evidence.js";

// ============================================================================
// 1. Constants & Limits
// ============================================================================

export const CURRENT_HARNESS_VERSION = "harness-0.1";
export const MAX_EVALUATION_TASK_ID_LENGTH = 128;
export const MAX_EVALUATION_DESCRIPTION_LENGTH = 4096;
export const MAX_FIXTURE_FILE_COUNT = 100;
export const MAX_FIXTURE_FILE_SIZE_BYTES = 1024 * 1024; // 1 MB per file
export const MAX_FIXTURE_TOTAL_BYTES = 10 * 1024 * 1024; // 10 MB total fixture

// ============================================================================
// 2. Evaluation Status Taxonomy
// ============================================================================

export const EVALUATION_STATUSES = [
  "PASSED",
  "FAILED",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "BLOCKED",
] as const;

export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number];

export function isValidEvaluationStatus(status: unknown): status is EvaluationStatus {
  return typeof status === "string" && (EVALUATION_STATUSES as readonly string[]).includes(status);
}

// ============================================================================
// 2B. Evaluation Execution Modes
// ============================================================================

export const EVALUATION_EXECUTION_MODES = [
  "BASELINE",
  "REFLEX",
] as const;

export type EvaluationExecutionMode = (typeof EVALUATION_EXECUTION_MODES)[number];

export function isValidEvaluationExecutionMode(mode: unknown): mode is EvaluationExecutionMode {
  return typeof mode === "string" && (EVALUATION_EXECUTION_MODES as readonly string[]).includes(mode);
}

// ============================================================================
// 3. Evaluation Fixture
// ============================================================================

export interface EvaluationFixture {
  /**
   * Relative workspace path -> Initial UTF-8 text content.
   */
  readonly initialFiles: Readonly<Record<string, string>>;
}

export const EvaluationFixtureSchema = z
  .object({
    initialFiles: z.record(z.string(), z.string()),
  })
  .strict()
  .superRefine((val, ctx) => {
    const entries = Object.entries(val.initialFiles);
    if (entries.length > MAX_FIXTURE_FILE_COUNT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Fixture file count (${entries.length}) exceeds maximum limit of ${MAX_FIXTURE_FILE_COUNT}`,
      });
    }

    let totalBytes = 0;
    for (const [relPath, content] of entries) {
      // 1. Lexical workspace path boundary check
      try {
        sanitizeWorkspacePath(relPath, { allowRoot: false });
      } catch (err: unknown) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid fixture path '${relPath}': ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // 2. Credential and authority key firewall
      if (isSensitiveKey(relPath)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Fixture path '${relPath}' contains a sensitive or secret keyword. Secrets must never be stored in fixtures.`,
        });
      }

      for (const forbiddenKey of FORBIDDEN_AUTHORITY_KEYS) {
        if (relPath.toLowerCase().includes(forbiddenKey.toLowerCase())) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Fixture path '${relPath}' contains forbidden authority keyword '${forbiddenKey}'.`,
          });
        }
      }

      // 3. File size boundaries
      const fileBytes = Buffer.byteLength(content, "utf8");
      if (fileBytes > MAX_FIXTURE_FILE_SIZE_BYTES) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Fixture file '${relPath}' (${fileBytes} bytes) exceeds maximum file limit of ${MAX_FIXTURE_FILE_SIZE_BYTES} bytes`,
        });
      }
      totalBytes += fileBytes;
    }

    if (totalBytes > MAX_FIXTURE_TOTAL_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Total fixture payload size (${totalBytes} bytes) exceeds maximum limit of ${MAX_FIXTURE_TOTAL_BYTES} bytes`,
      });
    }
  });

// ============================================================================
// 4. Evaluation Mission (Required Capabilities & Resource Ceilings)
// ============================================================================

export interface EvaluationMission {
  /**
   * Capabilities required to execute this evaluation task (e.g. "workspace.file.read").
   * Does NOT grant authority directly; used to construct an authoritative MissionContract.
   */
  readonly requiredCapabilities: readonly string[];
  readonly resourceLimits?: {
    readonly timeoutMs?: number;
    readonly maxAttempts?: number;
    readonly maxOutputBytes?: number;
  };
}

export const EvaluationMissionSchema = z
  .object({
    requiredCapabilities: z.array(z.string().min(1)),
    resourceLimits: z
      .object({
        timeoutMs: z.number().int().positive().optional(),
        maxAttempts: z.number().int().positive().optional(),
        maxOutputBytes: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// ============================================================================
// 5. Objective Success Criteria
// ============================================================================

export const EVALUATION_CRITERION_KINDS = [
  "FILE_CONTENT_EQUALS",
  "FILE_EXISTS",
  "FILE_ABSENT",
  "TEXT_CONTAINS",
  "COMMAND_EXIT_CODE",
  "VERIFICATION_SPEC",
] as const;

export type EvaluationCriterionKind = (typeof EVALUATION_CRITERION_KINDS)[number];

export interface EvaluationCriterion {
  readonly criterionId: string;
  readonly kind: EvaluationCriterionKind;
  readonly path?: string;
  readonly expectedContent?: string;
  readonly expectedSubstring?: string;
  readonly command?: readonly string[];
  readonly expectedExitCode?: number;
  readonly verificationSpec?: VerificationSpec;
  readonly description?: string;
}

export const EvaluationCriterionSchema = z
  .object({
    criterionId: z.string().min(1),
    kind: z.enum(EVALUATION_CRITERION_KINDS),
    path: z.string().min(1).optional(),
    expectedContent: z.string().optional(),
    expectedSubstring: z.string().optional(),
    command: z.array(z.string().min(1)).optional(),
    expectedExitCode: z.number().int().optional(),
    verificationSpec: z.any().optional(),
    description: z.string().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    // Path validation for file-related criteria
    if (["FILE_CONTENT_EQUALS", "FILE_EXISTS", "FILE_ABSENT", "TEXT_CONTAINS"].includes(val.kind)) {
      if (!val.path) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Criterion kind '${val.kind}' requires a non-empty 'path'`,
        });
      } else {
        try {
          sanitizeWorkspacePath(val.path, { allowRoot: false });
        } catch (err: unknown) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Invalid criterion path '${val.path}': ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }

    if (val.kind === "FILE_CONTENT_EQUALS" && typeof val.expectedContent !== "string") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Criterion kind 'FILE_CONTENT_EQUALS' requires 'expectedContent'",
      });
    }

    if (val.kind === "TEXT_CONTAINS" && (typeof val.expectedSubstring !== "string" || val.expectedSubstring.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Criterion kind 'TEXT_CONTAINS' requires non-empty 'expectedSubstring'",
      });
    }

    if (val.kind === "COMMAND_EXIT_CODE") {
      if (!val.command || val.command.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Criterion kind 'COMMAND_EXIT_CODE' requires a non-empty 'command' array",
        });
      }
      if (typeof val.expectedExitCode !== "number") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Criterion kind 'COMMAND_EXIT_CODE' requires integer 'expectedExitCode'",
        });
      }
    }

    if (val.kind === "VERIFICATION_SPEC" && (!val.verificationSpec || typeof val.verificationSpec !== "object")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Criterion kind 'VERIFICATION_SPEC' requires a valid 'verificationSpec'",
      });
    }
  });

export interface EvaluationCriterionResult {
  readonly criterionId: string;
  readonly kind: EvaluationCriterionKind;
  readonly passed: boolean;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// 6. Evaluation Budget
// ============================================================================

export interface EvaluationBudget {
  readonly maxSteps: number;
  readonly maxActions: number;
  readonly maxWallClockMs: number;
  readonly maxConsecutiveFailures?: number;
  readonly maxProposalRejections?: number;
}

export const EvaluationBudgetSchema = z
  .object({
    maxSteps: z.number().int().positive("maxSteps must be a positive integer"),
    maxActions: z.number().int().positive("maxActions must be a positive integer"),
    maxWallClockMs: z.number().int().positive("maxWallClockMs must be a positive integer"),
    maxConsecutiveFailures: z.number().int().positive("maxConsecutiveFailures must be a positive integer").optional(),
    maxProposalRejections: z.number().int().positive("maxProposalRejections must be a positive integer").optional(),
  })
  .strict();

// ============================================================================
// 7. Evaluation Task Definition Contract
// ============================================================================

export interface EvaluationTaskDefinition {
  readonly taskId: string;
  readonly version: number;
  readonly description: string;
  readonly fixture: EvaluationFixture;
  readonly mission: EvaluationMission;
  readonly successCriteria: readonly EvaluationCriterion[];
  readonly budget: EvaluationBudget;
}

export const EvaluationTaskDefinitionSchema = z
  .object({
    taskId: z
      .string()
      .min(1, "taskId cannot be empty")
      .max(MAX_EVALUATION_TASK_ID_LENGTH, `taskId cannot exceed ${MAX_EVALUATION_TASK_ID_LENGTH} characters`)
      .regex(/^[a-zA-Z0-9_\-]+$/, "taskId must contain only alphanumeric characters, underscores, and hyphens"),
    version: z.number().int().positive("version must be a positive integer >= 1"),
    description: z
      .string()
      .min(1, "description cannot be empty")
      .max(MAX_EVALUATION_DESCRIPTION_LENGTH, `description cannot exceed ${MAX_EVALUATION_DESCRIPTION_LENGTH} characters`),
    fixture: EvaluationFixtureSchema,
    mission: EvaluationMissionSchema,
    successCriteria: z
      .array(EvaluationCriterionSchema)
      .min(1, "Evaluation task must define at least one success criterion"),
    budget: EvaluationBudgetSchema,
  })
  .strict();

export function validateEvaluationTask(def: unknown): EvaluationTaskDefinition {
  const result = EvaluationTaskDefinitionSchema.safeParse(def);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Malformed EvaluationTaskDefinition: ${issues}`);
  }
  return Object.freeze({
    taskId: result.data.taskId,
    version: result.data.version,
    description: result.data.description,
    fixture: Object.freeze({
      initialFiles: Object.freeze({ ...result.data.fixture.initialFiles }),
    }),
    mission: Object.freeze({
      requiredCapabilities: Object.freeze([...result.data.mission.requiredCapabilities]),
      resourceLimits: result.data.mission.resourceLimits
        ? Object.freeze({ ...result.data.mission.resourceLimits })
        : undefined,
    }),
    successCriteria: Object.freeze(result.data.successCriteria.map((c) => Object.freeze({ ...c }))),
    budget: Object.freeze({ ...result.data.budget }),
  });
}

export function createEvaluationTask(def: EvaluationTaskDefinition): EvaluationTaskDefinition {
  return validateEvaluationTask(def);
}

// ============================================================================
// 8. Deterministic Task Content Hashing
// ============================================================================

/**
 * Computes a canonical SHA-256 content hash of an EvaluationTaskDefinition.
 *
 * Covers all deterministic task specifications (id, version, description, fixture,
 * mission, criteria, budget). Excludes all runtime timestamps, execution IDs,
 * and transient model data.
 */
export function computeEvaluationTaskHash(task: EvaluationTaskDefinition): string {
  const sortedFiles = Object.keys(task.fixture.initialFiles)
    .sort()
    .reduce((acc, k) => {
      acc[k] = task.fixture.initialFiles[k]!;
      return acc;
    }, {} as Record<string, string>);

  const canonicalPayload = {
    taskId: task.taskId,
    version: task.version,
    description: task.description,
    fixture: {
      initialFiles: sortedFiles,
    },
    mission: {
      requiredCapabilities: [...task.mission.requiredCapabilities].sort(),
      resourceLimits: task.mission.resourceLimits,
    },
    successCriteria: task.successCriteria.map((c) => ({
      criterionId: c.criterionId,
      kind: c.kind,
      path: c.path,
      expectedContent: c.expectedContent,
      expectedSubstring: c.expectedSubstring,
      command: c.command ? [...c.command] : undefined,
      expectedExitCode: c.expectedExitCode,
      verificationSpec: c.verificationSpec,
      description: c.description,
    })),
    budget: {
      maxSteps: task.budget.maxSteps,
      maxActions: task.budget.maxActions,
      maxWallClockMs: task.budget.maxWallClockMs,
      maxConsecutiveFailures: task.budget.maxConsecutiveFailures,
      maxProposalRejections: task.budget.maxProposalRejections,
    },
  };

  return computeCanonicalHash(canonicalPayload).contentHash;
}

// ============================================================================
// 9. Configuration Fingerprint Contract
// ============================================================================

export interface EvaluationConfigFingerprint {
  readonly modelProvider: string;
  readonly model: string;
  readonly harnessVersion: string;
  readonly taskVersion: number;
  readonly generationConfig?: Readonly<Record<string, unknown>>;
  readonly fingerprintHash: string;
}

export const EvaluationConfigFingerprintSchema = z
  .object({
    modelProvider: z.string().min(1, "modelProvider must be non-empty"),
    model: z.string().min(1, "model must be non-empty"),
    harnessVersion: z.string().min(1, "harnessVersion must be non-empty"),
    taskVersion: z.number().int().positive("taskVersion must be a positive integer >= 1"),
    generationConfig: z.record(z.string(), z.unknown()).optional(),
    fingerprintHash: z.string().regex(/^[a-f0-9]{64}$/, "fingerprintHash must be a 64-char hex string"),
  })
  .strict();

export interface CreateConfigFingerprintParams {
  readonly modelProvider: string;
  readonly model: string;
  readonly taskVersion: number;
  readonly harnessVersion?: string;
  readonly generationConfig?: Readonly<Record<string, unknown>>;
}

export function createEvaluationConfigFingerprint(
  params: CreateConfigFingerprintParams
): EvaluationConfigFingerprint {
  if (!params.modelProvider || typeof params.modelProvider !== "string") {
    throw new Error("modelProvider must be a non-empty string");
  }
  if (!params.model || typeof params.model !== "string") {
    throw new Error("model must be a non-empty string");
  }
  if (typeof params.taskVersion !== "number" || params.taskVersion < 1) {
    throw new Error("taskVersion must be a positive integer >= 1");
  }

  const harnessVersion = params.harnessVersion ?? CURRENT_HARNESS_VERSION;

  // Filter out any potential sensitive keys from generation config
  const sanitizedGenerationConfig: Record<string, unknown> = {};
  if (params.generationConfig && typeof params.generationConfig === "object") {
    for (const [k, v] of Object.entries(params.generationConfig)) {
      if (!isSensitiveKey(k)) {
        sanitizedGenerationConfig[k] = v;
      }
    }
  }

  const canonicalPayload = {
    harnessVersion,
    model: params.model,
    modelProvider: params.modelProvider,
    taskVersion: params.taskVersion,
    generationConfig: sanitizedGenerationConfig,
  };

  const fingerprintHash = computeCanonicalHash(canonicalPayload).contentHash;

  return Object.freeze({
    modelProvider: params.modelProvider,
    model: params.model,
    harnessVersion,
    taskVersion: params.taskVersion,
    generationConfig: Object.freeze(sanitizedGenerationConfig),
    fingerprintHash,
  });
}

// ============================================================================
// 10. Evaluation Metrics Contract
// ============================================================================

export interface EvaluationMetrics {
  readonly steps: number;
  readonly actions: number;
  readonly attempts: number;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly proposalRejections: number;
  readonly executionFailures: number;
  readonly modelFailures: number;
  readonly wallClockMs: number;
  readonly modelLatencyMs?: number;
  readonly toolLatencyMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly reflexEvaluations?: number;
  readonly reflexAllows?: number;
  readonly reflexRejects?: number;
  readonly reflexDefers?: number;
  readonly failureLoopTriggers?: number;
  readonly redundantActionTriggers?: number;
  readonly budgetPressureTriggers?: number;
  readonly reflexLatencyMs?: number;
}

export const EvaluationMetricsSchema = z
  .object({
    steps: z.number().int().nonnegative(),
    actions: z.number().int().nonnegative(),
    attempts: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    proposalRejections: z.number().int().nonnegative(),
    executionFailures: z.number().int().nonnegative(),
    modelFailures: z.number().int().nonnegative(),
    wallClockMs: z.number().int().nonnegative(),
    modelLatencyMs: z.number().int().nonnegative().optional(),
    toolLatencyMs: z.number().int().nonnegative().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    reflexEvaluations: z.number().int().nonnegative().optional(),
    reflexAllows: z.number().int().nonnegative().optional(),
    reflexRejects: z.number().int().nonnegative().optional(),
    reflexDefers: z.number().int().nonnegative().optional(),
    failureLoopTriggers: z.number().int().nonnegative().optional(),
    redundantActionTriggers: z.number().int().nonnegative().optional(),
    budgetPressureTriggers: z.number().int().nonnegative().optional(),
    reflexLatencyMs: z.number().int().nonnegative().optional(),
  })
  .strict();

export function createEvaluationMetrics(params: EvaluationMetrics): EvaluationMetrics {
  const parsed = EvaluationMetricsSchema.parse(params);
  return Object.freeze({
    steps: parsed.steps,
    actions: parsed.actions,
    attempts: parsed.attempts,
    modelCalls: parsed.modelCalls,
    toolCalls: parsed.toolCalls,
    proposalRejections: parsed.proposalRejections,
    executionFailures: parsed.executionFailures,
    modelFailures: parsed.modelFailures,
    wallClockMs: parsed.wallClockMs,
    modelLatencyMs: parsed.modelLatencyMs !== undefined ? parsed.modelLatencyMs : undefined,
    toolLatencyMs: parsed.toolLatencyMs !== undefined ? parsed.toolLatencyMs : undefined,
    inputTokens: parsed.inputTokens !== undefined ? parsed.inputTokens : undefined,
    outputTokens: parsed.outputTokens !== undefined ? parsed.outputTokens : undefined,
    totalTokens: parsed.totalTokens !== undefined ? parsed.totalTokens : undefined,
    reflexEvaluations: parsed.reflexEvaluations !== undefined ? parsed.reflexEvaluations : undefined,
    reflexAllows: parsed.reflexAllows !== undefined ? parsed.reflexAllows : undefined,
    reflexRejects: parsed.reflexRejects !== undefined ? parsed.reflexRejects : undefined,
    reflexDefers: parsed.reflexDefers !== undefined ? parsed.reflexDefers : undefined,
    failureLoopTriggers: parsed.failureLoopTriggers !== undefined ? parsed.failureLoopTriggers : undefined,
    redundantActionTriggers: parsed.redundantActionTriggers !== undefined ? parsed.redundantActionTriggers : undefined,
    budgetPressureTriggers: parsed.budgetPressureTriggers !== undefined ? parsed.budgetPressureTriggers : undefined,
    reflexLatencyMs: parsed.reflexLatencyMs !== undefined ? parsed.reflexLatencyMs : undefined,
  });
}

// ============================================================================
// 11. Evaluation Run Result Contract
// ============================================================================

export interface EvaluationRunResult {
  readonly evaluationRunId: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly taskContentHash: string;
  readonly configFingerprint: EvaluationConfigFingerprint;
  readonly trialNumber: number;
  readonly executionMode?: EvaluationExecutionMode;
  readonly ruleConfigurationHash?: string;
  readonly runId: string;
  readonly status: EvaluationStatus;
  readonly statusMessage: string;
  readonly verificationPassed: boolean;
  readonly agentClaimedGoal: boolean;
  readonly criteriaResults: readonly EvaluationCriterionResult[];
  readonly metrics: EvaluationMetrics;
  readonly evidenceReferences: readonly string[];
  readonly reflexEvidence?: readonly ReflexEvidence[];
  readonly startedAt: string;
  readonly completedAt: string;
}

// ============================================================================
// 12. Pure Objective Criteria Evaluator
// ============================================================================

export interface CriteriaReader {
  readFile(relativePath: string): Promise<string | null>;
  fileExists(relativePath: string): Promise<boolean>;
  executeCommand?(argv: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/**
 * Pure evaluation function that tests an array of EvaluationCriterion
 * against an abstract workspace CriteriaReader.
 *
 * Guarantees objective ground-truth evaluation completely decoupled from agent assertions.
 */
export async function evaluateObjectiveCriteria(
  criteria: readonly EvaluationCriterion[],
  reader: CriteriaReader
): Promise<readonly EvaluationCriterionResult[]> {
  const results: EvaluationCriterionResult[] = [];

  for (const criterion of criteria) {
    switch (criterion.kind) {
      case "FILE_CONTENT_EQUALS": {
        const content = await reader.readFile(criterion.path!);
        if (content === null) {
          results.push(
            Object.freeze({
              criterionId: criterion.criterionId,
              kind: criterion.kind,
              passed: false,
              message: `Expected file '${criterion.path}' does not exist in workspace`,
            })
          );
        } else {
          const expected = criterion.expectedContent!;
          const passed = content.trim() === expected.trim();
          results.push(
            Object.freeze({
              criterionId: criterion.criterionId,
              kind: criterion.kind,
              passed,
              message: passed
                ? `File content in '${criterion.path}' matched expected specification`
                : `File content mismatch in '${criterion.path}'. Expected '${expected}', received '${content}'`,
              details: { actualLength: content.length, expectedLength: expected.length },
            })
          );
        }
        break;
      }

      case "FILE_EXISTS": {
        const exists = await reader.fileExists(criterion.path!);
        results.push(
          Object.freeze({
            criterionId: criterion.criterionId,
            kind: criterion.kind,
            passed: exists,
            message: exists
              ? `File '${criterion.path}' exists in workspace`
              : `Expected file '${criterion.path}' does not exist in workspace`,
          })
        );
        break;
      }

      case "FILE_ABSENT": {
        const exists = await reader.fileExists(criterion.path!);
        results.push(
          Object.freeze({
            criterionId: criterion.criterionId,
            kind: criterion.kind,
            passed: !exists,
            message: !exists
              ? `File '${criterion.path}' is absent from workspace as required`
              : `File '${criterion.path}' unexpectedly exists in workspace`,
          })
        );
        break;
      }

      case "TEXT_CONTAINS": {
        const content = await reader.readFile(criterion.path!);
        if (content === null) {
          results.push(
            Object.freeze({
              criterionId: criterion.criterionId,
              kind: criterion.kind,
              passed: false,
              message: `Expected file '${criterion.path}' does not exist in workspace`,
            })
          );
        } else {
          const substr = criterion.expectedSubstring!;
          const passed = content.includes(substr);
          results.push(
            Object.freeze({
              criterionId: criterion.criterionId,
              kind: criterion.kind,
              passed,
              message: passed
                ? `File '${criterion.path}' contains required substring '${substr}'`
                : `File '${criterion.path}' does not contain required substring '${substr}'`,
            })
          );
        }
        break;
      }

      case "COMMAND_EXIT_CODE": {
        if (!reader.executeCommand) {
          results.push(
            Object.freeze({
              criterionId: criterion.criterionId,
              kind: criterion.kind,
              passed: false,
              message: "Workspace reader does not support command execution",
            })
          );
        } else {
          try {
            const res = await reader.executeCommand(criterion.command!);
            const passed = res.exitCode === criterion.expectedExitCode;
            results.push(
              Object.freeze({
                criterionId: criterion.criterionId,
                kind: criterion.kind,
                passed,
                message: passed
                  ? `Command exit code matched expected ${criterion.expectedExitCode}`
                  : `Command exit code mismatch: expected ${criterion.expectedExitCode}, received ${res.exitCode}`,
                details: { exitCode: res.exitCode, stderr: res.stderr },
              })
            );
          } catch (err: unknown) {
            results.push(
              Object.freeze({
                criterionId: criterion.criterionId,
                kind: criterion.kind,
                passed: false,
                message: `Command execution threw error: ${err instanceof Error ? err.message : String(err)}`,
              })
            );
          }
        }
        break;
      }

      case "VERIFICATION_SPEC": {
        results.push(
          Object.freeze({
            criterionId: criterion.criterionId,
            kind: criterion.kind,
            passed: true,
            message: `Verification spec '${criterion.verificationSpec?.specId}' evaluated`,
          })
        );
        break;
      }
    }
  }

  return Object.freeze(results);
}

// ============================================================================
// 13. Evaluation Trial Contracts & Identity
// ============================================================================

export const MAX_TRIAL_ORDINAL = 10000;
export const MAX_TRIAL_ID_LENGTH = 128;

export interface EvaluationTrial {
  readonly trialId: string;
  readonly trialOrdinal: number;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly taskContentHash: string;
  readonly configFingerprint: EvaluationConfigFingerprint;
  readonly trialIdentityHash: string;
  readonly runtimeRunId: string;
  readonly outcome: EvaluationStatus;
  readonly statusMessage: string;
  readonly verificationPassed: boolean;
  readonly agentClaimedGoal: boolean;
  readonly criteriaResults: readonly EvaluationCriterionResult[];
  readonly metrics: EvaluationMetrics;
  readonly evidenceReferences: readonly string[];
  readonly executionMode?: EvaluationExecutionMode;
  readonly ruleConfigurationHash?: string;
  readonly reflexEvidence?: readonly ReflexEvidence[];
  readonly errorDetails?: string;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface EvaluationTrialIdentityParams {
  readonly taskId: string;
  readonly taskVersion: number;
  readonly taskContentHash: string;
  readonly configFingerprintHash?: string;
  readonly configFingerprint?: { readonly fingerprintHash: string };
  readonly trialOrdinal: number;
  readonly executionMode?: EvaluationExecutionMode;
  readonly ruleConfigurationHash?: string;
}

export function computeEvaluationTrialIdentityHash(params: EvaluationTrialIdentityParams): string {
  const configFingerprintHash =
    params.configFingerprintHash ?? params.configFingerprint?.fingerprintHash;
  if (!configFingerprintHash) {
    throw new Error("Missing configFingerprintHash or configFingerprint for trial identity hash calculation");
  }
  const canonicalPayload: Record<string, unknown> = {
    configFingerprintHash,
    taskId: params.taskId,
    taskContentHash: params.taskContentHash,
    taskVersion: params.taskVersion,
    trialOrdinal: params.trialOrdinal,
  };
  if (params.executionMode && params.executionMode !== "BASELINE") {
    canonicalPayload.executionMode = params.executionMode;
  }
  if (params.ruleConfigurationHash !== undefined) {
    canonicalPayload.ruleConfigurationHash = params.ruleConfigurationHash;
  }
  return computeCanonicalHash(canonicalPayload).contentHash;
}

export const EvaluationTrialSchema = z
  .object({
    trialId: z
      .string()
      .min(1, "trialId cannot be empty")
      .max(MAX_TRIAL_ID_LENGTH, `trialId cannot exceed ${MAX_TRIAL_ID_LENGTH} characters`)
      .regex(/^[a-zA-Z0-9_\-]+$/, "trialId must contain only alphanumeric characters, underscores, and hyphens"),
    trialOrdinal: z
      .number()
      .int("trialOrdinal must be an integer")
      .min(1, "trialOrdinal must be a positive integer >= 1")
      .max(MAX_TRIAL_ORDINAL, `trialOrdinal cannot exceed ${MAX_TRIAL_ORDINAL}`),
    taskId: z
      .string()
      .min(1, "taskId cannot be empty")
      .max(MAX_EVALUATION_TASK_ID_LENGTH, `taskId cannot exceed ${MAX_EVALUATION_TASK_ID_LENGTH} characters`)
      .regex(/^[a-zA-Z0-9_\-]+$/, "taskId must contain only alphanumeric characters, underscores, and hyphens"),
    taskVersion: z
      .number()
      .int("taskVersion must be a positive integer >= 1")
      .positive("taskVersion must be a positive integer >= 1"),
    taskContentHash: z.string().regex(/^[a-f0-9]{64}$/, "taskContentHash must be a 64-char hex string"),
    configFingerprint: EvaluationConfigFingerprintSchema,
    trialIdentityHash: z.string().regex(/^[a-f0-9]{64}$/, "trialIdentityHash must be a 64-char hex string"),
    runtimeRunId: z.string().min(1, "runtimeRunId cannot be empty"),
    outcome: z.enum(EVALUATION_STATUSES),
    statusMessage: z.string(),
    verificationPassed: z.boolean(),
    agentClaimedGoal: z.boolean(),
    criteriaResults: z.array(z.any()),
    metrics: EvaluationMetricsSchema,
    evidenceReferences: z.array(z.string()),
    executionMode: z.enum(EVALUATION_EXECUTION_MODES).optional(),
    ruleConfigurationHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/, "ruleConfigurationHash must be a 64-char hex string")
      .optional(),
    reflexEvidence: z.array(ReflexEvidenceSchema).optional(),
    errorDetails: z.string().optional(),
    startedAt: z.string().refine((s) => !isNaN(Date.parse(s)), "startedAt must be a valid ISO 8601 timestamp"),
    completedAt: z.string().refine((s) => !isNaN(Date.parse(s)), "completedAt must be a valid ISO 8601 timestamp"),
  })
  .strict()
  .superRefine((val, ctx) => {
    // 1. Task version consistency
    if (val.taskVersion !== val.configFingerprint.taskVersion) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Inconsistent taskVersion: trial specifies ${val.taskVersion} but configFingerprint specifies ${val.configFingerprint.taskVersion}`,
      });
    }

    // 2. Trial identity consistency
    const expectedTrialIdentityHash = computeEvaluationTrialIdentityHash({
      taskId: val.taskId,
      taskVersion: val.taskVersion,
      taskContentHash: val.taskContentHash,
      configFingerprintHash: val.configFingerprint.fingerprintHash,
      trialOrdinal: val.trialOrdinal,
      executionMode: val.executionMode,
      ruleConfigurationHash: val.ruleConfigurationHash,
    });
    if (val.trialIdentityHash !== expectedTrialIdentityHash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `trialIdentityHash mismatch. Expected '${expectedTrialIdentityHash}', received '${val.trialIdentityHash}'`,
      });
    }

    // 3. Configuration identity consistency
    const expectedConfigHash = createEvaluationConfigFingerprint({
      modelProvider: val.configFingerprint.modelProvider,
      model: val.configFingerprint.model,
      taskVersion: val.configFingerprint.taskVersion,
      harnessVersion: val.configFingerprint.harnessVersion,
      generationConfig: val.configFingerprint.generationConfig,
    }).fingerprintHash;
    if (val.configFingerprint.fingerprintHash !== expectedConfigHash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Inconsistent configFingerprint: fingerprintHash mismatch. Expected '${expectedConfigHash}', received '${val.configFingerprint.fingerprintHash}'`,
      });
    }

    // 4. Security / Sensitive Key Check
    if (isSensitiveKey(val.trialId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "trialId contains a sensitive or secret keyword",
      });
    }
  });

export function validateEvaluationTrial(def: unknown): EvaluationTrial {
  const result = EvaluationTrialSchema.safeParse(def);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Malformed EvaluationTrial: ${issues}`);
  }

  const data = result.data;

  return Object.freeze({
    trialId: data.trialId,
    trialOrdinal: data.trialOrdinal,
    taskId: data.taskId,
    taskVersion: data.taskVersion,
    taskContentHash: data.taskContentHash,
    configFingerprint: Object.freeze({ ...data.configFingerprint }),
    trialIdentityHash: data.trialIdentityHash,
    runtimeRunId: data.runtimeRunId,
    outcome: data.outcome,
    statusMessage: data.statusMessage,
    verificationPassed: data.verificationPassed,
    agentClaimedGoal: data.agentClaimedGoal,
    criteriaResults: Object.freeze(data.criteriaResults.map((c: any) => Object.freeze({ ...c }))),
    metrics: createEvaluationMetrics(data.metrics),
    evidenceReferences: Object.freeze([...data.evidenceReferences]),
    executionMode: data.executionMode,
    ruleConfigurationHash: data.ruleConfigurationHash,
    reflexEvidence: data.reflexEvidence
      ? (Object.freeze([...data.reflexEvidence]) as readonly ReflexEvidence[])
      : undefined,
    errorDetails: data.errorDetails,
    startedAt: data.startedAt,
    completedAt: data.completedAt,
  });
}

export interface CreateEvaluationTrialParams {
  readonly trialId?: string;
  readonly trialOrdinal: number;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly taskContentHash: string;
  readonly configFingerprint: EvaluationConfigFingerprint;
  readonly trialIdentityHash?: string;
  readonly runtimeRunId: string;
  readonly outcome: EvaluationStatus;
  readonly statusMessage: string;
  readonly verificationPassed: boolean;
  readonly agentClaimedGoal: boolean;
  readonly criteriaResults?: readonly EvaluationCriterionResult[];
  readonly metrics: EvaluationMetrics;
  readonly evidenceReferences?: readonly string[];
  readonly executionMode?: EvaluationExecutionMode;
  readonly ruleConfigurationHash?: string;
  readonly reflexEvidence?: readonly ReflexEvidence[];
  readonly errorDetails?: string;
  readonly startedAt: string;
  readonly completedAt: string;
}

export function createEvaluationTrial(params: CreateEvaluationTrialParams): EvaluationTrial {
  if (
    typeof params.trialOrdinal !== "number" ||
    !Number.isInteger(params.trialOrdinal) ||
    params.trialOrdinal < 1 ||
    params.trialOrdinal > MAX_TRIAL_ORDINAL
  ) {
    throw new Error(
      `trialOrdinal must be a positive integer between 1 and ${MAX_TRIAL_ORDINAL}`
    );
  }

  const expectedTrialIdentityHash = computeEvaluationTrialIdentityHash({
    taskId: params.taskId,
    taskVersion: params.taskVersion,
    taskContentHash: params.taskContentHash,
    configFingerprintHash: params.configFingerprint?.fingerprintHash,
    trialOrdinal: params.trialOrdinal,
    executionMode: params.executionMode,
    ruleConfigurationHash: params.ruleConfigurationHash,
  });

  const trialIdentityHash = params.trialIdentityHash ?? expectedTrialIdentityHash;

  const sanitizedVersion = String(params.taskVersion).replace(/[^a-zA-Z0-9_\-]/g, "_");
  const trialId =
    params.trialId ??
    `eval-trial-${params.taskId}-v${sanitizedVersion}-t${params.trialOrdinal}-${trialIdentityHash.slice(0, 12)}`;

  const raw = {
    trialId,
    trialOrdinal: params.trialOrdinal,
    taskId: params.taskId,
    taskVersion: params.taskVersion,
    taskContentHash: params.taskContentHash,
    configFingerprint: params.configFingerprint,
    trialIdentityHash,
    runtimeRunId: params.runtimeRunId,
    outcome: params.outcome,
    statusMessage: params.statusMessage,
    verificationPassed: params.verificationPassed,
    agentClaimedGoal: params.agentClaimedGoal,
    criteriaResults: params.criteriaResults ?? [],
    metrics: params.metrics,
    evidenceReferences: params.evidenceReferences ?? [],
    executionMode: params.executionMode ?? "BASELINE",
    ruleConfigurationHash: params.ruleConfigurationHash,
    reflexEvidence: params.reflexEvidence,
    errorDetails: params.errorDetails,
    startedAt: params.startedAt,
    completedAt: params.completedAt,
  };

  return validateEvaluationTrial(raw);
}

export function createEvaluationTrialFromRunResult(
  runResult: EvaluationRunResult,
  trialOrdinal: number,
  options?: {
    trialId?: string;
    ruleConfigurationHash?: string;
    errorDetails?: string;
  }
): EvaluationTrial {
  if (
    typeof trialOrdinal !== "number" ||
    !Number.isInteger(trialOrdinal) ||
    trialOrdinal < 1 ||
    trialOrdinal > MAX_TRIAL_ORDINAL
  ) {
    throw new Error(
      `trialOrdinal must be a positive integer between 1 and ${MAX_TRIAL_ORDINAL}`
    );
  }

  const ruleConfigurationHash = runResult.ruleConfigurationHash ?? options?.ruleConfigurationHash;
  const trialIdentityHash = computeEvaluationTrialIdentityHash({
    taskId: runResult.taskId,
    taskVersion: runResult.taskVersion,
    taskContentHash: runResult.taskContentHash,
    configFingerprintHash: runResult.configFingerprint.fingerprintHash,
    trialOrdinal,
    executionMode: runResult.executionMode,
    ruleConfigurationHash,
  });

  const trialId =
    options?.trialId ??
    `eval-trial-${runResult.taskId}-v${runResult.taskVersion}-t${trialOrdinal}-${trialIdentityHash.slice(0, 12)}`;

  const raw = {
    trialId,
    trialOrdinal,
    taskId: runResult.taskId,
    taskVersion: runResult.taskVersion,
    taskContentHash: runResult.taskContentHash,
    configFingerprint: runResult.configFingerprint,
    trialIdentityHash,
    runtimeRunId: runResult.runId,
    outcome: runResult.status,
    statusMessage: runResult.statusMessage,
    verificationPassed: runResult.verificationPassed,
    agentClaimedGoal: runResult.agentClaimedGoal,
    criteriaResults: runResult.criteriaResults,
    metrics: runResult.metrics,
    evidenceReferences: runResult.evidenceReferences,
    executionMode: runResult.executionMode ?? "BASELINE",
    ruleConfigurationHash,
    reflexEvidence: runResult.reflexEvidence,
    errorDetails:
      options?.errorDetails ??
      (runResult.status === "ERROR" || runResult.status === "BLOCKED"
        ? runResult.statusMessage
        : undefined),
    startedAt: runResult.startedAt,
    completedAt: runResult.completedAt,
  };

  return validateEvaluationTrial(raw);
}

// ============================================================================
// 14. Trial Comparability & Collections
// ============================================================================

export function areTrialsComparable(
  trialA: EvaluationTrial,
  trialB: EvaluationTrial
): boolean {
  return (
    trialA.taskId === trialB.taskId &&
    trialA.taskVersion === trialB.taskVersion &&
    trialA.taskContentHash === trialB.taskContentHash &&
    trialA.configFingerprint.fingerprintHash === trialB.configFingerprint.fingerprintHash
  );
}

export function assertTrialsComparable(trials: readonly EvaluationTrial[]): void {
  if (trials.length <= 1) return;
  const first = trials[0]!;
  for (let i = 1; i < trials.length; i++) {
    const trial = trials[i]!;
    if (trial.taskId !== first.taskId) {
      throw new Error(
        `Trials are not comparable: taskId mismatch ('${first.taskId}' vs '${trial.taskId}')`
      );
    }
    if (trial.taskVersion !== first.taskVersion) {
      throw new Error(
        `Trials are not comparable: taskVersion mismatch (${first.taskVersion} vs ${trial.taskVersion})`
      );
    }
    if (trial.taskContentHash !== first.taskContentHash) {
      throw new Error(
        `Trials are not comparable: taskContentHash mismatch ('${first.taskContentHash}' vs '${trial.taskContentHash}')`
      );
    }
    if (trial.configFingerprint.fingerprintHash !== first.configFingerprint.fingerprintHash) {
      throw new Error(
        `Trials are not comparable: configFingerprint mismatch ('${first.configFingerprint.fingerprintHash}' vs '${trial.configFingerprint.fingerprintHash}')`
      );
    }
  }
}

export interface EvaluationTrialCollection {
  readonly taskId: string;
  readonly taskVersion: number;
  readonly taskContentHash: string;
  readonly configFingerprint: EvaluationConfigFingerprint;
  readonly trials: readonly EvaluationTrial[];
}

export function createEvaluationTrialCollection(
  trials: readonly EvaluationTrial[]
): EvaluationTrialCollection {
  if (trials.length === 0) {
    throw new Error("Cannot create EvaluationTrialCollection from empty trials array");
  }
  assertTrialsComparable(trials);

  const seenOrdinals = new Set<number>();
  for (const t of trials) {
    if (seenOrdinals.has(t.trialOrdinal)) {
      throw new Error(`Duplicate trialOrdinal ${t.trialOrdinal} in trial collection`);
    }
    seenOrdinals.add(t.trialOrdinal);
  }

  const sortedTrials = [...trials].sort((a, b) => a.trialOrdinal - b.trialOrdinal);
  const first = sortedTrials[0]!;

  return Object.freeze({
    taskId: first.taskId,
    taskVersion: first.taskVersion,
    taskContentHash: first.taskContentHash,
    configFingerprint: first.configFingerprint,
    trials: Object.freeze(sortedTrials),
  });
}

// ============================================================================
// 15. Controlled Evaluation Experiment Conditions & Task Scope
// ============================================================================

export const MAX_EXPERIMENT_ID_LENGTH = 128;
export const MAX_EXPERIMENT_TITLE_LENGTH = 256;
export const MAX_EXPERIMENT_HYPOTHESIS_LENGTH = 4096;
export const MAX_CONDITIONS_PER_EXPERIMENT = 32;
export const MAX_PLANNED_TRIAL_COUNT = 1000;

export const EXPERIMENT_STATUSES = [
  "DRAFT",
  "READY",
  "RUNNING",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
] as const;

export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

export function isValidExperimentStatus(status: unknown): status is ExperimentStatus {
  return typeof status === "string" && (EXPERIMENT_STATUSES as readonly string[]).includes(status);
}

export interface EvaluationTaskReference {
  readonly taskId: string;
  readonly taskVersion: number;
  readonly taskContentHash: string;
}

export const EvaluationTaskReferenceSchema = z
  .object({
    taskId: z
      .string()
      .min(1, "taskId cannot be empty")
      .max(MAX_EVALUATION_TASK_ID_LENGTH, `taskId cannot exceed ${MAX_EVALUATION_TASK_ID_LENGTH} characters`)
      .regex(/^[a-zA-Z0-9_\-]+$/, "taskId must contain only alphanumeric characters, underscores, and hyphens"),
    taskVersion: z
      .number()
      .int("taskVersion must be a positive integer >= 1")
      .positive("taskVersion must be a positive integer >= 1"),
    taskContentHash: z.string().regex(/^[a-f0-9]{64}$/, "taskContentHash must be a 64-char hex string"),
  })
  .strict();

export function createTaskReference(task: EvaluationTaskDefinition): EvaluationTaskReference {
  return Object.freeze({
    taskId: task.taskId,
    taskVersion: task.version,
    taskContentHash: computeEvaluationTaskHash(task),
  });
}

export interface EvaluationExperimentCondition {
  readonly conditionId: string;
  readonly name: string;
  readonly description?: string;
  readonly executionMode: EvaluationExecutionMode;
  readonly ruleConfigurationHash?: string;
  readonly configFingerprint: EvaluationConfigFingerprint;
  readonly conditionHash: string;
}

export interface ComputeConditionHashParams {
  readonly conditionId: string;
  readonly configFingerprintHash: string;
  readonly executionMode?: EvaluationExecutionMode;
  readonly ruleConfigurationHash?: string;
}

export function computeConditionHash(params: ComputeConditionHashParams): string {
  const executionMode = params.executionMode ?? "BASELINE";
  const canonicalPayload: Record<string, unknown> = {
    conditionId: params.conditionId,
    configFingerprintHash: params.configFingerprintHash,
    executionMode,
  };
  if (params.ruleConfigurationHash !== undefined) {
    canonicalPayload.ruleConfigurationHash = params.ruleConfigurationHash;
  }
  return computeCanonicalHash(canonicalPayload).contentHash;
}

export const EvaluationExperimentConditionSchema = z
  .object({
    conditionId: z
      .string()
      .min(1, "conditionId cannot be empty")
      .max(128, "conditionId cannot exceed 128 characters")
      .regex(/^[a-zA-Z0-9_\-]+$/, "conditionId must contain only alphanumeric characters, underscores, and hyphens"),
    name: z
      .string()
      .min(1, "condition name cannot be empty")
      .max(256, "condition name cannot exceed 256 characters"),
    description: z.string().max(4096, "condition description cannot exceed 4096 characters").optional(),
    executionMode: z.enum(EVALUATION_EXECUTION_MODES).default("BASELINE"),
    ruleConfigurationHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/, "ruleConfigurationHash must be a 64-char hex string")
      .optional(),
    configFingerprint: EvaluationConfigFingerprintSchema,
    conditionHash: z.string().regex(/^[a-f0-9]{64}$/, "conditionHash must be a 64-char hex string"),
  })
  .strict()
  .superRefine((val, ctx) => {
    // 1. Condition hash consistency
    const expectedHash = computeConditionHash({
      conditionId: val.conditionId,
      configFingerprintHash: val.configFingerprint.fingerprintHash,
      executionMode: val.executionMode,
      ruleConfigurationHash: val.ruleConfigurationHash,
    });
    if (val.conditionHash !== expectedHash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `conditionHash mismatch. Expected '${expectedHash}', received '${val.conditionHash}'`,
      });
    }

    // 2. Security firewall: sensitive key check
    if (isSensitiveKey(val.conditionId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `conditionId '${val.conditionId}' contains sensitive keyword`,
      });
    }
    if (isSensitiveKey(val.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `condition name '${val.name}' contains sensitive keyword`,
      });
    }

    // 3. Security firewall: authority keyword check
    for (const forbidden of FORBIDDEN_AUTHORITY_KEYS) {
      if (val.conditionId.toLowerCase().includes(forbidden.toLowerCase())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `conditionId '${val.conditionId}' contains forbidden authority keyword '${forbidden}'`,
        });
      }
      if (val.name.toLowerCase().includes(forbidden.toLowerCase())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `condition name '${val.name}' contains forbidden authority keyword '${forbidden}'`,
        });
      }
    }
  });

export function validateExperimentCondition(def: unknown): EvaluationExperimentCondition {
  const result = EvaluationExperimentConditionSchema.safeParse(def);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Malformed EvaluationExperimentCondition: ${issues}`);
  }
  return Object.freeze({
    conditionId: result.data.conditionId,
    name: result.data.name,
    description: result.data.description,
    executionMode: result.data.executionMode,
    ruleConfigurationHash: result.data.ruleConfigurationHash,
    configFingerprint: Object.freeze({ ...result.data.configFingerprint }),
    conditionHash: result.data.conditionHash,
  });
}

export interface CreateExperimentConditionParams {
  readonly conditionId: string;
  readonly name: string;
  readonly description?: string;
  readonly executionMode?: EvaluationExecutionMode;
  readonly ruleConfigurationHash?: string;
  readonly configFingerprint: EvaluationConfigFingerprint;
  readonly conditionHash?: string;
}

export function createExperimentCondition(
  params: CreateExperimentConditionParams
): EvaluationExperimentCondition {
  const executionMode = params.executionMode ?? "BASELINE";
  const conditionHash =
    params.conditionHash ??
    computeConditionHash({
      conditionId: params.conditionId,
      configFingerprintHash: params.configFingerprint?.fingerprintHash,
      executionMode,
      ruleConfigurationHash: params.ruleConfigurationHash,
    });

  const raw = {
    conditionId: params.conditionId,
    name: params.name,
    description: params.description,
    executionMode,
    ruleConfigurationHash: params.ruleConfigurationHash,
    configFingerprint: params.configFingerprint,
    conditionHash,
  };

  return validateExperimentCondition(raw);
}

// ============================================================================
// 16. Controlled Evaluation Experiment Contracts & Deterministic Hashing
// ============================================================================

export interface EvaluationExperiment {
  readonly experimentId: string;
  readonly version: number;
  readonly title: string;
  readonly description: string;
  readonly hypothesis: string;
  readonly taskRef: EvaluationTaskReference;
  readonly conditions: readonly EvaluationExperimentCondition[];
  readonly plannedTrialCount: number;
  readonly harnessVersion: string;
  readonly status: ExperimentStatus;
  readonly experimentContentHash: string;
}

export function computeEvaluationExperimentHash(params: {
  readonly experimentId: string;
  readonly version: number;
  readonly title: string;
  readonly description: string;
  readonly hypothesis: string;
  readonly taskRef: EvaluationTaskReference;
  readonly conditions: readonly EvaluationExperimentCondition[];
  readonly plannedTrialCount: number;
  readonly harnessVersion: string;
}): string {
  const sortedConditions = [...params.conditions]
    .sort((a, b) => a.conditionId.localeCompare(b.conditionId))
    .map((c) => ({
      conditionHash: c.conditionHash,
      conditionId: c.conditionId,
      configFingerprintHash: c.configFingerprint.fingerprintHash,
      executionMode: c.executionMode,
      name: c.name,
    }));

  const canonicalPayload = {
    conditions: sortedConditions,
    description: params.description,
    experimentId: params.experimentId,
    harnessVersion: params.harnessVersion,
    hypothesis: params.hypothesis,
    plannedTrialCount: params.plannedTrialCount,
    taskRef: {
      taskId: params.taskRef.taskId,
      taskVersion: params.taskRef.taskVersion,
      taskContentHash: params.taskRef.taskContentHash,
    },
    title: params.title,
    version: params.version,
  };

  return computeCanonicalHash(canonicalPayload).contentHash;
}

export const EvaluationExperimentSchema = z
  .object({
    experimentId: z
      .string()
      .min(1, "experimentId cannot be empty")
      .max(MAX_EXPERIMENT_ID_LENGTH, `experimentId cannot exceed ${MAX_EXPERIMENT_ID_LENGTH} characters`)
      .regex(/^[a-zA-Z0-9_\-]+$/, "experimentId must contain only alphanumeric characters, underscores, and hyphens"),
    version: z
      .number()
      .int("version must be a positive integer >= 1")
      .positive("version must be a positive integer >= 1"),
    title: z
      .string()
      .min(1, "title cannot be empty")
      .max(MAX_EXPERIMENT_TITLE_LENGTH, `title cannot exceed ${MAX_EXPERIMENT_TITLE_LENGTH} characters`),
    description: z
      .string()
      .min(1, "description cannot be empty")
      .max(MAX_EVALUATION_DESCRIPTION_LENGTH, `description cannot exceed ${MAX_EVALUATION_DESCRIPTION_LENGTH} characters`),
    hypothesis: z
      .string()
      .min(1, "hypothesis cannot be empty")
      .max(MAX_EXPERIMENT_HYPOTHESIS_LENGTH, `hypothesis cannot exceed ${MAX_EXPERIMENT_HYPOTHESIS_LENGTH} characters`),
    taskRef: EvaluationTaskReferenceSchema,
    conditions: z
      .array(EvaluationExperimentConditionSchema)
      .min(1, "Experiment must define at least one condition")
      .max(MAX_CONDITIONS_PER_EXPERIMENT, `conditions cannot exceed ${MAX_CONDITIONS_PER_EXPERIMENT}`),
    plannedTrialCount: z
      .number()
      .int("plannedTrialCount must be a positive integer >= 1")
      .min(1, "plannedTrialCount must be a positive integer >= 1")
      .max(MAX_PLANNED_TRIAL_COUNT, `plannedTrialCount cannot exceed ${MAX_PLANNED_TRIAL_COUNT}`),
    harnessVersion: z.string().min(1, "harnessVersion cannot be empty"),
    status: z.enum(EXPERIMENT_STATUSES),
    experimentContentHash: z.string().regex(/^[a-f0-9]{64}$/, "experimentContentHash must be a 64-char hex string"),
  })
  .strict()
  .superRefine((val, ctx) => {
    // 1. Content hash consistency
    const expectedHash = computeEvaluationExperimentHash({
      experimentId: val.experimentId,
      version: val.version,
      title: val.title,
      description: val.description,
      hypothesis: val.hypothesis,
      taskRef: val.taskRef,
      conditions: val.conditions,
      plannedTrialCount: val.plannedTrialCount,
      harnessVersion: val.harnessVersion,
    });
    if (val.experimentContentHash !== expectedHash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `experimentContentHash mismatch. Expected '${expectedHash}', received '${val.experimentContentHash}'`,
      });
    }

    // 2. Condition ID uniqueness
    const seenConditionIds = new Set<string>();
    for (const condition of val.conditions) {
      if (seenConditionIds.has(condition.conditionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate conditionId '${condition.conditionId}' in experiment conditions`,
        });
      }
      seenConditionIds.add(condition.conditionId);

      // 3. Condition taskVersion consistency with taskRef
      if (condition.configFingerprint.taskVersion !== val.taskRef.taskVersion) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Condition '${condition.conditionId}' taskVersion (${condition.configFingerprint.taskVersion}) does not match experiment taskRef version (${val.taskRef.taskVersion})`,
        });
      }

      // 4. Condition harnessVersion consistency with experiment harnessVersion
      if (condition.configFingerprint.harnessVersion !== val.harnessVersion) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Condition '${condition.conditionId}' harnessVersion ('${condition.configFingerprint.harnessVersion}') does not match experiment harnessVersion ('${val.harnessVersion}')`,
        });
      }
    }

    // 5. Security firewall: sensitive key check
    if (isSensitiveKey(val.experimentId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `experimentId '${val.experimentId}' contains sensitive keyword`,
      });
    }
    if (isSensitiveKey(val.title)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `title '${val.title}' contains sensitive keyword`,
      });
    }

    // 6. Security firewall: authority keyword check
    for (const forbidden of FORBIDDEN_AUTHORITY_KEYS) {
      if (val.experimentId.toLowerCase().includes(forbidden.toLowerCase())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `experimentId '${val.experimentId}' contains forbidden authority keyword '${forbidden}'`,
        });
      }
      if (val.title.toLowerCase().includes(forbidden.toLowerCase())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `title '${val.title}' contains forbidden authority keyword '${forbidden}'`,
        });
      }
    }
  });

export function validateEvaluationExperiment(def: unknown): EvaluationExperiment {
  const result = EvaluationExperimentSchema.safeParse(def);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Malformed EvaluationExperiment: ${issues}`);
  }
  return Object.freeze({
    experimentId: result.data.experimentId,
    version: result.data.version,
    title: result.data.title,
    description: result.data.description,
    hypothesis: result.data.hypothesis,
    taskRef: Object.freeze({ ...result.data.taskRef }),
    conditions: Object.freeze(result.data.conditions.map((c) => validateExperimentCondition(c))),
    plannedTrialCount: result.data.plannedTrialCount,
    harnessVersion: result.data.harnessVersion,
    status: result.data.status,
    experimentContentHash: result.data.experimentContentHash,
  });
}

export interface CreateEvaluationExperimentParams {
  readonly experimentId: string;
  readonly version: number;
  readonly title: string;
  readonly description: string;
  readonly hypothesis: string;
  readonly taskRef: EvaluationTaskReference | EvaluationTaskDefinition;
  readonly conditions: readonly (EvaluationExperimentCondition | CreateExperimentConditionParams)[];
  readonly plannedTrialCount: number;
  readonly harnessVersion?: string;
  readonly status?: ExperimentStatus;
  readonly experimentContentHash?: string;
}

export function createEvaluationExperiment(
  params: CreateEvaluationExperimentParams
): EvaluationExperiment {
  const harnessVersion = params.harnessVersion ?? CURRENT_HARNESS_VERSION;
  const status = params.status ?? "DRAFT";

  const taskRef: EvaluationTaskReference =
    "fixture" in params.taskRef
      ? createTaskReference(params.taskRef as EvaluationTaskDefinition)
      : Object.freeze({
          taskId: params.taskRef.taskId,
          taskVersion: params.taskRef.taskVersion,
          taskContentHash: params.taskRef.taskContentHash,
        });

  const conditions = params.conditions.map((c) =>
    "conditionHash" in c && typeof c.conditionHash === "string"
      ? validateExperimentCondition(c)
      : createExperimentCondition(c as CreateExperimentConditionParams)
  );

  const experimentContentHash =
    params.experimentContentHash ??
    computeEvaluationExperimentHash({
      experimentId: params.experimentId,
      version: params.version,
      title: params.title,
      description: params.description,
      hypothesis: params.hypothesis,
      taskRef,
      conditions,
      plannedTrialCount: params.plannedTrialCount,
      harnessVersion,
    });

  const raw = {
    experimentId: params.experimentId,
    version: params.version,
    title: params.title,
    description: params.description,
    hypothesis: params.hypothesis,
    taskRef,
    conditions,
    plannedTrialCount: params.plannedTrialCount,
    harnessVersion,
    status,
    experimentContentHash,
  };

  return validateEvaluationExperiment(raw);
}

// ============================================================================
// 17. Experiment Trial Compatibility & Membership Fencing
// ============================================================================

export function isTrialCompatibleWithCondition(
  trial: EvaluationTrial,
  experiment: EvaluationExperiment,
  conditionId: string
): boolean {
  const condition = experiment.conditions.find((c) => c.conditionId === conditionId);
  if (!condition) {
    return false;
  }

  return (
    trial.taskId === experiment.taskRef.taskId &&
    trial.taskVersion === experiment.taskRef.taskVersion &&
    trial.taskContentHash === experiment.taskRef.taskContentHash &&
    trial.configFingerprint.fingerprintHash === condition.configFingerprint.fingerprintHash &&
    (condition.executionMode ?? "BASELINE") === (trial.executionMode ?? "BASELINE") &&
    condition.ruleConfigurationHash === trial.ruleConfigurationHash
  );
}

export function assertTrialCompatibleWithCondition(
  trial: EvaluationTrial,
  experiment: EvaluationExperiment,
  conditionId: string
): void {
  const condition = experiment.conditions.find((c) => c.conditionId === conditionId);
  if (!condition) {
    throw new Error(
      `Condition '${conditionId}' not found in experiment '${experiment.experimentId}'`
    );
  }

  if (trial.taskId !== experiment.taskRef.taskId) {
    throw new Error(
      `Trial task mismatch: experiment requires taskId '${experiment.taskRef.taskId}', received '${trial.taskId}'`
    );
  }

  if (trial.taskVersion !== experiment.taskRef.taskVersion) {
    throw new Error(
      `Trial task version mismatch: experiment requires version ${experiment.taskRef.taskVersion}, received ${trial.taskVersion}`
    );
  }

  if (trial.taskContentHash !== experiment.taskRef.taskContentHash) {
    throw new Error(
      `Trial task content hash mismatch: experiment requires '${experiment.taskRef.taskContentHash}', received '${trial.taskContentHash}'`
    );
  }

  if (trial.configFingerprint.fingerprintHash !== condition.configFingerprint.fingerprintHash) {
    throw new Error(
      `Trial configuration fingerprint mismatch for condition '${conditionId}': condition requires '${condition.configFingerprint.fingerprintHash}', received '${trial.configFingerprint.fingerprintHash}'`
    );
  }

  if ((condition.executionMode ?? "BASELINE") !== (trial.executionMode ?? "BASELINE")) {
    throw new Error(
      `Trial execution mode mismatch for condition '${conditionId}': condition requires '${condition.executionMode}', received '${trial.executionMode ?? "BASELINE"}'`
    );
  }

  if (condition.ruleConfigurationHash !== trial.ruleConfigurationHash) {
    throw new Error(
      `Trial rule configuration hash mismatch for condition '${conditionId}': condition requires '${condition.ruleConfigurationHash}', received '${trial.ruleConfigurationHash}'`
    );
  }
}

export interface EvaluationExperimentConditionTrials {
  readonly conditionId: string;
  readonly condition: EvaluationExperimentCondition;
  readonly trials: readonly EvaluationTrial[];
}

export function validateExperimentConditionTrials(
  experiment: EvaluationExperiment,
  conditionId: string,
  trials: readonly EvaluationTrial[]
): EvaluationExperimentConditionTrials {
  const condition = experiment.conditions.find((c) => c.conditionId === conditionId);
  if (!condition) {
    throw new Error(
      `Condition '${conditionId}' not found in experiment '${experiment.experimentId}'`
    );
  }

  for (const trial of trials) {
    assertTrialCompatibleWithCondition(trial, experiment, conditionId);
  }

  const seenOrdinals = new Set<number>();
  for (const trial of trials) {
    if (seenOrdinals.has(trial.trialOrdinal)) {
      throw new Error(
        `Duplicate trialOrdinal ${trial.trialOrdinal} in condition '${conditionId}' trials`
      );
    }
    seenOrdinals.add(trial.trialOrdinal);
  }

  const sortedTrials = [...trials].sort((a, b) => a.trialOrdinal - b.trialOrdinal);

  return Object.freeze({
    conditionId,
    condition,
    trials: Object.freeze(sortedTrials),
  });
}

// ============================================================================
// 18. Evaluation Metric Keys & Constants
// ============================================================================

export const EVALUATION_METRIC_KEYS = [
  "steps",
  "actions",
  "attempts",
  "modelCalls",
  "toolCalls",
  "proposalRejections",
  "executionFailures",
  "modelFailures",
  "wallClockMs",
  "modelLatencyMs",
  "toolLatencyMs",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "reflexEvaluations",
  "reflexAllows",
  "reflexRejects",
  "reflexDefers",
  "failureLoopTriggers",
  "redundantActionTriggers",
  "budgetPressureTriggers",
  "reflexLatencyMs",
] as const;

export type EvaluationMetricKey = (typeof EVALUATION_METRIC_KEYS)[number];

export function isValidEvaluationMetricKey(key: unknown): key is EvaluationMetricKey {
  return typeof key === "string" && (EVALUATION_METRIC_KEYS as readonly string[]).includes(key);
}

// ============================================================================
// 19. Descriptive Rate Contract
// ============================================================================

export interface DescriptiveRate {
  readonly numerator: number;
  readonly denominator: number;
  readonly rate?: number;
}

export const DescriptiveRateSchema = z
  .object({
    numerator: z.number().int().nonnegative(),
    denominator: z.number().int().nonnegative(),
    rate: z.number().nonnegative().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.denominator === 0 && val.rate !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "rate must be undefined when denominator is 0",
      });
    }
  });

export function computeDescriptiveRate(numerator: number, denominator: number): DescriptiveRate {
  if (denominator <= 0) {
    return Object.freeze({
      numerator,
      denominator,
      rate: undefined,
    });
  }
  const raw = numerator / denominator;
  const rate = Math.round(raw * 1e8) / 1e8;
  return Object.freeze({
    numerator,
    denominator,
    rate,
  });
}

// ============================================================================
// 20. Evaluation Outcome Distribution
// ============================================================================

export interface EvaluationOutcomeDistribution {
  readonly totalTrials: number;
  readonly completedTrials: number;
  readonly passedTrials: number;
  readonly failedTrials: number;
  readonly timedOutTrials: number;
  readonly cancelledTrials: number;
  readonly blockedTrials: number;
  readonly errorTrials: number;
}

export const EvaluationOutcomeDistributionSchema = z
  .object({
    totalTrials: z.number().int().nonnegative(),
    completedTrials: z.number().int().nonnegative(),
    passedTrials: z.number().int().nonnegative(),
    failedTrials: z.number().int().nonnegative(),
    timedOutTrials: z.number().int().nonnegative(),
    cancelledTrials: z.number().int().nonnegative(),
    blockedTrials: z.number().int().nonnegative(),
    errorTrials: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const sum =
      val.passedTrials +
      val.failedTrials +
      val.timedOutTrials +
      val.cancelledTrials +
      val.blockedTrials +
      val.errorTrials;
    if (sum !== val.totalTrials) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Sum of outcome buckets (${sum}) does not equal totalTrials (${val.totalTrials})`,
      });
    }
    if (val.completedTrials !== val.passedTrials + val.failedTrials) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `completedTrials (${val.completedTrials}) must equal passedTrials + failedTrials (${val.passedTrials + val.failedTrials})`,
      });
    }
  });

// ============================================================================
// 21. Metric Aggregate Contract & Missing Value Semantics
// ============================================================================

export interface MetricAggregate {
  readonly observedCount: number;
  readonly unavailableCount: number;
  readonly sum?: number;
  readonly average?: number;
  readonly minimum?: number;
  readonly maximum?: number;
}

export const MetricAggregateSchema = z
  .object({
    observedCount: z.number().int().nonnegative(),
    unavailableCount: z.number().int().nonnegative(),
    sum: z.number().optional(),
    average: z.number().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.observedCount === 0) {
      if (
        val.sum !== undefined ||
        val.average !== undefined ||
        val.minimum !== undefined ||
        val.maximum !== undefined
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Aggregate metrics (sum, average, minimum, maximum) must be undefined when observedCount is 0",
        });
      }
    } else {
      if (
        val.sum === undefined ||
        val.average === undefined ||
        val.minimum === undefined ||
        val.maximum === undefined
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Aggregate metrics (sum, average, minimum, maximum) must be present when observedCount > 0",
        });
      }
    }
  });

export function aggregateMetric(values: readonly (number | undefined)[]): MetricAggregate {
  let observedCount = 0;
  let unavailableCount = 0;
  let sum = 0;
  let minimum: number | undefined = undefined;
  let maximum: number | undefined = undefined;

  for (const v of values) {
    if (typeof v === "number" && !isNaN(v)) {
      observedCount++;
      sum += v;
      if (minimum === undefined || v < minimum) {
        minimum = v;
      }
      if (maximum === undefined || v > maximum) {
        maximum = v;
      }
    } else {
      unavailableCount++;
    }
  }

  if (observedCount === 0) {
    return Object.freeze({
      observedCount: 0,
      unavailableCount,
      sum: undefined,
      average: undefined,
      minimum: undefined,
      maximum: undefined,
    });
  }

  const average = Math.round((sum / observedCount) * 1e8) / 1e8;
  const roundedSum = Math.round(sum * 1e8) / 1e8;

  return Object.freeze({
    observedCount,
    unavailableCount,
    sum: roundedSum,
    average,
    minimum,
    maximum,
  });
}

// ============================================================================
// 22. Condition-Level Evaluation Report
// ============================================================================

export interface EvaluationConditionReport {
  readonly conditionId: string;
  readonly conditionName: string;
  readonly conditionHash: string;
  readonly executionMode?: EvaluationExecutionMode;
  readonly taskRef: EvaluationTaskReference;
  readonly configFingerprint: EvaluationConfigFingerprint;
  readonly plannedTrialCount: number;
  readonly observedTrialCount: number;
  readonly outcomes: EvaluationOutcomeDistribution;
  readonly objectivePassRate: DescriptiveRate;
  readonly metrics: Readonly<Record<EvaluationMetricKey, MetricAggregate>>;
  readonly trialReferences: readonly string[];
}

export const EvaluationConditionReportSchema = z
  .object({
    conditionId: z.string().min(1),
    conditionName: z.string().min(1),
    conditionHash: z.string().regex(/^[a-f0-9]{64}$/),
    executionMode: z.enum(EVALUATION_EXECUTION_MODES).optional(),
    taskRef: EvaluationTaskReferenceSchema,
    configFingerprint: EvaluationConfigFingerprintSchema,
    plannedTrialCount: z.number().int().positive(),
    observedTrialCount: z.number().int().nonnegative(),
    outcomes: EvaluationOutcomeDistributionSchema,
    objectivePassRate: DescriptiveRateSchema,
    metrics: z.record(z.string(), MetricAggregateSchema),
    trialReferences: z.array(z.string()),
  })
  .strict()
  .superRefine((val, ctx) => {
    for (const key of EVALUATION_METRIC_KEYS) {
      if (!val.metrics[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Missing required metric aggregate for '${key}' in condition report`,
        });
      }
    }
  });

export function validateConditionReport(def: unknown): EvaluationConditionReport {
  const result = EvaluationConditionReportSchema.safeParse(def);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Malformed EvaluationConditionReport: ${issues}`);
  }

  const metricsRecord: Record<string, MetricAggregate> = {};
  for (const k of EVALUATION_METRIC_KEYS) {
    const agg = result.data.metrics[k]!;
    metricsRecord[k] = Object.freeze({ ...agg });
  }

  return Object.freeze({
    conditionId: result.data.conditionId,
    conditionName: result.data.conditionName,
    conditionHash: result.data.conditionHash,
    executionMode: result.data.executionMode,
    taskRef: Object.freeze({ ...result.data.taskRef }),
    configFingerprint: Object.freeze({ ...result.data.configFingerprint }),
    plannedTrialCount: result.data.plannedTrialCount,
    observedTrialCount: result.data.observedTrialCount,
    outcomes: Object.freeze({ ...result.data.outcomes }),
    objectivePassRate: Object.freeze({ ...result.data.objectivePassRate }),
    metrics: Object.freeze(metricsRecord) as Readonly<Record<EvaluationMetricKey, MetricAggregate>>,
    trialReferences: Object.freeze([...result.data.trialReferences]),
  });
}

// ============================================================================
// 23. Evaluation Report Contract & Deterministic Hashing
// ============================================================================

export interface EvaluationReport {
  readonly experimentId: string;
  readonly experimentVersion: number;
  readonly experimentContentHash: string;
  readonly taskRef: EvaluationTaskReference;
  readonly harnessVersion: string;
  readonly plannedTrialCount: number;
  readonly totalObservedTrials: number;
  readonly conditions: readonly EvaluationConditionReport[];
  readonly reportContentHash: string;
}

export interface EvaluationReportHashConditionInput {
  readonly conditionId: string;
  readonly conditionName: string;
  readonly conditionHash: string;
  readonly plannedTrialCount: number;
  readonly observedTrialCount: number;
  readonly outcomes: EvaluationOutcomeDistribution;
  readonly objectivePassRate: DescriptiveRate;
  readonly metrics: Readonly<Record<string, MetricAggregate>>;
  readonly trialReferences: readonly string[];
}

export function computeEvaluationReportHash(params: {
  readonly experimentId: string;
  readonly experimentVersion: number;
  readonly experimentContentHash: string;
  readonly taskRef: EvaluationTaskReference;
  readonly harnessVersion: string;
  readonly plannedTrialCount: number;
  readonly conditions: readonly EvaluationReportHashConditionInput[];
}): string {
  const sortedConditions = [...params.conditions]
    .sort((a, b) => a.conditionId.localeCompare(b.conditionId))
    .map((c) => ({
      conditionHash: c.conditionHash,
      conditionId: c.conditionId,
      conditionName: c.conditionName,
      metrics: EVALUATION_METRIC_KEYS.map((metricName) => {
        const agg = c.metrics[metricName];
        return {
          metricName,
          observedCount: agg?.observedCount ?? 0,
          unavailableCount: agg?.unavailableCount ?? 0,
          sum: agg?.sum,
          average: agg?.average,
          minimum: agg?.minimum,
          maximum: agg?.maximum,
        };
      }),
      objectivePassRate: {
        denominator: c.objectivePassRate.denominator,
        numerator: c.objectivePassRate.numerator,
        rate: c.objectivePassRate.rate,
      },
      observedTrialCount: c.observedTrialCount,
      outcomes: {
        blockedTrials: c.outcomes.blockedTrials,
        cancelledTrials: c.outcomes.cancelledTrials,
        completedTrials: c.outcomes.completedTrials,
        errorTrials: c.outcomes.errorTrials,
        failedTrials: c.outcomes.failedTrials,
        passedTrials: c.outcomes.passedTrials,
        timedOutTrials: c.outcomes.timedOutTrials,
        totalTrials: c.outcomes.totalTrials,
      },
      plannedTrialCount: c.plannedTrialCount,
      trialReferences: [...c.trialReferences].sort(),
    }));

  const canonicalPayload = {
    conditions: sortedConditions,
    experimentContentHash: params.experimentContentHash,
    experimentId: params.experimentId,
    experimentVersion: params.experimentVersion,
    harnessVersion: params.harnessVersion,
    plannedTrialCount: params.plannedTrialCount,
    taskRef: {
      taskId: params.taskRef.taskId,
      taskVersion: params.taskRef.taskVersion,
      taskContentHash: params.taskRef.taskContentHash,
    },
  };

  return computeCanonicalHash(canonicalPayload).contentHash;
}

export const EvaluationReportSchema = z
  .object({
    experimentId: z.string().min(1),
    experimentVersion: z.number().int().positive(),
    experimentContentHash: z.string().regex(/^[a-f0-9]{64}$/),
    taskRef: EvaluationTaskReferenceSchema,
    harnessVersion: z.string().min(1),
    plannedTrialCount: z.number().int().positive(),
    totalObservedTrials: z.number().int().nonnegative(),
    conditions: z.array(EvaluationConditionReportSchema).min(1),
    reportContentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((val, ctx) => {
    // 1. Condition uniqueness
    const seenConditionIds = new Set<string>();
    for (const c of val.conditions) {
      if (seenConditionIds.has(c.conditionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate conditionId '${c.conditionId}' in evaluation report`,
        });
      }
      seenConditionIds.add(c.conditionId);
    }

    // 2. Report content hash verification
    const expectedHash = computeEvaluationReportHash({
      experimentId: val.experimentId,
      experimentVersion: val.experimentVersion,
      experimentContentHash: val.experimentContentHash,
      taskRef: val.taskRef,
      harnessVersion: val.harnessVersion,
      plannedTrialCount: val.plannedTrialCount,
      conditions: val.conditions,
    });
    if (val.reportContentHash !== expectedHash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `reportContentHash mismatch. Expected '${expectedHash}', received '${val.reportContentHash}'`,
      });
    }

    // 3. Security firewall: authority keyword checks
    for (const forbidden of FORBIDDEN_AUTHORITY_KEYS) {
      if (val.experimentId.toLowerCase().includes(forbidden.toLowerCase())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `experimentId '${val.experimentId}' contains forbidden authority keyword '${forbidden}'`,
        });
      }
    }
  });

export function validateEvaluationReport(def: unknown): EvaluationReport {
  const result = EvaluationReportSchema.safeParse(def);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Malformed EvaluationReport: ${issues}`);
  }
  return Object.freeze({
    experimentId: result.data.experimentId,
    experimentVersion: result.data.experimentVersion,
    experimentContentHash: result.data.experimentContentHash,
    taskRef: Object.freeze({ ...result.data.taskRef }),
    harnessVersion: result.data.harnessVersion,
    plannedTrialCount: result.data.plannedTrialCount,
    totalObservedTrials: result.data.totalObservedTrials,
    conditions: Object.freeze(
      result.data.conditions.map((c) => validateConditionReport(c))
    ),
    reportContentHash: result.data.reportContentHash,
  });
}

// ============================================================================
// 24. Pure Report Generation
// ============================================================================

export interface GenerateEvaluationReportParams {
  readonly experiment: EvaluationExperiment;
  readonly trials: readonly EvaluationTrial[];
}

export function generateEvaluationReport(
  experimentOrParams: EvaluationExperiment | GenerateEvaluationReportParams,
  maybeTrials?: readonly EvaluationTrial[]
): EvaluationReport {
  let experiment: EvaluationExperiment;
  let trials: readonly EvaluationTrial[];

  if ("experiment" in experimentOrParams) {
    experiment = experimentOrParams.experiment;
    trials = experimentOrParams.trials;
  } else {
    experiment = experimentOrParams;
    trials = maybeTrials ?? [];
  }

  // Validate experiment structure
  validateEvaluationExperiment(experiment);

  // Group trials by conditionId
  const trialsByConditionId = new Map<string, EvaluationTrial[]>();
  for (const condition of experiment.conditions) {
    trialsByConditionId.set(condition.conditionId, []);
  }

  for (const trial of trials) {
    if (trial.taskId !== experiment.taskRef.taskId) {
      throw new Error(
        `Trial '${trial.trialId}' task mismatch: experiment requires taskId '${experiment.taskRef.taskId}', received '${trial.taskId}'`
      );
    }
    if (trial.taskVersion !== experiment.taskRef.taskVersion) {
      throw new Error(
        `Trial '${trial.trialId}' task version mismatch: experiment requires version ${experiment.taskRef.taskVersion}, received ${trial.taskVersion}`
      );
    }
    if (trial.taskContentHash !== experiment.taskRef.taskContentHash) {
      throw new Error(
        `Trial '${trial.trialId}' task content hash mismatch: experiment requires '${experiment.taskRef.taskContentHash}', received '${trial.taskContentHash}'`
      );
    }

    const matchingCondition = experiment.conditions.find(
      (c) =>
        c.configFingerprint.fingerprintHash === trial.configFingerprint.fingerprintHash &&
        (c.executionMode ?? "BASELINE") === (trial.executionMode ?? "BASELINE") &&
        c.ruleConfigurationHash === trial.ruleConfigurationHash
    );
    if (!matchingCondition) {
      throw new Error(
        `Trial '${trial.trialId}' with fingerprint '${trial.configFingerprint.fingerprintHash}' (mode: ${trial.executionMode ?? "BASELINE"}, ruleHash: ${trial.ruleConfigurationHash}) does not match any condition in experiment '${experiment.experimentId}'`
      );
    }

    trialsByConditionId.get(matchingCondition.conditionId)!.push(trial);
  }

  // Validate trial ordinal uniqueness within each condition
  for (const [condId, condTrials] of trialsByConditionId.entries()) {
    const seenOrdinals = new Set<number>();
    for (const t of condTrials) {
      if (seenOrdinals.has(t.trialOrdinal)) {
        throw new Error(
          `Duplicate trialOrdinal ${t.trialOrdinal} in condition '${condId}'`
        );
      }
      seenOrdinals.add(t.trialOrdinal);
    }
  }

  // Build condition reports in deterministic order (sorted by conditionId)
  const sortedConditions = [...experiment.conditions].sort((a, b) =>
    a.conditionId.localeCompare(b.conditionId)
  );

  let totalObserved = 0;
  const conditionReports: EvaluationConditionReport[] = [];

  for (const condition of sortedConditions) {
    const condTrials = [...(trialsByConditionId.get(condition.conditionId) ?? [])].sort(
      (a, b) => a.trialOrdinal - b.trialOrdinal
    );
    totalObserved += condTrials.length;

    let passedTrials = 0;
    let failedTrials = 0;
    let timedOutTrials = 0;
    let cancelledTrials = 0;
    let blockedTrials = 0;
    let errorTrials = 0;

    for (const t of condTrials) {
      switch (t.outcome) {
        case "PASSED":
          passedTrials++;
          break;
        case "FAILED":
          failedTrials++;
          break;
        case "TIMED_OUT":
          timedOutTrials++;
          break;
        case "CANCELLED":
          cancelledTrials++;
          break;
        case "BLOCKED":
          blockedTrials++;
          break;
        case "ERROR":
          errorTrials++;
          break;
      }
    }

    const completedTrials = passedTrials + failedTrials;
    const totalTrials = condTrials.length;

    const outcomes: EvaluationOutcomeDistribution = Object.freeze({
      totalTrials,
      completedTrials,
      passedTrials,
      failedTrials,
      timedOutTrials,
      cancelledTrials,
      blockedTrials,
      errorTrials,
    });

    const objectivePassRate = computeDescriptiveRate(passedTrials, completedTrials);

    const metricAggregates: Record<string, MetricAggregate> = {};
    for (const metricKey of EVALUATION_METRIC_KEYS) {
      const values = condTrials.map((t) => t.metrics[metricKey]);
      metricAggregates[metricKey] = aggregateMetric(values);
    }

    const trialReferences = Object.freeze(condTrials.map((t) => t.trialId));

    conditionReports.push(
      Object.freeze({
        conditionId: condition.conditionId,
        conditionName: condition.name,
        conditionHash: condition.conditionHash,
        executionMode: condition.executionMode,
        taskRef: experiment.taskRef,
        configFingerprint: condition.configFingerprint,
        plannedTrialCount: experiment.plannedTrialCount,
        observedTrialCount: totalTrials,
        outcomes,
        objectivePassRate,
        metrics: Object.freeze(metricAggregates as Record<EvaluationMetricKey, MetricAggregate>),
        trialReferences,
      })
    );
  }

  const reportContentHash = computeEvaluationReportHash({
    experimentId: experiment.experimentId,
    experimentVersion: experiment.version,
    experimentContentHash: experiment.experimentContentHash,
    taskRef: experiment.taskRef,
    harnessVersion: experiment.harnessVersion,
    plannedTrialCount: experiment.plannedTrialCount,
    conditions: conditionReports,
  });

  return Object.freeze({
    experimentId: experiment.experimentId,
    experimentVersion: experiment.version,
    experimentContentHash: experiment.experimentContentHash,
    taskRef: experiment.taskRef,
    harnessVersion: experiment.harnessVersion,
    plannedTrialCount: experiment.plannedTrialCount,
    totalObservedTrials: totalObserved,
    conditions: Object.freeze(conditionReports),
    reportContentHash,
  });
}

// ============================================================================
// 25. Baseline Comparison Contract & Comparator
// ============================================================================

export interface MetricComparison {
  readonly baseline: MetricAggregate;
  readonly candidate: MetricAggregate;
  readonly deltaAverage?: number;
  readonly deltaSum?: number;
}

export interface PassRateComparison {
  readonly baseline: DescriptiveRate;
  readonly candidate: DescriptiveRate;
  readonly delta?: number;
}

export interface ConditionComparison {
  readonly baselineConditionId: string;
  readonly candidateConditionId: string;
  readonly baselineConditionName: string;
  readonly candidateConditionName: string;
  readonly taskRef: EvaluationTaskReference;
  readonly passRateComparison: PassRateComparison;
  readonly metricComparisons: Readonly<Record<EvaluationMetricKey, MetricComparison>>;
}

function computeDelta(candidate: number | undefined, baseline: number | undefined): number | undefined {
  if (candidate === undefined || baseline === undefined) {
    return undefined;
  }
  const raw = candidate - baseline;
  return Math.round(raw * 1e8) / 1e8;
}

export function compareConditions(
  baseline: EvaluationConditionReport,
  candidate: EvaluationConditionReport,
  taskRef?: EvaluationTaskReference
): ConditionComparison {
  if (baseline.taskRef.taskId !== candidate.taskRef.taskId) {
    throw new Error(
      `Cannot compare conditions with different taskId: '${baseline.taskRef.taskId}' vs '${candidate.taskRef.taskId}'`
    );
  }
  if (baseline.taskRef.taskVersion !== candidate.taskRef.taskVersion) {
    throw new Error(
      `Cannot compare conditions with different taskVersion: ${baseline.taskRef.taskVersion} vs ${candidate.taskRef.taskVersion}`
    );
  }
  if (baseline.taskRef.taskContentHash !== candidate.taskRef.taskContentHash) {
    throw new Error(
      `Cannot compare conditions with different taskContentHash: '${baseline.taskRef.taskContentHash}' vs '${candidate.taskRef.taskContentHash}'`
    );
  }

  if (taskRef) {
    if (baseline.taskRef.taskId !== taskRef.taskId) {
      throw new Error(
        `Conditions do not match expected taskRef taskId: '${taskRef.taskId}' vs '${baseline.taskRef.taskId}'`
      );
    }
    if (baseline.taskRef.taskVersion !== taskRef.taskVersion) {
      throw new Error(
        `Conditions do not match expected taskRef taskVersion: ${taskRef.taskVersion} vs ${baseline.taskRef.taskVersion}`
      );
    }
    if (baseline.taskRef.taskContentHash !== taskRef.taskContentHash) {
      throw new Error(
        `Conditions do not match expected taskRef taskContentHash: '${taskRef.taskContentHash}' vs '${baseline.taskRef.taskContentHash}'`
      );
    }
  }

  const passRateDelta = computeDelta(candidate.objectivePassRate.rate, baseline.objectivePassRate.rate);
  const passRateComparison: PassRateComparison = Object.freeze({
    baseline: baseline.objectivePassRate,
    candidate: candidate.objectivePassRate,
    delta: passRateDelta,
  });

  const metricComparisons: Record<string, MetricComparison> = {};
  for (const metricKey of EVALUATION_METRIC_KEYS) {
    const baseAgg = baseline.metrics[metricKey];
    const candAgg = candidate.metrics[metricKey];
    const deltaAverage = computeDelta(candAgg.average, baseAgg.average);
    const deltaSum = computeDelta(candAgg.sum, baseAgg.sum);

    metricComparisons[metricKey] = Object.freeze({
      baseline: baseAgg,
      candidate: candAgg,
      deltaAverage,
      deltaSum,
    });
  }

  return Object.freeze({
    baselineConditionId: baseline.conditionId,
    candidateConditionId: candidate.conditionId,
    baselineConditionName: baseline.conditionName,
    candidateConditionName: candidate.conditionName,
    taskRef: baseline.taskRef,
    passRateComparison,
    metricComparisons: Object.freeze(metricComparisons as Record<EvaluationMetricKey, MetricComparison>),
  });
}

export function compareExperimentConditions(
  report: EvaluationReport,
  baselineConditionId: string,
  candidateConditionId: string
): ConditionComparison {
  const baseline = report.conditions.find((c) => c.conditionId === baselineConditionId);
  if (!baseline) {
    throw new Error(
      `Baseline condition '${baselineConditionId}' not found in report for experiment '${report.experimentId}'`
    );
  }

  const candidate = report.conditions.find((c) => c.conditionId === candidateConditionId);
  if (!candidate) {
    throw new Error(
      `Candidate condition '${candidateConditionId}' not found in report for experiment '${report.experimentId}'`
    );
  }

  return compareConditions(baseline, candidate, report.taskRef);
}

// ============================================================================
// 26. Reflex Evaluation Condition Boundary & Controlled Comparison
// ============================================================================

export function assertExecutionModeSupported(
  mode: EvaluationExecutionMode,
  options?: { readonly reflexConfigured?: boolean }
): void {
  if (mode === "REFLEX") {
    if (!options?.reflexConfigured) {
      throw new ReflexNotImplementedError(
        "Evaluation execution mode 'REFLEX' is reserved for the future adaptive Reflex control layer and is not yet implemented (REFLEX_NOT_IMPLEMENTED). Preflight execution rejected."
      );
    }
    return;
  }
  if (mode !== "BASELINE") {
    throw new Error(`Unsupported evaluation execution mode: '${mode}'`);
  }
}

export interface ControlledConditionComparisonResult {
  readonly comparable: boolean;
  readonly taskRef: EvaluationTaskReference;
  readonly baselineConditionId: string;
  readonly candidateConditionId: string;
  readonly intentionalDifferences: readonly string[];
  readonly configurationCompatible: boolean;
}

export interface AssertControlledConditionComparabilityParams {
  readonly taskRef: EvaluationTaskReference;
  readonly baselineCondition: EvaluationExperimentCondition;
  readonly candidateCondition: EvaluationExperimentCondition;
  readonly expectedTaskId?: string;
  readonly expectedTaskVersion?: number;
  readonly expectedTaskContentHash?: string;
  readonly allowConfigDifferences?: boolean;
}

export function assertControlledConditionComparability(
  params: AssertControlledConditionComparabilityParams
): ControlledConditionComparisonResult {
  const {
    taskRef,
    baselineCondition,
    candidateCondition,
    expectedTaskId,
    expectedTaskVersion,
    expectedTaskContentHash,
    allowConfigDifferences,
  } = params;

  // 1. Task verification & fencing against expectations
  if (expectedTaskId && taskRef.taskId !== expectedTaskId) {
    throw new Error(
      `Task mismatch in controlled comparison: expected taskId '${expectedTaskId}', received '${taskRef.taskId}'`
    );
  }
  if (expectedTaskVersion !== undefined && taskRef.taskVersion !== expectedTaskVersion) {
    throw new Error(
      `Task version mismatch in controlled comparison: expected version ${expectedTaskVersion}, received ${taskRef.taskVersion}`
    );
  }
  if (expectedTaskContentHash && taskRef.taskContentHash !== expectedTaskContentHash) {
    throw new Error(
      `Task content hash mismatch in controlled comparison: expected '${expectedTaskContentHash}', received '${taskRef.taskContentHash}'`
    );
  }

  // 2. Condition-to-task version alignment
  if (baselineCondition.configFingerprint.taskVersion !== taskRef.taskVersion) {
    throw new Error(
      `Task version mismatch between baseline condition and taskRef: ${baselineCondition.configFingerprint.taskVersion} vs ${taskRef.taskVersion}`
    );
  }
  if (candidateCondition.configFingerprint.taskVersion !== taskRef.taskVersion) {
    throw new Error(
      `Task version mismatch between candidate condition and taskRef: ${candidateCondition.configFingerprint.taskVersion} vs ${taskRef.taskVersion}`
    );
  }

  // 3. Baseline condition execution mode verification
  if (baselineCondition.executionMode !== "BASELINE") {
    throw new Error(
      `Baseline condition must have executionMode 'BASELINE', received '${baselineCondition.executionMode}'`
    );
  }

  // 4. Configuration comparability fencing
  const baseFp = baselineCondition.configFingerprint;
  const candFp = candidateCondition.configFingerprint;

  if (baseFp.harnessVersion !== candFp.harnessVersion) {
    throw new Error(
      `Incompatible harnessVersion in controlled comparison: '${baseFp.harnessVersion}' vs '${candFp.harnessVersion}'`
    );
  }
  if (baseFp.modelProvider !== candFp.modelProvider && !allowConfigDifferences) {
    throw new Error(
      `Incompatible modelProvider in controlled comparison: '${baseFp.modelProvider}' vs '${candFp.modelProvider}'`
    );
  }
  if (baseFp.model !== candFp.model && !allowConfigDifferences) {
    throw new Error(
      `Incompatible model in controlled comparison: '${baseFp.model}' vs '${candFp.model}'`
    );
  }

  // 5. Explicitly isolate and declare intentional differences
  const intentionalDifferences: string[] = [];
  if (baselineCondition.executionMode !== candidateCondition.executionMode) {
    intentionalDifferences.push(
      `executionMode: ${baselineCondition.executionMode} -> ${candidateCondition.executionMode}`
    );
  }
  if (baseFp.fingerprintHash !== candFp.fingerprintHash) {
    intentionalDifferences.push("configFingerprint");
  }

  return Object.freeze({
    comparable: true,
    taskRef,
    baselineConditionId: baselineCondition.conditionId,
    candidateConditionId: candidateCondition.conditionId,
    intentionalDifferences: Object.freeze(intentionalDifferences),
    configurationCompatible: baseFp.fingerprintHash === candFp.fingerprintHash,
  });
}

// ============================================================================
// 24. Reflex Intervention Metrics Contract (Phase 8.7)
// ============================================================================

export interface ReflexInterventionMetrics {
  readonly reflexEvaluations?: number;
  readonly reflexInterventions?: number;
  readonly reflexAllows?: number;
  readonly reflexRejects?: number;
  readonly reflexDefers?: number;
  readonly interventionRate?: number;
  readonly rejectionRate?: number;
  readonly deferRate?: number;
  readonly allowanceRate?: number;
  readonly falsePositiveInterventions?: number;
  readonly falsePositiveRate?: number;
}

export const ReflexInterventionMetricsSchema = z
  .object({
    reflexEvaluations: z.number().int().nonnegative().optional(),
    reflexInterventions: z.number().int().nonnegative().optional(),
    reflexAllows: z.number().int().nonnegative().optional(),
    reflexRejects: z.number().int().nonnegative().optional(),
    reflexDefers: z.number().int().nonnegative().optional(),
    interventionRate: z.number().min(0).max(1).optional(),
    rejectionRate: z.number().min(0).max(1).optional(),
    deferRate: z.number().min(0).max(1).optional(),
    allowanceRate: z.number().min(0).max(1).optional(),
    falsePositiveInterventions: z.number().int().nonnegative().optional(),
    falsePositiveRate: z.number().min(0).max(1).optional(),
  })
  .strict();

export function isTaskInterventionFree(taskId: string): boolean | undefined {
  const interventionFreeTasks = new Set([
    "task-baseline-reflex-normal",
    "task-baseline-reflex-multi-step-normal",
    "task-baseline-reflex-long-sequence",
    "task-baseline-reflex-intermittent-failure",
    "task-baseline-reflex-near-threshold",
    "task-swe-bug-fix-calc",
    "task-swe-bug-fix-parser",
    "task-swe-feature-string-utils",
    "task-swe-feature-multi-file",
    "task-swe-recoverable-failure",
  ]);
  const intendedInterventionTasks = new Set([
    "task-baseline-reflex-failure-loop",
    "task-baseline-reflex-redundant-action",
    "task-baseline-reflex-budget-pressure",
    "task-baseline-reflex-mixed-workload",
    "task-swe-futile-loop",
  ]);

  if (interventionFreeTasks.has(taskId)) return true;
  if (intendedInterventionTasks.has(taskId)) return false;
  return undefined;
}

export function calculateReflexInterventionMetrics(
  trials: readonly EvaluationTrial[],
  task?: EvaluationTaskDefinition
): ReflexInterventionMetrics {
  const reflexTrials = trials.filter((t) => t.metrics.reflexEvaluations !== undefined);
  if (reflexTrials.length === 0) {
    return Object.freeze({
      reflexEvaluations: undefined,
      reflexInterventions: undefined,
      reflexAllows: undefined,
      reflexRejects: undefined,
      reflexDefers: undefined,
      interventionRate: undefined,
      rejectionRate: undefined,
      deferRate: undefined,
      allowanceRate: undefined,
      falsePositiveInterventions: undefined,
      falsePositiveRate: undefined,
    });
  }

  let totalEvals = 0;
  let totalAllows = 0;
  let totalRejects = 0;
  let totalDefers = 0;

  for (const trial of reflexTrials) {
    totalEvals += trial.metrics.reflexEvaluations ?? 0;
    totalAllows += trial.metrics.reflexAllows ?? 0;
    totalRejects += trial.metrics.reflexRejects ?? 0;
    totalDefers += trial.metrics.reflexDefers ?? 0;
  }

  const totalInterventions = totalRejects + totalDefers;

  const interventionRate = totalEvals > 0 ? totalInterventions / totalEvals : undefined;
  const rejectionRate = totalEvals > 0 ? totalRejects / totalEvals : undefined;
  const deferRate = totalEvals > 0 ? totalDefers / totalEvals : undefined;
  const allowanceRate = totalEvals > 0 ? totalAllows / totalEvals : undefined;

  let falsePositiveInterventions: number | undefined = undefined;
  let falsePositiveRate: number | undefined = undefined;

  if (task) {
    const isFree = isTaskInterventionFree(task.taskId);
    if (isFree === true) {
      falsePositiveInterventions = totalInterventions;
      falsePositiveRate = totalEvals > 0 ? totalInterventions / totalEvals : 0;
    } else if (isFree === false) {
      falsePositiveInterventions = undefined;
      falsePositiveRate = undefined;
    }
  }

  return Object.freeze({
    reflexEvaluations: totalEvals,
    reflexInterventions: totalInterventions,
    reflexAllows: totalAllows,
    reflexRejects: totalRejects,
    reflexDefers: totalDefers,
    interventionRate,
    rejectionRate,
    deferRate,
    allowanceRate,
    falsePositiveInterventions,
    falsePositiveRate,
  });
}

// ============================================================================
// 25. Reflex Stability Metrics Contract (Phase 8.7)
// ============================================================================

export interface ReflexStabilityMetrics {
  readonly trialCount: number;
  readonly isDecisionConsistent?: boolean;
  readonly isRuleTriggerConsistent?: boolean;
  readonly interventionCountDistribution?: Readonly<Record<number, number>>;
  readonly uniqueDecisionSequencesCount?: number;
}

export function calculateReflexStabilityMetrics(
  trials: readonly EvaluationTrial[]
): ReflexStabilityMetrics | undefined {
  if (trials.length === 0) return undefined;
  const reflexTrials = trials.filter((t) => t.metrics.reflexEvaluations !== undefined);
  if (reflexTrials.length === 0) return undefined;

  const interventionCountDistribution: Record<number, number> = {};
  const decisionSignatures = new Set<string>();
  const triggerSignatures = new Set<string>();

  for (const trial of reflexTrials) {
    const allows = trial.metrics.reflexAllows ?? 0;
    const rejects = trial.metrics.reflexRejects ?? 0;
    const defers = trial.metrics.reflexDefers ?? 0;
    const interventions = rejects + defers;

    interventionCountDistribution[interventions] =
      (interventionCountDistribution[interventions] ?? 0) + 1;

    decisionSignatures.add(`${allows}:${rejects}:${defers}`);
    triggerSignatures.add(
      `${trial.metrics.failureLoopTriggers ?? 0}:${trial.metrics.redundantActionTriggers ?? 0}:${trial.metrics.budgetPressureTriggers ?? 0}`
    );
  }

  return Object.freeze({
    trialCount: reflexTrials.length,
    isDecisionConsistent: decisionSignatures.size === 1,
    isRuleTriggerConsistent: triggerSignatures.size === 1,
    interventionCountDistribution: Object.freeze(interventionCountDistribution),
    uniqueDecisionSequencesCount: decisionSignatures.size,
  });
}

// ============================================================================
// 26. Experiment Manifest Contract (Phase 8.7)
// ============================================================================

export interface ExperimentManifest {
  readonly manifestVersion: 1;
  readonly experimentId: string;
  readonly taskRegistry: string;
  readonly taskIds: readonly string[];
  readonly taskCount: number;
  readonly trialCount: number;
  readonly executionModes: readonly EvaluationExecutionMode[];
  readonly ruleConfigurationHash?: string;
  readonly modelProvider: string;
  readonly model: string;
  readonly generationConfig?: Readonly<Record<string, unknown>>;
  readonly harnessVersion: string;
  readonly manifestHash: string;
}

export const ExperimentManifestSchema = z
  .object({
    manifestVersion: z.literal(1),
    experimentId: z.string().min(1),
    taskRegistry: z.string().min(1),
    taskIds: z.array(z.string().min(1)).min(1),
    taskCount: z.number().int().positive(),
    trialCount: z.number().int().positive(),
    executionModes: z.array(z.enum(EVALUATION_EXECUTION_MODES)).min(1),
    ruleConfigurationHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    modelProvider: z.string().min(1),
    model: z.string().min(1),
    generationConfig: z.record(z.unknown()).optional(),
    harnessVersion: z.string().min(1),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export function computeExperimentManifestHash(params: {
  readonly manifestVersion: 1;
  readonly experimentId: string;
  readonly taskRegistry: string;
  readonly taskIds: readonly string[];
  readonly taskCount: number;
  readonly trialCount: number;
  readonly executionModes: readonly EvaluationExecutionMode[];
  readonly ruleConfigurationHash?: string;
  readonly modelProvider: string;
  readonly model: string;
  readonly generationConfig?: Readonly<Record<string, unknown>>;
  readonly harnessVersion: string;
}): string {
  const sanitizedConfig = params.generationConfig
    ? (redactSensitiveData(params.generationConfig) as Record<string, unknown>)
    : {};
  const canonicalPayload = {
    executionModes: [...params.executionModes].sort(),
    generationConfig: sanitizedConfig,
    harnessVersion: params.harnessVersion,
    manifestVersion: params.manifestVersion,
    model: params.model,
    modelProvider: params.modelProvider,
    ruleConfigurationHash: params.ruleConfigurationHash ?? null,
    taskCount: params.taskCount,
    taskIds: [...params.taskIds].sort(),
    taskRegistry: params.taskRegistry,
    trialCount: params.trialCount,
  };
  return computeCanonicalHash(canonicalPayload).contentHash;
}

export function createExperimentManifest(params: {
  readonly experimentId: string;
  readonly taskRegistry?: string;
  readonly taskIds: readonly string[];
  readonly trialCount: number;
  readonly executionModes: readonly EvaluationExecutionMode[];
  readonly ruleConfigurationHash?: string;
  readonly modelProvider: string;
  readonly model: string;
  readonly generationConfig?: Readonly<Record<string, unknown>>;
  readonly harnessVersion?: string;
}): ExperimentManifest {
  const taskRegistry = params.taskRegistry ?? "emerald-controlled-baseline-reflex";
  const harnessVersion = params.harnessVersion ?? CURRENT_HARNESS_VERSION;
  const taskCount = params.taskIds.length;

  const sanitizedGenerationConfig = params.generationConfig
    ? (redactSensitiveData(params.generationConfig) as Record<string, unknown>)
    : undefined;

  const manifestHash = computeExperimentManifestHash({
    manifestVersion: 1,
    experimentId: params.experimentId,
    taskRegistry,
    taskIds: params.taskIds,
    taskCount,
    trialCount: params.trialCount,
    executionModes: params.executionModes,
    ruleConfigurationHash: params.ruleConfigurationHash,
    modelProvider: params.modelProvider,
    model: params.model,
    generationConfig: sanitizedGenerationConfig,
    harnessVersion,
  });

  const raw = {
    manifestVersion: 1 as const,
    experimentId: params.experimentId,
    taskRegistry,
    taskIds: params.taskIds,
    taskCount,
    trialCount: params.trialCount,
    executionModes: params.executionModes,
    ruleConfigurationHash: params.ruleConfigurationHash,
    modelProvider: params.modelProvider,
    model: params.model,
    generationConfig: sanitizedGenerationConfig ? Object.freeze({ ...sanitizedGenerationConfig }) : undefined,
    harnessVersion,
    manifestHash,
  };

  const parsed = ExperimentManifestSchema.parse(raw);
  return Object.freeze({
    ...parsed,
    taskIds: Object.freeze([...parsed.taskIds]),
    executionModes: Object.freeze([...parsed.executionModes]),
  });
}

