/**
 * Emerald Agent Fabric — Read-Only Quarantine Diagnostics CLI Tests (F-7.3)
 *
 * Verifies that `emerald recovery status` satisfies all safety invariants:
 * - Read-only inspection of tenant launch-gate records.
 * - Displays the eight schema fields only (withholding internal token and lease_id).
 * - Leaves database bytes and QUARANTINED state completely unmutated.
 * - Invokes no recovery sweeps, gate releases, workspace operations, or Docker calls.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { EmeraldCli } from "../../src/cli/emerald-cli.js";
import {
  projectLaunchGateDiagnostic,
  readTenantLaunchGateDiagnostics,
} from "../../src/recovery/quarantine-diagnostics.js";
import type { TenantLaunchGate } from "../../src/ports/tenant-launch-coordinator.port.js";

import { RunCoordinator } from "../../src/application/index.js";
import { createAndActivateContract } from "../application/test-helpers.js";

const sha256File = (filePath: string): string =>
  createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");

describe("emerald recovery status (Read-Only Diagnostics)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-recovery-status-"));
    dbPath = path.join(tempDir, "fabric.db");
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  /** Creates a task and run using domain coordinator so all foreign key constraints are satisfied. */
  function seedRun(store: SqliteStateStore, runId: string): void {
    const coordinator = new RunCoordinator(store);
    const task = coordinator.createTask({ title: "diagnostic-task", inputPayload: {} });
    createAndActivateContract(store, task.taskId);
    // Explicitly insert run row with the requested runId
    const db = (store as any).db;
    db.prepare(`
      INSERT OR REPLACE INTO runs (run_id, task_id, status, attempt_count, max_attempts, created_at, updated_at)
      VALUES (?, ?, 'RUNNING', 1, 3, '2026-11-02T12:00:00.000Z', '2026-11-02T12:00:00.000Z')
    `).run(runId, task.taskId);
  }

  it("handles an empty tenant_launch_gates table clearly", async () => {
    const store = new SqliteStateStore({ location: dbPath });
    store.close();

    const cli = new EmeraldCli();
    const res = await cli.run(["recovery", "status", "--db", dbPath]);

    expect(res.exitCode).toBe(0);
    expect(res.output).toBe("No tenant launch gates found.");

    // JSON mode on empty table returns empty array
    const jsonRes = await cli.run(["recovery", "status", "--db", dbPath, "--json"]);
    expect(jsonRes.exitCode).toBe(0);
    expect(JSON.parse(jsonRes.output)).toEqual([]);
  });

  it("projects only the exact eight approved fields in projectLaunchGateDiagnostic", () => {
    const gate: TenantLaunchGate = {
      runId: "run-abc",
      holderType: "WORKER",
      holderId: "w-1",
      leaseId: "lease-secret-123",
      token: "crypto-secret-token-456",
      acquiredAt: "2026-11-02T12:00:00.000Z",
      expiresAt: "2026-11-02T12:00:30.000Z",
      releasedAt: "2026-11-02T12:00:25.000Z",
      state: "RELEASED",
      ownerPid: 54321,
    };

    const proj = projectLaunchGateDiagnostic(gate);
    const keys = Object.keys(proj).sort();

    expect(keys).toEqual([
      "acquired_at",
      "expires_at",
      "holder_id",
      "holder_type",
      "owner_pid",
      "released_at",
      "run_id",
      "state",
    ]);

    expect((proj as any).leaseId).toBeUndefined();
    expect((proj as any).lease_id).toBeUndefined();
    expect((proj as any).token).toBeUndefined();
    expect((proj as any).reason).toBeUndefined();
  });

  it("renders all eight fields correctly and withholds internal secrets", async () => {
    const store = new SqliteStateStore({ location: dbPath });
    seedRun(store, "run-single");
    store.acquireTenantLaunchGate({
      runId: "run-single",
      holderType: "WORKER",
      holderId: "worker-node-42",
      leaseId: "sensitive-lease-id-777",
      nowIso: "2026-11-02T14:00:00.000Z",
      ttlMs: 30_000,
      ownerPid: 8888,
    });
    store.close();

    const cli = new EmeraldCli();
    const res = await cli.run(["recovery", "status", "--db", dbPath]);

    expect(res.exitCode).toBe(0);
    expect(res.output).toContain("Tenant Launch Gate Status:");
    expect(res.output).toContain("run_id:      run-single");
    expect(res.output).toContain("holder_type: WORKER");
    expect(res.output).toContain("holder_id:   worker-node-42");
    expect(res.output).toContain("state:       ACQUIRED");
    expect(res.output).toContain("acquired_at: 2026-11-02T14:00:00.000Z");
    expect(res.output).toContain("expires_at:  2026-11-02T14:00:30.000Z");
    expect(res.output).toContain("released_at: none");
    expect(res.output).toContain("owner_pid:   8888");

    // Strictly ensure internal secrets are not leaked
    expect(res.output).not.toContain("sensitive-lease-id-777");
    expect(res.output).not.toContain("token");
  });

  it("displays multiple gate records deterministically ordered", async () => {
    const store = new SqliteStateStore({ location: dbPath });
    seedRun(store, "run-b");
    seedRun(store, "run-a");

    store.acquireTenantLaunchGate({
      runId: "run-b",
      holderType: "WORKER",
      holderId: "worker-b",
      leaseId: "lease-b",
      nowIso: "2026-11-02T10:00:00.000Z",
      ttlMs: 10_000,
    });

    store.acquireTenantLaunchGate({
      runId: "run-a",
      holderType: "RECOVERY",
      holderId: "supervisor-1",
      leaseId: "lease-a",
      nowIso: "2026-11-02T10:05:00.000Z",
      ttlMs: 15_000,
      ownerPid: 101,
    });
    store.close();

    const cli = new EmeraldCli();
    const res = await cli.run(["recovery", "status", "--db", dbPath]);

    expect(res.exitCode).toBe(0);
    expect(res.output).toContain("Tenant Launch Gate Status (2 records):");

    // Ordered by acquired_at ASC: run-b (10:00:00) before run-a (10:05:00)
    const idxB = res.output.indexOf("run_id:      run-b");
    const idxA = res.output.indexOf("run_id:      run-a");
    expect(idxB).toBeGreaterThan(-1);
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeLessThan(idxA);

    // JSON array formatting
    const jsonRes = await cli.run(["recovery", "status", "--db", dbPath, "--json"]);
    expect(jsonRes.exitCode).toBe(0);
    const parsed = JSON.parse(jsonRes.output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].run_id).toBe("run-b");
    expect(parsed[1].run_id).toBe("run-a");
  });

  it("inspects QUARANTINED state without modifying or clearing it", async () => {
    const store = new SqliteStateStore({ location: dbPath });
    seedRun(store, "run-quarantine");
    store.quarantineTenantLaunchGate({
      runId: "run-quarantine",
      nowIso: "2026-11-02T15:00:00.000Z",
      reason: "termination unverified",
    });
    store.close();

    const cli = new EmeraldCli();
    const res = await cli.run(["recovery", "status", "--db", dbPath, "--run-id", "run-quarantine"]);

    expect(res.exitCode).toBe(0);
    expect(res.output).toContain("run_id:      run-quarantine");
    expect(res.output).toContain("state:       QUARANTINED");
    expect(res.output).toContain("holder_type: QUARANTINE");
    expect(res.output).toContain("holder_id:   quarantine");

    // Reopen database directly and verify record was completely unmutated
    const verifyStore = new SqliteStateStore({ location: dbPath });
    const gate = verifyStore.getTenantLaunchGate("run-quarantine");
    verifyStore.close();

    expect(gate).not.toBeNull();
    expect(gate?.state).toBe("QUARANTINED");
    expect(gate?.holderType).toBe("QUARANTINE");
    expect(gate?.holderId).toBe("quarantine");
  });

  it("proves strict read-only guarantee with byte-level checksum stability", async () => {
    const store = new SqliteStateStore({ location: dbPath });
    seedRun(store, "run-hash-check");
    store.acquireTenantLaunchGate({
      runId: "run-hash-check",
      holderType: "WORKER",
      holderId: "worker-check",
      leaseId: "lease-check",
      nowIso: "2026-11-02T16:00:00.000Z",
      ttlMs: 20_000,
    });
    // Checkpoint and close store so bytes are flushed
    (store as any).db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    store.close();

    const hashBefore = sha256File(dbPath);

    const cli = new EmeraldCli();
    const res = await cli.run(["recovery", "status", "--db", dbPath]);
    expect(res.exitCode).toBe(0);

    const jsonRes = await cli.run(["recovery", "status", "--db", dbPath, "--json"]);
    expect(jsonRes.exitCode).toBe(0);

    const hashAfter = sha256File(dbPath);
    expect(hashAfter).toBe(hashBefore);
  });

  it("handles non-existent run query with clear not-found message", async () => {
    const store = new SqliteStateStore({ location: dbPath });
    store.close();

    const cli = new EmeraldCli();
    const res = await cli.run(["recovery", "status", "--db", dbPath, "--run-id", "non-existent-run"]);

    expect(res.exitCode).toBe(0);
    expect(res.output).toBe("No tenant launch gate found for run 'non-existent-run'.");

    const jsonRes = await cli.run(["recovery", "status", "--db", dbPath, "--run-id", "non-existent-run", "--json"]);
    expect(jsonRes.exitCode).toBe(0);
    expect(jsonRes.output).toBe("null");
  });

  it("handles database errors and invalid CLI usage safely without mutation", async () => {
    const cli = new EmeraldCli();

    // Missing --db
    const noDb = await cli.run(["recovery", "status"]);
    expect(noDb.exitCode).toBe(1);
    expect(noDb.output).toContain("Error: --db is required");

    // :memory: rejected
    const memDb = await cli.run(["recovery", "status", "--db", ":memory:"]);
    expect(memDb.exitCode).toBe(1);
    expect(memDb.output).toContain("not :memory:");

    // Non-existent file
    const missingFile = path.join(tempDir, "does-not-exist.sqlite");
    const noFile = await cli.run(["recovery", "status", "--db", missingFile]);
    expect(noFile.exitCode).toBe(1);
    expect(noFile.output).toContain("Database not found (recovery status never creates one)");
    expect(fs.existsSync(missingFile)).toBe(false);

    // Empty file
    const emptyFile = path.join(tempDir, "empty.sqlite");
    fs.writeFileSync(emptyFile, "");
    const emptyRes = await cli.run(["recovery", "status", "--db", emptyFile]);
    expect(emptyRes.exitCode).toBe(1);
    expect(emptyRes.output).toContain("Database file is empty");

    // Non-SQLite garbage file
    const garbageFile = path.join(tempDir, "garbage.sqlite");
    fs.writeFileSync(garbageFile, "this is definitely not a sqlite database file header");
    const garbageRes = await cli.run(["recovery", "status", "--db", garbageFile]);
    expect(garbageRes.exitCode).toBe(1);
    expect(garbageRes.output).toContain("Database access failed");

    // Unknown option
    const unknownOpt = await cli.run(["recovery", "status", "--db", dbPath, "--unknown"]);
    expect(unknownOpt.exitCode).toBe(1);
    expect(unknownOpt.output).toContain("unknown option");
  });

  it("unit query function handles direct programmatic invocation", () => {
    const missing = readTenantLaunchGateDiagnostics({ dbPath: path.join(tempDir, "missing.db") });
    expect(missing.status).toBe("ERROR");

    const store = new SqliteStateStore({ location: dbPath });
    seedRun(store, "direct-run");
    store.acquireTenantLaunchGate({
      runId: "direct-run",
      holderType: "WORKER",
      holderId: "direct-w",
      leaseId: "l-dir",
      nowIso: "2026-11-02T18:00:00.000Z",
    });
    store.close();

    const okAll = readTenantLaunchGateDiagnostics({ dbPath });
    expect(okAll.status).toBe("OK");
    if (okAll.status === "OK") {
      expect(okAll.records).toHaveLength(1);
      expect(okAll.records[0]!.run_id).toBe("direct-run");
    }

    const okSingle = readTenantLaunchGateDiagnostics({ dbPath, runId: "direct-run" });
    expect(okSingle.status).toBe("OK");
    if (okSingle.status === "OK") {
      expect(okSingle.records[0]!.holder_type).toBe("WORKER");
    }

    const notFound = readTenantLaunchGateDiagnostics({ dbPath, runId: "missing-run" });
    expect(notFound.status).toBe("NOT_FOUND");
  });
});
