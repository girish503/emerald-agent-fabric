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

  get resource(): string {
    return this.limitName;
  }

  get requested(): number {
    return this.requestedValue;
  }

  get ceiling(): number {
    return this.ceilingValue;
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
  readonly code: string = "CONTRACT_NOT_ACTIVE";

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

export class ContractRevokedError extends ContractNotActiveError {
  override readonly code = "CONTRACT_REVOKED";

  constructor(
    contractId: string,
    version: number,
    readonly revocationReason?: string | null
  ) {
    super(contractId, version, "REVOKED");
    this.message = `Bound MissionContract '${contractId}' v${version} has been REVOKED${
      revocationReason ? `: ${revocationReason}` : ""
    }`;
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

// ============================================================================
// Tool Error Taxonomy (Phase 4 / Task 4.1)
// ============================================================================

export const TOOL_ERROR_CODES = [
  "TOOL_NOT_FOUND",
  "INVALID_TOOL_INPUT",
  "CAPABILITY_DENIED",
  "WORKSPACE_BOUNDARY_VIOLATION",
  "TOOL_TIMEOUT",
  "TOOL_OUTPUT_LIMIT_EXCEEDED",
  "TOOL_EXECUTION_FAILED",
  "TOOL_CANCELLED",
  "TOOL_PROVIDER_UNAVAILABLE",
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export type ToolErrorCategory =
  | "validation"
  | "authorization"
  | "workspace"
  | "resource"
  | "execution"
  | "cancellation"
  | "provider";

export const TOOL_ERROR_CATEGORY_MAP: Readonly<Record<ToolErrorCode, ToolErrorCategory>> = {
  TOOL_NOT_FOUND: "provider",
  INVALID_TOOL_INPUT: "validation",
  CAPABILITY_DENIED: "authorization",
  WORKSPACE_BOUNDARY_VIOLATION: "workspace",
  TOOL_TIMEOUT: "resource",
  TOOL_OUTPUT_LIMIT_EXCEEDED: "resource",
  TOOL_EXECUTION_FAILED: "execution",
  TOOL_CANCELLED: "cancellation",
  TOOL_PROVIDER_UNAVAILABLE: "provider",
};

export interface ToolErrorPayload {
  readonly code: ToolErrorCode;
  readonly category: ToolErrorCategory;
  readonly message: string;
  readonly details?: unknown;
}

export abstract class ToolDomainError extends DomainError {
  abstract override readonly code: ToolErrorCode;
  abstract readonly category: ToolErrorCategory;
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.details = details;
  }

  toPayload(): ToolErrorPayload {
    return {
      code: this.code,
      category: this.category,
      message: this.message,
      details: this.details,
    };
  }
}

export class ToolNotFoundError extends ToolDomainError {
  readonly code = "TOOL_NOT_FOUND";
  readonly category = "provider";

  constructor(readonly toolName: string) {
    super(`Tool '${toolName}' is not registered`);
  }
}

export class InvalidToolInputError extends ToolDomainError {
  readonly code = "INVALID_TOOL_INPUT";
  readonly category = "validation";

  constructor(
    readonly toolName: string,
    readonly reason: string,
    details?: unknown
  ) {
    super(`Invalid input for tool '${toolName}': ${reason}`, details);
  }
}

export class ToolCapabilityDeniedError extends ToolDomainError {
  readonly code = "CAPABILITY_DENIED";
  readonly category = "authorization";

  constructor(
    readonly toolName: string,
    readonly capability: string,
    readonly reason?: string
  ) {
    super(
      `Capability '${capability}' required by tool '${toolName}' was denied${
        reason ? `: ${reason}` : ""
      }`
    );
  }
}

export class ToolWorkspaceBoundaryViolationError extends ToolDomainError {
  readonly code = "WORKSPACE_BOUNDARY_VIOLATION";
  readonly category = "workspace";

  constructor(
    readonly toolName: string,
    readonly path: string,
    readonly reason?: string
  ) {
    super(
      `Path '${path}' in tool '${toolName}' violates workspace boundary${
        reason ? `: ${reason}` : ""
      }`
    );
  }
}

export class ToolTimeoutError extends ToolDomainError {
  readonly code = "TOOL_TIMEOUT";
  readonly category = "resource";

  constructor(
    readonly toolName: string,
    readonly timeoutMs: number
  ) {
    super(`Tool '${toolName}' timed out after ${timeoutMs}ms`);
  }
}

export class ToolOutputLimitExceededError extends ToolDomainError {
  readonly code = "TOOL_OUTPUT_LIMIT_EXCEEDED";
  readonly category = "resource";

  constructor(
    readonly toolName: string,
    readonly maxBytes: number,
    readonly actualBytes?: number
  ) {
    super(
      `Tool '${toolName}' exceeded output limit of ${maxBytes} bytes${
        actualBytes ? ` (got ${actualBytes} bytes)` : ""
      }`
    );
  }
}

export class ToolExecutionFailedError extends ToolDomainError {
  readonly code = "TOOL_EXECUTION_FAILED";
  readonly category = "execution";

  constructor(
    readonly toolName: string,
    message: string,
    details?: unknown
  ) {
    super(`Tool '${toolName}' execution failed: ${message}`, details);
  }
}

export class ToolCancelledError extends ToolDomainError {
  readonly code = "TOOL_CANCELLED";
  readonly category = "cancellation";

  constructor(
    readonly toolName: string,
    readonly reason?: string
  ) {
    super(`Tool '${toolName}' was cancelled${reason ? `: ${reason}` : ""}`);
  }
}

export class ToolProviderUnavailableError extends ToolDomainError {
  readonly code = "TOOL_PROVIDER_UNAVAILABLE";
  readonly category = "provider";

  constructor(
    readonly toolName: string,
    message: string
  ) {
    super(`Provider unavailable for tool '${toolName}': ${message}`);
  }
}

export class InvalidActionError extends DomainError {
  readonly code = "INVALID_ACTION_INVARIANT";

  constructor(
    readonly actionId: string,
    readonly violations: readonly string[]
  ) {
    super(
      `Invariant violation(s) for action '${actionId}': ${violations.join("; ")}`
    );
  }
}

export class InvalidAttemptError extends DomainError {
  readonly code = "INVALID_ATTEMPT_INVARIANT";

  constructor(
    readonly attemptId: string,
    readonly violations: readonly string[]
  ) {
    super(
      `Invariant violation(s) for attempt '${attemptId}': ${violations.join("; ")}`
    );
  }
}

export class InvalidActionTransitionError extends DomainError {
  readonly code = "INVALID_ACTION_STATE_TRANSITION";

  constructor(
    readonly fromState: string,
    readonly command: string,
    readonly reason?: string
  ) {
    super(
      `Cannot execute command '${command}' on action from state '${fromState}'${
        reason ? `: ${reason}` : ""
      }`
    );
  }
}

export class InvalidAttemptTransitionError extends DomainError {
  readonly code = "INVALID_ATTEMPT_STATE_TRANSITION";

  constructor(
    readonly fromState: string,
    readonly command: string,
    readonly reason?: string
  ) {
    super(
      `Cannot execute command '${command}' on attempt from state '${fromState}'${
        reason ? `: ${reason}` : ""
      }`
    );
  }
}

export class DuplicateActionSequenceError extends DomainError {
  readonly code = "DUPLICATE_ACTION_SEQUENCE";

  constructor(readonly runId: string, readonly sequenceNumber: number) {
    super(`Action with sequence number ${sequenceNumber} already exists for run '${runId}'`);
  }
}

export class DuplicateAttemptError extends DomainError {
  readonly code = "DUPLICATE_ATTEMPT_NUMBER";

  constructor(readonly actionId: string, readonly attemptNumber: number) {
    super(`Attempt number ${attemptNumber} already exists for action '${actionId}'`);
  }
}

export class DuplicateAttemptTokenError extends DomainError {
  readonly code = "DUPLICATE_ATTEMPT_TOKEN";

  constructor(readonly token: string) {
    super(`Attempt with idempotency token '${token}' already exists`);
  }
}

export class ActiveAttemptConflictError extends DomainError {
  readonly code = "ACTIVE_ATTEMPT_CONFLICT";

  constructor(readonly actionId: string) {
    super(`Action '${actionId}' already has an active attempt in non-terminal state`);
  }
}

export class ActionNotFoundError extends DomainError {
  readonly code = "ACTION_NOT_FOUND";

  constructor(readonly actionId: string) {
    super(`Action '${actionId}' not found`);
  }
}

export class AttemptNotFoundError extends DomainError {
  readonly code = "ATTEMPT_NOT_FOUND";

  constructor(readonly attemptId: string) {
    super(`Attempt '${attemptId}' not found`);
  }
}

export class PayloadLimitExceededError extends DomainError {
  readonly code = "PAYLOAD_LIMIT_EXCEEDED";

  constructor(
    readonly fieldName: string,
    readonly byteLength: number,
    readonly maxBytes: number
  ) {
    super(
      `Payload for field '${fieldName}' (${byteLength} bytes) exceeds persistence limit of ${maxBytes} bytes`
    );
  }
}

export class ContextBudgetExceededError extends DomainError {
  readonly code = "CONTEXT_BUDGET_EXCEEDED";

  constructor(
    readonly reason: string,
    readonly requiredEstimatedTokens?: number,
    readonly maxEstimatedTokens?: number
  ) {
    super(`Context budget exceeded: ${reason}`);
  }
}

export class InvalidObservationError extends DomainError {
  readonly code = "INVALID_OBSERVATION";

  constructor(
    readonly reason: string,
    readonly violations?: readonly string[]
  ) {
    super(
      `Invalid observation: ${reason}${
        violations && violations.length > 0 ? ` (${violations.join("; ")})` : ""
      }`
    );
  }
}

export class InvalidContextBudgetError extends DomainError {
  readonly code = "INVALID_CONTEXT_BUDGET";

  constructor(readonly reason: string) {
    super(`Invalid context budget: ${reason}`);
  }
}

export class ActionProposalRejectedError extends DomainError {
  readonly code = "ACTION_PROPOSAL_REJECTED";

  constructor(
    readonly reason: string,
    readonly rejectionMessage: string,
    readonly violations?: readonly string[]
  ) {
    super(
      `Action proposal rejected [${reason}]: ${rejectionMessage}${
        violations && violations.length > 0 ? ` (${violations.join("; ")})` : ""
      }`
    );
  }
}

// ============================================================================
// Model Provider Error Hierarchy (Phase 6.1)
// ============================================================================

export type ModelProviderErrorCode =
  | "MODEL_PROVIDER_UNAVAILABLE"
  | "MODEL_REQUEST_INVALID"
  | "MODEL_REQUEST_TIMEOUT"
  | "MODEL_REQUEST_CANCELLED"
  | "MODEL_RATE_LIMITED"
  | "MODEL_RESPONSE_INVALID"
  | "MODEL_OUTPUT_LIMIT_EXCEEDED"
  | "MODEL_PROVIDER_ERROR";

export class ModelProviderError extends DomainError {
  readonly code: ModelProviderErrorCode;
  readonly isRetryable: boolean;
  readonly providerName?: string;
  readonly requestId?: string;
  readonly cause?: unknown;

  constructor(
    code: ModelProviderErrorCode,
    message: string,
    options?: {
      isRetryable?: boolean;
      providerName?: string;
      requestId?: string;
      cause?: unknown;
    }
  ) {
    super(`[${code}] ${message}`);
    this.code = code;
    this.isRetryable = options?.isRetryable ?? false;
    this.providerName = options?.providerName;
    this.requestId = options?.requestId;
    this.cause = options?.cause;
  }
}

export class ModelProviderUnavailableError extends ModelProviderError {
  constructor(
    message: string,
    options?: { providerName?: string; requestId?: string; cause?: unknown }
  ) {
    super("MODEL_PROVIDER_UNAVAILABLE", message, { ...options, isRetryable: true });
  }
}

export class ModelRequestInvalidError extends ModelProviderError {
  constructor(
    message: string,
    options?: { providerName?: string; requestId?: string; cause?: unknown }
  ) {
    super("MODEL_REQUEST_INVALID", message, { ...options, isRetryable: false });
  }
}

export class ModelRequestTimeoutError extends ModelProviderError {
  readonly timeoutMs?: number;

  constructor(
    message: string,
    options?: { timeoutMs?: number; providerName?: string; requestId?: string; cause?: unknown }
  ) {
    super("MODEL_REQUEST_TIMEOUT", message, { ...options, isRetryable: true });
    this.timeoutMs = options?.timeoutMs;
  }
}

export class ModelRequestCancelledError extends ModelProviderError {
  constructor(
    message: string,
    options?: { providerName?: string; requestId?: string; cause?: unknown }
  ) {
    super("MODEL_REQUEST_CANCELLED", message, { ...options, isRetryable: false });
  }
}

export class ModelRateLimitedError extends ModelProviderError {
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options?: { retryAfterMs?: number; providerName?: string; requestId?: string; cause?: unknown }
  ) {
    super("MODEL_RATE_LIMITED", message, { ...options, isRetryable: true });
    this.retryAfterMs = options?.retryAfterMs;
  }
}

export class ModelResponseInvalidError extends ModelProviderError {
  constructor(
    message: string,
    options?: { providerName?: string; requestId?: string; cause?: unknown }
  ) {
    super("MODEL_RESPONSE_INVALID", message, { ...options, isRetryable: false });
  }
}

export class ModelOutputLimitExceededError extends ModelProviderError {
  readonly maxOutputTokens?: number;

  constructor(
    message: string,
    options?: { maxOutputTokens?: number; providerName?: string; requestId?: string; cause?: unknown }
  ) {
    super("MODEL_OUTPUT_LIMIT_EXCEEDED", message, { ...options, isRetryable: false });
    this.maxOutputTokens = options?.maxOutputTokens;
  }
}

export class ReflexNotImplementedError extends DomainError {
  readonly code = "REFLEX_NOT_IMPLEMENTED";

  constructor(
    message: string = "Evaluation execution mode 'REFLEX' is reserved for the future adaptive Reflex control layer and is not yet implemented (REFLEX_NOT_IMPLEMENTED). Preflight execution rejected."
  ) {
    super(message);
  }
}

export class InvalidReflexDecisionError extends DomainError {
  readonly code = "INVALID_REFLEX_DECISION";

  constructor(message: string) {
    super(message);
  }
}

export class InvalidReflexContextError extends DomainError {
  readonly code = "INVALID_REFLEX_CONTEXT";

  constructor(message: string) {
    super(message);
  }
}

export class ReflexAuthorityExpansionError extends DomainError {
  readonly code = "REFLEX_AUTHORITY_EXPANSION";

  constructor(message: string) {
    super(message);
  }
}

export class ReflexExecutionDeferredError extends DomainError {
  readonly code = "REFLEX_EXECUTION_DEFERRED";

  constructor(message: string) {
    super(message);
  }
}

export class InvalidRuleConfigError extends DomainError {
  readonly code = "INVALID_RULE_CONFIG";

  constructor(message: string) {
    super(message);
  }
}
