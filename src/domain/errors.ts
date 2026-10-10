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
