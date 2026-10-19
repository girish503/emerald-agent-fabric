/**
 * Phase 58 — Coupled Multi-File Inductive Program Repair Synthesis Integration Tests
 *
 * Verifies:
 * 1. Repair obligation extraction generates deterministic IDs and provenance hashes
 * 2. Repair variable construction across multiple files preserves cross-module dependencies
 * 3. Coupled repair graph maintains valid topology, node indexing, and repairGraphDigest
 * 4. Candidate ranking orders candidates by complexity and specificity deterministically
 * 5. Cross-module constraint evaluation checks INTRA_MODULE, CROSS_MODULE, and REGRESSION_PRESERVATION
 * 6. Unknown constraint behavior fails closed (FAIL_CLOSED)
 * 7. Branch-and-bound search terminates deterministically on search exhaustion or depth ceiling
 * 8. Transactional multi-file atomic patch application applies edits to all target files atomically
 * 9. Atomic rollback restores original files if any constraint fails
 * 10. Gold patch leakage prevention rejects references to gold patches or expected oracle outputs
 * 11. Authority firewall prevents candidate promotion to authoritative specification without verification
 * 12. Byte-identical determinism across repeated runs
 * 13. Diagnostic task P46-L7-01: logs exhausted candidates and failure attribution
 * 14. Diagnostic task P46-L7-02: logs exhausted candidates and failure attribution
 * 15. Fourfold verification gate executes fail-closed on unverified candidates
 * 16. Search space budget limits (maxDepth: 5, maxCandidates: 25, maxWallClockMs: 30000) are enforced
 * 17. Negative controls N1–N8 are rejected
 * 18. Clean-room verification enforces zero false positives
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  CoupledRepairSynthesizer,
  REPAIR_SEARCH_LIMITS,
  type RepairObligation,
  type CoupledRepairGraph,
  type CrossModuleConstraint,
  type RepairCandidate,
  type MultiFilePatch
} from "../../src/application/coupled-repair-synthesizer.js";

const ROOT = path.resolve(process.cwd());

describe("Phase 58 — Coupled Multi-File Inductive Program Repair Synthesis", () => {
  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase58-protocol.json"), "utf8"));
  const obligationsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase58-repair-obligations.json"), "utf8"));
  const graphsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase58-repair-graphs.json"), "utf8"));
  const candidatesData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase58-candidates.json"), "utf8"));
  const determinism = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase58-determinism.json"), "utf8"));
  const diagnostics = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase58-l7-diagnostics.json"), "utf8"));
  const evaluation = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase58-evaluation.json"), "utf8"));
  const negativeControls = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase58-negative-controls.json"), "utf8"));
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase58-results.json"), "utf8"));

  // ---------------------------------------------------------------------------
  // 1. Repair Obligation Extraction & Provenance
  // ---------------------------------------------------------------------------
  it("extracts obligations with deterministic IDs and provenance hashes", () => {
    expect(protocol.phase).toBe("58");
    expect(protocol.baselineCommit).toBe("f7d25d0");
    expect(obligationsData.tasks.length).toBe(15);
    expect(candidatesData.totalSearches).toBe(15);

    for (const task of obligationsData.tasks) {
      expect(task.obligationsCount).toBeGreaterThanOrEqual(1);
      for (const ob of task.obligations as RepairObligation[]) {
        expect(ob.obligationId).toBeDefined();
        expect(ob.provenanceHash).toBe(CoupledRepairSynthesizer.computeObligationHash(ob));
        expect(ob.requiredGuarantees!.length).toBeGreaterThan(0);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // 2. Repair Variable Construction & Cross-Module Dependencies
  // ---------------------------------------------------------------------------
  it("constructs repair variables preserving cross-module linkages", () => {
    const l7Task = obligationsData.tasks.find((t: any) => t.taskId === "P46-L7-01");
    expect(l7Task).toBeDefined();

    const vars = CoupledRepairSynthesizer.constructRepairVariables(
      "P46-L7-01",
      l7Task.obligations,
      ["src/parser.js", "src/calc.js"],
      ["parseExpression", "evaluateExponent"]
    );

    expect(vars.length).toBe(2);
    expect(vars[0]!.targetFile).toBe("src/parser.js");
    expect(vars[1]!.targetFile).toBe("src/calc.js");
    expect(vars[0]!.variableType).toBe("BINDING_POWER");
    expect(vars[1]!.variableType).toBe("BINDING_POWER");

    for (const v of vars) {
      expect(v.variableDigest).toBe(CoupledRepairSynthesizer.computeVariableHash(v));
      expect(v.domain!.length).toBeGreaterThan(0);
    }
  });

  // ---------------------------------------------------------------------------
  // 3. Coupled Repair Graph Topology & Canonical Digest
  // ---------------------------------------------------------------------------
  it("constructs coupled repair graph with topological ordering and deterministic digest", () => {
    expect(graphsData.graphs.length).toBe(15);

    for (const graph of graphsData.graphs as CoupledRepairGraph[]) {
      expect(graph.graphId).toBeDefined();
      expect(graph.variables.length).toBeGreaterThanOrEqual(1);
      expect(graph.constraints.length).toBeGreaterThanOrEqual(1);
      expect(graph.repairGraphDigest).toBeDefined();
      expect(graph.topologicalOrder.length).toBe(graph.variables.length);
    }
  });

  // ---------------------------------------------------------------------------
  // 4. Candidate Ranking by Complexity and Specificity
  // ---------------------------------------------------------------------------
  it("ranks repair candidates deterministically by complexity and specificity", () => {
    const c1: RepairCandidate = {
      candidateId: "C1",
      variableBindings: {},
      complexityScore: 10,
      specificityScore: 2,
      evaluationStatus: "UNTESTED",
      evaluationDetails: "Low specificity, high complexity",
      candidateDigest: "hash1"
    };
    const c2: RepairCandidate = {
      candidateId: "C2",
      variableBindings: {},
      complexityScore: 2,
      specificityScore: 5,
      evaluationStatus: "UNTESTED",
      evaluationDetails: "High specificity, low complexity",
      candidateDigest: "hash2"
    };

    const sorted = CoupledRepairSynthesizer.rankCandidates([c1, c2]);
    expect(sorted[0]!.candidateId).toBe("C2");
    expect(sorted[1]!.candidateId).toBe("C1");
  });

  // ---------------------------------------------------------------------------
  // 5. Cross-Module Constraint Evaluation
  // ---------------------------------------------------------------------------
  it("evaluates INTRA_MODULE, CROSS_MODULE, and REGRESSION_PRESERVATION constraints", () => {
    const candidate: RepairCandidate = {
      candidateId: "C-TEST",
      variableBindings: {
        "VAR-1": "let x = 1;",
        "VAR-2": "let y = 2;"
      },
      complexityScore: 4,
      specificityScore: 4,
      evaluationStatus: "UNTESTED",
      evaluationDetails: "",
      candidateDigest: "cand-hash"
    };

    const intraConstraint: CrossModuleConstraint = {
      constraintId: "C-INTRA",
      constraintType: "INTRA_MODULE",
      affectedVariables: ["VAR-1"],
      specification: "valid assignment",
      enforcementMode: "BLOCKING"
    };

    const crossConstraint: CrossModuleConstraint = {
      constraintId: "C-CROSS",
      constraintType: "CROSS_MODULE",
      affectedVariables: ["VAR-1", "VAR-2"],
      specification: "consistent return types",
      enforcementMode: "BLOCKING"
    };

    const evalIntra = CoupledRepairSynthesizer.evaluateConstraint(candidate, intraConstraint);
    expect(evalIntra.satisfied).toBe(true);
    expect(evalIntra.reason).toContain("INTRA_MODULE satisfied");

    const evalCross = CoupledRepairSynthesizer.evaluateConstraint(candidate, crossConstraint);
    expect(evalCross.satisfied).toBe(true);
    expect(evalCross.reason).toContain("CROSS_MODULE satisfied");
  });

  // ---------------------------------------------------------------------------
  // 6. Unknown Constraint Behavior Fails Closed
  // ---------------------------------------------------------------------------
  it("fails closed on UNKNOWN or unhandled constraint types", () => {
    const candidate: RepairCandidate = {
      candidateId: "C-TEST",
      variableBindings: { "VAR-1": "test" },
      complexityScore: 1,
      specificityScore: 1,
      evaluationStatus: "UNTESTED",
      evaluationDetails: "",
      candidateDigest: "hash"
    };

    const unknownConstraint: any = {
      constraintId: "C-UNKNOWN",
      constraintType: "SPECULATIVE_UNDEFINED_TYPE",
      affectedVariables: ["VAR-1"],
      specification: "unknown",
      enforcementMode: "BLOCKING"
    };

    const evalResult = CoupledRepairSynthesizer.evaluateConstraint(candidate, unknownConstraint);
    expect(evalResult.satisfied).toBe(false);
    expect(evalResult.reason).toContain("FAIL_CLOSED");
  });

  // ---------------------------------------------------------------------------
  // 7. Bounded Branch-and-Bound Search Termination
  // ---------------------------------------------------------------------------
  it("terminates search deterministically on search exhaustion or depth ceiling", () => {
    const task01 = graphsData.graphs.find((g: any) => g.taskId === "P46-L7-01")!;
    const searchResult = CoupledRepairSynthesizer.synthesizeCoupledRepair(
      "P46-L7-01",
      task01,
      task01.constraints,
      true // isL7
    );

    expect(searchResult.exhausted).toBe(true);
    expect(searchResult.selectedCandidate).toBeNull();
    expect(searchResult.exploredCandidatesCount).toBeGreaterThan(0);
    expect(searchResult.failureAttribution).toContain("COMBINATORIAL_REPAIR_SEARCH_BOUNDARY");
  });

  // ---------------------------------------------------------------------------
  // 8. Transactional Multi-File Atomic Patch Application
  // ---------------------------------------------------------------------------
  it("applies multi-file patch transactionally to all target files", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase58-test-"));
    const fileA = path.join(tmpDir, "fileA.js");
    const fileB = path.join(tmpDir, "fileB.js");

    fs.writeFileSync(fileA, "const a = 1;");
    fs.writeFileSync(fileB, "const b = 2;");

    const patch: MultiFilePatch = {
      patchId: "PATCH-01",
      taskId: "TEST-TASK",
      modifications: [
        { filePath: fileA, originalContent: "const a = 1;", modifiedContent: "const a = 100;" },
        { filePath: fileB, originalContent: "const b = 2;", modifiedContent: "const b = 200;" }
      ],
      patchDigest: "pdigest"
    };

    const result = CoupledRepairSynthesizer.applyMultiFilePatch(tmpDir, patch);
    expect(result.success).toBe(true);
    expect(fs.readFileSync(fileA, "utf8")).toBe("const a = 100;");
    expect(fs.readFileSync(fileB, "utf8")).toBe("const b = 200;");

    // Clean up
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // 9. Atomic Rollback on Constraint/File Failure
  // ---------------------------------------------------------------------------
  it("rolls back all modifications atomically if any file mutation fails", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase58-rollback-"));
    const fileA = path.join(tmpDir, "fileA.js");
    const nonExistentFile = path.join(tmpDir, "nonexistent", "fileB.js");

    fs.writeFileSync(fileA, "const a = 1;");

    const patch: MultiFilePatch = {
      patchId: "PATCH-FAIL",
      taskId: "TEST-TASK",
      modifications: [
        { filePath: fileA, originalContent: "const a = 1;", modifiedContent: "const a = 999;" },
        { filePath: nonExistentFile, originalContent: "", modifiedContent: "broken" }
      ],
      patchDigest: "pdigest"
    };

    const result = CoupledRepairSynthesizer.applyMultiFilePatch(tmpDir, patch);
    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);
    // fileA must be restored to original content
    expect(fs.readFileSync(fileA, "utf8")).toBe("const a = 1;");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // 10. Gold Patch Leakage Prevention
  // ---------------------------------------------------------------------------
  it("strictly detects and rejects gold patch leaks and test oracle access (N3, N4, N5)", () => {
    expect(CoupledRepairSynthesizer.detectGoldLeakage("__SWE_BENCH_GOLD_PATCH__")).toBe(true);
    expect(CoupledRepairSynthesizer.detectGoldLeakage("__REFERENCE_ORACLE_OUTPUT__")).toBe(true);
    expect(CoupledRepairSynthesizer.detectGoldLeakage("P46-L7-01_HARDCODED_GOLD_FIX")).toBe(true);
    expect(CoupledRepairSynthesizer.detectGoldLeakage("standard safe repair code")).toBe(false);

    expect(() =>
      CoupledRepairSynthesizer.validateAuthorityAction("N3", "__SWE_BENCH_GOLD_PATCH__")
    ).toThrow(/GOLD_LEAK_DETECTED/);

    expect(() =>
      CoupledRepairSynthesizer.validateAuthorityAction("N4", "__REFERENCE_ORACLE_OUTPUT__")
    ).toThrow(/GOLD_LEAK_DETECTED/);

    expect(() =>
      CoupledRepairSynthesizer.validateAuthorityAction("N5", "P46-L7-01_HARDCODED_GOLD_FIX")
    ).toThrow(/GOLD_LEAK_DETECTED/);
  });

  // ---------------------------------------------------------------------------
  // 11. Authority Firewall Integrity
  // ---------------------------------------------------------------------------
  it("enforces authority firewall preventing self-elevation or bypass (N1, N2, N6, N7, N8)", () => {
    expect(() =>
      CoupledRepairSynthesizer.validateAuthorityAction("N1", "out_of_bounds_path")
    ).toThrow(/WORKSPACE_BOUNDARY_VIOLATION/);

    expect(() =>
      CoupledRepairSynthesizer.validateAuthorityAction("N2", "external_api")
    ).toThrow(/REJECT/);

    expect(() =>
      CoupledRepairSynthesizer.validateAuthorityAction("N6", "candidate_to_authoritative")
    ).toThrow(/REJECT/);

    expect(() =>
      CoupledRepairSynthesizer.validateAuthorityAction("N7", "emit_pass_token")
    ).toThrow(/REJECT/);

    expect(() =>
      CoupledRepairSynthesizer.validateAuthorityAction("N8", "write_terminal_record")
    ).toThrow(/REJECT/);
  });

  // ---------------------------------------------------------------------------
  // 12. Byte-Identical Determinism Across Repeated Runs
  // ---------------------------------------------------------------------------
  it("confirms byte-identical determinism across repeated executions", () => {
    expect(determinism.allByteIdentical).toBe(true);
    expect(determinism.records.length).toBe(15);

    for (const rec of determinism.records) {
      expect(rec.isByteIdentical).toBe(true);
      expect(rec.run1Digest).toBe(rec.run2Digest);
    }
  });

  // ---------------------------------------------------------------------------
  // 13. Critical Diagnostic Task P46-L7-01
  // ---------------------------------------------------------------------------
  it("evaluates diagnostic task P46-L7-01 and confirms search exhaustion", () => {
    const diag = diagnostics.diagnostics.find((d: any) => d.taskId === "P46-L7-01");
    expect(diag).toBeDefined();
    expect(diag.searchExhaustionStatus).toBe("REPAIR_SEARCH_EXHAUSTED");
    expect(diag.candidatesExplored).toBe(9);
    expect(diag.candidatesRejected).toBe(9);
    expect(diag.failureAttribution).toContain("COMBINATORIAL_REPAIR_SEARCH_BOUNDARY");
  });

  // ---------------------------------------------------------------------------
  // 14. Critical Diagnostic Task P46-L7-02
  // ---------------------------------------------------------------------------
  it("evaluates diagnostic task P46-L7-02 and confirms search exhaustion", () => {
    const diag = diagnostics.diagnostics.find((d: any) => d.taskId === "P46-L7-02");
    expect(diag).toBeDefined();
    expect(diag.searchExhaustionStatus).toBe("REPAIR_SEARCH_EXHAUSTED");
    expect(diag.candidatesExplored).toBe(4);
    expect(diag.candidatesRejected).toBe(4);
    expect(diag.failureAttribution).toContain("COMBINATORIAL_REPAIR_SEARCH_BOUNDARY");
  });

  // ---------------------------------------------------------------------------
  // 15. Fourfold Verification Fail-Closed
  // ---------------------------------------------------------------------------
  it("executes fourfold verification gate with fail-closed behavior on unverified candidates", () => {
    const l7Candidate: RepairCandidate = {
      candidateId: "C-L7",
      variableBindings: { "VAR-1": "mutation" },
      complexityScore: 10,
      specificityScore: 1,
      evaluationStatus: "UNTESTED",
      evaluationDetails: "Unverified candidate",
      candidateDigest: "c-digest"
    };

    const verified = CoupledRepairSynthesizer.verifyFourfoldGate("P46-L7-01", l7Candidate);
    expect(verified).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 16. Search Space Budget Limits Enforced
  // ---------------------------------------------------------------------------
  it("enforces search space budget limits", () => {
    expect(REPAIR_SEARCH_LIMITS.maxSearchDepth).toBe(5);
    expect(REPAIR_SEARCH_LIMITS.maxCandidatePerVariable).toBe(25);
    expect(REPAIR_SEARCH_LIMITS.maxWallClockMs).toBe(30000);
    expect(results.metrics.maxSearchDepth).toBe(5);
  });

  // ---------------------------------------------------------------------------
  // 17. Negative Controls N1–N8 Complete Verification
  // ---------------------------------------------------------------------------
  it("verifies all negative controls pass with 100% integrity", () => {
    expect(negativeControls.controls.length).toBe(8);
    for (const ctrl of negativeControls.controls) {
      expect(ctrl.status).toBe("PASS");
      expect(ctrl.actualClass).toBe(ctrl.expectedClass);
    }
  });

  // ---------------------------------------------------------------------------
  // 18. Clean-Room Verification Zero False Positives
  // ---------------------------------------------------------------------------
  it("enforces clean-room zero false positive rate across all conditions", () => {
    const trials = evaluation.trials;
    expect(trials.length).toBe(60);

    const l7Trials = trials.filter((t: any) => t.complexityTier.startsWith("L7"));
    expect(l7Trials.length).toBe(20);

    // Zero false positives on L7: none pass clean-room
    for (const trial of l7Trials) {
      expect(trial.cleanRoomPassed).toBe(false);
    }

    expect(results.metrics.decision).toBe("COMBINATORIAL_REPAIR_SEARCH_BOUNDARY");
    expect(results.metrics.scientificOutcome).toBe("OUTCOME_C_COMBINATORIAL_REPAIR_SEARCH_BOUNDARY");
    expect(results.metrics.remainingBoundary).toBe("COMBINATORIAL_REPAIR_SPACE_SEARCH_AND_HEURISTIC_PRUNING");
  });
});
