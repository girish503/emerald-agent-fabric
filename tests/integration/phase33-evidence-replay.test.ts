import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { Action } from "../../src/domain/action.js";
import { Attempt } from "../../src/domain/attempt.js";
import {
  createMissionContract,
  createExecutionPolicy,
  createResourceLimits,
  createVerificationSpec,
} from "../../src/domain/index.js";
import { ClockPort } from "../../src/ports/clock.port.js";
import { EvidenceExporter } from "../../src/application/evidence-exporter.js";
import { EvidenceReplayVerifier } from "../../src/application/evidence-replay-verifier.js";
import { EvidenceBundle } from "../../src/domain/evidence-bundle.js";

class DeterministicClock implements ClockPort {
  private currentMs: number;
  constructor(startIso: string = "2026-10-18T10:00:00.000Z") {
    this.currentMs = new Date(startIso).getTime();
  }
  now(): Date {
    return new Date(this.currentMs);
  }
  nowIso(): string {
    return new Date(this.currentMs).toISOString();
  }
  advanceMs(ms: number): void {
    this.currentMs += ms;
  }
}

describe("Phase 33 — Governed Clean-Room Replay & Evidence Bundle Provenance", () => {
  let tmpDir: string;
  let dbPath: string;
  let store: SqliteStateStore;
  let clock: DeterministicClock;
  let coordinator: RunCoordinator;
  let runId: string;
  let validBundle: EvidenceBundle;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-phase33-"));
    dbPath = path.join(tmpDir, "state.db");
    store = new SqliteStateStore({ location: dbPath });
    clock = new DeterministicClock();
    coordinator = new RunCoordinator(store, clock);

    // Register Task first so foreign key constraints are satisfied
    coordinator.createTask({
      taskId: "task-p33-main",
      title: "Phase 33 Target Task",
      inputPayload: { goal: "verify provenance" },
    });

    // Create and activate contract
    const spec = {
      taskId: "task-p33-main",
      policy: createExecutionPolicy({
        policyId: "policy-p33",
        allowedCapabilities: ["read_file", "write_file", "run_command", "git_status", "git_diff"],
        isolationRequirement: "IN_PROCESS",
        trustedInProcessOperations: ["read_file", "write_file", "run_command", "git_status", "git_diff"],
      }),
      resourceLimits: createResourceLimits({
        timeoutMs: 30000,
        maxAttempts: 3,
        maxOutputBytes: 1048576,
      }),
      verificationSpecs: [
        createVerificationSpec({
          specId: "spec-exit-zero",
          ruleKind: "EXIT_CODE_ZERO",
          expectedValue: { toolName: "run_command" },
        }),
      ],
      credentialScopes: ["repo:read"],
    };

    const draft = createMissionContract(spec);
    store.insertContract(draft);
    store.activateContract(draft.spec.contractId, draft.spec.version, clock.nowIso());

    const createRes = coordinator.createRun({
      taskId: "task-p33-main",
      maxAttempts: 3,
      timeoutMs: 30000,
    });
    runId = createRes.run.runId;

    // Queue and Claim
    coordinator.queueRun(runId);
    coordinator.registerWorker({
      workerId: "worker-1",
      hostname: "node-1",
      pid: 1001,
      status: "ACTIVE",
      lastHeartbeatAt: clock.nowIso(),
      createdAt: clock.nowIso(),
    });

    const claim = coordinator.claimRun(runId, "worker-1", 10000);
    coordinator.startRun(runId, "worker-1", claim.lease.leaseId);

    // Step 1: Action 1 with Attempt 1
    const actionId = "act-p33-1";
    const { action, event: actEvt } = Action.create({
      actionId,
      runId,
      sequenceNumber: 1,
      toolName: "run_command",
      inputPayload: { command: "test", sensitiveSecret: "super-secret-token" },
      contractBinding: createRes.run.contractBinding!,
      maxAttempts: 3,
      now: clock.nowIso(),
    });

    const { attempt: att1, event: att1Evt } = Attempt.create({
      attemptId: "att-p33-1",
      actionId,
      runId,
      attemptNumber: 1,
      workerId: "worker-1",
      leaseId: claim.lease.leaseId,
      now: clock.nowIso(),
    });

    store.transaction((tx) => {
      tx.insertAction(action.snapshot, actEvt, { workerId: "worker-1", leaseId: claim.lease.leaseId });
      tx.transitionAction(actionId, { type: "AUTHORIZE", now: clock.nowIso() }, () => "e1");
      tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 1, now: clock.nowIso() }, () => "e2");
      tx.insertAttempt(att1.snapshot, att1Evt, { workerId: "worker-1", leaseId: claim.lease.leaseId });
      tx.transitionAttempt("att-p33-1", { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
      tx.transitionAttempt("att-p33-1", { type: "START", now: clock.nowIso() }, () => "e4");
      tx.transitionAttempt(
        "att-p33-1",
        {
          type: "COMPLETE",
          outputPayload: { exitCode: 0, stdout: "All tests passed" },
          exitCode: 0,
          now: clock.nowIso(),
        },
        () => "e5"
      );
      tx.transitionAction(actionId, { type: "SUCCEED", resultPayload: { exitCode: 0 }, now: clock.nowIso() }, () => "e6");
    });

    // Save Checkpoint 1
    coordinator.saveCheckpoint({
      runId,
      checkpointVersion: 1,
      actionId,
      attemptNumber: 1,
      durableState: { stage: "test-passed" },
    });

    // Record Verification Evidence and Result
    coordinator.recordEvidence(runId, {
      evidenceId: "evi-p33-1",
      runId,
      source: "PROVIDER_REPORTED",
      kind: "PROCESS_EXIT",
      contentHash: "a".repeat(64),
      summary: { exitCode: 0 },
      observedAt: clock.nowIso(),
      schemaVersion: 1,
    });

    coordinator.recordVerificationResult(runId, {
      status: "VERIFIED",
      verifierId: "deterministic-verifier-v1",
      specId: "spec-exit-zero",
      evidenceIds: ["evi-p33-1"],
      message: "EXIT_CODE_ZERO satisfied by run_command",
      verifiedAt: clock.nowIso(),
    });

    // Complete run
    coordinator.completeRun(runId, "worker-1", claim.lease.leaseId, { success: true });

    // Export golden valid bundle
    validBundle = EvidenceExporter.exportBundle(store, runId, { nowIso: clock.nowIso() });
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // Ignore if already closed
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // T1: Valid bundle
  // -------------------------------------------------------------------------
  it("T1: exports and verifies a valid evidence bundle", () => {
    const result = EvidenceReplayVerifier.verify(validBundle);
    expect(result.valid).toBe(true);
    expect(result.bundleIntegrity).toBe(true);
    expect(result.contractIntegrity).toBe(true);
    expect(result.eventIntegrity).toBe(true);
    expect(result.checkpointIntegrity).toBe(true);
    expect(result.attemptIntegrity).toBe(true);
    expect(result.authorityIntegrity).toBe(true);
    expect(result.verificationIntegrity).toBe(true);
    expect(result.terminalOutcome).toBe("COMPLETED");
    expect(result.failures.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // T2: Bundle content mutation
  // -------------------------------------------------------------------------
  it("T2: detects single-field bundle content mutation", () => {
    const tampered = {
      ...validBundle,
      run: {
        ...validBundle.run,
        taskId: "tampered-task-id",
      },
    };
    const result = EvidenceReplayVerifier.verify(tampered);
    expect(result.valid).toBe(false);
    expect(result.bundleIntegrity).toBe(false);
    expect(result.failures.some((f) => f.includes("Bundle identity mismatch"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T3: Contract mutation
  // -------------------------------------------------------------------------
  it("T3: detects contract specification mutation", () => {
    const tampered = {
      ...validBundle,
      contract: {
        ...validBundle.contract,
        spec: {
          ...validBundle.contract.spec,
          taskId: "tampered-contract-task",
        },
      },
    };
    const result = EvidenceReplayVerifier.verify(tampered);
    expect(result.valid).toBe(false);
    expect(result.contractIntegrity).toBe(false);
    expect(result.failures.some((f) => f.includes("Contract specification contentHash mismatch"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T4: Contract hash substitution
  // -------------------------------------------------------------------------
  it("T4: detects contract hash substitution without spec modification", () => {
    const tampered = {
      ...validBundle,
      contract: {
        ...validBundle.contract,
        contentHash: "f".repeat(64),
      },
    };
    const result = EvidenceReplayVerifier.verify(tampered);
    expect(result.valid).toBe(false);
    expect(result.contractIntegrity).toBe(false);
    expect(result.failures.some((f) => f.includes("contentHash mismatch"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T5: Event deletion
  // -------------------------------------------------------------------------
  it("T5: detects event deletion causing sequence and hash-chain failure", () => {
    const modifiedEvents = [...validBundle.events];
    modifiedEvents.splice(1, 1); // Delete internal event
    const tampered = {
      ...validBundle,
      events: modifiedEvents,
    };
    const result = EvidenceReplayVerifier.verify(tampered);
    expect(result.valid).toBe(false);
    expect(result.eventIntegrity).toBe(false);
    expect(result.failures.some((f) => f.includes("sequence gap") || f.includes("hash chain broken"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T6: Event duplication
  // -------------------------------------------------------------------------
  it("T6: detects duplicated event causing sequence disorder and chain breakage", () => {
    const duplicateEvent = { ...validBundle.events[0]! };
    const tampered = {
      ...validBundle,
      events: [duplicateEvent, ...validBundle.events],
    };
    const result = EvidenceReplayVerifier.verify(tampered);
    expect(result.valid).toBe(false);
    expect(result.eventIntegrity).toBe(false);
  });

  // -------------------------------------------------------------------------
  // T7: Event reordering
  // -------------------------------------------------------------------------
  it("T7: detects swapped/reordered events", () => {
    expect(validBundle.events.length).toBeGreaterThanOrEqual(2);
    const swapped = [...validBundle.events];
    const temp = swapped[0]!;
    swapped[0] = swapped[1]!;
    swapped[1] = temp;

    const tampered = {
      ...validBundle,
      events: swapped,
    };
    const result = EvidenceReplayVerifier.verify(tampered);
    expect(result.valid).toBe(false);
    expect(result.eventIntegrity).toBe(false);
  });

  // -------------------------------------------------------------------------
  // T8: Event payload mutation
  // -------------------------------------------------------------------------
  it("T8: detects tampered event payload violating event hash integrity", () => {
    const modifiedEvents = validBundle.events.map((e, idx) => {
      if (idx === 1) {
        return {
          ...e,
          payload: { ...(e.payload as any), forgedField: "malicious" },
        };
      }
      return e;
    });

    const tampered = {
      ...validBundle,
      events: modifiedEvents,
    };
    const result = EvidenceReplayVerifier.verify(tampered);
    expect(result.valid).toBe(false);
    expect(result.eventIntegrity).toBe(false);
    expect(result.failures.some((f) => f.includes("Event hash integrity failure"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T9: Previous-event hash mutation
  // -------------------------------------------------------------------------
  it("T9: detects forged previousEventHash pointer in hash chain", () => {
    const modifiedEvents = validBundle.events.map((e, idx) => {
      if (idx === 2) {
        return {
          ...e,
          previousEventHash: "0".repeat(64),
        };
      }
      return e;
    });

    const tampered = {
      ...validBundle,
      events: modifiedEvents,
    };
    const result = EvidenceReplayVerifier.verify(tampered);
    expect(result.valid).toBe(false);
    expect(result.eventIntegrity).toBe(false);
    expect(result.failures.some((f) => f.includes("hash chain broken"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T10: Attempt-number mutation
  // -------------------------------------------------------------------------
  it("T10: detects non-monotonic attempt numbering gap", () => {
    const modifiedAttempts = validBundle.attempts.map((att) => ({
      ...att,
      attemptNumber: 5, // Gap: expected 1, found 5
    }));

    const tampered = {
      ...validBundle,
      attempts: modifiedAttempts,
    };
    const result = EvidenceReplayVerifier.verify(tampered);
    expect(result.valid).toBe(false);
    expect(result.attemptIntegrity).toBe(false);
    expect(result.failures.some((f) => f.includes("Attempt number non-monotonic"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T11: Attempt identity mutation
  // -------------------------------------------------------------------------
  it("T11: detects attempt runId mismatch", () => {
    const modifiedAttempts = validBundle.attempts.map((att) => ({
      ...att,
      runId: "forged-run-uuid",
    }));

    const tampered = {
      ...validBundle,
      attempts: modifiedAttempts,
    };
    const result = EvidenceReplayVerifier.verify(tampered);
    expect(result.valid).toBe(false);
    expect(result.attemptIntegrity).toBe(false);
    expect(result.failures.some((f) => f.includes("mismatched runId"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T12: Action/Attempt mismatch
  // -------------------------------------------------------------------------
  it("T12: detects attempt referencing nonexistent actionId", () => {
    const modifiedAttempts = validBundle.attempts.map((att) => ({
      ...att,
      actionId: "nonexistent-action-id",
    }));

    const tampered = {
      ...validBundle,
      attempts: modifiedAttempts,
    };
    const result = EvidenceReplayVerifier.verify(tampered);
    expect(result.valid).toBe(false);
    expect(result.attemptIntegrity).toBe(false);
    expect(result.failures.some((f) => f.includes("references nonexistent actionId"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T13: Contract continuity mutation
  // -------------------------------------------------------------------------
  it("T13: detects attempt contractBinding divergence from bundle contract", () => {
    const modifiedActions = validBundle.actions.map((act) => ({
      ...act,
      contractBinding: {
        ...act.contractBinding,
        contentHash: "0".repeat(64),
      },
    }));

    const tampered = {
      ...validBundle,
      actions: modifiedActions,
    };
    const result = EvidenceReplayVerifier.verify(tampered);
    expect(result.valid).toBe(false);
    expect(result.attemptIntegrity).toBe(false);
    expect(result.failures.some((f) => f.includes("Contract continuity failure"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T14: Checkpoint rollback
  // -------------------------------------------------------------------------
  it("T14: detects checkpoint version regression or rollback", () => {
    const modifiedCheckpoints = [
      { ...validBundle.checkpoints[0]!, checkpointVersion: 2 },
      { ...validBundle.checkpoints[0]!, checkpointId: "ckpt-2", checkpointVersion: 1 }, // Regresses from 2 to 1
    ];

    const tampered = {
      ...validBundle,
      checkpoints: modifiedCheckpoints,
    };
    const result = EvidenceReplayVerifier.verify(tampered);
    expect(result.valid).toBe(false);
    expect(result.checkpointIntegrity).toBe(false);
    expect(result.failures.some((f) => f.includes("Checkpoint version non-monotonic"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T15: Checkpoint future reference
  // -------------------------------------------------------------------------
  it("T15: detects checkpoint referencing future event sequence", () => {
    const modifiedCheckpoints = validBundle.checkpoints.map((ckpt) => ({
      ...ckpt,
      eventSequence: 999999, // Future sequence
    }));

    const tampered = {
      ...validBundle,
      checkpoints: modifiedCheckpoints,
    };
    const result = EvidenceReplayVerifier.verify(tampered);
    expect(result.valid).toBe(false);
    expect(result.checkpointIntegrity).toBe(false);
    expect(result.failures.some((f) => f.includes("references future event sequence"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T16: Authority mutation
  // -------------------------------------------------------------------------
  it("T16: detects attempt with missing authority provenance", () => {
    const modifiedAttempts = validBundle.attempts.map((att) => ({
      ...att,
      workerId: "",
      leaseId: "",
    }));

    const tampered = {
      ...validBundle,
      attempts: modifiedAttempts,
    };
    const result = EvidenceReplayVerifier.verify(tampered);
    expect(result.valid).toBe(false);
    expect(result.authorityIntegrity).toBe(false);
    expect(result.failures.some((f) => f.includes("missing required worker or lease authority provenance"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T17: Verification evidence mutation
  // -------------------------------------------------------------------------
  it("T17: detects verification evidence with invalid contentHash format", () => {
    const modifiedEvidence = validBundle.verificationEvidence.map((evi) => ({
      ...evi,
      contentHash: "corrupted_short_hash",
    }));

    const tampered = {
      ...validBundle,
      verificationEvidence: modifiedEvidence,
    };
    const result = EvidenceReplayVerifier.verify(tampered);
    expect(result.valid).toBe(false);
    expect(result.verificationIntegrity).toBe(false);
    expect(result.failures.some((f) => f.includes("invalid contentHash format"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T18: Detached evidence
  // -------------------------------------------------------------------------
  it("T18: detects attempt referencing missing verification evidence", () => {
    const modifiedAttempts = validBundle.attempts.map((att) => ({
      ...att,
      evidenceIds: ["missing-evidence-uuid-999"],
    }));

    const tampered = {
      ...validBundle,
      attempts: modifiedAttempts,
    };
    const result = EvidenceReplayVerifier.verify(tampered);
    expect(result.valid).toBe(false);
    expect(result.verificationIntegrity).toBe(false);
    expect(result.failures.some((f) => f.includes("references missing verification evidence"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T19: Fourfold false success
  // -------------------------------------------------------------------------
  it("T19: rejects producer claimed COMPLETED when verification failed", () => {
    // Tamper the bundle so that the action exitCode is non-zero, but producer claimed COMPLETED
    const tamperedAttempts = validBundle.attempts.map((att) => ({
      ...att,
      exitCode: 1, // Non-zero exit code
      outputPayload: { exitCode: 1, stderr: "AssertionError" },
    }));

    const tampered = {
      ...validBundle,
      attempts: tamperedAttempts,
      run: {
        ...validBundle.run,
        status: "COMPLETED" as const,
      },
    };

    const result = EvidenceReplayVerifier.verify(tampered);
    expect(result.valid).toBe(false);
    expect(result.fourfoldOutcome.verificationPassed).toBe(false);
    expect(result.terminalOutcome).toBe("FAILED");
    expect(result.failures.some((f) => f.includes("Fourfold outcome mismatch"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T20: Valid failed mission
  // -------------------------------------------------------------------------
  it("T20: authenticates a legitimately failed mission as internally valid with FAILED outcome", () => {
    // Create a new run that fails deterministically
    const failRunRes = coordinator.createRun({
      taskId: "task-p33-main",
      maxAttempts: 1,
      timeoutMs: 30000,
    });
    const fRunId = failRunRes.run.runId;
    coordinator.queueRun(fRunId);
    const fClaim = coordinator.claimRun(fRunId, "worker-1", 10000);
    coordinator.startRun(fRunId, "worker-1", fClaim.lease.leaseId);

    // Fail the run explicitly
    coordinator.failRun(fRunId, { message: "Budget exhausted" }, "worker-1", fClaim.lease.leaseId);

    // Export the failed mission bundle
    const failedBundle = EvidenceExporter.exportBundle(store, fRunId, { nowIso: clock.nowIso() });

    // Verify the failed mission bundle
    const result = EvidenceReplayVerifier.verify(failedBundle);
    expect(result.valid).toBe(true);
    expect(result.bundleIntegrity).toBe(true);
    expect(result.contractIntegrity).toBe(true);
    expect(result.eventIntegrity).toBe(true);
    expect(result.terminalOutcome).toBe("FAILED");
    expect(result.failures.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Clean-room replay (Phase 33H)
  // -------------------------------------------------------------------------
  it("Phase 33H: executes clean-room offline replay after serialization and state store destruction", () => {
    // 1. Serialize bundle to pure JSON text
    const serializedBundle = JSON.stringify(validBundle);

    // 2. Parse bundle back
    const parsedBundle: EvidenceBundle = JSON.parse(serializedBundle);

    // 3. Close and destroy the state store instance
    store.close();
    fs.rmSync(dbPath, { force: true });

    // 4. Run pure offline verifier
    const result = EvidenceReplayVerifier.verify(parsedBundle);
    expect(result.valid).toBe(true);
    expect(result.bundleIntegrity).toBe(true);
    expect(result.terminalOutcome).toBe("COMPLETED");
    expect(result.failures.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Replay determinism (Phase 33I)
  // -------------------------------------------------------------------------
  it("Phase 33I: guarantees strict replay determinism across repeated executions", () => {
    const result1 = EvidenceReplayVerifier.verify(validBundle);
    const result2 = EvidenceReplayVerifier.verify(validBundle);
    const result3 = EvidenceReplayVerifier.verify(validBundle);

    expect(result1).toEqual(result2);
    expect(result2).toEqual(result3);
    expect(result1.bundleId).toBe(result2.bundleId);
    expect(result1.provenanceRoot).toBe(result2.provenanceRoot);
  });

  // -------------------------------------------------------------------------
  // Security / Secret Redaction (Phase 33L)
  // -------------------------------------------------------------------------
  it("Phase 33L: confirms sensitive credentials and tokens are redacted with zero secret leakage", () => {
    const bundleString = JSON.stringify(validBundle);

    // Assert that the raw secret value never appears in the exported bundle
    expect(bundleString.includes("super-secret-token")).toBe(false);

    // Assert that the redacted token appears in the action payload
    const actionWithSecret = validBundle.actions.find((a) => a.actionId === "act-p33-1");
    expect(actionWithSecret).toBeDefined();
    expect((actionWithSecret!.inputPayload as any).sensitiveSecret).toBe("[REDACTED]");
  });
});
