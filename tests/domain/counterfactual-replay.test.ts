/**
 * Emerald Agent Fabric — Phase 9.4 Test Suite
 * Counterfactual Reflex Replay on Real Live SWE Traces
 *
 * Verifies:
 * 1. Historical artifact loading & immutable provenance preservation (LIVE_OBSERVED vs COUNTERFACTUAL)
 * 2. Scenario C1: Repeated identical execution failure fires REJECT with REPEATED_FAILURE at threshold (observedCount=3)
 * 3. Scenario C2: Below-threshold failure sequence (observedCount=2 < 3) does not trigger premature intervention
 * 4. Scenario C3: Recovery after failure (intervening SUCCEEDED breaks failure streak, recovery proposal permitted)
 * 5. Scenario C4: Same tool with different inputs (H1 !== H2 !== H3) does not trigger failure loop
 * 6. Scenario C5: Repeated proposal with state changes (contextSnapshotHash changes) resets failure streak
 * 7. Scenario C6: Policy rejection (UNAUTHORIZED_CAPABILITY) does not increment execution failure streak
 * 8. Scenario C7: Proposal schema failure (INVALID_TOOL_INPUT) remains distinct from tool execution failures
 * 9. Scenario C8: Fail-closed UNKNOWN execution handling (UNKNOWN contributes to failure streak, prevents unobserved loops)
 * 10. Deterministic replay: 100% canonical hash equality between run 1 and run 2 across all scenarios
 * 11. Authority monotonicity: EffectiveAuthorityAfterReflex ⊆ EffectiveAuthorityBeforeReflex verified for all decisions
 * 12. Historical artifact immutability: Phase 9.4B artifacts remain byte-identical before and after replay
 * 13. Credential boundary & firewall: Zero secrets, keys, or bearer tokens in replay inputs or results
 * 14. Tamper detection: Mutating proposal payload or context hash invalidates canonical provenance
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  runAllCounterfactualScenarios,
  runScenarioC1,
  runScenarioC2,
  runScenarioC3,
  runScenarioC4,
  runScenarioC5,
  runScenarioC6,
  runScenarioC7,
  runScenarioC8,
  extractTrialEvidences,
  findProposalEntry,
  proposalFromTranscriptStep,
  buildCounterfactualReflexContext,
  CounterfactualProvenanceSchema,
} from "../../src/domain/counterfactual-replay.js";
import {
  computeRuleBasedReflexConfigHash,
  computeReflexContextHash,
  DEFAULT_RULE_BASED_REFLEX_CONFIG,
  FROZEN_RULE_BASED_REFLEX_CONFIG_HASH,
  assertReflexAuthorityInvariant,
} from "../../src/domain/reflex.js";
import {
  assertCredentialBoundary,
  verifyArtifactIntegrity,
} from "../../src/domain/evaluation-evidence.js";
import { computeCanonicalHash, sha256Hex } from "../../src/domain/canonical-hash.js";
import { ActionProposal } from "../../src/domain/action-proposal.js";

import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SUMMARY_PATH = path.resolve(__dirname, "../fixtures/phase9-4b-summary.json");

function loadHistoricalSummary(): { summaryData: any; rawSummary: string } {
  if (!fs.existsSync(SUMMARY_PATH)) {
    throw new Error(`Summary artifact not found at ${SUMMARY_PATH}`);
  }
  const rawSummary = fs.readFileSync(SUMMARY_PATH, "utf-8");
  return { summaryData: JSON.parse(rawSummary), rawSummary };
}

describe("Phase 9.4 — Counterfactual Reflex Replay", () => {
  it("loads historical Phase 9.4B summary without mutating it and extracts trial evidence", () => {
    const { summaryData, rawSummary } = loadHistoricalSummary();
    const hashBefore = sha256Hex(rawSummary);

    const evidences = extractTrialEvidences(summaryData);
    expect(evidences.length).toBe(8);

    // Verify all 8 trial artifacts have valid integrity
    for (const e of evidences) {
      const integrity = verifyArtifactIntegrity(e);
      expect(integrity.valid).toBe(true);
    }

    // Historical artifact immutability
    const rawSummaryAfter = fs.readFileSync(SUMMARY_PATH, "utf-8");
    expect(sha256Hex(rawSummaryAfter)).toBe(hashBefore);
  });

  it("verifies frozen RuleBasedReflex configuration hash", () => {
    const hash = computeRuleBasedReflexConfigHash(DEFAULT_RULE_BASED_REFLEX_CONFIG);
    expect(hash).toBe(FROZEN_RULE_BASED_REFLEX_CONFIG_HASH);
  });

  it("preserves provenance separating LIVE_OBSERVED and COUNTERFACTUAL", () => {
    const { summaryData } = loadHistoricalSummary();
    const evidences = extractTrialEvidences(summaryData);
    const { trial, step } = findProposalEntry(evidences, "task-swe-futile-loop:REFLEX:1", (s) => !!s.toolName);

    const p = proposalFromTranscriptStep(step);
    const inputHash = computeCanonicalHash(p.inputPayload).contentHash;

    const liveProvenance = {
      provenanceKind: "LIVE_OBSERVED" as const,
      sourceArtifactHash: trial.artifactHash,
      sourceTrialKey: `${trial.taskIdentity.taskId}:${trial.executionMode}:${trial.trialIdentity.trialOrdinal}`,
      sourceTranscriptStepNumber: step.stepNumber,
      originalTaskId: trial.taskIdentity.taskId,
      originalTaskVersion: trial.taskIdentity.taskVersion,
      originalTaskContentHash: trial.taskIdentity.taskContentHash,
      originalProposalId: p.proposalId,
      originalToolName: p.toolName,
      originalInputPayload: p.inputPayload,
      originalInputHash: inputHash,
      originalContextHash: step.contextHash,
      scenarioId: "C1" as const,
    };
    expect(CounterfactualProvenanceSchema.safeParse(liveProvenance).success).toBe(true);

    const counterfactualProvenance = {
      ...liveProvenance,
      provenanceKind: "COUNTERFACTUAL" as const,
      syntheticOutcome: {
        status: "FAILED" as const,
        failureReason: "Synthetic tool failure",
        label: "COUNTERFACTUAL" as const,
      },
    };
    expect(CounterfactualProvenanceSchema.safeParse(counterfactualProvenance).success).toBe(true);
  });

  it("executes Scenario C1: repeated identical failures fire REJECT at threshold 3", async () => {
    const { summaryData } = loadHistoricalSummary();
    const evidences = extractTrialEvidences(summaryData);

    const res = await runScenarioC1(evidences);

    expect(res.scenarioId).toBe("C1");
    expect(res.steps.length).toBe(4);
    // Steps 1, 2, 3 have 0, 1, 2 prior failures in history -> ALLOW
    expect(res.decisionSequence[0]).toBe("ALLOW");
    expect(res.decisionSequence[1]).toBe("ALLOW");
    expect(res.decisionSequence[2]).toBe("ALLOW");
    // Step 4 has 3 prior identical failures in history -> REJECT
    expect(res.decisionSequence[3]).toBe("REJECT");
    expect(res.reasonCodes[3]).toBe("REPEATED_FAILURE");
    expect(res.ruleIds[3]).toBe("reflex.failure-loop.v1");
    expect(res.repetitionTriggered).toBe(true);
    expect(res.repetitionTriggerStep).toBe(4);
    expect(res.authorityMonotonic).toBe(true);
  });

  it("executes Scenario C2: below-threshold failure sequence (2 < 3) does not trigger intervention", async () => {
    const { summaryData } = loadHistoricalSummary();
    const evidences = extractTrialEvidences(summaryData);

    const res = await runScenarioC2(evidences);

    expect(res.scenarioId).toBe("C2");
    expect(res.steps.length).toBe(3);
    // All steps below threshold 3 remain ALLOW
    expect(res.decisionSequence).toEqual(["ALLOW", "ALLOW", "ALLOW"]);
    expect(res.reasonCodes).toEqual(["NO_INTERVENTION", "NO_INTERVENTION", "NO_INTERVENTION"]);
    expect(res.repetitionTriggered).toBe(false);
    expect(res.authorityMonotonic).toBe(true);
  });

  it("executes Scenario C3: recovery after failure resets failure streak", async () => {
    const { summaryData } = loadHistoricalSummary();
    const evidences = extractTrialEvidences(summaryData);

    const res = await runScenarioC3(evidences);

    expect(res.scenarioId).toBe("C3");
    expect(res.steps.length).toBe(3);
    // Step 1 fails, Step 2 succeeds (ALLOW), Step 3 is ALLOW because SUCCEEDED broke streak
    expect(res.decisionSequence).toEqual(["ALLOW", "ALLOW", "ALLOW"]);
    expect(res.repetitionTriggered).toBe(false);
    expect(res.authorityMonotonic).toBe(true);
  });

  it("executes Scenario C4: same tool with different inputs does not trigger failure loop", async () => {
    const { summaryData } = loadHistoricalSummary();
    const evidences = extractTrialEvidences(summaryData);

    const res = await runScenarioC4(evidences);

    expect(res.scenarioId).toBe("C4");
    expect(res.steps.length).toBe(3);
    // Even though all 3 proposals failed, their input hashes differed (H1 !== H2 !== H3)
    // RuleBasedReflex requires sameInput for failureStreak to increment
    expect(res.decisionSequence).toEqual(["ALLOW", "ALLOW", "ALLOW"]);
    expect(res.repetitionTriggered).toBe(false);
    expect(res.authorityMonotonic).toBe(true);
  });

  it("executes Scenario C5: repeated proposals with state changes reset failure streak", async () => {
    const { summaryData } = loadHistoricalSummary();
    const evidences = extractTrialEvidences(summaryData);

    const res = await runScenarioC5(evidences);

    expect(res.scenarioId).toBe("C5");
    expect(res.steps.length).toBe(4);
    // Environmental contextHash changed between proposals, breaking the streak
    expect(res.decisionSequence).toEqual(["ALLOW", "ALLOW", "ALLOW", "ALLOW"]);
    expect(res.repetitionTriggered).toBe(false);
    expect(res.authorityMonotonic).toBe(true);
  });

  it("executes Scenario C6: policy rejection does not increment execution failure streak", async () => {
    const { summaryData } = loadHistoricalSummary();
    const evidences = extractTrialEvidences(summaryData);

    const res = await runScenarioC6(evidences);

    expect(res.scenarioId).toBe("C6");
    expect(res.steps.length).toBe(4);
    // Step 1: preserved LIVE_OBSERVED policy denial
    expect(res.steps[0]?.provenance.provenanceKind).toBe("LIVE_OBSERVED");
    // Steps 2, 3, 4: authorized proposal failing execution.
    // Notice: Step 4 only has 2 execution failures in history (steps 2 & 3),
    // because step 1 was a policy rejection, NOT an executed action failure!
    // Therefore step 4 is ALLOW (2 < 3 threshold).
    expect(res.decisionSequence[3]).toBe("ALLOW");
    expect(res.repetitionTriggered).toBe(false);
    expect(res.authorityMonotonic).toBe(true);
  });

  it("executes Scenario C7: proposal schema validation failure remains distinct from execution failure", async () => {
    const { summaryData } = loadHistoricalSummary();
    const evidences = extractTrialEvidences(summaryData);

    const res = await runScenarioC7(evidences);

    expect(res.scenarioId).toBe("C7");
    expect(res.steps.length).toBe(3);
    expect(res.steps[0]?.provenance.provenanceKind).toBe("LIVE_OBSERVED");
    // Schema validation failures are handled before execution, never transformed into tool execution failures
    expect(res.decisionSequence).toEqual(["ALLOW", "ALLOW", "ALLOW"]);
    expect(res.repetitionTriggered).toBe(false);
    expect(res.authorityMonotonic).toBe(true);
  });

  it("executes Scenario C8: fail-closed UNKNOWN execution outcome contributes to failure streak", async () => {
    const { summaryData } = loadHistoricalSummary();
    const evidences = extractTrialEvidences(summaryData);

    const res = await runScenarioC8(evidences);

    expect(res.scenarioId).toBe("C8");
    expect(res.steps.length).toBe(4);
    // Step 1 has UNKNOWN, Step 2 & 3 have FAILED. Total failure streak at step 4 = 3!
    // Controller treats UNKNOWN as non-success, reaching threshold 3 -> REJECT
    expect(res.decisionSequence[0]).toBe("ALLOW");
    expect(res.decisionSequence[1]).toBe("ALLOW");
    expect(res.decisionSequence[2]).toBe("ALLOW");
    expect(res.decisionSequence[3]).toBe("REJECT");
    expect(res.reasonCodes[3]).toBe("REPEATED_FAILURE");
    expect(res.repetitionTriggered).toBe(true);
    expect(res.repetitionTriggerStep).toBe(4);
    expect(res.authorityMonotonic).toBe(true);
  });

  it("verifies determinism across dual runs and generates complete experiment artifact", async () => {
    const { summaryData } = loadHistoricalSummary();

    const experimentResult = await runAllCounterfactualScenarios(summaryData);

    expect(experimentResult.schemaVersion).toBe(1);
    expect(experimentResult.determinismVerified).toBe(true);
    expect(experimentResult.authorityMonotonicityVerified).toBe(true);
    expect(experimentResult.frozenReflexConfigurationHash).toBe(FROZEN_RULE_BASED_REFLEX_CONFIG_HASH);
    expect(experimentResult.scenarios.length).toBe(8);

    // Verify credential boundary across the entire result
    expect(() => assertCredentialBoundary(experimentResult)).not.toThrow();

    // Verify findings are present and separated
    expect(experimentResult.LIVE_OBSERVED_FINDINGS.totalTrialsAnalyzed).toBe(8);
    expect(experimentResult.LIVE_OBSERVED_FINDINGS.liveExecutionLoopsObserved).toBe(false);
    expect(experimentResult.COUNTERFACTUAL_FINDINGS.determinismVerified).toBe(true);
    expect(experimentResult.COUNTERFACTUAL_FINDINGS.authorityInvariantVerified).toBe(true);
  });

  it("enforces authority monotonicity: ALLOW never expands authority or contains forbidden keys", () => {
    const dummyProposal: ActionProposal = {
      proposalId: "prop-auth-test-001",
      toolName: "read_file",
      inputPayload: { path: "src/calc.ts" },
      contextSnapshotHash: "a".repeat(64),
      rationale: "Authority testing proposal",
    };

    const validDecision = {
      decision: "ALLOW" as const,
      reasonCode: "NO_INTERVENTION" as const,
    };
    expect(() => assertReflexAuthorityInvariant(dummyProposal, validDecision)).not.toThrow();

    const maliciousDecision = {
      decision: "ALLOW" as const,
      reasonCode: "NO_INTERVENTION" as const,
      capability: "root", // forbidden authority key
    };
    expect(() => assertReflexAuthorityInvariant(dummyProposal, maliciousDecision as any)).toThrow();
  });

  it("detects tampering when proposal or context hash is altered", () => {
    const ctx = buildCounterfactualReflexContext({
      runId: "run-tamper-test",
      taskId: "task-test",
      stepNumber: 1,
      recentActionHistory: [],
    });

    const originalHash = ctx.contextHash;
    const tamperedContext = {
      ...ctx,
      failureCount: 99,
    };
    const tamperedHash = computeReflexContextHash(tamperedContext);
    expect(tamperedHash).not.toBe(originalHash);
  });
});
