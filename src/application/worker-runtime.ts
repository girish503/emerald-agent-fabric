import { LeaseLostError } from "../domain/errors.js";
import {
  DeterministicOperation,
  EchoOperation,
  OperationContext,
} from "../domain/operation.js";
import { ClockPort, SystemClock } from "../ports/clock.port.js";
import { WorkerRecord } from "../ports/state-store.port.js";
import { ClaimRunResult, RunCoordinator } from "./run-coordinator.js";

export type WorkerRunResult =
  | { readonly status: "IDLE" }
  | { readonly status: "COMPLETED"; readonly runId: string; readonly output: unknown }
  | { readonly status: "FAILED"; readonly runId: string; readonly error: unknown }
  | { readonly status: "FENCED"; readonly runId: string; readonly error: LeaseLostError };

export interface WorkerRuntimeOptions {
  readonly workerId?: string;
  readonly hostname?: string;
  readonly pid?: number;
  readonly coordinator: RunCoordinator;
  readonly clock?: ClockPort;
  readonly leaseTtlMs?: number;
  readonly operations?: readonly DeterministicOperation[] | DeterministicOperation;
}

/**
 * WorkerRuntime is a single-worker deterministic execution unit.
 * It claims runs, executes registered deterministic operations, manages leases,
 * handles fencing token validation, and records completion or failure.
 */
export class WorkerRuntime {
  readonly workerId: string;
  readonly hostname: string;
  readonly pid: number;
  private readonly coordinator: RunCoordinator;
  private readonly clock: ClockPort;
  private readonly leaseTtlMs: number;
  private readonly operationMap: Map<string, DeterministicOperation> = new Map();
  private defaultOperation: DeterministicOperation = new EchoOperation();

  constructor(options: WorkerRuntimeOptions) {
    this.workerId = options.workerId ?? crypto.randomUUID();
    this.hostname = options.hostname ?? "localhost";
    this.pid = options.pid ?? (typeof process !== "undefined" && process.pid ? process.pid : 1);
    this.coordinator = options.coordinator;
    this.clock = options.clock ?? new SystemClock();
    this.leaseTtlMs = options.leaseTtlMs ?? 10000;

    if (options.operations) {
      const ops = options.operations;
      if (Array.isArray(ops)) {
        for (const op of ops) {
          this.operationMap.set(op.name, op);
        }
        if (ops.length > 0) {
          this.defaultOperation = ops[0];
        }
      } else {
        const singleOp = ops as DeterministicOperation;
        this.operationMap.set(singleOp.name, singleOp);
        this.defaultOperation = singleOp;
      }
    }
  }

  /**
   * Registers a deterministic operation that the worker can execute.
   */
  registerOperation(operation: DeterministicOperation): void {
    this.operationMap.set(operation.name, operation);
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

    // Select operation: by task title match, or default operation
    const operation = this.operationMap.get(task.title) ?? this.defaultOperation;

    const opContext: OperationContext = {
      runId: run.runId,
      taskId: task.taskId,
      idempotencyToken: run.idempotencyKey ?? run.runId,
      timestamp: this.clock.nowIso(),
    };

    try {
      const result = await operation.execute(task.inputPayload, opContext);

      // Transition RUNNING -> COMPLETED
      this.coordinator.completeRun(run.runId, this.workerId, lease.leaseId, result.output);
      return {
        status: "COMPLETED",
        runId: run.runId,
        output: result.output,
      };
    } catch (err: unknown) {
      if (err instanceof LeaseLostError) {
        return { status: "FENCED", runId: run.runId, error: err };
      }

      // Record operation failure in state store
      try {
        const errorPayload =
          err instanceof Error
            ? { name: err.name, message: err.message, stack: err.stack }
            : { message: String(err) };

        this.coordinator.failRun(run.runId, errorPayload, this.workerId, lease.leaseId);
        return {
          status: "FAILED",
          runId: run.runId,
          error: errorPayload,
        };
      } catch (failErr: unknown) {
        if (failErr instanceof LeaseLostError) {
          return { status: "FENCED", runId: run.runId, error: failErr };
        }
        throw failErr;
      }
    }
  }
}
