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
  computeProvenanceRoot,
  EvidenceBundle,
  EvidenceSignature,
} from "../../src/domain/evidence-bundle.js";
import { canonicalJsonStringify, sha256Hex } from "../../src/domain/canonical-hash.js";
import { FileSystemEvidenceArchive } from "../../src/adapters/persistence/file-system-evidence-archive.js";
import { EvidenceIngestionGateway } from "../../src/application/evidence-ingestion-gateway.js";
import {
  EvidenceSigner,
  EvidenceThresholdVerifier,
  TrustedKeyring,
  computePublicKeyFingerprint,
} from "../../src/application/evidence-signer.js";

describe("Phase 37 — Production Multi-Authority Threshold Evidence Signing", () => {
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
    tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-phase37-"));
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
      taskId: "task-p37-main",
      title: "Phase 37 Multi-Authority Threshold Task",
      inputPayload: { goal: "production threshold evidence signing" },
    });

    const spec = {
      taskId: "task-p37-main",
      policy: createExecutionPolicy({
        policyId: "policy-p37",
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
      taskId: "task-p37-main",
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
    const actionId = "act-p37-1";
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
      attemptId: "att-p37-1",
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
      tx.transitionAttempt("att-p37-1", { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
      tx.transitionAttempt("att-p37-1", { type: "START", now: clock.nowIso() }, () => "e4");
      tx.transitionAttempt(
        "att-p37-1",
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
      evidenceId: "evi-p37-1",
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
      evidenceIds: ["evi-p37-1"],
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
    });
  });

  afterEach(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tmpBaseDir, { recursive: true, force: true });
  });

  // Helpers to sign with specific authority
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
  // Section 1: Authority Setup (Tests 1-3)
  // ===========================================================================
  it("1: initializes exactly three distinct trusted authorities with roles", () => {
    expect(keyring.hasKey("worker-key")).toBe(true);
    expect(keyring.hasKey("supervisor-key")).toBe(true);
    expect(keyring.hasKey("verifier-key")).toBe(true);

    const workerRec = keyring.getKey("worker-key")!;
    expect(workerRec.authorityId).toBe("WORKER_PRODUCER");
    expect(workerRec.role).toBe("WORKER_PRODUCER");
    expect(workerRec.status).toBe("TRUSTED");

    const supervisorRec = keyring.getKey("supervisor-key")!;
    expect(supervisorRec.authorityId).toBe("SUPERVISOR");
    expect(supervisorRec.role).toBe("SUPERVISOR");
    expect(supervisorRec.status).toBe("TRUSTED");

    const verifierRec = keyring.getKey("verifier-key")!;
    expect(verifierRec.authorityId).toBe("INDEPENDENT_VERIFIER");
    expect(verifierRec.role).toBe("INDEPENDENT_VERIFIER");
    expect(verifierRec.status).toBe("TRUSTED");
  });

  it("2: produces deterministic public key fingerprints for all authorities", () => {
    const fp1 = computePublicKeyFingerprint(workerKey.publicKey);
    const fp2 = computePublicKeyFingerprint(workerKey.publicKey);
    expect(fp1).toBe(fp2);
    expect(/^[0-9a-f]{64}$/.test(fp1)).toBe(true);

    expect(keyring.getKey("worker-key")!.publicKeyFingerprint).toBe(fp1);
    expect(keyring.getKey("supervisor-key")!.publicKeyFingerprint).toBe(
      computePublicKeyFingerprint(supervisorKey.publicKey)
    );
    expect(keyring.getKey("verifier-key")!.publicKeyFingerprint).toBe(
      computePublicKeyFingerprint(verifierKey.publicKey)
    );
  });

  it("3: ensures authority IDs are cryptographically bound and resolvable from keyring", () => {
    const recWorker = keyring.getKeyByAuthorityId("WORKER_PRODUCER");
    expect(recWorker).toBeDefined();
    expect(recWorker?.keyId).toBe("worker-key");

    const recSupervisor = keyring.getKeyByAuthorityId("SUPERVISOR");
    expect(recSupervisor).toBeDefined();
    expect(recSupervisor?.keyId).toBe("supervisor-key");

    const recVerifier = keyring.getKeyByAuthorityId("INDEPENDENT_VERIFIER");
    expect(recVerifier).toBeDefined();
    expect(recVerifier?.keyId).toBe("verifier-key");
  });

  // ===========================================================================
  // Section 2: Threshold 2-of-3 Semantics (Tests 4-9)
  // ===========================================================================
  it("4: Worker + Supervisor satisfies 2-of-3 threshold and is accepted", () => {
    const bundle = createMultiSignedBundle(goldenBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const result = gateway.ingest(bundle);
    expect(result.status).toBe("ACCEPTED");
    expect(result.thresholdResult?.status).toBe("THRESHOLD_SATISFIED");
    expect(result.thresholdResult?.distinctValidAuthorities).toBe(2);
    expect(result.thresholdResult?.validAuthorityIds).toEqual(
      expect.arrayContaining(["WORKER_PRODUCER", "SUPERVISOR"])
    );
  });

  it("5: Worker + IndependentVerifier satisfies 2-of-3 threshold and is accepted", () => {
    const bundle = createMultiSignedBundle(goldenBundle, ["WORKER_PRODUCER", "INDEPENDENT_VERIFIER"]);
    const result = gateway.ingest(bundle);
    expect(result.status).toBe("ACCEPTED");
    expect(result.thresholdResult?.status).toBe("THRESHOLD_SATISFIED");
    expect(result.thresholdResult?.distinctValidAuthorities).toBe(2);
    expect(result.thresholdResult?.validAuthorityIds).toEqual(
      expect.arrayContaining(["WORKER_PRODUCER", "INDEPENDENT_VERIFIER"])
    );
  });

  it("6: Supervisor + IndependentVerifier satisfies 2-of-3 threshold and is accepted", () => {
    const bundle = createMultiSignedBundle(goldenBundle, ["SUPERVISOR", "INDEPENDENT_VERIFIER"]);
    const result = gateway.ingest(bundle);
    expect(result.status).toBe("ACCEPTED");
    expect(result.thresholdResult?.status).toBe("THRESHOLD_SATISFIED");
    expect(result.thresholdResult?.distinctValidAuthorities).toBe(2);
    expect(result.thresholdResult?.validAuthorityIds).toEqual(
      expect.arrayContaining(["SUPERVISOR", "INDEPENDENT_VERIFIER"])
    );
  });

  it("7: Worker alone fails 2-of-3 threshold with INSUFFICIENT_AUTHORITIES", () => {
    const bundle = createMultiSignedBundle(goldenBundle, ["WORKER_PRODUCER"]);
    const result = gateway.ingest(bundle);
    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("INSUFFICIENT_AUTHORITIES");
    expect(result.thresholdResult?.status).toBe("INSUFFICIENT_AUTHORITIES");
    expect(result.thresholdResult?.distinctValidAuthorities).toBe(1);
  });

  it("8: Supervisor alone fails 2-of-3 threshold with INSUFFICIENT_AUTHORITIES", () => {
    const bundle = createMultiSignedBundle(goldenBundle, ["SUPERVISOR"]);
    const result = gateway.ingest(bundle);
    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("INSUFFICIENT_AUTHORITIES");
    expect(result.thresholdResult?.status).toBe("INSUFFICIENT_AUTHORITIES");
    expect(result.thresholdResult?.distinctValidAuthorities).toBe(1);
  });

  it("9: IndependentVerifier alone fails 2-of-3 threshold with INSUFFICIENT_AUTHORITIES", () => {
    const bundle = createMultiSignedBundle(goldenBundle, ["INDEPENDENT_VERIFIER"]);
    const result = gateway.ingest(bundle);
    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("INSUFFICIENT_AUTHORITIES");
    expect(result.thresholdResult?.status).toBe("INSUFFICIENT_AUTHORITIES");
    expect(result.thresholdResult?.distinctValidAuthorities).toBe(1);
  });

  // ===========================================================================
  // Section 3: Authority Distinctness (Tests 10-12)
  // ===========================================================================
  it("10: Worker + Worker duplicate signatures fail with DUPLICATE_AUTHORITY", () => {
    const sigWorker1 = signWithAuthority(goldenBundle, "WORKER_PRODUCER");
    const sigWorker2 = signWithAuthority(goldenBundle, "WORKER_PRODUCER");
    const bundle: EvidenceBundle = {
      ...goldenBundle,
      signatures: [sigWorker1, sigWorker2],
    };
    const result = gateway.ingest(bundle);
    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("DUPLICATE_AUTHORITY");
    expect(result.reasonCodes).toContain("INSUFFICIENT_AUTHORITIES");
    expect(result.thresholdResult?.distinctValidAuthorities).toBe(1);
  });

  it("11: Supervisor + Supervisor duplicate signatures fail with DUPLICATE_AUTHORITY", () => {
    const sigSupervisor = signWithAuthority(goldenBundle, "SUPERVISOR");
    const bundle: EvidenceBundle = {
      ...goldenBundle,
      signatures: [sigSupervisor, sigSupervisor],
    };
    const result = gateway.ingest(bundle);
    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("DUPLICATE_AUTHORITY");
    expect(result.thresholdResult?.distinctValidAuthorities).toBe(1);
  });

  it("12: duplicate signature cannot increase threshold count toward quorum", () => {
    const sigWorker = signWithAuthority(goldenBundle, "WORKER_PRODUCER");
    // 3 copies of the same worker signature
    const bundle: EvidenceBundle = {
      ...goldenBundle,
      signatures: [sigWorker, sigWorker, sigWorker],
    };
    const result = gateway.ingest(bundle);
    expect(result.status).toBe("QUARANTINED");
    expect(result.thresholdResult?.distinctValidAuthorities).toBe(1);
    expect(result.reasonCodes).toContain("INSUFFICIENT_AUTHORITIES");
  });

  // ===========================================================================
  // Section 4: Producer-Compromise Defense (Tests 13-15)
  // ===========================================================================
  it("13: compromised Worker cannot forge accepted evidence (decisive Phase 36 A1 defense)", () => {
    // Attacker fabricates an execution trajectory with synthetic tool output
    const syntheticBundle = JSON.parse(JSON.stringify(goldenBundle));
    syntheticBundle.attempts[0].outputPayload = { exitCode: 0, stdout: "Compromised producer fabrication" };
    const attemptRoot = sha256Hex(canonicalJsonStringify(syntheticBundle.attempts));
    syntheticBundle.provenanceRoot = computeProvenanceRoot({
      contractHash: syntheticBundle.contract.contentHash,
      eventRoot: syntheticBundle.events[syntheticBundle.events.length - 1].eventHash,
      checkpointRoot: sha256Hex(canonicalJsonStringify(syntheticBundle.checkpoints)),
      attemptRoot,
      verificationRoot: sha256Hex(canonicalJsonStringify(syntheticBundle.verificationEvidence)),
    });
    const { bundleId, signature, signatures, ...rest } = syntheticBundle;
    syntheticBundle.bundleId = computeBundleId(rest as any);

    // Attacker signs with valid Worker private key
    const sig = EvidenceSigner.sign(syntheticBundle, workerKey.privateKey, "worker-key", {
      authorityId: "WORKER_PRODUCER",
    }).signature!;

    const attackerSubmission: EvidenceBundle = {
      ...syntheticBundle,
      signature: sig,
      signatures: [sig],
    };

    // Under Phase 37 threshold gateway, attacker is quarantined with INSUFFICIENT_AUTHORITIES!
    const result = gateway.ingest(attackerSubmission);
    expect(result.status).toBe("QUARANTINED");
    expect(result.replayValid).toBe(false);
    expect(result.reasonCodes).toContain("INSUFFICIENT_AUTHORITIES");
    expect(result.thresholdResult?.status).toBe("INSUFFICIENT_AUTHORITIES");
    expect(result.thresholdResult?.distinctValidAuthorities).toBe(1);
  });

  it("14: compromised Supervisor alone cannot forge accepted evidence", () => {
    const bundle = createMultiSignedBundle(goldenBundle, ["SUPERVISOR"]);
    const result = gateway.ingest(bundle);
    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("INSUFFICIENT_AUTHORITIES");
    expect(result.thresholdResult?.distinctValidAuthorities).toBe(1);
  });

  it("15: compromised IndependentVerifier alone cannot forge accepted evidence", () => {
    const bundle = createMultiSignedBundle(goldenBundle, ["INDEPENDENT_VERIFIER"]);
    const result = gateway.ingest(bundle);
    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("INSUFFICIENT_AUTHORITIES");
    expect(result.thresholdResult?.distinctValidAuthorities).toBe(1);
  });

  // ===========================================================================
  // Section 5: Cryptographic Binding (Tests 16-20)
  // ===========================================================================
  it("16: signature substitution without changing authorityId fails with INVALID_SIGNATURE", () => {
    const sigWorker = signWithAuthority(goldenBundle, "WORKER_PRODUCER");
    const sigSupervisor = signWithAuthority(goldenBundle, "SUPERVISOR");

    // Replace supervisor's signature bytes with worker's signature bytes while keeping keyId="supervisor-key"
    const tamperedSupervisorSig: EvidenceSignature = {
      ...sigSupervisor,
      signature: sigWorker.signature,
    };

    const bundle: EvidenceBundle = {
      ...goldenBundle,
      signatures: [sigWorker, tamperedSupervisorSig],
    };

    const result = gateway.ingest(bundle);
    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("INVALID_SIGNATURE");
  });

  it("17: authority substitution (changing authorityId & keyId while keeping signature) fails with INVALID_SIGNATURE", () => {
    const sigWorker = signWithAuthority(goldenBundle, "WORKER_PRODUCER");

    // Change keyId & authorityId to supervisor, but keep worker's signature bytes
    const substitutedSig: EvidenceSignature = {
      ...sigWorker,
      keyId: "supervisor-key",
      authorityId: "SUPERVISOR",
      publicKeyFingerprint: keyring.getKey("supervisor-key")!.publicKeyFingerprint,
    };

    const bundle: EvidenceBundle = {
      ...goldenBundle,
      signatures: [sigWorker, substitutedSig],
    };

    const result = gateway.ingest(bundle);
    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("INVALID_SIGNATURE");
  });

  it("18: cross-bundle signature reuse fails with INVALID_SIGNATURE for all authorities", () => {
    // Golden bundle A
    const sigWorkerA = signWithAuthority(goldenBundle, "WORKER_PRODUCER");
    const sigSupervisorA = signWithAuthority(goldenBundle, "SUPERVISOR");

    // Golden bundle B with different timestamp
    const bundleBData = EvidenceExporter.exportBundle(store, goldenBundle.run.runId, {
      nowIso: "2026-10-18T15:00:00.000Z",
    });

    // Attach signatures from bundle A to bundle B
    const bundleBWithSigsA: EvidenceBundle = {
      ...bundleBData,
      signatures: [sigWorkerA, sigSupervisorA],
    };

    const result = gateway.ingest(bundleBWithSigsA);
    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("INVALID_SIGNATURE");
  });

  it("19: provenance-root mutation fails with PROVENANCE_ROOT_MISMATCH / INVALID_PROVENANCE_ROOT", () => {
    const validBundle = createMultiSignedBundle(goldenBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const tampered: EvidenceBundle = {
      ...validBundle,
      provenanceRoot: "f".repeat(64),
    };
    // Recompute bundleId so bundleId check passes and provenance check is isolated
    const { bundleId, signature, signatures, ...rest } = tampered;
    (tampered as any).bundleId = computeBundleId(rest as any);

    const result = gateway.ingest(tampered);
    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("INVALID_SIGNATURE");
  });

  it("20: bundle-ID mutation fails with INVALID_BUNDLE_ID / BUNDLE_ID_MISMATCH", () => {
    const validBundle = createMultiSignedBundle(goldenBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const tampered: EvidenceBundle = {
      ...validBundle,
      bundleId: "e".repeat(64),
    };

    const result = gateway.ingest(tampered);
    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("INVALID_BUNDLE_ID");
    expect(result.reasonCodes).toContain("BUNDLE_ID_MISMATCH");
  });

  // ===========================================================================
  // Section 6: Key Lifecycle & Rotation (Tests 21-24)
  // ===========================================================================
  it("21: revoked authority cannot satisfy new threshold", () => {
    // Revoke supervisor key
    keyring.revokeKey("supervisor-key");

    const bundle = createMultiSignedBundle(goldenBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const result = gateway.ingest(bundle);
    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("REVOKED_AUTHORITY");
    expect(result.reasonCodes).toContain("INSUFFICIENT_AUTHORITIES");
    expect(result.thresholdResult?.distinctValidAuthorities).toBe(1);
  });

  it("22: unknown authority fails with UNKNOWN_AUTHORITY", () => {
    const sigWorker = signWithAuthority(goldenBundle, "WORKER_PRODUCER");
    const unknownKey = EvidenceSigner.generateKeyPair();
    const sigUnknown = EvidenceSigner.sign(goldenBundle, unknownKey.privateKey, "unregistered-key", {
      authorityId: "SUPERVISOR",
    }).signature!;

    const bundle: EvidenceBundle = {
      ...goldenBundle,
      signatures: [sigWorker, sigUnknown],
    };

    const result = gateway.ingest(bundle);
    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("UNKNOWN_AUTHORITY");
    expect(result.reasonCodes).toContain("INSUFFICIENT_AUTHORITIES");
    expect(result.thresholdResult?.distinctValidAuthorities).toBe(1);
  });

  it("23: historical revoked signature remains auditable without invalidating history", () => {
    // Ingest valid 2-of-3 bundle while all authorities are trusted
    const bundle = createMultiSignedBundle(goldenBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const ingestRes = gateway.ingest(bundle);
    expect(ingestRes.status).toBe("ACCEPTED");

    // Later, revoke supervisor key
    keyring.revokeKey("supervisor-key");

    // Historical verification from archive remains VERIFIED
    const auditRes = archive.verifyArchivedBundle(bundle.bundleId, keyring);
    expect(auditRes.valid).toBe(true);
    expect(auditRes.status).toBe("VERIFIED");
  });

  it("24: historical bundle does not become newly acceptable under new strict submission after revocation", () => {
    // Revoke supervisor
    keyring.revokeKey("supervisor-key");

    // New submission of the same bundle fails
    const bundle = createMultiSignedBundle(goldenBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const freshArchiveDir = path.join(tmpBaseDir, "fresh-archive");
    const freshArchive = new FileSystemEvidenceArchive({ baseDir: freshArchiveDir, clock, keyring });
    const freshGateway = new EvidenceIngestionGateway({
      archive: freshArchive,
      clock,
      keyring,
      thresholdPolicy: { threshold: 2, totalAuthorities: 3 },
    });

    const res = freshGateway.ingest(bundle);
    expect(res.status).toBe("QUARANTINED");
    expect(res.reasonCodes).toContain("REVOKED_AUTHORITY");
  });

  // ===========================================================================
  // Section 7: Replay & Policy Composition (Tests 25-28)
  // ===========================================================================
  it("25: valid quorum + invalid replay fails with REPLAY_VERIFICATION_FAILURE", () => {
    const tampered = JSON.parse(JSON.stringify(goldenBundle));
    // Falsify completion while attempt exitCode is 1
    tampered.attempts[0].exitCode = 1;
    tampered.attempts[0].status = "FAILED";
    tampered.terminalState.status = "COMPLETED";

    const { bundleId, signature, signatures, ...rest } = tampered;
    tampered.bundleId = computeBundleId(rest as any);

    const multiSigned = createMultiSignedBundle(tampered, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const result = gateway.ingest(multiSigned);

    expect(result.status).toBe("QUARANTINED");
    expect(result.replayValid).toBe(false);
    expect(result.reasonCodes).toContain("REPLAY_VERIFICATION_FAILURE");
  });

  it("26: valid quorum + policy violation fails with SECURITY_POLICY_FAILURE", () => {
    const tampered = JSON.parse(JSON.stringify(goldenBundle));
    tampered.actions[0].inputPayload = { raw_password: "unredacted-secret-password-123" };

    const { bundleId, signature, signatures, ...rest } = tampered;
    tampered.bundleId = computeBundleId(rest as any);

    const multiSigned = createMultiSignedBundle(tampered, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const result = gateway.ingest(multiSigned);

    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("SECURITY_POLICY_FAILURE");
  });

  it("27: valid quorum + secret leak fails with SECURITY_POLICY_FAILURE", () => {
    const tampered = JSON.parse(JSON.stringify(goldenBundle));
    tampered.actions[0].inputPayload = {
      ...tampered.actions[0].inputPayload,
      secret_api_key: "sk-live-unredacted-secret-value-12345",
    };

    const { bundleId, signature, signatures, ...rest } = tampered;
    tampered.bundleId = computeBundleId(rest as any);

    const multiSigned = createMultiSignedBundle(tampered, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const result = gateway.ingest(multiSigned);

    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("SECURITY_POLICY_FAILURE");
  });

  it("28: valid replay + insufficient quorum fails with INSUFFICIENT_AUTHORITIES", () => {
    // Bundle is 100% replay valid, but has only 1 authority
    const bundle = createMultiSignedBundle(goldenBundle, ["WORKER_PRODUCER"]);
    const result = gateway.ingest(bundle);

    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("INSUFFICIENT_AUTHORITIES");
  });

  // ===========================================================================
  // Section 8: Archival Semantics (Tests 29-32)
  // ===========================================================================
  it("29: accepted quorum bundle is persisted to archive/accepted/", () => {
    const bundle = createMultiSignedBundle(goldenBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const result = gateway.ingest(bundle);

    expect(result.status).toBe("ACCEPTED");
    expect(archive.hasAccepted(bundle.bundleId)).toBe(true);
    expect(archive.getAcceptedBytes(bundle.bundleId)).not.toBeNull();
  });

  it("30: insufficient quorum is quarantined under quarantine directory", () => {
    const bundle = createMultiSignedBundle(goldenBundle, ["WORKER_PRODUCER"]);
    const result = gateway.ingest(bundle);

    expect(result.status).toBe("QUARANTINED");
    expect(archive.hasAccepted(bundle.bundleId)).toBe(false);
    expect(result.quarantineReference).toBeDefined();
  });

  it("31: duplicate submission of identical quorum bundle remains idempotent", () => {
    const bundle = createMultiSignedBundle(goldenBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const res1 = gateway.ingest(bundle);
    expect(res1.status).toBe("ACCEPTED");

    const res2 = gateway.ingest(bundle);
    expect(res2.status).toBe("DUPLICATE");
    expect(res2.bundleId).toBe(bundle.bundleId);
  });

  it("32: identity conflict does not overwrite existing accepted bundle", () => {
    const bundle = createMultiSignedBundle(goldenBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const res1 = gateway.ingest(bundle);
    expect(res1.status).toBe("ACCEPTED");

    // Craft conflicting payload claiming the same bundleId
    const conflicting = {
      ...bundle,
      run: {
        ...bundle.run,
        taskId: "tampered-task-identity-conflict",
      },
      bundleId: bundle.bundleId,
    };

    const res2 = gateway.ingest(canonicalJsonStringify(conflicting));
    expect(res2.status).toBe("QUARANTINED");
    expect(res2.reasonCodes).toContain("INVALID_BUNDLE_ID");

    // Verify existing archive is not overwritten
    const originalArchived = archive.getAcceptedBytes(bundle.bundleId);
    expect(originalArchived).toBe(canonicalJsonStringify(bundle));

    // Also verify archive.storeAccepted throws on differing bytes
    expect(() =>
      archive.storeAccepted(bundle, JSON.stringify({ differing: true }))
    ).toThrow(/Identity conflict/);
  });

  // ===========================================================================
  // Section 9: Determinism (Tests 33-35)
  // ===========================================================================
  it("33: same bundle + same authorities produces identical verification result", () => {
    const bundle = createMultiSignedBundle(goldenBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const res1 = EvidenceThresholdVerifier.verifyThreshold(bundle, keyring);
    const res2 = EvidenceThresholdVerifier.verifyThreshold(bundle, keyring);

    expect(res1.status).toBe(res2.status);
    expect(res1.distinctValidAuthorities).toBe(res2.distinctValidAuthorities);
    expect(res1.validAuthorityIds).toEqual(res2.validAuthorityIds);
  });

  it("34: signature ordering does not affect threshold result", () => {
    const sigWorker = signWithAuthority(goldenBundle, "WORKER_PRODUCER");
    const sigSupervisor = signWithAuthority(goldenBundle, "SUPERVISOR");

    const bundle1: EvidenceBundle = { ...goldenBundle, signatures: [sigWorker, sigSupervisor] };
    const bundle2: EvidenceBundle = { ...goldenBundle, signatures: [sigSupervisor, sigWorker] };

    const res1 = EvidenceThresholdVerifier.verifyThreshold(bundle1, keyring);
    const res2 = EvidenceThresholdVerifier.verifyThreshold(bundle2, keyring);

    expect(res1.status).toBe("THRESHOLD_SATISFIED");
    expect(res2.status).toBe("THRESHOLD_SATISFIED");
    expect(res1.distinctValidAuthorities).toBe(res2.distinctValidAuthorities);
    expect(new Set(res1.validAuthorityIds)).toEqual(new Set(res2.validAuthorityIds));
  });

  it("35: authority ordering does not affect threshold result", () => {
    const bundle1 = createMultiSignedBundle(goldenBundle, ["WORKER_PRODUCER", "INDEPENDENT_VERIFIER"]);
    const bundle2 = createMultiSignedBundle(goldenBundle, ["INDEPENDENT_VERIFIER", "WORKER_PRODUCER"]);

    const res1 = EvidenceThresholdVerifier.verifyThreshold(bundle1, keyring);
    const res2 = EvidenceThresholdVerifier.verifyThreshold(bundle2, keyring);

    expect(res1.status).toBe("THRESHOLD_SATISFIED");
    expect(res2.status).toBe("THRESHOLD_SATISFIED");
    expect(res1.distinctValidAuthorities).toBe(res2.distinctValidAuthorities);
    expect(new Set(res1.validAuthorityIds)).toEqual(new Set(res2.validAuthorityIds));

    // Both independently pass gateway ingestion when submitted to independent archives
    const archive1Dir = path.join(tmpBaseDir, "archive-order-1");
    const archive2Dir = path.join(tmpBaseDir, "archive-order-2");
    const gateway1 = new EvidenceIngestionGateway({
      archive: new FileSystemEvidenceArchive({ baseDir: archive1Dir, clock, keyring }),
      clock,
      keyring,
      thresholdPolicy: { threshold: 2, totalAuthorities: 3 },
    });
    const gateway2 = new EvidenceIngestionGateway({
      archive: new FileSystemEvidenceArchive({ baseDir: archive2Dir, clock, keyring }),
      clock,
      keyring,
      thresholdPolicy: { threshold: 2, totalAuthorities: 3 },
    });

    expect(gateway1.ingest(bundle1).status).toBe("ACCEPTED");
    expect(gateway2.ingest(bundle2).status).toBe("ACCEPTED");
  });

  // ===========================================================================
  // Section 10: Phase 35 Regression Compatibility (Tests 36-38)
  // ===========================================================================
  it("36: Phase 35 single-signature behavior remains available for historical compatibility when no threshold policy configured", () => {
    // Gateway configured without thresholdPolicy (legacy Phase 35 mode)
    const legacyGateway = new EvidenceIngestionGateway({ archive, clock, keyring });
    const singleSigned = EvidenceSigner.sign(goldenBundle, workerKey.privateKey, "worker-key");

    const result = legacyGateway.ingest(singleSigned);
    expect(result.status).toBe("ACCEPTED");
    expect(result.signatureStatus).toBe("VALID");
    expect(result.authorityStatus).toBe("TRUSTED");
  });

  it("37: allowUnsignedLegacy=true remains functional for unsigned historical bundles", () => {
    const legacyGateway = new EvidenceIngestionGateway({
      archive,
      clock,
      keyring,
      allowUnsignedLegacy: true,
    });
    const unsignedBundle = goldenBundle;

    const result = legacyGateway.ingest(unsignedBundle);
    expect(result.status).toBe("ACCEPTED");
    expect(result.signatureStatus).toBe("UNSIGNED_LEGACY");
    expect(result.authorityStatus).toBe("NOT_ESTABLISHED");
  });

  it("38: strict unsigned behavior remains fail-closed when allowUnsignedLegacy=false", () => {
    const strictGateway = new EvidenceIngestionGateway({
      archive,
      clock,
      keyring,
      allowUnsignedLegacy: false,
    });
    const unsignedBundle = goldenBundle;

    const result = strictGateway.ingest(unsignedBundle);
    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("UNSIGNED_BUNDLE_REJECTED");
  });
});
