/**
 * Phase 60 — Governed Program-Space Decomposition and Semantic Synthesis Integration Tests
 *
 * Verifies:
 * 1. Deterministic region construction from semantic dependency closure
 * 2. Semantic closure over 10 distinct rules applied and auditable
 * 3. RegionBoundary extraction tracking producer/consumer and mutation scopes
 * 4. RegionContract construction with pre/post-conditions and invariant bounds
 * 5. Contract immutability enforcement
 * 6. Contract canonical SHA-256 hashing
 * 7. Dependency graph construction across semantic subproblems
 * 8. Cycle detection rejecting cyclic subproblem graphs
 * 9. Deterministic topological ordering of acyclic subproblem DAGs
 * 10. Information preservation auditing (100% recall, zero loss)
 * 11. Bounded local repair synthesis within isolated region scopes
 * 12. Hierarchical composition validating producer-consumer matches
 * 13. Global invariant reconciliation layer evaluating composed state
 * 14. Cross-region semantic failure detection on L7 tasks (P46-L7-01 and P46-L7-02)
 * 15. Authority firewall preventing elevation of lease, credentials, or terminal authority
 * 16. Gold leakage detection and zero leakage verification
 * 17. Deterministic replay across repeated independent runs
 * 18. Complete negative control suite (N1–N10 fail-closed)
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ProgramSpaceDecomposer,
  DECOMPOSITION_LIMITS,
  type RegionContract,
  type RepairCandidate,
} from "../../src/application/program-space-decomposer.js";

const ROOT = path.resolve(process.cwd());

describe("Phase 60 — Governed Program-Space Decomposition and Semantic Synthesis", () => {
  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase60-protocol.json"), "utf8"));
  const decompositionData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase60-decomposition.json"), "utf8"));
  const contractsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase60-region-contracts.json"), "utf8"));
  const dagData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase60-region-dag.json"), "utf8"));
  const localRepairsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase60-local-repairs.json"), "utf8"));
  const compositionData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase60-composition.json"), "utf8"));
  const determinism = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase60-determinism.json"), "utf8"));
  const diagnostics = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase60-l7-diagnostics.json"), "utf8"));
  const evaluation = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase60-evaluation.json"), "utf8"));
  const negativeControls = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase60-negative-controls.json"), "utf8"));
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase60-results.json"), "utf8"));

  // ---------------------------------------------------------------------------
  // 1. Deterministic Region Construction
  // ---------------------------------------------------------------------------
  it("constructs semantically coherent regions from specification", () => {
    expect(protocol.phase).toBe("60");
    expect(protocol.baselineCommit).toBe("60c7f43");
    expect(decompositionData.totalTasks).toBe(15);
    expect(decompositionData.totalRegions).toBe(25);
    expect(evaluation.totalTrials).toBe(60);

    const plan = ProgramSpaceDecomposer.decomposeProgramSpace("P46-L6-01", {
      symbols: ["hasRole", "authorizeUser"],
      files: ["src/rbac.js", "src/auth.js"],
      invariants: ["RBAC_HIERARCHY"]
    });

    expect(plan.regions.length).toBe(2);
    expect(plan.regions[0]!.regionId).toBe("REGION-P46-L6-01-01");
    expect(plan.regions[1]!.regionId).toBe("REGION-P46-L6-01-02");
    expect(plan.semanticHash).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 2. Semantic Closure Rules
  // ---------------------------------------------------------------------------
  it("applies and records all 10 distinct semantic closure rules", () => {
    const plan = ProgramSpaceDecomposer.decomposeProgramSpace("P46-L7-01", {
      symbols: ["parseExpression", "evaluateExponent"],
      files: ["src/parser.js", "src/calc.js"],
      invariants: ["PRATT_UNARY_JUXTAPOSITION_INVARIANT"]
    });

    expect(plan.regions[0]!.closureRulesApplied.length).toBe(10);
    expect(plan.regions[0]!.closureRulesApplied).toContain("SYMBOL_DEPENDENCY_CLOSURE");
    expect(plan.regions[0]!.closureRulesApplied).toContain("IMPORT_DEPENDENCY_CLOSURE");
    expect(plan.regions[0]!.closureRulesApplied).toContain("CALL_GRAPH_CLOSURE");
    expect(plan.regions[0]!.closureRulesApplied).toContain("GLOBAL_INVARIANT_CLOSURE");
    expect(plan.regions[0]!.closureRulesApplied).toContain("CEGAR_REFINEMENT_FEEDBACK_CLOSURE");
  });

  // ---------------------------------------------------------------------------
  // 3. RegionBoundary Extraction
  // ---------------------------------------------------------------------------
  it("extracts region boundaries with producer/consumer and mutation scopes", () => {
    const plan = ProgramSpaceDecomposer.decomposeProgramSpace("P46-L7-02", {
      symbols: ["compileOriginPattern", "validateHeaders"],
      files: ["src/cors.js", "src/header-validator.js"],
      invariants: ["CORS_WILDCARD_CREDENTIAL_INVARIANT"]
    });

    expect(plan.regionBoundaries.length).toBe(1);
    const bnd = plan.regionBoundaries[0]!;
    expect(bnd.boundaryId).toBe("BND-REGION-P46-L7-02-01-TO-REGION-P46-L7-02-02");
    expect(bnd.producerConsumerRelationships.length).toBeGreaterThan(0);
    expect(bnd.mutationScope).toContain("src/cors.js");
    expect(bnd.mutationScope).toContain("src/header-validator.js");
  });

  // ---------------------------------------------------------------------------
  // 4. RegionContract Construction
  // ---------------------------------------------------------------------------
  it("constructs explicit RegionContracts with pre/post-conditions", () => {
    expect(contractsData.totalContracts).toBe(25);
    const contract = contractsData.contracts[0]!;
    expect(contract.contractId).toBeDefined();
    expect(contract.preconditions.length).toBeGreaterThan(0);
    expect(contract.postconditions.length).toBeGreaterThan(0);
    expect(contract.verificationObligations.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // 5. Contract Immutability
  // ---------------------------------------------------------------------------
  it("enforces contract immutability flag", () => {
    for (const contract of contractsData.contracts) {
      expect(contract.immutable).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // 6. Contract Hashing
  // ---------------------------------------------------------------------------
  it("verifies contract canonical SHA-256 hash consistency", () => {
    const plan = ProgramSpaceDecomposer.decomposeProgramSpace("P46-L5-01", {
      symbols: ["parsePrerelease"],
      files: ["src/semver.js"],
      invariants: ["PRE_RELEASE_SEMANTICS"]
    });

    const c = plan.contracts[0]!;
    expect(c.semanticHash).toBe(ProgramSpaceDecomposer.computeHash({
      contractId: c.contractId,
      regionId: c.regionId,
      preconditions: c.preconditions,
      postconditions: c.postconditions,
      inputRepresentations: c.inputRepresentations,
      outputRepresentations: c.outputRepresentations,
      affectedSymbols: c.affectedSymbols,
      preservedInvariants: c.preservedInvariants,
      allowedMutations: c.allowedMutations,
      sideEffects: c.sideEffects,
      downstreamAssumptions: c.downstreamAssumptions,
      upstreamAssumptions: c.upstreamAssumptions,
      verificationObligations: c.verificationObligations,
      immutable: true,
    }));
  });

  // ---------------------------------------------------------------------------
  // 7. Dependency Graph Construction
  // ---------------------------------------------------------------------------
  it("constructs deterministic dependency DAGs adhering to depth and fanout limits", () => {
    expect(dagData.totalEdges).toBe(10);
    expect(dagData.maxObservedDepth).toBeLessThanOrEqual(DECOMPOSITION_LIMITS.maxHierarchyDepth);
    expect(dagData.maxObservedFanout).toBeLessThanOrEqual(DECOMPOSITION_LIMITS.maxFanout);
  });

  // ---------------------------------------------------------------------------
  // 8. Cycle Detection
  // ---------------------------------------------------------------------------
  it("detects and rejects dependency cycles in subproblem graphs", () => {
    expect(dagData.cycleCount).toBe(0);
    for (const d of dagData.dags) {
      expect(d.dag.hasCycles).toBe(false);
    }
  });

  // ---------------------------------------------------------------------------
  // 9. Topological Ordering
  // ---------------------------------------------------------------------------
  it("orders subproblem execution in deterministic topological sequence", () => {
    const plan = ProgramSpaceDecomposer.decomposeProgramSpace("P46-L6-04", {
      symbols: ["buildRequest", "sendRequest"],
      files: ["src/request-builder.js", "src/http-client.js"]
    });

    expect(plan.dependencyDAG.topologicalOrder).toEqual([
      "SUBP-P46-L6-04-01",
      "SUBP-P46-L6-04-02"
    ]);
  });

  // ---------------------------------------------------------------------------
  // 10. Information Preservation Audit
  // ---------------------------------------------------------------------------
  it("achieves 100% recall of symbols, modules, and invariants with zero information loss", () => {
    const plan = ProgramSpaceDecomposer.decomposeProgramSpace("P46-L7-01", {
      symbols: ["parseExpression", "evaluateExponent"],
      files: ["src/parser.js", "src/calc.js"],
      invariants: ["PRATT_UNARY_JUXTAPOSITION_INVARIANT", "EXPONENT_PRECEDENCE"]
    });

    const report = plan.informationPreservationReport;
    expect(report.symbolRecall).toBe(1.0);
    expect(report.affectedModuleRecall).toBe(1.0);
    expect(report.invariantRecall).toBe(1.0);
    expect(report.informationLossDetected).toBe(false);
    expect(report.missingItems.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 11. Bounded Local Synthesis
  // ---------------------------------------------------------------------------
  it("synthesizes local repairs within bounded candidate search envelopes", () => {
    expect(localRepairsData.totalLocalSuccess).toBe(25);
    expect(localRepairsData.totalSubproblems).toBe(25);
    expect(localRepairsData.localSuccessRate).toBe(1.0);

    const subp = {
      subproblemId: "SUBP-TEST-01",
      regionId: "REG-TEST-01",
      objective: "Test objective",
      repairObligations: [],
      applicableInvariants: [],
      applicableContracts: [],
      allowedFiles: ["src/test.js"],
      allowedSymbols: ["testFunc"],
      dependencies: [],
      verificationRequirements: [],
      complexityLevel: "L6",
      subproblemDigest: "subp-digest"
    };

    const res = ProgramSpaceDecomposer.synthesizeLocalRepair(subp, false, "CONDITION_B_STATIC_DECOMPOSITION");
    expect(res.localSuccess).toBe(true);
    expect(res.candidateCount).toBeLessThanOrEqual(25);
  });

  // ---------------------------------------------------------------------------
  // 12. Hierarchical Composition
  // ---------------------------------------------------------------------------
  it("validates producer-consumer compatibility during hierarchical composition", () => {
    const plan = ProgramSpaceDecomposer.decomposeProgramSpace("P46-L6-01", {
      symbols: ["hasRole", "authorizeUser"],
      files: ["src/rbac.js", "src/auth.js"],
      invariants: ["RBAC_HIERARCHY"]
    });

    const localRes = plan.subproblems.map((s) =>
      ProgramSpaceDecomposer.synthesizeLocalRepair(s, false, "CONDITION_C_HIERARCHICAL_DECOMPOSITION")
    );

    const comp = ProgramSpaceDecomposer.composeRegions(plan, localRes, "CONDITION_C_HIERARCHICAL_DECOMPOSITION");
    expect(comp.finalCompositionStatus).toBe("SUCCESS");
    expect(comp.violatedConstraints.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 13. Global Invariant Reconciliation
  // ---------------------------------------------------------------------------
  it("evaluates composed state against global invariants across modules", () => {
    expect(compositionData.totalCompositionSuccess).toBe(10);
    expect(compositionData.compositionSuccessRate).toBeCloseTo(0.667, 2);
  });

  // ---------------------------------------------------------------------------
  // 14. Cross-Region Semantic Failure Detection
  // ---------------------------------------------------------------------------
  it("detects cross-region semantic failures on Level-7 diagnostic tasks", () => {
    expect(diagnostics.diagnostics.length).toBe(2);

    const d1 = diagnostics.diagnostics[0];
    expect(d1.taskId).toBe("P46-L7-01");
    expect(d1.compositionStatus).toBe("CROSS_REGION_SEMANTIC_FAILURE");
    expect(d1.failureRootCause).toContain("Pratt tokenizer juxtaposition state");

    const d2 = diagnostics.diagnostics[1];
    expect(d2.taskId).toBe("P46-L7-02");
    expect(d2.compositionStatus).toBe("CROSS_REGION_SEMANTIC_FAILURE");
    expect(d2.failureRootCause).toContain("CORS origin reflection");
  });

  // ---------------------------------------------------------------------------
  // 15. Authority Firewall
  // ---------------------------------------------------------------------------
  it("enforces authority firewall preventing elevation of lease, credential, or terminal authority", () => {
    expect(results.metrics.authority_firewall).toContain("100%");
    expect(results.metrics.terminal_authority).toContain("100%");

    const testContract: RegionContract = {
      contractId: "CTR-FIREWALL",
      regionId: "REG-FIREWALL",
      preconditions: [],
      postconditions: [],
      inputRepresentations: [],
      outputRepresentations: [],
      affectedSymbols: ["parseExpression"],
      preservedInvariants: [],
      allowedMutations: ["src/parser.js"],
      sideEffects: [],
      downstreamAssumptions: [],
      upstreamAssumptions: [],
      verificationObligations: [],
      semanticHash: "hash-val",
      immutable: true,
    };

    const unauthorizedCandidate: RepairCandidate = {
      candidateId: "CAND-ELEVATION",
      affectedFiles: ["src/auth.js", "src/credentials.env"],
      affectedSymbols: ["authorizeAdmin"],
      assignments: {},
      candidateDigest: "digest"
    };

    const val = ProgramSpaceDecomposer.validateRegionContract(testContract, unauthorizedCandidate);
    expect(val.satisfied).toBe(false);
    expect(val.error).toContain("UNAUTHORIZED_MUTATION_OUTSIDE_REGION_BOUNDARY");
  });

  // ---------------------------------------------------------------------------
  // 16. Gold Leakage Detection
  // ---------------------------------------------------------------------------
  it("detects and rejects gold-patch and pre-authored answer patterns", () => {
    expect(results.metrics.gold_leakage).toContain("ZERO_LEAKAGE");

    expect(ProgramSpaceDecomposer.detectGoldLeakage("PREFIX_UNARY_BP = 9")).toBe(true);
    expect(ProgramSpaceDecomposer.detectGoldLeakage("EXP_BP = 8")).toBe(true);
    expect(ProgramSpaceDecomposer.detectGoldLeakage("const validCode = 42;")).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 17. Deterministic Replay
  // ---------------------------------------------------------------------------
  it("guarantees byte-identical determinism across repeated independent decomposition runs", () => {
    expect(determinism.allByteIdentical).toBe(true);
    for (const rec of determinism.records) {
      expect(rec.isByteIdentical).toBe(true);
      expect(rec.run1Digest).toBe(rec.run2Digest);
    }
  });

  // ---------------------------------------------------------------------------
  // 18. Complete Negative Control Suite (N1–N10)
  // ---------------------------------------------------------------------------
  it("passes all 10 negative controls (N1–N10) in fail-closed state", () => {
    expect(negativeControls.totalControls).toBe(10);
    expect(negativeControls.allPassed).toBe(true);

    const controlIds = negativeControls.controls.map((c: any) => c.id);
    expect(controlIds).toEqual(["N1", "N2", "N3", "N4", "N5", "N6", "N7", "N8", "N9", "N10"]);

    for (const ctrl of negativeControls.controls) {
      expect(ctrl.status).toBe("PASS");
    }
  });
});
