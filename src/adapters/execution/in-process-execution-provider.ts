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
 * - Owns execution mechanics (calling the pure operation implementation).
 * - Has ZERO dependencies on SQLite, database transactions, leases, or run lifecycle.
 * - Supports logical timeout detection (without claiming physical process kill).
 * - Pure deterministic operations f(input) = output are safe for replay.
 */
export class InProcessExecutionProvider implements ExecutionProvider {
  readonly name = "in-process";
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

    // 1. Resolve operation by requested name or fallback
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

    // 2. Set up logical timeout if requested
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
      }
    });

    const executionPromise = (async (): Promise<ExecutionResult<TOutput>> => {
      try {
        const result = await Promise.resolve(operation.execute(request.inputPayload, context));
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }

        // If logical timeout already fired, drop late output
        if (didTimeout) {
          return new Promise<never>(() => {}); // Never resolve; timeout already resolved
        }

        const durationMs = Math.round(performance.now() - startTime);
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

        if (didTimeout) {
          return new Promise<never>(() => {});
        }

        const durationMs = Math.round(performance.now() - startTime);
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
      }
    })();

    if (request.timeoutMs > 0 && Number.isFinite(request.timeoutMs)) {
      return Promise.race([executionPromise, timeoutPromise]);
    }

    return executionPromise;
  }
}
