import { DockerExecutionProvider } from "../adapters/execution/docker-execution-provider.js";
import { InProcessExecutionProvider } from "../adapters/execution/in-process-execution-provider.js";
import { computeCanonicalHash } from "../domain/canonical-hash.js";
import {
  ContractIntegrityError,
  InvalidMissionContractError,
  InvalidRunError,
  LeaseLostError,
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
import { DeterministicVerifier, VerificationSpec } from "../domain/verification.js";
import { ClockPort, SystemClock } from "../ports/clock.port.js";
import { ExecutionProvider, ExecutionRequest } from "../ports/execution-provider.port.js";
import { WorkerRecord } from "../ports/state-store.port.js";
import { ClaimRunResult, RunCoordinator } from "./run-coordinator.js";

export type WorkerRunResult =
  | { readonly status: "IDLE" }
  | { readonly status: "COMPLETED"; readonly runId: string; readonly output: unknown }
  | { readonly status: "FAILED"; readonly runId: string; readonly error: unknown }
  | { readonly status: "TIMED_OUT"; readonly runId: string; readonly error: unknown }
  | { readonly status: "CANCELLED"; readonly runId: string; readonly error: unknown }
  | { readonly status: "FENCED"; readonly runId: string; readonly error: LeaseLostError };

export interface WorkerRuntimeOptions {
  readonly workerId?: string;
  readonly hostname?: string;
  readonly pid?: number;
  readonly coordinator: RunCoordinator;
  readonly clock?: ClockPort;
  readonly leaseTtlMs?: number;
  readonly executionProvider?: ExecutionProvider;
  readonly operations?: readonly DeterministicOperation[] | DeterministicOperation;
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
  private readonly ephemeralPolicy?: ExecutionPolicy;
  private readonly ephemeralVerificationSpec?:
    | VerificationSpec
    | ((request: ExecutionRequest) => VerificationSpec | undefined);
  private readonly policyEvaluator: PolicyEvaluator;
  private readonly isIsolationAvailableProbe?: boolean | (() => Promise<boolean>);

  constructor(options: WorkerRuntimeOptions) {
    this.workerId = options.workerId ?? crypto.randomUUID();
    this.hostname = options.hostname ?? "localhost";
    this.pid = options.pid ?? (typeof process !== "undefined" && process.pid ? process.pid : 1);
    this.coordinator = options.coordinator;
    this.clock = options.clock ?? new SystemClock();
    this.leaseTtlMs = options.leaseTtlMs ?? 10000;
    this.policyEvaluator = options.policyEvaluator ?? new PolicyEvaluator();
    this.isIsolationAvailableProbe = options.isIsolationAvailable;
    this.ephemeralPolicy = options.policy;
    this.ephemeralVerificationSpec = options.verificationSpec;

    if (options.executionProvider) {
      this.executionProvider = options.executionProvider;
    } else {
      this.executionProvider = new InProcessExecutionProvider(
        options.operations ?? [new EchoOperation()]
      );
    }
  }

  /**
   * Reference to the configured execution provider.
   */
  get provider(): ExecutionProvider {
    return this.executionProvider;
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
        code: "MISSING_BOUND_CONTRACT",
        message: `Run '${run.runId}' has no bound MissionContract`,
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
    const request: ExecutionRequest = {
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

    // 9. Delegate to ExecutionProvider ONLY NOW (Sections 1, 15)
    const executionResult = await this.executionProvider.execute(request);

    // 10. Process ExecutionResult and apply governed verification (Section 12)
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
}

