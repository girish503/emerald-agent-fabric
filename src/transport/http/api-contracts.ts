/**
 * Milestone 2.25 / Wave 1 — Frozen Backend API Contracts (Track B)
 *
 * Implements typed OpenAPI/Zod contracts, schemas, error taxonomies, authentication
 * envelopes, and SSE event streaming definitions for Emerald Agent Fabric.
 *
 * Architectural Invariants:
 * 1. Claims != Evidence: No completion endpoint accepts arbitrary success assertions.
 * 2. Fail-Closed Security: No arbitrary shell execution, unrestricted file mounts,
 *    or direct database mutation is exposed.
 * 3. Trace correlation: every response carries a request trace ID. Idempotency keys are NOT implemented.
 * 4. Pure Transport Layer: Depends only on Zod and domain contracts.
 * 5. No public completion override: callers cannot enable unverified completion (Milestone 2.23 gate).
 * 6. Durability is declared per route in the server (docs: Track B route inventory); a field in these
 *    schemas does not imply the data behind it is durable.
 */

import { z } from "zod";
import { TRIAL_FINAL_OUTCOMES, type TrialFinalOutcome } from "../../domain/evaluation.js";

export type { TrialFinalOutcome };
export const API_VERSION = "v1";

// ============================================================================
// 1. Error Taxonomy & Response Schemas
// ============================================================================

export const API_ERROR_CODES = [
  "TRANSIENT",
  "PERMANENT",
  "POLICY_DENIED",
  "USER_ACTION_REQUIRED",
  "MODEL_ERROR",
  "TOOL_ERROR",
  "SANDBOX_ERROR",
  "INTERNAL_ERROR",
  "NOT_FOUND",
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "CONFLICT",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "SERVICE_UNAVAILABLE",
  "TOO_MANY_REQUESTS",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const ApiErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    message: z.string().min(1),
    details: z.record(z.unknown()).optional(),
    timestamp: z.string().datetime(),
    traceId: z.string().min(1),
  }),
});

export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

// ============================================================================
// 2. Authentication & Authorization Contracts
// ============================================================================

export const USER_ROLES = ["operator", "auditor", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const AuthPrincipalSchema = z.object({
  principalId: z.string().min(1),
  tenantId: z.string().min(1).default("default-tenant"),
  role: z.enum(USER_ROLES),
  capabilities: z.array(z.string()),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export type AuthPrincipal = z.infer<typeof AuthPrincipalSchema>;

export const WhoamiIdentitySchema = z.object({
  principalId: z.string().min(1),
  tenantId: z.string().min(1),
  role: z.enum(USER_ROLES),
  allowConstrainedHost: z.boolean().optional(),
});

export type WhoamiIdentity = z.infer<typeof WhoamiIdentitySchema>;

export const WhoamiResponseSchema = z.object({
  success: z.literal(true),
  data: WhoamiIdentitySchema,
});

export type WhoamiResponse = z.infer<typeof WhoamiResponseSchema>;

export const AuthorizationHeaderSchema = z
  .string()
  .regex(/^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/, "Must be valid Bearer token");

// ============================================================================
// 3. Task Submission Contracts
// ============================================================================

export const ExecutionModeSchema = z.enum(["sandboxed", "constrained_host"]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

import {
  ALLOWED_VERIFICATION_EXECUTABLES,
  FORBIDDEN_CODE_EXECUTION_FLAGS,
  SHELL_METACHARACTER_REGEX,
  validateVerificationOperation,
  type AllowedVerificationExecutable,
  type ServerVerificationOperationId,
} from "../../application/verification-operation-registry.js";

export {
  ALLOWED_VERIFICATION_EXECUTABLES,
  FORBIDDEN_CODE_EXECUTION_FLAGS,
  SHELL_METACHARACTER_REGEX,
  validateVerificationOperation,
  type AllowedVerificationExecutable,
  type ServerVerificationOperationId,
};

export function tokenizeCommandLine(command: string): string[] {
  const tokens: string[] = [];
  const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(command)) !== null) {
    if (match[1] !== undefined) {
      tokens.push(match[1].replace(/\\"/g, '"'));
    } else if (match[2] !== undefined) {
      tokens.push(match[2].replace(/\\'/g, "'"));
    } else if (match[3] !== undefined) {
      tokens.push(match[3]);
    }
  }
  return tokens;
}

export const VerificationRuleKindSchema = z.enum([
  "EXIT_CODE_ZERO",
  "EXACT_OUTPUT_MATCH",
  "OUTPUT_HASH_MATCH",
]);
export type VerificationRuleKindInput = z.infer<typeof VerificationRuleKindSchema>;

export const VerificationSpecInputSchema = z
  .object({
    specId: z
      .string()
      .min(1)
      .max(64)
      .regex(
        /^[a-zA-Z0-9_-]+$/,
        "specId must contain only alphanumeric characters, dashes, and underscores"
      )
      .optional(),
    name: z.string().min(1).max(128).optional(),
    operationId: z.string().min(1).max(64).optional(),
    ruleKind: VerificationRuleKindSchema.optional(),
    argv: z
      .array(
        z
          .string()
          .min(1)
          .max(1024)
          .refine(
            (arg) => !SHELL_METACHARACTER_REGEX.test(arg),
            "Argument must not contain shell metacharacters (; & | ` $ > < \\n \\r)"
          )
      )
      .min(1)
      .max(64)
      .optional(),
    command: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (cmd) => !SHELL_METACHARACTER_REGEX.test(cmd),
        "Command must not contain shell metacharacters (; & | ` $ > < \\n \\r)"
      )
      .optional(),
    timeoutMs: z.number().int().positive().max(300_000).default(30_000),
    expectedExitCode: z.number().int().default(0),
    expectedHash: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/, "expectedHash must be a 64-character SHA-256 hex string")
      .optional(),
    expectedOutput: z.unknown().optional(),
    requireMutation: z.boolean().optional(),
    requireDiff: z.boolean().optional(),
  })
  .strict()
  .refine(
    (spec) => {
      const kind = spec.ruleKind ?? "EXIT_CODE_ZERO";
      if (kind === "EXIT_CODE_ZERO") {
        return (
          (spec.argv !== undefined && spec.argv.length > 0) ||
          (spec.command !== undefined && spec.command.trim().length > 0)
        );
      }
      return true;
    },
    { message: "EXIT_CODE_ZERO verification requires either non-empty 'argv' or 'command'" }
  )
  .refine(
    (spec) => {
      const kind = spec.ruleKind ?? "EXIT_CODE_ZERO";
      if (kind === "EXIT_CODE_ZERO") {
        let argv = spec.argv;
        if (!argv && spec.command) {
          argv = tokenizeCommandLine(spec.command);
        }
        if (!argv || argv.length === 0) return false;
        const res = validateVerificationOperation(argv);
        return res.valid;
      }
      return true;
    },
    (spec) => {
      let argv = spec.argv;
      if (!argv && spec.command) {
        argv = tokenizeCommandLine(spec.command);
      }
      const res =
        argv && argv.length > 0
          ? validateVerificationOperation(argv)
          : { valid: false, reason: "No valid command or argv provided" };
      return {
        message:
          res.reason ??
          `Verification command failed server-defined verification operation validation (${ALLOWED_VERIFICATION_EXECUTABLES.join(", ")})`,
      };
    }
  );

export type VerificationSpecInput = z.input<typeof VerificationSpecInputSchema>;
export type VerificationSpecOutput = z.infer<typeof VerificationSpecInputSchema>;

export const ModelConfigInputSchema = z.object({
  provider: z.string().min(1).max(64).default("ollama"),
  modelName: z.string().min(1).max(128),
  temperature: z.number().min(0).max(2).default(0),
  contextWindow: z.number().int().positive().max(131_072).default(8192),
});

export const ResourceLimitsInputSchema = z.object({
  timeoutSeconds: z.number().int().positive().max(86_400).default(1800),
  maxSteps: z.number().int().positive().max(500).default(50),
  maxOutputBytes: z.number().int().positive().max(10 * 1024 * 1024).default(1024 * 1024),
});

/**
 * Strict: unknown keys are rejected (400), so clients cannot supply server-owned fields. In particular
 * there is NO client-supplied task id (ids are server-generated, which removes cross-tenant id rebinding)
 * and NO `allowUnverifiedCompletion` (unverified completion is an operator-level runtime decision that is
 * never exposed to API callers).
 */
export const CreateTaskRequestSchema = z
  .object({
    title: z.string().min(1).max(256),
    prompt: z.string().min(1).max(65536),
    repoPath: z.string().max(1024).optional(),
    requiredCapabilities: z.array(z.string().min(1)).default([]),
    executionMode: ExecutionModeSchema.default("sandboxed"),
    modelConfig: ModelConfigInputSchema,
    resourceLimits: ResourceLimitsInputSchema.default({}),
    verificationSpecs: z.array(VerificationSpecInputSchema).default([]),
    idempotencyKey: z.string().min(1).max(256).optional(),
  })
  .strict();

export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

export const TaskStatusSchema = z.enum([
  "CREATED",
  "QUEUED",
  "LEASED",
  "RUNNING",
  "VERIFYING",
  "WAITING_APPROVAL",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
  "RECOVERING",
]);

export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSummarySchema = z.object({
  taskId: z.string().min(1),
  tenantId: z.string().optional(),
  title: z.string(),
  status: TaskStatusSchema,
  executionMode: ExecutionModeSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** null when no Mission Contract exists for the task (transport-local records have none). */
  contractId: z.string().min(1).nullable(),
  runId: z.string().min(1).optional(),
  parentTaskId: z.string().min(1).optional(),
  childTaskCount: z.number().int().nonnegative().optional(),
  dependsOnTaskIds: z.array(z.string().min(1)).optional(),
});

export type TaskSummary = z.infer<typeof TaskSummarySchema>;

export const TaskResponseSchema = z.object({
  success: z.literal(true),
  data: TaskSummarySchema,
});

export type TaskResponse = z.infer<typeof TaskResponseSchema>;

export const ListTasksQuerySchema = z
  .object({
    limit: z.preprocess((val) => {
      if (val === undefined || val === null || val === "") return 20;
      if (typeof val === "string") {
        const num = Number(val);
        if (Number.isInteger(num)) return num;
      }
      return val;
    }, z.number().int().positive().max(100).default(20)),
    cursor: z.string().min(1).optional(),
    status: TaskStatusSchema.optional(),
  })
  .strict();

export type ListTasksQuery = z.infer<typeof ListTasksQuerySchema>;

export const ListTasksResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(TaskSummarySchema),
  nextCursor: z.string().nullable(),
});

export type ListTasksResponse = z.infer<typeof ListTasksResponseSchema>;

export const TaskDagNodeSchema = z.object({
  taskId: z.string(),
  title: z.string(),
  status: z.string(),
  parentTaskIds: z.array(z.string()),
  childTaskIds: z.array(z.string()),
});
export type TaskDagNode = z.infer<typeof TaskDagNodeSchema>;

export const TaskDagResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    rootTaskId: z.string(),
    nodes: z.array(TaskDagNodeSchema),
  }),
});
export type TaskDagResponse = z.infer<typeof TaskDagResponseSchema>;

// ============================================================================
// 3b. Approval Lifecycle Contracts (M4.2)
// ============================================================================

export const ApprovalStatusSchema = z.enum(["PENDING", "APPROVED", "REJECTED", "EXPIRED", "CONSUMED"]);
export type ApprovalStatusDto = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalSummarySchema = z.object({
  approvalId: z.string().min(1),
  runId: z.string().min(1),
  taskId: z.string().min(1).nullable(),
  tenantId: z.string().min(1).nullable(),
  operation: z.string().min(1),
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  justification: z.string(),
  status: ApprovalStatusSchema,
  singleUse: z.boolean(),
  requestedAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().datetime().nullable(),
  decisionReason: z.string().nullable(),
  consumedAt: z.string().datetime().nullable(),
});
export type ApprovalSummary = z.infer<typeof ApprovalSummarySchema>;

export const ListApprovalsQuerySchema = z
  .object({
    runId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    status: ApprovalStatusSchema.optional(),
  })
  .strict();

export const ListApprovalsResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(ApprovalSummarySchema),
});
export type ListApprovalsResponse = z.infer<typeof ListApprovalsResponseSchema>;

export const ApprovalResponseSchema = z.object({
  success: z.literal(true),
  data: ApprovalSummarySchema,
});
export type ApprovalResponse = z.infer<typeof ApprovalResponseSchema>;

export const ApprovalDecisionRequestSchema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT"]).optional(),
    reason: z.string().min(1).max(512).optional(),
  })
  .strict();
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequestSchema>;

export const ApprovalDecisionResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    approval: ApprovalSummarySchema,
    runStatus: TaskStatusSchema.optional(),
    resumed: z.boolean(),
  }),
});
export type ApprovalDecisionResponse = z.infer<typeof ApprovalDecisionResponseSchema>;

// ============================================================================
// 4. Run Lifecycle & Inspection Contracts
// ============================================================================

export const RunResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    runId: z.string().min(1),
    taskId: z.string().min(1),
    tenantId: z.string().optional(),
    status: TaskStatusSchema,
    attemptNumber: z.number().int().nonnegative(),
    currentStepIndex: z.number().int().nonnegative(),
    leaseExpiresAt: z.string().datetime().nullable(),
    finalOutcome: z.enum(TRIAL_FINAL_OUTCOMES).nullable(),
    metrics: z.object({
      wallClockMs: z.number().nonnegative(),
      stepCount: z.number().int().nonnegative(),
      toolCallCount: z.number().int().nonnegative(),
    }),
    createdAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
    executionMode: z.enum(["fixture", "live"]).optional(),
    currentWorkerId: z.string().min(1).nullable().optional(),
    leaseId: z.string().min(1).nullable().optional(),
    pendingApprovals: z.array(ApprovalSummarySchema).optional(),
    repairSummary: z
      .object({
        cycleCount: z.number().int().nonnegative(),
        stagnationDetected: z.boolean(),
        exhausted: z.boolean(),
        lastDiagnosis: z.string().optional(),
      })
      .optional(),
    memorySummary: z
      .object({
        entryCount: z.number().int().nonnegative(),
        verifiedCount: z.number().int().nonnegative(),
        scopes: z.record(z.string(), z.number().int().nonnegative()),
      })
      .optional(),
    verificationSummary: z
      .object({
        verified: z.boolean(),
        reason: z.string().optional(),
        specCount: z.number().int().nonnegative(),
        proofHash: z.string().optional(),
        verifierId: z.string().optional(),
        specId: z.string().optional(),
      })
      .optional(),
  }),
});

export type RunResponse = z.infer<typeof RunResponseSchema>;

export const CancelRunRequestSchema = z.object({
  reason: z.string().min(1).max(512),
});

export type CancelRunRequest = z.infer<typeof CancelRunRequestSchema>;

export const CancelRunResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    runId: z.string().min(1),
    status: z.literal("CANCELLED"),
    reason: z.string(),
    cancelledAt: z.string().datetime(),
    note: z.string().optional(),
  }),
});

export type CancelRunResponse = z.infer<typeof CancelRunResponseSchema>;

// ============================================================================
// 5. Artifact Metadata & Evidence Contracts
// ============================================================================

export const ArtifactResponseSchema = z.object({
  artifactId: z.string().min(1),
  runId: z.string().min(1),
  relativePath: z.string().min(1),
  sha256: z.string().length(64),
  byteSize: z.number().int().nonnegative(),
  contentType: z.string().min(1),
  createdAt: z.string().datetime(),
});

export type ArtifactResponse = z.infer<typeof ArtifactResponseSchema>;

export const ListArtifactsResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(ArtifactResponseSchema),
});

export type ListArtifactsResponse = z.infer<typeof ListArtifactsResponseSchema>;

// ============================================================================
// 6. SSE Execution Event Streaming Contracts
// ============================================================================

/**
 * Durable run event types the runtime actually persists (src/domain/events.ts, plus the Milestone 2.23
 * completion-gate events). The stream relays EVERY durable event of a run in sequence order (filtering
 * would create sequence gaps), so this list is the documented known set, not a filter. Events the runtime
 * does not emit (for example "stream.completed", "sandbox.ready", "tool.requested") are intentionally absent.
 */
export const SSE_EVENT_TYPES = [
  "run.created",
  "run.queued",
  "worker.claimed",
  "run.started",
  "verification.started",
  "run.waiting_approval",
  "run.completed",
  "run.failed",
  "run.timed_out",
  "run.cancelled",
  "lease.expired",
  "run.recovered",
  "policy.evaluated",
  "evidence.recorded",
  "verification.completed",
  "verification.rejected",
  "verification.unverified_completion_authorized",
  "workspace.provisioning",
  "workspace.ready",
  "workspace.leased",
  "workspace.cleaning",
  "workspace.disposed",
  "workspace.failed",
  "action.created",
  "action.authorized",
  "action.started",
  "action.completed",
  "action.failed",
  "action.timed_out",
  "action.cancelled",
  "action.retrying",
  "attempt.created",
  "attempt.dispatched",
  "attempt.started",
  "attempt.completed",
  "attempt.failed",
  "attempt.timed_out",
  "attempt.cancelled",
  "attempt.unknown",
] as const;

export type SseEventType = (typeof SSE_EVENT_TYPES)[number];

/** Events the stream terminates after. They are relayed from the durable log, never synthesised. */
export const SSE_TERMINAL_EVENT_TYPES = ["run.completed", "run.failed", "run.cancelled", "run.timed_out"] as const;

/**
 * Transport control events (not run events, never carry an `id:` field, never advance the client cursor).
 * `stream.overflow` tells the client the connection ended because events could not be delivered losslessly.
 * `stream.error` informs the client of a server-side read or relay failure.
 */
export const SSE_CONTROL_EVENT_TYPES = ["stream.overflow", "stream.error"] as const;

export const StreamOverflowPayloadSchema = z.object({
  runId: z.string().min(1),
  lastDeliveredSequence: z.number().int().nonnegative(),
  reason: z.enum(["LIVE_BUFFER_OVERFLOW", "SLOW_CLIENT_BACKPRESSURE", "SEQUENCE_GAP"]),
  recovery: z.string(),
});

export const StreamErrorPayloadSchema = z.object({
  runId: z.string().min(1),
  code: z.string().min(1),
  message: z.string().min(1),
});

export const SseEventEnvelopeSchema = z.object({
  id: z.string().min(1),
  /** One of SSE_EVENT_TYPES for durable events; unknown durable types are still relayed to keep sequences gapless. */
  event: z.string().min(1),
  runId: z.string().min(1),
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime(),
  schemaVersion: z.number().int().positive(),
  producer: z.string().min(1),
  data: z.unknown(),
});

export type SseEventEnvelope = z.infer<typeof SseEventEnvelopeSchema>;

// ============================================================================
// 7. OpenAPI / Route Registry Interface
// ============================================================================

export interface FastifyRouteDeclaration {
  readonly method: "GET" | "POST" | "DELETE";
  readonly url: string;
  readonly schema: {
    readonly description: string;
    readonly tags: readonly string[];
    readonly body?: z.ZodTypeAny;
    readonly querystring?: z.ZodTypeAny;
    readonly params?: z.ZodTypeAny;
    readonly response: Record<number, z.ZodTypeAny>;
  };
}

// ============================================================================
// Multi-Agent & Super Agent Orchestration Contracts (Phase 2)
// ============================================================================

export const SuperAgentRoleSchema = z.enum(["RESEARCHER", "CODER", "TESTER", "REVIEWER"]);
export type SuperAgentRole = z.infer<typeof SuperAgentRoleSchema>;

export const SubtaskSpecInputSchema = z.object({
  subtaskId: z.string().min(1).max(64),
  role: SuperAgentRoleSchema,
  objective: z.string().min(1).max(2048),
  constraints: z.array(z.string().min(1)).optional(),
  acceptanceCriteria: z.array(z.string().min(1)).optional(),
  dependencies: z.array(z.string().min(1)).optional(),
  verificationSpecs: z.array(VerificationSpecInputSchema).optional(),
  resourceLimits: z
    .object({
      timeoutMs: z.number().int().positive().optional(),
      maxAttempts: z.number().int().positive().optional(),
      maxOutputBytes: z.number().int().positive().optional(),
    })
    .optional(),
  customCapabilities: z.array(z.string().min(1)).optional(),
  inputPayload: z.record(z.unknown()).optional(),
});

export const DecomposeMissionRequestSchema = z
  .object({
    subtasks: z.array(SubtaskSpecInputSchema).min(1).max(16),
    maxDepth: z.number().int().positive().max(16).optional(),
    maxChildrenPerParent: z.number().int().positive().max(32).optional(),
  })
  .strict();

export type DecomposeMissionRequest = z.infer<typeof DecomposeMissionRequestSchema>;

export interface DecomposeMissionResponse {
  readonly success: true;
  readonly data: {
    readonly missionTaskId: string;
    readonly decompositionHash: string;
    readonly subtaskTaskIds: readonly string[];
    readonly totalSubtasks: number;
    readonly isDuplicate: boolean;
  };
}

export interface MissionHierarchyResponse {
  readonly success: true;
  readonly data: {
    readonly missionTaskId: string;
    readonly missionTitle: string | null;
    readonly decompositionHash: string | null;
    readonly root: unknown;
    readonly totalSubtasks: number;
  };
}

export interface SynthesizeMissionResponse {
  readonly success: true;
  readonly data: {
    readonly missionTaskId: string;
    readonly verdict: string;
    readonly totalSubtasks: number;
    readonly verifiedCount: number;
    readonly rejectedCount: number;
    readonly blockedCount: number;
    readonly unverifiableCount: number;
    readonly summary: string;
    readonly canCompleteMission: boolean;
    readonly subtaskReports: readonly unknown[];
  };
}

export const FROZEN_API_ROUTES: readonly FastifyRouteDeclaration[] = [
  {
    method: "GET",
    url: "/api/v1/tasks",
    schema: {
      description: "List tasks for the authenticated tenant with cursor pagination and status filtering",
      tags: ["Tasks"],
      querystring: ListTasksQuerySchema,
      response: {
        200: ListTasksResponseSchema,
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        403: ApiErrorResponseSchema,
      },
    },
  },
  {
    method: "POST",
    url: "/api/v1/tasks",
    schema: {
      description: "Submit a new governed agent task with explicit capability and resource bounds (transport-local non-durable adapter)",
      tags: ["Tasks"],
      body: CreateTaskRequestSchema,
      response: {
        201: TaskResponseSchema,
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        403: ApiErrorResponseSchema,
        413: ApiErrorResponseSchema,
        415: ApiErrorResponseSchema,
        503: ApiErrorResponseSchema,
      },
    },
  },
  {
    method: "GET",
    url: "/api/v1/tasks/:taskId",
    schema: {
      description: "Retrieve task lifecycle status and specification",
      tags: ["Tasks"],
      params: z.object({ taskId: z.string().min(1) }),
      response: {
        200: TaskResponseSchema,
        401: ApiErrorResponseSchema,
        403: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
      },
    },
  },
  {
    method: "GET",
    url: "/api/v1/runs/:runId",
    schema: {
      description: "Retrieve run execution status, current step, lease, and authoritative outcome",
      tags: ["Runs"],
      params: z.object({ runId: z.string().min(1) }),
      response: {
        200: RunResponseSchema,
        401: ApiErrorResponseSchema,
        403: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
      },
    },
  },
  {
    method: "POST",
    url: "/api/v1/runs/:runId/cancel",
    schema: {
      description: "Safely cancel an in-flight run with reason recording (coordinator authority required)",
      tags: ["Runs"],
      params: z.object({ runId: z.string().min(1) }),
      body: CancelRunRequestSchema,
      response: {
        200: CancelRunResponseSchema,
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        403: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        409: ApiErrorResponseSchema,
        413: ApiErrorResponseSchema,
        415: ApiErrorResponseSchema,
        503: ApiErrorResponseSchema,
      },
    },
  },
  {
    method: "GET",
    url: "/api/v1/runs/:runId/events",
    schema: {
      description: "Open an SSE stream delivering ordered execution lifecycle events from durable store replay",
      tags: ["Streaming"],
      params: z.object({ runId: z.string().min(1) }),
      response: {
        200: z.any(), // SSE text/event-stream
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        403: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        429: ApiErrorResponseSchema,
        503: ApiErrorResponseSchema,
      },
    },
  },
  {
    method: "GET",
    url: "/api/v1/auth/whoami",
    schema: {
      description: "Inspect the authenticated principal, tenant, and role without returning secret tokens",
      tags: ["Auth"],
      response: {
        200: WhoamiResponseSchema,
        401: ApiErrorResponseSchema,
      },
    },
  },
  {
    method: "GET",
    url: "/api/v1/runs/:runId/artifacts",
    schema: {
      description: "List artifacts and cryptographic hashes produced by a run",
      tags: ["Artifacts"],
      params: z.object({ runId: z.string().min(1) }),
      response: {
        200: ListArtifactsResponseSchema,
        401: ApiErrorResponseSchema,
        403: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
      },
    },
  },
  {
    method: "GET",
    url: "/api/v1/runs/:runId/artifacts/:artifactId/content",
    schema: {
      description: "Retrieve verified raw artifact content bytes for a run",
      tags: ["Artifacts"],
      params: z.object({
        runId: z.string().min(1),
        artifactId: z.string().min(1),
      }),
      response: {
        200: z.string(),
        401: ApiErrorResponseSchema,
        403: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        409: ApiErrorResponseSchema,
        413: ApiErrorResponseSchema,
      },
    },
  },
  {
    method: "POST",
    url: "/api/v1/tasks/:taskId/decompose",
    schema: {
      description: "Decompose a mission into bounded, dependency-aware subtasks governed by narrow contracts",
      tags: ["Multi-Agent"],
      params: z.object({ taskId: z.string().min(1) }),
      body: DecomposeMissionRequestSchema,
      response: {
        200: z.any(),
        201: z.any(),
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        403: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        503: ApiErrorResponseSchema,
      },
    },
  },
  {
    method: "GET",
    url: "/api/v1/tasks/:taskId/hierarchy",
    schema: {
      description: "Retrieve complete multi-agent subtask hierarchy and verification statuses",
      tags: ["Multi-Agent"],
      params: z.object({ taskId: z.string().min(1) }),
      response: {
        200: z.any(),
        401: ApiErrorResponseSchema,
        403: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        503: ApiErrorResponseSchema,
      },
    },
  },
  {
    method: "POST",
    url: "/api/v1/tasks/:taskId/synthesize",
    schema: {
      description: "Synthesize mission outcome from subtask verifications enforcing fail-closed zero self-approval",
      tags: ["Multi-Agent"],
      params: z.object({ taskId: z.string().min(1) }),
      response: {
        200: z.any(),
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        403: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        503: ApiErrorResponseSchema,
      },
    },
  },
  {
    method: "GET",
    url: "/api/v1/approvals",
    schema: {
      description: "List governed human-in-the-loop approval requests scoped strictly to the caller tenant",
      tags: ["Approvals"],
      querystring: ListApprovalsQuerySchema,
      response: {
        200: ListApprovalsResponseSchema,
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        403: ApiErrorResponseSchema,
        503: ApiErrorResponseSchema,
      },
    },
  },
  {
    method: "POST",
    url: "/api/v1/approvals/:approvalId/approve",
    schema: {
      description: "Approve a pending human-in-the-loop request and requeue any WAITING_APPROVAL run",
      tags: ["Approvals"],
      params: z.object({ approvalId: z.string().min(1) }),
      body: ApprovalDecisionRequestSchema,
      response: {
        200: ApprovalDecisionResponseSchema,
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        403: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        409: ApiErrorResponseSchema,
        413: ApiErrorResponseSchema,
        415: ApiErrorResponseSchema,
        503: ApiErrorResponseSchema,
      },
    },
  },
  {
    method: "POST",
    url: "/api/v1/approvals/:approvalId/reject",
    schema: {
      description: "Reject a pending human-in-the-loop request and fail any WAITING_APPROVAL run",
      tags: ["Approvals"],
      params: z.object({ approvalId: z.string().min(1) }),
      body: ApprovalDecisionRequestSchema,
      response: {
        200: ApprovalDecisionResponseSchema,
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        403: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        409: ApiErrorResponseSchema,
        413: ApiErrorResponseSchema,
        415: ApiErrorResponseSchema,
        503: ApiErrorResponseSchema,
      },
    },
  },
  {
    method: "GET",
    url: "/metrics",
    schema: {
      description: "Expose system, agent step, inference, tool, and verification metrics in Prometheus exposition format",
      tags: ["Monitoring"],
      response: {
        200: z.string(),
      },
    },
  },
  {
    method: "GET",
    url: "/health",
    schema: {
      description: "Read-only runtime, SQLite store, and observability pipeline health status (zero authority)",
      tags: ["Monitoring"],
      response: {
        200: z.any(),
      },
    },
  },
] as const;
