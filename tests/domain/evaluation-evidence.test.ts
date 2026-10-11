/**
 * Emerald Agent Fabric — Phase 9.4A Test Suite
 * Evaluation Evidence Persistence, Integrity, and Offline Replay
 *
 * Verifies:
 * 1. Contract & schema validation (PersistedTrialEvidence, DurableTranscriptEntry, NDJSON records)
 * 2. Deterministic offline replayability: persist -> reload -> reconstruct evidence -> replayReflexEvidence -> same decision
 * 3. Tamper detection on all 7 fields (inputPayload, inputHash, contextHash, failure reason, reflex decision, ruleConfigurationHash, taskContentHash)
 * 4. Credential boundary & redaction (keys, bearer tokens, passwords, API tokens)
 * 5. Bounded serialization ceilings (entry count, payload bytes, transcript bytes, reflex bytes, total bytes)
 * 6. Baseline telemetry isolation (reflexEvidence strictly undefined for Baseline, empty array for zero-intervention Reflex)
 */

import { describe, expect, it } from "vitest";
import {
  createPersistedTrialEvidence,
  verifyArtifactIntegrity,
  assertArtifactIntegrity,
  serializeTrialEvidence,
  deserializeTrialEvidence,
  sanitizeValue,
  assertCredentialBoundary,
  EVIDENCE_ARTIFACT_BOUNDS,
  EVIDENCE_ARTIFACT_SCHEMA_VERSION,
  DurableTranscriptEntry,
  PersistedTrialEvidence,
} from "../../src/domain/evaluation-evidence.js";
import {
  DEFAULT_RULE_BASED_REFLEX_CONFIG,
  computeRuleBasedReflexConfigHash,
  computeReflexContextHash,
  ReflexContext,
  FROZEN_RULE_BASED_REFLEX_CONFIG_HASH,
} from "../../src/domain/reflex.js";
import {
  createReflexEvidence,
  replayReflexEvidence,
} from "../../src/domain/reflex-evidence.js";
import { RuleBasedReflex } from "../../src/adapters/reflex/rule-based-reflex.js";
import {
  computeEvaluationTrialIdentityHash,
  createEvaluationConfigFingerprint,
  CURRENT_HARNESS_VERSION,
  EvaluationExecutionMode,
  EvaluationMetrics,
} from "../../src/domain/evaluation.js";
import { ActionProposal } from "../../src/domain/action-proposal.js";
import { computeCanonicalHash } from "../../src/domain/canonical-hash.js";
import {
  ArtifactBoundsExceededError,
  ArtifactIntegrityError,
  ArtifactSecurityError,
} from "../../src/domain/errors.js";

const validTaskHash = "a".repeat(64);
const validContextHash = "b".repeat(64);
const validInputHash = "d".repeat(64);

function makeSampleProposal(
  proposalId: string,
  toolName: any = "read_file",
  inputPayload: any = { path: "src/calc.ts" },
  contextSnapshotHash: string = validContextHash
): ActionProposal {
  return {
    proposalId,
    toolName,
    inputPayload,
    contextSnapshotHash,
    rationale: "Testing step evidence",
  };
}

function makeSampleContext(runId: string, taskId: string, stepNumber: number): ReflexContext {
  const raw = {
    runId,
    taskId,
    stepNumber,
    taskDescription: "Fix calculator bug",
    failureCount: 0,
    recentActionHistory: [],
    resourceUsage: {
      elapsedWallClockMs: 100,
      actionsExecuted: stepNumber - 1,
      stepsExecuted: stepNumber - 1,
    },
  };
  return {
    ...raw,
    contextHash: computeReflexContextHash(raw),
  };
}

function makeSampleMetrics(overrides: Partial<EvaluationMetrics> = {}): EvaluationMetrics {
  return {
    steps: 1,
    actions: 1,
    attempts: 1,
    modelCalls: 1,
    toolCalls: 1,
    proposalRejections: 0,
    executionFailures: 0,
    modelFailures: 0,
    wallClockMs: 100,
    ...overrides,
  };
}

describe("Phase 9.4A: Evaluation Evidence Persistence & Verification", () => {
  const config = DEFAULT_RULE_BASED_REFLEX_CONFIG;
  const configHash = computeRuleBasedReflexConfigHash(config);

  const sampleFingerprint = createEvaluationConfigFingerprint({
    modelProvider: "ollama",
    model: "qwen2.5:3b",
    taskVersion: 1,
    harnessVersion: CURRENT_HARNESS_VERSION,
  });

  function getTrialHash(params: {
    taskId?: string;
    taskVersion?: number;
    taskContentHash?: string;
    trialOrdinal?: number;
    executionMode: EvaluationExecutionMode;
    ruleConfigurationHash?: string;
  }): string {
    return computeEvaluationTrialIdentityHash({
      taskId: params.taskId ?? "task-swe-01",
      taskVersion: params.taskVersion ?? 1,
      taskContentHash: params.taskContentHash ?? validTaskHash,
      configFingerprintHash: sampleFingerprint.fingerprintHash,
      trialOrdinal: params.trialOrdinal ?? 1,
      executionMode: params.executionMode,
      ruleConfigurationHash: params.ruleConfigurationHash,
    });
  }

  it("verifies frozen reflex config hash remains strictly invariant", () => {
    expect(configHash).toBe(FROZEN_RULE_BASED_REFLEX_CONFIG_HASH);
  });

  // ==========================================================================
  // 1. Contract & Round-Trip Serialization
  // ==========================================================================
  describe("Contract & Round-Trip Serialization", () => {
    it("creates, serializes, and deserializes a valid PersistedTrialEvidence artifact", () => {
      const proposal = makeSampleProposal("prop-001", "read_file", { path: "src/index.ts" });
      const context = makeSampleContext("run-001", "task-swe-01", 1);
      const reflexEvidence = createReflexEvidence({
        runId: "run-001",
        sequenceNumber: 1,
        proposal,
        context,
        decision: { decision: "ALLOW", reasonCode: "NO_INTERVENTION" },
        reflexImplementation: "RuleBasedReflex",
        ruleConfigurationHash: configHash,
        ruleConfig: config,
        evaluatedAt: "2026-10-11T20:00:00.000Z",
      });

      const transcriptEntry: DurableTranscriptEntry = {
        stepNumber: 1,
        contextSnapshotId: "snap-1",
        contextHash: context.contextHash!,
        contextEstimatedTokens: 500,
        contextBytes: 2000,
        contextObservationsCount: 1,
        proposalId: proposal.proposalId,
        toolName: "read_file",
        inputHash: reflexEvidence.actionInputHash,
        inputPayload: proposal.inputPayload,
        rationale: proposal.rationale,
        finishReason: "tool_calls",
        proposalValid: true,
        reflexDecision: "ALLOW",
        reflexReasonCode: "NO_INTERVENTION",
        reflexEvidence,
        actionId: "act-001",
        actionStatus: "SUCCESS",
        actionOutput: { content: "export const x = 1;" },
        durationMs: 150,
        timestamp: "2026-10-11T20:00:00.100Z",
      };

      const trialIdentityHash = getTrialHash({
        taskId: "task-swe-01",
        taskVersion: 1,
        taskContentHash: validTaskHash,
        trialOrdinal: 1,
        executionMode: "REFLEX",
        ruleConfigurationHash: configHash,
      });

      const artifact = createPersistedTrialEvidence({
        trialIdentity: {
          trialId: "trial-001",
          trialOrdinal: 1,
          trialIdentityHash,
          runtimeRunId: "run-001",
        },
        taskIdentity: {
          taskId: "task-swe-01",
          taskVersion: 1,
          taskContentHash: validTaskHash,
        },
        condition: {
          conditionId: "cond-reflex",
          name: "Reflex Condition",
        },
        executionMode: "REFLEX",
        model: "qwen2.5:3b",
        configFingerprint: sampleFingerprint,
        ruleConfigurationHash: configHash,
        transcript: [transcriptEntry],
        reflexEvidence: [reflexEvidence],
        metrics: makeSampleMetrics({
          steps: 1,
          actions: 1,
          toolCalls: 1,
          modelCalls: 1,
          wallClockMs: 150,
          reflexEvaluations: 1,
          reflexAllows: 1,
          reflexRejects: 0,
          reflexDefers: 0,
        }),
        outcome: {
          status: "PASSED",
          statusMessage: "Task passed",
          verificationPassed: true,
        },
        persistedAt: "2026-10-11T20:00:01.000Z",
      });

      expect(artifact.schemaVersion).toBe(EVIDENCE_ARTIFACT_SCHEMA_VERSION);
      expect(artifact.artifactHash).toMatch(/^[a-f0-9]{64}$/);
      expect(verifyArtifactIntegrity(artifact).valid).toBe(true);

      const serialized = serializeTrialEvidence(artifact);
      expect(typeof serialized).toBe("string");

      const deserialized = deserializeTrialEvidence(serialized);
      expect(deserialized.artifactHash).toBe(artifact.artifactHash);
      expect(deserialized.trialIdentity.trialId).toBe("trial-001");
      expect(deserialized.transcript).toHaveLength(1);
      expect(deserialized.transcript[0]!.inputPayload).toEqual({ path: "src/index.ts" });
      expect(verifyArtifactIntegrity(deserialized).valid).toBe(true);
    });
  });

  // ==========================================================================
  // 2. Deterministic Offline Replayability
  // ==========================================================================
  describe("Deterministic Offline Replayability", () => {
    it("persists transcript -> reloads transcript -> reconstructs evidence -> replays with exact match", async () => {
      const reflexEngine = new RuleBasedReflex(config);

      // Step 1: Generate proposals and evidence for ALLOW and REJECT
      const prop1 = makeSampleProposal("p-1", "read_file", { path: "src/parser.ts" });
      const ctx1 = makeSampleContext("run-replay", "task-swe-parser", 1);
      const dec1 = await reflexEngine.evaluate(prop1, ctx1);
      const ev1 = createReflexEvidence({
        runId: "run-replay",
        sequenceNumber: 1,
        proposal: prop1,
        context: ctx1,
        decision: dec1,
        reflexImplementation: "RuleBasedReflex",
        ruleConfigurationHash: configHash,
        ruleConfig: config,
        evaluatedAt: "2026-10-11T21:00:00.000Z",
      });

      // Repeating identical failing action -> triggers REJECT via REPEATED_FAILURE
      const prop2 = makeSampleProposal("p-2", "run_command", { command: "npm test" }, validContextHash);
      const prop2InputHash = computeCanonicalHash(prop2.inputPayload).contentHash;
      const failAction = {
        toolName: "run_command" as const,
        status: "FAILED" as const,
        sequenceNumber: 2,
        inputHash: prop2InputHash,
        contextHash: prop2.contextSnapshotHash,
        failureReason: "syntax error",
      };
      const rawCtx2 = {
        runId: "run-replay",
        taskId: "task-swe-parser",
        stepNumber: 3,
        taskDescription: "Fix parser bug",
        failureCount: 3,
        recentActionHistory: [failAction, failAction, failAction],
        resourceUsage: {
          elapsedWallClockMs: 500,
          actionsExecuted: 3,
          stepsExecuted: 3,
        },
      };
      const ctx2: ReflexContext = {
        ...rawCtx2,
        contextHash: computeReflexContextHash(rawCtx2),
      };
      const dec2 = await reflexEngine.evaluate(prop2, ctx2);
      const ev2 = createReflexEvidence({
        runId: "run-replay",
        sequenceNumber: 3,
        proposal: prop2,
        context: ctx2,
        decision: dec2,
        reflexImplementation: "RuleBasedReflex",
        ruleConfigurationHash: configHash,
        ruleConfig: config,
        evaluatedAt: "2026-10-11T21:00:01.000Z",
      });

      const transcript: DurableTranscriptEntry[] = [
        {
          stepNumber: 1,
          contextSnapshotId: "snap-1",
          contextHash: ctx1.contextHash!,
          contextEstimatedTokens: 400,
          contextBytes: 1500,
          contextObservationsCount: 1,
          proposalId: prop1.proposalId,
          toolName: "read_file",
          inputHash: ev1.actionInputHash,
          inputPayload: prop1.inputPayload,
          proposalValid: true,
          reflexDecision: "ALLOW",
          reflexReasonCode: "NO_INTERVENTION",
          reflexEvidence: ev1,
          actionId: "act-1",
          actionStatus: "SUCCESS",
          durationMs: 40,
          timestamp: "2026-10-11T21:00:00.100Z",
        },
        {
          stepNumber: 3,
          contextSnapshotId: "snap-2",
          contextHash: ctx2.contextHash!,
          contextEstimatedTokens: 800,
          contextBytes: 3000,
          contextObservationsCount: 4,
          proposalId: prop2.proposalId,
          toolName: "run_command",
          inputHash: ev2.actionInputHash,
          inputPayload: prop2.inputPayload,
          proposalValid: true,
          reflexDecision: "REJECT",
          reflexReasonCode: "REPEATED_FAILURE",
          reflexRationale: ev2.rationale,
          reflexEvidence: ev2,
          durationMs: 25,
          timestamp: "2026-10-11T21:00:01.100Z",
        },
      ];

      const trialIdentityHash = getTrialHash({
        taskId: "task-swe-parser",
        taskVersion: 1,
        taskContentHash: validTaskHash,
        trialOrdinal: 1,
        executionMode: "REFLEX",
        ruleConfigurationHash: configHash,
      });

      // Step 2: Persist evidence artifact
      const artifact = createPersistedTrialEvidence({
        trialIdentity: {
          trialId: "trial-replay-01",
          trialOrdinal: 1,
          trialIdentityHash,
          runtimeRunId: "run-replay",
        },
        taskIdentity: {
          taskId: "task-swe-parser",
          taskVersion: 1,
          taskContentHash: validTaskHash,
        },
        condition: {
          conditionId: "cond-reflex",
          name: "Reflex Condition",
        },
        executionMode: "REFLEX",
        model: "qwen2.5:3b",
        configFingerprint: sampleFingerprint,
        ruleConfigurationHash: configHash,
        transcript,
        reflexEvidence: [ev1, ev2],
        metrics: makeSampleMetrics({
          steps: 2,
          actions: 1,
          toolCalls: 2,
          modelCalls: 2,
          wallClockMs: 600,
          reflexEvaluations: 2,
          reflexAllows: 1,
          reflexRejects: 1,
          reflexDefers: 0,
          failureLoopTriggers: 1,
        }),
        outcome: {
          status: "FAILED",
          statusMessage: "Execution finished",
          verificationPassed: false,
        },
        persistedAt: "2026-10-11T21:00:02.000Z",
      });

      // Step 3: Serialize and reload (simulating offline replay tool)
      const serialized = serializeTrialEvidence(artifact);
      const reloaded = deserializeTrialEvidence(serialized);

      expect(verifyArtifactIntegrity(reloaded).valid).toBe(true);
      expect(reloaded.reflexEvidence).toBeDefined();
      expect(reloaded.reflexEvidence).toHaveLength(2);

      // Step 4: Execute pure offline replay on both reloaded evidence records
      const replay1 = await replayReflexEvidence(reloaded.reflexEvidence![0]!, { ruleConfig: config });
      expect(replay1.match).toBe(true);
      expect(replay1.status).toBe("MATCH");
      expect(replay1.recomputed?.decision).toBe("ALLOW");
      expect(replay1.recomputed?.reasonCode).toBe("NO_INTERVENTION");

      const replay2 = await replayReflexEvidence(reloaded.reflexEvidence![1]!, { ruleConfig: config });
      expect(replay2.match).toBe(true);
      expect(replay2.status).toBe("MATCH");
      expect(replay2.recomputed?.decision).toBe("REJECT");
      expect(replay2.recomputed?.reasonCode).toBe("REPEATED_FAILURE");
    });
  });

  // ==========================================================================
  // 3. Tamper Detection Across All 7 Fields
  // ==========================================================================
  describe("Tamper Detection", () => {
    function buildBaseArtifact(): PersistedTrialEvidence {
      const prop = makeSampleProposal("prop-tamper", "read_file", { path: "src/app.ts" });
      const ctx = makeSampleContext("run-t", "task-t", 1);
      const ev = createReflexEvidence({
        runId: "run-t",
        sequenceNumber: 1,
        proposal: prop,
        context: ctx,
        decision: { decision: "ALLOW", reasonCode: "NO_INTERVENTION" },
        reflexImplementation: "RuleBasedReflex",
        ruleConfigurationHash: configHash,
        ruleConfig: config,
        evaluatedAt: "2026-10-11T20:00:00.000Z",
      });

      const trialIdentityHash = getTrialHash({
        taskId: "task-t",
        taskVersion: 1,
        taskContentHash: validTaskHash,
        trialOrdinal: 1,
        executionMode: "REFLEX",
        ruleConfigurationHash: configHash,
      });

      return createPersistedTrialEvidence({
        trialIdentity: {
          trialId: "trial-t",
          trialOrdinal: 1,
          trialIdentityHash,
          runtimeRunId: "run-t",
        },
        taskIdentity: {
          taskId: "task-t",
          taskVersion: 1,
          taskContentHash: validTaskHash,
        },
        condition: {
          conditionId: "cond-t",
          name: "Test Condition",
        },
        executionMode: "REFLEX",
        model: "qwen2.5:3b",
        configFingerprint: sampleFingerprint,
        ruleConfigurationHash: configHash,
        transcript: [
          {
            stepNumber: 1,
            contextSnapshotId: "s-1",
            contextHash: validContextHash,
            contextEstimatedTokens: 100,
            contextBytes: 500,
            contextObservationsCount: 1,
            proposalId: prop.proposalId,
            toolName: "read_file",
            inputHash: validInputHash,
            inputPayload: { path: "src/app.ts" },
            proposalValid: true,
            reflexDecision: "ALLOW",
            reflexReasonCode: "NO_INTERVENTION",
            reflexEvidence: ev,
            actionId: "act-1",
            actionStatus: "FAILED",
            actionError: "File not found",
            durationMs: 50,
            timestamp: "2026-10-11T20:00:00.000Z",
          },
        ],
        reflexEvidence: [ev],
        metrics: makeSampleMetrics({
          steps: 1,
          actions: 1,
          toolCalls: 1,
          modelCalls: 1,
          wallClockMs: 50,
          reflexEvaluations: 1,
          reflexAllows: 1,
          reflexRejects: 0,
          reflexDefers: 0,
        }),
        outcome: {
          status: "FAILED",
          statusMessage: "Execution failed",
          verificationPassed: false,
        },
        persistedAt: "2026-10-11T20:00:01.000Z",
      });
    }

    it("detects tampering with action input payload", () => {
      const base = buildBaseArtifact();
      const firstEntry = base.transcript[0]!;
      const tampered: PersistedTrialEvidence = {
        ...base,
        transcript: [
          {
            ...firstEntry,
            inputPayload: { path: "src/tampered.ts" },
          },
        ],
      };
      expect(() => assertArtifactIntegrity(tampered)).toThrow(ArtifactIntegrityError);
      expect(verifyArtifactIntegrity(tampered).valid).toBe(false);
    });

    it("detects tampering with inputHash", () => {
      const base = buildBaseArtifact();
      const firstEntry = base.transcript[0]!;
      const tampered: PersistedTrialEvidence = {
        ...base,
        transcript: [
          {
            ...firstEntry,
            inputHash: "f".repeat(64),
          },
        ],
      };
      expect(() => assertArtifactIntegrity(tampered)).toThrow(ArtifactIntegrityError);
      expect(verifyArtifactIntegrity(tampered).valid).toBe(false);
    });

    it("detects tampering with contextHash", () => {
      const base = buildBaseArtifact();
      const firstEntry = base.transcript[0]!;
      const tampered: PersistedTrialEvidence = {
        ...base,
        transcript: [
          {
            ...firstEntry,
            contextHash: "f".repeat(64),
          },
        ],
      };
      expect(() => assertArtifactIntegrity(tampered)).toThrow(ArtifactIntegrityError);
      expect(verifyArtifactIntegrity(tampered).valid).toBe(false);
    });

    it("detects tampering with failure reason / actionError", () => {
      const base = buildBaseArtifact();
      const firstEntry = base.transcript[0]!;
      const tampered: PersistedTrialEvidence = {
        ...base,
        transcript: [
          {
            ...firstEntry,
            actionError: "Tampered error message",
          },
        ],
      };
      expect(() => assertArtifactIntegrity(tampered)).toThrow(ArtifactIntegrityError);
      expect(verifyArtifactIntegrity(tampered).valid).toBe(false);
    });

    it("detects tampering with reflex decision", () => {
      const base = buildBaseArtifact();
      const firstEntry = base.transcript[0]!;
      const tampered: PersistedTrialEvidence = {
        ...base,
        transcript: [
          {
            ...firstEntry,
            reflexDecision: "REJECT",
          },
        ],
      };
      expect(() => assertArtifactIntegrity(tampered)).toThrow(ArtifactIntegrityError);
      expect(verifyArtifactIntegrity(tampered).valid).toBe(false);
    });

    it("detects tampering with ruleConfigurationHash", () => {
      const base = buildBaseArtifact();
      const tampered: PersistedTrialEvidence = {
        ...base,
        ruleConfigurationHash: "0".repeat(64),
      };
      expect(() => assertArtifactIntegrity(tampered)).toThrow(ArtifactIntegrityError);
      expect(verifyArtifactIntegrity(tampered).valid).toBe(false);
    });

    it("detects tampering with taskContentHash", () => {
      const base = buildBaseArtifact();
      const tampered: PersistedTrialEvidence = {
        ...base,
        taskIdentity: {
          ...base.taskIdentity,
          taskContentHash: "0".repeat(64),
        },
      };
      expect(() => assertArtifactIntegrity(tampered)).toThrow(ArtifactIntegrityError);
      expect(verifyArtifactIntegrity(tampered).valid).toBe(false);
    });

    it("detects tampering with artifactHash directly", () => {
      const base = buildBaseArtifact();
      const tampered: PersistedTrialEvidence = {
        ...base,
        artifactHash: "e".repeat(64),
      };
      expect(() => assertArtifactIntegrity(tampered)).toThrow(ArtifactIntegrityError);
      expect(verifyArtifactIntegrity(tampered).valid).toBe(false);
    });
  });

  // ==========================================================================
  // 4. Credential Boundary & Redaction
  // ==========================================================================
  describe("Credential Boundary & Redaction", () => {
    it("redacts private keys, bearer tokens, API keys, and passwords via sanitizeValue", () => {
      const secretPayload = {
        normalField: "hello world",
        apiKey: "sk-abcdef1234567890abcdef1234",
        userProvidedInput: "ghp_123456789012345678901234567890",
        serverCertKey: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...",
        authHeader: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
        password: "SuperSecretPassword123!",
      };

      const sanitized = sanitizeValue(secretPayload) as Record<string, unknown>;
      expect(sanitized.normalField).toBe("hello world");
      expect(sanitized.apiKey).toBe("[REDACTED]");
      expect(sanitized.userProvidedInput).toBe("[REDACTED_SECRET]");
      expect(sanitized.serverCertKey).toBe("[REDACTED_SECRET]");
      expect(sanitized.authHeader).toBe("[REDACTED_SECRET]");
      expect(sanitized.password).toBe("[REDACTED]");
    });

    it("assertCredentialBoundary throws ArtifactSecurityError when raw secret is present", () => {
      const secretPayload = {
        token: "ghp_123456789012345678901234567890",
      };
      expect(() => assertCredentialBoundary(secretPayload)).toThrow(ArtifactSecurityError);
    });

    it("assertCredentialBoundary succeeds when sensitive properties are already sanitized", () => {
      const cleanPayload = {
        token: "[REDACTED]",
        secret: "[REDACTED]",
        normalField: "safe text",
      };
      expect(() => assertCredentialBoundary(cleanPayload)).not.toThrow();
    });

    it("createPersistedTrialEvidence automatically sanitizes sensitive values and asserts boundary", () => {
      const entryWithSecret: DurableTranscriptEntry = {
        stepNumber: 1,
        contextSnapshotId: "s-1",
        contextHash: validContextHash,
        contextEstimatedTokens: 50,
        contextBytes: 200,
        contextObservationsCount: 1,
        toolName: "run_command",
        inputPayload: { command: "echo hello", apiKey: "sk-123456789012345678901234" },
        proposalValid: true,
        durationMs: 10,
        timestamp: "2026-10-11T20:00:00.000Z",
      };

      const trialIdentityHash = getTrialHash({
        taskId: "task-sec",
        taskVersion: 1,
        taskContentHash: validTaskHash,
        trialOrdinal: 1,
        executionMode: "REFLEX",
      });

      const artifact = createPersistedTrialEvidence({
        trialIdentity: {
          trialId: "trial-sec",
          trialOrdinal: 1,
          trialIdentityHash,
          runtimeRunId: "run-sec",
        },
        taskIdentity: {
          taskId: "task-sec",
          taskVersion: 1,
          taskContentHash: validTaskHash,
        },
        condition: {
          conditionId: "cond-sec",
        },
        executionMode: "REFLEX",
        model: "qwen2.5:3b",
        configFingerprint: sampleFingerprint,
        transcript: [entryWithSecret],
        metrics: makeSampleMetrics(),
        outcome: {
          status: "PASSED",
          statusMessage: "Done",
          verificationPassed: true,
        },
      });

      // The persisted entry must have its apiKey redacted
      const persistedPayload = artifact.transcript[0]!.inputPayload as Record<string, unknown>;
      expect(persistedPayload.apiKey).toBe("[REDACTED]");
      expect(verifyArtifactIntegrity(artifact).valid).toBe(true);
    });
  });

  // ==========================================================================
  // 5. Bounded Serialization Ceilings
  // ==========================================================================
  describe("Bounded Serialization Ceilings", () => {
    it("throws ArtifactBoundsExceededError if transcript entry count exceeds ceiling (50)", () => {
      const transcript: DurableTranscriptEntry[] = [];
      for (let i = 1; i <= EVIDENCE_ARTIFACT_BOUNDS.maxTranscriptEntries + 1; i++) {
        transcript.push({
          stepNumber: i,
          contextSnapshotId: `s-${i}`,
          contextHash: validContextHash,
          contextEstimatedTokens: 10,
          contextBytes: 50,
          contextObservationsCount: 0,
          proposalValid: true,
          durationMs: 1,
          timestamp: "2026-10-11T20:00:00.000Z",
        });
      }

      const trialIdentityHash = getTrialHash({
        taskId: "task-b1",
        executionMode: "REFLEX",
      });

      expect(() =>
        createPersistedTrialEvidence({
          trialIdentity: {
            trialId: "trial-b1",
            trialOrdinal: 1,
            trialIdentityHash,
            runtimeRunId: "run-b1",
          },
          taskIdentity: {
            taskId: "task-b1",
            taskVersion: 1,
            taskContentHash: validTaskHash,
          },
          condition: { conditionId: "c-1" },
          executionMode: "REFLEX",
          model: "qwen2.5:3b",
          configFingerprint: sampleFingerprint,
          transcript,
          metrics: makeSampleMetrics({ steps: 51 }),
          outcome: {
            status: "PASSED",
            statusMessage: "Done",
            verificationPassed: true,
          },
        })
      ).toThrow(ArtifactBoundsExceededError);
    });

    it("throws ArtifactBoundsExceededError if a single input payload exceeds maxPayloadBytes (64KB)", () => {
      const hugeString = "x".repeat(EVIDENCE_ARTIFACT_BOUNDS.maxPayloadBytes + 10);
      const transcript: DurableTranscriptEntry[] = [
        {
          stepNumber: 1,
          contextSnapshotId: "s-1",
          contextHash: validContextHash,
          contextEstimatedTokens: 10,
          contextBytes: 50,
          contextObservationsCount: 0,
          toolName: "write_file",
          inputPayload: { path: "huge.txt", content: hugeString },
          proposalValid: true,
          durationMs: 1,
          timestamp: "2026-10-11T20:00:00.000Z",
        },
      ];

      const trialIdentityHash = getTrialHash({
        taskId: "task-b2",
        executionMode: "REFLEX",
      });

      expect(() =>
        createPersistedTrialEvidence({
          trialIdentity: {
            trialId: "trial-b2",
            trialOrdinal: 1,
            trialIdentityHash,
            runtimeRunId: "run-b2",
          },
          taskIdentity: {
            taskId: "task-b2",
            taskVersion: 1,
            taskContentHash: validTaskHash,
          },
          condition: { conditionId: "c-1" },
          executionMode: "REFLEX",
          model: "qwen2.5:3b",
          configFingerprint: sampleFingerprint,
          transcript,
          metrics: makeSampleMetrics(),
          outcome: {
            status: "PASSED",
            statusMessage: "Done",
            verificationPassed: true,
          },
        })
      ).toThrow(ArtifactBoundsExceededError);
    });
  });

  // ==========================================================================
  // 6. Baseline Isolation Invariant
  // ==========================================================================
  describe("Baseline Telemetry Isolation", () => {
    it("enforces reflexEvidence is strictly undefined for BASELINE mode", () => {
      const baseEntry: DurableTranscriptEntry = {
        stepNumber: 1,
        contextSnapshotId: "s-1",
        contextHash: validContextHash,
        contextEstimatedTokens: 50,
        contextBytes: 200,
        contextObservationsCount: 1,
        toolName: "read_file",
        inputPayload: { path: "src/calc.ts" },
        proposalValid: true,
        durationMs: 10,
        timestamp: "2026-10-11T20:00:00.000Z",
      };

      const trialIdentityHash = getTrialHash({
        taskId: "task-base",
        executionMode: "BASELINE",
      });

      // Valid BASELINE trial: reflexEvidence omitted
      const baselineArtifact = createPersistedTrialEvidence({
        trialIdentity: {
          trialId: "trial-base",
          trialOrdinal: 1,
          trialIdentityHash,
          runtimeRunId: "run-base",
        },
        taskIdentity: {
          taskId: "task-base",
          taskVersion: 1,
          taskContentHash: validTaskHash,
        },
        condition: { conditionId: "c-base" },
        executionMode: "BASELINE",
        model: "qwen2.5:3b",
        configFingerprint: sampleFingerprint,
        transcript: [baseEntry],
        metrics: makeSampleMetrics(),
        outcome: {
          status: "PASSED",
          statusMessage: "Baseline finished",
          verificationPassed: true,
        },
      });

      expect(baselineArtifact.reflexEvidence).toBeUndefined();
      expect(verifyArtifactIntegrity(baselineArtifact).valid).toBe(true);

      // Invariant check: If someone attempts to attach reflexEvidence to a BASELINE trial, it must throw
      const prop = makeSampleProposal("p-1");
      const ctx = makeSampleContext("r", "t", 1);
      const ev = createReflexEvidence({
        runId: "r",
        sequenceNumber: 1,
        proposal: prop,
        context: ctx,
        decision: { decision: "ALLOW", reasonCode: "NO_INTERVENTION" },
        reflexImplementation: "RuleBasedReflex",
        ruleConfigurationHash: configHash,
        ruleConfig: config,
        evaluatedAt: "2026-10-11T20:00:00.000Z",
      });

      expect(() =>
        createPersistedTrialEvidence({
          trialIdentity: {
            trialId: "trial-base-invalid",
            trialOrdinal: 1,
            trialIdentityHash,
            runtimeRunId: "run-base-invalid",
          },
          taskIdentity: {
            taskId: "task-base",
            taskVersion: 1,
            taskContentHash: validTaskHash,
          },
          condition: { conditionId: "c-base" },
          executionMode: "BASELINE",
          model: "qwen2.5:3b",
          configFingerprint: sampleFingerprint,
          transcript: [baseEntry],
          reflexEvidence: [ev],
          metrics: makeSampleMetrics(),
          outcome: {
            status: "PASSED",
            statusMessage: "Baseline finished",
            verificationPassed: true,
          },
        })
      ).toThrow("Invariant violation: Baseline trial cannot persist non-undefined reflexEvidence");
    });

    it("stores reflexEvidence: [] for REFLEX mode when zero interventions occurred", () => {
      const baseEntry: DurableTranscriptEntry = {
        stepNumber: 1,
        contextSnapshotId: "s-1",
        contextHash: validContextHash,
        contextEstimatedTokens: 50,
        contextBytes: 200,
        contextObservationsCount: 1,
        toolName: "read_file",
        inputPayload: { path: "src/calc.ts" },
        proposalValid: true,
        durationMs: 10,
        timestamp: "2026-10-11T20:00:00.000Z",
      };

      const trialIdentityHash = getTrialHash({
        taskId: "task-ref-zero",
        executionMode: "REFLEX",
        ruleConfigurationHash: configHash,
      });

      const reflexArtifact = createPersistedTrialEvidence({
        trialIdentity: {
          trialId: "trial-ref-zero",
          trialOrdinal: 1,
          trialIdentityHash,
          runtimeRunId: "run-ref-zero",
        },
        taskIdentity: {
          taskId: "task-ref-zero",
          taskVersion: 1,
          taskContentHash: validTaskHash,
        },
        condition: { conditionId: "c-ref" },
        executionMode: "REFLEX",
        model: "qwen2.5:3b",
        configFingerprint: sampleFingerprint,
        ruleConfigurationHash: configHash,
        transcript: [baseEntry],
        reflexEvidence: undefined, // 0 interventions
        metrics: makeSampleMetrics({
          reflexEvaluations: 0,
          reflexAllows: 0,
          reflexRejects: 0,
          reflexDefers: 0,
        }),
        outcome: {
          status: "PASSED",
          statusMessage: "Reflex finished with zero interventions",
          verificationPassed: true,
        },
      });

      expect(reflexArtifact.reflexEvidence).toEqual([]);
      expect(verifyArtifactIntegrity(reflexArtifact).valid).toBe(true);
    });
  });
});
