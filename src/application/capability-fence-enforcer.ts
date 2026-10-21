/**
 * Phase 99: Capability Fence Enforcer
 *
 * Implements capability lattice evaluation, downward delegation bounding,
 * intersection-only capability composition, anti-laundering / anti-splitting detection,
 * immediate revocation cascades, and cryptographic audit recording.
 *
 * ABSOLUTE GOVERNING PRINCIPLE:
 * Capability may be delegated only downward within a fixed safety envelope.
 * Capability composition must never create authority ex nihilo.
 */

import * as path from "node:path";
import { ClockPort, SystemClock } from "../ports/clock.port.js";
import { sha256Hex } from "../domain/canonical-hash.js";
import {
  ALL_FORBIDDEN_CAPABILITIES,
  CapabilityDenial,
  CapabilityEvidence,
  CapabilityFence,
  CapabilityGrant,
  CapabilityScope,
  CapabilityViolation,
  ForbiddenCapability,
  PositiveCapability,
  computeCapabilityDenialHash,
  computeCapabilityEvidenceHash,
  computeCapabilityFenceHash,
  computeCapabilityGrantHash,
  computeCapabilityViolationHash,
  intersectCapabilities,
  isScopeContained,
  isSubCapabilitySet,
} from "../domain/capability-fence.js";
import {
  DelegationRecord,
  computeDelegationRecordHash,
} from "../domain/cross-harness-request.js";

export interface CapabilityCheckResult {
  readonly granted: boolean;
  readonly fenceId?: string;
  readonly subjectId: string;
  readonly requestedCapability: string;
  readonly denialReason?: string;
  readonly controlId?: string;
  readonly violationType?: string;
  readonly grant?: CapabilityGrant;
}

export class CapabilityFenceEnforcer {
  private readonly fences: Map<string, CapabilityFence> = new Map();
  private readonly grants: Map<string, CapabilityGrant> = new Map();
  private readonly denials: Map<string, CapabilityDenial> = new Map();
  private readonly evidences: Map<string, CapabilityEvidence> = new Map();
  private readonly violations: Map<string, CapabilityViolation> = new Map();
  private readonly delegations: Map<string, DelegationRecord> = new Map();
  private readonly operationHistory: Array<{
    subjectId: string;
    capability: string;
    timestamp: string;
  }> = [];

  constructor(private readonly clock: ClockPort = new SystemClock()) {}

  /**
   * Register and activate a governed capability fence.
   */
  public registerFence(fence: CapabilityFence): void {
    this.fences.set(fence.fenceId, fence);
    this.recordEvidence(
      fence.fenceId,
      "FENCE_REGISTERED",
      { subjectId: fence.subjectId, roleId: fence.roleId, harnessId: fence.harnessId },
      fence.missionContractHash,
    );
  }

  /**
   * Retrieve a capability fence by ID.
   */
  public getFence(fenceId: string): CapabilityFence | undefined {
    return this.fences.get(fenceId);
  }

  /**
   * Retrieve active fence for a given subject.
   */
  public getActiveFenceForSubject(subjectId: string): CapabilityFence | undefined {
    for (const fence of Array.from(this.fences.values())) {
      if (fence.subjectId === subjectId && fence.status === "ACTIVE") {
        return fence;
      }
    }
    return undefined;
  }

  /**
   * Verify and evaluate an attempted capability invocation.
   */
  public evaluateCapability(
    fenceId: string,
    subjectId: string,
    capability: string,
    options?: {
      targetPath?: string;
      toolName?: string;
      intermediarySubjectId?: string;
      missionContractHash?: string;
      fenceVersion?: number;
    },
  ): CapabilityCheckResult {
    const nowIso = this.clock.now().toISOString();
    const fence = this.fences.get(fenceId);

    // N691 / N705: Missing fence or synthetic grant without provenance
    if (!fence) {
      this.recordDenial(fenceId, subjectId, capability, "Fence not found or unregistered", "N705");
      return {
        granted: false,
        subjectId,
        requestedCapability: capability,
        denialReason: "Fence not found or unregistered",
        controlId: "N705",
      };
    }

    // N701: Revoked fence check
    if (fence.status === "REVOKED") {
      this.recordDenial(fenceId, subjectId, capability, "Fence is revoked", "N701");
      this.recordViolation(fenceId, subjectId, capability, "REVOKED", "CRITICAL");
      return {
        granted: false,
        fenceId,
        subjectId,
        requestedCapability: capability,
        denialReason: "Fence is revoked",
        controlId: "N701",
        violationType: "REVOKED",
      };
    }

    // N700: Expired fence lease check
    if (fence.status === "EXPIRED" || new Date(fence.expiresAt).getTime() <= this.clock.now().getTime()) {
      this.recordDenial(fenceId, subjectId, capability, "Fence lease expired", "N700");
      this.recordViolation(fenceId, subjectId, capability, "EXPIRED", "HIGH");
      return {
        granted: false,
        fenceId,
        subjectId,
        requestedCapability: capability,
        denialReason: "Fence lease expired",
        controlId: "N700",
        violationType: "EXPIRED",
      };
    }

    // Active status check
    if (fence.status !== "ACTIVE") {
      this.recordDenial(fenceId, subjectId, capability, `Fence status is ${fence.status}`, "N691");
      return {
        granted: false,
        fenceId,
        subjectId,
        requestedCapability: capability,
        denialReason: `Fence status is ${fence.status}`,
        controlId: "N691",
      };
    }

    // N702: Fence version mismatch
    if (options?.fenceVersion !== undefined && options.fenceVersion !== fence.version) {
      this.recordDenial(fenceId, subjectId, capability, "Fence version mismatch", "N702");
      return {
        granted: false,
        fenceId,
        subjectId,
        requestedCapability: capability,
        denialReason: "Fence version mismatch",
        controlId: "N702",
      };
    }

    // N703: Mission contract hash mismatch
    if (
      options?.missionContractHash !== undefined &&
      options.missionContractHash !== fence.missionContractHash
    ) {
      this.recordDenial(fenceId, subjectId, capability, "Mission contract hash mismatch", "N703");
      return {
        granted: false,
        fenceId,
        subjectId,
        requestedCapability: capability,
        denialReason: "Mission contract hash mismatch",
        controlId: "N703",
      };
    }

    // Invariant C1 & N691: Absolute forbidden capabilities check
    if (ALL_FORBIDDEN_CAPABILITIES.includes(capability as ForbiddenCapability)) {
      this.recordDenial(fenceId, subjectId, capability, "Requested capability is strictly forbidden", "N691");
      this.recordViolation(fenceId, subjectId, capability, "FORBIDDEN", "CRITICAL");
      return {
        granted: false,
        fenceId,
        subjectId,
        requestedCapability: capability,
        denialReason: "Requested capability is strictly forbidden",
        controlId: "N691",
        violationType: "FORBIDDEN",
      };
    }

    // N711: Tool check against allowedTools in scope
    if (options?.toolName) {
      if (!fence.scope.allowedTools.includes(options.toolName)) {
        this.recordDenial(fenceId, subjectId, capability, `Tool ${options.toolName} not allowed in scope`, "N711");
        this.recordViolation(fenceId, subjectId, capability, "SCOPE_BREACH", "HIGH");
        return {
          granted: false,
          fenceId,
          subjectId,
          requestedCapability: capability,
          denialReason: `Tool ${options.toolName} not allowed in scope`,
          controlId: "N711",
          violationType: "SCOPE_BREACH",
        };
      }
    }

    // N710 & Invariant C12: Path traversal check outside workspace
    if (options?.targetPath) {
      const rawNormalized = options.targetPath.replace(/\\/g, "/");
      const hasTraversal =
        rawNormalized.includes("../") ||
        rawNormalized.includes("/..") ||
        rawNormalized.startsWith("../") ||
        rawNormalized.includes("..\\") ||
        options.targetPath.includes("..");

      let resolvedTarget = rawNormalized;
      if (!path.isAbsolute(options.targetPath) && !rawNormalized.startsWith("/")) {
        const base = fence.scope.allowedWorkspacePaths[0] ?? "/workspace";
        resolvedTarget = path.resolve(base, options.targetPath).replace(/\\/g, "/");
      }

      const normTarget = resolvedTarget.toLowerCase();
      const isForbidden = fence.scope.forbiddenWorkspacePaths.some((p) => {
        const normP = p.replace(/\\/g, "/").toLowerCase();
        return normTarget.startsWith(normP) || normTarget.includes("/" + normP.replace(/^\//, ""));
      });
      const isAllowed = fence.scope.allowedWorkspacePaths.some((p) => {
        const normP = p.replace(/\\/g, "/").toLowerCase();
        return normTarget.startsWith(normP);
      });

      if (hasTraversal || isForbidden || !isAllowed) {
        this.recordDenial(fenceId, subjectId, capability, "Path traversal or outside allowed workspace boundary", "N710");
        this.recordViolation(fenceId, subjectId, capability, "PATH_TRAVERSAL", "CRITICAL");
        return {
          granted: false,
          fenceId,
          subjectId,
          requestedCapability: capability,
          denialReason: "Path traversal or outside allowed workspace boundary",
          controlId: "N710",
          violationType: "PATH_TRAVERSAL",
        };
      }
    }

    // N694 & Invariant C5: Anti-Laundering check
    if (options?.intermediarySubjectId) {
      const originalCallerFence = this.getActiveFenceForSubject(options.intermediarySubjectId);
      if (!originalCallerFence || !originalCallerFence.allowedCapabilities.includes(capability as PositiveCapability)) {
        this.recordDenial(fenceId, subjectId, capability, "Capability laundering attempt detected", "N694");
        this.recordViolation(fenceId, subjectId, capability, "LAUNDERING", "CRITICAL");
        return {
          granted: false,
          fenceId,
          subjectId,
          requestedCapability: capability,
          denialReason: "Capability laundering attempt detected",
          controlId: "N694",
          violationType: "LAUNDERING",
        };
      }
    }

    // N691: Undeclared capability check
    if (!fence.allowedCapabilities.includes(capability as PositiveCapability)) {
      this.recordDenial(fenceId, subjectId, capability, "Undeclared capability for subject", "N691");
      this.recordViolation(fenceId, subjectId, capability, "UNDECLARED", "HIGH");
      return {
        granted: false,
        fenceId,
        subjectId,
        requestedCapability: capability,
        denialReason: "Undeclared capability for subject",
        controlId: "N691",
        violationType: "UNDECLARED",
      };
    }

    // N695 & Invariant C6: Anti-Splitting detection
    this.operationHistory.push({ subjectId, capability, timestamp: nowIso });
    if (this.detectCapabilitySplitting(subjectId)) {
      this.recordDenial(fenceId, subjectId, capability, "Capability splitting attempt aggregating to forbidden action", "N695");
      this.recordViolation(fenceId, subjectId, capability, "SPLITTING", "CRITICAL");
      return {
        granted: false,
        fenceId,
        subjectId,
        requestedCapability: capability,
        denialReason: "Capability splitting attempt aggregating to forbidden action",
        controlId: "N695",
        violationType: "SPLITTING",
      };
    }

    // Issue cryptographic grant
    const grantRaw: Omit<CapabilityGrant, "hash"> = {
      grantId: `grant-${this.grants.size + 1}`,
      fenceId,
      subjectId,
      capability: capability as PositiveCapability,
      scope: fence.scope,
      justification: "Authorized within active capability fence",
      issuedAt: nowIso,
      expiresAt: fence.expiresAt,
      signature: sha256Hex(`sig-${fenceId}-${capability}-${nowIso}`),
    };
    const grant: CapabilityGrant = {
      ...grantRaw,
      hash: computeCapabilityGrantHash(grantRaw),
    };
    this.grants.set(grant.grantId, grant);

    return {
      granted: true,
      fenceId,
      subjectId,
      requestedCapability: capability,
      grant,
    };
  }

  /**
   * Delegate capabilities downward from parent fence to child subject.
   * Invariants C2, C8, C9; Controls N697, N698, N699, N707.
   */
  public delegateCapability(
    parentFenceId: string,
    childSubjectId: string,
    childRoleId: string,
    childHarnessId: string,
    requestedCapabilities: readonly PositiveCapability[],
    requestedScope: CapabilityScope,
    durationMs: number,
  ): { success: boolean; childFence?: CapabilityFence; denialReason?: string; controlId?: string } {
    const parentFence = this.fences.get(parentFenceId);
    if (!parentFence) {
      return { success: false, denialReason: "Parent fence not found", controlId: "N705" };
    }
    if (parentFence.status !== "ACTIVE") {
      return { success: false, denialReason: `Parent fence status is ${parentFence.status}`, controlId: "N701" };
    }

    // N697: Downward-only check: child capabilities MUST be subset of parent
    if (!isSubCapabilitySet(requestedCapabilities, parentFence.allowedCapabilities)) {
      this.recordDenial(parentFenceId, childSubjectId, "DELEGATE", "Child capabilities exceed parent envelope", "N697");
      return { success: false, denialReason: "Child capabilities exceed parent envelope", controlId: "N697" };
    }

    // N699: Scope check: child scope MUST be contained in parent scope
    if (!isScopeContained(requestedScope, parentFence.scope)) {
      this.recordDenial(parentFenceId, childSubjectId, "DELEGATE", "Child scope exceeds parent resource budget", "N699");
      return { success: false, denialReason: "Child scope exceeds parent resource budget", controlId: "N699" };
    }

    // N698: Expiration check: child expiration cannot exceed parent
    const now = this.clock.now().getTime();
    const parentExpiry = new Date(parentFence.expiresAt).getTime();
    const childExpiry = now + durationMs;
    if (childExpiry > parentExpiry) {
      this.recordDenial(parentFenceId, childSubjectId, "DELEGATE", "Child expiration exceeds parent fence lease", "N698");
      return { success: false, denialReason: "Child expiration exceeds parent fence lease", controlId: "N698" };
    }

    const nowIso = this.clock.now().toISOString();
    const childFenceId = `fence-child-${this.fences.size + 1}`;
    const childFenceRaw: Omit<CapabilityFence, "hash"> = {
      fenceId: childFenceId,
      subjectId: childSubjectId,
      roleId: childRoleId,
      harnessId: childHarnessId,
      allowedCapabilities: requestedCapabilities,
      forbiddenCapabilities: parentFence.forbiddenCapabilities,
      scope: requestedScope,
      trustLabel: parentFence.trustLabel,
      status: "ACTIVE",
      parentFenceId,
      delegatedFenceIds: [],
      version: 1,
      missionContractId: parentFence.missionContractId,
      missionContractHash: parentFence.missionContractHash,
      authoritative: false,
      terminalAuthority: false,
      sovereignAuthority: false,
      createdAt: nowIso,
      expiresAt: new Date(childExpiry).toISOString(),
    };
    const childFence: CapabilityFence = {
      ...childFenceRaw,
      hash: computeCapabilityFenceHash(childFenceRaw),
    };

    // Update parent's delegatedFenceIds
    const updatedParentRaw: Omit<CapabilityFence, "hash"> = {
      ...parentFence,
      delegatedFenceIds: [...parentFence.delegatedFenceIds, childFenceId],
    };
    const updatedParent: CapabilityFence = {
      ...updatedParentRaw,
      hash: computeCapabilityFenceHash(updatedParentRaw),
    };
    this.fences.set(parentFenceId, updatedParent);
    this.fences.set(childFenceId, childFence);

    // Record Delegation Record
    const delRaw: Omit<DelegationRecord, "hash"> = {
      delegationId: `del-${this.delegations.size + 1}`,
      parentFenceId,
      childFenceId,
      parentSubjectId: parentFence.subjectId,
      childSubjectId,
      delegatedCapabilities: requestedCapabilities,
      remainingParentCapabilities: parentFence.allowedCapabilities,
      delegatedScope: requestedScope,
      expiresAt: childFence.expiresAt,
      createdAt: nowIso,
    };
    const delRecord: DelegationRecord = {
      ...delRaw,
      hash: computeDelegationRecordHash(delRaw),
    };
    this.delegations.set(delRecord.delegationId, delRecord);

    this.recordEvidence(
      childFenceId,
      "FENCE_DELEGATED",
      { parentFenceId, childSubjectId, requestedCapabilities },
      parentFence.missionContractHash,
    );

    return { success: true, childFence };
  }

  /**
   * Revoke a capability fence and immediately cascade revocation to all descendants.
   * Invariant C9.
   */
  public revokeFence(fenceId: string, reason: string): string[] {
    const revokedIds: string[] = [];
    const queue: string[] = [fenceId];
    const nowIso = this.clock.now().toISOString();

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const fence = this.fences.get(currentId);
      if (!fence) continue;

      const revokedFenceRaw: Omit<CapabilityFence, "hash"> = {
        ...fence,
        status: "REVOKED",
        revokedAt: nowIso,
      };
      const revokedFence: CapabilityFence = {
        ...revokedFenceRaw,
        hash: computeCapabilityFenceHash(revokedFenceRaw),
      };
      this.fences.set(currentId, revokedFence);
      revokedIds.push(currentId);

      this.recordEvidence(
        currentId,
        "FENCE_REVOKED",
        { reason, cascadeFrom: fenceId },
        fence.missionContractHash,
      );

      // Enqueue all children
      for (const childId of fence.delegatedFenceIds) {
        queue.push(childId);
      }
    }

    return revokedIds;
  }

  /**
   * Compose capabilities across multiple fences.
   * Invariants C3, C4; Control N706. Strictly INTERSECTION, never union.
   */
  public composeCapabilities(fenceIds: readonly string[]): {
    composedCapabilities: readonly PositiveCapability[];
    valid: boolean;
    denialReason?: string;
  } {
    if (fenceIds.length === 0) {
      return { composedCapabilities: [], valid: true };
    }

    let intersection: PositiveCapability[] | null = null;

    for (const id of fenceIds) {
      const fence = this.fences.get(id);
      if (!fence || fence.status !== "ACTIVE") {
        return {
          composedCapabilities: [],
          valid: false,
          denialReason: `Fence ${id} is not active`,
        };
      }
      if (new Date(fence.expiresAt).getTime() <= this.clock.now().getTime()) {
        return {
          composedCapabilities: [],
          valid: false,
          denialReason: `Fence ${id} has expired`,
        };
      }

      if (intersection === null) {
        intersection = [...fence.allowedCapabilities];
      } else {
        intersection = intersectCapabilities(intersection, fence.allowedCapabilities);
      }
    }

    return {
      composedCapabilities: intersection || [],
      valid: true,
    };
  }

  private detectCapabilitySplitting(subjectId: string): boolean {
    const recent = this.operationHistory.filter((op) => op.subjectId === subjectId).slice(-5);
    const caps = recent.map((op) => op.capability);
    // If agent performs rapid write output + metadata read + AST read attempting staged git assembly
    if (
      caps.includes("WRITE_TEMPORARY_OUTPUT") &&
      caps.filter((c) => c === "WRITE_TEMPORARY_OUTPUT").length >= 3 &&
      caps.includes("READ_REPOSITORY")
    ) {
      return true;
    }
    return false;
  }

  private recordDenial(
    fenceId: string,
    subjectId: string,
    requestedCapability: string,
    reason: string,
    controlId: string,
  ): void {
    const raw: Omit<CapabilityDenial, "hash"> = {
      denialId: `denial-${this.denials.size + 1}`,
      fenceId,
      subjectId,
      requestedCapability,
      reason,
      controlId,
      attemptedAt: this.clock.now().toISOString(),
    };
    const denial: CapabilityDenial = {
      ...raw,
      hash: computeCapabilityDenialHash(raw),
    };
    this.denials.set(denial.denialId, denial);
  }

  private recordViolation(
    fenceId: string,
    subjectId: string,
    attemptedCapability: string,
    violationType: CapabilityViolation["violationType"],
    severity: CapabilityViolation["severity"],
  ): void {
    const raw: Omit<CapabilityViolation, "hash"> = {
      violationId: `violation-${this.violations.size + 1}`,
      fenceId,
      subjectId,
      attemptedCapability,
      violationType,
      severity,
      blockedAt: this.clock.now().toISOString(),
    };
    const violation: CapabilityViolation = {
      ...raw,
      hash: computeCapabilityViolationHash(raw),
    };
    this.violations.set(violation.violationId, violation);
  }

  private recordEvidence(
    fenceId: string,
    eventType: string,
    details: Record<string, unknown>,
    provenanceRoot: string,
  ): void {
    const raw: Omit<CapabilityEvidence, "hash"> = {
      evidenceId: `evidence-${this.evidences.size + 1}`,
      fenceId,
      eventType,
      details,
      timestamp: this.clock.now().toISOString(),
      provenanceRoot,
    };
    const evidence: CapabilityEvidence = {
      ...raw,
      hash: computeCapabilityEvidenceHash(raw),
    };
    this.evidences.set(evidence.evidenceId, evidence);
  }

  public getAllFences(): readonly CapabilityFence[] {
    return Array.from(this.fences.values());
  }

  public getAllGrants(): readonly CapabilityGrant[] {
    return Array.from(this.grants.values());
  }

  public getAllDenials(): readonly CapabilityDenial[] {
    return Array.from(this.denials.values());
  }

  public getAllEvidences(): readonly CapabilityEvidence[] {
    return Array.from(this.evidences.values());
  }

  public getAllViolations(): readonly CapabilityViolation[] {
    return Array.from(this.violations.values());
  }

  public getAllDelegations(): readonly DelegationRecord[] {
    return Array.from(this.delegations.values());
  }
}
