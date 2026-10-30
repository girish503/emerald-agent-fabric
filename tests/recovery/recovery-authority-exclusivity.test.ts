/**
 * Re-audit HIGH-1 / HIGH-2:
 *  - The rollback engine validates supervisor authority against the store itself; a forged,
 *    stale or foreign authority context can never reach a filesystem write, even when the
 *    caller supplies no extra guard callback.
 *  - Supervisor authority per run is exclusive: no second ACTIVE lease is ever issued, not
 *    even to the same supervisor id, and the database enforces it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteClient } from "../../src/adapters/persistence/sqlite-client.js";
import { migrateDatabase } from "../../src/adapters/persistence/schema.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { DurableRollbackEngine } from "../../src/recovery/durable-rollback-engine.js";
import { RecoverySupervisor } from "../../src/recovery/recovery-supervisor.js";
import { computeRecoveryDedupToken } from "../../src/domain/mutation-intent.js";
import { SupervisorLeaseExpiredError, SupervisorLeaseLostError } from "../../src/domain/errors.js";
import { MutationAuthorityContext } from "../../src/ports/mutation-intent-store.port.js";

const sha256 = (c: string) => createHash("sha256").update(c).digest("hex");
const RUN = "run-auth-01";
const OTHER_RUN = "run-auth-02";
const NOW = "2026-10-28T12:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";

function ctx(leaseId: string, supervisorId = "sup"): MutationAuthorityContext {
  return { authority: "SUPERVISOR", supervisorFencing: { supervisorId, leaseId, nowIso: NOW } };
}

describe("Engine authority is validated against the store (HIGH-1)", () => {
  let db: DatabaseSync;
  let store: SqliteStateStore;
  let engine: DurableRollbackEngine;
  let tempDir: string;
  let ws: string;
  let target: string;

  function seedRun(runId: string) {
    store.transaction((tx) => {
      tx.insertTask({ taskId: "t-" + runId, title: "t", description: "d", inputPayload: {}, createdAt: NOW, updatedAt: NOW });
      tx.insertWorker({ workerId: "w-" + runId, hostname: "h", pid: process.pid, status: "ACTIVE", lastHeartbeatAt: NOW, createdAt: NOW });
      tx.insertRun(
        {
          runId, taskId: "t-" + runId, status: "RECOVERING", version: 1, attemptCount: 1, maxAttempts: 3, timeoutMs: 30000,
          idempotencyKey: null, currentWorkerId: "w-" + runId, leaseId: "l-" + runId, leaseExpiresAt: FUTURE,
          resultPayload: null, errorPayload: null, createdAt: NOW, updatedAt: NOW, contractBinding: null, maxOutputBytes: null,
        },
        { eventId: "e-" + runId, runId, timestamp: NOW, eventType: "run.created", schemaVersion: 1, producer: "test", payload: {} }
      );
      tx.insertLease({ leaseId: "l-" + runId, workerId: "w-" + runId, runId, state: "ACTIVE", acquiredAt: NOW, expiresAt: FUTURE, releasedAt: null });
    });
  }

  function supLease(leaseId: string, runId: string, supervisorId: string, expiresAt: string) {
    db.prepare(
      `INSERT INTO supervisor_leases (lease_id, run_id, supervisor_id, acquired_at, expires_at, state) VALUES (?, ?, ?, ?, ?, 'ACTIVE')`
    ).run(leaseId, runId, supervisorId, NOW, expiresAt);
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eaf-auth-"));
    ws = path.join(tempDir, "workspace");
    fs.mkdirSync(path.join(ws, ".emerald", "snapshots", RUN), { recursive: true });
    db = createSqliteClient({ location: ":memory:" });
    store = new SqliteStateStore(db);
    engine = new DurableRollbackEngine(store);
    seedRun(RUN);
    seedRun(OTHER_RUN);

    target = path.join(ws, "src", "x.ts");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "MUT");
    const snap = path.join(ws, ".emerald", "snapshots", RUN, "m1.snap");
    fs.writeFileSync(snap, "BASE");
    store.recordIntent({
      mutationId: "m1", runId: RUN, workerLeaseId: "l-" + RUN, relativePath: "src/x.ts", canonicalPath: target,
      parentMutationId: null, pathMutationVersion: 1, baseDigest: sha256("BASE"), expectedResultingDigest: sha256("MUT"),
      snapshotRef: snap, recoveryDedupToken: computeRecoveryDedupToken(RUN, "m1", "COMMITTED"),
      lifecycleStatus: "COMMITTED", createdAt: 1, updatedAt: 1,
    });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const untouched = () => {
    expect(fs.readFileSync(target, "utf8")).toBe("MUT");
    expect(store.getRunRollback(RUN)).toBeNull();
    expect(store.getIntent("m1")?.lifecycleStatus).toBe("COMMITTED");
  };

  it("a forged authority context (no such lease, no guard callback) is refused before any write or bookkeeping", async () => {
    await expect(
      engine.executeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: ctx("forged-lease") })
    ).rejects.toBeInstanceOf(SupervisorLeaseLostError);
    untouched();
  });

  it("an expired supervisor lease is refused", async () => {
    supLease("sl-expired", RUN, "sup", "2000-01-01T00:00:00.000Z");
    await expect(
      engine.executeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: ctx("sl-expired") })
    ).rejects.toBeInstanceOf(SupervisorLeaseExpiredError);
    untouched();
  });

  it("a lease that belongs to another run is refused", async () => {
    supLease("sl-other", OTHER_RUN, "sup", FUTURE);
    await expect(
      engine.executeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: ctx("sl-other") })
    ).rejects.toBeInstanceOf(SupervisorLeaseLostError);
    untouched();
  });

  it("a supervisor-id mismatch on a real lease is refused", async () => {
    supLease("sl-real", RUN, "sup-real", FUTURE);
    await expect(
      engine.executeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: ctx("sl-real", "impostor") })
    ).rejects.toBeInstanceOf(SupervisorLeaseLostError);
    untouched();
  });

  it("resumeRollback with a forged authority is refused as well", async () => {
    await expect(
      engine.resumeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: ctx("forged-lease") })
    ).rejects.toBeInstanceOf(SupervisorLeaseLostError);
    untouched();
  });

  it("orphan temp cleanup with a forged authority deletes nothing", () => {
    const dir = path.dirname(target);
    const orphan = path.join(dir, ".emerald.tmp.restore.ours");
    fs.writeFileSync(orphan, "BASE");
    expect(() =>
      engine.cleanOrphanedRestoreTempFiles(dir, [sha256("BASE")], {
        runId: RUN,
        workspaceRoot: ws,
        authorityContext: ctx("forged-lease"),
      })
    ).toThrow(SupervisorLeaseLostError);
    expect(fs.existsSync(orphan)).toBe(true);
  });

  it("a valid live lease still completes the rollback with no guard callback supplied", async () => {
    supLease("sl-good", RUN, "sup", FUTURE);
    const result = await engine.executeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: ctx("sl-good") });
    expect(result.status).toBe("COMPLETED");
    expect(fs.readFileSync(target, "utf8")).toBe("BASE");
  });

  // ------------------------------------------------------------------------
  // HIGH-2: exclusive supervisor authority
  // ------------------------------------------------------------------------
  describe("exclusive supervisor lease (HIGH-2)", () => {
    const activeCount = (runId: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM supervisor_leases WHERE run_id = ? AND state = 'ACTIVE'`).get(runId) as { n: number }).n;

    it("the same supervisor id cannot acquire a second ACTIVE lease while the first is unexpired", () => {
      const first = store.acquireSupervisorLease({ runId: RUN, supervisorId: "sup-a", ttlMs: 30000, nowIso: new Date().toISOString() });
      expect(() =>
        store.acquireSupervisorLease({ runId: RUN, supervisorId: "sup-a", ttlMs: 30000, nowIso: new Date().toISOString() })
      ).toThrow(SupervisorLeaseLostError);
      expect(activeCount(RUN)).toBe(1);
      expect(() => store.validateSupervisorFencing(RUN, { supervisorId: "sup-a", leaseId: first.leaseId })).not.toThrow();
    });

    it("a different supervisor id is also refused while the lease is unexpired", () => {
      store.acquireSupervisorLease({ runId: RUN, supervisorId: "sup-a", ttlMs: 30000, nowIso: new Date().toISOString() });
      expect(() =>
        store.acquireSupervisorLease({ runId: RUN, supervisorId: "sup-b", ttlMs: 30000, nowIso: new Date().toISOString() })
      ).toThrow(SupervisorLeaseLostError);
      expect(activeCount(RUN)).toBe(1);
    });

    it("an expired lease can be taken over, and the old holder is fenced out", () => {
      const old = store.acquireSupervisorLease({ runId: RUN, supervisorId: "sup-a", ttlMs: 10, nowIso: "2020-01-01T00:00:00.000Z" });
      const fresh = store.acquireSupervisorLease({ runId: RUN, supervisorId: "sup-a", ttlMs: 30000, nowIso: new Date().toISOString() });
      expect(fresh.leaseId).not.toBe(old.leaseId);
      expect(activeCount(RUN)).toBe(1);
      expect(() => store.validateSupervisorFencing(RUN, { supervisorId: "sup-a", leaseId: old.leaseId })).toThrow();
    });

    it("the database itself refuses a second ACTIVE lease row for a run", () => {
      supLease("sl-1", RUN, "sup-a", FUTURE);
      expect(() => supLease("sl-2", RUN, "sup-a", FUTURE)).toThrow(/UNIQUE/i);
    });

    it("migration demotes legacy duplicate ACTIVE leases (keeping the latest expiry) and installs the index", () => {
      db.exec("DROP INDEX IF EXISTS idx_sup_leases_one_active");
      supLease("legacy-old", RUN, "sup-a", "2090-01-01T00:00:00.000Z");
      supLease("legacy-new", RUN, "sup-b", FUTURE);

      migrateDatabase(db);

      const rows = db.prepare(`SELECT lease_id, state FROM supervisor_leases WHERE run_id = ? ORDER BY lease_id`).all(RUN) as Array<{
        lease_id: string;
        state: string;
      }>;
      expect(rows).toEqual([
        { lease_id: "legacy-new", state: "ACTIVE" },
        { lease_id: "legacy-old", state: "EXPIRED" },
      ]);
      expect(() => supLease("sl-3", RUN, "sup-c", FUTURE)).toThrow(/UNIQUE/i);
    });

    it("default supervisor ids are unique per instance", () => {
      const a = new RecoverySupervisor({ stateStore: store, rollbackEngine: engine });
      const b = new RecoverySupervisor({ stateStore: store, rollbackEngine: engine });
      expect(a.getSupervisorId()).not.toBe(b.getSupervisorId());
    });

    it("a second supervisor, including one configured with the same id, is SKIPPED_LOCKED while the first holds the run", async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      db.prepare(`UPDATE runs SET status = 'RUNNING', lease_expires_at = ? WHERE run_id = ?`).run(past, RUN);
      db.prepare(`UPDATE leases SET expires_at = ? WHERE lease_id = ?`).run(past, "l-" + RUN);
      store.acquireSupervisorLease({ runId: RUN, supervisorId: "shared-id", ttlMs: 30000, nowIso: new Date().toISOString() });

      for (const id of ["shared-id", "other-id"]) {
        const outcome = await new RecoverySupervisor({ stateStore: store, rollbackEngine: engine, supervisorId: id }).recoverRun(RUN, {
          workspaceRoot: ws,
        });
        expect(outcome.status).toBe("SKIPPED_LOCKED_BY_ANOTHER_SUPERVISOR");
      }
      expect(activeCount(RUN)).toBe(1);
      expect(fs.readFileSync(target, "utf8")).toBe("MUT");
    });
  });
});
