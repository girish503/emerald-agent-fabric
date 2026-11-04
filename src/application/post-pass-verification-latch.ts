/**
 * Post-Pass Verification Latch and Protection Gate for Emerald Agent Fabric.
 *
 * Implements a deterministic, controller-owned latch that activates when
 * intermediate test verification confirms that a defect repair passes
 * both fail-to-pass and pass-to-pass suites (classification === "PASS").
 *
 * Responsibilities:
 * 1. Deterministic Activation: Latches when intermediate verification passes.
 * 2. Target File Protection: Locks verified target file(s) against subsequent
 *    destructive mutations (edit_file, write_file) to prevent post-repair drift.
 * 3. Scoped Enforcement: Protects verified targets while allowing read-only
 *    inspection, permitted test execution, and legitimate multi-file work.
 * 4. Authoritative Completion Integration: Tracks independent clean-room verification
 *    proofs without treating untrusted model claims as authoritative.
 * 5. Permanent Scoped Lifetime: Persists for the duration of the run; proposal
 *    rejections or subsequent actions NEVER clear the latch.
 */

import { CleanRoomVerificationOutcome } from "./clean-room-verifier.js";
import type { DomainEvent } from "../domain/events.js";
import type { PersistedEvent } from "../ports/state-store.port.js";

export function normalizeLatchPath(filePath: string): string {
  if (typeof filePath !== "string") return "";
  return filePath
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .trim();
}

export const MUTATING_TOOL_NAMES = Object.freeze(["write_file", "edit_file"] as const);

export interface PostPassLatchActivationParams {
  readonly stepNumber: number;
  readonly timestamp: string;
  readonly protectedPath: string;
  readonly f2pExitCode: number;
  readonly p2pExitCode: number;
  readonly targetHash?: string;
  readonly cleanRoomSpecId?: string;
  readonly taskId?: string;
}

export interface PostPassLatchSnapshot {
  readonly schemaVersion?: number;
  readonly isLatched: boolean;
  readonly activationEvent?: Readonly<PostPassLatchActivationParams>;
  readonly protectedPaths: readonly string[];
  readonly cleanRoomVerified: boolean;
  readonly cleanRoomStatus?: "VERIFIED" | "FAILED";
  readonly cleanRoomMessage?: string;
}

export interface ReconstructFromEventsOptions {
  readonly runId?: string;
}

export class AmbiguousRunReconstructionError extends Error {
  constructor(message: string) {
    super(`Ambiguous run reconstruction: ${message}`);
    this.name = "AmbiguousRunReconstructionError";
  }
}

export class InvalidLatchSnapshotError extends Error {
  constructor(message: string) {
    super(`Invalid PostPassLatchSnapshot: ${message}`);
    this.name = "InvalidLatchSnapshotError";
  }
}

export interface ReconstructibleEvent {
  readonly eventId?: string;
  readonly runId?: string;
  readonly sequence?: number;
  readonly timestamp?: string;
  readonly eventType: string;
  readonly schemaVersion?: number;
  readonly producer?: string;
  readonly payload?: unknown;
}

export class PostPassVerificationLatch {
  private _isLatched = false;
  private _activationEvent?: PostPassLatchActivationParams;
  private readonly _protectedPaths = new Set<string>();
  private _cleanRoomVerified = false;
  private _cleanRoomStatus?: "VERIFIED" | "FAILED";
  private _cleanRoomMessage?: string;

  /**
   * Returns true if the latch has been activated by a passing intermediate verification.
   */
  get isLatched(): boolean {
    return this._isLatched;
  }

  /**
   * Returns whether authoritative clean-room verification has completed and passed.
   */
  get cleanRoomVerified(): boolean {
    return this._cleanRoomVerified;
  }

  /**
   * Returns the clean-room verification status if executed.
   */
  get cleanRoomStatus(): "VERIFIED" | "FAILED" | undefined {
    return this._cleanRoomStatus;
  }

  /**
   * Returns all currently protected normalized target paths.
   */
  get protectedPaths(): readonly string[] {
    return Array.from(this._protectedPaths);
  }

  /**
   * Returns the activation event if the latch is active.
   */
  get activationEvent(): Readonly<PostPassLatchActivationParams> | undefined {
    return this._activationEvent;
  }

  /**
   * Activates the latch upon confirmed intermediate verification pass.
   * Idempotent: Can be called if multiple targets pass in multi-file workflows.
   */
  activate(params: PostPassLatchActivationParams): void {
    const normalized = normalizeLatchPath(params.protectedPath);
    if (!normalized) return;

    this._isLatched = true;
    this._protectedPaths.add(normalized);

    if (!this._activationEvent) {
      this._activationEvent = Object.freeze({
        ...params,
        protectedPath: normalized,
      });
    }
  }

  /**
   * Checks whether a specific file path is locked against mutations by this latch.
   */
  isTargetProtected(filePath?: string): boolean {
    if (!this._isLatched || !filePath) return false;
    const normalized = normalizeLatchPath(filePath);
    return this._protectedPaths.has(normalized);
  }

  /**
   * Evaluates whether a proposed tool operation is prohibited by the latch.
   *
   * Invariants:
   * 1. Mutating tools (edit_file, write_file) targeting protected paths are strictly prohibited.
   * 2. Non-mutating tools (read_file, search_code, git_status, git_diff, run_command) are always permitted.
   * 3. Mutating tools targeting unlatched paths (e.g. multi-file tasks where another file still requires work) are permitted.
   */
  isMutationProhibited(
    toolName: string,
    targetPath?: string
  ): { readonly prohibited: boolean; readonly reason?: string } {
    if (!this._isLatched) {
      return { prohibited: false };
    }

    const isMutatingTool = (MUTATING_TOOL_NAMES as readonly string[]).includes(toolName);
    if (!isMutatingTool) {
      // Read-only, inspection, search, and run_command verification are never prohibited by the latch
      return { prohibited: false };
    }

    if (!targetPath) {
      // Mutating tool without a target path fails validation elsewhere; latch does not prohibit
      return { prohibited: false };
    }

    const normalized = normalizeLatchPath(targetPath);
    if (this._protectedPaths.has(normalized)) {
      return {
        prohibited: true,
        reason:
          `Proposal for tool '${toolName}' rejected: Target file '${normalized}' has already passed verification tests and is protected by the post-pass verification latch. ` +
          "Further mutations to this verified file are disallowed to prevent regression. Propose verification tests or conclude the task with isGoalReached: true.",
      };
    }

    return { prohibited: false };
  }

  /**
   * Authoritatively records the outcome of clean-room verification.
   */
  recordCleanRoomResult(outcome: CleanRoomVerificationOutcome): void {
    this._cleanRoomStatus = outcome.status;
    this._cleanRoomVerified = outcome.status === "VERIFIED";
    this._cleanRoomMessage = outcome.message;
  }

  /**
   * Clears latch state. Only called by the controller at the start of a fresh run.
   * Never called during rejection handling or turn processing.
   */
  clear(): void {
    this._isLatched = false;
    this._activationEvent = undefined;
    this._protectedPaths.clear();
    this._cleanRoomVerified = false;
    this._cleanRoomStatus = undefined;
    this._cleanRoomMessage = undefined;
  }

  /**
   * Produces an immutable structured snapshot of the latch state.
   */
  getSnapshot(): PostPassLatchSnapshot {
    return Object.freeze({
      schemaVersion: 1,
      isLatched: this._isLatched,
      ...(this._activationEvent ? { activationEvent: this._activationEvent } : {}),
      protectedPaths: Object.freeze(Array.from(this._protectedPaths).sort()),
      cleanRoomVerified: this._cleanRoomVerified,
      ...(this._cleanRoomStatus ? { cleanRoomStatus: this._cleanRoomStatus } : {}),
      ...(this._cleanRoomMessage ? { cleanRoomMessage: this._cleanRoomMessage } : {}),
    });
  }

  /**
   * Reconstitutes latch state from a previous snapshot.
   *
   * Validates snapshot integrity fail-closed: throws InvalidLatchSnapshotError
   * if the snapshot contains malformed, contradictory, or unreachable live safety state.
   */
  restoreFromSnapshot(snapshot: PostPassLatchSnapshot): void {
    this.clear();
    if (!snapshot || typeof snapshot !== "object") {
      throw new InvalidLatchSnapshotError("Snapshot must be a non-null object");
    }

    if (snapshot.schemaVersion !== undefined && snapshot.schemaVersion !== 1) {
      throw new InvalidLatchSnapshotError(
        `Unsupported snapshot schemaVersion '${snapshot.schemaVersion}' (expected 1)`
      );
    }

    if (typeof snapshot.isLatched !== "boolean") {
      throw new InvalidLatchSnapshotError("isLatched must be an explicit boolean");
    }
    if (typeof snapshot.cleanRoomVerified !== "boolean") {
      throw new InvalidLatchSnapshotError("cleanRoomVerified must be an explicit boolean");
    }
    if (!Array.isArray(snapshot.protectedPaths)) {
      throw new InvalidLatchSnapshotError("protectedPaths must be an array");
    }

    // Clean-room status / verified boolean / message mutual consistency
    if (snapshot.cleanRoomVerified && snapshot.cleanRoomStatus !== "VERIFIED") {
      throw new InvalidLatchSnapshotError(
        `cleanRoomVerified is true but cleanRoomStatus is '${String(snapshot.cleanRoomStatus)}' (expected 'VERIFIED')`
      );
    }
    if (snapshot.cleanRoomStatus === "FAILED" && snapshot.cleanRoomVerified) {
      throw new InvalidLatchSnapshotError(
        "Contradictory clean-room state: cleanRoomStatus is 'FAILED' but cleanRoomVerified is true"
      );
    }
    if (
      snapshot.cleanRoomStatus !== undefined &&
      snapshot.cleanRoomStatus !== "VERIFIED" &&
      snapshot.cleanRoomStatus !== "FAILED"
    ) {
      throw new InvalidLatchSnapshotError(
        `Invalid cleanRoomStatus '${String(snapshot.cleanRoomStatus)}' (must be 'VERIFIED' or 'FAILED')`
      );
    }
    if (snapshot.cleanRoomStatus === undefined) {
      if (snapshot.cleanRoomVerified) {
        throw new InvalidLatchSnapshotError("cleanRoomStatus cannot be undefined when cleanRoomVerified is true");
      }
      if (snapshot.cleanRoomMessage !== undefined) {
        throw new InvalidLatchSnapshotError("cleanRoomMessage cannot be defined when cleanRoomStatus is undefined");
      }
    }
    if (snapshot.cleanRoomMessage !== undefined && typeof snapshot.cleanRoomMessage !== "string") {
      throw new InvalidLatchSnapshotError("cleanRoomMessage must be a string if defined");
    }

    // Consistency between isLatched, protectedPaths, and activationEvent
    if (snapshot.isLatched) {
      const normalizedPaths: string[] = [];
      for (const p of snapshot.protectedPaths) {
        if (typeof p !== "string") {
          throw new InvalidLatchSnapshotError("protectedPaths entries must all be strings");
        }
        const norm = normalizeLatchPath(p);
        if (!norm) {
          throw new InvalidLatchSnapshotError("protectedPaths contains empty or whitespace file path");
        }
        normalizedPaths.push(norm);
      }
      if (normalizedPaths.length === 0) {
        throw new InvalidLatchSnapshotError(
          "isLatched is true but protectedPaths contains no valid normalized file paths"
        );
      }

      // In live execution, an active latch ALWAYS possesses an activation event
      if (!snapshot.activationEvent || typeof snapshot.activationEvent !== "object") {
        throw new InvalidLatchSnapshotError(
          "isLatched is true but activationEvent is missing (unreachable live latch state)"
        );
      }

      const act = snapshot.activationEvent;
      if (typeof act.protectedPath !== "string") {
        throw new InvalidLatchSnapshotError("activationEvent.protectedPath must be a string");
      }
      const actNormPath = normalizeLatchPath(act.protectedPath);
      if (!actNormPath) {
        throw new InvalidLatchSnapshotError("activationEvent.protectedPath must be a non-empty string");
      }
      if (typeof act.stepNumber !== "number" || !Number.isInteger(act.stepNumber) || act.stepNumber < 0) {
        throw new InvalidLatchSnapshotError("activationEvent.stepNumber must be a non-negative integer");
      }
      if (typeof act.timestamp !== "string" || !act.timestamp.trim()) {
        throw new InvalidLatchSnapshotError("activationEvent.timestamp must be a non-empty string");
      }
      if (act.f2pExitCode !== 0 || act.p2pExitCode !== 0) {
        throw new InvalidLatchSnapshotError(
          `activationEvent exit codes must be 0 for passing verification (got f2p=${act.f2pExitCode}, p2p=${act.p2pExitCode})`
        );
      }
      if (act.targetHash !== undefined && (typeof act.targetHash !== "string" || !act.targetHash.trim())) {
        throw new InvalidLatchSnapshotError("activationEvent.targetHash must be a non-empty string if provided");
      }
      if (act.cleanRoomSpecId !== undefined && (typeof act.cleanRoomSpecId !== "string" || !act.cleanRoomSpecId.trim())) {
        throw new InvalidLatchSnapshotError("activationEvent.cleanRoomSpecId must be a non-empty string if provided");
      }
      if (act.taskId !== undefined && (typeof act.taskId !== "string" || !act.taskId.trim())) {
        throw new InvalidLatchSnapshotError("activationEvent.taskId must be a non-empty string if provided");
      }

      // The activation path MUST be present among the protected paths
      if (!normalizedPaths.includes(actNormPath)) {
        throw new InvalidLatchSnapshotError(
          `activationEvent.protectedPath '${actNormPath}' is not present in protectedPaths (inconsistent latch state)`
        );
      }

      for (const norm of normalizedPaths) {
        this._protectedPaths.add(norm);
      }
      this._isLatched = true;
      this._activationEvent = Object.freeze({
        stepNumber: act.stepNumber,
        timestamp: act.timestamp,
        protectedPath: actNormPath,
        f2pExitCode: 0,
        p2pExitCode: 0,
        ...(act.targetHash ? { targetHash: act.targetHash } : {}),
        ...(act.cleanRoomSpecId ? { cleanRoomSpecId: act.cleanRoomSpecId } : {}),
        ...(act.taskId ? { taskId: act.taskId } : {}),
      });
    } else {
      // isLatched is false
      if (snapshot.protectedPaths.length > 0) {
        throw new InvalidLatchSnapshotError(
          "isLatched is false but protectedPaths is non-empty (unlatched latch cannot hold active file locks)"
        );
      }
      if (snapshot.activationEvent !== undefined) {
        throw new InvalidLatchSnapshotError(
          "isLatched is false but activationEvent is present (unlatched latch cannot possess an activation event)"
        );
      }
    }

    this._cleanRoomVerified = snapshot.cleanRoomVerified;
    this._cleanRoomStatus = snapshot.cleanRoomStatus;
    this._cleanRoomMessage = typeof snapshot.cleanRoomMessage === "string" ? snapshot.cleanRoomMessage : undefined;
  }

  /**
   * Reconstructs the latch state by deterministically replaying durable events.
   *
   * Invariants:
   * 1. Unambiguous Run Scoping: Explicit runId strongly preferred. Mismatched or mixed-run events fail closed
   *    by clearing state and throwing AmbiguousRunReconstructionError.
   * 2. Authoritative Ordering: Events sorted by durable sequence number ascending. Timestamp fallback used
   *    only when sequence numbers are absent. Event IDs provide deterministic tie-breaking without manufacturing
   *    lifecycle authority.
   * 3. Ambiguous Conflict Safety: Conflicting verification evidence at ambiguous sequence/timestamp points
   *    fails closed to FAILED/unverified. Unsequenced pass events cannot override sequenced failures.
   * 4. Conservative & Fail-Closed: Malformed evidence or non-zero exit codes cannot latch paths.
   */
  reconstructFromEvents(
    events: readonly (DomainEvent<unknown> | PersistedEvent<unknown> | ReconstructibleEvent)[],
    options?: ReconstructFromEventsOptions
  ): void {
    this.clear();

    if (!Array.isArray(events) || events.length === 0) {
      return;
    }

    // Determine targetRunId and enforce run identity unambiguously
    let targetRunId = options?.runId?.trim();

    if (targetRunId) {
      // Explicit runId: validate that every event belongs to this runId; fail closed on mismatch
      for (const evt of events) {
        if (!evt || typeof evt !== "object") continue;
        if (typeof evt.runId === "string" && evt.runId && evt.runId !== targetRunId) {
          this.clear();
          throw new AmbiguousRunReconstructionError(
            `Event '${evt.eventId ?? "unknown"}' runId '${evt.runId}' does not match expected runId '${targetRunId}'`
          );
        }
        const payloadRunId = (evt.payload as any)?.runId;
        if (typeof payloadRunId === "string" && payloadRunId && payloadRunId !== targetRunId) {
          this.clear();
          throw new AmbiguousRunReconstructionError(
            `Event '${evt.eventId ?? "unknown"}' payload runId '${payloadRunId}' does not match expected runId '${targetRunId}'`
          );
        }
      }
    } else {
      // Inference mode: collect all distinct non-empty runIds across all events
      const distinctRunIds = new Set<string>();
      for (const evt of events) {
        if (!evt || typeof evt !== "object") continue;
        if (typeof evt.runId === "string" && evt.runId.trim()) {
          distinctRunIds.add(evt.runId.trim());
        }
        const payloadRunId = (evt.payload as any)?.runId;
        if (typeof payloadRunId === "string" && payloadRunId.trim()) {
          distinctRunIds.add(payloadRunId.trim());
        }
      }

      if (distinctRunIds.size > 1) {
        this.clear();
        throw new AmbiguousRunReconstructionError(
          `Mixed-run input detected across ${distinctRunIds.size} distinct runs (${Array.from(distinctRunIds).join(", ")}). Explicit runId required.`
        );
      }

      if (distinctRunIds.size === 1) {
        targetRunId = Array.from(distinctRunIds)[0];
      }
    }

    // Sort by sequence (if both have numbers) or timestamp ascending, tie-broken by eventId for stability
    const sorted = [...events].sort((a, b) => {
      const seqA = typeof (a as any).sequence === "number" ? (a as any).sequence : undefined;
      const seqB = typeof (b as any).sequence === "number" ? (b as any).sequence : undefined;
      if (seqA !== undefined && seqB !== undefined) {
        if (seqA !== seqB) return seqA - seqB;
      } else if (seqA !== undefined && seqB === undefined) {
        return -1;
      } else if (seqA === undefined && seqB !== undefined) {
        return 1;
      }
      const tsA = typeof a.timestamp === "string" ? a.timestamp : "";
      const tsB = typeof b.timestamp === "string" ? b.timestamp : "";
      if (tsA !== tsB) {
        return tsA.localeCompare(tsB);
      }
      const idA = typeof a.eventId === "string" ? a.eventId : "";
      const idB = typeof b.eventId === "string" ? b.eventId : "";
      return idA.localeCompare(idB);
    });

    // Track clean-room verification outcome with lifecycle authority
    interface CleanRoomCandidate {
      status: "VERIFIED" | "FAILED";
      message?: string;
      sequence?: number;
      timestamp: string;
    }

    let activeCleanRoom: CleanRoomCandidate | null = null;

    const mergeCleanRoomCandidate = (
      prev: CleanRoomCandidate | null,
      curr: CleanRoomCandidate
    ): CleanRoomCandidate => {
      if (!prev) {
        return curr;
      }

      // Check for ambiguous conflict:
      // If one candidate is VERIFIED and one is FAILED:
      if (prev.status !== curr.status) {
        // Condition A: Sequence collision (both have same sequence number)
        if (prev.sequence !== undefined && curr.sequence !== undefined && prev.sequence === curr.sequence) {
          return {
            status: "FAILED",
            message: "Ambiguous conflicting verification evidence at identical sequence (fail closed)",
            sequence: curr.sequence,
            timestamp: curr.timestamp,
          };
        }

        // Condition B: Mixed sequenced / unsequenced evidence
        if (prev.sequence !== undefined && curr.sequence === undefined) {
          // Unsequenced pass cannot override a sequenced failure
          if (curr.status === "VERIFIED") {
            return prev; // keep sequenced failure
          }
          // Unsequenced failure supersedes or fails closed
          return curr;
        }
        if (prev.sequence === undefined && curr.sequence !== undefined) {
          // Sequenced event is authoritative over unsequenced
          return curr;
        }

        // Condition C: Pure timestamp collision when neither has sequence
        if (prev.sequence === undefined && curr.sequence === undefined && prev.timestamp === curr.timestamp) {
          return {
            status: "FAILED",
            message: "Ambiguous conflicting verification evidence at identical timestamp (fail closed)",
            timestamp: curr.timestamp,
          };
        }
      }

      // Standard precedence check: is current candidate strictly later than previous?
      let isStrictlyLater = false;
      if (prev.sequence !== undefined && curr.sequence !== undefined) {
        isStrictlyLater = curr.sequence > prev.sequence;
      } else if (prev.sequence === undefined && curr.sequence !== undefined) {
        isStrictlyLater = true;
      } else if (prev.sequence !== undefined && curr.sequence === undefined) {
        isStrictlyLater = false;
      } else {
        isStrictlyLater = curr.timestamp > prev.timestamp;
      }

      if (isStrictlyLater) {
        return curr;
      }
      return prev;
    };

    for (const event of sorted) {
      if (!event || typeof event !== "object" || typeof event.eventType !== "string") {
        continue;
      }

      if (!event.payload || typeof event.payload !== "object") {
        continue;
      }

      const payload = event.payload as Record<string, unknown>;
      const eventSeq = typeof (event as any).sequence === "number" ? (event as any).sequence : undefined;
      const eventTs = typeof event.timestamp === "string" ? event.timestamp : "";

      switch (event.eventType) {
        case "verification.latched": {
          const rawPath = typeof payload.protectedPath === "string" ? payload.protectedPath : "";
          const normalized = normalizeLatchPath(rawPath);
          if (!normalized) break;

          const stepNumber =
            typeof payload.stepNumber === "number" && Number.isInteger(payload.stepNumber) && payload.stepNumber >= 0
              ? payload.stepNumber
              : 0;
          const timestamp =
            typeof event.timestamp === "string"
              ? event.timestamp
              : typeof payload.timestamp === "string"
              ? (payload.timestamp as string)
              : "";
          const f2pExitCode = typeof payload.f2pExitCode === "number" ? payload.f2pExitCode : 0;
          const p2pExitCode = typeof payload.p2pExitCode === "number" ? payload.p2pExitCode : 0;

          // Fail-closed check: non-zero exit codes cannot latch target files
          if (f2pExitCode !== 0 || p2pExitCode !== 0) {
            break;
          }

          const targetHash = typeof payload.targetHash === "string" ? payload.targetHash : undefined;
          const cleanRoomSpecId =
            typeof payload.cleanRoomSpecId === "string" ? payload.cleanRoomSpecId : undefined;
          const taskId = typeof payload.taskId === "string" ? payload.taskId : undefined;

          this.activate({
            stepNumber,
            timestamp,
            protectedPath: normalized,
            f2pExitCode,
            p2pExitCode,
            targetHash,
            cleanRoomSpecId,
            taskId,
          });
          break;
        }

        case "verification.completed": {
          const status = payload.status;
          if (status === "VERIFIED") {
            activeCleanRoom = mergeCleanRoomCandidate(activeCleanRoom, {
              status: "VERIFIED",
              message: typeof payload.message === "string" ? payload.message : "",
              sequence: eventSeq,
              timestamp: eventTs,
            });
          } else if (status === "FAILED") {
            activeCleanRoom = mergeCleanRoomCandidate(activeCleanRoom, {
              status: "FAILED",
              message: typeof payload.message === "string" ? payload.message : "",
              sequence: eventSeq,
              timestamp: eventTs,
            });
          }
          break;
        }

        case "clean_room.verified": {
          activeCleanRoom = mergeCleanRoomCandidate(activeCleanRoom, {
            status: "VERIFIED",
            message:
              typeof payload.message === "string" ? payload.message : "Clean room dual gate passed",
            sequence: eventSeq,
            timestamp: eventTs,
          });
          break;
        }

        case "verification.rejected": {
          activeCleanRoom = mergeCleanRoomCandidate(activeCleanRoom, {
            status: "FAILED",
            message:
              typeof payload.message === "string" ? payload.message : "Verification rejected",
            sequence: eventSeq,
            timestamp: eventTs,
          });
          break;
        }

        default:
          // Ignore unrelated event types
          break;
      }
    }

    if (activeCleanRoom) {
      this._cleanRoomStatus = activeCleanRoom.status;
      this._cleanRoomVerified = activeCleanRoom.status === "VERIFIED";
      this._cleanRoomMessage = activeCleanRoom.message;
    }
  }

  /**
   * Reconstructs a PostPassVerificationLatch instance from durable events.
   */
  static reconstructFromEvents(
    events: readonly (DomainEvent<unknown> | PersistedEvent<unknown> | ReconstructibleEvent)[],
    options?: ReconstructFromEventsOptions
  ): PostPassVerificationLatch {
    const latch = new PostPassVerificationLatch();
    latch.reconstructFromEvents(events, options);
    return latch;
  }

  /**
   * Reconstitutes a PostPassVerificationLatch instance from a snapshot.
   */
  static fromSnapshot(snapshot: PostPassLatchSnapshot): PostPassVerificationLatch {
    const latch = new PostPassVerificationLatch();
    latch.restoreFromSnapshot(snapshot);
    return latch;
  }
}
