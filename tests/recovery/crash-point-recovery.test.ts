/**
 * Crash-point recovery (ADR-0036 CP2–CP7), exercised against real SQLite and a real
 * temporary workspace. Each test persists the exact durable state a crash would leave
 * behind, then runs recovery and asserts both disk and database outcomes.
 *
 * Mapping to the legacy contract tests in tests/contract/rollback-safety.test.ts:
 *   A3 -> CP2 tests, A4 -> CP3 tests, A5 -> CP4 test, A7/A8/D3 -> CP6/CP7 tests.
 * Not covered here (real features still missing): A6 verification-crash hook,
 * B6 lock manager, B7 path serializer, C2/C3/C5 controller rollback triggers.
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
import { RecoverySupervisor } from "../../src/recovery/recovery-supervisor.js";
import {
  MutationIntent,
  MutationLifecycleStatus,
  computeRecoveryDedupToken,
} from "../../src/domain/mutation-intent.js";
import { MutationAuthorityContext } from "../../src/ports/mutation-intent-store.port.js";
import { inProcessBinding } from "./in-process-binding.js";

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

const RUN = "run-cp-01";
const NOW = "2026-10-28T12:00:00.000Z";
const SUP_ID = "sup-cp";
const SUP_LEASE = "sup-lease-cp";

const authority: MutationAuthorityContext = {
  authority: "SUPERVISOR",
  supervisorFencing: { supervisorId: SUP_ID, leaseId: SUP_LEASE, nowIso: NOW },
};

describe("Crash-point recovery (CP2–CP7)", () => {
  let db: DatabaseSync;
  let store: SqliteStateStore;
  let engine: DurableRollbackEngine;
  let tempDir: string;
  let ws: string;
  let snapDir: string;

  function seedRun(runStatus: "RECOVERING" | "RUNNING", leaseExpiresAt: string) {
    store.transaction((tx) => {
      tx.insertTask({ taskId: "t", title: "t", description: "d", inputPayload: {}, createdAt: NOW, updatedAt: NOW });
      tx.insertWorker({ workerId: "w", hostname: "h", pid: process.pid, status: "ACTIVE", lastHeartbeatAt: NOW, createdAt: NOW });
      tx.insertRun(
        {
          runId: RUN,
          taskId: "t",
          status: runStatus,
          version: 1,
          attemptCount: 1,
          maxAttempts: 3,
          timeoutMs: 30000,
          idempotencyKey: null,
          currentWorkerId: "w",
          leaseId: "l",
          leaseExpiresAt,
          resultPayload: null,
          errorPayload: null,
          createdAt: NOW,
          updatedAt: NOW,
          contractBinding: inProcessBinding(tx, "t"),
          maxOutputBytes: 1048576,
        },
        { eventId: "e1", runId: RUN, timestamp: NOW, eventType: "run.created", schemaVersion: 1, producer: "test", payload: {} }
      );
      tx.insertLease({ leaseId: "l", workerId: "w", runId: RUN, state: "ACTIVE", acquiredAt: NOW, expiresAt: leaseExpiresAt, releasedAt: null });
    });
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eaf-cp-"));
    ws = path.join(tempDir, "workspace");
    snapDir = path.join(ws, ".emerald", "snapshots", RUN);
    fs.mkdirSync(snapDir, { recursive: true });
    db = createSqliteClient({ location: ":memory:" });
    store = new SqliteStateStore(db);
    engine = new DurableRollbackEngine(store);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Simulates the worker dying: its lease (and the run's recorded expiry) is now in the past. */
  function expireWorkerLease() {
    const past = new Date(Date.now() - 60_000).toISOString();
    db.prepare(`UPDATE runs SET lease_expires_at = ? WHERE run_id = ?`).run(past, RUN);
    db.prepare(`UPDATE leases SET expires_at = ? WHERE lease_id = 'l'`).run(past);
  }

  function withSupervisorLease() {
    db.prepare(
      `INSERT INTO supervisor_leases (lease_id, run_id, supervisor_id, acquired_at, expires_at, state) VALUES (?, ?, ?, ?, ?, 'ACTIVE')`
    ).run(SUP_LEASE, RUN, SUP_ID, NOW, "2099-01-01T00:00:00.000Z");
  }

  /** Records an intent in `status`, with disk and snapshot in the state a crash at that point leaves. */
  function crashState(opts: {
    rel: string;
    status: MutationLifecycleStatus;
    original: string;
    mutated: string;
    diskHoldsMutated: boolean;
    snapshotWritten: boolean;
    mutationId: string;
  }) {
    const target = path.resolve(ws, opts.rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, opts.diskHoldsMutated ? opts.mutated : opts.original);
    const snap = path.resolve(snapDir, `${opts.mutationId}.snap`);
    if (opts.snapshotWritten) fs.writeFileSync(snap, opts.original);
    const intent: MutationIntent = {
      mutationId: opts.mutationId,
      runId: RUN,
      workerLeaseId: "l",
      relativePath: opts.rel,
      canonicalPath: target,
      parentMutationId: null,
      pathMutationVersion: 1,
      baseDigest: sha256(opts.original),
      expectedResultingDigest: sha256(opts.mutated),
      snapshotRef: snap,
      recoveryDedupToken: computeRecoveryDedupToken(RUN, opts.mutationId, opts.status),
      lifecycleStatus: opts.status,
      createdAt: 1729900000000,
      updatedAt: 1729900000000,
    };
    store.recordIntent(intent);
    return { target, snap };
  }

  describe("with a RECOVERING run and supervisor authority", () => {
    beforeEach(() => {
      seedRun("RECOVERING", "2099-01-01T00:00:00.000Z");
      withSupervisorLease();
    });

    // CP2 (A3)
    it("CP2: intent RECORDED, no snapshot, file untouched -> ABORTED_UNMUTATED with zero modifications", async () => {
      const { target } = crashState({
        rel: "src/a.ts",
        status: "RECORDED",
        original: "BASE",
        mutated: "MUT",
        diskHoldsMutated: false,
        snapshotWritten: false,
        mutationId: "m-cp2a",
      });
      const before = fs.statSync(target);

      const result = await engine.executeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: authority });

      expect(result.status).toBe("COMPLETED");
      expect(fs.readFileSync(target, "utf8")).toBe("BASE");
      expect(fs.statSync(target).mtimeMs).toBe(before.mtimeMs);
      expect(store.getIntent("m-cp2a")?.lifecycleStatus).toBe("ABORTED_UNMUTATED");
      expect(fs.readdirSync(path.dirname(target)).filter((f) => f.startsWith(".emerald.tmp"))).toEqual([]);
    });

    it("CP2: intent SNAPSHOT_WRITTEN, file untouched -> ABORTED_UNMUTATED, file byte-for-byte unchanged", async () => {
      const { target } = crashState({
        rel: "src/b.ts",
        status: "SNAPSHOT_WRITTEN",
        original: "BASE",
        mutated: "MUT",
        diskHoldsMutated: false,
        snapshotWritten: true,
        mutationId: "m-cp2b",
      });

      const result = await engine.executeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: authority });

      expect(result.status).toBe("COMPLETED");
      expect(fs.readFileSync(target, "utf8")).toBe("BASE");
      expect(store.getIntent("m-cp2b")?.lifecycleStatus).toBe("ABORTED_UNMUTATED");
    });

    it("CP2: an unmutated intent whose file was modified externally is a conflict and the file is preserved", async () => {
      const { target } = crashState({
        rel: "src/c.ts",
        status: "SNAPSHOT_WRITTEN",
        original: "BASE",
        mutated: "MUT",
        diskHoldsMutated: false,
        snapshotWritten: true,
        mutationId: "m-cp2c",
      });
      fs.writeFileSync(target, "SOMEONE ELSE");

      const result = await engine.executeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: authority });

      expect(result.status).toBe("PARTIALLY_ROLLED_BACK_CONFLICT");
      expect(fs.readFileSync(target, "utf8")).toBe("SOMEONE ELSE");
    });

    it("CP2: a recorded new-file intent (baseline ABSENT) with no file is aborted without creating anything", async () => {
      const target = path.resolve(ws, "src/new.ts");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      store.recordIntent({
        mutationId: "m-cp2d",
        runId: RUN,
        workerLeaseId: "l",
        relativePath: "src/new.ts",
        canonicalPath: target,
        parentMutationId: null,
        pathMutationVersion: 1,
        baseDigest: "ABSENT",
        expectedResultingDigest: sha256("NEW"),
        snapshotRef: path.resolve(snapDir, "m-cp2d.snap"),
        recoveryDedupToken: computeRecoveryDedupToken(RUN, "m-cp2d", "RECORDED"),
        lifecycleStatus: "RECORDED",
        createdAt: 1,
        updatedAt: 1,
      });

      const result = await engine.executeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: authority });

      expect(result.status).toBe("COMPLETED");
      expect(fs.existsSync(target)).toBe(false);
      expect(store.getIntent("m-cp2d")?.lifecycleStatus).toBe("ABORTED_UNMUTATED");
    });

    // CP3 (A4)
    it("CP3: APPLYING_MUTATION with file already replaced -> original restored via snapshot, intent ROLLED_BACK", async () => {
      const { target } = crashState({
        rel: "src/d.ts",
        status: "APPLYING_MUTATION",
        original: "BASE",
        mutated: "MUT",
        diskHoldsMutated: true,
        snapshotWritten: true,
        mutationId: "m-cp3",
      });

      const result = await engine.executeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: authority });

      expect(result.status).toBe("COMPLETED");
      expect(fs.readFileSync(target, "utf8")).toBe("BASE");
      expect(store.getIntent("m-cp3")?.lifecycleStatus).toBe("ROLLED_BACK");
    });

    it("CP3: APPLYING_MUTATION where the rename never happened -> file left at baseline, intent ROLLED_BACK", async () => {
      const { target } = crashState({
        rel: "src/e.ts",
        status: "APPLYING_MUTATION",
        original: "BASE",
        mutated: "MUT",
        diskHoldsMutated: false,
        snapshotWritten: true,
        mutationId: "m-cp3b",
      });

      const result = await engine.executeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: authority });

      expect(result.status).toBe("COMPLETED");
      expect(fs.readFileSync(target, "utf8")).toBe("BASE");
      expect(store.getIntent("m-cp3b")?.lifecycleStatus).toBe("ROLLED_BACK");
    });

    // CP4 (A5)
    it("CP4: COMMITTED but unverified mutation is rolled back, leaving no untracked mutation", async () => {
      const { target } = crashState({
        rel: "src/f.ts",
        status: "COMMITTED",
        original: "BASE",
        mutated: "MUT",
        diskHoldsMutated: true,
        snapshotWritten: true,
        mutationId: "m-cp4",
      });

      const result = await engine.executeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: authority });

      expect(result.status).toBe("COMPLETED");
      expect(fs.readFileSync(target, "utf8")).toBe("BASE");
      expect(store.getIntent("m-cp4")?.lifecycleStatus).toBe("ROLLED_BACK");
    });

    // CP7 (A8 / D3)
    it("CP7: disk already restored but DB not updated -> recovery commits the event idempotently without rewriting", async () => {
      const { target } = crashState({
        rel: "src/g.ts",
        status: "COMMITTED",
        original: "BASE",
        mutated: "MUT",
        diskHoldsMutated: false, // restored before the crash
        snapshotWritten: true,
        mutationId: "m-cp7",
      });
      const before = fs.statSync(target).mtimeMs;

      const first = await engine.executeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: authority });
      expect(first.status).toBe("COMPLETED");
      expect(fs.statSync(target).mtimeMs).toBe(before);
      expect(store.getIntent("m-cp7")?.lifecycleStatus).toBe("ROLLED_BACK");

      const events = store.getEventsForRun(RUN).filter((e) => e.eventType === "file.mutation_rolled_back");
      expect(events).toHaveLength(1);

      const second = await engine.executeRollback({ runId: RUN, workspaceRoot: ws, authorityContext: authority });
      expect(second.status).toBe("COMPLETED");
      expect(store.getEventsForRun(RUN).filter((e) => e.eventType === "file.mutation_rolled_back")).toHaveLength(1);
    });
  });

  describe("end to end through the RecoverySupervisor", () => {
    it("CP3 via supervisor: expired worker lease + bound workspace -> RECOVERED, file restored, run handed off (never COMPLETED)", async () => {
      seedRun("RUNNING", "2099-01-01T00:00:00.000Z");
      const { target } = crashState({
        rel: "src/h.ts",
        status: "APPLYING_MUTATION",
        original: "BASE",
        mutated: "MUT",
        diskHoldsMutated: true,
        snapshotWritten: true,
        mutationId: "m-sup-cp3",
      });
      store.bindRunWorkspace(RUN, fs.realpathSync(ws), NOW);
      expireWorkerLease();

      const supervisor = new RecoverySupervisor({ stateStore: store, rollbackEngine: engine, supervisorId: SUP_ID });
      const outcome = await supervisor.recoverRun(RUN);

      expect(outcome.status).toBe("RECOVERED");
      expect(outcome.statusAfter).toBe("RECOVERING"); // attempts remain: handed off, not failed
      expect(fs.readFileSync(target, "utf8")).toBe("BASE");
      expect(store.getIntent("m-sup-cp3")?.lifecycleStatus).toBe("ROLLED_BACK");
      expect(store.getRun(RUN)?.status).toBe("RECOVERING");
    });

    it("CP2 via supervisor: unmutated crash state recovers without touching the file", async () => {
      seedRun("RUNNING", "2099-01-01T00:00:00.000Z");
      const { target } = crashState({
        rel: "src/i.ts",
        status: "RECORDED",
        original: "BASE",
        mutated: "MUT",
        diskHoldsMutated: false,
        snapshotWritten: false,
        mutationId: "m-sup-cp2",
      });
      expireWorkerLease();
      const supervisor = new RecoverySupervisor({ stateStore: store, rollbackEngine: engine, supervisorId: SUP_ID });
      const outcome = await supervisor.recoverRun(RUN, { workspaceRoot: ws });

      expect(outcome.status).toBe("RECOVERED");
      expect(fs.readFileSync(target, "utf8")).toBe("BASE");
      expect(store.getIntent("m-sup-cp2")?.lifecycleStatus).toBe("ABORTED_UNMUTATED");
    });

    // F10
    it("F10: a run with zero mutation intents is flagged as having no recorded evidence", async () => {
      seedRun("RUNNING", "2099-01-01T00:00:00.000Z");
      expireWorkerLease();
      const supervisor = new RecoverySupervisor({ stateStore: store, rollbackEngine: engine, supervisorId: SUP_ID });
      const outcome = await supervisor.recoverRun(RUN, { workspaceRoot: ws });

      expect(outcome.status).toBe("RECOVERED_UNVERIFIED");
      expect(outcome.noMutationIntentsRecorded).toBe(true);
      expect(outcome.details).toMatch(/no mutation intents/i);
    });

    // F9
    it("F9: worker-lease expiry is re-proven inside the transition transaction (stale pre-check cannot reclaim a live lease)", async () => {
      seedRun("RUNNING", "2099-01-01T00:00:00.000Z"); // lease was renewed: genuinely active in the database
      const live = store.getRun(RUN)!;
      const staleView = Object.create(store, {
        getRun: {
          // The pre-acquisition candidate read observed the old, expired lease.
          value: (id: string, ...rest: unknown[]) =>
            id === RUN && staleCalls++ === 0
              ? { ...live, leaseExpiresAt: new Date(Date.now() - 60_000).toISOString() }
              : (store.getRun as (...a: unknown[]) => unknown)(id, ...rest),
        },
      });
      let staleCalls = 0;
      const supervisor = new RecoverySupervisor({ stateStore: staleView, rollbackEngine: engine, supervisorId: SUP_ID });

      await expect(supervisor.recoverRun(RUN, { workspaceRoot: ws })).rejects.toThrow(/unexpired|active worker lease/i);
      expect(store.getRun(RUN)?.status).toBe("RUNNING");
      expect(store.getRun(RUN)?.version).toBe(live.version);
    });

    // F8
    it("F8: a store that cannot validate supervisor fencing fails closed instead of skipping the check", async () => {
      seedRun("RUNNING", "2099-01-01T00:00:00.000Z");
      crashState({
        rel: "src/j.ts",
        status: "COMMITTED",
        original: "BASE",
        mutated: "MUT",
        diskHoldsMutated: true,
        snapshotWritten: true,
        mutationId: "m-f8",
      });
      expireWorkerLease();
      const noFencing = Object.create(store, { validateSupervisorFencing: { value: undefined } });
      const supervisor = new RecoverySupervisor({ stateStore: noFencing, rollbackEngine: engine, supervisorId: SUP_ID });

      await expect(supervisor.recoverRun(RUN, { workspaceRoot: ws })).rejects.toThrow(/cannot validate supervisor fencing/);
      expect(fs.readFileSync(path.resolve(ws, "src/j.ts"), "utf8")).toBe("MUT");
    });
  });
});
