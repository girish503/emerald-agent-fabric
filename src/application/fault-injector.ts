/**
 * Phase 98: Fault Injector
 *
 * Implements deterministic fault scheduling, channel-level message manipulation,
 * partition topologies (P1–P10), crash simulation, delay/drop/reorder queues,
 * equivocation injection, and cryptographic fault evidence recording.
 *
 * ABSOLUTE GOVERNING PRINCIPLE:
 * Fault injection is test infrastructure only. It must never grant authority.
 */

import { ClockPort, SystemClock } from "../ports/clock.port.js";
import { sha256Hex } from "../domain/canonical-hash.js";
import {
  FaultClassification,
  FaultScenario,
  FaultEvent,
  FaultSchedule,
  FaultEvidence,
  computeFaultEventHash,
  computeFaultEvidenceHash,
} from "../domain/fault-injection.js";
import {
  GovernedMessage,
  PartitionSnapshot,
  PartitionTopologyType,
  computeGovernedMessageHash,
  computePartitionSnapshotHash,
} from "../domain/governed-agreement.js";

export interface ChannelMessageQueue {
  readonly channelId: string;
  readonly senderId: string;
  readonly receiverId: string;
  messages: GovernedMessage[];
}

export class FaultInjector {
  private readonly scenarios: Map<string, FaultScenario> = new Map();
  private readonly events: Map<string, FaultEvent> = new Map();
  private readonly evidenceRecords: Map<string, FaultEvidence> = new Map();
  private readonly channels: Map<string, ChannelMessageQueue> = new Map();
  private readonly partitions: Map<string, PartitionSnapshot> = new Map();
  private readonly crashedAgents: Set<string> = new Set();
  private readonly delayedChannels: Map<string, number> = new Map(); // channelId -> delayMs
  private readonly droppedChannels: Set<string> = new Set(); // channelId -> drop all
  private readonly quarantinedAgents: Set<string> = new Set();
  private sequenceCounter: number = 0;

  constructor(private readonly clock: ClockPort = new SystemClock()) {}

  /**
   * Register a deterministic fault scenario.
   */
  public registerScenario(scenario: FaultScenario): void {
    this.scenarios.set(scenario.scenarioId, scenario);
  }

  /**
   * Schedule and immediately stage or inject a fault event from a scenario.
   */
  public scheduleFault(scenario: FaultScenario): FaultEvent {
    this.sequenceCounter++;
    const now = this.clock.nowIso();
    const eventId = `fault-evt-${scenario.scenarioId}-${this.sequenceCounter}`;

    const rawEvent: Omit<FaultEvent, "hash"> = {
      eventId,
      scenarioId: scenario.scenarioId,
      faultClass: scenario.faultClass,
      target: scenario.target,
      injectedAt: now,
      sequence: this.sequenceCounter,
      expectedEffect: scenario.description,
      status: "INJECTED",
      provenance: scenario.provenance,
    };

    const hash = computeFaultEventHash(rawEvent);
    const event: FaultEvent = { ...rawEvent, hash };
    this.events.set(eventId, event);
    this.registerScenario(scenario);

    // Apply immediate target effects
    this.applyFaultSideEffects(event);

    return event;
  }

  /**
   * Apply mechanical side effects of an injected fault to communication channels or agents.
   */
  private applyFaultSideEffects(event: FaultEvent): void {
    const { faultClass, target } = event;

    switch (faultClass) {
      case "CRASH":
        if (target.targetType === "AGENT" || target.targetType === "WORKER") {
          this.crashedAgents.add(target.targetId);
        }
        break;

      case "DELAY":
        if (target.channelId) {
          this.delayedChannels.set(target.channelId, 50);
        } else if (target.targetId) {
          // Delay all channels to/from targetId
          for (const [chId, ch] of Array.from(this.channels.entries())) {
            if (ch.senderId === target.targetId || ch.receiverId === target.targetId) {
              this.delayedChannels.set(chId, 50);
            }
          }
        }
        break;

      case "DROP":
        if (target.channelId) {
          this.droppedChannels.add(target.channelId);
        } else if (target.targetId) {
          for (const [chId, ch] of Array.from(this.channels.entries())) {
            if (ch.senderId === target.targetId || ch.receiverId === target.targetId) {
              this.droppedChannels.add(chId);
            }
          }
        }
        break;

      case "PARTITION":
        // Partition handled via applyPartition explicitly or via target parameters
        break;

      case "RECOVERY":
        if (target.targetType === "AGENT" || target.targetType === "WORKER") {
          this.crashedAgents.delete(target.targetId);
        }
        break;

      default:
        // Behavioral / semantic faults (e.g. EQUIVOCATION, CONTRACT_MISMATCH) handled on message emission
        break;
    }
  }

  /**
   * Create or retrieve a logical communication channel between two participants.
   */
  public getOrCreateChannel(senderId: string, receiverId: string): ChannelMessageQueue {
    const channelId = `ch-${senderId}->${receiverId}`;
    let ch = this.channels.get(channelId);
    if (!ch) {
      ch = {
        channelId,
        senderId,
        receiverId,
        messages: [],
      };
      this.channels.set(channelId, ch);
    }
    return ch;
  }

  /**
   * Enqueue a governed message for delivery through the local channel abstraction.
   */
  public enqueueMessage(msg: GovernedMessage): GovernedMessage {
    const ch = this.getOrCreateChannel(msg.senderId, msg.receiverId);

    // Check if sender or receiver is crashed
    if (this.crashedAgents.has(msg.senderId) || this.crashedAgents.has(msg.receiverId)) {
      const droppedMsg: GovernedMessage = {
        ...msg,
        deliveryState: "DROPPED",
        hash: computeGovernedMessageHash({ ...msg, deliveryState: "DROPPED" }),
      };
      ch.messages.push(droppedMsg);
      return droppedMsg;
    }

    // Check if channel is partitioned
    if (this.isChannelPartitioned(msg.senderId, msg.receiverId)) {
      const partitionedMsg: GovernedMessage = {
        ...msg,
        deliveryState: "DROPPED",
        hash: computeGovernedMessageHash({ ...msg, deliveryState: "DROPPED" }),
      };
      ch.messages.push(partitionedMsg);
      return partitionedMsg;
    }

    // Check if channel drops messages
    if (this.droppedChannels.has(ch.channelId)) {
      const droppedMsg: GovernedMessage = {
        ...msg,
        deliveryState: "DROPPED",
        hash: computeGovernedMessageHash({ ...msg, deliveryState: "DROPPED" }),
      };
      ch.messages.push(droppedMsg);
      return droppedMsg;
    }

    // Check if delayed
    if (this.delayedChannels.has(ch.channelId)) {
      const delayedMsg: GovernedMessage = {
        ...msg,
        deliveryState: "DELAYED",
        hash: computeGovernedMessageHash({ ...msg, deliveryState: "DELAYED" }),
      };
      ch.messages.push(delayedMsg);
      return delayedMsg;
    }

    // Default queued
    ch.messages.push(msg);
    return msg;
  }

  /**
   * Deliver all eligible messages queued in a channel.
   */
  public deliverChannelMessages(channelId: string): GovernedMessage[] {
    const ch = this.channels.get(channelId);
    if (!ch) return [];

    const delivered: GovernedMessage[] = [];
    const now = this.clock.nowIso();

    for (const msg of ch.messages) {
      if (msg.deliveryState === "DROPPED" || msg.deliveryState === "REJECTED") {
        continue;
      }

      if (this.isChannelPartitioned(msg.senderId, msg.receiverId)) {
        continue;
      }

      const deliveredMsg: GovernedMessage = {
        ...msg,
        deliveryState: "DELIVERED",
        deliveredAt: now,
        hash: computeGovernedMessageHash({
          ...msg,
          deliveryState: "DELIVERED",
        }),
      };
      delivered.push(deliveredMsg);
    }

    // Clear delivered
    ch.messages = [];
    return delivered;
  }

  /**
   * Apply a deterministic partition topology (P1 through P10).
   */
  public applyPartition(
    topologyType: PartitionTopologyType,
    groups: readonly (readonly string[])[],
    epoch: number = 1
  ): PartitionSnapshot {
    const partitionId = `partition-${topologyType}-${epoch}-${Date.now()}`;
    const isolatedAgents: string[] = [];
    for (const g of groups) {
      if (g.length === 1 && typeof g[0] === "string") {
        isolatedAgents.push(g[0]);
      }
    }

    const rawSnapshot: Omit<PartitionSnapshot, "hash"> = {
      partitionId,
      topologyType,
      groups,
      isolatedAgents,
      isRecovered: false,
      epoch,
      membershipVersion: epoch,
      createdAt: this.clock.nowIso(),
    };

    const hash = computePartitionSnapshotHash(rawSnapshot);
    const snapshot: PartitionSnapshot = { ...rawSnapshot, hash };
    this.partitions.set(partitionId, snapshot);
    return snapshot;
  }

  /**
   * Heal an active partition, enabling post-partition reconciliation.
   */
  public healPartition(partitionId: string): PartitionSnapshot {
    const partition = this.partitions.get(partitionId);
    if (!partition) {
      throw new Error(`Cannot heal non-existent partition: ${partitionId}`);
    }

    const now = this.clock.nowIso();
    const healedRaw: Omit<PartitionSnapshot, "hash"> = {
      ...partition,
      isRecovered: true,
      recoveredAt: now,
    };

    const hash = computePartitionSnapshotHash(healedRaw);
    const healed: PartitionSnapshot = { ...healedRaw, hash };
    this.partitions.set(partitionId, healed);
    return healed;
  }

  /**
   * Check if communication between sender and receiver is cut off by any active partition.
   */
  public isChannelPartitioned(senderId: string, receiverId: string): boolean {
    for (const partition of Array.from(this.partitions.values())) {
      if (!partition.isRecovered) {
        // Find which group sender and receiver belong to
        const senderGroupIndex = partition.groups.findIndex((g) => g.includes(senderId));
        const receiverGroupIndex = partition.groups.findIndex((g) => g.includes(receiverId));

        if (senderGroupIndex !== -1 && receiverGroupIndex !== -1 && senderGroupIndex !== receiverGroupIndex) {
          return true; // Separated across partition boundary
        }
      }
    }
    return false;
  }

  /**
   * Synthesize a controlled equivocation event where an agent emits conflicting observations.
   */
  public injectEquivocation(
    agentId: string,
    runId: string,
    taskId: string,
    subject: string,
    val1: Record<string, unknown>,
    val2: Record<string, unknown>,
    receiver1: string,
    receiver2: string,
    missionContractId: string,
    missionContractHash: string,
    provenanceRoot: string
  ): [GovernedMessage, GovernedMessage] {
    const now = this.clock.nowIso();
    const seq = ++this.sequenceCounter;

    const p1 = { ...val1, subject };
    const p2 = { ...val2, subject };
    const payloadHash1 = sha256Hex(JSON.stringify(p1));
    const payloadHash2 = sha256Hex(JSON.stringify(p2));

    const msg1Raw: Omit<GovernedMessage, "hash"> = {
      messageId: `msg-equiv-1-${seq}`,
      senderId: agentId,
      receiverId: receiver1,
      runId,
      taskId,
      sequence: seq,
      creationSequence: seq,
      payload: p1,
      payloadHash: payloadHash1,
      missionContractId,
      missionContractHash,
      provenanceRoot,
      deliveryState: "CREATED",
      authoritative: false,
      terminalAuthority: false,
      verificationAuthority: false,
      policyAuthority: false,
      isByzantine: true,
      isEquivocating: true,
      sentAt: now,
    };
    const msg1: GovernedMessage = { ...msg1Raw, hash: computeGovernedMessageHash(msg1Raw) };

    const msg2Raw: Omit<GovernedMessage, "hash"> = {
      messageId: `msg-equiv-2-${seq}`,
      senderId: agentId,
      receiverId: receiver2,
      runId,
      taskId,
      sequence: seq,
      creationSequence: seq,
      payload: p2,
      payloadHash: payloadHash2,
      missionContractId,
      missionContractHash,
      provenanceRoot,
      deliveryState: "CREATED",
      authoritative: false,
      terminalAuthority: false,
      verificationAuthority: false,
      policyAuthority: false,
      isByzantine: true,
      isEquivocating: true,
      sentAt: now,
    };
    const msg2: GovernedMessage = { ...msg2Raw, hash: computeGovernedMessageHash(msg2Raw) };

    this.enqueueMessage(msg1);
    this.enqueueMessage(msg2);

    return [msg1, msg2];
  }

  /**
   * Record immutable evidence for a detected fault or anomaly.
   * Invariant B2: Fault evidence is immutable.
   */
  public recordEvidence(
    event: FaultEvent,
    detectedClassification: FaultClassification,
    detectionLatencyMs: number,
    resolutionLatencyMs: number,
    impactOnQuorum: boolean,
    partitionAffected: boolean,
    quarantineActionTaken: boolean
  ): FaultEvidence {
    const evidenceId = `evidence-${event.eventId}-${Date.now()}`;
    const rawEvidence: Omit<FaultEvidence, "hash"> = {
      evidenceId,
      scenarioId: event.scenarioId,
      faultEventId: event.eventId,
      injectedFaultClass: event.faultClass,
      detectedFaultClassification: detectedClassification,
      detectionLatencyMs,
      resolutionLatencyMs,
      impactOnQuorum,
      partitionAffected,
      quarantineActionTaken,
      provenanceRoot: event.provenance,
      immutable: true,
      authoritative: false,
    };

    const hash = computeFaultEvidenceHash(rawEvidence);
    const evidence: FaultEvidence = { ...rawEvidence, hash };
    this.evidenceRecords.set(evidenceId, evidence);
    return evidence;
  }

  public isAgentCrashed(agentId: string): boolean {
    return this.crashedAgents.has(agentId);
  }

  public recoverAgent(agentId: string): void {
    this.crashedAgents.delete(agentId);
  }

  public quarantineAgent(agentId: string): void {
    this.quarantinedAgents.add(agentId);
  }

  public isAgentQuarantined(agentId: string): boolean {
    return this.quarantinedAgents.has(agentId);
  }

  public getActivePartitions(): PartitionSnapshot[] {
    return Array.from(this.partitions.values()).filter((p) => !p.isRecovered);
  }

  public getAllPartitions(): PartitionSnapshot[] {
    return Array.from(this.partitions.values());
  }

  public getFaultSchedule(): FaultSchedule {
    const events = Array.from(this.events.values());
    const scenarios = Array.from(this.scenarios.values());
    const activeFaults = events.filter((e) => e.status === "ACTIVE" || e.status === "INJECTED");
    const resolvedFaults = events.filter((e) => e.status === "RESOLVED");

    const digest = sha256Hex(
      JSON.stringify({
        eventCount: events.length,
        scenarioCount: scenarios.length,
        activeCount: activeFaults.length,
      })
    );

    return {
      scheduleId: `sched-${Date.now()}`,
      events,
      scenarios,
      activeFaults,
      resolvedFaults,
      digest,
    };
  }

  public getEvidenceRecords(): readonly FaultEvidence[] {
    return Array.from(this.evidenceRecords.values());
  }
}
