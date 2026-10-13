import { createHash } from "node:crypto";
import {
  ContextBudget,
  ContextSnapshot,
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_SELECTION_POLICY,
  Observation,
  ObservationCategory,
  ObservationFreshness,
  OmittedObservationsSummary,
  OmittedReason,
  SelectionPolicy,
  computeContextHash,
  computeObservationContentHash,
  estimateBytes,
  estimateTokens,
  truncateToolOutput,
  validateContextBudget,
  validateObservation,
} from "../../domain/context.js";
import {
  ContextBudgetExceededError,
  InvalidObservationError,
} from "../../domain/errors.js";

export interface BuildContextOptions {
  readonly runId: string;
  readonly taskId: string;
  readonly candidates: readonly Observation[];
  readonly budget?: ContextBudget;
  readonly policy?: SelectionPolicy;
  readonly createdAt?: string;
}

interface OmittedEntry {
  readonly observation: Observation;
  readonly reason: OmittedReason;
}

const CATEGORY_DISPLAY_ORDER: readonly ObservationCategory[] = [
  "RUN_STATE",
  "MISSION_CONTEXT",
  "ATTEMPT_HISTORY",
  "TOOL_ERROR",
  "VERIFICATION",
  "WORKSPACE_STATE",
  "TOOL_RESULT",
  "ACTION_HISTORY",
  "EVIDENCE",
  "SYSTEM_EVENT",
] as const;

/**
 * Pure, deterministic ContextEngine.
 * Performs selection, ranking, budgeting, truncation, and snapshot assembly.
 * Independent of model providers, LLMs, and databases.
 */
export class ContextEngine {
  /**
   * Builds an immutable, bounded, verifiable ContextSnapshot.
   */
  static build(options: BuildContextOptions): ContextSnapshot {
    const budget = options.budget ?? DEFAULT_CONTEXT_BUDGET;
    validateContextBudget(budget);

    const policy = options.policy ?? DEFAULT_SELECTION_POLICY;
    const createdAt = options.createdAt ?? new Date().toISOString();

    // 1. Invariant checks on candidate observations
    for (const candidate of options.candidates) {
      validateObservation(candidate);
      if (candidate.provenance.runId !== options.runId) {
        throw new InvalidObservationError(
          `Observation '${candidate.observationId}' runId '${candidate.provenance.runId}' does not match context runId '${options.runId}'`
        );
      }
    }

    // 2. Pre-process truncation on oversized tool outputs
    const preprocessedCandidates: Observation[] = options.candidates.map((candidate) => {
      if (
        (candidate.category === "TOOL_RESULT" || candidate.category === "TOOL_ERROR") &&
        candidate.estimatedBytes > budget.maxToolOutputBytes
      ) {
        const { truncatedContent, truncation } = truncateToolOutput(
          candidate.content,
          budget.maxToolOutputBytes
        );
        const retainedBytes = estimateBytes(truncatedContent);
        const retainedTokens = estimateTokens(retainedBytes);
        const truncatedObs: Observation = {
          ...candidate,
          content: truncatedContent,
          contentHash: computeObservationContentHash(truncatedContent),
          estimatedBytes: retainedBytes,
          estimatedTokens: retainedTokens,
          truncation,
        };
        validateObservation(truncatedObs);
        return truncatedObs;
      }
      return candidate;
    });

    const omitted: OmittedEntry[] = [];
    const candidatesByCategory: Map<ObservationCategory, Observation[]> = new Map();

    for (const obs of preprocessedCandidates) {
      const list = candidatesByCategory.get(obs.category) ?? [];
      list.push(obs);
      candidatesByCategory.set(obs.category, list);
    }

    // 3. Enforce category-level count bounds
    const survivingCandidates: Observation[] = [];

    // Category: SYSTEM_EVENT
    const eventCandidates = candidatesByCategory.get("SYSTEM_EVENT") ?? [];
    eventCandidates.sort((a, b) => (a.provenance.sequenceNumber ?? 0) - (b.provenance.sequenceNumber ?? 0));
    if (eventCandidates.length > budget.maxHistoryEvents) {
      const excess = eventCandidates.length - budget.maxHistoryEvents;
      const pruned = eventCandidates.slice(0, excess);
      const kept = eventCandidates.slice(excess);
      for (const p of pruned) {
        omitted.push({ observation: p, reason: "CATEGORY_LIMIT" });
      }
      survivingCandidates.push(...kept);
    } else {
      survivingCandidates.push(...eventCandidates);
    }

    // Category: ACTION_HISTORY
    const actionCandidates = candidatesByCategory.get("ACTION_HISTORY") ?? [];
    actionCandidates.sort((a, b) => (a.provenance.sequenceNumber ?? 0) - (b.provenance.sequenceNumber ?? 0));
    if (actionCandidates.length > budget.maxActionHistory) {
      const excess = actionCandidates.length - budget.maxActionHistory;
      const pruned = actionCandidates.slice(0, excess);
      const kept = actionCandidates.slice(excess);
      for (const p of pruned) {
        omitted.push({ observation: p, reason: "CATEGORY_LIMIT" });
      }
      survivingCandidates.push(...kept);
    } else {
      survivingCandidates.push(...actionCandidates);
    }

    // Category: ATTEMPT_HISTORY (Mandatory UNKNOWN attempts are exempt from category limit pruning)
    const attemptCandidates = candidatesByCategory.get("ATTEMPT_HISTORY") ?? [];
    attemptCandidates.sort((a, b) => (a.provenance.sequenceNumber ?? 0) - (b.provenance.sequenceNumber ?? 0));
    const mandatoryAttempts = attemptCandidates.filter((a) => a.isMandatory);
    const nonMandatoryAttempts = attemptCandidates.filter((a) => !a.isMandatory);
    if (nonMandatoryAttempts.length > budget.maxAttemptHistory) {
      const excess = nonMandatoryAttempts.length - budget.maxAttemptHistory;
      const pruned = nonMandatoryAttempts.slice(0, excess);
      const kept = nonMandatoryAttempts.slice(excess);
      for (const p of pruned) {
        omitted.push({ observation: p, reason: "CATEGORY_LIMIT" });
      }
      survivingCandidates.push(...mandatoryAttempts, ...kept);
    } else {
      survivingCandidates.push(...attemptCandidates);
    }

    // Category: EVIDENCE
    const evidenceCandidates = candidatesByCategory.get("EVIDENCE") ?? [];
    evidenceCandidates.sort((a, b) => (a.provenance.sequenceNumber ?? 0) - (b.provenance.sequenceNumber ?? 0));
    if (evidenceCandidates.length > budget.maxEvidenceItems) {
      const excess = evidenceCandidates.length - budget.maxEvidenceItems;
      const pruned = evidenceCandidates.slice(0, excess);
      const kept = evidenceCandidates.slice(excess);
      for (const p of pruned) {
        omitted.push({ observation: p, reason: "CATEGORY_LIMIT" });
      }
      survivingCandidates.push(...kept);
    } else {
      survivingCandidates.push(...evidenceCandidates);
    }

    // Add remaining categories without specific count ceilings
    for (const [cat, list] of candidatesByCategory.entries()) {
      if (
        cat !== "SYSTEM_EVENT" &&
        cat !== "ACTION_HISTORY" &&
        cat !== "ATTEMPT_HISTORY" &&
        cat !== "EVIDENCE"
      ) {
        survivingCandidates.push(...list);
      }
    }

    // 4. Deterministic ranking comparator
    const freshnessRank: Record<ObservationFreshness, number> = {
      CURRENT: 3,
      RECENT: 2,
      STALE: 1,
    };

    function compareCandidates(a: Observation, b: Observation): number {
      // Priority descending
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      // Freshness descending
      if (freshnessRank[b.freshness] !== freshnessRank[a.freshness]) {
        return freshnessRank[b.freshness] - freshnessRank[a.freshness];
      }
      // Sequence ascending
      const aSeq = a.provenance.sequenceNumber ?? 0;
      const bSeq = b.provenance.sequenceNumber ?? 0;
      if (aSeq !== bSeq) {
        return aSeq - bSeq;
      }
      // Stable tie-breaker: observationId ascending
      return a.observationId.localeCompare(b.observationId);
    }

    // 5. Partition into mandatory vs optional
    const mandatoryCandidates = survivingCandidates
      .filter((o) => o.isMandatory)
      .sort(compareCandidates);
    const optionalCandidates = survivingCandidates
      .filter((o) => !o.isMandatory)
      .sort(compareCandidates);

    // 6. Mandatory safety floor validation
    let mandatoryBytes = 0;
    let mandatoryTokens = 0;
    for (const obs of mandatoryCandidates) {
      mandatoryBytes += obs.estimatedBytes;
      mandatoryTokens += obs.estimatedTokens;
    }

    if (
      mandatoryCandidates.length > budget.maxObservations ||
      mandatoryBytes > budget.maxBytes ||
      mandatoryTokens > budget.maxEstimatedTokens
    ) {
      throw new ContextBudgetExceededError(
        `Cannot accommodate mandatory safety observations (${mandatoryCandidates.length} items, ${mandatoryTokens} tokens, ${mandatoryBytes} bytes) within context budget (${budget.maxObservations} items, ${budget.maxEstimatedTokens} tokens, ${budget.maxBytes} bytes)`,
        mandatoryTokens,
        budget.maxEstimatedTokens
      );
    }

    const selectedObservations: Observation[] = [...mandatoryCandidates];
    let currentBytes = mandatoryBytes;
    let currentTokens = mandatoryTokens;
    let currentCount = mandatoryCandidates.length;

    // 7. Fill budget with optional candidates by priority
    for (const candidate of optionalCandidates) {
      const willExceedCount = currentCount + 1 > budget.maxObservations;
      const willExceedBytes = currentBytes + candidate.estimatedBytes > budget.maxBytes;
      const willExceedTokens = currentTokens + candidate.estimatedTokens > budget.maxEstimatedTokens;

      if (!willExceedCount && !willExceedBytes && !willExceedTokens) {
        selectedObservations.push(candidate);
        currentBytes += candidate.estimatedBytes;
        currentTokens += candidate.estimatedTokens;
        currentCount += 1;
      } else {
        omitted.push({ observation: candidate, reason: "BUDGET_LIMIT" });
      }
    }

    // 8. Order selected observations deterministically by semantic category display order
    selectedObservations.sort((a, b) => {
      const aCatIndex = CATEGORY_DISPLAY_ORDER.indexOf(a.category);
      const bCatIndex = CATEGORY_DISPLAY_ORDER.indexOf(b.category);
      if (aCatIndex !== bCatIndex) {
        return aCatIndex - bCatIndex;
      }
      const aSeq = a.provenance.sequenceNumber ?? 0;
      const bSeq = b.provenance.sequenceNumber ?? 0;
      if (aSeq !== bSeq) {
        return aSeq - bSeq;
      }
      return a.observationId.localeCompare(b.observationId);
    });

    // 9. Aggregate omitted observations summary
    const summaryMap = new Map<string, { category: ObservationCategory; reason: OmittedReason; count: number; totalTokens: number; totalBytes: number }>();
    for (const entry of omitted) {
      const key = `${entry.observation.category}:${entry.reason}`;
      const existing = summaryMap.get(key);
      if (existing) {
        existing.count += 1;
        existing.totalTokens += entry.observation.estimatedTokens;
        existing.totalBytes += entry.observation.estimatedBytes;
      } else {
        summaryMap.set(key, {
          category: entry.observation.category,
          reason: entry.reason,
          count: 1,
          totalTokens: entry.observation.estimatedTokens,
          totalBytes: entry.observation.estimatedBytes,
        });
      }
    }

    const omittedSummary: OmittedObservationsSummary[] = Array.from(summaryMap.values())
      .map((item) => ({
        category: item.category,
        count: item.count,
        totalEstimatedTokens: item.totalTokens,
        totalBytes: item.totalBytes,
        reason: item.reason,
      }))
      .sort((a, b) => a.category.localeCompare(b.category));

    // 10. Compute deterministic context hash
    const contextHash = computeContextHash({
      runId: options.runId,
      taskId: options.taskId,
      policyVersion: policy.policyVersion,
      budget,
      observations: selectedObservations,
    });

    const snapshotId = `ctx-${createHash("sha256")
      .update(`${options.runId}:${contextHash}`, "utf8")
      .digest("hex")
      .slice(0, 16)}`;

    return Object.freeze({
      snapshotId,
      runId: options.runId,
      taskId: options.taskId,
      policyVersion: policy.policyVersion,
      createdAt,
      budget,
      observations: Object.freeze(selectedObservations),
      omittedObservationsCount: omitted.length,
      omittedObservationsSummary: Object.freeze(omittedSummary),
      totalEstimatedTokens: currentTokens,
      totalBytes: currentBytes,
      contextHash,
    });
  }
}
