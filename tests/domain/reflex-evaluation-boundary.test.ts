import { describe, it, expect } from "vitest";
import {
  EVALUATION_EXECUTION_MODES,
  isValidEvaluationExecutionMode,
  assertExecutionModeSupported,
  createExperimentCondition,
  computeConditionHash,
  validateExperimentCondition,
  EvaluationExperimentConditionSchema,
  createEvaluationTask,
  createTaskReference,
  createEvaluationConfigFingerprint,
  assertControlledConditionComparability,
  ReflexNotImplementedError,
  CURRENT_HARNESS_VERSION,
  EvaluationTaskDefinition,
} from "../../src/domain/index.js";
import {
  executeEvaluationRun,
  executeEvaluationTrial,
} from "../../src/application/evaluation/evaluation-runner.js";
import {
  ModelProviderPort,
  ModelProviderRequest,
  ModelProviderResponse,
} from "../../src/ports/model-provider.port.js";

// ============================================================================
// Test Helpers & Mock Fixtures
// ============================================================================

class MockModelProvider implements ModelProviderPort {
  readonly providerName = "mock-provider";
  callCount = 0;

  async generate(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    this.callCount++;
    return {
      requestId: request.requestId,
      model: "mock-model",
      outputText: JSON.stringify({
        isGoalReached: true,
      }),
      finishReason: "STOP",
      durationMs: 50,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      },
    };
  }
}

function createSampleTask(overrides: Partial<Parameters<typeof createEvaluationTask>[0]> = {}): EvaluationTaskDefinition {
  return createEvaluationTask({
    taskId: "reflex-boundary-task",
    version: 1,
    description: "Evaluates condition boundary for baseline and reflex execution modes",
    fixture: {
      initialFiles: { "input.txt": "baseline content" },
    },
    mission: {
      requiredCapabilities: ["workspace.file.read"],
    },
    successCriteria: [
      {
        criterionId: "crit-1",
        kind: "FILE_EXISTS",
        path: "input.txt",
      },
    ],
    budget: {
      maxSteps: 5,
      maxActions: 5,
      maxWallClockMs: 5000,
    },
    ...overrides,
  });
}

function createSampleFingerprint(model = "qwen2.5-coder:7b") {
  return createEvaluationConfigFingerprint({
    modelProvider: "ollama",
    model,
    taskVersion: 1,
    harnessVersion: CURRENT_HARNESS_VERSION,
    generationConfig: { temperature: 0.2 },
  });
}

// ============================================================================
// Phase 7.6 — Reflex Evaluation Condition Boundary Tests
// ============================================================================

describe("Phase 7.6 — Reflex Evaluation Condition Boundary", () => {
  // --------------------------------------------------------------------------
  // Execution Mode (Items 1 - 5)
  // --------------------------------------------------------------------------
  describe("Execution Mode", () => {
    it("1. BASELINE accepted as a valid evaluation execution mode", () => {
      expect(isValidEvaluationExecutionMode("BASELINE")).toBe(true);
      expect(EVALUATION_EXECUTION_MODES).toContain("BASELINE");
    });

    it("2. REFLEX accepted as a valid evaluation execution mode", () => {
      expect(isValidEvaluationExecutionMode("REFLEX")).toBe(true);
      expect(EVALUATION_EXECUTION_MODES).toContain("REFLEX");
    });

    it("3. invalid mode rejected by validation and schema", () => {
      expect(isValidEvaluationExecutionMode("FAST")).toBe(false);
      expect(isValidEvaluationExecutionMode("TURBO")).toBe(false);
      expect(isValidEvaluationExecutionMode("ADAPTIVE")).toBe(false);
      expect(isValidEvaluationExecutionMode("")).toBe(false);
      expect(isValidEvaluationExecutionMode(null)).toBe(false);
      expect(isValidEvaluationExecutionMode(123)).toBe(false);

      expect(() => {
        validateExperimentCondition({
          conditionId: "cond-invalid",
          name: "Invalid Mode Condition",
          executionMode: "UNSUPPORTED_MODE",
          configFingerprint: createSampleFingerprint(),
          conditionHash: "a".repeat(64),
        });
      }).toThrow(/Malformed EvaluationExperimentCondition/);
    });

    it("4. mode serializes deterministically in condition and report structures", () => {
      const cond = createExperimentCondition({
        conditionId: "cond-reflex",
        name: "Reflex Condition",
        executionMode: "REFLEX",
        configFingerprint: createSampleFingerprint(),
      });

      const serialized = JSON.stringify(cond);
      const parsed = JSON.parse(serialized);
      expect(parsed.executionMode).toBe("REFLEX");

      // Verify deterministic JSON representation
      expect(JSON.stringify({ mode: cond.executionMode })).toBe('{"mode":"REFLEX"}');
    });

    it("5. mode participates in condition identity hash calculation", () => {
      const fp = createSampleFingerprint();
      const hashWithBaseline = computeConditionHash({
        conditionId: "cond-ident",
        configFingerprintHash: fp.fingerprintHash,
        executionMode: "BASELINE",
      });
      const hashWithReflex = computeConditionHash({
        conditionId: "cond-ident",
        configFingerprintHash: fp.fingerprintHash,
        executionMode: "REFLEX",
      });

      expect(hashWithBaseline).toMatch(/^[a-f0-9]{64}$/);
      expect(hashWithReflex).toMatch(/^[a-f0-9]{64}$/);
      expect(hashWithBaseline).not.toBe(hashWithReflex);
    });
  });

  // --------------------------------------------------------------------------
  // Condition Identity (Items 6 - 10)
  // --------------------------------------------------------------------------
  describe("Condition Identity", () => {
    it("6. baseline and Reflex conditions are distinct entities", () => {
      const fp = createSampleFingerprint();
      const baselineCond = createExperimentCondition({
        conditionId: "cond-base",
        name: "Baseline Execution",
        executionMode: "BASELINE",
        configFingerprint: fp,
      });

      const reflexCond = createExperimentCondition({
        conditionId: "cond-reflex",
        name: "Reflex Execution",
        executionMode: "REFLEX",
        configFingerprint: fp,
      });

      expect(baselineCond.executionMode).toBe("BASELINE");
      expect(reflexCond.executionMode).toBe("REFLEX");
      expect(baselineCond.conditionHash).not.toBe(reflexCond.conditionHash);
    });

    it("7. same task/config + different mode produces different condition identity", () => {
      const fp = createSampleFingerprint();
      const condA = createExperimentCondition({
        conditionId: "cond-test",
        name: "Test Condition",
        executionMode: "BASELINE",
        configFingerprint: fp,
      });

      const condB = createExperimentCondition({
        conditionId: "cond-test",
        name: "Test Condition",
        executionMode: "REFLEX",
        configFingerprint: fp,
      });

      // Same conditionId, same configFingerprint, but different executionMode
      expect(condA.conditionHash).not.toBe(condB.conditionHash);
    });

    it("8. identical semantic condition produces identical hash", () => {
      const fp = createSampleFingerprint();
      const hash1 = computeConditionHash({
        conditionId: "cond-semantic",
        configFingerprintHash: fp.fingerprintHash,
        executionMode: "REFLEX",
      });
      const hash2 = computeConditionHash({
        conditionId: "cond-semantic",
        configFingerprintHash: fp.fingerprintHash,
        executionMode: "REFLEX",
      });

      expect(hash1).toBe(hash2);
    });

    it("9. key ordering does not change identity", () => {
      const fp = createSampleFingerprint();
      // computeConditionHash uses computeCanonicalHash which recursively sorts object keys
      const hashA = computeConditionHash({
        conditionId: "cond-order",
        configFingerprintHash: fp.fingerprintHash,
        executionMode: "REFLEX",
      });
      const hashB = computeConditionHash({
        executionMode: "REFLEX",
        configFingerprintHash: fp.fingerprintHash,
        conditionId: "cond-order",
      });

      expect(hashA).toBe(hashB);
    });

    it("10. timestamps do not affect condition identity", () => {
      const fp = createSampleFingerprint();
      const beforeTime = Date.now();
      const hash1 = computeConditionHash({
        conditionId: "cond-pure",
        configFingerprintHash: fp.fingerprintHash,
        executionMode: "BASELINE",
      });
      const afterTime = Date.now() + 10000;
      const hash2 = computeConditionHash({
        conditionId: "cond-pure",
        configFingerprintHash: fp.fingerprintHash,
        executionMode: "BASELINE",
      });

      expect(beforeTime).toBeLessThanOrEqual(afterTime);
      expect(hash1).toBe(hash2);
    });
  });

  // --------------------------------------------------------------------------
  // Comparability (Items 11 - 16)
  // --------------------------------------------------------------------------
  describe("Comparability Fencing", () => {
    it("11. same task baseline/reflex accepted as comparable experimental conditions", () => {
      const task = createSampleTask();
      const taskRef = createTaskReference(task);
      const fp = createSampleFingerprint();

      const baselineCond = createExperimentCondition({
        conditionId: "cond-base",
        name: "Baseline Execution",
        executionMode: "BASELINE",
        configFingerprint: fp,
      });

      const reflexCond = createExperimentCondition({
        conditionId: "cond-reflex",
        name: "Reflex Execution",
        executionMode: "REFLEX",
        configFingerprint: fp,
      });

      const result = assertControlledConditionComparability({
        taskRef,
        baselineCondition: baselineCond,
        candidateCondition: reflexCond,
      });

      expect(result.comparable).toBe(true);
      expect(result.configurationCompatible).toBe(true);
      expect(result.intentionalDifferences).toContain("executionMode: BASELINE -> REFLEX");
    });

    it("12. task mismatch rejected by comparability assertion", () => {
      const task = createSampleTask();
      const taskRef = createTaskReference(task);
      const fp = createSampleFingerprint();

      const baselineCond = createExperimentCondition({
        conditionId: "cond-base",
        name: "Baseline",
        executionMode: "BASELINE",
        configFingerprint: fp,
      });
      const reflexCond = createExperimentCondition({
        conditionId: "cond-reflex",
        name: "Reflex",
        executionMode: "REFLEX",
        configFingerprint: fp,
      });

      expect(() => {
        assertControlledConditionComparability({
          taskRef,
          baselineCondition: baselineCond,
          candidateCondition: reflexCond,
          expectedTaskId: "different-task-id",
        });
      }).toThrow(/Task mismatch in controlled comparison/);
    });

    it("13. task version mismatch rejected by comparability assertion", () => {
      const task = createSampleTask();
      const taskRef = createTaskReference(task);
      const fp = createSampleFingerprint();

      const baselineCond = createExperimentCondition({
        conditionId: "cond-base",
        name: "Baseline",
        executionMode: "BASELINE",
        configFingerprint: fp,
      });
      const reflexCond = createExperimentCondition({
        conditionId: "cond-reflex",
        name: "Reflex",
        executionMode: "REFLEX",
        configFingerprint: fp,
      });

      expect(() => {
        assertControlledConditionComparability({
          taskRef,
          baselineCondition: baselineCond,
          candidateCondition: reflexCond,
          expectedTaskVersion: 2, // Task is version 1
        });
      }).toThrow(/Task version mismatch in controlled comparison/);
    });

    it("14. task hash mismatch rejected by comparability assertion", () => {
      const task = createSampleTask();
      const taskRef = createTaskReference(task);
      const fp = createSampleFingerprint();

      const baselineCond = createExperimentCondition({
        conditionId: "cond-base",
        name: "Baseline",
        executionMode: "BASELINE",
        configFingerprint: fp,
      });
      const reflexCond = createExperimentCondition({
        conditionId: "cond-reflex",
        name: "Reflex",
        executionMode: "REFLEX",
        configFingerprint: fp,
      });

      expect(() => {
        assertControlledConditionComparability({
          taskRef,
          baselineCondition: baselineCond,
          candidateCondition: reflexCond,
          expectedTaskContentHash: "0".repeat(64),
        });
      }).toThrow(/Task content hash mismatch in controlled comparison/);
    });

    it("15. incompatible configuration rejected by comparability assertion", () => {
      const task = createSampleTask();
      const taskRef = createTaskReference(task);

      const baselineFp = createSampleFingerprint("qwen2.5-coder:7b");
      const candidateFp = createSampleFingerprint("llama3.2:3b");

      const baselineCond = createExperimentCondition({
        conditionId: "cond-base",
        name: "Baseline Qwen",
        executionMode: "BASELINE",
        configFingerprint: baselineFp,
      });
      const candidateCond = createExperimentCondition({
        conditionId: "cond-reflex-llama",
        name: "Reflex Llama",
        executionMode: "REFLEX",
        configFingerprint: candidateFp,
      });

      expect(() => {
        assertControlledConditionComparability({
          taskRef,
          baselineCondition: baselineCond,
          candidateCondition: candidateCond,
          allowConfigDifferences: false,
        });
      }).toThrow(/Incompatible model in controlled comparison/);
    });

    it("16. execution mode is preserved as the intentional condition difference", () => {
      const task = createSampleTask();
      const taskRef = createTaskReference(task);
      const fp = createSampleFingerprint();

      const baselineCond = createExperimentCondition({
        conditionId: "cond-base",
        name: "Baseline",
        executionMode: "BASELINE",
        configFingerprint: fp,
      });
      const reflexCond = createExperimentCondition({
        conditionId: "cond-reflex",
        name: "Reflex",
        executionMode: "REFLEX",
        configFingerprint: fp,
      });

      const comparison = assertControlledConditionComparability({
        taskRef,
        baselineCondition: baselineCond,
        candidateCondition: reflexCond,
      });

      expect(comparison.intentionalDifferences).toEqual([
        "executionMode: BASELINE -> REFLEX",
      ]);
      expect(comparison.configurationCompatible).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Runner & Boundary Execution (Items 17 - 23)
  // --------------------------------------------------------------------------
  describe("Runner & Execution Boundary", () => {
    it("17. baseline executes through existing governed runtime", async () => {
      const task = createSampleTask();
      const provider = new MockModelProvider();

      const result = await executeEvaluationRun({
        task,
        modelProvider: provider,
        model: "mock-model",
        executionMode: "BASELINE",
      });

      expect(result.status).toBe("PASSED");
      expect(result.verificationPassed).toBe(true);
      expect(result.executionMode).toBe("BASELINE");
      expect(typeof result.runId).toBe("string");
      expect(result.runId.length).toBeGreaterThan(0);
    });

    it("18. Reflex condition does not silently fall back to baseline", async () => {
      const task = createSampleTask();
      const provider = new MockModelProvider();

      // Must reject rather than returning a result from baseline execution
      await expect(
        executeEvaluationRun({
          task,
          modelProvider: provider,
          model: "mock-model",
          executionMode: "REFLEX",
        })
      ).rejects.toThrow(ReflexNotImplementedError);
    });

    it("19. unimplemented Reflex condition fails explicitly with REFLEX_NOT_IMPLEMENTED", async () => {
      const task = createSampleTask();
      const provider = new MockModelProvider();

      try {
        await executeEvaluationRun({
          task,
          modelProvider: provider,
          model: "mock-model",
          executionMode: "REFLEX",
        });
        expect.unreachable("Expected executeEvaluationRun to throw ReflexNotImplementedError");
      } catch (err: any) {
        expect(err).toBeInstanceOf(ReflexNotImplementedError);
        expect(err.code).toBe("REFLEX_NOT_IMPLEMENTED");
        expect(err.message).toContain("REFLEX_NOT_IMPLEMENTED");
      }
    });

    it("20. no Runtime Run is created for a blocked unsupported Reflex condition during preflight", async () => {
      const task = createSampleTask();
      const provider = new MockModelProvider();

      // Test with executeEvaluationTrial
      await expect(
        executeEvaluationTrial({
          task,
          modelProvider: provider,
          model: "mock-model",
          trialOrdinal: 1,
          executionMode: "REFLEX",
        })
      ).rejects.toThrow(ReflexNotImplementedError);

      // Provider was never invoked because preflight rejected before execution
      expect(provider.callCount).toBe(0);
    });

    it("21. existing MissionContract remains authoritative in baseline execution", async () => {
      const task = createSampleTask();
      const provider = new MockModelProvider();

      const result = await executeEvaluationRun({
        task,
        modelProvider: provider,
        model: "mock-model",
        executionMode: "BASELINE",
      });

      // Verified under authoritative MissionContract
      expect(result.status).toBe("PASSED");
    });

    it("22. ProposalValidator remains authoritative in governed step loop", async () => {
      // Create a task requiring file.read, with maxProposalRejections ceiling of 1
      const task = createSampleTask({
        mission: { requiredCapabilities: ["workspace.file.read"] },
        budget: {
          maxSteps: 5,
          maxActions: 5,
          maxWallClockMs: 5000,
          maxProposalRejections: 1,
        },
      });

      class BadProposalProvider implements ModelProviderPort {
        readonly providerName = "bad-provider";
        async generate(request: ModelProviderRequest): Promise<ModelProviderResponse> {
          return {
            requestId: request.requestId,
            model: "bad-model",
            outputText: JSON.stringify({
              isGoalReached: false,
              proposalId: "bad-prop-1",
              toolName: "read_file",
              inputPayload: { path: "../../outside.txt" },
              rationale: "Attempting path traversal",
            }),
            finishReason: "STOP",
            durationMs: 50,
          };
        }
      }

      const result = await executeEvaluationRun({
        task,
        modelProvider: new BadProposalProvider(),
        model: "bad-model",
        executionMode: "BASELINE",
      });

      // Proposal was rejected by ProposalValidator (path traversal), resulting in BLOCKED
      expect(result.metrics.proposalRejections).toBeGreaterThan(0);
      expect(result.status).toBe("BLOCKED");
    });

    it("23. ToolExecutionGateway remains authoritative over all executions", async () => {
      const task = createSampleTask();
      const provider = new MockModelProvider();

      const result = await executeEvaluationRun({
        task,
        modelProvider: provider,
        model: "mock-model",
        executionMode: "BASELINE",
      });

      expect(result.evidenceReferences).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Security Boundaries (Items 24 - 28)
  // --------------------------------------------------------------------------
  describe("Security Boundaries", () => {
    it("24. mode cannot grant capabilities", () => {
      const task = createSampleTask();
      const cond = createExperimentCondition({
        conditionId: "cond-reflex",
        name: "Reflex",
        executionMode: "REFLEX",
        configFingerprint: createSampleFingerprint(),
      });

      // The condition itself has no capabilities property and cannot alter task mission
      expect((cond as any).requiredCapabilities).toBeUndefined();
      expect(task.mission.requiredCapabilities).toEqual(["workspace.file.read"]);
    });

    it("25. mode cannot modify MissionContract", () => {
      expect(() => {
        EvaluationExperimentConditionSchema.parse({
          conditionId: "cond-escalate",
          name: "Escalate",
          executionMode: "REFLEX",
          configFingerprint: createSampleFingerprint(),
          conditionHash: "a".repeat(64),
          missionContract: { allowedCapabilities: ["*"] },
        });
      }).toThrow(); // Zod strict mode rejects extra contract keys
    });

    it("26. mode cannot specify credentials", () => {
      expect(() => {
        createExperimentCondition({
          conditionId: "cond-api-key-secret",
          name: "Secret Condition",
          executionMode: "REFLEX",
          configFingerprint: createSampleFingerprint(),
        });
      }).toThrow(/sensitive keyword/);
    });

    it("27. mode cannot specify worker/lease identity", () => {
      expect(() => {
        createExperimentCondition({
          conditionId: "cond-workerId-override",
          name: "Worker Override",
          executionMode: "REFLEX",
          configFingerprint: createSampleFingerprint(),
        });
      }).toThrow(/forbidden authority keyword/);
    });

    it("28. mode cannot bypass workspace isolation", () => {
      expect(() => {
        EvaluationExperimentConditionSchema.parse({
          conditionId: "cond-host-escape",
          name: "Escape",
          executionMode: "REFLEX",
          configFingerprint: createSampleFingerprint(),
          conditionHash: "a".repeat(64),
          workspaceRoot: "C:\\Windows\\System32",
        });
      }).toThrow(); // Zod strict mode rejects unknown host path / isolation fields
    });
  });

  // --------------------------------------------------------------------------
  // Architectural Invariants (Items 29 - 33)
  // --------------------------------------------------------------------------
  describe("Architectural Invariants", () => {
    it("29. no direct tool invocation capability on condition or boundary objects", () => {
      const cond = createExperimentCondition({
        conditionId: "cond-pure-domain",
        name: "Pure Domain",
        executionMode: "REFLEX",
        configFingerprint: createSampleFingerprint(),
      });

      expect((cond as any).executeTool).toBeUndefined();
      expect((cond as any).runCommand).toBeUndefined();
      expect((cond as any).gateway).toBeUndefined();
    });

    it("30. no model-provider invocation added to condition or comparability checks", () => {
      const task = createSampleTask();
      const taskRef = createTaskReference(task);
      const fp = createSampleFingerprint();

      const condA = createExperimentCondition({
        conditionId: "cond-a",
        name: "A",
        executionMode: "BASELINE",
        configFingerprint: fp,
      });
      const condB = createExperimentCondition({
        conditionId: "cond-b",
        name: "B",
        executionMode: "REFLEX",
        configFingerprint: fp,
      });

      // Comparison is purely mathematical / logical; zero network or model requests
      const comparison = assertControlledConditionComparability({
        taskRef,
        baselineCondition: condA,
        candidateCondition: condB,
      });

      expect(comparison.comparable).toBe(true);
    });

    it("31. source experiment and condition definitions remain strictly immutable", () => {
      const cond = createExperimentCondition({
        conditionId: "cond-frozen",
        name: "Frozen Condition",
        executionMode: "REFLEX",
        configFingerprint: createSampleFingerprint(),
      });

      expect(Object.isFrozen(cond)).toBe(true);
      expect(() => {
        (cond as any).executionMode = "BASELINE";
      }).toThrow();
    });

    it("32. no metrics are artificially modified based on condition mode", async () => {
      const task = createSampleTask();
      const provider = new MockModelProvider();

      const result = await executeEvaluationRun({
        task,
        modelProvider: provider,
        model: "mock-model",
        executionMode: "BASELINE",
      });

      // Metrics reflect exact observed values, not scaled or synthetic metrics
      expect(result.metrics.modelCalls).toBe(provider.callCount);
      expect(result.metrics.inputTokens).toBe(100);
      expect(result.metrics.outputTokens).toBe(50);
      expect(result.metrics.totalTokens).toBe(150);
    });

    it("33. no synthetic Reflex improvement is produced", () => {
      // Direct call to assertExecutionModeSupported fails closed rather than fabricating improvements
      expect(() => assertExecutionModeSupported("REFLEX")).toThrow(ReflexNotImplementedError);
    });
  });
});
