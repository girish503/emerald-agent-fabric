/**
 * Typed Tool Schemas for Emerald Agent Fabric.
 *
 * Implements strict, immutable Zod input and output schemas for the initial six
 * tool primitives (read_file, write_file, search_code, git_status, git_diff, run_command).
 *
 * Security & Validation Principles:
 * 1. Strict Schemas: Unknown keys are rejected via .strict().
 * 2. Lexical Path Sanitization: All relative workspace paths are validated using
 *    pure lexical boundary rules (rejecting absolute paths, Windows drive letters,
 *    UNC network shares, traversal `..`, null bytes, control chars, and Windows reserved stems).
 * 3. Structured Process Execution: `run_command` accepts discrete argv arrays only,
 *    categorically rejecting raw shell string interpolation.
 * 4. Bounded Resources: Resource parameters (maxBytes, timeoutMs, maxResults) must be
 *    positive integers and are validated deterministically without silent clamping.
 */

import { z } from "zod";
import { sanitizeWorkspacePath } from "./workspace-path.js";

/**
 * Reusable Zod schema that enforces pure lexical workspace containment for child files.
 */
export const WorkspaceRelativePathSchema = z
  .string()
  .min(1, "Path cannot be empty")
  .superRefine((val, ctx) => {
    try {
      sanitizeWorkspacePath(val, { allowRoot: false });
    } catch (err: unknown) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

/**
 * Reusable Zod schema that enforces pure lexical workspace containment allowing workspace root (".").
 */
export const WorkspaceDirectoryPathSchema = z
  .string()
  .min(1, "Directory path cannot be empty")
  .superRefine((val, ctx) => {
    try {
      sanitizeWorkspacePath(val, { allowRoot: true });
    } catch (err: unknown) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

// ============================================================================
// 1. read_file
// ============================================================================

export const ReadFileInputSchema = z
  .object({
    path: WorkspaceRelativePathSchema.describe("Relative path to file within workspace sandbox"),
    offsetLine: z.number().int().min(1, "offsetLine must be >= 1").optional().default(1),
    limitLines: z.number().int().min(1, "limitLines must be >= 1").max(5000, "limitLines cannot exceed 5000").optional().default(500),
    maxBytes: z.number().int().positive("maxBytes must be positive").optional().describe("Requested maximum bytes to read"),
  })
  .strict();

export type ReadFileInput = z.infer<typeof ReadFileInputSchema>;

export const ReadFileOutputSchema = z
  .object({
    path: z.string(),
    content: z.string(),
    bytesRead: z.number().int().nonnegative(),
    totalLines: z.number().int().nonnegative().optional(),
    isTruncated: z.boolean(),
    contentHash: z.string().optional(),
  })
  .strict();

export type ReadFileOutput = z.infer<typeof ReadFileOutputSchema>;

// ============================================================================
// 2. write_file
// ============================================================================

export const WriteFileInputSchema = z
  .object({
    path: WorkspaceRelativePathSchema.describe("Relative path to file within workspace sandbox"),
    content: z.string().describe("UTF-8 text content to write"),
    overwrite: z.boolean().default(true),
    maxBytes: z.number().int().positive("maxBytes must be positive").optional().describe("Requested maximum bytes to write"),
  })
  .strict();

export type WriteFileInput = z.infer<typeof WriteFileInputSchema>;

export const WriteFileOutputSchema = z
  .object({
    path: z.string(),
    bytesWritten: z.number().int().nonnegative(),
    created: z.boolean(),
    contentHash: z.string().optional(),
  })
  .strict();

export type WriteFileOutput = z.infer<typeof WriteFileOutputSchema>;

// ============================================================================
// 3. search_code
// ============================================================================

export const SearchCodeInputSchema = z
  .object({
    query: z.string().min(1, "query cannot be empty").max(1000, "query too long").describe("Search string or regex query"),
    isRegex: z.boolean().default(false),
    path: WorkspaceDirectoryPathSchema.optional().default("."),
    filePattern: z.string().min(1, "filePattern cannot be empty").optional().default("*"),
    maxResults: z.number().int().min(1, "maxResults must be >= 1").max(1000, "maxResults cannot exceed 1000").optional().default(50),
    maxBytes: z.number().int().positive("maxBytes must be positive").optional().describe("Requested maximum output bytes"),
  })
  .strict();

export type SearchCodeInput = z.infer<typeof SearchCodeInputSchema>;

export const SearchCodeMatchSchema = z
  .object({
    file: z.string(),
    line: z.number().int().positive(),
    content: z.string(),
  })
  .strict();

export type SearchCodeMatch = z.infer<typeof SearchCodeMatchSchema>;

export const SearchCodeOutputSchema = z
  .object({
    query: z.string(),
    matches: z.array(SearchCodeMatchSchema),
    totalMatches: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export type SearchCodeOutput = z.infer<typeof SearchCodeOutputSchema>;

// ============================================================================
// 4. git_status
// ============================================================================

export const GitStatusInputSchema = z
  .object({
    path: WorkspaceDirectoryPathSchema.optional(),
  })
  .strict();

export type GitStatusInput = z.infer<typeof GitStatusInputSchema>;

export const GitStatusOutputSchema = z
  .object({
    clean: z.boolean(),
    currentCommit: z.string().optional(),
    modified: z.array(z.string()),
    added: z.array(z.string()),
    deleted: z.array(z.string()),
    untracked: z.array(z.string()),
  })
  .strict();

export type GitStatusOutput = z.infer<typeof GitStatusOutputSchema>;

// ============================================================================
// 5. git_diff
// ============================================================================

export const GitDiffInputSchema = z
  .object({
    path: WorkspaceDirectoryPathSchema.optional(),
    staged: z.boolean().default(false),
    maxBytes: z.number().int().positive("maxBytes must be positive").optional().describe("Requested maximum diff bytes"),
  })
  .strict();

export type GitDiffInput = z.infer<typeof GitDiffInputSchema>;

export const GitDiffOutputSchema = z
  .object({
    diff: z.string(),
    filesChanged: z.number().int().nonnegative(),
    insertions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    diffHash: z.string().optional(),
    isTruncated: z.boolean(),
  })
  .strict();

export type GitDiffOutput = z.infer<typeof GitDiffOutputSchema>;

// ============================================================================
// 6. run_command (Security Critical: argv discrete tokens only)
// ============================================================================

export const RunCommandInputSchema = z
  .object({
    argv: z
      .array(z.string())
      .min(1, "argv must contain at least the executable command")
      .superRefine((arr, ctx) => {
        if (!arr[0] || arr[0].trim().length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Executable name (argv[0]) cannot be empty or whitespace only",
          });
        }
      })
      .describe("Array of discrete arguments where argv[0] is the executable name"),
    cwd: WorkspaceDirectoryPathSchema.optional().default("."),
    timeoutMs: z.number().int().positive("timeoutMs must be positive").optional().describe("Requested timeout in ms"),
    maxOutputBytes: z.number().int().positive("maxOutputBytes must be positive").optional().describe("Requested maximum output bytes"),
  })
  .strict();

export type RunCommandInput = z.infer<typeof RunCommandInputSchema>;

export const RunCommandOutputSchema = z
  .object({
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: z.number().int().nonnegative(),
    outputTruncated: z.boolean(),
    commandHash: z.string().optional(),
  })
  .strict();

export type RunCommandOutput = z.infer<typeof RunCommandOutputSchema>;

// ============================================================================
// Mapping Types
// ============================================================================

export interface ToolInputMap {
  readonly read_file: ReadFileInput;
  readonly write_file: WriteFileInput;
  readonly search_code: SearchCodeInput;
  readonly git_status: GitStatusInput;
  readonly git_diff: GitDiffInput;
  readonly run_command: RunCommandInput;
}

export interface ToolOutputMap {
  readonly read_file: ReadFileOutput;
  readonly write_file: WriteFileOutput;
  readonly search_code: SearchCodeOutput;
  readonly git_status: GitStatusOutput;
  readonly git_diff: GitDiffOutput;
  readonly run_command: RunCommandOutput;
}
