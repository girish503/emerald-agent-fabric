/**
 * Git Diff Tool Adapter for Emerald Agent Fabric.
 *
 * Implements typed, workspace-confined unified diff generation
 * without spawning external git processes or shell commands.
 *
 * Security & Governance Invariants:
 * 1. Zero Subprocesses: NO child_process, NO exec, NO spawn, NO shell commands.
 * 2. Strict Workspace Containment: Path resolution and containment verified via WorkspacePort.
 * 3. Path Privacy: Host absolute paths are never disclosed in diffs or errors.
 * 4. Deterministic Output: Forward slashes, alphabetical file ordering, stable SHA-256 digest.
 * 5. Bounded Consumption: Enforces maxBytes ceiling with explicit truncation flag.
 * 6. Cancellation: Honors AbortSignal from ToolExecutionContext.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  InvalidWorkspacePathError,
  ToolCancelledError,
  ToolExecutionFailedError,
  ToolWorkspaceBoundaryViolationError,
  WorkspacePathOutsideBoundaryError,
} from "../../domain/errors.js";
import { GitDiffInput, GitDiffOutput } from "../../domain/tool-schemas.js";
import {
  ToolAdapter,
  ToolExecutionContext,
} from "../../ports/tool-adapter.port.js";
import { WorkspacePort } from "../../ports/workspace.port.js";
import {
  computeGitBlobSha1,
  findGitDir,
  generateUnifiedDiff,
  getCommitFiles,
  getHeadCommit,
  readGitIndex,
  readGitObject,
} from "./git-utils.js";

export class GitDiffToolAdapter implements ToolAdapter<"git_diff"> {
  readonly toolName = "git_diff" as const;

  constructor(private readonly workspacePort: WorkspacePort) {}

  async execute(
    context: ToolExecutionContext,
    input: GitDiffInput
  ): Promise<GitDiffOutput> {
    // 1. Initial cancellation check
    if (context.abortSignal?.aborted) {
      throw new ToolCancelledError(this.toolName, context.abortSignal.reason?.message);
    }

    // 2. Resolve target path within workspace boundary
    const targetRelPath = input.path ?? ".";
    let targetHostPath: string;
    try {
      targetHostPath = await this.workspacePort.resolvePath(
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
        `Path resolution failed for '${targetRelPath}': ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // 3. Locate .git directory within workspace
    const gitDir = await findGitDir(context.workspace.hostPath, targetHostPath);
    if (!gitDir) {
      throw new ToolExecutionFailedError(
        this.toolName,
        `Not a git repository (or any parent up to workspace root): '${targetRelPath}'`
      );
    }

    if (context.abortSignal?.aborted) {
      throw new ToolCancelledError(this.toolName, context.abortSignal.reason?.message);
    }

    // 4. Effective resource limits
    const effectiveMaxBytes = Math.min(
      input.maxBytes ?? context.resourceLimits.maxOutputBytes,
      context.resourceLimits.maxOutputBytes
    );

    // 5. Normalized filter path
    const normalizedFilter =
      targetRelPath !== "."
        ? targetRelPath.replace(/\\/g, "/").replace(/^\.\/?/, "").replace(/\/+$/, "")
        : "";

    const matchesFilter = (filePath: string): boolean => {
      if (!normalizedFilter) return true;
      return (
        filePath === normalizedFilter ||
        filePath.startsWith(normalizedFilter + "/")
      );
    };

    // 6. Gather repository states (HEAD, index)
    const currentCommit = await getHeadCommit(gitDir);
    const headFiles = currentCommit
      ? await getCommitFiles(gitDir, currentCommit)
      : new Map<string, string>();
    const indexMap = await readGitIndex(gitDir);

    let totalInsertions = 0;
    let totalDeletions = 0;
    let filesChanged = 0;
    const diffChunks: string[] = [];
    let currentBytes = 0;
    let isTruncated = false;

    if (input.staged) {
      // =========================================================================
      // Staged diff: Index vs HEAD
      // =========================================================================
      const allCandidateFiles = new Set<string>();
      for (const f of indexMap.keys()) {
        if (matchesFilter(f)) allCandidateFiles.add(f);
      }
      for (const f of headFiles.keys()) {
        if (matchesFilter(f)) allCandidateFiles.add(f);
      }

      const sortedFiles = Array.from(allCandidateFiles).sort();

      for (const file of sortedFiles) {
        if (context.abortSignal?.aborted) {
          throw new ToolCancelledError(this.toolName, context.abortSignal.reason?.message);
        }

        const inIndex = indexMap.has(file);
        const inHead = headFiles.has(file);

        if (inIndex && !inHead) {
          // New staged file
          const indexSha = indexMap.get(file)!.sha;
          const obj = await readGitObject(gitDir, indexSha);
          const newText = obj ? obj.data.toString("utf8") : "";
          const result = generateUnifiedDiff(file, "", newText, false, true);
          if (result.diff) {
            filesChanged++;
            totalInsertions += result.insertions;
            totalDeletions += result.deletions;
            const chunkBytes = Buffer.byteLength(result.diff, "utf8");
            if (currentBytes + chunkBytes > effectiveMaxBytes) {
              isTruncated = true;
              break;
            }
            diffChunks.push(result.diff);
            currentBytes += chunkBytes;
          }
        } else if (!inIndex && inHead) {
          // Staged deletion
          const headSha = headFiles.get(file)!;
          const obj = await readGitObject(gitDir, headSha);
          const oldText = obj ? obj.data.toString("utf8") : "";
          const result = generateUnifiedDiff(file, oldText, "", true, false);
          if (result.diff) {
            filesChanged++;
            totalInsertions += result.insertions;
            totalDeletions += result.deletions;
            const chunkBytes = Buffer.byteLength(result.diff, "utf8");
            if (currentBytes + chunkBytes > effectiveMaxBytes) {
              isTruncated = true;
              break;
            }
            diffChunks.push(result.diff);
            currentBytes += chunkBytes;
          }
        } else if (inIndex && inHead) {
          // Both in index and HEAD: check if SHA differs
          const indexSha = indexMap.get(file)!.sha;
          const headSha = headFiles.get(file)!;
          if (indexSha !== headSha) {
            const oldObj = await readGitObject(gitDir, headSha);
            const newObj = await readGitObject(gitDir, indexSha);
            const oldText = oldObj ? oldObj.data.toString("utf8") : "";
            const newText = newObj ? newObj.data.toString("utf8") : "";
            const result = generateUnifiedDiff(file, oldText, newText, false, false);
            if (result.diff) {
              filesChanged++;
              totalInsertions += result.insertions;
              totalDeletions += result.deletions;
              const chunkBytes = Buffer.byteLength(result.diff, "utf8");
              if (currentBytes + chunkBytes > effectiveMaxBytes) {
                isTruncated = true;
                break;
              }
              diffChunks.push(result.diff);
              currentBytes += chunkBytes;
            }
          }
        }
      }
    } else {
      // =========================================================================
      // Unstaged diff: Working tree vs Index (or HEAD if not in index)
      // =========================================================================
      const baseFiles = new Map<string, string>();
      for (const [f, entry] of indexMap.entries()) {
        if (matchesFilter(f)) baseFiles.set(f, entry.sha);
      }
      // If index is empty (e.g. no staging done), fallback to HEAD files
      if (baseFiles.size === 0) {
        for (const [f, sha] of headFiles.entries()) {
          if (matchesFilter(f)) baseFiles.set(f, sha);
        }
      }

      const sortedBaseFiles = Array.from(baseFiles.keys()).sort();

      for (const file of sortedBaseFiles) {
        if (context.abortSignal?.aborted) {
          throw new ToolCancelledError(this.toolName, context.abortSignal.reason?.message);
        }

        const baseSha = baseFiles.get(file)!;
        const hostFilePath = path.join(context.workspace.hostPath, file);

        let fileExists = false;
        let workSha = "";
        let workContent = "";

        try {
          const contentBuf = await fs.readFile(hostFilePath);
          fileExists = true;
          workSha = computeGitBlobSha1(contentBuf);
          workContent = contentBuf.toString("utf8");
        } catch {
          // File deleted in working tree
          fileExists = false;
        }

        if (!fileExists) {
          // File deleted from working tree
          const baseObj = await readGitObject(gitDir, baseSha);
          const oldText = baseObj ? baseObj.data.toString("utf8") : "";
          const result = generateUnifiedDiff(file, oldText, "", true, false);
          if (result.diff) {
            filesChanged++;
            totalInsertions += result.insertions;
            totalDeletions += result.deletions;
            const chunkBytes = Buffer.byteLength(result.diff, "utf8");
            if (currentBytes + chunkBytes > effectiveMaxBytes) {
              isTruncated = true;
              break;
            }
            diffChunks.push(result.diff);
            currentBytes += chunkBytes;
          }
        } else if (workSha !== baseSha) {
          // Modified in working tree
          const baseObj = await readGitObject(gitDir, baseSha);
          const oldText = baseObj ? baseObj.data.toString("utf8") : "";
          const result = generateUnifiedDiff(file, oldText, workContent, false, false);
          if (result.diff) {
            filesChanged++;
            totalInsertions += result.insertions;
            totalDeletions += result.deletions;
            const chunkBytes = Buffer.byteLength(result.diff, "utf8");
            if (currentBytes + chunkBytes > effectiveMaxBytes) {
              isTruncated = true;
              break;
            }
            diffChunks.push(result.diff);
            currentBytes += chunkBytes;
          }
        }
      }
    }

    let diffText = diffChunks.join("\n\n");
    let diffBytes = Buffer.byteLength(diffText, "utf8");

    if (diffBytes > effectiveMaxBytes) {
      const truncatedBuf = Buffer.from(diffText, "utf8").subarray(0, effectiveMaxBytes);
      diffText = truncatedBuf.toString("utf8");
      isTruncated = true;
    }

    const diffHash = crypto.createHash("sha256").update(diffText, "utf8").digest("hex");

    return {
      diff: diffText,
      filesChanged,
      insertions: totalInsertions,
      deletions: totalDeletions,
      diffHash,
      isTruncated,
    };
  }
}
