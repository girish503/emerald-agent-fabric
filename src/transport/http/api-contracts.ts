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

export const AuthorizationHeaderSchema = z
  .string()
  .regex(/^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/, "Must be valid Bearer token");

// ============================================================================
// 3. Task Submission Contracts
// ============================================================================

export const ExecutionModeSchema = z.enum(["sandboxed", "constrained_host"]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

export const VerificationSpecInputSchema = z.object({
  name: z.string().min(1).max(128),
  command: z.string().min(1).max(1024),
  timeoutMs: z.number().int().positive().max(300_000).default(30_000),
  expectedExitCode: z.number().int().default(0),
});

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

export const TaskResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
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
  }),
});

export type TaskResponse = z.infer<typeof TaskResponseSchema>;

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

export const FROZEN_API_ROUTES: readonly FastifyRouteDeclaration[] = [
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
] as const;
