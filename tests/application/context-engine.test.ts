import { describe, expect, it } from "vitest";
import {
  ContextBudget,
  DEFAULT_CONTEXT_BUDGET,
  Observation,
  computeObservationContentHash,
  estimateBytes,
  estimateTokens,
} from "../../src/domain/context.js";
import { ContextBudgetExceededError } from "../../src/domain/errors.js";
import { ContextEngine } from "../../src/application/context/context-engine.js";

function makeObs(params: {
  id: string;
  category: Observation["category"];
  priority: number;
  freshness?: Observation["freshness"];
  content?: Record<string, unknown>;
  isMandatory?: boolean;
  seq?: number;
  runId?: string;
}): Observation {
  const runId = params.runId ?? "run-1";
  const content = params.content ?? { test: params.id };
  const bytes = estimateBytes(content);
  return {
    observationId: params.id,
    category: params.category,
    provenance: {
      entityKind: "Run",
      entityId: params.id,
      runId,
      sequenceNumber: params.seq ?? 1,
      timestamp: "2026-10-13T12:00:00.000Z",
      isAuthoritativeRuntimeFact: true,
    },
    freshness: params.freshness ?? "CURRENT",
    priority: params.priority,
    content,
    contentHash: computeObservationContentHash(content),
    estimatedBytes: bytes,
    estimatedTokens: estimateTokens(bytes),
    isMandatory: params.isMandatory ?? false,
  };
}

describe("Application — ContextEngine", () => {
  const runId = "run-ctx-1";
  const taskId = "task-ctx-1";

  it("builds a snapshot deterministically preserving mandatory safety observations", () => {
    const runStateObs = makeObs({
      id: "obs-run",
      category: "RUN_STATE",
      priority: 100,
      isMandatory: true,
      runId,
    });
    const missionObs = makeObs({
      id: "obs-mission",
      category: "MISSION_CONTEXT",
      priority: 90,
      isMandatory: true,
      runId,
    });
    const actionObs = makeObs({
      id: "obs-action-1",
      category: "ACTION_HISTORY",
      priority: 50,
      runId,
    });

    const snapshot1 = ContextEngine.build({
      runId,
      taskId,
      candidates: [actionObs, runStateObs, missionObs],
      createdAt: "2026-10-13T12:00:00.000Z",
    });

    const snapshot2 = ContextEngine.build({
      runId,
      taskId,
      candidates: [missionObs, actionObs, runStateObs],
      createdAt: "2026-10-13T12:00:00.000Z",
    });

    expect(snapshot1.snapshotId).toBe(snapshot2.snapshotId);
    expect(snapshot1.contextHash).toBe(snapshot2.contextHash);
    expect(snapshot1.observations.map((o) => o.observationId)).toEqual([
      "obs-run",
      "obs-mission",
      "obs-action-1",
    ]);
  });

  it("strictly preserves epistemic uncertainty for UNKNOWN attempts", () => {
    const unknownAttemptObs = makeObs({
      id: "obs-attempt-unknown",
      category: "ATTEMPT_HISTORY",
      priority: 85,
      isMandatory: true, // Marked mandatory to preserve epistemic uncertainty
      content: {
        attemptNumber: 1,
        status: "UNKNOWN",
        executionOutcomeUncertain: true,
        unknownReason: "LEASE_EXPIRED_DURING_EXECUTION",
      },
      runId,
    });

    const snapshot = ContextEngine.build({
      runId,
      taskId,
      candidates: [unknownAttemptObs],
    });

    expect(snapshot.observations).toHaveLength(1);
    const obs = snapshot.observations[0]!;
    expect(obs.category).toBe("ATTEMPT_HISTORY");
    expect(obs.content["status"]).toBe("UNKNOWN");
    expect(obs.content["executionOutcomeUncertain"]).toBe(true);
    expect(obs.content["unknownReason"]).toBe("LEASE_EXPIRED_DURING_EXECUTION");
  });

  it("selects higher priority observations when budget is tight", () => {
    const highPriority = makeObs({
      id: "obs-high",
      category: "TOOL_ERROR",
      priority: 80,
      runId,
    });
    const lowPriority = makeObs({
      id: "obs-low",
      category: "SYSTEM_EVENT",
      priority: 20,
      runId,
    });

    const tightBudget: ContextBudget = {
      ...DEFAULT_CONTEXT_BUDGET,
      maxObservations: 1,
    };

    const snapshot = ContextEngine.build({
      runId,
      taskId,
      candidates: [lowPriority, highPriority],
      budget: tightBudget,
    });

    expect(snapshot.observations).toHaveLength(1);
    expect(snapshot.observations[0]!.observationId).toBe("obs-high");
    expect(snapshot.omittedObservationsCount).toBe(1);
    expect(snapshot.omittedObservationsSummary).toEqual([
      {
        category: "SYSTEM_EVENT",
        count: 1,
        reason: "BUDGET_LIMIT",
        totalEstimatedTokens: lowPriority.estimatedTokens,
        totalBytes: lowPriority.estimatedBytes,
      },
    ]);
  });

  it("enforces category count limits (maxHistoryEvents, maxActionHistory)", () => {
    const events: Observation[] = [];
    for (let i = 1; i <= 10; i++) {
      events.push(
        makeObs({
          id: `obs-event-${i}`,
          category: "SYSTEM_EVENT",
          priority: 20,
          seq: i,
          runId,
        })
      );
    }

    const budget: ContextBudget = {
      ...DEFAULT_CONTEXT_BUDGET,
      maxHistoryEvents: 3,
    };

    const snapshot = ContextEngine.build({
      runId,
      taskId,
      candidates: events,
      budget,
    });

    expect(snapshot.observations).toHaveLength(3);
    // Should keep the latest sequence numbers (8, 9, 10)
    expect(snapshot.observations.map((o) => o.observationId)).toEqual([
      "obs-event-8",
      "obs-event-9",
      "obs-event-10",
    ]);
    expect(snapshot.omittedObservationsCount).toBe(7);
  });

  it("enforces maxEstimatedTokens and maxBytes ceilings", () => {
    const largeContent = { data: "X".repeat(200) };
    const obs1 = makeObs({ id: "obs-1", category: "TOOL_RESULT", priority: 60, content: largeContent, runId });
    const obs2 = makeObs({ id: "obs-2", category: "TOOL_RESULT", priority: 60, content: largeContent, runId });
    const obs3 = makeObs({ id: "obs-3", category: "TOOL_RESULT", priority: 60, content: largeContent, runId });

    // Budget allows only enough tokens for 1 observation
    const tightBudget: ContextBudget = {
      ...DEFAULT_CONTEXT_BUDGET,
      maxEstimatedTokens: obs1.estimatedTokens + 5,
    };

    const snapshot = ContextEngine.build({
      runId,
      taskId,
      candidates: [obs1, obs2, obs3],
      budget: tightBudget,
    });

    expect(snapshot.observations).toHaveLength(1);
    expect(snapshot.totalEstimatedTokens).toBeLessThanOrEqual(tightBudget.maxEstimatedTokens);
    expect(snapshot.omittedObservationsCount).toBe(2);
  });

  it("truncates oversized tool outputs to maxToolOutputBytes", () => {
    const hugeOutput = "B".repeat(5000);
    const oversizedObs = makeObs({
      id: "obs-tool-huge",
      category: "TOOL_RESULT",
      priority: 60,
      content: { stdout: hugeOutput, exitCode: 0 },
      runId,
    });

    const budget: ContextBudget = {
      ...DEFAULT_CONTEXT_BUDGET,
      maxToolOutputBytes: 500,
    };

    const snapshot = ContextEngine.build({
      runId,
      taskId,
      candidates: [oversizedObs],
      budget,
    });

    expect(snapshot.observations).toHaveLength(1);
    const selected = snapshot.observations[0]!;
    expect(selected.truncation).toBeDefined();
    expect(selected.truncation?.isTruncated).toBe(true);
    expect(selected.estimatedBytes).toBeLessThanOrEqual(1000);
    expect(selected.content["stdout"]).toContain("TRUNCATED");
  });

  it("throws ContextBudgetExceededError when mandatory observations cannot fit", () => {
    const mandatoryObs = makeObs({
      id: "obs-mandatory-run",
      category: "RUN_STATE",
      priority: 100,
      isMandatory: true,
      content: { status: "RUNNING", details: "large mandatory context ".repeat(20) },
      runId,
    });

    const impossibleBudget: ContextBudget = {
      ...DEFAULT_CONTEXT_BUDGET,
      maxEstimatedTokens: 5, // Far too small to fit mandatory observation
    };

    expect(() =>
      ContextEngine.build({
        runId,
        taskId,
        candidates: [mandatoryObs],
        budget: impossibleBudget,
      })
    ).toThrow(ContextBudgetExceededError);
  });
});
