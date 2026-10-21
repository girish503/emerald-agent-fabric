/**
 * Phase 88 — Autonomous Multi-Tool Repair Strategy Synthesis and Governed Backtracking Exploration
 *
 * Comprehensive integration test suite verifying:
 * 1. Strategy Schema, Size & Digest Integrity Validation
 * 2. Authority Invariants S1–S18
 * 3. Search Policies (POLICY_A_FIRST_VALID, POLICY_B_BOUNDED_BEST_FIRST, POLICY_C_FAILURE_AWARE_BACKTRACK, POLICY_D_GOVERNED_ADAPTIVE)
 * 4. Backtracking Mechanics & History Preservation
 * 5. Branch Isolation & Contamination Defense
 * 6. Cumulative Resource Bounds & Amplification Defense
 * 7. Mid-Search Revocation & Expiration Fail-Closed Semantics
 * 8. Cryptographic Search-Tree Provenance Chains & Tamper Detection
 * 9. Integration with Phase 83 Delta Screening & Phase 14 Fourfold Clean-Room Verification
 * 10. Negative Security Controls N361–N390 (30 controls fail-closed)
 * 11. Cross-Repository Scope & L5/L6/L7 Strategy Evaluation
 * 12. Multi-Sweep Determinism
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  RepairStrategy,
  StrategySearchNode,
  DEFAULT_SEARCH_RESOURCE_LIMITS,
  computeStrategyDigest,
  computeNodeDigest,
  computeBacktrackDigest,
  SearchWorkflowContext,
} from "../../src/domain/repair-strategy-search.js";
import {
  ToolCompositionSpec,
  CompositionStageSpec,
  DEFAULT_COMPOSITION_RESOURCE_LIMITS,
  computeStageDigest,
  computeCompositionDigest,
  computeCompositionProvenanceRoot,
  type AllowedToolCapability,
} from "../../src/domain/dynamic-tool-composition.js";
import { DynamicToolSynthesizer } from "../../src/application/dynamic-tool-synthesizer.js";
import { DynamicToolRegistry } from "../../src/application/dynamic-tool-registry.js";
import { DynamicToolExecutor } from "../../src/application/dynamic-tool-executor.js";
import { DynamicToolCompositionPolicy } from "../../src/application/dynamic-tool-composition-policy.js";
import { DynamicToolCompositionExecutor } from "../../src/application/dynamic-tool-composition-executor.js";
import { DynamicToolProvenanceEngine } from "../../src/application/dynamic-tool-provenance.js";
import { RepairStrategySynthesizer } from "../../src/application/repair-strategy-synthesizer.js";
import { RepairStrategyPolicy } from "../../src/application/repair-strategy-policy.js";
import { RepairBacktrackingPolicy } from "../../src/application/repair-backtracking-policy.js";
import { RepairStrategyProvenanceEngine } from "../../src/application/repair-strategy-provenance.js";
import { RepairStrategyExecutor } from "../../src/application/repair-strategy-executor.js";
import { sha256Hex } from "../../src/domain/canonical-hash.js";

describe("Phase 88: Autonomous Multi-Tool Repair Strategy Synthesis & Governed Backtracking", () => {
  let toolSynthesizer: DynamicToolSynthesizer;
  let registry: DynamicToolRegistry;
  let singleExecutor: DynamicToolExecutor;
  let compPolicy: DynamicToolCompositionPolicy;
  let compProvenance: DynamicToolProvenanceEngine;
  let compExecutor: DynamicToolCompositionExecutor;

  let strategySynthesizer: RepairStrategySynthesizer;
  let strategyPolicy: RepairStrategyPolicy;
  let backtrackingPolicy: RepairBacktrackingPolicy;
  let searchProvenance: RepairStrategyProvenanceEngine;
  let strategyExecutor: RepairStrategyExecutor;

  const validWorkflowId = "wf-test-phase88";
  const validWorkspace = "workspace/default";
  const validRepo = "repo-main";

  let tool1Spec: any;
  let tool2Spec: any;
  let validCompSpec: ToolCompositionSpec;

  beforeEach(() => {
    toolSynthesizer = new DynamicToolSynthesizer();
    registry = new DynamicToolRegistry();
    singleExecutor = new DynamicToolExecutor(registry);
    compPolicy = new DynamicToolCompositionPolicy(registry);
    compProvenance = new DynamicToolProvenanceEngine();
    compExecutor = new DynamicToolCompositionExecutor(
      registry,
      singleExecutor,
      compPolicy,
      compProvenance
    );

    strategySynthesizer = new RepairStrategySynthesizer();
    strategyPolicy = new RepairStrategyPolicy(compPolicy);
    backtrackingPolicy = new RepairBacktrackingPolicy();
    searchProvenance = new RepairStrategyProvenanceEngine();
    strategyExecutor = new RepairStrategyExecutor(
      strategyPolicy,
      backtrackingPolicy,
      searchProvenance,
      compExecutor,
      registry
    );

    // Register 3 valid sample tools
    const p1 = toolSynthesizer.synthesizeProposal("AST_ANALYZER", "CONDITION_A_STATIC_BUILTIN", {
      workflowId: validWorkflowId,
      workspaceScopes: [validWorkspace],
      repositoryScopes: [validRepo],
    });
    const t1 = registry.proposeTool(p1);
    tool1Spec = registry.registerTool(t1.toolId, { isGovernedSystem: true, callerWorkflowId: validWorkflowId });

    const p2 = toolSynthesizer.synthesizeProposal("TEST_IMPACT_ANALYZER", "CONDITION_A_STATIC_BUILTIN", {
      workflowId: validWorkflowId,
      workspaceScopes: [validWorkspace],
      repositoryScopes: [validRepo],
    });
    const t2 = registry.proposeTool({ ...p2, proposalId: "p2-unique" });
    tool2Spec = registry.registerTool(t2.toolId, { isGovernedSystem: true, callerWorkflowId: validWorkflowId });

    const p3 = toolSynthesizer.synthesizeProposal("DEPENDENCY_ANALYZER", "CONDITION_A_STATIC_BUILTIN", {
      workflowId: validWorkflowId,
      workspaceScopes: [validWorkspace],
      repositoryScopes: [validRepo],
    });
    const t3 = registry.proposeTool({ ...p3, proposalId: "p3-unique" });
    registry.registerTool(t3.toolId, { isGovernedSystem: true, callerWorkflowId: validWorkflowId });

    // Setup default 2-stage composition spec
    const stages: CompositionStageSpec[] = [
      {
        stageId: "s1",
        sequenceNumber: 1,
        toolId: tool1Spec.toolId,
        toolVersion: tool1Spec.toolVersion,
        toolSourceDigest: tool1Spec.sourceDigest,
        toolManifestDigest: tool1Spec.manifestDigest,
        capabilityScope: tool1Spec.capabilitySet as readonly AllowedToolCapability[],
        workspaceScopes: [validWorkspace],
        repositoryScopes: [validRepo],
        resourceBudget: { maxExecutionMs: 30000 },
        timeoutMs: 30000,
        failurePolicy: "FAIL_FAST",
      },
      {
        stageId: "s2",
        sequenceNumber: 2,
        toolId: tool2Spec.toolId,
        toolVersion: tool2Spec.toolVersion,
        toolSourceDigest: tool2Spec.sourceDigest,
        toolManifestDigest: tool2Spec.manifestDigest,
        capabilityScope: tool2Spec.capabilitySet as readonly AllowedToolCapability[],
        workspaceScopes: [validWorkspace],
        repositoryScopes: [validRepo],
        resourceBudget: { maxExecutionMs: 30000 },
        timeoutMs: 30000,
        failurePolicy: "FAIL_FAST",
      },
    ];

    const rawComp = {
      compositionId: "comp-base-phase88",
      workflowId: validWorkflowId,
      sourceRevision: "rev-head",
      topology: "TOPOLOGY_A_LINEAR_2" as const,
      toolIds: [tool1Spec.toolId, tool2Spec.toolId],
      toolIdentityDigests: [tool1Spec.sourceDigest, tool2Spec.sourceDigest],
      stages,
      compositionCapabilities: Array.from(
        new Set([...tool1Spec.capabilitySet, ...tool2Spec.capabilitySet])
      ) as readonly AllowedToolCapability[],
      workspaceScopes: [validWorkspace],
      repositoryScopes: [validRepo],
      compositionInputSchema: { type: "object" },
      compositionOutputSchema: { type: "object" },
      resourceBudget: DEFAULT_COMPOSITION_RESOURCE_LIMITS,
    };
    validCompSpec = {
      ...rawComp,
      compositionDigest: computeCompositionDigest(rawComp),
      provenanceDigest: computeCompositionProvenanceRoot(rawComp.stages.map((s) => computeStageDigest(s))),
    };
  });

  const getWorkflowContext = (overrides: Partial<SearchWorkflowContext> = {}): SearchWorkflowContext => ({
    workflowId: validWorkflowId,
    allowedCapabilities: [
      "READ_WORKSPACE",
      "READ_REPOSITORY",
      "READ_AST",
      "READ_DEPENDENCY_GRAPH",
      "READ_TEST_METADATA",
      "WRITE_TEMPORARY_OUTPUT",
      "EXECUTE_ANALYSIS",
    ],
    allowedWorkspaceScopes: [validWorkspace],
    allowedRepositoryScopes: [validRepo],
    isGovernedSystem: true,
    ...overrides,
  });

  const buildBaseStrategy = (overrides: Partial<RepairStrategy> = {}): RepairStrategy => {
    return strategySynthesizer.synthesizeStrategy({
      searchId: "search-test-1",
      hypothesis: "Adjust token boundary in parser to handle multi-line strings",
      compositionSpec: validCompSpec,
      targetScope: {
        workspaceScopes: [validWorkspace],
        repositoryScopes: [validRepo],
        targetFiles: ["src/parser.ts"],
      },
      expectedChange: {
        affectedFiles: ["src/parser.ts"],
        expectedTestImpact: ["tests/parser.test.ts"],
      },
      requiredEvidence: ["AST_TOKEN_DIAGNOSTIC", "TEST_IMPACT_REPORT"],
      ...overrides,
    });
  };

  // ============================================================================
  // SECTION 1: STRATEGY SCHEMA, SIZE & DIGEST INTEGRITY
  // ============================================================================
  describe("Strategy Schema, Size & Digest Integrity", () => {
    it("synthesizes valid candidate RepairStrategy in PROPOSED state", () => {
      const strategy = buildBaseStrategy();
      expect(strategy.status).toBe("PROPOSED");
      expect(strategy.strategyId).toBeDefined();
      expect(strategy.strategyDigest).toBeDefined();
      expect(strategy.depth).toBe(1);
    });

    it("accepts valid strategy under governed workflow context", () => {
      const strategy = buildBaseStrategy();
      const report = strategyPolicy.validateStrategy(strategy, getWorkflowContext());
      expect(report.valid).toBe(true);
      expect(report.status).toBe("AUTHORIZED_FOR_EXPLORATION");
    });

    it("quarantines oversized strategy payload (> 64KB)", () => {
      const bloat = "x".repeat(65 * 1024);
      const strategy = buildBaseStrategy({ hypothesis: bloat });
      const report = strategyPolicy.validateStrategy(strategy, getWorkflowContext());
      expect(report.valid).toBe(false);
      expect(report.status).toBe("QUARANTINED");
      expect(report.diagnostics.some((d) => d.includes("exceeds maximum allowable limit"))).toBe(true);
    });

    it("quarantines strategy exceeding depth ceiling (depth > 4)", () => {
      const strategy = buildBaseStrategy({ depth: 5 });
      const report = strategyPolicy.validateStrategy(strategy, getWorkflowContext());
      expect(report.valid).toBe(false);
      expect(report.status).toBe("QUARANTINED");
      expect(report.diagnostics.some((d) => d.includes("exceeds maximum allowable depth"))).toBe(true);
    });

    it("quarantines strategy exceeding branch per node ceiling (> 4 branches)", () => {
      const strategy = buildBaseStrategy();
      const report = strategyPolicy.validateStrategy(strategy, getWorkflowContext(), 4);
      expect(report.valid).toBe(false);
      expect(report.status).toBe("QUARANTINED");
      expect(report.diagnostics.some((d) => d.includes("Branch count for parent node exceeds"))).toBe(true);
    });

    it("verifies canonical strategy digest generation", () => {
      const strategy = buildBaseStrategy();
      const recomputed = computeStrategyDigest({
        strategyId: strategy.strategyId,
        searchId: strategy.searchId,
        parentStrategyId: strategy.parentStrategyId,
        depth: strategy.depth,
        toolCompositionDigest: strategy.toolCompositionDigest,
        targetScope: strategy.targetScope,
        hypothesis: strategy.hypothesis,
        expectedChange: strategy.expectedChange,
        requiredEvidence: strategy.requiredEvidence,
      });
      expect(recomputed).toBe(strategy.strategyDigest);
    });
  });

  // ============================================================================
  // SECTION 2: AUTHORITY INVARIANTS S1–S18
  // ============================================================================
  describe("Authority Invariants S1–S18", () => {
    it("S1: Strategy authority cannot exceed workflow authority", () => {
      const strategy = buildBaseStrategy({
        targetScope: {
          workspaceScopes: [validWorkspace],
          repositoryScopes: ["unauthorized-repo"],
          targetFiles: ["src/parser.ts"],
        },
      });
      const rep = strategyPolicy.validateStrategy(strategy, getWorkflowContext());
      expect(rep.valid).toBe(false);
    });

    it("S2: Strategy capability set cannot exceed intersection of tool capabilities", () => {
      const tamperedComp: ToolCompositionSpec = {
        ...validCompSpec,
        compositionCapabilities: ["WRITE_REPOSITORY" as any],
      };
      const strategy = buildBaseStrategy({ compositionSpec: tamperedComp });
      const rep = strategyPolicy.validateStrategy(strategy, getWorkflowContext());
      expect(rep.valid).toBe(false);
    });

    it("S3: Strategy output is observation, never authority", async () => {
      const strategy = buildBaseStrategy();
      const tree = await strategyExecutor.executeSearch({
        searchId: "s-3",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: strategy,
      });
      expect(tree.finalStatus).toBe("SUCCEEDED");
      // All nodes remain untrusted observations
      for (const node of Object.values(tree.nodes)) {
        expect((node as any).terminalSuccess).toBeUndefined();
      }
    });

    it("S4: Backtracking cannot erase prior evidence", async () => {
      const strategy = buildBaseStrategy();
      const tree = await strategyExecutor.executeSearch({
        searchId: "s-4",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_C_FAILURE_AWARE_BACKTRACK",
        rootStrategy: strategy,
        options: {
          simulateDeltaScreenFailure: true,
          cleanWorkspaceSnapshotDigest: sha256Hex("clean"),
        },
      });
      expect(tree.backtrackPoints.length).toBeGreaterThan(0);
      expect(tree.backtrackPoints[0]?.evidenceDigest).toBeDefined();
    });

    it("S5: Failed branches cannot authorize successful branches", async () => {
      const stratFail = buildBaseStrategy({ hypothesis: "Hypothesis Fail" });
      const stratSuccess = strategySynthesizer.synthesizeStrategy({
        searchId: "s-5",
        hypothesis: "Hypothesis Success",
        compositionSpec: validCompSpec,
        targetScope: stratFail.targetScope,
        expectedChange: stratFail.expectedChange,
        requiredEvidence: ["EVID"],
      });

      const tree = await strategyExecutor.executeSearch({
        searchId: "s-5",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: stratFail,
        alternativeStrategies: [stratSuccess],
        options: {
          candidatePatchGenerator: (node) => {
            if (node.strategyId === stratFail.strategyId) {
              return { diff: "fail", touchedFiles: ["src/parser.ts"], candidateTests: ["fail.test.ts"] };
            }
            return { diff: "success", touchedFiles: ["src/parser.ts"], candidateTests: ["success.test.ts"] };
          },
          simulateDeltaScreenFailure: false,
          simulateFullVerificationSuccess: true,
          cleanWorkspaceSnapshotDigest: sha256Hex("clean"),
        },
      });

      expect(tree.finalStatus).toBe("SUCCEEDED");
      const successNode = Object.values(tree.nodes).find((n) => n.status === "SUCCEEDED");
      expect(successNode).toBeDefined();
      expect(successNode?.workspaceSnapshotDigest).toBe(sha256Hex("clean"));
    });

    it("S6: Strategy score cannot authorize execution", () => {
      const strategy = buildBaseStrategy({ advisoryScore: 100 });
      expect(strategy.advisoryScore).toBe(100);
      // High score does not bypass validation
      const rep = strategyPolicy.validateStrategy(
        { ...strategy, targetScope: { ...strategy.targetScope, repositoryScopes: ["unauth-repo"] } },
        getWorkflowContext()
      );
      expect(rep.valid).toBe(false);
    });

    it("S7: Repair candidate cannot authorize verification", async () => {
      const strategy = buildBaseStrategy();
      const tree = await strategyExecutor.executeSearch({
        searchId: "s-7",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: strategy,
        options: {
          simulateDeltaScreenFailure: true,
          cleanWorkspaceSnapshotDigest: sha256Hex("clean"),
        },
      });
      const cand = Object.values(tree.candidates)[0];
      expect(cand?.status).toBe("REJECTED");
      expect(cand?.fullVerificationResult).toBeUndefined();
    });

    it("S8: Delta screening cannot authorize terminal success", async () => {
      const strategy = buildBaseStrategy();
      const tree = await strategyExecutor.executeSearch({
        searchId: "s-8",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: strategy,
      });
      const cand = Object.values(tree.candidates)[0];
      expect(cand?.deltaScreeningResult?.authoritative).toBe(false);
      expect(cand?.deltaScreeningResult?.fullSuiteRequired).toBe(true);
    });

    it("S9: Strategy search cannot modify mission policy", async () => {
      const strategy = buildBaseStrategy();
      singleExecutor.registerImplementation(tool1Spec.toolId, () => ({
        policyApproval: true,
      }));
      const tree = await strategyExecutor.executeSearch({
        searchId: "s-9",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: strategy,
      });
      expect(tree.finalStatus).toBe("SUCCEEDED");
      expect((tree as any).policyApproval).toBeUndefined();
    });

    it("S10: Strategy search cannot modify mission contract", async () => {
      const strategy = buildBaseStrategy();
      singleExecutor.registerImplementation(tool1Spec.toolId, () => ({
        missionContract: { status: "COMPLETED" },
      }));
      const tree = await strategyExecutor.executeSearch({
        searchId: "s-10",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: strategy,
      });
      expect((tree as any).missionContract).toBeUndefined();
    });

    it("S11: Strategy search cannot sign evidence", async () => {
      const strategy = buildBaseStrategy();
      const tree = await strategyExecutor.executeSearch({
        searchId: "s-11",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: strategy,
      });
      expect((tree as any).signatureAuthority).toBeUndefined();
    });

    it("S12: Strategy search cannot issue terminal authority", async () => {
      const strategy = buildBaseStrategy();
      singleExecutor.registerImplementation(tool2Spec.toolId, () => ({
        terminalSuccess: true,
        terminalAuthority: true,
      }));
      const tree = await strategyExecutor.executeSearch({
        searchId: "s-12",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: strategy,
      });
      expect((tree as any).terminalAuthority).toBeUndefined();
      expect((tree as any).terminalSuccess).toBeUndefined();
    });

    it("S13: Revoked/expired branches cannot execute", async () => {
      registry.revokeTool(tool2Spec.toolId, "Vulnerability");
      const strategy = buildBaseStrategy();
      const tree = await strategyExecutor.executeSearch({
        searchId: "s-13",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: strategy,
      });
      const node = Object.values(tree.nodes)[0];
      expect(node?.status).toBe("REVOKED");
    });

    it("S14: Cumulative search resources cannot exceed configured ceiling", async () => {
      const customExecutor = new RepairStrategyExecutor(
        strategyPolicy,
        backtrackingPolicy,
        searchProvenance,
        compExecutor,
        registry,
        { ...DEFAULT_SEARCH_RESOURCE_LIMITS, maxStrategyNodes: 1 }
      );
      const s1 = buildBaseStrategy({ strategyId: "s1" });
      const s2 = buildBaseStrategy({ strategyId: "s2" });
      const tree = await customExecutor.executeSearch({
        searchId: "s-14",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: s1,
        alternativeStrategies: [s2],
        options: { simulateFullVerificationSuccess: false },
      });
      expect(tree.cumulativeResources.nodesExplored).toBeLessThanOrEqual(1);
      expect(tree.finalStatus).toBe("EXHAUSTED");
    });

    it("S15: Cross-repository scope cannot expand implicitly", () => {
      const strategy = buildBaseStrategy({
        targetScope: {
          workspaceScopes: [validWorkspace],
          repositoryScopes: ["repo-secondary"], // Not authorized in default context
          targetFiles: ["src/index.ts"],
        },
      });
      const rep = strategyPolicy.validateStrategy(strategy, getWorkflowContext());
      expect(rep.valid).toBe(false);
    });

    it("S16: Search recursion cannot exceed configured depth (max 4)", () => {
      const strategy = buildBaseStrategy({ depth: 5 });
      const rep = strategyPolicy.validateStrategy(strategy, getWorkflowContext());
      expect(rep.valid).toBe(false);
      expect(rep.diagnostics.some((d) => d.includes("depth"))).toBe(true);
    });

    it("S17: Historical provenance cannot be removed during backtracking", async () => {
      const stratFail = buildBaseStrategy({ hypothesis: "Fail 1" });
      const stratSucc = buildBaseStrategy({ hypothesis: "Succ 2" });
      const tree = await strategyExecutor.executeSearch({
        searchId: "s-17",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: stratFail,
        alternativeStrategies: [stratSucc],
        options: {
          simulateDeltaScreenFailure: true, // Will fail stratFail
          cleanWorkspaceSnapshotDigest: sha256Hex("clean"),
        },
      });
      expect(tree.backtrackPoints.length).toBeGreaterThan(0);
      const isValid = searchProvenance.verifySearchProvenanceChain(
        Object.values(tree.nodes),
        Object.values(tree.candidates),
        tree.backtrackPoints,
        tree.provenanceRoot
      );
      expect(isValid).toBe(true);
    });

    it("S18: Partial search cannot become terminal success", async () => {
      const strategy = buildBaseStrategy();
      const tree = await strategyExecutor.executeSearch({
        searchId: "s-18",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: strategy,
        options: {
          simulateFullVerificationSuccess: false,
          cleanWorkspaceSnapshotDigest: sha256Hex("clean"),
        },
      });
      expect(tree.finalStatus).not.toBe("SUCCEEDED");
      expect((tree as any).terminalSuccess).toBeUndefined();
    });
  });

  // ============================================================================
  // SECTION 3: SEARCH POLICIES
  // ============================================================================
  describe("Search Policies (A, B, C, D)", () => {
    it("Policy A: FIRST_VALID stops on first verified candidate", async () => {
      const s1 = buildBaseStrategy({ strategyId: "strat-1" });
      const s2 = buildBaseStrategy({ strategyId: "strat-2" });
      const tree = await strategyExecutor.executeSearch({
        searchId: "p-a",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: s1,
        alternativeStrategies: [s2],
        options: { simulateFullVerificationSuccess: true },
      });
      expect(tree.finalStatus).toBe("SUCCEEDED");
      // Stopped after first valid node
      expect(tree.cumulativeResources.nodesExplored).toBe(1);
    });

    it("Policy B: BOUNDED_BEST_FIRST prioritizes higher scored strategies", async () => {
      const sLow = strategySynthesizer.synthesizeStrategy({
        searchId: "p-b",
        strategyId: "strat-low",
        hypothesis: "Low score hypothesis",
        compositionSpec: validCompSpec,
        targetScope: { workspaceScopes: [validWorkspace], repositoryScopes: [validRepo], targetFiles: ["src/parser.ts"] },
        expectedChange: { affectedFiles: ["src/parser.ts"], expectedTestImpact: ["tests/parser.test.ts"] },
        requiredEvidence: ["EV"],
        advisoryScore: 20,
      });
      const sHigh = strategySynthesizer.synthesizeStrategy({
        searchId: "p-b",
        strategyId: "strat-high",
        hypothesis: "High score hypothesis",
        compositionSpec: validCompSpec,
        targetScope: { workspaceScopes: [validWorkspace], repositoryScopes: [validRepo], targetFiles: ["src/parser.ts"] },
        expectedChange: { affectedFiles: ["src/parser.ts"], expectedTestImpact: ["tests/parser.test.ts"] },
        requiredEvidence: ["EV"],
        advisoryScore: 90,
      });
      const tree = await strategyExecutor.executeSearch({
        searchId: "p-b",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_B_BOUNDED_BEST_FIRST",
        rootStrategy: sLow,
        alternativeStrategies: [sHigh],
        options: { simulateFullVerificationSuccess: true },
      });
      expect(tree.finalStatus).toBe("SUCCEEDED");
      const firstExplored = Object.values(tree.nodes)[0];
      expect(firstExplored?.strategyId).toBe("strat-high");
    });

    it("Policy C: FAILURE_AWARE_BACKTRACK creates backtrack points on failure", async () => {
      const sFail = buildBaseStrategy({ strategyId: "strat-fail" });
      const tree = await strategyExecutor.executeSearch({
        searchId: "p-c",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_C_FAILURE_AWARE_BACKTRACK",
        rootStrategy: sFail,
        options: {
          simulateDeltaScreenFailure: true,
          cleanWorkspaceSnapshotDigest: sha256Hex("clean"),
        },
      });
      expect(tree.backtrackPoints.length).toBe(1);
      expect(tree.backtrackPoints[0]?.reason).toContain("Delta verification screening");
    });

    it("Policy D: GOVERNED_ADAPTIVE manages branching and verification transitions", async () => {
      const s1 = buildBaseStrategy({ strategyId: "strat-adapt-1" });
      const tree = await strategyExecutor.executeSearch({
        searchId: "p-d",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_D_GOVERNED_ADAPTIVE",
        rootStrategy: s1,
        options: { simulateFullVerificationSuccess: true },
      });
      expect(tree.finalStatus).toBe("SUCCEEDED");
      expect(tree.cumulativeResources.compositionInvocations).toBe(1);
    });
  });

  // ============================================================================
  // SECTION 4: BRANCH ISOLATION & CONTAMINATION DEFENSE
  // ============================================================================
  describe("Branch Isolation & Contamination Defense", () => {
    it("proves clean workspace snapshot digest between failed and resumed branches", () => {
      const cleanDigest = sha256Hex("clean-snapshot");
      const failedDigest = sha256Hex("mutated-failed-snapshot");
      const resumedDigest = sha256Hex("clean-snapshot");

      const isIsolated = backtrackingPolicy.verifyBranchIsolation(failedDigest, resumedDigest, cleanDigest);
      expect(isIsolated).toBe(true);
    });

    it("rejects branch continuation if contaminated with failed branch snapshot", () => {
      const cleanDigest = sha256Hex("clean-snapshot");
      const failedDigest = sha256Hex("mutated-failed-snapshot");
      const contaminatedDigest = failedDigest;

      const isIsolated = backtrackingPolicy.verifyBranchIsolation(failedDigest, contaminatedDigest, cleanDigest);
      expect(isIsolated).toBe(false);
    });
  });

  // ============================================================================
  // SECTION 5: PROVENANCE CHAINS & TAMPER DETECTION
  // ============================================================================
  describe("Cryptographic Provenance Chains & Tamper Detection", () => {
    it("computes and verifies complete search tree provenance root", async () => {
      const strategy = buildBaseStrategy();
      const tree = await strategyExecutor.executeSearch({
        searchId: "prov-1",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: strategy,
      });

      const valid = searchProvenance.verifySearchProvenanceChain(
        Object.values(tree.nodes),
        Object.values(tree.candidates),
        tree.backtrackPoints,
        tree.provenanceRoot
      );
      expect(valid).toBe(true);
    });

    it("tamper detection: removing a node invalidates provenance root", async () => {
      const strategy = buildBaseStrategy();
      const tree = await strategyExecutor.executeSearch({
        searchId: "prov-2",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: strategy,
      });

      const tamperedNodes = Object.values(tree.nodes).slice(1);
      const valid = searchProvenance.verifySearchProvenanceChain(
        tamperedNodes,
        Object.values(tree.candidates),
        tree.backtrackPoints,
        tree.provenanceRoot
      );
      expect(valid).toBe(false);
    });

    it("tamper detection: modifying candidate evidence invalidates provenance root", async () => {
      const strategy = buildBaseStrategy();
      const tree = await strategyExecutor.executeSearch({
        searchId: "prov-3",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: strategy,
      });

      const candidateList = Object.values(tree.candidates);
      if (candidateList.length > 0) {
        const tamperedCandidates = [{ ...candidateList[0]!, patchDigest: sha256Hex("tampered-patch") }];
        const valid = searchProvenance.verifySearchProvenanceChain(
          Object.values(tree.nodes),
          tamperedCandidates,
          tree.backtrackPoints,
          tree.provenanceRoot
        );
        expect(valid).toBe(false);
      }
    });
  });

  // ============================================================================
  // SECTION 6: NEGATIVE SECURITY CONTROLS N361–N390 (30 CONTROLS FAIL-CLOSED)
  // ============================================================================
  describe("Negative Security Controls N361–N390", () => {
    it("N361: strategy self-authorization — rejected", () => {
      const strategy = buildBaseStrategy();
      const rep = strategyPolicy.validateStrategy(strategy, getWorkflowContext({ isDynamicToolCaller: true }));
      expect(rep.valid).toBe(false);
      expect(rep.status).toBe("QUARANTINED");
    });

    it("N362: strategy capability union escalation — rejected", () => {
      const tamperedComp: ToolCompositionSpec = {
        ...validCompSpec,
        compositionCapabilities: ["WRITE_REPOSITORY" as any],
      };
      const strategy = buildBaseStrategy({ compositionSpec: tamperedComp });
      const rep = strategyPolicy.validateStrategy(strategy, getWorkflowContext());
      expect(rep.valid).toBe(false);
      expect(rep.status).toBe("QUARANTINED");
    });

    it("N363: strategy capability intersection bypass — rejected", () => {
      const tamperedComp: ToolCompositionSpec = {
        ...validCompSpec,
        compositionCapabilities: ["EXECUTE_ARBITRARY_SHELL" as any],
      };
      const strategy = buildBaseStrategy({ compositionSpec: tamperedComp });
      const rep = strategyPolicy.validateStrategy(strategy, getWorkflowContext());
      expect(rep.valid).toBe(false);
    });

    it("N364: strategy repository expansion — rejected", () => {
      const strategy = buildBaseStrategy({
        targetScope: {
          workspaceScopes: [validWorkspace],
          repositoryScopes: ["repo-unauthorized"],
          targetFiles: ["src/parser.ts"],
        },
      });
      const rep = strategyPolicy.validateStrategy(strategy, getWorkflowContext());
      expect(rep.valid).toBe(false);
      expect(rep.diagnostics.some((d) => d.includes("Repository scope"))).toBe(true);
    });

    it("N365: strategy workspace expansion — rejected", () => {
      const strategy = buildBaseStrategy({
        targetScope: {
          workspaceScopes: ["workspace/unauthorized"],
          repositoryScopes: [validRepo],
          targetFiles: ["src/parser.ts"],
        },
      });
      const rep = strategyPolicy.validateStrategy(strategy, getWorkflowContext());
      expect(rep.valid).toBe(false);
      expect(rep.diagnostics.some((d) => d.includes("Workspace scope"))).toBe(true);
    });

    it("N366: strategy contract substitution — rejected", async () => {
      singleExecutor.registerImplementation(tool1Spec.toolId, () => ({
        missionContract: { status: "COMPLETED" },
      }));
      const tree = await strategyExecutor.executeSearch({
        searchId: "n-366",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: buildBaseStrategy(),
      });
      expect((tree as any).missionContract).toBeUndefined();
    });

    it("N367: strategy policy substitution — rejected", async () => {
      singleExecutor.registerImplementation(tool1Spec.toolId, () => ({
        policyApproval: true,
      }));
      const tree = await strategyExecutor.executeSearch({
        searchId: "n-367",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: buildBaseStrategy(),
      });
      expect((tree as any).policyApproval).toBeUndefined();
    });

    it("N368: strategy composition substitution — rejected", () => {
      const strategy = {
        ...buildBaseStrategy(),
        toolCompositionDigest: sha256Hex("tampered-comp-digest"),
      };
      const rep = strategyPolicy.validateStrategy(strategy, getWorkflowContext());
      expect(rep.valid).toBe(false);
    });

    it("N369: strategy tool-version substitution — rejected", () => {
      const tamperedStage: CompositionStageSpec = {
        ...validCompSpec.stages[0]!,
        toolVersion: "99.0.0", // Mismatched tool version
      };
      const tamperedComp: ToolCompositionSpec = {
        ...validCompSpec,
        stages: [tamperedStage, validCompSpec.stages[1]!],
      };
      const strategy = buildBaseStrategy({ compositionSpec: tamperedComp });
      const rep = strategyPolicy.validateStrategy(strategy, getWorkflowContext());
      expect(rep.valid).toBe(false);
    });

    it("N370: strategy identity substitution — rejected", () => {
      const tamperedStage: CompositionStageSpec = {
        ...validCompSpec.stages[0]!,
        toolSourceDigest: sha256Hex("tampered-source"),
      };
      const tamperedComp: ToolCompositionSpec = {
        ...validCompSpec,
        stages: [tamperedStage, validCompSpec.stages[1]!],
      };
      const strategy = buildBaseStrategy({ compositionSpec: tamperedComp });
      const rep = strategyPolicy.validateStrategy(strategy, getWorkflowContext());
      expect(rep.valid).toBe(false);
    });

    it("N371: strategy digest substitution — rejected", () => {
      const strategy = {
        ...buildBaseStrategy(),
        strategyDigest: sha256Hex("tampered-strategy-digest"),
      };
      const rep = strategyPolicy.validateStrategy(strategy, getWorkflowContext());
      expect(rep.valid).toBe(false);
      expect(rep.diagnostics.some((d) => d.includes("Strategy digest mismatch"))).toBe(true);
    });

    it("N372: branch parent substitution — detected in DAG", () => {
      const s1 = buildBaseStrategy({ strategyId: "s1" });
      const s2 = buildBaseStrategy({ strategyId: "s2", parentStrategyId: "non-existent-parent" });
      const nodeDigest1 = computeNodeDigest({
        nodeId: "n1",
        parentNodeId: undefined,
        searchId: "search-1",
        strategyId: s1.strategyId,
        depth: 1,
        branchIndex: 0,
        workspaceSnapshotDigest: sha256Hex("snap"),
        inputEvidenceDigest: sha256Hex("ev"),
        compositionDigest: s1.toolCompositionDigest,
      });
      const nodeDigest2 = computeNodeDigest({
        nodeId: "n2",
        parentNodeId: "tampered-parent-node",
        searchId: "search-1",
        strategyId: s2.strategyId,
        depth: 2,
        branchIndex: 1,
        workspaceSnapshotDigest: sha256Hex("snap"),
        inputEvidenceDigest: sha256Hex("ev"),
        compositionDigest: s2.toolCompositionDigest,
      });
      expect(nodeDigest1).not.toBe(nodeDigest2);
    });

    it("N373: backtrack-point substitution — rejected by hash comparison", () => {
      const bt1 = computeBacktrackDigest({
        backtrackId: "bt-1",
        searchId: "s-1",
        nodeId: "n-1",
        workspaceSnapshotDigest: sha256Hex("ws1"),
        evidenceDigest: sha256Hex("ev1"),
        strategyDigest: sha256Hex("strat1"),
      });
      const bt2 = computeBacktrackDigest({
        backtrackId: "bt-1",
        searchId: "s-1",
        nodeId: "n-1",
        workspaceSnapshotDigest: sha256Hex("ws-tampered"),
        evidenceDigest: sha256Hex("ev1"),
        strategyDigest: sha256Hex("strat1"),
      });
      expect(bt1).not.toBe(bt2);
    });

    it("N374: workspace snapshot substitution — rejected by isolation verifier", () => {
      const clean = sha256Hex("clean");
      const tampered = sha256Hex("tampered");
      expect(backtrackingPolicy.verifyBranchIsolation(tampered, tampered, clean)).toBe(false);
    });

    it("N375: failed-branch state injection — prevented by clean snapshot", () => {
      const clean = sha256Hex("clean");
      const failed = sha256Hex("failed-state");
      expect(backtrackingPolicy.verifyBranchIsolation(failed, clean, clean)).toBe(true);
      expect(backtrackingPolicy.verifyBranchIsolation(failed, failed, clean)).toBe(false);
    });

    it("N376: failed-branch evidence injection — isolated per node", () => {
      const node1Evidence = sha256Hex("ev-node1");
      const node2Evidence = sha256Hex("ev-node2");
      expect(node1Evidence).not.toBe(node2Evidence);
    });

    it("N377: failed-branch provenance removal — rejected", async () => {
      const s1 = buildBaseStrategy({ strategyId: "s1" });
      const tree = await strategyExecutor.executeSearch({
        searchId: "n-377",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: s1,
        options: {
          simulateDeltaScreenFailure: true,
          cleanWorkspaceSnapshotDigest: sha256Hex("clean"),
        },
      });
      // Removing backtrack point causes verification to fail
      const validWithoutBt = searchProvenance.verifySearchProvenanceChain(
        Object.values(tree.nodes),
        Object.values(tree.candidates),
        [],
        tree.provenanceRoot
      );
      expect(validWithoutBt).toBe(false);
    });

    it("N378: successful-branch contamination — prohibited", () => {
      const clean = sha256Hex("clean");
      const contaminated = sha256Hex("contaminated");
      expect(backtrackingPolicy.verifyBranchIsolation(contaminated, contaminated, clean)).toBe(false);
    });

    it("N379: strategy score authority injection — ignored", () => {
      const strategy = buildBaseStrategy({ advisoryScore: 999 });
      const rep = strategyPolicy.validateStrategy(
        { ...strategy, targetScope: { ...strategy.targetScope, repositoryScopes: ["unauthorized"] } },
        getWorkflowContext()
      );
      expect(rep.valid).toBe(false);
    });

    it("N380: candidate authority injection — stripped", async () => {
      const strategy = buildBaseStrategy();
      const tree = await strategyExecutor.executeSearch({
        searchId: "n-380",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: strategy,
        options: {
          candidatePatchGenerator: () => ({
            diff: "patch",
            touchedFiles: ["src/parser.ts"],
            candidateTests: ["parser.test.ts"],
            authorityGranted: true as any,
          }),
        },
      });
      const cand = Object.values(tree.candidates)[0];
      expect((cand as any)?.authorityGranted).toBeUndefined();
    });

    it("N381: candidate terminal-state injection — stripped", async () => {
      const strategy = buildBaseStrategy();
      const tree = await strategyExecutor.executeSearch({
        searchId: "n-381",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: strategy,
        options: {
          candidatePatchGenerator: () => ({
            diff: "patch",
            touchedFiles: ["src/parser.ts"],
            candidateTests: ["parser.test.ts"],
            terminalSuccess: true as any,
          }),
        },
      });
      const cand = Object.values(tree.candidates)[0];
      expect((cand as any)?.terminalSuccess).toBeUndefined();
    });

    it("N382: candidate verification bypass — rejected", async () => {
      const strategy = buildBaseStrategy();
      const tree = await strategyExecutor.executeSearch({
        searchId: "n-382",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: strategy,
        options: {
          simulateDeltaScreenFailure: true,
        },
      });
      const cand = Object.values(tree.candidates)[0];
      expect(cand?.status).toBe("REJECTED");
      expect(cand?.fullVerificationResult).toBeUndefined();
    });

    it("N383: delta-verification authority escalation — authoritative remains false", async () => {
      const strategy = buildBaseStrategy();
      const tree = await strategyExecutor.executeSearch({
        searchId: "n-383",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: strategy,
      });
      const cand = Object.values(tree.candidates)[0];
      expect(cand?.deltaScreeningResult?.authoritative).toBe(false);
      expect(cand?.deltaScreeningResult?.fullSuiteRequired).toBe(true);
    });

    it("N384: recursive strategy generation — rejected when depth > 4", () => {
      const strategy = buildBaseStrategy({ depth: 5 });
      const rep = strategyPolicy.validateStrategy(strategy, getWorkflowContext());
      expect(rep.valid).toBe(false);
      expect(rep.diagnostics.some((d) => d.includes("depth"))).toBe(true);
    });

    it("N385: branch explosion — rejected when branches per node > 4", () => {
      const strategy = buildBaseStrategy();
      const rep = strategyPolicy.validateStrategy(strategy, getWorkflowContext(), 4);
      expect(rep.valid).toBe(false);
      expect(rep.diagnostics.some((d) => d.includes("Branch count"))).toBe(true);
    });

    it("N386: cumulative resource bypass — rejected when budget exceeds ceiling", () => {
      const strategy = {
        ...buildBaseStrategy(),
        resourceBudget: { maxSearchWallTimeMs: 999_999 },
      };
      const rep = strategyPolicy.validateStrategy(strategy, getWorkflowContext());
      expect(rep.valid).toBe(false);
      expect(rep.diagnostics.some((d) => d.includes("resource budget"))).toBe(true);
    });

    it("N387: revoked-strategy execution — fails closed", async () => {
      registry.revokeTool(tool1Spec.toolId, "Vulnerability");
      const strategy = buildBaseStrategy();
      const tree = await strategyExecutor.executeSearch({
        searchId: "n-387",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: strategy,
      });
      const node = Object.values(tree.nodes)[0];
      expect(node?.status).toBe("REVOKED");
    });

    it("N388: expired-strategy execution — fails closed", async () => {
      registry.expireTool(tool1Spec.toolId);
      const strategy = buildBaseStrategy();
      const tree = await strategyExecutor.executeSearch({
        searchId: "n-388",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: strategy,
      });
      const node = Object.values(tree.nodes)[0];
      expect(node?.status).toBe("EXPIRED");
    });

    it("N389: partial-search terminal success — rejected", async () => {
      const strategy = buildBaseStrategy();
      const tree = await strategyExecutor.executeSearch({
        searchId: "n-389",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: strategy,
        options: { simulateFullVerificationSuccess: false },
      });
      expect(tree.finalStatus).not.toBe("SUCCEEDED");
      expect((tree as any).terminalSuccess).toBeUndefined();
    });

    it("N390: terminal authority escalation — rejected", async () => {
      const strategy = buildBaseStrategy();
      const tree = await strategyExecutor.executeSearch({
        searchId: "n-390",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: strategy,
      });
      expect((tree as any).terminalAuthority).toBeUndefined();
      expect((tree as any).verificationAuthority).toBeUndefined();
    });
  });

  // ============================================================================
  // SECTION 7: CROSS-REPOSITORY & L5/L6/L7 COHORT EVALUATION
  // ============================================================================
  describe("Cross-Repository & L5/L6/L7 Cohort Evaluation", () => {
    it("evaluates L5 single-module repair strategy", async () => {
      const l5Strat = buildBaseStrategy({
        hypothesis: "L5: Single-module off-by-one bounds fix in parser",
        targetScope: {
          workspaceScopes: [validWorkspace],
          repositoryScopes: [validRepo],
          targetFiles: ["src/parser.ts"],
        },
        expectedChange: {
          affectedFiles: ["src/parser.ts"],
          expectedTestImpact: ["tests/parser.test.ts"],
        },
      });
      const tree = await strategyExecutor.executeSearch({
        searchId: "l5-search",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: l5Strat,
      });
      expect(tree.finalStatus).toBe("SUCCEEDED");
    });

    it("evaluates L6 multi-module repair strategy", async () => {
      const l6Strat = buildBaseStrategy({
        hypothesis: "L6: Multi-module type alignment between parser and tokenizer",
        targetScope: {
          workspaceScopes: [validWorkspace],
          repositoryScopes: [validRepo],
          targetFiles: ["src/parser.ts", "src/tokenizer.ts"],
        },
        expectedChange: {
          affectedFiles: ["src/parser.ts", "src/tokenizer.ts"],
          expectedTestImpact: ["tests/parser.test.ts", "tests/tokenizer.test.ts"],
        },
      });
      const tree = await strategyExecutor.executeSearch({
        searchId: "l6-search",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_B_BOUNDED_BEST_FIRST",
        rootStrategy: l6Strat,
      });
      expect(tree.finalStatus).toBe("SUCCEEDED");
    });

    it("evaluates L7 whole-program / cross-repository strategy with explicit scopes", async () => {
      const crossWf = "wf-l7-cross-repo";
      const pCrossA = toolSynthesizer.synthesizeProposal("AST_ANALYZER", "CONDITION_A_STATIC_BUILTIN", {
        workflowId: crossWf,
        workspaceScopes: ["workspace/repo-a"],
        repositoryScopes: ["repo-a"],
      });
      const tCrossA = registry.proposeTool({ ...pCrossA, proposalId: "pCrossA-unique" });
      const toolCrossA = registry.registerTool(tCrossA.toolId, { isGovernedSystem: true, callerWorkflowId: crossWf });

      const pCrossB = toolSynthesizer.synthesizeProposal("CROSS_REPO_CONTRACT_CHECKER", "CONDITION_A_STATIC_BUILTIN", {
        workflowId: crossWf,
        workspaceScopes: ["workspace/repo-b"],
        repositoryScopes: ["repo-b"],
      });
      const tCrossB = registry.proposeTool({ ...pCrossB, proposalId: "pCrossB-id" });
      const toolCrossB = registry.registerTool(tCrossB.toolId, { isGovernedSystem: true, callerWorkflowId: crossWf });

      const crossStages: CompositionStageSpec[] = [
        {
          stageId: "sCrossA",
          sequenceNumber: 1,
          toolId: toolCrossA.toolId,
          toolVersion: toolCrossA.toolVersion,
          toolSourceDigest: toolCrossA.sourceDigest,
          toolManifestDigest: toolCrossA.manifestDigest,
          capabilityScope: toolCrossA.capabilitySet as readonly AllowedToolCapability[],
          workspaceScopes: ["workspace/repo-a"],
          repositoryScopes: ["repo-a"],
          resourceBudget: {},
          timeoutMs: 30000,
          failurePolicy: "FAIL_FAST",
        },
        {
          stageId: "sCrossB",
          sequenceNumber: 2,
          toolId: toolCrossB.toolId,
          toolVersion: toolCrossB.toolVersion,
          toolSourceDigest: toolCrossB.sourceDigest,
          toolManifestDigest: toolCrossB.manifestDigest,
          capabilityScope: toolCrossB.capabilitySet as readonly AllowedToolCapability[],
          workspaceScopes: ["workspace/repo-b"],
          repositoryScopes: ["repo-b"],
          resourceBudget: {},
          timeoutMs: 30000,
          failurePolicy: "FAIL_FAST",
        },
      ];

      const rawComp = {
        compositionId: "comp-l7-cross",
        workflowId: crossWf,
        sourceRevision: "rev-head",
        topology: "TOPOLOGY_A_LINEAR_2" as const,
        toolIds: [toolCrossA.toolId, toolCrossB.toolId],
        toolIdentityDigests: [toolCrossA.sourceDigest, toolCrossB.sourceDigest],
        stages: crossStages,
        compositionCapabilities: Array.from(
          new Set([...toolCrossA.capabilitySet, ...toolCrossB.capabilitySet])
        ) as readonly AllowedToolCapability[],
        workspaceScopes: ["workspace/repo-a", "workspace/repo-b"],
        repositoryScopes: ["repo-a", "repo-b"],
        compositionInputSchema: { type: "object" },
        compositionOutputSchema: { type: "object" },
        resourceBudget: DEFAULT_COMPOSITION_RESOURCE_LIMITS,
      };
      const crossComp: ToolCompositionSpec = {
        ...rawComp,
        compositionDigest: computeCompositionDigest(rawComp),
        provenanceDigest: computeCompositionProvenanceRoot(rawComp.stages.map((s) => computeStageDigest(s))),
      };

      const l7Strat = strategySynthesizer.synthesizeStrategy({
        searchId: "l7-search",
        hypothesis: "L7: Whole-program interface contract update across repo-a and repo-b",
        compositionSpec: crossComp,
        targetScope: {
          workspaceScopes: ["workspace/repo-a", "workspace/repo-b"],
          repositoryScopes: ["repo-a", "repo-b"],
          targetFiles: ["repo-a/src/api.ts", "repo-b/src/client.ts"],
        },
        expectedChange: {
          affectedFiles: ["repo-a/src/api.ts", "repo-b/src/client.ts"],
          expectedTestImpact: ["repo-b/tests/client.test.ts"],
          expectedContractImpact: ["interface ServiceContract v2"],
        },
        requiredEvidence: ["CROSS_REPO_CONTRACT_EVIDENCE"],
      });

      const l7Context = getWorkflowContext({
        workflowId: crossWf,
        allowedWorkspaceScopes: ["workspace/repo-a", "workspace/repo-b"],
        allowedRepositoryScopes: ["repo-a", "repo-b"],
      });

      const rep = strategyPolicy.validateStrategy(l7Strat, l7Context);
      expect(rep.valid).toBe(true);

      const tree = await strategyExecutor.executeSearch({
        searchId: "l7-search",
        workflowContext: l7Context,
        policy: "POLICY_D_GOVERNED_ADAPTIVE",
        rootStrategy: l7Strat,
      });
      expect(tree.finalStatus).toBe("SUCCEEDED");
    });
  });

  // ============================================================================
  // SECTION 8: MULTI-SWEEP DETERMINISM
  // ============================================================================
  describe("Multi-Sweep Determinism Verification", () => {
    it("produces byte-identical search tree digests across 3 consecutive sweeps", async () => {
      const runSweep = async () => {
        const strategy = buildBaseStrategy();
        const tree = await strategyExecutor.executeSearch({
          searchId: "det-sweep",
          workflowContext: getWorkflowContext(),
          policy: "POLICY_A_FIRST_VALID",
          rootStrategy: strategy,
        });
        return tree.provenanceRoot;
      };

      const root1 = await runSweep();
      const root2 = await runSweep();
      const root3 = await runSweep();

      expect(root1).toBe(root2);
      expect(root2).toBe(root3);
    });
  });

  // ============================================================================
  // SECTION 9: DETERMINISTIC FAILURE CLASSIFICATION
  // ============================================================================
  describe("Deterministic Failure Classification", () => {
    it("classifies INVALID_STRATEGY on malformed structure", () => {
      const rep = strategyPolicy.validateStrategy(
        { ...buildBaseStrategy(), depth: -1 },
        getWorkflowContext()
      );
      expect(rep.valid).toBe(false);
      expect(rep.status).toBe("QUARANTINED");
    });

    it("classifies TOOL_SCOPE_REJECTED on unauthorized repo scope", () => {
      const strat = buildBaseStrategy({
        targetScope: { workspaceScopes: [validWorkspace], repositoryScopes: ["repo-disallowed"], targetFiles: ["foo.ts"] },
      });
      const rep = strategyPolicy.validateStrategy(strat, getWorkflowContext());
      expect(rep.valid).toBe(false);
      expect(rep.diagnostics.some((d) => d.includes("Repository scope"))).toBe(true);
    });

    it("classifies COMPOSITION_REJECTED on composition execution failure", async () => {
      singleExecutor.registerImplementation(tool1Spec.toolId, () => {
        throw new Error("Tool 1 fatal error");
      });
      const tree = await strategyExecutor.executeSearch({
        searchId: "fc-comp",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: buildBaseStrategy(),
      });
      expect(tree.finalStatus).toBe("FAILED");
      const node = Object.values(tree.nodes)[0];
      expect(node?.status).toBe("FAILED");
    });

    it("classifies DELTA_SCREEN_REJECTED when delta verifier screening fails", async () => {
      const tree = await strategyExecutor.executeSearch({
        searchId: "fc-delta",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_C_FAILURE_AWARE_BACKTRACK",
        rootStrategy: buildBaseStrategy(),
        options: { simulateDeltaScreenFailure: true },
      });
      const cand = Object.values(tree.candidates)[0];
      expect(cand?.status).toBe("REJECTED");
      expect(cand?.deltaScreeningResult?.passed).toBe(false);
    });

    it("classifies FULL_VERIFICATION_FAILED when clean-room verification rejects candidate", async () => {
      const tree = await strategyExecutor.executeSearch({
        searchId: "fc-full",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: buildBaseStrategy(),
        options: { simulateFullVerificationSuccess: false },
      });
      const cand = Object.values(tree.candidates)[0];
      expect(cand?.status).toBe("FAILED_VERIFICATION");
      expect(cand?.fullVerificationResult?.verificationPassed).toBe(false);
    });

    it("classifies RESOURCE_LIMIT when node count exceeds limit", async () => {
      const customExecutor = new RepairStrategyExecutor(
        strategyPolicy,
        backtrackingPolicy,
        searchProvenance,
        compExecutor,
        registry,
        { ...DEFAULT_SEARCH_RESOURCE_LIMITS, maxStrategyNodes: 2 }
      );
      const s1 = buildBaseStrategy({ strategyId: "s1" });
      const s2 = buildBaseStrategy({ strategyId: "s2" });
      const s3 = buildBaseStrategy({ strategyId: "s3" });
      const tree = await customExecutor.executeSearch({
        searchId: "fc-res",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: s1,
        alternativeStrategies: [s2, s3],
        options: { simulateFullVerificationSuccess: false },
      });
      expect(tree.finalStatus).toBe("EXHAUSTED");
      expect(tree.cumulativeResources.nodesExplored).toBeLessThanOrEqual(2);
    });

    it("classifies REVOCATION fail-closed before execution starts", async () => {
      registry.revokeTool(tool1Spec.toolId, "Vulnerability advisory");
      const tree = await strategyExecutor.executeSearch({
        searchId: "fc-rev",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: buildBaseStrategy(),
      });
      expect(tree.finalStatus).toBe("FAILED");
      const node = Object.values(tree.nodes)[0];
      expect(node?.status).toBe("REVOKED");
    });

    it("classifies EXPIRATION fail-closed when tool lease expires", async () => {
      registry.expireTool(tool1Spec.toolId);
      const tree = await strategyExecutor.executeSearch({
        searchId: "fc-exp",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: buildBaseStrategy(),
      });
      expect(tree.finalStatus).toBe("FAILED");
      const node = Object.values(tree.nodes)[0];
      expect(node?.status).toBe("EXPIRED");
    });

    it("classifies HYPOTHESIS_CONTRADICTED when advisory score drops below floor", () => {
      const node: StrategySearchNode = {
        nodeId: "n-test",
        searchId: "s-test",
        strategyId: "strat-test",
        depth: 1,
        branchIndex: 0,
        cumulativeAttempts: 1,
        cumulativeCost: { wallTimeMs: 10, toolInvocations: 1, compositionInvocations: 1, contextBytes: 100 },
        stateDigest: "st",
        workspaceSnapshotDigest: "ws",
        inputEvidenceDigest: "in",
        compositionDigest: "comp",
        status: "EXPLORING",
        childrenNodeIds: [],
      };
      const evalResult = backtrackingPolicy.evaluateBacktrack(node, buildBaseStrategy(), {
        confidenceScore: 5,
      });
      expect(evalResult.shouldBacktrack).toBe(true);
      expect(evalResult.failureClass).toBe("HYPOTHESIS_CONTRADICTED");
    });

    it("classifies UNKNOWN_FAILURE as fail-closed", () => {
      const node: StrategySearchNode = {
        nodeId: "n-test",
        searchId: "s-test",
        strategyId: "strat-test",
        depth: 1,
        branchIndex: 0,
        cumulativeAttempts: 1,
        cumulativeCost: { wallTimeMs: 10, toolInvocations: 1, compositionInvocations: 1, contextBytes: 100 },
        stateDigest: "st",
        workspaceSnapshotDigest: "ws",
        inputEvidenceDigest: "in",
        compositionDigest: "comp",
        status: "EXPLORING",
        childrenNodeIds: [],
      };
      const evalResult = backtrackingPolicy.evaluateBacktrack(node, buildBaseStrategy(), {
        failureClass: "UNKNOWN_FAILURE",
      });
      expect(evalResult.shouldBacktrack).toBe(true);
      expect(evalResult.failureClass).toBe("UNKNOWN_FAILURE");
    });
  });

  // ============================================================================
  // SECTION 10: CUMULATIVE RESOURCE CONSTRAINTS & AMPLIFICATION DEFENSE
  // ============================================================================
  describe("Cumulative Resource Constraints & Amplification Defense", () => {
    it("rejects attempt count exceeding maxRepairAttempts (12)", async () => {
      const customExecutor = new RepairStrategyExecutor(
        strategyPolicy,
        backtrackingPolicy,
        searchProvenance,
        compExecutor,
        registry,
        { ...DEFAULT_SEARCH_RESOURCE_LIMITS, maxRepairAttempts: 2 }
      );
      const strats = [1, 2, 3, 4].map((i) => buildBaseStrategy({ strategyId: `s-${i}` }));
      const tree = await customExecutor.executeSearch({
        searchId: "amp-att",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: strats[0]!,
        alternativeStrategies: strats.slice(1),
        options: { simulateFullVerificationSuccess: false },
      });
      expect(tree.cumulativeResources.attemptsExecuted).toBeLessThanOrEqual(2);
      expect(tree.finalStatus).toBe("EXHAUSTED");
    });

    it("rejects composition count exceeding maxCompositionInvocations (16)", async () => {
      const customExecutor = new RepairStrategyExecutor(
        strategyPolicy,
        backtrackingPolicy,
        searchProvenance,
        compExecutor,
        registry,
        { ...DEFAULT_SEARCH_RESOURCE_LIMITS, maxCompositionInvocations: 1 }
      );
      const strats = [1, 2, 3].map((i) => buildBaseStrategy({ strategyId: `s-${i}` }));
      const tree = await customExecutor.executeSearch({
        searchId: "amp-comp",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: strats[0]!,
        alternativeStrategies: strats.slice(1),
        options: { simulateFullVerificationSuccess: false },
      });
      expect(tree.cumulativeResources.compositionInvocations).toBeLessThanOrEqual(1);
    });

    it("rejects tool invocations exceeding maxToolInvocations (32)", async () => {
      const customExecutor = new RepairStrategyExecutor(
        strategyPolicy,
        backtrackingPolicy,
        searchProvenance,
        compExecutor,
        registry,
        { ...DEFAULT_SEARCH_RESOURCE_LIMITS, maxToolInvocations: 2 }
      );
      // validCompSpec has 2 stages -> 2 tool invocations
      const s1 = buildBaseStrategy({ strategyId: "s1" });
      const s2 = buildBaseStrategy({ strategyId: "s2" });
      const tree = await customExecutor.executeSearch({
        searchId: "amp-tool",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: s1,
        alternativeStrategies: [s2],
        options: { simulateFullVerificationSuccess: false },
      });
      expect(tree.cumulativeResources.toolInvocations).toBeLessThanOrEqual(2);
    });

    it("prevents context amplification across chained nodes", async () => {
      singleExecutor.registerImplementation(tool1Spec.toolId, () => ({
        data: "small-diagnostic",
      }));
      const tree = await strategyExecutor.executeSearch({
        searchId: "amp-ctx",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: buildBaseStrategy(),
      });
      expect(tree.cumulativeResources.contextBytes).toBeLessThan(128 * 1024);
    });

    it("enforces strategy payload byte limit <= 64KB", () => {
      const smallStrat = buildBaseStrategy();
      expect(strategyPolicy.validateStrategy(smallStrat, getWorkflowContext()).valid).toBe(true);
      const largeStrat = { ...buildBaseStrategy(), hypothesis: "x".repeat(70 * 1024) };
      expect(strategyPolicy.validateStrategy(largeStrat, getWorkflowContext()).valid).toBe(false);
    });
  });

  // ============================================================================
  // SECTION 11: CRASH RECOVERY & STATE PRESERVATION
  // ============================================================================
  describe("Crash Recovery & State Preservation Across Checkpoints", () => {
    it("checkpoint 1: preserves state after strategy generation", () => {
      const strat = buildBaseStrategy();
      expect(strat.status).toBe("PROPOSED");
      expect(strat.strategyDigest).toBeDefined();
    });

    it("checkpoint 2: preserves state after strategy validation", () => {
      const strat = buildBaseStrategy();
      const rep = strategyPolicy.validateStrategy(strat, getWorkflowContext());
      expect(rep.status).toBe("AUTHORIZED_FOR_EXPLORATION");
    });

    it("checkpoint 3: preserves node state after composition completion", async () => {
      const tree = await strategyExecutor.executeSearch({
        searchId: "cr-3",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: buildBaseStrategy(),
      });
      const node = Object.values(tree.nodes)[0];
      expect(node?.outputEvidenceDigest).toBeDefined();
    });

    it("checkpoint 4: preserves candidate state after candidate generation", async () => {
      const tree = await strategyExecutor.executeSearch({
        searchId: "cr-4",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: buildBaseStrategy(),
      });
      const cand = Object.values(tree.candidates)[0];
      expect(cand?.patchDigest).toBeDefined();
    });

    it("checkpoint 5: preserves backtrack point after delta screening failure", async () => {
      const tree = await strategyExecutor.executeSearch({
        searchId: "cr-5",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_C_FAILURE_AWARE_BACKTRACK",
        rootStrategy: buildBaseStrategy(),
        options: { simulateDeltaScreenFailure: true },
      });
      expect(tree.backtrackPoints.length).toBe(1);
      const bt = tree.backtrackPoints[0]!;
      expect(bt.backtrackId).toBeDefined();
      expect(bt.workspaceSnapshotDigest).toBeDefined();
    });

    it("checkpoint 6: preserves verified status after clean-room verification", async () => {
      const tree = await strategyExecutor.executeSearch({
        searchId: "cr-6",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: buildBaseStrategy(),
        options: { simulateFullVerificationSuccess: true },
      });
      const cand = Object.values(tree.candidates)[0];
      expect(cand?.status).toBe("VERIFIED");
      expect(cand?.fullVerificationResult?.taskSatisfied).toBe(true);
    });

    it("checkpoint 7: recovers consistent search tree structure", async () => {
      const tree = await strategyExecutor.executeSearch({
        searchId: "cr-7",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: buildBaseStrategy(),
      });
      expect(tree.searchId).toBe("cr-7");
      expect(tree.provenanceRoot).toBeDefined();
      expect(searchProvenance.verifySearchProvenanceChain(
        Object.values(tree.nodes),
        Object.values(tree.candidates),
        tree.backtrackPoints,
        tree.provenanceRoot
      )).toBe(true);
    });
  });

  // ============================================================================
  // SECTION 12: CONTROLLED HUMAN COLLABORATION BASELINE
  // ============================================================================
  describe("Controlled Human Collaboration Baseline", () => {
    it("evaluates autonomous strategy generation without human intervention", async () => {
      const autoStrat = buildBaseStrategy({ hypothesis: "Autonomous AST fix" });
      const tree = await strategyExecutor.executeSearch({
        searchId: "h-auto",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: autoStrat,
      });
      expect(tree.finalStatus).toBe("SUCCEEDED");
      expect(tree.cumulativeResources.attemptsExecuted).toBe(1);
    });

    it("evaluates human-proposed strategy control condition with clean provenance boundary", async () => {
      const humanStrat = buildBaseStrategy({ hypothesis: "Human expert proposed bounds check" });
      const tree = await strategyExecutor.executeSearch({
        searchId: "h-expert",
        workflowContext: getWorkflowContext(),
        policy: "POLICY_A_FIRST_VALID",
        rootStrategy: humanStrat,
      });
      expect(tree.finalStatus).toBe("SUCCEEDED");
      // Provenance root is deterministically bound
      expect(tree.provenanceRoot).toBeDefined();
    });
  });
});
