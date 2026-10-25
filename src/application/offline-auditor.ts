/**
 * Phase 41 — Standalone Offline Auditor Verification Engine
 *
 * Implements an independent, pure, read-only, offline verification pipeline
 * for external auditors evaluating Emerald evidence bundles and archives.
 *
 * ZERO dependencies on SQLite, Docker, Ollama, network, or Emerald runtime execution.
 * Composes existing pure verification primitives:
 * - EvidenceReplayVerifier
 * - EvidenceSignatureVerifier & EvidenceThresholdVerifier
 * - computeBundleId & computeProvenanceRoot
 * - computeTerminalRecordHash & isTerminalStatus
 * - containsUnredactedSecrets & canonicalJsonStringify
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  canonicalJsonStringify,
  containsUnredactedSecrets,
  sha256Hex,
} from "../domain/canonical-hash.js";
import {
  AuthoritativeTerminalRecord,
  computeBundleId,
  computeProvenanceRoot,
  computeTerminalRecordHash,
  EvidenceBundle,
  isTerminalStatus,
  ThresholdPolicy,
} from "../domain/evidence-bundle.js";
import { EvidenceReplayVerifier } from "./evidence-replay-verifier.js";
import {
  EvidenceSignatureVerifier,
  EvidenceThresholdVerifier,
  TrustedKeyring,
} from "./evidence-signer.js";

// =============================================================================
// Constants & Limits
// =============================================================================

export const AUDIT_EXIT_CODES = {
  VERIFIED: 0,
  VERIFICATION_FAILED: 1,
  INVALID_INPUT: 2,
  CONFIGURATION_ERROR: 3,
} as const;

export const AUDIT_LIMITS = {
  MAX_BUNDLE_BYTES: 10 * 1024 * 1024, // 10 MB (Phase 34 boundary)
  MAX_ARCHIVE_BYTES: 100 * 1024 * 1024, // 100 MB aggregate
  MAX_BUNDLE_COUNT: 1000,
  MAX_TERMINAL_RECORD_BYTES: 64 * 1024, // 64 KB
} as const;

export const DEFAULT_AUDIT_THRESHOLD_POLICY: ThresholdPolicy = {
  threshold: 2,
  totalAuthorities: 3,
};

// =============================================================================
// Auditor Data Types
// =============================================================================

export interface AuditFailure {
  readonly code: string;
  readonly message: string;
  readonly bundleId?: string;
  readonly runId?: string;
}

export interface BundleAuditSummary {
  readonly bundleId: string;
  readonly runId: string;
  readonly terminalStatus: string;
  readonly isTerminal: boolean;
  readonly contentIdValid: boolean;
  readonly provenanceRootValid: boolean;
  readonly replayValid: boolean;
  readonly secretPolicySatisfied: boolean;
  readonly signatureStatus?: string;
  readonly thresholdSatisfied?: boolean;
  readonly fourfoldSatisfied: boolean;
}

export interface TerminalRecordAuditSummary {
  readonly runId: string;
  readonly bundleId: string;
  readonly terminalOutcome: string;
  readonly recordedAt: string;
  readonly recordHash: string;
  readonly hashValid: boolean;
  readonly bundlePresent: boolean;
  readonly bundleMatches: boolean;
}

export interface AuditVerificationResult {
  readonly status: "VERIFIED" | "FAILED";
  readonly targetType: "SINGLE_BUNDLE" | "ARCHIVE";
  readonly runIds: readonly string[];
  readonly bundleIds: readonly string[];
  readonly authoritativeTerminalBundleId?: string;
  readonly terminalOutcome?: string;
  readonly thresholdSatisfied: boolean;
  readonly replayValid: boolean;
  readonly policyValid: boolean;
  readonly secretPolicySatisfied: boolean;
  readonly evidenceComplete: boolean;
  readonly fourfoldSatisfied: boolean;
  readonly terminalAuthorityValid: boolean;
  readonly failures: readonly AuditFailure[];
  readonly bundleSummaries: readonly BundleAuditSummary[];
  readonly terminalRecords?: readonly TerminalRecordAuditSummary[];
}

export interface AuditInspectionResult {
  readonly status: "INSPECTED";
  readonly targetType: "SINGLE_BUNDLE" | "ARCHIVE";
  readonly runIds: readonly string[];
  readonly bundles: readonly {
    readonly bundleId: string;
    readonly runId: string;
    readonly terminalOutcome: string;
    readonly checkpointCount: number;
    readonly actionCount: number;
    readonly attemptCount: number;
    readonly contractHash: string;
    readonly provenanceRoot: string;
    readonly authorities: readonly string[];
    readonly thresholdSatisfied?: boolean;
  }[];
  readonly terminalRecords: readonly {
    readonly runId: string;
    readonly bundleId: string;
    readonly terminalOutcome: string;
    readonly recordedAt: string;
    readonly recordHash: string;
  }[];
  readonly disclaimer: "Inspection only — evidence has NOT been verified.";
}

export interface OfflineAuditorOptions {
  readonly keyring?: TrustedKeyring;
  readonly thresholdPolicy?: ThresholdPolicy;
  readonly requireKeyring?: boolean;
}

// =============================================================================
// Keyring Loading Utility
// =============================================================================

export function loadTrustedKeyringFromFile(keyringPath: string): TrustedKeyring {
  if (!fs.existsSync(keyringPath)) {
    throw new Error(`Keyring file not found: ${keyringPath}`);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(keyringPath, "utf8");
  } catch (err: any) {
    throw new Error(`Failed to read keyring file: ${err?.message ?? "unknown error"}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`Invalid JSON in keyring file: ${err?.message ?? "unknown error"}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Keyring must be a JSON array of key records");
  }

  const keyring = new TrustedKeyring();
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("Keyring entry must be an object");
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.keyId !== "string" || e.keyId.trim() === "") {
      throw new Error("Keyring entry missing valid keyId string");
    }
    if (typeof e.publicKey !== "string" || e.publicKey.trim() === "") {
      throw new Error(`Keyring entry '${e.keyId}' missing valid publicKey PEM string`);
    }
    keyring.registerKey({
      keyId: e.keyId,
      publicKey: e.publicKey,
      status: (e.status as any) ?? "TRUSTED",
      authorityId: e.authorityId as string | undefined,
      role: e.role as any,
    });
  }

  return keyring;
}

// =============================================================================
// Helper: Path Safety & Symlink Check
// =============================================================================

function assertPathSafety(targetPath: string, rootDir?: string): void {
  const normalized = path.normalize(targetPath);
  if (rootDir) {
    const normalizedRoot = path.normalize(rootDir);
    if (!normalized.startsWith(normalizedRoot)) {
      throw new Error(`Path traversal attempt detected: '${targetPath}' escapes root '${rootDir}'`);
    }
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(targetPath);
  } catch (err: any) {
    throw new Error(`Cannot access path: ${err?.message ?? "unknown error"}`);
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`Unsafe symlink detected: '${targetPath}' is a symbolic link`);
  }
}

// =============================================================================
// Single Bundle Verifier
// =============================================================================

function verifyBundleContent(
  rawString: string,
  keyring?: TrustedKeyring,
  thresholdPolicy: ThresholdPolicy = DEFAULT_AUDIT_THRESHOLD_POLICY,
  requireKeyring = false
): {
  valid: boolean;
  bundle?: EvidenceBundle;
  failures: AuditFailure[];
  summary?: BundleAuditSummary;
} {
  const failures: AuditFailure[] = [];

  // Size limit check
  const sizeBytes = Buffer.byteLength(rawString, "utf8");
  if (sizeBytes > AUDIT_LIMITS.MAX_BUNDLE_BYTES) {
    return {
      valid: false,
      failures: [{ code: "BUNDLE_TOO_LARGE", message: `Bundle size ${sizeBytes} exceeds maximum of ${AUDIT_LIMITS.MAX_BUNDLE_BYTES} bytes` }],
    };
  }

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawString);
  } catch (err: any) {
    return {
      valid: false,
      failures: [{ code: "INVALID_JSON", message: `Corrupted bundle payload: invalid JSON (${err?.message ?? "unknown"})` }],
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      valid: false,
      failures: [{ code: "UNSUPPORTED_SCHEMA", message: "Bundle payload must be a JSON object" }],
    };
  }

  const obj = parsed as Record<string, unknown>;

  // Schema validation
  if (
    obj.formatVersion !== "emerald-evidence-bundle-v1" ||
    obj.schemaVersion !== 1 ||
    typeof obj.bundleId !== "string" ||
    !/^[0-9a-f]{64}$/.test(obj.bundleId) ||
    typeof obj.provenanceRoot !== "string" ||
    !/^[0-9a-f]{64}$/.test(obj.provenanceRoot) ||
    typeof obj.run !== "object" ||
    obj.run === null ||
    typeof obj.contract !== "object" ||
    obj.contract === null ||
    !Array.isArray(obj.checkpoints) ||
    !Array.isArray(obj.events) ||
    !Array.isArray(obj.actions) ||
    !Array.isArray(obj.attempts) ||
    typeof obj.terminalState !== "object" ||
    obj.terminalState === null ||
    typeof obj.provenance !== "object" ||
    obj.provenance === null
  ) {
    return {
      valid: false,
      failures: [{ code: "UNSUPPORTED_SCHEMA", message: "Bundle does not match emerald-evidence-bundle-v1 schema specification" }],
    };
  }

  const bundle = obj as unknown as EvidenceBundle;
  const runId = bundle.run.runId;
  const declaredBundleId = bundle.bundleId;

  // Content-addressed bundle identity
  const { bundleId: _b, signature: _s, signatures: _ss, ...contentToHash } = bundle;
  const recomputedBundleId = computeBundleId(contentToHash as any);
  let contentIdValid = true;
  if (recomputedBundleId !== declaredBundleId) {
    contentIdValid = false;
    failures.push({
      code: "BUNDLE_ID_MISMATCH",
      message: `Content identity mismatch: declared '${declaredBundleId}', recomputed '${recomputedBundleId}'`,
      bundleId: declaredBundleId,
      runId,
    });
  }

  // Provenance root verification
  let provenanceRootValid = true;
  const contractHash = bundle.contract?.contentHash ?? "";
  const eventRoot =
    bundle.events.length > 0
      ? bundle.events[bundle.events.length - 1]!.eventHash
      : sha256Hex(`empty:events:${bundle.run?.runId ?? ""}`);
  const checkpointRoot = sha256Hex(
    canonicalJsonStringify(bundle.checkpoints ?? [])
  );
  const attemptRoot = sha256Hex(canonicalJsonStringify(bundle.attempts ?? []));
  const verificationRoot = sha256Hex(
    canonicalJsonStringify(bundle.verificationEvidence ?? [])
  );

  const recomputedProvenanceRoot = computeProvenanceRoot({
    contractHash,
    eventRoot,
    checkpointRoot,
    attemptRoot,
    verificationRoot,
  });

  if (bundle.provenanceRoot !== recomputedProvenanceRoot) {
    provenanceRootValid = false;
    failures.push({
      code: "PROVENANCE_ROOT_MISMATCH",
      message: `Provenance root mismatch: declared '${bundle.provenanceRoot}', recomputed '${recomputedProvenanceRoot}'`,
      bundleId: declaredBundleId,
      runId,
    });
  }

  // Secret scanning
  let secretPolicySatisfied = true;
  if (containsUnredactedSecrets(bundle)) {
    secretPolicySatisfied = false;
    failures.push({
      code: "SECURITY_POLICY_FAILURE",
      message: "Unredacted secrets detected in bundle content",
      bundleId: declaredBundleId,
      runId,
    });
  }

  // Signature and Threshold verification
  let signatureStatus: string | undefined = undefined;
  let thresholdSatisfied: boolean | undefined = undefined;

  if (keyring) {
    if (bundle.signatures && Array.isArray(bundle.signatures) && bundle.signatures.length > 0) {
      const thresholdRes = EvidenceThresholdVerifier.verifyThreshold(bundle, keyring, thresholdPolicy);
      signatureStatus = thresholdRes.status;
      thresholdSatisfied = thresholdRes.status === "THRESHOLD_SATISFIED";
      if (!thresholdSatisfied) {
        failures.push({
          code: thresholdRes.reasonCodes?.[0] ?? "THRESHOLD_NOT_MET",
          message: `Threshold authority policy not satisfied: ${thresholdRes.failures.join("; ")}`,
          bundleId: declaredBundleId,
          runId,
        });
      }
    } else if (bundle.signature) {
      const sigRes = EvidenceSignatureVerifier.verify(bundle, keyring);
      signatureStatus = sigRes.signatureStatus;
      thresholdSatisfied = sigRes.valid;
      if (!sigRes.valid) {
        failures.push({
          code: sigRes.reasonCode ?? "INVALID_SIGNATURE",
          message: `Signature verification failed: ${sigRes.failures.join("; ")}`,
          bundleId: declaredBundleId,
          runId,
        });
      }
    } else if (requireKeyring) {
      failures.push({
        code: "UNSIGNED_BUNDLE",
        message: "Keyring provided but bundle contains zero signatures",
        bundleId: declaredBundleId,
        runId,
      });
    }
  } else if (requireKeyring) {
    failures.push({
      code: "MISSING_KEYRING",
      message: "Keyring is required for verification but none was provided",
      bundleId: declaredBundleId,
      runId,
    });
  }

  // Offline deterministic replay verification
  const replayRes = EvidenceReplayVerifier.verify(bundle);
  const replayValid = replayRes.valid;
  if (!replayRes.valid) {
    for (const f of replayRes.failures) {
      let code = "REPLAY_VERIFICATION_FAILURE";
      if (f.includes("Event hash chain")) code = "EVENT_INTEGRITY_FAILURE";
      else if (f.includes("Checkpoint")) code = "CHECKPOINT_INTEGRITY_FAILURE";
      else if (f.includes("Attempt")) code = "ATTEMPT_INTEGRITY_FAILURE";
      else if (f.includes("Action")) code = "ACTION_INTEGRITY_FAILURE";
      else if (f.includes("Contract")) code = "CONTRACT_INTEGRITY_FAILURE";
      else if (f.includes("Provenance")) code = "PROVENANCE_ROOT_MISMATCH";
      else if (f.includes("Fourfold")) code = "FOURFOLD_COMPLETION_FAILURE";
      failures.push({
        code,
        message: f,
        bundleId: declaredBundleId,
        runId,
      });
    }
  }

  // Fourfold completion check
  const fourfold = replayRes.fourfoldOutcome;
  const fourfoldSatisfied =
    fourfold.taskSatisfied &&
    fourfold.verificationPassed &&
    fourfold.policySatisfied &&
    fourfold.evidenceComplete;

  const terminalStatus = bundle.terminalState.status;
  const isTerminal = isTerminalStatus(terminalStatus);

  if (terminalStatus === "COMPLETED" && !fourfoldSatisfied) {
    failures.push({
      code: "FOURFOLD_COMPLETION_FAILURE",
      message: "Bundle claims terminal COMPLETED status, but fourfold verification is not satisfied",
      bundleId: declaredBundleId,
      runId,
    });
  }

  const summary: BundleAuditSummary = {
    bundleId: declaredBundleId,
    runId,
    terminalStatus,
    isTerminal,
    contentIdValid,
    provenanceRootValid,
    replayValid,
    secretPolicySatisfied,
    signatureStatus,
    thresholdSatisfied,
    fourfoldSatisfied,
  };

  return {
    valid: failures.length === 0,
    bundle,
    failures,
    summary,
  };
}

// =============================================================================
// Standalone Offline Auditor
// =============================================================================

export class OfflineAuditor {
  /**
   * Verifies an untrusted evidence path (either a single bundle JSON file or an archive directory).
   */
  static verifyEvidence(
    targetPath: string,
    options: OfflineAuditorOptions = {}
  ): AuditVerificationResult {
    if (!fs.existsSync(targetPath)) {
      throw new Error(`Evidence target not found: ${targetPath}`);
    }

    assertPathSafety(targetPath);
    const stat = fs.statSync(targetPath);

    if (stat.isFile()) {
      return this.verifySingleBundleFile(targetPath, options);
    } else if (stat.isDirectory()) {
      return this.verifyArchiveDirectory(targetPath, options);
    } else {
      throw new Error(`Target is neither a file nor a directory: ${targetPath}`);
    }
  }

  /**
   * Verifies a single bundle file.
   */
  private static verifySingleBundleFile(
    filePath: string,
    options: OfflineAuditorOptions
  ): AuditVerificationResult {
    const rawString = fs.readFileSync(filePath, "utf8");
    const { valid, bundle, failures, summary } = verifyBundleContent(
      rawString,
      options.keyring,
      options.thresholdPolicy,
      options.requireKeyring
    );

    const runId = bundle?.run?.runId;
    const bundleId = bundle?.bundleId;
    const runIds = runId ? [runId] : [];
    const bundleIds = bundleId ? [bundleId] : [];
    const isTerminal = bundle ? isTerminalStatus(bundle.terminalState?.status) : false;

    return {
      status: valid ? "VERIFIED" : "FAILED",
      targetType: "SINGLE_BUNDLE",
      runIds,
      bundleIds,
      authoritativeTerminalBundleId: isTerminal ? bundleId : undefined,
      terminalOutcome: bundle?.terminalState?.status,
      thresholdSatisfied: summary?.thresholdSatisfied ?? true,
      replayValid: summary?.replayValid ?? false,
      policyValid: true,
      secretPolicySatisfied: summary?.secretPolicySatisfied ?? false,
      evidenceComplete: summary?.fourfoldSatisfied ?? false,
      fourfoldSatisfied: summary?.fourfoldSatisfied ?? false,
      terminalAuthorityValid: isTerminal,
      failures,
      bundleSummaries: summary ? [summary] : [],
    };
  }

  /**
   * Verifies an entire archive directory (Phase 40 structure).
   */
  private static verifyArchiveDirectory(
    archiveDir: string,
    options: OfflineAuditorOptions
  ): AuditVerificationResult {
    const failures: AuditFailure[] = [];
    const acceptedDir = path.join(archiveDir, "accepted");
    const runsDir = path.join(archiveDir, "runs");

    if (!fs.existsSync(acceptedDir)) {
      failures.push({
        code: "MISSING_ACCEPTED_DIRECTORY",
        message: `Archive directory missing required 'accepted/' subdirectory: ${acceptedDir}`,
      });
      return {
        status: "FAILED",
        targetType: "ARCHIVE",
        runIds: [],
        bundleIds: [],
        thresholdSatisfied: false,
        replayValid: false,
        policyValid: false,
        secretPolicySatisfied: false,
        evidenceComplete: false,
        fourfoldSatisfied: false,
        terminalAuthorityValid: false,
        failures,
        bundleSummaries: [],
      };
    }

    // Safety checks on acceptedDir
    assertPathSafety(acceptedDir, archiveDir);

    const acceptedEntries = fs.readdirSync(acceptedDir, { withFileTypes: true });
    let totalArchiveBytes = 0;
    const acceptedBundles = new Map<string, EvidenceBundle>();
    const bundleSummaries: BundleAuditSummary[] = [];
    const bundlesByRun = new Map<string, EvidenceBundle[]>();

    // 1. Process all accepted bundles
    for (const entry of acceptedEntries) {
      const entryPath = path.join(acceptedDir, entry.name);
      assertPathSafety(entryPath, acceptedDir);

      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        failures.push({
          code: "UNKNOWN_ARCHIVE_FILE",
          message: `Unexpected file or directory in accepted archive: '${entry.name}'`,
        });
        continue;
      }

      const stat = fs.statSync(entryPath);
      totalArchiveBytes += stat.size;
      if (totalArchiveBytes > AUDIT_LIMITS.MAX_ARCHIVE_BYTES) {
        failures.push({
          code: "ARCHIVE_TOO_LARGE",
          message: `Aggregate archive size exceeds maximum of ${AUDIT_LIMITS.MAX_ARCHIVE_BYTES} bytes`,
        });
        break;
      }

      const expectedFilenameMatch = entry.name.match(/^([0-9a-f]{64})\.json$/i);
      if (!expectedFilenameMatch) {
        failures.push({
          code: "INVALID_ARCHIVE_FILE",
          message: `Archive bundle filename must be 64-char hex SHA-256 string: '${entry.name}'`,
        });
        continue;
      }
      const filenameBundleId = expectedFilenameMatch[1]!.toLowerCase();

      let raw: string;
      try {
        raw = fs.readFileSync(entryPath, "utf8");
      } catch (err: any) {
        failures.push({
          code: "ARCHIVE_READ_FAILURE",
          message: `Failed to read accepted bundle file '${entry.name}': ${err?.message ?? "unknown"}`,
          bundleId: filenameBundleId,
        });
        continue;
      }

      const verifiedContent = verifyBundleContent(
        raw,
        options.keyring,
        options.thresholdPolicy,
        options.requireKeyring
      );

      if (!verifiedContent.valid || !verifiedContent.bundle || !verifiedContent.summary) {
        failures.push(...verifiedContent.failures);
        continue;
      }

      const bundle = verifiedContent.bundle;
      const summary = verifiedContent.summary;

      // Invariant: Never trust filename! Filename must match verified bundleId
      if (bundle.bundleId !== filenameBundleId) {
        failures.push({
          code: "BUNDLE_ID_FILENAME_MISMATCH",
          message: `Bundle contentId '${bundle.bundleId}' does not match file basename '${filenameBundleId}'`,
          bundleId: bundle.bundleId,
          runId: bundle.run.runId,
        });
      }

      if (acceptedBundles.has(bundle.bundleId)) {
        failures.push({
          code: "DUPLICATE_BUNDLE_IN_ARCHIVE",
          message: `Duplicate bundleId '${bundle.bundleId}' encountered in accepted archive`,
          bundleId: bundle.bundleId,
          runId: bundle.run.runId,
        });
      }

      acceptedBundles.set(bundle.bundleId, bundle);
      bundleSummaries.push(summary);

      const runList = bundlesByRun.get(bundle.run.runId) ?? [];
      runList.push(bundle);
      bundlesByRun.set(bundle.run.runId, runList);
    }

    if (bundleSummaries.length > AUDIT_LIMITS.MAX_BUNDLE_COUNT) {
      failures.push({
        code: "TOO_MANY_BUNDLES",
        message: `Archive contains ${bundleSummaries.length} bundles, exceeding limit of ${AUDIT_LIMITS.MAX_BUNDLE_COUNT}`,
      });
    }

    // 2. Process terminal records in runs/
    const terminalRecords: TerminalRecordAuditSummary[] = [];
    const terminalRecordsByRun = new Map<string, AuthoritativeTerminalRecord>();

    if (fs.existsSync(runsDir)) {
      assertPathSafety(runsDir, archiveDir);
      const runEntries = fs.readdirSync(runsDir, { withFileTypes: true });

      for (const runEntry of runEntries) {
        const runDirPath = path.join(runsDir, runEntry.name);
        assertPathSafety(runDirPath, runsDir);

        if (!runEntry.isDirectory()) {
          failures.push({
            code: "UNKNOWN_ARCHIVE_FILE",
            message: `Unexpected file in runs directory: '${runEntry.name}'`,
          });
          continue;
        }

        const terminalJsonPath = path.join(runDirPath, "terminal.json");
        if (!fs.existsSync(terminalJsonPath)) {
          failures.push({
            code: "INVALID_TERMINAL_RECORD",
            message: `Run directory '${runEntry.name}' missing 'terminal.json'`,
          });
          continue;
        }

        // Check for unexpected extra files in run subdirectory
        const filesInRunDir = fs.readdirSync(runDirPath);
        for (const file of filesInRunDir) {
          if (file !== "terminal.json") {
            failures.push({
              code: "UNKNOWN_ARCHIVE_FILE",
              message: `Unexpected file '${file}' in run directory '${runEntry.name}'`,
            });
          }
        }

        const stat = fs.statSync(terminalJsonPath);
        if (stat.size > AUDIT_LIMITS.MAX_TERMINAL_RECORD_BYTES) {
          failures.push({
            code: "TERMINAL_RECORD_TOO_LARGE",
            message: `terminal.json in '${runEntry.name}' exceeds maximum size of ${AUDIT_LIMITS.MAX_TERMINAL_RECORD_BYTES} bytes`,
          });
          continue;
        }

        let rawTerminal: string;
        try {
          rawTerminal = fs.readFileSync(terminalJsonPath, "utf8");
        } catch (err: any) {
          failures.push({
            code: "TERMINAL_READ_FAILURE",
            message: `Failed to read terminal.json in '${runEntry.name}': ${err?.message ?? "unknown"}`,
          });
          continue;
        }

        let parsedTerm: unknown;
        try {
          parsedTerm = JSON.parse(rawTerminal);
        } catch (err: any) {
          failures.push({
            code: "INVALID_TERMINAL_RECORD",
            message: `Corrupted terminal.json in '${runEntry.name}': invalid JSON (${err?.message ?? "unknown"})`,
          });
          continue;
        }

        const tObj = parsedTerm as Record<string, unknown>;
        if (
          !tObj ||
          typeof tObj !== "object" ||
          tObj.formatVersion !== "emerald-terminal-record-v1" ||
          tObj.schemaVersion !== 1 ||
          typeof tObj.runId !== "string" ||
          typeof tObj.bundleId !== "string" ||
          !/^[0-9a-f]{64}$/.test(tObj.bundleId) ||
          !isTerminalStatus(tObj.terminalOutcome as any) ||
          typeof tObj.recordedAt !== "string" ||
          typeof tObj.recordHash !== "string"
        ) {
          failures.push({
            code: "INVALID_TERMINAL_RECORD",
            message: `Invalid terminal record schema in '${runEntry.name}'`,
          });
          continue;
        }

        const termRecord = tObj as unknown as AuthoritativeTerminalRecord;
        const expectedSafeRunId = termRecord.runId.replace(/[^a-zA-Z0-9_-]/g, "_");
        if (runEntry.name !== expectedSafeRunId) {
          failures.push({
            code: "TERMINAL_RECORD_MISMATCH",
            message: `Run directory name '${runEntry.name}' does not match expected safeRunId '${expectedSafeRunId}' for runId '${termRecord.runId}'`,
            runId: termRecord.runId,
          });
        }

        // Verify recordHash integrity
        const { recordHash, ...termWithoutHash } = termRecord;
        const expectedRecordHash = computeTerminalRecordHash(termWithoutHash);
        const hashValid = recordHash === expectedRecordHash;
        if (!hashValid) {
          failures.push({
            code: "INVALID_TERMINAL_RECORD",
            message: `Terminal record hash mismatch in '${termRecord.runId}': expected '${expectedRecordHash}', got '${recordHash}'`,
            runId: termRecord.runId,
            bundleId: termRecord.bundleId,
          });
        }

        // Resolve referenced bundleId in accepted/
        const referencedBundle = acceptedBundles.get(termRecord.bundleId);
        const bundlePresent = referencedBundle !== undefined;
        let bundleMatches = false;

        if (!bundlePresent) {
          failures.push({
            code: "TERMINAL_BUNDLE_MISSING",
            message: `Terminal record for run '${termRecord.runId}' references bundle '${termRecord.bundleId}', which is missing from accepted/`,
            runId: termRecord.runId,
            bundleId: termRecord.bundleId,
          });
        } else {
          // Check bundle matches runId and terminalOutcome
          if (referencedBundle.run.runId !== termRecord.runId) {
            failures.push({
              code: "TERMINAL_RECORD_MISMATCH",
              message: `Terminal record runId '${termRecord.runId}' does not match bundle runId '${referencedBundle.run.runId}'`,
              runId: termRecord.runId,
              bundleId: termRecord.bundleId,
            });
          } else if (referencedBundle.terminalState.status !== termRecord.terminalOutcome) {
            failures.push({
              code: "TERMINAL_RECORD_MISMATCH",
              message: `Terminal record outcome '${termRecord.terminalOutcome}' does not match bundle status '${referencedBundle.terminalState.status}'`,
              runId: termRecord.runId,
              bundleId: termRecord.bundleId,
            });
          } else {
            bundleMatches = true;
          }
        }

        terminalRecords.push({
          runId: termRecord.runId,
          bundleId: termRecord.bundleId,
          terminalOutcome: termRecord.terminalOutcome,
          recordedAt: termRecord.recordedAt,
          recordHash: termRecord.recordHash,
          hashValid,
          bundlePresent,
          bundleMatches,
        });

        if (terminalRecordsByRun.has(termRecord.runId)) {
          failures.push({
            code: "CONFLICTING_TERMINAL_RECORDS",
            message: `Multiple terminal records found for run '${termRecord.runId}'`,
            runId: termRecord.runId,
          });
        } else {
          terminalRecordsByRun.set(termRecord.runId, termRecord);
        }
      }
    }

    // 3. Check Invariant B cross-consistency:
    // A run may have multiple immutable evidence snapshots, but at most one authoritative terminal record.
    for (const [runId, bundles] of bundlesByRun.entries()) {
      const terminalBundles = bundles.filter((b) => isTerminalStatus(b.terminalState.status));
      const establishedTerminalRecord = terminalRecordsByRun.get(runId);

      if (establishedTerminalRecord) {
        // If an authoritative terminal record exists, all terminal bundles for this run in accepted/
        // MUST equal the authoritative bundleId. Any different terminal bundle is a TERMINAL_CONFLICT!
        for (const tb of terminalBundles) {
          if (tb.bundleId !== establishedTerminalRecord.bundleId) {
            failures.push({
              code: "TERMINAL_CONFLICT",
              message: `Contradictory terminal bundle in accepted archive: bundle '${tb.bundleId}' claims terminal status '${tb.terminalState.status}', but authoritative terminal record designates bundle '${establishedTerminalRecord.bundleId}'`,
              bundleId: tb.bundleId,
              runId,
            });
          }
        }
      } else {
        // If NO terminal record is established in runs/, but accepted/ contains multiple distinct terminal bundles for this run:
        if (terminalBundles.length > 1) {
          const distinctBundleIds = new Set(terminalBundles.map((b) => b.bundleId));
          if (distinctBundleIds.size > 1) {
            failures.push({
              code: "TERMINAL_CONFLICT",
              message: `Unfenced conflicting terminal bundles found in accepted archive for run '${runId}': ${Array.from(distinctBundleIds).join(", ")}`,
              runId,
            });
          }
        }
      }
    }

    const runIds = Array.from(bundlesByRun.keys()).sort();
    const bundleIds = Array.from(acceptedBundles.keys()).sort();

    // Determine overall fourfold and replay validity
    const replayValid = bundleSummaries.length > 0 && bundleSummaries.every((s) => s.replayValid);
    const secretPolicySatisfied = bundleSummaries.every((s) => s.secretPolicySatisfied);
    const fourfoldSatisfied = bundleSummaries.every((s) => s.fourfoldSatisfied);
    const thresholdSatisfied = bundleSummaries.every((s) => s.thresholdSatisfied ?? true);
    const terminalAuthorityValid =
      terminalRecords.length > 0
        ? terminalRecords.every((r) => r.hashValid && r.bundlePresent && r.bundleMatches)
        : true;

    // Determine primary authoritative terminal bundle if single run
    let authoritativeTerminalBundleId: string | undefined = undefined;
    let terminalOutcome: string | undefined = undefined;
    if (runIds.length === 1 && terminalRecords.length === 1) {
      authoritativeTerminalBundleId = terminalRecords[0]!.bundleId;
      terminalOutcome = terminalRecords[0]!.terminalOutcome;
    }

    return {
      status: failures.length === 0 ? "VERIFIED" : "FAILED",
      targetType: "ARCHIVE",
      runIds,
      bundleIds,
      authoritativeTerminalBundleId,
      terminalOutcome,
      thresholdSatisfied,
      replayValid,
      policyValid: true,
      secretPolicySatisfied,
      evidenceComplete: fourfoldSatisfied,
      fourfoldSatisfied,
      terminalAuthorityValid,
      failures,
      bundleSummaries,
      terminalRecords,
    };
  }

  /**
   * Inspects safe metadata from evidence without asserting validity.
   */
  static inspectEvidence(targetPath: string): AuditInspectionResult {
    if (!fs.existsSync(targetPath)) {
      throw new Error(`Evidence target not found: ${targetPath}`);
    }

    assertPathSafety(targetPath);
    const stat = fs.statSync(targetPath);

    if (stat.isFile()) {
      const raw = fs.readFileSync(targetPath, "utf8");
      const parsed = JSON.parse(raw);
      const bundle = parsed as EvidenceBundle;
      const authorities: string[] = [];
      if (bundle.signatures && Array.isArray(bundle.signatures)) {
        for (const s of bundle.signatures) {
          if (s.authorityId) authorities.push(s.authorityId);
          else if (s.keyId) authorities.push(s.keyId);
        }
      } else if (bundle.signature) {
        authorities.push(bundle.signature.authorityId ?? bundle.signature.keyId);
      }

      return {
        status: "INSPECTED",
        targetType: "SINGLE_BUNDLE",
        runIds: [bundle.run.runId],
        bundles: [
          {
            bundleId: bundle.bundleId,
            runId: bundle.run.runId,
            terminalOutcome: bundle.terminalState?.status ?? "UNKNOWN",
            checkpointCount: bundle.checkpoints?.length ?? 0,
            actionCount: bundle.actions?.length ?? 0,
            attemptCount: bundle.attempts?.length ?? 0,
            contractHash: bundle.contract?.contentHash ?? bundle.contract?.spec?.contractId ?? "",
            provenanceRoot: bundle.provenanceRoot ?? "",
            authorities,
          },
        ],
        terminalRecords: [],
        disclaimer: "Inspection only — evidence has NOT been verified.",
      };
    } else {
      const acceptedDir = path.join(targetPath, "accepted");
      const runsDir = path.join(targetPath, "runs");
      const runIdsSet = new Set<string>();
      const bundlesList: any[] = [];
      const terminalList: any[] = [];

      if (fs.existsSync(acceptedDir)) {
        const files = fs.readdirSync(acceptedDir).filter((f) => f.endsWith(".json"));
        for (const file of files) {
          try {
            const raw = fs.readFileSync(path.join(acceptedDir, file), "utf8");
            const bundle = JSON.parse(raw) as EvidenceBundle;
            runIdsSet.add(bundle.run.runId);
            const authorities: string[] = [];
            if (bundle.signatures && Array.isArray(bundle.signatures)) {
              for (const s of bundle.signatures) {
                if (s.authorityId) authorities.push(s.authorityId);
                else if (s.keyId) authorities.push(s.keyId);
              }
            } else if (bundle.signature) {
              authorities.push(bundle.signature.authorityId ?? bundle.signature.keyId);
            }
            bundlesList.push({
              bundleId: bundle.bundleId,
              runId: bundle.run.runId,
              terminalOutcome: bundle.terminalState?.status ?? "UNKNOWN",
              checkpointCount: bundle.checkpoints?.length ?? 0,
              actionCount: bundle.actions?.length ?? 0,
              attemptCount: bundle.attempts?.length ?? 0,
              contractHash: bundle.contract?.contentHash ?? bundle.contract?.spec?.contractId ?? "",
              provenanceRoot: bundle.provenanceRoot ?? "",
              authorities,
            });
          } catch {}
        }
      }

      if (fs.existsSync(runsDir)) {
        const runDirs = fs.readdirSync(runsDir);
        for (const rd of runDirs) {
          const tPath = path.join(runsDir, rd, "terminal.json");
          if (fs.existsSync(tPath)) {
            try {
              const raw = fs.readFileSync(tPath, "utf8");
              const t = JSON.parse(raw);
              terminalList.push({
                runId: t.runId,
                bundleId: t.bundleId,
                terminalOutcome: t.terminalOutcome,
                recordedAt: t.recordedAt,
                recordHash: t.recordHash,
              });
            } catch {}
          }
        }
      }

      return {
        status: "INSPECTED",
        targetType: "ARCHIVE",
        runIds: Array.from(runIdsSet).sort(),
        bundles: bundlesList,
        terminalRecords: terminalList,
        disclaimer: "Inspection only — evidence has NOT been verified.",
      };
    }
  }

  /**
   * Formats a human-readable audit report string.
   */
  static formatHumanReport(result: AuditVerificationResult): string {
    const lines: string[] = [];
    lines.push("Emerald Offline Evidence Audit");
    lines.push("--------------------------------");
    lines.push(`Status: ${result.status}`);
    lines.push("");

    if (result.runIds.length > 0) {
      lines.push("Run:");
      lines.push(`  runId: ${result.runIds.join(", ")}`);
      lines.push("");
    }

    lines.push("Evidence:");
    lines.push(`  bundles: ${result.bundleIds.length}`);
    if (result.authoritativeTerminalBundleId) {
      lines.push(`  terminal bundle: ${result.authoritativeTerminalBundleId}`);
    }
    lines.push("");

    if (result.terminalOutcome) {
      lines.push("Terminal:");
      lines.push(`  outcome: ${result.terminalOutcome}`);
      lines.push(`  authoritative: ${result.terminalAuthorityValid ? "yes" : "no"}`);
      lines.push("");
    }

    lines.push("Authorities:");
    lines.push("  threshold: 2-of-3");
    lines.push(`  satisfied: ${result.thresholdSatisfied ? "yes" : "no"}`);
    lines.push("");

    lines.push("Replay:");
    lines.push(`  event chain: ${result.replayValid ? "PASS" : "FAIL"}`);
    lines.push(`  provenance: ${result.replayValid ? "PASS" : "FAIL"}`);
    lines.push(`  checkpoint continuity: ${result.replayValid ? "PASS" : "FAIL"}`);
    lines.push("");

    lines.push("Fourfold:");
    lines.push(`  TaskSatisfied: ${result.fourfoldSatisfied ? "PASS" : "FAIL"}`);
    lines.push(`  VerificationPassed: ${result.fourfoldSatisfied ? "PASS" : "FAIL"}`);
    lines.push(`  PolicySatisfied: ${result.policyValid ? "PASS" : "FAIL"}`);
    lines.push(`  EvidenceComplete: ${result.evidenceComplete ? "PASS" : "FAIL"}`);
    lines.push("");

    if (result.failures.length > 0) {
      lines.push("Failures:");
      for (const f of result.failures) {
        lines.push(`  - [${f.code}] ${f.message}`);
      }
      lines.push("");
    }

    lines.push(`Final:\n  ${result.status === "VERIFIED" ? "VERIFIED" : "NOT VERIFIED"}`);
    return lines.join("\n");
  }

  /**
   * Formats human-readable inspection report string.
   */
  static formatHumanInspection(result: AuditInspectionResult): string {
    const lines: string[] = [];
    lines.push("Emerald Evidence Inspection (Unverified)");
    lines.push("----------------------------------------");
    lines.push(`Target Type: ${result.targetType}`);
    lines.push(`Run IDs: ${result.runIds.join(", ") || "none"}`);
    lines.push(`Bundles Count: ${result.bundles.length}`);
    lines.push("");

    for (const b of result.bundles) {
      lines.push(`Bundle: ${b.bundleId}`);
      lines.push(`  runId: ${b.runId}`);
      lines.push(`  outcome: ${b.terminalOutcome}`);
      lines.push(`  checkpoints: ${b.checkpointCount}`);
      lines.push(`  actions: ${b.actionCount}, attempts: ${b.attemptCount}`);
      lines.push(`  authorities: ${b.authorities.join(", ") || "none"}`);
      lines.push(`  contractHash: ${b.contractHash}`);
      lines.push(`  provenanceRoot: ${b.provenanceRoot}`);
      lines.push("");
    }

    if (result.terminalRecords.length > 0) {
      lines.push("Terminal Records:");
      for (const t of result.terminalRecords) {
        lines.push(`  runId: ${t.runId} -> bundle: ${t.bundleId} (${t.terminalOutcome})`);
      }
      lines.push("");
    }

    lines.push(result.disclaimer);
    return lines.join("\n");
  }
}
