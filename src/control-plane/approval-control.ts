/**
 * Emerald Agent Fabric — Production Control Plane: Approval Control
 *
 * Implements governed human-in-the-loop approval gates.
 *
 * Invariant:
 * The model cannot self-approve. Approval is strictly a human governance operation.
 */

import { ClockPort, SystemClock } from "../ports/clock.port.js";

export interface ApprovalRequest {
  readonly approvalId: string;
  readonly runId: string;
  readonly operation: string;
  readonly parameters: Record<string, unknown>;
  readonly riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  readonly justification: string;
  readonly status: "PENDING" | "APPROVED" | "REJECTED";
  readonly requestedAt: string;
  readonly decidedAt?: string;
  readonly approver?: string;
  readonly decisionReason?: string;
}

export class ApprovalControl {
  private readonly approvals: Map<string, ApprovalRequest> = new Map();
  private approvalCounter: number = 0;

  constructor(private readonly clock: ClockPort = new SystemClock()) {}

  /**
   * Request human approval for a high-risk operation.
   */
  public requestApproval(params: {
    runId: string;
    operation: string;
    parameters: Record<string, unknown>;
    riskLevel: ApprovalRequest["riskLevel"];
    justification: string;
  }): ApprovalRequest {
    this.approvalCounter++;
    const approvalId = `appr-${Date.now()}-${this.approvalCounter}`;
    const request: ApprovalRequest = {
      approvalId,
      runId: params.runId,
      operation: params.operation,
      parameters: params.parameters,
      riskLevel: params.riskLevel,
      justification: params.justification,
      status: "PENDING",
      requestedAt: this.clock.now().toISOString(),
    };
    this.approvals.set(approvalId, request);
    return request;
  }

  public getApproval(approvalId: string): ApprovalRequest | undefined {
    return this.approvals.get(approvalId);
  }

  public listPending(): readonly ApprovalRequest[] {
    return Array.from(this.approvals.values()).filter((a) => a.status === "PENDING");
  }

  public listAll(): readonly ApprovalRequest[] {
    return Array.from(this.approvals.values());
  }

  public approve(approvalId: string, approver: string, reason?: string): ApprovalRequest {
    const req = this.approvals.get(approvalId);
    if (!req) throw new Error(`Approval request not found: ${approvalId}`);
    if (req.status !== "PENDING") throw new Error(`Approval already decided: ${req.status}`);

    const updated: ApprovalRequest = {
      ...req,
      status: "APPROVED",
      approver,
      decisionReason: reason ?? "Approved by operator",
      decidedAt: this.clock.now().toISOString(),
    };
    this.approvals.set(approvalId, updated);
    return updated;
  }

  public reject(approvalId: string, approver: string, reason: string): ApprovalRequest {
    const req = this.approvals.get(approvalId);
    if (!req) throw new Error(`Approval request not found: ${approvalId}`);
    if (req.status !== "PENDING") throw new Error(`Approval already decided: ${req.status}`);

    const updated: ApprovalRequest = {
      ...req,
      status: "REJECTED",
      approver,
      decisionReason: reason,
      decidedAt: this.clock.now().toISOString(),
    };
    this.approvals.set(approvalId, updated);
    return updated;
  }
}
