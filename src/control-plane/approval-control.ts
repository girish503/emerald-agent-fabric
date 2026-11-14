/**
 * Emerald Agent Fabric — Production Control Plane: Approval Control
 *
 * Implements governed human-in-the-loop approval gates with optional durable SQLite persistence,
 * strict contextual binding (runId, taskId, tenantId, contractHash, operation, parametersHash),
 * expiration enforcement, and atomic single-use consumption.
 *
 * Invariant:
 * The model cannot self-approve. Approval is strictly a human governance operation.
 */

import * as crypto from "node:crypto";
import { computeCanonicalHash } from "../domain/canonical-hash.js";
import { ClockPort, SystemClock } from "../ports/clock.port.js";
import type { DurableApprovalRecord, DurableApprovalStatus, StateStorePort } from "../ports/state-store.port.js";

export type ApprovalStatus = DurableApprovalStatus;

export interface ApprovalRequest {
  readonly approvalId: string;
  readonly runId: string;
  readonly taskId?: string;
  readonly tenantId?: string;
  readonly contractHash?: string;
  readonly actionId?: string;
  readonly operation: string;
  readonly parameters: Record<string, unknown>;
  readonly parametersHash: string;
  readonly riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  readonly justification: string;
  readonly status: ApprovalStatus;
  readonly singleUse: boolean;
  readonly requestedAt: string;
  readonly expiresAt?: string;
  readonly decidedAt?: string;
  readonly consumedAt?: string;
  readonly consumedByRunId?: string;
  readonly approver?: string;
  readonly decisionReason?: string;
}

export type ApprovalStorePort = Pick<
  StateStorePort,
  "insertApprovalRequest" | "getApprovalRequest" | "listApprovalRequests" | "updateApprovalDecision" | "consumeApprovalRequest"
>;

export interface RequestApprovalParams {
  readonly runId: string;
  readonly taskId?: string;
  readonly tenantId?: string;
  readonly contractHash?: string;
  readonly actionId?: string;
  readonly operation: string;
  readonly parameters: Record<string, unknown>;
  readonly riskLevel: ApprovalRequest["riskLevel"];
  readonly justification: string;
  readonly expiresAt?: string;
  readonly ttlMs?: number;
  readonly singleUse?: boolean;
}

export interface ApprovalVerificationParams {
  readonly approvalId?: string;
  readonly runId: string;
  readonly taskId?: string;
  readonly tenantId?: string;
  readonly contractHash?: string;
  readonly subjectId?: string;
  readonly operation: string;
  readonly parametersHash: string;
  readonly consume?: boolean;
}

export type ApprovalVerificationStatus =
  | "APPROVED"
  | "MISSING"
  | "PENDING"
  | "REJECTED"
  | "CONSUMED"
  | "EXPIRED"
  | "MISMATCH";

export interface ApprovalVerificationResult {
  readonly authorized: boolean;
  readonly status: ApprovalVerificationStatus;
  readonly approvalId?: string;
  readonly reason: string;
}

const DISALLOWED_APPROVER_IDS = /^(model|agent|llm|ai|autonomous|autonomous-agent|self)$/i;

function validateHumanApprover(approver: string): string {
  if (typeof approver !== "string" || approver.trim().length === 0) {
    throw new Error("Approval requires a non-empty human operator identifier");
  }
  const normalized = approver.trim();
  if (DISALLOWED_APPROVER_IDS.test(normalized)) {
    throw new Error(`Model or agent identity '${normalized}' cannot self-approve governed operations`);
  }
  return normalized;
}

function fromDurableRecord(r: DurableApprovalRecord): ApprovalRequest {
  return {
    approvalId: r.approvalId,
    runId: r.runId,
    ...(r.taskId ? { taskId: r.taskId } : {}),
    ...(r.tenantId ? { tenantId: r.tenantId } : {}),
    ...(r.contractHash ? { contractHash: r.contractHash } : {}),
    ...(r.actionId ? { actionId: r.actionId } : {}),
    operation: r.operation,
    parameters: r.parameters,
    parametersHash: r.parametersHash,
    riskLevel: r.riskLevel,
    justification: r.justification,
    status: r.status,
    singleUse: r.singleUse,
    requestedAt: r.requestedAt,
    ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}),
    ...(r.decidedAt ? { decidedAt: r.decidedAt } : {}),
    ...(r.consumedAt ? { consumedAt: r.consumedAt } : {}),
    ...(r.consumedByRunId ? { consumedByRunId: r.consumedByRunId } : {}),
    ...(r.approver ? { approver: r.approver } : {}),
    ...(r.decisionReason ? { decisionReason: r.decisionReason } : {}),
  };
}

export class ApprovalControl {
  private readonly approvals: Map<string, ApprovalRequest> = new Map();
  private approvalCounter: number = 0;

  constructor(
    private readonly clock: ClockPort = new SystemClock(),
    private readonly store?: ApprovalStorePort,
    private readonly requireDurableStore: boolean = false
  ) {
    if (this.requireDurableStore && !this.hasDurableStore()) {
      throw new Error(
        "ApprovalControl: Durable SQLite approval store required in production path; in-memory fallback is forbidden."
      );
    }
  }

  private hasDurableStore(): boolean {
    return Boolean(
      this.store?.insertApprovalRequest &&
        this.store?.getApprovalRequest &&
        this.store?.listApprovalRequests &&
        this.store?.updateApprovalDecision &&
        this.store?.consumeApprovalRequest
    );
  }

  /**
   * Request human approval for a high-risk operation.
   */
  public requestApproval(params: RequestApprovalParams): ApprovalRequest {
    this.approvalCounter++;
    const nowMs = this.clock.now().getTime();
    const nowIso = new Date(nowMs).toISOString();
    const approvalId = `appr-${nowMs}-${this.approvalCounter}-${crypto.randomUUID().slice(0, 8)}`;
    const hashed = computeCanonicalHash(params.parameters ?? {});
    const parametersHash = hashed.contentHash;
    const redactedParameters =
      hashed.redacted && typeof hashed.redacted === "object" && !Array.isArray(hashed.redacted)
        ? (hashed.redacted as Record<string, unknown>)
        : {};

    let expiresAt = params.expiresAt;
    if (!expiresAt && typeof params.ttlMs === "number") {
      expiresAt = new Date(nowMs + params.ttlMs).toISOString();
    }

    const request: ApprovalRequest = {
      approvalId,
      runId: params.runId,
      ...(params.taskId ? { taskId: params.taskId } : {}),
      ...(params.tenantId ? { tenantId: params.tenantId } : {}),
      ...(params.contractHash ? { contractHash: params.contractHash } : {}),
      ...(params.actionId ? { actionId: params.actionId } : {}),
      operation: params.operation,
      parameters: redactedParameters,
      parametersHash,
      riskLevel: params.riskLevel,
      justification: params.justification,
      status: "PENDING",
      singleUse: params.singleUse !== false,
      requestedAt: nowIso,
      ...(expiresAt ? { expiresAt } : {}),
    };

    if (this.hasDurableStore()) {
      this.store!.insertApprovalRequest!({
        approvalId: request.approvalId,
        runId: request.runId,
        taskId: request.taskId ?? "",
        tenantId: request.tenantId ?? "",
        contractHash: request.contractHash ?? "",
        ...(request.actionId ? { actionId: request.actionId } : {}),
        operation: request.operation,
        parameters: request.parameters,
        parametersHash: request.parametersHash,
        riskLevel: request.riskLevel,
        justification: request.justification,
        status: request.status,
        singleUse: request.singleUse,
        requestedAt: request.requestedAt,
        ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
      });
    } else {
      this.approvals.set(approvalId, request);
    }

    return request;
  }

  public getApproval(approvalId: string): ApprovalRequest | undefined {
    if (this.hasDurableStore()) {
      const rec = this.store!.getApprovalRequest!(approvalId);
      return rec ? fromDurableRecord(rec) : undefined;
    }
    return this.approvals.get(approvalId);
  }

  public listPending(): readonly ApprovalRequest[] {
    if (this.hasDurableStore()) {
      return this.store!.listApprovalRequests!({ status: "PENDING" }).map(fromDurableRecord);
    }
    return Array.from(this.approvals.values()).filter((a) => a.status === "PENDING");
  }

  public listAll(runId?: string): readonly ApprovalRequest[] {
    if (this.hasDurableStore()) {
      return this.store!.listApprovalRequests!(runId ? { runId } : undefined).map(fromDurableRecord);
    }
    const all = Array.from(this.approvals.values());
    return runId ? all.filter((a) => a.runId === runId) : all;
  }

  public approve(approvalId: string, approver: string, reason?: string): ApprovalRequest {
    const cleanApprover = validateHumanApprover(approver);
    const req = this.getApproval(approvalId);
    if (!req) throw new Error(`Approval request not found: ${approvalId}`);
    if (req.status !== "PENDING") throw new Error(`Approval already decided: ${req.status}`);

    const nowIso = this.clock.now().toISOString();
    if (req.expiresAt && Date.parse(req.expiresAt) <= Date.parse(nowIso)) {
      this.markExpired(req);
      throw new Error(`Approval request expired: ${approvalId}`);
    }

    const decisionReason = reason ?? "Approved by operator";
    if (this.hasDurableStore()) {
      const updated = this.store!.updateApprovalDecision!({
        approvalId,
        expectedStatus: "PENDING",
        nextStatus: "APPROVED",
        approver: cleanApprover,
        decisionReason,
        decidedAt: nowIso,
      });
      if (!updated) {
        throw new Error(`Approval state conflict while approving: ${approvalId}`);
      }
      return fromDurableRecord(updated);
    }

    const updated: ApprovalRequest = {
      ...req,
      status: "APPROVED",
      approver: cleanApprover,
      decisionReason,
      decidedAt: nowIso,
    };
    this.approvals.set(approvalId, updated);
    return updated;
  }

  public reject(approvalId: string, approver: string, reason: string): ApprovalRequest {
    const cleanApprover = validateHumanApprover(approver);
    const req = this.getApproval(approvalId);
    if (!req) throw new Error(`Approval request not found: ${approvalId}`);
    if (req.status !== "PENDING") throw new Error(`Approval already decided: ${req.status}`);

    const nowIso = this.clock.now().toISOString();
    if (this.hasDurableStore()) {
      const updated = this.store!.updateApprovalDecision!({
        approvalId,
        expectedStatus: "PENDING",
        nextStatus: "REJECTED",
        approver: cleanApprover,
        decisionReason: reason,
        decidedAt: nowIso,
      });
      if (!updated) {
        throw new Error(`Approval state conflict while rejecting: ${approvalId}`);
      }
      return fromDurableRecord(updated);
    }

    const updated: ApprovalRequest = {
      ...req,
      status: "REJECTED",
      approver: cleanApprover,
      decisionReason: reason,
      decidedAt: nowIso,
    };
    this.approvals.set(approvalId, updated);
    return updated;
  }

  private markExpired(req: ApprovalRequest): void {
    if (this.hasDurableStore()) {
      this.store!.updateApprovalDecision!({
        approvalId: req.approvalId,
        expectedStatus: req.status,
        nextStatus: "EXPIRED",
        decisionReason: req.decisionReason ?? "Approval window expired",
      });
    } else {
      this.approvals.set(req.approvalId, {
        ...req,
        status: "EXPIRED",
      });
    }
  }

  private checkBindingMismatch(req: ApprovalRequest, params: ApprovalVerificationParams): string | null {
    if (req.runId !== params.runId) {
      return `Approval '${req.approvalId}' is bound to run '${req.runId}', not '${params.runId}'`;
    }
    if (req.operation !== params.operation) {
      return `Approval '${req.approvalId}' is bound to operation '${req.operation}', not '${params.operation}'`;
    }
    if (req.parametersHash !== params.parametersHash) {
      return `Approval '${req.approvalId}' parameter digest does not match proposed invocation`;
    }
    if (req.taskId && params.taskId !== req.taskId) {
      return `Approval '${req.approvalId}' task binding mismatch (expected '${req.taskId}', got '${params.taskId ?? ""}')`;
    }
    if (req.tenantId && params.tenantId !== req.tenantId) {
      return `Approval '${req.approvalId}' tenant binding mismatch (expected '${req.tenantId}', got '${params.tenantId ?? ""}')`;
    }
    if (req.contractHash && params.contractHash !== req.contractHash) {
      return `Approval '${req.approvalId}' contractHash binding mismatch`;
    }
    if (params.subjectId && req.approver && req.approver === params.subjectId) {
      return `Self-approval forbidden: approver '${req.approver}' matches execution subject`;
    }
    return null;
  }

  /**
   * Verifies that a valid, unbound-tampering, unexpired, non-consumed operator approval
   * exists for the exact execution context, optionally consuming single-use approvals atomically.
   */
  public authorizeAndConsume(params: ApprovalVerificationParams): ApprovalVerificationResult {
    const consume = params.consume !== false;
    let candidate: ApprovalRequest | undefined;

    if (params.approvalId) {
      candidate = this.getApproval(params.approvalId);
      if (!candidate) {
        return {
          authorized: false,
          status: "MISSING",
          reason: `Approval request '${params.approvalId}' not found`,
        };
      }
      const mismatch = this.checkBindingMismatch(candidate, params);
      if (mismatch) {
        return {
          authorized: false,
          status: "MISMATCH",
          approvalId: candidate.approvalId,
          reason: mismatch,
        };
      }
    } else {
      const sameRunOp = this.listAll(params.runId).filter((a) => a.operation === params.operation);
      if (sameRunOp.length === 0) {
        return {
          authorized: false,
          status: "MISSING",
          reason: `Operation ${params.operation} is high-risk and requires operator approval`,
        };
      }

      // First try exact contextual match that is APPROVED
      const exactApproved = sameRunOp.find(
        (a) => a.status === "APPROVED" && this.checkBindingMismatch(a, params) === null
      );
      if (exactApproved) {
        candidate = exactApproved;
      } else {
        // Prefer exact binding in non-approved terminal/pending states for accurate status reporting
        const exactMatch = sameRunOp.find((a) => this.checkBindingMismatch(a, params) === null);
        if (exactMatch) {
          candidate = exactMatch;
        } else {
          // Exists for same run+operation, but parameters or task/tenant/contract mismatch
          return {
            authorized: false,
            status: "MISMATCH",
            approvalId: sameRunOp[0]!.approvalId,
            reason: `Existing approval '${sameRunOp[0]!.approvalId}' does not match current invocation context or parameters`,
          };
        }
      }
    }

    const nowMs = this.clock.now().getTime();
    const nowIso = new Date(nowMs).toISOString();

    if (candidate.status === "REJECTED") {
      return {
        authorized: false,
        status: "REJECTED",
        approvalId: candidate.approvalId,
        reason: `Operation ${params.operation} was rejected by operator (${candidate.decisionReason ?? "denied"})`,
      };
    }

    if (candidate.status === "CONSUMED") {
      return {
        authorized: false,
        status: "CONSUMED",
        approvalId: candidate.approvalId,
        reason: `Approval '${candidate.approvalId}' has already been consumed (replay blocked)`,
      };
    }

    if (candidate.status === "EXPIRED") {
      return {
        authorized: false,
        status: "EXPIRED",
        approvalId: candidate.approvalId,
        reason: `Approval '${candidate.approvalId}' has expired and is no longer valid`,
      };
    }

    if (candidate.expiresAt && Date.parse(candidate.expiresAt) <= nowMs) {
      this.markExpired(candidate);
      return {
        authorized: false,
        status: "EXPIRED",
        approvalId: candidate.approvalId,
        reason: `Approval '${candidate.approvalId}' expired at ${candidate.expiresAt}`,
      };
    }

    if (candidate.status === "PENDING") {
      return {
        authorized: false,
        status: "PENDING",
        approvalId: candidate.approvalId,
        reason: `Operation ${params.operation} is awaiting operator approval (${candidate.approvalId})`,
      };
    }

    if (!consume || !candidate.singleUse) {
      return {
        authorized: true,
        status: "APPROVED",
        approvalId: candidate.approvalId,
        reason: "Operator approval verified",
      };
    }

    // Consume single-use approval atomically
    if (this.hasDurableStore()) {
      const consumed = this.store!.consumeApprovalRequest!({
        approvalId: candidate.approvalId,
        consumedAt: nowIso,
        consumedByRunId: params.runId,
      });
      if (!consumed) {
        return {
          authorized: false,
          status: "CONSUMED",
          approvalId: candidate.approvalId,
          reason: `Approval '${candidate.approvalId}' was already consumed`,
        };
      }
    } else {
      this.approvals.set(candidate.approvalId, {
        ...candidate,
        status: "CONSUMED",
        consumedAt: nowIso,
        consumedByRunId: params.runId,
      });
    }

    return {
      authorized: true,
      status: "APPROVED",
      approvalId: candidate.approvalId,
      reason: "Operator approval verified and consumed",
    };
  }
}
