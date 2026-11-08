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

/**
 * Waits `ms` (an integer 0..60000) and returns `value` (default null). The OUTPUT is a pure function of the input; only
 * the wait is time-dependent. It exists so a stock worker has an operation that stays RUNNING long enough to observe,
 * cancel, time out or crash-test through the real worker process.
 */
export class SlowOperation implements DeterministicOperation<{ ms: number; value?: unknown }, unknown> {
  readonly name = "slow";
  static readonly MAX_MS = 60_000;

  async execute(input: { ms?: number; value?: unknown; instruction?: string }, _context: OperationContext): Promise<OperationResult<unknown>> {
    let ms = input?.ms;
    if (ms === undefined && typeof input?.instruction === "string") {
      const parsed = parseInt(input.instruction, 10);
      if (Number.isInteger(parsed)) {
        ms = parsed;
      }
    }
    if (ms === undefined) {
      ms = 1000;
    }
    if (!Number.isInteger(ms) || ms < 0 || ms > SlowOperation.MAX_MS) {
      throw new Error(`slow: input.ms must be an integer between 0 and ${SlowOperation.MAX_MS}`);
    }
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { output: input.value ?? null };
  }
}
