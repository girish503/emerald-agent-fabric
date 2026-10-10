import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { LeaseLostError, VersionConflictError } from "../../src/domain/errors.js";
import { Run } from "../../src/domain/run.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";

describe("Concurrency, OCC, and Lease Fencing", () => {
  let tempDir: string;
  let dbPath: string;
  let store: SqliteStateStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-fencing-test-"));
    dbPath = path.join(tempDir, "test.db");
    store = new SqliteStateStore({ location: dbPath });

    store.transaction((tx) => {
      tx.insertTask({
        taskId: "task-fence-1",
        title: "Fencing Task",
        description: "Testing lease fencing and OCC",
        inputPayload: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      tx.insertWorker({
        workerId: "worker-A",
        hostname: "node-1",
        pid: 1001,
        status: "ACTIVE",
        lastHeartbeatAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });
      tx.insertWorker({
        workerId: "worker-B",
        hostname: "node-2",
        pid: 1002,
        status: "ACTIVE",
        lastHeartbeatAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });
    });
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  describe("Request Idempotency", () => {
    it("returns existing run and prevents duplicate insertion when identical idempotencyKey is submitted", () => {
      const { run: run1, event: event1 } = Run.create({
        runId: "run-idem-1",
        taskId: "task-fence-1",
        idempotencyKey: "unique-request-token-123",
      });

      // First submission
      const persisted1 = store.transaction((tx) => tx.insertRun(run1.snapshot, event1));
      expect(persisted1.runId).toBe("run-idem-1");

      // Second submission with same idempotencyKey but different runId
      const { run: run2, event: event2 } = Run.create({
        runId: "run-idem-2",
        taskId: "task-fence-1",
        idempotencyKey: "unique-request-token-123",
      });

      const persisted2 = store.transaction((tx) => tx.insertRun(run2.snapshot, event2));
      // Must return existing run-idem-1's initial event
      expect(persisted2.runId).toBe("run-idem-1");

      // Ensure run-idem-2 was never created
      expect(store.getRun("run-idem-2")).toBeNull();

      // Ensure only 1 run and 1 event exist
      const run = store.getRunByIdempotencyKey("unique-request-token-123");
      expect(run?.runId).toBe("run-idem-1");
      const events = store.getEventsForRun("run-idem-1");
      expect(events.length).toBe(1);
    });
  });

  describe("Optimistic Concurrency Control (OCC)", () => {
    it("rejects concurrent mutation with VersionConflictError when versions diverge", () => {
      const { run, event: createdEvent } = Run.create({
        runId: "run-occ-1",
        taskId: "task-fence-1",
      });

      store.transaction((tx) => {
        tx.insertRun(run.snapshot, createdEvent);
      });

      // Both Worker A and Worker B read run at version 1
      const initial = store.getRun("run-occ-1");
      expect(initial?.version).toBe(1);

      // Worker A updates from version 1 -> 2
      const runA = Run.reconstitute(initial!);
      const queuedA = runA.queue();
      store.transaction((tx) => {
        tx.updateRun(runA.runId, 1, runA.snapshot, queuedA);
      });

      expect(store.getRun("run-occ-1")?.version).toBe(2);

      // Worker B attempts to update from version 1 -> 2 using stale snapshot
      const runB = Run.reconstitute(initial!);
      const queuedB = runB.queue();
      expect(() => {
        store.transaction((tx) => {
          tx.updateRun(runB.runId, 1, runB.snapshot, queuedB);
        });
      }).toThrow(VersionConflictError);

      // Verify version remains 2
      expect(store.getRun("run-occ-1")?.version).toBe(2);
    });
  });

  describe("Lease Fencing (Stale Worker Prevention)", () => {
    it("rejects stale worker mutation with LeaseLostError after lease is reassigned", () => {
      // 1. Create run and queue it
      const { run, event: createdEvent } = Run.create({
        runId: "run-fence-test",
        taskId: "task-fence-1",
      });
      store.transaction((tx) => {
        tx.insertRun(run.snapshot, createdEvent);
      });

      const qEvent = run.queue();
      store.transaction((tx) => {
        tx.updateRun(run.runId, 1, run.snapshot, qEvent);
      });

      // 2. Worker A acquires Lease A
      const claimA = run.claim("worker-A", "lease-A", "2026-10-10T12:05:00.000Z");
      store.transaction((tx) => {
        tx.updateRun(run.runId, 2, run.snapshot, claimA);
        tx.insertLease({
          leaseId: "lease-A",
          runId: "run-fence-test",
          workerId: "worker-A",
          acquiredAt: new Date().toISOString(),
          expiresAt: "2026-10-10T12:05:00.000Z",
          releasedAt: null,
          state: "ACTIVE",
        });
      });

      // Worker A starts running
      const startA = run.start("worker-A", "lease-A");
      store.transaction((tx) => {
        tx.updateRun(run.runId, 3, run.snapshot, startA, {
          workerId: "worker-A",
          leaseId: "lease-A",
        });
      });

      expect(store.getRun("run-fence-test")?.status).toBe("RUNNING");
      expect(store.getRun("run-fence-test")?.leaseId).toBe("lease-A");
      expect(store.getRun("run-fence-test")?.version).toBe(4);

      // 3. Worker A stalls. Sweeper reclaims run and assigns Lease B to Worker B
      // Supervisor marks lease expired & recovers run
      const currentRunSnapshot = store.getRun("run-fence-test")!;
      const runRecovered = Run.reconstitute(currentRunSnapshot);
      const expireEvent = runRecovered.expireLease();
      store.transaction((tx) => {
        tx.updateRun(runRecovered.runId, 4, runRecovered.snapshot, expireEvent);
        tx.updateLeaseState("lease-A", "EXPIRED");
      });

      // Worker B claims the run with lease-B
      const claimB = runRecovered.claim("worker-B", "lease-B", "2026-10-10T12:10:00.000Z");
      store.transaction((tx) => {
        tx.updateRun(runRecovered.runId, 5, runRecovered.snapshot, claimB);
        tx.insertLease({
          leaseId: "lease-B",
          runId: "run-fence-test",
          workerId: "worker-B",
          acquiredAt: new Date().toISOString(),
          expiresAt: "2026-10-10T12:10:00.000Z",
          releasedAt: null,
          state: "ACTIVE",
        });
      });

      expect(store.getRun("run-fence-test")?.leaseId).toBe("lease-B");
      expect(store.getRun("run-fence-test")?.currentWorkerId).toBe("worker-B");
      expect(store.getRun("run-fence-test")?.version).toBe(6);

      // 4. Stale Worker A wakes up and attempts to complete run with lease-A
      expect(() => {
        store.transaction((tx) => {
          // Worker A tries to update using its old lease-A
          tx.updateRun(
            "run-fence-test",
            4, // Worker A's perceived version
            {
              ...run.snapshot,
              status: "COMPLETED",
              version: 5,
            },
            {
              eventId: "stale-complete-event",
              runId: "run-fence-test",
              timestamp: new Date().toISOString(),
              eventType: "run.completed",
              schemaVersion: 1,
              producer: "worker:worker-A",
              payload: {},
            },
            {
              workerId: "worker-A",
              leaseId: "lease-A",
            }
          );
        });
      }).toThrow(LeaseLostError);

      // Verify Worker B's active lease and run state were unaffected
      const finalState = store.getRun("run-fence-test")!;
      expect(finalState.status).toBe("LEASED");
      expect(finalState.currentWorkerId).toBe("worker-B");
      expect(finalState.leaseId).toBe("lease-B");
    });
  });
});
