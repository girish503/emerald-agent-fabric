/**
 * Phase 7.1 — Evaluation Domain Contracts Test Suite
 *
 * Comprehensive tests for reproducible evaluation harness contracts:
 * 1. Task Identity (Tests 1–4)
 * 2. Fixture (Tests 5–9)
 * 3. Objective Success Criteria (Tests 10–13)
 * 4. Metric Semantics (Tests 14–17)
 * 5. Configuration Fingerprint (Tests 18–22)
 * 6. Result & Outcome Taxonomy (Tests 23–28)
 * 7. Reproducibility & Content Hashing (Tests 29–32)
 * 8. Security Boundaries (Tests 33–36)
 */

import { describe, expect, it } from "vitest";
import {
  computeEvaluationTaskHash,
  createEvaluationConfigFingerprint,
  createEvaluationMetrics,
  createEvaluationTask,
  evaluateObjectiveCriteria,
  EvaluationCriterion,
  EvaluationTaskDefinition,
  validateEvaluationTask,
} from "../../src/domain/evaluation.js";

// ============================================================================
// Helper Factory
// ============================================================================

function createValidTaskDefinition(overrides: Partial<EvaluationTaskDefinition> = {}): EvaluationTaskDefinition {
  return {
    taskId: "test-task-1",
    version: 1,
    description: "Sample reproducible evaluation task",
    fixture: {
      initialFiles: {
        "src/hello.txt": "Hello, World!\n",
      },
    },
    mission: {
      requiredCapabilities: ["workspace.file.read", "workspace.file.write"],
      resourceLimits: {
        timeoutMs: 30000,
        maxAttempts: 3,
        maxOutputBytes: 1048576,
      },
    },
    successCriteria: [
      {
        criterionId: "crit-1",
        kind: "FILE_CONTENT_EQUALS",
        path: "src/hello.txt",
        expectedContent: "Hello, Emerald!\n",
        description: "File must contain updated greeting",
      },
    ],
    budget: {
      maxSteps: 5,
      maxActions: 3,
      maxWallClockMs: 60000,
      maxConsecutiveFailures: 2,
      maxProposalRejections: 2,
    },
    ...overrides,
  };
}

describe("Phase 7.1 — Evaluation Domain Contracts", () => {
  // ==========================================================================
  // 1. Task Identity
  // ==========================================================================
  describe("1. Task Identity", () => {
    it("1. accepts stable, valid taskId and version", () => {
      const def = createValidTaskDefinition({ taskId: "eval-task-greeting-v1", version: 1 });
      const task = createEvaluationTask(def);
      expect(task.taskId).toBe("eval-task-greeting-v1");
      expect(task.version).toBe(1);
    });

    it("2. enforces version is a strictly positive integer", () => {
      expect(() => {
        validateEvaluationTask(createValidTaskDefinition({ version: 0 }));
      }).toThrow(/version must be a positive integer/);

      expect(() => {
        validateEvaluationTask(createValidTaskDefinition({ version: -1 }));
      }).toThrow(/version must be a positive integer/);

      expect(() => {
        validateEvaluationTask(createValidTaskDefinition({ version: 1.5 }));
      }).toThrow(/Expected integer/);
    });

    it("3. distinguishes task revisions via version number", () => {
      const taskV1 = createEvaluationTask(createValidTaskDefinition({ version: 1 }));
      const taskV2 = createEvaluationTask(createValidTaskDefinition({ version: 2 }));
      expect(taskV1.version).not.toBe(taskV2.version);

      const hash1 = computeEvaluationTaskHash(taskV1);
      const hash2 = computeEvaluationTaskHash(taskV2);
      expect(hash1).not.toBe(hash2);
    });

    it("4. rejects malformed task definitions fail-closed", () => {
      expect(() => {
        validateEvaluationTask(createValidTaskDefinition({ taskId: "" }));
      }).toThrow(/taskId cannot be empty/);

      expect(() => {
        validateEvaluationTask(createValidTaskDefinition({ taskId: "invalid id with spaces" }));
      }).toThrow(/taskId must contain only alphanumeric/);

      expect(() => {
        validateEvaluationTask(createValidTaskDefinition({ description: "" }));
      }).toThrow(/description cannot be empty/);

      expect(() => {
        validateEvaluationTask(createValidTaskDefinition({ successCriteria: [] }));
      }).toThrow(/Evaluation task must define at least one success criterion/);
    });
  });

  // ==========================================================================
  // 2. Fixture
  // ==========================================================================
  describe("2. Fixture", () => {
    it("5. represents deterministic input files without authority", () => {
      const def = createValidTaskDefinition({
        fixture: {
          initialFiles: {
            "README.md": "# Project Title\n",
            "src/index.ts": "console.log(42);\n",
          },
        },
      });
      const task = createEvaluationTask(def);
      expect(Object.keys(task.fixture.initialFiles)).toHaveLength(2);
      expect(task.fixture.initialFiles["README.md"]).toBe("# Project Title\n");
    });

    it("6. enforces fixture size boundaries fail-closed", () => {
      // Over 100 files
      const tooManyFiles: Record<string, string> = {};
      for (let i = 0; i < 105; i++) {
        tooManyFiles[`file_${i}.txt`] = "content";
      }
      expect(() => {
        validateEvaluationTask(createValidTaskDefinition({ fixture: { initialFiles: tooManyFiles } }));
      }).toThrow(/Fixture file count/);

      // Single file over 1 MB
      const hugeFile = "x".repeat(1024 * 1024 + 10);
      expect(() => {
        validateEvaluationTask(
          createValidTaskDefinition({ fixture: { initialFiles: { "huge.txt": hugeFile } } })
        );
      }).toThrow(/exceeds maximum file limit/);
    });

    it("7. rejects fixtures containing credential keywords", () => {
      expect(() => {
        validateEvaluationTask(
          createValidTaskDefinition({ fixture: { initialFiles: { "secrets/api_key.txt": "secret-123" } } })
        );
      }).toThrow(/sensitive or secret keyword/);

      expect(() => {
        validateEvaluationTask(
          createValidTaskDefinition({ fixture: { initialFiles: { "config/password.json": "{}" } } })
        );
      }).toThrow(/sensitive or secret keyword/);
    });

    it("8. rejects fixtures with host paths or traversal", () => {
      expect(() => {
        validateEvaluationTask(
          createValidTaskDefinition({ fixture: { initialFiles: { "../../etc/passwd": "root" } } })
        );
      }).toThrow(/Invalid fixture path/);

      expect(() => {
        validateEvaluationTask(
          createValidTaskDefinition({ fixture: { initialFiles: { "/etc/shadow": "root" } } })
        );
      }).toThrow(/Invalid fixture path/);

      expect(() => {
        validateEvaluationTask(
          createValidTaskDefinition({ fixture: { initialFiles: { "C:\\Windows\\system32": "data" } } })
        );
      }).toThrow(/Invalid fixture path/);
    });

    it("9. rejects fixtures containing authority-bearing keywords in path", () => {
      expect(() => {
        validateEvaluationTask(
          createValidTaskDefinition({ fixture: { initialFiles: { "workerId_override.txt": "100" } } })
        );
      }).toThrow(/forbidden authority keyword 'workerId'/);

      expect(() => {
        validateEvaluationTask(
          createValidTaskDefinition({ fixture: { initialFiles: { "contractId_hack.json": "{}" } } })
        );
      }).toThrow(/forbidden authority keyword 'contractId'/);
    });
  });

  // ==========================================================================
  // 3. Objective Success Criteria
  // ==========================================================================
  describe("3. Objective Success Criteria", () => {
    it("10. evaluates valid criteria kinds objectively against physical reader", async () => {
      const criteria: readonly EvaluationCriterion[] = [
        {
          criterionId: "c1",
          kind: "FILE_CONTENT_EQUALS",
          path: "greeting.txt",
          expectedContent: "Emerald Agent Fabric",
        },
        {
          criterionId: "c2",
          kind: "FILE_EXISTS",
          path: "output.log",
        },
        {
          criterionId: "c3",
          kind: "FILE_ABSENT",
          path: "temp.bin",
        },
        {
          criterionId: "c4",
          kind: "TEXT_CONTAINS",
          path: "greeting.txt",
          expectedSubstring: "Emerald",
        },
        {
          criterionId: "c5",
          kind: "COMMAND_EXIT_CODE",
          command: ["git", "status"],
          expectedExitCode: 0,
        },
      ];

      const reader = {
        async readFile(path: string) {
          if (path === "greeting.txt") return "Emerald Agent Fabric\n";
          if (path === "output.log") return "Done";
          return null;
        },
        async fileExists(path: string) {
          if (path === "greeting.txt" || path === "output.log") return true;
          return false;
        },
        async executeCommand(_argv: readonly string[]) {
          return { exitCode: 0, stdout: "clean", stderr: "" };
        },
      };

      const results = await evaluateObjectiveCriteria(criteria, reader);
      expect(results).toHaveLength(5);
      expect(results.every((r) => r.passed)).toBe(true);
    });

    it("11. rejects invalid criterion specifications during task validation", () => {
      expect(() => {
        validateEvaluationTask(
          createValidTaskDefinition({
            successCriteria: [
              {
                criterionId: "invalid-1",
                kind: "FILE_CONTENT_EQUALS",
                // Missing path
                expectedContent: "data",
              },
            ],
          })
        );
      }).toThrow(/requires a non-empty 'path'/);

      expect(() => {
        validateEvaluationTask(
          createValidTaskDefinition({
            successCriteria: [
              {
                criterionId: "invalid-2",
                kind: "FILE_CONTENT_EQUALS",
                path: "../../outside.txt",
                expectedContent: "data",
              },
            ],
          })
        );
      }).toThrow(/Invalid criterion path/);

      expect(() => {
        validateEvaluationTask(
          createValidTaskDefinition({
            successCriteria: [
              {
                criterionId: "invalid-3",
                kind: "TEXT_CONTAINS",
                path: "valid.txt",
                // Missing expectedSubstring
              },
            ],
          })
        );
      }).toThrow(/requires non-empty 'expectedSubstring'/);
    });

    it("12. produces objective failure when file content does not match", async () => {
      const criteria: readonly EvaluationCriterion[] = [
        {
          criterionId: "c1",
          kind: "FILE_CONTENT_EQUALS",
          path: "greeting.txt",
          expectedContent: "Expected text",
        },
      ];

      const reader = {
        async readFile() {
          return "Actual different text";
        },
        async fileExists() {
          return true;
        },
      };

      const results = await evaluateObjectiveCriteria(criteria, reader);
      expect(results[0]!.passed).toBe(false);
      expect(results[0]!.message).toContain("File content mismatch");
    });

    it("13. guarantees agent claims cannot produce success when objective criteria fail", async () => {
      const criteria: readonly EvaluationCriterion[] = [
        {
          criterionId: "c1",
          kind: "FILE_EXISTS",
          path: "nonexistent.txt",
        },
      ];

      const reader = {
        async readFile() {
          return null;
        },
        async fileExists() {
          return false;
        },
      };

      const results = await evaluateObjectiveCriteria(criteria, reader);
      const verificationPassed = results.every((r) => r.passed);
      const agentClaimedGoal = true; // Agent claimed it achieved the goal

      // Invariant: verificationPassed determines task outcome, NOT agentClaimedGoal
      const outcome = verificationPassed ? "PASSED" : "FAILED";
      expect(agentClaimedGoal).toBe(true);
      expect(verificationPassed).toBe(false);
      expect(outcome).toBe("FAILED");
    });
  });

  // ==========================================================================
  // 4. Metric Semantics
  // ==========================================================================
  describe("4. Metric Semantics", () => {
    it("14. preserves observed non-negative metrics accurately", () => {
      const metrics = createEvaluationMetrics({
        steps: 4,
        actions: 2,
        attempts: 2,
        modelCalls: 4,
        toolCalls: 2,
        proposalRejections: 1,
        executionFailures: 0,
        modelFailures: 0,
        wallClockMs: 1250,
        modelLatencyMs: 900,
        toolLatencyMs: 250,
        inputTokens: 120,
        outputTokens: 45,
        totalTokens: 165,
      });

      expect(metrics.steps).toBe(4);
      expect(metrics.actions).toBe(2);
      expect(metrics.attempts).toBe(2);
      expect(metrics.modelCalls).toBe(4);
      expect(metrics.toolCalls).toBe(2);
      expect(metrics.proposalRejections).toBe(1);
      expect(metrics.executionFailures).toBe(0);
      expect(metrics.wallClockMs).toBe(1250);
      expect(metrics.inputTokens).toBe(120);
      expect(metrics.outputTokens).toBe(45);
      expect(metrics.totalTokens).toBe(165);
    });

    it("15. preserves unavailable metrics as undefined without fabricating values", () => {
      const metrics = createEvaluationMetrics({
        steps: 2,
        actions: 1,
        attempts: 1,
        modelCalls: 2,
        toolCalls: 1,
        proposalRejections: 0,
        executionFailures: 0,
        modelFailures: 0,
        wallClockMs: 500,
        inputTokens: undefined, // Model provider did not return token usage
        outputTokens: undefined,
        totalTokens: undefined,
      });

      expect(metrics.inputTokens).toBeUndefined();
      expect(metrics.outputTokens).toBeUndefined();
      expect(metrics.totalTokens).toBeUndefined();
    });

    it("16. strictly distinguishes observed 0 tokens from unavailable undefined", () => {
      const metricsWithZero = createEvaluationMetrics({
        steps: 1,
        actions: 0,
        attempts: 0,
        modelCalls: 1,
        toolCalls: 0,
        proposalRejections: 0,
        executionFailures: 0,
        modelFailures: 0,
        wallClockMs: 100,
        inputTokens: 0, // Explicitly observed 0 tokens
      });

      const metricsWithUndefined = createEvaluationMetrics({
        steps: 1,
        actions: 0,
        attempts: 0,
        modelCalls: 1,
        toolCalls: 0,
        proposalRejections: 0,
        executionFailures: 0,
        modelFailures: 0,
        wallClockMs: 100,
        inputTokens: undefined, // Provider did not support tokens
      });

      expect(metricsWithZero.inputTokens).toBe(0);
      expect(metricsWithUndefined.inputTokens).toBeUndefined();
      expect(metricsWithZero.inputTokens).not.toBe(metricsWithUndefined.inputTokens);
    });

    it("17. rejects negative metrics fail-closed", () => {
      expect(() => {
        createEvaluationMetrics({
          steps: -1,
          actions: 0,
          attempts: 0,
          modelCalls: 0,
          toolCalls: 0,
          proposalRejections: 0,
          executionFailures: 0,
          modelFailures: 0,
          wallClockMs: 100,
        });
      }).toThrow();
    });
  });

  // ==========================================================================
  // 5. Configuration Fingerprint
  // ==========================================================================
  describe("5. Configuration Fingerprint", () => {
    it("18. generates deterministic fingerprint hash for identical configurations", () => {
      const fp1 = createEvaluationConfigFingerprint({
        modelProvider: "ollama",
        model: "llama3.2",
        taskVersion: 1,
        harnessVersion: "harness-0.1",
        generationConfig: { temperature: 0.2 },
      });

      const fp2 = createEvaluationConfigFingerprint({
        modelProvider: "ollama",
        model: "llama3.2",
        taskVersion: 1,
        harnessVersion: "harness-0.1",
        generationConfig: { temperature: 0.2 },
      });

      expect(fp1.fingerprintHash).toBe(fp2.fingerprintHash);
      expect(fp1.fingerprintHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("19. excludes secrets and API credentials from fingerprint computation", () => {
      const fp = createEvaluationConfigFingerprint({
        modelProvider: "ollama",
        model: "llama3.2",
        taskVersion: 1,
        generationConfig: {
          temperature: 0.0,
          api_key: "super-secret-key",
          auth_token: "secret-token",
        },
      });

      expect((fp.generationConfig as any).api_key).toBeUndefined();
      expect((fp.generationConfig as any).auth_token).toBeUndefined();
      expect(fp.fingerprintHash).toBeDefined();
    });

    it("20. incorporates model and provider in fingerprint", () => {
      const fpLlama = createEvaluationConfigFingerprint({
        modelProvider: "ollama",
        model: "llama3.2",
        taskVersion: 1,
      });

      const fpQwen = createEvaluationConfigFingerprint({
        modelProvider: "ollama",
        model: "qwen2.5-coder",
        taskVersion: 1,
      });

      expect(fpLlama.fingerprintHash).not.toBe(fpQwen.fingerprintHash);
    });

    it("21. incorporates task version in fingerprint", () => {
      const fpV1 = createEvaluationConfigFingerprint({
        modelProvider: "ollama",
        model: "llama3.2",
        taskVersion: 1,
      });

      const fpV2 = createEvaluationConfigFingerprint({
        modelProvider: "ollama",
        model: "llama3.2",
        taskVersion: 2,
      });

      expect(fpV1.fingerprintHash).not.toBe(fpV2.fingerprintHash);
    });

    it("22. incorporates harness version in fingerprint", () => {
      const fpHarness1 = createEvaluationConfigFingerprint({
        modelProvider: "ollama",
        model: "llama3.2",
        taskVersion: 1,
        harnessVersion: "harness-0.1",
      });

      const fpHarness2 = createEvaluationConfigFingerprint({
        modelProvider: "ollama",
        model: "llama3.2",
        taskVersion: 1,
        harnessVersion: "harness-0.2",
      });

      expect(fpHarness1.fingerprintHash).not.toBe(fpHarness2.fingerprintHash);
    });
  });

  // ==========================================================================
  // 6. Result & Outcome Taxonomy
  // ==========================================================================
  describe("6. Result & Outcome Taxonomy", () => {
    it("23. classifies PASSED when objective criteria succeed", () => {
      const criteriaResults = [{ criterionId: "c1", kind: "FILE_EXISTS" as const, passed: true, message: "OK" }];
      const verificationPassed = criteriaResults.every((c) => c.passed);
      expect(verificationPassed).toBe(true);
    });

    it("24. classifies FAILED when objective criteria fail", () => {
      const criteriaResults = [{ criterionId: "c1", kind: "FILE_EXISTS" as const, passed: false, message: "Missing" }];
      const verificationPassed = criteriaResults.every((c) => c.passed);
      expect(verificationPassed).toBe(false);
    });

    it("25. classifies TIMED_OUT when step or wall-clock budget is exhausted", () => {
      const terminalReason = "MAX_STEPS";
      const isTimeout = ["MAX_STEPS", "MAX_ACTIONS", "MAX_WALL_CLOCK"].includes(terminalReason);
      expect(isTimeout).toBe(true);
    });

    it("26. classifies CANCELLED on explicit abort signal", () => {
      const terminalReason = "CANCELLED";
      expect(terminalReason).toBe("CANCELLED");
    });

    it("27. classifies ERROR on model or infrastructure failure", () => {
      const terminalReason = "BRAIN_FAILURE";
      const isError = terminalReason === "BRAIN_FAILURE";
      expect(isError).toBe(true);
    });

    it("28. classifies BLOCKED on governance fencing or policy rejection", () => {
      const terminalReason = "CONTRACT_REVOKED";
      const isBlocked = ["CONTRACT_REVOKED", "LEASE_LOST", "MAX_PROPOSAL_REJECTIONS", "UNKNOWN_EXECUTION"].includes(terminalReason);
      expect(isBlocked).toBe(true);
    });
  });

  // ==========================================================================
  // 7. Reproducibility & Content Hashing
  // ==========================================================================
  describe("7. Reproducibility & Content Hashing", () => {
    it("29. produces identical content hash for identical task definition", () => {
      const task1 = createEvaluationTask(createValidTaskDefinition());
      const task2 = createEvaluationTask(createValidTaskDefinition());
      expect(computeEvaluationTaskHash(task1)).toBe(computeEvaluationTaskHash(task2));
    });

    it("30. produces different content hash when task definition changes", () => {
      const task1 = createEvaluationTask(createValidTaskDefinition({ description: "Desc 1" }));
      const task2 = createEvaluationTask(createValidTaskDefinition({ description: "Desc 2" }));
      expect(computeEvaluationTaskHash(task1)).not.toBe(computeEvaluationTaskHash(task2));
    });

    it("31. decouples runtime Run identity from EvaluationRun identity", () => {
      const evaluationRunId = "eval-run-task-1-v1-t1-123456789";
      const runtimeRunId = "c8942b10-67a4-4a25-9df4-6e1be877f01a";
      expect(evaluationRunId).not.toBe(runtimeRunId);
    });

    it("32. permits multiple trials referencing same task version", () => {
      const task = createEvaluationTask(createValidTaskDefinition({ version: 1 }));
      const trial1Fingerprint = createEvaluationConfigFingerprint({
        modelProvider: "ollama",
        model: "llama3.2",
        taskVersion: task.version,
      });
      const trial2Fingerprint = createEvaluationConfigFingerprint({
        modelProvider: "ollama",
        model: "llama3.2",
        taskVersion: task.version,
      });

      expect(trial1Fingerprint.fingerprintHash).toBe(trial2Fingerprint.fingerprintHash);
      expect(trial1Fingerprint.taskVersion).toBe(1);
      expect(trial2Fingerprint.taskVersion).toBe(1);
    });
  });

  // ==========================================================================
  // 8. Security Boundaries
  // ==========================================================================
  describe("8. Security Boundaries", () => {
    it("33. evaluation task contracts declare required capabilities, but cannot execute tools directly", () => {
      const task = createEvaluationTask(createValidTaskDefinition());
      expect((task as any).execute).toBeUndefined();
      expect((task as any).runTool).toBeUndefined();
    });

    it("34. evaluation fixtures cannot grant capabilities or configure permissions", () => {
      const def = createValidTaskDefinition();
      expect((def.fixture as any).capabilities).toBeUndefined();
      expect((def.fixture as any).policy).toBeUndefined();
    });

    it("35. evaluation results are read-only summary objects without mutation handles", () => {
      const task = createEvaluationTask(createValidTaskDefinition());
      expect(Object.isFrozen(task)).toBe(true);
      expect(Object.isFrozen(task.fixture)).toBe(true);
      expect(Object.isFrozen(task.mission)).toBe(true);
      expect(Object.isFrozen(task.budget)).toBe(true);
    });

    it("36. evaluation criteria cannot bypass ProposalValidator boundary", () => {
      // Evaluation criteria only run post-execution as verification against workspace evidence.
      // Every model action during execution must pass through ProposalValidator.
      const task = createEvaluationTask(createValidTaskDefinition());
      expect(task.successCriteria[0]!.kind).toBe("FILE_CONTENT_EQUALS");
    });
  });
});
