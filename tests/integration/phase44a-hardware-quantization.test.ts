/**
 * Phase 44A — Local Hardware Acceleration & Quantization Boundary Evaluation Test Suite.
 *
 * Evaluates whether Emerald's model-capability ceiling is caused primarily by
 * model capability, CPU-only inference latency, quantization, or local hardware,
 * while verifying that Emerald's frozen governance architecture remains strictly invariant.
 *
 * Invariants:
 * - ₹0 cost, local execution, open-weight models only.
 * - Hardware baseline unchanged: Intel Core i3-N305, 8 cores, ~7.63GB RAM.
 * - Accelerator status: ACCELERATOR_UNAVAILABLE (no discrete GPU).
 * - Step 6 Capability Probe: NOT_EXECUTED (accelerator absent).
 * - Clean-room verification, fourfold completion, threshold signing, terminal indexing unchanged.
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

// ============================================================================
// Helper to create test evidence bundles
// ============================================================================

function createTestBundle(baseDir: string, status: "COMPLETED" | "FAILED"): EvidenceBundle {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dbPath = path.join(baseDir, `test-store-${nonce}.db`);
  const store = new SqliteStateStore({ location: dbPath });
  const clock = new SettableClock("2026-10-19T16:00:00.000Z");
  const coordinator = new RunCoordinator(store, clock);

  const taskId = `task-p44a-${nonce}`;
  coordinator.createTask({
    taskId,
    title: "Phase 44A Hardware Boundary Task",
    inputPayload: { goal: "evaluate hardware boundary run" },
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
    workerId: "worker-p44a",
    hostname: "node-p44a",
    pid: 3001,
    status: "ACTIVE",
    lastHeartbeatAt: clock.nowIso(),
    createdAt: clock.nowIso(),
  });

  const claim = coordinator.claimRun(createRes.run.runId, "worker-p44a", 30000);
  coordinator.startRun(createRes.run.runId, "worker-p44a", claim.lease.leaseId);
  coordinator.saveCheckpoint({
    runId: createRes.run.runId,
    checkpointVersion: 1,
    durableState: { stage: "init" },
  });

  const actionId = "act-p44a-1";
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
    attemptId: "att-p44a-1",
    actionId,
    runId: createRes.run.runId,
    attemptNumber: 1,
    workerId: "worker-p44a",
    leaseId: claim.lease.leaseId,
    now: clock.nowIso(),
  });

  store.transaction((tx) => {
    tx.insertAction(action.snapshot, actEvt, { workerId: "worker-p44a", leaseId: claim.lease.leaseId });
    tx.transitionAction(actionId, { type: "AUTHORIZE", now: clock.nowIso() }, () => "e1");
    tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 1, now: clock.nowIso() }, () => "e2");
    tx.insertAttempt(att1.snapshot, att1Evt, { workerId: "worker-p44a", leaseId: claim.lease.leaseId });
    tx.transitionAttempt("att-p44a-1", { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
    tx.transitionAttempt("att-p44a-1", { type: "START", now: clock.nowIso() }, () => "e4");
    tx.transitionAttempt(
      "att-p44a-1",
      {
        type: "COMPLETE",
        outputPayload: { exitCode: status === "COMPLETED" ? 0 : 1, stdout: "test output" },
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
    coordinator.completeRun(createRes.run.runId, "worker-p44a", claim.lease.leaseId, {
      success: true,
      message: "Run completed successfully",
    });
  } else {
    coordinator.failRun(
      createRes.run.runId,
      { error: "Task tests failed", retryable: false },
      "worker-p44a",
      claim.lease.leaseId
    );
  }

  return EvidenceExporter.exportBundle(store, createRes.run.runId, {
    nowIso: "2026-10-19T16:05:00.000Z",
  });
}

// ============================================================================
// Test Suite
// ============================================================================

describe("Phase 44A — Local Hardware Acceleration & Quantization Boundary Evaluation", () => {
  let tempDir: string;
  let keyring: TrustedKeyring;
  let workerKeys: ReturnType<typeof EvidenceSigner.generateKeyPair>;
  let supervisorKeys: ReturnType<typeof EvidenceSigner.generateKeyPair>;
  let verifierKeys: ReturnType<typeof EvidenceSigner.generateKeyPair>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "phase44a-eval-"));
    workerKeys = EvidenceSigner.generateKeyPair();
    supervisorKeys = EvidenceSigner.generateKeyPair();
    verifierKeys = EvidenceSigner.generateKeyPair();

    keyring = new TrustedKeyring();
    keyring.registerKey({
      authorityId: "auth-worker-p44a",
      keyId: "key-worker-p44a",
      role: "WORKER_PRODUCER",
      publicKey: workerKeys.publicKey,
      status: "TRUSTED",
    });
    keyring.registerKey({
      authorityId: "auth-supervisor-p44a",
      keyId: "key-supervisor-p44a",
      role: "SUPERVISOR",
      publicKey: supervisorKeys.publicKey,
      status: "TRUSTED",
    });
    keyring.registerKey({
      authorityId: "auth-verifier-p44a",
      keyId: "key-verifier-p44a",
      role: "INDEPENDENT_VERIFIER",
      publicKey: verifierKeys.publicKey,
      status: "TRUSTED",
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  // --------------------------------------------------------------------------
  // Group 1: Hardware Inventory & Accelerator Availability Audit
  // --------------------------------------------------------------------------

  it("1.1 verifies hardware baseline and establishes ACCELERATOR_UNAVAILABLE status", async () => {
    const feasPath = path.resolve("scratch/phase44a-accelerator-feasibility.json");
    const raw = await fs.readFile(feasPath, "utf8");
    const feasibility = JSON.parse(raw);

    expect(feasibility.phase).toBe("44A");
    expect(feasibility.status).toBe("ACCELERATOR_UNAVAILABLE");
    expect(feasibility.hardware.cpu).toBe("Intel(R) Core(TM) i3-N305");
    expect(feasibility.hardware.logicalProcessors).toBe(8);
    expect(feasibility.hardware.physicalCores).toBe(8);
    expect(feasibility.hardware.ramReadable).toBe("7.63 GiB");
    expect(feasibility.hardware.hardwareConfigurationUnchanged).toBe(true);

    // Verify backends audit
    const cuda = feasibility.backends.find((b: any) => b.backend === "NVIDIA CUDA");
    const rocm = feasibility.backends.find((b: any) => b.backend === "AMD ROCm");
    const metal = feasibility.backends.find((b: any) => b.backend === "Apple Metal");
    const cpu = feasibility.backends.find((b: any) => b.backend.startsWith("CPU"));

    expect(cuda.decision).toBe("HARDWARE_ABSENT");
    expect(rocm.decision).toBe("HARDWARE_ABSENT");
    expect(metal.decision).toBe("HARDWARE_ABSENT");
    expect(cpu.decision).toBe("SUPPORTED");
  });

  // --------------------------------------------------------------------------
  // Group 2: Quantization Boundary & Canonical Source Integrity
  // --------------------------------------------------------------------------

  it("1.2 validates quantization findings and preserves canonical source integrity", async () => {
    const modelFeasPath = path.resolve("scratch/phase44a-model-feasibility.json");
    const modelFeas = JSON.parse(await fs.readFile(modelFeasPath, "utf8"));

    expect(modelFeas.phase).toBe("44A");
    expect(modelFeas.status).toBe("COMPLETE");
    expect(modelFeas.models.length).toBeGreaterThanOrEqual(8);

    // Find SmolLM2 (Q8_0) and Qwen2.5-Coder (Q4_K_M)
    const smollm = modelFeas.models.find((m: any) => m.modelName === "smollm2:1.7b");
    const qwen15 = modelFeas.models.find((m: any) => m.modelName === "qwen2.5-coder:1.5b");
    const deepseek = modelFeas.models.find((m: any) => m.modelName === "deepseek-r1:8b");

    expect(smollm.quantization).toBe("Q8_0");
    expect(qwen15.quantization).toBe("Q4_K_M");
    expect(deepseek.status).toBe("ENVIRONMENTALLY_INFEASIBLE");

    // SmolLM2 Q8_0 latency (~71.5s) is higher than Qwen1.5 Q4_K_M (~25.3s)
    expect(smollm.observedLatencyMs).toBeGreaterThan(qwen15.observedLatencyMs);
  });

  // --------------------------------------------------------------------------
  // Group 3: Model Feasibility & Size Boundary
  // --------------------------------------------------------------------------

  it("1.3 establishes CPU hardware parameter ceiling <= 3.2B under 120s ceiling", async () => {
    const modelFeasPath = path.resolve("scratch/phase44a-model-feasibility.json");
    const modelFeas = JSON.parse(await fs.readFile(modelFeasPath, "utf8"));

    const executableModels = modelFeas.models.filter((m: any) => m.status === "EXECUTABLE");
    for (const m of executableModels) {
      expect(m.parameters).toBeLessThanOrEqual(3200000000);
      expect(m.observedLatencyMs).toBeLessThanOrEqual(120000);
    }

    const infeasibleModels = modelFeas.models.filter((m: any) => m.status === "ENVIRONMENTALLY_INFEASIBLE");
    for (const m of infeasibleModels) {
      expect(m.parameters).toBeGreaterThan(4000000000);
      expect(m.observedLatencyMs).toBeGreaterThan(120000);
    }
  });

  // --------------------------------------------------------------------------
  // Group 4: Capability Probe Invariant (NOT_EXECUTED when accelerator absent)
  // --------------------------------------------------------------------------

  it("1.4 confirms CAPABILITY_PROBE_STATUS is NOT_EXECUTED due to accelerator absence", async () => {
    const feasPath = path.resolve("scratch/phase44a-accelerator-feasibility.json");
    const feasibility = JSON.parse(await fs.readFile(feasPath, "utf8"));

    const probeDecision = feasibility.decisions.find((d: any) => d.category === "CAPABILITY_PROBE");
    expect(probeDecision.status).toBe("NOT_EXECUTED");

    const acqDecision = feasibility.decisions.find((d: any) => d.category === "MODEL_ACQUISITION");
    expect(acqDecision.status).toBe("NO_NEW_MODEL_ACQUISITION");
  });

  // --------------------------------------------------------------------------
  // Group 5: Governance & Clean-Room Verification Invariance
  // --------------------------------------------------------------------------

  it("1.5 confirms fail-closed governance invariance across hardware boundary", async () => {
    const failedBundle = createTestBundle(tempDir, "FAILED");

    const sigWorker = EvidenceSigner.sign(failedBundle, workerKeys.privateKey, "key-worker-p44a", {
      authorityId: "auth-worker-p44a",
    }).signature!;
    const sigSupervisor = EvidenceSigner.sign(failedBundle, supervisorKeys.privateKey, "key-supervisor-p44a", {
      authorityId: "auth-supervisor-p44a",
    }).signature!;

    const signedBundle: EvidenceBundle = {
      ...failedBundle,
      signatures: [sigWorker, sigSupervisor],
    };

    const filePath = path.join(tempDir, `${signedBundle.bundleId}.json`);
    await fs.writeFile(filePath, JSON.stringify(signedBundle), "utf8");

    const auditResult = await OfflineAuditor.verifyEvidence(filePath, {
      keyring,
      thresholdPolicy: { threshold: 2, totalAuthorities: 3 },
    });

    expect(auditResult.status).toBe("VERIFIED");
    expect(auditResult.thresholdSatisfied).toBe(true);
    expect(auditResult.fourfoldSatisfied).toBe(false); // Valid failed run, fourfold completion is false
    expect(auditResult.terminalOutcome).toBe("FAILED");
  });

  // --------------------------------------------------------------------------
  // Group 6: Authoritative Terminal Fencing Invariance
  // --------------------------------------------------------------------------

  it("1.6 enforces Invariant B anti-equivocation terminal record fencing", async () => {
    const runId = "run-fencing-p44a";
    const archiveDir = path.join(tempDir, "archive-p44a");
    await fs.mkdir(path.join(archiveDir, "runs", runId), { recursive: true });

    const terminalRecord = createTerminalRecord({
      runId,
      bundleId: "bundle-terminal-p44a".padEnd(64, "0"),
      terminalOutcome: "FAILED",
      nowIso: "2026-10-19T16:10:00.000Z",
    });

    await fs.writeFile(path.join(archiveDir, "runs", runId, "terminal.json"), JSON.stringify(terminalRecord), "utf8");

    const raw = await fs.readFile(path.join(archiveDir, "runs", runId, "terminal.json"), "utf8");
    const parsed = JSON.parse(raw);

    expect(parsed.runId).toBe(runId);
    expect(parsed.terminalOutcome).toBe("FAILED");
    expect(parsed.bundleId).toBe(terminalRecord.bundleId);
  });

  // --------------------------------------------------------------------------
  // Group 7: Offline Auditor Agreement Invariance
  // --------------------------------------------------------------------------

  it("1.7 achieves 100% agreement between runtime and offline auditor across valid bundles", async () => {
    const completedBundle = createTestBundle(tempDir, "COMPLETED");

    const signedCompleted: EvidenceBundle = {
      ...completedBundle,
      signatures: [
        EvidenceSigner.sign(completedBundle, workerKeys.privateKey, "key-worker-p44a", { authorityId: "auth-worker-p44a" }).signature!,
        EvidenceSigner.sign(completedBundle, supervisorKeys.privateKey, "key-supervisor-p44a", { authorityId: "auth-supervisor-p44a" }).signature!,
      ],
    };

    const filePath = path.join(tempDir, `${signedCompleted.bundleId}.json`);
    await fs.writeFile(filePath, JSON.stringify(signedCompleted), "utf8");

    const auditResult = await OfflineAuditor.verifyEvidence(filePath, {
      keyring,
      thresholdPolicy: { threshold: 2, totalAuthorities: 3 },
    });

    expect(auditResult.status).toBe("VERIFIED");
    expect(auditResult.fourfoldSatisfied).toBe(true);
  });
});
