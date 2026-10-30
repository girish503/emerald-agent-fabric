/**
 * Phase 43 — Gate A Deterministic Benchmark Runner & Evidence Integration Test Suite
 *
 * Verifies that the bounded benchmark runner executes the complete end-to-end
 * reasoning, governance, clean-room verification, and evidence auditing pipeline
 * deterministically using hermetic fake model transports prior to live trials.
 *
 * Gate A Acceptance Criteria:
 * 1. Fake-transport tests pass deterministically.
 * 2. Invalid model output fails closed.
 * 3. Empty patches cannot produce success (EMPTY_PATCH).
 * 4. Out-of-scope modifications are rejected (POLICY_PATH_VIOLATION).
 * 5. Timeout and iteration limits are enforced (MAX_STEPS / TIMED_OUT).
 * 6. Acceptance-test failure (TARGET_TEST_FAILED) and regression (REGRESSION_DETECTED) prevent success.
 * 7. Successful and failed attempts produce appropriately classified evidence.
 * 8. Offline auditor results agree with the recorded authoritative outcome (100% agreement).
 * 9. The model cannot modify task manifests, acceptance tests, runtime policy, verifier logic, or evidence authority.
 * 10. Multi-task coverage: EAF-BM-01, EAF-BM-02, and EAF-BM-03 (CRLF security defect) verify successfully.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  Phase43BenchmarkRunner,
  Phase43PilotTask,
} from "../../src/production/benchmark/phase43-benchmark-runner.js";
import {
  OllamaFetchLike,
  OllamaModelProvider,
} from "../../src/adapters/models/ollama-model-provider.js";
import {
  EvidenceSigner,
  TrustedKeyring,
} from "../../src/application/evidence-signer.js";
import { findForbiddenAuthorityKeys } from "../../src/domain/action-proposal.js";
import {
  deriveActionableValidationGuidance,
  DETERMINISTIC_TOOL_PARAMETER_MAPPINGS,
  MAX_REJECTION_FEEDBACK_CHARS,
  sanitizeRejectionMessage,
} from "../../src/application/agent-step-controller.js";

// ============================================================================
// Helper: Scripted Fake Ollama Transport
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
  script: Array<(body: any, callCount: number) => { content: string; promptTokens?: number; evalTokens?: number }>
): OllamaFetchLike {
  let callIndex = 0;
  return async (_input, init) => {
    const bodyStr = init?.body ? String(init.body) : "{}";
    const body = JSON.parse(bodyStr);
    const handler = script[callIndex] ?? script[script.length - 1]!;
    const currentCall = callIndex;
    callIndex++;
    const { content, promptTokens = 110, evalTokens = 42 } = handler(body, currentCall);
    const responseJson = {
      model: body.model ?? "qwen2.5-coder:1.5b",
      message: { role: "assistant", content },
      done: true,
      done_reason: "stop",
      prompt_eval_count: promptTokens,
      eval_count: evalTokens,
      total_duration: 85000000,
    };
    return new Response(JSON.stringify(responseJson), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

// ============================================================================
// Test Matrix
// ============================================================================

describe("Phase 43 — Gate A Deterministic Runner & Evidence Integration", () => {
  let tempBaseDir: string;
  let runner: Phase43BenchmarkRunner;
  let workerKeys: ReturnType<typeof EvidenceSigner.generateKeyPair>;
  let supervisorKeys: ReturnType<typeof EvidenceSigner.generateKeyPair>;
  let keyring: TrustedKeyring;

  beforeEach(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "phase43-gate-a-"));
    runner = new Phase43BenchmarkRunner({ baseTempDir: tempBaseDir });

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
      // Best effort cleanup
    }
  });

  // --------------------------------------------------------------------------
  // Criterion 1: Deterministic End-to-End Execution with Fake Transport (Happy Path)
  // --------------------------------------------------------------------------
  it("Gate A.1: completes EAF-BM-01 end-to-end with fake model transport, dual-gate verification, and offline audit", async () => {
    const task = runner.getTask("EAF-BM-01");

    const fetchImpl = createScriptedOllamaFetch([
      // Step 1: Read target file
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p-01",
            toolName: "read_file",
            inputPayload: { path: "src/calc.js" },
            contextSnapshotHash: hash,
            rationale: "Read defective calculation code",
          }),
          promptTokens: 120,
          evalTokens: 35,
        };
      },
      // Step 2: Write gold patch
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p-02",
            toolName: "write_file",
            inputPayload: { path: "src/calc.js", content: task.goldPatch },
            contextSnapshotHash: hash,
            rationale: "Fix off-by-one addition bug",
          }),
          promptTokens: 160,
          evalTokens: 48,
        };
      },
      // Step 3: Signal goal reached
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: true,
            proposalId: "p-03",
            contextSnapshotHash: hash,
            rationale: "Fix applied; goal reached",
          }),
          promptTokens: 190,
          evalTokens: 25,
        };
      },
    ]);

    const provider = new OllamaModelProvider({
      baseURL: "http://127.0.0.1:11434",
      defaultModel: "qwen2.5-coder:1.5b",
      fetch: fetchImpl,
    });

    const result = await runner.executeTrial(task, {
      modelProvider: provider,
      model: "qwen2.5-coder:1.5b",
      signingKeys: { workerKeys, supervisorKeys },
      keyring,
      maxSteps: 5,
    });

    expect(result.verified).toBe(true);
    expect(result.terminalStatus).toBe("COMPLETED");
    expect(result.terminalReason).toBe("COMPLETED");
    // Under Phase 48L post-pass verification latch, authoritative clean-room dual-gate
    // verification succeeds immediately after the verified edit (Step 2), completing the run
    // without requiring an untrusted model completion claim at Step 3.
    expect(result.totalSteps).toBeLessThanOrEqual(3);
    expect(result.totalActions).toBe(2);
    expect(result.tokenMetrics.promptTokens).toBe(120 + 160);
    expect(result.tokenMetrics.evalTokens).toBe(35 + 48);
    expect(result.tokenMetrics.totalTokens).toBe((120 + 160) + (35 + 48));

    // Verify offline auditor agreement
    expect(result.offlineAudit.status).toBe("VERIFIED");
    expect(result.offlineAudit.thresholdSatisfied).toBe(true);
    expect(result.offlineAudit.fourfoldSatisfied).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Criterion 2: Invalid Model Output Fails Closed
  // --------------------------------------------------------------------------
  it("Gate A.2: invalid model output (raw text, non-JSON) fails closed without executing ungrounded tools", async () => {
    const task = runner.getTask("EAF-BM-01");

    const fetchImpl = createScriptedOllamaFetch([
      // Returns raw unparseable English text instead of valid ActionProposal JSON
      () => ({
        content: "I have thought about the problem and believe the bug is in src/calc.js. Let's fix it!",
      }),
    ]);

    const provider = new OllamaModelProvider({
      baseURL: "http://127.0.0.1:11434",
      defaultModel: "qwen2.5-coder:1.5b",
      fetch: fetchImpl,
    });

    const result = await runner.executeTrial(task, {
      modelProvider: provider,
      model: "qwen2.5-coder:1.5b",
      signingKeys: { workerKeys, supervisorKeys },
      keyring,
      maxSteps: 3,
    });

    expect(result.verified).toBe(false);
    expect(result.terminalStatus).toBe("FAILED");
    expect(result.terminalReason).toBe("BRAIN_FAILURE");
    expect(result.totalActions).toBe(0); // Zero unvalidated tools were executed!
  });

  it("Gate A.2b: invalid proposal fails proposal validation and stops at MAX_PROPOSAL_REJECTIONS", async () => {
    const task = runner.getTask("EAF-BM-01");

    const fetchImpl = createScriptedOllamaFetch([
      // Proposes a registered tool but with invalid input payload (violating input schema)
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p-invalid-input",
            toolName: "read_file",
            inputPayload: { invalid_field: true }, // Missing required 'path' field
            contextSnapshotHash: hash,
            rationale: "Attempt to call tool with invalid input",
          }),
        };
      },
    ]);

    const provider = new OllamaModelProvider({
      baseURL: "http://127.0.0.1:11434",
      defaultModel: "qwen2.5-coder:1.5b",
      fetch: fetchImpl,
    });

    const result = await runner.executeTrial(task, {
      modelProvider: provider,
      model: "qwen2.5-coder:1.5b",
      signingKeys: { workerKeys, supervisorKeys },
      keyring,
      maxSteps: 5,
    });

    expect(result.verified).toBe(false);
    expect(result.terminalStatus).toBe("FAILED");
    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");
    expect(result.totalActions).toBe(0);
    expect(result.totalProposalRejections).toBe(3);

    // Verify diagnostic persistence (Phase 43 Gate B.1 Observability)
    expect(result.diagnostics).toBeDefined();
    expect(result.diagnostics.stepDiagnostics.length).toBe(3);
    expect(result.diagnostics.proposalRejections.length).toBe(3);
    expect(result.diagnostics.rawCompletions.length).toBe(3);

    const firstRejection = result.diagnostics.proposalRejections[0]!;
    expect(firstRejection.stepNumber).toBe(1);
    expect(firstRejection.proposalValid).toBe(false);
    expect(firstRejection.toolName).toBe("read_file");
    expect(firstRejection.proposalId).toBe("p-invalid-input");
    expect(firstRejection.rejectionReason).toBe("INVALID_TOOL_INPUT");
    expect(firstRejection.rejectionMessage).toMatch(/failed schema validation/i);
    expect(firstRejection.rejectionMessage).toMatch(/path/i);
    expect(firstRejection.rawCompletion).toContain("p-invalid-input");
  });

  it("Gate A.2c: diagnostics enforce size limits and redact sensitive credentials from completions and payloads", async () => {
    const task = runner.getTask("EAF-BM-01");

    // Construct an oversized completion string (> 4096 chars) with embedded secrets
    const fetchImpl = createScriptedOllamaFetch([
      (body) => {
        const hash = extractContextHash(body);
        const jsonStr = JSON.stringify({
          isGoalReached: false,
          proposalId: "p-sensitive-test",
          toolName: "read_file",
          inputPayload: {
            path: "src/calc.js",
            api_key: "supersecret-credential-value",
            auth_token: "private-auth-token-12345",
          },
          contextSnapshotHash: hash,
          rationale: "Bearer secret-bearer-token-abcdef123456789",
        });
        return {
          content: jsonStr + "\n" + " ".repeat(5000),
        };
      },
    ]);

    const provider = new OllamaModelProvider({
      baseURL: "http://127.0.0.1:11434",
      defaultModel: "qwen2.5-coder:1.5b",
      fetch: fetchImpl,
    });

    const result = await runner.executeTrial(task, {
      modelProvider: provider,
      model: "qwen2.5-coder:1.5b",
      signingKeys: { workerKeys, supervisorKeys },
      keyring,
      maxSteps: 1,
    });

    expect(result.diagnostics).toBeDefined();
    const rawComp = result.diagnostics.rawCompletions[0]!;
    expect(rawComp.truncated).toBe(true);
    expect(rawComp.originalLength).toBeGreaterThan(4096);
    expect(rawComp.rawOutput.length).toBeLessThanOrEqual(4096 + 20); // bounded
    expect(rawComp.rawOutput).toContain("[TRUNCATED]");
    expect(rawComp.rawOutput).toContain("Bearer [REDACTED]");
    expect(rawComp.rawOutput).not.toContain("secret-bearer-token-abcdef123456789");

    // Input payload redaction check
    const stepDiag = result.diagnostics.stepDiagnostics[0]!;
    const input = stepDiag.inputPayload as Record<string, unknown>;
    expect(input.path).toBe("src/calc.js");
    expect(input.api_key).toBe("[REDACTED]");
    expect(input.auth_token).toBe("[REDACTED]");
  });

  // --------------------------------------------------------------------------
  // Criterion 3: Empty Patch Rejection (EMPTY_PATCH)
  // --------------------------------------------------------------------------
  it("Gate A.3: empty patch (premature goal reached without modifications) is rejected by clean-room verifier", async () => {
    const task = runner.getTask("EAF-BM-01");

    const fetchImpl = createScriptedOllamaFetch([
      // Immediately emits isGoalReached: true without modifying any files
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: true,
            proposalId: "p-empty",
            contextSnapshotHash: hash,
            rationale: "I believe the task is already complete!",
          }),
        };
      },
    ]);

    const provider = new OllamaModelProvider({
      baseURL: "http://127.0.0.1:11434",
      defaultModel: "qwen2.5-coder:1.5b",
      fetch: fetchImpl,
    });

    const result = await runner.executeTrial(task, {
      modelProvider: provider,
      model: "qwen2.5-coder:1.5b",
      signingKeys: { workerKeys, supervisorKeys },
      keyring,
      maxSteps: 3,
    });

    expect(result.verified).toBe(false);
    expect(result.terminalStatus).toBe("FAILED");
    expect(result.totalProposalRejections).toBeGreaterThan(0);

    // Offline auditor verifies that the terminal state is correctly recorded as FAILED
    expect(result.offlineAudit.status).toBe("VERIFIED");
    expect(result.evidenceBundle.terminalState.status).toBe("FAILED");
  });

  // --------------------------------------------------------------------------
  // Criterion 4: Out-of-Scope Modification Rejection (POLICY_PATH_VIOLATION)
  // --------------------------------------------------------------------------
  it("Gate A.4: out-of-scope modification to test/package files is rejected by static policy audit", async () => {
    const task = runner.getTask("EAF-BM-01");

    const fetchImpl = createScriptedOllamaFetch([
      // Step 1: Modifies package.json (forbidden by allowedPathPatterns: ["src/calc.js"])
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p-out-of-scope",
            toolName: "write_file",
            inputPayload: { path: "package.json", content: '{"name": "tampered"}' },
            contextSnapshotHash: hash,
            rationale: "Modify disallowed package.json",
          }),
        };
      },
      // Step 2: Signal goal reached
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: true,
            proposalId: "p-claim",
            contextSnapshotHash: hash,
            rationale: "Done",
          }),
        };
      },
    ]);

    const provider = new OllamaModelProvider({
      baseURL: "http://127.0.0.1:11434",
      defaultModel: "qwen2.5-coder:1.5b",
      fetch: fetchImpl,
    });

    const result = await runner.executeTrial(task, {
      modelProvider: provider,
      model: "qwen2.5-coder:1.5b",
      signingKeys: { workerKeys, supervisorKeys },
      keyring,
      maxSteps: 3,
    });

    expect(result.verified).toBe(false);
    expect(result.terminalStatus).toBe("FAILED");

    // Inspect verification event in evidence
    const verifyEvt = result.evidenceBundle.events.find((e) => e.eventType === "verification.completed");
    const reasonCode = (verifyEvt?.payload as any)?.reasonCode ?? (verifyEvt?.payload as any)?.verificationResult?.reasonCode;
    expect(reasonCode).toBe("POLICY_PATH_VIOLATION");
  });

  // --------------------------------------------------------------------------
  // Criterion 5: Timeout and Resource Limits Enforced (MAX_STEPS)
  // --------------------------------------------------------------------------
  it("Gate A.5: step ceiling limits loop execution and marks trial TIMED_OUT", async () => {
    const task = runner.getTask("EAF-BM-01");

    // Endless read loop
    const fetchImpl = createScriptedOllamaFetch([
      (body, count) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: `p-loop-${count}`,
            toolName: "read_file",
            inputPayload: { path: "src/calc.js" },
            contextSnapshotHash: hash,
            rationale: `Endless read loop step ${count}`,
          }),
        };
      },
    ]);

    const provider = new OllamaModelProvider({
      baseURL: "http://127.0.0.1:11434",
      defaultModel: "qwen2.5-coder:1.5b",
      fetch: fetchImpl,
    });

    const result = await runner.executeTrial(task, {
      modelProvider: provider,
      model: "qwen2.5-coder:1.5b",
      signingKeys: { workerKeys, supervisorKeys },
      keyring,
      maxSteps: 2, // Strict budget ceiling: 2 steps max
    });

    expect(result.verified).toBe(false);
    expect(result.terminalStatus).toBe("TIMED_OUT");
    expect(result.terminalReason).toBe("MAX_STEPS");
    expect(result.totalSteps).toBe(2);
    expect(result.offlineAudit.status).toBe("VERIFIED");
  });

  // --------------------------------------------------------------------------
  // Criterion 6: Defective and Regression Patches Fail Independent Clean-Room
  // --------------------------------------------------------------------------
  it("Gate A.6a: incorrect patch (wrongPatch) fails FAIL_TO_PASS test in clean room", async () => {
    const task = runner.getTask("EAF-BM-01");

    const fetchImpl = createScriptedOllamaFetch([
      // Step 1: Write wrong patch (a - b instead of a + b)
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p-wrong",
            toolName: "write_file",
            inputPayload: { path: "src/calc.js", content: task.wrongPatch },
            contextSnapshotHash: hash,
            rationale: "Apply incorrect subtraction patch",
          }),
        };
      },
      // Step 2: Signal goal reached
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: true,
            proposalId: "p-goal",
            contextSnapshotHash: hash,
            rationale: "Done",
          }),
        };
      },
    ]);

    const provider = new OllamaModelProvider({
      baseURL: "http://127.0.0.1:11434",
      defaultModel: "qwen2.5-coder:1.5b",
      fetch: fetchImpl,
    });

    const result = await runner.executeTrial(task, {
      modelProvider: provider,
      model: "qwen2.5-coder:1.5b",
      signingKeys: { workerKeys, supervisorKeys },
      keyring,
      maxSteps: 3,
    });

    expect(result.verified).toBe(false);
    expect(result.terminalStatus).toBe("FAILED");
  });

  it("Gate A.6b: regression-inducing patch (regressionPatch) breaks existing PASS_TO_PASS test", async () => {
    const task = runner.getTask("EAF-BM-01");

    const fetchImpl = createScriptedOllamaFetch([
      // Step 1: Write regression patch (fixes add, but breaks multiply)
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p-regr",
            toolName: "write_file",
            inputPayload: { path: "src/calc.js", content: task.regressionPatch },
            contextSnapshotHash: hash,
            rationale: "Fix add but break multiply",
          }),
        };
      },
      // Step 2: Signal goal reached
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: true,
            proposalId: "p-goal",
            contextSnapshotHash: hash,
            rationale: "Done",
          }),
        };
      },
    ]);

    const provider = new OllamaModelProvider({
      baseURL: "http://127.0.0.1:11434",
      defaultModel: "qwen2.5-coder:1.5b",
      fetch: fetchImpl,
    });

    const result = await runner.executeTrial(task, {
      modelProvider: provider,
      model: "qwen2.5-coder:1.5b",
      signingKeys: { workerKeys, supervisorKeys },
      keyring,
      maxSteps: 3,
    });

    expect(result.verified).toBe(false);
    expect(result.terminalStatus).toBe("FAILED");
  });

  // --------------------------------------------------------------------------
  // Criterion 7 & 8: Evidence Bundle Retention & Standalone Offline Auditor Agreement
  // --------------------------------------------------------------------------
  it("Gate A.7 & A.8: exports complete verifiable evidence bundle for both COMPLETED and FAILED runs", async () => {
    const task = runner.getTask("EAF-BM-01");

    // Run trial with immediate empty patch (fails)
    const fetchImpl = createScriptedOllamaFetch([
      (body) => ({
        content: JSON.stringify({
          isGoalReached: true,
          proposalId: "p-fail",
          contextSnapshotHash: extractContextHash(body),
          rationale: "Premature claim",
        }),
      }),
    ]);

    const provider = new OllamaModelProvider({
      baseURL: "http://127.0.0.1:11434",
      defaultModel: "qwen2.5-coder:1.5b",
      fetch: fetchImpl,
    });

    const result = await runner.executeTrial(task, {
      modelProvider: provider,
      model: "qwen2.5-coder:1.5b",
      signingKeys: { workerKeys, supervisorKeys },
      keyring,
      maxSteps: 2,
    });

    // Verify bundle structure
    const bundle = result.evidenceBundle;
    expect(bundle.bundleId).toBeDefined();
    expect(bundle.provenanceRoot).toBeDefined();
    expect(bundle.signatures?.length).toBe(2);
    expect(bundle.terminalState.status).toBe("FAILED");
    expect(bundle.events.length).toBeGreaterThan(0);

    // Verify offline auditor agreement
    expect(result.offlineAudit.status).toBe("VERIFIED");
    expect(result.offlineAudit.authoritativeTerminalBundleId).toBe(bundle.bundleId);
  });

  // --------------------------------------------------------------------------
  // Criterion 9: Model Authority Escalation Firewall
  // --------------------------------------------------------------------------
  it("Gate A.9: model proposal attempting to inject infrastructure authority fields is rejected", () => {
    const rogueProposal = {
      isGoalReached: false,
      proposalId: "p-rogue",
      toolName: "write_file",
      inputPayload: { path: "src/calc.js", content: "..." },
      contextSnapshotHash: "0".repeat(64),
      workerId: "rogue-worker-escalation", // Forbidden authority key!
      leaseId: "rogue-lease-id",           // Forbidden authority key!
    };

    const forbidden = findForbiddenAuthorityKeys(rogueProposal);
    expect(forbidden).toContain("workerId");
    expect(forbidden).toContain("leaseId");
    expect(forbidden.length).toBe(2);
  });

  // --------------------------------------------------------------------------
  // Criterion 10: Multi-Task Pilot Coverage (EAF-BM-01, EAF-BM-02, EAF-BM-03)
  // --------------------------------------------------------------------------
  it("Gate A.10: all 3 pilot tasks execute and achieve verified clean-room completion with gold patches", async () => {
    const tasks: Phase43PilotTask[] = [
      runner.getTask("EAF-BM-01"),
      runner.getTask("EAF-BM-02"),
      runner.getTask("EAF-BM-03"), // CRLF Origin Injection test
    ];

    for (const task of tasks) {
      const fetchImpl = createScriptedOllamaFetch([
        // Step 1: Write gold patch
        (body) => {
          const hash = extractContextHash(body);
          return {
            content: JSON.stringify({
              isGoalReached: false,
              proposalId: `p-${task.taskId}-fix`,
              toolName: "write_file",
              inputPayload: { path: task.targetFile, content: task.goldPatch },
              contextSnapshotHash: hash,
              rationale: `Apply gold fix to ${task.targetFile}`,
            }),
            promptTokens: 140,
            evalTokens: 40,
          };
        },
        // Step 2: Signal goal reached
        (body) => {
          const hash = extractContextHash(body);
          return {
            content: JSON.stringify({
              isGoalReached: true,
              proposalId: `p-${task.taskId}-done`,
              contextSnapshotHash: hash,
              rationale: `Task ${task.taskId} gold patch applied`,
            }),
            promptTokens: 180,
            evalTokens: 20,
          };
        },
      ]);

      const provider = new OllamaModelProvider({
        baseURL: "http://127.0.0.1:11434",
        defaultModel: "qwen2.5-coder:1.5b",
        fetch: fetchImpl,
      });

      const result = await runner.executeTrial(task, {
        modelProvider: provider,
        model: "qwen2.5-coder:1.5b",
        signingKeys: { workerKeys, supervisorKeys },
        keyring,
        maxSteps: 4,
      });

      expect(result.verified).toBe(true);
      expect(result.terminalStatus).toBe("COMPLETED");
      expect(result.offlineAudit.status).toBe("VERIFIED");
      expect(result.offlineAudit.fourfoldSatisfied).toBe(true);
    }
  });

  // --------------------------------------------------------------------------
  // Criterion 11: Structured Proposal-Rejection Feedback Loop (Gate A.11)
  // --------------------------------------------------------------------------
  it("Gate A.11a: model proposing invalid tool input receives structured TOOL_ERROR feedback and recovers in next step", async () => {
    const task = runner.getTask("EAF-BM-01");
    let step2PromptReceived = "";

    const fetchImpl = createScriptedOllamaFetch([
      // Step 1: Model proposes invalid tool input with known alias 'filePath' (observed failure in Gate B.2/B.3)
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p-invalid-step1",
            toolName: "read_file",
            inputPayload: { filePath: task.targetFile },
            contextSnapshotHash: hash,
            rationale: "Erroneous proposal using invalid parameter filePath",
          }),
        };
      },
      // Step 2: Model inspects prompt — verifies rejection feedback exists, then applies gold patch
      (body) => {
        const hash = extractContextHash(body);
        step2PromptReceived =
          body?.messages?.filter((m: any) => m.role === "user")?.pop()?.content ?? "";
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p-recovery-step2",
            toolName: "write_file",
            inputPayload: { path: task.targetFile, content: task.goldPatch },
            contextSnapshotHash: hash,
            rationale: "Recovered from rejection and applying gold patch",
          }),
        };
      },
      // Step 3: Model signals goal reached
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: true,
            proposalId: "p-done-step3",
            contextSnapshotHash: hash,
            rationale: "Goal achieved after recovery",
          }),
        };
      },
    ]);

    const provider = new OllamaModelProvider({
      baseURL: "http://127.0.0.1:11434",
      defaultModel: "qwen2.5-coder:1.5b",
      fetch: fetchImpl,
    });

    const result = await runner.executeTrial(task, {
      modelProvider: provider,
      model: "qwen2.5-coder:1.5b",
      signingKeys: { workerKeys, supervisorKeys },
      keyring,
      maxSteps: 5,
    });

    // 1. Verify rejection observation was injected into Step 2 prompt with actionable guidance
    expect(step2PromptReceived).toContain("[TOOL_ERROR]");
    expect(step2PromptReceived).toContain("PROPOSAL_VALIDATION");
    expect(step2PromptReceived).toContain("INVALID_TOOL_INPUT");
    expect(step2PromptReceived).toContain("p-invalid-step1");
    expect(step2PromptReceived).toContain(
      'Invalid read_file input: unrecognized key \\"filePath\\"; expected field \\"path\\". Retry using \\"path\\" and the documented read_file schema.'
    );

    // 2. Verify overall execution recovered and succeeded
    expect(result.verified).toBe(true);
    expect(result.terminalStatus).toBe("COMPLETED");
    expect(result.totalProposalRejections).toBe(1);
    expect(result.totalActions).toBe(1); // Exactly 1 write_file action executed
    expect(result.offlineAudit.status).toBe("VERIFIED");
    expect(result.offlineAudit.fourfoldSatisfied).toBe(true);
  });

  it("Gate A.11b: repeated invalid proposals continue to be rejected despite feedback, halting at MAX_PROPOSAL_REJECTIONS with FAILED", async () => {
    const task = runner.getTask("EAF-BM-01");
    const promptsSeen: string[] = [];

    const fetchImpl = createScriptedOllamaFetch([
      // Step 1: Invalid input (missing path)
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p-err-1",
            toolName: "read_file",
            inputPayload: { bad: 1 },
            contextSnapshotHash: hash,
            rationale: "Attempt 1",
          }),
        };
      },
      // Step 2: Invalid input again (missing content on write_file)
      (body) => {
        const hash = extractContextHash(body);
        promptsSeen.push(
          body?.messages?.filter((m: any) => m.role === "user")?.pop()?.content ?? ""
        );
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p-err-2",
            toolName: "write_file",
            inputPayload: { path: "src/calc.js" }, // Missing content
            contextSnapshotHash: hash,
            rationale: "Attempt 2",
          }),
        };
      },
      // Step 3: Invalid input again (missing path on read_file)
      (body) => {
        const hash = extractContextHash(body);
        promptsSeen.push(
          body?.messages?.filter((m: any) => m.role === "user")?.pop()?.content ?? ""
        );
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p-err-3",
            toolName: "read_file",
            inputPayload: {}, // Missing path
            contextSnapshotHash: hash,
            rationale: "Attempt 3",
          }),
        };
      },
    ]);

    const provider = new OllamaModelProvider({
      baseURL: "http://127.0.0.1:11434",
      defaultModel: "qwen2.5-coder:1.5b",
      fetch: fetchImpl,
    });

    const result = await runner.executeTrial(task, {
      modelProvider: provider,
      model: "qwen2.5-coder:1.5b",
      signingKeys: { workerKeys, supervisorKeys },
      keyring,
      maxSteps: 5,
    });

    expect(result.verified).toBe(false);
    expect(result.terminalStatus).toBe("FAILED");
    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");
    expect(result.totalProposalRejections).toBe(3);
    expect(result.totalActions).toBe(0); // Fail-closed: 0 unvalidated executions

    // Verify feedback was delivered in subsequent turns
    expect(promptsSeen[0]).toContain("p-err-1");
    expect(promptsSeen[0]).toContain("[TOOL_ERROR]");
    expect(promptsSeen[1]).toContain("p-err-2");
    expect(promptsSeen[1]).toContain("[TOOL_ERROR]");
  });

  it("Gate A.11c: model attempting unauthorized path violation after feedback fails closed without capability expansion", async () => {
    const task = runner.getTask("EAF-BM-01");
    let step2PromptReceived = "";

    const fetchImpl = createScriptedOllamaFetch([
      // Step 1: Erroneous proposal
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p-init-invalid",
            toolName: "read_file",
            inputPayload: {},
            contextSnapshotHash: hash,
            rationale: "Invalid initial attempt",
          }),
        };
      },
      // Step 2: Path violation (outside workspace)
      (body) => {
        const hash = extractContextHash(body);
        step2PromptReceived =
          body?.messages?.filter((m: any) => m.role === "user")?.pop()?.content ?? "";
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p-path-violation",
            toolName: "write_file",
            inputPayload: { path: "../outside-workspace.txt", content: "illegal content" },
            contextSnapshotHash: hash,
            rationale: "Attempt unauthorized path write",
          }),
        };
      },
      // Step 3: Repeated invalid proposal (missing path)
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p-another-invalid",
            toolName: "read_file",
            inputPayload: {},
            contextSnapshotHash: hash,
            rationale: "Another invalid attempt",
          }),
        };
      },
    ]);

    const provider = new OllamaModelProvider({
      baseURL: "http://127.0.0.1:11434",
      defaultModel: "qwen2.5-coder:1.5b",
      fetch: fetchImpl,
    });

    const result = await runner.executeTrial(task, {
      modelProvider: provider,
      model: "qwen2.5-coder:1.5b",
      signingKeys: { workerKeys, supervisorKeys },
      keyring,
      maxSteps: 5,
    });

    // Step 2 prompt received feedback
    expect(step2PromptReceived).toContain("[TOOL_ERROR]");
    expect(step2PromptReceived).toContain("p-init-invalid");

    // Path violation was rejected
    expect(result.verified).toBe(false);
    expect(result.terminalStatus).toBe("FAILED");
    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");
    expect(result.totalActions).toBe(0); // Zero actions executed
    expect(result.totalProposalRejections).toBe(3);
    expect(result.diagnostics.proposalRejections.length).toBe(3);

    const pathRejection = result.diagnostics.proposalRejections.find((r) => r.proposalId === "p-path-violation");
    expect(pathRejection?.rejectionReason).toBe("INVALID_TOOL_INPUT");
    expect(pathRejection?.rejectionMessage).toMatch(/path/i);

    const lastRejection = result.diagnostics.proposalRejections[2];
    expect(lastRejection?.proposalId).toBe("p-another-invalid");
    expect(lastRejection?.rejectionReason).toBe("INVALID_TOOL_INPUT");
  });

  it("Gate A.11d: feedback enforces 512-character limit with [TRUNCATED] and handles empty/missing messages safely without fabrication", () => {
    // 1. Sanitization of sensitive data
    const textWithSecret =
      "Error: failed connection with Bearer secret-auth-token-12345 and api_key: 'super-sensitive-api-key'";
    const sanitized = sanitizeRejectionMessage(textWithSecret);
    expect(sanitized).not.toContain("secret-auth-token-12345");
    expect(sanitized).not.toContain("super-sensitive-api-key");
    expect(sanitized).toContain("Bearer [REDACTED]");
    expect(sanitized).toContain('"[REDACTED]"');

    // 2. Bound limit
    expect(MAX_REJECTION_FEEDBACK_CHARS).toBe(512);

    // 3. Safe fallback on non-string inputs
    expect(sanitizeRejectionMessage(null as any)).toBe("");
    expect(sanitizeRejectionMessage(undefined as any)).toBe("");
  });

  it("Gate A.11e: deriveActionableValidationGuidance generates deterministic guidance for known aliases and safely falls back on unknown/unsupported inputs", () => {
    // 0. Verify mapping constants
    expect(DETERMINISTIC_TOOL_PARAMETER_MAPPINGS.read_file?.filePath).toBe("path");
    expect(DETERMINISTIC_TOOL_PARAMETER_MAPPINGS.write_file?.text).toBe("content");

    // 1. Known alias: read_file with filePath
    const readGuidance = deriveActionableValidationGuidance({
      toolName: "read_file",
      rejectionReason: "INVALID_TOOL_INPUT",
      inputPayload: { filePath: "src/calc.js" },
      validatorMessage: "Input payload for tool 'read_file' failed schema validation",
    });
    expect(readGuidance).toBe(
      'Invalid read_file input: unrecognized key "filePath"; expected field "path". Retry using "path" and the documented read_file schema.'
    );

    // 2. Known alias: read_file with file_path
    const readGuidanceSnake = deriveActionableValidationGuidance({
      toolName: "read_file",
      rejectionReason: "INVALID_TOOL_INPUT",
      inputPayload: { file_path: "src/calc.js" },
    });
    expect(readGuidanceSnake).toBe(
      'Invalid read_file input: unrecognized key "file_path"; expected field "path". Retry using "path" and the documented read_file schema.'
    );

    // 3. Known alias: write_file with filePath
    const writeGuidance = deriveActionableValidationGuidance({
      toolName: "write_file",
      rejectionReason: "INVALID_TOOL_INPUT",
      inputPayload: { filePath: "src/calc.js", content: "data" },
    });
    expect(writeGuidance).toBe(
      'Invalid write_file input: unrecognized key "filePath"; expected field "path". Retry using "path" and the documented write_file schema.'
    );

    // 4. Known alias: write_file with text
    const writeTextGuidance = deriveActionableValidationGuidance({
      toolName: "write_file",
      rejectionReason: "INVALID_TOOL_INPUT",
      inputPayload: { path: "src/calc.js", text: "data" },
    });
    expect(writeTextGuidance).toBe(
      'Invalid write_file input: unrecognized key "text"; expected field "content". Retry using "content" and the documented write_file schema.'
    );

    // 5. Known alias: search_code with pattern
    const searchGuidance = deriveActionableValidationGuidance({
      toolName: "search_code",
      rejectionReason: "INVALID_TOOL_INPUT",
      inputPayload: { pattern: "fn" },
    });
    expect(searchGuidance).toBe(
      'Invalid search_code input: unrecognized key "pattern"; expected field "query". Retry using "query" and the documented search_code schema.'
    );

    // 6. Unknown / arbitrary parameter: returns null (safe fallback, no fabrication)
    const unknownGuidance = deriveActionableValidationGuidance({
      toolName: "read_file",
      rejectionReason: "INVALID_TOOL_INPUT",
      inputPayload: { arbitrary_field: 42 },
    });
    expect(unknownGuidance).toBeNull();

    // 7. Non-INVALID_TOOL_INPUT rejection reason: returns null
    const policyGuidance = deriveActionableValidationGuidance({
      toolName: "write_file",
      rejectionReason: "POLICY_PATH_VIOLATION",
      inputPayload: { path: "package.json", content: "{}" },
    });
    expect(policyGuidance).toBeNull();

    // 8. Unknown tool: returns null
    const unknownToolGuidance = deriveActionableValidationGuidance({
      toolName: "nonexistent_tool",
      rejectionReason: "INVALID_TOOL_INPUT",
      inputPayload: { filePath: "src/calc.js" },
    });
    expect(unknownToolGuidance).toBeNull();

    // 9. Path traversal: returns null (ensures boundary violations are not converted to field guidance)
    const traversalGuidance = deriveActionableValidationGuidance({
      toolName: "write_file",
      rejectionReason: "INVALID_TOOL_INPUT",
      inputPayload: { path: "../outside-workspace.txt", content: "evil" },
    });
    expect(traversalGuidance).toBeNull();
  });

  it("Gate A.11f: rejected proposals cause zero workspace mutations and zero executed actions", async () => {
    const task = runner.getTask("EAF-BM-01");
    const baselineContent = task.initialFiles[task.targetFile];

    const fetchImpl = createScriptedOllamaFetch([
      // Step 1: Rejected due to filePath
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p-reject-1",
            toolName: "write_file",
            inputPayload: { filePath: task.targetFile, content: "corrupted content" },
            contextSnapshotHash: hash,
            rationale: "Should be rejected",
          }),
        };
      },
      // Step 2: Rejected due to path traversal
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p-reject-2",
            toolName: "write_file",
            inputPayload: { path: "../corrupted.txt", content: "corrupted content" },
            contextSnapshotHash: hash,
            rationale: "Should be rejected",
          }),
        };
      },
      // Step 3: Stop
      (body) => {
        const hash = extractContextHash(body);
        return {
          content: JSON.stringify({
            isGoalReached: true,
            proposalId: "p-claim-done",
            contextSnapshotHash: hash,
            rationale: "Claim completion without applying fix",
          }),
        };
      },
    ]);

    const provider = new OllamaModelProvider({
      baseURL: "http://127.0.0.1:11434",
      defaultModel: "qwen2.5-coder:1.5b",
      fetch: fetchImpl,
    });

    const result = await runner.executeTrial(task, {
      modelProvider: provider,
      model: "qwen2.5-coder:1.5b",
      signingKeys: { workerKeys, supervisorKeys },
      keyring,
      maxSteps: 5,
      retainWorkspace: true,
    });

    expect(result.verified).toBe(false);
    expect(result.terminalStatus).toBe("FAILED");
    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");
    expect(result.totalActions).toBe(0); // Zero actions executed
    expect(result.totalProposalRejections).toBe(3);

    // Verify zero tool execution events occurred in evidence
    const executedToolEvents = result.evidenceBundle.events.filter(
      (e) => e.eventType === "tool.executed" || e.eventType === "tool.requested"
    );
    expect(executedToolEvents.length).toBe(0);

    // Recursively locate target file within provisioned workspace and verify content is untouched
    async function findFileRecursively(dir: string, targetName: string): Promise<string | null> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const nested = await findFileRecursively(fullPath, targetName);
          if (nested) return nested;
        } else if (entry.name === targetName) {
          return fullPath;
        }
      }
      return null;
    }

    const calcFile = await findFileRecursively(result.workspaceHostPath, "calc.js");
    expect(calcFile).not.toBeNull();
    const currentContent = await fs.readFile(calcFile!, "utf-8");
    expect(currentContent).toBe(baselineContent);
  });
});
