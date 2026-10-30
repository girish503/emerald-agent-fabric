import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { FailedAnchorTracker } from "../../src/application/failed-anchor-tracker.js";
import { ProposalValidator } from "../../src/application/proposal-validator.js";
import {
  AgentStepController,
  deriveActionableValidationGuidance,
} from "../../src/application/agent-step-controller.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { defaultGovernedToolRegistry } from "../../src/domain/tool.js";
import { SystemClock } from "../../src/ports/clock.port.js";
import { AgentBrainPort, AgentBrainRequest, AgentBrainResult } from "../../src/ports/agent-brain.port.js";
import { ExecutionProvider, ExecutionRequest, ExecutionResult } from "../../src/ports/execution-provider.port.js";
import { ActionProposal } from "../../src/domain/action-proposal.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import { createAndActivateContract } from "./test-helpers.js";

describe("Phase 48D: Grounded Verification Context and Failed-Anchor Guard", () => {
  let tempDir: string;
  let store: SqliteStateStore;
  let clock: SystemClock;
  let coordinator: RunCoordinator;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  const workerId = "worker-phase48d-1";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eaf-phase48d-test-"));
    store = new SqliteStateStore();
    clock = new SystemClock();
    coordinator = new RunCoordinator(store, clock);
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: tempDir });

    // Register active worker
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
  // Option C Unit Tests: FailedAnchorTracker
  // ==========================================================================
  describe("FailedAnchorTracker", () => {
    it("normalizes file paths to workspace-relative forward-slash form", () => {
      const tracker = new FailedAnchorTracker();
      expect(tracker.normalizePath("src\\utils\\math.ts")).toBe("src/utils/math.ts");
      expect(tracker.normalizePath("./src/utils/math.ts")).toBe("src/utils/math.ts");
      expect(tracker.normalizePath(".\\src\\utils\\math.ts")).toBe("src/utils/math.ts");
    });

    it("records failure for missing and ambiguous anchors only", () => {
      const tracker = new FailedAnchorTracker();
      tracker.recordFailure("src/math.ts", "const x = 1;", "MISSING", 1);
      tracker.recordFailure("src/math.ts", "function add(", "AMBIGUOUS", 2);

      expect(tracker.isFailedAnchor("src/math.ts", "const x = 1;")).toBe(true);
      expect(tracker.isFailedAnchor("./src/math.ts", "function add(")).toBe(true);
      expect(tracker.isFailedAnchor("src\\math.ts", "const x = 1;")).toBe(true);
      expect(tracker.isFailedAnchor("src/math.ts", "const y = 2;")).toBe(false);

      const record = tracker.getFailedAnchorRecord("src/math.ts", "const x = 1;");
      expect(record).toEqual({
        path: "src/math.ts",
        anchor: "const x = 1;",
        failureReason: "MISSING",
        failedAtStep: 1,
      });
    });

    it("clears failed anchors for a specific file upon fresh read or mutation", () => {
      const tracker = new FailedAnchorTracker();
      tracker.recordFailure("src/a.ts", "anchorA", "MISSING", 1);
      tracker.recordFailure("src/b.ts", "anchorB", "MISSING", 1);

      expect(tracker.getTotalFailedAnchorCount()).toBe(2);

      tracker.clearForFile("src/a.ts");
      expect(tracker.isFailedAnchor("src/a.ts", "anchorA")).toBe(false);
      expect(tracker.isFailedAnchor("src/b.ts", "anchorB")).toBe(true);
      expect(tracker.getTotalFailedAnchorCount()).toBe(1);
    });

    it("finds matching failed anchors for zero-match search queries (Option D)", () => {
      const tracker = new FailedAnchorTracker();
      tracker.recordFailure("src/math.ts", "const result = 10;", "MISSING", 1);

      const match1 = tracker.findMatchingFailedAnchor("const result = 10;");
      expect(match1).toBeDefined();
      expect(match1?.path).toBe("src/math.ts");

      const matchPattern = tracker.findMatchingFailedAnchor("const result = 10;", "src/math.ts");
      expect(matchPattern).toBeDefined();

      const noMatchPattern = tracker.findMatchingFailedAnchor("const result = 10;", "src/other.ts");
      expect(noMatchPattern).toBeUndefined();

      const noMatchQuery = tracker.findMatchingFailedAnchor("const result = 20;");
      expect(noMatchQuery).toBeUndefined();
    });
  });

  // ==========================================================================
  // Option C Proposal Validation Tests
  // ==========================================================================
  describe("ProposalValidator Failed Anchor Check", () => {
    it("rejects edit_file proposal with REPEATED_FAILED_ANCHOR_DISALLOWED when anchor previously failed", () => {
      const validator = new ProposalValidator({
        coordinator,
        stateStore: store,
        toolRegistry: defaultGovernedToolRegistry,
        clock,
      });

      const tracker = new FailedAnchorTracker();
      tracker.recordFailure("src/target.ts", "def defective_function():", "MISSING", 1);

      const task = coordinator.createTask({
        title: "Test Task",
        description: "Testing failed anchor rejection",
        inputPayload: {},
      });

      const contract = createAndActivateContract(store, task.taskId, {
        policy: createExecutionPolicy({
          policyId: `policy-${task.taskId}`,
          governedBenchmarkRepairMode: true,
          allowWholeFileReplacement: false,
          isolationRequirement: "ISOLATED",
          allowedCapabilities: [
            "workspace.file.read",
            "workspace.file.write",
            "process.execute",
            "system.inspect",
          ],
        }),
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);
      const claimResult = coordinator.claimRun(run.runId, workerId, 60000);
      coordinator.startRun(run.runId, workerId, claimResult.lease.leaseId);
      const activeRun = store.getRun(run.runId)!;

      const dummyHash = "a".repeat(64);
      const proposal: ActionProposal = {
        proposalId: "prop-1",
        toolName: "edit_file",
        contextSnapshotHash: dummyHash,
        inputPayload: {
          path: "src/target.ts",
          searchAnchor: "def defective_function():",
          replacementText: "def repaired_function():",
        },
        rationale: "Fix function definition",
      };

      const result = validator.validate(proposal, {
        runId: activeRun.runId,
        contextSnapshot: {
          snapshotId: "snap-1",
          runId: activeRun.runId,
          taskId: task.taskId,
          createdAt: clock.nowIso(),
          observations: [],
          totalEstimatedTokens: 0,
          totalBytes: 0,
          contextHash: dummyHash,
        },
        run: activeRun,
        contract,
        workspaceHostPath: tempDir,
        failedAnchorChecker: (p, a) => tracker.isFailedAnchor(p, a),
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe("REPEATED_FAILED_ANCHOR_DISALLOWED");
      expect(result.message).toContain("has already failed in 'src/target.ts'");

      const guidance = deriveActionableValidationGuidance({
        toolName: "edit_file",
        rejectionReason: result.reason,
        inputPayload: proposal.inputPayload,
      });
      expect(guidance).toContain("Re-read the target file with 'read_file'");
    });
  });

  // ==========================================================================
  // Option B End-to-End Tests: Grounded Verification Context Snapshot
  // ==========================================================================
  describe("Option B: Source-grounded verification context snapshot", () => {
    class MockExecutionProvider implements ExecutionProvider {
      public readonly name = "mock-provider";
      public execCount = 0;
      public f2pExitCode = 1;
      public stdout = "AssertionError: 7 !== 5";
      public stderr = "Test failed at test.ts:12";

      async execute<TInput = unknown, TOutput = unknown>(
        request: ExecutionRequest<TInput>
      ): Promise<ExecutionResult<TOutput>> {
        this.execCount++;
        return {
          status: "SUCCESS",
          output: {
            exitCode: this.f2pExitCode,
            stdout: this.stdout,
            stderr: this.stderr,
          } as unknown as TOutput,
          durationMs: 10,
        };
      }
    }

    it("attaches bounded source snapshot when mutation triggers intermediate test failure", async () => {
      const mockExec = new MockExecutionProvider();
      const workerRuntime = new WorkerRuntime({
        workerId,
        coordinator,
        stateStore: store,
        workspacePort: workspaceAdapter,
        executionProvider: mockExec,
        clock,
      });

      const targetRelPath = "src/math.ts";
      const fullTargetFilePath = path.join(tempDir, targetRelPath);
      fs.mkdirSync(path.dirname(fullTargetFilePath), { recursive: true });
      fs.writeFileSync(
        fullTargetFilePath,
        "export function add(a: number, b: number): number {\n  return a + b + 2;\n}\n",
        "utf-8"
      );

      const task = coordinator.createTask({
        title: "Test Task",
        description: "Testing Option B snapshot",
        inputPayload: {},
      });

      const contract = createAndActivateContract(store, task.taskId, {
        policy: createExecutionPolicy({
          policyId: `policy-${task.taskId}`,
          governedBenchmarkRepairMode: true,
          allowWholeFileReplacement: true,
          isolationRequirement: "ISOLATED",
          allowedCapabilities: [
            "workspace.file.read",
            "workspace.file.write",
            "process.execute",
            "system.inspect",
          ],
        }),
        verificationSpecs: [
          {
            specId: "clean-room-gate",
            ruleKind: "CLEAN_ROOM_DUAL_GATE",
            expectedValue: {
              specId: "clean-room-gate",
              failToPass: {
                testCommand: ["npm", "test"],
                expectedPatchedExitCode: 0,
              },
              passToPass: {
                testCommand: ["npm", "test", "regression"],
                expectedPatchedExitCode: 0,
              },
              timeoutMs: 5000,
            },
          },
        ],
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);
      const claimResult = coordinator.claimRun(run.runId, workerId, 60000);
      coordinator.startRun(run.runId, workerId, claimResult.lease.leaseId);

      await workspaceAdapter.provisionWorkspace({
        workspaceId: "ws-1",
        runId: run.runId,
        taskId: task.taskId,
        maxWorkspaceBytes: 50 * 1024 * 1024,
        maxFileSizeBytes: 10 * 1024 * 1024,
      });

      let stepNum = 0;
      let capturedObservation: any = null;

      const mockBrain: AgentBrainPort = {
        async proposeAction(req: AgentBrainRequest): Promise<AgentBrainResult> {
          stepNum++;
          if (stepNum === 1) {
            return {
              proposal: {
                proposalId: "p1",
                toolName: "write_file",
                contextSnapshotHash: req.contextSnapshot.contextHash,
                inputPayload: {
                  path: targetRelPath,
                  content: "export function add(a: number, b: number): number {\n  return a + b + 2;\n}\n",
                },
                rationale: "Apply buggy patch",
              },
            };
          } else {
            capturedObservation = req.contextSnapshot.observations.find((o) => o.category === "VERIFICATION");
            return {
              isGoalReached: true,
            };
          }
        },
      };

      const controller = new AgentStepController({
        coordinator,
        stateStore: store,
        workerRuntime,
        agentBrain: mockBrain,
        clock,
        defaultBudget: {
          maxSteps: 3,
          enableIntermediateTestFeedback: true,
        },
      });

      await controller.runStepLoop({
        runId: run.runId,
        workerId,
        leaseId: claimResult.lease.leaseId,
        workspace: {
          workspaceId: "ws-1",
          hostPath: tempDir,
        },
      });

      expect(capturedObservation).toBeDefined();
      expect(capturedObservation.content.classification).toBe("FAIL");
      expect(capturedObservation.content.currentSourceContext).toBeDefined();
      expect(capturedObservation.content.currentSourceContext).toContain("return a + b + 2;");
      expect(capturedObservation.content.sourceReadError).toBeUndefined();
    });

    it("truncates source context snapshot exceeding 2,048 bytes with explicit truncation marker", async () => {
      const mockExec = new MockExecutionProvider();
      const workerRuntime = new WorkerRuntime({
        workerId,
        coordinator,
        stateStore: store,
        workspacePort: workspaceAdapter,
        executionProvider: mockExec,
        clock,
      });

      const targetRelPath = "src/large.ts";
      const fullTargetFilePath = path.join(tempDir, targetRelPath);
      fs.mkdirSync(path.dirname(fullTargetFilePath), { recursive: true });
      // Create a 4 KB source file
      const largeContent = "// Header comment\n" + "console.log('line');\n".repeat(200);
      fs.writeFileSync(fullTargetFilePath, largeContent, "utf-8");

      const task = coordinator.createTask({
        title: "Test Task Large",
        description: "Testing Option B large file truncation",
        inputPayload: {},
      });

      const contract = createAndActivateContract(store, task.taskId, {
        policy: createExecutionPolicy({
          policyId: `policy-${task.taskId}`,
          governedBenchmarkRepairMode: true,
          allowWholeFileReplacement: true,
          isolationRequirement: "ISOLATED",
          allowedCapabilities: [
            "workspace.file.read",
            "workspace.file.write",
            "process.execute",
            "system.inspect",
          ],
        }),
        verificationSpecs: [
          {
            specId: "clean-room-gate",
            ruleKind: "CLEAN_ROOM_DUAL_GATE",
            expectedValue: {
              specId: "clean-room-gate",
              failToPass: {
                testCommand: ["npm", "test"],
                expectedPatchedExitCode: 0,
              },
              passToPass: {
                testCommand: ["npm", "test", "regression"],
                expectedPatchedExitCode: 0,
              },
              timeoutMs: 5000,
            },
          },
        ],
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);
      const claimResult = coordinator.claimRun(run.runId, workerId, 60000);
      coordinator.startRun(run.runId, workerId, claimResult.lease.leaseId);

      await workspaceAdapter.provisionWorkspace({
        workspaceId: "ws-1",
        runId: run.runId,
        taskId: task.taskId,
        maxWorkspaceBytes: 50 * 1024 * 1024,
        maxFileSizeBytes: 10 * 1024 * 1024,
      });

      let stepNum = 0;
      let capturedObservation: any = null;

      const mockBrain: AgentBrainPort = {
        async proposeAction(req: AgentBrainRequest): Promise<AgentBrainResult> {
          stepNum++;
          if (stepNum === 1) {
            return {
              proposal: {
                proposalId: "p1",
                toolName: "write_file",
                contextSnapshotHash: req.contextSnapshot.contextHash,
                inputPayload: {
                  path: targetRelPath,
                  content: largeContent,
                },
                rationale: "Write large content",
              },
            };
          } else {
            capturedObservation = req.contextSnapshot.observations.find((o) => o.category === "VERIFICATION");
            return {
              isGoalReached: true,
            };
          }
        },
      };

      const controller = new AgentStepController({
        coordinator,
        stateStore: store,
        workerRuntime,
        agentBrain: mockBrain,
        clock,
        defaultBudget: {
          maxSteps: 3,
          enableIntermediateTestFeedback: true,
        },
      });

      await controller.runStepLoop({
        runId: run.runId,
        workerId,
        leaseId: claimResult.lease.leaseId,
        workspace: {
          workspaceId: "ws-1",
          hostPath: tempDir,
        },
      });

      expect(capturedObservation).toBeDefined();
      const sourceSnapshot = capturedObservation.content.currentSourceContext as string;
      expect(sourceSnapshot).toBeDefined();
      expect(sourceSnapshot.endsWith("\n... [TRUNCATED]")).toBe(true);
      expect(Buffer.byteLength(sourceSnapshot, "utf-8")).toBeLessThanOrEqual(2048);
    });
  });

  // ==========================================================================
  // Option C & D End-to-End Tests: Failed Anchor Guard & Search Zero-Match
  // ==========================================================================
  describe("Option C & Option D End-to-End Loop Integration", () => {
    it("tracks anchor execution failure, blocks repeated proposal, and clears upon read_file", async () => {
      const targetRelPath = "src/calculator.ts";

      const workerRuntime = new WorkerRuntime({
        workerId,
        coordinator,
        stateStore: store,
        workspacePort: workspaceAdapter,
        clock,
      });

      const task = coordinator.createTask({
        title: "Test Task Anchor Guard",
        description: "Testing Option C and D loop",
        inputPayload: {},
      });

      const contract = createAndActivateContract(store, task.taskId, {
        policy: createExecutionPolicy({
          policyId: `policy-${task.taskId}`,
          governedBenchmarkRepairMode: true,
          allowWholeFileReplacement: false,
          isolationRequirement: "ISOLATED",
          allowedCapabilities: [
            "workspace.file.read",
            "workspace.file.write",
            "workspace.code.search",
            "process.execute",
            "system.inspect",
          ],
        }),
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);
      const claimResult = coordinator.claimRun(run.runId, workerId, 60000);
      coordinator.startRun(run.runId, workerId, claimResult.lease.leaseId);

      const wsHandle = await workspaceAdapter.provisionWorkspace({
        workspaceId: "ws-1",
        runId: run.runId,
        taskId: task.taskId,
        maxWorkspaceBytes: 50 * 1024 * 1024,
        maxFileSizeBytes: 10 * 1024 * 1024,
      });

      const fullTargetFilePath = path.join(wsHandle.hostPath, targetRelPath);
      fs.mkdirSync(path.dirname(fullTargetFilePath), { recursive: true });
      fs.writeFileSync(fullTargetFilePath, "export function calc() { return 1; }\n", "utf-8");

      let stepNum = 0;
      const observedStepFeedback: any[] = [];

      const mockBrain: AgentBrainPort = {
        async proposeAction(req: AgentBrainRequest): Promise<AgentBrainResult> {
          stepNum++;
          observedStepFeedback.push(req.contextSnapshot.observations);

          if (stepNum === 1) {
            // Propose edit_file with non-existent anchor (fails execution)
            return {
              proposal: {
                proposalId: "p1",
                toolName: "edit_file",
                contextSnapshotHash: req.contextSnapshot.contextHash,
                inputPayload: {
                  path: targetRelPath,
                  searchAnchor: "const nonexistent = 999;",
                  replacementText: "const repaired = 1;",
                },
                rationale: "Attempt edit with bad anchor",
              },
            };
          } else if (stepNum === 2) {
            // Propose exact same anchor again -> should be rejected by ProposalValidator pre-execution
            return {
              proposal: {
                proposalId: "p2",
                toolName: "edit_file",
                contextSnapshotHash: req.contextSnapshot.contextHash,
                inputPayload: {
                  path: targetRelPath,
                  searchAnchor: "const nonexistent = 999;",
                  replacementText: "const repaired = 2;",
                },
                rationale: "Repeat bad anchor",
              },
            };
          } else if (stepNum === 3) {
            // Propose search_code for the failed anchor -> should trigger Option D advisory
            return {
              proposal: {
                proposalId: "p3",
                toolName: "search_code",
                contextSnapshotHash: req.contextSnapshot.contextHash,
                inputPayload: {
                  query: "const nonexistent = 999;",
                  path: targetRelPath,
                },
                rationale: "Search for anchor",
              },
            };
          } else if (stepNum === 4) {
            // Re-read the file -> should clear failed-anchor tracker for targetRelPath
            return {
              proposal: {
                proposalId: "p4",
                toolName: "read_file",
                contextSnapshotHash: req.contextSnapshot.contextHash,
                inputPayload: {
                  path: targetRelPath,
                },
                rationale: "Re-read file to recover",
              },
            };
          } else {
            return {
              isGoalReached: true,
            };
          }
        },
      };

      const controller = new AgentStepController({
        coordinator,
        stateStore: store,
        workerRuntime,
        agentBrain: mockBrain,
        clock,
        defaultBudget: {
          maxSteps: 6,
          maxProposalRejections: 5,
          maxConsecutiveFailures: 5,
        },
      });

      const loopResult = await controller.runStepLoop({
        runId: run.runId,
        workerId,
        leaseId: claimResult.lease.leaseId,
        workspace: wsHandle,
      });

      // Verify Step 1 resulted in execution failure and tracker recorded failure, then step 4 cleared it
      expect(controller.getFailedAnchorTracker().isFailedAnchor(targetRelPath, "const nonexistent = 999;")).toBe(false);

      const transcript = loopResult.transcript;
      expect(transcript.length).toBeGreaterThanOrEqual(4);

      // Step 2 transcript entry was proposal rejection: REPEATED_FAILED_ANCHOR_DISALLOWED
      const step2Transcript = transcript[1];
      expect(step2Transcript?.proposalValid).toBe(false);
      expect(step2Transcript?.proposalRejectionReason).toBe("REPEATED_FAILED_ANCHOR_DISALLOWED");

      // Step 4 had the Option D zero-match advisory in context observations
      const step4Observations = observedStepFeedback[3];
      const zeroMatchAdvisory = step4Observations?.find(
        (o: any) => o.content?.advisoryKind === "ZERO_MATCH_FAILED_ANCHOR_SEARCH"
      );
      expect(zeroMatchAdvisory).toBeDefined();
      expect(zeroMatchAdvisory.content.query).toBe("const nonexistent = 999;");
      expect(zeroMatchAdvisory.content.guidance).toContain("Stop retrying this anchor");
    });
  });
});
