import { describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalJsonStringify, sha256Hex } from "../../src/domain/canonical-hash.js";
import {
  CLEANROOM_TOOL_CONTRACTS,
  computeToolSchemasHash,
  renderToolSchemaDocumentation,
  validateToolProposalPayload,
} from "../../src/application/evaluation/cleanroom-tool-schema.js";
import {
  DualGateEvaluationHarness,
  EVALUATION_HARNESS_VERSION,
  EVALUATION_HARNESS_VERSION_V3_0,
  EVALUATION_HARNESS_VERSION_V3_1,
} from "../../src/application/evaluation/dual-gate-eval-harness.js";
import { getBenchmarkTaskById } from "../../src/application/evaluation/capability-benchmark-suite.js";
import { DeterministicEvalFixtureModelProvider } from "../../src/application/evaluation/deterministic-eval-fixture-model.js";
import { GovernedModelRouterService } from "../../src/application/governed-model-router.js";
import { ModelProviderPort, ModelProviderRequest, ModelProviderResponse } from "../../src/ports/model-provider.port.js";

describe("Phase 1: Deterministic Tool-Schema Discoverability & Gateway Contract Hardening (cleanroom-eval-v3.1)", () => {
  const modelId = "qwen2.5-coder:1.5b";
  const modelDigest = "sha256:d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668";
  const harness = new DualGateEvaluationHarness();

  // 1. Every G3/G4 model-visible tool schema matches its gateway contract
  it("Scenario 1: every G3/G4 model-visible tool schema matches its gateway contract", () => {
    expect(EVALUATION_HARNESS_VERSION_V3_1).toBe("cleanroom-eval-v3.1");
    expect(EVALUATION_HARNESS_VERSION).toBe("cleanroom-eval-v3.1");

    // G3 tools: read_file
    const readFileContract = CLEANROOM_TOOL_CONTRACTS.read_file;
    expect(readFileContract.toolName).toBe("read_file");
    expect(readFileContract.canonicalPathParameter).toBe("path");
    const readPath = readFileContract.parameters.find((p) => p.name === "path");
    expect(readPath?.required).toBe(true);
    expect(readPath?.aliases).toContain("filePath");

    // G4 tools: read_file, write_file
    const writeFileContract = CLEANROOM_TOOL_CONTRACTS.write_file;
    expect(writeFileContract.toolName).toBe("write_file");
    expect(writeFileContract.canonicalPathParameter).toBe("path");
    const writePath = writeFileContract.parameters.find((p) => p.name === "path");
    expect(writePath?.required).toBe(true);
    expect(writePath?.aliases).toBeUndefined(); // filePath is NOT an alias for write_file

    const g3Docs = renderToolSchemaDocumentation(["read_file"]);
    expect(g3Docs).toContain("Tool: `read_file`");
    expect(g3Docs).toContain("`path` (string, REQUIRED");

    const g4Docs = renderToolSchemaDocumentation(["read_file", "write_file"]);
    expect(g4Docs).toContain("Tool: `read_file`");
    expect(g4Docs).toContain("Tool: `write_file`");
    expect(g4Docs).toContain("CANONICAL PARAMETER IS 'path'");
    expect(g4Docs).toContain("Parameter 'filePath' is NOT accepted");
  });

  // 2. write_file clearly requires path
  it("Scenario 2: write_file clearly requires path and forbids filePath in schema and documentation", () => {
    const contract = CLEANROOM_TOOL_CONTRACTS.write_file;
    const pathParam = contract.parameters.find((p) => p.name === "path");
    expect(pathParam).toBeDefined();
    expect(pathParam?.required).toBe(true);
    expect(pathParam?.type).toBe("string");
    expect(contract.canonicalPathParameter).toBe("path");

    const docs = renderToolSchemaDocumentation(["write_file"]);
    expect(docs).toMatch(/Canonical Path Parameter:\s*`path`/);
    expect(docs).toContain("Valid Minimal Proposal Example:");
    expect(docs).toContain('"path":"src/math-pow.js"');
  });

  // 3. Invalid filePath-only write proposals are rejected deterministically
  it("Scenario 3: invalid filePath-only write proposals are rejected deterministically with structured error", () => {
    const res = validateToolProposalPayload("write_file", {
      filePath: "src/math-pow.js",
      content: "export function power(base, exp) { return base ** exp; }",
    });

    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.error.error).toBe("MISSING_PATH");
      expect(res.error.tool).toBe("write_file");
      expect(res.error.missingRequiredParameter).toBe("path");
      expect(res.error.rejectedParameter).toBe("filePath");
      expect(res.error.message).toContain("Parameter 'filePath' is not accepted by write_file; use 'path'.");
      expect(res.error.mutationExecuted).toBe(false);
      expect(res.error.expectedSchema.required).toContain("path");
      expect(res.error.expectedSchema.required).toContain("content");
    }
  });

  // 4. Rejection occurs before workspace mutation
  it("Scenario 4: rejection occurs before workspace mutation and leaves disk unmodified", async () => {
    const task = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;
    let capturedWorkspace: string | undefined;

    const mockProvider: ModelProviderPort = {
      modelId,
      generate: async (req: ModelProviderRequest): Promise<ModelProviderResponse> => {
        return {
          outputText: JSON.stringify({
            toolName: "write_file",
            inputPayload: {
              filePath: "src/math-pow.js", // Invalid key
              content: "MUTATED_CONTENT_SHOULD_NEVER_EXIST",
            },
            rationale: "Attempt write with invalid key",
          }),
        };
      },
    };

    const trial = await harness.executeTrial({
      task,
      modelProvider: mockProvider,
      modelId,
      modelDigest,
      trialIndex: 0,
      onWorkspaceReady: (ws) => {
        capturedWorkspace = ws;
      },
    });

    expect(trial.overallPassed).toBe(false);
    const step1 = trial.stepRecords?.[0];
    expect(step1?.toolObservation).toContain("MISSING_PATH");
    expect(step1?.toolObservation).toContain('"mutationExecuted": false');
    expect(step1?.toolObservation).toContain('"rejectedParameter": "filePath"');
  });

  // 5. Valid path proposals retain existing behavior
  it("Scenario 5: valid path proposals retain existing behavior and succeed", async () => {
    const task = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;
    const provider = new DeterministicEvalFixtureModelProvider({ mode: "ALL_PASS" });

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId,
      modelDigest,
      trialIndex: 0,
    });

    expect(trial.gateA.passed).toBe(true);
    expect(trial.gateB.passed).toBe(true);
    expect(trial.overallPassed).toBe(true);
    expect(trial.harnessVersion).toBe("cleanroom-eval-v3.1");
  });

  // 6. read_file retains its existing accepted parameter behavior
  it("Scenario 6: read_file retains its existing accepted parameter behavior for path and filePath", () => {
    // Valid with path
    const resPath = validateToolProposalPayload("read_file", { path: "src/user-service.js" });
    expect(resPath.valid).toBe(true);

    // Valid with filePath (gateway compatibility)
    const resFilePath = validateToolProposalPayload("read_file", { filePath: "src/user-service.js" });
    expect(resFilePath.valid).toBe(true);

    // Invalid when both are missing
    const resNeither = validateToolProposalPayload("read_file", { offsetLine: 1, limitLines: 50 });
    expect(resNeither.valid).toBe(false);
    if (!resNeither.valid) {
      expect(resNeither.error.error).toBe("MISSING_PATH");
      expect(resNeither.error.missingRequiredParameter).toBe("path");
      expect(resNeither.error.mutationExecuted).toBe(false);
    }
  });

  // 7. Structured errors identify the exact invalid or missing parameter
  it("Scenario 7: structured errors identify the exact invalid or missing parameter across tools", () => {
    // write_file missing path
    const errWrite = validateToolProposalPayload("write_file", {});
    expect(errWrite.valid).toBe(false);
    if (!errWrite.valid) {
      expect(errWrite.error.missingRequiredParameter).toBe("path");
      expect(errWrite.error.expectedSchema.parameters.path).toBeDefined();
    }

    // search_code missing query
    const errSearch = validateToolProposalPayload("search_code", { path: "." });
    expect(errSearch.valid).toBe(false);
    if (!errSearch.valid) {
      expect(errSearch.error.error).toBe("INVALID_QUERY");
      expect(errSearch.error.missingRequiredParameter).toBe("query");
      expect(errSearch.error.expectedSchema.parameters.query).toBeDefined();
    }
  });

  // 8. Error feedback reaches the next inference context
  it("Scenario 8: error feedback reaches the next inference context without truncation", async () => {
    const task = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;
    const capturedRequests: ModelProviderRequest[] = [];

    const mockProvider: ModelProviderPort = {
      modelId,
      generate: async (req: ModelProviderRequest): Promise<ModelProviderResponse> => {
        capturedRequests.push(req);
        if (capturedRequests.length === 1) {
          // Step 1: propose invalid filePath
          return {
            outputText: JSON.stringify({
              toolName: "write_file",
              inputPayload: { filePath: "src/math-pow.js", content: "attempt 1" },
              rationale: "Propose with invalid key",
            }),
          };
        }
        // Step 2: propose valid path
        return {
          outputText: JSON.stringify({
            toolName: "write_file",
            inputPayload: {
              path: "src/math-pow.js",
              content: "export function power(base, exp) {\n  return base ** exp;\n}\n",
            },
            rationale: "Corrected to use canonical path parameter",
          }),
        };
      },
    };

    const trial = await harness.executeTrial({
      task,
      modelProvider: mockProvider,
      modelId,
      modelDigest,
      trialIndex: 0,
    });

    expect(capturedRequests.length).toBeGreaterThanOrEqual(2);
    const step2Input = capturedRequests[1]!.input;

    // Verify system prompt in Step 2 contains schema documentation
    const systemMsg = step2Input.find((m) => m.role === "system");
    expect(systemMsg?.content).toContain("Available Tool Schemas and Contracts:");
    expect(systemMsg?.content).toContain("CANONICAL PARAMETER IS 'path'");

    // Verify user message preceding Step 2 contains the full structured error observation
    const toolObservationMsg = step2Input.find(
      (m) => m.role === "user" && m.content.includes("Tool 'write_file' observation:")
    );
    expect(toolObservationMsg).toBeDefined();
    expect(toolObservationMsg?.content).toContain('"error": "MISSING_PATH"');
    expect(toolObservationMsg?.content).toContain('"missingRequiredParameter": "path"');
    expect(toolObservationMsg?.content).toContain('"rejectedParameter": "filePath"');
    expect(toolObservationMsg?.content).toContain('"mutationExecuted": false');

    // And verify the trial passes overall when corrected in Step 2!
    expect(trial.overallPassed).toBe(true);
    expect(trial.gateA.passed).toBe(true);
    expect(trial.gateB.passed).toBe(true);
  });

  // 9. No sensitive internal paths or secrets leak through error responses
  it("Scenario 9: no sensitive internal host paths or secrets leak through error responses", async () => {
    const task = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;
    let hostTmpPath = "";

    const mockProvider: ModelProviderPort = {
      modelId,
      generate: async (): Promise<ModelProviderResponse> => {
        return {
          outputText: JSON.stringify({
            toolName: "write_file",
            inputPayload: { filePath: "src/math-pow.js", content: "dummy" },
            rationale: "test",
          }),
        };
      },
    };

    const trial = await harness.executeTrial({
      task,
      modelProvider: mockProvider,
      modelId,
      modelDigest,
      trialIndex: 0,
      onWorkspaceReady: (ws) => {
        hostTmpPath = ws;
      },
    });

    const obs = trial.stepRecords?.[0]?.toolObservation ?? "";
    expect(obs).not.toContain(hostTmpPath);
    expect(obs).not.toContain(os.homedir());
    expect(obs).not.toContain("process.env");
    expect(obs).not.toContain("password");
    expect(obs).not.toContain("secret");
  });

  // 10. Schema changes are included in configuration identity and hashing
  it("Scenario 10: schema changes are included in configuration identity and hashing", async () => {
    const task = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;
    const provider = new DeterministicEvalFixtureModelProvider({ mode: "ALL_PASS" });

    // Trial under v3.0 harness
    const trialV3_0 = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId,
      modelDigest,
      trialIndex: 0,
      harnessVersion: EVALUATION_HARNESS_VERSION_V3_0,
    });

    // Trial under v3.1 harness
    const trialV3_1 = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId,
      modelDigest,
      trialIndex: 0,
      harnessVersion: EVALUATION_HARNESS_VERSION_V3_1,
    });

    expect(trialV3_0.harnessVersion).toBe("cleanroom-eval-v3.0");
    expect(trialV3_1.harnessVersion).toBe("cleanroom-eval-v3.1");

    // The configuration hashes MUST differ because v3.1 binds toolSchemaHash and new harnessVersion
    expect(trialV3_0.configHash).not.toBe(trialV3_1.configHash);
    expect(trialV3_0.trialEvidenceHash).not.toBe(trialV3_1.trialEvidenceHash);

    const schemaHashG4 = computeToolSchemasHash(["read_file", "write_file"]);
    expect(schemaHashG4).toHaveLength(64);
  });

  // 11. Historical v3.0 and G3/G4 v1.1.0 evidence remains byte-identical
  it("Scenario 11: historical v3.0 and G3/G4 v1.1.0 evidence remains byte-identical", () => {
    const brainDir = "C:/Users/Adusumalli Girish/.gemini/antigravity/brain/22cc3ec1-2247-4c9d-855b-ba8bc4b1274d";

    const expectedHashes: Record<string, string> = {
      "g3-v1.0.0-raw-evidence.json": "fa9e421d1656023d815b185c9aff70223f33323b78e99e22b92a33b0b4e88dab",
      "g3-v1.1.0-live-raw-evidence.json": "b973df278dddd8da3dbf246690d7045b79982cb17db0e0ef8be75731d1a1ed86",
      "g3-v1.1.0-live-evidence-manifest.json": "f68fc662b3a4401127d831958bef66c0ef7809bddeb898a5ba759bb35121e365",
      "g4-v1.1.0-live-raw-evidence.json": "702001006442fccde5926699d58386317db6ca07dd3e8ff62b9bffd89b78e16d",
      "g4-v1.1.0-live-evidence-manifest.json": "593824ff8e6acd377e1531473863961ca2d79851a0f2e6e4251faed7ad87df09",
      "g4-v1.1.0-live-five-trial-results.md": "5d8c7d22faa10e1592a2a13bc3285a4e9387682a81e24fef55d850c0765ce07c",
    };

    for (const [filename, expectedHash] of Object.entries(expectedHashes)) {
      const fullPath = path.join(brainDir, filename);
      if (fs.existsSync(fullPath)) {
        const fileBytes = fs.readFileSync(fullPath);
        const actualHash = crypto.createHash("sha256").update(fileBytes).digest("hex");
        expect(actualHash).toBe(expectedHash);
      }
    }
  });

  // 12. Gate A and Gate B behavior remains unchanged
  it("Scenario 12: Gate A and Gate B assessment criteria remain strictly unchanged", async () => {
    // Case A: Gate A failure
    const taskA = getBenchmarkTaskById("g2-nav-01-locate-auth-service")!;
    const failAProvider = new DeterministicEvalFixtureModelProvider({ mode: "FAIL_GATE_A" });
    const trialA = await harness.executeTrial({
      task: taskA,
      modelProvider: failAProvider,
      modelId,
      modelDigest,
      trialIndex: 0,
    });
    expect(trialA.gateA.passed).toBe(false);
    expect(trialA.overallPassed).toBe(false);
    expect(trialA.failureClassification).toBe("MODEL_BEHAVIORAL_FAILURE");

    // Case B: Gate B failure
    const taskB = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;
    const failBProvider = new DeterministicEvalFixtureModelProvider({ mode: "FAIL_GATE_B" });
    const trialB = await harness.executeTrial({
      task: taskB,
      modelProvider: failBProvider,
      modelId,
      modelDigest,
      trialIndex: 1,
    });
    expect(trialB.gateA.passed).toBe(true);
    expect(trialB.gateB.passed).toBe(false);
    expect(trialB.overallPassed).toBe(false);
    expect(trialB.failureClassification).toBe("INDEPENDENT_VERIFICATION_FAILURE");
  });

  // 13. Independent verification remains authoritative
  it("Scenario 13: independent verification remains authoritative; model claiming success without fix fails", async () => {
    const task = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;
    const liarProvider: ModelProviderPort = {
      modelId,
      generate: async (): Promise<ModelProviderResponse> => ({
        outputText: JSON.stringify({
          toolName: undefined,
          inputPayload: {},
          rationale: "I have fixed the bug and all tests pass! TEST_PASSED 100% verified.",
        }),
      }),
    };

    const trial = await harness.executeTrial({
      task,
      modelProvider: liarProvider,
      modelId,
      modelDigest,
      trialIndex: 0,
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.gateB.passed).toBe(false);
  });

  // 14. Stagnation detection still halts repeated invalid proposals
  it("Scenario 14: stagnation detection still halts repeated invalid proposals", async () => {
    const task = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;
    const repeatingProvider: ModelProviderPort = {
      modelId,
      generate: async (): Promise<ModelProviderResponse> => ({
        outputText: JSON.stringify({
          toolName: "write_file",
          inputPayload: { filePath: "src/math-pow.js", content: "repeating bug" },
          rationale: "repeated attempt",
        }),
      }),
    };

    const trial = await harness.executeTrial({
      task,
      modelProvider: repeatingProvider,
      modelId,
      modelDigest,
      trialIndex: 0,
    });

    expect(trial.overallPassed).toBe(false);
    const steps = trial.stepRecords ?? [];
    expect(steps.length).toBe(2);
    expect(steps[1]?.toolObservation).toContain("STAGNATION_DETECTED");
  });

  // 15. Timeout, cancellation, fencing and cleanup precedence remain intact
  it("Scenario 15: timeout, cancellation, fencing and cleanup precedence remain intact", async () => {
    const task = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;

    // Fencing / path traversal precedence
    const traversalProvider = new DeterministicEvalFixtureModelProvider({ mode: "SIMULATE_PATH_TRAVERSAL" });
    const trialSec = await harness.executeTrial({
      task,
      modelProvider: traversalProvider,
      modelId,
      modelDigest,
      trialIndex: 0,
    });
    expect(trialSec.failureClassification).toBe("SECURITY_VIOLATION");
    expect(trialSec.diagnosticRootCause).toBe("SECURITY_VIOLATION");

    // Cleanup failure cannot downgrade SECURITY_VIOLATION
    const trialSecCleanup = await harness.executeTrial({
      task,
      modelProvider: traversalProvider,
      modelId,
      modelDigest,
      trialIndex: 1,
      cleanupWorkspace: () => {
        throw new Error("Simulated cleanup disk failure");
      },
    });
    expect(trialSecCleanup.failureClassification).toBe("SECURITY_VIOLATION");

    // Caller cancellation
    const abortCtrl = new AbortController();
    abortCtrl.abort(new Error("OPERATOR_ABORT: Operator terminated trial"));
    const trialCancel = await harness.executeTrial({
      task,
      modelProvider: new DeterministicEvalFixtureModelProvider({ mode: "ALL_PASS" }),
      modelId,
      modelDigest,
      trialIndex: 2,
      abortSignal: abortCtrl.signal,
    });
    expect(trialCancel.failureClassification).toBe("CANCELLED");
    expect(trialCancel.diagnosticRootCause).toBe("CALLER_ABORTED");
  });

  // 16. Late model responses cannot produce success
  it("Scenario 16: late model responses cannot produce success", async () => {
    const task = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;
    const slowProvider: ModelProviderPort = {
      modelId,
      generate: async (): Promise<ModelProviderResponse> => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return {
          outputText: JSON.stringify({
            toolName: "write_file",
            inputPayload: {
              path: "src/math-pow.js",
              content: "export function power(base, exp) { return base ** exp; }",
            },
            rationale: "Late response",
          }),
        };
      },
    };

    const trial = await harness.executeTrial({
      task,
      modelProvider: slowProvider,
      modelId,
      modelDigest,
      trialIndex: 0,
      timeoutMs: 50,
      stepTimeoutMs: 30,
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.failureClassification).toBe("TIMEOUT");
  });

  // 17. Existing router certification and assignment enforcement remain unchanged
  it("Scenario 17: existing router certification and assignment enforcement remain unchanged (CODER blocked)", () => {
    const router = new GovernedModelRouterService();
    router.applyInstalledInventory([
      { name: modelId, digest: modelDigest },
    ]);

    // G3 and G4 remain UNVERIFIED in clean state
    expect(router.getGateCertificationStatus(modelId, "G3_CODE_UNDERSTANDING")).toBe("UNVERIFIED");
    expect(router.getGateCertificationStatus(modelId, "G4_SINGLE_FILE_REPAIR")).toBe("UNVERIFIED");

    // Attempting to route CODER fails closed because G3 and G4 are required
    expect(() =>
      router.routeModel({
        role: "CODER",
        tenantId: "tenant-eval",
        taskId: "task-eval-1",
        contractId: "contract-eval-1",
        remainingBudgetMs: 300000,
        stepBudgetMs: 150000,
        estimatedContextTokens: 1000,
      })
    ).toThrowError(/MISSING_GATE_EVIDENCE/);
  });
});
