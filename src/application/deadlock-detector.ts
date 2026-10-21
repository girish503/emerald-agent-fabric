/**
 * Phase 97: Deadlock Detector
 *
 * Implements deterministic wait-for graph construction, resource allocation graphs,
 * cycle detection via DFS and Tarjan's SCC, explicit classification (TRUE_DEADLOCK,
 * TRANSIENT_CONTENTION, STARVATION, PRIORITY_INVERSION, RESOURCE_EXHAUSTION,
 * LIVELOCK, STALE_DEPENDENCY, RECOVERABLE_LEASE_FAILURE, UNKNOWN), false-positive
 * suppression, and cryptographic cycle witness generation.
 *
 * ABSOLUTE GOVERNING PRINCIPLE:
 * Deadlock may change execution relationships. Deadlock resolution must never change authority.
 */

import { ClockPort, SystemClock } from "../ports/clock.port.js";
import { sha256Hex } from "../domain/canonical-hash.js";
import {
  DeadlockNode,
  DeadlockNodeType,
  DeadlockEdge,
  DeadlockDependencyType,
  DeadlockClassification,
  CycleWitness,
  computeDeadlockNodeHash,
  computeDeadlockEdgeHash,
  computeCycleWitnessHash,
  validateDeadlockNode,
} from "../domain/deadlock-detection.js";

export interface AddNodeParams {
  readonly nodeId: string;
  readonly nodeType: DeadlockNodeType;
  readonly entityId: string;
  readonly workflowId: string;
  readonly missionContractId: string;
  readonly missionContractHash: string;
  readonly agentId?: string;
  readonly workerId?: string;
  readonly leaseId?: string;
  readonly actionId?: string;
  readonly attemptId?: string;
  readonly branchId?: string;
  readonly resourceId?: string;
}

export interface AddEdgeParams {
  readonly edgeId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly dependencyType: DeadlockDependencyType;
  readonly isOptional?: boolean;
  readonly resourceQuantity?: number;
  readonly waitDurationMs?: number;
  readonly provenanceDigest?: string;
}

export class DeadlockDetector {
  private readonly nodes: Map<string, DeadlockNode> = new Map();
  private readonly edges: Map<string, DeadlockEdge> = new Map();
  private readonly adjacencyList: Map<string, Set<string>> = new Map();
  private readonly incomingEdges: Map<string, Set<string>> = new Map();
  private readonly actionHistory: Map<string, { actionType: string; timestamp: number }[]> = new Map();
  private readonly usefulWorkCounter: Map<string, number> = new Map();

  constructor(private readonly clock: ClockPort = new SystemClock()) {}

  /**
   * Register an execution node in the deadlock graph.
   * Invariant D1: Node is observation-only; never authoritative.
   */
  public addNode(params: AddNodeParams): DeadlockNode {
    const rawNode: Omit<DeadlockNode, "hash"> = {
      nodeId: params.nodeId,
      nodeType: params.nodeType,
      entityId: params.entityId,
      workflowId: params.workflowId,
      missionContractId: params.missionContractId,
      missionContractHash: params.missionContractHash,
      agentId: params.agentId,
      workerId: params.workerId,
      leaseId: params.leaseId,
      actionId: params.actionId,
      attemptId: params.attemptId,
      branchId: params.branchId,
      resourceId: params.resourceId,
      authoritative: false,
      terminalAuthority: false,
      verificationAuthority: false,
      policyAuthority: false,
    };

    const hash = computeDeadlockNodeHash(rawNode);
    const node: DeadlockNode = { ...rawNode, hash };

    const validation = validateDeadlockNode(node);
    if (!validation.valid) {
      throw new Error(`Invalid DeadlockNode: ${validation.reason}`);
    }

    this.nodes.set(node.nodeId, node);
    if (!this.adjacencyList.has(node.nodeId)) {
      this.adjacencyList.set(node.nodeId, new Set());
    }
    if (!this.incomingEdges.has(node.nodeId)) {
      this.incomingEdges.set(node.nodeId, new Set());
    }
    return node;
  }

  /**
   * Register a directed dependency edge (fromNodeId -> toNodeId).
   */
  public addEdge(params: AddEdgeParams): DeadlockEdge {
    if (!this.nodes.has(params.fromNodeId)) {
      throw new Error(`Edge source node ${params.fromNodeId} not found in deadlock graph`);
    }
    if (!this.nodes.has(params.toNodeId)) {
      throw new Error(`Edge target node ${params.toNodeId} not found in deadlock graph`);
    }

    const createdAt = this.clock.now().toISOString();
    const prov = params.provenanceDigest ?? sha256Hex(`EDGE_${params.fromNodeId}_${params.toNodeId}_${createdAt}`);

    const rawEdge: Omit<DeadlockEdge, "hash"> = {
      edgeId: params.edgeId,
      fromNodeId: params.fromNodeId,
      toNodeId: params.toNodeId,
      dependencyType: params.dependencyType,
      isOptional: params.isOptional ?? false,
      resourceQuantity: params.resourceQuantity,
      waitDurationMs: params.waitDurationMs ?? 0,
      provenanceDigest: prov,
      createdAt,
      authoritative: false,
    };

    const hash = computeDeadlockEdgeHash(rawEdge);
    const edge: DeadlockEdge = { ...rawEdge, hash };

    this.edges.set(edge.edgeId, edge);
    this.adjacencyList.get(edge.fromNodeId)!.add(edge.toNodeId);
    this.incomingEdges.get(edge.toNodeId)!.add(edge.fromNodeId);

    return edge;
  }

  /**
   * Remove a dependency edge from the graph.
   */
  public removeEdge(edgeId: string): boolean {
    const edge = this.edges.get(edgeId);
    if (!edge) return false;

    this.edges.delete(edgeId);
    this.adjacencyList.get(edge.fromNodeId)?.delete(edge.toNodeId);
    this.incomingEdges.get(edge.toNodeId)?.delete(edge.fromNodeId);
    return true;
  }

  /**
   * Record agent action for livelock detection.
   */
  public recordAction(agentId: string, actionType: string, isUsefulWork: boolean = false): void {
    const nowMs = this.clock.now().getTime();
    if (!this.actionHistory.has(agentId)) {
      this.actionHistory.set(agentId, []);
    }
    const history = this.actionHistory.get(agentId)!;
    history.push({ actionType, timestamp: nowMs });
    // Bounded history window (last 50 actions)
    if (history.length > 50) {
      history.shift();
    }
    if (isUsefulWork) {
      this.usefulWorkCounter.set(agentId, (this.usefulWorkCounter.get(agentId) ?? 0) + 1);
    }
  }

  /**
   * Deterministic cycle detection using Depth-First Search (DFS).
   * Finds all elementary cycles deterministically sorted by node IDs.
   */
  public detectCyclesDFS(): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const onStack = new Set<string>();
    const path: string[] = [];

    const sortedNodeIds = Array.from(this.nodes.keys()).sort();

    const dfs = (current: string, startNode: string) => {
      visited.add(current);
      onStack.add(current);
      path.push(current);

      const neighbors = Array.from(this.adjacencyList.get(current) || []).sort();
      for (const next of neighbors) {
        if (next === startNode && path.length >= 2) {
          // Closed cycle found!
          cycles.push([...path]);
        } else if (!visited.has(next) && next > startNode) {
          dfs(next, startNode);
        }
      }

      path.pop();
      onStack.delete(current);
    };

    for (const startNode of sortedNodeIds) {
      visited.clear();
      dfs(startNode, startNode);
    }

    return cycles;
  }

  /**
   * Tarjan's Strongly Connected Components (SCC) algorithm.
   * Returns all non-trivial components with >= 2 nodes or self-loops.
   */
  public detectCyclesTarjanSCC(): string[][] {
    let index = 0;
    const indices = new Map<string, number>();
    const lowlinks = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const sccs: string[][] = [];

    const strongConnect = (v: string) => {
      indices.set(v, index);
      lowlinks.set(v, index);
      index++;
      stack.push(v);
      onStack.add(v);

      const neighbors = Array.from(this.adjacencyList.get(v) || []).sort();
      for (const w of neighbors) {
        if (!indices.has(w)) {
          strongConnect(w);
          lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
        } else if (onStack.has(w)) {
          lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
        }
      }

      if (lowlinks.get(v) === indices.get(v)) {
        const scc: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
        } while (w !== v);

        // A component represents a cycle if it has > 1 node or a self-loop
        if (scc.length > 1 || (scc.length === 1 && (this.adjacencyList.get(scc[0])?.has(scc[0]) ?? false))) {
          sccs.push(scc.sort());
        }
      }
    };

    const sortedNodes = Array.from(this.nodes.keys()).sort();
    for (const node of sortedNodes) {
      if (!indices.has(node)) {
        strongConnect(node);
      }
    }

    return sccs;
  }

  /**
   * Classify a detected cycle deterministically.
   * Distinguishes TRUE_DEADLOCK from TRANSIENT_CONTENTION, STARVATION,
   * PRIORITY_INVERSION, RESOURCE_EXHAUSTION, LIVELOCK, STALE_DEPENDENCY, etc.
   */
  public classifyCycle(nodeIds: readonly string[]): DeadlockClassification {
    if (nodeIds.length < 2) {
      return "UNKNOWN";
    }

    // Retrieve edges participating in this cycle
    const cycleEdges: DeadlockEdge[] = [];
    for (let i = 0; i < nodeIds.length; i++) {
      const from = nodeIds[i];
      const to = nodeIds[(i + 1) % nodeIds.length];
      const edge = Array.from(this.edges.values()).find(
        (e) => e.fromNodeId === from && e.toNodeId === to,
      );
      if (edge) {
        cycleEdges.push(edge);
      }
    }

    if (cycleEdges.length !== nodeIds.length) {
      // Incomplete cycle edge information fails closed
      return "UNKNOWN";
    }

    // 1. Check for Transient Contention (short wait times, all < 200ms)
    const maxWaitMs = Math.max(...cycleEdges.map((e) => e.waitDurationMs));
    if (maxWaitMs < 200 && cycleEdges.some((e) => e.isOptional)) {
      return "TRANSIENT_CONTENTION";
    }

    // 2. Check for Stale Dependency or Lease Failure (> 30000ms wait with LEASE type)
    if (cycleEdges.some((e) => e.dependencyType === "LEASE" && e.waitDurationMs > 30000)) {
      return "RECOVERABLE_LEASE_FAILURE";
    }
    if (maxWaitMs > 60000) {
      return "STALE_DEPENDENCY";
    }

    // 3. Check for Priority Inversion (PRIORITY dependency involved)
    if (cycleEdges.some((e) => e.dependencyType === "PRIORITY")) {
      return "PRIORITY_INVERSION";
    }

    // 4. Check for Livelock (high action frequency with 0 useful work delta)
    for (const nodeId of nodeIds) {
      const node = this.nodes.get(nodeId);
      if (node?.agentId) {
        const history = this.actionHistory.get(node.agentId) || [];
        const usefulWork = this.usefulWorkCounter.get(node.agentId) ?? 0;
        if (history.length >= 8 && usefulWork === 0) {
          return "LIVELOCK";
        }
      }
    }

    // 5. Check for pure Resource Exhaustion
    if (cycleEdges.every((e) => e.dependencyType === "RESOURCE") && maxWaitMs < 1000) {
      return "RESOURCE_EXHAUSTION";
    }

    // 6. Confirmed TRUE_DEADLOCK: Closed causal loop with significant wait duration
    return "TRUE_DEADLOCK";
  }

  /**
   * Create a cryptographically verified CycleWitness for a detected cycle.
   */
  public createCycleWitness(nodeIds: readonly string[], cycleIndex: number = 1): CycleWitness {
    const classification = this.classifyCycle(nodeIds);
    const cycleId = `cycle-witness-${cycleIndex}-${sha256Hex(nodeIds.join("->")).slice(0, 8)}`;

    const edgeIds: string[] = [];
    for (let i = 0; i < nodeIds.length; i++) {
      const from = nodeIds[i];
      const to = nodeIds[(i + 1) % nodeIds.length];
      const edge = Array.from(this.edges.values()).find(
        (e) => e.fromNodeId === from && e.toNodeId === to,
      );
      if (edge) {
        edgeIds.push(edge.edgeId);
      }
    }

    const detectedAt = this.clock.now().toISOString();
    const witnessDigest = computeCycleWitnessHash(cycleId, nodeIds, edgeIds, classification);
    const provenanceRoot = sha256Hex(`PROV_WITNESS_${witnessDigest}_${detectedAt}`);

    return {
      cycleId,
      nodeIds,
      edgeIds,
      classification,
      cycleLength: nodeIds.length,
      detectedAt,
      witnessDigest,
      provenanceRoot,
    };
  }

  /**
   * Full deadlock audit: detects all elementary cycles and builds CycleWitnesses.
   */
  public detectAllDeadlocks(): CycleWitness[] {
    const rawCycles = this.detectCyclesDFS();
    const witnesses: CycleWitness[] = [];

    // Deduplicate cycles with identical node set
    const seenCycleKeys = new Set<string>();

    for (let i = 0; i < rawCycles.length; i++) {
      const cycle = rawCycles[i];
      const canonicalKey = [...cycle].sort().join("|");
      if (!seenCycleKeys.has(canonicalKey)) {
        seenCycleKeys.add(canonicalKey);
        const witness = this.createCycleWitness(cycle, witnesses.length + 1);
        witnesses.push(witness);
      }
    }

    return witnesses;
  }

  /**
   * Returns current wait-for graph nodes and edges.
   */
  public getWaitForGraph(): { nodes: DeadlockNode[]; edges: DeadlockEdge[] } {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values()),
    };
  }

  /**
   * Returns resource allocation graph (nodes and edges with RESOURCE or LEASE dependency).
   */
  public getResourceAllocationGraph(): { nodes: DeadlockNode[]; edges: DeadlockEdge[] } {
    const resEdges = Array.from(this.edges.values()).filter(
      (e) => e.dependencyType === "RESOURCE" || e.dependencyType === "LEASE",
    );
    const resNodeIds = new Set<string>();
    for (const e of resEdges) {
      resNodeIds.add(e.fromNodeId);
      resNodeIds.add(e.toNodeId);
    }
    const resNodes = Array.from(this.nodes.values()).filter((n) => resNodeIds.has(n.nodeId));
    return { nodes: resNodes, edges: resEdges };
  }

  /**
   * Check if an agent is in a livelock state.
   */
  public isAgentLivelocked(agentId: string, minActions: number = 8): boolean {
    const history = this.actionHistory.get(agentId) || [];
    const usefulWork = this.usefulWorkCounter.get(agentId) ?? 0;
    return history.length >= minActions && usefulWork === 0;
  }

  public getNode(nodeId: string): DeadlockNode | undefined {
    return this.nodes.get(nodeId);
  }

  public getEdge(edgeId: string): DeadlockEdge | undefined {
    return this.edges.get(edgeId);
  }

  public clear(): void {
    this.nodes.clear();
    this.edges.clear();
    this.adjacencyList.clear();
    this.incomingEdges.clear();
    this.actionHistory.clear();
    this.usefulWorkCounter.clear();
  }
}
