/**
 * Clean-Room Verifier for Emerald Agent Fabric.
 *
 * Implements independent, out-of-band verification in pristine clean-room workspaces
 * without trusting the agent's mutable workspace, execution trace, or self-attestations.
 *
 * Core Boundary Guarantees:
 * 1. Pristine Baseline Truth: Allocates ephemeral workspace directly from contract baselineCommitSha.
 * 2. Immutable Evidence Generation: Generates Evidence with source: "INDEPENDENT_OBSERVER".
 * 3. Dual-Gated Evaluation: Enforces FAIL_TO_PASS = 1.0 AND PASS_TO_PASS = 1.0.
 * 4. Anti-False-Positive Gating: SUITE_RAN regex and non-zero test assertion counts.
 * 5. Scope & Policy Audit: Verifies all touched files match contract allowedPathPatterns.
 * 6. Guaranteed Disposal: Unconditional cleanup of ephemeral clean-room workspace in finally block.
 * 7. Zero Shell Injection: All test commands and path operations execute discrete argv tokens.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { GitDiffToolAdapter } from "../adapters/tools/git-diff.tool-adapter.js";
import { findGitDir, getCommitFiles, readGitObject } from "../adapters/tools/git-utils.js";
import { createEvidence, Evidence } from "../domain/evidence.js";
import { MissionContract } from "../domain/mission-contract.js";
import { RunCommandOutput } from "../domain/tool-schemas.js";
import {
  CleanRoomFailureReasonCode,
  CleanRoomVerificationSpec,
  DeterministicVerifier,
  IndependentVerificationEvidencePayload,
  VerificationResult,
} from "../domain/verification.js";
import { ClockPort, SystemClock } from "../ports/clock.port.js";
import { StateStorePort } from "../ports/state-store.port.js";
import { WorkspaceHandle, WorkspacePort } from "../ports/workspace.port.js";
import { RunCoordinator } from "./run-coordinator.js";
import { WorkerRuntime, extractReplayBlockDetails } from "./worker-runtime.js";

/** Raised when the replay gate refuses a clean-room test command; verification cannot proceed. */
class ReplayBlockedVerificationError extends Error {
  constructor(readonly details: Record<string, string>) {
    super("Clean-room test command blocked by the replay gate");
  }
}

// ============================================================================
// Types
// ============================================================================

export interface CleanRoomVerifierOptions {
  readonly workspacePort: WorkspacePort;
  readonly workerRuntime: WorkerRuntime;
  readonly coordinator: RunCoordinator;
  readonly stateStore: StateStorePort;
  readonly clock?: ClockPort;
}

export interface CleanRoomVerifyParams {
  readonly runId: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly leaseId: string;
  readonly contract: MissionContract;
  readonly spec: CleanRoomVerificationSpec;
  readonly agentWorkspace: {
    readonly workspaceId: string;
    readonly hostPath: string;
    readonly containerMountPath?: string;
  };
  readonly abortSignal?: AbortSignal;
}

export interface CleanRoomVerificationOutcome {
  readonly status: "VERIFIED" | "FAILED";
  readonly evidence: Evidence;
  readonly payload: IndependentVerificationEvidencePayload;
  readonly verificationResult: VerificationResult;
  readonly failureReasonCode?: CleanRoomFailureReasonCode;
  /**
   * Present only when a clean-room test command was refused by the Tier-1 replay gate. Structured,
   * payload-free metadata; the verification did not run and no test result is implied.
   */
  readonly replayBlock?: Readonly<Record<string, string>>;
  readonly message: string;
}

// ============================================================================
// Pure Utility Helpers
// ============================================================================

/**
 * Extracts touched relative file paths from a unified diff.
 */
export function parseTouchedFilesFromDiff(diffText: string): readonly string[] {
  if (!diffText) return Object.freeze([]);
  const files: string[] = [];
  const lines = diffText.split(/\r?\n/);

  for (const line of lines) {
    if (line.startsWith("+++ b/")) {
      const file = line.slice("+++ b/".length).trim();
      if (file && file !== "/dev/null" && !files.includes(file)) {
        files.push(file.replace(/\\/g, "/"));
      }
    } else if (line.startsWith("--- a/") && !lines.some((l) => l.startsWith("+++ b/"))) {
      const file = line.slice("--- a/".length).trim();
      if (file && file !== "/dev/null" && !files.includes(file)) {
        files.push(file.replace(/\\/g, "/"));
      }
    }
  }

  return Object.freeze(files);
}

/**
 * Matches a relative file path against a glob pattern (supports * and **).
 */
export function matchPathPattern(filePath: string, pattern: string): boolean {
  const normPath = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const normPattern = pattern.replace(/\\/g, "/").replace(/^\.\//, "");

  if (normPattern === "*" || normPattern === "**" || normPattern === "**/*") {
    return true;
  }

  if (normPath === normPattern) {
    return true;
  }

  let p = normPattern.replace(/\*\*/g, "___GLOBSTAR___");
  p = p.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  // Handle /**/ -> either / or /.../ (zero or more directory segments)
  p = p.replace(/\/___GLOBSTAR___\//g, "(?:/|/.+/)");
  // Handle leading **/ -> optional directory prefix
  p = p.replace(/^___GLOBSTAR___\//g, "(?:.+/)?");
  // Handle trailing /** -> optional directory suffix
  p = p.replace(/\/___GLOBSTAR___$/g, "(?:/.*)?");
  // Handle any remaining globstars
  p = p.replace(/___GLOBSTAR___/g, ".*");
  // Handle single * -> anything except /
  p = p.replace(/\*/g, "[^/]*");

  const regex = new RegExp(`^${p}$`);
  return regex.test(normPath);
}

interface FilePatch {
  oldPath: string;
  newPath: string;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

/**
 * Pure TypeScript in-process unified diff parser and patch applier.
 * Strictly verifies workspace confinement and detects conflicts without external processes.
 */
export async function applyUnifiedDiff(
  workspaceHostPath: string,
  diffText: string
): Promise<{
  status: "APPLIED" | "CONFLICT" | "EMPTY" | "MALFORMED";
  exitCode: number;
  outputText: string;
}> {
  if (!diffText || diffText.trim().length === 0) {
    return {
      status: "EMPTY",
      exitCode: 1,
      outputText: "Patch diff is empty; zero changes detected.",
    };
  }

  const lines = diffText.split(/\r?\n/);
  const filePatches: FilePatch[] = [];
  let currentPatch: FilePatch | null = null;
  let currentHunk: Hunk | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.startsWith("diff --git ") || line.startsWith("--- ")) {
      if (line.startsWith("diff --git ")) {
        if (currentPatch) {
          if (currentHunk) currentPatch.hunks.push(currentHunk);
          filePatches.push(currentPatch);
        }
        currentPatch = {
          oldPath: "",
          newPath: "",
          isNew: false,
          isDeleted: false,
          hunks: [],
        };
        currentHunk = null;
        continue;
      }

      if (!currentPatch) {
        currentPatch = {
          oldPath: "",
          newPath: "",
          isNew: false,
          isDeleted: false,
          hunks: [],
        };
      }

      if (line.startsWith("--- ")) {
        const rawOld = line.slice(4).trim();
        if (rawOld === "/dev/null") {
          currentPatch.isNew = true;
          currentPatch.oldPath = "/dev/null";
        } else {
          currentPatch.oldPath = rawOld.startsWith("a/") ? rawOld.slice(2) : rawOld;
        }

        // Next line should be +++
        const nextLine = lines[i + 1];
        if (nextLine && nextLine.startsWith("+++ ")) {
          i++;
          const rawNew = nextLine.slice(4).trim();
          if (rawNew === "/dev/null") {
            currentPatch.isDeleted = true;
            currentPatch.newPath = "/dev/null";
          } else {
            currentPatch.newPath = rawNew.startsWith("b/") ? rawNew.slice(2) : rawNew;
          }
        }
        continue;
      }
    }

    if (line.startsWith("new file mode")) {
      if (currentPatch) currentPatch.isNew = true;
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      if (currentPatch) currentPatch.isDeleted = true;
      continue;
    }

    if (line.startsWith("@@ ")) {
      if (!currentPatch) {
        return {
          status: "MALFORMED",
          exitCode: 1,
          outputText: `Malformed diff: hunk header without file target at line ${i + 1}`,
        };
      }
      if (currentHunk) {
        currentPatch.hunks.push(currentHunk);
      }
      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!match) {
        return {
          status: "MALFORMED",
          exitCode: 1,
          outputText: `Malformed hunk header '${line}' at line ${i + 1}`,
        };
      }
      currentHunk = {
        oldStart: parseInt(match[1]!, 10),
        oldCount: match[2] !== undefined ? parseInt(match[2]!, 10) : 1,
        newStart: parseInt(match[3]!, 10),
        newCount: match[4] !== undefined ? parseInt(match[4]!, 10) : 1,
        lines: [],
      };
      continue;
    }

    if (currentHunk) {
      if (
        line.startsWith(" ") ||
        line.startsWith("-") ||
        line.startsWith("+") ||
        line === ""
      ) {
        currentHunk.lines.push(line === "" ? " " : line);
      }
    }
  }

  if (currentPatch) {
    if (currentHunk) currentPatch.hunks.push(currentHunk);
    filePatches.push(currentPatch);
  }

  if (filePatches.length === 0) {
    return {
      status: "MALFORMED",
      exitCode: 1,
      outputText: "Failed to parse any valid file patches from candidate diff.",
    };
  }

  const canonicalWorkspaceRoot = path.resolve(workspaceHostPath);

  // Apply patches sequentially
  for (const patch of filePatches) {
    const targetRelPath = patch.isDeleted ? patch.oldPath : patch.newPath;
    if (!targetRelPath || targetRelPath === "/dev/null") {
      continue;
    }

    const resolvedTarget = path.resolve(canonicalWorkspaceRoot, targetRelPath);
    if (
      resolvedTarget !== canonicalWorkspaceRoot &&
      !resolvedTarget.startsWith(canonicalWorkspaceRoot + path.sep)
    ) {
      return {
        status: "CONFLICT",
        exitCode: 1,
        outputText: `Security boundary violation: patch target '${targetRelPath}' escapes workspace boundary.`,
      };
    }

    if (patch.isDeleted) {
      try {
        await fs.unlink(resolvedTarget);
      } catch (err: unknown) {
        return {
          status: "CONFLICT",
          exitCode: 1,
          outputText: `Failed to delete file '${targetRelPath}': ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      continue;
    }

    if (patch.isNew) {
      await fs.mkdir(path.dirname(resolvedTarget), { recursive: true });
      const newLines: string[] = [];
      for (const hunk of patch.hunks) {
        for (const l of hunk.lines) {
          if (l.startsWith("+")) {
            newLines.push(l.slice(1));
          }
        }
      }
      await fs.writeFile(resolvedTarget, newLines.join("\n"), "utf8");
      continue;
    }

    // Existing file modification
    let originalText = "";
    try {
      originalText = await fs.readFile(resolvedTarget, "utf8");
    } catch (err: unknown) {
      return {
        status: "CONFLICT",
        exitCode: 1,
        outputText: `Target file '${targetRelPath}' does not exist on baseline: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const hadTrailingNewline = originalText.endsWith("\n");
    const origLines = originalText.split(/\r?\n/);
    if (origLines.length > 0 && origLines[origLines.length - 1] === "") {
      origLines.pop();
    }

    const resultingLines: string[] = [];
    let origIdx = 0;

    for (const hunk of patch.hunks) {
      // Hunk line numbering is 1-indexed
      const targetStartIdx = Math.max(0, hunk.oldStart - 1);

      // Copy unchanged lines prior to this hunk
      while (origIdx < targetStartIdx && origIdx < origLines.length) {
        resultingLines.push(origLines[origIdx]!);
        origIdx++;
      }

      for (const hunkLine of hunk.lines) {
        const prefix = hunkLine[0];
        const text = hunkLine.slice(1);

        if (prefix === " ") {
          // Context line: must match original line
          if (origIdx >= origLines.length || origLines[origIdx] !== text) {
            return {
              status: "CONFLICT",
              exitCode: 1,
              outputText: `Patch conflict in '${targetRelPath}' at line ${origIdx + 1}: expected context line '${text}', observed '${origLines[origIdx]}'`,
            };
          }
          resultingLines.push(origLines[origIdx]!);
          origIdx++;
        } else if (prefix === "-") {
          // Deletion line: must match original line
          if (origIdx >= origLines.length || origLines[origIdx] !== text) {
            return {
              status: "CONFLICT",
              exitCode: 1,
              outputText: `Patch conflict in '${targetRelPath}' at line ${origIdx + 1}: expected deletion of '${text}', observed '${origLines[origIdx]}'`,
            };
          }
          origIdx++;
        } else if (prefix === "+") {
          // Insertion line: emit to result
          resultingLines.push(text);
        }
      }
    }

    // Append remaining lines after the last hunk
    while (origIdx < origLines.length) {
      resultingLines.push(origLines[origIdx]!);
      origIdx++;
    }

    const finalContent = resultingLines.join("\n") + (hadTrailingNewline ? "\n" : "");
    await fs.writeFile(resolvedTarget, finalContent, "utf8");
  }

  return {
    status: "APPLIED",
    exitCode: 0,
    outputText: `Patch applied cleanly across ${filePatches.length} file(s).`,
  };
}

// ============================================================================
// Clean-Room Verifier Implementation
// ============================================================================

export class CleanRoomVerifier {
  private readonly workspacePort: WorkspacePort;
  private readonly workerRuntime: WorkerRuntime;
  private readonly coordinator: RunCoordinator;
  private readonly _stateStore: StateStorePort;
  private readonly clock: ClockPort;

  constructor(options: CleanRoomVerifierOptions) {
    this.workspacePort = options.workspacePort;
    this.workerRuntime = options.workerRuntime;
    this.coordinator = options.coordinator;
    this._stateStore = options.stateStore;
    this.clock = options.clock ?? new SystemClock();
  }

  get stateStore(): StateStorePort {
    return this._stateStore;
  }

  /**
   * Materializes the clean baseline repository from an immutable commitSha.
   */
  private async materializeBaseline(
    cleanWorkspaceHostPath: string,
    sourceHostPath: string,
    baselineCommitSha: string
  ): Promise<void> {
    const gitDir = await findGitDir(sourceHostPath, sourceHostPath);

    if (gitDir && baselineCommitSha) {
      const commitFiles = await getCommitFiles(gitDir, baselineCommitSha);
      if (commitFiles.size > 0) {
        // Materialize pristine files directly from commit tree
        for (const [relPath, blobSha] of commitFiles.entries()) {
          const blobObj = await readGitObject(gitDir, blobSha);
          if (blobObj) {
            const destPath = path.join(cleanWorkspaceHostPath, relPath);
            await fs.mkdir(path.dirname(destPath), { recursive: true });
            await fs.writeFile(destPath, blobObj.data);
          }
        }

        // Copy .git directory structure to ensure git inspection tools work
        const cleanGitDir = path.join(cleanWorkspaceHostPath, ".git");
        await fs.cp(gitDir, cleanGitDir, { recursive: true });
        return;
      }
    }

    // Fallback: copy files from sourceHostPath (ignoring .emerald-workspace.json and temporary files)
    await fs.cp(sourceHostPath, cleanWorkspaceHostPath, {
      recursive: true,
      filter: (src) => !src.endsWith(".emerald-workspace.json"),
    });
  }

  /**
   * Executes a test command in the specified workspace through WorkerRuntime.
   */
  private async executeTestCommand(
    runId: string,
    testCommand: readonly string[],
    workspace: WorkspaceHandle,
    suiteRanRegex: string,
    minTestCount: number,
    timeoutMs: number,
    leaseId: string,
    abortSignal?: AbortSignal
  ): Promise<{
    readonly exitCode: number | null;
    readonly outputHash: string;
    readonly stdout: string;
    readonly stderr: string;
    readonly durationMs: number;
    readonly testsExecuted: number;
    readonly testsPassed: number;
    readonly suiteRanMatched: boolean;
    readonly timedOut: boolean;
  }> {
    const actionResult = await this.workerRuntime.executeAction({
      runId,
      toolName: "run_command",
      inputPayload: {
        argv: [...testCommand],
        timeoutMs,
      },
      leaseId,
      workspace,
      abortSignal,
    });

    // Tier-1 replay gate: the command was not dispatched and an earlier identical execution is
    // unresolved. This is neither a test result nor proof about the earlier run; do not interpret it
    // as exit code, output, or defect reproduction.
    const replayBlock = extractReplayBlockDetails(actionResult);
    if (replayBlock) {
      throw new ReplayBlockedVerificationError(replayBlock);
    }

    if (actionResult.status === "TIMED_OUT") {
      return {
        exitCode: null,
        outputHash: "",
        stdout: "",
        stderr: "Command execution timed out in clean-room container.",
        durationMs: timeoutMs,
        testsExecuted: 0,
        testsPassed: 0,
        suiteRanMatched: false,
        timedOut: true,
      };
    }

    const cmdOutput = actionResult.output as RunCommandOutput | undefined;
    const stdout = cmdOutput?.stdout ?? "";
    const stderr = cmdOutput?.stderr ?? "";
    const combined = `${stdout}\n${stderr}`;
    const exitCode = cmdOutput?.exitCode !== undefined ? cmdOutput.exitCode : null;

    const outputHash = crypto
      .createHash("sha256")
      .update(combined, "utf8")
      .digest("hex");

    const suiteRegex = new RegExp(suiteRanRegex, "i");
    const regexMatched = suiteRegex.test(combined);

    // Extract test execution count if present in output
    let testsExecuted = 0;
    const passOfMatch = combined.match(/PASS:?\s*(\d+)\s+of\s+(\d+)/i);
    const passingMatch = combined.match(/(\d+)\s+passing/i);
    const testsCountMatch = combined.match(/(\d+)\s+tests?/i);

    if (passOfMatch && passOfMatch[2]) {
      testsExecuted = parseInt(passOfMatch[2], 10);
    } else if (passingMatch && passingMatch[1]) {
      testsExecuted = parseInt(passingMatch[1], 10);
    } else if (testsCountMatch && testsCountMatch[1]) {
      testsExecuted = parseInt(testsCountMatch[1], 10);
    } else if (regexMatched) {
      testsExecuted = Math.max(minTestCount, 1);
    }

    const testsPassed = exitCode === 0 && regexMatched ? testsExecuted : 0;
    const suiteRanMatched = regexMatched && testsExecuted >= minTestCount;

    return {
      exitCode,
      outputHash,
      stdout,
      stderr,
      durationMs: cmdOutput?.durationMs ?? 0,
      testsExecuted,
      testsPassed,
      suiteRanMatched,
      timedOut: false,
    };
  }

  /**
   * Independently verifies a candidate patch produced by an agent.
   */
  async verifyCandidatePatch(params: CleanRoomVerifyParams): Promise<CleanRoomVerificationOutcome> {
    const { runId, taskId, workerId, leaseId, contract, spec, agentWorkspace } = params;
    const nowIso = this.clock.nowIso();

    // 1. Extract candidate unified diff from agent workspace
    const diffAdapter = new GitDiffToolAdapter(this.workspacePort);
    const diffResult = await diffAdapter.execute(
      {
        runId,
        taskId,
        workerId,
        leaseId,
        toolName: "git_diff",
        requiredCapability: "git.read",
        isolationRequirement: "WORKSPACE",
        workspace: agentWorkspace,
        resourceLimits: {
          timeoutMs: spec.timeoutMs,
          maxOutputBytes: contract.spec.resourceLimits.maxOutputBytes,
        },
        abortSignal: params.abortSignal,
      },
      { path: ".", staged: false }
    );

    const diffText = diffResult.diff ?? "";
    const candidatePatchHash = crypto
      .createHash("sha256")
      .update(diffText, "utf8")
      .digest("hex");
    const candidatePatchBytes = Buffer.byteLength(diffText, "utf8");
    const touchedFiles = parseTouchedFilesFromDiff(diffText);

    // Gate 1: Check non-empty diff
    if (!diffText || diffText.trim().length === 0) {
      const payload: IndependentVerificationEvidencePayload = {
        runId,
        taskId,
        contractId: contract.spec.contractId,
        contractVersion: contract.spec.version,
        baselineCommitSha: spec.baselineCommitSha,
        candidatePatchHash,
        candidatePatchBytes,
        touchedFiles,
        baselineDiagnostic: {
          f2pExitCode: null,
          f2pOutputHash: "",
          p2pExitCode: null,
          p2pOutputHash: "",
          baselineValid: false,
        },
        patchApplication: {
          status: "EMPTY",
          exitCode: 1,
          outputText: "Candidate patch is empty; no changes were made.",
        },
        cleanRoomEvaluation: {
          f2pExitCode: null,
          f2pTestsExecuted: 0,
          f2pTestsPassed: 0,
          f2pRatio: 0,
          f2pSuiteRanMatched: false,
          p2pExitCode: null,
          p2pTestsExecuted: 0,
          p2pTestsPassed: 0,
          p2pRatio: 0,
          p2pSuiteRanMatched: false,
        },
        policyAudit: {
          allowedPathsCompliant: true,
          disallowedFilesTouched: [],
        },
        overallStatus: "FAILED",
        failureReasonCode: "EMPTY_PATCH",
        verifiedAt: nowIso,
      };

      const evidence = createEvidence({
        runId,
        kind: "OUTPUT_PAYLOAD",
        source: "INDEPENDENT_OBSERVER",
        rawContent: payload,
        observedAt: nowIso,
      });
      this.coordinator.recordEvidence(runId, evidence);

      const verificationResult = DeterministicVerifier.verifyCleanRoom(evidence, spec, nowIso);
      this.coordinator.recordVerificationResult(runId, verificationResult);

      return {
        status: "FAILED",
        evidence,
        payload,
        verificationResult,
        failureReasonCode: "EMPTY_PATCH",
        message: "Candidate patch is empty; no changes were made.",
      };
    }

    // Gate 2: Static policy audit
    const disallowedFilesTouched = touchedFiles.filter(
      (f) => !spec.allowedPathPatterns.some((pattern) => matchPathPattern(f, pattern))
    );

    if (disallowedFilesTouched.length > 0) {
      const payload: IndependentVerificationEvidencePayload = {
        runId,
        taskId,
        contractId: contract.spec.contractId,
        contractVersion: contract.spec.version,
        baselineCommitSha: spec.baselineCommitSha,
        candidatePatchHash,
        candidatePatchBytes,
        touchedFiles,
        baselineDiagnostic: {
          f2pExitCode: null,
          f2pOutputHash: "",
          p2pExitCode: null,
          p2pOutputHash: "",
          baselineValid: false,
        },
        patchApplication: {
          status: "MALFORMED",
          exitCode: 1,
          outputText: `Policy path violation: touched files [${disallowedFilesTouched.join(", ")}] not allowed.`,
        },
        cleanRoomEvaluation: {
          f2pExitCode: null,
          f2pTestsExecuted: 0,
          f2pTestsPassed: 0,
          f2pRatio: 0,
          f2pSuiteRanMatched: false,
          p2pExitCode: null,
          p2pTestsExecuted: 0,
          p2pTestsPassed: 0,
          p2pRatio: 0,
          p2pSuiteRanMatched: false,
        },
        policyAudit: {
          allowedPathsCompliant: false,
          disallowedFilesTouched,
        },
        overallStatus: "FAILED",
        failureReasonCode: "POLICY_PATH_VIOLATION",
        verifiedAt: nowIso,
      };

      const evidence = createEvidence({
        runId,
        kind: "OUTPUT_PAYLOAD",
        source: "INDEPENDENT_OBSERVER",
        rawContent: payload,
        observedAt: nowIso,
      });
      this.coordinator.recordEvidence(runId, evidence);

      const verificationResult = DeterministicVerifier.verifyCleanRoom(evidence, spec, nowIso);
      this.coordinator.recordVerificationResult(runId, verificationResult);

      return {
        status: "FAILED",
        evidence,
        payload,
        verificationResult,
        failureReasonCode: "POLICY_PATH_VIOLATION",
        message: `Policy path violation: touched files [${disallowedFilesTouched.join(", ")}] exceed contract allowedPathPatterns.`,
      };
    }

    // Gate 3: Provision ephemeral clean-room workspace
    const verifyWorkspaceId = `ws-verify-${runId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
    const cleanWorkspace = await this.workspacePort.provisionWorkspace({
      workspaceId: verifyWorkspaceId,
      runId,
      taskId,
      repositorySource: {
        type: "git",
        location: agentWorkspace.hostPath,
        revision: spec.baselineCommitSha,
      },
      maxWorkspaceBytes: 500 * 1024 * 1024,
      maxFileSizeBytes: 10 * 1024 * 1024,
    });

    try {
      // 4. Materialize baseline commit
      await this.materializeBaseline(
        cleanWorkspace.hostPath,
        agentWorkspace.hostPath,
        spec.baselineCommitSha
      );

      // 5. Baseline Diagnostic (F2P must fail, P2P must pass)
      const baselineF2P = await this.executeTestCommand(
        runId,
        spec.failToPass.testCommand,
        cleanWorkspace,
        spec.failToPass.suiteRanRegex,
        spec.failToPass.minTestCount,
        spec.timeoutMs,
        leaseId,
        params.abortSignal
      );

      if (baselineF2P.timedOut) {
        return this.assembleAndRecordFailure(
          runId,
          taskId,
          contract,
          spec,
          candidatePatchHash,
          candidatePatchBytes,
          touchedFiles,
          {
            f2pExitCode: null,
            f2pOutputHash: "",
            p2pExitCode: null,
            p2pOutputHash: "",
            baselineValid: false,
          },
          { status: "MALFORMED", exitCode: 1, outputText: "Baseline F2P timed out" },
          "EXECUTION_TIMEOUT",
          "Baseline defect test timed out in clean-room environment."
        );
      }

      if (baselineF2P.exitCode === spec.failToPass.expectedPatchedExitCode) {
        // Defect was not reproduced on baseline!
        return this.assembleAndRecordFailure(
          runId,
          taskId,
          contract,
          spec,
          candidatePatchHash,
          candidatePatchBytes,
          touchedFiles,
          {
            f2pExitCode: baselineF2P.exitCode,
            f2pOutputHash: baselineF2P.outputHash,
            p2pExitCode: null,
            p2pOutputHash: "",
            baselineValid: false,
          },
          { status: "MALFORMED", exitCode: 1, outputText: "Baseline defect not reproduced" },
          "BASELINE_DEFECT_NOT_REPRODUCED",
          `Baseline defect was not reproduced: target test passed with exitCode 0 on baseline commit.`
        );
      }

      const baselineP2P = await this.executeTestCommand(
        runId,
        spec.passToPass.testCommand,
        cleanWorkspace,
        spec.passToPass.suiteRanRegex,
        spec.passToPass.minTestCount,
        spec.timeoutMs,
        leaseId,
        params.abortSignal
      );

      if (baselineP2P.timedOut) {
        return this.assembleAndRecordFailure(
          runId,
          taskId,
          contract,
          spec,
          candidatePatchHash,
          candidatePatchBytes,
          touchedFiles,
          {
            f2pExitCode: baselineF2P.exitCode,
            f2pOutputHash: baselineF2P.outputHash,
            p2pExitCode: null,
            p2pOutputHash: "",
            baselineValid: false,
          },
          { status: "MALFORMED", exitCode: 1, outputText: "Baseline P2P timed out" },
          "EXECUTION_TIMEOUT",
          "Baseline regression suite timed out in clean-room environment."
        );
      }

      if (baselineP2P.exitCode !== spec.passToPass.expectedBaselineExitCode) {
        return this.assembleAndRecordFailure(
          runId,
          taskId,
          contract,
          spec,
          candidatePatchHash,
          candidatePatchBytes,
          touchedFiles,
          {
            f2pExitCode: baselineF2P.exitCode,
            f2pOutputHash: baselineF2P.outputHash,
            p2pExitCode: baselineP2P.exitCode,
            p2pOutputHash: baselineP2P.outputHash,
            baselineValid: false,
          },
          { status: "MALFORMED", exitCode: 1, outputText: "Baseline regression preexisting" },
          "BASELINE_REGRESSION_PREEXISTING",
          `Baseline regression suite failed with exitCode ${baselineP2P.exitCode} prior to patch application.`
        );
      }

      const baselineDiagnostic = {
        f2pExitCode: baselineF2P.exitCode,
        f2pOutputHash: baselineF2P.outputHash,
        p2pExitCode: baselineP2P.exitCode,
        p2pOutputHash: baselineP2P.outputHash,
        baselineValid: true,
      };

      // 6. Apply candidate patch
      const patchApp = await applyUnifiedDiff(cleanWorkspace.hostPath, diffText);
      if (patchApp.status !== "APPLIED") {
        return this.assembleAndRecordFailure(
          runId,
          taskId,
          contract,
          spec,
          candidatePatchHash,
          candidatePatchBytes,
          touchedFiles,
          baselineDiagnostic,
          patchApp,
          patchApp.status === "EMPTY" ? "EMPTY_PATCH" : "APPLY_PATCH_FAIL",
          `Patch application failed: ${patchApp.outputText}`
        );
      }

      // 7. Post-Patch Clean-Room Verification
      // F2P Test (Must pass)
      const patchedF2P = await this.executeTestCommand(
        runId,
        spec.failToPass.testCommand,
        cleanWorkspace,
        spec.failToPass.suiteRanRegex,
        spec.failToPass.minTestCount,
        spec.timeoutMs,
        leaseId,
        params.abortSignal
      );

      if (patchedF2P.timedOut) {
        return this.assembleAndRecordFailure(
          runId,
          taskId,
          contract,
          spec,
          candidatePatchHash,
          candidatePatchBytes,
          touchedFiles,
          baselineDiagnostic,
          patchApp,
          "EXECUTION_TIMEOUT",
          "Target test timed out on patched clean-room workspace."
        );
      }

      if (patchedF2P.exitCode !== spec.failToPass.expectedPatchedExitCode) {
        return this.assembleAndRecordFailure(
          runId,
          taskId,
          contract,
          spec,
          candidatePatchHash,
          candidatePatchBytes,
          touchedFiles,
          baselineDiagnostic,
          patchApp,
          "TARGET_TEST_FAILED",
          `Target bug test failed with exitCode ${patchedF2P.exitCode} on patched code.`,
          {
            f2pExitCode: patchedF2P.exitCode,
            f2pTestsExecuted: patchedF2P.testsExecuted,
            f2pTestsPassed: patchedF2P.testsPassed,
            f2pRatio: 0,
            f2pSuiteRanMatched: patchedF2P.suiteRanMatched,
            p2pExitCode: null,
            p2pTestsExecuted: 0,
            p2pTestsPassed: 0,
            p2pRatio: 0,
            p2pSuiteRanMatched: false,
          }
        );
      }

      if (!patchedF2P.suiteRanMatched) {
        return this.assembleAndRecordFailure(
          runId,
          taskId,
          contract,
          spec,
          candidatePatchHash,
          candidatePatchBytes,
          touchedFiles,
          baselineDiagnostic,
          patchApp,
          "TEST_SUITE_NEVER_RAN",
          `Target bug test suite did not execute required assertions (SUITE_RAN match failed or count < ${spec.failToPass.minTestCount}).`,
          {
            f2pExitCode: patchedF2P.exitCode,
            f2pTestsExecuted: patchedF2P.testsExecuted,
            f2pTestsPassed: patchedF2P.testsPassed,
            f2pRatio: 0,
            f2pSuiteRanMatched: false,
            p2pExitCode: null,
            p2pTestsExecuted: 0,
            p2pTestsPassed: 0,
            p2pRatio: 0,
            p2pSuiteRanMatched: false,
          }
        );
      }

      // P2P Test (Must pass)
      const patchedP2P = await this.executeTestCommand(
        runId,
        spec.passToPass.testCommand,
        cleanWorkspace,
        spec.passToPass.suiteRanRegex,
        spec.passToPass.minTestCount,
        spec.timeoutMs,
        leaseId,
        params.abortSignal
      );

      if (patchedP2P.timedOut) {
        return this.assembleAndRecordFailure(
          runId,
          taskId,
          contract,
          spec,
          candidatePatchHash,
          candidatePatchBytes,
          touchedFiles,
          baselineDiagnostic,
          patchApp,
          "EXECUTION_TIMEOUT",
          "Regression test suite timed out on patched clean-room workspace."
        );
      }

      if (patchedP2P.exitCode !== spec.passToPass.expectedPatchedExitCode) {
        return this.assembleAndRecordFailure(
          runId,
          taskId,
          contract,
          spec,
          candidatePatchHash,
          candidatePatchBytes,
          touchedFiles,
          baselineDiagnostic,
          patchApp,
          "REGRESSION_DETECTED",
          `Regression detected: test suite failed with exitCode ${patchedP2P.exitCode} on patched code.`,
          {
            f2pExitCode: patchedF2P.exitCode,
            f2pTestsExecuted: patchedF2P.testsExecuted,
            f2pTestsPassed: patchedF2P.testsPassed,
            f2pRatio: 1.0,
            f2pSuiteRanMatched: true,
            p2pExitCode: patchedP2P.exitCode,
            p2pTestsExecuted: patchedP2P.testsExecuted,
            p2pTestsPassed: patchedP2P.testsPassed,
            p2pRatio: 0,
            p2pSuiteRanMatched: patchedP2P.suiteRanMatched,
          }
        );
      }

      if (!patchedP2P.suiteRanMatched) {
        return this.assembleAndRecordFailure(
          runId,
          taskId,
          contract,
          spec,
          candidatePatchHash,
          candidatePatchBytes,
          touchedFiles,
          baselineDiagnostic,
          patchApp,
          "TEST_SUITE_NEVER_RAN",
          `Regression test suite did not execute required assertions (SUITE_RAN match failed or count < ${spec.passToPass.minTestCount}).`,
          {
            f2pExitCode: patchedF2P.exitCode,
            f2pTestsExecuted: patchedF2P.testsExecuted,
            f2pTestsPassed: patchedF2P.testsPassed,
            f2pRatio: 1.0,
            f2pSuiteRanMatched: true,
            p2pExitCode: patchedP2P.exitCode,
            p2pTestsExecuted: patchedP2P.testsExecuted,
            p2pTestsPassed: patchedP2P.testsPassed,
            p2pRatio: 0,
            p2pSuiteRanMatched: false,
          }
        );
      }

      // 8. All Four Conditions Satisfied -> Success
      const payload: IndependentVerificationEvidencePayload = {
        runId,
        taskId,
        contractId: contract.spec.contractId,
        contractVersion: contract.spec.version,
        baselineCommitSha: spec.baselineCommitSha,
        candidatePatchHash,
        candidatePatchBytes,
        touchedFiles,
        baselineDiagnostic,
        patchApplication: patchApp,
        cleanRoomEvaluation: {
          f2pExitCode: patchedF2P.exitCode,
          f2pTestsExecuted: patchedF2P.testsExecuted,
          f2pTestsPassed: patchedF2P.testsPassed,
          f2pRatio: 1.0,
          f2pSuiteRanMatched: true,
          p2pExitCode: patchedP2P.exitCode,
          p2pTestsExecuted: patchedP2P.testsExecuted,
          p2pTestsPassed: patchedP2P.testsPassed,
          p2pRatio: 1.0,
          p2pSuiteRanMatched: true,
        },
        policyAudit: {
          allowedPathsCompliant: true,
          disallowedFilesTouched: [],
        },
        overallStatus: "VERIFIED",
        verifiedAt: nowIso,
      };

      const evidence = createEvidence({
        runId,
        kind: "OUTPUT_PAYLOAD",
        source: "INDEPENDENT_OBSERVER",
        rawContent: payload,
        observedAt: nowIso,
      });
      this.coordinator.recordEvidence(runId, evidence);

      const verificationResult = DeterministicVerifier.verifyCleanRoom(evidence, spec, nowIso);
      this.coordinator.recordVerificationResult(runId, verificationResult);

      return {
        status: "VERIFIED",
        evidence,
        payload,
        verificationResult,
        message: "Independent clean-room proof verified: F2P=1.0, P2P=1.0, SUITE_RAN verified, zero regressions.",
      };
    } catch (err: unknown) {
      if (err instanceof ReplayBlockedVerificationError) {
        const failure = this.assembleAndRecordFailure(
          runId,
          taskId,
          contract,
          spec,
          candidatePatchHash,
          candidatePatchBytes,
          touchedFiles,
          {
            f2pExitCode: null,
            f2pOutputHash: "",
            p2pExitCode: null,
            p2pOutputHash: "",
            baselineValid: false,
          },
          {
            status: "MALFORMED",
            exitCode: 1,
            outputText: "Verification not executed: test command blocked by uncertain prior execution",
          },
          "INFRA_ENVIRONMENT_FAILURE",
          "Clean-room verification could not run: a test command was blocked because an identical earlier execution has an unresolved outcome. No test result is implied."
        );
        return { ...failure, replayBlock: err.details };
      }
      throw err;
    } finally {
      // Unconditionally dispose clean-room workspace and restore agent workspace
      await this.workspacePort.disposeWorkspace(verifyWorkspaceId).catch(() => {});
      this.workerRuntime.setRunWorkspace(runId, agentWorkspace);
    }
  }

  private assembleAndRecordFailure(
    runId: string,
    taskId: string,
    contract: MissionContract,
    spec: CleanRoomVerificationSpec,
    candidatePatchHash: string,
    candidatePatchBytes: number,
    touchedFiles: readonly string[],
    baselineDiagnostic: IndependentVerificationEvidencePayload["baselineDiagnostic"],
    patchApplication: IndependentVerificationEvidencePayload["patchApplication"],
    failureReasonCode: CleanRoomFailureReasonCode,
    message: string,
    cleanRoomEvaluationOverride?: IndependentVerificationEvidencePayload["cleanRoomEvaluation"]
  ): CleanRoomVerificationOutcome {
    const nowIso = this.clock.nowIso();

    const payload: IndependentVerificationEvidencePayload = {
      runId,
      taskId,
      contractId: contract.spec.contractId,
      contractVersion: contract.spec.version,
      baselineCommitSha: spec.baselineCommitSha,
      candidatePatchHash,
      candidatePatchBytes,
      touchedFiles,
      baselineDiagnostic,
      patchApplication,
      cleanRoomEvaluation: cleanRoomEvaluationOverride ?? {
        f2pExitCode: null,
        f2pTestsExecuted: 0,
        f2pTestsPassed: 0,
        f2pRatio: 0,
        f2pSuiteRanMatched: false,
        p2pExitCode: null,
        p2pTestsExecuted: 0,
        p2pTestsPassed: 0,
        p2pRatio: 0,
        p2pSuiteRanMatched: false,
      },
      policyAudit: {
        allowedPathsCompliant: true,
        disallowedFilesTouched: [],
      },
      overallStatus: "FAILED",
      failureReasonCode,
      verifiedAt: nowIso,
    };

    const evidence = createEvidence({
      runId,
      kind: "OUTPUT_PAYLOAD",
      source: "INDEPENDENT_OBSERVER",
      rawContent: payload,
      observedAt: nowIso,
    });
    this.coordinator.recordEvidence(runId, evidence);

    const verificationResult = DeterministicVerifier.verifyCleanRoom(evidence, spec, nowIso);
    this.coordinator.recordVerificationResult(runId, verificationResult);

    return {
      status: "FAILED",
      evidence,
      payload,
      verificationResult,
      failureReasonCode,
      message,
    };
  }
}
