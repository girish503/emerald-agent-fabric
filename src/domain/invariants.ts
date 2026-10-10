import { InvalidContractBindingError, InvalidRunError } from "./errors.js";

export type RunStatus =
  | "CREATED"
  | "QUEUED"
  | "LEASED"
  | "RUNNING"
  | "VERIFYING"
  | "WAITING_APPROVAL"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT"
  | "RECOVERING";

export const TERMINAL_STATES: ReadonlySet<RunStatus> = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);

export function isTerminalState(status: RunStatus): boolean {
  return TERMINAL_STATES.has(status);
}

/**
 * Exact governance/integrity identity binding a Run to a specific MissionContract.
 * (contractId, version, contentHash).
 * Strictly immutable domain value object.
 */
export interface ContractBinding {
  readonly contractId: string;
  readonly version: number;
  readonly contentHash: string;
}

/**
 * Validates a ContractBinding and returns a list of violation messages.
 */
export function getContractBindingViolations(binding: unknown): string[] {
  const violations: string[] = [];

  if (!binding || typeof binding !== "object") {
    return ["contractBinding must be a valid object"];
  }

  const b = binding as Record<string, unknown>;

  if (typeof b.contractId !== "string" || b.contractId.trim().length === 0) {
    violations.push("contractId must be a non-empty string");
  }

  if (typeof b.version !== "number" || !Number.isInteger(b.version) || b.version < 1) {
    violations.push(`version must be an integer >= 1, received ${String(b.version)}`);
  }

  if (typeof b.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(b.contentHash)) {
    violations.push("contentHash must be exactly 64 lowercase hexadecimal characters");
  }

  return violations;
}

/**
 * Validates and freezes an immutable ContractBinding value object.
 * Throws InvalidContractBindingError if validation fails.
 */
export function createContractBinding(binding: ContractBinding): ContractBinding {
  const violations = getContractBindingViolations(binding);
  if (violations.length > 0) {
    throw new InvalidContractBindingError(violations.join("; "), violations);
  }

  return Object.freeze({
    contractId: binding.contractId.trim(),
    version: binding.version,
    contentHash: binding.contentHash,
  });
}

export interface RunSnapshot {
  readonly runId: string;
  readonly taskId: string;
  readonly status: RunStatus;
  readonly version: number;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  readonly idempotencyKey: string | null;
  readonly currentWorkerId: string | null;
  readonly leaseId: string | null;
  readonly leaseExpiresAt: string | null;
  readonly resultPayload: unknown | null;
  readonly errorPayload: unknown | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly contractBinding?: ContractBinding | null;
  readonly maxOutputBytes?: number | null;
}

/**
 * Validates domain invariants for a Run snapshot.
 * Throws InvalidRunError if any invariants are violated.
 */
export function validateRunInvariants(snapshot: RunSnapshot): void {
  const violations: string[] = [];

  if (!snapshot.runId || snapshot.runId.trim().length === 0) {
    violations.push("runId must be a non-empty string");
  }

  if (!snapshot.taskId || snapshot.taskId.trim().length === 0) {
    violations.push("taskId must be a non-empty string");
  }

  if (!Number.isInteger(snapshot.version) || snapshot.version < 1) {
    violations.push(`version must be an integer >= 1, received ${snapshot.version}`);
  }

  if (!Number.isInteger(snapshot.attemptCount) || snapshot.attemptCount < 0) {
    violations.push(`attemptCount must be an integer >= 0, received ${snapshot.attemptCount}`);
  }

  if (!Number.isInteger(snapshot.maxAttempts) || snapshot.maxAttempts < 1) {
    violations.push(`maxAttempts must be an integer >= 1, received ${snapshot.maxAttempts}`);
  }

  if (!Number.isInteger(snapshot.timeoutMs) || snapshot.timeoutMs < 1) {
    violations.push(`timeoutMs must be an integer >= 1, received ${snapshot.timeoutMs}`);
  }

  // Active leased and running states must possess valid worker and lease identifiers
  if (snapshot.status === "LEASED" || snapshot.status === "RUNNING") {
    if (!snapshot.currentWorkerId) {
      violations.push(`State '${snapshot.status}' requires currentWorkerId`);
    }
    if (!snapshot.leaseId) {
      violations.push(`State '${snapshot.status}' requires leaseId`);
    }
    if (!snapshot.leaseExpiresAt) {
      violations.push(`State '${snapshot.status}' requires leaseExpiresAt`);
    }
  }

  // Terminal states must have cleared active lease and worker ownership
  if (isTerminalState(snapshot.status)) {
    if (snapshot.leaseExpiresAt !== null) {
      violations.push(`Terminal state '${snapshot.status}' must have null leaseExpiresAt`);
    }
  }

  // Timestamp ordering
  const created = Date.parse(snapshot.createdAt);
  const updated = Date.parse(snapshot.updatedAt);
  if (Number.isNaN(created)) {
    violations.push("createdAt must be a valid ISO 8601 timestamp");
  }
  if (Number.isNaN(updated)) {
    violations.push("updatedAt must be a valid ISO 8601 timestamp");
  }
  if (!Number.isNaN(created) && !Number.isNaN(updated) && updated < created) {
    violations.push("updatedAt cannot be earlier than createdAt");
  }

  // Contract binding and operational output limit invariants
  const binding = snapshot.contractBinding ?? null;
  const maxOutputBytes = snapshot.maxOutputBytes ?? null;

  if (binding !== null) {
    const bindingViolations = getContractBindingViolations(binding);
    violations.push(...bindingViolations);

    if (
      maxOutputBytes === null ||
      typeof maxOutputBytes !== "number" ||
      !Number.isInteger(maxOutputBytes) ||
      maxOutputBytes < 1
    ) {
      violations.push(
        `Governed Run requires maxOutputBytes to be an integer >= 1, received ${String(maxOutputBytes)}`
      );
    }
  } else {
    if (maxOutputBytes !== null) {
      violations.push("Legacy unbound Run (contractBinding is null) must have null maxOutputBytes");
    }
  }

  if (violations.length > 0) {
    throw new InvalidRunError(snapshot.runId, violations);
  }
}
