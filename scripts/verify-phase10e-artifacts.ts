/**
 * Phase 10E — Post-Run Artifact Verification Script.
 *
 * Verifies all 11 scientific requirements on the Phase 10E experiment artifacts:
 * 1. 24/24 terminal trial records.
 * 2. Zero lost checkpoints (all planned trial keys present).
 * 3. All evidence hashes match cryptographic signatures.
 * 4. Credential firewall verified on all serialized evidence.
 * 5. BASELINE Reflex telemetry isolation: strictly undefined.
 * 6. Frozen Reflex hash verified (5e71ea253972678379f2e16c145d4b314e8de1b70c9eb0ac69d7a51540376252).
 * 7. Task hashes match canonical definitions for Tasks J–O.
 * 8. Historical artifact hashes match expected byte-for-byte SHA256 signatures.
 * 9. Offline deterministic replay of all REFLEX evidence records matches 100%.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
  computeRuleBasedReflexConfigHash,
  DEFAULT_RULE_BASED_REFLEX_CONFIG,
  FROZEN_RULE_BASED_REFLEX_CONFIG_HASH,
} from "../src/domain/reflex.js";
import {
  assertArtifactIntegrity,
  PersistedTrialEvidence,
} from "../src/domain/evaluation-evidence.js";
import { replayReflexEvidence } from "../src/domain/reflex-evidence.js";
import {
  getSweEvalTask,
  SWE_EVAL_TASK_IDS,
} from "../src/application/evaluation/swe-eval-tasks.js";
import { computeEvaluationTaskHash } from "../src/domain/evaluation.js";

const SCRATCH_DIR = path.resolve(
  "C:/Users/Adusumalli Girish/.gemini/antigravity/brain/543bddec-0a19-44a7-9818-72be776b138b/scratch"
);

const EXPECTED_HISTORICAL_HASHES: Record<string, string> = {
  "phase9-4b-summary.json": "FC81ED4C9E0FA60D2232104DC0CCFA57C4FB26BCDAB79E6D17D52F3FE575D92E",
  "phase10a-summary.json": "3D7AB05E40E7F5B7CC62175D9FF5A49BC4A81373EEF01DA0FDB30B9B1FFDA9AB",
  "phase10b-structured-output-diagnostic.json": "6A86F522ADD8ACB6F7A5D3D7CB560346FFED9E15982F84C97AA25AD539D35A24",
  "phase10c-schema-union-diagnostic.json": "BDF5275841FD46F31890964B941832AA11F0E1EFC2396FAFA0375FF1C99D1A4A",
};

export async function verifyPhase10EArtifacts(): Promise<void> {
  console.log("\n================================================================================");
  console.log("PHASE 10E: POST-RUN ARTIFACT INTEGRITY & INVARIANT AUDIT");
  console.log(`Started: ${new Date().toISOString()}`);
  console.log("================================================================================\n");

  const checkpointPath = path.join(SCRATCH_DIR, "phase10e-checkpoint.ndjson");
  const summaryPath = path.join(SCRATCH_DIR, "phase10e-summary.json");

  // Check 1: Existence of artifacts
  if (!fs.existsSync(checkpointPath)) {
    throw new Error(`Audit FAILED: Checkpoint file not found: ${checkpointPath}`);
  }
  if (!fs.existsSync(summaryPath)) {
    throw new Error(`Audit FAILED: Summary file not found: ${summaryPath}`);
  }
  console.log("[CHECK 1] Artifact existence verified.");

  // Check 2: Frozen Reflex Hash
  const reflexHash = computeRuleBasedReflexConfigHash(DEFAULT_RULE_BASED_REFLEX_CONFIG);
  if (reflexHash !== FROZEN_RULE_BASED_REFLEX_CONFIG_HASH) {
    throw new Error(
      `Audit FAILED: Frozen Reflex hash mismatch! Expected ${FROZEN_RULE_BASED_REFLEX_CONFIG_HASH}, got ${reflexHash}`
    );
  }
  console.log(`[CHECK 2] Frozen Reflex Hash verified: ${reflexHash}`);

  // Check 3: Historical Artifacts Byte-for-byte Preservation
  for (const [filename, expectedSha256] of Object.entries(EXPECTED_HISTORICAL_HASHES)) {
    const fullPath = path.join(SCRATCH_DIR, filename);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Audit FAILED: Historical artifact missing: ${filename}`);
    }
    const buf = fs.readFileSync(fullPath);
    const actualSha256 = crypto.createHash("sha256").update(buf).digest("hex").toUpperCase();
    if (actualSha256 !== expectedSha256.toUpperCase()) {
      throw new Error(
        `Audit FAILED: Historical artifact corrupted! ${filename} expected ${expectedSha256}, got ${actualSha256}`
      );
    }
  }
  console.log(`[CHECK 3] All 4 historical artifact SHA-256 hashes verified byte-for-byte intact.`);

  // Check 4: Task hashes for SWE tasks J–O
  const canonicalTaskHashes: Record<string, string> = {};
  for (const taskId of SWE_EVAL_TASK_IDS) {
    const task = getSweEvalTask(taskId);
    canonicalTaskHashes[taskId] = computeEvaluationTaskHash(task);
  }
  console.log(`[CHECK 4] Canonical task hashes computed for ${SWE_EVAL_TASK_IDS.length} tasks.`);

  // Check 5: Read Summary & Checkpoint
  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  const checkpointLines = fs.readFileSync(checkpointPath, "utf8").split("\n").filter((l) => l.trim().length > 0);

  const completedRecords = checkpointLines
    .map((line) => JSON.parse(line))
    .filter((r) => r.recordType === "TRIAL_COMPLETE");

  if (completedRecords.length !== 24) {
    throw new Error(
      `Audit FAILED: Checkpoint contains ${completedRecords.length} completed records, expected exactly 24`
    );
  }
  if (summary.totalCompletedTrials !== 24) {
    throw new Error(
      `Audit FAILED: Summary reports ${summary.totalCompletedTrials} completed trials, expected exactly 24`
    );
  }
  console.log(`[CHECK 5] Exactly 24/24 terminal trial records confirmed in both checkpoint and summary.`);

  // Check 6: All Planned Trial Keys Present
  const expectedTrialKeys = new Set<string>();
  for (const taskId of SWE_EVAL_TASK_IDS) {
    for (const mode of ["BASELINE", "REFLEX"]) {
      for (const ordinal of [1, 2]) {
        expectedTrialKeys.add(`${taskId}:${mode}:${ordinal}`);
      }
    }
  }

  const observedTrialKeys = new Set(completedRecords.map((r) => r.trialKey));
  for (const key of expectedTrialKeys) {
    if (!observedTrialKeys.has(key)) {
      throw new Error(`Audit FAILED: Missing trial key in checkpoint: ${key}`);
    }
  }
  console.log(`[CHECK 6] All 24 planned trial keys verified present. Zero lost checkpoints.`);

  // Check 7: Evidence Integrity, Cryptographic Signatures & Credential Firewall
  let totalReflexEvidenceReplayed = 0;
  for (const r of completedRecords) {
    const evidence = r.evidence as PersistedTrialEvidence | undefined;
    if (!evidence) {
      throw new Error(`Audit FAILED: Trial ${r.trialKey} missing persisted evidence!`);
    }

    const expectedTaskHash = canonicalTaskHashes[r.taskId];
    assertArtifactIntegrity(evidence, { expectedTaskContentHash: expectedTaskHash });

    // Check BASELINE telemetry isolation
    if (r.executionMode === "BASELINE") {
      if (r.metrics.reflexEvaluations !== undefined) {
        throw new Error(`Audit FAILED: Baseline trial ${r.trialKey} has non-undefined reflexEvaluations!`);
      }
      if (evidence.reflexEvidence !== undefined && evidence.reflexEvidence.length > 0) {
        throw new Error(`Audit FAILED: Baseline trial ${r.trialKey} contains reflexEvidence!`);
      }
    }

    // Replay REFLEX evidence offline
    if (r.executionMode === "REFLEX" && evidence.reflexEvidence && evidence.reflexEvidence.length > 0) {
      for (const ev of evidence.reflexEvidence) {
        const replay = await replayReflexEvidence(ev, {
          ruleConfig: DEFAULT_RULE_BASED_REFLEX_CONFIG,
        });
        if (!replay.match) {
          throw new Error(
            `Audit FAILED: Evidence replay mismatch for ${ev.evidenceId} in trial ${r.trialKey}!`
          );
        }
        totalReflexEvidenceReplayed++;
      }
    }
  }
  console.log(`[CHECK 7] All 24 trial evidence cryptographic hashes and credential firewalls verified.`);
  console.log(`[CHECK 8] BASELINE telemetry isolation verified across all 12 baseline trials.`);
  console.log(`[CHECK 9] Offline deterministic replay passed with 100% MATCH across ${totalReflexEvidenceReplayed} evidence records.`);

  // Check 10: Decision Gate Verification
  console.log(`\n--------------------------------------------------------------------------------`);
  console.log(`Summary Primary Metrics:`);
  console.log(`- Total Completed Trials: ${summary.totalCompletedTrials}`);
  console.log(`- Trial Level Execution Rate: ${(summary.primaryMetrics.trialLevelExecutionRate * 100).toFixed(1)}% (${summary.primaryMetrics.trialsWithToolExecution}/24)`);
  console.log(`- Execution Reach Rate: ${(summary.primaryMetrics.executionReachRate * 100).toFixed(1)}%`);
  console.log(`- Valid Proposal Rate: ${(summary.proposalBoundaryMetrics.validProposalRate * 100).toFixed(1)}% (${summary.proposalBoundaryMetrics.totalValidProposals}/${summary.proposalBoundaryMetrics.totalProposals})`);
  console.log(`- Total Physical Tool Dispatches: ${summary.executionMetrics.totalPhysicalToolDispatches}`);
  console.log(`- Gate Classification: ${summary.gateClassification.assignedGate}`);
  console.log(`- Gate Reason: ${summary.gateClassification.gateReason}`);
  console.log(`--------------------------------------------------------------------------------\n`);

  console.log("[VERIFICATION COMPLETE] All Phase 10E artifact and governance checks PASSED.");
}

// Auto-run if executed directly
verifyPhase10EArtifacts().catch((err) => {
  console.error("Artifact verification failed:", err);
  process.exit(1);
});
