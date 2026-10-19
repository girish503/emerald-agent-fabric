/**
 * Phase 51 — Governed Execution-Tier Capability Amplification Module
 *
 * Implements bounded, deterministic amplification of the execution tier:
 * 1. ExecutionAmplificationPlan: immutable execution contract.
 * 2. DeterministicDiagnosticExtractor: extracts compiler/test/diff feedback.
 * 3. LocalReferenceEnvironment: read-only local idiom retrieval.
 * 4. ExecutionAmplifier: coordinates bounded iterative mutation and repair.
 *
 * Invariants:
 * - Amplification is NEVER an authority mechanism.
 * - Cannot declare task completion, alter verification criteria, or sign evidence.
 * - Clean-room verification remains 100% authoritative and fail-closed.
 * - Strict budget ceilings enforced: maxMutationAttempts = 3, maxRepairAttempts = 2, totalModelCalls <= 9.
 */

import { ActionProposalSchema, findForbiddenAuthorityKeys } from "../domain/action-proposal.js";

// ============================================================================
// 1. Types & Interfaces
// ============================================================================

export interface ExecutionAmplificationPlan {
  readonly planId: string;
  readonly taskId: string;
  readonly semanticPlanHash: string;
  readonly targetFiles: readonly string[];
  readonly targetSymbols: readonly string[];
  readonly structuralPreconditions: readonly string[];
  readonly structuralPostconditions: readonly string[];
  readonly maxMutationAttempts: number;
  readonly maxRepairAttempts: number;
  readonly referenceSetHash?: string;
  readonly isActivated: boolean;
}

export interface ExecutionDiagnostic {
  readonly attemptNumber: number;
  readonly stage: "MUTATION" | "LOCAL_VALIDATION" | "REPAIR";
  readonly compilerPassed: boolean;
  readonly localTestPassed: boolean;
  readonly astValid: boolean;
  readonly diffScopeValid: boolean;
  readonly diagnosticMessages: readonly string[];
  readonly recommendedAction?: string;
}

export interface LocalReferencePattern {
  readonly patternId: string;
  readonly domain: string;
  readonly description: string;
  readonly sampleCode: string;
  readonly applicableAstNodeType: string;
}

export interface MutationAttemptResult {
  readonly attemptNumber: number;
  readonly proposalValid: boolean;
  readonly astPatchApplied: boolean;
  readonly typescriptCompiles: boolean;
  readonly localTestsPass: boolean;
  readonly diffScopeValid: boolean;
  readonly cleanRoomVerified: boolean;
  readonly failureClass?: string;
}

// ============================================================================
// 2. Deterministic Diagnostic Extractor
// ============================================================================

export class DeterministicDiagnosticExtractor {
  static extractFeedback(
    compilerOutput: string,
    testOutput: string,
    astValid: boolean,
    diffFiles: readonly string[],
    authorizedFiles: readonly string[]
  ): ExecutionDiagnostic {
    const messages: string[] = [];
    let compilerPassed = true;
    let localTestPassed = true;
    let diffScopeValid = true;

    // 1. Compiler check
    if (compilerOutput.includes("error TS") || compilerOutput.includes("SyntaxError")) {
      compilerPassed = false;
      const match = compilerOutput.match(/(error TS\d+:[^\n]+)/);
      messages.push((match && match[1]) ? match[1] : "Compiler syntax error detected");
    }

    // 2. Test check
    if (testOutput.includes("FAIL") || testOutput.includes("AssertionError") || testOutput.includes("ERR_ASSERTION")) {
      localTestPassed = false;
      const match = testOutput.match(/(AssertionError[^\n]+)/);
      messages.push((match && match[1]) ? match[1] : "Local test assertion failure");
    }

    // 3. AST validity check
    if (!astValid) {
      messages.push("AST node mismatch or invalid target structure");
    }

    // 4. Scope check
    for (const file of diffFiles) {
      if (!authorizedFiles.includes(file)) {
        diffScopeValid = false;
        messages.push(`Scope violation: modification of unauthorized file ${file}`);
      }
    }

    return {
      attemptNumber: 1,
      stage: "LOCAL_VALIDATION",
      compilerPassed,
      localTestPassed,
      astValid,
      diffScopeValid,
      diagnosticMessages: Object.freeze(messages),
      recommendedAction: !compilerPassed
        ? "Fix syntax/type errors before re-running tests"
        : !astValid
        ? "Re-target AST node or adjust node transformation type"
        : !localTestPassed
        ? "Adjust implementation to satisfy failing test assertion"
        : !diffScopeValid
        ? "Revert changes to unauthorized files"
        : "Proceed to clean-room verification"
    };
  }
}

// ============================================================================
// 3. Local Reference Environment (Read-Only)
// ============================================================================

export class LocalReferenceEnvironment {
  private readonly patterns: Map<string, LocalReferencePattern> = new Map();

  constructor(initialPatterns: readonly LocalReferencePattern[]) {
    for (const p of initialPatterns) {
      this.patterns.set(p.patternId, p);
    }
  }

  retrievePatterns(domain: string): readonly LocalReferencePattern[] {
    const results: LocalReferencePattern[] = [];
    for (const pattern of this.patterns.values()) {
      if (pattern.domain === domain || domain === "*") {
        results.push(pattern);
      }
    }
    return Object.freeze(results);
  }

  validateReferenceSafety(query: string): { safe: boolean; reason?: string } {
    const lower = query.toLowerCase();
    if (lower.includes("gold_patch") || lower.includes("test_solution") || lower.includes("oracle")) {
      return { safe: false, reason: "LEAKAGE_ATTEMPT_PROHIBITED" };
    }
    return { safe: true };
  }
}

// ============================================================================
// 4. Execution Amplifier (Deterministic Coordinator)
// ============================================================================

export class ExecutionAmplifier {
  private attemptsUsed = 0;
  private repairsUsed = 0;
  private readonly maxMutationAttempts: number;
  private readonly maxRepairAttempts: number;

  constructor(plan: ExecutionAmplificationPlan) {
    if (!plan.isActivated) {
      throw new Error("CANNOT_EXECUTE_UNACTIVATED_PLAN");
    }
    this.maxMutationAttempts = plan.maxMutationAttempts;
    this.maxRepairAttempts = plan.maxRepairAttempts;
  }

  recordMutationAttempt(proposalPayload: unknown): void {
    this.attemptsUsed++;
    if (this.attemptsUsed > this.maxMutationAttempts) {
      throw new Error("CASCADE_BUDGET_EXCEEDED");
    }

    // Negative control N8 check: validate authority firewall
    const forbidden = findForbiddenAuthorityKeys(proposalPayload);
    if (forbidden.length > 0) {
      throw new Error(`AUTHORITY_FIREWALL_VIOLATION: ${forbidden.join(", ")}`);
    }

    // Validate ActionProposal schema
    const parsed = ActionProposalSchema.safeParse(proposalPayload);
    if (!parsed.success) {
      throw new Error("ACTION_PROPOSAL_SCHEMA_INVALID");
    }
  }

  recordRepairAttempt(): void {
    this.repairsUsed++;
    if (this.repairsUsed > this.maxRepairAttempts) {
      throw new Error("CASCADE_BUDGET_EXCEEDED");
    }
  }

  getAttemptsCount(): number {
    return this.attemptsUsed;
  }

  getRepairsCount(): number {
    return this.repairsUsed;
  }

  assertNoPrematureGoalDeclaration(isGoalReachedClaimed: boolean, mutationApplied: boolean): void {
    if (isGoalReachedClaimed && !mutationApplied) {
      throw new Error("PREMATURE_GOAL_DECLARATION_REJECTED");
    }
  }

  assertCleanRoomAuthority(cleanRoomPassed: boolean, fourfoldPassed: boolean): boolean {
    // Only dual-gate clean room + fourfold completion can grant terminal success
    return cleanRoomPassed && fourfoldPassed;
  }
}
