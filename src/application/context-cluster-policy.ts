/**
 * Phase 90: Context Cluster Policy & Security Governance
 *
 * Enforces negative security controls N421–N450 and Context Security Invariants K1–K18:
 * - K1: Context cannot grant authority (authoritative: false, terminalAuthority: false)
 * - K2: Context scope ⊆ goal scope
 * - K3: Context repositories ⊆ declared repositories
 * - K4: Context capabilities ⊆ workflow capabilities
 * - K5: Cumulative resource budget enforcement (128KB total, 64KB per stage, 256 nodes, 512 edges)
 * - K6/K7: Cryptographic digest and provenance integrity
 * - K8: No hallucinated missing dependencies
 * - K9/K10: Stale and revoked context fail-closed
 * - K11/K12: Cross-goal and cross-repo contamination prevention
 * - K13: Agent authority injection prevention
 * - K14/K15: Centrality/relevance non-authorization
 * - K16: Oracle/reference leakage prevention
 * - K17/K18: Phase 83 & Clean-room verification bypass prevention
 */

import { DistilledContext } from "./subgoal-context-distiller.js";
import { ASTContextGraph } from "../domain/ast-context-graph.js";
import { GoalNode, SubGoalContract } from "../domain/hierarchical-goal-decomposition.js";
import { ContextResourceBudget, DEFAULT_CONTEXT_RESOURCE_LIMITS } from "../domain/context-cluster.js";
import { SearchWorkflowContext } from "../domain/repair-strategy-search.js";

export interface ContextPolicyValidationReport {
  readonly valid: boolean;
  readonly violatedInvariants: readonly string[];
  readonly violatedSecurityControls: readonly string[];
  readonly diagnostics: readonly string[];
}

export class ContextClusterPolicy {
  /**
   * Validate a distilled context against all Phase 90 governance invariants (K1–K18)
   * and negative security controls (N421–N450).
   */
  public validateContext(params: {
    readonly context: DistilledContext;
    readonly goal: GoalNode;
    readonly contract: SubGoalContract;
    readonly graph: ASTContextGraph;
    readonly workflowContext: SearchWorkflowContext;
    readonly budget?: ContextResourceBudget;
    readonly declaredCrossRepoEdges?: readonly { fromRepo: string; toRepo: string }[];
    readonly isRevoked?: boolean;
    readonly containsOracleData?: boolean;
  }): ContextPolicyValidationReport {
    const budget = params.budget || DEFAULT_CONTEXT_RESOURCE_LIMITS;
    const ctx = params.context;
    const goal = params.goal;
    const contract = params.contract;
    const wf = params.workflowContext;

    const violatedInvariants: string[] = [];
    const violatedSecurityControls: string[] = [];
    const diagnostics: string[] = [];

    // N421 / N426 / K1: Context Self-Authorization & Terminal Authority Injection
    if (
      (ctx as any).authoritative !== false ||
      (ctx as any).terminalAuthority !== false ||
      (ctx as any).policyApproval !== false ||
      (ctx as any).verificationAuthority !== false
    ) {
      violatedInvariants.push("K1");
      violatedSecurityControls.push("N421", "N426", "N450");
      diagnostics.push("Context attempts to claim authoritative, terminal, or policy approval.");
    }

    // N422 / K4: Capability Injection
    if ((ctx as any).requestedCapabilities) {
      for (const cap of (ctx as any).requestedCapabilities) {
        if (!wf.allowedCapabilities.includes(cap)) {
          violatedInvariants.push("K4");
          violatedSecurityControls.push("N422");
          diagnostics.push(`Context requests capability '${cap}' outside workflow permissions.`);
        }
      }
    }

    // N423 / K2: Scope Expansion
    for (const node of ctx.selectedNodes) {
      if (
        goal.affectedScope.targetFiles.length > 0 &&
        !goal.affectedScope.workspaceScopes.some((ws) => node.filePath.startsWith(ws) || ws === "workspace/default")
      ) {
        violatedInvariants.push("K2");
        violatedSecurityControls.push("N423");
        diagnostics.push(`Node '${node.nodeId}' targets file outside goal workspace scope.`);
      }
    }

    // N424 / K3: Repository Expansion
    for (const node of ctx.selectedNodes) {
      if (!wf.allowedRepositoryScopes.includes(node.repositoryId)) {
        violatedInvariants.push("K3");
        violatedSecurityControls.push("N424");
        diagnostics.push(`Node '${node.nodeId}' belongs to unauthorized repository '${node.repositoryId}'.`);
      }
    }

    // N425: Credential Injection
    if (
      (ctx as any).credentials ||
      (ctx as any).apiKey ||
      (ctx as any).token ||
      (ctx as any).workerId ||
      (ctx as any).leaseId
    ) {
      violatedSecurityControls.push("N425");
      diagnostics.push("Context payload contains unauthorized credentials or worker/lease identities.");
    }

    // N428: Graph-Edge Authority Injection
    for (const edge of params.graph.edges) {
      if ((edge as any).terminalAuthority || (edge.provenance as any).terminalAuthority) {
        violatedSecurityControls.push("N428");
        diagnostics.push(`Graph edge '${edge.edgeId}' claims execution/terminal authority.`);
      }
    }

    // N433 / K8: Omitted Dependency Concealment / Silent Hallucination
    if ((ctx as any).omittedDependenciesConcealed || (ctx as any).hallucinatedDependencies) {
      violatedInvariants.push("K8");
      violatedSecurityControls.push("N433", "N434");
      diagnostics.push("Context conceals omitted dependencies or hallucinates synthetic references.");
    }

    // N435 / N436 / K14 / K15: Centrality/Relevance Authority Escalation
    if ((ctx as any).centralityAuthorizedAction || (ctx as any).relevanceAuthorizedAction) {
      violatedInvariants.push("K14", "K15");
      violatedSecurityControls.push("N435", "N436");
      diagnostics.push("Centrality or relevance score attempted to authorize execution action directly.");
    }

    // N437 / N438 / K5: Expansion Recursion & Budget Bypass
    if (
      ctx.expansionRoundsUsed > budget.maxExpansionRounds ||
      ctx.estimatedBytes > budget.maxTotalContextBytes ||
      ctx.selectedNodes.length > budget.maxGraphNodes
    ) {
      violatedInvariants.push("K5");
      violatedSecurityControls.push("N437", "N438", "N439");
      diagnostics.push(
        `Context exceeds resource budget ceilings: bytes=${ctx.estimatedBytes}/${budget.maxTotalContextBytes}, nodes=${ctx.selectedNodes.length}/${budget.maxGraphNodes}`
      );
    }

    // N440: Graph Edge Amplification
    if (params.graph.edges.length > budget.maxGraphEdges) {
      violatedSecurityControls.push("N440");
      diagnostics.push(`Graph edge count (${params.graph.edges.length}) exceeds budget ceiling (${budget.maxGraphEdges}).`);
    }

    // N441 / K12: Cross-Repository Graph Injection (Phase 85 integration)
    const declaredEdges = params.declaredCrossRepoEdges || [];
    for (const edge of params.graph.edges) {
      if (edge.edgeType === "CROSS_REPO_DEPENDENCY") {
        const srcNode = params.graph.nodes[edge.sourceNodeId];
        const tgtNode = params.graph.nodes[edge.targetNodeId];
        if (srcNode && tgtNode && srcNode.repositoryId !== tgtNode.repositoryId) {
          const isDeclared = declaredEdges.some(
            (d) => d.fromRepo === srcNode.repositoryId && d.toRepo === tgtNode.repositoryId
          );
          if (!isDeclared) {
            violatedInvariants.push("K12");
            violatedSecurityControls.push("N441", "N445");
            diagnostics.push(
              `Undeclared cross-repo dependency edge from '${srcNode.repositoryId}' to '${tgtNode.repositoryId}'.`
            );
          }
        }
      }
    }

    // N442 / K9: Stale Context Execution
    if (ctx.completenessStatus === "STALE") {
      violatedInvariants.push("K9");
      violatedSecurityControls.push("N442");
      diagnostics.push("Context contains stale nodes with outdated source digests.");
    }

    // N443 / K10: Revoked Context Execution
    if (params.isRevoked) {
      violatedInvariants.push("K10");
      violatedSecurityControls.push("N443");
      diagnostics.push("Context references revoked tools or capabilities.");
    }

    // N444 / K11: Goal Contamination
    if (ctx.goalId !== goal.goalId || ctx.goalId !== contract.goalId) {
      violatedInvariants.push("K11");
      violatedSecurityControls.push("N444");
      diagnostics.push(`Context goalId '${ctx.goalId}' does not match target goalId '${goal.goalId}' or contract '${contract.goalId}'.`);
    }

    // N446 / K13: Agent Authority Injection
    if ((ctx as any).agentAuthorityToken) {
      violatedInvariants.push("K13");
      violatedSecurityControls.push("N446");
      diagnostics.push("Agent authority token detected inside context cluster.");
    }

    // N447 / K16: Reference/Oracle Leakage
    if (params.containsOracleData || (ctx as any).referenceSolution) {
      violatedInvariants.push("K16");
      violatedSecurityControls.push("N447");
      diagnostics.push("Reference solution or test oracle leaked into context payload.");
    }

    // N448 / N449 / K17 / K18: Context Bypassing Verification
    if ((ctx as any).bypassesDeltaScreening || (ctx as any).bypassesCleanRoomFourfold) {
      violatedInvariants.push("K17", "K18");
      violatedSecurityControls.push("N448", "N449");
      diagnostics.push("Context claims to bypass delta screening or clean-room fourfold verification.");
    }

    // K6 / K7: Provenance & Digest Integrity
    if (!ctx.contextDigest || !ctx.sourceProvenance) {
      violatedInvariants.push("K6", "K7");
      violatedSecurityControls.push("N431", "N432");
      diagnostics.push("Context missing mandatory cryptographic digests or source provenance root.");
    }

    return {
      valid: violatedInvariants.length === 0 && violatedSecurityControls.length === 0,
      violatedInvariants,
      violatedSecurityControls,
      diagnostics,
    };
  }
}
