/**
 * Phase 52 — Governed Formal Contract Extraction & Subtask Projection Module
 *
 * Implements:
 * 1. FormalContract extraction (Interface, State, Behavioral, Cross-Module)
 * 2. Immutable contract representations and canonical hashing
 * 3. Contract contradiction detection (N10)
 * 4. Contract immutability enforcement (N3)
 * 5. Subtask complexity validation against the Phase 45 ladder (N6)
 * 6. Cross-slice invariant conflict detection (N7)
 * 7. SubtaskDAG composition and verification
 *
 * Invariants:
 * - Contracts are immutable records passed as read-only observations.
 * - The model cannot edit, delete, or override active contracts.
 * - Any subtask exceeding the configured L6 boundary triggers DECOMPOSITION_BOUNDARY_FAILURE.
 */

import { canonicalJsonStringify, sha256Hex } from "../domain/canonical-hash.js";
import { RepositorySlice } from "./repository-slicer.js";

// ============================================================================
// 1. Types & Interfaces
// ============================================================================

export type ContractType = "INTERFACE" | "STATE" | "BEHAVIORAL" | "CROSS_MODULE";

export interface FormalContract {
  readonly contractId: string;
  readonly taskId: string;
  readonly contractType: ContractType;
  readonly sourceSymbols: readonly string[];
  readonly preconditions: readonly string[];
  readonly postconditions: readonly string[];
  readonly invariants: readonly string[];
  readonly interfaceConstraints: readonly string[];
  readonly stateConstraints: readonly string[];
  readonly provenance: readonly string[];
  readonly contentHash: string;
  readonly isImmutable: boolean;
}

export interface ContractCollection {
  readonly taskId: string;
  readonly contracts: readonly FormalContract[];
  readonly collectionHash: string;
  readonly contractCount: number;
  readonly contractBytes: number;
  readonly requiredInvariants: readonly string[];
  readonly coveredInvariants: readonly string[];
  readonly recall: number;
  readonly precision: number;
}

export type TaskComplexityLadder = "L0" | "L1" | "L2" | "L3" | "L4" | "L5" | "L6" | "L7";

export interface SubtaskDefinition {
  readonly subtaskId: string;
  readonly parentTaskId: string;
  readonly title: string;
  readonly complexityTier: TaskComplexityLadder;
  readonly targetFiles: readonly string[];
  readonly targetSymbols: readonly string[];
  readonly assignedContracts: readonly string[];
  readonly dependencies: readonly string[]; // DAG predecessors
  readonly maxMutationAttempts: number;
  readonly maxRepairAttempts: number;
  readonly estimatedMutationSurfaceLines: number;
}

export interface SubtaskDAG {
  readonly dagId: string;
  readonly parentTaskId: string;
  readonly parentComplexityTier: "L5_MULTI_FUNCTION" | "L6_MULTI_FILE" | "L7_FULL_SWE";
  readonly subtasks: readonly SubtaskDefinition[];
  readonly maxDepth: number;
  readonly maxFanout: number;
  readonly isProjectedToL6OrBelow: boolean;
  readonly dagHash: string;
}

// ============================================================================
// 2. ContractExtractor Implementation
// ============================================================================

export class ContractExtractor {
  /**
   * Deterministically computes the SHA-256 hash of a formal contract.
   */
  public static computeContractHash(contract: Omit<FormalContract, "contentHash" | "isImmutable">): string {
    const canonical = canonicalJsonStringify({
      contractId: contract.contractId,
      contractType: contract.contractType,
      invariants: [...contract.invariants].sort(),
      interfaceConstraints: [...contract.interfaceConstraints].sort(),
      postconditions: [...contract.postconditions].sort(),
      preconditions: [...contract.preconditions].sort(),
      provenance: [...contract.provenance].sort(),
      sourceSymbols: [...contract.sourceSymbols].sort(),
      stateConstraints: [...contract.stateConstraints].sort(),
      taskId: contract.taskId
    });
    return sha256Hex(canonical);
  }

  /**
   * Deterministically extracts formal contracts from slice and authoritative invariants.
   */
  public static extractContracts(spec: {
    taskId: string;
    slice: RepositorySlice;
    targetSymbols: readonly string[];
    invariants: readonly string[];
    preconditions?: readonly string[];
    postconditions?: readonly string[];
    interfaceConstraints?: readonly string[];
    stateConstraints?: readonly string[];
    requiredInvariants?: readonly string[];
  }): ContractCollection {
    const contracts: FormalContract[] = [];

    // 1. Interface Contract
    const ifacePre = spec.preconditions ?? ["Inputs conform to typed parameter schemas"];
    const ifacePost = spec.postconditions ?? ["Return value satisfies expected interface signature"];
    const ifaceConstraints = spec.interfaceConstraints ?? spec.targetSymbols.map((s) => `Signature of '${s}' must remain invariant`);
    const ifacePartial = {
      contractId: `contract-${spec.taskId}-interface`,
      taskId: spec.taskId,
      contractType: "INTERFACE" as const,
      sourceSymbols: spec.targetSymbols,
      preconditions: ifacePre,
      postconditions: ifacePost,
      invariants: spec.invariants.filter((i) => i.toLowerCase().includes("signature") || i.toLowerCase().includes("type")),
      interfaceConstraints: ifaceConstraints,
      stateConstraints: [],
      provenance: [`slice:${spec.slice.sliceId}`]
    };
    contracts.push({
      ...ifacePartial,
      contentHash: this.computeContractHash(ifacePartial),
      isImmutable: true
    });

    // 2. State & Invariant Contract
    const stateInvariants = spec.invariants.length > 0
      ? spec.invariants
      : [`State consistency preserved across ${spec.slice.files.join(", ")}`];
    const stateConstraints = spec.stateConstraints ?? ["Working tree remains clean", "No extraneous global state mutation"];
    const statePartial = {
      contractId: `contract-${spec.taskId}-state`,
      taskId: spec.taskId,
      contractType: "STATE" as const,
      sourceSymbols: spec.targetSymbols,
      preconditions: ["Clean initial state"],
      postconditions: ["State transitions strictly valid"],
      invariants: stateInvariants,
      interfaceConstraints: [],
      stateConstraints: stateConstraints,
      provenance: [`slice:${spec.slice.sliceId}`]
    };
    contracts.push({
      ...statePartial,
      contentHash: this.computeContractHash(statePartial),
      isImmutable: true
    });

    // 3. Cross-Module Contract (if multi-file)
    if (spec.slice.files.length > 1) {
      const crossPartial = {
        contractId: `contract-${spec.taskId}-cross-module`,
        taskId: spec.taskId,
        contractType: "CROSS_MODULE" as const,
        sourceSymbols: spec.targetSymbols,
        preconditions: ["Producer-consumer modules aligned on shared protocol"],
        postconditions: ["Composed subsystem passes cross-module integration tests"],
        invariants: [`Cross-boundary invariants preserved between ${spec.slice.files.join(" <-> ")}`],
        interfaceConstraints: ["Inter-module calls adhere to declared signatures"],
        stateConstraints: ["No shared lock contention or asynchronous status race"],
        provenance: [`slice:${spec.slice.sliceId}`]
      };
      contracts.push({
        ...crossPartial,
        contentHash: this.computeContractHash(crossPartial),
        isImmutable: true
      });
    }

    // Measure contract recall against required invariants
    const requiredInvariants = spec.requiredInvariants ?? spec.invariants;
    const coveredInvariants = requiredInvariants.filter((req) =>
      contracts.some((c) => c.invariants.some((inv) => inv === req || inv.includes(req)))
    );
    const recall = requiredInvariants.length === 0 ? 1.0 : Number((coveredInvariants.length / requiredInvariants.length).toFixed(4));
    const precision = 1.0;

    const collectionCanonical = canonicalJsonStringify(contracts.map((c) => c.contentHash).sort());
    const collectionHash = sha256Hex(collectionCanonical);
    const contractBytes = JSON.stringify(contracts).length;

    return {
      taskId: spec.taskId,
      contracts,
      collectionHash,
      contractCount: contracts.length,
      contractBytes,
      requiredInvariants,
      coveredInvariants,
      recall,
      precision
    };
  }

  /**
   * Enforces contract immutability (Negative Control N3).
   * Models cannot edit or override active formal contracts.
   */
  public static assertContractImmutability(contract: FormalContract, mutationAttempt: unknown): void {
    if (mutationAttempt !== null && typeof mutationAttempt === "object") {
      throw new Error(`CAPABILITY_DENIED: FormalContract '${contract.contractId}' is immutable and cannot be modified by model proposals.`);
    }
  }

  /**
   * Detects contradictory pre/post conditions or mutually exclusive invariants (Negative Control N10).
   */
  public static detectContractContradictions(contracts: readonly FormalContract[]): {
    readonly hasContradiction: boolean;
    readonly conflictingContractIds: readonly string[];
    readonly conflictDescription?: string;
  } {
    const isPairContradictory = (a: string, b: string): boolean => {
      const normA = a.toLowerCase();
      const normB = b.toLowerCase();
      if (
        (normA.includes("root") && !normA.includes("non-root") && normB.includes("non-root")) ||
        (normB.includes("root") && !normB.includes("non-root") && normA.includes("non-root"))
      ) {
        return true;
      }
      if (
        (normA.includes("true") && normB.includes("false")) ||
        (normB.includes("true") && normA.includes("false"))
      ) {
        return true;
      }
      if (
        (normA.includes("mutable") && !normA.includes("immutable") && normB.includes("immutable")) ||
        (normB.includes("mutable") && !normB.includes("immutable") && normA.includes("immutable"))
      ) {
        return true;
      }
      if (
        (normA.includes("null") && !normA.includes("non-null") && normB.includes("non-null")) ||
        (normB.includes("null") && !normB.includes("non-null") && normA.includes("non-null"))
      ) {
        return true;
      }
      if (
        (normA.includes("throws") && !normA.includes("never") && normB.includes("never throws")) ||
        (normB.includes("throws") && !normB.includes("never") && normA.includes("never throws"))
      ) {
        return true;
      }
      if (
        (normA.includes("allow all") && normB.includes("deny all")) ||
        (normB.includes("allow all") && normA.includes("deny all"))
      ) {
        return true;
      }
      return false;
    };

    const allPre: { text: string; cid: string }[] = [];
    const allPost: { text: string; cid: string }[] = [];
    const conflictingIds = new Set<string>();

    for (const c of contracts) {
      for (const pre of c.preconditions) {
        for (const existing of allPre) {
          if (isPairContradictory(pre, existing.text)) {
            conflictingIds.add(c.contractId);
            conflictingIds.add(existing.cid);
            return {
              hasContradiction: true,
              conflictingContractIds: Array.from(conflictingIds),
              conflictDescription: `CONTRACT_CONTRADICTION_DETECTED: Preconditions '${pre}' and '${existing.text}' contradict.`
            };
          }
        }
        allPre.push({ text: pre, cid: c.contractId });
      }

      for (const post of c.postconditions) {
        for (const existing of allPost) {
          if (isPairContradictory(post, existing.text)) {
            conflictingIds.add(c.contractId);
            conflictingIds.add(existing.cid);
            return {
              hasContradiction: true,
              conflictingContractIds: Array.from(conflictingIds),
              conflictDescription: `CONTRACT_CONTRADICTION_DETECTED: Postconditions '${post}' and '${existing.text}' contradict.`
            };
          }
        }
        allPost.push({ text: post, cid: c.contractId });
      }
    }

    return {
      hasContradiction: false,
      conflictingContractIds: []
    };
  }

  /**
   * Validates subtask complexity against the empirical Phase 45 ladder (Negative Control N6).
   * Ceiling is L6 (and mutation surface <= 150 lines). If L7, triggers DECOMPOSITION_BOUNDARY_FAILURE.
   */
  public static validateSubtaskComplexity(subtask: SubtaskDefinition): {
    readonly isValid: boolean;
    readonly failureReason?: string;
  } {
    if (subtask.complexityTier === "L7") {
      return {
        isValid: false,
        failureReason: "DECOMPOSITION_BOUNDARY_FAILURE: Subtask complexity tier is 'L7', exceeding maximum permitted 'L6' ceiling."
      };
    }

    if (subtask.estimatedMutationSurfaceLines > 150) {
      return {
        isValid: false,
        failureReason: `DECOMPOSITION_BOUNDARY_FAILURE: Subtask estimated mutation surface ${subtask.estimatedMutationSurfaceLines} lines exceeds 150-line ceiling.`
      };
    }

    return { isValid: true };
  }

  /**
   * Validates subtask DAG bounds (max subtasks <= 6, max depth <= 3).
   */
  public static validateDAG(dag: SubtaskDAG): {
    readonly isValid: boolean;
    readonly failureReason?: string;
  } {
    if (dag.subtasks.length > 6) {
      return {
        isValid: false,
        failureReason: `DAG_BUDGET_EXCEEDED: Subtask count ${dag.subtasks.length} exceeds MAX_SUBTASKS ceiling of 6.`
      };
    }

    if (dag.maxDepth > 3) {
      return {
        isValid: false,
        failureReason: `DAG_BUDGET_EXCEEDED: DAG depth ${dag.maxDepth} exceeds MAX_DAG_DEPTH ceiling of 3.`
      };
    }

    for (const subtask of dag.subtasks) {
      const compCheck = this.validateSubtaskComplexity(subtask);
      if (!compCheck.isValid) {
        return compCheck;
      }
    }

    return { isValid: true };
  }

  /**
   * Detects cross-slice invariant conflicts during composition (Negative Control N7).
   */
  public static detectCrossSliceConflicts(
    mutations: readonly {
      readonly file: string;
      readonly modifiedSymbols: readonly string[];
      readonly violatedInvariants: readonly string[];
    }[]
  ): {
    readonly hasConflict: boolean;
    readonly conflictReason?: string;
  } {
    for (const m of mutations) {
      if (m.violatedInvariants.length > 0) {
        return {
          hasConflict: true,
          conflictReason: `CROSS_SLICE_INVARIANT_CONFLICT: Mutation in '${m.file}' violated shared invariant: ${m.violatedInvariants.join("; ")}`
        };
      }
    }
    return { hasConflict: false };
  }
}
