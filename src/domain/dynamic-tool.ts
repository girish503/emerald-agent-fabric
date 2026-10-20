/**
 * Phase 86 — Governed Dynamic Tool Synthesis and Runtime Capability Extension
 *
 * Domain types, lifecycle models, capability vocabularies, and cryptographic
 * identity primitives for dynamically synthesized analysis tools.
 *
 * CENTRAL ARCHITECTURAL INVARIANT:
 * "An agent may synthesize computation. Emerald alone governs capability, execution, evidence, and authority."
 * "effectiveToolAuthority ⊆ declaredToolAuthority AND effectiveToolAuthority ⊆ parentWorkflowAuthority."
 * "Dynamic tools possess ZERO terminal authority, ZERO policy authority, and ZERO verification authority."
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";

export type ToolLifecycleState =
  | "DRAFT"
  | "PROPOSED"
  | "VALIDATING"
  | "AUTHORIZED_FOR_EXECUTION"
  | "REGISTERED"
  | "EXECUTING"
  | "SUCCEEDED"
  | "FAILED"
  | "REVOKED"
  | "EXPIRED"
  | "QUARANTINED";

export type AllowedToolCapability =
  | "READ_WORKSPACE"
  | "READ_REPOSITORY"
  | "READ_AST"
  | "READ_DEPENDENCY_GRAPH"
  | "READ_TEST_METADATA"
  | "WRITE_TEMPORARY_OUTPUT"
  | "EXECUTE_ANALYSIS";

export type ForbiddenToolCapability =
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

export type ToolCapability = AllowedToolCapability | ForbiddenToolCapability;

export const ALLOWED_TOOL_CAPABILITIES: readonly AllowedToolCapability[] = [
  "READ_WORKSPACE",
  "READ_REPOSITORY",
  "READ_AST",
  "READ_DEPENDENCY_GRAPH",
  "READ_TEST_METADATA",
  "WRITE_TEMPORARY_OUTPUT",
  "EXECUTE_ANALYSIS",
] as const;

export const FORBIDDEN_TOOL_CAPABILITIES: readonly ForbiddenToolCapability[] = [
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

export interface DynamicToolResourceLimits {
  readonly maxSourceBytes: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxExecutionMs: number;
  readonly maxMemoryBytes: number;
  readonly maxCPU: number;
  readonly maxPids: number;
  readonly maxTemporaryBytes: number;
  readonly maxToolInvocationsPerWorkflow: number;
  readonly maxDynamicToolsPerWorkflow: number;
  readonly maxDependencyModules: number;
  readonly maxParallelDynamicTools: number;
}

export const DEFAULT_DYNAMIC_TOOL_BUDGETS: DynamicToolResourceLimits = {
  maxSourceBytes: 64 * 1024, // 64 KB
  maxInputBytes: 64 * 1024, // 64 KB
  maxOutputBytes: 1024 * 1024, // 1 MB
  maxExecutionMs: 30000, // 30 seconds
  maxMemoryBytes: 256 * 1024 * 1024, // 256 MB
  maxCPU: 0.5,
  maxPids: 32,
  maxTemporaryBytes: 16 * 1024 * 1024, // 16 MB
  maxToolInvocationsPerWorkflow: 8,
  maxDynamicToolsPerWorkflow: 4,
  maxDependencyModules: 32,
  maxParallelDynamicTools: 1,
};

export type DynamicToolClass =
  | "AST_ANALYZER"
  | "DEPENDENCY_ANALYZER"
  | "API_COMPATIBILITY_CHECKER"
  | "SCHEMA_COMPARATOR"
  | "CONFIGURATION_ANALYZER"
  | "TEST_IMPACT_ANALYZER"
  | "CROSS_REPO_CONTRACT_CHECKER"
  | "MIGRATION_IMPACT_ANALYZER";

export type ToolProvenanceCondition =
  | "CONDITION_A_STATIC_BUILTIN"
  | "CONDITION_B_HUMAN_SYNTHESIZED"
  | "CONDITION_C_MODEL_SYNTHESIZED"
  | "CONDITION_D_MODEL_HUMAN_REVISED";

export interface DynamicToolSpec {
  readonly toolId: string;
  readonly toolVersion: string;
  readonly toolName: string;
  readonly toolClass: DynamicToolClass;
  readonly description: string;
  readonly sourceDigest: string;
  readonly manifestDigest: string;
  readonly runtimeDigest: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  readonly capabilitySet: readonly ToolCapability[];
  readonly workspaceScopes: readonly string[];
  readonly repositoryScopes: readonly string[];
  readonly resourceLimits: DynamicToolResourceLimits;
  readonly networkPolicy: "DENY_ALL";
  readonly credentialScopes: readonly string[];
  readonly deterministicExpectation: boolean;
  readonly creatorIdentity: string;
  readonly creationWorkflowId: string;
  readonly provenanceCondition: ToolProvenanceCondition;
}

export interface DynamicToolManifest {
  readonly toolId: string;
  readonly toolVersion: string;
  readonly toolName: string;
  readonly toolClass: DynamicToolClass;
  readonly sourceDigest: string;
  readonly runtimeDigest: string;
  readonly inputSchemaDigest: string;
  readonly outputSchemaDigest: string;
  readonly capabilityDigest: string;
  readonly resourceLimitDigest: string;
  readonly workspaceScopeDigest: string;
  readonly repositoryScopeDigest: string;
  readonly networkPolicy: "DENY_ALL";
  readonly credentialScopes: readonly string[];
}

export interface DynamicToolProposal {
  readonly proposalId: string;
  readonly workflowId: string;
  readonly creatorIdentity: string;
  readonly toolName: string;
  readonly toolClass: DynamicToolClass;
  readonly description: string;
  readonly sourceCode: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  readonly requestedCapabilities: readonly ToolCapability[];
  readonly workspaceScopes: readonly string[];
  readonly repositoryScopes: readonly string[];
  readonly provenanceCondition: ToolProvenanceCondition;
  readonly customResourceLimits?: Partial<DynamicToolResourceLimits>;
}

export interface DynamicToolExecutionResult {
  readonly executionId: string;
  readonly toolId: string;
  readonly toolIdentity: string;
  readonly workflowId: string;
  readonly status: "SUCCESS" | "FAILED" | "TIMEOUT" | "SECURITY_DENIED" | "SCHEMA_ERROR";
  readonly durationMs: number;
  readonly exitCode: number;
  readonly inputDigest: string;
  readonly outputDigest: string;
  readonly output?: unknown;
  readonly error?: string;
  readonly authoritative: false; // ALWAYS FALSE
  readonly policyAuthority: false; // ALWAYS FALSE
  readonly terminalAuthority: false; // ALWAYS FALSE
  readonly verificationAuthority: false; // ALWAYS FALSE
  readonly evidenceType: "DYNAMIC_TOOL_OBSERVATION";
}

export interface ToolAuthorityEnvelope {
  readonly toolId: string;
  readonly declaredCapabilities: readonly ToolCapability[];
  readonly effectiveCapabilities: readonly AllowedToolCapability[];
  readonly allowsPolicyModification: false;
  readonly allowsTerminalAuthority: false;
  readonly allowsVerificationAuthority: false;
  readonly allowsEvidenceSigning: false;
  readonly allowsProcessSpawning: false;
  readonly allowsNetworkAccess: false;
  readonly allowsDockerSocket: false;
  readonly allowsCredentialAccess: false;
}

export function computeToolSourceDigest(sourceCode: string): string {
  return sha256Hex(sourceCode);
}

export function computeToolManifestDigest(manifest: DynamicToolManifest): string {
  return sha256Hex(canonicalJsonStringify(manifest));
}

export function computeDynamicToolIdentity(spec: DynamicToolSpec): string {
  const identityPayload = {
    toolId: spec.toolId,
    toolVersion: spec.toolVersion,
    toolClass: spec.toolClass,
    sourceDigest: spec.sourceDigest,
    manifestDigest: spec.manifestDigest,
    runtimeDigest: spec.runtimeDigest,
    capabilitySet: spec.capabilitySet,
    workspaceScopes: spec.workspaceScopes,
    repositoryScopes: spec.repositoryScopes,
    networkPolicy: spec.networkPolicy,
    credentialScopes: spec.credentialScopes,
  };
  return sha256Hex(canonicalJsonStringify(identityPayload));
}

export function computeToolInputDigest(input: unknown): string {
  return sha256Hex(canonicalJsonStringify(input));
}

export function computeToolOutputDigest(output: unknown): string {
  return sha256Hex(canonicalJsonStringify(output));
}

export function isForbiddenCapability(capability: string): capability is ForbiddenToolCapability {
  return (FORBIDDEN_TOOL_CAPABILITIES as readonly string[]).includes(capability);
}

export function isAllowedCapability(capability: string): capability is AllowedToolCapability {
  return (ALLOWED_TOOL_CAPABILITIES as readonly string[]).includes(capability);
}
