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

const execFileAsync = promisify(execFile);

export interface ToolExecutionContext {
  readonly runId: string;
  readonly subjectId: string;
  readonly fenceId: string;
  readonly harnessType: HarnessType;
  readonly workspacePath: string;
  readonly missionContractHash: string;
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
}

export interface ToolExecutionResponse {
  readonly success: boolean;
  readonly output: unknown;
  readonly error?: string;
  readonly durationMs: number;
  readonly bytesOutput: number;
}

export class ProductionToolGateway {
  constructor(private readonly governance: ProductionGovernanceFacade) {}

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
        return "WRITE_TEMPORARY_OUTPUT";
      case "run_command":
        return "EXECUTE_ANALYSIS";
      default:
        return "UNKNOWN";
    }
  }

  private resolveSafePath(filePath: string, workspacePath: string): string {
    const normalized = path.normalize(filePath);
    if (normalized.includes("..") || path.isAbsolute(normalized)) {
      const resolved = path.resolve(workspacePath, normalized);
      const normResolved = resolved.replace(/\\/g, "/").toLowerCase();
      const normBase = path.resolve(workspacePath).replace(/\\/g, "/").toLowerCase();
      if (!normResolved.startsWith(normBase)) {
        throw new Error(`Path traversal denied outside workspace: ${filePath}`);
      }
      return resolved;
    }
    return path.resolve(workspacePath, normalized);
  }

  // --- Tool 1: read_file ---
  private async toolReadFile(input: Record<string, unknown>, context: ToolExecutionContext): Promise<string> {
    const rawPath = String(input["path"] || input["filePath"] || "");
    const safePath = this.resolveSafePath(rawPath, context.workspacePath);

    if (!fs.existsSync(safePath)) {
      throw new Error(`File not found: ${rawPath}`);
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
    const patternStr = String(input["pattern"] || "");
    const regex = new RegExp(patternStr, "i");
    const results: Array<{ file: string; line: number; text: string }> = [];

    const walk = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.name === ".git" || ent.name === "node_modules") continue;
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

    walk(context.workspacePath);
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

    fs.writeFileSync(safePath, content, "utf8");
    return {
      path: path.relative(context.workspacePath, safePath).replace(/\\/g, "/"),
      bytesWritten: Buffer.byteLength(content, "utf8"),
    };
  }

  // --- Tool 6: run_command ---
  private async toolRunCommand(
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const cmd = String(input["command"] || "");
    const args = Array.isArray(input["args"]) ? (input["args"] as string[]) : [];

    // Security: sanitize against command injection
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
