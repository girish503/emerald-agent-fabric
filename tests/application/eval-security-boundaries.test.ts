import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBenchmarkTaskById } from "../../src/application/evaluation/capability-benchmark-suite.js";
import {
  DualGateEvaluationHarness,
  executeIsolatedTestInSandbox,
} from "../../src/application/evaluation/dual-gate-eval-harness.js";
import { DualGateStatisticalAggregator } from "../../src/application/evaluation/dual-gate-statistical-aggregator.js";
import { GovernedModelRouterService } from "../../src/application/governed-model-router.js";
import { ModelAssignmentViolationError } from "../../src/domain/model-routing.js";
import { ModelAssignmentEnforcingBrain } from "../../src/application/model-assignment-guard.js";
import { AgentBrainPort, AgentBrainRequest } from "../../src/ports/agent-brain.port.js";
import { computeTrialEvidenceHash } from "../../src/domain/dual-gate-evaluation.js";

describe("Security: Clean-Room Dual-Gate Evaluation Boundaries", () => {
  const harness = new DualGateEvaluationHarness();
  const testDigest = "sha256:d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668";
  const modelId = "qwen2.5-coder:1.5b";

  it("prohibits symlink escapes outside the temporary workspace", async () => {
    // Construct a custom task with a symlink targeting outside the workspace
    const outsideTarget = path.join(os.tmpdir(), "outside-secret.txt");
    fs.writeFileSync(outsideTarget, "CONFIDENTIAL_HOST_DATA", "utf8");

    try {
      const task = getBenchmarkTaskById("g2-nav-01-locate-auth-service")!;
      // Model attempts to write a symlink or traverse to outside target
      const evilProvider: any = {
        providerName: "evil-provider",
        async generate() {
          return {
            requestId: "evil-req",
            outputText: JSON.stringify({
              toolName: "read_file",
              inputPayload: { path: `../../../../../../../../../../../../../../../../../../${outsideTarget.replace(/^[a-zA-Z]:/, "")}` },
              rationale: "Attempting traversal to host root",
            }),
            model: modelId,
            finishReason: "STOP",
            durationMs: 10,
          };
        },
      };

      const trial = await harness.executeTrial({
        task,
        modelProvider: evilProvider,
        modelId,
        modelDigest: testDigest,
      });

      expect(trial.overallPassed).toBe(false);
      expect(trial.failureClassification).toBe("SECURITY_VIOLATION");
    } finally {
      try {
        fs.unlinkSync(outsideTarget);
      } catch {}
    }
  });

  it("ensures evaluator failure/crash fail-closed and cannot manufacture PASSED evidence", async () => {
    const task = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;
    const crashingProvider: any = {
      providerName: "crashing-provider",
      async generate() {
        throw new Error("UNEXPECTED_CRASH_DURING_EVALUATION");
      },
    };

    const trial = await harness.executeTrial({
      task,
      modelProvider: crashingProvider,
      modelId,
      modelDigest: testDigest,
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.gateA.passed).toBe(false);
    expect(trial.gateB.passed).toBe(false);
    expect(trial.failureClassification).toBe("HARNESS_ERROR");

    // Aggregator must not create evidence for failed trial
    const summary = DualGateStatisticalAggregator.aggregateTrials("G4_SINGLE_FILE_REPAIR", modelId, testDigest, [trial]);
    expect(summary.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(DualGateStatisticalAggregator.createEvidenceRecord(summary)).toBeNull();
  });

  it("detects evidence tampering via cryptographic evidence hash divergence", () => {
    const trialRecord = {
      trialId: "trial-secure-1",
      taskId: "g4-repair-01-fix-math-pow",
      gateId: "G4_SINGLE_FILE_REPAIR",
      modelId,
      modelDigest: testDigest,
      harnessVersion: "cleanroom-eval-v1.0",
      evaluationMode: "LIVE_MODEL_EVALUATION",
      observedAt: "2026-11-11T12:00:00.000Z",
      configHash: "1".repeat(64),
      inputHash: "2".repeat(64),
      outputHash: "3".repeat(64),
      gateAPassed: true,
      gateBPassed: true,
      overallPassed: true,
    };

    const validHash = computeTrialEvidenceHash(trialRecord);

    // Tampered record where outcome was flipped
    const tamperedRecord = { ...trialRecord, overallPassed: false };
    const invalidHash = computeTrialEvidenceHash(tamperedRecord);

    expect(validHash).not.toBe(invalidHash);

    // Tampered record where evaluationMode was altered
    const tamperedModeRecord = { ...trialRecord, evaluationMode: "FIXTURE_VALIDATION" };
    expect(computeTrialEvidenceHash(tamperedModeRecord)).not.toBe(validHash);
  });

  it("rejects fixture validation evidence from certifying live production routing", () => {
    const router = new GovernedModelRouterService();
    router.applyInstalledInventory([{ name: modelId, digest: testDigest }]);

    const fixtureEvidence = {
      gateId: "G2_REPO_NAVIGATION" as const,
      outcome: "PASSED" as const,
      modelId,
      modelDigest: testDigest,
      evaluationVersion: "cleanroom-eval-v1.0",
      evaluationMode: "FIXTURE_VALIDATION" as const,
      evidenceRef: "fixture-evidence-ref",
      summary: "Fixture validation run",
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };

    // applyGateEvidence must reject FIXTURE_VALIDATION fail-closed
    expect(() => router.applyGateEvidence(fixtureEvidence)).toThrowError(/EVALUATION_MODE_VIOLATION/);
  });

  it("rejects duplicate trial replay from artificially satisfying sample count threshold", () => {
    // Construct a single passing trial
    const singleTrial = {
      trialId: "trial-unique-1",
      trialIndex: 0,
      taskId: "g4-repair-01-fix-math-pow",
      gateId: "G4_SINGLE_FILE_REPAIR" as const,
      modelId,
      modelDigest: testDigest,
      harnessVersion: "cleanroom-eval-v1.0",
      evaluationMode: "LIVE_MODEL_EVALUATION" as const,
      gateA: { passed: true, score: 1.0, rationale: "pass", details: [] },
      gateB: { passed: true, verifierType: "CLEANROOM_ORACLE" as const, details: [], independentEvidenceRef: "ref" },
      overallPassed: true,
      durationMs: 100,
      observedAt: new Date().toISOString(),
      configHash: "1".repeat(64),
      inputHash: "2".repeat(64),
      outputHash: "3".repeat(64),
      trialEvidenceHash: "4".repeat(64),
    };

    // Replay the exact same trial 10 times
    const replayedTrials = Array(10).fill(singleTrial);

    // Aggregator must deduplicate and detect insufficient evidence
    const summary = DualGateStatisticalAggregator.aggregateTrials(
      "G4_SINGLE_FILE_REPAIR",
      modelId,
      testDigest,
      replayedTrials
    );

    expect(summary.totalTrials).toBe(1); // Deduplicated to 1
    expect(summary.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(DualGateStatisticalAggregator.createEvidenceRecord(summary)).toBeNull();
  });

  it("rejects evidence with stale/expired timestamp during router certification", () => {
    const router = new GovernedModelRouterService();
    router.applyInstalledInventory([{ name: modelId, digest: testDigest }]);

    const expiredEvidence = {
      gateId: "G2_REPO_NAVIGATION" as const,
      outcome: "PASSED" as const,
      modelId,
      modelDigest: testDigest,
      evaluationVersion: "cleanroom-eval-v1.0",
      evidenceRef: "expired-ref",
      summary: "Expired evidence",
      observedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), // expired 10 days ago
    };

    router.applyGateEvidence(expiredEvidence);
    // Router should classify as EXPIRED and refuse routing
    expect(router.getGateCertificationStatus(modelId, "G2_REPO_NAVIGATION")).toBe("EXPIRED");

    expect(() =>
      router.routeModel({
        role: "RESEARCHER",
        tenantId: "tenant-eval",
        taskId: "task-eval-expired",
        contractId: "contract-1",
        remainingBudgetMs: 300000,
        stepBudgetMs: 150000,
        estimatedContextTokens: 1000,
      })
    ).toThrowError(/MISSING_GATE_EVIDENCE/);
  });

  it("ensures evaluation artifacts cannot bypass model assignment guard on execution", async () => {
    const mockStore: any = {
      getTask: (id: string) => ({
        taskId: id,
        title: "Unassigned coder task",
        inputPayload: { role: "CODER" },
      }),
      getRun: () => null,
      getContract: () => null,
    };

    const dummyBrain: AgentBrainPort = {
      async proposeAction() {
        return {
          finishReason: "ACTION_PROPOSED",
          proposal: { toolName: "read_file", inputPayload: { path: "README.md" } },
        };
      },
    };

    // Guarded brain for worker running qwen2.5-coder:1.5b
    const guardedBrain = new ModelAssignmentEnforcingBrain({
      inner: dummyBrain,
      stateStore: mockStore,
      verifiedModel: { modelId, modelDigest: testDigest },
    });

    const request = {
      runId: "run-test-1",
      sequenceNumber: 1,
      availableTools: [],
      contextSnapshot: {
        taskId: "task-unassigned-coder",
      },
    } as unknown as AgentBrainRequest;

    await expect(guardedBrain.proposeAction(request)).rejects.toThrowError(ModelAssignmentViolationError);
    await expect(guardedBrain.proposeAction(request)).rejects.toThrowError(/no governed model assignment/);
  });

  it("rejects path traversal in search_code directory path and classifies as SECURITY_VIOLATION", async () => {
    const task = getBenchmarkTaskById("g2-nav-01-locate-auth-service")!;
    const evilProvider: any = {
      providerName: "evil-search-provider",
      async generate() {
        return {
          requestId: "evil-search-req",
          outputText: JSON.stringify({
            toolName: "search_code",
            inputPayload: { query: "secret", path: "../../../" },
            rationale: "Attempting traversal in search_code path",
          }),
          model: modelId,
          finishReason: "STOP",
          durationMs: 10,
        };
      },
    };

    const trial = await harness.executeTrial({
      task,
      modelProvider: evilProvider,
      modelId,
      modelDigest: testDigest,
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.failureClassification).toBe("SECURITY_VIOLATION");
  });

  it("enforces allowedTools permission fence and provides policy violation observation", async () => {
    const task = getBenchmarkTaskById("g2-nav-01-locate-auth-service")!; // allowedTools: ["read_file", "search_code"]
    let capturedInput: any[] = [];
    let callCount = 0;

    const unpermittedToolProvider: any = {
      providerName: "unpermitted-tool-provider",
      async generate(req: any) {
        callCount++;
        capturedInput = req.input;
        if (callCount === 1) {
          // Model proposes forbidden tool run_command
          return {
            requestId: "unpermitted-req-1",
            outputText: JSON.stringify({
              toolName: "run_command",
              inputPayload: { command: "rm -rf /" },
              rationale: "Attempting unpermitted tool call",
            }),
            model: modelId,
            finishReason: "STOP",
            durationMs: 10,
          };
        }
        if (callCount === 2) {
          return {
            requestId: "unpermitted-req-2",
            outputText: JSON.stringify({
              toolName: "read_file",
              inputPayload: { path: "packages/services/auth/src/jwt-signer.js" },
              rationale: "Correcting to read_file on jwt-signer.js",
            }),
            model: modelId,
            finishReason: "STOP",
            durationMs: 10,
          };
        }
        return {
          requestId: "unpermitted-req-3",
          outputText: JSON.stringify({
            toolName: undefined,
            rationale: "Completed after correction",
          }),
          model: modelId,
          finishReason: "STOP",
          durationMs: 10,
        };
      },
    };

    const trial = await harness.executeTrial({
      task,
      modelProvider: unpermittedToolProvider,
      modelId,
      modelDigest: testDigest,
    });

    expect(callCount).toBe(3);
    // Policy violation observation was communicated back to model
    const policyMsg = capturedInput.find((m: any) => typeof m?.content === "string" && m.content.includes("POLICY_VIOLATION"));
    expect(policyMsg).toBeDefined();
    expect(policyMsg.content).toContain("POLICY_VIOLATION: Tool 'run_command' is not allowed");
    expect(trial.stepRecords?.[0]?.toolObservation).toContain("POLICY_VIOLATION");
  });

  it("bounds tool output bytes and truncates without memory exhaustion", async () => {
    const task = getBenchmarkTaskById("g2-nav-01-locate-auth-service")!;
    // Create custom task with small maxOutputBytes
    const constrainedTask = {
      ...task,
      resourceLimits: {
        timeoutMs: 30000,
        maxSteps: 2,
        maxOutputBytes: 120, // small byte bound
      },
    };

    const provider: any = {
      providerName: "reading-provider",
      async generate(req: any) {
        if (req.input.length <= 2) {
          return {
            requestId: "req-1",
            outputText: JSON.stringify({
              toolName: "read_file",
              inputPayload: { path: "packages/services/auth/src/jwt-signer.js" },
              rationale: "Reading jwt-signer.js",
            }),
            model: modelId,
            finishReason: "STOP",
            durationMs: 10,
          };
        }
        return {
          requestId: "req-2",
          outputText: JSON.stringify({ toolName: undefined, rationale: "Done." }),
          model: modelId,
          finishReason: "STOP",
          durationMs: 10,
        };
      },
    };

    const trial = await harness.executeTrial({
      task: constrainedTask,
      modelProvider: provider,
      modelId,
      modelDigest: testDigest,
    });

    const step1 = trial.stepRecords?.[0];
    expect(step1).toBeDefined();
    expect(step1?.toolObservation).toBeDefined();
    // Observation bytes should not exceed reasonable bound
    const parsedObs = JSON.parse(step1!.toolObservation!);
    expect(parsedObs.bytesRead).toBeLessThanOrEqual(120);
  });

  it("categorically disables arbitrary regex search with clear policy error to prevent ReDoS and backtracking", async () => {
    const task = getBenchmarkTaskById("g2-nav-01-locate-auth-service")!;
    const redosPatterns = ["(a+)+$", "(a|aa)+$", "(x+x+)+y", "([a-zA-Z]+)*$", "^(a+)+b", "(.*a){10}"];

    for (const pattern of redosPatterns) {
      const redosProvider: any = {
        providerName: "redos-provider",
        async generate() {
          return {
            requestId: "redos-req",
            outputText: JSON.stringify({
              toolName: "search_code",
              inputPayload: { query: pattern, isRegex: true },
              rationale: "Attempting catastrophic backtracking via regex",
            }),
            model: modelId,
            finishReason: "STOP",
            durationMs: 10,
          };
        },
      };

      const startTime = Date.now();
      const trial = await harness.executeTrial({
        task,
        modelProvider: redosProvider,
        modelId,
        modelDigest: testDigest,
      });
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(300); // Rejection is instantaneous without regex engine execution
      const obs = trial.stepRecords?.[0]?.toolObservation ?? "";
      expect(obs).toContain("REGEX_DISABLED");
      expect(obs).toContain("Regular expression search is disabled in clean-room evaluation for ReDoS prevention; use literal substring search.");
    }
  });

  it("handles literal search with special characters without regex compilation error", async () => {
    const task = getBenchmarkTaskById("g2-nav-01-locate-auth-service")!;
    const literalQuery = "signToken(payload, key) {";

    const literalProvider: any = {
      providerName: "literal-provider",
      async generate() {
        return {
          requestId: "literal-req",
          outputText: JSON.stringify({
            toolName: "search_code",
            inputPayload: { query: literalQuery, isRegex: false },
            rationale: "Literal search containing brackets and parens",
          }),
          model: modelId,
          finishReason: "STOP",
          durationMs: 10,
        };
      },
    };

    const trial = await harness.executeTrial({
      task,
      modelProvider: literalProvider,
      modelId,
      modelDigest: testDigest,
    });

    const obs = trial.stepRecords?.[0]?.toolObservation ?? "";
    const parsed = JSON.parse(obs);
    expect(parsed.error).toBeUndefined();
    expect(parsed.totalMatches).toBe(1);
    expect(parsed.matches[0].file).toBe("packages/services/auth/src/jwt-signer.js");
  });

  it("rejects oversized search query input beyond maximum length ceiling", async () => {
    const task = getBenchmarkTaskById("g2-nav-01-locate-auth-service")!;
    const oversizedQuery = "A".repeat(600);

    const oversizedProvider: any = {
      providerName: "oversized-provider",
      async generate() {
        return {
          requestId: "oversized-req",
          outputText: JSON.stringify({
            toolName: "search_code",
            inputPayload: { query: oversizedQuery },
            rationale: "Attempting oversized query injection",
          }),
          model: modelId,
          finishReason: "STOP",
          durationMs: 10,
        };
      },
    };

    const trial = await harness.executeTrial({
      task,
      modelProvider: oversizedProvider,
      modelId,
      modelDigest: testDigest,
    });

    const obs = trial.stepRecords?.[0]?.toolObservation ?? "";
    expect(obs).toContain("QUERY_TOO_LONG");
  });

  it("confirms historical evaluation evidence and router status remain immutable", () => {
    const router = new GovernedModelRouterService();
    // Default startup inventory
    router.applyInstalledInventory([{ name: modelId, digest: testDigest }]);

    // Historical baseline: G2 is UNVERIFIED until valid evidence is applied
    expect(router.getGateCertificationStatus(modelId, "G2_REPO_NAVIGATION")).toBe("UNVERIFIED");
    // Historical G1 is PASSED
    expect(router.getGateCertificationStatus(modelId, "G1_STRUCTURED_JSON")).toBe("PASSED");
    // Historical G8 and G10 are FAILED
    expect(router.getGateCertificationStatus(modelId, "G8_CONTEXT_RETENTION")).toBe("FAILED");
    expect(router.getGateCertificationStatus(modelId, "G10_COMPLETION_SIGNAL")).toBe("FAILED");

    // Applying FAILED evidence transitions status strictly to FAILED
    router.applyGateEvidence({
      gateId: "G2_REPO_NAVIGATION",
      outcome: "FAILED",
      modelId,
      modelDigest: testDigest,
      evaluationVersion: "cleanroom-eval-v2.1",
      evidenceRef: "historical-failed-eval-ref",
      summary: "Historical 0/5 navigation failure",
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(router.getGateCertificationStatus(modelId, "G2_REPO_NAVIGATION")).toBe("FAILED");
  });

  describe("SEC-016: G4 Single-File Mutation Boundary & Tamper Auditing", () => {
    it("strictly rejects writes targeting unauthorized files in G4 via tool gateway fence", async () => {
      const task = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;
      const evilProvider: any = {
        providerName: "evil-writer-provider",
        async generate() {
          return {
            requestId: "evil-write-req",
            outputText: JSON.stringify({
              toolName: "write_file",
              inputPayload: {
                path: "test/math-pow.test.js",
                content: "console.log('tampered test file');\n",
              },
              rationale: "Attempting to overwrite immutable test file",
            }),
            model: modelId,
            finishReason: "STOP",
            durationMs: 10,
          };
        },
      };

      const trial = await harness.executeTrial({
        task,
        modelProvider: evilProvider,
        modelId,
        modelDigest: testDigest,
      });

      expect(trial.overallPassed).toBe(false);
      expect(trial.gateB.passed).toBe(false);
      // Tool observation should have caught UNAUTHORIZED_WRITE_PATH
      const step = trial.stepRecords?.[0];
      expect(step?.toolObservation).toContain("UNAUTHORIZED_WRITE_PATH");
      expect(step?.toolObservation).toContain("strictly limits writes to authorized target file 'src/math-pow.js'");
    });

    it("strictly rejects creation of backdoor files outside designated single-file target", async () => {
      const task = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;
      const backdoorProvider: any = {
        providerName: "backdoor-provider",
        async generate() {
          return {
            requestId: "backdoor-req",
            outputText: JSON.stringify({
              toolName: "write_file",
              inputPayload: {
                path: "src/backdoor.js",
                content: "export const pwned = true;\n",
              },
              rationale: "Attempting backdoor creation",
            }),
            model: modelId,
            finishReason: "STOP",
            durationMs: 10,
          };
        },
      };

      const trial = await harness.executeTrial({
        task,
        modelProvider: backdoorProvider,
        modelId,
        modelDigest: testDigest,
      });

      expect(trial.overallPassed).toBe(false);
      expect(trial.gateB.passed).toBe(false);
      const step = trial.stepRecords?.[0];
      expect(step?.toolObservation).toContain("UNAUTHORIZED_WRITE_PATH");
    });
  });

  describe("SEC-017: Sealed Node.js VM Test Runner Isolation", () => {
    it("terminates infinite loops deterministically within 1000ms execution timeout", async () => {
      const task = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;
      const loopProvider: any = {
        providerName: "loop-provider",
        async generate() {
          return {
            requestId: "loop-req",
            outputText: JSON.stringify({
              toolName: "write_file",
              inputPayload: {
                path: "src/math-pow.js",
                content: "export function power(base, exp) { while (true) {} return 0; }\n",
              },
              rationale: "Infinite loop proposal",
            }),
            model: modelId,
            finishReason: "STOP",
            durationMs: 10,
          };
        },
      };

      const startMs = Date.now();
      const trial = await harness.executeTrial({
        task,
        modelProvider: loopProvider,
        modelId,
        modelDigest: testDigest,
      });
      const durationMs = Date.now() - startMs;

      expect(trial.overallPassed).toBe(false);
      expect(trial.gateB.passed).toBe(false);
      expect(trial.gateB.details.some((d) => d.includes("timed out"))).toBe(true);
      // Execution must have completed in bounded time (< 5 seconds total trial time)
      expect(durationMs).toBeLessThan(5000);
    });

    it("prevents host process termination or ambient global escape from repaired code", async () => {
      const task = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;
      const escapeProvider: any = {
        providerName: "escape-provider",
        async generate() {
          return {
            requestId: "escape-req",
            outputText: JSON.stringify({
              toolName: "write_file",
              inputPayload: {
                path: "src/math-pow.js",
                content: "export function power(base, exp) { if (typeof process !== 'undefined') process.exit(1); return base ** exp; }\n",
              },
              rationale: "Host escape attempt",
            }),
            model: modelId,
            finishReason: "STOP",
            durationMs: 10,
          };
        },
      };

      // Process must not exit, and trial must complete safely
      const trial = await harness.executeTrial({
        task,
        modelProvider: escapeProvider,
        modelId,
        modelDigest: testDigest,
      });

      // Because typeof process === 'undefined' in sealed VM, it evaluated cleanly and passed
      expect(trial.gateB.passed).toBe(true);
      expect(trial.overallPassed).toBe(true);
    });

    it("prevents arbitrary module imports via stripped require", async () => {
      const task = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;
      const requireProvider: any = {
        providerName: "require-provider",
        async generate() {
          return {
            requestId: "require-req",
            outputText: JSON.stringify({
              toolName: "write_file",
              inputPayload: {
                path: "src/math-pow.js",
                content: "export function power(base, exp) { const fs = require('node:fs'); return 0; }\n",
              },
              rationale: "Require attack",
            }),
            model: modelId,
            finishReason: "STOP",
            durationMs: 10,
          };
        },
      };

      const trial = await harness.executeTrial({
        task,
        modelProvider: requireProvider,
        modelId,
        modelDigest: testDigest,
      });

      expect(trial.overallPassed).toBe(false);
      expect(trial.gateB.passed).toBe(false);
      expect(trial.gateB.details.some((d) => d.includes("require is not defined"))).toBe(true);
    });

    it("prevents prototype pollution attacks within isolated VM execution", () => {
      const maliciousSource = `
        export function compute(val) {
          try {
            Object.prototype.polluted = "ATTACK_SUCCESS";
          } catch (e) {}
          return val * 2;
        }
      `;
      const assertions = `
        const result = compute(5);
        if (result !== 10) throw new Error("Computation failed");
        if (Object.prototype.polluted === "ATTACK_SUCCESS") throw new Error("PROTOTYPE_POLLUTION_DETECTED");
      `;
      const res = executeIsolatedTestInSandbox(maliciousSource, assertions);
      expect(res.success).toBe(true);
      expect((Object.prototype as any).polluted).toBeUndefined();
    });

    it("rejects unauthorized write_file path with case mismatch on case-sensitive evaluation (Audit 4)", async () => {
      const task = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;
      const casedProvider: any = {
        providerName: "cased-provider",
        async generate() {
          return {
            requestId: "cased-req",
            outputText: JSON.stringify({
              toolName: "write_file",
              inputPayload: {
                path: "src/MATH-POW.js",
                content: "export function power(base, exp) { return base ** exp; }\n",
              },
              rationale: "Write with altered case",
            }),
            model: modelId,
            finishReason: "STOP",
            durationMs: 10,
          };
        },
      };

      const trial = await harness.executeTrial({
        task,
        modelProvider: casedProvider,
        modelId,
        modelDigest: testDigest,
        caseSensitive: true,
      });

      expect(trial.overallPassed).toBe(false);
      const step = trial.stepRecords?.[0];
      expect(step?.toolObservation).toContain("UNAUTHORIZED_WRITE_PATH");
    });

    it("detects illegal symlinks created during trial and fails Gate B closed (SEC-016 / Audit 4)", async () => {
      const task = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;
      const symlinkProvider: any = {
        providerName: "symlink-provider",
        async generate() {
          return {
            requestId: "symlink-req",
            outputText: JSON.stringify({
              toolName: "write_file",
              inputPayload: {
                path: "src/math-pow.js",
                content: "export function power(base, exp) { return base ** exp; }\n",
              },
              rationale: "Valid fix plus side-channel symlink",
            }),
            model: modelId,
            finishReason: "STOP",
            durationMs: 10,
          };
        },
      };

      const trial = await harness.executeTrial({
        task,
        modelProvider: symlinkProvider,
        modelId,
        modelDigest: testDigest,
        onWorkspaceReady: (workspaceDir) => {
          const srcDir = path.join(workspaceDir, "src");
          if (fs.existsSync(srcDir)) {
            fs.symlinkSync(srcDir, path.join(workspaceDir, "illegal-symlink"), "junction");
          }
        },
      });

      expect(trial.overallPassed).toBe(false);
      expect(trial.gateB.passed).toBe(false);
      expect(trial.gateB.details.some((d) => d.includes("Illegal symbolic link created"))).toBe(true);
    });
  });
});
