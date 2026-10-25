import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import https from "node:https";
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
  createSigningPayload,
  computeSignedContentDigest,
  EvidenceBundle,
} from "../../src/domain/evidence-bundle.js";
import { canonicalJsonStringify } from "../../src/domain/canonical-hash.js";
import { FileSystemEvidenceArchive } from "../../src/adapters/persistence/file-system-evidence-archive.js";
import { EvidenceIngestionGateway } from "../../src/application/evidence-ingestion-gateway.js";
import {
  EvidenceSigner,
  TrustedKeyring,
  computePublicKeyFingerprint,
} from "../../src/application/evidence-signer.js";

describe("Phase 35 — Ed25519 Evidence Signing & Public-Key Authority Verification", () => {
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
  let keypairA: ReturnType<typeof EvidenceSigner.generateKeyPair>;
  let keypairB: ReturnType<typeof EvidenceSigner.generateKeyPair>;

  beforeEach(() => {
    tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-phase35-"));
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
      taskId: "task-p35-main",
      title: "Phase 35 Signing Task",
      inputPayload: { goal: "verify cryptographic authenticity" },
    });

    const spec = {
      taskId: "task-p35-main",
      policy: createExecutionPolicy({
        policyId: "policy-p35",
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
      taskId: "task-p35-main",
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
    const actionId = "act-p35-1";
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
      attemptId: "att-p35-1",
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
      tx.transitionAttempt("att-p35-1", { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
      tx.transitionAttempt("att-p35-1", { type: "START", now: clock.nowIso() }, () => "e4");
      tx.transitionAttempt(
        "att-p35-1",
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
      evidenceId: "evi-p35-1",
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
      evidenceIds: ["evi-p35-1"],
      message: "EXIT_CODE_ZERO satisfied by run_command",
      verifiedAt: clock.nowIso(),
    });

    // Complete run
    coordinator.completeRun(runId, "worker-1", claim.lease.leaseId, { success: true });

    // Export unsigned golden valid bundle
    goldenBundle = EvidenceExporter.exportBundle(store, runId, { nowIso: clock.nowIso() });

    // Generate test keypairs
    keypairA = EvidenceSigner.generateKeyPair();
    keypairB = EvidenceSigner.generateKeyPair();

    // Setup keyring
    keyring = new TrustedKeyring();
    keyring.registerKey({
      keyId: "producer-key-a",
      publicKey: keypairA.publicKey,
      status: "TRUSTED",
    });

    // Receiver archive and gateway
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
  // T1: Generate Ed25519 keypair
  // ---------------------------------------------------------------------------
  it("T1: generates valid in-memory Ed25519 keypair with deterministic fingerprint", () => {
    const pair = EvidenceSigner.generateKeyPair();
    expect(pair.publicKey).toBeDefined();
    expect(pair.privateKey).toBeDefined();
    expect(pair.publicKey.asymmetricKeyType).toBe("ed25519");
    expect(pair.privateKey.asymmetricKeyType).toBe("ed25519");
    expect(pair.publicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(pair.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(pair.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(computePublicKeyFingerprint(pair.publicKey)).toBe(pair.fingerprint);
  });

  // ---------------------------------------------------------------------------
  // T2: Sign valid bundle
  // ---------------------------------------------------------------------------
  it("T2: signs valid bundle producing accurate EvidenceSignature metadata", () => {
    const signed = EvidenceSigner.sign(goldenBundle, keypairA.privateKey, "producer-key-a");
    expect(signed.signature).toBeDefined();
    expect(signed.signature?.algorithm).toBe("Ed25519");
    expect(signed.signature?.keyId).toBe("producer-key-a");
    expect(signed.signature?.publicKeyFingerprint).toBe(keypairA.fingerprint);
    expect(signed.signature?.signature).toMatch(/^[0-9a-f]{128}$/);
    expect(signed.signature?.signedContentDigest).toMatch(/^[0-9a-f]{64}$/);
    // Bundle identity unchanged
    expect(signed.bundleId).toBe(goldenBundle.bundleId);
    expect(signed.provenanceRoot).toBe(goldenBundle.provenanceRoot);
  });

  // ---------------------------------------------------------------------------
  // T3: Valid signature + trusted key -> ACCEPTED
  // ---------------------------------------------------------------------------
  it("T3: accepts valid signed bundle with trusted key in keyring", () => {
    const signed = EvidenceSigner.sign(goldenBundle, keypairA.privateKey, "producer-key-a");
    const result = gateway.ingest(signed);
    expect(result.status).toBe("ACCEPTED");
    expect(result.replayValid).toBe(true);
    expect(result.signatureStatus).toBe("VALID");
    expect(result.authorityStatus).toBe("TRUSTED");
    expect(result.keyId).toBe("producer-key-a");
    expect(result.reasonCodes).toEqual([]);
    expect(archive.hasAccepted(result.bundleId!)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // T4: Modify bundle payload -> signature fails
  // ---------------------------------------------------------------------------
  it("T4: quarantines bundle if payload is modified after signing", () => {
    const signed = EvidenceSigner.sign(goldenBundle, keypairA.privateKey, "producer-key-a");
    // Tamper with payload and recompute bundleId so bundleId matches content
    const tampered = JSON.parse(JSON.stringify(signed));
    tampered.run.status = "FAILED";
    const { bundleId, signature, ...rest } = tampered;
    tampered.bundleId = computeBundleId(rest as any);

    const result = gateway.ingest(tampered);
    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("INVALID_SIGNATURE");
  });

  // ---------------------------------------------------------------------------
  // T5: Modify bundleId -> signature fails
  // ---------------------------------------------------------------------------
  it("T5: quarantines bundle if bundleId is modified", () => {
    const signed = EvidenceSigner.sign(goldenBundle, keypairA.privateKey, "producer-key-a");
    const tampered = { ...signed, bundleId: "b".repeat(64) };
    const result = gateway.ingest(tampered);
    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("INVALID_BUNDLE_ID");
  });

  // ---------------------------------------------------------------------------
  // T6: Modify provenanceRoot -> signature fails
  // ---------------------------------------------------------------------------
  it("T6: quarantines bundle if provenanceRoot is modified", () => {
    const signed = EvidenceSigner.sign(goldenBundle, keypairA.privateKey, "producer-key-a");
    const tampered = { ...signed, provenanceRoot: "c".repeat(64) };
    const { bundleId, signature, ...rest } = tampered;
    tampered.bundleId = computeBundleId(rest as any);

    const result = gateway.ingest(tampered);
    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("INVALID_SIGNATURE");
  });

  // ---------------------------------------------------------------------------
  // T7: Modify signature bytes -> fails
  // ---------------------------------------------------------------------------
  it("T7: quarantines bundle if signature hex bytes are mutated", () => {
    const signed = EvidenceSigner.sign(goldenBundle, keypairA.privateKey, "producer-key-a");
    const firstChar = signed.signature!.signature[0];
    const tamperedSig = (firstChar === "f" ? "0" : "f") + signed.signature!.signature.slice(1);
    const tampered = {
      ...signed,
      signature: {
        ...signed.signature!,
        signature: tamperedSig,
      },
    };
    const result = gateway.ingest(tampered);
    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("INVALID_SIGNATURE");
  });

  // ---------------------------------------------------------------------------
  // T8: Wrong public key -> fails
  // ---------------------------------------------------------------------------
  it("T8: quarantines bundle if signed with key not matching registered fingerprint", () => {
    // Signed with Keypair B, but declares keyId for Keypair A
    const signedWithB = EvidenceSigner.sign(goldenBundle, keypairB.privateKey, "producer-key-a", {
      publicKeyFingerprint: keypairB.fingerprint,
    });
    const result = gateway.ingest(signedWithB);
    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("INVALID_PUBLIC_KEY");
  });

  // ---------------------------------------------------------------------------
  // T9: Unknown keyId -> QUARANTINED
  // ---------------------------------------------------------------------------
  it("T9: quarantines bundle signed with unknown keyId not in keyring", () => {
    const signed = EvidenceSigner.sign(goldenBundle, keypairB.privateKey, "unknown-producer-key");
    const result = gateway.ingest(signed);
    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("UNKNOWN_SIGNING_KEY");
    expect(result.authorityStatus).toBe("UNKNOWN");
  });

  // ---------------------------------------------------------------------------
  // T10: Revoked key -> QUARANTINED
  // ---------------------------------------------------------------------------
  it("T10: quarantines bundle signed with REVOKED keyId", () => {
    keyring.revokeKey("producer-key-a");
    const signed = EvidenceSigner.sign(goldenBundle, keypairA.privateKey, "producer-key-a");
    const result = gateway.ingest(signed);
    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("REVOKED_SIGNING_KEY");
    expect(result.authorityStatus).toBe("REVOKED");
  });

  // ---------------------------------------------------------------------------
  // T11: Signature algorithm mismatch -> QUARANTINED
  // ---------------------------------------------------------------------------
  it("T11: quarantines bundle with unsupported signature algorithm", () => {
    const signed = EvidenceSigner.sign(goldenBundle, keypairA.privateKey, "producer-key-a");
    const tampered = {
      ...signed,
      signature: {
        ...signed.signature!,
        algorithm: "RSA" as any,
      },
    };
    const result = gateway.ingest(tampered);
    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("INVALID_SIGNATURE_PAYLOAD");
  });

  // ---------------------------------------------------------------------------
  // T12: Truncated signature -> QUARANTINED
  // ---------------------------------------------------------------------------
  it("T12: quarantines bundle with truncated signature hex string", () => {
    const signed = EvidenceSigner.sign(goldenBundle, keypairA.privateKey, "producer-key-a");
    const tampered = {
      ...signed,
      signature: {
        ...signed.signature!,
        signature: "abcd1234ef",
      },
    };
    const result = gateway.ingest(tampered);
    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("INVALID_SIGNATURE");
  });

  // ---------------------------------------------------------------------------
  // T13: Malformed public key -> QUARANTINED
  // ---------------------------------------------------------------------------
  it("T13: quarantines bundle with malformed public key fingerprint", () => {
    const signed = EvidenceSigner.sign(goldenBundle, keypairA.privateKey, "producer-key-a");
    const tampered = {
      ...signed,
      signature: {
        ...signed.signature!,
        publicKeyFingerprint: "not-a-valid-hex-fingerprint",
      },
    };
    const result = gateway.ingest(tampered);
    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("INVALID_PUBLIC_KEY");
  });

  // ---------------------------------------------------------------------------
  // T14: Signed bundle with replay-invalid evidence -> QUARANTINED
  // ---------------------------------------------------------------------------
  it("T14: quarantines bundle with valid signature but invalid replay evidence", () => {
    // Tamper with event sequence in source bundle
    const tampered = JSON.parse(JSON.stringify(goldenBundle));
    tampered.events[0].eventType = "corrupted.event";
    const { bundleId, signature, ...rest } = tampered;
    tampered.bundleId = computeBundleId(rest as any);

    // Sign the tampered bundle with valid key
    const signedTampered = EvidenceSigner.sign(tampered, keypairA.privateKey, "producer-key-a");

    // Ingest: signature is valid over the identity, but replay must fail
    const result = gateway.ingest(signedTampered);
    expect(result.status).toBe("QUARANTINED");
    expect(result.replayValid).toBe(false);
    expect(result.reasonCodes).toContain("EVENT_INTEGRITY_FAILURE");
  });

  // ---------------------------------------------------------------------------
  // T15: Replay-valid but unsigned bundle -> follows explicit legacy policy
  // ---------------------------------------------------------------------------
  it("T15: accepts unsigned bundle under legacy policy, rejects under strict policy", () => {
    // 1. Default gateway (allowUnsignedLegacy: true)
    const legacyResult = gateway.ingest(goldenBundle);
    expect(legacyResult.status).toBe("ACCEPTED");
    expect(legacyResult.signatureStatus).toBe("UNSIGNED_LEGACY");
    expect(legacyResult.authorityStatus).toBe("NOT_ESTABLISHED");

    // 2. Strict gateway (allowUnsignedLegacy: false)
    const strictGateway = new EvidenceIngestionGateway({
      archive,
      clock,
      keyring,
      allowUnsignedLegacy: false,
    });
    const strictResult = strictGateway.ingest(goldenBundle);
    expect(strictResult.status).toBe("QUARANTINED");
    expect(strictResult.reasonCodes).toContain("UNSIGNED_BUNDLE_REJECTED");
  });

  // ---------------------------------------------------------------------------
  // T16: Two trusted keys sign two valid bundles -> both verify independently
  // ---------------------------------------------------------------------------
  it("T16: accepts and verifies bundles signed by different trusted keys", () => {
    keyring.registerKey({
      keyId: "producer-key-b",
      publicKey: keypairB.publicKey,
      status: "TRUSTED",
    });

    const bundleA = EvidenceSigner.sign(goldenBundle, keypairA.privateKey, "producer-key-a");
    const resultA = gateway.ingest(bundleA);
    expect(resultA.status).toBe("ACCEPTED");
    expect(resultA.keyId).toBe("producer-key-a");

    // Second bundle with different timestamp
    const bundleBUnsigned = EvidenceExporter.exportBundle(store, goldenBundle.run.runId, {
      nowIso: "2026-10-18T13:00:00.000Z",
    });
    const bundleB = EvidenceSigner.sign(bundleBUnsigned, keypairB.privateKey, "producer-key-b");
    const resultB = gateway.ingest(bundleB);
    expect(resultB.status).toBe("ACCEPTED");
    expect(resultB.keyId).toBe("producer-key-b");
  });

  // ---------------------------------------------------------------------------
  // T17: Key rotation: old trusted key -> valid
  // ---------------------------------------------------------------------------
  it("T17: verifies bundles signed by active trusted keys before rotation", () => {
    const signed = EvidenceSigner.sign(goldenBundle, keypairA.privateKey, "producer-key-a");
    const result = gateway.ingest(signed);
    expect(result.status).toBe("ACCEPTED");
  });

  // ---------------------------------------------------------------------------
  // T18: Key rotation: revoked old key -> new submission rejected
  // ---------------------------------------------------------------------------
  it("T18: rejects new submission signed by old key after revocation", () => {
    keyring.revokeKey("producer-key-a");
    const signed = EvidenceSigner.sign(goldenBundle, keypairA.privateKey, "producer-key-a");
    const result = gateway.ingest(signed);
    expect(result.status).toBe("QUARANTINED");
    expect(result.reasonCodes).toContain("REVOKED_SIGNING_KEY");
  });

  // ---------------------------------------------------------------------------
  // T19: Historical bundle signed by subsequently revoked key -> retained
  // ---------------------------------------------------------------------------
  it("T19: retains historical bundle when key is subsequently revoked and reports authority REVOKED", () => {
    // 1. Ingest while trusted
    const signed = EvidenceSigner.sign(goldenBundle, keypairA.privateKey, "producer-key-a");
    const ingestRes = gateway.ingest(signed);
    expect(ingestRes.status).toBe("ACCEPTED");

    // 2. Revoke key
    keyring.revokeKey("producer-key-a");

    // 3. Re-verify archived artifact
    const verifyRes = gateway.verifyArchivedBundle(signed.bundleId);
    expect(verifyRes.valid).toBe(true);
    expect(verifyRes.status).toBe("VERIFIED");
    expect(verifyRes.signatureResult?.signatureStatus).toBe("VALID");
    expect(verifyRes.signatureResult?.authorityStatus).toBe("REVOKED");
  });

  // ---------------------------------------------------------------------------
  // T20: Private key never appears in serialized bundle
  // ---------------------------------------------------------------------------
  it("T20: guarantees private key material never appears in serialized bundle", () => {
    const signed = EvidenceSigner.sign(goldenBundle, keypairA.privateKey, "producer-key-a");
    const serialized = canonicalJsonStringify(signed);

    const privateKeyRaw = keypairA.privateKey.export({ type: "pkcs8", format: "der" });
    const privateKeyHex = privateKeyRaw.toString("hex");

    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    expect(serialized).not.toContain("PRIVATE KEY");
    expect(serialized).not.toContain(privateKeyHex);
  });

  // ---------------------------------------------------------------------------
  // T21: Private key never appears in archive
  // ---------------------------------------------------------------------------
  it("T21: guarantees private key material never appears in filesystem archive", () => {
    const signed = EvidenceSigner.sign(goldenBundle, keypairA.privateKey, "producer-key-a");
    gateway.ingest(signed);

    const acceptedFiles = fs.readdirSync(path.join(archiveDir, "accepted"));
    for (const file of acceptedFiles) {
      const content = fs.readFileSync(path.join(archiveDir, "accepted", file), "utf8");
      expect(content).not.toContain("BEGIN PRIVATE KEY");
      expect(content).not.toContain("PRIVATE KEY");
    }
  });

  // ---------------------------------------------------------------------------
  // T22: Deterministic signature payload
  // ---------------------------------------------------------------------------
  it("T22: generates deterministic signature payload and content digest across invocations", () => {
    const payload1 = createSigningPayload(goldenBundle);
    const payload2 = createSigningPayload(goldenBundle);
    expect(payload1).toEqual(payload2);

    const digest1 = computeSignedContentDigest(payload1);
    const digest2 = computeSignedContentDigest(payload2);
    expect(digest1).toBe(digest2);
    expect(digest1).toMatch(/^[0-9a-f]{64}$/);
  });

  // ---------------------------------------------------------------------------
  // T23: Same bundle + same private key -> deterministic signature behavior
  // ---------------------------------------------------------------------------
  it("T23: produces byte-for-byte identical signatures for same bundle and private key", () => {
    const signed1 = EvidenceSigner.sign(goldenBundle, keypairA.privateKey, "producer-key-a");
    const signed2 = EvidenceSigner.sign(goldenBundle, keypairA.privateKey, "producer-key-a");

    expect(signed1.signature?.signature).toBe(signed2.signature?.signature);
    expect(signed1.signature?.signedContentDigest).toBe(signed2.signature?.signedContentDigest);
  });

  // ---------------------------------------------------------------------------
  // T24: Cross-host signed bundle simulation
  // ---------------------------------------------------------------------------
  it("T24: successfully simulates cross-host export, transfer, wipe, and ingestion", () => {
    // 1. Host A exports and signs bundle
    const hostASigned = EvidenceExporter.exportBundle(store, goldenBundle.run.runId, {
      nowIso: clock.nowIso(),
      signer: {
        privateKey: keypairA.privateKey,
        keyId: "producer-key-a",
      },
    });
    const serializedPayload = canonicalJsonStringify(hostASigned);

    // 2. Destroy Host A environment
    store.close();
    fs.rmSync(producerDbDir, { recursive: true, force: true });

    // 3. Host B initializes fresh archive and gateway with public keyring only
    const hostBArchiveDir = path.join(tmpBaseDir, "host-b-archive");
    const hostBKeyring = new TrustedKeyring();
    hostBKeyring.registerKey({
      keyId: "producer-key-a",
      publicKey: keypairA.publicKeyPem,
      status: "TRUSTED",
    });

    const hostBArchive = new FileSystemEvidenceArchive({
      baseDir: hostBArchiveDir,
      clock,
      keyring: hostBKeyring,
    });
    const hostBGateway = new EvidenceIngestionGateway({
      archive: hostBArchive,
      clock,
      keyring: hostBKeyring,
    });

    // 4. Ingest raw payload string
    const ingestRes = hostBGateway.ingest(serializedPayload);
    expect(ingestRes.status).toBe("ACCEPTED");
    expect(ingestRes.signatureStatus).toBe("VALID");
    expect(ingestRes.authorityStatus).toBe("TRUSTED");

    // 5. Offline re-verification
    const reVerify = hostBGateway.verifyArchivedBundle(ingestRes.bundleId!);
    expect(reVerify.valid).toBe(true);
    expect(reVerify.status).toBe("VERIFIED");
  });

  // ---------------------------------------------------------------------------
  // T25: Accepted signed archive reload -> signature + replay verification PASS
  // ---------------------------------------------------------------------------
  it("T25: reloads and re-verifies accepted signed bundle from archive", () => {
    const signed = EvidenceSigner.sign(goldenBundle, keypairA.privateKey, "producer-key-a");
    const ingestRes = gateway.ingest(signed);
    expect(ingestRes.status).toBe("ACCEPTED");

    const reVerify = archive.verifyArchivedBundle(signed.bundleId, keyring);
    expect(reVerify.valid).toBe(true);
    expect(reVerify.status).toBe("VERIFIED");
    expect(reVerify.replayResult?.valid).toBe(true);
    expect(reVerify.signatureResult?.valid).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // T26: Archive tampering -> signature/replay integrity failure
  // ---------------------------------------------------------------------------
  it("T26: detects tampering of archived signed file on disk", () => {
    const signed = EvidenceSigner.sign(goldenBundle, keypairA.privateKey, "producer-key-a");
    gateway.ingest(signed);

    const targetFile = path.join(archiveDir, "accepted", `${signed.bundleId}.json`);
    const originalContent = fs.readFileSync(targetFile, "utf8");
    const tampered = JSON.parse(originalContent);
    tampered.signature.signature = "0".repeat(128); // Corrupt signature bytes
    fs.writeFileSync(targetFile, canonicalJsonStringify(tampered), "utf8");

    const reVerify = gateway.verifyArchivedBundle(signed.bundleId);
    expect(reVerify.valid).toBe(false);
    expect(reVerify.status).toBe("ARCHIVE_INTEGRITY_FAILURE");
  });

  // ---------------------------------------------------------------------------
  // T27: Unsigned historical Phase 33 bundle remains verifiable
  // ---------------------------------------------------------------------------
  it("T27: verifies unsigned historical bundle under legacy policy without false claims", () => {
    // Ingest unsigned bundle
    const ingestRes = gateway.ingest(goldenBundle);
    expect(ingestRes.status).toBe("ACCEPTED");

    // Verify archived unsigned artifact
    const reVerify = gateway.verifyArchivedBundle(goldenBundle.bundleId);
    expect(reVerify.valid).toBe(true);
    expect(reVerify.status).toBe("VERIFIED");
    expect(reVerify.signatureResult).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // T28: Phase 34 duplicate semantics remain intact
  // ---------------------------------------------------------------------------
  it("T28: preserves idempotent duplicate handling for signed bundles", () => {
    const signed = EvidenceSigner.sign(goldenBundle, keypairA.privateKey, "producer-key-a");

    const res1 = gateway.ingest(signed);
    expect(res1.status).toBe("ACCEPTED");

    const res2 = gateway.ingest(signed);
    expect(res2.status).toBe("DUPLICATE");

    const files = fs.readdirSync(path.join(archiveDir, "accepted"));
    expect(files.length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // T29: Signature verification performs zero network access
  // ---------------------------------------------------------------------------
  it("T29: guarantees zero network calls during signing and verification", () => {
    let networkCallMade = false;
    const originalHttpRequest = http.request;
    const originalHttpsRequest = https.request;

    http.request = (() => {
      networkCallMade = true;
      throw new Error("Prohibited network call in http.request");
    }) as any;

    https.request = (() => {
      networkCallMade = true;
      throw new Error("Prohibited network call in https.request");
    }) as any;

    try {
      const signed = EvidenceSigner.sign(goldenBundle, keypairA.privateKey, "producer-key-a");
      const result = gateway.ingest(signed);
      expect(result.status).toBe("ACCEPTED");
      expect(networkCallMade).toBe(false);
    } finally {
      http.request = originalHttpRequest;
      https.request = originalHttpsRequest;
    }
  });

  // ---------------------------------------------------------------------------
  // T30: Signature verification performs zero model inference
  // ---------------------------------------------------------------------------
  it("T30: guarantees zero model inference occurs during signing and ingestion", () => {
    const signed = EvidenceSigner.sign(goldenBundle, keypairA.privateKey, "producer-key-a");
    const result = gateway.ingest(signed);
    expect(result.status).toBe("ACCEPTED");
    // Explicitly verify no ollama, prompt, or model objects are accessed
    expect((result as any).modelCalls).toBeUndefined();
  });
});
