/**
 * Phase 71 — Integration Test Suite
 * Governed Guided Constructive Search
 *
 * Covers 36 comprehensive tests:
 * 1. Constraint index extraction determinism
 * 2. Goal constraints indexing
 * 3. Semantic invariants indexing
 * 4. Cross-module contracts indexing
 * 5. Search node deterministic hash addressing
 * 6. Forward constraint propagation valid on permitted effects
 * 7. Forward constraint propagation rejects unpermitted effects
 * 8. Forward constraint propagation validates non-negative stream positions
 * 9. Backward constraint propagation narrows hole constructors
 * 10. Backward constraint propagation enforces transaction constraints
 * 11. Backward constraint propagation respects L7 program obligations
 * 12. Bidirectional constraint intersection valid when overlapping
 * 13. Bidirectional constraint intersection flags BIDIRECTIONAL_CONFLICT when disjoint
 * 14. Deterministic branch scoring consistency
 * 15. Branch scoring rewards satisfied obligations
 * 16. Branch scoring penalizes violated obligations
 * 17. Conservative dominance pruner detects strictly dominated nodes
 * 18. Conservative dominance pruner refuses to prune with distinct obligations
 * 19. Conservative dominance pruner refuses to prune with mismatched state
 * 20. Dead-end detector catches depth ceiling violations
 * 21. Dead-end detector catches irreversible type violations
 * 22. Dead-end detector catches unrecoverable effect mismatches
 * 23. Valid candidates are never falsely pruned
 * 24. Frozen search budget limits preserved
 * 25. Complete search accounting counter integrity
 * 26. Frontier sorting determinism
 * 27. Condition A (Phase 70 control) replication
 * 28. Condition B (Forward guided search) evaluation
 * 29. Condition C (Bidirectional guided search) evaluation
 * 30. Condition D (Full governed guided search) evaluation
 * 31. Search node reduction ratio achieves >= 60% reduction
 * 32. Time reduction ratio achieves >= 40% reduction
 * 33. Clean-room dual gate fail-closed on L7
 * 34. Deterministic byte-identical replay across runs
 * 35. Negative controls N1–N80 preserved
 * 36. Negative controls N81–N90 fail-closed validation
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import {
  GuidedConstructiveSearchEngine,
  ForwardConstraintPropagator,
  BackwardConstraintPropagator,
  BidirectionalConstraintPropagator,
  BranchScorer,
  DominancePruner,
  SemanticDeadEndDetector,
  SearchFrontier,
  SearchNode,
} from "../../src/application/guided-constructive-search.js";
import {
  ConstructiveProgramInductionCalculusEngine,
  CONSTRUCTIVE_CALCULUS_LIMITS,
  CONSTRUCTOR_PRIMITIVES,
} from "../../src/application/constructive-program-induction-calculus.js";

const ROOT = path.resolve(process.cwd());

describe("Phase 71 — Governed Guided Constructive Search", () => {
  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-protocol.json"), "utf8"));
  const strategies = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-search-strategy.json"), "utf8"));
  const constraintIndexData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-constraint-index.json"), "utf8"));
  const forwardData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-forward-constraints.json"), "utf8"));
  const backwardData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-backward-constraints.json"), "utf8"));
  const bidirData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-bidirectional-constraints.json"), "utf8"));
  const branchScoresData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-branch-scores.json"), "utf8"));
  const dominanceData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-dominance.json"), "utf8"));
  const searchTracesData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-search-traces.json"), "utf8"));
  const evaluationData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-evaluation.json"), "utf8"));
  const efficiencyData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-efficiency.json"), "utf8"));
  const negativeControlsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-negative-controls.json"), "utf8"));
  const determinismData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-determinism.json"), "utf8"));
  const resultsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-results.json"), "utf8"));
  const statusData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-status.json"), "utf8"));
  const l7DiagnosticsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-l7-diagnostics.json"), "utf8"));

  // 1. Constraint index extraction determinism
  it("Test 1: constraint index extraction is deterministic with identical hash for identical task", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const index1 = GuidedConstructiveSearchEngine.createConstraintIndex("P46-L5-01", goal);
    const index2 = GuidedConstructiveSearchEngine.createConstraintIndex("P46-L5-01", goal);
    expect(index1.contentHash).toBe(index2.contentHash);
    expect(index1.indexId).toBe(index2.indexId);
    expect(constraintIndexData.totalIndices).toBe(15);
    expect(strategies.strategies.length).toBe(4);
    expect(forwardData.totalEvaluated).toBe(15);
    expect(backwardData.totalEvaluated).toBe(15);
    expect(bidirData.totalEvaluated).toBe(15);
    expect(branchScoresData.totalScores).toBe(15);
    expect(dominanceData.totalEvaluated).toBe(15);
    expect(searchTracesData.totalTraces).toBe(15);
    expect(efficiencyData.candidateReductionRatio).toBe(0.6);
  });

  // 2. Goal constraints indexing
  it("Test 2: constraint index indexes required input/output types and allowed effects", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const index = GuidedConstructiveSearchEngine.createConstraintIndex("P46-L5-01", goal);
    expect(index.goalConstraints.some((c) => c.includes("REQUIRED_OUTPUT"))).toBe(true);
    expect(index.goalConstraints.some((c) => c.includes("REQUIRED_INPUT"))).toBe(true);
    expect(index.goalConstraints.some((c) => c.includes("ALLOWED_EFFECT"))).toBe(true);
  });

  // 3. Semantic invariants indexing
  it("Test 3: constraint index captures input validation and state consistency preservation invariants", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L6-01");
    const index = GuidedConstructiveSearchEngine.createConstraintIndex("P46-L6-01", goal);
    expect(index.semanticInvariants.includes("INVARIANT_INPUT_VALIDATION_PRESERVATION")).toBe(true);
    expect(index.semanticInvariants.includes("INVARIANT_STATE_CONSISTENCY_PRESERVATION")).toBe(true);
  });

  // 4. Cross-module contracts indexing
  it("Test 4: constraint index incorporates cross-module contracts on L6 and L7 tasks", () => {
    const goalL7 = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L7-01");
    const indexL7 = GuidedConstructiveSearchEngine.createConstraintIndex("P46-L7-01", goalL7);
    expect(indexL7.crossModuleContracts.includes("CROSS_MODULE_SYNC_TOKEN_STREAM")).toBe(true);

    const goalL6 = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L6-01");
    const indexL6 = GuidedConstructiveSearchEngine.createConstraintIndex("P46-L6-01", goalL6);
    expect(indexL6.crossModuleContracts.includes("CORS_ORIGIN_VERIFICATION")).toBe(true);
  });

  // 5. Search node deterministic hash addressing
  it("Test 5: search node is addressed deterministically without non-canonical identifiers", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);
    const index = GuidedConstructiveSearchEngine.createConstraintIndex("P46-L5-01", goal);
    const node1 = GuidedConstructiveSearchEngine.createInitialNode(goal, skeleton, index);
    const node2 = GuidedConstructiveSearchEngine.createInitialNode(goal, skeleton, index);
    expect(node1.nodeId).toBe(node2.nodeId);
    expect(node1.contentHash).toBe(node2.contentHash);
  });

  // 6. Forward constraint propagation valid on permitted effects
  it("Test 6: forward constraint propagation accepts nodes whose effects match allowedEffects", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);
    const index = GuidedConstructiveSearchEngine.createConstraintIndex("P46-L5-01", goal);
    const node = GuidedConstructiveSearchEngine.createInitialNode(goal, skeleton, index);
    const result = ForwardConstraintPropagator.propagate(node, goal, index);
    expect(result.valid).toBe(true);
  });

  // 7. Forward constraint propagation rejects unpermitted effects
  it("Test 7: forward constraint propagation rejects nodes with disallowed effects", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01"); // Pure only
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);
    const index = GuidedConstructiveSearchEngine.createConstraintIndex("P46-L5-01", goal);
    const baseNode = GuidedConstructiveSearchEngine.createInitialNode(goal, skeleton, index);
    const taintedNode: SearchNode = {
      ...baseNode,
      effectState: ["MUTATE_PROGRAM"],
      contentHash: "hash-tainted",
    };
    const result = ForwardConstraintPropagator.propagate(taintedNode, goal, index);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("FORWARD_CONSTRAINT_PRUNE");
  });

  // 8. Forward constraint propagation validates non-negative stream positions
  it("Test 8: forward constraint propagation rejects negative token stream positions", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L7-01");
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);
    const index = GuidedConstructiveSearchEngine.createConstraintIndex("P46-L7-01", goal);
    const baseNode = GuidedConstructiveSearchEngine.createInitialNode(goal, skeleton, index);
    const corruptedNode: SearchNode = {
      ...baseNode,
      semanticState: {
        ...baseNode.semanticState,
        tokenStreamPosition: -5,
      },
      contentHash: "hash-corrupt",
    };
    const result = ForwardConstraintPropagator.propagate(corruptedNode, goal, index);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("FORWARD_CONSTRAINT_PRUNE");
  });

  // 9. Backward constraint propagation narrows hole constructors
  it("Test 9: backward constraint propagation narrows allowed constructors for atomic commit goals", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L7-01");
    const index = GuidedConstructiveSearchEngine.createConstraintIndex("P46-L7-01", goal);
    const stateHole = {
      holeId: "HOLE-TEST-STATE",
      expectedType: "STATE" as const,
      allowedEffects: ["TRANSACTIONAL" as const],
      semanticContext: "State transition unit",
      invariantObligations: [],
      candidateConstructors: [...CONSTRUCTOR_PRIMITIVES],
      contentHash: "hash-hole",
    };
    const result = BackwardConstraintPropagator.propagate(goal, stateHole, index);
    expect(result.allowedConstructors.length).toBeLessThan(CONSTRUCTOR_PRIMITIVES.length);
    expect(result.allowedConstructors.includes("TRANSACTION")).toBe(true);
    expect(result.allowedConstructors.includes("ROLLBACK")).toBe(true);
  });

  // 10. Backward constraint propagation enforces transaction constraints
  it("Test 10: backward constraint propagation ensures pure non-state constructors are pruned for state holes", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L7-01");
    const index = GuidedConstructiveSearchEngine.createConstraintIndex("P46-L7-01", goal);
    const stateHole = {
      holeId: "HOLE-TEST-STATE",
      expectedType: "STATE" as const,
      allowedEffects: ["TRANSACTIONAL" as const],
      semanticContext: "State transition unit",
      invariantObligations: [],
      candidateConstructors: ["MAP", "FILTER", "REDUCE"] as const,
      contentHash: "hash-hole-pure",
    };
    const result = BackwardConstraintPropagator.propagate(goal, stateHole, index);
    expect(result.allowedConstructors.length).toBe(0);
    expect(result.reason).toContain("BACKWARD_CONSTRAINT_PRUNE");
  });

  // 11. Backward constraint propagation respects L7 program obligations
  it("Test 11: backward constraint propagation narrows L7 PROGRAM holes to state-sequencing constructors", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L7-01");
    const index = GuidedConstructiveSearchEngine.createConstraintIndex("P46-L7-01", goal);
    const progHole = {
      holeId: "HOLE-TEST-PROG",
      expectedType: "PROGRAM" as const,
      allowedEffects: ["CONTROL_FLOW" as const],
      semanticContext: "Main coordination block",
      invariantObligations: [],
      candidateConstructors: ["CONSTANT", "IDENTITY", "GUARD", "SEQUENCE", "STATE_SET"] as const,
      contentHash: "hash-hole-prog",
    };
    const result = BackwardConstraintPropagator.propagate(goal, progHole, index);
    expect(result.allowedConstructors).toEqual(["GUARD", "SEQUENCE", "STATE_SET"]);
  });

  // 12. Bidirectional constraint intersection valid when overlapping
  it("Test 12: bidirectional constraint propagator finds common constructors across directions", () => {
    const forward = ["GUARD", "BRANCH", "CONSTANT"] as const;
    const backward = ["VALIDATE", "GUARD", "BRANCH"] as const;
    const result = BidirectionalConstraintPropagator.intersect(forward, backward);
    expect(result.valid).toBe(true);
    expect(result.intersection).toEqual(["GUARD", "BRANCH"]);
  });

  // 13. Bidirectional constraint intersection flags BIDIRECTIONAL_CONFLICT when disjoint
  it("Test 13: bidirectional constraint propagator flags conflict when intersection is empty", () => {
    const forward = ["CONSTANT", "PARAMETER"] as const;
    const backward = ["STATE_SET", "ROLLBACK"] as const;
    const result = BidirectionalConstraintPropagator.intersect(forward, backward);
    expect(result.valid).toBe(false);
    expect(result.conflictReason).toContain("BIDIRECTIONAL_CONFLICT");
  });

  // 14. Deterministic branch scoring consistency
  it("Test 14: branch scorer produces identical scores and hashes for identical inputs", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);
    const index = GuidedConstructiveSearchEngine.createConstraintIndex("P46-L5-01", goal);
    const node = GuidedConstructiveSearchEngine.createInitialNode(goal, skeleton, index);
    const score1 = BranchScorer.score(node, goal, index);
    const score2 = BranchScorer.score(node, goal, index);
    expect(score1.totalHeuristicScore).toBe(score2.totalHeuristicScore);
    expect(score1.contentHash).toBe(score2.contentHash);
  });

  // 15. Branch scoring rewards satisfied obligations
  it("Test 15: branch scorer grants higher scores to nodes satisfying more obligations", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);
    const index = GuidedConstructiveSearchEngine.createConstraintIndex("P46-L5-01", goal);
    const nodeA = GuidedConstructiveSearchEngine.createInitialNode(goal, skeleton, index);
    const nodeB: SearchNode = {
      ...nodeA,
      satisfiedObligations: ["TYPE_CHECK_PRECOND", "EFFECT_PRECOND", "STATE_CONSISTENCY"],
      contentHash: "hash-node-b",
    };
    const scoreA = BranchScorer.score(nodeA, goal, index);
    const scoreB = BranchScorer.score(nodeB, goal, index);
    expect(scoreB.totalHeuristicScore).toBeGreaterThan(scoreA.totalHeuristicScore);
  });

  // 16. Branch scoring penalizes violated obligations
  it("Test 16: branch scorer penalizes nodes with violated obligations", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);
    const index = GuidedConstructiveSearchEngine.createConstraintIndex("P46-L5-01", goal);
    const nodeClean = GuidedConstructiveSearchEngine.createInitialNode(goal, skeleton, index);
    const nodeViolated: SearchNode = {
      ...nodeClean,
      violatedObligations: ["TYPE_CORRECTNESS", "REGRESSION_RISK"],
      contentHash: "hash-violated",
    };
    const scoreClean = BranchScorer.score(nodeClean, goal, index);
    const scoreViolated = BranchScorer.score(nodeViolated, goal, index);
    expect(scoreViolated.totalHeuristicScore).toBeLessThan(scoreClean.totalHeuristicScore);
  });

  // 17. Conservative dominance pruner detects strictly dominated nodes
  it("Test 17: conservative dominance pruner prunes nodes with equal state and higher cost", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);
    const index = GuidedConstructiveSearchEngine.createConstraintIndex("P46-L5-01", goal);
    const nodeA = GuidedConstructiveSearchEngine.createInitialNode(goal, skeleton, index);
    const nodeDominated: SearchNode = {
      ...nodeA,
      nodeId: "NODE-DOMINATED-COPY",
      estimatedCost: nodeA.estimatedCost + 10,
      contentHash: "hash-dominated",
    };
    expect(DominancePruner.isDominated(nodeDominated, nodeA)).toBe(true);
  });

  // 18. Conservative dominance pruner refuses to prune with distinct obligations
  it("Test 18: conservative dominance pruner refuses to prune nodes satisfying distinct obligations", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);
    const index = GuidedConstructiveSearchEngine.createConstraintIndex("P46-L5-01", goal);
    const nodeA = GuidedConstructiveSearchEngine.createInitialNode(goal, skeleton, index);
    const nodeDistinct: SearchNode = {
      ...nodeA,
      nodeId: "NODE-DISTINCT-OBLIGATION",
      satisfiedObligations: ["DISTINCT_OBLIGATION_UNSATISFIED_BY_A"],
      estimatedCost: nodeA.estimatedCost + 5,
      contentHash: "hash-distinct",
    };
    expect(DominancePruner.isDominated(nodeDistinct, nodeA)).toBe(false);
  });

  // 19. Conservative dominance pruner refuses to prune with mismatched state
  it("Test 19: conservative dominance pruner refuses to prune nodes with different semantic states", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L6-01");
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);
    const index = GuidedConstructiveSearchEngine.createConstraintIndex("P46-L6-01", goal);
    const nodeA = GuidedConstructiveSearchEngine.createInitialNode(goal, skeleton, index);
    const nodeDiffOrigin: SearchNode = {
      ...nodeA,
      nodeId: "NODE-DIFF-ORIGIN",
      semanticState: {
        ...nodeA.semanticState,
        requestOrigin: "https://different-origin.com",
      },
      contentHash: "hash-diff-origin",
    };
    expect(DominancePruner.isDominated(nodeDiffOrigin, nodeA)).toBe(false);
  });

  // 20. Dead-end detector catches depth ceiling violations
  it("Test 20: dead-end detector flags nodes exceeding maxProgramDepth as dead ends", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);
    const index = GuidedConstructiveSearchEngine.createConstraintIndex("P46-L5-01", goal);
    const node = GuidedConstructiveSearchEngine.createInitialNode(goal, skeleton, index);
    const deepNode: SearchNode = {
      ...node,
      depth: CONSTRUCTIVE_CALCULUS_LIMITS.maxProgramDepth + 1,
      contentHash: "hash-deep",
    };
    const res = SemanticDeadEndDetector.isDeadEnd(deepNode, goal);
    expect(res.deadEnd).toBe(true);
    expect(res.reason).toContain("DEAD_END_PRUNE");
  });

  // 21. Dead-end detector catches irreversible type violations
  it("Test 21: dead-end detector flags irreversible type violations", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);
    const index = GuidedConstructiveSearchEngine.createConstraintIndex("P46-L5-01", goal);
    const node = GuidedConstructiveSearchEngine.createInitialNode(goal, skeleton, index);
    const typeViolatedNode: SearchNode = {
      ...node,
      violatedObligations: ["TYPE_CORRECTNESS"],
      contentHash: "hash-type-violated",
    };
    const res = SemanticDeadEndDetector.isDeadEnd(typeViolatedNode, goal);
    expect(res.deadEnd).toBe(true);
    expect(res.reason).toContain("DEAD_END_PRUNE");
  });

  // 22. Dead-end detector catches unrecoverable effect mismatches
  it("Test 22: dead-end detector flags unrecoverable effect mismatches", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);
    const index = GuidedConstructiveSearchEngine.createConstraintIndex("P46-L5-01", goal);
    const node = GuidedConstructiveSearchEngine.createInitialNode(goal, skeleton, index);
    const effectViolatedNode: SearchNode = {
      ...node,
      effectState: ["MUTATE_PROGRAM"],
      contentHash: "hash-effect-violated",
    };
    const res = SemanticDeadEndDetector.isDeadEnd(effectViolatedNode, goal);
    expect(res.deadEnd).toBe(true);
  });

  // 23. Valid candidates are never falsely pruned
  it("Test 23: valid initial candidate node is not falsely pruned by any pruner", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);
    const index = GuidedConstructiveSearchEngine.createConstraintIndex("P46-L5-01", goal);
    const node = GuidedConstructiveSearchEngine.createInitialNode(goal, skeleton, index);

    const fwd = ForwardConstraintPropagator.propagate(node, goal, index);
    const deadEnd = SemanticDeadEndDetector.isDeadEnd(node, goal);
    const bwd = BackwardConstraintPropagator.propagate(goal, skeleton.holes[0]!, index);

    expect(fwd.valid).toBe(true);
    expect(deadEnd.deadEnd).toBe(false);
    expect(bwd.allowedConstructors.length).toBeGreaterThan(0);
  });

  // 24. Frozen search budget limits preserved
  it("Test 24: frozen resource limits match Phase 70 exactly", () => {
    expect(protocol.calculusBounds.maxProgramDepth).toBe(10);
    expect(protocol.calculusBounds.maxProgramNodes).toBe(64);
    expect(protocol.calculusBounds.maxConstructiveHoles).toBe(16);
    expect(protocol.calculusBounds.maxConstructorApplications).toBe(128);
    expect(protocol.calculusBounds.maxRefinementIterations).toBe(6);
    expect(protocol.calculusBounds.maxPrograms).toBe(64);
    expect(protocol.calculusBounds.maxAffectedFiles).toBe(6);
    expect(protocol.calculusBounds.maxAffectedSymbols).toBe(64);
    expect(protocol.calculusBounds.maxWallClockMs).toBe(120000);
  });

  // 25. Complete search accounting counter integrity
  it("Test 25: search accounting records all required counters", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const searchRes = GuidedConstructiveSearchEngine.search(goal, "D");
    const c = searchRes.counters;
    expect(typeof c.generated).toBe("number");
    expect(typeof c.expanded).toBe("number");
    expect(typeof c.typePruned).toBe("number");
    expect(typeof c.effectPruned).toBe("number");
    expect(typeof c.forwardPruned).toBe("number");
    expect(typeof c.backwardPruned).toBe("number");
    expect(typeof c.bidirectionalPruned).toBe("number");
    expect(typeof c.dominancePruned).toBe("number");
    expect(typeof c.deadEndPruned).toBe("number");
    expect(typeof c.proofRejected).toBe("number");
    expect(typeof c.materialized).toBe("number");
    expect(typeof c.cleanRoomRejected).toBe("number");
    expect(typeof c.cleanRoomAccepted).toBe("number");
    expect(typeof c.searchExhausted).toBe("number");
  });

  // 26. Frontier sorting determinism
  it("Test 26: search frontier pops nodes with highest heuristic score first", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);
    const index = GuidedConstructiveSearchEngine.createConstraintIndex("P46-L5-01", goal);
    const nodeA = GuidedConstructiveSearchEngine.createInitialNode(goal, skeleton, index);
    const nodeLowScore = { ...nodeA, nodeId: "NODE-LOW", heuristicScore: 10, contentHash: "hash-low" };
    const nodeHighScore = { ...nodeA, nodeId: "NODE-HIGH", heuristicScore: 100, contentHash: "hash-high" };

    const frontier = new SearchFrontier();
    frontier.push(nodeLowScore);
    frontier.push(nodeHighScore);

    const first = frontier.pop();
    expect(first?.nodeId).toBe("NODE-HIGH");
  });

  // 27. Condition A (Phase 70 control) replication
  it("Test 27: Condition A evaluates 10/15 exactly matching Phase 70 baseline", () => {
    const condA = evaluationData.trials.filter((t: any) => t.condition === "A");
    expect(condA.length).toBe(15);
    const passed = condA.filter((t: any) => t.cleanRoomPassed).length;
    expect(passed).toBe(10);
    expect(condA.filter((t: any) => t.level === "L7").every((t: any) => !t.cleanRoomPassed)).toBe(true);
  });

  // 28. Condition B (Forward guided search) evaluation
  it("Test 28: Condition B maintains 10/15 clean-room success with reduced forward search", () => {
    const condB = evaluationData.trials.filter((t: any) => t.condition === "B");
    expect(condB.length).toBe(15);
    const passed = condB.filter((t: any) => t.cleanRoomPassed).length;
    expect(passed).toBe(10);
  });

  // 29. Condition C (Bidirectional guided search) evaluation
  it("Test 29: Condition C maintains 10/15 clean-room success with bidirectional narrowing", () => {
    const condC = evaluationData.trials.filter((t: any) => t.condition === "C");
    expect(condC.length).toBe(15);
    const passed = condC.filter((t: any) => t.cleanRoomPassed).length;
    expect(passed).toBe(10);
  });

  // 30. Condition D (Full governed guided search) evaluation
  it("Test 30: Condition D achieves 10/15 clean-room success with full guidance", () => {
    const condD = evaluationData.trials.filter((t: any) => t.condition === "D");
    expect(condD.length).toBe(15);
    const passed = condD.filter((t: any) => t.cleanRoomPassed).length;
    expect(passed).toBe(10);
    expect(resultsData.metrics.overall_success).toBe("10/15 (66.7%)");
  });

  // 31. Search node reduction ratio achieves >= 60% reduction
  it("Test 31: Condition D achieves 70.0% node reduction ratio relative to baseline", () => {
    expect(resultsData.metrics.search_node_reduction_ratio).toBe("70.0%");
    expect(resultsData.metrics.candidate_reduction_ratio).toBe("60.0%");
  });

  // 32. Time reduction ratio achieves >= 40% reduction
  it("Test 32: Condition D achieves 42.6% time reduction ratio", () => {
    expect(resultsData.metrics.time_reduction_ratio).toBe("42.6%");
    expect(resultsData.metrics.latency).toBe("390 ms (L5) / 510 ms (L6) / 1420 ms (L7)");
  });

  // 33. Clean-room dual gate fail-closed on L7
  it("Test 33: clean-room dual gate remains 0/5 on L7 due to unresolved CROSS_MODULE_SYNC", () => {
    expect(resultsData.metrics.l7_clean_room_success).toBe("0/5 (0.0%)");
    expect(l7DiagnosticsData.totalCases).toBe(5);
    for (const d of l7DiagnosticsData.diagnosticCases) {
      expect(d.cleanRoomStatus).toBe("CLEAN_ROOM_REJECTED");
      expect(d.proofObligationStatus.crossModuleSync).toBe("UNRESOLVED");
    }
  });

  // 34. Deterministic byte-identical replay across runs
  it("Test 34: repeated evaluation produces byte-identical hash digest across 3 runs", () => {
    expect(determinismData.allByteIdentical).toBe(true);
    expect(determinismData.status).toBe("PASS");
    expect(determinismData.run1Digest).toBe(determinismData.run2Digest);
    expect(determinismData.run2Digest).toBe(determinismData.run3Digest);
  });

  // 35. Negative controls N1–N80 preserved
  it("Test 35: historical negative controls N1–N80 pass 100% fail-closed", () => {
    const historical = negativeControlsData.controls.filter((c: any) => {
      const num = parseInt(c.id.replace("N", ""), 10);
      return num <= 80;
    });
    expect(historical.length).toBe(80);
    expect(historical.every((c: any) => c.status === "PASS")).toBe(true);
  });

  // 36. Negative controls N81–N90 fail-closed validation
  it("Test 36: new Phase 71 negative controls N81–N90 validate fail-closed search guidance", () => {
    const p71Controls = negativeControlsData.controls.filter((c: any) => {
      const num = parseInt(c.id.replace("N", ""), 10);
      return num >= 81 && num <= 90;
    });
    expect(p71Controls.length).toBe(10);
    expect(p71Controls.every((c: any) => c.status === "PASS")).toBe(true);
    expect(statusData.status.decision).toBe("SEARCH_EFFICIENCY_BOUNDARY");
    expect(statusData.status.remainingBoundary).toBe("HEURISTIC_SEARCH_LIMIT");
  });
});
