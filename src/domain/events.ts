import { ContractBinding } from "./invariants.js";
import { ToolIdempotency, ToolName } from "./tool.js";

/**
 * Domain Events for Emerald Agent Fabric.
 * Pure definitions of state changes and lifecycle occurrences.
 */

export interface DomainEvent<T = unknown> {
  readonly eventId: string;
  readonly runId: string;
  readonly timestamp: string; // ISO 8601 UTC
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly producer: string;
  readonly payload: T;
}

export interface RunCreatedPayload {
  readonly taskId: string;
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  readonly idempotencyKey: string | null;
  readonly contractBinding?: {
    readonly contractId: string;
    readonly version: number;
    readonly contentHash: string;
  } | null;
  readonly maxOutputBytes?: number | null;
}

export type RunCreatedEvent = DomainEvent<RunCreatedPayload> & {
  readonly eventType: "run.created";
};

export interface RunQueuedPayload {
  readonly attemptNumber: number;
}

export type RunQueuedEvent = DomainEvent<RunQueuedPayload> & {
  readonly eventType: "run.queued";
};

export interface WorkerClaimedPayload {
  readonly workerId: string;
  readonly leaseId: string;
  readonly leaseExpiresAt: string;
}

export type WorkerClaimedEvent = DomainEvent<WorkerClaimedPayload> & {
  readonly eventType: "worker.claimed";
};

export interface RunStartedPayload {
  readonly workerId: string;
  readonly leaseId: string;
}

export type RunStartedEvent = DomainEvent<RunStartedPayload> & {
  readonly eventType: "run.started";
};

export interface RunCompletedPayload {
  readonly workerId: string;
  readonly leaseId: string;
  readonly result: unknown;
}

export type RunCompletedEvent = DomainEvent<RunCompletedPayload> & {
  readonly eventType: "run.completed";
};

export interface RunFailedPayload {
  readonly workerId: string | null;
  readonly leaseId: string | null;
  readonly error: unknown;
  readonly attemptNumber: number;
  readonly retriesExhausted: boolean;
}

export type RunFailedEvent = DomainEvent<RunFailedPayload> & {
  readonly eventType: "run.failed";
};

export interface RunTimedOutPayload {
  readonly workerId: string | null;
  readonly leaseId: string | null;
  readonly timeoutMs: number;
  readonly reason?: string;
}

export type RunTimedOutEvent = DomainEvent<RunTimedOutPayload> & {
  readonly eventType: "run.timed_out";
};

export interface RunCancelledPayload {
  readonly reason?: string;
}

export type RunCancelledEvent = DomainEvent<RunCancelledPayload> & {
  readonly eventType: "run.cancelled";
};

export interface LeaseExpiredPayload {
  readonly workerId: string;
  readonly leaseId: string;
  readonly expiredAt: string;
}

export type LeaseExpiredEvent = DomainEvent<LeaseExpiredPayload> & {
  readonly eventType: "lease.expired";
};

export interface RunRecoveredPayload {
  readonly nextAttemptNumber: number;
  readonly maxAttempts: number;
}

export type RunRecoveredEvent = DomainEvent<RunRecoveredPayload> & {
  readonly eventType: "run.recovered";
};

export interface VerificationStartedPayload {
  readonly workerId: string;
  readonly leaseId: string;
}

export type VerificationStartedEvent = DomainEvent<VerificationStartedPayload> & {
  readonly eventType: "verification.started";
};

export interface RunWaitingApprovalPayload {
  readonly approvalId: string;
  readonly operation: string;
  readonly previousStatus: string;
  readonly workerId: string | null;
  readonly leaseId: string | null;
}

export type RunWaitingApprovalEvent = DomainEvent<RunWaitingApprovalPayload> & {
  readonly eventType: "run.waiting_approval";
};

export interface PolicyEvaluatedPayload {
  readonly runId: string;
  readonly taskId: string;
  readonly operationName: string;
  readonly capabilityName: string;
  readonly policyId: string;
  readonly allowed: boolean;
  readonly isolationRequirement: string;
  readonly reasonCode?: string;
  readonly providerName?: string;
}

export type PolicyEvaluatedEvent = DomainEvent<PolicyEvaluatedPayload> & {
  readonly eventType: "policy.evaluated";
};

export interface EvidenceRecordedPayload {
  readonly evidenceId: string;
  readonly runId: string;
  readonly source: "PROVIDER_REPORTED" | "INDEPENDENT_OBSERVER";
  readonly kind: string;
  readonly contentHash: string;
  readonly summary?: Record<string, unknown>;
  readonly observedAt: string;
}

export type EvidenceRecordedEvent = DomainEvent<EvidenceRecordedPayload> & {
  readonly eventType: "evidence.recorded";
};

export interface VerificationCompletedPayload {
  readonly runId: string;
  readonly verifierId: string;
  readonly specId: string;
  readonly status: "VERIFIED" | "FAILED";
  readonly evidenceIds: readonly string[];
  readonly reasonCode?: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly verifiedAt: string;
}

export type VerificationCompletedEvent = DomainEvent<VerificationCompletedPayload> & {
  readonly eventType: "verification.completed";
};

export interface VerificationRejectedPayload {
  readonly runId: string;
  readonly status: "COMPLETION_REJECTED";
  readonly reason: "UNVERIFIED_COMPLETION_CLAIM";
  readonly message: string;
  readonly requirements: Record<string, string>;
  readonly outstandingRequirements: readonly string[];
  readonly rejectedAt: string;
}

export type VerificationRejectedEvent = DomainEvent<VerificationRejectedPayload> & {
  readonly eventType: "verification.rejected";
};

export interface WorkspaceProvisioningPayload {
  readonly workspaceId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly repositorySource?: {
    readonly type: "git" | "archive" | "local_template";
    readonly location: string;
    readonly revision: string;
  };
  readonly maxWorkspaceBytes: number;
}

export type WorkspaceProvisioningEvent = DomainEvent<WorkspaceProvisioningPayload> & {
  readonly eventType: "workspace.provisioning";
};

/** Audit summary of a repository copied into a run workspace. Counts only; never file contents. */
export interface RepositoryImportSummary {
  readonly sourcePath: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly skippedSymlinks: number;
  readonly skippedSpecialFiles: number;
  /** VCS metadata, dependency directories and likely secret files that were deliberately not copied. */
  readonly excludedEntries: number;
  readonly oversizeSkipped: number;
}

export interface WorkspaceReadyPayload {
  readonly workspaceId: string;
  readonly runId: string;
  readonly hostPath?: string;
  readonly containerMountPath?: string;
  readonly repositoryImport?: RepositoryImportSummary;
}

export type WorkspaceReadyEvent = DomainEvent<WorkspaceReadyPayload> & {
  readonly eventType: "workspace.ready";
};

export interface WorkspaceLeasedPayload {
  readonly workspaceId: string;
  readonly runId: string;
  readonly workerId: string;
  readonly leaseId: string;
}

export type WorkspaceLeasedEvent = DomainEvent<WorkspaceLeasedPayload> & {
  readonly eventType: "workspace.leased";
};

/** Audit summary of the artifact preserved from a run workspace before disposal. Counts and a digest only. */
export interface ArtifactExportSummary {
  /** Location relative to the configured artifact root. */
  readonly artifactPath: string;
  readonly attempt: number;
  readonly changedFiles: number;
  readonly added: number;
  readonly modified: number;
  readonly deleted: number;
  readonly patchBytes: number;
  readonly patchSha256: string;
}

export interface WorkspaceCleaningPayload {
  readonly workspaceId: string;
  readonly runId: string;
  readonly reason?: string;
  readonly artifactExport?: ArtifactExportSummary;
}

export type WorkspaceCleaningEvent = DomainEvent<WorkspaceCleaningPayload> & {
  readonly eventType: "workspace.cleaning";
};

export interface WorkspaceDisposedPayload {
  readonly workspaceId: string;
  readonly runId: string;
}

export type WorkspaceDisposedEvent = DomainEvent<WorkspaceDisposedPayload> & {
  readonly eventType: "workspace.disposed";
};

export interface WorkspaceFailedPayload {
  readonly workspaceId: string;
  readonly runId: string;
  readonly fromState: string;
  readonly errorMessage: string;
}

export type WorkspaceFailedEvent = DomainEvent<WorkspaceFailedPayload> & {
  readonly eventType: "workspace.failed";
};

export type AnyWorkspaceEvent =
  | WorkspaceProvisioningEvent
  | WorkspaceReadyEvent
  | WorkspaceLeasedEvent
  | WorkspaceCleaningEvent
  | WorkspaceDisposedEvent
  | WorkspaceFailedEvent;

// ============================================================================
// Action Domain Events (Phase 4 / Task 4.4-C)
// ============================================================================

export interface ActionCreatedPayload {
  readonly actionId: string;
  readonly runId: string;
  readonly sequenceNumber: number;
  readonly toolName: ToolName;
  readonly inputHash: string;
  readonly idempotency: ToolIdempotency;
  readonly contractBinding: ContractBinding;
  readonly maxAttempts: number;
}

export type ActionCreatedEvent = DomainEvent<ActionCreatedPayload> & {
  readonly eventType: "action.created";
};

export interface ActionAuthorizedPayload {
  readonly actionId: string;
  readonly runId: string;
  readonly sequenceNumber: number;
  readonly toolName: ToolName;
}

export type ActionAuthorizedEvent = DomainEvent<ActionAuthorizedPayload> & {
  readonly eventType: "action.authorized";
};

export interface ActionStartedPayload {
  readonly actionId: string;
  readonly runId: string;
  readonly attemptNumber: number;
}

export type ActionStartedEvent = DomainEvent<ActionStartedPayload> & {
  readonly eventType: "action.started";
};

export interface ActionCompletedPayload {
  readonly actionId: string;
  readonly runId: string;
  readonly totalAttempts: number;
  readonly resultPayload?: unknown;
}

export type ActionCompletedEvent = DomainEvent<ActionCompletedPayload> & {
  readonly eventType: "action.completed";
};

export interface ActionFailedPayload {
  readonly actionId: string;
  readonly runId: string;
  readonly totalAttempts: number;
  readonly error: unknown;
}

export type ActionFailedEvent = DomainEvent<ActionFailedPayload> & {
  readonly eventType: "action.failed";
};

export interface ActionTimedOutPayload {
  readonly actionId: string;
  readonly runId: string;
  readonly totalAttempts: number;
  readonly reason?: unknown;
}

export type ActionTimedOutEvent = DomainEvent<ActionTimedOutPayload> & {
  readonly eventType: "action.timed_out";
};

export interface ActionCancelledPayload {
  readonly actionId: string;
  readonly runId: string;
  readonly reason?: unknown;
}

export type ActionCancelledEvent = DomainEvent<ActionCancelledPayload> & {
  readonly eventType: "action.cancelled";
};

export interface ActionRetryingPayload {
  readonly actionId: string;
  readonly runId: string;
  readonly attemptNumber: number;
  readonly nextAttemptNumber: number;
  readonly maxAttempts: number;
  readonly error?: unknown;
}

export type ActionRetryingEvent = DomainEvent<ActionRetryingPayload> & {
  readonly eventType: "action.retrying";
};

export type AnyActionEvent =
  | ActionCreatedEvent
  | ActionAuthorizedEvent
  | ActionStartedEvent
  | ActionCompletedEvent
  | ActionFailedEvent
  | ActionTimedOutEvent
  | ActionCancelledEvent
  | ActionRetryingEvent;

// ============================================================================
// Attempt Domain Events (Phase 4 / Task 4.4-C)
// ============================================================================

export interface AttemptCreatedPayload {
  readonly attemptId: string;
  readonly actionId: string;
  readonly runId: string;
  readonly attemptNumber: number;
  readonly workerId: string;
  readonly leaseId: string;
  readonly idempotencyToken: string;
}

export type AttemptCreatedEvent = DomainEvent<AttemptCreatedPayload> & {
  readonly eventType: "attempt.created";
};

export interface AttemptDispatchedPayload {
  readonly attemptId: string;
  readonly actionId: string;
  readonly runId: string;
  readonly attemptNumber: number;
  readonly workerId: string;
  readonly leaseId: string;
}

export type AttemptDispatchedEvent = DomainEvent<AttemptDispatchedPayload> & {
  readonly eventType: "attempt.dispatched";
};

export interface AttemptStartedPayload {
  readonly attemptId: string;
  readonly actionId: string;
  readonly runId: string;
  readonly attemptNumber: number;
}

export type AttemptStartedEvent = DomainEvent<AttemptStartedPayload> & {
  readonly eventType: "attempt.started";
};

export interface AttemptCompletedPayload {
  readonly attemptId: string;
  readonly actionId: string;
  readonly runId: string;
  readonly attemptNumber: number;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly evidenceIds: readonly string[];
}

export type AttemptCompletedEvent = DomainEvent<AttemptCompletedPayload> & {
  readonly eventType: "attempt.completed";
};

export interface AttemptFailedPayload {
  readonly attemptId: string;
  readonly actionId: string;
  readonly runId: string;
  readonly attemptNumber: number;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly evidenceIds: readonly string[];
  readonly error: unknown;
}

export type AttemptFailedEvent = DomainEvent<AttemptFailedPayload> & {
  readonly eventType: "attempt.failed";
};

export interface AttemptTimedOutPayload {
  readonly attemptId: string;
  readonly actionId: string;
  readonly runId: string;
  readonly attemptNumber: number;
  readonly durationMs: number | null;
  readonly reason?: unknown;
}

export type AttemptTimedOutEvent = DomainEvent<AttemptTimedOutPayload> & {
  readonly eventType: "attempt.timed_out";
};

export interface AttemptCancelledPayload {
  readonly attemptId: string;
  readonly actionId: string;
  readonly runId: string;
  readonly attemptNumber: number;
  readonly reason?: unknown;
}

export type AttemptCancelledEvent = DomainEvent<AttemptCancelledPayload> & {
  readonly eventType: "attempt.cancelled";
};

export type AttemptUnknownReason =
  | "LEASE_EXPIRED_DURING_EXECUTION"
  | "WORKER_CRASHED"
  | "PROCESS_TERMINATION_BEFORE_PERSISTENCE"
  | "PROVIDER_RESULT_UNAVAILABLE"
  | "UNSPECIFIED_EXECUTION_UNCERTAINTY";

export interface AttemptUnknownPayload {
  readonly attemptId: string;
  readonly actionId: string;
  readonly runId: string;
  readonly attemptNumber: number;
  readonly reasonCode: AttemptUnknownReason;
  readonly details?: string;
}

export type AttemptUnknownEvent = DomainEvent<AttemptUnknownPayload> & {
  readonly eventType: "attempt.unknown";
};

export type AnyAttemptEvent =
  | AttemptCreatedEvent
  | AttemptDispatchedEvent
  | AttemptStartedEvent
  | AttemptCompletedEvent
  | AttemptFailedEvent
  | AttemptTimedOutEvent
  | AttemptCancelledEvent
  | AttemptUnknownEvent;


export type ModelInferenceOutcome =
  | "SUCCESS"
  | "TIMEOUT"
  | "CANCELLED"
  | "INVALID_RESPONSE"
  | "PROVIDER_UNAVAILABLE"
  | "ERROR";

export interface ModelInferenceTelemetryPayload {
  readonly runId: string;
  readonly taskId: string;
  readonly stepNumber: number;
  readonly workerId: string;
  readonly leaseId: string;
  readonly requestId: string;
  readonly model: string;
  readonly provider: string;
  readonly outcome: ModelInferenceOutcome;
  readonly startedAt: string; // ISO 8601 UTC
  readonly completedAt: string; // ISO 8601 UTC
  readonly wallClockDurationMs: number;
  readonly totalDurationNs?: number | null;
  readonly loadDurationNs?: number | null;
  readonly promptEvalDurationNs?: number | null;
  readonly evalDurationNs?: number | null;
  readonly promptEvalCount?: number | null;
  readonly evalCount?: number | null;
  readonly doneReason?: string | null;
  readonly finishReason?: string | null;
  readonly modelParameters?: {
    readonly temperature?: number;
    readonly numPredict?: number;
    readonly numCtx?: number;
    readonly keepAlive?: string;
  };
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly details?: unknown;
  } | null;
}

export type ModelInferenceTelemetryEvent = DomainEvent<ModelInferenceTelemetryPayload> & {
  readonly eventType: "model.inference.telemetry";
};

// ============================================================================
// Multi-Agent & Super Agent Orchestration Events (Phase 2)
// ============================================================================

export interface SubagentDecomposedPayload {
  readonly missionTaskId: string;
  readonly decompositionHash: string;
  readonly totalSubtasks: number;
  readonly subtaskIds: readonly string[];
}

export type SubagentDecomposedEvent = DomainEvent<SubagentDecomposedPayload> & {
  readonly eventType: "subagent.decomposed";
};

export interface SubagentSpawnedPayload {
  readonly missionTaskId: string;
  readonly subtaskId: string;
  readonly childTaskId: string;
  readonly childRunId: string;
  readonly role: string;
  readonly allowedCapabilities: readonly string[];
  readonly dependencies: readonly string[];
}

export type SubagentSpawnedEvent = DomainEvent<SubagentSpawnedPayload> & {
  readonly eventType: "subagent.spawned";
};

export interface SubagentCompletedPayload {
  readonly missionTaskId: string;
  readonly subtaskId: string;
  readonly childTaskId: string;
  readonly childRunId: string;
  readonly outcome: string;
}

export type SubagentCompletedEvent = DomainEvent<SubagentCompletedPayload> & {
  readonly eventType: "subagent.completed";
};

export interface SubagentVerifiedPayload {
  readonly missionTaskId: string;
  readonly subtaskId: string;
  readonly childTaskId: string;
  readonly childRunId: string;
  readonly verificationStatus: "VERIFIED";
  readonly evidenceCount: number;
}

export type SubagentVerifiedEvent = DomainEvent<SubagentVerifiedPayload> & {
  readonly eventType: "subagent.verified";
};

export interface SubagentRejectedPayload {
  readonly missionTaskId: string;
  readonly subtaskId: string;
  readonly childTaskId: string;
  readonly childRunId: string;
  readonly verificationStatus: "REJECTED" | "BLOCKED" | "UNVERIFIABLE";
  readonly reason: string;
}

export type SubagentRejectedEvent = DomainEvent<SubagentRejectedPayload> & {
  readonly eventType: "subagent.rejected";
};

export interface MissionSynthesizedPayload {
  readonly missionTaskId: string;
  readonly verdict: "SUCCESS" | "FAILED" | "BLOCKED" | "IN_PROGRESS";
  readonly totalSubtasks: number;
  readonly verifiedCount: number;
  readonly rejectedCount: number;
  readonly blockedCount: number;
  readonly summary: string;
}

export type MissionSynthesizedEvent = DomainEvent<MissionSynthesizedPayload> & {
  readonly eventType: "mission.synthesized";
};

export type AnyMultiAgentEvent =
  | SubagentDecomposedEvent
  | SubagentSpawnedEvent
  | SubagentCompletedEvent
  | SubagentVerifiedEvent
  | SubagentRejectedEvent
  | MissionSynthesizedEvent;

export type AnyRunEvent =
  | RunCreatedEvent
  | RunQueuedEvent
  | WorkerClaimedEvent
  | RunStartedEvent
  | VerificationStartedEvent
  | RunWaitingApprovalEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunTimedOutEvent
  | RunCancelledEvent
  | LeaseExpiredEvent
  | RunRecoveredEvent
  | PolicyEvaluatedEvent
  | EvidenceRecordedEvent
  | VerificationCompletedEvent
  | VerificationRejectedEvent
  | AnyWorkspaceEvent
  | AnyActionEvent
  | AnyAttemptEvent;


