/**
 * Worker host: the process-level shell around WorkerRuntime (`emerald worker`).
 *
 * It owns ONLY process concerns - opening the explicitly named database, the claim loop, structured logging and
 * shutdown. Claiming, lease fencing/renewal, execution, timeouts, terminal transitions and workspace handling all stay in
 * WorkerRuntime / RunCoordinator; recovery stays with `emerald recovery` (a worker never recovers other workers' runs).
 *
 * Shutdown: the first abort stops claiming NEW runs and lets the in-flight run finish (WorkerRuntime has no way to abort
 * a provider). A host that must stop immediately simply dies; the run's lease then expires and recovery takes over.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import { SqliteStateStore } from "../adapters/persistence/sqlite-state-store.js";
import { InProcessExecutionProvider } from "../adapters/execution/in-process-execution-provider.js";
import { NodeFsWorkspaceAdapter } from "../adapters/workspace/node-fs-workspace-adapter.js";
import { SlowOperation, DeterministicOperation, EchoOperation, SumOperation } from "../domain/operation.js";
import { SystemClock } from "../ports/clock.port.js";
import { RunCoordinator } from "./run-coordinator.js";
import { WorkerRuntime } from "./worker-runtime.js";

export class WorkerHostConfigError extends Error {}

export interface WorkerLogRecord {
  readonly ts: string;
  readonly event: string;
  readonly [key: string]: unknown;
}

export interface WorkerHostOptions {
  /** Existing SQLite file. A worker never creates or defaults a database. */
  readonly dbPath: string;
  readonly workerId?: string;
  /** Existing directory for per-run workspaces; without it runs execute with no workspace. */
  readonly workspaceRoot?: string;
  readonly leaseTtlMs?: number;
  readonly pollIntervalMs?: number;
  /** Exit when no run is queued instead of polling. */
  readonly once?: boolean;
  /** Exit after this many claimed runs. */
  readonly maxRuns?: number;
  readonly signal: AbortSignal;
  readonly log?: (record: WorkerLogRecord) => void;
}

export interface WorkerHostResult {
  readonly workerId: string;
  readonly runsProcessed: number;
  readonly errors: number;
}

/** The deterministic operations a stock worker can execute. */
export const BUILT_IN_OPERATIONS: readonly DeterministicOperation[] = [new EchoOperation(), new SumOperation(), new SlowOperation()];

const defaultLog = (record: WorkerLogRecord): void => {
  process.stdout.write(JSON.stringify(record) + "\n");
};

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function runWorkerHost(options: WorkerHostOptions): Promise<WorkerHostResult> {
  if (!options.dbPath || options.dbPath === ":memory:") {
    throw new WorkerHostConfigError("dbPath must be the path of an existing database file");
  }
  if (!fs.existsSync(options.dbPath) || !fs.statSync(options.dbPath).isFile()) {
    throw new WorkerHostConfigError(`Database not found (a worker never creates one; use 'emerald submit' first): ${options.dbPath}`);
  }
  if (options.workspaceRoot !== undefined && (!fs.existsSync(options.workspaceRoot) || !fs.statSync(options.workspaceRoot).isDirectory())) {
    throw new WorkerHostConfigError(`workspaceRoot must be an existing directory (it is never created): ${options.workspaceRoot}`);
  }
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 3_600_000) {
    throw new WorkerHostConfigError("pollIntervalMs must be an integer between 10 and 3600000");
  }
  if (options.maxRuns !== undefined && (!Number.isInteger(options.maxRuns) || options.maxRuns < 1)) {
    throw new WorkerHostConfigError("maxRuns must be a positive integer");
  }

  const log = options.log ?? defaultLog;
  const stamp = (event: string, extra: Record<string, unknown> = {}): WorkerLogRecord => ({ ts: new Date().toISOString(), event, ...extra });
  const workerId = options.workerId ?? `worker-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

  const clock = new SystemClock();
  const store = new SqliteStateStore({ location: options.dbPath });
  try {
    let workspace: NodeFsWorkspaceAdapter | undefined;
    if (options.workspaceRoot) {
      try {
        workspace = new NodeFsWorkspaceAdapter({ workspaceRoot: options.workspaceRoot });
      } catch (err: unknown) {
        throw new WorkerHostConfigError(`Invalid workspaceRoot: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const coordinator = new RunCoordinator(store, clock, undefined, workspace);
    let runtime: WorkerRuntime;
    try {
      runtime = new WorkerRuntime({
        workerId,
        hostname: os.hostname(),
        pid: process.pid,
        coordinator,
        clock,
        leaseTtlMs: options.leaseTtlMs,
        workspacePort: workspace,
        executionProvider: new InProcessExecutionProvider(BUILT_IN_OPERATIONS),
      });
    } catch (err: unknown) {
      throw new WorkerHostConfigError(`Invalid worker configuration: ${err instanceof Error ? err.message : String(err)}`);
    }

    log(stamp("worker.started", { workerId, dbPath: options.dbPath, once: options.once ?? false, workspaceRoot: options.workspaceRoot ?? null }));
    let runsProcessed = 0;
    let errors = 0;
    // A ref'd timer keeps the process alive while idle-polling is awaiting only an abort signal.
    const keepAlive = setInterval(() => {}, 2_147_483_647);
    try {
      while (!options.signal.aborted) {
        let result;
        try {
          result = await runtime.runOnce();
        } catch (err: unknown) {
          errors++;
          log(stamp("worker.error", { workerId, error: err instanceof Error ? err.message : String(err) }));
          if (options.once) break;
          await abortableSleep(pollIntervalMs, options.signal);
          continue;
        }
        if (result.status === "IDLE") {
          if (options.once) break;
          await abortableSleep(pollIntervalMs, options.signal);
          continue;
        }
        runsProcessed++;
        log(stamp("worker.run.finished", { workerId, runId: result.runId, status: result.status }));
        if (options.maxRuns !== undefined && runsProcessed >= options.maxRuns) break;
      }
    } finally {
      clearInterval(keepAlive);
      log(stamp("worker.stopped", { workerId, runsProcessed, errors }));
    }
    return { workerId, runsProcessed, errors };
  } finally {
    store.close();
  }
}
