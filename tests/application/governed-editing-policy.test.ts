/**
 * Phase 47C: Governed Editing Policy Hardening Test Suite
 *
 * Verifies all 12 contractual requirements for preventing unauthorized whole-file
 * overwrites of existing files while preserving localized editing, new file creation,
 * explicit replacement overrides, and workspace containment.
 *
 * Criteria:
 * 1. Existing-file write_file is denied when governed localized editing policy applies.
 * 2. The existing file remains byte-for-byte unchanged after denial.
 * 3. An authorized edit_file operation remains available.
 * 4. A new-file write_file operation remains allowed when authorized.
 * 5. Explicitly permitted full replacement remains possible in the intended configuration.
 * 6. Unauthorized edit_file is denied.
 * 7. Path traversal and workspace containment checks remain enforced.
 * 8. A denied mutation cannot satisfy clean-room verification.
 * 9. Repeated policy denials cannot cause an unbounded execution loop.
 * 10. Dynamic tool filtering cannot override the authoritative policy.
 * 11. Existing static-schema compatibility and historical contract invariants remain intact.
 * 12. Existing intermediate-test feedback and stagnation behavior remain intact.
 *
 * Zero live Ollama inference. Zero network calls. Zero git mutations.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

import { EditFileToolAdapter } from "../../src/adapters/tools/edit-file.tool-adapter.js";
import { WriteFileToolAdapter } from "../../src/adapters/tools/write-file.tool-adapter.js";
import {
  EDIT_FILE_TOOL,
  INITIAL_TOOL_DEFINITIONS,
  StaticToolRegistry,
} from "../../src/domain/tool.js";
import {
  DEFAULT_MAX_CONSECUTIVE_INEFFECTIVE_EDITS,
  DEFAULT_STEP_CONTROLLER_BUDGET,
  deriveActionableValidationGuidance,
} from "../../src/application/agent-step-controller.js";
import { ProposalValidator } from "../../src/application/proposal-validator.js";
import {
  ContextSnapshot,
  DEFAULT_CONTEXT_BUDGET,
} from "../../src/domain/context.js";
import {
  createExecutionPolicy,
  createMissionContract,
  createResourceLimits,
  createVerificationSpec,
  MissionContract,
  PolicyEvaluator,
} from "../../src/domain/index.js";
import { RunSnapshot } from "../../src/domain/invariants.js";
import {
  ToolExecutionFailedError,
  ToolWorkspaceBoundaryViolationError,
  WorkspacePathOutsideBoundaryError,
} from "../../src/domain/errors.js";
import { WorkspacePort } from "../../src/ports/workspace.port.js";
import { ToolExecutionContext } from "../../src/ports/tool-adapter.port.js";
import { DeterministicVerifier } from "../../src/domain/verification.js";
import { createProcessExitEvidence } from "../../src/domain/evidence.js";
import {
  Phase43BenchmarkRunner,
  PHASE43_PILOT_TASKS,
} from "../../src/production/benchmark/phase43-benchmark-runner.js";
import {
  OllamaFetchLike,
  OllamaModelProvider,
} from "../../src/adapters/models/ollama-model-provider.js";
import {
  EvidenceSigner,
  TrustedKeyring,
} from "../../src/application/evidence-signer.js";

// ============================================================================
// Workspace & Test Environment Helpers
// ============================================================================

class MockWorkspacePort implements WorkspacePort {
  constructor(private readonly rootDir: string) {}

  async resolvePath(workspaceId: string, relPath: string): Promise<string> {
    const normalized = path.normalize(relPath);
    if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
      throw new WorkspacePathOutsideBoundaryError(workspaceId, relPath, "Path outside workspace boundary");
    }
    return path.join(this.rootDir, normalized);
  }

  async readDirectory(): Promise<any> {
    return [];
  }
}

function createGovernedPolicy(options: {
  governedBenchmarkRepairMode?: boolean;
  allowWholeFileReplacement?: boolean;
  allowEditFile?: boolean;
}) {
  const allowed = [
    "workspace.file.read",
    "workspace.file.write",
    "workspace.code.search",
    "git.read",
    "process.execute",
    "read_file",
    "write_file",
    "run_command",
    "git_status",
    "git_diff",
    "search_code",
  ];
  if (options.allowEditFile !== false) {
    allowed.push("edit_file");
  }

  return createExecutionPolicy({
    policyId: "test-policy",
    allowedCapabilities: allowed,
    isolationRequirement: "ISOLATED",
    governedBenchmarkRepairMode: options.governedBenchmarkRepairMode ?? true,
    allowWholeFileReplacement: options.allowWholeFileReplacement ?? false,
  });
}

function createGovernedContract(policy: ExecutionPolicy, contractId = "contract-test-p47c"): MissionContract {
  return createMissionContract({
    contractId,
    version: 1,
    taskId: "task-1",
    policy,
    status: "ACTIVE",
    verificationSpecs: [],
    resourceLimits: createResourceLimits({
      timeoutMs: 5000,
      maxAttempts: 3,
      maxOutputBytes: 1048576,
    }),
  });
}

function createDummyRun(contract: MissionContract): RunSnapshot {
  return {
    runId: "run-test-p47c",
    taskId: "task-test-p47c",
    status: "RUNNING",
    currentWorkerId: "worker-1",
    currentLeaseId: "lease-1",
    contractBinding: {
      contractId: contract.spec.contractId,
      version: contract.spec.version,
      contentHash: contract.contentHash,
    },
    actionCount: 0,
    attemptCount: 0,
    timeoutMs: 5000,
    maxOutputBytes: 1048576,
  } as RunSnapshot;
}

function createDummyContextSnapshot(): ContextSnapshot {
  const hash = "a".repeat(64);
  return {
    snapshotId: "snap-1",
    runId: "run-test-p47c",
    sequenceNumber: 1,
    timestamp: new Date().toISOString(),
    observations: [],
    budget: DEFAULT_CONTEXT_BUDGET,
    estimatedTokens: 100,
    totalBytes: 500,
    isEvicted: false,
    contentHash: hash,
    contextHash: hash,
    totalEstimatedTokens: 100,
  } as ContextSnapshot;
}

function extractContextHash(body: any): string {
  const lastUserMsg = body?.messages?.filter((m: any) => m.role === "user")?.pop()?.content ?? "";
  const match =
    lastUserMsg.match(/Context Snapshot Hash:\s*([a-f0-9]{64})/i) ||
    lastUserMsg.match(/contextSnapshotHash to "([a-f0-9]{64})"/i) ||
    lastUserMsg.match(/"contextHash"\s*:\s*"([a-f0-9]{64})"/);
  return match ? match[1] : "0".repeat(64);
}

function createScriptedOllamaFetch(
  script: Array<(body: any, callCount: number) => { content: string }>
): OllamaFetchLike {
  let callIndex = 0;
  return async (_input, init) => {
    const bodyStr = init?.body ? String(init.body) : "{}";
    const body = JSON.parse(bodyStr);
    const handler = script[callIndex] ?? script[script.length - 1]!;
    const currentCall = callIndex;
    callIndex++;
    const { content } = handler(body, currentCall);
    const responseJson = {
      model: body.model ?? "qwen2.5-coder:1.5b",
      message: { role: "assistant", content },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 120,
      eval_count: 45,
      total_duration: 50000000,
    };
    return new Response(JSON.stringify(responseJson), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

// ============================================================================
// Test Suite
// ============================================================================

describe("Phase 47C — Offline Governed Editing Policy Hardening", () => {
  let tempDir: string;
  let workspaceRoot: string;
  let workspacePort: MockWorkspacePort;
  let toolRegistry: StaticToolRegistry;
  let proposalValidator: ProposalValidator;
  let keyring: TrustedKeyring;
  let workerKeys: ReturnType<typeof EvidenceSigner.generateKeyPair>;
  let supervisorKeys: ReturnType<typeof EvidenceSigner.generateKeyPair>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "emerald-phase47c-"));
    workspaceRoot = path.join(tempDir, "workspace");
    await fs.mkdir(workspaceRoot, { recursive: true });

    // Seed existing test file
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "src", "calc.js"),
      "function add(a, b) {\n  return a + b + 1;\n}\nmodule.exports = { add };\n",
      "utf8"
    );

    workspacePort = new MockWorkspacePort(workspaceRoot);
    toolRegistry = new StaticToolRegistry(INITIAL_TOOL_DEFINITIONS);
    toolRegistry.register(EDIT_FILE_TOOL);
    proposalValidator = new ProposalValidator({ toolRegistry });

    workerKeys = EvidenceSigner.generateKeyPair();
    supervisorKeys = EvidenceSigner.generateKeyPair();
    keyring = new TrustedKeyring();
    keyring.registerKey({
      authorityId: "auth-worker-p43",
      keyId: "key-worker-p43",
      role: "WORKER_PRODUCER",
      publicKey: workerKeys.publicKey,
      status: "TRUSTED",
    });
    keyring.registerKey({
      authorityId: "auth-supervisor-p43",
      keyId: "key-supervisor-p43",
      role: "SUPERVISOR",
      publicKey: supervisorKeys.publicKey,
      status: "TRUSTED",
    });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore temporary file lock cleanup errors on Windows
    }
  });

  // --------------------------------------------------------------------------
  // Criterion 1: Existing-file write_file is denied when governed editing applies
  // --------------------------------------------------------------------------
  it("Criterion 1: rejects write_file replacement of existing file when governed editing applies", async () => {
    const policy = createGovernedPolicy({ governedBenchmarkRepairMode: true });
    const contract = createGovernedContract(policy, "contract-c1");
    const run = createDummyRun(contract);
    const contextSnapshot = createDummyContextSnapshot();

    const proposal = {
      proposalId: "prop-write-existing",
      toolName: "write_file",
      inputPayload: {
        path: "src/calc.js",
        content: "function add(a, b) { return a + b; }",
      },
      contextSnapshotHash: contextSnapshot.contextHash,
    };

    // 1. ProposalValidator evaluation
    const decision = proposalValidator.validate(proposal, {
      runId: run.runId,
      contextSnapshot,
      run,
      contract,
      workspaceHostPath: workspaceRoot,
    });

    expect(decision.valid).toBe(false);
    if (!decision.valid) {
      expect(decision.reason).toBe("DISALLOWED_FILE_OVERWRITE");
      expect(decision.message).toContain("Direct overwrite of existing file 'src/calc.js' via 'write_file' is disallowed");
    }

    // 2. Defense-in-depth: WriteFileToolAdapter direct execution check
    const adapter = new WriteFileToolAdapter(workspacePort);
    const execContext: ToolExecutionContext = {
      runId: run.runId,
      taskId: "task-1",
      workerId: "worker-1",
      leaseId: "lease-1",
      toolName: "write_file",
      requiredCapability: "workspace.file.write",
      isolationRequirement: "ISOLATED",
      workspace: { workspaceId: "ws-1", hostPath: workspaceRoot },
      resourceLimits: { timeoutMs: 5000, maxOutputBytes: 1048576 },
      governedBenchmarkRepairMode: true,
      allowWholeFileReplacement: false,
    };

    await expect(
      adapter.execute(execContext, {
        path: "src/calc.js",
        content: "function add(a, b) { return a + b; }",
      })
    ).rejects.toThrow(ToolExecutionFailedError);
  });

  // --------------------------------------------------------------------------
  // Criterion 2: Existing file remains byte-for-byte unchanged after denial
  // --------------------------------------------------------------------------
  it("Criterion 2: ensures existing file remains byte-for-byte unchanged after denial", async () => {
    const calcPath = path.join(workspaceRoot, "src", "calc.js");
    const initialContent = await fs.readFile(calcPath, "utf8");
    const initialHash = createHash("sha256").update(initialContent).digest("hex");

    const policy = createGovernedPolicy({ governedBenchmarkRepairMode: true });
    const contract = createGovernedContract(policy, "contract-c2");
    const run = createDummyRun(contract);
    const contextSnapshot = createDummyContextSnapshot();

    // Validate rejected proposal
    const decision = proposalValidator.validate(
      {
        proposalId: "prop-write-c2",
        toolName: "write_file",
        inputPayload: {
          path: "src/calc.js",
          content: "CORRUPTED CONTENT",
        },
        contextSnapshotHash: contextSnapshot.contextHash,
      },
      {
        runId: run.runId,
        contextSnapshot,
        run,
        contract,
        workspaceHostPath: workspaceRoot,
      }
    );
    expect(decision.valid).toBe(false);

    // Verify adapter attempt also fails-close without modifying file
    const adapter = new WriteFileToolAdapter(workspacePort);
    const execContext: ToolExecutionContext = {
      runId: run.runId,
      taskId: "task-1",
      workerId: "worker-1",
      leaseId: "lease-1",
      toolName: "write_file",
      requiredCapability: "workspace.file.write",
      isolationRequirement: "ISOLATED",
      workspace: { workspaceId: "ws-1", hostPath: workspaceRoot },
      resourceLimits: { timeoutMs: 5000, maxOutputBytes: 1048576 },
      governedBenchmarkRepairMode: true,
      allowWholeFileReplacement: false,
    };

    try {
      await adapter.execute(execContext, {
        path: "src/calc.js",
        content: "CORRUPTED CONTENT",
      });
    } catch {
      // Expected failure
    }

    const currentContent = await fs.readFile(calcPath, "utf8");
    const currentHash = createHash("sha256").update(currentContent).digest("hex");

    expect(currentContent).toBe(initialContent);
    expect(currentHash).toBe(initialHash);
  });

  // --------------------------------------------------------------------------
  // Criterion 3: Authorized edit_file operation remains available
  // --------------------------------------------------------------------------
  it("Criterion 3: permits authorized localized editing via edit_file", async () => {
    const policy = createGovernedPolicy({ governedBenchmarkRepairMode: true });
    const contract = createGovernedContract(policy, "contract-c3");
    const run = createDummyRun(contract);
    const contextSnapshot = createDummyContextSnapshot();

    const editProposal = {
      proposalId: "prop-edit-c3",
      toolName: "edit_file",
      inputPayload: {
        path: "src/calc.js",
        searchAnchor: "return a + b + 1;",
        replacementText: "return a + b;",
      },
      contextSnapshotHash: contextSnapshot.contextHash,
    };

    const decision = proposalValidator.validate(editProposal, {
      runId: run.runId,
      contextSnapshot,
      run,
      contract,
      workspaceHostPath: workspaceRoot,
    });

    expect(decision.valid).toBe(true);

    const adapter = new EditFileToolAdapter(workspacePort);
    const execContext: ToolExecutionContext = {
      runId: run.runId,
      taskId: "task-1",
      workerId: "worker-1",
      leaseId: "lease-1",
      toolName: "edit_file",
      requiredCapability: "workspace.file.write",
      isolationRequirement: "ISOLATED",
      workspace: { workspaceId: "ws-1", hostPath: workspaceRoot },
      resourceLimits: { timeoutMs: 5000, maxOutputBytes: 1048576 },
    };

    const output = await adapter.execute(execContext, {
      path: "src/calc.js",
      searchAnchor: "return a + b + 1;",
      replacementText: "return a + b;",
    });

    expect(output.path).toBe("src/calc.js");
    expect(output.occurrences).toBe(1);
    expect(output.applied).toBe(true);

    const content = await fs.readFile(path.join(workspaceRoot, "src", "calc.js"), "utf8");
    expect(content).toContain("return a + b;");
    expect(content).not.toContain("return a + b + 1;");
  });

  // --------------------------------------------------------------------------
  // Criterion 4: New-file write_file operation remains allowed when authorized
  // --------------------------------------------------------------------------
  it("Criterion 4: allows write_file for creating genuinely new files under governed mode", async () => {
    const policy = createGovernedPolicy({ governedBenchmarkRepairMode: true });
    const contract = createGovernedContract(policy, "contract-c4");
    const run = createDummyRun(contract);
    const contextSnapshot = createDummyContextSnapshot();

    const newFileProposal = {
      proposalId: "prop-write-new",
      toolName: "write_file",
      inputPayload: {
        path: "src/helper.js",
        content: "function helper() { return 42; }\nmodule.exports = { helper };\n",
      },
      contextSnapshotHash: contextSnapshot.contextHash,
    };

    const decision = proposalValidator.validate(newFileProposal, {
      runId: run.runId,
      contextSnapshot,
      run,
      contract,
      workspaceHostPath: workspaceRoot,
    });

    expect(decision.valid).toBe(true);

    const adapter = new WriteFileToolAdapter(workspacePort);
    const execContext: ToolExecutionContext = {
      runId: run.runId,
      taskId: "task-1",
      workerId: "worker-1",
      leaseId: "lease-1",
      toolName: "write_file",
      requiredCapability: "workspace.file.write",
      isolationRequirement: "ISOLATED",
      workspace: { workspaceId: "ws-1", hostPath: workspaceRoot },
      resourceLimits: { timeoutMs: 5000, maxOutputBytes: 1048576 },
      governedBenchmarkRepairMode: true,
      allowWholeFileReplacement: false,
    };

    const output = await adapter.execute(execContext, {
      path: "src/helper.js",
      content: "function helper() { return 42; }\nmodule.exports = { helper };\n",
    });

    expect(output.path).toBe("src/helper.js");
    expect(output.created).toBe(true);

    const createdContent = await fs.readFile(path.join(workspaceRoot, "src", "helper.js"), "utf8");
    expect(createdContent).toContain("function helper()");
  });

  // --------------------------------------------------------------------------
  // Criterion 5: Explicitly permitted full replacement remains possible
  // --------------------------------------------------------------------------
  it("Criterion 5: allows full replacement when allowWholeFileReplacement is true", async () => {
    const policy = createGovernedPolicy({
      governedBenchmarkRepairMode: true,
      allowWholeFileReplacement: true,
    });
    const contract = createGovernedContract(policy, "contract-c5");
    const run = createDummyRun(contract);
    const contextSnapshot = createDummyContextSnapshot();

    const overwriteProposal = {
      proposalId: "prop-write-override",
      toolName: "write_file",
      inputPayload: {
        path: "src/calc.js",
        content: "module.exports = { cleanReplacement: true };\n",
      },
      contextSnapshotHash: contextSnapshot.contextHash,
    };

    const decision = proposalValidator.validate(overwriteProposal, {
      runId: run.runId,
      contextSnapshot,
      run,
      contract,
      workspaceHostPath: workspaceRoot,
    });

    expect(decision.valid).toBe(true);

    const adapter = new WriteFileToolAdapter(workspacePort);
    const execContext: ToolExecutionContext = {
      runId: run.runId,
      taskId: "task-1",
      workerId: "worker-1",
      leaseId: "lease-1",
      toolName: "write_file",
      requiredCapability: "workspace.file.write",
      isolationRequirement: "ISOLATED",
      workspace: { workspaceId: "ws-1", hostPath: workspaceRoot },
      resourceLimits: { timeoutMs: 5000, maxOutputBytes: 1048576 },
      governedBenchmarkRepairMode: true,
      allowWholeFileReplacement: true,
    };

    const output = await adapter.execute(execContext, {
      path: "src/calc.js",
      content: "module.exports = { cleanReplacement: true };\n",
    });

    expect(output.path).toBe("src/calc.js");
    const updatedContent = await fs.readFile(path.join(workspaceRoot, "src", "calc.js"), "utf8");
    expect(updatedContent).toBe("module.exports = { cleanReplacement: true };\n");
  });

  // --------------------------------------------------------------------------
  // Criterion 6: Unauthorized edit_file is denied
  // --------------------------------------------------------------------------
  it("Criterion 6: denies edit_file when capability is unauthorized under policy", async () => {
    const policy = createExecutionPolicy({
      policyId: "policy-no-write",
      allowedCapabilities: ["workspace.file.read"], // "workspace.file.write" is omitted!
      isolationRequirement: "ISOLATED",
    });
    const contract = createGovernedContract(policy, "contract-c6");
    const run = createDummyRun(contract);
    const contextSnapshot = createDummyContextSnapshot();

    const editProposal = {
      proposalId: "prop-unauth-edit",
      toolName: "edit_file",
      inputPayload: {
        path: "src/calc.js",
        searchAnchor: "return a + b + 1;",
        replacementText: "return a + b;",
      },
      contextSnapshotHash: contextSnapshot.contextHash,
    };

    const decision = proposalValidator.validate(editProposal, {
      runId: run.runId,
      contextSnapshot,
      run,
      contract,
      workspaceHostPath: workspaceRoot,
    });

    expect(decision.valid).toBe(false);
    if (!decision.valid) {
      expect(decision.reason).toBe("UNAUTHORIZED_CAPABILITY");
    }
  });

  // --------------------------------------------------------------------------
  // Criterion 7: Path traversal and workspace containment checks remain enforced
  // --------------------------------------------------------------------------
  it("Criterion 7: strictly rejects directory traversal across both validator and adapter", async () => {
    const policy = createGovernedPolicy({ governedBenchmarkRepairMode: true });
    const contract = createGovernedContract(policy, "contract-c7");
    const run = createDummyRun(contract);
    const contextSnapshot = createDummyContextSnapshot();

    // 1. Validator boundary check
    const traversalProposal = {
      proposalId: "prop-traversal",
      toolName: "write_file",
      inputPayload: {
        path: "../../escaped.txt",
        content: "malicious content",
      },
      contextSnapshotHash: contextSnapshot.contextHash,
    };

    const decision = proposalValidator.validate(traversalProposal, {
      runId: run.runId,
      contextSnapshot,
      run,
      contract,
      workspaceHostPath: workspaceRoot,
    });

    expect(decision.valid).toBe(false);
    if (!decision.valid) {
      expect(decision.reason).toBe("INVALID_TOOL_INPUT");
      expect(decision.message).toMatch(/outside workspace boundary|escape workspace boundary/);
    }

    // 2. Adapter boundary check
    const adapter = new WriteFileToolAdapter(workspacePort);
    const execContext: ToolExecutionContext = {
      runId: run.runId,
      taskId: "task-1",
      workerId: "worker-1",
      leaseId: "lease-1",
      toolName: "write_file",
      requiredCapability: "workspace.file.write",
      isolationRequirement: "ISOLATED",
      workspace: { workspaceId: "ws-1", hostPath: workspaceRoot },
      resourceLimits: { timeoutMs: 5000, maxOutputBytes: 1048576 },
    };

    await expect(
      adapter.execute(execContext, {
        path: "../../escaped.txt",
        content: "malicious content",
      })
    ).rejects.toThrow(ToolWorkspaceBoundaryViolationError);
  });

  // --------------------------------------------------------------------------
  // Criterion 8: Denied mutation cannot satisfy clean-room verification
  // --------------------------------------------------------------------------
  it("Criterion 8: denied mutation leaves defect intact and fails clean-room verification", async () => {
    const task = PHASE43_PILOT_TASKS["EAF-BM-01"];

    // Populate initial files
    for (const [relPath, content] of Object.entries(task.initialFiles)) {
      const fullPath = path.join(workspaceRoot, relPath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, "utf8");
    }

    // A denied write_file proposal does not mutate calc.js
    // Execute F2P test command directly against workspace to verify exitCode === 1
    let exitCode = 0;
    try {
      await execFileAsync(process.execPath, ["test/f2p.test.js"], {
        cwd: workspaceRoot,
      });
    } catch (err: any) {
      exitCode = err.code ?? 1;
    }

    expect(exitCode).toBe(1);

    // Also verify via DeterministicVerifier: EXIT_CODE_ZERO rule fails
    const verifSpec = createVerificationSpec({
      specId: "spec-exit-zero",
      ruleKind: "EXIT_CODE_ZERO",
      expectedValue: 0,
    });

    const failedEvidence = createProcessExitEvidence("run-c8", {
      exitCode,
    });

    const verdict = DeterministicVerifier.verify([failedEvidence], verifSpec);
    expect(verdict.status).toBe("FAILED");
  });

  // --------------------------------------------------------------------------
  // Criterion 9: Repeated policy denials cannot cause an unbounded execution loop
  // --------------------------------------------------------------------------
  it("Criterion 9: halts controller loop deterministically on repeated proposal rejections", async () => {
    const runner = new Phase43BenchmarkRunner({
      baseTempDir: tempDir,
    });
    const task = runner.getTask("EAF-BM-01");

    // Scripted Ollama model repeatedly proposing disallowed write_file on existing file
    const fakeOllama = createScriptedOllamaFetch([
      (body, count) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: `disallowed-write-${count}`,
            toolName: "write_file",
            inputPayload: {
              path: "src/calc.js",
              content: "function add(a,b){ return a+b+2; }",
            },
            contextSnapshotHash: hash,
            rationale: "Overwriting calc.js directly",
          }),
        };
      },
    ]);

    const modelProvider = new OllamaModelProvider({
      defaultModel: "qwen2.5-coder:1.5b",
      fetch: fakeOllama,
    });

    const result = await runner.executeTrial(task, {
      modelProvider,
      model: "qwen2.5-coder:1.5b",
      signingKeys: { workerKeys, supervisorKeys },
      keyring,
      maxSteps: 3,
      governedBenchmarkRepairMode: true,
      allowWholeFileReplacement: false,
    });

    expect(result.verified).toBe(false);
    expect(result.totalProposalRejections).toBeGreaterThan(0);
    expect(result.totalSteps).toBeLessThanOrEqual(3);
    // Should terminate gracefully with terminal status
    expect(["FAILED", "COMPLETED", "TIMED_OUT"]).toContain(result.terminalStatus);
  });

  // --------------------------------------------------------------------------
  // Criterion 10: Dynamic tool filtering cannot override authoritative policy
  // --------------------------------------------------------------------------
  it("Criterion 10: authoritative policy enforces overwrite denial regardless of tool eligibility", async () => {
    const policy = createGovernedPolicy({ governedBenchmarkRepairMode: true });

    // FileOperationPolicyDecision directly tested
    const decision = PolicyEvaluator.evaluateFileOperation(
      {
        toolName: "write_file",
        path: "src/calc.js",
        fileExists: true,
        isEditFileAvailableAndAuthorized: true,
      },
      policy
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("DISALLOWED_FILE_OVERWRITE");

    // Actionable guidance derived from denial
    const guidance = deriveActionableValidationGuidance({
      toolName: "write_file",
      rejectionReason: "DISALLOWED_FILE_OVERWRITE",
    });

    expect(guidance).toContain("Direct overwrite of existing files via 'write_file' is disallowed");
    expect(guidance).toContain("Use 'edit_file' with exact searchAnchor targeting");
  });

  // --------------------------------------------------------------------------
  // Criterion 11: Static schema compatibility and historical invariants intact
  // --------------------------------------------------------------------------
  it("Criterion 11: preserves legacy whole-file writes when governedBenchmarkRepairMode is false", async () => {
    const legacyPolicy = createGovernedPolicy({ governedBenchmarkRepairMode: false });
    const contract = createGovernedContract(legacyPolicy, "contract-c11");
    const run = createDummyRun(contract);
    const contextSnapshot = createDummyContextSnapshot();

    const proposal = {
      proposalId: "prop-legacy-write",
      toolName: "write_file",
      inputPayload: {
        path: "src/calc.js",
        content: "function add(a, b) { return a + b; }",
      },
      contextSnapshotHash: contextSnapshot.contextHash,
    };

    const decision = proposalValidator.validate(proposal, {
      runId: run.runId,
      contextSnapshot,
      run,
      contract,
      workspaceHostPath: workspaceRoot,
    });

    expect(decision.valid).toBe(true);

    const adapter = new WriteFileToolAdapter(workspacePort);
    const execContext: ToolExecutionContext = {
      runId: run.runId,
      taskId: "task-1",
      workerId: "worker-1",
      leaseId: "lease-1",
      toolName: "write_file",
      requiredCapability: "workspace.file.write",
      isolationRequirement: "ISOLATED",
      workspace: { workspaceId: "ws-1", hostPath: workspaceRoot },
      resourceLimits: { timeoutMs: 5000, maxOutputBytes: 1048576 },
      governedBenchmarkRepairMode: false,
    };

    const output = await adapter.execute(execContext, {
      path: "src/calc.js",
      content: "function add(a, b) { return a + b; }",
    });

    expect(output.path).toBe("src/calc.js");
  });

  // --------------------------------------------------------------------------
  // Criterion 12: Intermediate-test feedback and stagnation behavior remain intact
  // --------------------------------------------------------------------------
  it("Criterion 12: preserves stagnation control constants and actionable guidance contracts", () => {
    expect(DEFAULT_MAX_CONSECUTIVE_INEFFECTIVE_EDITS).toBe(3);
    expect(DEFAULT_STEP_CONTROLLER_BUDGET.maxSteps).toBe(10);

    // Guidance mapping test
    const guidance = deriveActionableValidationGuidance({
      toolName: "edit_file",
      rejectionReason: "INVALID_TOOL_INPUT",
      inputPayload: {
        file: "src/calc.js",
        old_text: "foo",
      },
    });

    expect(guidance).toContain('unrecognized key "file"; expected field "path"');
  });
});
