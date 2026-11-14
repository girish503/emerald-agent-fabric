/**
 * Governed Agent Execution Provider for Emerald Agent Fabric.
 *
 * Implements ExecutionProvider (src/ports/execution-provider.port.ts) to bridge
 * the durable WorkerRuntime task execution boundary to the governed autonomous
 * reasoning loop orchestrated by AgentStepController.
 *
 * Architectural Invariants:
 * 1. Hexagonal Inversion: Implements the application ExecutionProvider port. Free
 *    of any direct UI or external protocol dependencies.
 * 2. Model != Authority: The model is strictly an untrusted reasoning component.
 *    Proposals generated during step execution must pass through ProposalValidator,
 *    ReflexPort, and PolicyEvaluator before reaching ToolExecutionGateway.
 * 3. Zero Direct State Mutation: This adapter does NOT mutate Run state, commit
 *    terminal transitions (completeRun, failRun), or release leases. It returns
 *    a typed ExecutionResult to WorkerRuntime, which owns state machine transitions.
 * 4. Cooperative Cancellation: Propagates request.signal through to AgentStepController
 *    and maps cancellation outcomes to typed ExecutionResult { status: "CANCELLED" }.
 * 5. Explicit Timeouts: request.timeoutMs is enforced as a wall-clock ceiling in
 *    AgentStepController and mapped to ExecutionResult { status: "TIMED_OUT" }.
 * 6. Tenant Quiescence: Declares tenantModel = "NONE" (in-process execution). A dead
 *    worker leaves no background child processes or containers from this provider.
 * 7. Deterministic Testing: Fully testable using deterministic offline mock brains
 *    and fixtures with ₹0 cost, zero network traffic, and zero model downloads.
 */

import { ClockPort, SystemClock } from "../../ports/clock.port.js";
import { LeaseExpiredError, LeaseLostError } from "../../domain/errors.js";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
  ProviderCancellationModel,
} from "../../ports/execution-provider.port.js";
import { TenantModel } from "../../ports/tenant-quiescence.port.js";
import {
  AgentStepController,
  RunStepLoopParams,
  StepControllerBudget,
  StepControllerResult,
} from "../../application/agent-step-controller.js";

export interface GovernedAgentExecutionProviderOptions {
  /**
   * Custom provider name. Defaults to "governed-agent".
   */
  readonly name?: string;

  /**
   * Pre-configured AgentStepController instance.
   */
  readonly stepController?: AgentStepController;

  /**
   * Dynamic factory allowing lazy resolution or per-request instantiation of AgentStepController.
   */
  readonly stepControllerFactory?: (
    request: ExecutionRequest
  ) => AgentStepController | Promise<AgentStepController>;

  /**
   * Clock port for execution duration measurement. Defaults to SystemClock.
   */
  readonly clock?: ClockPort;

  /**
   * Default step controller budget overrides (e.g. maxSteps, maxActions).
   */
  readonly defaultBudget?: Partial<StepControllerBudget>;
}

export class GovernedAgentExecutionProvider implements ExecutionProvider {
  readonly name: string;
  readonly role = "ORCHESTRATION" as const;
  readonly tenantModel: TenantModel = "NONE";
  readonly cancellationModel: ProviderCancellationModel = "COOPERATIVE";

  private stepController?: AgentStepController;
  private readonly stepControllerFactory?: (
    request: ExecutionRequest
  ) => AgentStepController | Promise<AgentStepController>;
  private readonly clock: ClockPort;
  private readonly defaultBudget?: Partial<StepControllerBudget>;

  constructor(options: GovernedAgentExecutionProviderOptions = {}) {
    this.name = options.name ?? "governed-agent";
    this.stepController = options.stepController;
    this.stepControllerFactory = options.stepControllerFactory;
    this.clock = options.clock ?? new SystemClock();
    this.defaultBudget = options.defaultBudget;
  }

  /**
   * Returns the clock configured on this provider.
   */
  get providerClock(): ClockPort {
    return this.clock;
  }

  /**
   * Configures or updates the backing AgentStepController instance.
   * Useful when resolving circular initialization dependencies between
   * WorkerRuntime and AgentStepController.
   */
  setStepController(stepController: AgentStepController): void {
    this.stepController = stepController;
  }

  /**
   * Returns whether a step controller or factory is currently configured.
   */
  hasStepController(): boolean {
    return Boolean(this.stepController || this.stepControllerFactory);
  }

  /**
   * Executes a governed agent task across multi-step reasoning turns.
   *
   * Translates the incoming ExecutionRequest into AgentStepController.runStepLoop()
   * parameters and maps the resulting StepControllerResult into the canonical
   * ExecutionResult contract expected by WorkerRuntime.
   */
  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    const startTimeMonotonic = performance.now();

    // 1. Cooperative cancellation check prior to dispatch
    if (request.signal?.aborted) {
      return {
        status: "CANCELLED",
        durationMs: 0,
        error: {
          code: "EXECUTION_CANCELLED",
          message: request.signal.reason
            ? String(request.signal.reason)
            : "Execution was cancelled prior to dispatch",
        },
      };
    }

    // 2. Resolve AgentStepController
    let controller: AgentStepController | undefined = this.stepController;
    if (this.stepControllerFactory) {
      try {
        controller = await this.stepControllerFactory(request);
      } catch (factoryErr: unknown) {
        const durationMs = Math.max(
          0,
          Math.round(performance.now() - startTimeMonotonic)
        );
        return {
          status: "FAILED",
          durationMs,
          error: {
            code: "PROVIDER_UNAVAILABLE",
            message: `Failed to resolve AgentStepController: ${
              factoryErr instanceof Error ? factoryErr.message : String(factoryErr)
            }`,
          },
        };
      }
    }

    if (!controller) {
      const durationMs = Math.max(
        0,
        Math.round(performance.now() - startTimeMonotonic)
      );
      return {
        status: "FAILED",
        durationMs,
        error: {
          code: "PROVIDER_UNAVAILABLE",
          message:
            "No AgentStepController configured on GovernedAgentExecutionProvider",
        },
      };
    }

    // 3. Map workspace mount if present
    let workspaceParam: RunStepLoopParams["workspace"] = undefined;
    if (request.workspace) {
      workspaceParam = {
        workspaceId: request.workspace.workspaceId ?? `ws-${request.runId}`,
        hostPath: request.workspace.hostPath,
        containerMountPath: request.workspace.containerMountPath,
      };
    }

    // 4. Assemble execution budgets with timeout ceiling
    const budget: Partial<StepControllerBudget> = {
      ...this.defaultBudget,
      ...(request.timeoutMs > 0 ? { maxWallClockMs: request.timeoutMs } : {}),
    };

    // 5. Construct RunStepLoopParams
    const stepParams: RunStepLoopParams = {
      runId: request.runId,
      workerId: request.workerId ?? "worker-anonymous",
      leaseId: request.leaseId ?? "lease-none",
      workspace: workspaceParam,
      budget,
      abortSignal: request.signal,
    };

    // 6. Execute step loop under governance
    try {
      const stepResult = await controller.runStepLoop(stepParams);
      const durationMs = Math.max(
        0,
        Math.round(performance.now() - startTimeMonotonic)
      );

      return this.mapStepResult<TOutput>(stepResult, durationMs);
    } catch (err: unknown) {
      const durationMs = Math.max(
        0,
        Math.round(performance.now() - startTimeMonotonic)
      );

      // Lease expiry / loss takes precedence over cancellation or timeout
      if (err instanceof LeaseLostError || err instanceof LeaseExpiredError) {
        return {
          status: "FAILED",
          durationMs,
          error: {
            code: "LEASE_LOST",
            message: err.message,
            details: { error: String(err) },
          },
          providerMetadata: {
            providerName: this.name,
            terminalReason: "LEASE_LOST",
            executedAt: this.clock.nowIso(),
          },
        };
      }

      // Check if abort signal triggered during execution
      if (request.signal?.aborted) {
        return {
          status: "CANCELLED",
          durationMs,
          error: {
            code: "EXECUTION_CANCELLED",
            message: request.signal.reason
              ? String(request.signal.reason)
              : "Execution was cancelled by abort signal",
            details: { error: err instanceof Error ? err.message : String(err) },
          },
        };
      }

      return {
        status: "FAILED",
        durationMs,
        error: {
          code: "EXECUTION_FAILED",
          message: err instanceof Error ? err.message : String(err),
          details: { error: String(err) },
        },
      };
    }
  }

  /**
   * Maps StepControllerResult to canonical ExecutionResult contract.
   */
  private mapStepResult<TOutput>(
    stepResult: StepControllerResult,
    durationMs: number
  ): ExecutionResult<TOutput> {
    const providerMetadata = {
      providerName: this.name,
      terminalReason: stepResult.terminalReason,
      totalSteps: stepResult.totalSteps,
      totalActions: stepResult.totalActions,
      totalProposalRejections: stepResult.totalProposalRejections,
      executedAt: this.clock.nowIso(),
    };

    switch (stepResult.terminalReason) {
      case "COMPLETED": {
        const outputPayload = {
          runId: stepResult.runId,
          taskId: stepResult.taskId,
          terminalReason: stepResult.terminalReason,
          terminalMessage: stepResult.terminalMessage,
          totalSteps: stepResult.totalSteps,
          totalActions: stepResult.totalActions,
          totalProposalRejections: stepResult.totalProposalRejections,
          totalConsecutiveFailures: stepResult.totalConsecutiveFailures,
          totalWallClockMs: stepResult.totalWallClockMs,
          transcript: stepResult.transcript,
        } as unknown as TOutput;

        return {
          status: "SUCCESS",
          output: outputPayload,
          durationMs,
          providerMetadata,
        };
      }

      case "CANCELLED": {
        return {
          status: "CANCELLED",
          durationMs,
          error: {
            code: "EXECUTION_CANCELLED",
            message: stepResult.terminalMessage,
            details: { terminalReason: stepResult.terminalReason },
          },
          providerMetadata,
        };
      }

      case "COMPLETION_UNVERIFIABLE": {
        // The runtime could not authorize completion (no verifiable contract). Never a successful run.
        return {
          status: "FAILED",
          durationMs,
          error: {
            code: "COMPLETION_UNVERIFIABLE",
            message: stepResult.terminalMessage,
            details: {
              terminalReason: stepResult.terminalReason,
              totalSteps: stepResult.totalSteps,
              totalProposalRejections: stepResult.totalProposalRejections,
            },
          },
          providerMetadata,
        };
      }

      case "WAITING_APPROVAL": {
        return {
          status: "FAILED",
          durationMs,
          error: {
            code: "WAITING_APPROVAL",
            message: stepResult.terminalMessage,
            details: {
              terminalReason: stepResult.terminalReason,
              ...(stepResult.pendingApprovalId ? { approvalId: stepResult.pendingApprovalId } : {}),
              ...(stepResult.pendingApprovalOperation ? { operation: stepResult.pendingApprovalOperation } : {}),
            },
          },
          providerMetadata,
        };
      }

      case "APPROVAL_REJECTED":
      case "APPROVAL_EXPIRED":
      case "REPAIR_EXHAUSTED": {
        return {
          status: "FAILED",
          durationMs,
          error: {
            code: stepResult.terminalReason,
            message: stepResult.terminalMessage,
            details: {
              terminalReason: stepResult.terminalReason,
              totalSteps: stepResult.totalSteps,
              totalProposalRejections: stepResult.totalProposalRejections,
            },
          },
          providerMetadata,
        };
      }

      case "CYCLE_DETECTED": {
        return {
          status: "FAILED",
          durationMs,
          error: {
            code: "EXECUTION_FAILED",
            message: stepResult.terminalMessage,
            details: {
              terminalReason: stepResult.terminalReason,
              totalSteps: stepResult.totalSteps,
              totalProposalRejections: stepResult.totalProposalRejections,
            },
          },
          providerMetadata,
        };
      }

      case "MAX_WALL_CLOCK": {
        return {
          status: "TIMED_OUT",
          durationMs,
          error: {
            code: "EXECUTION_TIMEOUT",
            message: stepResult.terminalMessage,
            details: { terminalReason: stepResult.terminalReason },
          },
          providerMetadata,
        };
      }

      case "LEASE_LOST": {
        return {
          status: "FAILED",
          durationMs,
          error: {
            code: "LEASE_LOST",
            message: stepResult.terminalMessage,
            details: {
              terminalReason: stepResult.terminalReason,
              totalSteps: stepResult.totalSteps,
              totalProposalRejections: stepResult.totalProposalRejections,
            },
          },
          providerMetadata,
        };
      }

      default: {
        return {
          status: "FAILED",
          durationMs,
          error: {
            code: "EXECUTION_FAILED",
            message: stepResult.terminalMessage,
            details: {
              terminalReason: stepResult.terminalReason,
              totalSteps: stepResult.totalSteps,
              totalProposalRejections: stepResult.totalProposalRejections,
            },
          },
          providerMetadata,
        };
      }
    }
  }
}
