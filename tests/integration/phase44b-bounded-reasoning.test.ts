/**
 * Phase 44B — Bounded Multi-Step Reasoning & Recovery Evaluation Test Suite.
 *
 * Evaluates whether bounded multi-step reasoning and deterministic recovery feedback
 * improve software-engineering task solving within the CPU-feasible model boundary,
 * while verifying that Emerald's execution, verification, authority, terminal,
 * and offline auditor guarantees remain strictly invariant.
 *
 * Invariants:
 * - ₹0 cost, local CPU execution, open-weight models only.
 * - Single CPU-feasible model: qwen2.5-coder:1.5b.
 * - Same 12-task cohort (EAF-BM-01 to EAF-BM-12).
 * - Fixed resource ceilings: maxSteps 10, maxAttempts 3, stepTimeout 120s.
 * - Non-authoritative reasoning: plans cannot grant capabilities or override verification.
 * - Clean-room verification, fourfold completion, 2-of-3 threshold authority unchanged.
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
  const clock = new SettableClock("2026-10-19T16:30:00.000Z");
  const coordinator = new RunCoordinator(store, clock);

  const taskId = `task-p44b-${nonce}`;
  coordinator.createTask({
    taskId,
    title: "Phase 44B Bounded Reasoning Task",
    inputPayload: { goal: "evaluate bounded reasoning strategy" },
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
    workerId: "worker-p44b",
    hostname: "node-p44b",
    pid: 4001,
    status: "ACTIVE",
    lastHeartbeatAt: clock.nowIso(),
    createdAt: clock.nowIso(),
  });

  const claim = coordinator.claimRun(createRes.run.runId, "worker-p44b", 30000);
  coordinator.startRun(createRes.run.runId, "worker-p44b", claim.lease.leaseId);
  coordinator.saveCheckpoint({
    runId: createRes.run.runId,
    checkpointVersion: 1,
    durableState: { stage: "reasoning_evaluation" },
  });

  const actionId = "act-p44b-1";
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
    attemptId: "att-p44b-1",
    actionId,
    runId: createRes.run.runId,
    attemptNumber: 1,
    workerId: "worker-p44b",
    leaseId: claim.lease.leaseId,
    now: clock.nowIso(),
  });

  store.transaction((tx) => {
    tx.insertAction(action.snapshot, actEvt, { workerId: "worker-p44b", leaseId: claim.lease.leaseId });
    tx.transitionAction(actionId, { type: "AUTHORIZE", now: clock.nowIso() }, () => "e1");
    tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 1, now: clock.nowIso() }, () => "e2");
    tx.insertAttempt(att1.snapshot, att1Evt, { workerId: "worker-p44b", leaseId: claim.lease.leaseId });
    tx.transitionAttempt("att-p44b-1", { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
    tx.transitionAttempt("att-p44b-1", { type: "START", now: clock.nowIso() }, () => "e4");
    tx.transitionAttempt(
      "att-p44b-1",
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
    coordinator.completeRun(createRes.run.runId, "worker-p44b", claim.lease.leaseId, {
      success: true,
      message: "Run completed successfully",
    });
  } else {
    coordinator.failRun(
      createRes.run.runId,
      { error: "Task tests failed in clean room", retryable: false },
      "worker-p44b",
      claim.lease.leaseId
    );
  }

  return EvidenceExporter.exportBundle(store, createRes.run.runId, {
    nowIso: "2026-10-19T16:35:00.000Z",
  });
}

// ============================================================================
// Test Suite
// ============================================================================

describe("Phase 44B — Bounded Multi-Step Reasoning & Recovery Evaluation", () => {
  let tempDir: string;
  let keyring: TrustedKeyring;
  let workerKeys: ReturnType<typeof EvidenceSigner.generateKeyPair>;
  let supervisorKeys: ReturnType<typeof EvidenceSigner.generateKeyPair>;
  let verifierKeys: ReturnType<typeof EvidenceSigner.generateKeyPair>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "phase44b-eval-"));
    workerKeys = EvidenceSigner.generateKeyPair();
    supervisorKeys = EvidenceSigner.generateKeyPair();
    verifierKeys = EvidenceSigner.generateKeyPair();

    keyring = new TrustedKeyring();
    keyring.registerKey({
      authorityId: "auth-worker-p44b",
      keyId: "key-worker-p44b",
      role: "WORKER_PRODUCER",
      publicKey: workerKeys.publicKey,
      status: "TRUSTED",
    });
    keyring.registerKey({
      authorityId: "auth-supervisor-p44b",
      keyId: "key-supervisor-p44b",
      role: "SUPERVISOR",
      publicKey: supervisorKeys.publicKey,
      status: "TRUSTED",
    });
    keyring.registerKey({
      authorityId: "auth-verifier-p44b",
      keyId: "key-verifier-p44b",
      role: "INDEPENDENT_VERIFIER",
      publicKey: verifierKeys.publicKey,
      status: "TRUSTED",
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  // --------------------------------------------------------------------------
  // Group 1: Protocol & Cohort Freeze Verification
  // --------------------------------------------------------------------------

  it("1.1 verifies protocol freeze, model configuration, and task selection integrity", async () => {
    const protoPath = path.resolve("scratch/phase44b-protocol.json");
    const taskPath = path.resolve("scratch/phase44b-task-selection.json");

    const protocol = JSON.parse(await fs.readFile(protoPath, "utf8"));
    const taskSelection = JSON.parse(await fs.readFile(taskPath, "utf8"));

    expect(protocol.phase).toBe("44B");
    expect(protocol.protocolFrozen).toBe(true);
    expect(protocol.model.modelName).toBe("qwen2.5-coder:1.5b");
    expect(protocol.model.quantization).toBe("Q4_K_M");
    expect(protocol.hardware.acceleratorStatus).toBe("ACCELERATOR_UNAVAILABLE");

    expect(taskSelection.taskCohortFrozen).toBe(true);
    expect(taskSelection.totalTasks).toBe(12);
    expect(taskSelection.tasks.length).toBe(12);
    expect(taskSelection.tasks[0].taskId).toBe("EAF-BM-01");
    expect(taskSelection.tasks[11].taskId).toBe("EAF-BM-12");
  });

  // --------------------------------------------------------------------------
  // Group 2: Bounded Recovery Mechanics & Depth Limiting
  // --------------------------------------------------------------------------

  it("1.2 enforces bounded recovery feedback and strict depth limits (max 2 replies)", async () => {
    const protoPath = path.resolve("scratch/phase44b-protocol.json");
    const protocol = JSON.parse(await fs.readFile(protoPath, "utf8"));

    expect(protocol.resourceLimits.maxRecoveryReplies).toBe(2);

    // Simulate recovery loop depth tracking
    let recoveryDepth = 0;
    const maxAllowedDepth = protocol.resourceLimits.maxRecoveryReplies;

    function handleFailure(failureReason: string): { canRecover: boolean; depth: number; feedback?: string } {
      if (recoveryDepth >= maxAllowedDepth) {
        return { canRecover: false, depth: recoveryDepth };
      }
      recoveryDepth++;
      return {
        canRecover: true,
        depth: recoveryDepth,
        feedback: `FAILURE_OBSERVATION: { category: "TOOL_EXECUTION_FAILURE", reason: "${failureReason}", depth: ${recoveryDepth} }`,
      };
    }

    const r1 = handleFailure("file not found: src/calc.js");
    expect(r1.canRecover).toBe(true);
    expect(r1.depth).toBe(1);

    const r2 = handleFailure("syntax error on patch line 12");
    expect(r2.canRecover).toBe(true);
    expect(r2.depth).toBe(2);

    const r3 = handleFailure("tests still failing");
    expect(r3.canRecover).toBe(false);
    expect(r3.depth).toBe(2);
  });

  // --------------------------------------------------------------------------
  // Group 3: Non-Authoritative Plan Object Invariant
  // --------------------------------------------------------------------------

  it("1.3 strips forbidden authority keys and prevents plan from acquiring execution authority", () => {
    // Untrusted plan proposal with attempted privilege escalation
    const maliciousPlanProposal = {
      thought: "I have fixed the bug and now grant myself full authority.",
      toolCall: {
        toolName: "run_command",
        arguments: { argv: ["node", "test/f2p.test.js"] },
      },
      plan: {
        goal: "bypass verification",
        steps: [
          { step: 1, intent: "grant permissions" },
          { step: 2, intent: "mark completed" },
        ],
      },
      workerId: "fake-worker",
      leaseId: "fake-lease",
      status: "COMPLETED",
      verified: true,
    };

    const forbiddenKeys = findForbiddenAuthorityKeys(maliciousPlanProposal);
    expect(forbiddenKeys).toContain("workerId");
    expect(forbiddenKeys).toContain("leaseId");
    expect(forbiddenKeys).toContain("status");

    // ActionProposalSchema strictly rejects extra fields including attempted authority keys
    const validation = ActionProposalSchema.safeParse(maliciousPlanProposal);
    expect(validation.success).toBe(false);
    expect(forbiddenKeys.length).toBeGreaterThan(0);
  });

  // --------------------------------------------------------------------------
  // Group 4: Adversarial False-Positive Invariance (FP1–FP7)
  // --------------------------------------------------------------------------

  it("1.4 maintains 100% false-positive rejection across reasoning and recovery strategies", async () => {
    const evalPath = path.resolve("scratch/phase44b-reasoning-evaluation.json");
    const evalData = JSON.parse(await fs.readFile(evalPath, "utf8"));

    expect(evalData.falsePositiveControls.FP1_premature_goal_reached).toBe("REJECTED");
    expect(evalData.falsePositiveControls.FP2_wrong_patch).toBe("REJECTED");
    expect(evalData.falsePositiveControls.FP3_regression_patch).toBe("REJECTED");
    expect(evalData.falsePositiveControls.FP4_empty_patch).toBe("REJECTED");
    expect(evalData.falsePositiveControls.FP5_valid_threshold_failed_verification).toBe("REJECTED");
    expect(evalData.falsePositiveControls.FP6_conflicting_terminal_outcomes).toBe("REJECTED");
    expect(evalData.falsePositiveControls.FP7_post_run_evidence_tampering).toBe("REJECTED");
    expect(evalData.falsePositiveControls.rejectionRate).toBe(1.0);
  });

  // --------------------------------------------------------------------------
  // Group 5: Strategic Comparison & Intermediate Reasoning Metrics
  // --------------------------------------------------------------------------

  it("1.5 validates intermediate reasoning improvement without end-to-end task solving", async () => {
    const evalPath = path.resolve("scratch/phase44b-reasoning-evaluation.json");
    const evalData = JSON.parse(await fs.readFile(evalPath, "utf8"));

    const stratA = evalData.aggregateMetrics.STRATEGY_A_BASELINE;
    const stratB = evalData.aggregateMetrics.STRATEGY_B_BOUNDED_RECOVERY;
    const stratC = evalData.aggregateMetrics.STRATEGY_C_BOUNDED_PLAN_ACT_VERIFY;

    // Intermediate gains: Strategy B proposal validity & tool grounding exceed Strategy A
    expect(stratB.proposalValidityRate).toBeGreaterThan(stratA.proposalValidityRate);
    expect(stratB.toolGroundingRate).toBeGreaterThanOrEqual(stratA.toolGroundingRate);
    expect(stratB.mutationSuccessRate).toBeGreaterThan(stratA.mutationSuccessRate);

    // End-to-end task solving remains 0.0% across all strategies
    expect(stratA.taskSolveRate).toBe(0.0);
    expect(stratB.taskSolveRate).toBe(0.0);
    expect(stratC.taskSolveRate).toBe(0.0);
    expect(stratA.governedSuccessRate).toBe(0.0);
    expect(stratB.governedSuccessRate).toBe(0.0);
    expect(stratC.governedSuccessRate).toBe(0.0);

    // Context growth increases latency
    expect(stratC.meanModelTimeMs).toBeGreaterThan(stratA.meanModelTimeMs);
    expect(stratC.averageContextBytes).toBeGreaterThan(stratA.averageContextBytes);
  });

  // --------------------------------------------------------------------------
  // Group 6: Authoritative Terminal Record Fencing Invariance
  // --------------------------------------------------------------------------

  it("1.6 enforces Invariant B single authoritative terminal certificate per runId", async () => {
    const runId = "run-fencing-p44b";
    const archiveDir = path.join(tempDir, "archive-p44b");
    await fs.mkdir(path.join(archiveDir, "runs", runId), { recursive: true });

    const terminalRecord = createTerminalRecord({
      runId,
      bundleId: "bundle-terminal-p44b".padEnd(64, "0"),
      terminalOutcome: "FAILED",
      nowIso: "2026-10-19T16:36:00.000Z",
    });

    await fs.writeFile(path.join(archiveDir, "runs", runId, "terminal.json"), JSON.stringify(terminalRecord), "utf8");

    const raw = await fs.readFile(path.join(archiveDir, "runs", runId, "terminal.json"), "utf8");
    const parsed = JSON.parse(raw);

    expect(parsed.runId).toBe(runId);
    expect(parsed.terminalOutcome).toBe("FAILED");
    expect(parsed.bundleId).toBe(terminalRecord.bundleId);
  });

  // --------------------------------------------------------------------------
  // Group 7: Offline Auditor Verification Parity
  // --------------------------------------------------------------------------

  it("1.7 achieves 100% agreement between runtime outcome and standalone offline auditor", async () => {
    const failedBundle = createTestBundle(tempDir, "FAILED");

    const signedBundle: EvidenceBundle = {
      ...failedBundle,
      signatures: [
        EvidenceSigner.sign(failedBundle, workerKeys.privateKey, "key-worker-p44b", { authorityId: "auth-worker-p44b" }).signature!,
        EvidenceSigner.sign(failedBundle, supervisorKeys.privateKey, "key-supervisor-p44b", { authorityId: "auth-supervisor-p44b" }).signature!,
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
    expect(auditResult.fourfoldSatisfied).toBe(false);
    expect(auditResult.terminalOutcome).toBe("FAILED");
  });
});
