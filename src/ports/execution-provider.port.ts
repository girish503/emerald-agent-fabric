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
}

export type ExecutionStatus = "SUCCESS" | "FAILED" | "TIMED_OUT" | "CANCELLED";

export type ExecutionErrorCode =
  | "EXECUTION_FAILED"
  | "EXECUTION_TIMEOUT"
  | "EXECUTION_CANCELLED"
  | "PROVIDER_UNAVAILABLE"
  | "OPERATION_NOT_FOUND";

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
  execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>>;
}

