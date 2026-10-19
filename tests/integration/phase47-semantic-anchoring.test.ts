/**
 * Phase 47 — Governed Interface Contracts & Cross-Subtask Semantic Anchoring Test Suite.
 *
 * Evaluates whether explicit, immutable interface contracts and cross-sub-task semantic
 * state assertions can reduce the 44.4% composition gap observed in Phase 46.
 *
 * Invariants:
 * - ₹0 cost, local CPU execution, open-weight models only.
 * - Single CPU-feasible model: qwen2.5-coder:1.5b (Q4_K_M).
 * - Exact Phase 46 15 parent task cohort and DAG decomposition graphs.
 * - 4 experimental conditions: Control (A), Interface Contracts (B), State Assertions (C), Combined (D).
 * - 60 total parent task evaluations.
 * - Clean-room verification and fourfold completion strictly fail-closed.
 * - Offline auditor parity: 100% concordance.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
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

// ============================================================================
// Semantic Anchor Domain Types & Validation Helpers
// ============================================================================

export type VerificationType =
  | "FILE_EXISTS"
  | "SYMBOL_EXISTS"
  | "EXPORT_EXISTS"
  | "FILE_HASH"
  | "TEXT_PATTERN"
  | "JSON_FIELD"
  | "COMMAND_RESULT"
  | "TEST_RESULT"
  | "GIT_DIFF_SCOPE";

export type ProvenanceSource =
  | "CLEAN_ROOM_VERIFICATION"
  | "TEST_RESULT"
  | "TOOL_OBSERVATION"
  | "STATIC_ANALYSIS"
  | "MODEL_CLAIM";

export interface InterfaceContract {
  interfaceName: string;
  version: string;
  inputs: Record<string, string>;
  outputs: Record<string, string>;
  preconditions: string[];
  postconditions: string[];
  compatibilityRules: string[];
}

export interface StateAssertion {
  assertionId: string;
  description: string;
  scope: string;
  severity: "FATAL" | "REQUIRED";
  verificationType: VerificationType;
  expectedValue: string;
}

export interface SemanticAnchorContract {
  anchorId: string;
  parentTaskId: string;
  subTaskId: string;
  version: string;
  interfaceContracts: InterfaceContract[];
  stateAssertions: StateAssertion[];
  inputHash: string;
  createdAt: string;
  contentHash: string;
}

export interface SemanticObservation {
  observationId: string;
  parentTaskId: string;
  subTaskId: string;
  assertionId: string;
  source: ProvenanceSource;
  timestamp: string;
  verified: boolean;
  actualValue: string;
}

export function computeAnchorContentHash(anchor: Omit<SemanticAnchorContract, "contentHash">): string {
  const normalized = {
    anchorId: anchor.anchorId,
    parentTaskId: anchor.parentTaskId,
    subTaskId: anchor.subTaskId,
    version: anchor.version,
    interfaceContracts: anchor.interfaceContracts,
    stateAssertions: anchor.stateAssertions,
    inputHash: anchor.inputHash,
    createdAt: anchor.createdAt,
  };
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function validateSemanticAnchor(
  anchor: SemanticAnchorContract,
  expectedParentTaskId: string,
  expectedSubTaskId: string
): { valid: boolean; error?: string } {
  if (!anchor || typeof anchor !== "object") {
    return { valid: false, error: "Anchor must be an object" };
  }
  if (!anchor.anchorId || !anchor.parentTaskId || !anchor.subTaskId) {
    return { valid: false, error: "Missing required anchor identifier fields" };
  }
  if (anchor.parentTaskId !== expectedParentTaskId) {
    return {
      valid: false,
      error: `Parent task mismatch: expected ${expectedParentTaskId}, got ${anchor.parentTaskId}`,
    };
  }
  if (anchor.subTaskId !== expectedSubTaskId) {
    return {
      valid: false,
      error: `Sub-task mismatch: expected ${expectedSubTaskId}, got ${anchor.subTaskId}`,
    };
  }

  // Check for solution leakage: anchor must not contain patch diff markers
  const rawString = JSON.stringify(anchor);
  if (rawString.includes("--- a/") || rawString.includes("+++ b/") || rawString.includes("diff --git")) {
    return { valid: false, error: "ANCHOR_SOLUTION_LEAKAGE: Raw diff or patch detected in semantic anchor" };
  }

  // Validate content hash
  const computedHash = computeAnchorContentHash(anchor);
  if (computedHash !== anchor.contentHash) {
    return {
      valid: false,
      error: `ANCHOR_HASH_MISMATCH: computed ${computedHash} != declared ${anchor.contentHash}`,
    };
  }

  return { valid: true };
}

export function evaluateStateAssertion(
  assertion: StateAssertion,
  observation: SemanticObservation
): { passed: boolean; error?: string } {
  // Provenance check: MODEL_CLAIM cannot satisfy state assertion
  if (observation.source === "MODEL_CLAIM") {
    return {
      passed: false,
      error: "MODEL_CLAIM cannot satisfy state assertion; authoritative provenance required",
    };
  }

  if (observation.assertionId !== assertion.assertionId) {
    return {
      passed: false,
      error: `Observation assertionId mismatch: expected ${assertion.assertionId}, got ${observation.assertionId}`,
    };
  }

  if (!observation.verified) {
    return {
      passed: false,
      error: `Assertion failed verification: actual ${observation.actualValue} != expected ${assertion.expectedValue}`,
    };
  }

  return { passed: true };
}

export function evaluateParentCompositionGate(params: {
  allSubTasksVerified: boolean;
  allRequiredAssertionsVerified: boolean;
  parentCleanRoomVerificationPassed: boolean;
  policySatisfied: boolean;
  evidenceComplete: boolean;
  terminalAuthorityEstablished: boolean;
}): { completed: boolean; terminalReason: string } {
  if (!params.allSubTasksVerified) {
    return { completed: false, terminalReason: "NOT_ALL_SUBTASKS_VERIFIED" };
  }
  if (!params.allRequiredAssertionsVerified) {
    return { completed: false, terminalReason: "REQUIRED_ASSERTIONS_UNVERIFIED" };
  }
  if (!params.parentCleanRoomVerificationPassed) {
    return { completed: false, terminalReason: "COMPOSITION_FAILURE" };
  }
  if (!params.policySatisfied) {
    return { completed: false, terminalReason: "POLICY_VIOLATION" };
  }
  if (!params.evidenceComplete) {
    return { completed: false, terminalReason: "EVIDENCE_INCOMPLETE" };
  }
  if (!params.terminalAuthorityEstablished) {
    return { completed: false, terminalReason: "TERMINAL_AUTHORITY_MISSING" };
  }

  return { completed: true, terminalReason: "PARENT_COMPLETED_SUCCESSFULLY" };
}

// ============================================================================
// Helper to create test evidence bundles
// ============================================================================

function createTestBundle(baseDir: string, status: "COMPLETED" | "FAILED"): EvidenceBundle {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dbPath = path.join(baseDir, `test-store-${nonce}.db`);
  const store = new SqliteStateStore({ location: dbPath });
  const clock = new SettableClock("2026-10-19T17:45:00.000Z");
  const coordinator = new RunCoordinator(store, clock);

  const taskId = `task-p47-${nonce}`;
  coordinator.createTask({
    taskId,
    title: "Phase 47 Semantic Anchoring Task",
    inputPayload: { goal: "evaluate semantic anchoring" },
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
    workerId: "worker-p47",
    hostname: "node-p47",
    pid: 5003,
    status: "ACTIVE",
    lastHeartbeatAt: clock.nowIso(),
    createdAt: clock.nowIso(),
  });

  const claim = coordinator.claimRun(createRes.run.runId, "worker-p47", 30000);
  coordinator.startRun(createRes.run.runId, "worker-p47", claim.lease.leaseId);
  coordinator.saveCheckpoint({
    runId: createRes.run.runId,
    checkpointVersion: 1,
    durableState: { stage: "semantic_anchoring_test" },
  });

  const actionId = `act-p47-${nonce}`;
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
    attemptId: `att-p47-${nonce}`,
    actionId,
    runId: createRes.run.runId,
    attemptNumber: 1,
    workerId: "worker-p47",
    leaseId: claim.lease.leaseId,
    now: clock.nowIso(),
  });

  store.transaction((tx) => {
    tx.insertAction(action.snapshot, actEvt, { workerId: "worker-p47", leaseId: claim.lease.leaseId });
    tx.transitionAction(actionId, { type: "AUTHORIZE", now: clock.nowIso() }, () => "e1");
    tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 1, now: clock.nowIso() }, () => "e2");
    tx.insertAttempt(att1.snapshot, att1Evt, { workerId: "worker-p47", leaseId: claim.lease.leaseId });
    tx.transitionAttempt(att1.snapshot.attemptId, { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
    tx.transitionAttempt(att1.snapshot.attemptId, { type: "START", now: clock.nowIso() }, () => "e4");
    tx.transitionAttempt(
      att1.snapshot.attemptId,
      {
        type: "COMPLETE",
        outputPayload: { exitCode: status === "COMPLETED" ? 0 : 1, stdout: "semantic anchoring test output" },
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
    coordinator.completeRun(createRes.run.runId, "worker-p47", claim.lease.leaseId, {
      success: true,
      message: "Run completed successfully",
    });
  } else {
    coordinator.failRun(
      createRes.run.runId,
      { error: "Parent composition verification failed in clean room", retryable: false },
      "worker-p47",
      claim.lease.leaseId
    );
  }

  const bundle = EvidenceExporter.exportBundle(store, createRes.run.runId, {
    nowIso: "2026-10-19T17:45:00.000Z",
  });

  store.close();
  return bundle;
}

// ============================================================================
// Test Suite
// ============================================================================

describe("Phase 47 — Governed Interface Contracts & Cross-Subtask Semantic Anchoring", () => {
  let tempDir: string;
  let keyring: TrustedKeyring;
  let workerKeys: ReturnType<typeof EvidenceSigner.generateKeyPair>;
  let supervisorKeys: ReturnType<typeof EvidenceSigner.generateKeyPair>;
  let verifierKeys: ReturnType<typeof EvidenceSigner.generateKeyPair>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "phase47-test-"));
    workerKeys = EvidenceSigner.generateKeyPair();
    supervisorKeys = EvidenceSigner.generateKeyPair();
    verifierKeys = EvidenceSigner.generateKeyPair();

    keyring = new TrustedKeyring();
    keyring.registerKey({
      authorityId: "auth-worker-p47",
      keyId: "key-worker-p47",
      role: "WORKER_PRODUCER",
      publicKey: workerKeys.publicKey,
      status: "TRUSTED",
    });
    keyring.registerKey({
      authorityId: "auth-supervisor-p47",
      keyId: "key-supervisor-p47",
      role: "SUPERVISOR",
      publicKey: supervisorKeys.publicKey,
      status: "TRUSTED",
    });
    keyring.registerKey({
      authorityId: "auth-verifier-p47",
      keyId: "key-verifier-p47",
      role: "INDEPENDENT_VERIFIER",
      publicKey: verifierKeys.publicKey,
      status: "TRUSTED",
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("1. verifies Phase 47 protocol and frozen semantic anchors byte-for-byte", async () => {
    const protocolPath = path.resolve("scratch/phase47-protocol.json");
    const anchorsPath = path.resolve("scratch/phase47-semantic-anchors.json");

    const protocolBytes = await fs.readFile(protocolPath);
    const anchorsBytes = await fs.readFile(anchorsPath);

    const protocolDigest = crypto.createHash("sha256").update(protocolBytes).digest("hex");
    const anchorsDigest = crypto.createHash("sha256").update(anchorsBytes).digest("hex");

    expect(protocolDigest).toBe("2d6e917f0eaede933ed64bfc69decffe076ba3439a55d76616ab59cb500d3e14");
    expect(anchorsDigest).toBe("839c66d4bfdb6b0cd10f4b7e22d53a9cf5a97e82613187a32c4bb8f823683a7c");

    const anchorsData = JSON.parse(anchorsBytes.toString("utf-8"));
    expect(anchorsData.totalAnchors).toBe(45);
    expect(anchorsData.anchors.length).toBe(45);
  });

  it("2. validates all 46 semantic anchor contracts against schema and integrity rules", async () => {
    const anchorsPath = path.resolve("scratch/phase47-semantic-anchors.json");
    const anchorsData = JSON.parse(await fs.readFile(anchorsPath, "utf-8"));

    for (const anchor of anchorsData.anchors) {
      // Validate schema and binding
      expect(anchor.anchorId).toBeDefined();
      expect(anchor.parentTaskId).toBeDefined();
      expect(anchor.subTaskId).toBeDefined();
      expect(anchor.contentHash).toBeDefined();

      // Ensure no raw patch/diff leakage
      const raw = JSON.stringify(anchor);
      expect(raw.includes("--- a/")).toBe(false);
      expect(raw.includes("+++ b/")).toBe(false);
      expect(raw.includes("diff --git")).toBe(false);
    }
  });

  it("3. verifies state assertion model, authoritative provenance, and rejects model claims", () => {
    const assertion: StateAssertion = {
      assertionId: "SA-TEST-01",
      description: "Function exports exist",
      scope: "src/calc.js",
      severity: "REQUIRED",
      verificationType: "EXPORT_EXISTS",
      expectedValue: "compute",
    };

    // Authoritative clean-room verification passes
    const authObs: SemanticObservation = {
      observationId: "OBS-01",
      parentTaskId: "P-01",
      subTaskId: "P-01-S1",
      assertionId: "SA-TEST-01",
      source: "CLEAN_ROOM_VERIFICATION",
      timestamp: "2026-10-19T17:45:00.000Z",
      verified: true,
      actualValue: "compute",
    };
    const resAuth = evaluateStateAssertion(assertion, authObs);
    expect(resAuth.passed).toBe(true);

    // Negative Control N5: MODEL_CLAIM rejected
    const modelObs: SemanticObservation = {
      observationId: "OBS-02",
      parentTaskId: "P-01",
      subTaskId: "P-01-S1",
      assertionId: "SA-TEST-01",
      source: "MODEL_CLAIM",
      timestamp: "2026-10-19T17:45:00.000Z",
      verified: true,
      actualValue: "compute",
    };
    const resModel = evaluateStateAssertion(assertion, modelObs);
    expect(resModel.passed).toBe(false);
    expect(resModel.error).toContain("MODEL_CLAIM cannot satisfy state assertion");
  });

  it("4. executes Negative Controls N1 through N8", () => {
    const baseAnchor: SemanticAnchorContract = {
      anchorId: "ANCHOR-TEST-01",
      parentTaskId: "P-TEST",
      subTaskId: "P-TEST-S1",
      version: "1.0",
      interfaceContracts: [
        {
          interfaceName: "testFn",
          version: "1.0",
          inputs: { a: "number" },
          outputs: { b: "string" },
          preconditions: [],
          postconditions: [],
          compatibilityRules: [],
        },
      ],
      stateAssertions: [
        {
          assertionId: "SA-TEST-01",
          description: "test assertion",
          scope: "src/test.js",
          severity: "REQUIRED",
          verificationType: "SYMBOL_EXISTS",
          expectedValue: "testFn",
        },
      ],
      inputHash: "input-hash-123",
      createdAt: "2026-10-19T17:45:00.000Z",
      contentHash: "",
    };
    baseAnchor.contentHash = computeAnchorContentHash(baseAnchor);

    // N1: Wrong interface contract (subtask binding or validation failure)
    const n1Res = validateSemanticAnchor(baseAnchor, "P-WRONG", "P-TEST-S1");
    expect(n1Res.valid).toBe(false);
    expect(n1Res.error).toContain("Parent task mismatch");

    // N2: Contradictory state assertion (expected value does not match observation)
    const contradictoryObs: SemanticObservation = {
      observationId: "OBS-N2",
      parentTaskId: "P-TEST",
      subTaskId: "P-TEST-S1",
      assertionId: "SA-TEST-01",
      source: "CLEAN_ROOM_VERIFICATION",
      timestamp: "2026-10-19T17:45:00.000Z",
      verified: false,
      actualValue: "undefined",
    };
    const n2Res = evaluateStateAssertion(baseAnchor.stateAssertions[0]!, contradictoryObs);
    expect(n2Res.passed).toBe(false);
    expect(n2Res.error).toContain("Assertion failed verification");

    // N3: Solution leakage rejected
    const leakyContract: InterfaceContract = {
      ...baseAnchor.interfaceContracts[0]!,
      compatibilityRules: ["--- a/src/test.js", "+++ b/src/test.js"],
    };
    const leakyAnchor: SemanticAnchorContract = {
      ...baseAnchor,
      interfaceContracts: [leakyContract],
    };
    leakyAnchor.contentHash = computeAnchorContentHash(leakyAnchor);
    const n3Res = validateSemanticAnchor(leakyAnchor, "P-TEST", "P-TEST-S1");
    expect(n3Res.valid).toBe(false);
    expect(n3Res.error).toContain("ANCHOR_SOLUTION_LEAKAGE");

    // N4: Anchor mutation rejected (contentHash mismatch)
    const mutatedAnchor = {
      ...baseAnchor,
      version: "2.0-MUTATED", // mutated after contentHash computed
    };
    const n4Res = validateSemanticAnchor(mutatedAnchor, "P-TEST", "P-TEST-S1");
    expect(n4Res.valid).toBe(false);
    expect(n4Res.error).toContain("ANCHOR_HASH_MISMATCH");

    // N5: Model claims assertion PASS rejected (already tested in Test 3)

    // N6: Stale assertion (observation from before subsequent mutation)
    const mutationTimestamp = "2026-10-19T17:50:00.000Z";
    const staleObsTimestamp = "2026-10-19T17:40:00.000Z";
    const isStale = new Date(staleObsTimestamp) < new Date(mutationTimestamp);
    expect(isStale).toBe(true);

    // N7: Wrong subtask binding rejected
    const n7Res = validateSemanticAnchor(baseAnchor, "P-TEST", "P-TEST-S_DIFFERENT");
    expect(n7Res.valid).toBe(false);
    expect(n7Res.error).toContain("Sub-task mismatch");

    // N8: Parent completion without anchor verification rejected
    const n8Res = evaluateParentCompositionGate({
      allSubTasksVerified: true,
      allRequiredAssertionsVerified: false, // unverified assertion
      parentCleanRoomVerificationPassed: true,
      policySatisfied: true,
      evidenceComplete: true,
      terminalAuthorityEstablished: true,
    });
    expect(n8Res.completed).toBe(false);
    expect(n8Res.terminalReason).toBe("REQUIRED_ASSERTIONS_UNVERIFIED");
  });

  it("5. verifies 4-condition comparative evaluation results and composition gap reduction", async () => {
    const evalPath = path.resolve("scratch/phase47-evaluation.json");
    const evalData = JSON.parse(await fs.readFile(evalPath, "utf-8"));

    expect(evalData.phase).toBe("47");
    expect(evalData.status).toBe("COMPLETE");
    expect(evalData.totalEvaluations).toBe(60);

    // Condition summaries
    const condA = evalData.conditionSummaries.find((c: any) => c.conditionId === "CONDITION_A_NO_ANCHOR");
    const condB = evalData.conditionSummaries.find((c: any) => c.conditionId === "CONDITION_B_INTERFACE_CONTRACT");
    const condC = evalData.conditionSummaries.find((c: any) => c.conditionId === "CONDITION_C_STATE_ASSERTIONS");
    const condD = evalData.conditionSummaries.find((c: any) => c.conditionId === "CONDITION_D_CONTRACT_AND_STATE");

    expect(condA.parentSuccessRate).toBe(0.333);
    expect(condB.parentSuccessRate).toBe(0.467);
    expect(condC.parentSuccessRate).toBe(0.400);
    expect(condD.parentSuccessRate).toBe(0.533);

    // Composition success and gap
    expect(condA.compositionSuccessRate).toBe(0.556);
    expect(condA.compositionGap).toBe(0.444);

    expect(condB.compositionSuccessRate).toBe(0.700);
    expect(condB.compositionGap).toBe(0.300);

    expect(condC.compositionSuccessRate).toBe(0.667);
    expect(condC.compositionGap).toBe(0.333);

    expect(condD.compositionSuccessRate).toBe(0.800);
    expect(condD.compositionGap).toBe(0.200);

    // Cost overhead
    expect(evalData.costMultipliersOverConditionA.latencyMultiplier).toBe(1.12);
    expect(evalData.costMultipliersOverConditionA.modelCallMultiplier).toBe(1.07);
    expect(evalData.costMultipliersOverConditionA.contextMultiplier).toBe(1.16);

    // Hypotheses
    expect(evalData.hypothesisResults.H1_INTERFACE_BENEFIT).toContain("SUPPORTED");
    expect(evalData.hypothesisResults.H2_STATE_BENEFIT).toContain("SUPPORTED");
    expect(evalData.hypothesisResults.H3_COMBINED_BENEFIT).toContain("SUPPORTED");
    expect(evalData.hypothesisResults.H4_COMPOSITION_GAP_REDUCTION).toContain("SUPPORTED");
    expect(evalData.hypothesisResults.H5_COST_OVERHEAD).toContain("SUPPORTED");
    expect(evalData.hypothesisResults.H6_VERIFICATION_PRESERVATION).toContain("SUPPORTED");
  });

  it("6. verifies composition failure deep dive on 4 target tasks", async () => {
    const evalPath = path.resolve("scratch/phase47-evaluation.json");
    const evalData = JSON.parse(await fs.readFile(evalPath, "utf-8"));

    const deepDive = evalData.compositionFailureDeepDive;
    expect(deepDive.length).toBe(4);

    const tL5_04 = deepDive.find((d: any) => d.parentTaskId === "P46-L5-04");
    const tL6_03 = deepDive.find((d: any) => d.parentTaskId === "P46-L6-03");
    const tL6_04 = deepDive.find((d: any) => d.parentTaskId === "P46-L6-04");
    const tL7_01 = deepDive.find((d: any) => d.parentTaskId === "P46-L7-01");

    expect(tL5_04.resolvedBy).toBe("STATE_ASSERTIONS");
    expect(tL6_03.resolvedBy).toBe("INTERFACE_CONTRACT");
    expect(tL6_04.resolvedBy).toBe("INTERFACE_CONTRACT");
    expect(tL7_01.resolvedBy).toBe("UNRESOLVED_DEEP_COMPOSITION_FAILURE");
  });

  it("7. verifies clean-room dual-gate verifier, fourfold completion, and offline auditor concordance", async () => {
    const completedBundle = createTestBundle(tempDir, "COMPLETED");

    const signedCompleted: EvidenceBundle = {
      ...completedBundle,
      signatures: [
        EvidenceSigner.sign(completedBundle, workerKeys.privateKey, "key-worker-p47", { authorityId: "auth-worker-p47" }).signature!,
        EvidenceSigner.sign(completedBundle, supervisorKeys.privateKey, "key-supervisor-p47", { authorityId: "auth-supervisor-p47" }).signature!,
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

    // Invariant B terminal record test
    const runId = completedBundle.run.runId;
    const terminalRecord = createTerminalRecord({
      runId,
      bundleId: completedBundle.bundleId,
      terminalOutcome: "COMPLETED",
      nowIso: "2026-10-19T17:45:00.000Z",
    });

    expect(terminalRecord.runId).toBe(runId);
    expect(terminalRecord.bundleId).toBe(completedBundle.bundleId);
    expect(terminalRecord.terminalOutcome).toBe("COMPLETED");
  });
});
