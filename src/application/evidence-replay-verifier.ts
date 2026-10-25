/**
 * Offline Deterministic Evidence Replay Verifier for Emerald Agent Fabric.
 *
 * Implements pure, offline verification of an EvidenceBundle without accessing
 * the original runtime, SQLite database, filesystem, Docker, network, or model inference.
 */

import {
  computeBundleId,
  computeEventHash,
  computeGenesisEventHash,
  computeProvenanceRoot,
  EvidenceBundle,
  EvidenceBundleContent,
  FourfoldReplayOutcome,
  ReplayVerificationResult,
} from "../domain/evidence-bundle.js";
import {
  canonicalJsonStringify,
  computeCanonicalHash,
  sha256Hex,
} from "../domain/canonical-hash.js";
import { AttemptSnapshot, createAttemptIdempotencyToken } from "../domain/attempt.js";
import { RunSnapshot } from "../domain/invariants.js";

export class EvidenceReplayVerifier {
  /**
   * Performs an offline, clean-room verification of an EvidenceBundle.
   * Completely deterministic, zero-network, zero-filesystem, zero-model.
   */
  static verify(bundle: EvidenceBundle): ReplayVerificationResult {
    const failures: string[] = [];

    // -------------------------------------------------------------------------
    // 1. Schema & Version Validation
    // -------------------------------------------------------------------------
    if (bundle.formatVersion !== "emerald-evidence-bundle-v1") {
      failures.push(
        `Invalid formatVersion: expected 'emerald-evidence-bundle-v1', got '${bundle.formatVersion}'`
      );
    }
    if (bundle.schemaVersion !== 1) {
      failures.push(
        `Invalid schemaVersion: expected 1, got ${bundle.schemaVersion}`
      );
    }

    // -------------------------------------------------------------------------
    // 2. Bundle Content & Identity Integrity (P1, P2)
    // -------------------------------------------------------------------------
    let bundleIntegrity = true;
    const { bundleId, ...content } = bundle;
    const computedBundleId = computeBundleId(content as EvidenceBundleContent);
    if (computedBundleId !== bundleId) {
      bundleIntegrity = false;
      failures.push(
        `Bundle identity mismatch: expected '${computedBundleId}', got '${bundleId}'`
      );
    }

    // -------------------------------------------------------------------------
    // 3. Contract Content Hash Integrity (P3)
    // -------------------------------------------------------------------------
    let contractIntegrity = true;
    if (!bundle.contract?.spec || !bundle.contract?.contentHash) {
      contractIntegrity = false;
      failures.push("Missing or malformed contract specification in evidence bundle");
    } else {
      const { contentHash: recomputedContractHash } = computeCanonicalHash(
        bundle.contract.spec
      );
      if (recomputedContractHash !== bundle.contract.contentHash) {
        contractIntegrity = false;
        failures.push(
          `Contract specification contentHash mismatch: expected '${recomputedContractHash}', got '${bundle.contract.contentHash}'`
        );
      }
      if (
        bundle.run?.contractBinding &&
        bundle.contract.contentHash !== bundle.run.contractBinding.contentHash
      ) {
        contractIntegrity = false;
        failures.push(
          `Run contract binding hash mismatch: run bound '${bundle.run.contractBinding.contentHash}', contract hash is '${bundle.contract.contentHash}'`
        );
      }
    }

    // -------------------------------------------------------------------------
    // 4. Event Sequence & Hash Chain Integrity (P4, P5, P6)
    // -------------------------------------------------------------------------
    let eventIntegrity = true;
    const events = bundle.events ?? [];
    if (events.length === 0) {
      eventIntegrity = false;
      failures.push("Evidence bundle contains an empty event stream");
    } else {
      let expectedPrevHash = computeGenesisEventHash(bundle.run?.runId ?? "");
      for (let i = 0; i < events.length; i++) {
        const ev = events[i]!;
        const expectedSeq = i + 1;

        if (ev.sequence !== expectedSeq) {
          eventIntegrity = false;
          failures.push(
            `Event sequence gap or disorder at index ${i}: expected ${expectedSeq}, got ${ev.sequence}`
          );
        }

        if (ev.runId !== bundle.run?.runId) {
          eventIntegrity = false;
          failures.push(
            `Event at sequence ${ev.sequence} has mismatched runId: expected '${bundle.run?.runId}', got '${ev.runId}'`
          );
        }

        if (ev.previousEventHash !== expectedPrevHash) {
          eventIntegrity = false;
          failures.push(
            `Event hash chain broken at sequence ${ev.sequence}: expected previousEventHash '${expectedPrevHash}', got '${ev.previousEventHash}'`
          );
        }

        const recomputedHash = computeEventHash(ev, expectedPrevHash);
        if (ev.eventHash !== recomputedHash) {
          eventIntegrity = false;
          failures.push(
            `Event hash integrity failure at sequence ${ev.sequence}: expected '${recomputedHash}', got '${ev.eventHash}'`
          );
        }

        expectedPrevHash = ev.eventHash;
      }
    }

    // -------------------------------------------------------------------------
    // 5. Action & Attempt Relationships & Monotonicity (P7, P8, P9, P12)
    // -------------------------------------------------------------------------
    let attemptIntegrity = true;
    const actions = bundle.actions ?? [];
    const attempts = bundle.attempts ?? [];
    const actionMap = new Map<string, (typeof actions)[0]>();
    for (const a of actions) {
      actionMap.set(a.actionId, a);
    }

    // Group attempts by action
    const attemptsByAction = new Map<string, AttemptSnapshot[]>();
    for (const att of attempts) {
      if (!actionMap.has(att.actionId)) {
        attemptIntegrity = false;
        failures.push(
          `Attempt '${att.attemptId}' references nonexistent actionId '${att.actionId}'`
        );
      }
      if (att.runId !== bundle.run?.runId) {
        attemptIntegrity = false;
        failures.push(
          `Attempt '${att.attemptId}' has mismatched runId: expected '${bundle.run?.runId}', got '${att.runId}'`
        );
      }

      // Recompute idempotency token
      const expectedToken = createAttemptIdempotencyToken(
        bundle.run?.runId ?? "",
        att.actionId,
        att.attemptNumber
      );
      if (att.idempotencyToken !== expectedToken) {
        attemptIntegrity = false;
        failures.push(
          `Attempt '${att.attemptId}' idempotencyToken mismatch: expected '${expectedToken}', got '${att.idempotencyToken}'`
        );
      }

      const list = attemptsByAction.get(att.actionId) ?? [];
      list.push(att);
      attemptsByAction.set(att.actionId, list);
    }

    // Check attempt monotonicity and historical immutability
    for (const [actionId, actionAttempts] of attemptsByAction.entries()) {
      actionAttempts.sort((a, b) => a.attemptNumber - b.attemptNumber);
      for (let j = 0; j < actionAttempts.length; j++) {
        const expectedAttNum = j + 1;
        const currentAtt = actionAttempts[j]!;

        if (currentAtt.attemptNumber !== expectedAttNum) {
          attemptIntegrity = false;
          failures.push(
            `Attempt number non-monotonic for action '${actionId}': expected ${expectedAttNum}, got ${currentAtt.attemptNumber}`
          );
        }

        // Prior attempts (1..K-1) must be in terminal or reconciled states
        if (j < actionAttempts.length - 1) {
          const activeStatuses = new Set(["CREATED", "DISPATCHED", "RUNNING"]);
          if (activeStatuses.has(currentAtt.status)) {
            attemptIntegrity = false;
            failures.push(
              `Historical attempt ${currentAtt.attemptNumber} for action '${actionId}' was left in non-terminal state '${currentAtt.status}'`
            );
          }
        }
      }
    }

    // Verify contract continuity across actions
    for (const act of actions) {
      if (
        bundle.contract?.spec &&
        (act.contractBinding?.contractId !== bundle.contract.spec.contractId ||
          act.contractBinding?.version !== bundle.contract.spec.version ||
          act.contractBinding?.contentHash !== bundle.contract.contentHash)
      ) {
        attemptIntegrity = false;
        failures.push(
          `Contract continuity failure for action '${act.actionId}': contract identity diverges from bundle contract`
        );
      }
    }

    // -------------------------------------------------------------------------
    // 6. Checkpoint Continuity (P10)
    // -------------------------------------------------------------------------
    let checkpointIntegrity = true;
    const checkpoints = bundle.checkpoints ?? [];
    let prevCheckpointVersion = 0;

    for (const ckpt of checkpoints) {
      if (ckpt.checkpointVersion <= prevCheckpointVersion) {
        checkpointIntegrity = false;
        failures.push(
          `Checkpoint version non-monotonic: expected > ${prevCheckpointVersion}, got ${ckpt.checkpointVersion}`
        );
      }
      prevCheckpointVersion = ckpt.checkpointVersion;

      if (ckpt.eventSequence > events.length) {
        checkpointIntegrity = false;
        failures.push(
          `Checkpoint '${ckpt.checkpointId}' references future event sequence ${ckpt.eventSequence} (total events: ${events.length})`
        );
      }

      if (
        bundle.contract?.contentHash &&
        ckpt.contractBinding.contentHash !== bundle.contract.contentHash
      ) {
        checkpointIntegrity = false;
        failures.push(
          `Checkpoint '${ckpt.checkpointId}' contractBinding hash mismatch: expected '${bundle.contract.contentHash}', got '${ckpt.contractBinding.contentHash}'`
        );
      }

      if (ckpt.actionId && !actionMap.has(ckpt.actionId)) {
        checkpointIntegrity = false;
        failures.push(
          `Checkpoint '${ckpt.checkpointId}' references nonexistent actionId '${ckpt.actionId}'`
        );
      }
    }

    // -------------------------------------------------------------------------
    // 7. Authority Provenance (P11)
    // -------------------------------------------------------------------------
    let authorityIntegrity = true;
    for (const att of attempts) {
      if (!att.workerId || !att.leaseId) {
        authorityIntegrity = false;
        failures.push(
          `Attempt '${att.attemptId}' missing required worker or lease authority provenance`
        );
      }
    }

    const supervisorLeases = bundle.supervisorEvidence ?? [];
    const validSupervisorIds = new Set(supervisorLeases.map((s) => s.supervisorId));

    for (const ev of events) {
      if (ev.eventType === "run.recovered") {
        const supProducer = ev.producer;
        const supMatch = /^supervisor\.(.+)$/.exec(supProducer);
        if (supMatch && supMatch[1]) {
          const supId = supMatch[1];
          if (!validSupervisorIds.has(supId)) {
            authorityIntegrity = false;
            failures.push(
              `Recovery event at sequence ${ev.sequence} produced by unauthorized supervisor '${supId}'`
            );
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // 8. Verification Evidence Binding (P13)
    // -------------------------------------------------------------------------
    let verificationIntegrity = true;
    const bundledEvidence = bundle.verificationEvidence ?? [];
    const evidenceMap = new Map<string, (typeof bundledEvidence)[0]>();

    for (const evi of bundledEvidence) {
      if (!evi.contentHash || !/^[0-9a-f]{64}$/.test(evi.contentHash)) {
        verificationIntegrity = false;
        failures.push(`Evidence '${evi.evidenceId}' has invalid contentHash format`);
      }
      if (evi.runId !== bundle.run?.runId) {
        verificationIntegrity = false;
        failures.push(
          `Evidence '${evi.evidenceId}' has mismatched runId: expected '${bundle.run?.runId}', got '${evi.runId}'`
        );
      }
      evidenceMap.set(evi.evidenceId, evi);
    }

    // Assert referenced evidence exists
    for (const att of attempts) {
      if (att.evidenceIds && Array.isArray(att.evidenceIds)) {
        for (const eid of att.evidenceIds) {
          if (!evidenceMap.has(eid)) {
            verificationIntegrity = false;
            failures.push(
              `Attempt '${att.attemptId}' references missing verification evidence '${eid}'`
            );
          }
        }
      }
    }

    for (const vRes of bundle.verificationResults ?? []) {
      for (const eid of vRes.evidenceIds ?? []) {
        if (!evidenceMap.has(eid)) {
          verificationIntegrity = false;
          failures.push(
            `VerificationResult for spec '${vRes.specId}' references missing evidence '${eid}'`
          );
        }
      }
    }

    // -------------------------------------------------------------------------
    // 9. Fourfold Outcome Derivation (P14)
    // -------------------------------------------------------------------------
    const taskSatisfied =
      bundle.terminalState?.status === "COMPLETED" ||
      events.some(
        (e) =>
          e.eventType === "run.completed" ||
          (e.payload as any)?.isGoalReached === true ||
          (e.payload as any)?.terminalReason === "GOAL_REACHED"
      );

    // Evaluate verification specs independently
    const vSpecs = bundle.contract?.spec?.verificationSpecs ?? [];
    let verificationPassed = true;

    for (const spec of vSpecs) {
      const expected = spec.expectedValue as Record<string, unknown> | undefined;

      if (spec.ruleKind === "EXIT_CODE_ZERO") {
        const targetTool = (expected?.toolName as string) ?? "run_command";
        const matchingActions = actions.filter((a) => a.toolName === targetTool);
        let passed = false;

        if (matchingActions.length > 0) {
          const lastAction = matchingActions[matchingActions.length - 1]!;
          const actionAtts = attemptsByAction.get(lastAction.actionId) ?? [];
          if (actionAtts.length > 0) {
            const lastAtt = actionAtts[actionAtts.length - 1]!;
            const code =
              lastAtt.exitCode !== null && lastAtt.exitCode !== undefined
                ? lastAtt.exitCode
                : (lastAtt.outputPayload as any)?.exitCode !== undefined
                ? (lastAtt.outputPayload as any).exitCode
                : null;
            passed = code === 0;
          }
        }

        if (!passed) {
          verificationPassed = false;
        }
      } else if (spec.ruleKind === "CLEAN_ROOM_DUAL_GATE") {
        const vResult = (bundle.verificationResults ?? []).find(
          (r) => r.specId === spec.specId
        );
        if (!vResult || vResult.status !== "VERIFIED") {
          verificationPassed = false;
        }
      }
    }

    // Policy verification
    const allowedCapabilities = new Set(bundle.contract?.spec?.policy?.allowedCapabilities ?? []);
    let policySatisfied = true;
    for (const act of actions) {
      if (allowedCapabilities.size > 0 && !allowedCapabilities.has(act.toolName as any)) {
        policySatisfied = false;
        failures.push(`Action '${act.actionId}' used unauthorized capability '${act.toolName}'`);
      }
    }

    const maxAttempts = bundle.contract?.spec?.resourceLimits?.maxAttempts ?? 10;
    for (const att of attempts) {
      if (att.attemptNumber > maxAttempts) {
        policySatisfied = false;
        failures.push(
          `Attempt number ${att.attemptNumber} exceeds contract maxAttempts ceiling ${maxAttempts}`
        );
      }
    }

    const evidenceComplete =
      vSpecs.length === 0 ||
      (verificationPassed && (bundle.verificationResults ?? []).length >= 0);

    const fourfoldOutcome: FourfoldReplayOutcome = {
      taskSatisfied,
      verificationPassed,
      policySatisfied,
      evidenceComplete,
    };

    // -------------------------------------------------------------------------
    // 10. Terminal Outcome Derivation (P15)
    // -------------------------------------------------------------------------
    let derivedTerminalOutcome: RunSnapshot["status"] = "FAILED";
    if (
      taskSatisfied &&
      verificationPassed &&
      policySatisfied &&
      evidenceComplete
    ) {
      derivedTerminalOutcome = "COMPLETED";
    }

    // Detect fourfold false success claims
    if (
      bundle.run?.status === "COMPLETED" &&
      derivedTerminalOutcome !== "COMPLETED"
    ) {
      failures.push(
        `Fourfold outcome mismatch: run marked COMPLETED by producer, but replay derived '${derivedTerminalOutcome}' (verificationPassed: ${verificationPassed}, taskSatisfied: ${taskSatisfied}, policySatisfied: ${policySatisfied})`
      );
    }

    // -------------------------------------------------------------------------
    // 11. Subsystem Roots & Provenance Root Verification
    // -------------------------------------------------------------------------
    const contractHash = bundle.contract?.contentHash ?? "";
    const eventRoot =
      events.length > 0
        ? events[events.length - 1]!.eventHash
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

    if (recomputedProvenanceRoot !== bundle.provenanceRoot) {
      failures.push(
        `Provenance root mismatch: expected '${recomputedProvenanceRoot}', got '${bundle.provenanceRoot}'`
      );
    }

    const valid = failures.length === 0;

    return Object.freeze({
      valid,
      bundleId: bundle.bundleId,
      provenanceRoot: bundle.provenanceRoot,
      bundleIntegrity,
      contractIntegrity,
      eventIntegrity,
      checkpointIntegrity,
      attemptIntegrity,
      authorityIntegrity,
      verificationIntegrity,
      fourfoldOutcome,
      terminalOutcome: derivedTerminalOutcome,
      failures: Object.freeze(failures),
    });
  }
}
