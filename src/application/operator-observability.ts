/**
 * Emerald Agent Fabric — Operator Observability & Durable Run Inspection (Milestone 2.21)
 *
 * Implements strictly read-only inspection services for operators:
 * - Run inspection: durable identity, lifecycle, action/attempt summaries, verification latch, artifacts, and failure explanations.
 * - Task-tree inspection: hierarchical parent-child relationships, execution state, and dispatch eligibility.
 * - Durable event timeline: sequence-ordered pagination, payload sanitization, and redaction.
 * - Failure explanation layer: deterministic diagnostic classification for known failure codes.
 *
 * Security & Invariants:
 * - Read-only enforcement via SQLite PRAGMA query_only = ON and { readOnly: true }.
 * - Never creates a missing database file (fails closed).
 * - Never runs migrations or triggers background recovery/dispatch.
 * - Redacts sensitive tokens, credentials, keys, prompts, and unbounded payloads.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { SqliteStateStore } from "../adapters/persistence/sqlite-state-store.js";
import type { RunSnapshot, RunStatus } from "../domain/invariants.js";
import type { PersistedEvent, TaskRecord } from "../ports/state-store.port.js";
import type { TaskRelationRecord, RouterSubmissionRecord } from "../ports/task-router-store.port.js";
import { PostPassVerificationLatch } from "./post-pass-verification-latch.js";
import { artifactDirectory } from "../adapters/workspace/git-artifact-exporter.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: NodeDatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSync };

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface ReadOnlyDatabaseHandle {
  readonly db: DatabaseSync;
  readonly store: SqliteStateStore;
  readonly close: () => void;
}

export interface FailureExplanation {
  readonly code: string;
  readonly stage: "EXECUTION" | "VERIFICATION" | "REASONING" | "PERSISTENCE" | "CONTROL" | "RECOVERY" | "UNKNOWN";
  readonly status: string;
  readonly fact: string;
  readonly inference: string;
  readonly recommendedNextStep: string;
}

export interface RunIdentityReport {
  readonly runId: string;
  readonly taskId: string;
  readonly status: RunStatus;
  readonly version: number;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  readonly idempotencyKey: string | null;
  readonly contract: {
    readonly contractId: string;
    readonly version: number;
    readonly contentHash: string;
  } | null;
  readonly worker: {
    readonly currentWorkerId: string | null;
    readonly leaseId: string | null;
    readonly leaseExpiresAt: string | null;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resultPayload: unknown | null;
  readonly errorPayload: unknown | null;
}

export interface ActionSummaryItem {
  readonly actionId: string;
  readonly sequenceNumber: number;
  readonly toolName: string;
  readonly status: string;
  readonly totalAttempts: number;
}

export interface AttemptSummaryItem {
  readonly attemptNumber: number;
  readonly actionId: string;
  readonly status: string;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

export interface ExecutionSummaryReport {
  readonly totalAttempts: number;
  readonly actionsCount: number;
  readonly actionsSucceeded: number;
  readonly actionsFailed: number;
  readonly actions: readonly ActionSummaryItem[];
  readonly attempts: readonly AttemptSummaryItem[];
}

export interface VerificationReport {
  readonly isLatched: boolean;
  readonly protectedPaths: readonly string[];
  readonly cleanRoomVerified: boolean;
  readonly cleanRoomStatus: "VERIFIED" | "FAILED" | "NOT_RUN";
  readonly cleanRoomMessage: string | null;
  readonly evidenceExists: boolean;
}

export interface ArtifactReport {
  readonly exists: boolean;
  readonly attempt: number | null;
  readonly manifestPath: string | null;
  readonly patchPath: string | null;
  readonly patchBytes: number | null;
  readonly changedFiles: number | null;
  readonly totals: {
    readonly changedFiles: number;
    readonly added: number;
    readonly modified: number;
    readonly deleted: number;
    readonly linesAdded: number;
    readonly linesRemoved: number;
  } | null;
}

export interface RunInspectionReport {
  readonly run: RunIdentityReport;
  readonly execution: ExecutionSummaryReport;
  readonly verification: VerificationReport;
  readonly artifacts: ArtifactReport;
  readonly failure: FailureExplanation | null;
}

export interface InspectRunOptions {
  readonly dbPath: string;
  readonly runId: string;
  readonly artifactRoot?: string;
}

export type DispatchEligibility =
  | "ROOT_ELIGIBLE"
  | "DISPATCHED"
  | "READY"
  | "WAITING_PARENT"
  | "BLOCKED_PARENT_FAILED"
  | "UNROUTED";

export interface TaskTreeNode {
  readonly taskId: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly depth: number;
  readonly ordinal: number;
  readonly parentTaskId: string | null;
  readonly runId: string | null;
  readonly runStatus: RunStatus | null;
  readonly dispatchEligibility: DispatchEligibility;
  readonly eligibilityReason: string;
  readonly children: readonly TaskTreeNode[];
}

export interface TaskTreeReport {
  readonly rootTaskId: string;
  readonly totalNodes: number;
  readonly tree: TaskTreeNode;
}

export interface InspectTaskTreeOptions {
  readonly dbPath: string;
  readonly taskId: string;
}

export interface TimelineEventSummary {
  readonly eventId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly eventType: string;
  readonly producer: string;
  readonly summary: string;
  readonly payload: unknown;
}

export interface RunEventTimelineReport {
  readonly runId: string;
  readonly totalEvents: number;
  readonly returnedCount: number;
  readonly afterSequence: number;
  readonly limit: number;
  readonly events: readonly TimelineEventSummary[];
}

export interface RunEventTimelineOptions {
  readonly dbPath: string;
  readonly runId: string;
  readonly limit?: number;
  readonly afterSequence?: number;
}

// ============================================================================
// Database & Read-Only Safety Layer
// ============================================================================

/**
 * Opens an existing SQLite database strictly in read-only mode without executing migrations or creating files.
 * Enforces PRAGMA query_only = ON to guarantee fail-closed behavior on accidental write attempts.
 */
export function openReadOnlyDatabase(dbPath: string): ReadOnlyDatabaseHandle {
  if (!dbPath || dbPath === ":memory:") {
    throw new Error("--db <file> is required (not :memory:)");
  }

  // Strict preflight check: fail immediately if database file does not exist
  if (!fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) {
    throw new Error(`database not found (inspect never creates one): ${dbPath}`);
  }

  // NodeDatabaseSync with readOnly: true prevents SQLite from creating new files or acquiring write locks
  const db = new NodeDatabaseSync(dbPath, { readOnly: true });

  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA query_only = ON;");
  } catch (err) {
    try {
      db.close();
    } catch {
      // ignore close errors on failed config
    }
    throw err;
  }

  const store = new SqliteStateStore(db);
  return {
    db,
    store,
    close: () => {
      try {
        db.close();
      } catch {
        // ignore close errors
      }
    },
  };
}

/**
 * Verifies whether candidatePath canonical realpath resides strictly inside canonicalRoot.
 * Returns false if candidatePath does not exist, throws on realpath resolution,
 * or resolves outside canonicalRoot (preventing directory traversal and symlink escapes).
 */
export function isPathInsideCanonicalRoot(candidatePath: string, canonicalRoot: string): boolean {
  try {
    if (!fs.existsSync(candidatePath) || !fs.existsSync(canonicalRoot)) return false;
    const realCandidate = fs.realpathSync(candidatePath);
    const realRoot = fs.realpathSync(canonicalRoot);
    const rel = path.relative(realRoot, realCandidate);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

// ============================================================================
// Sanitization & Redaction Layer
// ============================================================================

const SENSITIVE_KEY_REGEX = /token|key|secret|password|credential|prompt|env|authorization|cookie|private/i;
const SENSITIVE_VALUE_PREFIXES = ["ghp_", "sk-", "Bearer ", "bearer "];

/**
 * Sanitizes and redacts sensitive data from payloads.
 * Masks secrets, tokens, credentials, prompts, and truncates long strings to bounded limits.
 */
export function redactSensitivePayload(
  data: unknown,
  maxStringLength: number = 160,
  depth: number = 0,
  visited: Set<unknown> = new Set()
): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === "string") {
    for (const prefix of SENSITIVE_VALUE_PREFIXES) {
      if (data.startsWith(prefix)) {
        return "[REDACTED]";
      }
    }
    if (data.length > maxStringLength) {
      return `${data.slice(0, maxStringLength)}... [truncated ${data.length - maxStringLength} chars]`;
    }
    return data;
  }

  if (typeof data === "number" || typeof data === "boolean") {
    return data;
  }

  if (depth > 6 || visited.has(data)) {
    return "[DEPTH_LIMIT]";
  }

  if (Array.isArray(data)) {
    visited.add(data);
    const result = data.slice(0, 50).map((item) =>
      redactSensitivePayload(item, maxStringLength, depth + 1, visited)
    );
    if (data.length > 50) {
      result.push(`... [${data.length - 50} more items truncated]` as any);
    }
    visited.delete(data);
    return result;
  }

  if (typeof data === "object") {
    visited.add(data);
    const result: Record<string, unknown> = {};
    const entries = Object.entries(data as Record<string, unknown>);
    for (const [k, v] of entries) {
      if (SENSITIVE_KEY_REGEX.test(k)) {
        result[k] = "[REDACTED]";
      } else {
        result[k] = redactSensitivePayload(v, maxStringLength, depth + 1, visited);
      }
    }
    visited.delete(data);
    return result;
  }

  return String(data);
}

function sanitizeIdempotencyKey(key: string | null): string | null {
  if (!key) return null;
  if (SENSITIVE_KEY_REGEX.test(key)) {
    return "[REDACTED]";
  }
  for (const prefix of SENSITIVE_VALUE_PREFIXES) {
    if (key.startsWith(prefix)) return "[REDACTED]";
  }
  if (key.length > 80) {
    return `${key.slice(0, 30)}...${key.slice(-10)}`;
  }
  return key;
}

// ============================================================================
// Phase E — Failure Explanation Layer
// ============================================================================

/**
 * Deterministically explains known failure codes and terminal conditions using persisted evidence.
 * Returns null if the run is not in a terminal failure/cancelled state.
 */
export function explainRunFailure(
  run: RunSnapshot,
  events: readonly PersistedEvent[]
): FailureExplanation | null {
  if (run.status !== "FAILED" && run.status !== "CANCELLED" && run.status !== "TIMED_OUT") {
    return null;
  }

  if (run.status === "CANCELLED") {
    const errorPayload = run.errorPayload as Record<string, unknown> | null;
    const cancelEvent = events.slice().reverse().find((e) => e.eventType === "run.cancelled");
    const cancelPayload = cancelEvent?.payload as Record<string, unknown> | undefined;
    const reason =
      (errorPayload?.reason as string) ??
      (errorPayload?.message as string) ??
      (cancelPayload?.reason as string) ??
      null;

    return {
      code: "CANCELLED",
      stage: "CONTROL",
      status: "CANCELLED",
      fact: `Run was cancelled${reason ? `: ${reason}` : ""}.`,
      inference: "An operator or parent task cancellation aborted the run.",
      recommendedNextStep: "Review cancellation reason; submit a new task if cancellation was accidental.",
    };
  }

  if (run.status === "TIMED_OUT") {
    return {
      code: "TIMED_OUT",
      stage: "EXECUTION",
      status: "TIMED_OUT",
      fact: `Run exceeded maximum allowed timeout (${run.timeoutMs}ms).`,
      inference: "The agent was unable to complete execution within the configured time budget.",
      recommendedNextStep: "Increase --timeout-ms or decompose the task into smaller subtasks.",
    };
  }

  // Run status === "FAILED"
  const errorPayload = run.errorPayload as Record<string, unknown> | null;
  const failEvent = events.slice().reverse().find((e) => e.eventType === "run.failed");
  const failPayload = failEvent?.payload as Record<string, unknown> | undefined;

  const rawCode =
    (errorPayload?.code as string) ??
    (errorPayload?.name as string) ??
    (failPayload?.error as any)?.code ??
    (failPayload?.error as any)?.name ??
    "";

  const rawMessage =
    (errorPayload?.message as string) ??
    (failPayload?.error as any)?.message ??
    (typeof errorPayload === "string" ? errorPayload : "") ??
    "";

  const fullSearchText = `${rawCode} ${rawMessage} ${JSON.stringify(errorPayload ?? "")} ${JSON.stringify(failPayload ?? "")}`.toLowerCase();

  // 1. Worker lease lost
  if (rawCode === "LEASE_LOST" || rawCode === "LeaseLostError" || /leaselost/i.test(fullSearchText)) {
    return {
      code: "LEASE_LOST",
      stage: "EXECUTION",
      status: run.status,
      fact: "Worker lease lost: another worker took over or heartbeat check detected an active lease held by another worker.",
      inference: "The worker execution was preempted or lost connectivity to the state store.",
      recommendedNextStep: "Verify worker health and connectivity; inspect lease timeouts before rerunning.",
    };
  }

  // 2. Worker lease expired
  if (rawCode === "LEASE_EXPIRED" || rawCode === "LeaseExpiredError" || /leaseexpired/i.test(fullSearchText)) {
    return {
      code: "LEASE_EXPIRED",
      stage: "EXECUTION",
      status: run.status,
      fact: "Worker lease expired during execution without timely renewal.",
      inference: "The worker process was stalled, unseated, or the lease renewal loop was starved.",
      recommendedNextStep: "Check worker host CPU utilization or increase lease TTL (--lease-ttl-ms).",
    };
  }

  // 3. Verification failed
  if (
    rawCode === "VERIFICATION_FAILED" ||
    rawCode === "POST_WRITE_VERIFICATION_FAILED" ||
    /post_write_verification_failed|verification.*fail/i.test(fullSearchText)
  ) {
    return {
      code: "VERIFICATION_FAILED",
      stage: "VERIFICATION",
      status: run.status,
      fact: `Verification checks did not pass: ${rawMessage || "Verification suites rejected the proposed changes"}`,
      inference: "The agent's proposed changes failed to satisfy required test assertions or broke existing regression tests.",
      recommendedNextStep: "Inspect test failure logs and artifact diff; refine agent prompts or task constraints.",
    };
  }

  // 4. Replay blocked uncertain prior attempt
  if (
    rawCode === "REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT" ||
    /replay_blocked_uncertain_prior_attempt/i.test(fullSearchText)
  ) {
    return {
      code: "REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT",
      stage: "RECOVERY",
      status: run.status,
      fact: "Recovery engine blocked execution because a prior attempt completed with uncertain non-idempotent status.",
      inference: "Fail-closed safety invariant prevented duplicate execution of non-idempotent mutations.",
      recommendedNextStep: "Human operator manual review required to inspect workspace state before clearing or submitting a new task.",
    };
  }

  // 5. SQLite database busy/locked
  if (
    rawCode === "SQLITE_BUSY" ||
    rawCode === "SQLITE_LOCKED" ||
    /database is locked|sqlite_busy|sqlite_locked/i.test(fullSearchText)
  ) {
    return {
      code: "SQLITE_BUSY",
      stage: "PERSISTENCE",
      status: run.status,
      fact: "SQLite database contention exceeded timeout or database was locked.",
      inference: "Concurrent processes attempted conflicting write operations on the SQLite database.",
      recommendedNextStep: "Tune busy timeout, adjust concurrency caps, or verify no long-running uncommitted transactions.",
    };
  }

  // 6. Model provider failure / invalid proposal
  if (
    rawCode === "MODEL_PROVIDER_FAILURE" ||
    rawCode === "INVALID_TOOL_PROPOSAL" ||
    /model.*fail|invalid tool proposal|unreachable model/i.test(fullSearchText)
  ) {
    return {
      code: "MODEL_PROVIDER_FAILURE",
      stage: "REASONING",
      status: run.status,
      fact: `Model provider failure: ${rawMessage || "Model provider unreachable or produced invalid tool proposal"}`,
      inference: "The local model endpoint was unreachable, overloaded, or output did not conform to schema.",
      recommendedNextStep: "Verify local model server (e.g. Ollama) is running and model weights are loaded.",
    };
  }

  // 7. Unknown / Unclassified failure — do NOT hallucinate causes
  return {
    code: "UNKNOWN_FAILURE",
    stage: "UNKNOWN",
    status: run.status,
    fact: `Failure observed with error: ${rawMessage || rawCode || JSON.stringify(errorPayload ?? {})}`,
    inference: "Unclassified failure code or unrecorded failure reason.",
    recommendedNextStep: "Inspect durable event timeline (emerald run events) and worker logs for root cause.",
  };
}

// ============================================================================
// Phase B — Run Inspection Implementation
// ============================================================================

/**
 * Inspects a durable run and returns a complete, typed inspection report.
 */
export function inspectRun(options: InspectRunOptions): RunInspectionReport {
  const { dbPath, runId, artifactRoot } = options;
  const handle = openReadOnlyDatabase(dbPath);

  try {
    const { store } = handle;
    const run = store.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    // 1. Actions and attempts
    const actions = store.getActionsForRun(runId);
    const actionSummaries: ActionSummaryItem[] = [];
    const attemptSummaries: AttemptSummaryItem[] = [];
    let actionsSucceeded = 0;
    let actionsFailed = 0;

    for (const act of actions) {
      actionSummaries.push({
        actionId: act.actionId,
        sequenceNumber: act.sequenceNumber,
        toolName: act.toolName,
        status: act.status,
        totalAttempts: act.totalAttempts,
      });

      if (act.status === "SUCCEEDED") actionsSucceeded++;
      if (act.status === "FAILED") actionsFailed++;

      const attempts = store.getAttemptsForAction(act.actionId);
      for (const att of attempts) {
        attemptSummaries.push({
          attemptNumber: att.attemptNumber,
          actionId: att.actionId,
          status: att.status,
          exitCode: att.exitCode,
          durationMs: att.durationMs,
          startedAt: att.startedAt,
          completedAt: att.completedAt,
        });
      }
    }

    // 2. Events & Verification latch
    const events = store.getEventsForRun(runId);
    let latch: PostPassVerificationLatch | null = null;
    try {
      latch = PostPassVerificationLatch.reconstructFromEvents(events, { runId });
    } catch {
      latch = null;
    }

    const hasVerificationEvent = events.some(
      (e) =>
        e.eventType === "verification.completed" &&
        ((e.payload as any)?.passed === true || (e.payload as any)?.verified === true)
    );

    const verification: VerificationReport = {
      isLatched: latch ? latch.isLatched : false,
      protectedPaths: latch ? latch.protectedPaths : [],
      cleanRoomVerified: latch ? latch.cleanRoomVerified : false,
      cleanRoomStatus: latch?.cleanRoomStatus ?? "NOT_RUN",
      cleanRoomMessage: null,
      evidenceExists: latch ? latch.cleanRoomVerified || hasVerificationEvent : hasVerificationEvent,
    };

    // 3. Artifacts
    let artifactReport: ArtifactReport = {
      exists: false,
      attempt: null,
      manifestPath: null,
      patchPath: null,
      patchBytes: null,
      changedFiles: null,
      totals: null,
    };

    const resolvedArtifactRoot = artifactRoot ?? path.join(process.cwd(), "artifacts");
    if (fs.existsSync(resolvedArtifactRoot) && fs.statSync(resolvedArtifactRoot).isDirectory()) {
      let canonicalArtifactRoot: string;
      try {
        canonicalArtifactRoot = fs.realpathSync(resolvedArtifactRoot);
      } catch {
        canonicalArtifactRoot = path.resolve(resolvedArtifactRoot);
      }

      const runArtifactDir = path.join(resolvedArtifactRoot, runId);
      if (
        fs.existsSync(runArtifactDir) &&
        fs.statSync(runArtifactDir).isDirectory() &&
        isPathInsideCanonicalRoot(runArtifactDir, canonicalArtifactRoot)
      ) {
        const attemptDirs = fs
          .readdirSync(runArtifactDir)
          .map((name) => /^attempt-(\d+)$/.exec(name))
          .filter((m): m is RegExpExecArray => m !== null)
          .map((m) => Number(m[1]))
          .sort((a, b) => a - b);

        const latestAttempt = attemptDirs[attemptDirs.length - 1];
        if (latestAttempt !== undefined) {
          const attemptDirPath = artifactDirectory(resolvedArtifactRoot, runId, latestAttempt);
          if (
            fs.existsSync(attemptDirPath) &&
            fs.statSync(attemptDirPath).isDirectory() &&
            isPathInsideCanonicalRoot(attemptDirPath, canonicalArtifactRoot)
          ) {
            const manifestPath = path.join(attemptDirPath, "manifest.json");
            const patchPath = path.join(attemptDirPath, "patch.diff");

            if (
              fs.existsSync(manifestPath) &&
              isPathInsideCanonicalRoot(manifestPath, canonicalArtifactRoot)
            ) {
              try {
                const manifestContent = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
                const hasValidPatch =
                  fs.existsSync(patchPath) &&
                  isPathInsideCanonicalRoot(patchPath, canonicalArtifactRoot);
                const patchBytes = hasValidPatch ? fs.statSync(patchPath).size : null;
                artifactReport = {
                  exists: true,
                  attempt: latestAttempt,
                  manifestPath,
                  patchPath: hasValidPatch ? patchPath : null,
                  patchBytes,
                  changedFiles: manifestContent?.totals?.changedFiles ?? null,
                  totals: manifestContent?.totals ?? null,
                };
              } catch {
                // ignore parse errors
              }
            }
          }
        }
      }
    }

    // 4. Failure explanation
    const failure = explainRunFailure(run, events);

    return {
      run: {
        runId: run.runId,
        taskId: run.taskId,
        status: run.status,
        version: run.version,
        attemptCount: run.attemptCount,
        maxAttempts: run.maxAttempts,
        timeoutMs: run.timeoutMs,
        idempotencyKey: sanitizeIdempotencyKey(run.idempotencyKey),
        contract: run.contractBinding
          ? {
              contractId: run.contractBinding.contractId,
              version: run.contractBinding.version,
              contentHash: run.contractBinding.contentHash,
            }
          : null,
        worker: {
          currentWorkerId: run.currentWorkerId,
          leaseId: run.leaseId,
          leaseExpiresAt: run.leaseExpiresAt,
        },
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        resultPayload: redactSensitivePayload(run.resultPayload),
        errorPayload: redactSensitivePayload(run.errorPayload),
      },
      execution: {
        totalAttempts: run.attemptCount,
        actionsCount: actions.length,
        actionsSucceeded,
        actionsFailed,
        actions: actionSummaries,
        attempts: attemptSummaries,
      },
      verification,
      artifacts: artifactReport,
      failure,
    };
  } finally {
    handle.close();
  }
}

/**
 * Formats a RunInspectionReport into readable CLI text output.
 */
export function formatRunInspectionReport(report: RunInspectionReport): string {
  const { run, execution, verification, artifacts, failure } = report;
  const lines: string[] = [
    `Run Inspection: ${run.runId}`,
    `============================================================`,
    `Status:             ${run.status}`,
    `Task ID:            ${run.taskId}`,
    `Contract:           ${run.contract ? `${run.contract.contractId} (v${run.contract.version}, ${run.contract.contentHash.slice(0, 12)}...)` : "None"}`,
    `Idempotency Key:    ${run.idempotencyKey ?? "None"}`,
    `Worker ID:          ${run.worker.currentWorkerId ?? "None"}`,
    `Lease ID:           ${run.worker.leaseId ?? "None"} (expires: ${run.worker.leaseExpiresAt ?? "None"})`,
    `Created At:         ${run.createdAt}`,
    `Updated At:         ${run.updatedAt}`,
    ``,
    `Execution Summary:`,
    `  Attempts:         ${execution.totalAttempts}`,
    `  Actions Total:    ${execution.actionsCount} (Succeeded: ${execution.actionsSucceeded}, Failed: ${execution.actionsFailed})`,
  ];

  if (execution.actions.length > 0) {
    lines.push(`  Actions Breakdown:`);
    for (const a of execution.actions) {
      lines.push(`    - [Seq ${a.sequenceNumber}] ${a.toolName} -> ${a.status} (${a.totalAttempts} attempt(s))`);
    }
  }

  lines.push(``, `Verification:`);
  lines.push(`  Latched:          ${verification.isLatched ? "Yes" : "No"}`);
  lines.push(`  Protected Paths:  ${verification.protectedPaths.length > 0 ? verification.protectedPaths.join(", ") : "None"}`);
  lines.push(`  Clean-Room:       ${verification.cleanRoomStatus} (Verified: ${verification.cleanRoomVerified ? "Yes" : "No"})`);
  lines.push(`  Evidence Exists:  ${verification.evidenceExists ? "Yes" : "No"}`);

  lines.push(``, `Artifacts:`);
  lines.push(`  Exported:         ${artifacts.exists ? "Yes" : "No"}`);
  if (artifacts.exists) {
    lines.push(`  Attempt:          ${artifacts.attempt}`);
    lines.push(`  Manifest:         ${artifacts.manifestPath}`);
    lines.push(`  Patch:            ${artifacts.patchPath ?? "None"} (${artifacts.patchBytes ?? 0} bytes)`);
    if (artifacts.totals) {
      lines.push(`  Changed Files:    ${artifacts.totals.changedFiles} (+${artifacts.totals.linesAdded} / -${artifacts.totals.linesRemoved} lines)`);
    }
  }

  if (failure) {
    lines.push(``, `Failure Explanation:`);
    lines.push(`  Failure Code:     ${failure.code}`);
    lines.push(`  Affected Stage:   ${failure.stage}`);
    lines.push(`  Confirmed Fact:   ${failure.fact}`);
    lines.push(`  Inference:        ${failure.inference}`);
    lines.push(`  Recommended Next: ${failure.recommendedNextStep}`);
  }

  return lines.join("\n");
}

// ============================================================================
// Phase C — Task Tree Inspection Implementation
// ============================================================================

/**
 * Inspects a task hierarchy starting from a task ID.
 * Determines parent-child relationships, statuses, and dispatch eligibility using existing router policy.
 */
export function inspectTaskTree(options: InspectTaskTreeOptions): TaskTreeReport {
  const { dbPath, taskId } = options;
  const handle = openReadOnlyDatabase(dbPath);

  try {
    const { store, db } = handle;

    // Helper queries on read-only DB directly to avoid mutating state
    const getTaskRow = (id: string): TaskRecord | null => store.getTask(id);

    const getRelationRow = (childId: string): TaskRelationRecord | null => {
      const stmt = db.prepare(`SELECT * FROM task_relations WHERE child_task_id = ?`);
      const row = stmt.get(childId) as any;
      if (!row) return null;
      return {
        childTaskId: row.child_task_id,
        parentTaskId: row.parent_task_id,
        depth: Number(row.depth),
        ordinal: Number(row.ordinal),
        createdAt: row.created_at,
      };
    };

    const listChildrenRows = (parentId: string): TaskRelationRecord[] => {
      const stmt = db.prepare(
        `SELECT * FROM task_relations WHERE parent_task_id = ? ORDER BY ordinal ASC, child_task_id ASC`
      );
      const rows = stmt.all(parentId) as any[];
      return rows.map((row) => ({
        childTaskId: row.child_task_id,
        parentTaskId: row.parent_task_id,
        depth: Number(row.depth),
        ordinal: Number(row.ordinal),
        createdAt: row.created_at,
      }));
    };

    const getSubmissionRow = (id: string): RouterSubmissionRecord | null => {
      const stmt = db.prepare(`SELECT * FROM router_submissions WHERE task_id = ?`);
      const row = stmt.get(id) as any;
      if (!row) return null;
      return {
        submissionKey: row.submission_key,
        taskId: row.task_id,
        runId: row.run_id,
        requestHash: row.request_hash,
        createdAt: row.created_at,
      };
    };

    const rootTask = getTaskRow(taskId);
    if (!rootTask) {
      throw new Error(`Task not found: ${taskId}`);
    }

    let totalNodes = 0;
    const visited = new Set<string>();

    const buildNode = (currTaskId: string, parentTaskId: string | null, depth: number, ordinal: number): TaskTreeNode => {
      if (visited.has(currTaskId)) {
        throw new Error(`Cycle detected at task '${currTaskId}'`);
      }
      visited.add(currTaskId);
      totalNodes++;

      const task = getTaskRow(currTaskId);
      const sub = getSubmissionRow(currTaskId);
      const run = sub ? store.getRun(sub.runId) : null;
      const runStatus = run?.status ?? null;

      // Determine dispatch eligibility
      let dispatchEligibility: DispatchEligibility;
      let eligibilityReason: string;

      if (!sub) {
        dispatchEligibility = "UNROUTED";
        eligibilityReason = "Task exists without a router submission";
      } else if (!parentTaskId) {
        if (runStatus && ["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(runStatus)) {
          dispatchEligibility = "DISPATCHED";
          eligibilityReason = `Task already dispatched (run status: ${runStatus})`;
        } else {
          dispatchEligibility = "ROOT_ELIGIBLE";
          eligibilityReason = "Root task is directly eligible for dispatch";
        }
      } else {
        // Child task with parent: check parent submission and run status
        const parentSub = getSubmissionRow(parentTaskId);
        const parentRun = parentSub ? store.getRun(parentSub.runId) : null;

        if (!parentSub || !parentRun) {
          dispatchEligibility = "BLOCKED_PARENT_FAILED";
          eligibilityReason = `Parent task '${parentTaskId}' has no active or completed run`;
        } else if (parentRun.status === "COMPLETED") {
          if (runStatus && ["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(runStatus)) {
            dispatchEligibility = "DISPATCHED";
            eligibilityReason = `Task already dispatched (run status: ${runStatus})`;
          } else {
            dispatchEligibility = "READY";
            eligibilityReason = `Parent task '${parentTaskId}' completed successfully`;
          }
        } else if (["FAILED", "CANCELLED", "TIMED_OUT"].includes(parentRun.status)) {
          dispatchEligibility = "BLOCKED_PARENT_FAILED";
          eligibilityReason = `Parent task '${parentTaskId}' ended with terminal status ${parentRun.status}`;
        } else {
          dispatchEligibility = "WAITING_PARENT";
          eligibilityReason = `Parent task '${parentTaskId}' is still in progress (${parentRun.status})`;
        }
      }

      // Recursively build children
      const childRelations = listChildrenRows(currTaskId);
      const children = childRelations.map((rel) =>
        buildNode(rel.childTaskId, currTaskId, depth + 1, rel.ordinal)
      );

      return {
        taskId: currTaskId,
        title: task?.title ?? null,
        description: task?.description ?? null,
        depth,
        ordinal,
        parentTaskId,
        runId: sub?.runId ?? null,
        runStatus,
        dispatchEligibility,
        eligibilityReason,
        children,
      };
    };

    const tree = buildNode(taskId, getRelationRow(taskId)?.parentTaskId ?? null, 0, 0);

    return {
      rootTaskId: taskId,
      totalNodes,
      tree,
    };
  } finally {
    handle.close();
  }
}

/**
 * Formats a TaskTreeReport into readable CLI text output with indented ASCII hierarchy.
 */
export function formatTaskTreeReport(report: TaskTreeReport): string {
  const lines: string[] = [
    `Task Tree: ${report.rootTaskId} (${report.totalNodes} node(s))`,
    `============================================================`,
  ];

  const renderNode = (node: TaskTreeNode, prefix: string, isLast: boolean, isRoot: boolean): void => {
    const statusTag = node.runStatus ? `[${node.runStatus}]` : "[UNROUTED]";
    const runTag = node.runId ? `(run: ${node.runId})` : "";
    const eligibilityTag = `[${node.dispatchEligibility} - ${node.eligibilityReason}]`;

    if (isRoot) {
      lines.push(`* ${node.taskId} ${statusTag} ${runTag} ${eligibilityTag}`.trim());
    } else {
      const connector = isLast ? "└── " : "├── ";
      lines.push(`${prefix}${connector}${node.taskId} ${statusTag} ${runTag} ${eligibilityTag}`.trim());
    }

    const childPrefix = isRoot ? "" : prefix + (isLast ? "    " : "│   ");
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i]!;
      const childIsLast = i === node.children.length - 1;
      renderNode(child, childPrefix, childIsLast, false);
    }
  };

  renderNode(report.tree, "", true, true);
  return lines.join("\n");
}

// ============================================================================
// Phase D — Durable Event Timeline Implementation
// ============================================================================

/**
 * Summarizes an event into a concise human-readable one-liner.
 */
function summarizeEvent(eventType: string, producer: string, payload: any): string {
  switch (eventType) {
    case "run.created":
      return `Run created for task ${payload?.taskId ?? ""}`;
    case "run.queued":
      return "Run queued for worker assignment";
    case "worker.claimed":
      return `Worker '${payload?.workerId ?? producer}' claimed run`;
    case "sandbox.created":
      return `Sandbox created (${payload?.sandboxId ?? ""})`;
    case "sandbox.ready":
      return "Sandbox environment ready";
    case "agent.step.started":
      return `Agent step ${payload?.stepNumber ?? ""} started`;
    case "tool.requested":
      return `Tool requested: ${payload?.toolName ?? "unknown"}`;
    case "tool.completed":
      return `Tool completed: ${payload?.toolName ?? "unknown"} (exit: ${payload?.exitCode ?? 0})`;
    case "policy.checked":
      return `Policy checked: ${payload?.rule ?? "default"} - ${payload?.allowed ? "ALLOWED" : "DENIED"}`;
    case "policy.denied":
      return `Policy denied tool ${payload?.toolName ?? ""}: ${payload?.reason ?? ""}`;
    case "verification.started":
      return "Clean-room verification started";
    case "verification.completed":
      return `Verification ${payload?.passed || payload?.verified ? "PASSED" : "FAILED"}`;
    case "run.completed":
      return "Run completed successfully";
    case "run.failed":
      return `Run failed: ${payload?.error?.message ?? payload?.message ?? "Execution failure"}`;
    case "run.cancelled":
      return `Run cancelled: ${payload?.reason ?? "Operator cancellation"}`;
    case "run.timed_out":
      return "Run timed out";
    default:
      return `${eventType} by ${producer}`;
  }
}

/**
 * Queries and returns sequence-ordered, paginated, and sanitized events for a run.
 */
export function getRunEventTimeline(options: RunEventTimelineOptions): RunEventTimelineReport {
  const { dbPath, runId, limit = 50, afterSequence = 0 } = options;
  const handle = openReadOnlyDatabase(dbPath);

  try {
    const { db, store } = handle;
    const run = store.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    const countStmt = db.prepare(`SELECT COUNT(*) as count FROM run_events WHERE run_id = ?`);
    const countRow = countStmt.get(runId) as { count: number } | undefined;
    const totalEvents = countRow ? Number(countRow.count) : 0;

    const eventStmt = db.prepare(
      `SELECT event_id, run_id, sequence, timestamp, event_type, schema_version, producer, payload
       FROM run_events
       WHERE run_id = ? AND sequence > ?
       ORDER BY sequence ASC
       LIMIT ?`
    );

    const rows = eventStmt.all(runId, afterSequence, limit) as any[];
    const events: TimelineEventSummary[] = rows.map((row) => {
      let rawPayload: unknown = null;
      try {
        rawPayload = JSON.parse(row.payload);
      } catch {
        rawPayload = row.payload;
      }

      const sanitizedPayload = redactSensitivePayload(rawPayload);
      const summary = summarizeEvent(row.event_type, row.producer, sanitizedPayload);

      return {
        eventId: row.event_id,
        sequence: Number(row.sequence),
        timestamp: row.timestamp,
        eventType: row.event_type,
        producer: row.producer,
        summary,
        payload: sanitizedPayload,
      };
    });

    return {
      runId,
      totalEvents,
      returnedCount: events.length,
      afterSequence,
      limit,
      events,
    };
  } finally {
    handle.close();
  }
}

/**
 * Formats a RunEventTimelineReport into readable CLI text output.
 */
export function formatRunEventTimelineReport(report: RunEventTimelineReport): string {
  const lines: string[] = [
    `Event Timeline: ${report.runId}`,
    `============================================================`,
    `Total Events: ${report.totalEvents} | Returned: ${report.returnedCount} (after sequence: ${report.afterSequence}, limit: ${report.limit})`,
    ``,
  ];

  if (report.events.length === 0) {
    lines.push(`(No events found matching sequence criteria)`);
    return lines.join("\n");
  }

  for (const e of report.events) {
    lines.push(`[Seq ${e.sequence}] ${e.timestamp} | ${e.eventType} (by ${e.producer})`);
    lines.push(`  Summary: ${e.summary}`);
  }

  return lines.join("\n");
}
