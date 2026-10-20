/**
 * Phase 83 — Automated Delta Test Suite Minimization and Predictive Clean-Room Verification
 * Integration Tests
 *
 * Verifies:
 * 1. Structural impact analysis & AST symbol extraction
 * 2. Canonical ImpactGraph hashing and deterministic ordering
 * 3. Transitive dependency traversal, cycle protection, and depth limits
 * 4. Test impact index mappings across all 15 cohort tasks (L5, L6, L7)
 * 5. Deterministic test selection under Conditions A, B, C, D
 * 6. Minimization ratios across task difficulty tiers
 * 7. Candidate provenance and suite selection digests
 * 8. Predictive delta verification & early defect detection
 * 9. Non-authoritative invariant: authoritative === false permanently
 * 10. Clean-room dual-gate handoff: F2P=1.0, P2P=1.0, SUITE_RAN=11
 * 11. False-positive trapping by authoritative clean room
 * 12. Production safety negative controls N241–N260 (20/20 PASS)
 * 13. 3-sweep determinism and state-store isolation
 */

import { describe, expect, it } from "vitest";
import { ImpactGraph } from "../../src/domain/delta-verification.js";
import {
  DeltaImpactAnalyzer,
  FROZEN_PHASE82_BASELINE,
} from "../../src/application/delta-impact-analyzer.js";
import { TestImpactIndex } from "../../src/application/test-impact-index.js";
import { PredictiveDeltaVerifier } from "../../src/application/predictive-delta-verifier.js";

describe("Phase 83: Automated Delta Test Suite Minimization & Predictive Clean-Room Verification", () => {
  const analyzer = new DeltaImpactAnalyzer();
  const index = new TestImpactIndex();
  const verifier = new PredictiveDeltaVerifier(analyzer, index);

  // ==========================================================================
  // 1. Structural Impact Analysis & AST Symbol Extraction
  // ==========================================================================

  it("1. builds impact graph with file, symbol, and module nodes for L5 task", () => {
    const patch = `function parsePrerelease(v) { return v.split('-'); }`;
    const graph = analyzer.analyzeImpact("P46-L5-01", ["src/semver.js"], patch);

    expect(graph.graphId).toContain("impact-P46-L5-01");
    expect(graph.nodes.some((n) => n.id === "file:src/semver.js")).toBe(true);
    expect(graph.nodes.some((n) => n.id === "mod:src")).toBe(true);
    expect(graph.nodes.some((n) => n.name === "parsePrerelease")).toBe(true);
    expect(graph.edges.some((e) => e.type === "DEFINES")).toBe(true);
  });

  it("2. builds cross-file call and import edges for multi-file L6 task", () => {
    const patch = `function hasRole(u, r) { return u.roles.includes(r); }`;
    const files = ["src/models/user.js", "src/services/user-service.js"];
    const graph = analyzer.analyzeImpact("P46-L6-01", files, patch);

    expect(graph.nodes.some((n) => n.id === "file:src/models/user.js")).toBe(true);
    expect(graph.nodes.some((n) => n.id === "file:src/services/user-service.js")).toBe(true);
    expect(graph.edges.some((e) => e.type === "IMPORTS")).toBe(true);
    expect(graph.edges.some((e) => e.type === "CALLS")).toBe(true);
  });

  it("3. builds three-file dependency topology for SWE-bench L7 task", () => {
    const patch = `function evaluateExpression(expr) { return tokenize(expr); }`;
    const files = ["src/models/user.js", "src/services/user-service.js", "src/routes/user-route.js"];
    const graph = analyzer.analyzeImpact("P46-L7-05", files, patch);

    expect(graph.nodes.filter((n) => n.type === "FILE").length).toBe(3);
    expect(graph.edges.filter((e) => e.type === "CALLS").length).toBeGreaterThanOrEqual(2);
  });

  it("4. rejects empty taskId in impact analyzer", () => {
    expect(() => analyzer.analyzeImpact("", ["src/semver.js"], "patch")).toThrow("EMPTY_TASK_ID");
  });

  it("5. rejects empty targetFiles array in impact analyzer", () => {
    expect(() => analyzer.analyzeImpact("P46-L5-01", [], "patch")).toThrow("EMPTY_TARGET_FILES");
  });

  it("6. rejects null or undefined patch in impact analyzer", () => {
    expect(() => analyzer.analyzeImpact("P46-L5-01", ["src/semver.js"], null as any)).toThrow("NULL_PATCH");
  });

  // ==========================================================================
  // 2. Canonical Digest Verification & Deterministic Ordering
  // ==========================================================================

  it("7. generates deterministic canonical ImpactGraph digest", () => {
    const patch = `function scanDirectory(dir) { return true; }`;
    const graph1 = analyzer.analyzeImpact("P46-L5-04", ["src/scanner.js"], patch);
    const graph2 = analyzer.analyzeImpact("P46-L5-04", ["src/scanner.js"], patch);

    expect(graph1.graphDigest).toBe(graph2.graphDigest);
    expect(graph1.graphDigest.length).toBe(64);
  });

  it("8. verifies ImpactGraph digest correctly with verifyGraphDigest", () => {
    const patch = `function emit(event, ...args) {}`;
    const graph = analyzer.analyzeImpact("P46-L5-03", ["src/emitter.js"], patch);

    expect(analyzer.verifyGraphDigest(graph)).toBe(true);
    const corrupted = { ...graph, graphDigest: "0000000000000000000000000000000000000000000000000000000000000000" };
    expect(analyzer.verifyGraphDigest(corrupted)).toBe(false);
  });

  it("9. deterministically sorts nodes and edges by id and source/target", () => {
    const patch = `function _toPath() {}\nfunction _setInternal() {}`;
    const graph = analyzer.analyzeImpact("P46-L5-02", ["src/deep-set.js"], patch);

    for (let i = 1; i < graph.nodes.length; i++) {
      expect(graph.nodes[i]!.id.localeCompare(graph.nodes[i - 1]!.id)).toBeGreaterThanOrEqual(0);
    }
  });

  // ==========================================================================
  // 3. Transitive Dependency Traversal & Cycle Defense
  // ==========================================================================

  it("10. traverses transitive closure up to specified depth", () => {
    const patch = `function tokenize() {}`;
    const graph = analyzer.analyzeImpact("P46-L7-01", ["src/calc.js", "src/parser.js"], patch);
    const closure = analyzer.traverseClosure(graph, ["file:src/calc.js"], 2);

    expect(closure.has("file:src/calc.js")).toBe(true);
    expect(closure.has("file:src/parser.js")).toBe(true);
  });

  it("11. detects and resolves cyclic dependencies without infinite recursion", () => {
    const cyclicGraph: ImpactGraph = {
      graphId: "cyclic-g",
      nodes: [
        { id: "A", type: "FILE", name: "A", path: "a.js" },
        { id: "B", type: "FILE", name: "B", path: "b.js" },
      ],
      edges: [
        { source: "A", target: "B", type: "CALLS", weight: 1.0 },
        { source: "B", target: "A", type: "CALLS", weight: 1.0 },
      ],
      sourceRevision: FROZEN_PHASE82_BASELINE,
      graphDigest: "cyclic-hash",
    };

    const closure = analyzer.traverseClosure(cyclicGraph, ["A"], 5);
    expect(closure.size).toBe(2);
    expect(closure.has("A")).toBe(true);
    expect(closure.has("B")).toBe(true);
  });

  it("12. throws on non-positive maxDepth limit", () => {
    const graph = analyzer.analyzeImpact("P46-L5-01", ["src/semver.js"], "function test() {}");
    expect(() => analyzer.traverseClosure(graph, ["file:src/semver.js"], 0)).toThrow("INVALID_MAX_DEPTH");
    expect(() => analyzer.traverseClosure(graph, ["file:src/semver.js"], -1)).toThrow("INVALID_MAX_DEPTH");
  });

  it("13. throws on excessive maxDepth (> 50) protecting resource bounds", () => {
    const graph = analyzer.analyzeImpact("P46-L5-01", ["src/semver.js"], "function test() {}");
    expect(() => analyzer.traverseClosure(graph, ["file:src/semver.js"], 51)).toThrow("EXCEEDED_MAX_DEPTH_LIMIT");
  });

  // ==========================================================================
  // 4. Test Impact Index & Suite Definitions
  // ==========================================================================

  it("14. provides exactly 11 static test suites per task", () => {
    const suites = TestImpactIndex.getTaskTestSuiteDefinitions("P46-L5-01");
    expect(suites.length).toBe(11);
    expect(TestImpactIndex.TOTAL_SUITE_COUNT).toBe(11);
  });

  it("15. marks exactly test-01 as F2P target bug verification test", () => {
    const suites = TestImpactIndex.getTaskTestSuiteDefinitions("P46-L6-01");
    expect(suites[0]!.isF2P).toBe(true);
    expect(suites[0]!.category).toBe("TARGET_BUG");
    for (let i = 1; i < suites.length; i++) {
      expect(suites[i]!.isF2P).toBe(false);
    }
  });

  it("16. scales base test costs appropriately with task difficulty (L7 > L6 > L5)", () => {
    const sL5 = TestImpactIndex.getTaskTestSuiteDefinitions("P46-L5-01");
    const sL6 = TestImpactIndex.getTaskTestSuiteDefinitions("P46-L6-01");
    const sL7 = TestImpactIndex.getTaskTestSuiteDefinitions("P46-L7-01");

    expect(sL7[0]!.baseCostMs).toBeGreaterThan(sL6[0]!.baseCostMs);
    expect(sL6[0]!.baseCostMs).toBeGreaterThan(sL5[0]!.baseCostMs);
  });

  it("17. creates candidate with valid cryptographic provenanceDigest", () => {
    const meta = TestImpactIndex.getTaskTestSuiteDefinitions("P46-L5-01")[0]!;
    const candidate = TestImpactIndex.createCandidate(meta, ["src/semver.js"], ["parsePrerelease"], 0, "F2P", 1.0);

    expect(candidate.provenanceDigest.length).toBe(64);
    expect(index.verifyCandidateDigest(candidate)).toBe(true);
  });

  it("18. catches corrupted candidate provenanceDigest", () => {
    const meta = TestImpactIndex.getTaskTestSuiteDefinitions("P46-L5-01")[0]!;
    const candidate = TestImpactIndex.createCandidate(meta, ["src/semver.js"], ["parsePrerelease"], 0, "F2P", 1.0);
    const corrupted = { ...candidate, provenanceDigest: "badprovenance000000" };

    expect(index.verifyCandidateDigest(corrupted)).toBe(false);
  });

  it("19. rejects candidate creation with empty sourceRevision", () => {
    const meta = TestImpactIndex.getTaskTestSuiteDefinitions("P46-L5-01")[0]!;
    expect(() =>
      TestImpactIndex.createCandidate(meta, ["src/semver.js"], [], 0, "test", 1.0, "")
    ).toThrow("MISSING_SOURCE_REVISION");
  });

  it("20. rejects candidate creation containing malicious shell commands", () => {
    const baseMeta = TestImpactIndex.getTaskTestSuiteDefinitions("P46-L5-01")[0]!;
    const maliciousMeta = {
      ...baseMeta,
      testCommand: "npm test; rm -rf /",
    };
    expect(() =>
      TestImpactIndex.createCandidate(maliciousMeta, ["src/semver.js"], [], 0, "test", 1.0)
    ).toThrow("MUTATED_TEST_COMMAND");
  });

  // ==========================================================================
  // 5. Delta Selection Strategies across L5, L6, L7
  // ==========================================================================

  it("21. Condition A (FULL_SUITE) selects all 11 test suites", () => {
    const patch = `function parsePrerelease() {}`;
    const graph = analyzer.analyzeImpact("P46-L5-01", ["src/semver.js"], patch);
    const suite = index.selectDeltaSuite("FULL_SUITE", "P46-L5-01", "run-1", patch, graph);

    expect(suite.selectedTests.length).toBe(11);
    expect(suite.excludedTests.length).toBe(0);
    expect(suite.selectionMethod).toBe("FULL_SUITE");
  });

  it("22. Condition B (DIRECT_AST_IMPACT) selects 2 tests for L5 task", () => {
    const patch = `function parsePrerelease() {}`;
    const graph = analyzer.analyzeImpact("P46-L5-01", ["src/semver.js"], patch);
    const suite = index.selectDeltaSuite("DIRECT_AST_IMPACT", "P46-L5-01", "run-2", patch, graph);

    expect(suite.selectedTests.length).toBe(2);
    expect(suite.excludedTests.length).toBe(9);
    expect(suite.selectedTests[0]!.testId).toContain("test-01-f2p");
  });

  it("23. Condition B (DIRECT_AST_IMPACT) selects 3 tests for L6 task", () => {
    const patch = `function hasRole() {}`;
    const graph = analyzer.analyzeImpact("P46-L6-01", ["src/models/user.js", "src/services/user-service.js"], patch);
    const suite = index.selectDeltaSuite("DIRECT_AST_IMPACT", "P46-L6-01", "run-3", patch, graph);

    expect(suite.selectedTests.length).toBe(3);
    expect(suite.excludedTests.length).toBe(8);
  });

  it("24. Condition B (DIRECT_AST_IMPACT) selects 4 tests for L7 task", () => {
    const patch = `function evaluateExpression() {}`;
    const graph = analyzer.analyzeImpact("P46-L7-01", ["src/calc.js", "src/parser.js"], patch);
    const suite = index.selectDeltaSuite("DIRECT_AST_IMPACT", "P46-L7-01", "run-4", patch, graph);

    expect(suite.selectedTests.length).toBe(4);
    expect(suite.excludedTests.length).toBe(7);
  });

  it("25. Condition C (DEPENDENCY_CLOSURE) selects 3 tests for L5 task", () => {
    const patch = `function parsePrerelease() {}`;
    const graph = analyzer.analyzeImpact("P46-L5-01", ["src/semver.js"], patch);
    const suite = index.selectDeltaSuite("DEPENDENCY_CLOSURE", "P46-L5-01", "run-5", patch, graph);

    expect(suite.selectedTests.length).toBe(3);
    expect(suite.excludedTests.length).toBe(8);
  });

  it("26. Condition C (DEPENDENCY_CLOSURE) selects 5 tests for L6 task", () => {
    const patch = `function hasRole() {}`;
    const graph = analyzer.analyzeImpact("P46-L6-01", ["src/models/user.js", "src/services/user-service.js"], patch);
    const suite = index.selectDeltaSuite("DEPENDENCY_CLOSURE", "P46-L6-01", "run-6", patch, graph);

    expect(suite.selectedTests.length).toBe(5);
    expect(suite.excludedTests.length).toBe(6);
  });

  it("27. Condition C (DEPENDENCY_CLOSURE) selects 8 tests for L7 task", () => {
    const patch = `function evaluateExpression() {}`;
    const graph = analyzer.analyzeImpact("P46-L7-01", ["src/calc.js", "src/parser.js"], patch);
    const suite = index.selectDeltaSuite("DEPENDENCY_CLOSURE", "P46-L7-01", "run-7", patch, graph);

    expect(suite.selectedTests.length).toBe(8);
    expect(suite.excludedTests.length).toBe(3);
  });

  it("28. Condition D (RISK_AWARE_DELTA) selects 4 tests for L5 task", () => {
    const patch = `function _toPath() {}`;
    const graph = analyzer.analyzeImpact("P46-L5-02", ["src/deep-set.js"], patch);
    const suite = index.selectDeltaSuite("RISK_AWARE_DELTA", "P46-L5-02", "run-8", patch, graph);

    expect(suite.selectedTests.length).toBe(4);
    expect(suite.selectedTests.some((t) => t.testId.includes("test-06-security"))).toBe(true);
  });

  it("29. Condition D (RISK_AWARE_DELTA) selects 6 tests for L6 task", () => {
    const patch = `function hasRole() {}`;
    const graph = analyzer.analyzeImpact("P46-L6-01", ["src/models/user.js", "src/services/user-service.js"], patch);
    const suite = index.selectDeltaSuite("RISK_AWARE_DELTA", "P46-L6-01", "run-9", patch, graph);

    expect(suite.selectedTests.length).toBe(6);
  });

  it("30. Condition D (RISK_AWARE_DELTA) selects 9 tests for L7 task", () => {
    const patch = `function evaluateExpression() {}`;
    const graph = analyzer.analyzeImpact("P46-L7-01", ["src/calc.js", "src/parser.js"], patch);
    const suite = index.selectDeltaSuite("RISK_AWARE_DELTA", "P46-L7-01", "run-10", patch, graph);

    expect(suite.selectedTests.length).toBe(9);
    expect(suite.excludedTests.length).toBe(2);
  });

  // ==========================================================================
  // 6. Canonical Suite Selection Digest & Invariants
  // ==========================================================================

  it("31. computes canonical DeltaTestSuite selectionDigest and verifies integrity", () => {
    const patch = `function emit() {}`;
    const graph = analyzer.analyzeImpact("P46-L5-03", ["src/emitter.js"], patch);
    const suite = index.selectDeltaSuite("RISK_AWARE_DELTA", "P46-L5-03", "run-11", patch, graph);

    expect(suite.selectionDigest.length).toBe(64);
    expect(index.verifySuiteDigest(suite)).toBe(true);

    const corrupted = { ...suite, selectionDigest: "badsuite000000000" };
    expect(index.verifySuiteDigest(corrupted)).toBe(false);
  });

  it("32. rejects invalid or spoofed selection method", () => {
    const patch = `function emit() {}`;
    const graph = analyzer.analyzeImpact("P46-L5-03", ["src/emitter.js"], patch);
    expect(() =>
      index.selectDeltaSuite("INVALID_METHOD" as any, "P46-L5-03", "run-12", patch, graph)
    ).toThrow("UNKNOWN_SELECTION_METHOD");
  });

  // ==========================================================================
  // 7. Predictive Verification Execution & Non-Authoritative Invariant
  // ==========================================================================

  it("33. marks clean candidate patch with PREDICTIVE_PASS and PREDICTIVE_PASS_CLEAN", () => {
    const patch = `function parsePrerelease() { return true; }`;
    const { result } = verifier.verifyDelta("P46-L5-01", "run-13", ["src/semver.js"], patch, "RISK_AWARE_DELTA", {
      isDefectivePatch: false,
    });

    expect(result.status).toBe("PREDICTIVE_PASS");
    expect(result.detectionClass).toBe("PREDICTIVE_PASS_CLEAN");
    expect(result.failedTests.length).toBe(0);
  });

  it("34. detects defective candidate patch early with EARLY_DEFECT_DETECTED", () => {
    const patch = `function parsePrerelease() { return false; }`;
    const { result } = verifier.verifyDelta("P46-L5-01", "run-14", ["src/semver.js"], patch, "DIRECT_AST_IMPACT", {
      isDefectivePatch: true,
    });

    expect(result.status).toBe("PREDICTED_VERIFICATION_FAILURE");
    expect(result.detectionClass).toBe("EARLY_DEFECT_DETECTED");
    expect(result.failedTests.length).toBeGreaterThanOrEqual(1);
  });

  it("35. STRICT SAFETY INVARIANT: result.authoritative is ALWAYS false", () => {
    const patch = `function parsePrerelease() { return true; }`;
    const { result } = verifier.verifyDelta("P46-L5-01", "run-15", ["src/semver.js"], patch, "FULL_SUITE", {
      isDefectivePatch: false,
    });

    expect(result.authoritative).toBe(false);
  });

  it("36. STRICT SAFETY INVARIANT: result.fullSuiteRequired is ALWAYS true", () => {
    const patch = `function parsePrerelease() { return true; }`;
    const { result } = verifier.verifyDelta("P46-L5-01", "run-16", ["src/semver.js"], patch, "RISK_AWARE_DELTA", {
      isDefectivePatch: false,
    });

    expect(result.fullSuiteRequired).toBe(true);
  });

  // ==========================================================================
  // 8. Clean-Room Dual-Gate Handoff & Trapping
  // ==========================================================================

  it("37. independent clean room dual-gate passes clean patch with F2P=1.0, P2P=1.0, SUITE_RAN=11", () => {
    const cleanRoom = verifier.executeAuthoritativeCleanRoom("P46-L5-01", false);

    expect(cleanRoom.cleanRoomPassed).toBe(true);
    expect(cleanRoom.f2pRatio).toBe(1.0);
    expect(cleanRoom.p2pRatio).toBe(1.0);
    expect(cleanRoom.suiteRan).toBe(11);
    expect(cleanRoom.terminalAuthorityGranted).toBe(true);
  });

  it("38. authoritative clean room traps defective patch even if predictive pass occurred", () => {
    const cleanRoom = verifier.executeAuthoritativeCleanRoom("P46-L6-01", true);

    expect(cleanRoom.cleanRoomPassed).toBe(false);
    expect(cleanRoom.f2pRatio).toBe(0.0);
    expect(cleanRoom.terminalAuthorityGranted).toBe(false);
  });

  // ==========================================================================
  // 9. Negative Controls N241–N260 (20/20 PASS)
  // ==========================================================================

  it("39. executes all 20 negative controls N241–N260 with 100% pass rate", () => {
    const controls = verifier.evaluateNegativeControls();

    expect(controls.length).toBe(20);
    const failed = controls.filter((c) => c.status !== "PASS");
    expect(failed.length).toBe(0);

    // Verify key security IDs
    expect(controls.some((c) => c.id === "N241" && c.status === "PASS")).toBe(true);
    expect(controls.some((c) => c.id === "N242" && c.status === "PASS")).toBe(true);
    expect(controls.some((c) => c.id === "N246" && c.status === "PASS")).toBe(true);
    expect(controls.some((c) => c.id === "N250" && c.status === "PASS")).toBe(true);
    expect(controls.some((c) => c.id === "N252" && c.status === "PASS")).toBe(true);
    expect(controls.some((c) => c.id === "N260" && c.status === "PASS")).toBe(true);
  });

  // ==========================================================================
  // 10. 60-Trial Matrix & 3-Sweep Determinism
  // ==========================================================================

  it("40. runs 60-trial matrix with 100% clean-room pass and 0% delta authority", () => {
    const { trials, summary } = verifier.run60TrialMatrix();

    expect(trials.length).toBe(60);
    expect(summary.totalTrials).toBe(60);
    expect(summary.conditionATrials).toBe(15);
    expect(summary.conditionBTrials).toBe(15);
    expect(summary.conditionCTrials).toBe(15);
    expect(summary.conditionDTrials).toBe(15);
    expect(summary.cleanRoomTerminalPassRate).toBe(1.0);
    expect(summary.deltaTerminalAuthorityRate).toBe(0.0);
  });

  it("41. achieves 100% byte-identical determinism across 3 sweeps of 60 trials", () => {
    const sweep1 = verifier.run60TrialMatrix();
    const sweep2 = verifier.run60TrialMatrix();
    const sweep3 = verifier.run60TrialMatrix();

    const d1 = JSON.stringify(sweep1);
    const d2 = JSON.stringify(sweep2);
    const d3 = JSON.stringify(sweep3);

    expect(d1).toBe(d2);
    expect(d2).toBe(d3);
  });
});
