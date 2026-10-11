/**
 * Pure Workspace Domain Aggregate and Lifecycle State Machine.
 *
 * Implements the isolated workspace domain model adhering strictly to:
 * - Hexagonal Architecture (Zero I/O or infrastructure dependencies)
 * - Deterministic, crash-recoverable state machine
 * - Distinct identity decoupling Workspace ID from Run ID
 * - Explicit separation of Governance Ceilings vs Provider Safety Limits
 */

import {
  InvalidWorkspaceError,
  InvalidWorkspaceTransitionError,
  WorkspaceLeaseError,
} from "./errors.js";
import {
  AnyWorkspaceEvent,
  WorkspaceCleaningEvent,
  WorkspaceDisposedEvent,
  WorkspaceFailedEvent,
  WorkspaceLeasedEvent,
  WorkspaceProvisioningEvent,
  WorkspaceReadyEvent,
} from "./events.js";

/**
 * Workspace Lifecycle States.
 */
export type WorkspaceStatus =
  | "PROVISIONING"
  | "READY"
  | "LEASED"
  | "CLEANING"
  | "DISPOSED"
  | "FAILED";

export const TERMINAL_WORKSPACE_STATUSES: ReadonlySet<WorkspaceStatus> = new Set([
  "DISPOSED",
  "FAILED",
]);

export function isTerminalWorkspaceStatus(status: WorkspaceStatus): boolean {
  return TERMINAL_WORKSPACE_STATUSES.has(status);
}

/**
 * Source specification for repository acquisition.
 */
export interface RepositorySource {
  readonly type: "git" | "archive" | "local_template";
  readonly location: string;
  readonly revision: string; // Exact immutable Git commit SHA or archive hash
}

/**
 * Pure specification required to allocate a workspace.
 */
export interface WorkspaceSpec {
  readonly workspaceId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly repositorySource?: RepositorySource;
  readonly maxWorkspaceBytes: number; // Provider safety limit (e.g. 500 MB)
  readonly maxFileSizeBytes: number;    // Effective limit: rejected if > contract maxOutputBytes
}

/**
 * Immutable snapshot representing complete state of a workspace.
 */
export interface WorkspaceSnapshot {
  readonly workspaceId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly status: WorkspaceStatus;
  readonly spec: WorkspaceSpec;
  readonly assignedWorkerId: string | null;
  readonly leaseId: string | null;
  readonly leasedAt: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Transition commands dispatched to the workspace state machine.
 */
export type WorkspaceCommand =
  | {
      readonly type: "MARK_READY";
      readonly now: string;
      readonly hostPath?: string;
      readonly containerMountPath?: string;
    }
  | {
      readonly type: "CLAIM_LEASE";
      readonly workerId: string;
      readonly leaseId: string;
      readonly now: string;
    }
  | {
      readonly type: "START_CLEANING";
      readonly reason?: string;
      readonly now: string;
      readonly workerId?: string;
      readonly leaseId?: string;
    }
  | {
      readonly type: "MARK_DISPOSED";
      readonly now: string;
    }
  | {
      readonly type: "FAIL";
      readonly errorMessage: string;
      readonly now: string;
    };

/**
 * Validates a WorkspaceSpec and returns a list of violation messages.
 */
export function getWorkspaceSpecViolations(spec: unknown): string[] {
  const violations: string[] = [];

  if (!spec || typeof spec !== "object") {
    return ["spec must be a valid object"];
  }

  const s = spec as Record<string, unknown>;

  if (typeof s.workspaceId !== "string" || s.workspaceId.trim().length === 0) {
    violations.push("workspaceId must be a non-empty string");
  }

  if (typeof s.runId !== "string" || s.runId.trim().length === 0) {
    violations.push("runId must be a non-empty string");
  }

  if (typeof s.taskId !== "string" || s.taskId.trim().length === 0) {
    violations.push("taskId must be a non-empty string");
  }

  if (
    typeof s.maxWorkspaceBytes !== "number" ||
    !Number.isInteger(s.maxWorkspaceBytes) ||
    s.maxWorkspaceBytes <= 0
  ) {
    violations.push("maxWorkspaceBytes must be a positive integer");
  }

  if (
    typeof s.maxFileSizeBytes !== "number" ||
    !Number.isInteger(s.maxFileSizeBytes) ||
    s.maxFileSizeBytes <= 0
  ) {
    violations.push("maxFileSizeBytes must be a positive integer");
  }

  if (s.repositorySource !== undefined && s.repositorySource !== null) {
    if (typeof s.repositorySource !== "object") {
      violations.push("repositorySource must be an object if specified");
    } else {
      const repo = s.repositorySource as Record<string, unknown>;
      if (
        repo.type !== "git" &&
        repo.type !== "archive" &&
        repo.type !== "local_template"
      ) {
        violations.push("repositorySource.type must be 'git', 'archive', or 'local_template'");
      }
      if (typeof repo.location !== "string" || repo.location.trim().length === 0) {
        violations.push("repositorySource.location must be a non-empty string");
      }
      if (typeof repo.revision !== "string" || repo.revision.trim().length === 0) {
        violations.push("repositorySource.revision must be a non-empty string");
      }
    }
  }

  return violations;
}

/**
 * Validates complete invariant integrity for a WorkspaceSnapshot.
 * @throws {InvalidWorkspaceError} on invariant violation.
 */
export function validateWorkspaceInvariants(snapshot: WorkspaceSnapshot): void {
  const violations = getWorkspaceSpecViolations(snapshot.spec);

  if (
    snapshot.status !== "PROVISIONING" &&
    snapshot.status !== "READY" &&
    snapshot.status !== "LEASED" &&
    snapshot.status !== "CLEANING" &&
    snapshot.status !== "DISPOSED" &&
    snapshot.status !== "FAILED"
  ) {
    violations.push(`Invalid status: '${String(snapshot.status)}'`);
  }

  if (snapshot.status === "LEASED") {
    if (!snapshot.assignedWorkerId || snapshot.assignedWorkerId.trim().length === 0) {
      violations.push("assignedWorkerId must be present when workspace is LEASED");
    }
    if (!snapshot.leaseId || snapshot.leaseId.trim().length === 0) {
      violations.push("leaseId must be present when workspace is LEASED");
    }
  }

  if (snapshot.status === "FAILED") {
    if (!snapshot.errorMessage || snapshot.errorMessage.trim().length === 0) {
      violations.push("errorMessage must be present when workspace is in FAILED state");
    }
  }

  if (violations.length > 0) {
    throw new InvalidWorkspaceError(snapshot.workspaceId, violations);
  }
}

/**
 * Pure transition engine for Workspace lifecycle state machine.
 */
export function applyWorkspaceTransition(
  current: WorkspaceSnapshot,
  command: WorkspaceCommand,
  eventIdGenerator: () => string = () => crypto.randomUUID()
): { nextSnapshot: WorkspaceSnapshot; event: AnyWorkspaceEvent } {
  // Terminal state protection
  if (isTerminalWorkspaceStatus(current.status)) {
    throw new InvalidWorkspaceTransitionError(
      current.workspaceId,
      current.status,
      command.type,
      "Cannot transition from terminal state"
    );
  }

  const now = command.now;
  const eventId = eventIdGenerator();

  switch (command.type) {
    case "MARK_READY": {
      if (current.status !== "PROVISIONING") {
        throw new InvalidWorkspaceTransitionError(
          current.workspaceId,
          current.status,
          "READY",
          "Workspace can only transition to READY from PROVISIONING"
        );
      }

      const nextSnapshot: WorkspaceSnapshot = {
        ...current,
        status: "READY",
        updatedAt: now,
      };

      validateWorkspaceInvariants(nextSnapshot);

      const event: WorkspaceReadyEvent = {
        eventId,
        runId: current.runId,
        timestamp: now,
        eventType: "workspace.ready",
        schemaVersion: 1,
        producer: "domain.workspace",
        payload: {
          workspaceId: current.workspaceId,
          runId: current.runId,
          ...(command.hostPath ? { hostPath: command.hostPath } : {}),
          ...(command.containerMountPath ? { containerMountPath: command.containerMountPath } : {}),
        },
      };

      return { nextSnapshot, event };
    }

    case "CLAIM_LEASE": {
      if (current.status !== "READY") {
        throw new InvalidWorkspaceTransitionError(
          current.workspaceId,
          current.status,
          "LEASED",
          "Workspace can only be claimed/leased from READY state"
        );
      }

      if (!command.workerId || command.workerId.trim().length === 0) {
        throw new WorkspaceLeaseError(current.workspaceId, "workerId must be non-empty");
      }

      if (!command.leaseId || command.leaseId.trim().length === 0) {
        throw new WorkspaceLeaseError(current.workspaceId, "leaseId must be non-empty");
      }

      const nextSnapshot: WorkspaceSnapshot = {
        ...current,
        status: "LEASED",
        assignedWorkerId: command.workerId,
        leaseId: command.leaseId,
        leasedAt: now,
        updatedAt: now,
      };

      validateWorkspaceInvariants(nextSnapshot);

      const event: WorkspaceLeasedEvent = {
        eventId,
        runId: current.runId,
        timestamp: now,
        eventType: "workspace.leased",
        schemaVersion: 1,
        producer: "domain.workspace",
        payload: {
          workspaceId: current.workspaceId,
          runId: current.runId,
          workerId: command.workerId,
          leaseId: command.leaseId,
        },
      };

      return { nextSnapshot, event };
    }

    case "START_CLEANING": {
      if (current.status !== "READY" && current.status !== "LEASED") {
        throw new InvalidWorkspaceTransitionError(
          current.workspaceId,
          current.status,
          "CLEANING",
          "Workspace can only transition to CLEANING from READY or LEASED"
        );
      }

      // Fencing check if active lease exists
      if (current.status === "LEASED") {
        if (command.workerId && command.workerId !== current.assignedWorkerId) {
          throw new WorkspaceLeaseError(
            current.workspaceId,
            `Worker mismatch: active lease held by '${current.assignedWorkerId}', attempted by '${command.workerId}'`
          );
        }
        if (command.leaseId && command.leaseId !== current.leaseId) {
          throw new WorkspaceLeaseError(
            current.workspaceId,
            `Lease fencing token mismatch: active lease '${current.leaseId}', attempted with '${command.leaseId}'`
          );
        }
      }

      const nextSnapshot: WorkspaceSnapshot = {
        ...current,
        status: "CLEANING",
        assignedWorkerId: null,
        leaseId: null,
        leasedAt: null,
        updatedAt: now,
      };

      validateWorkspaceInvariants(nextSnapshot);

      const event: WorkspaceCleaningEvent = {
        eventId,
        runId: current.runId,
        timestamp: now,
        eventType: "workspace.cleaning",
        schemaVersion: 1,
        producer: "domain.workspace",
        payload: {
          workspaceId: current.workspaceId,
          runId: current.runId,
          ...(command.reason ? { reason: command.reason } : {}),
        },
      };

      return { nextSnapshot, event };
    }

    case "MARK_DISPOSED": {
      if (current.status !== "CLEANING") {
        throw new InvalidWorkspaceTransitionError(
          current.workspaceId,
          current.status,
          "DISPOSED",
          "Workspace can only transition to DISPOSED from CLEANING"
        );
      }

      const nextSnapshot: WorkspaceSnapshot = {
        ...current,
        status: "DISPOSED",
        updatedAt: now,
      };

      validateWorkspaceInvariants(nextSnapshot);

      const event: WorkspaceDisposedEvent = {
        eventId,
        runId: current.runId,
        timestamp: now,
        eventType: "workspace.disposed",
        schemaVersion: 1,
        producer: "domain.workspace",
        payload: {
          workspaceId: current.workspaceId,
          runId: current.runId,
        },
      };

      return { nextSnapshot, event };
    }

    case "FAIL": {
      const nextSnapshot: WorkspaceSnapshot = {
        ...current,
        status: "FAILED",
        errorMessage: command.errorMessage,
        updatedAt: now,
      };

      validateWorkspaceInvariants(nextSnapshot);

      const event: WorkspaceFailedEvent = {
        eventId,
        runId: current.runId,
        timestamp: now,
        eventType: "workspace.failed",
        schemaVersion: 1,
        producer: "domain.workspace",
        payload: {
          workspaceId: current.workspaceId,
          runId: current.runId,
          fromState: current.status,
          errorMessage: command.errorMessage,
        },
      };

      return { nextSnapshot, event };
    }
  }
}

/**
 * Parameters to create a new Workspace aggregate.
 */
export interface CreateWorkspaceParams {
  readonly workspaceId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly repositorySource?: RepositorySource;
  readonly maxWorkspaceBytes?: number; // Defaults to provider safety limit (500 MB)
  readonly maxFileSizeBytes?: number;    // Defaults to 10 MB
  readonly now?: string;
  readonly eventIdGenerator?: () => string;
}

/**
 * Workspace Aggregate Root.
 */
export class Workspace {
  private _snapshot: WorkspaceSnapshot;
  private readonly _eventIdGenerator: () => string;

  private constructor(snapshot: WorkspaceSnapshot, eventIdGenerator: () => string) {
    validateWorkspaceInvariants(snapshot);
    this._snapshot = Object.freeze({
      ...snapshot,
      spec: Object.freeze({ ...snapshot.spec }),
    });
    this._eventIdGenerator = eventIdGenerator;
  }

  /**
   * Factory method to create a new Workspace aggregate in PROVISIONING state.
   */
  static create(params: CreateWorkspaceParams): {
    workspace: Workspace;
    event: WorkspaceProvisioningEvent;
  } {
    const now = params.now ?? new Date().toISOString();
    const eventIdGenerator = params.eventIdGenerator ?? (() => crypto.randomUUID());
    const maxWorkspaceBytes = params.maxWorkspaceBytes ?? 500 * 1024 * 1024; // 500 MB
    const maxFileSizeBytes = params.maxFileSizeBytes ?? 10 * 1024 * 1024;    // 10 MB

    const spec: WorkspaceSpec = {
      workspaceId: params.workspaceId,
      runId: params.runId,
      taskId: params.taskId,
      ...(params.repositorySource ? { repositorySource: { ...params.repositorySource } } : {}),
      maxWorkspaceBytes,
      maxFileSizeBytes,
    };

    const snapshot: WorkspaceSnapshot = {
      workspaceId: params.workspaceId,
      runId: params.runId,
      taskId: params.taskId,
      status: "PROVISIONING",
      spec,
      assignedWorkerId: null,
      leaseId: null,
      leasedAt: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };

    validateWorkspaceInvariants(snapshot);

    const event: WorkspaceProvisioningEvent = {
      eventId: eventIdGenerator(),
      runId: params.runId,
      timestamp: now,
      eventType: "workspace.provisioning",
      schemaVersion: 1,
      producer: "domain.workspace",
      payload: {
        workspaceId: params.workspaceId,
        runId: params.runId,
        taskId: params.taskId,
        ...(params.repositorySource ? { repositorySource: { ...params.repositorySource } } : {}),
        maxWorkspaceBytes,
      },
    };

    const workspace = new Workspace(snapshot, eventIdGenerator);
    return { workspace, event };
  }

  /**
   * Reconstitutes an existing Workspace aggregate from a snapshot.
   */
  static reconstitute(
    snapshot: WorkspaceSnapshot,
    eventIdGenerator: () => string = () => crypto.randomUUID()
  ): Workspace {
    return new Workspace(snapshot, eventIdGenerator);
  }

  get snapshot(): WorkspaceSnapshot {
    return this._snapshot;
  }

  get workspaceId(): string {
    return this._snapshot.workspaceId;
  }

  get runId(): string {
    return this._snapshot.runId;
  }

  get taskId(): string {
    return this._snapshot.taskId;
  }

  get status(): WorkspaceStatus {
    return this._snapshot.status;
  }

  get spec(): WorkspaceSpec {
    return this._snapshot.spec;
  }

  get assignedWorkerId(): string | null {
    return this._snapshot.assignedWorkerId;
  }

  get leaseId(): string | null {
    return this._snapshot.leaseId;
  }

  get leasedAt(): string | null {
    return this._snapshot.leasedAt;
  }

  get errorMessage(): string | null {
    return this._snapshot.errorMessage;
  }

  get createdAt(): string {
    return this._snapshot.createdAt;
  }

  get updatedAt(): string {
    return this._snapshot.updatedAt;
  }

  private executeCommand<TEvent extends AnyWorkspaceEvent>(command: WorkspaceCommand): TEvent {
    const result = applyWorkspaceTransition(this._snapshot, command, this._eventIdGenerator);
    this._snapshot = Object.freeze({
      ...result.nextSnapshot,
      spec: Object.freeze({ ...result.nextSnapshot.spec }),
    });
    return result.event as TEvent;
  }

  markReady(params?: {
    now?: string;
    hostPath?: string;
    containerMountPath?: string;
  }): WorkspaceReadyEvent {
    return this.executeCommand<WorkspaceReadyEvent>({
      type: "MARK_READY",
      now: params?.now ?? new Date().toISOString(),
      ...(params?.hostPath ? { hostPath: params.hostPath } : {}),
      ...(params?.containerMountPath ? { containerMountPath: params.containerMountPath } : {}),
    });
  }

  claimLease(params: {
    workerId: string;
    leaseId: string;
    now?: string;
  }): WorkspaceLeasedEvent {
    return this.executeCommand<WorkspaceLeasedEvent>({
      type: "CLAIM_LEASE",
      workerId: params.workerId,
      leaseId: params.leaseId,
      now: params.now ?? new Date().toISOString(),
    });
  }

  startCleaning(params?: {
    reason?: string;
    now?: string;
    workerId?: string;
    leaseId?: string;
  }): WorkspaceCleaningEvent {
    return this.executeCommand<WorkspaceCleaningEvent>({
      type: "START_CLEANING",
      reason: params?.reason,
      workerId: params?.workerId,
      leaseId: params?.leaseId,
      now: params?.now ?? new Date().toISOString(),
    });
  }

  markDisposed(params?: { now?: string }): WorkspaceDisposedEvent {
    return this.executeCommand<WorkspaceDisposedEvent>({
      type: "MARK_DISPOSED",
      now: params?.now ?? new Date().toISOString(),
    });
  }

  markFailed(params: { errorMessage: string; now?: string }): WorkspaceFailedEvent {
    return this.executeCommand<WorkspaceFailedEvent>({
      type: "FAIL",
      errorMessage: params.errorMessage,
      now: params?.now ?? new Date().toISOString(),
    });
  }
}
