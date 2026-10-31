/**
 * Recovery host entry point: opens a real on-disk SQLite database and runs the supervisor +
 * coordinator sweep (one-shot and watch), through the library API and the `emerald recovery` CLI.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/index.js";
import { EmeraldCli } from "../../src/cli/emerald-cli.js";
import {
  RecoveryHostConfigError,
  RecoveryLogRecord,
  openRecoveryRuntime,
  runRecoveryHost,
  runRecoverySweepOnce,
} from "../../src/recovery/recovery-host.js";
import { computeRecoveryDedupToken } from "../../src/domain/mutation-intent.js";
import { createAndActivateContract } from "../application/test-helpers.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };
const sha256 = (c: string) => createHash("sha256").update(c).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Recovery host", () => {
  let tempDir: string;
  let dbPath: string;
  let ws: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eaf-host-"));
    dbPath = path.join(tempDir, "emerald.sqlite");
    ws = path.join(tempDir, "workspace");
    fs.mkdirSync(ws, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Creates the database on disk with one crashed run (worker lease expired) and closes it. */
  async function seedCrashedRun(opts: { mutation: boolean; bind: boolean }) {
    const store = new SqliteStateStore({ location: dbPath });
    const coordinator = new RunCoordinator(store);
    coordinator.registerWorker({
      workerId: "worker-1", hostname: "localhost", pid: process.pid, status: "ACTIVE",
      lastHeartbeatAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    });
    const task = coordinator.createTask({ title: "echo", inputPayload: { v: 1 } });
    createAndActivateContract(store, task.taskId);
    const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3, timeoutMs: 15000, maxOutputBytes: 1048576 });
    coordinator.queueRun(run.runId);
    const claim = coordinator.claimRun(run.runId, "worker-1", 300);
    coordinator.startRun(run.runId, "worker-1", claim.lease.leaseId);

    const target = path.join(ws, "src", "x.ts");
    if (opts.mutation) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "MUT");
      const snapDir = path.join(ws, ".emerald", "snapshots", run.runId);
      fs.mkdirSync(snapDir, { recursive: true });
      const snap = path.join(snapDir, "m1.snap");
      fs.writeFileSync(snap, "BASE");
      store.recordIntent({
        mutationId: "m1", runId: run.runId, workerLeaseId: claim.lease.leaseId, relativePath: "src/x.ts", canonicalPath: target,
        parentMutationId: null, pathMutationVersion: 1, baseDigest: sha256("BASE"), expectedResultingDigest: sha256("MUT"),
        snapshotRef: snap, recoveryDedupToken: computeRecoveryDedupToken(run.runId, "m1", "COMMITTED"),
        lifecycleStatus: "COMMITTED", createdAt: 1, updatedAt: 1,
      });
    }
    if (opts.bind) store.bindRunWorkspace(run.runId, fs.realpathSync(ws), new Date().toISOString());
    store.close();
    await sleep(450); // worker lease (300ms) is now expired
    return { runId: run.runId, target };
  }

  const readRun = (runId: string) => {
    const store = new SqliteStateStore({ location: dbPath });
    try {
      return { run: store.getRun(runId), intent: store.getIntent("m1") };
    } finally {
      store.close();
    }
  };

  describe("library API", () => {
    it("refuses to create a database: missing path, :memory: and directories are configuration errors", () => {
      expect(() => openRecoveryRuntime({ acknowledgeNoActiveWorkers: true, dbPath: path.join(tempDir, "typo.sqlite") })).toThrow(RecoveryHostConfigError);
      expect(fs.existsSync(path.join(tempDir, "typo.sqlite"))).toBe(false);
      expect(() => openRecoveryRuntime({ acknowledgeNoActiveWorkers: true, dbPath: ":memory:" })).toThrow(RecoveryHostConfigError);
      expect(() => openRecoveryRuntime({ acknowledgeNoActiveWorkers: true, dbPath: tempDir })).toThrow(RecoveryHostConfigError);
    });

    it("rejects an invalid workspaceRoot without leaking an open database", () => {
      new SqliteStateStore({ location: dbPath }).close();
      expect(() => openRecoveryRuntime({ acknowledgeNoActiveWorkers: true, dbPath, workspaceRoot: "relative/path" })).toThrow(RecoveryHostConfigError);
      fs.rmSync(dbPath); // would fail on Windows if the connection were left open
    });

    it("refuses to run without the no-active-workers acknowledgement", () => {
      new SqliteStateStore({ location: dbPath }).close();
      expect(() => openRecoveryRuntime({ acknowledgeNoActiveWorkers: false, dbPath })).toThrow(/not renewed/);
    });

    it("rejects an empty file, a non-SQLite file, a foreign SQLite database and a stale Emerald schema WITHOUT modifying them", () => {
      const digest = (p: string) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
      const cases: Record<string, (p: string) => void> = {
        empty: (p) => fs.writeFileSync(p, ""),
        text: (p) => fs.writeFileSync(p, "this is not a database"),
        foreign: (p) => {
          const db = new DatabaseSync(p);
          db.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO unrelated (v) VALUES ('keep me');");
          db.close();
        },
        stale: (p) => {
          new SqliteStateStore({ location: p }).close();
          const db = new DatabaseSync(p);
          db.exec("DROP TABLE run_workspace_bindings;");
          db.close();
        },
      };
      for (const [name, make] of Object.entries(cases)) {
        const p = path.join(tempDir, `${name}.sqlite`);
        make(p);
        const before = digest(p);
        expect(() => openRecoveryRuntime({ acknowledgeNoActiveWorkers: true, dbPath: p }), name).toThrow(RecoveryHostConfigError);
        expect(digest(p), `${name} must be byte-identical`).toBe(before);
        // (a stale WAL-mode database may legitimately keep sidecar files from its own earlier use)
        if (name !== "stale") expect(fs.existsSync(`${p}-wal`), `${name} no WAL created`).toBe(false);
        if (name === "stale") {
          const chk = new DatabaseSync(p, { readOnly: true });
          const tables = (chk.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
          chk.close();
          expect(tables).not.toContain("run_workspace_bindings"); // not migrated
        }
      }
    });

    describe("schema contract (no initialisation, migration or journal-mode change on open)", () => {
      const fileHash = (p: string) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
      const snapshot = (p: string) => {
        const db = new DatabaseSync(p, { readOnly: true });
        try {
          return JSON.stringify({
            master: db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(),
            journal: db.prepare("PRAGMA journal_mode").all(),
          });
        } finally {
          db.close();
        }
      };
      /** A current-schema database on disk, optionally altered, left in rollback-journal mode (no sidecars). */
      const makeDb = (name: string, mutate?: (db: DatabaseSyncType) => void, journal = "DELETE") => {
        const p = path.join(tempDir, name);
        new SqliteStateStore({ location: p }).close();
        const db = new DatabaseSync(p);
        db.exec(`PRAGMA journal_mode = ${journal};`);
        mutate?.(db);
        db.close();
        return p;
      };

      const stale: Record<string, [(db: DatabaseSyncType) => void, RegExp]> = {
        "missing required table": [(db) => db.exec("DROP TABLE run_workspace_bindings;"), /missing table run_workspace_bindings/],
        "missing required column (all tables present)": [
          (db) => db.exec("DROP INDEX idx_run_events_dedup; ALTER TABLE run_events DROP COLUMN dedup_token;"),
          /missing column run_events\.dedup_token/,
        ],
        "missing recovery-critical index (all tables present)": [
          (db) => db.exec("DROP INDEX idx_sup_leases_one_active;"),
          /missing index on supervisor_leases/,
        ],
        "missing non-required table that normal initialisation would recreate": [
          (db) => db.exec("DROP TABLE attempts;"),
          /missing table attempts/,
        ],
        "index with a different predicate": [
          (db) => db.exec("DROP INDEX idx_sup_leases_one_active; CREATE UNIQUE INDEX idx_sup_leases_one_active ON supervisor_leases(run_id) WHERE state = 'EXPIRED';"),
          /missing index on supervisor_leases/,
        ],
      };

      for (const [name, [mutate, expected]] of Object.entries(stale)) {
        it(`rejects ${name} and leaves the file, its schema and its directory untouched`, () => {
          const p = makeDb("stale.sqlite", mutate);
          const hash = fileHash(p);
          const schema = snapshot(p);
          const listing = fs.readdirSync(tempDir).sort();

          expect(() => openRecoveryRuntime({ acknowledgeNoActiveWorkers: true, dbPath: p })).toThrow(expected);

          expect(fileHash(p)).toBe(hash);
          expect(snapshot(p)).toBe(schema);
          expect(fs.readdirSync(tempDir).sort()).toEqual(listing); // no -wal/-shm/replacement
          // the handle was released: the file can be replaced/removed right after the failed open
          fs.renameSync(p, `${p}.moved`);
        });
      }

      /** Rewrites one table's DDL (no rows in these fixtures) to simulate a column/constraint drift. */
      const rewriteTable = (table: string, transform: (sql: string) => string) => (db: DatabaseSyncType) => {
        const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string };
        const next = transform(row.sql);
        expect(next, "fixture transform must change the DDL").not.toBe(row.sql);
        db.exec(`PRAGMA foreign_keys = OFF; DROP TABLE ${table};`);
        db.exec(next);
      };
      const drift: Record<string, [(db: DatabaseSyncType) => void, RegExp]> = {
        "column type": [rewriteTable("run_workspace_bindings", (q) => q.replace("bound_at TEXT NOT NULL", "bound_at INTEGER NOT NULL")), /column run_workspace_bindings\.bound_at differs/],
        "column nullability": [rewriteTable("run_workspace_bindings", (q) => q.replace("workspace_root TEXT NOT NULL", "workspace_root TEXT")), /column run_workspace_bindings\.workspace_root differs/],
        "primary key": [rewriteTable("run_workspace_bindings", (q) => q.replace("run_id TEXT PRIMARY KEY", "run_id TEXT")), /column run_workspace_bindings\.run_id differs/],
        "foreign key": [rewriteTable("run_workspace_bindings", (q) => q.replace(/,\s*FOREIGN KEY[^)]*\)\s*REFERENCES runs\(run_id\)\s*ON DELETE RESTRICT/i, "")), /missing foreign key on run_workspace_bindings/],
      };
      for (const [name, [mutate, expected]] of Object.entries(drift)) {
        it(`rejects a ${name} mismatch and leaves the file untouched`, () => {
          const p = makeDb("drift.sqlite", mutate);
          const hash = fileHash(p);
          const schema = snapshot(p);
          const listing = fs.readdirSync(tempDir).sort();
          expect(() => openRecoveryRuntime({ acknowledgeNoActiveWorkers: true, dbPath: p })).toThrow(expected);
          expect(fileHash(p)).toBe(hash);
          expect(snapshot(p)).toBe(schema);
          expect(fs.readdirSync(tempDir).sort()).toEqual(listing);
        });
      }

      // ---- WAL-mode databases: SQLite itself rewrites bytes when a WAL is replayed on a writable open ----
      const fileState = (p: string) => ({
        main: fileHash(p),
        wal: fs.existsSync(`${p}-wal`) ? fileHash(`${p}-wal`) : null,
        shm: fs.existsSync(`${p}-shm`),
        dir: fs.readdirSync(path.dirname(p)).sort(),
      });
      /**
       * A WAL-mode database whose last writer "crashed": its changes exist only in the -wal file (no
       * checkpoint, no -shm). Built by copying main + wal while the writer is still open.
       */
      const leftoverWalDb = (name: string, sql: string) => {
        const srcDir = path.join(tempDir, `${name}-src`);
        const dstDir = path.join(tempDir, name);
        fs.mkdirSync(srcDir);
        fs.mkdirSync(dstDir);
        new SqliteStateStore({ location: path.join(srcDir, "db.sqlite") }).close();
        const writer = new DatabaseSync(path.join(srcDir, "db.sqlite"));
        try {
          writer.exec("PRAGMA wal_autocheckpoint = 0;");
          writer.exec(sql);
          fs.copyFileSync(path.join(srcDir, "db.sqlite"), path.join(dstDir, "db.sqlite"));
          fs.copyFileSync(path.join(srcDir, "db.sqlite-wal"), path.join(dstDir, "db.sqlite-wal"));
        } finally {
          writer.close();
        }
        return path.join(dstDir, "db.sqlite");
      };

      it("rejects a stale database with a leftover uncheckpointed WAL without replaying it (main file, WAL and sidecars unchanged)", () => {
        const p = leftoverWalDb("stale-leftover", "DROP INDEX idx_sup_leases_one_active");
        const before = fileState(p);
        expect(before.wal, "fixture must carry a non-empty leftover WAL").not.toBeNull();
        expect(fs.statSync(`${p}-wal`).size).toBeGreaterThan(0);
        expect(() => openRecoveryRuntime({ acknowledgeNoActiveWorkers: true, dbPath: p })).toThrow(/missing index on supervisor_leases/);
        expect(fileState(p)).toEqual(before);
      });

      it("rejects a stale clean WAL-mode database without touching it", () => {
        const p = makeDb("stale-wal.sqlite", (db) => db.exec("DROP INDEX idx_sup_leases_one_active;"), "WAL");
        const before = fileState(p);
        expect(() => openRecoveryRuntime({ acknowledgeNoActiveWorkers: true, dbPath: p })).toThrow(RecoveryHostConfigError);
        expect(fileState(p)).toEqual(before);
      });

      it("rejects a foreign database with a leftover WAL without touching it", () => {
        const dir = path.join(tempDir, "foreign-wal");
        fs.mkdirSync(dir);
        const p = path.join(dir, "db.sqlite");
        const writer = new DatabaseSync(p);
        try {
          writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE unrelated (id INTEGER);");
          const copyDir = path.join(tempDir, "foreign-wal-copy");
          fs.mkdirSync(copyDir);
          fs.copyFileSync(p, path.join(copyDir, "db.sqlite"));
          fs.copyFileSync(`${p}-wal`, path.join(copyDir, "db.sqlite-wal"));
          const copy = path.join(copyDir, "db.sqlite");
          const before = fileState(copy);
          expect(() => openRecoveryRuntime({ acknowledgeNoActiveWorkers: true, dbPath: copy })).toThrow(RecoveryHostConfigError);
          expect(fileState(copy)).toEqual(before);
        } finally {
          writer.close();
        }
      });

      it("accepts a valid database with a leftover WAL and keeps its committed WAL content", () => {
        const p = leftoverWalDb("valid-leftover", "CREATE TABLE zz_extra (x)");
        const runtime = openRecoveryRuntime({ acknowledgeNoActiveWorkers: true, dbPath: p });
        runtime.close();
        const db = new DatabaseSync(p, { readOnly: true });
        try {
          expect(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE name = 'zz_extra'").all()).toHaveLength(1);
        } finally {
          db.close();
        }
      });

      it("does not leave its private validation copy behind", () => {
        const prefix = "emerald-recovery-validate-";
        const count = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(prefix)).length;
        const p = makeDb("copy-cleanup.sqlite", (db) => db.exec("DROP INDEX idx_sup_leases_one_active;"));
        const before = count();
        expect(() => openRecoveryRuntime({ acknowledgeNoActiveWorkers: true, dbPath: p })).toThrow(RecoveryHostConfigError);
        expect(count()).toBeLessThanOrEqual(before);
      });

      // ---- rollback-journal databases with a HOT journal (writer crashed mid-transaction) ----
      const INDEX_SQL = "CREATE UNIQUE INDEX idx_sup_leases_one_active ON supervisor_leases(run_id) WHERE state = 'ACTIVE'";
      /**
       * A rollback-journal database whose writer "crashed" mid-transaction after SQLite spilled dirty
       * pages into the main file: main file is torn, the -journal holds the undo pre-images. Built by
       * copying main + journal while the writer's transaction is still open. After SQLite recovery the
       * database equals its COMMITTED state: with the recovery index when committedValid, without it otherwise.
       */
      const hotJournalDb = (name: string, committedValid: boolean) => {
        const srcDir = path.join(tempDir, `${name}-src`);
        const dstDir = path.join(tempDir, name);
        fs.mkdirSync(srcDir);
        fs.mkdirSync(dstDir);
        const src = path.join(srcDir, "db.sqlite");
        new SqliteStateStore({ location: src }).close();
        const writer = new DatabaseSync(src);
        try {
          writer.exec("PRAGMA journal_mode = DELETE;");
          if (!committedValid) writer.exec("DROP INDEX idx_sup_leases_one_active;");
          writer.exec("CREATE TABLE zz (x BLOB); PRAGMA cache_size = 8; PRAGMA cache_spill = ON; BEGIN;");
          writer.exec(committedValid ? "DROP INDEX idx_sup_leases_one_active;" : INDEX_SQL);
          writer.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4000) INSERT INTO zz SELECT randomblob(1500) FROM n;");
          fs.copyFileSync(src, path.join(dstDir, "db.sqlite"));
          fs.copyFileSync(`${src}-journal`, path.join(dstDir, "db.sqlite-journal"));
          writer.exec("ROLLBACK;");
        } finally {
          writer.close();
        }
        return path.join(dstDir, "db.sqlite");
      };
      const hasIndex = (p: string) => {
        const db = new DatabaseSync(p, { readOnly: true });
        try {
          return db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE name = 'idx_sup_leases_one_active'").all().length === 1;
        } finally {
          db.close();
        }
      };

      it("rejects a database that is stale after hot-journal recovery, with the main file, journal and directory untouched", () => {
        const p = hotJournalDb("hot-stale", false);
        expect(fs.statSync(`${p}-journal`).size, "fixture must carry a hot journal").toBeGreaterThan(0);
        const before = fileState(p);
        const journalBefore = fileHash(`${p}-journal`);
        // the verdict is about the recovered state (index missing), not about the torn main file
        expect(() => openRecoveryRuntime({ acknowledgeNoActiveWorkers: true, dbPath: p })).toThrow(/missing index on supervisor_leases/);
        expect(fileState(p)).toEqual(before);
        expect(fileHash(`${p}-journal`)).toBe(journalBefore);
      });

      it("accepts a database that is valid after hot-journal recovery (control) and lets SQLite roll the original back", () => {
        const p = hotJournalDb("hot-valid", true);
        expect(fs.statSync(`${p}-journal`).size, "fixture must carry a hot journal").toBeGreaterThan(0);
        const runtime = openRecoveryRuntime({ acknowledgeNoActiveWorkers: true, dbPath: p });
        runtime.close();
        expect(hasIndex(p)).toBe(true); // recovered to the committed state
        const db = new DatabaseSync(p, { readOnly: true });
        try {
          expect((db.prepare("SELECT COUNT(*) AS n FROM zz").get() as { n: number }).n).toBe(0); // in-flight rows undone
        } finally {
          db.close();
        }
        expect(fs.existsSync(`${p}-journal`)).toBe(false);
      });

      /** Marks the database files read-only for the duration of `body`, then restores them so the temp dir can be removed. */
      const withReadOnlyFiles = (p: string, body: () => void) => {
        const files = [p, `${p}-journal`].filter((f) => fs.existsSync(f));
        for (const f of files) fs.chmodSync(f, 0o444);
        try {
          body();
        } finally {
          for (const f of files) fs.chmodSync(f, 0o666);
        }
      };

      it("judges a read-only database with a hot journal by its recovered schema (stale -> missing index, not a read-only error)", () => {
        const p = hotJournalDb("ro-hot-stale", false);
        withReadOnlyFiles(p, () => {
          const before = fileState(p);
          const journalBefore = fileHash(`${p}-journal`);
          expect(() => openRecoveryRuntime({ acknowledgeNoActiveWorkers: true, dbPath: p })).toThrow(/missing index on supervisor_leases/);
          expect(fileState(p)).toEqual(before);
          expect(fileHash(`${p}-journal`)).toBe(journalBefore);
          expect(fs.statSync(p).mode & 0o200, "original stays read-only").toBe(0);
        });
      });

      it("refuses a valid read-only database whose hot journal cannot be rolled back, leaving it untouched (documented limitation)", () => {
        const p = hotJournalDb("ro-hot-valid", true);
        withReadOnlyFiles(p, () => {
          const before = fileState(p);
          const journalBefore = fileHash(`${p}-journal`);
          // Stage 1 passes (the private copy is recoverable); the original itself cannot be recovered
          // while it is read-only, so the host refuses rather than serve a torn file.
          expect(() => openRecoveryRuntime({ acknowledgeNoActiveWorkers: true, dbPath: p })).toThrow(/readonly database/);
          expect(fileState(p)).toEqual(before);
          expect(fileHash(`${p}-journal`)).toBe(journalBefore);
        });
      });

      it("accepts a valid current database in rollback-journal mode and preserves bytes, schema and journal mode", () => {
        const p = makeDb("valid-delete.sqlite");
        const hash = fileHash(p);
        const schema = snapshot(p);
        const runtime = openRecoveryRuntime({ acknowledgeNoActiveWorkers: true, dbPath: p });
        runtime.close();
        expect(fileHash(p)).toBe(hash);
        expect(snapshot(p)).toBe(schema);
        expect(JSON.parse(schema).journal).toEqual([{ journal_mode: "delete" }]);
      });

      it("accepts a valid WAL database and keeps it in WAL mode", () => {
        const p = makeDb("valid-wal.sqlite", undefined, "WAL");
        const schemaBefore = snapshot(p);
        const runtime = openRecoveryRuntime({ acknowledgeNoActiveWorkers: true, dbPath: p });
        runtime.close();
        expect(snapshot(p)).toBe(schemaBefore);
        expect(JSON.parse(snapshot(p)).journal).toEqual([{ journal_mode: "wal" }]);
      });

      it("runs a sweep against a valid rollback-journal database without changing its journal mode", async () => {
        const p = makeDb("valid-sweep.sqlite");
        const result = await runRecoverySweepOnce({ acknowledgeNoActiveWorkers: true, dbPath: p });
        expect(result.scan.scannedCount).toBe(0);
        expect(JSON.parse(snapshot(p)).journal).toEqual([{ journal_mode: "delete" }]);
      });
    });

    it("refuses a nonexistent workspaceRoot and never creates it", () => {
      new SqliteStateStore({ location: dbPath }).close();
      const root = path.join(tempDir, "typo-root");
      expect(() => openRecoveryRuntime({ acknowledgeNoActiveWorkers: true, dbPath, workspaceRoot: root })).toThrow(/existing directory/);
      expect(fs.existsSync(root)).toBe(false);
    });

    it("one sweep rolls back the workspace and requeues the crashed run", async () => {
      const { runId, target } = await seedCrashedRun({ mutation: true, bind: true });

      const result = await runRecoverySweepOnce({ acknowledgeNoActiveWorkers: true, dbPath });

      expect(result.scan.recoveredCount).toBe(1);
      expect(result.heldForRollbackRunIds).toEqual([]);
      const { run, intent } = readRun(runId);
      expect(run?.status).toBe("QUEUED");
      expect(intent?.lifecycleStatus).toBe("ROLLED_BACK");
      expect(fs.readFileSync(target, "utf8")).toBe("BASE");
    });

    it("a mutated run whose workspace was never bound is reported, left untouched", async () => {
      const { runId, target } = await seedCrashedRun({ mutation: true, bind: false });

      const result = await runRecoverySweepOnce({ acknowledgeNoActiveWorkers: true, dbPath });

      expect(result.heldForRollbackRunIds).toEqual([runId]);
      expect(result.needsAttention.map((a) => a.runId)).toEqual([runId]);
      expect(readRun(runId).run?.status).toBe("RUNNING");
      expect(fs.readFileSync(target, "utf8")).toBe("MUT");
    });
  });

  describe("watch loop", () => {
    it("sweeps on an interval, logs structured JSON records, and shuts down cleanly on abort", async () => {
      const { runId } = await seedCrashedRun({ mutation: true, bind: true });
      const logs: RecoveryLogRecord[] = [];
      const controller = new AbortController();

      const host = runRecoveryHost({ acknowledgeNoActiveWorkers: true, dbPath, intervalMs: 20, signal: controller.signal, log: (r) => logs.push(r) });
      await sleep(400);
      controller.abort();
      await host;

      expect(logs[0]!.event).toBe("recovery.host.started");
      expect(logs[logs.length - 1]!.event).toBe("recovery.host.stopped");
      const sweeps = logs.filter((l) => l.event === "recovery.sweep");
      expect(sweeps).toHaveLength(1); // only the sweep that did work is logged; idle sweeps are quiet
      expect(sweeps[0]!.recovered).toBe(1);
      expect(readRun(runId).run?.status).toBe("QUEUED");
      expect(() => JSON.parse(JSON.stringify(logs))).not.toThrow();
      fs.rmSync(dbPath); // the host closed its database connection
    });

    it("logs an attention record for runs that need an operator", async () => {
      await seedCrashedRun({ mutation: true, bind: false });
      const logs: RecoveryLogRecord[] = [];
      const controller = new AbortController();

      const host = runRecoveryHost({ acknowledgeNoActiveWorkers: true, dbPath, intervalMs: 20, signal: controller.signal, log: (r) => logs.push(r) });
      await sleep(200);
      controller.abort();
      await host;

      const attention = logs.filter((l) => l.event === "recovery.sweep.attention");
      expect(attention.length).toBeGreaterThanOrEqual(1);
      expect((attention[0]!.heldForRollback as string[]).length).toBe(1);
    });

    it("an already-aborted signal starts and stops without sweeping", async () => {
      new SqliteStateStore({ location: dbPath }).close();
      const logs: RecoveryLogRecord[] = [];
      const controller = new AbortController();
      controller.abort();

      await runRecoveryHost({ acknowledgeNoActiveWorkers: true, dbPath, intervalMs: 20, signal: controller.signal, log: (r) => logs.push(r) });

      expect(logs.map((l) => l.event)).toEqual(["recovery.host.started", "recovery.host.stopped"]);
    });
  });

  describe("emerald recovery CLI", () => {
    const cli = () => new EmeraldCli({ dbPath });

    it("sweep exits 0 and prints a JSON summary when everything reconciles", async () => {
      const { runId } = await seedCrashedRun({ mutation: true, bind: true });

      const res = await cli().run(["recovery", "sweep", "--db", dbPath, "--workers-stopped"]);

      expect(res.exitCode).toBe(0);
      const summary = JSON.parse(res.output);
      expect(summary.recovered).toBe(1);
      expect(summary.heldForRollback).toEqual([]);
      expect(readRun(runId).run?.status).toBe("QUEUED");
    });

    it("sweep exits 2 when a run needs an operator", async () => {
      await seedCrashedRun({ mutation: true, bind: false });
      const res = await cli().run(["recovery", "sweep", "--db", dbPath, "--workers-stopped"]);
      expect(res.exitCode).toBe(2);
      expect(JSON.parse(res.output).heldForRollback).toHaveLength(1);
    });

    it("requires --db (no default database) and --workers-stopped", async () => {
      new SqliteStateStore({ location: dbPath }).close();
      const noDb = await cli().run(["recovery", "sweep", "--workers-stopped"]);
      expect(noDb.exitCode).toBe(1);
      expect(noDb.output).toMatch(/--db is required/);
      const noAck = await cli().run(["recovery", "sweep", "--db", dbPath]);
      expect(noAck.exitCode).toBe(1);
      expect(noAck.output).toMatch(/not renewed/);
    });

    it("reports usage and configuration errors with exit code 1", async () => {
      const ok = ["--db", dbPath, "--workers-stopped"];
      expect((await cli().run(["recovery"])).exitCode).toBe(1);
      expect((await cli().run(["recovery", "bogus"])).exitCode).toBe(1);
      expect((await cli().run(["recovery", "sweep", "--nope", "x", ...ok])).output).toMatch(/unknown option/);
      expect((await cli().run(["recovery", "sweep", "--workers-stopped", "--db"])).output).toMatch(/requires a value/);
      expect((await cli().run(["recovery", "sweep", "--db", dbPath, "--db", dbPath, "--workers-stopped"])).output).toMatch(/more than once/);
      expect((await cli().run(["recovery", "sweep", ...ok, "--workers-stopped"])).output).toMatch(/more than once/);
      const missing = await cli().run(["recovery", "sweep", "--db", path.join(tempDir, "nope.sqlite"), "--workers-stopped"]);
      expect(missing.exitCode).toBe(1);
      expect(missing.output).toMatch(/never creates one/);
      expect(fs.existsSync(path.join(tempDir, "nope.sqlite"))).toBe(false);
    });

    it("validates --interval-ms strictly (plain integer, 100..86400000)", async () => {
      new SqliteStateStore({ location: dbPath }).close();
      for (const bad of ["5", "1e3", "0x64", "100abc", "", "99999999999", "86400001", "-200", "NaN"]) {
        const res = await cli().run(["recovery", "watch", "--db", dbPath, "--workers-stopped", "--interval-ms", bad || " "]);
        expect(res.exitCode, `interval '${bad}'`).toBe(1);
        expect(res.output).toMatch(/plain integer between 100 and 86400000/);
      }
    });

    it("refuses a nonexistent --workspace-root without creating it", async () => {
      new SqliteStateStore({ location: dbPath }).close();
      const root = path.join(tempDir, "typo-root");
      const res = await cli().run(["recovery", "sweep", "--db", dbPath, "--workers-stopped", "--workspace-root", root]);
      expect(res.exitCode).toBe(1);
      expect(res.output).toMatch(/existing directory/);
      expect(fs.existsSync(root)).toBe(false);
    });
  });
});
