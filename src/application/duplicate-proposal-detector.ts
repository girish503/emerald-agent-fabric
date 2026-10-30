/**
 * Duplicate-Proposal Detector and Oversized Whole-File Anchor Inspector
 * for Emerald Agent Fabric.
 *
 * Implements bounded proposal memory for actions rejected prior to execution.
 * Prevents agents from repeatedly proposing identical rejected operations
 * without intervening successful actions or fresh evidence.
 *
 * Invariants:
 * 1. Fingerprint Determinism: sha256(toolName + ":" + canonicalJsonStringify(normalizedPayload)).
 * 2. Pre-Execution Grounded: Records a proposal ONLY after pre-execution rejection.
 * 3. Fresh-Action Invalidation: Any successful action execution clears or invalidates the duplicate memory.
 * 4. Fresh-Read Invalidation: A successful read_file of a target file invalidates duplicate records targeting that file.
 * 5. Bounded Memory: Retains at most a fixed bounded number of recent rejections (default: 10).
 * 6. Scoped Lifetime: Scoped to a single run/trial; never leaks across runs or trials.
 * 7. Non-Invasive: Never auto-corrects or modifies proposals, nor bypasses authoritative policy.
 */

import crypto from "node:crypto";
import { canonicalJsonStringify } from "../domain/canonical-hash.js";

/**
 * Deterministically checks whether a searchAnchor appears to be an oversized, whole-file anchor
 * rather than a localized code fragment (1-3 lines).
 *
 * Criteria (general-purpose, model/benchmark independent):
 * - Line count exceeds 5 lines (localized edits are typically 1-3 lines, max 5).
 * - Character count exceeds 200 characters with multiple line breaks.
 * - Structural markers indicating a multi-declaration module (e.g. multiple function/class declarations).
 *
 * Does NOT hard-code any specific file path, function name, 11-line count, or expected answer.
 */
export function isOversizedWholeFileAnchor(anchor: unknown): boolean {
  if (typeof anchor !== "string") return false;
  const trimmed = anchor.trim();
  if (trimmed.length === 0) return false;

  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length > 5) {
    return true;
  }
  if (trimmed.length > 200 && lines.length > 2) {
    return true;
  }

  // Check for multi-declaration module structure (e.g. multiple function/class declarations)
  const declarationMatches = trimmed.match(/\b(function\s+\w+|class\s+\w+|def\s+\w+)\b/g);
  if (declarationMatches && declarationMatches.length >= 2) {
    return true;
  }

  return false;
}

export interface DuplicateProposalRecord {
  readonly fingerprint: string;
  readonly toolName: string;
  readonly targetPath?: string;
  readonly stepNumber: number;
  readonly rejectionReason: string;
  readonly timestamp: string;
}

export interface IneffectiveMutationRecord {
  readonly fingerprint: string;
  readonly toolName: string;
  readonly targetPath: string;
  readonly stepNumber: number;
  readonly verificationClassification: string;
  readonly sourceHash: string;
  readonly workspaceMutationVersion: number;
  readonly timestamp: string;
}

export interface DuplicateProposalDetectorOptions {
  readonly maxCapacity?: number;
}

export class DuplicateProposalDetector {
  private readonly maxCapacity: number;
  private readonly records = new Map<string, DuplicateProposalRecord>();
  private readonly insertionOrder: string[] = [];
  private lastRejectedFingerprint: string | null = null;
  private readonly ineffectiveMutations = new Map<string, IneffectiveMutationRecord>();
  private readonly ineffectiveInsertionOrder: string[] = [];
  private currentWorkspaceMutationVersion: number = 0;

  constructor(options?: DuplicateProposalDetectorOptions) {
    this.maxCapacity = Math.max(1, options?.maxCapacity ?? 10);
  }

  /**
   * Normalizes workspace-relative paths to forward-slash form without leading `./`.
   */
  public normalizePath(filePath: string): string {
    return filePath.split("\\").join("/").replace(/^\.\//, "");
  }

  /**
   * Normalizes an input payload for fingerprinting by stripping volatile proposal-level
   * fields (e.g. proposalId, contextSnapshotHash, sequenceHint, rationale) and
   * normalizing path strings.
   */
  public normalizePayload(payload: unknown): unknown {
    if (payload === null || typeof payload !== "object") {
      return payload;
    }

    if (Array.isArray(payload)) {
      return payload.map((item) => this.normalizePayload(item));
    }

    const rec = payload as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(rec)) {
      // Exclude volatile metadata that changes across turns while the action remains identical
      if (
        key === "proposalId" ||
        key === "contextSnapshotHash" ||
        key === "sequenceHint" ||
        key === "rationale"
      ) {
        continue;
      }

      if (key === "path" && typeof value === "string") {
        normalized[key] = this.normalizePath(value);
      } else {
        normalized[key] = this.normalizePayload(value);
      }
    }

    return normalized;
  }

  /**
   * Computes a deterministic SHA-256 fingerprint for a tool proposal.
   */
  public computeFingerprint(toolName: string, inputPayload: unknown): string {
    const norm = this.normalizePayload(inputPayload);
    const serialized = canonicalJsonStringify(norm);
    return crypto
      .createHash("sha256")
      .update(`${toolName}:${serialized}`)
      .digest("hex");
  }

  /**
   * Extracts target path from inputPayload if present.
   */
  private extractTargetPath(inputPayload: unknown): string | undefined {
    if (
      inputPayload &&
      typeof inputPayload === "object" &&
      !Array.isArray(inputPayload)
    ) {
      const pathVal = (inputPayload as Record<string, unknown>).path;
      if (typeof pathVal === "string") {
        return this.normalizePath(pathVal);
      }
    }
    return undefined;
  }

  /**
   * Records a pre-execution proposal rejection.
   */
  public recordRejection(
    toolName: string,
    inputPayload: unknown,
    rejectionReason: string,
    stepNumber: number,
    timestamp?: string
  ): void {
    if (!toolName) return;

    const fp = this.computeFingerprint(toolName, inputPayload);
    const targetPath = this.extractTargetPath(inputPayload);

    const record: DuplicateProposalRecord = {
      fingerprint: fp,
      toolName,
      targetPath,
      stepNumber,
      rejectionReason,
      timestamp: timestamp ?? new Date().toISOString(),
    };

    // If key already exists, refresh its position in insertionOrder
    if (this.records.has(fp)) {
      const idx = this.insertionOrder.indexOf(fp);
      if (idx !== -1) {
        this.insertionOrder.splice(idx, 1);
      }
    } else if (this.insertionOrder.length >= this.maxCapacity) {
      // Evict oldest record
      const oldestFp = this.insertionOrder.shift();
      if (oldestFp) {
        this.records.delete(oldestFp);
      }
    }

    this.records.set(fp, record);
    this.insertionOrder.push(fp);
    this.lastRejectedFingerprint = fp;
  }

  /**
   * Checks whether the proposal matches an immediately preceding pre-execution rejection.
   */
  public isDuplicate(toolName: string, inputPayload: unknown): boolean {
    if (!toolName) return false;
    const fp = this.computeFingerprint(toolName, inputPayload);
    return this.lastRejectedFingerprint !== null && this.lastRejectedFingerprint === fp;
  }

  /**
   * Retrieves the duplicate record if the proposal matches an immediately preceding rejection.
   */
  public getDuplicateRecord(
    toolName: string,
    inputPayload: unknown
  ): DuplicateProposalRecord | undefined {
    if (!toolName) return undefined;
    const fp = this.computeFingerprint(toolName, inputPayload);
    if (this.lastRejectedFingerprint === fp) {
      return this.records.get(fp);
    }
    return undefined;
  }

  /**
   * Invalidation hook called whenever an action executes.
   * If the action succeeded, clears the immediately preceding rejection state,
   * ensuring that subsequent retries are evaluated with the benefit of the fresh action result.
   */
  public onActionExecuted(action: {
    readonly toolName: string;
    readonly status: string;
    readonly inputPayload?: unknown;
  }): void {
    if (action.status === "SUCCEEDED") {
      // Clear immediate rejection state on any successful execution
      this.lastRejectedFingerprint = null;

      const targetPath = this.extractTargetPath(action.inputPayload);
      if (targetPath) {
        this.clearForTarget(targetPath);
      }
    }
  }

  /**
   * Clears all recorded rejections targeting a specific file path.
   * Triggered upon a fresh successful read_file or successful mutation of that file.
   */
  public clearForTarget(targetPath: string): void {
    if (!targetPath) return;
    const norm = this.normalizePath(targetPath);

    const toRemove: string[] = [];
    for (const [fp, record] of this.records.entries()) {
      if (record.targetPath === norm) {
        toRemove.push(fp);
      }
    }

    for (const fp of toRemove) {
      this.records.delete(fp);
      const idx = this.insertionOrder.indexOf(fp);
      if (idx !== -1) {
        this.insertionOrder.splice(idx, 1);
      }
      if (this.lastRejectedFingerprint === fp) {
        this.lastRejectedFingerprint = null;
      }
    }
  }

  /**
   * Records a successful physical workspace file mutation (write_file or edit_file).
   * Monotonically increments the workspace mutation version.
   * Intervening mutations to other files in the workspace alter the multi-file
   * verification context, allowing previously ineffective edits on dependent files
   * to be legitimately reconsidered.
   */
  public recordWorkspaceMutation(targetPath?: string): void {
    this.currentWorkspaceMutationVersion++;
  }

  public getWorkspaceMutationVersion(): number {
    return this.currentWorkspaceMutationVersion;
  }

  /**
   * Records an executed mutating file operation that failed intermediate test verification.
   * Associating the mutation with the post-mutation source hash and workspace mutation version
   * allows detecting repeated ineffective proposals against the same unchanged source state,
   * while allowing reconsideration if an intervening mutation changes the workspace context.
   */
  public recordIneffectiveMutation(params: {
    readonly toolName: string;
    readonly inputPayload: unknown;
    readonly targetPath: string;
    readonly stepNumber: number;
    readonly verificationClassification: string;
    readonly sourceHash: string;
    readonly workspaceMutationVersion?: number;
    readonly timestamp?: string;
  }): void {
    if (!params.toolName || !params.targetPath) return;

    const fp = this.computeFingerprint(params.toolName, params.inputPayload);
    const normTarget = this.normalizePath(params.targetPath);

    const record: IneffectiveMutationRecord = {
      fingerprint: fp,
      toolName: params.toolName,
      targetPath: normTarget,
      stepNumber: params.stepNumber,
      verificationClassification: params.verificationClassification,
      sourceHash: params.sourceHash,
      workspaceMutationVersion:
        params.workspaceMutationVersion ?? this.currentWorkspaceMutationVersion,
      timestamp: params.timestamp ?? new Date().toISOString(),
    };

    if (this.ineffectiveMutations.has(fp)) {
      const idx = this.ineffectiveInsertionOrder.indexOf(fp);
      if (idx !== -1) {
        this.ineffectiveInsertionOrder.splice(idx, 1);
      }
    } else if (this.ineffectiveInsertionOrder.length >= this.maxCapacity) {
      const oldest = this.ineffectiveInsertionOrder.shift();
      if (oldest) {
        this.ineffectiveMutations.delete(oldest);
      }
    }

    this.ineffectiveMutations.set(fp, record);
    this.ineffectiveInsertionOrder.push(fp);
  }

  /**
   * Checks whether a proposed mutation matches an ineffective mutation whose intermediate
   * tests previously failed, provided the target file's current source hash has not changed
   * and no intervening file mutation has altered the workspace verification context.
   */
  public getIneffectiveMutationRecord(
    toolName: string,
    inputPayload: unknown,
    currentSourceHash?: string,
    workspaceMutationVersion?: number
  ): IneffectiveMutationRecord | undefined {
    if (toolName !== "edit_file" && toolName !== "write_file") {
      return undefined;
    }
    const fp = this.computeFingerprint(toolName, inputPayload);
    const record = this.ineffectiveMutations.get(fp);
    if (!record) {
      return undefined;
    }

    // Invalidation rule 1: Target file's content has changed since the recorded failure
    if (currentSourceHash !== undefined && currentSourceHash !== record.sourceHash) {
      return undefined;
    }

    // Invalidation rule 2: An intervening file mutation occurred in the workspace
    // since this ineffective mutation was recorded, changing the multi-file verification context
    const currentVersion = workspaceMutationVersion ?? this.currentWorkspaceMutationVersion;
    if (currentVersion > record.workspaceMutationVersion) {
      return undefined;
    }

    return record;
  }

  /**
   * Clears ineffective mutation records targeting a specific file.
   * Called when intermediate verification confirms that a repair PASSES for that file.
   */
  public clearIneffectiveForTarget(targetPath: string): void {
    if (!targetPath) return;
    const norm = this.normalizePath(targetPath);
    const toRemove: string[] = [];
    for (const [fp, record] of this.ineffectiveMutations.entries()) {
      if (record.targetPath === norm) {
        toRemove.push(fp);
      }
    }
    for (const fp of toRemove) {
      this.ineffectiveMutations.delete(fp);
      const idx = this.ineffectiveInsertionOrder.indexOf(fp);
      if (idx !== -1) {
        this.ineffectiveInsertionOrder.splice(idx, 1);
      }
    }
  }

  public getTrackedIneffectiveCount(): number {
    return this.ineffectiveMutations.size;
  }

  /**
   * Clears all state across trials/runs.
   */
  public clearAll(): void {
    this.records.clear();
    this.insertionOrder.length = 0;
    this.lastRejectedFingerprint = null;
    this.ineffectiveMutations.clear();
    this.ineffectiveInsertionOrder.length = 0;
    this.currentWorkspaceMutationVersion = 0;
  }

  public getTrackedCount(): number {
    return this.records.size;
  }

  public getLastRejectedFingerprint(): string | null {
    return this.lastRejectedFingerprint;
  }
}
