/**
 * Edit File Tool Adapter for Emerald Agent Fabric.
 *
 * Implements typed, line-anchored, workspace-confined search-and-replace file editing.
 * Replaces exact text spans without whole-file replacement.
 *
 * Security & Governance Invariants:
 * 1. Strict Workspace Containment: Path canonicalization and symlink verification are
 *    performed exclusively within workspace boundary (lexical + canonical realpath).
 * 2. Exact Match Required: Anchors must match uniquely by default; ambiguous or zero matches fail closed.
 * 3. Atomic Replacement: Staged to a temporary file inside the same parent directory then renamed.
 * 4. Stale Edit Defense: Mismatched expected SHA-256 digest fails closed without modifying disk.
 * 5. Non-Authoritative: Succeeded edit reports applied: true, but never grants verified repair authority.
 * 6. Cancellation: Honors AbortSignal from ToolExecutionContext.
 */

import * as path from "node:path";
import {
  DigestMismatchError,
  GovernedWamiRequiredError,
  IncompletePriorMutationError,
  InvalidWorkspacePathError,
  LeaseExpiredError,
  LeaseLostError,
  PostWriteVerificationError,
  PreRenameConflictError,
  SnapshotContainmentError,
  SnapshotCreationError,
  ToolCancelledError,
  ToolExecutionFailedError,
  ToolOutputLimitExceededError,
  ToolPreconditionFailedError,
  ToolWorkspaceBoundaryViolationError,
  WorkspacePathOutsideBoundaryError,
} from "../../domain/errors.js";
import { EditFileInput, EditFileOutput } from "../../domain/tool-schemas.js";
import {
  ToolAdapter,
  ToolExecutionContext,
} from "../../ports/tool-adapter.port.js";
import { WorkspacePort } from "../../ports/workspace.port.js";
import {
  LineAnchoredEditor,
  LineAnchoredEditResult,
  LineAnchoredMutationOptions,
} from "../../production/repair/line-anchored-editor.js";
import { MutationIntentStorePort } from "../../ports/mutation-intent-store.port.js";

export class EditFileToolAdapter implements ToolAdapter<"edit_file"> {
  readonly toolName = "edit_file" as const;

  constructor(
    _workspacePort?: WorkspacePort,
    private readonly editor: LineAnchoredEditor = new LineAnchoredEditor(),
    private readonly mutationStore?: MutationIntentStorePort,
    private readonly snapshotBasePath?: string
  ) {}

  async execute(
    context: ToolExecutionContext,
    input: EditFileInput
  ): Promise<EditFileOutput> {
    // 1. Cancellation check
    if (context.abortSignal?.aborted) {
      throw new ToolCancelledError(this.toolName, context.abortSignal.reason?.message);
    }

    // 2. Resource ceiling enforcement on replacement payload
    const replacementBytes = Buffer.byteLength(input.replacementText, "utf8");
    const maxAllowed = Math.min(
      input.maxBytes ?? context.resourceLimits.maxOutputBytes,
      context.resourceLimits.maxOutputBytes
    );

    if (replacementBytes > maxAllowed) {
      throw new ToolOutputLimitExceededError(this.toolName, maxAllowed, replacementBytes);
    }

    // 3. Resolve host workspace path
    const workspaceHostPath = context.workspace?.hostPath;
    if (!workspaceHostPath || typeof workspaceHostPath !== "string" || workspaceHostPath.trim().length === 0) {
      if (context.governedBenchmarkRepairMode) {
        throw new GovernedWamiRequiredError(
          context.runId ?? "unknown",
          input.path,
          "Governed repair execution requires valid workspace context with hostPath"
        );
      }
      throw new ToolWorkspaceBoundaryViolationError(this.toolName, input.path, "No workspace hostPath assigned to context");
    }

    // 4. Validate containment and apply edit through LineAnchoredEditor
    try {
      // First verify path containment through resolveSafePath
      this.editor.resolveSafePath(input.path, workspaceHostPath);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (
        errMsg.includes("Path traversal denied") ||
        errMsg.includes("outside workspace") ||
        errMsg.includes("canonical symlink escape") ||
        err instanceof WorkspacePathOutsideBoundaryError ||
        err instanceof InvalidWorkspacePathError
      ) {
        throw new ToolWorkspaceBoundaryViolationError(this.toolName, input.path, errMsg);
      }
      throw new ToolExecutionFailedError(this.toolName, `Path resolution failed for '${input.path}': ${errMsg}`);
    }

    // 5. Apply the line-anchored edit
    let editResult: LineAnchoredEditResult;
    try {
      let mutationOptions: LineAnchoredMutationOptions | undefined;

      if (context.governedBenchmarkRepairMode) {
        if (!this.mutationStore) {
          throw new GovernedWamiRequiredError(
            context.runId ?? "unknown",
            input.path,
            "Governed repair execution requires MutationIntentStorePort for WAMI persistence"
          );
        }
        if (!context.runId || typeof context.runId !== "string" || context.runId.trim().length === 0) {
          throw new GovernedWamiRequiredError(
            context.runId ?? "unknown",
            input.path,
            "Governed repair execution requires non-empty valid runId"
          );
        }
        if (!context.workerId || typeof context.workerId !== "string" || context.workerId.trim().length === 0) {
          throw new GovernedWamiRequiredError(
            context.runId,
            input.path,
            "Governed repair execution requires non-empty valid workerId"
          );
        }
        if (!context.leaseId || typeof context.leaseId !== "string" || context.leaseId.trim().length === 0) {
          throw new GovernedWamiRequiredError(
            context.runId,
            input.path,
            "Governed repair execution requires non-empty valid leaseId"
          );
        }

        const snapshotDir = this.snapshotBasePath ?? path.resolve(workspaceHostPath, ".emerald", "snapshots", context.runId);
        mutationOptions = {
          runId: context.runId,
          workerId: context.workerId,
          workerLeaseId: context.leaseId,
          store: this.mutationStore,
          snapshotDir,
        };
      } else if (this.mutationStore && context.runId && context.leaseId) {
        mutationOptions = {
          runId: context.runId,
          workerId: context.workerId,
          workerLeaseId: context.leaseId,
          store: this.mutationStore,
          snapshotDir: this.snapshotBasePath ?? path.resolve(workspaceHostPath, ".emerald", "snapshots", context.runId),
        };
      }

      editResult = this.editor.applyEdit(
        input as unknown as Record<string, unknown>,
        workspaceHostPath,
        mutationOptions
      );
    } catch (err: unknown) {
      if (
        err instanceof GovernedWamiRequiredError ||
        err instanceof LeaseExpiredError ||
        err instanceof LeaseLostError ||
        err instanceof PreRenameConflictError ||
        err instanceof PostWriteVerificationError ||
        err instanceof IncompletePriorMutationError ||
        err instanceof SnapshotContainmentError ||
        err instanceof SnapshotCreationError ||
        err instanceof DigestMismatchError
      ) {
        throw err;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("Path traversal denied")) {
        throw new ToolWorkspaceBoundaryViolationError(this.toolName, input.path, errMsg);
      }
      if (errMsg.includes("Stale edit precondition failed")) {
        throw new ToolPreconditionFailedError(this.toolName, errMsg, { path: input.path });
      }
      if (errMsg.includes("File size limit exceeded")) {
        throw new ToolOutputLimitExceededError(this.toolName, 1048576, maxAllowed);
      }
      throw new ToolExecutionFailedError(this.toolName, errMsg);
    }

    return {
      path: editResult.path,
      originalDigest: editResult.originalDigest,
      resultingDigest: editResult.resultingDigest,
      occurrences: editResult.occurrences,
      replacedCount: editResult.replacedCount,
      bytesModified: editResult.bytesModified,
      applied: editResult.applied,
    };
  }
}
