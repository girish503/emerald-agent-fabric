import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { Run } from "../../src/domain/run.js";

describe("Event Sequencing Semantics", () => {
  let tempDir: string;
  let dbPath: string;
  let store: SqliteStateStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-seq-test-"));
    dbPath = path.join(tempDir, "test.db");
    store = new SqliteStateStore({ location: dbPath });

    store.transaction((tx) => {
      tx.insertTask({
        taskId: "task-seq-1",
        title: "Sequence Task",
        description: "Testing gapless sequencing",
        inputPayload: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      tx.insertWorker({
        workerId: "worker-1",
        hostname: "node-seq-1",
        pid: 2001,
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

  it("allocates strictly gapless sequence numbers 1..5 across sequential transitions for a single run", () => {
    const { run, event: createdEvent } = Run.create({
      runId: "run-seq-single",
      taskId: "task-seq-1",
    });

    // 1. Create (Sequence 1)
    store.transaction((tx) => {
      tx.insertRun(run.snapshot, createdEvent);
    });

    // 2. Queue (Sequence 2)
    const v1 = run.version;
    const queuedEvent = run.queue();
    store.transaction((tx) => {
      tx.updateRun(run.runId, v1, run.snapshot, queuedEvent);
    });

    // 3. Claim (Sequence 3)
    const v2 = run.version;
    const claimedEvent = run.claim("worker-1", "lease-1", "2026-10-10T14:00:00.000Z");
    store.transaction((tx) => {
      tx.updateRun(run.runId, v2, run.snapshot, claimedEvent);
    });

    // 4. Start (Sequence 4)
    const v3 = run.version;
    const startedEvent = run.start("worker-1", "lease-1");
    store.transaction((tx) => {
      tx.updateRun(run.runId, v3, run.snapshot, startedEvent, {
        workerId: "worker-1",
        leaseId: "lease-1",
      });
    });

    // 5. Complete (Sequence 5)
    const v4 = run.version;
    const completedEvent = run.complete("worker-1", "lease-1", { result: "done" });
    store.transaction((tx) => {
      tx.updateRun(run.runId, v4, run.snapshot, completedEvent, {
        workerId: "worker-1",
        leaseId: "lease-1",
      });
    });

    const events = store.getEventsForRun("run-seq-single");
    expect(events.length).toBe(5);

    const sequences = events.map((e) => e.sequence);
    expect(sequences).toEqual([1, 2, 3, 4, 5]);

    expect(events[0]?.eventType).toBe("run.created");
    expect(events[1]?.eventType).toBe("run.queued");
    expect(events[2]?.eventType).toBe("worker.claimed");
    expect(events[3]?.eventType).toBe("run.started");
    expect(events[4]?.eventType).toBe("run.completed");
  });

  it("maintains independent gapless sequences for distinct runs", () => {
    const { run: runA, event: eventA } = Run.create({
      runId: "run-A",
      taskId: "task-seq-1",
    });
    const { run: runB, event: eventB } = Run.create({
      runId: "run-B",
      taskId: "task-seq-1",
    });

    store.transaction((tx) => {
      tx.insertRun(runA.snapshot, eventA);
      tx.insertRun(runB.snapshot, eventB);
    });

    // Advance Run A
    const vA = runA.version;
    const queuedA = runA.queue();
    store.transaction((tx) => {
      tx.updateRun(runA.runId, vA, runA.snapshot, queuedA);
    });

    // Advance Run B
    const vB = runB.version;
    const queuedB = runB.queue();
    store.transaction((tx) => {
      tx.updateRun(runB.runId, vB, runB.snapshot, queuedB);
    });

    const eventsA = store.getEventsForRun("run-A");
    const eventsB = store.getEventsForRun("run-B");

    expect(eventsA.map((e) => e.sequence)).toEqual([1, 2]);
    expect(eventsB.map((e) => e.sequence)).toEqual([1, 2]);
  });

  it("leaves no gap in committed sequences when an in-flight transaction rolls back", () => {
    const { run, event: createdEvent } = Run.create({
      runId: "run-seq-rollback",
      taskId: "task-seq-1",
    });

    store.transaction((tx) => {
      tx.insertRun(run.snapshot, createdEvent);
    });

    // Attempt a transition that rolls back mid-way
    expect(() => {
      store.transaction((tx) => {
        tx.appendEvent({
          eventId: "aborted-event",
          runId: run.runId,
          timestamp: new Date().toISOString(),
          eventType: "aborted.event",
          schemaVersion: 1,
          producer: "test",
          payload: {},
        });
        throw new Error("Force rollback");
      });
    }).toThrow();

    // Now perform a valid subsequent transition
    const v1 = run.version;
    const queuedEvent = run.queue();
    store.transaction((tx) => {
      tx.updateRun(run.runId, v1, run.snapshot, queuedEvent);
    });

    const events = store.getEventsForRun("run-seq-rollback");
    expect(events.length).toBe(2);
    // Sequences must be strictly [1, 2] without a gap at sequence 2
    expect(events.map((e) => e.sequence)).toEqual([1, 2]);
  });
});
