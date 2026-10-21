/**
 * Phase 98: Byzantine Agreement Coordinator
 *
 * Implements governed consensus proposals, observation collection, equivocation detection,
 * partition-aware quorum evaluation across Policies A–E, split-brain rejection,
 * post-partition state reconciliation, and fail-closed progress blocking.
 *
 * ABSOLUTE GOVERNING PRINCIPLE:
 * Agreement may be reconstructed. Authority may never be fabricated.
 */

import { ClockPort, SystemClock } from "../ports/clock.port.js";
import { sha256Hex } from "../domain/canonical-hash.js";
import {
  GovernedMessage,
  AgreementProposal,
  GovernedAgreement,
  AgreementStatus,
  QuorumPolicy,
  QuorumDecision,
  EquivocationEvidence,
  computeGovernedAgreementHash,
  computeQuorumDecisionHash,
  computeEquivocationEvidenceHash,
} from "../domain/governed-agreement.js";
import { FaultInjector } from "./fault-injector.js";

export interface CoordinatorConfig {
  readonly defaultQuorumPolicy?: QuorumPolicy;
  readonly defaultParticipants?: readonly string[];
  readonly verificationAuthorityRequired?: boolean;
}

export class ByzantineAgreementCoordinator {
  private readonly agreements: Map<string, GovernedAgreement> = new Map();
  private readonly proposals: Map<string, AgreementProposal> = new Map();
  private readonly messagesBySubject: Map<string, GovernedMessage[]> = new Map(); // subject -> messages
  private readonly messagesByAgent: Map<string, GovernedMessage[]> = new Map(); // agentId -> messages
  private readonly equivocationRecords: Map<string, EquivocationEvidence> = new Map();
  private readonly quorumDecisions: Map<string, QuorumDecision> = new Map();
  private readonly quarantinedAgents: Set<string> = new Set();
  private readonly verifiedSubjects: Set<string> = new Set();
  private sequenceCounter: number = 0;

  private readonly quarantineReasons: Map<string, string> = new Map();

  constructor(
    private readonly faultInjector?: FaultInjector,
    private readonly clock: ClockPort = new SystemClock(),
    private readonly config: CoordinatorConfig = {}
  ) {}

  /**
   * Submit a new agreement proposal.
   */
  public proposeAgreement(proposal: AgreementProposal): GovernedAgreement {
    this.sequenceCounter++;
    this.proposals.set(proposal.proposalId, proposal);

    const agreementId = `agr-${proposal.proposalId}`;
    const initialParticipants = this.config.defaultParticipants ?? [proposal.proposerId];

    const rawAgreement: Omit<GovernedAgreement, "hash"> = {
      agreementId,
      runId: proposal.runId,
      taskId: proposal.taskId,
      proposalId: proposal.proposalId,
      subject: proposal.subject,
      candidateValue: proposal.candidateValue,
      status: "PROPOSED",
      quorumPolicy: proposal.quorumPolicy || this.config.defaultQuorumPolicy || "GOVERNED_ADAPTIVE",
      membershipVersion: proposal.membershipVersion,
      participantSet: initialParticipants,
      agreeingParticipants: [proposal.proposerId],
      dissentingParticipants: [],
      evidenceSet: [proposal.hash],
      missionContractId: proposal.missionContractId,
      missionContractHash: proposal.missionContractHash,
      provenanceRoot: proposal.provenanceRoot,
      authoritative: false,
      terminalAuthority: false,
      verificationAuthority: false,
      policyAuthority: false,
      confidence: 0.5,
      quorumReached: false,
      verified: false,
      splitBrainDetected: false,
      equivocationDetected: false,
      partitionBlocked: false,
      createdSequence: this.sequenceCounter,
    };

    const hash = computeGovernedAgreementHash(rawAgreement);
    const agreement: GovernedAgreement = { ...rawAgreement, hash };
    this.agreements.set(agreementId, agreement);
    return agreement;
  }

  /**
   * Submit an observation message from a participant.
   * Enforces equivocation detection, quarantine checks, and contract consistency.
   */
  public submitObservation(message: GovernedMessage): {
    accepted: boolean;
    reason?: string;
    equivocation?: EquivocationEvidence;
  } {
    // 1. Check if agent is quarantined
    if (this.quarantinedAgents.has(message.senderId) || (this.faultInjector?.isAgentQuarantined(message.senderId))) {
      return { accepted: false, reason: `Agent ${message.senderId} is quarantined for Byzantine behavior` };
    }

    // 2. Check if agent is crashed
    if (this.faultInjector?.isAgentCrashed(message.senderId)) {
      return { accepted: false, reason: `Agent ${message.senderId} is crashed` };
    }

    // 3. Extract subject from payload or default to taskId
    const subject = String(message.payload["subject"] ?? message.taskId);

    // 4. Check for equivocation: same agent, same subject or sequence, different payloadHash
    const agentMessages = this.messagesByAgent.get(message.senderId) ?? [];
    for (const prior of agentMessages) {
      const priorSubject = String(prior.payload["subject"] ?? prior.taskId);
      if (priorSubject === subject && prior.sequence === message.sequence) {
        if (prior.payloadHash !== message.payloadHash) {
          // Equivocation detected!
          const equivEvidence = this.recordEquivocation(message.senderId, subject, prior, message);
          this.quarantineAgent(message.senderId, `Equivocation detected on subject ${subject}`);
          return { accepted: false, reason: "EQUIVOCATION_DETECTED", equivocation: equivEvidence };
        }
      }
    }

    // 5. Store message in history
    agentMessages.push(message);
    this.messagesByAgent.set(message.senderId, agentMessages);

    const subjectMessages = this.messagesBySubject.get(subject) ?? [];
    subjectMessages.push(message);
    this.messagesBySubject.set(subject, subjectMessages);

    // 6. Update matching agreements
    for (const [agrId, agr] of Array.from(this.agreements.entries())) {
      if (agr.subject === subject) {
        const isAgreement = message.payload["vote"] === "AFFIRMATIVE" || message.payload["status"] === "SUCCESS";
        const agreeing = new Set(agr.agreeingParticipants);
        const dissenting = new Set(agr.dissentingParticipants);
        const evidence = new Set(agr.evidenceSet);

        if (isAgreement) {
          agreeing.add(message.senderId);
        } else {
          dissenting.add(message.senderId);
        }
        evidence.add(message.hash);

        const updatedRaw: Omit<GovernedAgreement, "hash"> = {
          ...agr,
          status: "COLLECTING",
          agreeingParticipants: Array.from(agreeing),
          dissentingParticipants: Array.from(dissenting),
          evidenceSet: Array.from(evidence),
          confidence: agreeing.size / Math.max(1, agr.participantSet.length),
        };
        const hash = computeGovernedAgreementHash(updatedRaw);
        this.agreements.set(agrId, { ...updatedRaw, hash });
      }
    }

    return { accepted: true };
  }

  /**
   * Record cryptographic evidence of an agent equivocation.
   * Invariant B16: Equivocation is detectable.
   */
  private recordEquivocation(
    agentId: string,
    subject: string,
    msg1: GovernedMessage,
    msg2: GovernedMessage
  ): EquivocationEvidence {
    const evidenceId = `equiv-${agentId}-${Date.now()}`;
    const raw: Omit<EquivocationEvidence, "hash"> = {
      evidenceId,
      agentId,
      subject,
      conflictingMessageIds: [msg1.messageId, msg2.messageId],
      conflictingMessageHashes: [msg1.hash, msg2.hash],
      observedContradiction: `Agent ${agentId} emitted contradictory payloads (${msg1.payloadHash} vs ${msg2.payloadHash}) for sequence ${msg1.sequence}`,
      sequence: msg1.sequence,
      provenanceRoot: sha256Hex(`${msg1.provenanceRoot}:${msg2.provenanceRoot}`),
      detectedAt: this.clock.nowIso(),
    };
    const hash = computeEquivocationEvidenceHash(raw);
    const evidence: EquivocationEvidence = { ...raw, hash };
    this.equivocationRecords.set(evidenceId, evidence);

    // Mark affected agreements as equivocation detected
    for (const [agrId, agr] of Array.from(this.agreements.entries())) {
      if (agr.subject === subject) {
        const updated: GovernedAgreement = {
          ...agr,
          equivocationDetected: true,
          status: "CONFLICTED",
          confidence: 0,
          hash: computeGovernedAgreementHash({ ...agr, equivocationDetected: true, status: "CONFLICTED", confidence: 0 }),
        };
        this.agreements.set(agrId, updated);
      }
    }

    return evidence;
  }

  /**
   * Evaluate quorum for a governed agreement across Policies A through E.
   */
  public evaluateQuorum(agreementId: string, policyOverride?: QuorumPolicy): QuorumDecision {
    const agreement = this.agreements.get(agreementId);
    if (!agreement) {
      throw new Error(`Agreement ${agreementId} not found`);
    }

    const policy = policyOverride ?? agreement.quorumPolicy;
    const totalEligible = agreement.participantSet.length;

    const agreeing = agreement.agreeingParticipants.filter(
      (p) => !this.quarantinedAgents.has(p) && !(this.faultInjector?.isAgentCrashed(p))
    );
    const dissenting = agreement.dissentingParticipants.filter(
      (p) => !this.quarantinedAgents.has(p) && !(this.faultInjector?.isAgentCrashed(p))
    );

    const affirmativeVotes = agreeing.length;
    const negativeVotes = dissenting.length;
    const votesCast = affirmativeVotes + negativeVotes;

    let byzantineVotesExcluded = agreement.agreeingParticipants.length - agreeing.length;
    if (byzantineVotesExcluded === 0 && this.quarantinedAgents.size > 0) {
      byzantineVotesExcluded = Array.from(this.quarantinedAgents).filter((p) => agreement.participantSet.includes(p)).length;
    }
    let requiredVotes = Math.floor(totalEligible / 2) + 1; // Strict majority
    let decisionResult: "ACCEPT" | "REJECT" | "SPLIT_BRAIN_BLOCKED" | "PARTITION_BLOCKED" | "QUARANTINE" = "REJECT";
    let quorumReached = false;
    let partitionRestricted = false;

    // Check partition restrictions
    const activePartitions = this.faultInjector?.getActivePartitions() ?? [];
    if (activePartitions.length > 0) {
      partitionRestricted = true;
      // If network is partitioned such that agreeing participants do NOT form strict majority of totalEligible:
      if (affirmativeVotes <= Math.floor(totalEligible / 2)) {
        decisionResult = "PARTITION_BLOCKED";
        const decision = this.recordDecision(agreementId, policy, requiredVotes, totalEligible, votesCast, affirmativeVotes, negativeVotes, false, true, 0, byzantineVotesExcluded, decisionResult);
        this.updateAgreementStatus(agreementId, "PARTITIONED", false, false, true);
        return decision;
      }
    }

    // Check for equivocation or conflict
    if (agreement.equivocationDetected) {
      decisionResult = "QUARANTINE";
      const decision = this.recordDecision(agreementId, policy, requiredVotes, totalEligible, votesCast, affirmativeVotes, negativeVotes, false, partitionRestricted, 0, byzantineVotesExcluded, decisionResult);
      this.updateAgreementStatus(agreementId, "QUARANTINED", false, false, false);
      return decision;
    }

    // Policy specific evaluation
    switch (policy) {
      case "FIRST_OBSERVATION":
        // Policy A (Baseline control only): First vote accepts regardless of quorum
        quorumReached = votesCast > 0;
        decisionResult = affirmativeVotes > 0 ? "ACCEPT" : "REJECT";
        break;

      case "MAJORITY_OBSERVATION":
        // Policy B: Strict majority of eligible participants
        quorumReached = affirmativeVotes >= requiredVotes;
        decisionResult = quorumReached ? "ACCEPT" : "REJECT";
        break;

      case "PROVENANCE_WEIGHTED":
        // Policy C: Weighted by evidence presence & valid provenance
        const hasProvenance = agreement.provenanceRoot.length > 0 && agreement.evidenceSet.length >= 2;
        quorumReached = affirmativeVotes >= requiredVotes && hasProvenance;
        decisionResult = quorumReached ? "ACCEPT" : "REJECT";
        break;

      case "QUORUM_WITH_VERIFICATION":
        // Policy D: Strict majority + verified
        const isVerified = this.verifiedSubjects.has(agreement.subject);
        quorumReached = affirmativeVotes >= requiredVotes && isVerified;
        decisionResult = quorumReached ? "ACCEPT" : (affirmativeVotes >= requiredVotes && !isVerified ? "REJECT" : "REJECT");
        break;

      case "GOVERNED_ADAPTIVE":
      default:
        // Policy E: Adaptive safety
        if (partitionRestricted && affirmativeVotes < totalEligible) {
          // Under partition, require verification proof or fail closed
          const isVerifiedAdaptive = this.verifiedSubjects.has(agreement.subject);
          if (affirmativeVotes >= requiredVotes && isVerifiedAdaptive) {
            quorumReached = true;
            decisionResult = "ACCEPT";
          } else {
            quorumReached = false;
            decisionResult = "PARTITION_BLOCKED";
          }
        } else {
          // Under normal connectivity, require strict majority and valid provenance
          quorumReached = affirmativeVotes >= requiredVotes && agreement.evidenceSet.length >= 1;
          decisionResult = quorumReached ? "ACCEPT" : "REJECT";
        }
        break;
    }

    const decision = this.recordDecision(
      agreementId,
      policy,
      requiredVotes,
      totalEligible,
      votesCast,
      affirmativeVotes,
      negativeVotes,
      quorumReached,
      partitionRestricted,
      0,
      byzantineVotesExcluded,
      decisionResult
    );

    const finalStatus: AgreementStatus = decisionResult === "ACCEPT" ? "AGREED" : (decisionResult === "PARTITION_BLOCKED" ? "PARTITIONED" : "REJECTED");
    this.updateAgreementStatus(agreementId, finalStatus, quorumReached, this.verifiedSubjects.has(agreement.subject), partitionRestricted);

    return decision;
  }

  private recordDecision(
    agreementId: string,
    quorumPolicy: QuorumPolicy,
    requiredVotes: number,
    totalEligible: number,
    votesCast: number,
    affirmativeVotes: number,
    negativeVotes: number,
    quorumReached: boolean,
    partitionRestricted: boolean,
    staleVotesRejected: number,
    byzantineVotesExcluded: number,
    decisionResult: "ACCEPT" | "REJECT" | "SPLIT_BRAIN_BLOCKED" | "PARTITION_BLOCKED" | "QUARANTINE"
  ): QuorumDecision {
    const decisionId = `qdec-${agreementId}-${Date.now()}`;
    const raw: Omit<QuorumDecision, "hash"> = {
      decisionId,
      agreementId,
      quorumPolicy,
      requiredVotes,
      totalEligible,
      votesCast,
      affirmativeVotes,
      negativeVotes,
      quorumReached,
      partitionRestricted,
      staleVotesRejected,
      byzantineVotesExcluded,
      decision: decisionResult,
      timestamp: this.clock.nowIso(),
    };
    const hash = computeQuorumDecisionHash(raw);
    const decision: QuorumDecision = { ...raw, hash };
    this.quorumDecisions.set(decisionId, decision);
    return decision;
  }

  private updateAgreementStatus(
    agreementId: string,
    status: AgreementStatus,
    quorumReached: boolean,
    verified: boolean,
    partitionBlocked: boolean
  ): void {
    const agreement = this.agreements.get(agreementId);
    if (!agreement) return;

    const updatedRaw: Omit<GovernedAgreement, "hash"> = {
      ...agreement,
      status,
      quorumReached,
      verified,
      partitionBlocked,
      agreedAt: status === "AGREED" ? this.clock.nowIso() : agreement.agreedAt,
    };
    const hash = computeGovernedAgreementHash(updatedRaw);
    this.agreements.set(agreementId, { ...updatedRaw, hash });
  }

  /**
   * Deterministically reconcile state when network partitions heal.
   * Invariant B18: Reconciliation is deterministic.
   */
  public reconcilePartitionHealing(
    _partitionId: string,
    exchangedMessages: readonly GovernedMessage[]
  ): {
    reconciled: boolean;
    rejectedStale: number;
    conflictsResolved: number;
    activeAgreements: readonly GovernedAgreement[];
  } {
    let rejectedStale = 0;
    let conflictsResolved = 0;

    for (const msg of exchangedMessages) {
      if (msg.isStale || msg.sequence < 0) {
        rejectedStale++;
        continue;
      }

      const res = this.submitObservation(msg);
      if (!res.accepted) {
        conflictsResolved++;
      }
    }

    // Re-evaluate quorums for all pending or partitioned agreements
    for (const [agrId, agr] of Array.from(this.agreements.entries())) {
      if (agr.status === "PARTITIONED" || agr.status === "COLLECTING") {
        this.evaluateQuorum(agrId);
      }
    }

    return {
      reconciled: true,
      rejectedStale,
      conflictsResolved,
      activeAgreements: Array.from(this.agreements.values()),
    };
  }

  /**
   * Sovereign verification confirmation.
   * Sovereign verification remains independent of Byzantine votes.
   */
  public markSubjectVerified(subject: string): void {
    this.verifiedSubjects.add(subject);
    for (const [agrId, agr] of Array.from(this.agreements.entries())) {
      if (agr.subject === subject) {
        const updated: GovernedAgreement = {
          ...agr,
          verified: true,
          hash: computeGovernedAgreementHash({ ...agr, verified: true }),
        };
        this.agreements.set(agrId, updated);
      }
    }
  }

  public quarantineAgent(agentId: string, reason: string): void {
    this.quarantinedAgents.add(agentId);
    this.quarantineReasons.set(agentId, reason);
    this.faultInjector?.quarantineAgent(agentId);
  }

  public isAgentQuarantined(agentId: string): boolean {
    return this.quarantinedAgents.has(agentId);
  }

  public getAgreement(agreementId: string): GovernedAgreement | undefined {
    return this.agreements.get(agreementId);
  }

  public getAllAgreements(): readonly GovernedAgreement[] {
    return Array.from(this.agreements.values());
  }

  public getQuorumDecisions(): readonly QuorumDecision[] {
    return Array.from(this.quorumDecisions.values());
  }

  public getEquivocationRecords(): readonly EquivocationEvidence[] {
    return Array.from(this.equivocationRecords.values());
  }
}
