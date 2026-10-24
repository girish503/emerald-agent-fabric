/**
 * Emerald Agent Fabric — Production V1.8
 * Minimal Structured Proposal Schema and Constrained JSON Validation
 *
 * Provides a versioned, typed schema for the existing production proposal contract.
 * Represents ONLY the 7 actions already authorized by the current runtime:
 * - read_file
 * - write_file
 * - edit_file_anchor
 * - search_code
 * - git_status
 * - git_diff
 * - run_command
 *
 * Invariants:
 * 1. Never introduces new tools or capabilities.
 * 2. Rejects unknown action identifiers fail-closed.
 * 3. Rejects missing or malformed required fields.
 * 4. Rejects oversized payloads.
 * 5. Rejects unknown top-level fields to prevent authority injection.
 * 6. Never executes proposals merely because they pass schema validation.
 * 7. Model-provided fields can never override mission identity, permissions,
 *    budgets, workspace roots, or verification authority.
 */

import { z } from "zod";
import { createHash } from "node:crypto";
import { AgentProposal } from "../../runtime/production-runtime-engine.js";

export const PROPOSAL_SCHEMA_VERSION = "v1.8.0";
export const MAX_PROPOSAL_PAYLOAD_BYTES = 64 * 1024; // 64 KB maximum payload

export const AUTHORIZED_ACTION_NAMES = [
  "read_file",
  "write_file",
  "edit_file_anchor",
  "search_code",
  "git_status",
  "git_diff",
  "run_command",
] as const;

export type AuthorizedActionName = (typeof AUTHORIZED_ACTION_NAMES)[number];

// Tool-specific input schemas
export const ReadFileInputSchema = z
  .object({
    path: z.string().min(1, "Path cannot be empty").max(1024, "Path exceeds maximum length"),
  })
  .strict();

export const WriteFileInputSchema = z
  .object({
    path: z.string().min(1, "Path cannot be empty").max(1024, "Path exceeds maximum length"),
    content: z.string({ required_error: "Content string is required for write_file" }),
  })
  .strict();

export const EditFileAnchorInputSchema = z
  .object({
    path: z.string().min(1, "Path cannot be empty").max(1024, "Path exceeds maximum length"),
    searchAnchor: z.string().min(1, "searchAnchor cannot be empty"),
    replacementText: z.string({ required_error: "replacementText is required for edit_file_anchor" }),
    expectedDigest: z.string().length(64).optional(),
    allowMultipleMatches: z.boolean().optional(),
  })
  .strict();

export const SearchCodeInputSchema = z
  .object({
    query: z.string().min(1, "Query cannot be empty").max(1024, "Query exceeds maximum length"),
    path: z.string().max(1024).optional(),
  })
  .strict();

export const GitStatusInputSchema = z.object({}).strict();

export const GitDiffInputSchema = z
  .object({
    path: z.string().max(1024).optional(),
    cached: z.boolean().optional(),
  })
  .strict();

export const RunCommandInputSchema = z
  .object({
    command: z.string().min(1, "Command cannot be empty").max(1024, "Command exceeds maximum length"),
    args: z.array(z.string().max(1024)).optional(),
  })
  .strict();

export const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "version",
  "thought",
  "toolName",
  "toolInput",
  "isGoalReached",
]);

export interface ProposalValidationResult {
  readonly valid: boolean;
  readonly schemaVersion: string;
  readonly schemaDigest: string;
  readonly proposal?: AgentProposal;
  readonly error?: string;
  readonly errorCode?:
    | "OVERSIZED_PAYLOAD"
    | "INVALID_JSON_STRUCTURE"
    | "UNEXPECTED_FIELD"
    | "UNSUPPORTED_VERSION"
    | "UNKNOWN_ACTION"
    | "INVALID_ARGUMENTS";
}

/**
 * Returns the canonical JSON Schema definition for Ollama constrained generation.
 * This object is passed directly to Ollama's `format` parameter.
 */
export function getStructuredProposalJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      version: {
        type: "string",
        enum: [PROPOSAL_SCHEMA_VERSION],
      },
      thought: {
        type: "string",
      },
      toolName: {
        type: "string",
        enum: [...AUTHORIZED_ACTION_NAMES],
      },
      toolInput: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          searchAnchor: { type: "string" },
          replacementText: { type: "string" },
          expectedDigest: { type: "string" },
          allowMultipleMatches: { type: "boolean" },
          query: { type: "string" },
          command: { type: "string" },
          args: {
            type: "array",
            items: { type: "string" },
          },
          cached: { type: "boolean" },
        },
      },
      isGoalReached: {
        type: "boolean",
      },
    },
    required: ["version", "thought", "toolName", "toolInput"],
  };
}

/**
 * Computes deterministic SHA-256 hash of the canonical JSON Schema.
 */
export function getProposalSchemaDigest(): string {
  const schema = getStructuredProposalJsonSchema();
  const canonical = JSON.stringify(schema, Object.keys(schema).sort());
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Validates any candidate proposal object against the versioned schema and tool argument constraints.
 * Enforces strict typing, rejects oversized payloads, unexpected fields, and invalid tool arguments fail-closed.
 */
export function validateStructuredProposal(
  rawPayload: unknown,
  options?: { maxBytes?: number },
): ProposalValidationResult {
  const schemaVersion = PROPOSAL_SCHEMA_VERSION;
  const schemaDigest = getProposalSchemaDigest();
  const maxBytes = options?.maxBytes ?? MAX_PROPOSAL_PAYLOAD_BYTES;

  // 1. Payload size check
  let rawString = "";
  try {
    rawString = typeof rawPayload === "string" ? rawPayload : JSON.stringify(rawPayload);
  } catch {
    return {
      valid: false,
      schemaVersion,
      schemaDigest,
      errorCode: "INVALID_JSON_STRUCTURE",
      error: "Payload cannot be serialized or analyzed",
    };
  }

  const payloadBytes = Buffer.byteLength(rawString, "utf8");
  if (payloadBytes > maxBytes) {
    return {
      valid: false,
      schemaVersion,
      schemaDigest,
      errorCode: "OVERSIZED_PAYLOAD",
      error: `Proposal payload (${payloadBytes} bytes) exceeds maximum limit of ${maxBytes} bytes`,
    };
  }

  // 2. Parse if raw string
  let parsed: unknown = rawPayload;
  if (typeof rawPayload === "string") {
    try {
      parsed = JSON.parse(rawPayload);
    } catch (e: any) {
      return {
        valid: false,
        schemaVersion,
        schemaDigest,
        errorCode: "INVALID_JSON_STRUCTURE",
        error: `Malformed JSON: ${e.message}`,
      };
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      valid: false,
      schemaVersion,
      schemaDigest,
      errorCode: "INVALID_JSON_STRUCTURE",
      error: "Proposal must be a non-null object",
    };
  }

  const obj = parsed as Record<string, unknown>;

  // 3. Reject unexpected top-level fields (anti-privilege-escalation)
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      return {
        valid: false,
        schemaVersion,
        schemaDigest,
        errorCode: "UNEXPECTED_FIELD",
        error: `Unexpected top-level field '${key}' rejected. Model cannot inject authority or configuration overrides.`,
      };
    }
  }

  // 4. Validate version
  if (obj.version !== PROPOSAL_SCHEMA_VERSION) {
    return {
      valid: false,
      schemaVersion,
      schemaDigest,
      errorCode: "UNSUPPORTED_VERSION",
      error: `Proposal version must be '${PROPOSAL_SCHEMA_VERSION}', received '${String(obj.version)}'`,
    };
  }

  // 5. Validate thought
  if (typeof obj.thought !== "string" || obj.thought.trim().length === 0) {
    return {
      valid: false,
      schemaVersion,
      schemaDigest,
      errorCode: "INVALID_ARGUMENTS",
      error: "Proposal 'thought' must be a non-empty string",
    };
  }

  // 6. Validate toolName
  if (typeof obj.toolName !== "string" || !AUTHORIZED_ACTION_NAMES.includes(obj.toolName as any)) {
    return {
      valid: false,
      schemaVersion,
      schemaDigest,
      errorCode: "UNKNOWN_ACTION",
      error: `Unknown or unauthorized toolName '${String(obj.toolName)}'. Must be one of: ${AUTHORIZED_ACTION_NAMES.join(", ")}`,
    };
  }

  // 7. Validate toolInput is an object
  if (!obj.toolInput || typeof obj.toolInput !== "object" || Array.isArray(obj.toolInput)) {
    return {
      valid: false,
      schemaVersion,
      schemaDigest,
      errorCode: "INVALID_ARGUMENTS",
      error: "Proposal 'toolInput' must be an object",
    };
  }

  // 8. Tool-specific argument validation
  const toolName = obj.toolName as AuthorizedActionName;
  const toolInput = obj.toolInput as Record<string, unknown>;

  let validationResult: z.SafeParseReturnType<any, any>;
  switch (toolName) {
    case "read_file":
      validationResult = ReadFileInputSchema.safeParse(toolInput);
      break;
    case "write_file":
      validationResult = WriteFileInputSchema.safeParse(toolInput);
      break;
    case "edit_file_anchor":
      validationResult = EditFileAnchorInputSchema.safeParse(toolInput);
      break;
    case "search_code":
      validationResult = SearchCodeInputSchema.safeParse(toolInput);
      break;
    case "git_status":
      validationResult = GitStatusInputSchema.safeParse(toolInput);
      break;
    case "git_diff":
      validationResult = GitDiffInputSchema.safeParse(toolInput);
      break;
    case "run_command":
      validationResult = RunCommandInputSchema.safeParse(toolInput);
      break;
    default:
      return {
        valid: false,
        schemaVersion,
        schemaDigest,
        errorCode: "UNKNOWN_ACTION",
        error: `Tool '${toolName}' not authorized`,
      };
  }

  if (!validationResult.success) {
    const issue = validationResult.error.issues[0];
    const message = issue ? `${issue.path.join(".") || "input"}: ${issue.message}` : "Validation failed";
    return {
      valid: false,
      schemaVersion,
      schemaDigest,
      errorCode: "INVALID_ARGUMENTS",
      error: `Tool argument validation failed for '${toolName}': ${message}`,
    };
  }

  // Valid proposal constructed
  const validatedProposal: AgentProposal = {
    thought: obj.thought.trim(),
    toolName,
    toolInput: validationResult.data as Record<string, unknown>,
    isGoalReached: Boolean(obj.isGoalReached),
  };

  return {
    valid: true,
    schemaVersion,
    schemaDigest,
    proposal: validatedProposal,
  };
}
