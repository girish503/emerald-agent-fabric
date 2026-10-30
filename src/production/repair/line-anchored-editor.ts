/**
 * Emerald Agent Fabric — Production V1.6: Line-Anchored Editor
 *
 * Provides constrained, line-anchored search-and-replace file editing.
 * Replaces exact text spans without whole-file replacement.
 *
 * Core Invariants:
 * 1. Only workspace-contained files can be edited (strict path traversal checks).
 * 2. Anchors must match uniquely by default; ambiguous or zero matches fail closed.
 * 3. File content outside the anchor is preserved byte-for-byte.
 * 4. Stale edits with mismatched expected digests fail closed without modifying disk.
 * 5. Malformed inputs fail closed without modifying disk.
 * 6. Never silently fall back to whole-file replacement.
 * 7. Operations are non-authoritative (sovereign verifier remains sole authority).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { MutationAuthorityContext, MutationIntentStorePort } from "../../ports/mutation-intent-store.port.js";
import {
  MutationIntent,
  MutationLifecycleStatus,
  computeRecoveryDedupToken,
} from "../../domain/mutation-intent.js";
import {
  DigestMismatchError,
  IncompletePriorMutationError,
  LeaseExpiredError,
  LeaseLostError,
  MissingMutationAuthorityError,
  PostWriteVerificationError,
  PreRenameConflictError,
  SnapshotContainmentError,
  SnapshotCreationError,
} from "../../domain/errors.js";

export interface LineAnchoredEditInput {
  readonly path: string;
  readonly searchAnchor: string;
  readonly replacementText: string;
  readonly expectedDigest?: string;
  readonly allowMultipleMatches?: boolean;
}

export interface LineAnchoredMutationOptions {
  readonly runId: string;
  readonly workerId: string;
  readonly workerLeaseId: string;
  readonly store: MutationIntentStorePort;
  readonly snapshotDir?: string;
  readonly mutationId?: string;
}

export interface PlannedEdit {
  readonly safePath: string;
  readonly relativePath: string;
  readonly originalContent: string;
  readonly originalDigest: string;
  readonly newContent: string;
  readonly resultingDigest: string;
  readonly occurrences: number;
  readonly replacedCount: number;
  readonly bytesModified: number;
}

export interface LineAnchoredEditResult {
  readonly success: boolean;
  readonly path: string;
  readonly originalDigest: string;
  readonly resultingDigest: string;
  readonly occurrences: number;
  readonly replacedCount: number;
  readonly bytesModified: number;
  readonly applied: boolean;
  readonly mutationId?: string;
  readonly error?: string;
  readonly authoritative: false;
  readonly verificationAuthority: false;
  readonly terminalAuthority: false;
}

export class LineAnchoredEditor {
  /**
   * Resolves and verifies that a relative path stays within the workspace boundary.
   * Enforces both lexical containment and canonical filesystem (realpath) containment.
   * Throws on directory traversal, outside absolute paths, or symlink/junction escapes.
   */
  public resolveSafePath(filePath: string, workspacePath: string): string {
    if (!filePath || typeof filePath !== "string") {
      throw new Error("File path must be a non-empty string");
    }

    // Security: reject Windows drive-relative paths (e.g., "C:foo", "D:bar/baz")
    if (/^[a-zA-Z]:(?![\/\\])/.test(filePath)) {
      throw new Error(`Path traversal denied outside workspace: ${filePath}`);
    }

    // 1. Lexical root-or-descendant boundary check
    const normalized = path.normalize(filePath);
    const resolved = path.resolve(workspacePath, normalized);
    const normResolved = resolved.split("\\").join("/").toLowerCase();
    const normBase = path.resolve(workspacePath).split("\\").join("/").toLowerCase();
    const normBaseWithSlash = normBase.endsWith("/") ? normBase : normBase + "/";

    // Security: ensure target is either the workspace root itself or a descendant separated by delimiter
    if (normResolved !== normBase && !normResolved.startsWith(normBaseWithSlash)) {
      throw new Error(`Path traversal denied outside workspace: ${filePath}`);
    }

    // 2. Canonical filesystem (realpath) containment check
    const canonicalRealpath = (p: string): string => {
      if (typeof fs.realpathSync.native === "function") {
        return fs.realpathSync.native(p);
      }
      return fs.realpathSync(p);
    };

    const normalizeCanonical = (p: string): string => {
      let s = p.split("\\").join("/");
      if (s.startsWith("//?/")) {
        s = s.slice(4);
      }
      return s.toLowerCase();
    };

    let canonicalWorkspace: string;
    try {
      canonicalWorkspace = canonicalRealpath(path.resolve(workspacePath));
    } catch {
      canonicalWorkspace = path.resolve(workspacePath);
    }
    const normCanonicalBase = normalizeCanonical(canonicalWorkspace);
    const normCanonicalBaseWithSlash = normCanonicalBase.endsWith("/") ? normCanonicalBase : normCanonicalBase + "/";

    // 3. For existing targets, validate canonical target
    if (fs.existsSync(resolved)) {
      let canonicalTarget: string;
      try {
        canonicalTarget = canonicalRealpath(resolved);
      } catch (err: any) {
        throw new Error(`Path traversal denied outside workspace (failed to canonicalize): ${filePath}`);
      }
      const normCanonicalTarget = normalizeCanonical(canonicalTarget);
      if (normCanonicalTarget !== normCanonicalBase && !normCanonicalTarget.startsWith(normCanonicalBaseWithSlash)) {
        throw new Error(`Path traversal denied outside workspace (canonical symlink escape): ${filePath}`);
      }
    } else {
      // 4. For non-existent targets, locate nearest existing ancestor and validate canonical path
      let curr = path.dirname(resolved);
      let existingAncestor: string | null = null;
      while (true) {
        if (fs.existsSync(curr)) {
          existingAncestor = curr;
          break;
        }
        const parent = path.dirname(curr);
        if (parent === curr) {
          break;
        }
        curr = parent;
      }

      if (!existingAncestor) {
        throw new Error(`Path traversal denied outside workspace (no valid existing ancestor): ${filePath}`);
      }

      let canonicalAncestor: string;
      try {
        canonicalAncestor = canonicalRealpath(existingAncestor);
      } catch (err: any) {
        throw new Error(`Path traversal denied outside workspace (failed to canonicalize ancestor): ${filePath}`);
      }

      const normCanonicalAncestor = normalizeCanonical(canonicalAncestor);
      if (normCanonicalAncestor !== normCanonicalBase && !normCanonicalAncestor.startsWith(normCanonicalBaseWithSlash)) {
        throw new Error(`Path traversal denied outside workspace (symlink ancestor escape): ${filePath}`);
      }

      const relFromAncestor = path.relative(existingAncestor, resolved);
      const canonicalTarget = path.resolve(canonicalAncestor, relFromAncestor);
      const normCanonicalTarget = normalizeCanonical(canonicalTarget);
      if (normCanonicalTarget !== normCanonicalBase && !normCanonicalTarget.startsWith(normCanonicalBaseWithSlash)) {
        throw new Error(`Path traversal denied outside workspace (canonical target escape): ${filePath}`);
      }
    }

    return resolved;
  }

  /**
   * Plans a constrained, line-anchored search-and-replace edit without mutating disk.
   * Validates paths, enforces pre-read size guards (<= 1 MiB), checks UTF-8 validity,
   * rejects binary null-bytes (0x00), verifies anchor uniqueness, and precomputes
   * the resulting digest deterministically.
   */
  public planEdit(
    rawInput: Record<string, unknown>,
    workspacePath: string,
  ): PlannedEdit {
    // 1. Normalize and validate input fields
    const targetFile = String(rawInput["path"] || rawInput["filePath"] || "");
    const searchAnchor = typeof rawInput["searchAnchor"] === "string"
      ? rawInput["searchAnchor"]
      : (typeof rawInput["oldText"] === "string" ? rawInput["oldText"] : (typeof rawInput["anchor"] === "string" ? rawInput["anchor"] : undefined));
    const replacementText = typeof rawInput["replacementText"] === "string"
      ? rawInput["replacementText"]
      : (typeof rawInput["newText"] === "string" ? rawInput["newText"] : (typeof rawInput["replacement"] === "string" ? rawInput["replacement"] : undefined));
    const expectedDigest = typeof rawInput["expectedDigest"] === "string" ? rawInput["expectedDigest"].trim().toLowerCase() : undefined;
    const allowMultipleMatches = Boolean(rawInput["allowMultipleMatches"]);

    if (!targetFile) {
      throw new Error("Invalid edit request: 'path' must be specified");
    }
    if (searchAnchor === undefined) {
      throw new Error("Invalid edit request: 'searchAnchor' (or 'oldText') must be provided as a string");
    }
    if (replacementText === undefined) {
      throw new Error("Invalid edit request: 'replacementText' (or 'newText') must be provided as a string");
    }
    if (searchAnchor.trim().length === 0) {
      throw new Error("Invalid edit request: 'searchAnchor' cannot be empty or whitespace-only");
    }
    if (searchAnchor === replacementText) {
      throw new Error(
        "Invalid edit request: 'searchAnchor' and 'replacementText' are identical. A localized edit must modify the file."
      );
    }

    // 2. Resolve and verify safe containment in workspace
    const safePath = this.resolveSafePath(targetFile, workspacePath);

    // 3. Verify file exists (cannot create files via anchored edits)
    if (!fs.existsSync(safePath)) {
      throw new Error(`File not found for line-anchored edit: ${targetFile}`);
    }

    const stat = fs.statSync(safePath);
    if (!stat.isFile()) {
      throw new Error(`Target path is not a regular file: ${targetFile}`);
    }

    // 4. Pre-Read Size Guard: Enforce 1 MiB ceiling per ADR-0036 Section 5.2
    const MAX_FILE_SIZE = 1048576; // 1 MiB (1,048,576 bytes)
    if (stat.size > MAX_FILE_SIZE) {
      throw new Error(
        `File size limit exceeded for line-anchored edit: ${stat.size} bytes exceeds maximum ${MAX_FILE_SIZE} bytes (1 MiB)`
      );
    }

    // 5. Read current file bytes and validate content (UTF-8 and zero null bytes)
    const rawBuffer = fs.readFileSync(safePath);

    // Reject binary files containing null bytes (0x00) per ADR-0036 Section 5.2
    if (rawBuffer.includes(0x00)) {
      throw new Error(
        `Binary file detected: target file contains null bytes (0x00), line-anchored editing rejected: ${targetFile}`
      );
    }

    // Validate UTF-8 encoding
    let originalContent: string;
    try {
      originalContent = new TextDecoder("utf-8", { fatal: true }).decode(rawBuffer);
    } catch {
      throw new Error(
        `Invalid UTF-8 encoding in target file: line-anchored editing rejected: ${targetFile}`
      );
    }

    const originalDigest = createHash("sha256").update(originalContent, "utf8").digest("hex");

    // 6. Optimistic concurrency check if expectedDigest provided
    if (expectedDigest && expectedDigest !== originalDigest) {
      throw new Error(
        `Stale edit precondition failed for ${targetFile}: expected digest '${expectedDigest}' but current digest is '${originalDigest}'`,
      );
    }

    // 7. Find occurrences of searchAnchor
    let occurrences = 0;
    let pos = 0;
    while ((pos = originalContent.indexOf(searchAnchor, pos)) !== -1) {
      occurrences++;
      pos += searchAnchor.length;
    }

    // Zero matches: fail closed without disk modification
    if (occurrences === 0) {
      throw new Error(
        `Search anchor not found in ${targetFile}: 0 occurrences matched '${searchAnchor.slice(0, 80)}${searchAnchor.length > 80 ? "..." : ""}'`,
      );
    }

    // Multiple matches when unique match is required: fail closed
    if (occurrences > 1 && !allowMultipleMatches) {
      throw new Error(
        `Ambiguous search anchor in ${targetFile}: ${occurrences} occurrences matched, but unique match is required. Provide more surrounding context lines.`,
      );
    }

    // 8. Perform replacement preserving surrounding bytes exactly
    let newContent: string;
    if (allowMultipleMatches) {
      newContent = originalContent.split(searchAnchor).join(replacementText);
    } else {
      const firstIdx = originalContent.indexOf(searchAnchor);
      const prefix = originalContent.slice(0, firstIdx);
      const suffix = originalContent.slice(firstIdx + searchAnchor.length);
      newContent = prefix + replacementText + suffix;
    }

    const resultingDigest = createHash("sha256").update(newContent, "utf8").digest("hex");
    const replacedCount = allowMultipleMatches ? occurrences : 1;
    const bytesModified = Buffer.byteLength(replacementText, "utf8");
    const relativePath = path.relative(workspacePath, safePath).replace(/\\/g, "/");

    return {
      safePath,
      relativePath,
      originalContent,
      originalDigest,
      newContent,
      resultingDigest,
      occurrences,
      replacedCount,
      bytesModified,
    };
  }

  /**
   * Applies a constrained, line-anchored search-and-replace edit to an existing file.
   * If mutationOptions is supplied, enforces the ADR-0036 Write-Ahead Mutation Intent (WAMI) lifecycle:
   *   RECORDED -> SNAPSHOT_WRITTEN -> APPLYING_MUTATION -> [Filesystem Atomic Rename] -> COMMITTED
   * If mutationOptions is omitted, performs the direct atomic edit (legacy mode).
   */
  public applyEdit(
    rawInput: Record<string, unknown>,
    workspacePath: string,
    mutationOptions?: LineAnchoredMutationOptions,
  ): LineAnchoredEditResult {
    // 1. Plan the edit deterministically without touching disk
    const plan = this.planEdit(rawInput, workspacePath);

    // 2. Legacy execution mode without mutation store
    if (!mutationOptions) {
      const tempFile = path.resolve(
        path.dirname(plan.safePath),
        `.tmp.${path.basename(plan.safePath)}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
      );

      try {
        fs.writeFileSync(tempFile, plan.newContent, "utf8");
        fs.renameSync(tempFile, plan.safePath);
      } catch (writeErr) {
        if (fs.existsSync(tempFile)) {
          try {
            fs.unlinkSync(tempFile);
          } catch {
            // Ignore temp cleanup error
          }
        }
        throw new Error(`Failed to commit atomic edit to ${plan.relativePath}: ${(writeErr as Error).message}`);
      }

      return {
        success: true,
        path: plan.relativePath,
        originalDigest: plan.originalDigest,
        resultingDigest: plan.resultingDigest,
        occurrences: plan.occurrences,
        replacedCount: plan.replacedCount,
        bytesModified: plan.bytesModified,
        applied: true,
        authoritative: false,
        verificationAuthority: false,
        terminalAuthority: false,
      };
    }

    // 3. ADR-0036 Write-Ahead Mutation Intent (WAMI) Lifecycle
    const { runId, workerId, workerLeaseId, store } = mutationOptions;

    // Validate safe identifier formats for runId, workerId, and workerLeaseId
    const SAFE_ID_REGEX = /^[a-zA-Z0-9_\-]+$/;
    if (!SAFE_ID_REGEX.test(runId)) {
      throw new SnapshotContainmentError(
        runId,
        runId,
        `Invalid runId format: must contain only alphanumeric characters, underscores, and hyphens`
      );
    }

    if (!workerId || typeof workerId !== "string" || workerId.trim().length === 0) {
      throw new MissingMutationAuthorityError(
        mutationOptions.mutationId ?? "unrecorded",
        "LineAnchoredEditor requires a non-empty, non-whitespace workerId in mutationOptions"
      );
    }
    if (!SAFE_ID_REGEX.test(workerId)) {
      throw new MissingMutationAuthorityError(
        mutationOptions.mutationId ?? "unrecorded",
        `Invalid workerId format: must contain only alphanumeric characters, underscores, and hyphens`
      );
    }

    if (!workerLeaseId || typeof workerLeaseId !== "string" || workerLeaseId.trim().length === 0) {
      throw new MissingMutationAuthorityError(
        mutationOptions.mutationId ?? "unrecorded",
        "LineAnchoredEditor requires a non-empty, non-whitespace workerLeaseId in mutationOptions"
      );
    }
    if (!SAFE_ID_REGEX.test(workerLeaseId)) {
      throw new MissingMutationAuthorityError(
        mutationOptions.mutationId ?? "unrecorded",
        `Invalid workerLeaseId format: must contain only alphanumeric characters, underscores, and hyphens`
      );
    }

    // 3a. Chain inspection & version determination
    const latestIntent = store.getLatestIntentForPath(runId, plan.relativePath);
    let pathMutationVersion = 1;
    let parentMutationId: string | null = null;

    if (latestIntent) {
      // 1. Unresolved prior intent check
      const INCOMPLETE_STATES: readonly MutationLifecycleStatus[] = [
        "RECORDED",
        "SNAPSHOT_WRITTEN",
        "APPLYING_MUTATION",
        "ROLLING_BACK",
      ];
      if (INCOMPLETE_STATES.includes(latestIntent.lifecycleStatus)) {
        throw new IncompletePriorMutationError(
          plan.relativePath,
          latestIntent.mutationId,
          latestIntent.lifecycleStatus,
          `Cannot mutate ${plan.relativePath}: prior mutation '${latestIntent.mutationId}' is in unresolved status '${latestIntent.lifecycleStatus}'. Prior mutations must be settled or rolled back before further edits.`
        );
      }

      const CONFLICT_TERMINAL_STATES: readonly MutationLifecycleStatus[] = [
        "ROLLBACK_CONFLICT_LOST_UPDATE",
        "ROLLBACK_CONFLICT_HASH_MISMATCH",
        "RESTORE_FAILED",
      ];
      if (CONFLICT_TERMINAL_STATES.includes(latestIntent.lifecycleStatus)) {
        throw new IncompletePriorMutationError(
          plan.relativePath,
          latestIntent.mutationId,
          latestIntent.lifecycleStatus,
          `Cannot mutate ${plan.relativePath}: prior mutation '${latestIntent.mutationId}' is in conflict/terminal failure state '${latestIntent.lifecycleStatus}'.`
        );
      }

      // 2. Digest chain continuity check based on prior intent lifecycle status
      if (latestIntent.lifecycleStatus === "COMMITTED" || latestIntent.lifecycleStatus === "VERIFIED_PASS") {
        if (latestIntent.expectedResultingDigest !== plan.originalDigest) {
          throw new DigestMismatchError(
            `Digest chain continuity violation for ${plan.relativePath}: current disk digest '${plan.originalDigest}' does not match latest intent expected resulting digest '${latestIntent.expectedResultingDigest}'`
          );
        }
      } else if (latestIntent.lifecycleStatus === "ROLLED_BACK") {
        // Authoritative expected baseline after rollback is baseDigest (D_0)
        if (latestIntent.baseDigest === "ABSENT") {
          throw new DigestMismatchError(
            `Digest chain continuity violation for ${plan.relativePath}: prior mutation '${latestIntent.mutationId}' rolled back file creation (baseline was ABSENT), but file exists on disk`
          );
        }
        if (latestIntent.baseDigest !== plan.originalDigest) {
          throw new DigestMismatchError(
            `Digest chain continuity violation after rollback for ${plan.relativePath}: current disk digest '${plan.originalDigest}' does not match rolled-back expected baseline digest '${latestIntent.baseDigest}'`
          );
        }
      } else if (latestIntent.lifecycleStatus === "ABORTED_UNMUTATED") {
        // Authoritative expected baseline after abort is baseDigest (D_0)
        if (latestIntent.baseDigest === "ABSENT") {
          throw new DigestMismatchError(
            `Digest chain continuity violation for ${plan.relativePath}: prior mutation '${latestIntent.mutationId}' was aborted on uncreated file (baseline was ABSENT), but file exists on disk`
          );
        }
        if (latestIntent.baseDigest !== plan.originalDigest) {
          throw new DigestMismatchError(
            `Digest chain continuity violation after abort for ${plan.relativePath}: current disk digest '${plan.originalDigest}' does not match aborted-unmutated baseline digest '${latestIntent.baseDigest}'`
          );
        }
      } else {
        throw new IncompletePriorMutationError(
          plan.relativePath,
          latestIntent.mutationId,
          latestIntent.lifecycleStatus,
          `Cannot mutate ${plan.relativePath}: unrecognized prior mutation status '${latestIntent.lifecycleStatus}'`
        );
      }

      pathMutationVersion = latestIntent.pathMutationVersion + 1;
      parentMutationId = latestIntent.mutationId;
    }

    const mutationId = mutationOptions.mutationId ?? `mut-${randomUUID()}`;
    if (!SAFE_ID_REGEX.test(mutationId)) {
      throw new SnapshotContainmentError(
        mutationId,
        mutationId,
        `Invalid mutationId format: must contain only alphanumeric characters, underscores, and hyphens`
      );
    }

    // Snapshot containment verification
    const snapshotDir = mutationOptions.snapshotDir ?? path.resolve(workspacePath, ".emerald", "snapshots", runId);
    const normWorkspace = path.resolve(workspacePath).split("\\").join("/").toLowerCase();
    const normSnapshotDir = path.resolve(snapshotDir).split("\\").join("/").toLowerCase();
    if (!normSnapshotDir.startsWith(normWorkspace.endsWith("/") ? normWorkspace : normWorkspace + "/")) {
      throw new SnapshotContainmentError(
        mutationId,
        snapshotDir,
        `Snapshot directory must be contained within workspace: ${snapshotDir}`
      );
    }

    fs.mkdirSync(snapshotDir, { recursive: true });
    const snapshotRef = path.resolve(snapshotDir, `${mutationId}.snap`);
    const normSnapshotRef = path.resolve(snapshotRef).split("\\").join("/").toLowerCase();
    if (!normSnapshotRef.startsWith(normSnapshotDir.endsWith("/") ? normSnapshotDir : normSnapshotDir + "/")) {
      throw new SnapshotContainmentError(
        mutationId,
        snapshotRef,
        `Snapshot file must be contained within snapshot directory: ${snapshotRef}`
      );
    }

    // 3b. RECORDED: Persist intent to SQLite before any filesystem mutation
    const intent: MutationIntent = {
      mutationId,
      runId,
      workerLeaseId,
      relativePath: plan.relativePath,
      canonicalPath: plan.safePath,
      parentMutationId,
      pathMutationVersion,
      baseDigest: plan.originalDigest,
      expectedResultingDigest: plan.resultingDigest,
      snapshotRef,
      recoveryDedupToken: computeRecoveryDedupToken(runId, mutationId, "RECORDED"),
      lifecycleStatus: "RECORDED",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    store.recordIntent(intent);

    // 3c. SNAPSHOT_WRITTEN: Write pre-mutation snapshot and transition
    const snapTemp = path.resolve(snapshotDir, `.tmp.${mutationId}.${Date.now()}`);
    try {
      fs.writeFileSync(snapTemp, plan.originalContent, "utf8");
      fs.renameSync(snapTemp, snapshotRef);
    } catch (snapErr: any) {
      if (fs.existsSync(snapTemp)) {
        try {
          fs.unlinkSync(snapTemp);
        } catch {}
      }
      throw new SnapshotCreationError(
        plan.relativePath,
        mutationId,
        `Failed to write pre-mutation snapshot for ${plan.relativePath}: ${snapErr.message}`
      );
    }

    let writtenSnapDigest: string;
    try {
      writtenSnapDigest = createHash("sha256").update(fs.readFileSync(snapshotRef, "utf8")).digest("hex");
    } catch (readErr: any) {
      throw new SnapshotCreationError(
        plan.relativePath,
        mutationId,
        `Failed to read snapshot file for verification: ${readErr.message}`
      );
    }

    if (writtenSnapDigest !== plan.originalDigest) {
      throw new SnapshotCreationError(
        plan.relativePath,
        mutationId,
        `Snapshot verification failed for ${plan.relativePath}: snapshot digest '${writtenSnapDigest}' does not match original digest '${plan.originalDigest}'`
      );
    }

    const authorityContext: MutationAuthorityContext = {
      authority: "WORKER",
      fencing: {
        workerId,
        leaseId: workerLeaseId,
        nowIso: new Date().toISOString(),
      },
    };

    store.transitionMutationStatus({
      mutationId,
      fromStatus: "RECORDED",
      toStatus: "SNAPSHOT_WRITTEN",
      event: {
        eventId: randomUUID(),
        runId,
        timestamp: new Date().toISOString(),
        eventType: "file.snapshot_written",
        schemaVersion: 1,
        producer: "LINE_ANCHORED_EDITOR",
        payload: {
          mutationId,
          relativePath: plan.relativePath,
          snapshotRef,
          baseDigest: plan.originalDigest,
        },
      },
      nextDedupToken: computeRecoveryDedupToken(runId, mutationId, "SNAPSHOT_WRITTEN"),
      authorityContext,
    });

    // 3d. APPLYING_MUTATION: Indicate that filesystem modification is in progress
    store.transitionMutationStatus({
      mutationId,
      fromStatus: "SNAPSHOT_WRITTEN",
      toStatus: "APPLYING_MUTATION",
      event: {
        eventId: randomUUID(),
        runId,
        timestamp: new Date().toISOString(),
        eventType: "file.applying_mutation",
        schemaVersion: 1,
        producer: "LINE_ANCHORED_EDITOR",
        payload: {
          mutationId,
          relativePath: plan.relativePath,
          pathMutationVersion,
          expectedResultingDigest: plan.resultingDigest,
        },
      },
      nextDedupToken: computeRecoveryDedupToken(runId, mutationId, "APPLYING_MUTATION"),
      authorityContext,
    });

    // 3e. Atomic filesystem mutation via temporary file in target directory (.emerald.tmp.<mutationId>.<nonce>)
    const nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const tempFile = path.resolve(
      path.dirname(plan.safePath),
      `.emerald.tmp.${mutationId}.${nonce}`
    );

    try {
      fs.writeFileSync(tempFile, plan.newContent, "utf8");

      // Work 3: Pre-rename target digest check immediately prior to replacement
      if (!fs.existsSync(plan.safePath)) {
        if (fs.existsSync(tempFile)) {
          try { fs.unlinkSync(tempFile); } catch {}
        }
        throw new PreRenameConflictError(
          plan.relativePath,
          plan.originalDigest,
          "FILE_DELETED",
          `Pre-rename verification failed for ${plan.relativePath}: target file was deleted concurrently after planning`
        );
      }

      let currentPreRenameContent: string;
      try {
        const currentPreRenameBuffer = fs.readFileSync(plan.safePath);
        currentPreRenameContent = new TextDecoder("utf-8", { fatal: true }).decode(currentPreRenameBuffer);
      } catch (decodeErr: any) {
        if (fs.existsSync(tempFile)) {
          try { fs.unlinkSync(tempFile); } catch {}
        }
        throw new PreRenameConflictError(
          plan.relativePath,
          plan.originalDigest,
          "INVALID_OR_UNREADABLE",
          `Pre-rename verification failed for ${plan.relativePath}: target file cannot be read or is invalid UTF-8 concurrently: ${decodeErr.message}`
        );
      }

      const currentPreRenameDigest = createHash("sha256").update(currentPreRenameContent, "utf8").digest("hex");
      if (currentPreRenameDigest !== plan.originalDigest) {
        if (fs.existsSync(tempFile)) {
          try { fs.unlinkSync(tempFile); } catch {}
        }
        throw new PreRenameConflictError(
          plan.relativePath,
          plan.originalDigest,
          currentPreRenameDigest,
          `Pre-rename verification failed for ${plan.relativePath}: file on disk was concurrently modified after planning (expected base '${plan.originalDigest}', found '${currentPreRenameDigest}')`
        );
      }

      // Windows bounded retry on EBUSY / EPERM (antivirus / file locks)
      let renamed = false;
      let lastRenameErr: unknown = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          fs.renameSync(tempFile, plan.safePath);
          renamed = true;
          break;
        } catch (renameErr) {
          lastRenameErr = renameErr;
          if (attempt < 3) {
            const sleepMs = attempt * 25;
            const waitTill = Date.now() + sleepMs;
            while (Date.now() < waitTill) {
              // spin wait
            }
          }
        }
      }
      if (!renamed) {
        throw lastRenameErr;
      }
    } catch (writeErr) {
      if (fs.existsSync(tempFile)) {
        try {
          fs.unlinkSync(tempFile);
        } catch {
          // Ignore temp cleanup error
        }
      }
      // Re-throw typed errors directly
      if (
        writeErr instanceof PreRenameConflictError ||
        writeErr instanceof SnapshotCreationError ||
        writeErr instanceof SnapshotContainmentError ||
        writeErr instanceof IncompletePriorMutationError ||
        writeErr instanceof DigestMismatchError ||
        writeErr instanceof LeaseExpiredError ||
        writeErr instanceof LeaseLostError ||
        writeErr instanceof MissingMutationAuthorityError
      ) {
        throw writeErr;
      }
      // On filesystem write failure, intent remains in APPLYING_MUTATION (reflecting CP4/CP4a)
      throw new Error(`Failed to commit atomic edit to ${plan.relativePath}: ${(writeErr as Error).message}`);
    }

    // Work 4: Post-write verification before COMMITTED
    let actualOnDiskContent: string;
    try {
      const actualOnDiskBuffer = fs.readFileSync(plan.safePath);
      actualOnDiskContent = new TextDecoder("utf-8", { fatal: true }).decode(actualOnDiskBuffer);
    } catch (readErr: any) {
      throw new PostWriteVerificationError(
        plan.relativePath,
        plan.resultingDigest,
        "UNREADABLE",
        `Post-write verification failed for ${plan.relativePath}: unable to re-read target after rename (${readErr.message})`
      );
    }

    const actualOnDiskDigest = createHash("sha256").update(actualOnDiskContent, "utf8").digest("hex");
    if (actualOnDiskDigest !== plan.resultingDigest) {
      throw new PostWriteVerificationError(
        plan.relativePath,
        plan.resultingDigest,
        actualOnDiskDigest,
        `Post-write verification failed for ${plan.relativePath}: actual on-disk digest '${actualOnDiskDigest}' does not match expected resulting digest '${plan.resultingDigest}'`
      );
    }

    // 3f. COMMITTED: Transition status in SQLite after successful rename
    store.transitionMutationStatus({
      mutationId,
      fromStatus: "APPLYING_MUTATION",
      toStatus: "COMMITTED",
      event: {
        eventId: randomUUID(),
        runId,
        timestamp: new Date().toISOString(),
        eventType: "file.mutation_committed",
        schemaVersion: 1,
        producer: "LINE_ANCHORED_EDITOR",
        payload: {
          mutationId,
          relativePath: plan.relativePath,
          pathMutationVersion,
          resultingDigest: plan.resultingDigest,
        },
      },
      nextDedupToken: computeRecoveryDedupToken(runId, mutationId, "COMMITTED"),
      authorityContext,
    });

    return {
      success: true,
      path: plan.relativePath,
      originalDigest: plan.originalDigest,
      resultingDigest: plan.resultingDigest,
      occurrences: plan.occurrences,
      replacedCount: plan.replacedCount,
      bytesModified: plan.bytesModified,
      applied: true,
      mutationId,
      authoritative: false,
      verificationAuthority: false,
      terminalAuthority: false,
    };
  }
}
