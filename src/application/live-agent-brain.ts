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
import { TOOL_NAMES, ToolName } from "../domain/tool.js";
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
3. Propose exact, bounded input arguments matching the tool's parameter schema.
4. If the mission goal is fully achieved, output an action proposal indicating completion (isGoalReached: true).
5. Never attempt to specify infrastructure authority fields (workerId, leaseId, contracts, capabilities, mount paths, retry limits, execution status).
6. Format your response strictly according to the required action proposal schema.`;

// ============================================================================
// 2. Structured Output Schema Descriptor
// ============================================================================

export const ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA: ModelStructuredOutputSchema =
  Object.freeze({
    name: "action_proposal",
    description:
      "Untrusted action proposal or completion signal for Emerald agent reasoning",
    strict: true,
    jsonSchema: Object.freeze({
      anyOf: [
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
        {
          type: "object",
          description: "Tool-action proposal (requests governed tool execution)",
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
              description: "Name of the registered tool to invoke",
              enum: [...TOOL_NAMES],
            },
            inputPayload: {
              type: "object",
              description: "Tool input parameters matching tool schema",
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
      ],
    }),
  });

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

    sections.push("\n## Available Tools");
    for (const tool of availableTools) {
      sections.push(
        `- ${tool.name} (capability: ${tool.requiredCapability}, idempotency: ${tool.idempotency}): ${tool.description}`
      );
    }

    sections.push("\n## Context Observations");
    if (contextSnapshot.observations.length === 0) {
      sections.push("No observations available.");
    } else {
      for (const obs of contextSnapshot.observations) {
        const truncNote = obs.truncation?.isTruncated
          ? ` [Truncated: ${obs.truncation.retainedBytes}/${obs.truncation.originalBytes} bytes]`
          : "";
        sections.push(
          `### [${obs.category}] Priority ${obs.priority} (${obs.freshness})${truncNote}\n${canonicalJsonStringify(obs.content)}`
        );
      }
    }

    if (contextSnapshot.omittedObservationsCount > 0) {
      sections.push(
        `\n## Omitted Observations: ${contextSnapshot.omittedObservationsCount} item(s) omitted due to context budget limits.`
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

    const generation: ModelGenerationOptions = Object.freeze({
      temperature: this.generationOptions?.temperature ?? 0.0,
      maxOutputTokens: this.generationOptions?.maxOutputTokens ?? 2048,
      ...(this.generationOptions?.topP !== undefined
        ? { topP: this.generationOptions.topP }
        : {}),
      ...(this.generationOptions?.stopSequences !== undefined
        ? { stopSequences: this.generationOptions.stopSequences }
        : {}),
      structuredOutput: ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA,
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
      !TOOL_NAMES.includes(obj.toolName as any)
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
