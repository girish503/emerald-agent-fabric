/**
 * Emerald Agent Fabric — Recovery Host
 *
 * Composition root that actually RUNS crash recovery against a SQLite database: it opens the
 * store, wires RunCoordinator + DurableRollbackEngine + RecoverySupervisor + RecoverySweeper, and
 * either performs one sweep or watches on an interval until aborted.
 *
 * Operating rules:
 * - RUN ONLY WHILE NO WORKER IS ACTIVE. Worker leases are not renewed anywhere in the codebase, so a
 *   run that outlives its lease TTL is indistinguishable from a crashed one: a host running beside
 *   live workers could roll back and requeue a run whose worker is still alive. Callers must pass
 *   acknowledgeNoActiveWorkers: true (CLI: --workers-stopped) to confirm.
 * - The database must already be an Emerald database with the current schema (all recovery tables
 *   present). Recovery never creates a database and never migrates an old or foreign one: it opens
 *   the file read-only first and refuses anything else.
 * - The workspaceRoot, when given, must already exist; it is never created.
 * - Single-user, local, no network. One recovery host should run per database; the supervisor
 *   lease makes a second host safe (it is refused per run) but pointless.
 * - Optional workspaceRoot gives the coordinator a workspace adapter so crashed workspaces are
 *   discarded before a retry; without it, crashed workspace directories are left in place and a
 *   retry that needs the same `ws-<runId>` directory will fail provisioning (fail closed).
 * - Logging is structured JSON lines; sweeps with nothing to report are not logged.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { SqliteStateStore } from "../adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../adapters/workspace/node-fs-workspace-adapter.js";
import { RunCoordinator } from "../application/run-coordinator.js";
import { SystemClock } from "../ports/clock.port.js";
import { DurableRollbackEngine } from "./durable-rollback-engine.js";
import { RecoverySupervisor } from "./recovery-supervisor.js";
import { RecoverySweeper, RecoverySweepResult } from "./recovery-sweeper.js";

export interface RecoveryLogRecord {
  readonly ts: string;
  readonly event: string;
  readonly [key: string]: unknown;
}

export interface RecoveryHostOptions {
  /** Path of an existing Emerald SQLite database. */
  readonly dbPath: string;
  /** Must be true: confirms no worker is running against this database (see header). */
  readonly acknowledgeNoActiveWorkers: boolean;
  /** Optional workspace root so the coordinator can discard crashed workspaces before retrying. */
  readonly workspaceRoot?: string;
  readonly supervisorId?: string;
  readonly leaseTtlMs?: number;
  readonly log?: (record: RecoveryLogRecord) => void;
}

export interface RecoveryHostRuntime {
  readonly store: SqliteStateStore;
  readonly coordinator: RunCoordinator;
  readonly supervisor: RecoverySupervisor;
  readonly sweeper: RecoverySweeper;
  close(): void;
}

export class RecoveryHostConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryHostConfigError";
  }
}

const REQUIRED_TABLES = [
  "runs",
  "run_events",
  "leases",
  "supervisor_leases",
  "mutation_intents",
  "run_rollbacks",
  "path_rollback_progress",
  "run_workspace_bindings",
] as const;

const SQLITE_MAGIC = "SQLite format 3\u0000";

/**
 * Verifies the file is a SQLite database that already carries the full Emerald recovery schema,
 * WITHOUT writing to it (read-only open), so a wrong --db can never be initialised or migrated.
 */
function assertEmeraldDatabase(dbPath: string): void {
  const stat = fs.statSync(dbPath);
  if (stat.size === 0) {
    throw new RecoveryHostConfigError(`Not an Emerald database (empty file): ${dbPath}`);
  }
  const header = Buffer.alloc(16);
  const fd = fs.openSync(dbPath, "r");
  try {
    fs.readSync(fd, header, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (header.toString("latin1") !== SQLITE_MAGIC) {
    throw new RecoveryHostConfigError(`Not an Emerald database (not a SQLite file): ${dbPath}`);
  }

  const nodeRequire = createRequire(import.meta.url);
  const { DatabaseSync: ReadOnlyDb } = nodeRequire("node:sqlite") as { DatabaseSync: typeof DatabaseSync };
  let db: DatabaseSync | undefined;
  try {
    db = new ReadOnlyDb(dbPath, { readOnly: true });
    const present = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name)
    );
    const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
    if (missing.length > 0) {
      throw new RecoveryHostConfigError(
        `Not a current Emerald database (missing tables: ${missing.join(", ")}). Open it with the application first so its migrations run; recovery will not migrate it: ${dbPath}`
      );
    }
  } catch (err: unknown) {
    if (err instanceof RecoveryHostConfigError) throw err;
    throw new RecoveryHostConfigError(
      `Cannot read database as SQLite: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

const defaultLog = (record: RecoveryLogRecord): void => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
};

/** Opens the database and wires the recovery components. Caller must call close(). */
export function openRecoveryRuntime(
  options: RecoveryHostOptions,
  hooks?: { onSweep?: (r: RecoverySweepResult) => void; onError?: (e: unknown) => void }
): RecoveryHostRuntime {
  if (options.acknowledgeNoActiveWorkers !== true) {
    throw new RecoveryHostConfigError(
      "Refusing to run: worker leases are not renewed, so a live worker running longer than its lease TTL would be treated as crashed. Stop all workers and pass acknowledgeNoActiveWorkers (CLI: --workers-stopped)."
    );
  }
  if (!options.dbPath || typeof options.dbPath !== "string" || options.dbPath === ":memory:") {
    throw new RecoveryHostConfigError("dbPath must be the path of an existing database file");
  }
  if (!fs.existsSync(options.dbPath) || !fs.statSync(options.dbPath).isFile()) {
    throw new RecoveryHostConfigError(`Database not found (recovery never creates one): ${options.dbPath}`);
  }
  assertEmeraldDatabase(options.dbPath);
  if (options.workspaceRoot !== undefined) {
    if (!fs.existsSync(options.workspaceRoot) || !fs.statSync(options.workspaceRoot).isDirectory()) {
      throw new RecoveryHostConfigError(`workspaceRoot must be an existing directory (it is never created): ${options.workspaceRoot}`);
    }
  }

  const clock = new SystemClock();
  const store = new SqliteStateStore({ location: options.dbPath });
  try {
    let workspacePort: NodeFsWorkspaceAdapter | undefined;
    if (options.workspaceRoot) {
      try {
        workspacePort = new NodeFsWorkspaceAdapter({ workspaceRoot: options.workspaceRoot });
      } catch (err: unknown) {
        throw new RecoveryHostConfigError(
          `Invalid workspaceRoot: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    const coordinator = new RunCoordinator(store, clock, undefined, workspacePort);
    const supervisor = new RecoverySupervisor({
      stateStore: store,
      rollbackEngine: new DurableRollbackEngine(store),
      clock,
      supervisorId: options.supervisorId,
      leaseTtlMs: options.leaseTtlMs,
    });
    const sweeper = new RecoverySweeper({ supervisor, coordinator, onSweep: hooks?.onSweep, onError: hooks?.onError });
    return { store, coordinator, supervisor, sweeper, close: () => store.close() };
  } catch (err: unknown) {
    store.close();
    throw err;
  }
}

/** Compact, JSON-safe summary of a sweep (no raw snapshots). */
export function summarizeSweep(result: RecoverySweepResult): Record<string, unknown> {
  return {
    scanned: result.scan.scannedCount,
    recovered: result.scan.recoveredCount,
    recoveredUnverified: result.scan.unverifiedCount,
    skipped: result.scan.skippedCount,
    failed: result.scan.failedCount,
    requeuedOrFailedByCoordinator: result.retry.recoveredCount,
    heldForRollback: result.heldForRollbackRunIds,
    needsAttention: result.needsAttention,
  };
}

/** True when the sweep leaves runs that need an operator (held or failed-closed). */
export function sweepNeedsOperator(result: RecoverySweepResult): boolean {
  return result.heldForRollbackRunIds.length > 0 || result.needsAttention.length > 0;
}

/** Runs exactly one sweep and closes the database. */
export async function runRecoverySweepOnce(options: RecoveryHostOptions): Promise<RecoverySweepResult> {
  const runtime = openRecoveryRuntime(options);
  try {
    return await runtime.sweeper.sweepOnce();
  } finally {
    runtime.close();
  }
}

/**
 * Watches until `signal` aborts: sweeps every `intervalMs`, logging structured JSON lines, then
 * stops the sweeper (waiting for an in-flight sweep) and closes the database.
 */
export async function runRecoveryHost(
  options: RecoveryHostOptions & { readonly intervalMs: number; readonly signal: AbortSignal }
): Promise<{ readonly sweepErrors: number }> {
  let sweepErrors = 0;
  const log = options.log ?? defaultLog;
  const stamp = (event: string, extra: Record<string, unknown> = {}): RecoveryLogRecord => ({
    ts: new Date().toISOString(),
    event,
    ...extra,
  });

  const runtime = openRecoveryRuntime(options, {
    onSweep: (result) => {
      const summary = summarizeSweep(result);
      const quiet =
        result.scan.scannedCount === 0 && result.retry.recoveredCount === 0 && !sweepNeedsOperator(result);
      if (!quiet) log(stamp(sweepNeedsOperator(result) ? "recovery.sweep.attention" : "recovery.sweep", summary));
    },
    onError: (err) => {
      sweepErrors++;
      log(stamp("recovery.error", { error: err instanceof Error ? err.message : String(err) }));
    },
  });

  log(
    stamp("recovery.host.started", {
      dbPath: options.dbPath,
      intervalMs: options.intervalMs,
      supervisorId: runtime.supervisor.getSupervisorId(),
      workspaceCleanup: options.workspaceRoot !== undefined,
      ...(options.workspaceRoot === undefined
        ? { warning: "no workspaceRoot: crashed workspaces are not discarded before retries" }
        : {}),
    })
  );
  try {
    if (!options.signal.aborted) {
      runtime.sweeper.start(options.intervalMs);
      await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
    }
  } finally {
    await runtime.sweeper.stop();
    runtime.close();
    log(stamp("recovery.host.stopped", { sweepErrors }));
  }
  return { sweepErrors };
}
