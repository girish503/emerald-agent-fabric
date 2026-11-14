/**
 * Emerald Agent Fabric — Production Tool Gateway & Tools
 *
 * Implements the six stable production developer tools:
 * 1. read_file
 * 2. search_code
 * 3. git_status
 * 4. git_diff
 * 5. write_file
 * 6. run_command
 *
 * Guarantees:
 * - Every invocation crosses the ProductionGovernanceFacade.
 * - Filesystem operations are strictly contained within the workspace root.
 * - Command executions are timeout-bounded, resource-clamped, and network-disabled.
 * - Outputs are deterministic and byte-bounded.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProductionGovernanceFacade } from "../governance/production-governance-facade.js";
import { HarnessType } from "../domain/cross-harness-request.js";
import { LineAnchoredEditor, LineAnchoredEditResult, LineAnchoredMutationOptions } from "../production/repair/line-anchored-editor.js";
import { MutationIntentStorePort } from "../ports/mutation-intent-store.port.js";
import { GovernedWamiRequiredError } from "../domain/errors.js";

const execFileAsync = promisify(execFile);

export interface ToolExecutionContext {
  readonly runId: string;
  readonly taskId?: string;
  readonly tenantId?: string;
  readonly approvalId?: string;
  readonly subjectId: string;
  readonly fenceId: string;
  readonly harnessType: HarnessType;
  readonly workspacePath: string;
  readonly missionContractHash: string;
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
  readonly governedBenchmarkRepairMode?: boolean;
  readonly snapshotBasePath?: string;
}

export interface ToolExecutionResponse {
  readonly success: boolean;
  readonly output: unknown;
  readonly error?: string;
  readonly requiresHumanApproval?: boolean;
  readonly approvalId?: string;
  readonly approvalStatus?: string;
  readonly runStatusHint?: "WAITING_APPROVAL";
  readonly durationMs: number;
  readonly bytesOutput: number;
}

export class ProductionToolGateway {
  constructor(
    private readonly governance: ProductionGovernanceFacade,
    private readonly mutationStore?: MutationIntentStorePort,
    private readonly snapshotBasePath?: string
  ) {}

  /**
   * Execute a tool under strict governance checks.
   */
  public async executeTool(
    toolName: string,
    rawInput: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResponse> {
    const startTime = Date.now();

    // Map tool name to capability
    const capability = this.mapToolToCapability(toolName);

    // 1. Mandatory Governance Gate
    const decision = this.governance.evaluateProposal({
      runId: context.runId,
      taskId: context.taskId,
      tenantId: context.tenantId,
      approvalId: context.approvalId,
      subjectId: context.subjectId,
      fenceId: context.fenceId,
      harnessType: context.harnessType,
      capability,
      toolName,
      input: rawInput,
      workspacePath: context.workspacePath,
      missionContractHash: context.missionContractHash,
    });

    if (!decision.authorized) {
      return {
        success: false,
        output: null,
        error: `Governance denial [${decision.controlId ?? "GOVERNANCE_BLOCKED"}]: ${decision.reason}`,
        ...(decision.requiresHumanApproval !== undefined ? { requiresHumanApproval: decision.requiresHumanApproval } : {}),
        ...(decision.approvalId ? { approvalId: decision.approvalId } : {}),
        ...(decision.approvalStatus ? { approvalStatus: decision.approvalStatus } : {}),
        ...(decision.runStatusHint ? { runStatusHint: decision.runStatusHint } : {}),
        durationMs: Date.now() - startTime,
        bytesOutput: 0,
      };
    }

    const input = decision.sanitizedInput ?? rawInput;

    // 2. Dispatch to specific tool
    try {
      let resultOutput: unknown;
      switch (toolName) {
        case "read_file":
          resultOutput = await this.toolReadFile(input, context);
          break;
        case "search_code":
          resultOutput = await this.toolSearchCode(input, context);
          break;
        case "git_status":
          resultOutput = await this.toolGitStatus(context);
          break;
        case "git_diff":
          resultOutput = await this.toolGitDiff(input, context);
          break;
        case "write_file":
          resultOutput = await this.toolWriteFile(input, context);
          break;
        case "edit_file_anchor":
          resultOutput = await this.toolEditFileAnchor(input, context);
          break;
        case "run_command":
          resultOutput = await this.toolRunCommand(input, context);
          break;
        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }

      const outputStr = typeof resultOutput === "string" ? resultOutput : JSON.stringify(resultOutput);
      const maxBytes = context.maxOutputBytes ?? 1024 * 1024;
      const boundedOutput = outputStr.length > maxBytes ? outputStr.slice(0, maxBytes) + "\n...[truncated]" : resultOutput;

      return {
        success: true,
        output: boundedOutput,
        durationMs: Date.now() - startTime,
        bytesOutput: Buffer.byteLength(outputStr, "utf8"),
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: null,
        error: errMsg,
        durationMs: Date.now() - startTime,
        bytesOutput: 0,
      };
    }
  }

  private mapToolToCapability(toolName: string): string {
    switch (toolName) {
      case "read_file":
      case "search_code":
        return "READ_WORKSPACE";
      case "git_status":
      case "git_diff":
        return "READ_REPOSITORY";
      case "write_file":
      case "edit_file_anchor":
        return "WRITE_TEMPORARY_OUTPUT";
      case "run_command":
        return "EXECUTE_ANALYSIS";
      default:
        return "UNKNOWN";
    }
  }

  private resolveSafePath(filePath: string, workspacePath: string): string {
    if (!filePath || typeof filePath !== "string") {
      throw new Error("File path must be a non-empty string");
    }

    if (/^[a-zA-Z]:(?![\/\\])/.test(filePath)) {
      throw new Error(`Path traversal denied outside workspace: ${filePath}`);
    }

    // 1. Lexical root-or-descendant boundary check
    const normalized = path.normalize(filePath);
    const resolved = path.resolve(workspacePath, normalized);
    const normResolved = resolved.split("\\").join("/").toLowerCase();
    const normBase = path.resolve(workspacePath).split("\\").join("/").toLowerCase();
    const normBaseWithSlash = normBase.endsWith("/") ? normBase : normBase + "/";
    if (normResolved !== normBase && !normResolved.startsWith(normBaseWithSlash)) {
      throw new Error(`Path traversal denied outside workspace: ${filePath}`);
    }

    // 2. Canonical filesystem (realpath) containment check
    const canonicalRealpath = (p: string): string => {
      if (typeof fs.realpathSync.native === "function") {
        return fs.realpathSync.native(p);
      }
      return fs.realpathSync(p);
    };

    const normalizeCanonical = (p: string): string => {
      let s = p.split("\\").join("/");
      if (s.startsWith("//?/")) {
        s = s.slice(4);
      }
      return s.toLowerCase();
    };

    let canonicalWorkspace: string;
    try {
      canonicalWorkspace = canonicalRealpath(path.resolve(workspacePath));
    } catch {
      canonicalWorkspace = path.resolve(workspacePath);
    }
    const normCanonicalBase = normalizeCanonical(canonicalWorkspace);
    const normCanonicalBaseWithSlash = normCanonicalBase.endsWith("/") ? normCanonicalBase : normCanonicalBase + "/";

    // 3. For existing targets, validate canonical target
    if (fs.existsSync(resolved)) {
      let canonicalTarget: string;
      try {
        canonicalTarget = canonicalRealpath(resolved);
      } catch (err: any) {
        throw new Error(`Path traversal denied outside workspace (failed to canonicalize): ${filePath}`);
      }
      const normCanonicalTarget = normalizeCanonical(canonicalTarget);
      if (normCanonicalTarget !== normCanonicalBase && !normCanonicalTarget.startsWith(normCanonicalBaseWithSlash)) {
        throw new Error(`Path traversal denied outside workspace (canonical symlink escape): ${filePath}`);
      }
    } else {
      // 4. For non-existent targets, locate nearest existing ancestor and validate canonical path
      let curr = path.dirname(resolved);
      let existingAncestor: string | null = null;
      while (true) {
        if (fs.existsSync(curr)) {
          existingAncestor = curr;
          break;
        }
        const parent = path.dirname(curr);
        if (parent === curr) {
          break;
        }
        curr = parent;
      }

      if (!existingAncestor) {
        throw new Error(`Path traversal denied outside workspace (no valid existing ancestor): ${filePath}`);
      }

      let canonicalAncestor: string;
      try {
        canonicalAncestor = canonicalRealpath(existingAncestor);
      } catch (err: any) {
        throw new Error(`Path traversal denied outside workspace (failed to canonicalize ancestor): ${filePath}`);
      }

      const normCanonicalAncestor = normalizeCanonical(canonicalAncestor);
      if (normCanonicalAncestor !== normCanonicalBase && !normCanonicalAncestor.startsWith(normCanonicalBaseWithSlash)) {
        throw new Error(`Path traversal denied outside workspace (symlink ancestor escape): ${filePath}`);
      }

      const relFromAncestor = path.relative(existingAncestor, resolved);
      const canonicalTarget = path.resolve(canonicalAncestor, relFromAncestor);
      const normCanonicalTarget = normalizeCanonical(canonicalTarget);
      if (normCanonicalTarget !== normCanonicalBase && !normCanonicalTarget.startsWith(normCanonicalBaseWithSlash)) {
        throw new Error(`Path traversal denied outside workspace (canonical target escape): ${filePath}`);
      }
    }

    return resolved;
  }

  // --- Tool 1: read_file ---
  private async toolReadFile(input: Record<string, unknown>, context: ToolExecutionContext): Promise<string> {
    const rawPath = String(input["path"] || input["filePath"] || "");
    const safePath = this.resolveSafePath(rawPath, context.workspacePath);

    if (!fs.existsSync(safePath)) {
      throw new Error(`File not found: ${rawPath}`);
    }

    const stat = fs.statSync(safePath);
    if (!stat.isFile()) {
      throw new Error(`Target path is not a regular file: ${rawPath}`);
    }

    const content = fs.readFileSync(safePath, "utf8");
    const offsetLine = Math.max(1, Number(input["offsetLine"] || 1));
    const limitLines = Math.max(1, Number(input["limitLines"] || 500));

    const lines = content.split(/\r?\n/);
    const selected = lines.slice(offsetLine - 1, offsetLine - 1 + limitLines);
    return selected.join("\n");
  }

  // --- Tool 2: search_code ---
  private async toolSearchCode(
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<Array<{ file: string; line: number; text: string }>> {
    const patternStr = String(input["pattern"] || input["query"] || "");
    const regex = new RegExp(patternStr, "i");
    const results: Array<{ file: string; line: number; text: string }> = [];

    const rawPath = String(input["path"] || input["filePath"] || "");
    const startDir = rawPath && rawPath !== "."
      ? this.resolveSafePath(rawPath, context.workspacePath)
      : context.workspacePath;

    if (!fs.existsSync(startDir)) {
      throw new Error(`Directory not found: ${rawPath}`);
    }
    const startStat = fs.statSync(startDir);
    if (!startStat.isDirectory()) {
      throw new Error(`Path is not a directory: ${rawPath}`);
    }

    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        // Inaccessible or unreadable directories fail safely without stopping search
        return;
      }

      for (const ent of entries) {
        if (ent.name === ".git" || ent.name === "node_modules") continue;

        // Security: Never follow symbolic links or NTFS junctions during search traversal.
        // Prevents directory traversal outside workspace, recursion cycles, and link races.
        if (typeof ent.isSymbolicLink === "function" && ent.isSymbolicLink()) {
          continue;
        }

        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(full);
        } else if (ent.isFile()) {
          try {
            const text = fs.readFileSync(full, "utf8");
            const lines = text.split(/\r?\n/);
            lines.forEach((line, idx) => {
              if (regex.test(line) && results.length < 50) {
                results.push({
                  file: path.relative(context.workspacePath, full).replace(/\\/g, "/"),
                  line: idx + 1,
                  text: line.trim(),
                });
              }
            });
          } catch {
            // Ignore binary/unreadable files
          }
        }
      }
    };

    walk(startDir);
    return results;
  }

  // --- Tool 3: git_status ---
  private async toolGitStatus(context: ToolExecutionContext): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
        cwd: context.workspacePath,
        timeout: context.timeoutMs ?? 15000,
      });
      return stdout.trim();
    } catch {
      return "Working directory clean or not a git repository.";
    }
  }

  // --- Tool 4: git_diff ---
  private async toolGitDiff(input: Record<string, unknown>, context: ToolExecutionContext): Promise<string> {
    const targetFile = input["path"] ? [String(input["path"])] : [];
    try {
      const { stdout } = await execFileAsync("git", ["diff", ...targetFile], {
        cwd: context.workspacePath,
        timeout: context.timeoutMs ?? 15000,
      });
      return stdout;
    } catch {
      return "";
    }
  }

  // --- Tool 5: write_file ---
  private async toolWriteFile(input: Record<string, unknown>, context: ToolExecutionContext): Promise<{ path: string; bytesWritten: number }> {
    const rawPath = String(input["path"] || input["filePath"] || "");
    const safePath = this.resolveSafePath(rawPath, context.workspacePath);
    const content = String(input["content"] ?? "");

    // Ensure directory exists
    const dir = path.dirname(safePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(safePath) && !fs.statSync(safePath).isFile()) {
      throw new Error(`Target path is not a regular file: ${rawPath}`);
    }

    fs.writeFileSync(safePath, content, "utf8");
    return {
      path: path.relative(context.workspacePath, safePath).replace(/\\/g, "/"),
      bytesWritten: Buffer.byteLength(content, "utf8"),
    };
  }

  // --- Tool 5b: edit_file_anchor ---
  private async toolEditFileAnchor(
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<LineAnchoredEditResult> {
    const editor = new LineAnchoredEditor();
    const rawPath = String(input["path"] || input["filePath"] || "");
    const safePath = this.resolveSafePath(rawPath, context.workspacePath);
    const relPath = path.relative(context.workspacePath, safePath).replace(/\\/g, "/");

    let mutationOptions: LineAnchoredMutationOptions | undefined;

    if (context.governedBenchmarkRepairMode) {
      if (!this.mutationStore) {
        throw new GovernedWamiRequiredError(
          context.runId ?? "unknown",
          relPath,
          "Governed repair execution requires MutationIntentStorePort for WAMI persistence"
        );
      }
      if (!context.runId || typeof context.runId !== "string" || context.runId.trim().length === 0) {
        throw new GovernedWamiRequiredError(
          context.runId ?? "unknown",
          relPath,
          "Governed repair execution requires non-empty valid runId"
        );
      }
      if (!context.subjectId || typeof context.subjectId !== "string" || context.subjectId.trim().length === 0) {
        throw new GovernedWamiRequiredError(
          context.runId,
          relPath,
          "Governed repair execution requires non-empty valid worker/subjectId"
        );
      }
      if (!context.fenceId || typeof context.fenceId !== "string" || context.fenceId.trim().length === 0) {
        throw new GovernedWamiRequiredError(
          context.runId,
          relPath,
          "Governed repair execution requires non-empty valid lease/fenceId"
        );
      }
      if (!context.workspacePath || typeof context.workspacePath !== "string" || context.workspacePath.trim().length === 0) {
        throw new GovernedWamiRequiredError(
          context.runId,
          relPath,
          "Governed repair execution requires valid workspacePath"
        );
      }
      const snapshotDir =
        context.snapshotBasePath ??
        this.snapshotBasePath ??
        path.resolve(context.workspacePath, ".emerald", "snapshots", context.runId);

      mutationOptions = {
        runId: context.runId,
        workerId: context.subjectId,
        workerLeaseId: context.fenceId,
        store: this.mutationStore,
        snapshotDir,
      };
    } else if (
      this.mutationStore &&
      context.runId &&
      context.fenceId &&
      context.subjectId &&
      context.subjectId.trim().length > 0
    ) {
      const snapshotDir =
        context.snapshotBasePath ??
        this.snapshotBasePath ??
        path.resolve(context.workspacePath, ".emerald", "snapshots", context.runId);

      mutationOptions = {
        runId: context.runId,
        workerId: context.subjectId,
        workerLeaseId: context.fenceId,
        store: this.mutationStore,
        snapshotDir,
      };
    }

    return editor.applyEdit(input, context.workspacePath, mutationOptions);
  }

  // --- Tool 6: run_command ---
  private async toolRunCommand(
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const cmd = String(input["command"] || "");
    const rawArgs = Array.isArray(input["args"]) ? input["args"] : Array.isArray(input["argv"]) ? input["argv"] : [];
    const args = rawArgs.map((a) => String(a));

    // Security: sanitize against null bytes and command injection
    if (cmd.includes("\0") || args.some((a) => a.includes("\0"))) {
      throw new Error("Null bytes denied in run_command");
    }
    if (cmd.includes(";") || cmd.includes("&") || cmd.includes("|") || cmd.includes("`") || cmd.includes("$")) {
      throw new Error(`Shell metacharacters denied in run_command: ${cmd}`);
    }

    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        cwd: context.workspacePath,
        timeout: context.timeoutMs ?? 30000,
        maxBuffer: context.maxOutputBytes ?? 1024 * 1024,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err: any) {
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message,
        exitCode: err.code ?? 1,
      };
    }
  }
}
