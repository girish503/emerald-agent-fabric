/**
 * Emerald Agent Fabric — Production Governance Facade
 *
 * Serves as the authoritative single entry point for all governance, capability fencing,
 * policy evaluation, and boundary checks.
 *
 * Core Principle:
 * "The model proposes. The runtime governs. The sandbox executes. The verifier decides. The evidence proves."
 */

import { CapabilityFenceEnforcer } from "../application/capability-fence-enforcer.js";
import { CrossHarnessGateway } from "../application/cross-harness-gateway.js";
import { HarnessType } from "../domain/cross-harness-request.js";
import { ClockPort, SystemClock } from "../ports/clock.port.js";
import { ApprovalControl } from "../control-plane/approval-control.js";

export interface GovernanceDecision {
  readonly authorized: boolean;
  readonly reason?: string;
  readonly controlId?: string;
  readonly requiresHumanApproval?: boolean;
  readonly sanitizedInput?: Record<string, unknown>;
}

export interface GovernanceCheckParams {
  readonly runId: string;
  readonly subjectId: string;
  readonly fenceId: string;
  readonly harnessType: HarnessType;
  readonly capability: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly workspacePath: string;
  readonly missionContractHash: string;
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

  /**
   * Evaluates a proposed tool action against all frozen governance rules.
   * Fails closed on any violation.
   */
  public evaluateProposal(params: GovernanceCheckParams): GovernanceDecision {
    this.checkCounter++;

    // 1. Check if tool operation is high-risk and requires human approval
    if (this.isHighRiskOperation(params.toolName, params.input)) {
      if (this.approvalControl) {
        const pending = this.approvalControl.listPending().find(
          (a) => a.runId === params.runId && a.operation === params.toolName,
        );
        if (!pending || pending.status !== "APPROVED") {
          return {
            authorized: false,
            reason: `Operation ${params.toolName} is high-risk and requires operator approval`,
            requiresHumanApproval: true,
            controlId: "N691",
          };
        }
      }
    }

    // 2. Path containment check
    const targetPath = (params.input["path"] as string) || (params.input["filePath"] as string) || (params.input["cwd"] as string);

    // 3. Evaluate capability via frozen CapabilityFenceEnforcer
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
      return {
        authorized: true,
        sanitizedInput: crossResult.sanitizedPayload,
      };
    }

    return {
      authorized: true,
      sanitizedInput: params.input,
    };
  }

  public getCheckCount(): number {
    return this.checkCounter;
  }

  private isHighRiskOperation(toolName: string, input: Record<string, unknown>): boolean {
    if (toolName === "run_command") {
      const cmd = String(input["command"] || "");
      if (cmd.includes("push") || cmd.includes("rm -rf /") || cmd.includes("deploy") || cmd.includes("reboot")) {
        return true;
      }
    }
    return false;
  }
}
