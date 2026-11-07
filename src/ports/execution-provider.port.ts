import type { TenantModel, TenantQuiescencePort } from "./tenant-quiescence.port.js";

/**
 * Execution Provider Port.
 * Establishes the boundary between "what Emerald wants executed" (the operation)
 * and "where/how that execution occurs" (the provider environment).
 *
 * Owned by the application/ports layer. Free of any infrastructure, container,
 * or database dependencies.
 *
 * Key Architectural Contracts:
 *
 * 1. Provider Lifecycle Responsibility:
 *    - The ExecutionProvider reports execution outcomes ONLY.
 *    - It does NOT own run lifecycle, lease state, worker ownership, retry policy,
 *      or run state transitions.
 *    - The application runtime maps provider outcomes into run state transitions.
 *
 * 2. Logical Timeout vs Physical Termination:
 *    - Current provider timeout is a LOGICAL runtime timeout.
 *    - Promise.race() causes the runtime to stop waiting for an operation, but does
 *      NOT physically terminate the underlying asynchronous execution or thread.
 *    - Physical process termination belongs to a future out-of-process provider.
 *
 * 3. Run Idempotency vs Operation Idempotency:
 *    - A run-level idempotency key protects creation/recovery semantics for the run.
 *    - It must NOT automatically be treated as sufficient operation-level idempotency
 *      for arbitrary future multi-step agent actions.
 *    - Future architecture may explicitly distinguish: run_id, execution_id,
 *      operation_id, attempt_number, and operation idempotency token.
 *
 * 4. Operation Registry vs Authorization:
 *    - Selecting an operation by operationName is an execution routing lookup, NOT
 *      an authorization mechanism.
 *    - Future operation execution must pass through policy/capability authorization
 *      before execution.
 *
 * 5. Minimal Abstraction:
 *    - The ExecutionProvider contract is intentionally small and focused.
 *    - It must not be expanded merely to anticipate speculative future requirements.
 */

export type ExecutionWorkloadTrustClassification =
  | "TRUSTED_INTERNAL"
  | "UNTRUSTED_WORKLOAD"
  | "ADVERSARIAL_WORKLOAD"
  | "MULTI_TENANT_WORKLOAD"
  | "UNKNOWN";

/**
 * Architectural role of an ExecutionProvider within the runtime pipeline.
 * - "PHYSICAL": Directly executes operations, commands, or processes (e.g. Docker, InProcess). Default.
 * - "ORCHESTRATION": Drives multi-turn agent reasoning loops and delegates tool actions through ToolExecutionGateway.
 */
export type ExecutionProviderRole = "PHYSICAL" | "ORCHESTRATION";

/**
 * Resolves the role of an ExecutionProvider, defaulting to "PHYSICAL" if undeclared.
 */
export function resolveProviderRole(provider: ExecutionProvider): ExecutionProviderRole {
  return provider.role ?? "PHYSICAL";
}

export interface ExecutionWorkspaceMount {
  readonly workspaceId?: string;
  readonly hostPath: string;
  readonly containerMountPath?: string;
}

export interface ExecutionRequest<TInput = unknown> {
  readonly runId: string;
  readonly taskId: string;
  readonly operationName: string;
  readonly inputPayload: TInput;
  readonly idempotencyToken: string;
  readonly attemptNumber: number;
  readonly timeoutMs: number;
  readonly workspace?: ExecutionWorkspaceMount;
  readonly leaseId?: string;
  readonly workerId?: string;
  readonly tenantId?: string;
  readonly trustClassification?: ExecutionWorkloadTrustClassification;
  /**
   * Optional cancellation signal delivered by the runtime.
   * NOTE: Receipt of an abort signal represents a cancellation request;
   * it does NOT guarantee immediate physical execution termination.
   */
  readonly signal?: AbortSignal;
}

/**
 * Cancellation capability model declared by an ExecutionProvider.
 *
 * - "PHYSICAL": The provider guarantees physical termination of managed child processes/containers.
 * - "COOPERATIVE": The provider checks the signal cooperatively between discrete execution boundaries.
 * - "NONE": The provider does not support cancellation; execution continues un-interrupted in flight.
 */
export type ProviderCancellationModel = "PHYSICAL" | "COOPERATIVE" | "NONE";

/**
 * Resolves the cancellation capability of an ExecutionProvider.
 * Fail-closed default: an undeclared provider is treated as "NONE".
 */
export function resolveProviderCancellationModel(
  provider: ExecutionProvider
): ProviderCancellationModel {
  return provider.cancellationModel ?? "NONE";
}

export type ExecutionStatus = "SUCCESS" | "FAILED" | "TIMED_OUT" | "CANCELLED";

export type ExecutionErrorCode =
  | "EXECUTION_FAILED"
  | "EXECUTION_TIMEOUT"
  | "EXECUTION_CANCELLED"
  | "PROVIDER_UNAVAILABLE"
  | "OPERATION_NOT_FOUND"
  /**
   * A timeout, cancellation or output-limit stop was requested but the provider could NOT prove the
   * execution is gone. Always reported with status "FAILED" (never TIMED_OUT/CANCELLED): the workload may
   * still be running, so the runtime must leave the run to lease-expiry recovery (ADR-0037).
   */
  | "TERMINATION_UNVERIFIED"
  /**
   * The agent claimed completion but the runtime could not authorize it because the Mission Contract has
   * nothing verifiable (no specifications, unsupported rule, or a missing clean-room verifier/workspace).
   * Always reported with status "FAILED": a model claim never produces a successful run (Milestone 2.23).
   */
  | "COMPLETION_UNVERIFIABLE"
  // Track E Sandbox and Security Failure Taxonomy
  | "SANDBOX_CONFIGURATION_INVALID"
  | "SANDBOX_POLICY_REJECTED"
  | "DOCKER_UNAVAILABLE"
  | "ROOTLESS_VALIDATION_FAILED"
  | "IMAGE_NOT_AVAILABLE"
  | "IMAGE_POLICY_REJECTED"
  | "CONTAINER_CREATE_FAILED"
  | "CONTAINER_START_FAILED"
  | "RESOURCE_LIMIT_EXCEEDED"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "CONTAINER_EXIT_NONZERO"
  | "CONTAINER_CRASHED"
  | "CONTAINER_CLEANUP_FAILED"
  | "UNKNOWN_TRUST_CLASSIFICATION"
  | "HOST_FALLBACK_DISALLOWED"
  | "EXECUTION_OUTCOME_UNKNOWN";

export interface ExecutionErrorPayload {
  readonly code: ExecutionErrorCode;
  readonly message: string;
  readonly details?: unknown;
}

export interface ExecutionResult<TOutput = unknown> {
  readonly status: ExecutionStatus;
  readonly output?: TOutput;
  readonly error?: ExecutionErrorPayload;
  readonly durationMs: number;
  readonly providerMetadata?: Record<string, unknown>;
}

/**
 * ExecutionProvider defines the contract for executing operations.
 *
 * Responsibilities:
 * - Owns execution mechanics (in-process, future sandboxes, containers).
 * - Must NOT mutate database state, update Run state, or manage leases.
 */
export interface ExecutionProvider {
  readonly name: string;
  /**
   * Role of the provider in the execution pipeline. Default: "PHYSICAL".
   */
  readonly role?: ExecutionProviderRole;
  /**
   * What this provider can leave running if its worker dies (ADR-0037). Omitted means ISOLATED_PROCESSES: an undeclared
   * provider is never assumed harmless.
   */
  readonly tenantModel?: TenantModel;
  /** How recovery proves an ISOLATED_PROCESSES provider's tenants are gone. */
  readonly quiescence?: TenantQuiescencePort;
  /** Explicit cancellation capability declared by the provider. Default: "NONE" */
  readonly cancellationModel?: ProviderCancellationModel;
  execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>>;
}

