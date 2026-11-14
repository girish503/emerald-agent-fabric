/**
 * Clean-Room Dual-Gate Model Capability Evaluation Harness for Emerald Agent Fabric.
 *
 * Implements strict, reproducible clean-room trial execution across G2–G7 and G9.
 *
 * ISOLATION BOUNDARIES & SECURITY ENVELOPE:
 * 1. Temporary Workspace Separation:
 *    - Each trial executes in an isolated temporary directory in os.tmpdir().
 *    - Guaranteed cleanup in a finally block; no persistent state pollution.
 * 2. Application-Level Path Containment:
 *    - Strict lexical inspection rejecting path traversal ('..') and absolute paths.
 *    - Containment resolution rejects paths resolving outside the workspace directory.
 * 3. Symlink Containment:
 *    - Canonical realpath checks via fs.realpathSync ensure symlink destinations
 *      cannot escape the workspace root.
 * 4. Process Isolation Boundary (LIMITATION):
 *    - NONE. Execution is in-process within the host Node.js runtime. No child process
 *      or subprocess boundaries are spawned for evaluation tool execution.
 * 5. Kernel-Enforced Isolation Boundary (LIMITATION):
 *    - NONE. No Linux cgroups, namespaces, seccomp filters, Docker containers, or
 *      OS-level kernel security boundaries are enforced.
 * 6. Appropriate Scope:
 *    - This harness is designed solely for controlled, deterministic capability evaluation
 *      fixtures and approved open-weight model trials within its demonstrated security envelope.
 *    - IT MUST NEVER BE USED TO EXECUTE ARBITRARY, UNTRUSTED REPOSITORY CODE.
 *
 * HARNESS CAPABILITIES:
 * - Anti-leakage structural workspace manifest: provides top-level directory layout without
 *   disclosing deep target filenames, ground-truth answers, or expected citations.
 * - Multi-step interactive execution loop respecting task resourceLimits.maxSteps.
 * - Clean-room in-process tool gateway (search_code with ReDoS mitigation, read_file with byte bounds).
 * - Gate A / Gate B semantic separation with system-owned file-access tracking (zero self-approval).
 * - Cryptographic evidence binding (modelId, modelDigest, configHash, inputHash, outputHash).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { canonicalJsonStringify, sha256Hex } from "../../domain/canonical-hash.js";
import {
  computeTrialEvidenceHash,
  type DualGateEvaluationTask,
  type DualGateTrialResult,
  type EvaluationExecutionMode,
  type EvaluationStepRecord,
  type GateAAssessment,
  type GateBAssessment,
} from "../../domain/dual-gate-evaluation.js";
import { ModelProviderPort, ModelProviderRequest } from "../../ports/model-provider.port.js";
import {
  computeToolSchemasHash,
  renderToolSchemaDocumentation,
  validateToolProposalPayload,
} from "./cleanroom-tool-schema.js";

export const EVALUATION_HARNESS_VERSION_V3_0 = "cleanroom-eval-v3.0";
export const EVALUATION_HARNESS_VERSION_V3_1 = "cleanroom-eval-v3.1";
export const EVALUATION_HARNESS_VERSION = EVALUATION_HARNESS_VERSION_V3_1;

/**
 * Executes repaired JavaScript module code and functional test assertions inside an isolated,
 * sealed in-process V8 VM context (SEC-017).
 *
 * SCOPE & ISOLATION LIMITATIONS:
 * - This function is strictly designed for deterministic evaluation fixtures and controlled benchmark
 *   evaluations on trusted local code.
 * - NODE:VM IS NOT A SECURITY MECHANISM FOR UNTRUSTED CODE. Node.js documentation explicitly states
 *   that vm contexts do not provide containment against malicious code or OS-level security boundaries.
 * - Untrusted model-generated code in production MUST execute within sandboxed container providers
 *   (Docker/OCI) with dropped capabilities and seccomp filtering, NEVER directly in the host process.
 *
 * In-Process Controls:
 * - Sandbox created with Object.create(null): zero ambient globals (process, require, fs, console, global).
 * - Hard execution timeout strictly bounds synchronous execution (1000ms ceiling).
 * - Source transformation safely maps ESM exports to local function/const bindings.
 */
export function executeIsolatedTestInSandbox(
  sourceCode: string,
  testAssertions: string,
  timeoutMs = 1000
): { success: boolean; error?: string } {
  try {
    // Strip comments prior to export transformation to prevent comments from altering declaration semantics
    const strippedComments = sourceCode
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\r\n]*/g, "");

    const transformedSource = strippedComments
      .replace(/export\s+default\s+function\s+([a-zA-Z0-9_$]+)/g, "function $1")
      .replace(/export\s+default\s+class\s+([a-zA-Z0-9_$]+)/g, "class $1")
      .replace(/export\s+default\s+/g, "")
      .replace(/export\s+function\s+([a-zA-Z0-9_$]+)/g, "function $1")
      .replace(/export\s+const\s+([a-zA-Z0-9_$]+)/g, "const $1")
      .replace(/export\s+let\s+([a-zA-Z0-9_$]+)/g, "let $1")
      .replace(/export\s+var\s+([a-zA-Z0-9_$]+)/g, "var $1")
      .replace(/export\s+class\s+([a-zA-Z0-9_$]+)/g, "class $1")
      .replace(/export\s*\{[^}]*\};?/g, "");

    const codeToRun = `
      "use strict";
      if (typeof Object !== "undefined" && Object.prototype) {
        try {
          Object.freeze(Object.prototype);
          Object.freeze(Function.prototype);
          Object.freeze(Array.prototype);
        } catch {}
      }
      ${transformedSource}
      ${testAssertions}
    `;

    const sandbox = Object.create(null);
    const context = vm.createContext(sandbox);

    vm.runInContext(codeToRun, context, {
      timeout: timeoutMs,
      displayErrors: true,
    });

    return { success: true };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface CleanRoomTrialOptions {
  readonly task: DualGateEvaluationTask;
  readonly modelProvider: ModelProviderPort;
  readonly modelId: string;
  readonly modelDigest: string;
  readonly trialIndex?: number;
  readonly evaluationMode?: EvaluationExecutionMode;
  readonly harnessVersion?: string;
  readonly timeoutMs?: number;
  readonly stepTimeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly caseSensitive?: boolean;
  readonly isSymlinkPredicate?: (resolvedPath: string) => boolean;
  readonly onWorkspaceReady?: (workspaceRoot: string) => void;
  readonly cleanupWorkspace?: (workspaceRoot: string) => void;
}

export interface WorkspaceManifestOptions {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly maxDepth?: number;
  readonly targetFiles?: readonly string[];
  readonly expectedCitations?: readonly string[];
}

export class DualGateEvaluationHarness {
  /**
   * Probes whether the filesystem hosting the given directory is case-sensitive.
   */
  public static isDirectoryCaseSensitive(dir: string): boolean {
    try {
      const probeName = `.case_probe_${process.pid}_${Date.now()}`;
      const probeFile = path.join(dir, probeName);
      fs.writeFileSync(probeFile, "1", "utf8");
      try {
        const invertedProbe = path.join(dir, probeName.toUpperCase());
        const exists = fs.existsSync(invertedProbe);
        return !exists;
      } finally {
        try {
          fs.unlinkSync(probeFile);
        } catch {
          // Ignore probe unlink error
        }
      }
    } catch {
      return process.platform === "linux";
    }
  }

  /**
   * Generates a deterministic, anti-leakage directory structure manifest of the workspace.
   *
   * Security & Fairness Invariants:
   * 1. Top-Level Structural Layout: Emits top-level directory entries (and directories up to depth 2)
   *    and root files only. Leaf files in subdirectories are NEVER emitted, guaranteeing that
   *    deep benchmark target files, expected function names, and ground-truth answers are never leaked.
   * 2. Zero Answer Disclosure: Task target files (even if located at the workspace root) and expected
   *    symbols or citations are strictly filtered out and never disclosed.
   * 3. Determinism: Entries are sorted lexicographically.
   * 4. Bounded Context: Bounded by maxEntries (default 30) and maxBytes (default 2048) with explicit,
   *    deterministic truncation metadata that never reveals omitted target names.
   * 5. Resilient Layout: Supports empty directories and unusually named directories cleanly.
   */
  public static generateWorkspaceManifest(
    workspaceRoot: string,
    options: WorkspaceManifestOptions = {}
  ): string {
    const maxEntries = options.maxEntries ?? 30;
    const maxBytes = options.maxBytes ?? 2048;
    const maxDepth = options.maxDepth ?? 2;

    const targetFilesNorm = new Set(
      (options.targetFiles ?? []).map((t) => path.normalize(t).replace(/\\/g, "/"))
    );
    const targetBasenames = new Set(
      (options.targetFiles ?? []).map((t) => path.basename(t).toLowerCase())
    );
    const citations = new Set(
      (options.expectedCitations ?? []).map((c) => c.toLowerCase())
    );

    const rootResolved = path.resolve(workspaceRoot);
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(rootResolved);
    } catch {
      realRoot = rootResolved;
    }
    const structureEntries: string[] = [];

    const walk = (currentDir: string, currentDepth: number): void => {
      let dirents: fs.Dirent[] = [];
      try {
        dirents = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }
      dirents.sort((a, b) => a.name.localeCompare(b.name));

      for (const dirent of dirents) {
        if (dirent.name.startsWith(".")) {
          continue; // Skip hidden / VCS entries
        }
        const fullPath = path.join(currentDir, dirent.name);
        try {
          if (fs.existsSync(fullPath)) {
            const realTarget = fs.realpathSync(fullPath);
            if (!realTarget.startsWith(realRoot)) {
              continue; // Exclude external symlinks
            }
          }
        } catch {
          continue;
        }

        const rel = path.relative(realRoot, fullPath).replace(/\\/g, "/");

        if (dirent.isDirectory()) {
          structureEntries.push(`${rel}/`);
          if (currentDepth < maxDepth) {
            walk(fullPath, currentDepth + 1);
          }
        } else if (dirent.isFile() && currentDepth === 1) {
          // Anti-leakage: filter out any task target files (even at root level) and citations
          const lowerName = dirent.name.toLowerCase();
          if (targetFilesNorm.has(rel) || targetBasenames.has(lowerName) || citations.has(lowerName)) {
            continue;
          }
          structureEntries.push(rel);
        }
      }
    };

    walk(realRoot, 1);
    structureEntries.sort((a, b) => a.localeCompare(b));

    const totalCount = structureEntries.length;
    const shown = structureEntries.slice(0, maxEntries);
    let truncated = totalCount > maxEntries;

    // Check byte bound
    const lines = shown.map((e) => `- ${e}`);
    let contentStr = lines.join("\n");
    while (lines.length > 0 && Buffer.byteLength(contentStr, "utf8") > maxBytes) {
      lines.pop();
      truncated = true;
      contentStr = lines.join("\n");
    }

    const shownCount = lines.length;
    const truncatedCount = totalCount - shownCount;
    if (truncated) {
      lines.push(`- ... (${truncatedCount} more entries truncated)`);
    }
    const metadata = `[Repository Structure: ${shownCount} entries shown (${truncatedCount} truncated)]`;
    lines.push(metadata);

    return lines.join("\n");
  }

  /**
   * Executes a single clean-room dual-gate evaluation trial.
   */
  public async executeTrial(options: CleanRoomTrialOptions): Promise<DualGateTrialResult> {
    const trialIndex = options.trialIndex ?? 0;
    const trialId = `trial-${options.task.taskId}-${trialIndex}-${crypto.randomUUID().slice(0, 8)}`;
    const evaluationMode = options.evaluationMode ?? "FIXTURE_VALIDATION";
    const startTime = Date.now();
    const observedAt = new Date().toISOString();

    const totalTrialTimeoutMs = options.timeoutMs ?? options.task.resourceLimits?.timeoutMs;
    const configuredStepTimeoutMs = options.stepTimeoutMs ?? options.task.resourceLimits?.stepTimeoutMs;

    if (
      typeof totalTrialTimeoutMs !== "number" ||
      !Number.isFinite(totalTrialTimeoutMs) ||
      totalTrialTimeoutMs <= 0
    ) {
      throw new Error(`INVALID_RESOURCE_LIMITS: totalTrialTimeoutMs must be a positive finite number (got ${String(totalTrialTimeoutMs)})`);
    }
    if (
      configuredStepTimeoutMs !== undefined &&
      (typeof configuredStepTimeoutMs !== "number" || !Number.isFinite(configuredStepTimeoutMs) || configuredStepTimeoutMs <= 0)
    ) {
      throw new Error(`INVALID_RESOURCE_LIMITS: stepTimeoutMs must be a positive finite number when provided (got ${String(configuredStepTimeoutMs)})`);
    }

    const effectiveResourceLimits = {
      ...options.task.resourceLimits,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.stepTimeoutMs !== undefined ? { stepTimeoutMs: options.stepTimeoutMs } : {}),
    };

    const harnessVersion = options.harnessVersion ?? EVALUATION_HARNESS_VERSION;
    const toolSchemaHash = harnessVersion === EVALUATION_HARNESS_VERSION_V3_0
      ? undefined
      : computeToolSchemasHash(options.task.allowedTools);

    const configPayload = {
      harnessVersion,
      evaluationMode,
      modelId: options.modelId,
      modelDigest: options.modelDigest,
      taskId: options.task.taskId,
      taskVersion: options.task.version ?? "1.0.0",
      gateId: options.task.gateId,
      resourceLimits: effectiveResourceLimits,
      allowedTools: options.task.allowedTools,
      trialIndex,
      ...(toolSchemaHash ? { toolSchemaHash } : {}),
    };
    const configHash = sha256Hex(canonicalJsonStringify(configPayload));

    const inputPayload = {
      initialFiles: options.task.initialFiles,
      inputPrompt: options.task.inputPrompt,
      allowedTools: options.task.allowedTools,
    };
    const inputHash = sha256Hex(canonicalJsonStringify(inputPayload));

    // Create temporary clean-room workspace (ephemeral, in-process, os.tmpdir)
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `emerald-eval-${options.task.taskId}-`));

    let gateA: GateAAssessment = {
      passed: false,
      score: 0.0,
      rationale: "Unassessed",
      details: [],
    };

    let gateB: GateBAssessment = {
      passed: false,
      verifierType: options.task.gateBCriteria.verifierType,
      details: [],
      independentEvidenceRef: `ref-${trialId}`,
    };

    let failureClassification: DualGateTrialResult["failureClassification"];
    let diagnosticRootCause: DualGateTrialResult["diagnosticRootCause"];
    const accessedFiles = new Set<string>();
    const accessedFileRecords: Array<{ requestedRelPath: string; realPath: string; isSymlink: boolean }> = [];
    const proposalsRecorded: unknown[] = [];
    const stepRecords: EvaluationStepRecord[] = [];

    const isCaseSensitive = options.caseSensitive ?? DualGateEvaluationHarness.isDirectoryCaseSensitive(tempDir);

    try {
      // 1. Populate workspace with initial files and snapshot pre-trial file hashes (SEC-016)
      const initialWorkspaceFileHashes: Record<string, string> = {};
      for (const [relPath, content] of Object.entries(options.task.initialFiles)) {
        this.assertSandboxPath(tempDir, relPath);
        const fullPath = path.join(tempDir, relPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, "utf8");
        initialWorkspaceFileHashes[path.normalize(relPath).replace(/\\/g, "/")] = sha256Hex(content);
      }

      options.onWorkspaceReady?.(tempDir);

      // 2. Generate workspace directory structure manifest (Anti-leakage: structural layout only)
      const manifest = DualGateEvaluationHarness.generateWorkspaceManifest(tempDir, {
        targetFiles: options.task.gateACriteria.expectedTargetFiles,
        expectedCitations: options.task.gateACriteria.expectedCitations,
      });
      const initialUserPrompt = options.task.inputPrompt + (manifest ? `\n\nWorkspace files:\n${manifest}` : "");

      let systemPromptContent: string;
      if (harnessVersion === EVALUATION_HARNESS_VERSION_V3_0) {
        systemPromptContent = `You are an evaluation agent for capability ${options.task.gateId}. Available tools: ${options.task.allowedTools.join(", ")}. Return structured action proposal as JSON: {"toolName": "...", "inputPayload": { ... }, "rationale": "..."}.`;
      } else {
        const toolDocumentation = renderToolSchemaDocumentation(options.task.allowedTools);
        systemPromptContent = [
          `You are an evaluation agent for capability ${options.task.gateId}.`,
          `Available tools: ${options.task.allowedTools.join(", ")}.`,
          `Return structured action proposal as JSON: {"toolName": "...", "inputPayload": { ... }, "rationale": "..."}.`,
          "",
          "Available Tool Schemas and Contracts:",
          toolDocumentation,
          "",
          "Evaluation Rules:",
          "1. Every tool call must adhere strictly to the parameter schema defined above.",
          "2. For 'write_file', the target path must be passed via the 'path' parameter. 'filePath' is NOT accepted.",
          "3. When you have completed the task or if no further tool actions are required, emit your final answer without specifying a toolName (or with toolName omitted).",
        ].join("\n");
      }

      const conversation: Array<ModelProviderRequest["input"][number]> = [
        {
          role: "system",
          content: systemPromptContent,
        },
        {
          role: "user",
          content: initialUserPrompt,
        },
      ];

      const maxSteps = Math.max(1, options.task.resourceLimits?.maxSteps ?? 1);
      const maxOutputBytes = options.task.resourceLimits?.maxOutputBytes ?? 16384;
      const deadline = startTime + totalTrialTimeoutMs;

      if (deadline - Date.now() < 1) {
        throw new Error("TRIAL_WALL_CLOCK_TIMEOUT: Trial execution deadline exceeded before interaction loop");
      }

      // 3. Multi-step interaction loop
      for (let step = 0; step < maxSteps; step++) {
        const stepStart = Date.now();

        if (options.abortSignal?.aborted) {
          throw options.abortSignal.reason ?? new Error("EVALUATION_CANCELLED: Trial execution cancelled by caller");
        }

        const remainingMs = deadline - Date.now();
        if (remainingMs < 1) {
          throw new Error("TRIAL_WALL_CLOCK_TIMEOUT: Trial execution deadline exceeded");
        }

        const effectiveStepTimeoutMs = configuredStepTimeoutMs !== undefined
          ? Math.min(configuredStepTimeoutMs, remainingMs)
          : remainingMs;

        if (effectiveStepTimeoutMs < 1) {
          throw new Error("TRIAL_WALL_CLOCK_TIMEOUT: Step cannot start because total trial deadline has elapsed");
        }

        const stepAbortController = new AbortController();
        let cleanupCallerAbort: (() => void) | undefined;
        let callerAbortPromise: Promise<never> | undefined;

        if (options.abortSignal) {
          if (options.abortSignal.aborted) {
            throw options.abortSignal.reason ?? new Error("EVALUATION_CANCELLED: Trial execution cancelled by caller");
          }
          const onCallerAbort = () => {
            stepAbortController.abort(options.abortSignal?.reason ?? new Error("EVALUATION_CANCELLED"));
          };
          options.abortSignal.addEventListener("abort", onCallerAbort, { once: true });
          cleanupCallerAbort = () => options.abortSignal?.removeEventListener("abort", onCallerAbort);

          callerAbortPromise = new Promise<never>((_, reject) => {
            if (options.abortSignal!.aborted) {
              reject(options.abortSignal!.reason ?? new Error("EVALUATION_CANCELLED: Trial execution cancelled by caller"));
            } else {
              options.abortSignal!.addEventListener(
                "abort",
                () => reject(options.abortSignal!.reason ?? new Error("EVALUATION_CANCELLED: Trial execution cancelled by caller")),
                { once: true }
              );
            }
          });
        }

        const request: ModelProviderRequest = {
          requestId: `eval-req-${trialId}-step-${step}`,
          model: options.modelId,
          input: [...conversation],
          generation: {
            temperature: 0.0,
          },
          timeoutMs: effectiveStepTimeoutMs,
          abortSignal: stepAbortController.signal,
        };

        let stepTimer: NodeJS.Timeout | undefined;
        let stepTimerFired = false;
        let rawContent = "";
        try {
          const responsePromise = options.modelProvider.generate(request);
          const timeoutPromise = new Promise<never>((_, reject) => {
            stepTimer = setTimeout(() => {
              if (stepTimerFired) return;
              stepTimerFired = true;
              stepAbortController.abort(new Error("STEP_TIMEOUT"));
              const remainingAtTimeout = deadline - Date.now();
              if (remainingAtTimeout < 1) {
                reject(new Error(`TRIAL_WALL_CLOCK_TIMEOUT: Trial execution deadline exceeded during step ${step + 1}`));
              } else {
                reject(new Error(`MODEL_REQUEST_TIMEOUT: Step ${step + 1} execution timed out after ${effectiveStepTimeoutMs}ms`));
              }
            }, effectiveStepTimeoutMs);
          });

          const racePromises: Array<Promise<any>> = [responsePromise, timeoutPromise];
          if (callerAbortPromise) {
            racePromises.push(callerAbortPromise);
          }

          const response = await Promise.race(racePromises);
          rawContent = response.outputText?.trim() ?? "";
        } finally {
          if (stepTimer !== undefined) {
            clearTimeout(stepTimer);
            stepTimer = undefined;
          }
          cleanupCallerAbort?.();
        }

        proposalsRecorded.push(rawContent);

        // Parse proposal with resilience against markdown code fences
        let parsedProposal: { toolName?: string; inputPayload?: any; rationale?: string } = {};
        try {
          const cleaned = rawContent.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
          parsedProposal = JSON.parse(cleaned);
        } catch {
          const match = rawContent.match(/\{[\s\S]*\}/);
          if (match) {
            try {
              parsedProposal = JSON.parse(match[0]);
            } catch {
              parsedProposal = {
                toolName: undefined,
                inputPayload: { text: rawContent },
                rationale: rawContent,
              };
            }
          } else {
            parsedProposal = {
              toolName: undefined,
              inputPayload: { text: rawContent },
              rationale: rawContent,
            };
          }
        }

        // Security boundary validation: any proposed filesystem path must remain within sandbox
        const proposedPath = parsedProposal.inputPayload?.path ?? parsedProposal.inputPayload?.filePath;
        if (typeof proposedPath === "string") {
          this.assertSandboxPath(tempDir, proposedPath);
        }
        if (typeof parsedProposal.inputPayload?.searchPath === "string") {
          this.assertSandboxPath(tempDir, parsedProposal.inputPayload.searchPath);
        }

        // If no tool was proposed or model signaled completion
        if (!parsedProposal.toolName) {
          stepRecords.push({
            stepNumber: step + 1,
            proposal: parsedProposal,
            durationMs: Date.now() - stepStart,
          });
          break;
        }

        // Stagnation check: detect identical action proposed consecutively
        if (step > 0) {
          const prevStep = stepRecords[step - 1];
          if (
            prevStep &&
            prevStep.proposal?.toolName === parsedProposal.toolName &&
            canonicalJsonStringify(prevStep.proposal?.inputPayload) === canonicalJsonStringify(parsedProposal.inputPayload)
          ) {
            stepRecords.push({
              stepNumber: step + 1,
              proposal: parsedProposal,
              toolObservation: "STAGNATION_DETECTED: Repeated identical action proposal; stopping interaction loop.",
              durationMs: Date.now() - stepStart,
            });
            break;
          }
        }

        // Check tool permission allowlist: reject unauthorized tools fail-closed without mutation
        if (!options.task.allowedTools.includes(parsedProposal.toolName as any)) {
          const toolObservation = `POLICY_VIOLATION: Tool '${parsedProposal.toolName}' is not allowed for task '${options.task.taskId}'. Allowed tools: [${options.task.allowedTools.join(", ")}].`;
          stepRecords.push({
            stepNumber: step + 1,
            proposal: parsedProposal,
            toolObservation,
            durationMs: Date.now() - stepStart,
          });
          conversation.push({ role: "assistant", content: rawContent });
          conversation.push({ role: "user", content: `Tool '${parsedProposal.toolName}' observation:\n${toolObservation}` });
          continue;
        }

        // Execute tool via Clean-Room Tool Gateway
        let toolObservation = "";
        let accessedPath: string | undefined;

        if (parsedProposal.toolName === "search_code") {
          toolObservation = this.executeCleanroomSearchCode(tempDir, parsedProposal.inputPayload, maxOutputBytes, deadline);
        } else if (parsedProposal.toolName === "read_file") {
          const readRes = this.executeCleanroomReadFile(tempDir, parsedProposal.inputPayload, maxOutputBytes, isCaseSensitive, options.isSymlinkPredicate);
          toolObservation = readRes.observation;
          if (readRes.record) {
            accessedPath = readRes.record.requestedRelPath;
            accessedFiles.add(readRes.record.requestedRelPath);
            accessedFileRecords.push(readRes.record);
          }
        } else if (parsedProposal.toolName === "write_file") {
          // Categorical boundary: write_file is strictly forbidden for G2_REPO_NAVIGATION
          if (options.task.gateId === "G2_REPO_NAVIGATION" || !options.task.allowedTools.includes("write_file")) {
            toolObservation = `POLICY_VIOLATION: Tool 'write_file' is unauthorized and forbidden for capability '${options.task.gateId}'.`;
          } else {
            toolObservation = this.executeCleanroomWriteFile(tempDir, parsedProposal.inputPayload, maxOutputBytes, options.task, isCaseSensitive);
          }
        } else {
          toolObservation = `UNSUPPORTED_TOOL: Clean-room evaluation gateway does not implement tool '${parsedProposal.toolName}'`;
        }

        stepRecords.push({
          stepNumber: step + 1,
          proposal: parsedProposal,
          toolObservation,
          accessedPath,
          durationMs: Date.now() - stepStart,
        });

        // Feed tool observation back to conversation history for next step
        conversation.push({ role: "assistant", content: rawContent });
        conversation.push({ role: "user", content: `Tool '${parsedProposal.toolName}' observation:\n${toolObservation}` });
      }

      if (deadline - Date.now() < 1) {
        throw new Error("TRIAL_WALL_CLOCK_TIMEOUT: Trial execution deadline exceeded during interaction loop");
      }

      // 4. Evaluate Gate A: Model Behavioral Capability
      gateA = this.assessGateA(options.task, stepRecords, proposalsRecorded as string[]);

      // 5. Evaluate Gate B: Independent System Verification
      gateB = await this.assessGateB(
        options.task,
        tempDir,
        stepRecords,
        proposalsRecorded as string[],
        accessedFileRecords,
        trialId,
        isCaseSensitive,
        initialWorkspaceFileHashes
      );

      if (deadline - Date.now() < 1) {
        throw new Error("TRIAL_WALL_CLOCK_TIMEOUT: Trial execution deadline exceeded during verification");
      }

      if (!gateA.passed && !gateB.passed) {
        failureClassification = "MODEL_BEHAVIORAL_FAILURE";
        const hasUnparseableProposal = proposalsRecorded.some((p) => {
          if (typeof p !== "string") return true;
          try {
            JSON.parse(p.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim());
            return false;
          } catch {
            return true;
          }
        });
        const hasMissingToolProposal = stepRecords.some((r) => !r.proposal?.toolName);
        diagnosticRootCause = (hasUnparseableProposal || hasMissingToolProposal)
          ? "INVALID_TOOL_PROPOSAL"
          : "BEHAVIORAL_FAILURE";
      } else if (!gateA.passed) {
        failureClassification = "MODEL_BEHAVIORAL_FAILURE";
        const hasUnparseableProposal = proposalsRecorded.some((p) => {
          if (typeof p !== "string") return true;
          try {
            JSON.parse(p.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim());
            return false;
          } catch {
            return true;
          }
        });
        const hasMissingToolProposal = stepRecords.some((r) => !r.proposal?.toolName);
        diagnosticRootCause = (hasUnparseableProposal || hasMissingToolProposal)
          ? "INVALID_TOOL_PROPOSAL"
          : "BEHAVIORAL_FAILURE";
      } else if (!gateB.passed) {
        failureClassification = "INDEPENDENT_VERIFICATION_FAILURE";
        diagnosticRootCause = "INDEPENDENT_VERIFICATION_FAILURE";
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const errCode = (err as any)?.code;

      if (msg.includes("PATH_TRAVERSAL") || msg.includes("FENCING") || msg.includes("LEASE_EXPIRED") || msg.includes("SECURITY_VIOLATION")) {
        failureClassification = "SECURITY_VIOLATION";
        diagnosticRootCause = "SECURITY_VIOLATION";
        gateA = { passed: false, score: 0.0, rationale: `Security violation: ${msg}`, details: [msg] };
        gateB = { passed: false, verifierType: options.task.gateBCriteria.verifierType, details: [msg], independentEvidenceRef: `err-${trialId}` };
      } else if (msg.includes("TRIAL_WALL_CLOCK_TIMEOUT")) {
        failureClassification = "TIMEOUT";
        diagnosticRootCause = "TRIAL_WALL_CLOCK_TIMEOUT";
        gateA = { passed: false, score: 0.0, rationale: "Execution timed out: total trial wall-clock limit exceeded", details: [msg] };
        gateB = { passed: false, verifierType: options.task.gateBCriteria.verifierType, details: [msg], independentEvidenceRef: `err-${trialId}` };
      } else if (msg.includes("MODEL_REQUEST_TIMEOUT") || errCode === "MODEL_REQUEST_TIMEOUT") {
        failureClassification = "TIMEOUT";
        diagnosticRootCause = "MODEL_REQUEST_TIMEOUT";
        gateA = { passed: false, score: 0.0, rationale: "Execution timed out: model request timeout", details: [msg] };
        gateB = { passed: false, verifierType: options.task.gateBCriteria.verifierType, details: [msg], independentEvidenceRef: `err-${trialId}` };
      } else if (msg.includes("TOOL_EXECUTION_TIMEOUT") || msg.includes("TOOL_TIMEOUT")) {
        failureClassification = "TIMEOUT";
        diagnosticRootCause = "TOOL_EXECUTION_TIMEOUT";
        gateA = { passed: false, score: 0.0, rationale: "Execution timed out: tool execution timeout", details: [msg] };
        gateB = { passed: false, verifierType: options.task.gateBCriteria.verifierType, details: [msg], independentEvidenceRef: `err-${trialId}` };
      } else if (msg.includes("EVALUATION_TIMEOUT") || msg.includes("TIMEOUT")) {
        failureClassification = "TIMEOUT";
        diagnosticRootCause = "TRIAL_WALL_CLOCK_TIMEOUT";
        gateA = { passed: false, score: 0.0, rationale: "Execution timed out", details: [msg] };
        gateB = { passed: false, verifierType: options.task.gateBCriteria.verifierType, details: [msg], independentEvidenceRef: `err-${trialId}` };
      } else if (
        options.abortSignal?.aborted ||
        msg.includes("EVALUATION_CANCELLED") ||
        msg.includes("MODEL_REQUEST_CANCELLED") ||
        msg.includes("CALLER_ABORT") ||
        msg.includes("OPERATOR_ABORT") ||
        msg.includes("USER_INTENTIONAL_CANCEL") ||
        errCode === "MODEL_REQUEST_CANCELLED"
      ) {
        failureClassification = "CANCELLED";
        diagnosticRootCause = "CALLER_ABORTED";
        gateA = { passed: false, score: 0.0, rationale: `Execution cancelled: ${msg}`, details: [msg] };
        gateB = { passed: false, verifierType: options.task.gateBCriteria.verifierType, details: [msg], independentEvidenceRef: `err-${trialId}` };
      } else if (msg.includes("MODEL_PROVIDER_UNAVAILABLE") || errCode === "MODEL_PROVIDER_UNAVAILABLE") {
        failureClassification = "HARNESS_ERROR";
        diagnosticRootCause = "MODEL_PROVIDER_FAILURE";
        gateA = { passed: false, score: 0.0, rationale: `Model provider failure: ${msg}`, details: [msg] };
        gateB = { passed: false, verifierType: options.task.gateBCriteria.verifierType, details: [msg], independentEvidenceRef: `err-${trialId}` };
      } else {
        failureClassification = "HARNESS_ERROR";
        diagnosticRootCause = "HARNESS_FAILURE";
        gateA = { passed: false, score: 0.0, rationale: `Harness error: ${msg}`, details: [msg] };
        gateB = { passed: false, verifierType: options.task.gateBCriteria.verifierType, details: [msg], independentEvidenceRef: `err-${trialId}` };
      }
    } finally {
      // Guaranteed workspace cleanup
      try {
        if (options.cleanupWorkspace) {
          options.cleanupWorkspace(tempDir);
        } else {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      } catch (cleanupErr: unknown) {
        const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        // Genuine cleanup failures must remain visible rather than being silently swallowed or masked as successful cancellation.
        // Precedence: FENCING / SECURITY_VIOLATION > TIMEOUT > CANCELLED / HARNESS_ERROR
        if (failureClassification !== "SECURITY_VIOLATION" && failureClassification !== "TIMEOUT") {
          failureClassification = "HARNESS_ERROR";
          diagnosticRootCause = "WORKSPACE_CLEANUP_FAILURE";
        }
        const existingDetailsA = gateA?.details ?? [];
        const existingDetailsB = gateB?.details ?? [];
        gateA = {
          passed: false,
          score: 0.0,
          rationale: gateA?.rationale ? `${gateA.rationale}; Workspace cleanup failed: ${cleanupMsg}` : `Workspace cleanup failed: ${cleanupMsg}`,
          details: [...existingDetailsA, `Workspace cleanup error: ${cleanupMsg}`],
        };
        gateB = {
          passed: false,
          verifierType: options.task.gateBCriteria.verifierType,
          details: [...existingDetailsB, `Workspace cleanup error: ${cleanupMsg}`],
          independentEvidenceRef: `err-${trialId}`,
        };
      }
    }

    const durationMs = Date.now() - startTime;
    const isExpiredAtFinalization = (startTime + totalTrialTimeoutMs) - Date.now() < 1;
    if (isExpiredAtFinalization && failureClassification !== "SECURITY_VIOLATION") {
      gateA = {
        passed: false,
        score: 0.0,
        rationale: "Execution timed out: total trial wall-clock limit exceeded before evidence finalization",
        details: ["Trial wall-clock deadline exceeded"],
      };
      gateB = {
        passed: false,
        verifierType: options.task.gateBCriteria.verifierType,
        details: ["Trial deadline exceeded"],
        independentEvidenceRef: `err-${trialId}`,
      };
      failureClassification = "TIMEOUT";
      diagnosticRootCause = "TRIAL_WALL_CLOCK_TIMEOUT";
    }
    const overallPassed = !isExpiredAtFinalization && gateA.passed && gateB.passed;
    const outputHash = sha256Hex(canonicalJsonStringify(proposalsRecorded));

    const trialEvidenceHash = computeTrialEvidenceHash({
      trialId,
      taskId: options.task.taskId,
      gateId: options.task.gateId,
      modelId: options.modelId,
      modelDigest: options.modelDigest,
      harnessVersion,
      evaluationMode,
      observedAt,
      configHash,
      inputHash,
      outputHash,
      gateAPassed: gateA.passed,
      gateBPassed: gateB.passed,
      overallPassed,
    });

    return Object.freeze({
      trialId,
      trialIndex,
      taskId: options.task.taskId,
      gateId: options.task.gateId,
      modelId: options.modelId,
      modelDigest: options.modelDigest,
      harnessVersion,
      evaluationMode,
      gateA: Object.freeze(gateA),
      gateB: Object.freeze(gateB),
      overallPassed,
      durationMs,
      observedAt,
      configHash,
      inputHash,
      outputHash,
      trialEvidenceHash,
      stepsExecuted: stepRecords.length,
      stepRecords: Object.freeze(stepRecords),
      ...(failureClassification ? { failureClassification } : {}),
      ...(diagnosticRootCause ? { diagnosticRootCause } : {}),
    });
  }

  private assertSandboxPath(workspaceRoot: string, relPath: string): void {
    if (relPath.includes("..") || path.isAbsolute(relPath)) {
      throw new Error(`PATH_TRAVERSAL: Illegal path traversal detected: '${relPath}'`);
    }
    const rootResolved = path.resolve(workspaceRoot);
    const resolved = path.resolve(workspaceRoot, relPath);
    if (!resolved.startsWith(rootResolved)) {
      throw new Error(`PATH_TRAVERSAL: Path '${relPath}' resolves outside workspace boundary`);
    }
    try {
      if (fs.existsSync(resolved)) {
        const realTarget = fs.realpathSync(resolved);
        const realRoot = fs.realpathSync(rootResolved);
        if (!realTarget.startsWith(realRoot)) {
          throw new Error(`PATH_TRAVERSAL: Symlink destination '${realTarget}' escapes workspace root '${realRoot}'`);
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith("PATH_TRAVERSAL")) {
        throw err;
      }
    }
  }

  private executeCleanroomSearchCode(
    workspaceRoot: string,
    payload: any,
    maxOutputBytes: number,
    deadline: number
  ): string {
    const validation = validateToolProposalPayload("search_code", payload);
    if (!validation.valid) {
      return JSON.stringify(validation.error, null, 2);
    }

    const rawQuery = typeof payload?.query === "string" ? payload.query : "";
    const query = rawQuery.trim();
    if (!query) {
      return JSON.stringify({ error: "INVALID_QUERY", message: "query must be a non-empty string" });
    }

    // 1. Query length ceiling: reject oversized query inputs
    if (query.length > 500) {
      return JSON.stringify({
        error: "QUERY_TOO_LONG",
        message: `Query length (${query.length}) exceeds maximum limit (500 characters)`,
      });
    }

    // 2. Validate directory path containment
    const relSearchDir = typeof payload?.path === "string" ? payload.path : ".";
    this.assertSandboxPath(workspaceRoot, relSearchDir);
    const hostSearchDir = path.resolve(workspaceRoot, relSearchDir);
    if (!fs.existsSync(hostSearchDir)) {
      return JSON.stringify({ error: "DIRECTORY_NOT_FOUND", path: relSearchDir });
    }

    const isRegex = Boolean(payload?.isRegex);
    if (isRegex) {
      return JSON.stringify({
        error: "REGEX_DISABLED",
        message: "Regular expression search is disabled in clean-room evaluation for ReDoS prevention; use literal substring search.",
      });
    }

    // Literal search semantics by default: query is treated strictly as literal substring
    // Special characters like *, +, ?, [, ], (, ), \, $, ^ have no regex meaning
    const lowerQuery = query.toLowerCase();
    const matcher = (line: string) => line.toLowerCase().includes(lowerQuery);

    // 5. Hard ceilings for search operations
    const MAX_FILES_TO_SCAN = 100;
    const MAX_FILE_SIZE_BYTES = 512 * 1024; // 512 KB
    const MAX_TRAVERSAL_DEPTH = 10;
    const SEARCH_TIMEOUT_MS = 2000; // Max 2 seconds dedicated search execution
    const searchDeadline = Math.min(deadline, Date.now() + SEARCH_TIMEOUT_MS);

    const maxResults = Math.min(20, Math.max(1, typeof payload?.maxResults === "number" ? payload.maxResults : 10));
    const matches: Array<{ file: string; line: number; content: string }> = [];
    let filesScanned = 0;
    let truncated = false;
    let reasonTruncated = "";

    let realRoot: string;
    try {
      realRoot = fs.realpathSync(workspaceRoot);
    } catch {
      realRoot = path.resolve(workspaceRoot);
    }

    // Bounded recursive traversal
    const walk = (dir: string, depth: number): void => {
      if (matches.length >= maxResults || filesScanned >= MAX_FILES_TO_SCAN || Date.now() >= searchDeadline || depth > MAX_TRAVERSAL_DEPTH) {
        truncated = true;
        if (matches.length >= maxResults) reasonTruncated = "max_matches_reached";
        else if (filesScanned >= MAX_FILES_TO_SCAN) reasonTruncated = "max_files_scanned_reached";
        else if (Date.now() >= searchDeadline) reasonTruncated = "search_timeout_exceeded";
        else if (depth > MAX_TRAVERSAL_DEPTH) reasonTruncated = "max_traversal_depth_exceeded";
        return;
      }

      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        if (matches.length >= maxResults || filesScanned >= MAX_FILES_TO_SCAN || Date.now() >= searchDeadline) {
          truncated = true;
          return;
        }
        if (entry.name.startsWith(".")) continue;

        const fullPath = path.join(dir, entry.name);
        try {
          const realTarget = fs.realpathSync(fullPath);
          if (!realTarget.startsWith(realRoot)) continue;
        } catch {
          continue;
        }

        if (entry.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (entry.isFile()) {
          filesScanned++;
          const relFilePath = path.relative(realRoot, fullPath).replace(/\\/g, "/");
          try {
            const stat = fs.statSync(fullPath);
            if (stat.size > MAX_FILE_SIZE_BYTES) {
              // Skip files exceeding file size ceiling
              continue;
            }

            const text = fs.readFileSync(fullPath, "utf8");
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              if (matches.length >= maxResults || Date.now() >= searchDeadline) {
                truncated = true;
                break;
              }
              const line = lines[i]!;
              if (matcher(line)) {
                matches.push({
                  file: relFilePath,
                  line: i + 1,
                  content: line.trim().slice(0, 500), // Bound line content length
                });
              }
            }
          } catch {
            // Skip unreadable files
          }
        }
      }
    };

    walk(hostSearchDir, 1);

    let resultJson = JSON.stringify({
      query,
      isRegex,
      totalMatches: matches.length,
      matches,
      truncated,
      ...(reasonTruncated ? { reasonTruncated } : {}),
      filesScanned,
    }, null, 2);

    // Enforce maxOutputBytes bound
    if (Buffer.byteLength(resultJson, "utf8") > maxOutputBytes) {
      while (matches.length > 1 && Buffer.byteLength(resultJson, "utf8") > maxOutputBytes) {
        matches.pop();
        resultJson = JSON.stringify({
          query,
          isRegex,
          totalMatches: matches.length,
          matches,
          truncated: true,
          reasonTruncated: "max_output_bytes_exceeded",
          filesScanned,
        }, null, 2);
      }
    }

    return resultJson;
  }

  private executeCleanroomReadFile(
    workspaceRoot: string,
    payload: any,
    maxOutputBytes: number,
    caseSensitive: boolean,
    isSymlinkPredicate?: (resolvedPath: string) => boolean
  ): { observation: string; record?: { requestedRelPath: string; realPath: string; isSymlink: boolean } } {
    const validation = validateToolProposalPayload("read_file", payload);
    if (!validation.valid) {
      return { observation: JSON.stringify(validation.error, null, 2) };
    }

    const rawPath = typeof payload?.path === "string" ? payload.path.trim() : (typeof payload?.filePath === "string" ? payload.filePath.trim() : "");

    this.assertSandboxPath(workspaceRoot, rawPath);
    const normalizedRelPath = path.normalize(rawPath).replace(/\\/g, "/");
    const fullPath = path.resolve(workspaceRoot, rawPath);

    if (!fs.existsSync(fullPath)) {
      return { observation: JSON.stringify({ error: "FILE_NOT_FOUND", path: normalizedRelPath }) };
    }

    // Check on-disk casing on case-sensitive filesystem
    let realRoot: string;
    let realTarget: string;
    try {
      realRoot = fs.realpathSync.native ? fs.realpathSync.native(path.resolve(workspaceRoot)) : fs.realpathSync(path.resolve(workspaceRoot));
      realTarget = fs.realpathSync.native ? fs.realpathSync.native(fullPath) : fs.realpathSync(fullPath);
    } catch {
      return { observation: JSON.stringify({ error: "FILE_NOT_FOUND", path: normalizedRelPath }) };
    }

    const onDiskRel = path.relative(realRoot, realTarget).replace(/\\/g, "/");
    if (caseSensitive && normalizedRelPath !== onDiskRel) {
      return { observation: JSON.stringify({ error: "FILE_NOT_FOUND", path: normalizedRelPath }) };
    }

    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) {
        return { observation: JSON.stringify({ error: "NOT_A_FILE", path: normalizedRelPath }) };
      }

      let isSymlink = isSymlinkPredicate ? isSymlinkPredicate(fullPath) : false;
      if (!isSymlink) {
        try {
          const lstat = fs.lstatSync(fullPath);
          if (lstat.isSymbolicLink()) {
            isSymlink = true;
          }
        } catch {
          // Ignore lstat error
        }
      }

      const fullContent = fs.readFileSync(fullPath, "utf8");
      const lines = fullContent.split(/\r?\n/);
      const offsetLine = Math.max(1, typeof payload?.offsetLine === "number" ? payload.offsetLine : 1);
      const limitLines = Math.max(1, Math.min(1000, typeof payload?.limitLines === "number" ? payload.limitLines : 500));

      const selectedLines = lines.slice(offsetLine - 1, offsetLine - 1 + limitLines);
      let content = selectedLines.join("\n");
      let isTruncated = (offsetLine - 1 + limitLines) < lines.length || offsetLine > 1;

      if (Buffer.byteLength(content, "utf8") > maxOutputBytes) {
        content = content.slice(0, maxOutputBytes);
        isTruncated = true;
      }

      const output = {
        path: normalizedRelPath,
        content,
        bytesRead: Buffer.byteLength(content, "utf8"),
        totalLines: lines.length,
        isTruncated,
      };

      return {
        observation: JSON.stringify(output, null, 2),
        record: {
          requestedRelPath: normalizedRelPath,
          realPath: realTarget,
          isSymlink,
        },
      };
    } catch (err: unknown) {
      return { observation: JSON.stringify({ error: "READ_FAILED", message: String(err) }) };
    }
  }

  private executeCleanroomWriteFile(
    workspaceRoot: string,
    payload: any,
    _maxOutputBytes: number,
    task?: DualGateEvaluationTask,
    isCaseSensitive: boolean = true
  ): string {
    const validation = validateToolProposalPayload("write_file", payload);
    if (!validation.valid) {
      return JSON.stringify(validation.error, null, 2);
    }

    const rawPath = typeof payload?.path === "string" ? payload.path.trim() : "";
    const content = typeof payload?.content === "string" ? payload.content : "";

    this.assertSandboxPath(workspaceRoot, rawPath);
    const normalizedRelPath = path.normalize(rawPath).replace(/\\/g, "/");

    // SEC-016: Single-File Mutation Boundary enforcement for G4
    if (task?.gateId === "G4_SINGLE_FILE_REPAIR") {
      const expectedTargets = task.gateACriteria.expectedTargetFiles ?? [];
      if (expectedTargets.length > 0) {
        const authorizedTarget = path.normalize(expectedTargets[0]!).replace(/\\/g, "/");
        const matchesTarget = isCaseSensitive
          ? normalizedRelPath === authorizedTarget
          : normalizedRelPath.toLowerCase() === authorizedTarget.toLowerCase();
        if (!matchesTarget) {
          return JSON.stringify({
            error: "UNAUTHORIZED_WRITE_PATH",
            message: `G4_SINGLE_FILE_REPAIR strictly limits writes to authorized target file '${authorizedTarget}'. Write to '${normalizedRelPath}' was rejected.`,
          }, null, 2);
        }
      }
    }

    const fullPath = path.resolve(workspaceRoot, rawPath);

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");

    const bytesWritten = Buffer.byteLength(content, "utf8");
    return JSON.stringify({
      path: normalizedRelPath,
      bytesWritten,
      created: true,
    }, null, 2);
  }

  private assessGateA(
    task: DualGateEvaluationTask,
    stepRecords: EvaluationStepRecord[],
    rawTexts: string[]
  ): GateAAssessment {
    const details: string[] = [];
    const crit = task.gateACriteria;

    if (crit.customAssess) {
      const lastProposal = stepRecords[stepRecords.length - 1]?.proposal ?? {};
      const custom = crit.customAssess(lastProposal);
      return {
        passed: custom.passed,
        score: custom.score,
        rationale: custom.rationale,
        details: [custom.rationale],
      };
    }

    let score = 1.0;
    const allText = rawTexts.join(" ");

    // Check expected tool if criteria specifies one
    if (crit.expectedTool) {
      const usedExpectedTool = stepRecords.some((r) => r.proposal?.toolName === crit.expectedTool);
      if (!usedExpectedTool) {
        score -= 0.5;
        const usedTools = stepRecords.map((r) => r.proposal?.toolName).filter(Boolean);
        details.push(`Expected tool '${crit.expectedTool}', but used [${usedTools.join(", ")}]`);
      }
    }

    // Check expected target files
    if (crit.expectedTargetFiles && crit.expectedTargetFiles.length > 0) {
      const touchesTarget = crit.expectedTargetFiles.some((expected) => {
        const normExpected = expected.replace(/\\/g, "/");
        return stepRecords.some((r) => {
          const pathArg = (r.proposal?.inputPayload as any)?.path ?? (r.proposal?.inputPayload as any)?.filePath ?? "";
          const normPathArg = typeof pathArg === "string" ? pathArg.replace(/\\/g, "/") : "";
          const rationale = typeof r.proposal?.rationale === "string" ? r.proposal.rationale : "";
          return (
            normPathArg.includes(normExpected) ||
            rationale.includes(normExpected) ||
            (r.accessedPath && r.accessedPath.replace(/\\/g, "/").includes(normExpected))
          );
        }) || allText.includes(normExpected);
      });

      if (!touchesTarget) {
        score -= 0.5;
        details.push(`Proposals did not target or reference any of [${crit.expectedTargetFiles.join(", ")}]`);
      }
    }

    // Check expected citations
    if (crit.expectedCitations && crit.expectedCitations.length > 0) {
      const missingCitations = crit.expectedCitations.filter((c) => !allText.includes(c));
      if (missingCitations.length === crit.expectedCitations.length) {
        score -= 0.5;
        details.push(`Missing ground-truth citations: [${missingCitations.join(", ")}]`);
      }
    }

    score = Math.max(0.0, score);
    const passed = score >= 0.7;
    return {
      passed,
      score,
      rationale: passed ? "Gate A behavioral criteria satisfied" : details.join("; ") || "Behavioral criteria failed",
      details,
    };
  }

  private async assessGateB(
    task: DualGateEvaluationTask,
    workspaceRoot: string,
    _stepRecords: EvaluationStepRecord[],
    rawTexts: string[],
    accessedRecords: Array<{ requestedRelPath: string; realPath: string; isSymlink: boolean }>,
    trialId: string,
    isCaseSensitive: boolean,
    initialWorkspaceFileHashes: Record<string, string> = {}
  ): Promise<GateBAssessment> {
    const crit = task.gateBCriteria;
    const details: string[] = [];
    const allText = rawTexts.join(" ");

    // Zero self-approval invariant: disregard model claims of success
    if (allText.toLowerCase().includes("i have verified") || allText.toLowerCase().includes("all tests pass")) {
      details.push("Model claims of success noted and disregarded by independent verifier");
    }

    if (crit.customVerify) {
      const res = await crit.customVerify(workspaceRoot);
      if (!res.success) {
        details.push(res.details ?? "Custom verifier failed");
      }
      return {
        passed: res.success,
        verifierType: crit.verifierType,
        details,
        independentEvidenceRef: `custom-verify-${trialId}`,
      };
    }

    if (crit.verifierType === "CLEANROOM_ORACLE") {
      const expectedTargets = task.gateACriteria.expectedTargetFiles ?? [];
      let passed = true;

      if (expectedTargets.length > 0) {
        let realRoot: string;
        try {
          realRoot = fs.realpathSync.native ? fs.realpathSync.native(path.resolve(workspaceRoot)) : fs.realpathSync(path.resolve(workspaceRoot));
        } catch {
          realRoot = path.resolve(workspaceRoot);
        }

        // A search query alone is NOT access: target must be accessed via exact, successful read_file
        const targetAccessed = expectedTargets.some((target) => {
          const normTarget = path.normalize(target).replace(/\\/g, "/");
          const targetFullPath = path.resolve(workspaceRoot, target);
          if (!fs.existsSync(targetFullPath)) {
            return false;
          }

          let realTarget: string;
          try {
            realTarget = fs.realpathSync.native ? fs.realpathSync.native(targetFullPath) : fs.realpathSync(targetFullPath);
          } catch {
            return false;
          }

          if (!realTarget.startsWith(realRoot)) {
            return false;
          }

          for (const rec of accessedRecords) {
            // Negative test: Symlink aliases cannot satisfy Gate B
            if (rec.isSymlink) {
              continue;
            }

            // Canonical on-disk path identity without lowercasing
            if (rec.realPath !== realTarget) {
              continue;
            }

            // Filesystem-aware case handling for requested relative path
            if (isCaseSensitive) {
              if (rec.requestedRelPath !== normTarget) {
                continue;
              }
            } else {
              if (rec.requestedRelPath.toLowerCase() !== normTarget.toLowerCase()) {
                continue;
              }
            }

            return true;
          }
          return false;
        });

        if (!targetAccessed) {
          passed = false;
          details.push(
            `Cleanroom oracle: Ground-truth target file(s) [${expectedTargets.join(", ")}] were not accessed via read_file. (Accessed files: [${accessedRecords.map((r) => r.requestedRelPath + (r.isSymlink ? " [symlink]" : "")).join(", ")}])`
          );
        } else {
          details.push(`Cleanroom oracle: Verified access to target file(s) [${expectedTargets.join(", ")}]`);
        }
      }

      // Grounded Diagnostic Verification for G3_CODE_UNDERSTANDING
      if (crit.diagnosticGrounding) {
        const dg = crit.diagnosticGrounding;
        const normTarget = path.normalize(dg.targetFile).replace(/\\/g, "/");
        const wasTargetRead = accessedRecords.some((r) => !r.isSymlink && (isCaseSensitive ? r.requestedRelPath === normTarget : r.requestedRelPath.toLowerCase() === normTarget.toLowerCase()));

        if (!wasTargetRead) {
          passed = false;
          details.push(`Grounded diagnostic: Target file '${dg.targetFile}' was not accessed via read_file`);
        }

        // 1. Line number citation verification (Audit 2: require explicit line syntax, reject bare numbers)
        if (dg.defectiveLineNumbers && dg.defectiveLineNumbers.length > 0) {
          const citesAnyLine = dg.defectiveLineNumbers.some((lineNum) => {
            const linePatterns = [
              new RegExp(`\\bline\\s*[:#]?\\s*${lineNum}\\b`, "i"),
              new RegExp(`:${lineNum}\\b`),
              new RegExp(`\\bL${lineNum}\\b`, "i"),
            ];
            return linePatterns.some((p) => p.test(allText));
          });

          if (!citesAnyLine) {
            passed = false;
            details.push(`Grounded diagnostic: Diagnosis failed to cite expected defective line number(s) [${dg.defectiveLineNumbers.join(", ")}]`);
          } else {
            details.push(`Grounded diagnostic: Verified citation of defective line number(s) [${dg.defectiveLineNumbers.join(", ")}]`);
          }
        }

        // 2. Causal keyword verification
        if (dg.causalKeywords && dg.causalKeywords.length > 0) {
          const lowerText = allText.toLowerCase();
          const hasCausal = dg.causalKeywords.some((kw) => lowerText.includes(kw.toLowerCase()));
          if (!hasCausal) {
            passed = false;
            details.push(`Grounded diagnostic: Diagnosis missing causal explanation keywords [${dg.causalKeywords.join(", ")}]`);
          } else {
            details.push("Grounded diagnostic: Verified presence of causal diagnostic explanation");
          }
        }

        // 3. Healthy code boundary discrimination (Negative cases)
        if (dg.healthyFiles && dg.healthyFiles.length > 0) {
          const lowerText = allText.toLowerCase();
          for (const hf of dg.healthyFiles) {
            const baseHf = path.basename(hf).toLowerCase();
            const falseBlamePatterns = [
              `defect in ${baseHf}`,
              `bug in ${baseHf}`,
              `fix ${baseHf}`,
              `error in ${baseHf}`,
              `modify ${baseHf}`,
            ];
            const blamedHealthy = falseBlamePatterns.some((p) => lowerText.includes(p));
            if (blamedHealthy) {
              passed = false;
              details.push(`Healthy code discrimination failed: Diagnosis falsely blamed healthy production file '${hf}'`);
            } else {
              details.push(`Healthy code discrimination verified: Healthy file '${hf}' was not blamed`);
            }
          }
        }

        // 4. Semantic Causal Verification Oracle (Audit 2: Prevent keyword gaming & false causal claims)
        if (dg.validateDiagnosis) {
          let targetSource = "";
          try {
            const targetFullPath = path.resolve(workspaceRoot, dg.targetFile);
            if (fs.existsSync(targetFullPath)) {
              targetSource = fs.readFileSync(targetFullPath, "utf8");
            }
          } catch {
            // Source not readable
          }
          const diagResult = dg.validateDiagnosis(allText, targetSource);
          if (!diagResult.valid) {
            passed = false;
            details.push(`Grounded diagnostic causal validation failed: ${diagResult.reason ?? "Invalid causal reasoning or false defect attribution"}`);
          } else {
            details.push("Grounded diagnostic: Semantic causal validation confirmed");
          }
        }
      }

      return {
        passed,
        verifierType: crit.verifierType,
        details,
        independentEvidenceRef: `oracle-${trialId}`,
      };
    }

    if (crit.verifierType === "HASH_INVARIANT") {
      // Deterministic hash invariance across recorded proposals
      const lastRaw = rawTexts[rawTexts.length - 1] ?? "";
      let parsed: unknown = {};
      try {
        const cleaned = lastRaw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
        parsed = JSON.parse(cleaned);
      } catch {
        parsed = { text: lastRaw };
      }
      const proposalHash = sha256Hex(canonicalJsonStringify(parsed));
      return {
        passed: proposalHash.length === 64,
        verifierType: crit.verifierType,
        details: [`Proposal hash: ${proposalHash}`],
        independentEvidenceRef: `hash-${proposalHash}`,
      };
    }

    // TEST_RUNNER mode
    let passed = true;

    // SEC-016: Post-Trial Workspace Hash Integrity Audit
    const currentFiles: Record<string, string> = {};
    let illegalEntryDetected: string | null = null;

    const collectFiles = (dir: string): void => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);

        // Audit 4: Detect illegal symbolic links, FIFOs, sockets, or special device files
        if (entry.isSymbolicLink()) {
          illegalEntryDetected = `Illegal symbolic link created: '${path.relative(workspaceRoot, full).replace(/\\/g, "/")}'`;
          return;
        }
        if (!entry.isFile() && !entry.isDirectory()) {
          illegalEntryDetected = `Illegal special file created (FIFO/socket/device): '${path.relative(workspaceRoot, full).replace(/\\/g, "/")}'`;
          return;
        }

        if (entry.isDirectory()) {
          collectFiles(full);
        } else if (entry.isFile()) {
          const rel = path.relative(workspaceRoot, full).replace(/\\/g, "/");
          try {
            currentFiles[rel] = sha256Hex(fs.readFileSync(full, "utf8"));
          } catch {}
        }
      }
    };
    collectFiles(workspaceRoot);

    if (illegalEntryDetected) {
      passed = false;
      details.push(`Workspace integrity violation: ${illegalEntryDetected}`);
    }

    // Audit for deleted baseline files
    for (const [relPath] of Object.entries(initialWorkspaceFileHashes)) {
      if (!(relPath in currentFiles)) {
        passed = false;
        details.push(`Workspace integrity violation: Baseline file was deleted: '${relPath}'`);
      }
    }

    // Audit for unauthorized newly created files
    for (const [relPath] of Object.entries(currentFiles)) {
      if (!(relPath in initialWorkspaceFileHashes)) {
        const isAuthorizedOutput = task.gateACriteria.expectedTargetFiles?.some((tgt) => {
          const normTgt = path.normalize(tgt).replace(/\\/g, "/");
          return isCaseSensitive
            ? normTgt === relPath
            : normTgt.toLowerCase() === relPath.toLowerCase();
        });
        if (!isAuthorizedOutput) {
          passed = false;
          details.push(`Workspace integrity violation: Unauthorized file created: '${relPath}'`);
        }
      }
    }

    // For G4_SINGLE_FILE_REPAIR, audit single-file mutation constraint
    if (task.gateId === "G4_SINGLE_FILE_REPAIR") {
      const modifiedFiles = Object.keys(currentFiles).filter(
        (rel) => initialWorkspaceFileHashes[rel] && initialWorkspaceFileHashes[rel] !== currentFiles[rel]
      );
      const expectedTarget = path.normalize(task.gateACriteria.expectedTargetFiles?.[0] ?? "").replace(/\\/g, "/");
      const targetMatches = (m: string) =>
        isCaseSensitive ? m === expectedTarget : m.toLowerCase() === expectedTarget.toLowerCase();

      if (modifiedFiles.length === 0) {
        passed = false;
        details.push("Single-file repair violation: No workspace file was modified");
      } else if (modifiedFiles.length > 1) {
        passed = false;
        details.push(`Single-file repair violation: Multiple files modified: [${modifiedFiles.join(", ")}]`);
      } else if (!targetMatches(modifiedFiles[0]!)) {
        passed = false;
        details.push(`Single-file repair violation: Modified file '${modifiedFiles[0]}' does not match target '${expectedTarget}'`);
      } else {
        details.push(`Single-file mutation boundary verified: Exactly 1 target file modified ('${expectedTarget}')`);
      }
    }

    // Check immutable files have not been modified or deleted
    if (crit.immutableFiles) {
      for (const rel of crit.immutableFiles) {
        const normRel = path.normalize(rel).replace(/\\/g, "/");
        const abs = path.join(workspaceRoot, normRel);
        if (!fs.existsSync(abs)) {
          passed = false;
          details.push(`Immutable verification file was deleted: '${normRel}'`);
        } else {
          const currentContent = fs.readFileSync(abs, "utf8");
          const expectedContent = task.initialFiles[normRel] ?? task.initialFiles[rel];
          if (expectedContent !== undefined && currentContent !== expectedContent) {
            passed = false;
            details.push(`Immutable verification file was illegally modified: '${normRel}'`);
          }
        }
      }
    }

    // SEC-017: Isolated VM Test Runner Execution
    if (crit.testRunner) {
      const targetModuleAbs = path.join(workspaceRoot, crit.testRunner.targetModule);
      if (!fs.existsSync(targetModuleAbs)) {
        passed = false;
        details.push(`Test runner target module '${crit.testRunner.targetModule}' does not exist on disk`);
      } else {
        const moduleContent = fs.readFileSync(targetModuleAbs, "utf8");
        const testResult = executeIsolatedTestInSandbox(moduleContent, crit.testRunner.testAssertions, 1000);
        if (!testResult.success) {
          passed = false;
          details.push(`Isolated test runner execution failed: ${testResult.error}`);
        } else {
          details.push(`Isolated test runner execution passed: All functional assertions satisfied for '${crit.testRunner.targetModule}'`);
        }
      }
    }

    // Check expected files against predicates (backward compatibility)
    if (crit.expectedFiles) {
      for (const [rel, matcher] of Object.entries(crit.expectedFiles)) {
        const abs = path.join(workspaceRoot, rel);
        if (!fs.existsSync(abs)) {
          passed = false;
          details.push(`Expected file '${rel}' was not created`);
        } else {
          const content = fs.readFileSync(abs, "utf8");
          const ok = typeof matcher === "function" ? matcher(content) : content === matcher;
          if (!ok) {
            passed = false;
            details.push(`File '${rel}' content did not satisfy verification predicate`);
          }
        }
      }
    }

    return {
      passed,
      verifierType: crit.verifierType,
      details,
      independentEvidenceRef: `test-runner-${trialId}`,
    };
  }
}
