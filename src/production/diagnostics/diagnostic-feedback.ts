/**
 * Emerald Agent Fabric — Diagnostic Feedback Domain Types & Interfaces
 *
 * Defines the bounded diagnostic feedback abstraction:
 * - DiagnosticStatus: PASS, SYNTAX_ERROR, TYPE_ERROR, LINT_ERROR, TOOL_ERROR, TIMEOUT, UNSUPPORTED
 * - DiagnosticItem: file, line, column, severity, diagnosticCode, message
 * - DiagnosticResult: structured non-authoritative observation
 * - DiagnosticConfig: strict context and execution bounds
 * - DiagnosticProvenanceRecord: tamper-evident evidence record
 *
 * Invariant:
 * The diagnostic subsystem is strictly advisory.
 * authoritative = false, terminalAuthority = false, verificationAuthority = false, policyAuthority = false.
 * Only ProductionVerifier can establish sovereign task success.
 */

import { computeCanonicalHash } from "../../domain/canonical-hash.js";

export type DiagnosticStatus =
  | "PASS"
  | "SYNTAX_ERROR"
  | "TYPE_ERROR"
  | "LINT_ERROR"
  | "TOOL_ERROR"
  | "TIMEOUT"
  | "UNSUPPORTED";

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface DiagnosticItem {
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
  readonly severity: DiagnosticSeverity;
  readonly diagnosticCode?: string;
  readonly message: string;
}

export interface DiagnosticResult {
  readonly diagnosticId: string;
  readonly runId?: string;
  readonly actionId?: string;
  readonly attemptId?: string;
  readonly status: DiagnosticStatus;
  readonly diagnostics: readonly DiagnosticItem[];
  readonly summary: string;
  readonly durationMs: number;
  readonly inputHash: string;
  readonly outputHash: string;
  readonly affectedFilesCount: number;
  readonly commandExecuted?: string;
  readonly timestamp: string;
  readonly feedbackObservationText?: string;

  // Strict non-authoritative invariants
  readonly authoritative: false;
  readonly terminalAuthority: false;
  readonly verificationAuthority: false;
  readonly policyAuthority: false;
}

export interface DiagnosticConfig {
  readonly enabled: boolean;
  readonly maxPayloadBytes: number; // default: 8192 (8 KB)
  readonly maxMessageBytes: number; // default: 512 bytes
  readonly maxDiagnostics: number;  // default: 32 items
  readonly maxFeedbackRoundsPerAction: number; // default: 2
  readonly maxExecutionsPerRun: number;        // default: 8
  readonly timeoutMs: number;                  // default: 10000 ms
}

export const DEFAULT_DIAGNOSTIC_CONFIG: DiagnosticConfig = {
  enabled: true,
  maxPayloadBytes: 8192,
  maxMessageBytes: 512,
  maxDiagnostics: 32,
  maxFeedbackRoundsPerAction: 2,
  maxExecutionsPerRun: 8,
  timeoutMs: 10000,
};

export interface DiagnosticProvenanceRecord {
  readonly diagnosticId: string;
  readonly actionId: string;
  readonly attemptId: string;
  readonly runId: string;
  readonly commandHash: string;
  readonly inputHash: string;
  readonly outputHash: string;
  readonly diagnosticStatus: DiagnosticStatus;
  readonly diagnosticDigest: string;
  readonly durationMs: number;
  readonly timestamp: string;
}

export interface DiagnosticMetrics {
  diagnosticExecutionCount: number;
  diagnosticFailureCount: number;
  diagnosticRecoveryCount: number;
  diagnosticUnsupportedCount: number;
  diagnosticTimeoutCount: number;
  malformedPatchRate: number;
  malformedPatchRecoveryRate: number;
  sovereignVerificationCallsAvoided: number;
  meanDiagnosticLatency: number;
  p95DiagnosticLatency: number;
  diagnosticContextBytes: number;
}

/**
 * Computes a deterministic SHA-256 digest for a diagnostic observation record.
 */
export function computeDiagnosticDigest(result: Omit<DiagnosticResult, "feedbackObservationText">): string {
  const payload = {
    diagnosticId: result.diagnosticId,
    status: result.status,
    inputHash: result.inputHash,
    outputHash: result.outputHash,
    summary: result.summary,
    diagnostics: result.diagnostics.map((d) => ({
      file: d.file,
      line: d.line,
      col: d.column,
      code: d.diagnosticCode,
      sev: d.severity,
      msg: d.message,
    })),
    durationMs: result.durationMs,
    authoritative: false,
    terminalAuthority: false,
    verificationAuthority: false,
    policyAuthority: false,
  };
  return computeCanonicalHash(payload).contentHash;
}

/**
 * Generates an aggressively bounded, structured textual observation string
 * suitable for inclusion in small local model contexts (<= 8 KB).
 */
export function formatDiagnosticObservation(
  result: DiagnosticResult,
  maxPayloadBytes: number = 8192,
  maxMessageBytes: number = 512,
): string {
  if (result.status === "PASS" || result.status === "UNSUPPORTED") {
    return "";
  }

  const lines: string[] = [
    `DIAGNOSTIC_FEEDBACK`,
    `status: ${result.status}`,
    `summary: ${result.summary}`,
    `affected_files: ${result.affectedFilesCount}`,
  ];

  for (const diag of result.diagnostics) {
    const truncatedMsg = diag.message.length > maxMessageBytes
      ? diag.message.slice(0, maxMessageBytes - 3) + "..."
      : diag.message;

    lines.push(`---`);
    lines.push(`file: ${diag.file}`);
    if (diag.line !== undefined) lines.push(`line: ${diag.line}`);
    if (diag.column !== undefined) lines.push(`column: ${diag.column}`);
    if (diag.diagnosticCode) lines.push(`code: ${diag.diagnosticCode}`);
    lines.push(`severity: ${diag.severity}`);
    lines.push(`message: ${truncatedMsg}`);
  }

  lines.push(`feedback_digest: ${computeDiagnosticDigest(result).slice(0, 16)}`);

  let text = lines.join("\n");
  if (Buffer.byteLength(text, "utf8") > maxPayloadBytes) {
    // Aggressively truncate if payload exceeds maximum budget
    text = text.slice(0, maxPayloadBytes - 64) + "\n...[diagnostic output truncated to budget]";
  }
  return text;
}
