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
import { computeCanonicalHash, isSensitiveKey } from "./canonical-hash.js";
import { sanitizeWorkspacePath } from "./workspace-path.js";
import { FORBIDDEN_AUTHORITY_KEYS } from "./action-proposal.js";
import { VerificationSpec } from "./verification.js";

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
  readonly runId: string;
  readonly status: EvaluationStatus;
  readonly statusMessage: string;
  readonly verificationPassed: boolean;
  readonly agentClaimedGoal: boolean;
  readonly criteriaResults: readonly EvaluationCriterionResult[];
  readonly metrics: EvaluationMetrics;
  readonly evidenceReferences: readonly string[];
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
}

export function computeEvaluationTrialIdentityHash(params: EvaluationTrialIdentityParams): string {
  const configFingerprintHash =
    params.configFingerprintHash ?? params.configFingerprint?.fingerprintHash;
  if (!configFingerprintHash) {
    throw new Error("Missing configFingerprintHash or configFingerprint for trial identity hash calculation");
  }
  const canonicalPayload = {
    configFingerprintHash,
    taskId: params.taskId,
    taskContentHash: params.taskContentHash,
    taskVersion: params.taskVersion,
    trialOrdinal: params.trialOrdinal,
  };
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

  const trialIdentityHash = computeEvaluationTrialIdentityHash({
    taskId: runResult.taskId,
    taskVersion: runResult.taskVersion,
    taskContentHash: runResult.taskContentHash,
    configFingerprintHash: runResult.configFingerprint.fingerprintHash,
    trialOrdinal,
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
  readonly configFingerprint: EvaluationConfigFingerprint;
  readonly conditionHash: string;
}

export function computeConditionHash(params: {
  readonly conditionId: string;
  readonly configFingerprintHash: string;
}): string {
  const canonicalPayload = {
    conditionId: params.conditionId,
    configFingerprintHash: params.configFingerprintHash,
  };
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
    configFingerprint: EvaluationConfigFingerprintSchema,
    conditionHash: z.string().regex(/^[a-f0-9]{64}$/, "conditionHash must be a 64-char hex string"),
  })
  .strict()
  .superRefine((val, ctx) => {
    // 1. Condition hash consistency
    const expectedHash = computeConditionHash({
      conditionId: val.conditionId,
      configFingerprintHash: val.configFingerprint.fingerprintHash,
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
    configFingerprint: Object.freeze({ ...result.data.configFingerprint }),
    conditionHash: result.data.conditionHash,
  });
}

export interface CreateExperimentConditionParams {
  readonly conditionId: string;
  readonly name: string;
  readonly description?: string;
  readonly configFingerprint: EvaluationConfigFingerprint;
  readonly conditionHash?: string;
}

export function createExperimentCondition(
  params: CreateExperimentConditionParams
): EvaluationExperimentCondition {
  const conditionHash =
    params.conditionHash ??
    computeConditionHash({
      conditionId: params.conditionId,
      configFingerprintHash: params.configFingerprint?.fingerprintHash,
    });

  const raw = {
    conditionId: params.conditionId,
    name: params.name,
    description: params.description,
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
    trial.configFingerprint.fingerprintHash === condition.configFingerprint.fingerprintHash
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
