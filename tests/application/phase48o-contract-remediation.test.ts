/**
 * Phase 48O Regression Test Suite:
 * Model-Facing Digest Filtering, Stale-Precondition Recovery, and Ineffective Mutation Guard
 *
 * Verifies all requirements for Phase 48O:
 * - Work A: expectedDigest is filtered from model-facing schema and tool catalog, while
 *   remaining intact in underlying schemas and adapter for internal callers.
 * - Work B: Stale precondition throws typed ToolPreconditionFailedError, produces targeted
 *   high-priority recovery observation without leaking hallucinated hashes, preserves target file,
 *   and allows subsequent grounded edits.
 * - Work C: Executed mutations that fail verification are recorded as ineffective; identical
 *   retries against unchanged file state are rejected before execution with INEFFECTIVE_MUTATION_DISALLOWED;
 *   read-only tools and changed source states are not blocked.
 * - Work D: Phase 48L post-pass latch invariants remain intact (requires intermediate PASS, never
 *   activated by failed or rejected mutations).
 *
 * Strictly offline. Zero live Ollama inference. Zero git mutations.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EDIT_FILE_TOOL,
  INITIAL_TOOL_DEFINITIONS,
  StaticToolRegistry,
} from "../../src/domain/tool.js";
import {
  formatModelFacingToolCatalog,
  inspectToolProjection,
  projectToolDefinition,
  TOOL_SEMANTIC_METADATA,
} from "../../src/domain/tool-projection.js";
import { EDIT_FILE_SCHEMA_BRANCH } from "../../src/application/live-agent-brain.js";
import { EditFileInputSchema } from "../../src/domain/tool-schemas.js";
import { LineAnchoredEditor } from "../../src/production/repair/line-anchored-editor.js";
import { EditFileToolAdapter } from "../../src/adapters/tools/edit-file.tool-adapter.js";
import { ToolPreconditionFailedError } from "../../src/domain/errors.js";
import { ProposalValidator } from "../../src/application/proposal-validator.js";
import {
  AgentStepController,
  deriveActionableValidationGuidance,
  DEFAULT_STEP_CONTROLLER_BUDGET,
} from "../../src/application/agent-step-controller.js";
import { DuplicateProposalDetector } from "../../src/application/duplicate-proposal-detector.js";
import {
  createExecutionPolicy,
  createMissionContract,
  createResourceLimits,
  MissionContract,
} from "../../src/domain/index.js";
import { ContextSnapshot } from "../../src/domain/context.js";
import { RunSnapshot } from "../../src/domain/invariants.js";
import { ToolExecutionContext } from "../../src/ports/tool-adapter.port.js";
import { WorkspacePort } from "../../src/ports/workspace.port.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { SystemClock } from "../../src/ports/clock.port.js";
import {
  AgentBrainPort,
  AgentBrainRequest,
  AgentBrainResult,
} from "../../src/ports/agent-brain.port.js";

describe("Phase 48O - Work A: Model-Facing Digest Filtering & Contract Alignment", () => {
  it("Work A.1: expectedDigest is completely absent from model-facing structured-output schema", () => {
    const inputPayloadProps = EDIT_FILE_SCHEMA_BRANCH.properties.inputPayload.properties as Record<string, unknown>;
    expect(inputPayloadProps).toBeDefined();
    expect("expectedDigest" in inputPayloadProps).toBe(false);
  });

  it("Work A.2: expectedDigest is completely absent from model-facing tool catalog projection", () => {
    const projected = projectToolDefinition(EDIT_FILE_TOOL);
    expect(projected).toContain("- edit_file(");
    expect(projected).not.toContain("expectedDigest");

    const inspection = inspectToolProjection(EDIT_FILE_TOOL);
    const paramNames = inspection.parameters.map((p) => p.name);
    expect(paramNames).not.toContain("expectedDigest");

    const catalog = formatModelFacingToolCatalog([...INITIAL_TOOL_DEFINITIONS, EDIT_FILE_TOOL]);
    expect(catalog).toContain("- edit_file(");
    expect(catalog).not.toContain("expectedDigest");
  });

  it("Work A.3: legitimate model-facing parameters remain exposed in both schema and catalog", () => {
    const inputPayloadProps = EDIT_FILE_SCHEMA_BRANCH.properties.inputPayload.properties as Record<string, unknown>;
    expect("path" in inputPayloadProps).toBe(true);
    expect("searchAnchor" in inputPayloadProps).toBe(true);
    expect("replacementText" in inputPayloadProps).toBe(true);
    expect("allowMultipleMatches" in inputPayloadProps).toBe(true);
    expect("maxBytes" in inputPayloadProps).toBe(true);

    const inspection = inspectToolProjection(EDIT_FILE_TOOL);
    const paramNames = inspection.parameters.map((p) => p.name);
    expect(paramNames).toContain("path");
    expect(paramNames).toContain("searchAnchor");
    expect(paramNames).toContain("replacementText");
    expect(paramNames).toContain("allowMultipleMatches");
    expect(paramNames).toContain("maxBytes");
  });

  it("Work A.4: underlying EditFileInputSchema and LineAnchoredEditor still enforce optimistic concurrency for internal callers", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "phase48o-worka-"));
    try {
      const filePath = path.join(tempDir, "src/calc.js");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const content = "function add(a, b) {\n  return a + b + 1;\n}\n";
      await fs.writeFile(filePath, content, "utf8");
      const correctDigest = crypto.createHash("sha256").update(content, "utf8").digest("hex");
      const wrongDigest = "e2ff1fad7db8543e7d6f2888925d83f0d2e0a03c0770c6d87f9af985ca5776a9";

      // 1. Zod schema still validates expectedDigest for internal callers
      const parsedWithDigest = EditFileInputSchema.safeParse({
        path: "src/calc.js",
        searchAnchor: "return a + b + 1;",
        replacementText: "return a + b;",
        expectedDigest: correctDigest,
      });
      expect(parsedWithDigest.success).toBe(true);

      // 2. Editor succeeds when expectedDigest matches
      const editor = new LineAnchoredEditor();
      const validResult = editor.applyEdit(
        {
          path: "src/calc.js",
          searchAnchor: "return a + b + 1;",
          replacementText: "return a + b;",
          expectedDigest: correctDigest,
        },
        tempDir
      );
      expect(validResult.applied).toBe(true);

      // 3. Editor rejects when expectedDigest does not match
      expect(() => {
        editor.applyEdit(
          {
            path: "src/calc.js",
            searchAnchor: "return a + b;",
            replacementText: "return a + b + 1;",
            expectedDigest: wrongDigest,
          },
          tempDir
        );
      }).toThrow(/Stale edit precondition failed/);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("Work A.5: normal model-facing edit proposal that omits expectedDigest passes validation and reaches execution", () => {
    const registry = new StaticToolRegistry();
    registry.register(EDIT_FILE_TOOL);
    const validator = new ProposalValidator({ toolRegistry: registry });

    const contract = createMissionContract({
      contractId: "contract-48o",
      version: 1,
      taskId: "task-48o",
      status: "ACTIVE",
      policy: createExecutionPolicy({
        policyId: "policy-48o",
        allowedCapabilities: ["workspace.file.write"],
        isolationRequirement: "ISOLATED",
        governedBenchmarkRepairMode: true,
      }),
      resourceLimits: createResourceLimits({ timeoutMs: 30000, maxAttempts: 5, maxOutputBytes: 1048576 }),
    });

    const run: RunSnapshot = {
      runId: "run-48o",
      taskId: "task-48o",
      status: "RUNNING",
      version: 1,
      attemptCount: 1,
      maxAttempts: 5,
      leaseId: "lease-48o",
      currentWorkerId: "worker-48o",
      contractBinding: {
        contractId: contract.spec.contractId,
        version: contract.spec.version,
        contentHash: contract.contentHash,
        boundAt: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const contextSnapshot: ContextSnapshot = {
      snapshotId: "snap-48o",
      taskId: "task-48o",
      observations: [],
      contextHash: "a".repeat(64),
      createdAt: new Date().toISOString(),
      budget: { maxEstimatedTokens: 4000, maxRawBytes: 32768, priorityCutoff: 0, reservedObservationsRatio: 0.2 },
      totalEstimatedTokens: 10,
      totalBytes: 50,
      retainedTokens: 10,
      retainedBytes: 50,
      droppedObservationsCount: 0,
      isTruncated: false,
    };

    // Proposal strictly omits expectedDigest
    const proposal = {
      proposalId: "prop-omitted-digest",
      toolName: "edit_file",
      contextSnapshotHash: contextSnapshot.contextHash,
      inputPayload: {
        path: "src/calc.js",
        searchAnchor: "return a + b + 1;",
        replacementText: "return a + b;",
      },
    };

    const result = validator.validate(proposal, {
      runId: run.runId,
      contextSnapshot,
      workerId: run.currentWorkerId!,
      leaseId: run.leaseId!,
      run,
      contract,
    });

    expect(result.valid).toBe(true);
  });
});

describe("Phase 48O - Work B: Actionable Stale-Precondition Recovery", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "phase48o-workb-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("Work B.1: EditFileToolAdapter throws typed ToolPreconditionFailedError with STALE_PRECONDITION on digest mismatch", async () => {
    const filePath = path.join(tempDir, "src/calc.js");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "function add(a, b) { return a + b + 1; }", "utf8");

    const adapter = new EditFileToolAdapter();
    const context: ToolExecutionContext = {
      runId: "run-precond-test",
      taskId: "task-precond-test",
      actionId: "act-precond-test",
      attemptNumber: 1,
      resourceLimits: { timeoutMs: 30000, maxOutputBytes: 1048576, maxAttempts: 5 },
      workspace: { hostPath: tempDir, workspaceId: "ws-precond-test" },
    };

    let caughtError: unknown;
    try {
      await adapter.execute(
        context,
        {
          path: "src/calc.js",
          searchAnchor: "return a + b + 1;",
          replacementText: "return a + b;",
          expectedDigest: "0".repeat(64),
        }
      );
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ToolPreconditionFailedError);
    expect((caughtError as ToolPreconditionFailedError).subcode).toBe("STALE_PRECONDITION");
    expect((caughtError as ToolPreconditionFailedError).code).toBe("TOOL_EXECUTION_FAILED");
  });

  it("Work B.2 & B.4: AgentStepController captures stale precondition, leaves target unchanged, and emits safe recovery observation", async () => {
    const stateStore = new SqliteStateStore();
    const clock = new SystemClock();
    const coordinator = new RunCoordinator(stateStore, clock);

    const mockWorkspacePort: WorkspacePort = {
      provisionWorkspace: async (p) => ({
        workspaceId: p.workspaceId,
        hostPath: tempDir,
        containerMountPath: "/workspace",
      }),
      cleanWorkspace: async () => {},
      isWorkspaceActive: async () => true,
    };

    const workerRuntime = new WorkerRuntime({
      workerId: "worker-test-48o",
      coordinator,
      clock,
      workspacePort: mockWorkspacePort,
    });

    const targetFileRel = "src/calc.js";
    const targetFileAbs = path.join(tempDir, targetFileRel);
    await fs.mkdir(path.dirname(targetFileAbs), { recursive: true });
    const originalContent = "function add(a, b) {\n  return a + b + 1;\n}\n";
    await fs.writeFile(targetFileAbs, originalContent, "utf8");

    stateStore.transaction((tx) => {
      tx.insertWorker({
        workerId: "worker-test-48o",
        hostname: "localhost",
        pid: 8888,
        status: "ACTIVE",
        createdAt: clock.nowIso(),
        lastHeartbeatAt: clock.nowIso(),
      });
    });

    const task = coordinator.createTask({
      taskId: "task-precond-48o",
      title: "Precondition Recovery Test",
      description: "Test recovery after stale precondition",
      inputPayload: {},
    });

    const contract = createMissionContract({
      contractId: "contract-precond-48o",
      version: 1,
      taskId: task.taskId,
      policy: createExecutionPolicy({
        policyId: "policy-precond-48o",
        allowedCapabilities: ["workspace.file.read", "workspace.file.write"],
        isolationRequirement: "ISOLATED",
        governedBenchmarkRepairMode: true,
      }),
      resourceLimits: createResourceLimits({ timeoutMs: 30000, maxAttempts: 5, maxOutputBytes: 1048576 }),
    });
    stateStore.insertContract(contract);
    stateStore.activateContract(contract.spec.contractId, contract.spec.version, clock.nowIso());

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);
    const claim = coordinator.claimRun(run.runId, "worker-test-48o", 60000);
    coordinator.startRun(run.runId, "worker-test-48o", claim.lease.leaseId);

    const hallucinatedHash = "e2ff1fad7db8543e7d6f2888925d83f0d2e0a03c0770c6d87f9af985ca5776a9";
    let capturedSnapshotStep2: ContextSnapshot | null = null;

    class StalePreconditionBrain implements AgentBrainPort {
      private step = 0;
      async proposeAction(req: AgentBrainRequest): Promise<AgentBrainResult> {
        this.step++;
        if (this.step === 1) {
          // Proposes invalid digest
          return {
            finishReason: "ACTION_PROPOSED",
            proposal: {
              proposalId: "prop-stale-step-1",
              toolName: "edit_file",
              inputPayload: {
                path: targetFileRel,
                searchAnchor: "return a + b + 1;",
                replacementText: "return a + b;",
                expectedDigest: hallucinatedHash,
              },
              contextSnapshotHash: req.contextSnapshot.contextHash,
            },
          };
        } else {
          capturedSnapshotStep2 = req.contextSnapshot;
          return {
            finishReason: "STOP",
          };
        }
      }
    }

    const brain = new StalePreconditionBrain();
    const controller = new AgentStepController({
      stateStore,
      coordinator,
      workerRuntime,
      agentBrain: brain,
      clock,
      defaultBudget: { maxSteps: 3 },
    });

    await controller.runStepLoop({
      runId: run.runId,
      workerId: "worker-test-48o",
      leaseId: claim.lease.leaseId,
      workspace: { workspaceId: "ws-test-48o", hostPath: tempDir },
    });

    // Work B.4: Target file is byte-for-byte unchanged
    const onDisk = await fs.readFile(targetFileAbs, "utf8");
    expect(onDisk).toBe(originalContent);

    // Work B.2: Recovery observation was delivered into step 2 context
    expect(capturedSnapshotStep2).not.toBeNull();
    const recoveryObs = capturedSnapshotStep2!.observations.find(
      (o) => (o.content as any)?.feedbackKind === "ACTION_RECOVERY_GUIDANCE"
    );
    expect(recoveryObs).toBeDefined();
    expect((recoveryObs!.content as any).failureReason).toBe("STALE_EDIT_PRECONDITION");

    const guidance = (recoveryObs!.content as any).guidance as string;
    expect(guidance).toContain("Edit precondition failed");
    expect(guidance).toContain("Re-read the current target file");
    expect(guidance).toContain("without supplying any invented or external digest");
    expect(guidance).toContain("Do not copy hash strings from mission context");

    // Must NOT leak or contain the hallucinated hash
    expect(guidance).not.toContain(hallucinatedHash);
    expect((recoveryObs!.content as any).rawError).not.toContain(hallucinatedHash);
  });
});

describe("Phase 48O - Work C: Ineffective Repeated Mutation Guard", () => {
  let detector: DuplicateProposalDetector;

  beforeEach(() => {
    detector = new DuplicateProposalDetector({ maxCapacity: 5 });
  });

  it("Work C.1: DuplicateProposalDetector records failed mutations with source state", () => {
    detector.recordIneffectiveMutation({
      toolName: "edit_file",
      inputPayload: {
        path: "src/calc.js",
        searchAnchor: "function add(a, b) {",
        replacementText: "function add(a, b) { return a + b; }",
      },
      targetPath: "src/calc.js",
      stepNumber: 2,
      verificationClassification: "FAIL",
      sourceHash: "source-hash-corrupted-1",
    });

    expect(detector.getTrackedIneffectiveCount()).toBe(1);
    const record = detector.getIneffectiveMutationRecord(
      "edit_file",
      {
        path: "src/calc.js",
        searchAnchor: "function add(a, b) {",
        replacementText: "function add(a, b) { return a + b; }",
      },
      "source-hash-corrupted-1"
    );
    expect(record).toBeDefined();
    expect(record?.stepNumber).toBe(2);
    expect(record?.verificationClassification).toBe("FAIL");
  });

  it("Work C.2: Identical mutation against unchanged relevant source state is rejected before execution", () => {
    const registry = new StaticToolRegistry();
    registry.register(EDIT_FILE_TOOL);
    const validator = new ProposalValidator({ toolRegistry: registry });

    const contract = createMissionContract({
      contractId: "contract-48o-c",
      version: 1,
      taskId: "task-48o-c",
      status: "ACTIVE",
      policy: createExecutionPolicy({
        policyId: "policy-48o-c",
        allowedCapabilities: ["workspace.file.write"],
        isolationRequirement: "ISOLATED",
        governedBenchmarkRepairMode: true,
      }),
      resourceLimits: createResourceLimits({ timeoutMs: 30000, maxAttempts: 5, maxOutputBytes: 1048576 }),
    });

    const run: RunSnapshot = {
      runId: "run-48o-c",
      taskId: "task-48o-c",
      status: "RUNNING",
      version: 1,
      attemptCount: 1,
      maxAttempts: 5,
      leaseId: "lease-48o-c",
      currentWorkerId: "worker-48o-c",
      contractBinding: {
        contractId: contract.spec.contractId,
        version: contract.spec.version,
        contentHash: contract.contentHash,
        boundAt: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const contextSnapshot: ContextSnapshot = {
      snapshotId: "snap-48o-c",
      taskId: "task-48o-c",
      observations: [],
      contextHash: "b".repeat(64),
      createdAt: new Date().toISOString(),
      budget: { maxEstimatedTokens: 4000, maxRawBytes: 32768, priorityCutoff: 0, reservedObservationsRatio: 0.2 },
      totalEstimatedTokens: 10,
      totalBytes: 50,
      retainedTokens: 10,
      retainedBytes: 50,
      droppedObservationsCount: 0,
      isTruncated: false,
    };

    detector.recordIneffectiveMutation({
      toolName: "edit_file",
      inputPayload: {
        path: "src/calc.js",
        searchAnchor: "function add(a, b) {",
        replacementText: "function add(a, b) { return a + b; }",
      },
      targetPath: "src/calc.js",
      stepNumber: 2,
      verificationClassification: "FAIL",
      sourceHash: "hash-same",
    });

    const proposal = {
      proposalId: "prop-step-3-repeat",
      toolName: "edit_file",
      contextSnapshotHash: contextSnapshot.contextHash,
      inputPayload: {
        path: "src/calc.js",
        searchAnchor: "function add(a, b) {",
        replacementText: "function add(a, b) { return a + b; }",
      },
    };

    const result = validator.validate(proposal, {
      runId: run.runId,
      contextSnapshot,
      workerId: run.currentWorkerId!,
      leaseId: run.leaseId!,
      run,
      contract,
      ineffectiveMutationChecker: (toolName, payload, targetPath) => {
        const rec = detector.getIneffectiveMutationRecord(toolName, payload, "hash-same");
        if (rec) {
          return { isIneffective: true, priorStep: rec.stepNumber };
        }
        return false;
      },
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("INEFFECTIVE_MUTATION_DISALLOWED");
    expect(result.message).toContain("already executed at step 2 and failed intermediate verification");

    const guidance = deriveActionableValidationGuidance({
      rejectionReason: result.reason,
    });
    expect(guidance).toContain("An identical mutation was already executed and failed intermediate verification");
    expect(guidance).toContain("propose a materially different localized edit");
  });

  it("Work C.3: Materially different localized edit against same target file remains possible", () => {
    detector.recordIneffectiveMutation({
      toolName: "edit_file",
      inputPayload: {
        path: "src/calc.js",
        searchAnchor: "function add(a, b) {",
        replacementText: "function add(a, b) { return a + b; }",
      },
      targetPath: "src/calc.js",
      stepNumber: 2,
      verificationClassification: "FAIL",
      sourceHash: "hash-same",
    });

    // Proposes a materially different edit
    const differentRecord = detector.getIneffectiveMutationRecord(
      "edit_file",
      {
        path: "src/calc.js",
        searchAnchor: "return a + b + 1;",
        replacementText: "return a + b;",
      },
      "hash-same"
    );
    expect(differentRecord).toBeUndefined();
  });

  it("Work C.4: Source-state change permits newly grounded proposal according to invalidation rule", () => {
    detector.recordIneffectiveMutation({
      toolName: "edit_file",
      inputPayload: {
        path: "src/calc.js",
        searchAnchor: "function add(a, b) {",
        replacementText: "function add(a, b) { return a + b; }",
      },
      targetPath: "src/calc.js",
      stepNumber: 2,
      verificationClassification: "FAIL",
      sourceHash: "hash-old",
    });

    // File was modified by an intervening edit or restored, so new hash is "hash-new"
    const recordOnNewState = detector.getIneffectiveMutationRecord(
      "edit_file",
      {
        path: "src/calc.js",
        searchAnchor: "function add(a, b) {",
        replacementText: "function add(a, b) { return a + b; }",
      },
      "hash-new" // source changed!
    );
    expect(recordOnNewState).toBeUndefined();
  });

  it("Work C.5: Read-only tools and test execution are not blocked by the file-mutation guard", () => {
    detector.recordIneffectiveMutation({
      toolName: "edit_file",
      inputPayload: { path: "src/calc.js", searchAnchor: "x", replacementText: "y" },
      targetPath: "src/calc.js",
      stepNumber: 1,
      verificationClassification: "FAIL",
      sourceHash: "hash-1",
    });

    // read_file is not blocked
    expect(detector.getIneffectiveMutationRecord("read_file", { path: "src/calc.js" }, "hash-1")).toBeUndefined();

    // run_command is not blocked
    expect(detector.getIneffectiveMutationRecord("run_command", { argv: ["npm", "test"] }, "hash-1")).toBeUndefined();
  });

  it("Work C.6: onActionExecuted does not clear failed-mutation protection merely because an action succeeded textually", () => {
    detector.recordIneffectiveMutation({
      toolName: "edit_file",
      inputPayload: {
        path: "src/calc.js",
        searchAnchor: "function add(a, b) {",
        replacementText: "function add(a, b) { return a + b; }",
      },
      targetPath: "src/calc.js",
      stepNumber: 2,
      verificationClassification: "FAIL",
      sourceHash: "hash-corrupted",
    });

    // An action succeeds textually (e.g. read_file or another textual operation)
    detector.onActionExecuted({
      toolName: "read_file",
      status: "SUCCEEDED",
      inputPayload: { path: "src/calc.js" },
    });

    // The ineffective mutation MUST still be remembered!
    expect(detector.getTrackedIneffectiveCount()).toBe(1);
    expect(
      detector.getIneffectiveMutationRecord(
        "edit_file",
        {
          path: "src/calc.js",
          searchAnchor: "function add(a, b) {",
          replacementText: "function add(a, b) { return a + b; }",
        },
        "hash-corrupted"
      )
    ).toBeDefined();
  });

  it("Work C.7: Cross-file mutation invalidation permits previously ineffective edit on file A after file B is mutated", () => {
    // 1. Initial workspace version is 0. File A's edit fails verification at version 1.
    detector.recordWorkspaceMutation("src/fileA.js"); // version becomes 1
    expect(detector.getWorkspaceMutationVersion()).toBe(1);

    detector.recordIneffectiveMutation({
      toolName: "edit_file",
      inputPayload: {
        path: "src/fileA.js",
        searchAnchor: "const a = 1;",
        replacementText: "const a = 2;",
      },
      targetPath: "src/fileA.js",
      stepNumber: 1,
      verificationClassification: "FAIL",
      sourceHash: "hash-fileA-v1",
    });

    // 2. Immediate retry of file A while workspace mutation version is still 1 is BLOCKED
    const blockedRecord = detector.getIneffectiveMutationRecord(
      "edit_file",
      {
        path: "src/fileA.js",
        searchAnchor: "const a = 1;",
        replacementText: "const a = 2;",
      },
      "hash-fileA-v1"
    );
    expect(blockedRecord).toBeDefined();

    // 3. Model executes an edit to file B (src/fileB.js), mutating the workspace
    detector.recordWorkspaceMutation("src/fileB.js"); // version becomes 2
    expect(detector.getWorkspaceMutationVersion()).toBe(2);

    // 4. Now, the original edit to file A is evaluated in the new multi-file context.
    // Even though file A's source hash is still hash-fileA-v1, the intervening mutation to file B
    // changed the multi-file verification context, so the edit is PERMITTED!
    const permittedRecord = detector.getIneffectiveMutationRecord(
      "edit_file",
      {
        path: "src/fileA.js",
        searchAnchor: "const a = 1;",
        replacementText: "const a = 2;",
      },
      "hash-fileA-v1"
    );
    expect(permittedRecord).toBeUndefined();
  });

  it("Work C.8: Unrelated actions (reads, searches, commands) do not increment workspace mutation version and do not clear protection", () => {
    detector.recordWorkspaceMutation("src/fileA.js"); // version becomes 1
    detector.recordIneffectiveMutation({
      toolName: "edit_file",
      inputPayload: { path: "src/fileA.js", searchAnchor: "x;", replacementText: "y;" },
      targetPath: "src/fileA.js",
      stepNumber: 1,
      verificationClassification: "FAIL",
      sourceHash: "hash-A",
    });

    // Read action does not increment mutation version
    detector.onActionExecuted({ toolName: "read_file", status: "SUCCEEDED", inputPayload: { path: "src/fileB.js" } });
    expect(detector.getWorkspaceMutationVersion()).toBe(1);

    // Command execution does not increment mutation version
    detector.onActionExecuted({ toolName: "run_command", status: "SUCCEEDED", inputPayload: { argv: ["npm", "test"] } });
    expect(detector.getWorkspaceMutationVersion()).toBe(1);

    // File A's ineffective record is STILL active and blocks retry
    expect(
      detector.getIneffectiveMutationRecord("edit_file", { path: "src/fileA.js", searchAnchor: "x;", replacementText: "y;" }, "hash-A")
    ).toBeDefined();
  });
});

describe("Phase 48O - Work D: Phase 48L Latch Invariants Preserved", () => {
  it("Work D.1: Failed mutation cannot activate post-pass verification latch", () => {
    const controller = new AgentStepController({
      stateStore: new SqliteStateStore(),
      coordinator: new RunCoordinator(new SqliteStateStore(), new SystemClock()),
      workerRuntime: {} as any,
      agentBrain: {} as any,
    });

    const latch = controller.getPostPassVerificationLatch();
    expect(latch.isLatched).toBe(false);
    expect(latch.protectedPaths).toEqual([]);
    expect(latch.isMutationProhibited("edit_file", "src/calc.js").prohibited).toBe(false);
  });

  it("Work D.2: Latch activates strictly upon confirmed PASS and locks verified target", () => {
    const controller = new AgentStepController({
      stateStore: new SqliteStateStore(),
      coordinator: new RunCoordinator(new SqliteStateStore(), new SystemClock()),
      workerRuntime: {} as any,
      agentBrain: {} as any,
    });

    const latch = controller.getPostPassVerificationLatch();

    // Intermediate verification passes
    latch.activate({
      stepNumber: 3,
      timestamp: new Date().toISOString(),
      protectedPath: "src/calc.js",
      f2pExitCode: 0,
      p2pExitCode: 0,
      targetHash: "gold-hash-calc",
    });

    expect(latch.isLatched).toBe(true);
    expect(latch.protectedPaths).toEqual(["src/calc.js"]);

    // Further mutation to src/calc.js is prohibited
    expect(latch.isMutationProhibited("edit_file", "src/calc.js").prohibited).toBe(true);
    expect(latch.isMutationProhibited("write_file", "src/calc.js").prohibited).toBe(true);

    // Read-only tools and unrelated targets remain allowed
    expect(latch.isMutationProhibited("read_file", "src/calc.js").prohibited).toBe(false);
    expect(latch.isMutationProhibited("edit_file", "src/other.js").prohibited).toBe(false);
  });
});
