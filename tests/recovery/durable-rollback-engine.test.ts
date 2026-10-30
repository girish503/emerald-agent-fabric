import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteClient } from "../../src/adapters/persistence/sqlite-client.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { DurableRollbackEngine } from "../../src/recovery/durable-rollback-engine.js";
import {
  MutationIntent,
  computeRecoveryDedupToken,
} from "../../src/domain/mutation-intent.js";
import {
  MissingMutationAuthorityError,
  SnapshotContainmentError,
  SupervisorLeaseExpiredError,
  SupervisorLeaseLostError,
  TerminalStateError,
  UnauthorizedMutationTransitionError,
} from "../../src/domain/errors.js";
import { MutationAuthorityContext } from "../../src/ports/mutation-intent-store.port.js";
import { RunSnapshot } from "../../src/domain/invariants.js";

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("Phase 48AG.3: Durable Rollback Engine Unit & Integration Tests", () => {
  let db: DatabaseSync;
  let store: SqliteStateStore;
  let engine: DurableRollbackEngine;
  let tempDir: string;
  let workspaceRoot: string;
  let snapshotDir: string;

  const TEST_RUN_ID = "run-rollback-01";
  const TEST_TASK_ID = "task-rollback-01";
  const TEST_WORKER_ID = "worker-rollback-01";
  const TEST_LEASE_ID = "lease-rollback-01";
  const TEST_SUPERVISOR_ID = "supervisor-rollback-01";
  const TEST_SUPERVISOR_LEASE_ID = "supervisor-lease-rollback-01";

  const defaultSupervisorAuthority: MutationAuthorityContext = {
    authority: "SUPERVISOR",
    supervisorFencing: {
      supervisorId: TEST_SUPERVISOR_ID,
      leaseId: TEST_SUPERVISOR_LEASE_ID,
      nowIso: "2026-10-28T12:00:00.000Z",
    },
  };

  const defaultWorkerAuthority: MutationAuthorityContext = {
    authority: "WORKER",
    fencing: {
      workerId: TEST_WORKER_ID,
      leaseId: TEST_LEASE_ID,
      nowIso: "2026-10-28T12:00:00.000Z",
    },
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eaf-durable-rollback-"));
    workspaceRoot = path.join(tempDir, "workspace");
    snapshotDir = path.join(workspaceRoot, ".emerald", "snapshots", TEST_RUN_ID);
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(snapshotDir, { recursive: true });

    db = createSqliteClient({ location: ":memory:" });
    store = new SqliteStateStore(db);
    engine = new DurableRollbackEngine(store);

    // Initialize baseline task, worker, run, worker lease, and supervisor lease
    store.transaction((tx) => {
      tx.insertTask({
        taskId: TEST_TASK_ID,
        title: "Rollback Test Task",
        description: "Testing ADR-0036 rollback engine",
        inputPayload: {},
        createdAt: "2026-10-28T12:00:00.000Z",
        updatedAt: "2026-10-28T12:00:00.000Z",
      });

      tx.insertWorker({
        workerId: TEST_WORKER_ID,
        hostname: "localhost",
        pid: process.pid,
        status: "ACTIVE",
        lastHeartbeatAt: "2026-10-28T12:00:00.000Z",
        createdAt: "2026-10-28T12:00:00.000Z",
      });

      const runSnapshot: RunSnapshot = {
        runId: TEST_RUN_ID,
        taskId: TEST_TASK_ID,
        status: "RECOVERING", // Permitted state for supervisor recovery transitions
        version: 1,
        attemptCount: 1,
        maxAttempts: 3,
        timeoutMs: 30000,
        idempotencyKey: null,
        currentWorkerId: TEST_WORKER_ID,
        leaseId: TEST_LEASE_ID,
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
        resultPayload: null,
        errorPayload: null,
        createdAt: "2026-10-28T12:00:00.000Z",
        updatedAt: "2026-10-28T12:00:00.000Z",
        contractBinding: null,
        maxOutputBytes: null,
      };

      tx.insertRun(runSnapshot, {
        eventId: "evt-run-created-rb-01",
        runId: TEST_RUN_ID,
        timestamp: "2026-10-28T12:00:00.000Z",
        eventType: "run.created",
        schemaVersion: 1,
        producer: "test",
        payload: {},
      });

      tx.insertLease({
        leaseId: TEST_LEASE_ID,
        workerId: TEST_WORKER_ID,
        runId: TEST_RUN_ID,
        state: "ACTIVE",
        acquiredAt: "2026-10-28T12:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        releasedAt: null,
      });

      db.prepare(`
        INSERT INTO supervisor_leases (lease_id, run_id, supervisor_id, acquired_at, expires_at, state)
        VALUES (?, ?, ?, ?, ?, 'ACTIVE')
      `).run(
        TEST_SUPERVISOR_LEASE_ID,
        TEST_RUN_ID,
        TEST_SUPERVISOR_ID,
        "2026-10-28T12:00:00.000Z",
        "2099-01-01T00:00:00.000Z"
      );
    });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  /**
   * Helper to set up a mutated file with snapshot and intent record.
   */
  function setupMutatedFile(params: {
    relativePath: string;
    originalContent: string;
    mutatedContent: string;
    mutationId?: string;
    pathMutationVersion?: number;
    parentMutationId?: string | null;
    runId?: string;
    workerLeaseId?: string;
  }): { intent: MutationIntent; targetPath: string; snapshotPath: string } {
    const runId = params.runId ?? TEST_RUN_ID;
    const mutationId = params.mutationId ?? `mut-${randomUUID()}`;
    const version = params.pathMutationVersion ?? 1;
    const workerLeaseId = params.workerLeaseId ?? TEST_LEASE_ID;
    const targetPath = path.resolve(workspaceRoot, params.relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    // Write mutated content on disk (simulating committed edit)
    fs.writeFileSync(targetPath, params.mutatedContent, "utf8");

    // Write pre-mutation snapshot on disk
    const snapshotPath = path.resolve(snapshotDir, `${mutationId}.snap`);
    fs.writeFileSync(snapshotPath, params.originalContent, "utf8");

    const baseDigest = sha256(params.originalContent);
    const expectedResultingDigest = sha256(params.mutatedContent);

    const intent: MutationIntent = {
      mutationId,
      runId,
      workerLeaseId,
      relativePath: params.relativePath,
      canonicalPath: targetPath,
      parentMutationId: params.parentMutationId ?? null,
      pathMutationVersion: version,
      baseDigest,
      expectedResultingDigest,
      snapshotRef: snapshotPath,
      recoveryDedupToken: computeRecoveryDedupToken(runId, mutationId, "COMMITTED"),
      lifecycleStatus: "COMMITTED",
      createdAt: 1729900000000,
      updatedAt: 1729900000000,
    };

    store.recordIntent(intent);
    return { intent, targetPath, snapshotPath };
  }

  // ==========================================================================
  // Test 1: Single-file restoration
  // ==========================================================================
  it("Test 1: Successful single-file restoration (D_0 restored, verified against SHA-256)", async () => {
    const originalContent = "export const PI = 3.14159;\n";
    const mutatedContent = "export const PI = 3.14;\n";
    const { targetPath } = setupMutatedFile({
      relativePath: "src/math.ts",
      originalContent,
      mutatedContent,
      mutationId: "mut-single-01",
    });

    const result = await engine.executeRollback({
      runId: TEST_RUN_ID,
      workspaceRoot,
      authorityContext: defaultSupervisorAuthority,
      initiatedBy: "VERIFICATION_FAILURE",
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.totalPaths).toBe(1);
    expect(result.restoredPaths).toEqual(["src/math.ts"]);
    expect(result.conflictedPaths).toEqual([]);

    // Verify disk content matches initial baseline D_0 exactly
    const restoredDiskContent = fs.readFileSync(targetPath, "utf8");
    expect(restoredDiskContent).toBe(originalContent);
    expect(sha256(restoredDiskContent)).toBe(sha256(originalContent));

    // Verify DB intent state is ROLLED_BACK
    const intent = store.getIntent("mut-single-01");
    expect(intent?.lifecycleStatus).toBe("ROLLED_BACK");

    // Verify path rollback progress row
    const progress = store.getPathRollbackProgress(TEST_RUN_ID, "src/math.ts");
    expect(progress?.status).toBe("RESTORED");

    // Verify run rollback aggregate
    const runRollback = store.getRunRollback(TEST_RUN_ID);
    expect(runRollback?.status).toBe("COMPLETED");
    expect(runRollback?.completedAt).toBeGreaterThan(0);
  });

  // ==========================================================================
  // Test 2: Multi-file restoration with deterministic ordering
  // ==========================================================================
  it("Test 2: Successful multi-file restoration with deterministic ordering", async () => {
    const fileZ = setupMutatedFile({
      relativePath: "src/z_last.ts",
      originalContent: "const Z = 26;\n",
      mutatedContent: "const Z = 99;\n",
      mutationId: "mut-z-01",
    });
    const fileA = setupMutatedFile({
      relativePath: "src/a_first.ts",
      originalContent: "const A = 1;\n",
      mutatedContent: "const A = 42;\n",
      mutationId: "mut-a-01",
    });
    const fileM = setupMutatedFile({
      relativePath: "src/m_mid.ts",
      originalContent: "const M = 13;\n",
      mutatedContent: "const M = 77;\n",
      mutationId: "mut-m-01",
    });

    const result = await engine.executeRollback({
      runId: TEST_RUN_ID,
      workspaceRoot,
      authorityContext: defaultSupervisorAuthority,
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.totalPaths).toBe(3);
    // Deterministic alphabetical ordering: a_first, m_mid, z_last
    expect(result.restoredPaths).toEqual(["src/a_first.ts", "src/m_mid.ts", "src/z_last.ts"]);

    // Verify disk content on all 3 files
    expect(fs.readFileSync(fileA.targetPath, "utf8")).toBe("const A = 1;\n");
    expect(fs.readFileSync(fileM.targetPath, "utf8")).toBe("const M = 13;\n");
    expect(fs.readFileSync(fileZ.targetPath, "utf8")).toBe("const Z = 26;\n");
  });

  // ==========================================================================
  // Test 3: Multi-mutation chain direct-to-baseline restoration
  // ==========================================================================
  it("Test 3: Multi-mutation chain direct-to-baseline restoration (D_0 -> D_1 -> D_2 -> D_0)", async () => {
    const relPath = "src/chain.ts";
    const d0 = "export function calc() { return 0; }\n";
    const d1 = "export function calc() { return 1; }\n";
    const d2 = "export function calc() { return 2; }\n";

    // Setup mut-01 (version 1)
    const targetPath = path.resolve(workspaceRoot, relPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const snapPath0 = path.resolve(snapshotDir, "mut-chain-01.snap");
    fs.writeFileSync(snapPath0, d0, "utf8");

    const intent1: MutationIntent = {
      mutationId: "mut-chain-01",
      runId: TEST_RUN_ID,
      workerLeaseId: TEST_LEASE_ID,
      relativePath: relPath,
      canonicalPath: targetPath,
      parentMutationId: null,
      pathMutationVersion: 1,
      baseDigest: sha256(d0),
      expectedResultingDigest: sha256(d1),
      snapshotRef: snapPath0,
      recoveryDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-chain-01", "COMMITTED"),
      lifecycleStatus: "COMMITTED",
      createdAt: 1729900000000,
      updatedAt: 1729900000000,
    };
    store.recordIntent(intent1);

    // Setup mut-02 (version 2)
    const snapPath1 = path.resolve(snapshotDir, "mut-chain-02.snap");
    fs.writeFileSync(snapPath1, d1, "utf8");
    fs.writeFileSync(targetPath, d2, "utf8"); // Disk is currently at D_2

    const intent2: MutationIntent = {
      mutationId: "mut-chain-02",
      runId: TEST_RUN_ID,
      workerLeaseId: TEST_LEASE_ID,
      relativePath: relPath,
      canonicalPath: targetPath,
      parentMutationId: "mut-chain-01",
      pathMutationVersion: 2,
      baseDigest: sha256(d1),
      expectedResultingDigest: sha256(d2),
      snapshotRef: snapPath1,
      recoveryDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-chain-02", "COMMITTED"),
      lifecycleStatus: "COMMITTED",
      createdAt: 1729900001000,
      updatedAt: 1729900001000,
    };
    store.recordIntent(intent2);

    const result = await engine.executeRollback({
      runId: TEST_RUN_ID,
      workspaceRoot,
      authorityContext: defaultSupervisorAuthority,
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.restoredPaths).toEqual([relPath]);

    // Restored directly from D_2 to D_0
    expect(fs.readFileSync(targetPath, "utf8")).toBe(d0);

    // Both mutations transitioned to ROLLED_BACK
    expect(store.getIntent("mut-chain-01")?.lifecycleStatus).toBe("ROLLED_BACK");
    expect(store.getIntent("mut-chain-02")?.lifecycleStatus).toBe("ROLLED_BACK");
  });

  // ==========================================================================
  // Test 4: Preflight conflict with zero filesystem restorations
  // ==========================================================================
  it("Test 4: Preflight conflict halts before touching filesystem (zero files restored)", async () => {
    // File 1: in expected state
    const file1 = setupMutatedFile({
      relativePath: "src/file1.ts",
      originalContent: "const F1 = 1;\n",
      mutatedContent: "const F1 = 100;\n",
      mutationId: "mut-pre-01",
    });

    // File 2: external user altered disk to foreign content Dx
    const file2 = setupMutatedFile({
      relativePath: "src/file2.ts",
      originalContent: "const F2 = 2;\n",
      mutatedContent: "const F2 = 200;\n",
      mutationId: "mut-pre-02",
    });
    const foreignContent = "const F2 = 'EXTERNAL_USER_EDIT';\n";
    fs.writeFileSync(file2.targetPath, foreignContent, "utf8");

    const result = await engine.executeRollback({
      runId: TEST_RUN_ID,
      workspaceRoot,
      authorityContext: defaultSupervisorAuthority,
    });

    expect(result.status).toBe("PARTIALLY_ROLLED_BACK_CONFLICT");
    expect(result.restoredPaths).toEqual([]);
    expect(result.conflictedPaths).toEqual(["src/file2.ts"]);
    expect(result.skippedPaths).toEqual(["src/file1.ts"]);

    // ZERO filesystem modifications:
    // File 1 remains untouched at mutated content (NOT restored)
    expect(fs.readFileSync(file1.targetPath, "utf8")).toBe("const F1 = 100;\n");
    // File 2 remains untouched at foreign content (PRESERVED)
    expect(fs.readFileSync(file2.targetPath, "utf8")).toBe(foreignContent);

    // Run rollback recorded as PARTIALLY_ROLLED_BACK_CONFLICT
    const runRollback = store.getRunRollback(TEST_RUN_ID);
    expect(runRollback?.status).toBe("PARTIALLY_ROLLED_BACK_CONFLICT");
  });

  // ==========================================================================
  // Test 5: Conflict after one or more paths have already been restored
  // ==========================================================================
  it("Test 5: Conflict after one or more paths restored halts immediately and preserves conflict", async () => {
    // File A: clean
    const fileA = setupMutatedFile({
      relativePath: "src/a_clean.ts",
      originalContent: "const A = 'ORIGINAL';\n",
      mutatedContent: "const A = 'MUTATED';\n",
      mutationId: "mut-part-01",
    });

    // File B: clean at preflight, but we inject conflict before B's replacement
    const fileB = setupMutatedFile({
      relativePath: "src/b_conflict.ts",
      originalContent: "const B = 'ORIGINAL';\n",
      mutatedContent: "const B = 'MUTATED';\n",
      mutationId: "mut-part-02",
    });

    // File C: sibling file that should remain PENDING / untouched
    const fileC = setupMutatedFile({
      relativePath: "src/c_pending.ts",
      originalContent: "const C = 'ORIGINAL';\n",
      mutatedContent: "const C = 'MUTATED';\n",
      mutationId: "mut-part-03",
    });

    // Preflight check will pass if we do normal preflight, but let's simulate
    // an external modification right before File B replacement.
    // To test this deterministically: corrupt fileB right after preflight.
    // We can do this by using a small subclass or modifying fileB right after recordRunRollback.
    const preRollback = store.getRunRollback(TEST_RUN_ID);
    expect(preRollback).toBeNull();

    // Let's modify fileB immediately to trigger preflight conflict or simulate intermediate conflict
    // If preflight check passed earlier: fileA restored, then fileB replaced.
    // Let's test the pre-replacement check in Layer 2 by having preflight succeed (e.g. fileB matches D_n),
    // and modifying fileB before rename.
    // Or we can test resume where fileA is already RESTORED, fileB conflicts:
    const nowMs = Date.now();
    store.recordRunRollback(
      {
        runId: TEST_RUN_ID,
        status: "RESTORING_PATHS",
        initiatedBy: "SUPERVISOR",
        createdAt: nowMs,
        completedAt: null,
      },
      [
        {
          runId: TEST_RUN_ID,
          relativePath: "src/a_clean.ts",
          status: "RESTORED",
          initialBaseDigest: sha256("const A = 'ORIGINAL';\n"),
          latestExpectedDigest: sha256("const A = 'MUTATED';\n"),
          baselineSnapshotRef: fileA.snapshotPath,
          updatedAt: nowMs,
        },
        {
          runId: TEST_RUN_ID,
          relativePath: "src/b_conflict.ts",
          status: "IN_PROGRESS",
          initialBaseDigest: sha256("const B = 'ORIGINAL';\n"),
          latestExpectedDigest: sha256("const B = 'MUTATED';\n"),
          baselineSnapshotRef: fileB.snapshotPath,
          updatedAt: nowMs,
        },
        {
          runId: TEST_RUN_ID,
          relativePath: "src/c_pending.ts",
          status: "PENDING",
          initialBaseDigest: sha256("const C = 'ORIGINAL';\n"),
          latestExpectedDigest: sha256("const C = 'MUTATED';\n"),
          baselineSnapshotRef: fileC.snapshotPath,
          updatedAt: nowMs,
        },
      ]
    );

    // Restore fileA on disk
    fs.writeFileSync(fileA.targetPath, "const A = 'ORIGINAL';\n", "utf8");
    // Modify fileB with external user content
    const foreignB = "const B = 'EXTERNAL_RACE_MODIFICATION';\n";
    fs.writeFileSync(fileB.targetPath, foreignB, "utf8");

    // Resume rollback
    const result = await engine.resumeRollback({
      runId: TEST_RUN_ID,
      workspaceRoot,
      authorityContext: defaultSupervisorAuthority,
    });

    expect(result.status).toBe("PARTIALLY_ROLLED_BACK_CONFLICT");
    expect(result.restoredPaths).toEqual(["src/a_clean.ts"]);
    expect(result.conflictedPaths).toEqual(["src/b_conflict.ts"]);
    expect(result.skippedPaths).toEqual(["src/c_pending.ts"]);

    // File A remains RESTORED
    expect(fs.readFileSync(fileA.targetPath, "utf8")).toBe("const A = 'ORIGINAL';\n");
    // File B remains PRESERVED at foreign content
    expect(fs.readFileSync(fileB.targetPath, "utf8")).toBe(foreignB);
    // File C remains UNTOUCHED at original mutated content
    expect(fs.readFileSync(fileC.targetPath, "utf8")).toBe("const C = 'MUTATED';\n");
  });

  // ==========================================================================
  // Test 6: Missing snapshot when snapshot is required
  // ==========================================================================
  it("Test 6: Missing snapshot fails-closed (zero files modified)", async () => {
    const { snapshotPath, targetPath } = setupMutatedFile({
      relativePath: "src/missing_snap.ts",
      originalContent: "const S = 'PRE';\n",
      mutatedContent: "const S = 'POST';\n",
      mutationId: "mut-missing-01",
    });

    // Delete snapshot
    fs.unlinkSync(snapshotPath);

    const result = await engine.executeRollback({
      runId: TEST_RUN_ID,
      workspaceRoot,
      authorityContext: defaultSupervisorAuthority,
    });

    expect(result.status).toBe("PARTIALLY_ROLLED_BACK_CONFLICT");
    expect(result.conflictedPaths).toEqual(["src/missing_snap.ts"]);
    // Target file untouched
    expect(fs.readFileSync(targetPath, "utf8")).toBe("const S = 'POST';\n");
  });

  // ==========================================================================
  // Test 7: Corrupt snapshot (digest mismatch)
  // ==========================================================================
  it("Test 7: Corrupt snapshot fails-closed (digest mismatch detected)", async () => {
    const { snapshotPath, targetPath } = setupMutatedFile({
      relativePath: "src/corrupt_snap.ts",
      originalContent: "const C = 'PRE';\n",
      mutatedContent: "const C = 'POST';\n",
      mutationId: "mut-corrupt-01",
    });

    // Corrupt snapshot file with different content
    fs.writeFileSync(snapshotPath, "CORRUPT_BYTES", "utf8");

    const result = await engine.executeRollback({
      runId: TEST_RUN_ID,
      workspaceRoot,
      authorityContext: defaultSupervisorAuthority,
    });

    expect(result.status).toBe("PARTIALLY_ROLLED_BACK_CONFLICT");
    expect(result.conflictedPaths).toEqual(["src/corrupt_snap.ts"]);
    // Target file untouched
    expect(fs.readFileSync(targetPath, "utf8")).toBe("const C = 'POST';\n");
  });

  // ==========================================================================
  // Test 8: Target already at original digest D_0 (idempotent no-op)
  // ==========================================================================
  it("Test 8: Target already at original digest D_0 is handled as safe idempotent no-op", async () => {
    const originalContent = "const IDEM = true;\n";
    const { targetPath } = setupMutatedFile({
      relativePath: "src/already_baseline.ts",
      originalContent,
      mutatedContent: originalContent, // Already at baseline
      mutationId: "mut-already-01",
    });

    const result = await engine.executeRollback({
      runId: TEST_RUN_ID,
      workspaceRoot,
      authorityContext: defaultSupervisorAuthority,
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.restoredPaths).toEqual(["src/already_baseline.ts"]);
    expect(fs.readFileSync(targetPath, "utf8")).toBe(originalContent);
  });

  // ==========================================================================
  // Test 9: Newly created file (baseDigest = ABSENT) unlinked on rollback
  // ==========================================================================
  it("Test 9: Newly created file (baseDigest = ABSENT) is unlinked on rollback", async () => {
    const relPath = "src/new_file.ts";
    const targetPath = path.resolve(workspaceRoot, relPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const content = "export const NEW_FEATURE = true;\n";
    fs.writeFileSync(targetPath, content, "utf8");

    const intent: MutationIntent = {
      mutationId: "mut-new-01",
      runId: TEST_RUN_ID,
      workerLeaseId: TEST_LEASE_ID,
      relativePath: relPath,
      canonicalPath: targetPath,
      parentMutationId: null,
      pathMutationVersion: 1,
      baseDigest: "ABSENT",
      expectedResultingDigest: sha256(content),
      snapshotRef: path.resolve(snapshotDir, "mut-new-01.snap"), // Unused for ABSENT
      recoveryDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-new-01", "COMMITTED"),
      lifecycleStatus: "COMMITTED",
      createdAt: 1729900000000,
      updatedAt: 1729900000000,
    };
    store.recordIntent(intent);

    const result = await engine.executeRollback({
      runId: TEST_RUN_ID,
      workspaceRoot,
      authorityContext: defaultSupervisorAuthority,
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.restoredPaths).toEqual([relPath]);
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  // ==========================================================================
  // Test 10: Newly created file externally modified preserves conflict
  // ==========================================================================
  it("Test 10: Newly created file modified externally is preserved and marked conflict", async () => {
    const relPath = "src/new_file_conflict.ts";
    const targetPath = path.resolve(workspaceRoot, relPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const originalCreatedContent = "export const INITIAL = 1;\n";
    // External user modified it:
    const foreignContent = "export const USER_CHANGED = 999;\n";
    fs.writeFileSync(targetPath, foreignContent, "utf8");

    const intent: MutationIntent = {
      mutationId: "mut-new-conf-01",
      runId: TEST_RUN_ID,
      workerLeaseId: TEST_LEASE_ID,
      relativePath: relPath,
      canonicalPath: targetPath,
      parentMutationId: null,
      pathMutationVersion: 1,
      baseDigest: "ABSENT",
      expectedResultingDigest: sha256(originalCreatedContent),
      snapshotRef: path.resolve(snapshotDir, "mut-new-conf-01.snap"),
      recoveryDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-new-conf-01", "COMMITTED"),
      lifecycleStatus: "COMMITTED",
      createdAt: 1729900000000,
      updatedAt: 1729900000000,
    };
    store.recordIntent(intent);

    const result = await engine.executeRollback({
      runId: TEST_RUN_ID,
      workspaceRoot,
      authorityContext: defaultSupervisorAuthority,
    });

    expect(result.status).toBe("PARTIALLY_ROLLED_BACK_CONFLICT");
    expect(result.conflictedPaths).toEqual([relPath]);
    // Target file is preserved untouched!
    expect(fs.existsSync(targetPath)).toBe(true);
    expect(fs.readFileSync(targetPath, "utf8")).toBe(foreignContent);
  });

  // ==========================================================================
  // Test 11: Crash after temporary restore file written (CP6)
  // ==========================================================================
  it("Test 11: Crash during restore with orphaned temp file (CP6) resumes and cleans temp", async () => {
    const { targetPath } = setupMutatedFile({
      relativePath: "src/cp6.ts",
      originalContent: "const CP6 = 'BASE';\n",
      mutatedContent: "const CP6 = 'MUT';\n",
      mutationId: "mut-cp6-01",
    });

    // Simulate crash at CP6: orphaned temp file in target directory
    const targetDir = path.dirname(targetPath);
    const orphanedTemp = path.resolve(targetDir, ".emerald.tmp.restore.test_nonce");
    // Provably ours: a copy of the baseline snapshot (foreign-content temp files are preserved; see hardening tests)
    fs.writeFileSync(orphanedTemp, "const CP6 = 'BASE';\n", "utf8");
    expect(fs.existsSync(orphanedTemp)).toBe(true);

    // Initial rollback in progress
    const nowMs = Date.now();
    store.recordRunRollback(
      {
        runId: TEST_RUN_ID,
        status: "RESTORING_PATHS",
        initiatedBy: "SUPERVISOR",
        createdAt: nowMs,
        completedAt: null,
      },
      [
        {
          runId: TEST_RUN_ID,
          relativePath: "src/cp6.ts",
          status: "IN_PROGRESS",
          initialBaseDigest: sha256("const CP6 = 'BASE';\n"),
          latestExpectedDigest: sha256("const CP6 = 'MUT';\n"),
          baselineSnapshotRef: path.resolve(snapshotDir, "mut-cp6-01.snap"),
          updatedAt: nowMs,
        },
      ]
    );

    const result = await engine.resumeRollback({
      runId: TEST_RUN_ID,
      workspaceRoot,
      authorityContext: defaultSupervisorAuthority,
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.restoredPaths).toEqual(["src/cp6.ts"]);
    expect(fs.readFileSync(targetPath, "utf8")).toBe("const CP6 = 'BASE';\n");
    // Orphaned temp file cleaned
    expect(fs.existsSync(orphanedTemp)).toBe(false);
  });

  // ==========================================================================
  // Test 12: Crash after filesystem replacement before DB progress commit (CP6a)
  // ==========================================================================
  it("Test 12: Crash after rename before DB commit (CP6a) commits status without re-writing", async () => {
    const originalContent = "const CP6A = 'BASE';\n";
    const { targetPath, snapshotPath } = setupMutatedFile({
      relativePath: "src/cp6a.ts",
      originalContent,
      mutatedContent: "const CP6A = 'MUT';\n",
      mutationId: "mut-cp6a-01",
    });

    // Simulate CP6a: target on disk was already renamed to originalContent!
    fs.writeFileSync(targetPath, originalContent, "utf8");

    // But DB shows IN_PROGRESS and intent shows COMMITTED
    const nowMs = Date.now();
    store.recordRunRollback(
      {
        runId: TEST_RUN_ID,
        status: "RESTORING_PATHS",
        initiatedBy: "SUPERVISOR",
        createdAt: nowMs,
        completedAt: null,
      },
      [
        {
          runId: TEST_RUN_ID,
          relativePath: "src/cp6a.ts",
          status: "IN_PROGRESS",
          initialBaseDigest: sha256(originalContent),
          latestExpectedDigest: sha256("const CP6A = 'MUT';\n"),
          baselineSnapshotRef: snapshotPath,
          updatedAt: nowMs,
        },
      ]
    );

    const result = await engine.resumeRollback({
      runId: TEST_RUN_ID,
      workspaceRoot,
      authorityContext: defaultSupervisorAuthority,
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.restoredPaths).toEqual(["src/cp6a.ts"]);

    // DB intent transitioned to ROLLED_BACK
    expect(store.getIntent("mut-cp6a-01")?.lifecycleStatus).toBe("ROLLED_BACK");
    // Progress is RESTORED
    expect(store.getPathRollbackProgress(TEST_RUN_ID, "src/cp6a.ts")?.status).toBe("RESTORED");
  });

  // ==========================================================================
  // Test 13: Repeated invocation of already completed rollback is idempotent
  // ==========================================================================
  it("Test 13: Repeated invocation of already completed rollback is an idempotent no-op", async () => {
    const { targetPath } = setupMutatedFile({
      relativePath: "src/repeated.ts",
      originalContent: "const R = 1;\n",
      mutatedContent: "const R = 2;\n",
      mutationId: "mut-rep-01",
    });

    const firstResult = await engine.executeRollback({
      runId: TEST_RUN_ID,
      workspaceRoot,
      authorityContext: defaultSupervisorAuthority,
    });
    expect(firstResult.status).toBe("COMPLETED");

    // Second execution must be idempotent no-op
    const secondResult = await engine.executeRollback({
      runId: TEST_RUN_ID,
      workspaceRoot,
      authorityContext: defaultSupervisorAuthority,
    });
    expect(secondResult.status).toBe("COMPLETED");
    expect(secondResult.restoredPaths).toEqual(["src/repeated.ts"]);
    expect(fs.readFileSync(targetPath, "utf8")).toBe("const R = 1;\n");
  });

  // ==========================================================================
  // Test 14: Authority rejection — missing authority context
  // ==========================================================================
  it("Test 14: Rollback rejected when authorityContext is missing", async () => {
    setupMutatedFile({
      relativePath: "src/auth1.ts",
      originalContent: "const A = 1;\n",
      mutatedContent: "const A = 2;\n",
      mutationId: "mut-auth-01",
    });

    await expect(
      engine.executeRollback({
        runId: TEST_RUN_ID,
        workspaceRoot,
        authorityContext: null as any,
      })
    ).rejects.toThrow(MissingMutationAuthorityError);
  });

  // ==========================================================================
  // Test 15: Authority rejection — worker authority attempting supervisor rollback
  // ==========================================================================
  it("Test 15: Rollback rejected when worker authority attempts recovery transition", async () => {
    setupMutatedFile({
      relativePath: "src/auth2.ts",
      originalContent: "const A = 1;\n",
      mutatedContent: "const A = 2;\n",
      mutationId: "mut-auth-02",
    });

    await expect(
      engine.executeRollback({
        runId: TEST_RUN_ID,
        workspaceRoot,
        authorityContext: defaultWorkerAuthority,
      })
    ).rejects.toThrow(UnauthorizedMutationTransitionError);
  });

  // ==========================================================================
  // Test 16: Authority rejection — expired supervisor lease
  // ==========================================================================
  it("Test 16: Rollback rejected when supervisor lease is expired", async () => {
    setupMutatedFile({
      relativePath: "src/auth3.ts",
      originalContent: "const A = 1;\n",
      mutatedContent: "const A = 2;\n",
      mutationId: "mut-auth-03",
    });

    // Update supervisor lease to expired
    db.prepare(`UPDATE supervisor_leases SET expires_at = ? WHERE lease_id = ?`).run(
      "2020-01-01T00:00:00.000Z",
      TEST_SUPERVISOR_LEASE_ID
    );

    await expect(
      engine.executeRollback({
        runId: TEST_RUN_ID,
        workspaceRoot,
        authorityContext: defaultSupervisorAuthority,
      })
    ).rejects.toThrow(SupervisorLeaseExpiredError);
  });

  // ==========================================================================
  // Test 17: Authority rejection — foreign supervisor lease for different run
  // ==========================================================================
  it("Test 17: Rollback rejected when supervisor lease belongs to another run", async () => {
    setupMutatedFile({
      relativePath: "src/auth4.ts",
      originalContent: "const A = 1;\n",
      mutatedContent: "const A = 2;\n",
      mutationId: "mut-auth-04",
    });

    const foreignAuthority: MutationAuthorityContext = {
      authority: "SUPERVISOR",
      supervisorFencing: {
        supervisorId: TEST_SUPERVISOR_ID,
        leaseId: "foreign-supervisor-lease",
        nowIso: "2026-10-28T12:00:00.000Z",
      },
    };

    await expect(
      engine.executeRollback({
        runId: TEST_RUN_ID,
        workspaceRoot,
        authorityContext: foreignAuthority,
      })
    ).rejects.toThrow(SupervisorLeaseLostError);
  });

  // ==========================================================================
  // Test 18: Run lifecycle binding — terminal run rejects transitions
  // ==========================================================================
  it("Test 18: Rollback rejected when run is in terminal status (COMPLETED)", async () => {
    setupMutatedFile({
      relativePath: "src/lifecycle.ts",
      originalContent: "const L = 1;\n",
      mutatedContent: "const L = 2;\n",
      mutationId: "mut-life-01",
    });

    // Set run to terminal COMPLETED
    db.prepare(`UPDATE runs SET status = 'COMPLETED' WHERE run_id = ?`).run(TEST_RUN_ID);

    await expect(
      engine.executeRollback({
        runId: TEST_RUN_ID,
        workspaceRoot,
        authorityContext: defaultSupervisorAuthority,
      })
    ).rejects.toThrow(TerminalStateError);
  });

  // ==========================================================================
  // Test 19: Run isolation — intents from other runs are unaffected
  // ==========================================================================
  it("Test 19: Run isolation guarantees unrelated run mutations are not touched", async () => {
    const OTHER_RUN_ID = "run-other-99";
    const OTHER_LEASE_ID = "lease-other-99";
    store.transaction((tx) => {
      tx.insertRun(
        {
          runId: OTHER_RUN_ID,
          taskId: TEST_TASK_ID,
          status: "RUNNING",
          version: 1,
          attemptCount: 1,
          maxAttempts: 3,
          timeoutMs: 30000,
          idempotencyKey: null,
          currentWorkerId: TEST_WORKER_ID,
          leaseId: OTHER_LEASE_ID,
          leaseExpiresAt: "2099-01-01T00:00:00.000Z",
          resultPayload: null,
          errorPayload: null,
          createdAt: "2026-10-28T12:00:00.000Z",
          updatedAt: "2026-10-28T12:00:00.000Z",
          contractBinding: null,
          maxOutputBytes: null,
        },
        {
          eventId: "evt-other-run-01",
          runId: OTHER_RUN_ID,
          timestamp: "2026-10-28T12:00:00.000Z",
          eventType: "run.created",
          schemaVersion: 1,
          producer: "test",
          payload: {},
        }
      );

      tx.insertLease({
        leaseId: OTHER_LEASE_ID,
        runId: OTHER_RUN_ID,
        workerId: TEST_WORKER_ID,
        acquiredAt: "2026-10-28T12:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        releasedAt: null,
        state: "ACTIVE",
      });
    });

    // Setup file in run-1
    setupMutatedFile({
      relativePath: "src/run1_file.ts",
      originalContent: "const R1 = 'INIT';\n",
      mutatedContent: "const R1 = 'MUT';\n",
      mutationId: "mut-run1-01",
      runId: TEST_RUN_ID,
    });

    // Setup file in OTHER_RUN
    const otherFile = setupMutatedFile({
      relativePath: "src/other_file.ts",
      originalContent: "const R2 = 'OTHER_INIT';\n",
      mutatedContent: "const R2 = 'OTHER_MUT';\n",
      mutationId: "mut-other-01",
      runId: OTHER_RUN_ID,
      workerLeaseId: OTHER_LEASE_ID,
    });

    const result = await engine.executeRollback({
      runId: TEST_RUN_ID,
      workspaceRoot,
      authorityContext: defaultSupervisorAuthority,
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.restoredPaths).toEqual(["src/run1_file.ts"]);

    // OTHER_RUN intent is completely untouched
    const otherIntent = store.getIntent("mut-other-01");
    expect(otherIntent?.lifecycleStatus).toBe("COMMITTED");
    expect(fs.readFileSync(otherFile.targetPath, "utf8")).toBe("const R2 = 'OTHER_MUT';\n");
  });

  // ==========================================================================
  // Test 20: Path containment — paths outside workspace rejected
  // ==========================================================================
  it("Test 20: Path traversal escaping workspace root is rejected fail-closed", () => {
    expect(() => {
      engine.resolveSafePath("../outside.ts", workspaceRoot);
    }).toThrow(SnapshotContainmentError);

    expect(() => {
      engine.resolveSafePath("C:drive_rel.ts", workspaceRoot);
    }).toThrow(SnapshotContainmentError);
  });
});
