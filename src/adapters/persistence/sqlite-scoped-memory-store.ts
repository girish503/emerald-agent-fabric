/**
 * Durable SQLite Adapter for Scoped Context Memory.
 *
 * Persistence guarantees:
 * - Shares SQLite connection, WAL mode, busy_timeout, and schema migrations with SqliteStateStore.
 * - All writes execute inside BEGIN IMMEDIATE transactions; callers receive results only after COMMIT.
 * - Bounded retry loop handles transient SQLITE_BUSY / SQLITE_LOCKED contention fail-closed.
 * - Hydrated rows are validated for Truth Firewall invariants, contentHash integrity, timestamps, and metadata JSON.
 * - Zero silent fallback to in-memory storage on any persistence failure.
 */

import type { DatabaseSync } from "node:sqlite";
import { sha256Hex } from "../../domain/canonical-hash.js";
import {
  DEFAULT_MAX_QUERY_LIMIT,
  MAX_MEMORY_METADATA_BYTES,
  MemoryCorruptRecordError,
  MemoryExpiredError,
  MemoryIdempotencyConflictError,
  MemoryIsolationError,
  MemoryNotFoundError,
  MemoryPersistenceError,
  MemoryStorageUnavailableError,
  MemoryValidationError,
  MemoryVersionConflictError,
  TruthFirewallViolationError,
  assertBoundedContent,
  assertOptionalIdentifier,
  assertRequiredScopeIdentifier,
  assertTruthFirewallInvariant,
  assertValidIsoTimestamp,
  assertValidMemoryScope,
  computeMemoryPayloadFingerprint,
  isValidMemoryScope,
  type MemoryEntry,
} from "../../domain/scoped-memory.js";
import type {
  CreateMemoryEntryRecord,
  DeleteMemoryEntryRequest,
  MemoryPersistResult,
  MemoryQueryFilter,
  MemoryScopeIdentity,
  PurgeExpiredMemoriesRequest,
  ScopedMemoryStorePort,
  UpdateMemoryEntryRecord,
} from "../../ports/scoped-memory-store.port.js";
import { migrateDatabase } from "./schema.js";
import { createSqliteClient, type SqliteClientConfig } from "./sqlite-client.js";

const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(SLEEP_ARRAY, 0, 0, ms);
}

function isSqliteBusyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as { code?: unknown; errcode?: unknown; message?: unknown };
  const code = typeof anyErr.code === "string" ? anyErr.code : "";
  const errcode = typeof anyErr.errcode === "number" ? anyErr.errcode : 0;
  const msg = typeof anyErr.message === "string" ? anyErr.message.toLowerCase() : "";
  return (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_LOCKED" ||
    errcode === 5 ||
    errcode === 6 ||
    msg.includes("database is locked") ||
    msg.includes("database table is locked") ||
    msg.includes("sqlite_busy") ||
    msg.includes("sqlite_locked")
  );
}

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface DbScopedMemoryRow {
  readonly _rowid?: number | bigint;
  readonly memory_id: string;
  readonly tenant_id: unknown;
  readonly task_id: unknown;
  readonly run_id: unknown;
  readonly agent_id: unknown;
  readonly scope: unknown;
  readonly source: unknown;
  readonly is_model_generated: unknown;
  readonly is_independently_verified: unknown;
  readonly content: unknown;
  readonly content_hash: unknown;
  readonly estimated_tokens: unknown;
  readonly metadata_json: unknown;
  readonly idempotency_key: unknown;
  readonly version: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly expires_at: unknown;
}

function parseIsoStrict(value: unknown, entryId: string, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || Number.isNaN(Date.parse(value))) {
    throw new MemoryCorruptRecordError(entryId, `invalid ${fieldName} timestamp '${String(value)}'`);
  }
  return new Date(value).toISOString();
}

function parseMetadataStrict(raw: unknown, entryId: string): Record<string, unknown> | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new MemoryCorruptRecordError(entryId, "metadata_json must be a string or NULL");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new MemoryCorruptRecordError(
      entryId,
      `corrupt metadata_json JSON: ${formatErrorMessage(err)}`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MemoryCorruptRecordError(entryId, "metadata_json must decode to a plain object");
  }
  return parsed as Record<string, unknown>;
}

function mapRowToMemoryEntry(row: DbScopedMemoryRow): MemoryEntry {
  const entryId = typeof row.memory_id === "string" && row.memory_id.trim().length > 0
    ? row.memory_id
    : "<unknown>";
  if (entryId === "<unknown>") {
    throw new MemoryCorruptRecordError(entryId, "missing or empty memory_id");
  }
  if (typeof row.tenant_id !== "string" || row.tenant_id.trim().length === 0) {
    throw new MemoryCorruptRecordError(entryId, "missing or empty tenant_id");
  }
  if (typeof row.task_id !== "string" || row.task_id.trim().length === 0) {
    throw new MemoryCorruptRecordError(entryId, "missing or empty task_id");
  }
  if (row.run_id !== null && row.run_id !== undefined && (typeof row.run_id !== "string" || row.run_id.trim().length === 0)) {
    throw new MemoryCorruptRecordError(entryId, "corrupt run_id");
  }
  if (row.agent_id !== null && row.agent_id !== undefined && (typeof row.agent_id !== "string" || row.agent_id.trim().length === 0)) {
    throw new MemoryCorruptRecordError(entryId, "corrupt agent_id");
  }
  if (!isValidMemoryScope(row.scope)) {
    throw new MemoryCorruptRecordError(entryId, `invalid scope '${String(row.scope)}'`);
  }
  if (typeof row.source !== "string" || row.source.trim().length === 0) {
    throw new MemoryCorruptRecordError(entryId, "missing or empty source");
  }
  if (row.is_model_generated !== 0 && row.is_model_generated !== 1) {
    throw new MemoryCorruptRecordError(entryId, `invalid is_model_generated flag '${String(row.is_model_generated)}'`);
  }
  if (row.is_independently_verified !== 0 && row.is_independently_verified !== 1) {
    throw new MemoryCorruptRecordError(entryId, `invalid is_independently_verified flag '${String(row.is_independently_verified)}'`);
  }
  if (typeof row.content !== "string") {
    throw new MemoryCorruptRecordError(entryId, "content must be a string");
  }
  if (typeof row.content_hash !== "string" || row.content_hash.length !== 64) {
    throw new MemoryCorruptRecordError(entryId, "missing or malformed content_hash");
  }
  const actualHash = sha256Hex(row.content);
  if (actualHash !== row.content_hash) {
    throw new MemoryCorruptRecordError(
      entryId,
      `content_hash mismatch (expected '${row.content_hash}', computed '${actualHash}')`
    );
  }

  const isModelGenerated = row.is_model_generated === 1;
  const isIndependentlyVerified = row.is_independently_verified === 1;
  if (isModelGenerated && (isIndependentlyVerified || row.scope === "VERIFIED_EVIDENCE")) {
    throw new MemoryCorruptRecordError(
      entryId,
      "Truth Firewall invariant violated in persisted record"
    );
  }

  if (typeof row.estimated_tokens !== "number" || !Number.isInteger(row.estimated_tokens) || row.estimated_tokens < 0) {
    throw new MemoryCorruptRecordError(entryId, `invalid estimated_tokens '${String(row.estimated_tokens)}'`);
  }
  if (typeof row.version !== "number" || !Number.isInteger(row.version) || row.version < 1) {
    throw new MemoryCorruptRecordError(entryId, `invalid version '${String(row.version)}'`);
  }

  const createdAt = parseIsoStrict(row.created_at, entryId, "created_at");
  const updatedAt = parseIsoStrict(row.updated_at, entryId, "updated_at");
  const expiresAt =
    row.expires_at !== null && row.expires_at !== undefined
      ? parseIsoStrict(row.expires_at, entryId, "expires_at")
      : null;

  const metadata = parseMetadataStrict(row.metadata_json, entryId);
  const idempotencyKey =
    row.idempotency_key !== null && row.idempotency_key !== undefined
      ? String(row.idempotency_key)
      : null;

  return {
    id: entryId,
    tenantId: row.tenant_id,
    taskId: row.task_id,
    runId: row.run_id ?? null,
    agentId: row.agent_id ?? null,
    scope: row.scope,
    source: row.source,
    isModelGenerated,
    isIndependentlyVerified,
    content: row.content,
    timestamp: createdAt,
    createdAt,
    updatedAt,
    expiresAt,
    version: row.version,
    estimatedTokens: row.estimated_tokens,
    contentHash: row.content_hash,
    idempotencyKey,
    sequence: row._rowid !== undefined ? Number(row._rowid) : undefined,
    metadata,
  };
}

export interface SqliteScopedMemoryStoreOptions {
  readonly maxBusyRetries?: number;
  readonly busyRetryDelayMs?: number;
  readonly maxQueryLimit?: number;
}

export class SqliteScopedMemoryStore implements ScopedMemoryStorePort {
  private readonly db: DatabaseSync;
  private readonly ownsConnection: boolean;
  private readonly maxBusyRetries: number;
  private readonly busyRetryDelayMs: number;
  private readonly maxQueryLimit: number;
  private closed = false;

  constructor(
    dbOrConfig?: DatabaseSync | (SqliteClientConfig & SqliteScopedMemoryStoreOptions),
    options: SqliteScopedMemoryStoreOptions = {}
  ) {
    const isDb = Boolean(dbOrConfig && typeof (dbOrConfig as DatabaseSync).exec === "function");
    const resolvedOptions = isDb
      ? options
      : { ...((dbOrConfig as SqliteScopedMemoryStoreOptions | undefined) ?? {}), ...options };

    const rawBusyRetries = resolvedOptions.maxBusyRetries;
    this.maxBusyRetries =
      rawBusyRetries !== undefined && Number.isFinite(rawBusyRetries)
        ? Math.max(0, Math.floor(rawBusyRetries))
        : 5;
    const rawRetryDelay = resolvedOptions.busyRetryDelayMs;
    this.busyRetryDelayMs =
      rawRetryDelay !== undefined && Number.isFinite(rawRetryDelay)
        ? Math.max(1, Math.floor(rawRetryDelay))
        : 20;
    const rawMaxLimit = resolvedOptions.maxQueryLimit;
    this.maxQueryLimit =
      rawMaxLimit !== undefined && Number.isFinite(rawMaxLimit)
        ? Math.max(1, Math.floor(rawMaxLimit))
        : DEFAULT_MAX_QUERY_LIMIT;

    try {
      if (isDb) {
        this.db = dbOrConfig as DatabaseSync;
        this.ownsConnection = false;
        this.runWithBusyRetry("migrate", () => {
          migrateDatabase(this.db);
        });
      } else {
        this.db = createSqliteClient(dbOrConfig as SqliteClientConfig | undefined);
        this.ownsConnection = true;
      }
    } catch (err) {
      if (err instanceof MemoryPersistenceError) {
        throw err;
      }
      throw new MemoryStorageUnavailableError("initialize", formatErrorMessage(err));
    }
  }

  public getDatabase(): DatabaseSync {
    this.assertOpen("getDatabase");
    return this.db;
  }

  public insertMemoryEntry(record: CreateMemoryEntryRecord): MemoryPersistResult {
    this.assertOpen("insertMemoryEntry");

    const id = assertRequiredScopeIdentifier(record.id, "id");
    const tenantId = assertRequiredScopeIdentifier(record.tenantId, "tenantId");
    const taskId = assertRequiredScopeIdentifier(record.taskId, "taskId");
    const runId = assertOptionalIdentifier(record.runId, "runId");
    const agentId = assertOptionalIdentifier(record.agentId, "agentId");
    const scope = assertValidMemoryScope(record.scope);
    const source = assertRequiredScopeIdentifier(record.source, "source");
    const content = assertBoundedContent(record.content);
    const createdAt = assertValidIsoTimestamp(record.createdAt, "createdAt");
    const updatedAt = assertValidIsoTimestamp(record.updatedAt, "updatedAt");
    const expiresAt =
      record.expiresAt !== null && record.expiresAt !== undefined
        ? assertValidIsoTimestamp(record.expiresAt, "expiresAt")
        : null;
    const idempotencyKey = assertOptionalIdentifier(record.idempotencyKey, "idempotencyKey");

    assertTruthFirewallInvariant({
      entryId: id,
      scope,
      isModelGenerated: record.isModelGenerated,
      isIndependentlyVerified: record.isIndependentlyVerified,
    });

    if (record.contentHash !== sha256Hex(content)) {
      throw new MemoryValidationError("contentHash does not match SHA-256 of content");
    }
    if (!Number.isInteger(record.estimatedTokens) || record.estimatedTokens < 0) {
      throw new MemoryValidationError("estimatedTokens must be a non-negative integer");
    }
    if (record.metadataJson !== null) {
      if (typeof record.metadataJson !== "string") {
        throw new MemoryValidationError("metadataJson must be a string or null");
      }
      const metaBytes = Buffer.byteLength(record.metadataJson, "utf8");
      if (metaBytes > MAX_MEMORY_METADATA_BYTES) {
        throw new MemoryValidationError(
          `Memory metadata size (${metaBytes} bytes) exceeds limit (${MAX_MEMORY_METADATA_BYTES} bytes)`
        );
      }
    }

    return this.withImmediateTransaction("insertMemoryEntry", () => {
      if (idempotencyKey !== null) {
        const existingRow = this.db
          .prepare(
            `SELECT rowid AS _rowid, * FROM scoped_memories
             WHERE tenant_id = ? AND task_id = ? AND idempotency_key = ?`
          )
          .get(tenantId, taskId, idempotencyKey) as DbScopedMemoryRow | undefined;

        if (existingRow) {
          const existing = mapRowToMemoryEntry(existingRow);
          const existingFingerprint = computeMemoryPayloadFingerprint({
            scope: existing.scope,
            source: existing.source,
            contentHash: existing.contentHash,
            isModelGenerated: existing.isModelGenerated,
            isIndependentlyVerified: existing.isIndependentlyVerified,
            runId: existing.runId ?? null,
            agentId: existing.agentId ?? null,
          });
          const incomingFingerprint = computeMemoryPayloadFingerprint({
            scope,
            source,
            contentHash: record.contentHash,
            isModelGenerated: record.isModelGenerated,
            isIndependentlyVerified: record.isIndependentlyVerified,
            runId,
            agentId,
          });

          if (existingFingerprint !== incomingFingerprint) {
            throw new MemoryIdempotencyConflictError(tenantId, taskId, idempotencyKey);
          }

          return { entry: existing, isDuplicate: true };
        }
      }

      const stmt = this.db.prepare(
        `INSERT INTO scoped_memories (
          memory_id, tenant_id, task_id, run_id, agent_id,
          scope, source, is_model_generated, is_independently_verified,
          content, content_hash, estimated_tokens, metadata_json,
          idempotency_key, version, created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
      );

      stmt.run(
        id,
        tenantId,
        taskId,
        runId,
        agentId,
        scope,
        source,
        record.isModelGenerated ? 1 : 0,
        record.isIndependentlyVerified ? 1 : 0,
        content,
        record.contentHash,
        record.estimatedTokens,
        record.metadataJson,
        idempotencyKey,
        createdAt,
        updatedAt,
        expiresAt
      );

      const persistedRow = this.db
        .prepare(`SELECT rowid AS _rowid, * FROM scoped_memories WHERE memory_id = ?`)
        .get(id) as DbScopedMemoryRow | undefined;

      if (!persistedRow) {
        throw new MemoryStorageUnavailableError(
          "insertMemoryEntry",
          `Inserted entry '${id}' could not be read back inside transaction`
        );
      }

      return {
        entry: mapRowToMemoryEntry(persistedRow),
        isDuplicate: false,
      };
    });
  }

  public getMemoryEntry(
    id: string,
    identity: MemoryScopeIdentity,
    options: { readonly nowIso?: string; readonly allowExpired?: boolean } = {}
  ): MemoryEntry | null {
    this.assertOpen("getMemoryEntry");

    const entryId = assertRequiredScopeIdentifier(id, "id");
    const tenantId = assertRequiredScopeIdentifier(identity?.tenantId, "tenantId");
    const taskId = assertRequiredScopeIdentifier(identity?.taskId, "taskId");
    const expectedRunId = identity.runId !== undefined ? assertRequiredScopeIdentifier(identity.runId, "runId") : undefined;
    const expectedAgentId = identity.agentId !== undefined ? assertRequiredScopeIdentifier(identity.agentId, "agentId") : undefined;
    const nowIso = assertValidIsoTimestamp(options.nowIso ?? new Date().toISOString(), "nowIso");

    const row = this.runWithBusyRetry("getMemoryEntry", () =>
      this.db
        .prepare(`SELECT rowid AS _rowid, * FROM scoped_memories WHERE memory_id = ?`)
        .get(entryId) as DbScopedMemoryRow | undefined
    );

    if (!row) {
      return null;
    }

    const entry = mapRowToMemoryEntry(row);

    if (entry.tenantId !== tenantId || entry.taskId !== taskId) {
      throw new MemoryIsolationError(
        `Cross-scope memory read denied for entry '${entryId}' under tenant '${tenantId}' task '${taskId}'`
      );
    }
    if (expectedRunId !== undefined && entry.runId !== expectedRunId) {
      throw new MemoryIsolationError(
        `Cross-run memory read denied for entry '${entryId}' under run '${expectedRunId}'`
      );
    }
    if (expectedAgentId !== undefined && entry.agentId !== expectedAgentId) {
      throw new MemoryIsolationError(
        `Cross-agent memory read denied for entry '${entryId}' under agent '${expectedAgentId}'`
      );
    }

    if (!options.allowExpired && entry.expiresAt && Date.parse(entry.expiresAt) <= Date.parse(nowIso)) {
      throw new MemoryExpiredError(entry.id, entry.expiresAt);
    }

    return entry;
  }

  public queryMemoryEntries(filter: MemoryQueryFilter): readonly MemoryEntry[] {
    this.assertOpen("queryMemoryEntries");

    const tenantId = assertRequiredScopeIdentifier(filter?.tenantId, "tenantId");
    const taskId = assertRequiredScopeIdentifier(filter?.taskId, "taskId");
    const nowIso = assertValidIsoTimestamp(filter.nowIso, "nowIso");
    const runId = filter.runId !== undefined ? assertRequiredScopeIdentifier(filter.runId, "runId") : undefined;
    const agentId = filter.agentId !== undefined ? assertRequiredScopeIdentifier(filter.agentId, "agentId") : undefined;

    const scopes = filter.scopes?.map((s) => assertValidMemoryScope(s));
    if (filter.limit !== undefined && (!Number.isFinite(filter.limit) || filter.limit < 1)) {
      throw new MemoryValidationError("Query limit must be a positive finite number");
    }
    if (filter.offset !== undefined && (!Number.isFinite(filter.offset) || filter.offset < 0)) {
      throw new MemoryValidationError("Query offset must be a non-negative finite number");
    }
    const limit = Math.min(
      Math.max(1, Math.floor(filter.limit ?? this.maxQueryLimit)),
      this.maxQueryLimit
    );
    const offset = Math.max(0, Math.floor(filter.offset ?? 0));
    const orderSql = filter.order === "DESC" ? "DESC" : "ASC";

    const clauses: string[] = ["tenant_id = ?", "task_id = ?"];
    const params: Array<string | number> = [tenantId, taskId];

    if (runId !== undefined) {
      clauses.push("run_id = ?");
      params.push(runId);
    }
    if (agentId !== undefined) {
      clauses.push("agent_id = ?");
      params.push(agentId);
    }
    if (scopes && scopes.length > 0) {
      const placeholders = scopes.map(() => "?").join(", ");
      clauses.push(`scope IN (${placeholders})`);
      params.push(...scopes);
    }
    if (!filter.includeExpired) {
      clauses.push("(expires_at IS NULL OR expires_at > ?)");
      params.push(nowIso);
    }

    params.push(limit, offset);

    const sql = `
      SELECT rowid AS _rowid, *
      FROM scoped_memories
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at ${orderSql}, rowid ${orderSql}
      LIMIT ? OFFSET ?
    `;

    const rows = this.runWithBusyRetry("queryMemoryEntries", () =>
      this.db.prepare(sql).all(...params) as unknown as DbScopedMemoryRow[]
    );

    const nowMs = Date.parse(nowIso);
    const entries: MemoryEntry[] = [];
    for (const row of rows) {
      const entry = mapRowToMemoryEntry(row);
      if (!filter.includeExpired && entry.expiresAt && Date.parse(entry.expiresAt) <= nowMs) {
        continue;
      }
      entries.push(entry);
    }
    return entries;
  }

  public updateMemoryEntry(update: UpdateMemoryEntryRecord): MemoryEntry {
    this.assertOpen("updateMemoryEntry");

    const id = assertRequiredScopeIdentifier(update.id, "id");
    const tenantId = assertRequiredScopeIdentifier(update.tenantId, "tenantId");
    const taskId = assertRequiredScopeIdentifier(update.taskId, "taskId");
    const expectedRunId =
      update.runId !== undefined && update.runId !== null
        ? assertRequiredScopeIdentifier(update.runId, "runId")
        : update.runId;
    const expectedAgentId =
      update.agentId !== undefined && update.agentId !== null
        ? assertRequiredScopeIdentifier(update.agentId, "agentId")
        : update.agentId;
    const updatedAt = assertValidIsoTimestamp(update.updatedAt, "updatedAt");
    if (update.estimatedTokens !== undefined && (!Number.isInteger(update.estimatedTokens) || update.estimatedTokens < 0)) {
      throw new MemoryValidationError("estimatedTokens must be a non-negative integer");
    }
    if (update.metadataJson !== undefined && update.metadataJson !== null) {
      if (typeof update.metadataJson !== "string") {
        throw new MemoryValidationError("metadataJson must be a string or null");
      }
      const metaBytes = Buffer.byteLength(update.metadataJson, "utf8");
      if (metaBytes > MAX_MEMORY_METADATA_BYTES) {
        throw new MemoryValidationError(
          `Memory metadata size (${metaBytes} bytes) exceeds limit (${MAX_MEMORY_METADATA_BYTES} bytes)`
        );
      }
    }

    return this.withImmediateTransaction("updateMemoryEntry", () => {
      const existingRow = this.db
        .prepare(`SELECT rowid AS _rowid, * FROM scoped_memories WHERE memory_id = ?`)
        .get(id) as DbScopedMemoryRow | undefined;

      if (!existingRow) {
        throw new MemoryNotFoundError(id, tenantId, taskId);
      }

      const existing = mapRowToMemoryEntry(existingRow);

      if (existing.tenantId !== tenantId || existing.taskId !== taskId) {
        throw new MemoryIsolationError(
          `Cross-scope memory update denied for entry '${id}' under tenant '${tenantId}' task '${taskId}'`
        );
      }
      if (expectedRunId !== undefined && existing.runId !== expectedRunId) {
        throw new MemoryIsolationError(
          `Cross-run memory update denied for entry '${id}' under run '${String(expectedRunId)}'`
        );
      }
      if (expectedAgentId !== undefined && existing.agentId !== expectedAgentId) {
        throw new MemoryIsolationError(
          `Cross-agent memory update denied for entry '${id}' under agent '${String(expectedAgentId)}'`
        );
      }

      if (existing.expiresAt && Date.parse(existing.expiresAt) <= Date.parse(updatedAt)) {
        throw new MemoryExpiredError(existing.id, existing.expiresAt);
      }

      if (update.expectedVersion !== undefined && existing.version !== update.expectedVersion) {
        throw new MemoryVersionConflictError(id, update.expectedVersion, existing.version);
      }

      if (existing.isModelGenerated && update.isModelGenerated === false) {
        throw new TruthFirewallViolationError(
          `Truth Firewall violation on entry '${id}': cannot strip isModelGenerated provenance on update`
        );
      }

      const nextIsModelGenerated = update.isModelGenerated ?? existing.isModelGenerated;
      const nextScope = update.scope !== undefined ? assertValidMemoryScope(update.scope) : existing.scope;
      const nextVerified = update.isIndependentlyVerified ?? existing.isIndependentlyVerified;

      assertTruthFirewallInvariant({
        entryId: id,
        scope: nextScope,
        isModelGenerated: nextIsModelGenerated,
        isIndependentlyVerified: nextVerified,
      });

      const nextContent = update.content !== undefined ? assertBoundedContent(update.content) : existing.content;
      const nextContentHash = update.content !== undefined ? sha256Hex(nextContent) : existing.contentHash;
      if (update.contentHash !== undefined && update.contentHash !== nextContentHash) {
        throw new MemoryValidationError("Provided contentHash does not match updated content");
      }
      const nextTokens = update.estimatedTokens ?? Math.ceil(nextContent.length / 4);
      const nextExpiresAt =
        update.expiresAt === undefined
          ? existing.expiresAt ?? null
          : update.expiresAt === null
            ? null
            : assertValidIsoTimestamp(update.expiresAt, "expiresAt");
      const nextMetadataJson =
        update.metadataJson === undefined
          ? (existingRow.metadata_json as string | null)
          : update.metadataJson;

      const res = this.db
        .prepare(
          `UPDATE scoped_memories
           SET scope = ?,
               is_model_generated = ?,
               is_independently_verified = ?,
               content = ?,
               content_hash = ?,
               estimated_tokens = ?,
               metadata_json = ?,
               expires_at = ?,
               updated_at = ?,
               version = version + 1
           WHERE memory_id = ? AND tenant_id = ? AND task_id = ? AND version = ?`
        )
        .run(
          nextScope,
          nextIsModelGenerated ? 1 : 0,
          nextVerified ? 1 : 0,
          nextContent,
          nextContentHash,
          nextTokens,
          nextMetadataJson,
          nextExpiresAt,
          updatedAt,
          id,
          tenantId,
          taskId,
          existing.version
        );

      if (Number(res.changes) !== 1) {
        throw new MemoryVersionConflictError(id, existing.version, existing.version);
      }

      const updatedRow = this.db
        .prepare(`SELECT rowid AS _rowid, * FROM scoped_memories WHERE memory_id = ?`)
        .get(id) as DbScopedMemoryRow | undefined;

      if (!updatedRow) {
        throw new MemoryStorageUnavailableError(
          "updateMemoryEntry",
          `Updated entry '${id}' could not be read back inside transaction`
        );
      }

      return mapRowToMemoryEntry(updatedRow);
    });
  }

  public deleteMemoryEntry(request: DeleteMemoryEntryRequest): boolean {
    this.assertOpen("deleteMemoryEntry");

    const id = assertRequiredScopeIdentifier(request.id, "id");
    const tenantId = assertRequiredScopeIdentifier(request.tenantId, "tenantId");
    const taskId = assertRequiredScopeIdentifier(request.taskId, "taskId");
    const expectedRunId =
      request.runId !== undefined ? assertRequiredScopeIdentifier(request.runId, "runId") : undefined;
    const expectedAgentId =
      request.agentId !== undefined ? assertRequiredScopeIdentifier(request.agentId, "agentId") : undefined;

    return this.withImmediateTransaction("deleteMemoryEntry", () => {
      const existingRow = this.db
        .prepare(`SELECT rowid AS _rowid, * FROM scoped_memories WHERE memory_id = ?`)
        .get(id) as DbScopedMemoryRow | undefined;

      if (!existingRow) {
        return false;
      }

      if (existingRow.tenant_id !== tenantId || existingRow.task_id !== taskId) {
        throw new MemoryIsolationError(
          `Cross-scope memory delete denied for entry '${id}' under tenant '${tenantId}' task '${taskId}'`
        );
      }
      if (expectedRunId !== undefined && existingRow.run_id !== expectedRunId) {
        throw new MemoryIsolationError(
          `Cross-run memory delete denied for entry '${id}' under run '${expectedRunId}'`
        );
      }
      if (expectedAgentId !== undefined && existingRow.agent_id !== expectedAgentId) {
        throw new MemoryIsolationError(
          `Cross-agent memory delete denied for entry '${id}' under agent '${expectedAgentId}'`
        );
      }

      if (request.expectedVersion !== undefined) {
        const currentVersion = Number(existingRow.version);
        if (currentVersion !== request.expectedVersion) {
          throw new MemoryVersionConflictError(id, request.expectedVersion, currentVersion);
        }
      }

      const res = this.db
        .prepare(
          `DELETE FROM scoped_memories
           WHERE memory_id = ? AND tenant_id = ? AND task_id = ?`
        )
        .run(id, tenantId, taskId);

      return Number(res.changes) === 1;
    });
  }

  public purgeExpiredMemoryEntries(request: PurgeExpiredMemoriesRequest): number {
    this.assertOpen("purgeExpiredMemoryEntries");

    const tenantId = assertRequiredScopeIdentifier(request.tenantId, "tenantId");
    const taskId = request.taskId !== undefined ? assertRequiredScopeIdentifier(request.taskId, "taskId") : undefined;
    const runId = request.runId !== undefined ? assertRequiredScopeIdentifier(request.runId, "runId") : undefined;
    const nowIso = assertValidIsoTimestamp(request.nowIso, "nowIso");

    const clauses = ["tenant_id = ?", "expires_at IS NOT NULL", "expires_at <= ?"];
    const params: string[] = [tenantId, nowIso];

    if (taskId !== undefined) {
      clauses.push("task_id = ?");
      params.push(taskId);
    }
    if (runId !== undefined) {
      clauses.push("run_id = ?");
      params.push(runId);
    }

    return this.withImmediateTransaction("purgeExpiredMemoryEntries", () => {
      const res = this.db
        .prepare(`DELETE FROM scoped_memories WHERE ${clauses.join(" AND ")}`)
        .run(...params);
      return Number(res.changes);
    });
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsConnection) {
      this.db.close();
    }
  }

  private assertOpen(operation: string): void {
    if (this.closed) {
      throw new MemoryStorageUnavailableError(operation, "SQLite store connection is closed");
    }
  }

  private runWithBusyRetry<T>(operation: string, fn: () => T): T {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxBusyRetries; attempt++) {
      try {
        return fn();
      } catch (err) {
        if (err instanceof MemoryPersistenceError) {
          throw err;
        }
        if (isSqliteBusyError(err) && attempt < this.maxBusyRetries) {
          lastError = err;
          sleepSync(this.busyRetryDelayMs * (attempt + 1));
          continue;
        }
        if (isSqliteBusyError(err)) {
          throw new MemoryStorageUnavailableError(
            operation,
            `SQLite busy/locked after ${attempt + 1} attempts: ${formatErrorMessage(err)}`
          );
        }
        throw new MemoryStorageUnavailableError(operation, formatErrorMessage(err));
      }
    }
    throw new MemoryStorageUnavailableError(operation, formatErrorMessage(lastError));
  }

  private withImmediateTransaction<T>(operation: string, fn: () => T): T {
    return this.runWithBusyRetry(operation, () => {
      if (this.db.isTransaction) {
        const spName = `sp_scoped_mem_${Date.now()}`;
        this.db.exec(`SAVEPOINT ${spName};`);
        try {
          const result = fn();
          this.db.exec(`RELEASE SAVEPOINT ${spName};`);
          return result;
        } catch (err) {
          try {
            this.db.exec(`ROLLBACK TO SAVEPOINT ${spName};`);
            this.db.exec(`RELEASE SAVEPOINT ${spName};`);
          } catch {
            // Safe guard if transaction already rolled back
          }
          throw err;
        }
      }

      this.db.exec("BEGIN IMMEDIATE;");
      try {
        const result = fn();
        this.db.exec("COMMIT;");
        return result;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK;");
        } catch {
          // Safe guard if SQLite already aborted transaction on constraint/error
        }
        throw err;
      }
    });
  }
}
