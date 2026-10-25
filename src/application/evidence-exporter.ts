/**
 * Evidence Exporter for Emerald Agent Fabric.
 *
 * Implements authoritative export of an immutable, tamper-evident EvidenceBundle
 * from durable state storage. Refuses export if source evidence is internally inconsistent.
 */

import {
  buildEventHashChain,
  computeBundleId,
  computeProvenanceRoot,
  EvidenceBundle,
  EvidenceBundleContent,
} from "../domain/evidence-bundle.js";
import {
  canonicalJsonStringify,
  computeCanonicalHash,
  redactSensitiveData,
  sha256Hex,
} from "../domain/canonical-hash.js";
import { StateStorePort } from "../ports/state-store.port.js";
import { AttemptSnapshot } from "../domain/attempt.js";
import { Evidence } from "../domain/evidence.js";
import { VerificationResult } from "../domain/verification.js";

import crypto from "node:crypto";
import { EvidenceSigner } from "./evidence-signer.js";

export interface EvidenceExporterOptions {
  readonly exporterVersion?: string;
  readonly nowIso?: string;
  readonly signer?: {
    readonly privateKey: crypto.KeyObject | string;
    readonly keyId: string;
    readonly publicKeyFingerprint?: string;
    readonly publicKey?: crypto.KeyObject | string;
  };
}

export class EvidenceExporter {
  static readonly EXPORTER_VERSION = "emerald-evidence-exporter-v1";

  /**
   * Exports an authoritative, immutable EvidenceBundle for a specific runId.
   * Fails closed if source state is inconsistent, missing, or corrupted.
   */
  static exportBundle(
    stateStore: StateStorePort,
    runId: string,
    options: EvidenceExporterOptions = {}
  ): EvidenceBundle {
    const run = stateStore.getRun(runId);
    if (!run) {
      throw new Error(`Cannot export evidence bundle: Run '${runId}' not found.`);
    }

    if (!run.contractBinding) {
      throw new Error(
        `Cannot export evidence bundle: Run '${runId}' has no bound MissionContract.`
      );
    }

    const { contractId, version, contentHash } = run.contractBinding;
    const contract = stateStore.getContract(contractId, version);
    if (!contract) {
      throw new Error(
        `Cannot export evidence bundle: Bound MissionContract '${contractId}' v${version} not found.`
      );
    }

    // Assert source contract integrity
    const { contentHash: recomputedHash } = computeCanonicalHash(contract.spec);
    if (
      recomputedHash !== contract.contentHash ||
      contract.contentHash !== contentHash
    ) {
      throw new Error(
        `Cannot export evidence bundle: Contract content hash integrity failure for run '${runId}'.`
      );
    }

    // 1. Gather all events and validate gapless sequence
    const rawEvents = stateStore.getEventsForRun(runId);
    for (let i = 0; i < rawEvents.length; i++) {
      const expectedSeq = i + 1;
      const actualSeq = rawEvents[i]!.sequence;
      if (actualSeq !== expectedSeq) {
        throw new Error(
          `Cannot export evidence bundle: Non-contiguous event sequence at index ${i}: expected ${expectedSeq}, found ${actualSeq}.`
        );
      }
    }

    // 2. Gather checkpoints
    const rawCheckpoints = stateStore.getCheckpoints(runId);

    // 3. Gather actions and attempts
    const rawActions = stateStore.getActionsForRun(runId);
    const rawAttempts: AttemptSnapshot[] = [];
    for (const action of rawActions) {
      const attempts = stateStore.getAttemptsForAction(action.actionId);
      for (const att of attempts) {
        rawAttempts.push(att);
      }
    }

    // 4. Gather supervisor leases
    const supervisorEvidence = stateStore.getSupervisorLeasesForRun
      ? stateStore.getSupervisorLeasesForRun(runId)
      : [];

    // 5. Gather verification evidence and verification results from events
    const verificationEvidenceMap = new Map<string, Evidence>();
    const verificationResultsMap = new Map<string, VerificationResult>();

    for (const event of rawEvents) {
      if (event.eventType === "evidence.recorded") {
        const p = event.payload as any;
        if (p?.evidenceId && p?.contentHash) {
          const evi: Evidence = {
            evidenceId: p.evidenceId,
            runId: p.runId ?? runId,
            source: p.source ?? "PROVIDER_REPORTED",
            kind: p.kind ?? "OUTPUT_PAYLOAD",
            contentHash: p.contentHash,
            summary: p.summary,
            observedAt: p.observedAt ?? event.timestamp,
            schemaVersion: p.schemaVersion ?? 1,
          };
          verificationEvidenceMap.set(p.evidenceId, Object.freeze(evi));
        }
      } else if (event.eventType === "verification.completed") {
        const p = event.payload as any;
        const vRes: VerificationResult | undefined = p?.verificationResult ?? (p?.verifierId && p?.status ? p : undefined);
        if (vRes?.specId) {
          verificationResultsMap.set(vRes.specId, Object.freeze(vRes));
        }
      }
    }

    const verificationEvidenceList = Array.from(verificationEvidenceMap.values());
    const verificationResultsList = Array.from(verificationResultsMap.values());

    // 6. Build event hash chain
    const chainedEvents = buildEventHashChain(runId, rawEvents);

    // 7. Redact sensitive data across all collections
    const redactedRun = redactSensitiveData(run) as typeof run;
    const redactedContract = redactSensitiveData(contract) as typeof contract;
    const redactedCheckpoints = redactSensitiveData(rawCheckpoints) as typeof rawCheckpoints;
    const redactedActions = redactSensitiveData(rawActions) as typeof rawActions;
    const redactedAttempts = redactSensitiveData(rawAttempts) as typeof rawAttempts;
    const redactedSupervisorEvidence = redactSensitiveData(supervisorEvidence) as typeof supervisorEvidence;
    const redactedVerificationEvidence = redactSensitiveData(verificationEvidenceList) as typeof verificationEvidenceList;
    const redactedVerificationResults = redactSensitiveData(verificationResultsList) as typeof verificationResultsList;

    // 8. Compute subsystem roots
    const contractHash = contract.contentHash;
    const eventRoot =
      chainedEvents.length > 0
        ? chainedEvents[chainedEvents.length - 1]!.eventHash
        : sha256Hex(`empty:events:${runId}`);
    const checkpointRoot = sha256Hex(canonicalJsonStringify(redactedCheckpoints));
    const attemptRoot = sha256Hex(canonicalJsonStringify(redactedAttempts));
    const verificationRoot = sha256Hex(canonicalJsonStringify(redactedVerificationEvidence));

    const provenanceRoot = computeProvenanceRoot({
      contractHash,
      eventRoot,
      checkpointRoot,
      attemptRoot,
      verificationRoot,
    });

    const terminalState = {
      status: run.status,
      resultPayload: redactSensitiveData(run.resultPayload),
      errorPayload: redactSensitiveData(run.errorPayload),
      completedAt: run.updatedAt,
    };

    const provenance = {
      formatVersion: "emerald-evidence-bundle-v1" as const,
      schemaVersion: 1 as const,
      exportedAt: options.nowIso ?? new Date().toISOString(),
      exporterVersion: options.exporterVersion ?? EvidenceExporter.EXPORTER_VERSION,
      hostRedacted: true,
      sourceRunId: runId,
    };

    const content: EvidenceBundleContent = {
      formatVersion: "emerald-evidence-bundle-v1",
      schemaVersion: 1,
      provenanceRoot,
      run: redactedRun,
      contract: redactedContract,
      checkpoints: redactedCheckpoints,
      events: chainedEvents,
      actions: redactedActions,
      attempts: redactedAttempts,
      supervisorEvidence: redactedSupervisorEvidence,
      verificationEvidence: redactedVerificationEvidence,
      verificationResults: redactedVerificationResults,
      terminalState,
      provenance,
    };

    const bundleId = computeBundleId(content);

    const bundle: EvidenceBundle = Object.freeze({
      ...content,
      bundleId,
    });

    if (options.signer) {
      return EvidenceSigner.sign(
        bundle,
        options.signer.privateKey,
        options.signer.keyId,
        {
          publicKeyFingerprint: options.signer.publicKeyFingerprint,
          publicKey: options.signer.publicKey,
        }
      );
    }

    return bundle;
  }
}
