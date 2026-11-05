/**
 * Context Residency Tracker for Emerald Agent Fabric.
 *
 * Implements the Context-Residency Contract and Dynamic Tool Eligibility Model
 * specified in docs/research/phase45-dynamic-context-aware-tool-filtering-design.md.
 *
 * Architectural Invariants:
 * 1. Observation-Driven: Only trusted, successful, complete file observations establish residency.
 * 2. Conservative Invalidation: Partial reads, truncation, failures, mutations, or context budget
 *    evictions immediately invalidate residency and restore read_file eligibility (Rules 1-7).
 * 3. Non-Authoritative Optimization: Residency tracking is strictly a model prompt/grammar projection
 *    optimization to eliminate passive reading loops. It NEVER replaces runtime authorization,
 *    ProposalValidator, or PolicyEvaluator.
 * 4. Zero Semantic Fabrication: Residency reflects byte/line observation presence in context;
 *    it does NOT claim or assume that the model understands or reasons correctly about the file.
 */

import { createHash } from "node:crypto";
import { posix as posixPath } from "node:path";
import { ToolDefinition, ToolName } from "../domain/tool.js";
import { ReadFileInput, ReadFileOutput } from "../domain/tool-schemas.js";
import { ContextSnapshot } from "../domain/context.js";

// ============================================================================
// 1. Types & Interfaces
// ============================================================================

export interface FileResidencyRecord {
  /** Relative workspace path */
  readonly path: string;
  /** SHA-256 hash of the observed content payload */
  readonly contentHash: string;
  /** Total byte size of the file observed */
  readonly totalBytes: number;
  /** Total line count of the file observed */
  readonly totalLines: number;
  /** Whether the full file content is present without line or byte truncation */
  readonly isComplete: boolean;
  /** Sequence number of the step where this observation was captured */
  readonly sequenceNumber: number;
  /** Whether intervening actions have modified the workspace since observation */
  readonly isStale: boolean;
}

/**
 * Canonical key for a workspace-relative path: backslashes become slashes, then `.`/`..`/duplicate-slash
 * segments are collapsed (so `./input/a.md`, `input//a.md` and `input/../input/a.md` all map to `input/a.md`).
 * Returns "" for the workspace root. Tool adapters report the model-supplied spelling, so every residency
 * lookup and mutation must go through this to refer to the same file consistently.
 */
export function normalizeResidencyPath(rawPath: string): string {
  const normalized = posixPath.normalize(rawPath.replace(/\\/g, "/"));
  const stripped = normalized.replace(/^(\.\/)+/, "");
  return stripped === "." ? "" : stripped;
}

export type ToolEligibilityState = "ELIGIBLE" | "FILTERED" | "RESTORED";

export interface ContextResidencyTrackerOptions {
  /**
   * Whether dynamic context-aware tool filtering is enabled.
   * Default: false (preserves static schema behavior).
   */
  readonly enableDynamicToolFiltering?: boolean;
}

// ============================================================================
// 2. Implementation
// ============================================================================

export class ContextResidencyTracker {
  private readonly records = new Map<string, FileResidencyRecord>();
  private readonly enabled: boolean;

  constructor(options: ContextResidencyTrackerOptions = {}) {
    this.enabled = options.enableDynamicToolFiltering ?? false;
  }

  /**
   * Whether dynamic tool filtering is active in this tracker instance.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Records a successful file read observation.
   * Enforces Rule 2: Incomplete or truncated reads mark isComplete: false.
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
        input.limitLines >= output.totalLines) &&
      typeof output.content === "string";

    const contentHash = createHash("sha256")
      .update(output.content ?? "", "utf8")
      .digest("hex");

    const record: FileResidencyRecord = {
      path: output.path,
      contentHash,
      totalBytes: output.bytesRead,
      totalLines: output.totalLines ?? (output.content ? output.content.split("\n").length : 0),
      isComplete: isFullFile,
      sequenceNumber,
      isStale: false,
    };

    this.records.set(normalizeResidencyPath(output.path), record);
    return record;
  }

  /**
   * Records a workspace mutation (e.g. write_file).
   * Enforces Rule 1: Invalidates residency for target path (or entire workspace).
   */
  recordWorkspaceMutation(path?: string, sequenceNumber?: number): void {
    const target = path ? normalizeResidencyPath(path) : "";
    if (target !== "") {
      // Targeted mutation: invalidate only records for the same file. Comparison is case-folded because
      // workspace filesystems may be case-insensitive; folding can only over-invalidate (the safe direction).
      const foldedTarget = target.toLowerCase();
      this.records.forEach((rec, key) => {
        if (key.toLowerCase() === foldedTarget) {
          this.records.set(key, {
            ...rec,
            isStale: true,
            sequenceNumber: sequenceNumber ?? rec.sequenceNumber,
          });
        }
      });
    } else {
      // General workspace mutation (no target, or the workspace root): invalidate all
      this.records.forEach((rec, p) => {
        this.records.set(p, {
          ...rec,
          isStale: true,
          sequenceNumber: sequenceNumber ?? rec.sequenceNumber,
        });
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
    targetPath?: string,
    contextSnapshot?: ContextSnapshot,
    taskCategory?: string
  ): ToolEligibilityState {
    // When dynamic filtering is disabled, all registered tools are unconditionally ELIGIBLE
    if (!this.enabled) {
      return "ELIGIBLE";
    }

    // Only read_file is subject to residency-based filtering
    if (toolName !== "read_file") {
      return "ELIGIBLE";
    }

    // Rule 7: Pure navigation tasks bypass tool filtering entirely
    if (taskCategory === "CODE_NAVIGATION") {
      return "ELIGIBLE";
    }

    // If no specific target path is identified, do not filter read_file
    if (!targetPath) {
      return "ELIGIBLE";
    }

    const normalizedTarget = normalizeResidencyPath(targetPath);
    const record = this.records.get(normalizedTarget);

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

    // Rule 5: Context budget eviction - check if observation is actively present in snapshot
    if (contextSnapshot) {
      const hasObservationInSnapshot = contextSnapshot.observations.some((obs) => {
        if (obs.category === "TOOL_RESULT") {
          const payload = (obs.content as any)?.output ?? (obs.content as any)?.payload;
          return typeof payload?.path === "string" && normalizeResidencyPath(payload.path) === normalizedTarget;
        }
        return false;
      });

      if (!hasObservationInSnapshot) {
        return "RESTORED";
      }
    }

    // Complete, current, resident in snapshot: FILTERED
    return "FILTERED";
  }

  /**
   * Filters the list of available tools based on residency state.
   */
  filterEligibleTools(
    allTools: readonly ToolDefinition[],
    targetPath?: string,
    contextSnapshot?: ContextSnapshot,
    taskCategory?: string
  ): readonly ToolDefinition[] {
    if (!this.enabled) {
      return allTools;
    }

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

  /**
   * Returns the residency record for a specific file path, if any.
   */
  getResidency(path: string): FileResidencyRecord | undefined {
    return this.records.get(normalizeResidencyPath(path));
  }

  /**
   * Lists all tracked file residency records.
   */
  listResidencyRecords(): readonly FileResidencyRecord[] {
    const list: FileResidencyRecord[] = [];
    this.records.forEach((rec) => {
      list.push(rec);
    });
    return Object.freeze(list);
  }

  /**
   * Resets all residency records.
   */
  clear(): void {
    this.records.clear();
  }
}
