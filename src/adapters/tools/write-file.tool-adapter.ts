/**
 * Write File Tool Adapter for Emerald Agent Fabric.
 *
 * Implements typed, workspace-confined atomic file writing using Phase 3 WorkspacePort.
 *
 * Security & Governance Invariants:
 * 1. Strict Workspace Containment: Path canonicalization and symlink verification are
 *    performed exclusively via WorkspacePort. Ancestor symlink traversal is strictly rejected.
 * 2. Symlink Overwrite Defense: Symlink targets are never followed or overwritten.
 * 3. Atomic In-Workspace Staging: Writes are staged to a temporary file inside the same parent
 *    directory within the workspace, then atomically renamed. Staging outside workspace is FORBIDDEN.
 * 4. Path Privacy: Host absolute paths are never disclosed in outputs or errors.
 * 5. Determinism: Zero ambient or stochastic mutations. Single-shot execution without automatic retry.
 * 6. Cancellation: Honors AbortSignal from ToolExecutionContext.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  InvalidWorkspacePathError,
  ToolCancelledError,
  ToolExecutionFailedError,
  ToolOutputLimitExceededError,
  ToolWorkspaceBoundaryViolationError,
  WorkspacePathOutsideBoundaryError,
} from "../../domain/errors.js";
import { WriteFileInput, WriteFileOutput } from "../../domain/tool-schemas.js";
import {
  ToolAdapter,
  ToolExecutionContext,
} from "../../ports/tool-adapter.port.js";
import { WorkspacePort } from "../../ports/workspace.port.js";

export class WriteFileToolAdapter implements ToolAdapter<"write_file"> {
  readonly toolName = "write_file" as const;

  constructor(private readonly workspacePort: WorkspacePort) {}

  async execute(
    context: ToolExecutionContext,
    input: WriteFileInput
  ): Promise<WriteFileOutput> {
    // 1. Cancellation check
    if (context.abortSignal?.aborted) {
      throw new ToolCancelledError(this.toolName, context.abortSignal.reason?.message);
    }

    // 2. Resource ceiling enforcement on content payload
    const contentBytes = Buffer.byteLength(input.content, "utf8");
    const maxAllowed = Math.min(
      input.maxBytes ?? context.resourceLimits.maxOutputBytes,
      context.resourceLimits.maxOutputBytes
    );

    if (contentBytes > maxAllowed) {
      throw new ToolOutputLimitExceededError(this.toolName, maxAllowed, contentBytes);
    }

    // 3. Resolve canonical host path via WorkspacePort
    let resolvedHostPath: string;
    try {
      resolvedHostPath = await this.workspacePort.resolvePath(
        context.workspace.workspaceId,
        input.path
      );
    } catch (err: unknown) {
      if (
        err instanceof WorkspacePathOutsideBoundaryError ||
        err instanceof InvalidWorkspacePathError
      ) {
        throw new ToolWorkspaceBoundaryViolationError(
          this.toolName,
          input.path,
          err.message
        );
      }
      throw new ToolExecutionFailedError(
        this.toolName,
        `Path resolution failed for '${input.path}': ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // 4. Inspect existing destination to protect against symlinks and overwrite constraints
    let alreadyExists = false;
    try {
      const stats = await fs.lstat(resolvedHostPath);
      alreadyExists = true;

      if (stats.isSymbolicLink()) {
        throw new ToolWorkspaceBoundaryViolationError(
          this.toolName,
          input.path,
          "Cannot write to a symbolic link target"
        );
      }

      if (stats.isDirectory()) {
        throw new ToolExecutionFailedError(
          this.toolName,
          `Target path '${input.path}' is an existing directory`
        );
      }

      if (input.overwrite === false) {
        throw new ToolExecutionFailedError(
          this.toolName,
          `File already exists and overwrite is set to false: '${input.path}'`
        );
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }

    // 5. In-workspace staging and atomic commit
    const parentDir = path.dirname(resolvedHostPath);
    await fs.mkdir(parentDir, { recursive: true, mode: 0o700 });

    const tempFileName = `.${path.basename(resolvedHostPath)}.tmp.${Date.now()}.${crypto.randomBytes(4).toString("hex")}`;
    const tempFilePath = path.join(parentDir, tempFileName);

    try {
      await fs.writeFile(tempFilePath, input.content, { encoding: "utf8", mode: 0o600 });
      await fs.rename(tempFilePath, resolvedHostPath);
    } catch (err: unknown) {
      // Best-effort cleanup of temporary staging file on failure
      await fs.rm(tempFilePath, { force: true }).catch(() => {});
      throw new ToolExecutionFailedError(
        this.toolName,
        `Failed to atomically write file '${input.path}': ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // 6. Compute deterministic content digest
    const contentHash = crypto.createHash("sha256").update(input.content, "utf8").digest("hex");

    return {
      path: input.path,
      bytesWritten: contentBytes,
      created: !alreadyExists,
      contentHash,
    };
  }
}
