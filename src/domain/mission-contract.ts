/**
 * Pure Mission Contract Domain Aggregate for Emerald Agent Fabric.
 *
 * Establishes the immutable governance boundary answering:
 * "What is this mission permitted and required to do?"
 *
 * Core Architectural Guarantees:
 * 1. Spec-Lifecycle Separation:
 *    - The cryptographic identity (contentHash) is computed exclusively from the immutable
 *      governance specification (MissionContractSpec).
 *    - Mutable lifecycle metadata (status, createdAt, activatedAt, revokedAt, revocationReason)
 *      is excluded from the contentHash calculation.
 * 2. Hash Invariance across Lifecycle:
 *    - Transitioning a contract across DRAFT -> ACTIVE -> REVOKED does not alter its contentHash.
 * 3. Deep Immutability:
 *    - All returned domain entities, specs, policies, verification specs, resource limits,
 *      and lifecycle objects are deeply frozen.
 * 4. Autonomous Boundary:
 *    - The Mission Contract defines what the fabric permits and requires.
 *    - It does NOT define agent reasoning, prompts, LLM models, scratchpads, or planning.
 * 5. Provider & Runtime Independence:
 *    - Pure domain aggregate with zero dependency on Docker, SQLite, WorkerRuntime, or network.
 */

import { computeCanonicalHash, isSensitiveKey } from "./canonical-hash.js";
import { InvalidMissionContractError } from "./errors.js";
import { createExecutionPolicy, ExecutionPolicy } from "./policy.js";
import { createVerificationSpec, VerificationSpec } from "./verification.js";

/**
 * Resource governance limits defined by the Mission Contract.
 * Represents the authoritative governance ceiling for executions under this mission.
 */
export interface ResourceLimits {
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly maxOutputBytes: number;
}

export interface CreateResourceLimitsOptions {
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly maxOutputBytes: number;
}

/**
 * Validates and creates an immutable ResourceLimits object.
 */
export function createResourceLimits(options: CreateResourceLimitsOptions): ResourceLimits {
  if (!options || typeof options !== "object") {
    throw new InvalidMissionContractError("ResourceLimits must be a valid object.");
  }

  const { timeoutMs, maxAttempts, maxOutputBytes } = options;

  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new InvalidMissionContractError(
      `Resource limit 'timeoutMs' must be a positive integer, got: ${String(timeoutMs)}`
    );
  }

  if (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    throw new InvalidMissionContractError(
      `Resource limit 'maxAttempts' must be a positive integer, got: ${String(maxAttempts)}`
    );
  }

  if (typeof maxOutputBytes !== "number" || !Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new InvalidMissionContractError(
      `Resource limit 'maxOutputBytes' must be a positive integer, got: ${String(maxOutputBytes)}`
    );
  }

  return Object.freeze({
    timeoutMs,
    maxAttempts,
    maxOutputBytes,
  });
}

/**
 * Immutable governance specification for a mission.
 * This is the exact payload that is canonically hashed to produce contentHash.
 */
export interface MissionContractSpec {
  readonly contractId: string;
  readonly version: number;
  readonly taskId: string;
  readonly policy: ExecutionPolicy;
  readonly verificationSpecs: readonly VerificationSpec[];
  readonly resourceLimits: ResourceLimits;
  readonly credentialScopes?: readonly string[];
}

export interface CreateMissionContractSpecOptions {
  readonly contractId: string;
  readonly version: number;
  readonly taskId: string;
  readonly policy: ExecutionPolicy;
  readonly verificationSpecs?: Iterable<VerificationSpec>;
  readonly resourceLimits: ResourceLimits;
  readonly credentialScopes?: Iterable<string>;
}

/**
 * Recursively asserts that a specification object contains no secret-bearing or sensitive fields.
 * MissionContractSpec is a pure governance envelope and cannot contain raw credentials or secrets.
 *
 * Guarantees that canonical contentHash provides a 1:1 stable integrity identity for the actual
 * governance specification without masking differences through sensitive-key redaction.
 */
function assertNoSensitiveFields(value: unknown, path: string = "spec"): void {
  if (value === null || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertNoSensitiveFields(value[i], `${path}[${i}]`);
    }
    return;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, val] of entries) {
    if (isSensitiveKey(key)) {
      throw new InvalidMissionContractError(
        `MissionContractSpec must not contain raw secrets or sensitive fields (found '${path}.${key}').`
      );
    }
    assertNoSensitiveFields(val, `${path}.${key}`);
  }
}

/**
 * Validates and creates an immutable MissionContractSpec.
 */
export function createMissionContractSpec(
  options: CreateMissionContractSpecOptions
): MissionContractSpec {
  if (!options || typeof options !== "object") {
    throw new InvalidMissionContractError("MissionContractSpec options must be a valid object.");
  }

  assertNoSensitiveFields(options);

  // 1. Identity validation
  if (typeof options.contractId !== "string" || options.contractId.trim().length === 0) {
    throw new InvalidMissionContractError("MissionContractSpec requires a valid non-empty 'contractId'.");
  }
  const contractId = options.contractId.trim();

  if (typeof options.taskId !== "string" || options.taskId.trim().length === 0) {
    throw new InvalidMissionContractError("MissionContractSpec requires a valid non-empty 'taskId'.");
  }
  const taskId = options.taskId.trim();

  if (typeof options.version !== "number" || !Number.isInteger(options.version) || options.version < 1) {
    throw new InvalidMissionContractError(
      `MissionContractSpec 'version' must be an integer >= 1, got: ${String(options.version)}`
    );
  }
  const version = options.version;

  // 2. Policy validation
  if (!options.policy || typeof options.policy !== "object") {
    throw new InvalidMissionContractError("MissionContractSpec requires a valid 'policy' object.");
  }
  const policy = createExecutionPolicy(options.policy);

  // 3. Verification specs validation (empty array permitted for unverified operations)
  const verificationSpecsList: VerificationSpec[] = [];
  if (options.verificationSpecs) {
    for (const vSpec of options.verificationSpecs) {
      verificationSpecsList.push(createVerificationSpec(vSpec));
    }
  }

  // 4. Resource limits validation
  const resourceLimits = createResourceLimits(options.resourceLimits);

  // 5. Credential scopes validation and deterministic canonicalization (Condition 2)
  let credentialScopes: readonly string[] | undefined = undefined;
  if (options.credentialScopes) {
    const scopeSet = new Set<string>();
    for (const scope of options.credentialScopes) {
      if (typeof scope !== "string" || scope.trim().length === 0) {
        throw new InvalidMissionContractError(
          "Credential scopes must contain non-empty string identifiers."
        );
      }
      const trimmed = scope.trim();
      if (/^(bearer\s|ghp_|glpat-|sk-|xox[baprs]-)/i.test(trimmed)) {
        throw new InvalidMissionContractError(
          `Credential scope '${trimmed}' appears to contain a raw token or secret. Only abstract scope identifiers (e.g. 'github:repo:read') are permitted.`
        );
      }
      scopeSet.add(trimmed);
    }
    // Deterministic lexicographical sorting across deduplicated authority identifiers
    credentialScopes = Object.freeze(Array.from(scopeSet).sort());
  }

  const spec: MissionContractSpec = {
    contractId,
    version,
    taskId,
    policy,
    verificationSpecs: Object.freeze(verificationSpecsList),
    resourceLimits,
    ...(credentialScopes !== undefined ? { credentialScopes } : {}),
  };

  // 6. Assert that spec contains zero sensitive fields (Condition 1)
  assertNoSensitiveFields(spec);

  return deepFreeze(spec);
}

export type ContractStatus = "DRAFT" | "ACTIVE" | "REVOKED";

/**
 * Mutable lifecycle metadata for a Mission Contract.
 * Excluded from the cryptographic contentHash.
 */
export interface MissionContractLifecycle {
  readonly status: ContractStatus;
  readonly createdAt: string;
  readonly activatedAt: string | null;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
}

/**
 * Complete Mission Contract Domain Aggregate.
 */
export interface MissionContract {
  readonly spec: MissionContractSpec;
  /**
   * Deterministic SHA-256 digest of the canonical redacted MissionContractSpec.
   * Invariant: Computed EXCLUSIVELY from spec. Lifecycle state is NEVER included.
   */
  readonly contentHash: string;
  readonly lifecycle: MissionContractLifecycle;
}

export interface CreateMissionContractParams {
  readonly contractId?: string;
  readonly version?: number;
  readonly taskId: string;
  readonly policy: ExecutionPolicy;
  readonly verificationSpecs?: Iterable<VerificationSpec>;
  readonly resourceLimits: ResourceLimits;
  readonly credentialScopes?: Iterable<string>;
  readonly status?: ContractStatus;
  readonly createdAt?: string;
  readonly activatedAt?: string | null;
  readonly revokedAt?: string | null;
  readonly revocationReason?: string | null;
}

/**
 * Deep freezes an arbitrary object/array graph.
 */
export function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  if (Object.isFrozen(obj)) {
    return obj;
  }

  const props = Object.getOwnPropertyNames(obj);
  for (const prop of props) {
    const val = (obj as Record<string, unknown>)[prop];
    if (val !== null && typeof val === "object") {
      deepFreeze(val);
    }
  }

  return Object.freeze(obj);
}

/**
 * Validates lifecycle metadata according to status transitions.
 */
function validateLifecycle(lifecycle: MissionContractLifecycle): void {
  if (!lifecycle || typeof lifecycle !== "object") {
    throw new InvalidMissionContractError("Lifecycle must be a valid object.");
  }

  const validStatuses: readonly ContractStatus[] = ["DRAFT", "ACTIVE", "REVOKED"];
  if (!validStatuses.includes(lifecycle.status)) {
    throw new InvalidMissionContractError(`Invalid contract status: '${String(lifecycle.status)}'.`);
  }

  if (!lifecycle.createdAt || typeof lifecycle.createdAt !== "string" || lifecycle.createdAt.trim().length === 0) {
    throw new InvalidMissionContractError("Lifecycle requires a valid non-empty 'createdAt' timestamp.");
  }

  if (lifecycle.status === "ACTIVE" && !lifecycle.activatedAt) {
    throw new InvalidMissionContractError("ACTIVE contract requires a non-null 'activatedAt' timestamp.");
  }

  if (lifecycle.status === "REVOKED" && !lifecycle.revokedAt) {
    throw new InvalidMissionContractError("REVOKED contract requires a non-null 'revokedAt' timestamp.");
  }

  if (lifecycle.status === "DRAFT" && (lifecycle.activatedAt !== null || lifecycle.revokedAt !== null)) {
    throw new InvalidMissionContractError("DRAFT contract cannot have non-null 'activatedAt' or 'revokedAt'.");
  }
}

/**
 * Pure factory creating an immutable MissionContract aggregate.
 */
export function createMissionContract(params: CreateMissionContractParams): MissionContract {
  if (!params || typeof params !== "object") {
    throw new InvalidMissionContractError("MissionContract parameters must be a valid object.");
  }

  const contractId = params.contractId ?? "contract-" + crypto.randomUUID().slice(0, 8);
  const version = params.version ?? 1;

  // 1. Build and validate immutable specification
  const spec = createMissionContractSpec({
    contractId,
    version,
    taskId: params.taskId,
    policy: params.policy,
    verificationSpecs: params.verificationSpecs,
    resourceLimits: params.resourceLimits,
    credentialScopes: params.credentialScopes,
  });

  // 2. Compute canonical content hash strictly over the specification
  // CRITICAL INVARIANT: Lifecycle fields are NEVER passed into computeCanonicalHash.
  const { contentHash } = computeCanonicalHash(spec);

  // 3. Assemble and validate lifecycle metadata
  const status: ContractStatus = params.status ?? "DRAFT";
  const createdAt = params.createdAt ?? new Date().toISOString();

  let activatedAt: string | null = null;
  if (status === "ACTIVE") {
    activatedAt = params.activatedAt ?? createdAt;
  } else if (status === "REVOKED") {
    activatedAt = params.activatedAt ?? null;
  }

  let revokedAt: string | null = null;
  let revocationReason: string | null = null;
  if (status === "REVOKED") {
    revokedAt = params.revokedAt ?? createdAt;
    revocationReason = params.revocationReason ?? null;
  }

  const lifecycle: MissionContractLifecycle = {
    status,
    createdAt,
    activatedAt,
    revokedAt,
    revocationReason,
  };

  validateLifecycle(lifecycle);

  const contract: MissionContract = {
    spec,
    contentHash,
    lifecycle,
  };

  return deepFreeze(contract);
}

/**
 * Pure domain transition helper: DRAFT -> ACTIVE.
 * Returns a new immutable MissionContract preserving identical spec and contentHash.
 */
export function activateMissionContract(
  contract: MissionContract,
  activatedAt?: string
): MissionContract {
  if (!contract || typeof contract !== "object") {
    throw new InvalidMissionContractError("Contract must be a valid MissionContract object.");
  }

  if (contract.lifecycle.status !== "DRAFT") {
    throw new InvalidMissionContractError(
      `Cannot activate contract '${contract.spec.contractId}' in status '${contract.lifecycle.status}'. Only DRAFT contracts can be activated.`
    );
  }

  const now = activatedAt ?? new Date().toISOString();

  const activatedLifecycle: MissionContractLifecycle = {
    status: "ACTIVE",
    createdAt: contract.lifecycle.createdAt,
    activatedAt: now,
    revokedAt: null,
    revocationReason: null,
  };

  validateLifecycle(activatedLifecycle);

  // Invariant: spec and contentHash are preserved exactly
  return deepFreeze({
    spec: contract.spec,
    contentHash: contract.contentHash,
    lifecycle: activatedLifecycle,
  });
}

/**
 * Pure domain transition helper: ACTIVE -> REVOKED.
 * Returns a new immutable MissionContract preserving identical spec and contentHash.
 */
export function revokeMissionContract(
  contract: MissionContract,
  reason?: string,
  revokedAt?: string
): MissionContract {
  if (!contract || typeof contract !== "object") {
    throw new InvalidMissionContractError("Contract must be a valid MissionContract object.");
  }

  if (contract.lifecycle.status !== "ACTIVE") {
    throw new InvalidMissionContractError(
      `Cannot revoke contract '${contract.spec.contractId}' in status '${contract.lifecycle.status}'. Only ACTIVE contracts can be revoked.`
    );
  }

  const now = revokedAt ?? new Date().toISOString();

  const revokedLifecycle: MissionContractLifecycle = {
    status: "REVOKED",
    createdAt: contract.lifecycle.createdAt,
    activatedAt: contract.lifecycle.activatedAt,
    revokedAt: now,
    revocationReason: reason ?? null,
  };

  validateLifecycle(revokedLifecycle);

  // Invariant: spec and contentHash are preserved exactly
  return deepFreeze({
    spec: contract.spec,
    contentHash: contract.contentHash,
    lifecycle: revokedLifecycle,
  });
}

/**
 * Reconstitutes an existing MissionContract from persisted storage components.
 * Performs fail-closed content integrity verification against expectedContentHash.
 */
export function reconstituteMissionContract(
  spec: MissionContractSpec,
  expectedContentHash: string,
  lifecycle: MissionContractLifecycle
): MissionContract {
  const validatedSpec = createMissionContractSpec(spec);
  const { contentHash: actualHash } = computeCanonicalHash(validatedSpec);

  if (actualHash.toLowerCase() !== expectedContentHash.toLowerCase()) {
    throw new InvalidMissionContractError(
      `Content hash mismatch for contract '${spec.contractId}' version ${spec.version}: expected '${expectedContentHash}', computed '${actualHash}'`
    );
  }

  validateLifecycle(lifecycle);

  return deepFreeze({
    spec: validatedSpec,
    contentHash: actualHash,
    lifecycle: { ...lifecycle },
  });
}
