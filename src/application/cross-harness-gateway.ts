/**
 * Phase 99: Cross-Harness Gateway
 *
 * Mediates requests across distinct harness boundaries, defending against confused deputy
 * exploitation, cross-harness privilege escalation, and unsanitized data flows.
 *
 * ABSOLUTE GOVERNING PRINCIPLE:
 * Capability may be delegated only downward within a fixed safety envelope.
 * Capability composition must never create authority ex nihilo.
 */

import { ClockPort, SystemClock } from "../ports/clock.port.js";
import {
  CrossHarnessRequest,
  CrossHarnessRequestType,
  DelegationDecision,
  HarnessType,
  computeCrossHarnessRequestHash,
} from "../domain/cross-harness-request.js";
import { CapabilityFenceEnforcer } from "./capability-fence-enforcer.js";

export interface GatewayEvaluationResult {
  readonly granted: boolean;
  readonly requestId: string;
  readonly decision: DelegationDecision;
  readonly denialReason?: string;
  readonly controlId?: string;
  readonly sanitizedPayload?: Record<string, unknown>;
}

export class CrossHarnessGateway {
  private readonly requests: Map<string, CrossHarnessRequest> = new Map();
  private requestCounter: number = 0;

  constructor(
    private readonly fenceEnforcer: CapabilityFenceEnforcer,
    private readonly clock: ClockPort = new SystemClock(),
  ) {}

  /**
   * Submit and evaluate a cross-harness request.
   */
  public handleCrossHarnessRequest(
    callerSubjectId: string,
    callerHarness: HarnessType,
    calleeHarness: HarnessType,
    requestType: CrossHarnessRequestType,
    requestedCapability: string,
    targetResource: string,
    payload: Record<string, unknown>,
    missionContractId: string,
    missionContractHash: string,
  ): GatewayEvaluationResult {
    const nowIso = this.clock.now().toISOString();
    this.requestCounter++;
    const requestId = `chr-${this.requestCounter}`;

    const callerFence = this.fenceEnforcer.getActiveFenceForSubject(callerSubjectId);

    // Initial check: Caller must have an active registered fence
    if (!callerFence) {
      const denial = this.createAndStoreRequest({
        requestId,
        callerSubjectId,
        callerHarness,
        calleeHarness,
        requestType,
        requestedCapability,
        targetResource,
        payload,
        missionContractId,
        missionContractHash,
        callerFenceId: "NONE",
        status: "DENIED",
        decision: "DENY",
        denialReason: "Caller subject has no active capability fence",
        controlId: "N691",
        submittedAt: nowIso,
        evaluatedAt: nowIso,
        authoritative: false,
      });
      return {
        granted: false,
        requestId,
        decision: "DENY",
        denialReason: denial.denialReason,
        controlId: denial.controlId,
      };
    }

    // Invariant C10 & Control N703: Mission Contract hash binding check
    if (callerFence.missionContractHash !== missionContractHash) {
      const denial = this.createAndStoreRequest({
        requestId,
        callerSubjectId,
        callerHarness,
        calleeHarness,
        requestType,
        requestedCapability,
        targetResource,
        payload,
        missionContractId,
        missionContractHash,
        callerFenceId: callerFence.fenceId,
        status: "DENIED",
        decision: "DENY",
        denialReason: "Mission contract hash mismatch on cross-harness request",
        controlId: "N703",
        submittedAt: nowIso,
        evaluatedAt: nowIso,
        authoritative: false,
      });
      return {
        granted: false,
        requestId,
        decision: "DENY",
        denialReason: denial.denialReason,
        controlId: denial.controlId,
      };
    }

    // Invariant C19 & Control N720: Terminal authority cannot be claimed or granted
    if (requestedCapability === "ISSUE_TERMINAL_AUTHORITY") {
      const denial = this.createAndStoreRequest({
        requestId,
        callerSubjectId,
        callerHarness,
        calleeHarness,
        requestType,
        requestedCapability,
        targetResource,
        payload,
        missionContractId,
        missionContractHash,
        callerFenceId: callerFence.fenceId,
        status: "DENIED",
        decision: "DENY",
        denialReason: "Terminal authority cannot be issued or claimed via cross-harness request",
        controlId: "N720",
        submittedAt: nowIso,
        evaluatedAt: nowIso,
        authoritative: false,
      });
      return {
        granted: false,
        requestId,
        decision: "DENY",
        denialReason: denial.denialReason,
        controlId: denial.controlId,
      };
    }

    // Invariant C5 & Control N693: Cross-harness privilege escalation check
    // e.g. caller in ANALYSIS_HARNESS cannot ask IMPLEMENTATION_HARNESS to write repository
    if (requestedCapability === "WRITE_REPOSITORY" || requestedCapability === "COMMIT_GIT") {
      const denial = this.createAndStoreRequest({
        requestId,
        callerSubjectId,
        callerHarness,
        calleeHarness,
        requestType,
        requestedCapability,
        targetResource,
        payload,
        missionContractId,
        missionContractHash,
        callerFenceId: callerFence.fenceId,
        status: "DENIED",
        decision: "DENY",
        denialReason: "Cross-harness privilege escalation to write repository forbidden",
        controlId: "N693",
        submittedAt: nowIso,
        evaluatedAt: nowIso,
        authoritative: false,
      });
      return {
        granted: false,
        requestId,
        decision: "DENY",
        denialReason: denial.denialReason,
        controlId: denial.controlId,
      };
    }

    // Control N709: Cross-harness data flow sanitization
    const sanitizeResult = this.sanitizeCrossHarnessPayload(payload);
    if (!sanitizeResult.safe) {
      const denial = this.createAndStoreRequest({
        requestId,
        callerSubjectId,
        callerHarness,
        calleeHarness,
        requestType,
        requestedCapability,
        targetResource,
        payload,
        missionContractId,
        missionContractHash,
        callerFenceId: callerFence.fenceId,
        status: "QUARANTINED",
        decision: "QUARANTINE",
        denialReason: `Cross-harness data flow rejected: ${sanitizeResult.reason}`,
        controlId: "N709",
        submittedAt: nowIso,
        evaluatedAt: nowIso,
        authoritative: false,
      });
      return {
        granted: false,
        requestId,
        decision: "QUARANTINE",
        denialReason: denial.denialReason,
        controlId: "N709",
      };
    }

    // Invariant C7 & Control N696: Confused Deputy Defense
    // The caller must independently hold the permission for the requested capability
    const capabilityCheck = this.fenceEnforcer.evaluateCapability(
      callerFence.fenceId,
      callerSubjectId,
      requestedCapability,
      { missionContractHash },
    );
    if (!capabilityCheck.granted) {
      const denial = this.createAndStoreRequest({
        requestId,
        callerSubjectId,
        callerHarness,
        calleeHarness,
        requestType,
        requestedCapability,
        targetResource,
        payload,
        missionContractId,
        missionContractHash,
        callerFenceId: callerFence.fenceId,
        status: "DENIED",
        decision: "DENY",
        denialReason: `Confused deputy or undeclared cross-harness capability: ${capabilityCheck.denialReason}`,
        controlId: "N696",
        submittedAt: nowIso,
        evaluatedAt: nowIso,
        authoritative: false,
      });
      return {
        granted: false,
        requestId,
        decision: "DENY",
        denialReason: denial.denialReason,
        controlId: "N696",
      };
    }

    // Granted: Safe cross-harness request evaluated
    this.createAndStoreRequest({
      requestId,
      callerSubjectId,
      callerHarness,
      calleeHarness,
      requestType,
      requestedCapability,
      targetResource,
      payload: sanitizeResult.sanitized,
      missionContractId,
      missionContractHash,
      callerFenceId: callerFence.fenceId,
      status: "GRANTED",
      decision: "GRANT",
      submittedAt: nowIso,
      evaluatedAt: nowIso,
      authoritative: false,
    });

    return {
      granted: true,
      requestId,
      decision: "GRANT",
      sanitizedPayload: sanitizeResult.sanitized,
    };
  }

  private sanitizeCrossHarnessPayload(payload: Record<string, unknown>): {
    safe: boolean;
    reason?: string;
    sanitized: Record<string, unknown>;
  } {
    const raw = JSON.stringify(payload);
    const dangerousPatterns = [
      /rm\s+-rf/i,
      /sudo/i,
      /docker\.sock/i,
      /\/etc\/passwd/i,
      /eval\(/i,
      /process\.exit/i,
      /child_process/i,
      /require\(["']fs["']\)/i,
      /__proto__/i,
    ];

    for (const pat of dangerousPatterns) {
      if (pat.test(raw)) {
        return { safe: false, reason: `Dangerous pattern detected in payload: ${pat}`, sanitized: {} };
      }
    }

    // Return sanitized deep clone
    const sanitized = JSON.parse(raw);
    delete sanitized["terminalAuthority"];
    delete sanitized["bypassGovernance"];
    return { safe: true, sanitized };
  }

  private createAndStoreRequest(
    data: Omit<CrossHarnessRequest, "hash">,
  ): CrossHarnessRequest {
    const request: CrossHarnessRequest = {
      ...data,
      hash: computeCrossHarnessRequestHash(data),
    };
    this.requests.set(request.requestId, request);
    return request;
  }

  public getAllRequests(): readonly CrossHarnessRequest[] {
    return Array.from(this.requests.values());
  }

  public getRequest(requestId: string): CrossHarnessRequest | undefined {
    return this.requests.get(requestId);
  }
}
