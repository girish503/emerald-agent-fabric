import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getBenchmarkTaskById,
} from "../../src/application/evaluation/capability-benchmark-suite.js";
import { DeterministicEvalFixtureModelProvider } from "../../src/application/evaluation/deterministic-eval-fixture-model.js";
import { DualGateEvaluationHarness } from "../../src/application/evaluation/dual-gate-eval-harness.js";

describe("Application: Dual-Gate Evaluation Harness", () => {
  const harness = new DualGateEvaluationHarness();
  const testDigest = "sha256:d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668";

  it("passes both Gate A and Gate B when model fulfills behavioral criteria and verification oracle", async () => {
    const task = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;
    const provider = new DeterministicEvalFixtureModelProvider({ mode: "ALL_PASS" });

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId: "qwen2.5-coder:1.5b",
      modelDigest: testDigest,
      trialIndex: 0,
    });

    expect(trial.gateA.passed).toBe(true);
    expect(trial.gateB.passed).toBe(true);
    expect(trial.overallPassed).toBe(true);
    expect(trial.failureClassification).toBeUndefined();
    expect(trial.trialEvidenceHash).toHaveLength(64);
  });

  it("fails overall trial and classifies failure when Gate A fails behavioral criteria", async () => {
    const task = getBenchmarkTaskById("g2-nav-01-locate-auth-service")!;
    const provider = new DeterministicEvalFixtureModelProvider({ mode: "FAIL_GATE_A" });

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId: "qwen2.5-coder:1.5b",
      modelDigest: testDigest,
      trialIndex: 1,
    });

    expect(trial.gateA.passed).toBe(false);
    expect(trial.overallPassed).toBe(false);
    expect(trial.failureClassification).toBe("MODEL_BEHAVIORAL_FAILURE");
  });

  it("fails overall trial when Gate B independent verification fails despite valid Gate A syntax", async () => {
    const task = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;
    const provider = new DeterministicEvalFixtureModelProvider({ mode: "FAIL_GATE_B" });

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId: "qwen2.5-coder:1.5b",
      modelDigest: testDigest,
      trialIndex: 2,
    });

    expect(trial.gateA.passed).toBe(true);
    expect(trial.gateB.passed).toBe(false);
    expect(trial.overallPassed).toBe(false);
    expect(trial.failureClassification).toBe("INDEPENDENT_VERIFICATION_FAILURE");
  });

  it("handles timeout boundedly and classifies trial as TIMEOUT", async () => {
    const task = getBenchmarkTaskById("g2-nav-01-locate-auth-service")!;
    const provider = new DeterministicEvalFixtureModelProvider({ mode: "SIMULATE_TIMEOUT" });

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId: "qwen2.5-coder:1.5b",
      modelDigest: testDigest,
      trialIndex: 3,
      timeoutMs: 50, // Short timeout for test
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.failureClassification).toBe("TIMEOUT");
  });

  it("rejects path traversal attempt outside sandbox and classifies as SECURITY_VIOLATION", async () => {
    const task = getBenchmarkTaskById("g2-nav-01-locate-auth-service")!;
    const provider = new DeterministicEvalFixtureModelProvider({ mode: "SIMULATE_PATH_TRAVERSAL" });

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId: "qwen2.5-coder:1.5b",
      modelDigest: testDigest,
      trialIndex: 4,
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.failureClassification).toBe("SECURITY_VIOLATION");
  });

  it("executes multi-step repository navigation with genuine search then read interaction", async () => {
    const task = getBenchmarkTaskById("g2-nav-01-locate-auth-service")!;
    const provider = new DeterministicEvalFixtureModelProvider({ mode: "ALL_PASS" });

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId: "qwen2.5-coder:1.5b",
      modelDigest: testDigest,
      trialIndex: 5,
    });

    expect(trial.overallPassed).toBe(true);
    expect(trial.gateA.passed).toBe(true);
    expect(trial.gateB.passed).toBe(true);
    expect(trial.stepsExecuted).toBe(3);
    expect(trial.stepRecords).toHaveLength(3);
    expect(trial.stepRecords?.[0]?.proposal.toolName).toBe("search_code");
    expect(trial.stepRecords?.[1]?.proposal.toolName).toBe("read_file");
    expect(trial.stepRecords?.[1]?.accessedPath).toBe("packages/services/auth/src/jwt-signer.js");
    expect(trial.stepRecords?.[2]?.proposal.toolName).toBeUndefined();
  });

  it("fails Gate B when model searches but never executes read_file on expected target", async () => {
    const task = getBenchmarkTaskById("g2-nav-01-locate-auth-service")!;
    const provider = new DeterministicEvalFixtureModelProvider({ mode: "SEARCH_ONLY_NO_READ" });

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId: "qwen2.5-coder:1.5b",
      modelDigest: testDigest,
      trialIndex: 6,
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.gateB.passed).toBe(false);
    expect(trial.failureClassification).toBe("INDEPENDENT_VERIFICATION_FAILURE");
    expect(trial.gateB.details.some((d) => d.includes("were not accessed via read_file"))).toBe(true);
    expect(trial.gateB.details.some((d) => d.includes("Model claims of success noted and disregarded"))).toBe(true);
  });

  it("fails Gate B when model reads decoy file rather than active production target", async () => {
    const task = getBenchmarkTaskById("g2-nav-05-decoy-boundary")!;
    const provider = new DeterministicEvalFixtureModelProvider({ mode: "READ_DECOY" });

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId: "qwen2.5-coder:1.5b",
      modelDigest: testDigest,
      trialIndex: 7,
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.gateB.passed).toBe(false);
    expect(trial.failureClassification).toBe("INDEPENDENT_VERIFICATION_FAILURE");
    expect(trial.gateB.details.some((d) => d.includes("config/production.json"))).toBe(true);
  });

  it("terminates when step budget is exhausted without target read", async () => {
    const task = getBenchmarkTaskById("g2-nav-01-locate-auth-service")!;
    const provider = new DeterministicEvalFixtureModelProvider({ mode: "EXHAUST_STEP_BUDGET" });

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId: "qwen2.5-coder:1.5b",
      modelDigest: testDigest,
      trialIndex: 8,
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.stepsExecuted).toBe(task.resourceLimits.maxSteps);
    expect(trial.failureClassification).toBe("MODEL_BEHAVIORAL_FAILURE");
  });

  it("detects stagnation and terminates interaction loop early on repeated identical action", async () => {
    const task = getBenchmarkTaskById("g2-nav-01-locate-auth-service")!;
    const provider = new DeterministicEvalFixtureModelProvider({ mode: "SIMULATE_STAGNATION" });

    const trial = await harness.executeTrial({
      task,
      modelProvider: provider,
      modelId: "qwen2.5-coder:1.5b",
      modelDigest: testDigest,
      trialIndex: 9,
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.stepsExecuted).toBe(2);
    expect(trial.stepRecords?.[1]?.toolObservation).toContain("STAGNATION_DETECTED");
  });

  it("generates anti-leakage workspace manifest containing relative paths without disclosing contents or answers", () => {
    const manifest = DualGateEvaluationHarness.generateWorkspaceManifest(".", { maxEntries: 5 });
    expect(manifest).toBeDefined();
    // Manifest lines start with "- "
    const lines = manifest.split("\n");
    expect(lines.length).toBeGreaterThan(0);
    // Does not disclose file content
    expect(manifest).not.toContain("export class");
    expect(manifest).not.toContain("export function");
    // Contains truncation metadata
    expect(manifest).toContain("[Repository Structure:");
  });

  it("strictly prevents workspace manifest answer leakage across all 5 G2 benchmark tasks", () => {
    const g2Tasks = [
      getBenchmarkTaskById("g2-nav-01-locate-auth-service")!,
      getBenchmarkTaskById("g2-nav-02-locate-db-pool")!,
      getBenchmarkTaskById("g2-nav-03-locate-logger")!,
      getBenchmarkTaskById("g2-nav-04-locate-error-handler")!,
      getBenchmarkTaskById("g2-nav-05-decoy-boundary")!,
    ];

    for (const task of g2Tasks) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `manifest-leak-test-${task.taskId}-`));
      try {
        for (const [relPath, content] of Object.entries(task.initialFiles)) {
          const fullPath = path.join(tempDir, relPath);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, content, "utf8");
        }

        const manifest = DualGateEvaluationHarness.generateWorkspaceManifest(tempDir);

        // 1. Target files MUST NEVER appear in the manifest
        for (const target of task.gateACriteria.expectedTargetFiles ?? []) {
          expect(manifest).not.toContain(target);
          expect(manifest).not.toContain(path.basename(target));
        }

        // 2. Expected symbols / function citations MUST NEVER appear in the manifest
        for (const citation of task.gateACriteria.expectedCitations ?? []) {
          expect(manifest).not.toContain(citation);
        }

        // 3. Legitimate top-level directory structure MUST be present
        const hasTopLevelDir = manifest.includes("packages/") || manifest.includes("src/") || manifest.includes("config/");
        expect(hasTopLevelDir).toBe(true);
        expect(manifest).toContain("[Repository Structure:");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it("rejects write_file proposals during G2 evaluation with policy rejection and zero workspace mutation", async () => {
    const task = getBenchmarkTaskById("g2-nav-01-locate-auth-service")!;
    let attemptedWritePath = "";

    const writeProposingProvider: any = {
      providerName: "write-proposing-provider",
      async generate() {
        attemptedWritePath = "packages/services/auth/src/evil-mutation.js";
        return {
          requestId: "write-req-1",
          outputText: JSON.stringify({
            toolName: "write_file",
            inputPayload: {
              path: attemptedWritePath,
              content: "export const hacked = true;",
            },
            rationale: "Attempting unauthorized write during G2 navigation",
          }),
          model: "qwen2.5-coder:1.5b",
          finishReason: "STOP",
          durationMs: 10,
        };
      },
    };

    const trial = await harness.executeTrial({
      task,
      modelProvider: writeProposingProvider,
      modelId: "qwen2.5-coder:1.5b",
      modelDigest: testDigest,
      trialIndex: 10,
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.gateA.passed).toBe(false);
    expect(trial.gateB.passed).toBe(false);
    expect(trial.stepRecords?.[0]?.toolObservation).toContain("POLICY_VIOLATION");
    expect(trial.stepRecords?.[0]?.toolObservation).toContain("Tool 'write_file' is not allowed");
  });

  it("proves that a differently cased path cannot satisfy Gate B on a case-sensitive filesystem (Linux parity)", async () => {
    const task = getBenchmarkTaskById("g2-nav-01-locate-auth-service")!;
    // Ground-truth target is packages/services/auth/src/jwt-signer.js
    // Model proposes differently cased path: packages/services/auth/src/Jwt-Signer.js
    const diffCaseProvider: any = {
      providerName: "diff-case-provider",
      async generate() {
        return {
          requestId: "diff-case-req",
          outputText: JSON.stringify({
            toolName: "read_file",
            inputPayload: { path: "packages/services/auth/src/Jwt-Signer.js" },
            rationale: "Targeting packages/services/auth/src/jwt-signer.js with signToken and verifyToken but path is Jwt-Signer.js",
          }),
          model: "qwen2.5-coder:1.5b",
          finishReason: "STOP",
          durationMs: 10,
        };
      },
    };

    const trial = await harness.executeTrial({
      task,
      modelProvider: diffCaseProvider,
      modelId: "qwen2.5-coder:1.5b",
      modelDigest: testDigest,
      trialIndex: 11,
      caseSensitive: true, // Enforce case sensitivity
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.gateA.passed).toBe(true);
    expect(trial.gateB.passed).toBe(false);
    expect(trial.failureClassification).toBe("INDEPENDENT_VERIFICATION_FAILURE");
    // Tool observation returns FILE_NOT_FOUND because case does not match on-disk file
    expect(trial.stepRecords?.[0]?.toolObservation).toContain("FILE_NOT_FOUND");
    expect(trial.gateB.details.some((d) => d.includes("were not accessed via read_file"))).toBe(true);
  });

  it("rejects symlink aliases from satisfying Gate B (negative test for symlink aliasing)", async () => {
    const task = getBenchmarkTaskById("g2-nav-01-locate-auth-service")!;

    // Model proposes reading alias.js
    const symlinkAliasProvider: any = {
      providerName: "symlink-alias-provider",
      async generate() {
        return {
          requestId: "alias-req",
          outputText: JSON.stringify({
            toolName: "read_file",
            inputPayload: { path: "packages/services/auth/src/alias.js" },
            rationale: "Targeting packages/services/auth/src/jwt-signer.js with signToken and verifyToken via alias",
          }),
          model: "qwen2.5-coder:1.5b",
          finishReason: "STOP",
          durationMs: 10,
        };
      },
    };

    // Create a task that includes alias.js
    const taskWithAlias = {
      ...task,
      initialFiles: {
        ...task.initialFiles,
        "packages/services/auth/src/alias.js": task.initialFiles["packages/services/auth/src/jwt-signer.js"]!,
      },
    };

    const trial = await harness.executeTrial({
      task: taskWithAlias,
      modelProvider: symlinkAliasProvider,
      modelId: "qwen2.5-coder:1.5b",
      modelDigest: testDigest,
      trialIndex: 12,
      isSymlinkPredicate: (p) => p.replace(/\\/g, "/").includes("alias.js"),
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.gateA.passed).toBe(true);
    expect(trial.gateB.passed).toBe(false);
    expect(trial.failureClassification).toBe("INDEPENDENT_VERIFICATION_FAILURE");
    expect(trial.gateB.details.some((d) => d.includes("were not accessed via read_file"))).toBe(true);
    expect(trial.gateB.details.some((d) => d.includes("[symlink]"))).toBe(true);
  });

  it("rejects missing file reads from satisfying Gate B", async () => {
    const task = getBenchmarkTaskById("g2-nav-01-locate-auth-service")!;
    const missingFileProvider: any = {
      providerName: "missing-file-provider",
      async generate() {
        return {
          requestId: "missing-req",
          outputText: JSON.stringify({
            toolName: "read_file",
            inputPayload: { path: "packages/services/auth/src/non-existent-file.js" },
            rationale: "Reading non-existent file",
          }),
          model: "qwen2.5-coder:1.5b",
          finishReason: "STOP",
          durationMs: 10,
        };
      },
    };

    const trial = await harness.executeTrial({
      task,
      modelProvider: missingFileProvider,
      modelId: "qwen2.5-coder:1.5b",
      modelDigest: testDigest,
      trialIndex: 13,
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.gateB.passed).toBe(false);
    expect(trial.stepRecords?.[0]?.toolObservation).toContain("FILE_NOT_FOUND");
    expect(trial.gateB.details.some((d) => d.includes("were not accessed via read_file"))).toBe(true);
  });

  it("rejects wrong file reads from satisfying Gate B", async () => {
    const task = getBenchmarkTaskById("g2-nav-01-locate-auth-service")!;
    const wrongFileProvider: any = {
      providerName: "wrong-file-provider",
      async generate() {
        return {
          requestId: "wrong-req",
          outputText: JSON.stringify({
            toolName: "read_file",
            inputPayload: { path: "packages/services/auth/package.json" },
            rationale: "Targeting packages/services/auth/src/jwt-signer.js with signToken and verifyToken, but reading package.json",
          }),
          model: "qwen2.5-coder:1.5b",
          finishReason: "STOP",
          durationMs: 10,
        };
      },
    };

    const trial = await harness.executeTrial({
      task,
      modelProvider: wrongFileProvider,
      modelId: "qwen2.5-coder:1.5b",
      modelDigest: testDigest,
      trialIndex: 14,
    });

    expect(trial.overallPassed).toBe(false);
    expect(trial.gateA.passed).toBe(true);
    expect(trial.gateB.passed).toBe(false);
    expect(trial.failureClassification).toBe("INDEPENDENT_VERIFICATION_FAILURE");
    expect(trial.gateB.details.some((d) => d.includes("were not accessed via read_file"))).toBe(true);
  });

  it("manifest anti-leakage: task with root-level target files does not disclose targets", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-root-target-test-"));
    try {
      fs.writeFileSync(path.join(tempDir, "root-target.ts"), "export const secretCode = 42;", "utf8");
      fs.writeFileSync(path.join(tempDir, "README.md"), "# Project", "utf8");
      fs.writeFileSync(path.join(tempDir, "package.json"), "{}", "utf8");
      fs.mkdirSync(path.join(tempDir, "src"));
      fs.writeFileSync(path.join(tempDir, "src", "index.ts"), "export * from './app';", "utf8");

      const manifest = DualGateEvaluationHarness.generateWorkspaceManifest(tempDir, {
        targetFiles: ["root-target.ts"],
        expectedCitations: ["secretCode"],
      });

      // root-target.ts MUST NOT appear in the manifest
      expect(manifest).not.toContain("root-target.ts");
      expect(manifest).not.toContain("secretCode");
      // Standard structure MUST appear
      expect(manifest).toContain("README.md");
      expect(manifest).toContain("package.json");
      expect(manifest).toContain("src/");
      expect(manifest).not.toContain("index.ts"); // Leaf file inside src/ must not appear
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("manifest anti-leakage: deeply nested layout displays directory structure without leaf files", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-deep-test-"));
    try {
      fs.mkdirSync(path.join(tempDir, "packages", "services", "auth", "src"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "packages", "services", "auth", "src", "deep-secret.ts"), "secret", "utf8");
      fs.mkdirSync(path.join(tempDir, "packages", "shared", "utils"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "packages", "shared", "utils", "helper.ts"), "helper", "utf8");

      const manifest = DualGateEvaluationHarness.generateWorkspaceManifest(tempDir, { maxDepth: 2 });

      // Directories up to depth 2 must appear
      expect(manifest).toContain("packages/");
      expect(manifest).toContain("packages/services/");
      expect(manifest).toContain("packages/shared/");
      // Leaf files must never appear
      expect(manifest).not.toContain("deep-secret.ts");
      expect(manifest).not.toContain("helper.ts");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("manifest anti-leakage: deterministic truncation metadata never discloses omitted target names", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-trunc-test-"));
    try {
      for (let i = 0; i < 35; i++) {
        const num = String(i).padStart(2, "0");
        fs.mkdirSync(path.join(tempDir, `module-${num}`));
      }

      const manifest = DualGateEvaluationHarness.generateWorkspaceManifest(tempDir, { maxEntries: 10 });

      // Exactly 10 module lines shown, 1 truncation indicator, 1 metadata line
      expect(manifest).toContain("- module-00/");
      expect(manifest).toContain("- module-09/");
      expect(manifest).not.toContain("- module-10/");
      expect(manifest).toContain("- ... (25 more entries truncated)");
      expect(manifest).toContain("[Repository Structure: 10 entries shown (25 truncated)]");
      // No sensitive names in truncation line
      expect(manifest).not.toContain("target");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("manifest anti-leakage: supports empty directories and unusual directory names cleanly", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-unusual-test-"));
    try {
      fs.mkdirSync(path.join(tempDir, "empty-dir-alpha"));
      fs.mkdirSync(path.join(tempDir, "@scoped-scope", "sub-pkg"), { recursive: true });
      fs.mkdirSync(path.join(tempDir, "directory with spaces"));

      const manifest = DualGateEvaluationHarness.generateWorkspaceManifest(tempDir);

      expect(manifest).toContain("empty-dir-alpha/");
      expect(manifest).toContain("@scoped-scope/");
      expect(manifest).toContain("@scoped-scope/sub-pkg/");
      expect(manifest).toContain("directory with spaces/");
      expect(manifest).toContain("[Repository Structure: 4 entries shown (0 truncated)]");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("G3: Code Understanding & Grounded Diagnosis", () => {
    const g3Tasks = [
      "g3-diag-01-off-by-one",
      "g3-diag-02-null-dereference",
      "g3-diag-03-division-by-zero",
      "g3-diag-04-async-race",
      "g3-diag-05-healthy-boundary",
    ];

    it("evaluates all 5 G3 tasks and passes both Gate A and Gate B under grounded causal diagnosis", async () => {
      const provider = new DeterministicEvalFixtureModelProvider({ mode: "ALL_PASS" });
      for (let i = 0; i < g3Tasks.length; i++) {
        const task = getBenchmarkTaskById(g3Tasks[i]!)!;
        const trial = await harness.executeTrial({
          task,
          modelProvider: provider,
          modelId: "qwen2.5-coder:1.5b",
          modelDigest: testDigest,
          trialIndex: i,
        });

        expect(trial.gateA.passed).toBe(true);
        expect(trial.gateB.passed).toBe(true);
        expect(trial.overallPassed).toBe(true);
        expect(trial.gateB.details.some((d) => d.includes("Verified citation of defective line"))).toBe(true);
        expect(trial.gateB.details.some((d) => d.includes("Verified presence of causal"))).toBe(true);
      }
    });

    it("fails Gate B when model hallucinates diagnosis without reading the target file", async () => {
      const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
      const noReadProvider: any = {
        providerName: "no-read-provider",
        async generate() {
          return {
            requestId: "no-read-req",
            outputText: JSON.stringify({
              toolName: undefined,
              rationale: "The defect in src/chunker.js is on line 3: i <= arr.length causes empty chunk in slice loop.",
            }),
            model: "qwen2.5-coder:1.5b",
            finishReason: "STOP",
            durationMs: 10,
          };
        },
      };

      const trial = await harness.executeTrial({
        task,
        modelProvider: noReadProvider,
        modelId: "qwen2.5-coder:1.5b",
        modelDigest: testDigest,
        trialIndex: 0,
      });

      expect(trial.gateB.passed).toBe(false);
      expect(trial.overallPassed).toBe(false);
      expect(trial.gateB.details.some((d) => d.includes("were not accessed via read_file"))).toBe(true);
    });

    it("fails Gate B when diagnosis omits defective line number citation", async () => {
      const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
      const noLineProvider: any = {
        providerName: "no-line-provider",
        async generate() {
          return {
            requestId: "no-line-req",
            outputText: JSON.stringify({
              toolName: "read_file",
              inputPayload: { path: "src/chunker.js" },
              rationale: "The loop condition i <= arr.length produces an empty chunk in slice without specifying any line number.",
            }),
            model: "qwen2.5-coder:1.5b",
            finishReason: "STOP",
            durationMs: 10,
          };
        },
      };

      const trial = await harness.executeTrial({
        task,
        modelProvider: noLineProvider,
        modelId: "qwen2.5-coder:1.5b",
        modelDigest: testDigest,
        trialIndex: 0,
      });

      expect(trial.gateB.passed).toBe(false);
      expect(trial.overallPassed).toBe(false);
      expect(trial.gateB.details.some((d) => d.includes("failed to cite expected defective line number"))).toBe(true);
    });

    it("fails Gate B when diagnosis omits causal explanation keywords", async () => {
      const task = getBenchmarkTaskById("g3-diag-04-async-race")!;
      const noCausalProvider: any = {
        providerName: "no-causal-provider",
        async generate() {
          return {
            requestId: "no-causal-req",
            outputText: JSON.stringify({
              toolName: "read_file",
              inputPayload: { path: "src/worker.js" },
              rationale: "Error on line 2 in src/worker.js something is wrong.",
            }),
            model: "qwen2.5-coder:1.5b",
            finishReason: "STOP",
            durationMs: 10,
          };
        },
      };

      const trial = await harness.executeTrial({
        task,
        modelProvider: noCausalProvider,
        modelId: "qwen2.5-coder:1.5b",
        modelDigest: testDigest,
        trialIndex: 0,
      });

      expect(trial.gateB.passed).toBe(false);
      expect(trial.overallPassed).toBe(false);
      expect(trial.gateB.details.some((d) => d.includes("missing causal explanation keywords"))).toBe(true);
    });

    it("fails Gate B healthy boundary check when model falsely blames healthy code in negative case", async () => {
      const task = getBenchmarkTaskById("g3-diag-05-healthy-boundary")!;
      const falseBlameProvider: any = {
        providerName: "false-blame-provider",
        async generate() {
          return {
            requestId: "false-blame-req",
            outputText: JSON.stringify({
              toolName: "read_file",
              inputPayload: { path: "test/math.test.js" },
              rationale: "There is a bug in math.js on line 3 and we should fix math.js to make 2+2 equal 5.",
            }),
            model: "qwen2.5-coder:1.5b",
            finishReason: "STOP",
            durationMs: 10,
          };
        },
      };

      const trial = await harness.executeTrial({
        task,
        modelProvider: falseBlameProvider,
        modelId: "qwen2.5-coder:1.5b",
        modelDigest: testDigest,
        trialIndex: 0,
      });

      expect(trial.gateB.passed).toBe(false);
      expect(trial.overallPassed).toBe(false);
      expect(trial.gateB.details.some((d) => d.includes("falsely blamed healthy production file"))).toBe(true);
    });

    it("fails Gate B when keywords are present but diagnosis contains contradictory or wrong causal claims", async () => {
      const task = getBenchmarkTaskById("g3-diag-04-async-race")!;
      const contradictoryProvider: any = {
        providerName: "contradictory-provider",
        async generate() {
          return {
            requestId: "contra-req",
            outputText: JSON.stringify({
              toolName: "read_file",
              inputPayload: { path: "src/worker.js" },
              rationale: "Line 2: db.save is async promise, but do not await because db.save throws error if awaited.",
            }),
            model: "qwen2.5-coder:1.5b",
            finishReason: "STOP",
            durationMs: 10,
          };
        },
      };

      const trial = await harness.executeTrial({
        task,
        modelProvider: contradictoryProvider,
        modelId: "qwen2.5-coder:1.5b",
        modelDigest: testDigest,
        trialIndex: 0,
      });

      expect(trial.gateB.passed).toBe(false);
      expect(trial.overallPassed).toBe(false);
      expect(trial.gateB.details.some((d) => d.includes("contradictory advice"))).toBe(true);
    });

    it("fails Gate B when correct line is cited but wrong defect is named", async () => {
      const task = getBenchmarkTaskById("g3-diag-02-null-dereference")!;
      const wrongDefectProvider: any = {
        providerName: "wrong-defect-provider",
        async generate() {
          return {
            requestId: "wrong-defect-req",
            outputText: JSON.stringify({
              toolName: "read_file",
              inputPayload: { path: "src/user-service.js" },
              rationale: "On line 2: toUpperCase is broken and null pointer exception occurs because toUpperCase does not exist.",
            }),
            model: "qwen2.5-coder:1.5b",
            finishReason: "STOP",
            durationMs: 10,
          };
        },
      };

      const trial = await harness.executeTrial({
        task,
        modelProvider: wrongDefectProvider,
        modelId: "qwen2.5-coder:1.5b",
        modelDigest: testDigest,
        trialIndex: 0,
      });

      expect(trial.gateB.passed).toBe(false);
      expect(trial.overallPassed).toBe(false);
      expect(trial.gateB.details.some((d) => d.includes("fails to identify user.profile"))).toBe(true);
    });

    it("fails Gate B when defect is named but bare number without line syntax is used", async () => {
      const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
      const bareNumberProvider: any = {
        providerName: "bare-number-provider",
        async generate() {
          return {
            requestId: "bare-num-req",
            outputText: JSON.stringify({
              toolName: "read_file",
              inputPayload: { path: "src/chunker.js" },
              rationale: "In 3 iterations the loop termination i <= arr.length creates an empty chunk from slice.",
            }),
            model: "qwen2.5-coder:1.5b",
            finishReason: "STOP",
            durationMs: 10,
          };
        },
      };

      const trial = await harness.executeTrial({
        task,
        modelProvider: bareNumberProvider,
        modelId: "qwen2.5-coder:1.5b",
        modelDigest: testDigest,
        trialIndex: 0,
      });

      expect(trial.gateB.passed).toBe(false);
      expect(trial.overallPassed).toBe(false);
      expect(trial.gateB.details.some((d) => d.includes("failed to cite expected defective line number"))).toBe(true);
    });

    it("fails Gate B when model only echoes the test output trace without explaining causal boundary", async () => {
      const task = getBenchmarkTaskById("g3-diag-01-off-by-one")!;
      const echoProvider: any = {
        providerName: "echo-provider",
        async generate() {
          return {
            requestId: "echo-req",
            outputText: JSON.stringify({
              toolName: "read_file",
              inputPayload: { path: "src/chunker.js" },
              rationale: "On line 3: Test case: chunkArray([1, 2, 3, 4, 5, 6], 2) failed with empty chunk length.",
            }),
            model: "qwen2.5-coder:1.5b",
            finishReason: "STOP",
            durationMs: 10,
          };
        },
      };

      const trial = await harness.executeTrial({
        task,
        modelProvider: echoProvider,
        modelId: "qwen2.5-coder:1.5b",
        modelDigest: testDigest,
        trialIndex: 0,
      });

      expect(trial.gateB.passed).toBe(false);
      expect(trial.overallPassed).toBe(false);
      expect(trial.gateB.details.some((d) => d.includes("fails to identify loop termination condition"))).toBe(true);
    });

    it("fails Gate B when harmful or unneeded modification to healthy production code is advocated", async () => {
      const task = getBenchmarkTaskById("g3-diag-05-healthy-boundary")!;
      const harmfulProvider: any = {
        providerName: "harmful-provider",
        async generate() {
          return {
            requestId: "harm-req",
            outputText: JSON.stringify({
              toolName: "read_file",
              inputPayload: { path: "test/math.test.js" },
              rationale: "Defect in math.js on line 3: we must modify src/math.js to return a + b + 1 so test passes.",
            }),
            model: "qwen2.5-coder:1.5b",
            finishReason: "STOP",
            durationMs: 10,
          };
        },
      };

      const trial = await harness.executeTrial({
        task,
        modelProvider: harmfulProvider,
        modelId: "qwen2.5-coder:1.5b",
        modelDigest: testDigest,
        trialIndex: 0,
      });

      expect(trial.gateB.passed).toBe(false);
      expect(trial.overallPassed).toBe(false);
      expect(trial.gateB.details.some((d) => d.includes("falsely blamed healthy production file"))).toBe(true);
    });
  });

  describe("G4: Single File Repair & Isolated VM Test Execution", () => {
    const g4Tasks = [
      "g4-repair-01-fix-math-pow",
      "g4-repair-02-fix-clamp",
      "g4-repair-03-fix-array-unique",
      "g4-repair-04-fix-string-trim",
      "g4-repair-05-fix-hex-validator",
    ];

    it("evaluates all 5 G4 tasks and passes both Gate A and Gate B under functional VM execution", async () => {
      const provider = new DeterministicEvalFixtureModelProvider({ mode: "ALL_PASS" });
      for (let i = 0; i < g4Tasks.length; i++) {
        const task = getBenchmarkTaskById(g4Tasks[i]!)!;
        const trial = await harness.executeTrial({
          task,
          modelProvider: provider,
          modelId: "qwen2.5-coder:1.5b",
          modelDigest: testDigest,
          trialIndex: i,
        });

        expect(trial.gateA.passed).toBe(true);
        expect(trial.gateB.passed).toBe(true);
        expect(trial.overallPassed).toBe(true);
        expect(trial.gateB.details.some((d) => d.includes("All functional assertions satisfied"))).toBe(true);
        expect(trial.gateB.details.some((d) => d.includes("Single-file mutation boundary verified"))).toBe(true);
      }
    });

    it("eliminates G4-01 string-matching vulnerability: non-functional code containing keywords fails Gate B", async () => {
      const task = getBenchmarkTaskById("g4-repair-01-fix-math-pow")!;
      // Model emits original broken multiplication with Math.pow / ** in comment
      const cheatProvider: any = {
        providerName: "cheat-provider",
        async generate() {
          return {
            requestId: "cheat-req",
            outputText: JSON.stringify({
              toolName: "write_file",
              inputPayload: {
                path: "src/math-pow.js",
                content: "export function power(base, exp) {\n  // Math.pow ** keyword guessing\n  return base * exp;\n}\n",
              },
              rationale: "Fixed power function with Math.pow and **",
            }),
            model: "qwen2.5-coder:1.5b",
            finishReason: "STOP",
            durationMs: 10,
          };
        },
      };

      const trial = await harness.executeTrial({
        task,
        modelProvider: cheatProvider,
        modelId: "qwen2.5-coder:1.5b",
        modelDigest: testDigest,
        trialIndex: 0,
      });

      // Gate A passes because tool and target file are correct
      expect(trial.gateA.passed).toBe(true);
      // Gate B MUST fail because actual test runner executed and 2*3 !== 8
      expect(trial.gateB.passed).toBe(false);
      expect(trial.overallPassed).toBe(false);
      expect(trial.failureClassification).toBe("INDEPENDENT_VERIFICATION_FAILURE");
      expect(trial.gateB.details.some((d) => d.includes("Isolated test runner execution failed"))).toBe(true);
    });

    it("fails Gate B when repaired code throws runtime exception during execution", async () => {
      const task = getBenchmarkTaskById("g4-repair-02-fix-clamp")!;
      const throwingProvider: any = {
        providerName: "throwing-provider",
        async generate() {
          return {
            requestId: "throw-req",
            outputText: JSON.stringify({
              toolName: "write_file",
              inputPayload: {
                path: "src/clamp.js",
                content: "export function clamp(val, min, max) {\n  throw new Error('RUNTIME_PANIC_IN_REPAIR');\n}\n",
              },
              rationale: "Attempted clamp fix",
            }),
            model: "qwen2.5-coder:1.5b",
            finishReason: "STOP",
            durationMs: 10,
          };
        },
      };

      const trial = await harness.executeTrial({
        task,
        modelProvider: throwingProvider,
        modelId: "qwen2.5-coder:1.5b",
        modelDigest: testDigest,
        trialIndex: 0,
      });

      expect(trial.gateB.passed).toBe(false);
      expect(trial.overallPassed).toBe(false);
      expect(trial.gateB.details.some((d) => d.includes("RUNTIME_PANIC_IN_REPAIR"))).toBe(true);
    });
  });
});
