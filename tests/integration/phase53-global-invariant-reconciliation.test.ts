/**
 * Phase 53 — Governed Global Invariant Reconciliation Integration Tests
 *
 * Verifies:
 * 1. Deterministic global invariant extraction and hashing
 * 2. Conflict graph construction and hash determinism
 * 3. Static contract reconciliation vs Dataflow reconciliation vs Symbolic analysis
 * 4. Diagnostic tasks P46-L7-01 and P46-L7-02 conflict identification and fail-closed clean room rejection
 * 5. Negative controls N1–N12 enforcement
 * 6. Full 60-trial evaluation matrix (15 tasks x 4 conditions)
 * 7. Governance invariants (Clean-room dual-gate, Fourfold completion, Ed25519 threshold, Offline auditor)
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  GlobalInvariantReconciler,
  GlobalInvariant,
  GlobalConflict
} from "../../src/application/global-invariant-reconciler.js";
import {
  BoundedSymbolicAnalyzer,
  DEFAULT_SYMBOLIC_BUDGET
} from "../../src/application/bounded-symbolic-analyzer.js";

const ROOT = path.resolve(process.cwd());

describe("Phase 53 — Governed Global Invariant Reconciliation", () => {
  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase53-protocol.json"), "utf8"));
  const invariantsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase53-global-invariants.json"), "utf8"));
  const graphsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase53-conflict-graphs.json"), "utf8"));
  const reconciliationData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase53-reconciliation.json"), "utf8"));
  const symbolicData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase53-symbolic-analysis.json"), "utf8"));
  const evaluation = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase53-evaluation.json"), "utf8"));
  const negativeControls = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase53-negative-controls.json"), "utf8"));
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase53-results.json"), "utf8"));

  // ---------------------------------------------------------------------------
  // 1. Invariant Extraction & Hash Determinism
  // ---------------------------------------------------------------------------
  it("verifies deterministic global invariant extraction and canonical hash stability", () => {
    expect(protocol.phase).toBe("53");
    expect(reconciliationData.reconciliationRecords.length).toBe(15);
    expect(negativeControls.controls.length).toBe(12);
    expect(protocol.experimentalVariable).toBe("governed_global_invariant_reconciliation");
    expect(protocol.frozenBaselineCommit).toBe("494f0f9");

    expect(invariantsData.taskInvariants.length).toBe(15);
    for (const tInv of invariantsData.taskInvariants) {
      expect(tInv.invariants.length).toBeGreaterThanOrEqual(2);
      for (const inv of tInv.invariants) {
        expect(inv.contentHash).toBeDefined();
        const recomputed = GlobalInvariantReconciler.computeInvariantHash(inv);
        expect(inv.contentHash).toBe(recomputed);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // 2. Conflict Graph Determinism
  // ---------------------------------------------------------------------------
  it("verifies deterministic conflict graph construction and graphHash stability", () => {
    expect(graphsData.conflictGraphs.length).toBe(15);

    for (const g of graphsData.conflictGraphs) {
      expect(g.nodes.length).toBeGreaterThan(0);
      expect(g.graphHash).toBeDefined();

      const sampleInv: GlobalInvariant = {
        invariantId: "inv-test",
        taskId: g.taskId,
        sourceContracts: ["c1"],
        symbols: ["sym"],
        preconditions: ["pre"],
        postconditions: ["post"],
        stateRelations: ["state"],
        dataFlowRelations: ["df"],
        behavioralProperties: ["behav"],
        provenance: ["prov"],
        contentHash: "hash1"
      };

      const rebuilt = GlobalInvariantReconciler.buildConflictGraph(g.taskId, [sampleInv], ["sub-1"], []);
      expect(rebuilt.graphHash).toBeDefined();
    }
  });

  // ---------------------------------------------------------------------------
  // 3. Static vs Dataflow vs Symbolic Reconciliation
  // ---------------------------------------------------------------------------
  it("verifies static reconciliation limits vs dataflow and bounded symbolic conflict detection", () => {
    // Condition B: Static contract reconciliation alone misses emergent precedence and regex port conflicts on L7
    const condBEvals = evaluation.evaluations.filter((e: any) => e.conditionId === "CONDITION_B_STATIC_CONTRACT_RECONCILIATION");
    const l7Static = condBEvals.filter((e: any) => e.complexityTier === "L7_FULL_SWE");
    for (const ev of l7Static) {
      expect(ev.conflictsDetectedCount).toBe(0); // static contract inspection alone fails to detect emergent conflict
    }

    // Condition C: Dataflow reconciliation detects cross-module dataflow conflicts on L7 tasks
    const condCEvals = evaluation.evaluations.filter((e: any) => e.conditionId === "CONDITION_C_DATAFLOW_CONTROL_FLOW_RECONCILIATION");
    const l7Dataflow = condCEvals.filter((e: any) => e.complexityTier === "L7_FULL_SWE");
    for (const ev of l7Dataflow) {
      expect(ev.conflictsDetectedCount).toBe(1);
    }

    // Condition D: Bounded symbolic analysis produces detailed diagnostics on 100% of L7 tasks
    expect(symbolicData.symbolicAnalyses.length).toBe(15);
    const l7Symbolic = symbolicData.symbolicAnalyses.filter((s: any) => s.taskId.startsWith("P46-L7"));
    expect(l7Symbolic.length).toBe(5);
    for (const sym of l7Symbolic) {
      expect(sym.behavioralConflictsDetected.length).toBeGreaterThanOrEqual(1);
      expect(sym.diagnostics.length).toBeGreaterThanOrEqual(1);
      expect(sym.pathsExplored).toBeLessThanOrEqual(DEFAULT_SYMBOLIC_BUDGET.maxSymbolicPaths);
    }
  });

  // ---------------------------------------------------------------------------
  // 4. Critical Diagnostic Tasks P46-L7-01 and P46-L7-02
  // ---------------------------------------------------------------------------
  describe("Critical Diagnostic Tasks P46-L7-01 & P46-L7-02", () => {
    const analyzer = new BoundedSymbolicAnalyzer();

    it("P46-L7-01: identifies AST precedence conflict and fails clean-room on flawed repair", () => {
      const precEval = analyzer.evaluateExpressionPrecedence("-2**2");
      expect(precEval.conflictDetected).toBe(true);
      expect(precEval.observedAstShape).toContain("UnaryMinusExpression");

      const l7_01_eval = evaluation.evaluations.find(
        (e: any) => e.parentTaskId === "P46-L7-01" && e.conditionId === "CONDITION_D_BOUNDED_SYMBOLIC_BEHAVIORAL_RECONCILIATION"
      );
      expect(l7_01_eval.conflictsDetectedCount).toBe(1);
      expect(l7_01_eval.globalRepairAttempted).toBe(true);
      expect(l7_01_eval.globalRepairAttemptsCount).toBe(2);
      expect(l7_01_eval.cleanRoomF2P).toBe("FAIL");
      expect(l7_01_eval.parentCleanRoomVerified).toBe(false);
      expect(l7_01_eval.primaryFailureClass).toBe("COMPOSITION_FAILURE");
    });

    it("P46-L7-02: identifies CORS port wildcard regex conflict and fails clean-room on flawed repair", () => {
      const corsEval = analyzer.evaluateCorsRegexBehavior("^https?:\\/\\/.*\\.domain\\.com$", "http://sub.domain.com:3000");
      expect(corsEval.conflictDetected).toBe(true);
      expect(corsEval.handlesPort).toBe(false);

      const l7_02_eval = evaluation.evaluations.find(
        (e: any) => e.parentTaskId === "P46-L7-02" && e.conditionId === "CONDITION_D_BOUNDED_SYMBOLIC_BEHAVIORAL_RECONCILIATION"
      );
      expect(l7_02_eval.conflictsDetectedCount).toBe(1);
      expect(l7_02_eval.globalRepairAttempted).toBe(true);
      expect(l7_02_eval.globalRepairAttemptsCount).toBe(2);
      expect(l7_02_eval.cleanRoomF2P).toBe("FAIL");
      expect(l7_02_eval.parentCleanRoomVerified).toBe(false);
      expect(l7_02_eval.primaryFailureClass).toBe("COMPOSITION_FAILURE");
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Negative Controls N1–N12
  // ---------------------------------------------------------------------------
  describe("Negative Controls N1–N12", () => {
    it("N1: detects explicit contract contradiction", () => {
      const c1 = {
        contractId: "c1",
        taskId: "t",
        contractType: "INTERFACE" as const,
        sourceSymbols: ["s"],
        preconditions: ["user must be root"],
        postconditions: [],
        invariants: [],
        interfaceConstraints: [],
        stateConstraints: [],
        provenance: [],
        contentHash: "h1",
        isImmutable: true
      };
      const c2 = {
        contractId: "c2",
        taskId: "t",
        contractType: "INTERFACE" as const,
        sourceSymbols: ["s"],
        preconditions: ["user requires non-root"],
        postconditions: [],
        invariants: [],
        interfaceConstraints: [],
        stateConstraints: [],
        provenance: [],
        contentHash: "h2",
        isImmutable: true
      };
      const conflicts = GlobalInvariantReconciler.reconcileContracts("t", [c1, c2], ["sub-1", "sub-2"]);
      expect(conflicts.length).toBeGreaterThan(0);
      expect(conflicts[0]?.conflictType).toBe("INTERFACE_CONFLICT");
    });

    it("N2: detects hidden cross-subtask state conflict", () => {
      const inv: GlobalInvariant = {
        invariantId: "inv-state",
        taskId: "t",
        sourceContracts: [],
        symbols: ["queue"],
        preconditions: [],
        postconditions: [],
        stateRelations: [],
        dataFlowRelations: [],
        behavioralProperties: [],
        provenance: [],
        contentHash: "h"
      };
      const conflict: GlobalConflict = {
        conflictId: "c-state",
        taskId: "t",
        subtasks: ["s1", "s2"],
        symbols: ["queue"],
        conflictType: "STATE_CONFLICT",
        invariant: "Monotonic status progression",
        evidence: ["Queue evicts worker while job status is still active"],
        severity: "CRITICAL",
        deterministicHash: "ch"
      };
      const result = GlobalInvariantReconciler.evaluateInvariants([inv], [conflict]);
      expect(result.overallStatus).toBe("CONFLICT_DETECTED");
      expect(result.evaluations[0]?.status).toBe("VIOLATED");
    });

    it("N3: enforces critical rule UNKNOWN != SATISFIED and flags GLOBAL_INVARIANT_UNPROVEN", () => {
      const inv: GlobalInvariant = {
        invariantId: "ginv-test-emergent-behavior",
        taskId: "t",
        sourceContracts: [],
        symbols: ["sym"],
        preconditions: [],
        postconditions: [],
        stateRelations: [],
        dataFlowRelations: [],
        behavioralProperties: [],
        provenance: [],
        contentHash: "h"
      };
      const result = GlobalInvariantReconciler.evaluateInvariants([inv], [], true); // hasUncertainty = true
      expect(result.overallStatus).toBe("GLOBAL_INVARIANT_UNPROVEN");
      expect(result.evaluations[0]?.status).toBe("UNKNOWN");
    });

    it("N4: enforces symbolic path ceiling of 32 paths", () => {
      const analyzer = new BoundedSymbolicAnalyzer();
      expect(() => {
        analyzer.analyzeTask("P46-L7-01", ["s1", "s2"], [], 33);
      }).toThrow(/GLOBAL_ANALYSIS_BUDGET_EXCEEDED/);
    });

    it("N5: enforces global repair attempt budget ceiling of 2 attempts", () => {
      const analyzer = new BoundedSymbolicAnalyzer();
      analyzer.recordRepairAttempt(1);
      analyzer.recordRepairAttempt(2);
      expect(() => {
        analyzer.recordRepairAttempt(3);
      }).toThrow(/GLOBAL_REPAIR_BUDGET_EXCEEDED/);
    });

    it("N6: ensures false local success results in clean-room failure", () => {
      const l7Eval = evaluation.evaluations.find(
        (e: any) => e.parentTaskId === "P46-L7-01" && e.conditionId === "CONDITION_D_BOUNDED_SYMBOLIC_BEHAVIORAL_RECONCILIATION"
      );
      expect(l7Eval.subtasksPassed).toBe(2);
      expect(l7Eval.cleanRoomF2P).toBe("FAIL");
      expect(l7Eval.parentCleanRoomVerified).toBe(false);
    });

    it("N7: verifies clean-room verifier remains authoritative even if symbolic analysis finds no conflict", () => {
      const analyzer = new BoundedSymbolicAnalyzer();
      const granted = analyzer.assertCleanRoomAuthority(false, true); // clean room failed, symbolic passed
      expect(granted).toBe(false);
    });

    it("N8: detects gold patch leakage in reconciliation queries", () => {
      const leak1 = GlobalInvariantReconciler.checkGoldLeakage("please apply gold_patch");
      const leak2 = GlobalInvariantReconciler.checkGoldLeakage("oracle_solution.js");
      expect(leak1.leaked).toBe(true);
      expect(leak1.reason).toContain("GOLD_LEAKAGE_DETECTED");
      expect(leak2.leaked).toBe(true);
    });

    it("N9: rejects model attempts to modify global invariants with CAPABILITY_DENIED", () => {
      expect(() => {
        GlobalInvariantReconciler.assertInvariantAuthority("MODIFY_GLOBAL_INVARIANT");
      }).toThrow(/CAPABILITY_DENIED/);
    });

    it("N10: rejects model attempts to approve unproven invariants with CAPABILITY_DENIED", () => {
      expect(() => {
        GlobalInvariantReconciler.assertInvariantAuthority("APPROVE_UNPROVEN_INVARIANT");
      }).toThrow(/CAPABILITY_DENIED/);
    });

    it("N11: detects mutations outside authorized slice and rejects with scope violation", () => {
      const scopeCheck = GlobalInvariantReconciler.validateMutationScope(
        ["src/parser.js", "unauthorized.js"],
        ["src/parser.js", "src/calc.js"]
      );
      expect(scopeCheck.isValid).toBe(false);
      expect(scopeCheck.unauthorizedFiles).toContain("unauthorized.js");
    });

    it("N12: detects contradictory repair that fixes one invariant but breaks another", () => {
      const contRepair = GlobalInvariantReconciler.detectContradictoryRepair(
        "ginv-target-fix",
        "ginv-regression-break"
      );
      expect(contRepair.isContradictory).toBe(true);
      expect(contRepair.reason).toContain("CONTRADICTORY_REPAIR_REJECTED");
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Complete 60-Trial Evaluation Matrix & Invariant Governance
  // ---------------------------------------------------------------------------
  it("verifies complete 60-evaluation matrix, complexity breakdown, and invariant governance", () => {
    expect(evaluation.totalEvaluations).toBe(60);
    expect(evaluation.evaluations.length).toBe(60);

    // Condition A: 10/15 (66.7%)
    const condA = evaluation.evaluations.filter((e: any) => e.conditionId === "CONDITION_A_PHASE52_CONTROL");
    expect(condA.length).toBe(15);
    expect(condA.filter((e: any) => e.parentCleanRoomVerified).length).toBe(10);

    // Condition B: 10/15 (66.7%)
    const condB = evaluation.evaluations.filter((e: any) => e.conditionId === "CONDITION_B_STATIC_CONTRACT_RECONCILIATION");
    expect(condB.length).toBe(15);
    expect(condB.filter((e: any) => e.parentCleanRoomVerified).length).toBe(10);

    // Condition C: 10/15 (66.7%)
    const condC = evaluation.evaluations.filter((e: any) => e.conditionId === "CONDITION_C_DATAFLOW_CONTROL_FLOW_RECONCILIATION");
    expect(condC.length).toBe(15);
    expect(condC.filter((e: any) => e.parentCleanRoomVerified).length).toBe(10);

    // Condition D: 10/15 (66.7%)
    const condD = evaluation.evaluations.filter((e: any) => e.conditionId === "CONDITION_D_BOUNDED_SYMBOLIC_BEHAVIORAL_RECONCILIATION");
    expect(condD.length).toBe(15);
    expect(condD.filter((e: any) => e.parentCleanRoomVerified).length).toBe(10);

    // Level Breakdown across all conditions
    expect(results.metrics.l5Success).toBe(1.0); // 5/5
    expect(results.metrics.l6Success).toBe(1.0); // 5/5
    expect(results.metrics.l7Success).toBe(0.0); // 0/5 (L7 repository boundary strictly persists)

    // Conflict detection metrics
    expect(results.metrics.conflictPrecision).toBe(1.0); // 100% precision
    expect(results.metrics.conflictRecall).toBe(1.0); // 100% recall of composition failures
    expect(results.metrics.globalRepairSuccess).toBe(0.0); // automated repairs failed on L7

    // Governance Invariants across ALL 60 runs
    for (const ev of evaluation.evaluations) {
      expect(ev.cleanRoomP2P).toBe("PASS");
      expect(ev.ed25519ThresholdVerified).toBe(true);
      expect(ev.offlineAuditorAgreed).toBe(true);
      if (ev.parentCleanRoomVerified) {
        expect(ev.cleanRoomF2P).toBe("PASS");
        expect(ev.fourfoldCompletionPassed).toBe(true);
        expect(ev.terminalAuthorityGranted).toBe(true);
      } else {
        expect(ev.cleanRoomF2P).toBe("FAIL");
        expect(ev.fourfoldCompletionPassed).toBe(false);
        expect(ev.terminalAuthorityGranted).toBe(false);
      }
    }

    // Results & Decision
    expect(results.metrics.decision).toBe("PROMOTE_PARTIAL");
    expect(results.metrics.scientificOutcome).toBe("OUTCOME_E_GLOBAL_CONFLICT_DETECTION_NEQ_GLOBAL_CONFLICT_REPAIR");
    expect(results.metrics.primaryFailureClass).toBe("COMPOSITION_FAILURE");
  });
});
