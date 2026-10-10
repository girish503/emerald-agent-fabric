import { InProcessExecutionProvider } from "../adapters/execution/in-process-execution-provider.js";
import { LeaseLostError } from "../domain/errors.js";
import { DeterministicOperation, EchoOperation } from "../domain/operation.js";
import { ClockPort, SystemClock } from "../ports/clock.port.js";
import { ExecutionProvider, ExecutionRequest } from "../ports/execution-provider.port.js";
import { WorkerRecord } from "../ports/state-store.port.js";
import { ClaimRunResult, RunCoordinator } from "./run-coordinator.js";

export type WorkerRunResult =
  | { readonly status: "IDLE" }
  | { readonly status: "COMPLETED"; readonly runId: string; readonly output: unknown }
  | { readonly status: "FAILED"; readonly runId: string; readonly error: unknown }
  | { readonly status: "TIMED_OUT"; readonly runId: string; readonly error: unknown }
  | { readonly status: "CANCELLED"; readonly runId: string; readonly error: unknown }
  | { readonly status: "FENCED"; readonly runId: string; readonly error: LeaseLostError };

export interface WorkerRuntimeOptions {
  readonly workerId?: string;
  readonly hostname?: string;
  readonly pid?: number;
  readonly coordinator: RunCoordinator;
  readonly clock?: ClockPort;
  readonly leaseTtlMs?: number;
  readonly executionProvider?: ExecutionProvider;
  readonly operations?: readonly DeterministicOperation[] | DeterministicOperation;
}

/**
 * WorkerRuntime is a single-worker deterministic execution unit.
 *
 * Boundary Responsibilities:
 * - Owns run claiming, worker lease heartbeats, and lifecycle state transitions.
 * - Delegates actual computation to an ExecutionProvider.
 * - Translates execution results into RunCoordinator transitions (complete, fail, timeout).
 * - Enforces fencing tokens and safely handles lease theft / loss.
 */
export class WorkerRuntime {
  readonly workerId: string;
  readonly hostname: string;
  readonly pid: number;
  private readonly coordinator: RunCoordinator;
  private readonly clock: ClockPort;
  private readonly leaseTtlMs: number;
  private readonly executionProvider: ExecutionProvider;

  constructor(options: WorkerRuntimeOptions) {
    this.workerId = options.workerId ?? crypto.randomUUID();
    this.hostname = options.hostname ?? "localhost";
    this.pid = options.pid ?? (typeof process !== "undefined" && process.pid ? process.pid : 1);
    this.coordinator = options.coordinator;
    this.clock = options.clock ?? new SystemClock();
    this.leaseTtlMs = options.leaseTtlMs ?? 10000;

    if (options.executionProvider) {
      this.executionProvider = options.executionProvider;
    } else {
      this.executionProvider = new InProcessExecutionProvider(
        options.operations ?? [new EchoOperation()]
      );
    }
  }

  /**
   * Reference to the configured execution provider.
   */
  get provider(): ExecutionProvider {
    return this.executionProvider;
  }

  /**
   * Heartbeats/registers the worker record in the coordinator's state store.
   */
  ensureRegistered(): void {
    const now = this.clock.nowIso();
    const worker: WorkerRecord = {
      workerId: this.workerId,
      hostname: this.hostname,
      pid: this.pid,
      status: "ACTIVE",
      lastHeartbeatAt: now,
      createdAt: now,
    };
    this.coordinator.registerWorker(worker);
  }

  /**
   * Executes a single pass of the worker execution loop.
   * If runId is provided, claims that specific run.
   * Otherwise, claims the next QUEUED run.
   */
  async runOnce(targetRunId?: string): Promise<WorkerRunResult> {
    this.ensureRegistered();

    let claimResult: ClaimRunResult;

    if (targetRunId) {
      claimResult = this.coordinator.claimRun(targetRunId, this.workerId, this.leaseTtlMs);
    } else {
      const nextRun = this.coordinator.getNextQueuedRun();
      if (!nextRun) {
        return { status: "IDLE" };
      }
      claimResult = this.coordinator.claimRun(nextRun.runId, this.workerId, this.leaseTtlMs);
    }

    const { run, lease } = claimResult;

    // Transition LEASED -> RUNNING
    try {
      this.coordinator.startRun(run.runId, this.workerId, lease.leaseId);
    } catch (err: unknown) {
      if (err instanceof LeaseLostError) {
        return { status: "FENCED", runId: run.runId, error: err };
      }
      throw err;
    }

    // Resolve task and input payload
    const task = this.coordinator.getTask(run.taskId);
    if (!task) {
      throw new Error(`Task '${run.taskId}' not found for run '${run.runId}'`);
    }

    // Construct ExecutionRequest
    const request: ExecutionRequest = {
      runId: run.runId,
      taskId: task.taskId,
      operationName: task.title,
      inputPayload: task.inputPayload,
      idempotencyToken: run.idempotencyKey ?? run.runId,
      attemptNumber: run.attemptCount,
      timeoutMs: run.timeoutMs,
    };

    // Delegate to ExecutionProvider
    const executionResult = await this.executionProvider.execute(request);

    // Translate ExecutionResult to RunCoordinator state transitions
    try {
      switch (executionResult.status) {
        case "SUCCESS": {
          this.coordinator.completeRun(
            run.runId,
            this.workerId,
            lease.leaseId,
            executionResult.output
          );
          return {
            status: "COMPLETED",
            runId: run.runId,
            output: executionResult.output,
          };
        }

        case "TIMED_OUT": {
          const reason =
            executionResult.error?.message ?? `Operation exceeded timeout of ${run.timeoutMs}ms`;
          this.coordinator.timeoutRun(run.runId, reason);
          return {
            status: "TIMED_OUT",
            runId: run.runId,
            error: executionResult.error,
          };
        }

        case "CANCELLED": {
          const reason = executionResult.error?.message ?? "Operation cancelled by provider";
          this.coordinator.cancelRun(run.runId, reason);
          return {
            status: "CANCELLED",
            runId: run.runId,
            error: executionResult.error,
          };
        }

        case "FAILED":
        default: {
          const errorPayload = executionResult.error ?? {
            code: "EXECUTION_FAILED",
            message: "Execution provider reported unhandled failure",
          };
          this.coordinator.failRun(run.runId, errorPayload, this.workerId, lease.leaseId);
          return {
            status: "FAILED",
            runId: run.runId,
            error: errorPayload,
          };
        }
      }
    } catch (err: unknown) {
      if (err instanceof LeaseLostError) {
        return { status: "FENCED", runId: run.runId, error: err };
      }
      throw err;
    }
  }
}
