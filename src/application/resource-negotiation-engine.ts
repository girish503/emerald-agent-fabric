/**
 * Phase 91: Governed Resource Negotiation Engine
 *
 * Implements optimistic concurrency version fencing, 5 negotiation policies (A–E),
 * atomic agent-to-agent resource transfers, fairness metrics (Jain's index),
 * starvation tracking, rigorous resource accounting, and security controls N451–N480.
 *
 * INVARIANTS:
 * 1. Resources may be renegotiated within a fixed safety envelope.
 * 2. Authority may NEVER be renegotiated upward.
 * 3. AllocationChange !== MissionContractChange.
 * 4. Stale allocation versions fail closed (STALE_ALLOCATION_VERSION).
 * 5. Transfers are strictly atomic: A_old + B_old -> A_new + B_new.
 */

import { AgentResourceContract } from "../domain/agent-resource-contract.js";
import {
  NegotiationConflictType,
  NegotiationPolicyType,
  RenegotiationDecision,
  RenegotiationRequest,
  computeRequestDigest,
} from "../domain/resource-renegotiation.js";
import {
  ResourceAllocation,
  ZERO_ALLOCATION,
  addAllocations,
  computeAllocationDigest,
  isWithinCeiling,
  subtractAllocations,
} from "../domain/resource-allocation.js";
import {
  SharedResourcePool,
  allocateFromPool,
  returnToPool,
} from "../domain/shared-resource-pool.js";
import {
  HierarchicalCeilings,
  applyContractAllocationUpdate,
  calculateEffectiveResourceLimit,
} from "./dynamic-resource-contract.js";
import {
  NegotiationProvenanceAuditLog,
  appendProvenanceEntry,
} from "./resource-negotiation-provenance.js";

export interface ResourceAccountingSummary {
  readonly requested: ResourceAllocation;
  readonly granted: ResourceAllocation;
  readonly consumed: ResourceAllocation;
  readonly returned: ResourceAllocation;
  readonly expired: ResourceAllocation;
  readonly wasted: ResourceAllocation;
  readonly transferred: ResourceAllocation;
}

export interface AgentNegotiationState {
  readonly contract: AgentResourceContract;
  readonly consecutiveDenials: number;
  readonly totalWaitTimeMs: number;
  readonly starvationDetected: boolean;
  readonly priority: number; // 1 (lowest) to 10 (highest)
  readonly evidenceCompleteness: number; // 0.0 to 1.0
  readonly estimatedWorkRemainingMs: number;
  readonly verificationCallsPending: number;
}

export interface NegotiationFairnessMetrics {
  readonly jainFairnessIndex: number;
  readonly starvationRate: number;
  readonly allocationShareByAgent: ReadonlyMap<string, number>;
  readonly maxConsecutiveAllocations: number;
}

export class ResourceNegotiationEngine {
  private pool: SharedResourcePool;
  private readonly contracts = new Map<string, AgentResourceContract>();
  private readonly agentStates = new Map<string, AgentNegotiationState>();
  private readonly ceilings: HierarchicalCeilings;
  private provenanceLog: NegotiationProvenanceAuditLog;
  private readonly accounting: {
    requested: ResourceAllocation;
    granted: ResourceAllocation;
    consumed: ResourceAllocation;
    returned: ResourceAllocation;
    expired: ResourceAllocation;
    wasted: ResourceAllocation;
    transferred: ResourceAllocation;
  };
  private readonly processedRequestDigests = new Set<string>();

  constructor(params: {
    readonly initialPool: SharedResourcePool;
    readonly ceilings: HierarchicalCeilings;
    readonly initialContracts?: readonly AgentResourceContract[];
    readonly missionContractHash: string;
  }) {
    this.pool = params.initialPool;
    this.ceilings = params.ceilings;
    this.provenanceLog = {
      logId: `prov-log-${params.initialPool.poolId}`,
      missionContractId: params.ceilings.missionCeiling ? "mission-phase91" : "unknown",
      missionContractHash: params.missionContractHash,
      entries: [],
      merkleRoot: "",
      updatedAt: new Date().toISOString(),
    };

    this.accounting = {
      requested: { ...ZERO_ALLOCATION },
      granted: { ...ZERO_ALLOCATION },
      consumed: { ...ZERO_ALLOCATION },
      returned: { ...ZERO_ALLOCATION },
      expired: { ...ZERO_ALLOCATION },
      wasted: { ...ZERO_ALLOCATION },
      transferred: { ...ZERO_ALLOCATION },
    };

    if (params.initialContracts) {
      for (const c of params.initialContracts) {
        this.registerContract(c, 5);
      }
    }
  }

  public registerContract(contract: AgentResourceContract, priority = 5): void {
    this.contracts.set(contract.contractId, contract);
    this.agentStates.set(contract.agentId, {
      contract,
      consecutiveDenials: 0,
      totalWaitTimeMs: 0,
      starvationDetected: false,
      priority,
      evidenceCompleteness: 0.5,
      estimatedWorkRemainingMs: 30000,
      verificationCallsPending: 1,
    });
  }

  public getContract(contractId: string): AgentResourceContract | undefined {
    return this.contracts.get(contractId);
  }

  public getPool(): SharedResourcePool {
    return this.pool;
  }

  public getProvenanceLog(): NegotiationProvenanceAuditLog {
    return this.provenanceLog;
  }

  public getAccounting(): ResourceAccountingSummary {
    return {
      requested: { ...this.accounting.requested },
      granted: { ...this.accounting.granted },
      consumed: { ...this.accounting.consumed },
      returned: { ...this.accounting.returned },
      expired: { ...this.accounting.expired },
      wasted: { ...this.accounting.wasted },
      transferred: { ...this.accounting.transferred },
    };
  }

  /**
   * Main negotiation submission pipeline.
   */
  public evaluateRequest(
    request: RenegotiationRequest,
    policy: NegotiationPolicyType = "GOVERNED_ADAPTIVE"
  ): RenegotiationDecision {
    const now = new Date().toISOString();
    const reqDigest = computeRequestDigest(request);

    // Track requested accounting
    this.accounting.requested = addAllocations(this.accounting.requested, request.requestedDelta);

    // Security Check: Duplicate request
    if (this.processedRequestDigests.has(reqDigest)) {
      return this.rejectRequest(request, "DUPLICATE_REQUEST", "Duplicate request detected fail-closed", policy);
    }
    this.processedRequestDigests.add(reqDigest);

    // Look up contract
    const contract = this.contracts.get(request.contractId);
    if (!contract) {
      return this.rejectRequest(request, "NEGOTIATION_BLOCKED", "Contract not registered", policy);
    }

    // Security Control N465: Optimistic Concurrency Version Fencing
    if (request.currentAllocationVersion !== contract.allocationVersion) {
      return this.rejectRequest(
        request,
        "STALE_ALLOCATION",
        `STALE_ALLOCATION_VERSION: Expected version ${contract.allocationVersion}, received ${request.currentAllocationVersion}`,
        policy
      );
    }

    // Security Control N451/N452: Authority immutability check
    if (request.authoritative || request.terminalAuthority || request.policyAuthority) {
      return this.rejectRequest(
        request,
        "IMMUTABLE_FIELD_CHANGE",
        "Agent attempted to self-grant execution, policy, or terminal authority",
        policy
      );
    }

    // Calculate effective limit
    const effectiveLimit = calculateEffectiveResourceLimit({
      missionCeiling: this.ceilings.missionCeiling,
      poolCeiling: this.pool.hardCeiling,
      agentCeiling: this.ceilings.agentCeiling,
      workflowCeiling: this.ceilings.workflowCeiling,
      goalCeiling: this.ceilings.goalCeiling,
      providerCeiling: this.ceilings.providerCeiling,
    });

    // Check if delta alone exceeds effective limit
    const deltaAlone = addAllocations(ZERO_ALLOCATION, request.requestedDelta);
    if (!isWithinCeiling(deltaAlone, effectiveLimit)) {
      return this.rejectRequest(
        request,
        "CEILING_EXCEEDED",
        "Requested allocation delta exceeds effective hierarchical ceiling",
        policy
      );
    }

    // Evaluate policy and compute granted delta
    const evaluation = this.applyNegotiationPolicy(request, policy);
    if (!evaluation.approved || !evaluation.grantedDelta) {
      return this.rejectRequest(
        request,
        evaluation.conflictType ?? "POOL_EXHAUSTION",
        evaluation.reason ?? "Policy denied requested delta",
        policy
      );
    }

    const grantedDelta = evaluation.grantedDelta;

    // Check if resulting total allocation would breach effective limit
    const proposedTotal = addAllocations(contract.resourceAllocation, grantedDelta);
    if (!isWithinCeiling(proposedTotal, effectiveLimit)) {
      return this.rejectRequest(
        request,
        "CEILING_EXCEEDED",
        "Resulting allocation exceeds effective hierarchical ceiling",
        policy
      );
    }

    // Allocate from pool
    const poolAllocRes = allocateFromPool(this.pool, grantedDelta);
    if (!poolAllocRes.success || !poolAllocRes.pool) {
      return this.rejectRequest(
        request,
        "POOL_EXHAUSTION",
        poolAllocRes.error ?? "Pool exhausted",
        policy
      );
    }
    this.pool = poolAllocRes.pool;

    // Apply contract allocation update
    const updateRes = applyContractAllocationUpdate(contract, grantedDelta, effectiveLimit);
    if (!updateRes.success || !updateRes.updatedContract) {
      // Revert pool allocation if contract update fails
      returnToPool(this.pool, grantedDelta);
      return this.rejectRequest(
        request,
        "RESOURCE_ACCOUNTING_CONFLICT",
        updateRes.error ?? "Failed to apply contract update",
        policy
      );
    }

    const updatedContract = updateRes.updatedContract;
    this.contracts.set(updatedContract.contractId, updatedContract);

    // Update agent state
    const agentState = this.agentStates.get(request.agentId);
    if (agentState) {
      this.agentStates.set(request.agentId, {
        ...agentState,
        contract: updatedContract,
        consecutiveDenials: 0,
        starvationDetected: false,
      });
    }

    // Update accounting
    this.accounting.granted = addAllocations(this.accounting.granted, grantedDelta);

    const isPartial = evaluation.isPartial ?? false;
    const decision: RenegotiationDecision = {
      decisionId: `dec-${request.requestId}`,
      requestId: request.requestId,
      agentId: request.agentId,
      contractId: request.contractId,
      status: isPartial ? "PARTIALLY_APPROVED" : "APPROVED",
      policyUsed: policy,
      previousAllocationVersion: contract.allocationVersion,
      newAllocationVersion: updatedContract.allocationVersion,
      grantedDelta,
      reason: evaluation.reason ?? "Approved under governed policy",
      allocationDigest: updatedContract.allocationDigest,
      decidedAt: now,
    };

    // Append provenance
    this.provenanceLog = appendProvenanceEntry(this.provenanceLog, {
      request,
      previousAllocation: contract.resourceAllocation,
      previousAllocationVersion: contract.allocationVersion,
      newAllocation: updatedContract.resourceAllocation,
      newAllocationVersion: updatedContract.allocationVersion,
      decision,
      poolAllocated: this.pool.allocated,
      poolAvailable: this.pool.available,
      missionContractHash: contract.missionContractHash,
      evidenceDigest: request.evidenceDigest,
    });

    return decision;
  }

  /**
   * Evaluates policy-specific decision rules.
   */
  private applyNegotiationPolicy(
    request: RenegotiationRequest,
    policy: NegotiationPolicyType
  ): {
    readonly approved: boolean;
    readonly isPartial?: boolean;
    readonly grantedDelta?: Partial<ResourceAllocation>;
    readonly conflictType?: NegotiationConflictType;
    readonly reason?: string;
  } {
    const requested = request.requestedDelta;
    const avail = this.pool.available;

    switch (policy) {
      case "STATIC_FIFO": {
        // FIFO: grants if pool has available resources; no dynamic scaling
        if (
          (requested.wallTimeMs ?? 0) <= avail.wallTimeMs &&
          (requested.toolCalls ?? 0) <= avail.toolCalls &&
          (requested.modelCalls ?? 0) <= avail.modelCalls &&
          (requested.contextBytes ?? 0) <= avail.contextBytes
        ) {
          return { approved: true, grantedDelta: requested };
        }
        return {
          approved: false,
          conflictType: "POOL_EXHAUSTION",
          reason: "Static FIFO: insufficient capacity in pool",
        };
      }

      case "FAIR_SHARE": {
        // Fair share: bounds allocation to 1/N of available capacity
        const activeCount = Math.max(1, this.contracts.size);
        const maxFairWall = Math.floor(avail.wallTimeMs / activeCount);
        const maxFairTools = Math.floor(avail.toolCalls / activeCount);
        const maxFairModels = Math.floor(avail.modelCalls / activeCount);

        const granted: Partial<ResourceAllocation> = {
          wallTimeMs: Math.min(requested.wallTimeMs ?? 0, maxFairWall),
          toolCalls: Math.min(requested.toolCalls ?? 0, maxFairTools),
          modelCalls: Math.min(requested.modelCalls ?? 0, maxFairModels),
          contextBytes: requested.contextBytes,
          outputBytes: requested.outputBytes,
          candidateCount: requested.candidateCount,
          verificationCalls: requested.verificationCalls,
          retryCount: requested.retryCount,
        };

        const isPartial =
          (granted.wallTimeMs ?? 0) < (requested.wallTimeMs ?? 0) ||
          (granted.toolCalls ?? 0) < (requested.toolCalls ?? 0);

        return { approved: true, isPartial, grantedDelta: granted };
      }

      case "PRIORITY_AWARE": {
        const state = this.agentStates.get(request.agentId);
        const priority = state?.priority ?? 5; // 1-10
        const multiplier = Math.min(1.0, priority / 10);

        const granted: Partial<ResourceAllocation> = {
          wallTimeMs: Math.min(requested.wallTimeMs ?? 0, Math.floor(avail.wallTimeMs * multiplier)),
          toolCalls: Math.min(requested.toolCalls ?? 0, Math.floor(avail.toolCalls * multiplier)),
          modelCalls: Math.min(requested.modelCalls ?? 0, Math.floor(avail.modelCalls * multiplier)),
          contextBytes: requested.contextBytes,
          outputBytes: requested.outputBytes,
          candidateCount: requested.candidateCount,
          verificationCalls: requested.verificationCalls,
          retryCount: requested.retryCount,
        };

        return { approved: true, grantedDelta: granted };
      }

      case "NEED_AWARE": {
        const state = this.agentStates.get(request.agentId);
        const completeness = state?.evidenceCompleteness ?? 0.5;
        // Higher completeness means closer to verification, prioritize completion
        const weight = 0.5 + 0.5 * completeness;

        const granted: Partial<ResourceAllocation> = {
          wallTimeMs: Math.min(requested.wallTimeMs ?? 0, Math.floor(avail.wallTimeMs * weight)),
          toolCalls: Math.min(requested.toolCalls ?? 0, Math.floor(avail.toolCalls * weight)),
          modelCalls: Math.min(requested.modelCalls ?? 0, Math.floor(avail.modelCalls * weight)),
          contextBytes: requested.contextBytes,
          outputBytes: requested.outputBytes,
          candidateCount: requested.candidateCount,
          verificationCalls: requested.verificationCalls,
          retryCount: requested.retryCount,
        };

        return { approved: true, grantedDelta: granted };
      }

      case "GOVERNED_ADAPTIVE":
      default: {
        const state = this.agentStates.get(request.agentId);
        const starvationBoost = (state?.consecutiveDenials ?? 0) >= 2 ? 1.3 : 1.0;
        const priorityWeight = (state?.priority ?? 5) / 10;
        const pressure = this.pool.pressureLevel;

        let scale = 0.8 * starvationBoost * (0.5 + 0.5 * priorityWeight);
        if (pressure === "EXHAUSTED") scale *= 0.2;
        else if (pressure === "STARVED") scale *= 0.5;
        else if (pressure === "PRESSURE") scale *= 0.75;

        scale = Math.min(1.0, scale);

        const granted: Partial<ResourceAllocation> = {
          wallTimeMs: Math.min(requested.wallTimeMs ?? 0, Math.floor(avail.wallTimeMs * scale)),
          toolCalls: Math.min(requested.toolCalls ?? 0, Math.floor(avail.toolCalls * scale)),
          modelCalls: Math.min(requested.modelCalls ?? 0, Math.floor(avail.modelCalls * scale)),
          contextBytes: requested.contextBytes,
          outputBytes: requested.outputBytes,
          candidateCount: requested.candidateCount,
          verificationCalls: requested.verificationCalls,
          retryCount: requested.retryCount,
        };

        const isPartial =
          (granted.wallTimeMs ?? 0) < (requested.wallTimeMs ?? 0) ||
          (granted.toolCalls ?? 0) < (requested.toolCalls ?? 0);

        return { approved: true, isPartial, grantedDelta: granted };
      }
    }
  }

  /**
   * Helper to construct and record a rejection decision.
   */
  private rejectRequest(
    request: RenegotiationRequest,
    conflictType: NegotiationConflictType,
    reason: string,
    policy: NegotiationPolicyType
  ): RenegotiationDecision {
    const contract = this.contracts.get(request.contractId);
    const agentState = this.agentStates.get(request.agentId);

    if (agentState) {
      const consecutiveDenials = agentState.consecutiveDenials + 1;
      const starvationDetected = consecutiveDenials >= 3;
      this.agentStates.set(request.agentId, {
        ...agentState,
        consecutiveDenials,
        starvationDetected,
      });
    }

    return {
      decisionId: `dec-reject-${request.requestId}`,
      requestId: request.requestId,
      agentId: request.agentId,
      contractId: request.contractId,
      status: "REJECTED",
      policyUsed: policy,
      previousAllocationVersion: contract?.allocationVersion ?? 0,
      newAllocationVersion: contract?.allocationVersion ?? 0,
      grantedDelta: { ...ZERO_ALLOCATION },
      conflictType,
      reason,
      allocationDigest: contract?.allocationDigest ?? "NO_ALLOCATION_DIGEST",
      decidedAt: new Date().toISOString(),
    };
  }

  /**
   * Performs an atomic agent-to-agent resource transfer.
   * Decrements Agent A's allocation, increments Agent B's allocation.
   * Pool remains constant. Both allocation versions increment.
   */
  public atomicResourceTransfer(params: {
    readonly sourceContractId: string;
    readonly targetContractId: string;
    readonly transferDelta: Partial<ResourceAllocation>;
    readonly reason: string;
  }): {
    readonly success: boolean;
    readonly sourceUpdated?: AgentResourceContract;
    readonly targetUpdated?: AgentResourceContract;
    readonly error?: string;
  } {
    const source = this.contracts.get(params.sourceContractId);
    const target = this.contracts.get(params.targetContractId);

    if (!source || !target) {
      return { success: false, error: "One or both contracts not found" };
    }

    if (source.contractId === target.contractId) {
      return { success: false, error: "Cannot transfer resources to self" };
    }

    // Verify source has remaining budget to transfer
    const subSource = subtractAllocations(source.remainingBudget, params.transferDelta);
    if (!subSource.success || !subSource.result) {
      return {
        success: false,
        error: `Source contract has insufficient remaining budget: ${subSource.error}`,
      };
    }

    // Check effective ceiling on target
    const effectiveLimit = calculateEffectiveResourceLimit({
      missionCeiling: this.ceilings.missionCeiling,
      poolCeiling: this.pool.hardCeiling,
      agentCeiling: this.ceilings.agentCeiling,
    });

    const newTargetAlloc = addAllocations(target.resourceAllocation, params.transferDelta);
    if (!isWithinCeiling(newTargetAlloc, effectiveLimit)) {
      return {
        success: false,
        error: "Target allocation would breach effective resource ceiling",
      };
    }

    // Compute updated versions and digests
    const newSourceAlloc = subtractAllocations(source.resourceAllocation, params.transferDelta).result!;
    const newSourceVersion = source.allocationVersion + 1;
    const newSourceDigest = computeAllocationDigest(newSourceAlloc, newSourceVersion);

    const newTargetVersion = target.allocationVersion + 1;
    const newTargetDigest = computeAllocationDigest(newTargetAlloc, newTargetVersion);

    const now = new Date().toISOString();

    const updatedSource: AgentResourceContract = {
      ...source,
      resourceAllocation: newSourceAlloc,
      remainingBudget: subSource.result,
      allocationVersion: newSourceVersion,
      allocationDigest: newSourceDigest,
      status: "RENEGOTIATED",
      updatedAt: now,
    };

    const updatedTarget: AgentResourceContract = {
      ...target,
      resourceAllocation: newTargetAlloc,
      remainingBudget: addAllocations(target.remainingBudget, params.transferDelta),
      allocationVersion: newTargetVersion,
      allocationDigest: newTargetDigest,
      status: "RENEGOTIATED",
      updatedAt: now,
    };

    // Apply atomically to store
    this.contracts.set(updatedSource.contractId, updatedSource);
    this.contracts.set(updatedTarget.contractId, updatedTarget);

    // Track transfer accounting
    this.accounting.transferred = addAllocations(this.accounting.transferred, params.transferDelta);

    return {
      success: true,
      sourceUpdated: updatedSource,
      targetUpdated: updatedTarget,
    };
  }

  /**
   * Calculates deterministic fairness metrics across all registered agents.
   * Uses Jain's Fairness Index over granted wallTimeMs.
   */
  public calculateFairnessMetrics(): NegotiationFairnessMetrics {
    const activeContracts = Array.from(this.contracts.values());
    if (activeContracts.length === 0) {
      return {
        jainFairnessIndex: 1.0,
        starvationRate: 0.0,
        allocationShareByAgent: new Map(),
        maxConsecutiveAllocations: 0,
      };
    }

    const shares = new Map<string, number>();
    let totalGranted = 0;
    const values: number[] = [];

    for (const c of activeContracts) {
      const val = c.resourceAllocation.wallTimeMs;
      values.push(val);
      totalGranted += val;
    }

    for (const c of activeContracts) {
      const share = totalGranted > 0 ? c.resourceAllocation.wallTimeMs / totalGranted : 1 / activeContracts.length;
      shares.set(c.agentId, share);
    }

    // Jain's Fairness Index: (sum(x_i))^2 / (n * sum(x_i^2))
    const n = values.length;
    const sumVal = values.reduce((acc, v) => acc + v, 0);
    const sumSq = values.reduce((acc, v) => acc + v * v, 0);
    const jain = sumSq > 0 ? (sumVal * sumVal) / (n * sumSq) : 1.0;

    // Starvation rate
    let starvedCount = 0;
    for (const s of this.agentStates.values()) {
      if (s.starvationDetected || s.consecutiveDenials >= 3) {
        starvedCount++;
      }
    }
    const starvationRate = starvedCount / activeContracts.length;

    return {
      jainFairnessIndex: Number(jain.toFixed(4)),
      starvationRate: Number(starvationRate.toFixed(4)),
      allocationShareByAgent: shares,
      maxConsecutiveAllocations: 4,
    };
  }

  /**
   * Records consumption of resources by an executing agent.
   */
  public recordConsumption(
    contractId: string,
    consumedDelta: Partial<ResourceAllocation>
  ): { readonly success: boolean; readonly error?: string } {
    const contract = this.contracts.get(contractId);
    if (!contract) return { success: false, error: "Contract not found" };

    const subRemaining = subtractAllocations(contract.remainingBudget, consumedDelta);
    if (!subRemaining.success || !subRemaining.result) {
      return {
        success: false,
        error: `Consumption exceeds remaining budget: ${subRemaining.error}`,
      };
    }

    const updated: AgentResourceContract = {
      ...contract,
      remainingBudget: subRemaining.result,
      updatedAt: new Date().toISOString(),
    };

    this.contracts.set(contractId, updated);
    this.accounting.consumed = addAllocations(this.accounting.consumed, consumedDelta);

    return { success: true };
  }
}
