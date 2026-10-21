/**
 * Emerald Agent Fabric — Source Diagnostic Engine
 *
 * Implements bounded, non-authoritative syntax and type diagnostics
 * against isolated candidate mutations before sovereign verification.
 *
 * Adheres strictly to Section 4-13 invariants:
 * - Advisory only (authoritative: false, terminalAuthority: false, verificationAuthority: false)
 * - Safe deterministic discovery (no network, no package installs, no lockfile mutations)
 * - Aggressive context compression (<= 8 KB payload, <= 512 bytes/msg, <= 32 diagnostics)
 * - Error prioritization (syntax > type > modified file > dependency > warning)
 * - Full cryptographic evidence hashing & provenance recording
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { computeCanonicalHash } from "../../domain/canonical-hash.js";
import {
  DiagnosticConfig,
  DiagnosticItem,
  DiagnosticResult,
  DiagnosticStatus,
  DEFAULT_DIAGNOSTIC_CONFIG,
  formatDiagnosticObservation,
} from "./diagnostic-feedback.js";

const execFileAsync = promisify(execFile);

export class SourceDiagnosticEngine {
  private readonly config: DiagnosticConfig;
  private executionCountForRun = 0;

  constructor(configOverrides?: Partial<DiagnosticConfig>) {
    this.config = {
      ...DEFAULT_DIAGNOSTIC_CONFIG,
      ...configOverrides,
    };
  }

  /**
   * Reset execution counter for a new run.
   */
  public resetRunExecutionCount(): void {
    this.executionCountForRun = 0;
  }

  /**
   * Current execution count for the active run.
   */
  public getExecutionCount(): number {
    return this.executionCountForRun;
  }

  /**
   * Deterministically discovers a safe diagnostic command for the candidate workspace.
   * Priority:
   * 1. Explicit command override
   * 2. Repository package.json scripts (typecheck, check)
   * 3. Project tsconfig.json (tsc --noEmit)
   * 4. Node.js built-in syntax check (node --check <modifiedFile>)
   * 5. null -> UNSUPPORTED
   */
  public discoverDiagnosticCommand(
    workspacePath: string,
    modifiedFiles: readonly string[] = [],
  ): { cmd: string; args: string[]; language: string } | null {
    const pkgJsonPath = path.resolve(workspacePath, "package.json");
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
        const scripts = pkg.scripts || {};
        if (scripts.typecheck) {
          return { cmd: "npm", args: ["run", "typecheck", "--silent"], language: "typescript" };
        }
        if (scripts.check) {
          return { cmd: "npm", args: ["run", "check", "--silent"], language: "javascript" };
        }
      } catch {
        // Fall through to file checks if package.json is unparseable
      }
    }

    // Check for tsconfig.json
    const tsconfigPath = path.resolve(workspacePath, "tsconfig.json");
    if (fs.existsSync(tsconfigPath)) {
      const localTsc = path.resolve(workspacePath, "node_modules/.bin/tsc");
      const localTscCmd = path.resolve(workspacePath, "node_modules/.bin/tsc.cmd");
      const isWin = process.platform === "win32";
      if (isWin && fs.existsSync(localTscCmd)) {
        return { cmd: localTscCmd, args: ["--noEmit"], language: "typescript" };
      } else if (!isWin && fs.existsSync(localTsc)) {
        return { cmd: localTsc, args: ["--noEmit"], language: "typescript" };
      }
    }

    // Check for JavaScript files to check with Node.js built-in syntax verification
    const jsFiles = modifiedFiles.filter((f) => f.endsWith(".js") || f.endsWith(".mjs") || f.endsWith(".cjs"));
    if (jsFiles.length > 0) {
      const targetFile = jsFiles[0]!;
      return { cmd: process.execPath, args: ["--check", targetFile], language: "javascript" };
    }

    // Check for TypeScript files if no tsconfig
    const tsFiles = modifiedFiles.filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
    if (tsFiles.length > 0) {
      // Use node --check if node supports it or fallback
      const targetFile = tsFiles[0]!;
      return { cmd: process.execPath, args: ["--check", targetFile], language: "typescript" };
    }

    return null;
  }

  /**
   * Executes bounded diagnostics against candidate workspace state.
   */
  public async runDiagnostics(params: {
    workspacePath: string;
    runId: string;
    actionId?: string;
    attemptId?: string;
    modifiedFiles: readonly string[];
    explicitCommand?: { cmd: string; args: string[] };
  }): Promise<DiagnosticResult> {
    const startTime = Date.now();
    const diagnosticId = `diag-${params.runId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Compute inputHash from modified files
    const inputContents = params.modifiedFiles.map((f) => {
      const fullPath = path.resolve(params.workspacePath, f);
      return fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf8") : "";
    }).join("\n---FILE---\n");
    const inputHash = computeCanonicalHash(inputContents).contentHash;

    // Budget check: max executions per run
    if (this.executionCountForRun >= this.config.maxExecutionsPerRun) {
      return this.buildResult({
        diagnosticId,
        runId: params.runId,
        actionId: params.actionId,
        attemptId: params.attemptId,
        status: "UNSUPPORTED",
        diagnostics: [],
        summary: `Diagnostic execution budget reached (${this.config.maxExecutionsPerRun} max). Skipping diagnostic.`,
        durationMs: Date.now() - startTime,
        inputHash,
        outputHash: computeCanonicalHash("SKIPPED_BUDGET").contentHash,
        affectedFilesCount: params.modifiedFiles.length,
      });
    }

    // Discovery
    const command = params.explicitCommand ?? this.discoverDiagnosticCommand(params.workspacePath, params.modifiedFiles);
    if (!command) {
      return this.buildResult({
        diagnosticId,
        runId: params.runId,
        actionId: params.actionId,
        attemptId: params.attemptId,
        status: "UNSUPPORTED",
        diagnostics: [],
        summary: "No deterministic diagnostic tool discovered for workspace.",
        durationMs: Date.now() - startTime,
        inputHash,
        outputHash: computeCanonicalHash("UNSUPPORTED").contentHash,
        affectedFilesCount: params.modifiedFiles.length,
      });
    }

    // Security validation on command
    if (
      command.cmd.includes(";") ||
      command.cmd.includes("&") ||
      command.cmd.includes("|") ||
      command.cmd.includes("`") ||
      command.cmd.includes("$")
    ) {
      return this.buildResult({
        diagnosticId,
        runId: params.runId,
        actionId: params.actionId,
        attemptId: params.attemptId,
        status: "TOOL_ERROR",
        diagnostics: [
          {
            file: "workspace",
            severity: "error",
            message: `Command security violation: shell metacharacters rejected in '${command.cmd}'.`,
          },
        ],
        summary: "Diagnostic command rejected by security boundary.",
        durationMs: Date.now() - startTime,
        inputHash,
        outputHash: computeCanonicalHash("SECURITY_DENIAL").contentHash,
        affectedFilesCount: params.modifiedFiles.length,
      });
    }

    this.executionCountForRun++;

    // Execute isolated diagnostic check
    try {
      const { stdout, stderr } = await execFileAsync(command.cmd, command.args, {
        cwd: params.workspacePath,
        timeout: this.config.timeoutMs,
        maxBuffer: this.config.maxPayloadBytes * 2,
        env: {
          ...process.env,
          NODE_ENV: "test",
          CI: "true",
        },
      });

      const outputCombined = `${stdout}\n${stderr}`.trim();
      const outputHash = computeCanonicalHash(outputCombined).contentHash;

      return this.buildResult({
        diagnosticId,
        runId: params.runId,
        actionId: params.actionId,
        attemptId: params.attemptId,
        status: "PASS",
        diagnostics: [],
        summary: "Diagnostic checks passed with 0 errors.",
        durationMs: Date.now() - startTime,
        inputHash,
        outputHash,
        affectedFilesCount: params.modifiedFiles.length,
        commandExecuted: `${command.cmd} ${command.args.join(" ")}`,
      });
    } catch (err: any) {
      const isTimeout = err.killed && err.signal === "SIGTERM";
      if (isTimeout) {
        return this.buildResult({
          diagnosticId,
          runId: params.runId,
          actionId: params.actionId,
          attemptId: params.attemptId,
          status: "TIMEOUT",
          diagnostics: [
            {
              file: params.modifiedFiles[0] ?? "workspace",
              severity: "error",
              message: `Diagnostic timed out after ${this.config.timeoutMs}ms.`,
            },
          ],
          summary: `Diagnostic command timed out after ${this.config.timeoutMs}ms.`,
          durationMs: Date.now() - startTime,
          inputHash,
          outputHash: computeCanonicalHash("TIMEOUT").contentHash,
          affectedFilesCount: params.modifiedFiles.length,
          commandExecuted: `${command.cmd} ${command.args.join(" ")}`,
        });
      }

      const rawStderr = String(err.stderr || "");
      const rawStdout = String(err.stdout || "");
      const fullErrorText = `${rawStderr}\n${rawStdout}\n${err.message || ""}`;
      const outputHash = computeCanonicalHash(fullErrorText).contentHash;

      // Parse structured diagnostics
      const parsedDiagnostics = this.parseDiagnosticOutput(
        fullErrorText,
        params.workspacePath,
        params.modifiedFiles,
      );

      // Prioritize and determine overall status
      const prioritized = this.prioritizeDiagnostics(parsedDiagnostics, params.modifiedFiles);
      const hasSyntax = prioritized.some((d) => d.severity === "error" && (d.message.toLowerCase().includes("syntax") || d.diagnosticCode?.includes("SYNTAX")));
      const hasType = prioritized.some((d) => d.severity === "error" && (d.diagnosticCode?.startsWith("TS") || d.message.toLowerCase().includes("type")));

      let status: DiagnosticStatus = "LINT_ERROR";
      if (hasSyntax) status = "SYNTAX_ERROR";
      else if (hasType) status = "TYPE_ERROR";

      return this.buildResult({
        diagnosticId,
        runId: params.runId,
        actionId: params.actionId,
        attemptId: params.attemptId,
        status,
        diagnostics: prioritized.slice(0, this.config.maxDiagnostics),
        summary: `Detected ${prioritized.length} diagnostic error(s) [${status}].`,
        durationMs: Date.now() - startTime,
        inputHash,
        outputHash,
        affectedFilesCount: params.modifiedFiles.length,
        commandExecuted: `${command.cmd} ${command.args.join(" ")}`,
      });
    }
  }

  /**
   * Parses raw compiler/interpreter output into structured DiagnosticItems.
   */
  private parseDiagnosticOutput(
    rawText: string,
    workspacePath: string,
    modifiedFiles: readonly string[],
  ): DiagnosticItem[] {
    const items: DiagnosticItem[] = [];
    const lines = rawText.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]?.trim();
      if (!line) continue;

      // 1. Node.js / JavaScript SyntaxError pattern:
      // SyntaxError: Unexpected token '}' in file.js:14:5
      // or file.js:14
      // SyntaxError: Unexpected token '{'
      if (line.includes("SyntaxError:")) {
        const syntaxMsg = line.slice(line.indexOf("SyntaxError:"));
        let targetFile = modifiedFiles[0] ?? "unknown.js";
        let lineNum: number | undefined;
        let colNum: number | undefined;

        // Check if preceding or subsequent lines contain file:line:col
        const locMatch = rawText.match(/([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+):(\d+)(?::(\d+))?/);
        if (locMatch) {
          targetFile = path.relative(workspacePath, locMatch[1]!).replace(/\\/g, "/");
          lineNum = parseInt(locMatch[2]!, 10);
          if (locMatch[3]) colNum = parseInt(locMatch[3], 10);
        }

        items.push({
          file: targetFile,
          line: lineNum,
          column: colNum,
          severity: "error",
          diagnosticCode: "SYNTAX_ERR",
          message: syntaxMsg,
        });
        continue;
      }

      // 2. TypeScript compiler error pattern:
      // src/foo.ts(42,17): error TS1005: ';' expected.
      const tsMatch = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/);
      if (tsMatch) {
        const rawFile = tsMatch[1]!;
        const relFile = path.isAbsolute(rawFile)
          ? path.relative(workspacePath, rawFile).replace(/\\/g, "/")
          : rawFile.replace(/\\/g, "/");

        items.push({
          file: relFile,
          line: parseInt(tsMatch[2]!, 10),
          column: parseInt(tsMatch[3]!, 10),
          severity: tsMatch[4] === "error" ? "error" : "warning",
          diagnosticCode: tsMatch[5],
          message: tsMatch[6]!,
        });
        continue;
      }

      // 3. Generic standard error pattern:
      // foo.js:42:17: error: message
      const stdMatch = line.match(/^(.+?):(\d+)(?::(\d+))?:\s+(error|warning):\s+(.+)$/i);
      if (stdMatch) {
        const rawFile = stdMatch[1]!;
        const relFile = path.isAbsolute(rawFile)
          ? path.relative(workspacePath, rawFile).replace(/\\/g, "/")
          : rawFile.replace(/\\/g, "/");

        items.push({
          file: relFile,
          line: parseInt(stdMatch[2]!, 10),
          column: stdMatch[3] ? parseInt(stdMatch[3], 10) : undefined,
          severity: stdMatch[4]!.toLowerCase() === "error" ? "error" : "warning",
          message: stdMatch[5]!,
        });
        continue;
      }
    }

    // Fallback if raw text has errors but regex didn't extract structured lines
    if (items.length === 0 && rawText.toLowerCase().includes("error")) {
      items.push({
        file: modifiedFiles[0] ?? "workspace",
        severity: "error",
        message: rawText.slice(0, this.config.maxMessageBytes),
      });
    }

    return items;
  }

  /**
   * Prioritize diagnostics according to Section 11:
   * 1. Syntax errors
   * 2. Type errors
   * 3. Errors directly in modified files
   * 4. Dependency errors
   * 5. Warnings
   */
  private prioritizeDiagnostics(
    diagnostics: readonly DiagnosticItem[],
    modifiedFiles: readonly string[],
  ): DiagnosticItem[] {
    const normModified = new Set(modifiedFiles.map((f) => f.replace(/\\/g, "/")));

    return [...diagnostics].sort((a, b) => {
      // 1. Errors before warnings
      if (a.severity !== b.severity) {
        if (a.severity === "error") return -1;
        if (b.severity === "error") return 1;
      }

      // 2. Syntax errors before type errors
      const aIsSyntax = a.message.toLowerCase().includes("syntax") || a.diagnosticCode?.includes("SYNTAX") || a.diagnosticCode === "TS1005";
      const bIsSyntax = b.message.toLowerCase().includes("syntax") || b.diagnosticCode?.includes("SYNTAX") || b.diagnosticCode === "TS1005";
      if (aIsSyntax && !bIsSyntax) return -1;
      if (!aIsSyntax && bIsSyntax) return 1;

      // 3. Modified files before other files
      const aInMod = normModified.has(a.file);
      const bInMod = normModified.has(b.file);
      if (aInMod && !bInMod) return -1;
      if (!aInMod && bInMod) return 1;

      return 0;
    });
  }

  /**
   * Helper to construct a strictly non-authoritative DiagnosticResult.
   */
  private buildResult(params: {
    diagnosticId: string;
    runId?: string;
    actionId?: string;
    attemptId?: string;
    status: DiagnosticStatus;
    diagnostics: readonly DiagnosticItem[];
    summary: string;
    durationMs: number;
    inputHash: string;
    outputHash: string;
    affectedFilesCount: number;
    commandExecuted?: string;
  }): DiagnosticResult {
    const rawResult: Omit<DiagnosticResult, "feedbackObservationText"> = {
      diagnosticId: params.diagnosticId,
      runId: params.runId,
      actionId: params.actionId,
      attemptId: params.attemptId,
      status: params.status,
      diagnostics: params.diagnostics,
      summary: params.summary,
      durationMs: params.durationMs,
      inputHash: params.inputHash,
      outputHash: params.outputHash,
      affectedFilesCount: params.affectedFilesCount,
      commandExecuted: params.commandExecuted,
      timestamp: new Date().toISOString(),
      authoritative: false,
      terminalAuthority: false,
      verificationAuthority: false,
      policyAuthority: false,
    };

    const feedbackObservationText = formatDiagnosticObservation(
      rawResult as DiagnosticResult,
      this.config.maxPayloadBytes,
      this.config.maxMessageBytes,
    );

    return {
      ...rawResult,
      feedbackObservationText,
    };
  }
}
