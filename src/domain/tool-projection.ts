/**
 * Standardized Model-Facing Tool Projection for Emerald Agent Fabric.
 *
 * Implements ADR-0029 (Option D: Hybrid Typed Runtime Contract + Structured Semantic Metadata Projection).
 *
 * Architectural Invariants:
 * 1. Single Source of Truth: Runtime typed tool contracts (src/domain/tool.ts and src/domain/tool-schemas.ts)
 *    remain the sole authoritative source of truth. Model-facing descriptions are derived projections.
 * 2. Model Output is Untrusted: Model-facing tool descriptions provide advisory cognitive guidance only;
 *    they do NOT grant authority, alter runtime validation, or replace sandbox boundaries.
 * 3. Authority Separation: Projection output strictly excludes internal authority attributes
 *    (capabilities, idempotency, worker IDs, lease IDs, contract IDs, resource ceilings, container mounts).
 * 4. Compact Representation: Parameter signatures, concise summaries, minimal valid examples,
 *    and targeted warnings are formatted within a strict token budget (<= 250 bytes average per tool).
 * 5. Determinism: Projection functions are pure, stateless, and produce byte-identical output across calls.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJsonStringify } from "./canonical-hash.js";
import { ToolDefinition, ToolName } from "./tool.js";

// ============================================================================
// 1. Semantic Metadata Contract & Declarations
// ============================================================================

export interface ToolSemanticMetadata {
  /** Concise, single-responsibility summary of the tool's action. */
  readonly summary: string;
  /** Minimal valid payload guaranteed to pass runtime Zod validation. */
  readonly minimalExample: Record<string, unknown>;
  /** Targeted guidance explicitly warning against observed model hallucination traps. */
  readonly invalidFieldWarning: string;
}

/**
 * Static, immutable semantic metadata declarations for the six core tools.
 * Each entry is strictly validated against the corresponding runtime Zod schema in contract tests.
 */
export const TOOL_SEMANTIC_METADATA: Readonly<Record<ToolName, ToolSemanticMetadata>> = Object.freeze({
  read_file: Object.freeze({
    summary: "Read UTF-8 text from file with line offset and limit bounds.",
    minimalExample: Object.freeze({ path: "src/index.ts", offsetLine: 1, limitLines: 50 }),
    invalidFieldWarning: 'Use "path", "offsetLine", "limitLines" (NOT "filePath", "startLine").',
  }),
  write_file: Object.freeze({
    summary: "Atomically create or overwrite a file with UTF-8 text.",
    minimalExample: Object.freeze({ path: "src/index.ts", content: "export const x = 1;\n" }),
    invalidFieldWarning: 'Use "path" and "content" (NOT "filePath", "text", "data").',
  }),
  search_code: Object.freeze({
    summary: "Search workspace files for literal text or regex query.",
    minimalExample: Object.freeze({ path: ".", query: "export function" }),
    invalidFieldWarning: 'Use "query" (NOT "pattern", "filePaths", "files").',
  }),
  git_status: Object.freeze({
    summary: "Inspect Git working tree status (modified, untracked).",
    minimalExample: Object.freeze({ path: "." }),
    invalidFieldWarning: "Path is optional; empty object {} is valid (no flags).",
  }),
  git_diff: Object.freeze({
    summary: "Compute unified diff against baseline or staged index.",
    minimalExample: Object.freeze({ staged: false }),
    invalidFieldWarning: 'Use "staged" boolean (NOT "cached", "commit").',
  }),
  run_command: Object.freeze({
    summary: "Execute command in container sandbox using discrete argv.",
    minimalExample: Object.freeze({ argv: ["npm", "test"] }),
    invalidFieldWarning: 'Use "argv" string array (NOT raw string like "cmd" or "command").',
  }),
});

// ============================================================================
// 2. Projected Parameter Data Types
// ============================================================================

export interface ProjectedParameter {
  readonly name: string;
  readonly type: string;
  readonly isOptional: boolean;
  readonly defaultValue?: unknown;
}

export interface ProjectedToolInspection {
  readonly toolName: ToolName;
  readonly summary: string;
  readonly parameters: readonly ProjectedParameter[];
  readonly minimalExample: Record<string, unknown>;
  readonly invalidFieldWarning: string;
  readonly formattedProjection: string;
  readonly byteLength: number;
  readonly sha256: string;
}

// ============================================================================
// 3. Schema Introspection Helpers
// ============================================================================

/**
 * Unwraps Zod wrapper types (Optional, Default, Effects, Nullable) to determine
 * underlying schema type, optionality, and default value.
 */
function unwrapZodType(type: z.ZodTypeAny): {
  inner: z.ZodTypeAny;
  isOptional: boolean;
  defaultValue?: unknown;
} {
  let current: z.ZodTypeAny = type;
  let isOptional = false;
  let defaultValue: unknown = undefined;

  let unwrapping = true;
  while (unwrapping) {
    if (current instanceof z.ZodOptional) {
      isOptional = true;
      current = current.unwrap();
    } else if (current instanceof z.ZodDefault) {
      isOptional = true;
      try {
        defaultValue = current._def.defaultValue();
      } catch {
        // Fallback if default function fails evaluation
      }
      current = current._def.innerType;
    } else if (current instanceof z.ZodEffects) {
      current = current.innerType();
    } else if (current instanceof z.ZodNullable) {
      isOptional = true;
      current = current.unwrap();
    } else {
      unwrapping = false;
    }
  }

  return { inner: current, isOptional, defaultValue };
}

/**
 * Maps an unwrapped Zod inner type to a readable TypeScript primitive representation.
 */
function getTypeName(inner: z.ZodTypeAny): string {
  if (inner instanceof z.ZodString) return "string";
  if (inner instanceof z.ZodNumber) return "number";
  if (inner instanceof z.ZodBoolean) return "boolean";
  if (inner instanceof z.ZodArray) {
    const element = unwrapZodType(inner.element);
    return `${getTypeName(element.inner)}[]`;
  }
  if (inner instanceof z.ZodObject) return "object";
  if (inner instanceof z.ZodRecord) return "record";
  return "unknown";
}

/**
 * Introspects a tool's input schema (z.ZodObject) directly from its AST,
 * extracting parameter names, inferred types, and optionality.
 */
export function introspectToolInputSchema(schema: z.ZodTypeAny): readonly ProjectedParameter[] {
  let target: z.ZodTypeAny = schema;
  while (target instanceof z.ZodEffects) {
    target = target.innerType();
  }

  if (!(target instanceof z.ZodObject)) {
    return Object.freeze([]);
  }

  const shape = (target as z.ZodObject<any>).shape;
  const parameters: ProjectedParameter[] = [];

  for (const [key, fieldDef] of Object.entries(shape)) {
    const { inner, isOptional, defaultValue } = unwrapZodType(fieldDef as z.ZodTypeAny);
    const typeName = getTypeName(inner);
    parameters.push(
      Object.freeze({
        name: key,
        type: typeName,
        isOptional,
        ...(defaultValue !== undefined ? { defaultValue } : {}),
      })
    );
  }

  return Object.freeze(parameters);
}

// ============================================================================
// 4. Projection Functions
// ============================================================================

/**
 * Formats a single tool definition into a compact, standardized model-facing specification line.
 * Format:
 * `- <tool_name>(<params>): <summary> Example: <json>. Warning: <warning>`
 */
export function projectToolDefinition(tool: ToolDefinition): string {
  const metadata = TOOL_SEMANTIC_METADATA[tool.name as ToolName];
  const summary = metadata?.summary ?? tool.description;
  const params = introspectToolInputSchema(tool.inputSchema);

  const paramSignatures = params.map((p) =>
    p.isOptional ? `${p.name}?: ${p.type}` : `${p.name}: ${p.type}`
  );

  const sig = `${tool.name}(${paramSignatures.join(", ")})`;
  const exampleJson = metadata
    ? canonicalJsonStringify(metadata.minimalExample)
    : "{}";
  const warningText = metadata?.invalidFieldWarning
    ? ` Warning: ${metadata.invalidFieldWarning}`
    : "";

  return `- ${sig}: ${summary} Example: ${exampleJson}.${warningText}`;
}

/**
 * Produces full inspection metadata for a tool projection, including byte length and SHA-256 hash.
 */
export function inspectToolProjection(tool: ToolDefinition): ProjectedToolInspection {
  const metadata = TOOL_SEMANTIC_METADATA[tool.name as ToolName] ?? {
    summary: tool.description,
    minimalExample: {},
    invalidFieldWarning: "",
  };
  const parameters = introspectToolInputSchema(tool.inputSchema);
  const formattedProjection = projectToolDefinition(tool);
  const byteLength = Buffer.byteLength(formattedProjection, "utf8");
  const sha256 = createHash("sha256").update(formattedProjection, "utf8").digest("hex");

  return Object.freeze({
    toolName: tool.name,
    summary: metadata.summary,
    parameters,
    minimalExample: metadata.minimalExample,
    invalidFieldWarning: metadata.invalidFieldWarning,
    formattedProjection,
    byteLength,
    sha256,
  });
}

/**
 * Formats an array of available tools into the model-facing catalog block for LiveAgentBrain.
 */
export function formatModelFacingToolCatalog(tools: readonly ToolDefinition[]): string {
  if (tools.length === 0) {
    return "No tools available.";
  }
  return tools.map((tool) => projectToolDefinition(tool)).join("\n");
}
