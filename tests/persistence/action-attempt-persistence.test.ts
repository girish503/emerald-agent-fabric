import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SqliteStateStore, MAX_PERSISTED_PAYLOAD_BYTES } from "../../src/adapters/persistence/sqlite-state-store.js";
import { migrateDatabase } from "../../src/adapters/persistence/schema.js";
import { createSqliteClient } from "../../src/adapters/persistence/sqlite-client.js";
import { Run } from "../../src/domain/run.js";
import { Action } from "../../src/domain/action.js";
import { Attempt, createAttemptIdempotencyToken } from "../../src/domain/attempt.js";
import {
  ActionNotFoundError,
  ActiveAttemptConflictError,
  AttemptNotFoundError,
  InvalidActionError,
  InvalidActionTransitionError,
  InvalidAttemptError,
  InvalidAttemptTransitionError,
  InvalidContractBindingError,
  LeaseLostError,
  PayloadLimitExceededError,
  TerminalStateError,
} from "../../src/domain/errors.js";
import { createContractBinding } from "../../src/domain/invariants.js";
import {
  createMissionContract,
  createDefaultInProcessPolicy,
  createResourceLimits,
  createVerificationSpec,
  MissionContract,
} from "../../src/domain/index.js";

describe("Phase 4 / Task 4.4-D — Action & Attempt SQLite Persistence, Event Atomicity & Lease Fencing", () => {
  let tempDir: string;
  let dbPath: string;
  let store: SqliteStateStore;
  let boundContract: MissionContract;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-44d-persistence-"));
    dbPath = path.join(tempDir, "test.db");
    store = new SqliteStateStore({ location: dbPath });

    // Seed task, contract, workers, run
    store.transaction((tx) => {
      tx.insertTask({
        taskId: "task-44d-1",
        title: "Task for Action/Attempt Persistence",
        description: "Testing durable operational state and lease fencing",
        inputPayload: { query: "test" },
        createdAt: "2026-10-12T12:00:00.000Z",
        updatedAt: "2026-10-12T12:00:00.000Z",
      });

      boundContract = createMissionContract({
        contractId: "contract-44d-1",
        version: 1,
        taskId: "task-44d-1",
        policy: createDefaultInProcessPolicy("policy-44d-1"),
        verificationSpecs: [
          createVerificationSpec({
            specId: "vspec-44d-1",
            ruleKind: "EXACT_OUTPUT_MATCH",
            expectedValue: { status: "success" },
          }),
        ],
        resourceLimits: createResourceLimits({
          timeoutMs: 30000,
          maxAttempts: 3,
          maxOutputBytes: 65536,
        }),
        credentialScopes: ["workspace:read", "workspace:write"],
      });
      tx.insertContract(boundContract);
      tx.activateContract(boundContract.spec.contractId, boundContract.spec.version, "2026-10-12T12:00:01.000Z");

      tx.insertWorker({
        workerId: "worker-A",
        hostname: "node-1",
        pid: 1001,
        status: "ACTIVE",
        lastHeartbeatAt: "2026-10-12T12:00:00.000Z",
        createdAt: "2026-10-12T12:00:00.000Z",
      });

      tx.insertWorker({
        workerId: "worker-B",
        hostname: "node-2",
        pid: 1002,
        status: "ACTIVE",
        lastHeartbeatAt: "2026-10-12T12:00:00.000Z",
        createdAt: "2026-10-12T12:00:00.000Z",
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

  function setupGovernedRun(runId: string = "run-44d-1", workerId: string = "worker-A", leaseId: string = "lease-1") {
    const binding = createContractBinding({
      contractId: boundContract.spec.contractId,
      version: boundContract.spec.version,
      contentHash: boundContract.contentHash,
    });

    const { run, event: runCreatedEvent } = Run.create({
      runId,
      taskId: "task-44d-1",
      contractBinding: binding,
      maxOutputBytes: 65536,
    });

    store.transaction((tx) => {
      tx.insertRun(run.snapshot, runCreatedEvent);
      const qEvent = run.queue();
      tx.updateRun(runId, 1, run.snapshot, qEvent);
      const claimEvent = run.claim(workerId, leaseId, "2026-10-12T12:30:00.000Z");
      tx.updateRun(runId, 2, run.snapshot, claimEvent);
      tx.insertLease({
        leaseId,
        runId,
        workerId,
        acquiredAt: "2026-10-12T12:00:00.000Z",
        expiresAt: "2026-10-12T12:30:00.000Z",
        releasedAt: null,
        state: "ACTIVE",
      });
      const startEvent = run.start(workerId, leaseId);
      tx.updateRun(runId, 3, run.snapshot, startEvent, { workerId, leaseId });
    });

    return { runId, binding, workerId, leaseId };
  }

  // =========================================================================
  // 1. ACTION PERSISTENCE LIFECYCLE
  // =========================================================================
  describe("1. Action Persistence Lifecycle", () => {
    it("persists Action and appends action.created event atomically", () => {
      const { runId, binding, workerId, leaseId } = setupGovernedRun();

      const { action, event: actionCreatedEvent } = Action.create({
        actionId: "act-1",
        runId,
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: { path: "src/index.ts" },
        contractBinding: binding,
        maxAttempts: 3,
        now: "2026-10-12T12:01:00.000Z",
      });

      const persistedEvent = store.transaction((tx) => {
        return tx.insertAction(action.snapshot, actionCreatedEvent, { workerId, leaseId });
      });

      expect(persistedEvent.eventType).toBe("action.created");
      expect(persistedEvent.sequence).toBeGreaterThan(0);

      // Verify state retrieval
      const fetched = store.getAction("act-1");
      expect(fetched).not.toBeNull();
      expect(fetched?.actionId).toBe("act-1");
      expect(fetched?.status).toBe("CREATED");
      expect(fetched?.toolName).toBe("read_file");
      expect(fetched?.inputPayload).toEqual({ path: "src/index.ts" });
      expect(fetched?.contractBinding.contractId).toBe("contract-44d-1");

      // Verify event log
      const events = store.getEventsForRun(runId);
      const actionEvents = events.filter((e) => e.eventType.startsWith("action."));
      expect(actionEvents.length).toBe(1);
      expect(actionEvents[0]?.eventType).toBe("action.created");
      expect(actionEvents[0]?.payload).toEqual(
        expect.objectContaining({
          actionId: "act-1",
          toolName: "read_file",
          inputHash: action.inputHash,
        })
      );
    });

    it("retrieves Actions for run ordered by sequence number", () => {
      const { runId, binding, workerId, leaseId } = setupGovernedRun();

      const { action: act1, event: ev1 } = Action.create({
        actionId: "act-seq-1",
        runId,
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: { path: "a.ts" },
        contractBinding: binding,
        maxAttempts: 3,
      });

      const { action: act2, event: ev2 } = Action.create({
        actionId: "act-seq-2",
        runId,
        sequenceNumber: 2,
        toolName: "git_status",
        inputPayload: {},
        contractBinding: binding,
        maxAttempts: 3,
      });

      store.transaction((tx) => {
        tx.insertAction(act1.snapshot, ev1, { workerId, leaseId });
        tx.insertAction(act2.snapshot, ev2, { workerId, leaseId });
      });

      const actions = store.getActionsForRun(runId);
      expect(actions.length).toBe(2);
      expect(actions[0]?.sequenceNumber).toBe(1);
      expect(actions[0]?.actionId).toBe("act-seq-1");
      expect(actions[1]?.sequenceNumber).toBe(2);
      expect(actions[1]?.actionId).toBe("act-seq-2");

      const actBySeq = store.getActionBySequence(runId, 2);
      expect(actBySeq?.actionId).toBe("act-seq-2");
    });

    it("enforces sequence gaplessness on Action insertion", () => {
      const { runId, binding, workerId, leaseId } = setupGovernedRun();

      // Attempt to insert sequence 2 when sequence 1 does not exist
      const { action, event } = Action.create({
        actionId: "act-gap-2",
        runId,
        sequenceNumber: 2,
        toolName: "read_file",
        inputPayload: { path: "a.ts" },
        contractBinding: binding,
        maxAttempts: 3,
      });

      expect(() => {
        store.transaction((tx) => {
          tx.insertAction(action.snapshot, event, { workerId, leaseId });
        });
      }).toThrow(InvalidActionError);
    });

    it("enforces sequence ordering and rejects duplicate sequence number", () => {
      const { runId, binding, workerId, leaseId } = setupGovernedRun();

      const { action: act1, event: ev1 } = Action.create({
        actionId: "act-dup-1",
        runId,
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: { path: "a.ts" },
        contractBinding: binding,
        maxAttempts: 3,
      });

      store.transaction((tx) => {
        tx.insertAction(act1.snapshot, ev1, { workerId, leaseId });
      });

      const { action: actDuplicate, event: evDup } = Action.create({
        actionId: "act-dup-2",
        runId,
        sequenceNumber: 1, // Duplicate sequence
        toolName: "git_status",
        inputPayload: {},
        contractBinding: binding,
        maxAttempts: 3,
      });

      expect(() => {
        store.transaction((tx) => {
          tx.insertAction(actDuplicate.snapshot, evDup, { workerId, leaseId });
        });
      }).toThrow(InvalidActionError);
    });

    it("rejects Action insertion when contract binding does not match parent Run", () => {
      const { runId, workerId, leaseId } = setupGovernedRun();

      const mismatchedBinding = createContractBinding({
        contractId: "different-contract",
        version: 1,
        contentHash: "a".repeat(64),
      });

      const { action, event } = Action.create({
        actionId: "act-mismatch-1",
        runId,
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: { path: "a.ts" },
        contractBinding: mismatchedBinding,
        maxAttempts: 3,
      });

      expect(() => {
        store.transaction((tx) => {
          tx.insertAction(action.snapshot, event, { workerId, leaseId });
        });
      }).toThrow(InvalidContractBindingError);
    });

    it("rejects Action insertion for non-existent Run", () => {
      const binding = createContractBinding({
        contractId: boundContract.spec.contractId,
        version: boundContract.spec.version,
        contentHash: boundContract.contentHash,
      });

      const { action, event } = Action.create({
        actionId: "act-norun-1",
        runId: "run-does-not-exist",
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: { path: "a.ts" },
        contractBinding: binding,
        maxAttempts: 3,
      });

      expect(() => {
        store.transaction((tx) => {
          tx.insertAction(action.snapshot, event);
        });
      }).toThrow("Run 'run-does-not-exist' not found");
    });

    it("throws ActionNotFoundError when transitioning non-existent action", () => {
      expect(() => {
        store.transaction((tx) => {
          tx.transitionAction("act-does-not-exist", { type: "AUTHORIZE", now: "2026-10-12T12:00:00Z" }, () => "e1");
        });
      }).toThrow(ActionNotFoundError);
    });

    it("transitions Action through complete lifecycle and enforces terminal immutability", () => {
      const { runId, binding, workerId, leaseId } = setupGovernedRun();

      const { action, event: evCreated } = Action.create({
        actionId: "act-life-1",
        runId,
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: { path: "file.txt" },
        contractBinding: binding,
        maxAttempts: 3,
      });

      store.transaction((tx) => {
        tx.insertAction(action.snapshot, evCreated, { workerId, leaseId });
      });

      // 1. Authorize via transitionAction
      store.transaction((tx) => {
        tx.transitionAction(
          "act-life-1",
          { type: "AUTHORIZE", now: "2026-10-12T12:02:00.000Z" },
          () => "evt-auth-1",
          { workerId, leaseId }
        );
      });
      expect(store.getAction("act-life-1")?.status).toBe("AUTHORIZED");

      // 2. Start attempt
      store.transaction((tx) => {
        tx.transitionAction(
          "act-life-1",
          { type: "START_ATTEMPT", attemptNumber: 1, now: "2026-10-12T12:03:00.000Z" },
          () => "evt-start-1",
          { workerId, leaseId }
        );
      });
      expect(store.getAction("act-life-1")?.status).toBe("RUNNING");
      expect(store.getAction("act-life-1")?.activeAttemptNumber).toBe(1);

      // 3. Succeed terminal transition
      store.transaction((tx) => {
        tx.transitionAction(
          "act-life-1",
          {
            type: "SUCCEED",
            resultPayload: { content: "hello world" },
            now: "2026-10-12T12:04:00.000Z",
          },
          () => "evt-succ-1",
          { workerId, leaseId }
        );
      });
      const terminalAction = store.getAction("act-life-1");
      expect(terminalAction?.status).toBe("SUCCEEDED");
      expect(terminalAction?.resultPayload).toEqual({ content: "hello world" });

      // 4. Terminal Immutability: transitionAction on terminal status throws InvalidActionTransitionError
      expect(() => {
        store.transaction((tx) => {
          tx.transitionAction(
            "act-life-1",
            {
              type: "FAIL",
              errorPayload: { error: "cannot fail after success" },
              now: "2026-10-12T12:05:00.000Z",
            },
            () => "evt-fail-2",
            { workerId, leaseId }
          );
        });
      }).toThrow(InvalidActionTransitionError);

      // 5. Terminal Immutability: direct updateAction on terminal status throws TerminalStateError
      expect(() => {
        store.transaction((tx) => {
          tx.updateAction(
            "act-life-1",
            {
              ...terminalAction!,
              status: "FAILED",
              errorPayload: { code: "ERROR", message: "Cannot mutate" },
            },
            {
              eventId: "evt-illegal-mut",
              runId,
              timestamp: "2026-10-12T12:06:00.000Z",
              eventType: "action.failed",
              schemaVersion: 1,
              producer: "test",
              payload: {},
            } as any,
            { workerId, leaseId }
          );
        });
      }).toThrow(TerminalStateError);
    });

    it("enforces Immutability of Intent on Action update", () => {
      const { runId, binding, workerId, leaseId } = setupGovernedRun();

      const { action, event } = Action.create({
        actionId: "act-intent-1",
        runId,
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: { path: "a.ts" },
        contractBinding: binding,
        maxAttempts: 3,
      });

      store.transaction((tx) => {
        tx.insertAction(action.snapshot, event, { workerId, leaseId });
      });

      // Tamper with toolName
      const tamperedSnapshot = {
        ...action.snapshot,
        toolName: "git_diff" as any,
        status: "AUTHORIZED" as const,
      };

      expect(() => {
        store.transaction((tx) => {
          tx.updateAction("act-intent-1", tamperedSnapshot, {
            eventId: "tamper-evt",
            runId,
            timestamp: new Date().toISOString(),
            eventType: "action.authorized",
            schemaVersion: 1,
            producer: "domain.action",
            payload: { actionId: "act-intent-1", toolName: "git_diff" },
          } as any);
        });
      }).toThrow();
    });
  });

  // =========================================================================
  // 2. ATTEMPT PERSISTENCE LIFECYCLE
  // =========================================================================
  describe("2. Attempt Persistence Lifecycle", () => {
    function setupAuthorizedAction(runId: string, binding: any, workerId: string, leaseId: string) {
      const { action, event: evCreated } = Action.create({
        actionId: "act-for-att-1",
        runId,
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: { path: "file.txt" },
        contractBinding: binding,
        maxAttempts: 3,
      });

      store.transaction((tx) => {
        tx.insertAction(action.snapshot, evCreated, { workerId, leaseId });
        tx.transitionAction(
          "act-for-att-1",
          { type: "AUTHORIZE", now: "2026-10-12T12:01:00.000Z" },
          () => "evt-auth-1",
          { workerId, leaseId }
        );
      });
      return action;
    }

    it("persists Attempt and appends attempt.created event atomically", () => {
      const { runId, binding, workerId, leaseId } = setupGovernedRun();
      setupAuthorizedAction(runId, binding, workerId, leaseId);

      const { attempt, event: attCreatedEvent } = Attempt.create({
        attemptId: "att-1",
        actionId: "act-for-att-1",
        runId,
        attemptNumber: 1,
        workerId,
        leaseId,
        now: "2026-10-12T12:02:00.000Z",
      });

      const persistedEvent = store.transaction((tx) => {
        return tx.insertAttempt(attempt.snapshot, attCreatedEvent, { workerId, leaseId });
      });

      expect(persistedEvent.eventType).toBe("attempt.created");

      // Verify state retrieval
      const fetched = store.getAttempt("att-1");
      expect(fetched).not.toBeNull();
      expect(fetched?.attemptId).toBe("att-1");
      expect(fetched?.actionId).toBe("act-for-att-1");
      expect(fetched?.status).toBe("CREATED");
      expect(fetched?.attemptNumber).toBe(1);
      expect(fetched?.workerId).toBe("worker-A");
      expect(fetched?.leaseId).toBe("lease-1");
      expect(fetched?.idempotencyToken).toBe(createAttemptIdempotencyToken(runId, "act-for-att-1", 1));

      // Active attempt lookup
      const active = store.getActiveAttemptForAction("act-for-att-1");
      expect(active?.attemptId).toBe("att-1");

      // By number lookup
      const byNum = store.getAttemptByNumber("act-for-att-1", 1);
      expect(byNum?.attemptId).toBe("att-1");

      // By token lookup
      const byTok = store.getAttemptByIdempotencyToken(createAttemptIdempotencyToken(runId, "act-for-att-1", 1));
      expect(byTok?.attemptId).toBe("att-1");
    });

    it("throws AttemptNotFoundError when transitioning non-existent attempt", () => {
      expect(() => {
        store.transaction((tx) => {
          tx.transitionAttempt("att-does-not-exist", { type: "START", now: "2026-10-12T12:00:00Z" }, () => "e1");
        });
      }).toThrow(AttemptNotFoundError);
    });

    it("enforces single active attempt invariant per Action via partial index", () => {
      const { runId, binding, workerId, leaseId } = setupGovernedRun();
      setupAuthorizedAction(runId, binding, workerId, leaseId);

      const { attempt: att1, event: ev1 } = Attempt.create({
        attemptId: "att-active-1",
        actionId: "act-for-att-1",
        runId,
        attemptNumber: 1,
        workerId,
        leaseId,
        now: "2026-10-12T12:02:00.000Z",
      });

      store.transaction((tx) => {
        tx.insertAttempt(att1.snapshot, ev1, { workerId, leaseId });
      });

      // Attempt to create second active attempt for same action
      const { attempt: att2, event: ev2 } = Attempt.create({
        attemptId: "att-active-2",
        actionId: "act-for-att-1",
        runId,
        attemptNumber: 2,
        workerId,
        leaseId,
        now: "2026-10-12T12:03:00.000Z",
      });

      expect(() => {
        store.transaction((tx) => {
          tx.insertAttempt(att2.snapshot, ev2, { workerId, leaseId });
        });
      }).toThrow(ActiveAttemptConflictError);
    });

    it("enforces attempt number ordering and rejects duplicate attempt number", () => {
      const { runId, binding, workerId, leaseId } = setupGovernedRun();
      setupAuthorizedAction(runId, binding, workerId, leaseId);

      const { attempt: att1, event: ev1 } = Attempt.create({
        attemptId: "att-idem-1",
        actionId: "act-for-att-1",
        runId,
        attemptNumber: 1,
        workerId,
        leaseId,
        now: "2026-10-12T12:02:00.000Z",
      });

      store.transaction((tx) => {
        tx.insertAttempt(att1.snapshot, ev1, { workerId, leaseId });
      });

      // Complete attempt 1 so no active attempt conflict
      store.transaction((tx) => {
        tx.transitionAttempt(
          "att-idem-1",
          { type: "DISPATCH", now: "2026-10-12T12:02:10.000Z" },
          () => "e1",
          { workerId, leaseId }
        );
        tx.transitionAttempt(
          "att-idem-1",
          { type: "START", now: "2026-10-12T12:02:11.000Z" },
          () => "e2",
          { workerId, leaseId }
        );
        tx.transitionAttempt(
          "att-idem-1",
          {
            type: "FAIL",
            errorPayload: { error: "transient" },
            now: "2026-10-12T12:02:12.000Z",
          },
          () => "e3",
          { workerId, leaseId }
        );
      });

      // Re-submitting duplicate attempt #1
      const { attempt: attDup, event: evDup } = Attempt.create({
        attemptId: "att-idem-dup",
        actionId: "act-for-att-1",
        runId,
        attemptNumber: 1, // Duplicate attemptNumber and token
        workerId,
        leaseId,
        now: "2026-10-12T12:02:00.000Z",
      });

      expect(() => {
        store.transaction((tx) => {
          tx.insertAttempt(attDup.snapshot, evDup, { workerId, leaseId });
        });
      }).toThrow(InvalidAttemptError);
    });

    it("rejects Attempt creation if attemptNumber exceeds action.maxAttempts", () => {
      const { runId, binding, workerId, leaseId } = setupGovernedRun();
      setupAuthorizedAction(runId, binding, workerId, leaseId);

      // Create attempt 4 when maxAttempts is 3
      const { attempt, event } = Attempt.create({
        attemptId: "att-ceil-4",
        actionId: "act-for-att-1",
        runId,
        attemptNumber: 4,
        workerId,
        leaseId,
        now: "2026-10-12T12:02:00.000Z",
      });

      expect(() => {
        store.transaction((tx) => {
          tx.insertAttempt(attempt.snapshot, event, { workerId, leaseId });
        });
      }).toThrow(InvalidAttemptError);
    });

    it("transitions Attempt through DISPATCHED -> RUNNING -> SUCCEEDED", () => {
      const { runId, binding, workerId, leaseId } = setupGovernedRun();
      setupAuthorizedAction(runId, binding, workerId, leaseId);

      const { attempt, event: evCreated } = Attempt.create({
        attemptId: "att-trans-1",
        actionId: "act-for-att-1",
        runId,
        attemptNumber: 1,
        workerId,
        leaseId,
        now: "2026-10-12T12:02:00.000Z",
      });

      store.transaction((tx) => {
        tx.insertAttempt(attempt.snapshot, evCreated, { workerId, leaseId });
      });

      // 1. Dispatch
      store.transaction((tx) => {
        tx.transitionAttempt(
          "att-trans-1",
          { type: "DISPATCH", now: "2026-10-12T12:02:01.000Z" },
          () => "e-disp-1",
          { workerId, leaseId }
        );
      });
      expect(store.getAttempt("att-trans-1")?.status).toBe("DISPATCHED");

      // 2. Start
      store.transaction((tx) => {
        tx.transitionAttempt(
          "att-trans-1",
          { type: "START", now: "2026-10-12T12:02:02.000Z" },
          () => "e-start-1",
          { workerId, leaseId }
        );
      });
      expect(store.getAttempt("att-trans-1")?.status).toBe("RUNNING");

      // 3. Complete
      store.transaction((tx) => {
        tx.transitionAttempt(
          "att-trans-1",
          {
            type: "COMPLETE",
            outputPayload: { bytesRead: 128 },
            exitCode: 0,
            durationMs: 45,
            evidenceIds: ["evi-1"],
            now: "2026-10-12T12:02:05.000Z",
          },
          () => "e-comp-1",
          { workerId, leaseId }
        );
      });
      const finished = store.getAttempt("att-trans-1");
      expect(finished?.status).toBe("SUCCEEDED");
      expect(finished?.outputPayload).toEqual({ bytesRead: 128 });
      expect(finished?.exitCode).toBe(0);
      expect(finished?.durationMs).toBe(45);
      expect(finished?.evidenceIds).toEqual(["evi-1"]);
      expect(finished?.completedAt).toBe("2026-10-12T12:02:05.000Z");

      // 4. Terminal Immutability: transitionAttempt on terminal status throws InvalidAttemptTransitionError
      expect(() => {
        store.transaction((tx) => {
          tx.transitionAttempt(
            "att-trans-1",
            {
              type: "FAIL",
              errorPayload: { err: "fail" },
              now: "2026-10-12T12:02:06.000Z",
            },
            () => "e-fail-1",
            { workerId, leaseId }
          );
        });
      }).toThrow(InvalidAttemptTransitionError);

      // 5. Terminal Immutability: direct updateAttempt on terminal status throws TerminalStateError
      expect(() => {
        store.transaction((tx) => {
          tx.updateAttempt(
            "att-trans-1",
            {
              ...finished!,
              status: "FAILED",
              errorPayload: { code: "ERROR", message: "Cannot mutate" },
            },
            {
              eventId: "evt-illegal-mut-att",
              runId,
              timestamp: "2026-10-12T12:06:00.000Z",
              eventType: "attempt.failed",
              schemaVersion: 1,
              producer: "test",
              payload: {},
            } as any,
            { workerId, leaseId }
          );
        });
      }).toThrow(TerminalStateError);
    });

    it("persists UNKNOWN terminal state without translating to FAILED", () => {
      const { runId, binding, workerId, leaseId } = setupGovernedRun();
      setupAuthorizedAction(runId, binding, workerId, leaseId);

      const { attempt, event: evCreated } = Attempt.create({
        attemptId: "att-unk-1",
        actionId: "act-for-att-1",
        runId,
        attemptNumber: 1,
        workerId,
        leaseId,
        now: "2026-10-12T12:02:00.000Z",
      });

      store.transaction((tx) => {
        tx.insertAttempt(attempt.snapshot, evCreated, { workerId, leaseId });
        tx.transitionAttempt(
          "att-unk-1",
          { type: "DISPATCH", now: "2026-10-12T12:02:01.000Z" },
          () => "e-d",
          { workerId, leaseId }
        );
        tx.transitionAttempt(
          "att-unk-1",
          { type: "START", now: "2026-10-12T12:02:02.000Z" },
          () => "e-s",
          { workerId, leaseId }
        );
      });

      // Crash / sweeper transition to UNKNOWN
      store.transaction((tx) => {
        tx.transitionAttempt(
          "att-unk-1",
          {
            type: "MARK_UNKNOWN",
            reason: "LEASE_EXPIRED_DURING_EXECUTION",
            now: "2026-10-12T12:05:00.000Z",
          },
          () => "e-unk-1",
          { workerId, leaseId }
        );
      });

      const unkAttempt = store.getAttempt("att-unk-1");
      expect(unkAttempt).not.toBeNull();
      expect(unkAttempt?.status).toBe("UNKNOWN");
      expect(unkAttempt?.errorPayload).toEqual(
        expect.objectContaining({
          code: "EXECUTION_UNCERTAIN",
          reason: "LEASE_EXPIRED_DURING_EXECUTION",
          reasonCode: "LEASE_EXPIRED_DURING_EXECUTION",
        })
      );

      // Verify it cannot be resumed or modified
      expect(() => {
        store.transaction((tx) => {
          tx.transitionAttempt(
            "att-unk-1",
            { type: "START", now: "2026-10-12T12:06:00.000Z" },
            () => "e-resume",
            { workerId, leaseId }
          );
        });
      }).toThrow(InvalidAttemptTransitionError);
    });
  });

  // =========================================================================
  // 3. ATOMIC STATE + EVENT TRANSACTIONS & ROLLBACK
  // =========================================================================
  describe("3. Atomic State + Event Transactions & Rollback", () => {
    it("rolls back both state and event when transaction throws midway", () => {
      const { runId, binding, workerId, leaseId } = setupGovernedRun();

      const { action, event } = Action.create({
        actionId: "act-roll-1",
        runId,
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: { path: "data.txt" },
        contractBinding: binding,
        maxAttempts: 3,
      });

      expect(() => {
        store.transaction((tx) => {
          tx.insertAction(action.snapshot, event, { workerId, leaseId });
          throw new Error("Simulated mid-transaction failure");
        });
      }).toThrow("Simulated mid-transaction failure");

      // Verify Action was NOT persisted
      expect(store.getAction("act-roll-1")).toBeNull();

      // Verify Event was NOT persisted
      const events = store.getEventsForRun(runId);
      const actionEvents = events.filter((e) => e.eventType.startsWith("action."));
      expect(actionEvents.length).toBe(0);
    });

    it("rolls back state if event append encounters constraint failure", () => {
      const { runId, binding, workerId, leaseId } = setupGovernedRun();

      const { action, event: ev1 } = Action.create({
        actionId: "act-roll-2",
        runId,
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: { path: "data.txt" },
        contractBinding: binding,
        maxAttempts: 3,
      });

      // Manually plant an event with fixed eventId
      store.transaction((tx) => {
        tx.appendEvent({
          eventId: "duplicate-event-id",
          runId,
          timestamp: new Date().toISOString(),
          eventType: "custom.event",
          schemaVersion: 1,
          producer: "test",
          payload: {},
        });
      });

      // Create an action with the duplicate eventId
      const conflictingEvent = {
        ...ev1,
        eventId: "duplicate-event-id", // Will violate PRIMARY KEY on run_events
      };

      expect(() => {
        store.transaction((tx) => {
          tx.insertAction(action.snapshot, conflictingEvent, { workerId, leaseId });
        });
      }).toThrow();

      // Verify Action was rolled back
      expect(store.getAction("act-roll-2")).toBeNull();
    });
  });

  // =========================================================================
  // 4. LEASE FENCING & STALE WORKER CONCURRENCY DEFENSE
  // =========================================================================
  describe("4. Lease Fencing & Stale Worker Concurrency Defense", () => {
    it("rejects stale worker attempt completion with LeaseLostError after lease reassignment", () => {
      // 1. Worker A starts run with lease-A
      const { runId, binding } = setupGovernedRun("run-fenced-test", "worker-A", "lease-A");

      const { action, event: evAct } = Action.create({
        actionId: "act-fenced-1",
        runId,
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: { path: "confidential.txt" },
        contractBinding: binding,
        maxAttempts: 3,
      });

      store.transaction((tx) => {
        tx.insertAction(action.snapshot, evAct, { workerId: "worker-A", leaseId: "lease-A" });
        tx.transitionAction(
          "act-fenced-1",
          { type: "AUTHORIZE", now: "2026-10-12T12:01:00.000Z" },
          () => "ea-1",
          { workerId: "worker-A", leaseId: "lease-A" }
        );
        tx.transitionAction(
          "act-fenced-1",
          { type: "START_ATTEMPT", attemptNumber: 1, now: "2026-10-12T12:02:00.000Z" },
          () => "ea-2",
          { workerId: "worker-A", leaseId: "lease-A" }
        );
      });

      const { attempt, event: evAtt } = Attempt.create({
        attemptId: "att-fenced-1",
        actionId: "act-fenced-1",
        runId,
        attemptNumber: 1,
        workerId: "worker-A",
        leaseId: "lease-A",
        now: "2026-10-12T12:02:00.000Z",
      });

      store.transaction((tx) => {
        tx.insertAttempt(attempt.snapshot, evAtt, { workerId: "worker-A", leaseId: "lease-A" });
        tx.transitionAttempt(
          "att-fenced-1",
          { type: "DISPATCH", now: "2026-10-12T12:02:01.000Z" },
          () => "eat-1",
          { workerId: "worker-A", leaseId: "lease-A" }
        );
        tx.transitionAttempt(
          "att-fenced-1",
          { type: "START", now: "2026-10-12T12:02:02.000Z" },
          () => "eat-2",
          { workerId: "worker-A", leaseId: "lease-A" }
        );
      });

      expect(store.getAttempt("att-fenced-1")?.status).toBe("RUNNING");

      // 2. Worker A stalls. Sweeper reclaims run and grants lease-B to Worker B
      const runSnapshot = store.getRun("run-fenced-test")!;
      const runReconstituted = Run.reconstitute(runSnapshot);

      store.transaction((tx) => {
        const expireEvent = runReconstituted.expireLease();
        tx.updateRun(runId, 4, runReconstituted.snapshot, expireEvent);
        tx.updateLeaseState("lease-A", "EXPIRED");

        const claimB = runReconstituted.claim("worker-B", "lease-B", "2026-10-12T12:45:00.000Z");
        tx.updateRun(runId, 5, runReconstituted.snapshot, claimB);
        tx.insertLease({
          leaseId: "lease-B",
          runId,
          workerId: "worker-B",
          acquiredAt: "2026-10-12T12:05:00.000Z",
          expiresAt: "2026-10-12T12:45:00.000Z",
          releasedAt: null,
          state: "ACTIVE",
        });
      });

      expect(store.getRun("run-fenced-test")?.currentWorkerId).toBe("worker-B");
      expect(store.getRun("run-fenced-test")?.leaseId).toBe("lease-B");

      // 3. Stale Worker A wakes up and tries to complete Attempt #1 with lease-A
      expect(() => {
        store.transaction((tx) => {
          tx.transitionAttempt(
            "att-fenced-1",
            {
              type: "COMPLETE",
              outputPayload: { secret: "leaked" },
              exitCode: 0,
              now: "2026-10-12T12:06:00.000Z",
            },
            () => "stale-complete-evt",
            { workerId: "worker-A", leaseId: "lease-A" }
          );
        });
      }).toThrow(LeaseLostError);

      // 4. Verify Attempt state was NOT mutated and no false success event was added
      const preservedAttempt = store.getAttempt("att-fenced-1");
      expect(preservedAttempt?.status).toBe("RUNNING");
      expect(preservedAttempt?.completedAt).toBeNull();

      const events = store.getEventsForRun(runId);
      const staleEvents = events.filter((e) => e.eventId === "stale-complete-evt");
      expect(staleEvents.length).toBe(0);
    });

    it("rejects stale worker Action insertion with LeaseLostError", () => {
      const { runId, binding } = setupGovernedRun("run-stale-act-test", "worker-A", "lease-A");

      // Reassign run to worker-B
      const runSnapshot = store.getRun("run-stale-act-test")!;
      const run = Run.reconstitute(runSnapshot);

      store.transaction((tx) => {
        const expireEvt = run.expireLease();
        tx.updateRun(runId, 4, run.snapshot, expireEvt);
        const claimB = run.claim("worker-B", "lease-B", "2026-10-12T13:00:00.000Z");
        tx.updateRun(runId, 5, run.snapshot, claimB);
        tx.insertLease({
          leaseId: "lease-B",
          runId,
          workerId: "worker-B",
          acquiredAt: "2026-10-12T12:05:00.000Z",
          expiresAt: "2026-10-12T13:00:00.000Z",
          releasedAt: null,
          state: "ACTIVE",
        });
      });

      // Stale Worker A tries to create Action with old lease-A
      const { action, event } = Action.create({
        actionId: "act-stale-worker",
        runId,
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: { path: "a.ts" },
        contractBinding: binding,
        maxAttempts: 3,
      });

      expect(() => {
        store.transaction((tx) => {
          tx.insertAction(action.snapshot, event, { workerId: "worker-A", leaseId: "lease-A" });
        });
      }).toThrow(LeaseLostError);

      expect(store.getAction("act-stale-worker")).toBeNull();
    });
  });

  // =========================================================================
  // 5. SECURITY & PAYLOAD BOUNDING
  // =========================================================================
  describe("5. Security & Payload Bounding", () => {
    it("redacts sensitive keys from persisted payloads while preserving canonical hash", () => {
      const { runId, binding, workerId, leaseId } = setupGovernedRun();

      const sensitiveInput = {
        path: "credentials.json",
        apiKey: "SUPER_SECRET_KEY_12345",
        nested: {
          password: "my-secret-password",
          safeField: "public-value",
        },
      };

      const { action, event } = Action.create({
        actionId: "act-sec-1",
        runId,
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: sensitiveInput,
        contractBinding: binding,
        maxAttempts: 3,
      });

      store.transaction((tx) => {
        tx.insertAction(action.snapshot, event, { workerId, leaseId });
      });

      const fetched = store.getAction("act-sec-1");
      expect(fetched).not.toBeNull();
      const inputObj = fetched?.inputPayload as any;

      // Verify secrets are redacted in SQLite
      expect(inputObj.apiKey).toBe("[REDACTED]");
      expect(inputObj.nested.password).toBe("[REDACTED]");
      expect(inputObj.nested.safeField).toBe("public-value");

      // Verify canonical hash invariant
      expect(fetched?.inputHash).toBe(action.inputHash);
    });

    it("rejects payloads exceeding MAX_PERSISTED_PAYLOAD_BYTES limit", () => {
      const { runId, binding, workerId, leaseId } = setupGovernedRun();

      // Create an input payload larger than 1 MB
      const largePayload = {
        data: "x".repeat(MAX_PERSISTED_PAYLOAD_BYTES + 100),
      };

      const { action, event } = Action.create({
        actionId: "act-large-1",
        runId,
        sequenceNumber: 1,
        toolName: "write_file",
        inputPayload: largePayload,
        contractBinding: binding,
        maxAttempts: 3,
      });

      expect(() => {
        store.transaction((tx) => {
          tx.insertAction(action.snapshot, event, { workerId, leaseId });
        });
      }).toThrow(PayloadLimitExceededError);
    });
  });

  // =========================================================================
  // 6. MIGRATION & HISTORICAL DATA SAFETY
  // =========================================================================
  describe("6. Migration & Historical Data Safety", () => {
    it("applies migrations cleanly to empty database and establishes constraints", () => {
      const memDb = createSqliteClient({ location: ":memory:" });

      // Check actions table
      const actTable = memDb.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='actions'`
      ).get();
      expect(actTable).not.toBeUndefined();

      // Check attempts table
      const attTable = memDb.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='attempts'`
      ).get();
      expect(attTable).not.toBeUndefined();

      // Check partial unique index
      const activeIdx = memDb.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_attempts_action_active'`
      ).get();
      expect(activeIdx).not.toBeUndefined();

      memDb.close();
    });

    it("upgrades existing database idempotently without altering historical runs", () => {
      const migrationTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-mig-test-"));
      const migrationDbPath = path.join(migrationTempDir, "mig.db");

      // 1. Create client and seed historical run
      const client1 = createSqliteClient({ location: migrationDbPath });
      client1.exec(`
        INSERT INTO tasks (task_id, title, description, input_payload, created_at, updated_at)
        VALUES ('hist-task-1', 'Legacy Task', '', '{}', '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z');

        INSERT INTO runs (run_id, task_id, status, attempt_count, max_attempts, timeout_ms, version, created_at, updated_at)
        VALUES ('hist-run-1', 'hist-task-1', 'COMPLETED', 1, 3, 30000, 1, '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z');
      `);
      client1.close();

      // 2. Reopen and run migration
      const client2 = createSqliteClient({ location: migrationDbPath });
      migrateDatabase(client2);

      // Verify historical run is untouched
      const histRun = client2.prepare(`SELECT * FROM runs WHERE run_id = 'hist-run-1'`).get() as any;
      expect(histRun.run_id).toBe("hist-run-1");
      expect(histRun.status).toBe("COMPLETED");

      // Verify 0 fabricated actions or attempts
      const actCount = client2.prepare(`SELECT COUNT(*) AS c FROM actions`).get() as any;
      expect(actCount.c).toBe(0);

      const attCount = client2.prepare(`SELECT COUNT(*) AS c FROM attempts`).get() as any;
      expect(attCount.c).toBe(0);

      client2.close();
      fs.rmSync(migrationTempDir, { recursive: true, force: true });
    });
  });
});
