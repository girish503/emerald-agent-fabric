/**
 * Phase 48G: Targeted Whole-File No-Op Guidance and Bounded Duplicate-Proposal Guard
 *
 * Verifies all requirements for Phase 48G:
 * 1. isOversizedWholeFileAnchor uses generic, model/benchmark-independent criteria.
 * 2. deriveActionableValidationGuidance outputs targeted whole-file guidance when oversized no-op occurs.
 * 3. deriveActionableValidationGuidance retains standard localized no-op guidance for small anchors.
 * 4. ProposalValidator rejects oversized no-op edits with NOOP_EDIT_DISALLOWED.
 * 5. DuplicateProposalDetector computes deterministic fingerprints excluding volatile metadata.
 * 6. DuplicateProposalDetector normalizes file path separators.
 * 7. DuplicateProposalDetector detects immediate duplicate retry following pre-execution rejection.
 * 8. Meaningfully different proposals are allowed to proceed through validation.
 * 9. Successful action execution clears the immediate duplicate state.
 * 10. Fresh successful read of target file invalidates duplicate memory for that file.
 * 11. Run reset (clearAll) completely clears detector memory.
 * 12. Bounded capacity evicts oldest records without unbounded memory growth.
 * 13. ProposalValidator rejects duplicate proposals with DUPLICATE_PROPOSAL_DISALLOWED.
 * 14. AgentStepController integrates duplicate detection, tracks rejections, and respects rejection budget.
 * 15. Target file on disk remains completely untouched throughout rejections.
 *
 * Zero live inference. Zero network calls. Zero git mutations.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  DuplicateProposalDetector,
  isOversizedWholeFileAnchor,
} from "../../src/application/duplicate-proposal-detector.js";
import {
  AgentStepController,
  deriveActionableValidationGuidance,
  DEFAULT_STEP_CONTROLLER_BUDGET,
} from "../../src/application/agent-step-controller.js";
import { ProposalValidator } from "../../src/application/proposal-validator.js";
import {
  EDIT_FILE_TOOL,
  INITIAL_TOOL_DEFINITIONS,
  StaticToolRegistry,
  defaultGovernedToolRegistry,
} from "../../src/domain/tool.js";
import {
  createExecutionPolicy,
  createMissionContract,
  createResourceLimits,
  createVerificationSpec,
  MissionContract,
  PolicyEvaluator,
} from "../../src/domain/index.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { SystemClock } from "../../src/ports/clock.port.js";
import { AgentBrainPort, AgentBrainRequest, AgentBrainResult } from "../../src/ports/agent-brain.port.js";
import { ActionProposal } from "../../src/domain/action-proposal.js";
import { ContextSnapshot, DEFAULT_CONTEXT_BUDGET } from "../../src/domain/context.js";
import { RunSnapshot } from "../../src/domain/invariants.js";
import { createAndActivateContract } from "./test-helpers.js";

describe("Phase 48G: Targeted Whole-File Guidance and Duplicate-Proposal Guard", () => {
  let tempDir: string;
  let testFile: string;
  let initialFileContent: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "eaf-phase48g-test-"));
    testFile = path.join(tempDir, "sample.js");
    initialFileContent = [
      "function computeA(x) {",
      "  return x + 1;",
      "}",
      "",
      "function computeB(y) {",
      "  return y * 2;",
      "}",
      "",
      "module.exports = { computeA, computeB };",
      "",
    ].join("\n");
    await fs.writeFile(testFile, initialFileContent, "utf8");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // Suite 1: Oversized Whole-File Anchor Detection & Guidance (Option 1)
  // ==========================================================================
  describe("Option 1 — Targeted Whole-File No-Op Guidance", () => {
    it("identifies anchors with > 5 lines as oversized whole-file anchors", () => {
      const multiLineAnchor = [
        "function one() {",
        "  return 1;",
        "}",
        "function two() {",
        "  return 2;",
        "}",
      ].join("\n");
      expect(isOversizedWholeFileAnchor(multiLineAnchor)).toBe(true);
    });

    it("identifies multi-declaration code blocks as oversized anchors", () => {
      const multiDeclAnchor = "function alpha() { return 1; }\nfunction beta() { return 2; }";
      expect(isOversizedWholeFileAnchor(multiDeclAnchor)).toBe(true);

      const classAndFunc = "class Service {}\nfunction createService() { return new Service(); }";
      expect(isOversizedWholeFileAnchor(classAndFunc)).toBe(true);
    });

    it("identifies anchors exceeding 200 characters with multiple line breaks as oversized", () => {
      const longAnchor =
        "const config = {\n" +
        "  settingA: 'extremely_long_configuration_parameter_that_takes_up_substantial_space',\n" +
        "  settingB: 'another_verbose_option_that_pushes_character_count_well_over_the_two_hundred_mark'\n" +
        "};";
      expect(isOversizedWholeFileAnchor(longAnchor)).toBe(true);
    });

    it("does not classify small localized (1-3 line) code anchors as oversized", () => {
      expect(isOversizedWholeFileAnchor("return x + 1;")).toBe(false);
      expect(isOversizedWholeFileAnchor("const tax = total * 0.05;\nreturn total + tax;")).toBe(false);
      expect(
        isOversizedWholeFileAnchor("function add(a, b) {\n  return a + b;\n}")
      ).toBe(false);
    });

    it("handles non-string, empty, or whitespace-only anchors safely without throwing", () => {
      expect(isOversizedWholeFileAnchor(null)).toBe(false);
      expect(isOversizedWholeFileAnchor(undefined)).toBe(false);
      expect(isOversizedWholeFileAnchor(12345)).toBe(false);
      expect(isOversizedWholeFileAnchor("")).toBe(false);
      expect(isOversizedWholeFileAnchor("   \n\t  ")).toBe(false);
    });

    it("generates specific whole-file guidance when NOOP_EDIT_DISALLOWED has an oversized anchor", () => {
      const wholeFileAnchor = initialFileContent;
      const guidance = deriveActionableValidationGuidance({
        toolName: "edit_file",
        rejectionReason: "NOOP_EDIT_DISALLOWED",
        inputPayload: {
          path: "sample.js",
          searchAnchor: wholeFileAnchor,
          replacementText: wholeFileAnchor,
        },
      });

      expect(guidance).not.toBeNull();
      expect(guidance).toContain("entire source file");
      expect(guidance).toContain("Do NOT submit the whole file");
      expect(guidance).toContain("1-3 lines");
      expect(guidance).toContain("replacementText' must be different");
      expect(guidance).toContain("rest of the file remains untouched");
      // Must contain a generic example not tied to the benchmark gold answer
      expect(guidance).toContain("Generic example");
      expect(guidance).not.toContain("src/calc.js");
      expect(guidance).not.toContain("return a + b;");
    });

    it("retains standard localized guidance when NOOP_EDIT_DISALLOWED has a small anchor", () => {
      const guidance = deriveActionableValidationGuidance({
        toolName: "edit_file",
        rejectionReason: "NOOP_EDIT_DISALLOWED",
        inputPayload: {
          path: "sample.js",
          searchAnchor: "return x + 1;",
          replacementText: "return x + 1;",
        },
      });

      expect(guidance).not.toBeNull();
      expect(guidance).toContain("'searchAnchor' and 'replacementText' are identical");
      expect(guidance).toContain("Choose a small, unique literal code anchor");
      expect(guidance).not.toContain("entire source file");
    });

    it("ProposalValidator rejects oversized no-op edits with specific message and NOOP_EDIT_DISALLOWED reason", () => {
      const registry = new StaticToolRegistry([EDIT_FILE_TOOL]);
      const validator = new ProposalValidator({ toolRegistry: registry });

      const contract = createMissionContract({
        contractId: "contract-48g-1",
        taskId: "task-48g-1",
        version: 1,
        status: "ACTIVE",
        policy: createExecutionPolicy({
          allowedTools: ["edit_file"],
          isolationRequirement: "IN_PROCESS",
          governedBenchmarkRepairMode: true,
          allowWholeFileReplacement: false,
          allowedCapabilities: ["workspace.file.read", "workspace.file.write"],
        }),
        resourceLimits: createResourceLimits({
          timeoutMs: 30000,
          maxAttempts: 3,
          maxOutputBytes: 1048576,
        }),
        verificationSpecs: [
          createVerificationSpec({
            specId: "v1",
            ruleKind: "EXIT_CODE_ZERO",
            expectedValue: 0,
          }),
        ],
      });

      const contextSnapshot: ContextSnapshot = {
        snapshotId: "snap-1",
        contextHash: "a".repeat(64),
        taskId: "task-48g-1",
        createdAt: new Date().toISOString(),
        observations: [],
        totalBytes: 100,
        totalEstimatedTokens: 25,
        omittedObservationsCount: 0,
        budget: DEFAULT_CONTEXT_BUDGET,
      };

      const run: RunSnapshot = {
        runId: "run-48g-1",
        taskId: "task-48g-1",
        status: "RUNNING",
        version: 1,
        attemptCount: 1,
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        contractBinding: {
          contractId: contract.id,
          version: contract.version,
          contentHash: contract.contentHash,
          boundAt: new Date().toISOString(),
        },
      };

      const result = validator.validate(
        {
          proposalId: "p-1",
          toolName: "edit_file",
          contextSnapshotHash: "a".repeat(64),
          inputPayload: {
            path: "sample.js",
            searchAnchor: initialFileContent,
            replacementText: initialFileContent,
          },
        },
        {
          runId: "run-48g-1",
          run,
          contextSnapshot,
          contract,
          workspaceHostPath: tempDir,
        }
      );

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("NOOP_EDIT_DISALLOWED");
        expect(result.message).toContain("Entire file or oversized");
        expect(result.message).toContain("1-3 line");
      }
    });
  });

  // ==========================================================================
  // Suite 2: Bounded Duplicate-Proposal Detector (Option 3)
  // ==========================================================================
  describe("Option 3 — Bounded Duplicate-Proposal Detector", () => {
    let detector: DuplicateProposalDetector;

    beforeEach(() => {
      detector = new DuplicateProposalDetector({ maxCapacity: 5 });
    });

    it("computes deterministic fingerprints ignoring volatile fields (proposalId, contextSnapshotHash)", () => {
      const p1 = {
        proposalId: "id-111",
        contextSnapshotHash: "0".repeat(64),
        sequenceHint: 1,
        rationale: "first attempt",
        path: "src/code.js",
        searchAnchor: "foo",
        replacementText: "bar",
      };
      const p2 = {
        proposalId: "id-222",
        contextSnapshotHash: "1".repeat(64),
        sequenceHint: 2,
        rationale: "second attempt",
        path: "src/code.js",
        searchAnchor: "foo",
        replacementText: "bar",
      };

      const fp1 = detector.computeFingerprint("edit_file", p1);
      const fp2 = detector.computeFingerprint("edit_file", p2);

      expect(fp1).toBe(fp2);
      expect(typeof fp1).toBe("string");
      expect(fp1.length).toBe(64); // SHA-256 hex
    });

    it("normalizes path separators so backslashes and forward slashes match", () => {
      const pWindows = { path: "src\\utils\\calc.js", searchAnchor: "x", replacementText: "y" };
      const pPosix = { path: "src/utils/calc.js", searchAnchor: "x", replacementText: "y" };

      const fpWin = detector.computeFingerprint("edit_file", pWindows);
      const fpPos = detector.computeFingerprint("edit_file", pPosix);

      expect(fpWin).toBe(fpPos);
    });

    it("detects an identical retry following a pre-execution rejection", () => {
      const payload = { path: "sample.js", searchAnchor: "const x = 1;", replacementText: "const x = 1;" };

      expect(detector.isDuplicate("edit_file", payload)).toBe(false);

      detector.recordRejection("edit_file", payload, "NOOP_EDIT_DISALLOWED", 2);

      expect(detector.isDuplicate("edit_file", payload)).toBe(true);

      const record = detector.getDuplicateRecord("edit_file", payload);
      expect(record).toBeDefined();
      expect(record?.stepNumber).toBe(2);
      expect(record?.rejectionReason).toBe("NOOP_EDIT_DISALLOWED");
      expect(record?.toolName).toBe("edit_file");
      expect(record?.targetPath).toBe("sample.js");
    });

    it("allows meaningfully different proposals to proceed", () => {
      const payload1 = { path: "sample.js", searchAnchor: "const a = 1;", replacementText: "const a = 1;" };
      detector.recordRejection("edit_file", payload1, "NOOP_EDIT_DISALLOWED", 2);

      // Different replacementText
      const payloadDifferentReplacement = {
        path: "sample.js",
        searchAnchor: "const a = 1;",
        replacementText: "const a = 2;",
      };
      expect(detector.isDuplicate("edit_file", payloadDifferentReplacement)).toBe(false);

      // Different tool
      expect(detector.isDuplicate("read_file", { path: "sample.js" })).toBe(false);

      // Different path
      const payloadDifferentPath = {
        path: "other.js",
        searchAnchor: "const a = 1;",
        replacementText: "const a = 1;",
      };
      expect(detector.isDuplicate("edit_file", payloadDifferentPath)).toBe(false);
    });

    it("clears immediate duplicate state on any successful action execution", () => {
      const payload = { path: "sample.js", searchAnchor: "const a = 1;", replacementText: "const a = 1;" };
      detector.recordRejection("edit_file", payload, "NOOP_EDIT_DISALLOWED", 2);
      expect(detector.isDuplicate("edit_file", payload)).toBe(true);

      // Successful read action occurs
      detector.onActionExecuted({
        toolName: "read_file",
        status: "SUCCEEDED",
        inputPayload: { path: "sample.js" },
      });

      // Immediate duplicate check is now false
      expect(detector.isDuplicate("edit_file", payload)).toBe(false);
    });

    it("failed action execution does not clear duplicate memory", () => {
      const payload = { path: "sample.js", searchAnchor: "const a = 1;", replacementText: "const a = 1;" };
      detector.recordRejection("edit_file", payload, "NOOP_EDIT_DISALLOWED", 2);
      expect(detector.isDuplicate("edit_file", payload)).toBe(true);

      // Failed action execution occurs
      detector.onActionExecuted({
        toolName: "run_command",
        status: "FAILED",
        inputPayload: { argv: ["npm", "test"] },
      });

      // Duplicate state remains active
      expect(detector.isDuplicate("edit_file", payload)).toBe(true);
    });

    it("clearForTarget clears records for the specified target file only", () => {
      const p1 = { path: "fileA.js", content: "data" };
      const p2 = { path: "fileB.js", content: "data" };

      detector.recordRejection("write_file", p1, "DISALLOWED_FILE_OVERWRITE", 1);
      detector.recordRejection("write_file", p2, "DISALLOWED_FILE_OVERWRITE", 2);

      expect(detector.getTrackedCount()).toBe(2);

      detector.clearForTarget("fileA.js");

      expect(detector.getTrackedCount()).toBe(1);
      expect(detector.isDuplicate("write_file", p2)).toBe(true);
      expect(detector.isDuplicate("write_file", p1)).toBe(false);
    });

    it("clearAll completely resets the detector across runs", () => {
      detector.recordRejection("write_file", { path: "a.js" }, "OVERWRITE", 1);
      expect(detector.getTrackedCount()).toBe(1);

      detector.clearAll();

      expect(detector.getTrackedCount()).toBe(0);
      expect(detector.isDuplicate("write_file", { path: "a.js" })).toBe(false);
      expect(detector.getLastRejectedFingerprint()).toBeNull();
    });

    it("enforces bounded capacity by evicting oldest entries", () => {
      const smallDetector = new DuplicateProposalDetector({ maxCapacity: 3 });

      smallDetector.recordRejection("write_file", { path: "file1.js" }, "R1", 1);
      smallDetector.recordRejection("write_file", { path: "file2.js" }, "R2", 2);
      smallDetector.recordRejection("write_file", { path: "file3.js" }, "R3", 3);

      expect(smallDetector.getTrackedCount()).toBe(3);

      // 4th rejection evicts file1
      smallDetector.recordRejection("write_file", { path: "file4.js" }, "R4", 4);

      expect(smallDetector.getTrackedCount()).toBe(3);
      expect(smallDetector.isDuplicate("write_file", { path: "file4.js" })).toBe(true);
      expect(smallDetector.isDuplicate("write_file", { path: "file1.js" })).toBe(false);
    });

    it("ProposalValidator rejects duplicate proposal with DUPLICATE_PROPOSAL_DISALLOWED", () => {
      const registry = new StaticToolRegistry([EDIT_FILE_TOOL]);
      const validator = new ProposalValidator({ toolRegistry: registry });

      const contract = createMissionContract({
        contractId: "contract-48g-dup",
        taskId: "task-48g-dup",
        version: 1,
        status: "ACTIVE",
        policy: createExecutionPolicy({
          allowedTools: ["edit_file"],
          isolationRequirement: "IN_PROCESS",
          allowedCapabilities: ["workspace.file.read", "workspace.file.write"],
        }),
        resourceLimits: createResourceLimits({
          timeoutMs: 30000,
          maxAttempts: 3,
          maxOutputBytes: 1048576,
        }),
        verificationSpecs: [
          createVerificationSpec({
            specId: "v1",
            ruleKind: "EXIT_CODE_ZERO",
            expectedValue: 0,
          }),
        ],
      });

      const contextSnapshot: ContextSnapshot = {
        snapshotId: "snap-1",
        contextHash: "b".repeat(64),
        taskId: "task-48g-dup",
        createdAt: new Date().toISOString(),
        observations: [],
        totalBytes: 100,
        totalEstimatedTokens: 25,
        omittedObservationsCount: 0,
        budget: DEFAULT_CONTEXT_BUDGET,
      };

      const run: RunSnapshot = {
        runId: "run-dup-1",
        taskId: "task-48g-dup",
        status: "RUNNING",
        version: 1,
        attemptCount: 1,
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        contractBinding: {
          contractId: contract.id,
          version: contract.version,
          contentHash: contract.contentHash,
          boundAt: new Date().toISOString(),
        },
      };

      const result = validator.validate(
        {
          proposalId: "p-dup",
          toolName: "edit_file",
          contextSnapshotHash: "b".repeat(64),
          inputPayload: {
            path: "sample.js",
            searchAnchor: "return x + 1;",
            replacementText: "return x + 2;",
          },
        },
        {
          runId: "run-dup-1",
          run,
          contextSnapshot,
          contract,
          workspaceHostPath: tempDir,
          duplicateProposalChecker: () => ({
            isDuplicate: true,
            priorStep: 3,
            priorReason: "NOOP_EDIT_DISALLOWED",
          }),
        }
      );

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("DUPLICATE_PROPOSAL_DISALLOWED");
        expect(result.message).toContain("Proposal for tool 'edit_file' rejected");
        expect(result.message).toContain("already rejected at step 3 (NOOP_EDIT_DISALLOWED)");
      }
    });

    it("generates actionable guidance for DUPLICATE_PROPOSAL_DISALLOWED", () => {
      const guidance = deriveActionableValidationGuidance({
        toolName: "edit_file",
        rejectionReason: "DUPLICATE_PROPOSAL_DISALLOWED",
      });

      expect(guidance).not.toBeNull();
      expect(guidance).toContain("Proposal rejected: An identical tool proposal was already rejected");
      expect(guidance).toContain("Repeating the identical proposal is disallowed");
      expect(guidance).toContain("meaningfully different action");
    });
  });

  // ==========================================================================
  // Suite 3: End-to-End AgentStepController Integration Tests
  // ==========================================================================
  describe("AgentStepController Duplicate-Proposal & Rejection Ceiling Integration", () => {
    let store: SqliteStateStore;
    let clock: SystemClock;
    let coordinator: RunCoordinator;
    let workspaceAdapter: NodeFsWorkspaceAdapter;
    const workerId = "worker-48g-integration";

    beforeEach(() => {
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
    });

    it("reproduces Phase 48E sequence and catches Step 4 duplicate with DUPLICATE_PROPOSAL_DISALLOWED, terminating safely at rejection ceiling", async () => {
      const taskId = "task-phase48g-repro";

      store.transaction((tx) => {
        tx.insertTask({
          taskId,
          title: "Phase 48G Test Task",
          description: "Repair code",
          inputPayload: {},
          status: "READY",
          createdAt: clock.nowIso(),
          updatedAt: clock.nowIso(),
        });
      });

      createAndActivateContract(store, taskId, {
        policy: createExecutionPolicy({
          allowedTools: ["read_file", "write_file", "edit_file"],
          isolationRequirement: "IN_PROCESS",
          governedBenchmarkRepairMode: true,
          allowWholeFileReplacement: false,
          allowedCapabilities: [
            "workspace.file.read",
            "workspace.file.write",
            "process.execute",
            "system.inspect",
          ],
        }),
      });

      const { run } = coordinator.createRun({ taskId });
      coordinator.queueRun(run.runId);
      const claimResult = coordinator.claimRun(run.runId, workerId, 60000);
      coordinator.startRun(run.runId, workerId, claimResult.lease.leaseId);

      // Scripted mock agent brain simulating the Phase 48E sequence:
      // Step 1: read_file sample.js -> succeeds
      // Step 2: write_file sample.js with initialContent -> rejected DISALLOWED_FILE_OVERWRITE (rejection 1)
      // Step 3: edit_file sample.js with identical anchor & replacement -> rejected NOOP_EDIT_DISALLOWED (rejection 2)
      // Step 4: identical edit_file retry -> rejected DUPLICATE_PROPOSAL_DISALLOWED (rejection 3 -> hits budget)
      let turn = 0;
      const scriptedBrain: AgentBrainPort = {
        proposeAction: async (req: AgentBrainRequest): Promise<AgentBrainResult> => {
          turn++;
          const hash = req.contextSnapshot.contextHash;
          if (turn === 1) {
            return {
              proposal: {
                proposalId: "p-read",
                toolName: "read_file",
                contextSnapshotHash: hash,
                inputPayload: { path: "sample.js", offsetLine: 1, limitLines: 50 },
              },
              finishReason: "ACTION_PROPOSED",
              telemetry: { durationMs: 10 },
            };
          }
          if (turn === 2) {
            return {
              proposal: {
                proposalId: "p-write-overwrite",
                toolName: "write_file",
                contextSnapshotHash: hash,
                inputPayload: { path: "sample.js", content: initialFileContent },
              },
              finishReason: "ACTION_PROPOSED",
              telemetry: { durationMs: 10 },
            };
          }
          if (turn === 3) {
            // First no-op proposal: entire file
            return {
              proposal: {
                proposalId: "p-edit-noop-1",
                toolName: "edit_file",
                contextSnapshotHash: hash,
                inputPayload: {
                  path: "sample.js",
                  searchAnchor: initialFileContent,
                  replacementText: initialFileContent,
                },
              },
              finishReason: "ACTION_PROPOSED",
              telemetry: { durationMs: 10 },
            };
          }
          // Step 4: identical retry of the rejected no-op proposal
          return {
            proposal: {
              proposalId: "p-edit-noop-2-dup", // different proposalId
              contextSnapshotHash: hash,        // new contextSnapshotHash
              toolName: "edit_file",
              inputPayload: {
                path: "sample.js",
                searchAnchor: initialFileContent,
                replacementText: initialFileContent,
              },
            },
            finishReason: "ACTION_PROPOSED",
            telemetry: { durationMs: 10 },
          };
        },
      };

      const workerRuntime = new WorkerRuntime({
        workerId,
        stateStore: store,
        clock,
        coordinator,
        toolRegistry: defaultGovernedToolRegistry,
        workspacePort: workspaceAdapter,
      });

      const controller = new AgentStepController({
        coordinator,
        stateStore: store,
        workerRuntime,
        agentBrain: scriptedBrain,
        clock,
        defaultBudget: {
          ...DEFAULT_STEP_CONTROLLER_BUDGET,
          maxSteps: 10,
          maxProposalRejections: 3, // Exactly matching Phase 48E budget
        },
      });

      const loopResult = await controller.runStepLoop({
        runId: run.runId,
        workerId,
        leaseId: claimResult.lease.leaseId,
        workspace: { workspaceId: "ws-48g", hostPath: tempDir },
      });

      // Verification:
      // 1. Controller terminates with MAX_PROPOSAL_REJECTIONS
      expect(loopResult.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");
      expect(loopResult.totalSteps).toBe(4);
      expect(loopResult.totalActions).toBe(1); // Only the Step 1 read_file executed
      expect(loopResult.totalProposalRejections).toBe(3);

      const transcript = loopResult.transcript;
      expect(transcript.length).toBe(4);

      // Step 2 was rejected as DISALLOWED_FILE_OVERWRITE
      expect(transcript[1].proposalValid).toBe(false);
      expect(transcript[1].proposalRejectionReason).toBe("DISALLOWED_FILE_OVERWRITE");

      // Step 3 was rejected as NOOP_EDIT_DISALLOWED with oversized guidance
      expect(transcript[2].proposalValid).toBe(false);
      expect(transcript[2].proposalRejectionReason).toBe("NOOP_EDIT_DISALLOWED");
      expect(transcript[2].proposalRejectionMessage).toContain("Entire file or oversized");

      // Step 4 was caught as DUPLICATE_PROPOSAL_DISALLOWED by the duplicate guard!
      expect(transcript[3].proposalValid).toBe(false);
      expect(transcript[3].proposalRejectionReason).toBe("DUPLICATE_PROPOSAL_DISALLOWED");
      expect(transcript[3].proposalRejectionMessage).toContain("already rejected");

      // Target file remains byte-for-byte identical to baseline
      const finalContent = await fs.readFile(testFile, "utf8");
      expect(finalContent).toBe(initialFileContent);
    });

    it("allows a changed proposal after rejection to proceed and succeed", async () => {
      const taskId = "task-phase48g-recovery";

      store.transaction((tx) => {
        tx.insertTask({
          taskId,
          title: "Recovery Task",
          description: "Test recovery",
          inputPayload: {},
          status: "READY",
          createdAt: clock.nowIso(),
          updatedAt: clock.nowIso(),
        });
      });

      createAndActivateContract(store, taskId, {
        policy: createExecutionPolicy({
          allowedTools: ["read_file", "edit_file"],
          isolationRequirement: "IN_PROCESS",
          governedBenchmarkRepairMode: true,
          allowedCapabilities: [
            "workspace.file.read",
            "workspace.file.write",
            "process.execute",
            "system.inspect",
          ],
        }),
      });

      const { run } = coordinator.createRun({ taskId });
      coordinator.queueRun(run.runId);
      const claimResult = coordinator.claimRun(run.runId, workerId, 60000);
      coordinator.startRun(run.runId, workerId, claimResult.lease.leaseId);

      let turn = 0;
      const scriptedBrain: AgentBrainPort = {
        proposeAction: async (req: AgentBrainRequest): Promise<AgentBrainResult> => {
          turn++;
          const hash = req.contextSnapshot.contextHash;
          if (turn === 1) {
            // First turn: no-op edit proposal (rejected)
            return {
              proposal: {
                proposalId: "p-noop",
                toolName: "edit_file",
                contextSnapshotHash: hash,
                inputPayload: {
                  path: "sample.js",
                  searchAnchor: "return x + 1;",
                  replacementText: "return x + 1;",
                },
              },
              finishReason: "ACTION_PROPOSED",
              telemetry: { durationMs: 10 },
            };
          }
          if (turn === 2) {
            // Second turn: corrected localized proposal (not a duplicate!)
            return {
              proposal: {
                proposalId: "p-valid-edit",
                toolName: "edit_file",
                contextSnapshotHash: hash,
                inputPayload: {
                  path: "sample.js",
                  searchAnchor: "return x + 1;",
                  replacementText: "return x + 42;",
                },
              },
              finishReason: "ACTION_PROPOSED",
              telemetry: { durationMs: 10 },
            };
          }
          // Final turn: goal reached
          return {
            proposal: {
              isGoalReached: true,
              contextSnapshotHash: hash,
            },
            finishReason: "GOAL_REACHED",
            telemetry: { durationMs: 10 },
          };
        },
      };

      const workerRuntime = new WorkerRuntime({
        workerId,
        stateStore: store,
        clock,
        coordinator,
        toolRegistry: defaultGovernedToolRegistry,
        workspacePort: workspaceAdapter,
      });

      const controller = new AgentStepController({
        coordinator,
        stateStore: store,
        workerRuntime,
        agentBrain: scriptedBrain,
        clock,
        defaultBudget: {
          ...DEFAULT_STEP_CONTROLLER_BUDGET,
          maxSteps: 5,
          maxProposalRejections: 3,
        },
      });

      const loopResult = await controller.runStepLoop({
        runId: run.runId,
        workerId,
        leaseId: claimResult.lease.leaseId,
        workspace: { workspaceId: "ws-48g-rec", hostPath: tempDir },
      });

      // Verification:
      // Turn 1 rejected, Turn 2 accepted and executed, Turn 3 completed
      expect(loopResult.totalSteps).toBe(3);
      expect(loopResult.totalActions).toBe(1);

      const modifiedContent = await fs.readFile(testFile, "utf8");
      expect(modifiedContent).toContain("return x + 42;");
    });
  });
});
