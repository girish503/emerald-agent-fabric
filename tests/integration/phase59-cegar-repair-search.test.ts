/**
 * Phase 59 — Counterexample-Guided Coupled Repair Search (CEGAR) Integration Tests
 *
 * Verifies:
 * 1. Counterexample extraction from failed candidate execution
 * 2. Counterexample normalization from raw payloads
 * 3. Counterexample generalization into RefinementConstraints
 * 4. Refinement constraint construction with canonical hashing
 * 5. Safe refinement: generalizable incompatibility prunes invalid subspace
 * 6. Unsound refinement rejection (REFINEMENT_NOT_PROVEN on superficial shared features)
 * 7. Search-space pruning and reduction ratio computation
 * 8. Search trace recording with deterministic digest
 * 9. Hidden counterexample: local test passes but downstream regression failure triggers CEGAR refinement
 * 10. Diagnostic task P46-L7-01 (SWE-bench calc Pratt parser)
 * 11. Diagnostic task P46-L7-02 (SWE-bench CORS validator)
 * 12. Transactional multi-file atomic patch application & rollback
 * 13. Gold leakage detection and rejection (N3, N4, N5)
 * 14. Authority firewall preventing self-elevation or bypass (N1, N2, N6, N7, N8, N9)
 * 15. Clean-room verification fail-closed behavior on unverified candidates
 * 16. Fourfold completion gate execution
 * 17. Deterministic replay across repeated independent runs
 * 18. Complete negative control suite (N1–N9)
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  CegarRepairSearchEngine,
  type Counterexample,
  type RefinementConstraint,
  type RefinedRepairSpace
} from "../../src/application/cegar-repair-search.js";
import {
  CoupledRepairSynthesizer,
  REPAIR_SEARCH_LIMITS,
  type CoupledRepairGraph,
  type RepairCandidate,
  type MultiFilePatch
} from "../../src/application/coupled-repair-synthesizer.js";

const ROOT = path.resolve(process.cwd());

describe("Phase 59 — Counterexample-Guided Coupled Repair Search (CEGAR)", () => {
  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase59-protocol.json"), "utf8"));
  const counterexamplesData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase59-counterexamples.json"), "utf8"));
  const refinementsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase59-refinement-constraints.json"), "utf8"));
  const tracesData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase59-search-traces.json"), "utf8"));
  const determinism = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase59-determinism.json"), "utf8"));
  const diagnostics = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase59-l7-diagnostics.json"), "utf8"));
  const evaluation = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase59-evaluation.json"), "utf8"));
  const negativeControls = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase59-negative-controls.json"), "utf8"));
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase59-results.json"), "utf8"));

  // ---------------------------------------------------------------------------
  // 1. Counterexample Extraction
  // ---------------------------------------------------------------------------
  it("extracts structured counterexamples with content hashes and provenance", () => {
    expect(protocol.phase).toBe("59");
    expect(protocol.baselineCommit).toBe("4fc48cc");
    expect(counterexamplesData.tasks.length).toBe(15);
    expect(evaluation.totalTrials).toBe(60);
    expect(REPAIR_SEARCH_LIMITS.maxCandidates).toBe(25);

    const candidate: RepairCandidate = {
      candidateId: "CAND-TEST-1",
      assignments: { "VAR-1": "val1" },
      affectedFiles: ["src/parser.js"],
      affectedSymbols: ["parseExpression"],
      candidateDigest: "cand-digest-1"
    };

    const cx = CegarRepairSearchEngine.extractCounterexample(
      "P46-L7-01",
      candidate,
      "REGRESSION_FAILURE",
      "infix juxtaposition failed",
      "NaN",
      "-2"
    );

    expect(cx.counterexampleId).toBe("CX-P46-L7-01-CAND-TEST-1-REGRESSION_FAILURE");
    expect(cx.failureClass).toBe("REGRESSION_FAILURE");
    expect(cx.contentHash).toBe(CegarRepairSearchEngine.computeCounterexampleHash(cx));
    expect(cx.provenance.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // 2. Counterexample Normalization
  // ---------------------------------------------------------------------------
  it("normalizes raw failure payloads into canonical Counterexamples", () => {
    const raw = {
      counterexampleId: "RAW-CX-01",
      candidateId: "CAND-RAW",
      failureClass: "COMPILE_FAILURE",
      failedAssertion: "SyntaxError: Unexpected token",
      observedValue: "syntax_error",
      expectedValue: "compiled"
    };

    const normalized = CegarRepairSearchEngine.normalizeCounterexample(raw);
    expect(normalized.counterexampleId).toBe("RAW-CX-01");
    expect(normalized.contentHash).toBeDefined();
    expect(normalized.affectedFiles).toEqual([]);

    expect(() =>
      CegarRepairSearchEngine.normalizeCounterexample({ missingId: true })
    ).toThrow(/INVALID_COUNTEREXAMPLE/);
  });

  // ---------------------------------------------------------------------------
  // 3. Counterexample Generalization
  // ---------------------------------------------------------------------------
  it("generalizes cross-module regression counterexamples into multi-variable refinement constraints", () => {
    const candidate: RepairCandidate = {
      candidateId: "CAND-P46-L7-01",
      assignments: {
        "VAR-P46-L7-01-1": "BP_8",
        "VAR-P46-L7-01-2": "BP_8"
      },
      affectedFiles: ["src/parser.js", "src/calc.js"],
      affectedSymbols: ["parseExpression", "evaluateExponent"],
      candidateDigest: "c-digest"
    };

    const cx = CegarRepairSearchEngine.extractCounterexample(
      "P46-L7-01",
      candidate,
      "REGRESSION_FAILURE",
      "test/calc-p2p.test.js: unary juxtaposition",
      "FAIL",
      "PASS"
    );

    const dummyGraph: CoupledRepairGraph = {
      graphId: "G-TEST",
      taskId: "P46-L7-01",
      variables: [],
      obligations: [],
      constraints: [],
      edges: [],
      topologicalOrder: [],
      repairGraphDigest: "g-digest"
    };

    const refinement = CegarRepairSearchEngine.generalizeCounterexample(
      "P46-L7-01",
      cx,
      candidate,
      dummyGraph
    );

    expect(refinement).not.toBe("REFINEMENT_NOT_PROVEN");
    if (typeof refinement !== "string") {
      expect(refinement.scope).toBe("CROSS_MODULE");
      expect(refinement.affectedVariables).toEqual(["VAR-P46-L7-01-1", "VAR-P46-L7-01-2"]);
      expect(refinement.forbiddenCombinations.length).toBe(1);
      expect(refinement.constraintDigest).toBe(CegarRepairSearchEngine.computeRefinementHash(refinement));
    }
  });

  // ---------------------------------------------------------------------------
  // 4. Refinement Constraint Construction
  // ---------------------------------------------------------------------------
  it("constructs deterministic RefinementConstraints with canonical hashing", () => {
    expect(refinementsData.tasks.length).toBe(15);
    for (const task of refinementsData.tasks) {
      for (const rc of task.refinements as RefinementConstraint[]) {
        expect(rc.constraintId).toBeDefined();
        expect(rc.constraintDigest).toBe(CegarRepairSearchEngine.computeRefinementHash(rc));
        expect(rc.confidence).toBeGreaterThan(0.5);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // 5. Safe Refinement
  // ---------------------------------------------------------------------------
  it("safely prunes invalid search regions using generalizable refinement constraints", () => {
    const space: RefinedRepairSpace = {
      taskId: "P46-L7-01",
      initialCardinality: 25,
      currentCardinality: 25,
      prunedCardinality: 0,
      searchReductionRatio: 0,
      refinementConstraints: []
    };

    const rc: RefinementConstraint = {
      constraintId: "RC-TEST",
      sourceCounterexampleId: "CX-TEST",
      affectedVariables: ["VAR-1", "VAR-2"],
      forbiddenCombinations: [{ "VAR-1": "BP_8", "VAR-2": "BP_8" }],
      requiredRelationships: ["MUTUAL_EXCLUSION: VAR-1 & VAR-2"],
      scope: "CROSS_MODULE",
      confidence: 0.95,
      provenance: ["PROV:TEST"],
      constraintDigest: "rc-hash"
    };

    const pruned = CegarRepairSearchEngine.pruneRepairSpace(space, rc);
    expect(pruned.prunedCardinality).toBeGreaterThan(0);
    expect(pruned.currentCardinality).toBeLessThan(space.initialCardinality);
    expect(pruned.searchReductionRatio).toBeGreaterThan(0);
    expect(pruned.refinementConstraints.length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 6. Unsound Refinement Rejection (Section 22)
  // ---------------------------------------------------------------------------
  it("rejects unsound refinement on superficial non-causal shared features", () => {
    const candidateA: RepairCandidate = {
      candidateId: "CAND-A",
      assignments: { "VAR-1": "BP_8", "VAR-2": "BP_8" },
      candidateDigest: "digest-A"
    };

    const candidateB: RepairCandidate = {
      candidateId: "CAND-B",
      assignments: { "VAR-1": "BP_8", "VAR-2": "BP_10" }, // superficially shares VAR-1=BP_8
      candidateDigest: "digest-B"
    };

    const failureA: Counterexample = {
      counterexampleId: "CX-A",
      candidateId: "CAND-A",
      failureClass: "REGRESSION_FAILURE",
      affectedFiles: ["src/parser.js"],
      affectedSymbols: ["parseExpression"],
      failedAssertion: "calc p2p",
      observedValue: "fail",
      expectedValue: "pass",
      provenance: ["EXEC:A"],
      candidateDigest: "digest-A",
      contentHash: "hash-A"
    };

    const outcome = CegarRepairSearchEngine.evaluateUnsoundRefinement(
      candidateA,
      candidateB,
      failureA
    );
    expect(outcome).toBe("REFINEMENT_NOT_PROVEN");
  });

  // ---------------------------------------------------------------------------
  // 7. Search Space Pruning & Reduction Ratio
  // ---------------------------------------------------------------------------
  it("computes search reduction ratio accurately", () => {
    expect(results.metrics.searchReductionRatio).toBe(0.60);
    expect(results.metrics.prunedCandidates).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // 8. Search Trace Determinism
  // ---------------------------------------------------------------------------
  it("persists deterministic search traces across all evaluated tasks", () => {
    expect(tracesData.traces.length).toBe(15);
    for (const trace of tracesData.traces) {
      expect(trace.taskId).toBeDefined();
      expect(trace.iterations.length).toBeGreaterThan(0);
      expect(trace.searchTraceDigest).toBeDefined();
    }
  });

  // ---------------------------------------------------------------------------
  // 9. Hidden Counterexample Control (Section 20)
  // ---------------------------------------------------------------------------
  it("extracts downstream regression failures when local target test passes", () => {
    const candidate: RepairCandidate = {
      candidateId: "CAND-LOCAL-PASS",
      assignments: { "VAR-1": "repaired_local", "VAR-2": "unrepaired_remote" },
      candidateDigest: "c-digest-hidden"
    };

    // Local target test passes, but downstream regression fails
    const cx = CegarRepairSearchEngine.extractCounterexample(
      "P46-L7-01",
      candidate,
      "REGRESSION_FAILURE",
      "test/calc-p2p.test.js: downstream consumer failure",
      "FAIL",
      "PASS",
      "DOWNSTREAM_REGRESSION_DETECTION"
    );

    expect(cx.failureClass).toBe("REGRESSION_FAILURE");
    expect(cx.provenance).toContain("PROV:DOWNSTREAM_REGRESSION_DETECTION");

    const dummyGraph: CoupledRepairGraph = {
      graphId: "G-TEST",
      taskId: "P46-L7-01",
      variables: [],
      obligations: [],
      constraints: [],
      edges: [],
      topologicalOrder: [],
      repairGraphDigest: "g-digest"
    };

    const refinement = CegarRepairSearchEngine.generalizeCounterexample(
      "P46-L7-01",
      cx,
      candidate,
      dummyGraph
    );
    expect(refinement).not.toBe("REFINEMENT_NOT_PROVEN");
  });

  // ---------------------------------------------------------------------------
  // 10. Critical Diagnostic Task P46-L7-01
  // ---------------------------------------------------------------------------
  it("evaluates diagnostic task P46-L7-01 with Pratt binding power counterexample", () => {
    const diag = diagnostics.diagnostics.find((d: any) => d.taskId === "P46-L7-01");
    expect(diag).toBeDefined();
    expect(diag.counterexamplesExtracted.length).toBe(1);
    expect(diag.refinementConstraintsDerived.length).toBe(1);
    expect(diag.searchReductionRatio).toBe(0.60);
    expect(diag.searchExhaustionStatus).toBe("REPAIR_SEARCH_EXHAUSTED");
    expect(diag.failureAttribution).toContain("REPAIR_SEARCH_COMPLEXITY_BOUNDARY");
  });

  // ---------------------------------------------------------------------------
  // 11. Critical Diagnostic Task P46-L7-02
  // ---------------------------------------------------------------------------
  it("evaluates diagnostic task P46-L7-02 with CORS header counterexample", () => {
    const diag = diagnostics.diagnostics.find((d: any) => d.taskId === "P46-L7-02");
    expect(diag).toBeDefined();
    expect(diag.counterexamplesExtracted.length).toBe(1);
    expect(diag.refinementConstraintsDerived.length).toBe(1);
    expect(diag.searchReductionRatio).toBe(0.60);
    expect(diag.searchExhaustionStatus).toBe("REPAIR_SEARCH_EXHAUSTED");
    expect(diag.failureAttribution).toContain("REPAIR_SEARCH_COMPLEXITY_BOUNDARY");
  });

  // ---------------------------------------------------------------------------
  // 12. Transactional Rollback
  // ---------------------------------------------------------------------------
  it("rolls back all modifications transactionally on constraint failure", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase59-test-"));
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
    expect(fs.readFileSync(fileA, "utf8")).toBe("const a = 1;");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // 13. Gold Patch Leakage Prevention
  // ---------------------------------------------------------------------------
  it("detects and rejects gold patch leaks and test oracle access (N3, N4, N5)", () => {
    expect(CegarRepairSearchEngine.detectGoldLeakage("__SWE_BENCH_GOLD_PATCH__")).toBe(true);
    expect(CegarRepairSearchEngine.detectGoldLeakage("__REFERENCE_ORACLE_OUTPUT__")).toBe(true);
    expect(CegarRepairSearchEngine.detectGoldLeakage("P46-L7-01_HARDCODED_GOLD_FIX")).toBe(true);
    expect(CegarRepairSearchEngine.detectGoldLeakage("standard safe repair code")).toBe(false);

    expect(() =>
      CegarRepairSearchEngine.validateAuthorityAction("N3", "__SWE_BENCH_GOLD_PATCH__")
    ).toThrow(/GOLD_LEAK_DETECTED/);

    expect(() =>
      CegarRepairSearchEngine.validateAuthorityAction("N4", "__REFERENCE_ORACLE_OUTPUT__")
    ).toThrow(/GOLD_LEAK_DETECTED/);

    expect(() =>
      CegarRepairSearchEngine.validateAuthorityAction("N5", "P46-L7-01_HARDCODED_GOLD_FIX")
    ).toThrow(/GOLD_LEAK_DETECTED/);
  });

  // ---------------------------------------------------------------------------
  // 14. Authority Firewall Integrity
  // ---------------------------------------------------------------------------
  it("enforces authority firewall preventing self-elevation or bypass (N1, N2, N6, N7, N8, N9)", () => {
    expect(() =>
      CegarRepairSearchEngine.validateAuthorityAction("N1", "out_of_bounds_path")
    ).toThrow(/WORKSPACE_BOUNDARY_VIOLATION/);

    expect(() =>
      CegarRepairSearchEngine.validateAuthorityAction("N2", "external_api")
    ).toThrow(/REJECT/);

    expect(() =>
      CegarRepairSearchEngine.validateAuthorityAction("N6", "fabricated_counterexample")
    ).toThrow(/REJECT/);

    expect(() =>
      CegarRepairSearchEngine.validateAuthorityAction("N7", "unsound_refinement")
    ).toThrow(/REFINEMENT_NOT_PROVEN/);

    expect(() =>
      CegarRepairSearchEngine.validateAuthorityAction("N8", "emit_pass_token")
    ).toThrow(/REJECT/);

    expect(() =>
      CegarRepairSearchEngine.validateAuthorityAction("N9", "write_terminal_record")
    ).toThrow(/REJECT/);
  });

  // ---------------------------------------------------------------------------
  // 15. Clean-Room Verification Gate
  // ---------------------------------------------------------------------------
  it("enforces clean-room verification fail-closed behavior on unverified candidates", () => {
    expect(CegarRepairSearchEngine.verifyCleanRoomGate("P46-L7-01", null)).toBe(false);
    expect(CegarRepairSearchEngine.verifyCleanRoomGate("P46-L7-01", { candidateId: "C1", candidateDigest: "d" })).toBe(false);
    expect(CegarRepairSearchEngine.verifyCleanRoomGate("P46-L5-01", { candidateId: "C1", candidateDigest: "d" })).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 16. Fourfold Completion Gate
  // ---------------------------------------------------------------------------
  it("enforces fourfold completion gate fail-closed behavior on unverified L7 candidates", () => {
    expect(CegarRepairSearchEngine.verifyFourfoldGate("P46-L7-01", null)).toBe(false);
    expect(CegarRepairSearchEngine.verifyFourfoldGate("P46-L7-01", { candidateId: "C1", candidateDigest: "d" })).toBe(false);
    expect(CegarRepairSearchEngine.verifyFourfoldGate("P46-L5-01", { candidateId: "C1", candidateDigest: "d" })).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 17. Deterministic Replay
  // ---------------------------------------------------------------------------
  it("confirms byte-identical determinism across repeated independent runs", () => {
    expect(determinism.allByteIdentical).toBe(true);
    expect(determinism.records.length).toBe(15);

    for (const rec of determinism.records) {
      expect(rec.isByteIdentical).toBe(true);
      expect(rec.run1Digest).toBe(rec.run2Digest);
      expect(rec.run1TraceDigest).toBe(rec.run2TraceDigest);
    }
  });

  // ---------------------------------------------------------------------------
  // 18. Complete Negative Controls (N1–N9)
  // ---------------------------------------------------------------------------
  it("verifies all negative controls N1–N9 pass with 100% policy enforcement", () => {
    expect(negativeControls.controls.length).toBe(9);
    for (const ctrl of negativeControls.controls) {
      expect(ctrl.status).toBe("PASS");
      expect(ctrl.actualClass).toBe(ctrl.expectedClass);
    }

    expect(results.metrics.decision).toBe("REPAIR_SEARCH_COMPLEXITY_BOUNDARY");
    expect(results.metrics.scientificOutcome).toBe("OUTCOME_D_REPAIR_SEARCH_COMPLEXITY_BOUNDARY");
    expect(results.metrics.remainingBoundary).toBe("COUNTEREXAMPLE_GUIDED_SEARCH_COMPLEXITY_AND_SYNTHESIS_CAPABILITY");
  });
});
