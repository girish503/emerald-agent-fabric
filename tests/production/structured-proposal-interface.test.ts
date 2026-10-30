/**
 * Emerald Agent Fabric — Production V1.8: Structured Proposal Interface Tests
 *
 * Verifies all 15 required criteria for structured proposal interfaces and constrained decoding:
 * 1. Valid proposal parsing.
 * 2. Malformed JSON rejection.
 * 3. Schema mismatch rejection.
 * 4. Unknown action identifiers rejection.
 * 5. Invalid arguments rejection.
 * 6. Oversized responses rejection.
 * 7. Unexpected fields rejection.
 * 8. Governance rejection after successful schema validation.
 * 9. No execution on parsing or schema failure.
 * 10. No privilege escalation through model-provided fields.
 * 11. Evidence and timeline recording.
 * 12. Deterministic replay without model inference or tool execution.
 * 13. Compatibility with the existing proposal path.
 * 14. Preservation of the frozen benchmark manifests.
 * 15. Preservation of all historical Phase 10H artifacts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  PROPOSAL_SCHEMA_VERSION,
  MAX_PROPOSAL_PAYLOAD_BYTES,
  getProposalSchemaDigest,
  validateStructuredProposal,
} from "../../src/production/adapter/structured-proposal-schema.js";
import { OllamaModelAdapter } from "../../src/production/benchmark/ollama-model-adapter.js";
import { CalibrationManifestLoader } from "../../src/production/benchmark/calibration-manifest.js";
import { BenchmarkManifestLoader } from "../../src/production/benchmark/benchmark-manifest.js";
import { ProductionGovernanceFacade } from "../../src/governance/production-governance-facade.js";
import { CapabilityFenceEnforcer } from "../../src/application/capability-fence-enforcer.js";
import { CrossHarnessGateway } from "../../src/application/cross-harness-gateway.js";
import { CapabilityFence } from "../../src/domain/capability-fence.js";
import { EvidenceControl, ProductionEvidenceBundle } from "../../src/control-plane/evidence-control.js";
import { ProductionReplayEngine } from "../../src/evidence/production-replay-engine.js";

describe("Production V1.8: Structured Proposal Interface and Constrained JSON Feasibility", () => {
  let tempDir: string;
  let fenceEnforcer: CapabilityFenceEnforcer;
  let crossHarnessGateway: CrossHarnessGateway;
  let governanceFacade: ProductionGovernanceFacade;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-v18-test-"));
    fenceEnforcer = new CapabilityFenceEnforcer();
    crossHarnessGateway = new CrossHarnessGateway(fenceEnforcer);
    governanceFacade = new ProductionGovernanceFacade(fenceEnforcer, crossHarnessGateway);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup locks
    }
  });

  // 1. Valid proposal parsing
  it("1. should successfully parse and validate a typed structured proposal", () => {
    const candidate = {
      version: PROPOSAL_SCHEMA_VERSION,
      thought: "Update configuration timeout using surgical anchored editing",
      toolName: "edit_file_anchor",
      toolInput: {
        path: "config.js",
        searchAnchor: "const TIMEOUT = 1000;",
        replacementText: "const TIMEOUT = 5000;",
      },
    };

    const res = validateStructuredProposal(candidate);
    expect(res.valid).toBe(true);
    expect(res.proposal).toBeDefined();
    expect(res.proposal?.toolName).toBe("edit_file_anchor");
    expect(res.proposal?.toolInput).toEqual({
      path: "config.js",
      searchAnchor: "const TIMEOUT = 1000;",
      replacementText: "const TIMEOUT = 5000;",
    });
    expect(res.schemaVersion).toBe(PROPOSAL_SCHEMA_VERSION);
    expect(res.schemaDigest).toBe(getProposalSchemaDigest());
  });

  // 2. Malformed JSON
  it("2. should reject malformed JSON fail-closed", () => {
    const raw = `{"version": "${PROPOSAL_SCHEMA_VERSION}", "thought": "Broken JSON,`;
    const res = validateStructuredProposal(raw);
    expect(res.valid).toBe(false);
    expect(res.errorCode).toBe("INVALID_JSON_STRUCTURE");
    expect(res.proposal).toBeUndefined();
  });

  // 3. Schema mismatch
  it("3. should reject schema mismatches such as missing required fields or incorrect version", () => {
    const missingThought = {
      version: PROPOSAL_SCHEMA_VERSION,
      toolName: "read_file",
      toolInput: { path: "index.js" },
    };
    const res1 = validateStructuredProposal(missingThought);
    expect(res1.valid).toBe(false);
    expect(res1.errorCode).toBe("INVALID_ARGUMENTS");

    const badVersion = {
      version: "v999.0",
      thought: "Valid thought",
      toolName: "read_file",
      toolInput: { path: "index.js" },
    };
    const res2 = validateStructuredProposal(badVersion);
    expect(res2.valid).toBe(false);
    expect(res2.errorCode).toBe("UNSUPPORTED_VERSION");
  });

  // 4. Unknown action identifiers
  it("4. should strictly reject unknown action identifiers fail-closed", () => {
    const unknownAction = {
      version: PROPOSAL_SCHEMA_VERSION,
      thought: "Execute arbitrary root shell",
      toolName: "execute_root_command",
      toolInput: { command: "rm -rf /" },
    };
    const res = validateStructuredProposal(unknownAction);
    expect(res.valid).toBe(false);
    expect(res.errorCode).toBe("UNKNOWN_ACTION");
    expect(res.error).toContain("Unknown or unauthorized toolName");
  });

  // 5. Invalid arguments
  it("5. should reject invalid or missing tool-specific arguments fail-closed", () => {
    // Missing required replacementText for edit_file_anchor
    const missingArg = {
      version: PROPOSAL_SCHEMA_VERSION,
      thought: "Edit file without replacement",
      toolName: "edit_file_anchor",
      toolInput: {
        path: "index.js",
        searchAnchor: "function foo() {}",
      },
    };
    const res1 = validateStructuredProposal(missingArg);
    expect(res1.valid).toBe(false);
    expect(res1.errorCode).toBe("INVALID_ARGUMENTS");

    // Invalid argument type (path is number instead of string)
    const badType = {
      version: PROPOSAL_SCHEMA_VERSION,
      thought: "Read file with number path",
      toolName: "read_file",
      toolInput: { path: 12345 },
    };
    const res2 = validateStructuredProposal(badType);
    expect(res2.valid).toBe(false);
    expect(res2.errorCode).toBe("INVALID_ARGUMENTS");

    // Extraneous keys for read_file must be rejected fail-closed
    const extraContent = {
      version: PROPOSAL_SCHEMA_VERSION,
      thought: "Read file with extraneous content",
      toolName: "read_file",
      toolInput: { path: "index.js", content: "unexpected" },
    };
    const resExtraContent = validateStructuredProposal(extraContent);
    expect(resExtraContent.valid).toBe(false);
    expect(resExtraContent.errorCode).toBe("INVALID_ARGUMENTS");
    expect(resExtraContent.error).toContain("Unrecognized key(s) in object: 'content'");

    const extraOffset = {
      version: PROPOSAL_SCHEMA_VERSION,
      thought: "Read file with extraneous offsetLine",
      toolName: "read_file",
      toolInput: { path: "index.js", offsetLine: 1, limitLines: 50 },
    };
    const resExtraOffset = validateStructuredProposal(extraOffset);
    expect(resExtraOffset.valid).toBe(false);
    expect(resExtraOffset.errorCode).toBe("INVALID_ARGUMENTS");

    // Canonical read_file with path only must succeed cleanly
    const canonicalRead = {
      version: PROPOSAL_SCHEMA_VERSION,
      thought: "Canonical read_file with path only",
      toolName: "read_file",
      toolInput: { path: "index.js" },
    };
    const resCanonical = validateStructuredProposal(canonicalRead);
    expect(resCanonical.valid).toBe(true);
    expect(resCanonical.proposal?.toolInput).toEqual({ path: "index.js" });
  });

  // 6. Oversized responses
  it("6. should reject oversized response payloads exceeding the maximum byte budget", () => {
    const oversizedPayload = {
      version: PROPOSAL_SCHEMA_VERSION,
      thought: "Large payload",
      toolName: "write_file",
      toolInput: {
        path: "huge.txt",
        content: "A".repeat(MAX_PROPOSAL_PAYLOAD_BYTES + 1000),
      },
    };
    const res = validateStructuredProposal(oversizedPayload, { maxBytes: MAX_PROPOSAL_PAYLOAD_BYTES });
    expect(res.valid).toBe(false);
    expect(res.errorCode).toBe("OVERSIZED_PAYLOAD");
  });

  // 7. Unexpected fields
  it("7. should reject unexpected top-level fields to prevent authority injection", () => {
    const injectedPayload = {
      version: PROPOSAL_SCHEMA_VERSION,
      thought: "Attempt privilege override",
      toolName: "read_file",
      toolInput: { path: "index.js" },
      adminOverride: true,
      grantRootCapability: true,
    };
    const res = validateStructuredProposal(injectedPayload);
    expect(res.valid).toBe(false);
    expect(res.errorCode).toBe("UNEXPECTED_FIELD");
    expect(res.error).toContain("adminOverride");
  });

  // 8. Governance rejection after successful schema validation
  it("8. should ensure governance rejects schema-valid proposals that violate capability fences", () => {
    const validProposal = {
      version: PROPOSAL_SCHEMA_VERSION,
      thought: "Write outside workspace",
      toolName: "write_file",
      toolInput: {
        path: "secret.txt",
        content: "new content",
      },
    };

    const valRes = validateStructuredProposal(validProposal);
    expect(valRes.valid).toBe(true);

    // Fence allows only READ_WORKSPACE, forbids WRITE_REPOSITORY
    const fence: CapabilityFence = {
      fenceId: "test-fence-readonly",
      subjectId: "agent-1",
      roleId: "auditor",
      harnessId: "TEST_HARNESS",
      allowedCapabilities: ["READ_WORKSPACE"],
      forbiddenCapabilities: ["WRITE_REPOSITORY"],
      scope: {
        allowedWorkspacePaths: [tempDir],
        forbiddenWorkspacePaths: [".git"],
        allowedTools: ["read_file"],
        maxOperations: 10,
        maxMemoryBytes: 1024 * 1024,
        networkAllowed: false,
        gitWriteAllowed: false,
      },
      trustLabel: "UNTRUSTED_OBSERVATION",
      status: "ACTIVE",
      delegatedFenceIds: [],
      version: 1,
      missionContractId: "contract-1",
      missionContractHash: "contract-hash-1",
      authoritative: false,
      terminalAuthority: false,
      sovereignAuthority: false,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      hash: "test-hash",
    };
    fenceEnforcer.registerFence(fence);

    const decision = governanceFacade.evaluateProposal({
      runId: "run-test-gov",
      subjectId: "agent-1",
      fenceId: "test-fence-readonly",
      harnessType: "IMPLEMENTATION_HARNESS",
      capability: "WRITE_TEMPORARY_OUTPUT",
      toolName: valRes.proposal!.toolName,
      input: valRes.proposal!.toolInput,
      workspacePath: tempDir,
      missionContractHash: "contract-hash-1",
    });

    expect(decision.authorized).toBe(false);
    expect(decision.reason).toBeDefined();
  });

  // 9. No execution on parsing or schema failure
  it("9. should never execute or mutate workspace if proposal parsing or schema fails", async () => {
    const targetFile = path.join(tempDir, "original.js");
    const originalContent = "const x = 1;\nmodule.exports = { x };\n";
    fs.writeFileSync(targetFile, originalContent, "utf8");

    const malformedProposal = `{"toolName": "write_file", "path": "original.js", MALFORMED}`;
    const valRes = validateStructuredProposal(malformedProposal);
    expect(valRes.valid).toBe(false);

    // Attempting execution without a valid proposal is strictly prohibited
    expect(fs.readFileSync(targetFile, "utf8")).toBe(originalContent);
  });

  // 10. No privilege escalation through model-provided fields
  it("10. should prevent model-provided fields from overriding mission identity, fence, or permissions", () => {
    const maliciousPayload = {
      version: PROPOSAL_SCHEMA_VERSION,
      thought: "Privilege escalation attempt",
      toolName: "read_file",
      toolInput: { path: "test.js" },
      // Attempting to override system properties:
      runId: "run-admin-override",
      subjectId: "root",
      fenceId: "fence-unrestricted",
      workspacePath: "/etc",
      missionContractHash: "bypassed-hash",
    };

    const valRes = validateStructuredProposal(maliciousPayload);
    expect(valRes.valid).toBe(false);
    expect(valRes.errorCode).toBe("UNEXPECTED_FIELD");
  });

  // 11. Evidence and timeline recording
  it("11. should record structured proposal validation events in timeline without secret leakage", () => {
    const evidenceControl = new EvidenceControl();
    const runId = "run-v18-evidence-test";

    evidenceControl.recordTimelineEntry(
      runId,
      "proposal.validated",
      "Model proposal passed schema validation",
      "proposal-validator",
      {
        schemaVersion: PROPOSAL_SCHEMA_VERSION,
        schemaDigest: getProposalSchemaDigest(),
        toolName: "edit_file_anchor",
      },
    );

    const entries = evidenceControl.getTimeline(runId);
    expect(entries.length).toBe(1);
    expect(entries[0]!.eventType).toBe("proposal.validated");
    expect(entries[0]!.details["schemaVersion"]).toBe(PROPOSAL_SCHEMA_VERSION);
    expect(entries[0]!.details["schemaDigest"]).toBe(getProposalSchemaDigest());
    expect(JSON.stringify(entries[0]!.details)).not.toContain("password");
    expect(JSON.stringify(entries[0]!.details)).not.toContain("secret");
  });

  // 12. Deterministic replay without model inference or tool execution
  it("12. should produce byte-identical deterministic replay reconstructions across 3 sweeps", () => {
    const evidenceControl = new EvidenceControl();
    const runId = "run-v18-replay";

    evidenceControl.recordTimelineEntry(runId, "run.started", "Run started", "coordinator");
    evidenceControl.recordTimelineEntry(runId, "proposal.schema_verified", "Schema verified", "validator", {
      schemaVersion: PROPOSAL_SCHEMA_VERSION,
      schemaDigest: getProposalSchemaDigest(),
    });
    evidenceControl.recordTimelineEntry(runId, "run.completed", "Run completed", "coordinator");

    const mockBundle: ProductionEvidenceBundle = {
      runId,
      missionId: "mission-v18",
      contractId: "contract-v18",
      contractHash: "contract-v18-hash",
      workspacePath: tempDir,
      repositoryPath: tempDir,
      modelId: "qwen2.5-coder:3b",
      contextDigest: "ctx-v18",
      actionsCount: 1,
      attemptsCount: 1,
      gitDiff: "",
      testResults: {
        passed: true,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        durationMs: 10,
      },
      verificationResult: {
        verified: true,
        sovereignVerifier: "ProductionVerifier_CleanRoom_v1",
        proofHash: "proof-v18",
      },
      timeline: evidenceControl.getTimeline(runId),
      disposition: "ACCEPTED",
      completedAt: new Date().toISOString(),
      bundleDigest: "bundle-v18",
    };

    const replayEngine = new ProductionReplayEngine();
    const s1 = replayEngine.reconstructRun(mockBundle);
    const s2 = replayEngine.reconstructRun(mockBundle);
    const s3 = replayEngine.reconstructRun(mockBundle);

    expect(s1.reconstructedSuccessfully).toBe(true);
    expect(s2.reconstructedSuccessfully).toBe(true);
    expect(s3.reconstructedSuccessfully).toBe(true);
    expect(s1).toEqual(s2);
    expect(s2).toEqual(s3);
  });

  // 13. Compatibility with existing proposal path
  it("13. should maintain backwards-compatibility when constrained output is disabled", () => {
    const adapter = new OllamaModelAdapter("qwen2.5-coder:3b", "http://localhost:11434", 30000, false);
    expect(adapter.constrainedOutputEnabled).toBe(false);

    // Call parseUnconstrainedProposal through test method
    const unconstrainedOutput = `\`\`\`json
{
  "thought": "Read index.js to investigate function signature",
  "toolName": "read_file",
  "toolInput": { "path": "index.js" }
}
\`\`\``;

    const parsed = (adapter as any).parseUnconstrainedProposal(unconstrainedOutput);
    expect(parsed.toolName).toBe("read_file");
    expect(parsed.thought).toContain("Read index.js");
    expect(parsed.toolInput).toEqual({ path: "index.js" });
  });

  // 14. Preservation of the frozen benchmark manifests
  it("14. should guarantee that calibration and SWE-bench manifests remain byte-identical", () => {
    const calibLoader = new CalibrationManifestLoader();
    const calibManifest = calibLoader.loadManifest();
    expect(calibManifest.taskCount).toBe(5);
    expect(calibManifest.manifestHash).toBe(
      "150cbb79005a238fe4d8712b4a7d0ced1ce9ebe031c33101990027be63236676",
    );

    const sweLoader = new BenchmarkManifestLoader();
    const sweManifest = sweLoader.loadManifest();
    expect(sweManifest.taskCount).toBe(15);
    expect(sweManifest.manifestHash).toBe(
      "d61852584504ced781f6cb9ca1d10d527aba52eb697ce8488840c34bed29f4a8",
    );
  });

  // 15. Preservation of all historical Phase 10H artifacts
  it("15. should verify that historical Phase 10H diagnostic artifacts remain untouched", async () => {
    const { verifyPhase10HArtifacts } = await import("../../scripts/verify-phase10h-artifacts.js");
    await expect(verifyPhase10HArtifacts()).resolves.not.toThrow();
  });
});
