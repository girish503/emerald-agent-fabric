/**
 * Phase 48A: Edit-Tool Contract Hardening and Targeted Recovery Feedback
 *
 * Verifies all requirements for Phase 48A:
 * 1. edit_file has explicit model-facing semantic metadata and minimal example.
 * 2. Model projection clarifies literal text matching and warns against line:10 pseudo-selectors.
 * 3. Identical searchAnchor and replacementText are rejected with NOOP_EDIT_DISALLOWED before mutation.
 * 4. Rejection leaves target file byte-for-byte unchanged.
 * 5. deriveActionableValidationGuidance generates actionable explanation for NOOP_EDIT_DISALLOWED.
 * 6. LineAnchoredEditor defense-in-depth rejects identical anchor/replacement fail-closed.
 * 7. Valid localized replacements work as expected.
 * 8. Missing search anchor fails closed and produces recovery observation in AgentStepController.
 * 9. Recovery observation includes the 5 required guidance elements.
 * 10. Workspace containment and fail-closed security invariants remain intact.
 *
 * Zero live Ollama calls. Zero network requests. Zero git mutations.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
import { ProposalValidator } from "../../src/application/proposal-validator.js";
import {
  deriveActionableValidationGuidance,
  AgentStepController,
  DEFAULT_STEP_CONTROLLER_BUDGET,
} from "../../src/application/agent-step-controller.js";
import { LineAnchoredEditor } from "../../src/production/repair/line-anchored-editor.js";
import { EditFileToolAdapter } from "../../src/adapters/tools/edit-file.tool-adapter.js";
import {
  createExecutionPolicy,
  createMissionContract,
  createResourceLimits,
  createVerificationSpec,
  MissionContract,
} from "../../src/domain/index.js";
import { ContextSnapshot, DEFAULT_CONTEXT_BUDGET } from "../../src/domain/context.js";
import { RunSnapshot } from "../../src/domain/invariants.js";
import { ToolExecutionContext } from "../../src/ports/tool-adapter.port.js";
import { WorkspacePort } from "../../src/ports/workspace.port.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { SystemClock } from "../../src/ports/clock.port.js";
import { AgentBrainPort, AgentBrainRequest, AgentBrainResult } from "../../src/ports/agent-brain.port.js";

describe("Phase 48A: Edit-Tool Contract Hardening & Recovery Feedback", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "phase48a-test-"));
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  // --------------------------------------------------------------------------
  // Criterion 1 & 2: Semantic Metadata and Model-Facing Projection
  // --------------------------------------------------------------------------
  it("Criterion 1: edit_file has explicit semantic metadata matching established conventions", () => {
    const meta = TOOL_SEMANTIC_METADATA["edit_file"];
    expect(meta).toBeDefined();
    expect(meta.summary).toContain("literal text segment");
    expect(meta.summary).toContain("smallest relevant code fragment");
    expect(meta.summary).toContain("read_file");

    // Minimal example grounded in EAF-BM-01
    expect(meta.minimalExample).toEqual({
      path: "src/calc.js",
      searchAnchor: "return a + b + 1;",
      replacementText: "return a + b;",
    });

    // Warning against line:10 pseudo-selectors
    expect(meta.invalidFieldWarning).toContain('NOT line numbers like "line:10"');
    expect(meta.invalidFieldWarning).toContain("searchAnchor and replacementText must be different");
  });

  it("Criterion 2: projectToolDefinition(EDIT_FILE_TOOL) outputs formatted projection with warning and example", () => {
    const projected = projectToolDefinition(EDIT_FILE_TOOL);
    expect(projected).toContain("- edit_file(");
    expect(projected).toContain('Example: {"path":"src/calc.js","replacementText":"return a + b;","searchAnchor":"return a + b + 1;"}');
    expect(projected).toContain('Warning: searchAnchor must be exact literal source text from the file (NOT line numbers like "line:10"');

    const catalog = formatModelFacingToolCatalog([...INITIAL_TOOL_DEFINITIONS, EDIT_FILE_TOOL]);
    expect(catalog).toContain("- edit_file(");
    expect(catalog).toContain("return a + b + 1;");
  });

  // --------------------------------------------------------------------------
  // Criterion 3 & 4: No-Op Edit Proposal Rejection
  // --------------------------------------------------------------------------
  it("Criterion 3: ProposalValidator rejects no-op edit where searchAnchor === replacementText", () => {
    const registry = new StaticToolRegistry();
    registry.register(EDIT_FILE_TOOL);
    const validator = new ProposalValidator({ toolRegistry: registry });

    const contract = createMissionContract({
      contractId: "contract-48a",
      version: 1,
      taskId: "task-48a",
      status: "ACTIVE",
      policy: createExecutionPolicy({
        policyId: "policy-48a",
        allowedCapabilities: ["workspace.file.write"],
        isolationRequirement: "ISOLATED",
        governedBenchmarkRepairMode: true,
      }),
      resourceLimits: createResourceLimits({ timeoutMs: 30000, maxAttempts: 5, maxOutputBytes: 1048576 }),
    });

    const run: RunSnapshot = {
      runId: "run-48a",
      taskId: "task-48a",
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
      createdAt: "2026-10-26T12:00:00.000Z",
      updatedAt: "2026-10-26T12:00:00.000Z",
    };

    const snapshot: ContextSnapshot = {
      snapshotId: "snap-1",
      runId: "run-48a",
      taskId: "task-48a",
      policyVersion: "v1",
      createdAt: "2026-10-26T12:00:00.000Z",
      budget: DEFAULT_CONTEXT_BUDGET,
      observations: [],
      omittedObservationsCount: 0,
      omittedObservationsSummary: [],
      totalEstimatedTokens: 0,
      totalBytes: 0,
      contextHash: "a".repeat(64),
    };

    // Identical anchor and replacement
    const noopProposal = {
      proposalId: "prop-noop",
      toolName: "edit_file" as const,
      inputPayload: {
        path: "src/calc.js",
        searchAnchor: "return a + b + 1;",
        replacementText: "return a + b + 1;",
      },
      contextSnapshotHash: "a".repeat(64),
    };

    const result = validator.validate(noopProposal, {
      runId: "run-48a",
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
      expect(result.message).toContain("searchAnchor' and 'replacementText' are identical");
    }

    // Actionable guidance check
    const guidance = deriveActionableValidationGuidance({
      toolName: "edit_file",
      rejectionReason: "NOOP_EDIT_DISALLOWED",
    });
    expect(guidance).toContain("searchAnchor' and 'replacementText' are identical");
    expect(guidance).toContain("must specify a different 'replacementText'");
  });

  // --------------------------------------------------------------------------
  // Criterion 5 & 6: LineAnchoredEditor Defense-in-Depth & File Preservation
  // --------------------------------------------------------------------------
  it("Criterion 5: LineAnchoredEditor rejects identical anchor/replacement fail-closed without mutating disk", async () => {
    const editor = new LineAnchoredEditor();
    const filePath = path.join(tempDir, "src/calc.js");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const originalContent = "function add(a, b) {\n  return a + b + 1;\n}\n";
    await fs.writeFile(filePath, originalContent, "utf8");

    expect(() => {
      editor.applyEdit(
        {
          path: "src/calc.js",
          searchAnchor: "return a + b + 1;",
          replacementText: "return a + b + 1;",
        },
        tempDir
      );
    }).toThrow("Invalid edit request: 'searchAnchor' and 'replacementText' are identical");

    // File remains byte-for-byte identical
    const onDisk = await fs.readFile(filePath, "utf8");
    expect(onDisk).toBe(originalContent);
  });

  it("Criterion 6: valid localized replacement succeeds", async () => {
    const editor = new LineAnchoredEditor();
    const filePath = path.join(tempDir, "src/calc.js");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const originalContent = "function add(a, b) {\n  return a + b + 1;\n}\n";
    await fs.writeFile(filePath, originalContent, "utf8");

    const result = editor.applyEdit(
      {
        path: "src/calc.js",
        searchAnchor: "return a + b + 1;",
        replacementText: "return a + b;",
      },
      tempDir
    );

    expect(result.applied).toBe(true);
    expect(result.occurrences).toBe(1);
    expect(result.replacedCount).toBe(1);

    const onDisk = await fs.readFile(filePath, "utf8");
    expect(onDisk).toBe("function add(a, b) {\n  return a + b;\n}\n");
  });

  // --------------------------------------------------------------------------
  // Criterion 7 & 8: Missing and Ambiguous Anchors Fail Closed
  // --------------------------------------------------------------------------
  it("Criterion 7: missing anchor fails closed without modifying file", async () => {
    const editor = new LineAnchoredEditor();
    const filePath = path.join(tempDir, "src/calc.js");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const originalContent = "function add(a, b) {\n  return a + b + 1;\n}\n";
    await fs.writeFile(filePath, originalContent, "utf8");

    expect(() => {
      editor.applyEdit(
        {
          path: "src/calc.js",
          searchAnchor: "line:10",
          replacementText: "console.log(42);",
        },
        tempDir
      );
    }).toThrow("Search anchor not found in src/calc.js: 0 occurrences matched 'line:10'");

    const onDisk = await fs.readFile(filePath, "utf8");
    expect(onDisk).toBe(originalContent);
  });

  it("Criterion 8: ambiguous anchor (multiple matches) fails closed without modifying file", async () => {
    const editor = new LineAnchoredEditor();
    const filePath = path.join(tempDir, "src/calc.js");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const originalContent = "const x = 1;\nconst y = 1;\n";
    await fs.writeFile(filePath, originalContent, "utf8");

    expect(() => {
      editor.applyEdit(
        {
          path: "src/calc.js",
          searchAnchor: "1;",
          replacementText: "2;",
          allowMultipleMatches: false,
        },
        tempDir
      );
    }).toThrow("Ambiguous search anchor in src/calc.js: 2 occurrences matched");

    const onDisk = await fs.readFile(filePath, "utf8");
    expect(onDisk).toBe(originalContent);
  });

  // --------------------------------------------------------------------------
  // Criterion 9: AgentStepController Recovery Guidance on Missing Anchor
  // --------------------------------------------------------------------------
  it("Criterion 9: AgentStepController injects bounded recovery guidance when edit_file anchor is not found", async () => {
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
      workerId: "worker-test-48a",
      coordinator,
      clock,
      workspacePort: mockWorkspacePort,
    });

    const targetFileRel = "src/calc.js";
    const targetFileAbs = path.join(tempDir, targetFileRel);
    await fs.mkdir(path.dirname(targetFileAbs), { recursive: true });
    const initialContent = "function add(a, b) {\n  return a + b + 1;\n}\n";
    await fs.writeFile(targetFileAbs, initialContent, "utf8");

    stateStore.transaction((tx) => {
      tx.insertWorker({
        workerId: "worker-test-48a",
        hostname: "localhost",
        pid: 7777,
        status: "ACTIVE",
        createdAt: clock.nowIso(),
        lastHeartbeatAt: clock.nowIso(),
      });
    });

    const task = coordinator.createTask({
      taskId: "task-recovery-48a",
      title: "Recovery Test Task",
      description: "Test recovery observation after failed anchor",
      inputPayload: {},
    });

    // Setup contract and run
    const contract = createMissionContract({
      contractId: "contract-recovery-48a",
      version: 1,
      taskId: task.taskId,
      policy: createExecutionPolicy({
        policyId: "policy-recovery-48a",
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
    const claim = coordinator.claimRun(run.runId, "worker-test-48a", 60000);
    coordinator.startRun(run.runId, "worker-test-48a", claim.lease.leaseId);

    // Mock brain:
    // Step 1: proposes edit_file with non-existent anchor "line:10"
    // Step 2: captures the context snapshot and checks observations, then finishes
    let capturedSnapshotStep2: ContextSnapshot | null = null;

    class ScriptedBrain implements AgentBrainPort {
      private step = 0;
      async proposeAction(req: AgentBrainRequest): Promise<AgentBrainResult> {
        this.step++;
        if (this.step === 1) {
          return {
            finishReason: "ACTION_PROPOSED",
            proposal: {
              proposalId: "prop-step-1",
              toolName: "edit_file",
              inputPayload: {
                path: targetFileRel,
                searchAnchor: "line:10",
                replacementText: "console.log(42);",
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

    const controller = new AgentStepController({
      coordinator,
      stateStore,
      workerRuntime,
      agentBrain: new ScriptedBrain(),
      clock,
    });

    const result = await controller.runStepLoop({
      runId: run.runId,
      workerId: "worker-test-48a",
      leaseId: claim.lease.leaseId,
      workspace: {
        workspaceId: "ws-test",
        hostPath: tempDir,
      },
      budget: {
        maxSteps: 3,
        maxActions: 3,
        maxConsecutiveFailures: 3,
        maxProposalRejections: 3,
        maxWallClockMs: 60000,
      },
    });

    // Step 1 must have executed and failed with missing anchor
    expect(result.totalSteps).toBe(2);
    expect(result.transcript[0]!.actionStatus).toBe("FAILED");

    // Target file on disk must be completely untouched
    const fileAfterStep1 = await fs.readFile(targetFileAbs, "utf8");
    expect(fileAfterStep1).toBe(initialContent);

    // Step 2 context snapshot must contain the recovery observation
    expect(capturedSnapshotStep2).not.toBeNull();
    const recoveryObs = capturedSnapshotStep2!.observations.find(
      (o) => (o.content as any)?.feedbackKind === "ACTION_RECOVERY_GUIDANCE"
    );
    expect(recoveryObs).toBeDefined();

    const guidance = (recoveryObs!.content as any).guidance as string;
    expect(guidance).toContain("Search anchor not found in 'src/calc.js'");
    expect(guidance).toContain("1) Re-read the file or inspect the most recent actual source output.");
    expect(guidance).toContain("2) Copy an exact literal text fragment from that source.");
    expect(guidance).toContain("3) Choose a smaller, unique anchor around the intended change.");
    expect(guidance).toContain("4) Avoid pseudo-selectors such as line:10.");
    expect(guidance).toContain("5) Use edit_file with the verified literal anchor rather than retrying a prohibited whole-file overwrite.");
  });
});
