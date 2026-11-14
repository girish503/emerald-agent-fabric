/**
 * Provider-Neutral Live Agent Brain for Emerald Agent Fabric.
 *
 * Implements the application-layer bridge between the governed reasoning
 * loop (AgentStepController via AgentBrainPort) and the provider-neutral
 * inference interface (ModelProviderPort).
 *
 * Architectural Invariants:
 * 1. Model != Authority: The model is strictly an untrusted reasoning component.
 *    Model output is NEVER authoritative. It cannot grant capabilities, modify
 *    contracts, change workspaces, mutate persistence, or directly invoke tools.
 * 2. Information Inflow: Brain receives only bounded ContextSnapshot and tool definitions.
 *    It receives zero infrastructure authority (no workerId, leaseId, contracts, DB handles).
 * 3. Proposal Outflow: Brain produces UNTRUSTED ActionProposals. Proposals must pass
 *    through ProposalValidator before becoming trusted Action aggregates.
 * 4. Single-Attempt Semantics: One proposeAction() call executes at most one
 *    ModelProviderPort.generate() invocation. Zero internal retry or backoff loops.
 * 5. Cooperative Cancellation: AbortSignal is propagated to ModelProviderPort and never swallowed.
 * 6. Explicit Timeouts: request timeoutMs enforces an inference-level ceiling, decoupled
 *    from the step controller's wall-clock loop budget.
 * 7. Zero Side Effects: LiveAgentBrain touches zero tool adapters, zero execution providers,
 *    and mutates zero database records (providerInvocationCount === 0).
 */

import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import {
  ActionProposal,
  ActionProposalSchema,
  ACTION_PROPOSAL_TOOL_NAMES,
  findForbiddenAuthorityKeys,
  MAX_PROPOSAL_BYTES,
  MAX_RATIONALE_LENGTH,
} from "../domain/action-proposal.js";
import { canonicalJsonStringify } from "../domain/canonical-hash.js";
import {
  ModelRequestCancelledError,
  ModelResponseInvalidError,
} from "../domain/errors.js";
import {
  ModelGenerationOptions,
  ModelMessage,
  ModelProviderRequest,
  ModelStructuredOutputSchema,
  validateModelProviderResponse,
} from "../domain/model-provider.js";
import { ToolDefinition, ToolName } from "../domain/tool.js";
import { formatModelFacingToolCatalog } from "../domain/tool-projection.js";
import { ObservationCategory } from "../domain/context.js";
import {
  AgentBrainPort,
  AgentBrainRequest,
  AgentBrainResult,
  BrainModelMetadata,
} from "../ports/agent-brain.port.js";
import { ClockPort, SystemClock } from "../ports/clock.port.js";
import { ModelProviderPort } from "../ports/model-provider.port.js";

// ============================================================================
// 1. Default System Instruction
// ============================================================================

export const DEFAULT_LIVE_BRAIN_SYSTEM_INSTRUCTION = `You are a reasoning component within the Emerald Agent Fabric.
Your role is to propose actions to achieve the assigned mission task.
You are a reasoning component.
You propose actions.
You do not execute actions.
You do not possess authority.
Your output is untrusted.
The execution system will independently validate your proposal.

Operational Rules:
1. Inspect the provided execution context observations carefully.
2. Select an appropriate registered tool from the available tools list.
3. Propose exact, bounded input arguments matching the tool's parameter schema. In tool inputPayload, the target file path parameter must always be named path (never filePath or file_path).
4. If the mission goal is fully achieved, output an action proposal indicating completion (isGoalReached: true).
5. Never attempt to specify infrastructure authority fields (workerId, leaseId, contracts, capabilities, mount paths, retry limits, execution status).
6. Format your response strictly according to the required action proposal schema.`;

// ============================================================================
// 2. Structured Output Schema Descriptor
// ============================================================================

// ============================================================================

export const EDIT_FILE_SCHEMA_BRANCH = Object.freeze({
  type: "object",
  description: "edit_file action proposal for line-anchored search-and-replace",
  properties: {
    isGoalReached: {
      type: "boolean",
      enum: [false],
      description: "Must be false when proposing a tool action",
    },
    proposalId: {
      type: "string",
      description: "Unique client-generated proposal identifier",
    },
    toolName: {
      type: "string",
      enum: ["edit_file"],
      description: "Name of the registered tool to invoke",
    },
    contextSnapshotHash: {
      type: "string",
      description:
        "The exact 64-character hexadecimal SHA-256 contextHash from snapshot",
    },
    rationale: {
      type: "string",
      description: "Brief rationale explaining why this edit is proposed",
    },
    sequenceHint: {
      type: "integer",
      description: "Optional sequence hint",
    },
    inputPayload: {
      type: "object",
      description: "Input parameters for edit_file",
      properties: {
        path: {
          type: "string",
          description: "Relative path to file within workspace sandbox",
        },
        searchAnchor: {
          type: "string",
          description: "Exact text segment to locate and replace",
        },
        replacementText: {
          type: "string",
          description: "Exact replacement text to substitute for searchAnchor",
        },
        allowMultipleMatches: {
          type: "boolean",
          default: false,
          description: "Whether to allow replacing multiple matches (default false)",
        },
        maxBytes: {
          type: "integer",
          minimum: 1,
          description: "Requested maximum bytes to write",
        },
      },
      required: ["path", "searchAnchor", "replacementText"],
      additionalProperties: false,
    },
  },
  required: [
    "isGoalReached",
    "proposalId",
    "toolName",
    "inputPayload",
    "contextSnapshotHash",
  ],
  additionalProperties: false,
});

/**
 * Options for deriving action proposal structured output schemas.
 */

export const ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA: ModelStructuredOutputSchema =
  Object.freeze({
    name: "action_proposal",
    description:
      "Untrusted action proposal or completion signal for Emerald agent reasoning",
    strict: true,
    jsonSchema: Object.freeze({
      anyOf: [
        // Branch 1: Goal-reached completion signal (no tool execution)
        {
          type: "object",
          description: "Goal-reached completion signal (no tool execution)",
          properties: {
            isGoalReached: {
              type: "boolean",
              enum: [true],
              description: "Must be true when task goal is fully achieved",
            },
            proposalId: {
              type: "string",
              description: "Unique client-generated proposal identifier",
            },
            contextSnapshotHash: {
              type: "string",
              description:
                "The exact 64-character hexadecimal SHA-256 contextHash from snapshot",
            },
            rationale: {
              type: "string",
              description:
                "Brief rationale explaining how the goal was achieved",
            },
          },
          required: ["isGoalReached", "proposalId", "contextSnapshotHash"],
          additionalProperties: false,
        },

        // Branch 2: read_file action proposal
        {
          type: "object",
          description: "read_file action proposal",
          properties: {
            isGoalReached: {
              type: "boolean",
              enum: [false],
              description: "Must be false when proposing a tool action",
            },
            proposalId: {
              type: "string",
              description: "Unique client-generated proposal identifier",
            },
            toolName: {
              type: "string",
              enum: ["read_file"],
              description: "Name of the registered tool to invoke",
            },
            contextSnapshotHash: {
              type: "string",
              description:
                "The exact 64-character hexadecimal SHA-256 contextHash from snapshot",
            },
            rationale: {
              type: "string",
              description:
                "Brief rationale explaining why this action is proposed",
            },
            sequenceHint: {
              type: "integer",
              description: "Optional sequence hint",
            },
            inputPayload: {
              type: "object",
              description: "Input parameters for read_file",
              properties: {
                path: {
                  type: "string",
                  description: "Relative path to file within workspace sandbox",
                },
                offsetLine: {
                  type: "integer",
                  minimum: 1,
                  default: 1,
                  description: "Starting line number (1-indexed)",
                },
                limitLines: {
                  type: "integer",
                  minimum: 1,
                  maximum: 5000,
                  default: 500,
                  description: "Maximum number of lines to read",
                },
                maxBytes: {
                  type: "integer",
                  minimum: 1,
                  description: "Maximum output bytes to read",
                },
              },
              required: ["path"],
              additionalProperties: false,
            },
          },
          required: [
            "isGoalReached",
            "proposalId",
            "toolName",
            "inputPayload",
            "contextSnapshotHash",
          ],
          additionalProperties: false,
        },

        // Branch 3: write_file action proposal
        {
          type: "object",
          description: "write_file action proposal",
          properties: {
            isGoalReached: {
              type: "boolean",
              enum: [false],
              description: "Must be false when proposing a tool action",
            },
            proposalId: {
              type: "string",
              description: "Unique client-generated proposal identifier",
            },
            toolName: {
              type: "string",
              enum: ["write_file"],
              description: "Name of the registered tool to invoke",
            },
            contextSnapshotHash: {
              type: "string",
              description:
                "The exact 64-character hexadecimal SHA-256 contextHash from snapshot",
            },
            rationale: {
              type: "string",
              description:
                "Brief rationale explaining why this action is proposed",
            },
            sequenceHint: {
              type: "integer",
              description: "Optional sequence hint",
            },
            inputPayload: {
              type: "object",
              description: "Input parameters for write_file",
              properties: {
                path: {
                  type: "string",
                  description: "Relative path to file within workspace sandbox",
                },
                content: {
                  type: "string",
                  description: "UTF-8 text content to write",
                },
                overwrite: {
                  type: "boolean",
                  default: true,
                  description: "Whether to overwrite existing file",
                },
                maxBytes: {
                  type: "integer",
                  minimum: 1,
                  description: "Maximum bytes allowed to write",
                },
              },
              required: ["path", "content"],
              additionalProperties: false,
            },
          },
          required: [
            "isGoalReached",
            "proposalId",
            "toolName",
            "inputPayload",
            "contextSnapshotHash",
          ],
          additionalProperties: false,
        },

        // Branch 4: search_code action proposal
        {
          type: "object",
          description: "search_code action proposal",
          properties: {
            isGoalReached: {
              type: "boolean",
              enum: [false],
              description: "Must be false when proposing a tool action",
            },
            proposalId: {
              type: "string",
              description: "Unique client-generated proposal identifier",
            },
            toolName: {
              type: "string",
              enum: ["search_code"],
              description: "Name of the registered tool to invoke",
            },
            contextSnapshotHash: {
              type: "string",
              description:
                "The exact 64-character hexadecimal SHA-256 contextHash from snapshot",
            },
            rationale: {
              type: "string",
              description:
                "Brief rationale explaining why this action is proposed",
            },
            sequenceHint: {
              type: "integer",
              description: "Optional sequence hint",
            },
            inputPayload: {
              type: "object",
              description: "Input parameters for search_code",
              properties: {
                query: {
                  type: "string",
                  description: "Search string or regex query",
                },
                isRegex: {
                  type: "boolean",
                  default: false,
                  description: "Whether query is a regular expression",
                },
                path: {
                  type: "string",
                  default: ".",
                  description: "Workspace directory to search within",
                },
                filePattern: {
                  type: "string",
                  default: "*",
                  description: "Glob pattern to filter filenames",
                },
                maxResults: {
                  type: "integer",
                  minimum: 1,
                  maximum: 1000,
                  default: 50,
                  description: "Maximum matches to return",
                },
                maxBytes: {
                  type: "integer",
                  minimum: 1,
                  description: "Maximum output bytes",
                },
              },
              required: ["query"],
              additionalProperties: false,
            },
          },
          required: [
            "isGoalReached",
            "proposalId",
            "toolName",
            "inputPayload",
            "contextSnapshotHash",
          ],
          additionalProperties: false,
        },

        // Branch 5: git_status action proposal
        {
          type: "object",
          description: "git_status action proposal",
          properties: {
            isGoalReached: {
              type: "boolean",
              enum: [false],
              description: "Must be false when proposing a tool action",
            },
            proposalId: {
              type: "string",
              description: "Unique client-generated proposal identifier",
            },
            toolName: {
              type: "string",
              enum: ["git_status"],
              description: "Name of the registered tool to invoke",
            },
            contextSnapshotHash: {
              type: "string",
              description:
                "The exact 64-character hexadecimal SHA-256 contextHash from snapshot",
            },
            rationale: {
              type: "string",
              description:
                "Brief rationale explaining why this action is proposed",
            },
            sequenceHint: {
              type: "integer",
              description: "Optional sequence hint",
            },
            inputPayload: {
              type: "object",
              description: "Input parameters for git_status",
              properties: {
                path: {
                  type: "string",
                  description: "Directory path within workspace",
                },
              },
              required: [],
              additionalProperties: false,
            },
          },
          required: [
            "isGoalReached",
            "proposalId",
            "toolName",
            "inputPayload",
            "contextSnapshotHash",
          ],
          additionalProperties: false,
        },

        // Branch 6: git_diff action proposal
        {
          type: "object",
          description: "git_diff action proposal",
          properties: {
            isGoalReached: {
              type: "boolean",
              enum: [false],
              description: "Must be false when proposing a tool action",
            },
            proposalId: {
              type: "string",
              description: "Unique client-generated proposal identifier",
            },
            toolName: {
              type: "string",
              enum: ["git_diff"],
              description: "Name of the registered tool to invoke",
            },
            contextSnapshotHash: {
              type: "string",
              description:
                "The exact 64-character hexadecimal SHA-256 contextHash from snapshot",
            },
            rationale: {
              type: "string",
              description:
                "Brief rationale explaining why this action is proposed",
            },
            sequenceHint: {
              type: "integer",
              description: "Optional sequence hint",
            },
            inputPayload: {
              type: "object",
              description: "Input parameters for git_diff",
              properties: {
                path: {
                  type: "string",
                  description: "Directory path within workspace",
                },
                staged: {
                  type: "boolean",
                  default: false,
                  description: "Whether to diff staged changes",
                },
                maxBytes: {
                  type: "integer",
                  minimum: 1,
                  description: "Maximum diff bytes",
                },
              },
              required: [],
              additionalProperties: false,
            },
          },
          required: [
            "isGoalReached",
            "proposalId",
            "toolName",
            "inputPayload",
            "contextSnapshotHash",
          ],
          additionalProperties: false,
        },

        // Branch 7: run_command action proposal
        {
          type: "object",
          description: "run_command action proposal",
          properties: {
            isGoalReached: {
              type: "boolean",
              enum: [false],
              description: "Must be false when proposing a tool action",
            },
            proposalId: {
              type: "string",
              description: "Unique client-generated proposal identifier",
            },
            toolName: {
              type: "string",
              enum: ["run_command"],
              description: "Name of the registered tool to invoke",
            },
            contextSnapshotHash: {
              type: "string",
              description:
                "The exact 64-character hexadecimal SHA-256 contextHash from snapshot",
            },
            rationale: {
              type: "string",
              description:
                "Brief rationale explaining why this action is proposed",
            },
            sequenceHint: {
              type: "integer",
              description: "Optional sequence hint",
            },
            inputPayload: {
              type: "object",
              description: "Input parameters for run_command",
              properties: {
                argv: {
                  type: "array",
                  items: { type: "string" },
                  minItems: 1,
                  description:
                    "Array of discrete arguments where argv[0] is executable name",
                },
                cwd: {
                  type: "string",
                  default: ".",
                  description:
                    "Working directory relative to workspace sandbox",
                },
                timeoutMs: {
                  type: "integer",
                  minimum: 1,
                  description: "Timeout in milliseconds",
                },
                maxOutputBytes: {
                  type: "integer",
                  minimum: 1,
                  description: "Maximum output bytes",
                },
              },
              required: ["argv"],
              additionalProperties: false,
            },
          },
          required: [
            "isGoalReached",
            "proposalId",
            "toolName",
            "inputPayload",
            "contextSnapshotHash",
          ],
          additionalProperties: false,
        },
        // Branch 8: edit_file action proposal
        EDIT_FILE_SCHEMA_BRANCH,
      ],
    }),
  });

// ============================================================================
// 2.5 Dynamic Schema Derivation
export interface ActionProposalSchemaOptions {
  readonly enableDynamicToolFiltering?: boolean;
  readonly governedBenchmarkRepairMode?: boolean;
  readonly allowWholeFileReplacement?: boolean;
}

/**
 * Derives a dynamic action proposal structured-output JSON Schema based on currently eligible tools.
 * In governed benchmark repair mode (without whole-file replacement), write_file's overwrite property
 * is omitted to strictly align the model-facing schema with runtime governance.
 */
export function deriveActionProposalSchema(
  availableTools: readonly ToolDefinition[],
  options?: ActionProposalSchemaOptions
): ModelStructuredOutputSchema {
  const isBenchmarkRepair = Boolean(
    options?.governedBenchmarkRepairMode && !options?.allowWholeFileReplacement
  );

  if (options?.enableDynamicToolFiltering === false && !isBenchmarkRepair) {
    return ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA;
  }

  const eligibleToolNames = new Set(availableTools.map((t) => t.name));
  const staticBranches = (ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA.jsonSchema as any).anyOf;

  // Branch 0 is isGoalReached (always present)
  const goalReachedBranch = staticBranches[0];

  // Tool branches: filter by eligible tools if dynamic filtering is enabled, else retain static branches
  const rawBranches = options?.enableDynamicToolFiltering === false
    ? staticBranches.slice(1)
    : staticBranches.slice(1).filter((branch: any) => {
        const toolName = branch.properties?.toolName?.enum?.[0];
        return toolName && eligibleToolNames.has(toolName);
      });

  const toolBranches = rawBranches.map((branch: any) => {
    const toolName = branch.properties?.toolName?.enum?.[0];
    if (toolName === "write_file" && isBenchmarkRepair) {
      const inputProperties = { ...(branch.properties?.inputPayload?.properties ?? {}) };
      delete inputProperties["overwrite"];
      return {
        ...branch,
        description:
          "write_file action proposal for creating new files (direct overwrite of existing files is disallowed; use edit_file)",
        properties: {
          ...branch.properties,
          inputPayload: {
            ...branch.properties?.inputPayload,
            description: "Input parameters for write_file (new files only)",
            properties: inputProperties,
            required: ["path", "content"],
            additionalProperties: false,
          },
        },
      };
    }
    return branch;
  });

  if (
    eligibleToolNames.has("edit_file") &&
    !toolBranches.some((b: any) => b.properties?.toolName?.enum?.[0] === "edit_file")
  ) {
    toolBranches.push(EDIT_FILE_SCHEMA_BRANCH);
  }

  return Object.freeze({
    name: "action_proposal",
    strict: true,
    jsonSchema: Object.freeze({
      type: "object",
      anyOf: Object.freeze([goalReachedBranch, ...toolBranches]),
    }),
  });
}

/**
 * Internal digest keys excluded from model-facing observation projections.
 * Preserves complete digest values in internal events, state store, evidence bundles,
 * audit records, and replay inputs while eliminating raw hash strings from model prompts.
 */
export const INTERNAL_DIGEST_FIELDS: ReadonlySet<string> = new Set([
  "originalDigest",
  "resultingDigest",
  "contentHash",
]);

/**
 * Projects an observation's structured content for model-facing prompt presentation.
 * Omits internal synchronization and evidence digests (originalDigest, resultingDigest, contentHash)
 * from tool result payloads while strictly preserving target paths, operational status, and source code.
 */
export function projectModelFacingObservationContent(
  category: ObservationCategory,
  content: Record<string, unknown>
): Record<string, unknown> {
  if (category === "TOOL_RESULT" && content.output && typeof content.output === "object") {
    const rawOutput = content.output as Record<string, unknown>;
    const safeOutput: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawOutput)) {
      if (!INTERNAL_DIGEST_FIELDS.has(k)) {
        safeOutput[k] = v;
      }
    }
    return {
      ...content,
      output: safeOutput,
    };
  }
  return content;
}

/**
 * Model-facing category display order for governed benchmark repair flows.
 * Positions actionable VERIFICATION feedback and recovery guidance with maximum recency,
 * immediately preceding ## Required Action, avoiding displacement by low-level metadata.
 */
export const GOVERNED_REPAIR_OBSERVATION_DISPLAY_ORDER: readonly ObservationCategory[] = [
  "RUN_STATE",
  "MISSION_CONTEXT",
  "ATTEMPT_HISTORY",
  "ACTION_HISTORY",
  "SYSTEM_EVENT",
  "EVIDENCE",
  "WORKSPACE_STATE",
  "TOOL_RESULT",
  "TOOL_ERROR",
  "VERIFICATION",
] as const;

// ============================================================================
// 3. Configuration Options
// ============================================================================

export interface LiveAgentBrainOptions {
  readonly modelProvider: ModelProviderPort;
  readonly model: string;
  readonly systemInstruction?: string;
  readonly generationOptions?: Partial<ModelGenerationOptions>;
  readonly timeoutMs?: number;
  readonly clock?: ClockPort;
  readonly requestIdGenerator?: () => string;
  /**
   * Whether dynamic context-aware tool filtering is enabled.
   * Default: false (preserves static 7-branch schema).
   */
  readonly enableDynamicToolFiltering?: boolean;
  /**
   * Explicit override for governed benchmark repair mode.
   * When undefined, auto-detects from contextSnapshot MISSION_CONTEXT policy.
   */
  readonly governedBenchmarkRepairMode?: boolean;
}

// ============================================================================
// 4. LiveAgentBrain Implementation
// ============================================================================

export class LiveAgentBrain implements AgentBrainPort {
  private readonly modelProvider: ModelProviderPort;
  private readonly model: string;
  private readonly systemInstruction: string;
  private readonly generationOptions?: Partial<ModelGenerationOptions>;
  private readonly timeoutMs: number;
  readonly clock: ClockPort;
  private readonly requestIdGenerator: () => string;
  private readonly enableDynamicToolFiltering: boolean;
  private readonly governedBenchmarkRepairMode?: boolean;

  constructor(options: LiveAgentBrainOptions) {
    if (!options.modelProvider) {
      throw new Error("LiveAgentBrain requires a valid modelProvider");
    }
    if (
      typeof options.model !== "string" ||
      options.model.trim().length === 0
    ) {
      throw new Error("LiveAgentBrain requires a non-empty model identifier");
    }

    this.modelProvider = options.modelProvider;
    this.model = options.model;
    this.systemInstruction =
      options.systemInstruction ?? DEFAULT_LIVE_BRAIN_SYSTEM_INSTRUCTION;
    this.generationOptions = options.generationOptions;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.clock = options.clock ?? new SystemClock();
    this.requestIdGenerator =
      options.requestIdGenerator ?? (() => crypto.randomUUID());
    this.enableDynamicToolFiltering =
      options.enableDynamicToolFiltering ?? false;
    this.governedBenchmarkRepairMode = options.governedBenchmarkRepairMode;
  }

  /**
   * Deterministically builds a ModelProviderRequest from the governed AgentBrainRequest.
   *
   * Architectural Invariant:
   * Strips all authority-bearing infrastructure details (workerId, leaseId, contracts, DB).
   * Produces identical message payloads given the same input snapshot and tools.
   */
  buildModelRequest(request: AgentBrainRequest): ModelProviderRequest {
    const { contextSnapshot, availableTools, sequenceNumber, runId, abortSignal } =
      request;

    const sections: string[] = [];

    sections.push("## Task Execution Context");
    sections.push(`- Task ID: ${contextSnapshot.taskId}`);
    sections.push(`- Run ID: ${runId}`);
    sections.push(`- Step Sequence: ${sequenceNumber}`);
    sections.push(`- Context Snapshot Hash: ${contextSnapshot.contextHash}`);

    const missionObs = contextSnapshot.observations.find(
      (o) => o.category === "MISSION_CONTEXT"
    );
    const policy = missionObs?.content?.policy as {
      governedBenchmarkRepairMode?: boolean;
      allowWholeFileReplacement?: boolean;
    } | undefined;
    const isBenchmarkRepairMode =
      this.governedBenchmarkRepairMode ??
      Boolean(policy?.governedBenchmarkRepairMode && !policy?.allowWholeFileReplacement);

    const taskDetails = missionObs?.content?.taskDetails as
      | { title?: string; description?: string; inputPayload?: unknown }
      | undefined;

    if (taskDetails?.title) {
      sections.push(`- Task Title: ${taskDetails.title}`);
    }
    if (taskDetails?.description) {
      sections.push(`\n### Task Objective & Criteria\n${taskDetails.description}`);
    }

    sections.push("\n## Available Tools");
    sections.push(
      formatModelFacingToolCatalog(availableTools, {
        governedBenchmarkRepairMode: isBenchmarkRepairMode,
        allowWholeFileReplacement: policy?.allowWholeFileReplacement,
      })
    );

    const observationsToRender = [...contextSnapshot.observations];
    if (isBenchmarkRepairMode) {
      observationsToRender.sort((a, b) => {
        const aCatIndex = GOVERNED_REPAIR_OBSERVATION_DISPLAY_ORDER.indexOf(a.category);
        const bCatIndex = GOVERNED_REPAIR_OBSERVATION_DISPLAY_ORDER.indexOf(b.category);
        if (aCatIndex !== bCatIndex) {
          return aCatIndex - bCatIndex;
        }
        const aSeq = a.provenance.sequenceNumber ?? 0;
        const bSeq = b.provenance.sequenceNumber ?? 0;
        if (aSeq !== bSeq) {
          return aSeq - bSeq;
        }
        return a.observationId.localeCompare(b.observationId);
      });
    }

    sections.push("\n## Context Observations");
    if (observationsToRender.length === 0) {
      sections.push("No observations available.");
    } else {
      for (const obs of observationsToRender) {
        const truncNote = obs.truncation?.isTruncated
          ? ` [Truncated: ${obs.truncation.retainedBytes}/${obs.truncation.originalBytes} bytes]`
          : "";
        const projectedContent = projectModelFacingObservationContent(obs.category, obs.content);
        sections.push(
          `### [${obs.category}] Priority ${obs.priority} (${obs.freshness})${truncNote}\n${canonicalJsonStringify(projectedContent)}`
        );
      }
    }

    if (contextSnapshot.omittedObservationsCount > 0) {
      sections.push(
        `\n## Omitted Observations: ${contextSnapshot.omittedObservationsCount} item(s) omitted due to context budget limits.`
      );
    }

    // Task-agnostic progress reminder (small local models lose the objective as the context grows).
    // It restates the task's own objective and lists governed file actions that already SUCCEEDED, derived
    // only from observations. It names no fixed paths, issues no completion instruction and never overrides
    // governance: completion is still decided by the authoritative verification gate in the step controller.
    if (taskDetails?.description) {
      const filesRead = new Set<string>();
      const filesChanged = new Set<string>();
      for (const obs of contextSnapshot.observations) {
        if (obs.category !== "ACTION_HISTORY") continue;
        const content = obs.content as Record<string, unknown> | undefined;
        const status = content?.status;
        if (status !== "SUCCEEDED" && status !== "COMPLETED") continue;
        const payload = content?.inputPayload as Record<string, unknown> | undefined;
        const targetPath = payload?.path;
        if (typeof targetPath !== "string" || targetPath.length === 0 || targetPath.length > 200) continue;
        if (content?.toolName === "read_file") filesRead.add(targetPath);
        else if (content?.toolName === "write_file" || content?.toolName === "edit_file") filesChanged.add(targetPath);
      }
      const list = (set: Set<string>) => (set.size === 0 ? "none" : Array.from(set).slice(0, 10).join(", "));
      sections.push(
        `\n## Task Reminder\n` +
          `Task Objective: ${taskDetails.description}\n` +
          `Files read successfully so far: ${list(filesRead)}\n` +
          `Files written or edited successfully so far: ${list(filesChanged)}\n` +
          (filesChanged.size > 0
            ? `If the files written or edited above already satisfy the objective, set isGoalReached: true instead of repeating the same action.`+"\n"
            : "") +
          `Only set isGoalReached: true when every part of the objective above is satisfied.`
      );
    }

    sections.push(
      `\n## Required Action\n` +
        `Propose the next logical tool action as a JSON object conforming to the action proposal schema.\n` +
        `Set contextSnapshotHash to "${contextSnapshot.contextHash}".\n` +
        `If the mission goal has been completely achieved, set isGoalReached: true.`
    );

    const userContent = sections.join("\n");

    const inputMessages: readonly ModelMessage[] = Object.freeze([
      Object.freeze({
        role: "system" as const,
        content: this.systemInstruction,
      }),
      Object.freeze({
        role: "user" as const,
        content: userContent,
      }),
    ]);

    const structuredOutput = deriveActionProposalSchema(availableTools, {
      enableDynamicToolFiltering: this.enableDynamicToolFiltering,
      governedBenchmarkRepairMode: isBenchmarkRepairMode,
      allowWholeFileReplacement: policy?.allowWholeFileReplacement,
    });

    const generation: ModelGenerationOptions = Object.freeze({
      temperature: this.generationOptions?.temperature ?? 0.0,
      maxOutputTokens: this.generationOptions?.maxOutputTokens ?? 2048,
      ...(this.generationOptions?.topP !== undefined
        ? { topP: this.generationOptions.topP }
        : {}),
      ...(this.generationOptions?.stopSequences !== undefined
        ? { stopSequences: this.generationOptions.stopSequences }
        : {}),
      structuredOutput,
    });

    const requestId = this.requestIdGenerator();

    return Object.freeze({
      requestId,
      model: this.model,
      input: inputMessages,
      generation,
      timeoutMs: this.timeoutMs,
      ...(abortSignal ? { abortSignal } : {}),
    });
  }

  /**
   * Proposes the next logical action given a bounded ContextSnapshot.
   *
   * Invariants:
   * 1. Single attempt: Performs exactly one call to modelProvider.generate().
   *    Zero internal retries or backoff loops.
   * 2. Zero execution: Executes no tools, touches no execution providers.
   * 3. Untrusted output: Resulting proposal is strictly untrusted.
   */
  async proposeAction(request: AgentBrainRequest): Promise<AgentBrainResult> {
    if (request.abortSignal?.aborted) {
      throw new ModelRequestCancelledError(
        "Model request was cancelled prior to dispatch",
        {
          providerName: this.modelProvider.providerName,
        }
      );
    }

    const modelRequest = this.buildModelRequest(request);

    // Single-attempt invocation: exactly one call to modelProvider.generate
    // Zero internal retries or backoff loops.
    const response = await this.modelProvider.generate(modelRequest);

    // Validate provider response structure
    try {
      validateModelProviderResponse(response);
    } catch (err: unknown) {
      if (err instanceof ModelResponseInvalidError) {
        return Object.freeze({
          finishReason: "ERROR",
          rawOutput: response?.outputText,
          error: err.message,
        });
      }
      throw err;
    }

    const modelMetadata: BrainModelMetadata = Object.freeze({
      modelName: response.model,
      promptTokens: response.usage?.inputTokens,
      completionTokens: response.usage?.outputTokens,
      totalTokens: response.usage?.totalTokens,
      durationMs: response.durationMs,
    });

    // Check provider-reported finish reasons
    if (response.finishReason === "LENGTH") {
      return Object.freeze({
        finishReason: "CONTEXT_LIMIT",
        rawOutput: response.outputText,
        modelMetadata,
        error:
          "Model output generation exceeded maximum output token length limit",
      });
    }

    if (response.finishReason === "CONTENT_FILTER") {
      return Object.freeze({
        finishReason: "ERROR",
        rawOutput: response.outputText,
        modelMetadata,
        error: "Model output was blocked by content filter",
      });
    }

    if (response.finishReason === "CANCELLED") {
      return Object.freeze({
        finishReason: "ERROR",
        rawOutput: response.outputText,
        modelMetadata,
        error: "Model request was cancelled",
      });
    }

    if (response.finishReason === "ERROR") {
      return Object.freeze({
        finishReason: "ERROR",
        rawOutput: response.outputText,
        modelMetadata,
        error: "Model provider returned ERROR finish reason",
      });
    }

    // Output extraction & JSON parsing
    if (!response.outputText || response.outputText.trim().length === 0) {
      return Object.freeze({
        finishReason: "ERROR",
        rawOutput: response.outputText,
        modelMetadata,
        error: "Model returned empty output text",
      });
    }

    let jsonText = response.outputText.trim();
    if (jsonText.startsWith("```json")) {
      jsonText = jsonText.slice(7);
      if (jsonText.endsWith("```")) {
        jsonText = jsonText.slice(0, -3);
      }
    } else if (jsonText.startsWith("```")) {
      jsonText = jsonText.slice(3);
      if (jsonText.endsWith("```")) {
        jsonText = jsonText.slice(0, -3);
      }
    }
    jsonText = jsonText.trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err: unknown) {
      return Object.freeze({
        finishReason: "ERROR",
        rawOutput: response.outputText,
        modelMetadata,
        error: `Failed to parse model output as JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }

    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return Object.freeze({
        finishReason: "ERROR",
        rawOutput: response.outputText,
        modelMetadata,
        error: "Model output JSON must be a non-null object",
      });
    }

    const obj = parsed as Record<string, unknown>;

    // 1. Payload size ceiling check (enforced across both branches)
    let serialized: string;
    try {
      serialized = canonicalJsonStringify(obj);
    } catch {
      return Object.freeze({
        finishReason: "ERROR",
        rawOutput: response.outputText,
        modelMetadata,
        error: "Proposal payload could not be serialized to canonical JSON",
      });
    }

    const byteLength = Buffer.byteLength(serialized, "utf8");
    if (byteLength > MAX_PROPOSAL_BYTES) {
      return Object.freeze({
        finishReason: "ERROR",
        rawOutput: response.outputText,
        modelMetadata,
        error: `Proposal payload size (${byteLength} bytes) exceeds maximum limit of ${MAX_PROPOSAL_BYTES} bytes`,
      });
    }

    // 2. Forbidden authority firewall check (enforced across both branches)
    const forbiddenKeys = findForbiddenAuthorityKeys(obj);
    if (forbiddenKeys.length > 0) {
      return Object.freeze({
        finishReason: "ERROR",
        rawOutput: response.outputText,
        modelMetadata,
        error: `Model output contains forbidden authority field(s): ${forbiddenKeys.join(
          ", "
        )}. Models are strictly prohibited from specifying runtime authority.`,
      });
    }

    // 3. Discriminator check: isGoalReached must be a boolean
    if (typeof obj.isGoalReached !== "boolean") {
      return Object.freeze({
        finishReason: "ERROR",
        rawOutput: response.outputText,
        modelMetadata,
        error:
          "Model output missing required boolean discriminator 'isGoalReached'",
      });
    }

    // 4. Branch 1: Goal-reached proposal (isGoalReached === true)
    if (obj.isGoalReached === true) {
      // Cross-branch contamination check: forbidden tool fields on goal-completion proposal
      if (
        obj.toolName !== undefined ||
        obj.inputPayload !== undefined ||
        obj.input !== undefined
      ) {
        return Object.freeze({
          finishReason: "ERROR",
          rawOutput: response.outputText,
          modelMetadata,
          error:
            "Goal-reached proposal cannot contain tool action fields (toolName, inputPayload)",
        });
      }

      // Rationale length check (if rationale provided)
      if (obj.rationale !== undefined) {
        if (
          typeof obj.rationale !== "string" ||
          obj.rationale.length > MAX_RATIONALE_LENGTH
        ) {
          return Object.freeze({
            finishReason: "ERROR",
            rawOutput: response.outputText,
            modelMetadata,
            error: `Proposal rationale must be a string <= ${MAX_RATIONALE_LENGTH} characters`,
          });
        }
      }

      return Object.freeze({
        finishReason: "GOAL_REACHED",
        proposal: undefined,
        rawOutput: response.outputText,
        modelMetadata,
      });
    }

    // 5. Branch 2: Tool-action proposal (isGoalReached === false)

    // Tool name check
    if (
      typeof obj.toolName !== "string" ||
      !ACTION_PROPOSAL_TOOL_NAMES.includes(obj.toolName as any)
    ) {
      return Object.freeze({
        finishReason: "ERROR",
        rawOutput: response.outputText,
        modelMetadata,
        error: `Tool '${String(
          obj.toolName
        )}' is missing or not a registered tool name`,
      });
    }

    // Input payload check (accepts either inputPayload or input)
    const rawInput = obj.inputPayload ?? obj.input;
    if (
      rawInput === null ||
      typeof rawInput !== "object" ||
      Array.isArray(rawInput)
    ) {
      return Object.freeze({
        finishReason: "ERROR",
        rawOutput: response.outputText,
        modelMetadata,
        error: "Proposal inputPayload must be a non-null object",
      });
    }

    // Rationale length check
    if (obj.rationale !== undefined) {
      if (
        typeof obj.rationale !== "string" ||
        obj.rationale.length > MAX_RATIONALE_LENGTH
      ) {
        return Object.freeze({
          finishReason: "ERROR",
          rawOutput: response.outputText,
          modelMetadata,
          error: `Proposal rationale must be a string <= ${MAX_RATIONALE_LENGTH} characters`,
        });
      }
    }

    const proposalId =
      typeof obj.proposalId === "string" && obj.proposalId.trim().length > 0
        ? obj.proposalId
        : crypto.randomUUID();

    const contextSnapshotHash =
      typeof obj.contextSnapshotHash === "string" &&
      obj.contextSnapshotHash.trim().length > 0
        ? obj.contextSnapshotHash
        : request.contextSnapshot.contextHash;

    const candidateProposal: ActionProposal = Object.freeze({
      proposalId,
      toolName: obj.toolName as ToolName,
      inputPayload: Object.freeze(rawInput as Record<string, unknown>),
      contextSnapshotHash,
      ...(obj.rationale !== undefined
        ? { rationale: obj.rationale as string }
        : {}),
      ...(typeof obj.sequenceHint === "number"
        ? { sequenceHint: obj.sequenceHint }
        : {}),
    });

    // ActionProposal schema validation (shape validation)
    const schemaResult = ActionProposalSchema.safeParse(candidateProposal);
    if (!schemaResult.success) {
      return Object.freeze({
        finishReason: "ERROR",
        rawOutput: response.outputText,
        modelMetadata,
        error: `Proposal failed schema validation: ${schemaResult.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join(", ")}`,
      });
    }

    return Object.freeze({
      proposal: candidateProposal,
      finishReason: "ACTION_PROPOSED",
      rawOutput: response.outputText,
      modelMetadata,
    });
  }
}
