/**
 * Milestone 2.25 Phase 2 — Contract-Bound Evaluation Runner Tests
 *
 * Verifies that evaluation task criteria bind directly to MissionContract.spec.verificationSpecs,
 * that the sovereign runtime verification gate determines verified success, and that
 * legacy tasks preserve backward compatibility without manufacturing verified success.
 *
 * 14 Focused Test Requirements:
 * 1. Each supported evaluation criterion maps to the correct runtime verification specification.
 * 2. Expected values and evidence requirements are preserved.
 * 3. Unsupported criteria are rejected explicitly.
 * 4. Missing criteria are not silently omitted (whole task is marked unsupported if any criterion fails).
 * 5. Benchmark contracts have non-empty verification specifications.
 * 6. Benchmark execution does not enable unverified completion.
 * 7. Runtime verification success produces VERIFIED_SUCCESS.
 * 8. Failed verification produces FALSE_COMPLETION only when evidence establishes a genuine failed criterion.
 * 9. Missing specs produce COMPLETION_UNVERIFIABLE.
 * 10. Unavailable verifiers produce COMPLETION_UNVERIFIABLE.
 * 11. CYCLE_DETECTED produces LOOP_DETECTED.
 * 12. Timeout and blocked outcomes remain distinct.
 * 13. Legacy Phase 9 tasks preserve their explicit opt-in behavior.
 * 14. Legacy opt-in cannot manufacture verified success.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  OllamaFetchLike,
  OllamaModelProvider,
} from "../../src/adapters/models/ollama-model-provider.js";
import {
  executeEvaluationRun,
  executeEvaluationTrial,
  ConstrainedHostExecutionProvider,
  correlateAuthoritativeVerificationEvents,
} from "../../src/application/evaluation/evaluation-runner.js";
import {
  translateCriterionToVerificationSpec,
  translateEvaluationTaskCriteria,
  createEvaluationTask,
  classifyTrialOutcome,
  type EvaluationCriterion,
} from "../../src/domain/evaluation.js";
import { createMissionContract } from "../../src/domain/mission-contract.js";
import { createVerificationSpec } from "../../src/domain/verification.js";
import type { ActionSnapshot } from "../../src/domain/action.js";
import type { AttemptSnapshot } from "../../src/domain/attempt.js";
import type { PersistedEvent } from "../../src/ports/state-store.port.js";

// ============================================================================
// Hermetic Mock Helpers
// ============================================================================

function extractContextHash(parsedBody: any): string {
  const messages = parsedBody?.messages ?? [];
  const lastMsg = messages[messages.length - 1]?.content ?? "";
  const match = lastMsg.match(/Context Snapshot Hash: ([a-f0-9]{64})/);
  return match ? match[1] : "0".repeat(64);
}

function createMockFetch(
  stepHandler: (step: number, body: any) => { content: string; evalCount?: number }
): { fetch: OllamaFetchLike } {
  let step = 0;
  const fetchImpl: OllamaFetchLike = async (_url, init) => {
    step++;
    const parsedBody = init?.body ? JSON.parse(String(init.body)) : {};
    const result = stepHandler(step, parsedBody);
    const responsePayload = {
      model: parsedBody.model || "test-eval-model",
      created_at: new Date().toISOString(),
      message: {
        role: "assistant",
        content: result.content,
      },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 50,
      eval_count: result.evalCount ?? 25,
    };
    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      statusText: "OK",
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetch: fetchImpl };
}

describe("Milestone 2.25 Phase 2: Contract-Bound Evaluation Runner", () => {
  // =========================================================================
  // 1. Supported Criteria Translation Mapping
  // =========================================================================
  it("Requirement 1: Each supported evaluation criterion maps to the correct runtime verification specification", () => {
    // 1a. COMMAND_EXIT_CODE with exitCode 0 -> EXIT_CODE_ZERO
    const cmdCriterion: EvaluationCriterion = {
      criterionId: "crit-cmd-test",
      kind: "COMMAND_EXIT_CODE",
      command: ["node", "test/calc.test.js"],
      expectedExitCode: 0,
      description: "Test suite must exit with code 0",
    };
    const cmdResult = translateCriterionToVerificationSpec(cmdCriterion);
    expect(cmdResult.supported).toBe(true);
    if (cmdResult.supported) {
      expect(cmdResult.verificationSpec.specId).toBe("crit-cmd-test");
      expect(cmdResult.verificationSpec.ruleKind).toBe("EXIT_CODE_ZERO");
    }

    // 1b. VERIFICATION_SPEC with CLEAN_ROOM_DUAL_GATE -> CLEAN_ROOM_DUAL_GATE
    const cleanRoomCriterion: EvaluationCriterion = {
      criterionId: "crit-clean-room",
      kind: "VERIFICATION_SPEC",
      verificationSpec: createVerificationSpec({
        specId: "clean-room-gate",
        ruleKind: "CLEAN_ROOM_DUAL_GATE",
        expectedValue: {
          specId: "cr-spec-1",
          baselineCommitSha: "a".repeat(40),
          failToPass: {
            testCommand: ["npm", "test"],
            expectedBaselineExitCode: 1,
            expectedPatchedExitCode: 0,
            minTestCount: 1,
            suiteRanRegex: "PASS",
          },
          passToPass: {
            testCommand: ["npm", "test"],
            expectedBaselineExitCode: 0,
            expectedPatchedExitCode: 0,
            minTestCount: 1,
            suiteRanRegex: "PASS",
          },
          allowedPathPatterns: ["src/**"],
          timeoutMs: 30000,
        },
      }),
    };
    const crResult = translateCriterionToVerificationSpec(cleanRoomCriterion);
    expect(crResult.supported).toBe(true);
    if (crResult.supported) {
      expect(crResult.verificationSpec.ruleKind).toBe("CLEAN_ROOM_DUAL_GATE");
    }

    // 1c. VERIFICATION_SPEC with EXACT_OUTPUT_MATCH -> EXACT_OUTPUT_MATCH
    const exactCriterion: EvaluationCriterion = {
      criterionId: "crit-exact",
      kind: "VERIFICATION_SPEC",
      verificationSpec: createVerificationSpec({
        specId: "exact-spec-1",
        ruleKind: "EXACT_OUTPUT_MATCH",
        expectedValue: { status: "OK" },
      }),
    };
    const exactResult = translateCriterionToVerificationSpec(exactCriterion);
    expect(exactResult.supported).toBe(true);
    if (exactResult.supported) {
      expect(exactResult.verificationSpec.ruleKind).toBe("EXACT_OUTPUT_MATCH");
    }
  });

  // =========================================================================
  // 2. Preservation of Expected Values and Evidence Requirements
  // =========================================================================
  it("Requirement 2: Expected values and evidence requirements are preserved during translation", () => {
    const cmdCriterion: EvaluationCriterion = {
      criterionId: "calc-tests-pass",
      kind: "COMMAND_EXIT_CODE",
      command: ["node", "test/calc.test.js", "--verbose"],
      expectedExitCode: 0,
    };
    const result = translateCriterionToVerificationSpec(cmdCriterion);
    expect(result.supported).toBe(true);
    if (result.supported) {
      expect(result.verificationSpec.specId).toBe("calc-tests-pass");
      const expected = result.verificationSpec.expectedValue as any;
      expect(expected).toBeDefined();
      expect(expected.toolName).toBe("run_command");
      expect(expected.argv).toEqual(["node", "test/calc.test.js", "--verbose"]);
    }
  });

  // =========================================================================
  // 3. Explicit Rejection of Unsupported Criteria
  // =========================================================================
  it("Requirement 3: Unsupported criteria are rejected explicitly with structured reason", () => {
    const unsupportedKinds: readonly EvaluationCriterion[] = [
      {
        criterionId: "c-file-exists",
        kind: "FILE_EXISTS",
        path: "src/calc.js",
      },
      {
        criterionId: "c-file-content",
        kind: "FILE_CONTENT_EQUALS",
        path: "src/calc.js",
        expectedContent: "return a + b;",
      },
      {
        criterionId: "c-text-contains",
        kind: "TEXT_CONTAINS",
        path: "src/calc.js",
        expectedSubstring: "add(a, b)",
      },
      {
        criterionId: "c-file-absent",
        kind: "FILE_ABSENT",
        path: "src/calc.bak",
      },
      {
        criterionId: "c-cmd-nonzero",
        kind: "COMMAND_EXIT_CODE",
        command: ["node", "test.js"],
        expectedExitCode: 1, // Non-zero exit code cannot be evaluated by EXIT_CODE_ZERO
      },
    ];

    for (const criterion of unsupportedKinds) {
      const result = translateCriterionToVerificationSpec(criterion);
      expect(result.supported).toBe(false);
      if (!result.supported) {
        expect(result.criterionId).toBe(criterion.criterionId);
        expect(result.reason.length).toBeGreaterThan(10);
      }
    }
  });

  // =========================================================================
  // 4. Invariant: Never Silently Omit Required Criteria
  // =========================================================================
  it("Requirement 4: Missing or untranslatable criteria are not silently omitted; entire task is marked unsupported", () => {
    const mixedTask = createEvaluationTask({
      taskId: "task-mixed-criteria",
      version: 1,
      description: "Mixed criteria test task",
      fixture: { initialFiles: { "src/calc.js": "test" } },
      mission: {
        requiredCapabilities: ["workspace.file.read", "process.execute"],
      },
      successCriteria: [
        {
          criterionId: "crit-pass",
          kind: "COMMAND_EXIT_CODE",
          command: ["node", "test.js"],
          expectedExitCode: 0,
        },
        {
          criterionId: "crit-unsupported",
          kind: "FILE_CONTENT_EQUALS",
          path: "src/calc.js",
          expectedContent: "test",
        },
      ],
      budget: { maxSteps: 5, maxActions: 5, maxWallClockMs: 10000 },
    });

    const translation = translateEvaluationTaskCriteria(mixedTask);
    expect(translation.supported).toBe(false);
    expect(translation.verificationSpecs).toHaveLength(0);
    expect(translation.unsupportedReasons.length).toBeGreaterThan(0);
    expect(translation.unsupportedReasons[0]).toContain("FILE_CONTENT_EQUALS");
  });

  // =========================================================================
  // 5. Benchmark Contracts Have Non-Empty Verification Specifications
  // =========================================================================
  it("Requirement 5: Benchmark contracts contain non-empty translated specifications before execution begins", async () => {
    const validBenchmarkTask = createEvaluationTask({
      taskId: "task-rel-non-empty-spec",
      version: 1,
      description: "Valid benchmark task with test verification",
      fixture: { initialFiles: { "test/ok.test.js": "process.exit(0);" } },
      mission: {
        requiredCapabilities: ["workspace.file.read", "process.execute"],
      },
      successCriteria: [
        {
          criterionId: "bench-test-pass",
          kind: "COMMAND_EXIT_CODE",
          command: ["node", "test/ok.test.js"],
          expectedExitCode: 0,
        },
      ],
      budget: { maxSteps: 5, maxActions: 5, maxWallClockMs: 10000 },
    });

    const translation = translateEvaluationTaskCriteria(validBenchmarkTask);
    expect(translation.supported).toBe(true);
    expect(translation.verificationSpecs).toHaveLength(1);
    expect(translation.verificationSpecs[0]!.specId).toBe("bench-test-pass");
    expect(translation.verificationSpecs[0]!.ruleKind).toBe("EXIT_CODE_ZERO");

    const { fetch } = createMockFetch((step, parsedBody) => {
      const hash = extractContextHash(parsedBody);
      if (step === 1) {
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p1",
            toolName: "run_command",
            inputPayload: { argv: ["node", "test/ok.test.js"] },
            contextSnapshotHash: hash,
            rationale: "Running verification test",
          }),
        };
      }
      return {
        content: JSON.stringify({
          isGoalReached: true,
          proposalId: "p2",
          contextSnapshotHash: hash,
          rationale: "Tests executed and passed",
        }),
      };
    });

    const provider = new OllamaModelProvider({ fetch, defaultModel: "test-eval-model" });
    const runResult = await executeEvaluationRun({
      task: validBenchmarkTask,
      modelProvider: provider,
      model: "test-eval-model",
    });

    // Contract was populated and authoritative verification was evaluated
    expect(runResult.verificationAssessment).toBeDefined();
    expect(runResult.verificationAssessment?.specCount).toBe(1);
    expect(runResult.verificationAssessment?.passedSpecCount).toBe(1);
    expect(runResult.finalOutcome).toBe("VERIFIED_SUCCESS");
  });

  // =========================================================================
  // 6. Benchmark Execution Does Not Enable Unverified Completion
  // =========================================================================
  it("Requirement 6: Benchmark execution defaults to allowUnverifiedCompletion = false and rejects unverified completion", async () => {
    const benchmarkTask = createEvaluationTask({
      taskId: "task-rel-fail-closed",
      version: 1,
      description: "Benchmark task requiring verification",
      fixture: { initialFiles: { "test.js": "process.exit(1);" } },
      mission: {
        requiredCapabilities: ["process.execute"],
      },
      successCriteria: [
        {
          criterionId: "bench-verify",
          kind: "COMMAND_EXIT_CODE",
          command: ["node", "test.js"],
          expectedExitCode: 0,
        },
      ],
      budget: { maxSteps: 2, maxActions: 2, maxWallClockMs: 10000 },
    });

    // Model immediately proposes completion without running verification command
    const { fetch } = createMockFetch((_step, parsedBody) => {
      const hash = extractContextHash(parsedBody);
      return {
        content: JSON.stringify({
          isGoalReached: true,
          proposalId: "p-claim",
          contextSnapshotHash: hash,
          rationale: "Claiming goal reached immediately",
        }),
      };
    });

    const provider = new OllamaModelProvider({ fetch, defaultModel: "test-eval-model" });
    const runResult = await executeEvaluationRun({
      task: benchmarkTask,
      modelProvider: provider,
      model: "test-eval-model",
      // allowUnverifiedCompletion is omitted -> strictly defaults to false!
    });

    // Model's completion claim was rejected by sovereign runtime gate
    expect(runResult.finalOutcome).not.toBe("VERIFIED_SUCCESS");
    expect(runResult.completionClaim?.claimed).toBe(true);
    // Transcript confirms goal claim was rejected due to unverified completion
    const rejectedEntry = runResult.transcript?.find(
      (e) => e.proposalRejectionReason === "UNVERIFIED_COMPLETION_CLAIM"
    );
    expect(rejectedEntry).toBeDefined();
    expect(rejectedEntry?.proposalValid).toBe(false);
  });

  // =========================================================================
  // 7. Runtime Verification Success Produces VERIFIED_SUCCESS
  // =========================================================================
  it("Requirement 7: Authoritative runtime verification produces VERIFIED_SUCCESS", async () => {
    const task = createEvaluationTask({
      taskId: "task-rel-verified-success",
      version: 1,
      description: "Benchmark task reaching verified completion",
      fixture: { initialFiles: { "test/suite.js": "process.exit(0);" } },
      mission: {
        requiredCapabilities: ["process.execute"],
      },
      successCriteria: [
        {
          criterionId: "crit-suite",
          kind: "COMMAND_EXIT_CODE",
          command: ["node", "test/suite.js"],
          expectedExitCode: 0,
        },
      ],
      budget: { maxSteps: 4, maxActions: 4, maxWallClockMs: 15000 },
    });

    const { fetch } = createMockFetch((step, parsedBody) => {
      const hash = extractContextHash(parsedBody);
      if (step === 1) {
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p1",
            toolName: "run_command",
            inputPayload: { argv: ["node", "test/suite.js"] },
            contextSnapshotHash: hash,
            rationale: "Running suite",
          }),
        };
      }
      return {
        content: JSON.stringify({
          isGoalReached: true,
          proposalId: "p2",
          contextSnapshotHash: hash,
          rationale: "Executed suite successfully",
        }),
      };
    });

    const provider = new OllamaModelProvider({ fetch, defaultModel: "test-eval-model" });
    const trial = await executeEvaluationTrial({
      task,
      modelProvider: provider,
      model: "test-eval-model",
      trialOrdinal: 1,
    });

    expect(trial.finalOutcome).toBe("VERIFIED_SUCCESS");
    expect(trial.completionClaim?.claimed).toBe(true);
    expect(trial.verificationAssessment?.decision).toBe("VERIFIED");
    expect(trial.verificationAssessment?.reasonCode).toBe("AUTHORITATIVE_VERIFIED");
    expect(trial.verificationAssessment?.passedSpecCount).toBe(1);
    expect(trial.verificationAssessment?.failedSpecCount).toBe(0);
  });

  // =========================================================================
  // 8. Failed Verification Produces FALSE_COMPLETION on Genuine Failed Evidence
  // =========================================================================
  it("Requirement 8: Failed verification produces FALSE_COMPLETION when model claimed completion and verification evidence failed", () => {
    // 8a. Model claimed completion + verification evidence failed -> FALSE_COMPLETION
    const falseCompletion = classifyTrialOutcome({
      terminalReason: "COMPLETED",
      modelCompletionClaim: {
        claimed: true,
        finishReason: "GOAL_REACHED",
        rationale: "I completed the fix",
      },
      verificationAssessment: {
        decision: "REJECTED",
        reasonCode: "SPEC_ASSERTION_FAILED",
        specCount: 1,
        passedSpecCount: 0,
        failedSpecCount: 1,
        message: "Test suite exited with code 1, expected 0",
      },
      postRunCriteriaPassed: false,
    });
    expect(falseCompletion.outcome).toBe("FALSE_COMPLETION");
    expect(falseCompletion.modelClaimedCompletion).toBe(true);
    expect(falseCompletion.verificationReasonCode).toBe("SPEC_ASSERTION_FAILED");

    // 8b. Contrast: When model did NOT claim completion -> EXECUTION_FAILURE
    const failureWithoutClaim = classifyTrialOutcome({
      terminalReason: "MAX_FAILURES",
      modelCompletionClaim: { claimed: false },
      verificationAssessment: {
        decision: "REJECTED",
        reasonCode: "SPEC_ASSERTION_FAILED",
      },
    });
    expect(failureWithoutClaim.outcome).toBe("EXECUTION_FAILURE");
    expect(failureWithoutClaim.modelClaimedCompletion).toBe(false);
  });

  // =========================================================================
  // 9. Missing Specs Produce COMPLETION_UNVERIFIABLE
  // =========================================================================
  it("Requirement 9: Missing specifications produce COMPLETION_UNVERIFIABLE when completion is claimed under fail-closed rules", () => {
    const result = classifyTrialOutcome({
      terminalReason: "COMPLETION_UNVERIFIABLE",
      modelCompletionClaim: { claimed: true, finishReason: "GOAL_REACHED" },
      verificationAssessment: {
        decision: "UNVERIFIABLE",
        reasonCode: "NO_VERIFICATION_SPECS",
        specCount: 0,
      },
      allowUnverifiedCompletion: false,
    });

    expect(result.outcome).toBe("COMPLETION_UNVERIFIABLE");
    expect(result.verificationReasonCode).toBe("NO_VERIFICATION_SPECS");
    expect(result.outcome).not.toBe("VERIFIED_SUCCESS");
    expect(result.outcome).not.toBe("FALSE_COMPLETION");
  });

  // =========================================================================
  // 10. Unavailable Verifiers Produce COMPLETION_UNVERIFIABLE
  // =========================================================================
  it("Requirement 10: Unavailable verifier produces COMPLETION_UNVERIFIABLE and is never misclassified as FALSE_COMPLETION", () => {
    const result = classifyTrialOutcome({
      terminalReason: "COMPLETION_UNVERIFIABLE",
      terminalMessage: "Clean-room dual-gate verifier unavailable on host",
      modelCompletionClaim: { claimed: true, finishReason: "GOAL_REACHED" },
      verificationAssessment: {
        decision: "UNVERIFIABLE",
        reasonCode: "VERIFIER_UNAVAILABLE",
        specCount: 1,
      },
      allowUnverifiedCompletion: false,
    });

    expect(result.outcome).toBe("COMPLETION_UNVERIFIABLE");
    expect(result.verificationReasonCode).toBe("VERIFIER_UNAVAILABLE");
    expect(result.outcome).not.toBe("FALSE_COMPLETION");
  });

  // =========================================================================
  // 11. CYCLE_DETECTED Produces LOOP_DETECTED
  // =========================================================================
  it("Requirement 11: CYCLE_DETECTED maps cleanly to LOOP_DETECTED", () => {
    const loopResult = classifyTrialOutcome({
      terminalReason: "CYCLE_DETECTED",
      terminalMessage: "Repeated cycle of length 2 detected without progress",
      modelCompletionClaim: { claimed: false },
      verificationAssessment: { decision: "NOT_EVALUATED" },
    });

    expect(loopResult.outcome).toBe("LOOP_DETECTED");
    expect(loopResult.reason).toContain("CYCLE_DETECTED");
  });

  // =========================================================================
  // 12. Timeout and Blocked Outcomes Remain Distinct
  // =========================================================================
  it("Requirement 12: Resource exhaustion (TIMEOUT) and governance fencing (BLOCKED) remain distinct", () => {
    const timeout = classifyTrialOutcome({
      terminalReason: "MAX_STEPS",
      modelCompletionClaim: { claimed: false },
      verificationAssessment: { decision: "NOT_EVALUATED" },
    });
    expect(timeout.outcome).toBe("TIMEOUT");

    const blocked = classifyTrialOutcome({
      terminalReason: "LEASE_LOST",
      modelCompletionClaim: { claimed: false },
      verificationAssessment: { decision: "NOT_EVALUATED" },
    });
    expect(blocked.outcome).toBe("BLOCKED");

    expect(timeout.outcome).not.toBe(blocked.outcome);
  });

  // =========================================================================
  // 13. Legacy Phase 9 Tasks Preserve Explicit Opt-in Behavior
  // =========================================================================
  it("Requirement 13: Phase 9 reflex tasks preserve explicit allowUnverifiedCompletion opt-in and report legacy PASSED status", async () => {
    const legacyTask = createEvaluationTask({
      taskId: "task-swe-legacy-calc",
      version: 1,
      description: "Legacy calculator bug fix",
      fixture: { initialFiles: { "src/calc.js": "function add(a, b) { return a - b; }" } },
      mission: { requiredCapabilities: ["workspace.file.read", "workspace.file.write"] },
      successCriteria: [
        {
          criterionId: "calc-content-fixed",
          kind: "FILE_CONTENT_EQUALS",
          path: "src/calc.js",
          expectedContent: "function add(a, b) { return a + b; }",
        },
      ],
      budget: { maxSteps: 3, maxActions: 3, maxWallClockMs: 15000 },
    });

    const { fetch } = createMockFetch((step, parsedBody) => {
      const hash = extractContextHash(parsedBody);
      if (step === 1) {
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p1",
            toolName: "write_file",
            inputPayload: { path: "src/calc.js", content: "function add(a, b) { return a + b; }" },
            contextSnapshotHash: hash,
            rationale: "Fixing calculator bug",
          }),
        };
      }
      return {
        content: JSON.stringify({
          isGoalReached: true,
          proposalId: "p2",
          contextSnapshotHash: hash,
          rationale: "Fixed calculator implementation",
        }),
      };
    });

    const provider = new OllamaModelProvider({ fetch, defaultModel: "test-eval-model" });
    const runResult = await executeEvaluationRun({
      task: legacyTask,
      modelProvider: provider,
      model: "test-eval-model",
      allowUnverifiedCompletion: true, // Explicit legacy opt-in
    });

    // Legacy status and verificationPassed fields behave identically to Phase 9
    expect(runResult.status).toBe("PASSED");
    expect(runResult.verificationPassed).toBe(true);
    expect(runResult.agentClaimedGoal).toBe(true);
  });

  // =========================================================================
  // 14. Legacy Opt-in Cannot Manufacture Verified Success
  // =========================================================================
  it("Requirement 14: Legacy opt-in cannot manufacture verified success in sovereign finalOutcome", async () => {
    const legacyTask = createEvaluationTask({
      taskId: "task-swe-legacy-optin",
      version: 1,
      description: "Legacy task testing finalOutcome safety",
      fixture: { initialFiles: { "src/calc.js": "function add() {}" } },
      mission: { requiredCapabilities: ["workspace.file.read", "workspace.file.write"] },
      successCriteria: [
        {
          criterionId: "calc-fixed",
          kind: "FILE_CONTENT_EQUALS",
          path: "src/calc.js",
          expectedContent: "fixed",
        },
      ],
      budget: { maxSteps: 3, maxActions: 3, maxWallClockMs: 15000 },
    });

    const { fetch } = createMockFetch((step, parsedBody) => {
      const hash = extractContextHash(parsedBody);
      if (step === 1) {
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p1",
            toolName: "write_file",
            inputPayload: { path: "src/calc.js", content: "fixed" },
            contextSnapshotHash: hash,
            rationale: "Fixing",
          }),
        };
      }
      return {
        content: JSON.stringify({
          isGoalReached: true,
          proposalId: "p2",
          contextSnapshotHash: hash,
          rationale: "Fixed",
        }),
      };
    });

    const provider = new OllamaModelProvider({ fetch, defaultModel: "test-eval-model" });
    const trial = await executeEvaluationTrial({
      task: legacyTask,
      modelProvider: provider,
      model: "test-eval-model",
      trialOrdinal: 1,
      allowUnverifiedCompletion: true,
    });

    // Legacy outcome is PASSED for backward compatibility
    expect(trial.outcome).toBe("PASSED");
    expect(trial.verificationPassed).toBe(true);

    // BUT sovereign finalOutcome is COMPLETION_UNVERIFIABLE!
    // An unverified run can NEVER be marked VERIFIED_SUCCESS!
    expect(trial.finalOutcome).toBe("COMPLETION_UNVERIFIABLE");
    expect(trial.finalOutcome).not.toBe("VERIFIED_SUCCESS");
    expect(trial.verificationAssessment?.reasonCode).toBe("NO_VERIFICATION_SPECS");
  });

  // =========================================================================
  // 15. ConstrainedHostExecutionProvider Threat Model & Boundary Enforcement
  // =========================================================================
  it("Requirement 15: ConstrainedHostExecutionProvider rejects unauthorized executables with POLICY_DENIED", async () => {
    const provider = new ConstrainedHostExecutionProvider();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-exec-sec-test-"));
    try {
      const unauthorizedBinaries = ["curl", "bash", "sh", "powershell", "cmd.exe", "rm", "python"];
      for (const bin of unauthorizedBinaries) {
        const result = await provider.execute({
          runId: "run-test-15",
          taskId: "task-sec-15",
          operationName: "run_command",
          inputPayload: { argv: [bin, "--help"] },
          idempotencyToken: "tok-15",
          attemptNumber: 1,
          timeoutMs: 5000,
          workspace: {
            workspaceId: "ws-15",
            hostPath: tempDir,
          },
        });

        expect(result.status).toBe("FAILED");
        expect(result.error?.code).toBe("EXECUTION_FAILED");
        expect(result.error?.message).toContain("POLICY_DENIED");
        expect(result.error?.message).toContain("is unauthorized");
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 16. ConstrainedHostExecutionProvider Rejects Forbidden Node Flags
  // =========================================================================
  it("Requirement 16: ConstrainedHostExecutionProvider rejects dangerous Node evaluation and loader flags with POLICY_DENIED", async () => {
    const provider = new ConstrainedHostExecutionProvider();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-node-flags-test-"));
    try {
      const forbiddenFlags = ["-e", "--eval", "-p", "--print", "--loader", "--import", "-r", "--require", "--inspect"];
      for (const flag of forbiddenFlags) {
        const result = await provider.execute({
          runId: "run-test-16",
          taskId: "task-sec-16",
          operationName: "run_command",
          inputPayload: { argv: ["node", flag, "console.log(1)"] },
          idempotencyToken: "tok-16",
          attemptNumber: 1,
          timeoutMs: 5000,
          workspace: {
            workspaceId: "ws-16",
            hostPath: tempDir,
          },
        });

        expect(result.status).toBe("FAILED");
        expect(result.error?.code).toBe("EXECUTION_FAILED");
        expect(result.error?.message).toContain("POLICY_DENIED");
        expect(result.error?.message).toContain("is forbidden");
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 17. ConstrainedHostExecutionProvider Rejects Workspace Boundary Escapes
  // =========================================================================
  it("Requirement 17: ConstrainedHostExecutionProvider rejects directory traversal and workspace escaping paths", async () => {
    const provider = new ConstrainedHostExecutionProvider();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-escape-test-"));
    try {
      // 17a. Working directory escaping workspace
      const resultCwdEscape = await provider.execute({
        runId: "run-test-17a",
        taskId: "task-sec-17",
        operationName: "run_command",
        inputPayload: { argv: ["node", "script.js"], cwd: "../outside" },
        idempotencyToken: "tok-17a",
        attemptNumber: 1,
        timeoutMs: 5000,
        workspace: {
          workspaceId: "ws-17a",
          hostPath: tempDir,
        },
      });

      expect(resultCwdEscape.status).toBe("FAILED");
      expect(resultCwdEscape.error?.code).toBe("EXECUTION_FAILED");
      expect(resultCwdEscape.error?.message).toContain("WORKSPACE_BOUNDARY_VIOLATION");

      // 17b. Script file argument escaping workspace via relative traversal
      const outsideScript = path.resolve(tempDir, "../outside-script.js");
      fs.writeFileSync(outsideScript, "process.exit(0);", "utf8");

      try {
        const resultScriptEscape = await provider.execute({
          runId: "run-test-17b",
          taskId: "task-sec-17",
          operationName: "run_command",
          inputPayload: { argv: ["node", "../outside-script.js"] },
          idempotencyToken: "tok-17b",
          attemptNumber: 1,
          timeoutMs: 5000,
          workspace: {
            workspaceId: "ws-17b",
            hostPath: tempDir,
          },
        });

        expect(resultScriptEscape.status).toBe("FAILED");
        expect(resultScriptEscape.error?.code).toBe("EXECUTION_FAILED");
        expect(resultScriptEscape.error?.message).toContain("WORKSPACE_BOUNDARY_VIOLATION");
      } finally {
        fs.rmSync(outsideScript, { force: true });
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 18. ConstrainedHostExecutionProvider Scrubs Secrets & Enforces Hermetic Env
  // =========================================================================
  it("Requirement 18: ConstrainedHostExecutionProvider scrubs host secrets and passes hermetic environment", async () => {
    const provider = new ConstrainedHostExecutionProvider();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-env-scrub-test-"));
    try {
      // Set a fake host secret in current Node process
      const secretKey = "TEST_SECRET_HOST_TOKEN_ABC123";
      process.env.EMERALD_TEST_HOST_SECRET = secretKey;

      const testScript = path.join(tempDir, "check-env.js");
      fs.writeFileSync(
        testScript,
        `
        if (process.env.EMERALD_TEST_HOST_SECRET) {
          console.error("SECRET_LEAKED");
          process.exit(1);
        }
        if (process.env.EMERALD_EVALUATION !== "1") {
          console.error("MISSING_EVAL_FLAG");
          process.exit(2);
        }
        process.exit(0);
        `,
        "utf8"
      );

      const result = await provider.execute({
        runId: "run-test-18",
        taskId: "task-sec-18",
        operationName: "run_command",
        inputPayload: { argv: ["node", "check-env.js"] },
        idempotencyToken: "tok-18",
        attemptNumber: 1,
        timeoutMs: 5000,
        workspace: {
          workspaceId: "ws-18",
          hostPath: tempDir,
        },
      });

      expect(result.status).toBe("SUCCESS");
      const output = result.output as any;
      expect(output.exitCode).toBe(0);
      expect(output.stderr).toBe("");

      delete process.env.EMERALD_TEST_HOST_SECRET;
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 19. Authoritative Verification Event Provenance & Correlation
  // =========================================================================
  it("Requirement 19: Evaluation runner correlates events strictly by runId, producer, and bound contract specId", async () => {
    const task = createEvaluationTask({
      taskId: "task-rel-provenance",
      version: 1,
      description: "Provenance and correlation test",
      fixture: { initialFiles: { "test.js": "process.exit(0);" } },
      mission: { requiredCapabilities: ["process.execute"] },
      successCriteria: [
        {
          criterionId: "spec-correct-run",
          kind: "COMMAND_EXIT_CODE",
          command: ["node", "test.js"],
          expectedExitCode: 0,
        },
      ],
      budget: { maxSteps: 3, maxActions: 3, maxWallClockMs: 15000 },
    });

    const { fetch } = createMockFetch((step, parsedBody) => {
      const hash = extractContextHash(parsedBody);
      if (step === 1) {
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p1",
            toolName: "run_command",
            inputPayload: { argv: ["node", "test.js"] },
            contextSnapshotHash: hash,
            rationale: "Running verification",
          }),
        };
      }
      return {
        content: JSON.stringify({
          isGoalReached: true,
          proposalId: "p2",
          contextSnapshotHash: hash,
          rationale: "Verified and finished",
        }),
      };
    });

    const provider = new OllamaModelProvider({ fetch, defaultModel: "test-eval-model" });
    const runResult = await executeEvaluationRun({
      task,
      modelProvider: provider,
      model: "test-eval-model",
    });

    expect(runResult.finalOutcome).toBe("VERIFIED_SUCCESS");
    expect(runResult.verificationAssessment?.decision).toBe("VERIFIED");
    expect(runResult.verificationAssessment?.reasonCode).toBe("AUTHORITATIVE_VERIFIED");
    expect(runResult.verificationAssessment?.specResults).toHaveLength(1);
    expect(runResult.verificationAssessment?.specResults?.[0]?.specId).toBe("spec-correct-run");
  });

  // =========================================================================
  // 20. Temporal Sequence Resolution for Verification Events
  // =========================================================================
  it("Requirement 20: Temporal sequence resolution accurately supersedes earlier attempts with latest assessment", () => {
    // 20a. Attempt 1 failed, but Attempt 2 passed -> outcome is VERIFIED
    const resolvedPass = classifyTrialOutcome({
      terminalReason: "COMPLETED",
      modelCompletionClaim: { claimed: true },
      verificationAssessment: {
        decision: "VERIFIED",
        reasonCode: "AUTHORITATIVE_VERIFIED",
        specCount: 1,
        passedSpecCount: 1,
        failedSpecCount: 0,
      },
      postRunCriteriaPassed: true,
    });
    expect(resolvedPass.outcome).toBe("VERIFIED_SUCCESS");

    // 20b. Attempt 1 passed, but Attempt 2 broke code and failed -> outcome is FALSE_COMPLETION
    const resolvedFail = classifyTrialOutcome({
      terminalReason: "COMPLETED",
      modelCompletionClaim: { claimed: true },
      verificationAssessment: {
        decision: "REJECTED",
        reasonCode: "SPEC_ASSERTION_FAILED",
        specCount: 1,
        passedSpecCount: 0,
        failedSpecCount: 1,
        message: "Process exit code was 1, expected 0",
      },
      postRunCriteriaPassed: false,
    });
    expect(resolvedFail.outcome).toBe("FALSE_COMPLETION");
  });

  // =========================================================================
  // 21. Complete Matrix: Fencing DEFERRED & Unverified Completion Non-Manufacture
  // =========================================================================
  it("Requirement 21: Full outcome classification matrix covers DEFERRED and prevents unverified success", () => {
    // 21a. DEFERRED produces BLOCKED
    const deferredOutcome = classifyTrialOutcome({
      terminalReason: "DEFERRED",
      terminalMessage: "Lease lost or recovery deferred",
      modelCompletionClaim: { claimed: false },
      verificationAssessment: { decision: "UNVERIFIABLE", specCount: 0, passedSpecCount: 0, failedSpecCount: 0 },
    });
    expect(deferredOutcome.outcome).toBe("BLOCKED");

    // 21b. Even if all specs passed, allowUnverifiedCompletion = true CANNOT produce VERIFIED_SUCCESS
    const unverifiedBlockedFromVerifiedSuccess = classifyTrialOutcome({
      terminalReason: "COMPLETED",
      modelCompletionClaim: { claimed: true },
      verificationAssessment: {
        decision: "VERIFIED",
        reasonCode: "AUTHORITATIVE_VERIFIED",
        specCount: 1,
        passedSpecCount: 1,
        failedSpecCount: 0,
      },
      postRunCriteriaPassed: true,
      allowUnverifiedCompletion: true,
    });
    expect(unverifiedBlockedFromVerifiedSuccess.outcome).toBe("COMPLETION_UNVERIFIABLE");
    expect(unverifiedBlockedFromVerifiedSuccess.outcome).not.toBe("VERIFIED_SUCCESS");
  });

  // =========================================================================
  // Milestone 2.25 Phase 2.2: Verification Authority & Execution-Attempt Correlation
  // =========================================================================
  describe("Milestone 2.25 Phase 2.2: Verification Authority & Execution-Attempt Correlation", () => {
    const contract = createMissionContract({
      contractId: "contract-authority-test",
      taskId: "task-authority-test",
      version: 1,
      status: "ACTIVE",
      policy: {
        policyId: "policy-authority-test",
        allowedCapabilities: ["process.execute"],
        isolationRequirement: "ISOLATED",
      },
      resourceLimits: { timeoutMs: 30000, maxAttempts: 5, maxOutputBytes: 1048576 },
      verificationSpecs: [
        {
          specId: "spec-exit-zero",
          ruleKind: "EXIT_CODE_ZERO",
          expectedValue: { toolName: "run_command", argv: ["node", "test.js"] },
        },
      ],
    });

    const runId = "run-eval-trial-authority-1";
    const targetAction: ActionSnapshot = {
      actionId: "act-run-cmd-1",
      sequenceNumber: 1,
      runId,
      toolName: "run_command",
      inputPayload: { argv: ["node", "test.js"] },
      inputHash: "0".repeat(64),
      idempotency: "IDEMPOTENT",
      contractBinding: { contractId: "contract-authority-test", version: 1, contentHash: "0".repeat(64) },
      maxAttempts: 3,
      status: "SUCCEEDED",
      activeAttemptNumber: null,
      totalAttempts: 1,
      resultPayload: { exitCode: 0 },
      errorPayload: null,
      completedAt: "2026-11-06T10:00:01.000Z",
      createdAt: "2026-11-06T10:00:00.000Z",
      updatedAt: "2026-11-06T10:00:01.000Z",
    };

    function createMockAttempt(attemptNumber: number, status: "SUCCEEDED" | "FAILED" = "SUCCEEDED"): AttemptSnapshot {
      return {
        attemptId: `att-${attemptNumber}`,
        actionId: targetAction.actionId,
        runId,
        attemptNumber,
        workerId: "worker-1",
        leaseId: "lease-1",
        idempotencyToken: `token-${attemptNumber}`,
        status,
        startedAt: "2026-11-06T10:00:00.000Z",
        completedAt: "2026-11-06T10:00:01.000Z",
        durationMs: 1000,
        exitCode: status === "SUCCEEDED" ? 0 : 1,
        outputPayload: { exitCode: status === "SUCCEEDED" ? 0 : 1 },
        errorPayload: null,
        evidenceIds: [],
      };
    }

    function createVerificationEvent(params: {
      runId?: string;
      specId?: string;
      producer?: string;
      verifierId?: string;
      schemaVersion?: number;
      sequence?: number;
      status: "VERIFIED" | "FAILED";
      details?: Record<string, unknown>;
    }): PersistedEvent {
      return {
        eventId: crypto.randomUUID(),
        runId: params.runId ?? runId,
        timestamp: "2026-11-06T10:00:02.000Z",
        sequence: params.sequence ?? 1,
        schemaVersion: params.schemaVersion ?? 1,
        producer: params.producer ?? "application.verifier",
        eventType: "verification.completed",
        payload: {
          runId: params.runId ?? runId,
          verifierId: params.verifierId ?? "deterministic-verifier-v1",
          specId: params.specId ?? "spec-exit-zero",
          status: params.status,
          evidenceIds: ["ev-1"],
          message: params.status === "VERIFIED" ? "Process exit code is 0" : "Process exit code was 1",
          details: params.details,
          verifiedAt: "2026-11-06T10:00:02.000Z",
        },
      };
    }

    // Scenario 1: Earlier attempt passes, final attempt fails
    it("Scenario 1: Earlier attempt passes, final attempt fails -> resolves to FAILED (earlier pass not credited)", () => {
      const attempts = [createMockAttempt(1, "SUCCEEDED"), createMockAttempt(2, "FAILED")];
      const events: PersistedEvent[] = [
        createVerificationEvent({
          sequence: 1,
          status: "VERIFIED",
          details: {
            contractId: "contract-authority-test",
            contractVersion: 1,
            actionId: targetAction.actionId,
            attemptId: "att-1",
            attemptNumber: 1,
          },
        }),
        createVerificationEvent({
          sequence: 2,
          status: "FAILED",
          details: {
            contractId: "contract-authority-test",
            contractVersion: 1,
            actionId: targetAction.actionId,
            attemptId: "att-2",
            attemptNumber: 2,
          },
        }),
      ];

      const verdicts = correlateAuthoritativeVerificationEvents({
        runId,
        contract,
        actions: [targetAction],
        getAttemptsForAction: () => attempts,
        events,
      });

      const verdict = verdicts.get("spec-exit-zero");
      expect(verdict).toBeDefined();
      expect(verdict?.status).toBe("FAILED");
      expect(verdict?.targetAttempt?.attemptNumber).toBe(2);
      expect((verdict?.details as any)?.attemptNumber).toBe(2);
    });

    // Scenario 2: Earlier attempt fails, final attempt passes
    it("Scenario 2: Earlier attempt fails, final attempt passes -> resolves to VERIFIED", () => {
      const attempts = [createMockAttempt(1, "FAILED"), createMockAttempt(2, "SUCCEEDED")];
      const events: PersistedEvent[] = [
        createVerificationEvent({
          sequence: 1,
          status: "FAILED",
          details: {
            contractId: "contract-authority-test",
            contractVersion: 1,
            actionId: targetAction.actionId,
            attemptId: "att-1",
            attemptNumber: 1,
          },
        }),
        createVerificationEvent({
          sequence: 2,
          status: "VERIFIED",
          details: {
            contractId: "contract-authority-test",
            contractVersion: 1,
            actionId: targetAction.actionId,
            attemptId: "att-2",
            attemptNumber: 2,
          },
        }),
      ];

      const verdicts = correlateAuthoritativeVerificationEvents({
        runId,
        contract,
        actions: [targetAction],
        getAttemptsForAction: () => attempts,
        events,
      });

      const verdict = verdicts.get("spec-exit-zero");
      expect(verdict).toBeDefined();
      expect(verdict?.status).toBe("VERIFIED");
      expect(verdict?.targetAttempt?.attemptNumber).toBe(2);
      expect((verdict?.details as any)?.attemptNumber).toBe(2);
    });

    // Scenario 3: Duplicate verification events
    it("Scenario 3: Duplicate verification events -> idempotent resolution of authoritative verdict", () => {
      const attempts = [createMockAttempt(1, "SUCCEEDED")];
      const details = {
        contractId: "contract-authority-test",
        contractVersion: 1,
        actionId: targetAction.actionId,
        attemptId: "att-1",
        attemptNumber: 1,
      };
      const events: PersistedEvent[] = [
        createVerificationEvent({ sequence: 1, status: "VERIFIED", details }),
        createVerificationEvent({ sequence: 2, status: "VERIFIED", details }),
      ];

      const verdicts = correlateAuthoritativeVerificationEvents({
        runId,
        contract,
        actions: [targetAction],
        getAttemptsForAction: () => attempts,
        events,
      });

      const verdict = verdicts.get("spec-exit-zero");
      expect(verdict).toBeDefined();
      expect(verdict?.status).toBe("VERIFIED");
      expect(verdict?.acceptedEvent).toBeDefined();
    });

    // Scenario 4: Events from an unrelated run
    it("Scenario 4: Events from an unrelated run -> ignored/rejected (runId mismatch)", () => {
      const attempts = [createMockAttempt(1, "SUCCEEDED")];
      const events: PersistedEvent[] = [
        createVerificationEvent({
          runId: "run-foreign-unrelated-999",
          sequence: 1,
          status: "VERIFIED",
          details: {
            contractId: "contract-authority-test",
            contractVersion: 1,
            actionId: targetAction.actionId,
            attemptId: "att-1",
            attemptNumber: 1,
          },
        }),
      ];

      const verdicts = correlateAuthoritativeVerificationEvents({
        runId,
        contract,
        actions: [targetAction],
        getAttemptsForAction: () => attempts,
        events,
      });

      const verdict = verdicts.get("spec-exit-zero");
      expect(verdict).toBeDefined();
      expect(verdict?.status).toBe("FAILED");
      expect(verdict?.reasonCode).toBe("MISSING_EVIDENCE");
    });

    // Scenario 5: Events from a previous execution attempt
    it("Scenario 5: Events from a previous execution attempt -> rejected as stale; fail closed", () => {
      const attempts = [createMockAttempt(1, "FAILED"), createMockAttempt(2, "SUCCEEDED")];
      const events: PersistedEvent[] = [
        createVerificationEvent({
          sequence: 1,
          status: "VERIFIED",
          details: {
            contractId: "contract-authority-test",
            contractVersion: 1,
            actionId: targetAction.actionId,
            attemptId: "att-1",
            attemptNumber: 1,
          },
        }),
      ];

      const verdicts = correlateAuthoritativeVerificationEvents({
        runId,
        contract,
        actions: [targetAction],
        getAttemptsForAction: () => attempts,
        events,
      });

      const verdict = verdicts.get("spec-exit-zero");
      expect(verdict).toBeDefined();
      expect(verdict?.status).toBe("FAILED");
      expect(verdict?.reasonCode).toBe("MISSING_EVIDENCE");
    });

    // Scenario 6: Events with unknown specification IDs
    it("Scenario 6: Events with unknown specification IDs -> ignored/rejected", () => {
      const attempts = [createMockAttempt(1, "SUCCEEDED")];
      const events: PersistedEvent[] = [
        createVerificationEvent({
          specId: "spec-unknown-bogus-999",
          sequence: 1,
          status: "VERIFIED",
          details: {
            contractId: "contract-authority-test",
            contractVersion: 1,
            actionId: targetAction.actionId,
            attemptId: "att-1",
            attemptNumber: 1,
          },
        }),
      ];

      const verdicts = correlateAuthoritativeVerificationEvents({
        runId,
        contract,
        actions: [targetAction],
        getAttemptsForAction: () => attempts,
        events,
      });

      const verdict = verdicts.get("spec-exit-zero");
      expect(verdict).toBeDefined();
      expect(verdict?.status).toBe("FAILED");
      expect(verdict?.reasonCode).toBe("MISSING_EVIDENCE");
    });

    // Scenario 7: Events with missing correlation metadata
    it("Scenario 7: Events with missing correlation metadata -> fail closed (no authority inferred from sequence alone)", () => {
      const attempts = [createMockAttempt(1, "SUCCEEDED")];
      const events: PersistedEvent[] = [
        createVerificationEvent({
          sequence: 1,
          status: "VERIFIED",
          details: {
            contractId: "contract-authority-test",
            contractVersion: 1,
          },
        }),
      ];

      const verdicts = correlateAuthoritativeVerificationEvents({
        runId,
        contract,
        actions: [targetAction],
        getAttemptsForAction: () => attempts,
        events,
      });

      const verdict = verdicts.get("spec-exit-zero");
      expect(verdict).toBeDefined();
      expect(verdict?.status).toBe("FAILED");
      expect(verdict?.reasonCode).toBe("MISSING_EVIDENCE");
    });

    // Scenario 8: Model-generated or evaluator-generated verification events
    it("Scenario 8: Model-generated or evaluator-generated verification events -> rejected (authoritative verifier required)", () => {
      const attempts = [createMockAttempt(1, "SUCCEEDED")];
      const events: PersistedEvent[] = [
        createVerificationEvent({
          producer: "agent.brain",
          sequence: 1,
          status: "VERIFIED",
          details: {
            contractId: "contract-authority-test",
            contractVersion: 1,
            actionId: targetAction.actionId,
            attemptId: "att-1",
            attemptNumber: 1,
          },
        }),
        createVerificationEvent({
          producer: "evaluator",
          sequence: 2,
          status: "VERIFIED",
          details: {
            contractId: "contract-authority-test",
            contractVersion: 1,
            actionId: targetAction.actionId,
            attemptId: "att-1",
            attemptNumber: 1,
          },
        }),
      ];

      const verdicts = correlateAuthoritativeVerificationEvents({
        runId,
        contract,
        actions: [targetAction],
        getAttemptsForAction: () => attempts,
        events,
      });

      const verdict = verdicts.get("spec-exit-zero");
      expect(verdict).toBeDefined();
      expect(verdict?.status).toBe("FAILED");
      expect(verdict?.reasonCode).toBe("MISSING_EVIDENCE");
    });
  });
});
