/**
 * Emerald Agent Fabric — Production Benchmark Unit & Integration Test Suite (v0.1)
 *
 * Verifies manifest integrity, zero gold-patch leakage, pre-flight doctor diagnostics,
 * local model adapter robustness, governed benchmark execution, and 3-sweep replay.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BenchmarkManifestLoader } from "../../src/production/benchmark/benchmark-manifest.js";
import { BenchmarkDoctor } from "../../src/production/benchmark/benchmark-doctor.js";
import { OllamaModelAdapter } from "../../src/production/benchmark/ollama-model-adapter.js";
import { BenchmarkRunner } from "../../src/production/benchmark/benchmark-runner.js";
import { EmeraldCli } from "../../src/cli/emerald-cli.js";
import { ModelAdapter, AgentProposal } from "../../src/runtime/production-runtime-engine.js";

describe("Production Benchmark Suite (v0.1)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-bench-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore Windows cleanup locks
    }
  });

  // ============================================================================
  // 1. BenchmarkManifestLoader & Gold Patch Leak Prevention
  // ============================================================================
  describe("1. BenchmarkManifestLoader", () => {
    it("1.1 loads and cryptographically digests exactly 15 tasks", () => {
      const loader = new BenchmarkManifestLoader();
      const manifest = loader.loadManifest();

      expect(manifest.taskCount).toBe(15);
      expect(manifest.tasks).toHaveLength(15);
      expect(manifest.manifestHash).toHaveLength(64);

      const easyTasks = manifest.tasks.filter((t) => t.difficulty === "EASY");
      const medTasks = manifest.tasks.filter((t) => t.difficulty === "MEDIUM");
      const hardTasks = manifest.tasks.filter((t) => t.difficulty === "HARD");

      expect(easyTasks).toHaveLength(5);
      expect(medTasks).toHaveLength(5);
      expect(hardTasks).toHaveLength(5);
    });

    it("1.2 buildUntrustedPromptForModel never leaks gold patches or test code", () => {
      const loader = new BenchmarkManifestLoader();
      const manifest = loader.loadManifest();
      const task = manifest.tasks[0]!;

      const prompt = loader.buildUntrustedPromptForModel(task);

      // Must contain issue description and source file
      expect(prompt).toContain(task.issue);
      expect(prompt).toContain(task.sourceFile);

      // Must NEVER contain expected behavioral fix or test implementation
      expect(prompt).not.toContain(task.expectedBehavior);
      expect(prompt).not.toContain(task.testCode);
      expect(prompt).not.toContain("assert.strictEqual");
    });
  });

  // ============================================================================
  // 2. BenchmarkDoctor & Hardware Feasibility Separation
  // ============================================================================
  describe("2. BenchmarkDoctor", () => {
    it("2.1 runs diagnostics and identifies host RAM and CPU specs", async () => {
      const doctor = new BenchmarkDoctor();
      const diag = await doctor.runDiagnostics();

      expect(diag.timestamp).toBeDefined();
      expect(diag.system.hostRamTotalMb).toBeGreaterThan(0);
      expect(diag.system.cpuCores).toBeGreaterThan(0);
      expect(diag.components.length).toBeGreaterThanOrEqual(4);
    });

    it("2.2 correctly distinguishes INFEASIBLE models when RAM is insufficient", async () => {
      const doctor = new BenchmarkDoctor();
      const diag = await doctor.runDiagnostics();

      // Models requiring > host RAM should be marked INFEASIBLE
      const infeasibleModels = diag.models.filter((m) => m.feasibility === "INFEASIBLE");
      if (diag.system.hostRamTotalMb < 12000) {
        expect(infeasibleModels.some((m) => m.modelName.includes("14b") || m.modelName.includes("32b"))).toBe(true);
      }
    });
  });

  // ============================================================================
  // 3. OllamaModelAdapter Proposal Parsing
  // ============================================================================
  describe("3. OllamaModelAdapter", () => {
    it("3.1 parses markdown-wrapped JSON proposal cleanly", async () => {
      const adapter = new OllamaModelAdapter("qwen2.5-coder:3b");
      const rawText = "```json\n{\n  \"thought\": \"Fix off by one\",\n  \"toolName\": \"write_file\",\n  \"toolInput\": {\"path\": \"calc.js\", \"content\": \"fixed\"},\n  \"isGoalReached\": true\n}\n```";

      // Access private parser via typed instance
      const parsed = (adapter as any).parseProposal(rawText);
      expect(parsed.thought).toBe("Fix off by one");
      expect(parsed.toolName).toBe("write_file");
      expect(parsed.toolInput.path).toBe("calc.js");
      expect(parsed.isGoalReached).toBe(true);
    });

    it("3.2 throws descriptive error on completely malformed JSON", () => {
      const adapter = new OllamaModelAdapter("qwen2.5-coder:3b");
      expect(() => (adapter as any).parseProposal("This is not JSON at all")).toThrow(
        "Failed to parse model output",
      );
    });
  });

  // ============================================================================
  // 4. BenchmarkRunner Execution & Sovereign Verification
  // ============================================================================
  describe("4. BenchmarkRunner", () => {
    it("4.1 executes Control C (Human Reference) and achieves sovereign verified success", async () => {
      const loader = new BenchmarkManifestLoader();
      const manifest = loader.loadManifest();
      const task = manifest.tasks[0]!;

      const runner = new BenchmarkRunner(loader);
      const mockAdapter: ModelAdapter = {
        async proposeAction() {
          return { thought: "mock", toolName: "git_status", toolInput: {} };
        },
      };

      const result = await runner.runTrial(task, "CONTROL_C_HUMAN_REFERENCE", mockAdapter, "human-ref", tempDir);

      expect(result.classification).toBe("SOVEREIGN_VERIFIED_SUCCESS");
      expect(result.verified).toBe(true);
      expect(result.replayVerified).toBe(true);
      expect(result.safety.capabilityViolations).toBe(0);
      expect(result.safety.pathTraversalAttempts).toBe(0);
    });

    it("4.2 executes Control B (Emerald Governed Runtime) through full production loop", async () => {
      const loader = new BenchmarkManifestLoader();
      const manifest = loader.loadManifest();
      const task = manifest.tasks[0]!;

      const runner = new BenchmarkRunner(loader);

      // Realistic model adapter that inspects, fixes, and signals completion
      let step = 0;
      const repairingAdapter: ModelAdapter = {
        async proposeAction(): Promise<AgentProposal> {
          step++;
          if (step === 1) {
            return {
              thought: "Inspect the buggy source file",
              toolName: "read_file",
              toolInput: { path: task.sourceFile },
            };
          } else if (step === 2) {
            const fixedCode = `class TokenBucket {
  constructor(capacity) {
    this.capacity = capacity;
    this.tokens = capacity;
  }
  consume(cost) {
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }
}
module.exports = { TokenBucket };
`;
            return {
              thought: "Write the corrected token boundary condition",
              toolName: "write_file",
              toolInput: { path: task.sourceFile, content: fixedCode },
            };
          } else {
            return {
              thought: "Repair complete, verify working tree",
              toolName: "git_status",
              toolInput: {},
              isGoalReached: true,
            };
          }
        },
      };

      const result = await runner.runTrial(task, "CONTROL_B_GOVERNED_RUNTIME", repairingAdapter, "test-model", tempDir);

      expect(result.classification).toBe("SOVEREIGN_VERIFIED_SUCCESS");
      expect(result.verified).toBe(true);
      expect(result.replayVerified).toBe(true);
      expect(result.attemptsCount).toBeGreaterThan(0);
      expect(result.toolCallsCount).toBeGreaterThanOrEqual(2);
      expect(result.verificationProofHash).toBeDefined();
      expect(result.evidenceBundleDigest).toBeDefined();
      expect(result.safety.capabilityViolations).toBe(0);
    });
  });

  // ============================================================================
  // 5. Emerald CLI Benchmark Commands
  // ============================================================================
  describe("5. Emerald CLI Benchmark Commands", () => {
    it("5.1 'emerald benchmark list' lists all 15 tasks", async () => {
      const cli = new EmeraldCli();
      const res = await cli.run(["benchmark", "list"]);

      expect(res.exitCode).toBe(0);
      expect(res.output).toContain("Total Tasks: 15");
      expect(res.output).toContain("swe-easy-001");
      expect(res.output).toContain("swe-hard-015");
    });

    it("5.2 'emerald benchmark doctor' reports system diagnostics", async () => {
      const cli = new EmeraldCli();
      const res = await cli.run(["benchmark", "doctor"]);

      expect(res.exitCode).toBe(0);
      expect(res.output).toContain("Benchmark Pre-Flight Diagnostics");
      expect(res.output).toContain("Host RAM:");
      expect(res.output).toContain("Local Model Feasibility Matrix:");
    });

    it("5.3 'emerald benchmark status' reports ready status", async () => {
      const cli = new EmeraldCli();
      const res = await cli.run(["benchmark", "status"]);

      expect(res.exitCode).toBe(0);
      expect(res.output).toContain("15 tasks registered");
    });
  });
});
