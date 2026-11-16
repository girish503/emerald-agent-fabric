/**
 * Frontend Type Definitions (Track C / Milestone 2.27)
 *
 * Re-exports authoritative backend contracts from Track B (api-contracts.ts)
 * and maintains backwards-compatible view model types for Track C components.
 */

// 1. Authoritative Backend Re-exports
export type {
  TrialFinalOutcome,
  TaskStatus,
  ExecutionMode,
  CreateTaskRequest,
  TaskResponse,
  RunResponse,
  CancelRunRequest,
  CancelRunResponse,
  ArtifactResponse,
  ListArtifactsResponse,
  ApiErrorResponse,
  ApiErrorCode,
  SseEventEnvelope,
  FastifyRouteDeclaration,
  TaskSummary,
  ListTasksQuery,
  ListTasksResponse,
  WhoamiIdentity,
  WhoamiResponse,
} from "../../../../src/transport/http/api-contracts.js";

export { TRIAL_FINAL_OUTCOMES } from "../../../../src/domain/evaluation.js";

export {
  API_VERSION,
  API_ERROR_CODES,
  ApiErrorResponseSchema,
  AuthPrincipalSchema,
  CreateTaskRequestSchema,
  TaskStatusSchema,
  ExecutionModeSchema,
  TaskResponseSchema,
  RunResponseSchema,
  CancelRunRequestSchema,
  CancelRunResponseSchema,
  ArtifactResponseSchema,
  ListArtifactsResponseSchema,
  SSE_EVENT_TYPES,
  SSE_TERMINAL_EVENT_TYPES,
  SSE_CONTROL_EVENT_TYPES,
  StreamOverflowPayloadSchema,
  StreamErrorPayloadSchema,
  SseEventEnvelopeSchema,
  FROZEN_API_ROUTES,
  TaskSummarySchema,
  ListTasksQuerySchema,
  ListTasksResponseSchema,
  WhoamiIdentitySchema,
  WhoamiResponseSchema,
} from "../../../../src/transport/http/api-contracts.js";

export interface ListTasksOptions {
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: TaskStatus;
  readonly signal?: AbortSignal;
}

// 2. Track C View Model & Mock Compatibility Types
import type {
  TaskStatus,
  ExecutionMode,
  TrialFinalOutcome,
} from "../../../../src/transport/http/api-contracts.js";

export interface CreateTaskInput {
  title: string;
  prompt: string;
  repoPath?: string;
  requiredCapabilities?: string[];
  executionMode?: ExecutionMode;
  modelConfig: {
    provider?: string;
    modelName: string;
    temperature?: number;
    contextWindow?: number;
  };
  resourceLimits?: {
    timeoutSeconds?: number;
    maxSteps?: number;
    maxOutputBytes?: number;
  };
  verificationSpecs?: Array<{
    name: string;
    command: string;
    timeoutMs?: number;
    expectedExitCode?: number;
  }>;
  /**
   * @deprecated Internal operator-only capability; rejected by backend contract in production submissions.
   */
  allowUnverifiedCompletion?: boolean;
}

export interface TaskRecord {
  taskId: string;
  title: string;
  status: TaskStatus;
  executionMode: ExecutionMode;
  allowUnverifiedCompletion?: boolean;
  createdAt: string;
  updatedAt: string;
  contractId: string | null;
  tenantId?: string;
  runId?: string;
  parentTaskId?: string;
  childTaskCount?: number;
}

export interface RunRecord {
  runId: string;
  taskId: string;
  status: TaskStatus;
  attemptNumber: number;
  currentStepIndex: number;
  leaseExpiresAt: string | null;
  finalOutcome: TrialFinalOutcome | null;
  metrics: {
    wallClockMs: number;
    stepCount: number;
    toolCallCount: number;
  };
  createdAt: string;
  completedAt: string | null;
  tenantId?: string;
}

export interface ExecutionEvent {
  id: string;
  event: string;
  runId: string;
  sequence: number;
  timestamp: string;
  schemaVersion: number;
  producer: string;
  data: Record<string, unknown>;
}

export interface ArtifactRecord {
  artifactId: string;
  runId: string;
  relativePath: string;
  sha256: string;
  byteSize: number;
  contentType: string;
  createdAt: string;
}

export interface ArtifactContentResponse {
  artifactId: string;
  runId: string;
  content: string;
  contentType: string;
  sha256?: string;
  fileName?: string;
  byteLength: number;
  truncated: boolean;
}

// 3. Track C Multi-Agent Mission DAG Types
export type RunDagNodeState =
  | "pending"
  | "running"
  | "waiting-approval"
  | "verified"
  | "completed"
  | "failed";

export interface RunDagToolCall {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly timestamp: string;
  readonly status: "requested" | "completed" | "failed";
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly output?: string;
}

export interface RunDagVerification {
  readonly verifierId?: string;
  readonly specId?: string;
  readonly status?: string;
  readonly exitCode?: number;
  readonly timestamp?: string;
  readonly summary?: string;
  readonly evidencePaths?: readonly string[];
  readonly unverifiedOverride?: boolean;
  readonly operator?: string;
  readonly note?: string;
}

export interface RunDagApproval {
  readonly approvalId: string;
  readonly operation: string;
  readonly status: "PENDING" | "APPROVED" | "REJECTED";
  readonly approver?: string;
  readonly justification?: string;
  readonly requestedAt: string;
  readonly decidedAt?: string;
}

export interface RunDagRepair {
  readonly eventType: string;
  readonly timestamp: string;
  readonly iteration: number;
  readonly ceiling: number;
  readonly feedbackCategory: string;
  readonly canContinue: boolean;
}

export interface RunDagTimelineEvent {
  readonly type: "tool" | "approval" | "repair" | "verification" | "lifecycle";
  readonly timestamp: string;
  readonly title: string;
  readonly description: string;
  readonly status?: string;
  readonly details?: unknown;
}

export interface RunDagNode {
  readonly id: string;
  readonly taskId: string;
  readonly title: string;
  readonly role: string;
  readonly objective: string;
  readonly dependencies: readonly string[];
  readonly state: RunDagNodeState;
  readonly rawStatus: string;
  readonly runId: string | null;
  readonly workerId: string | null;
  readonly durationMs: number;
  readonly toolCalls: readonly RunDagToolCall[];
  readonly verification: RunDagVerification | null;
  readonly approval: RunDagApproval | null;
  readonly repairs: readonly RunDagRepair[];
  readonly timeline: readonly RunDagTimelineEvent[];
}

export interface RunDagSnapshot {
  readonly rootTaskId: string;
  readonly missionTitle: string;
  readonly missionDescription: string;
  readonly rootRunId: string | null;
  readonly rootStatus: string;
  readonly activeNodeId: string | null;
  readonly nodes: readonly RunDagNode[];
  readonly synthesis?: unknown;
}
