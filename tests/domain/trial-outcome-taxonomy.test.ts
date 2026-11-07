/**
 * Milestone 2.25 — Domain Trial Outcome Taxonomy & Reliability Model Tests
 *
 * Deterministic tests covering Phase 1:
 * 1. Each final outcome is representable.
 * 2. A model completion claim can coexist with any applicable final outcome.
 * 3. A verified success requires authoritative verification evidence.
 * 4. Missing specifications are distinguishable from failed criteria.
 * 5. Unavailable verification is distinguishable from failed verification.
 * 6. Loop detection remains distinct from execution failure.
 * 7. Timeout and blocked outcomes remain distinguishable.
 * 8. Legacy evaluation types remain compatible.
 */

import { describe, expect, it } from "vitest";
import {
  TRIAL_FINAL_OUTCOMES,
  type TrialFinalOutcome,
  isValidTrialFinalOutcome,
  TrialFinalOutcomeSchema,
  type ModelCompletionClaimObservation,
  ModelCompletionClaimObservationSchema,
  classifyTrialOutcome,
  type ReliabilityEvaluationMetrics,
  createReliabilityEvaluationMetrics,
  ReliabilityEvaluationMetricsSchema,
  type EvaluationStatus,
  EVALUATION_STATUSES,
  isValidEvaluationStatus,
  createEvaluationMetrics,
  createEvaluationTrial,
  createEvaluationConfigFingerprint,
} from "../../src/domain/evaluation.js";

describe("Milestone 2.25 — Domain Trial Outcome Taxonomy & Reliability Model", () => {
  // =========================================================================
  // 1. Representability of all 7 Final Outcomes
  // =========================================================================
  it("Scenario 1: Each of the 7 final outcomes is strictly representable and valid", () => {
    const expectedOutcomes: readonly TrialFinalOutcome[] = [
      "VERIFIED_SUCCESS",
      "FALSE_COMPLETION",
      "COMPLETION_UNVERIFIABLE",
      "LOOP_DETECTED",
      "EXECUTION_FAILURE",
      "TIMEOUT",
      "BLOCKED",
    ];

    expect(TRIAL_FINAL_OUTCOMES).toEqual(expectedOutcomes);

    for (const outcome of expectedOutcomes) {
      expect(isValidTrialFinalOutcome(outcome)).toBe(true);
      expect(TrialFinalOutcomeSchema.parse(outcome)).toBe(outcome);
    }

    // Invalid outcomes must be rejected
    expect(isValidTrialFinalOutcome("PASSED")).toBe(false);
    expect(isValidTrialFinalOutcome("FAILED")).toBe(false);
    expect(isValidTrialFinalOutcome("UNKNOWN_OUTCOME")).toBe(false);
    expect(isValidTrialFinalOutcome(null)).toBe(false);
    expect(isValidTrialFinalOutcome(undefined)).toBe(false);
  });

  // =========================================================================
  // 2. Model Completion Claim Coexistence
  // =========================================================================
  it("Scenario 2: A model completion claim can coexist with any applicable final outcome", () => {
    const claim: ModelCompletionClaimObservation = {
      claimed: true,
      stepNumber: 4,
      finishReason: "GOAL_REACHED",
      rationale: "Task completed per instructions",
      claimedAt: "2026-11-06T10:00:00.000Z",
    };
    expect(ModelCompletionClaimObservationSchema.parse(claim)).toEqual(claim);

    // 2a. Claim + Authoritative Verification -> VERIFIED_SUCCESS
    const verified = classifyTrialOutcome({
      terminalReason: "COMPLETED",
      modelCompletionClaim: claim,
      verificationAssessment: {
        decision: "VERIFIED",
        reasonCode: "AUTHORITATIVE_VERIFIED",
        specCount: 2,
        passedSpecCount: 2,
        failedSpecCount: 0,
      },
      postRunCriteriaPassed: true,
    });
    expect(verified.outcome).toBe("VERIFIED_SUCCESS");
    expect(verified.modelClaimedCompletion).toBe(true);

    // 2b. Claim + Failed Evidence -> FALSE_COMPLETION
    const falseComp = classifyTrialOutcome({
      terminalReason: "COMPLETED",
      modelCompletionClaim: claim,
      verificationAssessment: {
        decision: "REJECTED",
        reasonCode: "SPEC_ASSERTION_FAILED",
        specCount: 2,
        passedSpecCount: 1,
        failedSpecCount: 1,
      },
      postRunCriteriaPassed: false,
    });
    expect(falseComp.outcome).toBe("FALSE_COMPLETION");
    expect(falseComp.modelClaimedCompletion).toBe(true);

    // 2c. Claim + Missing Specs -> COMPLETION_UNVERIFIABLE
    const unverifiable = classifyTrialOutcome({
      terminalReason: "COMPLETION_UNVERIFIABLE",
      modelCompletionClaim: claim,
      verificationAssessment: {
        decision: "UNVERIFIABLE",
        reasonCode: "NO_VERIFICATION_SPECS",
        specCount: 0,
      },
    });
    expect(unverifiable.outcome).toBe("COMPLETION_UNVERIFIABLE");
    expect(unverifiable.modelClaimedCompletion).toBe(true);

    // 2d. Claim + Wall Clock Timeout -> TIMEOUT
    const timeout = classifyTrialOutcome({
      terminalReason: "MAX_WALL_CLOCK",
      modelCompletionClaim: claim,
      verificationAssessment: {
        decision: "NOT_EVALUATED",
      },
    });
    expect(timeout.outcome).toBe("TIMEOUT");
    expect(timeout.modelClaimedCompletion).toBe(true);

    // 2e. Claim + Lease Lost -> BLOCKED
    const blocked = classifyTrialOutcome({
      terminalReason: "LEASE_LOST",
      modelCompletionClaim: claim,
      verificationAssessment: {
        decision: "NOT_EVALUATED",
      },
    });
    expect(blocked.outcome).toBe("BLOCKED");
    expect(blocked.modelClaimedCompletion).toBe(true);

    // 2f. Claim + Multi-step Cycle Loop -> LOOP_DETECTED
    const looped = classifyTrialOutcome({
      terminalReason: "CYCLE_DETECTED",
      modelCompletionClaim: claim,
      verificationAssessment: {
        decision: "NOT_EVALUATED",
      },
    });
    expect(looped.outcome).toBe("LOOP_DETECTED");
    expect(looped.modelClaimedCompletion).toBe(true);
  });

  // =========================================================================
  // 3. Verified Success Requires Authoritative Verification Evidence
  // =========================================================================
  it("Scenario 3: A verified success strictly requires authoritative verification evidence and declared specs", () => {
    const claim: ModelCompletionClaimObservation = {
      claimed: true,
      finishReason: "GOAL_REACHED",
    };

    // Case A: Model claims goal reached, but allowUnverifiedCompletion was used with 0 specs
    const unverifiedAttempt = classifyTrialOutcome({
      terminalReason: "COMPLETED",
      modelCompletionClaim: claim,
      allowUnverifiedCompletion: true,
      verificationAssessment: {
        decision: "VERIFIED",
        specCount: 0,
        reasonCode: "NO_VERIFICATION_SPECS",
      },
      postRunCriteriaPassed: true,
    });
    // Must NOT be classified as VERIFIED_SUCCESS
    expect(unverifiedAttempt.outcome).toBe("COMPLETION_UNVERIFIABLE");
    expect(unverifiedAttempt.outcome).not.toBe("VERIFIED_SUCCESS");

    // Case B: Model claims goal reached and authoritative verification specs pass
    const verifiedAttempt = classifyTrialOutcome({
      terminalReason: "COMPLETED",
      modelCompletionClaim: claim,
      verificationAssessment: {
        decision: "VERIFIED",
        reasonCode: "AUTHORITATIVE_VERIFIED",
        specCount: 3,
        passedSpecCount: 3,
        failedSpecCount: 0,
      },
      postRunCriteriaPassed: true,
    });
    expect(verifiedAttempt.outcome).toBe("VERIFIED_SUCCESS");
    expect(verifiedAttempt.verificationDecision).toBe("VERIFIED");
  });

  // =========================================================================
  // 4. Missing Specs Distinguishable from Failed Criteria
  // =========================================================================
  it("Scenario 4: Missing verification specifications are strictly distinguished from failed criteria", () => {
    const claim: ModelCompletionClaimObservation = {
      claimed: true,
      finishReason: "GOAL_REACHED",
    };

    // Missing specs: runtime cannot establish success -> COMPLETION_UNVERIFIABLE
    const missingSpecs = classifyTrialOutcome({
      terminalReason: "COMPLETION_UNVERIFIABLE",
      modelCompletionClaim: claim,
      verificationAssessment: {
        decision: "UNVERIFIABLE",
        reasonCode: "NO_VERIFICATION_SPECS",
        message: "No verification specifications declared in MissionContract",
      },
    });
    expect(missingSpecs.outcome).toBe("COMPLETION_UNVERIFIABLE");
    expect(missingSpecs.verificationReasonCode).toBe("NO_VERIFICATION_SPECS");

    // Failed criteria: criteria were declared and evaluated, but evidence failed -> FALSE_COMPLETION
    const failedCriteria = classifyTrialOutcome({
      terminalReason: "COMPLETED",
      modelCompletionClaim: claim,
      verificationAssessment: {
        decision: "REJECTED",
        reasonCode: "SPEC_ASSERTION_FAILED",
        specCount: 2,
        passedSpecCount: 1,
        failedSpecCount: 1,
        message: "Test exit code was 1, expected 0",
      },
      postRunCriteriaPassed: false,
    });
    expect(failedCriteria.outcome).toBe("FALSE_COMPLETION");
    expect(failedCriteria.verificationReasonCode).toBe("SPEC_ASSERTION_FAILED");

    // They must not share the same outcome classification
    expect(missingSpecs.outcome).not.toBe(failedCriteria.outcome);
  });

  // =========================================================================
  // 5. Unavailable Verification Distinguishable from Failed Verification
  // =========================================================================
  it("Scenario 5: Unavailable verification is strictly distinguished from failed verification", () => {
    const claim: ModelCompletionClaimObservation = {
      claimed: true,
      finishReason: "GOAL_REACHED",
    };

    // Case A: Clean-room verifier / workspace is unavailable -> COMPLETION_UNVERIFIABLE
    const unavailable = classifyTrialOutcome({
      terminalReason: "COMPLETION_UNVERIFIABLE",
      modelCompletionClaim: claim,
      verificationAssessment: {
        decision: "UNVERIFIABLE",
        reasonCode: "VERIFIER_UNAVAILABLE",
        message: "Independent clean-room verifier could not be dispatched",
      },
    });
    expect(unavailable.outcome).toBe("COMPLETION_UNVERIFIABLE");
    expect(unavailable.verificationReasonCode).toBe("VERIFIER_UNAVAILABLE");

    // Case B: Verifier ran, but candidate patch failed tests -> FALSE_COMPLETION
    const failed = classifyTrialOutcome({
      terminalReason: "COMPLETED",
      modelCompletionClaim: claim,
      verificationAssessment: {
        decision: "REJECTED",
        reasonCode: "SPEC_ASSERTION_FAILED",
        message: "Candidate patch failed clean-room test suite",
      },
    });
    expect(failed.outcome).toBe("FALSE_COMPLETION");
    expect(failed.verificationReasonCode).toBe("SPEC_ASSERTION_FAILED");

    // Proves infrastructure unavailability is never misclassified as a model false completion
    expect(unavailable.outcome).not.toBe(failed.outcome);
  });

  // =========================================================================
  // 6. Loop Detection Remains Distinct from Execution Failure
  // =========================================================================
  it("Scenario 6: Loop detection remains distinct from generic execution failure", () => {
    const noClaim: ModelCompletionClaimObservation = { claimed: false };

    // Multi-step loop stagnation (Milestone 2.24)
    const cycleResult = classifyTrialOutcome({
      terminalReason: "CYCLE_DETECTED",
      terminalMessage: "Repeated ineffective cycle of length 2 (read_file -> search_code) executed 2 times without progress",
      modelCompletionClaim: noClaim,
      verificationAssessment: { decision: "NOT_EVALUATED" },
    });
    expect(cycleResult.outcome).toBe("LOOP_DETECTED");
    expect(cycleResult.reason).toContain("CYCLE_DETECTED");

    // Single-action stagnation (Milestone 3.1A)
    const stagnationResult = classifyTrialOutcome({
      terminalReason: "STAGNATION",
      terminalMessage: "3 consecutive identical successful reads",
      modelCompletionClaim: noClaim,
      verificationAssessment: { decision: "NOT_EVALUATED" },
    });
    expect(stagnationResult.outcome).toBe("LOOP_DETECTED");

    // Action execution / brain failure
    const executionFailure = classifyTrialOutcome({
      terminalReason: "BRAIN_FAILURE",
      terminalMessage: "Model provider connection dropped: HTTP 503",
      modelCompletionClaim: noClaim,
      verificationAssessment: { decision: "NOT_EVALUATED" },
    });
    expect(executionFailure.outcome).toBe("EXECUTION_FAILURE");

    // Max consecutive action failures
    const maxFailures = classifyTrialOutcome({
      terminalReason: "MAX_FAILURES",
      terminalMessage: "3 consecutive tool failures",
      modelCompletionClaim: noClaim,
      verificationAssessment: { decision: "NOT_EVALUATED" },
    });
    expect(maxFailures.outcome).toBe("EXECUTION_FAILURE");

    // Must be distinct
    expect(cycleResult.outcome).not.toBe(executionFailure.outcome);
  });

  // =========================================================================
  // 7. Timeout and Blocked Outcomes Remain Distinguishable
  // =========================================================================
  it("Scenario 7: Timeout and blocked outcomes remain distinguishable based on failure origin", () => {
    const noClaim: ModelCompletionClaimObservation = { claimed: false };

    // Resource budget ceiling: MAX_STEPS -> TIMEOUT
    const stepTimeout = classifyTrialOutcome({
      terminalReason: "MAX_STEPS",
      modelCompletionClaim: noClaim,
      verificationAssessment: { decision: "NOT_EVALUATED" },
    });
    expect(stepTimeout.outcome).toBe("TIMEOUT");

    // Resource budget ceiling: MAX_WALL_CLOCK -> TIMEOUT
    const clockTimeout = classifyTrialOutcome({
      terminalReason: "MAX_WALL_CLOCK",
      modelCompletionClaim: noClaim,
      verificationAssessment: { decision: "NOT_EVALUATED" },
    });
    expect(clockTimeout.outcome).toBe("TIMEOUT");

    // Governance fencing: LEASE_LOST -> BLOCKED
    const leaseLost = classifyTrialOutcome({
      terminalReason: "LEASE_LOST",
      terminalMessage: "Run lease expired or stolen by worker-2",
      modelCompletionClaim: noClaim,
      verificationAssessment: { decision: "NOT_EVALUATED" },
    });
    expect(leaseLost.outcome).toBe("BLOCKED");

    // Governance fencing: CONTRACT_REVOKED -> BLOCKED
    const contractRevoked = classifyTrialOutcome({
      terminalReason: "CONTRACT_REVOKED",
      terminalMessage: "Contract status changed to REVOKED",
      modelCompletionClaim: noClaim,
      verificationAssessment: { decision: "NOT_EVALUATED" },
    });
    expect(contractRevoked.outcome).toBe("BLOCKED");

    // Policy denial: POLICY_DENIED -> BLOCKED
    const policyDenied = classifyTrialOutcome({
      terminalReason: "POLICY_DENIED",
      terminalMessage: "Capability workspace.network not authorized",
      modelCompletionClaim: noClaim,
      verificationAssessment: { decision: "NOT_EVALUATED" },
    });
    expect(policyDenied.outcome).toBe("BLOCKED");

    // Timeouts and Blocks must be separate
    expect(stepTimeout.outcome).not.toBe(leaseLost.outcome);
  });

  // =========================================================================
  // 8. Backward Compatibility with Legacy Phase 9 Types & Metrics
  // =========================================================================
  it("Scenario 8: Preserves complete backward compatibility with legacy Phase 9 evaluation types and metrics", () => {
    // 8a. Legacy EvaluationStatus remains intact
    const legacyStatuses: readonly EvaluationStatus[] = [
      "PASSED",
      "FAILED",
      "ERROR",
      "TIMED_OUT",
      "CANCELLED",
      "BLOCKED",
    ];
    expect(EVALUATION_STATUSES).toEqual(legacyStatuses);
    for (const status of legacyStatuses) {
      expect(isValidEvaluationStatus(status)).toBe(true);
    }

    // 8b. Legacy EvaluationMetrics constructs cleanly
    const legacyMetrics = createEvaluationMetrics({
      steps: 5,
      actions: 4,
      attempts: 4,
      modelCalls: 5,
      toolCalls: 4,
      proposalRejections: 0,
      executionFailures: 0,
      modelFailures: 0,
      wallClockMs: 1250,
    });
    expect(legacyMetrics.steps).toBe(5);
    expect(legacyMetrics.wallClockMs).toBe(1250);

    // 8c. Milestone 2.25 ReliabilityEvaluationMetrics contract
    const reliabilityMetrics: ReliabilityEvaluationMetrics = createReliabilityEvaluationMetrics({
      totalTrials: 10,
      modelCompletionClaims: 8,
      verifiedSuccesses: 5,
      falseCompletions: 2,
      unverifiableCompletions: 1,
      loopDetections: 1,
      executionFailures: 1,
      timeouts: 0,
      blockedTrials: 0,
      verifiedSuccessRate: 0.5,
      falseCompletionRate: 0.25,
      unverifiableCompletionRate: 0.125,
      loopFrequency: 0.1,
      toolEfficiency: 0.85,
      unnecessaryToolCallRate: 0.15,
      meanCompletionLatencyMs: 3200,
      recoveryIntegrityPreserved: true,
    });

    expect(ReliabilityEvaluationMetricsSchema.parse(reliabilityMetrics)).toEqual(reliabilityMetrics);
    expect(reliabilityMetrics.verifiedSuccesses).toBe(5);
    expect(reliabilityMetrics.falseCompletions).toBe(2);
    expect(reliabilityMetrics.recoveryIntegrityPreserved).toBe(true);

    // 8d. Legacy EvaluationTrial creation remains valid without Milestone 2.25 fields
    const configFingerprint = createEvaluationConfigFingerprint({
      modelProvider: "fixture-provider",
      model: "fixture-model",
      taskVersion: 1,
      harnessVersion: "harness-0.1",
    });

    const legacyTrial = createEvaluationTrial({
      trialOrdinal: 1,
      taskId: "test-task",
      taskVersion: 1,
      taskContentHash: "a".repeat(64),
      configFingerprint,
      runtimeRunId: "run-123",
      outcome: "PASSED",
      statusMessage: "Legacy verification passed",
      verificationPassed: true,
      agentClaimedGoal: true,
      metrics: legacyMetrics,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    expect(legacyTrial.outcome).toBe("PASSED");
    expect(legacyTrial.finalOutcome).toBeUndefined();

    // 8e. EvaluationTrial with Milestone 2.25 reliability fields
    const enhancedTrial = createEvaluationTrial({
      trialOrdinal: 2,
      taskId: "test-task",
      taskVersion: 1,
      taskContentHash: "a".repeat(64),
      configFingerprint,
      runtimeRunId: "run-124",
      outcome: "PASSED",
      statusMessage: "All criteria verified",
      verificationPassed: true,
      agentClaimedGoal: true,
      metrics: legacyMetrics,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      finalOutcome: "VERIFIED_SUCCESS",
      completionClaim: { claimed: true, finishReason: "GOAL_REACHED" },
      verificationAssessment: {
        decision: "VERIFIED",
        reasonCode: "AUTHORITATIVE_VERIFIED",
        specCount: 1,
        passedSpecCount: 1,
      },
    });

    expect(enhancedTrial.finalOutcome).toBe("VERIFIED_SUCCESS");
    expect(enhancedTrial.completionClaim?.claimed).toBe(true);
    expect(enhancedTrial.verificationAssessment?.reasonCode).toBe("AUTHORITATIVE_VERIFIED");
  });

  // =========================================================================
  // 9. Explicit Coverage for BLOCKED Under All Fencing and Revocation Precedents
  // =========================================================================
  it("Scenario 9: BLOCKED explicitly captures all lease loss, revocation, policy denial, and cancellation states and takes precedence over completion claims", () => {
    const claimWithGoal: ModelCompletionClaimObservation = {
      claimed: true,
      finishReason: "GOAL_REACHED",
      rationale: "Claiming success before eviction",
    };

    const blockedReasons: readonly [string, string][] = [
      ["LEASE_LOST", "Run lease expired or stolen by another worker"],
      ["CONTRACT_REVOKED", "Contract revoked by operator authority"],
      ["POLICY_DENIED", "Network capability not authorized by policy"],
      ["CANCELLED", "Run cancelled by operator command"],
    ];

    for (const [reason, message] of blockedReasons) {
      const result = classifyTrialOutcome({
        terminalReason: reason,
        terminalMessage: message,
        modelCompletionClaim: claimWithGoal,
        verificationAssessment: {
          decision: "VERIFIED", // Even if verifier ran or criteria were met before revocation
          reasonCode: "AUTHORITATIVE_VERIFIED",
          specCount: 1,
          passedSpecCount: 1,
        },
      });

      expect(result.outcome).toBe("BLOCKED");
      expect(result.reason).toContain(reason);
      expect(result.modelClaimedCompletion).toBe(true);
    }
  });

  // =========================================================================
  // 10. Disambiguation of FALSE_COMPLETION versus EXECUTION_FAILURE
  // =========================================================================
  it("Scenario 10: Disambiguates FALSE_COMPLETION from EXECUTION_FAILURE based on whether model claimed completion vs execution crash", () => {
    // 10a. Model claimed completion + verification evidence failed -> FALSE_COMPLETION
    const falseCompletionResult = classifyTrialOutcome({
      terminalReason: "COMPLETED",
      modelCompletionClaim: {
        claimed: true,
        finishReason: "GOAL_REACHED",
        rationale: "I completed the fix",
      },
      verificationAssessment: {
        decision: "REJECTED",
        reasonCode: "SPEC_ASSERTION_FAILED",
        specCount: 1,
        failedSpecCount: 1,
        message: "File index.html does not contain required title tag",
      },
      postRunCriteriaPassed: false,
    });
    expect(falseCompletionResult.outcome).toBe("FALSE_COMPLETION");
    expect(falseCompletionResult.modelClaimedCompletion).toBe(true);

    // 10b. Model did NOT claim completion + brain / tool failed -> EXECUTION_FAILURE
    const toolCrashResult = classifyTrialOutcome({
      terminalReason: "MAX_FAILURES",
      terminalMessage: "3 consecutive tool execution failures",
      modelCompletionClaim: {
        claimed: false,
      },
      verificationAssessment: {
        decision: "NOT_EVALUATED",
      },
    });
    expect(toolCrashResult.outcome).toBe("EXECUTION_FAILURE");
    expect(toolCrashResult.modelClaimedCompletion).toBe(false);

    // 10c. Model provider threw error before goal reached -> EXECUTION_FAILURE
    const brainCrashResult = classifyTrialOutcome({
      terminalReason: "BRAIN_FAILURE",
      terminalMessage: "Local Ollama process crashed with ECONNREFUSED",
      modelCompletionClaim: {
        claimed: false,
      },
      verificationAssessment: {
        decision: "NOT_EVALUATED",
      },
    });
    expect(brainCrashResult.outcome).toBe("EXECUTION_FAILURE");
    expect(brainCrashResult.modelClaimedCompletion).toBe(false);

    // 10d. Model claimed completion but brain failed before clean verification completion
    const claimedThenBrainFailed = classifyTrialOutcome({
      terminalReason: "BRAIN_FAILURE",
      terminalMessage: "Connection dropped during terminal formatting",
      modelCompletionClaim: {
        claimed: true,
        finishReason: "GOAL_REACHED",
      },
      verificationAssessment: {
        decision: "NOT_EVALUATED",
      },
    });
    // Brain failure takes precedence over claimed completion
    expect(claimedThenBrainFailed.outcome).toBe("EXECUTION_FAILURE");
    expect(claimedThenBrainFailed.modelClaimedCompletion).toBe(true);

    // 10e. Fallthrough: step loop ended without goal reached and without verification pass -> EXECUTION_FAILURE
    const fallthroughResult = classifyTrialOutcome({
      terminalReason: "STOPPED",
      terminalMessage: "Agent stopped without claiming completion",
      modelCompletionClaim: {
        claimed: false,
      },
      verificationAssessment: {
        decision: "NOT_EVALUATED",
      },
    });
    expect(fallthroughResult.outcome).toBe("EXECUTION_FAILURE");
  });

  // =========================================================================
  // 11. Full Classification Precedence Hierarchy
  // =========================================================================
  it("Scenario 11: Enforces strict classification precedence: BLOCKED > TIMEOUT > LOOP_DETECTED > EXECUTION_FAILURE > Completion Verification", () => {
    const claim: ModelCompletionClaimObservation = {
      claimed: true,
      finishReason: "GOAL_REACHED",
    };
    const assessmentPass = {
      decision: "VERIFIED" as const,
      reasonCode: "AUTHORITATIVE_VERIFIED" as const,
      specCount: 2,
      passedSpecCount: 2,
    };

    // Precedence 1: BLOCKED overrides everything
    expect(classifyTrialOutcome({
      terminalReason: "LEASE_LOST",
      modelCompletionClaim: claim,
      verificationAssessment: assessmentPass,
    }).outcome).toBe("BLOCKED");

    // Precedence 2: TIMEOUT overrides LOOP_DETECTED, EXECUTION_FAILURE, and completion
    expect(classifyTrialOutcome({
      terminalReason: "MAX_WALL_CLOCK",
      modelCompletionClaim: claim,
      verificationAssessment: assessmentPass,
    }).outcome).toBe("TIMEOUT");

    // Precedence 3: LOOP_DETECTED overrides EXECUTION_FAILURE and completion claims
    expect(classifyTrialOutcome({
      terminalReason: "CYCLE_DETECTED",
      modelCompletionClaim: claim,
      verificationAssessment: assessmentPass,
    }).outcome).toBe("LOOP_DETECTED");

    // Precedence 4: EXECUTION_FAILURE overrides completion claims
    expect(classifyTrialOutcome({
      terminalReason: "BRAIN_FAILURE",
      modelCompletionClaim: claim,
      verificationAssessment: assessmentPass,
    }).outcome).toBe("EXECUTION_FAILURE");

    // Precedence 5: When no failure/blocking occurred and completion was claimed:
    // 5a: With missing specs -> COMPLETION_UNVERIFIABLE
    expect(classifyTrialOutcome({
      terminalReason: "COMPLETED",
      modelCompletionClaim: claim,
      verificationAssessment: { decision: "UNVERIFIABLE", reasonCode: "NO_VERIFICATION_SPECS" },
    }).outcome).toBe("COMPLETION_UNVERIFIABLE");

    // 5b: With authoritative verification passed -> VERIFIED_SUCCESS
    expect(classifyTrialOutcome({
      terminalReason: "COMPLETED",
      modelCompletionClaim: claim,
      verificationAssessment: assessmentPass,
    }).outcome).toBe("VERIFIED_SUCCESS");

    // 5c: With failed verification -> FALSE_COMPLETION
    expect(classifyTrialOutcome({
      terminalReason: "COMPLETED",
      modelCompletionClaim: claim,
      verificationAssessment: { decision: "REJECTED", reasonCode: "SPEC_ASSERTION_FAILED" },
    }).outcome).toBe("FALSE_COMPLETION");
  });
});
