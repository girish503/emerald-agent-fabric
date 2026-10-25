import fs from "node:fs";
import path from "node:path";
import {
  ArchiveRecord,
  ArchiveVerificationResult,
  AuthoritativeTerminalRecord,
  computeBundleId,
  EvidenceBundle,
  IngestionReasonCode,
  isTerminalStatus,
  TerminalVerificationResult,
} from "../../domain/evidence-bundle.js";
import { canonicalJsonStringify, sha256Hex } from "../../domain/canonical-hash.js";
import { EvidenceArchivePort } from "../../ports/evidence-archive.port.js";
import { ClockPort, SystemClock } from "../../ports/clock.port.js";
import { EvidenceReplayVerifier } from "../../application/evidence-replay-verifier.js";
import {
  EvidenceSignatureVerifier,
  EvidenceThresholdVerifier,
  TrustedKeyring,
} from "../../application/evidence-signer.js";

export interface FileSystemEvidenceArchiveOptions {
  readonly baseDir: string;
  readonly clock?: ClockPort;
  readonly keyring?: TrustedKeyring;
}

/**
 * FileSystemEvidenceArchive implements a local immutable, content-addressed archive
 * for accepted EvidenceBundles with an isolated quarantine directory for invalid submissions,
 * and an authoritative terminal record index for logical execution identity (Phase 40).
 */
export class FileSystemEvidenceArchive implements EvidenceArchivePort {
  readonly baseDir: string;
  readonly acceptedDir: string;
  readonly quarantineDir: string;
  readonly runsDir: string;
  private readonly clock: ClockPort;
  private readonly keyring?: TrustedKeyring;

  constructor(options: FileSystemEvidenceArchiveOptions) {
    this.baseDir = path.resolve(options.baseDir);
    this.acceptedDir = path.join(this.baseDir, "accepted");
    this.quarantineDir = path.join(this.baseDir, "quarantine");
    this.runsDir = path.join(this.baseDir, "runs");
    this.clock = options.clock ?? new SystemClock();
    this.keyring = options.keyring;

    fs.mkdirSync(this.acceptedDir, { recursive: true });
    fs.mkdirSync(this.quarantineDir, { recursive: true });
    fs.mkdirSync(this.runsDir, { recursive: true });
  }

  private assertValidHex64(id: string, label: string): void {
    if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)) {
      throw new Error(
        `Invalid ${label}: must be a 64-character lowercase hexadecimal string, received '${id}'.`
      );
    }
  }

  hasAccepted(bundleId: string): boolean {
    if (!/^[0-9a-f]{64}$/.test(bundleId)) {
      return false;
    }
    const targetPath = path.join(this.acceptedDir, `${bundleId}.json`);
    return fs.existsSync(targetPath);
  }

  getAcceptedBytes(bundleId: string): string | null {
    if (!/^[0-9a-f]{64}$/.test(bundleId)) {
      return null;
    }
    const targetPath = path.join(this.acceptedDir, `${bundleId}.json`);
    if (!fs.existsSync(targetPath)) {
      return null;
    }
    return fs.readFileSync(targetPath, "utf8");
  }

  getAcceptedBundle(bundleId: string): EvidenceBundle | null {
    const raw = this.getAcceptedBytes(bundleId);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as EvidenceBundle;
    } catch {
      return null;
    }
  }

  storeAccepted(bundle: EvidenceBundle, rawCanonicalJson: string): ArchiveRecord {
    this.assertValidHex64(bundle.bundleId, "bundleId");
    const targetPath = path.join(this.acceptedDir, `${bundle.bundleId}.json`);

    if (fs.existsSync(targetPath)) {
      const existingBytes = fs.readFileSync(targetPath, "utf8");
      if (existingBytes === rawCanonicalJson) {
        // Idempotent duplicate storage
        return {
          bundleId: bundle.bundleId,
          provenanceRoot: bundle.provenanceRoot,
          acceptedAt: this.clock.nowIso(),
          formatVersion: bundle.formatVersion,
          schemaVersion: bundle.schemaVersion,
          sizeBytes: Buffer.byteLength(existingBytes, "utf8"),
          status: "ACCEPTED",
          archivePath: targetPath,
        };
      }
      throw new Error(
        `Identity conflict: archive artifact for bundleId '${bundle.bundleId}' already exists with differing content.`
      );
    }

    const tmpPath = path.join(
      this.acceptedDir,
      `.${bundle.bundleId}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    );
    fs.writeFileSync(tmpPath, rawCanonicalJson, "utf8");
    fs.renameSync(tmpPath, targetPath);

    return {
      bundleId: bundle.bundleId,
      provenanceRoot: bundle.provenanceRoot,
      acceptedAt: this.clock.nowIso(),
      formatVersion: bundle.formatVersion,
      schemaVersion: bundle.schemaVersion,
      sizeBytes: Buffer.byteLength(rawCanonicalJson, "utf8"),
      status: "ACCEPTED",
      archivePath: targetPath,
    };
  }

  storeQuarantined(params: {
    quarantineId: string;
    reasonCode: IngestionReasonCode;
    rawPayload: string;
    bundleId?: string;
  }): string {
    const safeReason = params.reasonCode.replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeId = params.quarantineId.replace(/[^a-zA-Z0-9_-]/g, "_");

    const targetDir = path.join(this.quarantineDir, safeReason);
    fs.mkdirSync(targetDir, { recursive: true });

    const targetPath = path.join(targetDir, `${safeId}.json`);
    fs.writeFileSync(targetPath, params.rawPayload, "utf8");
    return targetPath;
  }

  verifyArchivedBundle(bundleId: string, customKeyring?: unknown): ArchiveVerificationResult {
    if (typeof bundleId !== "string" || !/^[0-9a-f]{64}$/.test(bundleId)) {
      return {
        valid: false,
        bundleId,
        status: "NOT_FOUND",
        failures: ["Invalid bundleId format: must be 64-character lowercase hex string"],
      };
    }

    const targetPath = path.join(this.acceptedDir, `${bundleId}.json`);
    if (!fs.existsSync(targetPath)) {
      return {
        valid: false,
        bundleId,
        status: "NOT_FOUND",
        failures: [`Archived bundle '${bundleId}' not found in accepted archive`],
      };
    }

    let raw: string;
    try {
      raw = fs.readFileSync(targetPath, "utf8");
    } catch (err: any) {
      return {
        valid: false,
        bundleId,
        status: "ARCHIVE_INTEGRITY_FAILURE",
        failures: [`Failed to read archive artifact: ${err?.message ?? "unknown error"}`],
      };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        valid: false,
        bundleId,
        status: "ARCHIVE_INTEGRITY_FAILURE",
        failures: ["Corrupted archive artifact: invalid JSON payload"],
      };
    }

    const { bundleId: declaredId, ...content } = parsed;
    const recomputed = computeBundleId(content);
    if (recomputed !== bundleId || declaredId !== bundleId) {
      return {
        valid: false,
        bundleId,
        status: "ARCHIVE_INTEGRITY_FAILURE",
        failures: [
          `Archived bundle identity mismatch: archive keyed as '${bundleId}', recomputed '${recomputed}', declared '${declaredId}'`,
        ],
      };
    }

    const replayResult = EvidenceReplayVerifier.verify(parsed);
    if (!replayResult.valid) {
      return {
        valid: false,
        bundleId,
        status: "ARCHIVE_INTEGRITY_FAILURE",
        replayResult,
        failures: replayResult.failures,
      };
    }

    // Phase 35 & 37: Signature / Threshold verification if present and keyring available
    const activeKeyring = customKeyring instanceof TrustedKeyring ? customKeyring : this.keyring;
    let signatureResult = undefined;
    let thresholdResult = undefined;

    if (activeKeyring) {
      if (parsed.signatures && Array.isArray(parsed.signatures) && parsed.signatures.length > 0) {
        thresholdResult = EvidenceThresholdVerifier.verifyThreshold(
          parsed,
          activeKeyring,
          EvidenceThresholdVerifier.DEFAULT_THRESHOLD_POLICY,
          { allowRevokedForHistorical: true }
        );
        // For historical audit: invalid crypto or payload tampering causes integrity failure
        if (thresholdResult.signatureResults.some((s) => !s.valid && s.reasonCode !== "REVOKED_SIGNING_KEY")) {
          return {
            valid: false,
            bundleId,
            status: "ARCHIVE_INTEGRITY_FAILURE",
            replayResult,
            thresholdResult,
            failures: thresholdResult.failures,
          };
        }
      } else if (parsed.signature) {
        signatureResult = EvidenceSignatureVerifier.verify(parsed, activeKeyring, {
          allowRevokedForHistorical: true,
        });
        if (!signatureResult.valid) {
          return {
            valid: false,
            bundleId,
            status: "ARCHIVE_INTEGRITY_FAILURE",
            replayResult,
            signatureResult,
            failures: signatureResult.failures,
          };
        }
      }
    }

    // Verify terminal record consistency if a terminal record exists for this run
    if (parsed.run?.runId && this.hasTerminalRecord(parsed.run.runId)) {
      const terminalCheck = this.verifyTerminalRecord(parsed.run.runId);
      if (!terminalCheck.valid) {
        return {
          valid: false,
          bundleId,
          status: "ARCHIVE_INTEGRITY_FAILURE",
          replayResult,
          signatureResult,
          thresholdResult,
          failures: terminalCheck.failures,
        };
      }
      if (isTerminalStatus(parsed.terminalState?.status) && terminalCheck.terminalRecord?.bundleId !== bundleId) {
        return {
          valid: false,
          bundleId,
          status: "ARCHIVE_INTEGRITY_FAILURE",
          replayResult,
          signatureResult,
          thresholdResult,
          failures: [
            `Terminal record authority mismatch: bundle '${bundleId}' claims terminal status for run '${parsed.run.runId}', but authoritative terminal record designates bundle '${terminalCheck.terminalRecord?.bundleId}'`,
          ],
        };
      }
    }

    return {
      valid: true,
      bundleId,
      status: "VERIFIED",
      replayResult,
      signatureResult,
      thresholdResult,
      failures: [],
    };
  }

  hasTerminalRecord(runId: string): boolean {
    if (!runId || typeof runId !== "string") {
      return false;
    }
    const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const terminalPath = path.join(this.runsDir, safeRunId, "terminal.json");
    return fs.existsSync(terminalPath);
  }

  getTerminalRecord(runId: string): AuthoritativeTerminalRecord | null {
    if (!runId || typeof runId !== "string") {
      return null;
    }
    const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const terminalPath = path.join(this.runsDir, safeRunId, "terminal.json");
    if (!fs.existsSync(terminalPath)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(terminalPath, "utf8");
      return JSON.parse(raw) as AuthoritativeTerminalRecord;
    } catch {
      return null;
    }
  }

  establishAuthoritativeTerminal(record: AuthoritativeTerminalRecord): void {
    if (!record.runId || typeof record.runId !== "string") {
      throw new Error("Invalid terminal record: missing runId.");
    }
    this.assertValidHex64(record.bundleId, "bundleId");

    // The preferred invariant: referenced immutable bundle MUST be durably present
    if (!this.hasAccepted(record.bundleId)) {
      throw new Error(
        `Cannot establish authoritative terminal record: referenced bundle '${record.bundleId}' does not exist in accepted archive.`
      );
    }

    const safeRunId = record.runId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const runDir = path.join(this.runsDir, safeRunId);
    const terminalPath = path.join(runDir, "terminal.json");

    if (fs.existsSync(terminalPath)) {
      const existing = this.getTerminalRecord(record.runId);
      if (existing && existing.bundleId === record.bundleId) {
        // Idempotent identical establishment
        return;
      }
      throw new Error(
        `Terminal authority conflict: run '${record.runId}' already has authoritative terminal bundle '${existing?.bundleId}', cannot replace with '${record.bundleId}'.`
      );
    }

    fs.mkdirSync(runDir, { recursive: true });
    const canonicalJson = canonicalJsonStringify(record);
    const tmpPath = path.join(
      runDir,
      `.terminal.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    );
    fs.writeFileSync(tmpPath, canonicalJson, "utf8");
    fs.renameSync(tmpPath, terminalPath);
  }

  verifyTerminalRecord(runId: string): TerminalVerificationResult {
    if (!runId || typeof runId !== "string") {
      return {
        valid: false,
        runId,
        status: "NOT_FOUND",
        failures: ["Invalid runId provided"],
      };
    }

    const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const terminalPath = path.join(this.runsDir, safeRunId, "terminal.json");

    if (!fs.existsSync(terminalPath)) {
      return {
        valid: false,
        runId,
        status: "NOT_FOUND",
        failures: [`No authoritative terminal record found for run '${runId}'.`],
      };
    }

    let raw: string;
    try {
      raw = fs.readFileSync(terminalPath, "utf8");
    } catch (err: any) {
      return {
        valid: false,
        runId,
        status: "INVALID_RECORD",
        reasonCode: "INVALID_TERMINAL_RECORD",
        failures: [`Failed to read terminal record: ${err?.message ?? "unknown error"}`],
      };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        valid: false,
        runId,
        status: "INVALID_RECORD",
        reasonCode: "INVALID_TERMINAL_RECORD",
        failures: ["Corrupted terminal record: invalid JSON payload"],
      };
    }

    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.formatVersion !== "emerald-terminal-record-v1" ||
      parsed.schemaVersion !== 1 ||
      parsed.runId !== runId ||
      typeof parsed.bundleId !== "string" ||
      !/^[0-9a-f]{64}$/.test(parsed.bundleId) ||
      !isTerminalStatus(parsed.terminalOutcome) ||
      typeof parsed.recordHash !== "string"
    ) {
      return {
        valid: false,
        runId,
        terminalRecord: parsed,
        status: "INVALID_RECORD",
        reasonCode: "INVALID_TERMINAL_RECORD",
        failures: ["Terminal record structure invalid or corrupted."],
      };
    }

    // Verify recordHash integrity
    const { recordHash, ...contentToHash } = parsed;
    const expectedHash = sha256Hex(canonicalJsonStringify(contentToHash));
    if (recordHash !== expectedHash) {
      return {
        valid: false,
        runId,
        terminalRecord: parsed,
        status: "INVALID_RECORD",
        reasonCode: "INVALID_TERMINAL_RECORD",
        failures: [`Terminal record hash mismatch: expected '${expectedHash}', got '${recordHash}'`],
      };
    }

    // Verify referenced bundle exists in accepted archive
    if (!this.hasAccepted(parsed.bundleId)) {
      return {
        valid: false,
        runId,
        terminalRecord: parsed,
        bundleId: parsed.bundleId,
        status: "BUNDLE_MISSING",
        reasonCode: "TERMINAL_BUNDLE_MISSING",
        failures: [`Authoritative terminal bundle '${parsed.bundleId}' missing from accepted archive`],
      };
    }

    // Verify bundle content matches terminal record
    const bundle = this.getAcceptedBundle(parsed.bundleId);
    if (!bundle) {
      return {
        valid: false,
        runId,
        terminalRecord: parsed,
        bundleId: parsed.bundleId,
        status: "BUNDLE_MISSING",
        reasonCode: "TERMINAL_BUNDLE_MISSING",
        failures: [`Failed to parse authoritative terminal bundle '${parsed.bundleId}'`],
      };
    }

    if (bundle.run.runId !== runId) {
      return {
        valid: false,
        runId,
        terminalRecord: parsed,
        bundleId: parsed.bundleId,
        status: "RECORD_MISMATCH",
        reasonCode: "TERMINAL_RECORD_MISMATCH",
        failures: [`Terminal record runId '${runId}' does not match bundle runId '${bundle.run.runId}'`],
      };
    }

    if (bundle.terminalState?.status !== parsed.terminalOutcome) {
      return {
        valid: false,
        runId,
        terminalRecord: parsed,
        bundleId: parsed.bundleId,
        status: "RECORD_MISMATCH",
        reasonCode: "TERMINAL_RECORD_MISMATCH",
        failures: [
          `Terminal record outcome '${parsed.terminalOutcome}' does not match bundle terminal status '${bundle.terminalState?.status}'`,
        ],
      };
    }

    return {
      valid: true,
      runId,
      terminalRecord: parsed,
      bundleId: parsed.bundleId,
      status: "VERIFIED",
      failures: [],
    };
  }
}
