import { describe, expect, it } from "vitest";
import { TerminalStateError } from "../../src/domain/errors.js";
import { Run } from "../../src/domain/run.js";

describe("Run Aggregate Root", () => {
  const now = "2026-10-10T12:00:00.000Z";
  let eventSeq = 0;
  const mockEventIdGen = () => `event-${++eventSeq}`;

  it("creates a new run in CREATED state with version 1 and emits run.created", () => {
    const { run, event } = Run.create({
      runId: "run-001",
      taskId: "task-001",
      idempotencyKey: "idem-key-1",
      maxAttempts: 3,
      timeoutMs: 15000,
      now,
      eventIdGenerator: mockEventIdGen,
    });

    expect(run.runId).toBe("run-001");
    expect(run.taskId).toBe("task-001");
    expect(run.status).toBe("CREATED");
    expect(run.version).toBe(1);
    expect(run.attemptCount).toBe(0);
    expect(run.maxAttempts).toBe(3);
    expect(run.timeoutMs).toBe(15000);
    expect(Object.isFrozen(run.snapshot)).toBe(true);

    expect(event.eventType).toBe("run.created");
    expect(event.runId).toBe("run-001");
    expect(event.payload.taskId).toBe("task-001");
    expect(event.payload.idempotencyKey).toBe("idem-key-1");
  });

  it("executes an end-to-end lifecycle through aggregate methods", () => {
    const { run } = Run.create({
      runId: "run-002",
      taskId: "task-002",
      now,
      eventIdGenerator: mockEventIdGen,
    });

    // Queue
    const queueEvent = run.queue(now);
    expect(run.status).toBe("QUEUED");
    expect(run.version).toBe(2);
    expect(queueEvent.eventType).toBe("run.queued");

    // Claim
    const claimEvent = run.claim("worker-alpha", "lease-alpha-1", "2026-10-10T12:05:00.000Z", now);
    expect(run.status).toBe("LEASED");
    expect(run.version).toBe(3);
    expect(run.currentWorkerId).toBe("worker-alpha");
    expect(run.leaseId).toBe("lease-alpha-1");
    expect(claimEvent.eventType).toBe("worker.claimed");

    // Start
    const startEvent = run.start("worker-alpha", "lease-alpha-1", now);
    expect(run.status).toBe("RUNNING");
    expect(run.version).toBe(4);
    expect(startEvent.eventType).toBe("run.started");

    // Complete
    const completeEvent = run.complete("worker-alpha", "lease-alpha-1", { status: "success" }, now);
    expect(run.status).toBe("COMPLETED");
    expect(run.version).toBe(5);
    expect(run.resultPayload).toEqual({ status: "success" });
    expect(completeEvent.eventType).toBe("run.completed");

    // After completion, further actions are rejected
    expect(() => run.queue(now)).toThrow(TerminalStateError);
  });

  it("reconstitutes an existing run from snapshot", () => {
    const snapshot = {
      runId: "run-003",
      taskId: "task-003",
      status: "QUEUED" as const,
      version: 4,
      attemptCount: 1,
      maxAttempts: 3,
      timeoutMs: 30000,
      idempotencyKey: null,
      currentWorkerId: null,
      leaseId: null,
      leaseExpiresAt: null,
      resultPayload: null,
      errorPayload: null,
      createdAt: now,
      updatedAt: now,
    };

    const run = Run.reconstitute(snapshot, mockEventIdGen);
    expect(run.runId).toBe("run-003");
    expect(run.status).toBe("QUEUED");
    expect(run.version).toBe(4);

    // Can transition from reconstituted state
    run.claim("worker-beta", "lease-beta-1", "2026-10-10T12:05:00.000Z", now);
    expect(run.status).toBe("LEASED");
    expect(run.version).toBe(5);
  });
});
