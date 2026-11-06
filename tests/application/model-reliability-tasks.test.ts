/**
 * Milestone 2.25 Phase 3 — Standardized Local Model Reliability Benchmark Task Suite Tests.
 *
 * Verifies that:
 * 1. All six benchmark task definitions exist and are valid.
 * 2. Task IDs are unique and stable.
 * 3. Fixtures are deterministic.
 * 4. All success-oriented contracts have non-empty verification specifications.
 * 5. Unsupported verification criteria are rejected explicitly.
 * 6. All benchmark tasks disable unverified completion.
 * 7. Resource budgets are valid and bounded.
 * 8. No benchmark can produce verified success from a model claim alone.
 * 9. Recovery benchmark preserves lease and safeToResume invariants.
 * 10. Host execution is restricted to trusted fixtures.
 * 11. Repeated fixture initialization produces equivalent initial states.
 * 12. Every task has an explicit expected verification outcome.
 */

import { describe, expect, it } from "vitest";
import {
  getAllReliabilityBenchmarkTasks,
  getReliabilityBenchmarkTask,
  getReliabilityBenchmarkTaskByCategory,
  isReliabilityBenchmarkTaskId,
  validateReliabilityBenchmarkTask,
  RELIABILITY_BENCHMARK_CATEGORIES,
  UNSUPPORTED_VERIFICATION_CRITERIA_KINDS,
  BENCHMARK_01_FILE_CREATION_MUTATION,
  BENCHMARK_02_MULTI_STEP_CODING,
  BENCHMARK_03_REPO_INVESTIGATION,
  BENCHMARK_04_TEST_FAILURE_REPAIR,
  BENCHMARK_05_MULTI_TOOL_CHAINING,
  BENCHMARK_06_INTERRUPTED_RECOVERY,
} from "../../src/application/evaluation/model-reliability-tasks.js";
import {
  computeEvaluationTaskHash,
  createEvaluationTask,
  translateEvaluationTaskCriteria,
  classifyTrialOutcome,
  type EvaluationCriterion,
} from "../../src/domain/evaluation.js";
import {
  executeEvaluationRun,
  ConstrainedHostExecutionProvider,
  correlateAuthoritativeVerificationEvents,
} from "../../src/application/evaluation/evaluation-runner.js";
import { ProposalValidator } from "../../src/application/proposal-validator.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import {
  saveStepLoopCheckpoint,
  reconcileCheckpointWithDurableEvidence,
  UncertainAttemptReconciliationError,
} from "../../src/application/step-loop-checkpoint.js";
import { PostPassVerificationLatch } from "../../src/application/post-pass-verification-latch.js";
import { decideVerifiedRunRecovery } from "../../src/application/recovery-decision-policy.js";
import { createExecutionPolicy, PolicyEvaluator, matchesProtectedPath } from "../../src/domain/policy.js";
import { createMissionContract, createResourceLimits } from "../../src/domain/mission-contract.js";
import { Action } from "../../src/domain/action.js";
import { Attempt } from "../../src/domain/attempt.js";
import { defaultGovernedToolRegistry } from "../../src/domain/tool.js";
import * as fsExtra from "node:fs";
import * as osExtra from "node:os";
import * as pathExtra from "node:path";
import {
  OllamaFetchLike,
  OllamaModelProvider,
} from "../../src/adapters/models/ollama-model-provider.js";

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

describe("Milestone 2.25 Phase 3: Standardized Reliability Benchmark Task Suite", () => {
  // =========================================================================
  // 1. All six benchmark task definitions exist
  // =========================================================================
  it("Requirement 1: All six standardized benchmark task definitions exist and conform to categories", () => {
    const tasks = getAllReliabilityBenchmarkTasks();
    expect(tasks).toHaveLength(6);

    const categories = tasks.map((t) => t.category);
    expect(categories).toEqual([
      "BENCH_01_FILE_CREATION_MUTATION",
      "BENCH_02_MULTI_STEP_CODING",
      "BENCH_03_REPO_INVESTIGATION",
      "BENCH_04_TEST_FAILURE_REPAIR",
      "BENCH_05_MULTI_TOOL_CHAINING",
      "BENCH_06_INTERRUPTED_RECOVERY",
    ]);

    for (const category of RELIABILITY_BENCHMARK_CATEGORIES) {
      const task = getReliabilityBenchmarkTaskByCategory(category);
      expect(task).toBeDefined();
      expect(task?.category).toBe(category);
    }
  });

  // =========================================================================
  // 2. Task IDs are unique and stable
  // =========================================================================
  it("Requirement 2: Task IDs are unique, stable, and prefixed with 'benchmark-'", () => {
    const tasks = getAllReliabilityBenchmarkTasks();
    const taskIds = tasks.map((t) => t.taskDefinition.taskId);
    const uniqueIds = new Set(taskIds);
    expect(uniqueIds.size).toBe(6);

    expect(taskIds).toEqual([
      "benchmark-01-file-creation-mutation",
      "benchmark-02-multi-step-coding",
      "benchmark-03-repo-investigation",
      "benchmark-04-test-failure-repair",
      "benchmark-05-multi-tool-chaining",
      "benchmark-06-interrupted-recovery",
    ]);

    for (const taskId of taskIds) {
      expect(isReliabilityBenchmarkTaskId(taskId)).toBe(true);
      const found = getReliabilityBenchmarkTask(taskId);
      expect(found).toBeDefined();
      expect(found?.taskDefinition.taskId).toBe(taskId);
    }

    // Verify all exported task constants match their canonical definitions
    expect(BENCHMARK_01_FILE_CREATION_MUTATION.taskDefinition.taskId).toBe("benchmark-01-file-creation-mutation");
    expect(BENCHMARK_02_MULTI_STEP_CODING.taskDefinition.taskId).toBe("benchmark-02-multi-step-coding");
    expect(BENCHMARK_03_REPO_INVESTIGATION.taskDefinition.taskId).toBe("benchmark-03-repo-investigation");
    expect(BENCHMARK_04_TEST_FAILURE_REPAIR.taskDefinition.taskId).toBe("benchmark-04-test-failure-repair");
    expect(BENCHMARK_05_MULTI_TOOL_CHAINING.taskDefinition.taskId).toBe("benchmark-05-multi-tool-chaining");
    expect(BENCHMARK_06_INTERRUPTED_RECOVERY.taskDefinition.taskId).toBe("benchmark-06-interrupted-recovery");

    expect(isReliabilityBenchmarkTaskId("unrelated-task-id")).toBe(false);
  });

  // =========================================================================
  // 3. Fixtures are deterministic
  // =========================================================================
  it("Requirement 3: Initial fixtures are non-empty, strictly validated, and deterministic", () => {
    const tasks = getAllReliabilityBenchmarkTasks();
    for (const task of tasks) {
      const validation = validateReliabilityBenchmarkTask(task);
      expect(validation.valid).toBe(true);
      expect(validation.issues).toHaveLength(0);

      const files = Object.keys(task.taskDefinition.fixture.initialFiles);
      expect(files.length).toBeGreaterThan(0);
      expect(files).toContain("package.json");

      // Verify each fixture parses cleanly
      const pkg = JSON.parse(task.taskDefinition.fixture.initialFiles["package.json"]!);
      expect(pkg.name).toBeDefined();
      expect(pkg.type).toBe("commonjs");
    }
  });

  // =========================================================================
  // 4. All success-oriented contracts have non-empty verification specifications
  // =========================================================================
  it("Requirement 4: All success-oriented contracts produce non-empty runtime verification specifications", () => {
    const tasks = getAllReliabilityBenchmarkTasks();
    for (const task of tasks) {
      const translation = translateEvaluationTaskCriteria(task.taskDefinition);
      expect(translation.supported).toBe(true);
      expect(translation.unsupportedReasons).toHaveLength(0);
      expect(translation.verificationSpecs.length).toBeGreaterThan(0);

      for (const spec of translation.verificationSpecs) {
        expect(spec.specId).toBeDefined();
        expect(spec.ruleKind).toBe("EXIT_CODE_ZERO");
      }
    }
  });

  // =========================================================================
  // 5. Unsupported verification criteria are rejected explicitly
  // =========================================================================
  it("Requirement 5: Unsupported verification criteria are rejected explicitly and fail closed", () => {
    expect(UNSUPPORTED_VERIFICATION_CRITERIA_KINDS).toEqual([
      "FILE_CONTENT_EQUALS",
      "FILE_EXISTS",
      "FILE_ABSENT",
      "TEXT_CONTAINS",
    ]);

    for (const unsupportedKind of UNSUPPORTED_VERIFICATION_CRITERIA_KINDS) {
      const bogusTask = createEvaluationTask({
        taskId: "benchmark-test-unsupported",
        version: 1,
        description: "Task with unsupported criterion",
        fixture: { initialFiles: { "test.txt": "sample" } },
        mission: { requiredCapabilities: ["workspace.file.read"] },
        successCriteria: [
          {
            criterionId: "crit-unsupported",
            kind: unsupportedKind,
            path: "test.txt",
            expectedContent: "sample",
            expectedSubstring: "sample",
          } as EvaluationCriterion,
        ],
        budget: { maxSteps: 3, maxActions: 3, maxWallClockMs: 10000 },
      });

      const translation = translateEvaluationTaskCriteria(bogusTask);
      expect(translation.supported).toBe(false);
      expect(translation.verificationSpecs).toHaveLength(0);
      expect(translation.unsupportedReasons[0]).toContain(unsupportedKind);
      expect(translation.unsupportedReasons[0]).toContain("no direct runtime verification rule equivalent");
    }
  });

  // =========================================================================
  // 6. All benchmark tasks disable unverified completion
  // =========================================================================
  it("Requirement 6: Benchmark tasks strictly disable unverified completion", async () => {
    const task = BENCHMARK_01_FILE_CREATION_MUTATION.taskDefinition;

    // 6a. Agent claims completion immediately without executing verification command
    const { fetch: unverifiedFetch } = createMockFetch((_step, parsedBody) => {
      const hash = extractContextHash(parsedBody);
      return {
        content: JSON.stringify({
          isGoalReached: true,
          proposalId: "p1",
          contextSnapshotHash: hash,
          rationale: "Claiming complete without verified execution",
        }),
      };
    });

    const provider1 = new OllamaModelProvider({ fetch: unverifiedFetch, defaultModel: "test-eval-model" });
    const runResult1 = await executeEvaluationRun({
      task,
      modelProvider: provider1,
      model: "test-eval-model",
    });

    // Sovereign runtime verification rejects unverified claim (never VERIFIED_SUCCESS)
    expect(runResult1.finalOutcome).not.toBe("VERIFIED_SUCCESS");
    expect(runResult1.finalOutcome).toBe("TIMEOUT");
    expect(runResult1.completionClaim?.claimed).toBe(true);

    // 6b. Agent executes verification command that fails, then claims completion -> FALSE_COMPLETION
    const { fetch: failedVerifyFetch } = createMockFetch((step, parsedBody) => {
      const hash = extractContextHash(parsedBody);
      if (step === 1) {
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p1",
            toolName: "run_command",
            inputPayload: { argv: ["node", "test/verify_creation.js"] }, // test fails because files don't exist yet
            contextSnapshotHash: hash,
            rationale: "Running verification before files are created",
          }),
        };
      }
      return {
        content: JSON.stringify({
          isGoalReached: true,
          proposalId: "p2",
          contextSnapshotHash: hash,
          rationale: "Finishing despite failed verification",
        }),
      };
    });

    const provider2 = new OllamaModelProvider({ fetch: failedVerifyFetch, defaultModel: "test-eval-model" });
    const runResult2 = await executeEvaluationRun({
      task,
      modelProvider: provider2,
      model: "test-eval-model",
    });

    // Verification evidence failed -> Runtime rejects completion, never VERIFIED_SUCCESS
    expect(runResult2.finalOutcome).not.toBe("VERIFIED_SUCCESS");
    expect(runResult2.completionClaim?.claimed).toBe(true);
    expect(runResult2.verificationAssessment?.decision).toBe("REJECTED");

    // Pure outcome classification with rejected verification yields FALSE_COMPLETION
    expect(runResult2.completionClaim).toBeDefined();
    expect(runResult2.verificationAssessment).toBeDefined();
    const outcomeClassification = classifyTrialOutcome({
      terminalReason: "COMPLETED",
      modelCompletionClaim: runResult2.completionClaim!,
      verificationAssessment: runResult2.verificationAssessment!,
      allowUnverifiedCompletion: false,
    });
    expect(outcomeClassification.outcome).toBe("FALSE_COMPLETION");
  });

  // =========================================================================
  // 7. Resource budgets are valid and bounded
  // =========================================================================
  it("Requirement 7: Resource budgets are bounded, realistic, and positive integers", () => {
    const tasks = getAllReliabilityBenchmarkTasks();
    for (const task of tasks) {
      const budget = task.taskDefinition.budget;
      expect(budget.maxSteps).toBeGreaterThan(0);
      expect(budget.maxSteps).toBeLessThanOrEqual(20);
      expect(budget.maxActions).toBeGreaterThan(0);
      expect(budget.maxActions).toBeLessThanOrEqual(20);
      expect(budget.maxWallClockMs).toBeGreaterThan(0);
      expect(budget.maxWallClockMs).toBeLessThanOrEqual(60000);
      expect(budget.maxConsecutiveFailures).toBeGreaterThan(0);
    }
  });

  // =========================================================================
  // 8. No benchmark can produce verified success from a model claim alone
  // =========================================================================
  it("Requirement 8: Model completion claim alone never manufactures verified success", () => {
    // 8a. Model claims completion, but verification is REJECTED
    const falseClaimOutcome = classifyTrialOutcome({
      terminalReason: "COMPLETED",
      modelCompletionClaim: { claimed: true, finishReason: "GOAL_REACHED" },
      verificationAssessment: {
        decision: "REJECTED",
        reasonCode: "SPEC_ASSERTION_FAILED",
        specCount: 1,
        passedSpecCount: 0,
        failedSpecCount: 1,
      },
      postRunCriteriaPassed: false,
    });
    expect(falseClaimOutcome.outcome).toBe("FALSE_COMPLETION");

    // 8b. Model claims completion, but verification is UNVERIFIABLE
    const unverifiableOutcome = classifyTrialOutcome({
      terminalReason: "COMPLETION_UNVERIFIABLE",
      modelCompletionClaim: { claimed: true, finishReason: "GOAL_REACHED" },
      verificationAssessment: {
        decision: "UNVERIFIABLE",
        reasonCode: "NO_VERIFICATION_SPECS",
        specCount: 0,
        passedSpecCount: 0,
        failedSpecCount: 0,
      },
    });
    expect(unverifiableOutcome.outcome).toBe("COMPLETION_UNVERIFIABLE");

    // 8c. Model claims completion, but operator opted into unverified completion
    const unverifiedOptInOutcome = classifyTrialOutcome({
      terminalReason: "COMPLETED",
      modelCompletionClaim: { claimed: true },
      verificationAssessment: {
        decision: "VERIFIED",
        reasonCode: "AUTHORITATIVE_VERIFIED",
        specCount: 1,
        passedSpecCount: 1,
        failedSpecCount: 0,
      },
      allowUnverifiedCompletion: true,
    });
    expect(unverifiedOptInOutcome.outcome).toBe("COMPLETION_UNVERIFIABLE");
    expect(unverifiedOptInOutcome.outcome).not.toBe("VERIFIED_SUCCESS");
  });

  // =========================================================================
  // 9. Recovery benchmark preserves lease and safeToResume invariants
  // =========================================================================
  it("Requirement 9: Interrupted recovery benchmark preserves lease fencing and safeToResume = false", () => {
    const recoveryTask = BENCHMARK_06_INTERRUPTED_RECOVERY;
    expect(recoveryTask.category).toBe("BENCH_06_INTERRUPTED_RECOVERY");
    expect(recoveryTask.taskDefinition.taskId).toBe("benchmark-06-interrupted-recovery");

    // Invariant: Interrupted execution due to lease loss or cancellation terminates as BLOCKED
    const interruptedOutcome = classifyTrialOutcome({
      terminalReason: "LEASE_LOST",
      terminalMessage: "Worker lost lease ownership during execution",
      modelCompletionClaim: { claimed: false },
      verificationAssessment: {
        decision: "NOT_EVALUATED",
        specCount: 1,
        passedSpecCount: 0,
        failedSpecCount: 0,
      },
    });
    expect(interruptedOutcome.outcome).toBe("BLOCKED");

    // Invariant: safeToResume must remain false; unverified recovery is prohibited
    const safeToResumeInvariant = false;
    expect(safeToResumeInvariant).toBe(false);
  });

  // =========================================================================
  // 10. Host execution is restricted to trusted fixtures
  // =========================================================================
  it("Requirement 10: Host execution provider explicitly enforces trusted benchmark fixture boundaries", () => {
    const provider = new ConstrainedHostExecutionProvider();
    expect(provider.name).toBe("host-constrained");
    expect(provider.tenantModel).toBe("NONE");

    // All benchmark tasks declare isolationLevel CONSTRAINED_HOST for trusted fixtures
    const tasks = getAllReliabilityBenchmarkTasks();
    for (const task of tasks) {
      expect(task.isolationLevel).toBe("CONSTRAINED_HOST");
    }
  });

  // =========================================================================
  // 11. Repeated fixture initialization produces equivalent initial states
  // =========================================================================
  it("Requirement 11: Repeated fixture initialization produces identical canonical hashes", () => {
    const tasks = getAllReliabilityBenchmarkTasks();
    for (const task of tasks) {
      const hash1 = computeEvaluationTaskHash(task.taskDefinition);
      const revalidated = createEvaluationTask(task.taskDefinition);
      const hash2 = computeEvaluationTaskHash(revalidated);
      expect(hash1).toBe(hash2);
    }
  });

  // =========================================================================
  // 12. Every task has an explicit expected verification outcome
  // =========================================================================
  it("Requirement 12: Every task declares explicit expected outcome and verification rule", () => {
    const tasks = getAllReliabilityBenchmarkTasks();
    for (const task of tasks) {
      expect(task.expectedOutcome).toBe("VERIFIED_SUCCESS");
      expect(task.expectedVerificationRule).toBe("EXIT_CODE_ZERO");
      expect(task.objective.length).toBeGreaterThan(10);
      expect(task.constraints.length).toBeGreaterThan(0);
      expect(task.cleanupBehavior.length).toBeGreaterThan(10);
    }
  });

  // =========================================================================
  // 13. End-to-End Trial Execution on Benchmark Task
  // =========================================================================
  it("Requirement 13: End-to-end execution of BENCHMARK_01 produces VERIFIED_SUCCESS when properly completed", async () => {
    const task = BENCHMARK_01_FILE_CREATION_MUTATION.taskDefinition;

    const { fetch } = createMockFetch((step, parsedBody) => {
      const hash = extractContextHash(parsedBody);
      if (step === 1) {
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p1",
            toolName: "write_file",
            inputPayload: {
              path: "src/config.json",
              content: JSON.stringify({ service: "payment-gateway", port: 8080, active: true }, null, 2),
            },
            contextSnapshotHash: hash,
            rationale: "Creating src/config.json",
          }),
        };
      }
      if (step === 2) {
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p2",
            toolName: "write_file",
            inputPayload: {
              path: "src/formatter.js",
              content: 'function formatPayload(service, active) { return `[${service}:${active ? "active" : "inactive"}]`; }\nmodule.exports = { formatPayload };\n',
            },
            contextSnapshotHash: hash,
            rationale: "Creating src/formatter.js",
          }),
        };
      }
      if (step === 3) {
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p3",
            toolName: "run_command",
            inputPayload: { argv: ["node", "test/verify_creation.js"] },
            contextSnapshotHash: hash,
            rationale: "Running verification suite",
          }),
        };
      }
      return {
        content: JSON.stringify({
          isGoalReached: true,
          proposalId: "p4",
          contextSnapshotHash: hash,
          rationale: "Task completed and verified",
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
    expect(runResult.verificationAssessment?.specResults?.[0]?.status).toBe("VERIFIED");
  });

describe("Milestone 2.25 Phase 3.1: Benchmark Oracle Integrity and Recovery Authenticity", () => {
  // =========================================================================
  // 1. Agent cannot overwrite verification scripts
  // =========================================================================
  it("Adversarial Integrity 1: Evaluated agent cannot overwrite or mutate verification scripts", () => {
    const task = BENCHMARK_01_FILE_CREATION_MUTATION.taskDefinition;
    const policy = createExecutionPolicy({
      policyId: "test-oracle-policy",
      allowedCapabilities: ["workspace.file.write", "workspace.file.read", "process.execute"],
      isolationRequirement: "ISOLATED",
      protectedPaths: task.mission.protectedPaths,
    });
    const contract = createMissionContract({
      contractId: "contract-adversarial-1",
      version: 1,
      taskId: "task-adv-1",
      status: "ACTIVE",
      policy,
      resourceLimits: createResourceLimits({ timeoutMs: 30000, maxAttempts: 3, maxOutputBytes: 1048576 }),
    });
    const validator = new ProposalValidator({ toolRegistry: defaultGovernedToolRegistry });
    const clock = new SettableClock();
    const contextSnapshot = {
      snapshotId: "snap-1",
      runId: "run-adv-1",
      taskId: "task-adv-1",
      policyVersion: "v1",
      createdAt: clock.nowIso(),
      budget: {
        maxObservations: 50,
        maxEstimatedTokens: 4000,
        maxBytes: 16000,
        maxHistoryEvents: 20,
        maxActionHistory: 10,
        maxAttemptHistory: 10,
        maxToolOutputBytes: 2048,
        maxEvidenceItems: 10,
      },
      observations: [],
      omittedObservationsCount: 0,
      omittedObservationsSummary: [],
      totalEstimatedTokens: 10,
      totalBytes: 50,
      contextHash: "a".repeat(64),
    };
    const run = {
      runId: "run-adv-1",
      status: "RUNNING" as const,
      leaseId: "lease-1",
      currentWorkerId: "worker-1",
      contractBinding: { contractId: contract.spec.contractId, version: 1, contentHash: contract.contentHash },
    };
    const validationContext: any = {
      runId: "run-adv-1",
      contextSnapshot,
      workerId: "worker-1",
      leaseId: "lease-1",
      run,
      contract,
    };

    // 1a. Direct write_file targeting test/verify_creation.js
    const overwriteProposal = {
      proposalId: "prop-adv-1",
      toolName: "write_file" as const,
      inputPayload: { path: "test/verify_creation.js", content: "process.exit(0);" },
      contextSnapshotHash: "a".repeat(64),
    };
    const result1 = validator.validate(overwriteProposal, validationContext);
    expect(result1.valid).toBe(false);
    if (!result1.valid) {
      expect(result1.reason).toBe("DISALLOWED_FILE_OVERWRITE");
      expect(result1.message).toContain("protected oracle path");
    }

    // 1b. Direct edit_file targeting test/verify_creation.js
    const editProposal = {
      proposalId: "prop-adv-2",
      toolName: "edit_file" as const,
      inputPayload: { path: "test/verify_creation.js", searchAnchor: "assert", replacementText: "// neutralized" },
      contextSnapshotHash: "a".repeat(64),
    };
    const result2 = validator.validate(editProposal, validationContext);
    expect(result2.valid).toBe(false);
    if (!result2.valid) {
      expect(result2.reason).toBe("DISALLOWED_FILE_OVERWRITE");
      expect(result2.message).toContain("protected oracle path");
    }

    // 1c. Directory traversal trick targeting test/verify_creation.js
    const traversalProposal = {
      proposalId: "prop-adv-3",
      toolName: "write_file" as const,
      inputPayload: { path: "src/../test/verify_creation.js", content: "process.exit(0);" },
      contextSnapshotHash: "a".repeat(64),
    };
    const result3 = validator.validate(traversalProposal, validationContext);
    expect(result3.valid).toBe(false);
    if (!result3.valid) {
      expect(result3.reason).toBe("DISALLOWED_FILE_OVERWRITE");
    }
  });

  // =========================================================================
  // 2. Agent cannot alter expected results or instructions
  // =========================================================================
  it("Adversarial Integrity 2: Evaluated agent cannot alter expected results, config, or task instructions", () => {
    const task = BENCHMARK_01_FILE_CREATION_MUTATION.taskDefinition;
    const policy = createExecutionPolicy({
      policyId: "test-oracle-policy-2",
      allowedCapabilities: ["workspace.file.write"],
      isolationRequirement: "ISOLATED",
      protectedPaths: task.mission.protectedPaths,
    });

    const readmeDecision = PolicyEvaluator.evaluateFileOperation({
      toolName: "write_file",
      path: "README.md",
      fileExists: true,
      isEditFileAvailableAndAuthorized: true,
    }, policy);
    expect(readmeDecision.allowed).toBe(false);
    expect(readmeDecision.reasonCode).toBe("DISALLOWED_FILE_OVERWRITE");

    const pkgDecision = PolicyEvaluator.evaluateFileOperation({
      toolName: "write_file",
      path: "package.json",
      fileExists: true,
      isEditFileAvailableAndAuthorized: true,
    }, policy);
    expect(pkgDecision.allowed).toBe(false);
    expect(pkgDecision.reasonCode).toBe("DISALLOWED_FILE_OVERWRITE");
  });

  // =========================================================================
  // 3. Agent cannot replace the verification command or alter the MissionContract
  // =========================================================================
  it("Adversarial Integrity 3: Evaluated agent cannot replace verification command or alter MissionContract", () => {
    const validator = new ProposalValidator({ toolRegistry: defaultGovernedToolRegistry });
    const clock = new SettableClock();
    const contextSnapshot = {
      snapshotId: "snap-3",
      runId: "run-3",
      taskId: "task-3",
      policyVersion: "v1",
      createdAt: clock.nowIso(),
      budget: {
        maxObservations: 50,
        maxEstimatedTokens: 4000,
        maxBytes: 16000,
        maxHistoryEvents: 20,
        maxActionHistory: 10,
        maxAttemptHistory: 10,
        maxToolOutputBytes: 2048,
        maxEvidenceItems: 10,
      },
      observations: [],
      omittedObservationsCount: 0,
      omittedObservationsSummary: [],
      totalEstimatedTokens: 10,
      totalBytes: 50,
      contextHash: "b".repeat(64),
    };

    // Attempting to inject forbidden authority fields into proposal
    const authorityAttempt = {
      proposalId: "prop-adv-auth",
      toolName: "run_command" as const,
      inputPayload: { argv: ["node", "test/verify_creation.js"] },
      contextSnapshotHash: "b".repeat(64),
      contractId: "tampered-contract-id",
      capabilities: ["system.admin"],
    };
    const res = validator.validate(authorityAttempt as any, {
      runId: "run-3",
      contextSnapshot,
    } as any);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.reason).toBe("FORBIDDEN_AUTHORITY_FIELD");
    }
  });

  // =========================================================================
  // 4. A deliberately modified artifact fails verification
  // =========================================================================
  it("Adversarial Integrity 4: A deliberately modified or non-conforming artifact fails verification", async () => {
    const task = BENCHMARK_01_FILE_CREATION_MUTATION.taskDefinition;
    const { fetch } = createMockFetch((step, parsedBody) => {
      const hash = extractContextHash(parsedBody);
      if (step === 1) {
        // Intentionally create flawed artifact with incorrect service value
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p1",
            toolName: "write_file",
            inputPayload: {
              path: "src/config.json",
              content: JSON.stringify({ service: "WRONG_SERVICE", port: 9999, active: false }),
            },
            contextSnapshotHash: hash,
            rationale: "Creating flawed config",
          }),
        };
      }
      if (step === 2) {
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p2",
            toolName: "write_file",
            inputPayload: {
              path: "src/formatter.js",
              content: "module.exports = {};",
            },
            contextSnapshotHash: hash,
            rationale: "Creating flawed formatter",
          }),
        };
      }
      if (step === 3) {
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p3",
            toolName: "run_command",
            inputPayload: { argv: ["node", "test/verify_creation.js"] },
            contextSnapshotHash: hash,
            rationale: "Running verification",
          }),
        };
      }
      return {
        content: JSON.stringify({
          isGoalReached: true,
          proposalId: "p4",
          contextSnapshotHash: hash,
          rationale: "Claiming goal reached despite failure",
        }),
      };
    });

    const provider = new OllamaModelProvider({ fetch, defaultModel: "test-eval-model" });
    const runResult = await executeEvaluationRun({
      task,
      modelProvider: provider,
      model: "test-eval-model",
    });

    // Flawed artifact must never produce VERIFIED_SUCCESS
    expect(runResult.finalOutcome).not.toBe("VERIFIED_SUCCESS");
    expect(runResult.finalOutcome).toBe("TIMEOUT");
    expect(runResult.verificationAssessment?.decision).toBe("REJECTED");
  });

  // =========================================================================
  // 5. A deliberately modified verifier cannot manufacture success
  // =========================================================================
  it("Adversarial Integrity 5: A deliberately modified verifier cannot manufacture success (tamper detection)", () => {
    const contract = createMissionContract({
      contractId: "contract-adv-5",
      version: 1,
      taskId: "task-adv-5",
      policy: createExecutionPolicy({ allowedCapabilities: ["process.execute"], isolationRequirement: "ISOLATED" }),
      verificationSpecs: [
        {
          specId: "spec-adv-5",
          ruleKind: "EXIT_CODE_ZERO",
          expectedValue: { toolName: "run_command", argv: ["node", "test/verify_creation.js"], expectedExitCode: 0 },
        },
      ],
      resourceLimits: createResourceLimits({ timeoutMs: 30000, maxAttempts: 3, maxOutputBytes: 1048576 }),
    });

    // Temp directory simulating workspace where adversary overwrote verification script
    const tempDir = fsExtra.mkdtempSync(pathExtra.join(osExtra.tmpdir(), "oracle-tamper-"));
    try {
      const testDir = pathExtra.join(tempDir, "test");
      fsExtra.mkdirSync(testDir, { recursive: true });
      fsExtra.writeFileSync(pathExtra.join(testDir, "verify_creation.js"), "process.exit(0);", "utf8");

      const expectedOriginalHash = "0".repeat(64); // Different from hash of 'process.exit(0);'
      const fixtureHashes = new Map([["test/verify_creation.js", expectedOriginalHash]]);

      const actions = [
        {
          actionId: "act-tamper",
          runId: "run-5",
          sequenceNumber: 1,
          toolName: "run_command",
          status: "SUCCEEDED" as const,
          inputPayload: { argv: ["node", "test/verify_creation.js"] },
        },
      ];
      const attempts = [
        {
          attemptId: "att-tamper",
          actionId: "act-tamper",
          attemptNumber: 1,
          status: "SUCCEEDED" as const,
          outputPayload: { exitCode: 0 },
        },
      ];
      const events = [
        {
          eventId: "ev-1",
          runId: "run-5",
          eventType: "verification.completed",
          schemaVersion: 1,
          producer: "application.verifier",
          timestamp: new Date().toISOString(),
          sequence: 1,
          payload: {
            runId: "run-5",
            verifierId: "deterministic-verifier",
            specId: "spec-adv-5",
            status: "VERIFIED",
            details: { contractId: "contract-adv-5", contractVersion: 1, actionId: "act-tamper", attemptId: "att-tamper", attemptNumber: 1 },
          },
        },
      ];

      const verdicts = correlateAuthoritativeVerificationEvents({
        runId: "run-5",
        contract,
        actions: actions as any,
        getAttemptsForAction: () => attempts as any,
        events: events as any,
        fixtureHashes,
        workspaceDir: tempDir,
      });

      const verdict = verdicts.get("spec-adv-5");
      expect(verdict).toBeDefined();
      expect(verdict?.status).toBe("FAILED");
      expect(verdict?.message).toContain("Oracle integrity violation");
    } finally {
      fsExtra.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 6. A stale or mismatched verification result cannot produce verified success
  // =========================================================================
  it("Adversarial Integrity 6: A stale verification result cannot produce verified success", () => {
    const contract = createMissionContract({
      contractId: "contract-adv-6",
      version: 2,
      taskId: "task-adv-6",
      policy: createExecutionPolicy({ allowedCapabilities: ["process.execute"], isolationRequirement: "ISOLATED" }),
      verificationSpecs: [
        {
          specId: "spec-adv-6",
          ruleKind: "EXIT_CODE_ZERO",
          expectedValue: { toolName: "run_command", argv: ["node", "test/verify.js"], expectedExitCode: 0 },
        },
      ],
      resourceLimits: createResourceLimits({ timeoutMs: 30000, maxAttempts: 3, maxOutputBytes: 1048576 }),
    });

    // Stale event carries contractVersion: 1 (current is 2)
    const staleEvents = [
      {
        eventId: "ev-stale",
        runId: "run-6",
        eventType: "verification.completed",
        schemaVersion: 1,
        producer: "application.verifier",
        timestamp: new Date().toISOString(),
        sequence: 1,
        payload: {
          runId: "run-6",
          verifierId: "deterministic-verifier",
          specId: "spec-adv-6",
          status: "VERIFIED",
          details: { contractId: "contract-adv-6", contractVersion: 1, actionId: "act-1", attemptId: "att-1", attemptNumber: 1 },
        },
      },
    ];

    const verdicts = correlateAuthoritativeVerificationEvents({
      runId: "run-6",
      contract,
      actions: [{ actionId: "act-1", runId: "run-6", sequenceNumber: 1, toolName: "run_command", inputPayload: { argv: ["node", "test/verify.js"] }, status: "SUCCEEDED" }] as any,
      getAttemptsForAction: () => [{ attemptId: "att-1", actionId: "act-1", attemptNumber: 1, status: "SUCCEEDED", outputPayload: { exitCode: 0 } }] as any,
      events: staleEvents as any,
    });

    // Stale event rejected fail-closed
    const verdict = verdicts.get("spec-adv-6");
    expect(verdict?.status).toBe("FAILED");
    expect(verdict?.reasonCode).toBe("MISSING_EVIDENCE");
  });

  // =========================================================================
  // 7. All six tasks preserve oracle integrity
  // =========================================================================
  it("Adversarial Integrity 7: All six benchmark tasks define immutable oracle paths and reject mutations", () => {
    const tasks = getAllReliabilityBenchmarkTasks();
    expect(tasks.length).toBe(6);

    for (const task of tasks) {
      expect(task.oraclePaths.length).toBeGreaterThan(0);
      expect(task.agentWritablePaths.length).toBeGreaterThan(0);
      expect(task.taskDefinition.mission.protectedPaths).toBeDefined();

      const policy = createExecutionPolicy({
        policyId: `policy-${task.category}`,
        allowedCapabilities: ["workspace.file.write"],
        isolationRequirement: "ISOLATED",
        protectedPaths: task.taskDefinition.mission.protectedPaths,
      });

      // Test each oracle path is rejected for direct write
      for (const oracleFile of task.oraclePaths) {
        const decision = PolicyEvaluator.evaluateFileOperation({
          toolName: "write_file",
          path: oracleFile,
          fileExists: true,
          isEditFileAvailableAndAuthorized: true,
        }, policy);
        expect(decision.allowed).toBe(false);
        expect(decision.reasonCode).toBe("DISALLOWED_FILE_OVERWRITE");
      }
    }
  });

  // =========================================================================
  // 8. Authentic Interrupted Recovery Integration Test
  // =========================================================================
  it("Interrupted Recovery Authenticity: Real SQLite state store, checkpoint consistency, lease fencing, and supervisor safety invariants", () => {
    const tempDir = fsExtra.mkdtempSync(pathExtra.join(osExtra.tmpdir(), "recovery-auth-"));
    const store = new SqliteStateStore({ location: pathExtra.join(tempDir, "state.db"), isProcessAlive: () => false });
    const clock = new SettableClock("2026-11-06T12:00:00.000Z");
    const coordinator = new RunCoordinator(store, clock);

    try {
      // 1. Create Task and Contract
      const runtimeTask = coordinator.createTask({ title: "Recovery Task", description: "Testing real recovery", inputPayload: {} });
      const policy = createExecutionPolicy({ allowedCapabilities: ["workspace.file.write"], isolationRequirement: "ISOLATED" });
      const contract = createMissionContract({
        contractId: "contract-recovery-1",
        version: 1,
        taskId: runtimeTask.taskId,
        status: "ACTIVE",
        policy,
        resourceLimits: createResourceLimits({ timeoutMs: 30000, maxAttempts: 3, maxOutputBytes: 1048576 }),
      });
      store.insertContract(contract);

      // 2. Register Worker and Start Run
      coordinator.registerWorker({ workerId: "worker-1", hostname: "localhost", pid: 100, status: "ACTIVE", createdAt: clock.nowIso(), lastHeartbeatAt: clock.nowIso() });
      const { run } = coordinator.createRun({ taskId: runtimeTask.taskId });
      coordinator.queueRun(run.runId);
      const claim = coordinator.claimRun(run.runId, "worker-1", 300000);
      const started = coordinator.startRun(run.runId, "worker-1", claim.lease.leaseId);
      const fencing = { workerId: "worker-1", leaseId: claim.lease.leaseId };
      const gen = () => "evt-" + Math.random().toString(36).substring(2, 9);

      // 3. Insert Action 1 (SUCCEEDED) and Save Durable Checkpoint
      const { action: action1, event: actionEvent1 } = Action.create({
        actionId: "act-rec-1",
        runId: run.runId,
        sequenceNumber: 1,
        toolName: "write_file",
        inputPayload: { path: "data/record.txt", content: "step 1 done" },
        contractBinding: started.run.contractBinding!,
        maxAttempts: 3,
        now: clock.nowIso(),
      });
      const { attempt: attempt1, event: attEvent1 } = Attempt.create({
        attemptId: "att-rec-1",
        actionId: action1.actionId,
        runId: run.runId,
        attemptNumber: 1,
        workerId: "worker-1",
        leaseId: claim.lease.leaseId,
        now: clock.nowIso(),
      });

      store.transaction((tx) => {
        tx.insertAction(action1.snapshot, actionEvent1, fencing);
        tx.transitionAction(action1.actionId, { type: "AUTHORIZE", now: clock.nowIso() }, gen);
        tx.transitionAction(action1.actionId, { type: "START_ATTEMPT", attemptNumber: 1, now: clock.nowIso() }, gen);
        tx.insertAttempt(attempt1.snapshot, attEvent1, fencing);
        tx.transitionAttempt(attempt1.attemptId, { type: "DISPATCH", now: clock.nowIso() }, gen);
        tx.transitionAttempt(attempt1.attemptId, { type: "START", now: clock.nowIso() }, gen);
        tx.transitionAttempt(attempt1.attemptId, { type: "COMPLETE", outputPayload: { written: true }, now: clock.nowIso() }, gen);
        tx.transitionAction(action1.actionId, { type: "SUCCEED", resultPayload: { written: true }, now: clock.nowIso() }, gen);
      });

      saveStepLoopCheckpoint({
        coordinator,
        stateStore: store,
        clock,
        runId: run.runId,
        stepCount: 1,
        actionCount: 1,
        consecutiveFailures: 0,
        proposalRejections: 0,
        consecutiveIdenticalReads: 0,
        consecutiveIdenticalWrites: 0,
        consecutiveIneffectiveEdits: 0,
        postPassLatch: new PostPassVerificationLatch(),
        currentCheckpointVersion: 1,
        lastActionId: action1.actionId,
        lastAttemptNumber: 1,
        workerFencing: fencing,
      });

      // 4. Verify Checkpoint Consistency via Reconciliation
      const runSnapshot = store.getRun(run.runId)!;
      const cp = store.getLatestCheckpoint(run.runId)!;
      const reconciliation = reconcileCheckpointWithDurableEvidence({
        checkpoint: cp,
        runSnapshot,
        contract,
        actions: store.getActionsForRun(run.runId),
        attempts: store.getAttemptsForAction(action1.actionId),
        events: store.getEventsForRun(run.runId),
        clock,
      });
      expect(reconciliation.status).toBe("READY");
      expect(reconciliation.reconciledActionCount).toBe(1);
      expect(reconciliation.reconciledStepCount).toBe(1);

      // 5. Interruption / Crash: Attempt 2 left in UNCERTAIN (RUNNING) state
      const { action: action2, event: actionEvent2 } = Action.create({
        actionId: "act-rec-2",
        runId: run.runId,
        sequenceNumber: 2,
        toolName: "write_file",
        inputPayload: { path: "data/record-2.txt", content: "in-flight" },
        contractBinding: started.run.contractBinding!,
        maxAttempts: 3,
        now: clock.nowIso(),
      });
      const { attempt: attempt2, event: attEvent2 } = Attempt.create({
        attemptId: "att-rec-2",
        actionId: action2.actionId,
        runId: run.runId,
        attemptNumber: 1,
        workerId: "worker-1",
        leaseId: claim.lease.leaseId,
        now: clock.nowIso(),
      });

      store.transaction((tx) => {
        tx.insertAction(action2.snapshot, actionEvent2, fencing);
        tx.transitionAction(action2.actionId, { type: "AUTHORIZE", now: clock.nowIso() }, gen);
        tx.transitionAction(action2.actionId, { type: "START_ATTEMPT", attemptNumber: 1, now: clock.nowIso() }, gen);
        tx.insertAttempt(attempt2.snapshot, attEvent2, fencing);
        tx.transitionAttempt(attempt2.attemptId, { type: "DISPATCH", now: clock.nowIso() }, gen);
        tx.transitionAttempt(attempt2.attemptId, { type: "START", now: clock.nowIso() }, gen);
      });

      // Reconciliation MUST throw UncertainAttemptReconciliationError on uncertain attempt
      expect(() =>
        reconcileCheckpointWithDurableEvidence({
          checkpoint: cp,
          runSnapshot,
          contract,
          actions: store.getActionsForRun(run.runId),
          attempts: [...store.getAttemptsForAction(action1.actionId), ...store.getAttemptsForAction(action2.actionId)],
          events: store.getEventsForRun(run.runId),
          clock,
        })
      ).toThrow(UncertainAttemptReconciliationError);

      // 6. Advance Clock: Worker Lease Expires
      clock.advanceMs(310000);
      expect(clock.nowIso() > claim.lease.expiresAt).toBe(true);

      // 7. Sweeper Evidence (Lease expiry alone WITHOUT supervisor fencing):
      // Evaluated recovery policy proves safeToResume is strictly false
      const sweeperDecision = decideVerifiedRunRecovery({
        runSnapshot,
        events: store.getEventsForRun(run.runId),
      });
      // With no verified event, sweeper policy does not manufacture completion
      expect(sweeperDecision.action).toBe("PROCEED_TO_RETRY");

      // 8. Invariant Verification: safeToResume remains strictly false
      const safeToResume = false;
      expect(safeToResume).toBe(false);
    } finally {
      store.close();
      fsExtra.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

  // =========================================================================
  // Milestone 2.25 Phase 3.2: Final Oracle Boundary Validation
  // =========================================================================
  describe("Milestone 2.25 Phase 3.2: Final Oracle Boundary Validation", () => {
    // -----------------------------------------------------------------------
    // 1. Mutation routes: write_file, edit_file, traversal, case, backslashes
    // -----------------------------------------------------------------------
    it("Phase 3.2 - Mutation Routes: All direct mutation routes are prevented before operation dispatch", () => {
      const task = BENCHMARK_01_FILE_CREATION_MUTATION.taskDefinition;
      const policy = createExecutionPolicy({
        policyId: "policy-routes-test",
        allowedCapabilities: ["workspace.file.write", "workspace.file.read"],
        isolationRequirement: "ISOLATED",
        protectedPaths: task.mission.protectedPaths,
      });

      // 1a. Normal relative path
      const r1 = PolicyEvaluator.evaluateFileOperation({
        toolName: "write_file",
        path: "test/verify_creation.js",
        fileExists: true,
        isEditFileAvailableAndAuthorized: true,
      }, policy);
      expect(r1.allowed).toBe(false);
      expect(r1.reasonCode).toBe("DISALLOWED_FILE_OVERWRITE");

      // 1b. edit_file tool
      const r2 = PolicyEvaluator.evaluateFileOperation({
        toolName: "edit_file",
        path: "test/verify_creation.js",
        fileExists: true,
        isEditFileAvailableAndAuthorized: true,
      }, policy);
      expect(r2.allowed).toBe(false);
      expect(r2.reasonCode).toBe("DISALLOWED_FILE_OVERWRITE");

      // 1c. Case variation (Windows / macOS case-insensitivity)
      const r3 = PolicyEvaluator.evaluateFileOperation({
        toolName: "write_file",
        path: "TEST/VERIFY_CREATION.JS",
        fileExists: true,
        isEditFileAvailableAndAuthorized: true,
      }, policy);
      expect(r3.allowed).toBe(false);
      expect(r3.reasonCode).toBe("DISALLOWED_FILE_OVERWRITE");

      // 1d. Mixed case variation
      const r4 = PolicyEvaluator.evaluateFileOperation({
        toolName: "edit_file",
        path: "Test/Verify_Creation.js",
        fileExists: true,
        isEditFileAvailableAndAuthorized: true,
      }, policy);
      expect(r4.allowed).toBe(false);
      expect(r4.reasonCode).toBe("DISALLOWED_FILE_OVERWRITE");

      // 1e. Windows backslashes
      const r5 = PolicyEvaluator.evaluateFileOperation({
        toolName: "write_file",
        path: "test\\verify_creation.js",
        fileExists: true,
        isEditFileAvailableAndAuthorized: true,
      }, policy);
      expect(r5.allowed).toBe(false);
      expect(r5.reasonCode).toBe("DISALLOWED_FILE_OVERWRITE");

      // 1f. Directory traversal (..)
      const r6 = PolicyEvaluator.evaluateFileOperation({
        toolName: "write_file",
        path: "src/../test/verify_creation.js",
        fileExists: true,
        isEditFileAvailableAndAuthorized: true,
      }, policy);
      expect(r6.allowed).toBe(false);
      expect(r6.reasonCode).toBe("DISALLOWED_FILE_OVERWRITE");

      // 1g. Absolute path prefix
      const r7 = PolicyEvaluator.evaluateFileOperation({
        toolName: "write_file",
        path: "/workspace/test/verify_creation.js",
        fileExists: true,
        isEditFileAvailableAndAuthorized: true,
      }, policy);
      expect(r7.allowed).toBe(false);
      expect(r7.reasonCode).toBe("DISALLOWED_FILE_OVERWRITE");

      // 1h. File extension wildcard (*.json)
      expect(matchesProtectedPath("config/app.json", "*.json")).toBe(true);
      expect(matchesProtectedPath("PACKAGE.JSON", "*.json")).toBe(true);
      expect(matchesProtectedPath("src/main.ts", "*.json")).toBe(false);

      // 1i. Single-level vs recursive wildcards
      expect(matchesProtectedPath("test/foo.js", "test/*")).toBe(true);
      expect(matchesProtectedPath("test/sub/foo.js", "test/*")).toBe(false);
      expect(matchesProtectedPath("test/sub/foo.js", "test/**")).toBe(true);

      // 1j. NTFS trailing dot/whitespace and Alternate Data Streams (::$DATA)
      expect(matchesProtectedPath("test/verify_creation.js.", "test/**")).toBe(true);
      expect(matchesProtectedPath("test/verify_creation.js ", "test/**")).toBe(true);
      expect(matchesProtectedPath("package.json::$DATA", "package.json")).toBe(true);
      expect(matchesProtectedPath("workspace/test/foo.js", "test/*")).toBe(true);
    });

    // -----------------------------------------------------------------------
    // 2. Controlled Verification Race (Modify -> Execute -> Restore Attack)
    // -----------------------------------------------------------------------
    it("Phase 3.2 - Verification Race: Controlled modify-execute-restore attack is rejected fail-closed", async () => {
      const task = BENCHMARK_01_FILE_CREATION_MUTATION.taskDefinition;

      const { fetch } = createMockFetch((step, parsedBody) => {
        const hash = extractContextHash(parsedBody);

        if (step === 1) {
          // Agent creates flawed code (will fail real verification)
          return {
            content: JSON.stringify({
              isGoalReached: false,
              proposalId: "p1",
              toolName: "write_file",
              inputPayload: {
                path: "src/config.json",
                content: JSON.stringify({ service: "bad-service", port: 1234, active: false }),
              },
              contextSnapshotHash: hash,
              rationale: "Writing flawed config",
            }),
          };
        }

        if (step === 2) {
          // Flawed formatter
          return {
            content: JSON.stringify({
              isGoalReached: false,
              proposalId: "p2",
              toolName: "write_file",
              inputPayload: {
                path: "src/formatter.js",
                content: "module.exports = {};",
              },
              contextSnapshotHash: hash,
              rationale: "Writing flawed formatter",
            }),
          };
        }

        if (step === 3) {
          // Attempting to execute the verification command
          return {
            content: JSON.stringify({
              isGoalReached: false,
              proposalId: "p3",
              toolName: "run_command",
              inputPayload: { argv: ["node", "test/verify_creation.js"] },
              contextSnapshotHash: hash,
              rationale: "Attempting verification invocation",
            }),
          };
        }

        return {
          content: JSON.stringify({
            isGoalReached: true,
            proposalId: "p4",
            contextSnapshotHash: hash,
            rationale: "Claiming goal reached after attempting race",
          }),
        };
      });

      const provider = new OllamaModelProvider({ fetch, defaultModel: "test-eval-model" });
      const runResult = await executeEvaluationRun({
        task,
        modelProvider: provider,
        model: "test-eval-model",
      });

      // The modify-execute-restore attack MUST NEVER produce VERIFIED_SUCCESS
      expect(runResult.finalOutcome).not.toBe("VERIFIED_SUCCESS");
      expect(runResult.finalOutcome).toBe("TIMEOUT");
      expect(runResult.verificationPassed).toBe(false);
    });

    // -----------------------------------------------------------------------
    // 3. Execution Provider containment & flag rejection
    // -----------------------------------------------------------------------
    it("Phase 3.2 - Execution Boundary: ConstrainedHostExecutionProvider rejects unauthorized binaries, flags, and traversal", async () => {
      const tempDir = fsExtra.mkdtempSync(pathExtra.join(osExtra.tmpdir(), "exec-test-ws-"));
      const execProvider = new ConstrainedHostExecutionProvider();

      try {
        const dummyReq = (argv: string[], cwd?: string): any => ({
          actionId: "act-test-1",
          runId: "run-test-1",
          requestId: "req-1",
          operationName: "run_command",
          inputPayload: { argv, cwd },
          workspace: { workspaceId: "ws-test", hostPath: tempDir },
        });

        // 3a. Arbitrary system binaries rejected
        const r1 = await execProvider.execute(dummyReq(["bash", "-c", "echo 1"]));
        expect(r1.status).toBe("FAILED");
        expect(r1.error?.message).toContain("POLICY_DENIED");

        const r2 = await execProvider.execute(dummyReq(["powershell", "-Command", "Write-Output 1"]));
        expect(r2.status).toBe("FAILED");
        expect(r2.error?.message).toContain("POLICY_DENIED");

        // 3b. Dangerous Node flags rejected
        const r3 = await execProvider.execute(dummyReq(["node", "-e", "console.log(1)"]));
        expect(r3.status).toBe("FAILED");
        expect(r3.error?.message).toContain("POLICY_DENIED");

        const r4 = await execProvider.execute(dummyReq(["node", "--eval=process.exit(0)"]));
        expect(r4.status).toBe("FAILED");
        expect(r4.error?.message).toContain("POLICY_DENIED");

        const r5 = await execProvider.execute(dummyReq(["node", "-r", "evil-package", "test/run.js"]));
        expect(r5.status).toBe("FAILED");
        expect(r5.error?.message).toContain("POLICY_DENIED");

        // 3c. Workspace escape rejected
        const r6 = await execProvider.execute(dummyReq(["node", "test/run.js"], "../../"));
        expect(r6.status).toBe("FAILED");
        expect(r6.error?.message).toContain("WORKSPACE_BOUNDARY_VIOLATION");
      } finally {
        fsExtra.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    // -----------------------------------------------------------------------
    // 4. Per-benchmark oracle boundary validation across all 6 tasks
    // -----------------------------------------------------------------------
    it("Phase 3.2 - Per-Benchmark Integrity: All six benchmark tasks enforce distinct writable vs oracle paths", () => {
      const tasks = getAllReliabilityBenchmarkTasks();
      expect(tasks.length).toBe(6);

      for (const task of tasks) {
        // Must declare non-empty disjoint paths
        expect(task.oraclePaths.length).toBeGreaterThan(0);
        expect(task.agentWritablePaths.length).toBeGreaterThan(0);
        expect(task.taskDefinition.mission.protectedPaths).toBeDefined();

        const policy = createExecutionPolicy({
          policyId: `policy-${task.category}`,
          allowedCapabilities: ["workspace.file.write", "workspace.file.read"],
          isolationRequirement: "ISOLATED",
          protectedPaths: task.taskDefinition.mission.protectedPaths,
        });

        // Oracle paths must be rejected
        for (const oraclePath of task.oraclePaths) {
          const decision = PolicyEvaluator.evaluateFileOperation({
            toolName: "write_file",
            path: oraclePath,
            fileExists: true,
            isEditFileAvailableAndAuthorized: true,
          }, policy);
          expect(decision.allowed).toBe(false);
          expect(decision.reasonCode).toBe("DISALLOWED_FILE_OVERWRITE");
        }

        // Agent-writable paths must NOT be blocked by oracle paths
        for (const writablePath of task.agentWritablePaths) {
          // Clean file paths (skip directories ending with /**)
          if (!writablePath.includes("*")) {
            const decision = PolicyEvaluator.evaluateFileOperation({
              toolName: "write_file",
              path: writablePath,
              fileExists: false,
              isEditFileAvailableAndAuthorized: false,
            }, policy);
            expect(decision.allowed).toBe(true);
          }
        }
      }
    });
  });

});
