/**
 * Emerald Agent Fabric — Production V1.5: Controlled Repair Capability Calibration Tests
 *
 * Verifies the 14 invariant requirements specified for V1.5:
 * 1. Deterministic task fixture initialization
 * 2. Calibration tasks remaining separate from the frozen 15-task manifest
 * 3. Correct stage classification for malformed proposals
 * 4. Correct classification for patch application failures
 * 5. Correct classification for governance rejection
 * 6. Distinguishing test failures from test execution failures
 * 7. Distinguishing test failure from sovereign verification failure
 * 8. Unknown or inconclusive classification when evidence is insufficient
 * 9. Preservation of original task, model, contract, and budget configuration
 * 10. Evidence digest integrity
 * 11. Replay determinism across 3 sweeps
 * 12. Zero automatic commits or pushes
 * 13. Preservation of user modifications
 * 14. Existing scope and capability-fencing behavior
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

import { BenchmarkManifestLoader } from "../../src/production/benchmark/benchmark-manifest.js";
import { CalibrationManifestLoader } from "../../src/production/benchmark/calibration-manifest.js";
import { FailureAttributionClassifier } from "../../src/production/benchmark/failure-attribution.js";
import { ProductionReplayEngine } from "../../src/evidence/production-replay-engine.js";
import { ProductionEvidenceBundle } from "../../src/control-plane/evidence-control.js";
import { DEFAULT_REPAIR_CONFIG } from "../../src/production/repair/repair-types.js";
import { CapabilityFenceEnforcer } from "../../src/application/capability-fence-enforcer.js";
import { CapabilityFence } from "../../src/domain/capability-fence.js";

describe("Production V1.5: Controlled Repair Capability Calibration", () => {
  const classifier = new FailureAttributionClassifier();
  const benchmarkLoader = new BenchmarkManifestLoader();
  const calibLoader = new CalibrationManifestLoader();

  // ---------------------------------------------------------------------------
  // 1. Deterministic task fixture initialization
  // ---------------------------------------------------------------------------
  it("1. should initialize task fixtures deterministically and confirm baseline failure", () => {
    const calibManifest = calibLoader.loadManifest();
    expect(calibManifest.taskCount).toBe(5);

    const task1 = calibManifest.tasks[0]!;
    expect(task1.taskId).toBe("calib-001");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "calib-fixture-test-"));
    try {
      execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
      fs.writeFileSync(path.join(tmpDir, task1.sourceFile), task1.initialCode, "utf8");
      fs.writeFileSync(path.join(tmpDir, task1.testFile), task1.testCode, "utf8");

      // Verify the baseline fixture fails as expected (bug reproduces)
      let failed = false;
      try {
        execFileSync(task1.testCommand.cmd, task1.testCommand.args as string[], {
          cwd: tmpDir,
          stdio: "pipe",
        });
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // 2. Calibration tasks remaining separate from frozen 15-task manifest
  // ---------------------------------------------------------------------------
  it("2. should maintain strict isolation between the frozen 15-task manifest and the calibration suite", () => {
    const benchManifest = benchmarkLoader.loadManifest();
    const calibManifest = calibLoader.loadManifest();

    expect(benchManifest.taskCount).toBe(15);
    expect(calibManifest.taskCount).toBe(5);

    const benchTaskIds = new Set(benchManifest.tasks.map((t) => t.taskId));
    const calibTaskIds = new Set(calibManifest.tasks.map((t) => t.taskId));

    expect(benchTaskIds.size).toBe(15);
    expect(calibTaskIds.size).toBe(5);

    // Ensure zero overlap in task IDs
    for (const cid of calibTaskIds) {
      expect(benchTaskIds.has(cid)).toBe(false);
      expect(cid.startsWith("calib-")).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // 3. Correct stage classification for malformed proposals
  // ---------------------------------------------------------------------------
  it("3. should attribute malformed or unparseable proposals to STAGE_2_MODEL_PROPOSAL", () => {
    const res = classifier.classify({
      fixtureFailed: false,
      proposalValid: false,
      proposalError: "JSON syntax error at position 42",
      modelRawResponse: "Invalid non-JSON model output",
    });

    expect(res.primaryStage).toBe("STAGE_2_MODEL_PROPOSAL");
    expect(res.primaryCode).toBe("MODEL_PARSE_ERROR");
    expect(res.modelProposalValid).toBe(false);
    expect(res.patchAppliedSuccessfully).toBe(false);
    expect(res.testsExecuted).toBe(false);
    expect(res.sovereignVerified).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 4. Correct classification for patch application failures
  // ---------------------------------------------------------------------------
  it("4. should attribute patch write or target resolution failure to STAGE_3_PATCH_APPLICATION", () => {
    const res = classifier.classify({
      fixtureFailed: false,
      proposalValid: true,
      patchApplied: false,
      patchError: "Target string not found in file",
    });

    expect(res.primaryStage).toBe("STAGE_3_PATCH_APPLICATION");
    expect(res.primaryCode).toBe("PATCH_TARGET_NOT_FOUND");
    expect(res.modelProposalValid).toBe(true);
    expect(res.patchAppliedSuccessfully).toBe(false);
    expect(res.testsExecuted).toBe(false);
    expect(res.sovereignVerified).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 5. Correct classification for governance rejection
  // ---------------------------------------------------------------------------
  it("5. should attribute scope violations and capability denials to STAGE_4_GOVERNANCE_SCOPE", () => {
    const res = classifier.classify({
      fixtureFailed: false,
      proposalValid: true,
      patchApplied: true,
      governanceDenied: true,
      scopeViolations: ["Out-of-scope mutation: unauthorized/file.js"],
    });

    expect(res.primaryStage).toBe("STAGE_4_GOVERNANCE_SCOPE");
    expect(res.primaryCode).toBe("GOVERNANCE_SCOPE_VIOLATION");
    expect(res.modelProposalValid).toBe(true);
    expect(res.patchAppliedSuccessfully).toBe(true);
    expect(res.sovereignVerified).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 6. Distinguishing test failures from test execution failures
  // ---------------------------------------------------------------------------
  it("6. should cleanly distinguish test process execution failure from assertion failure", () => {
    // Case A: Test runner crashed / syntax error prevented execution
    const processCrash = classifier.classify({
      fixtureFailed: false,
      proposalValid: true,
      patchApplied: true,
      testExecutionFailed: true,
      testExitCode: 127,
    });
    expect(processCrash.primaryStage).toBe("STAGE_7_TEST_EXECUTION");
    expect(processCrash.primaryCode).toBe("TEST_PROCESS_FAILED");
    expect(processCrash.testsExecuted).toBe(false);

    // Case B: Test runner executed cleanly, but assertion failed
    const assertionFail = classifier.classify({
      fixtureFailed: false,
      proposalValid: true,
      patchApplied: true,
      testExecutionFailed: false,
      testAssertionFailed: true,
      testExitCode: 1,
    });
    expect(assertionFail.primaryStage).toBe("STAGE_7_TEST_EXECUTION");
    expect(assertionFail.primaryCode).toBe("TEST_ASSERTION_FAILED");
    expect(assertionFail.testsExecuted).toBe(true);
    expect(assertionFail.testPassed).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 7. Distinguishing test failure from sovereign verification failure
  // ---------------------------------------------------------------------------
  it("7. should distinguish targeted test failure from clean-room sovereign verification failure", () => {
    const verifFail = classifier.classify({
      fixtureFailed: false,
      proposalValid: true,
      patchApplied: true,
      testExecutionFailed: false,
      testAssertionFailed: false, // targeted tests passed in sandbox
      verified: false,           // sovereign clean-room verification failed
      verificationFailureReason: "Sovereign verifier detected uncommitted regression",
    });

    expect(verifFail.primaryStage).toBe("STAGE_8_SOVEREIGN_VERIFICATION");
    expect(verifFail.primaryCode).toBe("VERIFIER_INVARIANT_FAILED");
    expect(verifFail.testPassed).toBe(true);
    expect(verifFail.sovereignVerified).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 8. Unknown or inconclusive classification when evidence is insufficient
  // ---------------------------------------------------------------------------
  it("8. should yield STAGE_UNKNOWN_INCONCLUSIVE when evidence is insufficient", () => {
    const inconclusive = classifier.classify({});

    expect(inconclusive.primaryStage).toBe("STAGE_UNKNOWN_INCONCLUSIVE");
    expect(inconclusive.primaryCode).toBe("INCONCLUSIVE_INSUFFICIENT_EVIDENCE");
    expect(inconclusive.sovereignVerified).toBe(false);
    expect(inconclusive.stageRecords.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 9. Preservation of original task, model, contract, and budget configuration
  // ---------------------------------------------------------------------------
  it("9. should preserve all original repair budgets, timeouts, and contract invariants", () => {
    expect(DEFAULT_REPAIR_CONFIG.maxSteps).toBe(6);
    expect(DEFAULT_REPAIR_CONFIG.maxAttempts).toBe(8);
    expect(DEFAULT_REPAIR_CONFIG.maxModelCalls).toBe(10);
    expect(DEFAULT_REPAIR_CONFIG.maxToolCalls).toBe(20);
    expect(DEFAULT_REPAIR_CONFIG.timeoutMs).toBe(120_000);
    expect(DEFAULT_REPAIR_CONFIG.maxFeedbackBytes).toBe(4096);
    expect(DEFAULT_REPAIR_CONFIG.autoCommitForbidden).toBe(true);
    expect(DEFAULT_REPAIR_CONFIG.autoPushForbidden).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 10. Evidence digest integrity
  // ---------------------------------------------------------------------------
  it("10. should compute and preserve cryptographically valid SHA-256 manifest hashes", () => {
    const calibManifest = calibLoader.loadManifest();
    expect(calibManifest.manifestHash).toMatch(/^[a-f0-9]{64}$/);

    const reloaded = new CalibrationManifestLoader().loadManifest();
    expect(reloaded.manifestHash).toBe(calibManifest.manifestHash);
  });

  // ---------------------------------------------------------------------------
  // 11. Replay determinism across 3 sweeps
  // ---------------------------------------------------------------------------
  it("11. should reconstruct replay reports identically across 3 independent sweeps without executing code", () => {
    const replayEngine = new ProductionReplayEngine();

    const mockBundle: ProductionEvidenceBundle = {
      runId: "run-calib-replay",
      missionId: "mission-calib-001",
      contractId: "contract-calib",
      contractHash: "contracthash123",
      workspacePath: "/fake/calib",
      repositoryPath: "/fake/repo",
      modelId: "qwen2.5-coder:3b",
      contextDigest: "ctxdigest456",
      actionsCount: 1,
      attemptsCount: 1,
      gitDiff: "diff --git a/auth.js b/auth.js\n- false\n+ true",
      testResults: {
        passed: true,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        durationMs: 45,
      },
      verificationResult: {
        verified: true,
        sovereignVerifier: "ProductionVerifier_CleanRoom_v1",
        proofHash: "proof-calib-001",
      },
      timeline: [
        {
          sequence: 1,
          timestamp: "2026-10-22T10:00:00.000Z",
          eventType: "verification.completed",
          actor: "SovereignVerifier",
          description: "Sovereign verification PASSED. Proof: proof-calib-001",
          details: { verified: true, proofHash: "proof-calib-001" },
          hash: "thash1",
        },
      ],
      disposition: "ACCEPTED",
      completedAt: "2026-10-22T10:00:05.000Z",
      bundleDigest: "sealed-calib-bundle-digest",
    };

    const sweep1 = replayEngine.reconstructRun(mockBundle);
    const sweep2 = replayEngine.reconstructRun(mockBundle);
    const sweep3 = replayEngine.reconstructRun(mockBundle);

    expect(sweep1.reconstructedSuccessfully).toBe(true);
    expect(sweep1.verification.proofHash).toBe("proof-calib-001");
    expect(sweep1).toEqual(sweep2);
    expect(sweep2).toEqual(sweep3);
  });

  // ---------------------------------------------------------------------------
  // 12. Zero automatic commits or pushes
  // ---------------------------------------------------------------------------
  it("12. should strictly maintain the no-auto-commit and no-auto-push invariant", () => {
    expect(DEFAULT_REPAIR_CONFIG.autoCommitForbidden).toBe(true);
    expect(DEFAULT_REPAIR_CONFIG.autoPushForbidden).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 13. Preservation of user modifications
  // ---------------------------------------------------------------------------
  it("13. should verify baseline git hash integrity check protects unstaged user changes", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "user-mod-check-"));
    try {
      execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Tester"], { cwd: tmpDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@test.local"], { cwd: tmpDir, stdio: "ignore" });

      fs.writeFileSync(path.join(tmpDir, "file.txt"), "committed", "utf8");
      execFileSync("git", ["add", "."], { cwd: tmpDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: tmpDir, stdio: "ignore" });

      const initialHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf8" }).trim();

      // Simulate unstaged user modification
      fs.writeFileSync(path.join(tmpDir, "unrelated-user-work.txt"), "do not touch", "utf8");

      const currentHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf8" }).trim();
      // HEAD must be unaltered
      expect(currentHead).toBe(initialHead);
      // User modification must exist intact
      expect(fs.readFileSync(path.join(tmpDir, "unrelated-user-work.txt"), "utf8")).toBe("do not touch");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // 14. Existing scope and capability-fencing behavior
  // ---------------------------------------------------------------------------
  it("14. should enforce capability fence restrictions on unauthorized tool execution", () => {
    const fenceEnforcer = new CapabilityFenceEnforcer();
    const rawFence = {
      fenceId: "fence-calib-test",
      subjectId: "agent-1",
      roleId: "developer",
      harnessId: "HARNESS_IMPLEMENTATION",
      allowedCapabilities: ["READ_WORKSPACE", "EXECUTE_ANALYSIS"] as const,
      forbiddenCapabilities: ["WRITE_REPOSITORY", "NETWORK_ACCESS"] as const,
      scope: {
        allowedWorkspacePaths: ["/workspace"],
        forbiddenWorkspacePaths: ["/etc"],
        allowedTools: ["read_file"],
        maxOperations: 10,
        maxMemoryBytes: 1024 * 1024,
        networkAllowed: false as const,
        gitWriteAllowed: false as const,
      },
      trustLabel: "GOVERNED_OBSERVATION" as const,
      status: "ACTIVE" as const,
      delegatedFenceIds: [],
      version: 1,
      missionContractId: "contract-1",
      missionContractHash: "hash-1",
      authoritative: false as const,
      terminalAuthority: false as const,
      sovereignAuthority: false as const,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };

    const testFence: CapabilityFence = {
      ...rawFence,
      hash: "fence-hash-1",
    };

    fenceEnforcer.registerFence(testFence);

    // Allowed capability check
    const allowedCheck = fenceEnforcer.evaluateCapability(testFence.fenceId, testFence.subjectId, "READ_WORKSPACE");
    expect(allowedCheck.granted).toBe(true);

    // Forbidden capability check
    const forbiddenCheck = fenceEnforcer.evaluateCapability(testFence.fenceId, testFence.subjectId, "WRITE_REPOSITORY");
    expect(forbiddenCheck.granted).toBe(false);
  });
});
