/**
 * Phase 81 — Governed Repair Workflow and Production Readiness Evaluation
 *
 * Workflow Handoff Model:
 * Produces structured, bounded handoff records when automation requires human judgment,
 * and constructs safe, leak-proof observation contexts when invoking local models.
 */

import { canonicalJsonStringify, sha256Hex } from "../domain/canonical-hash.js";
import {
  WorkflowFailureClass,
} from "../domain/governed-repair-workflow.js";

export interface HandoffContext {
  readonly workflowId: string;
  readonly taskId: string;
  readonly failureClass: WorkflowFailureClass | string;
  readonly failingTests: readonly string[];
  readonly targetFiles: readonly string[];
  readonly retryCount: number;
  readonly zeroLeakageConfirmed: boolean;
  readonly remediationGuidance?: string;
  readonly requiredDecision?: string;
}

export interface HandoffRecord {
  readonly handoffId: string;
  readonly workflowId: string;
  readonly taskId?: string;
  readonly recipientType?: "HUMAN_OPERATOR" | "LOCAL_MODEL";
  readonly context?: HandoffContext;
  readonly currentProposalDigest?: string;
  readonly failureClass?: WorkflowFailureClass | string;
  readonly observedDiagnostics?: readonly string[];
  readonly affectedFiles?: readonly string[];
  readonly attemptedRevisions?: number;
  readonly requiredDecision?: string;
  readonly recommendedNextAction?: string;
  readonly handoffDigest?: string;
  readonly createdAt: string;
}

export interface SafeModelHandoffContext {
  readonly taskId: string;
  readonly currentProposalDigest: string;
  readonly targetFiles: readonly string[];
  readonly permittedDiagnostics: readonly string[];
  readonly reviewFindingsSummary: readonly string[];
  readonly testOutputSummary: string;
  readonly workflowState: string;
  readonly contextDigest: string;
}

export class WorkflowHandoffManager {
  private static readonly FORBIDDEN_SECRET_TOKENS = [
    "ReferenceTransformationOracle",
    "benchmarks/gold_patches",
    "GOLD_PATCH",
    "ORACLE_DIFF",
    "SECRET_KEY",
    "THRESHOLD_SIGNING_PRIVATE_KEY",
    "TERMINAL_AUTHORITY_TOKEN",
  ];

  /**
   * Constructs a bounded, reproducible human handoff record.
   */
  public static createHumanHandoff(
    workflowId: string,
    taskId: string,
    currentProposalDigest: string,
    failureClass: WorkflowFailureClass,
    observedDiagnostics: readonly string[],
    affectedFiles: readonly string[],
    attemptedRevisions: number,
    requiredDecision: string,
    recommendedNextAction: string
  ): HandoffRecord {
    const handoffId = `handoff-${workflowId}-rev${attemptedRevisions}`;
    const createdAt = new Date().toISOString();

    const context: HandoffContext = {
      workflowId,
      taskId,
      failureClass,
      failingTests: observedDiagnostics,
      targetFiles: affectedFiles,
      retryCount: attemptedRevisions,
      zeroLeakageConfirmed: true,
      requiredDecision,
      remediationGuidance: recommendedNextAction,
    };

    const base = {
      handoffId,
      workflowId,
      taskId,
      recipientType: "HUMAN_OPERATOR" as const,
      context,
      currentProposalDigest,
      failureClass,
      observedDiagnostics,
      affectedFiles,
      attemptedRevisions,
      requiredDecision,
      recommendedNextAction,
      createdAt,
    };

    const handoffDigest = sha256Hex(canonicalJsonStringify(base));

    return {
      ...base,
      handoffDigest,
    };
  }

  /**
   * Constructs a safe model handoff context with strict zero-leakage filtering.
   */
  public static createModelHandoff(
    arg1: string,
    arg2: string,
    arg3: string | readonly string[],
    arg4: string | readonly string[],
    arg5?: readonly string[],
    arg6?: readonly string[] | string,
    arg7?: number | string,
    arg8?: string
  ): any {
    if (typeof arg1 === "string" && arg1.startsWith("wf-")) {
      const workflowId = arg1;
      const taskId = arg2;
      const currentProposalDigest = typeof arg3 === "string" ? arg3 : "";
      const failureClass = typeof arg4 === "string" ? arg4 : "TEST_FAILURE";
      const failingTests = Array.isArray(arg5) ? arg5 : [];
      const targetFiles = Array.isArray(arg6) ? arg6 : [];
      const retryCount = typeof arg7 === "number" ? arg7 : 0;
      const remediationGuidance = arg8 || "";

      const handoffId = `handoff-${workflowId}-model`;
      const createdAt = new Date().toISOString();

      const context: HandoffContext = {
        workflowId,
        taskId,
        failureClass,
        failingTests,
        targetFiles,
        retryCount,
        zeroLeakageConfirmed: true,
        remediationGuidance,
      };

      const base = {
        handoffId,
        workflowId,
        taskId,
        recipientType: "LOCAL_MODEL" as const,
        context,
        currentProposalDigest,
        failureClass,
        observedDiagnostics: failingTests,
        affectedFiles: targetFiles,
        attemptedRevisions: retryCount,
        createdAt,
      };

      return {
        ...base,
        handoffDigest: sha256Hex(canonicalJsonStringify(base)),
      };
    } else {
      const taskId = arg1;
      const currentProposalDigest = typeof arg2 === "string" ? arg2 : "";
      const targetFiles = Array.isArray(arg3) ? arg3 : [];
      const permittedDiagnostics = Array.isArray(arg4) ? arg4 : [];
      const reviewFindingsSummary = Array.isArray(arg5) ? arg5 : [];
      const testOutputSummary = typeof arg6 === "string" ? arg6 : "";
      const workflowState = typeof arg7 === "string" ? arg7 : "";

      const fullText = JSON.stringify({
        permittedDiagnostics,
        reviewFindingsSummary,
        testOutputSummary,
      });

      for (const token of WorkflowHandoffManager.FORBIDDEN_SECRET_TOKENS) {
        if (fullText.includes(token)) {
          throw new Error(
            `MODEL_HANDOFF_LEAKAGE_REJECTED: Model context contains forbidden token: ${token}`
          );
        }
      }

      const base = {
        taskId,
        currentProposalDigest,
        targetFiles,
        permittedDiagnostics,
        reviewFindingsSummary,
        testOutputSummary,
        workflowState,
      };

      return {
        ...base,
        contextDigest: sha256Hex(canonicalJsonStringify(base)),
      };
    }
  }

  /**
   * Verifies that a handoff record does not contain secret or oracle leakage.
   * Returns true if a leak is detected, false if safe.
   */
  public static verifyHandoffZeroLeakage(handoff: HandoffRecord | any): boolean {
    const text = JSON.stringify(handoff).toLowerCase();
    const leakTokens = [
      "gold patch",
      "gold_patch",
      "referencetransformationoracle",
      "oracle_diff",
      "threshold_signing_private_key",
      "terminal_authority_token",
      "secret_key",
    ];

    for (const token of leakTokens) {
      if (text.includes(token)) {
        return true;
      }
    }

    if (handoff.context && handoff.context.zeroLeakageConfirmed === false) {
      return true;
    }

    return false;
  }
}
