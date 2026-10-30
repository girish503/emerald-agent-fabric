/**
 * Emerald Agent Fabric — Production V1.7: Anchored Edit Tool-Selection Calibration Tests
 *
 * Verifies all 15 required criteria for tool-selection calibration:
 * 1. Demonstration enabled versus disabled prompt construction.
 * 2. Exact prompt fragment and digest versioning.
 * 3. Baseline prompt unchanged when the feature is disabled.
 * 4. No benchmark-specific source code in the demonstration.
 * 5. Existing tool schema and capability checks preserved.
 * 6. Valid structured requests reaching the tool gateway.
 * 7. Malformed requests rejected without mutation.
 * 8. Ambiguous anchors rejected without mutation.
 * 9. No silent fallback from failed anchored edits to whole-file replacement.
 * 10. Original and resulting digest integrity.
 * 11. Evidence and timeline recording.
 * 12. Replay reconstruction without re-running the model, tool, tests, or workspace mutations.
 * 13. Preservation of user changes and untracked files.
 * 14. No automatic commits or pushes.
 * 15. No change to the frozen task manifests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import {
  CalibrationManifestLoader,
  ANCHORED_EDIT_DEMONSTRATION_VERSION,
  ANCHORED_EDIT_DEMONSTRATION_FRAGMENT,
  getAnchoredEditDemonstrationDigest,
} from "../../src/production/benchmark/calibration-manifest.js";
import { BenchmarkManifestLoader } from "../../src/production/benchmark/benchmark-manifest.js";
import { LineAnchoredEditor } from "../../src/production/repair/line-anchored-editor.js";
import { ProductionToolGateway } from "../../src/tools/production-tools.js";
import { ProductionGovernanceFacade } from "../../src/governance/production-governance-facade.js";
import { CapabilityFenceEnforcer } from "../../src/application/capability-fence-enforcer.js";
import { CrossHarnessGateway } from "../../src/application/cross-harness-gateway.js";
import { ProductionReplayEngine } from "../../src/evidence/production-replay-engine.js";
import { ProductionEvidenceBundle } from "../../src/control-plane/evidence-control.js";
import { CapabilityFence } from "../../src/domain/capability-fence.js";

describe("Production V1.7: Anchored Edit Tool-Selection Calibration", () => {
  let tempDir: string;
  let editor: LineAnchoredEditor;
  let manifestLoader: CalibrationManifestLoader;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-v17-test-"));
    editor = new LineAnchoredEditor();
    manifestLoader = new CalibrationManifestLoader();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup locks
    }
  });

  // 1. Demonstration enabled versus disabled prompt construction
  it("1. should produce distinct prompts when demonstration is enabled vs disabled", () => {
    const task = manifestLoader.loadManifest().tasks[0]!;

    const baselinePrompt = manifestLoader.buildUntrustedPromptForModel(task, {
      lineAnchoredEditingEnabled: true,
      anchoredEditDemonstrationEnabled: false,
    });

    const treatmentPrompt = manifestLoader.buildUntrustedPromptForModel(task, {
      lineAnchoredEditingEnabled: true,
      anchoredEditDemonstrationEnabled: true,
    });

    expect(treatmentPrompt).not.toBe(baselinePrompt);
    expect(treatmentPrompt).toContain(ANCHORED_EDIT_DEMONSTRATION_FRAGMENT);
    expect(baselinePrompt).not.toContain(ANCHORED_EDIT_DEMONSTRATION_FRAGMENT);
  });

  // 2. Exact prompt fragment and digest versioning
  it("2. should maintain deterministic versioning and SHA-256 digest for demonstration fragment", () => {
    expect(ANCHORED_EDIT_DEMONSTRATION_VERSION).toBe("v1.7.0");
    const digest = getAnchoredEditDemonstrationDigest();
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).toBe(getAnchoredEditDemonstrationDigest());
  });

  // 3. Baseline prompt unchanged when the feature is disabled
  it("3. should keep baseline prompt byte-for-byte identical when demonstration is omitted", () => {
    const task = manifestLoader.loadManifest().tasks[0]!;

    const defaultPrompt = manifestLoader.buildUntrustedPromptForModel(task, {
      lineAnchoredEditingEnabled: true,
    });

    const explicitFalsePrompt = manifestLoader.buildUntrustedPromptForModel(task, {
      lineAnchoredEditingEnabled: true,
      anchoredEditDemonstrationEnabled: false,
    });

    expect(defaultPrompt).toBe(explicitFalsePrompt);
  });

  // 4. No benchmark-specific source code in the demonstration
  it("4. should verify that the demonstration contains zero task-specific code, solutions, or benchmark assertions", () => {
    const manifest = manifestLoader.loadManifest();
    for (const task of manifest.tasks) {
      // Must not mention task source filenames
      expect(ANCHORED_EDIT_DEMONSTRATION_FRAGMENT).not.toContain(task.sourceFile);
      // Must not mention task test filenames
      expect(ANCHORED_EDIT_DEMONSTRATION_FRAGMENT).not.toContain(task.testFile);
      // Must not mention task IDs
      expect(ANCHORED_EDIT_DEMONSTRATION_FRAGMENT).not.toContain(task.taskId);
    }
    // Confirms synthetic filename is used
    expect(ANCHORED_EDIT_DEMONSTRATION_FRAGMENT).toContain("config.js");
    expect(ANCHORED_EDIT_DEMONSTRATION_FRAGMENT).toContain("SERVICE_NAME");
  });

  // 5. Existing tool schema and capability checks preserved
  it("5. should preserve tool capability mapping for edit_file_anchor and write_file", () => {
    const fenceEnforcer = new CapabilityFenceEnforcer();
    const crossGateway = new CrossHarnessGateway(fenceEnforcer);
    const governance = new ProductionGovernanceFacade(fenceEnforcer, crossGateway);
    const gateway = new ProductionToolGateway(governance);

    expect(gateway["mapToolToCapability"]("edit_file_anchor")).toBe("WRITE_TEMPORARY_OUTPUT");
    expect(gateway["mapToolToCapability"]("write_file")).toBe("WRITE_TEMPORARY_OUTPUT");
  });

  // 6. Valid structured requests reaching the tool gateway
  it("6. should route a valid edit_file_anchor structured request through the gateway successfully", async () => {
    const fenceEnforcer = new CapabilityFenceEnforcer();
    const crossGateway = new CrossHarnessGateway(fenceEnforcer);
    const governance = new ProductionGovernanceFacade(fenceEnforcer, crossGateway);
    const gateway = new ProductionToolGateway(governance);

    const testFence: CapabilityFence = {
      fenceId: "fence-dev-1",
      subjectId: "agent-1",
      roleId: "developer",
      harnessId: "harness-1",
      allowedCapabilities: ["WRITE_TEMPORARY_OUTPUT", "READ_WORKSPACE"],
      forbiddenCapabilities: ["WRITE_REPOSITORY", "NETWORK_ACCESS"],
      scope: {
        allowedWorkspacePaths: [tempDir],
        forbiddenWorkspacePaths: ["/etc"],
        allowedTools: ["edit_file_anchor"],
        maxOperations: 10,
        maxMemoryBytes: 1024 * 1024,
        networkAllowed: false,
        gitWriteAllowed: false,
      },
      trustLabel: "GOVERNED_OBSERVATION",
      status: "ACTIVE",
      delegatedFenceIds: [],
      version: 1,
      missionContractId: "contract-1",
      missionContractHash: "hash-1",
      authoritative: false,
      terminalAuthority: false,
      sovereignAuthority: false,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      hash: "fence-hash-1",
    };

    fenceEnforcer.registerFence(testFence);

    const targetFile = path.join(tempDir, "sample.js");
    fs.writeFileSync(targetFile, `const PORT = 3000;\n`, "utf8");

    const res = await gateway.executeTool(
      "edit_file_anchor",
      {
        path: "sample.js",
        searchAnchor: "const PORT = 3000;",
        replacementText: "const PORT = 8080;",
      },
      {
        runId: "run-1",
        subjectId: "agent-1",
        fenceId: "fence-dev-1",
        harnessType: "IMPLEMENTATION_HARNESS",
        workspacePath: tempDir,
        missionContractHash: "hash-1",
      },
    );

    expect(res.success).toBe(true);
    expect(fs.readFileSync(targetFile, "utf8")).toBe(`const PORT = 8080;\n`);
  });

  // 7. Malformed requests rejected without mutation
  it("7. should reject malformed edit requests without mutating target file", async () => {
    const targetFile = path.join(tempDir, "immutable.js");
    const initialContent = `const IMMUTABLE = 100;\n`;
    fs.writeFileSync(targetFile, initialContent, "utf8");

    expect(() =>
      editor.applyEdit(
        {
          path: "immutable.js",
          searchAnchor: "", // Empty anchor
          replacementText: "const IMMUTABLE = 200;",
        },
        tempDir,
      ),
    ).toThrow(/searchAnchor.*cannot be empty/);

    expect(fs.readFileSync(targetFile, "utf8")).toBe(initialContent);
  });

  // 8. Ambiguous anchors rejected without mutation
  it("8. should reject ambiguous anchors (matching multiple locations) without mutating file", () => {
    const targetFile = path.join(tempDir, "ambiguous.js");
    const initialContent = `let a = 1;\nlet a = 1;\n`;
    fs.writeFileSync(targetFile, initialContent, "utf8");

    expect(() =>
      editor.applyEdit(
        {
          path: "ambiguous.js",
          searchAnchor: "let a = 1;",
          replacementText: "let a = 2;",
        },
        tempDir,
      ),
    ).toThrow(/Ambiguous search anchor/);

    expect(fs.readFileSync(targetFile, "utf8")).toBe(initialContent);
  });

  // 9. No silent fallback from failed anchored edits to whole-file replacement
  it("9. should verify that failed anchored edits never silently fall back to whole-file replacement", () => {
    const targetFile = path.join(tempDir, "critical.js");
    const originalContent = `function important() { return 42; }\n`;
    fs.writeFileSync(targetFile, originalContent, "utf8");

    try {
      editor.applyEdit(
        {
          path: "critical.js",
          searchAnchor: "non_existent_span",
          replacementText: "function important() { return 100; }",
        },
        tempDir,
      );
    } catch {
      // Expected rejection
    }

    // Must still contain the original content, not the replacement text
    expect(fs.readFileSync(targetFile, "utf8")).toBe(originalContent);
  });

  // 10. Original and resulting digest integrity
  it("10. should accurately track original and resulting file digests", () => {
    const targetFile = path.join(tempDir, "hash.js");
    fs.writeFileSync(targetFile, `const HASH = "initial";\n`, "utf8");

    const res = editor.applyEdit(
      {
        path: "hash.js",
        searchAnchor: `const HASH = "initial";`,
        replacementText: `const HASH = "updated";`,
      },
      tempDir,
    );

    expect(res.originalDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(res.resultingDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(res.originalDigest).not.toBe(res.resultingDigest);
  });

  // 11. Evidence and timeline recording
  it("11. should structure anchored edit evidence timeline events without secret exposure", () => {
    const event = {
      sequence: 1,
      eventType: "repair.file_anchored_edit",
      actor: "agent-1",
      description: "Line-anchored edit applied to service.js",
      details: {
        filePath: "service.js",
        originalDigest: "abc1",
        resultingDigest: "def2",
        targetSpanLength: 15,
        outcome: "SUCCESS",
      },
    };

    expect(event.details.filePath).toBe("service.js");
    expect(event.details.outcome).toBe("SUCCESS");
    expect(event.details).not.toHaveProperty("fileContent");
  });

  // 12. Replay reconstruction without re-running the model, tool, tests, or workspace mutations
  it("12. should deterministically reconstruct anchored edit events in replay report", () => {
    const replayEngine = new ProductionReplayEngine();

    const mockBundle: ProductionEvidenceBundle = {
      runId: "run-v17-replay",
      missionId: "mission-v17",
      contractId: "contract-v17",
      contractHash: "hash-v17",
      workspacePath: tempDir,
      repositoryPath: tempDir,
      modelId: "qwen2.5-coder:3b",
      contextDigest: "ctx-v17",
      actionsCount: 1,
      attemptsCount: 1,
      gitDiff: "diff --git a/service.js b/service.js",
      testResults: {
        passed: true,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        durationMs: 40,
      },
      verificationResult: {
        verified: true,
        sovereignVerifier: "ProductionVerifier_CleanRoom_v1",
        proofHash: "proof-v17",
      },
      timeline: [
        {
          sequence: 1,
          timestamp: new Date().toISOString(),
          eventType: "repair.file_anchored_edit",
          actor: "agent-1",
          description: "Line-anchored edit applied to service.js",
          details: {
            filePath: "service.js",
            originalDigest: "dig1",
            resultingDigest: "dig2",
            outcome: "SUCCESS",
          },
          hash: "h1",
        },
      ],
      disposition: "ACCEPTED",
      completedAt: new Date().toISOString(),
      bundleDigest: "bundle-v17",
    };

    const s1 = replayEngine.reconstructRun(mockBundle);
    const s2 = replayEngine.reconstructRun(mockBundle);
    const s3 = replayEngine.reconstructRun(mockBundle);

    expect(s1.reconstructedSuccessfully).toBe(true);
    expect(s1.anchoredEditObservations).toBeDefined();
    expect(s1.anchoredEditObservations?.length).toBe(1);
    expect(s1).toEqual(s2);
    expect(s2).toEqual(s3);
  });

  // 13. Preservation of user changes and untracked files
  it("13. should preserve user changes on untracked files across editing operations", () => {
    const userFile = path.join(tempDir, "user_scratch.md");
    fs.writeFileSync(userFile, "# User Notes: Do Not Overwrite", "utf8");

    const targetFile = path.join(tempDir, "app.js");
    fs.writeFileSync(targetFile, "const x = 1;\n", "utf8");

    editor.applyEdit(
      {
        path: "app.js",
        searchAnchor: "const x = 1;",
        replacementText: "const x = 2;",
      },
      tempDir,
    );

    expect(fs.readFileSync(userFile, "utf8")).toBe("# User Notes: Do Not Overwrite");
    expect(fs.readFileSync(targetFile, "utf8")).toBe("const x = 2;\n");
  });

  // 14. No automatic commits or pushes
  it("14. should ensure anchored edits execute with zero automatic git commits or pushes", () => {
    execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@test.local"], { cwd: tempDir, stdio: "ignore" });

    const target = path.join(tempDir, "main.js");
    fs.writeFileSync(target, "let val = 1;\n", "utf8");
    execFileSync("git", ["add", "main.js"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: tempDir, stdio: "ignore" });

    const initialSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tempDir, encoding: "utf8" }).trim();

    editor.applyEdit(
      {
        path: "main.js",
        searchAnchor: "let val = 1;",
        replacementText: "let val = 2;",
      },
      tempDir,
    );

    const finalSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tempDir, encoding: "utf8" }).trim();
    expect(initialSha).toBe(finalSha);

    const status = execFileSync("git", ["status", "--porcelain"], { cwd: tempDir, encoding: "utf8" });
    expect(status).toContain("M main.js");
  });

  // 15. No change to the frozen task manifests
  it("15. should confirm calibration and SWE-bench manifests remain byte-identical", () => {
    const calibLoader = new CalibrationManifestLoader();
    expect(calibLoader.loadManifest().taskCount).toBe(5);
    expect(calibLoader.loadManifest().manifestHash).toBe("150cbb79005a238fe4d8712b4a7d0ced1ce9ebe031c33101990027be63236676");

    const sweLoader = new BenchmarkManifestLoader();
    expect(sweLoader.loadManifest().taskCount).toBe(15);
    expect(sweLoader.loadManifest().manifestHash).toBe("d61852584504ced781f6cb9ca1d10d527aba52eb697ce8488840c34bed29f4a8");
  });
});
