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
import { ExtendedToolName, ToolDefinition, ToolName } from "./tool.js";

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
export const TOOL_SEMANTIC_METADATA: Readonly<Record<ExtendedToolName, ToolSemanticMetadata>> = Object.freeze({
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
  edit_file: Object.freeze({
    summary:
      "Replace an exact literal text segment in an existing file. Prefer the smallest relevant code fragment rather than whole-file replacement. searchAnchor must be exact literal text from the file (NOT a line number, label, or regex). After a failed match, inspect the file with read_file and copy a new literal anchor.",
    minimalExample: Object.freeze({
      path: "src/calc.js",
      searchAnchor: "return a + b + 1;",
      replacementText: "return a + b;",
    }),
    invalidFieldWarning:
      'searchAnchor must be exact literal source text from the file (NOT line numbers like "line:10" or pseudo-selectors). searchAnchor and replacementText must be different.',
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
  readonly toolName: ExtendedToolName;
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
 * Parameters excluded from model-facing tool projections.
 * Internal synchronization tokens (e.g. optimistic concurrency tokens like expectedDigest)
 * are handled by runtime adapters and must not be exposed to autonomous models to prevent hallucination.
 */
export const INTERNAL_TOOL_PARAMETER_EXCLUSIONS: ReadonlySet<string> = new Set([
  "expectedDigest",
]);

export interface ToolProjectionOptions {
  /**
   * Whether governed benchmark repair mode is active without whole-file replacement.
   * When true, write_file cannot overwrite existing files; the overwrite parameter is omitted,
   * and description explicitly directs to edit_file for existing files.
   */
  readonly governedBenchmarkRepairMode?: boolean;
  readonly allowWholeFileReplacement?: boolean;
}

export const BENCHMARK_REPAIR_WRITE_FILE_METADATA: ToolSemanticMetadata = Object.freeze({
  summary:
    "Atomically create a new file with UTF-8 text. Overwriting existing files is disallowed; use edit_file for existing files.",
  minimalExample: Object.freeze({ path: "src/new-file.js", content: "export const x = 1;\n" }),
  invalidFieldWarning:
    'Use "path" and "content" to create a new file. Direct overwrite of existing files is disallowed; use edit_file.',
});

/**
 * Introspects a tool's input schema (z.ZodObject) directly from its AST,
 * extracting parameter names, inferred types, and optionality.
 * Internal parameters (such as expectedDigest) and context-sensitive exclusions are omitted.
 */
export function introspectToolInputSchema(
  schema: z.ZodTypeAny,
  options?: { extraExclusions?: ReadonlySet<string> }
): readonly ProjectedParameter[] {
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
    if (INTERNAL_TOOL_PARAMETER_EXCLUSIONS.has(key) || options?.extraExclusions?.has(key)) {
      continue;
    }
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
export function projectToolDefinition(
  tool: ToolDefinition,
  options?: ToolProjectionOptions
): string {
  const isBenchmarkRepair = Boolean(
    options?.governedBenchmarkRepairMode && !options?.allowWholeFileReplacement
  );

  const metadata = (isBenchmarkRepair && tool.name === "write_file")
    ? BENCHMARK_REPAIR_WRITE_FILE_METADATA
    : (TOOL_SEMANTIC_METADATA[tool.name as ExtendedToolName] ?? {
        summary: tool.description,
        minimalExample: {},
        invalidFieldWarning: "",
      });

  const extraExclusions = (isBenchmarkRepair && tool.name === "write_file")
    ? new Set(["overwrite"])
    : undefined;

  const summary = metadata.summary;
  const params = introspectToolInputSchema(tool.inputSchema, { extraExclusions });

  const paramSignatures = params.map((p) =>
    p.isOptional ? `${p.name}?: ${p.type}` : `${p.name}: ${p.type}`
  );

  const sig = `${tool.name}(${paramSignatures.join(", ")})`;
  const exampleJson = canonicalJsonStringify(metadata.minimalExample);
  const warningText = metadata.invalidFieldWarning
    ? ` Warning: ${metadata.invalidFieldWarning}`
    : "";

  return `- ${sig}: ${summary} Example: ${exampleJson}.${warningText}`;
}

/**
 * Produces full inspection metadata for a tool projection, including byte length and SHA-256 hash.
 */
export function inspectToolProjection(
  tool: ToolDefinition,
  options?: ToolProjectionOptions
): ProjectedToolInspection {
  const isBenchmarkRepair = Boolean(
    options?.governedBenchmarkRepairMode && !options?.allowWholeFileReplacement
  );
  const metadata = (isBenchmarkRepair && tool.name === "write_file")
    ? BENCHMARK_REPAIR_WRITE_FILE_METADATA
    : (TOOL_SEMANTIC_METADATA[tool.name as ExtendedToolName] ?? {
        summary: tool.description,
        minimalExample: {},
        invalidFieldWarning: "",
      });
  const extraExclusions = (isBenchmarkRepair && tool.name === "write_file")
    ? new Set(["overwrite"])
    : undefined;
  const parameters = introspectToolInputSchema(tool.inputSchema, { extraExclusions });
  const formattedProjection = projectToolDefinition(tool, options);
  const byteLength = Buffer.byteLength(formattedProjection, "utf8");
  const sha256 = createHash("sha256").update(formattedProjection, "utf8").digest("hex");

  return Object.freeze({
    toolName: tool.name as ExtendedToolName,
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
export function formatModelFacingToolCatalog(
  tools: readonly ToolDefinition[],
  options?: ToolProjectionOptions
): string {
  if (tools.length === 0) {
    return "No tools available.";
  }
  return tools.map((tool) => projectToolDefinition(tool, options)).join("\n");
}
