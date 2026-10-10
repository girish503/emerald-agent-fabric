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

export type AnyRunEvent =
  | RunCreatedEvent
  | RunQueuedEvent
  | WorkerClaimedEvent
  | RunStartedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunTimedOutEvent
  | RunCancelledEvent
  | LeaseExpiredEvent
  | RunRecoveredEvent
  | PolicyEvaluatedEvent
  | EvidenceRecordedEvent
  | VerificationCompletedEvent;

