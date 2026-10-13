import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { Run } from "../../src/domain/run.js";
import { Action } from "../../src/domain/action.js";
import { Attempt } from "../../src/domain/attempt.js";
import { createContractBinding } from "../../src/domain/invariants.js";
import {
  MissionContract,
  createDefaultInProcessPolicy,
  createMissionContract,
  createResourceLimits,
  createVerificationSpec,
} from "../../src/domain/index.js";
import { ContextSource } from "../../src/application/context/context-source.js";
import { ContextEngine } from "../../src/application/context/context-engine.js";
import { DEFAULT_CONTEXT_BUDGET, ContextBudget } from "../../src/domain/context.js";

describe("Application Integration — Context Engine End-to-End with SQLite State Store", () => {
  let tempDir: string;
  let dbPath: string;
  let store: SqliteStateStore;
  let boundContract: MissionContract;

  const runId = "run-ctx-integ-1";
  const taskId = "task-ctx-integ-1";
  const workerId = "worker-integ-1";
  const leaseId = "lease-integ-1";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-ctx-integ-"));
    dbPath = path.join(tempDir, "test.db");
    store = new SqliteStateStore({ location: dbPath });

    // Seed task, contract, worker, run, actions, attempts, events
    store.transaction((tx) => {
      tx.insertTask({
        taskId,
        title: "Integration Task with Sensitive Credentials",
        description: "Verify Context Engine observation selection, redaction, and budgeting",
        inputPayload: {
          project: "fabric",
          secret_key: "super-secret-password-12345",
          api_token: "jwt-token-abcd-efgh",
        },
        createdAt: "2026-10-13T12:00:00.000Z",
        updatedAt: "2026-10-13T12:00:00.000Z",
      });

      boundContract = createMissionContract({
        contractId: "contract-ctx-1",
        version: 1,
        taskId,
        policy: createDefaultInProcessPolicy("policy-ctx-1"),
        verificationSpecs: [
          createVerificationSpec({
            specId: "vspec-ctx-1",
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
      tx.activateContract("contract-ctx-1", 1, "2026-10-13T12:00:01.000Z");

      tx.insertWorker({
        workerId,
        hostname: "node-ctx",
        pid: 2026,
        status: "ACTIVE",
        lastHeartbeatAt: "2026-10-13T12:00:00.000Z",
        createdAt: "2026-10-13T12:00:00.000Z",
      });

      const binding = createContractBinding({
        contractId: boundContract.spec.contractId,
        version: boundContract.spec.version,
        contentHash: boundContract.contentHash,
      });

      const { run, event: runCreatedEvent } = Run.create({
        runId,
        taskId,
        contractBinding: binding,
        maxOutputBytes: 65536,
      });

      tx.insertRun(run.snapshot, runCreatedEvent);
      const qEvent = run.queue();
      tx.updateRun(runId, 1, run.snapshot, qEvent);
      const claimEvent = run.claim(workerId, leaseId, "2026-10-13T12:30:00.000Z");
      tx.updateRun(runId, 2, run.snapshot, claimEvent);
      tx.insertLease({
        leaseId,
        runId,
        workerId,
        acquiredAt: "2026-10-13T12:00:00.000Z",
        expiresAt: "2026-10-13T12:30:00.000Z",
        releasedAt: null,
        state: "ACTIVE",
      });
      const startEvent = run.start(workerId, leaseId);
      tx.updateRun(runId, 3, run.snapshot, startEvent, { workerId, leaseId });

      // Action 1: read_file with oversized output (to test tool output truncation)
      const { action: action1, event: a1CreatedEvent } = Action.create({
        actionId: "act-1",
        runId,
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: { path: "src/main.ts", access_token: "secret-token-act1" },
        contractBinding: binding,
        maxAttempts: 3,
        now: "2026-10-13T12:01:00.000Z",
      });
      tx.insertAction(action1.snapshot, a1CreatedEvent, { workerId, leaseId });
      tx.transitionAction(
        "act-1",
        { type: "AUTHORIZE", now: "2026-10-13T12:01:00.500Z" },
        () => "evt-auth-1",
        { workerId, leaseId }
      );

      const { attempt: att1, event: att1CreatedEvent } = Attempt.create({
        attemptId: "att-1-1",
        actionId: "act-1",
        runId,
        attemptNumber: 1,
        workerId,
        leaseId,
        now: "2026-10-13T12:01:01.000Z",
      });
      tx.insertAttempt(att1.snapshot, att1CreatedEvent, { workerId, leaseId });

      tx.transitionAction(
        "act-1",
        { type: "START_ATTEMPT", attemptNumber: 1, now: "2026-10-13T12:01:01.500Z" },
        () => "evt-act1-start",
        { workerId, leaseId }
      );

      // Start attempt 1
      tx.transitionAttempt(
        "att-1-1",
        { type: "DISPATCH", now: "2026-10-13T12:01:02.000Z" },
        () => "evt-att1-disp",
        { workerId, leaseId }
      );
      tx.transitionAttempt(
        "att-1-1",
        { type: "START", now: "2026-10-13T12:01:02.500Z" },
        () => "evt-att1-start",
        { workerId, leaseId }
      );

      // Complete attempt 1 with large stdout (> 3000 bytes)
      const largeOutput = "LOG_LINE_START\n" + "X".repeat(3500) + "\nLOG_LINE_END";
      tx.transitionAttempt(
        "att-1-1",
        {
          type: "COMPLETE",
          outputPayload: { stdout: largeOutput, exitCode: 0 },
          exitCode: 0,
          now: "2026-10-13T12:01:05.000Z",
        },
        () => "evt-att1-comp",
        { workerId, leaseId }
      );

      // Complete Action 1
      tx.transitionAction(
        "act-1",
        {
          type: "SUCCEED",
          resultPayload: { stdout: "truncated summary", exitCode: 0 },
          now: "2026-10-13T12:01:06.000Z",
        },
        () => "evt-act1-succ",
        { workerId, leaseId }
      );

      // Action 2: write_file that resulted in UNKNOWN attempt
      const { action: action2, event: a2CreatedEvent } = Action.create({
        actionId: "act-2",
        runId,
        sequenceNumber: 2,
        toolName: "write_file",
        inputPayload: { path: "output.txt", content: "data" },
        contractBinding: binding,
        maxAttempts: 3,
        now: "2026-10-13T12:02:00.000Z",
      });
      tx.insertAction(action2.snapshot, a2CreatedEvent, { workerId, leaseId });
      tx.transitionAction(
        "act-2",
        { type: "AUTHORIZE", now: "2026-10-13T12:02:00.500Z" },
        () => "evt-auth-2",
        { workerId, leaseId }
      );

      const { attempt: att2, event: att2CreatedEvent } = Attempt.create({
        attemptId: "att-2-1",
        actionId: "act-2",
        runId,
        attemptNumber: 1,
        workerId,
        leaseId,
        now: "2026-10-13T12:02:01.000Z",
      });
      tx.insertAttempt(att2.snapshot, att2CreatedEvent, { workerId, leaseId });

      tx.transitionAction(
        "act-2",
        { type: "START_ATTEMPT", attemptNumber: 1, now: "2026-10-13T12:02:01.500Z" },
        () => "evt-act2-start",
        { workerId, leaseId }
      );

      tx.transitionAttempt(
        "att-2-1",
        { type: "DISPATCH", now: "2026-10-13T12:02:02.000Z" },
        () => "evt-att2-disp",
        { workerId, leaseId }
      );
      tx.transitionAttempt(
        "att-2-1",
        { type: "START", now: "2026-10-13T12:02:02.500Z" },
        () => "evt-att2-start",
        { workerId, leaseId }
      );

      // Mark attempt 2 as UNKNOWN due to lease expiration during execution
      tx.transitionAttempt(
        "att-2-1",
        {
          type: "MARK_UNKNOWN",
          reason: "Worker lost lease while executing write_file",
          reasonCode: "LEASE_EXPIRED_DURING_EXECUTION",
          now: "2026-10-13T12:02:10.000Z",
        },
        () => "evt-att2-unk",
        { workerId, leaseId }
      );

      // Append domain events (workspace, verification, evidence)
      tx.appendEvent({
        eventId: "evt-ws-1",
        runId,
        timestamp: "2026-10-13T12:00:05.000Z",
        eventType: "workspace.provisioned",
        schemaVersion: 1,
        producer: "application.worker_runtime",
        payload: {
          workspaceId: "ws-1",
          rootDirectory: "/tmp/ws-1",
          hostDirectory: "C:\\tmp\\ws-1",
          status: "READY",
        },
      });

      tx.appendEvent({
        eventId: "evt-ver-1",
        runId,
        timestamp: "2026-10-13T12:01:07.000Z",
        eventType: "verification.completed",
        schemaVersion: 1,
        producer: "domain.verification",
        payload: {
          passed: true,
          checks: ["EXACT_OUTPUT_MATCH"],
        },
      });

      tx.appendEvent({
        eventId: "evt-ev-1",
        runId,
        timestamp: "2026-10-13T12:01:08.000Z",
        eventType: "evidence.recorded",
        schemaVersion: 1,
        producer: "application.worker_runtime",
        payload: {
          evidenceId: "ev-1",
          type: "PROCESS_EXIT",
          summary: "Exit code 0 confirmed",
        },
      });
    });
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // Ignored if already closed
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  });

  it("1. Zero State Mutations: Context Engine executes read-only without modifying database state", async () => {
    const runBefore = store.getRun(runId);
    const actionsBefore = store.getActionsForRun(runId);
    const eventsBefore = store.getEventsForRun(runId);
    const contractBefore = store.getContract("contract-ctx-1", 1);

    const source = new ContextSource(store);
    const candidates = await source.gatherCandidateObservations(runId);
    const snapshot = ContextEngine.build({
      runId,
      taskId,
      candidates,
    });

    expect(snapshot.observations.length).toBeGreaterThan(0);

    // Verify all database states remain strictly identical
    const runAfter = store.getRun(runId);
    const actionsAfter = store.getActionsForRun(runId);
    const eventsAfter = store.getEventsForRun(runId);
    const contractAfter = store.getContract("contract-ctx-1", 1);

    expect(runAfter).toEqual(runBefore);
    expect(actionsAfter).toEqual(actionsBefore);
    expect(eventsAfter).toEqual(eventsBefore);
    expect(contractAfter).toEqual(contractBefore);
  });

  it("2. Replayability & Determinism: Repeated execution produces identical snapshot and contextHash", async () => {
    const source = new ContextSource(store);
    const candidates1 = await source.gatherCandidateObservations(runId);
    const snapshot1 = ContextEngine.build({
      runId,
      taskId,
      candidates: candidates1,
      createdAt: "2026-10-13T12:05:00.000Z",
    });

    const candidates2 = await source.gatherCandidateObservations(runId);
    const snapshot2 = ContextEngine.build({
      runId,
      taskId,
      candidates: candidates2,
      createdAt: "2026-10-13T12:05:00.000Z",
    });

    expect(snapshot1.contextHash).toBe(snapshot2.contextHash);
    expect(snapshot1.snapshotId).toBe(snapshot2.snapshotId);
    expect(snapshot1.totalEstimatedTokens).toBe(snapshot2.totalEstimatedTokens);
    expect(snapshot1.totalBytes).toBe(snapshot2.totalBytes);

    // Close and reopen database from disk
    store.close();
    const reopenedStore = new SqliteStateStore({ location: dbPath });
    try {
      const reopenedSource = new ContextSource(reopenedStore);
      const candidatesReopened = await reopenedSource.gatherCandidateObservations(runId);
      const snapshotReopened = ContextEngine.build({
        runId,
        taskId,
        candidates: candidatesReopened,
        createdAt: "2026-10-13T12:05:00.000Z",
      });

      expect(snapshotReopened.contextHash).toBe(snapshot1.contextHash);
      expect(snapshotReopened.snapshotId).toBe(snapshot1.snapshotId);
    } finally {
      reopenedStore.close();
    }
  });

  it("3. Secret Redaction: Sensitive keys are redacted across all observations", async () => {
    const source = new ContextSource(store);
    const candidates = await source.gatherCandidateObservations(runId);
    const snapshot = ContextEngine.build({
      runId,
      taskId,
      candidates,
    });

    const serializedSnapshot = JSON.stringify(snapshot);
    expect(serializedSnapshot).not.toContain("super-secret-password-12345");
    expect(serializedSnapshot).not.toContain("jwt-token-abcd-efgh");
    expect(serializedSnapshot).not.toContain("secret-token-act1");

    // Verify mission context contains redaction marker
    const missionObs = snapshot.observations.find((o) => o.category === "MISSION_CONTEXT");
    expect(missionObs).toBeDefined();
    expect(JSON.stringify(missionObs?.content)).toContain("[REDACTED]");
  });

  it("4. Epistemic Uncertainty Preservation: UNKNOWN attempt preserves uncertainty and is mandatory", async () => {
    const source = new ContextSource(store);
    const candidates = await source.gatherCandidateObservations(runId);
    const snapshot = ContextEngine.build({
      runId,
      taskId,
      candidates,
    });

    const unknownAttemptObs = snapshot.observations.find(
      (o) => o.category === "ATTEMPT_HISTORY" && o.observationId === "obs-attempt-att-2-1"
    );

    expect(unknownAttemptObs).toBeDefined();
    expect(unknownAttemptObs?.isMandatory).toBe(true);
    expect(unknownAttemptObs?.content["status"]).toBe("UNKNOWN");
    expect(unknownAttemptObs?.content["executionOutcomeUncertain"]).toBe(true);
    expect(unknownAttemptObs?.content["unknownReason"]).toBe("LEASE_EXPIRED_DURING_EXECUTION");
    // Must never be normalized to FAILED or SUCCEEDED
    expect(unknownAttemptObs?.content["status"]).not.toBe("FAILED");
    expect(unknownAttemptObs?.content["status"]).not.toBe("SUCCEEDED");
  });

  it("5. Tool Output Truncation: Oversized output is bounded to maxToolOutputBytes", async () => {
    const source = new ContextSource(store);
    const candidates = await source.gatherCandidateObservations(runId);

    const budget: ContextBudget = {
      ...DEFAULT_CONTEXT_BUDGET,
      maxToolOutputBytes: 1024,
    };

    const snapshot = ContextEngine.build({
      runId,
      taskId,
      candidates,
      budget,
    });

    const toolResultObs = snapshot.observations.find(
      (o) => o.category === "TOOL_RESULT" && o.observationId === "obs-result-att-1-1"
    );

    expect(toolResultObs).toBeDefined();
    expect(toolResultObs?.truncation).toBeDefined();
    expect(toolResultObs?.truncation?.isTruncated).toBe(true);
    expect(toolResultObs?.truncation?.truncationStrategy).toBe("HEAD_TAIL");
    expect(toolResultObs?.estimatedBytes).toBeLessThanOrEqual(1500);

    const str = JSON.stringify(toolResultObs?.content);
    expect(str).toContain("LOG_LINE_START");
    expect(str).toContain("LOG_LINE_END");
    expect(str).toContain("TRUNCATED");
  });

  it("6. Context Budgeting: Tight token/byte ceilings prune non-mandatory observations with summary", async () => {
    const source = new ContextSource(store);
    const candidates = await source.gatherCandidateObservations(runId);

    // Provide a budget that allows mandatory observations + only a few optional items
    const tightBudget: ContextBudget = {
      ...DEFAULT_CONTEXT_BUDGET,
      maxObservations: 4, // RUN_STATE, MISSION_CONTEXT, UNKNOWN ATTEMPT are mandatory (3 items)
    };

    const snapshot = ContextEngine.build({
      runId,
      taskId,
      candidates,
      budget: tightBudget,
    });

    expect(snapshot.observations.length).toBeLessThanOrEqual(4);
    expect(snapshot.omittedObservationsCount).toBeGreaterThan(0);
    expect(snapshot.omittedObservationsSummary.length).toBeGreaterThan(0);

    // Mandatory observations MUST still be present
    expect(snapshot.observations.some((o) => o.category === "RUN_STATE")).toBe(true);
    expect(snapshot.observations.some((o) => o.category === "MISSION_CONTEXT")).toBe(true);
    expect(
      snapshot.observations.some(
        (o) => o.category === "ATTEMPT_HISTORY" && o.content["status"] === "UNKNOWN"
      )
    ).toBe(true);
  });
});
