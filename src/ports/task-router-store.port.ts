/**
 * Task Router storage port (Milestone 2.17).
 *
 * Durable parent/child task relations and idempotent router submissions. These are
 * transaction-scoped operations: they share the same SQLite transaction as run state so
 * that admission decisions (count in-flight runs + queue a run) are atomic.
 *
 * The router never stores derived status. Status is always computed from `runs`.
 */

export interface TaskRelationRecord {
  readonly childTaskId: string;
  readonly parentTaskId: string;
  /** Distance from the root task (child of a root has depth 1). */
  readonly depth: number;
  /** Zero-based submission order among siblings; part of the deterministic dispatch order. */
  readonly ordinal: number;
  readonly createdAt: string;
}

export interface TaskDependencyRecord {
  readonly childTaskId: string;
  readonly parentTaskId: string;
  readonly ordinal: number;
  readonly createdAt: string;
}

export interface RouterSubmissionRecord {
  readonly submissionKey: string;
  readonly taskId: string;
  readonly runId: string;
  /** Canonical hash of the submission request; the same key with a different hash is a conflict. */
  readonly requestHash: string;
  readonly createdAt: string;
}

export interface DispatchCandidateRecord {
  readonly taskId: string;
  readonly runId: string;
  readonly parentTaskId: string | null;
  readonly depth: number;
  readonly ordinal: number;
  readonly submittedAt: string;
}

export interface TaskRouterStorePort {
  insertTaskRelation(relation: TaskRelationRecord): void;
  getTaskRelation(childTaskId: string): TaskRelationRecord | null;
  listChildTaskRelations(parentTaskId: string): readonly TaskRelationRecord[];
  insertTaskDependencies?(childTaskId: string, parentTaskIds: readonly string[], createdAt: string): void;
  listTaskDependencies?(childTaskId: string): readonly TaskDependencyRecord[];
  listDependentTaskIds?(parentTaskId: string): readonly string[];

  insertRouterSubmission(submission: RouterSubmissionRecord): void;
  getRouterSubmissionByKey(submissionKey: string): RouterSubmissionRecord | null;
  getRouterSubmissionByTaskId(taskId: string): RouterSubmissionRecord | null;

  /** Counts runs (all runs, not only routed ones) currently in any of the given statuses. */
  countRunsByStatuses(statuses: readonly string[]): number;

  /**
   * Routed runs still in CREATED, in deterministic order:
   * (depth ASC, ordinal ASC, submitted_at ASC, task_id ASC).
   */
  listDispatchCandidates(): readonly DispatchCandidateRecord[];
}
