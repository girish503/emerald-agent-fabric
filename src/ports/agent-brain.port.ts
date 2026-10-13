/**
 * Agent Brain Port for Emerald Agent Fabric.
 *
 * Defines the interface boundary between the Emerald execution fabric
 * and an external agent brain (such as an LLM, mock, or planning system).
 *
 * Architectural Invariants:
 * 1. Model Independence: This port contains zero model SDKs (no OpenAI, Anthropic, Gemini, or LangChain).
 * 2. Information Inflow: Brain receives only bounded ContextSnapshot, available tools, and sequence information.
 * 3. Proposal Outflow: Brain outputs untrusted action proposals. Model output is NEVER authoritative.
 * 4. Zero Execution: Invoking an Agent Brain executes no tools and mutates no runtime state.
 */

import { ContextSnapshot } from "../domain/context.js";
import { ToolDefinition } from "../domain/tool.js";

export interface AgentBrainRequest {
  readonly runId: string;
  readonly contextSnapshot: ContextSnapshot;
  readonly availableTools: readonly ToolDefinition[];
  readonly sequenceNumber: number;
}

export type BrainFinishReason =
  | "ACTION_PROPOSED"
  | "GOAL_REACHED"
  | "ERROR"
  | "CONTEXT_LIMIT";

export interface BrainModelMetadata {
  readonly modelName?: string;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly durationMs?: number;
}

export interface AgentBrainResult {
  /**
   * The untrusted proposal produced by the brain.
   * Untyped / unknown because raw model output is untrusted until validated by ProposalValidator.
   */
  readonly proposal?: unknown;
  readonly finishReason: BrainFinishReason;
  readonly rawOutput?: string;
  readonly modelMetadata?: BrainModelMetadata;
  readonly error?: string;
}

export interface AgentBrainPort {
  /**
   * Proposes the next logical action given a bounded ContextSnapshot.
   * Guarantees zero side effects and zero direct tool execution.
   */
  proposeAction(request: AgentBrainRequest): Promise<AgentBrainResult>;
}
