import { DeterministicOperation, OperationContext } from "../../domain/operation.js";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "../../ports/execution-provider.port.js";

/**
 * InProcessExecutionProvider executes deterministic operations directly within
 * the current Node.js process.
 *
 * Boundary Guarantees:
 * - Owns execution mechanics ONLY (calling the pure operation implementation).
 * - Reports execution outcomes to the application runtime; does NOT manage leases,
 *   run lifecycles, retries, or database state.
 * - Selecting an operation by operationName is mechanical execution routing, NOT
 *   an authorization mechanism (authorization must occur at an outer policy gate).
 * - Implements LOGICAL timeout detection via Promise.race(); this causes the runtime
 *   to stop waiting, but does NOT physically terminate the underlying asynchronous
 *   execution. Hard process termination belongs to future out-of-process providers.
 * - Pure deterministic operations f(input) = output are safe for replay.
 */
export class InProcessExecutionProvider implements ExecutionProvider {
  readonly name = "in-process";
  /** Operations run inside the worker process: a dead worker leaves no tenant (ADR-0037). */
  readonly tenantModel = "NONE" as const;
  /** In-process cooperative cancellation: checks signal before execution and at async boundaries. */
  readonly cancellationModel = "COOPERATIVE" as const;
  private readonly operationMap: Map<string, DeterministicOperation> = new Map();
  private defaultOperation?: DeterministicOperation;

  constructor(
    operations?: readonly DeterministicOperation[] | DeterministicOperation,
    defaultOperation?: DeterministicOperation
  ) {
    if (operations) {
      if (Array.isArray(operations)) {
        for (const op of operations) {
          this.operationMap.set(op.name, op);
        }
        if (operations.length > 0) {
          this.defaultOperation = defaultOperation ?? operations[0];
        }
      } else {
        const singleOp = operations as DeterministicOperation;
        this.operationMap.set(singleOp.name, singleOp);
        this.defaultOperation = defaultOperation ?? singleOp;
      }
    } else if (defaultOperation) {
      this.defaultOperation = defaultOperation;
      this.operationMap.set(defaultOperation.name, defaultOperation);
    }
  }

  /**
   * Registers a deterministic operation in this provider.
   */
  registerOperation(operation: DeterministicOperation): void {
    this.operationMap.set(operation.name, operation);
    if (!this.defaultOperation) {
      this.defaultOperation = operation;
    }
  }

  /**
   * Executes a requested operation and produces an ExecutionResult.
   */
  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    const startTime = performance.now();

    // 1. Immediate pre-execution cancellation check
    if (request.signal?.aborted) {
      return {
        status: "CANCELLED",
        error: {
          code: "EXECUTION_CANCELLED",
          message: "Operation was cancelled before execution started",
        },
        durationMs: 0,
        providerMetadata: {
          provider: this.name,
          operation: request.operationName,
          preAborted: true,
        },
      };
    }

    // 2. Resolve operation by requested name or default operation
    let operation = this.operationMap.get(request.operationName);
    if (!operation && !request.operationName) {
      operation = this.defaultOperation;
    }

    if (!operation) {
      return {
        status: "FAILED",
        error: {
          code: "OPERATION_NOT_FOUND",
          message: `Operation '${request.operationName}' not found in in-process provider`,
        },
        durationMs: Math.round(performance.now() - startTime),
        providerMetadata: { provider: this.name, operation: request.operationName },
      };
    }

    const context: OperationContext = {
      runId: request.runId,
      taskId: request.taskId,
      idempotencyToken: request.idempotencyToken,
      timestamp: new Date().toISOString(),
    };

    // 3. Set up logical timeout if requested
    let timeoutTimer: NodeJS.Timeout | undefined;
    let didTimeout = false;

    const timeoutPromise = new Promise<ExecutionResult<TOutput>>((resolve) => {
      if (request.timeoutMs > 0 && Number.isFinite(request.timeoutMs)) {
        timeoutTimer = setTimeout(() => {
          didTimeout = true;
          const durationMs = Math.round(performance.now() - startTime);
          resolve({
            status: "TIMED_OUT",
            error: {
              code: "EXECUTION_TIMEOUT",
              message: `Operation '${operation.name}' exceeded logical timeout limit of ${request.timeoutMs}ms`,
            },
            durationMs,
            providerMetadata: {
              provider: this.name,
              operation: operation.name,
              timeoutMs: request.timeoutMs,
            },
          });
        }, request.timeoutMs);
        timeoutTimer.unref?.();
      }
    });

    // 4. Set up cooperative cancellation listener if signal is provided
    let abortListener: (() => void) | undefined;
    const cancelPromise = new Promise<ExecutionResult<TOutput>>((resolve) => {
      if (request.signal) {
        abortListener = () => {
          const durationMs = Math.round(performance.now() - startTime);
          const isTimeout =
            request.signal?.reason instanceof Error &&
            request.signal.reason.message.toLowerCase().includes("timeout");
          if (isTimeout) {
            resolve({
              status: "TIMED_OUT",
              error: {
                code: "EXECUTION_TIMEOUT",
                message: `Operation '${operation.name}' exceeded logical timeout limit of ${request.timeoutMs}ms`,
              },
              durationMs,
              providerMetadata: {
                provider: this.name,
                operation: operation.name,
                timeoutMs: request.timeoutMs,
              },
            });
            return;
          }
          resolve({
            status: "CANCELLED",
            error: {
              code: "EXECUTION_CANCELLED",
              message: `Operation '${operation.name}' was cancelled during execution`,
            },
            durationMs,
            providerMetadata: {
              provider: this.name,
              operation: operation.name,
              cancelled: true,
            },
          });
        };
        request.signal.addEventListener("abort", abortListener, { once: true });
      }
    });

    const executionPromise = (async (): Promise<ExecutionResult<TOutput>> => {
      try {
        const result = await Promise.resolve(operation.execute(request.inputPayload, context));
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }

        const durationMs = Math.round(performance.now() - startTime);

        // If cancellation signal fired while operation was executing, return CANCELLED (or TIMED_OUT if timeout reason)
        if (request.signal?.aborted) {
          const isTimeout =
            request.signal.reason instanceof Error &&
            request.signal.reason.message.toLowerCase().includes("timeout");
          if (isTimeout) {
            return {
              status: "TIMED_OUT",
              error: {
                code: "EXECUTION_TIMEOUT",
                message: `Operation '${operation.name}' exceeded logical timeout limit of ${request.timeoutMs}ms`,
              },
              durationMs,
              providerMetadata: {
                provider: this.name,
                operation: operation.name,
                timeoutMs: request.timeoutMs,
                lateCompletion: true,
              },
            };
          }
          return {
            status: "CANCELLED",
            error: {
              code: "EXECUTION_CANCELLED",
              message: `Operation '${operation.name}' completed after cancellation was requested`,
            },
            durationMs,
            providerMetadata: {
              provider: this.name,
              operation: operation.name,
              cancelledLate: true,
            },
          };
        }

        if (didTimeout) {
          return {
            status: "TIMED_OUT",
            error: {
              code: "EXECUTION_TIMEOUT",
              message: `Operation '${operation.name}' exceeded logical timeout limit of ${request.timeoutMs}ms`,
            },
            durationMs,
            providerMetadata: {
              provider: this.name,
              operation: operation.name,
              timeoutMs: request.timeoutMs,
              lateCompletion: true,
            },
          };
        }

        return {
          status: "SUCCESS",
          output: result.output as TOutput,
          durationMs,
          providerMetadata: {
            provider: this.name,
            operation: operation.name,
            attemptNumber: request.attemptNumber,
            idempotencyToken: request.idempotencyToken,
          },
        };
      } catch (err: unknown) {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }

        const durationMs = Math.round(performance.now() - startTime);
        if (request.signal?.aborted) {
          return {
            status: "CANCELLED",
            error: {
              code: "EXECUTION_CANCELLED",
              message: `Operation '${operation.name}' failed during cancellation: ${err instanceof Error ? err.message : String(err)}`,
            },
            durationMs,
            providerMetadata: { provider: this.name, operation: operation.name, cancelled: true },
          };
        }

        const message = err instanceof Error ? err.message : String(err);
        const details = err instanceof Error ? err.stack : undefined;

        return {
          status: "FAILED",
          error: {
            code: "EXECUTION_FAILED",
            message,
            details,
          },
          durationMs,
          providerMetadata: { provider: this.name, operation: operation.name },
        };
      } finally {
        if (abortListener && request.signal) {
          request.signal.removeEventListener("abort", abortListener);
        }
      }
    })();

    const races: Promise<ExecutionResult<TOutput>>[] = [executionPromise];
    if (request.timeoutMs > 0 && Number.isFinite(request.timeoutMs)) {
      races.push(timeoutPromise);
    }
    if (request.signal) {
      races.push(cancelPromise);
    }

    if (races.length > 1) {
      return Promise.race(races);
    }

    return executionPromise;
  }
}
