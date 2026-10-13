import { describe, expect, it } from "vitest";
import {
  ALL_OBSERVATION_CATEGORIES,
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_SELECTION_POLICY,
  Observation,
  computeContextHash,
  computeObservationContentHash,
  estimateBytes,
  estimateTokens,
  truncateToolOutput,
  validateContextBudget,
  validateObservation,
} from "../../src/domain/context.js";
import {
  InvalidContextBudgetError,
  InvalidObservationError,
} from "../../src/domain/errors.js";

describe("Domain — Context Engine Model & Invariants", () => {
  const validBaseObs: Observation = {
    observationId: "obs-test-01",
    category: "RUN_STATE",
    provenance: {
      entityKind: "Run",
      entityId: "run-123",
      runId: "run-123",
      sequenceNumber: 1,
      timestamp: "2026-10-13T12:00:00.000Z",
      isAuthoritativeRuntimeFact: true,
    },
    freshness: "CURRENT",
    priority: 100,
    content: { status: "RUNNING", step: 1 },
    contentHash: computeObservationContentHash({ status: "RUNNING", step: 1 }),
    estimatedBytes: 30,
    estimatedTokens: 8,
    isMandatory: true,
  };

  it("validates that all 10 observation categories are defined", () => {
    expect(ALL_OBSERVATION_CATEGORIES).toHaveLength(10);
    expect(ALL_OBSERVATION_CATEGORIES).toContain("RUN_STATE");
    expect(ALL_OBSERVATION_CATEGORIES).toContain("MISSION_CONTEXT");
    expect(ALL_OBSERVATION_CATEGORIES).toContain("ACTION_HISTORY");
    expect(ALL_OBSERVATION_CATEGORIES).toContain("ATTEMPT_HISTORY");
    expect(ALL_OBSERVATION_CATEGORIES).toContain("TOOL_RESULT");
    expect(ALL_OBSERVATION_CATEGORIES).toContain("TOOL_ERROR");
    expect(ALL_OBSERVATION_CATEGORIES).toContain("EVIDENCE");
    expect(ALL_OBSERVATION_CATEGORIES).toContain("VERIFICATION");
    expect(ALL_OBSERVATION_CATEGORIES).toContain("WORKSPACE_STATE");
    expect(ALL_OBSERVATION_CATEGORIES).toContain("SYSTEM_EVENT");
  });

  it("passes validation for a correctly formed observation", () => {
    expect(() => validateObservation(validBaseObs)).not.toThrow();
  });

  it("rejects observation with missing or empty observationId", () => {
    expect(() =>
      validateObservation({ ...validBaseObs, observationId: "" })
    ).toThrow(InvalidObservationError);
  });

  it("rejects observation with invalid category", () => {
    expect(() =>
      validateObservation({
        ...validBaseObs,
        category: "INVALID_CAT" as any,
      })
    ).toThrow(InvalidObservationError);
  });

  it("rejects observation with invalid freshness", () => {
    expect(() =>
      validateObservation({
        ...validBaseObs,
        freshness: "ANCIENT" as any,
      })
    ).toThrow(InvalidObservationError);
  });

  it("rejects observation with invalid contentHash", () => {
    expect(() =>
      validateObservation({
        ...validBaseObs,
        contentHash: "short-hash",
      })
    ).toThrow(InvalidObservationError);
  });

  it("rejects observation with negative estimatedTokens or estimatedBytes", () => {
    expect(() =>
      validateObservation({
        ...validBaseObs,
        estimatedBytes: -1,
      })
    ).toThrow(InvalidObservationError);

    expect(() =>
      validateObservation({
        ...validBaseObs,
        estimatedTokens: -5,
      })
    ).toThrow(InvalidObservationError);
  });

  it("rejects observation where truncation retainedBytes exceeds originalBytes", () => {
    expect(() =>
      validateObservation({
        ...validBaseObs,
        truncation: {
          isTruncated: true,
          originalBytes: 100,
          retainedBytes: 150,
          originalEstimatedTokens: 25,
          retainedEstimatedTokens: 40,
        },
      })
    ).toThrow(InvalidObservationError);
  });

  it("computes deterministic byte estimation and token estimation", () => {
    const payload = { a: 1, b: "hello world" };
    const bytes = estimateBytes(payload);
    expect(bytes).toBeGreaterThan(0);
    expect(estimateTokens(bytes)).toBe(Math.ceil(bytes / 4));
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(-10)).toBe(0);
  });

  it("redacts sensitive keys during computeObservationContentHash", () => {
    const payloadWithSecret = {
      user: "worker-1",
      api_key: "super-secret-token",
      token: "secret-token-value",
      password: "pass",
    };
    const hash1 = computeObservationContentHash(payloadWithSecret);

    const payloadRedactedExplicit = {
      user: "worker-1",
      api_key: "[REDACTED]",
      token: "[REDACTED]",
      password: "[REDACTED]",
    };
    const hash2 = computeObservationContentHash(payloadRedactedExplicit);

    expect(hash1).toBe(hash2);
  });

  it("truncates oversized tool outputs deterministically with head/tail preservation", () => {
    const hugeOutput = "A".repeat(5000) + "MIDDLE" + "Z".repeat(5000);
    const content = { stdout: hugeOutput, exitCode: 0 };

    const { truncatedContent, truncation } = truncateToolOutput(content, 1000);
    expect(truncation).toBeDefined();
    expect(truncation?.isTruncated).toBe(true);
    expect(truncation?.originalBytes).toBeGreaterThan(10000);
    expect(truncation?.retainedBytes).toBeLessThanOrEqual(1500);
    expect(truncation?.truncationStrategy).toBe("HEAD_TAIL");

    const str = truncatedContent["stdout"] as string;
    expect(str).toContain("TRUNCATED");
    expect(str.startsWith("AAAA")).toBe(true);
    expect(str.endsWith("ZZZZ")).toBe(true);
  });

  it("leaves content untouched when size is within limit", () => {
    const smallContent = { stdout: "all good", exitCode: 0 };
    const { truncatedContent, truncation } = truncateToolOutput(smallContent, 1000);
    expect(truncation).toBeUndefined();
    expect(truncatedContent).toEqual(smallContent);
  });

  it("validates context budget invariants", () => {
    expect(() => validateContextBudget(DEFAULT_CONTEXT_BUDGET)).not.toThrow();

    expect(() =>
      validateContextBudget({
        ...DEFAULT_CONTEXT_BUDGET,
        maxObservations: 0,
      })
    ).toThrow(InvalidContextBudgetError);

    expect(() =>
      validateContextBudget({
        ...DEFAULT_CONTEXT_BUDGET,
        maxEstimatedTokens: -1,
      })
    ).toThrow(InvalidContextBudgetError);

    expect(() =>
      validateContextBudget({
        ...DEFAULT_CONTEXT_BUDGET,
        maxBytes: 0,
      })
    ).toThrow(InvalidContextBudgetError);
  });

  it("computes deterministic contextHash across executions", () => {
    const obsList = [validBaseObs];
    const data = {
      runId: "run-123",
      taskId: "task-abc",
      policyVersion: DEFAULT_SELECTION_POLICY.policyVersion,
      budget: DEFAULT_CONTEXT_BUDGET,
      observations: obsList,
    };

    const hash1 = computeContextHash(data);
    const hash2 = computeContextHash(data);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);

    // Altering an observation must alter the contextHash
    const alteredObs: Observation = {
      ...validBaseObs,
      priority: 99,
    };
    const hash3 = computeContextHash({ ...data, observations: [alteredObs] });
    expect(hash3).not.toBe(hash1);
  });
});
