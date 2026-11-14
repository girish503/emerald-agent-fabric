/**
 * Scoped Context and Memory Continuity Engine for Emerald Agent Fabric.
 *
 * Implements durable SQLite-backed partitioned memory scopes, tenant & execution isolation,
 * provenance tracking, Truth Firewall enforcement, untrusted observation tagging,
 * TTL expiration, and bounded deduplicated context compilation:
 *
 * Invariants:
 * 1. Explicit Durability: Every write commits to a durable ScopedMemoryStorePort before
 *    returning an acknowledgment. Silent fallback to volatile in-memory storage is prohibited.
 * 2. Scope & Execution Partitioning: Strictly isolates entries by tenantId, taskId, runId,
 *    agentId, and MemoryScope across restarts.
 * 3. Truth Firewall: Model-generated memory is marked `isModelGenerated: true` and can NEVER
 *    become `isIndependentlyVerified: true` or occupy `VERIFIED_EVIDENCE` across persistence,
 *    updates, retrieval, agent handoff, or prompt compilation.
 * 4. Bounded Context Selection: Deduplicates repeated failure/observation clutter and selects
 *    entries deterministically within `maxTokens` while separating VERIFIED_FACT,
 *    UNVERIFIED_OBSERVATION, and MODEL_HYPOTHESIS entries.
 */

import * as crypto from "node:crypto";
import { sha256Hex } from "../domain/canonical-hash.js";
import type { SuperAgentRole } from "../domain/super-agent.js";
import { SystemClock, type ClockPort } from "../ports/clock.port.js";
import type { EmeraldLifecycleTelemetry } from "./observability-instrumentation.js";
import type {
  DeleteMemoryEntryRequest,
  MemoryPersistResult,
  MemoryScopeIdentity,
  PurgeExpiredMemoriesRequest,
  ScopedMemoryStorePort,
} from "../ports/scoped-memory-store.port.js";
import {
  ALL_MEMORY_SCOPES,
  MemoryCorruptRecordError,
  MemoryExpiredError,
  MemoryIdempotencyConflictError,
  MemoryIsolationError,
  MemoryNotFoundError,
  MemoryPersistenceError,
  MemoryStorageUnavailableError,
  MemoryStoreConfigurationError,
  MemoryValidationError,
  MemoryVersionConflictError,
  TruthFirewallViolationError,
  assertBoundedContent,
  assertOptionalIdentifier,
  assertRequiredScopeIdentifier,
  assertTruthFirewallInvariant,
  assertValidIsoTimestamp,
  assertValidMemoryScope,
  classifyMemoryProvenance,
  serializeMemoryMetadata,
  type MemoryEntry,
  type MemoryProvenanceClassification,
  type MemoryScope,
} from "../domain/scoped-memory.js";

export {
  ALL_MEMORY_SCOPES,
  MemoryCorruptRecordError,
  MemoryExpiredError,
  MemoryIdempotencyConflictError,
  MemoryIsolationError,
  MemoryNotFoundError,
  MemoryPersistenceError,
  MemoryStorageUnavailableError,
  MemoryStoreConfigurationError,
  MemoryValidationError,
  MemoryVersionConflictError,
  TruthFirewallViolationError,
  classifyMemoryProvenance,
  type MemoryEntry,
  type MemoryProvenanceClassification,
  type MemoryScope,
};

export interface ScopedContextMemoryServiceOptions {
  readonly clock?: ClockPort;
  readonly defaultTtlMs?: number;
  readonly telemetry?: EmeraldLifecycleTelemetry;
}

export interface RecordMemoryOptions {
  readonly runId?: string;
  readonly agentId?: string;
  readonly isModelGenerated?: boolean;
  readonly isIndependentlyVerified?: boolean;
  readonly strictTruthFirewall?: boolean;
  readonly metadata?: Record<string, unknown>;
  readonly idempotencyKey?: string;
  readonly ttlMs?: number;
  readonly expiresAt?: string;
  readonly nowIso?: string;
}

export interface QueryMemoriesOptions {
  readonly scopes?: readonly MemoryScope[];
  readonly runId?: string;
  readonly agentId?: string;
  readonly includeExpired?: boolean;
  readonly nowIso?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface UpdateMemoryOptions {
  readonly id: string;
  readonly tenantId: string;
  readonly taskId: string;
  readonly runId?: string;
  readonly agentId?: string;
  readonly expectedVersion?: number;
  readonly scope?: MemoryScope;
  readonly content?: string;
  readonly isIndependentlyVerified?: boolean;
  readonly isModelGenerated?: boolean;
  readonly metadata?: Record<string, unknown> | null;
  readonly ttlMs?: number;
  readonly expiresAt?: string | null;
  readonly nowIso?: string;
}

export interface ContextCompilationOptions {
  readonly maxTokens: number;
  readonly role: SuperAgentRole;
  readonly includeProjectKnowledge?: boolean;
  readonly includeAgentWorkingContext?: boolean;
  readonly runId?: string;
  readonly agentId?: string;
  readonly nowIso?: string;
  readonly maxObservations?: number;
  readonly deduplicate?: boolean;
}

export interface CompiledContextResult {
  readonly compiledPrompt: string;
  readonly totalTokens: number;
  readonly itemsIncluded: number;
  readonly includedEntryIds: readonly string[];
  readonly verifiedCount: number;
  readonly unverifiedObservationCount: number;
  readonly modelHypothesisCount: number;
  readonly deduplicatedCount: number;
}

function deduplicateByContentHashKeepLatest(entries: readonly MemoryEntry[]): {
  readonly items: MemoryEntry[];
  readonly dropped: number;
} {
  const seen = new Set<string>();
  const reversed: MemoryEntry[] = [];
  let dropped = 0;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    const key = `${entry.scope}::${entry.contentHash}`;
    if (seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    reversed.push(entry);
  }

  reversed.reverse();
  return { items: reversed, dropped };
}

function deduplicateByContentHashKeepFirst(entries: readonly MemoryEntry[]): {
  readonly items: MemoryEntry[];
  readonly dropped: number;
} {
  const seen = new Set<string>();
  const items: MemoryEntry[] = [];
  let dropped = 0;

  for (const entry of entries) {
    const key = `${entry.scope}::${entry.contentHash}`;
    if (seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    items.push(entry);
  }

  return { items, dropped };
}

function sanitizeSourceLabel(source: string): string {
  return source.replace(/[\r\n]+/g, " ").replace(/[\[\]]/g, "_");
}

function escapeSpoofedScopeHeaders(content: string): string {
  return content.replace(
    /^(\s*)\[(CURRENT_TASK_CONTEXT|DURABLE_TASK_HISTORY|PROJECT_KNOWLEDGE|AGENT_WORKING_CONTEXT|VERIFIED_EVIDENCE|UNTRUSTED_OBSERVATION)\]/gm,
    "$1> [ESCAPED_$2]"
  );
}

export class ScopedContextMemoryService {
  private readonly store: ScopedMemoryStorePort;
  private readonly clock: ClockPort;
  private readonly defaultTtlMs?: number;
  private readonly telemetry?: EmeraldLifecycleTelemetry;

  constructor(
    store: ScopedMemoryStorePort,
    options: ScopedContextMemoryServiceOptions = {}
  ) {
    if (
      !store ||
      typeof store.insertMemoryEntry !== "function" ||
      typeof store.getMemoryEntry !== "function" ||
      typeof store.queryMemoryEntries !== "function" ||
      typeof store.updateMemoryEntry !== "function" ||
      typeof store.deleteMemoryEntry !== "function" ||
      typeof store.purgeExpiredMemoryEntries !== "function"
    ) {
      throw new MemoryStoreConfigurationError(
        "ScopedContextMemoryService requires a durable ScopedMemoryStorePort; silent fallback to process-local memory is prohibited"
      );
    }

    if (options.defaultTtlMs !== undefined) {
      if (!Number.isFinite(options.defaultTtlMs) || options.defaultTtlMs <= 0) {
        throw new MemoryValidationError("defaultTtlMs must be a positive finite number");
      }
      this.defaultTtlMs = options.defaultTtlMs;
    }

    this.store = store;
    this.clock = options.clock ?? new SystemClock();
    this.telemetry = options.telemetry;
  }

  private resolveNowIso(suppliedNowIso?: string): string {
    if (suppliedNowIso !== undefined) {
      assertValidIsoTimestamp(suppliedNowIso, "nowIso");
    }
    return assertValidIsoTimestamp(this.clock.nowIso(), "clock.nowIso");
  }

  /**
   * Durably records a memory entry with explicit provenance and tenant/execution scoping.
   * Rejects empty tenantId/taskId, violates Truth Firewall on VERIFIED_EVIDENCE promotion,
   * and guarantees SQLite commit before returning.
   */
  public recordEntry(
    tenantId: string,
    taskId: string,
    scope: MemoryScope,
    source: string,
    content: string,
    options: RecordMemoryOptions = {}
  ): MemoryEntry {
    return this.recordEntryWithStatus(tenantId, taskId, scope, source, content, options).entry;
  }

  /**
   * Same as recordEntry, returning explicit idempotency duplicate receipt status.
   */
  public recordEntryWithStatus(
    tenantId: string,
    taskId: string,
    scope: MemoryScope,
    source: string,
    content: string,
    options: RecordMemoryOptions = {}
  ): MemoryPersistResult {
    const startMs = Date.now();
    try {
      const res = this.recordEntryWithStatusCore(tenantId, taskId, scope, source, content, options);
      this.telemetry?.recordMemoryOperation({
        operation: "write",
        scope: String(scope),
        outcome: "ok",
        durationMs: Date.now() - startMs,
      });
      return res;
    } catch (err) {
      this.telemetry?.recordMemoryOperation({
        operation: "write",
        scope: String(scope),
        outcome: err instanceof TruthFirewallViolationError ? "truth_firewall_rejected" : "error",
        durationMs: Date.now() - startMs,
      });
      throw err;
    }
  }

  private recordEntryWithStatusCore(
    tenantId: string,
    taskId: string,
    scope: MemoryScope,
    source: string,
    content: string,
    options: RecordMemoryOptions = {}
  ): MemoryPersistResult {
    const validTenantId = assertRequiredScopeIdentifier(tenantId, "tenantId");
    const validTaskId = assertRequiredScopeIdentifier(taskId, "taskId");
    const validScope = assertValidMemoryScope(scope);
    const validSource = assertRequiredScopeIdentifier(source, "source");
    const validContent = assertBoundedContent(content);
    const runId = assertOptionalIdentifier(options.runId, "runId");
    const agentId = assertOptionalIdentifier(options.agentId, "agentId");
    const idempotencyKey = assertOptionalIdentifier(options.idempotencyKey, "idempotencyKey");
    const nowIso = this.resolveNowIso(options.nowIso);

    const isModelGenerated = options.isModelGenerated ?? false;
    if (isModelGenerated && validScope === "VERIFIED_EVIDENCE") {
      throw new TruthFirewallViolationError(
        "Truth Firewall violation: model-generated content cannot be recorded under VERIFIED_EVIDENCE scope"
      );
    }
    if (isModelGenerated && options.isIndependentlyVerified && options.strictTruthFirewall) {
      throw new TruthFirewallViolationError(
        "Truth Firewall violation: model-generated content cannot claim independent verification"
      );
    }

    // Truth Firewall: Model-generated entries cannot claim independent verification
    const isIndependentlyVerified = isModelGenerated
      ? false
      : (options.isIndependentlyVerified ?? false);

    assertTruthFirewallInvariant({
      scope: validScope,
      isModelGenerated,
      isIndependentlyVerified,
    });

    const expiresAt = this.resolveExpiresAt(nowIso, options.expiresAt, options.ttlMs);
    const metadataJson = serializeMemoryMetadata(options.metadata);
    const estimatedTokens = Math.ceil(validContent.length / 4);
    const contentHash = sha256Hex(validContent);
    const id = `mem-${Date.parse(nowIso)}-${crypto.randomUUID()}`;

    return this.store.insertMemoryEntry({
      id,
      tenantId: validTenantId,
      taskId: validTaskId,
      runId,
      agentId,
      scope: validScope,
      source: validSource,
      isModelGenerated,
      isIndependentlyVerified,
      content: validContent,
      createdAt: nowIso,
      updatedAt: nowIso,
      expiresAt,
      estimatedTokens,
      contentHash,
      idempotencyKey,
      metadataJson,
    });
  }

  /**
   * Retrieves a specific memory entry by ID within explicit tenant/task(/run/agent) boundaries.
   * Rejects expired entries with MemoryExpiredError by default.
   */
  public getEntry(
    entryId: string,
    identity: MemoryScopeIdentity,
    options: { readonly nowIso?: string; readonly allowExpired?: boolean } = {}
  ): MemoryEntry | null {
    const validId = assertRequiredScopeIdentifier(entryId, "id");
    const validTenantId = assertRequiredScopeIdentifier(identity?.tenantId, "tenantId");
    const validTaskId = assertRequiredScopeIdentifier(identity?.taskId, "taskId");
    const nowIso = this.resolveNowIso(options.nowIso);

    return this.store.getMemoryEntry(
      validId,
      {
        tenantId: validTenantId,
        taskId: validTaskId,
        runId: identity.runId,
        agentId: identity.agentId,
      },
      { nowIso, allowExpired: options.allowExpired }
    );
  }

  /**
   * Retrieves memories for a task enforcing strict tenant, task, run, and agent isolation.
   * Expired entries are filtered out unless `includeExpired: true` is specified.
   */
  public queryMemories(
    tenantId: string,
    taskId: string,
    scopesOrOptions?: readonly MemoryScope[] | QueryMemoriesOptions
  ): readonly MemoryEntry[] {
    const validTenantId = assertRequiredScopeIdentifier(tenantId, "tenantId");
    const validTaskId = assertRequiredScopeIdentifier(taskId, "taskId");

    const opts: QueryMemoriesOptions = Array.isArray(scopesOrOptions)
      ? { scopes: scopesOrOptions }
      : ((scopesOrOptions as QueryMemoriesOptions | undefined) ?? {});

    const nowIso = this.resolveNowIso(opts.nowIso);

    return this.store.queryMemoryEntries({
      tenantId: validTenantId,
      taskId: validTaskId,
      scopes: opts.scopes,
      runId: opts.runId,
      agentId: opts.agentId,
      includeExpired: opts.includeExpired,
      nowIso,
      limit: opts.limit,
      offset: opts.offset,
    });
  }

  /**
   * Updates an existing durable memory entry transactionally with optimistic concurrency
   * and unbypassable Truth Firewall enforcement.
   */
  public updateEntry(options: UpdateMemoryOptions): MemoryEntry {
    const id = assertRequiredScopeIdentifier(options.id, "id");
    const tenantId = assertRequiredScopeIdentifier(options.tenantId, "tenantId");
    const taskId = assertRequiredScopeIdentifier(options.taskId, "taskId");
    const nowIso = this.resolveNowIso(options.nowIso);

    if (options.scope !== undefined) {
      assertValidMemoryScope(options.scope);
    }

    const content = options.content !== undefined ? assertBoundedContent(options.content) : undefined;
    const contentHash = content !== undefined ? sha256Hex(content) : undefined;
    const estimatedTokens = content !== undefined ? Math.ceil(content.length / 4) : undefined;

    if (options.expiresAt === null && options.ttlMs !== undefined) {
      throw new MemoryValidationError("Specify either expiresAt or ttlMs, not both");
    }
    let expiresAt: string | null | undefined = undefined;
    if (options.expiresAt === null) {
      expiresAt = null;
    } else if (options.expiresAt !== undefined || options.ttlMs !== undefined) {
      expiresAt = this.resolveExpiresAt(nowIso, options.expiresAt, options.ttlMs);
    }

    const metadataJson =
      options.metadata === undefined
        ? undefined
        : options.metadata === null
          ? null
          : serializeMemoryMetadata(options.metadata);

    return this.store.updateMemoryEntry({
      id,
      tenantId,
      taskId,
      runId: options.runId,
      agentId: options.agentId,
      expectedVersion: options.expectedVersion,
      scope: options.scope,
      content,
      contentHash,
      estimatedTokens,
      isIndependentlyVerified: options.isIndependentlyVerified,
      isModelGenerated: options.isModelGenerated,
      expiresAt,
      metadataJson,
      updatedAt: nowIso,
    });
  }

  /**
   * Deletes an entry inside caller's verified tenant/task scope.
   */
  public deleteEntry(request: DeleteMemoryEntryRequest): boolean {
    const id = assertRequiredScopeIdentifier(request.id, "id");
    const tenantId = assertRequiredScopeIdentifier(request.tenantId, "tenantId");
    const taskId = assertRequiredScopeIdentifier(request.taskId, "taskId");

    return this.store.deleteMemoryEntry({
      ...request,
      id,
      tenantId,
      taskId,
    });
  }

  /**
   * Deletes expired entries for a tenant (optionally scoped to task/run) and returns purged count.
   */
  public purgeExpiredEntries(request: Omit<PurgeExpiredMemoriesRequest, "nowIso"> & { readonly nowIso?: string }): number {
    const startMs = Date.now();
    const count = this.purgeExpiredEntriesCore(request);
    this.telemetry?.recordMemoryOperation({
      operation: "purge",
      scope: "ALL",
      outcome: "ok",
      durationMs: Date.now() - startMs,
      purgedCount: count,
    });
    return count;
  }

  private purgeExpiredEntriesCore(request: Omit<PurgeExpiredMemoriesRequest, "nowIso"> & { readonly nowIso?: string }): number {
    const tenantId = assertRequiredScopeIdentifier(request.tenantId, "tenantId");
    const nowIso = this.resolveNowIso(request.nowIso);
    return this.store.purgeExpiredMemoryEntries({
      tenantId,
      taskId: request.taskId,
      runId: request.runId,
      nowIso,
    });
  }

  /**
   * Compiles bounded, prioritized, deduplicated context for agent reasoning:
   * 1. Verified Evidence (highest priority; NEVER model-generated)
   * 2. Project Knowledge (when includeProjectKnowledge is true)
   * 3. Current Task Context (plus optional Agent Working Context)
   * 4. Most Recent Observations & Failure Feedback (UNTRUSTED_OBSERVATION / DURABLE_TASK_HISTORY)
   *
   * Distinguishes verified facts from unverified observations and model hypotheses,
   * eliminates duplicate failure feedback, and prunes strictly within `maxTokens`.
   */
  public compileContextForPrompt(
    tenantId: string,
    taskId: string,
    options: ContextCompilationOptions
  ): CompiledContextResult {
    const startMs = Date.now();
    try {
      const res = this.compileContextForPromptCore(tenantId, taskId, options);
      this.telemetry?.recordMemoryOperation({
        operation: "compile",
        scope: "ALL",
        outcome: "ok",
        durationMs: Date.now() - startMs,
      });
      return res;
    } catch (err) {
      this.telemetry?.recordMemoryOperation({
        operation: "compile",
        scope: "ALL",
        outcome: "error",
        durationMs: Date.now() - startMs,
      });
      throw err;
    }
  }

  private compileContextForPromptCore(
    tenantId: string,
    taskId: string,
    options: ContextCompilationOptions
  ): CompiledContextResult {
    const validTenantId = assertRequiredScopeIdentifier(tenantId, "tenantId");
    const validTaskId = assertRequiredScopeIdentifier(taskId, "taskId");

    if (!Number.isFinite(options.maxTokens) || options.maxTokens < 0) {
      throw new MemoryValidationError("maxTokens must be a non-negative finite number");
    }
    if (
      options.maxObservations !== undefined &&
      (!Number.isFinite(options.maxObservations) || options.maxObservations < 1)
    ) {
      throw new MemoryValidationError("maxObservations must be a positive finite number");
    }

    const nowIso = this.resolveNowIso(options.nowIso);
    const deduplicate = options.deduplicate ?? true;
    const maxObservations = Math.max(1, Math.floor(options.maxObservations ?? 5));

    // Query each priority tier explicitly by scope so noisy early observations (>500)
    // can never crowd out VERIFIED_EVIDENCE or the newest observations.
    const verifiedScopeEntries = this.store.queryMemoryEntries({
      tenantId: validTenantId,
      taskId: validTaskId,
      scopes: ["VERIFIED_EVIDENCE"],
      runId: options.runId,
      agentId: options.agentId,
      nowIso,
    });
    const rawVerified = verifiedScopeEntries.filter(
      (e) => e.scope === "VERIFIED_EVIDENCE" && !e.isModelGenerated
    );

    const rawProject = options.includeProjectKnowledge
      ? this.store.queryMemoryEntries({
          tenantId: validTenantId,
          taskId: validTaskId,
          scopes: ["PROJECT_KNOWLEDGE"],
          runId: options.runId,
          agentId: options.agentId,
          nowIso,
        })
      : [];

    const currentScopes: MemoryScope[] = options.includeAgentWorkingContext
      ? ["CURRENT_TASK_CONTEXT", "AGENT_WORKING_CONTEXT"]
      : ["CURRENT_TASK_CONTEXT"];
    const rawCurrent = this.store.queryMemoryEntries({
      tenantId: validTenantId,
      taskId: validTaskId,
      scopes: currentScopes,
      runId: options.runId,
      agentId: options.agentId,
      nowIso,
    });

    // Fetch newest observations first so high-volume logs never truncate recent failures,
    // then restore chronological ordering before deduplicating/slicing.
    const obsWindowLimit = deduplicate ? Math.max(maxObservations * 4, 50) : maxObservations;
    const newestObservationsDesc = this.store.queryMemoryEntries({
      tenantId: validTenantId,
      taskId: validTaskId,
      scopes: ["UNTRUSTED_OBSERVATION", "DURABLE_TASK_HISTORY"],
      runId: options.runId,
      agentId: options.agentId,
      nowIso,
      order: "DESC",
      limit: obsWindowLimit,
    });
    const rawObservations = [...newestObservationsDesc].reverse();

    const verifiedDedup = deduplicate
      ? deduplicateByContentHashKeepFirst(rawVerified)
      : { items: rawVerified, dropped: 0 };
    const projectDedup = deduplicate
      ? deduplicateByContentHashKeepFirst(rawProject)
      : { items: rawProject, dropped: 0 };
    const currentDedup = deduplicate
      ? deduplicateByContentHashKeepLatest(rawCurrent)
      : { items: rawCurrent, dropped: 0 };
    const obsDedup = deduplicate
      ? deduplicateByContentHashKeepLatest(rawObservations)
      : { items: rawObservations, dropped: 0 };

    const boundedObservations = obsDedup.items.slice(-maxObservations);
    const deduplicatedCount =
      verifiedDedup.dropped + projectDedup.dropped + currentDedup.dropped + obsDedup.dropped;

    const prioritizedQueue: MemoryEntry[] = [
      ...verifiedDedup.items,
      ...projectDedup.items,
      ...currentDedup.items,
      ...boundedObservations,
    ];

    let runningTokens = 0;
    const selectedEntries: MemoryEntry[] = [];

    for (const entry of prioritizedQueue) {
      if (runningTokens + entry.estimatedTokens <= options.maxTokens) {
        selectedEntries.push(entry);
        runningTokens += entry.estimatedTokens;
      }
    }

    let verifiedCount = 0;
    let unverifiedObservationCount = 0;
    let modelHypothesisCount = 0;

    const sections = selectedEntries.map((e) => {
      const classification = classifyMemoryProvenance(e);
      if (classification === "VERIFIED_FACT") {
        verifiedCount++;
      } else if (classification === "MODEL_HYPOTHESIS") {
        modelHypothesisCount++;
      } else {
        unverifiedObservationCount++;
      }

      const safeSource = sanitizeSourceLabel(e.source);
      const renderedContent =
        classification === "VERIFIED_FACT" ? e.content : escapeSpoofedScopeHeaders(e.content);
      const header = `[${e.scope}] (Source: ${safeSource}, Verified: ${e.isIndependentlyVerified}, Classification: ${classification})`;
      return `${header}\n${renderedContent}`;
    });

    return {
      compiledPrompt: sections.join("\n\n"),
      totalTokens: runningTokens,
      itemsIncluded: selectedEntries.length,
      includedEntryIds: selectedEntries.map((e) => e.id),
      verifiedCount,
      unverifiedObservationCount,
      modelHypothesisCount,
      deduplicatedCount,
    };
  }

  private resolveExpiresAt(
    nowIso: string,
    explicitExpiresAt?: string,
    explicitTtlMs?: number
  ): string | null {
    if (explicitExpiresAt !== undefined && explicitTtlMs !== undefined) {
      throw new MemoryValidationError("Specify either expiresAt or ttlMs, not both");
    }
    if (explicitExpiresAt !== undefined) {
      return assertValidIsoTimestamp(explicitExpiresAt, "expiresAt");
    }
    const ttlMs = explicitTtlMs ?? this.defaultTtlMs;
    if (ttlMs !== undefined) {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new MemoryValidationError("ttlMs must be a positive finite number");
      }
      return new Date(Date.parse(nowIso) + ttlMs).toISOString();
    }
    return null;
  }
}
