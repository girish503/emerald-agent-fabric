/**
 * Phase 91: Resource Allocation Domain Model
 *
 * Defines typed resource allocations, immutable authority envelopes,
 * and canonical digest computations for governed multi-agent negotiation.
 *
 * INVARIANTS:
 * 1. Resources may be renegotiated within a fixed safety envelope.
 * 2. Authority may NEVER be renegotiated upward.
 * 3. All allocation values must be non-negative integers.
 * 4. Mission contract hashes and identity remain strictly immutable.
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";

export interface ResourceAllocation {
  readonly wallTimeMs: number;
  readonly toolCalls: number;
  readonly modelCalls: number;
  readonly contextBytes: number;
  readonly outputBytes: number;
  readonly candidateCount: number;
  readonly verificationCalls: number;
  readonly retryCount: number;
}

export interface ResourceDimensionState {
  readonly requested: number;
  readonly granted: number;
  readonly consumed: number;
  readonly remaining: number;
  readonly ceiling: number;
  readonly allocationVersion: number;
}

export interface DetailedResourceAllocation {
  readonly wallTimeMs: ResourceDimensionState;
  readonly toolCalls: ResourceDimensionState;
  readonly modelCalls: ResourceDimensionState;
  readonly contextBytes: ResourceDimensionState;
  readonly outputBytes: ResourceDimensionState;
  readonly candidateCount: ResourceDimensionState;
  readonly verificationCalls: ResourceDimensionState;
  readonly retryCount: ResourceDimensionState;
}

export interface ImmutableAuthorityEnvelope {
  readonly missionContractId: string;
  readonly missionContractVersion: number;
  readonly missionContractHash: string;
  readonly capabilitySet: readonly string[];
  readonly repositoryScope: readonly string[];
  readonly workspaceScope: string;
  readonly credentialScope: readonly string[];
  readonly providerIsolationPolicy: string;
  readonly verificationAuthority: false;
  readonly terminalAuthority: false;
  readonly policyAuthority: false;
  readonly evidenceSigningAuthority: false;
}

export const ZERO_ALLOCATION: ResourceAllocation = Object.freeze({
  wallTimeMs: 0,
  toolCalls: 0,
  modelCalls: 0,
  contextBytes: 0,
  outputBytes: 0,
  candidateCount: 0,
  verificationCalls: 0,
  retryCount: 0,
});

export const DEFAULT_MISSION_RESOURCE_CEILINGS: ResourceAllocation = Object.freeze({
  wallTimeMs: 600_000, // 10 minutes
  toolCalls: 200,
  modelCalls: 100,
  contextBytes: 524_288, // 512 KB
  outputBytes: 262_144, // 256 KB
  candidateCount: 16,
  verificationCalls: 20,
  retryCount: 5,
});

export const DEFAULT_AGENT_RESOURCE_LIMITS: ResourceAllocation = Object.freeze({
  wallTimeMs: 120_000, // 2 minutes
  toolCalls: 40,
  modelCalls: 20,
  contextBytes: 131_072, // 128 KB
  outputBytes: 65_536, // 64 KB
  candidateCount: 4,
  verificationCalls: 5,
  retryCount: 2,
});

/**
 * Validates that all fields in an allocation are non-negative safe integers.
 */
export function validateResourceAllocation(allocation: ResourceAllocation): {
  readonly valid: boolean;
  readonly errors: readonly string[];
} {
  const errors: string[] = [];
  const fields = [
    "wallTimeMs",
    "toolCalls",
    "modelCalls",
    "contextBytes",
    "outputBytes",
    "candidateCount",
    "verificationCalls",
    "retryCount",
  ] as const;

  for (const field of fields) {
    const val = allocation[field];
    if (typeof val !== "number" || !Number.isFinite(val) || !Number.isInteger(val) || val < 0) {
      errors.push(`Field '${field}' must be a non-negative integer, received ${val}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Computes a deterministic SHA-256 digest of a resource allocation and version.
 */
export function computeAllocationDigest(
  allocation: ResourceAllocation,
  version: number
): string {
  const canonical = canonicalJsonStringify({
    version,
    allocation: {
      wallTimeMs: allocation.wallTimeMs,
      toolCalls: allocation.toolCalls,
      modelCalls: allocation.modelCalls,
      contextBytes: allocation.contextBytes,
      outputBytes: allocation.outputBytes,
      candidateCount: allocation.candidateCount,
      verificationCalls: allocation.verificationCalls,
      retryCount: allocation.retryCount,
    },
  });
  return sha256Hex(canonical);
}

/**
 * Computes a deterministic SHA-256 digest of an immutable authority envelope.
 */
export function computeAuthorityEnvelopeDigest(
  envelope: ImmutableAuthorityEnvelope
): string {
  const canonical = canonicalJsonStringify({
    missionContractId: envelope.missionContractId,
    missionContractVersion: envelope.missionContractVersion,
    missionContractHash: envelope.missionContractHash,
    capabilitySet: [...envelope.capabilitySet].sort(),
    repositoryScope: [...envelope.repositoryScope].sort(),
    workspaceScope: envelope.workspaceScope,
    credentialScope: [...envelope.credentialScope].sort(),
    providerIsolationPolicy: envelope.providerIsolationPolicy,
    verificationAuthority: false,
    terminalAuthority: false,
    policyAuthority: false,
    evidenceSigningAuthority: false,
  });
  return sha256Hex(canonical);
}

/**
 * Adds two resource allocations dimension by dimension.
 */
export function addAllocations(
  a: ResourceAllocation,
  b: Partial<ResourceAllocation>
): ResourceAllocation {
  return {
    wallTimeMs: Math.max(0, a.wallTimeMs + (b.wallTimeMs ?? 0)),
    toolCalls: Math.max(0, a.toolCalls + (b.toolCalls ?? 0)),
    modelCalls: Math.max(0, a.modelCalls + (b.modelCalls ?? 0)),
    contextBytes: Math.max(0, a.contextBytes + (b.contextBytes ?? 0)),
    outputBytes: Math.max(0, a.outputBytes + (b.outputBytes ?? 0)),
    candidateCount: Math.max(0, a.candidateCount + (b.candidateCount ?? 0)),
    verificationCalls: Math.max(0, a.verificationCalls + (b.verificationCalls ?? 0)),
    retryCount: Math.max(0, a.retryCount + (b.retryCount ?? 0)),
  };
}

/**
 * Subtracts allocation b from allocation a dimension by dimension.
 * Fails closed if any dimension would become negative.
 */
export function subtractAllocations(
  a: ResourceAllocation,
  b: Partial<ResourceAllocation>
): {
  readonly success: boolean;
  readonly result?: ResourceAllocation;
  readonly error?: string;
} {
  const target: ResourceAllocation = {
    wallTimeMs: a.wallTimeMs - (b.wallTimeMs ?? 0),
    toolCalls: a.toolCalls - (b.toolCalls ?? 0),
    modelCalls: a.modelCalls - (b.modelCalls ?? 0),
    contextBytes: a.contextBytes - (b.contextBytes ?? 0),
    outputBytes: a.outputBytes - (b.outputBytes ?? 0),
    candidateCount: a.candidateCount - (b.candidateCount ?? 0),
    verificationCalls: a.verificationCalls - (b.verificationCalls ?? 0),
    retryCount: a.retryCount - (b.retryCount ?? 0),
  };

  const validation = validateResourceAllocation(target);
  if (!validation.valid) {
    return {
      success: false,
      error: `Subtraction produced negative allocation: ${validation.errors.join("; ")}`,
    };
  }

  return {
    success: true,
    result: target,
  };
}

/**
 * Compares two allocations dimension by dimension.
 * Returns true if allocation A is component-wise <= allocation B.
 */
export function isWithinCeiling(
  a: ResourceAllocation,
  ceiling: ResourceAllocation
): boolean {
  return (
    a.wallTimeMs <= ceiling.wallTimeMs &&
    a.toolCalls <= ceiling.toolCalls &&
    a.modelCalls <= ceiling.modelCalls &&
    a.contextBytes <= ceiling.contextBytes &&
    a.outputBytes <= ceiling.outputBytes &&
    a.candidateCount <= ceiling.candidateCount &&
    a.verificationCalls <= ceiling.verificationCalls &&
    a.retryCount <= ceiling.retryCount
  );
}
