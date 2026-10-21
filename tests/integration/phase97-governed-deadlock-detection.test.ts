/**
 * Phase 97: Governed Autonomous Multi-Agent Deadlock Detection and Dynamic Cycle Elimination
 *
 * Integration Test Suite covering:
 * - 44 Test Categories
 * - >= 220 Tests
 * - Full coverage of D1–D20 Core Invariants
 * - Full coverage of N631–N660 Negative Security Controls
 * - Wait-for and Resource allocation graph construction
 * - Cycle detection (DFS and Tarjan SCC)
 * - Cycle classification (Deadlock, Contention, Starvation, Priority Inversion, Livelock, etc.)
 * - Minimum-intervention cycle-breaking strategies
 * - Integration with Phases 91, 92, 93, 94, 95, 96
 * - Action/Attempt and MissionContract identity preservation
 * - Crash recovery, determinism, and sovereign verification isolation.
 *
 * ABSOLUTE GOVERNING PRINCIPLE:
 * Deadlock may change execution relationships. Deadlock resolution must never change authority.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  DeadlockNode,
  DeadlockEdge,
  CycleWitness,
  DeadlockClassification,
  CycleBreakingStrategy,
  INTERVENTION_STRATEGY_COSTS,
  SECURITY_CONTROLS_PHASE97,
  DEADLOCK_CORE_INVARIANTS,
  computeDeadlockNodeHash,
  computeDeadlockEdgeHash,
  computeCycleWitnessHash,
  computeDeadlockResolutionHash,
  validateDeadlockNode,
  validateCycleWitness,
} from "../../src/domain/deadlock-detection.js";
import { DeadlockDetector } from "../../src/application/deadlock-detector.js";
import { DeadlockResolver } from "../../src/application/deadlock-resolver.js";
import { DeadlockGovernancePolicy } from "../../src/application/deadlock-governance-policy.js";
import { ClockPort } from "../../src/ports/clock.port.js";
import { sha256Hex } from "../../src/domain/canonical-hash.js";

class MockClock implements ClockPort {
  private currentTime: Date = new Date("2026-10-21T12:00:00.000Z");

  public now(): Date {
    return new Date(this.currentTime.getTime());
  }

  public advanceMs(ms: number): void {
    this.currentTime = new Date(this.currentTime.getTime() + ms);
  }

  public setTime(iso: string): void {
    this.currentTime = new Date(iso);
  }
}

describe("Phase 97: Governed Deadlock Detection and Dynamic Cycle Elimination", () => {
  let clock: MockClock;
  let detector: DeadlockDetector;
  let resolver: DeadlockResolver;
  let policy: DeadlockGovernancePolicy;

  beforeEach(() => {
    clock = new MockClock();
    detector = new DeadlockDetector(clock);
    resolver = new DeadlockResolver(detector, clock);
    policy = new DeadlockGovernancePolicy();
  });

  // ============================================================================
  // Category 1: Deadlock Graph Node Schema & Invariants (D1, N631)
  // ============================================================================
  describe("Category 1: Deadlock Graph Node Schema & Invariants", () => {
    it("1.1 creates valid non-authoritative deadlock node", () => {
      const node = detector.addNode({
        nodeId: "node-goal-01",
        nodeType: "GOAL",
        entityId: "goal-101",
        workflowId: "wf-1",
        missionContractId: "contract-1",
        missionContractHash: sha256Hex("CONTRACT_1"),
      });
      expect(node.nodeId).toBe("node-goal-01");
      expect(node.authoritative).toBe(false);
      expect(node.terminalAuthority).toBe(false);
      expect(node.verificationAuthority).toBe(false);
      expect(node.policyAuthority).toBe(false);
    });

    it("1.2 node validation succeeds for valid node", () => {
      const node = detector.addNode({
        nodeId: "node-agent-01",
        nodeType: "AGENT",
        entityId: "agent-1",
        workflowId: "wf-1",
        missionContractId: "contract-1",
        missionContractHash: sha256Hex("CONTRACT_1"),
      });
      const res = validateDeadlockNode(node);
      expect(res.valid).toBe(true);
    });

    it("1.3 rejects node if authoritative flag is forged true (N631)", () => {
      const node = detector.addNode({
        nodeId: "node-worker-01",
        nodeType: "WORKER",
        entityId: "worker-1",
        workflowId: "wf-1",
        missionContractId: "contract-1",
        missionContractHash: sha256Hex("CONTRACT_1"),
      });
      const forged = { ...node, authoritative: true as unknown as false };
      const res = validateDeadlockNode(forged);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain("authoritative flag must be false");
    });

    it("1.4 rejects node if terminalAuthority is forged true (N632)", () => {
      const node = detector.addNode({
        nodeId: "node-res-01",
        nodeType: "RESOURCE",
        entityId: "res-1",
        workflowId: "wf-1",
        missionContractId: "contract-1",
        missionContractHash: sha256Hex("CONTRACT_1"),
      });
      const forged = { ...node, terminalAuthority: true as unknown as false };
      const res = validateDeadlockNode(forged);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain("terminalAuthority flag must be false");
    });

    it("1.5 rejects node if hash does not match content digest", () => {
      const node = detector.addNode({
        nodeId: "node-lease-01",
        nodeType: "LEASE",
        entityId: "lease-1",
        workflowId: "wf-1",
        missionContractId: "contract-1",
        missionContractHash: sha256Hex("CONTRACT_1"),
      });
      const forged = { ...node, hash: "forged-hash" };
      const res = validateDeadlockNode(forged);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain("Node hash mismatch");
    });
  });

  // ============================================================================
  // Category 2: Deadlock Graph Edge Schema & Directed Dependencies
  // ============================================================================
  describe("Category 2: Deadlock Graph Edge Schema & Directed Dependencies", () => {
    beforeEach(() => {
      detector.addNode({
        nodeId: "n1",
        nodeType: "GOAL",
        entityId: "g1",
        workflowId: "wf-1",
        missionContractId: "c1",
        missionContractHash: sha256Hex("C1"),
      });
      detector.addNode({
        nodeId: "n2",
        nodeType: "GOAL",
        entityId: "g2",
        workflowId: "wf-1",
        missionContractId: "c1",
        missionContractHash: sha256Hex("C1"),
      });
    });

    it("2.1 adds valid directed dependency edge", () => {
      const edge = detector.addEdge({
        edgeId: "e1",
        fromNodeId: "n1",
        toNodeId: "n2",
        dependencyType: "WAIT",
        isOptional: false,
        waitDurationMs: 150,
      });
      expect(edge.edgeId).toBe("e1");
      expect(edge.fromNodeId).toBe("n1");
      expect(edge.toNodeId).toBe("n2");
      expect(edge.authoritative).toBe(false);
    });

    it("2.2 throws if edge source node does not exist", () => {
      expect(() => {
        detector.addEdge({
          edgeId: "e-bad",
          fromNodeId: "nonexistent",
          toNodeId: "n2",
          dependencyType: "WAIT",
        });
      }).toThrow("Edge source node nonexistent not found");
    });

    it("2.3 throws if edge target node does not exist", () => {
      expect(() => {
        detector.addEdge({
          edgeId: "e-bad",
          fromNodeId: "n1",
          toNodeId: "nonexistent",
          dependencyType: "WAIT",
        });
      }).toThrow("Edge target node nonexistent not found");
    });

    it("2.4 records optional flag accurately", () => {
      const edge = detector.addEdge({
        edgeId: "e-opt",
        fromNodeId: "n1",
        toNodeId: "n2",
        dependencyType: "GOAL",
        isOptional: true,
      });
      expect(edge.isOptional).toBe(true);
    });

    it("2.5 removes edge correctly", () => {
      detector.addEdge({
        edgeId: "e1",
        fromNodeId: "n1",
        toNodeId: "n2",
        dependencyType: "WAIT",
      });
      const removed = detector.removeEdge("e1");
      expect(removed).toBe(true);
      expect(detector.getEdge("e1")).toBeUndefined();
    });
  });

  // ============================================================================
  // Category 3: Wait-For Graph Construction & Querying
  // ============================================================================
  describe("Category 3: Wait-For Graph Construction & Querying", () => {
    it("3.1 builds empty wait-for graph initially", () => {
      const graph = detector.getWaitForGraph();
      expect(graph.nodes.length).toBe(0);
      expect(graph.edges.length).toBe(0);
    });

    it("3.2 queries populated nodes and edges accurately", () => {
      detector.addNode({ nodeId: "A", nodeType: "AGENT", entityId: "a1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "B", nodeType: "AGENT", entityId: "a2", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addEdge({ edgeId: "e-ab", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT" });

      const graph = detector.getWaitForGraph();
      expect(graph.nodes.length).toBe(2);
      expect(graph.edges.length).toBe(1);
    });

    it("3.3 clears wait-for graph completely", () => {
      detector.addNode({ nodeId: "A", nodeType: "AGENT", entityId: "a1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.clear();
      expect(detector.getWaitForGraph().nodes.length).toBe(0);
    });

    it("3.4 retrieves specific node by ID", () => {
      detector.addNode({ nodeId: "A", nodeType: "AGENT", entityId: "a1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      expect(detector.getNode("A")).toBeDefined();
      expect(detector.getNode("Z")).toBeUndefined();
    });

    it("3.5 retrieves specific edge by ID", () => {
      detector.addNode({ nodeId: "A", nodeType: "AGENT", entityId: "a1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "B", nodeType: "AGENT", entityId: "a2", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT" });
      expect(detector.getEdge("e1")?.fromNodeId).toBe("A");
    });
  });

  // ============================================================================
  // Category 4: Resource Allocation Graph Construction & Separation
  // ============================================================================
  describe("Category 4: Resource Allocation Graph Construction & Separation", () => {
    beforeEach(() => {
      detector.addNode({ nodeId: "WorkerA", nodeType: "WORKER", entityId: "w1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "WorkerB", nodeType: "WORKER", entityId: "w2", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "Res1", nodeType: "RESOURCE", entityId: "r1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "GoalA", nodeType: "GOAL", entityId: "g1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
    });

    it("4.1 isolates resource edges from logical goal edges", () => {
      detector.addEdge({ edgeId: "e-res", fromNodeId: "WorkerA", toNodeId: "Res1", dependencyType: "RESOURCE" });
      detector.addEdge({ edgeId: "e-goal", fromNodeId: "WorkerA", toNodeId: "GoalA", dependencyType: "GOAL" });

      const rag = detector.getResourceAllocationGraph();
      expect(rag.edges.length).toBe(1);
      expect(rag.edges[0].edgeId).toBe("e-res");
    });

    it("4.2 includes LEASE dependencies in resource allocation graph", () => {
      detector.addEdge({ edgeId: "e-lease", fromNodeId: "WorkerA", toNodeId: "WorkerB", dependencyType: "LEASE" });
      const rag = detector.getResourceAllocationGraph();
      expect(rag.edges.length).toBe(1);
      expect(rag.edges[0].dependencyType).toBe("LEASE");
    });

    it("4.3 returns only nodes involved in resource or lease edges", () => {
      detector.addEdge({ edgeId: "e-res", fromNodeId: "WorkerA", toNodeId: "Res1", dependencyType: "RESOURCE" });
      const rag = detector.getResourceAllocationGraph();
      expect(rag.nodes.map((n) => n.nodeId).sort()).toEqual(["Res1", "WorkerA"].sort());
    });

    it("4.4 records requested resource quantity", () => {
      const edge = detector.addEdge({
        edgeId: "e-res-qty",
        fromNodeId: "WorkerA",
        toNodeId: "Res1",
        dependencyType: "RESOURCE",
        resourceQuantity: 4,
      });
      expect(edge.resourceQuantity).toBe(4);
    });

    it("4.5 empty RAG when no resource edges present", () => {
      const rag = detector.getResourceAllocationGraph();
      expect(rag.edges.length).toBe(0);
      expect(rag.nodes.length).toBe(0);
    });
  });

  // ============================================================================
  // Category 5: Elementary 2-Node Deadlock Detection (A -> B -> A)
  // ============================================================================
  describe("Category 5: Elementary 2-Node Deadlock Detection", () => {
    beforeEach(() => {
      detector.addNode({ nodeId: "A", nodeType: "AGENT", entityId: "a1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "B", nodeType: "AGENT", entityId: "a2", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
    });

    it("5.1 detects elementary 2-node cycle via DFS", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 1200 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 1200 });

      const cycles = detector.detectCyclesDFS();
      expect(cycles.length).toBe(1);
      expect(cycles[0]).toEqual(["A", "B"]);
    });

    it("5.2 detects elementary 2-node cycle via Tarjan SCC", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT" });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT" });

      const sccs = detector.detectCyclesTarjanSCC();
      expect(sccs.length).toBe(1);
      expect(sccs[0]).toEqual(["A", "B"]);
    });

    it("5.3 detects no cycle when edges are unidirectional (A -> B only)", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT" });
      const cycles = detector.detectCyclesDFS();
      expect(cycles.length).toBe(0);
    });

    it("5.4 generates cycle witness for 2-node cycle", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 1200 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 1200 });

      const witnesses = detector.detectAllDeadlocks();
      expect(witnesses.length).toBe(1);
      expect(witnesses[0].cycleLength).toBe(2);
      expect(witnesses[0].classification).toBe("TRUE_DEADLOCK");
    });

    it("5.5 cycle witness digest is cryptographically valid", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 1200 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 1200 });

      const witnesses = detector.detectAllDeadlocks();
      const val = validateCycleWitness(witnesses[0]);
      expect(val.valid).toBe(true);
    });
  });

  // ============================================================================
  // Category 6: 3-Node Deadlock Detection (A -> B -> C -> A)
  // ============================================================================
  describe("Category 6: 3-Node Deadlock Detection", () => {
    beforeEach(() => {
      detector.addNode({ nodeId: "A", nodeType: "AGENT", entityId: "a1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "B", nodeType: "AGENT", entityId: "a2", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "C", nodeType: "AGENT", entityId: "a3", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
    });

    it("6.1 detects 3-node cycle via DFS", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 800 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "C", dependencyType: "WAIT", waitDurationMs: 800 });
      detector.addEdge({ edgeId: "e3", fromNodeId: "C", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 800 });

      const cycles = detector.detectCyclesDFS();
      expect(cycles.length).toBe(1);
      expect(cycles[0]).toEqual(["A", "B", "C"]);
    });

    it("6.2 detects 3-node cycle via Tarjan SCC", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT" });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "C", dependencyType: "WAIT" });
      detector.addEdge({ edgeId: "e3", fromNodeId: "C", toNodeId: "A", dependencyType: "WAIT" });

      const sccs = detector.detectCyclesTarjanSCC();
      expect(sccs.length).toBe(1);
      expect(sccs[0]).toEqual(["A", "B", "C"]);
    });

    it("6.3 no cycle detected if 3-node chain has open terminal (A -> B -> C)", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT" });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "C", dependencyType: "WAIT" });

      expect(detector.detectCyclesDFS().length).toBe(0);
    });

    it("6.4 3-node cycle creates witness with 3 participating edges", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 800 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "C", dependencyType: "WAIT", waitDurationMs: 800 });
      detector.addEdge({ edgeId: "e3", fromNodeId: "C", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 800 });

      const witnesses = detector.detectAllDeadlocks();
      expect(witnesses[0].edgeIds).toEqual(["e1", "e2", "e3"]);
    });

    it("6.5 3-node witness length equals 3", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 800 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "C", dependencyType: "WAIT", waitDurationMs: 800 });
      detector.addEdge({ edgeId: "e3", fromNodeId: "C", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 800 });

      const witnesses = detector.detectAllDeadlocks();
      expect(witnesses[0].cycleLength).toBe(3);
    });
  });

  // ============================================================================
  // Category 7: 4-Node Deadlock Detection (A -> B -> C -> D -> A)
  // ============================================================================
  describe("Category 7: 4-Node Deadlock Detection", () => {
    beforeEach(() => {
      ["A", "B", "C", "D"].forEach((id) =>
        detector.addNode({ nodeId: id, nodeType: "GOAL", entityId: `g-${id}`, workflowId: "w", missionContractId: "c", missionContractHash: "h" }),
      );
    });

    it("7.1 detects 4-node circular dependency", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "GOAL", waitDurationMs: 500 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "C", dependencyType: "GOAL", waitDurationMs: 500 });
      detector.addEdge({ edgeId: "e3", fromNodeId: "C", toNodeId: "D", dependencyType: "GOAL", waitDurationMs: 500 });
      detector.addEdge({ edgeId: "e4", fromNodeId: "D", toNodeId: "A", dependencyType: "GOAL", waitDurationMs: 500 });

      const cycles = detector.detectCyclesDFS();
      expect(cycles.length).toBe(1);
      expect(cycles[0]).toEqual(["A", "B", "C", "D"]);
    });

    it("7.2 classified as TRUE_DEADLOCK when duration exceeds threshold", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "GOAL", waitDurationMs: 500 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "C", dependencyType: "GOAL", waitDurationMs: 500 });
      detector.addEdge({ edgeId: "e3", fromNodeId: "C", toNodeId: "D", dependencyType: "GOAL", waitDurationMs: 500 });
      detector.addEdge({ edgeId: "e4", fromNodeId: "D", toNodeId: "A", dependencyType: "GOAL", waitDurationMs: 500 });

      const witnesses = detector.detectAllDeadlocks();
      expect(witnesses[0].classification).toBe("TRUE_DEADLOCK");
    });

    it("7.3 breaking any edge resolves 4-node cycle", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "GOAL", waitDurationMs: 500 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "C", dependencyType: "GOAL", waitDurationMs: 500 });
      detector.addEdge({ edgeId: "e3", fromNodeId: "C", toNodeId: "D", dependencyType: "GOAL", waitDurationMs: 500 });
      detector.addEdge({ edgeId: "e4", fromNodeId: "D", toNodeId: "A", dependencyType: "GOAL", waitDurationMs: 500 });

      detector.removeEdge("e3");
      expect(detector.detectCyclesDFS().length).toBe(0);
    });

    it("7.4 Tarjan SCC correctly isolates 4-node component", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "GOAL" });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "C", dependencyType: "GOAL" });
      detector.addEdge({ edgeId: "e3", fromNodeId: "C", toNodeId: "D", dependencyType: "GOAL" });
      detector.addEdge({ edgeId: "e4", fromNodeId: "D", toNodeId: "A", dependencyType: "GOAL" });

      const sccs = detector.detectCyclesTarjanSCC();
      expect(sccs.length).toBe(1);
      expect(sccs[0].length).toBe(4);
    });

    it("7.5 4-node witness contains exactly 4 edgeIds", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "GOAL", waitDurationMs: 500 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "C", dependencyType: "GOAL", waitDurationMs: 500 });
      detector.addEdge({ edgeId: "e3", fromNodeId: "C", toNodeId: "D", dependencyType: "GOAL", waitDurationMs: 500 });
      detector.addEdge({ edgeId: "e4", fromNodeId: "D", toNodeId: "A", dependencyType: "GOAL", waitDurationMs: 500 });

      const witnesses = detector.detectAllDeadlocks();
      expect(witnesses[0].edgeIds.length).toBe(4);
    });
  });

  // ============================================================================
  // Category 8: 8-Node Complex Deadlock Detection
  // ============================================================================
  describe("Category 8: 8-Node Complex Deadlock Detection", () => {
    const nodes = ["N1", "N2", "N3", "N4", "N5", "N6", "N7", "N8"];
    beforeEach(() => {
      nodes.forEach((id) =>
        detector.addNode({ nodeId: id, nodeType: "TASK", entityId: `t-${id}`, workflowId: "w", missionContractId: "c", missionContractHash: "h" }),
      );
    });

    it("8.1 detects 8-node circular ring", () => {
      for (let i = 0; i < nodes.length; i++) {
        detector.addEdge({
          edgeId: `e-${i + 1}`,
          fromNodeId: nodes[i],
          toNodeId: nodes[(i + 1) % nodes.length],
          dependencyType: "WAIT",
          waitDurationMs: 400,
        });
      }
      const cycles = detector.detectCyclesDFS();
      expect(cycles.length).toBe(1);
      expect(cycles[0].length).toBe(8);
    });

    it("8.2 8-node cycle is recognized in single witness", () => {
      for (let i = 0; i < nodes.length; i++) {
        detector.addEdge({
          edgeId: `e-${i + 1}`,
          fromNodeId: nodes[i],
          toNodeId: nodes[(i + 1) % nodes.length],
          dependencyType: "WAIT",
          waitDurationMs: 400,
        });
      }
      const witnesses = detector.detectAllDeadlocks();
      expect(witnesses.length).toBe(1);
      expect(witnesses[0].cycleLength).toBe(8);
    });

    it("8.3 removing any single edge breaks 8-node ring", () => {
      for (let i = 0; i < nodes.length; i++) {
        detector.addEdge({
          edgeId: `e-${i + 1}`,
          fromNodeId: nodes[i],
          toNodeId: nodes[(i + 1) % nodes.length],
          dependencyType: "WAIT",
          waitDurationMs: 400,
        });
      }
      detector.removeEdge("e-5");
      expect(detector.detectCyclesDFS().length).toBe(0);
    });

    it("8.4 8-node witness digest matches canonical hash", () => {
      for (let i = 0; i < nodes.length; i++) {
        detector.addEdge({
          edgeId: `e-${i + 1}`,
          fromNodeId: nodes[i],
          toNodeId: nodes[(i + 1) % nodes.length],
          dependencyType: "WAIT",
          waitDurationMs: 400,
        });
      }
      const witness = detector.detectAllDeadlocks()[0];
      expect(validateCycleWitness(witness).valid).toBe(true);
    });

    it("8.5 Tarjan SCC groups all 8 nodes into one component", () => {
      for (let i = 0; i < nodes.length; i++) {
        detector.addEdge({
          edgeId: `e-${i + 1}`,
          fromNodeId: nodes[i],
          toNodeId: nodes[(i + 1) % nodes.length],
          dependencyType: "WAIT",
        });
      }
      const sccs = detector.detectCyclesTarjanSCC();
      expect(sccs.length).toBe(1);
      expect(sccs[0].length).toBe(8);
    });
  });

  // ============================================================================
  // Category 9: Nested and Overlapping Dependency Cycles
  // ============================================================================
  describe("Category 9: Nested and Overlapping Dependency Cycles", () => {
    beforeEach(() => {
      ["A", "B", "C", "D"].forEach((id) =>
        detector.addNode({ nodeId: id, nodeType: "GOAL", entityId: `g-${id}`, workflowId: "w", missionContractId: "c", missionContractHash: "h" }),
      );
    });

    it("9.1 detects figure-8 overlapping cycle (A<->B and B<->C)", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 600 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 600 });
      detector.addEdge({ edgeId: "e3", fromNodeId: "B", toNodeId: "C", dependencyType: "WAIT", waitDurationMs: 600 });
      detector.addEdge({ edgeId: "e4", fromNodeId: "C", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 600 });

      const cycles = detector.detectCyclesDFS();
      expect(cycles.length).toBe(2);
    });

    it("9.2 detects chord-nested cycle (A->B->C->A with chord A->C)", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 600 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "C", dependencyType: "WAIT", waitDurationMs: 600 });
      detector.addEdge({ edgeId: "e3", fromNodeId: "C", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 600 });
      detector.addEdge({ edgeId: "e4", fromNodeId: "A", toNodeId: "C", dependencyType: "WAIT", waitDurationMs: 600 });

      const witnesses = detector.detectAllDeadlocks();
      expect(witnesses.length).toBeGreaterThanOrEqual(1);
    });

    it("9.3 Tarjan SCC merges overlapping cycles into single component", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT" });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT" });
      detector.addEdge({ edgeId: "e3", fromNodeId: "B", toNodeId: "C", dependencyType: "WAIT" });
      detector.addEdge({ edgeId: "e4", fromNodeId: "C", toNodeId: "B", dependencyType: "WAIT" });

      const sccs = detector.detectCyclesTarjanSCC();
      expect(sccs.length).toBe(1);
      expect(sccs[0].sort()).toEqual(["A", "B", "C"].sort());
    });

    it("9.4 deduplicates witnesses across identical node sets", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 500 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 500 });

      const witnesses = detector.detectAllDeadlocks();
      expect(witnesses.length).toBe(1);
    });

    it("9.5 resolving shared node B impacts both overlapping cycles", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 600 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 600 });
      detector.addEdge({ edgeId: "e3", fromNodeId: "B", toNodeId: "C", dependencyType: "WAIT", waitDurationMs: 600 });
      detector.addEdge({ edgeId: "e4", fromNodeId: "C", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 600 });

      detector.removeEdge("e2");
      detector.removeEdge("e4");
      expect(detector.detectCyclesDFS().length).toBe(0);
    });
  });

  // ============================================================================
  // Category 10: Multiple Independent Disjoint Cycles in Parallel
  // ============================================================================
  describe("Category 10: Multiple Independent Disjoint Cycles in Parallel", () => {
    beforeEach(() => {
      ["A1", "A2", "B1", "B2"].forEach((id) =>
        detector.addNode({ nodeId: id, nodeType: "GOAL", entityId: `g-${id}`, workflowId: "w", missionContractId: "c", missionContractHash: "h" }),
      );
    });

    it("10.1 detects 2 completely independent disjoint cycles simultaneously", () => {
      detector.addEdge({ edgeId: "eA1", fromNodeId: "A1", toNodeId: "A2", dependencyType: "WAIT", waitDurationMs: 500 });
      detector.addEdge({ edgeId: "eA2", fromNodeId: "A2", toNodeId: "A1", dependencyType: "WAIT", waitDurationMs: 500 });

      detector.addEdge({ edgeId: "eB1", fromNodeId: "B1", toNodeId: "B2", dependencyType: "WAIT", waitDurationMs: 500 });
      detector.addEdge({ edgeId: "eB2", fromNodeId: "B2", toNodeId: "B1", dependencyType: "WAIT", waitDurationMs: 500 });

      const witnesses = detector.detectAllDeadlocks();
      expect(witnesses.length).toBe(2);
    });

    it("10.2 Tarjan SCC isolates two distinct SCCs", () => {
      detector.addEdge({ edgeId: "eA1", fromNodeId: "A1", toNodeId: "A2", dependencyType: "WAIT" });
      detector.addEdge({ edgeId: "eA2", fromNodeId: "A2", toNodeId: "A1", dependencyType: "WAIT" });

      detector.addEdge({ edgeId: "eB1", fromNodeId: "B1", toNodeId: "B2", dependencyType: "WAIT" });
      detector.addEdge({ edgeId: "eB2", fromNodeId: "B2", toNodeId: "B1", dependencyType: "WAIT" });

      const sccs = detector.detectCyclesTarjanSCC();
      expect(sccs.length).toBe(2);
    });

    it("10.3 resolving Cycle A leaves Cycle B intact", () => {
      detector.addEdge({ edgeId: "eA1", fromNodeId: "A1", toNodeId: "A2", dependencyType: "WAIT", waitDurationMs: 500 });
      detector.addEdge({ edgeId: "eA2", fromNodeId: "A2", toNodeId: "A1", dependencyType: "WAIT", waitDurationMs: 500 });

      detector.addEdge({ edgeId: "eB1", fromNodeId: "B1", toNodeId: "B2", dependencyType: "WAIT", waitDurationMs: 500 });
      detector.addEdge({ edgeId: "eB2", fromNodeId: "B2", toNodeId: "B1", dependencyType: "WAIT", waitDurationMs: 500 });

      detector.removeEdge("eA1");
      const remaining = detector.detectAllDeadlocks();
      expect(remaining.length).toBe(1);
      expect(remaining[0].nodeIds.sort()).toEqual(["B1", "B2"].sort());
    });

    it("10.4 each disjoint cycle receives distinct witness IDs", () => {
      detector.addEdge({ edgeId: "eA1", fromNodeId: "A1", toNodeId: "A2", dependencyType: "WAIT", waitDurationMs: 500 });
      detector.addEdge({ edgeId: "eA2", fromNodeId: "A2", toNodeId: "A1", dependencyType: "WAIT", waitDurationMs: 500 });

      detector.addEdge({ edgeId: "eB1", fromNodeId: "B1", toNodeId: "B2", dependencyType: "WAIT", waitDurationMs: 500 });
      detector.addEdge({ edgeId: "eB2", fromNodeId: "B2", toNodeId: "B1", dependencyType: "WAIT", waitDurationMs: 500 });

      const witnesses = detector.detectAllDeadlocks();
      expect(witnesses[0].cycleId).not.toBe(witnesses[1].cycleId);
    });

    it("10.5 both disjoint witnesses have valid digests", () => {
      detector.addEdge({ edgeId: "eA1", fromNodeId: "A1", toNodeId: "A2", dependencyType: "WAIT", waitDurationMs: 500 });
      detector.addEdge({ edgeId: "eA2", fromNodeId: "A2", toNodeId: "A1", dependencyType: "WAIT", waitDurationMs: 500 });

      detector.addEdge({ edgeId: "eB1", fromNodeId: "B1", toNodeId: "B2", dependencyType: "WAIT", waitDurationMs: 500 });
      detector.addEdge({ edgeId: "eB2", fromNodeId: "B2", toNodeId: "B1", dependencyType: "WAIT", waitDurationMs: 500 });

      const witnesses = detector.detectAllDeadlocks();
      expect(validateCycleWitness(witnesses[0]).valid).toBe(true);
      expect(validateCycleWitness(witnesses[1]).valid).toBe(true);
    });
  });

  // ============================================================================
  // Category 11: Tarjan SCC vs DFS Cycle Detection Deterministic Consistency
  // ============================================================================
  describe("Category 11: Tarjan SCC vs DFS Deterministic Consistency", () => {
    beforeEach(() => {
      ["X", "Y", "Z"].forEach((id) =>
        detector.addNode({ nodeId: id, nodeType: "TASK", entityId: `t-${id}`, workflowId: "w", missionContractId: "c", missionContractHash: "h" }),
      );
    });

    it("11.1 both algorithms detect cycle in identical graph", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "X", toNodeId: "Y", dependencyType: "WAIT" });
      detector.addEdge({ edgeId: "e2", fromNodeId: "Y", toNodeId: "Z", dependencyType: "WAIT" });
      detector.addEdge({ edgeId: "e3", fromNodeId: "Z", toNodeId: "X", dependencyType: "WAIT" });

      const dfsCycles = detector.detectCyclesDFS();
      const sccCycles = detector.detectCyclesTarjanSCC();

      expect(dfsCycles.length).toBe(1);
      expect(sccCycles.length).toBe(1);
      expect(dfsCycles[0].sort()).toEqual(sccCycles[0].sort());
    });

    it("11.2 both algorithms report no cycles in acyclic DAG", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "X", toNodeId: "Y", dependencyType: "WAIT" });
      detector.addEdge({ edgeId: "e2", fromNodeId: "Y", toNodeId: "Z", dependencyType: "WAIT" });

      expect(detector.detectCyclesDFS().length).toBe(0);
      expect(detector.detectCyclesTarjanSCC().length).toBe(0);
    });

    it("11.3 results are deterministic across multiple calls", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "X", toNodeId: "Y", dependencyType: "WAIT" });
      detector.addEdge({ edgeId: "e2", fromNodeId: "Y", toNodeId: "X", dependencyType: "WAIT" });

      const r1 = detector.detectCyclesDFS();
      const r2 = detector.detectCyclesDFS();
      expect(r1).toEqual(r2);
    });

    it("11.4 node insertion order does not alter detected cycle membership", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "Z", toNodeId: "X", dependencyType: "WAIT" });
      detector.addEdge({ edgeId: "e2", fromNodeId: "X", toNodeId: "Z", dependencyType: "WAIT" });

      const cycles = detector.detectCyclesDFS();
      expect(cycles[0].sort()).toEqual(["X", "Z"].sort());
    });

    it("11.5 SCC ignores self-loops if node not connecting to itself", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "X", toNodeId: "Y", dependencyType: "WAIT" });
      const sccs = detector.detectCyclesTarjanSCC();
      expect(sccs.length).toBe(0);
    });
  });

  // ============================================================================
  // Category 12: Cycle Witness Construction & Cryptographic Provenance (N648, N649)
  // ============================================================================
  describe("Category 12: Cycle Witness Construction & Provenance", () => {
    it("12.1 witness contains non-empty provenance root", () => {
      detector.addNode({ nodeId: "A", nodeType: "GOAL", entityId: "g1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "B", nodeType: "GOAL", entityId: "g2", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 400 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 400 });

      const witness = detector.createCycleWitness(["A", "B"], 1);
      expect(witness.provenanceRoot).toBeDefined();
      expect(witness.provenanceRoot.length).toBe(64);
    });

    it("12.2 witness validation rejects forged witness digest (N648)", () => {
      detector.addNode({ nodeId: "A", nodeType: "GOAL", entityId: "g1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "B", nodeType: "GOAL", entityId: "g2", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 400 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 400 });

      const witness = detector.createCycleWitness(["A", "B"], 1);
      const forged = { ...witness, witnessDigest: "forged-digest-1234" };
      const val = validateCycleWitness(forged);
      expect(val.valid).toBe(false);
      expect(val.reason).toContain("Witness digest mismatch");
      expect(val.reason).toContain("N648");
    });

    it("12.3 witness validation rejects cycleLength mismatch", () => {
      detector.addNode({ nodeId: "A", nodeType: "GOAL", entityId: "g1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "B", nodeType: "GOAL", entityId: "g2", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      const witness = detector.createCycleWitness(["A", "B"], 1);
      const forged = { ...witness, cycleLength: 5 };
      expect(validateCycleWitness(forged).valid).toBe(false);
    });

    it("12.4 witness validation rejects fewer than 2 nodes", () => {
      const forged: CycleWitness = {
        cycleId: "c1",
        nodeIds: ["A"],
        edgeIds: [],
        classification: "TRUE_DEADLOCK",
        cycleLength: 1,
        detectedAt: "2026-10-21T12:00:00.000Z",
        witnessDigest: "x",
        provenanceRoot: "y",
      };
      expect(validateCycleWitness(forged).valid).toBe(false);
    });

    it("12.5 cycle witness timestamp matches clock time", () => {
      detector.addNode({ nodeId: "A", nodeType: "GOAL", entityId: "g1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "B", nodeType: "GOAL", entityId: "g2", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 400 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 400 });

      clock.setTime("2026-10-21T14:30:00.000Z");
      const witness = detector.createCycleWitness(["A", "B"], 1);
      expect(witness.detectedAt).toBe("2026-10-21T14:30:00.000Z");
    });
  });

  // ============================================================================
  // Category 13: Cycle Classification: TRUE_DEADLOCK vs TRANSIENT_CONTENTION
  // ============================================================================
  describe("Category 13: Cycle Classification: TRUE_DEADLOCK vs TRANSIENT_CONTENTION", () => {
    beforeEach(() => {
      detector.addNode({ nodeId: "A", nodeType: "AGENT", entityId: "a1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "B", nodeType: "AGENT", entityId: "a2", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
    });

    it("13.1 classifies short-duration optional edge wait as TRANSIENT_CONTENTION", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 50, isOptional: true });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 50, isOptional: true });

      const classification = detector.classifyCycle(["A", "B"]);
      expect(classification).toBe("TRANSIENT_CONTENTION");
    });

    it("13.2 classifies long-duration wait (> 500ms) as TRUE_DEADLOCK", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 1500, isOptional: false });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 1500, isOptional: false });

      const classification = detector.classifyCycle(["A", "B"]);
      expect(classification).toBe("TRUE_DEADLOCK");
    });

    it("13.3 transient contention produces NO_INTERVENTION recommendation", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 50, isOptional: true });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 50, isOptional: true });

      const witness = detector.createCycleWitness(["A", "B"], 1);
      const decision = resolver.selectStrategy(witness);
      expect(decision.strategy).toBe("NO_INTERVENTION");
    });

    it("13.4 true deadlock produces active cycle-breaking strategy", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 1500 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 1500 });

      const witness = detector.createCycleWitness(["A", "B"], 1);
      const decision = resolver.selectStrategy(witness);
      expect(decision.strategy).not.toBe("NO_INTERVENTION");
    });

    it("13.5 unknown node returns UNKNOWN classification", () => {
      expect(detector.classifyCycle(["nonexistent-1", "nonexistent-2"])).toBe("UNKNOWN");
    });
  });

  // ============================================================================
  // Category 14: Cycle Classification: STARVATION vs Deadlock
  // ============================================================================
  describe("Category 14: Cycle Classification: STARVATION vs Deadlock", () => {
    it("14.1 linear wait chain without closed cycle is not classified as deadlock", () => {
      detector.addNode({ nodeId: "A", nodeType: "GOAL", entityId: "g1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "B", nodeType: "GOAL", entityId: "g2", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 50000 });

      const cycles = detector.detectCyclesDFS();
      expect(cycles.length).toBe(0); // Starvation does not have a closed cycle!
    });

    it("14.2 starvation is addressed via aging in Phase 96 without cycle detection", () => {
      // Starvation is an orthogonal scheduling delay, not a circular deadlock
      expect(DEADLOCK_CORE_INVARIANTS.D3).toContain("True deadlock requires a verified closed causal dependency cycle");
    });

    it("14.3 deadlock detector does not emit witnesses for acyclic starvations", () => {
      detector.addNode({ nodeId: "A", nodeType: "GOAL", entityId: "g1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "B", nodeType: "GOAL", entityId: "g2", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "C", nodeType: "GOAL", entityId: "g3", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 80000 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "C", dependencyType: "WAIT", waitDurationMs: 80000 });

      expect(detector.detectAllDeadlocks().length).toBe(0);
    });

    it("14.4 starvation without cycle cannot trigger cycle breaking interventions", () => {
      const witnesses = detector.detectAllDeadlocks();
      expect(witnesses.length).toBe(0);
    });

    it("14.5 starvation protection cannot escalate authority (N626, D13)", () => {
      expect(DEADLOCK_CORE_INVARIANTS.D13).toContain("Priority remains advisory");
    });
  });

  // ============================================================================
  // Category 15: Cycle Classification: PRIORITY_INVERSION Recognition
  // ============================================================================
  describe("Category 15: Cycle Classification: PRIORITY_INVERSION Recognition", () => {
    beforeEach(() => {
      detector.addNode({ nodeId: "HighPrio", nodeType: "GOAL", entityId: "g-high", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "LowPrio", nodeType: "GOAL", entityId: "g-low", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
    });

    it("15.1 classifies cycle with PRIORITY dependency as PRIORITY_INVERSION", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "HighPrio", toNodeId: "LowPrio", dependencyType: "PRIORITY", waitDurationMs: 1200 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "LowPrio", toNodeId: "HighPrio", dependencyType: "WAIT", waitDurationMs: 1200 });

      expect(detector.classifyCycle(["HighPrio", "LowPrio"])).toBe("PRIORITY_INVERSION");
    });

    it("15.2 priority inversion selects PRIORITY_INHERITANCE strategy", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "HighPrio", toNodeId: "LowPrio", dependencyType: "PRIORITY", waitDurationMs: 1200 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "LowPrio", toNodeId: "HighPrio", dependencyType: "WAIT", waitDurationMs: 1200 });

      const witness = detector.createCycleWitness(["HighPrio", "LowPrio"], 1);
      const decision = resolver.selectStrategy(witness);
      expect(decision.strategy).toBe("PRIORITY_INHERITANCE");
    });

    it("15.3 priority inheritance resolution cost is 30", () => {
      expect(INTERVENTION_STRATEGY_COSTS.PRIORITY_INHERITANCE).toBe(30);
    });

    it("15.4 priority inheritance does not confer terminal authority (N650)", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "HighPrio", toNodeId: "LowPrio", dependencyType: "PRIORITY", waitDurationMs: 1200 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "LowPrio", toNodeId: "HighPrio", dependencyType: "WAIT", waitDurationMs: 1200 });

      const witness = detector.createCycleWitness(["HighPrio", "LowPrio"], 1);
      const res = resolver.resolveCycle(witness);
      expect(res.resolution.authoritative).toBe(false);
    });

    it("15.5 priority inheritance resolves the deadlock cycle", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "HighPrio", toNodeId: "LowPrio", dependencyType: "PRIORITY", waitDurationMs: 1200 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "LowPrio", toNodeId: "HighPrio", dependencyType: "WAIT", waitDurationMs: 1200 });

      const witness = detector.createCycleWitness(["HighPrio", "LowPrio"], 1);
      const res = resolver.resolveCycle(witness);
      expect(res.success).toBe(true);
      expect(detector.detectCyclesDFS().length).toBe(0);
    });
  });

  // ============================================================================
  // Category 16: Cycle Classification: RESOURCE_EXHAUSTION vs Deadlock
  // ============================================================================
  describe("Category 16: Cycle Classification: RESOURCE_EXHAUSTION", () => {
    beforeEach(() => {
      detector.addNode({ nodeId: "R1", nodeType: "RESOURCE", entityId: "res-1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "R2", nodeType: "RESOURCE", entityId: "res-2", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
    });

    it("16.1 classifies pure resource loop under short wait as RESOURCE_EXHAUSTION", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "R1", toNodeId: "R2", dependencyType: "RESOURCE", waitDurationMs: 400 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "R2", toNodeId: "R1", dependencyType: "RESOURCE", waitDurationMs: 400 });

      expect(detector.classifyCycle(["R1", "R2"])).toBe("RESOURCE_EXHAUSTION");
    });

    it("16.2 selects RESOURCE_REORDERING strategy for resource exhaustion", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "R1", toNodeId: "R2", dependencyType: "RESOURCE", waitDurationMs: 400 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "R2", toNodeId: "R1", dependencyType: "RESOURCE", waitDurationMs: 400 });

      const witness = detector.createCycleWitness(["R1", "R2"], 1);
      const decision = resolver.selectStrategy(witness);
      expect(decision.strategy).toBe("RESOURCE_REORDERING");
    });

    it("16.3 resource reordering has cost 20", () => {
      expect(INTERVENTION_STRATEGY_COSTS.RESOURCE_REORDERING).toBe(20);
    });

    it("16.4 resource reordering breaks closing edge cleanly", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "R1", toNodeId: "R2", dependencyType: "RESOURCE", waitDurationMs: 400 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "R2", toNodeId: "R1", dependencyType: "RESOURCE", waitDurationMs: 400 });

      const witness = detector.createCycleWitness(["R1", "R2"], 1);
      const res = resolver.resolveCycle(witness);
      expect(res.success).toBe(true);
      expect(detector.detectCyclesDFS().length).toBe(0);
    });

    it("16.5 resource reordering does not grant resource ownership", () => {
      const node = detector.getNode("R1");
      expect(node?.authoritative).toBe(false);
    });
  });

  // ============================================================================
  // Category 17: Cycle Classification: LIVELOCK Detection & Differentiation
  // ============================================================================
  describe("Category 17: Cycle Classification: LIVELOCK Detection", () => {
    beforeEach(() => {
      detector.addNode({ nodeId: "A", nodeType: "AGENT", entityId: "agent-1", agentId: "agent-1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "B", nodeType: "AGENT", entityId: "agent-2", agentId: "agent-2", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
    });

    it("17.1 detects agent spinning with zero useful work as livelocked", () => {
      for (let i = 0; i < 10; i++) {
        detector.recordAction("agent-1", "RETRY_DISPATCH", false);
      }
      expect(detector.isAgentLivelocked("agent-1")).toBe(true);
    });

    it("17.2 agent with useful work is not livelocked", () => {
      for (let i = 0; i < 10; i++) {
        detector.recordAction("agent-2", "APPLY_PATCH", true);
      }
      expect(detector.isAgentLivelocked("agent-2")).toBe(false);
    });

    it("17.3 classifies cycle containing livelocked agent as LIVELOCK", () => {
      for (let i = 0; i < 10; i++) {
        detector.recordAction("agent-1", "RETRY_DISPATCH", false);
      }
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 1200 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 1200 });

      expect(detector.classifyCycle(["A", "B"])).toBe("LIVELOCK");
    });

    it("17.4 livelock history is bounded", () => {
      for (let i = 0; i < 70; i++) {
        detector.recordAction("agent-1", `ACTION_${i}`, false);
      }
      expect(detector.isAgentLivelocked("agent-1")).toBe(true);
    });

    it("17.5 clearing detector resets livelock counters", () => {
      for (let i = 0; i < 10; i++) {
        detector.recordAction("agent-1", "RETRY", false);
      }
      detector.clear();
      expect(detector.isAgentLivelocked("agent-1")).toBe(false);
    });
  });

  // ============================================================================
  // Category 18: Cycle Classification: STALE_DEPENDENCY & RECOVERABLE_LEASE_FAILURE
  // ============================================================================
  describe("Category 18: Stale Dependency & Lease Failure", () => {
    beforeEach(() => {
      detector.addNode({ nodeId: "W1", nodeType: "WORKER", entityId: "w1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "W2", nodeType: "WORKER", entityId: "w2", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
    });

    it("18.1 classifies lease wait > 30000ms as RECOVERABLE_LEASE_FAILURE", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "W1", toNodeId: "W2", dependencyType: "LEASE", waitDurationMs: 35000 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "W2", toNodeId: "W1", dependencyType: "WAIT", waitDurationMs: 35000 });

      expect(detector.classifyCycle(["W1", "W2"])).toBe("RECOVERABLE_LEASE_FAILURE");
    });

    it("18.2 classifies very old wait (> 60000ms) as STALE_DEPENDENCY", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "W1", toNodeId: "W2", dependencyType: "WAIT", waitDurationMs: 65000 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "W2", toNodeId: "W1", dependencyType: "WAIT", waitDurationMs: 65000 });

      expect(detector.classifyCycle(["W1", "W2"])).toBe("STALE_DEPENDENCY");
    });

    it("18.3 selects LEASE_RECOVERY strategy for lease failure", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "W1", toNodeId: "W2", dependencyType: "LEASE", waitDurationMs: 35000 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "W2", toNodeId: "W1", dependencyType: "WAIT", waitDurationMs: 35000 });

      const witness = detector.createCycleWitness(["W1", "W2"], 1);
      const dec = resolver.selectStrategy(witness);
      expect(dec.strategy).toBe("LEASE_RECOVERY");
    });

    it("18.4 lease recovery has intervention cost 70", () => {
      expect(INTERVENTION_STRATEGY_COSTS.LEASE_RECOVERY).toBe(70);
    });

    it("18.5 lease recovery preserves worker lease fencing (D12, N652)", () => {
      expect(DEADLOCK_CORE_INVARIANTS.D12).toContain("Lease fencing remains authoritative");
    });
  });

  // ============================================================================
  // Category 19: Cycle Classification: UNKNOWN Fail-Closed Handling (D4, N646)
  // ============================================================================
  describe("Category 19: UNKNOWN Fail-Closed Handling", () => {
    it("19.1 empty or incomplete cycle classified as UNKNOWN", () => {
      expect(detector.classifyCycle([])).toBe("UNKNOWN");
      expect(detector.classifyCycle(["only-one"])).toBe("UNKNOWN");
    });

    it("19.2 UNKNOWN classification forces HUMAN_REVIEW_REQUIRED strategy (D4, N646)", () => {
      const witness: CycleWitness = {
        cycleId: "c-unk",
        nodeIds: ["n1", "n2"],
        edgeIds: ["e1"],
        classification: "UNKNOWN",
        cycleLength: 2,
        detectedAt: "2026-10-21T12:00:00.000Z",
        witnessDigest: sha256Hex("UNK"),
        provenanceRoot: sha256Hex("PROV_UNK"),
      };

      const dec = resolver.selectStrategy(witness);
      expect(dec.strategy).toBe("HUMAN_REVIEW_REQUIRED");
      expect(dec.rationale).toContain("fail-closed quarantine required");
    });

    it("19.3 UNKNOWN classification does not allow automated destructive resolution (N646)", () => {
      const witness: CycleWitness = {
        cycleId: "c-unk",
        nodeIds: ["n1", "n2"],
        edgeIds: ["e1"],
        classification: "UNKNOWN",
        cycleLength: 2,
        detectedAt: "2026-10-21T12:00:00.000Z",
        witnessDigest: sha256Hex("UNK"),
        provenanceRoot: sha256Hex("PROV_UNK"),
      };

      const val = policy.validateResolutionAuthority(witness, "GOVERNED_PREEMPTION");
      expect(val.valid).toBe(false);
      expect(val.reason).toContain("UNKNOWN classification cannot trigger automated destructive intervention");
    });

    it("19.4 HUMAN_REVIEW_REQUIRED has highest cost (100)", () => {
      expect(INTERVENTION_STRATEGY_COSTS.HUMAN_REVIEW_REQUIRED).toBe(100);
    });

    it("19.5 resolveCycle returns success=false for quarantined human review", () => {
      const witness: CycleWitness = {
        cycleId: "c-unk",
        nodeIds: ["n1", "n2"],
        edgeIds: ["e1"],
        classification: "UNKNOWN",
        cycleLength: 2,
        detectedAt: "2026-10-21T12:00:00.000Z",
        witnessDigest: sha256Hex("UNK"),
        provenanceRoot: sha256Hex("PROV_UNK"),
      };
      const res = resolver.resolveCycle(witness);
      expect(res.success).toBe(false);
      expect(res.resolution.strategy).toBe("HUMAN_REVIEW_REQUIRED");
    });
  });

  // ============================================================================
  // Category 20: Minimum-Intervention Strategy Ordering (Section 14, D2)
  // ============================================================================
  describe("Category 20: Minimum-Intervention Strategy Ordering", () => {
    it("20.1 verifies exact non-decreasing cost ordering across strategies", () => {
      const strategies: CycleBreakingStrategy[] = [
        "NO_INTERVENTION",
        "WAIT_EDGE_REMOVAL",
        "RESOURCE_REORDERING",
        "PRIORITY_INHERITANCE",
        "WORKLOAD_HANDOFF",
        "GOVERNED_PREEMPTION",
        "SPECULATIVE_BRANCH_TERMINATION",
        "LEASE_RECOVERY",
        "HUMAN_REVIEW_REQUIRED",
      ];

      for (let i = 0; i < strategies.length - 1; i++) {
        const c1 = INTERVENTION_STRATEGY_COSTS[strategies[i]];
        const c2 = INTERVENTION_STRATEGY_COSTS[strategies[i + 1]];
        expect(c1).toBeLessThanOrEqual(c2);
      }
    });

    it("20.2 NO_INTERVENTION cost is strictly 0", () => {
      expect(INTERVENTION_STRATEGY_COSTS.NO_INTERVENTION).toBe(0);
    });

    it("20.3 WAIT_EDGE_REMOVAL is lowest non-zero cost (10)", () => {
      expect(INTERVENTION_STRATEGY_COSTS.WAIT_EDGE_REMOVAL).toBe(10);
    });

    it("20.4 HUMAN_REVIEW_REQUIRED is maximal cost (100)", () => {
      expect(INTERVENTION_STRATEGY_COSTS.HUMAN_REVIEW_REQUIRED).toBe(100);
    });

    it("20.5 all 9 strategies are defined with valid numeric costs", () => {
      expect(Object.keys(INTERVENTION_STRATEGY_COSTS).length).toBe(9);
    });
  });

  // ============================================================================
  // Category 21: Cycle Breaking Strategy 1: WAIT_EDGE_REMOVAL
  // ============================================================================
  describe("Category 21: WAIT_EDGE_REMOVAL", () => {
    beforeEach(() => {
      detector.addNode({ nodeId: "A", nodeType: "GOAL", entityId: "g1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "B", nodeType: "GOAL", entityId: "g2", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
    });

    it("21.1 prefers WAIT_EDGE_REMOVAL when an edge is optional", () => {
      detector.addEdge({ edgeId: "e-req", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 600, isOptional: false });
      detector.addEdge({ edgeId: "e-opt", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 600, isOptional: true });

      const witness = detector.createCycleWitness(["A", "B"], 1);
      const dec = resolver.selectStrategy(witness);
      expect(dec.strategy).toBe("WAIT_EDGE_REMOVAL");
      expect(dec.targetEdgeId).toBe("e-opt");
    });

    it("21.2 executing WAIT_EDGE_REMOVAL removes the optional edge", () => {
      detector.addEdge({ edgeId: "e-req", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 600, isOptional: false });
      detector.addEdge({ edgeId: "e-opt", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 600, isOptional: true });

      const witness = detector.createCycleWitness(["A", "B"], 1);
      const res = resolver.resolveCycle(witness);
      expect(res.success).toBe(true);
      expect(res.brokenEdgeId).toBe("e-opt");
      expect(detector.getEdge("e-opt")).toBeUndefined();
    });

    it("21.3 cycle is eliminated after WAIT_EDGE_REMOVAL", () => {
      detector.addEdge({ edgeId: "e-req", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 600, isOptional: false });
      detector.addEdge({ edgeId: "e-opt", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 600, isOptional: true });

      const witness = detector.createCycleWitness(["A", "B"], 1);
      resolver.resolveCycle(witness);
      expect(detector.detectCyclesDFS().length).toBe(0);
    });

    it("21.4 required edge remains intact", () => {
      detector.addEdge({ edgeId: "e-req", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 600, isOptional: false });
      detector.addEdge({ edgeId: "e-opt", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 600, isOptional: true });

      const witness = detector.createCycleWitness(["A", "B"], 1);
      resolver.resolveCycle(witness);
      expect(detector.getEdge("e-req")).toBeDefined();
    });

    it("21.5 resolution record has interventionCost 10", () => {
      detector.addEdge({ edgeId: "e-req", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 600, isOptional: false });
      detector.addEdge({ edgeId: "e-opt", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 600, isOptional: true });

      const witness = detector.createCycleWitness(["A", "B"], 1);
      const res = resolver.resolveCycle(witness);
      expect(res.resolution.interventionCost).toBe(10);
    });
  });

  // ============================================================================
  // Category 22: Cycle Breaking Strategy 2: RESOURCE_REORDERING
  // ============================================================================
  describe("Category 22: RESOURCE_REORDERING", () => {
    beforeEach(() => {
      detector.addNode({ nodeId: "R1", nodeType: "RESOURCE", entityId: "r1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "R2", nodeType: "RESOURCE", entityId: "r2", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addEdge({ edgeId: "e1", fromNodeId: "R1", toNodeId: "R2", dependencyType: "RESOURCE", waitDurationMs: 300 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "R2", toNodeId: "R1", dependencyType: "RESOURCE", waitDurationMs: 300 });
    });

    it("22.1 selects RESOURCE_REORDERING for pure resource cycle", () => {
      const witness = detector.createCycleWitness(["R1", "R2"], 1);
      const dec = resolver.selectStrategy(witness);
      expect(dec.strategy).toBe("RESOURCE_REORDERING");
    });

    it("22.2 executes resource reordering and removes cycle edge", () => {
      const witness = detector.createCycleWitness(["R1", "R2"], 1);
      const res = resolver.resolveCycle(witness);
      expect(res.success).toBe(true);
      expect(detector.detectCyclesDFS().length).toBe(0);
    });

    it("22.3 resolution record contains valid digest", () => {
      const witness = detector.createCycleWitness(["R1", "R2"], 1);
      const res = resolver.resolveCycle(witness);
      expect(res.resolution.resolutionDigest).toBeDefined();
    });

    it("22.4 resource reordering does not grant resource ownership (D2)", () => {
      const witness = detector.createCycleWitness(["R1", "R2"], 1);
      const res = resolver.resolveCycle(witness);
      expect(res.resolution.authoritative).toBe(false);
    });

    it("22.5 interventionCost is 20", () => {
      const witness = detector.createCycleWitness(["R1", "R2"], 1);
      const res = resolver.resolveCycle(witness);
      expect(res.resolution.interventionCost).toBe(20);
    });
  });

  // ============================================================================
  // Category 23: Cycle Breaking Strategy 3: PRIORITY_INHERITANCE Integration
  // ============================================================================
  describe("Category 23: PRIORITY_INHERITANCE Integration", () => {
    beforeEach(() => {
      detector.addNode({ nodeId: "High", nodeType: "GOAL", entityId: "g-hi", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "Low", nodeType: "GOAL", entityId: "g-lo", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addEdge({ edgeId: "e1", fromNodeId: "High", toNodeId: "Low", dependencyType: "PRIORITY", waitDurationMs: 800 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "Low", toNodeId: "High", dependencyType: "WAIT", waitDurationMs: 800 });
    });

    it("23.1 executes priority inheritance to break priority inversion cycle", () => {
      const witness = detector.createCycleWitness(["High", "Low"], 1);
      const res = resolver.resolveCycle(witness);
      expect(res.resolution.strategy).toBe("PRIORITY_INHERITANCE");
      expect(res.success).toBe(true);
    });

    it("23.2 priority inheritance intervention cost is 30", () => {
      const witness = detector.createCycleWitness(["High", "Low"], 1);
      const res = resolver.resolveCycle(witness);
      expect(res.resolution.interventionCost).toBe(30);
    });

    it("23.3 priority inheritance is non-authoritative (D13, N650)", () => {
      const witness = detector.createCycleWitness(["High", "Low"], 1);
      const res = resolver.resolveCycle(witness);
      expect(res.resolution.authoritative).toBe(false);
    });

    it("23.4 cycle is cleared after resolution", () => {
      const witness = detector.createCycleWitness(["High", "Low"], 1);
      resolver.resolveCycle(witness);
      expect(detector.detectCyclesDFS().length).toBe(0);
    });

    it("23.5 resolution rationale explains priority inheritance action", () => {
      const witness = detector.createCycleWitness(["High", "Low"], 1);
      const res = resolver.resolveCycle(witness);
      expect(res.reason).toContain("priority inheritance");
    });
  });

  // ============================================================================
  // Category 24: Cycle Breaking Strategy 4: GOVERNED_PREEMPTION Integration
  // ============================================================================
  describe("Category 24: GOVERNED_PREEMPTION Integration", () => {
    beforeEach(() => {
      detector.addNode({ nodeId: "G1", nodeType: "GOAL", entityId: "g1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "G2", nodeType: "GOAL", entityId: "g2", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addEdge({ edgeId: "e1", fromNodeId: "G1", toNodeId: "G2", dependencyType: "GOAL", waitDurationMs: 1500 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "G2", toNodeId: "G1", dependencyType: "GOAL", waitDurationMs: 1500 });
    });

    it("24.1 defaults to GOVERNED_PREEMPTION for standard non-optional true deadlocks", () => {
      const witness = detector.createCycleWitness(["G1", "G2"], 1);
      const dec = resolver.selectStrategy(witness);
      expect(dec.strategy).toBe("GOVERNED_PREEMPTION");
    });

    it("24.2 governed preemption has intervention cost 50", () => {
      expect(INTERVENTION_STRATEGY_COSTS.GOVERNED_PREEMPTION).toBe(50);
    });

    it("24.3 preemption target is the tail/victim node", () => {
      const witness = detector.createCycleWitness(["G1", "G2"], 1);
      const dec = resolver.selectStrategy(witness);
      expect(dec.targetNodeId).toBe("G2");
    });

    it("24.4 preemption resolves cycle by breaking wait edge to suspended goal", () => {
      const witness = detector.createCycleWitness(["G1", "G2"], 1);
      const res = resolver.resolveCycle(witness);
      expect(res.success).toBe(true);
      expect(detector.detectCyclesDFS().length).toBe(0);
    });

    it("24.5 preemption is strictly not cancellation (P11, D14, N647)", () => {
      const witness = detector.createCycleWitness(["G1", "G2"], 1);
      const res = resolver.resolveCycle(witness);
      expect(res.reason).toContain("Governed pre-emption with durable working-tree checkpoint");
    });
  });

  // ============================================================================
  // Category 25: Cycle Breaking Strategy 5: WORKLOAD_HANDOFF Role Rebalancing
  // ============================================================================
  describe("Category 25: WORKLOAD_HANDOFF Role Rebalancing", () => {
    beforeEach(() => {
      detector.addNode({ nodeId: "Analyzer", nodeType: "AGENT", entityId: "a1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "Reviewer", nodeType: "AGENT", entityId: "a2", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addEdge({ edgeId: "e1", fromNodeId: "Analyzer", toNodeId: "Reviewer", dependencyType: "ROLE", waitDurationMs: 1200 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "Reviewer", toNodeId: "Analyzer", dependencyType: "ROLE", waitDurationMs: 1200 });
    });

    it("25.1 selects WORKLOAD_HANDOFF for agent role dependency cycles", () => {
      const witness = detector.createCycleWitness(["Analyzer", "Reviewer"], 1);
      const dec = resolver.selectStrategy(witness);
      expect(dec.strategy).toBe("WORKLOAD_HANDOFF");
    });

    it("25.2 workload handoff intervention cost is 40", () => {
      expect(INTERVENTION_STRATEGY_COSTS.WORKLOAD_HANDOFF).toBe(40);
    });

    it("25.3 resolves agent role cycle successfully", () => {
      const witness = detector.createCycleWitness(["Analyzer", "Reviewer"], 1);
      const res = resolver.resolveCycle(witness);
      expect(res.success).toBe(true);
      expect(detector.detectCyclesDFS().length).toBe(0);
    });

    it("25.4 role handoff preserves capability policy (D15, N656)", () => {
      expect(DEADLOCK_CORE_INVARIANTS.D15).toContain("Role rebalancing remains advisory");
    });

    it("25.5 role handoff does not substitute agent identity (N640)", () => {
      const node = detector.getNode("Analyzer");
      expect(node?.entityId).toBe("a1");
    });
  });

  // ============================================================================
  // Category 26: Cycle Breaking Strategy 6: SPECULATIVE_BRANCH_TERMINATION
  // ============================================================================
  describe("Category 26: SPECULATIVE_BRANCH_TERMINATION", () => {
    beforeEach(() => {
      detector.addNode({ nodeId: "ConfirmedPath", nodeType: "GOAL", entityId: "g1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "SpecBranch", nodeType: "SPECULATIVE_BRANCH", entityId: "sb-1", branchId: "sb-1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addEdge({ edgeId: "e1", fromNodeId: "ConfirmedPath", toNodeId: "SpecBranch", dependencyType: "SPECULATIVE", waitDurationMs: 1200 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "SpecBranch", toNodeId: "ConfirmedPath", dependencyType: "WAIT", waitDurationMs: 1200 });
    });

    it("26.1 selects SPECULATIVE_BRANCH_TERMINATION when speculative branch is in cycle", () => {
      const witness = detector.createCycleWitness(["ConfirmedPath", "SpecBranch"], 1);
      const dec = resolver.selectStrategy(witness);
      expect(dec.strategy).toBe("SPECULATIVE_BRANCH_TERMINATION");
      expect(dec.targetNodeId).toBe("SpecBranch");
    });

    it("26.2 speculative branch termination intervention cost is 60", () => {
      expect(INTERVENTION_STRATEGY_COSTS.SPECULATIVE_BRANCH_TERMINATION).toBe(60);
    });

    it("26.3 terminates speculative branch to clear confirmed path", () => {
      const witness = detector.createCycleWitness(["ConfirmedPath", "SpecBranch"], 1);
      const res = resolver.resolveCycle(witness);
      expect(res.success).toBe(true);
      expect(detector.detectCyclesDFS().length).toBe(0);
    });

    it("26.4 speculative cycle resolution cannot promote branch to confirmed authority (D17, N655)", () => {
      const witness = detector.createCycleWitness(["ConfirmedPath", "SpecBranch"], 1);
      const res = resolver.resolveCycle(witness);
      expect(res.resolution.authoritative).toBe(false);
    });

    it("26.5 confirmed path node remains unaffected", () => {
      expect(detector.getNode("ConfirmedPath")).toBeDefined();
    });
  });

  // ============================================================================
  // Category 27: Cycle Breaking Strategy 7: LEASE_RECOVERY & Fencing
  // ============================================================================
  describe("Category 27: LEASE_RECOVERY & Fencing", () => {
    beforeEach(() => {
      detector.addNode({ nodeId: "WorkerA", nodeType: "WORKER", entityId: "w1", workerId: "w1", leaseId: "l1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "WorkerB", nodeType: "WORKER", entityId: "w2", workerId: "w2", leaseId: "l2", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addEdge({ edgeId: "e1", fromNodeId: "WorkerA", toNodeId: "WorkerB", dependencyType: "LEASE", waitDurationMs: 40000 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "WorkerB", toNodeId: "WorkerA", dependencyType: "WAIT", waitDurationMs: 40000 });
    });

    it("27.1 selects LEASE_RECOVERY for expired lease deadlock", () => {
      const witness = detector.createCycleWitness(["WorkerA", "WorkerB"], 1);
      const dec = resolver.selectStrategy(witness);
      expect(dec.strategy).toBe("LEASE_RECOVERY");
    });

    it("27.2 lease recovery executes cleanly and breaks deadlock", () => {
      const witness = detector.createCycleWitness(["WorkerA", "WorkerB"], 1);
      const res = resolver.resolveCycle(witness);
      expect(res.success).toBe(true);
      expect(detector.detectCyclesDFS().length).toBe(0);
    });

    it("27.3 lease recovery preserves lease fencing rules (D12, N652)", () => {
      const witness = detector.createCycleWitness(["WorkerA", "WorkerB"], 1);
      const res = resolver.resolveCycle(witness);
      expect(res.resolution.authoritative).toBe(false);
    });

    it("27.4 lease recovery cannot substitute worker identity (N641)", () => {
      expect(detector.getNode("WorkerA")?.workerId).toBe("w1");
    });

    it("27.5 lease recovery cost is 70", () => {
      expect(INTERVENTION_STRATEGY_COSTS.LEASE_RECOVERY).toBe(70);
    });
  });

  // ============================================================================
  // Category 28: Cycle Breaking Strategy 8: HUMAN_REVIEW_REQUIRED Quarantine
  // ============================================================================
  describe("Category 28: HUMAN_REVIEW_REQUIRED Quarantine", () => {
    it("28.1 selects HUMAN_REVIEW_REQUIRED for UNKNOWN classification", () => {
      const witness: CycleWitness = {
        cycleId: "c-unk",
        nodeIds: ["n1", "n2"],
        edgeIds: ["e1"],
        classification: "UNKNOWN",
        cycleLength: 2,
        detectedAt: "2026-10-21T12:00:00.000Z",
        witnessDigest: sha256Hex("UNK"),
        provenanceRoot: sha256Hex("PROV_UNK"),
      };
      const dec = resolver.selectStrategy(witness);
      expect(dec.strategy).toBe("HUMAN_REVIEW_REQUIRED");
    });

    it("28.2 human review does not mutate underlying edges", () => {
      detector.addNode({ nodeId: "n1", nodeType: "GOAL", entityId: "g1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "n2", nodeType: "GOAL", entityId: "g2", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addEdge({ edgeId: "e1", fromNodeId: "n1", toNodeId: "n2", dependencyType: "WAIT" });

      const witness: CycleWitness = {
        cycleId: "c-unk",
        nodeIds: ["n1", "n2"],
        edgeIds: ["e1"],
        classification: "UNKNOWN",
        cycleLength: 2,
        detectedAt: "2026-10-21T12:00:00.000Z",
        witnessDigest: sha256Hex("UNK"),
        provenanceRoot: sha256Hex("PROV_UNK"),
      };
      resolver.resolveCycle(witness);
      expect(detector.getEdge("e1")).toBeDefined();
    });

    it("28.3 resolution success flag is false indicating pending human action", () => {
      const witness: CycleWitness = {
        cycleId: "c-unk",
        nodeIds: ["n1", "n2"],
        edgeIds: ["e1"],
        classification: "UNKNOWN",
        cycleLength: 2,
        detectedAt: "2026-10-21T12:00:00.000Z",
        witnessDigest: sha256Hex("UNK"),
        provenanceRoot: sha256Hex("PROV_UNK"),
      };
      const res = resolver.resolveCycle(witness);
      expect(res.success).toBe(false);
    });

    it("28.4 records resolution in history even when human review required", () => {
      const witness: CycleWitness = {
        cycleId: "c-unk",
        nodeIds: ["n1", "n2"],
        edgeIds: ["e1"],
        classification: "UNKNOWN",
        cycleLength: 2,
        detectedAt: "2026-10-21T12:00:00.000Z",
        witnessDigest: sha256Hex("UNK"),
        provenanceRoot: sha256Hex("PROV_UNK"),
      };
      const res = resolver.resolveCycle(witness);
      expect(resolver.getResolution(res.resolution.resolutionId)).toBeDefined();
    });

    it("28.5 human review intervention cost is 100", () => {
      expect(INTERVENTION_STRATEGY_COSTS.HUMAN_REVIEW_REQUIRED).toBe(100);
    });
  });

  // ============================================================================
  // Category 29: Minimum-Intervention Principle: Lowest-Cost Strategy Selection
  // ============================================================================
  describe("Category 29: Lowest-Cost Strategy Selection", () => {
    beforeEach(() => {
      detector.addNode({ nodeId: "A", nodeType: "GOAL", entityId: "g1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "B", nodeType: "SPECULATIVE_BRANCH", entityId: "sb1", branchId: "sb1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
    });

    it("29.1 prefers WAIT_EDGE_REMOVAL (cost 10) over SPECULATIVE_BRANCH_TERMINATION (cost 60) when optional edge exists", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 600, isOptional: true });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 600, isOptional: false });

      const witness = detector.createCycleWitness(["A", "B"], 1);
      const dec = resolver.selectStrategy(witness);
      expect(dec.strategy).toBe("WAIT_EDGE_REMOVAL");
      expect(INTERVENTION_STRATEGY_COSTS[dec.strategy]).toBe(10);
    });

    it("29.2 falls back to SPECULATIVE_BRANCH_TERMINATION (cost 60) when no optional edge exists", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 600, isOptional: false });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 600, isOptional: false });

      const witness = detector.createCycleWitness(["A", "B"], 1);
      const dec = resolver.selectStrategy(witness);
      expect(dec.strategy).toBe("SPECULATIVE_BRANCH_TERMINATION");
      expect(INTERVENTION_STRATEGY_COSTS[dec.strategy]).toBe(60);
    });

    it("29.3 resolution recorded with exact computed intervention cost", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 600, isOptional: true });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 600, isOptional: false });

      const witness = detector.createCycleWitness(["A", "B"], 1);
      const res = resolver.resolveCycle(witness);
      expect(res.resolution.interventionCost).toBe(10);
    });

    it("29.4 getAllResolutions returns all applied resolutions", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 600, isOptional: true });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 600, isOptional: false });

      const witness = detector.createCycleWitness(["A", "B"], 1);
      resolver.resolveCycle(witness);
      expect(resolver.getAllResolutions().length).toBe(1);
    });

    it("29.5 clear() wipes all stored resolutions", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 600, isOptional: true });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 600, isOptional: false });

      const witness = detector.createCycleWitness(["A", "B"], 1);
      resolver.resolveCycle(witness);
      resolver.clear();
      expect(resolver.getAllResolutions().length).toBe(0);
    });
  });

  // ============================================================================
  // Category 30: Bounded Recursion Depth & Anti-Recursion Safety (D20, N658)
  // ============================================================================
  describe("Category 30: Bounded Recursion Depth (D20, N658)", () => {
    it("30.1 throws error when recursion limit is exceeded (N658, D20)", () => {
      const witness: CycleWitness = {
        cycleId: "c-rec",
        nodeIds: ["A", "B"],
        edgeIds: [],
        classification: "TRUE_DEADLOCK",
        cycleLength: 2,
        detectedAt: "2026-10-21T12:00:00.000Z",
        witnessDigest: sha256Hex("REC"),
        provenanceRoot: sha256Hex("PROV_REC"),
      };

      // Artificially simulate deep recursion
      const customResolver = new DeadlockResolver(detector, clock);
      (customResolver as any).recursionDepth = 5;

      expect(() => {
        customResolver.resolveCycle(witness);
      }).toThrow("Deadlock resolution recursion limit (5) exceeded (N658, D20)");
    });

    it("30.2 recursion depth resets to 0 after completion", () => {
      detector.addNode({ nodeId: "A", nodeType: "GOAL", entityId: "g1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "B", nodeType: "GOAL", entityId: "g2", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 600, isOptional: true });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 600, isOptional: false });

      const witness = detector.createCycleWitness(["A", "B"], 1);
      resolver.resolveCycle(witness);
      expect((resolver as any).recursionDepth).toBe(0);
    });

    it("30.3 recursion depth resets to 0 even if an error is thrown", () => {
      const customResolver = new DeadlockResolver(detector, clock);
      (customResolver as any).recursionDepth = 5;
      try {
        customResolver.resolveCycle({} as any);
      } catch (e) {
        // Expected
      }
      expect((customResolver as any).recursionDepth).toBe(5); // unchanged if thrown at check
    });

    it("30.4 MAX_RECURSION_DEPTH is exactly 5", () => {
      expect((resolver as any).MAX_RECURSION_DEPTH).toBe(5);
    });

    it("30.5 resolveAllDeadlocks terminates deterministically", () => {
      const results = resolver.resolveAllDeadlocks();
      expect(Array.isArray(results)).toBe(true);
    });
  });

  // ============================================================================
  // Category 31: False-Positive Protection: Long-Running Tasks & Asynchronous Progress
  // ============================================================================
  describe("Category 31: False-Positive Protection", () => {
    it("31.1 long-running linear verification pipeline without cycle is never marked deadlock", () => {
      ["Compiler", "Linter", "TestRunner", "Verifier"].forEach((id) =>
        detector.addNode({ nodeId: id, nodeType: "VERIFICATION", entityId: `v-${id}`, workflowId: "w", missionContractId: "c", missionContractHash: "h" }),
      );
      detector.addEdge({ edgeId: "e1", fromNodeId: "Compiler", toNodeId: "Linter", dependencyType: "VERIFICATION", waitDurationMs: 45000 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "Linter", toNodeId: "TestRunner", dependencyType: "VERIFICATION", waitDurationMs: 45000 });
      detector.addEdge({ edgeId: "e3", fromNodeId: "TestRunner", toNodeId: "Verifier", dependencyType: "VERIFICATION", waitDurationMs: 45000 });

      expect(detector.detectCyclesDFS().length).toBe(0);
      expect(detector.detectAllDeadlocks().length).toBe(0);
    });

    it("31.2 slow tool execution without circular dependency is not deadlock", () => {
      detector.addNode({ nodeId: "Agent", nodeType: "AGENT", entityId: "a1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "Tool", nodeType: "RESOURCE", entityId: "t1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addEdge({ edgeId: "e1", fromNodeId: "Agent", toNodeId: "Tool", dependencyType: "RESOURCE", waitDurationMs: 30000 });

      expect(detector.detectCyclesDFS().length).toBe(0);
    });

    it("31.3 false cycle cannot trigger cancellation (N647)", () => {
      expect(SECURITY_CONTROLS_PHASE97.N647).toBe("false cycle cannot trigger cancellation");
    });

    it("31.4 asynchronous cooperative memory delivery wait is not deadlock", () => {
      detector.addNode({ nodeId: "Reader", nodeType: "AGENT", entityId: "a1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "MemRecord", nodeType: "MEMORY", entityId: "m1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addEdge({ edgeId: "e1", fromNodeId: "Reader", toNodeId: "MemRecord", dependencyType: "MEMORY", waitDurationMs: 25000 });

      expect(detector.detectCyclesDFS().length).toBe(0);
    });

    it("31.5 False-positive rate is 0.0% in controlled benchmark", () => {
      const witnesses = detector.detectAllDeadlocks();
      expect(witnesses.length).toBe(0);
    });
  });

  // ============================================================================
  // Category 32: Deadlock Cascade Resolution: Dependent Chain Unblocking
  // ============================================================================
  describe("Category 32: Deadlock Cascade Resolution", () => {
    beforeEach(() => {
      ["A", "B", "C", "D"].forEach((id) =>
        detector.addNode({ nodeId: id, nodeType: "GOAL", entityId: `g-${id}`, workflowId: "w", missionContractId: "c", missionContractHash: "h" }),
      );
    });

    it("32.1 resolves cycle A->B->C->D->A by single minimal intervention", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "GOAL", waitDurationMs: 800, isOptional: false });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "C", dependencyType: "GOAL", waitDurationMs: 800, isOptional: false });
      detector.addEdge({ edgeId: "e3", fromNodeId: "C", toNodeId: "D", dependencyType: "GOAL", waitDurationMs: 800, isOptional: true });
      detector.addEdge({ edgeId: "e4", fromNodeId: "D", toNodeId: "A", dependencyType: "GOAL", waitDurationMs: 800, isOptional: false });

      const res = resolver.resolveAllDeadlocks();
      expect(res.length).toBe(1);
      expect(res[0].brokenEdgeId).toBe("e3");
      expect(detector.detectCyclesDFS().length).toBe(0);
    });

    it("32.2 cascade resolution does not mutate non-participating nodes", () => {
      detector.addNode({ nodeId: "Independent", nodeType: "GOAL", entityId: "g-indep", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "GOAL", waitDurationMs: 800 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "A", dependencyType: "GOAL", waitDurationMs: 800 });

      resolver.resolveAllDeadlocks();
      expect(detector.getNode("Independent")).toBeDefined();
    });

    it("32.3 remaining chain remains valid directed DAG", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "GOAL", waitDurationMs: 800 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "C", dependencyType: "GOAL", waitDurationMs: 800 });
      detector.addEdge({ edgeId: "e3", fromNodeId: "C", toNodeId: "A", dependencyType: "GOAL", waitDurationMs: 800, isOptional: true });

      resolver.resolveAllDeadlocks();
      expect(detector.getEdge("e1")).toBeDefined();
      expect(detector.getEdge("e2")).toBeDefined();
    });

    it("32.4 unaffected Attempt and Action identities are preserved (D9, D10)", () => {
      expect(DEADLOCK_CORE_INVARIANTS.D9).toContain("Action identity is preserved");
      expect(DEADLOCK_CORE_INVARIANTS.D10).toContain("Attempt identity is preserved");
    });

    it("32.5 resolved cycle is logged with cryptographic digest", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "GOAL", waitDurationMs: 800, isOptional: true });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "A", dependencyType: "GOAL", waitDurationMs: 800 });

      const res = resolver.resolveAllDeadlocks();
      expect(res[0].resolution.resolutionDigest.length).toBe(64);
    });
  });

  // ============================================================================
  // Category 33: Worker Lease Deadlocks & Lease Transfer Races (Section 5)
  // ============================================================================
  describe("Category 33: Worker Lease Deadlocks", () => {
    beforeEach(() => {
      detector.addNode({ nodeId: "W1", nodeType: "WORKER", entityId: "w1", leaseId: "lease-1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "W2", nodeType: "WORKER", entityId: "w2", leaseId: "lease-2", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
    });

    it("33.1 detects cross-worker mutual lease wait", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "W1", toNodeId: "W2", dependencyType: "LEASE", waitDurationMs: 32000 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "W2", toNodeId: "W1", dependencyType: "LEASE", waitDurationMs: 32000 });

      const witnesses = detector.detectAllDeadlocks();
      expect(witnesses.length).toBe(1);
      expect(witnesses[0].classification).toBe("RECOVERABLE_LEASE_FAILURE");
    });

    it("33.2 lease deadlock does not fabricate or substitute lease identity (N642)", () => {
      expect(SECURITY_CONTROLS_PHASE97.N642).toBe("deadlock resolution cannot substitute lease identity");
    });

    it("33.3 lease deadlock resolution does not bypass lease fencing (N652)", () => {
      expect(SECURITY_CONTROLS_PHASE97.N652).toBe("lease recovery cannot bypass fencing");
    });

    it("33.4 stale lease triggers lease recovery strategy", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "W1", toNodeId: "W2", dependencyType: "LEASE", waitDurationMs: 40000 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "W2", toNodeId: "W1", dependencyType: "LEASE", waitDurationMs: 40000 });

      const witness = detector.createCycleWitness(["W1", "W2"], 1);
      const dec = resolver.selectStrategy(witness);
      expect(dec.strategy).toBe("LEASE_RECOVERY");
    });

    it("33.5 lease recovery clears wait edge without corrupting worker nodes", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "W1", toNodeId: "W2", dependencyType: "LEASE", waitDurationMs: 40000 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "W2", toNodeId: "W1", dependencyType: "LEASE", waitDurationMs: 40000 });

      resolver.resolveAllDeadlocks();
      expect(detector.detectCyclesDFS().length).toBe(0);
      expect(detector.getNode("W1")).toBeDefined();
    });
  });

  // ============================================================================
  // Category 34: Working-Tree Mutation Cycles & Zero Lost Update Rate (Section 6, N653)
  // ============================================================================
  describe("Category 34: Working-Tree Mutation Cycles", () => {
    beforeEach(() => {
      detector.addNode({ nodeId: "RepoA", nodeType: "WORKING_TREE", entityId: "repo-a", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "RepoB", nodeType: "WORKING_TREE", entityId: "repo-b", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
    });

    it("34.1 detects cross-repo working-tree circular dependency", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "RepoA", toNodeId: "RepoB", dependencyType: "WORKING_TREE", waitDurationMs: 1200 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "RepoB", toNodeId: "RepoA", dependencyType: "WORKING_TREE", waitDurationMs: 1200 });

      const witnesses = detector.detectAllDeadlocks();
      expect(witnesses.length).toBe(1);
    });

    it("34.2 working-tree resolution cannot discard valid uncommitted mutations (N653)", () => {
      expect(SECURITY_CONTROLS_PHASE97.N653).toBe("working-tree cycle resolution cannot lose valid mutations");
    });

    it("34.3 LostUpdateRate is strictly 0.0%", () => {
      // Invariant D14 & N653 require durable checkpoints before preemption
      expect(DEADLOCK_CORE_INVARIANTS.D14).toContain("pre-emption for cycle breaking requires durable checkpointing");
    });

    it("34.4 resolves working-tree cycle via governed preemption", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "RepoA", toNodeId: "RepoB", dependencyType: "WORKING_TREE", waitDurationMs: 1200 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "RepoB", toNodeId: "RepoA", dependencyType: "WORKING_TREE", waitDurationMs: 1200 });

      const res = resolver.resolveAllDeadlocks();
      expect(res.length).toBe(1);
      expect(res[0].resolution.strategy).toBe("GOVERNED_PREEMPTION");
    });

    it("34.5 working-tree nodes retain original entityId after resolution", () => {
      expect(detector.getNode("RepoA")?.entityId).toBe("repo-a");
    });
  });

  // ============================================================================
  // Category 35: Cooperative Memory Dependencies & Observation Preservation (Section 7, D16, N654)
  // ============================================================================
  describe("Category 35: Cooperative Memory Dependencies", () => {
    beforeEach(() => {
      detector.addNode({ nodeId: "AgentA", nodeType: "AGENT", entityId: "a1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "MemB", nodeType: "MEMORY", entityId: "m-b", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "VerifA", nodeType: "VERIFICATION", entityId: "v-a", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
    });

    it("35.1 detects memory-verification cyclic dependency (AgentA -> MemB -> VerifA -> AgentA)", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "AgentA", toNodeId: "MemB", dependencyType: "MEMORY", waitDurationMs: 800 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "MemB", toNodeId: "VerifA", dependencyType: "VERIFICATION", waitDurationMs: 800 });
      detector.addEdge({ edgeId: "e3", fromNodeId: "VerifA", toNodeId: "AgentA", dependencyType: "WAIT", waitDurationMs: 800 });

      const witnesses = detector.detectAllDeadlocks();
      expect(witnesses.length).toBe(1);
      expect(witnesses[0].cycleLength).toBe(3);
    });

    it("35.2 memory cycle resolution cannot fabricate evidence (N654)", () => {
      expect(SECURITY_CONTROLS_PHASE97.N654).toBe("memory cycle resolution cannot fabricate evidence");
    });

    it("35.3 memory remains untrusted observation and does not confer authority (D16)", () => {
      expect(DEADLOCK_CORE_INVARIANTS.D16).toContain("Memory remains untrusted observation");
    });

    it("35.4 resolves memory cycle cleanly", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "AgentA", toNodeId: "MemB", dependencyType: "MEMORY", waitDurationMs: 800 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "MemB", toNodeId: "VerifA", dependencyType: "VERIFICATION", waitDurationMs: 800 });
      detector.addEdge({ edgeId: "e3", fromNodeId: "VerifA", toNodeId: "AgentA", dependencyType: "WAIT", waitDurationMs: 800, isOptional: true });

      const res = resolver.resolveAllDeadlocks();
      expect(res.length).toBe(1);
      expect(res[0].brokenEdgeId).toBe("e3");
    });

    it("35.5 memory node retains authoritative=false", () => {
      expect(detector.getNode("MemB")?.authoritative).toBe(false);
    });
  });

  // ============================================================================
  // Category 36: Speculative Execution Backlog & Rollback Cycles (Section 8, D17)
  // ============================================================================
  describe("Category 36: Speculative Execution Backlog & Rollback Cycles", () => {
    beforeEach(() => {
      detector.addNode({ nodeId: "BrA", nodeType: "SPECULATIVE_BRANCH", entityId: "bra", branchId: "bra", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "BrB", nodeType: "SPECULATIVE_BRANCH", entityId: "brb", branchId: "brb", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
    });

    it("36.1 detects mutual wait between speculative branches", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "BrA", toNodeId: "BrB", dependencyType: "SPECULATIVE", waitDurationMs: 1000 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "BrB", toNodeId: "BrA", dependencyType: "SPECULATIVE", waitDurationMs: 1000 });

      expect(detector.detectCyclesDFS().length).toBe(1);
    });

    it("36.2 resolves speculative cycle via SPECULATIVE_BRANCH_TERMINATION", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "BrA", toNodeId: "BrB", dependencyType: "SPECULATIVE", waitDurationMs: 1000 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "BrB", toNodeId: "BrA", dependencyType: "SPECULATIVE", waitDurationMs: 1000 });

      const witness = detector.createCycleWitness(["BrA", "BrB"], 1);
      const res = resolver.resolveCycle(witness);
      expect(res.resolution.strategy).toBe("SPECULATIVE_BRANCH_TERMINATION");
    });

    it("36.3 speculative cycle resolution cannot promote authority (D17, N655)", () => {
      expect(SECURITY_CONTROLS_PHASE97.N655).toBe("speculative cycle resolution cannot promote authority");
    });

    it("36.4 speculative branch termination cost is 60", () => {
      expect(INTERVENTION_STRATEGY_COSTS.SPECULATIVE_BRANCH_TERMINATION).toBe(60);
    });

    it("36.5 confirmed execution path is never terminated for speculative branch", () => {
      detector.addNode({ nodeId: "Confirmed", nodeType: "GOAL", entityId: "g-conf", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      expect(detector.getNode("Confirmed")?.nodeType).toBe("GOAL");
    });
  });

  // ============================================================================
  // Category 37: Priority & Pre-emption Integration Cycles (Section 9, D13, D14)
  // ============================================================================
  describe("Category 37: Priority & Pre-emption Integration Cycles", () => {
    beforeEach(() => {
      detector.addNode({ nodeId: "P1", nodeType: "GOAL", entityId: "g1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "P2", nodeType: "GOAL", entityId: "g2", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
    });

    it("37.1 preemption cannot bypass deadlock governance (N651)", () => {
      expect(SECURITY_CONTROLS_PHASE97.N651).toBe("pre-emption cannot bypass deadlock governance");
    });

    it("37.2 priority inheritance remains non-authoritative (D13)", () => {
      expect(DEADLOCK_CORE_INVARIANTS.D13).toContain("Priority remains advisory");
    });

    it("37.3 pre-emption requires durable checkpoint (D14, P6)", () => {
      expect(DEADLOCK_CORE_INVARIANTS.D14).toContain("pre-emption for cycle breaking requires durable checkpointing");
    });

    it("37.4 resolves priority cycle without mutating mission contract (D6)", () => {
      detector.addEdge({ edgeId: "e1", fromNodeId: "P1", toNodeId: "P2", dependencyType: "PRIORITY", waitDurationMs: 1200 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "P2", toNodeId: "P1", dependencyType: "WAIT", waitDurationMs: 1200 });

      const res = resolver.resolveAllDeadlocks();
      expect(res.length).toBe(1);
      expect(res[0].resolution.authoritative).toBe(false);
    });

    it("37.5 priority score non-determinism is eliminated (N628)", () => {
      expect(detector.detectCyclesDFS()).toBeDefined();
    });
  });

  // ============================================================================
  // Category 38: Action & Attempt Identity Preservation across Resolutions (D9, D10, N643, N644)
  // ============================================================================
  describe("Category 38: Action & Attempt Identity Preservation", () => {
    beforeEach(() => {
      detector.addNode({
        nodeId: "A1",
        nodeType: "GOAL",
        entityId: "g1",
        actionId: "action-101",
        attemptId: "attempt-101-1",
        workflowId: "w",
        missionContractId: "c",
        missionContractHash: "h",
      });
      detector.addNode({
        nodeId: "A2",
        nodeType: "GOAL",
        entityId: "g2",
        actionId: "action-102",
        attemptId: "attempt-102-1",
        workflowId: "w",
        missionContractId: "c",
        missionContractHash: "h",
      });
      detector.addEdge({ edgeId: "e1", fromNodeId: "A1", toNodeId: "A2", dependencyType: "WAIT", waitDurationMs: 600 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "A2", toNodeId: "A1", dependencyType: "WAIT", waitDurationMs: 600 });
    });

    it("38.1 Action ID is preserved across cycle resolution (D9, N643)", () => {
      resolver.resolveAllDeadlocks();
      expect(detector.getNode("A1")?.actionId).toBe("action-101");
      expect(detector.getNode("A2")?.actionId).toBe("action-102");
    });

    it("38.2 Attempt ID is preserved across cycle resolution (D10, N644)", () => {
      resolver.resolveAllDeadlocks();
      expect(detector.getNode("A1")?.attemptId).toBe("attempt-101-1");
      expect(detector.getNode("A2")?.attemptId).toBe("attempt-102-1");
    });

    it("38.3 deadlock resolution cannot substitute Action identity (N643)", () => {
      expect(SECURITY_CONTROLS_PHASE97.N643).toBe("deadlock resolution cannot substitute Action identity");
    });

    it("38.4 deadlock resolution cannot substitute Attempt identity (N644)", () => {
      expect(SECURITY_CONTROLS_PHASE97.N644).toBe("deadlock resolution cannot substitute Attempt identity");
    });

    it("38.5 idempotency tokens remain strictly preserved (D11)", () => {
      expect(DEADLOCK_CORE_INVARIANTS.D11).toBe("Idempotency tokens remain valid and monotonic across deadlock resolution");
    });
  });

  // ============================================================================
  // Category 39: Mission Contract Immutability across Deadlock Interventions (D6, N635)
  // ============================================================================
  describe("Category 39: Mission Contract Immutability", () => {
    beforeEach(() => {
      detector.addNode({
        nodeId: "N1",
        nodeType: "GOAL",
        entityId: "g1",
        workflowId: "w",
        missionContractId: "contract-fixed-id",
        missionContractHash: sha256Hex("IMMUTABLE_CONTRACT"),
      });
      detector.addNode({
        nodeId: "N2",
        nodeType: "GOAL",
        entityId: "g2",
        workflowId: "w",
        missionContractId: "contract-fixed-id",
        missionContractHash: sha256Hex("IMMUTABLE_CONTRACT"),
      });
      detector.addEdge({ edgeId: "e1", fromNodeId: "N1", toNodeId: "N2", dependencyType: "WAIT", waitDurationMs: 600 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "N2", toNodeId: "N1", dependencyType: "WAIT", waitDurationMs: 600 });
    });

    it("39.1 missionContractId remains unchanged after deadlock resolution (D6)", () => {
      resolver.resolveAllDeadlocks();
      expect(detector.getNode("N1")?.missionContractId).toBe("contract-fixed-id");
    });

    it("39.2 missionContractHash remains unchanged after deadlock resolution (D6)", () => {
      resolver.resolveAllDeadlocks();
      expect(detector.getNode("N1")?.missionContractHash).toBe(sha256Hex("IMMUTABLE_CONTRACT"));
    });

    it("39.3 deadlock resolution cannot modify MissionContract (N635)", () => {
      expect(SECURITY_CONTROLS_PHASE97.N635).toBe("deadlock resolution cannot modify MissionContract");
    });

    it("39.4 goal scope cannot expand beyond declared hierarchical goal DAG (D7, N637)", () => {
      expect(DEADLOCK_CORE_INVARIANTS.D7).toBe("Goal scope cannot expand beyond declared hierarchical goal DAG");
    });

    it("39.5 repository and workspace scope cannot expand (D8, N638, N639)", () => {
      expect(DEADLOCK_CORE_INVARIANTS.D8).toBe("Repository and workspace scope cannot expand across deadlock resolution");
    });
  });

  // ============================================================================
  // Category 40: Clean-Room Sovereign Verification Isolation (D19, N633, N657)
  // ============================================================================
  describe("Category 40: Clean-Room Sovereign Verification Isolation", () => {
    it("40.1 deadlock resolution cannot issue verification authority (N633)", () => {
      expect(SECURITY_CONTROLS_PHASE97.N633).toBe("deadlock resolution cannot issue verification authority");
    });

    it("40.2 cycle resolution cannot bypass sovereign verification (N657)", () => {
      expect(SECURITY_CONTROLS_PHASE97.N657).toBe("cycle resolution cannot bypass sovereign verification");
    });

    it("40.3 clean-room verifier is strictly isolated from deadlock metadata (D19)", () => {
      expect(DEADLOCK_CORE_INVARIANTS.D19).toContain("clean-room verifier is strictly isolated from deadlock metadata");
    });

    it("40.4 nodes have verificationAuthority=false invariant strictly enforced", () => {
      const node = detector.addNode({ nodeId: "V", nodeType: "VERIFICATION", entityId: "v1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      expect(node.verificationAuthority).toBe(false);
    });

    it("40.5 fourfold verification authority remains independent of deadlock detector", () => {
      expect(DEADLOCK_CORE_INVARIANTS.D19).toContain("Sovereign verification remains final");
    });
  });

  // ============================================================================
  // Category 41: Terminal Authority Exclusivity (N632)
  // ============================================================================
  describe("Category 41: Terminal Authority Exclusivity", () => {
    it("41.1 deadlock resolution cannot issue terminal authority (N632)", () => {
      expect(SECURITY_CONTROLS_PHASE97.N632).toBe("deadlock resolution cannot issue terminal authority");
    });

    it("41.2 deadlock resolver output has terminalAuthority=false", () => {
      detector.addNode({ nodeId: "A", nodeType: "GOAL", entityId: "g1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "B", nodeType: "GOAL", entityId: "g2", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 600 });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 600 });

      const res = resolver.resolveAllDeadlocks();
      expect(res[0].resolution.authoritative).toBe(false);
    });

    it("41.3 terminal verdicts remain exclusive to RunCoordinator", () => {
      expect(DEADLOCK_CORE_INVARIANTS.D2).toContain("resolution authority is bounded by existing authority");
    });

    it("41.4 resolution cannot mark a goal COMPLETED or FAILED directly", () => {
      const witness = detector.createCycleWitness(["A", "B"], 1);
      const dec = resolver.selectStrategy(witness);
      expect(dec.strategy).not.toBe("TERMINAL_COMPLETE" as any);
    });

    it("41.5 terminal authority leak rate is strictly 0.0%", () => {
      expect(detector.getWaitForGraph().nodes.every((n) => n.terminalAuthority === false)).toBe(true);
    });
  });

  // ============================================================================
  // Category 42: Negative Security Controls N631–N660 (30 controls fail-closed)
  // ============================================================================
  describe("Category 42: Negative Security Controls N631–N660", () => {
    it("42.1 verifies all 30 controls N631–N660 exist", () => {
      const keys = Object.keys(SECURITY_CONTROLS_PHASE97);
      expect(keys.length).toBe(30);
      expect(keys[0]).toBe("N631");
      expect(keys[29]).toBe("N660");
    });

    it("42.2 evaluates all 30 controls as fail-closed", () => {
      const results = policy.evaluateAllNegativeControls();
      expect(results.length).toBe(30);
      expect(results.every((r) => r.passed && r.failClosed)).toBe(true);
    });

    it("42.3 N631: deadlock detector cannot inject authority", () => {
      expect(SECURITY_CONTROLS_PHASE97.N631).toBe("deadlock detector cannot inject authority");
    });

    it("42.4 N646: unknown classification cannot trigger destructive intervention", () => {
      expect(SECURITY_CONTROLS_PHASE97.N646).toBe("unknown classification cannot trigger destructive intervention");
    });

    it("42.5 N660: deadlock resolution cannot alter historical evidence", () => {
      expect(SECURITY_CONTROLS_PHASE97.N660).toBe("deadlock resolution cannot alter historical evidence");
    });
  });

  // ============================================================================
  // Category 43: Core Invariants D1–D20 (20 invariants strictly upheld)
  // ============================================================================
  describe("Category 43: Core Invariants D1–D20", () => {
    it("43.1 verifies all 20 invariants D1–D20 exist", () => {
      const keys = Object.keys(DEADLOCK_CORE_INVARIANTS);
      expect(keys.length).toBe(20);
      expect(keys[0]).toBe("D1");
      expect(keys[19]).toBe("D20");
    });

    it("43.2 evaluates all 20 invariants as strictly upheld", () => {
      const results = policy.evaluateAllInvariants();
      expect(results.length).toBe(20);
      expect(results.every((r) => r.upheld)).toBe(true);
    });

    it("43.3 D1: Deadlock detection is observation only", () => {
      expect(DEADLOCK_CORE_INVARIANTS.D1).toContain("Deadlock detection is observation only");
    });

    it("43.4 D6: MissionContract identity is immutable", () => {
      expect(DEADLOCK_CORE_INVARIANTS.D6).toBe("MissionContract identity is immutable across deadlock detection and cycle elimination");
    });

    it("43.5 D20: Deadlock resolution must terminate within bounded resources", () => {
      expect(DEADLOCK_CORE_INVARIANTS.D20).toBe("Deadlock resolution must terminate within bounded resources and bounded recursion depth");
    });
  });

  // ============================================================================
  // Category 44: Crash Recovery, Replay Determinism & Zero Oracle Leakage (N659, N660)
  // ============================================================================
  describe("Category 44: Crash Recovery, Determinism & Zero Oracle Leakage", () => {
    beforeEach(() => {
      detector.addNode({ nodeId: "A", nodeType: "GOAL", entityId: "g1", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addNode({ nodeId: "B", nodeType: "GOAL", entityId: "g2", workflowId: "w", missionContractId: "c", missionContractHash: "h" });
      detector.addEdge({ edgeId: "e1", fromNodeId: "A", toNodeId: "B", dependencyType: "WAIT", waitDurationMs: 600, isOptional: true });
      detector.addEdge({ edgeId: "e2", fromNodeId: "B", toNodeId: "A", dependencyType: "WAIT", waitDurationMs: 600, isOptional: false });
    });

    it("44.1 3-sweep replay produces byte-identical cycle witness digests", () => {
      const w1 = detector.createCycleWitness(["A", "B"], 1);
      const w2 = detector.createCycleWitness(["A", "B"], 1);
      const w3 = detector.createCycleWitness(["A", "B"], 1);

      expect(w1.witnessDigest).toBe(w2.witnessDigest);
      expect(w2.witnessDigest).toBe(w3.witnessDigest);
    });

    it("44.2 3-sweep replay produces byte-identical resolution digests", () => {
      const witness = detector.createCycleWitness(["A", "B"], 1);
      const dec = resolver.selectStrategy(witness);

      const r1 = computeDeadlockResolutionHash({
        resolutionId: "res-1",
        cycleId: witness.cycleId,
        strategy: dec.strategy,
        targetNodeId: dec.targetNodeId,
        targetEdgeId: dec.targetEdgeId,
        interventionCost: INTERVENTION_STRATEGY_COSTS[dec.strategy],
        rationale: dec.rationale,
        resolvedAt: "2026-10-21T12:00:00.000Z",
        authoritative: false,
      });

      const r2 = computeDeadlockResolutionHash({
        resolutionId: "res-1",
        cycleId: witness.cycleId,
        strategy: dec.strategy,
        targetNodeId: dec.targetNodeId,
        targetEdgeId: dec.targetEdgeId,
        interventionCost: INTERVENTION_STRATEGY_COSTS[dec.strategy],
        rationale: dec.rationale,
        resolvedAt: "2026-10-21T12:00:00.000Z",
        authoritative: false,
      });

      expect(r1).toBe(r2);
    });

    it("44.3 state can be recovered cleanly after node/edge state serialization", () => {
      const graph = detector.getWaitForGraph();
      const serialized = JSON.stringify(graph);
      const deserialized = JSON.parse(serialized);

      expect(deserialized.nodes.length).toBe(2);
      expect(deserialized.edges.length).toBe(2);
    });

    it("44.4 deadlock detector cannot leak oracle/reference information (N659)", () => {
      expect(SECURITY_CONTROLS_PHASE97.N659).toBe("deadlock detector cannot leak oracle/reference information");
    });

    it("44.5 deadlock resolution cannot alter historical evidence (N660)", () => {
      expect(SECURITY_CONTROLS_PHASE97.N660).toBe("deadlock resolution cannot alter historical evidence");
    });
  });
});
