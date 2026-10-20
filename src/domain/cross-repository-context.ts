/**
 * Phase 85 — Governed Cross-Repository Context Propagation and Multi-Project Repair Verification
 *
 * Domain types and canonical data models for cross-repository identity,
 * dependency graphs, contracts, context propagation, multi-repository repair plans,
 * and logical atomicity evidence.
 *
 * CENTRAL ARCHITECTURAL PRINCIPLE:
 * "Repositories may coordinate through explicit contracts and evidence.
 *  They must never share authority implicitly."
 * "terminalSuccessCount(workflowId) <= 1 across all participating repositories."
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";

export type DependencyKind =
  | "PACKAGE"
  | "API"
  | "SCHEMA"
  | "PROTOCOL"
  | "GENERATED_ARTIFACT"
  | "CLI_CONTRACT"
  | "CONFIGURATION"
  | "SHARED_TYPE";

export type ContractKind =
  | "API_SIGNATURE"
  | "TYPE_DEFINITION"
  | "SCHEMA_DEFINITION"
  | "SERIALIZATION_FORMAT"
  | "ERROR_CONTRACT"
  | "STATE_PROTOCOL"
  | "GENERATED_ARTIFACT"
  | "CONFIGURATION_CONTRACT";

export type CrossRepositoryInvariantClass =
  | "API_SIGNATURE_COMPATIBILITY"
  | "TYPE_COMPATIBILITY"
  | "SCHEMA_COMPATIBILITY"
  | "VERSION_COMPATIBILITY"
  | "SERIALIZATION_COMPATIBILITY"
  | "ERROR_CONTRACT_COMPATIBILITY"
  | "STATE_PROTOCOL_COMPATIBILITY"
  | "PRODUCER_CONSUMER_COMPATIBILITY"
  | "GENERATED_ARTIFACT_COMPATIBILITY"
  | "CONFIGURATION_COMPATIBILITY";

export type CrossRepositoryFailureCode =
  | "REPOSITORY_IDENTITY_FAILURE"
  | "DEPENDENCY_RESOLUTION_FAILURE"
  | "CONTRACT_EXTRACTION_FAILURE"
  | "CONTRACT_CONFLICT"
  | "CONTRACT_UNRESOLVED"
  | "VERSION_MISMATCH"
  | "SOURCE_REVISION_MISMATCH"
  | "CROSS_REPOSITORY_SCOPE_VIOLATION"
  | "PARTIAL_REPAIR"
  | "PRODUCER_REPAIR_FAILURE"
  | "CONSUMER_REPAIR_FAILURE"
  | "CROSS_REPOSITORY_VERIFICATION_FAILURE"
  | "EVIDENCE_COMPOSITION_FAILURE"
  | "TERMINAL_AUTHORITY_FAILURE"
  | "CROSS_REPOSITORY_TIMEOUT"
  | "CROSS_REPOSITORY_CANCELLED"
  | "CROSS_REPOSITORY_CONTRACT_STALE"
  | "DEPENDENCY_CONTEXT_UNAVAILABLE"
  | "UNKNOWN";

export type ContractCompatibilityStatus = "COMPATIBLE" | "INCOMPATIBLE" | "UNRESOLVED";

export type CrossRepositoryCondition =
  | "CONDITION_A_LOCAL_CONTROL"
  | "CONDITION_B_CONTRACT_CONTEXT"
  | "CONDITION_C_GOVERNED_COORDINATION"
  | "CONDITION_D_FULL_CLEAN_ROOM";

export interface RepositoryIdentity {
  readonly repositoryId: string;
  readonly canonicalRootDigest: string;
  readonly sourceRevision: string;
  readonly defaultBranchIdentity?: string;
  readonly repositoryManifestDigest: string;
  readonly dependencyManifestDigest: string;
}

export interface RepositoryDependencyEdge {
  readonly edgeId: string;
  readonly producerRepositoryId: string;
  readonly consumerRepositoryId: string;
  readonly dependencyKind: DependencyKind;
  readonly dependencyIdentifier: string;
  readonly declaredVersion: string;
  readonly resolvedVersion: string;
  readonly sourceRevision: string;
  readonly contractDigest: string;
  readonly resolutionEvidenceDigest: string;
}

export interface ContractProvenance {
  readonly sourceFile: string;
  readonly extractedAt: string;
  readonly extractor: string;
  readonly evidenceDigest: string;
}

export interface CrossRepositoryContract {
  readonly contractId: string;
  readonly producerRepositoryId: string;
  readonly consumerRepositoryId: string;
  readonly contractKind: ContractKind | string;
  readonly producerRevision: string;
  readonly consumerRevision: string;
  readonly representation: string;
  readonly preconditions: readonly string[];
  readonly postconditions: readonly string[];
  readonly compatibilityRules: readonly string[];
  readonly contractDigest: string;
  readonly provenance: ContractProvenance;
}

export interface MultiRepositoryRepairUnit {
  readonly unitId: string;
  readonly repositoryId: string;
  readonly targetRevision: string;
  readonly rationale: string;
  readonly contractId: string;
  readonly patchDigest: string;
  readonly status: "PENDING" | "APPLIED" | "FAILED" | "ROLLED_BACK";
}

export interface MultiRepositoryVerificationPlan {
  readonly repositoryVerificationSuites: Record<string, readonly string[]>;
  readonly crossRepositoryContractSuites: readonly string[];
  readonly requiredSuitesRan: number;
}

export interface MultiRepositoryRepairPlan {
  readonly planId: string;
  readonly workflowId: string;
  readonly repositories: readonly string[];
  readonly repositoryRevisions: Record<string, string>;
  readonly contractDependencies: readonly string[];
  readonly repairUnits: readonly MultiRepositoryRepairUnit[];
  readonly crossRepositoryInvariants: readonly CrossRepositoryInvariantClass[];
  readonly verificationPlan: MultiRepositoryVerificationPlan;
  readonly planDigest: string;
}

export interface RepositoryLocalVerificationResult {
  readonly repositoryId: string;
  readonly f2pPassed: boolean;
  readonly p2pPassed: boolean;
  readonly suitesRan: number;
  readonly exitCode: number;
  readonly verificationDigest: string;
}

export interface CrossRepositoryVerificationResult {
  readonly contractPassed: boolean;
  readonly compatibilityVerified: boolean;
  readonly suitesRan: number;
  readonly exitCode: number;
  readonly crossRepoVerificationDigest: string;
}

export interface CrossRepositoryEvidence {
  readonly workflowId: string;
  readonly planId: string;
  readonly repositoryIdentities: readonly RepositoryIdentity[];
  readonly exactRevisions: Record<string, string>;
  readonly dependencyEdges: readonly RepositoryDependencyEdge[];
  readonly contractDigests: readonly string[];
  readonly candidatePatchDigests: Record<string, string>;
  readonly repositoryLocalVerificationResults: Record<string, RepositoryLocalVerificationResult>;
  readonly crossRepositoryVerificationResult: CrossRepositoryVerificationResult;
  readonly provenanceRoot: string;
  readonly terminalRecordAccepted: boolean;
  readonly evidenceDigest: string;
}

export interface CrossRepositoryResourceBudgets {
  readonly maxRepositoriesPerTask: number;
  readonly maxDependencyDepth: number;
  readonly maxDependencyEdges: number;
  readonly maxContractCount: number;
  readonly maxContextBytes: number;
  readonly maxTotalCrossRepositoryContext: number;
  readonly maxParallelRepositories: number;
  readonly maxVerificationCommands: number;
}

export const DEFAULT_CROSS_REPO_BUDGETS: CrossRepositoryResourceBudgets = {
  maxRepositoriesPerTask: 5,
  maxDependencyDepth: 4,
  maxDependencyEdges: 8,
  maxContractCount: 16,
  maxContextBytes: 32 * 1024, // 32KB per repository
  maxTotalCrossRepositoryContext: 128 * 1024, // 128KB total
  maxParallelRepositories: 2,
  maxVerificationCommands: 32,
};

/**
 * Computes canonical digest for a RepositoryIdentity.
 */
export function computeRepositoryIdentityDigest(
  repo: Omit<RepositoryIdentity, "canonicalRootDigest"> | RepositoryIdentity
): string {
  const payload = {
    repositoryId: repo.repositoryId,
    sourceRevision: repo.sourceRevision,
    defaultBranchIdentity: repo.defaultBranchIdentity ?? "main",
    repositoryManifestDigest: repo.repositoryManifestDigest,
    dependencyManifestDigest: repo.dependencyManifestDigest,
  };
  return sha256Hex(canonicalJsonStringify(payload));
}

/**
 * Computes canonical digest for a RepositoryDependencyEdge.
 */
export function computeDependencyEdgeDigest(
  edge: Omit<RepositoryDependencyEdge, "resolutionEvidenceDigest"> | RepositoryDependencyEdge
): string {
  const payload = {
    edgeId: edge.edgeId,
    producerRepositoryId: edge.producerRepositoryId,
    consumerRepositoryId: edge.consumerRepositoryId,
    dependencyKind: edge.dependencyKind,
    dependencyIdentifier: edge.dependencyIdentifier,
    declaredVersion: edge.declaredVersion,
    resolvedVersion: edge.resolvedVersion,
    sourceRevision: edge.sourceRevision,
    contractDigest: edge.contractDigest,
  };
  return sha256Hex(canonicalJsonStringify(payload));
}

/**
 * Computes canonical digest for a CrossRepositoryContract.
 */
export function computeContractDigest(
  contract: Omit<CrossRepositoryContract, "contractDigest">
): string {
  const payload = {
    contractId: contract.contractId,
    producerRepositoryId: contract.producerRepositoryId,
    consumerRepositoryId: contract.consumerRepositoryId,
    contractKind: contract.contractKind,
    producerRevision: contract.producerRevision,
    consumerRevision: contract.consumerRevision,
    representation: contract.representation,
    preconditions: [...contract.preconditions].sort(),
    postconditions: [...contract.postconditions].sort(),
    compatibilityRules: [...contract.compatibilityRules].sort(),
    provenance: {
      sourceFile: contract.provenance.sourceFile,
      extractor: contract.provenance.extractor,
    },
  };
  return sha256Hex(canonicalJsonStringify(payload));
}

/**
 * Computes canonical digest for a MultiRepositoryRepairPlan.
 */
export function computeMultiRepoPlanDigest(
  plan: Omit<MultiRepositoryRepairPlan, "planDigest">
): string {
  const payload = {
    planId: plan.planId,
    workflowId: plan.workflowId,
    repositories: [...plan.repositories].sort(),
    repositoryRevisions: plan.repositoryRevisions,
    contractDependencies: [...plan.contractDependencies].sort(),
    repairUnits: plan.repairUnits.map((u) => ({
      unitId: u.unitId,
      repositoryId: u.repositoryId,
      targetRevision: u.targetRevision,
      contractId: u.contractId,
      patchDigest: u.patchDigest,
    })),
    crossRepositoryInvariants: [...plan.crossRepositoryInvariants].sort(),
    verificationPlan: {
      repositoryVerificationSuites: plan.verificationPlan.repositoryVerificationSuites,
      crossRepositoryContractSuites: [...plan.verificationPlan.crossRepositoryContractSuites].sort(),
      requiredSuitesRan: plan.verificationPlan.requiredSuitesRan,
    },
  };
  return sha256Hex(canonicalJsonStringify(payload));
}

/**
 * Computes canonical digest for CrossRepositoryEvidence.
 */
export function computeCrossRepoEvidenceDigest(
  evidence: Omit<CrossRepositoryEvidence, "evidenceDigest">
): string {
  const payload = {
    workflowId: evidence.workflowId,
    planId: evidence.planId,
    repositoryIdentities: evidence.repositoryIdentities.map((r) => r.repositoryId).sort(),
    exactRevisions: evidence.exactRevisions,
    contractDigests: [...evidence.contractDigests].sort(),
    candidatePatchDigests: evidence.candidatePatchDigests,
    repositoryLocalVerificationResults: evidence.repositoryLocalVerificationResults,
    crossRepositoryVerificationResult: evidence.crossRepositoryVerificationResult,
    provenanceRoot: evidence.provenanceRoot,
    terminalRecordAccepted: evidence.terminalRecordAccepted,
  };
  return sha256Hex(canonicalJsonStringify(payload));
}
