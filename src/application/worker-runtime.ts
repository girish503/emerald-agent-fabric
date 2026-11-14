import { LeaseRenewalLoop, LeaseRenewalOptions, validateLeaseRenewalConfig } from "./lease-renewal.js";
import { DockerExecutionProvider } from "../adapters/execution/docker-execution-provider.js";
import { InProcessExecutionProvider } from "../adapters/execution/in-process-execution-provider.js";
import { createWorkspaceToolAdapterRegistry } from "../adapters/tools/tool-adapter-registry.factory.js";
import {
  Action,
  ActionSnapshot,
  evaluateRetryEligibility,
  isTerminalActionStatus,
} from "../domain/action.js";
import {
  Attempt,
  AttemptSnapshot,
  createAttemptIdempotencyToken,
  isTerminalAttemptStatus,
} from "../domain/attempt.js";
import { AttemptUnknownReason, type ArtifactExportSummary, type RepositoryImportSummary } from "../domain/events.js";
import { ArtifactExportError, type ArtifactExporterPort } from "../ports/artifact-exporter.port.js";
import type { RepositoryImporterPort } from "../ports/repository-importer.port.js";
import { computeCanonicalHash } from "../domain/canonical-hash.js";
import {
  ContractIntegrityError,
  InvalidExecutionProviderRoleError,
  InvalidContractBindingError,
  InvalidMissionContractError,
  InvalidRunError,
  LeaseExpiredError,
  LeaseLostError,
  MissingBoundContractError,
  ResourceLimitExceededError,
  TerminalStateError,
  WorkspaceOwnershipError,
} from "../domain/errors.js";
import {
  createOutputPayloadEvidence,
  createProcessExitEvidence,
  Evidence,
} from "../domain/evidence.js";
import { MissionContract } from "../domain/mission-contract.js";
import { DeterministicOperation, EchoOperation } from "../domain/operation.js";
import {
  evaluateWorkloadExecutionRouting,
  ExecutionPolicy,
  IsolationRequirement,
  PolicyEvaluator,
  WorkloadTrustClassification,
} from "../domain/policy.js";
import {
  ExtendedToolName,
  ToolRequest,
  ToolResult,
} from "../domain/tool.js";
import { DeterministicVerifier, VerificationSpec } from "../domain/verification.js";
import { Workspace } from "../domain/workspace.js";
import { ClockPort, SystemClock } from "../ports/clock.port.js";
import { ExecutionProvider, ExecutionRequest, ExecutionResult, resolveProviderRole } from "../ports/execution-provider.port.js";
import { resolveProviderTenantModel } from "../ports/tenant-quiescence.port.js";
import type { TenantLaunchCoordinatorPort, TenantLaunchGate } from "../ports/tenant-launch-coordinator.port.js";
import { SqliteTenantLaunchCoordinator, InMemoryTenantLaunchCoordinator } from "../adapters/coordination/sqlite-tenant-launch-coordinator.js";
import { LeaseFencingCheck, StateStorePort, WorkerRecord } from "../ports/state-store.port.js";
import { ToolAdapterRegistryPort } from "../ports/tool-adapter.port.js";
import { MutationIntentStorePort } from "../ports/mutation-intent-store.port.js";
import { ToolRegistryPort } from "../ports/tool-registry.port.js";
import { WorkspaceHandle, WorkspacePort } from "../ports/workspace.port.js";
import {
  ClaimRunResult,
  RunCoordinator,
  StaleExecutionRecoveryOptions,
  StaleExecutionRecoveryResult,
} from "./run-coordinator.js";
import {
  ToolExecutionGateway,
  TrustedToolInvocationContext,
} from "./tool-execution-gateway.js";
import { defaultGovernedToolRegistry } from "../domain/tool.js";
import {
  createWorkspaceToolConnectorService,
  type GovernedToolConnectorService,
} from "./governed-tool-connector.js";
import { ApprovalControl } from "../control-plane/approval-control.js";
import { ScopedContextMemoryService } from "./scoped-context-memory.js";
import { EmeraldLifecycleTelemetry } from "./observability-instrumentation.js";
import {
  BoundedRepairLoopController,
  type RepairCycleState,
} from "./bounded-repair-loop.js";
import type { ObservabilityPort, TelemetrySpanRecord } from "../ports/observability.port.js";
import type { ProductionRepairOrchestrator } from "../production/repair/repair-orchestrator.js";

/**
 * Structural check establishing whether an object is a state store capable of durable launch gate operations.
 * Fails closed if the store does not structurally provide the required gate and transaction methods.
 */
export function isDurableLaunchGateStore(store: unknown): store is StateStorePort {
  return (
    typeof store === "object" &&
    store !== null &&
    typeof (store as any).acquireTenantLaunchGate === "function" &&
    typeof (store as any).releaseTenantLaunchGate === "function" &&
    typeof (store as any).getTenantLaunchGate === "function" &&
    typeof (store as any).transaction === "function"
  );
}

/**
 * Structural check extracting the backing state store from a tenant launch coordinator.
 */
export function getLaunchCoordinatorStore(
  coordinator: TenantLaunchCoordinatorPort
): StateStorePort | undefined {
  const store =
    (coordinator as any).store ??
    (coordinator as any).getStore?.() ??
    (coordinator as any).getStateStore?.();
  return typeof store === "object" && store !== null ? store : undefined;
}

export type WorkerRunResult =
  | { readonly status: "IDLE" }
  | { readonly status: "COMPLETED"; readonly runId: string; readonly output: unknown }
  | { readonly status: "FAILED"; readonly runId: string; readonly error: unknown }
  | { readonly status: "TIMED_OUT"; readonly runId: string; readonly error: unknown }
  | { readonly status: "CANCELLED"; readonly runId: string; readonly error: unknown }
  /**
   * The provider could not prove its tenant processes are gone after a timeout/cancel/limit stop. No terminal
   * transition is written and the workspace is untouched: heartbeats stop, the lease lapses, and the recovery
   * sweeper's quiescence pre-pass (ADR-0037/0038) owns the run from there.
   */
  | { readonly status: "TERMINATION_UNVERIFIED"; readonly runId: string; readonly error: unknown }
  | {
      readonly status: "WAITING_APPROVAL";
      readonly runId: string;
      readonly approvalId: string;
      readonly operation: string;
    }
  | { readonly status: "FENCED"; readonly runId: string; readonly error: LeaseLostError | LeaseExpiredError };

export type WorkerActionStatus =
  | "SUCCEEDED"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELLED"
  | "UNKNOWN"
  | "FENCED";

/** Error code returned when the Tier-1 replay gate refuses to dispatch a NON_IDEMPOTENT action. */
export const REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT = "REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT";

/**
 * Error code returned when a NON_IDEMPOTENT Action is re-entered while its own Attempt is already
 * past CREATED. The earlier dispatch may have produced a side effect, so it is not repeated.
 *
 * Result semantics: the returned `FAILED` status describes this call only (nothing was dispatched). It is
 * NOT a terminal outcome of the Action. The durable Action and Attempt are left exactly as they were
 * (typically RUNNING); nothing is marked UNKNOWN or terminal here, because that needs recovery evidence
 * rather than a caller's retry. Callers must not retry, count it as a tool failure of the Action, or
 * report completion from it. Resolution belongs to recovery (RunCoordinator.recoverStaleExecutions or
 * recoverMission), which records the Attempt as UNKNOWN and the Action as FAILED/EXECUTION_UNCERTAIN.
 * The runtime's own callers (agent step controller, verification stage, clean-room verifier) always
 * create a fresh Action and so cannot reach this result.
 */
export const RESUME_BLOCKED_PRIOR_DISPATCH = "RESUME_BLOCKED_PRIOR_DISPATCH";

interface UncertainPriorAttempt {
  readonly actionId: string;
  readonly attemptId: string;
  readonly attemptStatus: string;
  readonly reasonCode: string;
}

/**
 * Finds a prior Action with the same (toolName, inputHash) in the run that has an UNKNOWN attempt, or an
 * attempt that is still non-terminal (fail-closed: in-flight is never assumed to have stopped).
 */
function findUncertainPriorAttempt(
  actions: readonly ActionSnapshot[],
  getAttempts: (actionId: string) => readonly AttemptSnapshot[],
  candidate: ActionSnapshot
): UncertainPriorAttempt | null {
  for (const prior of actions) {
    if (
      prior.actionId === candidate.actionId ||
      prior.toolName !== candidate.toolName ||
      prior.inputHash !== candidate.inputHash
    ) {
      continue;
    }
    for (const attempt of getAttempts(prior.actionId)) {
      const unknown = attempt.status === "UNKNOWN";
      if (!unknown && isTerminalAttemptStatus(attempt.status)) {
        continue;
      }
      const payload = attempt.errorPayload as { reasonCode?: unknown } | null;
      return {
        actionId: prior.actionId,
        attemptId: attempt.attemptId,
        attemptStatus: attempt.status,
        reasonCode:
          unknown && typeof payload?.reasonCode === "string"
            ? payload.reasonCode
            : unknown
              ? "UNSPECIFIED_EXECUTION_UNCERTAINTY"
              : "ATTEMPT_NOT_TERMINAL",
      };
    }
  }
  return null;
}

/**
 * Returns the structured, non-sensitive metadata of a Tier-1 replay-block result, or null when the
 * result is not a replay block. Recognition uses only the structured status and error code (never
 * message text). Only fields actually present as strings are returned; nothing is fabricated and no
 * input payload is ever read.
 */
export function extractReplayBlockDetails(
  result: Pick<WorkerActionResult, "status" | "error">
): Record<string, string> | null {
  const error = result.error as
    | { code?: unknown; details?: Record<string, unknown> | null }
    | null
    | undefined;
  if (
    result.status !== "FAILED" ||
    !error ||
    typeof error !== "object" ||
    error.code !== REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT
  ) {
    return null;
  }
  const out: Record<string, string> = {};
  const details = error.details && typeof error.details === "object" ? error.details : {};
  for (const key of [
    "toolName",
    "priorActionId",
    "priorAttemptId",
    "priorAttemptStatus",
    "priorReasonCode",
  ]) {
    const value = details[key];
    if (typeof value === "string" && value.length > 0) {
      out[key] = value;
    }
  }
  return out;
}

export interface WorkerActionResult {
  readonly status: WorkerActionStatus;
  readonly actionId: string;
  readonly runId: string;
  readonly attemptId?: string;
  readonly output?: unknown;
  readonly error?: unknown;
  readonly action?: ActionSnapshot | null;
  readonly attempt?: AttemptSnapshot | null;
}

export interface WorkerStaleRecoveryResult {
  readonly coordinatorResult: StaleExecutionRecoveryResult;
  readonly retriedActions: readonly WorkerActionResult[];
}

export interface ExecuteActionParams {
  readonly runId: string;
  readonly actionId?: string;
  readonly sequenceNumber?: number;
  readonly toolName?: ExtendedToolName;
  readonly inputPayload?: unknown;
  readonly maxAttempts?: number;
  readonly leaseId?: string;
  readonly workspace?: {
    readonly workspaceId: string;
    readonly hostPath: string;
    readonly containerMountPath?: string;
  };
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly abortSignal?: AbortSignal;
  readonly throwOnError?: boolean;
  readonly autoRetry?: boolean;
  readonly speculativeBinding?: import("../domain/runtime-speculative-binding.js").RuntimeSpeculativeBinding;
  readonly systemVerificationSpecId?: string;
}

export interface WorkerRuntimeOptions {
  readonly workerId?: string;
  readonly hostname?: string;
  readonly pid?: number;
  readonly coordinator: RunCoordinator;
  readonly clock?: ClockPort;
  readonly leaseTtlMs?: number;
  /** Tuning for the lease-renewal heartbeat that runs while a claimed run executes. */
  readonly leaseRenewal?: LeaseRenewalOptions;
  readonly executionProvider?: ExecutionProvider;
  /**
   * Physical execution provider dedicated to executing concrete commands (e.g. Docker, InProcess)
   * for workspace tools (e.g. SandboxedCommandToolAdapter).
   *
   * When options.executionProvider is an ORCHESTRATION provider (such as GovernedAgentExecutionProvider),
   * physical command execution is delegated to this provider instead of recursively re-entering
   * the orchestration loop.
   */
  readonly physicalExecutionProvider?: ExecutionProvider;
  readonly operations?: readonly DeterministicOperation[] | DeterministicOperation;
  readonly workspacePort?: WorkspacePort;
  /**
   * @deprecated Non-authoritative for governed Runs.
   * Supplying ephemeral policy options on a governed Run is rejected.
   */
  readonly policy?: ExecutionPolicy;
  readonly policyEvaluator?: PolicyEvaluator;
  readonly isIsolationAvailable?: boolean | (() => Promise<boolean>);
  /**
   * @deprecated Non-authoritative for governed Runs.
   * Supplying ephemeral verificationSpec options on a governed Run is rejected.
   */
  readonly verificationSpec?:
    | VerificationSpec
    | ((request: ExecutionRequest) => VerificationSpec | undefined);
  readonly toolGateway?: ToolExecutionGateway;
  readonly toolAdapterRegistry?: ToolAdapterRegistryPort;
  readonly toolRegistry?: ToolRegistryPort;
  readonly mutationStore?: MutationIntentStorePort;
  /** ADR-0038: Optional launch coordinator for closing the late-start tenant race. */
  readonly launchCoordinator?: TenantLaunchCoordinatorPort;
  readonly launchGateTimeoutMs?: number;
  /**
   * Copies a task's requested repository (inputPayload.repositoryPath) into the run workspace. Without an
   * importer, a task that requests a repository fails closed instead of running on an empty workspace.
   */
  readonly repositoryImporter?: RepositoryImporterPort;
  /**
   * Preserves a run's workspace changes (patch + manifest) before the workspace is disposed. When set, a
   * baseline is captured before the agent runs; a failed baseline fails the run, and a failed export
   * preserves the workspace and fails the run instead of reporting success.
   */
  readonly artifactExporter?: ArtifactExporterPort;
  readonly connectorService?: GovernedToolConnectorService;
  readonly approvalControl?: ApprovalControl;
  readonly enableApprovalGate?: boolean;
  readonly scopedMemory?: ScopedContextMemoryService;
  readonly telemetry?: EmeraldLifecycleTelemetry;
  readonly observabilityPort?: ObservabilityPort;
  readonly repairController?: BoundedRepairLoopController;
  readonly repairOrchestrator?: ProductionRepairOrchestrator;
}

/**
 * WorkerRuntime is a single-worker deterministic execution unit.
 *
 * Boundary Responsibilities:
 * - Owns run claiming, worker lease heartbeats, and lifecycle state transitions.
 * - Enforces MissionContract governance, authorization, and integrity before dispatch.
 * - Delegates actual computation to an ExecutionProvider only when authorized.
 * - Translates execution results into RunCoordinator transitions (complete, fail, timeout).
 * - Enforces fencing tokens and safely handles lease theft / loss.
 */
export class WorkerRuntime {
  readonly workerId: string;
  readonly hostname: string;
  readonly pid: number;
  private readonly coordinator: RunCoordinator;
  private readonly clock: ClockPort;
  private readonly leaseTtlMs: number;
  private readonly leaseRenewalOptions?: LeaseRenewalOptions;
  private readonly executionProvider: ExecutionProvider;
  private readonly physicalExecutionProvider?: ExecutionProvider;
  private readonly workspacePort?: WorkspacePort;
  private readonly ephemeralPolicy?: ExecutionPolicy;
  private readonly ephemeralVerificationSpec?:
    | VerificationSpec
    | ((request: ExecutionRequest) => VerificationSpec | undefined);
  private readonly policyEvaluator: PolicyEvaluator;
  private readonly isIsolationAvailableProbe?: boolean | (() => Promise<boolean>);
  private readonly toolGateway: ToolExecutionGateway;
  private readonly launchCoordinator: TenantLaunchCoordinatorPort;
  private readonly launchGateTimeoutMs?: number;
  private readonly repositoryImporter?: RepositoryImporterPort;
  private readonly artifactExporter?: ArtifactExporterPort;
  private readonly connectorService?: GovernedToolConnectorService;
  private readonly approvalControl?: ApprovalControl;
  private readonly scopedMemory?: ScopedContextMemoryService;
  private readonly telemetry?: EmeraldLifecycleTelemetry;
  public readonly observability?: ObservabilityPort;
  private readonly repairController?: BoundedRepairLoopController;
  private readonly repairOrchestrator?: ProductionRepairOrchestrator;
  private readonly runWorkspaces = new Map<
    string,
    { workspaceId: string; hostPath: string; containerMountPath?: string }
  >();

  constructor(options: WorkerRuntimeOptions) {
    this.workerId = options.workerId ?? crypto.randomUUID();
    this.hostname = options.hostname ?? "localhost";
    this.pid = options.pid ?? (typeof process !== "undefined" && process.pid ? process.pid : 1);
    this.coordinator = options.coordinator;
    this.clock = options.clock ?? new SystemClock();
    this.launchGateTimeoutMs = options.launchGateTimeoutMs;
    this.repositoryImporter = options.repositoryImporter;
    this.artifactExporter = options.artifactExporter;
    this.observability = options.observabilityPort ?? options.telemetry?.observability;
    this.telemetry =
      options.telemetry ??
      (this.observability ? new EmeraldLifecycleTelemetry(this.observability) : undefined);
    this.repairController = options.repairController;
    this.repairOrchestrator = options.repairOrchestrator;
    const coordinatorStoreForServices = this.coordinator.store;
    this.approvalControl =
      options.approvalControl ??
      (options.enableApprovalGate !== false && coordinatorStoreForServices?.insertApprovalRequest
        ? new ApprovalControl(this.clock, coordinatorStoreForServices, true)
        : undefined);
    this.scopedMemory =
      options.scopedMemory ??
      (coordinatorStoreForServices &&
      typeof (coordinatorStoreForServices as any).getScopedMemoryStore === "function"
        ? new ScopedContextMemoryService((coordinatorStoreForServices as any).getScopedMemoryStore(), {
            clock: this.clock,
            telemetry: this.telemetry,
          })
        : undefined);
    this.launchCoordinator =
      options.launchCoordinator ??
      (this.coordinator.store
        ? new SqliteTenantLaunchCoordinator(this.coordinator.store, this.clock)
        : new InMemoryTenantLaunchCoordinator(this.clock));
    this.leaseTtlMs = options.leaseTtlMs ?? 10000;
    this.leaseRenewalOptions = options.leaseRenewal;
    // Fail at construction, not after a run has been claimed.
    validateLeaseRenewalConfig(this.leaseTtlMs, this.leaseRenewalOptions);
    this.policyEvaluator = options.policyEvaluator ?? new PolicyEvaluator();
    this.isIsolationAvailableProbe = options.isIsolationAvailable;
    this.workspacePort = options.workspacePort;
    this.ephemeralPolicy = options.policy;
    this.ephemeralVerificationSpec = options.verificationSpec;

    if (options.executionProvider) {
      this.executionProvider = options.executionProvider;
    } else {
      this.executionProvider = new InProcessExecutionProvider(
        options.operations ?? [new EchoOperation()]
      );
    }

    if (options.physicalExecutionProvider) {
      const physicalRole = resolveProviderRole(options.physicalExecutionProvider);
      if (physicalRole !== "PHYSICAL") {
        throw new InvalidExecutionProviderRoleError(
          options.physicalExecutionProvider.name,
          "PHYSICAL",
          physicalRole,
          `WorkerRuntime: options.physicalExecutionProvider '${options.physicalExecutionProvider.name}' has role '${physicalRole}'. Only PHYSICAL execution providers are permitted.`
        );
      }
      this.physicalExecutionProvider = options.physicalExecutionProvider;
    } else if (resolveProviderRole(this.executionProvider) === "PHYSICAL") {
      this.physicalExecutionProvider = this.executionProvider;
    } else {
      this.physicalExecutionProvider = undefined;
    }

    // ADR-0037 Step 4: fail at construction if a workspace-bearing worker is given an isolated-process
    // provider that has no TenantQuiescencePort.  Without the port the worker cannot safely auto-dispose
    // workspaces, so it is better to reject the configuration immediately than to silently preserve
    // workspaces at runtime.
    if (
      this.workspacePort &&
      resolveProviderTenantModel(this.executionProvider) === "ISOLATED_PROCESSES" &&
      !this.executionProvider.quiescence
    ) {
      throw new Error(
        `WorkerRuntime: execution provider '${this.executionProvider.name}' declares ISOLATED_PROCESSES tenant ` +
          `semantics (or does not declare tenantModel, which defaults to ISOLATED_PROCESSES) but provides no ` +
          `TenantQuiescencePort.  Automatic workspace disposal would be unsafe.  Either supply a ` +
          `TenantQuiescencePort on the provider or use a provider that declares tenantModel = "NONE".`
      );
    }

    // ADR-0038 Remediation (F-03 / F-4.4): An isolated-process provider requires durable launch coordination
    // across processes. Neither silent fallback nor explicit injection of an in-memory coordinator is permitted.
    // The launch coordinator must be backed by an authoritative durable state store matching the worker's coordinator store.
    if (resolveProviderTenantModel(this.executionProvider) === "ISOLATED_PROCESSES") {
      const coordinatorStore = this.coordinator?.store;
      const hasDurableCoordinatorStore = isDurableLaunchGateStore(coordinatorStore);

      if (!options.launchCoordinator) {
        if (!hasDurableCoordinatorStore) {
          throw new Error(
            `WorkerRuntime: execution provider '${this.executionProvider.name}' declares ISOLATED_PROCESSES ` +
              `tenant semantics, but neither options.launchCoordinator nor an authoritative coordinator store ` +
              `was provided. Silent fallback to in-memory coordination is prohibited for isolated execution.`
          );
        }
      } else {
        const launchStore = getLaunchCoordinatorStore(options.launchCoordinator);
        if (!isDurableLaunchGateStore(launchStore)) {
          throw new Error(
            `WorkerRuntime: execution provider '${this.executionProvider.name}' declares ISOLATED_PROCESSES ` +
              `tenant semantics, but the provided launch coordinator is not backed by an authoritative durable state store ` +
              `(explicit injection of an in-memory coordinator is prohibited for isolated execution). An authoritative coordinator store supporting ` +
              `tenant launch gates is required.`
          );
        }
        if (!hasDurableCoordinatorStore) {
          throw new Error(
            `WorkerRuntime: execution provider '${this.executionProvider.name}' declares ISOLATED_PROCESSES ` +
              `tenant semantics, but the worker coordinator has no authoritative durable state store. ` +
              `An authoritative coordinator store supporting tenant launch gates is required for isolated execution.`
          );
        }
        if (launchStore !== coordinatorStore) {
          throw new Error(
            `WorkerRuntime: execution provider '${this.executionProvider.name}' declares ISOLATED_PROCESSES ` +
              `tenant semantics, but the launch coordinator is backed by a different state store than the worker coordinator. ` +
              `Cross-store coordination is prohibited for isolated execution.`
          );
        }
      }
    }

    if (options.toolGateway) {
      this.toolGateway = options.toolGateway;
      this.connectorService = options.connectorService;
    } else {
      const coordinatorStore = this.coordinator.store;
      const mutationStore =
        options.mutationStore ??
        (coordinatorStore && typeof (coordinatorStore as any).recordIntent === "function"
          ? (coordinatorStore as unknown as MutationIntentStorePort)
          : undefined);

      const adapterRegistry =
        options.toolAdapterRegistry ??
        (this.workspacePort
          ? createWorkspaceToolAdapterRegistry(this.workspacePort, this.physicalExecutionProvider, {
              mutationStore,
            })
          : undefined);

      const effectiveToolRegistry = options.toolRegistry ?? defaultGovernedToolRegistry;
      const connectorService =
        options.connectorService ??
        (adapterRegistry
          ? createWorkspaceToolConnectorService({
              toolRegistry: effectiveToolRegistry,
              adapterRegistry,
              telemetry: this.telemetry,
            })
          : undefined);
      this.connectorService = connectorService;

      this.toolGateway = new ToolExecutionGateway({
        toolRegistry: effectiveToolRegistry,
        adapterRegistry,
        coordinator: this.coordinator,
        policyEvaluator: this.policyEvaluator,
        clock: this.clock,
        isIsolationAvailable: this.isIsolationAvailableProbe,
        connectorService,
        approvalControl: this.approvalControl,
        enableApprovalGate: options.enableApprovalGate ?? Boolean(this.approvalControl),
        telemetry: this.telemetry,
      });
    }
  }

  get memoryService(): ScopedContextMemoryService | undefined {
    return this.scopedMemory;
  }

  get connector(): GovernedToolConnectorService | undefined {
    return this.connectorService;
  }

  get approvalService(): ApprovalControl | undefined {
    return this.approvalControl;
  }

  /**
   * Reference to the configured ToolExecutionGateway.
   */
  get gateway(): ToolExecutionGateway {
    return this.toolGateway;
  }

  /**
   * Reference to the configured execution provider.
   */
  get provider(): ExecutionProvider {
    return this.executionProvider;
  }

  /**
   * Reference to the configured workspace port.
   */
  get workspace(): WorkspacePort | undefined {
    return this.workspacePort;
  }

  /**
   * Heartbeats/registers the worker record in the coordinator's state store.
   */
  ensureRegistered(): void {
    const now = this.clock.nowIso();
    const worker: WorkerRecord = {
      workerId: this.workerId,
      hostname: this.hostname,
      pid: this.pid,
      status: "ACTIVE",
      lastHeartbeatAt: now,
      createdAt: now,
    };
    this.coordinator.registerWorker(worker);
  }

  /**
   * Executes a single pass of the worker execution loop.
   * If runId is provided, claims that specific run.
   * Otherwise, claims the next QUEUED run.
   */
  async runOnce(
    targetRunId?: string,
    options?: { readonly signal?: AbortSignal }
  ): Promise<WorkerRunResult> {
    this.ensureRegistered();

    let claimResult: ClaimRunResult;

    try {
      if (targetRunId) {
        claimResult = this.coordinator.claimRun(targetRunId, this.workerId, this.leaseTtlMs);
      } else {
        const nextRun = this.coordinator.getNextQueuedRun();
        if (!nextRun) {
          return { status: "IDLE" };
        }
        claimResult = this.coordinator.claimRun(nextRun.runId, this.workerId, this.leaseTtlMs);
      }
    } catch (err: unknown) {
      if (err instanceof ContractIntegrityError) {
        return {
          status: "FAILED",
          runId: err.runId,
          error: {
            code: "CONTRACT_INTEGRITY_MISMATCH",
            message: err.message,
            details: {
              runId: err.runId,
              expectedHash: err.expectedHash,
              actualHash: err.actualHash,
            },
          },
        };
      }
      if (err instanceof InvalidRunError) {
        if (err.message.includes("not found")) {
          return {
            status: "FAILED",
            runId: err.runId,
            error: {
              code: "MISSING_BOUND_CONTRACT",
              message: err.message,
            },
          };
        }
        return {
          status: "FAILED",
          runId: err.runId,
          error: {
            code: "CONTRACT_INTEGRITY_MISMATCH",
            message: err.message,
          },
        };
      }
      if (err instanceof InvalidMissionContractError) {
        return {
          status: "FAILED",
          runId: targetRunId ?? "unknown",
          error: {
            code: "CONTRACT_INTEGRITY_MISMATCH",
            message: err.message,
          },
        };
      }
      throw err;
    }

    const { run, lease } = claimResult;

    // Transition LEASED -> RUNNING
    try {
      this.coordinator.startRun(run.runId, this.workerId, lease.leaseId);
    } catch (err: unknown) {
      if (err instanceof LeaseLostError || err instanceof LeaseExpiredError) {
        return { status: "FENCED", runId: run.runId, error: err };
      }
      throw err;
    }

    // Cooperative cancellation and timeout management
    const abortController = new AbortController();
    let timedOut = false;
    let timeoutTimer: NodeJS.Timeout | undefined;

    if (options?.signal) {
      if (options.signal.aborted) {
        abortController.abort(options.signal.reason);
      } else {
        options.signal.addEventListener(
          "abort",
          () => {
            abortController.abort(options?.signal?.reason);
          },
          { once: true }
        );
      }
    }

    if (run.timeoutMs && run.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        abortController.abort(new Error(`Operation exceeded timeout of ${run.timeoutMs}ms`));
      }, run.timeoutMs);
    }

    // Heartbeat: keeps the lease alive for as long as this run executes (stopped in the finally below,
    // before any terminal transition releases the lease). The block is intentionally not re-indented.
    const renewal = new LeaseRenewalLoop({
      coordinator: this.coordinator,
      clock: this.clock,
      runId: run.runId,
      leaseId: lease.leaseId,
      ttlMs: this.leaseTtlMs,
      expiresAt: lease.expiresAt,
      timeoutMs: run.timeoutMs,
      options: {
        ...this.leaseRenewalOptions,
        onLeaseLost: (err) => {
          this.leaseRenewalOptions?.onLeaseLost?.(err);
          try {
            const current = this.coordinator.getRun(run.runId);
            if (
              !current ||
              current.status !== "RUNNING" ||
              current.leaseId !== lease.leaseId ||
              current.currentWorkerId !== this.workerId
            ) {
              abortController.abort(err);
            }
          } catch {
            abortController.abort(err);
          }
        },
      },
    });
    renewal.start();
    let attemptSpan: TelemetrySpanRecord | undefined;
    if (this.observability) {
      try {
        attemptSpan = this.observability.startSpan(
          "worker.execute_attempt",
          {
            workerId: this.workerId,
            taskId: run.taskId,
            runId: run.runId,
            attemptCount: run.attemptCount,
          },
          {
            correlation: {
              taskId: run.taskId,
              runId: run.runId,
            },
          }
        );
        this.observability.incrementCounter(
          "emerald_worker_runs_started_total",
          "Total runs started by worker",
          { execution_mode: this.telemetry?.getDefaultExecutionMode() ?? "live" }
        );
      } catch { /* zero-authority */ }
    }
    try {
    const failRunSafely = (errorPayload: {
      code: string;
      message: string;
      details?: unknown;
    }): WorkerRunResult => {
      if (this.observability) {
        try {
          if (attemptSpan) {
            this.observability.endSpan(attemptSpan.spanId, "ERROR", errorPayload.message);
            attemptSpan = undefined;
          }
          this.observability.incrementCounter(
            "emerald_worker_runs_completed_total",
            "Total runs completed by worker",
            { status: "failed", execution_mode: this.telemetry?.getDefaultExecutionMode() ?? "live" }
          );
        } catch { /* zero-authority */ }
      }
      try {
        this.coordinator.failRun(run.runId, errorPayload, this.workerId, lease.leaseId);
      } catch (err: unknown) {
        if (err instanceof LeaseLostError) {
          return { status: "FENCED", runId: run.runId, error: err };
        }
        throw err;
      }
      return { status: "FAILED", runId: run.runId, error: errorPayload };
    };

    // 1. Ephemeral options rejection for governed Runs (Section 7)
    if (run.contractBinding) {
      if (this.ephemeralPolicy !== undefined || this.ephemeralVerificationSpec !== undefined) {
        return failRunSafely({
          code: "EPHEMERAL_OVERRIDE_REJECTED",
          message:
            "Ephemeral worker options (policy / verificationSpec) cannot be applied to governed Runs. The bound MissionContract is authoritative.",
          details: {
            hasPolicyOption: this.ephemeralPolicy !== undefined,
            hasVerificationSpecOption: this.ephemeralVerificationSpec !== undefined,
          },
        });
      }
    }

    // 2. Exact Contract Resolution & Existence (Sections 2, 3)
    if (!run.contractBinding) {
      return failRunSafely({
        code: "UNBOUND_RUN_EXECUTION_DISALLOWED",
        message: `Execution of unbound legacy Run '${run.runId}' is disallowed. Governed execution requires an authoritative MissionContract binding.`,
        details: { runId: run.runId },
      });
    }

    const { contractId, version, contentHash: boundContentHash } = run.contractBinding;
    let contract: MissionContract | null = null;
    try {
      contract = this.coordinator.getContract(contractId, version);
    } catch (err: unknown) {
      return failRunSafely({
        code: "CONTRACT_INTEGRITY_MISMATCH",
        message: err instanceof Error ? err.message : String(err),
        details: { contractId, version, boundContentHash },
      });
    }

    if (!contract) {
      return failRunSafely({
        code: "MISSING_BOUND_CONTRACT",
        message: `Exact bound MissionContract ('${contractId}', v${version}) not found`,
        details: { contractId, version },
      });
    }

    // 3. Contract Identity & Integrity Verification (Section 4)
    let recomputedHash: string;
    try {
      const hashResult = computeCanonicalHash(contract.spec);
      recomputedHash = hashResult.contentHash;
    } catch (err: unknown) {
      return failRunSafely({
        code: "CONTRACT_INTEGRITY_MISMATCH",
        message: `Failed to compute canonical hash for contract '${contractId}' v${version}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        details: { contractId, version, boundContentHash },
      });
    }

    if (
      contract.spec.contractId !== contractId ||
      contract.spec.version !== version ||
      contract.contentHash !== boundContentHash ||
      recomputedHash !== boundContentHash ||
      recomputedHash !== contract.contentHash
    ) {
      return failRunSafely({
        code: "CONTRACT_INTEGRITY_MISMATCH",
        message: `Content hash integrity mismatch for run '${run.runId}': bound hash '${boundContentHash}', contract hash '${contract.contentHash}', recomputed '${recomputedHash}'`,
        details: {
          runId: run.runId,
          boundContentHash,
          contractContentHash: contract.contentHash,
          recomputedHash,
          expectedContractId: contractId,
          actualContractId: contract.spec.contractId,
          expectedVersion: version,
          actualVersion: contract.spec.version,
        },
      });
    }

    // 4. Task Association Verification (Section 5)
    if (contract.spec.taskId !== run.taskId) {
      return failRunSafely({
        code: "MISSION_CONTRACT_TASK_MISMATCH",
        message: `Mission contract '${contract.spec.contractId}' belongs to task '${contract.spec.taskId}', not run task '${run.taskId}'`,
        details: {
          expectedTaskId: run.taskId,
          actualTaskId: contract.spec.taskId,
          contractId: contract.spec.contractId,
        },
      });
    }

    // 5. Lifecycle Authorization Verification (Section 6)
    if (contract.lifecycle.status === "REVOKED") {
      return failRunSafely({
        code: "CONTRACT_REVOKED",
        message: `Bound MissionContract '${contract.spec.contractId}' v${contract.spec.version} has been REVOKED${
          contract.lifecycle.revocationReason ? `: ${contract.lifecycle.revocationReason}` : ""
        }`,
        details: {
          contractId: contract.spec.contractId,
          version: contract.spec.version,
          status: contract.lifecycle.status,
          revocationReason: contract.lifecycle.revocationReason,
        },
      });
    }

    if (contract.lifecycle.status !== "ACTIVE") {
      return failRunSafely({
        code: "CONTRACT_NOT_ACTIVE",
        message: `Bound MissionContract '${contract.spec.contractId}' v${contract.spec.version} is not ACTIVE (status: '${contract.lifecycle.status}')`,
        details: {
          contractId: contract.spec.contractId,
          version: contract.spec.version,
          status: contract.lifecycle.status,
        },
      });
    }

    // 6. Operational Resource Limits Verification (Section 11)
    if (
      run.maxOutputBytes !== null &&
      run.maxOutputBytes !== undefined &&
      run.maxOutputBytes > contract.spec.resourceLimits.maxOutputBytes
    ) {
      return failRunSafely({
        code: "RESOURCE_LIMIT_EXCEEDED",
        message: `Run maxOutputBytes (${run.maxOutputBytes}) exceeds contract ceiling (${contract.spec.resourceLimits.maxOutputBytes})`,
        details: {
          limitName: "maxOutputBytes",
          requestedValue: run.maxOutputBytes,
          ceilingValue: contract.spec.resourceLimits.maxOutputBytes,
        },
      });
    }

    // Resolve task and input payload
    const task = this.coordinator.getTask(run.taskId);
    if (!task) {
      throw new Error(`Task '${run.taskId}' not found for run '${run.runId}'`);
    }

    // 7. Resolve Policy from MissionContract (Sections 8, 10)
    const policy = contract.spec.policy;

    // Construct ExecutionRequest with authoritative tenant & trust routing
    let request: ExecutionRequest = {
      runId: run.runId,
      taskId: task.taskId,
      operationName: task.title,
      inputPayload: task.inputPayload,
      idempotencyToken: run.idempotencyKey ?? run.runId,
      attemptNumber: run.attemptCount,
      timeoutMs: run.timeoutMs,
      leaseId: lease.leaseId,
      workerId: this.workerId,
      signal: abortController.signal,
      tenantId: policy.tenantId,
      trustClassification: policy.trustClassification,
    };

    const providerRole = resolveProviderRole(this.executionProvider);
    let policyDecision = this.policyEvaluator.evaluate(request, policy);
    const hasAgentInstruction =
      Boolean(task.inputPayload) &&
      typeof task.inputPayload === "object" &&
      ("instruction" in (task.inputPayload as Record<string, unknown>) ||
        "objective" in (task.inputPayload as Record<string, unknown>) ||
        "subtaskId" in (task.inputPayload as Record<string, unknown>));
    if (
      providerRole === "ORCHESTRATION" &&
      policyDecision.status === "DENIED" &&
      policyDecision.reasonCode === "UNKNOWN_CAPABILITY" &&
      hasAgentInstruction &&
      policy.allowedCapabilities.length > 0
    ) {
      policyDecision = PolicyEvaluator.evaluateCapability(policy.allowedCapabilities[0]!, policy);
    }

    // If policy denies capability: fail run immediately WITHOUT calling provider
    if (policyDecision.status === "DENIED") {
      this.coordinator.recordPolicyDecision(run.runId, {
        taskId: task.taskId,
        operationName: task.title,
        capabilityName: policyDecision.capabilityName,
        policyId: policyDecision.policyId,
        allowed: false,
        isolationRequirement: policyDecision.isolationRequirement,
        reasonCode: policyDecision.reasonCode,
        providerName: this.executionProvider.name,
      });

      return failRunSafely({
        code: "POLICY_DENIED",
        message: policyDecision.message,
        details: {
          reasonCode: policyDecision.reasonCode,
          capabilityName: policyDecision.capabilityName,
          isolationRequirement: policyDecision.isolationRequirement,
          policyId: policyDecision.policyId,
          providerName: this.executionProvider.name,
        },
      });
    }

    // 8. Verify Required Isolation Posture (Section 9)
    const isolationSatisfaction = await this.verifyIsolationSatisfaction(
      policyDecision.isolationRequirement,
      policy
    );

    if (!isolationSatisfaction.satisfied) {
      this.coordinator.recordPolicyDecision(run.runId, {
        taskId: task.taskId,
        operationName: task.title,
        capabilityName: policyDecision.capabilityName,
        policyId: policyDecision.policyId,
        allowed: false,
        isolationRequirement: policyDecision.isolationRequirement,
        reasonCode: "ISOLATION_REQUIREMENT_NOT_MET",
        providerName: this.executionProvider.name,
      });

      return failRunSafely({
        code: "POLICY_DENIED",
        message: isolationSatisfaction.reason,
        details: {
          reasonCode: "ISOLATION_REQUIREMENT_NOT_MET",
          capabilityName: policyDecision.capabilityName,
          isolationRequirement: policyDecision.isolationRequirement,
          policyId: policyDecision.policyId,
          providerName: this.executionProvider.name,
        },
      });
    }

    // Record successful policy evaluation event
    this.coordinator.recordPolicyDecision(run.runId, {
      taskId: task.taskId,
      operationName: task.title,
      capabilityName: policyDecision.capabilityName,
      policyId: policyDecision.policyId,
      allowed: true,
      isolationRequirement: policyDecision.isolationRequirement,
      providerName: this.executionProvider.name,
    });

    const priorWaitingApproval = this.coordinator.store
      .getEventsForRun(run.runId)
      .some((e) => e.eventType === "run.waiting_approval");

    // 9. Workspace Provisioning & Sandbox Boundary (if WorkspacePort is configured)
    let workspace: Workspace | undefined;
    let workspaceHandle: WorkspaceHandle | undefined;
    let artifactBaselineCaptured = false;
    const artifactAttempt = Math.max(1, run.attemptCount);

    if (this.workspacePort) {
      // 9a. Workspace identity: distinct from runId but stable for the run, so every attempt of
      // a run maps to the same workspace path (one workspace per run; ownership is bound below).
      const workspaceId = `ws-${run.runId}`;

      // 9b. Verify workspace limits against MissionContract authority
      const contractMaxOutput = contract.spec.resourceLimits.maxOutputBytes;
      const maxFileSizeBytes = Math.min(10 * 1024 * 1024, contractMaxOutput);

      const { workspace: wsAggregate, event: provisioningEvent } = Workspace.create({
        workspaceId,
        runId: run.runId,
        taskId: task.taskId,
        maxWorkspaceBytes: 500 * 1024 * 1024,
        maxFileSizeBytes,
        now: this.clock.nowIso(),
      });
      workspace = wsAggregate;
      this.coordinator.recordWorkspaceEvent(provisioningEvent);

      // 9c. Provision isolated filesystem directory in adapter (or resume existing authenticated workspace)
      try {
        workspaceHandle =
          priorWaitingApproval && this.workspacePort.resumeWorkspace
            ? await this.workspacePort.resumeWorkspace(workspace.spec, {
                runId: run.runId,
                leaseId: lease.leaseId,
              })
            : await this.workspacePort.provisionWorkspace(workspace.spec, {
                runId: run.runId,
                leaseId: lease.leaseId,
              });
      } catch (err: unknown) {
        const failedEvent = workspace.markFailed({
          errorMessage: err instanceof Error ? err.message : String(err),
          now: this.clock.nowIso(),
        });
        this.coordinator.recordWorkspaceEvent(failedEvent);
        return failRunSafely({
          code: "WORKSPACE_PROVISIONING_FAILED",
          message: `Workspace provisioning failed for run '${run.runId}': ${
            err instanceof Error ? err.message : String(err)
          }`,
          details: { workspaceId, error: err instanceof Error ? err.message : String(err) },
        });
      }

      // 9d. Validate WorkspaceHandle boundary & ownership
      if (
        !workspaceHandle ||
        workspaceHandle.runId !== run.runId ||
        workspaceHandle.workspaceId !== workspaceId ||
        !workspaceHandle.hostPath
      ) {
        const failedEvent = workspace.markFailed({
          errorMessage: "Invalid workspace handle returned by workspace adapter",
          now: this.clock.nowIso(),
        });
        this.coordinator.recordWorkspaceEvent(failedEvent);
        await this.workspacePort.disposeWorkspace(workspaceId, { runId: run.runId, leaseId: lease.leaseId }).catch(() => {});
        return failRunSafely({
          code: "WORKSPACE_BOUNDARY_FAILURE",
          message: "Workspace handle returned by adapter failed containment or identity check",
          details: { workspaceId },
        });
      }

      // 9d'. Bind the run to its workspace root so recovery never has to guess it.
      try {
        this.coordinator.bindRunWorkspace(run.runId, workspaceHandle.hostPath, {
          workerId: this.workerId,
          leaseId: lease.leaseId,
        });
      } catch (bindErr: unknown) {
        if (bindErr instanceof LeaseLostError) {
          return { status: "FENCED", runId: run.runId, error: bindErr };
        }
        const failedEvent = workspace.markFailed({
          errorMessage: `Workspace ownership binding failed: ${bindErr instanceof Error ? bindErr.message : String(bindErr)}`,
          now: this.clock.nowIso(),
        });
        this.coordinator.recordWorkspaceEvent(failedEvent);
        await this.workspacePort.disposeWorkspace(workspaceId, { runId: run.runId, leaseId: lease.leaseId }).catch(() => {});
        return failRunSafely({
          code: "WORKSPACE_BOUNDARY_FAILURE",
          message: "Run workspace ownership binding failed or conflicts with the run's bound workspace",
          details: { workspaceId, error: bindErr instanceof Error ? bindErr.message : String(bindErr) },
        });
      }

      // 9d-import. Optional repository import: a task may request a host repository (inputPayload.repositoryPath).
      // The copy is made into the empty, owned workspace; it fails closed (workspace disposed, run failed)
      // if no importer is configured, the policy grants no file-read capability, or the import is unsafe.
      let repositoryImport: RepositoryImportSummary | undefined;
      const requestedRepository = (task.inputPayload as { repositoryPath?: unknown } | null | undefined)
        ?.repositoryPath;
      if (requestedRepository !== undefined && !priorWaitingApproval) {
        let importFailure: { code: string; message: string } | undefined;
        if (typeof requestedRepository !== "string" || requestedRepository.trim().length === 0) {
          importFailure = {
            code: "REPOSITORY_IMPORT_INVALID",
            message: "Task repositoryPath must be a non-empty string",
          };
        } else if (!this.repositoryImporter) {
          importFailure = {
            code: "REPOSITORY_IMPORT_UNAVAILABLE",
            message: "Task requests a repository but this worker has no repository importer configured",
          };
        } else if (!contract.spec.policy.allowedCapabilities.includes("workspace.file.read")) {
          importFailure = {
            code: "REPOSITORY_IMPORT_DENIED",
            message: "Importing a repository requires the workspace.file.read capability in the mission policy",
          };
        } else {
          try {
            repositoryImport = await this.repositoryImporter.importRepository(
              requestedRepository,
              workspaceHandle.hostPath,
              { maxFileBytes: maxFileSizeBytes }
            );
          } catch (importErr: unknown) {
            importFailure = {
              code: "REPOSITORY_IMPORT_FAILED",
              message: importErr instanceof Error ? importErr.message : String(importErr),
            };
          }
        }
        if (importFailure) {
          const failedEvent = workspace.markFailed({
            errorMessage: `Repository import failed: ${importFailure.message}`,
            now: this.clock.nowIso(),
          });
          this.coordinator.recordWorkspaceEvent(failedEvent);
          await this.workspacePort
            .disposeWorkspace(workspaceId, { runId: run.runId, leaseId: lease.leaseId })
            .catch(() => {});
          return failRunSafely({
            code: importFailure.code,
            message: importFailure.message,
            details: { workspaceId },
          });
        }
      }

      // 9d-baseline. Capture the artifact baseline (after any repository import, before the agent runs) in a
      // location the agent cannot reach. A failed baseline fails the run closed: work must not run
      // unrecoverably when the operator asked for it to be preserved.
      if (this.artifactExporter) {
        try {
          await this.artifactExporter.captureBaseline({
            runId: run.runId,
            attempt: artifactAttempt,
            workspacePath: workspaceHandle.hostPath,
          });
          artifactBaselineCaptured = true;
        } catch (baselineErr: unknown) {
          const message = baselineErr instanceof Error ? baselineErr.message : String(baselineErr);
          const failedEvent = workspace.markFailed({
            errorMessage: `Artifact baseline failed: ${message}`,
            now: this.clock.nowIso(),
          });
          this.coordinator.recordWorkspaceEvent(failedEvent);
          await this.workspacePort
            .disposeWorkspace(workspaceId, { runId: run.runId, leaseId: lease.leaseId })
            .catch(() => {});
          return failRunSafely({
            code: "ARTIFACT_BASELINE_FAILED",
            message,
            details: { workspaceId },
          });
        }
      }

      // 9e. Transition domain aggregate: READY and LEASED
      const readyEvent = workspace.markReady({
        hostPath: workspaceHandle.hostPath,
        containerMountPath: workspaceHandle.containerMountPath,
        ...(repositoryImport ? { repositoryImport } : {}),
        now: this.clock.nowIso(),
      });
      this.coordinator.recordWorkspaceEvent(readyEvent);

      const leasedEvent = workspace.claimLease({
        workerId: this.workerId,
        leaseId: lease.leaseId,
        now: this.clock.nowIso(),
      });
      this.coordinator.recordWorkspaceEvent(leasedEvent);

      // 9f. Attach workspace mount to ExecutionRequest
      request = {
        ...request,
        workspace: {
          workspaceId: workspaceHandle.workspaceId,
          hostPath: workspaceHandle.hostPath,
          containerMountPath: workspaceHandle.containerMountPath,
        },
      };
    }

    let workspaceDisposed = false;
    const disposeWorkspaceSafely = async (reason?: string): Promise<void> => {
      if (!this.workspacePort || !workspace || workspaceDisposed) {
        return;
      }

      const fencing = { workerId: this.workerId, leaseId: lease.leaseId };

      // Fail closed: never delete unless ownership was positively verified. If this worker lost the
      // lease (run reclaimed, run gone, other worker/lease) it must NOT delete or mutate; if ownership
      // cannot be read at all, the error is surfaced and nothing is deleted.
      let currentRun: ReturnType<RunCoordinator["getRun"]>;
      try {
        currentRun = this.coordinator.getRun(run.runId);
      } catch (readErr: unknown) {
        throw new Error(
          `Workspace ownership could not be verified; workspace '${workspace.workspaceId}' was not deleted: ${
            readErr instanceof Error ? readErr.message : String(readErr)
          }`
        );
      }
      if (!currentRun || currentRun.leaseId !== lease.leaseId || currentRun.currentWorkerId !== this.workerId) {
        // Stale worker is fenced!
        return;
      }

      // ADR-0037 Step 4: an isolated-process provider must prove all tenant processes for this run are
      // gone before we delete the workspace.  Unknown provider semantics (tenantModel omitted) default to
      // ISOLATED_PROCESSES — fail closed.  On any failure we preserve the workspace and record a
      // workspace.failed event (fenced, so a stale worker will not pollute the newer attempt's stream).
      const tenantModel = resolveProviderTenantModel(this.executionProvider);
      if (tenantModel === "ISOLATED_PROCESSES") {
        const port = this.executionProvider.quiescence;
        let quiescenceReason: string | undefined;
        if (!port) {
          quiescenceReason = "no TenantQuiescencePort is configured for this isolated-process provider";
        } else {
          try {
            const qResult = await port.quiesceRun(run.runId);
            if (qResult.status !== "QUIESCENT") {
              quiescenceReason = `tenant processes not verified gone: ${qResult.reason}`;
            }
          } catch (qErr: unknown) {
            quiescenceReason = `quiescence check failed: ${qErr instanceof Error ? qErr.message : String(qErr)}`;
          }
        }
        if (quiescenceReason) {
          // Fail closed: record workspace.failed (with lease fencing) then preserve the directory.
          const failedEvent = workspace.markFailed({
            errorMessage: `Workspace disposal withheld — tenant quiescence not established: ${quiescenceReason}`,
            now: this.clock.nowIso(),
          });
          try {
            this.coordinator.recordWorkspaceEvent(failedEvent, fencing);
          } catch (recordErr: unknown) {
            if (!(recordErr instanceof LeaseLostError)) throw recordErr;
          }
          return; // workspace preserved
        }
      }

      // Artifact export: by now ownership is verified and (for isolated providers) tenant quiescence is
      // established, so the workspace is stable. The export never modifies the workspace. If it fails, the
      // workspace is PRESERVED (never disposed) and the failure is surfaced, so work is not silently lost.
      let artifactExport: ArtifactExportSummary | undefined;
      if (this.artifactExporter && artifactBaselineCaptured && workspaceHandle) {
        try {
          artifactExport = await this.artifactExporter.exportArtifact({
            runId: run.runId,
            attempt: artifactAttempt,
            workspacePath: workspaceHandle.hostPath,
            disposalReason: reason,
          });
        } catch (exportErr: unknown) {
          const message = exportErr instanceof Error ? exportErr.message : String(exportErr);
          const failedEvent = workspace.markFailed({
            errorMessage: `Workspace disposal withheld - artifact export failed: ${message}`,
            now: this.clock.nowIso(),
          });
          try {
            this.coordinator.recordWorkspaceEvent(failedEvent, fencing);
          } catch (recordErr: unknown) {
            if (!(recordErr instanceof LeaseLostError)) throw recordErr;
          }
          throw exportErr instanceof ArtifactExportError
            ? exportErr
            : new ArtifactExportError("ARTIFACT_EXPORT_FAILED", message);
        }
      }

      // The cleaning event is recorded WITH lease fencing inside a database transaction, so it is the
      // atomic ownership assertion made immediately before deletion. Only LeaseLost means "fenced, stop
      // quietly"; any other failure is unexpected and must not be treated as permission to delete.
      try {
        const cleaningEvent = workspace.startCleaning({
          reason,
          workerId: this.workerId,
          leaseId: lease.leaseId,
          ...(artifactExport ? { artifactExport } : {}),
          now: this.clock.nowIso(),
        });
        this.coordinator.recordWorkspaceEvent(cleaningEvent, fencing);
      } catch (fencingErr: unknown) {
        if (fencingErr instanceof LeaseLostError) {
          return;
        }
        throw fencingErr;
      }

      try {
        await this.workspacePort.disposeWorkspace(workspace.workspaceId, { runId: run.runId, leaseId: lease.leaseId });
        workspaceDisposed = true;
        const disposedEvent = workspace.markDisposed({ now: this.clock.nowIso() });
        this.coordinator.recordWorkspaceEvent(disposedEvent, fencing);
      } catch (err: unknown) {
        // A stale attempt: the directory belongs to a newer lease (or ownership is unprovable) and was not deleted.
        if (err instanceof LeaseLostError || err instanceof WorkspaceOwnershipError) {
          return;
        }
        const failedEvent = workspace.markFailed({
          errorMessage: `Workspace disposal failed: ${err instanceof Error ? err.message : String(err)}`,
          now: this.clock.nowIso(),
        });
        try {
          this.coordinator.recordWorkspaceEvent(failedEvent, fencing);
        } catch (recordErr: unknown) {
          // A fenced (stale) worker must not write into the newer attempt's workspace event stream.
          if (!(recordErr instanceof LeaseLostError)) throw recordErr;
        }
        throw err;
      }
    };

    // 10. Pre-launch approval gate for physical providers requiring explicit operator sign-off
    if (
      this.approvalControl &&
      resolveProviderRole(this.executionProvider) === "PHYSICAL" &&
      Boolean((task.inputPayload as { requireApproval?: unknown } | null | undefined)?.requireApproval === true)
    ) {
      const tenantId = contract.spec.policy.tenantId ?? "tenant-default";
      const contractHash = run.contractBinding?.contentHash ?? contract.contentHash;
      const parametersHash = computeCanonicalHash(request.inputPayload ?? {}).contentHash;
      const auth = this.approvalControl.authorizeAndConsume({
        runId: run.runId,
        taskId: task.taskId,
        tenantId,
        contractHash,
        operation: request.operationName,
        parametersHash,
        consume: true,
      });
      if (!auth.authorized) {
        if (auth.status === "REJECTED" || auth.status === "EXPIRED" || auth.status === "CONSUMED" || auth.status === "MISMATCH") {
          this.telemetry?.recordApprovalDecision({ action: auth.status.toLowerCase(), riskLevel: "HIGH" });
          await disposeWorkspaceSafely(`Approval ${auth.status}`).catch(() => {});
          return failRunSafely({
            code: auth.status === "REJECTED" ? "APPROVAL_REJECTED" : auth.status === "EXPIRED" ? "APPROVAL_EXPIRED" : "APPROVAL_INVALID",
            message: auth.reason,
            details: { approvalId: auth.approvalId, status: auth.status },
          });
        }
        const approvalId =
          auth.approvalId ??
          this.approvalControl.requestApproval({
            runId: run.runId,
            taskId: task.taskId,
            tenantId,
            contractHash,
            operation: request.operationName,
            parameters:
              request.inputPayload && typeof request.inputPayload === "object" && !Array.isArray(request.inputPayload)
                ? (request.inputPayload as Record<string, unknown>)
                : {},
            riskLevel: "HIGH",
            justification: `Task '${task.taskId}' requires operator approval before execution`,
            singleUse: true,
          }).approvalId;
        this.telemetry?.recordApprovalDecision({ action: "requested", riskLevel: "HIGH" });
        this.coordinator.requestApprovalTransition(run.runId, approvalId, request.operationName, {
          workerId: this.workerId,
          leaseId: lease.leaseId,
        });
        return {
          status: "WAITING_APPROVAL",
          runId: run.runId,
          approvalId,
          operation: request.operationName,
        };
      }
      this.telemetry?.recordApprovalDecision({ action: "consumed", riskLevel: "HIGH" });
    }

    // 10b. Delegate to ExecutionProvider ONLY NOW (ADR-0038: Gated Tenant Launch)
    let executionResult: ExecutionResult;
    let launchGate: TenantLaunchGate | undefined;
    const isIsolated = resolveProviderTenantModel(this.executionProvider) === "ISOLATED_PROCESSES";

    if (isIsolated) {
      try {
        launchGate = await this.launchCoordinator.acquire({
          runId: run.runId,
          holderType: "WORKER",
          holderId: this.workerId,
          leaseId: lease.leaseId,
          ownerPid: this.pid,
          ttlMs: Math.max(this.leaseTtlMs, 30_000),
          timeoutMs: this.launchGateTimeoutMs ?? 5_000,
        });
      } catch (gateErr: unknown) {
        await disposeWorkspaceSafely("Failed to acquire tenant launch gate").catch(() => {});
        return failRunSafely({
          code: "TENANT_LAUNCH_GATE_ERROR",
          message: gateErr instanceof Error ? gateErr.message : String(gateErr),
          details: { runId: run.runId, error: String(gateErr) },
        });
      }

      // Re-validate lease inside coordination gate before launching tenant container
      const currentBeforeLaunch = this.coordinator.getRun(run.runId);
      if (
        !currentBeforeLaunch ||
        currentBeforeLaunch.status !== "RUNNING" ||
        currentBeforeLaunch.leaseId !== lease.leaseId ||
        currentBeforeLaunch.currentWorkerId !== this.workerId
      ) {
        await this.launchCoordinator.release(launchGate).catch(() => {});
        launchGate = undefined;
        return {
          status: "FENCED",
          runId: run.runId,
          error: new LeaseLostError(run.runId, lease.leaseId, currentBeforeLaunch?.leaseId ?? null),
        };
      }
    }

    try {
      try {
        executionResult = await this.executionProvider.execute(request);
      } catch (providerError: unknown) {
        if (abortController.signal.aborted) {
          const current = this.coordinator.getRun(run.runId);
          if (
            !current ||
            current.status !== "RUNNING" ||
            current.leaseId !== lease.leaseId ||
            current.currentWorkerId !== this.workerId
          ) {
            return {
              status: "FENCED",
              runId: run.runId,
              error: new LeaseLostError(run.runId, lease.leaseId, current?.leaseId ?? null),
            };
          }
          if (timedOut) {
            executionResult = {
              status: "TIMED_OUT",
              durationMs: 0,
              error: {
                code: "EXECUTION_TIMEOUT",
                message: `Operation exceeded timeout of ${run.timeoutMs}ms`,
              },
            };
          } else {
            executionResult = {
              status: "CANCELLED",
              durationMs: 0,
              error: {
                code: "EXECUTION_CANCELLED",
                message: providerError instanceof Error ? providerError.message : "Operation cancelled by signal",
              },
            };
          }
        } else {
          await disposeWorkspaceSafely("Execution provider threw unexpected exception").catch(() => {});
          throw providerError;
        }
      }

      // Ownership check after the provider returns: if the run was reclaimed (lease/worker ids changed)
      // or already left RUNNING (e.g. cancelled by an operator),
      // this worker no longer has authority, so it must not write a terminal state or dispose the
      // workspace (recovery owns both now). Deliberately ownership-only: a lease that merely expired
      // by time without being reclaimed does not discard the work (the terminal write is still fenced
      // by the same ids inside its transaction). This does not depend on the heartbeat timer having run.
      const current = this.coordinator.getRun(run.runId);
      if (
        !current ||
        current.status !== "RUNNING" ||
        current.leaseId !== lease.leaseId ||
        current.currentWorkerId !== this.workerId
      ) {
        return { status: "FENCED", runId: run.runId, error: new LeaseLostError(run.runId, lease.leaseId, current?.leaseId ?? null) };
      }

      if (executionResult.status === "FAILED" && executionResult.error?.code === "LEASE_LOST") {
        // Provider aborted cleanly on lost/expired lease; fence without marking terminal FAILED or disposing workspace.
        return {
          status: "FENCED",
          runId: run.runId,
          error: new LeaseLostError(run.runId, lease.leaseId, current.leaseId ?? null),
        };
      }

      // Fencing has priority (above). An unverified termination is never rewritten into TIMED_OUT/CANCELLED
      // by the precedence rules below, and never reaches a terminal write or workspace disposal: a tenant may
      // still be running, so the run is left RUNNING for lease-expiry recovery to quiesce.
      if (executionResult.status === "FAILED" && executionResult.error?.code === "TERMINATION_UNVERIFIED") {
        if (launchGate && typeof this.launchCoordinator.quarantine === "function") {
          try {
            await this.launchCoordinator.quarantine(launchGate, "Worker termination unverified");
          } catch {
            // fail-closed best effort
          }
          launchGate = undefined;
        }
        return { status: "TERMINATION_UNVERIFIED", runId: run.runId, error: executionResult.error };
      }

      // Human-in-the-loop pause: release launch gate, preserve workspace for resume, transition run -> WAITING_APPROVAL
      if (
        executionResult.status === "FAILED" &&
        executionResult.error?.code === "WAITING_APPROVAL"
      ) {
        if (launchGate) {
          await this.launchCoordinator.release(launchGate).catch(() => {});
          launchGate = undefined;
        }
        const errDetails =
          executionResult.error.details && typeof executionResult.error.details === "object"
            ? (executionResult.error.details as Record<string, unknown>)
            : {};
        const approvalId =
          typeof errDetails.approvalId === "string" && errDetails.approvalId.length > 0
            ? errDetails.approvalId
            : `appr-pending-${run.runId}`;
        const operation =
          typeof errDetails.operation === "string" && errDetails.operation.length > 0
            ? errDetails.operation
            : request.operationName;
        this.coordinator.requestApprovalTransition(run.runId, approvalId, operation, {
          workerId: this.workerId,
          leaseId: lease.leaseId,
        });
        return {
          status: "WAITING_APPROVAL",
          runId: run.runId,
          approvalId,
          operation,
        };
      }

      // Deterministic precedence: timeout/cancellation takes precedence over late success
      if (timedOut) {
        executionResult = {
          status: "TIMED_OUT",
          durationMs: executionResult.durationMs,
          error: {
            code: "EXECUTION_TIMEOUT",
            message:
              executionResult.status === "TIMED_OUT" && executionResult.error?.message
                ? executionResult.error.message
                : `Operation '${request.operationName}' exceeded logical timeout limit of ${run.timeoutMs}ms`,
          },
        };
      } else if (abortController.signal.aborted && executionResult.status !== "CANCELLED" && executionResult.status !== "TIMED_OUT") {
        executionResult = {
          status: "CANCELLED",
          durationMs: executionResult.durationMs,
          error: executionResult.error ?? {
            code: "EXECUTION_CANCELLED",
            message: "Operation cancelled by signal",
          },
        };
      }

      // 11. Post-execution Revocation Check (Section 11)
      const postExecutionContract = this.coordinator.getContract(contractId, version);
      if (postExecutionContract?.lifecycle.status === "REVOKED") {
        await disposeWorkspaceSafely("MissionContract was REVOKED during execution").catch(() => {});
        return failRunSafely({
          code: "CONTRACT_REVOKED",
          message: `Bound MissionContract '${contractId}' v${version} was REVOKED during execution`,
          details: { contractId, version },
        });
      }

      // 12. Process ExecutionResult and apply governed verification
      switch (executionResult.status) {
        case "SUCCESS": {
          // Output limit enforcement (Section 11)
          if (
            run.maxOutputBytes !== null &&
            run.maxOutputBytes !== undefined &&
            executionResult.output !== undefined &&
            executionResult.output !== null
          ) {
            let outputBytes: number;
            if (typeof executionResult.output === "string") {
              outputBytes = Buffer.byteLength(executionResult.output, "utf8");
            } else if (Buffer.isBuffer(executionResult.output)) {
              outputBytes = executionResult.output.length;
            } else {
              try {
                outputBytes = Buffer.byteLength(JSON.stringify(executionResult.output), "utf8");
              } catch {
                outputBytes = 0;
              }
            }
            if (outputBytes > run.maxOutputBytes) {
              await disposeWorkspaceSafely("Output limit exceeded").catch(() => {});
              const errorPayload = {
                code: "OUTPUT_LIMIT_EXCEEDED",
                message: `Execution output of ${outputBytes} bytes exceeded governed budget of ${run.maxOutputBytes} bytes`,
                details: { outputBytes, maxOutputBytes: run.maxOutputBytes },
              };
              return failRunSafely(errorPayload);
            }
          }

          // Authoritative verification specifications from MissionContract (Section 12)
          const vSpecs = contract.spec.verificationSpecs;
          if (vSpecs && vSpecs.length > 0) {
            if (providerRole === "ORCHESTRATION") {
              // Orchestration providers (GovernedAgentExecutionProvider) verify specs per tool attempt inside
              // AgentStepController and persist `verification.completed` events. Independently confirm from
              // durable events after the latest `run.started` that EVERY contract spec passed (fail closed).
              const runEvents = this.coordinator.store.getEventsForRun(run.runId);
              let lastStartIdx = -1;
              for (let idx = runEvents.length - 1; idx >= 0; idx--) {
                if (runEvents[idx]?.eventType === "run.started") {
                  lastStartIdx = idx;
                  break;
                }
              }
              const attemptEvents = lastStartIdx >= 0 ? runEvents.slice(lastStartIdx) : [];
              const latestStatusBySpec = new Map<
                string,
                { status: string; message?: string; reasonCode?: string }
              >();
              for (const ev of attemptEvents) {
                if (ev.eventType === "verification.completed") {
                  const p = ev.payload as
                    | { specId?: unknown; status?: unknown; message?: unknown; reasonCode?: unknown }
                    | undefined;
                  if (typeof p?.specId === "string" && typeof p?.status === "string") {
                    latestStatusBySpec.set(p.specId, {
                      status: p.status,
                      message: typeof p.message === "string" ? p.message : undefined,
                      reasonCode: typeof p.reasonCode === "string" ? p.reasonCode : undefined,
                    });
                  }
                }
              }
              for (const spec of vSpecs) {
                const outcome = latestStatusBySpec.get(spec.specId);
                const passed = outcome?.status === "VERIFIED";

                if (this.observability) {
                  try {
                    this.observability.incrementCounter(
                      "emerald_worker_verifications_total",
                      "Total verification evaluations performed by worker",
                      {
                        status: passed ? "verified" : "failed",
                        execution_mode: this.telemetry?.getDefaultExecutionMode() ?? "live",
                      }
                    );
                  } catch { /* zero-authority */ }
                }

                if (!passed) {
                  let repairCycle: RepairCycleState | undefined;
                  let haltReason: string | undefined;
                  if (this.repairController) {
                    repairCycle = this.repairController.initCycle(task.taskId, run.runId);
                    const diagCategory = this.repairController.diagnoseFeedback(
                      repairCycle,
                      outcome?.message ?? "Orchestration verification failed",
                      JSON.stringify(outcome ?? {}),
                      1
                    );

                    if (this.observability) {
                      try {
                        this.observability.incrementCounter(
                          "emerald_worker_repair_attempts_total",
                          "Total post-verification repair attempts triggered by worker",
                          { category: diagCategory, execution_mode: this.telemetry?.getDefaultExecutionMode() ?? "live" }
                        );
                        this.observability.emitLog(
                          "WARN",
                          "worker.repair.diagnosed",
                          `Post-verification failure diagnosed: ${diagCategory}`,
                          { taskId: task.taskId, runId: run.runId, category: diagCategory, specId: spec.specId }
                        );
                      } catch { /* zero-authority */ }
                    }

                    const boundsCheck = this.repairController.shouldContinueRepair(repairCycle);
                    const missionId =
                      typeof (task.inputPayload as Record<string, unknown> | null)?.missionId === "string"
                        ? ((task.inputPayload as Record<string, unknown>).missionId as string)
                        : undefined;
                    if (!boundsCheck.canContinue) {
                      this.repairController.concludeVerification(repairCycle, 1);
                      haltReason = boundsCheck.reason;
                    } else if (this.repairOrchestrator && missionId) {
                      try {
                        const repairResult = await this.repairOrchestrator.executeRepairSession(
                          missionId,
                          (this.executionProvider as any)?.modelAdapter ?? {
                            generate: async () => ({ action: "NOOP", confidence: 0, reasoning: "Fallback" }),
                          }
                        );
                        if (repairResult.verification?.verified) {
                          this.repairController.concludeVerification(repairCycle, 0);
                          continue;
                        }
                      } catch {
                        this.repairController.concludeVerification(repairCycle, 1);
                      }
                    } else {
                      this.repairController.concludeVerification(repairCycle, 1);
                    }
                  }

                  await disposeWorkspaceSafely("Verification failed").catch(() => {});
                  return failRunSafely({
                    code: haltReason ? "VERIFICATION_FAILED_REPAIR_EXHAUSTED" : "VERIFICATION_FAILED",
                    message:
                      haltReason
                        ? `Verification failed and repair halted: ${haltReason}`
                        : outcome?.message ??
                          `Required verification specification '${spec.specId}' was not verified during orchestrated execution.`,
                    details: {
                      specId: spec.specId,
                      reasonCode: outcome?.reasonCode ?? "MISSING_EVIDENCE",
                      observedStatus: outcome?.status ?? "NOT_EVALUATED",
                      ...(repairCycle
                        ? {
                            repairDiagnosis: repairCycle.lastDiagnosis,
                            repairIterations: repairCycle.iterationCount,
                            repairStage: repairCycle.currentStage,
                            repairHaltReason: repairCycle.terminalReason,
                          }
                        : {}),
                    },
                  });
                }
              }
            } else {
              const evidenceList: Evidence[] = [
                createOutputPayloadEvidence(run.runId, executionResult.output),
              ];

              if (typeof executionResult.providerMetadata?.exitCode === "number") {
                evidenceList.push(
                  createProcessExitEvidence(run.runId, {
                    exitCode: executionResult.providerMetadata.exitCode as number,
                    signal: (executionResult.providerMetadata?.signal as string) ?? null,
                  })
                );
              }

              const verificationFencing = { workerId: this.workerId, leaseId: lease.leaseId };
              for (const evidence of evidenceList) {
                this.coordinator.recordEvidence(run.runId, evidence, verificationFencing);
              }

              for (const spec of vSpecs) {
                const verificationResult = DeterministicVerifier.verify(evidenceList, spec);
                this.coordinator.recordVerificationResult(run.runId, verificationResult, undefined, verificationFencing);

                const passed = verificationResult.status === "VERIFIED";
                if (this.observability) {
                  try {
                    this.observability.incrementCounter(
                      "emerald_worker_verifications_total",
                      "Total verification evaluations performed by worker",
                      {
                        status: passed ? "verified" : "failed",
                        execution_mode: this.telemetry?.getDefaultExecutionMode() ?? "live",
                      }
                    );
                  } catch { /* zero-authority */ }
                }

                if (!passed) {
                  let repairCycle: RepairCycleState | undefined;
                  let haltReason: string | undefined;
                  if (this.repairController) {
                    repairCycle = this.repairController.initCycle(task.taskId, run.runId);
                    const diagCategory = this.repairController.diagnoseFeedback(
                      repairCycle,
                      verificationResult.message,
                      JSON.stringify(verificationResult.details ?? {}),
                      1
                    );

                    if (this.observability) {
                      try {
                        this.observability.incrementCounter(
                          "emerald_worker_repair_attempts_total",
                          "Total post-verification repair attempts triggered by worker",
                          { category: diagCategory, execution_mode: this.telemetry?.getDefaultExecutionMode() ?? "live" }
                        );
                        this.observability.emitLog(
                          "WARN",
                          "worker.repair.diagnosed",
                          `Post-verification failure diagnosed: ${diagCategory}`,
                          { taskId: task.taskId, runId: run.runId, category: diagCategory, specId: spec.specId }
                        );
                      } catch { /* zero-authority */ }
                    }

                    const boundsCheck = this.repairController.shouldContinueRepair(repairCycle);
                    const missionId =
                      typeof (task.inputPayload as Record<string, unknown> | null)?.missionId === "string"
                        ? ((task.inputPayload as Record<string, unknown>).missionId as string)
                        : undefined;
                    if (!boundsCheck.canContinue) {
                      this.repairController.concludeVerification(repairCycle, 1);
                      haltReason = boundsCheck.reason;
                    } else if (this.repairOrchestrator && missionId) {
                      try {
                        const repairResult = await this.repairOrchestrator.executeRepairSession(
                          missionId,
                          (this.executionProvider as any)?.modelAdapter ?? {
                            generate: async () => ({ action: "NOOP", confidence: 0, reasoning: "Fallback" }),
                          }
                        );
                        if (repairResult.verification?.verified) {
                          this.repairController.concludeVerification(repairCycle, 0);
                          continue;
                        }
                      } catch {
                        this.repairController.concludeVerification(repairCycle, 1);
                      }
                    } else {
                      this.repairController.concludeVerification(repairCycle, 1);
                    }
                  }

                  await disposeWorkspaceSafely("Verification failed").catch(() => {});
                  const errorPayload = {
                    code: haltReason ? "VERIFICATION_FAILED_REPAIR_EXHAUSTED" : "VERIFICATION_FAILED",
                    message: haltReason
                      ? `Verification failed and repair halted: ${haltReason}`
                      : verificationResult.message,
                    details: {
                      specId: spec.specId,
                      reasonCode: verificationResult.reasonCode,
                      details: verificationResult.details,
                      evidenceIds: verificationResult.evidenceIds,
                      verifierId: verificationResult.verifierId,
                      ...(repairCycle
                        ? {
                            repairDiagnosis: repairCycle.lastDiagnosis,
                            repairIterations: repairCycle.iterationCount,
                            repairStage: repairCycle.currentStage,
                            repairHaltReason: repairCycle.terminalReason,
                          }
                        : {}),
                    },
                  };

                  return failRunSafely(errorPayload);
                }
              }
            }
          }

          // Safe workspace cleanup before completing run
          try {
            await disposeWorkspaceSafely("Run completed successfully");
          } catch (cleanupErr: unknown) {
            return failRunSafely({
              code: cleanupErr instanceof ArtifactExportError ? cleanupErr.code : "WORKSPACE_CLEANUP_FAILED",
              message:
                cleanupErr instanceof ArtifactExportError
                  ? cleanupErr.message
                  : `Workspace cleanup failed after execution: ${
                      cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
                    }`,
              details: { workspaceId: workspace?.workspaceId },
            });
          }

          const preMemRun = this.coordinator.getRun(run.runId);
          if (
            this.scopedMemory &&
            vSpecs &&
            vSpecs.length > 0 &&
            preMemRun &&
            preMemRun.status === "RUNNING" &&
            preMemRun.leaseId === lease.leaseId &&
            preMemRun.currentWorkerId === this.workerId
          ) {
            try {
              this.scopedMemory.recordEntry(
                contract.spec.policy.tenantId ?? "tenant-default",
                task.taskId,
                "VERIFIED_EVIDENCE",
                "verifier.worker_runtime",
                JSON.stringify({
                  runId: run.runId,
                  taskId: task.taskId,
                  verifiedSpecs: vSpecs.map((s) => s.specId),
                  verifiedAt: this.clock.nowIso(),
                }),
                {
                  runId: run.runId,
                  agentId: this.workerId,
                  isModelGenerated: false,
                  isIndependentlyVerified: true,
                  idempotencyKey: `m42:worker_verified:${run.runId}`,
                  nowIso: this.clock.nowIso(),
                }
              );
            } catch { /* non-fatal */ }
          }

          if (this.observability) {
            try {
              if (attemptSpan) {
                this.observability.endSpan(attemptSpan.spanId, "OK");
                attemptSpan = undefined;
              }
              this.observability.incrementCounter(
                "emerald_worker_runs_completed_total",
                "Total runs completed by worker",
                { status: "completed", execution_mode: this.telemetry?.getDefaultExecutionMode() ?? "live" }
              );
            } catch { /* zero-authority */ }
          }

          this.coordinator.completeRun(
            run.runId,
            this.workerId,
            lease.leaseId,
            executionResult.output
          );
          return {
            status: "COMPLETED",
            runId: run.runId,
            output: executionResult.output,
          };
        }

        case "TIMED_OUT": {
          if (this.observability && attemptSpan) {
            try {
              this.observability.endSpan(attemptSpan.spanId, "ERROR", executionResult.error?.message ?? "Operation timed out");
              attemptSpan = undefined;
            } catch { /* zero-authority */ }
          }
          await disposeWorkspaceSafely("Run timed out").catch(() => {});
          const reason =
            executionResult.error?.message ?? `Operation exceeded timeout of ${run.timeoutMs}ms`;
          this.coordinator.timeoutRun(run.runId, reason, { workerId: this.workerId, leaseId: lease.leaseId });
          return {
            status: "TIMED_OUT",
            runId: run.runId,
            error: executionResult.error,
          };
        }

        case "CANCELLED": {
          if (this.observability && attemptSpan) {
            try {
              this.observability.endSpan(attemptSpan.spanId, "ERROR", executionResult.error?.message ?? "Operation cancelled");
              attemptSpan = undefined;
            } catch { /* zero-authority */ }
          }
          await disposeWorkspaceSafely("Run cancelled").catch(() => {});
          const reason = executionResult.error?.message ?? "Operation cancelled by provider";
          this.coordinator.cancelRun(run.runId, reason, { workerId: this.workerId, leaseId: lease.leaseId });
          return {
            status: "CANCELLED",
            runId: run.runId,
            error: executionResult.error,
          };
        }

        case "FAILED":
        default: {
          if (executionResult.error?.code === "LEASE_LOST") {
            // Fenced worker must NOT dispose workspace (another worker/recovery may own it)
            // and must NOT attempt state mutation (no lease authority)
            const fenceErr = new LeaseLostError(
              run.runId,
              lease.leaseId,
              this.coordinator.getRun(run.runId)?.leaseId ?? null
            );
            return {
              status: "FENCED",
              runId: run.runId,
              error: fenceErr,
            };
          }

          await disposeWorkspaceSafely("Execution failed").catch(() => {});
          const errorPayload = executionResult.error ?? {
            code: "EXECUTION_FAILED",
            message: "Execution provider reported unhandled failure",
          };
          this.coordinator.failRun(run.runId, errorPayload, this.workerId, lease.leaseId);
          return {
            status: "FAILED",
            runId: run.runId,
            error: errorPayload,
          };
        }
      }
    } catch (err: unknown) {
      if (err instanceof LeaseLostError) {
        return { status: "FENCED", runId: run.runId, error: err };
      }
      throw err;
    } finally {
      if (launchGate) {
        await this.launchCoordinator.release(launchGate).catch(() => {});
        launchGate = undefined;
      }
    }
    } finally {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      renewal.stop();
    }
  }

  /**
   * Probes whether the required isolation environment is available.
   */
  private async checkIsolationAvailability(): Promise<boolean | undefined> {
    if (this.isIsolationAvailableProbe !== undefined) {
      if (typeof this.isIsolationAvailableProbe === "function") {
        return this.isIsolationAvailableProbe();
      }
      return this.isIsolationAvailableProbe;
    }

    if (this.executionProvider.name === "docker") {
      const probe = await DockerExecutionProvider.isAvailable();
      return probe.available;
    }

    return undefined;
  }

  /**
   * Verifies whether the configured execution provider can satisfy the required isolation posture.
   * Isolates provider capabilities and availability checks strictly to runtime infrastructure.
   */
  private async verifyIsolationSatisfaction(
    required: IsolationRequirement,
    policy?: ExecutionPolicy
  ): Promise<{ satisfied: boolean; reason: string }> {
    const isAvailable = await this.checkIsolationAvailability();

    const trustClassification: WorkloadTrustClassification =
      policy?.trustClassification ??
      (required === "ISOLATED"
        ? (policy?.tenantId ? "MULTI_TENANT_WORKLOAD" : "UNTRUSTED_WORKLOAD")
        : "TRUSTED_INTERNAL");

    // UNKNOWN trust classification is permanently rejected fail-closed
    if (trustClassification === "UNKNOWN") {
      return {
        satisfied: false,
        reason: "Workload trust classification is UNKNOWN; rejected fail-closed per security constitution.",
      };
    }

    // MULTI_TENANT_WORKLOAD requires an explicit non-empty tenantId
    if (trustClassification === "MULTI_TENANT_WORKLOAD" && (!policy?.tenantId || policy.tenantId.trim().length === 0)) {
      return {
        satisfied: false,
        reason: "Workload classification 'MULTI_TENANT_WORKLOAD' requires a non-empty tenantId; rejected fail-closed.",
      };
    }

    const providerRole = resolveProviderRole(this.executionProvider);

    // Architectural Distinction: Orchestration vs Physical Execution Provider
    if (providerRole === "ORCHESTRATION") {
      // GovernedAgentExecutionProvider drives multi-turn agent reasoning in the control plane.
      // Physical command sandbox isolation is independently enforced per-action by ToolExecutionGateway Stage 10.
      return { satisfied: true, reason: "" };
    }

    // Physical Execution Providers (e.g. InProcessExecutionProvider, DockerExecutionProvider):
    const routing = evaluateWorkloadExecutionRouting({
      trustClassification,
      requestedProviderName: this.executionProvider.name,
      isSandboxAvailable: isAvailable !== false,
      isDaemonRootless: isAvailable !== false,
      requireRootlessDaemon: policy?.requireRootlessDaemon,
      tenantId: policy?.tenantId,
    });

    if (!routing.allowed) {
      return {
        satisfied: false,
        reason: routing.message,
      };
    }

    if (required === "ISOLATED") {
      // Must not be an in-process provider
      if (this.executionProvider.name === "in-process") {
        return {
          satisfied: false,
          reason: "Policy requires ISOLATED execution, but provider is 'in-process' (no silent in-process downgrade permitted).",
        };
      }

      // Check whether isolated execution environment is operational
      if (isAvailable === false) {
        return {
          satisfied: false,
          reason: "Policy requires ISOLATED execution, but isolated environment (Docker) is unavailable (FAIL CLOSED).",
        };
      }

      return { satisfied: true, reason: "" };
    }

    if (required === "IN_PROCESS") {
      if (this.executionProvider.name !== "in-process") {
        return {
          satisfied: false,
          reason: `Policy requires IN_PROCESS execution, but provider is '${this.executionProvider.name}'.`,
        };
      }
      return { satisfied: true, reason: "" };
    }

    return { satisfied: false, reason: `Unknown isolation requirement: ${required}` };
  }

  /**
   * Associates an existing active workspace with a run for subsequent Action executions.
   */
  setRunWorkspace(
    runId: string,
    workspace: { workspaceId: string; hostPath: string; containerMountPath?: string }
  ): void {
    this.runWorkspaces.set(runId, workspace);
  }

  /**
   * Executes a single governed Action through the complete deterministic lifecycle:
   * Action CREATED -> AUTHORIZED -> RUNNING -> Attempt CREATED -> DISPATCHED -> RUNNING
   * -> ToolExecutionGateway.execute() -> Attempt SUCCEEDED/FAILED/TIMED_OUT/CANCELLED/UNKNOWN
   * -> Action SUCCEEDED/FAILED/TIMED_OUT/CANCELLED.
   */
  async executeAction(params: ExecuteActionParams): Promise<WorkerActionResult> {
    const runId = params.runId;
    const store = this.coordinator.store;

    if (this.observability) {
      try {
        this.observability.incrementCounter(
          "emerald_worker_actions_total",
          "Total actions executed by worker",
          {
            tool_name: params.toolName ?? "unknown",
            execution_mode: this.telemetry?.getDefaultExecutionMode() ?? "live",
          }
        );
      } catch { /* zero-authority */ }
    }

    // 1. Authoritative Run and Lease Resolution
    const run = store.getRun(runId);
    if (!run) {
      throw new Error(`Run '${runId}' not found in authoritative state store`);
    }

    const workerId = this.workerId;
    const leaseId = params.leaseId ?? run.leaseId;
    if (!leaseId) {
      throw new LeaseLostError(runId, "none", run.leaseId);
    }

    const fencing: LeaseFencingCheck = { workerId, leaseId, nowIso: this.clock.nowIso() };

    // Initial fencing verification against authoritative run
    if (run.currentWorkerId !== workerId || run.leaseId !== leaseId) {
      throw new LeaseLostError(runId, leaseId, run.leaseId);
    }

    // 2. Authoritative MissionContract & Ceilings Validation
    if (!run.contractBinding) {
      throw new InvalidContractBindingError(`Run '${runId}' has no bound MissionContract`);
    }

    const boundContract = store.getContract(
      run.contractBinding.contractId,
      run.contractBinding.version
    );
    if (!boundContract) {
      throw new MissingBoundContractError(
        run.contractBinding.contractId,
        run.contractBinding.version
      );
    }

    // Phase 94: Governed Speculative Execution Runtime Fencing
    if (params.speculativeBinding) {
      const binding = params.speculativeBinding;
      if (binding.runId !== runId) {
        throw new Error(`Speculative binding runId '${binding.runId}' does not match target runId '${runId}'`);
      }
      if (binding.workerId !== workerId) {
        throw new LeaseLostError(runId, binding.workerId, workerId);
      }
      if (binding.leaseId !== leaseId) {
        throw new LeaseLostError(runId, binding.leaseId, leaseId);
      }
      if (
        binding.missionContractId !== run.contractBinding.contractId ||
        binding.missionContractHash !== run.contractBinding.contentHash
      ) {
        throw new InvalidContractBindingError(
          `Speculative binding contract hash '${binding.missionContractHash}' does not match bound contract '${run.contractBinding.contentHash}'`
        );
      }
    }

    const existingAction = params.actionId ? store.getAction(params.actionId) : null;

    // Contract lifecycle verification for retries (Requirement 11)
    if (boundContract.lifecycle.status !== "ACTIVE" && existingAction && existingAction.status === "RETRYING") {
      store.transaction((tx) => {
        tx.transitionAction(
          existingAction.actionId,
          {
            type: "FAIL",
            errorPayload: {
              code: boundContract.lifecycle.status === "REVOKED" ? "CONTRACT_REVOKED" : "CONTRACT_NOT_ACTIVE",
              message: `Cannot execute retry: bound MissionContract is ${boundContract.lifecycle.status}`,
            },
            now: this.clock.nowIso(),
          },
          () => crypto.randomUUID(),
          fencing
        );
      });
      return {
        status: "FAILED",
        runId,
        actionId: existingAction.actionId,
        error: {
          code: "CONTRACT_REVOKED",
          message: `Bound MissionContract is ${boundContract.lifecycle.status}`,
        },
      };
    }

    // Non-clamping resource ceilings check on new action and retries (Requirement 12)
    const contractMaxAttempts = boundContract.spec.resourceLimits.maxAttempts;
    if (params.maxAttempts !== undefined && params.maxAttempts > contractMaxAttempts) {
      throw new ResourceLimitExceededError("maxAttempts", params.maxAttempts, contractMaxAttempts);
    }
    if (params.timeoutMs !== undefined && params.timeoutMs > boundContract.spec.resourceLimits.timeoutMs) {
      throw new ResourceLimitExceededError("timeoutMs", params.timeoutMs, boundContract.spec.resourceLimits.timeoutMs);
    }
    if (params.maxOutputBytes !== undefined && params.maxOutputBytes > boundContract.spec.resourceLimits.maxOutputBytes) {
      throw new ResourceLimitExceededError("maxOutputBytes", params.maxOutputBytes, boundContract.spec.resourceLimits.maxOutputBytes);
    }

    // 3. Action Resolution or Creation
    let actionSnapshot: ActionSnapshot;

    if (existingAction) {
      if (isTerminalActionStatus(existingAction.status)) {
        throw new TerminalStateError(existingAction.status, "executeAction");
      }
      actionSnapshot = existingAction;
    } else {
      if (!params.toolName) {
        throw new Error(
          `Cannot create Action: toolName is required when actionId does not refer to an existing Action`
        );
      }

      const effectiveMaxAttempts = params.maxAttempts ?? Math.min(3, contractMaxAttempts);

      let sequenceNumber = params.sequenceNumber;
      if (sequenceNumber === undefined) {
        const existingActions = store.getActionsForRun(runId);
        sequenceNumber = existingActions.length + 1;
      }

      const actionId = params.actionId ?? crypto.randomUUID();
      const now = this.clock.nowIso();

      const { action, event: createdEvent } = Action.create({
        actionId,
        runId,
        sequenceNumber,
        toolName: params.toolName,
        inputPayload: params.inputPayload,
        contractBinding: run.contractBinding,
        maxAttempts: effectiveMaxAttempts,
        now,
      });

      // Persist Action in CREATED state with action.created event (atomic + lease fenced)
      store.transaction((tx) => {
        tx.insertAction(action.snapshot, createdEvent, fencing);
      });

      actionSnapshot = action.snapshot;
    }

    // 3. Workspace resolution
    if (params.workspace) {
      this.runWorkspaces.set(runId, {
        workspaceId: params.workspace.workspaceId,
        hostPath: params.workspace.hostPath,
        containerMountPath: params.workspace.containerMountPath,
      });
    }
    let effectiveWorkspace = params.workspace ?? this.runWorkspaces.get(runId);
    if (!effectiveWorkspace && this.workspacePort) {
      const wsId = `ws-${run.runId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
      const handle = await this.workspacePort.provisionWorkspace(
        {
          workspaceId: wsId,
          runId: run.runId,
          taskId: run.taskId,
          maxWorkspaceBytes: 500 * 1024 * 1024,
          maxFileSizeBytes: 10 * 1024 * 1024,
        },
        { runId: run.runId, leaseId }
      );
      effectiveWorkspace = {
        workspaceId: handle.workspaceId,
        hostPath: handle.hostPath,
        containerMountPath: handle.containerMountPath,
      };
      this.runWorkspaces.set(runId, effectiveWorkspace);
    }

    // 4. Construct ToolRequest & Trusted Context
    const toolRequest: ToolRequest = {
      requestId: actionSnapshot.actionId,
      runId: run.runId,
      toolName: actionSnapshot.toolName,
      input: actionSnapshot.inputPayload as any,
    };

    let contractPolicy: ExecutionPolicy | undefined;
    if (run.contractBinding) {
      const boundContract = this.coordinator.getContract(
        run.contractBinding.contractId,
        run.contractBinding.version
      );
      contractPolicy = boundContract?.spec.policy;
    }

    const toolContext: TrustedToolInvocationContext = {
      runId: run.runId,
      taskId: run.taskId,
      workerId,
      leaseId,
      workspace: effectiveWorkspace,
      abortSignal: params.abortSignal,
      tenantId: contractPolicy?.tenantId,
      trustClassification: contractPolicy?.trustClassification,
      systemVerificationSpecId: params.systemVerificationSpecId,
    };

    // 5. Evaluate Authorization via ToolExecutionGateway
    const decision = await this.toolGateway.authorize(toolRequest, toolContext);

    if (decision.status !== "AUTHORIZED") {
      // Governance denied / invalid: FAIL Action directly from CREATED state.
      // ZERO Attempt is created. ZERO adapter/provider execution.
      const failErrorPayload = decision.errorPayload ?? {
        code: "CAPABILITY_DENIED",
        category: "authorization",
        message: decision.domainError?.message ?? "Tool authorization denied",
      };

      store.transaction((tx) => {
        const res = tx.transitionAction(
          actionSnapshot.actionId,
          {
            type: "FAIL",
            errorPayload: failErrorPayload,
            now: this.clock.nowIso(),
          },
          () => crypto.randomUUID(),
          fencing
        );
        actionSnapshot = res.snapshot;
      });

      if (params.throwOnError && decision.domainError) {
        throw decision.domainError;
      }

      return {
        status: "FAILED",
        actionId: actionSnapshot.actionId,
        runId: run.runId,
        error: failErrorPayload,
        action: actionSnapshot,
      };
    }

    // 5b. Tier-1 replay gate (Milestone 2.10C).
    // A new NON_IDEMPOTENT Action whose (runId, toolName, inputHash) equals that of a prior Action
    // with an UNKNOWN or still-in-flight Attempt is not dispatched. The key is a candidate-equivalence
    // match only: it does not prove an equivalent side effect, and a different payload is not caught.
    // The Action is failed from CREATED with zero Attempts, exactly like an authorization denial.
    if (actionSnapshot.status === "CREATED" && actionSnapshot.idempotency === "NON_IDEMPOTENT") {
      const gateCandidate = actionSnapshot;
      const blocked = store.transaction((tx) => {
        const prior = findUncertainPriorAttempt(
          tx.getActionsForRun(runId),
          (actionId) => tx.getAttemptsForAction(actionId),
          gateCandidate
        );
        if (!prior) {
          return null;
        }
        const errorPayload = {
          code: REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT,
          category: "policy",
          message:
            `Replay blocked: a prior '${gateCandidate.toolName}' action with identical input has an ` +
            `${prior.attemptStatus} attempt; its physical outcome is unresolved and is not retried automatically`,
          details: {
            toolName: gateCandidate.toolName,
            priorActionId: prior.actionId,
            priorAttemptId: prior.attemptId,
            priorAttemptStatus: prior.attemptStatus,
            priorReasonCode: prior.reasonCode,
          },
        };
        const res = tx.transitionAction(
          gateCandidate.actionId,
          { type: "FAIL", errorPayload, now: this.clock.nowIso() },
          () => crypto.randomUUID(),
          fencing
        );
        return { snapshot: res.snapshot, errorPayload };
      });

      if (blocked) {
        return {
          status: "FAILED",
          actionId: blocked.snapshot.actionId,
          runId: run.runId,
          error: blocked.errorPayload,
          action: blocked.snapshot,
        };
      }
    }

    // 6. Action Transition: CREATED -> AUTHORIZED
    if (actionSnapshot.status === "CREATED") {
      store.transaction((tx) => {
        const res = tx.transitionAction(
          actionSnapshot.actionId,
          {
            type: "AUTHORIZE",
            now: this.clock.nowIso(),
          },
          () => crypto.randomUUID(),
          fencing
        );
        actionSnapshot = res.snapshot;
      });
    }

    // 7. Action Transition: AUTHORIZED -> RUNNING or RETRYING -> RUNNING
    let targetAttemptNumber = 1;
    if (actionSnapshot.status === "AUTHORIZED") {
      targetAttemptNumber = 1;
      store.transaction((tx) => {
        const res = tx.transitionAction(
          actionSnapshot.actionId,
          {
            type: "START_ATTEMPT",
            attemptNumber: 1,
            now: this.clock.nowIso(),
          },
          () => crypto.randomUUID(),
          fencing
        );
        actionSnapshot = res.snapshot;
      });
    } else if (actionSnapshot.status === "RETRYING") {
      targetAttemptNumber = actionSnapshot.totalAttempts + 1;
      if (targetAttemptNumber > actionSnapshot.maxAttempts) {
        throw new Error(
          `Cannot retry Action '${actionSnapshot.actionId}': next attempt ${targetAttemptNumber} exceeds maxAttempts (${actionSnapshot.maxAttempts})`
        );
      }
      store.transaction((tx) => {
        const res = tx.transitionAction(
          actionSnapshot.actionId,
          {
            type: "START_ATTEMPT",
            attemptNumber: targetAttemptNumber,
            now: this.clock.nowIso(),
          },
          () => crypto.randomUUID(),
          fencing
        );
        actionSnapshot = res.snapshot;
      });
    } else if (actionSnapshot.status === "RUNNING") {
      targetAttemptNumber = actionSnapshot.activeAttemptNumber ?? actionSnapshot.totalAttempts;
    }

    // 8. Attempt Creation / Resolution
    let attemptSnapshot: AttemptSnapshot;
    const existingAttempt = store.getAttemptByNumber(actionSnapshot.actionId, targetAttemptNumber);
    if (existingAttempt) {
      attemptSnapshot = existingAttempt;

      // 8b. Re-dispatch guard (Milestone 2.11A).
      // An existing Attempt that is anything other than CREATED (DISPATCHED, RUNNING, or an UNKNOWN or
      // other terminal Attempt under a still-open Action) means a prior dispatch of this Action may have
      // reached the adapter. For a NON_IDEMPOTENT tool the adapter is not invoked again. The Attempt and
      // Action are left unchanged: lease expiry is not proof the earlier process stopped, so
      // reconciliation stays with recovery. A CREATED Attempt was never dispatched and proceeds.
      if (actionSnapshot.idempotency === "NON_IDEMPOTENT" && existingAttempt.status !== "CREATED") {
        return {
          status: "FAILED",
          actionId: actionSnapshot.actionId,
          runId: run.runId,
          attemptId: existingAttempt.attemptId,
          error: {
            code: RESUME_BLOCKED_PRIOR_DISPATCH,
            category: "policy",
            message:
              `Re-dispatch blocked: this '${actionSnapshot.toolName}' action already has an ` +
              `${existingAttempt.status} attempt; its physical outcome is unresolved and is not retried automatically`,
            details: {
              toolName: actionSnapshot.toolName,
              attemptStatus: existingAttempt.status,
            },
          },
          action: actionSnapshot,
          attempt: existingAttempt,
        };
      }
    } else {
      const attemptId = crypto.randomUUID();
      const idempotencyToken = createAttemptIdempotencyToken(
        run.runId,
        actionSnapshot.actionId,
        targetAttemptNumber
      );
      const { attempt, event: attemptCreatedEvent } = Attempt.create({
        attemptId,
        actionId: actionSnapshot.actionId,
        runId: run.runId,
        attemptNumber: targetAttemptNumber,
        workerId,
        leaseId,
        idempotencyToken,
        now: this.clock.nowIso(),
      });

      store.transaction((tx) => {
        tx.insertAttempt(attempt.snapshot, attemptCreatedEvent, fencing);
      });
      attemptSnapshot = attempt.snapshot;
    }

    // 9. Attempt Transition: CREATED -> DISPATCHED (if not already dispatched)
    if (attemptSnapshot.status === "CREATED") {
      store.transaction((tx) => {
        const res = tx.transitionAttempt(
          attemptSnapshot.attemptId,
          {
            type: "DISPATCH",
            now: this.clock.nowIso(),
          },
          () => crypto.randomUUID(),
          fencing
        );
        attemptSnapshot = res.snapshot;
      });
    }

    // 10. Attempt Transition: DISPATCHED -> RUNNING (if not already running)
    if (attemptSnapshot.status === "DISPATCHED") {
      store.transaction((tx) => {
        const res = tx.transitionAttempt(
          attemptSnapshot.attemptId,
          {
            type: "START",
            now: this.clock.nowIso(),
          },
          () => crypto.randomUUID(),
          fencing
        );
        attemptSnapshot = res.snapshot;
      });
    }

    // 11. Physical Tool Execution via Gateway Seam
    let toolResult: ToolResult;
    try {
      toolResult = await this.toolGateway.execute(toolRequest, toolContext, { throwOnError: false });
    } catch (err: unknown) {
      if (err instanceof LeaseLostError) {
        throw err;
      }
      toolResult = {
        requestId: actionSnapshot.actionId,
        toolName: actionSnapshot.toolName,
        status: "FAILED",
        error: {
          code: "TOOL_EXECUTION_FAILED",
          category: "execution",
          message: err instanceof Error ? err.message : String(err),
        },
        durationMs: 0,
      };
    }

    // 12. Map Result into Attempt and Action (atomic dual-transition in single transaction)
    const now = this.clock.nowIso();

    if (toolResult.status === "SUCCESS") {
      store.transaction((tx) => {
        const attRes = tx.transitionAttempt(
          attemptSnapshot.attemptId,
          {
            type: "COMPLETE",
            outputPayload: toolResult.output,
            exitCode: (toolResult.output as any)?.exitCode ?? 0,
            durationMs: toolResult.durationMs,
            now,
          },
          () => crypto.randomUUID(),
          fencing
        );
        attemptSnapshot = attRes.snapshot;

        const actRes = tx.transitionAction(
          actionSnapshot.actionId,
          {
            type: "SUCCEED",
            resultPayload: toolResult.output,
            now,
          },
          () => crypto.randomUUID(),
          fencing
        );
        actionSnapshot = actRes.snapshot;
      });

      return {
        status: "SUCCEEDED",
        actionId: actionSnapshot.actionId,
        runId: run.runId,
        attemptId: attemptSnapshot.attemptId,
        output: toolResult.output,
        action: actionSnapshot,
        attempt: attemptSnapshot,
      };
    }

    // Handle failure modes
    const errorCode = toolResult.error?.code;
    const errorCodeStr = String(errorCode ?? "");

    // Timeout
    if (errorCode === "TOOL_TIMEOUT") {
      store.transaction((tx) => {
        const attRes = tx.transitionAttempt(
          attemptSnapshot.attemptId,
          {
            type: "TIMEOUT",
            errorPayload: toolResult.error,
            durationMs: toolResult.durationMs,
            now,
          },
          () => crypto.randomUUID(),
          fencing
        );
        attemptSnapshot = attRes.snapshot;

        const actRes = tx.transitionAction(
          actionSnapshot.actionId,
          {
            type: "TIMEOUT",
            reason: toolResult.error,
            now,
          },
          () => crypto.randomUUID(),
          fencing
        );
        actionSnapshot = actRes.snapshot;
      });

      return {
        status: "TIMED_OUT",
        actionId: actionSnapshot.actionId,
        runId: run.runId,
        attemptId: attemptSnapshot.attemptId,
        error: toolResult.error,
        action: actionSnapshot,
        attempt: attemptSnapshot,
      };
    }

    // Cancellation
    if (errorCode === "TOOL_CANCELLED" || params.abortSignal?.aborted) {
      store.transaction((tx) => {
        const attRes = tx.transitionAttempt(
          attemptSnapshot.attemptId,
          {
            type: "CANCEL",
            reason: toolResult.error ?? "Tool execution cancelled",
            now,
          },
          () => crypto.randomUUID(),
          fencing
        );
        attemptSnapshot = attRes.snapshot;

        const actRes = tx.transitionAction(
          actionSnapshot.actionId,
          {
            type: "CANCEL",
            reason: toolResult.error ?? "Tool execution cancelled",
            now,
          },
          () => crypto.randomUUID(),
          fencing
        );
        actionSnapshot = actRes.snapshot;
      });

      return {
        status: "CANCELLED",
        actionId: actionSnapshot.actionId,
        runId: run.runId,
        attemptId: attemptSnapshot.attemptId,
        error: toolResult.error,
        action: actionSnapshot,
        attempt: attemptSnapshot,
      };
    }

    // UNKNOWN uncertainty
    const detailsCode = String((toolResult.error as any)?.details?.code ?? "");
    const errorMsg = String(toolResult.error?.message ?? "");
    const isUnknownUncertainty =
      errorCodeStr === "EXECUTION_UNCERTAIN" ||
      errorCodeStr === "PROVIDER_RESULT_UNAVAILABLE" ||
      errorCodeStr === "WORKER_CRASHED" ||
      errorCodeStr === "LEASE_EXPIRED_DURING_EXECUTION" ||
      errorCodeStr === "PROCESS_TERMINATION_BEFORE_PERSISTENCE" ||
      detailsCode === "PROVIDER_RESULT_UNAVAILABLE" ||
      detailsCode === "EXECUTION_UNCERTAIN" ||
      detailsCode === "WORKER_CRASHED" ||
      detailsCode === "LEASE_EXPIRED_DURING_EXECUTION" ||
      detailsCode === "PROCESS_TERMINATION_BEFORE_PERSISTENCE" ||
      errorMsg.includes("PROVIDER_RESULT_UNAVAILABLE") ||
      errorMsg.includes("EXECUTION_UNCERTAIN");

    if (isUnknownUncertainty) {
      const reasonCode = (
        ((toolResult.error as any)?.reasonCode ??
        ((toolResult.error as any)?.details?.reasonCode ??
        ((toolResult.error as any)?.details?.code ??
        (errorMsg.includes("PROVIDER_RESULT_UNAVAILABLE")
          ? "PROVIDER_RESULT_UNAVAILABLE"
          : errorCodeStr))))
      ) as AttemptUnknownReason;
      store.transaction((tx) => {
        const attRes = tx.transitionAttempt(
          attemptSnapshot.attemptId,
          {
            type: "MARK_UNKNOWN",
            reason: toolResult.error?.message ?? "Execution uncertainty",
            reasonCode,
            now,
          },
          () => crypto.randomUUID(),
          fencing
        );
        attemptSnapshot = attRes.snapshot;

        const actRes = tx.transitionAction(
          actionSnapshot.actionId,
          {
            type: "FAIL",
            errorPayload: toolResult.error,
            now,
          },
          () => crypto.randomUUID(),
          fencing
        );
        actionSnapshot = actRes.snapshot;
      });

      return {
        status: "UNKNOWN",
        actionId: actionSnapshot.actionId,
        runId: run.runId,
        attemptId: attemptSnapshot.attemptId,
        error: toolResult.error,
        action: actionSnapshot,
        attempt: attemptSnapshot,
      };
    }

    // Deterministic Failure
    store.transaction((tx) => {
      const attRes = tx.transitionAttempt(
        attemptSnapshot.attemptId,
        {
          type: "FAIL",
          errorPayload: toolResult.error,
          exitCode: (toolResult.error as any)?.exitCode ?? null,
          durationMs: toolResult.durationMs,
          now,
        },
        () => crypto.randomUUID(),
        fencing
      );
      attemptSnapshot = attRes.snapshot;

      // If autoRetry requested and tool is idempotent and attempts remain, transition to RETRYING
      if (
        params.autoRetry &&
        actionSnapshot.idempotency === "IDEMPOTENT" &&
        targetAttemptNumber < actionSnapshot.maxAttempts
      ) {
        const actRes = tx.transitionAction(
          actionSnapshot.actionId,
          {
            type: "PREPARE_RETRY",
            errorPayload: toolResult.error,
            now,
          },
          () => crypto.randomUUID(),
          fencing
        );
        actionSnapshot = actRes.snapshot;
      } else {
        const actRes = tx.transitionAction(
          actionSnapshot.actionId,
          {
            type: "FAIL",
            errorPayload: toolResult.error,
            now,
          },
          () => crypto.randomUUID(),
          fencing
        );
        actionSnapshot = actRes.snapshot;
      }
    });

    return {
      status: actionSnapshot.status === "RETRYING" ? "FAILED" : "FAILED",
      actionId: actionSnapshot.actionId,
      runId: run.runId,
      attemptId: attemptSnapshot.attemptId,
      error: toolResult.error,
      action: actionSnapshot,
      attempt: attemptSnapshot,
    };
  }

  /**
   * Recovers stale executions across runs.
   * Reconciles stale/orphan in-flight Attempts and Actions to durable states (UNKNOWN, FAILED, RETRYING)
   * via the RunCoordinator, and optionally executes eligible retries under this worker's lease.
   */
  async recoverStaleExecutions(
    options: StaleExecutionRecoveryOptions & { executeRetries?: boolean } = {}
  ): Promise<WorkerStaleRecoveryResult> {
    const nowIso = options.nowIso ?? this.clock.nowIso();

    // 1. Reconcile stale actions and attempts via coordinator
    const coordinatorResult = this.coordinator.recoverStaleExecutions({
      runId: options.runId,
      nowIso,
      maxRuns: options.maxRuns,
    });

    const retriedActionResults: WorkerActionResult[] = [];

    // 2. If executeRetries !== false, execute any eligible RETRYING actions
    if (options.executeRetries !== false) {
      const store = this.coordinator.store;
      const actionsToRetry: ActionSnapshot[] = [];

      if (options.runId) {
        const runActions = store.getActionsForRun(options.runId);
        actionsToRetry.push(...runActions.filter((a) => a.status === "RETRYING"));
      } else {
        const inFlight = store.findInFlightActions ? store.findInFlightActions(options.maxRuns ?? 50) : [];
        actionsToRetry.push(...inFlight.filter((a) => a.status === "RETRYING"));
      }

      for (const action of actionsToRetry) {
        const priorAttempts = store.getAttemptsForAction(action.actionId);
        const eligibility = evaluateRetryEligibility(action, priorAttempts[priorAttempts.length - 1]);
        if (eligibility.eligible) {
          const run = store.getRun(action.runId);
          if (run && (run.status === "RUNNING" || run.status === "LEASED")) {
            if (run.currentWorkerId === this.workerId) {
              const res = await this.executeAction({
                runId: action.runId,
                actionId: action.actionId,
              });
              retriedActionResults.push(res);
            }
          }
        }
      }
    }

    return {
      coordinatorResult,
      retriedActions: retriedActionResults,
    };
  }
}

