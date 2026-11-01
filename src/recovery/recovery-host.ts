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
 * - The database must already be an Emerald database with the current schema: every table, column,
 *   index and foreign key this build creates must exist (compared against a fresh in-memory schema).
 *   Recovery never creates a database, never migrates an old or foreign one, and never changes its
 *   journal mode: a database that is refused is validated on a private copy and never opened
 *   itself, so its bytes and any -wal/-shm files stay as they were (see openValidatedDatabase).
 *   An accepted database is opened normally; opening one with a leftover WAL lets SQLite replay it.
 *   Accepted limitations (owner decision): the trusted-single-operator model applies and the database
 *   directory must not be writable by other users. A file replaced mid-validation is caught by a
 *   device/inode check before SQLite's first read, but -wal/-journal are resolved by path and are not
 *   re-checked, and a file deleted in that window leaves an empty file. A database with a read-only
 *   attribute and a hot journal is refused until the operator makes it writable. The validation copy is
 *   not an atomic snapshot against a live writer (see the --workers-stopped rule above).
 * - The workspaceRoot, when given, must already exist; it is never created.
 * - Single-user, local, no network. One recovery host should run per database; the supervisor
 *   lease makes a second host safe (it is refused per run) but pointless.
 * - Optional workspaceRoot gives the coordinator a workspace adapter so crashed workspaces are
 *   discarded before a retry; without it, crashed workspace directories are left in place and a
 *   retry that needs the same `ws-<runId>` directory will fail provisioning (fail closed).
 * - Logging is structured JSON lines; sweeps with nothing to report are not logged.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteClient } from "../adapters/persistence/sqlite-client.js";
import { SqliteStateStore } from "../adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../adapters/workspace/node-fs-workspace-adapter.js";
import { RunCoordinator } from "../application/run-coordinator.js";
import { SystemClock } from "../ports/clock.port.js";
import { DurableRollbackEngine } from "./durable-rollback-engine.js";
import { RecoverySupervisor } from "./recovery-supervisor.js";
import { RecoverySweeper, RecoverySweepResult } from "./recovery-sweeper.js";
import { tenantModelFromContract } from "./tenant-quiescence-gate.js";
import type { TenantQuiescencePort } from "../ports/tenant-quiescence.port.js";
import { DockerTenantQuiescenceAdapter } from "../adapters/execution/docker-tenant-quiescence-adapter.js";

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
  /**
   * Proves isolated tenant processes (e.g. containers) are gone (ADR-0037). Defaults to DockerTenantQuiescenceAdapter().
   * Pass null to explicitly disable quiescence checking (holding all isolated runs).
   */
  readonly tenantQuiescence?: TenantQuiescencePort | null;
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

const SQLITE_MAGIC = "SQLite format 3\u0000";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync: NodeDatabaseSync } = nodeRequire("node:sqlite") as { DatabaseSync: typeof DatabaseSync };

interface TableShape {
  /** column name -> "type|notnull|pk" */
  readonly columns: Map<string, string>;
  /** unique|partial|columns|predicate signatures (index names are not part of the contract) */
  readonly indexes: Set<string>;
  /** to-table|from|to|on-delete signatures */
  readonly foreignKeys: Set<string>;
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

function describeSchema(db: DatabaseSync): Map<string, TableShape> {
  const shapes = new Map<string, TableShape>();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
  for (const { name } of tables) {
    const columns = new Map<string, string>();
    for (const c of db.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all() as Array<{ name: string; type: string; notnull: number; pk: number }>) {
      columns.set(c.name, `${c.type.toUpperCase()}|${c.notnull}|${c.pk}`);
    }
    const indexes = new Set<string>();
    for (const ix of db.prepare(`PRAGMA index_list(${quoteIdent(name)})`).all() as Array<{ name: string; unique: number; origin: string; partial: number }>) {
      if (ix.origin === "pk") continue;
      const cols = (db.prepare(`PRAGMA index_info(${quoteIdent(ix.name)})`).all() as Array<{ name: string | null }>).map((c) => c.name ?? "<expr>");
      let predicate = "";
      if (ix.partial) {
        const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(ix.name) as { sql: string | null } | undefined;
        predicate = (/\bWHERE\b([\s\S]*)$/i.exec(row?.sql ?? "")?.[1] ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      }
      indexes.add(`${ix.unique}|${ix.partial}|${cols.join(",")}|${predicate}`);
    }
    const foreignKeys = new Set<string>();
    for (const fk of db.prepare(`PRAGMA foreign_key_list(${quoteIdent(name)})`).all() as Array<{ table: string; from: string; to: string | null; on_delete: string }>) {
      foreignKeys.add(`${fk.table}|${fk.from}|${fk.to ?? ""}|${fk.on_delete}`);
    }
    shapes.set(name, { columns, indexes, foreignKeys });
  }
  return shapes;
}

/**
 * The schema contract is the schema this build creates: INITIAL_SCHEMA_SQL plus migrateDatabase,
 * applied to a throwaway in-memory database. Nothing is hand-listed, so it cannot drift from the
 * schema the store actually needs.
 */
function currentSchemaContract(): Map<string, TableShape> {
  const reference = createSqliteClient({ location: ":memory:" });
  try {
    return describeSchema(reference);
  } finally {
    reference.close();
  }
}

/** Returns the problems that make `actual` incompatible with the current schema (extras are tolerated). */
function schemaProblems(actual: Map<string, TableShape>, contract: Map<string, TableShape>): string[] {
  const problems: string[] = [];
  for (const [table, want] of contract) {
    const have = actual.get(table);
    if (!have) {
      problems.push(`missing table ${table}`);
      continue;
    }
    for (const [col, shape] of want.columns) {
      if (!have.columns.has(col)) problems.push(`missing column ${table}.${col}`);
      else if (have.columns.get(col) !== shape) problems.push(`column ${table}.${col} differs (${have.columns.get(col)} != ${shape})`);
    }
    for (const ix of want.indexes) if (!have.indexes.has(ix)) problems.push(`missing index on ${table} (${ix})`);
    for (const fk of want.foreignKeys) if (!have.foreignKeys.has(fk)) problems.push(`missing foreign key on ${table} (${fk})`);
  }
  return problems;
}

/** Reads the schema of a private snapshot of the database; the original file is never opened. */
function problemsOfPrivateCopy(dbPath: string, contract: Map<string, TableShape>): string[] {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-recovery-validate-"));
  let copy: DatabaseSync | undefined;
  try {
    const copyPath = path.join(tmpDir, "db.sqlite");
    fs.copyFileSync(dbPath, copyPath);
    // A leftover WAL holds committed pages the main file does not have yet; a hot rollback journal
    // holds the pre-images that undo a torn write. Without them the copy would show a state SQLite
    // itself would never expose (measured: a valid database looked stale or malformed).
    const copied = [copyPath];
    for (const sidecar of ["-wal", "-journal"]) {
      if (fs.existsSync(`${dbPath}${sidecar}`)) {
        fs.copyFileSync(`${dbPath}${sidecar}`, `${copyPath}${sidecar}`);
        copied.push(`${copyPath}${sidecar}`);
      }
    }
    // copyFileSync carries a read-only attribute/mode over to the copy, which would stop SQLite from
    // recovering it (measured: "attempt to write a readonly database" on a read-only original with a
    // hot journal). Only the private copies are made writable; the original's attributes are untouched.
    for (const file of copied) fs.chmodSync(file, 0o600);
    // Opened writable on purpose: the copy is private, and SQLite must be free to roll a hot journal
    // back (a read-only open of a hot journal fails). The original is never opened here.
    copy = new NodeDatabaseSync(copyPath);
    return schemaProblems(describeSchema(copy), contract);
  } finally {
    try {
      copy?.close();
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // the directory is private to this call; a leftover is harmless
    }
  }
}

const rejectIncompatible = (problems: string[], dbPath: string): never => {
  throw new RecoveryHostConfigError(
    `Not a current Emerald database (${problems.slice(0, 5).join("; ")}${problems.length > 5 ? `; +${problems.length - 5} more` : ""}). Open it with the application first so its migrations run; recovery will not migrate it: ${dbPath}`
  );
};

/**
 * Validates the database WITHOUT ever opening the original file for a database that is going to be
 * rejected, then opens it once for use and revalidates that handle.
 *
 * Why not a read-only open of the original: measured with disposable fixtures, a writable open and
 * close checkpoints a leftover WAL into the main file and deletes it (bytes changed on a REJECTED
 * database), and even a read-only open of a WAL database creates -shm/-wal sidecars. So stage 1
 * validates a private copy (main file + leftover WAL + hot rollback journal) in a temporary
 * directory: the original is only read, and its bytes and sidecars stay exactly as they were. The
 * copy is recovered by SQLite exactly as the original would be, so the verdict is about the state the
 * application would see after recovery, not about a torn file.
 *
 * Stage 2 runs only for a database that passed stage 1. It opens the original (no journal-mode
 * change, no INITIAL_SCHEMA_SQL, no migrations; query-only while checking), requires the same file
 * identity (device + inode) as at stage 1, and re-checks the schema on this very handle, so a file
 * swapped between the stages is refused rather than adopted. The handle goes to SqliteStateStore as-is.
 */
function openValidatedDatabase(dbPath: string): DatabaseSync {
  const before = fs.statSync(dbPath, { bigint: true });
  if (before.size === 0n) {
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

  const contract = currentSchemaContract();
  try {
    const problems = problemsOfPrivateCopy(dbPath, contract);
    if (problems.length > 0) rejectIncompatible(problems, dbPath);
  } catch (err: unknown) {
    if (err instanceof RecoveryHostConfigError) throw err;
    throw new RecoveryHostConfigError(
      `Cannot read database as SQLite: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let db: DatabaseSync | undefined;
  try {
    db = new NodeDatabaseSync(dbPath);
    // Per-connection and set BEFORE the first read: node:sqlite's default is to fail immediately, so a second
    // host starting while another is sweeping failed with "database is locked" (seen in a POSIX container run).
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA query_only = ON;");
    const after = fs.statSync(dbPath, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino) {
      throw new RecoveryHostConfigError(`Database file was replaced while it was being validated: ${dbPath}`);
    }
    const problems = schemaProblems(describeSchema(db), contract);
    if (problems.length > 0) rejectIncompatible(problems, dbPath);
    // Per-connection settings only (nothing here is persisted to the file).
    db.exec("PRAGMA query_only = OFF;");
    db.exec("PRAGMA foreign_keys = ON;");
    return db;
  } catch (err: unknown) {
    try {
      db?.close();
    } catch {
      // ignore
    }
    if (err instanceof RecoveryHostConfigError) throw err;
    throw new RecoveryHostConfigError(
      `Cannot read database as SQLite: ${err instanceof Error ? err.message : String(err)}`
    );
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
  if (options.workspaceRoot !== undefined) {
    if (!fs.existsSync(options.workspaceRoot) || !fs.statSync(options.workspaceRoot).isDirectory()) {
      throw new RecoveryHostConfigError(`workspaceRoot must be an existing directory (it is never created): ${options.workspaceRoot}`);
    }
  }

  const clock = new SystemClock();
  // Validated and opened as one handle; SqliteStateStore adopts it without running migrations.
  const store = new SqliteStateStore(openValidatedDatabase(options.dbPath));
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
    const tenantQuiescencePort =
      options.tenantQuiescence !== undefined
        ? (options.tenantQuiescence ?? undefined)
        : new DockerTenantQuiescenceAdapter();

    const sweeper = new RecoverySweeper({
      supervisor,
      coordinator,
      tenantQuiescence: {
        tenantModelOf: tenantModelFromContract((contractId, version) => coordinator.getContract(contractId, version)),
        port: tenantQuiescencePort,
      },
      onSweep: hooks?.onSweep,
      onError: hooks?.onError,
    });
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
    heldForTenants: result.heldForTenantsRunIds,
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
  // The sweeper's timers are unref'd (right for library use), and awaiting an abort signal holds no handle,
  // so without this the process silently exits (code 0, no stop record) as soon as nothing else is pending.
  // A ref'd interval keeps the watch alive until the signal aborts; it is always cleared below.
  const keepAlive = setInterval(() => {}, 2_147_483_647);
  try {
    if (!options.signal.aborted) {
      runtime.sweeper.start(options.intervalMs);
      await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
    }
  } finally {
    clearInterval(keepAlive);
    await runtime.sweeper.stop();
    runtime.close();
    log(stamp("recovery.host.stopped", { sweepErrors }));
  }
  return { sweepErrors };
}
