import {
  InvalidStateTransitionError,
  LeaseLostError,
  TerminalStateError,
} from "./errors.js";
import {
  AnyRunEvent,
  LeaseExpiredEvent,
  RunCancelledEvent,
  RunCompletedEvent,
  RunFailedEvent,
  RunQueuedEvent,
  RunRecoveredEvent,
  RunStartedEvent,
  RunTimedOutEvent,
  RunWaitingApprovalEvent,
  VerificationStartedEvent,
  WorkerClaimedEvent,
} from "./events.js";
import { isTerminalState, RunSnapshot, RunStatus, validateRunInvariants } from "./invariants.js";

export type RunCommand =
  | { readonly type: "QUEUE"; readonly now: string }
  | {
      readonly type: "CLAIM";
      readonly workerId: string;
      readonly leaseId: string;
      readonly leaseExpiresAt: string;
      readonly now: string;
    }
  | {
      readonly type: "START";
      readonly workerId: string;
      readonly leaseId: string;
      readonly now: string;
    }
  | {
      readonly type: "COMPLETE";
      readonly workerId: string;
      readonly leaseId: string;
      readonly result: unknown;
      readonly now: string;
    }
  | {
      readonly type: "FAIL";
      readonly workerId?: string;
      readonly leaseId?: string;
      readonly error: unknown;
      readonly now: string;
    }
  | {
      readonly type: "TIMEOUT";
      readonly workerId?: string;
      readonly leaseId?: string;
      readonly reason?: string;
      readonly now: string;
    }
  | { readonly type: "CANCEL"; readonly reason?: string; readonly now: string }
  | { readonly type: "EXPIRE_LEASE"; readonly now: string }
  | { readonly type: "RETRY"; readonly now: string }
  | { readonly type: "FAIL_EXHAUSTED"; readonly error?: unknown; readonly now: string }
  | {
      readonly type: "START_VERIFICATION";
      readonly workerId: string;
      readonly leaseId: string;
      readonly now: string;
    }
  | {
      readonly type: "REQUEST_APPROVAL";
      readonly approvalId: string;
      readonly operation: string;
      readonly workerId?: string;
      readonly leaseId?: string;
      readonly now: string;
    }
  | {
      readonly type: "APPROVE_RESUME";
      readonly approvalId: string;
      readonly approver: string;
      readonly now: string;
    }
  | {
      readonly type: "REJECT_APPROVAL";
      readonly approvalId: string;
      readonly approver: string;
      readonly reason: string;
      readonly now: string;
    };

export interface TransitionResult {
  readonly nextSnapshot: RunSnapshot;
  readonly event: AnyRunEvent;
}

/**
 * Checks whether a given command is structurally legal from the current state.
 */
export function canTransition(status: RunStatus, command: RunCommand): boolean {
  if (isTerminalState(status)) {
    return false;
  }

  switch (command.type) {
    case "QUEUE":
      return status === "CREATED" || status === "RECOVERING";
    case "CLAIM":
      return status === "QUEUED" || status === "RECOVERING";
    case "START":
      return status === "LEASED";
    case "START_VERIFICATION":
      return status === "RUNNING";
    case "REQUEST_APPROVAL":
      return status === "RUNNING" || status === "VERIFYING";
    case "APPROVE_RESUME":
    case "REJECT_APPROVAL":
      return status === "WAITING_APPROVAL";
    case "COMPLETE":
      return status === "RUNNING" || status === "VERIFYING" || status === "RECOVERING";
    case "FAIL":
      if (status === "WAITING_APPROVAL") return true;
      return status === "RUNNING" || status === "VERIFYING" || status === "RECOVERING";
    case "TIMEOUT":
      return status === "LEASED" || status === "RUNNING" || status === "VERIFYING" || status === "WAITING_APPROVAL";
    case "CANCEL":
      return (
        status === "CREATED" ||
        status === "QUEUED" ||
        status === "LEASED" ||
        status === "RUNNING" ||
        status === "WAITING_APPROVAL" ||
        status === "RECOVERING"
      );
    case "EXPIRE_LEASE":
      return status === "LEASED" || status === "RUNNING" || status === "VERIFYING";
    case "RETRY":
      return status === "RECOVERING";
    case "FAIL_EXHAUSTED":
      return status === "RECOVERING";
    default:
      return false;
  }
}

/**
 * Pure domain state machine transition function.
 * Evaluates current snapshot and command, checks fencing tokens and invariants,
 * advances version by exactly 1, and produces the next snapshot and domain event.
 */
export function applyTransition(
  snapshot: RunSnapshot,
  command: RunCommand,
  eventIdGenerator: () => string = () => crypto.randomUUID()
): TransitionResult {
  if (isTerminalState(snapshot.status)) {
    throw new TerminalStateError(snapshot.status, command.type);
  }

  if (!canTransition(snapshot.status, command)) {
    throw new InvalidStateTransitionError(
      snapshot.status,
      command.type,
      `Command '${command.type}' is illegal from state '${snapshot.status}'`
    );
  }

  const nextVersion = snapshot.version + 1;
  const eventId = eventIdGenerator();

  switch (command.type) {
    case "QUEUE": {
      const nextSnapshot: RunSnapshot = {
        ...snapshot,
        status: "QUEUED",
        version: nextVersion,
        currentWorkerId: null,
        leaseId: null,
        leaseExpiresAt: null,
        updatedAt: command.now,
      };
      validateRunInvariants(nextSnapshot);

      const event: RunQueuedEvent = {
        eventId,
        runId: snapshot.runId,
        timestamp: command.now,
        eventType: "run.queued",
        schemaVersion: 1,
        producer: "domain.state_machine",
        payload: {
          attemptNumber: nextSnapshot.attemptCount,
        },
      };

      return { nextSnapshot, event };
    }

    case "CLAIM": {
      const nextSnapshot: RunSnapshot = {
        ...snapshot,
        status: "LEASED",
        version: nextVersion,
        currentWorkerId: command.workerId,
        leaseId: command.leaseId,
        leaseExpiresAt: command.leaseExpiresAt,
        updatedAt: command.now,
      };
      validateRunInvariants(nextSnapshot);

      const event: WorkerClaimedEvent = {
        eventId,
        runId: snapshot.runId,
        timestamp: command.now,
        eventType: "worker.claimed",
        schemaVersion: 1,
        producer: `worker:${command.workerId}`,
        payload: {
          workerId: command.workerId,
          leaseId: command.leaseId,
          leaseExpiresAt: command.leaseExpiresAt,
        },
      };

      return { nextSnapshot, event };
    }

    case "START": {
      // Fencing check: worker and lease must match active lease
      if (snapshot.currentWorkerId !== command.workerId || snapshot.leaseId !== command.leaseId) {
        throw new LeaseLostError(snapshot.runId, command.leaseId, snapshot.leaseId);
      }

      const nextSnapshot: RunSnapshot = {
        ...snapshot,
        status: "RUNNING",
        version: nextVersion,
        updatedAt: command.now,
      };
      validateRunInvariants(nextSnapshot);

      const event: RunStartedEvent = {
        eventId,
        runId: snapshot.runId,
        timestamp: command.now,
        eventType: "run.started",
        schemaVersion: 1,
        producer: `worker:${command.workerId}`,
        payload: {
          workerId: command.workerId,
          leaseId: command.leaseId,
        },
      };

      return { nextSnapshot, event };
    }

    case "START_VERIFICATION": {
      if (snapshot.currentWorkerId !== command.workerId || snapshot.leaseId !== command.leaseId) {
        throw new LeaseLostError(snapshot.runId, command.leaseId, snapshot.leaseId);
      }
      const nextSnapshot: RunSnapshot = {
        ...snapshot,
        status: "VERIFYING",
        version: nextVersion,
        updatedAt: command.now,
      };
      validateRunInvariants(nextSnapshot);
      const event: VerificationStartedEvent = {
        eventId,
        runId: snapshot.runId,
        timestamp: command.now,
        eventType: "verification.started",
        schemaVersion: 1,
        producer: `worker:${command.workerId}`,
        payload: { workerId: command.workerId, leaseId: command.leaseId },
      };
      return { nextSnapshot, event };
    }

    case "REQUEST_APPROVAL": {
      if (snapshot.currentWorkerId && snapshot.leaseId) {
        if (snapshot.currentWorkerId !== command.workerId || snapshot.leaseId !== command.leaseId) {
          throw new LeaseLostError(snapshot.runId, command.leaseId ?? "", snapshot.leaseId);
        }
      }
      const nextSnapshot: RunSnapshot = {
        ...snapshot,
        status: "WAITING_APPROVAL",
        version: nextVersion,
        currentWorkerId: null,
        leaseId: null,
        leaseExpiresAt: null,
        updatedAt: command.now,
      };
      validateRunInvariants(nextSnapshot);
      const event: RunWaitingApprovalEvent = {
        eventId,
        runId: snapshot.runId,
        timestamp: command.now,
        eventType: "run.waiting_approval",
        schemaVersion: 1,
        producer: command.workerId ? `worker:${command.workerId}` : "domain.governance",
        payload: {
          approvalId: command.approvalId,
          operation: command.operation,
          previousStatus: snapshot.status,
          workerId: snapshot.currentWorkerId,
          leaseId: snapshot.leaseId,
        },
      };
      return { nextSnapshot, event };
    }

    case "APPROVE_RESUME": {
      const nextSnapshot: RunSnapshot = {
        ...snapshot,
        status: "QUEUED",
        version: nextVersion,
        currentWorkerId: null,
        leaseId: null,
        leaseExpiresAt: null,
        updatedAt: command.now,
      };
      validateRunInvariants(nextSnapshot);
      const event: RunQueuedEvent = {
        eventId,
        runId: snapshot.runId,
        timestamp: command.now,
        eventType: "run.queued",
        schemaVersion: 1,
        producer: `operator:${command.approver}`,
        payload: { attemptNumber: nextSnapshot.attemptCount },
      };
      return { nextSnapshot, event };
    }

    case "REJECT_APPROVAL": {
      const nextSnapshot: RunSnapshot = {
        ...snapshot,
        status: "FAILED",
        version: nextVersion,
        errorPayload: {
          code: "APPROVAL_REJECTED",
          approvalId: command.approvalId,
          approver: command.approver,
          reason: command.reason,
        },
        currentWorkerId: null,
        leaseId: null,
        leaseExpiresAt: null,
        updatedAt: command.now,
      };
      validateRunInvariants(nextSnapshot);
      const event: RunFailedEvent = {
        eventId,
        runId: snapshot.runId,
        timestamp: command.now,
        eventType: "run.failed",
        schemaVersion: 1,
        producer: `operator:${command.approver}`,
        payload: {
          workerId: snapshot.currentWorkerId,
          leaseId: snapshot.leaseId,
          error: nextSnapshot.errorPayload,
          attemptNumber: snapshot.attemptCount,
          retriesExhausted: true,
        },
      };
      return { nextSnapshot, event };
    }

    case "COMPLETE": {
      // Fencing check: enforce worker fencing unless completing under coordinator/supervisor recovery authority
      const isRecoveryAuthority = command.workerId === "recovery" || command.workerId === "coordinator.recovery";
      if (!isRecoveryAuthority) {
        if (snapshot.currentWorkerId !== command.workerId || snapshot.leaseId !== command.leaseId) {
          throw new LeaseLostError(snapshot.runId, command.leaseId, snapshot.leaseId);
        }
      }

      const nextSnapshot: RunSnapshot = {
        ...snapshot,
        status: "COMPLETED",
        version: nextVersion,
        resultPayload: command.result,
        leaseExpiresAt: null, // Clear active lease on terminal state
        updatedAt: command.now,
      };
      validateRunInvariants(nextSnapshot);

      const event: RunCompletedEvent = {
        eventId,
        runId: snapshot.runId,
        timestamp: command.now,
        eventType: "run.completed",
        schemaVersion: 1,
        producer: isRecoveryAuthority ? "coordinator.recovery" : `worker:${command.workerId}`,
        payload: {
          workerId: snapshot.currentWorkerId ?? command.workerId,
          leaseId: snapshot.leaseId ?? command.leaseId,
          result: command.result,
        },
      };

      return { nextSnapshot, event };
    }

    case "FAIL": {
      if (snapshot.status === "RUNNING" || snapshot.status === "VERIFYING") {
        if (
          command.leaseId &&
          (snapshot.currentWorkerId !== command.workerId || snapshot.leaseId !== command.leaseId)
        ) {
          throw new LeaseLostError(snapshot.runId, command.leaseId, snapshot.leaseId);
        }
      }

      const nextSnapshot: RunSnapshot = {
        ...snapshot,
        status: "FAILED",
        version: nextVersion,
        errorPayload: command.error,
        leaseExpiresAt: null,
        updatedAt: command.now,
      };
      validateRunInvariants(nextSnapshot);

      const event: RunFailedEvent = {
        eventId,
        runId: snapshot.runId,
        timestamp: command.now,
        eventType: "run.failed",
        schemaVersion: 1,
        producer: command.workerId ? `worker:${command.workerId}` : "domain.supervisor",
        payload: {
          workerId: snapshot.currentWorkerId,
          leaseId: snapshot.leaseId,
          error: command.error,
          attemptNumber: snapshot.attemptCount,
          retriesExhausted: true,
        },
      };

      return { nextSnapshot, event };
    }

    case "TIMEOUT": {
      const nextSnapshot: RunSnapshot = {
        ...snapshot,
        status: "TIMED_OUT",
        version: nextVersion,
        errorPayload: { reason: command.reason ?? "Execution exceeded wall-clock timeout budget" },
        leaseExpiresAt: null,
        updatedAt: command.now,
      };
      validateRunInvariants(nextSnapshot);

      const event: RunTimedOutEvent = {
        eventId,
        runId: snapshot.runId,
        timestamp: command.now,
        eventType: "run.timed_out",
        schemaVersion: 1,
        producer: "domain.supervisor",
        payload: {
          workerId: snapshot.currentWorkerId,
          leaseId: snapshot.leaseId,
          timeoutMs: snapshot.timeoutMs,
          reason: command.reason,
        },
      };

      return { nextSnapshot, event };
    }

    case "CANCEL": {
      const nextSnapshot: RunSnapshot = {
        ...snapshot,
        status: "CANCELLED",
        version: nextVersion,
        errorPayload: { reason: command.reason ?? "Run cancelled by supervisor" },
        leaseExpiresAt: null,
        updatedAt: command.now,
      };
      validateRunInvariants(nextSnapshot);

      const event: RunCancelledEvent = {
        eventId,
        runId: snapshot.runId,
        timestamp: command.now,
        eventType: "run.cancelled",
        schemaVersion: 1,
        producer: "domain.supervisor",
        payload: {
          reason: command.reason,
        },
      };

      return { nextSnapshot, event };
    }

    case "EXPIRE_LEASE": {
      const nextSnapshot: RunSnapshot = {
        ...snapshot,
        status: "RECOVERING",
        version: nextVersion,
        leaseExpiresAt: null,
        updatedAt: command.now,
      };
      validateRunInvariants(nextSnapshot);

      const event: LeaseExpiredEvent = {
        eventId,
        runId: snapshot.runId,
        timestamp: command.now,
        eventType: "lease.expired",
        schemaVersion: 1,
        producer: "domain.sweeper",
        payload: {
          workerId: snapshot.currentWorkerId ?? "unknown",
          leaseId: snapshot.leaseId ?? "unknown",
          expiredAt: command.now,
        },
      };

      return { nextSnapshot, event };
    }

    case "RETRY": {
      if (snapshot.attemptCount >= snapshot.maxAttempts) {
        throw new InvalidStateTransitionError(
          snapshot.status,
          command.type,
          `Cannot retry run: attempt count ${snapshot.attemptCount} reached maximum allowed attempts ${snapshot.maxAttempts}`
        );
      }

      const nextSnapshot: RunSnapshot = {
        ...snapshot,
        status: "QUEUED",
        version: nextVersion,
        attemptCount: snapshot.attemptCount + 1,
        currentWorkerId: null,
        leaseId: null,
        leaseExpiresAt: null,
        updatedAt: command.now,
      };
      validateRunInvariants(nextSnapshot);

      const event: RunRecoveredEvent = {
        eventId,
        runId: snapshot.runId,
        timestamp: command.now,
        eventType: "run.recovered",
        schemaVersion: 1,
        producer: "domain.supervisor",
        payload: {
          nextAttemptNumber: nextSnapshot.attemptCount,
          maxAttempts: nextSnapshot.maxAttempts,
        },
      };

      return { nextSnapshot, event };
    }

    case "FAIL_EXHAUSTED": {
      const nextSnapshot: RunSnapshot = {
        ...snapshot,
        status: "FAILED",
        version: nextVersion,
        errorPayload: command.error ?? {
          code: "RETRIES_EXHAUSTED",
          message: `Run failed after exhausting all ${snapshot.maxAttempts} attempts`,
        },
        leaseExpiresAt: null,
        updatedAt: command.now,
      };
      validateRunInvariants(nextSnapshot);

      const event: RunFailedEvent = {
        eventId,
        runId: snapshot.runId,
        timestamp: command.now,
        eventType: "run.failed",
        schemaVersion: 1,
        producer: "domain.supervisor",
        payload: {
          workerId: snapshot.currentWorkerId,
          leaseId: snapshot.leaseId,
          error: nextSnapshot.errorPayload,
          attemptNumber: snapshot.attemptCount,
          retriesExhausted: true,
        },
      };

      return { nextSnapshot, event };
    }
  }
}
