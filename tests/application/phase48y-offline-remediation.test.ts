/**
 * Phase 48Y: Offline Remediation & Model-Facing Schema Hardening Test Suite
 *
 * Verifies all requirements for Phase 48Y:
 * Workstream A: Model-Facing Digest Redaction
 *   - Internal file digests (originalDigest, resultingDigest, contentHash) are omitted from model-facing TOOL_RESULT text.
 *   - Useful operational feedback (path, occurrences, replacedCount, applied, bytesRead) is preserved.
 *   - Arbitrary source code content is not redacted merely because it resembles hex.
 *   - Complete digests remain preserved in internal persistence, state store, and evidence bundles.
 *
 * Workstream B: Tool Schema Alignment with Governance
 *   - In benchmark repair mode, write_file schema omits overwrite property.
 *   - Model-facing tool catalog omits overwrite parameter and warns against overwriting existing files.
 *   - New target file creation is permitted under benchmark repair policy.
 *   - Existing target file overwrite attempts are rejected by ProposalValidator with DISALLOWED_FILE_OVERWRITE.
 *   - In general-purpose mode (or allowWholeFileReplacement: true), overwrite is advertised and permitted.
 *
 * Workstream C: Verification Feedback Recency & Observation Ordering
 *   - In benchmark repair mode, VERIFICATION observations are placed at the end of the context observations,
 *     immediately preceding ## Required Action.
 *   - Tool results and workspace state precede verification feedback, eliminating recency displacement.
 *   - Task grounding (RUN_STATE, MISSION_CONTEXT) remains at the front of context observations.
 *   - In general-purpose mode, default display order is preserved.
 *
 * Strictly offline. Zero live Ollama inference. Zero network calls. Zero git mutations.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { ProposalValidator } from "../../src/application/proposal-validator.js";
import { SystemClock } from "../../src/ports/clock.port.js";
import { ModelProviderPort } from "../../src/ports/model-provider.port.js";
import { ModelProviderRequest, ModelProviderResponse } from "../../src/domain/model-provider.js";
import {
  LiveAgentBrain,
  deriveActionProposalSchema,
  projectModelFacingObservationContent,
  INTERNAL_DIGEST_FIELDS,
  GOVERNED_REPAIR_OBSERVATION_DISPLAY_ORDER,
} from "../../src/application/live-agent-brain.js";
import {
  formatModelFacingToolCatalog,
  projectToolDefinition,
  inspectToolProjection,
} from "../../src/domain/tool-projection.js";
import {
  INITIAL_TOOL_DEFINITIONS,
  WRITE_FILE_TOOL,
  READ_FILE_TOOL,
  staticToolRegistry,
  defaultGovernedToolRegistry,
} from "../../src/domain/tool.js";
import {
  createExecutionPolicy,
  createMissionContract,
  createResourceLimits,
} from "../../src/domain/index.js";
import {
  ContextSnapshot,
  DEFAULT_CONTEXT_BUDGET,
  Observation,
  computeContextHash,
} from "../../src/domain/context.js";
import { createAndActivateContract } from "./test-helpers.js";

// ============================================================================
// Test Doubles
// ============================================================================

class StubModelProvider implements ModelProviderPort {
  readonly providerName = "stub-provider";
  readonly calls: ModelProviderRequest[] = [];

  async generate(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    this.calls.push(request);
    return {
      requestId: request.requestId,
      model: request.model,
      outputText: JSON.stringify({
        isGoalReached: false,
        proposalId: "prop-test-1",
        toolName: "read_file",
        inputPayload: { path: "src/hex.js", offsetLine: 1, limitLines: 50 },
        contextSnapshotHash: "a".repeat(64),
      }),
      finishReason: "STOP",
      durationMs: 10,
    };
  }
}

describe("Phase 48Y: Offline Remediation & Model-Facing Schema Hardening", () => {
  let tempDir: string;
  let store: SqliteStateStore;
  let clock: SystemClock;
  let coordinator: RunCoordinator;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  const workerId = "worker-phase48y-1";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eaf-phase48y-test-"));
    store = new SqliteStateStore();
    clock = new SystemClock();
    coordinator = new RunCoordinator(store, clock);
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: tempDir });

    store.transaction((tx) => {
      tx.insertWorker({
        workerId,
        hostname: "localhost",
        pid: process.pid,
        status: "ACTIVE",
        createdAt: clock.nowIso(),
        lastHeartbeatAt: clock.nowIso(),
      });
    });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // Workstream A: Model-Facing Digest Redaction
  // ==========================================================================
  describe("Workstream A: Model-Facing Digest Redaction", () => {
    it("1. structured projection omits originalDigest and resultingDigest from edit_file TOOL_RESULT", () => {
      const rawContent: Record<string, unknown> = {
        actionId: "act-edit-1",
        attemptId: "att-edit-1",
        exitCode: 0,
        output: {
          path: "src/hex.js",
          originalDigest: "57d5818676a6972c4884fe42cea6dd177b968b26ad919e403a5182b273096b06",
          resultingDigest: "08594fba8b71871a95b0e4373163a89ffdae4e2f9173d49bfb0ed111590d0914",
          occurrences: 1,
          replacedCount: 1,
          applied: true,
        },
        toolName: "edit_file",
      };

      const projected = projectModelFacingObservationContent("TOOL_RESULT", rawContent);
      const projectedOutput = projected["output"] as Record<string, unknown>;

      expect(projectedOutput["originalDigest"]).toBeUndefined();
      expect(projectedOutput["resultingDigest"]).toBeUndefined();
      expect(projectedOutput["path"]).toBe("src/hex.js");
      expect(projectedOutput["occurrences"]).toBe(1);
      expect(projectedOutput["replacedCount"]).toBe(1);
      expect(projectedOutput["applied"]).toBe(true);

      // Verify raw content was not mutated
      expect((rawContent.output as any).originalDigest).toBeDefined();
    });

    it("2. structured projection omits contentHash from read_file and write_file TOOL_RESULT while preserving code and operational counts", () => {
      const readFileContent: Record<string, unknown> = {
        actionId: "act-read-1",
        attemptId: "att-read-1",
        exitCode: 0,
        output: {
          path: "src/hex.js",
          content: 'function parseHex(h) {\n  if (h === "#fff") return [255, 255, 255];\n}\n',
          bytesRead: 65,
          totalLines: 4,
          isTruncated: false,
          contentHash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        },
        toolName: "read_file",
      };

      const projectedRead = projectModelFacingObservationContent("TOOL_RESULT", readFileContent);
      const readOutput = projectedRead["output"] as Record<string, unknown>;

      expect(readOutput["contentHash"]).toBeUndefined();
      expect(readOutput["path"]).toBe("src/hex.js");
      expect(readOutput["bytesRead"]).toBe(65);
      expect(readOutput["content"]).toContain('#fff');

      const writeFileContent: Record<string, unknown> = {
        actionId: "act-write-1",
        attemptId: "att-write-1",
        exitCode: 0,
        output: {
          path: "src/new-file.js",
          bytesWritten: 120,
          created: true,
          contentHash: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        },
        toolName: "write_file",
      };

      const projectedWrite = projectModelFacingObservationContent("TOOL_RESULT", writeFileContent);
      const writeOutput = projectedWrite["output"] as Record<string, unknown>;

      expect(writeOutput["contentHash"]).toBeUndefined();
      expect(writeOutput["path"]).toBe("src/new-file.js");
      expect(writeOutput["bytesWritten"]).toBe(120);
      expect(writeOutput["created"]).toBe(true);
    });

    it("3. does not redact arbitrary source code containing hexadecimal literals or identifiers", () => {
      const sourceWithHex = 'const COLOR = "#ffffff"; const mask = 0xabcdef; const hashPattern = /^[a-f0-9]{64}$/;';
      const readContent: Record<string, unknown> = {
        actionId: "act-read-2",
        attemptId: "att-read-2",
        exitCode: 0,
        output: {
          path: "src/colors.js",
          content: sourceWithHex,
          bytesRead: sourceWithHex.length,
          isTruncated: false,
          contentHash: "deadbeef".repeat(8),
        },
        toolName: "read_file",
      };

      const projected = projectModelFacingObservationContent("TOOL_RESULT", readContent);
      const readOutput = projected["output"] as Record<string, unknown>;

      expect(readOutput["content"]).toBe(sourceWithHex);
      expect(readOutput["contentHash"]).toBeUndefined();
    });

    it("4. internal digests remain preserved in StateStore attempt records and evidence bundles while excluded from LiveAgentBrain prompt", async () => {
      const provider = new StubModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model",
      });

      const originalDigest = "57d5818676a6972c4884fe42cea6dd177b968b26ad919e403a5182b273096b06";
      const resultingDigest = "08594fba8b71871a95b0e4373163a89ffdae4e2f9173d49bfb0ed111590d0914";

      const toolResultObs: Observation = {
        observationId: "obs-result-step-3",
        category: "TOOL_RESULT",
        provenance: {
          entityKind: "Attempt",
          entityId: "att-edit-step-3",
          runId: "run-test-1",
          sequenceNumber: 3,
          timestamp: "2026-10-28T10:00:00.000Z",
          isAuthoritativeRuntimeFact: true,
        },
        priority: 70,
        freshness: "CURRENT",
        content: {
          actionId: "act-edit-step-3",
          attemptId: "att-edit-step-3",
          exitCode: 0,
          output: {
            path: "src/hex.js",
            originalDigest,
            resultingDigest,
            occurrences: 1,
            replacedCount: 1,
            applied: true,
          },
          toolName: "edit_file",
        },
        contentHash: "hash-obs-3",
        estimatedBytes: 250,
        estimatedTokens: 60,
        isMandatory: false,
      };

      const missionObs: Observation = {
        observationId: "obs-mission-1",
        category: "MISSION_CONTEXT",
        provenance: {
          entityKind: "MissionContract",
          entityId: "contract-1",
          runId: "run-test-1",
          timestamp: "2026-10-28T09:59:00.000Z",
          isAuthoritativeRuntimeFact: true,
        },
        priority: 90,
        freshness: "CURRENT",
        content: {
          contractId: "contract-1",
          policy: {
            governedBenchmarkRepairMode: true,
            allowWholeFileReplacement: false,
          },
          taskDetails: {
            title: "Shorthand Hexadecimal Parsing Fix",
            description: "Fix shorthand hex parsing",
          },
        },
        contentHash: "hash-mission-1",
        estimatedBytes: 200,
        estimatedTokens: 50,
        isMandatory: true,
      };

      const snapshot: ContextSnapshot = {
        snapshotId: "ctx-test-1",
        runId: "run-test-1",
        taskId: "task-test-1",
        policyVersion: "v1",
        createdAt: "2026-10-28T10:00:01.000Z",
        budget: DEFAULT_CONTEXT_BUDGET,
        observations: [missionObs, toolResultObs],
        omittedObservationsCount: 0,
        omittedObservationsSummary: [],
        totalEstimatedTokens: 110,
        totalBytes: 450,
        contextHash: "hash-context-1",
      };

      const modelRequest = brain.buildModelRequest({
        runId: "run-test-1",
        contextSnapshot: snapshot,
        availableTools: INITIAL_TOOL_DEFINITIONS,
        sequenceNumber: 4,
      });

      const userMessage = modelRequest.input.find((m) => m.role === "user")?.content ?? "";

      // Assert model-facing prompt does NOT contain raw digest strings
      expect(userMessage).not.toContain(originalDigest);
      expect(userMessage).not.toContain(resultingDigest);

      // Assert operational details ARE present
      expect(userMessage).toContain('"path":"src/hex.js"');
      expect(userMessage).toContain('"applied":true');
      expect(userMessage).toContain('"occurrences":1');
      expect(userMessage).toContain('"replacedCount":1');

      // Assert authoritative snapshot data object still holds complete digests for persistence/audit
      const rawOutputInSnapshot = (toolResultObs.content.output as any);
      expect(rawOutputInSnapshot.originalDigest).toBe(originalDigest);
      expect(rawOutputInSnapshot.resultingDigest).toBe(resultingDigest);
    });
  });

  // ==========================================================================
  // Workstream B: Align Tool Schema With Governance
  // ==========================================================================
  describe("Workstream B: Align Tool Schema With Governance", () => {
    it("5. in benchmark repair mode, deriveActionProposalSchema omits overwrite from write_file properties", () => {
      const repairSchema = deriveActionProposalSchema(INITIAL_TOOL_DEFINITIONS, {
        governedBenchmarkRepairMode: true,
        allowWholeFileReplacement: false,
      });

      const branches = (repairSchema.jsonSchema as any).anyOf;
      const writeBranch = branches.find((b: any) => b.properties?.toolName?.enum?.[0] === "write_file");
      expect(writeBranch).toBeDefined();

      const inputProps = writeBranch.properties.inputPayload.properties;
      expect(inputProps.path).toBeDefined();
      expect(inputProps.content).toBeDefined();
      expect(inputProps.overwrite).toBeUndefined(); // Strictly omitted!
      expect(writeBranch.properties.inputPayload.required).toEqual(["path", "content"]);
    });

    it("6. in general-purpose mode (or allowWholeFileReplacement: true), write_file retains overwrite parameter", () => {
      const generalSchema = deriveActionProposalSchema(INITIAL_TOOL_DEFINITIONS, {
        governedBenchmarkRepairMode: false,
      });

      const branchesGeneral = (generalSchema.jsonSchema as any).anyOf;
      const writeBranchGeneral = branchesGeneral.find((b: any) => b.properties?.toolName?.enum?.[0] === "write_file");
      expect(writeBranchGeneral.properties.inputPayload.properties.overwrite).toBeDefined();

      const overrideSchema = deriveActionProposalSchema(INITIAL_TOOL_DEFINITIONS, {
        governedBenchmarkRepairMode: true,
        allowWholeFileReplacement: true,
      });
      const branchesOverride = (overrideSchema.jsonSchema as any).anyOf;
      const writeBranchOverride = branchesOverride.find((b: any) => b.properties?.toolName?.enum?.[0] === "write_file");
      expect(writeBranchOverride.properties.inputPayload.properties.overwrite).toBeDefined();
    });

    it("7. formatModelFacingToolCatalog projects write_file without overwrite parameter and warns against overwriting existing files in benchmark repair mode", () => {
      const repairCatalog = formatModelFacingToolCatalog(INITIAL_TOOL_DEFINITIONS, {
        governedBenchmarkRepairMode: true,
        allowWholeFileReplacement: false,
      });

      const writeLine = repairCatalog.split("\n").find((line) => line.startsWith("- write_file"));
      expect(writeLine).toBeDefined();
      expect(writeLine).not.toContain("overwrite?: boolean");
      expect(writeLine).toContain("write_file(path: string, content: string, maxBytes?: number)");
      expect(writeLine).toContain("Overwriting existing files is disallowed; use edit_file for existing files.");

      const generalCatalog = formatModelFacingToolCatalog(INITIAL_TOOL_DEFINITIONS);
      const generalWriteLine = generalCatalog.split("\n").find((line) => line.startsWith("- write_file"));
      expect(generalWriteLine).toBeDefined();
      expect(generalWriteLine).toContain("overwrite?: boolean");
      expect(generalWriteLine).toContain("Atomically create or overwrite a file with UTF-8 text.");
    });

    it("8. ProposalValidator authoritatively rejects direct write_file attempts on existing file in benchmark repair mode with DISALLOWED_FILE_OVERWRITE", () => {
      const targetRel = "src/hex.js";
      const fullTarget = path.join(tempDir, targetRel);
      fs.mkdirSync(path.dirname(fullTarget), { recursive: true });
      fs.writeFileSync(fullTarget, "function parseHex(h) { return undefined; }\n", "utf-8");

      const policy = createExecutionPolicy({
        allowedCapabilities: ["workspace.file.read", "workspace.file.write"],
        isolationRequirement: "IN_PROCESS",
        governedBenchmarkRepairMode: true,
        allowWholeFileReplacement: false,
      });

      const contract = createMissionContract({
        taskId: "task-test-repair",
        policy,
        status: "ACTIVE",
        resourceLimits: createResourceLimits({
          timeoutMs: 60000,
          maxAttempts: 5,
          maxOutputBytes: 10 * 1024 * 1024,
        }),
      });

      const snapshot: ContextSnapshot = {
        snapshotId: "ctx-test-val",
        runId: "run-test-1",
        taskId: "task-test-repair",
        policyVersion: "v1",
        createdAt: "2026-10-28T10:00:00.000Z",
        budget: DEFAULT_CONTEXT_BUDGET,
        observations: [],
        omittedObservationsCount: 0,
        omittedObservationsSummary: [],
        totalEstimatedTokens: 0,
        totalBytes: 0,
        contextHash: "a".repeat(64),
      };

      const run = {
        runId: "run-test-1",
        taskId: "task-test-repair",
        status: "RUNNING" as const,
        version: 1,
        attemptCount: 1,
        maxAttempts: 3,
        timeoutMs: 30000,
        idempotencyKey: null,
        currentWorkerId: "worker-test-1",
        leaseId: "lease-1",
        contractBinding: {
          contractId: contract.spec.contractId,
          version: contract.spec.version,
          contentHash: contract.contentHash,
        },
        createdAt: "2026-10-28T10:00:00.000Z",
        updatedAt: "2026-10-28T10:00:00.000Z",
      };

      const validator = new ProposalValidator({ toolRegistry: defaultGovernedToolRegistry });
      const result = validator.validate(
        {
          proposalId: "prop-write-existing",
          toolName: "write_file",
          inputPayload: {
            path: targetRel,
            content: "module.exports = { parseHex: () => {} };\n",
            overwrite: true,
          },
          contextSnapshotHash: "a".repeat(64),
        },
        {
          runId: "run-test-1",
          contextSnapshot: snapshot,
          run,
          contract,
          leaseId: "lease-1",
          targetFilePath: targetRel,
          workspaceHostPath: tempDir,
        }
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toBe("DISALLOWED_FILE_OVERWRITE");
      expect(result.message).toContain("Direct overwrite of existing file 'src/hex.js' via 'write_file' is disallowed");
    });

    it("9. ProposalValidator allows write_file for creating a NEW file that does not yet exist under benchmark repair mode", () => {
      const newFileRel = "src/new-helper.js";
      const policy = createExecutionPolicy({
        allowedCapabilities: ["workspace.file.read", "workspace.file.write"],
        isolationRequirement: "IN_PROCESS",
        governedBenchmarkRepairMode: true,
        allowWholeFileReplacement: false,
      });

      const contract = createMissionContract({
        taskId: "task-test-new-file",
        policy,
        status: "ACTIVE",
        resourceLimits: createResourceLimits({
          timeoutMs: 60000,
          maxAttempts: 5,
          maxOutputBytes: 10 * 1024 * 1024,
        }),
      });

      const snapshot: ContextSnapshot = {
        snapshotId: "ctx-test-val-2",
        runId: "run-test-1",
        taskId: "task-test-new-file",
        policyVersion: "v1",
        createdAt: "2026-10-28T10:00:00.000Z",
        budget: DEFAULT_CONTEXT_BUDGET,
        observations: [],
        omittedObservationsCount: 0,
        omittedObservationsSummary: [],
        totalEstimatedTokens: 0,
        totalBytes: 0,
        contextHash: "a".repeat(64),
      };

      const run = {
        runId: "run-test-1",
        taskId: "task-test-new-file",
        status: "RUNNING" as const,
        version: 1,
        attemptCount: 1,
        maxAttempts: 3,
        timeoutMs: 30000,
        idempotencyKey: null,
        currentWorkerId: "worker-test-1",
        leaseId: "lease-1",
        contractBinding: {
          contractId: contract.spec.contractId,
          version: contract.spec.version,
          contentHash: contract.contentHash,
        },
        createdAt: "2026-10-28T10:00:00.000Z",
        updatedAt: "2026-10-28T10:00:00.000Z",
      };

      const validator = new ProposalValidator({ toolRegistry: defaultGovernedToolRegistry });
      const result = validator.validate(
        {
          proposalId: "prop-write-new",
          toolName: "write_file",
          inputPayload: {
            path: newFileRel,
            content: "export const helper = 42;\n",
          },
          contextSnapshotHash: "a".repeat(64),
        },
        {
          runId: "run-test-1",
          contextSnapshot: snapshot,
          run,
          contract,
          leaseId: "lease-1",
          targetFilePath: newFileRel,
          workspaceHostPath: tempDir,
        }
      );

      expect(result.valid).toBe(true);
    });
  });

  // ==========================================================================
  // Workstream C: Verification Feedback Recency & Observation Ordering
  // ==========================================================================
  describe("Workstream C: Verification Feedback Recency & Observation Ordering", () => {
    it("10. in benchmark repair mode, VERIFICATION observation is rendered with maximum recency (after TOOL_RESULT), immediately preceding ## Required Action", () => {
      const provider = new StubModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model",
      });

      const runStateObs: Observation = {
        observationId: "obs-run-1",
        category: "RUN_STATE",
        provenance: {
          entityKind: "Run",
          entityId: "run-test-1",
          runId: "run-test-1",
          timestamp: "2026-10-28T10:00:00.000Z",
          isAuthoritativeRuntimeFact: true,
        },
        priority: 100,
        freshness: "CURRENT",
        content: { status: "RUNNING" },
        contentHash: "hash-run",
        estimatedBytes: 100,
        estimatedTokens: 25,
        isMandatory: true,
      };

      const missionObs: Observation = {
        observationId: "obs-mission-1",
        category: "MISSION_CONTEXT",
        provenance: {
          entityKind: "MissionContract",
          entityId: "contract-1",
          runId: "run-test-1",
          timestamp: "2026-10-28T10:00:00.000Z",
          isAuthoritativeRuntimeFact: true,
        },
        priority: 90,
        freshness: "CURRENT",
        content: {
          contractId: "contract-1",
          policy: {
            governedBenchmarkRepairMode: true,
            allowWholeFileReplacement: false,
          },
          taskDetails: {
            title: "Shorthand Hexadecimal Parsing Fix",
            description: "Fix shorthand hex parsing",
          },
        },
        contentHash: "hash-mission",
        estimatedBytes: 200,
        estimatedTokens: 50,
        isMandatory: true,
      };

      const toolResultObs: Observation = {
        observationId: "obs-result-1",
        category: "TOOL_RESULT",
        provenance: {
          entityKind: "Attempt",
          entityId: "att-1",
          runId: "run-test-1",
          sequenceNumber: 3,
          timestamp: "2026-10-28T10:01:00.000Z",
          isAuthoritativeRuntimeFact: true,
        },
        priority: 70,
        freshness: "CURRENT",
        content: {
          toolName: "edit_file",
          output: { path: "src/hex.js", applied: true, occurrences: 1, replacedCount: 1 },
        },
        contentHash: "hash-tool-result",
        estimatedBytes: 150,
        estimatedTokens: 40,
        isMandatory: false,
      };

      const verificationObs: Observation = {
        observationId: "obs-verification-1",
        category: "VERIFICATION",
        provenance: {
          entityKind: "VerificationSpec",
          entityId: "spec-1",
          runId: "run-test-1",
          sequenceNumber: 3,
          timestamp: "2026-10-28T10:01:05.000Z",
          isAuthoritativeRuntimeFact: true,
        },
        priority: 95,
        freshness: "CURRENT",
        content: {
          classification: "FAIL",
          summary: "Verification test FAILED with exit code 1. Recovery advisory: In parseHex(h), the statement if (h.length === 4) return undefined; incorrectly returns undefined. Produce a localized repair targeting this statement.",
        },
        contentHash: "hash-verification",
        estimatedBytes: 300,
        estimatedTokens: 75,
        isMandatory: true,
      };

      // Create snapshot with observations (initially unsorted)
      const snapshot: ContextSnapshot = {
        snapshotId: "ctx-order-test",
        runId: "run-test-1",
        taskId: "task-test-1",
        policyVersion: "v1",
        createdAt: "2026-10-28T10:01:10.000Z",
        budget: DEFAULT_CONTEXT_BUDGET,
        observations: [runStateObs, missionObs, verificationObs, toolResultObs],
        omittedObservationsCount: 0,
        omittedObservationsSummary: [],
        totalEstimatedTokens: 190,
        totalBytes: 750,
        contextHash: "hash-context-order",
      };

      const modelRequest = brain.buildModelRequest({
        runId: "run-test-1",
        contextSnapshot: snapshot,
        availableTools: INITIAL_TOOL_DEFINITIONS,
        sequenceNumber: 4,
      });

      const userMessage = modelRequest.input.find((m) => m.role === "user")?.content ?? "";

      const runStateIdx = userMessage.indexOf("### [RUN_STATE]");
      const missionIdx = userMessage.indexOf("### [MISSION_CONTEXT]");
      const toolResultIdx = userMessage.indexOf("### [TOOL_RESULT]");
      const verificationIdx = userMessage.indexOf("### [VERIFICATION]");
      const requiredActionIdx = userMessage.indexOf("## Required Action");

      expect(runStateIdx).toBeGreaterThan(0);
      expect(missionIdx).toBeGreaterThan(runStateIdx);
      expect(toolResultIdx).toBeGreaterThan(missionIdx);
      expect(verificationIdx).toBeGreaterThan(toolResultIdx); // VERIFICATION appears AFTER TOOL_RESULT!
      expect(requiredActionIdx).toBeGreaterThan(verificationIdx); // ## Required Action is immediately after VERIFICATION!
    });

    it("11. in general-purpose mode, default display order is preserved without forcing benchmark repair ordering", () => {
      const provider = new StubModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model",
      });

      const missionObs: Observation = {
        observationId: "obs-mission-general",
        category: "MISSION_CONTEXT",
        provenance: {
          entityKind: "MissionContract",
          entityId: "contract-gen",
          runId: "run-gen",
          timestamp: "2026-10-28T10:00:00.000Z",
          isAuthoritativeRuntimeFact: true,
        },
        priority: 90,
        freshness: "CURRENT",
        content: {
          contractId: "contract-gen",
          policy: {
            governedBenchmarkRepairMode: false,
          },
        },
        contentHash: "hash-gen-mission",
        estimatedBytes: 150,
        estimatedTokens: 35,
        isMandatory: true,
      };

      const verificationObs: Observation = {
        observationId: "obs-ver-gen",
        category: "VERIFICATION",
        provenance: {
          entityKind: "VerificationSpec",
          entityId: "spec-gen",
          runId: "run-gen",
          timestamp: "2026-10-28T10:00:01.000Z",
          isAuthoritativeRuntimeFact: true,
        },
        priority: 75,
        freshness: "CURRENT",
        content: { summary: "General verification note" },
        contentHash: "hash-gen-ver",
        estimatedBytes: 100,
        estimatedTokens: 25,
        isMandatory: false,
      };

      const toolResultObs: Observation = {
        observationId: "obs-res-gen",
        category: "TOOL_RESULT",
        provenance: {
          entityKind: "Attempt",
          entityId: "att-gen",
          runId: "run-gen",
          timestamp: "2026-10-28T10:00:02.000Z",
          isAuthoritativeRuntimeFact: true,
        },
        priority: 60,
        freshness: "CURRENT",
        content: { toolName: "run_command", output: { stdout: "hello", exitCode: 0 } },
        contentHash: "hash-gen-res",
        estimatedBytes: 120,
        estimatedTokens: 30,
        isMandatory: false,
      };

      // In general mode, observations are rendered in the order supplied by snapshot
      const snapshot: ContextSnapshot = {
        snapshotId: "ctx-gen-test",
        runId: "run-gen",
        taskId: "task-gen",
        policyVersion: "v1",
        createdAt: "2026-10-28T10:00:03.000Z",
        budget: DEFAULT_CONTEXT_BUDGET,
        observations: [missionObs, verificationObs, toolResultObs],
        omittedObservationsCount: 0,
        omittedObservationsSummary: [],
        totalEstimatedTokens: 90,
        totalBytes: 370,
        contextHash: "hash-ctx-gen",
      };

      const modelRequest = brain.buildModelRequest({
        runId: "run-gen",
        contextSnapshot: snapshot,
        availableTools: INITIAL_TOOL_DEFINITIONS,
        sequenceNumber: 1,
      });

      const userMessage = modelRequest.input.find((m) => m.role === "user")?.content ?? "";

      const verIdx = userMessage.indexOf("### [VERIFICATION]");
      const resIdx = userMessage.indexOf("### [TOOL_RESULT]");

      // Preserves original snapshot order where verification came first
      expect(verIdx).toBeLessThan(resIdx);
    });
  });
});
