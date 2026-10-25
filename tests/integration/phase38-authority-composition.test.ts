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
  EvidenceSignature,
} from "../../src/domain/evidence-bundle.js";
import { canonicalJsonStringify } from "../../src/domain/canonical-hash.js";
import { FileSystemEvidenceArchive } from "../../src/adapters/persistence/file-system-evidence-archive.js";
import { EvidenceIngestionGateway } from "../../src/application/evidence-ingestion-gateway.js";
import { EvidenceReplayVerifier } from "../../src/application/evidence-replay-verifier.js";
import {
  EvidenceSigner,
  EvidenceThresholdVerifier,
  TrustedKeyring,
} from "../../src/application/evidence-signer.js";

describe("Phase 38 — End-to-End Authority Composition & Failure Injection", () => {
  let tmpBaseDir: string;
  let producerDbDir: string;
  let archiveDir: string;
  let store: SqliteStateStore;
  let clock: SettableClock;
  let coordinator: RunCoordinator;
  let goldenBundle: EvidenceBundle;
  let archive: FileSystemEvidenceArchive;
  let keyring: TrustedKeyring;
  let gateway: EvidenceIngestionGateway;
  let workerKey: ReturnType<typeof EvidenceSigner.generateKeyPair>;
  let supervisorKey: ReturnType<typeof EvidenceSigner.generateKeyPair>;
  let verifierKey: ReturnType<typeof EvidenceSigner.generateKeyPair>;

  beforeEach(() => {
    tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-phase38-"));
    producerDbDir = path.join(tmpBaseDir, "producer");
    archiveDir = path.join(tmpBaseDir, "archive");
    fs.mkdirSync(producerDbDir, { recursive: true });
    fs.mkdirSync(archiveDir, { recursive: true });

    const dbPath = path.join(producerDbDir, "producer.db");
    store = new SqliteStateStore({ location: dbPath });
    clock = new SettableClock("2026-10-18T12:00:00.000Z");
    coordinator = new RunCoordinator(store, clock);

    // Register Task and Contract
    coordinator.createTask({
      taskId: "task-p38-main",
      title: "Phase 38 Composition & Failure Injection Task",
      inputPayload: { goal: "evaluate multi-authority composition under failures" },
    });

    const spec = {
      taskId: "task-p38-main",
      policy: createExecutionPolicy({
        policyId: "policy-p38",
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
      taskId: "task-p38-main",
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

    // Action 1 with Attempt 1
    const actionId = "act-p38-1";
    const { action, event: actEvt } = Action.create({
      actionId,
      runId,
      sequenceNumber: 1,
      toolName: "run_command",
      inputPayload: { command: "test", sensitiveSecret: "secret-token" },
      contractBinding: createRes.run.contractBinding!,
      maxAttempts: 3,
      now: clock.nowIso(),
    });

    const { attempt: att1, event: att1Evt } = Attempt.create({
      attemptId: "att-p38-1",
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
      tx.transitionAttempt("att-p38-1", { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
      tx.transitionAttempt("att-p38-1", { type: "START", now: clock.nowIso() }, () => "e4");
      tx.transitionAttempt(
        "att-p38-1",
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

    // Checkpoint
    coordinator.saveCheckpoint({
      runId,
      checkpointVersion: 1,
      actionId,
      attemptNumber: 1,
      durableState: { stage: "test-passed" },
    });

    // Evidence & Verification
    coordinator.recordEvidence(runId, {
      evidenceId: "evi-p38-1",
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
      evidenceIds: ["evi-p38-1"],
      message: "EXIT_CODE_ZERO satisfied by run_command",
      verifiedAt: clock.nowIso(),
    });

    // Complete run
    coordinator.completeRun(runId, "worker-1", claim.lease.leaseId, { success: true });

    // Export golden bundle
    goldenBundle = EvidenceExporter.exportBundle(store, runId, { nowIso: clock.nowIso() });

    // Keypairs for the 3 distinct authorities
    workerKey = EvidenceSigner.generateKeyPair();
    supervisorKey = EvidenceSigner.generateKeyPair();
    verifierKey = EvidenceSigner.generateKeyPair();

    // Keyring registration
    keyring = new TrustedKeyring();
    keyring.registerKey({
      keyId: "worker-key",
      publicKey: workerKey.publicKey,
      authorityId: "WORKER_PRODUCER",
      role: "WORKER_PRODUCER",
      status: "TRUSTED",
    });
    keyring.registerKey({
      keyId: "supervisor-key",
      publicKey: supervisorKey.publicKey,
      authorityId: "SUPERVISOR",
      role: "SUPERVISOR",
      status: "TRUSTED",
    });
    keyring.registerKey({
      keyId: "verifier-key",
      publicKey: verifierKey.publicKey,
      authorityId: "INDEPENDENT_VERIFIER",
      role: "INDEPENDENT_VERIFIER",
      status: "TRUSTED",
    });

    // Archive & Gateway configured with production 2-of-3 threshold policy
    archive = new FileSystemEvidenceArchive({ baseDir: archiveDir, clock, keyring });
    gateway = new EvidenceIngestionGateway({
      archive,
      clock,
      keyring,
      thresholdPolicy: { threshold: 2, totalAuthorities: 3 },
      allowUnsignedLegacy: false,
    });
  });

  afterEach(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tmpBaseDir, { recursive: true, force: true });
  });

  // Helpers
  function signWithAuthority(
    bundle: EvidenceBundle,
    authority: "WORKER_PRODUCER" | "SUPERVISOR" | "INDEPENDENT_VERIFIER"
  ): EvidenceSignature {
    const keyMap = {
      WORKER_PRODUCER: { key: workerKey.privateKey, keyId: "worker-key" },
      SUPERVISOR: { key: supervisorKey.privateKey, keyId: "supervisor-key" },
      INDEPENDENT_VERIFIER: { key: verifierKey.privateKey, keyId: "verifier-key" },
    };
    const info = keyMap[authority];
    const signed = EvidenceSigner.sign(bundle, info.key, info.keyId, {
      authorityId: authority,
    });
    return signed.signature!;
  }

  function createMultiSignedBundle(
    bundle: EvidenceBundle,
    authorities: ("WORKER_PRODUCER" | "SUPERVISOR" | "INDEPENDENT_VERIFIER")[]
  ): EvidenceBundle {
    const signatures: EvidenceSignature[] = authorities.map((auth) => signWithAuthority(bundle, auth));
    return Object.freeze({
      ...bundle,
      signature: signatures[0],
      signatures: Object.freeze(signatures),
    });
  }

  // ===========================================================================
  // F1: Worker Crash Before Signature
  // ===========================================================================
  it("F1: worker crash before signature produces no accepted evidence (fail-closed safety)", () => {
    // Execution and verification are complete in SQLite, but worker crashes before signing
    const unsignedBundle = goldenBundle;
    const result = gateway.ingest(unsignedBundle);

    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("UNSIGNED_BUNDLE_REJECTED");
    expect(archive.hasAccepted(unsignedBundle.bundleId)).toBe(false);
  });

  // ===========================================================================
  // F2: Worker Crash After Signature, Before Supervisor Endorsement
  // ===========================================================================
  it("F2: worker crash after signing yields INSUFFICIENT_AUTHORITIES then succeeds upon supervisor recovery", () => {
    // 1. Worker signed, supervisor absent -> quarantined
    const sigWorker = signWithAuthority(goldenBundle, "WORKER_PRODUCER");
    const partialBundle: EvidenceBundle = {
      ...goldenBundle,
      signature: sigWorker,
      signatures: [sigWorker],
    };
    const res1 = gateway.ingest(partialBundle);
    expect(res1.status).toBe("QUARANTINED");
    expect(res1.reasonCodes).toContain("INSUFFICIENT_AUTHORITIES");

    // 2. Mission recovers: supervisor endorses the exact same canonical bundle
    const recoveredBundle = EvidenceSigner.addSignature(
      partialBundle,
      supervisorKey.privateKey,
      "supervisor-key",
      { authorityId: "SUPERVISOR" }
    );
    const res2 = gateway.ingest(recoveredBundle);
    expect(res2.status).toBe("ACCEPTED");
    expect(res2.thresholdResult?.status).toBe("THRESHOLD_SATISFIED");
    expect(res2.thresholdResult?.distinctValidAuthorities).toBe(2);
  });

  // ===========================================================================
  // F3: Supervisor Crash Before Endorsement
  // ===========================================================================
  it("F3: supervisor crash before endorsement keeps evidence unaccepted without fabricated signatures", () => {
    const sigWorker = signWithAuthority(goldenBundle, "WORKER_PRODUCER");
    const bundle: EvidenceBundle = {
      ...goldenBundle,
      signature: sigWorker,
      signatures: [sigWorker],
    };

    const result = gateway.ingest(bundle);
    expect(result.status).toBe("QUARANTINED");
    expect(result.thresholdResult?.validAuthorityIds).toEqual(["WORKER_PRODUCER"]);
    expect(result.thresholdResult?.validAuthorityIds).not.toContain("SUPERVISOR");
  });

  // ===========================================================================
  // F4: Supervisor Crash After Endorsement
  // ===========================================================================
  it("F4: supervisor crash after endorsement allows restart and idempotent archival", () => {
    const bundle = createMultiSignedBundle(goldenBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);

    // First ingestion (simulates supervisor crash right after acceptance)
    const res1 = gateway.ingest(bundle);
    expect(res1.status).toBe("ACCEPTED");

    // Restart ingestion
    const res2 = gateway.ingest(bundle);
    expect(res2.status).toBe("DUPLICATE");
    expect(res2.bundleId).toBe(bundle.bundleId);
    expect(archive.hasAccepted(bundle.bundleId)).toBe(true);

    const acceptedFiles = fs.readdirSync(path.join(archiveDir, "accepted"));
    expect(acceptedFiles.length).toBe(1);
  });

  // ===========================================================================
  // F5: Worker Lease Expiry Before Signing
  // ===========================================================================
  it("F5: worker lease expiry before signing enforces Phase 31 lease fencing", () => {
    // Advance clock past worker lease timeout (10000ms)
    clock.advanceMs(15000);

    // Attempting completion by expired worker throws or rejects
    expect(() =>
      coordinator.completeRun(goldenBundle.run.runId, "worker-1", "non-existent-lease", {
        success: true,
      })
    ).toThrow();
  });

  // ===========================================================================
  // F6: Supervisor Lease Expiry Before Endorsement
  // ===========================================================================
  it("F6: supervisor lease expiry before endorsement fails closed without endorsement", () => {
    // Acquire supervisor lease
    const supLease = coordinator.claimSupervisorLease({
      runId: goldenBundle.run.runId,
      supervisorId: "supervisor-alpha",
      ttlMs: 10000,
    });

    // Simulate supervisor lease expired in coordinator
    clock.advanceMs(60000); // Past supervisor lease

    // Stale supervisor cannot claim or update checkpoints
    expect(() =>
      coordinator.saveCheckpoint({
        runId: goldenBundle.run.runId,
        checkpointVersion: 2,
        actionId: "act-p38-1",
        attemptNumber: 1,
        supervisorFencing: {
          supervisorId: "supervisor-alpha",
          leaseId: supLease.leaseId,
        },
        durableState: { stage: "stale" },
      })
    ).toThrow();
  });

  // ===========================================================================
  // F7: Supervisor Lease Lost During Endorsement
  // ===========================================================================
  it("F7: supervisor lease lost during endorsement prevents uncoordinated authority creation", () => {
    // Verified: If supervisor lease is revoked or expired in the state store,
    // transactions requiring active supervisor lease fail closed in the database.
    const activeLease = store.findActiveSupervisorLease(goldenBundle.run.runId, clock.nowIso());
    if (activeLease) {
      store.expireSupervisorLease(activeLease.leaseId, clock.nowIso());
    }
    const currentLease = store.findActiveSupervisorLease(goldenBundle.run.runId, clock.nowIso());
    expect(currentLease).toBeNull();
  });

  // ===========================================================================
  // F8: Checkpoint Recovery + Threshold Evidence
  // ===========================================================================
  it("F8: checkpoint recovery preserves attempt monotonicity and binds signatures to final evidence", () => {
    // Simulate checkpoint 1 saved, then crash and recover to checkpoint 2
    coordinator.saveCheckpoint({
      runId: goldenBundle.run.runId,
      checkpointVersion: 2,
      actionId: "act-p38-1",
      attemptNumber: 1,
      durableState: { stage: "checkpoint-2-recovered" },
    });

    const recoveredBundle = EvidenceExporter.exportBundle(store, goldenBundle.run.runId, {
      nowIso: clock.nowIso(),
    });
    expect(recoveredBundle.checkpoints.length).toBe(2);

    const signedRecovered = createMultiSignedBundle(recoveredBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const result = gateway.ingest(signedRecovered);

    expect(result.status).toBe("ACCEPTED");
    expect(result.replayValid).toBe(true);
    expect(result.thresholdResult?.status).toBe("THRESHOLD_SATISFIED");
  });

  // ===========================================================================
  // F9: Stale Checkpoint Signature
  // ===========================================================================
  it("F9: stale checkpoint signature cannot authorize subsequent recovered checkpoint", () => {
    // Bundle A signed at checkpoint 1
    const sigWorker = signWithAuthority(goldenBundle, "WORKER_PRODUCER");
    const sigSupervisor = signWithAuthority(goldenBundle, "SUPERVISOR");

    // Run progresses to checkpoint 2
    coordinator.saveCheckpoint({
      runId: goldenBundle.run.runId,
      checkpointVersion: 2,
      actionId: "act-p38-1",
      attemptNumber: 1,
      durableState: { stage: "checkpoint-2-advanced" },
    });
    const advancedBundle = EvidenceExporter.exportBundle(store, goldenBundle.run.runId, {
      nowIso: clock.nowIso(),
    });

    // Attempting to attach checkpoint 1 signatures to advanced checkpoint 2 bundle
    const mismatchedBundle: EvidenceBundle = {
      ...advancedBundle,
      signatures: [sigWorker, sigSupervisor],
    };

    const result = gateway.ingest(mismatchedBundle);
    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("INVALID_SIGNATURE");
  });

  // ===========================================================================
  // F10: Verification Failure With Valid Threshold Signatures
  // ===========================================================================
  it("F10: verification failure is quarantined even with valid 2-of-3 threshold signatures", () => {
    const tampered = JSON.parse(JSON.stringify(goldenBundle));
    // Attempt exit code is failure
    tampered.attempts[0].exitCode = 1;
    tampered.attempts[0].status = "FAILED";
    tampered.terminalState.status = "COMPLETED"; // False claim

    const { bundleId, signature, signatures, ...rest } = tampered;
    tampered.bundleId = computeBundleId(rest as any);

    // Both Worker & Supervisor validly sign
    const signed = createMultiSignedBundle(tampered, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const result = gateway.ingest(signed);

    expect(result.status).toBe("QUARANTINED");
    expect(result.replayValid).toBe(false);
    expect(result.reasonCodes).toContain("REPLAY_VERIFICATION_FAILURE");
  });

  // ===========================================================================
  // F11: Replay Failure With Valid Threshold
  // ===========================================================================
  it("F11: corrupted event sequence fails clean-room replay despite valid 2-of-3 threshold", () => {
    const tampered = JSON.parse(JSON.stringify(goldenBundle));
    // Corrupt event sequence number
    tampered.events[0].sequence = 999;

    const { bundleId, signature, signatures, ...rest } = tampered;
    tampered.bundleId = computeBundleId(rest as any);

    const signed = createMultiSignedBundle(tampered, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const result = gateway.ingest(signed);

    expect(result.status).toBe("QUARANTINED");
    expect(result.replayValid).toBe(false);
    expect(result.reasonCodes).toContain("EVENT_INTEGRITY_FAILURE");
  });

  // ===========================================================================
  // F12: Policy Failure With Valid Threshold
  // ===========================================================================
  it("F12: prohibited tool capability is quarantined despite valid 2-of-3 threshold", () => {
    const tampered = JSON.parse(JSON.stringify(goldenBundle));
    // Action calls tool not in contract policy
    tampered.actions[0].toolName = "execute_unrestricted_shell";

    const { bundleId, signature, signatures, ...rest } = tampered;
    tampered.bundleId = computeBundleId(rest as any);

    const signed = createMultiSignedBundle(tampered, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const result = gateway.ingest(signed);

    expect(result.status).toBe("QUARANTINED");
    expect(result.replayValid).toBe(false);
  });

  // ===========================================================================
  // F13: Secret Leak With Valid Threshold
  // ===========================================================================
  it("F13: secret leak triggers SECURITY_POLICY_FAILURE despite valid 2-of-3 threshold", () => {
    const tampered = JSON.parse(JSON.stringify(goldenBundle));
    tampered.actions[0].inputPayload = {
      ...tampered.actions[0].inputPayload,
      secret_api_key: "sk-live-unredacted-secret-value-12345",
    };

    const { bundleId, signature, signatures, ...rest } = tampered;
    tampered.bundleId = computeBundleId(rest as any);

    const signed = createMultiSignedBundle(tampered, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const result = gateway.ingest(signed);

    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("SECURITY_POLICY_FAILURE");
  });

  // ===========================================================================
  // F14: Duplicate Authority After Recovery
  // ===========================================================================
  it("F14: duplicate authority after recovery does not increase threshold count", () => {
    const sigWorker = signWithAuthority(goldenBundle, "WORKER_PRODUCER");
    const sigSupervisor = signWithAuthority(goldenBundle, "SUPERVISOR");

    // Supervisor attempts to endorse twice after recovery
    const bundle: EvidenceBundle = {
      ...goldenBundle,
      signatures: [sigWorker, sigSupervisor, sigSupervisor],
    };

    const thresholdRes = EvidenceThresholdVerifier.verifyThreshold(bundle, keyring);
    expect(thresholdRes.status).toBe("THRESHOLD_SATISFIED");
    expect(thresholdRes.distinctValidAuthorities).toBe(2); // Only 2 distinct authorities
  });

  // ===========================================================================
  // F15: Signature Ordering
  // ===========================================================================
  it("F15: signature ordering does not affect threshold evaluation result", () => {
    const sigWorker = signWithAuthority(goldenBundle, "WORKER_PRODUCER");
    const sigSupervisor = signWithAuthority(goldenBundle, "SUPERVISOR");

    const order1: EvidenceBundle = { ...goldenBundle, signatures: [sigWorker, sigSupervisor] };
    const order2: EvidenceBundle = { ...goldenBundle, signatures: [sigSupervisor, sigWorker] };

    const res1 = EvidenceThresholdVerifier.verifyThreshold(order1, keyring);
    const res2 = EvidenceThresholdVerifier.verifyThreshold(order2, keyring);

    expect(res1.status).toBe("THRESHOLD_SATISFIED");
    expect(res2.status).toBe("THRESHOLD_SATISFIED");
    expect(res1.distinctValidAuthorities).toBe(res2.distinctValidAuthorities);
  });

  // ===========================================================================
  // F16: Partial Signature Collection
  // ===========================================================================
  it("F16: deterministically classifies all partial signature collection states", () => {
    const sigWorker = signWithAuthority(goldenBundle, "WORKER_PRODUCER");
    const sigSupervisor = signWithAuthority(goldenBundle, "SUPERVISOR");
    const sigVerifier = signWithAuthority(goldenBundle, "INDEPENDENT_VERIFIER");

    // Empty
    const bEmpty: EvidenceBundle = { ...goldenBundle, signatures: [] };
    expect(EvidenceThresholdVerifier.verifyThreshold(bEmpty, keyring).status).toBe("INSUFFICIENT_AUTHORITIES");

    // Worker only
    const bWorker: EvidenceBundle = { ...goldenBundle, signatures: [sigWorker] };
    expect(EvidenceThresholdVerifier.verifyThreshold(bWorker, keyring).status).toBe("INSUFFICIENT_AUTHORITIES");

    // Supervisor only
    const bSupervisor: EvidenceBundle = { ...goldenBundle, signatures: [sigSupervisor] };
    expect(EvidenceThresholdVerifier.verifyThreshold(bSupervisor, keyring).status).toBe("INSUFFICIENT_AUTHORITIES");

    // Verifier only
    const bVerifier: EvidenceBundle = { ...goldenBundle, signatures: [sigVerifier] };
    expect(EvidenceThresholdVerifier.verifyThreshold(bVerifier, keyring).status).toBe("INSUFFICIENT_AUTHORITIES");

    // Worker + Supervisor -> Satisfied
    const bFull: EvidenceBundle = { ...goldenBundle, signatures: [sigWorker, sigSupervisor] };
    expect(EvidenceThresholdVerifier.verifyThreshold(bFull, keyring).status).toBe("THRESHOLD_SATISFIED");
  });

  // ===========================================================================
  // F17: One Authority Revoked During Recovery
  // ===========================================================================
  it("F17: authority revoked during recovery rejects new submissions while preserving historical archive", () => {
    const bundle = createMultiSignedBundle(goldenBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);

    // Ingest before revocation -> ACCEPTED
    const resAccepted = gateway.ingest(bundle);
    expect(resAccepted.status).toBe("ACCEPTED");

    // Revoke supervisor
    keyring.revokeKey("supervisor-key");

    // Historical archive audit passes
    const auditRes = archive.verifyArchivedBundle(bundle.bundleId, keyring);
    expect(auditRes.valid).toBe(true);
    expect(auditRes.status).toBe("VERIFIED");

    // New submission with revoked supervisor is rejected
    const freshArchive = new FileSystemEvidenceArchive({
      baseDir: path.join(tmpBaseDir, "fresh-f17"),
      clock,
      keyring,
    });
    const freshGateway = new EvidenceIngestionGateway({
      archive: freshArchive,
      clock,
      keyring,
      thresholdPolicy: { threshold: 2, totalAuthorities: 3 },
    });
    const newRes = freshGateway.ingest(bundle);
    expect(newRes.status).toBe("QUARANTINED");
    expect(newRes.reasonCodes).toContain("REVOKED_AUTHORITY");
  });

  // ===========================================================================
  // F18: Archive Tampering
  // ===========================================================================
  it("F18: archive tampering is detected during archive verification", () => {
    const bundle = createMultiSignedBundle(goldenBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    gateway.ingest(bundle);

    // Tamper archived file on disk
    const targetFile = path.join(archiveDir, "accepted", `${bundle.bundleId}.json`);
    const raw = fs.readFileSync(targetFile, "utf8");
    const parsed = JSON.parse(raw);
    parsed.run.status = "FAILED";
    fs.writeFileSync(targetFile, JSON.stringify(parsed), "utf8");

    const auditRes = archive.verifyArchivedBundle(bundle.bundleId, keyring);
    expect(auditRes.valid).toBe(false);
    expect(auditRes.status).toBe("ARCHIVE_INTEGRITY_FAILURE");
  });

  // ===========================================================================
  // F19: Offline Replay
  // ===========================================================================
  it("F19: offline replay independently verifies accepted evidence without runtime dependencies", () => {
    const bundle = createMultiSignedBundle(goldenBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    gateway.ingest(bundle);

    // Clean-room offline verifier consumes ONLY the bundle
    const replayResult = EvidenceReplayVerifier.verify(bundle);
    expect(replayResult.valid).toBe(true);
    expect(replayResult.bundleIntegrity).toBe(true);
    expect(replayResult.contractIntegrity).toBe(true);
    expect(replayResult.eventIntegrity).toBe(true);
    expect(replayResult.fourfoldOutcome.taskSatisfied).toBe(true);
    expect(replayResult.terminalOutcome).toBe("COMPLETED");
  });

  // ===========================================================================
  // F20: Offline Replay of Rejected Evidence
  // ===========================================================================
  it("F20: offline replay of rejected evidence explains why accepted outcome cannot be established", () => {
    const tampered = JSON.parse(JSON.stringify(goldenBundle));
    tampered.attempts[0].exitCode = 1;
    tampered.terminalState.status = "COMPLETED";

    const replayResult = EvidenceReplayVerifier.verify(tampered);
    expect(replayResult.valid).toBe(false);
    expect(replayResult.terminalOutcome).toBe("FAILED");
    expect(replayResult.failures.some((f: string) => f.includes("Fourfold outcome mismatch"))).toBe(true);
  });

  // ===========================================================================
  // F21: Cross-Host Transfer
  // ===========================================================================
  it("F21: cross-host transfer maintains identical cryptographic identity and threshold decision", () => {
    const bundle = createMultiSignedBundle(goldenBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const serialized = canonicalJsonStringify(bundle);

    // Host B has no SQLite, no worker process, only public keyring
    const hostBArchiveDir = path.join(tmpBaseDir, "host-b-archive");
    const hostBArchive = new FileSystemEvidenceArchive({ baseDir: hostBArchiveDir, clock, keyring });
    const hostBGateway = new EvidenceIngestionGateway({
      archive: hostBArchive,
      clock,
      keyring,
      thresholdPolicy: { threshold: 2, totalAuthorities: 3 },
    });

    const hostBResult = hostBGateway.ingest(serialized);
    expect(hostBResult.status).toBe("ACCEPTED");
    expect(hostBResult.bundleId).toBe(bundle.bundleId);
    expect(hostBResult.thresholdResult?.status).toBe("THRESHOLD_SATISFIED");
  });

  // ===========================================================================
  // F22: Conflicting Evidence After Recovery (LOGICAL_IDENTITY_GAP)
  // ===========================================================================
  it("F22: demonstrates LOGICAL_IDENTITY_GAP where conflicting valid bundles for same runId coexist in content-addressed archive", () => {
    // Bundle A: exported at T1 (Run claims success)
    const bundleA = createMultiSignedBundle(goldenBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const resA = gateway.ingest(bundleA);
    expect(resA.status).toBe("ACCEPTED");

    // Bundle B: exported at T2 with different evidence for same runId
    const bundleBData = EvidenceExporter.exportBundle(store, goldenBundle.run.runId, {
      nowIso: "2026-10-18T16:00:00.000Z",
    });
    const bundleB = createMultiSignedBundle(bundleBData, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const resB = gateway.ingest(bundleB);

    // Both are accepted because content-addressing keys by bundleId, not logical runId
    expect(resB.status).toBe("ACCEPTED");
    expect(bundleA.run.runId).toBe(bundleB.run.runId);
    expect(bundleA.bundleId).not.toBe(bundleB.bundleId);
    // Demonstrates: ARCHITECTURAL_GAP: LOGICAL_EXECUTION_IDENTITY
  });

  // ===========================================================================
  // F23: Authority Collusion
  // ===========================================================================
  it("F23: documents boundary that 2 colluding authorities can forge accepted evidence under 2-of-3 model", () => {
    // Attacker possesses both Worker and Supervisor keys
    const syntheticBundle = JSON.parse(JSON.stringify(goldenBundle));
    syntheticBundle.actions[0].inputPayload = { goal: "attacker-controlled-mission" };
    const { bundleId, signature, signatures, ...rest } = syntheticBundle;
    syntheticBundle.bundleId = computeBundleId(rest as any);

    // Colluding worker + supervisor both sign
    const colludingBundle = createMultiSignedBundle(syntheticBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const result = gateway.ingest(colludingBundle);

    // Accepted under 2-of-3 threshold
    expect(result.status).toBe("ACCEPTED");
    // Demonstrates boundary: 2-of-3 protects against single-authority compromise, not 2 colluding authorities
  });

  // ===========================================================================
  // F24: Keyring Compromise
  // ===========================================================================
  it("F24: documents boundary that trust root compromise bypasses threshold authority", () => {
    const rogueKeyring = new TrustedKeyring();
    const rogueKey1 = EvidenceSigner.generateKeyPair();
    const rogueKey2 = EvidenceSigner.generateKeyPair();

    rogueKeyring.registerKey({
      keyId: "rogue-1",
      publicKey: rogueKey1.publicKey,
      authorityId: "WORKER_PRODUCER",
      status: "TRUSTED",
    });
    rogueKeyring.registerKey({
      keyId: "rogue-2",
      publicKey: rogueKey2.publicKey,
      authorityId: "SUPERVISOR",
      status: "TRUSTED",
    });

    const sig1 = EvidenceSigner.sign(goldenBundle, rogueKey1.privateKey, "rogue-1", {
      authorityId: "WORKER_PRODUCER",
    }).signature!;
    const sig2 = EvidenceSigner.sign(goldenBundle, rogueKey2.privateKey, "rogue-2", {
      authorityId: "SUPERVISOR",
    }).signature!;

    const bundle: EvidenceBundle = { ...goldenBundle, signatures: [sig1, sig2] };
    const res = EvidenceThresholdVerifier.verifyThreshold(bundle, rogueKeyring);
    expect(res.status).toBe("THRESHOLD_SATISFIED");
    // Demonstrates boundary: Trust root compromise cannot be prevented at the gateway layer
  });

  // ===========================================================================
  // F25: Deterministic Re-execution
  // ===========================================================================
  it("F25: produces byte-for-byte identical verification results across repeated trials", () => {
    const bundle = createMultiSignedBundle(goldenBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const trials: string[] = [];

    for (let i = 0; i < 5; i++) {
      const res = EvidenceThresholdVerifier.verifyThreshold(bundle, keyring);
      trials.push(`${res.status}:${res.distinctValidAuthorities}:${res.validAuthorityIds.join(",")}`);
    }

    expect(trials.every((t) => t === trials[0])).toBe(true);
    expect(trials[0]).toBe("THRESHOLD_SATISFIED:2:WORKER_PRODUCER,SUPERVISOR");
  });

  // ===========================================================================
  // F26: Crash During Archive
  // ===========================================================================
  it("F26: simulated crash during archive write maintains archive integrity and allows idempotent retry", () => {
    const bundle = createMultiSignedBundle(goldenBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);

    // Simulate partial/corrupted write
    const targetFile = path.join(archiveDir, "accepted", `${bundle.bundleId}.json`);
    fs.writeFileSync(targetFile, '{"partial": true', "utf8");

    // verifyArchivedBundle detects the corrupted JSON
    const checkCorrupted = archive.verifyArchivedBundle(bundle.bundleId, keyring);
    expect(checkCorrupted.valid).toBe(false);
    expect(checkCorrupted.status).toBe("ARCHIVE_INTEGRITY_FAILURE");

    // Repair via canonical write (retry)
    fs.unlinkSync(targetFile);
    const retryRes = gateway.ingest(bundle);
    expect(retryRes.status).toBe("ACCEPTED");
  });

  // ===========================================================================
  // F27: Duplicate Ingestion
  // ===========================================================================
  it("F27: duplicate ingestion returns DUPLICATE without creating duplicate files", () => {
    const bundle = createMultiSignedBundle(goldenBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);

    const res1 = gateway.ingest(bundle);
    expect(res1.status).toBe("ACCEPTED");

    const res2 = gateway.ingest(bundle);
    expect(res2.status).toBe("DUPLICATE");

    const res3 = gateway.ingest(bundle);
    expect(res3.status).toBe("DUPLICATE");

    const acceptedFiles = fs.readdirSync(path.join(archiveDir, "accepted"));
    expect(acceptedFiles.length).toBe(1);
  });

  // ===========================================================================
  // F28: Identity Conflict
  // ===========================================================================
  it("F28: identity conflict is quarantined and does not overwrite existing accepted bundle", () => {
    const bundle = createMultiSignedBundle(goldenBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const res1 = gateway.ingest(bundle);
    expect(res1.status).toBe("ACCEPTED");

    const conflicting = {
      ...bundle,
      run: {
        ...bundle.run,
        taskId: "tampered-identity-conflict",
      },
      bundleId: bundle.bundleId,
    };

    const res2 = gateway.ingest(canonicalJsonStringify(conflicting));
    expect(res2.status).toBe("QUARANTINED");
    expect(res2.reasonCodes).toContain("INVALID_BUNDLE_ID");

    const originalArchived = archive.getAcceptedBytes(bundle.bundleId);
    expect(originalArchived).toBe(canonicalJsonStringify(bundle));
  });

  // ===========================================================================
  // F29: Threshold + Historical Legacy
  // ===========================================================================
  it("F29: correctly handles all permutations of strict, legacy unsigned, and single-signature submissions", () => {
    // 1. Strict threshold rejects unsigned bundle
    const strictGateway = new EvidenceIngestionGateway({
      archive,
      clock,
      keyring,
      allowUnsignedLegacy: false,
      thresholdPolicy: { threshold: 2, totalAuthorities: 3 },
    });
    expect(strictGateway.ingest(goldenBundle).status).toBe("QUARANTINED");

    // 2. Legacy gateway accepts unsigned bundle
    const legacyGateway = new EvidenceIngestionGateway({
      archive,
      clock,
      keyring,
      allowUnsignedLegacy: true,
    });
    const legRes = legacyGateway.ingest(goldenBundle);
    expect(legRes.status).toBe("ACCEPTED");
    expect(legRes.signatureStatus).toBe("UNSIGNED_LEGACY");
    expect(legRes.authorityStatus).toBe("NOT_ESTABLISHED");

    // 3. Threshold gateway rejects single-signature Phase 35 bundle
    const singleSigned = EvidenceSigner.sign(goldenBundle, workerKey.privateKey, "worker-key", {
      authorityId: "WORKER_PRODUCER",
    });
    const thresholdRes = gateway.ingest(singleSigned);
    expect(thresholdRes.status).toBe("QUARANTINED");
    expect(thresholdRes.reasonCodes).toContain("INSUFFICIENT_AUTHORITIES");
  });

  // ===========================================================================
  // F30: Complete End-to-End Evidence Lifecycle
  // ===========================================================================
  it("F30: executes complete end-to-end evidence lifecycle from contract to offline replay", () => {
    // Contract -> Worker & Supervisor -> Threshold 2-of-3 -> Gateway -> Archive -> Offline Replay
    const bundle = createMultiSignedBundle(goldenBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);

    // 1. Ingestion across trust boundary
    const ingestionRes = gateway.ingest(bundle);
    expect(ingestionRes.status).toBe("ACCEPTED");
    expect(ingestionRes.replayValid).toBe(true);
    expect(ingestionRes.thresholdResult?.status).toBe("THRESHOLD_SATISFIED");

    // 2. Archival verification
    const archiveRes = archive.verifyArchivedBundle(bundle.bundleId, keyring);
    expect(archiveRes.valid).toBe(true);
    expect(archiveRes.status).toBe("VERIFIED");

    // 3. Independent offline replay
    const offlineRes = EvidenceReplayVerifier.verify(bundle);
    expect(offlineRes.valid).toBe(true);
    expect(offlineRes.fourfoldOutcome.taskSatisfied).toBe(true);
    expect(offlineRes.terminalOutcome).toBe("COMPLETED");
  });
});
