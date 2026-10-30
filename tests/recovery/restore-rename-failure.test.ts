/**
 * Legacy contract D2: if the atomic rename fails during restore (e.g. EPERM on Windows),
 * the temp file is removed, the target keeps its pre-restore content, and the failure is
 * recorded as a conflict rather than silently ignored.
 *
 * node:fs is mocked only to make renameSync fail on demand; all other behavior is real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const control = vi.hoisted(() => ({ failRename: false, renameAttempts: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (control.failRename) {
        control.renameAttempts++;
        const err = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      return actual.renameSync(...args);
    },
  };
});

import { createSqliteClient } from "../../src/adapters/persistence/sqlite-client.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { DurableRollbackEngine } from "../../src/recovery/durable-rollback-engine.js";
import { computeRecoveryDedupToken } from "../../src/domain/mutation-intent.js";
import { SupervisorLeaseLostError } from "../../src/domain/errors.js";
import { MutationAuthorityContext } from "../../src/ports/mutation-intent-store.port.js";

const sha256 = (c: string) => createHash("sha256").update(c).digest("hex");
const RUN = "run-rename-01";
const NOW = "2026-10-28T12:00:00.000Z";
const authority: MutationAuthorityContext = {
  authority: "SUPERVISOR",
  supervisorFencing: { supervisorId: "sup", leaseId: "sup-lease", nowIso: NOW },
};

describe("Restore rename failure (D2)", () => {
  let db: DatabaseSync;
  let store: SqliteStateStore;
  let tempDir: string;
  let ws: string;

  beforeEach(() => {
    control.failRename = false;
    control.renameAttempts = 0;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eaf-rename-"));
    ws = path.join(tempDir, "workspace");
    fs.mkdirSync(path.join(ws, ".emerald", "snapshots", RUN), { recursive: true });
    db = createSqliteClient({ location: ":memory:" });
    store = new SqliteStateStore(db);
    store.transaction((tx) => {
      tx.insertTask({ taskId: "t", title: "t", description: "d", inputPayload: {}, createdAt: NOW, updatedAt: NOW });
      tx.insertWorker({ workerId: "w", hostname: "h", pid: process.pid, status: "ACTIVE", lastHeartbeatAt: NOW, createdAt: NOW });
      tx.insertRun(
        {
          runId: RUN, taskId: "t", status: "RECOVERING", version: 1, attemptCount: 1, maxAttempts: 3, timeoutMs: 30000,
          idempotencyKey: null, currentWorkerId: "w", leaseId: "l", leaseExpiresAt: "2099-01-01T00:00:00.000Z",
          resultPayload: null, errorPayload: null, createdAt: NOW, updatedAt: NOW, contractBinding: null, maxOutputBytes: null,
        },
        { eventId: "e1", runId: RUN, timestamp: NOW, eventType: "run.created", schemaVersion: 1, producer: "test", payload: {} }
      );
      tx.insertLease({ leaseId: "l", workerId: "w", runId: RUN, state: "ACTIVE", acquiredAt: NOW, expiresAt: "2099-01-01T00:00:00.000Z", releasedAt: null });
    });
    db.prepare(
      `INSERT INTO supervisor_leases (lease_id, run_id, supervisor_id, acquired_at, expires_at, state) VALUES ('sup-lease', ?, 'sup', ?, '2099-01-01T00:00:00.000Z', 'ACTIVE')`
    ).run(RUN, NOW);
  });

  afterEach(() => {
    control.failRename = false;
    try {
      db.close();
    } catch {
      // ignore
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("D2: failed rename removes the temp file, keeps the target as it was, and records RESTORE_FAILED", async () => {
    const target = path.join(ws, "src", "x.ts");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "MUT");
    const snap = path.join(ws, ".emerald", "snapshots", RUN, "m1.snap");
    fs.writeFileSync(snap, "BASE");
    store.recordIntent({
      mutationId: "m1", runId: RUN, workerLeaseId: "l", relativePath: "src/x.ts", canonicalPath: target,
      parentMutationId: null, pathMutationVersion: 1, baseDigest: sha256("BASE"), expectedResultingDigest: sha256("MUT"),
      snapshotRef: snap, recoveryDedupToken: computeRecoveryDedupToken(RUN, "m1", "COMMITTED"),
      lifecycleStatus: "COMMITTED", createdAt: 1, updatedAt: 1,
    });

    control.failRename = true;
    const result = await new DurableRollbackEngine(store).executeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: authority });
    control.failRename = false;

    expect(control.renameAttempts).toBeGreaterThan(0);
    expect(result.status).toBe("PARTIALLY_ROLLED_BACK_CONFLICT");
    expect(fs.readFileSync(target, "utf8")).toBe("MUT");
    expect(fs.readdirSync(path.dirname(target)).filter((f) => f.startsWith(".emerald.tmp"))).toEqual([]);
    expect(store.getPathRollbackProgress(RUN, "src/x.ts")?.status).toBe("RESTORE_FAILED");
    expect(store.getIntent("m1")?.lifecycleStatus).toBe("COMMITTED");
  });

  it("D2: when authority is lost while handling the rename failure, the temp file is preserved (no unauthorized delete)", async () => {
    const target = path.join(ws, "src", "y.ts");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "MUT");
    const snap = path.join(ws, ".emerald", "snapshots", RUN, "m2.snap");
    fs.writeFileSync(snap, "BASE");
    store.recordIntent({
      mutationId: "m2", runId: RUN, workerLeaseId: "l", relativePath: "src/y.ts", canonicalPath: target,
      parentMutationId: null, pathMutationVersion: 1, baseDigest: sha256("BASE"), expectedResultingDigest: sha256("MUT"),
      snapshotRef: snap, recoveryDedupToken: computeRecoveryDedupToken(RUN, "m2", "COMMITTED"),
      lifecycleStatus: "COMMITTED", createdAt: 1, updatedAt: 1,
    });

    let calls = 0; // 1 up-front, 2 before temp write, 3 before rename, 4 = temp discard after the failure
    const guard = () => {
      calls++;
      if (calls >= 4) throw new SupervisorLeaseLostError(RUN, "sup", "other");
    };
    control.failRename = true;
    await new DurableRollbackEngine(store).executeRollback({
      runId: RUN, workspaceRoot: ws, authorityContext: authority, assertAuthorityActive: guard,
    });
    control.failRename = false;

    expect(fs.readFileSync(target, "utf8")).toBe("MUT");
    expect(fs.readdirSync(path.dirname(target)).filter((f) => f.startsWith(".emerald.tmp"))).toHaveLength(1);
  });
});
