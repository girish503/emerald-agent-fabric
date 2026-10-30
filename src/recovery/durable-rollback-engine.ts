/**
 * Emerald Agent Fabric — Durable Rollback Engine
 *
 * Implements durable, fail-closed, resumable workspace mutation rollback
 * per ADR-0036 (Sections 3, 4, 5, and 6) and Phase 48AG.2 authority fencing.
 *
 * Core Invariants:
 * 1. Authority Fencing: Every transition requires supervisor authority validated inside SQLite.
 * 2. Snapshot Integrity: Never restore from missing, incomplete, or corrupt snapshot; never guess contents.
 * 3. Two-Layer Conflict Defense:
 *    - Layer 1 (Preflight): Validates all paths before modifying filesystem. If any path conflicts,
 *      0 files are modified on disk.
 *    - Layer 2 (Per-Path): Re-checks target digest immediately before replacement. On conflict, halts
 *      immediately, preserves conflicting file byte-for-byte untouched, and records partial conflict.
 * 4. Direct-to-Baseline: Restores target file directly to initial baseline D_0 (or unlinks if ABSENT).
 * 5. Crash-Consistency: Resumes deterministically across process crashes (CP1–CP7).
 * 6. Audit & Idempotency: All events use deterministic recovery deduplication tokens.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  MutationAuthorityContext,
  MutationIntentStorePort,
} from "../ports/mutation-intent-store.port.js";
import {
  MutationIntent,
  PathRollbackProgress,
  PathRollbackStatus,
  RunRollback,
  RunRollbackStatus,
  computeRecoveryDedupToken,
  isRollbackPendingStatus,
  isTerminalMutationStatus,
} from "../domain/mutation-intent.js";
import {
  DigestMismatchError,
  MissingMutationAuthorityError,
  RollbackConflictDetectedError,
  RollbackSnapshotCorruptError,
  RollbackSnapshotMissingError,
  SnapshotContainmentError,
  SupervisorLeaseExpiredError,
  SupervisorLeaseLostError,
  UnauthorizedMutationTransitionError,
  WorkspaceOwnershipMismatchError,
} from "../domain/errors.js";

function isWithinDirectory(candidate: string, dir: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p);
    return process.platform === "win32" || process.platform === "darwin" ? r.toLowerCase() : r;
  };
  const c = norm(candidate);
  const d = norm(dir);
  return c === d || c.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}

/** realpath of the deepest existing ancestor + the not-yet-existing remainder. */
function realishPath(p: string): string {
  const resolved = path.resolve(p);
  let probe = resolved;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(probe);
      return path.join(real, ...rest.reverse());
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return resolved;
      rest.push(path.basename(probe));
      probe = parent;
    }
  }
}

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" || process.platform === "darwin"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

/**
 * Intents of one path (sorted by version) that belong to the rollback generation being reconciled:
 * everything after the last already-reconciled intent, but never dropping an earlier intent that
 * is still pending (e.g. [v1 COMMITTED, v2 ABORTED_UNMUTATED] keeps both).
 */
function selectGenerationIntents(sorted: readonly MutationIntent[]): MutationIntent[] {
  let lastReconciled = -1;
  let firstPending = -1;
  for (let i = 0; i < sorted.length; i++) {
    const st = sorted[i]!.lifecycleStatus;
    if (st === "ROLLED_BACK" || st === "ABORTED_UNMUTATED") lastReconciled = i;
    if (firstPending < 0 && isRollbackPendingStatus(st)) firstPending = i;
  }
  let start = lastReconciled + 1;
  if (firstPending >= 0 && firstPending < start) start = firstPending;
  return sorted.slice(start);
}

/** Digests a file of this path may hold after any applied (or possibly applied) mutation in the chain. */
function chainDigestsOf(intents: readonly MutationIntent[], latestExpectedDigest: string): string[] {
  const digests = new Set<string>([latestExpectedDigest]);
  for (const intent of intents) {
    const st = intent.lifecycleStatus;
    if (st !== "RECORDED" && st !== "SNAPSHOT_WRITTEN" && st !== "ABORTED_UNMUTATED") {
      digests.add(intent.expectedResultingDigest);
    }
  }
  return Array.from(digests);
}

function isFencingError(err: unknown): boolean {
  return err instanceof SupervisorLeaseLostError || err instanceof SupervisorLeaseExpiredError;
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface RollbackOptions {
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly authorityContext: MutationAuthorityContext;
  readonly initiatedBy?: string;
  readonly conflictDetails?: string | null;
  /**
   * Re-validates live supervisor authority. Invoked immediately before every
   * destructive filesystem operation; must throw if authority has been lost.
   */
  readonly assertAuthorityActive?: () => void;
}

export interface RollbackExecutionResult {
  readonly runId: string;
  readonly status: RunRollbackStatus;
  readonly totalPaths: number;
  readonly restoredPaths: readonly string[];
  readonly conflictedPaths: readonly string[];
  readonly skippedPaths: readonly string[];
  readonly conflictDetails?: string | null;
}

interface PreflightPathPlan {
  readonly relativePath: string;
  readonly canonicalPath: string;
  readonly rootIntent: MutationIntent;
  readonly latestIntent: MutationIntent;
  readonly allIntents: readonly MutationIntent[];
  readonly isBaselineAbsent: boolean;
  readonly initialBaseDigest: string;
  readonly latestExpectedDigest: string;
  /** Digests the file may legitimately hold mid-chain (crash between chained mutations of one path). */
  readonly chainDigests: readonly string[];
  readonly baselineSnapshotRef: string;
  status: "READY" | "ALREADY_RESTORED" | "CONFLICT_LOST_UPDATE" | "SNAPSHOT_MISSING" | "SNAPSHOT_CORRUPT";
  errorDetails?: string;
}

async function atomicRenameWithRetry(
  src: string,
  dest: string,
  maxAttempts = 3,
  initialBackoffMs = 50
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (err: unknown) {
      const nodeErr = err as { code?: string; message?: string };
      const isLockError =
        nodeErr?.code === "EBUSY" || nodeErr?.code === "EPERM" || nodeErr?.code === "EACCES";
      if (isLockError && attempt < maxAttempts) {
        const delayMs = initialBackoffMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw err;
    }
  }
}

export class DurableRollbackEngine {
  constructor(private readonly store: MutationIntentStorePort) {}

  /**
   * Resolves a target path safely within the workspace boundary.
   * Rejects path traversal and Windows drive-relative syntax.
   */
  public resolveSafePath(filePath: string, workspaceRoot: string): string {
    if (!filePath || typeof filePath !== "string") {
      throw new Error("File path must be a non-empty string");
    }

    if (/^[a-zA-Z]:(?![\/\\])/.test(filePath)) {
      throw new SnapshotContainmentError(
        filePath,
        filePath,
        `Path traversal denied outside workspace (drive-relative syntax): ${filePath}`
      );
    }

    const normalized = path.normalize(filePath);
    const resolved = path.resolve(workspaceRoot, normalized);
    const normResolved = resolved.split("\\").join("/").toLowerCase();
    const normBase = path.resolve(workspaceRoot).split("\\").join("/").toLowerCase();
    const normBaseWithSlash = normBase.endsWith("/") ? normBase : normBase + "/";

    if (normResolved !== normBase && !normResolved.startsWith(normBaseWithSlash)) {
      throw new SnapshotContainmentError(
        filePath,
        resolved,
        `Path traversal denied outside workspace: ${filePath}`
      );
    }

    this.assertRealpathContained(filePath, resolved, workspaceRoot);
    return resolved;
  }

  /**
   * Rejects symlink/junction escapes: the deepest existing ancestor of the target must
   * resolve (realpath) inside the real workspace root, and an existing target must not
   * itself be a symlink. Residual: a swap after this check (TOCTOU) is not prevented.
   */
  private assertRealpathContained(filePath: string, resolved: string, workspaceRoot: string): void {
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(workspaceRoot);
    } catch {
      throw new SnapshotContainmentError(filePath, resolved, `Workspace root is not accessible: ${workspaceRoot}`);
    }

    let probe = resolved;
    for (;;) {
      try {
        const st = fs.lstatSync(probe);
        if (probe === resolved && st.isSymbolicLink()) {
          throw new SnapshotContainmentError(filePath, resolved, `Symlink target denied: ${filePath}`);
        }
        break;
      } catch (err: unknown) {
        if (err instanceof SnapshotContainmentError) throw err;
        const parent = path.dirname(probe);
        if (parent === probe) {
          throw new SnapshotContainmentError(filePath, resolved, `No existing ancestor inside workspace: ${filePath}`);
        }
        probe = parent;
      }
    }

    const realProbe = fs.realpathSync(probe);
    if (!isWithinDirectory(realProbe, realRoot)) {
      throw new SnapshotContainmentError(
        filePath,
        resolved,
        `Path resolves outside workspace via link: ${filePath} -> ${realProbe}`
      );
    }
  }

  /**
   * Resolves a recorded snapshot reference and requires it to be a regular file inside
   * <workspace>/.emerald/snapshots/<runId>/. Returns the real path to read from.
   */
  private resolveSnapshotPath(snapshotRef: string, workspaceRoot: string, runId: string): string {
    const fail = (why: string): never => {
      throw new SnapshotContainmentError(snapshotRef, snapshotRef, `Snapshot reference denied (${why}): ${snapshotRef}`);
    };
    let realRoot: string;
    let realSnap: string;
    try {
      realRoot = fs.realpathSync(workspaceRoot);
      if (fs.lstatSync(snapshotRef).isSymbolicLink()) fail("symlink");
      realSnap = fs.realpathSync(snapshotRef);
    } catch (err: unknown) {
      if (err instanceof SnapshotContainmentError) throw err;
      return fail("unreadable");
    }
    const allowedDir = path.join(realRoot, ".emerald", "snapshots", runId);
    if (!isWithinDirectory(realSnap, allowedDir) || realSnap === allowedDir) {
      fail("outside snapshot directory");
    }
    if (!fs.statSync(realSnap).isFile()) fail("not a regular file");
    return realSnap;
  }

  /**
   * Returns the run's rollback aggregate for the CURRENT generation. A COMPLETED aggregate only
   * covers the mutations that existed when it ran: if a later attempt recorded new unreconciled
   * (non-terminal) mutation intents, the stale record is retired so those get rolled back too,
   * instead of being reported "already rolled back".
   */
  private currentGenerationRollback(runId: string): RunRollback | null {
    const existing = this.store.getRunRollback(runId);
    if (existing && existing.status === "COMPLETED") {
      const hasUnreconciled = this.store
        .getIntentsForRun(runId)
        .some((i) => isRollbackPendingStatus(i.lifecycleStatus));
      if (hasUnreconciled) {
        this.store.resetCompletedRunRollback(runId);
        return null;
      }
    }
    return existing;
  }

  /**
   * Provenance check: every recorded mutation path must be exactly where the supplied
   * workspace says it is. A wrong, swapped or drifted workspace therefore fails closed
   * before any filesystem or bookkeeping change, independent of how the root was chosen.
   */
  private assertWorkspaceOwnsIntents(
    runId: string,
    relativePath: string,
    canonicalPath: string,
    intents: readonly MutationIntent[]
  ): void {
    const expected = realishPath(canonicalPath);
    for (const intent of intents) {
      if (!intent.canonicalPath) continue;
      if (!samePath(realishPath(intent.canonicalPath), expected)) {
        throw new WorkspaceOwnershipMismatchError(runId, relativePath, intent.canonicalPath, canonicalPath);
      }
    }
  }

  /** Deletes our own temp file only while authority is still live; otherwise preserves it. */
  private discardOwnTempFile(tempFile: string, options: RollbackOptions): void {
    try {
      if (fs.existsSync(tempFile)) {
        this.fence(options);
        fs.unlinkSync(tempFile);
      }
    } catch {
      // Authority lost or delete failed: preserve. Orphans are reclaimed later by
      // cleanOrphanedRestoreTempFiles under valid authority (content-digest proof).
    }
  }

  /**
   * Last check before replacement: the target must still hold the baseline or the expected
   * mutated content. Narrows (does not eliminate) the check-then-rename window; ADR-0036
   * risk #1 (cooperative single-writer) still applies.
   */
  private assertTargetStillExpected(targetPath: string, allowedDigests: readonly string[]): void {
    let digest = "ABSENT";
    try {
      digest = sha256(fs.readFileSync(targetPath));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }
    if (!allowedDigests.includes(digest)) {
      throw new DigestMismatchError(
        `Target changed immediately before replacement: got ${digest}, expected one of baseline/expected digests`
      );
    }
  }

  /**
   * Mandatory live-authority check. Always validates the supervisor lease against the store
   * (never trusts the shape of the authority context alone), then runs the optional extra guard.
   */
  private fence(options: RollbackOptions): void {
    const ctx = options.authorityContext;
    if (!ctx || ctx.authority !== "SUPERVISOR") {
      throw new MissingMutationAuthorityError(options.runId, "Filesystem mutation requires SUPERVISOR authority");
    }
    this.store.validateSupervisorFencing(options.runId, {
      supervisorId: ctx.supervisorFencing.supervisorId,
      leaseId: ctx.supervisorFencing.leaseId,
    });
    options.assertAuthorityActive?.();
  }

  /**
   * Cleans orphaned restore temp files (.emerald.tmp.restore.*) that are provably ours:
   * a regular, non-symlink file whose content digest equals the baseline digest this
   * rollback would restore (i.e. a copy of our own snapshot). Anything else with the
   * same prefix cannot be attributed by name and is PRESERVED (ADR-0036 risk #3).
   * Returns the preserved (unrecognized) file names.
   */
  public cleanOrphanedRestoreTempFiles(
    dir: string,
    ownedDigests: readonly string[],
    options: RollbackOptions
  ): string[] {
    const preserved: string[] = [];
    if (!fs.existsSync(dir)) return preserved;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return preserved;
    }
    for (const entry of entries) {
      if (!entry.startsWith(".emerald.tmp.restore.")) continue;
      const fullPath = path.join(dir, entry);
      try {
        const st = fs.lstatSync(fullPath);
        if (!st.isFile() || st.isSymbolicLink() || !ownedDigests.includes(sha256(fs.readFileSync(fullPath)))) {
          preserved.push(entry);
          continue;
        }
        this.fence(options);
        fs.unlinkSync(fullPath);
      } catch (err: unknown) {
        if (isFencingError(err)) throw err;
        preserved.push(entry);
      }
    }
    return preserved;
  }

  /**
   * Validates authority context before performing rollback operations.
   * Strictly enforces SUPERVISOR authority per Phase 48AG.2.
   */
  private validateSupervisorAuthority(
    runId: string,
    authorityContext: MutationAuthorityContext
  ): void {
    if (!authorityContext || typeof authorityContext !== "object") {
      throw new MissingMutationAuthorityError(
        runId,
        "DurableRollbackEngine requires a valid MutationAuthorityContext"
      );
    }

    if (authorityContext.authority !== "SUPERVISOR") {
      throw new UnauthorizedMutationTransitionError(
        runId,
        authorityContext.authority,
        "COMMITTED",
        "ROLLING_BACK",
        `Rollback execution requires SUPERVISOR authority, got '${authorityContext.authority}'`
      );
    }

    const { supervisorFencing } = authorityContext;
    if (!supervisorFencing || typeof supervisorFencing !== "object") {
      throw new MissingMutationAuthorityError(
        runId,
        "Supervisor authority context requires valid SupervisorFencingCheck"
      );
    }

    if (!supervisorFencing.supervisorId || supervisorFencing.supervisorId.trim().length === 0) {
      throw new MissingMutationAuthorityError(
        runId,
        "Supervisor authority context requires non-empty supervisorId"
      );
    }

    if (!supervisorFencing.leaseId || supervisorFencing.leaseId.trim().length === 0) {
      throw new MissingMutationAuthorityError(
        runId,
        "Supervisor authority context requires non-empty leaseId"
      );
    }
  }

  /**
   * Executes a durable rollback for the specified runId.
   */
  public async executeRollback(options: RollbackOptions): Promise<RollbackExecutionResult> {
    const { runId, workspaceRoot, authorityContext } = options;

    if (!runId || typeof runId !== "string" || runId.trim().length === 0) {
      throw new Error("Invalid runId: must be non-empty string");
    }
    if (!workspaceRoot || typeof workspaceRoot !== "string") {
      throw new Error("Invalid workspaceRoot: must be non-empty string");
    }

    this.validateSupervisorAuthority(runId, authorityContext);
    this.fence(options);

    // 1. Check existing run rollback aggregate (starting a new generation if the previous one
    //    COMPLETED but later attempts recorded unreconciled mutations)
    const existingRollback = this.currentGenerationRollback(runId);
    if (existingRollback) {
      if (existingRollback.status === "COMPLETED") {
        const progressList = this.store.listPathRollbackProgress(runId);
        return {
          runId,
          status: "COMPLETED",
          totalPaths: progressList.length,
          restoredPaths: progressList.filter((p) => p.status === "RESTORED").map((p) => p.relativePath),
          conflictedPaths: [],
          skippedPaths: [],
          conflictDetails: null,
        };
      }

      if (existingRollback.status === "PARTIALLY_ROLLED_BACK_CONFLICT") {
        const progressList = this.store.listPathRollbackProgress(runId);
        return {
          runId,
          status: "PARTIALLY_ROLLED_BACK_CONFLICT",
          totalPaths: progressList.length,
          restoredPaths: progressList.filter((p) => p.status === "RESTORED").map((p) => p.relativePath),
          conflictedPaths: progressList.filter((p) => p.status === "CONFLICT_SKIPPED" || p.status === "RESTORE_FAILED").map((p) => p.relativePath),
          skippedPaths: progressList.filter((p) => p.status === "PENDING").map((p) => p.relativePath),
          conflictDetails: existingRollback.conflictDetails,
        };
      }

      // An IDLE aggregate means preflight never finished: re-run it (below) instead of resuming.
      if (existingRollback.status !== "IDLE") {
        return this.resumeRollback(options);
      }
    }
    const resumingIdle = existingRollback?.status === "IDLE";

    // 2. Query all mutation intents for this run
    const allIntents = this.store.getIntentsForRun(runId);
    if (allIntents.length === 0 && resumingIdle) {
      this.store.updateRunRollbackStatus(runId, "COMPLETED", Date.now(), null);
      return {
        runId,
        status: "COMPLETED",
        totalPaths: 0,
        restoredPaths: [],
        conflictedPaths: [],
        skippedPaths: [],
        conflictDetails: null,
      };
    }
    if (allIntents.length === 0) {
      // Zero mutations recorded; record completed rollback record
      const emptyRollback: RunRollback = {
        runId,
        status: "COMPLETED",
        initiatedBy: options.initiatedBy ?? "SUPERVISOR",
        createdAt: Date.now(),
        completedAt: Date.now(),
        conflictDetails: null,
      };
      this.store.recordRunRollback(emptyRollback, []);
      return {
        runId,
        status: "COMPLETED",
        totalPaths: 0,
        restoredPaths: [],
        conflictedPaths: [],
        skippedPaths: [],
        conflictDetails: null,
      };
    }

    // 3. Group intents by relativePath and sort deterministically
    const intentsByPath = new Map<string, MutationIntent[]>();
    for (const intent of allIntents) {
      const list = intentsByPath.get(intent.relativePath) ?? [];
      list.push(intent);
      intentsByPath.set(intent.relativePath, list);
    }

    const sortedRelativePaths = Array.from(intentsByPath.keys()).sort();
    const plans: PreflightPathPlan[] = [];
    const initialProgressList: PathRollbackProgress[] = [];

    const nowMs = Date.now();
    for (const relPath of sortedRelativePaths) {
      const sortedIntents = intentsByPath.get(relPath)!.sort((a, b) => a.pathMutationVersion - b.pathMutationVersion);
      // Only this rollback generation's intents are planned; the baseline and snapshot of an
      // earlier, already rolled-back attempt must not be reused.
      const intents = selectGenerationIntents(sortedIntents);
      if (intents.length === 0) continue; // fully reconciled by an earlier rollback
      const rootIntent = intents[0];
      const latestIntent = intents[intents.length - 1];
      const isBaselineAbsent = rootIntent.baseDigest === "ABSENT";
      const initialBaseDigest = rootIntent.baseDigest;
      const latestExpectedDigest = latestIntent.expectedResultingDigest;
      const baselineSnapshotRef = rootIntent.snapshotRef;

      const canonicalPath = this.resolveSafePath(relPath, workspaceRoot);
      this.assertWorkspaceOwnsIntents(runId, relPath, canonicalPath, intents);

      plans.push({
        relativePath: relPath,
        canonicalPath,
        rootIntent,
        latestIntent,
        allIntents: intents,
        isBaselineAbsent,
        initialBaseDigest,
        latestExpectedDigest,
        chainDigests: chainDigestsOf(intents, latestExpectedDigest),
        baselineSnapshotRef,
        status: "READY",
      });

      initialProgressList.push({
        runId,
        relativePath: relPath,
        status: "PENDING",
        initialBaseDigest,
        latestExpectedDigest,
        baselineSnapshotRef,
        updatedAt: nowMs,
        errorMessage: null,
      });
    }

    if (plans.length === 0) {
      // Every recorded mutation was already reconciled: nothing to restore
      if (resumingIdle) {
        this.store.updateRunRollbackStatus(runId, "COMPLETED", Date.now(), null);
      } else {
        this.store.recordRunRollback(
          {
            runId,
            status: "COMPLETED",
            initiatedBy: options.initiatedBy ?? "SUPERVISOR",
            createdAt: Date.now(),
            completedAt: Date.now(),
            conflictDetails: null,
          },
          []
        );
      }
      return {
        runId,
        status: "COMPLETED",
        totalPaths: 0,
        restoredPaths: [],
        conflictedPaths: [],
        skippedPaths: [],
        conflictDetails: null,
      };
    }

    // Atomically persist run_rollbacks (status: IDLE) and all path progress rows (status: PENDING)
    const initialRollback: RunRollback = {
      runId,
      status: "IDLE",
      initiatedBy: options.initiatedBy ?? "SUPERVISOR",
      createdAt: nowMs,
      completedAt: null,
      conflictDetails: options.conflictDetails ?? null,
    };
    if (!resumingIdle) {
      this.store.recordRunRollback(initialRollback, initialProgressList);
    }

    // 4. LAYER 1: PREFLIGHT VALIDATION (ADR-0036 Section 3.4)
    // Check all paths BEFORE any filesystem modifications
    let preflightConflictDetected = false;
    const preflightFailures: Array<{ relativePath: string; reason: string; expected: string; actual: string }> = [];

    for (const plan of plans) {
      // 4a. Validate snapshot integrity (if baseline was not absent). Paths whose intents
      // never reached APPLYING_MUTATION (crash at CP2) were never modified, so no snapshot
      // is needed: the disk check below proves the file is still at baseline.
      const neverMutated = plan.allIntents.every(
        (i) => i.lifecycleStatus === "RECORDED" || i.lifecycleStatus === "SNAPSHOT_WRITTEN"
      );
      if (!plan.isBaselineAbsent && !neverMutated) {
        if (!fs.existsSync(plan.baselineSnapshotRef)) {
          plan.status = "SNAPSHOT_MISSING";
          plan.errorDetails = `Snapshot file missing: ${plan.baselineSnapshotRef}`;
          preflightConflictDetected = true;
          preflightFailures.push({
            relativePath: plan.relativePath,
            reason: "SNAPSHOT_MISSING",
            expected: plan.initialBaseDigest,
            actual: "FILE_MISSING",
          });
          continue;
        }

        let snapBytes: Buffer;
        try {
          snapBytes = fs.readFileSync(this.resolveSnapshotPath(plan.baselineSnapshotRef, workspaceRoot, runId));
        } catch (err: unknown) {
          plan.status = "SNAPSHOT_CORRUPT";
          plan.errorDetails = `Failed to read snapshot file: ${(err as Error).message}`;
          preflightConflictDetected = true;
          preflightFailures.push({
            relativePath: plan.relativePath,
            reason: "SNAPSHOT_READ_ERROR",
            expected: plan.initialBaseDigest,
            actual: "READ_FAILED",
          });
          continue;
        }

        const snapDigest = sha256(snapBytes);
        if (snapDigest !== plan.initialBaseDigest) {
          plan.status = "SNAPSHOT_CORRUPT";
          plan.errorDetails = `Snapshot digest mismatch: expected ${plan.initialBaseDigest}, got ${snapDigest}`;
          preflightConflictDetected = true;
          preflightFailures.push({
            relativePath: plan.relativePath,
            reason: "SNAPSHOT_CORRUPT",
            expected: plan.initialBaseDigest,
            actual: snapDigest,
          });
          continue;
        }
      }

      // 4b. Validate current target file on disk
      if (!fs.existsSync(plan.canonicalPath)) {
        if (plan.isBaselineAbsent) {
          // File was created by run, but is absent on disk now (already at baseline)
          plan.status = "ALREADY_RESTORED";
        } else {
          // Target file missing on disk when it originally existed
          plan.status = "CONFLICT_LOST_UPDATE";
          plan.errorDetails = "Target file missing on disk prior to rollback";
          preflightConflictDetected = true;
          preflightFailures.push({
            relativePath: plan.relativePath,
            reason: "TARGET_MISSING_ON_DISK",
            expected: plan.latestExpectedDigest,
            actual: "ABSENT",
          });
        }
        continue;
      }

      let diskBytes: Buffer;
      try {
        diskBytes = fs.readFileSync(plan.canonicalPath);
      } catch (err: unknown) {
        plan.status = "CONFLICT_LOST_UPDATE";
        plan.errorDetails = `Failed to read target file on disk: ${(err as Error).message}`;
        preflightConflictDetected = true;
        preflightFailures.push({
          relativePath: plan.relativePath,
          reason: "TARGET_READ_ERROR",
          expected: plan.latestExpectedDigest,
          actual: "READ_FAILED",
        });
        continue;
      }

      const diskDigest = sha256(diskBytes);
      if (diskDigest === plan.initialBaseDigest) {
        // Target is already at pre-mutation baseline D_0
        plan.status = "ALREADY_RESTORED";
      } else if (plan.chainDigests.includes(diskDigest)) {
        // Target matches expected post-mutation state D_n
        plan.status = "READY";
      } else {
        // Target modified externally (foreign digest D_x)
        plan.status = "CONFLICT_LOST_UPDATE";
        plan.errorDetails = `External modification detected on target file: expected ${plan.latestExpectedDigest}, got ${diskDigest}`;
        preflightConflictDetected = true;
        preflightFailures.push({
          relativePath: plan.relativePath,
          reason: "CONFLICT_LOST_UPDATE",
          expected: plan.latestExpectedDigest,
          actual: diskDigest,
        });
      }
    }

    // 4c. If preflight conflict detected: FAIL-CLOSED WITH ZERO FILESYSTEM MODIFICATIONS
    if (preflightConflictDetected) {
      const conflictJson = JSON.stringify({ preflight: true, failures: preflightFailures });
      this.store.updateRunRollbackStatus(runId, "PARTIALLY_ROLLED_BACK_CONFLICT", null, conflictJson);

      for (const plan of plans) {
        const errorMsg = plan.errorDetails ?? (plan.status !== "READY" ? plan.status : "Preflight conflict in sibling path");
        this.store.updatePathRollbackProgress(runId, plan.relativePath, "CONFLICT_SKIPPED", errorMsg);

        // Transition the conflicted mutation intent to terminal conflict status if applicable
        if (plan.status === "CONFLICT_LOST_UPDATE" && !isTerminalMutationStatus(plan.latestIntent.lifecycleStatus)) {
          try {
            this.store.transitionMutationStatus({
              mutationId: plan.latestIntent.mutationId,
              fromStatus: plan.latestIntent.lifecycleStatus,
              toStatus: "ROLLBACK_CONFLICT_LOST_UPDATE",
              event: {
                eventId: randomUUID(),
                runId,
                timestamp: new Date().toISOString(),
                eventType: "file.rollback_conflict",
                schemaVersion: 1,
                producer: "DURABLE_ROLLBACK_ENGINE",
                payload: {
                  mutationId: plan.latestIntent.mutationId,
                  relativePath: plan.relativePath,
                  expectedDigest: plan.latestExpectedDigest,
                  actualDigest: preflightFailures.find((f) => f.relativePath === plan.relativePath)?.actual ?? "UNKNOWN",
                  conflictType: "LOST_UPDATE",
                  targetPreserved: true,
                },
              },
              nextDedupToken: computeRecoveryDedupToken(runId, plan.latestIntent.mutationId, "ROLLBACK_CONFLICT_LOST_UPDATE"),
              authorityContext,
              conflictDetails: conflictJson,
            });
          } catch {
            // Safe transition ignore if status already changed
          }
        } else if (plan.status === "SNAPSHOT_CORRUPT" && !isTerminalMutationStatus(plan.latestIntent.lifecycleStatus)) {
          try {
            this.store.transitionMutationStatus({
              mutationId: plan.latestIntent.mutationId,
              fromStatus: plan.latestIntent.lifecycleStatus,
              toStatus: "ROLLBACK_CONFLICT_HASH_MISMATCH",
              event: {
                eventId: randomUUID(),
                runId,
                timestamp: new Date().toISOString(),
                eventType: "file.rollback_conflict",
                schemaVersion: 1,
                producer: "DURABLE_ROLLBACK_ENGINE",
                payload: {
                  mutationId: plan.latestIntent.mutationId,
                  relativePath: plan.relativePath,
                  expectedDigest: plan.initialBaseDigest,
                  actualDigest: preflightFailures.find((f) => f.relativePath === plan.relativePath)?.actual ?? "CORRUPT",
                  conflictType: "HASH_MISMATCH",
                  targetPreserved: true,
                },
              },
              nextDedupToken: computeRecoveryDedupToken(runId, plan.latestIntent.mutationId, "ROLLBACK_CONFLICT_HASH_MISMATCH"),
              authorityContext,
              conflictDetails: conflictJson,
            });
          } catch {
            // Safe transition ignore
          }
        }
      }

      return {
        runId,
        status: "PARTIALLY_ROLLED_BACK_CONFLICT",
        totalPaths: plans.length,
        restoredPaths: [],
        conflictedPaths: preflightFailures.map((f) => f.relativePath),
        skippedPaths: plans.map((p) => p.relativePath).filter((p) => !preflightFailures.some((f) => f.relativePath === p)),
        conflictDetails: conflictJson,
      };
    }

    // 5. LAYER 2: SEQUENTIAL DIRECT-TO-BASELINE RESTORATION (ADR-0036 Section 3.3 & 3.4)
    this.store.updateRunRollbackStatus(runId, "RESTORING_PATHS");

    const restoredPaths: string[] = [];
    const conflictedPaths: string[] = [];
    const skippedPaths: string[] = [];

    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i]!;

      // If already at baseline, mark restored and commit intent transition
      if (plan.status === "ALREADY_RESTORED") {
        this.store.updatePathRollbackProgress(runId, plan.relativePath, "IN_PROGRESS");
        this.commitPathMutationRollback(plan, authorityContext);
        this.store.updatePathRollbackProgress(runId, plan.relativePath, "RESTORED", null, Date.now());
        restoredPaths.push(plan.relativePath);
        continue;
      }

      // Mark path IN_PROGRESS
      this.store.updatePathRollbackProgress(runId, plan.relativePath, "IN_PROGRESS");

      // Immediate pre-replacement verification on disk
      if (plan.isBaselineAbsent) {
        if (fs.existsSync(plan.canonicalPath)) {
          const liveBytes = fs.readFileSync(plan.canonicalPath);
          const liveDigest = sha256(liveBytes);
          if (!plan.chainDigests.includes(liveDigest)) {
            // Conflict immediately before replacement! HALT POLICY: halt immediately, preserve file
            this.handlePerPathConflict(
              plan,
              plans.slice(i + 1),
              authorityContext,
              liveDigest,
              restoredPaths,
              conflictedPaths,
              skippedPaths
            );
            return {
              runId,
              status: "PARTIALLY_ROLLED_BACK_CONFLICT",
              totalPaths: plans.length,
              restoredPaths,
              conflictedPaths,
              skippedPaths,
              conflictDetails: this.store.getRunRollback(runId)?.conflictDetails,
            };
          }

          // Safe unlink of newly created file
          this.fence(options);
          try {
            fs.unlinkSync(plan.canonicalPath);
          } catch (unlinkErr: unknown) {
            this.store.updatePathRollbackProgress(runId, plan.relativePath, "RESTORE_FAILED", (unlinkErr as Error).message);
            this.store.updateRunRollbackStatus(runId, "PARTIALLY_ROLLED_BACK_CONFLICT", null, (unlinkErr as Error).message);
            conflictedPaths.push(plan.relativePath);
            return {
              runId,
              status: "PARTIALLY_ROLLED_BACK_CONFLICT",
              totalPaths: plans.length,
              restoredPaths,
              conflictedPaths,
              skippedPaths: plans.slice(i + 1).map((p) => p.relativePath),
              conflictDetails: (unlinkErr as Error).message,
            };
          }
        }
      } else {
        // Non-absent baseline: verify disk right before atomic replacement
        if (!fs.existsSync(plan.canonicalPath)) {
          this.handlePerPathConflict(
            plan,
            plans.slice(i + 1),
            authorityContext,
            "ABSENT",
            restoredPaths,
            conflictedPaths,
            skippedPaths
          );
          return {
            runId,
            status: "PARTIALLY_ROLLED_BACK_CONFLICT",
            totalPaths: plans.length,
            restoredPaths,
            conflictedPaths,
            skippedPaths,
            conflictDetails: this.store.getRunRollback(runId)?.conflictDetails,
          };
        }

        const liveBytes = fs.readFileSync(plan.canonicalPath);
        const liveDigest = sha256(liveBytes);
        if (liveDigest !== plan.initialBaseDigest && !plan.chainDigests.includes(liveDigest)) {
          // Conflict immediately before replacement! HALT POLICY: halt immediately, preserve file
          this.handlePerPathConflict(
            plan,
            plans.slice(i + 1),
            authorityContext,
            liveDigest,
            restoredPaths,
            conflictedPaths,
            skippedPaths
          );
          return {
            runId,
            status: "PARTIALLY_ROLLED_BACK_CONFLICT",
            totalPaths: plans.length,
            restoredPaths,
            conflictedPaths,
            skippedPaths,
            conflictDetails: this.store.getRunRollback(runId)?.conflictDetails,
          };
        }

        // If not already at initial baseline, perform atomic rename from snapshot
        if (liveDigest !== plan.initialBaseDigest) {
          const targetDir = path.dirname(plan.canonicalPath);
          const nonce = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
          const tempFile = path.resolve(targetDir, `.emerald.tmp.restore.${nonce}`);

          this.fence(options);
          try {
            const snapBytes = fs.readFileSync(this.resolveSnapshotPath(plan.baselineSnapshotRef, workspaceRoot, runId));
            if (sha256(snapBytes) !== plan.initialBaseDigest) {
              throw new RollbackSnapshotCorruptError(plan.relativePath, plan.initialBaseDigest, sha256(snapBytes));
            }
            fs.writeFileSync(tempFile, snapBytes);

            const tempDigest = sha256(fs.readFileSync(tempFile));
            if (tempDigest !== plan.initialBaseDigest) {
              this.discardOwnTempFile(tempFile, options);
              throw new RollbackSnapshotCorruptError(plan.relativePath, plan.initialBaseDigest, tempDigest);
            }

            // Re-validate target and authority immediately before the atomic replacement
            this.assertTargetStillExpected(plan.canonicalPath, [plan.initialBaseDigest, ...plan.chainDigests]);
            this.fence(options);
            // Atomic rename with retry for Windows NTFS lock backoff
            await atomicRenameWithRetry(tempFile, plan.canonicalPath);
          } catch (restoreErr: unknown) {
            if (isFencingError(restoreErr)) throw restoreErr; // no authority: leave temp untouched
            this.discardOwnTempFile(tempFile, options);
            this.store.updatePathRollbackProgress(runId, plan.relativePath, "RESTORE_FAILED", (restoreErr as Error).message);
            this.store.updateRunRollbackStatus(runId, "PARTIALLY_ROLLED_BACK_CONFLICT", null, (restoreErr as Error).message);
            conflictedPaths.push(plan.relativePath);
            return {
              runId,
              status: "PARTIALLY_ROLLED_BACK_CONFLICT",
              totalPaths: plans.length,
              restoredPaths,
              conflictedPaths,
              skippedPaths: plans.slice(i + 1).map((p) => p.relativePath),
              conflictDetails: (restoreErr as Error).message,
            };
          }

          // Immediate post-replacement verification
          const postBytes = fs.readFileSync(plan.canonicalPath);
          const postDigest = sha256(postBytes);
          if (postDigest !== plan.initialBaseDigest) {
            throw new DigestMismatchError(
              `Post-restore digest mismatch for ${plan.relativePath}: expected ${plan.initialBaseDigest}, got ${postDigest}`
            );
          }
        }
      }

      // Commit DB status and events
      this.commitPathMutationRollback(plan, authorityContext);
      this.store.updatePathRollbackProgress(runId, plan.relativePath, "RESTORED", null, Date.now());
      restoredPaths.push(plan.relativePath);
    }

    // 6. Aggregate final completion
    this.store.updateRunRollbackStatus(runId, "COMPLETED", Date.now(), null);
    return {
      runId,
      status: "COMPLETED",
      totalPaths: plans.length,
      restoredPaths,
      conflictedPaths: [],
      skippedPaths: [],
      conflictDetails: null,
    };
  }

  /**
   * Resumes an interrupted run-level rollback.
   */
  public async resumeRollback(options: RollbackOptions): Promise<RollbackExecutionResult> {
    const { runId, workspaceRoot, authorityContext } = options;

    this.validateSupervisorAuthority(runId, authorityContext);
    this.fence(options);

    const existingRollback = this.currentGenerationRollback(runId);
    if (!existingRollback || existingRollback.status === "IDLE") {
      // Nothing durable has been restored yet: (re)start with full preflight validation
      return this.executeRollback(options);
    }

    if (existingRollback.status === "COMPLETED") {
      const progressList = this.store.listPathRollbackProgress(runId);
      return {
        runId,
        status: "COMPLETED",
        totalPaths: progressList.length,
        restoredPaths: progressList.filter((p) => p.status === "RESTORED").map((p) => p.relativePath),
        conflictedPaths: [],
        skippedPaths: [],
        conflictDetails: null,
      };
    }

    if (existingRollback.status === "PARTIALLY_ROLLED_BACK_CONFLICT") {
      const progressList = this.store.listPathRollbackProgress(runId);
      return {
        runId,
        status: "PARTIALLY_ROLLED_BACK_CONFLICT",
        totalPaths: progressList.length,
        restoredPaths: progressList.filter((p) => p.status === "RESTORED").map((p) => p.relativePath),
        conflictedPaths: progressList.filter((p) => p.status === "CONFLICT_SKIPPED" || p.status === "RESTORE_FAILED").map((p) => p.relativePath),
        skippedPaths: progressList.filter((p) => p.status === "PENDING").map((p) => p.relativePath),
        conflictDetails: existingRollback.conflictDetails,
      };
    }

    const progressList = this.store.listPathRollbackProgress(runId);
    const restoredPaths: string[] = [];
    const conflictedPaths: string[] = [];
    const skippedPaths: string[] = [];

    this.store.updateRunRollbackStatus(runId, "RESTORING_PATHS");

    for (let i = 0; i < progressList.length; i++) {
      const item = progressList[i]!;
      const canonicalPath = this.resolveSafePath(item.relativePath, workspaceRoot);
      const isBaselineAbsent = item.initialBaseDigest === "ABSENT";
      const pathIntents = [...this.store.getIntentsForPath(runId, item.relativePath)].sort(
        (a, b) => a.pathMutationVersion - b.pathMutationVersion
      );
      const generation = selectGenerationIntents(pathIntents);
      const allIntents = generation.length > 0 ? generation : pathIntents;
      this.assertWorkspaceOwnsIntents(runId, item.relativePath, canonicalPath, allIntents);
      const rootIntent = allIntents[0];
      const latestIntent = allIntents[allIntents.length - 1];

      const plan: PreflightPathPlan = {
        relativePath: item.relativePath,
        canonicalPath,
        rootIntent,
        latestIntent,
        allIntents,
        isBaselineAbsent,
        initialBaseDigest: item.initialBaseDigest,
        latestExpectedDigest: item.latestExpectedDigest,
        chainDigests: chainDigestsOf(allIntents, item.latestExpectedDigest),
        baselineSnapshotRef: item.baselineSnapshotRef,
        status: "READY",
      };

      if (item.status === "RESTORED") {
        restoredPaths.push(item.relativePath);
        continue;
      }

      if (item.status === "CONFLICT_SKIPPED" || item.status === "RESTORE_FAILED") {
        conflictedPaths.push(item.relativePath);
        continue;
      }

      // Check current disk state
      const fileExists = fs.existsSync(canonicalPath);
      let diskDigest = "ABSENT";
      if (fileExists) {
        diskDigest = sha256(fs.readFileSync(canonicalPath));
      }

      if (item.status === "IN_PROGRESS") {
        // CP6a crash boundary: file on disk was already restored before crash, but DB commit did not occur!
        if (diskDigest === item.initialBaseDigest) {
          this.commitPathMutationRollback(plan, authorityContext);
          this.store.updatePathRollbackProgress(runId, item.relativePath, "RESTORED", null, Date.now());
          restoredPaths.push(item.relativePath);
          continue;
        }

        // CP6 crash boundary: process crashed before rename completed.
        // Clean any orphaned temp restore files in directory
        this.cleanOrphanedRestoreTempFiles(path.dirname(canonicalPath), [item.initialBaseDigest], options);
      }

      // Check for conflict on resume
      if (diskDigest !== item.initialBaseDigest && !plan.chainDigests.includes(diskDigest)) {
        this.store.updatePathRollbackProgress(
          runId,
          item.relativePath,
          "CONFLICT_SKIPPED",
          `Conflict detected on resume: expected ${item.latestExpectedDigest}, got ${diskDigest}`
        );
        this.store.updateRunRollbackStatus(
          runId,
          "PARTIALLY_ROLLED_BACK_CONFLICT",
          null,
          `Conflict on resume for ${item.relativePath}`
        );
        conflictedPaths.push(item.relativePath);
        // Halt subsequent paths
        for (let j = i + 1; j < progressList.length; j++) {
          skippedPaths.push(progressList[j].relativePath);
        }
        return {
          runId,
          status: "PARTIALLY_ROLLED_BACK_CONFLICT",
          totalPaths: progressList.length,
          restoredPaths,
          conflictedPaths,
          skippedPaths,
          conflictDetails: `Conflict on resume for ${item.relativePath}`,
        };
      }

      // Perform restoration
      if (isBaselineAbsent) {
        if (fs.existsSync(canonicalPath)) {
          this.fence(options);
          fs.unlinkSync(canonicalPath);
        }
      } else {
        if (diskDigest !== item.initialBaseDigest) {
          const targetDir = path.dirname(canonicalPath);
          const nonce = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
          const tempFile = path.resolve(targetDir, `.emerald.tmp.restore.${nonce}`);

          this.fence(options);
          try {
            const snapBytes = fs.readFileSync(this.resolveSnapshotPath(item.baselineSnapshotRef, workspaceRoot, runId));
            const snapDigest = sha256(snapBytes);
            if (snapDigest !== item.initialBaseDigest) {
              throw new RollbackSnapshotCorruptError(item.relativePath, item.initialBaseDigest, snapDigest);
            }
            fs.writeFileSync(tempFile, snapBytes);
            const tempDigest = sha256(fs.readFileSync(tempFile));
            if (tempDigest !== item.initialBaseDigest) {
              throw new RollbackSnapshotCorruptError(item.relativePath, item.initialBaseDigest, tempDigest);
            }
            this.assertTargetStillExpected(canonicalPath, [item.initialBaseDigest, ...plan.chainDigests]);
            this.fence(options);
            await atomicRenameWithRetry(tempFile, canonicalPath);
          } catch (restoreErr: unknown) {
            if (isFencingError(restoreErr)) throw restoreErr; // no authority: leave temp untouched
            this.discardOwnTempFile(tempFile, options);
            const message = (restoreErr as Error).message;
            this.store.updatePathRollbackProgress(runId, item.relativePath, "RESTORE_FAILED", message);
            this.store.updateRunRollbackStatus(runId, "PARTIALLY_ROLLED_BACK_CONFLICT", null, message);
            conflictedPaths.push(item.relativePath);
            for (let j = i + 1; j < progressList.length; j++) {
              skippedPaths.push(progressList[j]!.relativePath);
            }
            return {
              runId,
              status: "PARTIALLY_ROLLED_BACK_CONFLICT",
              totalPaths: progressList.length,
              restoredPaths,
              conflictedPaths,
              skippedPaths,
              conflictDetails: message,
            };
          }
        }
      }

      this.commitPathMutationRollback(plan, authorityContext);
      this.store.updatePathRollbackProgress(runId, item.relativePath, "RESTORED", null, Date.now());
      restoredPaths.push(item.relativePath);
    }

    this.store.updateRunRollbackStatus(runId, "COMPLETED", Date.now(), null);
    return {
      runId,
      status: "COMPLETED",
      totalPaths: progressList.length,
      restoredPaths,
      conflictedPaths: [],
      skippedPaths: [],
      conflictDetails: null,
    };
  }

  /**
   * Helper to handle per-path conflict: halts sequential loop, preserves conflicting file,
   * transitions run rollback to PARTIALLY_ROLLED_BACK_CONFLICT, and emits rollback conflict event.
   */
  private handlePerPathConflict(
    plan: PreflightPathPlan,
    remainingPlans: PreflightPathPlan[],
    authorityContext: MutationAuthorityContext,
    actualDigest: string,
    restoredPaths: string[],
    conflictedPaths: string[],
    skippedPaths: string[]
  ): void {
    const conflictMsg = `Pre-rename conflict detected for ${plan.relativePath}: expected ${plan.latestExpectedDigest}, got ${actualDigest}`;
    this.store.updatePathRollbackProgress(plan.latestIntent.runId, plan.relativePath, "CONFLICT_SKIPPED", conflictMsg);
    this.store.updateRunRollbackStatus(plan.latestIntent.runId, "PARTIALLY_ROLLED_BACK_CONFLICT", null, conflictMsg);

    conflictedPaths.push(plan.relativePath);
    for (const rem of remainingPlans) {
      skippedPaths.push(rem.relativePath);
    }

    if (!isTerminalMutationStatus(plan.latestIntent.lifecycleStatus)) {
      try {
        this.store.transitionMutationStatus({
          mutationId: plan.latestIntent.mutationId,
          fromStatus: plan.latestIntent.lifecycleStatus,
          toStatus: "ROLLBACK_CONFLICT_LOST_UPDATE",
          event: {
            eventId: randomUUID(),
            runId: plan.latestIntent.runId,
            timestamp: new Date().toISOString(),
            eventType: "file.rollback_conflict",
            schemaVersion: 1,
            producer: "DURABLE_ROLLBACK_ENGINE",
            payload: {
              mutationId: plan.latestIntent.mutationId,
              relativePath: plan.relativePath,
              expectedDigest: plan.latestExpectedDigest,
              actualDigest,
              conflictType: "LOST_UPDATE",
              targetPreserved: true,
            },
          },
          nextDedupToken: computeRecoveryDedupToken(
            plan.latestIntent.runId,
            plan.latestIntent.mutationId,
            "ROLLBACK_CONFLICT_LOST_UPDATE"
          ),
          authorityContext,
          conflictDetails: conflictMsg,
        });
      } catch {
        // Safe transition ignore
      }
    }
  }

  /**
   * Transitions all non-terminal mutation intents for a path to ROLLED_BACK.
   */
  private commitPathMutationRollback(
    plan: PreflightPathPlan,
    authorityContext: MutationAuthorityContext
  ): void {
    for (const intent of plan.allIntents) {
      if (!isRollbackPendingStatus(intent.lifecycleStatus)) {
        continue;
      }

      // Intents that never reached APPLYING_MUTATION never touched the file; the state
      // machine only permits ABORTED_UNMUTATED for them (ROLLED_BACK is illegal).
      const unmutated = intent.lifecycleStatus === "RECORDED" || intent.lifecycleStatus === "SNAPSHOT_WRITTEN";
      const toStatus = unmutated ? "ABORTED_UNMUTATED" : "ROLLED_BACK";

      this.store.transitionMutationStatus({
        mutationId: intent.mutationId,
        fromStatus: intent.lifecycleStatus,
        toStatus,
        event: {
          eventId: randomUUID(),
          runId: intent.runId,
          timestamp: new Date().toISOString(),
          eventType: unmutated ? "file.mutation_aborted_unmutated" : "file.mutation_rolled_back",
          schemaVersion: 1,
          producer: "DURABLE_ROLLBACK_ENGINE",
          payload: {
            mutationId: intent.mutationId,
            relativePath: plan.relativePath,
            restoredDigest: plan.initialBaseDigest,
            reason: "RUN_ROLLBACK",
          },
        },
        nextDedupToken: computeRecoveryDedupToken(intent.runId, intent.mutationId, toStatus),
        authorityContext,
      });
    }
  }
}
