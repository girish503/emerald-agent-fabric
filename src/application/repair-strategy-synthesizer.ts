/**
 * Phase 88: Autonomous Multi-Tool Repair Strategy Synthesis
 *
 * Untrusted generator of candidate repair strategies.
 *
 * Invariants:
 * 1. Proposes analysis orders, hypotheses, test impact, and fallback strategies.
 * 2. Cannot choose workerId, leaseId, credentials, provider, isolation mode,
 *    mission contract, policy, terminal authority, evidence signing, or verification authority.
 * 3. Any authority-bearing keys present in input or templates are completely ignored.
 * 4. Strategies are output in PROPOSED lifecycle state with zero execution authority.
 */

import {
  RepairStrategy,
  StrategyTargetScope,
  StrategyExpectedChange,
  SearchResourceLimits,
  DEFAULT_SEARCH_RESOURCE_LIMITS,
  computeStrategyDigest,
} from "../domain/repair-strategy-search.js";
import { ToolCompositionSpec } from "../domain/dynamic-tool-composition.js";
import { sha256Hex } from "../domain/canonical-hash.js";

export interface StrategySynthesisParams {
  readonly strategyId?: string;
  readonly searchId: string;
  readonly depth?: number;
  readonly sequenceNumber?: number;
  readonly parentStrategyId?: string;
  readonly hypothesis: string;
  readonly compositionSpec: ToolCompositionSpec;
  readonly targetScope: StrategyTargetScope;
  readonly expectedChange: StrategyExpectedChange;
  readonly requiredEvidence: readonly string[];
  readonly resourceBudget?: Partial<SearchResourceLimits>;
  readonly advisoryScore?: number;
  readonly injectedAuthorityKeys?: Record<string, unknown>; // Test probe for N361, N379, etc.
}

export class RepairStrategySynthesizer {
  /**
   * Synthesize an untrusted candidate RepairStrategy.
   */
  public synthesizeStrategy(params: StrategySynthesisParams): RepairStrategy {
    const depth = params.depth ?? 1;
    const sequenceNumber = params.sequenceNumber ?? 1;
    const parentStrategyId = params.parentStrategyId;
    const strategyId =
      params.strategyId ??
      `strat-${params.searchId}-d${depth}-s${sequenceNumber}-${sha256Hex(params.hypothesis).slice(0, 8)}`;

    const compositionDigest =
      params.compositionSpec.compositionDigest || sha256Hex(params.compositionSpec.compositionId);

    const rawDigestData = {
      strategyId,
      searchId: params.searchId,
      parentStrategyId,
      depth,
      toolCompositionDigest: compositionDigest,
      targetScope: params.targetScope,
      hypothesis: params.hypothesis,
      expectedChange: params.expectedChange,
      requiredEvidence: params.requiredEvidence,
    };
    const strategyDigest = computeStrategyDigest(rawDigestData);
    const provenance = sha256Hex(`strat-prov:${strategyId}:${strategyDigest}`);

    // Authority stripping: sanitize any injected authority fields
    // Notice: workerId, leaseId, credentials, terminalAuthority, policyApproval are NEVER included.

    const strategy: RepairStrategy = {
      strategyId,
      searchId: params.searchId,
      parentStrategyId,
      depth,
      sequenceNumber,
      strategyDigest,
      toolCompositionDigest: compositionDigest,
      compositionSpec: params.compositionSpec,
      targetScope: {
        workspaceScopes: [...params.targetScope.workspaceScopes],
        repositoryScopes: [...params.targetScope.repositoryScopes],
        targetFiles: [...params.targetScope.targetFiles],
      },
      hypothesis: params.hypothesis,
      expectedChange: {
        affectedFiles: [...params.expectedChange.affectedFiles],
        expectedTestImpact: [...params.expectedChange.expectedTestImpact],
        expectedContractImpact: params.expectedChange.expectedContractImpact
          ? [...params.expectedChange.expectedContractImpact]
          : undefined,
      },
      requiredEvidence: [...params.requiredEvidence],
      resourceBudget: {
        maxSearchWallTimeMs: DEFAULT_SEARCH_RESOURCE_LIMITS.maxSearchWallTimeMs,
        maxStrategyNodes: DEFAULT_SEARCH_RESOURCE_LIMITS.maxStrategyNodes,
        maxDepth: DEFAULT_SEARCH_RESOURCE_LIMITS.maxDepth,
        maxBranchesPerNode: DEFAULT_SEARCH_RESOURCE_LIMITS.maxBranchesPerNode,
        maxRepairAttempts: DEFAULT_SEARCH_RESOURCE_LIMITS.maxRepairAttempts,
        maxToolInvocations: DEFAULT_SEARCH_RESOURCE_LIMITS.maxToolInvocations,
        maxCandidatePatches: DEFAULT_SEARCH_RESOURCE_LIMITS.maxCandidatePatches,
        maxCompositionInvocations: DEFAULT_SEARCH_RESOURCE_LIMITS.maxCompositionInvocations,
        ...(params.resourceBudget || {}),
      },
      status: "PROPOSED",
      advisoryScore: params.advisoryScore ?? 50,
      provenance,
      createdAt: new Date().toISOString(),
    };

    return strategy;
  }
}
