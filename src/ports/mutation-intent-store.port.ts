import { DomainEvent } from "../domain/events.js";
import {
  MutationIntent,
  MutationLifecycleStatus,
  PathRollbackProgress,
  PathRollbackStatus,
  RunRollback,
  RunRollbackStatus,
} from "../domain/mutation-intent.js";
import { LeaseFencingCheck, PersistedEvent, SupervisorFencingCheck } from "./state-store.port.js";

export type MutationAuthorityContext =
  | { readonly authority: "WORKER"; readonly fencing: LeaseFencingCheck }
  | { readonly authority: "SUPERVISOR"; readonly supervisorFencing: SupervisorFencingCheck };

export interface TransitionMutationStatusParams {
  readonly mutationId: string;
  readonly fromStatus: MutationLifecycleStatus;
  readonly toStatus: MutationLifecycleStatus;
  readonly event: DomainEvent;
  readonly nextDedupToken: string;
  readonly authorityContext: MutationAuthorityContext;
  readonly conflictDetails?: string | null;
  readonly nowMs?: number;
}

/**
 * MutationIntentStorePort defines the durable persistence contract for workspace
 * mutation intents, run rollbacks, and per-path rollback progress per ADR-0036.
 * Free of filesystem, editor, or recovery-supervisor logic.
 */
export interface MutationIntentStorePort {
  /**
   * Validates that the supervisor lease is the live, ACTIVE, unexpired authority for the run.
   * Throws SupervisorLeaseLostError / SupervisorLeaseExpiredError otherwise. Required so that
   * consumers performing destructive filesystem work can never skip the check.
   */
  validateSupervisorFencing(runId: string, fencing: SupervisorFencingCheck): void;

  /**
   * Persists a newly created mutation intent record.
   * Enforces UNIQUE (run_id, relative_path, path_mutation_version) and
   * UNIQUE (recovery_dedup_token).
   */
  recordIntent(intent: MutationIntent): void;

  /**
   * Retrieves a mutation intent by its unique mutationId.
   */
  getIntent(mutationId: string): MutationIntent | null;

  /**
   * Lists all mutation intents for a run, ordered by path_mutation_version and created_at ascending.
   */
  getIntentsForRun(runId: string): readonly MutationIntent[];

  /**
   * Lists all mutation intents for a specific relative path in a run, ordered by path_mutation_version ASC.
   */
  getIntentsForPath(runId: string, relativePath: string): readonly MutationIntent[];

  /**
   * Retrieves the latest mutation intent for a relative path in a run (highest path_mutation_version).
   */
  getLatestIntentForPath(runId: string, relativePath: string): MutationIntent | null;

  /**
   * Atomically transitions a mutation intent's lifecycle status, updates its current recovery deduplication token,
   * validates worker lease fencing (if supplied), and records the corresponding domain event in a single transaction.
   * If the transaction rolls back or fails, no partial state or orphan event is committed.
   */
  transitionMutationStatus(params: TransitionMutationStatusParams): PersistedEvent;

  /**
   * Atomically records a run rollback record AND initializes all associated path rollback progress rows
   * within a single database transaction. If any path insertion fails, the entire transaction rolls back.
   */
  recordRunRollback(
    rollback: RunRollback,
    pathProgressList: readonly PathRollbackProgress[]
  ): void;

  /**
   * Starts a new rollback generation for a run whose previous rollback COMPLETED: atomically
   * deletes the completed run rollback record and its path progress rows (the reconciled intents
   * and their events remain as the audit trail). Throws unless the record exists and is COMPLETED.
   */
  resetCompletedRunRollback(runId: string): void;

  /**
   * Retrieves the run rollback record for a run.
   */
  getRunRollback(runId: string): RunRollback | null;

  /**
   * Updates the status of a run-level rollback record.
   */
  updateRunRollbackStatus(
    runId: string,
    status: RunRollbackStatus,
    completedAt?: number | null,
    conflictDetails?: string | null
  ): void;

  /**
   * Retrieves the rollback progress record for a specific path in a run.
   */
  getPathRollbackProgress(runId: string, relativePath: string): PathRollbackProgress | null;

  /**
   * Lists all path rollback progress records for a run, ordered by relative_path ascending.
   */
  listPathRollbackProgress(runId: string): readonly PathRollbackProgress[];

  /**
   * Updates the status of a per-path rollback progress record.
   */
  updatePathRollbackProgress(
    runId: string,
    relativePath: string,
    status: PathRollbackStatus,
    errorMessage?: string | null,
    nowMs?: number
  ): void;
}
