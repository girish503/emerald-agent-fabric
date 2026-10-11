/**
 * Tool Domain Model for Emerald Agent Fabric.
 *
 * Establishes a deterministic, strongly typed, schema-validated domain contract for tools.
 *
 * Architectural Invariants:
 * 1. Authority Separation: A tool declares the capability it requires; it does NOT grant authority.
 *    Capability authorization remains gated upstream by MissionContract + Policy.
 * 2. Immutable Catalog: Tool definitions are frozen and statically defined.
 * 3. Structured Execution: `run_command` enforces discrete argv tokens, rejecting raw shell strings.
 * 4. Determinism: Definitions and schemas contain zero stochastic or host-dependent behaviour.
 * 5. Isolation Guarantees: Every tool explicitly declares its required execution boundary (WORKSPACE or SANDBOX).
 */

import { z } from "zod";
import { ToolRegistryPort } from "../ports/tool-registry.port.js";
import {
  GitDiffInputSchema,
  GitDiffOutputSchema,
  GitStatusInputSchema,
  GitStatusOutputSchema,
  ReadFileInputSchema,
  ReadFileOutputSchema,
  RunCommandInputSchema,
  RunCommandOutputSchema,
  SearchCodeInputSchema,
  SearchCodeOutputSchema,
  ToolInputMap,
  ToolOutputMap,
  WriteFileInputSchema,
  WriteFileOutputSchema,
} from "./tool-schemas.js";
import { ToolErrorPayload } from "./errors.js";

// ============================================================================
// 1. Tool Names & Types
// ============================================================================

export const TOOL_NAMES = [
  "read_file",
  "write_file",
  "search_code",
  "git_status",
  "git_diff",
  "run_command",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export function isValidToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

// ============================================================================
// 2. Capability Mapping
// ============================================================================

export const TOOL_CAPABILITY_MAP = {
  read_file: "workspace.file.read",
  write_file: "workspace.file.write",
  search_code: "workspace.code.search",
  git_status: "git.read",
  git_diff: "git.read",
  run_command: "process.execute",
} as const satisfies Record<ToolName, string>;

export type ToolCapability = (typeof TOOL_CAPABILITY_MAP)[ToolName];

export const KNOWN_TOOL_CAPABILITIES: readonly ToolCapability[] = Object.freeze(
  Array.from(new Set(Object.values(TOOL_CAPABILITY_MAP)))
);

export function toolNameToCapabilityName(toolName: string): ToolCapability | null {
  if (isValidToolName(toolName)) {
    return TOOL_CAPABILITY_MAP[toolName];
  }
  return null;
}

// ============================================================================
// 3. Idempotency Classification
// ============================================================================

export type ToolIdempotency = "IDEMPOTENT" | "NON_IDEMPOTENT";

export const TOOL_IDEMPOTENCY_MAP: Readonly<Record<ToolName, ToolIdempotency>> = {
  read_file: "IDEMPOTENT",
  search_code: "IDEMPOTENT",
  git_status: "IDEMPOTENT",
  git_diff: "IDEMPOTENT",
  write_file: "NON_IDEMPOTENT",
  run_command: "NON_IDEMPOTENT",
};

// ============================================================================
// 4. Isolation Requirement
// ============================================================================

export type ToolIsolationRequirement = "WORKSPACE" | "SANDBOX";

export const TOOL_ISOLATION_MAP: Readonly<Record<ToolName, ToolIsolationRequirement>> = {
  read_file: "WORKSPACE",
  write_file: "WORKSPACE",
  search_code: "WORKSPACE",
  git_status: "WORKSPACE",
  git_diff: "WORKSPACE",
  run_command: "SANDBOX",
};

// ============================================================================
// 5. Resource Semantics & Descriptors
// ============================================================================

export type ToolResourceDimension = "timeoutMs" | "maxBytes" | "maxResults" | "maxOutputBytes";

export interface ToolResourceDescriptor {
  readonly supportedDimensions: readonly ToolResourceDimension[];
  readonly defaultTimeoutMs?: number;
  readonly maxTimeoutMs?: number;
  readonly defaultMaxBytes?: number;
  readonly maxMaxBytes?: number;
  readonly defaultMaxResults?: number;
  readonly maxMaxResults?: number;
}

// ============================================================================
// 6. Tool Definition
// ============================================================================

export interface ToolDefinition<TName extends ToolName = ToolName> {
  readonly name: TName;
  readonly version: string;
  readonly description: string;
  readonly requiredCapability: ToolCapability;
  readonly isolationRequirement: ToolIsolationRequirement;
  readonly idempotency: ToolIdempotency;
  readonly resourceDescriptor: ToolResourceDescriptor;
  readonly inputSchema: z.ZodType<ToolInputMap[TName], z.ZodTypeDef, any>;
  readonly outputSchema: z.ZodType<ToolOutputMap[TName], z.ZodTypeDef, any>;
}

// ============================================================================
// 7. Initial Concrete Tool Definitions
// ============================================================================

export const READ_FILE_TOOL: ToolDefinition<"read_file"> = Object.freeze({
  name: "read_file",
  version: "1.0.0",
  description: "Reads UTF-8 text content from a file inside the workspace sandbox with line/offset bounding.",
  requiredCapability: "workspace.file.read",
  isolationRequirement: "WORKSPACE",
  idempotency: "IDEMPOTENT",
  resourceDescriptor: Object.freeze({
    supportedDimensions: Object.freeze(["maxBytes"] as const),
    defaultMaxBytes: 1024 * 1024,
    maxMaxBytes: 10 * 1024 * 1024,
  }),
  inputSchema: ReadFileInputSchema,
  outputSchema: ReadFileOutputSchema,
});

export const WRITE_FILE_TOOL: ToolDefinition<"write_file"> = Object.freeze({
  name: "write_file",
  version: "1.0.0",
  description: "Atomically creates or overwrites a text file within the workspace sandbox.",
  requiredCapability: "workspace.file.write",
  isolationRequirement: "WORKSPACE",
  idempotency: "NON_IDEMPOTENT",
  resourceDescriptor: Object.freeze({
    supportedDimensions: Object.freeze(["maxBytes"] as const),
    defaultMaxBytes: 1024 * 1024,
    maxMaxBytes: 10 * 1024 * 1024,
  }),
  inputSchema: WriteFileInputSchema,
  outputSchema: WriteFileOutputSchema,
});

export const SEARCH_CODE_TOOL: ToolDefinition<"search_code"> = Object.freeze({
  name: "search_code",
  version: "1.0.0",
  description: "Performs regex or literal text pattern matching across workspace files.",
  requiredCapability: "workspace.code.search",
  isolationRequirement: "WORKSPACE",
  idempotency: "IDEMPOTENT",
  resourceDescriptor: Object.freeze({
    supportedDimensions: Object.freeze(["maxResults", "maxBytes"] as const),
    defaultMaxResults: 50,
    maxMaxResults: 1000,
    defaultMaxBytes: 256 * 1024,
    maxMaxBytes: 2 * 1024 * 1024,
  }),
  inputSchema: SearchCodeInputSchema,
  outputSchema: SearchCodeOutputSchema,
});

export const GIT_STATUS_TOOL: ToolDefinition<"git_status"> = Object.freeze({
  name: "git_status",
  version: "1.0.0",
  description: "Inspects workspace Git repository status, returning modified, staged, untracked, and deleted files.",
  requiredCapability: "git.read",
  isolationRequirement: "WORKSPACE",
  idempotency: "IDEMPOTENT",
  resourceDescriptor: Object.freeze({
    supportedDimensions: Object.freeze([] as const),
  }),
  inputSchema: GitStatusInputSchema,
  outputSchema: GitStatusOutputSchema,
});

export const GIT_DIFF_TOOL: ToolDefinition<"git_diff"> = Object.freeze({
  name: "git_diff",
  version: "1.0.0",
  description: "Computes unified diff of working tree changes against the baseline commit.",
  requiredCapability: "git.read",
  isolationRequirement: "WORKSPACE",
  idempotency: "IDEMPOTENT",
  resourceDescriptor: Object.freeze({
    supportedDimensions: Object.freeze(["maxBytes"] as const),
    defaultMaxBytes: 256 * 1024,
    maxMaxBytes: 2 * 1024 * 1024,
  }),
  inputSchema: GitDiffInputSchema,
  outputSchema: GitDiffOutputSchema,
});

export const RUN_COMMAND_TOOL: ToolDefinition<"run_command"> = Object.freeze({
  name: "run_command",
  version: "1.0.0",
  description: "Executes a specific non-interactive command inside the isolated container sandbox.",
  requiredCapability: "process.execute",
  isolationRequirement: "SANDBOX",
  idempotency: "NON_IDEMPOTENT",
  resourceDescriptor: Object.freeze({
    supportedDimensions: Object.freeze(["timeoutMs", "maxOutputBytes"] as const),
    defaultTimeoutMs: 10000,
    maxTimeoutMs: 60000,
    defaultMaxBytes: 1024 * 1024,
    maxMaxBytes: 10 * 1024 * 1024,
  }),
  inputSchema: RunCommandInputSchema,
  outputSchema: RunCommandOutputSchema,
});

export const INITIAL_TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  SEARCH_CODE_TOOL,
  GIT_STATUS_TOOL,
  GIT_DIFF_TOOL,
  RUN_COMMAND_TOOL,
]);

// ============================================================================
// 8. Tool Request & Tool Result Models
// ============================================================================

export interface ToolRequest<TName extends ToolName = ToolName> {
  readonly requestId: string;
  readonly runId: string;
  readonly toolName: TName;
  readonly input: ToolInputMap[TName];
}

export type ToolResultStatus = "SUCCESS" | "FAILED" | "TIMED_OUT" | "CANCELLED";

export interface ToolResult<TName extends ToolName = ToolName> {
  readonly requestId: string;
  readonly toolName: TName;
  readonly status: ToolResultStatus;
  readonly output?: ToolOutputMap[TName];
  readonly error?: ToolErrorPayload;
  readonly durationMs: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// 9. Static Tool Registry Reference Implementation
// ============================================================================

export class StaticToolRegistry implements ToolRegistryPort {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(tools: readonly ToolDefinition[] = INITIAL_TOOL_DEFINITIONS) {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) {
        throw new Error(`Duplicate tool definition for '${tool.name}'`);
      }
      this.tools.set(tool.name, tool);
    }
  }

  getTool<TName extends ToolName>(name: TName): ToolDefinition<TName> | null;
  getTool(name: string): ToolDefinition | null;
  getTool(name: string): ToolDefinition | null {
    return (this.tools.get(name) as ToolDefinition | undefined) ?? null;
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  listTools(): readonly ToolDefinition[] {
    return Array.from(this.tools.values());
  }
}

export const staticToolRegistry = new StaticToolRegistry();
