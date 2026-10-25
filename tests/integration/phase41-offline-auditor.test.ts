/**
 * Phase 41 — Standalone Offline Auditor Verification CLI Test Suite
 *
 * Implements the complete Attack Matrix (A1 to A30), clean-room independence checks,
 * determinism checks, inspect command tests, and independent process CLI execution tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
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
import { canonicalJsonStringify } from "../../src/domain/canonical-hash.js";
import {
  EvidenceSigner,
  TrustedKeyring,
} from "../../src/application/evidence-signer.js";
import {
  AUDIT_EXIT_CODES,
  AUDIT_LIMITS,
  loadTrustedKeyringFromFile,
  OfflineAuditor,
} from "../../src/application/offline-auditor.js";

describe("Phase 41 — Standalone Offline Auditor Verification CLI", () => {
  let tmpBaseDir: string;
  let producerDbDir: string;
  let fixturesDir: string;
  let store: SqliteStateStore;
  let clock: SettableClock;
  let coordinator: RunCoordinator;
  let goldenCompletedBundle: EvidenceBundle;
  let goldenFailedBundle: EvidenceBundle;
  let intermediateSnapshot1: EvidenceBundle;
  let intermediateSnapshot2: EvidenceBundle;
  let keyring: TrustedKeyring;
  let keyringPath: string;
  let workerKey: ReturnType<typeof EvidenceSigner.generateKeyPair>;
  let supervisorKey: ReturnType<typeof EvidenceSigner.generateKeyPair>;
  let verifierKey: ReturnType<typeof EvidenceSigner.generateKeyPair>;
  let rogueKey: ReturnType<typeof EvidenceSigner.generateKeyPair>;
  let revokedKey: ReturnType<typeof EvidenceSigner.generateKeyPair>;

  beforeEach(() => {
    tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-phase41-"));
    producerDbDir = path.join(tmpBaseDir, "producer");
    fixturesDir = path.join(tmpBaseDir, "fixtures");
    fs.mkdirSync(producerDbDir, { recursive: true });
    fs.mkdirSync(fixturesDir, { recursive: true });

    const dbPath = path.join(producerDbDir, "producer.db");
    store = new SqliteStateStore({ location: dbPath });
    clock = new SettableClock("2026-10-19T12:00:00.000Z");
    coordinator = new RunCoordinator(store, clock);

    // Register Task and Contract
    coordinator.createTask({
      taskId: "task-p41-main",
      title: "Phase 41 Offline Auditor Task",
      inputPayload: { goal: "verify standalone offline evidence auditing" },
    });

    const spec = {
      taskId: "task-p41-main",
      policy: createExecutionPolicy({
        policyId: "policy-p41",
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
      taskId: "task-p41-main",
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
    const actionId = "act-p41-1";
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
      attemptId: "att-p41-1",
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
      tx.transitionAttempt("att-p41-1", { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
      tx.transitionAttempt("att-p41-1", { type: "START", now: clock.nowIso() }, () => "e4");
      tx.transitionAttempt(
        "att-p41-1",
        {
          type: "COMPLETE",
          outputPayload: { exitCode: 0, stdout: "all tests passed" },
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
      nowIso: "2026-10-19T12:05:00.000Z",
    });

    // Construct valid golden failed bundle for the same run
    const failedContent = {
      ...goldenCompletedBundle,
      terminalState: {
        status: "FAILED" as const,
        errorPayload: { code: "EXECUTION_FAILURE", reason: "Conflicting failure bundle" },
        completedAt: "2026-10-19T12:05:00.000Z",
      },
      provenance: {
        ...goldenCompletedBundle.provenance,
        exportedAt: "2026-10-19T12:06:00.000Z",
      },
    };
    const { bundleId: _b1, signature: _s1, signatures: _s2, ...rawFailed } = failedContent;
    const failedBundleId = computeBundleId(rawFailed as any);
    goldenFailedBundle = Object.freeze({
      ...(rawFailed as any),
      bundleId: failedBundleId,
    });

    // Non-terminal intermediate snapshots
    const runningContent1 = {
      ...goldenCompletedBundle,
      terminalState: {
        status: "RUNNING" as any,
        completedAt: "2026-10-19T12:02:00.000Z",
      },
      provenance: {
        ...goldenCompletedBundle.provenance,
        exportedAt: "2026-10-19T12:02:00.000Z",
      },
    };
    const { bundleId: _b2, signature: _s3, signatures: _s4, ...rawRunning1 } = runningContent1;
    intermediateSnapshot1 = Object.freeze({
      ...(rawRunning1 as any),
      bundleId: computeBundleId(rawRunning1 as any),
    });

    const runningContent2 = {
      ...goldenCompletedBundle,
      terminalState: {
        status: "VERIFYING" as any,
        completedAt: "2026-10-19T12:04:30.000Z",
      },
      provenance: {
        ...goldenCompletedBundle.provenance,
        exportedAt: "2026-10-19T12:04:30.000Z",
      },
    };
    const { bundleId: _b3, signature: _s5, signatures: _s6, ...rawRunning2 } = runningContent2;
    intermediateSnapshot2 = Object.freeze({
      ...(rawRunning2 as any),
      bundleId: computeBundleId(rawRunning2 as any),
    });

    // Generate Key Pairs
    workerKey = EvidenceSigner.generateKeyPair();
    supervisorKey = EvidenceSigner.generateKeyPair();
    verifierKey = EvidenceSigner.generateKeyPair();
    rogueKey = EvidenceSigner.generateKeyPair();
    revokedKey = EvidenceSigner.generateKeyPair();

    // Create Keyring
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
    keyring.registerKey({
      keyId: "revoked-key",
      publicKey: revokedKey.publicKey,
      authorityId: "REVOKED_AUTHORITY",
      role: "WORKER_PRODUCER",
      status: "REVOKED",
    });

    // Write keyring JSON file for CLI usage
    keyringPath = path.join(fixturesDir, "trusted-keyring.json");
    const keyringJsonData = [
      {
        keyId: "worker-key",
        publicKey: workerKey.publicKeyPem,
        authorityId: "WORKER_PRODUCER",
        role: "WORKER_PRODUCER",
        status: "TRUSTED",
      },
      {
        keyId: "supervisor-key",
        publicKey: supervisorKey.publicKeyPem,
        authorityId: "SUPERVISOR",
        role: "SUPERVISOR",
        status: "TRUSTED",
      },
      {
        keyId: "verifier-key",
        publicKey: verifierKey.publicKeyPem,
        authorityId: "INDEPENDENT_VERIFIER",
        role: "INDEPENDENT_VERIFIER",
        status: "TRUSTED",
      },
      {
        keyId: "revoked-key",
        publicKey: revokedKey.publicKeyPem,
        authorityId: "REVOKED_AUTHORITY",
        role: "WORKER_PRODUCER",
        status: "REVOKED",
      },
    ];
    fs.writeFileSync(keyringPath, canonicalJsonStringify(keyringJsonData), "utf8");
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
    authorities: ("WORKER_PRODUCER" | "SUPERVISOR" | "INDEPENDENT_VERIFIER" | "ROGUE" | "REVOKED")[]
  ): EvidenceBundle {
    const keyMap: Record<string, { key: any; keyId: string; authorityId: string }> = {
      WORKER_PRODUCER: { key: workerKey.privateKey, keyId: "worker-key", authorityId: "WORKER_PRODUCER" },
      SUPERVISOR: { key: supervisorKey.privateKey, keyId: "supervisor-key", authorityId: "SUPERVISOR" },
      INDEPENDENT_VERIFIER: { key: verifierKey.privateKey, keyId: "verifier-key", authorityId: "INDEPENDENT_VERIFIER" },
      ROGUE: { key: rogueKey.privateKey, keyId: "rogue-key", authorityId: "UNKNOWN_ROGUE" },
      REVOKED: { key: revokedKey.privateKey, keyId: "revoked-key", authorityId: "REVOKED_AUTHORITY" },
    };

    const signatures: EvidenceSignature[] = authorities.map((auth) => {
      const info = keyMap[auth]!;
      const signed = EvidenceSigner.sign(bundle, info.key, info.keyId, { authorityId: info.authorityId });
      return signed.signature!;
    });

    return Object.freeze({
      ...bundle,
      signature: signatures[0],
      signatures: Object.freeze(signatures),
    });
  }

  // Helper to build a standard Phase 40 archive directory
  function buildArchiveFixture(params: {
    bundles: EvidenceBundle[];
    terminalRecord?: { runId: string; bundleId: string; terminalOutcome: any };
    tamperTerminalHash?: boolean;
    omitAcceptedDir?: boolean;
    extraAcceptedFile?: { name: string; content: string };
    extraRunFile?: { runId: string; name: string; content: string };
  }): string {
    const archiveDir = path.join(fixturesDir, `archive-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(archiveDir, { recursive: true });

    if (!params.omitAcceptedDir) {
      const acceptedDir = path.join(archiveDir, "accepted");
      fs.mkdirSync(acceptedDir, { recursive: true });
      for (const b of params.bundles) {
        fs.writeFileSync(path.join(acceptedDir, `${b.bundleId}.json`), canonicalJsonStringify(b), "utf8");
      }
      if (params.extraAcceptedFile) {
        fs.writeFileSync(
          path.join(acceptedDir, params.extraAcceptedFile.name),
          params.extraAcceptedFile.content,
          "utf8"
        );
      }
    }

    if (params.terminalRecord) {
      const runsDir = path.join(archiveDir, "runs");
      const safeRunId = params.terminalRecord.runId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const runDir = path.join(runsDir, safeRunId);
      fs.mkdirSync(runDir, { recursive: true });

      const term = createTerminalRecord({
        runId: params.terminalRecord.runId,
        bundleId: params.terminalRecord.bundleId,
        terminalOutcome: params.terminalRecord.terminalOutcome,
        nowIso: "2026-10-19T12:05:00.000Z",
      });

      let termContent = { ...term };
      if (params.tamperTerminalHash) {
        termContent.recordHash = "0".repeat(64);
      }

      fs.writeFileSync(path.join(runDir, "terminal.json"), canonicalJsonStringify(termContent), "utf8");

      if (params.extraRunFile) {
        fs.writeFileSync(
          path.join(runDir, params.extraRunFile.name),
          params.extraRunFile.content,
          "utf8"
        );
      }
    }

    return archiveDir;
  }

  // ===========================================================================
  // SECTION 1: ATTACK / NEGATIVE TEST MATRIX (A1 to A30)
  // ===========================================================================

  it("A1: verifies valid single bundle", () => {
    const bundleFile = path.join(fixturesDir, "bundle-a1.json");
    fs.writeFileSync(bundleFile, canonicalJsonStringify(goldenCompletedBundle), "utf8");

    const result = OfflineAuditor.verifyEvidence(bundleFile);
    expect(result.status).toBe("VERIFIED");
    expect(result.targetType).toBe("SINGLE_BUNDLE");
    expect(result.failures.length).toBe(0);
    expect(result.bundleIds).toContain(goldenCompletedBundle.bundleId);
  });

  it("A2: verifies valid 2-of-3 threshold bundle", () => {
    const signed = signBundleWith(goldenCompletedBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const bundleFile = path.join(fixturesDir, "bundle-a2.json");
    fs.writeFileSync(bundleFile, canonicalJsonStringify(signed), "utf8");

    const result = OfflineAuditor.verifyEvidence(bundleFile, { keyring });
    expect(result.status).toBe("VERIFIED");
    expect(result.thresholdSatisfied).toBe(true);
    expect(result.failures.length).toBe(0);
  });

  it("A3: rejects bundle signed by unknown authority", () => {
    const signed = signBundleWith(goldenCompletedBundle, ["ROGUE"]);
    const bundleFile = path.join(fixturesDir, "bundle-a3.json");
    fs.writeFileSync(bundleFile, canonicalJsonStringify(signed), "utf8");

    const result = OfflineAuditor.verifyEvidence(bundleFile, { keyring, requireKeyring: true });
    expect(result.status).toBe("FAILED");
    expect(result.failures.some((f) => f.code === "UNKNOWN_SIGNING_KEY" || f.code === "UNKNOWN_AUTHORITY")).toBe(true);
  });

  it("A4: rejects bundle signed by revoked authority", () => {
    const signed = signBundleWith(goldenCompletedBundle, ["REVOKED"]);
    const bundleFile = path.join(fixturesDir, "bundle-a4.json");
    fs.writeFileSync(bundleFile, canonicalJsonStringify(signed), "utf8");

    const result = OfflineAuditor.verifyEvidence(bundleFile, { keyring, requireKeyring: true });
    expect(result.status).toBe("FAILED");
    expect(result.failures.some((f) => f.code === "REVOKED_SIGNING_KEY" || f.code === "REVOKED_AUTHORITY")).toBe(true);
  });

  it("A5: rejects invalid Ed25519 signature", () => {
    const signed = signBundleWith(goldenCompletedBundle, ["WORKER_PRODUCER"]);
    // Corrupt signature hex string in both signature and signatures array
    const tampered = {
      ...signed,
      signature: {
        ...signed.signature!,
        signature: "f".repeat(128),
      },
      signatures: [
        {
          ...signed.signatures![0]!,
          signature: "f".repeat(128),
        },
      ],
    };
    const bundleFile = path.join(fixturesDir, "bundle-a5.json");
    fs.writeFileSync(bundleFile, canonicalJsonStringify(tampered), "utf8");

    const result = OfflineAuditor.verifyEvidence(bundleFile, { keyring });
    expect(result.status).toBe("FAILED");
    expect(result.failures.some((f) => f.code === "INVALID_SIGNATURE")).toBe(true);
  });

  it("A6: rejects signature substitution across different bundles", () => {
    const signed1 = signBundleWith(goldenCompletedBundle, ["WORKER_PRODUCER"]);
    // Substitute signature from goldenCompletedBundle onto goldenFailedBundle
    const substituted = {
      ...goldenFailedBundle,
      signature: signed1.signature,
    };
    const bundleFile = path.join(fixturesDir, "bundle-a6.json");
    fs.writeFileSync(bundleFile, canonicalJsonStringify(substituted), "utf8");

    const result = OfflineAuditor.verifyEvidence(bundleFile, { keyring });
    expect(result.status).toBe("FAILED");
    expect(result.failures.some((f) => f.code === "INVALID_SIGNATURE" || f.code === "INVALID_SIGNATURE_DIGEST")).toBe(true);
  });

  it("A7: rejects bundleId tampering", () => {
    const tampered = {
      ...goldenCompletedBundle,
      bundleId: "0".repeat(64),
    };
    const bundleFile = path.join(fixturesDir, "bundle-a7.json");
    fs.writeFileSync(bundleFile, canonicalJsonStringify(tampered), "utf8");

    const result = OfflineAuditor.verifyEvidence(bundleFile);
    expect(result.status).toBe("FAILED");
    expect(result.failures.some((f) => f.code === "BUNDLE_ID_MISMATCH")).toBe(true);
  });

  it("A8: rejects provenance root tampering", () => {
    const tampered = {
      ...goldenCompletedBundle,
      provenanceRoot: "e".repeat(64),
    };
    const { bundleId: _b, ...content } = tampered;
    const recomputedId = computeBundleId(content as any);
    const validIdTamperedRoot = { ...content, bundleId: recomputedId };

    const bundleFile = path.join(fixturesDir, "bundle-a8.json");
    fs.writeFileSync(bundleFile, canonicalJsonStringify(validIdTamperedRoot), "utf8");

    const result = OfflineAuditor.verifyEvidence(bundleFile);
    expect(result.status).toBe("FAILED");
    expect(result.failures.some((f) => f.code === "PROVENANCE_ROOT_MISMATCH")).toBe(true);
  });

  it("A9: rejects event-chain tampering", () => {
    const alteredEvents = goldenCompletedBundle.events.map((e, idx) =>
      idx === 1 ? { ...e, eventHash: "0".repeat(64) } : e
    );
    const tampered = {
      ...goldenCompletedBundle,
      events: alteredEvents,
    };
    const { bundleId: _b, ...content } = tampered;
    const tamperedBundle = { ...content, bundleId: computeBundleId(content as any) };

    const bundleFile = path.join(fixturesDir, "bundle-a9.json");
    fs.writeFileSync(bundleFile, canonicalJsonStringify(tamperedBundle), "utf8");

    const result = OfflineAuditor.verifyEvidence(bundleFile);
    expect(result.status).toBe("FAILED");
    expect(result.failures.some((f) => f.code === "EVENT_INTEGRITY_FAILURE" || f.code === "REPLAY_VERIFICATION_FAILURE")).toBe(true);
  });

  it("A10: rejects checkpoint regression", () => {
    const regressedCheckpoints = [
      goldenCompletedBundle.checkpoints[1]!,
      goldenCompletedBundle.checkpoints[0]!,
    ];
    const tampered = {
      ...goldenCompletedBundle,
      checkpoints: regressedCheckpoints,
    };
    const { bundleId: _b, ...content } = tampered;
    const tamperedBundle = { ...content, bundleId: computeBundleId(content as any) };

    const bundleFile = path.join(fixturesDir, "bundle-a10.json");
    fs.writeFileSync(bundleFile, canonicalJsonStringify(tamperedBundle), "utf8");

    const result = OfflineAuditor.verifyEvidence(bundleFile);
    expect(result.status).toBe("FAILED");
    expect(result.failures.some((f) => f.code === "CHECKPOINT_INTEGRITY_FAILURE" || f.code === "REPLAY_VERIFICATION_FAILURE")).toBe(true);
  });

  it("A11: rejects unredacted secret leakage", () => {
    const leaked = {
      ...goldenCompletedBundle,
      actions: [
        {
          ...goldenCompletedBundle.actions[0]!,
          inputPayload: { apiKey: "sk-live-secret-unredacted-token-12345" },
        },
      ],
    };
    const { bundleId: _b, ...content } = leaked;
    const leakedBundle = { ...content, bundleId: computeBundleId(content as any) };

    const bundleFile = path.join(fixturesDir, "bundle-a11.json");
    fs.writeFileSync(bundleFile, canonicalJsonStringify(leakedBundle), "utf8");

    const result = OfflineAuditor.verifyEvidence(bundleFile);
    expect(result.status).toBe("FAILED");
    expect(result.failures.some((f) => f.code === "SECURITY_POLICY_FAILURE")).toBe(true);
  });

  it("A12: rejects false fourfold success claim when verification failed", () => {
    // Bundle claims COMPLETED, but verification failed because attempt failed with exitCode 1
    const failedAttempt = {
      ...goldenCompletedBundle.attempts[0]!,
      exitCode: 1,
      outputPayload: { exitCode: 1, stdout: "test suite failure" },
    };
    const failedFourfold = {
      ...goldenCompletedBundle,
      attempts: [failedAttempt],
      terminalState: {
        status: "COMPLETED" as const,
        completedAt: "2026-10-19T12:05:00.000Z",
      },
    };
    const { bundleId: _b, ...content } = failedFourfold;
    const tamperedBundle = { ...content, bundleId: computeBundleId(content as any) };

    const bundleFile = path.join(fixturesDir, "bundle-a12.json");
    fs.writeFileSync(bundleFile, canonicalJsonStringify(tamperedBundle), "utf8");

    const result = OfflineAuditor.verifyEvidence(bundleFile);
    expect(result.status).toBe("FAILED");
    expect(result.failures.some((f) => f.code === "FOURFOLD_COMPLETION_FAILURE" || f.code === "REPLAY_VERIFICATION_FAILURE")).toBe(true);
  });

  it("A13: rejects archive where terminal record references missing bundle", () => {
    const archiveDir = buildArchiveFixture({
      bundles: [goldenCompletedBundle],
      terminalRecord: {
        runId: goldenCompletedBundle.run.runId,
        bundleId: "1".repeat(64), // missing bundle
        terminalOutcome: "COMPLETED",
      },
    });

    const result = OfflineAuditor.verifyEvidence(archiveDir);
    expect(result.status).toBe("FAILED");
    expect(result.failures.some((f) => f.code === "TERMINAL_BUNDLE_MISSING")).toBe(true);
  });

  it("A14: rejects archive where terminal record hash is tampered with", () => {
    const archiveDir = buildArchiveFixture({
      bundles: [goldenCompletedBundle],
      terminalRecord: {
        runId: goldenCompletedBundle.run.runId,
        bundleId: goldenCompletedBundle.bundleId,
        terminalOutcome: "COMPLETED",
      },
      tamperTerminalHash: true,
    });

    const result = OfflineAuditor.verifyEvidence(archiveDir);
    expect(result.status).toBe("FAILED");
    expect(result.failures.some((f) => f.code === "INVALID_TERMINAL_RECORD")).toBe(true);
  });

  it("A15: rejects archive where terminal record disagrees with referenced bundle outcome", () => {
    const archiveDir = buildArchiveFixture({
      bundles: [goldenCompletedBundle],
      terminalRecord: {
        runId: goldenCompletedBundle.run.runId,
        bundleId: goldenCompletedBundle.bundleId,
        terminalOutcome: "FAILED", // Mismatch! Bundle has status COMPLETED
      },
    });

    const result = OfflineAuditor.verifyEvidence(archiveDir);
    expect(result.status).toBe("FAILED");
    expect(result.failures.some((f) => f.code === "TERMINAL_RECORD_MISMATCH")).toBe(true);
  });

  it("A16: rejects archive containing conflicting terminal outcomes for same run", () => {
    const archiveDir = buildArchiveFixture({
      bundles: [goldenCompletedBundle, goldenFailedBundle],
      terminalRecord: {
        runId: goldenCompletedBundle.run.runId,
        bundleId: goldenCompletedBundle.bundleId,
        terminalOutcome: "COMPLETED",
      },
    });

    const result = OfflineAuditor.verifyEvidence(archiveDir);
    expect(result.status).toBe("FAILED");
    expect(result.failures.some((f) => f.code === "TERMINAL_CONFLICT")).toBe(true);
  });

  it("A17: accepts archive with valid terminal record and matching accepted bundle", () => {
    const signed = signBundleWith(goldenCompletedBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const archiveDir = buildArchiveFixture({
      bundles: [signed],
      terminalRecord: {
        runId: signed.run.runId,
        bundleId: signed.bundleId,
        terminalOutcome: "COMPLETED",
      },
    });

    const result = OfflineAuditor.verifyEvidence(archiveDir, { keyring });
    expect(result.status).toBe("VERIFIED");
    expect(result.failures.length).toBe(0);
    expect(result.authoritativeTerminalBundleId).toBe(signed.bundleId);
  });

  it("A18: accepts archive with multiple valid non-terminal snapshots alongside terminal record", () => {
    const signedTerminal = signBundleWith(goldenCompletedBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const signedRunning1 = signBundleWith(intermediateSnapshot1, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const signedRunning2 = signBundleWith(intermediateSnapshot2, ["WORKER_PRODUCER", "SUPERVISOR"]);

    const archiveDir = buildArchiveFixture({
      bundles: [signedRunning1, signedRunning2, signedTerminal],
      terminalRecord: {
        runId: signedTerminal.run.runId,
        bundleId: signedTerminal.bundleId,
        terminalOutcome: "COMPLETED",
      },
    });

    const result = OfflineAuditor.verifyEvidence(archiveDir, { keyring });
    expect(result.status).toBe("VERIFIED");
    expect(result.bundleIds.length).toBe(3);
    expect(result.authoritativeTerminalBundleId).toBe(signedTerminal.bundleId);
    expect(result.failures.length).toBe(0);
  });

  it("A19: rejects unknown loose files in accepted or runs archive directories", () => {
    const archiveDir = buildArchiveFixture({
      bundles: [goldenCompletedBundle],
      terminalRecord: {
        runId: goldenCompletedBundle.run.runId,
        bundleId: goldenCompletedBundle.bundleId,
        terminalOutcome: "COMPLETED",
      },
      extraAcceptedFile: { name: "rogue-file.txt", content: "malicious payload" },
    });

    const result = OfflineAuditor.verifyEvidence(archiveDir);
    expect(result.status).toBe("FAILED");
    expect(result.failures.some((f) => f.code === "UNKNOWN_ARCHIVE_FILE" || f.code === "INVALID_ARCHIVE_FILE")).toBe(true);
  });

  it("A20: rejects path traversal attempts using ..", () => {
    const bundleFile = path.join(fixturesDir, "bundle-a20.json");
    fs.writeFileSync(bundleFile, canonicalJsonStringify(goldenCompletedBundle), "utf8");

    // Path traversal in filename or subpath
    expect(() => OfflineAuditor.verifyEvidence(bundleFile + "/../../escape.json")).toThrow();
  });

  it("A21: rejects symbolic links in evidence paths", () => {
    const realBundle = path.join(fixturesDir, "real-bundle.json");
    fs.writeFileSync(realBundle, canonicalJsonStringify(goldenCompletedBundle), "utf8");

    const symlinkPath = path.join(fixturesDir, "symlink-bundle.json");
    try {
      fs.symlinkSync(realBundle, symlinkPath);
      expect(() => OfflineAuditor.verifyEvidence(symlinkPath)).toThrow(/symlink/i);
    } catch (e: any) {
      // Windows non-admin without Developer Mode cannot create symlinks
      if (e.code === "EPERM" || e.message.includes("privilege not held")) {
        // Platform restriction: symlink cannot be created, test passes
        return;
      }
      throw e;
    }
  });

  it("A22: rejects oversized bundle payload exceeding 10 MB", () => {
    const largePayload = {
      ...goldenCompletedBundle,
      actions: [
        {
          ...goldenCompletedBundle.actions[0]!,
          inputPayload: { padding: "X".repeat(AUDIT_LIMITS.MAX_BUNDLE_BYTES + 1024) },
        },
      ],
    };
    const { bundleId: _b, ...content } = largePayload;
    const oversized = { ...content, bundleId: computeBundleId(content as any) };
    const bundleFile = path.join(fixturesDir, "bundle-a22.json");
    fs.writeFileSync(bundleFile, canonicalJsonStringify(oversized), "utf8");

    const result = OfflineAuditor.verifyEvidence(bundleFile);
    expect(result.status).toBe("FAILED");
    expect(result.failures.some((f) => f.code === "BUNDLE_TOO_LARGE")).toBe(true);
  });

  it("A23: rejects malformed unparseable JSON", () => {
    const bundleFile = path.join(fixturesDir, "bundle-a23.json");
    fs.writeFileSync(bundleFile, "{ not valid json syntax ... ", "utf8");

    const result = OfflineAuditor.verifyEvidence(bundleFile);
    expect(result.status).toBe("FAILED");
    expect(result.failures.some((f) => f.code === "INVALID_JSON")).toBe(true);
  });

  it("A24: rejects malformed keyring file", () => {
    const badKeyringFile = path.join(fixturesDir, "bad-keyring.json");
    fs.writeFileSync(badKeyringFile, "{ invalid keyring array ", "utf8");

    expect(() => loadTrustedKeyringFromFile(badKeyringFile)).toThrow(/Invalid JSON/);
  });

  it("A25: rejects bundle with insufficient threshold authorities (1-of-3 when 2 required)", () => {
    // Sign only with WORKER_PRODUCER (1 authority)
    const signed1 = signBundleWith(goldenCompletedBundle, ["WORKER_PRODUCER"]);
    const bundleFile = path.join(fixturesDir, "bundle-a25.json");
    fs.writeFileSync(bundleFile, canonicalJsonStringify(signed1), "utf8");

    const result = OfflineAuditor.verifyEvidence(bundleFile, { keyring, requireKeyring: true });
    expect(result.status).toBe("FAILED");
    expect(result.thresholdSatisfied).toBe(false);
    expect(result.failures.some((f) => f.code === "INSUFFICIENT_AUTHORITIES" || f.code === "THRESHOLD_NOT_MET")).toBe(true);
  });

  it("A26: rejects duplicate authority signatures attempting to meet threshold (Worker + Worker)", () => {
    // Generate second key for same authority
    const secondWorkerKey = EvidenceSigner.generateKeyPair();
    keyring.registerKey({
      keyId: "worker-key-2",
      publicKey: secondWorkerKey.publicKey,
      authorityId: "WORKER_PRODUCER",
      role: "WORKER_PRODUCER",
      status: "TRUSTED",
    });

    const sig1 = EvidenceSigner.sign(goldenCompletedBundle, workerKey.privateKey, "worker-key", { authorityId: "WORKER_PRODUCER" });
    const sig2 = EvidenceSigner.sign(goldenCompletedBundle, secondWorkerKey.privateKey, "worker-key-2", { authorityId: "WORKER_PRODUCER" });

    const duplicateAuthorityBundle = Object.freeze({
      ...goldenCompletedBundle,
      signature: sig1.signature,
      signatures: Object.freeze([sig1.signature!, sig2.signature!]),
    });

    const bundleFile = path.join(fixturesDir, "bundle-a26.json");
    fs.writeFileSync(bundleFile, canonicalJsonStringify(duplicateAuthorityBundle), "utf8");

    const result = OfflineAuditor.verifyEvidence(bundleFile, { keyring });
    expect(result.status).toBe("FAILED");
    expect(result.failures.some((f) => f.code === "DUPLICATE_AUTHORITY" || f.code === "THRESHOLD_NOT_MET")).toBe(true);
  });

  it("A27: rejects terminal record pointing to wrong runId", () => {
    const archiveDir = buildArchiveFixture({
      bundles: [goldenCompletedBundle],
      terminalRecord: {
        runId: "run-different-id",
        bundleId: goldenCompletedBundle.bundleId,
        terminalOutcome: "COMPLETED",
      },
    });

    const result = OfflineAuditor.verifyEvidence(archiveDir);
    expect(result.status).toBe("FAILED");
    expect(result.failures.some((f) => f.code === "TERMINAL_RECORD_MISMATCH")).toBe(true);
  });

  it("A28: rejects terminal record pointing to wrong bundleId", () => {
    const signedFailed = signBundleWith(goldenFailedBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const signedCompleted = signBundleWith(goldenCompletedBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);

    const archiveDir = buildArchiveFixture({
      bundles: [signedCompleted],
      terminalRecord: {
        runId: signedCompleted.run.runId,
        bundleId: signedFailed.bundleId, // wrong bundleId
        terminalOutcome: "COMPLETED",
      },
    });

    const result = OfflineAuditor.verifyEvidence(archiveDir, { keyring });
    expect(result.status).toBe("FAILED");
    expect(result.failures.some((f) => f.code === "TERMINAL_BUNDLE_MISSING")).toBe(true);
  });

  it("A29: rejects archive missing accepted/ directory", () => {
    const archiveDir = buildArchiveFixture({
      bundles: [goldenCompletedBundle],
      omitAcceptedDir: true,
    });

    const result = OfflineAuditor.verifyEvidence(archiveDir);
    expect(result.status).toBe("FAILED");
    expect(result.failures.some((f) => f.code === "MISSING_ACCEPTED_DIRECTORY")).toBe(true);
  });

  it("A30: verifies byte-identical deterministic repeated verification output", () => {
    const signed = signBundleWith(goldenCompletedBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const archiveDir = buildArchiveFixture({
      bundles: [signed],
      terminalRecord: {
        runId: signed.run.runId,
        bundleId: signed.bundleId,
        terminalOutcome: "COMPLETED",
      },
    });

    const res1 = OfflineAuditor.verifyEvidence(archiveDir, { keyring });
    const res2 = OfflineAuditor.verifyEvidence(archiveDir, { keyring });

    const json1 = canonicalJsonStringify(res1);
    const json2 = canonicalJsonStringify(res2);

    expect(json1).toBe(json2);
  });

  // ===========================================================================
  // SECTION 2: CLEAN-ROOM PROPERTY
  // ===========================================================================

  it("Clean-room: operates with zero SQLite, zero Docker, zero Ollama, zero network", () => {
    // Assert that offline-auditor module imports neither SQLite nor runtime coordinator
    const auditorModulePath = path.resolve("src/application/offline-auditor.ts");
    const auditorSource = fs.readFileSync(auditorModulePath, "utf8");

    expect(auditorSource).not.toContain("better-sqlite3");
    expect(auditorSource).not.toContain("sqlite");
    expect(auditorSource).not.toContain("docker");
    expect(auditorSource).not.toContain("ollama");
    expect(auditorSource).not.toContain("RunCoordinator");
    expect(auditorSource).not.toContain("WorkerRuntime");
    expect(auditorSource).not.toContain("http");
    expect(auditorSource).not.toContain("fetch(");
  });

  // ===========================================================================
  // SECTION 3: INSPECT COMMAND
  // ===========================================================================

  it("Inspect: extracts safe metadata without asserting validity and includes unverified disclaimer", () => {
    const bundleFile = path.join(fixturesDir, "inspect-bundle.json");
    fs.writeFileSync(bundleFile, canonicalJsonStringify(goldenCompletedBundle), "utf8");

    const inspection = OfflineAuditor.inspectEvidence(bundleFile);
    expect(inspection.status).toBe("INSPECTED");
    expect(inspection.runIds).toContain(goldenCompletedBundle.run.runId);
    expect(inspection.bundles[0]?.bundleId).toBe(goldenCompletedBundle.bundleId);
    expect(inspection.disclaimer).toBe("Inspection only — evidence has NOT been verified.");

    const humanText = OfflineAuditor.formatHumanInspection(inspection);
    expect(humanText).toContain("Emerald Evidence Inspection (Unverified)");
    expect(humanText).toContain("Inspection only — evidence has NOT been verified.");
  });

  // ===========================================================================
  // SECTION 4: INDEPENDENT PROCESS CLI EXECUTION
  // ===========================================================================

  it("CLI Process: executes emerald-audit CLI as an independent OS process", () => {
    const signed = signBundleWith(goldenCompletedBundle, ["WORKER_PRODUCER", "SUPERVISOR"]);
    const bundleFile = path.join(fixturesDir, "cli-valid-bundle.json");
    fs.writeFileSync(bundleFile, canonicalJsonStringify(signed), "utf8");

    const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";

    function runAuditCli(subArgs: string[]): string {
      const allArgs = ["tsx", "scripts/emerald-audit.ts", ...subArgs].map((a) =>
        a.includes(" ") ? `"${a}"` : a
      );
      return execFileSync(npxCmd, allArgs, { encoding: "utf8", shell: true });
    }

    // 1. Verify command with --json and --keyring -> Exit code 0
    const stdout = runAuditCli(["verify", bundleFile, "--keyring", keyringPath, "--json"]);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("VERIFIED");
    expect(parsed.thresholdSatisfied).toBe(true);

    // 2. Inspect command -> Exit code 0
    const inspectStdout = runAuditCli(["inspect", bundleFile, "--json"]);
    const inspectParsed = JSON.parse(inspectStdout);
    expect(inspectParsed.status).toBe("INSPECTED");
    expect(inspectParsed.disclaimer).toContain("Inspection only");

    // 3. Verification failure -> Exit code 1
    const tamperedFile = path.join(fixturesDir, "cli-tampered-bundle.json");
    fs.writeFileSync(tamperedFile, canonicalJsonStringify({ ...signed, bundleId: "0".repeat(64) }), "utf8");

    try {
      runAuditCli(["verify", tamperedFile]);
      expect.fail("Should have exited with code 1");
    } catch (err: any) {
      expect(err.status).toBe(AUDIT_EXIT_CODES.VERIFICATION_FAILED);
    }

    // 4. Invalid input (missing target) -> Exit code 2
    try {
      runAuditCli(["verify", "non-existent-path-12345.json"]);
      expect.fail("Should have exited with code 2");
    } catch (err: any) {
      expect(err.status).toBe(AUDIT_EXIT_CODES.INVALID_INPUT);
    }
  });
});
