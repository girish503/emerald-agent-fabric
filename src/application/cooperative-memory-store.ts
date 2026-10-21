/**
 * Phase 92: Cooperative Memory Store
 *
 * Append-oriented in-memory store for cooperative agent memory records.
 * Provides deterministic versioning, invalidation event tracking, provenance chains,
 * and Merkle root calculation.
 *
 * INVARIANTS:
 * - Silent deletion is strictly prohibited (M7).
 * - Records are keyed by (memoryId, version, contentDigest).
 * - Invalidation generates evidence and updates freshness/status, preserving history.
 */

import {
  MemoryRecord,
  computeMemoryRecordDigest,
  validateMemoryRecordIntegrity,
} from "../domain/cooperative-memory.js";
import { canonicalJsonStringify, sha256Hex } from "../domain/canonical-hash.js";

export interface MemoryInvalidationEvent {
  readonly eventId: string;
  readonly memoryId: string;
  readonly version: number;
  readonly reason: string;
  readonly trigger: "FILE_CHANGE" | "SYMBOL_CHANGE" | "REVISION_CHANGE" | "REVOCATION" | "EXPIRATION";
  readonly details: Record<string, unknown>;
  readonly invalidatedAt: string;
}

export function computeStoreMerkleRoot(entryHashes: readonly string[]): string {
  if (entryHashes.length === 0) {
    return sha256Hex("EMPTY_COOPERATIVE_MEMORY_STORE");
  }

  let currentLevel = [...entryHashes];

  while (currentLevel.length > 1) {
    const nextLevel: string[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i] ?? "";
      const right = i + 1 < currentLevel.length ? currentLevel[i + 1] ?? left : left;
      const combined = canonicalJsonStringify([left, right]);
      nextLevel.push(sha256Hex(combined));
    }
    currentLevel = nextLevel;
  }

  return currentLevel[0] ?? sha256Hex("EMPTY_COOPERATIVE_MEMORY_STORE");
}

export class CooperativeMemoryStore {
  // Key: memoryId -> versions array (sorted ascending by version)
  private readonly recordsByMemoryId: Map<string, MemoryRecord[]> = new Map();
  // All append events in order
  private readonly history: MemoryRecord[] = [];
  // Invalidation evidence log
  private readonly invalidationLog: MemoryInvalidationEvent[] = [];

  /**
   * Appends a new memory record.
   * If a record with memoryId already exists, the new record must have version = previous + 1.
   */
  public append(record: MemoryRecord): MemoryRecord {
    const integrity = validateMemoryRecordIntegrity(record);
    if (!integrity.valid) {
      throw new Error(`Invalid memory record: ${integrity.errors.join(", ")}`);
    }

    const versions = this.recordsByMemoryId.get(record.memoryId) ?? [];
    if (versions.length > 0) {
      const latest = versions[versions.length - 1];
      if (!latest) {
        throw new Error("Internal error: latest version undefined");
      }
      if (record.version <= latest.version) {
        throw new Error(
          `Version non-monotonic: new version ${record.version} <= existing latest ${latest.version}`
        );
      }
      // Check for content duplicate within same memoryId
      if (latest.contentDigest === record.contentDigest) {
        throw new Error(
          `Duplicate content digest ${record.contentDigest} for memoryId ${record.memoryId}`
        );
      }
    } else {
      if (record.version !== 1) {
        // Enforce initial version = 1
        throw new Error(`Initial version for new memoryId must be 1, got ${record.version}`);
      }
    }

    const updatedList = [...versions, record];
    this.recordsByMemoryId.set(record.memoryId, updatedList);
    this.history.push(record);

    return record;
  }

  /**
   * Reads a memory record. If version is omitted, returns the latest active/superseded version.
   */
  public read(memoryId: string, version?: number): MemoryRecord | undefined {
    const versions = this.recordsByMemoryId.get(memoryId);
    if (!versions || versions.length === 0) {
      return undefined;
    }
    if (version !== undefined) {
      return versions.find((r) => r.version === version);
    }
    return versions[versions.length - 1];
  }

  /**
   * Queries memory records by a filter predicate.
   */
  public query(predicate: (r: MemoryRecord) => boolean): readonly MemoryRecord[] {
    const results: MemoryRecord[] = [];
    for (const record of this.history) {
      if (predicate(record)) {
        results.push(record);
      }
    }
    return Object.freeze(results);
  }

  /**
   * Supersedes an existing memory record with a newer version.
   */
  public supersede(memoryId: string, newRecord: MemoryRecord): MemoryRecord {
    const versions = this.recordsByMemoryId.get(memoryId);
    if (!versions || versions.length === 0) {
      throw new Error(`Cannot supersede non-existent memoryId ${memoryId}`);
    }
    const current = versions[versions.length - 1];
    if (!current) {
      throw new Error("Internal error: current version undefined");
    }
    if (current.status !== "ACTIVE") {
      throw new Error(`Cannot supersede memory with status ${current.status}`);
    }

    // Mark current as superseded
    const supersededCurrent: MemoryRecord = {
      ...current,
      status: "SUPERSEDED",
    };
    versions[versions.length - 1] = supersededCurrent;

    // Append new record
    return this.append({
      ...newRecord,
      parentMemoryId: current.memoryId,
      version: current.version + 1,
    });
  }

  /**
   * Marks a memory record as EXPIRED deterministically.
   */
  public expire(memoryId: string, reason = "TTL_EXPIRED"): boolean {
    const versions = this.recordsByMemoryId.get(memoryId);
    if (!versions || versions.length === 0) {
      return false;
    }
    const latest = versions[versions.length - 1];
    if (!latest) {
      return false;
    }
    if (latest.freshness === "EXPIRED" || latest.status === "EXPIRED") {
      return false;
    }

    const expiredRecord: MemoryRecord = {
      ...latest,
      freshness: "EXPIRED",
      status: "EXPIRED",
    };
    versions[versions.length - 1] = expiredRecord;

    this.invalidationLog.push({
      eventId: `inv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      memoryId,
      version: latest.version,
      reason,
      trigger: "EXPIRATION",
      details: { previousStatus: latest.status },
      invalidatedAt: new Date().toISOString(),
    });

    return true;
  }

  /**
   * Revokes a memory record when source evidence or security constraints fail.
   */
  public revoke(memoryId: string, reason: string): boolean {
    const versions = this.recordsByMemoryId.get(memoryId);
    if (!versions || versions.length === 0) {
      return false;
    }
    const latest = versions[versions.length - 1];
    if (!latest) {
      return false;
    }
    if (latest.status === "REVOKED") {
      return false;
    }

    const revokedRecord: MemoryRecord = {
      ...latest,
      freshness: "REVOKED",
      status: "REVOKED",
    };
    versions[versions.length - 1] = revokedRecord;

    this.invalidationLog.push({
      eventId: `inv-rev-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      memoryId,
      version: latest.version,
      reason,
      trigger: "REVOCATION",
      details: { previousStatus: latest.status },
      invalidatedAt: new Date().toISOString(),
    });

    return true;
  }

  /**
   * Invalidation triggered when a referenced file changes.
   */
  public invalidateByFileChange(
    filePath: string,
    newRevision: string
  ): readonly MemoryRecord[] {
    const invalidated: MemoryRecord[] = [];
    for (const [memoryId, versions] of this.recordsByMemoryId.entries()) {
      const latest = versions[versions.length - 1];
      if (
        latest &&
        (latest.status === "ACTIVE" || latest.status === "VALIDATING") &&
        latest.referencedFiles &&
        latest.referencedFiles.includes(filePath)
      ) {
        const markedStale: MemoryRecord = {
          ...latest,
          freshness: "STALE",
        };
        versions[versions.length - 1] = markedStale;
        invalidated.push(markedStale);

        this.invalidationLog.push({
          eventId: `inv-file-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          memoryId,
          version: latest.version,
          reason: `Referenced file modified: ${filePath}`,
          trigger: "FILE_CHANGE",
          details: { filePath, newRevision },
          invalidatedAt: new Date().toISOString(),
        });
      }
    }
    return Object.freeze(invalidated);
  }

  /**
   * Invalidation triggered when a referenced code symbol changes.
   */
  public invalidateBySymbolChange(
    symbolName: string,
    newRevision: string
  ): readonly MemoryRecord[] {
    const invalidated: MemoryRecord[] = [];
    for (const [memoryId, versions] of this.recordsByMemoryId.entries()) {
      const latest = versions[versions.length - 1];
      if (
        latest &&
        (latest.status === "ACTIVE" || latest.status === "VALIDATING") &&
        latest.referencedSymbols &&
        latest.referencedSymbols.includes(symbolName)
      ) {
        const markedStale: MemoryRecord = {
          ...latest,
          freshness: "STALE",
        };
        versions[versions.length - 1] = markedStale;
        invalidated.push(markedStale);

        this.invalidationLog.push({
          eventId: `inv-sym-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          memoryId,
          version: latest.version,
          reason: `Referenced symbol modified: ${symbolName}`,
          trigger: "SYMBOL_CHANGE",
          details: { symbolName, newRevision },
          invalidatedAt: new Date().toISOString(),
        });
      }
    }
    return Object.freeze(invalidated);
  }

  /**
   * Invalidation triggered when repository revision changes.
   */
  public invalidateByRevisionChange(
    repositoryId: string,
    newRevision: string
  ): readonly MemoryRecord[] {
    const invalidated: MemoryRecord[] = [];
    for (const [memoryId, versions] of this.recordsByMemoryId.entries()) {
      const latest = versions[versions.length - 1];
      if (
        latest &&
        (latest.status === "ACTIVE" || latest.status === "VALIDATING") &&
        latest.repositoryId === repositoryId &&
        latest.baseRevision &&
        latest.baseRevision !== newRevision
      ) {
        const markedStale: MemoryRecord = {
          ...latest,
          freshness: "STALE",
        };
        versions[versions.length - 1] = markedStale;
        invalidated.push(markedStale);

        this.invalidationLog.push({
          eventId: `inv-rev-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          memoryId,
          version: latest.version,
          reason: `Base revision changed from ${latest.baseRevision} to ${newRevision}`,
          trigger: "REVISION_CHANGE",
          details: { repositoryId, oldRevision: latest.baseRevision, newRevision },
          invalidatedAt: new Date().toISOString(),
        });
      }
    }
    return Object.freeze(invalidated);
  }

  /**
   * Returns all version history for a given memoryId.
   */
  public versionLookup(memoryId: string): readonly MemoryRecord[] {
    const versions = this.recordsByMemoryId.get(memoryId);
    return versions ? Object.freeze([...versions]) : Object.freeze([]);
  }

  /**
   * Provenance lookup: returns chain of provenance roots and evidence digests.
   */
  public provenanceLookup(memoryId: string): readonly string[] {
    const versions = this.recordsByMemoryId.get(memoryId);
    if (!versions) {
      return Object.freeze([]);
    }
    return Object.freeze(
      versions.map((v) => `${v.memoryId}#v${v.version}:${v.provenanceRoot}:${v.sourceEvidenceDigest}`)
    );
  }

  /**
   * Returns all invalidation events recorded so far.
   */
  public getInvalidationEvents(): readonly MemoryInvalidationEvent[] {
    return Object.freeze([...this.invalidationLog]);
  }

  /**
   * Returns all stored records.
   */
  public getAllRecords(): readonly MemoryRecord[] {
    return Object.freeze([...this.history]);
  }

  /**
   * Computes the Merkle provenance root across all historical memory appends.
   */
  public computeStoreMerkleRoot(): string {
    if (this.history.length === 0) {
      return sha256Hex("EMPTY_COOPERATIVE_MEMORY_STORE");
    }
    const digests = this.history.map((r) => computeMemoryRecordDigest(r));
    return computeStoreMerkleRoot(digests);
  }
}
