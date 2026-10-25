/**
 * Phase 40 — Authoritative Terminal Record Index Integration Test Suite
 *
 * Implements and verifies Candidate Architecture Option D established in Phase 39:
 * "A run may have multiple immutable evidence snapshots, but at most one authoritative terminal record."
 *
 * Verifies:
 * - Content-addressed archive (archive/accepted/<bundleId>.json)
 * - Authoritative terminal record index (archive/runs/<runId>/terminal.json)
 * - Atomic write ordering (bundle first, terminal record second)
 * - Complete Test Matrix (T1 to T16)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
  createTerminalRecord,
  EvidenceBundle,
  EvidenceSignature,
} from "../../src/domain/evidence-bundle.js";
import { canonicalJsonStringify, sha256Hex } from "../../src/domain/canonical-hash.js";
import { FileSystemEvidenceArchive } from "../../src/adapters/persistence/file-system-evidence-archive.js";
import { EvidenceIngestionGateway } from "../../src/application/evidence-ingestion-gateway.js";
import {
  EvidenceSigner,
  TrustedKeyring,
} from "../../src/application/evidence-signer.js";

describe("Phase 40 — Authoritative Terminal Record Index Implementation", () => {
  let tmpBaseDir: string;
  let producerDbDir: string;
  let archiveDir: string;
  let store: SqliteStateStore;
  let clock: SettableClock;
  let coordinator: RunCoordinator;
  let goldenCompletedBundle: EvidenceBundle;
  let goldenFailedBundle: EvidenceBundle;
  let intermediateSnapshot1: EvidenceBundle;
  let intermediateSnapshot2: EvidenceBundle;
  let archive: FileSystemEvidenceArchive;
  let keyring: TrustedKeyring;
  let gateway: EvidenceIngestionGateway;
  let workerKey: ReturnType<typeof EvidenceSigner.generateKeyPair>;
  let supervisorKey: ReturnType<typeof EvidenceSigner.generateKeyPair>;
  let verifierKey: ReturnType<typeof EvidenceSigner.generateKeyPair>;

  beforeEach(() => {
    tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-phase40-"));
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
      taskId: "task-p40-main",
      title: "Phase 40 Terminal Record Index Task",
      inputPayload: { goal: "verify authoritative terminal record index architecture" },
    });

    const spec = {
      taskId: "task-p40-main",
      policy: createExecutionPolicy({
        policyId: "policy-p40",
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

    // Create and start run
    const createRes = coordinator.createRun({
      taskId: "task-p40-main",
      maxAttempts: 3,
      timeoutMs: 30000,
    });

    coordinator.queueRun(createRes.run.runId);
    coordinator.registerWorker({
      workerId: "worker-1",
      hostname: "node-producer",
      pid: 1001,
      status: "ACTIVE",
      lastHeartbeatAt: clock.nowIso(),
      createdAt: clock.nowIso(),
    });

    const claim = coordinator.claimRun(createRes.run.runId, "worker-1", 10000);
    coordinator.startRun(createRes.run.runId, "worker-1", claim.lease.leaseId);

    // Checkpoint 1: intermediate non-terminal state
    coordinator.saveCheckpoint({
      runId: createRes.run.runId,
      checkpointVersion: 1,
      durableState: { stage: "initialized" },
    });

    // Action 1
    const actionId = "act-p40-1";
    const { action, event: actEvt } = Action.create({
      actionId,
      runId: createRes.run.runId,
      sequenceNumber: 1,
      toolName: "run_command",
      inputPayload: { command: "npm test" },
      contractBinding: createRes.run.contractBinding!,
      maxAttempts: 3,
      now: clock.nowIso(),
    });

    const { attempt: att1, event: att1Evt } = Attempt.create({
      attemptId: "att-p40-1",
      actionId,
      runId: createRes.run.runId,
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
      tx.transitionAttempt("att-p40-1", { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
      tx.transitionAttempt(
        "att-p40-1",
        {
          type: "START",
          now: clock.nowIso(),
        },
        () => "e4"
      );
      tx.transitionAttempt(
        "att-p40-1",
        {
          type: "COMPLETE",
          outputPayload: { exitCode: 0, stdout: "test passed" },
          exitCode: 0,
          now: clock.nowIso(),
        },
        () => "e5"
      );
      tx.transitionAction(actionId, { type: "SUCCEED", resultPayload: { exitCode: 0 }, now: clock.nowIso() }, () => "e6");
    });

    // Checkpoint 2: intermediate non-terminal state
    coordinator.saveCheckpoint({
      runId: createRes.run.runId,
      checkpointVersion: 2,
      actionId,
      attemptNumber: 1,
      durableState: { stage: "tests-passed" },
    });

    // Complete run
    coordinator.completeRun(createRes.run.runId, "worker-1", claim.lease.leaseId, {
      success: true,
      message: "Task completed successfully",
    });

    // Export golden completed bundle
    goldenCompletedBundle = EvidenceExporter.exportBundle(store, createRes.run.runId, {
      nowIso: "2026-10-18T12:05:00.000Z",
    });

    // Construct valid golden failed bundle for the same runId
    const failedContent = {
      ...goldenCompletedBundle,
      terminalState: {
        status: "FAILED" as const,
        errorPayload: { code: "EXECUTION_FAILURE", reason: "Simulated conflicting terminal failure" },
        completedAt: "2026-10-18T12:05:00.000Z",
      },
      provenance: {
        ...goldenCompletedBundle.provenance,
        exportedAt: "2026-10-18T12:06:00.000Z",
      },
    };
    const { bundleId: _b1, signature: _s1, signatures: _s2, ...rawFailedContent } = failedContent;
    const failedBundleId = computeBundleId(rawFailedContent as any);
    goldenFailedBundle = Object.freeze({
      ...(rawFailedContent as any),
      bundleId: failedBundleId,
    });

    // Construct non-terminal intermediate snapshot 1 (RUNNING status)
    const runningContent1 = {
      ...goldenCompletedBundle,
      terminalState: {
        status: "RUNNING" as any,
        completedAt: "2026-10-18T12:02:00.000Z",
      },
      provenance: {
        ...goldenCompletedBundle.provenance,
        exportedAt: "2026-10-18T12:02:00.000Z",
      },
    };
    const { bundleId: _b2, signature: _s3, signatures: _s4, ...rawRunning1 } = runningContent1;
    const running1Id = computeBundleId(rawRunning1 as any);
    intermediateSnapshot1 = Object.freeze({
      ...(rawRunning1 as any),
      bundleId: running1Id,
    });

    // Construct non-terminal intermediate snapshot 2 (VERIFYING status)
    const runningContent2 = {
      ...goldenCompletedBundle,
      terminalState: {
        status: "VERIFYING" as any,
        completedAt: "2026-10-18T12:04:30.000Z",
      },
      provenance: {
        ...goldenCompletedBundle.provenance,
        exportedAt: "2026-10-18T12:04:30.000Z",
      },
    };
    const { bundleId: _b3, signature: _s5, signatures: _s6, ...rawRunning2 } = runningContent2;
    const running2Id = computeBundleId(rawRunning2 as any);
    intermediateSnapshot2 = Object.freeze({
      ...(rawRunning2 as any),
      bundleId: running2Id,
    });

    // Authorities and Keys
    workerKey = EvidenceSigner.generateKeyPair();
    supervisorKey = EvidenceSigner.generateKeyPair();
    verifierKey = EvidenceSigner.generateKeyPair();

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

    archive = new FileSystemEvidenceArchive({ baseDir: archiveDir, clock, keyring });
    gateway = new EvidenceIngestionGateway({
      archive,
      clock,
      keyring,
      thresholdPolicy: { threshold: 2, totalAuthorities: 3 },
      allowUnsignedLegacy: false,
      enforceTerminalAuthority: true,
    });
  });

  afterEach(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tmpBaseDir, { recursive: true, force: true });
  });

  // Helper to multi-sign bundles
  function signBundleWith(
    bundle: EvidenceBundle,
    authorities: ("WORKER_PRODUCER" | "SUPERVISOR" | "INDEPENDENT_VERIFIER")[]
  ): EvidenceBundle {
    const keyMap = {
      WORKER_PRODUCER: { key: workerKey.privateKey, keyId: "worker-key" },
      SUPERVISOR: { key: supervisorKey.privateKey, keyId: "supervisor-key" },
      INDEPENDENT_VERIFIER: { key: verifierKey.privateKey, keyId: "verifier-key" },
    };
    const signatures: EvidenceSignature[] = authorities.map((auth) => {
      const info = keyMap[auth];
      const signed = EvidenceSigner.sign(bundle, info.key, info.keyId, { authorityId: auth });
      return signed.signature!;
    });
    return Object.freeze({
      ...bundle,
      signature: signatures[0],
      signatures: Object.freeze(signatures),
    });
  }

  // ===========================================================================
  // TEST SCENARIOS: T1 through T16
  // ===========================================================================

  it("T1: accepts first terminal evidence bundle and establishes authoritative terminal record", () => {
    const signed = signBundleWith(goldenCompletedBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const res = gateway.ingest(signed);

    expect(res.status).toBe("ACCEPTED");
    expect(res.bundleId).toBe(signed.bundleId);

    // Verify bundle is stored in archive/accepted/<bundleId>.json
    const bundlePath = path.join(archiveDir, "accepted", `${signed.bundleId}.json`);
    expect(fs.existsSync(bundlePath)).toBe(true);

    // Verify authoritative terminal record is established in archive/runs/<runId>/terminal.json
    expect(archive.hasTerminalRecord(signed.run.runId)).toBe(true);
    const terminalRecord = gateway.getTerminalRecord(signed.run.runId);
    expect(terminalRecord).toBeDefined();
    expect(terminalRecord?.runId).toBe(signed.run.runId);
    expect(terminalRecord?.bundleId).toBe(signed.bundleId);
    expect(terminalRecord?.terminalOutcome).toBe("COMPLETED");
    expect(terminalRecord?.formatVersion).toBe("emerald-terminal-record-v1");

    // Cryptographic verification of terminal record
    const termVerify = gateway.verifyTerminalRecord(signed.run.runId);
    expect(termVerify.valid).toBe(true);
    expect(termVerify.status).toBe("VERIFIED");
  });

  it("T2: handles exact duplicate submission idempotently without altering terminal record", () => {
    const signed = signBundleWith(goldenCompletedBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const res1 = gateway.ingest(signed);
    expect(res1.status).toBe("ACCEPTED");

    const terminalBefore = gateway.getTerminalRecord(signed.run.runId);
    expect(terminalBefore).toBeDefined();

    // Ingest exact duplicate
    const res2 = gateway.ingest(signed);
    expect(res2.status).toBe("DUPLICATE");
    expect(res2.bundleId).toBe(signed.bundleId);

    // Terminal record remains intact and identical
    const terminalAfter = gateway.getTerminalRecord(signed.run.runId);
    expect(terminalAfter).toEqual(terminalBefore);
  });

  it("T3: quarantines structurally different terminal evidence with same outcome for same run", () => {
    const signed1 = signBundleWith(goldenCompletedBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const res1 = gateway.ingest(signed1);
    expect(res1.status).toBe("ACCEPTED");

    // Construct a structurally different bundle for same runId with outcome COMPLETED (e.g. later export timestamp)
    const differentContent = {
      ...goldenCompletedBundle,
      provenance: {
        ...goldenCompletedBundle.provenance,
        exportedAt: "2026-10-18T12:10:00.000Z",
      },
    };
    const { bundleId: _b, signature: _s1, signatures: _s2, ...rawContent } = differentContent;
    const diffBundleId = computeBundleId(rawContent as any);
    const diffBundle = Object.freeze({
      ...(rawContent as any),
      bundleId: diffBundleId,
    });
    const signed2 = signBundleWith(diffBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);

    const res2 = gateway.ingest(signed2);
    expect(res2.status).toBe("QUARANTINED");
    expect(res2.reasonCodes).toContain("TERMINAL_CONFLICT");

    // Authoritative terminal record still points to the first bundle
    const terminal = gateway.getTerminalRecord(goldenCompletedBundle.run.runId);
    expect(terminal?.bundleId).toBe(signed1.bundleId);
  });

  it("T4: quarantines contradictory terminal evidence (FAILED vs COMPLETED) for same run", () => {
    const signedCompleted = signBundleWith(goldenCompletedBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const res1 = gateway.ingest(signedCompleted);
    expect(res1.status).toBe("ACCEPTED");

    // Ingest valid FAILED bundle for the same run
    const signedFailed = signBundleWith(goldenFailedBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const res2 = gateway.ingest(signedFailed);

    expect(res2.status).toBe("QUARANTINED");
    expect(res2.reasonCodes).toContain("TERMINAL_CONFLICT");

    // Authoritative terminal record remains COMPLETED with first bundleId
    const terminal = gateway.getTerminalRecord(goldenCompletedBundle.run.runId);
    expect(terminal?.bundleId).toBe(signedCompleted.bundleId);
    expect(terminal?.terminalOutcome).toBe("COMPLETED");
  });

  it("T5: accepts multiple non-terminal snapshots for the same run without terminal conflict", () => {
    // Both intermediate snapshots have non-terminal status (RUNNING, VERIFYING)
    const signedRunning1 = signBundleWith(intermediateSnapshot1, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const signedRunning2 = signBundleWith(intermediateSnapshot2, ["WORKER_PRODUCER", "SUPERVISOR"]);

    const res1 = gateway.ingest(signedRunning1);
    expect(res1.status).toBe("ACCEPTED");

    const res2 = gateway.ingest(signedRunning2);
    expect(res2.status).toBe("ACCEPTED");

    // Both immutable snapshots are present in accepted/
    expect(archive.hasAccepted(signedRunning1.bundleId)).toBe(true);
    expect(archive.hasAccepted(signedRunning2.bundleId)).toBe(true);

    // No terminal record established because neither is terminal
    expect(archive.hasTerminalRecord(goldenCompletedBundle.run.runId)).toBe(false);
  });

  it("T6: accepts non-terminal snapshot ingested AFTER a terminal record is established", () => {
    // First ingest terminal bundle
    const signedCompleted = signBundleWith(goldenCompletedBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const res1 = gateway.ingest(signedCompleted);
    expect(res1.status).toBe("ACCEPTED");

    expect(archive.hasTerminalRecord(signedCompleted.run.runId)).toBe(true);

    // Later ingest earlier non-terminal snapshot
    const signedRunning = signBundleWith(intermediateSnapshot1, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const res2 = gateway.ingest(signedRunning);

    // Invariant B: A run may have multiple immutable evidence snapshots, but at most one authoritative terminal record
    expect(res2.status).toBe("ACCEPTED");
    expect(archive.hasAccepted(signedRunning.bundleId)).toBe(true);

    // Terminal record remains unchanged
    const terminal = gateway.getTerminalRecord(signedCompleted.run.runId);
    expect(terminal?.bundleId).toBe(signedCompleted.bundleId);
    expect(terminal?.terminalOutcome).toBe("COMPLETED");
  });

  it("T7: reconciles missing terminal record on re-ingestion after crash between bundle and terminal write", () => {
    const signed = signBundleWith(goldenCompletedBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const canonicalBytes = canonicalJsonStringify(signed);

    // Simulate crash: bundle stored in accepted/, but crash occurred before terminal record was established
    archive.storeAccepted(signed, canonicalBytes);
    expect(archive.hasAccepted(signed.bundleId)).toBe(true);
    expect(archive.hasTerminalRecord(signed.run.runId)).toBe(false);

    // Re-ingest bundle through gateway
    const res = gateway.ingest(signed);
    expect(res.status).toBe("DUPLICATE");

    // Gateway crash recovery reconciled and established the missing terminal record
    expect(archive.hasTerminalRecord(signed.run.runId)).toBe(true);
    const terminal = gateway.getTerminalRecord(signed.run.runId);
    expect(terminal?.bundleId).toBe(signed.bundleId);
    expect(terminal?.terminalOutcome).toBe("COMPLETED");

    // Verify consistency
    const verification = gateway.verifyTerminalRecord(signed.run.runId);
    expect(verification.valid).toBe(true);
    expect(verification.status).toBe("VERIFIED");
  });

  it("T8: fails verification with BUNDLE_MISSING if terminal record points to missing bundle", () => {
    const fakeBundleId = "a".repeat(64);
    const runId = "run-orphaned-terminal";
    const terminalRecord = createTerminalRecord({
      runId,
      bundleId: fakeBundleId,
      terminalOutcome: "COMPLETED",
      nowIso: clock.nowIso(),
    });

    // Manually write terminal record directly to disk without storing bundle in accepted/
    const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const runDir = path.join(archiveDir, "runs", safeRunId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "terminal.json"), canonicalJsonStringify(terminalRecord), "utf8");

    const res = archive.verifyTerminalRecord(runId);
    expect(res.valid).toBe(false);
    expect(res.status).toBe("BUNDLE_MISSING");
    expect(res.reasonCode).toBe("TERMINAL_BUNDLE_MISSING");
  });

  it("T9: fails verification with RECORD_MISMATCH if terminal record disagrees with referenced bundle", () => {
    const signed = signBundleWith(goldenCompletedBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const canonicalBytes = canonicalJsonStringify(signed);
    archive.storeAccepted(signed, canonicalBytes);

    // Create a mismatched terminal record claiming FAILED outcome for a COMPLETED bundle
    const runId = signed.run.runId;
    const mismatchedRecord = createTerminalRecord({
      runId,
      bundleId: signed.bundleId,
      terminalOutcome: "FAILED", // Mismatch with bundle.terminalState.status = COMPLETED
      nowIso: clock.nowIso(),
    });

    const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const runDir = path.join(archiveDir, "runs", safeRunId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "terminal.json"), canonicalJsonStringify(mismatchedRecord), "utf8");

    const res = archive.verifyTerminalRecord(runId);
    expect(res.valid).toBe(false);
    expect(res.status).toBe("RECORD_MISMATCH");
    expect(res.reasonCode).toBe("TERMINAL_RECORD_MISMATCH");

    // Also verify that verifyArchivedBundle detects the mismatch
    const archiveVerify = archive.verifyArchivedBundle(signed.bundleId, keyring);
    expect(archiveVerify.valid).toBe(false);
    expect(archiveVerify.status).toBe("ARCHIVE_INTEGRITY_FAILURE");
  });

  it("T10: fails verification with INVALID_RECORD if terminal record is tampered with on disk", () => {
    const signed = signBundleWith(goldenCompletedBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    gateway.ingest(signed);

    const runId = signed.run.runId;
    const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const terminalPath = path.join(archiveDir, "runs", safeRunId, "terminal.json");

    // Tamper with terminal record JSON (change recordedAt without recomputing recordHash)
    const content = JSON.parse(fs.readFileSync(terminalPath, "utf8"));
    content.recordedAt = "1999-01-01T00:00:00.000Z";
    fs.writeFileSync(terminalPath, canonicalJsonStringify(content), "utf8");

    const res = archive.verifyTerminalRecord(runId);
    expect(res.valid).toBe(false);
    expect(res.status).toBe("INVALID_RECORD");
    expect(res.reasonCode).toBe("INVALID_TERMINAL_RECORD");
    expect(res.failures[0]).toContain("hash mismatch");
  });

  it("T11: rejects terminal replacement attempt via establishAuthoritativeTerminal", () => {
    const signed1 = signBundleWith(goldenCompletedBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const signed2 = signBundleWith(goldenFailedBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);

    archive.storeAccepted(signed1, canonicalJsonStringify(signed1));
    archive.storeAccepted(signed2, canonicalJsonStringify(signed2));

    const rec1 = createTerminalRecord({
      runId: signed1.run.runId,
      bundleId: signed1.bundleId,
      terminalOutcome: "COMPLETED",
      nowIso: clock.nowIso(),
    });

    const rec2 = createTerminalRecord({
      runId: signed1.run.runId,
      bundleId: signed2.bundleId,
      terminalOutcome: "FAILED",
      nowIso: clock.nowIso(),
    });

    // First establishment succeeds
    archive.establishAuthoritativeTerminal(rec1);
    expect(archive.hasTerminalRecord(signed1.run.runId)).toBe(true);

    // Second establishment with different bundleId throws Terminal authority conflict
    expect(() => archive.establishAuthoritativeTerminal(rec2)).toThrow(/Terminal authority conflict/);
  });

  it("T12: protects recovered run against competing worker alternative terminal states", () => {
    // Ingest authoritative terminal state from original execution
    const signedCompleted = signBundleWith(goldenCompletedBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const res1 = gateway.ingest(signedCompleted);
    expect(res1.status).toBe("ACCEPTED");

    // Simulate competing worker (after partition/recovery) attempting to report FAILED for same run
    const competingWorkerKey = EvidenceSigner.generateKeyPair();
    keyring.registerKey({
      keyId: "worker-competing",
      publicKey: competingWorkerKey.publicKey,
      authorityId: "WORKER_PRODUCER",
      role: "WORKER_PRODUCER",
      status: "TRUSTED",
    });

    const competingSigned = EvidenceSigner.sign(goldenFailedBundle, competingWorkerKey.privateKey, "worker-competing", {
      authorityId: "WORKER_PRODUCER",
    });
    const supervisorSigned = EvidenceSigner.sign(goldenFailedBundle, supervisorKey.privateKey, "supervisor-key", {
      authorityId: "SUPERVISOR",
    });

    const competingBundle = Object.freeze({
      ...goldenFailedBundle,
      signature: competingSigned.signature,
      signatures: Object.freeze([competingSigned.signature!, supervisorSigned.signature!]),
    });

    const res2 = gateway.ingest(competingBundle);
    expect(res2.status).toBe("QUARANTINED");
    expect(res2.reasonCodes).toContain("TERMINAL_CONFLICT");
  });

  it("T13: fences metadata-divergent exports of the same logical execution", () => {
    const signed1 = signBundleWith(goldenCompletedBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const res1 = gateway.ingest(signed1);
    expect(res1.status).toBe("ACCEPTED");

    // Export again at later timestamp with different provenance exportedAt
    const export2 = EvidenceExporter.exportBundle(store, goldenCompletedBundle.run.runId, {
      nowIso: "2026-10-18T12:15:00.000Z",
    });
    expect(export2.bundleId).not.toBe(goldenCompletedBundle.bundleId);

    const signed2 = signBundleWith(export2, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const res2 = gateway.ingest(signed2);

    expect(res2.status).toBe("QUARANTINED");
    expect(res2.reasonCodes).toContain("TERMINAL_CONFLICT");
  });

  it("T14: fences conflicting terminal bundle claiming different contract hash", () => {
    const signed1 = signBundleWith(goldenCompletedBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    gateway.ingest(signed1);

    // Create alternative bundle with modified contract content (and recalculated contract hash)
    const alteredContract = {
      ...goldenCompletedBundle.contract,
      spec: {
        ...goldenCompletedBundle.contract.spec,
        timeoutMs: 99999,
      },
    };
    const alteredContractHash = sha256Hex(canonicalJsonStringify(alteredContract.spec));
    const alteredBundleContent = {
      ...goldenCompletedBundle,
      contract: {
        ...alteredContract,
        contractHash: alteredContractHash,
      },
      provenance: {
        ...goldenCompletedBundle.provenance,
        contractHash: alteredContractHash,
        exportedAt: "2026-10-18T12:20:00.000Z",
      },
    };
    const { bundleId: _b, signature: _s1, signatures: _s2, ...rawAltered } = alteredBundleContent;
    const alteredBundleId = computeBundleId(rawAltered as any);
    const alteredBundle = Object.freeze({
      ...(rawAltered as any),
      bundleId: alteredBundleId,
    });

    const signedAltered = signBundleWith(alteredBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const res = gateway.ingest(signedAltered);

    expect(res.status).toBe("QUARANTINED");
    expect(res.reasonCodes).toContain("TERMINAL_CONFLICT");
  });

  it("T15: fences conflicting terminal bundle with altered action sequence and provenance root", () => {
    const signed1 = signBundleWith(goldenCompletedBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    gateway.ingest(signed1);

    // Create alternative bundle with extra action
    const extraAction = {
      actionId: "act-extra-1",
      sequenceNumber: 2,
      runId: goldenCompletedBundle.run.runId,
      toolName: "run_command",
      status: "SUCCEEDED",
      inputPayload: { command: "echo extra" },
      resultPayload: { exitCode: 0 },
      createdAt: "2026-10-18T12:03:00.000Z",
      updatedAt: "2026-10-18T12:03:05.000Z",
    };
    const newActions = [...goldenCompletedBundle.actions, extraAction];
    const newProvenanceRoot = sha256Hex(`altered-provenance-root-extra-action-${goldenCompletedBundle.bundleId}`);

    const alteredBundleContent = {
      ...goldenCompletedBundle,
      actions: newActions,
      provenanceRoot: newProvenanceRoot,
      provenance: {
        ...goldenCompletedBundle.provenance,
        actionCount: newActions.length,
        exportedAt: "2026-10-18T12:25:00.000Z",
      },
    };
    const { bundleId: _b, signature: _s1, signatures: _s2, ...rawAltered } = alteredBundleContent;
    const alteredBundleId = computeBundleId(rawAltered as any);
    const alteredBundle = Object.freeze({
      ...(rawAltered as any),
      bundleId: alteredBundleId,
    });

    const signedAltered = signBundleWith(alteredBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const res = gateway.ingest(signedAltered);

    expect(res.status).toBe("QUARANTINED");
    expect(res.reasonCodes).toContain("TERMINAL_CONFLICT");
  });

  it("T16: quarantines conflicting terminal bundle even when signed with valid threshold quorum", () => {
    // Legitimate first execution accepted with 2-of-3 threshold signatures
    const legitimateSigned = signBundleWith(goldenCompletedBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const res1 = gateway.ingest(legitimateSigned);
    expect(res1.status).toBe("ACCEPTED");

    // Attacker constructs conflicting terminal bundle for the same run
    // AND compromises 2 authorities (SUPERVISOR and INDEPENDENT_VERIFIER) to sign it
    const attackerBundle = signBundleWith(goldenFailedBundle, ["SUPERVISOR", "INDEPENDENT_VERIFIER"]);

    // Cryptographic signatures are 100% valid 2-of-3 quorum
    const res2 = gateway.ingest(attackerBundle);

    // Ingestion gateway MUST QUARANTINE it because runId is already terminally fenced!
    expect(res2.status).toBe("QUARANTINED");
    expect(res2.reasonCodes).toContain("TERMINAL_CONFLICT");

    // Terminal record index remains unchanged and strictly points to the legitimate first terminal bundle
    const terminal = gateway.getTerminalRecord(goldenCompletedBundle.run.runId);
    expect(terminal?.bundleId).toBe(legitimateSigned.bundleId);
    expect(terminal?.terminalOutcome).toBe("COMPLETED");

    const verification = gateway.verifyTerminalRecord(goldenCompletedBundle.run.runId);
    expect(verification.valid).toBe(true);
    expect(verification.bundleId).toBe(legitimateSigned.bundleId);
  });
});
