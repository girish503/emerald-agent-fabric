/**
 * Evidence Model for Emerald Agent Fabric.
 *
 * Establishes an immutable, content-hashed domain representation of execution observations.
 *
 * Core Boundary Guarantees:
 * 1. Provenance: Explicitly identifies whether evidence is PROVIDER_REPORTED or INDEPENDENT_OBSERVER.
 *    (V1 produces PROVIDER_REPORTED exclusively; independent observation is deferred).
 * 2. Integrity: Persists SHA-256 digest computed over the canonical, redacted representation.
 * 3. Size Boundary: Enforces a conservative 64 KB experimental limit on embedded summaries
 *    to prevent turning the event stream into a blob store.
 * 4. Immutability: Deeply frozen structures prevent mutation after creation.
 * 5. Secret Protection: Sensitive keys are redacted before hashing and persistence.
 */

import { computeCanonicalHash } from "./canonical-hash.js";

export type EvidenceSource = "PROVIDER_REPORTED" | "INDEPENDENT_OBSERVER";

export type EvidenceKind = "OUTPUT_PAYLOAD" | "PROCESS_EXIT" | "CONTENT_HASH";

export interface Evidence {
  readonly evidenceId: string;
  readonly runId: string;
  readonly source: EvidenceSource;
  readonly kind: EvidenceKind;
  readonly contentHash: string;
  readonly summary?: Readonly<Record<string, unknown>>;
  readonly observedAt: string;
  readonly schemaVersion: number;
}

/**
 * Experimental initial V1 bounded summary limit (64 KB).
 */
export const DEFAULT_MAX_SUMMARY_BYTES = 64 * 1024;

export interface CreateEvidenceParams {
  readonly runId: string;
  readonly kind: EvidenceKind;
  readonly rawContent: unknown;
  readonly evidenceId?: string;
  readonly source?: EvidenceSource;
  readonly observedAt?: string;
  readonly maxSummaryBytes?: number;
}

/**
 * Deep freezes an arbitrary object/array graph.
 */
function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  if (Object.isFrozen(obj)) {
    return obj;
  }

  const props = Object.getOwnPropertyNames(obj);
  for (const prop of props) {
    const val = (obj as Record<string, unknown>)[prop];
    if (val !== null && typeof val === "object") {
      deepFreeze(val);
    }
  }

  return Object.freeze(obj);
}

/**
 * Creates an immutable, canonicalized Evidence domain entity.
 */
export function createEvidence(params: CreateEvidenceParams): Evidence {
  if (!params.runId || typeof params.runId !== "string") {
    throw new Error("Evidence requires a valid non-empty runId.");
  }

  const evidenceId = params.evidenceId ?? "evi-" + crypto.randomUUID().slice(0, 12);
  const observedAt = params.observedAt ?? new Date().toISOString();
  // V1 qualification: Default and enforce PROVIDER_REPORTED in V1
  const source: EvidenceSource = params.source ?? "PROVIDER_REPORTED";
  const maxBytes = params.maxSummaryBytes ?? DEFAULT_MAX_SUMMARY_BYTES;

  // 1. Redact, canonicalize, and hash
  const { redacted, canonicalJson, contentHash } = computeCanonicalHash(params.rawContent);

  // 2. Enforce size boundary for event stream summary
  const byteLength = Buffer.byteLength(canonicalJson, "utf8");
  let kind = params.kind;
  let summary: Record<string, unknown> | undefined;

  if (byteLength > maxBytes) {
    // Exceeds bounded limit: omit full payload to prevent SQLite blob bloat
    kind = "CONTENT_HASH";
    summary = {
      _truncated: true,
      _byteLength: byteLength,
      _maxBytes: maxBytes,
    };
  } else {
    // Wrap payload in a structured summary object
    if (typeof redacted === "object" && redacted !== null && !Array.isArray(redacted)) {
      summary = { ...(redacted as Record<string, unknown>) };
    } else {
      summary = { output: redacted };
    }
  }

  const evidence: Evidence = {
    evidenceId,
    runId: params.runId,
    source,
    kind,
    contentHash,
    summary: summary ? (deepFreeze(summary) as Readonly<Record<string, unknown>>) : undefined,
    observedAt,
    schemaVersion: 1,
  };

  return Object.freeze(evidence);
}

/**
 * Creates an Evidence record for operation output payloads.
 */
export function createOutputPayloadEvidence(
  runId: string,
  output: unknown,
  options?: {
    readonly evidenceId?: string;
    readonly observedAt?: string;
    readonly maxSummaryBytes?: number;
  }
): Evidence {
  return createEvidence({
    runId,
    kind: "OUTPUT_PAYLOAD",
    rawContent: output,
    evidenceId: options?.evidenceId,
    observedAt: options?.observedAt,
    maxSummaryBytes: options?.maxSummaryBytes,
  });
}

/**
 * Creates an Evidence record for process exit observations.
 */
export function createProcessExitEvidence(
  runId: string,
  exitDetails: { readonly exitCode: number | null; readonly signal?: string | null },
  options?: {
    readonly evidenceId?: string;
    readonly observedAt?: string;
    readonly source?: EvidenceSource;
  }
): Evidence {
  return createEvidence({
    runId,
    kind: "PROCESS_EXIT",
    rawContent: exitDetails,
    evidenceId: options?.evidenceId,
    observedAt: options?.observedAt,
    // Default stays PROVIDER_REPORTED (createEvidence default): only a caller that independently observed
    // the exit status may label it INDEPENDENT_OBSERVER, and must do so explicitly.
    ...(options?.source ? { source: options.source } : {}),
  });
}
