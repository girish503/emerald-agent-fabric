/**
 * Milestone 2.22 review fixes:
 *  1. ContextResidencyTracker must treat alias spellings of one file as the same file, and a write to an
 *     unrelated file must not evict resident inputs.
 *  2. The LiveAgentBrain task reminder must be task-agnostic: it restates the task's own objective, lists
 *     successful read/write paths from observations, names no fixed paths, and never tells the model to conclude.
 */
import { describe, expect, it } from "vitest";
import {
  ContextResidencyTracker,
  normalizeResidencyPath,
} from "../../src/application/context-residency-tracker.js";
import { LiveAgentBrain } from "../../src/application/live-agent-brain.js";
import { computeContextHash, ContextSnapshot, DEFAULT_CONTEXT_BUDGET, Observation } from "../../src/domain/context.js";
import { staticToolRegistry } from "../../src/domain/tool.js";
import { AgentBrainRequest } from "../../src/ports/agent-brain.port.js";
import { ModelProviderPort } from "../../src/ports/model-provider.port.js";

describe("normalizeResidencyPath", () => {
  it("maps alias spellings of the same workspace file to one key", () => {
    for (const alias of ["input/a.md", "./input/a.md", "input//a.md", "input/../input/a.md", "input\\a.md", ".//input/a.md"]) {
      expect(normalizeResidencyPath(alias), alias).toBe("input/a.md");
    }
    expect(normalizeResidencyPath(".")).toBe("");
  });
});

describe("ContextResidencyTracker — path-targeted invalidation", () => {
  const read = (t: ContextResidencyTracker, p: string) =>
    t.recordRead({ path: p } as never, { path: p, content: "x", bytesRead: 1, totalLines: 1, isTruncated: false } as never, 1);

  it("a write to an unrelated/untracked output file does not evict resident inputs", () => {
    const t = new ContextResidencyTracker({ enableDynamicToolFiltering: true });
    read(t, "input/a.md");
    read(t, "input/b.md");
    t.recordWorkspaceMutation("reports/out.md", 2);
    expect(t.getResidency("input/a.md")?.isStale).toBe(false);
    expect(t.getResidency("input/b.md")?.isStale).toBe(false);
  });

  it("an overwrite invalidates exactly the targeted file", () => {
    const t = new ContextResidencyTracker({ enableDynamicToolFiltering: true });
    read(t, "input/a.md");
    read(t, "input/b.md");
    t.recordWorkspaceMutation("input/a.md", 3);
    expect(t.getResidency("input/a.md")?.isStale).toBe(true);
    expect(t.getResidency("input/b.md")?.isStale).toBe(false);
  });

  it("alias spellings of a tracked file still invalidate it (no stale resident context)", () => {
    for (const alias of ["./input/a.md", "input//a.md", "input/../input/a.md", "input\\a.md"]) {
      const t = new ContextResidencyTracker({ enableDynamicToolFiltering: true });
      read(t, "input/a.md");
      t.recordWorkspaceMutation(alias, 4);
      expect(t.getResidency("input/a.md")?.isStale, alias).toBe(true);
    }
  });

  it("a read recorded under an alias is found, and invalidated, by the canonical spelling", () => {
    const t = new ContextResidencyTracker({ enableDynamicToolFiltering: true });
    read(t, "./input/a.md");
    expect(t.getResidency("input/a.md")).toBeDefined();
    t.recordWorkspaceMutation("input/a.md", 2);
    expect(t.getEligibility("read_file", "./input/a.md")).toBe("RESTORED");
  });

  it("is case-insensitive on mutation (safe over-invalidation for case-insensitive filesystems)", () => {
    const t = new ContextResidencyTracker({ enableDynamicToolFiltering: true });
    read(t, "input/a.md");
    t.recordWorkspaceMutation("Input/A.md", 2);
    expect(t.getResidency("input/a.md")?.isStale).toBe(true);
  });

  it("a mutation with no target, or the workspace root, still invalidates everything", () => {
    for (const target of [undefined, ".", ""]) {
      const t = new ContextResidencyTracker({ enableDynamicToolFiltering: true });
      read(t, "input/a.md");
      read(t, "input/b.md");
      t.recordWorkspaceMutation(target, 5);
      expect(t.getResidency("input/a.md")?.isStale).toBe(true);
      expect(t.getResidency("input/b.md")?.isStale).toBe(true);
    }
  });
});

describe("LiveAgentBrain — task-agnostic reminder", () => {
  const provider = {
    providerName: "fake",
    generate: async () => {
      throw new Error("not used");
    },
  } as unknown as ModelProviderPort;

  const obs = (id: string, category: Observation["category"], content: Record<string, unknown>): Observation => ({
    observationId: id,
    category,
    provenance: {
      entityKind: "Run",
      entityId: "run-1",
      runId: "run-1",
      timestamp: "2026-11-05T00:00:00.000Z",
      isAuthoritativeRuntimeFact: true,
    },
    freshness: "CURRENT",
    priority: 50,
    content,
    contentHash: id.padEnd(64, "0").slice(0, 64),
    estimatedTokens: 5,
    estimatedBytes: 20,
    isMandatory: false,
  });

  const buildPrompt = (description: string | undefined, history: Array<{ tool: string; path: string; status: string }>) => {
    const observations: Observation[] = [
      obs("m", "MISSION_CONTEXT", { taskDetails: { title: "T", ...(description ? { description } : {}) } }),
      ...history.map((h, i) =>
        obs(`a${i}`, "ACTION_HISTORY", { toolName: h.tool, status: h.status, inputPayload: { path: h.path } })
      ),
    ];
    const contextHash = computeContextHash({
      runId: "run-1",
      taskId: "task-1",
      policyVersion: "p",
      budget: DEFAULT_CONTEXT_BUDGET,
      observations,
    });
    const snapshot: ContextSnapshot = {
      snapshotId: "s",
      runId: "run-1",
      taskId: "task-1",
      policyVersion: "p",
      createdAt: "2026-11-05T00:00:00.000Z",
      budget: DEFAULT_CONTEXT_BUDGET,
      observations,
      omittedObservationsCount: 0,
      omittedObservationsSummary: [],
      totalEstimatedTokens: 5 * observations.length,
      totalBytes: 20 * observations.length,
      contextHash,
    };
    const req: AgentBrainRequest = {
      runId: "run-1",
      contextSnapshot: snapshot,
      availableTools: staticToolRegistry.listTools(),
      sequenceNumber: 1,
    };
    return new LiveAgentBrain({ modelProvider: provider, model: "m" }).buildModelRequest(req).input[1]!.content;
  };

  it("restates the task's own objective and lists only successful read/write paths", () => {
    const p = buildPrompt("Fix the parser bug in src/parse.ts", [
      { tool: "read_file", path: "src/parse.ts", status: "SUCCEEDED" },
      { tool: "edit_file", path: "src/parse.ts", status: "SUCCEEDED" },
      { tool: "read_file", path: "src/other.ts", status: "FAILED" },
    ]);
    expect(p).toContain("## Task Reminder");
    expect(p).toContain("Task Objective: Fix the parser bug in src/parse.ts");
    expect(p).toContain("Files read successfully so far: src/parse.ts\n");
    expect(p).toContain("Files written or edited successfully so far: src/parse.ts\n");
  });

  it("names no fixed acceptance-task paths and issues no conclusion instruction, even after writing a 'report' path", () => {
    const p = buildPrompt("Refactor src/reporting.ts", [{ tool: "write_file", path: "src/reporting.ts", status: "SUCCEEDED" }]);
    expect(p).not.toContain("project-brief.md");
    expect(p).not.toContain("project-analysis.md");
    expect(p).not.toContain("Conclude the mission now");
    expect(p).not.toContain("Do NOT propose any further tool actions");
    expect(p).toContain("Propose the next logical tool action");
    expect(p).toContain("Only set isGoalReached: true when every part of the objective above is satisfied.");
  });

  it("only suggests concluding after a successful write, conditionally, and never mandates it", () => {
    const before = buildPrompt("Update src/a.ts", [{ tool: "read_file", path: "src/a.ts", status: "SUCCEEDED" }]);
    expect(before).not.toContain("already satisfy the objective");
    const failedWrite = buildPrompt("Update src/a.ts", [{ tool: "write_file", path: "src/a.ts", status: "FAILED" }]);
    expect(failedWrite).not.toContain("already satisfy the objective");
    const after = buildPrompt("Update src/a.ts", [{ tool: "write_file", path: "src/a.ts", status: "SUCCEEDED" }]);
    expect(after).toContain("If the files written or edited above already satisfy the objective, set isGoalReached: true instead of repeating the same action.");
    expect(after).not.toContain("Do NOT propose any further tool actions");
    expect(after).toContain("Propose the next logical tool action");
  });

  it("adds no reminder when the task has no description", () => {
    expect(buildPrompt(undefined, [])).not.toContain("## Task Reminder");
  });
});
