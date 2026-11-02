/**
 * Re-audit medium findings:
 *  M3 workspace provenance / drift / too-broad roots, M5 zero-intent status,
 *  M6 preflight on IDLE resume, M7 transient vs deterministic failure, M8 pre-rename recheck.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inProcessBinding } from "./in-process-binding.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteClient } from "../../src/adapters/persistence/sqlite-client.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { DurableRollbackEngine } from "../../src/recovery/durable-rollback-engine.js";
import { RecoverySupervisor } from "../../src/recovery/recovery-supervisor.js";
import { computeRecoveryDedupToken } from "../../src/domain/mutation-intent.js";
import {
  WorkspaceBindingConflictError,
  WorkspaceOwnershipMismatchError,
  WorkspaceResolutionError,
} from "../../src/domain/errors.js";
import { MutationAuthorityContext } from "../../src/ports/mutation-intent-store.port.js";

const sha256 = (c: string) => createHash("sha256").update(c).digest("hex");
const RUN = "run-med-01";
const NOW = "2026-10-28T12:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";
const SUP = "sup-med";
const SUP_LEASE = "sup-lease-med";
const authority: MutationAuthorityContext = {
  authority: "SUPERVISOR",
  supervisorFencing: { supervisorId: SUP, leaseId: SUP_LEASE, nowIso: NOW },
};

describe("Re-audit medium findings", () => {
  let db: DatabaseSync;
  let store: SqliteStateStore;
  let engine: DurableRollbackEngine;
  let tempDir: string;
  let ws: string;
  let snapDir: string;

  function seedRun(status: "RECOVERING" | "RUNNING" = "RECOVERING") {
    store.transaction((tx) => {
      tx.insertTask({ taskId: "t", title: "t", description: "d", inputPayload: {}, createdAt: NOW, updatedAt: NOW });
      tx.insertWorker({ workerId: "w", hostname: "h", pid: process.pid, status: "ACTIVE", lastHeartbeatAt: NOW, createdAt: NOW });
      tx.insertRun(
        {
          runId: RUN, taskId: "t", status, version: 1, attemptCount: 1, maxAttempts: 3, timeoutMs: 30000,
          idempotencyKey: null, currentWorkerId: "w", leaseId: "l", leaseExpiresAt: FUTURE,
          resultPayload: null, errorPayload: null, createdAt: NOW, updatedAt: NOW, contractBinding: inProcessBinding(tx, "t"), maxOutputBytes: 1048576,
        },
        { eventId: "e1", runId: RUN, timestamp: NOW, eventType: "run.created", schemaVersion: 1, producer: "test", payload: {} }
      );
      tx.insertLease({ leaseId: "l", workerId: "w", runId: RUN, state: "ACTIVE", acquiredAt: NOW, expiresAt: FUTURE, releasedAt: null });
    });
  }

  const supervisorLease = () =>
    db
      .prepare(`INSERT INTO supervisor_leases (lease_id, run_id, supervisor_id, acquired_at, expires_at, state) VALUES (?, ?, ?, ?, ?, 'ACTIVE')`)
      .run(SUP_LEASE, RUN, SUP, NOW, FUTURE);

  function expireWorkerLease() {
    const past = new Date(Date.now() - 60_000).toISOString();
    db.prepare(`UPDATE runs SET lease_expires_at = ? WHERE run_id = ?`).run(past, RUN);
    db.prepare(`UPDATE leases SET expires_at = ? WHERE lease_id = 'l'`).run(past);
  }

  function addIntent(rel: string, original: string, mutated: string, id: string = "m-default", opts?: { root?: string; tamperSnapshot?: boolean }) {
    const root = opts?.root ?? ws;
    const target = path.resolve(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, mutated);
    const snap = path.resolve(snapDir, `${id}.snap`);
    fs.writeFileSync(snap, opts?.tamperSnapshot ? "TAMPERED" : original);
    store.recordIntent({
      mutationId: id, runId: RUN, workerLeaseId: "l", relativePath: rel, canonicalPath: target,
      parentMutationId: null, pathMutationVersion: 1, baseDigest: sha256(original), expectedResultingDigest: sha256(mutated),
      snapshotRef: snap, recoveryDedupToken: computeRecoveryDedupToken(RUN, id, "COMMITTED"),
      lifecycleStatus: "COMMITTED", createdAt: 1, updatedAt: 1,
    });
    return target;
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eaf-med-"));
    ws = path.join(tempDir, "workspace");
    snapDir = path.join(ws, ".emerald", "snapshots", RUN);
    fs.mkdirSync(snapDir, { recursive: true });
    db = createSqliteClient({ location: ":memory:" });
    store = new SqliteStateStore(db);
    engine = new DurableRollbackEngine(store);
    seedRun();
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------- M3
  describe("M3 workspace provenance", () => {
    it("a workspace that did not host the recorded mutation is refused, even with identical file content", async () => {
      supervisorLease();
      addIntent("src/x.ts", "BASE", "MUT");
      const wrong = path.join(tempDir, "other-workspace");
      fs.mkdirSync(path.join(wrong, "src"), { recursive: true });
      fs.writeFileSync(path.join(wrong, "src", "x.ts"), "MUT"); // same relative path, same bytes

      await expect(
        engine.executeRollback({ runId: RUN, workspaceRoot: wrong, authorityContext: authority })
      ).rejects.toBeInstanceOf(WorkspaceOwnershipMismatchError);

      expect(fs.readFileSync(path.join(wrong, "src", "x.ts"), "utf8")).toBe("MUT");
      expect(fs.readFileSync(path.join(ws, "src", "x.ts"), "utf8")).toBe("MUT");
      expect(store.getRunRollback(RUN)).toBeNull();
    });

    it("the owning workspace is accepted", async () => {
      supervisorLease();
      const target = addIntent("src/x.ts", "BASE", "MUT");
      const result = await engine.executeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: authority });
      expect(result.status).toBe("COMPLETED");
      expect(fs.readFileSync(target, "utf8")).toBe("BASE");
    });

    it("a bound root that later resolves elsewhere (replaced by a junction) is refused as drift", async () => {
      expireWorkerLease();
      db.prepare(`UPDATE runs SET status = 'RUNNING' WHERE run_id = ?`).run(RUN);
      const bound = fs.realpathSync(ws);
      store.bindRunWorkspace(RUN, bound, NOW);

      const elsewhere = path.join(tempDir, "elsewhere");
      fs.mkdirSync(elsewhere);
      fs.rmSync(ws, { recursive: true, force: true });
      fs.symlinkSync(elsewhere, ws, "junction");

      const supervisor = new RecoverySupervisor({ stateStore: store, rollbackEngine: engine, supervisorId: SUP });
      await expect(supervisor.recoverRun(RUN)).rejects.toBeInstanceOf(WorkspaceBindingConflictError);
      expect(store.getRun(RUN)?.status).toBe("RUNNING");
    });

    it("too-broad or system roots are refused (home ancestors, temp root, system directory)", async () => {
      expireWorkerLease();
      db.prepare(`UPDATE runs SET status = 'RUNNING' WHERE run_id = ?`).run(RUN);
      const supervisor = new RecoverySupervisor({ stateStore: store, rollbackEngine: engine, supervisorId: SUP });
      const bad = [
        path.dirname(os.homedir()),
        os.homedir(),
        os.tmpdir(),
        process.platform === "win32" ? (process.env.SystemRoot as string) : "/etc",
      ];
      for (const root of bad) {
        await expect(supervisor.recoverRun(RUN, { workspaceRoot: root })).rejects.toBeInstanceOf(WorkspaceResolutionError);
      }
      expect(store.getRunWorkspaceBinding(RUN)).toBeNull();
      expect(store.getRun(RUN)?.status).toBe("RUNNING");
    });
  });

  // ---------------------------------------------------------------- M5
  it("M5: a zero-intent recovery is RECOVERED_UNVERIFIED, flagged, and not counted as recovered", async () => {
    expireWorkerLease();
    db.prepare(`UPDATE runs SET status = 'RUNNING' WHERE run_id = ?`).run(RUN);
    const supervisor = new RecoverySupervisor({ stateStore: store, rollbackEngine: engine, supervisorId: SUP });
    store.bindRunWorkspace(RUN, fs.realpathSync(ws), NOW);

    const scan = await supervisor.scanAndRecover();

    expect(scan.recoveredCount).toBe(0);
    expect(scan.unverifiedCount).toBe(1);
    expect(scan.outcomes[0]?.status).toBe("RECOVERED_UNVERIFIED");
    expect(scan.outcomes[0]?.noMutationIntentsRecorded).toBe(true);
    expect(scan.outcomes[0]?.details).toMatch(/not verified/i);
    expect(store.getRun(RUN)?.status).toBe("RECOVERING"); // handed off for coordinator retry, not failed
  });

  // ---------------------------------------------------------------- M6
  describe("M6 preflight on IDLE resume", () => {
    function recordIdle(rels: Array<{ rel: string; original: string; mutated: string; id: string }>) {
      store.recordRunRollback(
        { runId: RUN, status: "IDLE", initiatedBy: "SUPERVISOR", createdAt: Date.now(), completedAt: null },
        rels.map((r) => ({
          runId: RUN, relativePath: r.rel, status: "PENDING" as const, initialBaseDigest: sha256(r.original),
          latestExpectedDigest: sha256(r.mutated), baselineSnapshotRef: path.resolve(snapDir, `${r.id}.snap`), updatedAt: Date.now(),
        }))
      );
    }

    it("a crash after the IDLE record but before preflight does not restore siblings when another path would conflict", async () => {
      supervisorLease();
      const a = addIntent("src/a.ts", "A0", "A1", "m-a");
      const b = addIntent("src/b.ts", "B0", "B1", "m-b", { tamperSnapshot: true });
      recordIdle([
        { rel: "src/a.ts", original: "A0", mutated: "A1", id: "m-a" },
        { rel: "src/b.ts", original: "B0", mutated: "B1", id: "m-b" },
      ]);

      const result = await engine.resumeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: authority });

      expect(result.status).toBe("PARTIALLY_ROLLED_BACK_CONFLICT");
      expect(fs.readFileSync(a, "utf8")).toBe("A1"); // zero writes: preflight caught B first
      expect(fs.readFileSync(b, "utf8")).toBe("B1");
    });

    it("an IDLE rollback over clean paths completes normally after preflight", async () => {
      supervisorLease();
      const a = addIntent("src/a.ts", "A0", "A1", "m-a");
      recordIdle([{ rel: "src/a.ts", original: "A0", mutated: "A1", id: "m-a" }]);

      const result = await engine.executeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: authority });

      expect(result.status).toBe("COMPLETED");
      expect(fs.readFileSync(a, "utf8")).toBe("A0");
      expect(store.getRunRollback(RUN)?.status).toBe("COMPLETED");
    });
  });

  // ---------------------------------------------------------------- M7
  describe("M7 failure classification", () => {
    function runningExpired() {
      expireWorkerLease();
      db.prepare(`UPDATE runs SET status = 'RUNNING' WHERE run_id = ?`).run(RUN);
    }
    const throwing = (code: string | undefined, message: string) =>
      Object.create(engine, {
        executeRollback: {
          value: async () => {
            const err = new Error(message) as NodeJS.ErrnoException;
            if (code) err.code = code;
            throw err;
          },
        },
      }) as DurableRollbackEngine;

    it("a transient error (EBUSY) leaves the run RECOVERING with no held lease, and a later supervisor completes it", async () => {
      const target = addIntent("src/x.ts", "BASE", "MUT");
      runningExpired();

      const flaky = new RecoverySupervisor({ stateStore: store, rollbackEngine: throwing("EBUSY", "resource busy"), supervisorId: "sup-flaky" });
      const first = await flaky.recoverRun(RUN, { workspaceRoot: ws });

      expect(first.status).toBe("FAILED");
      expect(first.statusAfter).toBe("RECOVERING");
      expect(store.getRun(RUN)?.status).toBe("RECOVERING");
      expect(db.prepare(`SELECT COUNT(*) AS n FROM supervisor_leases WHERE run_id = ? AND state = 'ACTIVE'`).get(RUN)).toEqual({ n: 0 });
      expect(fs.readFileSync(target, "utf8")).toBe("MUT");

      const healthy = new RecoverySupervisor({ stateStore: store, rollbackEngine: engine, supervisorId: "sup-healthy" });
      const second = await healthy.recoverRun(RUN, { workspaceRoot: ws });
      expect(second.status).toBe("RECOVERED");
      expect(fs.readFileSync(target, "utf8")).toBe("BASE");
    });

    it("a deterministic error terminates the run and marks any rollback aggregate as conflicted", async () => {
      addIntent("src/x.ts", "BASE", "MUT");
      runningExpired();
      store.recordRunRollback(
        { runId: RUN, status: "RESTORING_PATHS", initiatedBy: "SUPERVISOR", createdAt: Date.now(), completedAt: null },
        []
      );

      const sup = new RecoverySupervisor({ stateStore: store, rollbackEngine: throwing(undefined, "boom: unexpected"), supervisorId: "sup-det" });
      const outcome = await sup.recoverRun(RUN, { workspaceRoot: ws });

      expect(outcome.status).toBe("FAILED");
      expect(store.getRun(RUN)?.status).toBe("FAILED");
      expect(store.getRunRollback(RUN)?.status).toBe("PARTIALLY_ROLLED_BACK_CONFLICT");
    });
  });

  // ---------------------------------------------------------------- M8
  it("M8: a target modified after preflight but before replacement is preserved and reported as a conflict", async () => {
    supervisorLease();
    const target = addIntent("src/x.ts", "BASE", "MUT");
    let calls = 0;
    // calls: 1 = up-front fence, 2 = before temp write (preflight already passed)
    const guard = () => {
      calls++;
      if (calls === 2) fs.writeFileSync(target, "EXTERNAL EDIT");
    };

    const result = await engine.executeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: authority, assertAuthorityActive: guard });

    expect(result.status).toBe("PARTIALLY_ROLLED_BACK_CONFLICT");
    expect(fs.readFileSync(target, "utf8")).toBe("EXTERNAL EDIT");
    expect(fs.readdirSync(path.dirname(target)).filter((f) => f.startsWith(".emerald.tmp"))).toEqual([]);
    expect(store.getPathRollbackProgress(RUN, "src/x.ts")?.status).toBe("RESTORE_FAILED");
  });
});
