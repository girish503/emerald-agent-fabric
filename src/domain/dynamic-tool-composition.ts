/**
 * Phase 87 — Governed Multi-Tool Composition and Sequential Dynamic Analysis Chains
 *
 * Domain types, lifecycle models, capability intersection rules,
 * data-flow transfer records, and cryptographic provenance primitives for
 * multi-stage dynamic tool pipelines.
 *
 * CENTRAL ARCHITECTURAL INVARIANT:
 * "Tool composition may increase computational capability, but it must never increase authority."
 * "ComposedAuthority ⊆ Intersection(Tool1Authority, Tool2Authority, ...) ∩ WorkflowAuthority."
 * "Dynamic tool composition possesses ZERO terminal authority, ZERO policy authority, and ZERO verification authority."
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";
import type { AllowedToolCapability } from "./dynamic-tool.js";
export type { AllowedToolCapability } from "./dynamic-tool.js";

export type CompositionLifecycleState =
  | "PROPOSED"
  | "VALIDATING"
  | "AUTHORIZED"
  | "STAGE_READY"
  | "EXECUTING_STAGE"
  | "STAGE_SUCCEEDED"
  | "STAGE_FAILED"
  | "PIPELINE_ABORTING"
  | "PIPELINE_ABORTED"
  | "PIPELINE_COMPLETED"
  | "QUARANTINED"
  | "REVOKED"
  | "EXPIRED";

export type CompositionFailurePolicy =
  | "FAIL_FAST"
  | "BOUNDED_SKIP"
  | "REQUIRED_STAGE";

export type CompositionExecutionStatus =
  | "NOT_STARTED"
  | "PARTIALLY_EXECUTED"
  | "COMPLETED"
  | "FAILED"
  | "ABORTED"
  | "UNKNOWN";

export type CompositionTopologyType =
  | "TOPOLOGY_A_LINEAR_2"
  | "TOPOLOGY_B_LINEAR_3"
  | "TOPOLOGY_C_LINEAR_4"
  | "TOPOLOGY_D_BRANCHED";

export interface CompositionResourceLimits {
  readonly maxStageInputBytes: number;
  readonly maxStageOutputBytes: number;
  readonly maxCompositionContextBytes: number;
  readonly maxTools: number;
  readonly maxDepth: number;
  readonly maxInvocations: number;
  readonly maxExecutionMs: number;
  readonly maxMemoryBytes: number;
}

export const DEFAULT_COMPOSITION_RESOURCE_LIMITS: CompositionResourceLimits = {
  maxStageInputBytes: 64 * 1024, // 64 KB
  maxStageOutputBytes: 1024 * 1024, // 1 MB
  maxCompositionContextBytes: 128 * 1024, // 128 KB
  maxTools: 8,
  maxDepth: 4,
  maxInvocations: 16,
  maxExecutionMs: 120000, // 120 seconds
  maxMemoryBytes: 256 * 1024 * 1024, // 256 MB
};

export interface CompositionStageSpec {
  readonly stageId: string;
  readonly sequenceNumber: number;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly toolSourceDigest: string;
  readonly toolManifestDigest: string;
  readonly inputProjection?: Record<string, unknown>;
  readonly outputProjection?: Record<string, unknown>;
  readonly capabilityScope: readonly AllowedToolCapability[];
  readonly workspaceScopes: readonly string[];
  readonly repositoryScopes: readonly string[];
  readonly resourceBudget: Partial<CompositionResourceLimits>;
  readonly timeoutMs: number;
  readonly failurePolicy: CompositionFailurePolicy;
  readonly parentStageIds?: readonly string[];
}

export interface ToolCompositionSpec {
  readonly compositionId: string;
  readonly workflowId: string;
  readonly sourceRevision: string;
  readonly topology: CompositionTopologyType;
  readonly toolIds: readonly string[];
  readonly toolIdentityDigests: readonly string[];
  readonly stages: readonly CompositionStageSpec[];
  readonly compositionCapabilities: readonly AllowedToolCapability[];
  readonly workspaceScopes: readonly string[];
  readonly repositoryScopes: readonly string[];
  readonly compositionInputSchema: Record<string, unknown>;
  readonly compositionOutputSchema: Record<string, unknown>;
  readonly resourceBudget: CompositionResourceLimits;
  readonly provenanceDigest: string;
  readonly compositionDigest: string;
}

export interface ToolDataTransfer {
  readonly compositionId: string;
  readonly sourceToolId: string;
  readonly destinationToolId: string;
  readonly sourceOutputDigest: string;
  readonly destinationInputDigest: string;
  readonly schemaDigest: string;
  readonly provenanceDigest: string;
  readonly trustLevel: "UNTRUSTED_OBSERVATION";
}

export interface StageExecutionRecord {
  readonly stageId: string;
  readonly sequenceNumber: number;
  readonly toolId: string;
  readonly toolIdentity: string;
  readonly status: "SUCCESS" | "FAILED" | "SKIPPED";
  readonly durationMs: number;
  readonly inputDigest: string;
  readonly outputDigest: string;
  readonly output?: unknown;
  readonly error?: string;
  readonly stageEvidenceDigest: string;
}

export interface CompositionExecutionResult {
  readonly compositionId: string;
  readonly workflowId: string;
  readonly status: CompositionExecutionStatus;
  readonly durationMs: number;
  readonly stagesExecuted: number;
  readonly totalStages: number;
  readonly stageRecords: readonly StageExecutionRecord[];
  readonly transfers: readonly ToolDataTransfer[];
  readonly provenanceRoot: string;
  readonly cumulativeInputBytes: number;
  readonly cumulativeOutputBytes: number;
  readonly cumulativeExecutionMs: number;
  readonly finalOutput?: unknown;
  readonly error?: string;
  readonly authoritative: false; // ALWAYS FALSE
  readonly policyAuthority: false; // ALWAYS FALSE
  readonly terminalAuthority: false; // ALWAYS FALSE
  readonly verificationAuthority: false; // ALWAYS FALSE
  readonly evidenceType: "DYNAMIC_TOOL_COMPOSITION_OBSERVATION";
}

export function computeStageDigest(stage: CompositionStageSpec): string {
  const payload = {
    stageId: stage.stageId,
    sequenceNumber: stage.sequenceNumber,
    toolId: stage.toolId,
    toolVersion: stage.toolVersion,
    toolSourceDigest: stage.toolSourceDigest,
    toolManifestDigest: stage.toolManifestDigest,
    capabilityScope: stage.capabilityScope,
    workspaceScopes: stage.workspaceScopes,
    repositoryScopes: stage.repositoryScopes,
    failurePolicy: stage.failurePolicy,
    timeoutMs: stage.timeoutMs,
  };
  return sha256Hex(canonicalJsonStringify(payload));
}

export function computeCompositionDigest(
  spec: Omit<ToolCompositionSpec, "compositionDigest" | "provenanceDigest">
): string {
  const payload = {
    compositionId: spec.compositionId,
    workflowId: spec.workflowId,
    sourceRevision: spec.sourceRevision,
    topology: spec.topology,
    toolIds: spec.toolIds,
    toolIdentityDigests: spec.toolIdentityDigests,
    stageDigests: spec.stages.map((s) => computeStageDigest(s)),
    compositionCapabilities: spec.compositionCapabilities,
    workspaceScopes: spec.workspaceScopes,
    repositoryScopes: spec.repositoryScopes,
    resourceBudget: spec.resourceBudget,
  };
  return sha256Hex(canonicalJsonStringify(payload));
}

export function computeCompositionProvenanceRoot(stageDigests: readonly string[]): string {
  return sha256Hex(canonicalJsonStringify(stageDigests));
}
