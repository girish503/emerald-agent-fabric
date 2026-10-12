import { describe, expect, it } from "vitest";
import {
  Action,
  applyActionTransition,
} from "../../src/domain/action.js";
import {
  Attempt,
  applyAttemptTransition,
} from "../../src/domain/attempt.js";
import { computeCanonicalHash } from "../../src/domain/canonical-hash.js";
import {
  ActionAuthorizedEvent,
  ActionCancelledEvent,
  ActionCompletedEvent,
  ActionCreatedEvent,
  ActionFailedEvent,
  ActionRetryingEvent,
  ActionStartedEvent,
  ActionTimedOutEvent,
  AttemptCancelledEvent,
  AttemptCompletedEvent,
  AttemptCreatedEvent,
  AttemptDispatchedEvent,
  AttemptFailedEvent,
  AttemptStartedEvent,
  AttemptTimedOutEvent,
  AttemptUnknownEvent,
  AttemptUnknownReason,
} from "../../src/domain/events.js";
import { ContractBinding } from "../../src/domain/invariants.js";

describe("Action & Attempt Domain Events & State Machines (Task 4.4-C)", () => {
  const sampleBinding: ContractBinding = Object.freeze({
    contractId: "contract-m4-governed",
    version: 1,
    contentHash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  });

  const samplePayload = Object.freeze({
    argv: ["npm", "test"],
    env: { CI: "true" },
  });
  const canonicalHash = computeCanonicalHash(samplePayload).contentHash;

  let eventSequence = 1000;
  const mockEventIdGen = () => `evt-${++eventSequence}`;

  describe("1. Action Lifecycle Events & Payload Integrity", () => {
    it("emits action.created on Action.create() with immutable metadata and hash (not raw payload)", () => {
      const { action, event }: { action: Action; event: ActionCreatedEvent } = Action.create(
        {
          actionId: "act-create-1",
          runId: "run-001",
          sequenceNumber: 1,
          toolName: "run_command",
          inputPayload: samplePayload,
          contractBinding: sampleBinding,
          maxAttempts: 3,
          now: "2026-10-12T12:00:00.000Z",
        },
        mockEventIdGen
      );

      expect(action.actionId).toBe("act-create-1");
      expect(action.status).toBe("CREATED");

      expect(event.eventId).toBe("evt-1001");
      expect(event.runId).toBe("run-001");
      expect(event.eventType).toBe("action.created");
      expect(event.timestamp).toBe("2026-10-12T12:00:00.000Z");
      expect(event.schemaVersion).toBe(1);
      expect(event.producer).toBe("domain.action_aggregate");

      // Payload invariants
      expect(event.payload.actionId).toBe("act-create-1");
      expect(event.payload.runId).toBe("run-001");
      expect(event.payload.sequenceNumber).toBe(1);
      expect(event.payload.toolName).toBe("run_command");
      expect(event.payload.inputHash).toBe(canonicalHash);
      expect(event.payload.idempotency).toBe("NON_IDEMPOTENT");
      expect(event.payload.contractBinding).toEqual(sampleBinding);
      expect(event.payload.maxAttempts).toBe(3);

      // Raw unredacted inputPayload must NOT be included in event payload
      expect((event.payload as any).inputPayload).toBeUndefined();

      // Deep freeze check
      expect(Object.isFrozen(event)).toBe(true);
      expect(Object.isFrozen(event.payload)).toBe(true);
    });

    it("emits action.authorized on authorize()", () => {
      const { action } = Action.create(
        {
          runId: "run-001",
          sequenceNumber: 1,
          toolName: "read_file",
          inputPayload: { path: "src/domain/action.ts" },
          contractBinding: sampleBinding,
        },
        mockEventIdGen
      );

      const event: ActionAuthorizedEvent = action.authorize("2026-10-12T12:01:00.000Z");

      expect(action.status).toBe("AUTHORIZED");
      expect(event.eventType).toBe("action.authorized");
      expect(event.timestamp).toBe("2026-10-12T12:01:00.000Z");
      expect(event.producer).toBe("domain.action_aggregate");
      expect(event.payload.actionId).toBe(action.actionId);
      expect(event.payload.runId).toBe("run-001");
      expect(event.payload.sequenceNumber).toBe(1);
      expect(event.payload.toolName).toBe("read_file");
      expect(Object.isFrozen(event)).toBe(true);
    });

    it("emits action.started on startAttempt(1)", () => {
      const { action } = Action.create(
        {
          runId: "run-001",
          sequenceNumber: 1,
          toolName: "read_file",
          inputPayload: { path: "src/domain/action.ts" },
          contractBinding: sampleBinding,
        },
        mockEventIdGen
      );
      action.authorize();

      const event: ActionStartedEvent = action.startAttempt(1, "2026-10-12T12:02:00.000Z");

      expect(action.status).toBe("RUNNING");
      expect(event.eventType).toBe("action.started");
      expect(event.timestamp).toBe("2026-10-12T12:02:00.000Z");
      expect(event.payload.actionId).toBe(action.actionId);
      expect(event.payload.runId).toBe("run-001");
      expect(event.payload.attemptNumber).toBe(1);
    });

    it("emits action.completed on succeed()", () => {
      const { action } = Action.create(
        {
          runId: "run-001",
          sequenceNumber: 1,
          toolName: "read_file",
          inputPayload: { path: "src/domain/action.ts" },
          contractBinding: sampleBinding,
        },
        mockEventIdGen
      );
      action.authorize();
      action.startAttempt(1);

      const resultPayload = { lines: 45, content: "export ..." };
      const event: ActionCompletedEvent = action.succeed(resultPayload, "2026-10-12T12:03:00.000Z");

      expect(action.status).toBe("SUCCEEDED");
      expect(event.eventType).toBe("action.completed");
      expect(event.payload.actionId).toBe(action.actionId);
      expect(event.payload.runId).toBe("run-001");
      expect(event.payload.totalAttempts).toBe(1);
      expect(event.payload.resultPayload).toEqual(resultPayload);
      expect(Object.isFrozen(event)).toBe(true);
    });

    it("emits action.failed on fail() from CREATED, AUTHORIZED, and RUNNING", () => {
      // From CREATED
      const { action: actCreated } = Action.create(
        {
          runId: "run-001",
          sequenceNumber: 1,
          toolName: "read_file",
          inputPayload: { path: "src/domain/action.ts" },
          contractBinding: sampleBinding,
        },
        mockEventIdGen
      );
      const evCreatedFail: ActionFailedEvent = actCreated.fail(
        { code: "PRE_AUTH_REJECT", message: "Rejected" },
        "2026-10-12T12:04:00.000Z"
      );
      expect(actCreated.status).toBe("FAILED");
      expect(evCreatedFail.eventType).toBe("action.failed");
      expect(evCreatedFail.payload.totalAttempts).toBe(0);
      expect(evCreatedFail.payload.error).toEqual({ code: "PRE_AUTH_REJECT", message: "Rejected" });

      // From RUNNING
      const { action: actRunning } = Action.create(
        {
          runId: "run-001",
          sequenceNumber: 2,
          toolName: "read_file",
          inputPayload: { path: "src/domain/action.ts" },
          contractBinding: sampleBinding,
        },
        mockEventIdGen
      );
      actRunning.authorize();
      actRunning.startAttempt(1);
      const evRunningFail: ActionFailedEvent = actRunning.fail(
        { code: "COMMAND_EXIT_NON_ZERO", exitCode: 127 },
        "2026-10-12T12:05:00.000Z"
      );
      expect(actRunning.status).toBe("FAILED");
      expect(evRunningFail.eventType).toBe("action.failed");
      expect(evRunningFail.payload.totalAttempts).toBe(1);
      expect(evRunningFail.payload.error).toEqual({ code: "COMMAND_EXIT_NON_ZERO", exitCode: 127 });
    });

    it("emits action.timed_out on timeout()", () => {
      const { action } = Action.create(
        {
          runId: "run-001",
          sequenceNumber: 1,
          toolName: "run_command",
          inputPayload: { argv: ["sleep", "60"] },
          contractBinding: sampleBinding,
        },
        mockEventIdGen
      );
      action.authorize();
      action.startAttempt(1);

      const event: ActionTimedOutEvent = action.timeout("Hard timeout 15000ms exceeded", "2026-10-12T12:06:00.000Z");

      expect(action.status).toBe("TIMED_OUT");
      expect(event.eventType).toBe("action.timed_out");
      expect(event.payload.totalAttempts).toBe(1);
      expect(event.payload.reason).toBe("Hard timeout 15000ms exceeded");
    });

    it("emits action.cancelled on cancel()", () => {
      const { action } = Action.create(
        {
          runId: "run-001",
          sequenceNumber: 1,
          toolName: "run_command",
          inputPayload: { argv: ["echo", "hi"] },
          contractBinding: sampleBinding,
        },
        mockEventIdGen
      );
      action.authorize();

      const event: ActionCancelledEvent = action.cancel("Operator aborted run", "2026-10-12T12:07:00.000Z");

      expect(action.status).toBe("CANCELLED");
      expect(event.eventType).toBe("action.cancelled");
      expect(event.payload.reason).toBe("Operator aborted run");
    });

    it("emits action.retrying on prepareRetry() with attempt numbers and ceiling", () => {
      const { action } = Action.create(
        {
          runId: "run-001",
          sequenceNumber: 1,
          toolName: "read_file",
          inputPayload: { path: "src/domain/action.ts" },
          contractBinding: sampleBinding,
          maxAttempts: 3,
        },
        mockEventIdGen
      );
      action.authorize();
      action.startAttempt(1);

      const event: ActionRetryingEvent = action.prepareRetry(
        { reason: "Transient disk busy" },
        "2026-10-12T12:08:00.000Z"
      );

      expect(action.status).toBe("RETRYING");
      expect(event.eventType).toBe("action.retrying");
      expect(event.payload.attemptNumber).toBe(1);
      expect(event.payload.nextAttemptNumber).toBe(2);
      expect(event.payload.maxAttempts).toBe(3);
      expect(event.payload.error).toEqual({ reason: "Transient disk busy" });
    });
  });

  describe("2. Attempt Lifecycle Events & Metadata Binding", () => {
    it("emits attempt.created on Attempt.create() with idempotency token and lease context", () => {
      const { attempt, event }: { attempt: Attempt; event: AttemptCreatedEvent } = Attempt.create(
        {
          attemptId: "att-001",
          actionId: "act-001",
          runId: "run-001",
          attemptNumber: 1,
          workerId: "worker-us-east-1",
          leaseId: "lease-101",
          now: "2026-10-12T12:10:00.000Z",
        },
        mockEventIdGen
      );

      expect(attempt.status).toBe("CREATED");
      expect(attempt.idempotencyToken).toBe("run-001:act-001:1");

      expect(event.eventType).toBe("attempt.created");
      expect(event.runId).toBe("run-001");
      expect(event.producer).toBe("domain.attempt_aggregate");
      expect(event.schemaVersion).toBe(1);
      expect(event.payload.attemptId).toBe("att-001");
      expect(event.payload.actionId).toBe("act-001");
      expect(event.payload.runId).toBe("run-001");
      expect(event.payload.attemptNumber).toBe(1);
      expect(event.payload.workerId).toBe("worker-us-east-1");
      expect(event.payload.leaseId).toBe("lease-101");
      expect(event.payload.idempotencyToken).toBe("run-001:act-001:1");

      expect(Object.isFrozen(event)).toBe(true);
      expect(Object.isFrozen(event.payload)).toBe(true);
    });

    it("emits attempt.dispatched on dispatch()", () => {
      const { attempt } = Attempt.create(
        {
          actionId: "act-001",
          runId: "run-001",
          attemptNumber: 1,
          workerId: "w1",
          leaseId: "l1",
        },
        mockEventIdGen
      );

      const event: AttemptDispatchedEvent = attempt.dispatch("2026-10-12T12:11:00.000Z");

      expect(attempt.status).toBe("DISPATCHED");
      expect(event.eventType).toBe("attempt.dispatched");
      expect(event.timestamp).toBe("2026-10-12T12:11:00.000Z");
      expect(event.payload.attemptId).toBe(attempt.attemptId);
      expect(event.payload.workerId).toBe("w1");
      expect(event.payload.leaseId).toBe("l1");
    });

    it("emits attempt.started on start()", () => {
      const { attempt } = Attempt.create(
        {
          actionId: "act-001",
          runId: "run-001",
          attemptNumber: 1,
          workerId: "w1",
          leaseId: "l1",
        },
        mockEventIdGen
      );
      attempt.dispatch();

      const event: AttemptStartedEvent = attempt.start("2026-10-12T12:12:00.000Z");

      expect(attempt.status).toBe("RUNNING");
      expect(event.eventType).toBe("attempt.started");
      expect(event.payload.attemptId).toBe(attempt.attemptId);
      expect(event.payload.attemptNumber).toBe(1);
    });

    it("emits attempt.completed on complete() with exitCode, durationMs, and evidenceIds", () => {
      const { attempt } = Attempt.create(
        {
          actionId: "act-001",
          runId: "run-001",
          attemptNumber: 1,
          workerId: "w1",
          leaseId: "l1",
        },
        mockEventIdGen
      );
      attempt.dispatch();
      attempt.start();

      const event: AttemptCompletedEvent = attempt.complete({
        outputPayload: { stdout: "PASS" },
        exitCode: 0,
        durationMs: 320,
        evidenceIds: ["evi-stdout-1", "evi-exit-1"],
        now: "2026-10-12T12:13:00.000Z",
      });

      expect(attempt.status).toBe("SUCCEEDED");
      expect(event.eventType).toBe("attempt.completed");
      expect(event.payload.exitCode).toBe(0);
      expect(event.payload.durationMs).toBe(320);
      expect(event.payload.evidenceIds).toEqual(["evi-stdout-1", "evi-exit-1"]);
      expect(Object.isFrozen(event)).toBe(true);
    });

    it("emits attempt.failed on fail()", () => {
      const { attempt } = Attempt.create(
        {
          actionId: "act-001",
          runId: "run-001",
          attemptNumber: 1,
          workerId: "w1",
          leaseId: "l1",
        },
        mockEventIdGen
      );
      attempt.dispatch();
      attempt.start();

      const event: AttemptFailedEvent = attempt.fail({
        errorPayload: { stderr: "Command not found", exitCode: 127 },
        exitCode: 127,
        durationMs: 15,
        evidenceIds: ["evi-stderr-1"],
        now: "2026-10-12T12:14:00.000Z",
      });

      expect(attempt.status).toBe("FAILED");
      expect(event.eventType).toBe("attempt.failed");
      expect(event.payload.exitCode).toBe(127);
      expect(event.payload.durationMs).toBe(15);
      expect(event.payload.error).toEqual({ stderr: "Command not found", exitCode: 127 });
    });

    it("emits attempt.timed_out on timeout()", () => {
      const { attempt } = Attempt.create(
        {
          actionId: "act-001",
          runId: "run-001",
          attemptNumber: 1,
          workerId: "w1",
          leaseId: "l1",
        },
        mockEventIdGen
      );
      attempt.dispatch();
      attempt.start();

      const event: AttemptTimedOutEvent = attempt.timeout({
        errorPayload: "Container execution killed after 5000ms",
        durationMs: 5005,
        now: "2026-10-12T12:15:00.000Z",
      });

      expect(attempt.status).toBe("TIMED_OUT");
      expect(event.eventType).toBe("attempt.timed_out");
      expect(event.payload.durationMs).toBe(5005);
      expect(event.payload.reason).toBe("Container execution killed after 5000ms");
    });

    it("emits attempt.cancelled on cancel()", () => {
      const { attempt } = Attempt.create(
        {
          actionId: "act-001",
          runId: "run-001",
          attemptNumber: 1,
          workerId: "w1",
          leaseId: "l1",
        },
        mockEventIdGen
      );
      attempt.dispatch();

      const event: AttemptCancelledEvent = attempt.cancel({
        reason: "Worker preemption signal received",
        now: "2026-10-12T12:16:00.000Z",
      });

      expect(attempt.status).toBe("CANCELLED");
      expect(event.eventType).toBe("attempt.cancelled");
      expect(event.payload.reason).toBe("Worker preemption signal received");
    });
  });

  describe("3. UNKNOWN State & Crash Semantics (attempt.unknown)", () => {
    it("emits attempt.unknown with typed reasonCode and details", () => {
      const { attempt } = Attempt.create(
        {
          actionId: "act-crash-1",
          runId: "run-001",
          attemptNumber: 1,
          workerId: "worker-node-crash",
          leaseId: "lease-crash-1",
        },
        mockEventIdGen
      );
      attempt.dispatch();
      attempt.start();

      const event: AttemptUnknownEvent = attempt.markUnknown({
        reason: "Node power loss during Docker run",
        reasonCode: "WORKER_CRASHED",
        now: "2026-10-12T12:20:00.000Z",
      });

      expect(attempt.status).toBe("UNKNOWN");
      expect(event.eventType).toBe("attempt.unknown");
      expect(event.payload.reasonCode).toBe("WORKER_CRASHED");
      expect(event.payload.details).toBe("Node power loss during Docker run");
      expect(event.payload.attemptNumber).toBe(1);
      expect((event.payload as any).workerId).toBeUndefined(); // Worker context is on attemptId, payload conforms to AttemptUnknownPayload
    });

    it("verifies all closed enum values for AttemptUnknownReason", () => {
      const reasons: AttemptUnknownReason[] = [
        "LEASE_EXPIRED_DURING_EXECUTION",
        "WORKER_CRASHED",
        "PROCESS_TERMINATION_BEFORE_PERSISTENCE",
        "PROVIDER_RESULT_UNAVAILABLE",
        "UNSPECIFIED_EXECUTION_UNCERTAINTY",
      ];

      for (const reasonCode of reasons) {
        const { attempt } = Attempt.create(
          {
            actionId: "act-enum",
            runId: "run-enum",
            attemptNumber: 1,
            workerId: "w1",
            leaseId: "l1",
          },
          mockEventIdGen
        );
        attempt.dispatch();

        const event = attempt.markUnknown({
          reason: `Reason: ${reasonCode}`,
          reasonCode,
        });

        expect(event.payload.reasonCode).toBe(reasonCode);
        expect(attempt.errorPayload).toEqual({
          code: "EXECUTION_UNCERTAIN",
          reasonCode,
          reason: `Reason: ${reasonCode}`,
        });
      }
    });

    it("falls back gracefully to UNSPECIFIED_EXECUTION_UNCERTAINTY if arbitrary reason provided", () => {
      const { attempt } = Attempt.create(
        {
          actionId: "act-fallback",
          runId: "run-fallback",
          attemptNumber: 1,
          workerId: "w1",
          leaseId: "l1",
        },
        mockEventIdGen
      );
      attempt.dispatch();

      const event = attempt.markUnknown({
        reason: "Arbitrary unmapped diagnostic message",
      });

      expect(event.payload.reasonCode).toBe("UNSPECIFIED_EXECUTION_UNCERTAINTY");
      expect(event.payload.details).toBe("Arbitrary unmapped diagnostic message");
    });
  });

  describe("4. End-to-End Multi-Attempt Causal Sequence Simulation", () => {
    it("traces an end-to-end retry execution with full causal event ordering", () => {
      const emittedEvents: any[] = [];

      // Step 1: Agent decides intention -> Action Created
      const { action, event: evActionCreated } = Action.create(
        {
          actionId: "act-e2e-1",
          runId: "run-e2e",
          sequenceNumber: 1,
          toolName: "read_file",
          inputPayload: { path: "package.json" },
          contractBinding: sampleBinding,
          maxAttempts: 2,
          now: "2026-10-12T13:00:00.000Z",
        },
        mockEventIdGen
      );
      emittedEvents.push(evActionCreated);

      // Step 2: Gateway verifies policies and contract ceilings -> Action Authorized
      const evActionAuth = action.authorize("2026-10-12T13:00:01.000Z");
      emittedEvents.push(evActionAuth);

      // Step 3: Runtime prepares Attempt 1 under lease l1 -> Attempt Created
      const { attempt: att1, event: evAtt1Created } = Attempt.create(
        {
          attemptId: "att-e2e-1",
          actionId: action.actionId,
          runId: action.runId,
          attemptNumber: 1,
          workerId: "worker-A",
          leaseId: "lease-l1",
          now: "2026-10-12T13:00:02.000Z",
        },
        mockEventIdGen
      );
      emittedEvents.push(evAtt1Created);

      // Step 4: Action marks Attempt 1 started
      const evActionStart1 = action.startAttempt(1, "2026-10-12T13:00:03.000Z");
      emittedEvents.push(evActionStart1);

      // Step 5: Attempt 1 dispatched to provider
      const evAtt1Disp = att1.dispatch("2026-10-12T13:00:04.000Z");
      emittedEvents.push(evAtt1Disp);

      // Step 6: Attempt 1 starts execution
      const evAtt1Start = att1.start("2026-10-12T13:00:05.000Z");
      emittedEvents.push(evAtt1Start);

      // Step 7: Attempt 1 fails (transient lock conflict)
      const evAtt1Fail = att1.fail({
        errorPayload: { error: "EBUSY: resource busy or locked" },
        durationMs: 50,
        now: "2026-10-12T13:00:06.000Z",
      });
      emittedEvents.push(evAtt1Fail);

      // Step 8: Action transitions to RETRYING
      const evActionRetry = action.prepareRetry(
        { reason: "Retry eligible lock failure" },
        "2026-10-12T13:00:07.000Z"
      );
      emittedEvents.push(evActionRetry);

      // Step 9: Runtime prepares Attempt 2
      const { attempt: att2, event: evAtt2Created } = Attempt.create(
        {
          attemptId: "att-e2e-2",
          actionId: action.actionId,
          runId: action.runId,
          attemptNumber: 2,
          workerId: "worker-A",
          leaseId: "lease-l1",
          now: "2026-10-12T13:00:08.000Z",
        },
        mockEventIdGen
      );
      emittedEvents.push(evAtt2Created);

      // Step 10: Action marks Attempt 2 started
      const evActionStart2 = action.startAttempt(2, "2026-10-12T13:00:09.000Z");
      emittedEvents.push(evActionStart2);

      // Step 11: Attempt 2 dispatched and started
      const evAtt2Disp = att2.dispatch("2026-10-12T13:00:10.000Z");
      emittedEvents.push(evAtt2Disp);

      const evAtt2Start = att2.start("2026-10-12T13:00:11.000Z");
      emittedEvents.push(evAtt2Start);

      // Step 12: Attempt 2 succeeds
      const evAtt2Comp = att2.complete({
        outputPayload: { content: '{"name": "emerald-agent-fabric"}' },
        exitCode: 0,
        durationMs: 40,
        evidenceIds: ["evi-pkg-read"],
        now: "2026-10-12T13:00:12.000Z",
      });
      emittedEvents.push(evAtt2Comp);

      // Step 13: Action completes successfully
      const evActionComp = action.succeed(
        { content: '{"name": "emerald-agent-fabric"}' },
        "2026-10-12T13:00:13.000Z"
      );
      emittedEvents.push(evActionComp);

      // Verify complete ordered sequence of 14 events
      expect(emittedEvents.length).toBe(14);
      expect(emittedEvents.map((e) => e.eventType)).toEqual([
        "action.created",
        "action.authorized",
        "attempt.created",
        "action.started",
        "attempt.dispatched",
        "attempt.started",
        "attempt.failed",
        "action.retrying",
        "attempt.created",
        "action.started",
        "attempt.dispatched",
        "attempt.started",
        "attempt.completed",
        "action.completed",
      ]);

      // Verify idempotency tokens are distinct across attempts
      expect(evAtt1Created.payload.idempotencyToken).toBe("run-e2e:act-e2e-1:1");
      expect(evAtt2Created.payload.idempotencyToken).toBe("run-e2e:act-e2e-1:2");
      expect(evAtt1Created.payload.idempotencyToken).not.toBe(evAtt2Created.payload.idempotencyToken);

      // Verify actionId remains constant across the entire sequence
      for (const e of emittedEvents) {
        expect(e.payload.actionId).toBe("act-e2e-1");
        expect(e.runId).toBe("run-e2e");
      }

      // Verify terminal aggregate state
      expect(action.status).toBe("SUCCEEDED");
      expect(action.totalAttempts).toBe(2);
      expect(att1.status).toBe("FAILED");
      expect(att2.status).toBe("SUCCEEDED");
    });
  });

  describe("5. Pure Transition Engine Functionality (applyActionTransition & applyAttemptTransition)", () => {
    it("applyActionTransition directly returns deterministic snapshot and event", () => {
      const { action } = Action.create({
        runId: "run-direct",
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: { path: "test" },
        contractBinding: sampleBinding,
      });

      const { nextSnapshot, event } = applyActionTransition(
        action.snapshot,
        {
          type: "AUTHORIZE",
          now: "2026-10-12T14:00:00.000Z",
        },
        () => "evt-direct-auth"
      );

      expect(nextSnapshot.status).toBe("AUTHORIZED");
      expect(event.eventId).toBe("evt-direct-auth");
      expect(event.eventType).toBe("action.authorized");
      expect((event as ActionAuthorizedEvent).payload.toolName).toBe("read_file");
      // Original remains pristine
      expect(action.snapshot.status).toBe("CREATED");
    });

    it("applyAttemptTransition directly returns deterministic snapshot and event", () => {
      const { attempt } = Attempt.create({
        actionId: "act-direct",
        runId: "run-direct",
        attemptNumber: 1,
        workerId: "w1",
        leaseId: "l1",
      });

      const { nextSnapshot, event } = applyAttemptTransition(
        attempt.snapshot,
        {
          type: "DISPATCH",
          now: "2026-10-12T14:05:00.000Z",
        },
        () => "evt-direct-disp"
      );

      expect(nextSnapshot.status).toBe("DISPATCHED");
      expect(event.eventId).toBe("evt-direct-disp");
      expect(event.eventType).toBe("attempt.dispatched");
      expect((event as AttemptDispatchedEvent).payload.workerId).toBe("w1");
      // Original remains pristine
      expect(attempt.snapshot.status).toBe("CREATED");
    });
  });
});
