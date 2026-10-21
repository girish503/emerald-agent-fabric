/**
 * Phase 91: Resource Negotiation Policy and Security Governance
 *
 * Enforces negative security controls N451–N480 and Authority Invariants R1–R18.
 *
 * CRITICAL INVARIANT:
 * Resources may be renegotiated within a fixed safety envelope.
 * Authority may NEVER be renegotiated upward.
 */

import { AgentResourceContract } from "../domain/agent-resource-contract.js";
import {
  ResourceAllocation,
  computeAllocationDigest,
  isWithinCeiling,
  validateResourceAllocation,
} from "../domain/resource-allocation.js";
import {
  RenegotiationDecision,
  RenegotiationRequest,
} from "../domain/resource-renegotiation.js";
import {
  HierarchicalCeilings,
  calculateEffectiveResourceLimit,
} from "./dynamic-resource-contract.js";
import {
  NegotiationProvenanceAuditLog,
  verifyProvenanceIntegrity,
} from "./resource-negotiation-provenance.js";

export interface SecurityControlEvaluation {
  readonly controlId: string;
  readonly description: string;
  readonly passed: boolean;
  readonly failClosed: boolean;
  readonly error?: string;
}

export class ResourceNegotiationPolicy {
  /**
   * N451: Agent self-granted resources check.
   */
  public static checkN451AgentSelfGranted(request: RenegotiationRequest): SecurityControlEvaluation {
    const hasSelfGrant = (request as unknown as Record<string, unknown>).grantImmediate === true;
    return {
      controlId: "N451",
      description: "Agent self-granted resources",
      passed: !hasSelfGrant,
      failClosed: true,
      error: hasSelfGrant ? "Agent attempted to self-grant resources immediately" : undefined,
    };
  }

  /**
   * N452: Agent self-authorized renegotiation check.
   */
  public static checkN452AgentSelfAuthorized(request: RenegotiationRequest): SecurityControlEvaluation {
    const reqAny = request as unknown as Record<string, unknown>;
    const selfAuth =
      reqAny.authoritative === true ||
      reqAny.policyAuthority === true ||
      reqAny.terminalAuthority === true;
    return {
      controlId: "N452",
      description: "Agent self-authorized renegotiation",
      passed: !selfAuth,
      failClosed: true,
      error: selfAuth ? "Agent request carries self-authorized flags" : undefined,
    };
  }

  /**
   * N453: Mission contract mutation check.
   */
  public static checkN453MissionContractMutation(
    origId: string,
    proposedId: string
  ): SecurityControlEvaluation {
    const mutated = origId !== proposedId;
    return {
      controlId: "N453",
      description: "Mission contract mutation",
      passed: !mutated,
      failClosed: true,
      error: mutated ? `Attempted mutation of mission contract ID from ${origId} to ${proposedId}` : undefined,
    };
  }

  /**
   * N454: Mission contract hash substitution check.
   */
  public static checkN454MissionContractHashSubstitution(
    origHash: string,
    proposedHash: string
  ): SecurityControlEvaluation {
    const substituted = origHash !== proposedHash;
    return {
      controlId: "N454",
      description: "Mission contract hash substitution",
      passed: !substituted,
      failClosed: true,
      error: substituted ? "Attempted substitution of mission contract hash" : undefined,
    };
  }

  /**
   * N455: Capability escalation check.
   */
  public static checkN455CapabilityEscalation(
    origCaps: readonly string[],
    proposedCaps: readonly string[]
  ): SecurityControlEvaluation {
    const origSet = new Set(origCaps);
    const escalated = proposedCaps.some((c) => !origSet.has(c));
    return {
      controlId: "N455",
      description: "Capability escalation through renegotiation",
      passed: !escalated,
      failClosed: true,
      error: escalated ? "Attempted capability escalation in authority envelope" : undefined,
    };
  }

  /**
   * N456: Repository scope escalation check.
   */
  public static checkN456RepositoryScopeEscalation(
    origRepos: readonly string[],
    proposedRepos: readonly string[]
  ): SecurityControlEvaluation {
    const origSet = new Set(origRepos);
    const escalated = proposedRepos.some((r) => !origSet.has(r));
    return {
      controlId: "N456",
      description: "Repository scope escalation",
      passed: !escalated,
      failClosed: true,
      error: escalated ? "Attempted repository scope expansion" : undefined,
    };
  }

  /**
   * N457: Workspace scope escalation check.
   */
  public static checkN457WorkspaceScopeEscalation(
    origWorkspace: string,
    proposedWorkspace: string
  ): SecurityControlEvaluation {
    const escalated = origWorkspace !== proposedWorkspace;
    return {
      controlId: "N457",
      description: "Workspace scope escalation",
      passed: !escalated,
      failClosed: true,
      error: escalated ? "Attempted workspace scope mutation" : undefined,
    };
  }

  /**
   * N458: Credential scope escalation check.
   */
  public static checkN458CredentialScopeEscalation(
    origCreds: readonly string[],
    proposedCreds: readonly string[]
  ): SecurityControlEvaluation {
    const origSet = new Set(origCreds);
    const escalated = proposedCreds.some((c) => !origSet.has(c));
    return {
      controlId: "N458",
      description: "Credential scope escalation",
      passed: !escalated,
      failClosed: true,
      error: escalated ? "Attempted credential scope expansion" : undefined,
    };
  }

  /**
   * N459: Terminal authority escalation check.
   */
  public static checkN459TerminalAuthorityEscalation(
    contract: AgentResourceContract
  ): SecurityControlEvaluation {
    const contractAny = contract as unknown as Record<string, unknown>;
    const escalated = contractAny.terminalAuthority === true;
    return {
      controlId: "N459",
      description: "Terminal authority escalation",
      passed: !escalated,
      failClosed: true,
      error: escalated ? "Contract possesses terminal execution authority" : undefined,
    };
  }

  /**
   * N460: Verification authority escalation check.
   */
  public static checkN460VerificationAuthorityEscalation(
    contract: AgentResourceContract
  ): SecurityControlEvaluation {
    const contractAny = contract as unknown as Record<string, unknown>;
    const escalated = contractAny.verificationAuthority === true;
    return {
      controlId: "N460",
      description: "Verification authority escalation",
      passed: !escalated,
      failClosed: true,
      error: escalated ? "Contract possesses verification authority" : undefined,
    };
  }

  /**
   * N461: Policy authority escalation check.
   */
  public static checkN461PolicyAuthorityEscalation(
    contract: AgentResourceContract
  ): SecurityControlEvaluation {
    const contractAny = contract as unknown as Record<string, unknown>;
    const escalated = contractAny.policyAuthority === true;
    return {
      controlId: "N461",
      description: "Policy authority escalation",
      passed: !escalated,
      failClosed: true,
      error: escalated ? "Contract possesses policy approval authority" : undefined,
    };
  }

  /**
   * N462: Shared pool ceiling bypass check.
   */
  public static checkN462SharedPoolCeilingBypass(
    poolAllocated: ResourceAllocation,
    poolCeiling: ResourceAllocation
  ): SecurityControlEvaluation {
    const bypass = !isWithinCeiling(poolAllocated, poolCeiling);
    return {
      controlId: "N462",
      description: "Shared-pool ceiling bypass",
      passed: !bypass,
      failClosed: true,
      error: bypass ? "Pool allocated resources exceed hard ceiling" : undefined,
    };
  }

  /**
   * N463: Agent allocation ceiling bypass check.
   */
  public static checkN463AgentCeilingBypass(
    allocation: ResourceAllocation,
    agentCeiling: ResourceAllocation
  ): SecurityControlEvaluation {
    const bypass = !isWithinCeiling(allocation, agentCeiling);
    return {
      controlId: "N463",
      description: "Agent allocation ceiling bypass",
      passed: !bypass,
      failClosed: true,
      error: bypass ? "Agent allocation exceeds agent ceiling" : undefined,
    };
  }

  /**
   * N464: Effective limit bypass check.
   */
  public static checkN464EffectiveLimitBypass(
    allocation: ResourceAllocation,
    ceilings: HierarchicalCeilings
  ): SecurityControlEvaluation {
    const effectiveLimit = calculateEffectiveResourceLimit(ceilings);
    const bypass = !isWithinCeiling(allocation, effectiveLimit);
    return {
      controlId: "N464",
      description: "Effective-limit bypass",
      passed: !bypass,
      failClosed: true,
      error: bypass ? "Allocation exceeds hierarchical effective limit" : undefined,
    };
  }

  /**
   * N465: Stale allocation acceptance check.
   */
  public static checkN465StaleAllocation(
    currentVersion: number,
    requestVersion: number
  ): SecurityControlEvaluation {
    const isStale = currentVersion !== requestVersion;
    return {
      controlId: "N465",
      description: "Stale allocation acceptance",
      passed: !isStale,
      failClosed: true,
      error: isStale ? `Stale allocation version: current ${currentVersion}, request ${requestVersion}` : undefined,
    };
  }

  /**
   * N466: Allocation version rollback check.
   */
  public static checkN466AllocationVersionRollback(
    oldVersion: number,
    newVersion: number
  ): SecurityControlEvaluation {
    const rollback = newVersion <= oldVersion;
    return {
      controlId: "N466",
      description: "Allocation version rollback",
      passed: !rollback,
      failClosed: true,
      error: rollback ? `Version non-monotonic: old ${oldVersion}, new ${newVersion}` : undefined,
    };
  }

  /**
   * N467: Allocation digest substitution check.
   */
  public static checkN467AllocationDigestSubstitution(
    allocation: ResourceAllocation,
    version: number,
    declaredDigest: string
  ): SecurityControlEvaluation {
    const expected = computeAllocationDigest(allocation, version);
    const substituted = expected !== declaredDigest;
    return {
      controlId: "N467",
      description: "Allocation digest substitution",
      passed: !substituted,
      failClosed: true,
      error: substituted ? `Digest mismatch: expected ${expected}, declared ${declaredDigest}` : undefined,
    };
  }

  /**
   * N468: Duplicate resource transfer check.
   */
  public static checkN468DuplicateResourceTransfer(
    transferId: string,
    existingTransfers: ReadonlySet<string>
  ): SecurityControlEvaluation {
    const duplicate = existingTransfers.has(transferId);
    return {
      controlId: "N468",
      description: "Duplicate resource transfer",
      passed: !duplicate,
      failClosed: true,
      error: duplicate ? `Duplicate transfer ID '${transferId}' detected` : undefined,
    };
  }

  /**
   * N469: Resource double-spend check.
   */
  public static checkN469ResourceDoubleSpend(
    remaining: ResourceAllocation,
    spendDelta: Partial<ResourceAllocation>
  ): SecurityControlEvaluation {
    const sub = validateResourceAllocation({
      wallTimeMs: remaining.wallTimeMs - (spendDelta.wallTimeMs ?? 0),
      toolCalls: remaining.toolCalls - (spendDelta.toolCalls ?? 0),
      modelCalls: remaining.modelCalls - (spendDelta.modelCalls ?? 0),
      contextBytes: remaining.contextBytes - (spendDelta.contextBytes ?? 0),
      outputBytes: remaining.outputBytes - (spendDelta.outputBytes ?? 0),
      candidateCount: remaining.candidateCount - (spendDelta.candidateCount ?? 0),
      verificationCalls: remaining.verificationCalls - (spendDelta.verificationCalls ?? 0),
      retryCount: remaining.retryCount - (spendDelta.retryCount ?? 0),
    });
    return {
      controlId: "N469",
      description: "Resource double-spend",
      passed: sub.valid,
      failClosed: true,
      error: !sub.valid ? "Double spend: consumption exceeds remaining budget" : undefined,
    };
  }

  /**
   * N470: Negative resource accounting check.
   */
  public static checkN470NegativeResourceAccounting(
    allocation: ResourceAllocation
  ): SecurityControlEvaluation {
    const validation = validateResourceAllocation(allocation);
    return {
      controlId: "N470",
      description: "Negative resource accounting",
      passed: validation.valid,
      failClosed: true,
      error: !validation.valid ? validation.errors.join("; ") : undefined,
    };
  }

  /**
   * N471: Resource creation check.
   * Total allocated + available must equal pool total capacity.
   */
  public static checkN471ResourceCreation(
    total: ResourceAllocation,
    allocated: ResourceAllocation,
    available: ResourceAllocation
  ): SecurityControlEvaluation {
    const created =
      allocated.wallTimeMs + available.wallTimeMs !== total.wallTimeMs ||
      allocated.toolCalls + available.toolCalls !== total.toolCalls ||
      allocated.modelCalls + available.modelCalls !== total.modelCalls;
    return {
      controlId: "N471",
      description: "Resource creation",
      passed: !created,
      failClosed: true,
      error: created ? "Accounting mismatch: sum of allocated and available does not equal total" : undefined,
    };
  }

  /**
   * N472: Resource return inflation check.
   */
  public static checkN472ResourceReturnInflation(
    allocated: ResourceAllocation,
    returnDelta: Partial<ResourceAllocation>
  ): SecurityControlEvaluation {
    const inflated =
      (returnDelta.wallTimeMs ?? 0) > allocated.wallTimeMs ||
      (returnDelta.toolCalls ?? 0) > allocated.toolCalls ||
      (returnDelta.modelCalls ?? 0) > allocated.modelCalls;
    return {
      controlId: "N472",
      description: "Resource return inflation",
      passed: !inflated,
      failClosed: true,
      error: inflated ? "Attempted to return more resources than allocated" : undefined,
    };
  }

  /**
   * N473: Fairness bypass check.
   */
  public static checkN473FairnessBypass(
    agentShare: number,
    fairnessCeiling = 0.8
  ): SecurityControlEvaluation {
    const bypass = agentShare > fairnessCeiling;
    return {
      controlId: "N473",
      description: "Fairness bypass",
      passed: !bypass,
      failClosed: true,
      error: bypass ? `Agent monopolizing resources: share ${agentShare} > ceiling ${fairnessCeiling}` : undefined,
    };
  }

  /**
   * N474: Starvation manipulation check.
   */
  public static checkN474StarvationManipulation(
    consecutiveDenials: number,
    starvationThreshold = 10
  ): SecurityControlEvaluation {
    const manipulated = consecutiveDenials > starvationThreshold;
    return {
      controlId: "N474",
      description: "Starvation manipulation",
      passed: !manipulated,
      failClosed: true,
      error: manipulated ? `Excessive consecutive starvation denials: ${consecutiveDenials}` : undefined,
    };
  }

  /**
   * N475: Priority injection check.
   * Priority must not exceed 10 or confer authority.
   */
  public static checkN475PriorityInjection(
    declaredPriority: number,
    maxPriority = 10
  ): SecurityControlEvaluation {
    const injected = declaredPriority > maxPriority || declaredPriority < 1;
    return {
      controlId: "N475",
      description: "Priority injection",
      passed: !injected,
      failClosed: true,
      error: injected ? `Invalid priority ${declaredPriority}: must be between 1 and ${maxPriority}` : undefined,
    };
  }

  /**
   * N476: Renegotiation recursion check.
   */
  public static checkN476RenegotiationRecursion(
    depth: number,
    maxDepth = 4
  ): SecurityControlEvaluation {
    const recursive = depth > maxDepth;
    return {
      controlId: "N476",
      description: "Renegotiation recursion",
      passed: !recursive,
      failClosed: true,
      error: recursive ? `Renegotiation recursion depth ${depth} exceeds maximum ${maxDepth}` : undefined,
    };
  }

  /**
   * N477: Cross-agent contract contamination check.
   */
  public static checkN477CrossAgentContamination(
    contractAgentId: string,
    requestAgentId: string
  ): SecurityControlEvaluation {
    const contaminated = contractAgentId !== requestAgentId;
    return {
      controlId: "N477",
      description: "Cross-agent contract contamination",
      passed: !contaminated,
      failClosed: true,
      error: contaminated ? `cross-agent contract contamination: Agent ${requestAgentId} attempted to renegotiate contract belonging to ${contractAgentId}` : undefined,
    };
  }

  /**
   * N478: Provenance removal check.
   */
  public static checkN478ProvenanceRemoval(
    auditLog: NegotiationProvenanceAuditLog
  ): SecurityControlEvaluation {
    const verification = verifyProvenanceIntegrity(auditLog);
    return {
      controlId: "N478",
      description: "Provenance removal",
      passed: verification.valid,
      failClosed: true,
      error: !verification.valid ? verification.errors.join("; ") : undefined,
    };
  }

  /**
   * N479: Oracle/reference leakage check.
   */
  public static checkN479OracleLeakage(
    requestReason: string
  ): SecurityControlEvaluation {
    const leakPattern = /test_solution|oracle_result|ground_truth_patch/i;
    const leaked = leakPattern.test(requestReason);
    return {
      controlId: "N479",
      description: "Oracle/reference leakage",
      passed: !leaked,
      failClosed: true,
      error: leaked ? "Reference oracle leaked in renegotiation reason" : undefined,
    };
  }

  /**
   * N480: Terminal authority escalation check (duplicate fail-safe).
   */
  public static checkN480TerminalAuthorityEscalation(
    decision: RenegotiationDecision
  ): SecurityControlEvaluation {
    const decisionAny = decision as unknown as Record<string, unknown>;
    const terminalGranted = decisionAny.terminalAuthority === true || decisionAny.grantMissionSuccess === true;
    return {
      controlId: "N480",
      description: "Terminal authority escalation",
      passed: !terminalGranted,
      failClosed: true,
      error: terminalGranted ? "Decision granted terminal mission completion" : undefined,
    };
  }
}
