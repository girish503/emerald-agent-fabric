/**
 * Pure Deterministic Operation Abstraction.
 * Decouples the runtime kernel from shell execution, Docker containers,
 * browser automation, and LLM APIs.
 */

export interface OperationContext {
  readonly runId: string;
  readonly taskId: string;
  readonly idempotencyToken: string;
  readonly timestamp: string;
}

export interface OperationResult<T = unknown> {
  readonly output: T;
  readonly metadata?: Record<string, unknown>;
}

export interface DeterministicOperation<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  execute(input: TInput, context: OperationContext): Promise<OperationResult<TOutput>> | OperationResult<TOutput>;
}

/**
 * Baseline pure mathematical / transformation operations used for
 * deterministic verification of the runtime kernel without external side effects.
 */
export class EchoOperation implements DeterministicOperation<unknown, unknown> {
  readonly name = "echo";

  execute(input: unknown, _context: OperationContext): OperationResult<unknown> {
    return { output: input };
  }
}

export class SumOperation implements DeterministicOperation<readonly number[], number> {
  readonly name = "sum";

  execute(input: readonly number[], _context: OperationContext): OperationResult<number> {
    const sum = input.reduce((acc, val) => acc + val, 0);
    return { output: sum };
  }
}
