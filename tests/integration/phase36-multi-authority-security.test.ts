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
  EvidenceSignatureVerifier,
  TrustedKeyring,
} from "../../src/application/evidence-signer.js";

/**
 * Isolated Test Fixture: Evaluates a hypothetical multi-authority quorum policy
 * for security evaluation without introducing speculative production code.
 */
interface QuorumPolicy {
  readonly threshold: number; // e.g. 2
  readonly totalAuthorities: number; // e.g. 3
  readonly requiredKeyIds?: readonly string[]; // e.g. ["supervisor-authority"]
}

interface QuorumEvaluationResult {
  readonly valid: boolean;
  readonly distinctValidSignatures: number;
  readonly validKeyIds: readonly string[];
  readonly rejectedKeyIds: readonly string[];
  readonly reason?: string;
}

function evaluateHypotheticalQuorum(
  bundle: EvidenceBundle,
  signatures: readonly EvidenceSignature[],
  keyring: TrustedKeyring,
  policy: QuorumPolicy
): QuorumEvaluationResult {
  const validKeyIds = new Set<string>();
  const rejectedKeyIds: string[] = [];

  for (const sig of signatures) {
    const singleSignedBundle: EvidenceBundle = {
      ...bundle,
      signature: sig,
    };
    const res = EvidenceSignatureVerifier.verify(singleSignedBundle, keyring);
    if (res.valid && res.authorityStatus === "TRUSTED" && res.keyId) {
      // Must be distinct authority (A13 defense)
      if (!validKeyIds.has(res.keyId)) {
        validKeyIds.add(res.keyId);
      }
    } else {
      rejectedKeyIds.push(sig.keyId);
    }
  }

  // Check required authorities (e.g. supervisor endorsement)
  if (policy.requiredKeyIds) {
    for (const req of policy.requiredKeyIds) {
      if (!validKeyIds.has(req)) {
        return {
          valid: false,
          distinctValidSignatures: validKeyIds.size,
          validKeyIds: Array.from(validKeyIds),
          rejectedKeyIds,
          reason: `MISSING_REQUIRED_AUTHORITY: ${req}`,
        };
      }
    }
  }

  const distinctCount = validKeyIds.size;
  if (distinctCount >= policy.threshold) {
    return {
      valid: true,
      distinctValidSignatures: distinctCount,
      validKeyIds: Array.from(validKeyIds),
      rejectedKeyIds,
    };
  }

  return {
    valid: false,
    distinctValidSignatures: distinctCount,
    validKeyIds: Array.from(validKeyIds),
    rejectedKeyIds,
    reason: `QUORUM_NOT_MET: required ${policy.threshold}, got ${distinctCount}`,
  };
}

describe("Phase 36 — Multi-Authority Quorum Security Evaluation", () => {
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
  let producerKey: ReturnType<typeof EvidenceSigner.generateKeyPair>;
  let supervisorKey: ReturnType<typeof EvidenceSigner.generateKeyPair>;
  let independentWitnessKey: ReturnType<typeof EvidenceSigner.generateKeyPair>;

  beforeEach(() => {
    tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-phase36-"));
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
      taskId: "task-p36-main",
      title: "Phase 36 Security Evaluation Task",
      inputPayload: { goal: "evaluate multi-authority security guarantees" },
    });

    const spec = {
      taskId: "task-p36-main",
      policy: createExecutionPolicy({
        policyId: "policy-p36",
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
      taskId: "task-p36-main",
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
    const actionId = "act-p36-1";
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
      attemptId: "att-p36-1",
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
      tx.transitionAttempt("att-p36-1", { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
      tx.transitionAttempt("att-p36-1", { type: "START", now: clock.nowIso() }, () => "e4");
      tx.transitionAttempt(
        "att-p36-1",
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
      evidenceId: "evi-p36-1",
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
      evidenceIds: ["evi-p36-1"],
      message: "EXIT_CODE_ZERO satisfied by run_command",
      verifiedAt: clock.nowIso(),
    });

    // Complete run
    coordinator.completeRun(runId, "worker-1", claim.lease.leaseId, { success: true });

    // Export golden bundle
    goldenBundle = EvidenceExporter.exportBundle(store, runId, { nowIso: clock.nowIso() });

    // Generate keys for authorities
    producerKey = EvidenceSigner.generateKeyPair();
    supervisorKey = EvidenceSigner.generateKeyPair();
    independentWitnessKey = EvidenceSigner.generateKeyPair();

    // Register in keyring
    keyring = new TrustedKeyring();
    keyring.registerKey({ keyId: "producer-key", publicKey: producerKey.publicKey, status: "TRUSTED" });
    keyring.registerKey({ keyId: "supervisor-key", publicKey: supervisorKey.publicKey, status: "TRUSTED" });
    keyring.registerKey({ keyId: "witness-key", publicKey: independentWitnessKey.publicKey, status: "TRUSTED" });

    // Archive & Gateway
    archive = new FileSystemEvidenceArchive({ baseDir: archiveDir, clock, keyring });
    gateway = new EvidenceIngestionGateway({ archive, clock, keyring });
  });

  afterEach(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tmpBaseDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // A1: Compromised Producer Private Key
  // ---------------------------------------------------------------------------
  it("A1: demonstrates compromised producer key can fabricate internally consistent evidence accepted by single authority", () => {
    // Attacker possesses producerKey.privateKey.
    // Attacker fabricates an execution trajectory with fake output payloads (never physically executed).
    // Because attacker knows schema, hash chaining, and replay rules, attacker creates a valid fake bundle:
    const syntheticBundle = JSON.parse(JSON.stringify(goldenBundle));
    syntheticBundle.attempts[0].outputPayload = { exitCode: 0, stdout: "Attacker fabricated tool output" };
    const attemptRoot = sha256Hex(canonicalJsonStringify(syntheticBundle.attempts));
    syntheticBundle.provenanceRoot = computeProvenanceRoot({
      contractHash: syntheticBundle.contract.contentHash,
      eventRoot: syntheticBundle.events[syntheticBundle.events.length - 1].eventHash,
      checkpointRoot: sha256Hex(canonicalJsonStringify(syntheticBundle.checkpoints)),
      attemptRoot,
      verificationRoot: sha256Hex(canonicalJsonStringify(syntheticBundle.verificationEvidence)),
    });
    const { bundleId, signature, ...rest } = syntheticBundle;
    syntheticBundle.bundleId = computeBundleId(rest as any);

    // Sign with compromised producer key
    const signedSynthetic = EvidenceSigner.sign(syntheticBundle, producerKey.privateKey, "producer-key");

    // Phase 35 Evaluation: Accepted! Single authority cannot distinguish genuine execution from compromised producer
    const p35Result = gateway.ingest(signedSynthetic);
    expect(p35Result.status).toBe("ACCEPTED");

    // Hypothetical Multi-Authority Evaluation:
    // If policy requires 2-of-2 (Producer + Supervisor Endorsement), attacker possessing only producerKey fails!
    const sigProducer = signedSynthetic.signature!;
    const quorumRes = evaluateHypotheticalQuorum(signedSynthetic, [sigProducer], keyring, {
      threshold: 2,
      totalAuthorities: 2,
      requiredKeyIds: ["supervisor-key"],
    });
    expect(quorumRes.valid).toBe(false);
    expect(quorumRes.reason).toContain("MISSING_REQUIRED_AUTHORITY: supervisor-key");
  });

  // ---------------------------------------------------------------------------
  // A2: Malicious but Validly Signed Bundle
  // ---------------------------------------------------------------------------
  it("A2: proves replay verification catches structurally valid signed bundles with falsified claims", () => {
    // Attacker fabricates an attempt failure, but marks terminalState as "COMPLETED"
    const tampered = JSON.parse(JSON.stringify(goldenBundle));
    // Mutate attempt exitCode to 1 (failure)
    tampered.attempts[0].exitCode = 1;
    tampered.attempts[0].status = "FAILED";
    tampered.terminalState.status = "COMPLETED"; // False claim!

    const { bundleId, signature, ...rest } = tampered;
    tampered.bundleId = computeBundleId(rest as any);

    // Sign with valid producer key
    const signedTampered = EvidenceSigner.sign(tampered, producerKey.privateKey, "producer-key");

    // Ingest into Phase 35: Replay catches the false completion claim!
    const result = gateway.ingest(signedTampered);
    expect(result.status).toBe("QUARANTINED");
    expect(result.replayValid).toBe(false);
    expect(result.reasonCodes).toContain("REPLAY_VERIFICATION_FAILURE");
  });

  // ---------------------------------------------------------------------------
  // A3: Valid Signature + False Operational Outcome
  // ---------------------------------------------------------------------------
  it("A3: proves fourfold completion rule catches false operational outcome regardless of valid signature", () => {
    // Bundle claims run is COMPLETED, but the underlying attempt exit code failed (exitCode: 1)
    const tampered = JSON.parse(JSON.stringify(goldenBundle));
    tampered.attempts[0].exitCode = 1;
    tampered.attempts[0].outputPayload = { exitCode: 1, stdout: "Command failed with error 1" };
    // Recompute attemptRoot & provenanceRoot so hash integrity holds, isolating the fourfold verification check
    const attemptRoot = sha256Hex(canonicalJsonStringify(tampered.attempts));
    tampered.provenanceRoot = computeProvenanceRoot({
      contractHash: tampered.contract.contentHash,
      eventRoot: tampered.events[tampered.events.length - 1].eventHash,
      checkpointRoot: sha256Hex(canonicalJsonStringify(tampered.checkpoints)),
      attemptRoot,
      verificationRoot: sha256Hex(canonicalJsonStringify(tampered.verificationEvidence)),
    });
    const { bundleId, signature, ...rest } = tampered;
    tampered.bundleId = computeBundleId(rest as any);

    // Validly sign with producer private key
    const signedTampered = EvidenceSigner.sign(tampered, producerKey.privateKey, "producer-key");
    const result = gateway.ingest(signedTampered);

    expect(result.status).toBe("QUARANTINED");
    expect(result.replayValid).toBe(false);
    expect(result.reasonCodes).toContain("REPLAY_VERIFICATION_FAILURE");
  });

  // ---------------------------------------------------------------------------
  // A4: Replay-Valid but Policy-Invalid Evidence
  // ---------------------------------------------------------------------------
  it("A4: demonstrates replay-valid evidence violating policy is quarantined", () => {
    // Construct bundle with prohibited credential leaking unredacted secret
    const tampered = JSON.parse(JSON.stringify(goldenBundle));
    tampered.actions[0].inputPayload = { raw_password: "unredacted-secret-password-123" };
    const { bundleId, signature, ...rest } = tampered;
    tampered.bundleId = computeBundleId(rest as any);

    const signedTampered = EvidenceSigner.sign(tampered, producerKey.privateKey, "producer-key");
    const result = gateway.ingest(signedTampered);

    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("SECURITY_POLICY_FAILURE");
  });

  // ---------------------------------------------------------------------------
  // A5: Revoked Producer Authority
  // ---------------------------------------------------------------------------
  it("A5: verifies revoked producer authority rejects new submissions while preserving historical archive", () => {
    // 1. Submit valid bundle while trusted
    const signed = EvidenceSigner.sign(goldenBundle, producerKey.privateKey, "producer-key");
    const res1 = gateway.ingest(signed);
    expect(res1.status).toBe("ACCEPTED");

    // 2. Revoke key in keyring
    keyring.revokeKey("producer-key");

    // 3. New submission with revoked key is rejected
    const newBundle = EvidenceExporter.exportBundle(store, goldenBundle.run.runId, { nowIso: "2026-10-18T13:00:00.000Z" });
    const signedNew = EvidenceSigner.sign(newBundle, producerKey.privateKey, "producer-key");
    const resNew = gateway.ingest(signedNew);
    expect(resNew.status).toBe("QUARANTINED");
    expect(resNew.reasonCodes).toContain("REVOKED_SIGNING_KEY");

    // 4. Historical verification reports signatureValid=true, authorityStatus=REVOKED
    const reVerify = gateway.verifyArchivedBundle(signed.bundleId);
    expect(reVerify.valid).toBe(true);
    expect(reVerify.status).toBe("VERIFIED");
    expect(reVerify.signatureResult?.authorityStatus).toBe("REVOKED");
  });

  // ---------------------------------------------------------------------------
  // A6: Supervisor Disagreement
  // ---------------------------------------------------------------------------
  it("A6: demonstrates supervisor disagreement deadlocks 2-of-2 quorum but resolved by 2-of-3 threshold", () => {
    const sigProducer = EvidenceSigner.sign(goldenBundle, producerKey.privateKey, "producer-key").signature!;
    const sigWitness = EvidenceSigner.sign(goldenBundle, independentWitnessKey.privateKey, "witness-key").signature!;
    // Supervisor disagrees and refuses to sign (or issues invalid signature)
    const sigSupervisorBogus: EvidenceSignature = {
      ...sigProducer,
      keyId: "supervisor-key",
      signature: "0".repeat(128),
    };

    // 2-of-2 Model (Producer + Supervisor required):
    const res2of2 = evaluateHypotheticalQuorum(goldenBundle, [sigProducer, sigSupervisorBogus], keyring, {
      threshold: 2,
      totalAuthorities: 2,
      requiredKeyIds: ["supervisor-key"],
    });
    expect(res2of2.valid).toBe(false); // Deadlocked!

    // 2-of-3 Model (Any 2 of 3 trusted authorities):
    const res2of3 = evaluateHypotheticalQuorum(goldenBundle, [sigProducer, sigWitness, sigSupervisorBogus], keyring, {
      threshold: 2,
      totalAuthorities: 3,
    });
    expect(res2of3.valid).toBe(true); // Producer + Witness form quorum!
    expect(res2of3.distinctValidSignatures).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // A7: Conflicting Valid Evidence for Same RunId
  // ---------------------------------------------------------------------------
  it("A7: demonstrates Phase 35 accepts conflicting valid bundles under different content-addressed bundleIds", () => {
    // Bundle A is exported at T1 and claims COMPLETED
    const bundleA = EvidenceSigner.sign(goldenBundle, producerKey.privateKey, "producer-key");
    const resA = gateway.ingest(bundleA);
    expect(resA.status).toBe("ACCEPTED");

    // Bundle B is an export of the same runId at T2 with distinct metadata/timestamp
    const bundleBData = EvidenceExporter.exportBundle(store, goldenBundle.run.runId, {
      nowIso: "2026-10-18T14:00:00.000Z",
    });
    const bundleB = EvidenceSigner.sign(bundleBData, producerKey.privateKey, "producer-key");
    const resB = gateway.ingest(bundleB);

    // In Phase 35: Both are accepted because bundleId is content-addressed (different content hashes)
    expect(resB.status).toBe("ACCEPTED");
    expect(resA.bundleId).not.toBe(resB.bundleId);
    expect(bundleA.run.runId).toBe(bundleB.run.runId);

    // Quorum observation: A 2-of-2 quorum on bundleId would require both authorities
    // to sign the EXACT SAME bundleId, preventing divergent bundle acceptance for the same run.
    const qA = evaluateHypotheticalQuorum(bundleA, [bundleA.signature!], keyring, {
      threshold: 2,
      totalAuthorities: 2,
    });
    expect(qA.valid).toBe(false); // Only 1 of 2 signed bundleA
  });

  // ---------------------------------------------------------------------------
  // A8: Signature Stripping
  // ---------------------------------------------------------------------------
  it("A8: enforces strict unsigned rejection under allowUnsignedLegacy=false while honoring legacy policy", () => {
    const signed = EvidenceSigner.sign(goldenBundle, producerKey.privateKey, "producer-key");
    const { signature, ...stripped } = signed;

    // Strict Mode
    const strictGateway = new EvidenceIngestionGateway({ archive, clock, keyring, allowUnsignedLegacy: false });
    const strictRes = strictGateway.ingest(stripped);
    expect(strictRes.status).toBe("QUARANTINED");
    expect(strictRes.reasonCodes).toContain("UNSIGNED_BUNDLE_REJECTED");

    // Legacy Mode
    const legacyRes = gateway.ingest(stripped);
    expect(legacyRes.status).toBe("ACCEPTED");
    expect(legacyRes.signatureStatus).toBe("UNSIGNED_LEGACY");
    expect(legacyRes.authorityStatus).toBe("NOT_ESTABLISHED");
  });

  // ---------------------------------------------------------------------------
  // A9: Signature Substitution
  // ---------------------------------------------------------------------------
  it("A9: rejects all permutations of signature substitution", () => {
    const signed = EvidenceSigner.sign(goldenBundle, producerKey.privateKey, "producer-key");

    // 1. Signature from unrelated key
    const unrelatedKey = EvidenceSigner.generateKeyPair();
    const unrelatedSigned = EvidenceSigner.sign(goldenBundle, unrelatedKey.privateKey, "unrelated-key");
    expect(gateway.ingest(unrelatedSigned).reasonCodes).toContain("UNKNOWN_SIGNING_KEY");

    // 2. Signature bytes replaced with Keypair B signature
    const sigB = EvidenceSigner.sign(goldenBundle, supervisorKey.privateKey, "supervisor-key");
    const substitutedBytesBundle = {
      ...signed,
      signature: {
        ...signed.signature!,
        signature: sigB.signature!.signature, // Key B's signature under Key A's keyId
      },
    };
    expect(gateway.ingest(substitutedBytesBundle).reasonCodes).toContain("INVALID_SIGNATURE");
  });

  // ---------------------------------------------------------------------------
  // A10: Keyring Compromise
  // ---------------------------------------------------------------------------
  it("A10: proves trust root compromise bypasses both single authority and multi-authority quorum", () => {
    // Attacker controls the keyring registry
    const compromisedKeyring = new TrustedKeyring();
    const attackerKey1 = EvidenceSigner.generateKeyPair();
    const attackerKey2 = EvidenceSigner.generateKeyPair();

    // Attacker registers arbitrary keys as trusted
    compromisedKeyring.registerKey({ keyId: "auth-1", publicKey: attackerKey1.publicKey, status: "TRUSTED" });
    compromisedKeyring.registerKey({ keyId: "auth-2", publicKey: attackerKey2.publicKey, status: "TRUSTED" });

    const sig1 = EvidenceSigner.sign(goldenBundle, attackerKey1.privateKey, "auth-1").signature!;
    const sig2 = EvidenceSigner.sign(goldenBundle, attackerKey2.privateKey, "auth-2").signature!;

    // Quorum evaluated against compromised keyring passes trivially:
    const quorumRes = evaluateHypotheticalQuorum(goldenBundle, [sig1, sig2], compromisedKeyring, {
      threshold: 2,
      totalAuthorities: 2,
    });
    expect(quorumRes.valid).toBe(true);
    // Finding: Quorum does NOT protect against trust-root (keyring) compromise.
  });

  // ---------------------------------------------------------------------------
  // A11: One Malicious Authority in 2-of-3 Model
  // ---------------------------------------------------------------------------
  it("A11: proves 2-of-3 quorum maintains availability when one authority is malicious or offline", () => {
    const sigProducer = EvidenceSigner.sign(goldenBundle, producerKey.privateKey, "producer-key").signature!;
    const sigSupervisor = EvidenceSigner.sign(goldenBundle, supervisorKey.privateKey, "supervisor-key").signature!;
    // Third authority is malicious or corrupt
    const sigMalicious: EvidenceSignature = {
      ...sigProducer,
      keyId: "witness-key",
      signature: "deadbeef".repeat(16),
    };

    const quorumRes = evaluateHypotheticalQuorum(goldenBundle, [sigProducer, sigSupervisor, sigMalicious], keyring, {
      threshold: 2,
      totalAuthorities: 3,
    });
    expect(quorumRes.valid).toBe(true);
    expect(quorumRes.distinctValidSignatures).toBe(2);
    expect(quorumRes.rejectedKeyIds).toContain("witness-key");
  });

  // ---------------------------------------------------------------------------
  // A12: Two Conflicting Honest Authorities
  // ---------------------------------------------------------------------------
  it("A12: demonstrates liveness failure when honest authorities produce divergent evaluations under 2-of-2", () => {
    // Authority A verifies and signs
    const sigA = EvidenceSigner.sign(goldenBundle, producerKey.privateKey, "producer-key").signature!;
    // Honest Authority B observed a timeout during its independent verification and refrains from signing
    const signatures = [sigA];

    const quorumRes = evaluateHypotheticalQuorum(goldenBundle, signatures, keyring, {
      threshold: 2,
      totalAuthorities: 2,
    });
    expect(quorumRes.valid).toBe(false);
    expect(quorumRes.reason).toContain("QUORUM_NOT_MET: required 2, got 1");
    // Finding: Strict multi-authority consensus trades availability for safety in non-deterministic environments.
  });

  // ---------------------------------------------------------------------------
  // A13: Duplicate Authority Signatures
  // ---------------------------------------------------------------------------
  it("A13: proves replay of duplicate signature from same authority cannot satisfy quorum threshold", () => {
    const sigA = EvidenceSigner.sign(goldenBundle, producerKey.privateKey, "producer-key").signature!;
    // Attacker submits duplicate signatures from Authority A
    const duplicateSignatures = [sigA, sigA];

    const quorumRes = evaluateHypotheticalQuorum(goldenBundle, duplicateSignatures, keyring, {
      threshold: 2,
      totalAuthorities: 3,
    });
    expect(quorumRes.valid).toBe(false);
    expect(quorumRes.distinctValidSignatures).toBe(1); // Only counted once
    expect(quorumRes.reason).toContain("QUORUM_NOT_MET: required 2, got 1");
  });

  // ---------------------------------------------------------------------------
  // A14: Historical Revocation
  // ---------------------------------------------------------------------------
  it("A14: confirms key revocation preserves offline auditability without retroactively invalidating history", () => {
    const signed = EvidenceSigner.sign(goldenBundle, producerKey.privateKey, "producer-key");
    const ingestRes = gateway.ingest(signed);
    expect(ingestRes.status).toBe("ACCEPTED");

    // Revoke key
    keyring.revokeKey("producer-key");

    // Historical audit
    const reVerify = archive.verifyArchivedBundle(signed.bundleId, keyring);
    expect(reVerify.valid).toBe(true);
    expect(reVerify.status).toBe("VERIFIED");
    expect(reVerify.signatureResult?.signatureStatus).toBe("VALID");
    expect(reVerify.signatureResult?.authorityStatus).toBe("REVOKED");
  });

  // ---------------------------------------------------------------------------
  // A15: Deterministic Attack Replay
  // ---------------------------------------------------------------------------
  it("A15: demonstrates 100% deterministic attack results across repeated trials", () => {
    const results: string[] = [];
    for (let trial = 0; trial < 5; trial++) {
      const trialDir = path.join(tmpBaseDir, `trial-${trial}`);
      const trialArchive = new FileSystemEvidenceArchive({ baseDir: trialDir, clock, keyring });
      const trialGateway = new EvidenceIngestionGateway({ archive: trialArchive, clock, keyring });
      const signed = EvidenceSigner.sign(goldenBundle, producerKey.privateKey, "producer-key");
      const res = trialGateway.ingest(signed);
      results.push(`${res.status}:${res.signatureStatus}:${res.authorityStatus}`);
    }
    const allIdentical = results.every((r) => r === results[0]);
    expect(allIdentical).toBe(true);
    expect(results[0]).toBe("ACCEPTED:VALID:TRUSTED");
  });
});
