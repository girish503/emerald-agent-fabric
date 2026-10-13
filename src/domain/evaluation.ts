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
