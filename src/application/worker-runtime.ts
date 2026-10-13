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
} from "../domain/attempt.js";
import { AttemptUnknownReason } from "../domain/events.js";
import { computeCanonicalHash } from "../domain/canonical-hash.js";
import {
  ContractIntegrityError,
  InvalidContractBindingError,
  InvalidMissionContractError,
  InvalidRunError,
  LeaseLostError,
  MissingBoundContractError,
  ResourceLimitExceededError,
  TerminalStateError,
} from "../domain/errors.js";
import {
  createOutputPayloadEvidence,
  createProcessExitEvidence,
  Evidence,
} from "../domain/evidence.js";
import { MissionContract } from "../domain/mission-contract.js";
import { DeterministicOperation, EchoOperation } from "../domain/operation.js";
import {
  ExecutionPolicy,
  IsolationRequirement,
  PolicyEvaluator,
} from "../domain/policy.js";
import {
  ToolName,
  ToolRequest,
  ToolResult,
} from "../domain/tool.js";
import { DeterministicVerifier, VerificationSpec } from "../domain/verification.js";
import { Workspace } from "../domain/workspace.js";
import { ClockPort, SystemClock } from "../ports/clock.port.js";
import { ExecutionProvider, ExecutionRequest, ExecutionResult } from "../ports/execution-provider.port.js";
import { LeaseFencingCheck, WorkerRecord } from "../ports/state-store.port.js";
import { ToolAdapterRegistryPort } from "../ports/tool-adapter.port.js";
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

export type WorkerRunResult =
  | { readonly status: "IDLE" }
  | { readonly status: "COMPLETED"; readonly runId: string; readonly output: unknown }
  | { readonly status: "FAILED"; readonly runId: string; readonly error: unknown }
  | { readonly status: "TIMED_OUT"; readonly runId: string; readonly error: unknown }
  | { readonly status: "CANCELLED"; readonly runId: string; readonly error: unknown }
  | { readonly status: "FENCED"; readonly runId: string; readonly error: LeaseLostError };

export type WorkerActionStatus =
  | "SUCCEEDED"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELLED"
  | "UNKNOWN"
  | "FENCED";

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
  readonly toolName?: ToolName;
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
}

export interface WorkerRuntimeOptions {
  readonly workerId?: string;
  readonly hostname?: string;
  readonly pid?: number;
  readonly coordinator: RunCoordinator;
  readonly clock?: ClockPort;
  readonly leaseTtlMs?: number;
  readonly executionProvider?: ExecutionProvider;
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
  private readonly executionProvider: ExecutionProvider;
  private readonly workspacePort?: WorkspacePort;
  private readonly ephemeralPolicy?: ExecutionPolicy;
  private readonly ephemeralVerificationSpec?:
    | VerificationSpec
    | ((request: ExecutionRequest) => VerificationSpec | undefined);
  private readonly policyEvaluator: PolicyEvaluator;
  private readonly isIsolationAvailableProbe?: boolean | (() => Promise<boolean>);
  private readonly toolGateway: ToolExecutionGateway;
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
    this.leaseTtlMs = options.leaseTtlMs ?? 10000;
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

    if (options.toolGateway) {
      this.toolGateway = options.toolGateway;
    } else {
      const adapterRegistry =
        options.toolAdapterRegistry ??
        (this.workspacePort
          ? createWorkspaceToolAdapterRegistry(this.workspacePort, this.executionProvider)
          : undefined);

      this.toolGateway = new ToolExecutionGateway({
        toolRegistry: options.toolRegistry,
        adapterRegistry,
        coordinator: this.coordinator,
        policyEvaluator: this.policyEvaluator,
        clock: this.clock,
        isIsolationAvailable: this.isIsolationAvailableProbe,
      });
    }
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
  async runOnce(targetRunId?: string): Promise<WorkerRunResult> {
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
      if (err instanceof LeaseLostError) {
        return { status: "FENCED", runId: run.runId, error: err };
      }
      throw err;
    }

    const failRunSafely = (errorPayload: {
      code: string;
      message: string;
      details?: unknown;
    }): WorkerRunResult => {
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

    // Construct ExecutionRequest
    let request: ExecutionRequest = {
      runId: run.runId,
      taskId: task.taskId,
      operationName: task.title,
      inputPayload: task.inputPayload,
      idempotencyToken: run.idempotencyKey ?? run.runId,
      attemptNumber: run.attemptCount,
      timeoutMs: run.timeoutMs,
    };

    // 7. Evaluate Policy from MissionContract (Sections 8, 10)
    const policy = contract.spec.policy;
    const policyDecision = this.policyEvaluator.evaluate(request, policy);

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
      policyDecision.isolationRequirement
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

    // 9. Workspace Provisioning & Sandbox Boundary (if WorkspacePort is configured)
    let workspace: Workspace | undefined;
    let workspaceHandle: WorkspaceHandle | undefined;

    if (this.workspacePort) {
      // 9a. Workspace identity: distinct from runId
      const workspaceId = `ws-${run.runId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;

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

      // 9c. Provision isolated filesystem directory in adapter
      try {
        workspaceHandle = await this.workspacePort.provisionWorkspace(workspace.spec);
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
        await this.workspacePort.disposeWorkspace(workspaceId).catch(() => {});
        return failRunSafely({
          code: "WORKSPACE_BOUNDARY_FAILURE",
          message: "Workspace handle returned by adapter failed containment or identity check",
          details: { workspaceId },
        });
      }

      // 9e. Transition domain aggregate: READY and LEASED
      const readyEvent = workspace.markReady({
        hostPath: workspaceHandle.hostPath,
        containerMountPath: workspaceHandle.containerMountPath,
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

      // Lease fencing check: if this worker lost the lease, do NOT delete or mutate!
      try {
        const currentRun = this.coordinator.getRun(run.runId);
        if (
          currentRun &&
          (currentRun.leaseId !== lease.leaseId || currentRun.currentWorkerId !== this.workerId)
        ) {
          // Stale worker is fenced!
          return;
        }
      } catch {
        // Continue
      }

      try {
        const cleaningEvent = workspace.startCleaning({
          reason,
          workerId: this.workerId,
          leaseId: lease.leaseId,
          now: this.clock.nowIso(),
        });
        this.coordinator.recordWorkspaceEvent(cleaningEvent, fencing);
      } catch (fencingErr: unknown) {
        if (fencingErr instanceof LeaseLostError) {
          return;
        }
        // State machine guard: continue to attempt physical disposal if not fenced
      }

      try {
        await this.workspacePort.disposeWorkspace(workspace.workspaceId);
        workspaceDisposed = true;
        const disposedEvent = workspace.markDisposed({ now: this.clock.nowIso() });
        this.coordinator.recordWorkspaceEvent(disposedEvent, fencing);
      } catch (err: unknown) {
        if (err instanceof LeaseLostError) {
          return;
        }
        const failedEvent = workspace.markFailed({
          errorMessage: `Workspace disposal failed: ${err instanceof Error ? err.message : String(err)}`,
          now: this.clock.nowIso(),
        });
        this.coordinator.recordWorkspaceEvent(failedEvent);
        throw err;
      }
    };

    // 10. Delegate to ExecutionProvider ONLY NOW
    let executionResult: ExecutionResult;
    try {
      executionResult = await this.executionProvider.execute(request);
    } catch (providerError: unknown) {
      await disposeWorkspaceSafely("Execution provider threw unexpected exception").catch(() => {});
      throw providerError;
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
    try {
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

            for (const evidence of evidenceList) {
              this.coordinator.recordEvidence(run.runId, evidence);
            }

            for (const spec of vSpecs) {
              const verificationResult = DeterministicVerifier.verify(evidenceList, spec);
              this.coordinator.recordVerificationResult(run.runId, verificationResult);

              if (verificationResult.status !== "VERIFIED") {
                await disposeWorkspaceSafely("Verification failed").catch(() => {});
                const errorPayload = {
                  code: "VERIFICATION_FAILED",
                  message: verificationResult.message,
                  details: {
                    specId: spec.specId,
                    reasonCode: verificationResult.reasonCode,
                    details: verificationResult.details,
                    evidenceIds: verificationResult.evidenceIds,
                    verifierId: verificationResult.verifierId,
                  },
                };

                return failRunSafely(errorPayload);
              }
            }
          }

          // Safe workspace cleanup before completing run
          try {
            await disposeWorkspaceSafely("Run completed successfully");
          } catch (cleanupErr: unknown) {
            return failRunSafely({
              code: "WORKSPACE_CLEANUP_FAILED",
              message: `Workspace cleanup failed after execution: ${
                cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
              }`,
              details: { workspaceId: workspace?.workspaceId },
            });
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
          await disposeWorkspaceSafely("Run timed out").catch(() => {});
          const reason =
            executionResult.error?.message ?? `Operation exceeded timeout of ${run.timeoutMs}ms`;
          this.coordinator.timeoutRun(run.runId, reason);
          return {
            status: "TIMED_OUT",
            runId: run.runId,
            error: executionResult.error,
          };
        }

        case "CANCELLED": {
          await disposeWorkspaceSafely("Run cancelled").catch(() => {});
          const reason = executionResult.error?.message ?? "Operation cancelled by provider";
          this.coordinator.cancelRun(run.runId, reason);
          return {
            status: "CANCELLED",
            runId: run.runId,
            error: executionResult.error,
          };
        }

        case "FAILED":
        default: {
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
    required: IsolationRequirement
  ): Promise<{ satisfied: boolean; reason: string }> {
    if (required === "ISOLATED") {
      // Must not be an in-process provider
      if (this.executionProvider.name === "in-process") {
        return {
          satisfied: false,
          reason: "Policy requires ISOLATED execution, but provider is 'in-process' (no silent in-process downgrade permitted).",
        };
      }

      // Check whether isolated execution environment is operational
      const isAvailable = await this.checkIsolationAvailability();
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

    const fencing: LeaseFencingCheck = { workerId, leaseId };

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
      const handle = await this.workspacePort.provisionWorkspace({
        workspaceId: wsId,
        runId: run.runId,
        taskId: run.taskId,
        maxWorkspaceBytes: 500 * 1024 * 1024,
        maxFileSizeBytes: 10 * 1024 * 1024,
      });
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

    const toolContext: TrustedToolInvocationContext = {
      runId: run.runId,
      taskId: run.taskId,
      workerId,
      leaseId,
      workspace: effectiveWorkspace,
      abortSignal: params.abortSignal,
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
        const eligibility = evaluateRetryEligibility(action);
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

