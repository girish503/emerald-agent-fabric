/**
 * Durable Task Router (Milestone 2.17).
 *
 * An admission controller over the existing run runtime. It:
 *  - records durable parent/child task relations and idempotent submissions,
 *  - admits (QUEUED) routed runs deterministically, bounded by a global in-flight cap,
 *  - derives one consolidated status from durable run state,
 *  - propagates cancellation through the existing RunCoordinator.cancelRun.
 *
 * It does NOT claim, start or execute runs, touch workspaces or tools, call recovery,
 * retry failed runs, or enable resume. Workers keep their governed path and fencing.
 * Delivery is at-least-once: re-submitting with the same key is safe, not exactly-once.
 * Cancellation records a request and a state change; it never asserts the process stopped.
 */

import { RunCoordinator } from "./run-coordinator.js";
import { ClockPort } from "../ports/clock.port.js";
import { StateStorePort, StorageTransaction } from "../ports/state-store.port.js";
import { computeCanonicalHash } from "../domain/canonical-hash.js";

export type RouterRunStatus = string;

export interface TaskRouterConfig {
  /** Max in-flight runs, counted globally across all runs. Must be 1 or 2. */
  readonly maxConcurrentRuns: 1 | 2;
  /** Max depth below a root (default 4). */
  readonly maxDepth?: number;
  /** Max direct children per parent (default 8). */
  readonly maxChildrenPerParent?: number;
}

export class TaskRouterConfigError extends Error {
  constructor(message: string) {
    super(`Task router configuration invalid: ${message}`);
    this.name = "TaskRouterConfigError";
  }
}

export class SubmissionConflictError extends Error {
  constructor(readonly submissionKey: string, message: string) {
    super(`Submission '${submissionKey}' conflict: ${message}`);
    this.name = "SubmissionConflictError";
  }
}

export class TaskRouterTopologyError extends Error {
  constructor(message: string) {
    super(`Task router topology rejected: ${message}`);
    this.name = "TaskRouterTopologyError";
  }
}

export interface SubmitTaskParams {
  readonly submissionKey: string;
  /** Task must already exist and have exactly one ACTIVE MissionContract (caller-supplied authority). */
  readonly taskId: string;
  /** Parent must already be routed. Omit for a root task. */
  readonly parentTaskId?: string;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface SubmitTaskResult {
  readonly taskId: string;
  readonly runId: string;
  /** True when the key had already been recorded (no new run was created by this call). */
  readonly duplicate: boolean;
}

export interface DispatchTickResult {
  readonly admittedRunIds: readonly string[];
  readonly cancelledRunIds: readonly string[];
  readonly inFlight: number;
  readonly capacity: number;
}

export type TaskTreeAggregateStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface TaskTreeNodeStatus {
  readonly taskId: string;
  readonly runId: string | null;
  readonly runStatus: RouterRunStatus | null;
  readonly children: readonly TaskTreeNodeStatus[];
}

export interface TaskTreeStatus {
  readonly rootTaskId: string;
  readonly status: TaskTreeAggregateStatus;
  readonly counts: Readonly<Record<string, number>>;
  readonly root: TaskTreeNodeStatus;
}

export interface CancelTaskTreeResult {
  /** Runs moved to CANCELLED by this call. */
  readonly cancelledRunIds: readonly string[];
  /** Subset that was LEASED/RUNNING: cancellation requested; physical quiescence is NOT asserted. */
  readonly inFlightCancelRequestedRunIds: readonly string[];
  /** RECOVERING runs are left to the recovery supervisor and reported, never cancelled here. */
  readonly deferredRecoveringRunIds: readonly string[];
}

const IN_FLIGHT_STATUSES: readonly string[] = [
  "QUEUED",
  "LEASED",
  "RUNNING",
  "VERIFYING",
  "WAITING_APPROVAL",
  "RECOVERING",
];
const TERMINAL_STATUSES: readonly string[] = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"];

export class TaskRouterService {
  private readonly maxConcurrentRuns: number;
  private readonly maxDepth: number;
  private readonly maxChildrenPerParent: number;

  constructor(
    private readonly stateStore: StateStorePort,
    private readonly coordinator: RunCoordinator,
    private readonly clock: ClockPort,
    config: TaskRouterConfig
  ) {
    if (config.maxConcurrentRuns !== 1 && config.maxConcurrentRuns !== 2) {
      throw new TaskRouterConfigError(`maxConcurrentRuns must be 1 or 2, received ${config.maxConcurrentRuns}`);
    }
    this.maxConcurrentRuns = config.maxConcurrentRuns;
    this.maxDepth = config.maxDepth ?? 4;
    this.maxChildrenPerParent = config.maxChildrenPerParent ?? 8;
    if (!Number.isInteger(this.maxDepth) || this.maxDepth < 1) {
      throw new TaskRouterConfigError(`maxDepth must be an integer >= 1`);
    }
    if (!Number.isInteger(this.maxChildrenPerParent) || this.maxChildrenPerParent < 1) {
      throw new TaskRouterConfigError(`maxChildrenPerParent must be an integer >= 1`);
    }
  }

  // ---------------------------------------------------------------------------
  // Submission
  // ---------------------------------------------------------------------------

  /**
   * Idempotent submission. Safe to retry after a crash at any point:
   *   1. Read the key; same hash returns the stored record, different hash is a conflict.
   *   2. Validate topology.
   *   3. Create the run (CREATED) via RunCoordinator.createRun with idempotencyKey = submissionKey.
   *   4. Record relation + submission atomically.
   * A crash between 3 and 4 is repaired by retrying: step 3 returns the same run for the same key.
   */
  submitTask(params: SubmitTaskParams): SubmitTaskResult {
    if (!params.submissionKey || params.submissionKey.trim().length === 0) {
      throw new TaskRouterTopologyError("submissionKey must be a non-empty string");
    }
    const requestHash = computeCanonicalHash({
      taskId: params.taskId,
      parentTaskId: params.parentTaskId ?? null,
      maxAttempts: params.maxAttempts ?? null,
      timeoutMs: params.timeoutMs ?? null,
      maxOutputBytes: params.maxOutputBytes ?? null,
    }).contentHash;

    // 1. Duplicate check
    const prior = this.stateStore.transaction((tx) => tx.getRouterSubmissionByKey(params.submissionKey));
    if (prior) {
      return this.resolveDuplicate(prior, params.submissionKey, requestHash);
    }

    // 2. Topology validation (read-only)
    this.stateStore.transaction((tx) => {
      if (!tx.getTask(params.taskId)) {
        throw new TaskRouterTopologyError(`task '${params.taskId}' not found`);
      }
      if (tx.getRouterSubmissionByTaskId(params.taskId)) {
        throw new TaskRouterTopologyError(`task '${params.taskId}' is already routed under a different key`);
      }
      this.validateParent(tx, params.taskId, params.parentTaskId);
    });

    // 3. Create run (CREATED). The run idempotency key is the submission key.
    const created = this.coordinator.createRun({
      taskId: params.taskId,
      idempotencyKey: params.submissionKey,
      ...(params.maxAttempts !== undefined ? { maxAttempts: params.maxAttempts } : {}),
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
      ...(params.maxOutputBytes !== undefined ? { maxOutputBytes: params.maxOutputBytes } : {}),
    });
    if (created.run.taskId !== params.taskId) {
      throw new SubmissionConflictError(
        params.submissionKey,
        `key is already bound to a run for a different task ('${created.run.taskId}')`
      );
    }

    // A run found for this key that is no longer CREATED was not made by an unfinished router submission
    // (e.g. it was cancelled after an earlier rejection, or queued by another path). Recording it would route a
    // run that can never be dispatched while reporting success, so refuse and require a new key.
    if (created.run.status !== "CREATED") {
      throw new SubmissionConflictError(
        params.submissionKey,
        `key is already bound to a run in state '${created.run.status}' that the router did not admit; use a new submission key`
      );
    }

    // 4. Record relation + submission atomically
    return this.stateStore.transaction((tx) => {
      const raced = tx.getRouterSubmissionByKey(params.submissionKey);
      if (raced) {
        return this.resolveDuplicate(raced, params.submissionKey, requestHash);
      }
      const now = this.clock.nowIso();
      if (params.parentTaskId) {
        const depth = this.validateParent(tx, params.taskId, params.parentTaskId);
        const ordinal = tx.listChildTaskRelations(params.parentTaskId).length;
        tx.insertTaskRelation({
          childTaskId: params.taskId,
          parentTaskId: params.parentTaskId,
          depth,
          ordinal,
          createdAt: now,
        });
      }
      tx.insertRouterSubmission({
        submissionKey: params.submissionKey,
        taskId: params.taskId,
        runId: created.run.runId,
        requestHash,
        createdAt: now,
      });
      return { taskId: params.taskId, runId: created.run.runId, duplicate: false };
    });
  }

  private resolveDuplicate(
    prior: { submissionKey: string; taskId: string; runId: string; requestHash: string },
    submissionKey: string,
    requestHash: string
  ): SubmitTaskResult {
    if (prior.requestHash !== requestHash) {
      throw new SubmissionConflictError(
        submissionKey,
        "key was already used with a different request; refusing to return the earlier run"
      );
    }
    return { taskId: prior.taskId, runId: prior.runId, duplicate: true };
  }

  /** Validates parent routing, cycle freedom, depth and fan-out. Returns the child's depth. */
  private validateParent(
    tx: StorageTransaction,
    childTaskId: string,
    parentTaskId: string | undefined
  ): number {
    if (!parentTaskId) return 0;
    if (parentTaskId === childTaskId) {
      throw new TaskRouterTopologyError(`task '${childTaskId}' cannot be its own parent`);
    }
    if (!tx.getRouterSubmissionByTaskId(parentTaskId)) {
      throw new TaskRouterTopologyError(`parent task '${parentTaskId}' is not routed`);
    }
    // Defensive ancestor walk: the child must not be an ancestor of the parent.
    let depth = 1;
    let cursor: string | null = parentTaskId;
    const seen = new Set<string>();
    while (cursor) {
      if (cursor === childTaskId) {
        throw new TaskRouterTopologyError(`cycle detected: '${childTaskId}' is an ancestor of '${parentTaskId}'`);
      }
      if (seen.has(cursor)) {
        throw new TaskRouterTopologyError(`existing cycle detected at '${cursor}'`);
      }
      seen.add(cursor);
      const rel = tx.getTaskRelation(cursor);
      if (!rel) break;
      depth++;
      cursor = rel.parentTaskId;
    }
    if (depth > this.maxDepth) {
      throw new TaskRouterTopologyError(`depth ${depth} exceeds maxDepth ${this.maxDepth}`);
    }
    if (tx.listChildTaskRelations(parentTaskId).length >= this.maxChildrenPerParent) {
      throw new TaskRouterTopologyError(
        `parent '${parentTaskId}' already has ${this.maxChildrenPerParent} children (maxChildrenPerParent)`
      );
    }
    return depth;
  }

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  /**
   * One deterministic dispatch pass. Idempotent and restart-safe; all state is read from SQLite.
   *  Phase A: runs whose parent ended unsuccessfully (never started) are cancelled.
   *  Phase B: in ONE transaction, count global in-flight runs and queue ready runs up to the cap.
   */
  dispatchTick(): DispatchTickResult {
    const cancelledRunIds: string[] = [];

    // Phase A: cascade cancellation to never-started descendants of failed/cancelled parents.
    const candidates = this.stateStore.transaction((tx) => tx.listDispatchCandidates());
    for (const c of candidates) {
      if (!c.parentTaskId) continue;
      const verdict = this.stateStore.transaction((tx) => this.parentVerdict(tx, c.parentTaskId!));
      if (verdict === "DEAD") {
        try {
          this.coordinator.cancelRun(c.runId, `Parent task '${c.parentTaskId}' did not complete`);
          cancelledRunIds.push(c.runId);
        } catch {
          // Lost a race (already cancelled/queued by another actor); the next tick re-evaluates from SQLite.
        }
      }
    }

    // Phase B: atomic admission.
    const admittedRunIds: string[] = [];
    let inFlight = 0;
    let capacity = 0;
    this.stateStore.transaction((tx) => {
      inFlight = tx.countRunsByStatuses(IN_FLIGHT_STATUSES);
      capacity = Math.max(0, this.maxConcurrentRuns - inFlight);
      if (capacity === 0) return;
      for (const c of tx.listDispatchCandidates()) {
        if (admittedRunIds.length >= capacity) break;
        if (c.parentTaskId && this.parentVerdict(tx, c.parentTaskId) !== "READY") continue;
        this.coordinator.queueRunInTransaction(tx, c.runId);
        admittedRunIds.push(c.runId);
      }
    });

    return Object.freeze({
      admittedRunIds: Object.freeze(admittedRunIds),
      cancelledRunIds: Object.freeze(cancelledRunIds),
      inFlight,
      capacity,
    });
  }

  /** READY: parent run COMPLETED. WAIT: still pending/in flight. DEAD: ended unsuccessfully. */
  private parentVerdict(
    tx: StorageTransaction,
    parentTaskId: string
  ): "READY" | "WAIT" | "DEAD" {
    const sub = tx.getRouterSubmissionByTaskId(parentTaskId);
    if (!sub) return "DEAD"; // unrouted parent can never complete under the router
    const run = tx.getRun(sub.runId);
    if (!run) return "DEAD";
    if (run.status === "COMPLETED") return "READY";
    if (TERMINAL_STATUSES.includes(run.status)) return "DEAD";
    return "WAIT";
  }

  // ---------------------------------------------------------------------------
  // Consolidated status (pure read; nothing is stored)
  // ---------------------------------------------------------------------------

  getTaskTreeStatus(rootTaskId: string): TaskTreeStatus {
    const counts: Record<string, number> = {};
    const root = this.stateStore.transaction((tx) => {
      if (!tx.getTask(rootTaskId)) {
        throw new TaskRouterTopologyError(`task '${rootTaskId}' not found`);
      }
      const build = (taskId: string, visited: Set<string>): TaskTreeNodeStatus => {
        if (visited.has(taskId)) {
          throw new TaskRouterTopologyError(`cycle detected at '${taskId}'`);
        }
        visited.add(taskId);
        const sub = tx.getRouterSubmissionByTaskId(taskId);
        const run = sub ? tx.getRun(sub.runId) : null;
        const status = run?.status ?? null;
        if (status) counts[status] = (counts[status] ?? 0) + 1;
        const children = tx.listChildTaskRelations(taskId).map((r) => build(r.childTaskId, visited));
        return { taskId, runId: sub?.runId ?? null, runStatus: status, children };
      };
      return build(rootTaskId, new Set());
    });

    const statuses = Object.keys(counts);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    let status: TaskTreeAggregateStatus;
    if ((counts["FAILED"] ?? 0) + (counts["TIMED_OUT"] ?? 0) > 0) status = "FAILED";
    else if ((counts["CANCELLED"] ?? 0) > 0) status = "CANCELLED";
    else if (total > 0 && (counts["COMPLETED"] ?? 0) === total) status = "COMPLETED";
    else if (statuses.some((s) => s !== "CREATED")) status = "RUNNING";
    else status = "PENDING";

    return Object.freeze({ rootTaskId, status, counts: Object.freeze({ ...counts }), root });
  }

  // ---------------------------------------------------------------------------
  // Cancellation
  // ---------------------------------------------------------------------------

  /**
   * Cancels every non-terminal routed run in the tree through RunCoordinator.cancelRun.
   * LEASED/RUNNING runs are cancelled by state change (the worker observes lost authority; its
   * fenced writes are rejected) but process/container stop is NOT asserted. RECOVERING runs are
   * left to the recovery supervisor and reported.
   */
  cancelTaskTree(rootTaskId: string, reason = "Cancelled via task tree"): CancelTaskTreeResult {
    const runs = this.stateStore.transaction((tx) => {
      if (!tx.getTask(rootTaskId)) {
        throw new TaskRouterTopologyError(`task '${rootTaskId}' not found`);
      }
      const out: Array<{ runId: string; status: string }> = [];
      const queue = [rootTaskId];
      const seen = new Set<string>();
      while (queue.length > 0) {
        const taskId = queue.shift()!;
        if (seen.has(taskId)) continue;
        seen.add(taskId);
        const sub = tx.getRouterSubmissionByTaskId(taskId);
        const run = sub ? tx.getRun(sub.runId) : null;
        if (run) out.push({ runId: run.runId, status: run.status });
        for (const rel of tx.listChildTaskRelations(taskId)) queue.push(rel.childTaskId);
      }
      return out;
    });

    const cancelledRunIds: string[] = [];
    const inFlightCancelRequestedRunIds: string[] = [];
    const deferredRecoveringRunIds: string[] = [];
    for (const r of runs) {
      if (TERMINAL_STATUSES.includes(r.status)) continue;
      if (r.status === "RECOVERING") {
        deferredRecoveringRunIds.push(r.runId);
        continue;
      }
      try {
        this.coordinator.cancelRun(r.runId, reason);
        cancelledRunIds.push(r.runId);
        if (r.status === "LEASED" || r.status === "RUNNING") inFlightCancelRequestedRunIds.push(r.runId);
      } catch {
        // State changed concurrently (e.g. completed or became RECOVERING); it is re-evaluated from SQLite.
      }
    }
    return Object.freeze({
      cancelledRunIds: Object.freeze(cancelledRunIds),
      inFlightCancelRequestedRunIds: Object.freeze(inFlightCancelRequestedRunIds),
      deferredRecoveringRunIds: Object.freeze(deferredRecoveringRunIds),
    });
  }
}
