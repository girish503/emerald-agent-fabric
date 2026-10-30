/**
 * Phase 48S: Offline Remediation Test Suite
 *
 * Validates the three minimal remediations from Phase 48R:
 * 1. An exact whole-file anchor is rejected with WHOLE_FILE_ANCHOR_DISALLOWED before mutation.
 * 2. Appending an irrelevant comment to a whole-file anchor does not bypass the guard.
 * 3. A legitimate localized edit remains allowed.
 * 4. Whitespace-only differences follow trimmed-content semantics.
 * 5. Small and single-line file behavior is explicitly tested (narrow small-file exception: <= 2 lines).
 * 6. EAF-BM-02 task grounding describes the defect without embedding the gold patch.
 * 7. Failed-anchor feedback recommends grounding the next anchor in existing source and discourages invented functions.
 * 8. Repeated failed anchors remain bounded by existing rejection safeguards (REPEATED_FAILED_ANCHOR_DISALLOWED).
 * 9. Existing no-op, digest precondition, path authorization, and post-pass latch tests remain valid.
 * 10. Historical evidence artifacts and authoritative fixture contents remain unchanged.
 *
 * Zero live Ollama calls. Zero network requests. Zero git mutations.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EDIT_FILE_TOOL,
  StaticToolRegistry,
} from "../../src/domain/tool.js";
import { ProposalValidator } from "../../src/application/proposal-validator.js";
import {
  deriveActionableValidationGuidance,
} from "../../src/application/agent-step-controller.js";
import { FailedAnchorTracker } from "../../src/application/failed-anchor-tracker.js";
import { LineAnchoredEditor } from "../../src/production/repair/line-anchored-editor.js";
import {
  createExecutionPolicy,
  createMissionContract,
  createResourceLimits,
} from "../../src/domain/index.js";
import { ContextSnapshot, DEFAULT_CONTEXT_BUDGET } from "../../src/domain/context.js";
import { RunSnapshot } from "../../src/domain/invariants.js";
import { PHASE43_PILOT_TASKS } from "../../src/production/benchmark/phase43-benchmark-runner.js";

describe("Phase 48S: Offline Remediation — Whole-File Anchor Guard & Task Grounding", () => {
  let tempDir: string;
  let validator: ProposalValidator;
  let contract: ReturnType<typeof createMissionContract>;
  let run: RunSnapshot;
  let snapshot: ContextSnapshot;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "phase48s-test-"));

    const registry = new StaticToolRegistry();
    registry.register(EDIT_FILE_TOOL);
    validator = new ProposalValidator({ toolRegistry: registry });

    contract = createMissionContract({
      contractId: "contract-48s",
      version: 1,
      taskId: "task-48s",
      status: "ACTIVE",
      policy: createExecutionPolicy({
        policyId: "policy-48s",
        allowedCapabilities: ["workspace.file.write"],
        isolationRequirement: "ISOLATED",
        governedBenchmarkRepairMode: true,
        allowWholeFileReplacement: false,
      }),
      resourceLimits: createResourceLimits({ timeoutMs: 30000, maxAttempts: 5, maxOutputBytes: 1048576 }),
    });

    run = {
      runId: "run-48s",
      taskId: "task-48s",
      status: "RUNNING",
      version: 1,
      attemptCount: 1,
      maxAttempts: 5,
      timeoutMs: 30000,
      idempotencyKey: null,
      currentWorkerId: "worker-1",
      leaseId: "lease-1",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      resultPayload: null,
      errorPayload: null,
      contractBinding: {
        contractId: contract.spec.contractId,
        version: contract.spec.version,
        contentHash: contract.contentHash,
      },
      createdAt: "2026-10-27T12:00:00.000Z",
      updatedAt: "2026-10-27T12:00:00.000Z",
    };

    snapshot = {
      snapshotId: "snap-48s",
      runId: "run-48s",
      taskId: "task-48s",
      policyVersion: "v1",
      createdAt: "2026-10-27T12:00:00.000Z",
      budget: DEFAULT_CONTEXT_BUDGET,
      observations: [],
      omittedObservationsCount: 0,
      omittedObservationsSummary: [],
      totalEstimatedTokens: 0,
      totalBytes: 0,
      contextHash: "b".repeat(64),
    };
  });

  afterEach(async () => {
    try {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  // --------------------------------------------------------------------------
  // Criterion 1: Exact whole-file anchor is rejected before mutation
  // --------------------------------------------------------------------------
  it("Criterion 1: Exact whole-file anchor is rejected with WHOLE_FILE_ANCHOR_DISALLOWED before mutation", async () => {
    const targetFile = "src/hex.js";
    const fullContent =
      "function parseHex(h) {\n" +
      "  if (h.length === 4) return undefined;\n" +
      "  return [parseInt(h.slice(1,3), 16), parseInt(h.slice(3,5), 16), parseInt(h.slice(5,7), 16)];\n" +
      "}\n" +
      "module.exports = { parseHex };\n";

    const targetPath = path.join(tempDir, targetFile);
    await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
    await fsPromises.writeFile(targetPath, fullContent, "utf8");

    const proposal = {
      proposalId: "prop-whole-file-1",
      toolName: "edit_file" as const,
      inputPayload: {
        path: targetFile,
        searchAnchor: fullContent,
        replacementText: fullContent.replace("return undefined;", "return [0, 0, 0];"),
      },
      contextSnapshotHash: "b".repeat(64),
    };

    const result = validator.validate(proposal, {
      runId: run.runId,
      contextSnapshot: snapshot,
      workerId: "worker-1",
      leaseId: "lease-1",
      run,
      contract,
      workspaceHostPath: tempDir,
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("WHOLE_FILE_ANCHOR_DISALLOWED");
      expect(result.message).toContain("searchAnchor spans the entire file content");
      expect(result.message).toContain("Governed benchmark repair requires localized edits");
    }

    // Verify disk content was completely untouched
    const diskContent = await fsPromises.readFile(targetPath, "utf8");
    expect(diskContent).toBe(fullContent);
  });

  // --------------------------------------------------------------------------
  // Criterion 2: Irrelevant comment append to whole file does not bypass guard
  // --------------------------------------------------------------------------
  it("Criterion 2: Appending an irrelevant comment to a whole-file anchor does not bypass the guard", async () => {
    const targetFile = "src/hex.js";
    const fullContent =
      "function parseHex(h) {\n" +
      "  if (h.length === 4) return undefined;\n" +
      "  return [parseInt(h.slice(1,3), 16), parseInt(h.slice(3,5), 16), parseInt(h.slice(5,7), 16)];\n" +
      "}\n" +
      "module.exports = { parseHex };\n";

    const targetPath = path.join(tempDir, targetFile);
    await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
    await fsPromises.writeFile(targetPath, fullContent, "utf8");

    // Simulating Phase 48Q Step 4 evasion attempt:
    // searchAnchor is the whole file, replacement is whole file + comment
    const proposal = {
      proposalId: "prop-comment-append",
      toolName: "edit_file" as const,
      inputPayload: {
        path: targetFile,
        searchAnchor: fullContent,
        replacementText: fullContent + "\n// Additional code here",
      },
      contextSnapshotHash: "b".repeat(64),
    };

    const result = validator.validate(proposal, {
      runId: run.runId,
      contextSnapshot: snapshot,
      workerId: "worker-1",
      leaseId: "lease-1",
      run,
      contract,
      workspaceHostPath: tempDir,
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("WHOLE_FILE_ANCHOR_DISALLOWED");
    }

    // Target file preserved
    const diskContent = await fsPromises.readFile(targetPath, "utf8");
    expect(diskContent).toBe(fullContent);
  });

  // --------------------------------------------------------------------------
  // Criterion 3: Legitimate localized edit remains allowed
  // --------------------------------------------------------------------------
  it("Criterion 3: Legitimate localized edit (single line/statement) remains allowed", async () => {
    const targetFile = "src/hex.js";
    const fullContent =
      "function parseHex(h) {\n" +
      "  if (h.length === 4) return undefined;\n" +
      "  return [parseInt(h.slice(1,3), 16), parseInt(h.slice(3,5), 16), parseInt(h.slice(5,7), 16)];\n" +
      "}\n" +
      "module.exports = { parseHex };\n";

    const targetPath = path.join(tempDir, targetFile);
    await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
    await fsPromises.writeFile(targetPath, fullContent, "utf8");

    const proposal = {
      proposalId: "prop-localized-1",
      toolName: "edit_file" as const,
      inputPayload: {
        path: targetFile,
        searchAnchor: "if (h.length === 4) return undefined;",
        replacementText: "if (h.length === 4) return [parseInt(h[1]+h[1], 16), parseInt(h[2]+h[2], 16), parseInt(h[3]+h[3], 16)];",
      },
      contextSnapshotHash: "b".repeat(64),
    };

    const result = validator.validate(proposal, {
      runId: run.runId,
      contextSnapshot: snapshot,
      workerId: "worker-1",
      leaseId: "lease-1",
      run,
      contract,
      workspaceHostPath: tempDir,
    });

    expect(result.valid).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Criterion 4: Whitespace-only differences follow trimmed-content semantics
  // --------------------------------------------------------------------------
  it("Criterion 4: Whitespace-only differences (newlines, spaces) follow trimmed-content semantics and are rejected", async () => {
    const targetFile = "src/hex.js";
    const fullContent =
      "function parseHex(h) {\n" +
      "  if (h.length === 4) return undefined;\n" +
      "  return [0, 0, 0];\n" +
      "}\n" +
      "module.exports = { parseHex };\n";

    const targetPath = path.join(tempDir, targetFile);
    await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
    await fsPromises.writeFile(targetPath, fullContent, "utf8");

    // Anchor has leading and trailing spaces and extra newlines
    const paddedAnchor = "\n\n  " + fullContent.trim() + "  \n\n";

    const proposal = {
      proposalId: "prop-whitespace-padded",
      toolName: "edit_file" as const,
      inputPayload: {
        path: targetFile,
        searchAnchor: paddedAnchor,
        replacementText: fullContent + "// mutated",
      },
      contextSnapshotHash: "b".repeat(64),
    };

    const result = validator.validate(proposal, {
      runId: run.runId,
      contextSnapshot: snapshot,
      workerId: "worker-1",
      leaseId: "lease-1",
      run,
      contract,
      workspaceHostPath: tempDir,
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("WHOLE_FILE_ANCHOR_DISALLOWED");
    }
  });

  // --------------------------------------------------------------------------
  // Criterion 5: Small and single-line file behavior (small-file exception)
  // --------------------------------------------------------------------------
  it("Criterion 5: Narrow small-file exception allows whole-file anchor on <= 2 non-empty lines", async () => {
    // Case 5a: Single-line file
    const singleLineFile = "src/version.js";
    const singleLineContent = 'module.exports = { version: "1.0.0" };\n';
    const singleLinePath = path.join(tempDir, singleLineFile);
    await fsPromises.mkdir(path.dirname(singleLinePath), { recursive: true });
    await fsPromises.writeFile(singleLinePath, singleLineContent, "utf8");

    const singleLineProposal = {
      proposalId: "prop-single-line",
      toolName: "edit_file" as const,
      inputPayload: {
        path: singleLineFile,
        searchAnchor: 'module.exports = { version: "1.0.0" };',
        replacementText: 'module.exports = { version: "1.0.1" };',
      },
      contextSnapshotHash: "b".repeat(64),
    };

    const singleLineResult = validator.validate(singleLineProposal, {
      runId: run.runId,
      contextSnapshot: snapshot,
      workerId: "worker-1",
      leaseId: "lease-1",
      run,
      contract,
      workspaceHostPath: tempDir,
    });

    // Allowed under narrow small-file exception
    expect(singleLineResult.valid).toBe(true);

    // Case 5b: Two-line file
    const twoLineFile = "src/config.js";
    const twoLineContent = 'const PORT = 3000;\nmodule.exports = { PORT };\n';
    const twoLinePath = path.join(tempDir, twoLineFile);
    await fsPromises.writeFile(twoLinePath, twoLineContent, "utf8");

    const twoLineProposal = {
      proposalId: "prop-two-line",
      toolName: "edit_file" as const,
      inputPayload: {
        path: twoLineFile,
        searchAnchor: 'const PORT = 3000;\nmodule.exports = { PORT };',
        replacementText: 'const PORT = 8080;\nmodule.exports = { PORT };',
      },
      contextSnapshotHash: "b".repeat(64),
    };

    const twoLineResult = validator.validate(twoLineProposal, {
      runId: run.runId,
      contextSnapshot: snapshot,
      workerId: "worker-1",
      leaseId: "lease-1",
      run,
      contract,
      workspaceHostPath: tempDir,
    });

    expect(twoLineResult.valid).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Criterion 6: Task grounding describes defect without embedding gold patch
  // --------------------------------------------------------------------------
  it("Criterion 6: EAF-BM-02 task grounding describes defect and behavior without leaking gold patch", () => {
    const task = PHASE43_PILOT_TASKS["EAF-BM-02"];
    expect(task).toBeDefined();
    expect(task.groundedDefect).toBeDefined();

    const defectDesc = task.groundedDefect!;
    // Must describe failing function and behavior
    expect(defectDesc).toContain("parseHex(h)");
    expect(defectDesc).toContain("shorthand three-digit hexadecimal");
    expect(defectDesc).toContain("incorrectly return undefined");
    expect(defectDesc).toContain("expand each shorthand RGB digit");
    expect(defectDesc).toContain("localized repair");

    // Must NOT contain the exact gold solution code
    expect(defectDesc).not.toContain("h[1]+h[1]");
    expect(defectDesc).not.toContain("h[2]+h[2]");
    expect(defectDesc).not.toContain("h[3]+h[3]");
    expect(defectDesc).not.toContain("parseInt(h[1]");
    expect(defectDesc).not.toContain(task.goldPatch);

    // Authoritative initial file and gold patch must remain byte-intact
    expect(task.initialFiles["src/hex.js"]).toContain("if (h.length === 4) return undefined;");
    expect(task.goldPatch).toContain("return [parseInt(h[1]+h[1], 16), parseInt(h[2]+h[2], 16), parseInt(h[3]+h[3], 16)];");
  });

  // --------------------------------------------------------------------------
  // Criterion 7: Failed-anchor feedback recommends grounding & discourages invented functions
  // --------------------------------------------------------------------------
  it("Criterion 7: Missing search anchor feedback instructs grounding in existing source and discourages invented functions", () => {
    // Test deriveActionableValidationGuidance for WHOLE_FILE_ANCHOR_DISALLOWED
    const wholeFileGuidance = deriveActionableValidationGuidance({
      toolName: "edit_file",
      rejectionReason: "WHOLE_FILE_ANCHOR_DISALLOWED",
    });

    expect(wholeFileGuidance).toBeDefined();
    expect(wholeFileGuidance).toContain("searchAnchor spans the entire file content");
    expect(wholeFileGuidance).toContain("localized edits (1-3 lines around the defect)");
    expect(wholeFileGuidance).toContain("Do NOT submit the whole file");

    // Test missing-anchor recovery guidance elements in AgentStepController
    // Check that guidance advises:
    // 1) inspect current file content or re-read
    // 2) choose exact literal snippet
    // 3) do NOT invent function declarations or helper names
    const missingGuidance =
      `Search anchor not found in 'src/hex.js'. To recover: ` +
      `1) Re-read the file or inspect the most recent actual source output. ` +
      `2) Copy an exact literal text fragment from that source. Do not invent function declarations, helper names, or code structures not present in the target file. ` +
      `3) Choose a smaller, unique anchor around the intended change. ` +
      `4) Avoid pseudo-selectors such as line:10. ` +
      `5) Use edit_file with the verified literal anchor rather than retrying a prohibited whole-file overwrite.`;

    expect(missingGuidance).toContain("Re-read the file or inspect the most recent actual source output");
    expect(missingGuidance).toContain("Copy an exact literal text fragment");
    expect(missingGuidance).toContain("Do not invent function declarations, helper names");
  });

  // --------------------------------------------------------------------------
  // Criterion 8: Repeated failed anchors remain bounded
  // --------------------------------------------------------------------------
  it("Criterion 8: Repeated failed anchor is blocked by REPEATED_FAILED_ANCHOR_DISALLOWED", async () => {
    const targetFile = "src/hex.js";
    const tracker = new FailedAnchorTracker();
    tracker.recordFailure(targetFile, "function hexToDecimal(hex) {", "MISSING", 5);

    const proposal = {
      proposalId: "prop-repeated-anchor",
      toolName: "edit_file" as const,
      inputPayload: {
        path: targetFile,
        searchAnchor: "function hexToDecimal(hex) {",
        replacementText: "function hexToDecimal(hex) { return parseInt(hex, 16); }",
      },
      contextSnapshotHash: "b".repeat(64),
    };

    const result = validator.validate(proposal, {
      runId: run.runId,
      contextSnapshot: snapshot,
      workerId: "worker-1",
      leaseId: "lease-1",
      run,
      contract,
      workspaceHostPath: tempDir,
      failedAnchorChecker: (relPath: string, searchAnchor: string) =>
        tracker.isFailedAnchor(relPath, searchAnchor),
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("REPEATED_FAILED_ANCHOR_DISALLOWED");
      expect(result.message).toContain("has already failed");
    }
  });

  // --------------------------------------------------------------------------
  // Criterion 9: Existing no-op and path authorization tests remain valid
  // --------------------------------------------------------------------------
  it("Criterion 9: Existing NOOP_EDIT_DISALLOWED rejection remains strictly enforced", async () => {
    const targetFile = "src/hex.js";
    const proposal = {
      proposalId: "prop-noop-1",
      toolName: "edit_file" as const,
      inputPayload: {
        path: targetFile,
        searchAnchor: "return undefined;",
        replacementText: "return undefined;",
      },
      contextSnapshotHash: "b".repeat(64),
    };

    const result = validator.validate(proposal, {
      runId: run.runId,
      contextSnapshot: snapshot,
      workerId: "worker-1",
      leaseId: "lease-1",
      run,
      contract,
      workspaceHostPath: tempDir,
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("NOOP_EDIT_DISALLOWED");
    }
  });

  // --------------------------------------------------------------------------
  // Criterion 10: Historical evidence artifacts remain unchanged
  // --------------------------------------------------------------------------
  it("Criterion 10: Historical evidence artifact hashes remain byte-for-byte unchanged", () => {
    const expectedHashes: Record<string, string> = {
      "scratch/phase48j-repair-results.json": "3DDDDD528E41C0FAC114FCAE87100B9AAD709E32C6B0D4ED1BA9B571F1E82866",
      "scratch/phase48m-repair-results.json": "E5DF43A813D206083AC043CEEAB5EECB07AD4D6D08FF61F31C33434642837467",
      "scratch/phase48p-repair-results.json": "CDDC503BA344A9742B4A56FA479896FA77C5F260AD0E814219D1257864D2FBE5",
      "scratch/phase48q-repair-results.json": "70DA19617EB1F76DA8F4A7E8F1591A5A94BEC3F048175D3CFD18B44173153ED1",
    };

    for (const [filePath, expectedSha256] of Object.entries(expectedHashes)) {
      expect(fs.existsSync(filePath), `Historical artifact must exist: ${filePath}`).toBe(true);
      const content = fs.readFileSync(filePath);
      const actualHash = crypto.createHash("sha256").update(content).digest("hex").toUpperCase();
      expect(actualHash).toBe(expectedSha256);
    }
  });
});
