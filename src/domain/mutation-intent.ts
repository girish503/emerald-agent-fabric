import { createHash } from "node:crypto";

/**
 * Mutation Intent Lifecycle States per ADR-0036 Section 2.1.
 */
export type MutationLifecycleStatus =
  | "RECORDED"
  | "SNAPSHOT_WRITTEN"
  | "APPLYING_MUTATION"
  | "COMMITTED"
  | "ROLLING_BACK"
  | "ROLLED_BACK"
  | "VERIFIED_PASS"
  | "ROLLBACK_CONFLICT_LOST_UPDATE"
  | "ROLLBACK_CONFLICT_HASH_MISMATCH"
  | "ABORTED_UNMUTATED"
  | "RESTORE_FAILED";

/**
 * Terminal Mutation Statuses. No further state transitions are permitted once reached.
 */
export const TERMINAL_MUTATION_STATUSES: readonly MutationLifecycleStatus[] = Object.freeze([
  "VERIFIED_PASS",
  "ROLLED_BACK",
  "ROLLBACK_CONFLICT_LOST_UPDATE",
  "ROLLBACK_CONFLICT_HASH_MISMATCH",
  "ABORTED_UNMUTATED",
  "RESTORE_FAILED",
]);

/**
 * Run-Level Rollback States per ADR-0036 Section 3.2.
 */
export type RunRollbackStatus =
  | "IDLE"
  | "RESTORING_PATHS"
  | "COMPLETED"
  | "PARTIALLY_ROLLED_BACK_CONFLICT"
  | "FAILED";

/**
 * Per-Path Rollback Progress States per ADR-0036 Section 3.2.
 */
export type PathRollbackStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "RESTORED"
  | "CONFLICT_SKIPPED"
  | "RESTORE_FAILED";

/**
 * Mutation Intent entity representation per ADR-0036 Section 2.2.
 */
export interface MutationIntent {
  readonly mutationId: string;
  readonly runId: string;
  readonly workerLeaseId: string;
  readonly relativePath: string;
  readonly canonicalPath: string;
  readonly parentMutationId: string | null;
  readonly pathMutationVersion: number;
  readonly baseDigest: string; // 64-char hex SHA-256 or 'ABSENT'
  readonly expectedResultingDigest: string; // 64-char hex SHA-256
  readonly snapshotRef: string;
  readonly recoveryDedupToken: string;
  readonly lifecycleStatus: MutationLifecycleStatus;
  readonly createdAt: number; // Epoch milliseconds
  readonly updatedAt: number; // Epoch milliseconds
  readonly conflictDetails?: string | null;
}

/**
 * Run Rollback Aggregate entity representation per ADR-0036 Section 3.2.
 */
export interface RunRollback {
  readonly runId: string;
  readonly status: RunRollbackStatus;
  readonly initiatedBy: string;
  readonly createdAt: number;
  readonly completedAt?: number | null;
  readonly conflictDetails?: string | null;
}

/**
 * Path Rollback Progress entity representation per ADR-0036 Section 3.2.
 */
export interface PathRollbackProgress {
  readonly runId: string;
  readonly relativePath: string;
  readonly status: PathRollbackStatus;
  readonly initialBaseDigest: string; // D_0
  readonly latestExpectedDigest: string; // Current expected digest on disk
  readonly baselineSnapshotRef: string; // S_0
  readonly updatedAt: number;
  readonly errorMessage?: string | null;
}

/**
 * Permitted lifecycle transitions matrix per ADR-0036 Section 2.1 and Section 4.
 */
const LEGAL_MUTATION_TRANSITIONS: Record<MutationLifecycleStatus, readonly MutationLifecycleStatus[]> = Object.freeze({
  RECORDED: Object.freeze<readonly MutationLifecycleStatus[]>(["SNAPSHOT_WRITTEN", "ABORTED_UNMUTATED"]),
  SNAPSHOT_WRITTEN: Object.freeze<readonly MutationLifecycleStatus[]>(["APPLYING_MUTATION", "ABORTED_UNMUTATED"]),
  APPLYING_MUTATION: Object.freeze<readonly MutationLifecycleStatus[]>([
    "COMMITTED",
    "ROLLING_BACK",
    "ROLLED_BACK",
    "ABORTED_UNMUTATED",
    "ROLLBACK_CONFLICT_LOST_UPDATE",
  ]),
  COMMITTED: Object.freeze<readonly MutationLifecycleStatus[]>([
    "VERIFIED_PASS",
    "ROLLING_BACK",
    "ROLLED_BACK",
    "ROLLBACK_CONFLICT_LOST_UPDATE",
    "ROLLBACK_CONFLICT_HASH_MISMATCH",
  ]),
  ROLLING_BACK: Object.freeze<readonly MutationLifecycleStatus[]>([
    "ROLLED_BACK",
    "ROLLBACK_CONFLICT_LOST_UPDATE",
    "ROLLBACK_CONFLICT_HASH_MISMATCH",
    "RESTORE_FAILED",
  ]),
  ROLLED_BACK: Object.freeze<readonly MutationLifecycleStatus[]>([]),
  // A verified mutation belongs to a run attempt that has not completed if recovery is running;
  // the supervisor may still roll it back (workers cannot: ROLLED_BACK is not in their allowed set).
  VERIFIED_PASS: Object.freeze<readonly MutationLifecycleStatus[]>(["ROLLED_BACK"]),
  ROLLBACK_CONFLICT_LOST_UPDATE: Object.freeze<readonly MutationLifecycleStatus[]>([]),
  ROLLBACK_CONFLICT_HASH_MISMATCH: Object.freeze<readonly MutationLifecycleStatus[]>([]),
  ABORTED_UNMUTATED: Object.freeze<readonly MutationLifecycleStatus[]>([]),
  RESTORE_FAILED: Object.freeze<readonly MutationLifecycleStatus[]>([]),
});

/**
 * Checks whether a lifecycle transition from one status to another is legal.
 */
export function isLegalMutationTransition(
  from: MutationLifecycleStatus,
  to: MutationLifecycleStatus
): boolean {
  const allowed = LEGAL_MUTATION_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/**
 * Checks whether a mutation lifecycle status is terminal.
 */
export function isTerminalMutationStatus(status: MutationLifecycleStatus): boolean {
  return TERMINAL_MUTATION_STATUSES.includes(status);
}

/**
 * True when crash recovery must still reconcile the mutation: every non-terminal status, plus
 * VERIFIED_PASS (terminal for editing purposes, but its file change belongs to an attempt that
 * crashed before the run completed and so must not survive a retry).
 */
export function isRollbackPendingStatus(status: MutationLifecycleStatus): boolean {
  return !isTerminalMutationStatus(status) || status === "VERIFIED_PASS";
}

/**
 * Computes deterministic recovery deduplication token per ADR-0036 Section 6.1:
 * SHA-256(run_id + ":" + mutation_id + ":" + target_state)
 */
export function computeRecoveryDedupToken(
  runId: string,
  mutationId: string,
  targetLifecycleStatus: MutationLifecycleStatus
): string {
  return createHash("sha256")
    .update(`${runId}:${mutationId}:${targetLifecycleStatus}`, "utf8")
    .digest("hex");
}

/**
 * Validates fundamental structural invariants for a MutationIntent.
 */
export function validateMutationIntentInvariants(intent: MutationIntent): void {
  if (!intent.mutationId || typeof intent.mutationId !== "string") {
    throw new Error("Invalid mutationId: must be non-empty string");
  }
  if (!intent.runId || typeof intent.runId !== "string") {
    throw new Error("Invalid runId: must be non-empty string");
  }
  if (!intent.workerLeaseId || typeof intent.workerLeaseId !== "string") {
    throw new Error("Invalid workerLeaseId: must be non-empty string");
  }
  if (!intent.relativePath || typeof intent.relativePath !== "string") {
    throw new Error("Invalid relativePath: must be non-empty string");
  }
  if (!Number.isInteger(intent.pathMutationVersion) || intent.pathMutationVersion < 1) {
    throw new Error(`Invalid pathMutationVersion: expected integer >= 1, got ${intent.pathMutationVersion}`);
  }
  if (intent.pathMutationVersion === 1 && intent.parentMutationId !== null) {
    throw new Error("Invariant violation: root mutation (version 1) must have parentMutationId = null");
  }
  if (intent.pathMutationVersion > 1 && !intent.parentMutationId) {
    throw new Error("Invariant violation: chained mutation (version > 1) must have non-null parentMutationId");
  }
  const isHex64 = (s: string) => /^[0-9a-fA-F]{64}$/.test(s);
  if (intent.baseDigest !== "ABSENT" && !isHex64(intent.baseDigest)) {
    throw new Error(`Invalid baseDigest: expected 64 hex characters or 'ABSENT', got '${intent.baseDigest}'`);
  }
  if (!isHex64(intent.expectedResultingDigest)) {
    throw new Error(`Invalid expectedResultingDigest: expected 64 hex characters, got '${intent.expectedResultingDigest}'`);
  }
  if (!isHex64(intent.recoveryDedupToken)) {
    throw new Error(`Invalid recoveryDedupToken: expected 64 hex characters, got '${intent.recoveryDedupToken}'`);
  }
}
