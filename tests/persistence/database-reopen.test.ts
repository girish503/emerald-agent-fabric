import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { Run } from "../../src/domain/run.js";

describe("Database Reopen & Recovery Durability", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-reopen-test-"));
    dbPath = path.join(tempDir, "durable.db");
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  it("survives connection close and reopen with 100% state and event history integrity", () => {
    // Phase 1: Write state and events with Store 1
    const store1 = new SqliteStateStore({ location: dbPath });

    const now = "2026-10-10T12:00:00.000Z";
    store1.transaction((tx) => {
      tx.insertTask({
        taskId: "task-durable-1",
        title: "Durable Task",
        description: "Checking reopen persistence",
        inputPayload: { persistent: true },
        createdAt: now,
        updatedAt: now,
      });
      tx.insertWorker({
        workerId: "worker-durable-1",
        hostname: "host-1",
        pid: 4000,
        status: "ACTIVE",
        lastHeartbeatAt: now,
        createdAt: now,
      });
    });

    const { run, event: createdEvent } = Run.create({
      runId: "run-durable-1",
      taskId: "task-durable-1",
      idempotencyKey: "idem-durable-1",
      now,
    });

    store1.transaction((tx) => {
      tx.insertRun(run.snapshot, createdEvent);
    });

    const v1 = run.version;
    const queuedEvent = run.queue(now);
    store1.transaction((tx) => {
      tx.updateRun(run.runId, v1, run.snapshot, queuedEvent);
    });

    const v2 = run.version;
    const claimedEvent = run.claim("worker-durable-1", "lease-durable-1", "2026-10-10T12:10:00.000Z", now);
    store1.transaction((tx) => {
      tx.updateRun(run.runId, v2, run.snapshot, claimedEvent);
      tx.insertLease({
        leaseId: "lease-durable-1",
        runId: "run-durable-1",
        workerId: "worker-durable-1",
        acquiredAt: now,
        expiresAt: "2026-10-10T12:10:00.000Z",
        releasedAt: null,
        state: "ACTIVE",
      });
    });

    // Explicitly close Store 1
    store1.close();

    // Phase 2: Open Store 2 on the same database file
    const store2 = new SqliteStateStore({ location: dbPath });

    try {
      // 1. Verify Task
      const task = store2.getTask("task-durable-1");
      expect(task).not.toBeNull();
      expect(task?.title).toBe("Durable Task");
      expect(task?.inputPayload).toEqual({ persistent: true });

      // 2. Verify Worker
      const worker = store2.getWorker("worker-durable-1");
      expect(worker).not.toBeNull();
      expect(worker?.hostname).toBe("host-1");

      // 3. Verify Run
      const runSnapshot = store2.getRun("run-durable-1");
      expect(runSnapshot).not.toBeNull();
      expect(runSnapshot?.status).toBe("LEASED");
      expect(runSnapshot?.version).toBe(3);
      expect(runSnapshot?.currentWorkerId).toBe("worker-durable-1");
      expect(runSnapshot?.leaseId).toBe("lease-durable-1");

      // 4. Verify Events (Sequences 1, 2, 3)
      const events = store2.getEventsForRun("run-durable-1");
      expect(events.length).toBe(3);
      expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);
      expect(events[0]?.eventType).toBe("run.created");
      expect(events[1]?.eventType).toBe("run.queued");
      expect(events[2]?.eventType).toBe("worker.claimed");

      // 5. Continue execution against reopened store
      const resumedRun = Run.reconstitute(runSnapshot!);
      const v3 = resumedRun.version;
      const startedEvent = resumedRun.start("worker-durable-1", "lease-durable-1", now);
      store2.transaction((tx) => {
        tx.updateRun(resumedRun.runId, v3, resumedRun.snapshot, startedEvent, {
          workerId: "worker-durable-1",
          leaseId: "lease-durable-1",
        });
      });

      const updated = store2.getRun("run-durable-1");
      expect(updated?.status).toBe("RUNNING");
      expect(updated?.version).toBe(4);

      const updatedEvents = store2.getEventsForRun("run-durable-1");
      expect(updatedEvents.length).toBe(4);
      expect(updatedEvents.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
      expect(updatedEvents[3]?.eventType).toBe("run.started");
    } finally {
      store2.close();
    }
  });
});
