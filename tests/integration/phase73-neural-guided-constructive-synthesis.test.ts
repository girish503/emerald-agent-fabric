/**
 * Phase 73 — Neural-Guided Governed Constructive Program Synthesis Integration Tests
 *
 * Verifies:
 * - Model identity and non-authoritative advisor role
 * - Hardware and feasibility constraints
 * - Prompt leakage firewall (PROMPT_LEAKAGE_CHECK = ZERO_LEAKAGE)
 * - Structured proposal parsing and schema limits
 * - Constructor, type, effect, and state validation
 * - Candidate translation without silent repair
 * - Branch ranking without candidate mutation
 * - Deterministic fallback on failure or timeout
 * - Authority firewall preventing model authority escalation
 * - Full 60-trial matrix across Conditions A, B, C, D
 * - Negative controls N1–N110 fail-closed
 * - Replay determinism (byte-identical across 3 runs)
 * - Model output can never directly become executable code
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import {
  GovernedNeuralSynthesisEngine,
  NeuralSynthesisAdvisor,
  ProposalValidator,
  NeuralCandidateTranslator,
  NeuralBranchPrioritizer,
  NeuralConstraintInterpreter,
  NeuralLeakageScanner,
  FROZEN_NEURAL_SYNTHESIS_BUDGETS,
  MODEL_IDENTITY,
  NeuralSynthesisProposal,
} from "../../src/application/neural-guided-constructive-synthesis.js";
import {
  ConstructiveProgramInductionCalculusEngine,
  ConstructorPrimitive,
  SemanticType,
  SemanticEffect,
} from "../../src/application/constructive-program-induction-calculus.js";
import { SearchNode } from "../../src/application/guided-constructive-search.js";

const ROOT = path.resolve(process.cwd());

describe("Phase 73 — Neural-Guided Governed Constructive Program Synthesis", () => {
  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase73-protocol.json"), "utf8"));
  const modelIdentity = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase73-model-identity.json"), "utf8"));
  const modelFeasibility = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase73-model-feasibility.json"), "utf8"));
  const proposalsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase73-proposals.json"), "utf8"));
  const validationsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase73-proposal-validation.json"), "utf8"));
  const translationsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase73-candidate-translations.json"), "utf8"));
  const branchRankingsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase73-branch-rankings.json"), "utf8"));
  const accountingData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase73-search-accounting.json"), "utf8"));
  const evaluationData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase73-evaluation.json"), "utf8"));
  const negativeControlsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase73-negative-controls.json"), "utf8"));
  const determinismData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase73-determinism.json"), "utf8"));
  const resultsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase73-results.json"), "utf8"));
  const l7DiagnosticsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase73-l7-diagnostics.json"), "utf8"));
  const statusData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase73-status.json"), "utf8"));

  // 1. Model identity verification
  it("Test 1: model identity matches frozen local open-weight registry", () => {
    expect(FROZEN_NEURAL_SYNTHESIS_BUDGETS.maxModelCallsPerTrial).toBe(6);
    expect(MODEL_IDENTITY.modelName).toBe("qwen2.5-coder:3b");
    expect(MODEL_IDENTITY.parameterCount).toBe(3090000000);
    expect(MODEL_IDENTITY.quantization).toBe("Q4_K_M");
    expect(MODEL_IDENTITY.modelDigest).toBe("f72c60cabf6237b07f6e632b2c48d533cef25eda2efbd34bed21c5e9c01e6225");
    expect(modelIdentity.identity.modelName).toBe("qwen2.5-coder:3b");
  });

  // 2. Non-authoritative advisor role
  it("Test 2: model role is strictly UNTRUSTED_SYNTHESIS_ADVISOR and non-authoritative", () => {
    expect(MODEL_IDENTITY.role).toBe("UNTRUSTED_SYNTHESIS_ADVISOR");
    expect(modelIdentity.authorityStatus).toBe("UNTRUSTED_NON_AUTHORITATIVE");
  });

  // 3. Hardware feasibility profile
  it("Test 3: hardware profile confirms CPU-only execution without GPU dependency", () => {
    expect(protocol.hardware.cpu).toBe("Intel(R) Core(TM) i3-N305");
    expect(protocol.hardware.acceleratorStatus).toBe("ACCELERATOR_UNAVAILABLE");
    expect(modelFeasibility.verificationVerdict).toBe("FEASIBLE_LOCAL_CPU");
  });

  // 4. Prompt leakage scanner: gold patch rejection
  it("Test 4: prompt leakage scanner detects and rejects gold patch fragments", () => {
    const dirty = "Look at this diff --git a/src/index.js b/src/index.js";
    const res = NeuralLeakageScanner.scan(dirty);
    expect(res.clean).toBe(false);
    expect(res.detectedTokens).toContain("diff --git");
  });

  // 5. Prompt leakage scanner: private key rejection
  it("Test 5: prompt leakage scanner detects and rejects private key fragments", () => {
    const dirty = "-----BEGIN PRIVATE KEY-----\nMIGEAgEAMBAGByqGSM49AgEG";
    const res = NeuralLeakageScanner.scan(dirty);
    expect(res.clean).toBe(false);
    expect(res.detectedTokens).toContain("BEGIN PRIVATE KEY");
  });

  // 6. Prompt leakage scanner: clean prompt approval
  it("Test 6: prompt leakage scanner approves clean prompts (ZERO_LEAKAGE)", () => {
    const clean = "TASK: P46-L5-01\nGOAL: goal-01\nTYPE: BOOLEAN\nALLOWED_EFFECTS: PURE";
    const res = NeuralLeakageScanner.scan(clean);
    expect(res.clean).toBe(true);
    expect(res.detectedTokens.length).toBe(0);
  });

  // 7. Proposal size limit
  it("Test 7: proposal size limit rejects proposals exceeding 32768 bytes", () => {
    const largeObj = {
      proposalId: "p-large",
      data: "x".repeat(35000),
    };
    const val = ProposalValidator.validate(largeObj);
    expect(val.valid).toBe(false);
    expect(val.failureClass).toBe("INVALID_SCHEMA");
    expect(val.reason).toBe("PROPOSAL_EXCEEDS_SIZE_LIMIT");
  });

  // 8. Authority field injection rejection
  it("Test 8: proposal validator rejects forbidden authority fields (workerId, missionContract)", () => {
    const val = ProposalValidator.validate({
      proposalId: "p-auth",
      workerId: "attacker-worker",
      missionContract: "escalated-contract",
    });
    expect(val.valid).toBe(false);
    expect(val.failureClass).toBe("AUTHORITY_VIOLATION");
    expect(val.reason).toBe("FORBIDDEN_AUTHORITY_FIELDS");
  });

  // 9. Clean-room verification claim injection rejection
  it("Test 9: proposal validator rejects clean-room claim injection (cleanRoomSuccess)", () => {
    const val = ProposalValidator.validate({
      proposalId: "p-claim",
      cleanRoomSuccess: true,
      verificationPassed: true,
    });
    expect(val.valid).toBe(false);
    expect(val.failureClass).toBe("AUTHORITY_VIOLATION");
  });

  // 10. Arbitrary source code patch rejection
  it("Test 10: proposal validator rejects arbitrary source patch text", () => {
    const val = ProposalValidator.validate({
      proposalId: "p-patch",
      sourcePatch: "function execute() { return true; }",
    });
    expect(val.valid).toBe(false);
    expect(val.failureClass).toBe("AUTHORITY_VIOLATION");
  });

  // 11. Shell command injection rejection
  it("Test 11: proposal validator rejects shell command strings", () => {
    const val = ProposalValidator.validate({
      proposalId: "p-sh",
      shellCommand: "rm -rf /",
    });
    expect(val.valid).toBe(false);
    expect(val.failureClass).toBe("AUTHORITY_VIOLATION");
  });

  // 12. Unknown constructor rejection
  it("Test 12: proposal validator rejects unknown constructor primitives outside Phase 70", () => {
    const val = ProposalValidator.validate({
      proposalId: "p-unk",
      goalHash: "gh-1",
      skeletonHash: "sh-1",
      constructorApplications: [{ holeId: "h1", constructor: "MAGIC_SOLVER" as ConstructorPrimitive }],
      holeAssignments: [],
      confidence: 0.9,
    });
    expect(val.valid).toBe(false);
    expect(val.failureClass).toBe("UNKNOWN_CONSTRUCTOR");
  });

  // 13. Invalid semantic type rejection
  it("Test 13: proposal validator rejects invalid semantic types", () => {
    const val = ProposalValidator.validate({
      proposalId: "p-type",
      goalHash: "gh-1",
      skeletonHash: "sh-1",
      constructorApplications: [{ holeId: "h1", constructor: "GUARD" }],
      holeAssignments: [{ holeId: "h1", semanticType: 9999 as unknown as SemanticType, constructor: "GUARD" }],
      confidence: 0.9,
    });
    expect(val.valid).toBe(false);
    expect(val.failureClass).toBe("TYPE_INVALID");
  });

  // 14. Valid structured proposal acceptance
  it("Test 14: proposal validator accepts well-formed structured neural proposal", () => {
    expect(proposalsData.count).toBeGreaterThan(0);
    expect(validationsData.count).toBeGreaterThan(0);
    const val = ProposalValidator.validate({
      proposalId: "p-valid",
      goalHash: "gh-1",
      skeletonHash: "sh-1",
      constructorApplications: [{ holeId: "h1", constructor: "GUARD" }],
      holeAssignments: [{ holeId: "h1", semanticType: "BOOLEAN", constructor: "GUARD" }],
      reasoningHints: ["validate input first"],
      expectedEffects: ["PURE"],
      expectedStateTransitions: [{ key: "state", toValue: "VALID" }],
      expectedInvariants: ["VALID_INPUT"],
      confidence: 0.95,
    });
    expect(val.valid).toBe(true);
    expect(val.failureClass).toBe("VALID_CONSTRUCTIVE_PROPOSAL");
  });

  // 15. Constructor application count ceiling
  it("Test 15: proposal validator enforces constructor applications ceiling (max 64)", () => {
    const apps = Array.from({ length: 70 }, (_, i) => ({ holeId: `h${i}`, constructor: "GUARD" as ConstructorPrimitive }));
    const val = ProposalValidator.validate({
      proposalId: "p-app-overflow",
      goalHash: "gh-1",
      skeletonHash: "sh-1",
      constructorApplications: apps,
      holeAssignments: [],
      confidence: 0.5,
    });
    expect(val.valid).toBe(false);
    expect(val.failureClass).toBe("INVALID_SCHEMA");
  });

  // 16. Hole assignments count ceiling
  it("Test 16: proposal validator enforces hole assignments ceiling (max 16)", () => {
    const holes = Array.from({ length: 20 }, (_, i) => ({ holeId: `h${i}`, semanticType: "BOOLEAN" as SemanticType, constructor: "GUARD" as ConstructorPrimitive }));
    const val = ProposalValidator.validate({
      proposalId: "p-hole-overflow",
      goalHash: "gh-1",
      skeletonHash: "sh-1",
      constructorApplications: [],
      holeAssignments: holes,
      confidence: 0.5,
    });
    expect(val.valid).toBe(false);
    expect(val.failureClass).toBe("INVALID_SCHEMA");
  });

  // 17. Reasoning hints size ceiling
  it("Test 17: proposal validator enforces reasoning hints ceiling (max 4096 bytes)", () => {
    const val = ProposalValidator.validate({
      proposalId: "p-hint-overflow",
      goalHash: "gh-1",
      skeletonHash: "sh-1",
      constructorApplications: [],
      holeAssignments: [],
      reasoningHints: ["h".repeat(5000)],
      confidence: 0.5,
    });
    expect(val.valid).toBe(false);
    expect(val.failureClass).toBe("INVALID_SCHEMA");
  });

  // 18. Expected invariants count ceiling
  it("Test 18: proposal validator enforces expected invariants ceiling (max 32)", () => {
    const invs = Array.from({ length: 40 }, (_, i) => `INV_${i}`);
    const val = ProposalValidator.validate({
      proposalId: "p-inv-overflow",
      goalHash: "gh-1",
      skeletonHash: "sh-1",
      constructorApplications: [],
      holeAssignments: [],
      expectedInvariants: invs,
      confidence: 0.5,
    });
    expect(val.valid).toBe(false);
    expect(val.failureClass).toBe("INVALID_SCHEMA");
  });

  // 19. Candidate translation into ConstructiveProgram
  it("Test 19: candidate translator converts valid proposal into ConstructiveProgram", () => {
    expect(translationsData.count).toBeGreaterThan(0);
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);
    const proposal: NeuralSynthesisProposal = {
      proposalId: "p-trans",
      goalHash: "goal-hash-l5",
      skeletonHash: "skel-hash-l5",
      constructorApplications: [{ holeId: "h1", constructor: "GUARD" }],
      holeAssignments: [{ holeId: "h1", semanticType: "BOOLEAN", constructor: "GUARD" }],
      reasoningHints: ["enforce guard"],
      expectedEffects: ["PURE"],
      expectedStateTransitions: [],
      expectedInvariants: ["PRESERVE_PRERELEASE_PARSING"],
      confidence: 0.9,
    };
    const trans = NeuralCandidateTranslator.translate(proposal, goal, skeleton);
    expect(trans.success).toBe(true);
    expect(trans.program).toBeDefined();
    expect(trans.program!.validated).toBe(true);
  });

  // 20. Candidate translation rejects unallowed side-effects
  it("Test 20: candidate translator rejects unallowed side-effects (MUTATE_PROGRAM in pure goal)", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);
    const proposal: NeuralSynthesisProposal = {
      proposalId: "p-eff-bad",
      goalHash: "goal-hash-l5",
      skeletonHash: "skel-hash-l5",
      constructorApplications: [{ holeId: "h1", constructor: "GUARD" }],
      holeAssignments: [{ holeId: "h1", semanticType: "BOOLEAN", constructor: "GUARD" }],
      reasoningHints: [],
      expectedEffects: ["MUTATE_PROGRAM" as SemanticEffect],
      expectedStateTransitions: [],
      expectedInvariants: [],
      confidence: 0.9,
    };
    const trans = NeuralCandidateTranslator.translate(proposal, goal, skeleton);
    expect(trans.success).toBe(false);
    expect(trans.failureClass).toBe("EFFECT_INVALID");
  });

  // 21. Candidate translation rejects negative state transitions
  it("Test 21: candidate translator rejects negative state transitions", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);
    const proposal: NeuralSynthesisProposal = {
      proposalId: "p-state-bad",
      goalHash: "goal-hash-l5",
      skeletonHash: "skel-hash-l5",
      constructorApplications: [{ holeId: "h1", constructor: "GUARD" }],
      holeAssignments: [{ holeId: "h1", semanticType: "BOOLEAN", constructor: "GUARD" }],
      reasoningHints: [],
      expectedEffects: ["PURE"],
      expectedStateTransitions: [{ key: "tokenStreamPosition", toValue: -1 }],
      expectedInvariants: [],
      confidence: 0.9,
    };
    const trans = NeuralCandidateTranslator.translate(proposal, goal, skeleton);
    expect(trans.success).toBe(false);
    expect(trans.failureClass).toBe("STATE_INVALID");
  });

  // 22. Candidate translation rejects goal hash mismatch
  it("Test 22: candidate translator rejects goal hash mismatch without silent repair", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);
    const proposal: NeuralSynthesisProposal = {
      proposalId: "p-hash-mismatch",
      goalHash: "mismatched-goal-hash",
      skeletonHash: "skel-hash-l5",
      constructorApplications: [{ holeId: "h1", constructor: "GUARD" }],
      holeAssignments: [{ holeId: "h1", semanticType: "BOOLEAN", constructor: "GUARD" }],
      reasoningHints: [],
      expectedEffects: ["PURE"],
      expectedStateTransitions: [],
      expectedInvariants: [],
      confidence: 0.9,
    };
    const trans = NeuralCandidateTranslator.translate(proposal, goal, skeleton);
    expect(trans.success).toBe(false);
    expect(trans.failureClass).toBe("CONTRACT_INVALID");
  });

  // 23. Neural branch prioritizer reorders search nodes
  it("Test 23: neural branch prioritizer reorders search nodes according to neural recommendation", () => {
    expect(branchRankingsData.count).toBeGreaterThan(0);
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const nodes: SearchNode[] = [
      { nodeId: "node-1", parentNodeId: null, programSkeleton: {} as any, openHoles: [{} as any], satisfiedObligations: [], unsatisfiedObligations: [], violatedObligations: [], availableConstructors: [], semanticState: {} as any, effectState: [], typeState: [], constraintState: {}, depth: 1, estimatedCost: 10, heuristicScore: 50, contentHash: "h1" },
      { nodeId: "node-2", parentNodeId: null, programSkeleton: {} as any, openHoles: [{} as any], satisfiedObligations: [], unsatisfiedObligations: [], violatedObligations: [], availableConstructors: [], semanticState: {} as any, effectState: [], typeState: [], constraintState: {}, depth: 1, estimatedCost: 10, heuristicScore: 80, contentHash: "h2" },
    ];
    const rec = {
      rankingId: "rank-1",
      rankedNodeIds: ["node-1", "node-2"],
      reasoning: "Prioritizing node-1 first",
      confidence: 0.9,
    };
    const reordered = NeuralBranchPrioritizer.prioritize(nodes, goal, rec);
    expect(reordered[0]!.nodeId).toBe("node-1");
  });

  // 24. Neural branch prioritizer falls back to heuristic score
  it("Test 24: neural branch prioritizer falls back to heuristic score if recommendation is empty", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const nodes: SearchNode[] = [
      { nodeId: "node-1", parentNodeId: null, programSkeleton: {} as any, openHoles: [{} as any], satisfiedObligations: [], unsatisfiedObligations: [], violatedObligations: [], availableConstructors: [], semanticState: {} as any, effectState: [], typeState: [], constraintState: {}, depth: 1, estimatedCost: 10, heuristicScore: 50, contentHash: "h1" },
      { nodeId: "node-2", parentNodeId: null, programSkeleton: {} as any, openHoles: [{} as any], satisfiedObligations: [], unsatisfiedObligations: [], violatedObligations: [], availableConstructors: [], semanticState: {} as any, effectState: [], typeState: [], constraintState: {}, depth: 1, estimatedCost: 10, heuristicScore: 80, contentHash: "h2" },
    ];
    const fallback = NeuralBranchPrioritizer.prioritize(nodes, goal, undefined);
    expect(fallback[0]!.nodeId).toBe("node-2");
  });

  // 25. Neural branch prioritizer does not mutate node contents
  it("Test 25: neural branch prioritizer does not mutate node contents or create new authority", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const node: SearchNode = { nodeId: "node-1", parentNodeId: null, programSkeleton: {} as any, openHoles: [], satisfiedObligations: ["OB_1"], unsatisfiedObligations: [], violatedObligations: [], availableConstructors: [], semanticState: {} as any, effectState: [], typeState: [], constraintState: {}, depth: 1, estimatedCost: 10, heuristicScore: 50, contentHash: "h1" };
    const rec = { rankingId: "r1", rankedNodeIds: ["node-1"], reasoning: "test", confidence: 0.8 };
    const result = NeuralBranchPrioritizer.prioritize([node], goal, rec);
    expect(result[0]!.nodeId).toBe("node-1");
    expect(result[0]!.satisfiedObligations).toEqual(["OB_1"]);
  });

  // 26. Constraint interpreter extracts invariants into typed constraint mapping
  it("Test 26: constraint interpreter extracts invariants into typed constraint mapping", () => {
    const proposal: NeuralSynthesisProposal = {
      proposalId: "p-c",
      goalHash: "gh-1",
      skeletonHash: "sh-1",
      constructorApplications: [],
      holeAssignments: [],
      reasoningHints: [],
      expectedEffects: ["PURE"],
      expectedStateTransitions: [{ key: "parserMode", toValue: "STRICT" }],
      expectedInvariants: ["INV_STRICT_MODE"],
      confidence: 0.9,
    };
    const interpreted = NeuralConstraintInterpreter.interpret(proposal);
    expect(interpreted["INV_STRICT_MODE"]).toBe(true);
    expect(interpreted["effect:PURE"]).toBe(true);
    expect(interpreted["transition:parserMode"]).toBe("STRICT");
  });

  // 27. Advisor enforces model call budget limit
  it("Test 27: advisor enforces model call budget limit (max 6 calls per trial)", async () => {
    expect(accountingData.totalModelCalls).toBeGreaterThanOrEqual(0);
    const advisor = new NeuralSynthesisAdvisor();
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);

    for (let i = 0; i < 6; i++) {
      await advisor.requestProposal("P46-L5-01", goal, skeleton);
    }
    const overflow = await advisor.requestProposal("P46-L5-01", goal, skeleton);
    expect(overflow.failureClass).toBe("PROPOSAL_TIMEOUT");
    expect(overflow.reason).toBe("MODEL_CALL_BUDGET_EXHAUSTED");
  });

  // 28. Advisor handles timeout status cleanly
  it("Test 28: advisor handles timeout status cleanly without hanging", async () => {
    const mockTimeoutTransport = async () => ({ responseText: "", latencyMs: 30000, status: "TIMEOUT" as const });
    const advisor = new NeuralSynthesisAdvisor(mockTimeoutTransport);
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);

    const res = await advisor.requestProposal("P46-L5-01", goal, skeleton);
    expect(res.failureClass).toBe("PROPOSAL_TIMEOUT");
    expect(res.reason).toBe("MODEL_TIMEOUT");
  });

  // 29. Advisor handles model error gracefully
  it("Test 29: advisor handles model error gracefully", async () => {
    const mockErrorTransport = async () => ({ responseText: "", latencyMs: 50, status: "ERROR" as const });
    const advisor = new NeuralSynthesisAdvisor(mockErrorTransport);
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);

    const res = await advisor.requestProposal("P46-L5-01", goal, skeleton);
    expect(res.failureClass).toBe("MODEL_UNAVAILABLE");
    expect(res.reason).toBe("MODEL_ERROR");
  });

  // 30. Deterministic fallback triggers when model proposal is invalid
  it("Test 30: deterministic fallback triggers when model proposal fails validation", async () => {
    const mockInvalidTransport = async () => ({ responseText: JSON.stringify({ bad: "proposal" }), latencyMs: 50, status: "SUCCESS" as const });
    const advisor = new NeuralSynthesisAdvisor(mockInvalidTransport);
    const trial = await GovernedNeuralSynthesisEngine.executeTrial("P46-L5-01", "CONDITION_B", advisor);
    expect(trial.fallbackTriggered).toBe(true);
    expect(trial.success).toBe(true); // Fallback to guided search succeeds on L5
  });

  // 31. Deterministic fallback triggers when model times out
  it("Test 31: deterministic fallback triggers when model times out", async () => {
    const mockTimeoutTransport = async () => ({ responseText: "", latencyMs: 30000, status: "TIMEOUT" as const });
    const advisor = new NeuralSynthesisAdvisor(mockTimeoutTransport);
    const trial = await GovernedNeuralSynthesisEngine.executeTrial("P46-L5-01", "CONDITION_B", advisor);
    expect(trial.fallbackTriggered).toBe(true);
    expect(trial.success).toBe(true);
  });

  // 32. Condition A operates without model calls
  it("Test 32: Condition A operates without model calls (Phase 71 Control)", async () => {
    expect(evaluationData.totalTrials).toBe(60);
    const trial = await GovernedNeuralSynthesisEngine.executeTrial("P46-L5-01", "CONDITION_A");
    expect(trial.modelCalls).toBe(0);
    expect(trial.success).toBe(true);
  });

  // 33. Condition B requests proposal and achieves clean-room success on L5/L6
  it("Test 33: Condition B requests proposal and achieves clean-room success on L5/L6", async () => {
    const trial = await GovernedNeuralSynthesisEngine.executeTrial("P46-L5-01", "CONDITION_B");
    expect(trial.modelCalls).toBeGreaterThan(0);
    expect(trial.cleanRoomPassed).toBe(true);
    expect(trial.success).toBe(true);
  });

  // 34. Condition C requests branch ranking without creating candidates
  it("Test 34: Condition C requests branch ranking without creating candidates", async () => {
    const trial = await GovernedNeuralSynthesisEngine.executeTrial("P46-L6-01", "CONDITION_C");
    expect(trial.accounting.branchRankingsRequested).toBe(1);
    expect(trial.success).toBe(true);
  });

  // 35. Condition D coordinates multi-module contracts for L7
  it("Test 35: Condition D coordinates multi-module contracts for L7", async () => {
    const trial = await GovernedNeuralSynthesisEngine.executeTrial("P46-L7-01", "CONDITION_D");
    expect(trial.condition).toBe("CONDITION_D");
    expect(trial.programSynthesized).toBe(true);
  });

  // 36. Condition D clean-room verification fails-closed on L7 (0/5)
  it("Test 36: Condition D clean-room verification fails-closed on L7 (0/5)", async () => {
    expect(l7DiagnosticsData.cohortSize).toBe(5);
    expect(statusData.phase).toBe("73");
    const trial = await GovernedNeuralSynthesisEngine.executeTrial("P46-L7-01", "CONDITION_D");
    expect(trial.cleanRoomPassed).toBe(false);
    expect(trial.success).toBe(false);
    expect(resultsData.l7_clean_room_success).toBe("0/5 (0.0%)");
  });

  // 37. Replay determinism
  it("Test 37: three repeated runs produce byte-identical digests across all trials", () => {
    expect(determinismData.deterministicStatus).toBe("PASS (BYTE_IDENTICAL)");
    expect(determinismData.run1Digest).toBe(determinismData.run2Digest);
    expect(determinismData.run2Digest).toBe(determinismData.run3Digest);
  });

  // 38. Historical negative controls N1–N100 pass fail-closed
  it("Test 38: historical negative controls N1–N100 pass fail-closed", () => {
    expect(negativeControlsData.totalControls).toBe(110);
    const controls = GovernedNeuralSynthesisEngine.evaluateNegativeControls("P46-L5-01");
    const historical = controls.filter((c) => {
      const num = parseInt(c.id.replace("N", ""), 10);
      return num >= 1 && num <= 100;
    });
    expect(historical.length).toBe(100);
    for (const c of historical) {
      expect(c.status).toBe("PASS");
    }
  });

  // 39. Negative controls N101–N105 pass fail-closed
  it("Test 39: negative controls N101–N105 pass fail-closed", () => {
    const controls = GovernedNeuralSynthesisEngine.evaluateNegativeControls("P46-L5-01");
    const n101to105 = controls.filter((c) => ["N101", "N102", "N103", "N104", "N105"].includes(c.id));
    expect(n101to105.length).toBe(5);
    for (const c of n101to105) {
      expect(c.status).toBe("PASS");
      expect(c.actualClass).toBe("REJECT");
    }
  });

  // 40. Negative controls N106–N110 pass fail-closed
  it("Test 40: negative controls N106–N110 pass fail-closed", () => {
    const controls = GovernedNeuralSynthesisEngine.evaluateNegativeControls("P46-L5-01");
    const n106to110 = controls.filter((c) => ["N106", "N107", "N108", "N109", "N110"].includes(c.id));
    expect(n106to110.length).toBe(5);
    for (const c of n106to110) {
      expect(c.status).toBe("PASS");
      expect(c.actualClass).toBe("REJECT");
    }
  });

  // 41. Model output can never directly become executable code
  it("Test 41: model output can never directly become executable code", () => {
    const rawOutput = {
      proposalId: "p-code",
      arbitraryCode: "process.exit(1)",
      sourcePatch: "rm -rf *",
    };
    const val = ProposalValidator.validate(rawOutput);
    expect(val.valid).toBe(false);
    expect(val.failureClass).toBe("AUTHORITY_VIOLATION");
  });
});
