/**
 * Phase 94: Speculative Promotion Gate
 *
 * Implements the single atomic promotion boundary enforcing all 16 checks.
 *
 * ABSOLUTE PRINCIPLE:
 * Speculation may expand the search space. It must never expand authority.
 *
 * INVARIANTS:
 * 1. Promotion is all-or-nothing (atomic). No partial promotions.
 * 2. Speculative tree changes become authoritative IF AND ONLY IF sovereign fourfold verification passed.
 * 3. Authority leak rate = 0; Stale promotion rate = 0.
 */

import { ClockPort, SystemClock } from "../ports/clock.port.js";
import { canonicalJsonStringify, sha256Hex } from "../domain/canonical-hash.js";
import { SpeculativeBranchStore } from "./speculative-branch-store.js";
import type {
  PromotionOutcomeStatus,
  PromotionRejectionReason,
  RuntimeSpeculativeBinding,
} from "../domain/runtime-speculative-binding.js";

export interface ResourceAllocationLimit {
  readonly cpuMs?: number;
  readonly memoryBytes?: number;
  readonly fileMutations?: number;
  readonly toolCalls?: number;
}

export interface PromotionVerificationPayload {
  readonly verificationId: string;
  readonly branchId: string;
  readonly treeDigest: string;
  readonly passed: boolean;
  readonly sovereignFourfoldVerified: boolean;
  readonly timestamp: string;
  readonly isStale?: boolean;
}

export interface PromotionRequest {
  readonly branchId: string;
  readonly workerId: string;
  readonly leaseId: string;
  readonly isLeaseActive: boolean;
  readonly currentAuthoritativeRevision: string;
  readonly currentAuthoritativeTreeDigest: string;
  readonly activeMissionContractId: string;
  readonly activeMissionContractHash: string;
  readonly activeGoalId: string;
  readonly allocatedResourceLimit?: ResourceAllocationLimit;
  readonly consumedResource?: ResourceAllocationLimit;
  readonly verificationResult?: PromotionVerificationPayload;
  readonly runStatus: string;
  readonly isCancelled?: boolean;
  readonly gatewayPolicyCheck?: {
    readonly allowed: boolean;
    readonly reason?: string;
  };
  readonly binding?: RuntimeSpeculativeBinding;
  readonly idempotencyToken?: string;
}

export interface PromotionRecord {
  readonly eventId: string;
  readonly branchId: string;
  readonly previousTreeDigest: string;
  readonly promotedTreeDigest: string;
  readonly revision: string;
  readonly workerId: string;
  readonly leaseId: string;
  readonly missionContractHash: string;
  readonly verificationId: string;
  readonly timestamp: string;
  readonly provenanceHash: string;
}

export interface PromotionDecision {
  readonly status: PromotionOutcomeStatus;
  readonly branchId: string;
  readonly reason?: PromotionRejectionReason;
  readonly checksFailed: readonly PromotionRejectionReason[];
  readonly promotedTreeDigest?: string;
  readonly promotionRecord?: PromotionRecord;
  readonly timestamp: string;
}

export class SpeculativePromotionGate {
  private readonly store: SpeculativeBranchStore;
  private readonly clock: ClockPort;
  private authoritativeRevision: string;
  private authoritativeTreeDigest: string;
  private readonly promotionHistory: PromotionRecord[] = [];
  private readonly promotedBranches: Map<string, PromotionRecord> = new Map();
  private readonly idempotencyCache: Map<string, PromotionDecision> = new Map();

  constructor(options: {
    readonly store: SpeculativeBranchStore;
    readonly clock?: ClockPort;
    readonly authoritativeRevision?: string;
    readonly authoritativeTreeDigest?: string;
  }) {
    this.store = options.store;
    this.clock = options.clock ?? new SystemClock();
    this.authoritativeRevision = options.authoritativeRevision ?? "rev-init";
    this.authoritativeTreeDigest =
      options.authoritativeTreeDigest ?? sha256Hex("INITIAL_EMPTY_AUTHORITATIVE_TREE");
  }

  public getAuthoritativeRevision(): string {
    return this.authoritativeRevision;
  }

  public getAuthoritativeTreeDigest(): string {
    return this.authoritativeTreeDigest;
  }

  public getPromotionHistory(): readonly PromotionRecord[] {
    return Object.freeze([...this.promotionHistory]);
  }

  public isBranchPromoted(branchId: string): boolean {
    return this.promotedBranches.has(branchId);
  }

  /**
   * Atomically mutates the authoritative tree (for testing external concurrent mutation races).
   */
  public mutateAuthoritativeTreeDirectly(newRevision: string, newDigest: string): void {
    this.authoritativeRevision = newRevision;
    this.authoritativeTreeDigest = newDigest;
  }

  /**
   * Evaluates all 16 atomic promotion checks and performs the atomic state promotion.
   * If any check fails, returns PROMOTION_REJECTED with exact reasons; zero mutation occurs.
   */
  public evaluateAndPromote(req: PromotionRequest): PromotionDecision {
    const now = this.clock.nowIso();

    // Idempotency check (R18)
    if (req.idempotencyToken && this.idempotencyCache.has(req.idempotencyToken)) {
      return this.idempotencyCache.get(req.idempotencyToken)!;
    }

    const checksFailed: PromotionRejectionReason[] = [];

    // Pre-gate check: Run cancellation or non-running status
    if (
      req.isCancelled ||
      req.runStatus === "CANCELLED" ||
      req.runStatus === "FAILED" ||
      req.runStatus === "COMPLETED" ||
      req.runStatus === "TIMED_OUT"
    ) {
      checksFailed.push("RUN_TERMINATED_OR_CANCELLED");
    }

    // Check 1: Branch exists in store
    const branch = this.store.readBranch(req.branchId);
    if (!branch) {
      checksFailed.push("BRANCH_NOT_FOUND");
    }

    // Duplicate promotion check (R18, N561)
    if (branch && this.promotedBranches.has(branch.branchId)) {
      checksFailed.push("DUPLICATE_PROMOTION_DETECTED");
    }

    // Check 2: Branch status is promotable (AWAITING_VERIFICATION or VERIFIED)
    if (branch) {
      if (
        branch.status === "FAILED" ||
        branch.status === "INVALIDATED" ||
        branch.status === "ROLLING_BACK" ||
        branch.status === "ROLLED_BACK" ||
        branch.status === "QUARANTINED" ||
        branch.status === "EXPIRED" ||
        branch.status === "CANCELLED"
      ) {
        checksFailed.push("INVALID_BRANCH_STATUS");
      }
    }

    // Check 3: Branch not expired
    if (branch && branch.status === "EXPIRED") {
      checksFailed.push("BRANCH_EXPIRED");
    }

    // Check 4: Branch not revoked/quarantined
    if (branch && (branch.status === "QUARANTINED" || branch.status === "CANCELLED")) {
      checksFailed.push("BRANCH_REVOKED");
    }

    // Check 5: Worker lease valid and active
    if (!req.isLeaseActive || !req.leaseId || req.leaseId.trim().length === 0) {
      checksFailed.push("INVALID_WORKER_LEASE");
    }

    // Check 6: Mission contract valid (exact match with active contract)
    if (
      !branch ||
      branch.missionContractId !== req.activeMissionContractId ||
      branch.missionContractHash !== req.activeMissionContractHash
    ) {
      checksFailed.push("INVALID_MISSION_CONTRACT");
    }

    // Check 7: Goal valid (matches active goal)
    if (!branch || branch.goalId !== req.activeGoalId) {
      checksFailed.push("INVALID_GOAL");
    }

    // Check 8: Resource allocation valid (consumed <= allocated)
    if (req.allocatedResourceLimit && req.consumedResource) {
      const alloc = req.allocatedResourceLimit;
      const cons = req.consumedResource;
      if (
        (alloc.cpuMs !== undefined && cons.cpuMs !== undefined && cons.cpuMs > alloc.cpuMs) ||
        (alloc.memoryBytes !== undefined &&
          cons.memoryBytes !== undefined &&
          cons.memoryBytes > alloc.memoryBytes) ||
        (alloc.fileMutations !== undefined &&
          cons.fileMutations !== undefined &&
          cons.fileMutations > alloc.fileMutations) ||
        (alloc.toolCalls !== undefined &&
          cons.toolCalls !== undefined &&
          cons.toolCalls > alloc.toolCalls)
      ) {
        checksFailed.push("RESOURCE_ALLOCATION_EXCEEDED");
      }
    }

    // Check 9: Current authoritative tree compatible (must match branch baseTreeDigest)
    if (!branch || branch.baseTreeDigest !== this.authoritativeTreeDigest) {
      checksFailed.push("AUTHORITATIVE_TREE_INCOMPATIBLE");
    }

    // Check 10: Branch base revision compatible
    if (!branch || branch.baseRevision !== this.authoritativeRevision) {
      checksFailed.push("BASE_REVISION_INCOMPATIBLE");
    }

    // Check 11: Tree digest compatible (speculative tree digest must be non-empty and well-formed)
    if (!branch || !branch.speculativeTreeDigest || branch.speculativeTreeDigest.length !== 64) {
      checksFailed.push("TREE_DIGEST_MISMATCH");
    }

    // Check 12: Verification result current (not stale)
    if (!req.verificationResult || req.verificationResult.isStale) {
      checksFailed.push("STALE_VERIFICATION_RESULT");
    }

    // Check 13: Verification result bound to exact branch
    if (
      !req.verificationResult ||
      !branch ||
      req.verificationResult.branchId !== branch.branchId
    ) {
      checksFailed.push("VERIFICATION_BRANCH_MISMATCH");
    }

    // Check 14: Verification result bound to exact tree digest
    if (
      !req.verificationResult ||
      !branch ||
      req.verificationResult.treeDigest !== branch.speculativeTreeDigest
    ) {
      checksFailed.push("VERIFICATION_TREE_MISMATCH");
    }

    // Check 15: Sovereign verification passed (fourfold clean-room verification)
    if (
      !req.verificationResult ||
      !req.verificationResult.passed ||
      !req.verificationResult.sovereignFourfoldVerified
    ) {
      checksFailed.push("SOVEREIGN_VERIFICATION_FAILED");
    }

    // Check 16: Existing gateway policy allows promotion
    if (req.gatewayPolicyCheck && !req.gatewayPolicyCheck.allowed) {
      checksFailed.push("GATEWAY_POLICY_DENIED");
    }

    // Action/Attempt binding validation if provided
    if (req.binding) {
      if (
        req.binding.branchId !== req.branchId ||
        req.binding.workerId !== req.workerId ||
        req.binding.leaseId !== req.leaseId ||
        req.binding.missionContractHash !== req.activeMissionContractHash
      ) {
        checksFailed.push("GATEWAY_POLICY_DENIED");
      }
    }

    // If ANY check failed, reject promotion atomically (zero authoritative mutation)
    if (checksFailed.length > 0) {
      const decision: PromotionDecision = {
        status: "PROMOTION_REJECTED",
        branchId: req.branchId,
        reason: checksFailed[0],
        checksFailed: Object.freeze(checksFailed),
        timestamp: now,
      };
      if (req.idempotencyToken) {
        this.idempotencyCache.set(req.idempotencyToken, decision);
      }
      return decision;
    }

    // ATOMIC PROMOTION COMMIT
    const targetBranch = branch!;
    const previousTreeDigest = this.authoritativeTreeDigest;
    const promotedTreeDigest = targetBranch.speculativeTreeDigest;
    const newRevision = `rev-${this.promotionHistory.length + 1}`;

    const provenancePayload = {
      branchId: targetBranch.branchId,
      previousTreeDigest,
      promotedTreeDigest,
      revision: newRevision,
      workerId: req.workerId,
      leaseId: req.leaseId,
      missionContractHash: req.activeMissionContractHash,
      verificationId: req.verificationResult!.verificationId,
      timestamp: now,
    };
    const provenanceHash = sha256Hex(canonicalJsonStringify(provenancePayload));

    const record: PromotionRecord = {
      eventId: `promo-evt-${this.promotionHistory.length + 1}`,
      branchId: targetBranch.branchId,
      previousTreeDigest,
      promotedTreeDigest,
      revision: newRevision,
      workerId: req.workerId,
      leaseId: req.leaseId,
      missionContractHash: req.activeMissionContractHash,
      verificationId: req.verificationResult!.verificationId,
      timestamp: now,
      provenanceHash,
    };

    // 1. Transition branch status to VERIFIED if it wasn't already
    if (targetBranch.status !== "VERIFIED") {
      this.store.transitionBranch(targetBranch.branchId, "VERIFIED", {
        reason: "PROMOTION_GATE_VERIFIED",
        timestamp: now,
      });
    }

    // 2. Commit authoritative state atomically
    this.authoritativeTreeDigest = promotedTreeDigest;
    this.authoritativeRevision = newRevision;
    this.promotionHistory.push(record);
    this.promotedBranches.set(targetBranch.branchId, record);

    const decision: PromotionDecision = {
      status: "PROMOTED",
      branchId: targetBranch.branchId,
      checksFailed: Object.freeze([]),
      promotedTreeDigest,
      promotionRecord: record,
      timestamp: now,
    };

    if (req.idempotencyToken) {
      this.idempotencyCache.set(req.idempotencyToken, decision);
    }

    return decision;
  }
}
