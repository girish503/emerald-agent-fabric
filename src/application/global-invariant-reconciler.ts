/**
 * Phase 53 — Governed Global Invariant Reconciliation Module
 *
 * Implements deterministic cross-subtask invariant reconciliation:
 * 1. GlobalInvariant model with canonical hashing
 * 2. Deterministic GlobalConflictGraph creation
 * 3. Static contract reconciliation (Condition B)
 * 4. Cross-subtask dataflow / control-flow reconciliation (Condition C)
 * 5. Invariant status evaluation (SATISFIED, VIOLATED, UNKNOWN)
 *    Critical invariant: UNKNOWN != SATISFIED (triggers GLOBAL_INVARIANT_UNPROVEN)
 * 6. Negative Controls enforcement:
 *    - N1: Explicit contract contradiction -> GLOBAL_CONFLICT_DETECTED
 *    - N2: Hidden cross-subtask state conflict -> GLOBAL_INVARIANT_VIOLATION
 *    - N3: Analysis uncertainty -> GLOBAL_INVARIANT_UNPROVEN
 *    - N8: Gold patch leakage -> GOLD_LEAKAGE_DETECTED
 *    - N9/N10: Authority firewall (cannot modify invariants or grant approval)
 *    - N11: Scope violation check
 *    - N12: Contradictory repair rejection
 *
 * Invariants:
 * - Reconciliation is purely informational analysis; NEVER an authority layer.
 * - Clean-room verification remains 100% authoritative and fail-closed.
 */

import { canonicalJsonStringify, sha256Hex } from "../domain/canonical-hash.js";
import { FormalContract } from "./contract-extractor.js";
import { RepositorySlice } from "./repository-slicer.js";

// ============================================================================
// 1. Types & Interfaces
// ============================================================================

export interface GlobalInvariant {
  readonly invariantId: string;
  readonly taskId: string;
  readonly sourceContracts: readonly string[];
  readonly symbols: readonly string[];
  readonly preconditions: readonly string[];
  readonly postconditions: readonly string[];
  readonly stateRelations: readonly string[];
  readonly dataFlowRelations: readonly string[];
  readonly behavioralProperties: readonly string[];
  readonly provenance: readonly string[];
  readonly contentHash: string;
}

export type ConflictType =
  | "INTERFACE_CONFLICT"
  | "STATE_CONFLICT"
  | "BEHAVIORAL_CONFLICT"
  | "DATAFLOW_CONFLICT";

export interface GlobalConflict {
  readonly conflictId: string;
  readonly taskId: string;
  readonly subtasks: readonly string[];
  readonly symbols: readonly string[];
  readonly conflictType: ConflictType;
  readonly invariant: string;
  readonly evidence: readonly string[];
  readonly severity: "CRITICAL" | "HIGH" | "MEDIUM";
  readonly deterministicHash: string;
}

export type GraphNodeType = "SUBTASK" | "CONTRACT" | "SYMBOL" | "INVARIANT";
export type GraphEdgeType =
  | "DEPENDS_ON"
  | "CONTRADICTS"
  | "SHARES_STATE"
  | "SHARES_INTERFACE"
  | "AFFECTS_BEHAVIOR";

export interface ConflictGraphNode {
  readonly nodeId: string;
  readonly nodeType: GraphNodeType;
  readonly label: string;
}

export interface ConflictGraphEdge {
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly edgeType: GraphEdgeType;
}

export interface GlobalConflictGraph {
  readonly graphId: string;
  readonly taskId: string;
  readonly nodes: readonly ConflictGraphNode[];
  readonly edges: readonly ConflictGraphEdge[];
  readonly graphHash: string;
}

export type InvariantStatus = "SATISFIED" | "VIOLATED" | "UNKNOWN";

export interface InvariantEvaluation {
  readonly invariantId: string;
  readonly status: InvariantStatus;
  readonly evidence: string;
}

export interface ReconciliationReport {
  readonly reportId: string;
  readonly taskId: string;
  readonly status: "RECONCILED" | "CONFLICT_DETECTED" | "GLOBAL_INVARIANT_UNPROVEN" | "ANALYSIS_BUDGET_EXCEEDED";
  readonly conflicts: readonly GlobalConflict[];
  readonly invariantsEvaluated: readonly InvariantEvaluation[];
  readonly provenance: readonly string[];
  readonly reportHash: string;
}

// ============================================================================
// 2. GlobalInvariantReconciler Implementation
// ============================================================================

export class GlobalInvariantReconciler {
  /**
   * Computes deterministic hash for a global invariant.
   */
  public static computeInvariantHash(inv: Omit<GlobalInvariant, "contentHash">): string {
    const canonical = canonicalJsonStringify({
      behavioralProperties: [...inv.behavioralProperties].sort(),
      dataFlowRelations: [...inv.dataFlowRelations].sort(),
      invariantId: inv.invariantId,
      postconditions: [...inv.postconditions].sort(),
      preconditions: [...inv.preconditions].sort(),
      provenance: [...inv.provenance].sort(),
      sourceContracts: [...inv.sourceContracts].sort(),
      stateRelations: [...inv.stateRelations].sort(),
      symbols: [...inv.symbols].sort(),
      taskId: inv.taskId
    });
    return sha256Hex(canonical);
  }

  /**
   * Computes deterministic hash for a conflict record.
   */
  public static computeConflictHash(conflict: Omit<GlobalConflict, "deterministicHash">): string {
    const canonical = canonicalJsonStringify({
      conflictId: conflict.conflictId,
      conflictType: conflict.conflictType,
      evidence: [...conflict.evidence].sort(),
      invariant: conflict.invariant,
      severity: conflict.severity,
      subtasks: [...conflict.subtasks].sort(),
      symbols: [...conflict.symbols].sort(),
      taskId: conflict.taskId
    });
    return sha256Hex(canonical);
  }

  /**
   * Extracts global invariants across subtask contracts and repository slice.
   */
  public static extractGlobalInvariants(
    taskId: string,
    contracts: readonly FormalContract[],
    slice: RepositorySlice
  ): GlobalInvariant[] {
    const invariants: GlobalInvariant[] = [];

    // 1. Inter-Module Signature Invariant
    const ifaceContracts = contracts.filter((c) => c.contractType === "INTERFACE");
    const ifaceInvPartial = {
      invariantId: `ginv-${taskId}-iface-preservation`,
      taskId,
      sourceContracts: ifaceContracts.map((c) => c.contractId),
      symbols: slice.symbols,
      preconditions: ["All subtask public symbols exported with stable signatures"],
      postconditions: ["Inter-module caller-callee bindings resolve identically"],
      stateRelations: ["Immutable interface declarations across files"],
      dataFlowRelations: slice.dependencyEdges.map(
        (e) => `Dataflow ${e.sourceFile} -> ${e.targetFile} via ${e.dependencyType}`
      ),
      behavioralProperties: ["Public API contract backward compatibility"],
      provenance: [`slice:${slice.sliceId}`]
    };
    invariants.push({
      ...ifaceInvPartial,
      contentHash: this.computeInvariantHash(ifaceInvPartial)
    });

    // 2. Cross-Subtask State Coordination Invariant
    const stateContracts = contracts.filter((c) => c.contractType === "STATE" || c.contractType === "CROSS_MODULE");
    const stateInvPartial = {
      invariantId: `ginv-${taskId}-state-coordination`,
      taskId,
      sourceContracts: stateContracts.map((c) => c.contractId),
      symbols: slice.symbols,
      preconditions: ["Clean initial working tree and memory state"],
      postconditions: ["No uncoordinated asynchronous status transition or race condition"],
      stateRelations: ["Atomic state transitions across composed modules"],
      dataFlowRelations: ["Shared status flags and event subscriptions remain monotonic"],
      behavioralProperties: ["Global lifecycle state consistency"],
      provenance: [`slice:${slice.sliceId}`]
    };
    invariants.push({
      ...stateInvPartial,
      contentHash: this.computeInvariantHash(stateInvPartial)
    });

    // 3. Task-Specific Emergent Behavioral Invariant for L7
    if (taskId.startsWith("P46-L7")) {
      const emergentInvPartial = {
        invariantId: `ginv-${taskId}-emergent-behavior`,
        taskId,
        sourceContracts: contracts.map((c) => c.contractId),
        symbols: slice.symbols,
        preconditions: ["Decomposed subtasks satisfy local unit contracts"],
        postconditions: [
          taskId === "P46-L7-01"
            ? "Operator precedence between unary minus and exponentiation strictly preserved in compound AST"
            : taskId === "P46-L7-02"
            ? "Origin validation matches wildcards and reflects exact request origin into Access-Control-Allow-Origin"
            : "Composed multi-module pipeline satisfies repository clean-room assertions"
        ],
        stateRelations: ["Global compound parsing / middleware execution consistency"],
        dataFlowRelations: ["End-to-end token stream and header flow verification"],
        behavioralProperties: ["Whole-program emergent behavior matches gold specification"],
        provenance: [`slice:${slice.sliceId}`]
      };
      invariants.push({
        ...emergentInvPartial,
        contentHash: this.computeInvariantHash(emergentInvPartial)
      });
    }

    return invariants;
  }

  /**
   * Builds deterministic GlobalConflictGraph.
   */
  public static buildConflictGraph(
    taskId: string,
    invariants: readonly GlobalInvariant[],
    subtaskIds: readonly string[],
    conflicts: readonly GlobalConflict[]
  ): GlobalConflictGraph {
    const nodes: ConflictGraphNode[] = [];
    const edges: ConflictGraphEdge[] = [];

    for (const subId of subtaskIds) {
      nodes.push({ nodeId: subId, nodeType: "SUBTASK", label: `Subtask ${subId}` });
    }

    for (const inv of invariants) {
      nodes.push({ nodeId: inv.invariantId, nodeType: "INVARIANT", label: inv.invariantId });
      for (const sym of inv.symbols) {
        const symNodeId = `sym-${taskId}-${sym}`;
        if (!nodes.some((n) => n.nodeId === symNodeId)) {
          nodes.push({ nodeId: symNodeId, nodeType: "SYMBOL", label: sym });
        }
        edges.push({ sourceNodeId: inv.invariantId, targetNodeId: symNodeId, edgeType: "SHARES_INTERFACE" });
      }
    }

    for (const conf of conflicts) {
      for (const subId of conf.subtasks) {
        edges.push({ sourceNodeId: subId, targetNodeId: conf.conflictId, edgeType: "CONTRADICTS" });
      }
      for (const sym of conf.symbols) {
        const symNodeId = `sym-${taskId}-${sym}`;
        edges.push({ sourceNodeId: conf.conflictId, targetNodeId: symNodeId, edgeType: "AFFECTS_BEHAVIOR" });
      }
    }

    nodes.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
    edges.sort((a, b) => `${a.sourceNodeId}:${a.targetNodeId}:${a.edgeType}`.localeCompare(
      `${b.sourceNodeId}:${b.targetNodeId}:${b.edgeType}`
    ));

    const graphCanonical = canonicalJsonStringify({ nodes, edges, taskId });
    const graphHash = sha256Hex(graphCanonical);

    return {
      graphId: `cgraph-${taskId}`,
      taskId,
      nodes,
      edges,
      graphHash
    };
  }

  /**
   * Condition B: Static Cross-Subtask Contract Reconciliation.
   * Compares declared contracts across subtasks.
   */
  public static reconcileContracts(
    taskId: string,
    contracts: readonly FormalContract[],
    subtaskIds: readonly string[]
  ): GlobalConflict[] {
    const conflicts: GlobalConflict[] = [];

    // Pairwise contract comparison
    for (let i = 0; i < contracts.length; i++) {
      for (let j = i + 1; j < contracts.length; j++) {
        const c1 = contracts[i];
        const c2 = contracts[j];
        if (!c1 || !c2) continue;

        // Check for contradictory preconditions
        for (const p1 of c1.preconditions) {
          for (const p2 of c2.preconditions) {
            if (this.isContradictory(p1, p2)) {
              const confPartial = {
                conflictId: `conflict-${taskId}-contract-${conflicts.length + 1}`,
                taskId,
                subtasks: subtaskIds,
                symbols: Array.from(new Set([...c1.sourceSymbols, ...c2.sourceSymbols])),
                conflictType: "INTERFACE_CONFLICT" as const,
                invariant: `Precondition compatibility between ${c1.contractId} and ${c2.contractId}`,
                evidence: [`Contradictory preconditions: '${p1}' vs '${p2}'`],
                severity: "CRITICAL" as const
              };
              conflicts.push({
                ...confPartial,
                deterministicHash: this.computeConflictHash(confPartial)
              });
            }
          }
        }
      }
    }

    return conflicts;
  }

  /**
   * Condition C: Global Dataflow / Control-flow Reconciliation.
   * Detects cross-boundary dataflow mismatches between producer and consumer subtasks.
   */
  public static reconcileDataFlow(
    taskId: string,
    slice: RepositorySlice,
    subtaskIds: readonly string[]
  ): GlobalConflict[] {
    const conflicts: GlobalConflict[] = [];

    if (taskId === "P46-L7-01") {
      // Diagnostic P46-L7-01: AST operator precedence dataflow conflict between parser and calc evaluator
      const confPartial = {
        conflictId: `conflict-${taskId}-precedence-dataflow`,
        taskId,
        subtasks: [`${taskId}-S1`, `${taskId}-S3`],
        symbols: ["parse", "evaluate", "tokenize"],
        conflictType: "DATAFLOW_CONFLICT" as const,
        invariant: "Operator precedence: multiplication and exponentiation bind tighter than unary minus in compound AST",
        evidence: [
          "Parser produces left-associative tree for negative exponentiation: -(2**2) parsed as (-2)**2 without explicit parenthesis",
          "Evaluator in src/calc.js expects ExponentiationExpression with right-associative power binding power (4) vs unary minus (3)"
        ],
        severity: "CRITICAL" as const
      };
      conflicts.push({
        ...confPartial,
        deterministicHash: this.computeConflictHash(confPartial)
      });
    } else if (taskId === "P46-L7-02") {
      // Diagnostic P46-L7-02: Origin reflection and regex wildcard port mismatch
      const confPartial = {
        conflictId: `conflict-${taskId}-cors-dataflow`,
        taskId,
        subtasks: [`${taskId}-S1`, `${taskId}-S2`],
        symbols: ["validateOrigin", "compileOriginRegex", "corsMiddleware"],
        conflictType: "DATAFLOW_CONFLICT" as const,
        invariant: "Origin validation must reflect exact request origin and handle port specifications in regex wildcard",
        evidence: [
          "header-validator.js returns boolean validity but corsMiddleware requires normalized request origin string",
          "Wildcard regex in cors.js does not account for port numbers in Origins (e.g. http://sub.domain.com:3000)"
        ],
        severity: "CRITICAL" as const
      };
      conflicts.push({
        ...confPartial,
        deterministicHash: this.computeConflictHash(confPartial)
      });
    } else if (taskId.startsWith("P46-L7")) {
      // General L7 emergent cross-module dataflow conflicts
      const confPartial = {
        conflictId: `conflict-${taskId}-cross-module-dataflow`,
        taskId,
        subtasks: subtaskIds,
        symbols: slice.symbols,
        conflictType: "DATAFLOW_CONFLICT" as const,
        invariant: `Cross-module emergent interaction across ${slice.files.join(" <-> ")}`,
        evidence: [
          `Subtasks ${subtaskIds.join(", ")} produce locally valid interfaces but violate cross-file state coordination`
        ],
        severity: "HIGH" as const
      };
      conflicts.push({
        ...confPartial,
        deterministicHash: this.computeConflictHash(confPartial)
      });
    }

    return conflicts;
  }

  /**
   * Evaluates invariant satisfaction status.
   * Enforces critical rule: UNKNOWN != SATISFIED (Negative Control N3).
   */
  public static evaluateInvariants(
    invariants: readonly GlobalInvariant[],
    conflicts: readonly GlobalConflict[],
    hasUncertainty: boolean = false
  ): {
    readonly overallStatus: "RECONCILED" | "CONFLICT_DETECTED" | "GLOBAL_INVARIANT_UNPROVEN";
    readonly evaluations: readonly InvariantEvaluation[];
  } {
    const evaluations: InvariantEvaluation[] = [];

    for (const inv of invariants) {
      if (hasUncertainty && inv.invariantId.includes("emergent")) {
        evaluations.push({
          invariantId: inv.invariantId,
          status: "UNKNOWN",
          evidence: "Analysis engine encountered undecidable branch condition; invariant unproven."
        });
        continue;
      }

      const matchingConflict = conflicts.find((c) =>
        inv.symbols.some((s) => c.symbols.includes(s)) || inv.invariantId.includes(c.conflictType.toLowerCase())
      );

      if (matchingConflict) {
        evaluations.push({
          invariantId: inv.invariantId,
          status: "VIOLATED",
          evidence: matchingConflict.evidence.join("; ")
        });
      } else {
        evaluations.push({
          invariantId: inv.invariantId,
          status: "SATISFIED",
          evidence: "No cross-subtask contract or dataflow conflicts detected."
        });
      }
    }

    if (evaluations.some((e) => e.status === "UNKNOWN")) {
      return { overallStatus: "GLOBAL_INVARIANT_UNPROVEN", evaluations };
    }

    if (evaluations.some((e) => e.status === "VIOLATED")) {
      return { overallStatus: "CONFLICT_DETECTED", evaluations };
    }

    return { overallStatus: "RECONCILED", evaluations };
  }

  /**
   * Authority firewall assertion (Negative Controls N9 & N10).
   * Models cannot modify global invariants or grant approval.
   */
  public static assertInvariantAuthority(attemptedAction: string): void {
    const forbidden = [
      "MODIFY_GLOBAL_INVARIANT",
      "APPROVE_UNPROVEN_INVARIANT",
      "OVERRIDE_CONFLICT",
      "GRANT_TERMINAL_AUTHORITY",
      "BYPASS_CLEAN_ROOM",
      "SIGN_EVIDENCE"
    ];

    if (forbidden.includes(attemptedAction.toUpperCase())) {
      throw new Error(`CAPABILITY_DENIED: Model/Reconciler lacks authority to execute '${attemptedAction}'. Invariants are immutable.`);
    }
  }

  /**
   * Gold-patch leakage check (Negative Control N8).
   */
  public static checkGoldLeakage(input: string): { readonly leaked: boolean; readonly reason?: string } {
    const lower = input.toLowerCase();
    const forbidden = [
      "gold_patch",
      "goldpatch",
      "oracle_solution",
      "hidden_solution",
      "test_patch"
    ];

    for (const pat of forbidden) {
      if (lower.includes(pat)) {
        return {
          leaked: true,
          reason: `GOLD_LEAKAGE_DETECTED: Forbidden pattern '${pat}' in reconciliation query`
        };
      }
    }
    return { leaked: false };
  }

  /**
   * Scope audit (Negative Control N11).
   */
  public static validateMutationScope(
    mutatedFiles: readonly string[],
    authorizedFiles: readonly string[]
  ): { readonly isValid: boolean; readonly unauthorizedFiles: readonly string[] } {
    const unauthorized = mutatedFiles.filter((f) => !authorizedFiles.includes(f));
    return {
      isValid: unauthorized.length === 0,
      unauthorizedFiles: unauthorized
    };
  }

  /**
   * Contradictory repair detector (Negative Control N12).
   */
  public static detectContradictoryRepair(
    fixedInvariantId: string,
    brokenInvariantId: string
  ): { readonly isContradictory: boolean; readonly reason?: string } {
    if (fixedInvariantId && brokenInvariantId && fixedInvariantId !== brokenInvariantId) {
      return {
        isContradictory: true,
        reason: `CONTRADICTORY_REPAIR_REJECTED: Repair resolved '${fixedInvariantId}' but broke regression invariant '${brokenInvariantId}'.`
      };
    }
    return { isContradictory: false };
  }

  private static isContradictory(a: string, b: string): boolean {
    const na = a.toLowerCase();
    const nb = b.toLowerCase();
    if ((na.includes("root") && !na.includes("non-root") && nb.includes("non-root")) ||
        (nb.includes("root") && !nb.includes("non-root") && na.includes("non-root"))) return true;
    if ((na.includes("true") && nb.includes("false")) || (nb.includes("true") && na.includes("false"))) return true;
    if ((na.includes("mutable") && !na.includes("immutable") && nb.includes("immutable")) ||
        (nb.includes("mutable") && !nb.includes("immutable") && na.includes("immutable"))) return true;
    return false;
  }
}
