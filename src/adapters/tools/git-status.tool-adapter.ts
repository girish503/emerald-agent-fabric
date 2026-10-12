/**
 * Git Status Tool Adapter for Emerald Agent Fabric.
 *
 * Implements typed, workspace-confined Git repository status inspection
 * without invoking external git CLI or spawning any subprocesses.
 *
 * Security & Governance Invariants:
 * 1. Zero Subprocesses: NO child_process, NO exec, NO spawn, NO shell commands.
 * 2. Strict Workspace Containment: Path resolution and confinement enforced via WorkspacePort.
 * 3. Path Privacy: Host absolute paths are never disclosed in outputs or errors.
 * 4. Deterministic Output: Forward slashes, alphabetical path ordering, reproducible status.
 * 5. Cancellation: Honors AbortSignal from ToolExecutionContext.
 */

import {
  InvalidWorkspacePathError,
  ToolCancelledError,
  ToolExecutionFailedError,
  ToolWorkspaceBoundaryViolationError,
  WorkspacePathOutsideBoundaryError,
} from "../../domain/errors.js";
import { GitStatusInput, GitStatusOutput } from "../../domain/tool-schemas.js";
import {
  ToolAdapter,
  ToolExecutionContext,
} from "../../ports/tool-adapter.port.js";
import { WorkspacePort } from "../../ports/workspace.port.js";
import {
  findGitDir,
  getCommitFiles,
  getHeadCommit,
  readGitIndex,
  scanWorkingTreeFiles,
} from "./git-utils.js";

export class GitStatusToolAdapter implements ToolAdapter<"git_status"> {
  readonly toolName = "git_status" as const;

  constructor(private readonly workspacePort: WorkspacePort) {}

  async execute(
    context: ToolExecutionContext,
    input: GitStatusInput
  ): Promise<GitStatusOutput> {
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

    // 4. Resolve HEAD commit hash and tracked files in HEAD tree
    const currentCommit = (await getHeadCommit(gitDir)) ?? undefined;
    const headFiles = currentCommit
      ? await getCommitFiles(gitDir, currentCommit)
      : new Map<string, string>();

    // 5. Read index entries (.git/index)
    const indexMap = await readGitIndex(gitDir);

    // 6. Scan working tree files
    const workFiles = await scanWorkingTreeFiles(
      context.workspace.hostPath,
      targetRelPath === "." ? undefined : targetRelPath,
      context.abortSignal
    );

    if (context.abortSignal?.aborted) {
      throw new ToolCancelledError(this.toolName, context.abortSignal.reason?.message);
    }

    // 7. Compute normalized filter path
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

    // 8. Classify file statuses
    const untrackedSet = new Set<string>();
    const addedSet = new Set<string>();
    const modifiedSet = new Set<string>();
    const deletedSet = new Set<string>();

    // Check all working tree files
    for (const [filePath, workSha] of workFiles.entries()) {
      if (!matchesFilter(filePath)) continue;

      const inIndex = indexMap.has(filePath);
      const inHead = headFiles.has(filePath);

      if (!inIndex && !inHead) {
        untrackedSet.add(filePath);
      } else if (inIndex) {
        const indexSha = indexMap.get(filePath)!.sha;
        if (!inHead) {
          // Staged new file
          addedSet.add(filePath);
          if (workSha !== indexSha) {
            modifiedSet.add(filePath);
          }
        } else {
          // Tracked in HEAD and index
          const headSha = headFiles.get(filePath)!;
          if (workSha !== indexSha || indexSha !== headSha) {
            modifiedSet.add(filePath);
          }
        }
      } else if (inHead) {
        // In HEAD but not in index (staged removal or modified outside index)
        const headSha = headFiles.get(filePath)!;
        if (workSha !== headSha) {
          modifiedSet.add(filePath);
        }
      }
    }

    // Check for deleted files (in index or HEAD, but missing from working tree)
    for (const [filePath] of indexMap.entries()) {
      if (!matchesFilter(filePath)) continue;
      if (!workFiles.has(filePath)) {
        deletedSet.add(filePath);
      }
    }

    for (const [filePath] of headFiles.entries()) {
      if (!matchesFilter(filePath)) continue;
      if (!workFiles.has(filePath)) {
        deletedSet.add(filePath);
      }
    }

    // Sort all arrays alphabetically
    const untracked = Array.from(untrackedSet).sort();
    const added = Array.from(addedSet).sort();
    const modified = Array.from(modifiedSet).sort();
    const deleted = Array.from(deletedSet).sort();

    const clean =
      untracked.length === 0 &&
      added.length === 0 &&
      modified.length === 0 &&
      deleted.length === 0;

    return {
      clean,
      currentCommit,
      modified,
      added,
      deleted,
      untracked,
    };
  }
}
