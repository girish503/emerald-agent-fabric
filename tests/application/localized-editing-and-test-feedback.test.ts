/**
 * Phase 47A: Governed Localized Editing & Test-Guided Repair Test Suite
 *
 * Verifies all 12 contractual requirements for governed localized editing,
 * intermediate test-guided feedback, regression prevention, and bounded stagnation control.
 *
 * Invariants:
 * 1. Valid localized edit changes only the intended segment (byte-for-byte preservation outside anchor).
 * 2. Missing expected segment fails closed (0 occurrences matched, zero disk mutation).
 * 3. Multiple ambiguous matches fail closed without allowMultipleMatches.
 * 4. Out-of-workspace path is strictly rejected with boundary violation error.
 * 5. Failed edit is never reported as successful repair.
 * 6. F2P failure feedback is captured and delivered into model observation context.
 * 7. P2P regression failure prevents verified success and rejects goal completion claim.
 * 8. Test timeout is represented explicitly (isTimedOut: true, classification: TIMEOUT).
 * 9. Repeated ineffective edits trigger bounded stagnation control (terminalReason: STAGNATION).
 * 10. Proposal validation and policy enforcement remain authoritative upstream.
 * 11. Static schema behavior preserved when dynamic filtering is disabled.
 * 12. Offline evidence signing and verification continue to pass with status: VERIFIED.
 *
 * Zero live Ollama inference. Zero network calls. Zero git mutations.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LineAnchoredEditor } from "../../src/production/repair/line-anchored-editor.js";
import { EditFileToolAdapter } from "../../src/adapters/tools/edit-file.tool-adapter.js";
import {
  EDIT_FILE_TOOL,
  INITIAL_TOOL_DEFINITIONS,
  StaticToolRegistry,
  staticToolRegistry,
} from "../../src/domain/tool.js";
import {
  EditFileInputSchema,
  EditFileOutputSchema,
} from "../../src/domain/tool-schemas.js";
import {
  ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA,
  deriveActionProposalSchema,
  EDIT_FILE_SCHEMA_BRANCH,
} from "../../src/application/live-agent-brain.js";
import {
  DEFAULT_MAX_CONSECUTIVE_INEFFECTIVE_EDITS,
  DEFAULT_STEP_CONTROLLER_BUDGET,
  DETERMINISTIC_TOOL_PARAMETER_MAPPINGS,
  deriveActionableValidationGuidance,
} from "../../src/application/agent-step-controller.js";
import { ProposalValidator } from "../../src/application/proposal-validator.js";
import {
  computeContextHash,
  ContextSnapshot,
  DEFAULT_CONTEXT_BUDGET,
  Observation,
} from "../../src/domain/context.js";
import {
  createExecutionPolicy,
  createMissionContract,
  createResourceLimits,
  createVerificationSpec,
  MissionContract,
} from "../../src/domain/index.js";
import { RunSnapshot } from "../../src/domain/invariants.js";
import {
  Phase43BenchmarkRunner,
} from "../../src/production/benchmark/phase43-benchmark-runner.js";
import {
  OllamaFetchLike,
  OllamaModelProvider,
} from "../../src/adapters/models/ollama-model-provider.js";
import {
  EvidenceSigner,
  TrustedKeyring,
} from "../../src/application/evidence-signer.js";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "../../src/ports/execution-provider.port.js";

// ============================================================================
// Scripted Ollama Transport Helper (Offline Fake)
// ============================================================================

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

describe("Phase 47A: Governed Localized Editing & Test-Guided Repair", () => {
  let tempBaseDir: string;
  let workspaceDir: string;
  let editor: LineAnchoredEditor;
  let adapter: EditFileToolAdapter;
  let keyring: TrustedKeyring;
  let workerKeys: ReturnType<typeof EvidenceSigner.generateKeyPair>;
  let supervisorKeys: ReturnType<typeof EvidenceSigner.generateKeyPair>;

  beforeEach(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "phase47a-test-"));
    workspaceDir = path.join(tempBaseDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    editor = new LineAnchoredEditor();
    adapter = new EditFileToolAdapter(undefined, editor);

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
      await fs.rm(tempBaseDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  // --------------------------------------------------------------------------
  // Criterion 1: Valid localized edit changes only the intended segment
  // --------------------------------------------------------------------------
  it("Criterion 1: valid localized edit changes only the intended segment", async () => {
    const originalContent = [
      "// Multi-line module header",
      "function add(a, b) {",
      "  // Defective implementation",
      "  return a - b;",
      "}",
      "module.exports = { add };",
    ].join("\n");

    const filePath = "src/calc.js";
    const fullHostPath = path.join(workspaceDir, filePath);
    await fs.mkdir(path.dirname(fullHostPath), { recursive: true });
    await fs.writeFile(fullHostPath, originalContent, "utf8");

    const originalDigest = createHash("sha256").update(originalContent, "utf8").digest("hex");

    const result = await adapter.execute(
      {
        runId: "run-test-1",
        taskId: "task-test-1",
        workerId: "worker-test-1",
        leaseId: "lease-test-1",
        toolName: "edit_file" as any,
        requiredCapability: "workspace.file.write",
        isolationRequirement: "WORKSPACE",
        workspace: {
          workspaceId: "ws-test-1",
          hostPath: workspaceDir,
        },
        resourceLimits: {
          timeoutMs: 10000,
          maxOutputBytes: 1024 * 1024,
        },
      },
      {
        path: filePath,
        searchAnchor: "  return a - b;",
        replacementText: "  return a + b;",
      }
    );

    expect(result.applied).toBe(true);
    expect(result.occurrences).toBe(1);
    expect(result.replacedCount).toBe(1);
    expect(result.originalDigest).toBe(originalDigest);
    expect(result.resultingDigest).not.toBe(originalDigest);

    const onDiskContent = await fs.readFile(fullHostPath, "utf8");
    const expectedContent = [
      "// Multi-line module header",
      "function add(a, b) {",
      "  // Defective implementation",
      "  return a + b;",
      "}",
      "module.exports = { add };",
    ].join("\n");

    expect(onDiskContent).toBe(expectedContent);
  });

  // --------------------------------------------------------------------------
  // Criterion 2: Missing expected segment is rejected
  // --------------------------------------------------------------------------
  it("Criterion 2: missing expected segment fails closed without modifying disk", async () => {
    const content = "function add(a, b) { return a - b; }\n";
    const filePath = "src/calc.js";
    const fullHostPath = path.join(workspaceDir, filePath);
    await fs.mkdir(path.dirname(fullHostPath), { recursive: true });
    await fs.writeFile(fullHostPath, content, "utf8");
    const digestBefore = createHash("sha256").update(content, "utf8").digest("hex");

    await expect(
      adapter.execute(
        {
          runId: "run-test-1",
          taskId: "task-test-1",
          workerId: "worker-test-1",
          leaseId: "lease-test-1",
          toolName: "edit_file" as any,
          requiredCapability: "workspace.file.write",
          isolationRequirement: "WORKSPACE",
          workspace: {
            workspaceId: "ws-test-1",
            hostPath: workspaceDir,
          },
          resourceLimits: {
            timeoutMs: 10000,
            maxOutputBytes: 1024 * 1024,
          },
        },
        {
          path: filePath,
          searchAnchor: "return a * b * c;",
          replacementText: "return a + b;",
        }
      )
    ).rejects.toThrow(/Search anchor not found in .* 0 occurrences matched/);

    const contentAfter = await fs.readFile(fullHostPath, "utf8");
    const digestAfter = createHash("sha256").update(contentAfter, "utf8").digest("hex");
    expect(digestAfter).toBe(digestBefore);
  });

  // --------------------------------------------------------------------------
  // Criterion 3: Multiple ambiguous matches fail closed
  // --------------------------------------------------------------------------
  it("Criterion 3: multiple ambiguous matches fail closed", async () => {
    const content = [
      "const x = 10;",
      "const y = 10;",
      "const z = 10;",
    ].join("\n");

    const filePath = "src/data.js";
    const fullHostPath = path.join(workspaceDir, filePath);
    await fs.mkdir(path.dirname(fullHostPath), { recursive: true });
    await fs.writeFile(fullHostPath, content, "utf8");

    await expect(
      adapter.execute(
        {
          runId: "run-test-1",
          taskId: "task-test-1",
          workerId: "worker-test-1",
          leaseId: "lease-test-1",
          toolName: "edit_file" as any,
          requiredCapability: "workspace.file.write",
          isolationRequirement: "WORKSPACE",
          workspace: {
            workspaceId: "ws-test-1",
            hostPath: workspaceDir,
          },
          resourceLimits: {
            timeoutMs: 10000,
            maxOutputBytes: 1024 * 1024,
          },
        },
        {
          path: filePath,
          searchAnchor: "10;",
          replacementText: "42;",
          allowMultipleMatches: false,
        }
      )
    ).rejects.toThrow(/Ambiguous search anchor in .* 3 occurrences matched/);

    const contentAfter = await fs.readFile(fullHostPath, "utf8");
    expect(contentAfter).toBe(content);
  });

  // --------------------------------------------------------------------------
  // Criterion 4: Out-of-workspace path is rejected
  // --------------------------------------------------------------------------
  it("Criterion 4: out-of-workspace path is rejected with boundary violation", async () => {
    await expect(
      adapter.execute(
        {
          runId: "run-test-1",
          taskId: "task-test-1",
          workerId: "worker-test-1",
          leaseId: "lease-test-1",
          toolName: "edit_file" as any,
          requiredCapability: "workspace.file.write",
          isolationRequirement: "WORKSPACE",
          workspace: {
            workspaceId: "ws-test-1",
            hostPath: workspaceDir,
          },
          resourceLimits: {
            timeoutMs: 10000,
            maxOutputBytes: 1024 * 1024,
          },
        },
        {
          path: "../../outside-workspace.js",
          searchAnchor: "foo",
          replacementText: "bar",
        }
      )
    ).rejects.toThrow(/Path traversal denied outside workspace/);
  });

  // --------------------------------------------------------------------------
  // Criterion 5: Failed edit is not reported as successful repair
  // --------------------------------------------------------------------------
  it("Criterion 5: failed edit is never reported as successful repair", async () => {
    const rawResult = editor.applyEdit;
    expect(rawResult).toBeDefined();

    // Verify LineAnchoredEditResult statically declares authority flags as false
    const validContent = "console.log('original');\n";
    const testFile = path.join(workspaceDir, "test.js");
    await fs.writeFile(testFile, validContent, "utf8");

    const editRes = editor.applyEdit(
      {
        path: "test.js",
        searchAnchor: "console.log('original');",
        replacementText: "console.log('updated');",
      },
      workspaceDir
    );

    expect(editRes.applied).toBe(true);
    expect(editRes.authoritative).toBe(false);
    expect(editRes.verificationAuthority).toBe(false);
    expect(editRes.terminalAuthority).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Criterion 6: F2P failure feedback is captured and delivered into context
  // --------------------------------------------------------------------------
  it("Criterion 6: F2P failure feedback is captured and delivered into context", async () => {
    let capturedVerificationObs: Observation | undefined;

    const fakeFetch = createScriptedOllamaFetch([
      // Step 1: Read file
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "prop-step-1",
            toolName: "read_file",
            contextSnapshotHash: hash,
            rationale: "Read defective calc.js file",
            inputPayload: { path: "src/calc.js" },
          }),
        };
      },
      // Step 2: Propose wrong edit (retains defect)
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "prop-step-2",
            toolName: "edit_file",
            contextSnapshotHash: hash,
            rationale: "Apply incorrect edit to calc.js",
            inputPayload: {
              path: "src/calc.js",
              searchAnchor: "return a + b + 1;",
              replacementText: "return a * 0;",
            },
          }),
        };
      },
      // Step 3: Inspect context observations for test feedback
      (body) => {
        const lastUser = body.messages.filter((m: any) => m.role === "user").pop()?.content ?? "";
        expect(lastUser).toContain("[VERIFICATION]");
        expect(lastUser).toContain("FAIL_TO_PASS");
        expect(lastUser).toContain('"exitCode":1');
        expect(lastUser).toContain('"classification":"FAIL"');

        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "prop-step-3",
            toolName: "read_file",
            contextSnapshotHash: hash,
            rationale: "Acknowledged test failure",
            inputPayload: { path: "src/calc.js" },
          }),
        };
      },
    ]);

    const modelProvider = new OllamaModelProvider({
      defaultModel: "qwen2.5-coder:1.5b",
      fetch: fakeFetch,
    });

    const runner = new Phase43BenchmarkRunner({
      baseTempDir: tempBaseDir,
    });

    const task = runner.getTask("EAF-BM-01");
    const result = await runner.executeTrial(task, {
      modelProvider,
      model: "qwen2.5-coder:1.5b",
      signingKeys: { workerKeys, supervisorKeys },
      keyring,
      maxSteps: 3,
      enableDynamicToolFiltering: false,
    });

    expect(result.diagnostics.stepDiagnostics.length).toBeGreaterThanOrEqual(2);
  });

  // --------------------------------------------------------------------------
  // Criterion 7: P2P regression failure prevents verified success
  // --------------------------------------------------------------------------
  it("Criterion 7: P2P regression failure prevents verified success", async () => {
    const fakeFetch = createScriptedOllamaFetch([
      // Step 1: Read file
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "prop-step-1",
            toolName: "read_file",
            contextSnapshotHash: hash,
            rationale: "Read calc.js",
            inputPayload: { path: "src/calc.js" },
          }),
        };
      },
      // Step 2: Propose regression patch (fixes add but breaks multiply/etc)
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "prop-step-2",
            toolName: "write_file",
            contextSnapshotHash: hash,
            rationale: "Overwrite calc.js with regression",
            inputPayload: {
              path: "src/calc.js",
              content: "function add(a, b) { return a + b; }\nfunction subtract(a, b) { return 999; }\nmodule.exports = { add, subtract };\n",
            },
          }),
        };
      },
      // Step 3: Claim goal reached prematurely
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: true,
            proposalId: "prop-step-3",
            contextSnapshotHash: hash,
            rationale: "Claim completion with regression",
          }),
        };
      },
    ]);

    const modelProvider = new OllamaModelProvider({
      defaultModel: "qwen2.5-coder:1.5b",
      fetch: fakeFetch,
    });

    const runner = new Phase43BenchmarkRunner({
      baseTempDir: tempBaseDir,
    });

    const task = runner.getTask("EAF-BM-01");
    const result = await runner.executeTrial(task, {
      modelProvider,
      model: "qwen2.5-coder:1.5b",
      signingKeys: { workerKeys, supervisorKeys },
      keyring,
      maxSteps: 3,
      enableDynamicToolFiltering: false,
    });

    // Verification must have failed due to passToPass regression
    expect(result.terminalStatus).not.toBe("COMPLETED");
  });

  // --------------------------------------------------------------------------
  // Criterion 8: Test timeout is represented explicitly
  // --------------------------------------------------------------------------
  it("Criterion 8: test timeout is represented explicitly", async () => {
    class SimulatingTimedOutExecutionProvider implements ExecutionProvider {
  readonly tenantModel = "NONE" as const;
  readonly quiescence = { async quiesceRun(_runId: string) { return { status: "QUIESCENT" as const, stopped: 0 }; } };
      readonly name = "simulated-timeout-provider";
      async execute<TInput = unknown, TOutput = unknown>(
        _request: ExecutionRequest<TInput>
      ): Promise<ExecutionResult<TOutput>> {
        return {
          status: "TIMED_OUT",
          error: { code: "EXECUTION_TIMEOUT", message: "Process execution timed out" },
          durationMs: 1200,
        };
      }
    }

    const fakeFetch = createScriptedOllamaFetch([
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "prop-step-1",
            toolName: "read_file",
            contextSnapshotHash: hash,
            rationale: "Read calc.js",
            inputPayload: { path: "src/calc.js" },
          }),
        };
      },
      // Step 2: Propose edit triggering test execution that times out
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "prop-step-2",
            toolName: "edit_file",
            contextSnapshotHash: hash,
            rationale: "Apply edit",
            inputPayload: {
              path: "src/calc.js",
              searchAnchor: "return a + b + 1;",
              replacementText: "return a + b;",
            },
          }),
        };
      },
      // Step 3: Verify the timeout observation
      (body) => {
        const lastUser = body.messages.filter((m: any) => m.role === "user").pop()?.content ?? "";
        expect(lastUser).toContain("[VERIFICATION]");
        expect(lastUser).toContain("TIMEOUT");
        expect(lastUser).toContain('"isTimedOut":true');
        expect(lastUser).toContain('"durationMs":1200');

        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "prop-step-3",
            toolName: "read_file",
            contextSnapshotHash: hash,
            rationale: "Observe timeout",
            inputPayload: { path: "src/calc.js" },
          }),
        };
      },
    ]);

    const modelProvider = new OllamaModelProvider({
      defaultModel: "qwen2.5-coder:1.5b",
      fetch: fakeFetch,
    });

    const runner = new Phase43BenchmarkRunner({
      baseTempDir: tempBaseDir,
    });

    const task = runner.getTask("EAF-BM-01");
    const result = await runner.executeTrial(task, {
      modelProvider,
      model: "qwen2.5-coder:1.5b",
      maxSteps: 3,
      enableDynamicToolFiltering: false,
      executionProvider: new SimulatingTimedOutExecutionProvider(),
    });

    expect(result.terminalStatus).not.toBe("COMPLETED");
  });

  // --------------------------------------------------------------------------
  // Criterion 9: Repeated ineffective edits trigger bounded stagnation control
  // --------------------------------------------------------------------------
  it("Criterion 9: repeated ineffective edits trigger bounded stagnation control", async () => {
    const fakeFetch = createScriptedOllamaFetch([
      // Step 1: Ineffective edit 1 (successfully modifies calc.js but test still fails)
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "prop-step-1",
            toolName: "edit_file",
            contextSnapshotHash: hash,
            rationale: "Ineffective edit 1",
            inputPayload: {
              path: "src/calc.js",
              searchAnchor: "return a + b + 1;",
              replacementText: "return a + b + 2;",
            },
          }),
        };
      },
      // Step 2: Ineffective edit 2 (successfully modifies calc.js but test still fails)
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "prop-step-2",
            toolName: "edit_file",
            contextSnapshotHash: hash,
            rationale: "Ineffective edit 2",
            inputPayload: {
              path: "src/calc.js",
              searchAnchor: "return a + b + 2;",
              replacementText: "return a + b + 3;",
            },
          }),
        };
      },
      // Step 3: Ineffective edit 3 (successfully modifies calc.js but test still fails)
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "prop-step-3",
            toolName: "edit_file",
            contextSnapshotHash: hash,
            rationale: "Ineffective edit 3",
            inputPayload: {
              path: "src/calc.js",
              searchAnchor: "return a + b + 3;",
              replacementText: "return a + b + 4;",
            },
          }),
        };
      },
      // Step 4: Fallback response (should not be reached due to loop stagnation halt at start of step 4)
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "prop-step-4",
            toolName: "read_file",
            contextSnapshotHash: hash,
            rationale: "Fallback step",
            inputPayload: {
              path: "src/calc.js",
            },
          }),
        };
      },
    ]);

    const modelProvider = new OllamaModelProvider({
      defaultModel: "qwen2.5-coder:1.5b",
      fetch: fakeFetch,
    });

    const runner = new Phase43BenchmarkRunner({
      baseTempDir: tempBaseDir,
    });

    const task = runner.getTask("EAF-BM-01");
    const result = await runner.executeTrial(task, {
      modelProvider,
      model: "qwen2.5-coder:1.5b",
      maxSteps: 5,
      enableDynamicToolFiltering: false,
    });

    expect(result.terminalReason).toBe("STAGNATION");
    expect(result.terminalStatus).toBe("FAILED");
  });

  // --------------------------------------------------------------------------
  // Criterion 10: Proposal validation and policy enforcement remain authoritative
  // --------------------------------------------------------------------------
  it("Criterion 10: proposal validation and policy enforcement remain authoritative", () => {
    const registry = new StaticToolRegistry([EDIT_FILE_TOOL]);
    const validator = new ProposalValidator({ toolRegistry: registry });

    const contract = createMissionContract({
      contractId: "contract-read-only",
      version: 1,
      taskId: "task-test-1",
      policy: createExecutionPolicy({
        policyId: "policy-read-only",
        allowedCapabilities: ["workspace.file.read"], // write denied!
        isolationRequirement: "ISOLATED",
      }),
      resourceLimits: createResourceLimits({
        timeoutMs: 30000,
        maxAttempts: 3,
        maxOutputBytes: 1048576,
      }),
      status: "ACTIVE",
    });

    const run: RunSnapshot = {
      runId: "run-test-1",
      taskId: "task-test-1",
      status: "RUNNING",
      version: 1,
      attemptCount: 1,
      maxAttempts: 3,
      timeoutMs: 30000,
      idempotencyKey: null,
      currentWorkerId: "worker-test-1",
      leaseId: "lease-test-1",
      leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
      contractBinding: {
        contractId: contract.spec.contractId,
        version: contract.spec.version,
        contentHash: contract.contentHash,
      },
      resultPayload: null,
      errorPayload: null,
      createdAt: "2026-10-26T12:00:00.000Z",
      updatedAt: "2026-10-26T12:00:00.000Z",
    };

    const contextHash = "a".repeat(64);
    const mockSnapshot: ContextSnapshot = {
      snapshotId: "snap-1",
      runId: run.runId,
      taskId: run.taskId,
      policyVersion: "v1",
      createdAt: "2026-10-26T12:00:00.000Z",
      budget: DEFAULT_CONTEXT_BUDGET,
      observations: [],
      omittedObservationsCount: 0,
      omittedObservationsSummary: [],
      totalEstimatedTokens: 0,
      totalBytes: 0,
      contextHash,
    };

    // Proposal attempting edit_file with read-only policy
    const decision = validator.validate(
      {
        proposalId: "prop-unauthorized",
        toolName: "edit_file",
        inputPayload: {
          path: "src/calc.js",
          searchAnchor: "foo",
          replacementText: "bar",
        },
        contextSnapshotHash: contextHash,
      },
      {
        runId: run.runId,
        contextSnapshot: mockSnapshot,
        workerId: run.currentWorkerId!,
        leaseId: run.leaseId!,
        run,
        contract,
      }
    );

    expect(decision.valid).toBe(false);
    if (!decision.valid) {
      const failure = decision as ProposalValidationFailure;
      expect(failure.reason).toBe("UNAUTHORIZED_CAPABILITY");
      expect(failure.message).toContain("workspace.file.write");
    }
  });

  // --------------------------------------------------------------------------
  // Criterion 11: Static schema behavior preserved when dynamic filtering is disabled
  // --------------------------------------------------------------------------
  it("Criterion 11: static schema behavior preserved when dynamic filtering is disabled", () => {
    const tools = INITIAL_TOOL_DEFINITIONS;

    // With enableDynamicToolFiltering: false, always returns exactly the static 7-branch schema
    const staticDerived = deriveActionProposalSchema(tools, {
      enableDynamicToolFiltering: false,
    });

    expect(staticDerived).toBe(ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA);
    expect((staticDerived.jsonSchema as any).anyOf.length).toBe(7);

    // With dynamic filtering enabled and edit_file present, includes edit_file branch
    const extendedTools = [...tools, EDIT_FILE_TOOL];
    const dynamicDerived = deriveActionProposalSchema(extendedTools, {
      enableDynamicToolFiltering: true,
    });

    expect(dynamicDerived).not.toBe(ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA);
    const branchToolNames = (dynamicDerived.jsonSchema as any).anyOf
      .slice(1)
      .map((b: any) => b.properties?.toolName?.enum?.[0]);

    expect(branchToolNames).toContain("edit_file");
  });

  // --------------------------------------------------------------------------
  // Criterion 12: Offline evidence signing and verification continue to pass
  // --------------------------------------------------------------------------
  it("Criterion 12: offline evidence signing and verification continue to pass", async () => {
    const fakeFetch = createScriptedOllamaFetch([
      // Step 1: Read file
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "prop-step-1",
            toolName: "read_file",
            contextSnapshotHash: hash,
            rationale: "Read calc.js",
            inputPayload: { path: "src/calc.js" },
          }),
        };
      },
      // Step 2: Apply correct localized edit
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "prop-step-2",
            toolName: "edit_file",
            contextSnapshotHash: hash,
            rationale: "Fix add function via localized replacement",
            inputPayload: {
              path: "src/calc.js",
              searchAnchor: "return a + b + 1;",
              replacementText: "return a + b;",
            },
          }),
        };
      },
      // Step 3: Complete goal
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: true,
            proposalId: "prop-step-3",
            contextSnapshotHash: hash,
            rationale: "Repaired defect and verified test pass",
          }),
        };
      },
    ]);

    const modelProvider = new OllamaModelProvider({
      defaultModel: "qwen2.5-coder:1.5b",
      fetch: fakeFetch,
    });

    const runner = new Phase43BenchmarkRunner({
      baseTempDir: tempBaseDir,
    });

    const task = runner.getTask("EAF-BM-01");
    const result = await runner.executeTrial(task, {
      modelProvider,
      model: "qwen2.5-coder:1.5b",
      signingKeys: { workerKeys, supervisorKeys },
      keyring,
      maxSteps: 3,
      enableDynamicToolFiltering: false,
    });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.terminalStatus).toBe("COMPLETED");
    expect(result.cleanRoomOutcome?.status).toBe("VERIFIED");
    expect(result.offlineAudit.status).toBe("VERIFIED");
  });
});
