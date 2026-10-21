/**
 * Phase 92: Cooperative Memory Query Engine
 *
 * Provides resource-bounded, goal-scoped, freshness-aware querying over cooperative memory.
 *
 * HARD LIMITS:
 * - max records/query: 64
 * - max payload: 64KB (65536 bytes)
 * - max memory expansion rounds: 4
 * - max shared memory bytes/goal: 128KB (131072 bytes)
 * - max records/goal: 256
 * - max records added/round: 32
 * - max agents/workflow: 8
 * - max repositories/workflow: 8
 */

import { MemoryFreshness, MemoryRecord, MemoryType } from "../domain/cooperative-memory.js";
import { CooperativeMemoryStore } from "./cooperative-memory-store.js";
import { MemorySharingPolicy, WorkflowScopeContext } from "./memory-sharing-policy.js";

export const MEMORY_QUERY_LIMITS = {
  MAX_RECORDS_PER_QUERY: 64,
  MAX_PAYLOAD_BYTES: 64 * 1024, // 64KB
  MAX_EXPANSION_ROUNDS: 4,
  MAX_SHARED_MEMORY_BYTES_PER_GOAL: 128 * 1024, // 128KB
  MAX_RECORDS_PER_GOAL: 256,
  MAX_RECORDS_ADDED_PER_ROUND: 32,
  MAX_AGENTS_PER_WORKFLOW: 8,
  MAX_REPOSITORIES_PER_WORKFLOW: 8,
} as const;

export interface MemoryQueryParams {
  readonly requestingAgentId: string;
  readonly goalId: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly memoryType?: MemoryType;
  readonly requiredFreshness?: readonly MemoryFreshness[];
  readonly minConfidence?: number;
  readonly referencedFile?: string;
  readonly referencedSymbol?: string;
  readonly limit?: number;
}

export interface MemoryQueryResult {
  readonly records: readonly MemoryRecord[];
  readonly totalMatching: number;
  readonly returnedBytes: number;
  readonly truncatedDueToPayloadLimit: boolean;
  readonly truncatedDueToRecordLimit: boolean;
  readonly queryDurationMs: number;
}

export class CooperativeMemoryQueryEngine {
  constructor(
    private readonly store: CooperativeMemoryStore,
    private readonly workflowContext: WorkflowScopeContext
  ) {
    if (workflowContext.declaredAgents.length > MEMORY_QUERY_LIMITS.MAX_AGENTS_PER_WORKFLOW) {
      throw new Error(
        `Declared agents count ${workflowContext.declaredAgents.length} exceeds limit ${MEMORY_QUERY_LIMITS.MAX_AGENTS_PER_WORKFLOW}`
      );
    }
    if (
      workflowContext.declaredRepositories.length >
      MEMORY_QUERY_LIMITS.MAX_REPOSITORIES_PER_WORKFLOW
    ) {
      throw new Error(
        `Declared repositories count ${workflowContext.declaredRepositories.length} exceeds limit ${MEMORY_QUERY_LIMITS.MAX_REPOSITORIES_PER_WORKFLOW}`
      );
    }
  }

  /**
   * Executes a bounded, governed query.
   */
  public executeQuery(params: MemoryQueryParams): MemoryQueryResult {
    const startTime = Date.now();
    const effectiveLimit = Math.min(
      params.limit ?? MEMORY_QUERY_LIMITS.MAX_RECORDS_PER_QUERY,
      MEMORY_QUERY_LIMITS.MAX_RECORDS_PER_QUERY
    );

    const allowedFreshness = params.requiredFreshness ?? ["FRESH"];

    // Query candidate records from store
    const candidates = this.store.query((r) => {
      // Must match repository
      if (r.repositoryId !== params.repositoryId) return false;
      // Must match workspace
      if (r.workspaceId !== params.workspaceId) return false;
      // Freshness filter
      if (!allowedFreshness.includes(r.freshness)) return false;
      // MemoryType filter if specified
      if (params.memoryType && r.memoryType !== params.memoryType) return false;
      // Confidence filter
      if (params.minConfidence !== undefined && r.confidence < params.minConfidence)
        return false;
      // Referenced file filter
      if (
        params.referencedFile &&
        (!r.referencedFiles || !r.referencedFiles.includes(params.referencedFile))
      )
        return false;
      // Referenced symbol filter
      if (
        params.referencedSymbol &&
        (!r.referencedSymbols || !r.referencedSymbols.includes(params.referencedSymbol))
      )
        return false;

      return true;
    });

    const totalMatching = candidates.length;
    const sanitizedResults: MemoryRecord[] = [];
    let currentPayloadBytes = 0;
    let truncatedDueToPayloadLimit = false;
    let truncatedDueToRecordLimit = false;

    for (const record of candidates) {
      if (sanitizedResults.length >= effectiveLimit) {
        truncatedDueToRecordLimit = true;
        break;
      }

      // Check sharing policy
      const sharing = MemorySharingPolicy.evaluateSharing(
        record,
        params.requestingAgentId,
        params.goalId,
        this.workflowContext
      );

      if (!sharing.allowed || !sharing.sanitizedRecord) {
        continue;
      }

      const rec = sharing.sanitizedRecord;
      if (currentPayloadBytes + rec.contentSize > MEMORY_QUERY_LIMITS.MAX_PAYLOAD_BYTES) {
        truncatedDueToPayloadLimit = true;
        break;
      }

      sanitizedResults.push(rec);
      currentPayloadBytes += rec.contentSize;
    }

    const queryDurationMs = Math.max(1, Date.now() - startTime);

    return {
      records: Object.freeze(sanitizedResults),
      totalMatching,
      returnedBytes: currentPayloadBytes,
      truncatedDueToPayloadLimit,
      truncatedDueToRecordLimit,
      queryDurationMs,
    };
  }

  /**
   * Bounded iterative memory expansion up to MAX_EXPANSION_ROUNDS.
   */
  public expandMemoryGraph(
    initialRecordIds: readonly string[],
    requestingAgentId: string,
    goalId: string,
    maxRounds: number = MEMORY_QUERY_LIMITS.MAX_EXPANSION_ROUNDS
  ): readonly MemoryRecord[] {
    const rounds = Math.min(maxRounds, MEMORY_QUERY_LIMITS.MAX_EXPANSION_ROUNDS);
    const visitedRecordIds = new Set<string>(initialRecordIds);
    const collected: MemoryRecord[] = [];
    let currentGoalBytes = 0;

    let currentFrontierIds = [...initialRecordIds];

    for (let round = 1; round <= rounds; round++) {
      if (currentFrontierIds.length === 0) break;

      const nextFrontierIds: string[] = [];
      let recordsAddedThisRound = 0;

      for (const id of currentFrontierIds) {
        const rec = this.store.read(id);
        if (!rec) continue;

        // Check goal budget
        if (
          collected.length >= MEMORY_QUERY_LIMITS.MAX_RECORDS_PER_GOAL ||
          currentGoalBytes + rec.contentSize >
            MEMORY_QUERY_LIMITS.MAX_SHARED_MEMORY_BYTES_PER_GOAL
        ) {
          return Object.freeze(collected);
        }

        const sharing = MemorySharingPolicy.evaluateSharing(
          rec,
          requestingAgentId,
          goalId,
          this.workflowContext
        );

        if (sharing.allowed && sharing.sanitizedRecord) {
          collected.push(sharing.sanitizedRecord);
          currentGoalBytes += sharing.sanitizedRecord.contentSize;
        }

        // Parent memory link traversal
        if (rec.parentMemoryId && !visitedRecordIds.has(rec.parentMemoryId)) {
          if (recordsAddedThisRound < MEMORY_QUERY_LIMITS.MAX_RECORDS_ADDED_PER_ROUND) {
            visitedRecordIds.add(rec.parentMemoryId);
            nextFrontierIds.push(rec.parentMemoryId);
            recordsAddedThisRound++;
          }
        }
      }

      currentFrontierIds = nextFrontierIds;
    }

    return Object.freeze(collected);
  }
}
