/**
 * Pure Attempt Domain Aggregate, State Machine & Invariants for Emerald Agent Fabric.
 *
 * An Attempt represents one physical trial of an Action.
 *
 * Core Boundary Guarantees:
 * 1. Semantic Separation: Action (logical intention) != Attempt (physical trial).
 * 2. Mandatory Worker & Lease Ownership: Bound strictly to executing workerId and leaseId.
 * 3. Unique Physical Idempotency Token: `${runId}:${actionId}:${attemptNumber}`.
 * 4. Critical UNKNOWN Semantics: Explicit state for execution uncertainty (crash window).
 *    UNKNOWN is strictly terminal; cannot be resumed, guessed as succeeded, or blindly retried.
 * 5. Purity: Zero I/O, zero network, zero Docker, zero SQLite dependencies.
 */

import {
  InvalidAttemptError,
  InvalidAttemptTransitionError,
} from "./errors.js";

/**
 * Deterministic lifecycle states for an Attempt.
 */
export type AttemptStatus =
  | "CREATED"
  | "DISPATCHED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELLED"
  | "UNKNOWN";

export const TERMINAL_ATTEMPT_STATUSES: ReadonlySet<AttemptStatus> = new Set<AttemptStatus>([
  "SUCCEEDED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
  "UNKNOWN",
]);

export function isTerminalAttemptStatus(status: AttemptStatus): boolean {
  return TERMINAL_ATTEMPT_STATUSES.has(status);
}

/**
 * Generates the deterministic physical idempotency token for an Attempt.
 */
export function createAttemptIdempotencyToken(
  runId: string,
  actionId: string,
  attemptNumber: number
): string {
  return `${runId}:${actionId}:${attemptNumber}`;
}

/**
 * Deep freezes an arbitrary object/array graph for strict immutability.
 */
function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Object.isFrozen(obj)) {
    return obj;
  }
  const props = Object.getOwnPropertyNames(obj);
  for (const prop of props) {
    const val = (obj as Record<string, unknown>)[prop];
    if (val !== null && typeof val === "object") {
      deepFreeze(val);
    }
  }
  return Object.freeze(obj);
}

/**
 * Immutable snapshot representing the complete domain state of an Attempt.
 */
export interface AttemptSnapshot {
  readonly attemptId: string;
  readonly actionId: string;
  readonly runId: string;
  readonly attemptNumber: number;
  readonly workerId: string;
  readonly leaseId: string;
  readonly idempotencyToken: string;
  readonly status: AttemptStatus;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly exitCode: number | null;
  readonly outputPayload: unknown | null;
  readonly errorPayload: unknown | null;
  readonly evidenceIds: readonly string[];
  readonly providerMetadata?: Readonly<Record<string, unknown>> | null;
}

/**
 * Validates Attempt domain invariants, throwing InvalidAttemptError on violation.
 */
export function validateAttemptInvariants(snapshot: AttemptSnapshot): void {
  const violations: string[] = [];

  if (!snapshot || typeof snapshot !== "object") {
    throw new InvalidAttemptError("unknown", ["Attempt snapshot must be a valid object"]);
  }

  // 1. Identity & Scoping
  if (typeof snapshot.attemptId !== "string" || snapshot.attemptId.trim().length === 0) {
    violations.push("attemptId must be a non-empty string");
  }

  if (typeof snapshot.actionId !== "string" || snapshot.actionId.trim().length === 0) {
    violations.push("actionId must be a non-empty string");
  }

  if (typeof snapshot.runId !== "string" || snapshot.runId.trim().length === 0) {
    violations.push("runId must be a non-empty string");
  }

  if (
    typeof snapshot.attemptNumber !== "number" ||
    !Number.isInteger(snapshot.attemptNumber) ||
    snapshot.attemptNumber < 1
  ) {
    violations.push(`attemptNumber must be an integer >= 1, received ${String(snapshot.attemptNumber)}`);
  }

  // 2. Worker & Lease Ownership Context
  if (typeof snapshot.workerId !== "string" || snapshot.workerId.trim().length === 0) {
    violations.push("workerId must be a non-empty string");
  }

  if (typeof snapshot.leaseId !== "string" || snapshot.leaseId.trim().length === 0) {
    violations.push("leaseId must be a non-empty string");
  }

  // 3. Idempotency Token
  if (typeof snapshot.idempotencyToken !== "string" || snapshot.idempotencyToken.trim().length === 0) {
    violations.push("idempotencyToken must be a non-empty string");
  }

  // 4. Status Validity
  const validStatuses: readonly AttemptStatus[] = [
    "CREATED",
    "DISPATCHED",
    "RUNNING",
    "SUCCEEDED",
    "FAILED",
    "TIMED_OUT",
    "CANCELLED",
    "UNKNOWN",
  ];
  if (!validStatuses.includes(snapshot.status)) {
    violations.push(`Invalid attempt status '${String(snapshot.status)}'`);
  }

  // 5. Timestamps & Durations
  if (typeof snapshot.startedAt !== "string" || snapshot.startedAt.trim().length === 0) {
    violations.push("startedAt must be a non-empty string");
  }

  if (snapshot.durationMs !== null && snapshot.durationMs !== undefined) {
    if (typeof snapshot.durationMs !== "number" || snapshot.durationMs < 0) {
      violations.push(`durationMs must be a number >= 0, received ${String(snapshot.durationMs)}`);
    }
  }

  if (snapshot.exitCode !== null && snapshot.exitCode !== undefined) {
    if (typeof snapshot.exitCode !== "number" || !Number.isInteger(snapshot.exitCode)) {
      violations.push(`exitCode must be an integer or null, received ${String(snapshot.exitCode)}`);
    }
  }

  // 6. Evidence Items
  if (!Array.isArray(snapshot.evidenceIds)) {
    violations.push("evidenceIds must be an array");
  } else {
    for (const id of snapshot.evidenceIds) {
      if (typeof id !== "string" || id.trim().length === 0) {
        violations.push("evidenceIds entries must be non-empty strings");
        break;
      }
    }
  }

  // 7. Terminal State Consistency
  if (isTerminalAttemptStatus(snapshot.status)) {
    if (typeof snapshot.completedAt !== "string" || snapshot.completedAt.trim().length === 0) {
      violations.push(`completedAt must be a non-empty ISO timestamp when Attempt is terminal status '${snapshot.status}'`);
    }
    if (snapshot.status === "SUCCEEDED") {
      if (snapshot.errorPayload !== null) {
        violations.push("errorPayload must be null when Attempt SUCCEEDED");
      }
    } else {
      if (snapshot.errorPayload === null || snapshot.errorPayload === undefined) {
        violations.push(`errorPayload must be non-null when Attempt is in failed/unknown status '${snapshot.status}'`);
      }
    }
  } else {
    if (snapshot.completedAt !== null) {
      violations.push(`completedAt must be null when Attempt is non-terminal status '${snapshot.status}'`);
    }
  }

  // 8. Initial CREATED Consistency
  if (snapshot.status === "CREATED") {
    if (snapshot.completedAt !== null) {
      violations.push("completedAt must be null when Attempt is CREATED");
    }
    if (snapshot.durationMs !== null) {
      violations.push("durationMs must be null when Attempt is CREATED");
    }
    if (snapshot.outputPayload !== null) {
      violations.push("outputPayload must be null when Attempt is CREATED");
    }
    if (snapshot.errorPayload !== null) {
      violations.push("errorPayload must be null when Attempt is CREATED");
    }
  }

  if (violations.length > 0) {
    throw new InvalidAttemptError(snapshot.attemptId ?? "unknown", violations);
  }
}

/**
 * Commands dispatched to transition an Attempt's lifecycle.
 */
export type AttemptCommand =
  | { readonly type: "DISPATCH"; readonly now: string }
  | { readonly type: "START"; readonly now: string }
  | {
      readonly type: "COMPLETE";
      readonly outputPayload?: unknown;
      readonly exitCode?: number | null;
      readonly evidenceIds?: readonly string[];
      readonly providerMetadata?: Record<string, unknown>;
      readonly durationMs?: number | null;
      readonly now: string;
    }
  | {
      readonly type: "FAIL";
      readonly errorPayload: unknown;
      readonly exitCode?: number | null;
      readonly evidenceIds?: readonly string[];
      readonly providerMetadata?: Record<string, unknown>;
      readonly durationMs?: number | null;
      readonly now: string;
    }
  | {
      readonly type: "TIMEOUT";
      readonly errorPayload?: unknown;
      readonly durationMs?: number | null;
      readonly now: string;
    }
  | {
      readonly type: "CANCEL";
      readonly reason?: unknown;
      readonly now: string;
    }
  | {
      readonly type: "MARK_UNKNOWN";
      readonly reason: string;
      readonly now: string;
    };

/**
 * Pure state machine transition function for Attempt.
 */
export function applyAttemptTransition(
  snapshot: AttemptSnapshot,
  command: AttemptCommand
): AttemptSnapshot {
  if (isTerminalAttemptStatus(snapshot.status)) {
    throw new InvalidAttemptTransitionError(
      snapshot.status,
      command.type,
      `Attempt is in terminal state '${snapshot.status}' and cannot transition`
    );
  }

  switch (snapshot.status) {
    case "CREATED": {
      if (command.type === "DISPATCH") {
        return deepFreeze({
          ...snapshot,
          status: "DISPATCHED",
          startedAt: command.now,
        });
      }
      if (command.type === "CANCEL") {
        return deepFreeze({
          ...snapshot,
          status: "CANCELLED",
          errorPayload: command.reason ?? "Attempt cancelled before dispatch",
          completedAt: command.now,
        });
      }
      throw new InvalidAttemptTransitionError(snapshot.status, command.type);
    }

    case "DISPATCHED": {
      if (command.type === "START") {
        return deepFreeze({
          ...snapshot,
          status: "RUNNING",
        });
      }
      if (command.type === "COMPLETE") {
        return deepFreeze({
          ...snapshot,
          status: "SUCCEEDED",
          outputPayload: command.outputPayload ?? null,
          errorPayload: null,
          exitCode: command.exitCode ?? 0,
          evidenceIds: command.evidenceIds ? Object.freeze([...command.evidenceIds]) : snapshot.evidenceIds,
          providerMetadata: command.providerMetadata ? deepFreeze({ ...command.providerMetadata }) : snapshot.providerMetadata,
          durationMs: command.durationMs ?? null,
          completedAt: command.now,
        });
      }
      if (command.type === "FAIL") {
        return deepFreeze({
          ...snapshot,
          status: "FAILED",
          errorPayload: command.errorPayload,
          exitCode: command.exitCode ?? null,
          evidenceIds: command.evidenceIds ? Object.freeze([...command.evidenceIds]) : snapshot.evidenceIds,
          providerMetadata: command.providerMetadata ? deepFreeze({ ...command.providerMetadata }) : snapshot.providerMetadata,
          durationMs: command.durationMs ?? null,
          completedAt: command.now,
        });
      }
      if (command.type === "TIMEOUT") {
        return deepFreeze({
          ...snapshot,
          status: "TIMED_OUT",
          errorPayload: command.errorPayload ?? "Execution timed out",
          durationMs: command.durationMs ?? null,
          completedAt: command.now,
        });
      }
      if (command.type === "CANCEL") {
        return deepFreeze({
          ...snapshot,
          status: "CANCELLED",
          errorPayload: command.reason ?? "Attempt cancelled",
          completedAt: command.now,
        });
      }
      if (command.type === "MARK_UNKNOWN") {
        return deepFreeze({
          ...snapshot,
          status: "UNKNOWN",
          errorPayload: { code: "EXECUTION_UNCERTAIN", reason: command.reason },
          completedAt: command.now,
        });
      }
      throw new InvalidAttemptTransitionError(snapshot.status, command.type);
    }

    case "RUNNING": {
      if (command.type === "COMPLETE") {
        return deepFreeze({
          ...snapshot,
          status: "SUCCEEDED",
          outputPayload: command.outputPayload ?? null,
          errorPayload: null,
          exitCode: command.exitCode ?? 0,
          evidenceIds: command.evidenceIds ? Object.freeze([...command.evidenceIds]) : snapshot.evidenceIds,
          providerMetadata: command.providerMetadata ? deepFreeze({ ...command.providerMetadata }) : snapshot.providerMetadata,
          durationMs: command.durationMs ?? null,
          completedAt: command.now,
        });
      }
      if (command.type === "FAIL") {
        return deepFreeze({
          ...snapshot,
          status: "FAILED",
          errorPayload: command.errorPayload,
          exitCode: command.exitCode ?? null,
          evidenceIds: command.evidenceIds ? Object.freeze([...command.evidenceIds]) : snapshot.evidenceIds,
          providerMetadata: command.providerMetadata ? deepFreeze({ ...command.providerMetadata }) : snapshot.providerMetadata,
          durationMs: command.durationMs ?? null,
          completedAt: command.now,
        });
      }
      if (command.type === "TIMEOUT") {
        return deepFreeze({
          ...snapshot,
          status: "TIMED_OUT",
          errorPayload: command.errorPayload ?? "Execution timed out",
          durationMs: command.durationMs ?? null,
          completedAt: command.now,
        });
      }
      if (command.type === "CANCEL") {
        return deepFreeze({
          ...snapshot,
          status: "CANCELLED",
          errorPayload: command.reason ?? "Execution cancelled",
          completedAt: command.now,
        });
      }
      if (command.type === "MARK_UNKNOWN") {
        return deepFreeze({
          ...snapshot,
          status: "UNKNOWN",
          errorPayload: { code: "EXECUTION_UNCERTAIN", reason: command.reason },
          completedAt: command.now,
        });
      }
      throw new InvalidAttemptTransitionError(snapshot.status, command.type);
    }

    default:
      throw new InvalidAttemptTransitionError(snapshot.status, (command as any).type);
  }
}

export interface CreateAttemptParams {
  readonly attemptId?: string;
  readonly actionId: string;
  readonly runId: string;
  readonly attemptNumber: number;
  readonly workerId: string;
  readonly leaseId: string;
  readonly idempotencyToken?: string;
  readonly now?: string;
}

/**
 * Attempt Aggregate Root.
 * Encapsulates one physical execution instance of an Action.
 */
export class Attempt {
  private _snapshot: AttemptSnapshot;

  private constructor(snapshot: AttemptSnapshot) {
    validateAttemptInvariants(snapshot);
    this._snapshot = deepFreeze({ ...snapshot });
  }

  /**
   * Factory method to create a new Attempt aggregate in CREATED state.
   */
  static create(params: CreateAttemptParams): Attempt {
    const now = params.now ?? new Date().toISOString();
    const attemptId = params.attemptId ?? crypto.randomUUID();
    const idempotencyToken =
      params.idempotencyToken ??
      createAttemptIdempotencyToken(params.runId, params.actionId, params.attemptNumber);

    const snapshot: AttemptSnapshot = {
      attemptId,
      actionId: params.actionId,
      runId: params.runId,
      attemptNumber: params.attemptNumber,
      workerId: params.workerId,
      leaseId: params.leaseId,
      idempotencyToken,
      status: "CREATED",
      startedAt: now,
      completedAt: null,
      durationMs: null,
      exitCode: null,
      outputPayload: null,
      errorPayload: null,
      evidenceIds: Object.freeze([]),
      providerMetadata: null,
    };

    validateAttemptInvariants(snapshot);
    return new Attempt(snapshot);
  }

  /**
   * Reconstitutes an Attempt aggregate from a persisted snapshot.
   */
  static reconstitute(snapshot: AttemptSnapshot): Attempt {
    return new Attempt(snapshot);
  }

  get snapshot(): AttemptSnapshot {
    return this._snapshot;
  }

  get attemptId(): string {
    return this._snapshot.attemptId;
  }

  get actionId(): string {
    return this._snapshot.actionId;
  }

  get runId(): string {
    return this._snapshot.runId;
  }

  get attemptNumber(): number {
    return this._snapshot.attemptNumber;
  }

  get workerId(): string {
    return this._snapshot.workerId;
  }

  get leaseId(): string {
    return this._snapshot.leaseId;
  }

  get idempotencyToken(): string {
    return this._snapshot.idempotencyToken;
  }

  get status(): AttemptStatus {
    return this._snapshot.status;
  }

  get startedAt(): string {
    return this._snapshot.startedAt;
  }

  get completedAt(): string | null {
    return this._snapshot.completedAt;
  }

  get durationMs(): number | null {
    return this._snapshot.durationMs;
  }

  get exitCode(): number | null {
    return this._snapshot.exitCode;
  }

  get outputPayload(): unknown | null {
    return this._snapshot.outputPayload;
  }

  get errorPayload(): unknown | null {
    return this._snapshot.errorPayload;
  }

  get evidenceIds(): readonly string[] {
    return this._snapshot.evidenceIds;
  }

  get providerMetadata(): Readonly<Record<string, unknown>> | null | undefined {
    return this._snapshot.providerMetadata;
  }

  private dispatchCommand(command: AttemptCommand): void {
    const nextSnapshot = applyAttemptTransition(this._snapshot, command);
    validateAttemptInvariants(nextSnapshot);
    this._snapshot = nextSnapshot;
  }

  dispatch(now?: string): void {
    this.dispatchCommand({
      type: "DISPATCH",
      now: now ?? new Date().toISOString(),
    });
  }

  start(now?: string): void {
    this.dispatchCommand({
      type: "START",
      now: now ?? new Date().toISOString(),
    });
  }

  complete(params: {
    outputPayload?: unknown;
    exitCode?: number | null;
    evidenceIds?: readonly string[];
    providerMetadata?: Record<string, unknown>;
    durationMs?: number | null;
    now?: string;
  } = {}): void {
    this.dispatchCommand({
      type: "COMPLETE",
      outputPayload: params.outputPayload,
      exitCode: params.exitCode,
      evidenceIds: params.evidenceIds,
      providerMetadata: params.providerMetadata,
      durationMs: params.durationMs,
      now: params.now ?? new Date().toISOString(),
    });
  }

  fail(params: {
    errorPayload: unknown;
    exitCode?: number | null;
    evidenceIds?: readonly string[];
    providerMetadata?: Record<string, unknown>;
    durationMs?: number | null;
    now?: string;
  }): void {
    this.dispatchCommand({
      type: "FAIL",
      errorPayload: params.errorPayload,
      exitCode: params.exitCode,
      evidenceIds: params.evidenceIds,
      providerMetadata: params.providerMetadata,
      durationMs: params.durationMs,
      now: params.now ?? new Date().toISOString(),
    });
  }

  timeout(params: {
    errorPayload?: unknown;
    durationMs?: number | null;
    now?: string;
  } = {}): void {
    this.dispatchCommand({
      type: "TIMEOUT",
      errorPayload: params.errorPayload,
      durationMs: params.durationMs,
      now: params.now ?? new Date().toISOString(),
    });
  }

  cancel(params: {
    reason?: unknown;
    now?: string;
  } = {}): void {
    this.dispatchCommand({
      type: "CANCEL",
      reason: params.reason,
      now: params.now ?? new Date().toISOString(),
    });
  }

  markUnknown(params: {
    reason: string;
    now?: string;
  }): void {
    this.dispatchCommand({
      type: "MARK_UNKNOWN",
      reason: params.reason,
      now: params.now ?? new Date().toISOString(),
    });
  }
}
