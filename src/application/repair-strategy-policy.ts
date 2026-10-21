/**
 * Phase 88: Repair Strategy Validation Policy
 *
 * Governs candidate repair strategies before exploration.
 *
 * Validates:
 * 1. Schema & size limits (<= 64KB payload)
 * 2. Strategy search depth (<= 4)
 * 3. Branching bounds (<= 4 branches per node)
 * 4. Phase 87 composition policy validation
 * 5. Capability intersection (Composed ⊆ ToolCaps ∩ WorkflowCaps)
 * 6. Repository scope (no implicit or unauthorized expansion)
 * 7. Workspace scope (strictly bounded to workflow allowance)
 * 8. Resource budgets within global ceilings
 * 9. Exact tool identity pinning (no wildcards or version mutations)
 * 10. Self-authorization denial (dynamic tools cannot authorize strategies)
 * 11. Digest integrity binding (recomputed strategyDigest must match)
 *
 * If invalid: PROPOSED -> QUARANTINED. Never executed.
 */

import {
  RepairStrategy,
  SearchWorkflowContext,
  DEFAULT_SEARCH_RESOURCE_LIMITS,
  computeStrategyDigest,
} from "../domain/repair-strategy-search.js";
import { DynamicToolCompositionPolicy } from "./dynamic-tool-composition-policy.js";
import { computeCompositionDigest } from "../domain/dynamic-tool-composition.js";
import { canonicalJsonStringify, sha256Hex } from "../domain/canonical-hash.js";

export interface StrategyValidationReport {
  readonly valid: boolean;
  readonly strategyId: string;
  readonly status: "AUTHORIZED_FOR_EXPLORATION" | "QUARANTINED";
  readonly diagnostics: readonly string[];
  readonly validationDigest: string;
}

export class RepairStrategyPolicy {
  constructor(private readonly compositionPolicy: DynamicToolCompositionPolicy) {}

  /**
   * Validate an untrusted candidate strategy against all governance invariants.
   */
  public validateStrategy(
    strategy: RepairStrategy,
    workflowContext: SearchWorkflowContext,
    existingBranchCountForParent: number = 0
  ): StrategyValidationReport {
    const diagnostics: string[] = [];

    // 1. Self-authorization check (N361)
    if (workflowContext.isDynamicToolCaller || workflowContext.callerIdentity === "dynamic") {
      diagnostics.push("Self-authorization prohibited: dynamic tools cannot authorize repair strategies.");
    }

    // 2. Size validation (max 64KB payload)
    const payloadBytes = Buffer.byteLength(canonicalJsonStringify(strategy), "utf8");
    if (payloadBytes > DEFAULT_SEARCH_RESOURCE_LIMITS.maxStrategyPayloadBytes) {
      diagnostics.push(
        `Strategy payload (${payloadBytes} bytes) exceeds maximum allowable limit (${DEFAULT_SEARCH_RESOURCE_LIMITS.maxStrategyPayloadBytes} bytes).`
      );
    }

    // 3. Depth validation (max depth <= 4) (N384)
    if (strategy.depth > DEFAULT_SEARCH_RESOURCE_LIMITS.maxDepth || strategy.depth < 1) {
      diagnostics.push(
        `Strategy depth (${strategy.depth}) exceeds maximum allowable depth (${DEFAULT_SEARCH_RESOURCE_LIMITS.maxDepth}).`
      );
    }

    // 4. Branching validation (max branches per node <= 4) (N385)
    if (existingBranchCountForParent >= DEFAULT_SEARCH_RESOURCE_LIMITS.maxBranchesPerNode) {
      diagnostics.push(
        `Branch count for parent node exceeds maximum allowable branches (${DEFAULT_SEARCH_RESOURCE_LIMITS.maxBranchesPerNode}).`
      );
    }

    // 5. Strategy digest integrity (N371)
    const recomputedDigest = computeStrategyDigest({
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
    if (strategy.strategyDigest !== recomputedDigest) {
      diagnostics.push(
        `Strategy digest mismatch: declared '${strategy.strategyDigest}', computed '${recomputedDigest}'.`
      );
    }

    // 6. Composition digest integrity binding (N368)
    const recomputedCompDigest = computeCompositionDigest(strategy.compositionSpec);
    if (
      strategy.toolCompositionDigest !== recomputedCompDigest ||
      (strategy.compositionSpec.compositionDigest &&
        strategy.compositionSpec.compositionDigest !== recomputedCompDigest)
    ) {
      diagnostics.push("Composition digest declared in strategy does not match composition specification.");
    }

    // 7. Scope governance: Workspace scopes (N365)
    for (const ws of strategy.targetScope.workspaceScopes) {
      if (!workflowContext.allowedWorkspaceScopes.includes(ws)) {
        diagnostics.push(`Workspace scope '${ws}' exceeds workflow authorized workspace scopes.`);
      }
    }

    // 8. Scope governance: Repository scopes (N364)
    for (const repo of strategy.targetScope.repositoryScopes) {
      if (!workflowContext.allowedRepositoryScopes.includes(repo)) {
        diagnostics.push(`Repository scope '${repo}' exceeds workflow authorized repository scopes.`);
      }
    }

    // 9. Resource ceiling checks (N386)
    if (
      strategy.resourceBudget.maxSearchWallTimeMs &&
      strategy.resourceBudget.maxSearchWallTimeMs > DEFAULT_SEARCH_RESOURCE_LIMITS.maxSearchWallTimeMs
    ) {
      diagnostics.push("Strategy resource budget wallTime exceeds safety ceiling.");
    }
    if (
      strategy.resourceBudget.maxRepairAttempts &&
      strategy.resourceBudget.maxRepairAttempts > DEFAULT_SEARCH_RESOURCE_LIMITS.maxRepairAttempts
    ) {
      diagnostics.push("Strategy resource budget repairAttempts exceeds safety ceiling.");
    }
    if (
      strategy.resourceBudget.maxToolInvocations &&
      strategy.resourceBudget.maxToolInvocations > DEFAULT_SEARCH_RESOURCE_LIMITS.maxToolInvocations
    ) {
      diagnostics.push("Strategy resource budget toolInvocations exceeds safety ceiling.");
    }

    // 10. Phase 87 Composition Policy Validation (Capability intersection, cycles, tool versions) (N362, N363, N369, N370)
    const compValidationContext = {
      workflowId: workflowContext.workflowId,
      allowedCapabilities: workflowContext.allowedCapabilities as any,
      allowedWorkspaceScopes: workflowContext.allowedWorkspaceScopes,
      allowedRepositoryScopes: workflowContext.allowedRepositoryScopes,
      isGovernedSystem: workflowContext.isGovernedSystem,
      isDynamicToolCaller: workflowContext.isDynamicToolCaller,
    };
    const compReport = this.compositionPolicy.validateComposition(
      strategy.compositionSpec,
      compValidationContext
    );
    if (!compReport.valid) {
      diagnostics.push(...compReport.diagnostics.map((d) => `Composition validation failed: ${d}`));
    }

    const valid = diagnostics.length === 0;
    const status = valid ? "AUTHORIZED_FOR_EXPLORATION" : "QUARANTINED";
    const validationDigest = sha256Hex(
      canonicalJsonStringify({
        strategyId: strategy.strategyId,
        valid,
        status,
        diagnostics,
      })
    );

    return {
      valid,
      strategyId: strategy.strategyId,
      status,
      diagnostics,
      validationDigest,
    };
  }
}
