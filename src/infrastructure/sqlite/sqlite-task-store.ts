/**
 * Emerald Agent Fabric — SQLite Task Store
 *
 * Implements durable, tenant-scoped, keyset-paginated task listing without schema migration.
 * Ordering: (created_at DESC, task_id DESC) with tie-breaking.
 */

import type { DatabaseSync } from "node:sqlite";
import type { TaskSummary, TaskStatus } from "../../transport/http/api-contracts.js";
export type { TaskSummary };

export class InvalidCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCursorError";
  }
}

export interface TaskCursorData {
  readonly createdAt: string;
  readonly taskId: string;
  readonly tenantId: string;
  readonly status?: string | null;
}

export function encodeTaskCursor(data: TaskCursorData): string {
  const payload = {
    c: data.createdAt,
    t: data.taskId,
    te: data.tenantId,
    s: data.status ?? null,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeTaskCursor(
  rawCursor: string,
  expectedTenantId: string,
  expectedStatus?: string
): { createdAt: string; taskId: string } {
  if (typeof rawCursor !== "string" || rawCursor.trim().length === 0) {
    throw new InvalidCursorError("Malformed cursor: cursor string must not be empty");
  }

  let parsed: Record<string, unknown>;
  try {
    const json = Buffer.from(rawCursor, "base64url").toString("utf8");
    parsed = JSON.parse(json);
  } catch {
    throw new InvalidCursorError("Malformed cursor: not valid base64url or JSON");
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.c !== "string" ||
    typeof parsed.t !== "string" ||
    typeof parsed.te !== "string"
  ) {
    throw new InvalidCursorError("Malformed cursor: missing required cursor fields");
  }

  // Validate createdAt ISO datetime format
  if (isNaN(Date.parse(parsed.c))) {
    throw new InvalidCursorError("Malformed cursor: invalid createdAt date format");
  }

  // Validate tenant binding
  if (parsed.te !== expectedTenantId) {
    throw new InvalidCursorError(
      `Cursor tenant mismatch: cursor was issued for tenant '${parsed.te}' but requested by '${expectedTenantId}'`
    );
  }

  // Validate status filter binding
  const cursorStatus = (parsed.s as string | null | undefined) ?? null;
  const requestedStatus = expectedStatus ?? null;
  if (cursorStatus !== requestedStatus) {
    throw new InvalidCursorError(
      `Cursor filter mismatch: cursor was issued for status filter '${cursorStatus ?? "none"}' but requested with '${requestedStatus ?? "none"}'`
    );
  }

  return { createdAt: parsed.c, taskId: parsed.t };
}

export interface ListTasksOptions {
  readonly tenantId: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: TaskStatus;
}

export interface ListTasksResult {
  readonly tasks: readonly TaskSummary[];
  readonly nextCursor: string | null;
}

export class SqliteTaskStore {
  constructor(private readonly db: DatabaseSync) {}

  listTasks(options: ListTasksOptions): ListTasksResult {
    const tenantId = options.tenantId;
    if (!tenantId || typeof tenantId !== "string" || tenantId.trim().length === 0) {
      throw new Error("SqliteTaskStore.listTasks: tenantId must be a non-empty string");
    }

    const limit = Math.max(1, Math.min(100, options.limit ?? 20));
    const statusFilter = options.status ?? null;

    let cursorPoint: { createdAt: string; taskId: string } | null = null;
    if (options.cursor) {
      cursorPoint = decodeTaskCursor(options.cursor, tenantId, statusFilter ?? undefined);
    }

    const sql = `
SELECT
  t.task_id AS taskId,
  t.title AS title,
  t.description AS description,
  t.created_at AS createdAt,
  t.updated_at AS updatedAt,
  c.contract_id AS contractId,
  json_extract(c.canonical_spec, '$.policy.tenantId') AS tenantId,
  json_extract(c.canonical_spec, '$.policy.isolationRequirement') AS isolationRequirement,
  COALESCE(r.run_id, rs.run_id) AS runId,
  COALESCE(r.status, 'CREATED') AS status
FROM tasks t
JOIN mission_contracts c ON c.task_id = t.task_id
  AND c.version = (
    SELECT MAX(c2.version)
    FROM mission_contracts c2
    WHERE c2.task_id = t.task_id
  )
LEFT JOIN router_submissions rs ON rs.task_id = t.task_id
LEFT JOIN runs r ON (r.run_id = rs.run_id OR (r.task_id = t.task_id AND r.rowid = (SELECT MAX(r2.rowid) FROM runs r2 WHERE r2.task_id = t.task_id)))
WHERE json_extract(c.canonical_spec, '$.policy.tenantId') = ?
  AND (? IS NULL OR (t.created_at < ? OR (t.created_at = ? AND t.task_id < ?)))
  AND (? IS NULL OR COALESCE(r.status, 'CREATED') = ?)
ORDER BY t.created_at DESC, t.task_id DESC
LIMIT ?;
`;

    const cursorCreatedAt = cursorPoint ? cursorPoint.createdAt : null;
    const cursorTaskId = cursorPoint ? cursorPoint.taskId : null;

    const rows = this.db.prepare(sql).all(
      tenantId,
      cursorCreatedAt,
      cursorCreatedAt,
      cursorCreatedAt,
      cursorTaskId,
      statusFilter,
      statusFilter,
      limit + 1
    ) as Array<Record<string, unknown>>;

    const hasNext = rows.length > limit;
    const pageRows = hasNext ? rows.slice(0, limit) : rows;

    const tasks: TaskSummary[] = pageRows.map((row) => ({
      taskId: String(row.taskId),
      tenantId: String(row.tenantId ?? tenantId),
      title: String(row.title ?? ""),
      status: String(row.status ?? "CREATED") as TaskStatus,
      executionMode: (row.isolationRequirement === "IN_PROCESS" ? "constrained_host" : "sandboxed") as any,
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
      contractId: row.contractId ? String(row.contractId) : null,
      runId: row.runId ? String(row.runId) : undefined,
    }));

    let nextCursor: string | null = null;
    if (hasNext && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      if (last) {
        nextCursor = encodeTaskCursor({
          createdAt: String(last.createdAt),
          taskId: String(last.taskId),
          tenantId,
          status: statusFilter,
        });
      }
    }

    return { tasks, nextCursor };
  }

  getTaskById(taskId: string, tenantId: string): TaskSummary | null {
    if (!taskId || typeof taskId !== "string" || !tenantId || typeof tenantId !== "string") {
      return null;
    }

    const sql = `
SELECT
  t.task_id AS taskId,
  t.title AS title,
  t.created_at AS createdAt,
  t.updated_at AS updatedAt,
  c.contract_id AS contractId,
  json_extract(c.canonical_spec, '$.policy.tenantId') AS tenantId,
  json_extract(c.canonical_spec, '$.policy.isolationRequirement') AS isolationRequirement,
  COALESCE(r.run_id, rs.run_id) AS runId,
  COALESCE(r.status, 'CREATED') AS status,
  (SELECT tr.parent_task_id FROM task_relations tr WHERE tr.child_task_id = t.task_id LIMIT 1) AS parentTaskId,
  (SELECT COUNT(*) FROM task_relations tr2 WHERE tr2.parent_task_id = t.task_id) AS childTaskCount
FROM tasks t
JOIN mission_contracts c ON c.task_id = t.task_id
  AND c.version = (
    SELECT MAX(c2.version)
    FROM mission_contracts c2
    WHERE c2.task_id = t.task_id
  )
LEFT JOIN router_submissions rs ON rs.task_id = t.task_id
LEFT JOIN runs r ON (r.run_id = rs.run_id OR (r.task_id = t.task_id AND r.rowid = (SELECT MAX(r2.rowid) FROM runs r2 WHERE r2.task_id = t.task_id)))
WHERE t.task_id = ?
  AND json_extract(c.canonical_spec, '$.policy.tenantId') = ?
LIMIT 1;
`;

    const row = this.db.prepare(sql).get(taskId, tenantId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    const childCount = Number(row.childTaskCount ?? 0);
    return {
      taskId: String(row.taskId),
      tenantId: String(row.tenantId ?? tenantId),
      title: String(row.title ?? ""),
      status: String(row.status ?? "CREATED") as TaskStatus,
      executionMode: (row.isolationRequirement === "IN_PROCESS" ? "constrained_host" : "sandboxed") as any,
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
      contractId: row.contractId ? String(row.contractId) : null,
      ...(row.runId ? { runId: String(row.runId) } : {}),
      ...(row.parentTaskId ? { parentTaskId: String(row.parentTaskId) } : {}),
      ...(childCount > 0 ? { childTaskCount: childCount } : {}),
    };
  }
}
