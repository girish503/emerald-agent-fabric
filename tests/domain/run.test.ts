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

  describe("Governed Run Creation & Contract Binding", () => {
    const validBinding = {
      contractId: "contract-gov-01",
      version: 2,
      contentHash: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    };

    it("creates a governed run with exact contract binding and operational output limit", () => {
      const { run, event } = Run.create({
        runId: "run-gov-001",
        taskId: "task-gov-001",
        contractBinding: validBinding,
        maxOutputBytes: 1048576,
        now,
        eventIdGenerator: mockEventIdGen,
      });

      expect(run.runId).toBe("run-gov-001");
      expect(run.status).toBe("CREATED");
      expect(run.contractBinding).toEqual(validBinding);
      expect(run.maxOutputBytes).toBe(1048576);

      // Event contains exact binding and output limit
      expect(event.eventType).toBe("run.created");
      expect(event.payload.contractBinding).toEqual(validBinding);
      expect(event.payload.maxOutputBytes).toBe(1048576);
    });

    it("accepts maxOutputBytes = 1 for a governed run", () => {
      const { run, event } = Run.create({
        runId: "run-gov-min-output",
        taskId: "task-gov-min-output",
        contractBinding: validBinding,
        maxOutputBytes: 1,
        now,
        eventIdGenerator: mockEventIdGen,
      });

      expect(run.maxOutputBytes).toBe(1);
      expect(event.payload.maxOutputBytes).toBe(1);
    });

    it("preserves contract binding and output limit across aggregate transitions", () => {
      const { run } = Run.create({
        runId: "run-gov-lifecycle",
        taskId: "task-gov-lifecycle",
        contractBinding: validBinding,
        maxOutputBytes: 65536,
        now,
        eventIdGenerator: mockEventIdGen,
      });

      run.queue(now);
      expect(run.contractBinding).toEqual(validBinding);
      expect(run.maxOutputBytes).toBe(65536);

      run.claim("worker-gamma", "lease-gamma-1", "2026-10-10T12:05:00.000Z", now);
      expect(run.contractBinding).toEqual(validBinding);
      expect(run.maxOutputBytes).toBe(65536);

      run.start("worker-gamma", "lease-gamma-1", now);
      expect(run.contractBinding).toEqual(validBinding);
      expect(run.maxOutputBytes).toBe(65536);

      run.complete("worker-gamma", "lease-gamma-1", { data: "ok" }, now);
      expect(run.contractBinding).toEqual(validBinding);
      expect(run.maxOutputBytes).toBe(65536);
    });

    it("reconstitutes a legacy run snapshot where contractBinding and maxOutputBytes are null", () => {
      const legacySnapshot = {
        runId: "run-legacy-001",
        taskId: "task-legacy-001",
        status: "QUEUED" as const,
        version: 2,
        attemptCount: 0,
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
        contractBinding: null,
        maxOutputBytes: null,
      };

      const run = Run.reconstitute(legacySnapshot, mockEventIdGen);
      expect(run.contractBinding).toBeNull();
      expect(run.maxOutputBytes).toBeNull();
      expect(run.snapshot.contractBinding).toBeNull();
      expect(run.snapshot.maxOutputBytes).toBeNull();
    });

    it("reconstitutes a governed run snapshot with exact contractBinding and maxOutputBytes", () => {
      const governedSnapshot = {
        runId: "run-gov-reconst-001",
        taskId: "task-gov-reconst-001",
        status: "RUNNING" as const,
        version: 3,
        attemptCount: 0,
        maxAttempts: 3,
        timeoutMs: 30000,
        idempotencyKey: null,
        currentWorkerId: "w1",
        leaseId: "l1",
        leaseExpiresAt: "2026-10-10T12:05:00.000Z",
        resultPayload: null,
        errorPayload: null,
        createdAt: now,
        updatedAt: now,
        contractBinding: validBinding,
        maxOutputBytes: 2048,
      };

      const run = Run.reconstitute(governedSnapshot, mockEventIdGen);
      expect(run.contractBinding).toEqual(validBinding);
      expect(run.maxOutputBytes).toBe(2048);
    });

    it("enforces deep immutability on run snapshot and contract binding", () => {
      const { run } = Run.create({
        runId: "run-gov-immut",
        taskId: "task-gov-immut",
        contractBinding: validBinding,
        maxOutputBytes: 4096,
        now,
        eventIdGenerator: mockEventIdGen,
      });

      expect(Object.isFrozen(run.snapshot)).toBe(true);
      expect(Object.isFrozen(run.snapshot.contractBinding)).toBe(true);

      expect(() => {
        // @ts-expect-error mutating frozen object
        run.snapshot.version = 999;
      }).toThrow();

      expect(() => {
        // @ts-expect-error mutating frozen object
        run.snapshot.contractBinding!.contractId = "tampered";
      }).toThrow();
    });
  });
});
