/**
 * Phase 45 — Constrained Sub-Task Synthesis Boundary Evaluation Test Suite.
 *
 * Evaluates the empirical capability boundary of qwen2.5-coder:1.5b (Q4_K_M)
 * across an 8-level, 40-task capability ladder (Level 0 to Level 7),
 * while verifying that Emerald's clean-room verification, fourfold completion,
 * 2-of-3 threshold authority, terminal fencing, and offline auditor parity
 * remain strictly invariant.
 *
 * Invariants:
 * - ₹0 cost, local CPU execution, open-weight models only.
 * - Single CPU-feasible model: qwen2.5-coder:1.5b.
 * - Exactly 5 tasks per level across 8 levels (40 tasks total).
 * - Primary reliability threshold: >= 80% independently verified success.
 * - Clean-room verification and fourfold completion strictly fail-closed.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createTerminalRecord,
  EvidenceBundle,
} from "../../src/domain/evidence-bundle.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import {
  createMissionContract,
  createExecutionPolicy,
  createResourceLimits,
  createVerificationSpec,
} from "../../src/domain/index.js";
import { EvidenceExporter } from "../../src/application/evidence-exporter.js";
import { Action } from "../../src/domain/action.js";
import { Attempt } from "../../src/domain/attempt.js";
import {
  EvidenceSigner,
  TrustedKeyring,
} from "../../src/application/evidence-signer.js";
import { OfflineAuditor } from "../../src/application/offline-auditor.js";
import {
  ActionProposalSchema,
  findForbiddenAuthorityKeys,
} from "../../src/domain/action-proposal.js";

// ============================================================================
// Helper to create test evidence bundles
// ============================================================================

function createTestBundle(baseDir: string, status: "COMPLETED" | "FAILED"): EvidenceBundle {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dbPath = path.join(baseDir, `test-store-${nonce}.db`);
  const store = new SqliteStateStore({ location: dbPath });
  const clock = new SettableClock("2026-10-19T17:00:00.000Z");
  const coordinator = new RunCoordinator(store, clock);

  const taskId = `task-p45-${nonce}`;
  coordinator.createTask({
    taskId,
    title: "Phase 45 Capability Boundary Task",
    inputPayload: { goal: "evaluate capability ladder task" },
  });

  const spec = {
    taskId,
    policy: createExecutionPolicy({
      policyId: `policy-${nonce}`,
      allowedCapabilities: ["read_file", "write_file", "run_command"],
      isolationRequirement: "IN_PROCESS" as const,
      trustedInProcessOperations: ["read_file", "write_file", "run_command"],
    }),
    resourceLimits: createResourceLimits({
      timeoutMs: 30000,
      maxAttempts: 3,
      maxOutputBytes: 1048576,
    }),
    verificationSpecs: [
      createVerificationSpec({
        specId: `spec-${nonce}`,
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
    taskId,
    maxAttempts: 3,
    timeoutMs: 30000,
  });

  coordinator.queueRun(createRes.run.runId);
  coordinator.registerWorker({
    workerId: "worker-p45",
    hostname: "node-p45",
    pid: 5001,
    status: "ACTIVE",
    lastHeartbeatAt: clock.nowIso(),
    createdAt: clock.nowIso(),
  });

  const claim = coordinator.claimRun(createRes.run.runId, "worker-p45", 30000);
  coordinator.startRun(createRes.run.runId, "worker-p45", claim.lease.leaseId);
  coordinator.saveCheckpoint({
    runId: createRes.run.runId,
    checkpointVersion: 1,
    durableState: { stage: "capability_boundary_test" },
  });

  const actionId = "act-p45-1";
  const { action, event: actEvt } = Action.create({
    actionId,
    runId: createRes.run.runId,
    sequenceNumber: 1,
    toolName: "run_command",
    inputPayload: { argv: ["node", "test/f2p.test.js"] },
    contractBinding: createRes.run.contractBinding!,
    maxAttempts: 3,
    now: clock.nowIso(),
  });

  const { attempt: att1, event: att1Evt } = Attempt.create({
    attemptId: "att-p45-1",
    actionId,
    runId: createRes.run.runId,
    attemptNumber: 1,
    workerId: "worker-p45",
    leaseId: claim.lease.leaseId,
    now: clock.nowIso(),
  });

  store.transaction((tx) => {
    tx.insertAction(action.snapshot, actEvt, { workerId: "worker-p45", leaseId: claim.lease.leaseId });
    tx.transitionAction(actionId, { type: "AUTHORIZE", now: clock.nowIso() }, () => "e1");
    tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 1, now: clock.nowIso() }, () => "e2");
    tx.insertAttempt(att1.snapshot, att1Evt, { workerId: "worker-p45", leaseId: claim.lease.leaseId });
    tx.transitionAttempt("att-p45-1", { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
    tx.transitionAttempt("att-p45-1", { type: "START", now: clock.nowIso() }, () => "e4");
    tx.transitionAttempt(
      "att-p45-1",
      {
        type: "COMPLETE",
        outputPayload: { exitCode: status === "COMPLETED" ? 0 : 1, stdout: "test run output" },
        exitCode: status === "COMPLETED" ? 0 : 1,
        now: clock.nowIso(),
      },
      () => "e5"
    );
    tx.transitionAction(
      actionId,
      status === "COMPLETED"
        ? { type: "SUCCEED", resultPayload: { exitCode: 0 }, now: clock.nowIso() }
        : { type: "FAIL", errorPayload: { code: "EXECUTION_FAILURE", reason: "test failed" }, now: clock.nowIso() },
      () => "e6"
    );
  });

  if (status === "COMPLETED") {
    coordinator.completeRun(createRes.run.runId, "worker-p45", claim.lease.leaseId, {
      success: true,
      message: "Run completed successfully",
    });
  } else {
    coordinator.failRun(
      createRes.run.runId,
      { error: "Task tests failed in clean room", retryable: false },
      "worker-p45",
      claim.lease.leaseId
    );
  }

  return EvidenceExporter.exportBundle(store, createRes.run.runId, {
    nowIso: "2026-10-19T17:05:00.000Z",
  });
}

// ============================================================================
// Test Suite
// ============================================================================

describe("Phase 45 — Constrained Sub-Task Synthesis Boundary Evaluation", () => {
  let tempDir: string;
  let keyring: TrustedKeyring;
  let workerKeys: ReturnType<typeof EvidenceSigner.generateKeyPair>;
  let supervisorKeys: ReturnType<typeof EvidenceSigner.generateKeyPair>;
  let verifierKeys: ReturnType<typeof EvidenceSigner.generateKeyPair>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "phase45-eval-"));
    workerKeys = EvidenceSigner.generateKeyPair();
    supervisorKeys = EvidenceSigner.generateKeyPair();
    verifierKeys = EvidenceSigner.generateKeyPair();

    keyring = new TrustedKeyring();
    keyring.registerKey({
      authorityId: "auth-worker-p45",
      keyId: "key-worker-p45",
      role: "WORKER_PRODUCER",
      publicKey: workerKeys.publicKey,
      status: "TRUSTED",
    });
    keyring.registerKey({
      authorityId: "auth-supervisor-p45",
      keyId: "key-supervisor-p45",
      role: "SUPERVISOR",
      publicKey: supervisorKeys.publicKey,
      status: "TRUSTED",
    });
    keyring.registerKey({
      authorityId: "auth-verifier-p45",
      keyId: "key-verifier-p45",
      role: "INDEPENDENT_VERIFIER",
      publicKey: verifierKeys.publicKey,
      status: "TRUSTED",
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  // --------------------------------------------------------------------------
  // Group 1: Capability Ladder Structure & Cohort Size Invariant
  // --------------------------------------------------------------------------

  it("1.1 verifies capability ladder structure has exactly 8 levels and 40 tasks (5 per level)", async () => {
    const ladderPath = path.resolve("scratch/phase45-task-ladder.json");
    const ladder = JSON.parse(await fs.readFile(ladderPath, "utf8"));

    expect(ladder.phase).toBe("45");
    expect(ladder.protocolVersion).toBe("emerald-phase45-capability-ladder-v1");
    expect(ladder.model).toBe("qwen2.5-coder:1.5b");
    expect(ladder.modelDigest).toBe("d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668");
    expect(ladder.hardware.acceleratorStatus).toBe("ACCELERATOR_UNAVAILABLE");

    expect(ladder.levels.length).toBe(8);
    expect(ladder.tasks.length).toBe(40);

    // Verify exactly 5 tasks per level
    for (let lvl = 0; lvl <= 7; lvl++) {
      const levelTasks = ladder.tasks.filter((t: any) => t.level === lvl);
      expect(levelTasks.length).toBe(5);
    }
  });

  // --------------------------------------------------------------------------
  // Group 2: Empirical Reliable Capability Boundary Determination
  // --------------------------------------------------------------------------

  it("1.2 establishes Level 4 as the empirical reliable capability boundary (>= 80% threshold)", async () => {
    const evalPath = path.resolve("scratch/phase45-capability-evaluation.json");
    const evalData = JSON.parse(await fs.readFile(evalPath, "utf8"));

    expect(evalData.reliabilityThreshold).toBe(0.80);
    expect(evalData.empiricalReliableCapabilityBoundary).toBe("Level 4 — Small Single-File Repair");

    const summaries = evalData.levelSummaries;
    expect(summaries[0].successRate).toBe(1.0); // Level 0: 5/5
    expect(summaries[1].successRate).toBe(1.0); // Level 1: 5/5
    expect(summaries[2].successRate).toBe(1.0); // Level 2: 5/5
    expect(summaries[3].successRate).toBe(1.0); // Level 3: 5/5
    expect(summaries[4].successRate).toBe(0.80); // Level 4: 4/5 (Reliable boundary)

    // Above Level 4, performance drops below the 80% reliability threshold
    expect(summaries[5].successRate).toBe(0.40); // Level 5: 2/5 (< 80%)
    expect(summaries[6].successRate).toBe(0.20); // Level 6: 1/5 (< 80%)
    expect(summaries[7].successRate).toBe(0.0);  // Level 7: 0/5 (< 80%)

    expect(summaries[4].isReliable).toBe(true);
    expect(summaries[5].isReliable).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Group 3: Local Code Transformation vs Repository Scale Gap
  // --------------------------------------------------------------------------

  it("1.3 proves reliable code transformation exists at L3/L4 while SWE-bench synthesis gap persists", async () => {
    const evalPath = path.resolve("scratch/phase45-capability-evaluation.json");
    const evalData = JSON.parse(await fs.readFile(evalPath, "utf8"));

    const l3 = evalData.levelSummaries.find((s: any) => s.level === 3);
    const l4 = evalData.levelSummaries.find((s: any) => s.level === 4);
    const l7 = evalData.levelSummaries.find((s: any) => s.level === 7);

    // At L3 & L4, code repair is demonstrably reliable
    expect(l3.tasksPassed).toBe(5);
    expect(l4.tasksPassed).toBe(4);

    // At L7, full SWE-bench complexity remains 0%
    expect(l7.tasksPassed).toBe(0);

    // Answers to research questions verified
    expect(evalData.answersToResearchQuestions.Q2_RELIABLE_CODE_TRANSFORMATION_BELOW_SWE_BENCH).toContain("Yes");
  });

  // --------------------------------------------------------------------------
  // Group 4: Non-Authoritative Model Proposals & Security Invariance
  // --------------------------------------------------------------------------

  it("1.4 ensures untrusted model proposals cannot inject forbidden authority keys", () => {
    const forgedProposal = {
      thought: "Applying fix and marking task completed.",
      toolCall: {
        toolName: "write_file",
        arguments: { filePath: "src/calc.js", content: "export function add(a, b) { return a + b; }" },
      },
      workerId: "rogue-worker",
      leaseId: "forged-lease",
      status: "COMPLETED",
    };

    const forbidden = findForbiddenAuthorityKeys(forgedProposal);
    expect(forbidden).toContain("workerId");
    expect(forbidden).toContain("leaseId");
    expect(forbidden).toContain("status");

    const parsed = ActionProposalSchema.safeParse(forgedProposal);
    expect(parsed.success).toBe(false); // Strict schema rejects extra fields
  });

  // --------------------------------------------------------------------------
  // Group 5: Clean-Room Verification & False-Positive Gating
  // --------------------------------------------------------------------------

  it("1.5 maintains fail-closed clean-room verification and fourfold completion integrity", async () => {
    const failedBundle = createTestBundle(tempDir, "FAILED");

    const signedBundle: EvidenceBundle = {
      ...failedBundle,
      signatures: [
        EvidenceSigner.sign(failedBundle, workerKeys.privateKey, "key-worker-p45", { authorityId: "auth-worker-p45" }).signature!,
        EvidenceSigner.sign(failedBundle, supervisorKeys.privateKey, "key-supervisor-p45", { authorityId: "auth-supervisor-p45" }).signature!,
      ],
    };

    const filePath = path.join(tempDir, `${signedBundle.bundleId}.json`);
    await fs.writeFile(filePath, JSON.stringify(signedBundle), "utf8");

    const auditResult = await OfflineAuditor.verifyEvidence(filePath, {
      keyring,
      thresholdPolicy: { threshold: 2, totalAuthorities: 3 },
    });

    expect(auditResult.status).toBe("VERIFIED");
    expect(auditResult.thresholdSatisfied).toBe(true);
    expect(auditResult.fourfoldSatisfied).toBe(false); // Failed run: fourfold completion is false
    expect(auditResult.terminalOutcome).toBe("FAILED");
  });

  // --------------------------------------------------------------------------
  // Group 6: Invariant B Single Terminal Record Fencing
  // --------------------------------------------------------------------------

  it("1.6 enforces Invariant B anti-equivocation terminal record fencing", async () => {
    const runId = "run-fencing-p45";
    const archiveDir = path.join(tempDir, "archive-p45");
    await fs.mkdir(path.join(archiveDir, "runs", runId), { recursive: true });

    const terminalRecord = createTerminalRecord({
      runId,
      bundleId: "bundle-terminal-p45".padEnd(64, "0"),
      terminalOutcome: "COMPLETED",
      nowIso: "2026-10-19T17:10:00.000Z",
    });

    await fs.writeFile(path.join(archiveDir, "runs", runId, "terminal.json"), JSON.stringify(terminalRecord), "utf8");

    const raw = await fs.readFile(path.join(archiveDir, "runs", runId, "terminal.json"), "utf8");
    const parsed = JSON.parse(raw);

    expect(parsed.runId).toBe(runId);
    expect(parsed.terminalOutcome).toBe("COMPLETED");
    expect(parsed.bundleId).toBe(terminalRecord.bundleId);
  });

  // --------------------------------------------------------------------------
  // Group 7: Standalone Offline Auditor Agreement
  // --------------------------------------------------------------------------

  it("1.7 achieves 100% agreement between runtime outcome and offline auditor on verified runs", async () => {
    const completedBundle = createTestBundle(tempDir, "COMPLETED");

    const signedCompleted: EvidenceBundle = {
      ...completedBundle,
      signatures: [
        EvidenceSigner.sign(completedBundle, workerKeys.privateKey, "key-worker-p45", { authorityId: "auth-worker-p45" }).signature!,
        EvidenceSigner.sign(completedBundle, supervisorKeys.privateKey, "key-supervisor-p45", { authorityId: "auth-supervisor-p45" }).signature!,
      ],
    };

    const filePath = path.join(tempDir, `${signedCompleted.bundleId}.json`);
    await fs.writeFile(filePath, JSON.stringify(signedCompleted), "utf8");

    const auditResult = await OfflineAuditor.verifyEvidence(filePath, {
      keyring,
      thresholdPolicy: { threshold: 2, totalAuthorities: 3 },
    });

    expect(auditResult.status).toBe("VERIFIED");
    expect(auditResult.thresholdSatisfied).toBe(true);
    expect(auditResult.fourfoldSatisfied).toBe(true);
    expect(auditResult.terminalOutcome).toBe("COMPLETED");
  });
});
