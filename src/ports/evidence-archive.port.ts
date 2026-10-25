import {
  ArchiveRecord,
  ArchiveVerificationResult,
  AuthoritativeTerminalRecord,
  EvidenceBundle,
  IngestionReasonCode,
  TerminalVerificationResult,
} from "../domain/evidence-bundle.js";

/**
 * Port interface for content-addressed immutable evidence archival and quarantine isolation.
 */
export interface EvidenceArchivePort {
  /**
   * Checks if an accepted bundle exists for the specified bundleId.
   */
  hasAccepted(bundleId: string): boolean;

  /**
   * Retrieves the canonical UTF-8 bytes of an accepted bundle, or null if not found.
   */
  getAcceptedBytes(bundleId: string): string | null;

  /**
   * Retrieves and parses an accepted bundle, or null if not found.
   */
  getAcceptedBundle(bundleId: string): EvidenceBundle | null;

  /**
   * Immutably stores an accepted bundle into the content-addressed archive.
   * If the bundle already exists with identical bytes, returns the existing record idempotently.
   * If the bundle already exists with different bytes, throws an error.
   */
  storeAccepted(bundle: EvidenceBundle, rawCanonicalJson: string): ArchiveRecord;

  /**
   * Stores a quarantined payload into the isolated quarantine directory.
   * Returns the quarantine path or reference identifier.
   */
  storeQuarantined(params: {
    quarantineId: string;
    reasonCode: IngestionReasonCode;
    rawPayload: string;
    bundleId?: string;
  }): string;

  /**
   * Re-verifies an archived bundle from the content-addressed store without external runtime dependencies.
   */
  verifyArchivedBundle(bundleId: string, keyring?: unknown): ArchiveVerificationResult;

  /**
   * Checks if an authoritative terminal record exists for a runId.
   */
  hasTerminalRecord(runId: string): boolean;

  /**
   * Retrieves the authoritative terminal record for a runId, or null if none exists.
   */
  getTerminalRecord(runId: string): AuthoritativeTerminalRecord | null;

  /**
   * Establishes the authoritative terminal record for a runId.
   * Throws if an authoritative record already exists with a different bundleId.
   */
  establishAuthoritativeTerminal(record: AuthoritativeTerminalRecord): void;

  /**
   * Verifies the authoritative terminal record for a runId against the accepted bundle.
   */
  verifyTerminalRecord(runId: string): TerminalVerificationResult;
}
