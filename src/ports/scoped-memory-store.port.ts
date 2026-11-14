/**
 * Storage port for Durable Scoped Context Memory.
 * Free of SQLite or infrastructure details; enforces fail-closed durability,
 * strict tenant/execution scoping, optimistic concurrency, and Truth Firewall checks.
 */

import type { MemoryEntry, MemoryScope } from "../domain/scoped-memory.js";

export interface CreateMemoryEntryRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly taskId: string;
  readonly runId: string | null;
  readonly agentId: string | null;
  readonly scope: MemoryScope;
  readonly source: string;
  readonly isModelGenerated: boolean;
  readonly isIndependentlyVerified: boolean;
  readonly content: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string | null;
  readonly estimatedTokens: number;
  readonly contentHash: string;
  readonly idempotencyKey: string | null;
  readonly metadataJson: string | null;
}

export interface MemoryPersistResult {
  readonly entry: MemoryEntry;
  readonly isDuplicate: boolean;
}

export interface MemoryScopeIdentity {
  readonly tenantId: string;
  readonly taskId: string;
  readonly runId?: string;
  readonly agentId?: string;
}

export interface MemoryQueryFilter {
  readonly tenantId: string;
  readonly taskId: string;
  readonly scopes?: readonly MemoryScope[];
  readonly runId?: string;
  readonly agentId?: string;
  readonly includeExpired?: boolean;
  readonly nowIso: string;
  readonly order?: "ASC" | "DESC";
  readonly limit?: number;
  readonly offset?: number;
}

export interface UpdateMemoryEntryRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly taskId: string;
  readonly runId?: string;
  readonly agentId?: string;
  readonly expectedVersion?: number;
  readonly scope?: MemoryScope;
  readonly content?: string;
  readonly contentHash?: string;
  readonly estimatedTokens?: number;
  readonly isIndependentlyVerified?: boolean;
  readonly isModelGenerated?: boolean;
  readonly expiresAt?: string | null;
  readonly metadataJson?: string | null;
  readonly updatedAt: string;
}

export interface DeleteMemoryEntryRequest {
  readonly id: string;
  readonly tenantId: string;
  readonly taskId: string;
  readonly runId?: string;
  readonly agentId?: string;
  readonly expectedVersion?: number;
}

export interface PurgeExpiredMemoriesRequest {
  readonly tenantId: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly nowIso: string;
}

export interface ScopedMemoryStorePort {
  insertMemoryEntry(record: CreateMemoryEntryRecord): MemoryPersistResult;

  getMemoryEntry(
    id: string,
    identity: MemoryScopeIdentity,
    options?: { readonly nowIso?: string; readonly allowExpired?: boolean }
  ): MemoryEntry | null;

  queryMemoryEntries(filter: MemoryQueryFilter): readonly MemoryEntry[];

  updateMemoryEntry(update: UpdateMemoryEntryRecord): MemoryEntry;

  deleteMemoryEntry(request: DeleteMemoryEntryRequest): boolean;

  purgeExpiredMemoryEntries(request: PurgeExpiredMemoriesRequest): number;
}
