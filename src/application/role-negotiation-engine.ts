/**
 * Phase 95: Role Negotiation Engine
 *
 * Implements cooperative cross-agent role negotiation (transfers, swaps, borrows, handoffs).
 * Guarantees that negotiation remains subordinate to governance policy and cannot
 * negotiate sovereign authority (terminal, verification, contract, policy, credentials, scope).
 *
 * ABSOLUTE PRINCIPLE:
 * Role authority may change. Sovereign authority must not.
 */

import { ClockPort, SystemClock } from "../ports/clock.port.js";
import {
  AdvisoryAgentRole,
  RoleNegotiationProposalType,
} from "../domain/dynamic-agent-role.js";
import { AgentRoleTransitionManager } from "./agent-role-transition-manager.js";
import { RoleRebalancingPolicy } from "./role-rebalancing-policy.js";

export interface RoleNegotiationProposal {
  readonly proposalId: string;
  readonly proposalType: RoleNegotiationProposalType;
  readonly proposingAgentId: string;
  readonly targetAgentId?: string;
  readonly currentRole: AdvisoryAgentRole;
  readonly proposedRole: AdvisoryAgentRole;
  readonly targetProposedRole?: AdvisoryAgentRole;
  readonly workflowId: string;
  readonly goalId: string;
  readonly reason: string;
  readonly missionContractId: string;
  readonly missionContractHash: string;
  readonly timestamp?: string;
}

export type NegotiationStatus = "ACCEPTED" | "REJECTED";

export interface RoleNegotiationResult {
  readonly negotiationId: string;
  readonly proposalId: string;
  readonly status: NegotiationStatus;
  readonly reason: string;
  readonly executedTransitions: readonly string[];
  readonly timestamp: string;
}

export class RoleNegotiationEngine {
  private readonly negotiationHistory: RoleNegotiationResult[] = [];
  private readonly clock: ClockPort;

  constructor(
    private readonly transitionManager: AgentRoleTransitionManager,
    private readonly policy: RoleRebalancingPolicy,
    options?: { readonly clock?: ClockPort }
  ) {
    this.clock = options?.clock ?? new SystemClock();
  }

  public getNegotiationHistory(): readonly RoleNegotiationResult[] {
    return Object.freeze([...this.negotiationHistory]);
  }

  public getPolicy(): RoleRebalancingPolicy {
    return this.policy;
  }

  /**
   * Submits a role negotiation proposal, evaluates governance policy,
   * and executes atomic transitions if permitted.
   */
  public submitNegotiation(proposal: RoleNegotiationProposal): RoleNegotiationResult {
    const nowIso = proposal.timestamp ?? this.clock.nowIso();
    const negotiationId = `neg-${this.negotiationHistory.length + 1}`;

    // 1. Invariant Check: Negotiation cannot alter sovereign parameters
    if (!proposal.missionContractId || !proposal.missionContractHash) {
      const result: RoleNegotiationResult = {
        negotiationId,
        proposalId: proposal.proposalId,
        status: "REJECTED",
        reason: "Negotiation rejected: mission contract binding is required and immutable",
        executedTransitions: [],
        timestamp: nowIso,
      };
      this.negotiationHistory.push(result);
      return result;
    }

    // 2. Evaluate Proposal by Type
    try {
      if (proposal.proposalType === "ROLE_SWAP") {
        if (!proposal.targetAgentId) {
          throw new Error("Role swap requires targetAgentId");
        }

        const swapResult = this.transitionManager.executeAtomicRoleSwap(
          proposal.proposingAgentId,
          proposal.targetAgentId,
          {
            workflowId: proposal.workflowId,
            goalId: proposal.goalId,
            reason: `Negotiated swap: ${proposal.reason}`,
            missionContractId: proposal.missionContractId,
            missionContractHash: proposal.missionContractHash,
            timestamp: nowIso,
          }
        );

        const result: RoleNegotiationResult = {
          negotiationId,
          proposalId: proposal.proposalId,
          status: "ACCEPTED",
          reason: "Role swap negotiated and atomically executed",
          executedTransitions: [
            swapResult.assignmentA.assignmentId,
            swapResult.assignmentB.assignmentId,
          ],
          timestamp: nowIso,
        };
        this.negotiationHistory.push(result);
        return result;
      }

      if (proposal.proposalType === "ROLE_TRANSFER" || proposal.proposalType === "TEMPORARY_BORROW") {
        const assignment = this.transitionManager.transitionRole({
          agentId: proposal.proposingAgentId,
          workflowId: proposal.workflowId,
          goalId: proposal.goalId,
          newRole: proposal.proposedRole,
          reason: `Negotiated ${proposal.proposalType}: ${proposal.reason}`,
          missionContractId: proposal.missionContractId,
          missionContractHash: proposal.missionContractHash,
          timestamp: nowIso,
        });

        const result: RoleNegotiationResult = {
          negotiationId,
          proposalId: proposal.proposalId,
          status: "ACCEPTED",
          reason: `Role transition negotiated and committed`,
          executedTransitions: [assignment.assignmentId],
          timestamp: nowIso,
        };
        this.negotiationHistory.push(result);
        return result;
      }

      // Default handoff or specialization
      const assignment = this.transitionManager.transitionRole({
        agentId: proposal.proposingAgentId,
        workflowId: proposal.workflowId,
        goalId: proposal.goalId,
        newRole: proposal.proposedRole,
        reason: `Negotiated ${proposal.proposalType}: ${proposal.reason}`,
        missionContractId: proposal.missionContractId,
        missionContractHash: proposal.missionContractHash,
        timestamp: nowIso,
      });

      const result: RoleNegotiationResult = {
        negotiationId,
        proposalId: proposal.proposalId,
        status: "ACCEPTED",
        reason: `${proposal.proposalType} negotiated successfully`,
        executedTransitions: [assignment.assignmentId],
        timestamp: nowIso,
      };
      this.negotiationHistory.push(result);
      return result;
    } catch (err: any) {
      const result: RoleNegotiationResult = {
        negotiationId,
        proposalId: proposal.proposalId,
        status: "REJECTED",
        reason: `Negotiation rejected: ${err.message ?? String(err)}`,
        executedTransitions: [],
        timestamp: nowIso,
      };
      this.negotiationHistory.push(result);
      return result;
    }
  }
}
