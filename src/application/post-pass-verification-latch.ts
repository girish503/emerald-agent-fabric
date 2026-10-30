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
  readonly isLatched: boolean;
  readonly activationEvent?: Readonly<PostPassLatchActivationParams>;
  readonly protectedPaths: readonly string[];
  readonly cleanRoomVerified: boolean;
  readonly cleanRoomStatus?: "VERIFIED" | "FAILED";
  readonly cleanRoomMessage?: string;
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
      isLatched: this._isLatched,
      ...(this._activationEvent ? { activationEvent: this._activationEvent } : {}),
      protectedPaths: Object.freeze(Array.from(this._protectedPaths)),
      cleanRoomVerified: this._cleanRoomVerified,
      ...(this._cleanRoomStatus ? { cleanRoomStatus: this._cleanRoomStatus } : {}),
      ...(this._cleanRoomMessage ? { cleanRoomMessage: this._cleanRoomMessage } : {}),
    });
  }
}
