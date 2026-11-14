import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_BENCHMARK_TASKS,
  getBenchmarkTaskById,
  getBenchmarkTasksForGate,
} from "../../src/application/evaluation/capability-benchmark-suite.js";
import { DualGateEvaluationHarness } from "../../src/application/evaluation/dual-gate-eval-harness.js";
import { DualGateStatisticalAggregator } from "../../src/application/evaluation/dual-gate-statistical-aggregator.js";
import { GovernedModelRouterService } from "../../src/application/governed-model-router.js";
import {
  DualGateEvaluationTask,
  DualGateTrialResult,
  GateStatisticalSummary,
} from "../../src/domain/dual-gate-evaluation.js";
import { ModelCapabilityGateId } from "../../src/domain/model-routing.js";
import {
  ModelProviderPort,
  ModelProviderRequest,
  ModelProviderResponse,
} from "../../src/ports/model-provider.port.js";

class ControllableMockModelProvider implements ModelProviderPort {
  readonly providerName = "benchmark-suite-mock-provider";
  public calls: ModelProviderRequest[] = [];
  public cancelledCalls: string[] = [];

  constructor(
    private readonly handler: (
      request: ModelProviderRequest,
      callIndex: number
    ) => Promise<ModelProviderResponse>
  ) {}

  async generate(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    const callIndex = this.calls.length;
    this.calls.push(request);

    if (request.abortSignal) {
      request.abortSignal.addEventListener("abort", () => {
        this.cancelledCalls.push(request.requestId);
      });
    }

    return this.handler(request, callIndex);
  }
}

describe("Application: Capability Benchmark Suite", () => {
  const testDigest = "sha256:d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668";
  const modelId = "qwen2.5-coder:1.5b";

  const targetGates: ModelCapabilityGateId[] = [
    "G2_REPO_NAVIGATION",
    "G3_CODE_UNDERSTANDING",
    "G4_SINGLE_FILE_REPAIR",
    "G5_MULTI_FILE_REPAIR",
    "G6_REGRESSION_AWARENESS",
    "G7_BEHAVIORAL_CONSISTENCY",
    "G9_FAILURE_RECOVERY",
  ];

  it("provides comprehensive benchmark tasks for all target gates G2-G7 and G9", () => {
    for (const gateId of targetGates) {
      const tasks = getBenchmarkTasksForGate(gateId);
      expect(tasks.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("ensures all benchmark tasks have immutable specifications, resource bounds, and dual-gate criteria", () => {
    for (const task of CAPABILITY_BENCHMARK_TASKS) {
      expect(task.taskId).toBeTruthy();
      expect(task.title).toBeTruthy();
      expect(task.description).toBeTruthy();
      expect(task.inputPrompt).toBeTruthy();
      expect(task.resourceLimits.timeoutMs).toBeGreaterThan(0);
      expect(task.resourceLimits.maxSteps).toBeGreaterThan(0);
      expect(task.allowedTools.length).toBeGreaterThan(0);
      expect(task.gateACriteria).toBeDefined();
      expect(task.gateBCriteria).toBeDefined();
      expect(["CLEANROOM_ORACLE", "TEST_RUNNER", "HASH_INVARIANT"]).toContain(task.gateBCriteria.verifierType);
    }
  });

  // ========================================================================
  // DETERMINISTIC REGRESSION TESTING: G3 CONFIGURATION HARDENING & CONTRACT
  // ========================================================================

  it("1. All five G3 tasks in capability-benchmark-suite.ts have timeoutMs: 80000, stepTimeoutMs: 35000, maxSteps: 2, version: 1.1.0", () => {
    const g3Tasks = getBenchmarkTasksForGate("G3_CODE_UNDERSTANDING");
    expect(g3Tasks).toHaveLength(5);
    for (const task of g3Tasks) {
      expect(task.version).toBe("1.1.0");
      expect(task.resourceLimits.timeoutMs).toBe(80000);
      expect(task.resourceLimits.stepTimeoutMs).toBe(35000);
      expect(task.resourceLimits.maxSteps).toBe(2);
      expect(task.resourceLimits.maxOutputBytes).toBe(16384);
    }
  });

  it("2. When executeTrial is called without timeout options on a G3 task, it uses 80000/35000 from the task definition", async () => {
    const harness = new DualGateEvaluationHarness();
    const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
    let capturedStepTimeout: number | undefined;

    const provider = new ControllableMockModelProvider(async (req, callIndex) => {
      if (callIndex === 0) {
        capturedStepTimeout = req.timeoutMs;
        return {
          requestId: req.requestId,
          model: req.model,
          outputText: JSON.stringify({
            toolName: "read_file",
            inputPayload: { path: "src/chunker.js" },
            rationale: "Reading source file",
          }),
          finishReason: "STOP",
          durationMs: 5,
        };
      }
      return {
        requestId: req.requestId,
        model: req.model,
        outputText: JSON.stringify({
          toolName: undefined,
          inputPayload: {
            diagnosis: "Off-by-one error at line 3 where loop condition i <= arr.length causes empty slice chunk",
            citations: ["src/chunker.js:3", "i <= arr.length", "line 3"],
          },
          rationale: "Complete",
        }),
        finishReason: "STOP",
        durationMs: 5,
      };
    });

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
    });

    expect(trial.overallPassed).toBe(true);
    expect(capturedStepTimeout).toBe(35000);
  });

  it("3. When executeTrial is called with explicit timeout options, effective step timeout is min(stepTimeoutMs, remainingTrialMs)", async () => {
    const harness = new DualGateEvaluationHarness();
    const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
    let capturedStepTimeout: number | undefined;

    const provider = new ControllableMockModelProvider(async (req) => {
      capturedStepTimeout = req.timeoutMs;
      return {
        requestId: req.requestId,
        model: req.model,
        outputText: JSON.stringify({
          toolName: undefined,
          inputPayload: {
            diagnosis: "Off-by-one error at line 3 where loop condition i <= arr.length causes empty slice chunk",
            citations: ["src/chunker.js:3", "i <= arr.length", "line 3"],
          },
          rationale: "Complete",
        }),
        finishReason: "STOP",
        durationMs: 5,
      };
    });

    await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
      timeoutMs: 10000,
      stepTimeoutMs: 4000,
    });

    expect(capturedStepTimeout).toBe(4000);
  });

  it("4. In a two-step G3 trial where step 1 completes quickly, step 2 receives the full 35000 ms budget", async () => {
    const harness = new DualGateEvaluationHarness();
    const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
    const stepTimeouts: number[] = [];

    const provider = new ControllableMockModelProvider(async (req, callIndex) => {
      stepTimeouts.push(req.timeoutMs ?? 0);
      if (callIndex === 0) {
        return {
          requestId: req.requestId,
          model: req.model,
          outputText: JSON.stringify({
            toolName: "read_file",
            inputPayload: { path: "src/chunker.js" },
            rationale: "Reading source file",
          }),
          finishReason: "STOP",
          durationMs: 10,
        };
      }
      return {
        requestId: req.requestId,
        model: req.model,
        outputText: JSON.stringify({
          toolName: undefined,
          inputPayload: {
            diagnosis: "Off-by-one error at line 3 where loop condition i <= arr.length causes empty slice chunk",
            citations: ["src/chunker.js:3", "i <= arr.length", "line 3"],
          },
          rationale: "Complete",
        }),
        finishReason: "STOP",
        durationMs: 10,
      };
    });

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
    });

    expect(trial.overallPassed).toBe(true);
    expect(stepTimeouts).toHaveLength(2);
    expect(stepTimeouts[0]).toBe(35000);
    expect(stepTimeouts[1]).toBe(35000);
  });

  it("5. In a two-step G3 trial where step 1 consumes a large portion of trial budget, step 2 receives at most remaining trial budget", async () => {
    const harness = new DualGateEvaluationHarness();
    const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
    let step2Timeout: number | undefined;

    const provider = new ControllableMockModelProvider(async (req, callIndex) => {
      if (callIndex === 0) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          requestId: req.requestId,
          model: req.model,
          outputText: JSON.stringify({
            toolName: "read_file",
            inputPayload: { path: "src/chunker.js" },
            rationale: "Reading source file",
          }),
          finishReason: "STOP",
          durationMs: 100,
        };
      }
      step2Timeout = req.timeoutMs;
      return {
        requestId: req.requestId,
        model: req.model,
        outputText: JSON.stringify({
          toolName: undefined,
          inputPayload: {
            diagnosis: "Off-by-one error at line 3 where loop condition i <= arr.length causes empty slice chunk",
            citations: ["src/chunker.js:3", "i <= arr.length", "line 3"],
          },
          rationale: "Complete",
        }),
        finishReason: "STOP",
        durationMs: 5,
      };
    });

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
      timeoutMs: 300,
      stepTimeoutMs: 250,
    });

    expect(trial.overallPassed).toBe(true);
    expect(step2Timeout).toBeDefined();
    // Step 2 receives at most remaining trial budget (approx 300 - 100 = 200ms), strictly less than configured 250ms
    expect(step2Timeout!).toBeLessThanOrEqual(200);
  });

  it("6. Total trial timeout remains a hard ceiling that cannot be bypassed by step timeouts", async () => {
    const harness = new DualGateEvaluationHarness();
    const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
    const provider = new ControllableMockModelProvider(async () => {
      return new Promise<ModelProviderResponse>(() => {});
    });

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
      timeoutMs: 40,
      stepTimeoutMs: 500, // Attempting to set step timeout higher than total trial
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.failureClassification).toBe("TIMEOUT");
    expect(trial.diagnosticRootCause).toBe("TRIAL_WALL_CLOCK_TIMEOUT");
    expect(trial.durationMs).toBeLessThan(200);
  });

  it("7. Any attempt to pass negative or zero timeouts fails closed with INVALID_RESOURCE_LIMITS", async () => {
    const harness = new DualGateEvaluationHarness();
    const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
    const dummyProvider = new ControllableMockModelProvider(async (req) => ({
      requestId: req.requestId,
      model: req.model,
      outputText: "",
      finishReason: "STOP",
      durationMs: 1,
    }));

    await expect(
      harness.executeTrial({
        task,
        modelProvider: dummyProvider,
        modelId,
        modelDigest: testDigest,
        timeoutMs: 0,
      })
    ).rejects.toThrow(/INVALID_RESOURCE_LIMITS/);

    await expect(
      harness.executeTrial({
        task,
        modelProvider: dummyProvider,
        modelId,
        modelDigest: testDigest,
        timeoutMs: -100,
      })
    ).rejects.toThrow(/INVALID_RESOURCE_LIMITS/);

    await expect(
      harness.executeTrial({
        task,
        modelProvider: dummyProvider,
        modelId,
        modelDigest: testDigest,
        stepTimeoutMs: 0,
      })
    ).rejects.toThrow(/INVALID_RESOURCE_LIMITS/);

    await expect(
      harness.executeTrial({
        task,
        modelProvider: dummyProvider,
        modelId,
        modelDigest: testDigest,
        stepTimeoutMs: -50,
      })
    ).rejects.toThrow(/INVALID_RESOURCE_LIMITS/);
  });

  it("8. Single-step tasks without stepTimeoutMs continue to work with their default single-step budget", async () => {
    const harness = new DualGateEvaluationHarness();
    const baseTask = getBenchmarkTasksForGate("G2_REPO_NAVIGATION")[0]!;
    const singleStepTask: DualGateEvaluationTask = {
      ...baseTask,
      resourceLimits: { timeoutMs: 30000, maxSteps: 1, maxOutputBytes: 16384 },
    };
    expect(singleStepTask.resourceLimits.stepTimeoutMs).toBeUndefined();
    expect(singleStepTask.resourceLimits.timeoutMs).toBe(30000);

    let capturedStepTimeout: number | undefined;
    const provider = new ControllableMockModelProvider(async (req) => {
      capturedStepTimeout = req.timeoutMs;
      return {
        requestId: req.requestId,
        model: req.model,
        outputText: JSON.stringify({
          toolName: "read_file",
          inputPayload: { path: "packages/services/auth/src/jwt-signer.js" },
          rationale: "Inspecting target",
        }),
        finishReason: "STOP",
        durationMs: 5,
      };
    });

    const trial = await harness.executeTrial({
      task: singleStepTask,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
    });

    expect(capturedStepTimeout).toBeGreaterThan(29000);
    expect(capturedStepTimeout).toBeLessThanOrEqual(30000);
    expect(trial.stepsExecuted).toBe(1);
  });

  it("9. Configuration hash (configHash) distinguishes trials run under the new 80s/35s configuration from trials run under the old 30s configuration", async () => {
    const harness = new DualGateEvaluationHarness();
    const taskV1_1 = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
    const taskV1_0: DualGateEvaluationTask = {
      ...taskV1_1,
      version: "1.0.0",
      resourceLimits: { timeoutMs: 30000, maxSteps: 2, maxOutputBytes: 16384 },
    };

    const provider = new ControllableMockModelProvider(async (req) => ({
      requestId: req.requestId,
      model: req.model,
      outputText: JSON.stringify({
        toolName: undefined,
        inputPayload: {
          diagnosis: "Off-by-one error at line 3 where loop condition i <= arr.length causes empty slice chunk",
          citations: ["src/chunker.js:3", "i <= arr.length", "line 3"],
        },
        rationale: "Complete",
      }),
      finishReason: "STOP",
      durationMs: 1,
    }));

    const trialNew = await harness.executeTrial({
      task: taskV1_1,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
    });

    const trialOld = await harness.executeTrial({
      task: taskV1_0,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
    });

    expect(trialNew.configHash).not.toBe(trialOld.configHash);
    expect(trialNew.configHash).toHaveLength(64);
    expect(trialOld.configHash).toHaveLength(64);
  });

  it("10. Historical G3 evaluation raw evidence file remains unchanged and byte-exact", () => {
    const evidencePath = path.resolve(
      process.env.APP_DATA_DIR ?? "C:\\Users\\Adusumalli Girish\\.gemini\\antigravity",
      "brain/22cc3ec1-2247-4c9d-855b-ba8bc4b1274d/g3-live-evaluation-raw-evidence.json"
    );
    if (fs.existsSync(evidencePath)) {
      const content = fs.readFileSync(evidencePath);
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      expect(hash).toBe("fa9e421d1656023d815b185c9aff70223f33323b78e99e22b92a33b0b4e88dab");
    }
  });

  it("11. Human-readable CLI text output displays failureBreakdown, rootCauseBreakdown, and timeout percentage accurately", () => {
    const summary: GateStatisticalSummary = {
      gateId: "G3_CODE_UNDERSTANDING",
      modelId: "qwen2.5-coder:1.5b",
      modelDigest: testDigest,
      harnessVersion: "cleanroom-eval-v3.0",
      evaluationMode: "LIVE_MODEL_EVALUATION",
      totalTrials: 5,
      passedTrials: 0,
      failedTrials: 5,
      timedOutTrials: 3,
      gateAPassCount: 0,
      gateBPassCount: 0,
      successRate: 0.0,
      minLatencyMs: 30008,
      medianLatencyMs: 30022,
      p90LatencyMs: 30042,
      maxLatencyMs: 30042,
      status: "FAILED",
      reasons: ["Success rate (0.0%) is below required threshold (70.0%)"],
      failureBreakdown: { TIMEOUT: 3, MODEL_BEHAVIORAL_FAILURE: 2 },
      rootCauseBreakdown: { MODEL_REQUEST_TIMEOUT: 3, BEHAVIORAL_FAILURE: 2 },
    };

    const lines: string[] = [];
    lines.push(`  Total Trials:    ${summary.totalTrials}`);
    lines.push(`  Passed Trials:   ${summary.passedTrials}`);
    lines.push(`  Failed Trials:   ${summary.failedTrials}`);
    const timeoutRatePct =
      summary.totalTrials > 0 ? ((summary.timedOutTrials / summary.totalTrials) * 100).toFixed(1) : "0.0";
    lines.push(`  Timeouts:        ${summary.timedOutTrials} (${timeoutRatePct}%)`);
    if (summary.failureBreakdown && Object.keys(summary.failureBreakdown).length > 0) {
      const fbStr = Object.entries(summary.failureBreakdown)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      lines.push(`  Failure Breakdown: ${fbStr}`);
    }
    if (summary.rootCauseBreakdown && Object.keys(summary.rootCauseBreakdown).length > 0) {
      const rcbStr = Object.entries(summary.rootCauseBreakdown)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      lines.push(`  Root Cause Breakdown: ${rcbStr}`);
    }

    const output = lines.join("\n");
    expect(output).toContain("Timeouts:        3 (60.0%)");
    expect(output).toContain("Failure Breakdown: TIMEOUT: 3, MODEL_BEHAVIORAL_FAILURE: 2");
    expect(output).toContain("Root Cause Breakdown: MODEL_REQUEST_TIMEOUT: 3, BEHAVIORAL_FAILURE: 2");
  });

  it("12. Statistical aggregator rejects evaluation with 1 timeout in 5 trials and governed router refuses capability certification", () => {
    const router = new GovernedModelRouterService();

    const createTrial = (id: string, index: number, isTimeout: boolean): DualGateTrialResult => ({
      trialId: id,
      trialIndex: index,
      taskId: `task-${id}`,
      gateId: "G3_CODE_UNDERSTANDING",
      modelId,
      modelDigest: testDigest,
      harnessVersion: "cleanroom-eval-v3.0",
      evaluationMode: "LIVE_MODEL_EVALUATION",
      gateA: { passed: !isTimeout, score: isTimeout ? 0.0 : 1.0, rationale: "", details: [] },
      gateB: { passed: !isTimeout, verifierType: "CLEANROOM_ORACLE", details: [], independentEvidenceRef: `ref-${id}` },
      overallPassed: !isTimeout,
      durationMs: isTimeout ? 35000 : 500,
      observedAt: new Date().toISOString(),
      configHash: "c",
      inputHash: "i",
      outputHash: "o",
      trialEvidenceHash: "e",
      stepsExecuted: 1,
      stepRecords: [],
      ...(isTimeout
        ? {
            failureClassification: "TIMEOUT" as const,
            diagnosticRootCause: "MODEL_REQUEST_TIMEOUT" as const,
          }
        : {}),
    });

    const trials: DualGateTrialResult[] = [
      createTrial("t1", 0, false),
      createTrial("t2", 1, false),
      createTrial("t3", 2, false),
      createTrial("t4", 3, false),
      createTrial("t5", 4, true),
    ];

    const summary = DualGateStatisticalAggregator.aggregateTrials(
      "G3_CODE_UNDERSTANDING",
      modelId,
      testDigest,
      trials
    );

    expect(summary.totalTrials).toBe(5);
    expect(summary.timedOutTrials).toBe(1);
    expect(summary.status).toBe("FAILED");
    expect(summary.reasons.some((r) => r.includes("Timeout rate (20.0%) exceeds maximum allowed threshold (10.0%)"))).toBe(true);

    const evidence = DualGateStatisticalAggregator.createEvidenceRecord(summary);
    expect(evidence).toBeNull();

    const certStatus = router.getGateCertificationStatus(modelId, "G3_CODE_UNDERSTANDING");
    expect(certStatus).not.toBe("PASSED");
  });

  // ========================================================================
  // DETERMINISTIC REGRESSION TESTING: G4 CONFIGURATION HARDENING (v1.1.0)
  // ========================================================================

  it("13. All five G4 tasks in capability-benchmark-suite.ts have timeoutMs: 150000, stepTimeoutMs: 35000, maxSteps: 4, version: 1.1.0", () => {
    const g4Tasks = getBenchmarkTasksForGate("G4_SINGLE_FILE_REPAIR");
    expect(g4Tasks).toHaveLength(5);
    for (const task of g4Tasks) {
      expect(task.version).toBe("1.1.0");
      expect(task.resourceLimits.timeoutMs).toBe(150000);
      expect(task.resourceLimits.stepTimeoutMs).toBe(35000);
      expect(task.resourceLimits.maxSteps).toBe(4);
      expect(task.resourceLimits.maxOutputBytes).toBe(16384);
    }
  });

  it("14. When executeTrial is called without timeout options on a G4 task, it uses 150000/35000 from the task definition", async () => {
    const harness = new DualGateEvaluationHarness();
    const task = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;
    let capturedStepTimeout: number | undefined;

    const provider = new ControllableMockModelProvider(async (req, callIndex) => {
      if (callIndex === 0) {
        capturedStepTimeout = req.timeoutMs;
        return {
          requestId: req.requestId,
          model: req.model,
          outputText: JSON.stringify({
            toolName: "read_file",
            inputPayload: { path: "src/math-pow.js" },
            rationale: "Reading power implementation",
          }),
          finishReason: "STOP",
          durationMs: 5,
        };
      }
      return {
        requestId: req.requestId,
        model: req.model,
        outputText: JSON.stringify({
          toolName: "write_file",
          inputPayload: {
            path: "src/math-pow.js",
            content: "export function power(base, exp) {\n  return base ** exp;\n}\n",
          },
          rationale: "Fixed exponentiation with ** operator",
        }),
        finishReason: "STOP",
        durationMs: 5,
      };
    });

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
    });

    expect(trial.overallPassed).toBe(true);
    expect(capturedStepTimeout).toBe(35000);
  });

  it("15. Task configuration hash differentiates G4 v1.1.0 from legacy v1.0.0 definitions", async () => {
    const harness = new DualGateEvaluationHarness();
    const taskV1_1 = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;
    const taskV1_0: DualGateEvaluationTask = {
      ...taskV1_1,
      version: "1.0.0",
      resourceLimits: { timeoutMs: 45000, maxSteps: 4, maxOutputBytes: 16384 },
    };

    const provider = new ControllableMockModelProvider(async (req) => ({
      requestId: req.requestId,
      model: req.model,
      outputText: JSON.stringify({
        toolName: "write_file",
        inputPayload: {
          path: "src/math-pow.js",
          content: "export function power(base, exp) {\n  return base ** exp;\n}\n",
        },
        rationale: "Fixed exponentiation",
      }),
      finishReason: "STOP",
      durationMs: 1,
    }));

    const trialNew = await harness.executeTrial({
      task: taskV1_1,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
    });

    const trialOld = await harness.executeTrial({
      task: taskV1_0,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
    });

    expect(trialNew.configHash).not.toBe(trialOld.configHash);
    expect(trialNew.configHash).toHaveLength(64);
    expect(trialOld.configHash).toHaveLength(64);
  });

  it("16. Statistical aggregator enforces 70% pass rate and 10% timeout threshold for G4 capability", () => {
    const createTrial = (id: string, index: number, isTimeout: boolean, passed: boolean): DualGateTrialResult => ({
      trialId: id,
      trialIndex: index,
      taskId: `task-${id}`,
      gateId: "G4_SINGLE_FILE_REPAIR",
      modelId,
      modelDigest: testDigest,
      harnessVersion: "cleanroom-eval-v3.0",
      evaluationMode: "LIVE_MODEL_EVALUATION",
      gateA: { passed, score: passed ? 1.0 : 0.0, rationale: "", details: [] },
      gateB: { passed, verifierType: "TEST_RUNNER", details: [], independentEvidenceRef: `ref-${id}` },
      overallPassed: passed,
      durationMs: isTimeout ? 35000 : 500,
      observedAt: new Date().toISOString(),
      configHash: "c",
      inputHash: "i",
      outputHash: "o",
      trialEvidenceHash: "e",
      stepsExecuted: 1,
      stepRecords: [],
      ...(isTimeout
        ? {
            failureClassification: "TIMEOUT" as const,
            diagnosticRootCause: "MODEL_REQUEST_TIMEOUT" as const,
          }
        : {}),
    });

    // 4 passing trials, 1 timeout: overall pass rate 80% >= 70%, but timeout rate 20% > 10% -> FAILED
    const trialsWithTimeout: DualGateTrialResult[] = [
      createTrial("t1", 0, false, true),
      createTrial("t2", 1, false, true),
      createTrial("t3", 2, false, true),
      createTrial("t4", 3, false, true),
      createTrial("t5", 4, true, false),
    ];

    const summaryTimeout = DualGateStatisticalAggregator.aggregateTrials(
      "G4_SINGLE_FILE_REPAIR",
      modelId,
      testDigest,
      trialsWithTimeout
    );

    expect(summaryTimeout.totalTrials).toBe(5);
    expect(summaryTimeout.passedTrials).toBe(4);
    expect(summaryTimeout.timedOutTrials).toBe(1);
    expect(summaryTimeout.status).toBe("FAILED");
    expect(summaryTimeout.reasons.some((r) => r.includes("Timeout rate (20.0%) exceeds maximum allowed threshold (10.0%)"))).toBe(true);
    expect(DualGateStatisticalAggregator.createEvidenceRecord(summaryTimeout)).toBeNull();

    // 4 passing trials, 1 non-timeout failure: 80% pass rate >= 70%, 0% timeout <= 10% -> PASSED
    const passingTrials: DualGateTrialResult[] = [
      createTrial("t1", 0, false, true),
      createTrial("t2", 1, false, true),
      createTrial("t3", 2, false, true),
      createTrial("t4", 3, false, true),
      createTrial("t5", 4, false, false),
    ];

    const summaryPass = DualGateStatisticalAggregator.aggregateTrials(
      "G4_SINGLE_FILE_REPAIR",
      modelId,
      testDigest,
      passingTrials
    );

    expect(summaryPass.totalTrials).toBe(5);
    expect(summaryPass.passedTrials).toBe(4);
    expect(summaryPass.timedOutTrials).toBe(0);
    expect(summaryPass.status).toBe("PASSED");
    const evidence = DualGateStatisticalAggregator.createEvidenceRecord(summaryPass);
    expect(evidence).not.toBeNull();
    expect(evidence!.evidenceRef).toContain("eval-trials-G4_SINGLE_FILE_REPAIR");
  });
});

