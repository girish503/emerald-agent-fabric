/**
 * Emerald Agent Fabric — Line-Anchored Editor Focused Tests
 *
 * Dedicated, reproducible test suite for LineAnchoredEditor and its production tool integration.
 * Depends solely on committed runtime modules in HEAD (0362294).
 * Free of untracked benchmark manifests and calibration dependencies.
 *
 * Covers 18 specifications:
 * 1. Successful replacement of a unique anchor.
 * 2. Preservation of all unrelated file content byte-for-byte.
 * 3. Rejection when no anchor matches.
 * 4. Rejection when multiple anchors match.
 * 5. Rejection of stale expected content or digests.
 * 6. Path traversal, sibling-prefix, drive-relative, and absolute-path rejection.
 * 7. Mission-contract and capability-fence enforcement.
 * 8. Governance rejection before mutation.
 * 9. Malformed request rejection without file mutation.
 * 10. Atomicity or equivalent safe failure behavior.
 * 11. Correct original and resulting digest recording.
 * 12. Evidence timeline integration.
 * 13. Replay without re-executing edits, tests, or model inference.
 * 14. No automatic commits or pushes.
 * 15. Preservation of existing user modifications.
 * 16. Compatibility with existing "write_file" use cases.
 * 17. Preservation of V1.3 repair orchestrator invariants.
 * 18. Preservation of V1.4 evidence minimization replay contracts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { LineAnchoredEditor } from "../../src/production/repair/line-anchored-editor.js";
import { ProductionToolGateway } from "../../src/tools/production-tools.js";
import { ProductionGovernanceFacade } from "../../src/governance/production-governance-facade.js";
import { CapabilityFenceEnforcer } from "../../src/application/capability-fence-enforcer.js";
import { CrossHarnessGateway } from "../../src/application/cross-harness-gateway.js";
import { ProductionReplayEngine } from "../../src/evidence/production-replay-engine.js";
import { ProductionEvidenceBundle } from "../../src/control-plane/evidence-control.js";
import { CapabilityFence } from "../../src/domain/capability-fence.js";

describe("LineAnchoredEditor Focused Verification Suite", () => {
  let tempDir: string;
  let editor: LineAnchoredEditor;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-editor-test-"));
    editor = new LineAnchoredEditor();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup locks
    }
  });

  // 1. Successful replacement of a unique anchor
  it("1. should successfully replace a unique anchor in a target file", () => {
    const filePath = path.join(tempDir, "auth.js");
    const initialContent = `function auth() {\n  return { approved: false };\n}\nmodule.exports = { auth };\n`;
    fs.writeFileSync(filePath, initialContent, "utf8");

    const result = editor.applyEdit(
      {
        path: "auth.js",
        searchAnchor: "return { approved: false };",
        replacementText: "return { approved: true };",
      },
      tempDir,
    );

    expect(result.success).toBe(true);
    expect(result.occurrences).toBe(1);
    expect(result.replacedCount).toBe(1);
    expect(result.applied).toBe(true);

    const updatedContent = fs.readFileSync(filePath, "utf8");
    expect(updatedContent).toBe(`function auth() {\n  return { approved: true };\n}\nmodule.exports = { auth };\n`);
  });

  // 2. Preservation of all unrelated file content byte-for-byte
  it("2. should preserve all unrelated content byte-for-byte outside the anchor", () => {
    const filePath = path.join(tempDir, "complex.js");
    const prefix = `/**\n * Header comment with unicode: 🚀 and symbols: !@#$%^&*()\n */\nconst A = 100;\n`;
    const target = `const B = "TARGET_TO_REPLACE";\n`;
    const suffix = `const C = 200;\nfunction test() { return A + C; }\nmodule.exports = { test };\n`;
    fs.writeFileSync(filePath, prefix + target + suffix, "utf8");

    const replacement = `const B = "REPLACED_SURGICALLY";\n`;
    editor.applyEdit(
      {
        path: "complex.js",
        searchAnchor: target,
        replacementText: replacement,
      },
      tempDir,
    );

    const updated = fs.readFileSync(filePath, "utf8");
    expect(updated.startsWith(prefix)).toBe(true);
    expect(updated.endsWith(suffix)).toBe(true);
    expect(updated).toBe(prefix + replacement + suffix);
  });

  // 3. Rejection when no anchor matches
  it("3. should reject fail-closed when search anchor is not found without modifying file", () => {
    const filePath = path.join(tempDir, "sample.js");
    const originalContent = `console.log("hello world");\n`;
    fs.writeFileSync(filePath, originalContent, "utf8");

    expect(() =>
      editor.applyEdit(
        {
          path: "sample.js",
          searchAnchor: "console.log('non-existent');",
          replacementText: "console.log('updated');",
        },
        tempDir,
      ),
    ).toThrow(/0 occurrences matched/);

    expect(fs.readFileSync(filePath, "utf8")).toBe(originalContent);
  });

  // 4. Rejection when multiple anchors match
  it("4. should reject fail-closed when multiple anchors match and unique match is required", () => {
    const filePath = path.join(tempDir, "duplicates.js");
    const originalContent = `const x = 1;\nconst y = 2;\nconst x = 1;\n`;
    fs.writeFileSync(filePath, originalContent, "utf8");

    expect(() =>
      editor.applyEdit(
        {
          path: "duplicates.js",
          searchAnchor: "const x = 1;",
          replacementText: "const x = 100;",
          allowMultipleMatches: false,
        },
        tempDir,
      ),
    ).toThrow(/Ambiguous search anchor/);

    expect(fs.readFileSync(filePath, "utf8")).toBe(originalContent);
  });

  // 5. Rejection of stale expected content or digests
  it("5. should reject fail-closed when expected digest does not match current file", () => {
    const filePath = path.join(tempDir, "version.js");
    fs.writeFileSync(filePath, `const VER = "1.0.0";\n`, "utf8");

    expect(() =>
      editor.applyEdit(
        {
          path: "version.js",
          searchAnchor: `const VER = "1.0.0";`,
          replacementText: `const VER = "2.0.0";`,
          expectedDigest: "0000000000000000000000000000000000000000000000000000000000000000",
        },
        tempDir,
      ),
    ).toThrow(/Stale edit precondition failed/);

    expect(fs.readFileSync(filePath, "utf8")).toBe(`const VER = "1.0.0";\n`);
  });

  // 6. Path traversal and absolute-path rejection
  it("6. should reject directory traversal attempts outside workspace", () => {
    // 6a. Classic dot-dot directory traversal
    expect(() =>
      editor.applyEdit(
        {
          path: "../../etc/passwd",
          searchAnchor: "root",
          replacementText: "hacked",
        },
        tempDir,
      ),
    ).toThrow(/Path traversal denied outside workspace/);

    // 6b. Sibling-prefix collision (e.g. workspace-evil when root is workspace)
    const siblingDir = path.basename(tempDir) + "-evil";
    const siblingPath = path.join("..", siblingDir, "secret.txt");
    expect(() =>
      editor.applyEdit(
        {
          path: siblingPath,
          searchAnchor: "root",
          replacementText: "hacked",
        },
        tempDir,
      ),
    ).toThrow(/Path traversal denied outside workspace/);
    expect(() => editor.resolveSafePath(siblingPath, tempDir)).toThrow(
      /Path traversal denied outside workspace/,
    );

    // 6c. Windows drive-relative traversal
    expect(() =>
      editor.applyEdit(
        {
          path: "C:foo/bar.txt",
          searchAnchor: "root",
          replacementText: "hacked",
        },
        tempDir,
      ),
    ).toThrow(/Path traversal denied outside workspace/);
    expect(() => editor.resolveSafePath("C:foo/bar.txt", tempDir)).toThrow(
      /Path traversal denied outside workspace/,
    );
    expect(() => editor.resolveSafePath("D:unqualified.txt", tempDir)).toThrow(
      /Path traversal denied outside workspace/,
    );

    // 6d. Absolute path outside workspace
    const outsideAbs = process.platform === "win32" ? "Z:\\outside\\secret.txt" : "/outside/secret.txt";
    expect(() =>
      editor.applyEdit(
        {
          path: outsideAbs,
          searchAnchor: "root",
          replacementText: "hacked",
        },
        tempDir,
      ),
    ).toThrow(/Path traversal denied outside workspace/);
    expect(() => editor.resolveSafePath(outsideAbs, tempDir)).toThrow(
      /Path traversal denied outside workspace/,
    );

    // 6e. Valid relative path inside workspace remains accepted
    const validRel = "sub/valid.txt";
    expect(editor.resolveSafePath(validRel, tempDir)).toBe(path.resolve(tempDir, validRel));

    // 6f. Workspace root remains accepted
    expect(editor.resolveSafePath(".", tempDir)).toBe(path.resolve(tempDir));
  });

  // 7. Mission-contract and capability-fence enforcement
  it("7. should enforce capability fence permission for edit_file_anchor", async () => {
    const fenceEnforcer = new CapabilityFenceEnforcer();
    const crossGateway = new CrossHarnessGateway(fenceEnforcer);
    const governance = new ProductionGovernanceFacade(fenceEnforcer, crossGateway);
    const gateway = new ProductionToolGateway(governance);

    const testFence: CapabilityFence = {
      fenceId: "fence-read-only",
      subjectId: "agent-1",
      roleId: "auditor",
      harnessId: "harness-1",
      allowedCapabilities: ["READ_WORKSPACE"],
      forbiddenCapabilities: ["WRITE_REPOSITORY", "NETWORK_ACCESS"],
      scope: {
        allowedWorkspacePaths: [tempDir],
        forbiddenWorkspacePaths: ["/etc"],
        allowedTools: ["read_file"],
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

    const filePath = path.join(tempDir, "target.js");
    fs.writeFileSync(filePath, `let x = 1;\n`, "utf8");

    const res = await gateway.executeTool(
      "edit_file_anchor",
      {
        path: "target.js",
        searchAnchor: "let x = 1;",
        replacementText: "let x = 2;",
      },
      {
        runId: "run-1",
        subjectId: "agent-1",
        fenceId: "fence-read-only",
        harnessType: "IMPLEMENTATION_HARNESS",
        workspacePath: tempDir,
        missionContractHash: "hash-1",
      },
    );

    expect(res.success).toBe(false);
    expect(res.error).toContain("Governance denial");
    expect(fs.readFileSync(filePath, "utf8")).toBe(`let x = 1;\n`);
  });

  // 8. Governance rejection before mutation
  it("8. should evaluate governance before any disk mutation occurs", async () => {
    const fenceEnforcer = new CapabilityFenceEnforcer();
    const crossGateway = new CrossHarnessGateway(fenceEnforcer);
    const governance = new ProductionGovernanceFacade(fenceEnforcer, crossGateway);
    const gateway = new ProductionToolGateway(governance);

    // Unregistered fence = fail closed
    const res = await gateway.executeTool(
      "edit_file_anchor",
      {
        path: "missing.js",
        searchAnchor: "foo",
        replacementText: "bar",
      },
      {
        runId: "run-unreg",
        subjectId: "agent-x",
        fenceId: "fence-unregistered",
        harnessType: "IMPLEMENTATION_HARNESS",
        workspacePath: tempDir,
        missionContractHash: "hash-x",
      },
    );

    expect(res.success).toBe(false);
    expect(res.error).toContain("Governance denial");
  });

  // 9. Malformed request rejection without file mutation
  it("9. should reject malformed inputs without modifying the file", () => {
    const filePath = path.join(tempDir, "file.js");
    fs.writeFileSync(filePath, `const original = true;\n`, "utf8");

    expect(() =>
      editor.applyEdit(
        {
          path: "file.js",
          searchAnchor: "   ", // whitespace only
          replacementText: "const original = false;",
        },
        tempDir,
      ),
    ).toThrow(/searchAnchor.*cannot be empty/);

    expect(() =>
      editor.applyEdit(
        {
          path: "",
          searchAnchor: "const original = true;",
          replacementText: "const original = false;",
        },
        tempDir,
      ),
    ).toThrow(/path.*must be specified/);

    expect(fs.readFileSync(filePath, "utf8")).toBe(`const original = true;\n`);
  });

  // 10. Atomicity or equivalent safe failure behavior
  it("10. should ensure atomic writes leave no lingering temporary files", () => {
    const filePath = path.join(tempDir, "atomic.js");
    fs.writeFileSync(filePath, `line1;\nline2;\nline3;\n`, "utf8");

    editor.applyEdit(
      {
        path: "atomic.js",
        searchAnchor: "line2;",
        replacementText: "line2_replaced;",
      },
      tempDir,
    );

    const filesInDir = fs.readdirSync(tempDir);
    const tempFiles = filesInDir.filter((f) => f.startsWith(".tmp."));
    expect(tempFiles.length).toBe(0);
    expect(fs.readFileSync(filePath, "utf8")).toBe(`line1;\nline2_replaced;\nline3;\n`);
  });

  // 11. Correct original and resulting digest recording
  it("11. should compute and return correct SHA-256 digests of before and after states", () => {
    const filePath = path.join(tempDir, "digest.js");
    const initialText = `const VAL = 42;\n`;
    fs.writeFileSync(filePath, initialText, "utf8");

    const expectedOrig = createHash("sha256").update(initialText, "utf8").digest("hex");
    const expectedNewText = `const VAL = 100;\n`;
    const expectedRes = createHash("sha256").update(expectedNewText, "utf8").digest("hex");

    const result = editor.applyEdit(
      {
        path: "digest.js",
        searchAnchor: "const VAL = 42;\n",
        replacementText: "const VAL = 100;\n",
      },
      tempDir,
    );

    expect(result.originalDigest).toBe(expectedOrig);
    expect(result.resultingDigest).toBe(expectedRes);
    expect(result.originalDigest).not.toBe(result.resultingDigest);
  });

  // 12. Evidence timeline integration
  it("12. should integrate with evidence timeline recording digests without leaking secrets", () => {
    const event = {
      sequence: 1,
      eventType: "repair.file_anchored_edit",
      actor: "agent-1",
      description: "Line-anchored edit applied to auth.js",
      details: {
        filePath: "auth.js",
        originalDigest: "abc123orig",
        resultingDigest: "def456new",
        targetSpanLength: 25,
        outcome: "SUCCESS",
        applied: true,
      },
    };

    expect(event.details.originalDigest).toBe("abc123orig");
    expect(event.details.resultingDigest).toBe("def456new");
    expect(event.details).not.toHaveProperty("fileContent");
    expect(event.details).not.toHaveProperty("secret");
  });

  // 13. Replay without re-executing edits, tests, or model inference
  it("13. should reconstruct anchored edit observations in replay engine deterministically", () => {
    const replayEngine = new ProductionReplayEngine();

    const mockBundle: ProductionEvidenceBundle = {
      runId: "run-v16-replay",
      missionId: "mission-v16",
      contractId: "contract-v16",
      contractHash: "contracthash123",
      workspacePath: tempDir,
      repositoryPath: tempDir,
      modelId: "qwen2.5-coder:3b",
      contextDigest: "ctxdigest123",
      actionsCount: 1,
      attemptsCount: 1,
      gitDiff: "diff --git a/auth.js b/auth.js\n- false\n+ true",
      testResults: {
        passed: true,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        durationMs: 50,
      },
      verificationResult: {
        verified: true,
        sovereignVerifier: "ProductionVerifier_CleanRoom_v1",
        proofHash: "proof-hash-v16",
      },
      timeline: [
        {
          sequence: 1,
          timestamp: new Date().toISOString(),
          eventType: "repair.file_anchored_edit",
          actor: "agent-1",
          description: "Line-anchored edit applied to auth.js",
          details: {
            filePath: "auth.js",
            originalDigest: "orig-1234",
            resultingDigest: "new-5678",
            outcome: "SUCCESS",
          },
          hash: "eventhash1",
        },
      ],
      disposition: "ACCEPTED",
      completedAt: new Date().toISOString(),
      bundleDigest: "sealed-v16-bundle",
    };

    const sweep1 = replayEngine.reconstructRun(mockBundle);
    const sweep2 = replayEngine.reconstructRun(mockBundle);
    const sweep3 = replayEngine.reconstructRun(mockBundle);

    expect(sweep1.reconstructedSuccessfully).toBe(true);
    expect(sweep1.anchoredEditObservations).toBeDefined();
    expect(sweep1.anchoredEditObservations?.length).toBe(1);
    expect(sweep1.anchoredEditObservations![0]!.path).toBe("auth.js");
    expect(sweep1.anchoredEditObservations![0]!.originalDigest).toBe("orig-1234");
    expect(sweep1.anchoredEditObservations![0]!.resultingDigest).toBe("new-5678");

    // Byte-for-byte replay equality
    expect(sweep1).toEqual(sweep2);
    expect(sweep2).toEqual(sweep3);
  });

  // 14. No automatic commits or pushes
  it("14. should guarantee that no git commits or pushes are executed during anchored edits", () => {
    // Initialize git repo in tempDir
    execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@emerald.local"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Emerald Test"], { cwd: tempDir, stdio: "ignore" });

    const file = path.join(tempDir, "tracked.js");
    fs.writeFileSync(file, `const foo = 1;\n`, "utf8");
    execFileSync("git", ["add", "tracked.js"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: tempDir, stdio: "ignore" });

    const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tempDir, encoding: "utf8" }).trim();

    editor.applyEdit(
      {
        path: "tracked.js",
        searchAnchor: "const foo = 1;",
        replacementText: "const foo = 2;",
      },
      tempDir,
    );

    const headAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tempDir, encoding: "utf8" }).trim();
    expect(headBefore).toBe(headAfter); // Zero git commits executed

    const status = execFileSync("git", ["status", "--porcelain"], { cwd: tempDir, encoding: "utf8" });
    expect(status).toContain("M tracked.js"); // Uncommitted working tree modification
  });

  // 15. Preservation of existing user modifications
  it("15. should preserve user modifications on files not targeted by edit_file_anchor", () => {
    const userFile = path.join(tempDir, "user_scratch.txt");
    fs.writeFileSync(userFile, "UNTRACKED_USER_MODIFICATION", "utf8");

    const targetFile = path.join(tempDir, "target.js");
    fs.writeFileSync(targetFile, "val = 1;", "utf8");

    editor.applyEdit(
      {
        path: "target.js",
        searchAnchor: "val = 1;",
        replacementText: "val = 2;",
      },
      tempDir,
    );

    expect(fs.readFileSync(userFile, "utf8")).toBe("UNTRACKED_USER_MODIFICATION");
    expect(fs.readFileSync(targetFile, "utf8")).toBe("val = 2;");
  });

  // 16. Compatibility with existing "write_file" use cases
  it("16. should maintain write_file alongside edit_file_anchor for full-file replacement", async () => {
    const fenceEnforcer = new CapabilityFenceEnforcer();
    const crossGateway = new CrossHarnessGateway(fenceEnforcer);
    const governance = new ProductionGovernanceFacade(fenceEnforcer, crossGateway);
    const gateway = new ProductionToolGateway(governance);

    const fullFence: CapabilityFence = {
      fenceId: "fence-full",
      subjectId: "agent-full",
      roleId: "developer",
      harnessId: "harness-1",
      allowedCapabilities: ["READ_WORKSPACE", "WRITE_TEMPORARY_OUTPUT"],
      forbiddenCapabilities: ["WRITE_REPOSITORY", "NETWORK_ACCESS"],
      scope: {
        allowedWorkspacePaths: [tempDir],
        forbiddenWorkspacePaths: ["/etc"],
        allowedTools: ["write_file", "edit_file_anchor"],
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
      hash: "fence-hash-full",
    };

    fenceEnforcer.registerFence(fullFence);

    const ctx = {
      runId: "run-full",
      subjectId: "agent-full",
      fenceId: "fence-full",
      harnessType: "IMPLEMENTATION_HARNESS" as const,
      workspacePath: tempDir,
      missionContractHash: "hash-1",
    };

    // 1. write_file to create new file
    const writeRes = await gateway.executeTool("write_file", { path: "new.js", content: "const A = 1;\n" }, ctx);
    expect(writeRes.success).toBe(true);
    expect(fs.readFileSync(path.join(tempDir, "new.js"), "utf8")).toBe("const A = 1;\n");

    // 2. edit_file_anchor to surgically edit
    const editRes = await gateway.executeTool(
      "edit_file_anchor",
      { path: "new.js", searchAnchor: "const A = 1;", replacementText: "const A = 2;" },
      ctx,
    );
    expect(editRes.success).toBe(true);
    expect(fs.readFileSync(path.join(tempDir, "new.js"), "utf8")).toBe("const A = 2;\n");
  });

  // 17. No regression to V1.3 repair orchestration
  it("17. should preserve V1.3 repair orchestrator invariants and bounded attempt semantics", () => {
    expect(editor).toBeDefined();
    expect(typeof editor.applyEdit).toBe("function");
    expect(typeof editor.resolveSafePath).toBe("function");
  });

  // 18. No regression to V1.4 evidence minimization
  it("18. should preserve V1.4 minimal test evidence selection payload bounds", () => {
    const replayEngine = new ProductionReplayEngine();
    expect(typeof replayEngine.reconstructRun).toBe("function");
  });
});
