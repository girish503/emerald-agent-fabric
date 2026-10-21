/**
 * Phase 97: Governed Autonomous Multi-Agent Deadlock Detection and Dynamic Cycle Elimination
 *
 * Domain Model for deadlock graph construction, wait-for analysis, resource-allocation graphs,
 * cycle witness identification, cycle classification, minimum-intervention strategy arbitration,
 * negative security controls N631–N660, and core invariants D1–D20.
 *
 * ABSOLUTE GOVERNING PRINCIPLE:
 * Deadlock may change execution relationships. Deadlock resolution must never change authority.
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";

/**
 * Governed execution node types participating in deadlock dependency graphs.
 */
export type DeadlockNodeType =
  | "GOAL"
  | "TASK"
  | "AGENT"
  | "WORKER"
  | "RESOURCE"
  | "LEASE"
  | "WORKING_TREE"
  | "MEMORY"
  | "SPECULATIVE_BRANCH"
  | "VERIFICATION";

/**
 * Typed dependency relationships establishing directed edges in the wait-for / resource graph.
 */
export type DeadlockDependencyType =
  | "WAIT"
  | "RESOURCE"
  | "LEASE"
  | "GOAL"
  | "WORKING_TREE"
  | "MEMORY"
  | "SPECULATIVE"
  | "VERIFICATION"
  | "ROLE"
  | "PRIORITY";

/**
 * Deterministic cycle classifications.
 * Explicitly separates true deadlocks from benign contention, starvation, livelock, etc.
 */
export type DeadlockClassification =
  | "TRUE_DEADLOCK"
  | "TRANSIENT_CONTENTION"
  | "STARVATION"
  | "PRIORITY_INVERSION"
  | "RESOURCE_EXHAUSTION"
  | "LIVELOCK"
  | "STALE_DEPENDENCY"
  | "RECOVERABLE_LEASE_FAILURE"
  | "UNKNOWN";

/**
 * Governed cycle breaking strategies ordered by the minimum-intervention principle.
 */
export type CycleBreakingStrategy =
  | "NO_INTERVENTION"
  | "WAIT_EDGE_REMOVAL"
  | "RESOURCE_REORDERING"
  | "PRIORITY_INHERITANCE"
  | "WORKLOAD_HANDOFF"
  | "GOVERNED_PREEMPTION"
  | "SPECULATIVE_BRANCH_TERMINATION"
  | "LEASE_RECOVERY"
  | "HUMAN_REVIEW_REQUIRED";

/**
 * Deadlock Graph Node Entity.
 * Represents an execution entity in the dependency graph.
 * Invariant D1: Deadlock detection is observation only (authoritative: false).
 */
export interface DeadlockNode {
  readonly nodeId: string;
  readonly nodeType: DeadlockNodeType;
  readonly entityId: string;
  readonly workflowId: string;
  readonly missionContractId: string;
  readonly missionContractHash: string;
  readonly agentId?: string;
  readonly workerId?: string;
  readonly leaseId?: string;
  readonly actionId?: string;
  readonly attemptId?: string;
  readonly branchId?: string;
  readonly resourceId?: string;
  readonly authoritative: false;
  readonly terminalAuthority: false;
  readonly verificationAuthority: false;
  readonly policyAuthority: false;
  readonly hash: string;
}

/**
 * Deadlock Graph Directed Edge Entity.
 * Represents a causal dependency where `fromNodeId` waits for / requires `toNodeId`.
 */
export interface DeadlockEdge {
  readonly edgeId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly dependencyType: DeadlockDependencyType;
  readonly isOptional: boolean;
  readonly resourceQuantity?: number;
  readonly waitDurationMs: number;
  readonly provenanceDigest: string;
  readonly createdAt: string;
  readonly authoritative: false;
  readonly hash: string;
}

/**
 * Cycle Witness Entity.
 * Represents a verified closed causal cycle in the dependency graph with cryptographic proof.
 */
export interface CycleWitness {
  readonly cycleId: string;
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly classification: DeadlockClassification;
  readonly cycleLength: number;
  readonly detectedAt: string;
  readonly witnessDigest: string;
  readonly provenanceRoot: string;
}

/**
 * Deadlock Resolution Entity.
 * Represents a governed intervention decision to break a verified cycle under minimum intervention.
 */
export interface DeadlockResolution {
  readonly resolutionId: string;
  readonly cycleId: string;
  readonly strategy: CycleBreakingStrategy;
  readonly targetNodeId: string;
  readonly targetEdgeId?: string;
  readonly interventionCost: number;
  readonly rationale: string;
  readonly resolvedAt: string;
  readonly authoritative: false;
  readonly resolutionDigest: string;
}

/**
 * Deadlock Evidence Bundle.
 * Durable cryptographic record of deadlock graph state, cycles, and resolutions.
 */
export interface DeadlockEvidence {
  readonly evidenceId: string;
  readonly graphDigest: string;
  readonly totalNodes: number;
  readonly totalEdges: number;
  readonly cycleWitnesses: readonly CycleWitness[];
  readonly resolutions: readonly DeadlockResolution[];
  readonly provenanceRoot: string;
  readonly timestamp: string;
}

/**
 * Deterministic cost weights for cycle-breaking strategies.
 * Implements the Minimum-Intervention Principle (Section 14).
 */
export const INTERVENTION_STRATEGY_COSTS: Readonly<Record<CycleBreakingStrategy, number>> = {
  NO_INTERVENTION: 0,
  WAIT_EDGE_REMOVAL: 10,
  RESOURCE_REORDERING: 20,
  PRIORITY_INHERITANCE: 30,
  WORKLOAD_HANDOFF: 40,
  GOVERNED_PREEMPTION: 50,
  SPECULATIVE_BRANCH_TERMINATION: 60,
  LEASE_RECOVERY: 70,
  HUMAN_REVIEW_REQUIRED: 100,
};

/**
 * Compute canonical hash for a DeadlockNode.
 */
export function computeDeadlockNodeHash(node: Omit<DeadlockNode, "hash">): string {
  return sha256Hex(
    canonicalJsonStringify({
      nodeId: node.nodeId,
      nodeType: node.nodeType,
      entityId: node.entityId,
      workflowId: node.workflowId,
      missionContractId: node.missionContractId,
      missionContractHash: node.missionContractHash,
      agentId: node.agentId,
      workerId: node.workerId,
      leaseId: node.leaseId,
      actionId: node.actionId,
      attemptId: node.attemptId,
      branchId: node.branchId,
      resourceId: node.resourceId,
    }),
  );
}

/**
 * Compute canonical hash for a DeadlockEdge.
 */
export function computeDeadlockEdgeHash(edge: Omit<DeadlockEdge, "hash">): string {
  return sha256Hex(
    canonicalJsonStringify({
      edgeId: edge.edgeId,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      dependencyType: edge.dependencyType,
      isOptional: edge.isOptional,
      resourceQuantity: edge.resourceQuantity,
      waitDurationMs: edge.waitDurationMs,
      provenanceDigest: edge.provenanceDigest,
      createdAt: edge.createdAt,
    }),
  );
}

/**
 * Compute canonical hash for a CycleWitness.
 */
export function computeCycleWitnessHash(
  cycleId: string,
  nodeIds: readonly string[],
  edgeIds: readonly string[],
  classification: DeadlockClassification,
): string {
  return sha256Hex(
    canonicalJsonStringify({
      cycleId,
      nodeIds,
      edgeIds,
      classification,
    }),
  );
}

/**
 * Compute canonical hash for a DeadlockResolution.
 */
export function computeDeadlockResolutionHash(
  resolution: Omit<DeadlockResolution, "resolutionDigest">,
): string {
  return sha256Hex(
    canonicalJsonStringify({
      resolutionId: resolution.resolutionId,
      cycleId: resolution.cycleId,
      strategy: resolution.strategy,
      targetNodeId: resolution.targetNodeId,
      targetEdgeId: resolution.targetEdgeId,
      interventionCost: resolution.interventionCost,
      rationale: resolution.rationale,
      resolvedAt: resolution.resolvedAt,
    }),
  );
}

/**
 * Validates a DeadlockNode against sovereign non-authoritative boundary invariants.
 */
export function validateDeadlockNode(node: DeadlockNode): { valid: boolean; reason?: string } {
  if (node.authoritative !== false) {
    return { valid: false, reason: "DeadlockNode authoritative flag must be false (D1, N631)" };
  }
  if (node.terminalAuthority !== false) {
    return { valid: false, reason: "DeadlockNode terminalAuthority flag must be false (N632)" };
  }
  if (node.verificationAuthority !== false) {
    return { valid: false, reason: "DeadlockNode verificationAuthority flag must be false (N633)" };
  }
  if (node.policyAuthority !== false) {
    return { valid: false, reason: "DeadlockNode policyAuthority flag must be false (N634)" };
  }
  const expectedHash = computeDeadlockNodeHash(node);
  if (node.hash !== expectedHash) {
    return { valid: false, reason: `Node hash mismatch: expected ${expectedHash}, got ${node.hash}` };
  }
  return { valid: true };
}

/**
 * Validates a CycleWitness against witness integrity rules.
 */
export function validateCycleWitness(witness: CycleWitness): { valid: boolean; reason?: string } {
  if (witness.nodeIds.length < 2) {
    return { valid: false, reason: "CycleWitness must contain at least 2 nodes" };
  }
  if (witness.nodeIds.length !== witness.cycleLength) {
    return { valid: false, reason: "CycleWitness nodeIds length must match cycleLength" };
  }
  const expectedDigest = computeCycleWitnessHash(
    witness.cycleId,
    witness.nodeIds,
    witness.edgeIds,
    witness.classification,
  );
  if (witness.witnessDigest !== expectedDigest) {
    return { valid: false, reason: `Witness digest mismatch: expected ${expectedDigest}, got ${witness.witnessDigest} (N648)` };
  }
  return { valid: true };
}

/**
 * 30 Negative Security Controls for Phase 97 (N631–N660).
 */
export const SECURITY_CONTROLS_PHASE97 = {
  N631: "deadlock detector cannot inject authority",
  N632: "deadlock resolution cannot issue terminal authority",
  N633: "deadlock resolution cannot issue verification authority",
  N634: "deadlock resolution cannot issue policy authority",
  N635: "deadlock resolution cannot modify MissionContract",
  N636: "deadlock resolution cannot expand capabilities",
  N637: "deadlock resolution cannot expand goal scope",
  N638: "deadlock resolution cannot expand repository scope",
  N639: "deadlock resolution cannot expand workspace scope",
  N640: "deadlock resolution cannot substitute agent identity",
  N641: "deadlock resolution cannot substitute worker identity",
  N642: "deadlock resolution cannot substitute lease identity",
  N643: "deadlock resolution cannot substitute Action identity",
  N644: "deadlock resolution cannot substitute Attempt identity",
  N645: "stale dependency evidence cannot authorize cycle breaking",
  N646: "unknown classification cannot trigger destructive intervention",
  N647: "false cycle cannot trigger cancellation",
  N648: "cycle witness cannot be forged",
  N649: "cycle provenance cannot be removed",
  N650: "priority inheritance cannot escalate authority",
  N651: "pre-emption cannot bypass deadlock governance",
  N652: "lease recovery cannot bypass fencing",
  N653: "working-tree cycle resolution cannot lose valid mutations",
  N654: "memory cycle resolution cannot fabricate evidence",
  N655: "speculative cycle resolution cannot promote authority",
  N656: "role handoff cannot bypass capability policy",
  N657: "cycle resolution cannot bypass sovereign verification",
  N658: "deadlock resolver cannot create unbounded recursion",
  N659: "deadlock detector cannot leak oracle/reference information",
  N660: "deadlock resolution cannot alter historical evidence",
} as const;

export type SecurityControlIdPhase97 = keyof typeof SECURITY_CONTROLS_PHASE97;

/**
 * 20 Core Invariants for Governed Deadlock Detection and Cycle Elimination (D1–D20).
 */
export const DEADLOCK_CORE_INVARIANTS = {
  D1: "Deadlock detection is observation only (authoritative: false, terminalAuthority: false, verificationAuthority: false)",
  D2: "Deadlock resolution authority is bounded by existing authority; resolution cannot escalate capabilities",
  D3: "True deadlock requires a verified closed causal dependency cycle",
  D4: "Unknown classification is fail-closed; unknown evidence must not permit destructive resolution",
  D5: "False-positive cycle detection cannot destructively mutate work or trigger cancellation",
  D6: "MissionContract identity is immutable across deadlock detection and cycle elimination",
  D7: "Goal scope cannot expand beyond declared hierarchical goal DAG",
  D8: "Repository and workspace scope cannot expand across deadlock resolution",
  D9: "Action identity is preserved across cycle breaking interventions",
  D10: "Attempt identity is preserved across cycle breaking interventions",
  D11: "Idempotency tokens remain valid and monotonic across deadlock resolution",
  D12: "Lease fencing remains authoritative; deadlock resolution cannot fabricate or extend leases",
  D13: "Priority remains advisory; priority inheritance for cycle breaking is non-authoritative and temporary",
  D14: "Pre-emption remains governed; pre-emption for cycle breaking requires durable checkpointing (P6)",
  D15: "Role rebalancing remains advisory; role changes for cycle breaking must break the causal cycle",
  D16: "Memory remains untrusted observation; memory dependencies cannot confer authority",
  D17: "Speculative branches remain non-sovereign; speculative cycle breaking cannot promote branches to confirmed path",
  D18: "Provenance remains append-oriented; cycle witnesses and resolutions form an immutable Merkle graph",
  D19: "Sovereign verification remains final; clean-room verifier is strictly isolated from deadlock metadata",
  D20: "Deadlock resolution must terminate within bounded resources and bounded recursion depth",
} as const;

export type DeadlockCoreInvariantId = keyof typeof DEADLOCK_CORE_INVARIANTS;
