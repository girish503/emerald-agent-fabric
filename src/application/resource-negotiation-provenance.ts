/**
 * Phase 91: Resource Negotiation Provenance Engine
 *
 * Implements cryptographic Merkle tree audit trails and provenance tracking
 * for all multi-agent resource renegotiations, decisions, and atomic transfers.
 *
 * INVARIANTS:
 * 1. Every renegotiation must extend provenance.
 * 2. No historical allocation or decision may be deleted or mutated.
 * 3. Any tampering with past allocations breaks the Merkle root.
 */

import { canonicalJsonStringify, sha256Hex } from "../domain/canonical-hash.js";
import {
  RenegotiationDecision,
  RenegotiationRequest,
} from "../domain/resource-renegotiation.js";
import { ResourceAllocation } from "../domain/resource-allocation.js";

export interface NegotiationProvenanceEntry {
  readonly entryId: string;
  readonly requestId: string;
  readonly contractId: string;
  readonly agentId: string;
  readonly goalId: string;
  readonly previousAllocation: ResourceAllocation;
  readonly previousAllocationVersion: number;
  readonly newAllocation: ResourceAllocation;
  readonly newAllocationVersion: number;
  readonly decision: RenegotiationDecision;
  readonly poolAllocated: ResourceAllocation;
  readonly poolAvailable: ResourceAllocation;
  readonly missionContractHash: string;
  readonly evidenceDigest: string;
  readonly previousEntryHash?: string;
  readonly entryHash: string;
  readonly timestamp: string;
}

export interface NegotiationProvenanceAuditLog {
  readonly logId: string;
  readonly missionContractId: string;
  readonly missionContractHash: string;
  readonly entries: readonly NegotiationProvenanceEntry[];
  readonly merkleRoot: string;
  readonly updatedAt: string;
}

/**
 * Computes a deterministic SHA-256 hash of a single provenance entry.
 */
export function computeProvenanceEntryHash(entry: {
  readonly requestId: string;
  readonly contractId: string;
  readonly agentId: string;
  readonly previousAllocationVersion: number;
  readonly newAllocationVersion: number;
  readonly decisionDigest: string;
  readonly missionContractHash: string;
  readonly evidenceDigest: string;
  readonly previousEntryHash?: string;
}): string {
  const canonical = canonicalJsonStringify({
    requestId: entry.requestId,
    contractId: entry.contractId,
    agentId: entry.agentId,
    previousAllocationVersion: entry.previousAllocationVersion,
    newAllocationVersion: entry.newAllocationVersion,
    decisionDigest: entry.decisionDigest,
    missionContractHash: entry.missionContractHash,
    evidenceDigest: entry.evidenceDigest,
    previousEntryHash: entry.previousEntryHash ?? null,
  });
  return sha256Hex(canonical);
}

/**
 * Computes a cryptographic Merkle root over a list of entry hashes.
 */
export function computeProvenanceMerkleRoot(entryHashes: readonly string[]): string {
  if (entryHashes.length === 0) {
    return sha256Hex("EMPTY_NEGOTIATION_PROVENANCE_ROOT");
  }

  let currentLevel = [...entryHashes];

  while (currentLevel.length > 1) {
    const nextLevel: string[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      if (i + 1 < currentLevel.length) {
        const combined = canonicalJsonStringify([currentLevel[i], currentLevel[i + 1]]);
        nextLevel.push(sha256Hex(combined));
      } else {
        // Odd node: hash with itself
        const combined = canonicalJsonStringify([currentLevel[i], currentLevel[i]]);
        nextLevel.push(sha256Hex(combined));
      }
    }
    currentLevel = nextLevel;
  }

  return currentLevel[0] ?? sha256Hex("EMPTY_NEGOTIATION_PROVENANCE_ROOT");
}

/**
 * Appends a verified entry to the provenance audit log, recomputing the Merkle root.
 */
export function appendProvenanceEntry(
  log: NegotiationProvenanceAuditLog,
  entryParams: {
    readonly request: RenegotiationRequest;
    readonly previousAllocation: ResourceAllocation;
    readonly previousAllocationVersion: number;
    readonly newAllocation: ResourceAllocation;
    readonly newAllocationVersion: number;
    readonly decision: RenegotiationDecision;
    readonly poolAllocated: ResourceAllocation;
    readonly poolAvailable: ResourceAllocation;
    readonly missionContractHash: string;
    readonly evidenceDigest: string;
  }
): NegotiationProvenanceAuditLog {
  const previousEntry = log.entries[log.entries.length - 1];
  const previousEntryHash = previousEntry?.entryHash;

  const entryHash = computeProvenanceEntryHash({
    requestId: entryParams.request.requestId,
    contractId: entryParams.request.contractId,
    agentId: entryParams.request.agentId,
    previousAllocationVersion: entryParams.previousAllocationVersion,
    newAllocationVersion: entryParams.newAllocationVersion,
    decisionDigest: entryParams.decision.allocationDigest,
    missionContractHash: entryParams.missionContractHash,
    evidenceDigest: entryParams.evidenceDigest,
    previousEntryHash,
  });

  const entry: NegotiationProvenanceEntry = {
    entryId: `entry-${log.entries.length + 1}-${entryParams.request.requestId}`,
    requestId: entryParams.request.requestId,
    contractId: entryParams.request.contractId,
    agentId: entryParams.request.agentId,
    goalId: entryParams.request.goalId,
    previousAllocation: entryParams.previousAllocation,
    previousAllocationVersion: entryParams.previousAllocationVersion,
    newAllocation: entryParams.newAllocation,
    newAllocationVersion: entryParams.newAllocationVersion,
    decision: entryParams.decision,
    poolAllocated: entryParams.poolAllocated,
    poolAvailable: entryParams.poolAvailable,
    missionContractHash: entryParams.missionContractHash,
    evidenceDigest: entryParams.evidenceDigest,
    previousEntryHash,
    entryHash,
    timestamp: new Date().toISOString(),
  };

  const updatedEntries = [...log.entries, entry];
  const merkleRoot = computeProvenanceMerkleRoot(
    updatedEntries.map((e) => e.entryHash)
  );

  return {
    ...log,
    entries: updatedEntries,
    merkleRoot,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Verifies the integrity of the entire provenance log.
 * Returns true only if all chaining hashes and Merkle root match.
 */
export function verifyProvenanceIntegrity(
  log: NegotiationProvenanceAuditLog
): {
  readonly valid: boolean;
  readonly errors: string[];
} {
  const errors: string[] = [];

  for (let i = 0; i < log.entries.length; i++) {
    const entry = log.entries[i];
    if (!entry) continue;

    const prevEntry = i > 0 ? log.entries[i - 1] : undefined;
    const prevHash = prevEntry?.entryHash;

    if (entry.previousEntryHash !== prevHash) {
      errors.push(
        `Broken hash chain at entry ${entry.entryId}: expected previous ${prevHash}, got ${entry.previousEntryHash}`
      );
    }

    const expectedHash = computeProvenanceEntryHash({
      requestId: entry.requestId,
      contractId: entry.contractId,
      agentId: entry.agentId,
      previousAllocationVersion: entry.previousAllocationVersion,
      newAllocationVersion: entry.newAllocationVersion,
      decisionDigest: entry.decision.allocationDigest,
      missionContractHash: entry.missionContractHash,
      evidenceDigest: entry.evidenceDigest,
      previousEntryHash: prevHash,
    });

    if (entry.entryHash !== expectedHash) {
      errors.push(
        `Tampered entry hash at entry ${entry.entryId}: expected ${expectedHash}, got ${entry.entryHash}`
      );
    }
  }

  const expectedRoot = computeProvenanceMerkleRoot(
    log.entries.map((e) => e.entryHash)
  );
  if (log.merkleRoot !== expectedRoot) {
    errors.push(
      `Tampered Merkle root: expected ${expectedRoot}, got ${log.merkleRoot}`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
