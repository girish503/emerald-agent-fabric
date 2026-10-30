import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteClient } from "../../src/adapters/persistence/sqlite-client.js";
import { migrateDatabase } from "../../src/adapters/persistence/schema.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import {
  MutationIntent,
  RunRollback,
  PathRollbackProgress,
  computeRecoveryDedupToken,
} from "../../src/domain/mutation-intent.js";
import {
  InvalidMutationTransitionError,
  LeaseExpiredError,
  LeaseLostError,
  MutationIntentNotFoundError,
  MissingMutationAuthorityError,
  UnauthorizedMutationTransitionError,
  SupervisorLeaseExpiredError,
  SupervisorLeaseLostError,
  TerminalStateError,
} from "../../src/domain/errors.js";
import { MutationAuthorityContext } from "../../src/ports/mutation-intent-store.port.js";
import { RunSnapshot } from "../../src/domain/invariants.js";

describe("Phase 48AE: Mutation Intent Persistence Seam Integration Tests", () => {
  let db: DatabaseSync;
  let store: SqliteStateStore;

  const TEST_RUN_ID = "run-persistence-01";
  const TEST_TASK_ID = "task-persistence-01";
  const TEST_WORKER_ID = "worker-persistence-01";
  const TEST_LEASE_ID = "lease-persistence-01";
  const TEST_SUPERVISOR_ID = "supervisor-persistence-01";
  const TEST_SUPERVISOR_LEASE_ID = "supervisor-lease-persistence-01";

  const defaultWorkerAuthority: MutationAuthorityContext = {
    authority: "WORKER",
    fencing: {
      workerId: TEST_WORKER_ID,
      leaseId: TEST_LEASE_ID,
      nowIso: "2026-10-28T12:00:00.000Z",
    },
  };

  const defaultSupervisorAuthority: MutationAuthorityContext = {
    authority: "SUPERVISOR",
    supervisorFencing: {
      supervisorId: TEST_SUPERVISOR_ID,
      leaseId: TEST_SUPERVISOR_LEASE_ID,
      nowIso: "2026-10-28T12:00:00.000Z",
    },
  };

  beforeEach(() => {
    db = createSqliteClient({ location: ":memory:" });
    store = new SqliteStateStore(db);

    // Initialize baseline task, worker, run, and lease
    store.transaction((tx) => {
      tx.insertTask({
        taskId: TEST_TASK_ID,
        title: "Persistence Test Task",
        description: "Testing ADR-0036 persistence seam",
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
        status: "RUNNING",
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
        eventId: "evt-run-created-01",
        runId: TEST_RUN_ID,
        timestamp: "2026-10-28T12:00:00.000Z",
        eventType: "run.created",
        schemaVersion: 1,
        producer: "TEST",
        payload: {},
      });

      tx.insertLease({
        leaseId: TEST_LEASE_ID,
        runId: TEST_RUN_ID,
        workerId: TEST_WORKER_ID,
        acquiredAt: "2026-10-28T12:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        releasedAt: null,
        state: "ACTIVE",
      });

      // Active supervisor lease
      db.prepare(`
        INSERT INTO supervisor_leases (lease_id, run_id, supervisor_id, acquired_at, expires_at, state)
        VALUES (?, ?, ?, ?, ?, 'ACTIVE')
      `).run(TEST_SUPERVISOR_LEASE_ID, TEST_RUN_ID, TEST_SUPERVISOR_ID, "2026-10-28T12:00:00.000Z", "2099-01-01T00:00:00.000Z");
    });
  });

  afterEach(() => {
    store.close();
  });

  // 1. Schema initialization succeeds and is repeatable
  it("Requirement 1: Schema initialization succeeds and is repeatable", () => {
    expect(() => migrateDatabase(db)).not.toThrow();
    expect(() => migrateDatabase(db)).not.toThrow();
  });

  // 2. All required tables, indexes, and constraints exist
  it("Requirement 2: All required tables, indexes, and constraints exist", () => {
    const tableStmt = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('mutation_intents', 'run_rollbacks', 'path_rollback_progress')`
    );
    const tables = (tableStmt.all() as { name: string }[]).map((r) => r.name);
    expect(tables).toContain("mutation_intents");
    expect(tables).toContain("run_rollbacks");
    expect(tables).toContain("path_rollback_progress");

    const indexStmt = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_mutation_intents_run_path', 'idx_mutation_intents_status', 'idx_mutation_intents_lease', 'idx_run_events_dedup')`
    );
    const indexes = (indexStmt.all() as { name: string }[]).map((r) => r.name);
    expect(indexes).toContain("idx_mutation_intents_run_path");
    expect(indexes).toContain("idx_mutation_intents_status");
    expect(indexes).toContain("idx_mutation_intents_lease");
    expect(indexes).toContain("idx_run_events_dedup");
  });

  // 3. Mutation-intent insertion and retrieval work
  it("Requirement 3: Mutation-intent insertion and retrieval work", () => {
    const intent: MutationIntent = {
      mutationId: "mut-req3-01",
      runId: TEST_RUN_ID,
      workerLeaseId: TEST_LEASE_ID,
      relativePath: "src/utils.ts",
      canonicalPath: "/workspace/src/utils.ts",
      parentMutationId: null,
      pathMutationVersion: 1,
      baseDigest: "0".repeat(64),
      expectedResultingDigest: "1".repeat(64),
      snapshotRef: "/snapshots/snap-01.txt",
      recoveryDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-req3-01", "RECORDED"),
      lifecycleStatus: "RECORDED",
      createdAt: 1729900000000,
      updatedAt: 1729900000000,
      conflictDetails: null,
    };

    store.recordIntent(intent);
    const retrieved = store.getIntent("mut-req3-01");

    expect(retrieved).not.toBeNull();
    expect(retrieved?.mutationId).toBe("mut-req3-01");
    expect(retrieved?.runId).toBe(TEST_RUN_ID);
    expect(retrieved?.relativePath).toBe("src/utils.ts");
    expect(retrieved?.pathMutationVersion).toBe(1);
    expect(retrieved?.lifecycleStatus).toBe("RECORDED");
    expect(retrieved?.baseDigest).toBe("0".repeat(64));
    expect(retrieved?.expectedResultingDigest).toBe("1".repeat(64));
  });

  // 4. Required unique constraints reject duplicates
  it("Requirement 4: Required unique constraints reject duplicates", () => {
    const intent1: MutationIntent = {
      mutationId: "mut-req4-01",
      runId: TEST_RUN_ID,
      workerLeaseId: TEST_LEASE_ID,
      relativePath: "src/utils.ts",
      canonicalPath: "/workspace/src/utils.ts",
      parentMutationId: null,
      pathMutationVersion: 1,
      baseDigest: "0".repeat(64),
      expectedResultingDigest: "1".repeat(64),
      snapshotRef: "/snapshots/snap-01.txt",
      recoveryDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-req4-01", "RECORDED"),
      lifecycleStatus: "RECORDED",
      createdAt: 1729900000000,
      updatedAt: 1729900000000,
    };
    store.recordIntent(intent1);

    // Duplicate (runId, relativePath, pathMutationVersion)
    const duplicateVersionIntent: MutationIntent = {
      ...intent1,
      mutationId: "mut-req4-02",
      recoveryDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-req4-02", "RECORDED"),
    };
    expect(() => store.recordIntent(duplicateVersionIntent)).toThrow(/UNIQUE constraint failed/);

    // Duplicate recoveryDedupToken
    const duplicateTokenIntent: MutationIntent = {
      ...intent1,
      mutationId: "mut-req4-03",
      pathMutationVersion: 2,
      parentMutationId: "mut-req4-01",
      recoveryDedupToken: intent1.recoveryDedupToken,
    };
    expect(() => store.recordIntent(duplicateTokenIntent)).toThrow(/UNIQUE constraint failed/);
  });

  // 5. ON DELETE RESTRICT prevents prohibited run deletion
  it("Requirement 5: ON DELETE RESTRICT prevents prohibited run deletion", () => {
    const intent: MutationIntent = {
      mutationId: "mut-req5-01",
      runId: TEST_RUN_ID,
      workerLeaseId: TEST_LEASE_ID,
      relativePath: "src/utils.ts",
      canonicalPath: "/workspace/src/utils.ts",
      parentMutationId: null,
      pathMutationVersion: 1,
      baseDigest: "0".repeat(64),
      expectedResultingDigest: "1".repeat(64),
      snapshotRef: "/snapshots/snap-01.txt",
      recoveryDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-req5-01", "RECORDED"),
      lifecycleStatus: "RECORDED",
      createdAt: 1729900000000,
      updatedAt: 1729900000000,
    };
    store.recordIntent(intent);

    // Attempting to delete run row with child intent MUST fail with foreign key error
    expect(() => {
      db.prepare(`DELETE FROM runs WHERE run_id = ?`).run(TEST_RUN_ID);
    }).toThrow(/(FOREIGN KEY constraint failed|Fencing check failed)/);
  });

  // 6. Invalid lifecycle transitions are rejected
  it("Requirement 6: Invalid lifecycle transitions are rejected", () => {
    const intent: MutationIntent = {
      mutationId: "mut-req6-01",
      runId: TEST_RUN_ID,
      workerLeaseId: TEST_LEASE_ID,
      relativePath: "src/utils.ts",
      canonicalPath: "/workspace/src/utils.ts",
      parentMutationId: null,
      pathMutationVersion: 1,
      baseDigest: "0".repeat(64),
      expectedResultingDigest: "1".repeat(64),
      snapshotRef: "/snapshots/snap-01.txt",
      recoveryDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-req6-01", "RECORDED"),
      lifecycleStatus: "RECORDED",
      createdAt: 1729900000000,
      updatedAt: 1729900000000,
    };
    store.recordIntent(intent);

    // Attempt illegal transition RECORDED -> COMMITTED
    expect(() => {
      store.transitionMutationStatus({
        mutationId: "mut-req6-01",
        fromStatus: "RECORDED",
        toStatus: "COMMITTED",
        event: {
          eventId: "evt-illegal-01",
          runId: TEST_RUN_ID,
          timestamp: new Date().toISOString(),
          eventType: "file.mutation_committed",
          schemaVersion: 1,
          producer: "MUTATION_ENGINE",
          payload: {},
        },
        nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-req6-01", "COMMITTED"),
        authorityContext: defaultWorkerAuthority,
      });
    }).toThrow(InvalidMutationTransitionError);
  });

  // 7. Valid lifecycle transitions persist the correct state
  it("Requirement 7: Valid lifecycle transitions persist the correct state", () => {
    const intent: MutationIntent = {
      mutationId: "mut-req7-01",
      runId: TEST_RUN_ID,
      workerLeaseId: TEST_LEASE_ID,
      relativePath: "src/utils.ts",
      canonicalPath: "/workspace/src/utils.ts",
      parentMutationId: null,
      pathMutationVersion: 1,
      baseDigest: "0".repeat(64),
      expectedResultingDigest: "1".repeat(64),
      snapshotRef: "/snapshots/snap-01.txt",
      recoveryDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-req7-01", "RECORDED"),
      lifecycleStatus: "RECORDED",
      createdAt: 1729900000000,
      updatedAt: 1729900000000,
    };
    store.recordIntent(intent);

    // Transition 1: RECORDED -> SNAPSHOT_WRITTEN
    store.transitionMutationStatus({
      mutationId: "mut-req7-01",
      fromStatus: "RECORDED",
      toStatus: "SNAPSHOT_WRITTEN",
      event: {
        eventId: "evt-snap-01",
        runId: TEST_RUN_ID,
        timestamp: "2026-10-28T12:01:00.000Z",
        eventType: "file.snapshot_written",
        schemaVersion: 1,
        producer: "MUTATION_ENGINE",
        payload: { mutationId: "mut-req7-01" },
      },
      nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-req7-01", "SNAPSHOT_WRITTEN"),
      authorityContext: defaultWorkerAuthority,
    });

    let current = store.getIntent("mut-req7-01");
    expect(current?.lifecycleStatus).toBe("SNAPSHOT_WRITTEN");

    // Transition 2: SNAPSHOT_WRITTEN -> APPLYING_MUTATION
    store.transitionMutationStatus({
      mutationId: "mut-req7-01",
      fromStatus: "SNAPSHOT_WRITTEN",
      toStatus: "APPLYING_MUTATION",
      event: {
        eventId: "evt-apply-01",
        runId: TEST_RUN_ID,
        timestamp: "2026-10-28T12:02:00.000Z",
        eventType: "file.applying_mutation",
        schemaVersion: 1,
        producer: "MUTATION_ENGINE",
        payload: { mutationId: "mut-req7-01" },
      },
      nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-req7-01", "APPLYING_MUTATION"),
      authorityContext: defaultWorkerAuthority,
    });

    current = store.getIntent("mut-req7-01");
    expect(current?.lifecycleStatus).toBe("APPLYING_MUTATION");

    // Transition 3: APPLYING_MUTATION -> COMMITTED
    store.transitionMutationStatus({
      mutationId: "mut-req7-01",
      fromStatus: "APPLYING_MUTATION",
      toStatus: "COMMITTED",
      event: {
        eventId: "evt-commit-01",
        runId: TEST_RUN_ID,
        timestamp: "2026-10-28T12:03:00.000Z",
        eventType: "file.mutation_committed",
        schemaVersion: 1,
        producer: "MUTATION_ENGINE",
        payload: { mutationId: "mut-req7-01" },
      },
      nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-req7-01", "COMMITTED"),
      authorityContext: defaultWorkerAuthority,
    });

    current = store.getIntent("mut-req7-01");
    expect(current?.lifecycleStatus).toBe("COMMITTED");
  });

  // 8. The current recovery deduplication token updates correctly across successive transitions
  it("Requirement 8: The current recovery deduplication token updates correctly across successive transitions", () => {
    const token1 = computeRecoveryDedupToken(TEST_RUN_ID, "mut-req8-01", "RECORDED");
    const intent: MutationIntent = {
      mutationId: "mut-req8-01",
      runId: TEST_RUN_ID,
      workerLeaseId: TEST_LEASE_ID,
      relativePath: "src/utils.ts",
      canonicalPath: "/workspace/src/utils.ts",
      parentMutationId: null,
      pathMutationVersion: 1,
      baseDigest: "0".repeat(64),
      expectedResultingDigest: "1".repeat(64),
      snapshotRef: "/snapshots/snap-01.txt",
      recoveryDedupToken: token1,
      lifecycleStatus: "RECORDED",
      createdAt: 1729900000000,
      updatedAt: 1729900000000,
    };
    store.recordIntent(intent);
    expect(store.getIntent("mut-req8-01")?.recoveryDedupToken).toBe(token1);

    const token2 = computeRecoveryDedupToken(TEST_RUN_ID, "mut-req8-01", "SNAPSHOT_WRITTEN");
    store.transitionMutationStatus({
      mutationId: "mut-req8-01",
      fromStatus: "RECORDED",
      toStatus: "SNAPSHOT_WRITTEN",
      event: {
        eventId: "evt-token-01",
        runId: TEST_RUN_ID,
        timestamp: new Date().toISOString(),
        eventType: "file.snapshot_written",
        schemaVersion: 1,
        producer: "MUTATION_ENGINE",
        payload: {},
      },
      nextDedupToken: token2,
      authorityContext: defaultWorkerAuthority,
    });

    expect(store.getIntent("mut-req8-01")?.recoveryDedupToken).toBe(token2);
  });

  // 9. Historical domain events remain immutable
  it("Requirement 9: Historical domain events remain immutable", () => {
    const token1 = computeRecoveryDedupToken(TEST_RUN_ID, "mut-req9-01", "RECORDED");
    const intent: MutationIntent = {
      mutationId: "mut-req9-01",
      runId: TEST_RUN_ID,
      workerLeaseId: TEST_LEASE_ID,
      relativePath: "src/utils.ts",
      canonicalPath: "/workspace/src/utils.ts",
      parentMutationId: null,
      pathMutationVersion: 1,
      baseDigest: "0".repeat(64),
      expectedResultingDigest: "1".repeat(64),
      snapshotRef: "/snapshots/snap-01.txt",
      recoveryDedupToken: token1,
      lifecycleStatus: "RECORDED",
      createdAt: 1729900000000,
      updatedAt: 1729900000000,
    };
    store.recordIntent(intent);

    const token2 = computeRecoveryDedupToken(TEST_RUN_ID, "mut-req9-01", "SNAPSHOT_WRITTEN");
    store.transitionMutationStatus({
      mutationId: "mut-req9-01",
      fromStatus: "RECORDED",
      toStatus: "SNAPSHOT_WRITTEN",
      event: {
        eventId: "evt-hist-01",
        runId: TEST_RUN_ID,
        timestamp: "2026-10-28T12:05:00.000Z",
        eventType: "file.snapshot_written",
        schemaVersion: 1,
        producer: "MUTATION_ENGINE",
        payload: { step: 1 },
      },
      nextDedupToken: token2,
      authorityContext: defaultWorkerAuthority,
    });

    const token3 = computeRecoveryDedupToken(TEST_RUN_ID, "mut-req9-01", "APPLYING_MUTATION");
    store.transitionMutationStatus({
      mutationId: "mut-req9-01",
      fromStatus: "SNAPSHOT_WRITTEN",
      toStatus: "APPLYING_MUTATION",
      event: {
        eventId: "evt-hist-02",
        runId: TEST_RUN_ID,
        timestamp: "2026-10-28T12:06:00.000Z",
        eventType: "file.applying_mutation",
        schemaVersion: 1,
        producer: "MUTATION_ENGINE",
        payload: { step: 2 },
      },
      nextDedupToken: token3,
      authorityContext: defaultWorkerAuthority,
    });

    const events = store.getEventsForRun(TEST_RUN_ID);
    const snapEvent = events.find((e) => e.eventId === "evt-hist-01");
    const applyEvent = events.find((e) => e.eventId === "evt-hist-02");

    expect(snapEvent).toBeDefined();
    expect(applyEvent).toBeDefined();
    expect((snapEvent?.payload as { step: number }).step).toBe(1);
    expect((applyEvent?.payload as { step: number }).step).toBe(2);

    // Verify token stored in DB for evt-hist-01 remains token2
    const eventRow = db.prepare(`SELECT dedup_token FROM run_events WHERE event_id = ?`).get("evt-hist-01") as {
      dedup_token: string;
    };
    expect(eventRow.dedup_token).toBe(token2);
  });

  // 10. Intent state and event insertion commit atomically
  it("Requirement 10: Intent state and event insertion commit atomically", () => {
    const token1 = computeRecoveryDedupToken(TEST_RUN_ID, "mut-req10-01", "RECORDED");
    const intent: MutationIntent = {
      mutationId: "mut-req10-01",
      runId: TEST_RUN_ID,
      workerLeaseId: TEST_LEASE_ID,
      relativePath: "src/utils.ts",
      canonicalPath: "/workspace/src/utils.ts",
      parentMutationId: null,
      pathMutationVersion: 1,
      baseDigest: "0".repeat(64),
      expectedResultingDigest: "1".repeat(64),
      snapshotRef: "/snapshots/snap-01.txt",
      recoveryDedupToken: token1,
      lifecycleStatus: "RECORDED",
      createdAt: 1729900000000,
      updatedAt: 1729900000000,
    };
    store.recordIntent(intent);

    const token2 = computeRecoveryDedupToken(TEST_RUN_ID, "mut-req10-01", "SNAPSHOT_WRITTEN");
    const persisted = store.transitionMutationStatus({
      mutationId: "mut-req10-01",
      fromStatus: "RECORDED",
      toStatus: "SNAPSHOT_WRITTEN",
      event: {
        eventId: "evt-atomic-01",
        runId: TEST_RUN_ID,
        timestamp: new Date().toISOString(),
        eventType: "file.snapshot_written",
        schemaVersion: 1,
        producer: "MUTATION_ENGINE",
        payload: { ok: true },
      },
      nextDedupToken: token2,
      authorityContext: defaultWorkerAuthority,
    });

    expect(persisted.eventId).toBe("evt-atomic-01");
    expect(store.getIntent("mut-req10-01")?.lifecycleStatus).toBe("SNAPSHOT_WRITTEN");
    expect(store.getEventsForRun(TEST_RUN_ID).some((e) => e.eventId === "evt-atomic-01")).toBe(true);
  });

  // 11. A forced event-insertion failure rolls back the associated intent-state update
  it("Requirement 11: A forced event-insertion failure rolls back the associated intent-state update", () => {
    const token1 = computeRecoveryDedupToken(TEST_RUN_ID, "mut-req11-01", "RECORDED");
    const intent: MutationIntent = {
      mutationId: "mut-req11-01",
      runId: TEST_RUN_ID,
      workerLeaseId: TEST_LEASE_ID,
      relativePath: "src/utils.ts",
      canonicalPath: "/workspace/src/utils.ts",
      parentMutationId: null,
      pathMutationVersion: 1,
      baseDigest: "0".repeat(64),
      expectedResultingDigest: "1".repeat(64),
      snapshotRef: "/snapshots/snap-01.txt",
      recoveryDedupToken: token1,
      lifecycleStatus: "RECORDED",
      createdAt: 1729900000000,
      updatedAt: 1729900000000,
    };
    store.recordIntent(intent);

    // Insert an existing event with a collision token to force event insertion failure
    const collisionToken = "COLLISION_DEDUP_TOKEN_000000000000000000000000000000000000000000000";
    db.prepare(`
      INSERT INTO run_events (event_id, run_id, sequence, timestamp, event_type, schema_version, producer, payload, dedup_token)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("evt-prior-collision", TEST_RUN_ID, 999, "2026-10-28T00:00:00Z", "test.event", 1, "TEST", "{}", collisionToken);

    // Now attempt transition with the colliding token -> appendEvent will throw SQLite UNIQUE constraint failed on dedup_token
    expect(() => {
      store.transitionMutationStatus({
        mutationId: "mut-req11-01",
        fromStatus: "RECORDED",
        toStatus: "SNAPSHOT_WRITTEN",
        event: {
          eventId: "evt-failed-01",
          runId: TEST_RUN_ID,
          timestamp: new Date().toISOString(),
          eventType: "file.snapshot_written",
          schemaVersion: 1,
          producer: "MUTATION_ENGINE",
          payload: {},
        },
        nextDedupToken: collisionToken, // Collides with existing event!
        authorityContext: defaultWorkerAuthority,
      });
    }).toThrow(/UNIQUE constraint failed/);

    // Crucial Invariant: mutation_intents must remain at RECORDED with original token!
    const unchanged = store.getIntent("mut-req11-01");
    expect(unchanged?.lifecycleStatus).toBe("RECORDED");
    expect(unchanged?.recoveryDedupToken).toBe(token1);
  });

  // 12. A forced state-update failure does not leave a standalone transition event
  it("Requirement 12: A forced state-update failure does not leave a standalone transition event", () => {
    const token1 = computeRecoveryDedupToken(TEST_RUN_ID, "mut-req12-01", "RECORDED");
    const intent: MutationIntent = {
      mutationId: "mut-req12-01",
      runId: TEST_RUN_ID,
      workerLeaseId: TEST_LEASE_ID,
      relativePath: "src/utils.ts",
      canonicalPath: "/workspace/src/utils.ts",
      parentMutationId: null,
      pathMutationVersion: 1,
      baseDigest: "0".repeat(64),
      expectedResultingDigest: "1".repeat(64),
      snapshotRef: "/snapshots/snap-01.txt",
      recoveryDedupToken: token1,
      lifecycleStatus: "RECORDED",
      createdAt: 1729900000000,
      updatedAt: 1729900000000,
    };
    store.recordIntent(intent);

    // Call transition with non-existent mutationId
    expect(() => {
      store.transitionMutationStatus({
        mutationId: "non-existent-mut-id",
        fromStatus: "RECORDED",
        toStatus: "SNAPSHOT_WRITTEN",
        event: {
          eventId: "evt-orphan-01",
          runId: TEST_RUN_ID,
          timestamp: new Date().toISOString(),
          eventType: "file.snapshot_written",
          schemaVersion: 1,
          producer: "MUTATION_ENGINE",
          payload: {},
        },
        nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "non-existent-mut-id", "SNAPSHOT_WRITTEN"),
        authorityContext: defaultWorkerAuthority,
      });
    }).toThrow(MutationIntentNotFoundError);

    // Assert that 'evt-orphan-01' was NOT inserted
    const events = store.getEventsForRun(TEST_RUN_ID);
    expect(events.some((e) => e.eventId === "evt-orphan-01")).toBe(false);
  });

  // 13. Duplicate transition attempts do not create duplicate logical events
  it("Requirement 13: Duplicate transition attempts do not create duplicate logical events", () => {
    const token1 = computeRecoveryDedupToken(TEST_RUN_ID, "mut-req13-01", "RECORDED");
    const intent: MutationIntent = {
      mutationId: "mut-req13-01",
      runId: TEST_RUN_ID,
      workerLeaseId: TEST_LEASE_ID,
      relativePath: "src/utils.ts",
      canonicalPath: "/workspace/src/utils.ts",
      parentMutationId: null,
      pathMutationVersion: 1,
      baseDigest: "0".repeat(64),
      expectedResultingDigest: "1".repeat(64),
      snapshotRef: "/snapshots/snap-01.txt",
      recoveryDedupToken: token1,
      lifecycleStatus: "RECORDED",
      createdAt: 1729900000000,
      updatedAt: 1729900000000,
    };
    store.recordIntent(intent);

    const token2 = computeRecoveryDedupToken(TEST_RUN_ID, "mut-req13-01", "SNAPSHOT_WRITTEN");
    const eventParams = {
      mutationId: "mut-req13-01",
      fromStatus: "RECORDED" as const,
      toStatus: "SNAPSHOT_WRITTEN" as const,
      event: {
        eventId: "evt-dup-01",
        runId: TEST_RUN_ID,
        timestamp: new Date().toISOString(),
        eventType: "file.snapshot_written",
        schemaVersion: 1,
        producer: "MUTATION_ENGINE",
        payload: { data: "test" },
      },
      nextDedupToken: token2,
      authorityContext: defaultWorkerAuthority,
    };

    // First attempt commits
    const event1 = store.transitionMutationStatus(eventParams);
    expect(event1.eventId).toBe("evt-dup-01");

    // Second duplicate attempt: idempotent retry detects state is already SNAPSHOT_WRITTEN with token2
    const event2 = store.transitionMutationStatus(eventParams);
    expect(event2.eventId).toBe("evt-dup-01");

    // Exactly one such event in database
    const matchingEvents = store.getEventsForRun(TEST_RUN_ID).filter((e) => e.eventId === "evt-dup-01");
    expect(matchingEvents.length).toBe(1);
  });

  // 14. Lease validation follows the existing authoritative database contract
  it("Requirement 14: Lease validation follows the existing authoritative database contract", () => {
    const token1 = computeRecoveryDedupToken(TEST_RUN_ID, "mut-req14-01", "RECORDED");
    const intent: MutationIntent = {
      mutationId: "mut-req14-01",
      runId: TEST_RUN_ID,
      workerLeaseId: TEST_LEASE_ID,
      relativePath: "src/utils.ts",
      canonicalPath: "/workspace/src/utils.ts",
      parentMutationId: null,
      pathMutationVersion: 1,
      baseDigest: "0".repeat(64),
      expectedResultingDigest: "1".repeat(64),
      snapshotRef: "/snapshots/snap-01.txt",
      recoveryDedupToken: token1,
      lifecycleStatus: "RECORDED",
      createdAt: 1729900000000,
      updatedAt: 1729900000000,
    };
    store.recordIntent(intent);

    // Valid lease fencing succeeds
    expect(() => {
      store.transitionMutationStatus({
        mutationId: "mut-req14-01",
        fromStatus: "RECORDED",
        toStatus: "SNAPSHOT_WRITTEN",
        event: {
          eventId: "evt-lease-01",
          runId: TEST_RUN_ID,
          timestamp: new Date().toISOString(),
          eventType: "file.snapshot_written",
          schemaVersion: 1,
          producer: "MUTATION_ENGINE",
          payload: {},
        },
        nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-req14-01", "SNAPSHOT_WRITTEN"),
        authorityContext: {
          authority: "WORKER",
          fencing: {
            workerId: TEST_WORKER_ID,
            leaseId: TEST_LEASE_ID,
            nowIso: "2026-10-28T12:00:00.000Z",
          },
        },
      });
    }).not.toThrow();

    // Expired lease fencing throws LeaseExpiredError
    expect(() => {
      store.transitionMutationStatus({
        mutationId: "mut-req14-01",
        fromStatus: "SNAPSHOT_WRITTEN",
        toStatus: "APPLYING_MUTATION",
        event: {
          eventId: "evt-lease-02",
          runId: TEST_RUN_ID,
          timestamp: new Date().toISOString(),
          eventType: "file.applying_mutation",
          schemaVersion: 1,
          producer: "MUTATION_ENGINE",
          payload: {},
        },
        nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-req14-01", "APPLYING_MUTATION"),
        authorityContext: {
          authority: "WORKER",
          fencing: {
            workerId: TEST_WORKER_ID,
            leaseId: TEST_LEASE_ID,
            nowIso: "2100-01-01T00:00:00.000Z", // Past lease expiration!
          },
        },
      });
    }).toThrow(LeaseExpiredError);

    // Wrong worker lease throws LeaseLostError
    expect(() => {
      store.transitionMutationStatus({
        mutationId: "mut-req14-01",
        fromStatus: "SNAPSHOT_WRITTEN",
        toStatus: "APPLYING_MUTATION",
        event: {
          eventId: "evt-lease-03",
          runId: TEST_RUN_ID,
          timestamp: new Date().toISOString(),
          eventType: "file.applying_mutation",
          schemaVersion: 1,
          producer: "MUTATION_ENGINE",
          payload: {},
        },
        nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-req14-01", "APPLYING_MUTATION"),
        authorityContext: {
          authority: "WORKER",
          fencing: {
            workerId: "wrong-worker-id",
            leaseId: TEST_LEASE_ID,
            nowIso: "2026-10-28T12:00:00.000Z",
          },
        },
      });
    }).toThrow(LeaseLostError);
  });

  // 15. Run-level rollback initialization inserts every path-progress row atomically
  it("Requirement 15: Run-level rollback initialization inserts every path-progress row atomically", () => {
    const rollback: RunRollback = {
      runId: TEST_RUN_ID,
      status: "RESTORING_PATHS",
      initiatedBy: "VERIFICATION_FAILURE",
      createdAt: 1729900000000,
    };

    const pathProgress: PathRollbackProgress[] = [
      {
        runId: TEST_RUN_ID,
        relativePath: "src/utils.ts",
        status: "PENDING",
        initialBaseDigest: "a".repeat(64),
        latestExpectedDigest: "b".repeat(64),
        baselineSnapshotRef: "/snapshots/snap-utils.ts",
        updatedAt: 1729900000000,
      },
      {
        runId: TEST_RUN_ID,
        relativePath: "src/index.ts",
        status: "PENDING",
        initialBaseDigest: "c".repeat(64),
        latestExpectedDigest: "d".repeat(64),
        baselineSnapshotRef: "/snapshots/snap-index.ts",
        updatedAt: 1729900000000,
      },
    ];

    store.recordRunRollback(rollback, pathProgress);

    const retrievedRollback = store.getRunRollback(TEST_RUN_ID);
    expect(retrievedRollback).not.toBeNull();
    expect(retrievedRollback?.status).toBe("RESTORING_PATHS");

    const paths = store.listPathRollbackProgress(TEST_RUN_ID);
    expect(paths.length).toBe(2);
    expect(paths[0].relativePath).toBe("src/index.ts");
    expect(paths[1].relativePath).toBe("src/utils.ts");
  });

  // 16. A forced path-progress insertion failure leaves no partial run-level rollback
  it("Requirement 16: A forced path-progress insertion failure leaves no partial run-level rollback", () => {
    const rollback: RunRollback = {
      runId: TEST_RUN_ID,
      status: "RESTORING_PATHS",
      initiatedBy: "VERIFICATION_FAILURE",
      createdAt: 1729900000000,
    };

    // Intentional collision: duplicate relativePath in the list to trigger PRIMARY KEY violation
    const collidingProgress: PathRollbackProgress[] = [
      {
        runId: TEST_RUN_ID,
        relativePath: "src/utils.ts",
        status: "PENDING",
        initialBaseDigest: "a".repeat(64),
        latestExpectedDigest: "b".repeat(64),
        baselineSnapshotRef: "/snapshots/snap-utils.ts",
        updatedAt: 1729900000000,
      },
      {
        runId: TEST_RUN_ID,
        relativePath: "src/utils.ts", // Duplicate!
        status: "PENDING",
        initialBaseDigest: "a".repeat(64),
        latestExpectedDigest: "b".repeat(64),
        baselineSnapshotRef: "/snapshots/snap-utils.ts",
        updatedAt: 1729900000000,
      },
    ];

    expect(() => store.recordRunRollback(rollback, collidingProgress)).toThrow(/UNIQUE constraint failed/);

    // Verify neither run_rollbacks nor path_rollback_progress contains any records for this run!
    expect(store.getRunRollback(TEST_RUN_ID)).toBeNull();
    expect(store.listPathRollbackProgress(TEST_RUN_ID).length).toBe(0);
  });

  // 17. Path history is returned in the exact ADR-specified order
  it("Requirement 17: Path history is returned in the exact ADR-specified order", () => {
    // 3 successive mutations to src/utils.ts: D0 -> D1 -> D2 -> D3
    const d0 = "0".repeat(64);
    const d1 = "1".repeat(64);
    const d2 = "2".repeat(64);
    const d3 = "3".repeat(64);

    const m1: MutationIntent = {
      mutationId: "mut-order-01",
      runId: TEST_RUN_ID,
      workerLeaseId: TEST_LEASE_ID,
      relativePath: "src/utils.ts",
      canonicalPath: "/workspace/src/utils.ts",
      parentMutationId: null,
      pathMutationVersion: 1,
      baseDigest: d0,
      expectedResultingDigest: d1,
      snapshotRef: "/snap-1",
      recoveryDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-order-01", "COMMITTED"),
      lifecycleStatus: "COMMITTED",
      createdAt: 1000,
      updatedAt: 1000,
    };

    const m2: MutationIntent = {
      mutationId: "mut-order-02",
      runId: TEST_RUN_ID,
      workerLeaseId: TEST_LEASE_ID,
      relativePath: "src/utils.ts",
      canonicalPath: "/workspace/src/utils.ts",
      parentMutationId: "mut-order-01",
      pathMutationVersion: 2,
      baseDigest: d1,
      expectedResultingDigest: d2,
      snapshotRef: "/snap-2",
      recoveryDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-order-02", "COMMITTED"),
      lifecycleStatus: "COMMITTED",
      createdAt: 2000,
      updatedAt: 2000,
    };

    const m3: MutationIntent = {
      mutationId: "mut-order-03",
      runId: TEST_RUN_ID,
      workerLeaseId: TEST_LEASE_ID,
      relativePath: "src/utils.ts",
      canonicalPath: "/workspace/src/utils.ts",
      parentMutationId: "mut-order-02",
      pathMutationVersion: 3,
      baseDigest: d2,
      expectedResultingDigest: d3,
      snapshotRef: "/snap-3",
      recoveryDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-order-03", "COMMITTED"),
      lifecycleStatus: "COMMITTED",
      createdAt: 3000,
      updatedAt: 3000,
    };

    // Also a mutation to another file
    const mOther: MutationIntent = {
      mutationId: "mut-order-other",
      runId: TEST_RUN_ID,
      workerLeaseId: TEST_LEASE_ID,
      relativePath: "src/index.ts",
      canonicalPath: "/workspace/src/index.ts",
      parentMutationId: null,
      pathMutationVersion: 1,
      baseDigest: d0,
      expectedResultingDigest: d1,
      snapshotRef: "/snap-idx",
      recoveryDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-order-other", "COMMITTED"),
      lifecycleStatus: "COMMITTED",
      createdAt: 1500,
      updatedAt: 1500,
    };

    // Insert m1 first (parent), then mOther (interleaved), then m2, then m3
    store.recordIntent(m1);
    store.recordIntent(mOther);
    store.recordIntent(m2);
    store.recordIntent(m3);

    const history = store.getIntentsForPath(TEST_RUN_ID, "src/utils.ts");
    expect(history.length).toBe(3);
    expect(history[0].pathMutationVersion).toBe(1);
    expect(history[0].mutationId).toBe("mut-order-01");
    expect(history[1].pathMutationVersion).toBe(2);
    expect(history[1].mutationId).toBe("mut-order-02");
    expect(history[2].pathMutationVersion).toBe(3);
    expect(history[2].mutationId).toBe("mut-order-03");

    const latest = store.getLatestIntentForPath(TEST_RUN_ID, "src/utils.ts");
    expect(latest?.mutationId).toBe("mut-order-03");
    expect(latest?.expectedResultingDigest).toBe(d3);
  });

  // 18. Run and path rollback progress can be retrieved and updated according to the permitted state transitions
  it("Requirement 18: Run and path rollback progress can be retrieved and updated according to the permitted state transitions", () => {
    const rollback: RunRollback = {
      runId: TEST_RUN_ID,
      status: "RESTORING_PATHS",
      initiatedBy: "VERIFICATION_FAILURE",
      createdAt: 1000,
    };

    const pathProgress: PathRollbackProgress[] = [
      {
        runId: TEST_RUN_ID,
        relativePath: "src/utils.ts",
        status: "PENDING",
        initialBaseDigest: "0".repeat(64),
        latestExpectedDigest: "1".repeat(64),
        baselineSnapshotRef: "/snap-1",
        updatedAt: 1000,
      },
    ];

    store.recordRunRollback(rollback, pathProgress);

    // Update path progress to RESTORED
    store.updatePathRollbackProgress(TEST_RUN_ID, "src/utils.ts", "RESTORED", null, 2000);
    const updatedPath = store.getPathRollbackProgress(TEST_RUN_ID, "src/utils.ts");
    expect(updatedPath?.status).toBe("RESTORED");
    expect(updatedPath?.updatedAt).toBe(2000);

    // Update run rollback to COMPLETED
    store.updateRunRollbackStatus(TEST_RUN_ID, "COMPLETED", 3000);
    const updatedRun = store.getRunRollback(TEST_RUN_ID);
    expect(updatedRun?.status).toBe("COMPLETED");
    expect(updatedRun?.completedAt).toBe(3000);
  });

  // 19. Foreign-key restrictions and unique constraints behave correctly after transaction rollback
  it("Requirement 19: Foreign-key restrictions and unique constraints behave correctly after transaction rollback", () => {
    // Attempt an operation that fails FK restriction (referencing non-existent run)
    expect(() => {
      store.recordIntent({
        mutationId: "mut-bad-run",
        runId: "non-existent-run",
        workerLeaseId: TEST_LEASE_ID,
        relativePath: "src/utils.ts",
        canonicalPath: "/workspace/src/utils.ts",
        parentMutationId: null,
        pathMutationVersion: 1,
        baseDigest: "0".repeat(64),
        expectedResultingDigest: "1".repeat(64),
        snapshotRef: "/snap",
        recoveryDedupToken: computeRecoveryDedupToken("non-existent-run", "mut-bad-run", "RECORDED"),
        lifecycleStatus: "RECORDED",
        createdAt: 1000,
        updatedAt: 1000,
      });
    }).toThrow(/(FOREIGN KEY constraint failed|Fencing check failed)/);

    // Database must remain healthy: a subsequent valid insert succeeds immediately
    expect(() => {
      store.recordIntent({
        mutationId: "mut-good-run",
        runId: TEST_RUN_ID,
        workerLeaseId: TEST_LEASE_ID,
        relativePath: "src/utils.ts",
        canonicalPath: "/workspace/src/utils.ts",
        parentMutationId: null,
        pathMutationVersion: 1,
        baseDigest: "0".repeat(64),
        expectedResultingDigest: "1".repeat(64),
        snapshotRef: "/snap",
        recoveryDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-good-run", "RECORDED"),
        lifecycleStatus: "RECORDED",
        createdAt: 1000,
        updatedAt: 1000,
      });
    }).not.toThrow();

    expect(store.getIntent("mut-good-run")).not.toBeNull();
  });

  // 20. Existing persistence, application, domain, and event operations coexist and continue to operate non-interferingly
  it("Requirement 20: Coexistence and non-interference with existing store operations (tasks, workers, runs, leases, checkpoints)", () => {
    // Verify core store operations operate normally alongside mutation intents
    const task = store.getTask(TEST_TASK_ID);
    expect(task).not.toBeNull();
    expect(task?.taskId).toBe(TEST_TASK_ID);

    const worker = store.getWorker(TEST_WORKER_ID);
    expect(worker).not.toBeNull();
    expect(worker?.status).toBe("ACTIVE");

    const run = store.getRun(TEST_RUN_ID);
    expect(run).not.toBeNull();
    expect(run?.status).toBe("RUNNING");

    const lease = store.getLease(TEST_LEASE_ID);
    expect(lease).not.toBeNull();
    expect(lease?.state).toBe("ACTIVE");

    // Perform standard transaction modifying run and adding an event
    store.transaction((tx) => {
      tx.updateWorkerHeartbeat(TEST_WORKER_ID, "2026-10-28T12:05:00.000Z");
      tx.appendEvent({
        eventId: "evt-coexist-01",
        runId: TEST_RUN_ID,
        timestamp: "2026-10-28T12:05:00.000Z",
        eventType: "worker.heartbeat",
        schemaVersion: 1,
        producer: "WORKER",
        payload: { workerId: TEST_WORKER_ID },
      });
    });

    const updatedWorker = store.getWorker(TEST_WORKER_ID);
    expect(updatedWorker?.lastHeartbeatAt).toBe("2026-10-28T12:05:00.000Z");

    const events = store.getEventsForRun(TEST_RUN_ID);
    expect(events.some((e) => e.eventId === "evt-coexist-01")).toBe(true);
  });

  // ==========================================================================
  // Phase 48AG.2: Mutation Authority Fencing Contract Tests
  // ==========================================================================
  describe("Phase 48AG.2: Mutation Authority Fencing", () => {
    const createTestIntent = (mutationId: string, workerLeaseId: string = TEST_LEASE_ID): MutationIntent => {
      const intent: MutationIntent = {
        mutationId,
        runId: TEST_RUN_ID,
        workerLeaseId,
        relativePath: "src/auth-test.ts",
        canonicalPath: "/workspace/src/auth-test.ts",
        parentMutationId: null,
        pathMutationVersion: 1,
        baseDigest: "0".repeat(64),
        expectedResultingDigest: "1".repeat(64),
        snapshotRef: `/snapshots/${mutationId}.snap`,
        recoveryDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, mutationId, "RECORDED"),
        lifecycleStatus: "RECORDED",
        createdAt: 1729900000000,
        updatedAt: 1729900000000,
      };
      store.recordIntent(intent);
      return intent;
    };

    // 1. Missing or untyped authority context is rejected at runtime
    it("Test 1: Missing or invalid authority context is rejected with MissingMutationAuthorityError", () => {
      createTestIntent("mut-auth-01");

      // Omitted authorityContext
      expect(() => {
        (store.transitionMutationStatus as any)({
          mutationId: "mut-auth-01",
          fromStatus: "RECORDED",
          toStatus: "SNAPSHOT_WRITTEN",
          event: {
            eventId: "evt-missing-auth",
            runId: TEST_RUN_ID,
            timestamp: new Date().toISOString(),
            eventType: "file.snapshot_written",
            schemaVersion: 1,
            producer: "TEST",
            payload: {},
          },
          nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-auth-01", "SNAPSHOT_WRITTEN"),
        });
      }).toThrow(MissingMutationAuthorityError);

      // Untyped / invalid authority label
      expect(() => {
        store.transitionMutationStatus({
          mutationId: "mut-auth-01",
          fromStatus: "RECORDED",
          toStatus: "SNAPSHOT_WRITTEN",
          event: {
            eventId: "evt-invalid-auth",
            runId: TEST_RUN_ID,
            timestamp: new Date().toISOString(),
            eventType: "file.snapshot_written",
            schemaVersion: 1,
            producer: "TEST",
            payload: {},
          },
          nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-auth-01", "SNAPSHOT_WRITTEN"),
          authorityContext: { authority: "UNAUTHORIZED_ROLE" as any, fencing: defaultWorkerAuthority.fencing as any },
        });
      }).toThrow(MissingMutationAuthorityError);
    });

    // 2. Workers cannot execute supervisor-only transitions
    it("Test 2: Worker authority is rejected when attempting supervisor recovery transitions", () => {
      createTestIntent("mut-auth-02");

      // Worker attempting ABORTED_UNMUTATED from RECORDED
      expect(() => {
        store.transitionMutationStatus({
          mutationId: "mut-auth-02",
          fromStatus: "RECORDED",
          toStatus: "ABORTED_UNMUTATED",
          event: {
            eventId: "evt-worker-abort",
            runId: TEST_RUN_ID,
            timestamp: new Date().toISOString(),
            eventType: "file.mutation_aborted",
            schemaVersion: 1,
            producer: "WORKER",
            payload: {},
          },
          nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-auth-02", "ABORTED_UNMUTATED"),
          authorityContext: defaultWorkerAuthority,
        });
      }).toThrow(UnauthorizedMutationTransitionError);
    });

    // 3. Supervisors cannot execute worker-only forward transitions
    it("Test 3: Supervisor authority is rejected when attempting forward worker transitions", () => {
      createTestIntent("mut-auth-03");

      // Supervisor attempting SNAPSHOT_WRITTEN from RECORDED
      expect(() => {
        store.transitionMutationStatus({
          mutationId: "mut-auth-03",
          fromStatus: "RECORDED",
          toStatus: "SNAPSHOT_WRITTEN",
          event: {
            eventId: "evt-super-snap",
            runId: TEST_RUN_ID,
            timestamp: new Date().toISOString(),
            eventType: "file.snapshot_written",
            schemaVersion: 1,
            producer: "SUPERVISOR",
            payload: {},
          },
          nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-auth-03", "SNAPSHOT_WRITTEN"),
          authorityContext: defaultSupervisorAuthority,
        });
      }).toThrow(UnauthorizedMutationTransitionError);
    });

    // 4. Invalid, expired, stale, mismatched fencing data is rejected
    it("Test 4: Expired or mismatched worker and supervisor leases are rejected", () => {
      createTestIntent("mut-auth-04");

      // Expired worker lease
      expect(() => {
        store.transitionMutationStatus({
          mutationId: "mut-auth-04",
          fromStatus: "RECORDED",
          toStatus: "SNAPSHOT_WRITTEN",
          event: {
            eventId: "evt-exp-worker",
            runId: TEST_RUN_ID,
            timestamp: new Date().toISOString(),
            eventType: "file.snapshot_written",
            schemaVersion: 1,
            producer: "WORKER",
            payload: {},
          },
          nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-auth-04", "SNAPSHOT_WRITTEN"),
          authorityContext: {
            authority: "WORKER",
            fencing: {
              workerId: TEST_WORKER_ID,
              leaseId: TEST_LEASE_ID,
              nowIso: "2150-01-01T00:00:00.000Z",
            },
          },
        });
      }).toThrow(LeaseExpiredError);

      // Expired supervisor lease
      expect(() => {
        store.transitionMutationStatus({
          mutationId: "mut-auth-04",
          fromStatus: "RECORDED",
          toStatus: "ABORTED_UNMUTATED",
          event: {
            eventId: "evt-exp-super",
            runId: TEST_RUN_ID,
            timestamp: new Date().toISOString(),
            eventType: "file.mutation_aborted",
            schemaVersion: 1,
            producer: "SUPERVISOR",
            payload: {},
          },
          nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-auth-04", "ABORTED_UNMUTATED"),
          authorityContext: {
            authority: "SUPERVISOR",
            supervisorFencing: {
              supervisorId: TEST_SUPERVISOR_ID,
              leaseId: TEST_SUPERVISOR_LEASE_ID,
              nowIso: "2150-01-01T00:00:00.000Z",
            },
          },
        });
      }).toThrow(SupervisorLeaseExpiredError);
    });

    // 5. A worker cannot transition another worker's mutation intent
    it("Test 5: A worker cannot transition another worker's mutation intent", () => {
      // Create second worker and second lease for the same run
      const WORKER_2 = "worker-persistence-02";
      const LEASE_2 = "lease-persistence-02";
      store.transaction((tx) => {
        tx.insertWorker({
          workerId: WORKER_2,
          hostname: "localhost",
          pid: process.pid,
          status: "ACTIVE",
          lastHeartbeatAt: "2026-10-28T12:00:00.000Z",
          createdAt: "2026-10-28T12:00:00.000Z",
        });
        tx.insertLease({
          leaseId: LEASE_2,
          runId: TEST_RUN_ID,
          workerId: WORKER_2,
          acquiredAt: "2026-10-28T12:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
          releasedAt: null,
          state: "ACTIVE",
        });
      });

      // Intent recorded by WORKER 1 (TEST_LEASE_ID)
      createTestIntent("mut-auth-05", TEST_LEASE_ID);

      // WORKER 2 attempts to transition it
      expect(() => {
        store.transitionMutationStatus({
          mutationId: "mut-auth-05",
          fromStatus: "RECORDED",
          toStatus: "SNAPSHOT_WRITTEN",
          event: {
            eventId: "evt-thief-worker",
            runId: TEST_RUN_ID,
            timestamp: new Date().toISOString(),
            eventType: "file.snapshot_written",
            schemaVersion: 1,
            producer: "WORKER",
            payload: {},
          },
          nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-auth-05", "SNAPSHOT_WRITTEN"),
          authorityContext: {
            authority: "WORKER",
            fencing: {
              workerId: WORKER_2,
              leaseId: LEASE_2,
              nowIso: "2026-10-28T12:00:00.000Z",
            },
          },
        });
      }).toThrow(LeaseLostError);
    });

    // 6. A supervisor cannot transition a mutation intent belonging to an unrelated run
    it("Test 6: A supervisor cannot transition a mutation intent belonging to an unrelated run", () => {
      // Create foreign run with its own supervisor lease
      const FOREIGN_RUN = "run-foreign-01";
      const FOREIGN_SUPERVISOR_LEASE = "supervisor-lease-foreign-01";
      store.transaction((tx) => {
        const runSnapshot: RunSnapshot = {
          runId: FOREIGN_RUN,
          taskId: TEST_TASK_ID,
          status: "RUNNING",
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
          eventId: "evt-foreign-run-created",
          runId: FOREIGN_RUN,
          timestamp: "2026-10-28T12:00:00.000Z",
          eventType: "run.created",
          schemaVersion: 1,
          producer: "TEST",
          payload: {},
        });
        db.prepare(`
          INSERT INTO supervisor_leases (lease_id, run_id, supervisor_id, acquired_at, expires_at, state)
          VALUES (?, ?, ?, ?, ?, 'ACTIVE')
        `).run(FOREIGN_SUPERVISOR_LEASE, FOREIGN_RUN, TEST_SUPERVISOR_ID, "2026-10-28T12:00:00.000Z", "2099-01-01T00:00:00.000Z");
      });

      // Intent belongs to TEST_RUN_ID
      createTestIntent("mut-auth-06");

      // Supervisor presenting foreign lease for TEST_RUN_ID intent
      expect(() => {
        store.transitionMutationStatus({
          mutationId: "mut-auth-06",
          fromStatus: "RECORDED",
          toStatus: "ABORTED_UNMUTATED",
          event: {
            eventId: "evt-foreign-super",
            runId: TEST_RUN_ID,
            timestamp: new Date().toISOString(),
            eventType: "file.mutation_aborted",
            schemaVersion: 1,
            producer: "SUPERVISOR",
            payload: {},
          },
          nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-auth-06", "ABORTED_UNMUTATED"),
          authorityContext: {
            authority: "SUPERVISOR",
            supervisorFencing: {
              supervisorId: TEST_SUPERVISOR_ID,
              leaseId: FOREIGN_SUPERVISOR_LEASE, // foreign run lease!
              nowIso: "2026-10-28T12:00:00.000Z",
            },
          },
        });
      }).toThrow(SupervisorLeaseLostError);
    });

    // 7. Valid authorized transitions continue to work
    it("Test 7: Valid worker and supervisor transitions succeed when properly authorized", () => {
      createTestIntent("mut-auth-07");

      // Valid worker forward transition: RECORDED -> SNAPSHOT_WRITTEN
      const ev1 = store.transitionMutationStatus({
        mutationId: "mut-auth-07",
        fromStatus: "RECORDED",
        toStatus: "SNAPSHOT_WRITTEN",
        event: {
          eventId: "evt-valid-snap",
          runId: TEST_RUN_ID,
          timestamp: new Date().toISOString(),
          eventType: "file.snapshot_written",
          schemaVersion: 1,
          producer: "WORKER",
          payload: {},
        },
        nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-auth-07", "SNAPSHOT_WRITTEN"),
        authorityContext: defaultWorkerAuthority,
      });
      expect(ev1.eventId).toBe("evt-valid-snap");
      expect(store.getIntent("mut-auth-07")?.lifecycleStatus).toBe("SNAPSHOT_WRITTEN");

      // Valid supervisor recovery transition: SNAPSHOT_WRITTEN -> ABORTED_UNMUTATED
      const ev2 = store.transitionMutationStatus({
        mutationId: "mut-auth-07",
        fromStatus: "SNAPSHOT_WRITTEN",
        toStatus: "ABORTED_UNMUTATED",
        event: {
          eventId: "evt-valid-abort",
          runId: TEST_RUN_ID,
          timestamp: new Date().toISOString(),
          eventType: "file.mutation_aborted",
          schemaVersion: 1,
          producer: "SUPERVISOR",
          payload: {},
        },
        nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-auth-07", "ABORTED_UNMUTATED"),
        authorityContext: defaultSupervisorAuthority,
      });
      expect(ev2.eventId).toBe("evt-valid-abort");
      expect(store.getIntent("mut-auth-07")?.lifecycleStatus).toBe("ABORTED_UNMUTATED");
    });

    // 8. Failed authorization leaves mutation status and associated event history unchanged
    it("Test 8: Failed authorization leaves database row and event stream unchanged", () => {
      createTestIntent("mut-auth-08");
      const eventsBefore = store.getEventsForRun(TEST_RUN_ID);

      expect(() => {
        store.transitionMutationStatus({
          mutationId: "mut-auth-08",
          fromStatus: "RECORDED",
          toStatus: "ROLLED_BACK", // illegal forward for worker + illegal from RECORDED
          event: {
            eventId: "evt-unauth-fail",
            runId: TEST_RUN_ID,
            timestamp: new Date().toISOString(),
            eventType: "file.rollback_completed",
            schemaVersion: 1,
            producer: "WORKER",
            payload: {},
          },
          nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-auth-08", "ROLLED_BACK"),
          authorityContext: defaultWorkerAuthority,
        });
      }).toThrow();

      // Mutation row remains unchanged
      const intentAfter = store.getIntent("mut-auth-08");
      expect(intentAfter?.lifecycleStatus).toBe("RECORDED");
      expect(intentAfter?.recoveryDedupToken).toBe(computeRecoveryDedupToken(TEST_RUN_ID, "mut-auth-08", "RECORDED"));

      // Event stream unchanged
      const eventsAfter = store.getEventsForRun(TEST_RUN_ID);
      expect(eventsAfter.length).toBe(eventsBefore.length);
      expect(eventsAfter.some((e) => e.eventId === "evt-unauth-fail")).toBe(false);
    });

    // 9. Transaction rollback preserves persistence consistency if validation fails
    it("Test 9: Transaction rollback preserves persistence consistency on validation error", () => {
      createTestIntent("mut-auth-09");

      expect(() => {
        store.transaction((tx) => {
          // Worker attempts illegal supervisor transition
          tx.transitionMutationStatus({
            mutationId: "mut-auth-09",
            fromStatus: "RECORDED",
            toStatus: "ABORTED_UNMUTATED",
            event: {
              eventId: "evt-tx-fail",
              runId: TEST_RUN_ID,
              timestamp: new Date().toISOString(),
              eventType: "file.mutation_aborted",
              schemaVersion: 1,
              producer: "WORKER",
              payload: {},
            },
            nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-auth-09", "ABORTED_UNMUTATED"),
            authorityContext: defaultWorkerAuthority,
          });
        });
      }).toThrow(UnauthorizedMutationTransitionError);

      const intent = store.getIntent("mut-auth-09");
      expect(intent?.lifecycleStatus).toBe("RECORDED");
      expect(store.getEventsForRun(TEST_RUN_ID).some((e) => e.eventId === "evt-tx-fail")).toBe(false);
    });

    // 10. Existing idempotency and event-sequence behavior remains intact
    it("Test 10: Idempotent duplicate replay with valid authority preserves event sequence and token", () => {
      createTestIntent("mut-auth-10");

      const params = {
        mutationId: "mut-auth-10",
        fromStatus: "RECORDED" as const,
        toStatus: "SNAPSHOT_WRITTEN" as const,
        event: {
          eventId: "evt-idempotent-auth",
          runId: TEST_RUN_ID,
          timestamp: new Date().toISOString(),
          eventType: "file.snapshot_written",
          schemaVersion: 1,
          producer: "WORKER",
          payload: { step: 1 },
        },
        nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-auth-10", "SNAPSHOT_WRITTEN"),
        authorityContext: defaultWorkerAuthority,
      };

      const e1 = store.transitionMutationStatus(params);
      const e2 = store.transitionMutationStatus(params);

      expect(e1.eventId).toBe("evt-idempotent-auth");
      expect(e2.eventId).toBe("evt-idempotent-auth");
      expect(e1.sequence).toBe(e2.sequence);

      const matching = store.getEventsForRun(TEST_RUN_ID).filter((e) => e.eventId === "evt-idempotent-auth");
      expect(matching.length).toBe(1);
    });

    // 11. Missing, empty string, and whitespace-only worker identity rejected with MissingMutationAuthorityError
    it("Test 11: Missing, empty, whitespace-only, or invalid worker/supervisor identity rejected fail-closed", () => {
      createTestIntent("mut-auth-11");

      const invalidIdentities = ["", "   ", "\t\n  ", undefined as any];

      for (const badId of invalidIdentities) {
        expect(() => {
          store.transitionMutationStatus({
            mutationId: "mut-auth-11",
            fromStatus: "RECORDED",
            toStatus: "SNAPSHOT_WRITTEN",
            event: {
              eventId: "evt-auth-11-worker",
              runId: TEST_RUN_ID,
              timestamp: new Date().toISOString(),
              eventType: "file.snapshot_written",
              schemaVersion: 1,
              producer: "WORKER",
              payload: {},
            },
            nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-auth-11", "SNAPSHOT_WRITTEN"),
            authorityContext: {
              authority: "WORKER",
              fencing: {
                workerId: badId,
                leaseId: TEST_LEASE_ID,
                nowIso: "2026-10-28T12:00:00.000Z",
              },
            },
          });
        }).toThrow(MissingMutationAuthorityError);
      }

      // Empty / whitespace leaseId for worker
      expect(() => {
        store.transitionMutationStatus({
          mutationId: "mut-auth-11",
          fromStatus: "RECORDED",
          toStatus: "SNAPSHOT_WRITTEN",
          event: {
            eventId: "evt-auth-11-worker-lease",
            runId: TEST_RUN_ID,
            timestamp: new Date().toISOString(),
            eventType: "file.snapshot_written",
            schemaVersion: 1,
            producer: "WORKER",
            payload: {},
          },
          nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-auth-11", "SNAPSHOT_WRITTEN"),
          authorityContext: {
            authority: "WORKER",
            fencing: {
              workerId: TEST_WORKER_ID,
              leaseId: "   ",
              nowIso: "2026-10-28T12:00:00.000Z",
            },
          },
        });
      }).toThrow(MissingMutationAuthorityError);

      // Empty / whitespace supervisorId for supervisor
      expect(() => {
        store.transitionMutationStatus({
          mutationId: "mut-auth-11",
          fromStatus: "RECORDED",
          toStatus: "ABORTED_UNMUTATED",
          event: {
            eventId: "evt-auth-11-supervisor",
            runId: TEST_RUN_ID,
            timestamp: new Date().toISOString(),
            eventType: "file.mutation_aborted",
            schemaVersion: 1,
            producer: "SUPERVISOR",
            payload: {},
          },
          nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-auth-11", "ABORTED_UNMUTATED"),
          authorityContext: {
            authority: "SUPERVISOR",
            supervisorFencing: {
              supervisorId: "",
              leaseId: TEST_SUPERVISOR_LEASE_ID,
              nowIso: "2026-10-28T12:00:00.000Z",
            },
          },
        });
      }).toThrow(MissingMutationAuthorityError);
    });

    // 12. Strict unconditional equality check against runs.current_worker_id and leases.worker_id
    it("Test 12: Mismatched workerId rejected unconditionally with LeaseLostError", () => {
      createTestIntent("mut-auth-12");

      // 12a: workerId does not match runs.current_worker_id
      expect(() => {
        store.transitionMutationStatus({
          mutationId: "mut-auth-12",
          fromStatus: "RECORDED",
          toStatus: "SNAPSHOT_WRITTEN",
          event: {
            eventId: "evt-auth-12a",
            runId: TEST_RUN_ID,
            timestamp: new Date().toISOString(),
            eventType: "file.snapshot_written",
            schemaVersion: 1,
            producer: "WORKER",
            payload: {},
          },
          nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-auth-12", "SNAPSHOT_WRITTEN"),
          authorityContext: {
            authority: "WORKER",
            fencing: {
              workerId: "rogue-worker-identity",
              leaseId: TEST_LEASE_ID,
              nowIso: "2026-10-28T12:00:00.000Z",
            },
          },
        });
      }).toThrow(LeaseLostError);

      // 12b: workerId matches run but differs from leaseRow.worker_id
      const OTHER_WORKER = "worker-persistence-other";
      const OTHER_LEASE = "lease-persistence-other";
      store.transaction((tx) => {
        tx.insertWorker({
          workerId: OTHER_WORKER,
          hostname: "localhost",
          pid: process.pid,
          status: "ACTIVE",
          lastHeartbeatAt: "2026-10-28T12:00:00.000Z",
          createdAt: "2026-10-28T12:00:00.000Z",
        });
        tx.insertLease({
          leaseId: OTHER_LEASE,
          runId: TEST_RUN_ID,
          workerId: OTHER_WORKER,
          acquiredAt: "2026-10-28T12:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
          releasedAt: null,
          state: "ACTIVE",
        });
      });

      expect(() => {
        store.transitionMutationStatus({
          mutationId: "mut-auth-12",
          fromStatus: "RECORDED",
          toStatus: "SNAPSHOT_WRITTEN",
          event: {
            eventId: "evt-auth-12b",
            runId: TEST_RUN_ID,
            timestamp: new Date().toISOString(),
            eventType: "file.snapshot_written",
            schemaVersion: 1,
            producer: "WORKER",
            payload: {},
          },
          nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-auth-12", "SNAPSHOT_WRITTEN"),
          authorityContext: {
            authority: "WORKER",
            fencing: {
              workerId: TEST_WORKER_ID, // matches run, but OTHER_LEASE belongs to OTHER_WORKER
              leaseId: OTHER_LEASE,
              nowIso: "2026-10-28T12:00:00.000Z",
            },
          },
        });
      }).toThrow(LeaseLostError);
    });

    // 13. Stale historical nowIso cannot bypass lease expiry
    it("Test 13: Stale historical nowIso cannot bypass lease expiry on expired worker or supervisor lease", () => {
      createTestIntent("mut-auth-13");

      // Temporarily mark TEST_LEASE_ID as expired in SQLite
      db.prepare("UPDATE leases SET expires_at = ? WHERE lease_id = ?").run("2020-01-01T00:01:00.000Z", TEST_LEASE_ID);

      try {
        // Passing a historical nowIso (e.g. 2020-01-01T00:00:30.000Z) before expiresAt
        // must NOT bypass expiry because effectiveNowMs = Math.max(Date.now(), callerNowMs)
        expect(() => {
          store.transitionMutationStatus({
            mutationId: "mut-auth-13",
            fromStatus: "RECORDED",
            toStatus: "SNAPSHOT_WRITTEN",
            event: {
              eventId: "evt-auth-13-stale-worker",
              runId: TEST_RUN_ID,
              timestamp: "2020-01-01T00:00:30.000Z",
              eventType: "file.snapshot_written",
              schemaVersion: 1,
              producer: "WORKER",
              payload: {},
            },
            nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-auth-13", "SNAPSHOT_WRITTEN"),
            authorityContext: {
              authority: "WORKER",
              fencing: {
                workerId: TEST_WORKER_ID,
                leaseId: TEST_LEASE_ID,
                nowIso: "2020-01-01T00:00:30.000Z",
              },
            },
          });
        }).toThrow(LeaseExpiredError);
      } finally {
        db.prepare("UPDATE leases SET expires_at = ? WHERE lease_id = ?").run("2099-01-01T00:00:00.000Z", TEST_LEASE_ID);
      }

      // Expired supervisor lease with historical nowIso
      const EXPIRED_SUPERVISOR_LEASE = "sup-lease-expired-stale-time";
      // Supervisor authority is exclusive per run: retire the fixture's live lease so the
      // time-expired ACTIVE lease below is the only ACTIVE row (expiry-by-time is what is under test).
      db.prepare(`UPDATE supervisor_leases SET state = 'EXPIRED' WHERE lease_id = ?`).run(TEST_SUPERVISOR_LEASE_ID);
      db.prepare(`
        INSERT INTO supervisor_leases (lease_id, run_id, supervisor_id, acquired_at, expires_at, state)
        VALUES (?, ?, ?, ?, ?, 'ACTIVE')
      `).run(EXPIRED_SUPERVISOR_LEASE, TEST_RUN_ID, TEST_SUPERVISOR_ID, "2020-01-01T00:00:00.000Z", "2020-01-01T00:01:00.000Z");

      expect(() => {
        store.transitionMutationStatus({
          mutationId: "mut-auth-13",
          fromStatus: "RECORDED",
          toStatus: "ABORTED_UNMUTATED",
          event: {
            eventId: "evt-auth-13-stale-sup",
            runId: TEST_RUN_ID,
            timestamp: "2020-01-01T00:00:30.000Z",
            eventType: "file.mutation_aborted",
            schemaVersion: 1,
            producer: "SUPERVISOR",
            payload: {},
          },
          nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-auth-13", "ABORTED_UNMUTATED"),
          authorityContext: {
            authority: "SUPERVISOR",
            supervisorFencing: {
              supervisorId: TEST_SUPERVISOR_ID,
              leaseId: EXPIRED_SUPERVISOR_LEASE,
              nowIso: "2020-01-01T00:00:30.000Z",
            },
          },
        });
      }).toThrow(SupervisorLeaseExpiredError);
    });

    // 14. Malformed nowIso timestamp rejected fail-closed
    it("Test 14: Malformed nowIso string rejected with MissingMutationAuthorityError", () => {
      createTestIntent("mut-auth-14");

      // Worker malformed nowIso
      expect(() => {
        store.transitionMutationStatus({
          mutationId: "mut-auth-14",
          fromStatus: "RECORDED",
          toStatus: "SNAPSHOT_WRITTEN",
          event: {
            eventId: "evt-auth-14-bad-time",
            runId: TEST_RUN_ID,
            timestamp: new Date().toISOString(),
            eventType: "file.snapshot_written",
            schemaVersion: 1,
            producer: "WORKER",
            payload: {},
          },
          nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-auth-14", "SNAPSHOT_WRITTEN"),
          authorityContext: {
            authority: "WORKER",
            fencing: {
              workerId: TEST_WORKER_ID,
              leaseId: TEST_LEASE_ID,
              nowIso: "invalid-timestamp-string",
            },
          },
        });
      }).toThrow(MissingMutationAuthorityError);

      // Supervisor malformed nowIso
      expect(() => {
        store.transitionMutationStatus({
          mutationId: "mut-auth-14",
          fromStatus: "RECORDED",
          toStatus: "ABORTED_UNMUTATED",
          event: {
            eventId: "evt-auth-14-bad-time-sup",
            runId: TEST_RUN_ID,
            timestamp: new Date().toISOString(),
            eventType: "file.mutation_aborted",
            schemaVersion: 1,
            producer: "SUPERVISOR",
            payload: {},
          },
          nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-auth-14", "ABORTED_UNMUTATED"),
          authorityContext: {
            authority: "SUPERVISOR",
            supervisorFencing: {
              supervisorId: TEST_SUPERVISOR_ID,
              leaseId: TEST_SUPERVISOR_LEASE_ID,
              nowIso: "not-a-valid-date",
            },
          },
        });
      }).toThrow(MissingMutationAuthorityError);
    });

    // 15. Terminal run states reject transitions with TerminalStateError
    it("Test 15: Terminal run states (COMPLETED, FAILED, CANCELLED, TIMED_OUT) reject transitions with TerminalStateError", () => {
      createTestIntent("mut-auth-15");

      const terminalStatuses = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"] as const;

      for (const terminalStatus of terminalStatuses) {
        store.transaction((tx) => {
          (tx as any).db.prepare("UPDATE runs SET status = ? WHERE run_id = ?").run(terminalStatus, TEST_RUN_ID);
        });

        // Worker transition rejected
        expect(() => {
          store.transitionMutationStatus({
            mutationId: "mut-auth-15",
            fromStatus: "RECORDED",
            toStatus: "SNAPSHOT_WRITTEN",
            event: {
              eventId: `evt-term-worker-${terminalStatus}`,
              runId: TEST_RUN_ID,
              timestamp: new Date().toISOString(),
              eventType: "file.snapshot_written",
              schemaVersion: 1,
              producer: "WORKER",
              payload: {},
            },
            nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-auth-15", "SNAPSHOT_WRITTEN"),
            authorityContext: defaultWorkerAuthority,
          });
        }).toThrow(TerminalStateError);

        // Supervisor transition rejected
        expect(() => {
          store.transitionMutationStatus({
            mutationId: "mut-auth-15",
            fromStatus: "RECORDED",
            toStatus: "ABORTED_UNMUTATED",
            event: {
              eventId: `evt-term-sup-${terminalStatus}`,
              runId: TEST_RUN_ID,
              timestamp: new Date().toISOString(),
              eventType: "file.mutation_aborted",
              schemaVersion: 1,
              producer: "SUPERVISOR",
              payload: {},
            },
            nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-auth-15", "ABORTED_UNMUTATED"),
            authorityContext: defaultSupervisorAuthority,
          });
        }).toThrow(TerminalStateError);
      }

      // Restore run to RUNNING
      store.transaction((tx) => {
        (tx as any).db.prepare("UPDATE runs SET status = 'RUNNING' WHERE run_id = ?").run(TEST_RUN_ID);
      });
    });

    // 16. Worker transition rejected when run is in RECOVERING
    it("Test 16: Worker transition rejected when run is in RECOVERING status", () => {
      createTestIntent("mut-auth-16");

      store.transaction((tx) => {
        (tx as any).db.prepare("UPDATE runs SET status = 'RECOVERING' WHERE run_id = ?").run(TEST_RUN_ID);
      });

      try {
        expect(() => {
          store.transitionMutationStatus({
            mutationId: "mut-auth-16",
            fromStatus: "RECORDED",
            toStatus: "SNAPSHOT_WRITTEN",
            event: {
              eventId: "evt-auth-16-worker",
              runId: TEST_RUN_ID,
              timestamp: new Date().toISOString(),
              eventType: "file.snapshot_written",
              schemaVersion: 1,
              producer: "WORKER",
              payload: {},
            },
            nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-auth-16", "SNAPSHOT_WRITTEN"),
            authorityContext: defaultWorkerAuthority,
          });
        }).toThrow(UnauthorizedMutationTransitionError);
      } finally {
        store.transaction((tx) => {
          (tx as any).db.prepare("UPDATE runs SET status = 'RUNNING' WHERE run_id = ?").run(TEST_RUN_ID);
        });
      }
    });

    // 17. Supervisor transition succeeds with authority acquired via store.acquireSupervisorLease()
    it("Test 17: Supervisor transition succeeds with authority acquired via store.acquireSupervisorLease()", () => {
      const LIFECYCLE_RUN = "run-lifecycle-auth";
      const LIFECYCLE_TASK = "task-lifecycle-auth";
      const LIFECYCLE_WORKER = "worker-lifecycle-auth";
      const LIFECYCLE_LEASE = "lease-lifecycle-auth";
      store.transaction((tx) => {
        tx.insertTask({
          taskId: LIFECYCLE_TASK,
          title: "Lifecycle Task",
          description: "Testing supervisor lifecycle",
          inputPayload: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        tx.insertWorker({
          workerId: LIFECYCLE_WORKER,
          hostname: "localhost",
          pid: process.pid,
          status: "ACTIVE",
          lastHeartbeatAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        });
        const runSnapshot: RunSnapshot = {
          runId: LIFECYCLE_RUN,
          taskId: LIFECYCLE_TASK,
          status: "RECOVERING",
          version: 1,
          attemptCount: 1,
          maxAttempts: 3,
          timeoutMs: 30000,
          idempotencyKey: null,
          currentWorkerId: LIFECYCLE_WORKER,
          leaseId: LIFECYCLE_LEASE,
          leaseExpiresAt: "2099-01-01T00:00:00.000Z",
          resultPayload: null,
          errorPayload: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          contractBinding: null,
          maxOutputBytes: null,
        };
        tx.insertRun(runSnapshot, {
          eventId: "evt-lifecycle-run-created",
          runId: LIFECYCLE_RUN,
          timestamp: new Date().toISOString(),
          eventType: "run.created",
          schemaVersion: 1,
          producer: "TEST",
          payload: {},
        });
        tx.insertLease({
          leaseId: LIFECYCLE_LEASE,
          runId: LIFECYCLE_RUN,
          workerId: LIFECYCLE_WORKER,
          acquiredAt: new Date().toISOString(),
          expiresAt: "2099-01-01T00:00:00.000Z",
          releasedAt: null,
          state: "ACTIVE",
        });
        tx.recordIntent({
          mutationId: "mut-lifecycle-01",
          runId: LIFECYCLE_RUN,
          workerLeaseId: LIFECYCLE_LEASE,
          relativePath: "src/lifecycle.ts",
          canonicalPath: "/workspace/src/lifecycle.ts",
          parentMutationId: null,
          pathMutationVersion: 1,
          baseDigest: "0".repeat(64),
          expectedResultingDigest: "1".repeat(64),
          snapshotRef: "/snapshots/lifecycle.snap",
          recoveryDedupToken: computeRecoveryDedupToken(LIFECYCLE_RUN, "mut-lifecycle-01", "RECORDED"),
          lifecycleStatus: "RECORDED",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      });

      const lifecycleSupervisorId = "supervisor-lifecycle-integration";
      const nowIso = new Date().toISOString();
      const supLease = store.acquireSupervisorLease({
        runId: LIFECYCLE_RUN,
        supervisorId: lifecycleSupervisorId,
        ttlMs: 60000,
        nowIso,
      });

      expect(supLease.leaseId).toBeDefined();
      expect(supLease.supervisorId).toBe(lifecycleSupervisorId);
      expect(supLease.state).toBe("ACTIVE");

      const supervisorAuthority: MutationAuthorityContext = {
        authority: "SUPERVISOR",
        supervisorFencing: {
          supervisorId: supLease.supervisorId,
          leaseId: supLease.leaseId,
          nowIso: new Date().toISOString(),
        },
      };

      const event = store.transitionMutationStatus({
        mutationId: "mut-lifecycle-01",
        fromStatus: "RECORDED",
        toStatus: "ABORTED_UNMUTATED",
        event: {
          eventId: "evt-auth-17-lifecycle-sup",
          runId: LIFECYCLE_RUN,
          timestamp: new Date().toISOString(),
          eventType: "file.mutation_aborted",
          schemaVersion: 1,
          producer: "SUPERVISOR",
          payload: { reason: "Acquired via acquireSupervisorLease lifecycle API" },
        },
        nextDedupToken: computeRecoveryDedupToken(LIFECYCLE_RUN, "mut-lifecycle-01", "ABORTED_UNMUTATED"),
        authorityContext: supervisorAuthority,
      });

      expect(event.eventId).toBe("evt-auth-17-lifecycle-sup");
      const intent = store.getIntent("mut-lifecycle-01");
      expect(intent?.lifecycleStatus).toBe("ABORTED_UNMUTATED");
      expect(intent?.recoveryDedupToken).toBe(computeRecoveryDedupToken(LIFECYCLE_RUN, "mut-lifecycle-01", "ABORTED_UNMUTATED"));
    });
  });
});
