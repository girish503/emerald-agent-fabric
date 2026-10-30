/**
 * Phase 48AG.4.1 findings F4–F7: path containment, resume snapshot verification,
 * pre-write authority fencing, and provable-ownership temp cleanup.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteClient } from "../../src/adapters/persistence/sqlite-client.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { DurableRollbackEngine } from "../../src/recovery/durable-rollback-engine.js";
import { MutationIntent, computeRecoveryDedupToken } from "../../src/domain/mutation-intent.js";
import { SnapshotContainmentError, SupervisorLeaseLostError } from "../../src/domain/errors.js";
import { MutationAuthorityContext } from "../../src/ports/mutation-intent-store.port.js";

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

const RUN = "run-hardening-01";
const NOW = "2026-10-28T12:00:00.000Z";
const SUP_ID = "sup-hardening";
const SUP_LEASE = "sup-lease-hardening";

const authority: MutationAuthorityContext = {
  authority: "SUPERVISOR",
  supervisorFencing: { supervisorId: SUP_ID, leaseId: SUP_LEASE, nowIso: NOW },
};

describe("Durable rollback hardening (F4–F7)", () => {
  let db: DatabaseSync;
  let store: SqliteStateStore;
  let engine: DurableRollbackEngine;
  let tempDir: string;
  let ws: string;
  let outside: string;
  let snapDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eaf-rb-hard-"));
    ws = path.join(tempDir, "workspace");
    outside = path.join(tempDir, "outside");
    snapDir = path.join(ws, ".emerald", "snapshots", RUN);
    fs.mkdirSync(snapDir, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });

    db = createSqliteClient({ location: ":memory:" });
    store = new SqliteStateStore(db);
    engine = new DurableRollbackEngine(store);

    store.transaction((tx) => {
      tx.insertTask({ taskId: "t", title: "t", description: "d", inputPayload: {}, createdAt: NOW, updatedAt: NOW });
      tx.insertWorker({ workerId: "w", hostname: "h", pid: process.pid, status: "ACTIVE", lastHeartbeatAt: NOW, createdAt: NOW });
      tx.insertRun(
        {
          runId: RUN,
          taskId: "t",
          status: "RECOVERING",
          version: 1,
          attemptCount: 1,
          maxAttempts: 3,
          timeoutMs: 30000,
          idempotencyKey: null,
          currentWorkerId: "w",
          leaseId: "l",
          leaseExpiresAt: "2099-01-01T00:00:00.000Z",
          resultPayload: null,
          errorPayload: null,
          createdAt: NOW,
          updatedAt: NOW,
          contractBinding: null,
          maxOutputBytes: null,
        },
        { eventId: "e1", runId: RUN, timestamp: NOW, eventType: "run.created", schemaVersion: 1, producer: "test", payload: {} }
      );
      tx.insertLease({ leaseId: "l", workerId: "w", runId: RUN, state: "ACTIVE", acquiredAt: NOW, expiresAt: "2099-01-01T00:00:00.000Z", releasedAt: null });
    });
    db.prepare(
      `INSERT INTO supervisor_leases (lease_id, run_id, supervisor_id, acquired_at, expires_at, state) VALUES (?, ?, ?, ?, ?, 'ACTIVE')`
    ).run(SUP_LEASE, RUN, SUP_ID, NOW, "2099-01-01T00:00:00.000Z");
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function setup(rel: string, original: string, mutated: string, mutationId: string, snapshotRef?: string) {
    const target = path.resolve(ws, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, mutated);
    const snap = snapshotRef ?? path.resolve(snapDir, `${mutationId}.snap`);
    if (!snapshotRef) fs.writeFileSync(snap, original);
    const intent: MutationIntent = {
      mutationId,
      runId: RUN,
      workerLeaseId: "l",
      relativePath: rel,
      canonicalPath: target,
      parentMutationId: null,
      pathMutationVersion: 1,
      baseDigest: sha256(original),
      expectedResultingDigest: sha256(mutated),
      snapshotRef: snap,
      recoveryDedupToken: computeRecoveryDedupToken(RUN, mutationId, "COMMITTED"),
      lifecycleStatus: "COMMITTED",
      createdAt: 1729900000000,
      updatedAt: 1729900000000,
    };
    store.recordIntent(intent);
    return { target, snap };
  }

  function recordInProgress(rel: string, original: string, mutated: string, snap: string) {
    store.recordRunRollback(
      { runId: RUN, status: "RESTORING_PATHS", initiatedBy: "SUPERVISOR", createdAt: Date.now(), completedAt: null },
      [
        {
          runId: RUN,
          relativePath: rel,
          status: "IN_PROGRESS",
          initialBaseDigest: sha256(original),
          latestExpectedDigest: sha256(mutated),
          baselineSnapshotRef: snap,
          updatedAt: Date.now(),
        },
      ]
    );
  }

  // F4
  it("F4: rejects a path that traverses a directory link out of the workspace", () => {
    const secret = path.join(outside, "victim.ts");
    fs.writeFileSync(secret, "secret");
    fs.symlinkSync(outside, path.join(ws, "linkdir"), "junction");

    expect(() => engine.resolveSafePath("linkdir/victim.ts", ws)).toThrow(SnapshotContainmentError);
    expect(() => engine.resolveSafePath("linkdir/new-file.ts", ws)).toThrow(SnapshotContainmentError);
    expect(fs.readFileSync(secret, "utf8")).toBe("secret");
  });

  it("F4: rollback over a linked path fails before any filesystem or progress change", async () => {
    const victim = path.join(outside, "victim.ts");
    fs.writeFileSync(victim, "MUT");
    fs.symlinkSync(outside, path.join(ws, "linkdir"), "junction");
    const snap = path.resolve(snapDir, "m-link.snap");
    fs.writeFileSync(snap, "BASE");
    store.recordIntent({
      mutationId: "m-link",
      runId: RUN,
      workerLeaseId: "l",
      relativePath: "linkdir/victim.ts",
      canonicalPath: path.join(ws, "linkdir", "victim.ts"),
      parentMutationId: null,
      pathMutationVersion: 1,
      baseDigest: sha256("BASE"),
      expectedResultingDigest: sha256("MUT"),
      snapshotRef: snap,
      recoveryDedupToken: computeRecoveryDedupToken(RUN, "m-link", "COMMITTED"),
      lifecycleStatus: "COMMITTED",
      createdAt: 1,
      updatedAt: 1,
    });

    await expect(engine.executeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: authority })).rejects.toBeInstanceOf(
      SnapshotContainmentError
    );
    expect(fs.readFileSync(victim, "utf8")).toBe("MUT");
    expect(store.getRunRollback(RUN)).toBeNull();
  });

  it("F4: ordinary in-workspace paths (including not-yet-existing ones) still resolve", () => {
    expect(engine.resolveSafePath("src/new/file.ts", ws)).toBe(path.resolve(ws, "src/new/file.ts"));
  });

  // F5
  it("F5: resume refuses a tampered snapshot and leaves the target untouched", async () => {
    const { target, snap } = setup("src/a.ts", "BASE", "MUT", "m-tamper");
    fs.writeFileSync(snap, "TAMPERED");
    recordInProgress("src/a.ts", "BASE", "MUT", snap);

    const result = await engine.resumeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: authority });

    expect(result.status).toBe("PARTIALLY_ROLLED_BACK_CONFLICT");
    expect(result.conflictedPaths).toEqual(["src/a.ts"]);
    expect(fs.readFileSync(target, "utf8")).toBe("MUT");
    expect(store.getPathRollbackProgress(RUN, "src/a.ts")?.status).toBe("RESTORE_FAILED");
    expect(fs.readdirSync(path.dirname(target)).filter((f) => f.startsWith(".emerald.tmp"))).toEqual([]);
  });

  it("F5: a snapshot reference outside the run snapshot directory is refused, even with a matching digest", async () => {
    const stray = path.join(ws, "stray.snap");
    fs.writeFileSync(stray, "BASE");
    const { target } = setup("src/b.ts", "BASE", "MUT", "m-stray", stray);
    recordInProgress("src/b.ts", "BASE", "MUT", stray);

    const result = await engine.resumeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: authority });

    expect(result.status).toBe("PARTIALLY_ROLLED_BACK_CONFLICT");
    expect(fs.readFileSync(target, "utf8")).toBe("MUT");
  });

  it("F5: executeRollback treats an out-of-directory snapshot as corrupt (preflight, zero writes)", async () => {
    const stray = path.join(outside, "elsewhere.snap");
    fs.writeFileSync(stray, "BASE");
    const { target } = setup("src/c.ts", "BASE", "MUT", "m-out", stray);

    const result = await engine.executeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: authority });

    expect(result.status).toBe("PARTIALLY_ROLLED_BACK_CONFLICT");
    expect(fs.readFileSync(target, "utf8")).toBe("MUT");
  });

  // F6
  it("F6: authority is re-checked before the destructive write and the write is skipped when lost", async () => {
    const { target } = setup("src/d.ts", "BASE", "MUT", "m-fence");
    const guard = () => {
      throw new SupervisorLeaseLostError(RUN, SUP_ID, "other", "taken over");
    };

    await expect(
      engine.executeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: authority, assertAuthorityActive: guard })
    ).rejects.toBeInstanceOf(SupervisorLeaseLostError);

    expect(fs.readFileSync(target, "utf8")).toBe("MUT");
    expect(fs.readdirSync(path.dirname(target)).filter((f) => f.startsWith(".emerald.tmp"))).toEqual([]);
    expect(store.getPathRollbackProgress(RUN, "src/d.ts")?.status).not.toBe("RESTORE_FAILED");
  });

  it("F6: authority loss between temp write and rename skips the rename and preserves the temp file (no unauthorized delete)", async () => {
    const { target } = setup("src/e.ts", "BASE", "MUT", "m-fence2");
    let calls = 0;
    // calls: 1 = up-front fence, 2 = before temp write, 3 = before rename
    const guard = () => {
      calls++;
      if (calls >= 3) throw new SupervisorLeaseLostError(RUN, SUP_ID, "other");
    };

    await expect(
      engine.executeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: authority, assertAuthorityActive: guard })
    ).rejects.toBeInstanceOf(SupervisorLeaseLostError);

    expect(fs.readFileSync(target, "utf8")).toBe("MUT");
    const dir = path.dirname(target);
    const temps = fs.readdirSync(dir).filter((f) => f.startsWith(".emerald.tmp"));
    expect(temps).toHaveLength(1); // preserved: no authority to delete it
    expect(fs.readFileSync(path.join(dir, temps[0]!), "utf8")).toBe("BASE");

    // Later, under valid authority, the provable orphan is reclaimed.
    engine.cleanOrphanedRestoreTempFiles(dir, [sha256("BASE")], { runId: RUN, workspaceRoot: ws, authorityContext: authority });
    expect(fs.readdirSync(dir).filter((f) => f.startsWith(".emerald.tmp"))).toEqual([]);
  });

  it("F6: guard is invoked on the successful path", async () => {
    const { target } = setup("src/f.ts", "BASE", "MUT", "m-fence3");
    let calls = 0;
    const result = await engine.executeRollback({
      runId: RUN,
      workspaceRoot: ws,
      authorityContext: authority,
      assertAuthorityActive: () => {
        calls++;
      },
    });
    expect(result.status).toBe("COMPLETED");
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(fs.readFileSync(target, "utf8")).toBe("BASE");
  });

  // F7
  it("F7: restore temp files with foreign content are preserved; provable copies of our snapshot are removed", () => {
    const dir = path.join(ws, "src");
    fs.mkdirSync(dir, { recursive: true });
    const foreign = path.join(dir, ".emerald.tmp.restore.foreign");
    const ours = path.join(dir, ".emerald.tmp.restore.ours");
    const unrelated = path.join(dir, "keep.ts");
    fs.writeFileSync(foreign, "SOMEONE ELSE'S DATA");
    fs.writeFileSync(ours, "BASE");
    fs.writeFileSync(unrelated, "x");

    const preserved = engine.cleanOrphanedRestoreTempFiles(dir, [sha256("BASE")], {
      runId: RUN,
      workspaceRoot: ws,
      authorityContext: authority,
    });

    expect(preserved).toEqual([".emerald.tmp.restore.foreign"]);
    expect(fs.existsSync(foreign)).toBe(true);
    expect(fs.existsSync(ours)).toBe(false);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it("F7: resume with a foreign-content temp file present restores the target and preserves the foreign file", async () => {
    const { target, snap } = setup("src/g.ts", "BASE", "MUT", "m-foreign");
    const foreign = path.join(path.dirname(target), ".emerald.tmp.restore.foreign");
    fs.writeFileSync(foreign, "FOREIGN");
    recordInProgress("src/g.ts", "BASE", "MUT", snap);

    const result = await engine.resumeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: authority });

    expect(result.status).toBe("COMPLETED");
    expect(fs.readFileSync(target, "utf8")).toBe("BASE");
    expect(fs.readFileSync(foreign, "utf8")).toBe("FOREIGN");
  });
});
