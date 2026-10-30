/**
 * Pure Action Domain Aggregate, State Machine & Invariants for Emerald Agent Fabric.
 *
 * An Action represents one logical unit of work (intention) requested by the execution system.
 *
 * Core Boundary Guarantees:
 * 1. Semantic Separation: Action (logical intention) != Attempt (physical trial).
 * 2. Authority Inheritance: Traceable strictly to the bound MissionContract (contractId, version, contentHash).
 * 3. Immutable Intent: Parameters, inputHash, sequenceNumber, and tool identity are frozen at creation.
 * 4. Deterministic State Machine: Pure, side-effect-free transitions with terminal state enforcement.
 * 5. Purity: Zero I/O, zero network, zero Docker, zero SQLite dependencies.
 */

import { computeCanonicalHash } from "./canonical-hash.js";
import {
  ActionAuthorizedEvent,
  ActionCancelledEvent,
  ActionCompletedEvent,
  ActionCreatedEvent,
  ActionFailedEvent,
  ActionRetryingEvent,
  ActionStartedEvent,
  ActionTimedOutEvent,
  AnyActionEvent,
} from "./events.js";
import {
  InvalidActionError,
  InvalidActionTransitionError,
} from "./errors.js";
import {
  ContractBinding,
  createContractBinding,
  getContractBindingViolations,
} from "./invariants.js";
import {
  ExtendedToolName,
  isValidToolName,
  TOOL_IDEMPOTENCY_MAP,
  ToolIdempotency,
  ToolName,
} from "./tool.js";

/**
 * Deterministic lifecycle states for an Action.
 */
export type ActionStatus =
  | "CREATED"
  | "AUTHORIZED"
  | "RUNNING"
  | "RETRYING"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELLED";

export const TERMINAL_ACTION_STATUSES: ReadonlySet<ActionStatus> = new Set<ActionStatus>([
  "SUCCEEDED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
]);

export function isTerminalActionStatus(status: ActionStatus): boolean {
  return TERMINAL_ACTION_STATUSES.has(status);
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
 * Immutable snapshot representing the complete domain state of an Action.
 */
export interface ActionSnapshot {
  readonly actionId: string;
  readonly runId: string;
  readonly sequenceNumber: number;
  readonly toolName: ExtendedToolName;
  readonly inputPayload: unknown;
  readonly inputHash: string;
  readonly idempotency: ToolIdempotency;
  readonly contractBinding: ContractBinding;
  readonly maxAttempts: number;
  readonly createdAt: string;
  readonly status: ActionStatus;
  readonly activeAttemptNumber: number | null;
  readonly totalAttempts: number;
  readonly resultPayload: unknown | null;
  readonly errorPayload: unknown | null;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

/**
 * Validates Action domain invariants, throwing InvalidActionError on violation.
 */
export function validateActionInvariants(snapshot: ActionSnapshot): void {
  const violations: string[] = [];

  if (!snapshot || typeof snapshot !== "object") {
    throw new InvalidActionError("unknown", ["Action snapshot must be a valid object"]);
  }

  // 1. Identity & Scoping
  if (typeof snapshot.actionId !== "string" || snapshot.actionId.trim().length === 0) {
    violations.push("actionId must be a non-empty string");
  }

  if (typeof snapshot.runId !== "string" || snapshot.runId.trim().length === 0) {
    violations.push("runId must be a non-empty string");
  }

  if (
    typeof snapshot.sequenceNumber !== "number" ||
    !Number.isInteger(snapshot.sequenceNumber) ||
    snapshot.sequenceNumber < 1
  ) {
    violations.push(`sequenceNumber must be an integer >= 1, received ${String(snapshot.sequenceNumber)}`);
  }

  // 2. Tool & Idempotency
  if (!isValidToolName(snapshot.toolName)) {
    violations.push(`Invalid toolName '${String(snapshot.toolName)}'`);
  } else {
    const expectedIdempotency = TOOL_IDEMPOTENCY_MAP[snapshot.toolName];
    if (snapshot.idempotency !== expectedIdempotency) {
      violations.push(
        `Idempotency mismatch for tool '${snapshot.toolName}': expected '${expectedIdempotency}', received '${String(snapshot.idempotency)}'`
      );
    }
  }

  // 3. Input Hash Integrity
  if (
    typeof snapshot.inputHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(snapshot.inputHash)
  ) {
    violations.push("inputHash must be exactly 64 lowercase hexadecimal characters");
  } else {
    const computed = computeCanonicalHash(snapshot.inputPayload);
    if (computed.contentHash !== snapshot.inputHash) {
      violations.push(
        `inputHash does not match canonical hash of inputPayload: expected '${computed.contentHash}', received '${snapshot.inputHash}'`
      );
    }
  }

  // 4. Contract Binding Authority
  const bindingViolations = getContractBindingViolations(snapshot.contractBinding);
  if (bindingViolations.length > 0) {
    violations.push(...bindingViolations);
  }

  // 5. Attempt Accounting & Ceilings
  if (
    typeof snapshot.maxAttempts !== "number" ||
    !Number.isInteger(snapshot.maxAttempts) ||
    snapshot.maxAttempts < 1
  ) {
    violations.push(`maxAttempts must be an integer >= 1, received ${String(snapshot.maxAttempts)}`);
  }

  if (
    typeof snapshot.totalAttempts !== "number" ||
    !Number.isInteger(snapshot.totalAttempts) ||
    snapshot.totalAttempts < 0
  ) {
    violations.push(`totalAttempts must be an integer >= 0, received ${String(snapshot.totalAttempts)}`);
  }

  if (snapshot.totalAttempts > snapshot.maxAttempts) {
    violations.push(
      `totalAttempts (${snapshot.totalAttempts}) cannot exceed maxAttempts (${snapshot.maxAttempts})`
    );
  }

  // 6. Active Attempt Invariant
  if (snapshot.status === "RUNNING") {
    if (
      snapshot.activeAttemptNumber === null ||
      typeof snapshot.activeAttemptNumber !== "number" ||
      !Number.isInteger(snapshot.activeAttemptNumber) ||
      snapshot.activeAttemptNumber < 1
    ) {
      violations.push("activeAttemptNumber must be an integer >= 1 when Action is RUNNING");
    } else if (snapshot.activeAttemptNumber !== snapshot.totalAttempts) {
      violations.push(
        `activeAttemptNumber (${snapshot.activeAttemptNumber}) must equal totalAttempts (${snapshot.totalAttempts}) when RUNNING`
      );
    }
  } else {
    if (snapshot.activeAttemptNumber !== null) {
      violations.push(`activeAttemptNumber must be null when Action status is '${snapshot.status}'`);
    }
  }

  // 7. Terminal State Consistency
  if (isTerminalActionStatus(snapshot.status)) {
    if (typeof snapshot.completedAt !== "string" || snapshot.completedAt.trim().length === 0) {
      violations.push(`completedAt must be a non-empty ISO timestamp when Action is in terminal status '${snapshot.status}'`);
    }
    if (snapshot.status === "SUCCEEDED") {
      if (snapshot.errorPayload !== null) {
        violations.push("errorPayload must be null when Action SUCCEEDED");
      }
    } else {
      if (snapshot.errorPayload === null || snapshot.errorPayload === undefined) {
        violations.push(`errorPayload must be non-null when Action is in failed status '${snapshot.status}'`);
      }
    }
  } else {
    if (snapshot.completedAt !== null) {
      violations.push(`completedAt must be null when Action is non-terminal status '${snapshot.status}'`);
    }
  }

  // 8. Retrying State Consistency
  if (snapshot.status === "RETRYING") {
    if (snapshot.totalAttempts >= snapshot.maxAttempts) {
      violations.push(
        `Action cannot be in RETRYING state when totalAttempts (${snapshot.totalAttempts}) >= maxAttempts (${snapshot.maxAttempts})`
      );
    }
  }

  // 9. Initial State Consistency
  if (snapshot.status === "CREATED" || snapshot.status === "AUTHORIZED") {
    if (snapshot.totalAttempts !== 0) {
      violations.push(`totalAttempts must be 0 when Action is '${snapshot.status}'`);
    }
    if (snapshot.resultPayload !== null) {
      violations.push(`resultPayload must be null when Action is '${snapshot.status}'`);
    }
    if (snapshot.errorPayload !== null) {
      violations.push(`errorPayload must be null when Action is '${snapshot.status}'`);
    }
  }

  if (violations.length > 0) {
    throw new InvalidActionError(snapshot.actionId ?? "unknown", violations);
  }
}

/**
 * Commands dispatched to transition an Action's lifecycle.
 */
export type ActionCommand =
  | { readonly type: "AUTHORIZE"; readonly now: string }
  | { readonly type: "START_ATTEMPT"; readonly attemptNumber: number; readonly now: string }
  | { readonly type: "SUCCEED"; readonly resultPayload: unknown; readonly now: string }
  | { readonly type: "FAIL"; readonly errorPayload: unknown; readonly now: string }
  | { readonly type: "TIMEOUT"; readonly reason?: unknown; readonly now: string }
  | { readonly type: "CANCEL"; readonly reason?: unknown; readonly now: string }
  | { readonly type: "PREPARE_RETRY"; readonly errorPayload?: unknown; readonly now: string };

/**
 * Pure state machine transition function for Action.
 * Evaluates state transitions and returns the next snapshot along with the corresponding Domain Event.
 */
export function applyActionTransition(
  snapshot: ActionSnapshot,
  command: ActionCommand,
  eventIdGenerator: () => string = () => crypto.randomUUID()
): { nextSnapshot: ActionSnapshot; event: AnyActionEvent } {
  if (isTerminalActionStatus(snapshot.status)) {
    throw new InvalidActionTransitionError(
      snapshot.status,
      command.type,
      `Action is in terminal state '${snapshot.status}' and cannot transition`
    );
  }

  const now = command.now;
  const eventId = eventIdGenerator();

  switch (snapshot.status) {
    case "CREATED": {
      if (command.type === "AUTHORIZE") {
        const nextSnapshot: ActionSnapshot = deepFreeze({
          ...snapshot,
          status: "AUTHORIZED",
          updatedAt: command.now,
        });
        const event: ActionAuthorizedEvent = deepFreeze({
          eventId,
          runId: snapshot.runId,
          timestamp: now,
          eventType: "action.authorized",
          schemaVersion: 1,
          producer: "domain.action_aggregate",
          payload: deepFreeze({
            actionId: snapshot.actionId,
            runId: snapshot.runId,
            sequenceNumber: snapshot.sequenceNumber,
            toolName: snapshot.toolName,
          }),
        });
        return { nextSnapshot, event };
      }
      if (command.type === "FAIL") {
        const nextSnapshot: ActionSnapshot = deepFreeze({
          ...snapshot,
          status: "FAILED",
          errorPayload: command.errorPayload,
          completedAt: command.now,
          updatedAt: command.now,
        });
        const event: ActionFailedEvent = deepFreeze({
          eventId,
          runId: snapshot.runId,
          timestamp: now,
          eventType: "action.failed",
          schemaVersion: 1,
          producer: "domain.action_aggregate",
          payload: deepFreeze({
            actionId: snapshot.actionId,
            runId: snapshot.runId,
            totalAttempts: 0,
            error: command.errorPayload,
          }),
        });
        return { nextSnapshot, event };
      }
      if (command.type === "CANCEL") {
        const reason = command.reason ?? "Action cancelled before authorization";
        const nextSnapshot: ActionSnapshot = deepFreeze({
          ...snapshot,
          status: "CANCELLED",
          errorPayload: reason,
          completedAt: command.now,
          updatedAt: command.now,
        });
        const event: ActionCancelledEvent = deepFreeze({
          eventId,
          runId: snapshot.runId,
          timestamp: now,
          eventType: "action.cancelled",
          schemaVersion: 1,
          producer: "domain.action_aggregate",
          payload: deepFreeze({
            actionId: snapshot.actionId,
            runId: snapshot.runId,
            reason,
          }),
        });
        return { nextSnapshot, event };
      }
      throw new InvalidActionTransitionError(snapshot.status, command.type);
    }

    case "AUTHORIZED": {
      if (command.type === "START_ATTEMPT") {
        if (command.attemptNumber !== 1) {
          throw new InvalidActionTransitionError(
            snapshot.status,
            command.type,
            `Initial attempt from AUTHORIZED state must have attemptNumber 1, received ${command.attemptNumber}`
          );
        }
        const nextSnapshot: ActionSnapshot = deepFreeze({
          ...snapshot,
          status: "RUNNING",
          activeAttemptNumber: 1,
          totalAttempts: 1,
          updatedAt: command.now,
        });
        const event: ActionStartedEvent = deepFreeze({
          eventId,
          runId: snapshot.runId,
          timestamp: now,
          eventType: "action.started",
          schemaVersion: 1,
          producer: "domain.action_aggregate",
          payload: deepFreeze({
            actionId: snapshot.actionId,
            runId: snapshot.runId,
            attemptNumber: 1,
          }),
        });
        return { nextSnapshot, event };
      }
      if (command.type === "FAIL") {
        const nextSnapshot: ActionSnapshot = deepFreeze({
          ...snapshot,
          status: "FAILED",
          errorPayload: command.errorPayload,
          completedAt: command.now,
          updatedAt: command.now,
        });
        const event: ActionFailedEvent = deepFreeze({
          eventId,
          runId: snapshot.runId,
          timestamp: now,
          eventType: "action.failed",
          schemaVersion: 1,
          producer: "domain.action_aggregate",
          payload: deepFreeze({
            actionId: snapshot.actionId,
            runId: snapshot.runId,
            totalAttempts: 0,
            error: command.errorPayload,
          }),
        });
        return { nextSnapshot, event };
      }
      if (command.type === "CANCEL") {
        const reason = command.reason ?? "Action cancelled before attempt";
        const nextSnapshot: ActionSnapshot = deepFreeze({
          ...snapshot,
          status: "CANCELLED",
          errorPayload: reason,
          completedAt: command.now,
          updatedAt: command.now,
        });
        const event: ActionCancelledEvent = deepFreeze({
          eventId,
          runId: snapshot.runId,
          timestamp: now,
          eventType: "action.cancelled",
          schemaVersion: 1,
          producer: "domain.action_aggregate",
          payload: deepFreeze({
            actionId: snapshot.actionId,
            runId: snapshot.runId,
            reason,
          }),
        });
        return { nextSnapshot, event };
      }
      throw new InvalidActionTransitionError(snapshot.status, command.type);
    }

    case "RUNNING": {
      if (command.type === "SUCCEED") {
        const nextSnapshot: ActionSnapshot = deepFreeze({
          ...snapshot,
          status: "SUCCEEDED",
          resultPayload: command.resultPayload,
          errorPayload: null,
          activeAttemptNumber: null,
          completedAt: command.now,
          updatedAt: command.now,
        });
        const event: ActionCompletedEvent = deepFreeze({
          eventId,
          runId: snapshot.runId,
          timestamp: now,
          eventType: "action.completed",
          schemaVersion: 1,
          producer: "domain.action_aggregate",
          payload: deepFreeze({
            actionId: snapshot.actionId,
            runId: snapshot.runId,
            totalAttempts: snapshot.totalAttempts,
            resultPayload: command.resultPayload,
          }),
        });
        return { nextSnapshot, event };
      }
      if (command.type === "FAIL") {
        const nextSnapshot: ActionSnapshot = deepFreeze({
          ...snapshot,
          status: "FAILED",
          errorPayload: command.errorPayload,
          activeAttemptNumber: null,
          completedAt: command.now,
          updatedAt: command.now,
        });
        const event: ActionFailedEvent = deepFreeze({
          eventId,
          runId: snapshot.runId,
          timestamp: now,
          eventType: "action.failed",
          schemaVersion: 1,
          producer: "domain.action_aggregate",
          payload: deepFreeze({
            actionId: snapshot.actionId,
            runId: snapshot.runId,
            totalAttempts: snapshot.totalAttempts,
            error: command.errorPayload,
          }),
        });
        return { nextSnapshot, event };
      }
      if (command.type === "TIMEOUT") {
        const reason = command.reason ?? "Action execution timed out";
        const nextSnapshot: ActionSnapshot = deepFreeze({
          ...snapshot,
          status: "TIMED_OUT",
          errorPayload: reason,
          activeAttemptNumber: null,
          completedAt: command.now,
          updatedAt: command.now,
        });
        const event: ActionTimedOutEvent = deepFreeze({
          eventId,
          runId: snapshot.runId,
          timestamp: now,
          eventType: "action.timed_out",
          schemaVersion: 1,
          producer: "domain.action_aggregate",
          payload: deepFreeze({
            actionId: snapshot.actionId,
            runId: snapshot.runId,
            totalAttempts: snapshot.totalAttempts,
            reason,
          }),
        });
        return { nextSnapshot, event };
      }
      if (command.type === "CANCEL") {
        const reason = command.reason ?? "Action cancelled during execution";
        const nextSnapshot: ActionSnapshot = deepFreeze({
          ...snapshot,
          status: "CANCELLED",
          errorPayload: reason,
          activeAttemptNumber: null,
          completedAt: command.now,
          updatedAt: command.now,
        });
        const event: ActionCancelledEvent = deepFreeze({
          eventId,
          runId: snapshot.runId,
          timestamp: now,
          eventType: "action.cancelled",
          schemaVersion: 1,
          producer: "domain.action_aggregate",
          payload: deepFreeze({
            actionId: snapshot.actionId,
            runId: snapshot.runId,
            reason,
          }),
        });
        return { nextSnapshot, event };
      }
      if (command.type === "PREPARE_RETRY") {
        if (snapshot.totalAttempts >= snapshot.maxAttempts) {
          throw new InvalidActionTransitionError(
            snapshot.status,
            command.type,
            `Cannot retry: totalAttempts (${snapshot.totalAttempts}) reached maxAttempts ceiling (${snapshot.maxAttempts})`
          );
        }
        const nextSnapshot: ActionSnapshot = deepFreeze({
          ...snapshot,
          status: "RETRYING",
          activeAttemptNumber: null,
          errorPayload: command.errorPayload ?? null,
          updatedAt: command.now,
        });
        const event: ActionRetryingEvent = deepFreeze({
          eventId,
          runId: snapshot.runId,
          timestamp: now,
          eventType: "action.retrying",
          schemaVersion: 1,
          producer: "domain.action_aggregate",
          payload: deepFreeze({
            actionId: snapshot.actionId,
            runId: snapshot.runId,
            attemptNumber: snapshot.totalAttempts,
            nextAttemptNumber: snapshot.totalAttempts + 1,
            maxAttempts: snapshot.maxAttempts,
            error: command.errorPayload ?? null,
          }),
        });
        return { nextSnapshot, event };
      }
      throw new InvalidActionTransitionError(snapshot.status, command.type);
    }

    case "RETRYING": {
      if (command.type === "START_ATTEMPT") {
        const expectedAttempt = snapshot.totalAttempts + 1;
        if (command.attemptNumber !== expectedAttempt) {
          throw new InvalidActionTransitionError(
            snapshot.status,
            command.type,
            `Next attempt from RETRYING must be attemptNumber ${expectedAttempt}, received ${command.attemptNumber}`
          );
        }
        if (command.attemptNumber > snapshot.maxAttempts) {
          throw new InvalidActionTransitionError(
            snapshot.status,
            command.type,
            `Cannot start attempt ${command.attemptNumber}: exceeds maxAttempts (${snapshot.maxAttempts})`
          );
        }
        const nextSnapshot: ActionSnapshot = deepFreeze({
          ...snapshot,
          status: "RUNNING",
          activeAttemptNumber: command.attemptNumber,
          totalAttempts: command.attemptNumber,
          updatedAt: command.now,
        });
        const event: ActionStartedEvent = deepFreeze({
          eventId,
          runId: snapshot.runId,
          timestamp: now,
          eventType: "action.started",
          schemaVersion: 1,
          producer: "domain.action_aggregate",
          payload: deepFreeze({
            actionId: snapshot.actionId,
            runId: snapshot.runId,
            attemptNumber: command.attemptNumber,
          }),
        });
        return { nextSnapshot, event };
      }
      if (command.type === "FAIL") {
        const nextSnapshot: ActionSnapshot = deepFreeze({
          ...snapshot,
          status: "FAILED",
          errorPayload: command.errorPayload,
          activeAttemptNumber: null,
          completedAt: command.now,
          updatedAt: command.now,
        });
        const event: ActionFailedEvent = deepFreeze({
          eventId,
          runId: snapshot.runId,
          timestamp: now,
          eventType: "action.failed",
          schemaVersion: 1,
          producer: "domain.action_aggregate",
          payload: deepFreeze({
            actionId: snapshot.actionId,
            runId: snapshot.runId,
            totalAttempts: snapshot.totalAttempts,
            error: command.errorPayload,
          }),
        });
        return { nextSnapshot, event };
      }
      if (command.type === "CANCEL") {
        const reason = command.reason ?? "Action cancelled during retry wait";
        const nextSnapshot: ActionSnapshot = deepFreeze({
          ...snapshot,
          status: "CANCELLED",
          errorPayload: reason,
          activeAttemptNumber: null,
          completedAt: command.now,
          updatedAt: command.now,
        });
        const event: ActionCancelledEvent = deepFreeze({
          eventId,
          runId: snapshot.runId,
          timestamp: now,
          eventType: "action.cancelled",
          schemaVersion: 1,
          producer: "domain.action_aggregate",
          payload: deepFreeze({
            actionId: snapshot.actionId,
            runId: snapshot.runId,
            reason,
          }),
        });
        return { nextSnapshot, event };
      }
      throw new InvalidActionTransitionError(snapshot.status, command.type);
    }

    default:
      throw new InvalidActionTransitionError(snapshot.status, (command as any).type);
  }
}

/**
 * Pure evaluation of retry eligibility for an Action.
 * Does not execute retry; answers whether an Action can logically proceed to another Attempt.
 */
export interface RetryEligibilityResult {
  readonly eligible: boolean;
  readonly reasonCode:
    | "ELIGIBLE"
    | "TERMINAL_STATE"
    | "MAX_ATTEMPTS_EXHAUSTED"
    | "NON_IDEMPOTENT_UNKNOWN"
    | "NON_IDEMPOTENT_FAILED"
    | "ALREADY_SUCCEEDED"
    | "ATTEMPT_STILL_ACTIVE"
    | "INVALID_ACTION_STATE";
  readonly message: string;
}

export function evaluateRetryEligibility(
  action: ActionSnapshot,
  lastAttempt?: { readonly status: string }
): RetryEligibilityResult {
  if (isTerminalActionStatus(action.status)) {
    return {
      eligible: false,
      reasonCode: "TERMINAL_STATE",
      message: `Action is already in terminal state '${action.status}'`,
    };
  }

  if (action.totalAttempts >= action.maxAttempts) {
    return {
      eligible: false,
      reasonCode: "MAX_ATTEMPTS_EXHAUSTED",
      message: `Action has exhausted maximum attempts (${action.totalAttempts}/${action.maxAttempts})`,
    };
  }

  if (action.status === "RUNNING" && action.activeAttemptNumber !== null) {
    return {
      eligible: false,
      reasonCode: "ATTEMPT_STILL_ACTIVE",
      message: `Action has an active attempt running (#${action.activeAttemptNumber})`,
    };
  }

  if (lastAttempt) {
    if (lastAttempt.status === "SUCCEEDED") {
      return {
        eligible: false,
        reasonCode: "ALREADY_SUCCEEDED",
        message: "Action attempt already succeeded",
      };
    }

    if (lastAttempt.status === "UNKNOWN") {
      if (action.idempotency === "NON_IDEMPOTENT") {
        return {
          eligible: false,
          reasonCode: "NON_IDEMPOTENT_UNKNOWN",
          message:
            "Non-idempotent action in UNKNOWN state cannot be automatically retried (fail-closed on execution uncertainty)",
        };
      }
      return {
        eligible: true,
        reasonCode: "ELIGIBLE",
        message: "Idempotent action in UNKNOWN state is potentially eligible for retry",
      };
    }

    if (lastAttempt.status === "FAILED" || lastAttempt.status === "TIMED_OUT") {
      if (action.idempotency === "NON_IDEMPOTENT") {
        return {
          eligible: false,
          reasonCode: "NON_IDEMPOTENT_FAILED",
          message: "Non-idempotent action cannot be automatically retried after failure",
        };
      }
      return {
        eligible: true,
        reasonCode: "ELIGIBLE",
        message: "Idempotent action failure is eligible for retry",
      };
    }
  }

  if (action.status === "RETRYING" && action.idempotency === "IDEMPOTENT") {
    return {
      eligible: true,
      reasonCode: "ELIGIBLE",
      message: "Action is in RETRYING state and has remaining attempts",
    };
  }

  return {
    eligible: false,
    reasonCode: "INVALID_ACTION_STATE",
    message: `Action in status '${action.status}' is not eligible for retry`,
  };
}

export interface CreateActionParams {
  readonly actionId?: string;
  readonly runId: string;
  readonly sequenceNumber: number;
  readonly toolName: ExtendedToolName;
  readonly inputPayload: unknown;
  readonly inputHash?: string;
  readonly contractBinding: ContractBinding;
  readonly maxAttempts?: number;
  readonly now?: string;
}

/**
 * Action Aggregate Root.
 * Encapsulates the logical unit of work and enforces monotonic sequence,
 * input integrity, and deterministic state transitions.
 */
export class Action {
  private _snapshot: ActionSnapshot;
  private readonly _eventIdGenerator: () => string;

  private constructor(
    snapshot: ActionSnapshot,
    eventIdGenerator: () => string = () => crypto.randomUUID()
  ) {
    validateActionInvariants(snapshot);
    this._snapshot = deepFreeze({ ...snapshot });
    this._eventIdGenerator = eventIdGenerator;
  }

  /**
   * Factory method to create a new Action aggregate in CREATED state.
   * Returns both the new Action aggregate and its ActionCreatedEvent.
   */
  static create(
    params: CreateActionParams,
    eventIdGenerator: () => string = () => crypto.randomUUID()
  ): { action: Action; event: ActionCreatedEvent } {
    const now = params.now ?? new Date().toISOString();
    const actionId = params.actionId ?? crypto.randomUUID();
    const contractBinding = createContractBinding(params.contractBinding);

    if (!isValidToolName(params.toolName)) {
      throw new InvalidActionError(actionId, [`Invalid toolName '${String(params.toolName)}'`]);
    }
    const idempotency = TOOL_IDEMPOTENCY_MAP[params.toolName];

    const computed = computeCanonicalHash(params.inputPayload);
    const inputHash = params.inputHash ?? computed.contentHash;

    const maxAttempts = params.maxAttempts ?? 3;

    const snapshot: ActionSnapshot = {
      actionId,
      runId: params.runId,
      sequenceNumber: params.sequenceNumber,
      toolName: params.toolName,
      inputPayload: params.inputPayload,
      inputHash,
      idempotency,
      contractBinding,
      maxAttempts,
      createdAt: now,
      status: "CREATED",
      activeAttemptNumber: null,
      totalAttempts: 0,
      resultPayload: null,
      errorPayload: null,
      updatedAt: now,
      completedAt: null,
    };

    validateActionInvariants(snapshot);

    const event: ActionCreatedEvent = deepFreeze({
      eventId: eventIdGenerator(),
      runId: params.runId,
      timestamp: now,
      eventType: "action.created",
      schemaVersion: 1,
      producer: "domain.action_aggregate",
      payload: deepFreeze({
        actionId,
        runId: params.runId,
        sequenceNumber: params.sequenceNumber,
        toolName: params.toolName,
        inputHash,
        idempotency,
        contractBinding: { ...contractBinding },
        maxAttempts,
      }),
    });

    const action = new Action(snapshot, eventIdGenerator);
    return { action, event };
  }

  /**
   * Reconstitutes an Action aggregate from a persisted snapshot.
   */
  static reconstitute(
    snapshot: ActionSnapshot,
    eventIdGenerator: () => string = () => crypto.randomUUID()
  ): Action {
    return new Action(snapshot, eventIdGenerator);
  }

  get snapshot(): ActionSnapshot {
    return this._snapshot;
  }

  get actionId(): string {
    return this._snapshot.actionId;
  }

  get runId(): string {
    return this._snapshot.runId;
  }

  get sequenceNumber(): number {
    return this._snapshot.sequenceNumber;
  }

  get toolName(): ExtendedToolName {
    return this._snapshot.toolName;
  }

  get inputPayload(): unknown {
    return this._snapshot.inputPayload;
  }

  get inputHash(): string {
    return this._snapshot.inputHash;
  }

  get idempotency(): ToolIdempotency {
    return this._snapshot.idempotency;
  }

  get contractBinding(): ContractBinding {
    return this._snapshot.contractBinding;
  }

  get maxAttempts(): number {
    return this._snapshot.maxAttempts;
  }

  get status(): ActionStatus {
    return this._snapshot.status;
  }

  get activeAttemptNumber(): number | null {
    return this._snapshot.activeAttemptNumber;
  }

  get totalAttempts(): number {
    return this._snapshot.totalAttempts;
  }

  get resultPayload(): unknown | null {
    return this._snapshot.resultPayload;
  }

  get errorPayload(): unknown | null {
    return this._snapshot.errorPayload;
  }

  get createdAt(): string {
    return this._snapshot.createdAt;
  }

  get updatedAt(): string {
    return this._snapshot.updatedAt;
  }

  get completedAt(): string | null {
    return this._snapshot.completedAt;
  }

  private executeCommand<TEvent extends AnyActionEvent>(command: ActionCommand): TEvent {
    const result = applyActionTransition(this._snapshot, command, this._eventIdGenerator);
    validateActionInvariants(result.nextSnapshot);
    this._snapshot = result.nextSnapshot;
    return result.event as TEvent;
  }

  authorize(now?: string): ActionAuthorizedEvent {
    return this.executeCommand<ActionAuthorizedEvent>({
      type: "AUTHORIZE",
      now: now ?? new Date().toISOString(),
    });
  }

  startAttempt(attemptNumber: number, now?: string): ActionStartedEvent {
    return this.executeCommand<ActionStartedEvent>({
      type: "START_ATTEMPT",
      attemptNumber,
      now: now ?? new Date().toISOString(),
    });
  }

  succeed(resultPayload: unknown, now?: string): ActionCompletedEvent {
    return this.executeCommand<ActionCompletedEvent>({
      type: "SUCCEED",
      resultPayload,
      now: now ?? new Date().toISOString(),
    });
  }

  fail(errorPayload: unknown, now?: string): ActionFailedEvent {
    return this.executeCommand<ActionFailedEvent>({
      type: "FAIL",
      errorPayload,
      now: now ?? new Date().toISOString(),
    });
  }

  timeout(reason?: unknown, now?: string): ActionTimedOutEvent {
    return this.executeCommand<ActionTimedOutEvent>({
      type: "TIMEOUT",
      reason,
      now: now ?? new Date().toISOString(),
    });
  }

  cancel(reason?: unknown, now?: string): ActionCancelledEvent {
    return this.executeCommand<ActionCancelledEvent>({
      type: "CANCEL",
      reason,
      now: now ?? new Date().toISOString(),
    });
  }

  prepareRetry(errorPayload?: unknown, now?: string): ActionRetryingEvent {
    return this.executeCommand<ActionRetryingEvent>({
      type: "PREPARE_RETRY",
      errorPayload,
      now: now ?? new Date().toISOString(),
    });
  }
}
