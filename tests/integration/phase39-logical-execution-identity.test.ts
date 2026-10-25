/**
 * Phase 39 — Logical Execution Identity & Terminal Export Fencing Evaluation
 *
 * Investigates the Phase 38 F22 LOGICAL_IDENTITY_GAP:
 * Evaluates the relationship between content identity (bundleId = SHA-256(canonical bundle))
 * and logical execution identity (runId, checkpoints, terminalState).
 *
 * Executes the complete Attack Matrix (L1 to L16) and research questions R1 to R12.
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
  computeProvenanceRoot,
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

describe("Phase 39 — Logical Execution Identity & Terminal Export Fencing", () => {
  let tmpBaseDir: string;
  let producerDbDir: string;
  let archiveDir: string;
  let store: SqliteStateStore;
  let clock: SettableClock;
  let coordinator: RunCoordinator;
  let goldenCompletedBundle: EvidenceBundle;
  let goldenFailedBundle: EvidenceBundle;
  let archive: FileSystemEvidenceArchive;
  let keyring: TrustedKeyring;
  let gateway: EvidenceIngestionGateway;
  let workerKey: ReturnType<typeof EvidenceSigner.generateKeyPair>;
  let supervisorKey: ReturnType<typeof EvidenceSigner.generateKeyPair>;
  let verifierKey: ReturnType<typeof EvidenceSigner.generateKeyPair>;

  beforeEach(() => {
    tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-phase39-"));
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
      taskId: "task-p39-main",
      title: "Phase 39 Logical Execution Identity Task",
      inputPayload: { goal: "evaluate logical execution identity and terminal export fencing" },
    });

    const spec = {
      taskId: "task-p39-main",
      policy: createExecutionPolicy({
        policyId: "policy-p39",
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
      taskId: "task-p39-main",
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

    // Checkpoint 1
    coordinator.saveCheckpoint({
      runId: createRes.run.runId,
      checkpointVersion: 1,
      durableState: { stage: "initialized" },
    });

    // Action 1
    const actionId = "act-p39-1";
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
      attemptId: "att-p39-1",
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
      tx.transitionAttempt("att-p39-1", { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
      tx.transitionAttempt(
        "att-p39-1",
        {
          type: "START",
          now: clock.nowIso(),
        },
        () => "e4"
      );
      tx.transitionAttempt(
        "att-p39-1",
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

    // Checkpoint 2
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

    // Construct a valid golden failed bundle for the same run
    // (representing a conflicting terminal export where the run was marked FAILED)
    const failedContent = {
      ...goldenCompletedBundle,
      terminalState: {
        status: "FAILED" as const,
        errorPayload: { code: "EXECUTION_FAILURE", reason: "Test suite regression" },
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
  // SECTION 1: RESEARCH QUESTIONS (R1 to R12)
  // ===========================================================================

  it("R1: verifies runId represents a single logical task execution with a strict state machine", () => {
    const run = store.getRun(goldenCompletedBundle.run.runId);
    expect(run).toBeDefined();
    expect(run?.status).toBe("COMPLETED");
    expect(run?.taskId).toBe("task-p39-main");

    // In SQLite, once a run reaches terminal COMPLETED, it cannot transition further
    expect(() =>
      coordinator.failRun(goldenCompletedBundle.run.runId, "attempt post-terminal failure")
    ).toThrow();
  });

  it("R2: demonstrates a run legitimately produces distinct evidence bundles at different checkpoints", () => {
    // Export bundle at checkpoint 1 timestamp
    const bundleAtCheckpoint1 = EvidenceExporter.exportBundle(store, goldenCompletedBundle.run.runId, {
      nowIso: "2026-10-18T12:01:00.000Z",
    });

    // Export bundle at checkpoint 2 timestamp
    const bundleAtCheckpoint2 = EvidenceExporter.exportBundle(store, goldenCompletedBundle.run.runId, {
      nowIso: "2026-10-18T12:04:00.000Z",
    });

    expect(bundleAtCheckpoint1.bundleId).not.toBe(bundleAtCheckpoint2.bundleId);
    expect(bundleAtCheckpoint1.run.runId).toBe(bundleAtCheckpoint2.run.runId);
    expect(bundleAtCheckpoint1.provenance.exportedAt).not.toBe(bundleAtCheckpoint2.provenance.exportedAt);
  });

  it("R3: demonstrates multiple non-terminal bundles can legitimately coexist in content archive", () => {
    // Intermediate snapshot 1
    const bundle1 = createMultiSignedBundle(
      EvidenceExporter.exportBundle(store, goldenCompletedBundle.run.runId, { nowIso: "2026-10-18T12:01:00.000Z" }),
      ["WORKER_PRODUCER", "SUPERVISOR"]
    );
    // Intermediate snapshot 2
    const bundle2 = createMultiSignedBundle(
      EvidenceExporter.exportBundle(store, goldenCompletedBundle.run.runId, { nowIso: "2026-10-18T12:02:00.000Z" }),
      ["WORKER_PRODUCER", "SUPERVISOR"]
    );

    const res1 = gateway.ingest(bundle1);
    const res2 = gateway.ingest(bundle2);

    expect(res1.status).toBe("ACCEPTED");
    expect(res2.status).toBe("ACCEPTED");
    expect(archive.hasAccepted(bundle1.bundleId)).toBe(true);
    expect(archive.hasAccepted(bundle2.bundleId)).toBe(true);
  });

  it("R4: verifies terminal evidence uniqueness behavior when two identical terminal runs are exported", () => {
    // Export 1
    const bundleT1 = createMultiSignedBundle(
      EvidenceExporter.exportBundle(store, goldenCompletedBundle.run.runId, { nowIso: "2026-10-18T12:05:00.000Z" }),
      ["WORKER_PRODUCER", "SUPERVISOR"]
    );
    // Export 2 at different time (yields different bundleId)
    const bundleT2 = createMultiSignedBundle(
      EvidenceExporter.exportBundle(store, goldenCompletedBundle.run.runId, { nowIso: "2026-10-18T12:05:30.000Z" }),
      ["WORKER_PRODUCER", "SUPERVISOR"]
    );

    expect(bundleT1.bundleId).not.toBe(bundleT2.bundleId);
    expect(bundleT1.terminalState.status).toBe("COMPLETED");
    expect(bundleT2.terminalState.status).toBe("COMPLETED");

    // Both are currently accepted under content addressing
    const res1 = gateway.ingest(bundleT1);
    const res2 = gateway.ingest(bundleT2);
    expect(res1.status).toBe("ACCEPTED");
    expect(res2.status).toBe("ACCEPTED");
  });

  it("R5: demonstrates contradictory terminal outcomes for same runId are both currently accepted (decisive gap)", () => {
    const signedCompleted = createMultiSignedBundle(goldenCompletedBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);

    // Construct a validly-signed FAILED bundle
    // To make it pass replay verification as FAILED, we simulate an attempt failure in payload
    const failedContent = JSON.parse(JSON.stringify(goldenCompletedBundle));
    failedContent.run.status = "FAILED";
    failedContent.terminalState = {
      status: "FAILED",
      errorPayload: { code: "TEST_FAILED", reason: "unit tests failed" },
      completedAt: "2026-10-18T12:05:00.000Z",
    };
    failedContent.provenance.exportedAt = "2026-10-18T12:06:00.000Z";
    failedContent.attempts[0].exitCode = 1;
    failedContent.attempts[0].status = "FAILED";

    // Recompute provenanceRoot and bundleId
    const contractHash = failedContent.contract.contentHash;
    const eventRoot = failedContent.events[failedContent.events.length - 1].eventHash;
    const checkpointRoot = sha256Hex(canonicalJsonStringify(failedContent.checkpoints));
    const attemptRoot = sha256Hex(canonicalJsonStringify(failedContent.attempts));
    const verificationRoot = sha256Hex(canonicalJsonStringify(failedContent.verificationEvidence));
    failedContent.provenanceRoot = computeProvenanceRoot({
      contractHash,
      eventRoot,
      checkpointRoot,
      attemptRoot,
      verificationRoot,
    });

    const { bundleId: _b, signature: _s, signatures: _sigs, ...rest } = failedContent;
    failedContent.bundleId = computeBundleId(rest);

    const signedFailed = createMultiSignedBundle(failedContent, ["WORKER_PRODUCER", "SUPERVISOR"]);

    // Ingest both
    const resCompleted = gateway.ingest(signedCompleted);
    const resFailed = gateway.ingest(signedFailed);

    // DECISIVE FINDING: Both contradictory terminal outcomes are currently ACCEPTED into the archive!
    expect(resCompleted.status).toBe("ACCEPTED");
    expect(resFailed.status).toBe("ACCEPTED");
    expect(archive.hasAccepted(signedCompleted.bundleId)).toBe(true);
    expect(archive.hasAccepted(signedFailed.bundleId)).toBe(true);
  });

  // ===========================================================================
  // SECTION 2: ATTACK MATRIX (L1 to L16)
  // ===========================================================================

  // L1: Two valid terminal bundles, same runId
  it("L1: accepts two structurally distinct valid terminal bundles for the same runId (content addressing limitation)", () => {
    const b1 = createMultiSignedBundle(
      EvidenceExporter.exportBundle(store, goldenCompletedBundle.run.runId, { nowIso: "2026-10-18T12:05:00.000Z" }),
      ["WORKER_PRODUCER", "SUPERVISOR"]
    );
    const b2 = createMultiSignedBundle(
      EvidenceExporter.exportBundle(store, goldenCompletedBundle.run.runId, { nowIso: "2026-10-18T12:05:01.000Z" }),
      ["WORKER_PRODUCER", "SUPERVISOR"]
    );

    expect(gateway.ingest(b1).status).toBe("ACCEPTED");
    expect(gateway.ingest(b2).status).toBe("ACCEPTED");
    expect(archive.hasAccepted(b1.bundleId)).toBe(true);
    expect(archive.hasAccepted(b2.bundleId)).toBe(true);
  });

  // L2: One VERIFIED/COMPLETED, one FAILED
  it("L2: accepts contradictory VERIFIED and FAILED terminal bundles for the same runId", () => {
    const bVerified = createMultiSignedBundle(goldenCompletedBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);

    const failedContent = JSON.parse(JSON.stringify(goldenCompletedBundle));
    failedContent.run.status = "FAILED";
    failedContent.terminalState = { status: "FAILED", completedAt: "2026-10-18T12:05:00.000Z" };
    failedContent.provenance.exportedAt = "2026-10-18T12:05:02.000Z";
    failedContent.attempts[0].exitCode = 1;
    failedContent.attempts[0].status = "FAILED";

    const contractHash = failedContent.contract.contentHash;
    const eventRoot = failedContent.events[failedContent.events.length - 1].eventHash;
    const checkpointRoot = sha256Hex(canonicalJsonStringify(failedContent.checkpoints));
    const attemptRoot = sha256Hex(canonicalJsonStringify(failedContent.attempts));
    const verificationRoot = sha256Hex(canonicalJsonStringify(failedContent.verificationEvidence));
    failedContent.provenanceRoot = computeProvenanceRoot({
      contractHash,
      eventRoot,
      checkpointRoot,
      attemptRoot,
      verificationRoot,
    });
    const { bundleId: _b, signature: _s, signatures: _sigs, ...rest } = failedContent;
    failedContent.bundleId = computeBundleId(rest);

    const bFailed = createMultiSignedBundle(failedContent, ["WORKER_PRODUCER", "SUPERVISOR"]);

    expect(gateway.ingest(bVerified).status).toBe("ACCEPTED");
    expect(gateway.ingest(bFailed).status).toBe("ACCEPTED");
  });

  // L3: Newer checkpoint followed by older checkpoint
  it("L3: accepts older checkpoint evidence after newer checkpoint evidence has already been archived", () => {
    const newerBundle = createMultiSignedBundle(
      EvidenceExporter.exportBundle(store, goldenCompletedBundle.run.runId, { nowIso: "2026-10-18T12:05:00.000Z" }),
      ["WORKER_PRODUCER", "SUPERVISOR"]
    );
    const olderBundle = createMultiSignedBundle(
      EvidenceExporter.exportBundle(store, goldenCompletedBundle.run.runId, { nowIso: "2026-10-18T12:01:00.000Z" }),
      ["WORKER_PRODUCER", "SUPERVISOR"]
    );

    // Ingest newer first
    expect(gateway.ingest(newerBundle).status).toBe("ACCEPTED");
    // Ingest older second
    expect(gateway.ingest(olderBundle).status).toBe("ACCEPTED");
    expect(archive.hasAccepted(newerBundle.bundleId)).toBe(true);
    expect(archive.hasAccepted(olderBundle.bundleId)).toBe(true);
  });

  // L4: Terminal bundle followed by non-terminal bundle
  it("L4: accepts non-terminal snapshot evidence after a terminal outcome bundle is already archived", () => {
    const terminalBundle = createMultiSignedBundle(
      EvidenceExporter.exportBundle(store, goldenCompletedBundle.run.runId, { nowIso: "2026-10-18T12:05:00.000Z" }),
      ["WORKER_PRODUCER", "SUPERVISOR"]
    );

    // Non-terminal snapshot (status RUNNING)
    const nonTerminalContent = JSON.parse(JSON.stringify(goldenCompletedBundle));
    nonTerminalContent.terminalState = { status: "RUNNING" };
    nonTerminalContent.run.status = "RUNNING";
    nonTerminalContent.provenance.exportedAt = "2026-10-18T12:02:00.000Z";
    const { bundleId: _b, signature: _s, signatures: _sigs, ...rest } = nonTerminalContent;
    nonTerminalContent.bundleId = computeBundleId(rest);
    const nonTerminalBundle = createMultiSignedBundle(nonTerminalContent, ["WORKER_PRODUCER", "SUPERVISOR"]);

    expect(gateway.ingest(terminalBundle).status).toBe("ACCEPTED");
    expect(gateway.ingest(nonTerminalBundle).status).toBe("ACCEPTED");
  });

  // L5: Non-terminal bundle followed by terminal bundle
  it("L5: accepts terminal bundle after a non-terminal bundle is already archived", () => {
    const nonTerminalContent = JSON.parse(JSON.stringify(goldenCompletedBundle));
    nonTerminalContent.terminalState = { status: "RUNNING" };
    nonTerminalContent.run.status = "RUNNING";
    nonTerminalContent.provenance.exportedAt = "2026-10-18T12:02:00.000Z";
    const { bundleId: _b, signature: _s, signatures: _sigs, ...rest } = nonTerminalContent;
    nonTerminalContent.bundleId = computeBundleId(rest);
    const nonTerminalBundle = createMultiSignedBundle(nonTerminalContent, ["WORKER_PRODUCER", "SUPERVISOR"]);

    const terminalBundle = createMultiSignedBundle(
      EvidenceExporter.exportBundle(store, goldenCompletedBundle.run.runId, { nowIso: "2026-10-18T12:05:00.000Z" }),
      ["WORKER_PRODUCER", "SUPERVISOR"]
    );

    expect(gateway.ingest(nonTerminalBundle).status).toBe("ACCEPTED");
    expect(gateway.ingest(terminalBundle).status).toBe("ACCEPTED");
  });

  // L6: Duplicate terminal export
  it("L6: detects identical duplicate terminal export and returns ALREADY_ARCHIVED idempotently", () => {
    const bundle = createMultiSignedBundle(goldenCompletedBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const res1 = gateway.ingest(bundle);
    const res2 = gateway.ingest(bundle);

    expect(res1.status).toBe("ACCEPTED");
    expect(res2.status).toBe("DUPLICATE");
    expect(res2.bundleId).toBe(bundle.bundleId);
  });

  // L7: Two terminal exports from crash recovery
  it("L7: demonstrates crash recovery produces two valid terminal bundles across supervisor restart", () => {
    const bundlePreRecovery = createMultiSignedBundle(
      EvidenceExporter.exportBundle(store, goldenCompletedBundle.run.runId, { nowIso: "2026-10-18T12:05:00.000Z" }),
      ["WORKER_PRODUCER", "SUPERVISOR"]
    );
    // Crash recovery re-exports with updated supervisor lease evidence and timestamp
    const bundlePostRecovery = createMultiSignedBundle(
      EvidenceExporter.exportBundle(store, goldenCompletedBundle.run.runId, { nowIso: "2026-10-18T12:07:00.000Z" }),
      ["WORKER_PRODUCER", "SUPERVISOR"]
    );

    expect(bundlePreRecovery.bundleId).not.toBe(bundlePostRecovery.bundleId);
    expect(gateway.ingest(bundlePreRecovery).status).toBe("ACCEPTED");
    expect(gateway.ingest(bundlePostRecovery).status).toBe("ACCEPTED");
  });

  // L8: Two supervisors produce terminal evidence independently
  it("L8: demonstrates two independent supervisors with distinct keys can both produce accepted evidence", () => {
    // Register second supervisor
    const supervisor2Key = EvidenceSigner.generateKeyPair();
    keyring.registerKey({
      keyId: "supervisor-2-key",
      publicKey: supervisor2Key.publicKey,
      authorityId: "SUPERVISOR",
      role: "SUPERVISOR",
      status: "TRUSTED",
    });

    const sigWorker = signWithAuthority(goldenCompletedBundle, "WORKER_PRODUCER");
    const sigSup1 = signWithAuthority(goldenCompletedBundle, "SUPERVISOR");

    const bundleSup1: EvidenceBundle = Object.freeze({
      ...goldenCompletedBundle,
      signature: sigWorker,
      signatures: Object.freeze([sigWorker, sigSup1]),
    });

    const bundleSup2Content = {
      ...goldenCompletedBundle,
      provenance: {
        ...goldenCompletedBundle.provenance,
        exportedAt: "2026-10-18T12:05:10.000Z",
      },
    };
    const { bundleId: _b, signature: _s, signatures: _sigs, ...rest } = bundleSup2Content;
    const b2Id = computeBundleId(rest as any);
    const bundleSup2Pre: EvidenceBundle = Object.freeze({
      ...(rest as any),
      bundleId: b2Id,
    });
    const sigWorker2 = signWithAuthority(bundleSup2Pre, "WORKER_PRODUCER");
    const sigSup2New = EvidenceSigner.sign(bundleSup2Pre, supervisor2Key.privateKey, "supervisor-2-key", {
      authorityId: "SUPERVISOR",
    }).signature!;

    const bundleSup2: EvidenceBundle = Object.freeze({
      ...bundleSup2Pre,
      signature: sigWorker2,
      signatures: Object.freeze([sigWorker2, sigSup2New]),
    });

    expect(gateway.ingest(bundleSup1).status).toBe("ACCEPTED");
    expect(gateway.ingest(bundleSup2).status).toBe("ACCEPTED");
  });

  // L9: Worker retries after terminal state in SQLite
  it("L9: verifies worker cannot transition or retry after run reaches terminal state in store", () => {
    // Coordinator strictly throws when attempting to complete or fail an already terminal run
    expect(() =>
      coordinator.completeRun(goldenCompletedBundle.run.runId, "worker-1", "lease-1", { success: true })
    ).toThrow();
  });

  // L10: Stale worker submits evidence after supervisor recovery
  it("L10: verifies stale worker-only evidence fails 2-of-3 threshold without supervisor endorsement", () => {
    const singleSigned = EvidenceSigner.sign(goldenCompletedBundle, workerKey.privateKey, "worker-key", {
      authorityId: "WORKER_PRODUCER",
    });
    const res = gateway.ingest(singleSigned);
    expect(res.status).toBe("QUARANTINED");
    expect(res.reasonCodes).toContain("INSUFFICIENT_AUTHORITIES");
  });

  // L11: Valid threshold signatures on stale evidence
  it("L11: demonstrates valid threshold signatures on an older intermediate snapshot are accepted", () => {
    const staleSnapshot = createMultiSignedBundle(
      EvidenceExporter.exportBundle(store, goldenCompletedBundle.run.runId, { nowIso: "2026-10-18T12:01:00.000Z" }),
      ["WORKER_PRODUCER", "SUPERVISOR"]
    );
    const res = gateway.ingest(staleSnapshot);
    expect(res.status).toBe("ACCEPTED");
  });

  // L12: Valid threshold signatures on conflicting terminal outcomes
  it("L12: proves threshold signing does not detect cross-bundle terminal conflict on identical runId", () => {
    // Both bundles satisfy 2-of-3 threshold individually
    const res1 = gateway.ingest(createMultiSignedBundle(goldenCompletedBundle, ["WORKER_PRODUCER", "SUPERVISOR"]));
    const res2 = gateway.ingest(createMultiSignedBundle(goldenFailedBundle, ["WORKER_PRODUCER", "SUPERVISOR"]));

    expect(res1.status).toBe("ACCEPTED");
    expect(res2.status).toBe("ACCEPTED");
    expect(res1.thresholdResult?.status).toBe("THRESHOLD_SATISFIED");
    expect(res2.thresholdResult?.status).toBe("THRESHOLD_SATISFIED");
  });

  // L13: Same runId with different contractHash
  it("L13: quarantines bundle claiming same runId but possessing mismatched contractHash", () => {
    const tampered = JSON.parse(JSON.stringify(goldenCompletedBundle));
    tampered.contract.contentHash = "0".repeat(64);
    const { bundleId: _b, signature: _s, signatures: _sigs, ...rest } = tampered;
    tampered.bundleId = computeBundleId(rest);

    const signedTampered = createMultiSignedBundle(tampered, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const res = gateway.ingest(signedTampered);
    expect(res.status).toBe("QUARANTINED");
    expect(res.reasonCodes).toContain("CONTRACT_INTEGRITY_FAILURE");
  });

  // L14: Same runId with different mission contract version
  it("L14: quarantines bundle claiming same runId but mismatched contract version", () => {
    const tampered = JSON.parse(JSON.stringify(goldenCompletedBundle));
    tampered.contract.spec.version = 999;
    const { bundleId: _b, signature: _s, signatures: _sigs, ...rest } = tampered;
    tampered.bundleId = computeBundleId(rest);

    const signedTampered = createMultiSignedBundle(tampered, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const res = gateway.ingest(signedTampered);
    expect(res.status).toBe("QUARANTINED");
    expect(res.reasonCodes).toContain("CONTRACT_INTEGRITY_FAILURE");
  });

  // L15: Same runId with different provenanceRoot
  it("L15: quarantines bundle with tampered provenanceRoot", () => {
    const tampered = JSON.parse(JSON.stringify(goldenCompletedBundle));
    tampered.provenanceRoot = "a".repeat(64);
    const { bundleId: _b, signature: _s, signatures: _sigs, ...rest } = tampered;
    tampered.bundleId = computeBundleId(rest);

    const signedTampered = createMultiSignedBundle(tampered, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const res = gateway.ingest(signedTampered);
    expect(res.status).toBe("QUARANTINED");
    expect(res.reasonCodes).toContain("INVALID_PROVENANCE_ROOT");
  });

  // L16: Same runId with different terminal verification evidence
  it("L16: quarantines bundle where verification evidence is omitted or fails fourfold derivation", () => {
    const tampered = JSON.parse(JSON.stringify(goldenCompletedBundle));
    tampered.attempts[0].exitCode = 1; // Attempt failed, but terminalState claims COMPLETED

    const contractHash = tampered.contract.contentHash;
    const eventRoot = tampered.events[tampered.events.length - 1].eventHash;
    const checkpointRoot = sha256Hex(canonicalJsonStringify(tampered.checkpoints));
    const attemptRoot = sha256Hex(canonicalJsonStringify(tampered.attempts));
    const verificationRoot = sha256Hex(canonicalJsonStringify(tampered.verificationEvidence));
    tampered.provenanceRoot = computeProvenanceRoot({
      contractHash,
      eventRoot,
      checkpointRoot,
      attemptRoot,
      verificationRoot,
    });

    const { bundleId: _b, signature: _s, signatures: _sigs, ...rest } = tampered;
    tampered.bundleId = computeBundleId(rest);

    const signedTampered = createMultiSignedBundle(tampered, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const res = gateway.ingest(signedTampered);
    expect(res.status).toBe("QUARANTINED");
    expect(res.reasonCodes).toContain("REPLAY_VERIFICATION_FAILURE");
  });

  // ===========================================================================
  // SECTION 3: EVALUATION OF CANDIDATE ARCHITECTURES (A to F)
  // ===========================================================================

  it("Evaluates Option A (Strict runId uniqueness in archive) and demonstrates it breaks multi-checkpoint auditing", () => {
    // Model of Option A:
    // If archive checks `archive.hasAcceptedRun(runId)`, intermediate checkpoint 1 blocks checkpoint 2!
    const acceptedRunIds = new Set<string>();

    function ingestOptionA(bundle: EvidenceBundle) {
      if (acceptedRunIds.has(bundle.run.runId)) {
        return { status: "REJECTED_RUN_COLLISION", runId: bundle.run.runId };
      }
      acceptedRunIds.add(bundle.run.runId);
      return { status: "ACCEPTED", runId: bundle.run.runId };
    }

    const checkpoint1 = EvidenceExporter.exportBundle(store, goldenCompletedBundle.run.runId, {
      nowIso: "2026-10-18T12:01:00.000Z",
    });
    const terminalCheckpoint2 = EvidenceExporter.exportBundle(store, goldenCompletedBundle.run.runId, {
      nowIso: "2026-10-18T12:05:00.000Z",
    });

    const resCkpt1 = ingestOptionA(checkpoint1);
    expect(resCkpt1.status).toBe("ACCEPTED");

    // Option A FAILS LIVENESS FOR TERMINAL EVIDENCE:
    const resTerminal = ingestOptionA(terminalCheckpoint2);
    expect(resTerminal.status).toBe("REJECTED_RUN_COLLISION");
    // This demonstrates why Option A is unacceptable: legitimate intermediate snapshots block terminal certificates!
  });

  it("Evaluates Option B (runId + terminal outcome uniqueness) and demonstrates it allows snapshots but prevents conflicting outcomes", () => {
    // Model of Option B:
    // Non-terminal snapshots allowed. Terminal outcomes can be accepted at most once per runId.
    const terminalOutcomesByRun = new Map<string, { status: string; bundleId: string }>();

    function ingestOptionB(bundle: EvidenceBundle) {
      const isTerminal = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(bundle.terminalState.status);
      if (isTerminal) {
        const existing = terminalOutcomesByRun.get(bundle.run.runId);
        if (existing) {
          if (existing.bundleId === bundle.bundleId) {
            return { status: "ALREADY_ARCHIVED" };
          }
          if (existing.status !== bundle.terminalState.status) {
            return { status: "CONFLICTING_TERMINAL_OUTCOME", existing: existing.status, incoming: bundle.terminalState.status };
          }
          return { status: "DUPLICATE_TERMINAL_CERTIFICATE", existingBundleId: existing.bundleId };
        }
        terminalOutcomesByRun.set(bundle.run.runId, {
          status: bundle.terminalState.status,
          bundleId: bundle.bundleId,
        });
      }
      return { status: "ACCEPTED" };
    }

    // 1. Non-terminal snapshot accepted
    const nonTerminalBundle = { ...goldenCompletedBundle, terminalState: { status: "RUNNING" as const } };
    expect(ingestOptionB(nonTerminalBundle as any).status).toBe("ACCEPTED");

    // 2. Terminal COMPLETED bundle accepted
    expect(ingestOptionB(goldenCompletedBundle).status).toBe("ACCEPTED");

    // 3. Contradictory terminal FAILED bundle strictly rejected with CONFLICTING_TERMINAL_OUTCOME!
    const conflictRes = ingestOptionB(goldenFailedBundle);
    expect(conflictRes.status).toBe("CONFLICTING_TERMINAL_OUTCOME");
  });

  it("Evaluates Option D (Authoritative Terminal Record Index) and demonstrates clean separation of content vs logical identity", () => {
    // Model of Option D:
    // Content archive remains 100% content-addressed (indexes by bundleId).
    // A secondary Authoritative Terminal Record indexes (runId -> AuthoritativeTerminalRecord).
    interface AuthoritativeTerminalRecord {
      readonly runId: string;
      readonly terminalOutcome: "COMPLETED" | "FAILED" | "CANCELLED" | "TIMED_OUT";
      readonly authoritativeBundleId: string;
      readonly recordedAt: string;
    }

    const terminalRecords = new Map<string, AuthoritativeTerminalRecord>();
    const contentStore = new Set<string>();

    function ingestOptionD(bundle: EvidenceBundle) {
      // Step 1: Content-addressed storage (always preserves immutable evidence bytes)
      contentStore.add(bundle.bundleId);

      // Step 2: Authoritative terminal index enforcement
      const isTerminal = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(bundle.terminalState.status);
      if (isTerminal) {
        const existing = terminalRecords.get(bundle.run.runId);
        if (existing) {
          if (existing.authoritativeBundleId === bundle.bundleId) {
            return { status: "ACCEPTED_IDEMPOTENT", bundleId: bundle.bundleId };
          }
          return {
            status: "TERMINAL_FENCING_REJECTED",
            reason: `Run '${bundle.run.runId}' already has authoritative terminal record '${existing.authoritativeBundleId}' (${existing.terminalOutcome})`,
          };
        }
        terminalRecords.set(bundle.run.runId, {
          runId: bundle.run.runId,
          terminalOutcome: bundle.terminalState.status as any,
          authoritativeBundleId: bundle.bundleId,
          recordedAt: clock.nowIso(),
        });
      }

      return { status: "ACCEPTED", bundleId: bundle.bundleId };
    }

    // Both content bytes are safely preserved, but logical execution identity rejects contradictory claim
    const res1 = ingestOptionD(goldenCompletedBundle);
    expect(res1.status).toBe("ACCEPTED");
    expect(contentStore.has(goldenCompletedBundle.bundleId)).toBe(true);

    const res2 = ingestOptionD(goldenFailedBundle);
    expect(res2.status).toBe("TERMINAL_FENCING_REJECTED");
    expect(contentStore.has(goldenFailedBundle.bundleId)).toBe(true); // Content preserved for forensic audit
    expect(terminalRecords.get(goldenCompletedBundle.run.runId)?.terminalOutcome).toBe("COMPLETED");
  });
});
