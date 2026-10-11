/**
 * Domain-level error hierarchy for Emerald Agent Fabric.
 * These communicate machine-actionable domain invariant and state violations.
 */

export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidStateTransitionError extends DomainError {
  readonly code = "INVALID_STATE_TRANSITION";

  constructor(
    readonly fromState: string,
    readonly command: string,
    readonly reason?: string
  ) {
    super(
      `Cannot execute command '${command}' from state '${fromState}'${
        reason ? `: ${reason}` : ""
      }`
    );
  }
}

export class TerminalStateError extends DomainError {
  readonly code = "TERMINAL_STATE_MUTATION";

  constructor(
    readonly terminalState: string,
    readonly attemptedCommand: string
  ) {
    super(
      `Run is in terminal state '${terminalState}' and cannot process command '${attemptedCommand}'`
    );
  }
}

export class VersionConflictError extends DomainError {
  readonly code = "VERSION_CONFLICT";

  constructor(
    readonly runId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number
  ) {
    super(
      `Version conflict on run '${runId}': expected ${expectedVersion}, got ${actualVersion}`
    );
  }
}

export class LeaseLostError extends DomainError {
  readonly code = "LEASE_LOST";

  constructor(
    readonly runId: string,
    readonly expectedLeaseId: string,
    readonly actualLeaseId: string | null
  ) {
    super(
      `Fencing check failed for run '${runId}': worker presented lease '${expectedLeaseId}', but active lease is '${actualLeaseId ?? "none"}'`
    );
  }
}

export class InvalidRunError extends DomainError {
  readonly code = "INVALID_RUN_INVARIANT";

  constructor(
    readonly runId: string,
    readonly violations: readonly string[]
  ) {
    super(
      `Invariant violation(s) for run '${runId}': ${violations.join("; ")}`
    );
  }
}

export class InvalidMissionContractError extends DomainError {
  readonly code = "INVALID_MISSION_CONTRACT";

  constructor(
    readonly reason: string,
    readonly violations?: readonly string[]
  ) {
    super(
      `Invalid mission contract: ${reason}${
        violations && violations.length > 0 ? ` (${violations.join("; ")})` : ""
      }`
    );
  }
}

export class InvalidContractBindingError extends DomainError {
  readonly code = "INVALID_CONTRACT_BINDING";

  constructor(
    readonly reason: string,
    readonly violations?: readonly string[]
  ) {
    super(
      `Invalid contract binding: ${reason}${
        violations && violations.length > 0 ? ` (${violations.join("; ")})` : ""
      }`
    );
  }
}

export class ContractIntegrityError extends DomainError {
  readonly code = "CONTRACT_INTEGRITY_MISMATCH";

  constructor(
    readonly runId: string,
    readonly expectedHash: string,
    readonly actualHash: string
  ) {
    super(
      `Content hash integrity mismatch for run '${runId}': expected '${expectedHash}', got '${actualHash}'`
    );
  }
}

export class NoActiveMissionContractError extends DomainError {
  readonly code = "NO_ACTIVE_MISSION_CONTRACT";

  constructor(readonly taskId: string) {
    super(`No ACTIVE mission contract found for task '${taskId}'`);
  }
}

export class AmbiguousContractAuthorityError extends DomainError {
  readonly code = "AMBIGUOUS_CONTRACT_AUTHORITY";

  constructor(readonly taskId: string, readonly activeContractIds: readonly string[]) {
    super(
      `Multiple ACTIVE mission contracts found for task '${taskId}': ${activeContractIds.join(", ")}. Contract authority is ambiguous.`
    );
  }
}

export class MissionContractTaskMismatchError extends DomainError {
  readonly code = "MISSION_CONTRACT_TASK_MISMATCH";

  constructor(
    readonly expectedTaskId: string,
    readonly actualTaskId: string,
    readonly contractId: string
  ) {
    super(
      `Mission contract '${contractId}' belongs to task '${actualTaskId}', not requested task '${expectedTaskId}'`
    );
  }
}

export class ResourceLimitExceededError extends DomainError {
  readonly code = "RESOURCE_LIMIT_EXCEEDED";

  constructor(
    readonly limitName: string,
    readonly requestedValue: number,
    readonly ceilingValue: number
  ) {
    super(
      `Requested ${limitName} (${requestedValue}) exceeds contract ceiling (${ceilingValue})`
    );
  }
}

export class MissingBoundContractError extends DomainError {
  readonly code = "MISSING_BOUND_CONTRACT";

  constructor(
    readonly contractId: string,
    readonly version?: number,
    message?: string
  ) {
    super(
      message ??
        `Exact bound MissionContract ('${contractId}', v${version ?? "unknown"}) not found`
    );
  }
}

export class ContractNotActiveError extends DomainError {
  readonly code = "CONTRACT_NOT_ACTIVE";

  constructor(
    readonly contractId: string,
    readonly version: number,
    readonly status: string
  ) {
    super(
      `Bound MissionContract '${contractId}' v${version} is not ACTIVE (status: '${status}')`
    );
  }
}

export class ContractRevokedError extends DomainError {
  readonly code = "CONTRACT_REVOKED";

  constructor(
    readonly contractId: string,
    readonly version: number,
    readonly revocationReason?: string | null
  ) {
    super(
      `Bound MissionContract '${contractId}' v${version} has been REVOKED${
        revocationReason ? `: ${revocationReason}` : ""
      }`
    );
  }
}

export class EphemeralOverrideRejectedError extends DomainError {
  readonly code = "EPHEMERAL_OVERRIDE_REJECTED";

  constructor(readonly reason: string) {
    super(
      `Ephemeral worker options are rejected for governed Runs: ${reason}`
    );
  }
}

export class UnboundRunExecutionDisallowedError extends DomainError {
  readonly code = "UNBOUND_RUN_EXECUTION_DISALLOWED";

  constructor(readonly runId: string) {
    super(
      `Execution or recovery of unbound legacy Run '${runId}' is disallowed. Governed execution requires an authoritative MissionContract binding.`
    );
  }
}

export class InvalidWorkspaceError extends DomainError {
  readonly code = "INVALID_WORKSPACE";

  constructor(
    readonly workspaceId: string,
    readonly violations: readonly string[]
  ) {
    super(
      `Workspace '${workspaceId}' invariant violation(s): ${violations.join("; ")}`
    );
  }
}

export class InvalidWorkspaceTransitionError extends DomainError {
  readonly code = "INVALID_WORKSPACE_TRANSITION";

  constructor(
    readonly workspaceId: string,
    readonly fromState: string,
    readonly toState: string,
    readonly reason?: string
  ) {
    super(
      `Cannot transition workspace '${workspaceId}' from '${fromState}' to '${toState}'${
        reason ? `: ${reason}` : ""
      }`
    );
  }
}

export class WorkspaceStateError extends DomainError {
  readonly code = "WORKSPACE_STATE_ERROR";

  constructor(
    readonly workspaceId: string,
    readonly currentState: string,
    readonly requiredState: string,
    readonly operation?: string
  ) {
    super(
      `Workspace '${workspaceId}' is in state '${currentState}' but '${requiredState}' is required${
        operation ? ` for operation '${operation}'` : ""
      }`
    );
  }
}

export class WorkspaceLeaseError extends DomainError {
  readonly code = "WORKSPACE_LEASE_ERROR";

  constructor(
    readonly workspaceId: string,
    readonly reason: string
  ) {
    super(`Workspace lease error for '${workspaceId}': ${reason}`);
  }
}

export class InvalidWorkspacePathError extends DomainError {
  readonly code = "INVALID_WORKSPACE_PATH";

  constructor(
    readonly path: string,
    readonly reason: string
  ) {
    super(`Invalid workspace path '${path}': ${reason}`);
  }
}

export class WorkspacePathOutsideBoundaryError extends DomainError {
  readonly code = "WORKSPACE_PATH_OUTSIDE_BOUNDARY";

  constructor(
    readonly path: string,
    readonly reason?: string
  ) {
    super(
      `Path '${path}' resolves outside workspace boundary${
        reason ? `: ${reason}` : ""
      }`
    );
  }
}



