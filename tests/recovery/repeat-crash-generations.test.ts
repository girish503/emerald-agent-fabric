/**
 * Rollback generations: after a run's rollback COMPLETED and the run was retried, a later crash
 * must roll back exactly the NEW attempt's mutations (any intent state, any path shape) without
 * needing or touching the first attempt's evidence. Also: VERIFIED_PASS mutations of a crashed run
 * are rolled back, and chained mutations accept any legitimate intermediate digest.
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
import { MutationLifecycleStatus, computeRecoveryDedupToken } from "../../src/domain/mutation-intent.js";
import { SupervisorLeaseLostError } from "../../src/domain/errors.js";
import { MutationAuthorityContext } from "../../src/ports/mutation-intent-store.port.js";

const sha256 = (c: string) => createHash("sha256").update(c).digest("hex");
const RUN = "run-gen-01";
const NOW = "2026-10-28T12:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";
const authority: MutationAuthorityContext = {
  authority: "SUPERVISOR",
  supervisorFencing: { supervisorId: "sup", leaseId: "sup-lease", nowIso: NOW },
};

describe("Rollback generations and chained-mutation recovery", () => {
  let db: DatabaseSync;
  let store: SqliteStateStore;
  let engine: DurableRollbackEngine;
  let tempDir: string;
  let ws: string;
  let snapDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eaf-gen-"));
    ws = path.join(tempDir, "workspace");
    snapDir = path.join(ws, ".emerald", "snapshots", RUN);
    fs.mkdirSync(snapDir, { recursive: true });
    db = createSqliteClient({ location: ":memory:" });
    store = new SqliteStateStore(db);
    engine = new DurableRollbackEngine(store);
    store.transaction((tx) => {
      tx.insertTask({ taskId: "t", title: "t", description: "d", inputPayload: {}, createdAt: NOW, updatedAt: NOW });
      tx.insertWorker({ workerId: "w", hostname: "h", pid: process.pid, status: "ACTIVE", lastHeartbeatAt: NOW, createdAt: NOW });
      tx.insertRun(
        {
          runId: RUN, taskId: "t", status: "RECOVERING", version: 1, attemptCount: 1, maxAttempts: 3, timeoutMs: 30000,
          idempotencyKey: null, currentWorkerId: "w", leaseId: "l", leaseExpiresAt: FUTURE,
          resultPayload: null, errorPayload: null, createdAt: NOW, updatedAt: NOW, contractBinding: null, maxOutputBytes: null,
        },
        { eventId: "e1", runId: RUN, timestamp: NOW, eventType: "run.created", schemaVersion: 1, producer: "test", payload: {} }
      );
      tx.insertLease({ leaseId: "l", workerId: "w", runId: RUN, state: "ACTIVE", acquiredAt: NOW, expiresAt: FUTURE, releasedAt: null });
    });
    db.prepare(
      `INSERT INTO supervisor_leases (lease_id, run_id, supervisor_id, acquired_at, expires_at, state) VALUES ('sup-lease', ?, 'sup', ?, ?, 'ACTIVE')`
    ).run(RUN, NOW, FUTURE);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  let counter = 0;
  /** Records an intent and puts the disk/snapshot in the state a crash at that lifecycle point leaves. */
  function addIntent(o: {
    rel: string;
    base: string | "ABSENT";
    mutated: string;
    status: MutationLifecycleStatus;
    version?: number;
    parent?: string | null;
    diskHoldsMutated?: boolean;
    snapshot?: boolean;
  }) {
    const id = `m${++counter}`;
    const target = path.resolve(ws, o.rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const holdsMutated = o.diskHoldsMutated ?? true;
    if (holdsMutated) fs.writeFileSync(target, o.mutated);
    else if (o.base !== "ABSENT") fs.writeFileSync(target, o.base);
    const snap = path.resolve(snapDir, `${id}.snap`);
    if (o.snapshot !== false && o.base !== "ABSENT") fs.writeFileSync(snap, o.base);
    store.recordIntent({
      mutationId: id, runId: RUN, workerLeaseId: "l", relativePath: o.rel, canonicalPath: target,
      parentMutationId: o.parent ?? null, pathMutationVersion: o.version ?? 1,
      baseDigest: o.base === "ABSENT" ? "ABSENT" : sha256(o.base), expectedResultingDigest: sha256(o.mutated),
      snapshotRef: snap, recoveryDedupToken: computeRecoveryDedupToken(RUN, id, o.status),
      lifecycleStatus: o.status, createdAt: Date.now(), updatedAt: Date.now(),
    });
    return { id, target, snap };
  }

  const rollback = (extra?: { assertAuthorityActive?: () => void }) =>
    engine.executeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: authority, ...extra });
  const status = (id: string) => store.getIntent(id)?.lifecycleStatus;

  /** First attempt crashes, is rolled back (generation 1 COMPLETED). Its snapshots are then deleted. */
  async function completeGenerationOne() {
    const a = addIntent({ rel: "old.ts", base: "OLD0", mutated: "OLD1", status: "COMMITTED" });
    expect((await rollback()).status).toBe("COMPLETED");
    expect(fs.readFileSync(a.target, "utf8")).toBe("OLD0");
    expect(store.getRunRollback(RUN)?.status).toBe("COMPLETED");
    fs.rmSync(a.snap); // workspace cleanup between attempts
    return a;
  }

  it("a DIFFERENT new path in the second attempt: only it is planned and restored; the old path is untouched", async () => {
    const old = await completeGenerationOne();
    const b = addIntent({ rel: "src/new.ts", base: "B0", mutated: "B1", status: "COMMITTED" });

    const result = await rollback();

    expect(result.status).toBe("COMPLETED");
    expect(result.totalPaths).toBe(1);
    expect(result.restoredPaths).toEqual(["src/new.ts"]);
    expect(fs.readFileSync(b.target, "utf8")).toBe("B0");
    expect(fs.readFileSync(old.target, "utf8")).toBe("OLD0");
    expect(status(b.id)).toBe("ROLLED_BACK");
    expect(store.getPathRollbackProgress(RUN, "old.ts")).toBeNull(); // old generation's progress retired
  });

  it("a NEW file (ABSENT baseline) created by the second attempt is removed", async () => {
    await completeGenerationOne();
    const c = addIntent({ rel: "src/created.ts", base: "ABSENT", mutated: "NEWFILE", status: "COMMITTED" });
    expect(fs.existsSync(c.target)).toBe(true);

    const result = await rollback();

    expect(result.status).toBe("COMPLETED");
    expect(fs.existsSync(c.target)).toBe(false);
    expect(status(c.id)).toBe("ROLLED_BACK");
  });

  it("second-attempt intents in RECORDED, SNAPSHOT_WRITTEN and APPLYING_MUTATION states are each reconciled correctly", async () => {
    await completeGenerationOne();
    const rec = addIntent({ rel: "s/rec.ts", base: "R0", mutated: "R1", status: "RECORDED", diskHoldsMutated: false, snapshot: false });
    const snapW = addIntent({ rel: "s/snap.ts", base: "S0", mutated: "S1", status: "SNAPSHOT_WRITTEN", diskHoldsMutated: false });
    const applying = addIntent({ rel: "s/app.ts", base: "A0", mutated: "A1", status: "APPLYING_MUTATION", diskHoldsMutated: true });

    const result = await rollback();

    expect(result.status).toBe("COMPLETED");
    expect(result.totalPaths).toBe(3);
    expect(status(rec.id)).toBe("ABORTED_UNMUTATED");
    expect(status(snapW.id)).toBe("ABORTED_UNMUTATED");
    expect(status(applying.id)).toBe("ROLLED_BACK");
    expect(fs.readFileSync(rec.target, "utf8")).toBe("R0");
    expect(fs.readFileSync(snapW.target, "utf8")).toBe("S0");
    expect(fs.readFileSync(applying.target, "utf8")).toBe("A0");
  });

  it("VERIFIED_PASS: a crashed attempt's verified mutation is rolled back, not left on disk", async () => {
    const v = addIntent({ rel: "src/v.ts", base: "V0", mutated: "V1", status: "VERIFIED_PASS" });

    const result = await rollback();

    expect(result.status).toBe("COMPLETED");
    expect(fs.readFileSync(v.target, "utf8")).toBe("V0");
    expect(status(v.id)).toBe("ROLLED_BACK");
  });

  it("VERIFIED_PASS in the SECOND attempt after a completed first rollback is not hidden by the cached COMPLETED record", async () => {
    await completeGenerationOne();
    const v = addIntent({ rel: "src/v2.ts", base: "W0", mutated: "W1", status: "VERIFIED_PASS" });

    const result = await rollback();

    expect(result.totalPaths).toBe(1);
    expect(fs.readFileSync(v.target, "utf8")).toBe("W0");
    expect(status(v.id)).toBe("ROLLED_BACK");
  });

  it("VERIFIED_PASS from the first attempt does not make the second generation need its (deleted) snapshot", async () => {
    const first = addIntent({ rel: "src/p.ts", base: "P0", mutated: "P1", status: "VERIFIED_PASS", version: 1 });
    expect((await rollback()).status).toBe("COMPLETED");
    expect(status(first.id)).toBe("ROLLED_BACK");
    fs.rmSync(first.snap);

    const second = addIntent({ rel: "src/p.ts", base: "P0", mutated: "P2", status: "COMMITTED", version: 2, parent: first.id });
    const result = await rollback();

    expect(result.status).toBe("COMPLETED");
    expect(fs.readFileSync(second.target, "utf8")).toBe("P0");
  });

  it("generation cut keeps an earlier pending intent: [v1 COMMITTED, v2 ABORTED_UNMUTATED] restores v1 and completes", async () => {
    const v1 = addIntent({ rel: "src/chain.ts", base: "C0", mutated: "C1", status: "COMMITTED", version: 1 });
    const v2 = addIntent({ rel: "src/chain.ts", base: "C1", mutated: "C2", status: "ABORTED_UNMUTATED", version: 2, parent: v1.id, diskHoldsMutated: false, snapshot: false });
    fs.writeFileSync(v1.target, "C1"); // disk holds v1's result

    const result = await rollback();

    expect(result.status).toBe("COMPLETED");
    expect(result.totalPaths).toBe(1);
    expect(fs.readFileSync(v1.target, "utf8")).toBe("C0");
    expect(status(v1.id)).toBe("ROLLED_BACK");
    expect(status(v2.id)).toBe("ABORTED_UNMUTATED");
    // and the next call does not loop (reset + re-record) because nothing is pending any more
    expect((await rollback()).status).toBe("COMPLETED");
    expect(store.getRunRollback(RUN)?.status).toBe("COMPLETED");
  });

  it("chained mutations accept the intermediate digest: [v1 COMMITTED (disk D1), v2 APPLYING (not yet renamed)] is not a false conflict", async () => {
    const v1 = addIntent({ rel: "src/c2.ts", base: "D0", mutated: "D1", status: "COMMITTED", version: 1 });
    addIntent({ rel: "src/c2.ts", base: "D1", mutated: "D2", status: "APPLYING_MUTATION", version: 2, parent: v1.id, diskHoldsMutated: true });
    fs.writeFileSync(v1.target, "D1"); // v2's rename never happened

    const result = await rollback();

    expect(result.status).toBe("COMPLETED");
    expect(fs.readFileSync(v1.target, "utf8")).toBe("D0");
  });

  it("an external edit that matches no chain digest is still a conflict and the file is preserved", async () => {
    const v1 = addIntent({ rel: "src/c3.ts", base: "E0", mutated: "E1", status: "COMMITTED", version: 1 });
    addIntent({ rel: "src/c3.ts", base: "E1", mutated: "E2", status: "APPLYING_MUTATION", version: 2, parent: v1.id });
    fs.writeFileSync(v1.target, "SOMEONE ELSE");

    const result = await rollback();

    expect(result.status).toBe("PARTIALLY_ROLLED_BACK_CONFLICT");
    expect(fs.readFileSync(v1.target, "utf8")).toBe("SOMEONE ELSE");
  });

  it("a conflict in the second generation preserves the file and is not reset or re-run on the next call", async () => {
    await completeGenerationOne();
    const b = addIntent({ rel: "src/conf.ts", base: "F0", mutated: "F1", status: "COMMITTED" });
    fs.writeFileSync(b.target, "EXTERNAL");

    const first = await rollback();
    expect(first.status).toBe("PARTIALLY_ROLLED_BACK_CONFLICT");
    expect(fs.readFileSync(b.target, "utf8")).toBe("EXTERNAL");

    const second = await rollback();
    expect(second.status).toBe("PARTIALLY_ROLLED_BACK_CONFLICT");
    expect(store.getRunRollback(RUN)?.status).toBe("PARTIALLY_ROLLED_BACK_CONFLICT");
    expect(fs.readFileSync(b.target, "utf8")).toBe("EXTERNAL");
  });

  it("resume after a crash in the middle of the second generation finishes only what is left (mix of old and new paths)", async () => {
    await completeGenerationOne();
    const a = addIntent({ rel: "g2/a.ts", base: "GA0", mutated: "GA1", status: "COMMITTED" });
    const b = addIntent({ rel: "g2/b.ts", base: "GB0", mutated: "GB1", status: "COMMITTED" });

    // Authority is lost right before path b's rename: a is fully restored, b is mid-restore.
    // fence calls: 1 up-front, 2 a:before temp, 3 a:before rename, 4 b:before temp, 5 b:before rename
    let calls = 0;
    await expect(
      rollback({
        assertAuthorityActive: () => {
          if (++calls >= 5) throw new SupervisorLeaseLostError(RUN, "sup", "other");
        },
      })
    ).rejects.toBeInstanceOf(SupervisorLeaseLostError);
    expect(fs.readFileSync(a.target, "utf8")).toBe("GA0");
    expect(fs.readFileSync(b.target, "utf8")).toBe("GB1");
    expect(status(a.id)).toBe("ROLLED_BACK");

    const resumed = await engine.resumeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: authority });

    expect(resumed.status).toBe("COMPLETED");
    expect(fs.readFileSync(b.target, "utf8")).toBe("GB0");
    expect(status(b.id)).toBe("ROLLED_BACK");
    expect(fs.readFileSync(a.target, "utf8")).toBe("GA0");
  });

  it("the old generation's evidence survives: its intents and rolled-back events are still on record", async () => {
    const old = await completeGenerationOne();
    addIntent({ rel: "src/new2.ts", base: "N0", mutated: "N1", status: "COMMITTED" });
    await rollback();

    expect(status(old.id)).toBe("ROLLED_BACK");
    const rolledBack = store.getEventsForRun(RUN).filter((e) => e.eventType === "file.mutation_rolled_back");
    expect(rolledBack).toHaveLength(2);
  });
});
