/**
 * Emerald Agent Fabric — Production Governance Facade
 *
 * Serves as the authoritative single entry point for all governance, capability fencing,
 * policy evaluation, human approval enforcement, and boundary checks.
 *
 * Core Principle:
 * "The model proposes. The runtime governs. The sandbox executes. The verifier decides. The evidence proves."
 */

import { computeCanonicalHash } from "../domain/canonical-hash.js";
import { CapabilityFenceEnforcer } from "../application/capability-fence-enforcer.js";
import { CrossHarnessGateway } from "../application/cross-harness-gateway.js";
import { HarnessType } from "../domain/cross-harness-request.js";
import { ClockPort, SystemClock } from "../ports/clock.port.js";
import { ApprovalControl, type ApprovalVerificationStatus } from "../control-plane/approval-control.js";

export interface GovernanceDecision {
  readonly authorized: boolean;
  readonly reason?: string;
  readonly controlId?: string;
  readonly requiresHumanApproval?: boolean;
  readonly approvalId?: string;
  readonly approvalStatus?: ApprovalVerificationStatus;
  readonly runStatusHint?: "WAITING_APPROVAL";
  readonly sanitizedInput?: Record<string, unknown>;
}

export interface GovernanceCheckParams {
  readonly runId: string;
  readonly taskId?: string;
  readonly tenantId?: string;
  readonly actionId?: string;
  readonly approvalId?: string;
  readonly subjectId: string;
  readonly fenceId: string;
  readonly harnessType: HarnessType;
  readonly capability: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly workspacePath: string;
  readonly missionContractHash: string;
  readonly consumeApproval?: boolean;
}

export class ProductionGovernanceFacade {
  private checkCounter: number = 0;

  constructor(
    private readonly fenceEnforcer: CapabilityFenceEnforcer,
    private readonly crossHarnessGateway: CrossHarnessGateway,
    private readonly approvalControl?: ApprovalControl,
    private readonly clock: ClockPort = new SystemClock(),
  ) {}

  public getClock(): ClockPort {
    return this.clock;
  }

  public getApprovalControl(): ApprovalControl | undefined {
    return this.approvalControl;
  }

  /**
   * Evaluates a proposed tool action against all frozen governance rules.
   * Fails closed on any violation.
   */
  public evaluateProposal(params: GovernanceCheckParams): GovernanceDecision {
    this.checkCounter++;

    const highRisk = this.isHighRiskOperation(params.toolName, params.input);
    const parametersHash = highRisk ? computeCanonicalHash(params.input ?? {}).contentHash : "";

    // 1. Pre-check explicit operator rejection before further evaluation (fail closed, no retry loop)
    if (highRisk) {
      if (!this.approvalControl) {
        return {
          authorized: false,
          reason: `Operation ${params.toolName} is high-risk and requires configured ApprovalControl governance (fail-closed)`,
          requiresHumanApproval: true,
          approvalStatus: "MISSING",
          runStatusHint: "WAITING_APPROVAL",
          controlId: "N691",
        };
      }

      const preCheck = this.approvalControl.authorizeAndConsume({
        approvalId: params.approvalId,
        runId: params.runId,
        taskId: params.taskId,
        tenantId: params.tenantId,
        contractHash: params.missionContractHash,
        subjectId: params.subjectId,
        operation: params.toolName,
        parametersHash,
        consume: false,
      });

      if (!preCheck.authorized && preCheck.status === "REJECTED") {
        return {
          authorized: false,
          reason: preCheck.reason,
          requiresHumanApproval: false,
          approvalId: preCheck.approvalId,
          approvalStatus: "REJECTED",
          controlId: "N691",
        };
      }
    }

    // 2. Path containment check input extraction
    const targetPath = (params.input["path"] as string) || (params.input["filePath"] as string) || (params.input["cwd"] as string);

    // 3. Evaluate capability via frozen CapabilityFenceEnforcer
    // Human approval NEVER bypasses capability fences or cross-harness containment.
    const fenceResult = this.fenceEnforcer.evaluateCapability(
      params.fenceId,
      params.subjectId,
      params.capability,
      {
        targetPath,
        toolName: params.toolName,
        missionContractHash: params.missionContractHash,
      },
    );

    if (!fenceResult.granted) {
      return {
        authorized: false,
        reason: fenceResult.denialReason ?? "Capability fence rejected action",
        controlId: fenceResult.controlId ?? "N691",
      };
    }

    // 4. Cross-harness data sanitization if cross-harness
    let sanitizedInput: Record<string, unknown> = params.input;
    if (params.harnessType !== "SANDBOX_HARNESS" && params.harnessType !== "IMPLEMENTATION_HARNESS") {
      const crossResult = this.crossHarnessGateway.handleCrossHarnessRequest(
        params.subjectId,
        params.harnessType,
        "SANDBOX_HARNESS",
        "TOOL_INVOCATION",
        params.capability,
        targetPath ?? params.workspacePath,
        params.input,
        "contract",
        params.missionContractHash,
      );
      if (!crossResult.granted) {
        return {
          authorized: false,
          reason: crossResult.denialReason ?? "Cross-harness gateway denied invocation",
          controlId: crossResult.controlId ?? "N696",
        };
      }
      sanitizedInput = crossResult.sanitizedPayload ?? params.input;
    }

    // 5. Enforce & atomically consume human approval AFTER fence + gateway succeed
    if (highRisk) {
      const approvalResult = this.approvalControl!.authorizeAndConsume({
        approvalId: params.approvalId,
        runId: params.runId,
        taskId: params.taskId,
        tenantId: params.tenantId,
        contractHash: params.missionContractHash,
        subjectId: params.subjectId,
        operation: params.toolName,
        parametersHash,
        consume: params.consumeApproval !== false,
      });

      if (!approvalResult.authorized) {
        return {
          authorized: false,
          reason: approvalResult.reason,
          requiresHumanApproval: approvalResult.status !== "REJECTED",
          approvalId: approvalResult.approvalId,
          approvalStatus: approvalResult.status,
          ...(approvalResult.status !== "REJECTED" ? { runStatusHint: "WAITING_APPROVAL" as const } : {}),
          controlId: "N691",
        };
      }

      return {
        authorized: true,
        approvalId: approvalResult.approvalId,
        approvalStatus: "APPROVED",
        sanitizedInput,
      };
    }

    return {
      authorized: true,
      sanitizedInput,
    };
  }

  public getCheckCount(): number {
    return this.checkCounter;
  }

  private isHighRiskOperation(toolName: string, input: Record<string, unknown>): boolean {
    return isHighRiskToolOperation(toolName, input);
  }
}

/**
 * Shared high-risk tool classification used by both ProductionGovernanceFacade
 * and ToolExecutionGateway so approval gating policy stays single-sourced.
 */
export function isHighRiskToolOperation(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName === "run_command" || toolName === "execute_shell") {
    const cmd = typeof input["command"] === "string" ? input["command"] : "";
    const rawArgs = Array.isArray(input["args"])
      ? input["args"]
      : Array.isArray(input["argv"])
        ? input["argv"]
        : [];
    const stringArgs = rawArgs.filter((v): v is string => typeof v === "string");
    const allParts = [cmd, ...stringArgs].map((v) => v.trim()).filter(Boolean);
    const lowerParts = allParts.map((v) => v.toLowerCase());
    const combined = lowerParts.join(" ");
    const exeBase = (lowerParts[0] ?? "").replace(/^.*[\\/]/, "");

    if (lowerParts.some((p) => /[;|&`]|\$\(|[\r\n\0]/.test(p))) {
      return true;
    }
    if (
      (exeBase === "git" && lowerParts.includes("push")) ||
      /\bgit\s+(?:[^\s]+\s+)*push\b/.test(combined) ||
      /\bdeploy\b|\breboot\b|\bshutdown\b|\bpoweroff\b|\bmkfs(?:\.[a-z0-9]+)?\b/.test(combined) ||
      lowerParts.includes("push") ||
      lowerParts.includes("deploy")
    ) {
      return true;
    }
    if (
      ((exeBase === "rm" || /\brm\b/.test(combined)) &&
        lowerParts.some(
          (p) =>
            /^-[a-z]*[rf]/.test(p) ||
            p === "--recursive" ||
            p === "--force" ||
            p === "--no-preserve-root" ||
            p === "/" ||
            p === "/*"
        )) ||
      /\brm\s+.*-[a-z]*[rf]/.test(combined) ||
      /\brm\s+.*\//.test(combined) ||
      /\bdel\s+\/[fqsv]/.test(combined) ||
      /\brmdir\s+\/s/.test(combined)
    ) {
      return true;
    }
    const shellWrappers = new Set([
      "sh",
      "bash",
      "zsh",
      "dash",
      "ash",
      "ksh",
      "cmd",
      "cmd.exe",
      "powershell",
      "powershell.exe",
      "pwsh",
      "pwsh.exe",
    ]);
    if (
      shellWrappers.has(exeBase) &&
      lowerParts.some(
        (p) =>
          p === "-c" ||
          p === "/c" ||
          p === "-lc" ||
          p === "-command" ||
          p === "-enc" ||
          p === "-encodedcommand"
      )
    ) {
      return true;
    }
  }
  return false;
}
