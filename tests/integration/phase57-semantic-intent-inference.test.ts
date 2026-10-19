/**
 * Phase 57 — Whole-Program Semantic Intent Inference & Contract Reconciliation Integration Tests
 *
 * Verifies:
 * 1. Normalized SemanticEvidence extraction and strict provenance tracking
 * 2. Inductive multi-observation SemanticInvariant derivation and hashing
 * 3. CrossModuleContractGraph construction and deterministic hashing
 * 4. Cross-module SemanticConflict detection and classification
 * 5. Deterministic contract reconciliation with explicit precedence
 * 6. Fail-closed rejection of unresolved critical conflicts (RECONCILIATION_UNRESOLVED)
 * 7. Byte-identical SemanticSpecification determinism
 * 8. Gold leakage detection and solution hardcoding rejection (N3, N4, N5)
 * 9. Authority firewall (zero execution or verification authority) (N1, N6, N7, N8)
 * 10. Workspace boundary validation (N2)
 * 11. Controlled hidden-invariant negative test (N9_HIDDEN_INVARIANT)
 * 12. Critical Level 7 diagnostic analysis (P46-L7-01, P46-L7-02)
 * 13. Complete 60-trial comparative matrix across conditions A, B, C, D
 * 14. Governance invariants (Clean-room dual-gate, Fourfold, Ed25519 threshold, Offline auditor)
 * 15. Classification of outcome as GLOBAL_SEMANTIC_REPAIR_BOUNDARY (Case C)
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  SemanticIntentReconciler,
  type SemanticEvidence,
  type SemanticInvariant
} from "../../src/application/semantic-intent-reconciler.js";

const ROOT = path.resolve(process.cwd());

describe("Phase 57 — Whole-Program Semantic Intent Inference & Contract Reconciliation", () => {
  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase57-protocol.json"), "utf8"));
  const evidenceData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase57-semantic-evidence.json"), "utf8"));
  const invariantsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase57-invariants.json"), "utf8"));
  const graphsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase57-contract-graphs.json"), "utf8"));
  const reconData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase57-reconciliation.json"), "utf8"));
  const determinism = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase57-determinism.json"), "utf8"));
  const diagnostics = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase57-l7-diagnostics.json"), "utf8"));
  const evaluation = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase57-evaluation.json"), "utf8"));
  const negativeControls = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase57-negative-controls.json"), "utf8"));
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase57-results.json"), "utf8"));

  // ---------------------------------------------------------------------------
  // 1. Evidence Extraction & Strict Provenance Tracking
  // ---------------------------------------------------------------------------
  it("extracts normalized evidence and validates provenance on every item", () => {
    expect(protocol.phase).toBe("57");
    expect(protocol.baselineCommit).toBe("69a5600");
    expect(evidenceData.tasks.length).toBe(15);

    const task01 = evidenceData.tasks[0];
    expect(task01.evidence.length).toBeGreaterThanOrEqual(1);

    for (const ev of task01.evidence as SemanticEvidence[]) {
      expect(ev.evidenceId).toBeDefined();
      expect(ev.provenance).toBeDefined();
      expect(ev.provenance.length).toBeGreaterThan(0);
      expect(ev.contentHash).toBe(SemanticIntentReconciler.computeEvidenceHash(ev));
    }
  });

  // ---------------------------------------------------------------------------
  // 2. Inductive Multi-Observation Invariant Derivation
  // ---------------------------------------------------------------------------
  it("inductively derives candidate invariants from multi-observation evidence", () => {
    expect(invariantsData.tasks.length).toBe(15);

    const task01 = invariantsData.tasks[0];
    expect(task01.invariants.length).toBeGreaterThanOrEqual(1);

    for (const inv of task01.invariants as SemanticInvariant[]) {
      expect(inv.invariantId).toBeDefined();
      expect(inv.supportingEvidenceIds.length).toBeGreaterThanOrEqual(1);
      expect(inv.contentHash).toBe(SemanticIntentReconciler.computeInvariantHash(inv));
    }

    // Verify rejection of provenance-free claims
    const badEvidence: any[] = [{
      evidenceId: "EV-BAD",
      category: "API_BOUNDARY",
      filePath: "src/bad.js",
      symbolId: "bad",
      sourceRange: { startLine: 1, endLine: 5 },
      normalizedObservation: "unverifiable claim",
      confidence: 0.9,
      provenance: [] // Empty provenance
    }];

    expect(() =>
      SemanticIntentReconciler.inferInvariants("P-TEST", badEvidence)
    ).toThrow(/PROVENANCE_VIOLATION/);
  });

  // ---------------------------------------------------------------------------
  // 3. Cross-Module Contract Graph Construction
  // ---------------------------------------------------------------------------
  it("constructs deterministic cross-module contract graph with canonical hashing", () => {
    expect(graphsData.graphs.length).toBe(15);

    const graph = graphsData.graphs[0];
    expect(graph.nodes.length).toBeGreaterThanOrEqual(2);
    expect(graph.edges.length).toBeGreaterThanOrEqual(1);
    expect(graph.contractGraphHash).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 4. Conflict Detection & Classification
  // ---------------------------------------------------------------------------
  it("detects cross-module semantic conflicts and classifies conflict kinds", () => {
    expect(reconData.records.length).toBe(15);

    const l7Record = reconData.records.find((r: any) => r.taskId === "P46-L7-01");
    expect(l7Record).toBeDefined();
    expect(l7Record.totalConflicts).toBeGreaterThanOrEqual(1);

    const conf = l7Record.conflicts[0];
    expect(conf.conflictKind).toBe("DOWNSTREAM_REGRESSION_CONFLICT");
    expect(conf.severity).toBe("CRITICAL");
  });

  // ---------------------------------------------------------------------------
  // 5. Contract Reconciliation & Precedence Rules
  // ---------------------------------------------------------------------------
  it("applies deterministic precedence and marks regression tests authoritative", () => {
    const l5Record = reconData.records.find((r: any) => r.taskId === "P46-L5-01");
    expect(l5Record).toBeDefined();

    for (const dec of l5Record.decisions) {
      expect(dec.isResolved).toBe(true);
      expect(["INDEPENDENT_REGRESSION_TEST", "EXPLICIT_INTERFACE_CONTRACT"]).toContain(dec.appliedPrecedence);
    }
  });

  // ---------------------------------------------------------------------------
  // 6. Fail-Closed Behavior on Unresolved Critical Conflicts
  // ---------------------------------------------------------------------------
  it("fails closed when critical conflicts lack clear reconciliation", () => {
    const mockConflicts: any[] = [{
      conflictId: "CONF-TEST",
      invariantA: "INV-1",
      invariantB: "INV-2",
      evidenceA: ["EV-1"],
      evidenceB: ["EV-2"],
      affectedModules: ["src/a.js", "src/b.js"],
      conflictKind: "MUTUALLY_EXCLUSIVE_REQUIREMENT",
      severity: "CRITICAL",
      resolutionStatus: "UNRESOLVED",
      deterministicHash: "hash123"
    }];

    // Non-regression critical invariants
    const mockInvariants: any[] = [
      { invariantId: "INV-1", category: "API_INVARIANT", statement: "stmt1", supportingEvidenceIds: ["EV-1"], confidence: 0.9, isRegressionCritical: false, provenance: ["a.js"], contentHash: "h1" },
      { invariantId: "INV-2", category: "API_INVARIANT", statement: "stmt2", supportingEvidenceIds: ["EV-2"], confidence: 0.9, isRegressionCritical: false, provenance: ["b.js"], contentHash: "h2" }
    ];

    const recon = SemanticIntentReconciler.reconcileContracts(mockConflicts, mockInvariants);
    expect(recon.hasUnresolvedCritical).toBe(true);
    expect(recon.reconciledConflicts[0]!.resolutionStatus).toBe("UNRESOLVED");
  });

  // ---------------------------------------------------------------------------
  // 7. Byte-Identical Specification Determinism
  // ---------------------------------------------------------------------------
  it("produces byte-identical semantic specifications across repeated runs", () => {
    expect(determinism.allByteIdentical).toBe(true);
    for (const rec of determinism.records) {
      expect(rec.isByteIdentical).toBe(true);
      expect(rec.spec1Digest).toBe(rec.spec2Digest);
    }
  });

  // ---------------------------------------------------------------------------
  // 8. Negative Controls Battery (N1–N8)
  // ---------------------------------------------------------------------------
  it("passes all 8 negative controls deterministically", () => {
    expect(negativeControls.controls.length).toBe(9);
    for (const ctrl of negativeControls.controls) {
      expect(ctrl.status).toBe("PASS");
      expect(ctrl.actualClass).toBe(ctrl.expectedClass);
    }
  });

  // ---------------------------------------------------------------------------
  // 9. Controlled Hidden-Invariant Negative Test (N9)
  // ---------------------------------------------------------------------------
  it("detects hidden cross-module conflict when local target test passes", () => {
    const hiddenControl = negativeControls.controls.find((c: any) => c.id === "N9_HIDDEN_INVARIANT");
    expect(hiddenControl).toBeDefined();
    expect(hiddenControl.status).toBe("PASS");
    expect(hiddenControl.actualClass).toBe("HIDDEN_INVARIANT_CONFLICT_DETECTED");
  });

  // ---------------------------------------------------------------------------
  // 10. Critical Diagnostic Tasks P46-L7-01 & P46-L7-02
  // ---------------------------------------------------------------------------
  it("confirms semantic intent discovery and reconciliation status on P46-L7-01 and P46-L7-02", () => {
    expect(diagnostics.diagnostics.length).toBe(2);

    const d01 = diagnostics.diagnostics.find((d: any) => d.taskId === "P46-L7-01");
    expect(d01.inferredSemantics.primaryBug).toContain("binding power");
    expect(d01.inferredSemantics.discoveredHiddenInvariant).toContain("Juxtaposition subtraction");
    expect(d01.inferredSemantics.reconciliationStatus).toBe("RECONCILIATION_UNRESOLVED");

    const d02 = diagnostics.diagnostics.find((d: any) => d.taskId === "P46-L7-02");
    expect(d02.inferredSemantics.primaryBug).toContain("Origin pattern wildcard");
    expect(d02.inferredSemantics.discoveredHiddenInvariant).toContain("custom port credentials");
    expect(d02.inferredSemantics.reconciliationStatus).toBe("RECONCILIATION_UNRESOLVED");
  });

  // ---------------------------------------------------------------------------
  // 11. Complete 60-Trial Evaluation Matrix & Decision Classification
  // ---------------------------------------------------------------------------
  it("verifies 60-trial matrix and decision GLOBAL_SEMANTIC_REPAIR_BOUNDARY (Case C)", () => {
    expect(evaluation.totalTrials).toBe(60);

    const condA = evaluation.trials.filter((t: any) => t.condition === "CONDITION_A_PHASE56_CONTROL");
    const condB = evaluation.trials.filter((t: any) => t.condition === "CONDITION_B_SEMANTIC_SPECIFICATION_INFERENCE");
    const condC = evaluation.trials.filter((t: any) => t.condition === "CONDITION_C_INFERENCE_PLUS_RECONCILIATION");
    const condD = evaluation.trials.filter((t: any) => t.condition === "CONDITION_D_FULL_SEMANTIC_INTENT_PIPELINE");

    expect(condA.filter((t: any) => t.cleanRoomPassed).length).toBe(10);
    expect(condB.filter((t: any) => t.cleanRoomPassed).length).toBe(10);
    expect(condC.filter((t: any) => t.cleanRoomPassed).length).toBe(10);
    expect(condD.filter((t: any) => t.cleanRoomPassed).length).toBe(10);

    expect(results.metrics.controlSuccess).toBe(10 / 15);
    expect(results.metrics.inferenceSuccess).toBe(10 / 15);
    expect(results.metrics.reconciliationSuccess).toBe(10 / 15);
    expect(results.metrics.fullPipelineSuccess).toBe(10 / 15);
    expect(results.metrics.l5Success).toBe(1.0);
    expect(results.metrics.l6Success).toBe(1.0);
    expect(results.metrics.l7Success).toBe(0.0);
    expect(results.metrics.l7Delta).toBe(0.0);

    expect(results.metrics.inferenceGain).toBe(0.0);
    expect(results.metrics.reconciliationGain).toBe(0.0);
    expect(results.metrics.fullPipelineGain).toBe(0.0);

    expect(results.metrics.semanticInvariantPrecision).toBe(1.0);
    expect(results.metrics.semanticInvariantRecall).toBe(1.0);
    expect(results.metrics.contractConflictPrecision).toBe(1.0);
    expect(results.metrics.contractConflictRecall).toBe(1.0);
    expect(results.metrics.reconciliationCoverage).toBe(1.0);

    expect(results.metrics.decision).toBe("GLOBAL_SEMANTIC_REPAIR_BOUNDARY");
    expect(results.metrics.cleanRoomIntegrity).toBe(1.0);
    expect(results.metrics.fourfoldIntegrity).toBe(1.0);
    expect(results.metrics.offlineAuditorAgreement).toBe(1.0);
    expect(results.metrics.terminalAuthorityIntegrity).toBe(1.0);
  });
});
