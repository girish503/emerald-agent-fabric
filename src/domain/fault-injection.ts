/**
 * Phase 98: Governed Autonomous Multi-Agent Fault Injection and Dynamic Byzantine Agreement
 *
 * Domain Model for fault scenarios, fault events, deterministic fault schedules,
 * fault evidence, fault classifications, negative security controls N661–N690,
 * and core invariants B1–B20.
 *
 * ABSOLUTE GOVERNING PRINCIPLE:
 * Agreement may be reconstructed. Authority may never be fabricated.
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";

/**
 * Governed fault classes representing communication, node, and behavioral anomalies.
 */
export type FaultClass =
  | "CRASH"
  | "DELAY"
  | "DROP"
  | "DUPLICATE"
  | "REORDER"
  | "STALE_MESSAGE"
  | "CONFLICTING_MESSAGE"
  | "EQUIVOCATING_AGENT"
  | "CORRUPTED_OBSERVATION"
  | "PARTITION"
  | "RECOVERY"
  | "IDENTITY_MISMATCH"
  | "CONTRACT_MISMATCH"
  | "UNKNOWN";

/**
 * Target entity receiving or experiencing an injected fault.
 */
export interface FaultTarget {
  readonly targetType: "AGENT" | "WORKER" | "CHANNEL" | "PARTITION" | "MESSAGE" | "LEASE" | "CONTRACT" | "VERIFIER";
  readonly targetId: string;
  readonly channelId?: string;
  readonly agentId?: string;
}

/**
 * Deterministic fault classifications separating communication anomalies from malicious/Byzantine behavior.
 */
export type FaultClassification =
  | "TRANSIENT_COMMUNICATION"
  | "CRASH_FAIL_STOP"
  | "OMISSION"
  | "PARTITION_ISOLATION"
  | "EQUIVOCATION"
  | "BYZANTINE_CORRUPTION"
  | "IDENTITY_SPOOF"
  | "CONTRACT_SPOOF"
  | "STALE_REPLAY"
  | "BENIGN_DELAY"
  | "UNKNOWN";

/**
 * State of failure suspicion vs proven Byzantine behavior.
 * Invariant B3: Failure suspicion is not failure proof.
 */
export type FaultSuspicionState =
  | "HEALTHY"
  | "FAILURE_SUSPECTED"
  | "FAILURE_CONFIRMED"
  | "BYZANTINE_BEHAVIOR_EVIDENCED";

/**
 * Deterministic Fault Scenario specification.
 * Invariant B1: Fault injection is test infrastructure only.
 */
export interface FaultScenario {
  readonly scenarioId: string;
  readonly name: string;
  readonly description: string;
  readonly level: number; // 0 to 5
  readonly condition: "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J";
  readonly target: FaultTarget;
  readonly faultClass: FaultClass;
  readonly classification: FaultClassification;
  readonly scheduleTimestamp: string;
  readonly durationMs: number;
  readonly parameters: Record<string, unknown>;
  readonly digest: string;
  readonly provenance: string;
}

/**
 * Deterministic Fault Profile grouping scenarios.
 */
export interface FaultProfile {
  readonly profileId: string;
  readonly name: string;
  readonly level: number;
  readonly scenarios: readonly FaultScenario[];
  readonly faultClasses: readonly FaultClass[];
  readonly digest: string;
}

/**
 * Discrete fault event executed by the test harness.
 */
export interface FaultEvent {
  readonly eventId: string;
  readonly scenarioId: string;
  readonly faultClass: FaultClass;
  readonly target: FaultTarget;
  readonly injectedAt: string;
  readonly sequence: number;
  readonly expectedEffect: string;
  readonly observedEffect?: string;
  readonly resolvedAt?: string;
  readonly status: "INJECTED" | "ACTIVE" | "OBSERVED" | "RESOLVED" | "BLOCKED" | "REVERTED";
  readonly provenance: string;
  readonly hash: string;
}

/**
 * Schedule of deterministic fault events.
 */
export interface FaultSchedule {
  readonly scheduleId: string;
  readonly events: readonly FaultEvent[];
  readonly scenarios: readonly FaultScenario[];
  readonly activeFaults: readonly FaultEvent[];
  readonly resolvedFaults: readonly FaultEvent[];
  readonly digest: string;
}

/**
 * Immutable evidence bundle recorded for every injected fault and detection.
 * Invariant B2: Fault evidence is immutable.
 */
export interface FaultEvidence {
  readonly evidenceId: string;
  readonly scenarioId: string;
  readonly faultEventId: string;
  readonly injectedFaultClass: FaultClass;
  readonly detectedFaultClassification: FaultClassification;
  readonly detectionLatencyMs: number;
  readonly resolutionLatencyMs: number;
  readonly impactOnQuorum: boolean;
  readonly partitionAffected: boolean;
  readonly quarantineActionTaken: boolean;
  readonly provenanceRoot: string;
  readonly immutable: true;
  readonly authoritative: false;
  readonly hash: string;
}

/**
 * Security control definition for Phase 98 (N661–N690).
 */
export interface Phase98SecurityControl {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly status: "FAIL_CLOSED";
}

/**
 * Exact 30 Negative Security Controls for Phase 98 (N661–N690).
 */
export const SECURITY_CONTROLS_PHASE98: readonly Phase98SecurityControl[] = [
  { id: "N661", name: "fault_injection_authority", description: "fault injection cannot grant authority", status: "FAIL_CLOSED" },
  { id: "N662", name: "byzantine_terminal_authority", description: "Byzantine agent cannot issue terminal authority", status: "FAIL_CLOSED" },
  { id: "N663", name: "byzantine_verification_authority", description: "Byzantine agent cannot issue verification authority", status: "FAIL_CLOSED" },
  { id: "N664", name: "byzantine_policy_authority", description: "Byzantine agent cannot issue policy authority", status: "FAIL_CLOSED" },
  { id: "N665", name: "byzantine_contract_mutation", description: "Byzantine agent cannot modify MissionContract", status: "FAIL_CLOSED" },
  { id: "N666", name: "byzantine_capability_expansion", description: "Byzantine agent cannot expand capability", status: "FAIL_CLOSED" },
  { id: "N667", name: "byzantine_goal_scope", description: "Byzantine agent cannot expand goal scope", status: "FAIL_CLOSED" },
  { id: "N668", name: "byzantine_repo_scope", description: "Byzantine agent cannot expand repository scope", status: "FAIL_CLOSED" },
  { id: "N669", name: "byzantine_workspace_scope", description: "Byzantine agent cannot expand workspace scope", status: "FAIL_CLOSED" },
  { id: "N670", name: "byzantine_agent_identity", description: "Byzantine agent cannot substitute agent identity", status: "FAIL_CLOSED" },
  { id: "N671", name: "byzantine_worker_identity", description: "Byzantine agent cannot substitute worker identity", status: "FAIL_CLOSED" },
  { id: "N672", name: "byzantine_lease_identity", description: "Byzantine agent cannot substitute lease identity", status: "FAIL_CLOSED" },
  { id: "N673", name: "byzantine_action_identity", description: "Byzantine agent cannot substitute Action identity", status: "FAIL_CLOSED" },
  { id: "N674", name: "byzantine_attempt_identity", description: "Byzantine agent cannot substitute Attempt identity", status: "FAIL_CLOSED" },
  { id: "N675", name: "stale_message_state_override", description: "stale message cannot override current state", status: "FAIL_CLOSED" },
  { id: "N676", name: "duplicate_message_execution", description: "duplicate message cannot cause duplicate execution", status: "FAIL_CLOSED" },
  { id: "N677", name: "reordered_message_sequence", description: "reordered message cannot violate sequence semantics", status: "FAIL_CLOSED" },
  { id: "N678", name: "dropped_message_agreement", description: "dropped message cannot fabricate agreement", status: "FAIL_CLOSED" },
  { id: "N679", name: "partition_quorum_fabrication", description: "partition cannot fabricate quorum", status: "FAIL_CLOSED" },
  { id: "N680", name: "split_brain_terminal_authority", description: "split-brain quorum cannot issue terminal authority", status: "FAIL_CLOSED" },
  { id: "N681", name: "equivocation_conflicting_state", description: "equivocation cannot create conflicting sovereign state", status: "FAIL_CLOSED" },
  { id: "N682", name: "byzantine_evidence_provenance", description: "Byzantine evidence cannot bypass provenance", status: "FAIL_CLOSED" },
  { id: "N683", name: "false_verification_claim", description: "false verification claim cannot bypass verifier", status: "FAIL_CLOSED" },
  { id: "N684", name: "false_completion_attempt_success", description: "false completion claim cannot create Attempt success", status: "FAIL_CLOSED" },
  { id: "N685", name: "false_priority_authority", description: "false priority cannot create priority authority", status: "FAIL_CLOSED" },
  { id: "N686", name: "false_preemption_cancellation", description: "false pre-emption cannot cancel governed work", status: "FAIL_CLOSED" },
  { id: "N687", name: "false_deadlock_destructive_resolution", description: "false deadlock evidence cannot trigger destructive resolution", status: "FAIL_CLOSED" },
  { id: "N688", name: "fault_injection_evidence_alteration", description: "fault injection cannot alter historical evidence", status: "FAIL_CLOSED" },
  { id: "N689", name: "quorum_contract_modification", description: "quorum cannot modify contract identity", status: "FAIL_CLOSED" },
  { id: "N690", name: "agreement_sovereign_authority", description: "agreement cannot become sovereign authority", status: "FAIL_CLOSED" },
] as const;

/**
 * Core Invariant definition for Phase 98 (B1–B20).
 */
export interface Phase98CoreInvariant {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly status: "UPHELD";
}

/**
 * Exact 20 Core Invariants for Phase 98 (B1–B20).
 */
export const FAULT_AGREEMENT_INVARIANTS: readonly Phase98CoreInvariant[] = [
  { id: "B1", name: "fault_injection_test_only", description: "Fault injection is test-only", status: "UPHELD" },
  { id: "B2", name: "fault_evidence_immutable", description: "Fault evidence is immutable", status: "UPHELD" },
  { id: "B3", name: "suspicion_not_proof", description: "Failure suspicion is not failure proof", status: "UPHELD" },
  { id: "B4", name: "byzantine_claims_untrusted", description: "Byzantine claims are untrusted observations", status: "UPHELD" },
  { id: "B5", name: "quorum_membership_governed", description: "Quorum membership is governed", status: "UPHELD" },
  { id: "B6", name: "quorum_cannot_expand_authority", description: "Quorum cannot expand authority", status: "UPHELD" },
  { id: "B7", name: "partition_overwrite_prohibited", description: "Partitioned state cannot silently overwrite state", status: "UPHELD" },
  { id: "B8", name: "split_brain_terminal_prohibited", description: "Split-brain state cannot issue terminal authority", status: "UPHELD" },
  { id: "B9", name: "agreement_not_verification", description: "Agreement is not verification", status: "UPHELD" },
  { id: "B10", name: "agreement_not_terminal", description: "Agreement is not terminal success", status: "UPHELD" },
  { id: "B11", name: "agreement_cannot_modify_contract", description: "Agreement cannot modify MissionContract", status: "UPHELD" },
  { id: "B12", name: "message_identity_immutable", description: "Message identity is immutable", status: "UPHELD" },
  { id: "B13", name: "message_sequence_monotonic", description: "Message sequence is monotonic", status: "UPHELD" },
  { id: "B14", name: "stale_messages_rejected", description: "Stale messages cannot override current state", status: "UPHELD" },
  { id: "B15", name: "duplicate_messages_idempotent", description: "Duplicate messages cannot duplicate execution", status: "UPHELD" },
  { id: "B16", name: "equivocation_detectable", description: "Equivocation is detectable", status: "UPHELD" },
  { id: "B17", name: "conflicting_evidence_preserved", description: "Conflicting evidence is preserved", status: "UPHELD" },
  { id: "B18", name: "reconciliation_deterministic", description: "Reconciliation is deterministic", status: "UPHELD" },
  { id: "B19", name: "sovereign_verification_final", description: "Sovereign verification remains final", status: "UPHELD" },
  { id: "B20", name: "resolution_bounded_fail_closed", description: "Byzantine resolution is bounded and fail-closed", status: "UPHELD" },
] as const;

/**
 * Computes deterministic hash for a fault scenario.
 */
export function computeFaultScenarioDigest(scenario: Omit<FaultScenario, "digest">): string {
  const content = {
    scenarioId: scenario.scenarioId,
    name: scenario.name,
    level: scenario.level,
    condition: scenario.condition,
    target: scenario.target,
    faultClass: scenario.faultClass,
    classification: scenario.classification,
    scheduleTimestamp: scenario.scheduleTimestamp,
    durationMs: scenario.durationMs,
    parameters: scenario.parameters,
    provenance: scenario.provenance,
  };
  return sha256Hex(canonicalJsonStringify(content));
}

/**
 * Computes deterministic hash for a discrete fault event.
 */
export function computeFaultEventHash(event: Omit<FaultEvent, "hash">): string {
  const content = {
    eventId: event.eventId,
    scenarioId: event.scenarioId,
    faultClass: event.faultClass,
    target: event.target,
    injectedAt: event.injectedAt,
    sequence: event.sequence,
    expectedEffect: event.expectedEffect,
    observedEffect: event.observedEffect ?? null,
    resolvedAt: event.resolvedAt ?? null,
    status: event.status,
    provenance: event.provenance,
  };
  return sha256Hex(canonicalJsonStringify(content));
}

/**
 * Computes deterministic hash for a fault evidence record.
 */
export function computeFaultEvidenceHash(evidence: Omit<FaultEvidence, "hash">): string {
  const content = {
    evidenceId: evidence.evidenceId,
    scenarioId: evidence.scenarioId,
    faultEventId: evidence.faultEventId,
    injectedFaultClass: evidence.injectedFaultClass,
    detectedFaultClassification: evidence.detectedFaultClassification,
    detectionLatencyMs: evidence.detectionLatencyMs,
    resolutionLatencyMs: evidence.resolutionLatencyMs,
    impactOnQuorum: evidence.impactOnQuorum,
    partitionAffected: evidence.partitionAffected,
    quarantineActionTaken: evidence.quarantineActionTaken,
    provenanceRoot: evidence.provenanceRoot,
    immutable: evidence.immutable,
    authoritative: evidence.authoritative,
  };
  return sha256Hex(canonicalJsonStringify(content));
}
