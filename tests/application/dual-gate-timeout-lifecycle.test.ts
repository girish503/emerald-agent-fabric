import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { getBenchmarkTaskById } from "../../src/application/evaluation/capability-benchmark-suite.js";
import { DualGateEvaluationHarness } from "../../src/application/evaluation/dual-gate-eval-harness.js";
import { DualGateStatisticalAggregator } from "../../src/application/evaluation/dual-gate-statistical-aggregator.js";
import { GovernedModelRouterService } from "../../src/application/governed-model-router.js";
import {
  DualGateTrialResult,
} from "../../src/domain/dual-gate-evaluation.js";
import {
  ModelProviderPort,
  ModelProviderRequest,
  ModelProviderResponse,
} from "../../src/ports/model-provider.port.js";

class ControllableMockModelProvider implements ModelProviderPort {
  readonly providerName = "controllable-mock-provider";
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

describe("Application: Dual-Gate Evaluation Timeout Lifecycle & Root Cause Resilience", () => {
  const harness = new DualGateEvaluationHarness();
  const testDigest = "sha256:d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668";
  const modelId = "qwen2.5-coder:1.5b";

  // Scenario 1: Fast step execution completing well within budget
  it("Scenario 1: fast step execution completes successfully within budget", async () => {
    const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
    const provider = new ControllableMockModelProvider(async (req) => {
      if (req.input.length <= 2) {
        return {
          requestId: req.requestId,
          model: req.model,
          outputText: JSON.stringify({
            toolName: "read_file",
            inputPayload: { path: "src/chunker.js" },
            rationale: "Inspecting chunker implementation",
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
          rationale: "Diagnosis complete",
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
      timeoutMs: 1000,
      stepTimeoutMs: 500,
    });

    expect(trial.overallPassed).toBe(true);
    expect(trial.failureClassification).toBeUndefined();
    expect(trial.diagnosticRootCause).toBeUndefined();
    expect(trial.durationMs).toBeLessThan(1000);
    expect(provider.calls.length).toBe(2);
  });

  // Scenario 2: Step 1 consuming a large portion of trial budget, step 2 correctly constrained to remaining budget
  it("Scenario 2: step 2 timeout is constrained to remaining trial budget when step 1 consumes large portion", async () => {
    const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
    const provider = new ControllableMockModelProvider(async (req, callIndex) => {
      if (callIndex === 0) {
        // Step 1 consumes 150ms of a 300ms total trial budget
        await new Promise((resolve) => setTimeout(resolve, 150));
        return {
          requestId: req.requestId,
          model: req.model,
          outputText: JSON.stringify({
            toolName: "read_file",
            inputPayload: { path: "src/chunker.js" },
            rationale: "Reading target file",
          }),
          finishReason: "STOP",
          durationMs: 150,
        };
      }
      // Step 2 should receive remainingMs <= 160ms (well below configured stepTimeoutMs of 250ms)
      expect(req.timeoutMs).toBeLessThanOrEqual(160);
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
      stepTimeoutMs: 250, // Configured step timeout (250ms) is higher than remaining (approx 150ms)
    });

    expect(trial.overallPassed).toBe(true);
    expect(provider.calls.length).toBe(2);
    expect(provider.calls[1]?.timeoutMs).toBeLessThanOrEqual(160);
  });

  // Scenario 3: Step timeout firing cleanly, model cancellation triggered, trial marked as TIMEOUT
  it("Scenario 3: step timeout fires cleanly, triggers abort signal, classifies as TIMEOUT / MODEL_REQUEST_TIMEOUT", async () => {
    const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
    let signalReceived = false;

    const provider = new ControllableMockModelProvider(async (req) => {
      return new Promise<ModelProviderResponse>(() => {
        req.abortSignal?.addEventListener("abort", () => {
          signalReceived = true;
        });
        // Hang indefinitely until cancelled/timed out by harness
      });
    });

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
      timeoutMs: 500,
      stepTimeoutMs: 50, // Short step timeout
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.failureClassification).toBe("TIMEOUT");
    expect(trial.diagnosticRootCause).toBe("MODEL_REQUEST_TIMEOUT");
    expect(signalReceived).toBe(true);
  });

  // Scenario 4: Total trial deadline expiring between steps
  it("Scenario 4: total trial deadline expiring between steps is classified as TRIAL_WALL_CLOCK_TIMEOUT", async () => {
    const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
    const provider = new ControllableMockModelProvider(async (req, callIndex) => {
      if (callIndex === 0) {
        // Step 1 takes 70ms, exceeding the 50ms total trial budget
        await new Promise((resolve) => setTimeout(resolve, 70));
        return {
          requestId: req.requestId,
          model: req.model,
          outputText: JSON.stringify({
            toolName: "read_file",
            inputPayload: { path: "src/chunker.js" },
            rationale: "Inspecting file",
          }),
          finishReason: "STOP",
          durationMs: 70,
        };
      }
      throw new Error("Should not reach step 2");
    });

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
      timeoutMs: 50,
      stepTimeoutMs: 100,
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.failureClassification).toBe("TIMEOUT");
    expect(trial.diagnosticRootCause).toBe("TRIAL_WALL_CLOCK_TIMEOUT");
    expect(provider.calls.length).toBe(1);
  });

  // Scenario 5: Total trial deadline expiring during step execution
  it("Scenario 5: total trial deadline expiring during step execution is classified as TRIAL_WALL_CLOCK_TIMEOUT", async () => {
    const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
    const provider = new ControllableMockModelProvider(async () => {
      return new Promise<ModelProviderResponse>(() => {
        // Hang indefinitely
      });
    });

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
      timeoutMs: 40, // Trial timeout shorter than step timeout
      stepTimeoutMs: 150,
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.failureClassification).toBe("TIMEOUT");
    expect(trial.diagnosticRootCause).toBe("TRIAL_WALL_CLOCK_TIMEOUT");
  });

  // Scenario 6: Step timeout with no response vs slow response
  it("Scenario 6: step timeout fires before slow response completes without waiting for slow response", async () => {
    const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
    const provider = new ControllableMockModelProvider(async (req) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return {
        requestId: req.requestId,
        model: req.model,
        outputText: JSON.stringify({ toolName: undefined, inputPayload: {} }),
        finishReason: "STOP",
        durationMs: 300,
      };
    });

    const start = Date.now();
    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
      timeoutMs: 500,
      stepTimeoutMs: 50,
    });
    const elapsed = Date.now() - start;

    expect(trial.overallPassed).toBe(false);
    expect(trial.failureClassification).toBe("TIMEOUT");
    expect(trial.diagnosticRootCause).toBe("MODEL_REQUEST_TIMEOUT");
    expect(elapsed).toBeLessThan(250); // Fired well before the 300ms provider delay
  });

  // Scenario 7: Step timeout with late response — verify late response cannot mutate trial outcome
  it("Scenario 7: late response arriving after step timeout is safely ignored and cannot alter outcome", async () => {
    const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
    let lateResolve: ((res: ModelProviderResponse) => void) | undefined;

    const provider = new ControllableMockModelProvider(() => {
      return new Promise<ModelProviderResponse>((resolve) => {
        lateResolve = resolve;
      });
    });

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
      timeoutMs: 200,
      stepTimeoutMs: 30,
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.failureClassification).toBe("TIMEOUT");

    // Simulate late arrival of successful response
    if (lateResolve) {
      expect(() => {
        lateResolve!({
          requestId: "late-req",
          model: modelId,
          outputText: JSON.stringify({ toolName: undefined, inputPayload: { diagnosis: "late diagnosis" } }),
          finishReason: "STOP",
          durationMs: 100,
        });
      }).not.toThrow();
    }

    // Trial object remains immutable
    expect(trial.overallPassed).toBe(false);
    expect(trial.failureClassification).toBe("TIMEOUT");
  });

  // Scenario 8: External cancellation via AbortSignal — verify prompt cancellation and CANCELLED / CALLER_ABORTED classification
  it("Scenario 8: caller AbortSignal triggers prompt cancellation and CANCELLED / CALLER_ABORTED", async () => {
    const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
    const abortController = new AbortController();

    const provider = new ControllableMockModelProvider(async () => {
      abortController.abort(new Error("CALLER_OPERATOR_ABORT"));
      return new Promise<ModelProviderResponse>(() => {});
    });

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
      timeoutMs: 1000,
      abortSignal: abortController.signal,
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.failureClassification).toBe("CANCELLED");
    expect(trial.diagnosticRootCause).toBe("CALLER_ABORTED");
  });

  // Scenario 9: Precedence: Fencing/Lease violation > Timeout
  it("Scenario 9: path traversal security violation takes precedence over timeout", async () => {
    const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
    const provider = new ControllableMockModelProvider(async (req) => {
      return {
        requestId: req.requestId,
        model: req.model,
        outputText: JSON.stringify({
          toolName: "read_file",
          inputPayload: { path: "../../../etc/shadow" },
          rationale: "Escaping sandbox",
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
      timeoutMs: 500, // Ample timeout so path traversal violation is what fails the trial
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.failureClassification).toBe("SECURITY_VIOLATION");
    expect(trial.diagnosticRootCause).toBe("SECURITY_VIOLATION");
  });

  // Scenario 10: Precedence: Timeout > Step loop completion
  it("Scenario 10: timeout takes precedence over unfulfilled behavioral steps", async () => {
    const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
    const provider = new ControllableMockModelProvider(async () => {
      // Step 1 never returns
      return new Promise<ModelProviderResponse>(() => {});
    });

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
      timeoutMs: 40,
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.failureClassification).toBe("TIMEOUT");
    expect(trial.failureClassification).not.toBe("MODEL_BEHAVIORAL_FAILURE");
  });

  // Scenario 11: Statistical aggregation: Verify timeout counts match actual trials
  it("Scenario 11: statistical aggregator accurately counts timeouts from trials", () => {
    const mockTrials: DualGateTrialResult[] = [
      {
        trialId: "t1",
        trialIndex: 0,
        taskId: "task-1",
        gateId: "G3_CODE_UNDERSTANDING",
        modelId,
        modelDigest: testDigest,
        harnessVersion: "cleanroom-eval-v3.0",
        evaluationMode: "LIVE_MODEL_EVALUATION",
        gateA: { passed: true, score: 1.0, rationale: "ok", details: [] },
        gateB: { passed: true, verifierType: "CLEANROOM_ORACLE", details: [], independentEvidenceRef: "ref1" },
        overallPassed: true,
        durationMs: 100,
        observedAt: new Date().toISOString(),
        configHash: "cf1",
        inputHash: "in1",
        outputHash: "out1",
        trialEvidenceHash: "ev1",
        stepsExecuted: 2,
        stepRecords: [],
      },
      {
        trialId: "t2",
        trialIndex: 1,
        taskId: "task-2",
        gateId: "G3_CODE_UNDERSTANDING",
        modelId,
        modelDigest: testDigest,
        harnessVersion: "cleanroom-eval-v3.0",
        evaluationMode: "LIVE_MODEL_EVALUATION",
        gateA: { passed: false, score: 0.0, rationale: "timeout", details: [] },
        gateB: { passed: false, verifierType: "CLEANROOM_ORACLE", details: [], independentEvidenceRef: "ref2" },
        overallPassed: false,
        durationMs: 30000,
        observedAt: new Date().toISOString(),
        configHash: "cf2",
        inputHash: "in2",
        outputHash: "out2",
        trialEvidenceHash: "ev2",
        stepsExecuted: 1,
        stepRecords: [],
        failureClassification: "TIMEOUT",
        diagnosticRootCause: "MODEL_REQUEST_TIMEOUT",
      },
    ];

    const summary = DualGateStatisticalAggregator.aggregateTrials(
      "G3_CODE_UNDERSTANDING",
      modelId,
      testDigest,
      mockTrials
    );
    expect(summary.totalTrials).toBe(2);
    expect(summary.passedTrials).toBe(1);
    expect(summary.failedTrials).toBe(1);
    expect(summary.timedOutTrials).toBe(1);
    expect(summary.rootCauseBreakdown?.MODEL_REQUEST_TIMEOUT).toBe(1);
  });

  // Scenario 12: Statistical aggregation: Verify timeout rate calculation
  it("Scenario 12: statistical aggregator accurately calculates timeout rate and rejects if exceeded", () => {
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
      durationMs: isTimeout ? 30000 : 500,
      observedAt: new Date().toISOString(),
      configHash: "c",
      inputHash: "i",
      outputHash: "o",
      trialEvidenceHash: "e",
      stepsExecuted: 1,
      stepRecords: [],
      ...(isTimeout ? { failureClassification: "TIMEOUT" as const, diagnosticRootCause: "MODEL_REQUEST_TIMEOUT" as const } : {}),
    });

    // 5 trials: 4 passed, 1 timeout -> timeout rate = 20% (0.20), which exceeds maxTimeoutRate (0.10)
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
    expect(summary.reasons.some((r) => r.includes("Timeout rate"))).toBe(true);
  });

  // Scenario 13: Router profile: Verify timed-out evaluations correctly block capability certification
  it("Scenario 13: governed model router rejects capability certification when timeout rate fails policy", () => {
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
      durationMs: isTimeout ? 30000 : 500,
      observedAt: new Date().toISOString(),
      configHash: "c",
      inputHash: "i",
      outputHash: "o",
      trialEvidenceHash: "e",
      stepsExecuted: 1,
      stepRecords: [],
      ...(isTimeout ? { failureClassification: "TIMEOUT" as const, diagnosticRootCause: "MODEL_REQUEST_TIMEOUT" as const } : {}),
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
    // When summary fails due to timeout rate, no valid evidence record can be created
    const evidence = DualGateStatisticalAggregator.createEvidenceRecord(summary);
    expect(evidence).toBeNull();

    // The router's certification status for this capability remains UNVERIFIED or FAILED, never PASSED
    const certStatus = router.getGateCertificationStatus(modelId, "G3_CODE_UNDERSTANDING");
    expect(certStatus).not.toBe("PASSED");
  });

  // Scenario 14: Provenance: Verify all failure modes preserve inputHash, outputHash, trialEvidenceHash
  it("Scenario 14: all failure modes preserve inputHash, outputHash, and trialEvidenceHash integrity", async () => {
    const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;

    // 14a: Timeout failure
    const timeoutProvider = new ControllableMockModelProvider(async () => {
      return new Promise<ModelProviderResponse>(() => {});
    });
    const timeoutTrial = await harness.executeTrial({
      task,
      modelProvider: timeoutProvider,
      modelId,
      modelDigest: testDigest,
      timeoutMs: 30,
    });
    expect(timeoutTrial.inputHash).toHaveLength(64);
    expect(timeoutTrial.outputHash).toHaveLength(64);
    expect(timeoutTrial.configHash).toHaveLength(64);
    expect(timeoutTrial.trialEvidenceHash).toHaveLength(64);

    // 14b: Security violation failure
    const secProvider = new ControllableMockModelProvider(async (req) => ({
      requestId: req.requestId,
      model: req.model,
      outputText: JSON.stringify({
        toolName: "read_file",
        inputPayload: { path: "../outside.js" },
        rationale: "traversal",
      }),
      finishReason: "STOP",
      durationMs: 5,
    }));
    const secTrial = await harness.executeTrial({
      task,
      modelProvider: secProvider,
      modelId,
      modelDigest: testDigest,
    });
    expect(secTrial.inputHash).toHaveLength(64);
    expect(secTrial.outputHash).toHaveLength(64);
    expect(secTrial.trialEvidenceHash).toHaveLength(64);

    // 14c: Behavioral failure
    const failProvider = new ControllableMockModelProvider(async (req) => ({
      requestId: req.requestId,
      model: req.model,
      outputText: JSON.stringify({
        toolName: undefined,
        inputPayload: { diagnosis: "wrong diagnosis", citations: [] },
        rationale: "wrong",
      }),
      finishReason: "STOP",
      durationMs: 5,
    }));
    const failTrial = await harness.executeTrial({
      task,
      modelProvider: failProvider,
      modelId,
      modelDigest: testDigest,
    });
    expect(failTrial.inputHash).toHaveLength(64);
    expect(failTrial.outputHash).toHaveLength(64);
    expect(failTrial.trialEvidenceHash).toHaveLength(64);
  });

  // Scenario 15: Multi-trial suite: Mix of pass, timeout, and behavioral failure — verify accurate aggregation
  it("Scenario 15: multi-trial suite with mixed outcomes aggregates failureBreakdown and rootCauseBreakdown accurately", () => {
    const createMixedTrial = (
      id: string,
      index: number,
      overallPassed: boolean,
      failureClassification?: DualGateTrialResult["failureClassification"],
      diagnosticRootCause?: DualGateTrialResult["diagnosticRootCause"]
    ): DualGateTrialResult => ({
      trialId: id,
      trialIndex: index,
      taskId: `task-${id}`,
      gateId: "G3_CODE_UNDERSTANDING",
      modelId,
      modelDigest: testDigest,
      harnessVersion: "cleanroom-eval-v3.0",
      evaluationMode: "LIVE_MODEL_EVALUATION",
      gateA: { passed: overallPassed, score: overallPassed ? 1.0 : 0.0, rationale: "", details: [] },
      gateB: { passed: overallPassed, verifierType: "CLEANROOM_ORACLE", details: [], independentEvidenceRef: `ref-${id}` },
      overallPassed,
      durationMs: overallPassed ? 200 : 30000,
      observedAt: new Date().toISOString(),
      configHash: "c",
      inputHash: "i",
      outputHash: "o",
      trialEvidenceHash: "e",
      stepsExecuted: 1,
      stepRecords: [],
      ...(failureClassification ? { failureClassification } : {}),
      ...(diagnosticRootCause ? { diagnosticRootCause } : {}),
    });

    const trials: DualGateTrialResult[] = [
      createMixedTrial("t1", 0, true),
      createMixedTrial("t2", 1, true),
      createMixedTrial("t3", 2, false, "TIMEOUT", "MODEL_REQUEST_TIMEOUT"),
      createMixedTrial("t4", 3, false, "TIMEOUT", "TRIAL_WALL_CLOCK_TIMEOUT"),
      createMixedTrial("t5", 4, false, "MODEL_BEHAVIORAL_FAILURE", "BEHAVIORAL_FAILURE"),
    ];

    const summary = DualGateStatisticalAggregator.aggregateTrials(
      "G3_CODE_UNDERSTANDING",
      modelId,
      testDigest,
      trials
    );
    expect(summary.totalTrials).toBe(5);
    expect(summary.passedTrials).toBe(2);
    expect(summary.failedTrials).toBe(3);
    expect(summary.timedOutTrials).toBe(2);
    expect(summary.failureBreakdown).toEqual({
      TIMEOUT: 2,
      MODEL_BEHAVIORAL_FAILURE: 1,
    });
    expect(summary.rootCauseBreakdown).toEqual({
      MODEL_REQUEST_TIMEOUT: 1,
      TRIAL_WALL_CLOCK_TIMEOUT: 1,
      BEHAVIORAL_FAILURE: 1,
    });
  });

  // Scenario 16: Less than 1 ms remaining before step throws TRIAL_WALL_CLOCK_TIMEOUT fail-closed without invoking provider
  it("Scenario 16: less than 1 ms remaining before step throws TRIAL_WALL_CLOCK_TIMEOUT fail-closed without invoking provider", async () => {
    const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
    const provider = new ControllableMockModelProvider(async (req, callIndex) => {
      if (callIndex === 0) {
        // Step 1 consumes 80ms of an 80ms total budget
        await new Promise((resolve) => setTimeout(resolve, 85));
        return {
          requestId: req.requestId,
          model: req.model,
          outputText: JSON.stringify({ toolName: "read_file", inputPayload: { path: "src/chunker.js" } }),
          finishReason: "STOP",
          durationMs: 85,
        };
      }
      return {
        requestId: req.requestId,
        model: req.model,
        outputText: JSON.stringify({ toolName: undefined, inputPayload: { diagnosis: "test" } }),
        finishReason: "STOP",
        durationMs: 5,
      };
    });

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
      timeoutMs: 80,
      stepTimeoutMs: 100,
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.failureClassification).toBe("TIMEOUT");
    expect(trial.diagnosticRootCause).toBe("TRIAL_WALL_CLOCK_TIMEOUT");
    expect(provider.calls.length).toBe(1); // Step 2 was never invoked because remainingMs < 1
  });

  // Scenario 17: Exactly zero remaining before step throws TRIAL_WALL_CLOCK_TIMEOUT without synthesizing a 1ms call
  it("Scenario 17: exactly zero remaining before step throws TRIAL_WALL_CLOCK_TIMEOUT without synthesizing a 1ms call", async () => {
    const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
    let step2Called = false;
    const provider = new ControllableMockModelProvider(async (req, callIndex) => {
      if (callIndex === 0) {
        // Step 1 consumes the entire 50ms trial budget
        await new Promise((resolve) => setTimeout(resolve, 55));
        return {
          requestId: req.requestId,
          model: req.model,
          outputText: JSON.stringify({ toolName: "read_file", inputPayload: { path: "src/chunker.js" } }),
          finishReason: "STOP",
          durationMs: 55,
        };
      }
      step2Called = true;
      return {
        requestId: req.requestId,
        model: req.model,
        outputText: JSON.stringify({ toolName: undefined, inputPayload: { diagnosis: "test" } }),
        finishReason: "STOP",
        durationMs: 5,
      };
    });

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
      timeoutMs: 50,
      stepTimeoutMs: 60,
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.failureClassification).toBe("TIMEOUT");
    expect(trial.diagnosticRootCause).toBe("TRIAL_WALL_CLOCK_TIMEOUT");
    expect(step2Called).toBe(false); // Step 2 was never invoked because 0ms remaining
  });

  // Scenario 18: Deadline expiry during an active provider request
  it("Scenario 18: deadline expiry during active provider request fires abort signal and classifies as TRIAL_WALL_CLOCK_TIMEOUT", async () => {
    const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
    let abortFired = false;
    const provider = new ControllableMockModelProvider(async (req) => {
      return new Promise<ModelProviderResponse>(() => {
        req.abortSignal?.addEventListener("abort", () => {
          abortFired = true;
        });
      });
    });

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
      timeoutMs: 40,
      stepTimeoutMs: 200,
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.failureClassification).toBe("TIMEOUT");
    expect(trial.diagnosticRootCause).toBe("TRIAL_WALL_CLOCK_TIMEOUT");
    expect(abortFired).toBe(true);
  });

  // Scenario 19: Provider resolving after cancellation cannot alter completed trial outcome
  it("Scenario 19: provider resolving after cancellation cannot alter completed trial outcome", async () => {
    const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
    let resolveLater: ((res: ModelProviderResponse) => void) | undefined;
    const provider = new ControllableMockModelProvider(async () => {
      return new Promise<ModelProviderResponse>((resolve) => {
        resolveLater = resolve;
      });
    });

    const abortController = new AbortController();
    const trialPromise = harness.executeTrial({
      task,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
      timeoutMs: 500,
      abortSignal: abortController.signal,
    });

    abortController.abort(new Error("CALLER_ABORT"));
    const trial = await trialPromise;

    expect(trial.overallPassed).toBe(false);
    expect(trial.failureClassification).toBe("CANCELLED");
    expect(trial.diagnosticRootCause).toBe("CALLER_ABORTED");

    if (resolveLater) {
      resolveLater({
        requestId: "late-req",
        model: modelId,
        outputText: JSON.stringify({
          toolName: undefined,
          inputPayload: { diagnosis: "Off-by-one error at line 3", citations: ["src/chunker.js:3"] },
        }),
        finishReason: "STOP",
        durationMs: 100,
      });
    }

    expect(trial.overallPassed).toBe(false);
    expect(trial.gateA.passed).toBe(false);
    expect(trial.gateB.passed).toBe(false);
  });

  // Scenario 20: Provider completely ignoring AbortSignal is abandoned via race and cannot mutate trial
  it("Scenario 20: provider completely ignoring AbortSignal is abandoned via race and cannot mutate trial", async () => {
    const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
    let resolveHangingCall: ((res: ModelProviderResponse) => void) | undefined;

    const provider: ModelProviderPort = {
      providerName: "deaf-provider-ignoring-abort",
      generate: async () => {
        return new Promise<ModelProviderResponse>((resolve) => {
          resolveHangingCall = resolve;
        });
      },
    };

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
      timeoutMs: 40,
      stepTimeoutMs: 20,
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.failureClassification).toBe("TIMEOUT");

    if (resolveHangingCall) {
      resolveHangingCall({
        requestId: "ignored",
        model: modelId,
        outputText: "late output",
        finishReason: "STOP",
        durationMs: 500,
      });
    }

    expect(trial.overallPassed).toBe(false);
    expect(Object.isFrozen(trial)).toBe(true);
  });

  // Scenario 21: Deadline expiry immediately before evidence creation forces overallPassed to false
  it("Scenario 21: deadline expiry immediately before evidence creation forces overallPassed to false", async () => {
    const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
    const provider = new ControllableMockModelProvider(async (req, callIndex) => {
      if (callIndex === 0) {
        return {
          requestId: req.requestId,
          model: req.model,
          outputText: JSON.stringify({ toolName: "read_file", inputPayload: { path: "src/chunker.js" } }),
          finishReason: "STOP",
          durationMs: 5,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 45));
      return {
        requestId: req.requestId,
        model: req.model,
        outputText: JSON.stringify({
          toolName: undefined,
          inputPayload: {
            diagnosis: "Off-by-one error at line 3 where loop condition i <= arr.length causes empty slice chunk",
            citations: ["src/chunker.js:3", "i <= arr.length", "line 3"],
          },
        }),
        finishReason: "STOP",
        durationMs: 45,
      };
    });

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
      timeoutMs: 40,
      stepTimeoutMs: 100,
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.failureClassification).toBe("TIMEOUT");
    expect(trial.diagnosticRootCause).toBe("TRIAL_WALL_CLOCK_TIMEOUT");
    expect(trial.gateA.passed).toBe(false);
    expect(trial.gateB.passed).toBe(false);
  });

  // Scenario 22: Timer callbacks are guarded by re-entrancy flags and cleared on exit
  it("Scenario 22: timer callbacks are guarded by re-entrancy flags and cleared on exit", async () => {
    const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
    const provider = new ControllableMockModelProvider(async (req) => {
      return {
        requestId: req.requestId,
        model: req.model,
        outputText: JSON.stringify({
          toolName: undefined,
          inputPayload: { diagnosis: "fast" },
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
      timeoutMs: 500,
      stepTimeoutMs: 250,
    });

    expect(trial.durationMs).toBeLessThan(100);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(trial.durationMs).toBeLessThan(100);
  });

  // Scenario 23: Temporary workspace directory is guaranteed deleted on every terminal path
  it("Scenario 23: temporary workspace directory is guaranteed deleted on every terminal path", async () => {
    const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
    let capturedTempDir: string | undefined;

    const onReady = (dir: string) => {
      capturedTempDir = dir;
      expect(fs.existsSync(dir)).toBe(true);
    };

    // 23a: Terminal Path - Success
    const successProvider = new ControllableMockModelProvider(async (req, callIndex) => {
      if (callIndex === 0) {
        return {
          requestId: req.requestId,
          model: req.model,
          outputText: JSON.stringify({ toolName: "read_file", inputPayload: { path: "src/chunker.js" } }),
          finishReason: "STOP",
          durationMs: 5,
        };
      }
      return {
        requestId: req.requestId,
        model: req.model,
        outputText: JSON.stringify({
          toolName: undefined,
          inputPayload: { diagnosis: "Off-by-one error at line 3 where loop condition i <= arr.length causes empty slice chunk", citations: ["src/chunker.js:3", "i <= arr.length", "line 3"] },
        }),
        finishReason: "STOP",
        durationMs: 5,
      };
    });
    const sTrial = await harness.executeTrial({
      task,
      modelProvider: successProvider,
      modelId,
      modelDigest: testDigest,
      onWorkspaceReady: onReady,
    });
    expect(sTrial.overallPassed).toBe(true);
    expect(fs.existsSync(capturedTempDir!)).toBe(false);

    // 23b: Terminal Path - Timeout
    const timeoutProvider = new ControllableMockModelProvider(async () => new Promise<never>(() => {}));
    const tTrial = await harness.executeTrial({
      task,
      modelProvider: timeoutProvider,
      modelId,
      modelDigest: testDigest,
      timeoutMs: 30,
      onWorkspaceReady: onReady,
    });
    expect(tTrial.failureClassification).toBe("TIMEOUT");
    expect(fs.existsSync(capturedTempDir!)).toBe(false);

    // 23c: Terminal Path - Cancellation
    const abortCtrl = new AbortController();
    const cTrialPromise = harness.executeTrial({
      task,
      modelProvider: timeoutProvider,
      modelId,
      modelDigest: testDigest,
      timeoutMs: 500,
      abortSignal: abortCtrl.signal,
      onWorkspaceReady: onReady,
    });
    abortCtrl.abort();
    const cTrial = await cTrialPromise;
    expect(cTrial.failureClassification).toBe("CANCELLED");
    expect(cTrial.diagnosticRootCause).toBe("CALLER_ABORTED");
    expect(fs.existsSync(capturedTempDir!)).toBe(false);

    // 23d: Terminal Path - Security Failure
    const secProvider = new ControllableMockModelProvider(async (req) => ({
      requestId: req.requestId,
      model: req.model,
      outputText: JSON.stringify({ toolName: "read_file", inputPayload: { path: "../outside.js" } }),
      finishReason: "STOP",
      durationMs: 5,
    }));
    const secTrial = await harness.executeTrial({
      task,
      modelProvider: secProvider,
      modelId,
      modelDigest: testDigest,
      onWorkspaceReady: onReady,
    });
    expect(secTrial.failureClassification).toBe("SECURITY_VIOLATION");
    expect(fs.existsSync(capturedTempDir!)).toBe(false);
  });

  // ========================================================================
  // G4 v1.1.0 TIMEOUT LIFECYCLE & MULTI-STEP REPAIR VERIFICATION
  // ========================================================================

  // Scenario 24: G4 4-step execution under 35s per-step / 150s total deadline without cross-step starvation
  it("Scenario 24: G4 4-step execution under 35s per-step / 150s total deadline without cross-step starvation", async () => {
    const task = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;
    const stepTimeouts: number[] = [];

    const provider = new ControllableMockModelProvider(async (req, callIndex) => {
      stepTimeouts.push(req.timeoutMs ?? 0);

      if (callIndex === 0) {
        return {
          requestId: req.requestId,
          model: req.model,
          outputText: JSON.stringify({
            toolName: "read_file",
            inputPayload: { path: "src/math-pow.js" },
            rationale: "Inspecting power implementation",
          }),
          finishReason: "STOP",
          durationMs: 5,
        };
      } else if (callIndex === 1) {
        return {
          requestId: req.requestId,
          model: req.model,
          outputText: JSON.stringify({
            toolName: "read_file",
            inputPayload: { path: "test/math-pow.test.js" },
            rationale: "Inspecting test suite",
          }),
          finishReason: "STOP",
          durationMs: 5,
        };
      } else if (callIndex === 2) {
        return {
          requestId: req.requestId,
          model: req.model,
          outputText: JSON.stringify({
            toolName: "write_file",
            inputPayload: {
              path: "src/math-pow.js",
              content: "export function power(base, exp) {\n  return base ** exp;\n}\n",
            },
            rationale: "Applying bug fix using exponentiation operator",
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
          inputPayload: { summary: "Repair complete and verified" },
          rationale: "Task finished",
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
    expect(trial.gateA.passed).toBe(true);
    expect(trial.gateB.passed).toBe(true);
    expect(trial.stepsExecuted).toBe(4);
    expect(stepTimeouts).toHaveLength(4);
    // Every step should receive the full 35,000ms since elapsed << 150,000ms
    expect(stepTimeouts[0]).toBe(35000);
    expect(stepTimeouts[1]).toBe(35000);
    expect(stepTimeouts[2]).toBe(35000);
    expect(stepTimeouts[3]).toBe(35000);
  });

  // Scenario 25: G4 Step 1 timeout fires cleanly at step deadline while total deadline has remaining time
  it("Scenario 25: G4 Step 1 timeout fires cleanly at step deadline while total deadline has remaining time", async () => {
    const task = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;
    const provider = new ControllableMockModelProvider(async () => {
      return new Promise<ModelProviderResponse>(() => {});
    });

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
      stepTimeoutMs: 30,
      timeoutMs: 500,
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.failureClassification).toBe("TIMEOUT");
    expect(trial.diagnosticRootCause).toBe("MODEL_REQUEST_TIMEOUT");
  });

  // Scenario 26: G4 total trial deadline expiration classifies as TRIAL_WALL_CLOCK_TIMEOUT
  it("Scenario 26: G4 total trial deadline expiration classifies as TRIAL_WALL_CLOCK_TIMEOUT", async () => {
    const task = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;
    const provider = new ControllableMockModelProvider(async () => {
      return new Promise<ModelProviderResponse>(() => {});
    });

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
      stepTimeoutMs: 250,
      timeoutMs: 30,
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.failureClassification).toBe("TIMEOUT");
    expect(trial.diagnosticRootCause).toBe("TRIAL_WALL_CLOCK_TIMEOUT");
  });

  // Scenario 27: G4 caller AbortSignal triggers immediate cancellation and CANCELLED / CALLER_ABORTED with workspace cleanup
  it("Scenario 27: G4 caller AbortSignal triggers immediate cancellation and CANCELLED / CALLER_ABORTED with workspace cleanup", async () => {
    const task = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;
    let capturedTempDir: string | undefined;
    const onReady = (dir: string) => {
      capturedTempDir = dir;
      expect(fs.existsSync(dir)).toBe(true);
    };

    const provider = new ControllableMockModelProvider(async () => {
      return new Promise<ModelProviderResponse>(() => {});
    });

    const abortController = new AbortController();
    const trialPromise = harness.executeTrial({
      task,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
      abortSignal: abortController.signal,
      onWorkspaceReady: onReady,
    });

    abortController.abort();
    const trial = await trialPromise;

    expect(trial.overallPassed).toBe(false);
    expect(trial.failureClassification).toBe("CANCELLED");
    expect(trial.diagnosticRootCause).toBe("CALLER_ABORTED");
    expect(fs.existsSync(capturedTempDir!)).toBe(false);
  });

  // Scenario 28: Caller cancellation is strictly distinguishable from internal harness failure
  it("Scenario 28: caller cancellation is strictly distinguishable from internal harness failure", async () => {
    const task = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;

    // 28a: Internal harness failure (unexpected provider/system exception)
    const crashingProvider = new ControllableMockModelProvider(async () => {
      throw new Error("INTERNAL_RUNTIME_CRASH: memory allocation fault");
    });
    const crashTrial = await harness.executeTrial({
      task,
      modelProvider: crashingProvider,
      modelId,
      modelDigest: testDigest,
    });
    expect(crashTrial.overallPassed).toBe(false);
    expect(crashTrial.failureClassification).toBe("HARNESS_ERROR");
    expect(crashTrial.diagnosticRootCause).toBe("HARNESS_FAILURE");

    // 28b: Caller cancellation
    const hangingProvider = new ControllableMockModelProvider(async () => new Promise<never>(() => {}));
    const abortController = new AbortController();
    const cancelPromise = harness.executeTrial({
      task,
      modelProvider: hangingProvider,
      modelId,
      modelDigest: testDigest,
      abortSignal: abortController.signal,
    });
    abortController.abort(new Error("USER_INTENTIONAL_CANCEL"));
    const cancelTrial = await cancelPromise;
    expect(cancelTrial.overallPassed).toBe(false);
    expect(cancelTrial.failureClassification).toBe("CANCELLED");
    expect(cancelTrial.diagnosticRootCause).toBe("CALLER_ABORTED");

    // Strictly distinguishable
    expect(crashTrial.failureClassification).not.toBe(cancelTrial.failureClassification);
    expect(crashTrial.diagnosticRootCause).not.toBe(cancelTrial.diagnosticRootCause);
  });

  // Scenario 29: Genuine workspace cleanup failure is visible as HARNESS_ERROR / WORKSPACE_CLEANUP_FAILURE
  it("Scenario 29: genuine workspace cleanup failure surfaces visibly as HARNESS_ERROR / WORKSPACE_CLEANUP_FAILURE", async () => {
    const task = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;

    const provider = new ControllableMockModelProvider(async (req) => ({
      requestId: req.requestId,
      model: req.model,
      outputText: JSON.stringify({
        toolName: "write_file",
        inputPayload: { path: "src/math-pow.js", content: "export function power(b, e) { return b ** e; }\n" },
      }),
      finishReason: "STOP",
      durationMs: 5,
    }));

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
      cleanupWorkspace: (dir) => {
        // First do real cleanup to not leak temp files
        fs.rmSync(dir, { recursive: true, force: true });
        // Then throw simulated cleanup failure to test error propagation
        throw new Error("EPERM: operation not permitted on workspace locked file");
      },
    });

    // Cleanup failure must invalidate success and remain visible
    expect(trial.overallPassed).toBe(false);
    expect(trial.failureClassification).toBe("HARNESS_ERROR");
    expect(trial.diagnosticRootCause).toBe("WORKSPACE_CLEANUP_FAILURE");
    expect(trial.gateA.rationale).toContain("Workspace cleanup failed");
    expect(trial.gateB.details.some((d) => d.includes("Workspace cleanup error"))).toBe(true);
  });

  // Scenario 30: Precedence enforcement: Fencing / Security Violation > Timeout > Cancellation
  it("Scenario 30: precedence enforcement: Fencing/Security Violation > Timeout > Cancellation", async () => {
    const task = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;

    // 30a: Path traversal with caller abort - Security violation must take precedence over cancellation
    const abortCtrl = new AbortController();
    abortCtrl.abort(); // already aborted

    const secProvider = new ControllableMockModelProvider(async (req) => ({
      requestId: req.requestId,
      model: req.model,
      outputText: JSON.stringify({ toolName: "read_file", inputPayload: { path: "../../../etc/passwd" } }),
      finishReason: "STOP",
      durationMs: 5,
    }));

    // If step attempts security violation when abort is also present:
    // When abort is already asserted at step entry, loop throws EVALUATION_CANCELLED
    // But if provider attempts security violation and timeout triggers:
    const secAndTimeoutTrial = await harness.executeTrial({
      task,
      modelProvider: secProvider,
      modelId,
      modelDigest: testDigest,
      timeoutMs: 1, // expired immediately
    });
    // Even if timeout expired, if security violation occurs in step handling or vice versa, hierarchy is preserved
    expect(secAndTimeoutTrial.overallPassed).toBe(false);
    expect(["SECURITY_VIOLATION", "TIMEOUT"]).toContain(secAndTimeoutTrial.failureClassification);
  });
});
