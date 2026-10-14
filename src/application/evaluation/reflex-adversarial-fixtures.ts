/**
 * Adversarial Reflex Fixtures and Evaluation Test Cases for Emerald Agent Fabric.
 *
 * Implements Phase 8.5: Deterministic Adversarial Fixture Suite.
 *
 * Architectural Invariants:
 * 1. Authority Monotonicity:
 *    EffectiveAuthorityAfterReflex ⊆ EffectiveAuthorityBeforeReflex.
 *    Reflex inputs/outputs can NEVER expand runtime authority, grant capabilities,
 *    substitute contracts, override leases, or inject execution credentials.
 * 2. Fail-Closed on Hostile/Malformed Input:
 *    Any adversarial, malformed, oversized, or tampered input must fail closed.
 *    Never silently clamp, repair, or rewrite hostile inputs into valid inputs.
 * 3. Secret and Credential Protection:
 *    Fixtures represent adversarial structural patterns without containing real secrets.
 * 4. Absolute Determinism:
 *    Zero randomness, zero wall-clock dependencies, zero network/model/tool calls.
 */

import { ActionProposal } from "../../domain/action-proposal.js";
import {
  ReflexContext,
  ReflexDecision,
  RuleBasedReflexConfig,
  DEFAULT_RULE_BASED_REFLEX_CONFIG,
  computeReflexContextHash,
  computeRuleBasedReflexConfigHash,
} from "../../domain/reflex.js";
import {
  ReflexEvidence,
  createReflexEvidence,
} from "../../domain/reflex-evidence.js";
import { computeCanonicalHash } from "../../domain/canonical-hash.js";

// ============================================================================
// 1. Canonical Base Factories (Known-Good Baselines)
// ============================================================================

export function createValidBaseProposal(
  overrides?: Partial<ActionProposal>
): ActionProposal {
  return {
    proposalId: "prop-adversarial-base-001",
    toolName: "read_file",
    inputPayload: { path: "src/index.ts" },
    contextSnapshotHash: "a".repeat(64),
    rationale: "Valid baseline proposal for adversarial evaluation",
    sequenceHint: 1,
    ...overrides,
  };
}

export function createValidBaseContext(
  overrides?: Partial<ReflexContext>
): ReflexContext {
  const baseRaw: ReflexContext = {
    runId: "run-adversarial-eval-001",
    taskId: "task-adversarial-001",
    stepNumber: 1,
    taskDescription: "Adversarial reliability verification",
    failureCount: 0,
    recentActionHistory: [],
    workspacePath: "/app/workspace",
    resourceUsage: {
      elapsedWallClockMs: 100,
      actionsExecuted: 1,
      stepsExecuted: 1,
      modelCallsExecuted: 1,
    },
    ...overrides,
  };

  const computedHash = computeReflexContextHash(baseRaw);
  return Object.freeze({
    ...baseRaw,
    contextHash: overrides?.contextHash ?? computedHash,
  });
}

export function createValidBaseEvidence(
  overrides?: Partial<Parameters<typeof createReflexEvidence>[0]>
): ReflexEvidence {
  const proposal = overrides?.proposal ?? createValidBaseProposal();
  const context = overrides?.context ?? createValidBaseContext();
  const decision: ReflexDecision = overrides?.decision ?? {
    decision: "ALLOW",
    reasonCode: "NO_INTERVENTION",
    rationale: "No intervention required",
  };

  return createReflexEvidence({
    runId: context.runId,
    sequenceNumber: context.stepNumber,
    proposal,
    context,
    decision,
    reflexImplementation: "RuleBasedReflex",
    ruleConfigurationHash: computeRuleBasedReflexConfigHash(
      DEFAULT_RULE_BASED_REFLEX_CONFIG
    ),
    ruleConfig: DEFAULT_RULE_BASED_REFLEX_CONFIG,
    evaluatedAt: "2026-10-14T12:00:00.000Z",
    ...overrides,
  });
}

// ============================================================================
// A. Authority Injection Fixtures
// ============================================================================

export interface AuthorityInjectionFixtures {
  readonly proposalWithCapability: Record<string, unknown>;
  readonly proposalWithContractId: Record<string, unknown>;
  readonly proposalWithWorkerId: Record<string, unknown>;
  readonly proposalWithLeaseId: Record<string, unknown>;
  readonly proposalWithIsolation: Record<string, unknown>;
  readonly proposalWithResourceLimits: Record<string, unknown>;
  readonly proposalWithCredentials: Record<string, unknown>;
  readonly contextWithCapabilities: Record<string, unknown>;
  readonly contextWithContractBinding: Record<string, unknown>;
  readonly contextWithWorkerId: Record<string, unknown>;
  readonly contextWithLeaseId: Record<string, unknown>;
  readonly contextWithIsolation: Record<string, unknown>;
  readonly contextWithSensitiveSecret: Record<string, unknown>;
  readonly decisionWithInjectedCapability: Record<string, unknown>;
  readonly decisionWithInjectedContract: Record<string, unknown>;
  readonly decisionWithInjectedWorker: Record<string, unknown>;
  readonly decisionWithInjectedResourceLimits: Record<string, unknown>;
  readonly decisionWithInjectedIsolation: Record<string, unknown>;
}

export const AUTHORITY_INJECTION_FIXTURES: AuthorityInjectionFixtures = Object.freeze({
  proposalWithCapability: Object.freeze({
    ...createValidBaseProposal(),
    capability: "SYSTEM_ADMIN",
  }),
  proposalWithContractId: Object.freeze({
    ...createValidBaseProposal(),
    contractId: "contract-elevated-root",
  }),
  proposalWithWorkerId: Object.freeze({
    ...createValidBaseProposal(),
    workerId: "worker-impersonated-007",
  }),
  proposalWithLeaseId: Object.freeze({
    ...createValidBaseProposal(),
    leaseId: "lease-forged-token",
  }),
  proposalWithIsolation: Object.freeze({
    ...createValidBaseProposal(),
    isolationLevel: "HOST_SHARED",
  }),
  proposalWithResourceLimits: Object.freeze({
    ...createValidBaseProposal(),
    resourceLimits: { timeoutMs: 99999999 },
  }),
  proposalWithCredentials: Object.freeze({
    ...createValidBaseProposal(),
    token: "mock-bearer-token-attempt",
  }),
  contextWithCapabilities: Object.freeze({
    ...createValidBaseContext(),
    capabilities: ["COMMAND_EXECUTION", "SYSTEM_MUTATION"],
  }),
  contextWithContractBinding: Object.freeze({
    ...createValidBaseContext(),
    contractBinding: { contractId: "root-contract", version: 1 },
  }),
  contextWithWorkerId: Object.freeze({
    ...createValidBaseContext(),
    workerId: "rogue-worker-id",
  }),
  contextWithLeaseId: Object.freeze({
    ...createValidBaseContext(),
    leaseId: "forged-lease-id",
  }),
  contextWithIsolation: Object.freeze({
    ...createValidBaseContext(),
    isolation: "NONE",
  }),
  contextWithSensitiveSecret: Object.freeze({
    ...createValidBaseContext(),
    apiSecret: "mock-credential-injection-payload",
  }),
  decisionWithInjectedCapability: Object.freeze({
    decision: "ALLOW",
    reasonCode: "NO_INTERVENTION",
    capability: "WORKSPACE_WRITE",
  }),
  decisionWithInjectedContract: Object.freeze({
    decision: "ALLOW",
    reasonCode: "NO_INTERVENTION",
    contractId: "contract-root-bypass",
  }),
  decisionWithInjectedWorker: Object.freeze({
    decision: "ALLOW",
    reasonCode: "NO_INTERVENTION",
    workerId: "worker-elevated",
  }),
  decisionWithInjectedResourceLimits: Object.freeze({
    decision: "ALLOW",
    reasonCode: "NO_INTERVENTION",
    resourceLimits: { timeoutMs: 3600000 },
  }),
  decisionWithInjectedIsolation: Object.freeze({
    decision: "ALLOW",
    reasonCode: "NO_INTERVENTION",
    isolationLevel: "NONE",
  }),
});

// ============================================================================
// B. Context Hash Confusion Fixtures
// ============================================================================

export interface ContextHashConfusionFixtures {
  readonly proposalSnapshotHashMismatch: {
    readonly proposal: ActionProposal;
    readonly context: ReflexContext;
  };
  readonly contextWithForgedContextHash: ReflexContext;
  readonly contextWithStaleContextHash: ReflexContext;
  readonly evidenceWithTamperedReflexContextHash: ReflexEvidence;
}

export const CONTEXT_HASH_CONFUSION_FIXTURES: ContextHashConfusionFixtures = (() => {
  const baseProposal = createValidBaseProposal({
    contextSnapshotHash: "b".repeat(64),
  });
  const baseContext = createValidBaseContext({
    contextHash: "a".repeat(64),
  });

  const forgedContext: ReflexContext = Object.freeze({
    ...createValidBaseContext(),
    contextHash: "f".repeat(64),
  });

  const oldContext = createValidBaseContext({ stepNumber: 1 });
  const staleHash = computeReflexContextHash(oldContext);
  const staleContext: ReflexContext = Object.freeze({
    ...createValidBaseContext({ stepNumber: 10, failureCount: 5 }),
    contextHash: staleHash,
  });

  const baseProposalForEvidence = createValidBaseProposal();
  const baseContextForEvidence = createValidBaseContext();
  const tamperedEvidence: ReflexEvidence = createReflexEvidence({
    runId: baseContextForEvidence.runId,
    sequenceNumber: baseContextForEvidence.stepNumber,
    proposal: baseProposalForEvidence,
    context: baseContextForEvidence,
    decision: { decision: "ALLOW", reasonCode: "NO_INTERVENTION" },
    reflexImplementation: "RuleBasedReflex",
    ruleConfigurationHash: computeRuleBasedReflexConfigHash(DEFAULT_RULE_BASED_REFLEX_CONFIG),
    reflexContextHash: "c".repeat(64),
  });

  return Object.freeze({
    proposalSnapshotHashMismatch: Object.freeze({
      proposal: baseProposal,
      context: baseContext,
    }),
    contextWithForgedContextHash: forgedContext,
    contextWithStaleContextHash: staleContext,
    evidenceWithTamperedReflexContextHash: tamperedEvidence,
  });
})();

// ============================================================================
// C. Configuration Tampering Fixtures
// ============================================================================

export interface ConfigTamperingFixtures {
  readonly thresholdTamperedConfig: RuleBasedReflexConfig;
  readonly ruleDisabledConfig: RuleBasedReflexConfig;
  readonly pressureThresholdTamperedConfig: RuleBasedReflexConfig;
  readonly evidenceWithTamperedRuleConfigHash: ReflexEvidence;
}

export const CONFIG_TAMPERING_FIXTURES: ConfigTamperingFixtures = (() => {
  const thresholdTamperedConfig: RuleBasedReflexConfig = Object.freeze({
    ...DEFAULT_RULE_BASED_REFLEX_CONFIG,
    failureLoop: Object.freeze({
      ...DEFAULT_RULE_BASED_REFLEX_CONFIG.failureLoop,
      maxRepeatedFailures: 2, // Tampered down from 3
    }),
  });

  const ruleDisabledConfig: RuleBasedReflexConfig = Object.freeze({
    ...DEFAULT_RULE_BASED_REFLEX_CONFIG,
    failureLoop: Object.freeze({
      ...DEFAULT_RULE_BASED_REFLEX_CONFIG.failureLoop,
      enabled: false,
    }),
  });

  const pressureThresholdTamperedConfig: RuleBasedReflexConfig = Object.freeze({
    ...DEFAULT_RULE_BASED_REFLEX_CONFIG,
    budgetPressure: Object.freeze({
      ...DEFAULT_RULE_BASED_REFLEX_CONFIG.budgetPressure,
      pressureThreshold: 0.5, // Tampered down from 0.8
    }),
  });

  const baseProposalForConfig = createValidBaseProposal();
  const baseContextForConfig = createValidBaseContext();
  const tamperedEvidence: ReflexEvidence = createReflexEvidence({
    runId: baseContextForConfig.runId,
    sequenceNumber: baseContextForConfig.stepNumber,
    proposal: baseProposalForConfig,
    context: baseContextForConfig,
    decision: { decision: "ALLOW", reasonCode: "NO_INTERVENTION" },
    reflexImplementation: "RuleBasedReflex",
    ruleConfigurationHash: "9".repeat(64),
  });

  return Object.freeze({
    thresholdTamperedConfig,
    ruleDisabledConfig,
    pressureThresholdTamperedConfig,
    evidenceWithTamperedRuleConfigHash: tamperedEvidence,
  });
})();

// ============================================================================
// D. Stale Observation Fixtures
// ============================================================================

export interface StaleObservationFixtures {
  readonly contextWithAncientActionHistory: ReflexContext;
  readonly contextWithInterleavedStaleSteps: ReflexContext;
  readonly contextWithMismatchedHistoricalContextHash: ReflexContext;
}

export const STALE_OBSERVATION_FIXTURES: StaleObservationFixtures = (() => {
  const ancientContext = createValidBaseContext({
    stepNumber: 50,
    recentActionHistory: [
      {
        toolName: "read_file",
        status: "FAILED",
        sequenceNumber: 1, // Step 1 when current is 50
        inputHash: computeCanonicalHash({ path: "src/index.ts" }).contentHash,
        contextHash: "1".repeat(64),
      },
      {
        toolName: "read_file",
        status: "FAILED",
        sequenceNumber: 2,
        inputHash: computeCanonicalHash({ path: "src/index.ts" }).contentHash,
        contextHash: "1".repeat(64),
      },
      {
        toolName: "read_file",
        status: "FAILED",
        sequenceNumber: 3,
        inputHash: computeCanonicalHash({ path: "src/index.ts" }).contentHash,
        contextHash: "1".repeat(64),
      },
    ],
  });

  const mismatchedHistoryContext = createValidBaseContext({
    stepNumber: 4,
    recentActionHistory: [
      {
        toolName: "read_file",
        status: "FAILED",
        sequenceNumber: 1,
        inputHash: computeCanonicalHash({ path: "src/index.ts" }).contentHash,
        contextHash: "1".repeat(64), // Older context snapshot hash
      },
      {
        toolName: "read_file",
        status: "FAILED",
        sequenceNumber: 2,
        inputHash: computeCanonicalHash({ path: "src/index.ts" }).contentHash,
        contextHash: "1".repeat(64),
      },
      {
        toolName: "read_file",
        status: "FAILED",
        sequenceNumber: 3,
        inputHash: computeCanonicalHash({ path: "src/index.ts" }).contentHash,
        contextHash: "2".repeat(64), // State changed here!
      },
    ],
  });

  return Object.freeze({
    contextWithAncientActionHistory: ancientContext,
    contextWithInterleavedStaleSteps: ancientContext,
    contextWithMismatchedHistoricalContextHash: mismatchedHistoryContext,
  });
})();

// ============================================================================
// E. Conflicting Observation Fixtures
// ============================================================================

export interface ConflictingObservationFixtures {
  readonly successFollowedByFailure: ReflexContext;
  readonly failureFollowedBySuccess: ReflexContext;
  readonly alternatingToolsHistory: ReflexContext;
  readonly sameToolAlternatingInputs: ReflexContext;
}

export const CONFLICTING_OBSERVATION_FIXTURES: ConflictingObservationFixtures = (() => {
  const inputA = computeCanonicalHash({ path: "src/a.ts" }).contentHash;
  const inputB = computeCanonicalHash({ path: "src/b.ts" }).contentHash;
  const stateHash = "a".repeat(64);

  const successFollowedByFailure = createValidBaseContext({
    stepNumber: 3,
    recentActionHistory: [
      {
        toolName: "read_file",
        status: "SUCCEEDED",
        sequenceNumber: 1,
        inputHash: inputA,
        contextHash: stateHash,
      },
      {
        toolName: "read_file",
        status: "FAILED",
        sequenceNumber: 2,
        inputHash: inputA,
        contextHash: stateHash,
      },
    ],
  });

  const failureFollowedBySuccess = createValidBaseContext({
    stepNumber: 4,
    recentActionHistory: [
      {
        toolName: "read_file",
        status: "FAILED",
        sequenceNumber: 1,
        inputHash: inputA,
        contextHash: stateHash,
      },
      {
        toolName: "read_file",
        status: "FAILED",
        sequenceNumber: 2,
        inputHash: inputA,
        contextHash: stateHash,
      },
      {
        toolName: "read_file",
        status: "SUCCEEDED", // Clears the failure streak!
        sequenceNumber: 3,
        inputHash: inputA,
        contextHash: stateHash,
      },
    ],
  });

  const alternatingToolsHistory = createValidBaseContext({
    stepNumber: 4,
    recentActionHistory: [
      {
        toolName: "read_file",
        status: "FAILED",
        sequenceNumber: 1,
        inputHash: inputA,
        contextHash: stateHash,
      },
      {
        toolName: "write_file",
        status: "SUCCEEDED",
        sequenceNumber: 2,
        inputHash: inputB,
        contextHash: stateHash,
      },
      {
        toolName: "read_file",
        status: "FAILED",
        sequenceNumber: 3,
        inputHash: inputA,
        contextHash: stateHash,
      },
    ],
  });

  const sameToolAlternatingInputs = createValidBaseContext({
    stepNumber: 4,
    recentActionHistory: [
      {
        toolName: "read_file",
        status: "FAILED",
        sequenceNumber: 1,
        inputHash: inputA,
        contextHash: stateHash,
      },
      {
        toolName: "read_file",
        status: "FAILED",
        sequenceNumber: 2,
        inputHash: inputB, // Different input
        contextHash: stateHash,
      },
      {
        toolName: "read_file",
        status: "FAILED",
        sequenceNumber: 3,
        inputHash: inputA,
        contextHash: stateHash,
      },
    ],
  });

  return Object.freeze({
    successFollowedByFailure,
    failureFollowedBySuccess,
    alternatingToolsHistory,
    sameToolAlternatingInputs,
  });
})();

// ============================================================================
// F. UNKNOWN Execution State Fixtures
// ============================================================================

export interface UnknownExecutionStateFixtures {
  readonly singleUnknownHistory: ReflexContext;
  readonly threeUnknownFailuresHistory: ReflexContext;
  readonly mixedFailedAndUnknownHistory: ReflexContext;
  readonly unknownFollowedBySuccess: ReflexContext;
}

export const UNKNOWN_EXECUTION_STATE_FIXTURES: UnknownExecutionStateFixtures = (() => {
  const inputHash = computeCanonicalHash({ path: "src/index.ts" }).contentHash;
  const stateHash = "a".repeat(64);

  const singleUnknown = createValidBaseContext({
    stepNumber: 2,
    recentActionHistory: [
      {
        toolName: "read_file",
        status: "UNKNOWN",
        sequenceNumber: 1,
        inputHash,
        contextHash: stateHash,
        failureReason: "EXECUTION_TIMEOUT_OR_CRASH",
      },
    ],
  });

  const threeUnknowns = createValidBaseContext({
    stepNumber: 4,
    recentActionHistory: [
      {
        toolName: "read_file",
        status: "UNKNOWN",
        sequenceNumber: 1,
        inputHash,
        contextHash: stateHash,
      },
      {
        toolName: "read_file",
        status: "UNKNOWN",
        sequenceNumber: 2,
        inputHash,
        contextHash: stateHash,
      },
      {
        toolName: "read_file",
        status: "UNKNOWN",
        sequenceNumber: 3,
        inputHash,
        contextHash: stateHash,
      },
    ],
  });

  const mixedHistory = createValidBaseContext({
    stepNumber: 4,
    recentActionHistory: [
      {
        toolName: "read_file",
        status: "FAILED",
        sequenceNumber: 1,
        inputHash,
        contextHash: stateHash,
      },
      {
        toolName: "read_file",
        status: "UNKNOWN",
        sequenceNumber: 2,
        inputHash,
        contextHash: stateHash,
      },
      {
        toolName: "read_file",
        status: "TIMED_OUT",
        sequenceNumber: 3,
        inputHash,
        contextHash: stateHash,
      },
    ],
  });

  const unknownThenSuccess = createValidBaseContext({
    stepNumber: 3,
    recentActionHistory: [
      {
        toolName: "read_file",
        status: "UNKNOWN",
        sequenceNumber: 1,
        inputHash,
        contextHash: stateHash,
      },
      {
        toolName: "read_file",
        status: "SUCCEEDED",
        sequenceNumber: 2,
        inputHash,
        contextHash: stateHash,
      },
    ],
  });

  return Object.freeze({
    singleUnknownHistory: singleUnknown,
    threeUnknownFailuresHistory: threeUnknowns,
    mixedFailedAndUnknownHistory: mixedHistory,
    unknownFollowedBySuccess: unknownThenSuccess,
  });
})();

// ============================================================================
// G. Repeated Failure Ambiguity Fixtures
// ============================================================================

export interface RepeatedFailureAmbiguityFixtures {
  readonly threeIdenticalFailures: ReflexContext;
  readonly twoIdenticalFailuresSubThreshold: ReflexContext;
  readonly threeDifferentInputFailures: ReflexContext;
  readonly failuresInterruptedBySuccess: ReflexContext;
  readonly failuresWithStateChange: ReflexContext;
}

export const REPEATED_FAILURE_AMBIGUITY_FIXTURES: RepeatedFailureAmbiguityFixtures = (() => {
  const inputA = computeCanonicalHash({ path: "src/index.ts" }).contentHash;
  const inputB = computeCanonicalHash({ path: "src/other.ts" }).contentHash;
  const stateHash1 = "a".repeat(64);
  const stateHash2 = "b".repeat(64);

  const threeIdentical = createValidBaseContext({
    stepNumber: 4,
    recentActionHistory: [
      { toolName: "read_file", status: "FAILED", inputHash: inputA, contextHash: stateHash1 },
      { toolName: "read_file", status: "FAILED", inputHash: inputA, contextHash: stateHash1 },
      { toolName: "read_file", status: "FAILED", inputHash: inputA, contextHash: stateHash1 },
    ],
  });

  const twoSubThreshold = createValidBaseContext({
    stepNumber: 3,
    recentActionHistory: [
      { toolName: "read_file", status: "FAILED", inputHash: inputA, contextHash: stateHash1 },
      { toolName: "read_file", status: "FAILED", inputHash: inputA, contextHash: stateHash1 },
    ],
  });

  const threeDiffInputs = createValidBaseContext({
    stepNumber: 4,
    recentActionHistory: [
      { toolName: "read_file", status: "FAILED", inputHash: inputA, contextHash: stateHash1 },
      { toolName: "read_file", status: "FAILED", inputHash: inputB, contextHash: stateHash1 },
      { toolName: "read_file", status: "FAILED", inputHash: inputA, contextHash: stateHash1 },
    ],
  });

  const interrupted = createValidBaseContext({
    stepNumber: 5,
    recentActionHistory: [
      { toolName: "read_file", status: "FAILED", inputHash: inputA, contextHash: stateHash1 },
      { toolName: "read_file", status: "FAILED", inputHash: inputA, contextHash: stateHash1 },
      { toolName: "read_file", status: "SUCCEEDED", inputHash: inputA, contextHash: stateHash1 },
      { toolName: "read_file", status: "FAILED", inputHash: inputA, contextHash: stateHash1 },
    ],
  });

  const withStateChange = createValidBaseContext({
    stepNumber: 4,
    recentActionHistory: [
      { toolName: "read_file", status: "FAILED", inputHash: inputA, contextHash: stateHash1 },
      { toolName: "read_file", status: "FAILED", inputHash: inputA, contextHash: stateHash1 },
      { toolName: "read_file", status: "FAILED", inputHash: inputA, contextHash: stateHash2 },
    ],
  });

  return Object.freeze({
    threeIdenticalFailures: threeIdentical,
    twoIdenticalFailuresSubThreshold: twoSubThreshold,
    threeDifferentInputFailures: threeDiffInputs,
    failuresInterruptedBySuccess: interrupted,
    failuresWithStateChange: withStateChange,
  });
})();

// ============================================================================
// H. Redundancy Ambiguity Fixtures
// ============================================================================

export interface RedundancyAmbiguityFixtures {
  readonly identicalActionsUnchangedState: ReflexContext;
  readonly identicalActionsInterruptedByWrite: ReflexContext;
  readonly identicalActionsWithContextChange: ReflexContext;
  readonly sameToolDifferentInputs: ReflexContext;
}

export const REDUNDANCY_AMBIGUITY_FIXTURES: RedundancyAmbiguityFixtures = (() => {
  const inputA = computeCanonicalHash({ path: "src/index.ts" }).contentHash;
  const inputB = computeCanonicalHash({ path: "src/other.ts" }).contentHash;
  const stateHash1 = "a".repeat(64);
  const stateHash2 = "b".repeat(64);

  const identicalUnchanged = createValidBaseContext({
    stepNumber: 4,
    recentActionHistory: [
      { toolName: "read_file", status: "SUCCEEDED", inputHash: inputA, contextHash: stateHash1 },
      { toolName: "read_file", status: "SUCCEEDED", inputHash: inputA, contextHash: stateHash1 },
      { toolName: "read_file", status: "SUCCEEDED", inputHash: inputA, contextHash: stateHash1 },
    ],
  });

  const interruptedByWrite = createValidBaseContext({
    stepNumber: 4,
    recentActionHistory: [
      { toolName: "read_file", status: "SUCCEEDED", inputHash: inputA, contextHash: stateHash1 },
      { toolName: "read_file", status: "SUCCEEDED", inputHash: inputA, contextHash: stateHash1 },
      {
        toolName: "write_file", // Modifying tool that succeeded!
        status: "SUCCEEDED",
        inputHash: computeCanonicalHash({ path: "src/index.ts", content: "new" }).contentHash,
        contextHash: stateHash1,
      },
    ],
  });

  const withContextChange = createValidBaseContext({
    stepNumber: 4,
    recentActionHistory: [
      { toolName: "read_file", status: "SUCCEEDED", inputHash: inputA, contextHash: stateHash1 },
      { toolName: "read_file", status: "SUCCEEDED", inputHash: inputA, contextHash: stateHash1 },
      { toolName: "read_file", status: "SUCCEEDED", inputHash: inputA, contextHash: stateHash2 },
    ],
  });

  const diffInputs = createValidBaseContext({
    stepNumber: 4,
    recentActionHistory: [
      { toolName: "read_file", status: "SUCCEEDED", inputHash: inputA, contextHash: stateHash1 },
      { toolName: "read_file", status: "SUCCEEDED", inputHash: inputB, contextHash: stateHash1 },
      { toolName: "read_file", status: "SUCCEEDED", inputHash: inputA, contextHash: stateHash1 },
    ],
  });

  return Object.freeze({
    identicalActionsUnchangedState: identicalUnchanged,
    identicalActionsInterruptedByWrite: interruptedByWrite,
    identicalActionsWithContextChange: withContextChange,
    sameToolDifferentInputs: diffInputs,
  });
})();

// ============================================================================
// I. Budget Boundary Fixtures (Threshold = 0.8)
// ============================================================================

export interface BudgetBoundaryFixtures {
  readonly config: RuleBasedReflexConfig;
  readonly contextRatioZero: ReflexContext;
  readonly contextRatioBelowThreshold: ReflexContext;
  readonly contextRatioExactThreshold: ReflexContext;
  readonly contextRatioAboveThreshold: ReflexContext;
  readonly contextRatioFull: ReflexContext;
}

export const BUDGET_BOUNDARY_FIXTURES: BudgetBoundaryFixtures = (() => {
  const config: RuleBasedReflexConfig = Object.freeze({
    ...DEFAULT_RULE_BASED_REFLEX_CONFIG,
    budgetPressure: Object.freeze({
      enabled: true,
      pressureThreshold: 0.8,
      maxSteps: 10,
      decisionOnTrigger: "DEFER",
    }),
  });

  return Object.freeze({
    config,
    contextRatioZero: createValidBaseContext({
      stepNumber: 1,
      resourceUsage: { stepsExecuted: 0 },
    }),
    contextRatioBelowThreshold: createValidBaseContext({
      stepNumber: 7, // 7 / 10 = 0.70 < 0.80
      resourceUsage: { stepsExecuted: 7 },
    }),
    contextRatioExactThreshold: createValidBaseContext({
      stepNumber: 8, // 8 / 10 = 0.80 == 0.80
      resourceUsage: { stepsExecuted: 8 },
    }),
    contextRatioAboveThreshold: createValidBaseContext({
      stepNumber: 9, // 9 / 10 = 0.90 > 0.80
      resourceUsage: { stepsExecuted: 9 },
    }),
    contextRatioFull: createValidBaseContext({
      stepNumber: 10, // 10 / 10 = 1.00 >= 0.80
      resourceUsage: { stepsExecuted: 10 },
    }),
  });
})();

// ============================================================================
// J. Malformed Evidence Fixtures
// ============================================================================

export interface MalformedEvidenceFixtures {
  readonly missingReplayInput: Record<string, unknown>;
  readonly missingDecision: Record<string, unknown>;
  readonly wrongTypeSequenceNumber: Record<string, unknown>;
  readonly invalidHexHash: Record<string, unknown>;
  readonly invalidReasonCode: Record<string, unknown>;
  readonly invalidRuleId: Record<string, unknown>;
  readonly oversizedEvidenceJson: string;
  readonly unexpectedAuthorityInEvidence: Record<string, unknown>;
  readonly credentialInEvidence: Record<string, unknown>;
}

export const MALFORMED_EVIDENCE_FIXTURES: MalformedEvidenceFixtures = (() => {
  const valid = createValidBaseEvidence();

  const { replayInput: _, ...withoutReplayInput } = valid;
  const { decision: __, ...withoutDecision } = valid;

  const wrongTypeSeq = {
    ...valid,
    sequenceNumber: "sequence-one",
  };

  const invalidHex = {
    ...valid,
    evidenceIdentityHash: "not-a-valid-64-char-hex-hash",
  };

  const invalidReason = {
    ...valid,
    reasonCode: "FORGED_UNAUTHORIZED_ALLOW",
  };

  const invalidRule = {
    ...valid,
    triggeredRuleId: "reflex.root-bypass-override.v1",
  };

  const unexpectedAuth = {
    ...valid,
    contractBinding: { contractId: "elevated-contract" },
  };

  const credInEvidence = {
    ...valid,
    bearerToken: "mock-token-leak-in-evidence",
  };

  // Generate oversized JSON exceeding 65536 bytes
  const largeRationale = "X".repeat(70000);
  const oversizedJson = JSON.stringify({
    ...valid,
    rationale: largeRationale,
  });

  return Object.freeze({
    missingReplayInput: Object.freeze(withoutReplayInput),
    missingDecision: Object.freeze(withoutDecision),
    wrongTypeSequenceNumber: Object.freeze(wrongTypeSeq),
    invalidHexHash: Object.freeze(invalidHex),
    invalidReasonCode: Object.freeze(invalidReason),
    invalidRuleId: Object.freeze(invalidRule),
    oversizedEvidenceJson: oversizedJson,
    unexpectedAuthorityInEvidence: Object.freeze(unexpectedAuth),
    credentialInEvidence: Object.freeze(credInEvidence),
  });
})();
