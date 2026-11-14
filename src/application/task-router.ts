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
export interface TaskRouterTelemetrySink {
  recordRouterSubmission(input: {
    readonly taskId: string;
    readonly runId?: string;
    readonly parentTaskId?: string;
    readonly outcome: "admitted" | "duplicate" | "rejected";
    readonly durationMs: number;
  }): void;
  recordDispatchTick(input: {
    readonly admittedCount: number;
    readonly cancelledCount: number;
    readonly inFlight: number;
    readonly capacity: number;
    readonly durationMs: number;
  }): void;
}

export type RouterRunStatus = string;

export interface TaskRouterConfig {
  /** Max in-flight runs, counted globally across all runs. Must be 1 or 2. */
  readonly maxConcurrentRuns: 1 | 2;
  /** Max depth below a root (default 4). */
  readonly maxDepth?: number;
  /** Max direct children per parent (default 8). */
  readonly maxChildrenPerParent?: number;
  readonly telemetry?: TaskRouterTelemetrySink;
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
  /** Explicit multi-parent DAG predecessor task IDs (every predecessor must reach COMPLETED before admission). */
  readonly dependsOnTaskIds?: readonly string[];
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
  readonly dependsOnTaskIds?: readonly string[];
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
  private readonly telemetry?: TaskRouterTelemetrySink;

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
    this.telemetry = config.telemetry;
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
    const startMs = Date.now();
    try {
      const res = this.submitTaskCore(params);
      this.telemetry?.recordRouterSubmission({
        taskId: res.taskId,
        runId: res.runId,
        parentTaskId: params.parentTaskId,
        outcome: res.duplicate ? "duplicate" : "admitted",
        durationMs: Date.now() - startMs,
      });
      return res;
    } catch (err) {
      this.telemetry?.recordRouterSubmission({
        taskId: params.taskId,
        parentTaskId: params.parentTaskId,
        outcome: "rejected",
        durationMs: Date.now() - startMs,
      });
      throw err;
    }
  }

  private submitTaskCore(params: SubmitTaskParams): SubmitTaskResult {
    if (!params.submissionKey || params.submissionKey.trim().length === 0) {
      throw new TaskRouterTopologyError("submissionKey must be a non-empty string");
    }
    const normalizedDeps = this.normalizeDependsOn(params.dependsOnTaskIds);
    const requestHash = computeCanonicalHash({
      taskId: params.taskId,
      parentTaskId: params.parentTaskId ?? null,
      ...(normalizedDeps.length > 0 ? { dependsOnTaskIds: normalizedDeps } : {}),
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
      this.validateDependencies(tx, params.taskId, params.parentTaskId, normalizedDeps);
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
        this.validateDependencies(tx, params.taskId, params.parentTaskId, normalizedDeps);
        const ordinal = tx.listChildTaskRelations(params.parentTaskId).length;
        tx.insertTaskRelation({
          childTaskId: params.taskId,
          parentTaskId: params.parentTaskId,
          depth,
          ordinal,
          createdAt: now,
        });
      } else if (normalizedDeps.length > 0) {
        this.validateDependencies(tx, params.taskId, undefined, normalizedDeps);
      }
      const effectiveDeps: string[] = [];
      for (const dep of normalizedDeps) {
        if (!effectiveDeps.includes(dep)) {
          effectiveDeps.push(dep);
        }
      }
      if (params.parentTaskId && !effectiveDeps.includes(params.parentTaskId)) {
        effectiveDeps.push(params.parentTaskId);
      }
      if (effectiveDeps.length > 0 && tx.insertTaskDependencies) {
        tx.insertTaskDependencies(params.taskId, effectiveDeps, now);
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
    const startMs = Date.now();
    const res = this.dispatchTickCore();
    this.telemetry?.recordDispatchTick({
      admittedCount: res.admittedRunIds.length,
      cancelledCount: res.cancelledRunIds.length,
      inFlight: res.inFlight,
      capacity: res.capacity,
      durationMs: Date.now() - startMs,
    });
    return res;
  }

  private normalizeDependsOn(dependsOn?: readonly string[]): readonly string[] {
    if (!dependsOn || dependsOn.length === 0) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of dependsOn) {
      if (typeof raw !== "string" || raw.trim().length === 0) {
        throw new TaskRouterTopologyError("dependsOnTaskIds entries must be non-empty strings");
      }
      const dep = raw.trim();
      if (seen.has(dep)) {
        throw new TaskRouterTopologyError(`duplicate dependency '${dep}' in dependsOnTaskIds`);
      }
      seen.add(dep);
      out.push(dep);
    }
    return out;
  }

  private resolveTaskTenantId(tx: StorageTransaction, taskId: string): string | null {
    const activeContractTenant = tx.findContractsByTaskId(taskId, "ACTIVE")[0]?.spec.policy.tenantId;
    if (typeof activeContractTenant === "string" && activeContractTenant.trim().length > 0) {
      return activeContractTenant.trim();
    }
    const contractTenant = tx.findContractsByTaskId(taskId)[0]?.spec.policy.tenantId;
    if (typeof contractTenant === "string" && contractTenant.trim().length > 0) {
      return contractTenant.trim();
    }
    const payload = tx.getTask(taskId)?.inputPayload as Record<string, unknown> | undefined;
    const rawPayloadTenant = payload?.tenantId;
    if (typeof rawPayloadTenant === "string" && rawPayloadTenant.trim().length > 0) {
      return rawPayloadTenant.trim();
    }
    return null;
  }

  private validateDependencies(
    tx: StorageTransaction,
    childTaskId: string,
    parentTaskId: string | undefined,
    dependsOnTaskIds: readonly string[]
  ): void {
    const existingDeps = tx.listTaskDependencies ? tx.listTaskDependencies(childTaskId) : [];
    if (existingDeps.length > 0) {
      throw new TaskRouterTopologyError(`dependencies for task '${childTaskId}' are immutable once recorded`);
    }

    const preds: string[] = [];
    if (parentTaskId) preds.push(parentTaskId);
    for (const dep of dependsOnTaskIds) {
      if (!preds.includes(dep)) preds.push(dep);
    }
    if (preds.length === 0) return;

    const childTenant = this.resolveTaskTenantId(tx, childTaskId);
    for (const depId of preds) {
      if (depId === childTaskId) {
        throw new TaskRouterTopologyError(`task '${childTaskId}' cannot depend on itself`);
      }
      if (!tx.getTask(depId) || !tx.getRouterSubmissionByTaskId(depId)) {
        throw new TaskRouterTopologyError(`dependency task '${depId}' is not routed`);
      }
      const depTenant = this.resolveTaskTenantId(tx, depId);
      if ((childTenant || depTenant) && childTenant !== depTenant) {
        throw new TaskRouterTopologyError(`cross-tenant dependency '${depId}' -> '${childTaskId}' rejected`);
      }

      const relChildren = tx.listChildTaskRelations(depId).map((r) => r.childTaskId);
      const depChildren = tx.listDependentTaskIds ? tx.listDependentTaskIds(depId) : [];
      const uniqueChildren = new Set<string>([...relChildren, ...depChildren]);
      if (!uniqueChildren.has(childTaskId) && uniqueChildren.size >= this.maxChildrenPerParent) {
        throw new TaskRouterTopologyError(
          `parent '${depId}' already has ${this.maxChildrenPerParent} dependents (maxChildrenPerParent)`
        );
      }
    }

    // Cycle detection AND longest-path DAG depth ceiling across all predecessors
    const depthMemo = new Map<string, number>();
    const visiting = new Set<string>();
    const computeNodeDepth = (nodeId: string): number => {
      if (nodeId === childTaskId) {
        throw new TaskRouterTopologyError(`cycle detected involving task '${childTaskId}'`);
      }
      const cached = depthMemo.get(nodeId);
      if (cached !== undefined) return cached;
      if (visiting.has(nodeId)) {
        throw new TaskRouterTopologyError(`existing cycle detected at '${nodeId}'`);
      }
      visiting.add(nodeId);
      const rel = tx.getTaskRelation(nodeId);
      const nodePreds = this.getEffectivePredecessorTaskIds(tx, nodeId, rel?.parentTaskId ?? null);
      let maxPredDepth = -1;
      for (const p of nodePreds) {
        const d = computeNodeDepth(p);
        if (d > maxPredDepth) maxPredDepth = d;
      }
      visiting.delete(nodeId);
      const depth = nodePreds.length === 0 ? 0 : 1 + maxPredDepth;
      depthMemo.set(nodeId, depth);
      return depth;
    };

    let maxParentDepth = 0;
    for (const pred of preds) {
      const d = computeNodeDepth(pred);
      if (d > maxParentDepth) maxParentDepth = d;
    }
    const childDagDepth = 1 + maxParentDepth;
    if (childDagDepth > this.maxDepth) {
      throw new TaskRouterTopologyError(
        `DAG depth ${childDagDepth} exceeds maxDepth ${this.maxDepth}`
      );
    }
  }

  private getEffectivePredecessorTaskIds(
    tx: StorageTransaction,
    taskId: string,
    fallbackParentTaskId: string | null
  ): readonly string[] {
    const deps = tx.listTaskDependencies ? tx.listTaskDependencies(taskId) : [];
    if (deps.length > 0) {
      return deps.map((d) => d.parentTaskId);
    }
    return fallbackParentTaskId ? [fallbackParentTaskId] : [];
  }

  private dispatchTickCore(): DispatchTickResult {
    const cancelledRunIds: string[] = [];

    // Phase A: cascade cancellation to never-started descendants when ANY predecessor ended unsuccessfully.
    const candidates = this.stateStore.transaction((tx) => tx.listDispatchCandidates());
    for (const c of candidates) {
      const deadPred = this.stateStore.transaction((tx) => {
        const preds = this.getEffectivePredecessorTaskIds(tx, c.taskId, c.parentTaskId);
        return preds.find((predId) => this.parentVerdict(tx, predId) === "DEAD") ?? null;
      });
      if (deadPred) {
        try {
          this.coordinator.cancelRun(c.runId, `Predecessor task '${deadPred}' did not complete`);
          cancelledRunIds.push(c.runId);
        } catch {
          // Lost a race (already cancelled/queued by another actor); the next tick re-evaluates from SQLite.
        }
      }
    }

    // Phase B: atomic admission only when ALL predecessors are READY.
    const admittedRunIds: string[] = [];
    let inFlight = 0;
    let capacity = 0;
    this.stateStore.transaction((tx) => {
      inFlight = tx.countRunsByStatuses(IN_FLIGHT_STATUSES);
      capacity = Math.max(0, this.maxConcurrentRuns - inFlight);
      if (capacity === 0) return;
      for (const c of tx.listDispatchCandidates()) {
        if (admittedRunIds.length >= capacity) break;
        const preds = this.getEffectivePredecessorTaskIds(tx, c.taskId, c.parentTaskId);
        const allReady = preds.every((predId) => this.parentVerdict(tx, predId) === "READY");
        if (!allReady) continue;
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
    const boundContract = run.contractBinding
      ? tx.getContract(run.contractBinding.contractId, run.contractBinding.version)
      : null;
    if (boundContract && boundContract.lifecycle.status === "REVOKED") return "DEAD";
    const activeContracts = tx.findContractsByTaskId(parentTaskId, "ACTIVE");
    const anyRevoked = tx.findContractsByTaskId(parentTaskId).some((c) => c.lifecycle.status === "REVOKED");
    if (activeContracts.length === 0 && anyRevoked) return "DEAD";
    const events = tx.getEventsForRun(sub.runId);
    if (events.some((e) => e.eventType === "subagent.decomposed")) {
      return "READY";
    }
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
        const dependsOnTaskIds = this.getEffectivePredecessorTaskIds(
          tx,
          taskId,
          tx.getTaskRelation(taskId)?.parentTaskId ?? null
        );
        const branchVisited = new Set(visited);
        const children = tx.listChildTaskRelations(taskId).map((r) => build(r.childTaskId, branchVisited));
        return {
          taskId,
          runId: sub?.runId ?? null,
          runStatus: status,
          ...(dependsOnTaskIds.length > 0 ? { dependsOnTaskIds } : {}),
          children,
        };
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
        if (tx.listDependentTaskIds) {
          for (const depChildId of tx.listDependentTaskIds(taskId)) queue.push(depChildId);
        }
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
