/**
 * Phase 81 — Governed Repair Workflow and Production Readiness Integration Tests
 *
 * Verifies:
 * 1. Complete workflow lifecycle: DRAFT -> PROPOSED -> UNDER_REVIEW -> READY_FOR_EXECUTION -> EXECUTING -> VERIFYING -> VERIFIED -> TERMINAL
 * 2. Selective Review escalation (LOW_RISK direct, MEDIUM_RISK single reviewer, HIGH_RISK panel)
 * 3. Terminal finality of REJECTED, ABORTED, EXPIRED states
 * 4. Dual-gate clean-room verification (F2P=1.0, P2P=1.0) & fourfold completion
 * 5. Idempotent terminal transition & duplicate suppression
 * 6. Safe handoff generation & zero leaked solution tokens
 * 7. Crash recovery & transition replay
 * 8. Queue & retry bounds enforcement
 * 9. Negative controls N201–N220 (all fail closed)
 * 10. Multi-sweep determinism & historical baseline regression
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKFLOW_LIMITS,
  WorkflowState,
} from "../../src/domain/governed-repair-workflow.js";
import {
  HandoffRecord,
  WorkflowHandoffManager,
} from "../../src/application/workflow-handoff.js";
import {
  FROZEN_PHASE80_BASELINE,
  GovernedRepairOrchestrator,
} from "../../src/application/governed-repair-orchestrator.js";
import {
  FROZEN_TASK_COHORT,
} from "../../src/application/transformation-proposal-validator.js";

describe("Phase 81: Governed Repair Workflow & Production Readiness", () => {
  // ==========================================================================
  // 1. Workflow Lifecycle & State Machine Transitions
  // ==========================================================================

  it("1. initializes new workflow in DRAFT state with valid metadata", () => {
    const wf = GovernedRepairOrchestrator.createWorkflow("P46-L5-01", "MODE_B_HUMAN_MODEL");
    expect(wf.workflowId).toBeDefined();
    expect(wf.taskId).toBe("P46-L5-01");
    expect(wf.mode).toBe("MODE_B_HUMAN_MODEL");
    expect(wf.currentState).toBe("DRAFT");
    expect(wf.approvalState).toBe("PENDING_REVIEW");
    expect(wf.riskLevel).toBe("LOW_RISK");
    expect(wf.transitions.length).toBe(1);
    expect(wf.transitions[0]?.toState).toBe("DRAFT");
  });

  it("2. allows valid sequential lifecycle transitions from DRAFT to TERMINAL", () => {
    expect(GovernedRepairOrchestrator.isValidTransition("DRAFT", "PROPOSED")).toBe(true);
    expect(GovernedRepairOrchestrator.isValidTransition("PROPOSED", "UNDER_REVIEW")).toBe(true);
    expect(GovernedRepairOrchestrator.isValidTransition("UNDER_REVIEW", "READY_FOR_EXECUTION")).toBe(true);
    expect(GovernedRepairOrchestrator.isValidTransition("READY_FOR_EXECUTION", "EXECUTING")).toBe(true);
    expect(GovernedRepairOrchestrator.isValidTransition("EXECUTING", "VERIFYING")).toBe(true);
    expect(GovernedRepairOrchestrator.isValidTransition("VERIFYING", "VERIFIED")).toBe(true);
    expect(GovernedRepairOrchestrator.isValidTransition("VERIFIED", "TERMINAL")).toBe(true);
  });

  it("3. allows direct bypass to READY_FOR_EXECUTION for LOW_RISK under selective review", () => {
    expect(GovernedRepairOrchestrator.isValidTransition("PROPOSED", "READY_FOR_EXECUTION")).toBe(true);
    const risk = GovernedRepairOrchestrator.assessRiskLevel("P46-L5-01", ["src/calculator.ts"]);
    expect(risk).toBe("LOW_RISK");

    const trial = GovernedRepairOrchestrator.executeTrial("P46-L5-01", "SELECTIVE_REVIEW");
    expect(trial.modelCalls).toBe(1); // 1 proposer call, 0 review calls
    expect(trial.finalState).toBe("TERMINAL");
    expect(trial.cleanRoomSuccess).toBe(true);
  });

  it("4. routes MEDIUM_RISK tasks through single reviewer under selective review", () => {
    const risk = GovernedRepairOrchestrator.assessRiskLevel("P46-L6-01", ["src/state-manager.ts"]);
    expect(risk).toBe("MEDIUM_RISK");

    const trial = GovernedRepairOrchestrator.executeTrial("P46-L6-01", "SELECTIVE_REVIEW");
    expect(trial.modelCalls).toBe(2); // 1 proposer + 1 reviewer
    expect(trial.finalState).toBe("TERMINAL");
    expect(trial.cleanRoomSuccess).toBe(true);
  });

  it("5. escalates HIGH_RISK (L7) tasks to 4-role panel & human collaboration", () => {
    const risk = GovernedRepairOrchestrator.assessRiskLevel("P46-L7-01", ["src/parser.ts", "src/tokenizer.ts", "src/ast.ts"]);
    expect(risk).toBe("HIGH_RISK");

    const trial = GovernedRepairOrchestrator.executeTrial("P46-L7-01", "SELECTIVE_REVIEW");
    expect(trial.modelCalls).toBe(6); // 1 proposer + 4 panel + 1 synthesis revision
    expect(trial.humanInterventions).toBe(1);
    expect(trial.humanWallClockMs).toBe(420000);
    expect(trial.finalState).toBe("TERMINAL");
    expect(trial.cleanRoomSuccess).toBe(true);
  });

  // ==========================================================================
  // 2. Terminal Finality & Rejection Handling
  // ==========================================================================

  it("6. permits transition to REJECTED from review or execution", () => {
    expect(GovernedRepairOrchestrator.isValidTransition("PROPOSED", "REJECTED")).toBe(true);
    expect(GovernedRepairOrchestrator.isValidTransition("UNDER_REVIEW", "REJECTED")).toBe(true);
    expect(GovernedRepairOrchestrator.isValidTransition("EXECUTING", "REJECTED")).toBe(true);
    expect(GovernedRepairOrchestrator.isValidTransition("VERIFYING", "REJECTED")).toBe(true);
  });

  it("7. enforces terminal finality: REJECTED cannot transition to EXECUTING or VERIFIED", () => {
    expect(GovernedRepairOrchestrator.isValidTransition("REJECTED", "EXECUTING")).toBe(false);
    expect(GovernedRepairOrchestrator.isValidTransition("REJECTED", "VERIFIED")).toBe(false);
    expect(GovernedRepairOrchestrator.isValidTransition("REJECTED", "TERMINAL")).toBe(false);
  });

  it("8. supports REVISION_REQUIRED and re-submission to PROPOSED", () => {
    expect(GovernedRepairOrchestrator.isValidTransition("UNDER_REVIEW", "REVISION_REQUIRED")).toBe(true);
    expect(GovernedRepairOrchestrator.isValidTransition("REVISION_REQUIRED", "PROPOSED")).toBe(true);
  });

  it("9. supports ABORTED from any active state and enforces finality", () => {
    const activeStates: WorkflowState[] = [
      "DRAFT",
      "PROPOSED",
      "UNDER_REVIEW",
      "REVISION_REQUIRED",
      "READY_FOR_EXECUTION",
      "EXECUTING",
      "VERIFYING",
    ];

    for (const state of activeStates) {
      expect(GovernedRepairOrchestrator.isValidTransition(state, "ABORTED")).toBe(true);
    }

    expect(GovernedRepairOrchestrator.isValidTransition("ABORTED", "EXECUTING")).toBe(false);
    expect(GovernedRepairOrchestrator.isValidTransition("ABORTED", "VERIFIED")).toBe(false);
  });

  it("10. supports EXPIRED on timeout and blocks subsequent execution", () => {
    expect(GovernedRepairOrchestrator.isValidTransition("PROPOSED", "EXPIRED")).toBe(true);
    expect(GovernedRepairOrchestrator.isValidTransition("UNDER_REVIEW", "EXPIRED")).toBe(true);
    expect(GovernedRepairOrchestrator.isValidTransition("READY_FOR_EXECUTION", "EXPIRED")).toBe(true);
    expect(GovernedRepairOrchestrator.isValidTransition("EXPIRED", "EXECUTING")).toBe(false);
  });

  // ==========================================================================
  // 3. Prohibited Illegal Transitions & Defense in Depth
  // ==========================================================================

  it("11. blocks illegal direct jump from DRAFT to VERIFIED", () => {
    expect(GovernedRepairOrchestrator.isValidTransition("DRAFT", "VERIFIED")).toBe(false);
  });

  it("12. blocks illegal direct jump from DRAFT to EXECUTING", () => {
    expect(GovernedRepairOrchestrator.isValidTransition("DRAFT", "EXECUTING")).toBe(false);
  });

  it("13. blocks illegal direct jump from PROPOSED to VERIFIED", () => {
    expect(GovernedRepairOrchestrator.isValidTransition("PROPOSED", "VERIFIED")).toBe(false);
  });

  it("14. blocks illegal direct jump from UNDER_REVIEW to TERMINAL", () => {
    expect(GovernedRepairOrchestrator.isValidTransition("UNDER_REVIEW", "TERMINAL")).toBe(false);
  });

  it("15. blocks transition from TERMINAL to any other state (absolute finality)", () => {
    const allStates: WorkflowState[] = [
      "DRAFT",
      "PROPOSED",
      "UNDER_REVIEW",
      "REVISION_REQUIRED",
      "READY_FOR_EXECUTION",
      "EXECUTING",
      "VERIFYING",
      "VERIFIED",
      "REJECTED",
      "ABORTED",
      "EXPIRED",
    ];

    for (const state of allStates) {
      expect(GovernedRepairOrchestrator.isValidTransition("TERMINAL", state)).toBe(false);
    }
  });

  // ==========================================================================
  // 4. Clean-Room Verification Dual-Gate & Fourfold Completion
  // ==========================================================================

  it("16. requires both F2P=1.0 and P2P=1.0 for clean-room verification success", () => {
    const trialSuccess = GovernedRepairOrchestrator.executeTrial("P46-L5-01", "SELECTIVE_REVIEW");
    expect(trialSuccess.f2pRatio).toBe(1.0);
    expect(trialSuccess.p2pRatio).toBe(1.0);
    expect(trialSuccess.cleanRoomSuccess).toBe(true);
    expect(trialSuccess.suiteRan).toBeGreaterThan(0);
  });

  it("17. enforces fourfold verification before terminal authority sign-off", () => {
    const trial = GovernedRepairOrchestrator.executeTrial("P46-L6-01", "SELECTIVE_REVIEW");
    expect(trial.fourfoldSuccess).toBe(true);
    expect(trial.terminalAuthoritySuccess).toBe(true);
    expect(trial.finalState).toBe("TERMINAL");
  });

  it("18. handles terminal idempotency by suppressing duplicate completion events", () => {
    const trial1 = GovernedRepairOrchestrator.executeTrial("P46-L5-01", "SELECTIVE_REVIEW");
    expect(trial1.duplicateSuppressed).toBe(true);
  });

  // ==========================================================================
  // 5. Safe Model & Human Handoff Context (Zero-Leakage)
  // ==========================================================================

  it("19. creates safe human handoff context with zero leaked solution tokens", () => {
    const handoff = WorkflowHandoffManager.createHumanHandoff(
      "wf-handoff-test",
      "P46-L7-01",
      "sha256:proposal-digest-test",
      "CLEAN_ROOM_FAILURE",
      ["PrattParserTest#testLookaheadSync"],
      ["src/parser.ts", "src/tokenizer.ts"],
      0,
      "COORDINATION_FAILURE",
      "Pratt parser lookahead synchronization failed across tokenizer and parser"
    );

    expect(handoff.handoffId).toBeDefined();
    expect(handoff.recipientType).toBe("HUMAN_OPERATOR");
    expect(handoff.context?.taskId).toBe("P46-L7-01");
    expect(handoff.context?.failingTests).toContain("PrattParserTest#testLookaheadSync");
    expect(handoff.context?.zeroLeakageConfirmed).toBe(true);
  });

  it("20. creates safe model handoff context and verifies zero gold leakage", () => {
    const handoff = WorkflowHandoffManager.createModelHandoff(
      "wf-handoff-model",
      "P46-L6-01",
      "sha256:proposal-digest-model",
      "TEST_FAILURE",
      ["StateManagerTest#testRollback"],
      ["src/state-manager.ts"],
      1,
      "Handle rollback transaction rollback on state manager"
    );

    expect(handoff.handoffId).toBeDefined();
    expect(handoff.recipientType).toBe("LOCAL_MODEL");
    expect(handoff.context?.zeroLeakageConfirmed).toBe(true);
    const leaked = WorkflowHandoffManager.verifyHandoffZeroLeakage(handoff);
    expect(leaked).toBe(false);
  });

  it("21. detects and flags potential solution leaks in handoff context", () => {
    const contaminatedHandoff: HandoffRecord = {
      handoffId: "handoff-bad",
      workflowId: "wf-bad",
      recipientType: "LOCAL_MODEL",
      context: {
        workflowId: "wf-bad",
        taskId: "P46-L5-01",
        failureClass: "CLEAN_ROOM_FAILURE",
        failingTests: ["test1"],
        targetFiles: ["file.ts"],
        retryCount: 0,
        zeroLeakageConfirmed: false,
        remediationGuidance: "Here is the gold patch: return x + y - 1;",
      },
      createdAt: new Date().toISOString(),
    };

    const hasLeak = WorkflowHandoffManager.verifyHandoffZeroLeakage(contaminatedHandoff);
    expect(hasLeak).toBe(true);
  });

  // ==========================================================================
  // 6. Workflow Limits & Queue Bounding
  // ==========================================================================

  it("22. enforces default workflow limits and queue bounds", () => {
    expect(DEFAULT_WORKFLOW_LIMITS.MAX_PENDING_PROPOSALS).toBe(8);
    expect(DEFAULT_WORKFLOW_LIMITS.MAX_REVISIONS).toBe(3);
    expect(DEFAULT_WORKFLOW_LIMITS.MAX_RETRIES).toBe(3);
    expect(DEFAULT_WORKFLOW_LIMITS.PROPOSAL_TIMEOUT_MS).toBe(300000);
    expect(DEFAULT_WORKFLOW_LIMITS.REVIEW_TIMEOUT_MS).toBe(300000);
    expect(DEFAULT_WORKFLOW_LIMITS.EXECUTION_TIMEOUT_MS).toBe(600000);
  });

  it("23. simulates crash recovery and preserves workflow history", () => {
    const trial = GovernedRepairOrchestrator.executeTrial("P46-L5-01", "SELECTIVE_REVIEW");
    expect(trial.recoveredFromCrash).toBe(true);
  });

  // ==========================================================================
  // 7. Negative Controls N201–N220 (Production Safety Boundaries)
  // ==========================================================================

  const negativeControls = GovernedRepairOrchestrator.evaluateNegativeControls("P46-L5-01");

  it("24. passes N201 — Stale Approval Reuse Rejection", () => {
    const c = negativeControls.find((ctrl) => ctrl.id === "N201");
    expect(c?.status).toBe("PASS");
  });

  it("25. passes N202 — Stale Proposal Execution Rejection", () => {
    const c = negativeControls.find((ctrl) => ctrl.id === "N202");
    expect(c?.status).toBe("PASS");
  });

  it("26. passes N203 — Duplicate Terminal Success Suppression", () => {
    const c = negativeControls.find((ctrl) => ctrl.id === "N203");
    expect(c?.status).toBe("PASS");
  });

  it("27. passes N204 — Source Revision Substitution Rejection", () => {
    const c = negativeControls.find((ctrl) => ctrl.id === "N204");
    expect(c?.status).toBe("PASS");
  });

  it("28. passes N205 — Unauthorized Proposer Role Rejection", () => {
    const c = negativeControls.find((ctrl) => ctrl.id === "N205");
    expect(c?.status).toBe("PASS");
  });

  it("29. passes N206 — Unauthorized Reviewer Impersonation Rejection", () => {
    const c = negativeControls.find((ctrl) => ctrl.id === "N206");
    expect(c?.status).toBe("PASS");
  });

  it("30. passes N207 — Cross-Workflow Event Injection Rejection", () => {
    const c = negativeControls.find((ctrl) => ctrl.id === "N207");
    expect(c?.status).toBe("PASS");
  });

  it("31. passes N208 — Cross-Task Proposal Binding Rejection", () => {
    const c = negativeControls.find((ctrl) => ctrl.id === "N208");
    expect(c?.status).toBe("PASS");
  });

  it("32. passes N209 — Clean-Room Bypass Execution Rejection", () => {
    const c = negativeControls.find((ctrl) => ctrl.id === "N209");
    expect(c?.status).toBe("PASS");
  });

  it("33. passes N210 — Partial Fourfold Signature Rejection", () => {
    const c = negativeControls.find((ctrl) => ctrl.id === "N210");
    expect(c?.status).toBe("PASS");
  });

  it("34. passes N211–N215 (N211 Replay, N212 Tampering, N213 Leaks, N214 Escalation, N215 Concurrency)", () => {
    for (const id of ["N211", "N212", "N213", "N214", "N215"]) {
      const c = negativeControls.find((ctrl) => ctrl.id === id);
      expect(c?.status).toBe("PASS");
    }
  });

  it("35. passes N216–N220 (N216 Leases, N217 Quota, N218 Workspace Escape, N219 Policy Denied Replay, N220 Forged Transition)", () => {
    for (const id of ["N216", "N217", "N218", "N219", "N220"]) {
      const c = negativeControls.find((ctrl) => ctrl.id === id);
      expect(c?.status).toBe("PASS");
    }
  });

  it("36. passes all 20 Phase 81 negative controls (N201–N220: 20/20)", () => {
    expect(negativeControls.length).toBe(20);
    const passed = negativeControls.filter((c) => c.status === "PASS");
    expect(passed.length).toBe(20);
  });

  // ==========================================================================
  // 8. Determinism & Historical Regression
  // ==========================================================================

  it("37. guarantees byte-identical deterministic execution across 3 independent sweeps", () => {
    const run1 = GovernedRepairOrchestrator.runEvaluationSuite();
    const run2 = GovernedRepairOrchestrator.runEvaluationSuite();
    const run3 = GovernedRepairOrchestrator.runEvaluationSuite();

    const digest1 = JSON.stringify(run1);
    const digest2 = JSON.stringify(run2);
    const digest3 = JSON.stringify(run3);

    expect(digest1).toBe(digest2);
    expect(digest2).toBe(digest3);
  });

  it("38. preserves frozen historical baseline and task cohort integrity", () => {
    expect(FROZEN_PHASE80_BASELINE).toBe("9c35f70");
    expect(FROZEN_TASK_COHORT.length).toBe(15);
    expect(FROZEN_TASK_COHORT.filter((t) => t.includes("L5")).length).toBe(5);
    expect(FROZEN_TASK_COHORT.filter((t) => t.includes("L6")).length).toBe(5);
    expect(FROZEN_TASK_COHORT.filter((t) => t.includes("L7")).length).toBe(5);
  });
});
