/**
 * Failed-Anchor Tracker for Emerald Agent Fabric.
 *
 * Implements bounded failed-anchor memory for edit_file attempts.
 * Prevents agents from immediately repeating identical failed anchors without fresh source evidence.
 *
 * Invariants:
 * 1. Execution-Grounded: Records an anchor ONLY after actual edit execution fails because the anchor was missing or ambiguous.
 * 2. Fresh-Read Invalidation: A fresh successful read of the target file invalidates all failed anchors for that file.
 * 3. Mutation Invalidation: A successful file mutation clears stale failed-anchor state for that file.
 * 4. Deterministic Keying: Paths are normalized to workspace-relative forward-slash form.
 * 5. Scoped Lifetime: Scoped to a single run/trial; never leaks across tasks or trials.
 */

export interface FailedAnchorRecord {
  readonly path: string;
  readonly anchor: string;
  readonly failureReason: "MISSING" | "AMBIGUOUS";
  readonly failedAtStep: number;
}

export class FailedAnchorTracker {
  private readonly failedAnchors = new Map<string, Map<string, FailedAnchorRecord>>();

  public normalizePath(filePath: string): string {
    return filePath.split("\\").join("/").replace(/^\.\//, "");
  }

  public recordFailure(
    filePath: string,
    anchor: string,
    failureReason: "MISSING" | "AMBIGUOUS",
    stepNumber: number
  ): void {
    if (!filePath || !anchor) return;
    const norm = this.normalizePath(filePath);
    let fileMap = this.failedAnchors.get(norm);
    if (!fileMap) {
      fileMap = new Map();
      this.failedAnchors.set(norm, fileMap);
    }
    fileMap.set(anchor, {
      path: norm,
      anchor,
      failureReason,
      failedAtStep: stepNumber,
    });
  }

  public isFailedAnchor(filePath: string, anchor: string): boolean {
    if (!filePath || !anchor) return false;
    const norm = this.normalizePath(filePath);
    const fileMap = this.failedAnchors.get(norm);
    return fileMap !== undefined && fileMap.has(anchor);
  }

  public getFailedAnchorRecord(filePath: string, anchor: string): FailedAnchorRecord | undefined {
    if (!filePath || !anchor) return undefined;
    const norm = this.normalizePath(filePath);
    return this.failedAnchors.get(norm)?.get(anchor);
  }

  /**
   * Clears all failed anchors for a given file path.
   * Triggered upon a fresh successful read_file or successful mutation.
   */
  public clearForFile(filePath: string): void {
    if (!filePath) return;
    const norm = this.normalizePath(filePath);
    this.failedAnchors.delete(norm);
  }

  /**
   * Searches across tracked failed anchors to see if a query matches any failed anchor in a target file or pattern.
   * Used by zero-match search recovery (Option D).
   */
  public findMatchingFailedAnchor(query: string, filePattern?: string): FailedAnchorRecord | undefined {
    if (!query) return undefined;
    for (const [filePath, fileMap] of this.failedAnchors.entries()) {
      if (filePattern && filePattern !== "*" && !filePath.includes(this.normalizePath(filePattern))) {
        continue;
      }
      const record = fileMap.get(query);
      if (record) {
        return record;
      }
    }
    return undefined;
  }

  public clearAll(): void {
    this.failedAnchors.clear();
  }

  public getTrackedFileCount(): number {
    return this.failedAnchors.size;
  }

  public getTotalFailedAnchorCount(): number {
    let count = 0;
    for (const fileMap of this.failedAnchors.values()) {
      count += fileMap.size;
    }
    return count;
  }
}
