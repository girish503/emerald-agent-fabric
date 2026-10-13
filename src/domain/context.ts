import { createHash } from "node:crypto";
import { canonicalJsonStringify, redactSensitiveData } from "./canonical-hash.js";
import {
  InvalidContextBudgetError,
  InvalidObservationError,
} from "./errors.js";

/**
 * The 10 recognized categories of observations in Emerald Agent Fabric.
 * Information is partitioned strictly by semantic category to allow bounded selection.
 */
export type ObservationCategory =
  | "RUN_STATE"
  | "MISSION_CONTEXT"
  | "ACTION_HISTORY"
  | "ATTEMPT_HISTORY"
  | "TOOL_RESULT"
  | "TOOL_ERROR"
  | "EVIDENCE"
  | "VERIFICATION"
  | "WORKSPACE_STATE"
  | "SYSTEM_EVENT";

export const ALL_OBSERVATION_CATEGORIES: readonly ObservationCategory[] = [
  "RUN_STATE",
  "MISSION_CONTEXT",
  "ACTION_HISTORY",
  "ATTEMPT_HISTORY",
  "TOOL_RESULT",
  "TOOL_ERROR",
  "EVIDENCE",
  "VERIFICATION",
  "WORKSPACE_STATE",
  "SYSTEM_EVENT",
] as const;

/**
 * Freshness categorization for observations.
 * CURRENT: actively reflects current head/running state.
 * RECENT: immediately preceding actions or events within the active window.
 * STALE: older historical items beyond the active window.
 */
export type ObservationFreshness = "CURRENT" | "RECENT" | "STALE";

/**
 * Provenance tracking for every observation.
 * Links every piece of information to an authoritative, durable runtime entity.
 */
export interface ObservationProvenance {
  readonly entityKind:
    | "Run"
    | "MissionContract"
    | "Action"
    | "Attempt"
    | "DomainEvent"
    | "Workspace"
    | "Evidence"
    | "VerificationSpec";
  readonly entityId: string;
  readonly runId: string;
  readonly sequenceNumber?: number;
  readonly timestamp: string;
  readonly isAuthoritativeRuntimeFact: boolean;
}

/**
 * Truncation metadata describing how an observation's payload was bounded.
 */
export interface TruncationMetadata {
  readonly isTruncated: boolean;
  readonly originalBytes: number;
  readonly retainedBytes: number;
  readonly originalEstimatedTokens: number;
  readonly retainedEstimatedTokens: number;
  readonly truncationStrategy?: "HEAD_TAIL" | "TAIL_OMIT" | "FIELD_OMIT";
}

/**
 * An individual, typed Observation presented to the Context Engine.
 */
export interface Observation {
  readonly observationId: string;
  readonly category: ObservationCategory;
  readonly provenance: ObservationProvenance;
  readonly freshness: ObservationFreshness;
  readonly priority: number;
  readonly content: Record<string, unknown>;
  readonly contentHash: string;
  readonly estimatedTokens: number;
  readonly estimatedBytes: number;
  readonly truncation?: TruncationMetadata;
  readonly isMandatory: boolean;
}

/**
 * Estimates byte size of structured content using UTF-8 canonical JSON serialization.
 */
export function estimateBytes(content: Record<string, unknown>): number {
  const canonical = canonicalJsonStringify(content);
  return Buffer.byteLength(canonical, "utf8");
}

/**
 * Estimates token count using a deterministic, provider-independent character heuristic (4 bytes/char per token).
 * NOTE: This is a provider-independent approximation. estimatedTokens ≠ provider tokenizer tokens.
 */
export function estimateTokens(bytes: number): number {
  if (bytes <= 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(bytes / 4));
}

/**
 * Computes deterministic SHA-256 hash of redacted content.
 */
export function computeObservationContentHash(content: Record<string, unknown>): string {
  const redacted = redactSensitiveData(content);
  const canonical = canonicalJsonStringify(redacted);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Context Budget specifying hard ceilings on observations, tokens, bytes, and categories.
 */
export interface ContextBudget {
  readonly maxObservations: number;
  readonly maxEstimatedTokens: number;
  readonly maxBytes: number;
  readonly maxHistoryEvents: number;
  readonly maxActionHistory: number;
  readonly maxAttemptHistory: number;
  readonly maxToolOutputBytes: number;
  readonly maxEvidenceItems: number;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxObservations: 50,
  maxEstimatedTokens: 4000,
  maxBytes: 16000,
  maxHistoryEvents: 20,
  maxActionHistory: 10,
  maxAttemptHistory: 10,
  maxToolOutputBytes: 2048,
  maxEvidenceItems: 10,
};

/**
 * Selection policy defining default priority levels and mandatory categories.
 */
export interface SelectionPolicy {
  readonly policyVersion: string;
  readonly maxToolOutputBytes: number;
  readonly categoryPriorities: Record<ObservationCategory, number>;
  readonly mandatoryCategories: readonly ObservationCategory[];
}

export const DEFAULT_SELECTION_POLICY: SelectionPolicy = {
  policyVersion: "context-policy-v1",
  maxToolOutputBytes: 2048,
  categoryPriorities: {
    RUN_STATE: 100,
    MISSION_CONTEXT: 90,
    TOOL_ERROR: 80,
    VERIFICATION: 75,
    WORKSPACE_STATE: 70,
    TOOL_RESULT: 60,
    ACTION_HISTORY: 50,
    ATTEMPT_HISTORY: 45,
    EVIDENCE: 30,
    SYSTEM_EVENT: 20,
  },
  mandatoryCategories: ["RUN_STATE", "MISSION_CONTEXT"],
};

export type OmittedReason = "BUDGET_LIMIT" | "STALE_PRUNED" | "CATEGORY_LIMIT";

export interface OmittedObservationsSummary {
  readonly category: ObservationCategory;
  readonly count: number;
  readonly totalEstimatedTokens: number;
  readonly totalBytes: number;
  readonly reason: OmittedReason;
}

/**
 * A ContextSnapshot is an immutable, bounded, verifiable view of runtime state.
 */
export interface ContextSnapshot {
  readonly snapshotId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly policyVersion: string;
  readonly createdAt: string;
  readonly budget: ContextBudget;
  readonly observations: readonly Observation[];
  readonly omittedObservationsCount: number;
  readonly omittedObservationsSummary: readonly OmittedObservationsSummary[];
  readonly totalEstimatedTokens: number;
  readonly totalBytes: number;
  readonly contextHash: string;
}

/**
 * Computes deterministic context hash over selected observations and snapshot configuration.
 */
export function computeContextHash(data: {
  readonly runId: string;
  readonly taskId: string;
  readonly policyVersion: string;
  readonly budget: ContextBudget;
  readonly observations: readonly Observation[];
}): string {
  const hashPayload = {
    runId: data.runId,
    taskId: data.taskId,
    policyVersion: data.policyVersion,
    budget: data.budget,
    observations: data.observations.map((obs) => ({
      observationId: obs.observationId,
      category: obs.category,
      contentHash: obs.contentHash,
      priority: obs.priority,
      freshness: obs.freshness,
      isMandatory: obs.isMandatory,
      truncation: obs.truncation ?? null,
    })),
  };

  const canonical = canonicalJsonStringify(hashPayload);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Validates a single Observation's invariants.
 */
export function validateObservation(obs: Observation): void {
  const violations: string[] = [];

  if (!obs.observationId || typeof obs.observationId !== "string" || obs.observationId.trim() === "") {
    violations.push("observationId must be a non-empty string");
  }

  if (!ALL_OBSERVATION_CATEGORIES.includes(obs.category)) {
    violations.push(`Invalid category '${obs.category}'`);
  }

  if (!obs.provenance) {
    violations.push("provenance must be provided");
  } else {
    if (!obs.provenance.entityKind) {
      violations.push("provenance.entityKind is required");
    }
    if (!obs.provenance.entityId) {
      violations.push("provenance.entityId is required");
    }
    if (!obs.provenance.runId) {
      violations.push("provenance.runId is required");
    }
    if (!obs.provenance.timestamp || isNaN(Date.parse(obs.provenance.timestamp))) {
      violations.push("provenance.timestamp must be a valid ISO date string");
    }
    if (typeof obs.provenance.isAuthoritativeRuntimeFact !== "boolean") {
      violations.push("provenance.isAuthoritativeRuntimeFact must be boolean");
    }
  }

  if (!["CURRENT", "RECENT", "STALE"].includes(obs.freshness)) {
    violations.push(`Invalid freshness '${obs.freshness}'`);
  }

  if (typeof obs.priority !== "number" || !Number.isFinite(obs.priority)) {
    violations.push("priority must be a finite number");
  }

  if (!obs.content || typeof obs.content !== "object" || Array.isArray(obs.content)) {
    violations.push("content must be a non-null object");
  }

  if (!obs.contentHash || typeof obs.contentHash !== "string" || obs.contentHash.length !== 64) {
    violations.push("contentHash must be a 64-character SHA-256 hex string");
  }

  if (typeof obs.estimatedBytes !== "number" || obs.estimatedBytes < 0) {
    violations.push("estimatedBytes must be non-negative");
  }

  if (typeof obs.estimatedTokens !== "number" || obs.estimatedTokens < 0) {
    violations.push("estimatedTokens must be non-negative");
  }

  if (typeof obs.isMandatory !== "boolean") {
    violations.push("isMandatory must be boolean");
  }

  if (obs.truncation) {
    if (obs.truncation.retainedBytes > obs.truncation.originalBytes) {
      violations.push("truncation.retainedBytes cannot exceed originalBytes");
    }
    if (obs.truncation.retainedEstimatedTokens > obs.truncation.originalEstimatedTokens) {
      violations.push("truncation.retainedEstimatedTokens cannot exceed originalEstimatedTokens");
    }
  }

  if (violations.length > 0) {
    throw new InvalidObservationError(
      `Observation '${obs.observationId || "unknown"}' failed invariants`,
      violations
    );
  }
}

/**
 * Validates a ContextBudget configuration.
 */
export function validateContextBudget(budget: ContextBudget): void {
  if (budget.maxObservations <= 0) {
    throw new InvalidContextBudgetError("maxObservations must be greater than 0");
  }
  if (budget.maxEstimatedTokens <= 0) {
    throw new InvalidContextBudgetError("maxEstimatedTokens must be greater than 0");
  }
  if (budget.maxBytes <= 0) {
    throw new InvalidContextBudgetError("maxBytes must be greater than 0");
  }
  if (budget.maxHistoryEvents < 0) {
    throw new InvalidContextBudgetError("maxHistoryEvents must be non-negative");
  }
  if (budget.maxActionHistory < 0) {
    throw new InvalidContextBudgetError("maxActionHistory must be non-negative");
  }
  if (budget.maxAttemptHistory < 0) {
    throw new InvalidContextBudgetError("maxAttemptHistory must be non-negative");
  }
  if (budget.maxToolOutputBytes <= 0) {
    throw new InvalidContextBudgetError("maxToolOutputBytes must be greater than 0");
  }
  if (budget.maxEvidenceItems < 0) {
    throw new InvalidContextBudgetError("maxEvidenceItems must be non-negative");
  }
}

function findLargestStringEntry(
  obj: unknown,
  currentPath: readonly string[] = []
): { path: readonly string[]; length: number } | null {
  if (obj === null || typeof obj !== "object") {
    return null;
  }

  let largest: { path: readonly string[]; length: number } | null = null;

  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    const nextPath = [...currentPath, key];
    if (typeof val === "string") {
      if (!largest || val.length > largest.length) {
        largest = { path: nextPath, length: val.length };
      }
    } else if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      const nested = findLargestStringEntry(val, nextPath);
      if (nested && (!largest || nested.length > largest.length)) {
        largest = nested;
      }
    }
  }

  return largest;
}

function truncateStringAtPath(
  root: Record<string, unknown>,
  path: readonly string[],
  maxCharsToKeep: number
): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(root)) as Record<string, unknown>;
  let cur: any = cloned;
  for (let i = 0; i < path.length - 1; i++) {
    cur = cur[path[i]!];
  }
  const lastKey = path[path.length - 1]!;
  const str = cur[lastKey] as string;

  const targetKeep = Math.max(32, maxCharsToKeep);
  const headLen = Math.floor(targetKeep / 2);
  const tailLen = Math.floor(targetKeep / 2);

  const head = str.slice(0, headLen);
  const tail = str.slice(-tailLen);
  const omittedChars = Math.max(0, str.length - (headLen + tailLen));
  const marker = `\n... [TRUNCATED ${omittedChars} CHARACTERS DUE TO CONTEXT BUDGET] ...\n`;

  cur[lastKey] = `${head}${marker}${tail}`;
  return cloned;
}

/**
 * Truncates oversized tool output deterministically with head/tail preservation and truncation metadata.
 */
export function truncateToolOutput(
  content: Record<string, unknown>,
  maxBytes: number
): {
  truncatedContent: Record<string, unknown>;
  truncation?: TruncationMetadata;
} {
  const currentBytes = estimateBytes(content);
  if (currentBytes <= maxBytes) {
    return { truncatedContent: content };
  }

  const originalEstimatedTokens = estimateTokens(currentBytes);
  let workingContent = JSON.parse(JSON.stringify(content)) as Record<string, unknown>;
  let strategy: "HEAD_TAIL" | "FIELD_OMIT" = "HEAD_TAIL";

  // Search for the largest string (top-level or nested e.g. output.stdout)
  const largestEntry = findLargestStringEntry(workingContent);

  if (largestEntry && largestEntry.length > 64) {
    const excess = currentBytes - maxBytes;
    const targetKeep = Math.max(64, largestEntry.length - excess - 150);
    workingContent = truncateStringAtPath(workingContent, largestEntry.path, targetKeep);

    // If still exceeds budget, reduce further
    let workingBytes = estimateBytes(workingContent);
    if (workingBytes > maxBytes) {
      const moreExcess = workingBytes - maxBytes;
      const secondTarget = Math.max(32, targetKeep - moreExcess - 100);
      workingContent = truncateStringAtPath(workingContent, largestEntry.path, secondTarget);
    }
  } else {
    // If no large string found, replace largest field
    strategy = "FIELD_OMIT";
    const entries = Object.entries(workingContent);
    if (entries.length > 0) {
      const largestKey = entries.reduce((prev, curr) =>
        estimateBytes({ [curr[0]]: curr[1] }) > estimateBytes({ [prev[0]]: prev[1] })
          ? curr
          : prev
      )[0];
      workingContent[largestKey] = `[TRUNCATED ${largestKey} DUE TO CONTEXT BUDGET]`;
    }
  }

  let retainedBytes = estimateBytes(workingContent);
  if (retainedBytes > currentBytes) {
    retainedBytes = currentBytes;
  }
  let retainedEstimatedTokens = estimateTokens(retainedBytes);
  if (retainedEstimatedTokens > originalEstimatedTokens) {
    retainedEstimatedTokens = originalEstimatedTokens;
  }

  return {
    truncatedContent: workingContent,
    truncation: {
      isTruncated: true,
      originalBytes: currentBytes,
      retainedBytes,
      originalEstimatedTokens,
      retainedEstimatedTokens,
      truncationStrategy: strategy,
    },
  };
}
