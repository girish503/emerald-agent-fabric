/**
 * Phase 46A: Offline Contract Tests for Dynamic Context-Aware Tool Filtering
 *
 * Implements the deterministic contract-test matrix (CT-1 through CT-8) defined in:
 * docs/research/phase45-dynamic-context-aware-tool-filtering-design.md
 *
 * Architectural Boundary:
 * 1. Design-Level Contract Models:
 *    - FileResidencyRecord: Typed residency metadata tracking file completeness, staleness, and SHA-256 digest.
 *    - ReferenceContextResidencyTracker: Reference implementation of context-residency tracking and the 7 invalidation rules.
 *    - deriveActionProposalSchema(): Dynamic structured-output schema projection derived from eligible tools.
 * 2. Production Code Verification:
 *    - LiveAgentBrain's ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA: Verifies 7-branch static schema and grammar compatibility.
 *    - ProposalValidator: Proves that authoritative runtime proposal validation remains 100% intact and independent.
 *    - PolicyEvaluator: Proves capability-based governance enforcement is strictly preserved.
 *    - INITIAL_TOOL_DEFINITIONS: Validates registered tool boundaries against domain schemas.
 *
 * Zero live Ollama inference. Zero production runtime modifications. Zero git mutations.
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  INITIAL_TOOL_DEFINITIONS,
  ToolDefinition,
  ToolName,
} from "../../src/domain/tool.js";
import {
  ReadFileInput,
  ReadFileOutput,
} from "../../src/domain/tool-schemas.js";
import {
  ContextSnapshot,
  DEFAULT_CONTEXT_BUDGET,
  Observation,
} from "../../src/domain/context.js";
import {
  ProposalValidationContext,
  ProposalValidator,
} from "../../src/application/proposal-validator.js";
import {
  createExecutionPolicy,
  createMissionContract,
  createResourceLimits,
  MissionContract,
} from "../../src/domain/index.js";
import { PolicyEvaluator } from "../../src/domain/policy.js";
import { RunSnapshot } from "../../src/domain/invariants.js";
import {
  ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA,
  deriveActionProposalSchema as productionDeriveActionProposalSchema,
  LiveAgentBrain,
} from "../../src/application/live-agent-brain.js";
import { ContextResidencyTracker } from "../../src/application/context-residency-tracker.js";
import { AgentStepController } from "../../src/application/agent-step-controller.js";
import { ModelProviderPort } from "../../src/ports/model-provider.port.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { ModelStructuredOutputSchema } from "../../src/ports/model-provider.port.js";

// ============================================================================
// 1. Contract Interfaces (from Phase 45 Design Specification Section 3.1 & 3.2)
// ============================================================================

export interface FileResidencyRecord {
  readonly path: string;
  readonly contentHash: string;
  readonly totalBytes: number;
  readonly totalLines: number;
  readonly isComplete: boolean;
  readonly sequenceNumber: number;
  readonly isStale: boolean;
}

export type ToolEligibilityState = "ELIGIBLE" | "FILTERED" | "RESTORED";

export interface DynamicFilteringOptions {
  readonly enableDynamicToolFiltering?: boolean;
}

// ============================================================================
// 2. Test-Local Reference Model: ReferenceContextResidencyTracker
// ============================================================================

export class ReferenceContextResidencyTracker {
  private readonly records = new Map<string, FileResidencyRecord>();

  /**
   * Records a successful file read observation.
   * Enforces Rule 2: Incomplete/truncated reads mark isComplete: false.
   */
  recordRead(
    input: ReadFileInput,
    output: ReadFileOutput,
    sequenceNumber: number
  ): FileResidencyRecord {
    const isFullFile =
      (input.offsetLine === undefined || input.offsetLine === 1) &&
      output.isTruncated !== true &&
      (input.limitLines === undefined ||
        output.totalLines === undefined ||
        input.limitLines >= output.totalLines);

    const contentHash = createHash("sha256")
      .update(output.content, "utf8")
      .digest("hex");

    const record: FileResidencyRecord = {
      path: output.path,
      contentHash,
      totalBytes: output.bytesRead,
      totalLines: output.totalLines ?? output.content.split("\n").length,
      isComplete: isFullFile,
      sequenceNumber,
      isStale: false,
    };

    this.records.set(output.path, record);
    return record;
  }

  /**
   * Records a workspace mutation (e.g. write_file).
   * Enforces Rule 1: Invalidates residency for target path (or workspace).
   */
  recordWorkspaceMutation(path: string, sequenceNumber: number): void {
    const existing = this.records.get(path);
    if (existing) {
      this.records.set(path, {
        ...existing,
        isStale: true,
        sequenceNumber,
      });
    } else {
      // If an unobserved file is written, mark workspace as mutated
      this.records.forEach((rec, p) => {
        this.records.set(p, { ...rec, isStale: true });
      });
    }
  }

  /**
   * Records execution failure.
   * Enforces Rule 6: Restores all filtered tools to ensure recovery options.
   */
  recordExecutionFailure(): void {
    this.records.forEach((rec, p) => {
      this.records.set(p, { ...rec, isStale: true });
    });
  }

  /**
   * Evaluates eligibility for a tool given target path, context snapshot, and task category.
   * Evaluates Rules 1 through 7.
   */
  getEligibility(
    toolName: ToolName,
    targetPath: string,
    contextSnapshot: ContextSnapshot,
    taskCategory?: string
  ): ToolEligibilityState {
    if (toolName !== "read_file") {
      return "ELIGIBLE";
    }

    // Rule 7: Pure navigation tasks bypass tool filtering entirely
    if (taskCategory === "CODE_NAVIGATION") {
      return "ELIGIBLE";
    }

    const record = this.records.get(targetPath);

    // Rule 4: Multi-file exploration - unobserved file is eligible
    if (!record) {
      return "ELIGIBLE";
    }

    // Rule 2: Partial/range read does not filter
    if (!record.isComplete) {
      return "ELIGIBLE";
    }

    // Rule 1 & 3: Workspace mutation or external modification invalidates residency
    if (record.isStale) {
      return "RESTORED";
    }

    // Rule 5: Context budget eviction - check if observation is missing from snapshot
    const hasObservationInSnapshot = contextSnapshot.observations.some((obs) => {
      if (obs.category === "TOOL_RESULT") {
        const payload = (obs.content as any)?.output ?? (obs.content as any)?.payload;
        return payload?.path === targetPath;
      }
      return false;
    });

    if (!hasObservationInSnapshot || (contextSnapshot.omittedObservationsCount > 0 && !hasObservationInSnapshot)) {
      return "RESTORED";
    }

    // Complete, current, resident in snapshot: FILTERED
    return "FILTERED";
  }

  /**
   * Filters the list of available tools based on residency state.
   */
  filterEligibleTools(
    allTools: readonly ToolDefinition[],
    targetPath: string,
    contextSnapshot: ContextSnapshot,
    taskCategory?: string
  ): readonly ToolDefinition[] {
    return allTools.filter((tool) => {
      const eligibility = this.getEligibility(
        tool.name,
        targetPath,
        contextSnapshot,
        taskCategory
      );
      return eligibility === "ELIGIBLE" || eligibility === "RESTORED";
    });
  }

  getResidency(path: string): FileResidencyRecord | undefined {
    return this.records.get(path);
  }
}

// ============================================================================
// 3. Test-Local Reference Model: deriveActionProposalSchema()
// ============================================================================

export function deriveActionProposalSchema(
  availableTools: readonly ToolDefinition[],
  options?: DynamicFilteringOptions
): ModelStructuredOutputSchema {
  // Rollback configuration: if dynamic filtering is disabled, return static 7-branch schema
  if (options?.enableDynamicToolFiltering === false) {
    return ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA;
  }

  const eligibleToolNames = new Set(availableTools.map((t) => t.name));
  const staticBranches = (ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA.jsonSchema as any).anyOf;

  // Branch 0: isGoalReached (always included)
  const goalReachedBranch = staticBranches[0];

  // Tool branches: only include schema definitions for tools that are currently eligible
  const toolBranches = staticBranches.slice(1).filter((branch: any) => {
    const toolName = branch.properties?.toolName?.enum?.[0];
    return toolName && eligibleToolNames.has(toolName);
  });

  return {
    name: "action_proposal",
    strict: true,
    jsonSchema: {
      type: "object",
      anyOf: [goalReachedBranch, ...toolBranches],
    },
  };
}

// ============================================================================
// 4. Test Fixtures & Validation Helpers
// ============================================================================

const TEST_CONTEXT_HASH = "c".repeat(64);

function createMockSnapshot(options?: {
  includeReadFileObs?: boolean;
  filePath?: string;
  omittedCount?: number;
}): ContextSnapshot {
  const filePath = options?.filePath ?? "src/calc.js";
  const observations: Observation[] = [
    {
      observationId: "obs-task-info",
      category: "RUN_STATE",
      provenance: {
        entityKind: "Run",
        entityId: "run-test-1",
        runId: "run-test-1",
        timestamp: "2026-10-26T12:00:00.000Z",
        isAuthoritativeRuntimeFact: true,
      },
      freshness: "CURRENT",
      priority: 100,
      content: { taskId: "EAF-BM-01", status: "RUNNING" },
      contentHash: "1".repeat(64),
      estimatedBytes: 60,
      estimatedTokens: 15,
      isMandatory: true,
    },
  ];

  if (options?.includeReadFileObs) {
    observations.push({
      observationId: "obs-read-calc",
      category: "TOOL_RESULT",
      provenance: {
        entityKind: "Attempt",
        entityId: "att-1",
        runId: "run-test-1",
        timestamp: "2026-10-26T12:00:05.000Z",
        isAuthoritativeRuntimeFact: true,
      },
      freshness: "CURRENT",
      priority: 70,
      content: {
        toolName: "read_file",
        output: {
          path: filePath,
          content: "function add(a, b) {\n  return a + b + 1;\n}\nmodule.exports = { add };",
          bytesRead: 65,
          totalLines: 4,
          isTruncated: false,
        },
      },
      contentHash: "2".repeat(64),
      estimatedBytes: 150,
      estimatedTokens: 38,
      isMandatory: false,
    });
  }

  return {
    snapshotId: "snap-test-1",
    runId: "run-test-1",
    taskId: "task-test-1",
    policyVersion: "context-policy-v1",
    createdAt: "2026-10-26T12:00:00.000Z",
    budget: DEFAULT_CONTEXT_BUDGET,
    observations,
    omittedObservationsCount: options?.omittedCount ?? 0,
    omittedObservationsSummary: [],
    totalEstimatedTokens: 53,
    totalBytes: 210,
    contextHash: TEST_CONTEXT_HASH,
  };
}

function createMockContract(allowedCapabilities?: string[]): MissionContract {
  return createMissionContract({
    contractId: "contract-test-1",
    version: 1,
    taskId: "task-test-1",
    policy: createExecutionPolicy({
      policyId: "policy-test-1",
      allowedCapabilities: allowedCapabilities ?? [
        "workspace.file.read",
        "workspace.file.write",
        "workspace.code.search",
        "process.execute",
        "git.read",
      ],
      isolationRequirement: "ISOLATED",
    }),
    resourceLimits: createResourceLimits({
      timeoutMs: 30000,
      maxAttempts: 3,
      maxOutputBytes: 1048576,
    }),
    status: "ACTIVE",
    createdAt: "2026-10-26T12:00:00.000Z",
    activatedAt: "2026-10-26T12:00:00.000Z",
  });
}

function createMockRun(contract: MissionContract): RunSnapshot {
  return {
    runId: "run-test-1",
    taskId: "task-test-1",
    status: "RUNNING",
    version: 1,
    attemptCount: 1,
    maxAttempts: 3,
    timeoutMs: 30000,
    idempotencyKey: null,
    currentWorkerId: "worker-test-1",
    leaseId: "lease-test-1",
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
    contractBinding: {
      contractId: contract.spec.contractId,
      version: contract.spec.version,
      contentHash: contract.contentHash,
    },
    resultPayload: null,
    errorPayload: null,
    createdAt: "2026-10-26T12:00:00.000Z",
    updatedAt: "2026-10-26T12:00:00.000Z",
  };
}

/**
 * Returns the anyOf branches from a structured output schema.
 */
function getSchemaBranches(schema: ModelStructuredOutputSchema): readonly any[] {
  return (schema.jsonSchema as any)?.anyOf ?? [];
}

/**
 * Checks whether an action proposal matches any branch in a structured-output JSON Schema.
 */
function matchesSchema(schema: ModelStructuredOutputSchema, proposal: Record<string, unknown>): boolean {
  const branches = getSchemaBranches(schema);
  for (const branch of branches) {
    if (proposal.isGoalReached === true) {
      if (branch.properties?.isGoalReached?.enum?.includes(true)) {
        return true;
      }
    } else {
      const toolNameEnum = branch.properties?.toolName?.enum;
      if (Array.isArray(toolNameEnum) && toolNameEnum.includes(proposal.toolName)) {
        return true;
      }
    }
  }
  return false;
}

// ============================================================================
// 5. Offline Contract Suite (CT-1 through CT-8)
// ============================================================================

describe("Phase 46A: Dynamic Context-Aware Tool Filtering Contract Suite", () => {
  // --------------------------------------------------------------------------
  // CT-1: Initial cold start on unobserved workspace
  // --------------------------------------------------------------------------
  it("CT-1: cold start initializes all tools as ELIGIBLE and emits 7-branch schema", () => {
    const tracker = new ReferenceContextResidencyTracker();
    const coldSnapshot = createMockSnapshot({ includeReadFileObs: false });

    // 1. Tracker has 0 residency records
    expect(tracker.getResidency("src/calc.js")).toBeUndefined();

    // 2. All registered initial tools are ELIGIBLE
    const eligibleTools = tracker.filterEligibleTools(
      INITIAL_TOOL_DEFINITIONS,
      "src/calc.js",
      coldSnapshot
    );
    expect(eligibleTools.length).toBe(7);
    expect(eligibleTools.map((t) => t.name)).toEqual([
      "read_file",
      "write_file",
      "search_code",
      "git_status",
      "git_diff",
      "run_command",
      "edit_file",
    ]);

    // 3. Outbound schema has exactly 7 branches (isGoalReached + 6 tools)
    const schema = deriveActionProposalSchema(eligibleTools);
    expect(schema.name).toBe("action_proposal");
    expect(schema.strict).toBe(true);
    expect(getSchemaBranches(schema).length).toBe(8);

    // 4. Both isGoalReached and read_file match schema branches
    expect(matchesSchema(schema, { isGoalReached: true })).toBe(true);
    expect(matchesSchema(schema, { isGoalReached: false, toolName: "read_file" })).toBe(true);
  });

  // --------------------------------------------------------------------------
  // CT-2: Full successful read of target file
  // --------------------------------------------------------------------------
  it("CT-2: full successful read marks file resident, filters read_file, and emits 6-branch schema", () => {
    const tracker = new ReferenceContextResidencyTracker();
    const fileContent = "function add(a, b) {\n  return a + b + 1;\n}\nmodule.exports = { add };";
    const expectedHash = createHash("sha256").update(fileContent, "utf8").digest("hex");

    // 1. Record full successful read
    const readInput: ReadFileInput = {
      path: "src/calc.js",
      offsetLine: 1,
      limitLines: 500,
    };
    const readOutput: ReadFileOutput = {
      path: "src/calc.js",
      content: fileContent,
      bytesRead: 65,
      totalLines: 4,
      isTruncated: false,
    };

    const record = tracker.recordRead(readInput, readOutput, 1);

    // 2. Verify FileResidencyRecord contract & SHA-256 digest
    expect(record.path).toBe("src/calc.js");
    expect(record.isComplete).toBe(true);
    expect(record.isStale).toBe(false);
    expect(record.totalBytes).toBe(65);
    expect(record.totalLines).toBe(4);
    expect(record.sequenceNumber).toBe(1);
    expect(record.contentHash).toBe(expectedHash);

    // 3. Verify tool transitions to FILTERED
    const snapshotWithFile = createMockSnapshot({ includeReadFileObs: true, filePath: "src/calc.js" });
    const eligibility = tracker.getEligibility("read_file", "src/calc.js", snapshotWithFile);
    expect(eligibility).toBe("FILTERED");

    // 4. Eligible tools exclude read_file
    const eligibleTools = tracker.filterEligibleTools(
      INITIAL_TOOL_DEFINITIONS,
      "src/calc.js",
      snapshotWithFile
    );
    expect(eligibleTools.length).toBe(6);
    expect(eligibleTools.map((t) => t.name)).not.toContain("read_file");
    expect(eligibleTools.map((t) => t.name)).toEqual([
      "write_file",
      "search_code",
      "git_status",
      "git_diff",
      "run_command",
      "edit_file",
    ]);

    // 5. Outbound schema has exactly 7 branches and strictly excludes read_file
    const schema = deriveActionProposalSchema(eligibleTools);
    expect(getSchemaBranches(schema).length).toBe(7);
    expect(matchesSchema(schema, { isGoalReached: false, toolName: "read_file" })).toBe(false);
    expect(matchesSchema(schema, { isGoalReached: false, toolName: "write_file" })).toBe(true);
    expect(matchesSchema(schema, { isGoalReached: true })).toBe(true);
  });

  // --------------------------------------------------------------------------
  // CT-3: Truncated / partial read
  // --------------------------------------------------------------------------
  it("CT-3: partial or truncated read marks isComplete: false and keeps read_file ELIGIBLE", () => {
    const tracker = new ReferenceContextResidencyTracker();

    // Case 3a: Non-initial offset (offsetLine > 1)
    const partialRecord = tracker.recordRead(
      { path: "src/calc.js", offsetLine: 10, limitLines: 50 },
      {
        path: "src/calc.js",
        content: "return a + b + 1;\n",
        bytesRead: 20,
        totalLines: 50,
        isTruncated: false,
      },
      1
    );
    expect(partialRecord.isComplete).toBe(false);

    const snapshot = createMockSnapshot({ includeReadFileObs: true, filePath: "src/calc.js" });
    expect(tracker.getEligibility("read_file", "src/calc.js", snapshot)).toBe("ELIGIBLE");

    // Case 3b: Budget truncation (isTruncated === true)
    const truncatedRecord = tracker.recordRead(
      { path: "src/calc.js", offsetLine: 1, limitLines: 500 },
      {
        path: "src/calc.js",
        content: "function add(a, b) {\n",
        bytesRead: 25,
        totalLines: 100,
        isTruncated: true,
      },
      2
    );
    expect(truncatedRecord.isComplete).toBe(false);
    expect(tracker.getEligibility("read_file", "src/calc.js", snapshot)).toBe("ELIGIBLE");

    // 7-branch schema preserved
    const eligibleTools = tracker.filterEligibleTools(INITIAL_TOOL_DEFINITIONS, "src/calc.js", snapshot);
    const schema = deriveActionProposalSchema(eligibleTools);
    expect(getSchemaBranches(schema).length).toBe(8);
    expect(matchesSchema(schema, { isGoalReached: false, toolName: "read_file" })).toBe(true);
  });

  // --------------------------------------------------------------------------
  // CT-4: Workspace mutation via write_file
  // --------------------------------------------------------------------------
  it("CT-4: workspace mutation marks residency stale and restores read_file to ELIGIBLE", () => {
    const tracker = new ReferenceContextResidencyTracker();
    const snapshot = createMockSnapshot({ includeReadFileObs: true, filePath: "src/calc.js" });

    // Step 1: Full read -> FILTERED
    tracker.recordRead(
      { path: "src/calc.js", offsetLine: 1, limitLines: 500 },
      { path: "src/calc.js", content: "old content", bytesRead: 11, totalLines: 1, isTruncated: false },
      1
    );
    expect(tracker.getEligibility("read_file", "src/calc.js", snapshot)).toBe("FILTERED");

    // Step 2: write_file mutation occurs
    tracker.recordWorkspaceMutation("src/calc.js", 2);

    // Verify residency record is stale
    const record = tracker.getResidency("src/calc.js");
    expect(record?.isStale).toBe(true);

    // Verify eligibility transitions to RESTORED
    const eligibility = tracker.getEligibility("read_file", "src/calc.js", snapshot);
    expect(eligibility).toBe("RESTORED");

    // Eligible tools and schema return to full 7 branches
    const eligibleTools = tracker.filterEligibleTools(INITIAL_TOOL_DEFINITIONS, "src/calc.js", snapshot);
    expect(eligibleTools.map((t) => t.name)).toContain("read_file");

    const schema = deriveActionProposalSchema(eligibleTools);
    expect(getSchemaBranches(schema).length).toBe(8);
    expect(matchesSchema(schema, { isGoalReached: false, toolName: "read_file" })).toBe(true);
  });

  // --------------------------------------------------------------------------
  // CT-5: Context budget eviction
  // --------------------------------------------------------------------------
  it("CT-5: context budget eviction revokes residency and restores read_file", () => {
    const tracker = new ReferenceContextResidencyTracker();

    // Step 1: Full read recorded
    tracker.recordRead(
      { path: "src/calc.js", offsetLine: 1, limitLines: 500 },
      { path: "src/calc.js", content: "code", bytesRead: 4, totalLines: 1, isTruncated: false },
      1
    );

    // Step 2: Next step snapshot has context pressure: observation omitted
    const evictedSnapshot = createMockSnapshot({
      includeReadFileObs: false, // Evicted from snapshot observations
      omittedCount: 2,
    });

    // Verify eligibility restores read_file
    const eligibility = tracker.getEligibility("read_file", "src/calc.js", evictedSnapshot);
    expect(eligibility).toBe("RESTORED");

    const eligibleTools = tracker.filterEligibleTools(INITIAL_TOOL_DEFINITIONS, "src/calc.js", evictedSnapshot);
    const schema = deriveActionProposalSchema(eligibleTools);
    expect(getSchemaBranches(schema).length).toBe(8);
    expect(matchesSchema(schema, { isGoalReached: false, toolName: "read_file" })).toBe(true);
  });

  // --------------------------------------------------------------------------
  // CT-6: Multi-file request
  // --------------------------------------------------------------------------
  it("CT-6: residency of one file preserves read_file eligibility for unobserved files", () => {
    const tracker = new ReferenceContextResidencyTracker();
    const snapshot = createMockSnapshot({ includeReadFileObs: true, filePath: "src/calc.js" });

    // Target file src/calc.js is read and resident
    tracker.recordRead(
      { path: "src/calc.js", offsetLine: 1, limitLines: 500 },
      { path: "src/calc.js", content: "calc code", bytesRead: 9, totalLines: 1, isTruncated: false },
      1
    );

    // src/calc.js is FILTERED
    expect(tracker.getEligibility("read_file", "src/calc.js", snapshot)).toBe("FILTERED");

    // But unobserved file test/f2p.test.js remains ELIGIBLE
    expect(tracker.getResidency("test/f2p.test.js")).toBeUndefined();
    expect(tracker.getEligibility("read_file", "test/f2p.test.js", snapshot)).toBe("ELIGIBLE");

    const eligibleToolsForUnread = tracker.filterEligibleTools(
      INITIAL_TOOL_DEFINITIONS,
      "test/f2p.test.js",
      snapshot
    );
    expect(eligibleToolsForUnread.map((t) => t.name)).toContain("read_file");

    const schema = deriveActionProposalSchema(eligibleToolsForUnread);
    expect(getSchemaBranches(schema).length).toBe(8);
  });

  // --------------------------------------------------------------------------
  // CT-7: Read-only task classification
  // --------------------------------------------------------------------------
  it("CT-7: pure navigation tasks bypass tool filtering entirely", () => {
    const tracker = new ReferenceContextResidencyTracker();
    const snapshot = createMockSnapshot({ includeReadFileObs: true, filePath: "src/calc.js" });

    // File is completely read
    tracker.recordRead(
      { path: "src/calc.js", offsetLine: 1, limitLines: 500 },
      { path: "src/calc.js", content: "code", bytesRead: 4, totalLines: 1, isTruncated: false },
      1
    );

    // For standard repair task, read_file is filtered
    expect(tracker.getEligibility("read_file", "src/calc.js", snapshot)).toBe("FILTERED");

    // For CODE_NAVIGATION task, filtering is bypassed (Rule 7)
    const navEligibility = tracker.getEligibility(
      "read_file",
      "src/calc.js",
      snapshot,
      "CODE_NAVIGATION"
    );
    expect(navEligibility).toBe("ELIGIBLE");

    const eligibleTools = tracker.filterEligibleTools(
      INITIAL_TOOL_DEFINITIONS,
      "src/calc.js",
      snapshot,
      "CODE_NAVIGATION"
    );
    expect(eligibleTools.map((t) => t.name)).toContain("read_file");
  });

  // --------------------------------------------------------------------------
  // CT-8: Grammar compilation parity & Governance Preservation
  // --------------------------------------------------------------------------
  describe("CT-8: Grammar compilation parity & Governance Preservation", () => {
    it("Case 8a: verifies 6-branch schema preserves Ollama-compatible structure and strict constraints", () => {
      const fiveTools = INITIAL_TOOL_DEFINITIONS.filter((t) => t.name !== "read_file");
      const schema6 = deriveActionProposalSchema(fiveTools);
      const branches6 = getSchemaBranches(schema6);

      expect(schema6.name).toBe("action_proposal");
      expect(schema6.strict).toBe(true);
      expect(schema6.jsonSchema.type).toBe("object");
      expect(branches6.length).toBe(7);

      // Verify each branch has additionalProperties: false and required fields
      for (const branch of branches6) {
        expect(branch.type).toBe("object");
        expect(branch.additionalProperties).toBe(false);
        expect(Array.isArray(branch.required)).toBe(true);
      }

      // Verify read_file is completely excluded
      const toolNamesInSchema = branches6
        .map((b) => b.properties?.toolName?.enum?.[0])
        .filter(Boolean);
      expect(toolNamesInSchema).toEqual([
        "write_file",
        "search_code",
        "git_status",
        "git_diff",
        "run_command",
        "edit_file",
      ]);
      expect(toolNamesInSchema).not.toContain("read_file");
    });

    it("Case 8b: rollback configuration (enableDynamicToolFiltering: false) unconditionally preserves 7-branch schema", () => {
      const fiveTools = INITIAL_TOOL_DEFINITIONS.filter((t) => t.name !== "read_file");

      // When flag is false, static 7-branch schema is unconditionally returned
      const rolledBackSchema = deriveActionProposalSchema(fiveTools, {
        enableDynamicToolFiltering: false,
      });

      expect(rolledBackSchema).toBe(ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA);
      expect(getSchemaBranches(rolledBackSchema).length).toBe(8);
      expect(matchesSchema(rolledBackSchema, { isGoalReached: false, toolName: "read_file" })).toBe(true);
    });

    it("Case 8c: production ProposalValidator and PolicyEvaluator remain authoritative and independent", () => {
      const contract = createMockContract();
      const run = createMockRun(contract);
      const snapshot = createMockSnapshot();
      const validationContext: ProposalValidationContext = {
        runId: run.runId,
        contextSnapshot: snapshot,
        workerId: "worker-test-1",
        leaseId: "lease-test-1",
        run,
        contract,
      };

      const validator = new ProposalValidator();

      // Even if read_file were filtered from model grammar, ProposalValidator
      // authoritatively validates it against the actual domain tool registry and policy
      const readFileProposal = {
        proposalId: "prop-ct8-1",
        toolName: "read_file" as ToolName,
        inputPayload: {
          path: "src/calc.js",
          offsetLine: 1,
          limitLines: 50,
        },
        contextSnapshotHash: TEST_CONTEXT_HASH,
        rationale: "Legitimate verification read",
      };

      const validResult = validator.validate(readFileProposal, validationContext);
      expect(validResult.valid).toBe(true);

      // Verify capability-based governance enforcement via PolicyEvaluator
      const readPolicyCheck = PolicyEvaluator.evaluateCapability(
        "workspace.file.read",
        contract.spec.policy
      );
      expect(readPolicyCheck.allowed).toBe(true);
      expect(readPolicyCheck.status).toBe("ALLOWED");

      // Verify policy denial when capability is revoked
      const restrictedPolicy = createExecutionPolicy({
        policyId: "policy-restricted",
        allowedCapabilities: ["process.execute"], // file read/write revoked
        isolationRequirement: "ISOLATED",
      });
      const deniedPolicyCheck = PolicyEvaluator.evaluateCapability(
        "workspace.file.read",
        restrictedPolicy
      );
      expect(deniedPolicyCheck.allowed).toBe(false);
      expect(deniedPolicyCheck.status).toBe("DENIED");
      expect(deniedPolicyCheck.reasonCode).toBe("CAPABILITY_NOT_GRANTED");
    });
  });
});

// ============================================================================
// 6. Phase 46B Production Code Verification Suite
// ============================================================================

describe("Phase 46B: Production ContextResidencyTracker & Brain Projection Verification", () => {
  const dummyProvider: ModelProviderPort = {
    providerName: "mock-provider",
    generate: async () => ({
      requestId: "req-prod-1",
      model: "test-model",
      outputText: JSON.stringify({
        isGoalReached: true,
        proposalId: "prop-prod-1",
        contextSnapshotHash: TEST_CONTEXT_HASH,
      }),
      finishReason: "STOP",
      durationMs: 1,
      message: {
        role: "assistant",
        content: JSON.stringify({
          isGoalReached: true,
          proposalId: "prop-prod-1",
          contextSnapshotHash: TEST_CONTEXT_HASH,
        }),
      },
    }),
  };

  it("exercises production ContextResidencyTracker: enforces complete read, filtering, and invalidation", () => {
    // 1. Instantiation with enableDynamicToolFiltering: true
    const tracker = new ContextResidencyTracker({ enableDynamicToolFiltering: true });
    expect(tracker.isEnabled()).toBe(true);

    const snapshotWithFile = createMockSnapshot({ includeReadFileObs: true, filePath: "src/calc.js" });
    const content = "function add(a, b) {\n  return a + b + 1;\n}\n";

    // Cold start: ELIGIBLE
    expect(tracker.getEligibility("read_file", "src/calc.js", snapshotWithFile)).toBe("ELIGIBLE");

    // Full read: records residency and transitions to FILTERED
    tracker.recordRead(
      { path: "src/calc.js", offsetLine: 1, limitLines: 500 },
      { path: "src/calc.js", content, bytesRead: content.length, totalLines: 3, isTruncated: false },
      1
    );

    const rec = tracker.getResidency("src/calc.js");
    expect(rec).toBeDefined();
    expect(rec?.isComplete).toBe(true);
    expect(rec?.isStale).toBe(false);
    expect(tracker.getEligibility("read_file", "src/calc.js", snapshotWithFile)).toBe("FILTERED");

    // filterEligibleTools excludes read_file
    const filteredTools = tracker.filterEligibleTools(INITIAL_TOOL_DEFINITIONS, "src/calc.js", snapshotWithFile);
    expect(filteredTools.length).toBe(6);
    expect(filteredTools.map((t) => t.name)).not.toContain("read_file");

    // Workspace mutation invalidates residency and restores read_file
    tracker.recordWorkspaceMutation("src/calc.js", 2);
    expect(tracker.getResidency("src/calc.js")?.isStale).toBe(true);
    expect(tracker.getEligibility("read_file", "src/calc.js", snapshotWithFile)).toBe("RESTORED");

    const restoredTools = tracker.filterEligibleTools(INITIAL_TOOL_DEFINITIONS, "src/calc.js", snapshotWithFile);
    expect(restoredTools.length).toBe(7);
    expect(restoredTools.map((t) => t.name)).toContain("read_file");
  });

  it("exercises production ContextResidencyTracker default-off behavior: preserves ELIGIBLE unconditionally", () => {
    // Default constructor: enableDynamicToolFiltering defaults strictly to false
    const tracker = new ContextResidencyTracker();
    expect(tracker.isEnabled()).toBe(false);

    const snapshot = createMockSnapshot({ includeReadFileObs: true, filePath: "src/calc.js" });
    tracker.recordRead(
      { path: "src/calc.js", offsetLine: 1, limitLines: 500 },
      { path: "src/calc.js", content: "some code", bytesRead: 9, totalLines: 1, isTruncated: false },
      1
    );

    // When disabled, getEligibility is unconditionally ELIGIBLE
    expect(tracker.getEligibility("read_file", "src/calc.js", snapshot)).toBe("ELIGIBLE");

    const tools = tracker.filterEligibleTools(INITIAL_TOOL_DEFINITIONS, "src/calc.js", snapshot);
    expect(tools.length).toBe(7);
    expect(tools.map((t) => t.name)).toContain("read_file");
  });

  it("exercises production deriveActionProposalSchema: derives 6 branches when filtered, 7 when disabled", () => {
    const fiveTools = INITIAL_TOOL_DEFINITIONS.filter((t) => t.name !== "read_file");

    // Production deriveActionProposalSchema with enabled filtering
    const schema = productionDeriveActionProposalSchema(fiveTools, { enableDynamicToolFiltering: true });
    expect(schema.name).toBe("action_proposal");
    expect(schema.strict).toBe(true);
    expect((schema.jsonSchema as any).anyOf.length).toBe(7);

    const toolNames = (schema.jsonSchema as any).anyOf
      .map((b: any) => b.properties?.toolName?.enum?.[0])
      .filter(Boolean);
    expect(toolNames).not.toContain("read_file");
    expect(toolNames).toContain("write_file");

    // Production deriveActionProposalSchema with disabled filtering: returns static constant unconditionally
    const defaultOffSchema = productionDeriveActionProposalSchema(fiveTools, { enableDynamicToolFiltering: false });
    expect(defaultOffSchema).toBe(ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA);
    expect((defaultOffSchema.jsonSchema as any).anyOf.length).toBe(8);
  });

  it("exercises production LiveAgentBrain: default-off preserves static schema, enabled projects dynamic schema", () => {
    const fiveTools = INITIAL_TOOL_DEFINITIONS.filter((t) => t.name !== "read_file");
    const snapshot = createMockSnapshot();

    // 1. Default LiveAgentBrain (enableDynamicToolFiltering: false / undefined)
    const defaultBrain = new LiveAgentBrain({
      modelProvider: dummyProvider,
      model: "test-model",
    });

    const defaultRequest = defaultBrain.buildModelRequest({
      runId: "run-prod-1",
      contextSnapshot: snapshot,
      availableTools: fiveTools,
      sequenceNumber: 1,
    });

    // Outbound structuredOutput is the static 7-branch constant regardless of availableTools
    expect(defaultRequest.generation).toBeDefined();
    expect(defaultRequest.generation!.structuredOutput).toBe(ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA);
    expect((defaultRequest.generation!.structuredOutput?.jsonSchema as any).anyOf.length).toBe(8);

    // 2. Enabled LiveAgentBrain (enableDynamicToolFiltering: true)
    const enabledBrain = new LiveAgentBrain({
      modelProvider: dummyProvider,
      model: "test-model",
      enableDynamicToolFiltering: true,
    });

    const enabledRequest = enabledBrain.buildModelRequest({
      runId: "run-prod-2",
      contextSnapshot: snapshot,
      availableTools: fiveTools,
      sequenceNumber: 1,
    });

    // Outbound structuredOutput is dynamically reduced to 6 branches
    expect(enabledRequest.generation).toBeDefined();
    expect((enabledRequest.generation!.structuredOutput?.jsonSchema as any).anyOf.length).toBe(7);
    const branchToolNames = (enabledRequest.generation!.structuredOutput?.jsonSchema as any).anyOf
      .map((b: any) => b.properties?.toolName?.enum?.[0])
      .filter(Boolean);
    expect(branchToolNames).not.toContain("read_file");
  });

  it("exercises production AgentStepController: exposes residency tracker and preserves default-off behavior", () => {
    const store = new SqliteStateStore();
    const clock = new SettableClock(new Date("2026-10-26T12:00:00Z"));
    const coordinator = new RunCoordinator(store, clock);
    const workerRuntime = new WorkerRuntime({
      coordinator,
      clock,
    });

    const brain = new LiveAgentBrain({
      modelProvider: dummyProvider,
      model: "test-model",
    });

    // Default controller
    const defaultController = new AgentStepController({
      coordinator,
      stateStore: store,
      workerRuntime,
      agentBrain: brain,
      clock,
    });

    expect(defaultController.getContextResidencyTracker()).toBeDefined();
    expect(defaultController.getContextResidencyTracker().isEnabled()).toBe(false);

    // Enabled controller
    const enabledController = new AgentStepController({
      coordinator,
      stateStore: store,
      workerRuntime,
      agentBrain: brain,
      clock,
      enableDynamicToolFiltering: true,
    });

    expect(enabledController.getContextResidencyTracker().isEnabled()).toBe(true);
  });
});
