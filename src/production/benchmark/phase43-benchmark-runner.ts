/**
 * Phase 43 — Bounded Local Ollama Benchmark Runner
 *
 * Implements a bounded, reproducible benchmark runner executing real or simulated
 * local model inference against governed software repair tasks under strict Emerald invariants:
 *
 * 1. Zero Cloud / ₹0 Cost: Runs strictly against local models or hermetic fake transports.
 * 2. Complete Governance: All model outputs are untrusted proposals transit proposal validation,
 *    reflex policies, capability fencing, and independent clean-room dual-gate verification.
 * 3. Sovereign Verification: Task success is decided EXCLUSIVELY by clean-room FAIL_TO_PASS
 *    and PASS_TO_PASS test execution. Model self-reports (isGoalReached: true) are untrusted.
 * 4. Tamper-Proof Evidence: Every run generates an immutable EvidenceBundle signed by 2-of-3
 *    threshold Ed25519 keys, independently cross-checked by the standalone OfflineAuditor.
 * 5. Measured Truth: Real token counts and timings from provider telemetry are recorded directly;
 *    zero estimation or fabrication of unmeasured values.
 */

import * as crypto from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as zlib from "node:zlib";

const execFileAsync = promisify(execFile);

import { SqliteStateStore } from "../../adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../adapters/workspace/node-fs-workspace-adapter.js";
import { RunCoordinator } from "../../application/run-coordinator.js";
import { WorkerRuntime } from "../../application/worker-runtime.js";
import {
  CleanRoomVerifier,
  CleanRoomVerificationOutcome,
} from "../../application/clean-room-verifier.js";
import { LiveAgentBrain } from "../../application/live-agent-brain.js";
import {
  AgentStepController,
  StepControllerResult,
} from "../../application/agent-step-controller.js";
import { EvidenceExporter } from "../../application/evidence-exporter.js";
import {
  EvidenceSigner,
  TrustedKeyring,
} from "../../application/evidence-signer.js";
import {
  OfflineAuditor,
  AuditVerificationResult,
} from "../../application/offline-auditor.js";
import {
  ModelProviderPort,
  ModelProviderRequest,
  ModelProviderResponse,
} from "../../ports/model-provider.port.js";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "../../ports/execution-provider.port.js";
import { RunCommandOutput } from "../../domain/tool-schemas.js";
import { ClockPort, SystemClock } from "../../ports/clock.port.js";
import {
  CleanRoomVerificationSpec,
  createVerificationSpec,
} from "../../domain/verification.js";
import { createExecutionPolicy } from "../../domain/policy.js";
import {
  createMissionContract,
  createResourceLimits,
} from "../../domain/mission-contract.js";
import { EvidenceBundle } from "../../domain/evidence-bundle.js";
import { redactSensitiveData } from "../../domain/canonical-hash.js";

// ============================================================================
// 1. Task Definitions
// ============================================================================

export type Phase43PilotTaskId = "EAF-BM-01" | "EAF-BM-02" | "EAF-BM-03";

export interface Phase43PilotTask {
  readonly taskId: Phase43PilotTaskId;
  readonly title: string;
  readonly category: string;
  readonly targetFile: string;
  readonly allowedPathPatterns: readonly string[];
  readonly groundedDefect?: string;
  readonly initialFiles: Readonly<Record<string, string>>;
  readonly failToPass: {
    readonly testCommand: readonly string[];
    readonly expectedBaselineExitCode: number;
    readonly expectedPatchedExitCode: 0;
    readonly minTestCount: number;
    readonly suiteRanRegex: string;
  };
  readonly passToPass: {
    readonly testCommand: readonly string[];
    readonly expectedBaselineExitCode: 0;
    readonly expectedPatchedExitCode: 0;
    readonly minTestCount: number;
    readonly suiteRanRegex: string;
  };
  readonly goldPatch: string;
  readonly wrongPatch: string;
  readonly regressionPatch: string;
}

export const PHASE43_PILOT_TASKS: Readonly<Record<Phase43PilotTaskId, Phase43PilotTask>> = Object.freeze({
  "EAF-BM-01": {
    taskId: "EAF-BM-01",
    title: "Core Arithmetic Off-by-One Fix",
    category: "CODE_NAVIGATION",
    targetFile: "src/calc.js",
    allowedPathPatterns: ["src/calc.js"],
    groundedDefect:
      "In add(a, b), the current implementation returns a + b + 1 instead of a + b. Expected behavior: add(2, 3) === 5.",
    initialFiles: {
      "package.json": '{\n  "name": "calc",\n  "version": "1.0.0"\n}\n',
      "src/calc.js":
        "function add(a, b) {\n  return a + b + 1;\n}\n\nfunction multiply(a, b) {\n  return a * b;\n}\n\nmodule.exports = { add, multiply };\n",
      "test/f2p.test.js":
        'const assert = require("node:assert");\nconst { add } = require("../src/calc.js");\nassert.strictEqual(add(2, 3), 5);\nassert.strictEqual(add(-1, 1), 0);\nconsole.log("PASS: F2P calc passed");\n',
      "test/p2p.test.js":
        'const assert = require("node:assert");\nconst { multiply } = require("../src/calc.js");\nassert.strictEqual(multiply(4, 5), 20);\nconsole.log("PASS: P2P calc passed");\n',
    },
    failToPass: {
      testCommand: ["node", "test/f2p.test.js"],
      expectedBaselineExitCode: 1,
      expectedPatchedExitCode: 0 as const,
      minTestCount: 1,
      suiteRanRegex: "PASS: F2P calc passed",
    },
    passToPass: {
      testCommand: ["node", "test/p2p.test.js"],
      expectedBaselineExitCode: 0 as const,
      expectedPatchedExitCode: 0 as const,
      minTestCount: 1,
      suiteRanRegex: "PASS: P2P calc passed",
    },
    goldPatch:
      "function add(a, b) {\n  return a + b;\n}\n\nfunction multiply(a, b) {\n  return a * b;\n}\n\nmodule.exports = { add, multiply };\n",
    wrongPatch:
      "function add(a, b) {\n  return a - b;\n}\n\nfunction multiply(a, b) {\n  return a * b;\n}\n\nmodule.exports = { add, multiply };\n",
    regressionPatch:
      "function add(a, b) {\n  return a + b;\n}\n\nfunction multiply(a, b) {\n  return 0;\n}\n\nmodule.exports = { add, multiply };\n",
  },

  "EAF-BM-02": {
    taskId: "EAF-BM-02",
    title: "Shorthand Hexadecimal Parsing Fix",
    category: "LOCALIZED_BUG_FIX",
    targetFile: "src/hex.js",
    allowedPathPatterns: ["src/hex.js"],
    groundedDefect:
      "In parseHex(h), shorthand three-digit hexadecimal inputs such as '#fff' incorrectly return undefined. Expected behavior is to expand each shorthand RGB digit to two digits and return the three decimal channel values. Inspect the actual source code and produce a localized repair.",
    initialFiles: {
      "package.json": '{\n  "name": "hex-color",\n  "version": "1.0.0"\n}\n',
      "src/hex.js":
        "function parseHex(h) {\n  if (h.length === 4) return undefined;\n  return [parseInt(h.slice(1,3), 16), parseInt(h.slice(3,5), 16), parseInt(h.slice(5,7), 16)];\n}\n\nmodule.exports = { parseHex };\n",
      "test/f2p.test.js":
        'const assert = require("node:assert");\nconst { parseHex } = require("../src/hex.js");\nassert.deepStrictEqual(parseHex("#fff"), [255, 255, 255]);\nassert.deepStrictEqual(parseHex("#000"), [0, 0, 0]);\nconsole.log("PASS: F2P hex passed");\n',
      "test/p2p.test.js":
        'const assert = require("node:assert");\nconst { parseHex } = require("../src/hex.js");\nassert.deepStrictEqual(parseHex("#ff0000"), [255, 0, 0]);\nassert.deepStrictEqual(parseHex("#00ff00"), [0, 255, 0]);\nconsole.log("PASS: P2P hex passed");\n',
    },
    failToPass: {
      testCommand: ["node", "test/f2p.test.js"],
      expectedBaselineExitCode: 1,
      expectedPatchedExitCode: 0 as const,
      minTestCount: 1,
      suiteRanRegex: "PASS: F2P hex passed",
    },
    passToPass: {
      testCommand: ["node", "test/p2p.test.js"],
      expectedBaselineExitCode: 0 as const,
      expectedPatchedExitCode: 0 as const,
      minTestCount: 1,
      suiteRanRegex: "PASS: P2P hex passed",
    },
    goldPatch:
      "function parseHex(h) {\n  if (h.length === 4) {\n    return [parseInt(h[1]+h[1], 16), parseInt(h[2]+h[2], 16), parseInt(h[3]+h[3], 16)];\n  }\n  return [parseInt(h.slice(1,3), 16), parseInt(h.slice(3,5), 16), parseInt(h.slice(5,7), 16)];\n}\n\nmodule.exports = { parseHex };\n",
    wrongPatch:
      "function parseHex(h) {\n  return [0, 0, 0];\n}\n\nmodule.exports = { parseHex };\n",
    regressionPatch:
      "function parseHex(h) {\n  if (h.length === 4) return [255, 255, 255];\n  return [0, 0, 0];\n}\n\nmodule.exports = { parseHex };\n",
  },

  "EAF-BM-03": {
    taskId: "EAF-BM-03",
    title: "CORS Origin CRLF Injection Rejection",
    category: "INPUT_VALIDATION",
    targetFile: "src/cors.js",
    allowedPathPatterns: ["src/cors.js"],
    initialFiles: {
      "package.json": '{\n  "name": "cors-validator",\n  "version": "1.0.0"\n}\n',
      "src/cors.js":
        "function validateOrigin(origin) {\n  return origin.startsWith(\"http\");\n}\n\nmodule.exports = { validateOrigin };\n",
      "test/f2p.test.js":
        'const assert = require("node:assert");\nconst { validateOrigin } = require("../src/cors.js");\nassert.throws(() => validateOrigin("https://example.com\\r\\nInjected: Header"), /CRLF|injection|invalid/i);\nassert.throws(() => validateOrigin("https://example.com\\nInjected: Header"), /CRLF|injection|invalid/i);\nassert.throws(() => validateOrigin("https://example.com\\rInjected: Header"), /CRLF|injection|invalid/i);\nconsole.log("PASS: F2P cors passed");\n',
      "test/p2p.test.js":
        'const assert = require("node:assert");\nconst { validateOrigin } = require("../src/cors.js");\nassert.strictEqual(validateOrigin("https://valid.example.com"), true);\nassert.strictEqual(validateOrigin("http://localhost:3000"), true);\nconsole.log("PASS: P2P cors passed");\n',
    },
    failToPass: {
      testCommand: ["node", "test/f2p.test.js"],
      expectedBaselineExitCode: 1,
      expectedPatchedExitCode: 0 as const,
      minTestCount: 1,
      suiteRanRegex: "PASS: F2P cors passed",
    },
    passToPass: {
      testCommand: ["node", "test/p2p.test.js"],
      expectedBaselineExitCode: 0 as const,
      expectedPatchedExitCode: 0 as const,
      minTestCount: 1,
      suiteRanRegex: "PASS: P2P cors passed",
    },
    goldPatch:
      "function validateOrigin(origin) {\n  if (origin.includes(\"\\r\") || origin.includes(\"\\n\")) {\n    throw new Error(\"CRLF_INJECTION_DETECTED\");\n  }\n  return origin.startsWith(\"http\");\n}\n\nmodule.exports = { validateOrigin };\n",
    wrongPatch:
      "function validateOrigin(origin) {\n  return true;\n}\n\nmodule.exports = { validateOrigin };\n",
    regressionPatch:
      "function validateOrigin(origin) {\n  throw new Error(\"REJECT_ALL\");\n}\n\nmodule.exports = { validateOrigin };\n",
  },
});

// ============================================================================
// 2. Pure In-Process Git Repository Initializer
// ============================================================================

interface MockRepoFile {
  path: string;
  content: string;
}

async function writeLooseObject(
  gitDir: string,
  sha: string,
  rawPayload: Buffer
): Promise<void> {
  const prefix = sha.slice(0, 2);
  const rest = sha.slice(2);
  const dir = path.join(gitDir, "objects", prefix);
  await fs.mkdir(dir, { recursive: true });

  const compressed = zlib.deflateSync(rawPayload);
  await fs.writeFile(path.join(dir, rest), compressed);
}

async function writeMockIndex(
  gitDir: string,
  files: MockRepoFile[],
  fileBlobShas: Map<string, string>
): Promise<void> {
  const header = Buffer.alloc(12);
  header.write("DIRC", 0, 4, "ascii");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(files.length, 8);

  const entries: Buffer[] = [];
  for (const file of files) {
    const sha = fileBlobShas.get(file.path)!;
    const pathBuf = Buffer.from(file.path, "utf8");

    const statBuf = Buffer.alloc(40);
    const shaBuf = Buffer.from(sha, "hex");
    const flagsBuf = Buffer.alloc(2);
    flagsBuf.writeUInt16BE(Math.min(0xfff, pathBuf.length), 0);

    const fixedLen = 40 + 20 + 2;
    const pathAndNull = Buffer.concat([pathBuf, Buffer.from([0])]);
    const totalBeforePad = fixedLen + pathAndNull.length;
    const padLen = (8 - (totalBeforePad % 8)) % 8;
    const padding = Buffer.alloc(padLen, 0);

    const entry = Buffer.concat([statBuf, shaBuf, flagsBuf, pathAndNull, padding]);
    entries.push(entry);
  }

  const indexBuf = Buffer.concat([header, ...entries]);
  const checksum = crypto.createHash("sha1").update(indexBuf).digest();
  await fs.writeFile(path.join(gitDir, "index"), Buffer.concat([indexBuf, checksum]));
}

async function initCleanGitRepository(
  workspaceHostPath: string,
  committedFiles: MockRepoFile[]
): Promise<{ commitSha: string; fileBlobShas: Map<string, string> }> {
  const gitDir = path.join(workspaceHostPath, ".git");
  const objectsDir = path.join(gitDir, "objects");
  const refsDir = path.join(gitDir, "refs", "heads");

  await fs.mkdir(objectsDir, { recursive: true });
  await fs.mkdir(refsDir, { recursive: true });

  const fileBlobShas = new Map<string, string>();

  // 1. Write blobs
  for (const file of committedFiles) {
    const contentBuf = Buffer.from(file.content, "utf8");
    const header = Buffer.from(`blob ${contentBuf.length}\0`, "utf8");
    const sha = crypto
      .createHash("sha1")
      .update(header)
      .update(contentBuf)
      .digest("hex");

    fileBlobShas.set(file.path, sha);
    await writeLooseObject(gitDir, sha, Buffer.concat([header, contentBuf]));

    const targetPath = path.join(workspaceHostPath, file.path);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, "utf8");
  }

  // 2. Build tree object
  const treeEntries: Buffer[] = [];
  const sortedFiles = [...committedFiles].sort((a, b) => a.path.localeCompare(b.path));

  for (const file of sortedFiles) {
    const sha = fileBlobShas.get(file.path)!;
    const shaBuf = Buffer.from(sha, "hex");
    const entryHeader = Buffer.from(`100644 ${file.path}\0`, "utf8");
    treeEntries.push(Buffer.concat([entryHeader, shaBuf]));
  }

  const treeData = Buffer.concat(treeEntries);
  const treeHeader = Buffer.from(`tree ${treeData.length}\0`, "utf8");
  const treeSha = crypto
    .createHash("sha1")
    .update(treeHeader)
    .update(treeData)
    .digest("hex");

  await writeLooseObject(gitDir, treeSha, Buffer.concat([treeHeader, treeData]));

  // 3. Build commit object
  const commitBody = [
    `tree ${treeSha}`,
    `author EmeraldBenchmark <benchmark@emerald.local> 1700000000 +0000`,
    `committer EmeraldBenchmark <benchmark@emerald.local> 1700000000 +0000`,
    ``,
    `Initial benchmark fixture baseline`,
    ``,
  ].join("\n");

  const commitData = Buffer.from(commitBody, "utf8");
  const commitHeader = Buffer.from(`commit ${commitData.length}\0`, "utf8");
  const commitSha = crypto
    .createHash("sha1")
    .update(commitHeader)
    .update(commitData)
    .digest("hex");

  await writeLooseObject(gitDir, commitSha, Buffer.concat([commitHeader, commitData]));

  await fs.writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
  await fs.writeFile(path.join(refsDir, "main"), `${commitSha}\n`, "utf8");

  await writeMockIndex(gitDir, sortedFiles, fileBlobShas);

  return { commitSha, fileBlobShas };
}

// ============================================================================
// 3. Tracking Model Provider Wrapper
// ============================================================================
// 3. Tracking Model Provider Wrapper & Diagnostics
// ============================================================================

export const MAX_DIAGNOSTIC_COMPLETION_CHARS = 4096;
export const MAX_DIAGNOSTIC_ENTRIES = 50;

/**
 * Sanitizes diagnostic string content against sensitive credentials and secrets:
 * - PEM private key blocks
 * - Authorization Bearer tokens
 * - Common key/secret/token patterns
 */
export function sanitizeDiagnosticString(text: string): string {
  if (typeof text !== "string") {
    return "";
  }
  let result = text.replace(
    /-----BEGIN[A-Z\s]+PRIVATE KEY-----[\s\S]*?-----END[A-Z\s]+PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]"
  );
  result = result.replace(/Bearer\s+[A-Za-z0-9\-_.]+/gi, "Bearer [REDACTED]");
  result = result.replace(
    /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9\-_./+=]{8,}["']?/gi,
    (match) => {
      const parts = match.split(/[:=]/);
      return `${parts[0]}: "[REDACTED]"`;
    }
  );
  return result;
}

export interface Phase43RawCompletion {
  readonly callIndex: number;
  readonly durationMs: number;
  readonly promptTokens?: number;
  readonly evalTokens?: number;
  readonly rawOutput: string;
  readonly truncated: boolean;
  readonly originalLength: number;
}

export interface Phase43ProposalRejectionDiagnostic {
  readonly stepNumber: number;
  readonly proposalId?: string;
  readonly toolName?: string;
  readonly finishReason?: string;
  readonly proposalValid: boolean;
  readonly rejectionReason?: string;
  readonly rejectionMessage?: string;
  readonly rawCompletion?: string;
}

export interface Phase43StepDiagnostic {
  readonly stepNumber: number;
  readonly timestamp: string;
  readonly durationMs: number;
  readonly finishReason?: string;
  readonly proposalValid: boolean;
  readonly proposalId?: string;
  readonly toolName?: string;
  readonly inputPayload?: unknown;
  readonly rationale?: string;
  readonly rejectionReason?: string;
  readonly rejectionMessage?: string;
  readonly actionId?: string;
  readonly actionStatus?: string;
  readonly executionError?: string;
  readonly progressAdvisory?: string;
  readonly eligibleTools?: readonly string[];
  readonly filteredTools?: readonly string[];
  readonly rawCompletion?: string;
}

export interface Phase43TrialDiagnostics {
  readonly stepDiagnostics: readonly Phase43StepDiagnostic[];
  readonly proposalRejections: readonly Phase43ProposalRejectionDiagnostic[];
  readonly rawCompletions: readonly Phase43RawCompletion[];
  readonly postPassLatchSnapshot?: import("../../application/post-pass-verification-latch.js").PostPassLatchSnapshot;
}

class TrackingModelProviderWrapper implements ModelProviderPort {
  readonly providerName: string;
  calls = 0;
  failures = 0;
  totalLatencyMs = 0;
  promptTokens?: number;
  evalTokens?: number;
  totalTokens?: number;
  readonly rawCompletions: Phase43RawCompletion[] = [];

  constructor(
    private readonly inner: ModelProviderPort,
    private readonly maxCompletionLength: number = MAX_DIAGNOSTIC_COMPLETION_CHARS
  ) {
    this.providerName = inner.providerName;
  }

  async generate(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    this.calls++;
    const callIndex = this.calls;
    const start = Date.now();
    try {
      const response = await this.inner.generate(request);
      const durationMs = Date.now() - start;
      this.totalLatencyMs += durationMs;
      if (response.usage) {
        if (typeof response.usage.inputTokens === "number") {
          this.promptTokens = (this.promptTokens ?? 0) + response.usage.inputTokens;
        }
        if (typeof response.usage.outputTokens === "number") {
          this.evalTokens = (this.evalTokens ?? 0) + response.usage.outputTokens;
        }
        if (typeof response.usage.totalTokens === "number") {
          this.totalTokens = (this.totalTokens ?? 0) + response.usage.totalTokens;
        }
      }

      const rawText = typeof response.outputText === "string" ? response.outputText : "";
      const originalLength = rawText.length;
      const truncated = originalLength > this.maxCompletionLength;
      const boundedText = truncated
        ? rawText.slice(0, this.maxCompletionLength) + " [TRUNCATED]"
        : rawText;
      const sanitizedText = sanitizeDiagnosticString(boundedText);

      this.rawCompletions.push({
        callIndex,
        durationMs,
        promptTokens: response.usage?.inputTokens,
        evalTokens: response.usage?.outputTokens,
        rawOutput: sanitizedText,
        truncated,
        originalLength,
      });

      return response;
    } catch (err) {
      this.failures++;
      this.totalLatencyMs += Date.now() - start;
      throw err;
    }
  }
}

// ============================================================================
// 4. Runner Options and Result Types
// ============================================================================

export interface Phase43RunnerOptions {
  readonly modelProvider: ModelProviderPort;
  readonly model: string;
  readonly maxSteps?: number;
  readonly maxAttempts?: number;
  readonly stepTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
  readonly baseTempDir?: string;
  readonly signingKeys?: {
    readonly workerKeys: {
      readonly publicKey: crypto.KeyObject | string;
      readonly privateKey: crypto.KeyObject | string;
    };
    readonly supervisorKeys: {
      readonly publicKey: crypto.KeyObject | string;
      readonly privateKey: crypto.KeyObject | string;
    };
  };
  readonly keyring?: TrustedKeyring;
  readonly clock?: ClockPort;
  readonly retainWorkspace?: boolean;
  /**
   * Optional custom execution provider override (e.g. for deterministic simulation/testing).
   */
  readonly executionProvider?: ExecutionProvider;
  /**
   * Whether to explicitly enable dynamic context-aware tool filtering.
   * Default: false (preserves default-off behavior).
   */
  readonly enableDynamicToolFiltering?: boolean;
  /**
   * When active, whole-file overwrites via write_file are disallowed for existing files
   * if localized editing (edit_file) is authorized.
   * Default: false (preserves historical runner behavior and existing tests).
   */
  readonly governedBenchmarkRepairMode?: boolean;
  /**
   * Explicit override permitting whole-file overwrites even when governedBenchmarkRepairMode is active.
   * Default: false.
   */
  readonly allowWholeFileReplacement?: boolean;
}

export interface Phase43TrialResult {
  readonly runId: string;
  readonly taskId: Phase43PilotTaskId;
  readonly model: string;
  readonly verified: boolean;
  readonly terminalStatus: "COMPLETED" | "FAILED" | "TIMED_OUT";
  readonly terminalReason: string;
  readonly totalSteps: number;
  readonly totalActions: number;
  readonly totalProposalRejections: number;
  readonly durationMs: number;
  readonly tokenMetrics: {
    readonly promptTokens?: number;
    readonly evalTokens?: number;
    readonly totalTokens?: number;
    readonly modelCalls: number;
    readonly modelFailures: number;
  };
  readonly cleanRoomOutcome?: CleanRoomVerificationOutcome;
  readonly evidenceBundle: EvidenceBundle;
  readonly offlineAudit: AuditVerificationResult;
  readonly workspaceHostPath: string;
  readonly diagnostics: Phase43TrialDiagnostics;
}

// ============================================================================
// 4b. Local Process Execution Provider (Sovereign Clean-Room Process Execution)
// ============================================================================

export class LocalProcessExecutionProvider implements ExecutionProvider {
  readonly name = "local-process";
  readonly tenantModel = "NONE" as const;
  readonly quiescence = { async quiesceRun(_runId: string) { return { status: "QUIESCENT" as const, stopped: 0 }; } };

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    const startTime = Date.now();
    const payload = request.inputPayload as {
      argv?: string[];
      cwd?: string;
      maxOutputBytes?: number;
    } | undefined;

    const argv = payload?.argv ?? [];
    if (argv.length === 0) {
      return {
        status: "FAILED",
        error: { code: "EXECUTION_FAILED", message: "Empty argv in command execution request" },
        durationMs: Date.now() - startTime,
      };
    }

    const hostPath = request.workspace?.hostPath ?? process.cwd();
    const targetCwd = payload?.cwd ? path.resolve(hostPath, payload.cwd) : hostPath;
    const command = argv[0] === "node" ? process.execPath : argv[0]!;
    const args = argv.slice(1);

    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: targetCwd,
        timeout: request.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: payload?.maxOutputBytes ?? 10 * 1024 * 1024,
      });

      const durationMs = Date.now() - startTime;
      const combined = `${stdout}\n${stderr}`;
      const commandHash = crypto.createHash("sha256").update(combined, "utf8").digest("hex");

      const out: RunCommandOutput = {
        exitCode: 0,
        stdout,
        stderr,
        durationMs,
        outputTruncated: false,
        commandHash,
      };

      return {
        status: "SUCCESS",
        output: out as unknown as TOutput,
        durationMs,
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      if (err.killed || err.code === "ETIMEDOUT") {
        return {
          status: "TIMED_OUT",
          error: { code: "EXECUTION_TIMEOUT", message: "Process execution timed out" },
          durationMs,
        };
      }

      const exitCode = typeof err.code === "number" ? err.code : 1;
      const stdout = err.stdout ? String(err.stdout) : "";
      const stderr = err.stderr ? String(err.stderr) : (err.message ? String(err.message) : "");
      const combined = `${stdout}\n${stderr}`;
      const commandHash = crypto.createHash("sha256").update(combined, "utf8").digest("hex");

      const out: RunCommandOutput = {
        exitCode,
        stdout,
        stderr,
        durationMs,
        outputTruncated: false,
        commandHash,
      };

      return {
        status: "SUCCESS",
        output: out as unknown as TOutput,
        durationMs,
      };
    }
  }
}

// ============================================================================
// 5. Phase43BenchmarkRunner Implementation
// ============================================================================

export class Phase43BenchmarkRunner {
  constructor(private readonly defaultOptions?: Partial<Phase43RunnerOptions>) {}

  public getTask(taskId: Phase43PilotTaskId): Phase43PilotTask {
    const task = PHASE43_PILOT_TASKS[taskId];
    if (!task) {
      throw new Error(`Unknown Phase 43 task ID: '${taskId}'`);
    }
    return task;
  }

  public getAllTasks(): readonly Phase43PilotTask[] {
    return Object.values(PHASE43_PILOT_TASKS);
  }

  /**
   * Executes a single, completely governed benchmark trial.
   */
  public async executeTrial(
    task: Phase43PilotTask,
    options: Phase43RunnerOptions
  ): Promise<Phase43TrialResult> {
    const startTime = Date.now();
    const clock = options.clock ?? this.defaultOptions?.clock ?? new SystemClock();
    const baseTemp =
      options.baseTempDir ??
      this.defaultOptions?.baseTempDir ??
      os.tmpdir();

    const maxSteps = options.maxSteps ?? this.defaultOptions?.maxSteps ?? 10;
    const maxAttempts = options.maxAttempts ?? this.defaultOptions?.maxAttempts ?? 3;
    const stepTimeoutMs = options.stepTimeoutMs ?? this.defaultOptions?.stepTimeoutMs ?? 120000;
    const toolTimeoutMs = options.toolTimeoutMs ?? this.defaultOptions?.toolTimeoutMs ?? 30000;

    // 1. Setup isolated ephemeral workspace root
    const tempDir = fsSync.mkdtempSync(
      path.join(baseTemp, `emerald-p43-${task.taskId}-${Date.now()}-`)
    );

    // 2. Setup SQLite persistence and Runtime Coordinator
    const dbPath = path.join(tempDir, "state.db");
    const store = new SqliteStateStore({ location: dbPath });
    const coordinator = new RunCoordinator(store, clock);
    const workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: tempDir });

    const workerId = `worker-p43-${Date.now()}`;
    coordinator.registerWorker({
      workerId,
      hostname: "localhost",
      pid: process.pid,
      status: "ACTIVE",
      createdAt: clock.nowIso(),
      lastHeartbeatAt: clock.nowIso(),
    });

    const executionProvider =
      options.executionProvider ??
      this.defaultOptions?.executionProvider ??
      new LocalProcessExecutionProvider();
    const workerRuntime = new WorkerRuntime({
      workerId,
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
      executionProvider,
      isIsolationAvailable: true,
    });

    // 3. Setup Clean-Room Verifier
    const cleanRoomVerifier = new CleanRoomVerifier({
      workspacePort: workspaceAdapter,
      workerRuntime,
      coordinator,
      stateStore: store,
      clock,
    });

    // 4. Setup Live Agent Brain
    const trackingProvider = new TrackingModelProviderWrapper(options.modelProvider);
    const liveBrain = new LiveAgentBrain({
      modelProvider: trackingProvider,
      model: options.model,
      timeoutMs: stepTimeoutMs,
      clock,
      enableDynamicToolFiltering: options.enableDynamicToolFiltering ?? false,
      governedBenchmarkRepairMode: options.governedBenchmarkRepairMode,
    });

    // 5. Setup Governed Agent Step Controller
    const stepController = new AgentStepController({
      coordinator,
      stateStore: store,
      workerRuntime,
      agentBrain: liveBrain,
      cleanRoomVerifier,
      clock,
      enableDynamicToolFiltering: options.enableDynamicToolFiltering ?? false,
    });

    // 6. Define Task & Provision Agent Workspace
    const verificationCommand = task.failToPass.testCommand.join(" ");
    const regressionCommand = task.passToPass.testCommand.join(" ");
    const taskDescription = [
      `Task: ${task.title}`,
      `Category: ${task.category}`,
      `Target File: ${task.targetFile}`,
      `Allowed Modification Scope: ${task.allowedPathPatterns.join(", ")}`,
      ...(task.groundedDefect
        ? [`Grounded Defect: ${task.groundedDefect}`]
        : []),
      `Objective: Repair the defect in '${task.targetFile}'.`,
      `Repair Requirement: Make the smallest appropriate repair and verify it using the existing verification test command.`,
      `Verification Criteria:`,
      `- Verification test '${verificationCommand}' must pass with exit code ${task.failToPass.expectedPatchedExitCode}.`,
      `- Regression test '${regressionCommand}' must pass with exit code ${task.passToPass.expectedPatchedExitCode}.`,
    ].join("\n");

    const taskId = `task-${task.taskId}-${Date.now()}`;
    const runtimeTask = coordinator.createTask({
      taskId,
      title: task.title,
      description: taskDescription,
      inputPayload: {
        taskId: task.taskId,
        targetFile: task.targetFile,
        allowedPathPatterns: task.allowedPathPatterns,
        verificationCommand: task.failToPass.testCommand,
        regressionCommand: task.passToPass.testCommand,
        expectedPatchedExitCode: task.failToPass.expectedPatchedExitCode,
      },
    });

    const wsHandle = await workspaceAdapter.provisionWorkspace({
      workspaceId: `ws-${runtimeTask.taskId.slice(0, 8)}`,
      runId: `run-${runtimeTask.taskId.slice(0, 8)}`,
      taskId: runtimeTask.taskId,
      maxWorkspaceBytes: 100 * 1024 * 1024,
      maxFileSizeBytes: 10 * 1024 * 1024,
    });

    const committedFiles: MockRepoFile[] = Object.entries(task.initialFiles).map(
      ([relPath, content]) => ({ path: relPath, content })
    );

    const { commitSha } = await initCleanGitRepository(wsHandle.hostPath, committedFiles);

    // 7. Bind Clean-Room Verification Spec and Contract with verified commitSha
    const cleanRoomSpec: CleanRoomVerificationSpec = {
      specId: `spec-cleanroom-${task.taskId}`,
      baselineCommitSha: commitSha,
      failToPass: {
        testCommand: task.failToPass.testCommand,
        expectedBaselineExitCode: task.failToPass.expectedBaselineExitCode,
        expectedPatchedExitCode: task.failToPass.expectedPatchedExitCode,
        minTestCount: task.failToPass.minTestCount,
        suiteRanRegex: task.failToPass.suiteRanRegex,
      },
      passToPass: {
        testCommand: task.passToPass.testCommand,
        expectedBaselineExitCode: task.passToPass.expectedBaselineExitCode,
        expectedPatchedExitCode: task.passToPass.expectedPatchedExitCode,
        minTestCount: task.passToPass.minTestCount,
        suiteRanRegex: task.passToPass.suiteRanRegex,
      },
      allowedPathPatterns: task.allowedPathPatterns,
      timeoutMs: toolTimeoutMs,
    };

    const verificationSpec = createVerificationSpec({
      specId: cleanRoomSpec.specId,
      ruleKind: "CLEAN_ROOM_DUAL_GATE",
      expectedValue: cleanRoomSpec,
    });

    const policy = createExecutionPolicy({
      policyId: `policy-${task.taskId}`,
      allowedCapabilities: [
        "workspace.file.read",
        "workspace.file.write",
        "workspace.code.search",
        "git.read",
        "process.execute",
        "read_file",
        "write_file",
        "edit_file",
        "run_command",
        "git_status",
        "git_diff",
        "search_code",
      ],
      isolationRequirement: "ISOLATED",
      governedBenchmarkRepairMode:
        options.governedBenchmarkRepairMode ??
        this.defaultOptions?.governedBenchmarkRepairMode ??
        false,
      allowWholeFileReplacement:
        options.allowWholeFileReplacement ??
        this.defaultOptions?.allowWholeFileReplacement ??
        false,
    });

    const contract = createMissionContract({
      contractId: `contract-${task.taskId}`,
      version: 1,
      taskId: runtimeTask.taskId,
      policy,
      verificationSpecs: [verificationSpec],
      resourceLimits: createResourceLimits({
        timeoutMs: stepTimeoutMs * maxSteps,
        maxAttempts,
        maxOutputBytes: 1048576,
      }),
      credentialScopes: ["benchmark:pilot:scope"],
    });

    store.insertContract(contract);
    store.activateContract(contract.spec.contractId, contract.spec.version, clock.nowIso());

    // 8. Start Run and Claim Lease against the Activated Contract
    const { run } = coordinator.createRun({ taskId: runtimeTask.taskId });
    coordinator.queueRun(run.runId);
    const claimResult = coordinator.claimRun(run.runId, workerId, stepTimeoutMs * maxSteps);
    coordinator.startRun(run.runId, workerId, claimResult.lease.leaseId);

    let stepResult: StepControllerResult;
    let cleanRoomOutcome: CleanRoomVerificationOutcome | undefined;

    try {
      // 8. Execute Governed Step Loop
      stepResult = await stepController.runStepLoop({
        runId: run.runId,
        workerId,
        leaseId: claimResult.lease.leaseId,
        workspace: wsHandle,
        enableDynamicToolFiltering: options.enableDynamicToolFiltering ?? false,
        budget: {
          maxSteps,
          maxActions: maxSteps * 2,
          maxConsecutiveFailures: 3,
          maxProposalRejections: 3,
          maxWallClockMs: stepTimeoutMs * maxSteps,
        },
      });

      // 9. Inspect Clean-Room Verification Results from Durable Event Stream
      const runEvents = store.getEventsForRun(run.runId);
      const verificationEvent = runEvents.find(
        (e) => e.eventType === "verification.completed"
      );
      const cleanRoomResult =
        (verificationEvent?.payload as any)?.verificationResult ??
        (verificationEvent?.payload as any);
      cleanRoomOutcome = cleanRoomResult;

      const verified =
        stepResult.terminalReason === "COMPLETED" &&
        (cleanRoomResult?.status === "VERIFIED" || cleanRoomResult?.status === "PASSED");

      // 10. Record Authoritative Run Outcome
      let terminalStatus: "COMPLETED" | "FAILED" | "TIMED_OUT";
      if (verified) {
        terminalStatus = "COMPLETED";
        coordinator.completeRun(run.runId, workerId, claimResult.lease.leaseId, {
          success: true,
          terminalReason: stepResult.terminalReason,
        });
      } else if (cleanRoomResult && cleanRoomResult.status === "FAILED") {
        terminalStatus = "FAILED";
        coordinator.failRun(
          run.runId,
          {
            error: cleanRoomResult.message ?? "Verification failed",
            terminalReason: cleanRoomResult.reasonCode ?? stepResult.terminalReason,
          },
          workerId,
          claimResult.lease.leaseId
        );
      } else if (
        stepResult.terminalReason === "MAX_STEPS" ||
        stepResult.terminalReason === "MAX_WALL_CLOCK"
      ) {
        terminalStatus = "TIMED_OUT";
        coordinator.failRun(
          run.runId,
          {
            error: "Resource limit exhausted",
            terminalReason: stepResult.terminalReason,
          },
          workerId,
          claimResult.lease.leaseId
        );
      } else {
        terminalStatus = "FAILED";
        coordinator.failRun(
          run.runId,
          {
            error: "Task verification not achieved",
            terminalReason: stepResult.terminalReason,
          },
          workerId,
          claimResult.lease.leaseId
        );
      }

      // 11. Authoritative Evidence Export
      const rawBundle = EvidenceExporter.exportBundle(store, run.runId, {
        nowIso: clock.nowIso(),
      });

      // 12. 2-of-3 Threshold Signing
      const workerKeys =
        options.signingKeys?.workerKeys ?? EvidenceSigner.generateKeyPair();
      const supervisorKeys =
        options.signingKeys?.supervisorKeys ?? EvidenceSigner.generateKeyPair();

      const workerSig = EvidenceSigner.sign(
        rawBundle,
        workerKeys.privateKey,
        "key-worker-p43",
        { authorityId: "auth-worker-p43" }
      ).signature!;

      const supervisorSig = EvidenceSigner.sign(
        rawBundle,
        supervisorKeys.privateKey,
        "key-supervisor-p43",
        { authorityId: "auth-supervisor-p43" }
      ).signature!;

      const signedBundle: EvidenceBundle = {
        ...rawBundle,
        signatures: [workerSig, supervisorSig],
      };

      // 13. Independent Offline Auditor Verification
      const keyring = options.keyring ?? new TrustedKeyring();
      if (!options.keyring) {
        keyring.registerKey({
          authorityId: "auth-worker-p43",
          keyId: "key-worker-p43",
          role: "WORKER_PRODUCER",
          publicKey: workerKeys.publicKey,
          status: "TRUSTED",
        });
        keyring.registerKey({
          authorityId: "auth-supervisor-p43",
          keyId: "key-supervisor-p43",
          role: "SUPERVISOR",
          publicKey: supervisorKeys.publicKey,
          status: "TRUSTED",
        });
      }

      const bundleFilePath = path.join(tempDir, `evidence-${run.runId}.json`);
      await fs.writeFile(
        bundleFilePath,
        JSON.stringify(signedBundle, null, 2),
        "utf8"
      );

      const offlineAudit = await OfflineAuditor.verifyEvidence(bundleFilePath, {
        keyring,
        thresholdPolicy: { threshold: 2, totalAuthorities: 3 },
      });

      const durationMs = Date.now() - startTime;

      // 14. Assemble Diagnostics (Bounded, Redacted, Un-fabricated)
      const stepDiagnostics: Phase43StepDiagnostic[] = (stepResult.transcript ?? [])
        .slice(0, MAX_DIAGNOSTIC_ENTRIES)
        .map((entry, idx) => {
          const associatedCompletion = trackingProvider.rawCompletions[idx]?.rawOutput;
          const redactedInput =
            entry.inputPayload !== undefined
              ? redactSensitiveData(entry.inputPayload)
              : undefined;
          return {
            stepNumber: entry.stepNumber,
            timestamp: entry.timestamp,
            durationMs: entry.durationMs,
            ...(entry.finishReason !== undefined ? { finishReason: entry.finishReason } : {}),
            proposalValid: entry.proposalValid,
            ...(entry.proposalId !== undefined ? { proposalId: entry.proposalId } : {}),
            ...(entry.toolName !== undefined ? { toolName: entry.toolName } : {}),
            ...(redactedInput !== undefined ? { inputPayload: redactedInput } : {}),
            ...(entry.rationale !== undefined ? { rationale: entry.rationale } : {}),
            ...(entry.proposalRejectionReason !== undefined
              ? { rejectionReason: entry.proposalRejectionReason }
              : {}),
            ...(entry.proposalRejectionMessage !== undefined
              ? { rejectionMessage: entry.proposalRejectionMessage }
              : {}),
            ...(entry.actionId !== undefined ? { actionId: entry.actionId } : {}),
            ...(entry.actionStatus !== undefined ? { actionStatus: entry.actionStatus } : {}),
            ...(entry.actionError !== undefined ? { executionError: entry.actionError } : {}),
            ...(entry.progressAdvisory !== undefined
              ? { progressAdvisory: entry.progressAdvisory }
              : {}),
            ...(entry.eligibleTools !== undefined ? { eligibleTools: entry.eligibleTools } : {}),
            ...(entry.filteredTools !== undefined ? { filteredTools: entry.filteredTools } : {}),
            ...(associatedCompletion !== undefined ? { rawCompletion: associatedCompletion } : {}),
          };
        });

      const proposalRejections: Phase43ProposalRejectionDiagnostic[] = stepDiagnostics
        .filter((d) => !d.proposalValid || d.rejectionReason !== undefined)
        .map((d) => ({
          stepNumber: d.stepNumber,
          ...(d.proposalId !== undefined ? { proposalId: d.proposalId } : {}),
          ...(d.toolName !== undefined ? { toolName: d.toolName } : {}),
          ...(d.finishReason !== undefined ? { finishReason: d.finishReason } : {}),
          proposalValid: d.proposalValid,
          ...(d.rejectionReason !== undefined ? { rejectionReason: d.rejectionReason } : {}),
          ...(d.rejectionMessage !== undefined ? { rejectionMessage: d.rejectionMessage } : {}),
          ...(d.rawCompletion !== undefined ? { rawCompletion: d.rawCompletion } : {}),
        }));

      const diagnostics: Phase43TrialDiagnostics = {
        stepDiagnostics,
        proposalRejections,
        rawCompletions: trackingProvider.rawCompletions,
        ...(stepResult.postPassLatchSnapshot
          ? { postPassLatchSnapshot: stepResult.postPassLatchSnapshot }
          : {}),
      };

      return {
        runId: run.runId,
        taskId: task.taskId,
        model: options.model,
        verified,
        terminalStatus,
        terminalReason: stepResult.terminalReason,
        totalSteps: stepResult.totalSteps,
        totalActions: stepResult.totalActions,
        totalProposalRejections: stepResult.totalProposalRejections,
        durationMs,
        tokenMetrics: {
          promptTokens: trackingProvider.promptTokens,
          evalTokens: trackingProvider.evalTokens,
          totalTokens: trackingProvider.totalTokens,
          modelCalls: trackingProvider.calls,
          modelFailures: trackingProvider.failures,
        },
        cleanRoomOutcome,
        evidenceBundle: signedBundle,
        offlineAudit,
        workspaceHostPath: tempDir,
        diagnostics,
      };
    } finally {
      if (!options.retainWorkspace && !this.defaultOptions?.retainWorkspace) {
        try {
          await workspaceAdapter.disposeWorkspace(wsHandle.workspaceId);
        } catch {
          // Best effort
        }
        try {
          fsSync.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // Best effort
        }
      }
    }
  }
}
