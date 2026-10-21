/**
 * Phase 99: Governed Autonomous Multi-Agent Capability Fencing and Dynamic Cross-Harness Boundary Enactment
 *
 * Domain Model for capability fences, capability lattices, downward delegation constraints,
 * intersection-only capability composition, anti-laundering/anti-splitting barriers,
 * negative security controls N691–N720, and core invariants C1–C20.
 *
 * ABSOLUTE GOVERNING PRINCIPLE:
 * Capability may be delegated only downward within a fixed safety envelope.
 * Capability composition must never create authority ex nihilo.
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";

/**
 * Positive capabilities represent strictly bounded, non-destructive permissions
 * that may be granted to agents within their governed harness.
 */
export type PositiveCapability =
  | "READ_WORKSPACE"
  | "READ_REPOSITORY"
  | "READ_AST"
  | "READ_DEPENDENCY_GRAPH"
  | "READ_TEST_METADATA"
  | "WRITE_TEMPORARY_OUTPUT"
  | "EXECUTE_ANALYSIS";

/**
 * Forbidden capabilities are strictly prohibited from being granted to or held by
 * any agent, role, or dynamic harness.
 */
export type ForbiddenCapability =
  | "WRITE_REPOSITORY"
  | "COMMIT_GIT"
  | "PUSH_GIT"
  | "MODIFY_POLICY"
  | "MODIFY_MISSION_CONTRACT"
  | "SIGN_EVIDENCE"
  | "ISSUE_TERMINAL_AUTHORITY"
  | "ACCESS_CREDENTIALS"
  | "ACCESS_PRIVATE_KEYS"
  | "CHANGE_WORKSPACE_BOUNDARY"
  | "SPAWN_UNBOUNDED_PROCESS"
  | "NETWORK_ACCESS"
  | "DOCKER_SOCKET_ACCESS"
  | "HOST_FILESYSTEM_ACCESS";

export type CapabilityType = PositiveCapability | ForbiddenCapability;

export const ALL_POSITIVE_CAPABILITIES: readonly PositiveCapability[] = [
  "READ_WORKSPACE",
  "READ_REPOSITORY",
  "READ_AST",
  "READ_DEPENDENCY_GRAPH",
  "READ_TEST_METADATA",
  "WRITE_TEMPORARY_OUTPUT",
  "EXECUTE_ANALYSIS",
] as const;

export const ALL_FORBIDDEN_CAPABILITIES: readonly ForbiddenCapability[] = [
  "WRITE_REPOSITORY",
  "COMMIT_GIT",
  "PUSH_GIT",
  "MODIFY_POLICY",
  "MODIFY_MISSION_CONTRACT",
  "SIGN_EVIDENCE",
  "ISSUE_TERMINAL_AUTHORITY",
  "ACCESS_CREDENTIALS",
  "ACCESS_PRIVATE_KEYS",
  "CHANGE_WORKSPACE_BOUNDARY",
  "SPAWN_UNBOUNDED_PROCESS",
  "NETWORK_ACCESS",
  "DOCKER_SOCKET_ACCESS",
  "HOST_FILESYSTEM_ACCESS",
] as const;

/**
 * Trust labels reflecting the provenance and sovereignty level of information/evidence.
 */
export type TrustLabel =
  | "UNTRUSTED_OBSERVATION"
  | "GOVERNED_OBSERVATION"
  | "VERIFIED_EVIDENCE"
  | "POLICY_DECISION"
  | "SOVEREIGN_VERIFICATION"
  | "TERMINAL_AUTHORITY";

/**
 * Lifecycle states of a governed capability fence.
 */
export type FenceStatus =
  | "PROPOSED"
  | "VALIDATING"
  | "ACTIVE"
  | "REJECTED"
  | "REVOKED"
  | "EXPIRED"
  | "QUARANTINED";

/**
 * Concrete boundary scope defining spatial, tool, and resource containment.
 */
export interface CapabilityScope {
  readonly allowedWorkspacePaths: readonly string[];
  readonly forbiddenWorkspacePaths: readonly string[];
  readonly allowedTools: readonly string[];
  readonly maxOperations: number;
  readonly maxMemoryBytes: number;
  readonly networkAllowed: false; // Invariant C12: network is never allowed
  readonly gitWriteAllowed: false; // Invariant C1: git write is never allowed
}

/**
 * Governed Capability Fence representing the active security perimeter for an agent/harness.
 */
export interface CapabilityFence {
  readonly fenceId: string;
  readonly subjectId: string;
  readonly roleId: string;
  readonly harnessId: string;
  readonly allowedCapabilities: readonly PositiveCapability[];
  readonly forbiddenCapabilities: readonly ForbiddenCapability[];
  readonly scope: CapabilityScope;
  readonly trustLabel: TrustLabel;
  readonly status: FenceStatus;
  readonly parentFenceId?: string;
  readonly delegatedFenceIds: readonly string[];
  readonly version: number;
  readonly missionContractId: string;
  readonly missionContractHash: string;
  readonly authoritative: false;
  readonly terminalAuthority: false;
  readonly sovereignAuthority: false;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
  readonly hash: string;
}

/**
 * A verified grant of a single capability within an active fence.
 */
export interface CapabilityGrant {
  readonly grantId: string;
  readonly fenceId: string;
  readonly subjectId: string;
  readonly capability: PositiveCapability;
  readonly scope: CapabilityScope;
  readonly justification: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly signature: string;
  readonly hash: string;
}

/**
 * A recorded denial of an unauthorized, forbidden, or escalating capability attempt.
 */
export interface CapabilityDenial {
  readonly denialId: string;
  readonly fenceId: string;
  readonly subjectId: string;
  readonly requestedCapability: string;
  readonly reason: string;
  readonly controlId: string; // e.g. "N691"–"N720"
  readonly attemptedAt: string;
  readonly hash: string;
}

/**
 * Cryptographic evidence of fence operations and lifecycle transitions.
 */
export interface CapabilityEvidence {
  readonly evidenceId: string;
  readonly fenceId: string;
  readonly eventType: string;
  readonly details: Record<string, unknown>;
  readonly timestamp: string;
  readonly provenanceRoot: string;
  readonly hash: string;
}

/**
 * Recorded violation when an agent or harness breaches or attempts to breach fence boundaries.
 */
export interface CapabilityViolation {
  readonly violationId: string;
  readonly fenceId: string;
  readonly subjectId: string;
  readonly attemptedCapability: string;
  readonly violationType:
    | "UNDECLARED"
    | "FORBIDDEN"
    | "ESCALATION"
    | "LAUNDERING"
    | "SPLITTING"
    | "CONFUSED_DEPUTY"
    | "EXPIRED"
    | "REVOKED"
    | "SCOPE_BREACH"
    | "PATH_TRAVERSAL";
  readonly severity: "CRITICAL" | "HIGH" | "MEDIUM";
  readonly blockedAt: string;
  readonly hash: string;
}

/**
 * 30 Negative Security Controls for Phase 99 (N691–N720).
 * All 30 controls MUST fail-closed.
 */
export const SECURITY_CONTROLS_PHASE99 = [
  { id: "N691", description: "Direct invocation of undeclared capability rejected fail-closed" },
  { id: "N692", description: "Indirect invocation of undeclared capability through delegated agent rejected fail-closed" },
  { id: "N693", description: "Cross-harness privilege escalation via higher-authority harness rejected fail-closed" },
  { id: "N694", description: "Capability laundering (unprivileged agent routing request through privileged agent) rejected fail-closed" },
  { id: "N695", description: "Capability splitting (combining multiple partial capabilities to achieve prohibited capability) rejected fail-closed" },
  { id: "N696", description: "Confused deputy exploitation across harness boundaries rejected fail-closed" },
  { id: "N697", description: "Delegation to subject with broader capabilities than parent rejected fail-closed" },
  { id: "N698", description: "Delegation extending beyond parent capability expiration rejected fail-closed" },
  { id: "N699", description: "Delegation extending beyond parent resource budget rejected fail-closed" },
  { id: "N700", description: "Execution with expired capability lease rejected fail-closed" },
  { id: "N701", description: "Execution with revoked capability fence rejected fail-closed" },
  { id: "N702", description: "Execution with mismatched capability fence version rejected fail-closed" },
  { id: "N703", description: "Execution with mismatched mission contract hash in capability grant rejected fail-closed" },
  { id: "N704", description: "Capability grant without valid sovereign verification proof rejected fail-closed" },
  { id: "N705", description: "Synthetic capability grant generated ex nihilo without provenance rejected fail-closed" },
  { id: "N706", description: "Composed capability expanding beyond intersection of authorized capabilities rejected fail-closed" },
  { id: "N707", description: "Downward delegation to child with elevated repo write capability rejected fail-closed" },
  { id: "N708", description: "Upward capability reflection claiming parent authority rejected fail-closed" },
  { id: "N709", description: "Cross-harness data flow bypassing boundary sanitization rejected fail-closed" },
  { id: "N710", description: "Unfenced file system path traversal outside workspace boundary rejected fail-closed" },
  { id: "N711", description: "Unfenced tool execution attempting host escape rejected fail-closed" },
  { id: "N712", description: "Unfenced network socket access or DNS exfiltration rejected fail-closed" },
  { id: "N713", description: "Stale capability lease reuse after role rebalancing rejected fail-closed" },
  { id: "N714", description: "Capability grant spoofing during pre-emption or task suspension rejected fail-closed" },
  { id: "N715", description: "Capability expansion through speculative branch reconciliation rejected fail-closed" },
  { id: "N716", description: "Deadlock resolution cycle break granting unauthorized bypass capability rejected fail-closed" },
  { id: "N717", description: "Byzantine agreement quorum attempting to manufacture terminal authority rejected fail-closed" },
  { id: "N718", description: "Memory-assisted cross-agent authority forgery rejected fail-closed" },
  { id: "N719", description: "Clean-room sovereign verification bypass via composite cross-harness evidence rejected fail-closed" },
  { id: "N720", description: "Terminal authority claim without independent cryptographic verification rejected fail-closed" },
] as const;

/**
 * 20 Core Invariants for Governed Capability Fencing (C1–C20).
 */
export const CAPABILITY_FENCING_INVARIANTS = [
  { id: "C1", description: "Absolute Boundary Invariant — No agent, role, or harness may execute outside its signed capability fence." },
  { id: "C2", description: "Downward-Only Delegation Invariant — Capability delegation is strictly downward: D ⊆ P, never expanding scope or permissions." },
  { id: "C3", description: "Intersection-Only Composition Invariant — Composition of multiple capabilities is strictly their intersection: Composed ⊆ ⋂ C_i." },
  { id: "C4", description: "No Authority Ex Nihilo Invariant — Authority cannot be fabricated, synthesised, or inferred from unprivileged actions." },
  { id: "C5", description: "Anti-Laundering Invariant — High-authority harness must not execute actions for low-authority caller unless caller holds capability." },
  { id: "C6", description: "Anti-Splitting Invariant — Operations split across multiple agents/steps that aggregate into forbidden state are rejected." },
  { id: "C7", description: "Confused Deputy Defense Invariant — Gateways independently verify caller identity, capability scope, and target resource authorization." },
  { id: "C8", description: "Lease-Bounded Lifetime Invariant — Capability leases expire deterministically and cannot be extended without re-authorization." },
  { id: "C9", description: "Revocation Immediacy Invariant — Revocation of parent fence immediately cascades and revokes all delegated descendant fences." },
  { id: "C10", description: "Contract Identity Binding Invariant — Every capability fence and grant is strictly bound to immutable Mission Contract ID and hash." },
  { id: "C11", description: "Trust Label Monotonicity Invariant — Trust labels may degrade or remain equal, but never escalate without sovereign verification." },
  { id: "C12", description: "Workspace Containment Invariant — Capability fences strictly contain file operations within allocated workspace root; path traversals rejected." },
  { id: "C13", description: "Action/Attempt Authority Invariant — Capability fences govern execution without mutating Action/Attempt status machines." },
  { id: "C14", description: "Speculative Isolation Invariant — Speculative execution runs in isolated capability fence; cannot commit to master working-tree." },
  { id: "C15", description: "Role Rebalancing Containment Invariant — Dynamic role rebalancing cannot transfer capabilities not already held by target role contract." },
  { id: "C16", description: "Pre-emption Fence Preservation Invariant — Pre-empted tasks preserve capability fences in durable checkpoints without escalation upon resume." },
  { id: "C17", description: "Deadlock Mitigation Non-Escalation Invariant — Deadlock cycle elimination must never elevate execution authority to break cycles." },
  { id: "C18", description: "Byzantine Fence Immunity Invariant — Byzantine or faulty agents cannot compromise capability fences of healthy agents or the fabric." },
  { id: "C19", description: "Sovereign Verification Primacy Invariant — Sovereign verification retains absolute final authority over all capability claims." },
  { id: "C20", description: "Fail-Closed Enactment Invariant — Any ambiguity, boundary breach, invalid signature, or fence conflict terminates fail-closed." },
] as const;

/**
 * Calculates the strict intersection of two sets of capabilities.
 * Composed capability must NEVER be the union.
 */
export function intersectCapabilities(
  capsA: readonly PositiveCapability[],
  capsB: readonly PositiveCapability[],
): PositiveCapability[] {
  const setB = new Set(capsB);
  return capsA.filter((cap) => setB.has(cap));
}

/**
 * Checks if child capabilities are a subset of parent capabilities (Downward delegation).
 */
export function isSubCapabilitySet(
  childCaps: readonly PositiveCapability[],
  parentCaps: readonly PositiveCapability[],
): boolean {
  const parentSet = new Set(parentCaps);
  return childCaps.every((c) => parentSet.has(c));
}

/**
 * Checks if child scope is completely contained within parent scope.
 */
export function isScopeContained(
  childScope: CapabilityScope,
  parentScope: CapabilityScope,
): boolean {
  if (childScope.maxOperations > parentScope.maxOperations) return false;
  if (childScope.maxMemoryBytes > parentScope.maxMemoryBytes) return false;
  const parentTools = new Set(parentScope.allowedTools);
  if (!childScope.allowedTools.every((t) => parentTools.has(t))) return false;
  return true;
}

/**
 * Hash computation helper for CapabilityFence.
 */
export function computeCapabilityFenceHash(fence: Omit<CapabilityFence, "hash">): string {
  return sha256Hex(canonicalJsonStringify(fence));
}

/**
 * Hash computation helper for CapabilityGrant.
 */
export function computeCapabilityGrantHash(grant: Omit<CapabilityGrant, "hash">): string {
  return sha256Hex(canonicalJsonStringify(grant));
}

/**
 * Hash computation helper for CapabilityDenial.
 */
export function computeCapabilityDenialHash(denial: Omit<CapabilityDenial, "hash">): string {
  return sha256Hex(canonicalJsonStringify(denial));
}

/**
 * Hash computation helper for CapabilityEvidence.
 */
export function computeCapabilityEvidenceHash(evidence: Omit<CapabilityEvidence, "hash">): string {
  return sha256Hex(canonicalJsonStringify(evidence));
}

/**
 * Hash computation helper for CapabilityViolation.
 */
export function computeCapabilityViolationHash(violation: Omit<CapabilityViolation, "hash">): string {
  return sha256Hex(canonicalJsonStringify(violation));
}
