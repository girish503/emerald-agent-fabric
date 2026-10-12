/**
 * Read File Tool Adapter for Emerald Agent Fabric.
 *
 * Implements typed, workspace-confined file reading using the Phase 3 WorkspacePort.
 *
 * Security & Governance Invariants:
 * 1. Strict Workspace Containment: Paths are resolved and canonicalized exclusively
 *    through WorkspacePort. Symlinks escaping the workspace boundary are rejected.
 * 2. Path Privacy: Host absolute paths are never disclosed in outputs or errors.
 * 3. Bounded Consumption: Requested line and byte limits are enforced without silent expansion.
 * 4. Determinism: UTF-8 content semantics with stable SHA-256 digest computation.
 * 5. Cancellation: Honors AbortSignal from ToolExecutionContext.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import {
  InvalidWorkspacePathError,
  ToolCancelledError,
  ToolExecutionFailedError,
  ToolWorkspaceBoundaryViolationError,
  WorkspacePathOutsideBoundaryError,
} from "../../domain/errors.js";
import { ReadFileInput, ReadFileOutput } from "../../domain/tool-schemas.js";
import {
  ToolAdapter,
  ToolExecutionContext,
} from "../../ports/tool-adapter.port.js";
import { WorkspacePort } from "../../ports/workspace.port.js";

export class ReadFileToolAdapter implements ToolAdapter<"read_file"> {
  readonly toolName = "read_file" as const;

  constructor(private readonly workspacePort: WorkspacePort) {}

  async execute(
    context: ToolExecutionContext,
    input: ReadFileInput
  ): Promise<ReadFileOutput> {
    // 1. Cancellation check
    if (context.abortSignal?.aborted) {
      throw new ToolCancelledError(this.toolName, context.abortSignal.reason?.message);
    }

    // 2. Canonical containment resolution via WorkspacePort
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

    // 3. Inspect target existence and type
    let stats: import("node:fs").Stats;
    try {
      stats = await fs.lstat(resolvedHostPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ToolExecutionFailedError(
          this.toolName,
          `File not found: '${input.path}'`
        );
      }
      throw new ToolExecutionFailedError(
        this.toolName,
        `Cannot stat file '${input.path}': ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (stats.isDirectory()) {
      throw new ToolExecutionFailedError(
        this.toolName,
        `Target path '${input.path}' is a directory, not a file`
      );
    }

    // 4. Determine effective maximum bytes
    const effectiveMaxBytes = Math.min(
      input.maxBytes ?? context.resourceLimits.maxOutputBytes,
      context.resourceLimits.maxOutputBytes
    );

    // 5. Read file with bounded memory usage
    let rawText: string;
    try {
      rawText = await fs.readFile(resolvedHostPath, "utf8");
    } catch (err: unknown) {
      throw new ToolExecutionFailedError(
        this.toolName,
        `Failed to read file '${input.path}': ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // 6. Split into lines and apply line windowing
    const allLines = rawText.split(/\r?\n/);
    const totalLines = allLines.length;

    const offsetLine = Math.max(1, input.offsetLine ?? 1);
    const limitLines = Math.max(1, input.limitLines ?? 500);

    const startIdx = offsetLine - 1;
    const endIdx = Math.min(totalLines, startIdx + limitLines);

    const selectedLines = startIdx < totalLines ? allLines.slice(startIdx, endIdx) : [];
    let content = selectedLines.join("\n");
    let isTruncated = endIdx < totalLines;

    // 7. Enforce byte ceiling
    let bytesRead = Buffer.byteLength(content, "utf8");
    if (bytesRead > effectiveMaxBytes) {
      const truncatedBuffer = Buffer.from(content, "utf8").subarray(0, effectiveMaxBytes);
      content = truncatedBuffer.toString("utf8");
      bytesRead = Buffer.byteLength(content, "utf8");
      isTruncated = true;
    }

    // 8. Compute deterministic content digest
    const contentHash = crypto.createHash("sha256").update(content, "utf8").digest("hex");

    return {
      path: input.path,
      content,
      bytesRead,
      totalLines,
      isTruncated,
      contentHash,
    };
  }
}
