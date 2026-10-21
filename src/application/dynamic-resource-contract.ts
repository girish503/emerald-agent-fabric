/**
 * Phase 91: Dynamic Resource Contract Application Service
 *
 * Implements governed contract adjustments, effective resource ceiling calculation,
 * and strict enforcement of the immutable authority envelope.
 *
 * CRITICAL INVARIANTS:
 * 1. Resources may be renegotiated within a fixed safety envelope.
 * 2. Authority may NEVER be renegotiated upward.
 * 3. AllocationChange !== MissionContractChange.
 * 4. EffectiveLimit = min(Mission, Workflow, Pool, Goal, Agent, Provider).
 */

import { AgentResourceContract } from "../domain/agent-resource-contract.js";
import {
  ImmutableAuthorityEnvelope,
  ResourceAllocation,
  addAllocations,
  computeAllocationDigest,
  isWithinCeiling,
  validateResourceAllocation,
} from "../domain/resource-allocation.js";

export interface HierarchicalCeilings {
  readonly missionCeiling: ResourceAllocation;
  readonly workflowCeiling?: ResourceAllocation;
  readonly poolCeiling: ResourceAllocation;
  readonly goalCeiling?: ResourceAllocation;
  readonly agentCeiling: ResourceAllocation;
  readonly providerCeiling?: ResourceAllocation;
}

/**
 * Calculates EffectiveResourceLimit:
 * EffectiveLimit = min(Mission, Workflow, Pool, Goal, Agent, Provider)
 */
export function calculateEffectiveResourceLimit(
  ceilings: HierarchicalCeilings
): ResourceAllocation {
  const allCeilings: ResourceAllocation[] = [
    ceilings.missionCeiling,
    ceilings.poolCeiling,
    ceilings.agentCeiling,
  ];

  if (ceilings.workflowCeiling) allCeilings.push(ceilings.workflowCeiling);
  if (ceilings.goalCeiling) allCeilings.push(ceilings.goalCeiling);
  if (ceilings.providerCeiling) allCeilings.push(ceilings.providerCeiling);

  return {
    wallTimeMs: Math.min(...allCeilings.map((c) => c.wallTimeMs)),
    toolCalls: Math.min(...allCeilings.map((c) => c.toolCalls)),
    modelCalls: Math.min(...allCeilings.map((c) => c.modelCalls)),
    contextBytes: Math.min(...allCeilings.map((c) => c.contextBytes)),
    outputBytes: Math.min(...allCeilings.map((c) => c.outputBytes)),
    candidateCount: Math.min(...allCeilings.map((c) => c.candidateCount)),
    verificationCalls: Math.min(...allCeilings.map((c) => c.verificationCalls)),
    retryCount: Math.min(...allCeilings.map((c) => c.retryCount)),
  };
}

/**
 * Validates that an attempted contract update does NOT touch or mutate
 * the immutable authority envelope or mission contract metadata.
 */
export function validateImmutableEnvelopeIntegrity(
  originalEnvelope: ImmutableAuthorityEnvelope,
  proposedEnvelope: ImmutableAuthorityEnvelope,
  originalMissionHash: string,
  proposedMissionHash: string
): {
  readonly valid: boolean;
  readonly violations: readonly string[];
} {
  const violations: string[] = [];

  // Check mission contract hash
  if (originalMissionHash !== proposedMissionHash) {
    violations.push("Attempted mutation of missionContractHash");
  }

  // Check mission contract ID and version
  if (originalEnvelope.missionContractId !== proposedEnvelope.missionContractId) {
    violations.push("Attempted mutation of missionContractId");
  }
  if (
    originalEnvelope.missionContractVersion !== proposedEnvelope.missionContractVersion
  ) {
    violations.push("Attempted mutation of missionContractVersion");
  }

  // Check capability set
  const origCaps = new Set(originalEnvelope.capabilitySet);
  for (const cap of proposedEnvelope.capabilitySet) {
    if (!origCaps.has(cap)) {
      violations.push(`Attempted capability escalation: added capability '${cap}'`);
    }
  }

  // Check repository scope
  const origRepos = new Set(originalEnvelope.repositoryScope);
  for (const repo of proposedEnvelope.repositoryScope) {
    if (!origRepos.has(repo)) {
      violations.push(`Attempted repository scope escalation: added repo '${repo}'`);
    }
  }

  // Check workspace scope
  if (originalEnvelope.workspaceScope !== proposedEnvelope.workspaceScope) {
    violations.push("Attempted workspace scope escalation or mutation");
  }

  // Check credential scope
  const origCreds = new Set(originalEnvelope.credentialScope);
  for (const cred of proposedEnvelope.credentialScope) {
    if (!origCreds.has(cred)) {
      violations.push(`Attempted credential scope escalation: added credential '${cred}'`);
    }
  }

  // Check provider isolation policy
  if (
    originalEnvelope.providerIsolationPolicy !==
    proposedEnvelope.providerIsolationPolicy
  ) {
    violations.push("Attempted provider isolation policy mutation");
  }

  // Check authority flags (MUST all be false)
  const propRecord = proposedEnvelope as unknown as Record<string, unknown>;
  if (propRecord.verificationAuthority === true) {
    violations.push("Attempted verification authority escalation");
  }
  if (propRecord.terminalAuthority === true) {
    violations.push("Attempted terminal authority escalation");
  }
  if (propRecord.policyAuthority === true) {
    violations.push("Attempted policy authority escalation");
  }
  if (propRecord.evidenceSigningAuthority === true) {
    violations.push("Attempted evidence signing authority escalation");
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * Applies an approved resource delta to an AgentResourceContract.
 * Enforces version increment, digest recomputation, and ceiling checks.
 */
export function applyContractAllocationUpdate(
  contract: AgentResourceContract,
  delta: Partial<ResourceAllocation>,
  effectiveLimit: ResourceAllocation
): {
  readonly success: boolean;
  readonly updatedContract?: AgentResourceContract;
  readonly error?: string;
} {
  const updatedAllocation = addAllocations(contract.resourceAllocation, delta);
  const validation = validateResourceAllocation(updatedAllocation);
  if (!validation.valid) {
    return {
      success: false,
      error: `Invalid resulting allocation: ${validation.errors.join("; ")}`,
    };
  }

  if (!isWithinCeiling(updatedAllocation, effectiveLimit)) {
    return {
      success: false,
      error: "Updated allocation exceeds effective resource limit",
    };
  }

  const newAllocationVersion = contract.allocationVersion + 1;
  const newAllocationDigest = computeAllocationDigest(
    updatedAllocation,
    newAllocationVersion
  );
  const newRemainingBudget = addAllocations(contract.remainingBudget, delta);
  const now = new Date().toISOString();

  const updatedContract: AgentResourceContract = {
    ...contract,
    resourceAllocation: updatedAllocation,
    allocationVersion: newAllocationVersion,
    allocationDigest: newAllocationDigest,
    remainingBudget: newRemainingBudget,
    status: "RENEGOTIATED",
    updatedAt: now,
  };

  return {
    success: true,
    updatedContract,
  };
}
