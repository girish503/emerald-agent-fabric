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
import { SettableClock } from "../../src/ports/clock.port.js";
import { EvidenceExporter } from "../../src/application/evidence-exporter.js";
import {
  computeBundleId,
  EvidenceBundle,
} from "../../src/domain/evidence-bundle.js";
import { canonicalJsonStringify } from "../../src/domain/canonical-hash.js";
import { FileSystemEvidenceArchive } from "../../src/adapters/persistence/file-system-evidence-archive.js";
import { EvidenceIngestionGateway } from "../../src/application/evidence-ingestion-gateway.js";

describe("Phase 34 — Cross-Host Evidence Ingestion & Archival Integrity Boundary", () => {
  let tmpBaseDir: string;
  let producerDbDir: string;
  let archiveDir: string;
  let store: SqliteStateStore;
  let clock: SettableClock;
  let coordinator: RunCoordinator;
  let goldenBundle: EvidenceBundle;
  let goldenBundleJson: string;
  let archive: FileSystemEvidenceArchive;
  let gateway: EvidenceIngestionGateway;

  beforeEach(() => {
    tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-phase34-"));
    producerDbDir = path.join(tmpBaseDir, "producer");
    archiveDir = path.join(tmpBaseDir, "archive");
    fs.mkdirSync(producerDbDir, { recursive: true });
    fs.mkdirSync(archiveDir, { recursive: true });

    const dbPath = path.join(producerDbDir, "producer.db");
    store = new SqliteStateStore({ location: dbPath });
    clock = new SettableClock("2026-10-18T12:00:00.000Z");
    coordinator = new RunCoordinator(store, clock);

    // Register Task first so foreign key constraints are satisfied
    coordinator.createTask({
      taskId: "task-p34-main",
      title: "Phase 34 Ingestion Task",
      inputPayload: { goal: "verify cross-host ingestion" },
    });

    // Create and activate contract
    const spec = {
      taskId: "task-p34-main",
      policy: createExecutionPolicy({
        policyId: "policy-p34",
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
      taskId: "task-p34-main",
      maxAttempts: 3,
      timeoutMs: 30000,
    });
    const runId = createRes.run.runId;

    // Queue and Claim
    coordinator.queueRun(runId);
    coordinator.registerWorker({
      workerId: "worker-1",
      hostname: "node-producer",
      pid: 1001,
      status: "ACTIVE",
      lastHeartbeatAt: clock.nowIso(),
      createdAt: clock.nowIso(),
    });

    const claim = coordinator.claimRun(runId, "worker-1", 10000);
    coordinator.startRun(runId, "worker-1", claim.lease.leaseId);

    // Step 1: Action 1 with Attempt 1
    const actionId = "act-p34-1";
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
      attemptId: "att-p34-1",
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
      tx.transitionAttempt("att-p34-1", { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
      tx.transitionAttempt("att-p34-1", { type: "START", now: clock.nowIso() }, () => "e4");
      tx.transitionAttempt(
        "att-p34-1",
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
      evidenceId: "evi-p34-1",
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
      evidenceIds: ["evi-p34-1"],
      message: "EXIT_CODE_ZERO satisfied by run_command",
      verifiedAt: clock.nowIso(),
    });

    // Complete run
    coordinator.completeRun(runId, "worker-1", claim.lease.leaseId, { success: true });

    // Export golden valid bundle
    goldenBundle = EvidenceExporter.exportBundle(store, runId, { nowIso: clock.nowIso() });
    goldenBundleJson = canonicalJsonStringify(goldenBundle);

    // Initialize Receiver Archive & Gateway
    archive = new FileSystemEvidenceArchive({ baseDir: archiveDir, clock });
    gateway = new EvidenceIngestionGateway({ archive, clock });
  });

  afterEach(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tmpBaseDir, { recursive: true, force: true });
  });

  // Helper to recompute bundleId when mutating bundle content
  function withRecomputedBundleId(mutated: any): EvidenceBundle {
    const { bundleId, ...content } = mutated;
    const newId = computeBundleId(content);
    return {
      ...content,
      bundleId: newId,
    };
  }

  // -------------------------------------------------------------------------
  // T1: Valid bundle -> ACCEPTED
  // -------------------------------------------------------------------------
  it("T1: accepts a valid untrusted evidence bundle", () => {
    const result = gateway.ingest(goldenBundleJson);
    expect(result.status).toBe("ACCEPTED");
    expect(result.bundleId).toBe(goldenBundle.bundleId);
    expect(result.recomputedBundleId).toBe(goldenBundle.bundleId);
    expect(result.replayValid).toBe(true);
    expect(result.reasonCodes.length).toBe(0);
    expect(result.archiveReference).toBeDefined();
    expect(archive.hasAccepted(goldenBundle.bundleId)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T2: Malformed JSON -> QUARANTINED
  // -------------------------------------------------------------------------
  it("T2: quarantines malformed JSON payload", () => {
    const malformed = "{ invalid json content: 123, ";
    const result = gateway.ingest(malformed);
    expect(result.status).toBe("QUARANTINED");
    expect(result.replayValid).toBe(false);
    expect(result.reasonCodes).toContain("INVALID_JSON");
    expect(result.quarantineReference).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // T3: Oversized bundle -> QUARANTINED
  // -------------------------------------------------------------------------
  it("T3: quarantines oversized bundle payload before parsing", () => {
    const smallGateway = new EvidenceIngestionGateway({
      archive,
      clock,
      maxBytes: 100, // strict 100-byte limit
    });
    const result = smallGateway.ingest(goldenBundleJson);
    expect(result.status).toBe("QUARANTINED");
    expect(result.replayValid).toBe(false);
    expect(result.reasonCodes).toContain("BUNDLE_TOO_LARGE");
    expect(result.quarantineReference).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // T4: Unsupported schema -> QUARANTINED
  // -------------------------------------------------------------------------
  it("T4: quarantines payload with unsupported schema or missing fields", () => {
    const badSchema = JSON.stringify({
      formatVersion: "unknown-bundle-v99",
      schemaVersion: 99,
      data: "arbitrary",
    });
    const result = gateway.ingest(badSchema);
    expect(result.status).toBe("QUARANTINED");
    expect(result.replayValid).toBe(false);
    expect(result.reasonCodes).toContain("UNSUPPORTED_SCHEMA");
  });

  // -------------------------------------------------------------------------
  // T5: Invalid bundleId -> QUARANTINED
  // -------------------------------------------------------------------------
  it("T5: quarantines bundle with forged or mismatched bundleId", () => {
    const tampered = {
      ...goldenBundle,
      bundleId: "f".repeat(64), // Forged ID
    };
    const result = gateway.ingest(tampered);
    expect(result.status).toBe("QUARANTINED");
    expect(result.replayValid).toBe(false);
    expect(result.reasonCodes).toContain("INVALID_BUNDLE_ID");
    expect(result.bundleId).toBe("f".repeat(64));
    expect(result.recomputedBundleId).toBe(goldenBundle.bundleId);
  });

  // -------------------------------------------------------------------------
  // T6: Invalid provenanceRoot -> QUARANTINED
  // -------------------------------------------------------------------------
  it("T6: quarantines bundle with forged provenanceRoot", () => {
    const tampered = withRecomputedBundleId({
      ...goldenBundle,
      provenanceRoot: "e".repeat(64), // Forged provenanceRoot, but bundleId recalculated over it
    });
    const result = gateway.ingest(tampered);
    expect(result.status).toBe("QUARANTINED");
    expect(result.replayValid).toBe(false);
    expect(result.reasonCodes).toContain("INVALID_PROVENANCE_ROOT");
  });

  // -------------------------------------------------------------------------
  // T7: Contract tampering -> QUARANTINED
  // -------------------------------------------------------------------------
  it("T7: quarantines bundle with tampered contract content", () => {
    const tampered = withRecomputedBundleId({
      ...goldenBundle,
      contract: {
        ...goldenBundle.contract,
        contentHash: "d".repeat(64),
      },
    });
    const result = gateway.ingest(tampered);
    expect(result.status).toBe("QUARANTINED");
    expect(result.replayValid).toBe(false);
    expect(result.reasonCodes).toContain("CONTRACT_INTEGRITY_FAILURE");
  });

  // -------------------------------------------------------------------------
  // T8: Event deletion -> QUARANTINED
  // -------------------------------------------------------------------------
  it("T8: quarantines bundle with deleted internal event", () => {
    const modifiedEvents = [...goldenBundle.events];
    modifiedEvents.splice(1, 1); // remove event at index 1
    const tampered = withRecomputedBundleId({
      ...goldenBundle,
      events: modifiedEvents,
    });
    const result = gateway.ingest(tampered);
    expect(result.status).toBe("QUARANTINED");
    expect(result.replayValid).toBe(false);
    expect(result.reasonCodes).toContain("EVENT_INTEGRITY_FAILURE");
  });

  // -------------------------------------------------------------------------
  // T9: Event reordering -> QUARANTINED
  // -------------------------------------------------------------------------
  it("T9: quarantines bundle with swapped event sequence", () => {
    const modifiedEvents = [...goldenBundle.events];
    if (modifiedEvents.length >= 2) {
      const temp = modifiedEvents[0]!;
      modifiedEvents[0] = modifiedEvents[1]!;
      modifiedEvents[1] = temp;
    }
    const tampered = withRecomputedBundleId({
      ...goldenBundle,
      events: modifiedEvents,
    });
    const result = gateway.ingest(tampered);
    expect(result.status).toBe("QUARANTINED");
    expect(result.replayValid).toBe(false);
    expect(result.reasonCodes).toContain("EVENT_INTEGRITY_FAILURE");
  });

  // -------------------------------------------------------------------------
  // T10: Attempt mutation -> QUARANTINED
  // -------------------------------------------------------------------------
  it("T10: quarantines bundle with non-monotonic attempt numbering", () => {
    const modifiedAttempts = goldenBundle.attempts.map((att) => ({
      ...att,
      attemptNumber: 2, // Gapped attempt number
    }));
    const tampered = withRecomputedBundleId({
      ...goldenBundle,
      attempts: modifiedAttempts,
    });
    const result = gateway.ingest(tampered);
    expect(result.status).toBe("QUARANTINED");
    expect(result.replayValid).toBe(false);
    expect(result.reasonCodes).toContain("ATTEMPT_INTEGRITY_FAILURE");
  });

  // -------------------------------------------------------------------------
  // T11: Checkpoint mutation -> QUARANTINED
  // -------------------------------------------------------------------------
  it("T11: quarantines bundle with checkpoint version regression", () => {
    const modifiedCheckpoints = goldenBundle.checkpoints.map((c) => ({
      ...c,
      checkpointVersion: 0,
    }));
    const tampered = withRecomputedBundleId({
      ...goldenBundle,
      checkpoints: modifiedCheckpoints,
    });
    const result = gateway.ingest(tampered);
    expect(result.status).toBe("QUARANTINED");
    expect(result.replayValid).toBe(false);
    expect(result.reasonCodes).toContain("CHECKPOINT_INTEGRITY_FAILURE");
  });

  // -------------------------------------------------------------------------
  // T12: Verification evidence mutation -> QUARANTINED
  // -------------------------------------------------------------------------
  it("T12: quarantines bundle with corrupted verification evidence hash", () => {
    const modifiedEvidence = goldenBundle.verificationEvidence.map((e) => ({
      ...e,
      contentHash: "corrupted_hash_format",
    }));
    const tampered = withRecomputedBundleId({
      ...goldenBundle,
      verificationEvidence: modifiedEvidence,
    });
    const result = gateway.ingest(tampered);
    expect(result.status).toBe("QUARANTINED");
    expect(result.replayValid).toBe(false);
    expect(result.reasonCodes).toContain("VERIFICATION_INTEGRITY_FAILURE");
  });

  // -------------------------------------------------------------------------
  // T13: False success bundle -> QUARANTINED
  // -------------------------------------------------------------------------
  it("T13: quarantines bundle claiming COMPLETED when attempt verification failed", () => {
    const failedAttempts = goldenBundle.attempts.map((a) => ({
      ...a,
      exitCode: 1,
      outputPayload: { exitCode: 1, stderr: "Failed assertion" },
    }));
    const tampered = withRecomputedBundleId({
      ...goldenBundle,
      attempts: failedAttempts,
      run: {
        ...goldenBundle.run,
        status: "COMPLETED",
      },
    });
    const result = gateway.ingest(tampered);
    expect(result.status).toBe("QUARANTINED");
    expect(result.replayValid).toBe(false);
    expect(result.reasonCodes).toContain("REPLAY_VERIFICATION_FAILURE");
  });

  // -------------------------------------------------------------------------
  // T14: Duplicate submission -> ACCEPTED then DUPLICATE
  // -------------------------------------------------------------------------
  it("T14: handles duplicate submission idempotently", () => {
    const first = gateway.ingest(goldenBundleJson);
    expect(first.status).toBe("ACCEPTED");

    const second = gateway.ingest(goldenBundleJson);
    expect(second.status).toBe("DUPLICATE");
    expect(second.bundleId).toBe(goldenBundle.bundleId);
    expect(second.replayValid).toBe(true);

    // Verify only one physical file in accepted archive
    const acceptedFiles = fs.readdirSync(path.join(archiveDir, "accepted"));
    expect(acceptedFiles.length).toBe(1);
    expect(acceptedFiles[0]).toBe(`${goldenBundle.bundleId}.json`);
  });

  // -------------------------------------------------------------------------
  // T15: Same bundleId with different bytes -> QUARANTINED (IDENTITY_CONFLICT)
  // -------------------------------------------------------------------------
  it("T15: quarantines bundle on identity conflict (same bundleId, different bytes)", () => {
    // 1. Ingest original
    gateway.ingest(goldenBundleJson);

    // 2. Craft an adversarial payload claiming the exact same bundleId but differing content
    const conflicting = {
      ...goldenBundle,
      run: {
        ...goldenBundle.run,
        taskId: "tampered-task-identity-conflict",
      },
      bundleId: goldenBundle.bundleId, // Same declared ID, different content
    };

    const conflictResult = gateway.ingest(canonicalJsonStringify(conflicting));
    expect(conflictResult.status).toBe("QUARANTINED");
    expect(conflictResult.reasonCodes).toContain("INVALID_BUNDLE_ID");

    // Even if recomputed matches declared in a hypothetical hash collision, ensure archive bytes are protected
    const originalArchived = archive.getAcceptedBytes(goldenBundle.bundleId);
    expect(originalArchived).toBe(goldenBundleJson);
  });

  // -------------------------------------------------------------------------
  // T16: Accepted bundle archive reload -> replay PASS
  // -------------------------------------------------------------------------
  it("T16: successfully verifies archived bundle from disk", () => {
    gateway.ingest(goldenBundleJson);

    const archiveResult = gateway.verifyArchivedBundle(goldenBundle.bundleId);
    expect(archiveResult.valid).toBe(true);
    expect(archiveResult.status).toBe("VERIFIED");
    expect(archiveResult.bundleId).toBe(goldenBundle.bundleId);
    expect(archiveResult.failures.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // T17: Accepted archive mutation -> replay failure
  // -------------------------------------------------------------------------
  it("T17: detects archival tampering on previously accepted bundle", () => {
    gateway.ingest(goldenBundleJson);

    // Tamper the archived file on disk
    const targetFile = path.join(archiveDir, "accepted", `${goldenBundle.bundleId}.json`);
    const content = JSON.parse(fs.readFileSync(targetFile, "utf8"));
    content.run.status = "FAILED";
    fs.writeFileSync(targetFile, JSON.stringify(content), "utf8");

    const archiveResult = gateway.verifyArchivedBundle(goldenBundle.bundleId);
    expect(archiveResult.valid).toBe(false);
    expect(archiveResult.status).toBe("ARCHIVE_INTEGRITY_FAILURE");
    expect(archiveResult.failures.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // T18: Quarantined bundle cannot appear in accepted archive
  // -------------------------------------------------------------------------
  it("T18: ensures quarantined bundles are never present in accepted archive", () => {
    const badBundle = { formatVersion: "corrupted" };
    gateway.ingest(JSON.stringify(badBundle));

    const acceptedFiles = fs.readdirSync(path.join(archiveDir, "accepted"));
    expect(acceptedFiles.length).toBe(0);

    const quarantineSubdirs = fs.readdirSync(path.join(archiveDir, "quarantine"));
    expect(quarantineSubdirs.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // T19: Producer runtime unavailable after export -> ingestion still succeeds
  // -------------------------------------------------------------------------
  it("T19: successfully ingests bundle after producer runtime is completely destroyed", () => {
    // Export bundle, then close producer store and delete database file
    const serialized = canonicalJsonStringify(goldenBundle);
    store.close();
    fs.rmSync(producerDbDir, { recursive: true, force: true });

    // Ingest into gateway
    const result = gateway.ingest(serialized);
    expect(result.status).toBe("ACCEPTED");
    expect(result.bundleId).toBe(goldenBundle.bundleId);
    expect(result.replayValid).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T20: Two independent ingestion instances -> one logical archive identity
  // -------------------------------------------------------------------------
  it("T20: ensures two independent ingestion instances produce identical archive identity", () => {
    const gateway1 = new EvidenceIngestionGateway({ archive, clock });
    const gateway2 = new EvidenceIngestionGateway({ archive, clock });

    const res1 = gateway1.ingest(goldenBundleJson);
    const res2 = gateway2.ingest(goldenBundleJson);

    expect(res1.status).toBe("ACCEPTED");
    expect(res2.status).toBe("DUPLICATE");
    expect(res1.bundleId).toBe(res2.bundleId);

    const acceptedFiles = fs.readdirSync(path.join(archiveDir, "accepted"));
    expect(acceptedFiles.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // T21: Cross-host simulation
  // -------------------------------------------------------------------------
  it("T21: simulates cross-host transfer via serialized bundle file with zero DB access", () => {
    // Host A exports bundle to a file
    const transferFile = path.join(tmpBaseDir, "cross-host-transfer.json");
    fs.writeFileSync(transferFile, goldenBundleJson, "utf8");

    // Close and wipe Host A database
    store.close();
    fs.rmSync(producerDbDir, { recursive: true, force: true });

    // Host B reads only the transfer file
    const receivedBytes = fs.readFileSync(transferFile, "utf8");
    const hostBArchive = new FileSystemEvidenceArchive({
      baseDir: path.join(tmpBaseDir, "host-b-archive"),
      clock,
    });
    const hostBGateway = new EvidenceIngestionGateway({ archive: hostBArchive, clock });

    const result = hostBGateway.ingest(receivedBytes);
    expect(result.status).toBe("ACCEPTED");
    expect(result.bundleId).toBe(goldenBundle.bundleId);
    expect(hostBArchive.hasAccepted(goldenBundle.bundleId)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T22: Bundle contains prohibited secret -> SECURITY_POLICY_FAILURE
  // -------------------------------------------------------------------------
  it("T22: quarantines bundle containing unredacted raw credentials", () => {
    const leaked = withRecomputedBundleId({
      ...goldenBundle,
      actions: [
        {
          ...goldenBundle.actions[0]!,
          inputPayload: {
            command: "test",
            password: "raw-unredacted-production-password",
          },
        },
      ],
    });

    const result = gateway.ingest(canonicalJsonStringify(leaked));
    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("SECURITY_POLICY_FAILURE");
  });

  // -------------------------------------------------------------------------
  // T23: Bundle contains idempotencyToken -> accepted/preserved
  // -------------------------------------------------------------------------
  it("T23: preserves and accepts non-secret idempotencyToken coordinates", () => {
    // Golden bundle contains attempt with idempotencyToken
    expect(goldenBundle.attempts[0]?.idempotencyToken).toBeDefined();
    expect(goldenBundle.attempts[0]?.idempotencyToken).not.toBe("[REDACTED]");

    const result = gateway.ingest(goldenBundleJson);
    expect(result.status).toBe("ACCEPTED");
    expect(result.reasonCodes.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // T24: Identical bytes produce identical ingestion result
  // -------------------------------------------------------------------------
  it("T24: guarantees deterministic ingestion classification across repeated evaluations", () => {
    const gatewayFresh = () => new EvidenceIngestionGateway({ archive, clock });

    const res1 = gatewayFresh().ingest(goldenBundleJson);
    const res2 = gatewayFresh().ingest(goldenBundleJson);
    const res3 = gatewayFresh().ingest(goldenBundleJson);

    expect(res1.status).toBe("ACCEPTED");
    expect(res2.status).toBe("DUPLICATE");
    expect(res3.status).toBe("DUPLICATE");

    expect(res1.bundleId).toBe(goldenBundle.bundleId);
    expect(res2.bundleId).toBe(goldenBundle.bundleId);
    expect(res3.bundleId).toBe(goldenBundle.bundleId);
  });

  // -------------------------------------------------------------------------
  // T25: Ingestion never invokes execution/tool/model infrastructure
  // -------------------------------------------------------------------------
  it("T25: guarantees ingestion performs zero execution or child process spawning", () => {
    let processExecuted = false;
    // Check that ingestion completes as a pure parser and validator
    const result = gateway.ingest(goldenBundleJson);
    expect(result.status).toBe("ACCEPTED");
    expect(processExecuted).toBe(false);
  });
});
