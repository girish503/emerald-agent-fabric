/**
 * Emerald Agent Fabric — Production V1.4: Deterministic Minimal Test Evidence Selector
 *
 * Implements deterministic selection and minimization of test-failure evidence
 * to reduce context pressure and improve local-model repair outcomes.
 *
 * Core Principle:
 * "The model proposes. The runtime governs. The sandbox executes. Diagnostics explain. The verifier decides. The evidence proves."
 *
 * Security & Authority Invariants:
 * 1. The selector is strictly non-authoritative (authoritative: false, verificationAuthority: false, terminalAuthority: false).
 * 2. The selector NEVER reads or opens arbitrary filesystem paths extracted from stack traces.
 * 3. Authoritative verification evidence is never modified, deleted, or suppressed.
 */

import { createHash } from "node:crypto";
import {
  TestFailureLocalization,
  SelectedFailureRecord,
  MinimalEvidenceSelectionResult,
} from "./repair-types.js";

export interface EvidenceSelectionOptions {
  readonly modifiedFiles?: readonly string[];
  readonly maxFeedbackBytes?: number;
}

/**
 * Truncate a UTF-8 string to at most maxBytes without splitting multibyte characters
 * and without introducing replacement characters (U+FFFD).
 */
export function truncateUtf8Safe(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;

  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end--;
  }
  return buf.subarray(0, end).toString("utf8");
}

interface ScoredCandidateRecord {
  readonly recordId: string;
  readonly testName: string;
  readonly assertionMessage: string;
  readonly relevantFile?: string;
  readonly lineNumber?: number;
  readonly priorityScore: number;
  readonly priorityReason: string;
  readonly occurrenceCount: number;
  readonly underlyingReferences: readonly string[];
}

export class MinimalTestEvidenceSelector {
  constructor(private readonly defaultMaxBytes: number = 4096) {}

  /**
   * Deterministically select the minimal, highest-relevance subset of test-failure evidence
   * adhering strictly to the 4,096-byte budget.
   */
  public selectEvidence(
    localization: TestFailureLocalization,
    options?: EvidenceSelectionOptions,
  ): MinimalEvidenceSelectionResult {
    const rawMaxBytes = options?.maxFeedbackBytes ?? this.defaultMaxBytes;
    const maxBytes = typeof rawMaxBytes === "number" && !Number.isNaN(rawMaxBytes)
      ? Math.max(0, Math.floor(rawMaxBytes))
      : this.defaultMaxBytes;
    const modifiedFiles = options?.modifiedFiles ?? [];

    const originalText = localization.rawSummary ?? "";
    const originalBytes = Buffer.byteLength(originalText, "utf8");
    const originalDigest = createHash("sha256").update(originalText).digest("hex");

    // 1. Normalize and Extract Candidates
    const rawCandidates = this.extractRawCandidates(localization, modifiedFiles);

    // 2. Deduplicate genuinely identical normalized records
    const { deduplicated, deduplicatedCount } = this.deduplicateCandidates(rawCandidates);

    // 3. Sort Candidates Deterministically Using Observable Signals (Strict Priority)
    const sorted = [...deduplicated].sort((a, b) => {
      // Primary: Score descending (higher score = higher priority)
      if (b.priorityScore !== a.priorityScore) {
        return b.priorityScore - a.priorityScore;
      }
      // Tie-breaker 1: testName ascending (stable lexical order)
      if (a.testName !== b.testName) {
        return a.testName.localeCompare(b.testName);
      }
      // Tie-breaker 2: assertionMessage ascending
      if (a.assertionMessage !== b.assertionMessage) {
        return a.assertionMessage.localeCompare(b.assertionMessage);
      }
      // Tie-breaker 3: recordId ascending
      return a.recordId.localeCompare(b.recordId);
    });

    // Handle maxBytes === 0 (zero / negative normalized budget)
    if (maxBytes === 0) {
      return {
        selectedRecords: [],
        fullyRepresentedRecords: [],
        omittedCount: sorted.length,
        deduplicatedCount,
        originalEvidenceDigest: originalDigest,
        selectedEvidenceDigest: createHash("sha256").update("").digest("hex"),
        originalSerializedBytes: originalBytes,
        selectedSerializedBytes: 0,
        payloadReductionPercent: originalBytes > 0 ? 100 : 0,
        truncationApplied: sorted.length > 0,
        partialRecordTruncationApplied: false,
        formattedObservationText: "",
        authoritative: false,
        verificationAuthority: false,
        terminalAuthority: false,
      };
    }

    // Handle empty evidence (no failing candidates)
    if (sorted.length === 0) {
      const emptyMsg = `[MINIMAL_TEST_EVIDENCE (Advisory — Non-Authoritative)]\nCommand: ${localization.testCommand}\nStatus: No actionable failing assertions detected.`;
      const safeEmptyText = truncateUtf8Safe(emptyMsg, maxBytes);
      const selectedBytes = Buffer.byteLength(safeEmptyText, "utf8");
      return {
        selectedRecords: [],
        fullyRepresentedRecords: [],
        omittedCount: 0,
        deduplicatedCount,
        originalEvidenceDigest: originalDigest,
        selectedEvidenceDigest: createHash("sha256").update(safeEmptyText).digest("hex"),
        originalSerializedBytes: originalBytes,
        selectedSerializedBytes: selectedBytes,
        payloadReductionPercent: originalBytes > 0
          ? Number((((originalBytes - selectedBytes) / originalBytes) * 100).toFixed(1))
          : 0,
        truncationApplied: safeEmptyText !== emptyMsg,
        partialRecordTruncationApplied: false,
        formattedObservationText: safeEmptyText,
        authoritative: false,
        verificationAuthority: false,
        terminalAuthority: false,
      };
    }

    // 4. Select Complete Records as Whole Units within the Max Feedback Budget
    let selected: SelectedFailureRecord[] = [];
    let omittedCount = 0;
    let truncationApplied = false;
    let partialRecordTruncationApplied = false;
    let safeFormatted = "";
    let fitFound = false;

    for (let k = sorted.length; k >= 1; k--) {
      const candidateList: SelectedFailureRecord[] = sorted.slice(0, k).map((c) => ({
        recordId: c.recordId,
        testName: c.testName,
        assertionMessage: c.assertionMessage,
        relevantFile: c.relevantFile,
        lineNumber: c.lineNumber,
        priorityReason: c.priorityReason,
        occurrenceCount: c.occurrenceCount,
        underlyingReferences: c.underlyingReferences,
      }));
      const candidateOmitted = sorted.length - k;
      const proposedText = this.formatObservationText(
        localization.testCommand,
        candidateList,
        candidateOmitted,
      );

      if (Buffer.byteLength(proposedText, "utf8") <= maxBytes) {
        selected = candidateList;
        omittedCount = candidateOmitted;
        truncationApplied = omittedCount > 0;
        partialRecordTruncationApplied = false;
        safeFormatted = proposedText;
        fitFound = true;
        break;
      }
    }

    // If even a single complete record cannot fit, apply bounded partial truncation to the top record
    if (!fitFound && sorted.length > 0) {
      const top = sorted[0]!;
      const singleRecord: SelectedFailureRecord = {
        recordId: top.recordId,
        testName: top.testName,
        assertionMessage: top.assertionMessage,
        relevantFile: top.relevantFile,
        lineNumber: top.lineNumber,
        priorityReason: top.priorityReason,
        occurrenceCount: top.occurrenceCount,
        underlyingReferences: top.underlyingReferences,
      };
      selected = [singleRecord];
      omittedCount = sorted.length - 1;
      truncationApplied = true;
      partialRecordTruncationApplied = true;

      const fullOneRecordText = this.formatObservationText(
        localization.testCommand,
        [singleRecord],
        omittedCount,
      );

      const truncNote = "\n...[truncated for feedback budget]";
      const noteBytes = Buffer.byteLength(truncNote, "utf8");

      if (maxBytes >= noteBytes + 20) {
        const allowedText = maxBytes - noteBytes;
        safeFormatted = truncateUtf8Safe(fullOneRecordText, allowedText) + truncNote;
      } else {
        safeFormatted = truncateUtf8Safe(fullOneRecordText, maxBytes);
      }
    }

    const fullyRepresentedRecords = partialRecordTruncationApplied ? [] : selected;

    const selectedBytes = Buffer.byteLength(safeFormatted, "utf8");
    const reductionPercent = originalBytes > 0
      ? Number((((originalBytes - selectedBytes) / originalBytes) * 100).toFixed(1))
      : 0;

    const selectedDigest = createHash("sha256").update(safeFormatted).digest("hex");

    return {
      selectedRecords: selected,
      fullyRepresentedRecords,
      omittedCount,
      deduplicatedCount,
      originalEvidenceDigest: originalDigest,
      selectedEvidenceDigest: selectedDigest,
      originalSerializedBytes: originalBytes,
      selectedSerializedBytes: selectedBytes,
      payloadReductionPercent: reductionPercent,
      truncationApplied,
      partialRecordTruncationApplied,
      formattedObservationText: safeFormatted,
      authoritative: false,
      verificationAuthority: false,
      terminalAuthority: false,
    };
  }

  /**
   * Extract candidate records from raw localization data without touching the filesystem.
   */
  private extractRawCandidates(
    localization: TestFailureLocalization,
    modifiedFiles: readonly string[],
  ): ScoredCandidateRecord[] {
    const candidates: ScoredCandidateRecord[] = [];

    const failingTests = localization.failingTests ?? [];
    const failureMessages = localization.failureMessages ?? [];
    const localizedFiles = localization.localizedFiles ?? [];

    if (failingTests.length === 0 && failureMessages.length === 0) {
      if (localization.rawSummary && localization.rawSummary.trim().length > 0) {
        const assertionMessage = localization.rawSummary.trim().slice(0, 500);
        const testName = "Unparsed Test Suite Failure";
        const { score, reason } = this.calculatePriority(assertionMessage, undefined, undefined, modifiedFiles);
        const refHash = createHash("sha256").update(`${testName}:${assertionMessage}`).digest("hex");
        const recordId = `rec-${refHash.slice(0, 12)}`;
        return [
          {
            recordId,
            testName,
            assertionMessage,
            relevantFile: undefined,
            lineNumber: undefined,
            priorityScore: score,
            priorityReason: reason,
            occurrenceCount: 1,
            underlyingReferences: [recordId],
          },
        ];
      }
      return [];
    }

    const maxItems = Math.max(failingTests.length, failureMessages.length, 1);

    for (let i = 0; i < maxItems; i++) {
      const testName = failingTests[i] ?? failingTests[0] ?? `Test_${i + 1}`;
      const assertionMessage = failureMessages[i] ?? failureMessages[0] ?? "Test failed with non-zero exit code";

      let matchedFile: string | undefined;
      let matchedLine: number | undefined;

      // Remediation A: Associate file and line only if explicitly supported and unambiguous
      if (localizedFiles.length > 0) {
        let candidateFileEntry: string | undefined;

        if (localizedFiles.length === maxItems) {
          // Unambiguous 1:1 positional correspondence between failures and localized stack entries
          candidateFileEntry = localizedFiles[i];
        } else {
          // Check if testName or assertionMessage explicitly references exactly one localized file
          const explicitMatches = localizedFiles.filter((lf) => {
            const rawPath = lf.replace(/:\d+$/, "");
            return testName.includes(rawPath) || assertionMessage.includes(rawPath);
          });
          if (explicitMatches.length === 1) {
            candidateFileEntry = explicitMatches[0];
          }
          // Otherwise: ambiguous association -> represent as unknown (undefined)
        }

        if (candidateFileEntry) {
          const lineMatch = candidateFileEntry.match(/:(\d+)$/);
          if (lineMatch && lineMatch[1]) {
            matchedLine = parseInt(lineMatch[1], 10);
            matchedFile = candidateFileEntry.replace(/:\d+$/, "");
          } else {
            matchedFile = candidateFileEntry;
          }
        }
      }

      const { score, reason } = this.calculatePriority(assertionMessage, matchedFile, matchedLine, modifiedFiles);
      const refHash = createHash("sha256").update(`${testName}:${assertionMessage}:${matchedFile ?? ""}:${matchedLine ?? ""}`).digest("hex");
      const recordId = `rec-${refHash.slice(0, 12)}`;

      candidates.push({
        recordId,
        testName,
        assertionMessage,
        relevantFile: matchedFile,
        lineNumber: matchedLine,
        priorityScore: score,
        priorityReason: reason,
        occurrenceCount: 1,
        underlyingReferences: [recordId],
      });
    }

    return candidates;
  }

  /**
   * Score candidates strictly based on observable signals.
   */
  private calculatePriority(
    assertion: string,
    file: string | undefined,
    line: number | undefined,
    modifiedFiles: readonly string[],
  ): { score: number; reason: string } {
    let score = 0;
    const reasons: string[] = [];

    // Signal 1: Concrete failing assertion or expected-vs-actual mismatch (Weight: 1000)
    const isConcreteAssertion = /(?:AssertionError|Expected|Received|must equal|to equal|expected.*?to)/i.test(assertion);
    if (isConcreteAssertion) {
      score += 1000;
      reasons.push("Concrete failing assertion mismatch");
    }

    // Signal 2: Failure directly associated with a modified file (Weight: 500)
    const isModified = file && modifiedFiles.some((mf) => file.endsWith(mf) || mf.endsWith(file));
    if (isModified) {
      score += 500;
      reasons.push("Directly associated with modified source file");
    }

    // Signal 3: Valid source location directly associated with failure (Weight: 200)
    if (file && line) {
      score += 200;
      reasons.push(`Source location identified (${file}:${line})`);
    } else if (file) {
      score += 100;
      reasons.push(`Source file identified (${file})`);
    }

    // Signal 4: Concise error message explaining failure (Weight: 50)
    if (assertion.length > 5 && assertion.length < 256) {
      score += 50;
      reasons.push("Concise explanatory error description");
    }

    if (reasons.length === 0) {
      reasons.push("Generic failure observation");
    }

    return {
      score,
      reason: reasons.join("; "),
    };
  }

  /**
   * Deduplicate genuinely identical normalized records while preserving counts and references.
   */
  private deduplicateCandidates(candidates: ScoredCandidateRecord[]): {
    deduplicated: ScoredCandidateRecord[];
    deduplicatedCount: number;
  } {
    const map = new Map<string, ScoredCandidateRecord>();
    let deduplicatedCount = 0;

    for (const c of candidates) {
      const key = `${c.testName.trim()}::${c.assertionMessage.trim()}::${c.relevantFile || ""}::${c.lineNumber ?? ""}`;
      if (map.has(key)) {
        const existing = map.get(key)!;
        deduplicatedCount++;
        map.set(key, {
          ...existing,
          occurrenceCount: existing.occurrenceCount + 1,
          underlyingReferences: [...existing.underlyingReferences, ...c.underlyingReferences],
        });
      } else {
        map.set(key, c);
      }
    }

    return {
      deduplicated: Array.from(map.values()),
      deduplicatedCount,
    };
  }

  /**
   * Format compact, structured observation text.
   */
  private formatObservationText(
    testCommand: string,
    records: readonly SelectedFailureRecord[],
    omittedCount: number,
  ): string {
    const lines = [
      `[MINIMAL_TEST_EVIDENCE (Advisory — Non-Authoritative)]`,
      `Command: ${testCommand}`,
      `Selected Failures (${records.length}${omittedCount > 0 ? `, ${omittedCount} omitted for budget` : ""}):`,
    ];

    for (let i = 0; i < records.length; i++) {
      const r = records[i]!;
      lines.push(`  [#${i + 1}] Test: "${r.testName}"`);
      if (r.relevantFile) {
        lines.push(`      Location: ${r.relevantFile}${r.lineNumber ? `:${r.lineNumber}` : ""}`);
      }
      lines.push(`      Assertion: ${r.assertionMessage}`);
      if (r.occurrenceCount > 1) {
        lines.push(`      Occurrences: ${r.occurrenceCount} identical failures observed`);
      }
      lines.push(`      Prioritization: ${r.priorityReason}`);
    }

    if (omittedCount > 0) {
      lines.push(`[TRUNCATED: Remaining ${omittedCount} failure record(s) omitted to preserve context budget]`);
    }

    return lines.join("\n");
  }
}
