/**
 * Durable SQLite Adapter for Versioned Run Traces (Idea 3, Phase 1).
 *
 * Reuses the existing SQLite WAL database, `createSqliteClient`, and schema migrations.
 * Validates every trace with `RunTraceSchema` on both write and read so corrupt
 * or unredacted payloads fail closed.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  RunTrace,
  RunTraceSchema,
  TraceSpan,
  TraceSpanSchema,
  validateRunTrace,
} from "../../domain/trace.js";
import {
  TraceReplayReport,
  validateTraceReplayReport,
} from "../../domain/trace-replay.js";
import {
  TraceDiff,
  TraceDiffSchema,
  TraceSetScorecard,
  TraceSetScorecardSchema,
  computeScorecardHash,
  computeTraceDiffHash,
} from "../../domain/trace-diff.js";
import { migrateDatabase } from "./schema.js";
import { createSqliteClient, type SqliteClientConfig } from "./sqlite-client.js";

export interface ListTracesFilter {
  readonly missionId?: string;
  readonly tenantId?: string;
  readonly status?: string;
  readonly limit?: number;
}

interface DbRunTraceRow {
  readonly trace_id: string;
  readonly run_id: string;
  readonly mission_id: string;
  readonly format_version: string;
  readonly tenant_id: string;
  readonly status: string;
  readonly created_at: string;
  readonly recorded_at: string;
  readonly span_count: number;
  readonly trace_json: string;
}

interface DbTraceSpanRow {
  readonly span_json: string;
}

export class SqliteTraceStore {
  private readonly db: DatabaseSync;
  private readonly ownsConnection: boolean;
  private closed = false;

  constructor(dbOrConfig?: DatabaseSync | SqliteClientConfig) {
    const isDb = Boolean(dbOrConfig && typeof (dbOrConfig as DatabaseSync).exec === "function");
    if (isDb) {
      this.db = dbOrConfig as DatabaseSync;
      this.ownsConnection = false;
      const hasTable = this.db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'trace_scorecards'`)
        .get();
      if (!hasTable) {
        migrateDatabase(this.db);
      }
    } else {
      this.db = createSqliteClient(dbOrConfig as SqliteClientConfig | undefined);
      this.ownsConnection = true;
    }
  }

  /**
   * Validates and durably persists a `RunTrace` (and its indexed `trace_spans` rows)
   * inside an atomic `BEGIN IMMEDIATE` transaction.
   */
  writeTrace(trace: RunTrace, recordedAt: string = new Date().toISOString()): RunTrace {
    this.assertOpen();
    const validated = validateRunTrace(trace);
    const traceJson = JSON.stringify(validated);

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.db
        .prepare(`SELECT trace_id FROM run_traces WHERE run_id = ?`)
        .get(validated.runId) as { trace_id: string } | undefined;

      if (existing && existing.trace_id !== validated.traceId) {
        this.db.prepare(`DELETE FROM run_traces WHERE trace_id = ?`).run(existing.trace_id);
      }

      this.db
        .prepare(
          `INSERT INTO run_traces (
             trace_id, run_id, mission_id, format_version, tenant_id,
             status, created_at, recorded_at, span_count, trace_json
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(trace_id) DO UPDATE SET
             run_id = excluded.run_id,
             mission_id = excluded.mission_id,
             format_version = excluded.format_version,
             tenant_id = excluded.tenant_id,
             status = excluded.status,
             created_at = excluded.created_at,
             recorded_at = excluded.recorded_at,
             span_count = excluded.span_count,
             trace_json = excluded.trace_json`
        )
        .run(
          validated.traceId,
          validated.runId,
          validated.missionId,
          validated.formatVersion,
          validated.tenantId,
          validated.status,
          validated.createdAt,
          recordedAt,
          validated.spans.length,
          traceJson
        );

      this.db.prepare(`DELETE FROM trace_spans WHERE trace_id = ?`).run(validated.traceId);

      const insertSpan = this.db.prepare(
        `INSERT INTO trace_spans (
           trace_id, span_index, span_id, parent_span_id, kind, name,
           status, provenance, started_at, ended_at, latency_ms,
           tokens_in, tokens_out, cost_usd, span_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (let i = 0; i < validated.spans.length; i++) {
        const span = validated.spans[i]!;
        insertSpan.run(
          validated.traceId,
          i,
          span.spanId,
          span.parentSpanId,
          span.kind,
          span.name,
          span.status,
          span.provenance,
          span.startedAt,
          span.endedAt,
          span.latencyMs,
          span.tokensIn,
          span.tokensOut,
          span.costUsd,
          JSON.stringify(span)
        );
      }

      this.db.exec("COMMIT;");
      return validated;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // ignore rollback error
      }
      throw err;
    }
  }

  /**
   * Reads and validates the `RunTrace` for a given `runId`, or returns `null` if absent.
   */
  readTraceByRunId(runId: string): RunTrace | null {
    this.assertOpen();
    const row = this.db
      .prepare(`SELECT * FROM run_traces WHERE run_id = ?`)
      .get(runId) as unknown as DbRunTraceRow | undefined;
    if (!row) return null;
    return this.decodeTraceRow(row);
  }

  /**
   * Reads and validates the `RunTrace` for a given `traceId`, or returns `null` if absent.
   */
  readTraceById(traceId: string): RunTrace | null {
    this.assertOpen();
    const row = this.db
      .prepare(`SELECT * FROM run_traces WHERE trace_id = ?`)
      .get(traceId) as unknown as DbRunTraceRow | undefined;
    if (!row) return null;
    return this.decodeTraceRow(row);
  }

  /**
   * Lists stored traces matching optional mission/tenant/status filters.
   */
  listTraces(filter: ListTracesFilter = {}): readonly RunTrace[] {
    this.assertOpen();
    const clauses: string[] = [];
    const args: Array<string | number> = [];

    if (filter.missionId !== undefined) {
      clauses.push("mission_id = ?");
      args.push(filter.missionId);
    }
    if (filter.tenantId !== undefined) {
      clauses.push("tenant_id = ?");
      args.push(filter.tenantId);
    }
    if (filter.status !== undefined) {
      clauses.push("status = ?");
      args.push(filter.status);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit =
      filter.limit !== undefined && Number.isFinite(filter.limit) && filter.limit > 0
        ? Math.floor(filter.limit)
        : 200;

    const rows = this.db
      .prepare(
        `SELECT * FROM run_traces ${where} ORDER BY created_at ASC, trace_id ASC LIMIT ?`
      )
      .all(...args, limit) as unknown as DbRunTraceRow[];

    return rows.map((row) => this.decodeTraceRow(row));
  }

  /**
   * Reads ordered spans for a trace directly from `trace_spans`.
   */
  readSpansForTrace(traceId: string): readonly TraceSpan[] {
    this.assertOpen();
    const rows = this.db
      .prepare(
        `SELECT span_json FROM trace_spans WHERE trace_id = ? ORDER BY span_index ASC`
      )
      .all(traceId) as unknown as DbTraceSpanRow[];

    return rows.map((row) => TraceSpanSchema.parse(JSON.parse(row.span_json)));
  }

  /**
   * Validates and durably persists a deterministic `TraceReplayReport` alongside traces.
   */
  writeReplayReport(
    report: TraceReplayReport,
    recordedAt: string = new Date().toISOString()
  ): TraceReplayReport {
    this.assertOpen();
    const validated = validateTraceReplayReport(report);
    const reportJson = JSON.stringify(validated);

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db
        .prepare(
          `INSERT INTO trace_replay_reports (
             trace_id, run_id, format_version, report_hash,
             passed, checks_passed, checks_failed, recorded_at, report_json
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(trace_id) DO UPDATE SET
             run_id = excluded.run_id,
             format_version = excluded.format_version,
             report_hash = excluded.report_hash,
             passed = excluded.passed,
             checks_passed = excluded.checks_passed,
             checks_failed = excluded.checks_failed,
             recorded_at = excluded.recorded_at,
             report_json = excluded.report_json`
        )
        .run(
          validated.traceId,
          validated.runId,
          validated.formatVersion,
          validated.reportHash,
          validated.passed ? 1 : 0,
          validated.checksPassed,
          validated.checksFailed,
          recordedAt,
          reportJson
        );
      this.db.exec("COMMIT;");
      return validated;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // ignore rollback error
      }
      throw err;
    }
  }

  /**
   * Reads and hash-verifies a stored `TraceReplayReport` for a `traceId`, or returns `null`.
   */
  readReplayReportByTraceId(traceId: string): TraceReplayReport | null {
    this.assertOpen();
    const row = this.db
      .prepare(`SELECT report_json FROM trace_replay_reports WHERE trace_id = ?`)
      .get(traceId) as { report_json: string } | undefined;
    if (!row) return null;
    return validateTraceReplayReport(JSON.parse(row.report_json));
  }

  /**
   * Lists stored `TraceReplayReport` entries ordered deterministically by `trace_id`.
   */
  listReplayReports(limit: number = 200): readonly TraceReplayReport[] {
    this.assertOpen();
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;
    const rows = this.db
      .prepare(`SELECT report_json FROM trace_replay_reports ORDER BY trace_id ASC LIMIT ?`)
      .all(safeLimit) as Array<{ report_json: string }>;
    return rows.map((row) => validateTraceReplayReport(JSON.parse(row.report_json)));
  }

  /**
   * Validates and durably persists a deterministic `TraceDiff` beside traces/reports.
   */
  writeTraceDiff(
    diff: TraceDiff,
    recordedAt: string = new Date().toISOString()
  ): TraceDiff {
    this.assertOpen();
    const parsed = TraceDiffSchema.parse(diff);
    const { diffHash, ...body } = parsed;
    const expected = computeTraceDiffHash(body);
    if (diffHash !== expected) {
      throw new Error(`TraceDiff hash mismatch: expected '${expected}', got '${diffHash}'.`);
    }

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db
        .prepare(
          `INSERT INTO trace_diffs (diff_hash, old_trace_id, new_trace_id, is_empty, recorded_at, diff_json)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(diff_hash) DO UPDATE SET
             recorded_at = excluded.recorded_at,
             diff_json = excluded.diff_json`
        )
        .run(
          parsed.diffHash,
          parsed.oldTraceId,
          parsed.newTraceId,
          parsed.isEmpty ? 1 : 0,
          recordedAt,
          JSON.stringify(parsed)
        );
      this.db.exec("COMMIT;");
      return parsed;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // ignore rollback error
      }
      throw err;
    }
  }

  /**
   * Reads a stored `TraceDiff` by its canonical `diffHash`, or returns `null`.
   */
  readTraceDiffByHash(diffHash: string): TraceDiff | null {
    this.assertOpen();
    const row = this.db
      .prepare(`SELECT diff_json FROM trace_diffs WHERE diff_hash = ?`)
      .get(diffHash) as { diff_json: string } | undefined;
    if (!row) return null;
    return TraceDiffSchema.parse(JSON.parse(row.diff_json));
  }

  /**
   * Validates and durably persists a deterministic `TraceSetScorecard` beside traces/reports.
   */
  writeScorecard(
    scorecard: TraceSetScorecard,
    recordedAt: string = new Date().toISOString()
  ): TraceSetScorecard {
    this.assertOpen();
    const parsed = TraceSetScorecardSchema.parse(scorecard);
    const { scorecardHash, ...body } = parsed;
    const expected = computeScorecardHash(body);
    if (scorecardHash !== expected) {
      throw new Error(
        `TraceSetScorecard hash mismatch: expected '${expected}', got '${scorecardHash}'.`
      );
    }

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db
        .prepare(
          `INSERT INTO trace_scorecards (scorecard_id, scorecard_hash, total_traces, recorded_at, scorecard_json)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(scorecard_id) DO UPDATE SET
             scorecard_hash = excluded.scorecard_hash,
             total_traces = excluded.total_traces,
             recorded_at = excluded.recorded_at,
             scorecard_json = excluded.scorecard_json`
        )
        .run(
          parsed.scorecardId,
          parsed.scorecardHash,
          parsed.totalTraces,
          recordedAt,
          JSON.stringify(parsed)
        );
      this.db.exec("COMMIT;");
      return parsed;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // ignore rollback error
      }
      throw err;
    }
  }

  /**
   * Reads a stored `TraceSetScorecard` by `scorecardId`, or returns `null`.
   */
  readScorecardById(scorecardId: string): TraceSetScorecard | null {
    this.assertOpen();
    const row = this.db
      .prepare(`SELECT scorecard_json FROM trace_scorecards WHERE scorecard_id = ?`)
      .get(scorecardId) as { scorecard_json: string } | undefined;
    if (!row) return null;
    return TraceSetScorecardSchema.parse(JSON.parse(row.scorecard_json));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsConnection) {
      this.db.close();
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("SqliteTraceStore is closed.");
    }
  }

  private decodeTraceRow(row: DbRunTraceRow): RunTrace {
    const parsed = JSON.parse(row.trace_json);
    return RunTraceSchema.parse(parsed);
  }
}
