/**
 * Generalized Progress Accounting & Multi-Step Loop Detector
 * for Emerald Agent Fabric (Milestone 2.24).
 *
 * Core Principle: Activity is not progress.
 *
 * A tool call, file write, successful command, or new reasoning turn does NOT
 * automatically prove that the mission is progressing.
 *
 * Distinguishes:
 * - PROGRESS: Observable forward advancement in workspace state, verification, or fresh observations.
 * - NO_PROGRESS: Activity occurred but available evidence confirms no forward state advancement.
 * - REPEATED_CYCLE: Multi-step cycle (A -> B -> A -> B, A -> B -> C -> A -> B -> C) repeated without progress.
 * - INDETERMINATE: Uncertain execution outcome (e.g. UNKNOWN status, timeout without evidence).
 *
 * Invariants:
 * 1. Deterministic Fingerprints: Canonical action key = toolName + ":" + sha256(canonicalJsonStringify(normalizedPayload)).
 * 2. Bounded Memory: Fixed maximum capacity (default: 30) for history; bounded cycle length (2 to 5).
 * 3. False-Positive Safety: Legitimate operations with different inputs, changed workspace, new observations,
 *    or satisfied verification specs are recognized as progress or non-cycles.
 * 4. Fail-Closed Uncertainty: Uncertain outcomes yield INDETERMINATE, never assumed as no-progress.
 * 5. Reconstructable: Deterministically reconstructible from durable Action and Attempt records.
 */

import crypto from "node:crypto";
import { canonicalJsonStringify } from "../domain/canonical-hash.js";
import { ActionSnapshot } from "../domain/action.js";
import { AttemptSnapshot } from "../domain/attempt.js";

// ============================================================================
// 1. Types & Classification
// ============================================================================

export type ProgressClassification =
  | "PROGRESS"
  | "NO_PROGRESS"
  | "REPEATED_CYCLE"
  | "INDETERMINATE";

export interface ProgressAssessment {
  readonly classification: ProgressClassification;
  readonly reason: string;
  readonly cycleLength?: number;
  readonly repetitionCount?: number;
  readonly cyclePattern?: readonly string[];
  readonly evidenceSummary?: {
    readonly workspaceChanged: boolean;
    readonly verificationChanged: boolean;
    readonly observationChanged: boolean;
    readonly indeterminateOutcome: boolean;
  };
}

export interface ExecutedStepRecord {
  readonly stepNumber: number;
  readonly actionId: string;
  readonly sequenceNumber: number;
  readonly toolName: string;
  readonly inputPayload: unknown;
  readonly inputHash: string;
  readonly normalizedActionKey: string;
  readonly status: string; // SUCCEEDED, FAILED, TIMED_OUT, CANCELLED, UNKNOWN
  readonly outputHash?: string;
  readonly workspaceMutationVersion: number;
  readonly verificationSignature?: string;
  readonly timestamp: string;
}

export interface ProgressLoopDetectorOptions {
  /** Maximum number of executed steps retained in memory (default: 30) */
  readonly maxHistoryCapacity?: number;
  /** Minimum cycle period L to evaluate (default: 2) */
  readonly minCycleLength?: number;
  /** Maximum cycle period L to evaluate (default: 5) */
  readonly maxCycleLength?: number;
  /** Repetition threshold required to declare a confirmed stagnation cycle (default: 2) */
  readonly stagnationRepetitionThreshold?: number;
  /** Repetition threshold to issue an advisory warning observation (default: 1) */
  readonly advisoryRepetitionThreshold?: number;
}

export const DEFAULT_MAX_HISTORY_CAPACITY = 30;
export const DEFAULT_MIN_CYCLE_LENGTH = 2;
export const DEFAULT_MAX_CYCLE_LENGTH = 5;
export const DEFAULT_MAX_CONSECUTIVE_CYCLE_REPETITIONS = 2;
export const DEFAULT_STAGNATION_REPETITION_THRESHOLD = DEFAULT_MAX_CONSECUTIVE_CYCLE_REPETITIONS;
export const DEFAULT_ADVISORY_REPETITION_THRESHOLD = 1;

// ============================================================================
// 2. Implementation
// ============================================================================

export class ProgressLoopDetector {
  private maxHistoryCapacity: number;
  private minCycleLength: number;
  private maxCycleLength: number;
  private stagnationRepetitionThreshold: number;

  private readonly history: ExecutedStepRecord[] = [];
  private currentWorkspaceVersion: number = 0;
  private lastVerificationSignature: string | null = null;

  constructor(options?: ProgressLoopDetectorOptions) {
    this.maxHistoryCapacity = Math.max(10, options?.maxHistoryCapacity ?? DEFAULT_MAX_HISTORY_CAPACITY);
    this.minCycleLength = Math.max(2, options?.minCycleLength ?? DEFAULT_MIN_CYCLE_LENGTH);
    this.maxCycleLength = Math.max(this.minCycleLength, options?.maxCycleLength ?? DEFAULT_MAX_CYCLE_LENGTH);
    this.stagnationRepetitionThreshold = Math.max(1, options?.stagnationRepetitionThreshold ?? DEFAULT_STAGNATION_REPETITION_THRESHOLD);
  }

  /**
   * Updates runtime configuration for the detector.
   */
  public configure(options?: Partial<ProgressLoopDetectorOptions>): void {
    if (!options) return;
    if (options.maxHistoryCapacity !== undefined) {
      this.maxHistoryCapacity = Math.max(10, options.maxHistoryCapacity);
    }
    if (options.minCycleLength !== undefined) {
      this.minCycleLength = Math.max(2, options.minCycleLength);
    }
    if (options.maxCycleLength !== undefined) {
      this.maxCycleLength = Math.max(this.minCycleLength, options.maxCycleLength);
    }
    if (options.stagnationRepetitionThreshold !== undefined) {
      this.stagnationRepetitionThreshold = Math.max(1, options.stagnationRepetitionThreshold);
    }
  }

  /**
   * Normalizes workspace-relative path strings to posix forward slashes without leading `./`.
   */
  public normalizePath(filePath: string): string {
    return filePath.split("\\").join("/").replace(/^\.\//, "");
  }

  /**
   * Strips volatile execution metadata (e.g. proposalId, sequenceHint, contextSnapshotHash, rationale)
   * from an input payload so that functionally identical actions have identical canonical representations.
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
   * Computes a canonical, deterministic action key:
   * `${toolName}:${sha256(canonicalJsonStringify(normalizedPayload))}`
   */
  public computeActionKey(toolName: string, inputPayload: unknown): string {
    const norm = this.normalizePayload(inputPayload);
    const serialized = canonicalJsonStringify(norm);
    const hash = crypto.createHash("sha256").update(serialized).digest("hex");
    return `${toolName}:${hash}`;
  }

  /**
   * Computes a deterministic content hash for arbitrary output.
   */
  public computeOutputHash(output: unknown): string {
    const serialized = canonicalJsonStringify(output);
    return crypto.createHash("sha256").update(serialized).digest("hex");
  }

  /**
   * Records a workspace mutation version increment.
   */
  public recordWorkspaceMutation(): void {
    this.currentWorkspaceVersion++;
  }

  /**
   * Records an updated verification signature (e.g. test outcome hash, latched specs count).
   */
  public recordVerificationState(signature: string): void {
    this.lastVerificationSignature = signature;
  }

  /**
   * Records an executed step and evaluates whether it contributes to progress,
   * establishes a no-progress state, or completes a multi-step ineffective cycle.
   */
  public recordStep(params: {
    readonly stepNumber: number;
    readonly actionId: string;
    readonly sequenceNumber: number;
    readonly toolName: string;
    readonly inputPayload: unknown;
    readonly inputHash: string;
    readonly status: string;
    readonly output?: unknown;
    readonly verificationSignature?: string;
  }): ProgressAssessment {
    const normalizedActionKey = this.computeActionKey(params.toolName, params.inputPayload);
    const outputHash = params.output !== undefined ? this.computeOutputHash(params.output) : undefined;

    const record: ExecutedStepRecord = {
      stepNumber: params.stepNumber,
      actionId: params.actionId,
      sequenceNumber: params.sequenceNumber,
      toolName: params.toolName,
      inputPayload: params.inputPayload,
      inputHash: params.inputHash,
      normalizedActionKey,
      status: params.status,
      outputHash,
      workspaceMutationVersion: this.currentWorkspaceVersion,
      verificationSignature: params.verificationSignature ?? this.lastVerificationSignature ?? undefined,
      timestamp: new Date().toISOString(),
    };

    // Maintain bounded history
    if (this.history.length >= this.maxHistoryCapacity) {
      this.history.shift();
    }
    this.history.push(record);

    // Rule 1: Fail closed on uncertain execution outcomes
    if (params.status === "UNKNOWN") {
      return {
        classification: "INDETERMINATE",
        reason: `Execution outcome of Action '${params.actionId}' is UNKNOWN; cannot verify progress or stagnation`,
        evidenceSummary: {
          workspaceChanged: false,
          verificationChanged: false,
          observationChanged: false,
          indeterminateOutcome: true,
        },
      };
    }

    // Rule 2: Verification progress directly breaks stagnation
    const verificationChanged =
      params.verificationSignature !== undefined &&
      params.verificationSignature !== this.lastVerificationSignature;

    if (verificationChanged && params.verificationSignature) {
      this.lastVerificationSignature = params.verificationSignature;
      return {
        classification: "PROGRESS",
        reason: "Authoritative verification state changed or improved",
        evidenceSummary: {
          workspaceChanged: false,
          verificationChanged: true,
          observationChanged: false,
          indeterminateOutcome: false,
        },
      };
    }

    if (params.verificationSignature) {
      this.lastVerificationSignature = params.verificationSignature;
    }

    // Rule 3: Evaluate multi-step cycles across bounded history
    return this.evaluateCycles();
  }

  /**
   * Evaluates the recorded history for repeated multi-step cycles:
   * A -> B -> A -> B (L = 2)
   * A -> B -> C -> A -> B -> C (L = 3)
   * up to maxCycleLength.
   */
  public evaluateCycles(): ProgressAssessment {
    const N = this.history.length;
    if (N < this.minCycleLength * 2) {
      return {
        classification: "NO_PROGRESS",
        reason: `Insufficient action history (${N} steps) to establish multi-step cycle`,
        evidenceSummary: {
          workspaceChanged: false,
          verificationChanged: false,
          observationChanged: false,
          indeterminateOutcome: false,
        },
      };
    }

    // Evaluate candidate cycle lengths from smallest (2) to largest (maxCycleLength)
    for (let L = this.minCycleLength; L <= this.maxCycleLength; L++) {
      if (N < L * 2) continue;

      // Check how many times the suffix of length L repeats consecutively backwards
      const currentCycle = this.history.slice(N - L, N);
      let consecutiveRepetitions = 1; // currentCycle is 1 instance

      let checkOffset = N - L;

      while (checkOffset >= L) {
        const priorCycle = this.history.slice(checkOffset - L, checkOffset);
        const isMatch = this.areCyclesIdentical(priorCycle, currentCycle);
        if (isMatch) {
          consecutiveRepetitions++;
          checkOffset -= L;
        } else {
          break;
        }
      }

      // If we found at least 2 full occurrences of the sequence (1 repeat):
      if (consecutiveRepetitions >= 2) {
        // Now assess whether this repeated sequence produced genuine progress
        const cycleProgress = this.assessCycleProgress(L, consecutiveRepetitions);

        if (cycleProgress.hasGenuineProgress) {
          return {
            classification: "PROGRESS",
            reason: cycleProgress.progressReason ?? "Repeated action sequence produced genuine observable state or verification progress",
            cycleLength: L,
            repetitionCount: consecutiveRepetitions,
            evidenceSummary: {
              workspaceChanged: cycleProgress.workspaceChanged,
              verificationChanged: cycleProgress.verificationChanged,
              observationChanged: cycleProgress.observationChanged,
              indeterminateOutcome: false,
            },
          };
        }

        if (cycleProgress.hasIndeterminateOutcome) {
          return {
            classification: "INDETERMINATE",
            reason: "One or more steps in the repeating sequence produced an uncertain outcome",
            cycleLength: L,
            repetitionCount: consecutiveRepetitions,
            evidenceSummary: {
              workspaceChanged: false,
              verificationChanged: false,
              observationChanged: false,
              indeterminateOutcome: true,
            },
          };
        }

        const patternNames = currentCycle.map((r) => r.toolName);

        // Confirmed repeated ineffective cycle
        if (consecutiveRepetitions >= this.stagnationRepetitionThreshold) {
          return {
            classification: "REPEATED_CYCLE",
            reason: `Repeated ineffective cycle of length ${L} (${patternNames.join(" -> ")}) executed ${consecutiveRepetitions} times without progress`,
            cycleLength: L,
            repetitionCount: consecutiveRepetitions,
            cyclePattern: patternNames,
            evidenceSummary: {
              workspaceChanged: false,
              verificationChanged: false,
              observationChanged: false,
              indeterminateOutcome: false,
            },
          };
        }

        // Advisory threshold reached (e.g. 1 completed repeat)
        return {
          classification: "NO_PROGRESS",
          reason: `Action cycle of length ${L} (${patternNames.join(" -> ")}) is repeating without observable progress`,
          cycleLength: L,
          repetitionCount: consecutiveRepetitions,
          cyclePattern: patternNames,
          evidenceSummary: {
            workspaceChanged: false,
            verificationChanged: false,
            observationChanged: false,
            indeterminateOutcome: false,
          },
        };
      }
    }

    return {
      classification: "NO_PROGRESS",
      reason: "No confirmed repeating cycle or verified progress detected",
      evidenceSummary: {
        workspaceChanged: false,
        verificationChanged: false,
        observationChanged: false,
        indeterminateOutcome: false,
      },
    };
  }

  /**
   * Compares two slices of history to determine if they execute the same sequence of actions.
   */
  private areCyclesIdentical(a: ExecutedStepRecord[], b: ExecutedStepRecord[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const stepA = a[i];
      const stepB = b[i];
      if (!stepA || !stepB || stepA.normalizedActionKey !== stepB.normalizedActionKey) {
        return false;
      }
    }
    return true;
  }

  /**
   * Determines whether a repeating cycle produced genuine observable progress.
   */
  private assessCycleProgress(
    cycleLength: number,
    repetitionCount: number
  ): {
    readonly hasGenuineProgress: boolean;
    readonly progressReason?: string;
    readonly hasIndeterminateOutcome: boolean;
    readonly workspaceChanged: boolean;
    readonly verificationChanged: boolean;
    readonly observationChanged: boolean;
  } {
    const totalStepsInCycles = cycleLength * repetitionCount;
    const startIndex = this.history.length - totalStepsInCycles;
    const relevantSteps = this.history.slice(startIndex);

    let hasIndeterminateOutcome = false;
    let observationChanged = false;
    let workspaceChanged = false;
    let verificationChanged = false;

    // 1. Check for any indeterminate outcomes
    for (const step of relevantSteps) {
      if (step.status === "UNKNOWN") {
        hasIndeterminateOutcome = true;
        break;
      }
    }

    if (hasIndeterminateOutcome) {
      return {
        hasGenuineProgress: false,
        hasIndeterminateOutcome: true,
        workspaceChanged: false,
        verificationChanged: false,
        observationChanged: false,
      };
    }

    // 2. Check if read/observation output changed between matching steps in the cycle
    // If an agent executes read_file in cycle 1 and read_file in cycle 2, and the output
    // changed, that indicates fresh information was observed.
    for (let i = 0; i < cycleLength; i++) {
      const stepInCycle1 = relevantSteps[i];
      const stepInCycle2 = relevantSteps[i + cycleLength];
      if (
        stepInCycle1?.outputHash &&
        stepInCycle2?.outputHash &&
        stepInCycle1.outputHash !== stepInCycle2.outputHash
      ) {
        observationChanged = true;
        break;
      }
    }

    if (observationChanged) {
      return {
        hasGenuineProgress: true,
        progressReason: "Tool execution returned fresh, different output compared to prior iteration",
        hasIndeterminateOutcome: false,
        workspaceChanged: false,
        verificationChanged: false,
        observationChanged: true,
      };
    }

    // 3. Check if workspace state advanced
    const firstStep = relevantSteps[0];
    const lastStep = relevantSteps[relevantSteps.length - 1];
    if (firstStep && lastStep && lastStep.workspaceMutationVersion > firstStep.workspaceMutationVersion) {
      workspaceChanged = true;
    }

    // 4. Check if verification state changed
    const initialVerification = firstStep?.verificationSignature;
    const finalVerification = lastStep?.verificationSignature;
    if (
      initialVerification !== undefined &&
      finalVerification !== undefined &&
      initialVerification !== finalVerification
    ) {
      verificationChanged = true;
    }

    if (verificationChanged) {
      return {
        hasGenuineProgress: true,
        progressReason: "Verification state advanced during action sequence",
        hasIndeterminateOutcome: false,
        workspaceChanged,
        verificationChanged: true,
        observationChanged: false,
      };
    }

    if (workspaceChanged) {
      return {
        hasGenuineProgress: true,
        progressReason: "Workspace state mutated during action sequence",
        hasIndeterminateOutcome: false,
        workspaceChanged: true,
        verificationChanged: false,
        observationChanged: false,
      };
    }

    return {
      hasGenuineProgress: false,
      hasIndeterminateOutcome: false,
      workspaceChanged,
      verificationChanged: false,
      observationChanged: false,
    };
  }

  /**
   * Reconstructs history deterministically from durable Action and Attempt records.
   * Guarantees process-recovery resilience without requiring database migrations.
   */
  public reconstructFromDurableHistory(
    actions: readonly ActionSnapshot[],
    getAttemptsForAction: (actionId: string) => readonly AttemptSnapshot[]
  ): void {
    this.clearAll();

    // Sort actions by sequenceNumber ascending
    const sorted = [...actions].sort((a, b) => a.sequenceNumber - b.sequenceNumber);

    for (let i = 0; i < sorted.length; i++) {
      const act = sorted[i];
      if (!act) continue;
      const attempts = getAttemptsForAction(act.actionId);
      const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;

      const normalizedActionKey = this.computeActionKey(act.toolName, act.inputPayload);
      const outputHash = act.resultPayload ? this.computeOutputHash(act.resultPayload) : undefined;
      const status = latestAttempt?.status ?? act.status;

      if (act.toolName === "write_file" || act.toolName === "edit_file") {
        if (status === "SUCCEEDED") {
          this.currentWorkspaceVersion++;
        }
      }

      const record: ExecutedStepRecord = {
        stepNumber: i + 1,
        actionId: act.actionId,
        sequenceNumber: act.sequenceNumber,
        toolName: act.toolName,
        inputPayload: act.inputPayload,
        inputHash: act.inputHash,
        normalizedActionKey,
        status,
        outputHash,
        workspaceMutationVersion: this.currentWorkspaceVersion,
        timestamp: act.createdAt,
      };

      if (this.history.length >= this.maxHistoryCapacity) {
        this.history.shift();
      }
      this.history.push(record);
    }
  }

  /**
   * Clears all detector state across runs/trials.
   */
  public clearAll(): void {
    this.history.length = 0;
    this.currentWorkspaceVersion = 0;
    this.lastVerificationSignature = null;
  }

  public getHistoryCount(): number {
    return this.history.length;
  }

  public getHistory(): readonly ExecutedStepRecord[] {
    return Object.freeze([...this.history]);
  }
}
