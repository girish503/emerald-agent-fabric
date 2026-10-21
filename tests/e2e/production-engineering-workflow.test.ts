/**
 * Emerald Agent Fabric — Production End-to-End Acceptance Test
 *
 * Exercises the complete real-world engineering workflow:
 * User Task
 *   ↓
 * Mission Creation
 *   ↓
 * MissionContract Binding & Cryptographic Hash
 *   ↓
 * Workspace Allocation & Git Initialization
 *   ↓
 * Governed Agent Loop:
 *   - Context Engine construction
 *   - Model proposal (read_file)
 *   - Governance facade & Capability fence check
 *   - Tool execution (read_file)
 *   - Model proposal (write_file fix)
 *   - Governance facade & Capability fence check
 *   - Tool execution (write_file)
 *   - Model proposal (test run)
 *   - Verification pipeline (Sovereign Clean-Room Verification)
 *   ↓
 * Evidence Bundle Sealed
 *   ↓
 * Deterministic Replay Reconstruction
 *
 * Invariants Asserted:
 * - The model proposes.
 * - The runtime governs.
 * - The sandbox executes.
 * - The verifier decides.
 * - The evidence proves.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createProductionConfig } from "../../src/config/production-config.js";
import { MissionControl } from "../../src/control-plane/mission-control.js";
import { RunControl } from "../../src/control-plane/run-control.js";
import { EvidenceControl } from "../../src/control-plane/evidence-control.js";
import { CapabilityFenceEnforcer } from "../../src/application/capability-fence-enforcer.js";
import { CrossHarnessGateway } from "../../src/application/cross-harness-gateway.js";
import { ProductionRuntimeEngine, ModelAdapter, AgentProposal } from "../../src/runtime/production-runtime-engine.js";
import { ProductionVerifier } from "../../src/verification/production-verifier.js";
import { ProductionReplayEngine } from "../../src/evidence/production-replay-engine.js";

const execFileAsync = promisify(execFile);

describe("Production E2E Engineering Workflow", () => {
  let fixtureDir: string;

  beforeEach(async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-e2e-fixture-"));

    // 1. Initialize git repo in fixture
    await execFileAsync("git", ["init"], { cwd: fixtureDir });
    await execFileAsync("git", ["config", "user.name", "Emerald Test"], { cwd: fixtureDir });
    await execFileAsync("git", ["config", "user.email", "test@emerald.fabric"], { cwd: fixtureDir });

    // 2. Create buggy source file
    const buggyCode = `// Math Utilities
function multiply(a, b) {
  // BUG: adds instead of multiplying
  return a + b;
}

module.exports = { multiply };
`;
    fs.writeFileSync(path.join(fixtureDir, "calc.js"), buggyCode, "utf8");

    // 3. Create real test file that fails against buggy code
    const testCode = `const { multiply } = require('./calc.js');
const result = multiply(3, 4);
if (result !== 12) {
  console.error("Test failed: expected 12, received " + result);
  process.exit(1);
}
console.log("Test passed: multiply(3, 4) === 12");
process.exit(0);
`;
    fs.writeFileSync(path.join(fixtureDir, "test-calc.js"), testCode, "utf8");

    // 4. Commit baseline into git so git diff captures changes
    await execFileAsync("git", ["add", "calc.js", "test-calc.js"], { cwd: fixtureDir });
    await execFileAsync("git", ["commit", "-m", "baseline with defect"], { cwd: fixtureDir });
  });

  afterEach(() => {
    try {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it("executes the full governed software engineering workflow and repairs the defect", async () => {
    const config = createProductionConfig({
      workspaceRoot: fixtureDir,
      modelProvider: "mock",
      executionProvider: "in-process",
    });

    const missionControl = new MissionControl();
    const runControl = new RunControl();
    const evidenceControl = new EvidenceControl();
    const fenceEnforcer = new CapabilityFenceEnforcer();
    const crossHarnessGateway = new CrossHarnessGateway(fenceEnforcer);
    const verifier = new ProductionVerifier();
    const replayEngine = new ProductionReplayEngine();

    const runtime = new ProductionRuntimeEngine(
      config,
      missionControl,
      runControl,
      fenceEnforcer,
      crossHarnessGateway,
      evidenceControl,
      verifier,
    );

    // Step 1: User creates Mission
    const mission = missionControl.createMission({
      title: "Repair multiplication defect in calc.js",
      description: "Fix calc.js so that multiply(a, b) returns a * b instead of adding.",
      repositoryPath: fixtureDir,
      workspacePath: fixtureDir,
    });

    expect(mission.missionId).toBeDefined();
    expect(mission.contract.spec.contractId).toBe(`contract-${mission.missionId}`);
    expect(mission.contract.contentHash).toHaveLength(64);

    // Step 2: Realistic Model Adapter proposing repair steps
    let step = 0;
    const realisticModelAdapter: ModelAdapter = {
      async proposeAction(_ctx: string): Promise<AgentProposal> {
        step++;
        if (step === 1) {
          // Model proposes reading the buggy file
          return {
            thought: "I need to inspect calc.js to understand the implementation bug.",
            toolName: "read_file",
            toolInput: { path: "calc.js" },
          };
        } else if (step === 2) {
          // Model proposes writing the fixed implementation
          const fixedCode = `// Math Utilities
function multiply(a, b) {
  // FIXED: returns correct product
  return a * b;
}

module.exports = { multiply };
`;
          return {
            thought: "I will correct the addition operator to multiplication in calc.js.",
            toolName: "write_file",
            toolInput: { path: "calc.js", content: fixedCode },
          };
        } else {
          // Model declares goal reached and triggers sovereign verification
          return {
            thought: "The defect in calc.js is corrected. Ready for sovereign verification.",
            toolName: "git_status",
            toolInput: {},
            isGoalReached: true,
          };
        }
      },
    };

    // Step 3: Run the Governed Agent Execution Loop
    const result = await runtime.executeRun(mission.missionId, realisticModelAdapter, {
      testCommand: { cmd: "node", args: ["test-calc.js"] },
    });

    // Step 4: Assert End-to-End Governance and Verification Outlines
    // A. Run Status
    expect(result.run.status).toBe("COMPLETED");
    expect(result.run.actionsCount).toBe(2);

    // B. Sovereign Verification
    expect(result.verification.verified).toBe(true);
    expect(result.verification.proofHash).toHaveLength(64);
    expect(result.verification.stages.every((s) => s.passed)).toBe(true);

    // C. Evidence Bundle
    expect(result.evidence.disposition).toBe("ACCEPTED");
    expect(result.evidence.bundleDigest).toHaveLength(64);
    expect(result.evidence.contractHash).toBe(mission.contract.contentHash);
    expect(result.evidence.testResults.passed).toBe(true);
    expect(result.evidence.gitDiff).toContain("return a * b;");

    // D. Replay Reconstruction
    const replayReport = replayEngine.reconstructRun(result.evidence);
    expect(replayReport.reconstructedSuccessfully).toBe(true);
    expect(replayReport.runId).toBe(result.run.runId);
    expect(replayReport.verification.verified).toBe(true);
    expect(replayReport.changes.diff).toContain("return a * b;");
  });
});
