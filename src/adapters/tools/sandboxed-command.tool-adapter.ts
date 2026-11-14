/**
 * Sandboxed Command Tool Adapter for Emerald Agent Fabric.
 *
 * Implements typed, isolated process execution via the ExecutionProvider boundary.
 *
 * Security & Governance Invariants:
 * 1. Zero Subprocesses: NO child_process, NO exec, NO spawn, NO sh, NO bash in the adapter layer.
 *    All process execution occurs exclusively behind the hardened ExecutionProvider boundary (Docker).
 * 2. Strict Anti-Shell Injection: Commands are represented and dispatched as discrete argv tokens
 *    without string interpolation or shell wrapping.
 * 3. Working Directory Containment: cwd is resolved and validated strictly against the assigned workspace sandbox.
 * 4. Bounded Consumption: Timeout and output ceilings from ToolExecutionContext are enforced without silent expansion.
 * 5. Cancellation: Honors AbortSignal from ToolExecutionContext.
 * 6. Deterministic Error Taxonomy: Provider outcomes map to ToolDomainError instances (ToolTimeoutError,
 *    ToolOutputLimitExceededError, ToolCancelledError, ToolProviderUnavailableError, ToolExecutionFailedError).
 */

import * as crypto from "node:crypto";
import * as path from "node:path";
import {
  InvalidExecutionProviderRoleError,
  InvalidWorkspacePathError,
  ToolCancelledError,
  ToolExecutionFailedError,
  ToolOutputLimitExceededError,
  ToolProviderUnavailableError,
  ToolTimeoutError,
  ToolWorkspaceBoundaryViolationError,
  WorkspacePathOutsideBoundaryError,
} from "../../domain/errors.js";
import { RunCommandInput, RunCommandOutput } from "../../domain/tool-schemas.js";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
  resolveProviderRole,
} from "../../ports/execution-provider.port.js";
import {
  ToolAdapter,
  ToolExecutionContext,
} from "../../ports/tool-adapter.port.js";
import { WorkspacePort } from "../../ports/workspace.port.js";
import { RunCommandExecutionPayload } from "../execution/docker-execution-provider.js";

export class SandboxedCommandToolAdapter implements ToolAdapter<"run_command"> {
  readonly toolName = "run_command" as const;

  constructor(
    private readonly executionProvider: ExecutionProvider,
    private readonly workspacePort?: WorkspacePort
  ) {
    const role = resolveProviderRole(executionProvider);
    if (role !== "PHYSICAL") {
      throw new InvalidExecutionProviderRoleError(
        executionProvider.name,
        "PHYSICAL",
        role,
        `SandboxedCommandToolAdapter: executionProvider '${executionProvider.name}' has role '${role}'. Only PHYSICAL execution providers are permitted for sandboxed command execution.`
      );
    }
  }

  async execute(
    context: ToolExecutionContext,
    input: RunCommandInput
  ): Promise<RunCommandOutput> {
    // 1. Initial cancellation check
    if (context.abortSignal?.aborted) {
      throw new ToolCancelledError(this.toolName, context.abortSignal.reason?.message);
    }

    // 2. Working directory containment validation
    const targetRelCwd = input.cwd ?? ".";
    if (this.workspacePort) {
      try {
        await this.workspacePort.resolvePath(
          context.workspace.workspaceId,
          targetRelCwd
        );
      } catch (err: unknown) {
        if (
          err instanceof WorkspacePathOutsideBoundaryError ||
          err instanceof InvalidWorkspacePathError
        ) {
          throw new ToolWorkspaceBoundaryViolationError(
            this.toolName,
            targetRelCwd,
            err.message
          );
        }
        throw new ToolExecutionFailedError(
          this.toolName,
          `Working directory resolution failed for '${targetRelCwd}': ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    } else {
      // Lexical validation fallback when workspacePort is not injected
      const normalized = path.posix.normalize(targetRelCwd.replace(/\\/g, "/"));
      if (normalized.startsWith("..") || path.posix.isAbsolute(normalized)) {
        throw new ToolWorkspaceBoundaryViolationError(
          this.toolName,
          targetRelCwd,
          "Working directory escapes workspace boundary"
        );
      }
    }

    // 3. Determine effective resource bounds (non-clamping governance model)
    const effectiveTimeoutMs = Math.min(
      input.timeoutMs ?? context.resourceLimits.timeoutMs,
      context.resourceLimits.timeoutMs
    );
    const effectiveMaxOutputBytes = Math.min(
      input.maxOutputBytes ?? context.resourceLimits.maxOutputBytes,
      context.resourceLimits.maxOutputBytes
    );

    // 4. Construct typed ExecutionRequest
    const execRequest: ExecutionRequest<RunCommandExecutionPayload> = {
      runId: context.runId,
      taskId: context.taskId,
      operationName: "run_command",
      inputPayload: {
        argv: input.argv,
        cwd: targetRelCwd,
        maxOutputBytes: effectiveMaxOutputBytes,
      },
      idempotencyToken: crypto.randomUUID(),
      attemptNumber: 0,
      timeoutMs: effectiveTimeoutMs,
      workspace: {
        workspaceId: context.workspace.workspaceId,
        hostPath: context.workspace.hostPath,
        containerMountPath: context.workspace.containerMountPath ?? "/workspace",
      },
      tenantId: context.tenantId,
      trustClassification: context.trustClassification,
    };

    // 5. Dispatch exclusively through the hardened ExecutionProvider
    let result: ExecutionResult<RunCommandOutput>;
    try {
      result = await this.executionProvider.execute<
        RunCommandExecutionPayload,
        RunCommandOutput
      >(execRequest);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ToolProviderUnavailableError(this.toolName, msg);
    }

    // 6. Map provider outcomes to deterministic tool domain errors
    if (result.status === "TIMED_OUT" || result.error?.code === "EXECUTION_TIMEOUT") {
      throw new ToolTimeoutError(this.toolName, effectiveTimeoutMs);
    }

    if (result.status === "CANCELLED" || result.error?.code === "EXECUTION_CANCELLED") {
      throw new ToolCancelledError(this.toolName, result.error?.message);
    }

    if (result.error?.code === "PROVIDER_UNAVAILABLE") {
      throw new ToolProviderUnavailableError(this.toolName, result.error.message);
    }

    if (result.providerMetadata?.outputLimitExceeded) {
      throw new ToolOutputLimitExceededError(this.toolName, effectiveMaxOutputBytes);
    }

    if (result.status === "FAILED") {
      if (result.error?.message?.includes("Output limit")) {
        throw new ToolOutputLimitExceededError(this.toolName, effectiveMaxOutputBytes);
      }
      if (result.error?.message?.includes("Security violation")) {
        throw new ToolWorkspaceBoundaryViolationError(
          this.toolName,
          targetRelCwd,
          result.error.message
        );
      }
      throw new ToolExecutionFailedError(
        this.toolName,
        result.error?.message ?? "Command execution failed in container",
        result.error
      );
    }

    // 7. Process output
    const rawOutput = result.output;
    if (!rawOutput) {
      throw new ToolExecutionFailedError(
        this.toolName,
        "No output received from execution provider"
      );
    }

    let stdout = rawOutput.stdout ?? "";
    let stderr = rawOutput.stderr ?? "";
    let outputTruncated = rawOutput.outputTruncated ?? false;

    const totalBytes = Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8");
    if (totalBytes > effectiveMaxOutputBytes) {
      outputTruncated = true;
      const maxStdoutBytes = Math.max(0, effectiveMaxOutputBytes - Buffer.byteLength(stderr, "utf8"));
      if (Buffer.byteLength(stdout, "utf8") > maxStdoutBytes) {
        stdout = Buffer.from(stdout, "utf8").subarray(0, maxStdoutBytes).toString("utf8");
      }
    }

    const commandHash =
      rawOutput.commandHash ??
      crypto.createHash("sha256").update(JSON.stringify(input.argv), "utf8").digest("hex");

    return {
      exitCode: rawOutput.exitCode,
      stdout,
      stderr,
      durationMs: result.durationMs,
      outputTruncated,
      commandHash,
    };
  }
}
