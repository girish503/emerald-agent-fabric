/**
 * Emerald Agent Fabric — Production V1.3: Repair Workflow & Session Test Suite
 *
 * Verifies all 16 required production repair orchestration guarantees:
 * 1. successful repair
 * 2. failed first proposal followed by recovery
 * 3. malformed patch handling
 * 4. test-failure feedback
 * 5. repeated identical failure
 * 6. exhausted attempt budget
 * 7. exhausted model-call budget
 * 8. timeout and cancellation
 * 9. revoked contract
 * 10. stale lease or interrupted run
 * 11. unexpected mutation scope
 * 12. failed sovereign verification
 * 13. evidence integrity
 * 14. deterministic read-only replay
 * 15. no automatic commit or push
 * 16. preservation of existing user changes
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { createProductionConfig } from "../../src/config/production-config.js";
import { MissionControl } from "../../src/control-plane/mission-control.js";
import { RunControl } from "../../src/control-plane/run-control.js";
import { EvidenceControl } from "../../src/control-plane/evidence-control.js";
import { CapabilityFenceEnforcer } from "../../src/application/capability-fence-enforcer.js";
import { CrossHarnessGateway } from "../../src/application/cross-harness-gateway.js";
import { ProductionVerifier } from "../../src/verification/production-verifier.js";
import { ProductionRecoveryService } from "../../src/recovery/production-recovery-service.js";
import { SourceDiagnosticEngine } from "../../src/production/diagnostics/index.js";
import {
  ProductionRepairOrchestrator,
  TestFailureLocalizer,
} from "../../src/production/repair/index.js";
import { ProductionReplayEngine } from "../../src/evidence/production-replay-engine.js";
import { ModelAdapter } from "../../src/runtime/production-runtime-engine.js";

describe("Emerald Production V1.3: Bounded Repair Orchestration", () => {
  let tmpDir: string;
  let missionControl: MissionControl;
  let runControl: RunControl;
  let fenceEnforcer: CapabilityFenceEnforcer;
  let crossHarnessGateway: CrossHarnessGateway;
  let evidenceControl: EvidenceControl;
  let verifier: ProductionVerifier;
  let recoveryService: ProductionRecoveryService;
  let diagnosticEngine: SourceDiagnosticEngine;
  let testLocalizer: TestFailureLocalizer;
  let orchestrator: ProductionRepairOrchestrator;
  let replayEngine: ProductionReplayEngine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-repair-test-"));

    // Initialize clean git repository in tmpDir
    execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "TestRunner"], { cwd: tmpDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@emerald.fabric"], { cwd: tmpDir, stdio: "ignore" });

    // Initial bugged calculator source
    fs.writeFileSync(
      path.join(tmpDir, "calculator.js"),
      `function add(a, b) {
  return a - b; // BUG: subtraction instead of addition
}
module.exports = { add };
`,
      "utf8",
    );

    // Test file that asserts correctness
    fs.writeFileSync(
      path.join(tmpDir, "test.js"),
      `const { add } = require("./calculator.js");
const assert = require("node:assert");

assert.strictEqual(add(2, 3), 5, "2 + 3 must equal 5");
console.log("ALL_TESTS_PASSED");
`,
      "utf8",
    );

    // Initial commit to establish clean git baseline
    execFileSync("git", ["add", "."], { cwd: tmpDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "Initial commit with defect"], { cwd: tmpDir, stdio: "ignore" });

    const prodConfig = createProductionConfig({
      workspaceRoot: tmpDir,
    });

    missionControl = new MissionControl();
    runControl = new RunControl();
    fenceEnforcer = new CapabilityFenceEnforcer();
    crossHarnessGateway = new CrossHarnessGateway(fenceEnforcer);
    evidenceControl = new EvidenceControl();
    verifier = new ProductionVerifier();
    recoveryService = new ProductionRecoveryService(runControl, fenceEnforcer);
    diagnosticEngine = new SourceDiagnosticEngine();
    testLocalizer = new TestFailureLocalizer();
    replayEngine = new ProductionReplayEngine();

    orchestrator = new ProductionRepairOrchestrator(
      prodConfig,
      missionControl,
      runControl,
      fenceEnforcer,
      crossHarnessGateway,
      evidenceControl,
      verifier,
      recoveryService,
      diagnosticEngine,
      testLocalizer,
    );
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 1. Successful repair
  it("1. executes a successful repair session and achieves SOVEREIGN_VERIFIED_SUCCESS", async () => {
    const mission = missionControl.createMission({
      title: "Fix calculator addition defect",
      description: "Repair add function in calculator.js so test passes",
      repositoryPath: tmpDir,
    });

    const modelAdapter: ModelAdapter = {
      async proposeAction(_ctx: string) {
        return {
          thought: "Fixing operator in calculator.js",
          toolName: "write_file",
          toolInput: {
            path: "calculator.js",
            content: `function add(a, b) {
  return a + b;
}
module.exports = { add };
`,
          },
        };
      },
    };

    const outcome = await orchestrator.executeRepairSession(mission.missionId, modelAdapter, {
      testCommand: { cmd: "node", args: ["test.js"] },
      expectedFiles: ["calculator.js"],
    });

    expect(outcome.session.classification).toBe("SOVEREIGN_VERIFIED_SUCCESS");
    expect(outcome.session.sovereignVerified).toBe(true);
    expect(outcome.verification.verified).toBe(true);
    expect(outcome.changedFiles).toContain("calculator.js");
    expect(outcome.reviewableDiff).toContain("+  return a + b;");
    expect(outcome.reviewableDiff).toContain("-  return a - b;");
  });

  // 2. Failed first proposal followed by recovery
  it("2. handles a failed first proposal followed by successful recovery on revision", async () => {
    const mission = missionControl.createMission({
      title: "Iterative repair with feedback",
      description: "Repair calculator.js",
      repositoryPath: tmpDir,
    });

    let proposalCount = 0;
    const modelAdapter: ModelAdapter = {
      async proposeAction(ctx: string) {
        proposalCount++;
        if (proposalCount === 1) {
          // Still buggy
          return {
            thought: "Attempting wrong repair",
            toolName: "write_file",
            toolInput: {
              path: "calculator.js",
              content: `function add(a, b) { return a * b; } module.exports = { add };`,
            },
          };
        }
        // Second attempt receives test failure feedback
        expect(ctx).toContain("TEST_FAILURE_LOCALIZATION");
        return {
          thought: "Correct repair based on test failure feedback",
          toolName: "write_file",
          toolInput: {
            path: "calculator.js",
            content: `function add(a, b) { return a + b; } module.exports = { add };`,
          },
        };
      },
    };

    const outcome = await orchestrator.executeRepairSession(mission.missionId, modelAdapter, {
      testCommand: { cmd: "node", args: ["test.js"] },
      expectedFiles: ["calculator.js"],
    });

    expect(outcome.session.classification).toBe("SOVEREIGN_VERIFIED_SUCCESS");
    expect(proposalCount).toBe(2);
    expect(outcome.session.localizationsCount).toBeGreaterThan(0);
  });

  // 3. Malformed patch handling
  it("3. detects malformed patches via diagnostics and provides context feedback without running tests", async () => {
    const mission = missionControl.createMission({
      title: "Syntax error detection",
      description: "Fix calculator.js",
      repositoryPath: tmpDir,
    });

    let proposalCount = 0;
    const modelAdapter: ModelAdapter = {
      async proposeAction(ctx: string) {
        proposalCount++;
        if (proposalCount === 1) {
          return {
            thought: "Emitting syntax error",
            toolName: "write_file",
            toolInput: {
              path: "calculator.js",
              content: `function add(a, b { return a + b; // missing closing paren`,
            },
          };
        }
        expect(ctx).toContain("DIAGNOSTIC_FEEDBACK");
        return {
          thought: "Emitting fixed code",
          toolName: "write_file",
          toolInput: {
            path: "calculator.js",
            content: `function add(a, b) { return a + b; } module.exports = { add };`,
          },
        };
      },
    };

    const outcome = await orchestrator.executeRepairSession(mission.missionId, modelAdapter, {
      testCommand: { cmd: "node", args: ["test.js"] },
    });

    expect(outcome.session.sovereignVerified).toBe(true);
    expect(outcome.diagnosticMetrics?.diagnosticFailureCount).toBeGreaterThan(0);
    expect(outcome.diagnosticMetrics?.diagnosticRecoveryCount).toBe(1);
  });

  // 4. Test-failure feedback
  it("4. feeds actionable test failure localization into model context", async () => {
    const mission = missionControl.createMission({
      title: "Test failure localization",
      description: "Test feedback check",
      repositoryPath: tmpDir,
    });

    let receivedTestFeedback = false;
    let turn = 0;
    const modelAdapter: ModelAdapter = {
      async proposeAction(ctx: string) {
        turn++;
        if (turn === 1) {
          return {
            thought: "Making partial change that still fails test",
            toolName: "write_file",
            toolInput: {
              path: "calculator.js",
              content: `function add(a, b) { return 0; } module.exports = { add };`,
            },
          };
        }
        if (ctx.includes("2 + 3 must equal 5")) {
          receivedTestFeedback = true;
        }
        return {
          thought: "Fixed",
          toolName: "write_file",
          toolInput: {
            path: "calculator.js",
            content: `function add(a, b) { return a + b; } module.exports = { add };`,
          },
        };
      },
    };

    const outcome = await orchestrator.executeRepairSession(mission.missionId, modelAdapter, {
      testCommand: { cmd: "node", args: ["test.js"] },
    });

    expect(receivedTestFeedback).toBe(true);
    expect(outcome.session.sovereignVerified).toBe(true);
  });

  // 5. Repeated identical failure
  it("5. detects repeated identical malformed patches and halts with PATCH_FAILURE", async () => {
    const mission = missionControl.createMission({
      title: "Repeated syntax errors",
      description: "Check reflex loop cutoff",
      repositoryPath: tmpDir,
    });

    const identicalBadCode = `function add(a, b { return a + b;`;
    const modelAdapter: ModelAdapter = {
      async proposeAction() {
        return {
          thought: "Repeatedly submitting broken syntax",
          toolName: "write_file",
          toolInput: {
            path: "calculator.js",
            content: identicalBadCode,
          },
        };
      },
    };

    const outcome = await orchestrator.executeRepairSession(mission.missionId, modelAdapter, {
      testCommand: { cmd: "node", args: ["test.js"] },
      config: { maxFeedbackRoundsPerAction: 2 },
    });

    expect(outcome.session.classification).toBe("PATCH_FAILURE");
    expect(outcome.session.stoppedReason).toContain("repeated identical");
    expect(outcome.session.sovereignVerified).toBe(false);
  });

  // 6. Exhausted attempt budget
  it("6. halts when attempt budget is exhausted without passing verification", async () => {
    const mission = missionControl.createMission({
      title: "Budget exhaustion test",
      description: "Exhaust attempts",
      repositoryPath: tmpDir,
    });

    const modelAdapter: ModelAdapter = {
      async proposeAction() {
        return {
          thought: "Reading file repeatedly",
          toolName: "read_file",
          toolInput: { path: "calculator.js" },
        };
      },
    };

    const outcome = await orchestrator.executeRepairSession(mission.missionId, modelAdapter, {
      testCommand: { cmd: "node", args: ["test.js"] },
      config: { maxAttempts: 2, maxSteps: 10 },
    });

    expect(outcome.session.sovereignVerified).toBe(false);
    expect(outcome.session.budgets.remainingAttempts).toBe(0);
  });

  // 7. Exhausted model-call budget
  it("7. halts when model call budget is exhausted", async () => {
    const mission = missionControl.createMission({
      title: "Model call budget exhaustion",
      description: "Exhaust model calls",
      repositoryPath: tmpDir,
    });

    const modelAdapter: ModelAdapter = {
      async proposeAction() {
        return {
          thought: "Reading status",
          toolName: "git_status",
          toolInput: {},
        };
      },
    };

    const outcome = await orchestrator.executeRepairSession(mission.missionId, modelAdapter, {
      testCommand: { cmd: "node", args: ["test.js"] },
      config: { maxModelCalls: 1, maxSteps: 5 },
    });

    expect(outcome.session.sovereignVerified).toBe(false);
    expect(outcome.session.budgets.remainingModelCalls).toBe(0);
  });

  // 8. Timeout and cancellation
  it("8. halts with TIMEOUT when time budget expires", async () => {
    const mission = missionControl.createMission({
      title: "Timeout test",
      description: "Exceed timeout",
      repositoryPath: tmpDir,
    });

    const modelAdapter: ModelAdapter = {
      async proposeAction() {
        // Sleep slightly to ensure time advances beyond timeoutMs
        await new Promise((r) => setTimeout(r, 10));
        return {
          thought: "Reading file",
          toolName: "read_file",
          toolInput: { path: "calculator.js" },
        };
      },
    };

    const outcome = await orchestrator.executeRepairSession(mission.missionId, modelAdapter, {
      testCommand: { cmd: "node", args: ["test.js"] },
      config: { timeoutMs: 1 }, // 1ms timeout guarantees expiration
    });

    expect(outcome.session.classification).toBe("TIMEOUT");
    expect(outcome.session.sovereignVerified).toBe(false);
  });

  // 9. Revoked contract
  it("9. rejects execution fail-closed if mission contract is revoked", async () => {
    const mission = missionControl.createMission({
      title: "Revoked mission",
      description: "Should fail immediately",
      repositoryPath: tmpDir,
    });

    missionControl.revokeMission(mission.missionId, "Revoked for test");

    const modelAdapter: ModelAdapter = {
      async proposeAction() {
        return { thought: "noop", toolName: "git_status", toolInput: {} };
      },
    };

    await expect(
      orchestrator.executeRepairSession(mission.missionId, modelAdapter),
    ).rejects.toThrow("Cannot start repair session on REVOKED mission");
  });

  // 10. Stale lease or interrupted run
  it("10. safely recovers interrupted or stale runs via ProductionRecoveryService", () => {
    const mission = missionControl.createMission({
      title: "Interrupted run recovery",
      description: "Recovery test",
      repositoryPath: tmpDir,
    });

    const run = runControl.createRun(mission);
    runControl.transitionStatus(run.runId, "EXECUTING");

    const outcome = recoveryService.recoverRun(run.runId);
    expect(outcome.statusBefore).toBe("EXECUTING");
    expect(outcome.statusAfter).toBe("FAILED");
    expect(outcome.leasesFenced).toBeGreaterThanOrEqual(1);
  });

  // 11. Unexpected mutation scope
  it("11. detects unexpected mutation scope and rejects verification", async () => {
    const mission = missionControl.createMission({
      title: "Scope boundary check",
      description: "Modify unauthorized file",
      repositoryPath: tmpDir,
    });

    const modelAdapter: ModelAdapter = {
      async proposeAction() {
        return {
          thought: "Modifying unauthorized file",
          toolName: "write_file",
          toolInput: {
            path: "unauthorized.js",
            content: "console.log('out of scope');",
          },
        };
      },
    };

    const outcome = await orchestrator.executeRepairSession(mission.missionId, modelAdapter, {
      testCommand: { cmd: "node", args: ["test.js"] },
      expectedFiles: ["calculator.js"], // only calculator.js allowed
    });

    expect(outcome.session.scopeViolations).toContain("unauthorized.js");
    expect(outcome.session.sovereignVerified).toBe(false);
  });

  // 12. Failed sovereign verification
  it("12. classifies unverified runs as VERIFICATION_FAILURE", async () => {
    const mission = missionControl.createMission({
      title: "Verification failure",
      description: "Tests do not pass",
      repositoryPath: tmpDir,
    });

    const modelAdapter: ModelAdapter = {
      async proposeAction() {
        return {
          thought: "Declaring done without fixing",
          toolName: "git_status",
          toolInput: {},
          isGoalReached: true,
        };
      },
    };

    const outcome = await orchestrator.executeRepairSession(mission.missionId, modelAdapter, {
      testCommand: { cmd: "node", args: ["test.js"] },
    });

    expect(outcome.session.classification).toBe("VERIFICATION_FAILURE");
    expect(outcome.session.sovereignVerified).toBe(false);
  });

  // 13. Evidence integrity
  it("13. seals an evidence bundle with valid cryptographic hashes and timeline records", async () => {
    const mission = missionControl.createMission({
      title: "Evidence audit",
      description: "Check evidence integrity",
      repositoryPath: tmpDir,
    });

    const modelAdapter: ModelAdapter = {
      async proposeAction() {
        return {
          thought: "Fixing calculator",
          toolName: "write_file",
          toolInput: {
            path: "calculator.js",
            content: `function add(a, b) { return a + b; } module.exports = { add };`,
          },
        };
      },
    };

    const outcome = await orchestrator.executeRepairSession(mission.missionId, modelAdapter, {
      testCommand: { cmd: "node", args: ["test.js"] },
    });

    expect(outcome.evidence.bundleDigest).toBeDefined();
    expect(outcome.evidence.bundleDigest.length).toBe(64);
    expect(outcome.evidence.timeline.length).toBeGreaterThan(5);
    expect(outcome.evidence.verificationResult.proofHash).toBeDefined();
  });

  // 14. Deterministic read-only replay
  it("14. produces deterministic replay reports across 3 consecutive sweeps", async () => {
    const mission = missionControl.createMission({
      title: "Replay determinism",
      description: "Test 3 sweeps identical",
      repositoryPath: tmpDir,
    });

    const modelAdapter: ModelAdapter = {
      async proposeAction() {
        return {
          thought: "Fixing bug",
          toolName: "write_file",
          toolInput: {
            path: "calculator.js",
            content: `function add(a, b) { return a + b; } module.exports = { add };`,
          },
        };
      },
    };

    const outcome = await orchestrator.executeRepairSession(mission.missionId, modelAdapter, {
      testCommand: { cmd: "node", args: ["test.js"] },
    });

    const r1 = replayEngine.reconstructRun(outcome.evidence);
    const r2 = replayEngine.reconstructRun(outcome.evidence);
    const r3 = replayEngine.reconstructRun(outcome.evidence);

    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    expect(JSON.stringify(r2)).toBe(JSON.stringify(r3));
    expect(r1.reconstructedSuccessfully).toBe(true);
  });

  // 15. No automatic commit or push
  it("15. guarantees no git commit or push was executed during the session", async () => {
    const initialCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir }).toString().trim();

    const mission = missionControl.createMission({
      title: "No commit guarantee",
      description: "Ensure git commit tree unchanged",
      repositoryPath: tmpDir,
    });

    const modelAdapter: ModelAdapter = {
      async proposeAction() {
        return {
          thought: "Repairing in place",
          toolName: "write_file",
          toolInput: {
            path: "calculator.js",
            content: `function add(a, b) { return a + b; } module.exports = { add };`,
          },
        };
      },
    };

    await orchestrator.executeRepairSession(mission.missionId, modelAdapter, {
      testCommand: { cmd: "node", args: ["test.js"] },
    });

    const currentCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir }).toString().trim();
    expect(currentCommit).toBe(initialCommit);
  });

  // 16. Preservation of existing user changes
  it("16. preserves unstaged user changes outside repair session", async () => {
    // User creates an unrelated unstaged file
    const userUnstagedFile = path.join(tmpDir, "my-notes.txt");
    fs.writeFileSync(userUnstagedFile, "Important user scratch notes", "utf8");

    const mission = missionControl.createMission({
      title: "Preserve user files",
      description: "Check user notes remain intact",
      repositoryPath: tmpDir,
    });

    const modelAdapter: ModelAdapter = {
      async proposeAction() {
        return {
          thought: "Fixing calculator only",
          toolName: "write_file",
          toolInput: {
            path: "calculator.js",
            content: `function add(a, b) { return a + b; } module.exports = { add };`,
          },
        };
      },
    };

    await orchestrator.executeRepairSession(mission.missionId, modelAdapter, {
      testCommand: { cmd: "node", args: ["test.js"] },
    });

    expect(fs.existsSync(userUnstagedFile)).toBe(true);
    expect(fs.readFileSync(userUnstagedFile, "utf8")).toBe("Important user scratch notes");
  });
});
