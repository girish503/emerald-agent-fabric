/**
 * Execution Provider Port.
 * Establishes the boundary between "what Emerald wants executed" (the operation)
 * and "where/how that execution occurs" (the provider environment).
 *
 * Owned by the application/ports layer. Free of any infrastructure, container,
 * or database dependencies.
 */

export interface ExecutionRequest<TInput = unknown> {
  readonly runId: string;
  readonly taskId: string;
  readonly operationName: string;
  readonly inputPayload: TInput;
  readonly idempotencyToken: string;
  readonly attemptNumber: number;
  readonly timeoutMs: number;
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
