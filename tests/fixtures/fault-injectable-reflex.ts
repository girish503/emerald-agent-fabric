/**
 * Emerald Agent Fabric — Phase 8.6 Test Fixture
 * Fault-Injectable Reflex Test Double
 *
 * Implements ReflexPort with programmatic fault injection to rigorously verify:
 * - Fail-closed containment on any internal Reflex failure.
 * - Zero tool dispatch (providerInvocationCount === 0) on faults.
 * - Honest telemetry preservation without synthetic zeros or fabricated decisions.
 * - AbortSignal cancellation fast-paths.
 * - Timeout ceiling enforcement.
 * - Monotonic authority preservation.
 */

import type { ActionProposal } from "../../src/domain/action-proposal.js";
import {
  type ReflexContext,
  type ReflexDecision,
  type RuleBasedReflexConfig,
  DEFAULT_RULE_BASED_REFLEX_CONFIG,
  computeRuleBasedReflexConfigHash,
} from "../../src/domain/reflex.js";
import { ReflexExecutionError } from "../../src/domain/errors.js";
import type { ReflexPort } from "../../src/ports/reflex.port.js";
import { RuleBasedReflex } from "../../src/adapters/reflex/rule-based-reflex.js";

export type ReflexFaultMode =
  | "NONE"
  | "EXCEPTION_THROW"
  | "NON_ERROR_THROW"
  | "INVALID_DECISION_STRING"
  | "INVALID_REASON_CODE"
  | "INVALID_SCHEMA_SHAPE"
  | "AUTHORITY_INJECTION"
  | "RULE_CONFIG_CORRUPTION"
  | "CONTEXT_CORRUPTION_ATTEMPT"
  | "OBSERVATIONAL_EVIDENCE_FAILURE"
  | "ABORT_SIGNAL_CANCELLATION"
  | "BOUNDED_TIMEOUT_DELAY"
  | "ASYNC_REJECTION";

export interface FaultInjectableReflexOptions {
  faultMode?: ReflexFaultMode;
  customError?: unknown;
  delayMs?: number;
  config?: Partial<RuleBasedReflexConfig>;
  delegateToRuleBased?: boolean;
}

export class FaultInjectableReflex implements ReflexPort {
  readonly name = "FaultInjectableReflex";
  private faultMode: ReflexFaultMode;
  private customError?: unknown;
  private delayMs: number;
  private delegate?: RuleBasedReflex;

  public activeConfig: RuleBasedReflexConfig;
  public activeConfigHash: string;
  public evaluationCount: number = 0;
  public lastEvaluatedProposal?: ActionProposal;
  public lastEvaluatedContext?: ReflexContext;

  constructor(options?: FaultInjectableReflexOptions) {
    this.faultMode = options?.faultMode ?? "NONE";
    this.customError = options?.customError;
    this.delayMs = options?.delayMs ?? 0;
    this.activeConfig = {
      failureLoop: {
        ...DEFAULT_RULE_BASED_REFLEX_CONFIG.failureLoop,
        ...options?.config?.failureLoop,
      },
      redundantAction: {
        ...DEFAULT_RULE_BASED_REFLEX_CONFIG.redundantAction,
        ...options?.config?.redundantAction,
      },
      budgetPressure: {
        ...DEFAULT_RULE_BASED_REFLEX_CONFIG.budgetPressure,
        ...options?.config?.budgetPressure,
      },
    };
    this.activeConfigHash = computeRuleBasedReflexConfigHash(this.activeConfig);
    if (options?.delegateToRuleBased !== false) {
      this.delegate = new RuleBasedReflex(this.activeConfig);
    }
  }

  setFaultMode(
    mode: ReflexFaultMode,
    options?: { customError?: unknown; delayMs?: number; configHash?: string }
  ): void {
    this.faultMode = mode;
    if (options?.customError !== undefined) {
      this.customError = options.customError;
    }
    if (options?.delayMs !== undefined) {
      this.delayMs = options.delayMs;
    }
    if (options?.configHash !== undefined) {
      this.activeConfigHash = options.configHash;
    }
  }

  getFaultMode(): ReflexFaultMode {
    return this.faultMode;
  }

  async evaluate(
    proposal: ActionProposal,
    context: ReflexContext
  ): Promise<ReflexDecision> {
    this.evaluationCount++;
    this.lastEvaluatedProposal = proposal;
    this.lastEvaluatedContext = context;

    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }

    switch (this.faultMode) {
      case "NONE": {
        if (this.delegate) {
          return await this.delegate.evaluate(proposal, context);
        }
        return Object.freeze({
          decision: "ALLOW",
          reasonCode: "NO_INTERVENTION",
          rationale: "Default allow from FaultInjectableReflex",
        });
      }

      case "EXCEPTION_THROW": {
        if (this.customError) {
          throw this.customError;
        }
        throw new ReflexExecutionError(
          "Reflex execution failed: internal unexpected evaluation exception"
        );
      }

      case "NON_ERROR_THROW": {
        throw (
          this.customError ?? "Unexpected string-based panic thrown by Reflex"
        );
      }

      case "INVALID_DECISION_STRING": {
        return {
          decision: "EXECUTE_IMMEDIATELY" as any,
          reasonCode: "NO_INTERVENTION",
        };
      }

      case "INVALID_REASON_CODE": {
        return {
          decision: "REJECT",
          reasonCode: "UNAUTHORIZED_ACCESS" as any,
        };
      }

      case "INVALID_SCHEMA_SHAPE": {
        return (this.customError !== undefined ? this.customError : null) as any;
      }

      case "AUTHORITY_INJECTION": {
        return {
          decision: "ALLOW",
          reasonCode: "NO_INTERVENTION",
          bypassGovernance: true,
          elevatedPrivileges: ["root", "admin"],
          capabilities: ["write_anywhere"],
        } as any;
      }

      case "RULE_CONFIG_CORRUPTION": {
        this.activeConfigHash =
          "corrupted-hash-0000000000000000000000000000000000000000000000000000";
        return Object.freeze({
          decision: "ALLOW",
          reasonCode: "NO_INTERVENTION",
        });
      }

      case "CONTEXT_CORRUPTION_ATTEMPT": {
        try {
          (context as any).contextHash = "tampered-hash";
          (context as any).observations = [];
        } catch {
          // Context is frozen; catch mutation failure
        }
        return Object.freeze({
          decision: "ALLOW",
          reasonCode: "NO_INTERVENTION",
        });
      }

      case "OBSERVATIONAL_EVIDENCE_FAILURE": {
        return {
          decision: "ALLOW",
          reasonCode: "NO_INTERVENTION",
          evidence: {
            ruleId: "",
            reasonCode: "INVALID_REASON" as any,
          },
        } as any;
      }

      case "ABORT_SIGNAL_CANCELLATION": {
        const abortErr = new Error("This operation was aborted");
        abortErr.name = "AbortError";
        throw abortErr;
      }

      case "BOUNDED_TIMEOUT_DELAY": {
        await new Promise((resolve) =>
          setTimeout(resolve, this.delayMs || 1000)
        );
        return Object.freeze({
          decision: "ALLOW",
          reasonCode: "NO_INTERVENTION",
        });
      }

      case "ASYNC_REJECTION": {
        return Promise.reject(
          new ReflexExecutionError("Async unhandled promise rejection in Reflex")
        );
      }

      default: {
        const _exhaustive: never = this.faultMode;
        throw new Error(`Unhandled fault mode: ${_exhaustive}`);
      }
    }
  }
}
