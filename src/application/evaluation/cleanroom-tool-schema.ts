/**
 * Clean-Room Evaluation Tool Schemas and Gateway Contracts (cleanroom-eval-v3.1)
 *
 * Exposes explicit, machine-readable, model-visible tool parameter schemas
 * generated from and validated against the actual clean-room tool gateway implementations.
 */

import { canonicalJsonStringify, sha256Hex } from "../../domain/canonical-hash.js";
import { ToolName } from "../../domain/tool.js";

export interface CleanroomToolParameterContract {
  readonly name: string;
  readonly type: "string" | "number" | "boolean";
  readonly required: boolean;
  readonly description: string;
  readonly acceptedFormats: string;
  readonly defaultValue?: string | number | boolean;
  readonly aliases?: readonly string[];
}

export interface CleanroomToolContract {
  readonly toolName: ToolName;
  readonly description: string;
  readonly parameters: readonly CleanroomToolParameterContract[];
  readonly additionalProperties: "ignored";
  readonly canonicalPathParameter: "path";
  readonly minimalExample: {
    readonly toolName: ToolName;
    readonly inputPayload: Record<string, unknown>;
    readonly rationale: string;
  };
}

export const READ_FILE_TOOL_CONTRACT: CleanroomToolContract = Object.freeze({
  toolName: "read_file",
  description: "Reads UTF-8 text content from a file within the workspace with line-bounded slicing.",
  parameters: Object.freeze([
    Object.freeze({
      name: "path",
      type: "string",
      required: true,
      description: "Relative workspace file path to read.",
      acceptedFormats: "Relative path within the workspace root (e.g. 'src/user-service.js'). Absolute paths and path traversal ('..') are strictly forbidden.",
      aliases: Object.freeze(["filePath"]), // Accepted by gateway for backward compatibility, but 'path' is canonical
    }),
    Object.freeze({
      name: "offsetLine",
      type: "number",
      required: false,
      description: "Starting line number to read (1-indexed).",
      acceptedFormats: "Positive integer >= 1.",
      defaultValue: 1,
    }),
    Object.freeze({
      name: "limitLines",
      type: "number",
      required: false,
      description: "Maximum number of lines to return.",
      acceptedFormats: "Positive integer between 1 and 1000.",
      defaultValue: 500,
    }),
  ]),
  additionalProperties: "ignored",
  canonicalPathParameter: "path",
  minimalExample: Object.freeze({
    toolName: "read_file",
    inputPayload: Object.freeze({ path: "src/user-service.js" }),
    rationale: "Read the target source file to diagnose the defect.",
  }),
});

export const WRITE_FILE_TOOL_CONTRACT: CleanroomToolContract = Object.freeze({
  toolName: "write_file",
  description: "Writes full UTF-8 text content to a target file in the workspace, creating parent directories if needed.",
  parameters: Object.freeze([
    Object.freeze({
      name: "path",
      type: "string",
      required: true,
      description: "Relative workspace file path to write. CANONICAL PARAMETER IS 'path'. Parameter 'filePath' is NOT accepted.",
      acceptedFormats: "Relative path within workspace root (e.g. 'src/math-pow.js'). Absolute paths and path traversal ('..') are forbidden. For G4_SINGLE_FILE_REPAIR, write path must strictly match authorized target file.",
    }),
    Object.freeze({
      name: "content",
      type: "string",
      required: true,
      description: "Full file content to write.",
      acceptedFormats: "UTF-8 encoded string.",
      defaultValue: "",
    }),
  ]),
  additionalProperties: "ignored",
  canonicalPathParameter: "path",
  minimalExample: Object.freeze({
    toolName: "write_file",
    inputPayload: Object.freeze({
      path: "src/math-pow.js",
      content: "export function power(base, exp) {\n  return base ** exp;\n}\n",
    }),
    rationale: "Repair the exponentiation function to use the correct operator.",
  }),
});

export const SEARCH_CODE_TOOL_CONTRACT: CleanroomToolContract = Object.freeze({
  toolName: "search_code",
  description: "Searches file contents across the workspace for literal text matches.",
  parameters: Object.freeze([
    Object.freeze({
      name: "query",
      type: "string",
      required: true,
      description: "Literal substring to match (max 500 characters). Regex is disabled for safety.",
      acceptedFormats: "Non-empty literal string.",
    }),
    Object.freeze({
      name: "path",
      type: "string",
      required: false,
      description: "Relative directory path within workspace to search.",
      acceptedFormats: "Relative directory path (e.g. '.' or 'src').",
      defaultValue: ".",
    }),
    Object.freeze({
      name: "maxResults",
      type: "number",
      required: false,
      description: "Maximum number of matching lines to return.",
      acceptedFormats: "Integer between 1 and 20.",
      defaultValue: 10,
    }),
    Object.freeze({
      name: "isRegex",
      type: "boolean",
      required: false,
      description: "Regular expression flag (disabled for ReDoS prevention). Must be false or omitted.",
      acceptedFormats: "false",
      defaultValue: false,
    }),
  ]),
  additionalProperties: "ignored",
  canonicalPathParameter: "path",
  minimalExample: Object.freeze({
    toolName: "search_code",
    inputPayload: Object.freeze({ query: "signToken", path: "." }),
    rationale: "Search repository for authentication token signer implementation.",
  }),
});

export const EDIT_FILE_TOOL_CONTRACT: CleanroomToolContract = Object.freeze({
  toolName: "edit_file",
  description: "Performs exact line-anchored search-and-replace in a file in the workspace.",
  parameters: Object.freeze([
    Object.freeze({
      name: "path",
      type: "string",
      required: true,
      description: "Relative workspace file path to edit. CANONICAL PARAMETER IS 'path'.",
      acceptedFormats: "Relative path within workspace root.",
    }),
    Object.freeze({
      name: "searchAnchor",
      type: "string",
      required: true,
      description: "Exact text segment to locate and replace.",
      acceptedFormats: "Non-empty string.",
    }),
    Object.freeze({
      name: "replacementText",
      type: "string",
      required: true,
      description: "Exact replacement text to substitute for searchAnchor.",
      acceptedFormats: "String.",
    }),
  ]),
  additionalProperties: "ignored",
  canonicalPathParameter: "path",
  minimalExample: Object.freeze({
    toolName: "edit_file",
    inputPayload: Object.freeze({
      path: "src/math.js",
      searchAnchor: "return a - b;",
      replacementText: "return a + b;",
    }),
    rationale: "Fix subtraction operator to addition.",
  }),
});

export const CLEANROOM_TOOL_CONTRACTS: Readonly<Record<ToolName, CleanroomToolContract>> = Object.freeze({
  read_file: READ_FILE_TOOL_CONTRACT,
  write_file: WRITE_FILE_TOOL_CONTRACT,
  edit_file: EDIT_FILE_TOOL_CONTRACT,
  search_code: SEARCH_CODE_TOOL_CONTRACT,
  run_command: Object.freeze({
    toolName: "run_command",
    description: "Execute a shell command within the sandbox.",
    parameters: Object.freeze([
      Object.freeze({
        name: "command",
        type: "string",
        required: true,
        description: "Shell command to execute.",
        acceptedFormats: "Single command line string.",
      }),
    ]),
    additionalProperties: "ignored",
    canonicalPathParameter: "path",
    minimalExample: Object.freeze({
      toolName: "run_command",
      inputPayload: Object.freeze({ command: "npm test" }),
      rationale: "Run the test suite.",
    }),
  }),
  git_status: Object.freeze({
    toolName: "git_status",
    description: "Check git status in workspace.",
    parameters: Object.freeze([]),
    additionalProperties: "ignored",
    canonicalPathParameter: "path",
    minimalExample: Object.freeze({
      toolName: "git_status",
      inputPayload: Object.freeze({}),
      rationale: "Check modified files.",
    }),
  }),
  git_diff: Object.freeze({
    toolName: "git_diff",
    description: "Check git diff in workspace.",
    parameters: Object.freeze([]),
    additionalProperties: "ignored",
    canonicalPathParameter: "path",
    minimalExample: Object.freeze({
      toolName: "git_diff",
      inputPayload: Object.freeze({}),
      rationale: "Check diff.",
    }),
  }),
});

export interface StructuredToolValidationError {
  readonly error: "MISSING_PATH" | "INVALID_QUERY" | "INVALID_TOOL_PAYLOAD";
  readonly tool: ToolName;
  readonly missingRequiredParameter?: string;
  readonly rejectedParameter?: string;
  readonly message: string;
  readonly expectedSchema: {
    readonly required: readonly string[];
    readonly optional?: readonly string[];
    readonly parameters: Readonly<Record<string, string>>;
  };
  readonly mutationExecuted: boolean;
}

export function validateToolProposalPayload(
  toolName: ToolName,
  payload: any
): { valid: true } | { valid: false; error: StructuredToolValidationError } {
  const contract = CLEANROOM_TOOL_CONTRACTS[toolName];
  if (!contract) {
    return {
      valid: false,
      error: {
        error: "INVALID_TOOL_PAYLOAD",
        tool: toolName,
        message: `Tool '${toolName}' is not defined in clean-room evaluation contracts.`,
        expectedSchema: { required: [], parameters: {} },
        mutationExecuted: false,
      },
    };
  }

  if (!payload || typeof payload !== "object") {
    return {
      valid: false,
      error: {
        error: "INVALID_TOOL_PAYLOAD",
        tool: toolName,
        message: `Input payload for tool '${toolName}' must be a JSON object.`,
        expectedSchema: {
          required: contract.parameters.filter((p) => p.required).map((p) => p.name),
          optional: contract.parameters.filter((p) => !p.required).map((p) => p.name),
          parameters: Object.fromEntries(contract.parameters.map((p) => [p.name, `${p.type}: ${p.description}`])),
        },
        mutationExecuted: false,
      },
    };
  }

  if (toolName === "write_file") {
    const rawPath = typeof payload.path === "string" ? payload.path.trim() : "";
    if (!rawPath) {
      const hasFilePath = typeof payload.filePath === "string";
      const message = hasFilePath
        ? "Required parameter 'path' must be provided. Parameter 'filePath' is not accepted by write_file; use 'path'."
        : "Required parameter 'path' must be provided as a non-empty string.";
      return {
        valid: false,
        error: {
          error: "MISSING_PATH",
          tool: "write_file",
          missingRequiredParameter: "path",
          ...(hasFilePath ? { rejectedParameter: "filePath" } : {}),
          message,
          expectedSchema: {
            required: ["path", "content"],
            parameters: {
              path: "string (relative workspace path, e.g. 'src/math-pow.js')",
              content: "string (UTF-8 text content to write)",
            },
          },
          mutationExecuted: false,
        },
      };
    }
    return { valid: true };
  }

  if (toolName === "read_file") {
    const rawPath = typeof payload.path === "string" ? payload.path.trim() : (typeof payload.filePath === "string" ? payload.filePath.trim() : "");
    if (!rawPath) {
      return {
        valid: false,
        error: {
          error: "MISSING_PATH",
          tool: "read_file",
          missingRequiredParameter: "path",
          message: "Required parameter 'path' must be provided as a non-empty string.",
          expectedSchema: {
            required: ["path"],
            optional: ["offsetLine", "limitLines"],
            parameters: {
              path: "string (relative workspace path, e.g. 'src/index.js')",
              offsetLine: "number (positive integer >= 1, default: 1)",
              limitLines: "number (positive integer 1-1000, default: 500)",
            },
          },
          mutationExecuted: false,
        },
      };
    }
    return { valid: true };
  }

  if (toolName === "search_code") {
    const query = typeof payload.query === "string" ? payload.query.trim() : "";
    if (!query) {
      return {
        valid: false,
        error: {
          error: "INVALID_QUERY",
          tool: "search_code",
          missingRequiredParameter: "query",
          message: "Required parameter 'query' must be a non-empty string.",
          expectedSchema: {
            required: ["query"],
            optional: ["path", "maxResults", "isRegex"],
            parameters: {
              query: "string (literal text query, max 500 characters)",
              path: "string (relative directory, default: '.')",
              maxResults: "number (1-20, default: 10)",
              isRegex: "boolean (must be false; regex disabled for safety)",
            },
          },
          mutationExecuted: false,
        },
      };
    }
    return { valid: true };
  }

  return { valid: true };
}

export function renderToolSchemaDocumentation(allowedTools: readonly ToolName[]): string {
  const sections: string[] = [];
  for (const toolName of allowedTools) {
    const contract = CLEANROOM_TOOL_CONTRACTS[toolName];
    if (!contract) continue;
    const paramLines = contract.parameters.map((p) => {
      const req = p.required ? "REQUIRED" : "OPTIONAL";
      const def = p.defaultValue !== undefined ? `, default: ${JSON.stringify(p.defaultValue)}` : "";
      const alias = p.aliases && p.aliases.length > 0 ? `, aliases: [${p.aliases.map((a) => `'${a}'`).join(", ")}]` : "";
      return `  - \`${p.name}\` (${p.type}, ${req}${def}${alias}): ${p.description}\n    Format: ${p.acceptedFormats}`;
    });

    sections.push([
      `### Tool: \`${contract.toolName}\``,
      contract.description,
      "Parameters:",
      paramLines.length > 0 ? paramLines.join("\n") : "  (None)",
      `Additional Properties: ${contract.additionalProperties}`,
      `Canonical Path Parameter: \`${contract.canonicalPathParameter}\``,
      "Valid Minimal Proposal Example:",
      "```json",
      canonicalJsonStringify(contract.minimalExample),
      "```",
    ].join("\n"));
  }
  return sections.join("\n\n");
}

export function computeToolSchemasHash(allowedTools: readonly ToolName[]): string {
  const schemas = allowedTools.map((t) => CLEANROOM_TOOL_CONTRACTS[t] ?? { toolName: t });
  return sha256Hex(canonicalJsonStringify(schemas));
}
