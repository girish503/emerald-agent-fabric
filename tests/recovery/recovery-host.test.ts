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
