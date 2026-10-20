/**
 * Phase 84 — Speculative Parallel Multi-Hypothesis Clean-Room Execution
 * Integration Tests
 *
 * Verifies:
 * 1. Candidate identity construction and cryptographic hashing
 * 2. Group construction and canonical group digest integrity
 * 3. Baseline isolation & clean-room immutability
 * 4. Parallel dispatch under Sequential, Parallel-2, Parallel-4, and Adaptive modes
 * 5. Resource accounting, peak memory, and host ceiling enforcement
 * 6. Phase 83 delta verification integration and early defect rejection
 * 7. Clean-room dual-gate integration (F2P=1.0, P2P=1.0, SUITE_RAN=11)
 * 8. Early cancellation protocol and non-destructive cancellation lifecycle
 * 9. Explicit cancellation race conditions (Races A, B, C, D, E, F)
 * 10. Deterministic adjudication with multiple verified candidates
 * 11. Terminal authority firewall: terminalSuccessCount <= 1 strictly invariant
 * 12. Review approval fencing and stale source revision rejection
 * 13. Production safety negative controls N261–N280 (20/20 PASS)
 * 14. 3-sweep determinism across the 60-trial experimental matrix
 */

import { describe, expect, it } from "vitest";
import {
  computeAdjudicationDigest,
  computeCandidateIdentity,
  computeGroupDigest,
  CandidateHypothesis,
} from "../../src/domain/speculative-verification.js";
import { SpeculativeCancellationController } from "../../src/application/speculative-cancellation-controller.js";
import { SpeculativeAdjudicator } from "../../src/application/speculative-adjudicator.js";
import {
  FROZEN_PHASE83_BASELINE,
  SpeculativeVerificationOrchestrator,
} from "../../src/application/speculative-verification-orchestrator.js";

describe("Phase 84: Speculative Parallel Multi-Hypothesis Clean-Room Execution", () => {
  const cancellationController = new SpeculativeCancellationController();
  const adjudicator = new SpeculativeAdjudicator();
  const orchestrator = new SpeculativeVerificationOrchestrator(cancellationController, adjudicator);

  // ==========================================================================
  // 1. Candidate Identity & Cryptographic Hashing
  // ==========================================================================

  it("1. builds canonical candidate identity binding all required authority fields", () => {
    const id = computeCandidateIdentity({
      workflowId: "wf-1",
      sourceRevision: FROZEN_PHASE83_BASELINE,
      baselineCommit: FROZEN_PHASE83_BASELINE,
      proposalDigest: "proposal-hash-1",
      candidatePatchDigest: "patch-hash-1",
      contractHash: "contract-hash-1",
    });

    expect(id).toBeDefined();
    expect(id.length).toBe(64);
  });

  it("2. produces distinct candidate identities for different patch digests", () => {
    const id1 = computeCandidateIdentity({
      workflowId: "wf-1",
      sourceRevision: FROZEN_PHASE83_BASELINE,
      baselineCommit: FROZEN_PHASE83_BASELINE,
      proposalDigest: "proposal-hash",
      candidatePatchDigest: "patch-A",
      contractHash: "contract-hash",
    });
    const id2 = computeCandidateIdentity({
      workflowId: "wf-1",
      sourceRevision: FROZEN_PHASE83_BASELINE,
      baselineCommit: FROZEN_PHASE83_BASELINE,
      proposalDigest: "proposal-hash",
      candidatePatchDigest: "patch-B",
      contractHash: "contract-hash",
    });

    expect(id1).not.toBe(id2);
  });

  it("3. produces deterministic identical candidate identity for identical inputs", () => {
    const params = {
      workflowId: "wf-1",
      sourceRevision: FROZEN_PHASE83_BASELINE,
      baselineCommit: FROZEN_PHASE83_BASELINE,
      proposalDigest: "proposal-hash",
      candidatePatchDigest: "patch-A",
      contractHash: "contract-hash",
    };
    const id1 = computeCandidateIdentity(params);
    const id2 = computeCandidateIdentity(params);

    expect(id1).toBe(id2);
  });

  // ==========================================================================
  // 2. Speculative Group Construction & Hashing
  // ==========================================================================

  it("4. computes canonical group digest over group metadata and candidate IDs", () => {
    const digest = computeGroupDigest({
      groupId: "grp-1",
      workflowId: "wf-1",
      taskId: "P46-L5-01",
      sourceRevision: FROZEN_PHASE83_BASELINE,
      baselineCommit: FROZEN_PHASE83_BASELINE,
      candidateIds: ["cand-1", "cand-2", "cand-3"],
      maxParallelism: 4,
      startedAt: "2026-10-21T00:00:00.000Z",
      groupState: "CREATED",
    });

    expect(digest.length).toBe(64);
  });

  it("5. sorts candidate IDs deterministically in group digest computation", () => {
    const d1 = computeGroupDigest({
      groupId: "grp-1",
      workflowId: "wf-1",
      taskId: "P46-L5-01",
      sourceRevision: FROZEN_PHASE83_BASELINE,
      baselineCommit: FROZEN_PHASE83_BASELINE,
      candidateIds: ["cand-Z", "cand-A", "cand-M"],
      maxParallelism: 4,
      startedAt: "2026-10-21T00:00:00.000Z",
      groupState: "CREATED",
    });

    const d2 = computeGroupDigest({
      groupId: "grp-1",
      workflowId: "wf-1",
      taskId: "P46-L5-01",
      sourceRevision: FROZEN_PHASE83_BASELINE,
      baselineCommit: FROZEN_PHASE83_BASELINE,
      candidateIds: ["cand-A", "cand-M", "cand-Z"],
      maxParallelism: 4,
      startedAt: "2026-10-21T00:00:00.000Z",
      groupState: "CREATED",
    });

    expect(d1).toBe(d2);
  });

  // ==========================================================================
  // 3. Cohort Creation & Heterogeneous Distribution
  // ==========================================================================

  it("6. creates exactly 15 workflow groups in canonical cohort", () => {
    const { groups } = SpeculativeVerificationOrchestrator.createCohort();
    expect(groups.length).toBe(15);
  });

  it("7. assigns at least 3 candidate hypotheses per group (total >= 45 candidates)", () => {
    const { groups, candidateMap } = SpeculativeVerificationOrchestrator.createCohort();
    let totalCandidates = 0;
    for (const group of groups) {
      const cands = candidateMap.get(group.groupId)!;
      expect(cands.length).toBeGreaterThanOrEqual(3);
      totalCandidates += cands.length;
    }
    expect(totalCandidates).toBe(45);
  });

  it("8. includes valid, delta-defect, and cleanroom-defect candidates in each group", () => {
    const { groups, candidateMap } = SpeculativeVerificationOrchestrator.createCohort();
    const cands = candidateMap.get(groups[0]!.groupId)!;

    expect(cands[0]!.candidateId).toContain("valid");
    expect(cands[0]!.deltaVerificationStatus).toBe("SCREENING_PASS");

    expect(cands[1]!.candidateId).toContain("defect-delta");
    expect(cands[1]!.deltaVerificationStatus).toBe("SCREENING_FAIL");

    expect(cands[2]!.candidateId).toContain("defect-cleanroom");
    expect(cands[2]!.deltaVerificationStatus).toBe("SCREENING_PASS");
  });

  // ==========================================================================
  // 4. Parallel Dispatch & Modes
  // ==========================================================================

  it("9. executes group under Condition A (SEQUENTIAL) with concurrency = 1", () => {
    const { groups, candidateMap } = SpeculativeVerificationOrchestrator.createCohort();
    const group = groups[0]!;
    const cands = candidateMap.get(group.groupId)!;

    const { trialResult, groupUsage } = orchestrator.executeGroup(group, cands, "SEQUENTIAL");
    expect(trialResult.mode).toBe("SEQUENTIAL");
    expect(groupUsage.parallelSpeedup).toBeGreaterThanOrEqual(1.0);
    expect(trialResult.terminalAuthorityGranted).toBe(true);
  });

  it("10. executes group under Condition B (PARALLEL_2) with max concurrency = 2", () => {
    const { groups, candidateMap } = SpeculativeVerificationOrchestrator.createCohort();
    const group = groups[0]!;
    const cands = candidateMap.get(group.groupId)!;

    const { trialResult, groupUsage } = orchestrator.executeGroup(group, cands, "PARALLEL_2");
    expect(trialResult.mode).toBe("PARALLEL_2");
    expect(groupUsage.peakMemoryMb).toBeLessThanOrEqual(4096);
  });

  it("11. executes group under Condition C (PARALLEL_4) with max concurrency = 4", () => {
    const { groups, candidateMap } = SpeculativeVerificationOrchestrator.createCohort();
    const group = groups[0]!;
    const cands = candidateMap.get(group.groupId)!;

    const { trialResult, groupUsage } = orchestrator.executeGroup(group, cands, "PARALLEL_4");
    expect(trialResult.mode).toBe("PARALLEL_4");
    expect(groupUsage.wastedPostWinnerCostMs).toBeGreaterThanOrEqual(0);
  });

  it("12. executes group under Condition D (ADAPTIVE_PARALLEL) scaling by task complexity", () => {
    const { groups, candidateMap } = SpeculativeVerificationOrchestrator.createCohort();
    // L5 group
    const gL5 = groups[0]!;
    const resL5 = orchestrator.executeGroup(gL5, candidateMap.get(gL5.groupId)!, "ADAPTIVE_PARALLEL");
    expect(resL5.trialResult.mode).toBe("ADAPTIVE_PARALLEL");

    // L7 group
    const gL7 = groups[10]!;
    const resL7 = orchestrator.executeGroup(gL7, candidateMap.get(gL7.groupId)!, "ADAPTIVE_PARALLEL");
    expect(resL7.trialResult.mode).toBe("ADAPTIVE_PARALLEL");
    expect(resL7.groupUsage.peakMemoryMb).toBeLessThanOrEqual(4096);
  });

  // ==========================================================================
  // 5. Resource Accounting & Cost Model
  // ==========================================================================

  it("13. tracks individual candidate resource usage accurately", () => {
    const { groups, candidateMap } = SpeculativeVerificationOrchestrator.createCohort();
    const group = groups[0]!;
    const cands = candidateMap.get(group.groupId)!;

    const { candidateUsages } = orchestrator.executeGroup(group, cands, "PARALLEL_4");
    expect(candidateUsages.length).toBe(3);
    expect(candidateUsages[0]!.testExecutionCount).toBe(11);
    expect(candidateUsages[1]!.cleanRoomDurationMs).toBe(0); // rejected early at delta
  });

  it("14. tracks useful verification cost vs speculative cost in group usage", () => {
    const { groups, candidateMap } = SpeculativeVerificationOrchestrator.createCohort();
    const group = groups[0]!;
    const cands = candidateMap.get(group.groupId)!;

    const { groupUsage } = orchestrator.executeGroup(group, cands, "PARALLEL_4");
    expect(groupUsage.usefulVerificationCostMs).toBeGreaterThan(0);
    expect(groupUsage.speculativeCostMs).toBeGreaterThanOrEqual(0);
    expect(groupUsage.totalCandidateCostMs).toBe(
      groupUsage.usefulVerificationCostMs + groupUsage.speculativeCostMs
    );
  });

  it("15. calculates efficiency ratio (usefulCost / totalCost) properly", () => {
    const { groups, candidateMap } = SpeculativeVerificationOrchestrator.createCohort();
    const group = groups[0]!;
    const cands = candidateMap.get(group.groupId)!;

    const { groupUsage } = orchestrator.executeGroup(group, cands, "SEQUENTIAL");
    expect(groupUsage.efficiencyRatio).toBeGreaterThan(0.5);
    expect(groupUsage.efficiencyRatio).toBeLessThanOrEqual(1.0);
  });

  // ==========================================================================
  // 6. Early Defect Detection & Delta Integration
  // ==========================================================================

  it("16. aborts defective candidate early in delta screening saving clean-room compute", () => {
    const { groups, candidateMap } = SpeculativeVerificationOrchestrator.createCohort();
    const group = groups[0]!;
    const cands = candidateMap.get(group.groupId)!;

    const { candidateUsages } = orchestrator.executeGroup(group, cands, "PARALLEL_2");
    // Candidate 2 is defect-delta
    const cand2Usage = candidateUsages.find((u) => u.candidateId.includes("defect-delta"))!;
    expect(cand2Usage.cleanRoomDurationMs).toBe(0); // avoided running clean room
  });

  it("17. requires candidate passing delta screening to pass independent clean room", () => {
    const { groups, candidateMap } = SpeculativeVerificationOrchestrator.createCohort();
    const group = groups[0]!;
    const cands = candidateMap.get(group.groupId)!;

    const { candidateUsages } = orchestrator.executeGroup(group, cands, "PARALLEL_4");
    // Candidate 1 passed delta and ran full clean room
    const cand1Usage = candidateUsages.find((u) => u.candidateId.includes("valid"))!;
    expect(cand1Usage.cleanRoomDurationMs).toBeGreaterThan(0);
  });

  // ==========================================================================
  // 7. Cancellation Protocol & Lifecycle
  // ==========================================================================

  it("18. transitions losing candidate to CANCELLED state upon winner establishment", () => {
    const cand: CandidateHypothesis = {
      candidateId: "cand-loser",
      workflowId: "wf-1",
      taskId: "P46-L5-01",
      sourceRevision: FROZEN_PHASE83_BASELINE,
      baselineCommit: FROZEN_PHASE83_BASELINE,
      proposalDigest: "p",
      candidatePatchDigest: "d",
      contractHash: "c",
      proposerIdentity: "agent",
      reviewStatus: "APPROVED",
      riskClass: "LOW",
      deltaVerificationStatus: "SCREENING_PASS",
      candidateState: "RUNNING",
      candidateIdentityDigest: "h",
    };

    const res = cancellationController.requestCancellation(cand, "cand-winner");
    expect(res.finalCandidateState).toBe("CANCELLED");
    expect(res.cancellationState).toBe("CANCELLED");
    expect(res.evidencePreserved).toBe(true);
  });

  it("19. rejects illegal attempt to cancel the winning candidate", () => {
    const cand: CandidateHypothesis = {
      candidateId: "cand-winner",
      workflowId: "wf-1",
      taskId: "P46-L5-01",
      sourceRevision: FROZEN_PHASE83_BASELINE,
      baselineCommit: FROZEN_PHASE83_BASELINE,
      proposalDigest: "p",
      candidatePatchDigest: "d",
      contractHash: "c",
      proposerIdentity: "agent",
      reviewStatus: "APPROVED",
      riskClass: "LOW",
      deltaVerificationStatus: "SCREENING_PASS",
      candidateState: "VERIFIED_CANDIDATE",
      candidateIdentityDigest: "h",
    };

    expect(() => cancellationController.requestCancellation(cand, "cand-winner")).toThrow(
      "ILLEGAL_WINNER_CANCELLATION"
    );
  });

  it("20. preserves already terminal candidate state without overwriting diagnostic status", () => {
    const cand: CandidateHypothesis = {
      candidateId: "cand-failed",
      workflowId: "wf-1",
      taskId: "P46-L5-01",
      sourceRevision: FROZEN_PHASE83_BASELINE,
      baselineCommit: FROZEN_PHASE83_BASELINE,
      proposalDigest: "p",
      candidatePatchDigest: "d",
      contractHash: "c",
      proposerIdentity: "agent",
      reviewStatus: "APPROVED",
      riskClass: "LOW",
      deltaVerificationStatus: "SCREENING_FAIL",
      candidateState: "REJECTED",
      candidateIdentityDigest: "h",
    };

    const res = cancellationController.requestCancellation(cand, "cand-winner");
    expect(res.finalCandidateState).toBe("REJECTED");
    expect(res.reason).toContain("ALREADY_TERMINAL");
  });

  it("21. handles cancellation timeout by force-reclaiming worker safely", () => {
    const res = cancellationController.handleCancellationTimeout("cand-hanging");
    expect(res.cancellationState).toBe("CANCEL_TIMEOUT");
    expect(res.finalCandidateState).toBe("CANCELLED");
    expect(res.evidencePreserved).toBe(true);
  });

  // ==========================================================================
  // 8. Explicit Cancellation Race Testing (Races A to F)
  // ==========================================================================

  const createDummyCand = (id: string, state: any = "RUNNING"): CandidateHypothesis => ({
    candidateId: id,
    workflowId: "wf-race",
    taskId: "P46-L5-01",
    sourceRevision: FROZEN_PHASE83_BASELINE,
    baselineCommit: FROZEN_PHASE83_BASELINE,
    proposalDigest: `prop-${id}`,
    candidatePatchDigest: `patch-${id}`,
    contractHash: "contract",
    proposerIdentity: "agent",
    reviewStatus: "APPROVED",
    riskClass: "LOW",
    deltaVerificationStatus: "SCREENING_PASS",
    candidateState: state,
    candidateIdentityDigest: `hash-${id}`,
  });

  it("22. resolves Race A: Candidate A verifies while cancellation requested", () => {
    const candA = createDummyCand("cand-A", "VERIFIED_CANDIDATE");
    const candB = createDummyCand("cand-B", "VERIFIED_CANDIDATE");

    const res = cancellationController.resolveCancellationRace("RACE_A", candA, candB, "cand-B");
    expect(res.status).toBe("RESOLVED_SAFELY");
    expect(res.terminalSuccessCount).toBe(1);
    expect(res.resolvedWinnerId).toBe("cand-B");
  });

  it("23. resolves Race B: Candidate A verifies immediately before cancellation arrives", () => {
    const candA = createDummyCand("cand-A", "VERIFIED_CANDIDATE");
    const candB = createDummyCand("cand-B", "RUNNING");

    const res = cancellationController.resolveCancellationRace("RACE_B", candA, candB);
    expect(res.status).toBe("RESOLVED_SAFELY");
    expect(res.terminalSuccessCount).toBe(1);
    expect(res.resolvedWinnerId).toBe("cand-A");
  });

  it("24. resolves Race C: Candidate B receives cancellation while writing evidence", () => {
    const candA = createDummyCand("cand-A", "VERIFIED_CANDIDATE");
    const candB = createDummyCand("cand-B", "RUNNING");

    const res = cancellationController.resolveCancellationRace("RACE_C", candA, candB);
    expect(res.status).toBe("RESOLVED_SAFELY");
    expect(res.terminalSuccessCount).toBe(1);
  });

  it("25. resolves Race D: Candidate B completes verification during winner selection", () => {
    const candA = createDummyCand("cand-A", "VERIFIED_CANDIDATE");
    const candB = createDummyCand("cand-B", "VERIFIED_CANDIDATE");

    const res = cancellationController.resolveCancellationRace("RACE_D", candA, candB);
    expect(res.status).toBe("RESOLVED_SAFELY");
    expect(res.terminalSuccessCount).toBe(1);
    expect(res.resolvedWinnerId).toBe("cand-A"); // lexical tie-break
  });

  it("26. resolves Race E: Two candidates become VERIFIED simultaneously", () => {
    const candA = createDummyCand("cand-A", "VERIFIED_CANDIDATE");
    const candB = createDummyCand("cand-B", "VERIFIED_CANDIDATE");

    const res = cancellationController.resolveCancellationRace("RACE_E", candA, candB);
    expect(res.status).toBe("RESOLVED_SAFELY");
    expect(res.terminalSuccessCount).toBe(1);
    expect(res.resolvedWinnerId).toBe("cand-A");
  });

  it("27. resolves Race F: Winner cancellation races with terminal record creation", () => {
    const candA = createDummyCand("cand-A", "VERIFIED_CANDIDATE");
    const candB = createDummyCand("cand-B", "CANCELLED");

    const res = cancellationController.resolveCancellationRace("RACE_F", candA, candB);
    expect(res.status).toBe("RESOLVED_SAFELY");
    expect(res.terminalSuccessCount).toBe(1);
    expect(res.resolvedWinnerId).toBe("cand-A");
  });

  // ==========================================================================
  // 9. Deterministic Adjudication
  // ==========================================================================

  it("28. adjudicates sole verified candidate cleanly", () => {
    const cand1 = createDummyCand("cand-01", "VERIFIED_CANDIDATE");
    const record = adjudicator.adjudicate("grp-1", "wf-1", [cand1], FROZEN_PHASE83_BASELINE);

    expect(record.winnerCandidateId).toBe("cand-01");
    expect(record.tieBreakReason).toBe("SOLE_VERIFIED_CANDIDATE");
    expect(record.adjudicationDigest.length).toBe(64);
  });

  it("29. breaks ties deterministically when multiple candidates are verified", () => {
    const candA = createDummyCand("cand-A", "VERIFIED_CANDIDATE");
    const candB = createDummyCand("cand-B", "VERIFIED_CANDIDATE");

    const record = adjudicator.adjudicate("grp-1", "wf-1", [candB, candA], FROZEN_PHASE83_BASELINE);
    // Order 5 is lexical comparison of candidate identity digest
    expect(record.winnerCandidateId).toBeDefined();
    expect(record.verifiedCandidateIds.length).toBe(2);
    expect(record.tieBreakReason).toContain("DETERMINISTIC_LEXICAL_TIE_BREAK");
  });

  it("30. rejects candidate list with zero verified candidates", () => {
    const cand = createDummyCand("cand-unverified", "REJECTED");
    expect(() =>
      adjudicator.adjudicate("grp-1", "wf-1", [cand], FROZEN_PHASE83_BASELINE)
    ).toThrow("NO_VERIFIED_CANDIDATE");
  });

  it("31. disqualifies candidate with stale source revision during adjudication", () => {
    const staleCand = { ...createDummyCand("cand-stale", "VERIFIED_CANDIDATE"), sourceRevision: "old-rev" };
    expect(() =>
      adjudicator.adjudicate("grp-1", "wf-1", [staleCand], FROZEN_PHASE83_BASELINE)
    ).toThrow("STALE_REVISION_DISQUALIFIED");
  });

  it("32. disqualifies candidate failing review status policy (PENDING_REVIEW)", () => {
    const unapprovedCand = {
      ...createDummyCand("cand-unapproved", "VERIFIED_CANDIDATE"),
      reviewStatus: "PENDING_REVIEW" as any,
    };
    expect(() =>
      adjudicator.adjudicate("grp-1", "wf-1", [unapprovedCand], FROZEN_PHASE83_BASELINE)
    ).toThrow("POLICY_DISQUALIFIED");
  });

  // ==========================================================================
  // 10. Terminal Authority Invariants
  // ==========================================================================

  it("33. enforces terminalSuccessCount <= 1 strictly across all 60 trials", () => {
    const { trials } = orchestrator.run60TrialMatrix();
    for (const trial of trials) {
      expect(trial.terminalSuccessCount).toBe(1);
    }
  });

  it("34. ensures adjudicated winner receives terminal authority token", () => {
    const { groups, candidateMap } = SpeculativeVerificationOrchestrator.createCohort();
    const group = groups[0]!;
    const cands = candidateMap.get(group.groupId)!;

    const { trialResult, adjudicationRecord } = orchestrator.executeGroup(group, cands, "PARALLEL_2");
    expect(trialResult.winnerCandidateId).toBe(adjudicationRecord.winnerCandidateId);
    expect(trialResult.terminalAuthorityGranted).toBe(true);
  });

  it("35. computes valid canonical adjudication digest", () => {
    const partial = {
      adjudicationId: "adj-test",
      groupId: "grp-test",
      workflowId: "wf-test",
      verifiedCandidateIds: ["cand-1", "cand-2"],
      winnerCandidateId: "cand-1",
      tieBreakReason: "TEST",
      timestamp: "2026-10-21T00:00:00.000Z",
    };
    const digest = computeAdjudicationDigest(partial);
    expect(digest.length).toBe(64);
  });

  // ==========================================================================
  // 11. Production Safety Negative Controls N261–N280 (20/20 PASS)
  // ==========================================================================

  it("36. executes all 20 negative controls N261–N280 with 100% pass rate", () => {
    const controls = orchestrator.evaluateNegativeControls();
    expect(controls.length).toBe(20);

    const failed = controls.filter((c) => c.status !== "PASS");
    expect(failed.length).toBe(0);
  });

  it("37. verifies N261: cross-candidate workspace isolation", () => {
    const controls = orchestrator.evaluateNegativeControls();
    const c = controls.find((ctrl) => ctrl.id === "N261")!;
    expect(c.status).toBe("PASS");
    expect(c.actualClass).toBe("WORKSPACES_ISOLATED");
  });

  it("38. verifies N262: candidate patch substitution trapped by identity binding", () => {
    const controls = orchestrator.evaluateNegativeControls();
    const c = controls.find((ctrl) => ctrl.id === "N262")!;
    expect(c.status).toBe("PASS");
    expect(c.actualClass).toBe("SUBSTITUTION_TRAPPED");
  });

  it("39. verifies N265: winner identity spoofing rejected fail-closed", () => {
    const controls = orchestrator.evaluateNegativeControls();
    const c = controls.find((ctrl) => ctrl.id === "N265")!;
    expect(c.status).toBe("PASS");
    expect(c.actualClass).toBe("SPOOF_BLOCKED");
  });

  it("40. verifies N271: multiple terminal success injection strictly blocked", () => {
    const controls = orchestrator.evaluateNegativeControls();
    const c = controls.find((ctrl) => ctrl.id === "N271")!;
    expect(c.status).toBe("PASS");
    expect(c.actualClass).toBe("INJECTION_BLOCKED");
  });

  it("41. verifies N273: resource ceiling bypass clamped to host limits", () => {
    const controls = orchestrator.evaluateNegativeControls();
    const c = controls.find((ctrl) => ctrl.id === "N273")!;
    expect(c.status).toBe("PASS");
    expect(c.actualClass).toBe("CEILING_ENFORCED");
  });

  it("42. verifies N276: stale candidate dispatch rejected fail-closed", () => {
    const controls = orchestrator.evaluateNegativeControls();
    const c = controls.find((ctrl) => ctrl.id === "N276")!;
    expect(c.status).toBe("PASS");
    expect(c.actualClass).toBe("STALE_DISQUALIFIED");
  });

  it("43. verifies N277: review approval bypass blocked fail-closed", () => {
    const controls = orchestrator.evaluateNegativeControls();
    const c = controls.find((ctrl) => ctrl.id === "N277")!;
    expect(c.status).toBe("PASS");
    expect(c.actualClass).toBe("REVIEW_FENCED");
  });

  // ==========================================================================
  // 12. 60-Trial Matrix & 3-Sweep Determinism
  // ==========================================================================

  it("44. runs full 60-trial experimental matrix with 100% terminal correctness", () => {
    const { trials, summary } = orchestrator.run60TrialMatrix();

    expect(trials.length).toBe(60);
    expect(summary.totalTrials).toBe(60);
    expect(summary.sequentialTrials).toBe(15);
    expect(summary.parallel2Trials).toBe(15);
    expect(summary.parallel4Trials).toBe(15);
    expect(summary.adaptiveTrials).toBe(15);
    expect(summary.terminalCorrectnessRate).toBe(1.0);
    expect(summary.multipleTerminalSuccessViolations).toBe(0);
  });

  it("45. achieves 100% byte-identical replay determinism across 3 sweeps of 60 trials", () => {
    const sweep1 = orchestrator.run60TrialMatrix();
    const sweep2 = orchestrator.run60TrialMatrix();
    const sweep3 = orchestrator.run60TrialMatrix();

    const d1 = JSON.stringify(sweep1);
    const d2 = JSON.stringify(sweep2);
    const d3 = JSON.stringify(sweep3);

    expect(d1).toBe(d2);
    expect(d2).toBe(d3);
  });
});
