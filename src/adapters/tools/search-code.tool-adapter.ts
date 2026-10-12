/**
 * Search Code Tool Adapter for Emerald Agent Fabric.
 *
 * Implements deterministic in-process workspace file searching using Phase 3 WorkspacePort.
 *
 * Security & Governance Invariants:
 * 1. Controlled In-Process Traversal: NO external grep, ripgrep, find, or shell commands.
 * 2. Strict Workspace Containment: Path resolution enforced via WorkspacePort. Traversal
 *    is confined strictly within the designated workspace boundary.
 * 3. Deterministic Ordering: Traversal orders entries lexicographically, producing
 *    identical results across executions (file ASC, line ASC).
 * 4. Bounded Consumption: Enforces maxResults and maxOutputBytes ceilings, with explicit
 *    truncation representation. Skips binary files and ignores VCS metadata (.git).
 * 5. ReDoS Mitigation: Regex queries are bounded and validated prior to execution.
 * 6. Cancellation: Periodically checks AbortSignal during filesystem traversal.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  InvalidToolInputError,
  InvalidWorkspacePathError,
  ToolCancelledError,
  ToolExecutionFailedError,
  ToolWorkspaceBoundaryViolationError,
  WorkspacePathOutsideBoundaryError,
} from "../../domain/errors.js";
import {
  SearchCodeInput,
  SearchCodeMatch,
  SearchCodeOutput,
} from "../../domain/tool-schemas.js";
import {
  ToolAdapter,
  ToolExecutionContext,
} from "../../ports/tool-adapter.port.js";
import { WorkspacePort } from "../../ports/workspace.port.js";

const MAX_SEARCHABLE_FILE_BYTES = 10 * 1024 * 1024; // 10 MB limit per file to prevent memory exhaustion
const BINARY_CHECK_BYTES = 1024; // Sample size for detecting binary content (null bytes)

export class SearchCodeToolAdapter implements ToolAdapter<"search_code"> {
  readonly toolName = "search_code" as const;

  constructor(private readonly workspacePort: WorkspacePort) {}

  async execute(
    context: ToolExecutionContext,
    input: SearchCodeInput
  ): Promise<SearchCodeOutput> {
    // 1. Initial cancellation check
    if (context.abortSignal?.aborted) {
      throw new ToolCancelledError(this.toolName, context.abortSignal.reason?.message);
    }

    // 2. Resolve search directory relative to workspace boundary
    const targetRelPath = input.path ?? ".";
    let searchHostPath: string;
    try {
      searchHostPath = await this.workspacePort.resolvePath(
        context.workspace.workspaceId,
        targetRelPath
      );
    } catch (err: unknown) {
      if (
        err instanceof WorkspacePathOutsideBoundaryError ||
        err instanceof InvalidWorkspacePathError
      ) {
        throw new ToolWorkspaceBoundaryViolationError(
          this.toolName,
          targetRelPath,
          err.message
        );
      }
      throw new ToolExecutionFailedError(
        this.toolName,
        `Failed to resolve search path '${targetRelPath}': ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Canonical workspace root for computing relative display paths
    const workspaceHostRoot = context.workspace.hostPath;

    // 3. Prepare query matcher (Regex vs Literal)
    let regexMatcher: RegExp | null = null;
    if (input.isRegex) {
      // ReDoS basic sanity validation
      if (/(\w\+)+|(\w\*)+|([a-zA-Z]\+)\+/.test(input.query)) {
        throw new InvalidToolInputError(
          this.toolName,
          "Potential catastrophic backtracking pattern rejected in regex query"
        );
      }

      try {
        regexMatcher = new RegExp(input.query);
      } catch (err: unknown) {
        throw new InvalidToolInputError(
          this.toolName,
          `Invalid regular expression '${input.query}': ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // 4. File pattern filter
    const patternRegex = this.compileGlob(input.filePattern ?? "*");

    // 5. Compute effective resource limits
    const maxResults = Math.min(input.maxResults ?? 50, 1000);
    const maxOutputBytes = Math.min(
      input.maxBytes ?? context.resourceLimits.maxOutputBytes,
      context.resourceLimits.maxOutputBytes
    );

    // 6. Traverse and collect matching occurrences deterministically
    const matches: SearchCodeMatch[] = [];
    let totalOutputBytes = 0;
    let isTruncated = false;

    // Collect all candidate file paths deterministically
    const candidateFiles = await this.collectFiles(
      searchHostPath,
      patternRegex,
      context.abortSignal
    );

    for (const filePath of candidateFiles) {
      if (context.abortSignal?.aborted) {
        throw new ToolCancelledError(this.toolName, context.abortSignal.reason?.message);
      }

      if (matches.length >= maxResults || totalOutputBytes >= maxOutputBytes) {
        isTruncated = true;
        break;
      }

      const fileMatches = await this.searchFile(
        filePath,
        workspaceHostRoot,
        input.query,
        regexMatcher,
        maxResults - matches.length,
        maxOutputBytes - totalOutputBytes
      );

      for (const m of fileMatches.matches) {
        const itemBytes = Buffer.byteLength(m.content, "utf8") + m.file.length + 16;
        if (matches.length >= maxResults || totalOutputBytes + itemBytes > maxOutputBytes) {
          isTruncated = true;
          break;
        }
        matches.push(m);
        totalOutputBytes += itemBytes;
      }

      if (fileMatches.hitLimit || matches.length >= maxResults || totalOutputBytes >= maxOutputBytes) {
        isTruncated = true;
        break;
      }
    }

    // 7. Stable ordering: file ASC, line ASC
    matches.sort((a, b) => {
      const cmp = a.file.localeCompare(b.file);
      if (cmp !== 0) return cmp;
      return a.line - b.line;
    });

    return {
      query: input.query,
      matches,
      totalMatches: matches.length,
      truncated: isTruncated,
    };
  }

  /**
   * Recursively discovers files matching pattern in deterministic alphabetical order.
   */
  private async collectFiles(
    dirPath: string,
    pattern: RegExp,
    signal?: AbortSignal
  ): Promise<string[]> {
    const results: string[] = [];

    const walk = async (currentDir: string) => {
      if (signal?.aborted) return;

      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      // Deterministic alphabetical sort
      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        if (signal?.aborted) return;

        // Skip VCS metadata, hidden staging files, and workspace internal metadata
        if (
          entry.name === ".git" ||
          entry.name === ".emerald-workspace.json" ||
          entry.name.startsWith(".tmp.")
        ) {
          continue;
        }

        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          if (pattern.test(entry.name)) {
            results.push(fullPath);
          }
        }
      }
    };

    let rootStat: import("node:fs").Stats;
    try {
      rootStat = await fs.lstat(dirPath);
    } catch {
      return [];
    }

    if (rootStat.isDirectory()) {
      await walk(dirPath);
    } else if (rootStat.isFile()) {
      results.push(dirPath);
    }

    return results;
  }

  /**
   * Scans a single text file line-by-line for occurrences.
   */
  private async searchFile(
    filePath: string,
    workspaceRoot: string,
    query: string,
    regex: RegExp | null,
    remainingMatches: number,
    remainingBytes: number
  ): Promise<{ matches: SearchCodeMatch[]; hitLimit: boolean }> {
    const matches: SearchCodeMatch[] = [];

    let stats: import("node:fs").Stats;
    try {
      stats = await fs.stat(filePath);
    } catch {
      return { matches, hitLimit: false };
    }

    // Skip oversized files
    if (stats.size > MAX_SEARCHABLE_FILE_BYTES) {
      return { matches, hitLimit: false };
    }

    // Check for binary content by inspecting leading bytes
    try {
      const fd = await fs.open(filePath, "r");
      try {
        const sample = Buffer.alloc(BINARY_CHECK_BYTES);
        const { bytesRead } = await fd.read(sample, 0, BINARY_CHECK_BYTES, 0);
        for (let i = 0; i < bytesRead; i++) {
          if (sample[i] === 0) {
            // Null byte detected -> treat as binary and skip
            return { matches, hitLimit: false };
          }
        }
      } finally {
        await fd.close();
      }
    } catch {
      return { matches, hitLimit: false };
    }

    // Read UTF-8 text and scan lines
    let text: string;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch {
      return { matches, hitLimit: false };
    }

    // Compute canonical workspace-relative path (always using forward slashes)
    const relFile = path.relative(workspaceRoot, filePath).replace(/\\/g, "/");

    const lines = text.split(/\r?\n/);
    let bytesAccumulated = 0;
    let hitLimit = false;

    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= remainingMatches || bytesAccumulated >= remainingBytes) {
        hitLimit = true;
        break;
      }

      const line = lines[i]!;
      const isMatch = regex ? regex.test(line) : line.includes(query);

      if (isMatch) {
        // Truncate overly long single lines in results for safety (500 chars max)
        const displayContent = line.length > 500 ? line.slice(0, 500) + "..." : line;
        const entryBytes = Buffer.byteLength(displayContent, "utf8") + relFile.length + 16;

        if (bytesAccumulated + entryBytes > remainingBytes) {
          hitLimit = true;
          break;
        }

        matches.push({
          file: relFile,
          line: i + 1,
          content: displayContent,
        });
        bytesAccumulated += entryBytes;
      }
    }

    return { matches, hitLimit };
  }

  /**
   * Compiles simple glob pattern (e.g. "*.ts", "test_*.js") to RegExp.
   */
  private compileGlob(glob: string): RegExp {
    if (glob === "*" || glob.trim() === "") {
      return /^.*$/;
    }
    const escaped = glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`);
  }
}
