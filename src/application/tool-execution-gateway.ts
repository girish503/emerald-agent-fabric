/**
 * Tool Execution Gateway for Emerald Agent Fabric.
 *
 * Serves as the trusted application-layer boundary orchestrating tool resolution,
 * exact MissionContract verification, capability authorization, non-clamping resource
 * ceiling enforcement, input schema validation, and adapter dispatch.
 *
 * Architectural Invariants:
 * 1. Untrusted Request Boundary: ToolRequest is an untrusted external proposal.
 *    Authority (Run identity, contract binding, worker lease, workspace path)
 *    is derived strictly from trusted runtime context.
 * 2. Exact MissionContract Binding: Authority is verified exclusively against the
 *    exact (contractId, version, contentHash) bound to the active Run.
 *    Dynamic fallback, "latest" contract queries, or synthetic contracts are FORBIDDEN.
 * 3. Pre-Execution Governance: Any failure in contract verification, capability policy,
 *    or resource ceilings fails closed immediately with ZERO adapter and ZERO provider execution.
 * 4. Non-Clamping Resource Enforcement: Requests exceeding contract ceilings MUST be
 *    rejected (ResourceLimitExceededError), never silently clamped to lower values.
 * 5. Least Privilege Context: Tool adapters receive only minimal execution context
 *    (ToolExecutionContext); raw state stores, contract repos, and Docker sockets are never exposed.
 */

import { computeCanonicalHash } from "../domain/canonical-hash.js";
import {
  ContractIntegrityError,
  ContractNotActiveError,
  ContractRevokedError,
  DomainError,
  InvalidContractBindingError,
  InvalidRunError,
  InvalidToolInputError,
  LeaseLostError,
  MissionContractTaskMismatchError,
  MissingBoundContractError,
  ResourceLimitExceededError,
  TerminalStateError,
  ToolCapabilityDeniedError,
  ToolErrorPayload,
  ToolExecutionFailedError,
  ToolNotFoundError,
  ToolProviderUnavailableError,
  ToolWorkspaceBoundaryViolationError,
} from "../domain/errors.js";
import { MissionContract } from "../domain/mission-contract.js";
import {
  evaluateWorkloadExecutionRouting,
  PolicyEvaluator,
  WorkloadTrustClassification,
} from "../domain/policy.js";
import { RunSnapshot } from "../domain/invariants.js";
import {
  defaultGovernedToolRegistry,
  isValidToolName,
  ToolDefinition,
  ToolName,
  ToolRequest,
  ToolResult,
} from "../domain/tool.js";
import { ClockPort, SystemClock } from "../ports/clock.port.js";
import type { ExecutionWorkloadTrustClassification } from "../ports/execution-provider.port.js";
import { StateStorePort } from "../ports/state-store.port.js";
import {
  ToolAdapterRegistryPort,
  ToolExecutionContext,
} from "../ports/tool-adapter.port.js";
import { ToolRegistryPort } from "../ports/tool-registry.port.js";
import { RunCoordinator } from "./run-coordinator.js";
import {
  type GovernedToolConnectorService,
  type WorkspaceConnectorContext,
} from "./governed-tool-connector.js";
import { ApprovalControl } from "../control-plane/approval-control.js";
import { isHighRiskToolOperation } from "../governance/production-governance-facade.js";
import type { EmeraldLifecycleTelemetry } from "./observability-instrumentation.js";

/**
 * Trusted ambient runtime context establishing execution authority.
 * Kept strictly separate from untrusted model-facing ToolRequest.
 */
export interface TrustedToolInvocationContext {
  readonly runId: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly leaseId: string;
  readonly workspace?: {
    readonly workspaceId: string;
    readonly hostPath: string;
    readonly containerMountPath?: string;
  };
  readonly abortSignal?: AbortSignal;
  readonly tenantId?: string;
  readonly trustClassification?: ExecutionWorkloadTrustClassification;
  readonly systemVerificationSpecId?: string;
}

export type ToolAuthorizationStatus = "AUTHORIZED" | "DENIED" | "INVALID";

/**
 * Deterministic authorization decision returned by Gateway.
 */
export interface ToolAuthorizationDecision {
  readonly status: ToolAuthorizationStatus;
  readonly toolName?: ToolName;
  readonly toolDefinition?: ToolDefinition;
  readonly executionContext?: ToolExecutionContext;
  readonly validatedInput?: unknown;
  readonly errorPayload?: ToolErrorPayload;
  readonly domainError?: DomainError;
}

export interface ToolExecutionGatewayOptions {
  readonly toolRegistry?: ToolRegistryPort;
  readonly adapterRegistry?: ToolAdapterRegistryPort;
  readonly coordinator?: RunCoordinator;
  readonly stateStore?: StateStorePort;
  readonly policyEvaluator?: PolicyEvaluator;
  readonly clock?: ClockPort;
  readonly isIsolationAvailable?: boolean | (() => Promise<boolean>);
  readonly connectorService?: GovernedToolConnectorService;
  readonly approvalControl?: ApprovalControl;
  readonly enableApprovalGate?: boolean;
  readonly telemetry?: EmeraldLifecycleTelemetry;
}

export interface ExecuteToolOptions {
  readonly throwOnError?: boolean;
}

export class ToolExecutionGateway {
  private readonly toolRegistry: ToolRegistryPort;
  private readonly adapterRegistry?: ToolAdapterRegistryPort;
  private readonly coordinator?: RunCoordinator;
  private readonly stateStore?: StateStorePort;
  private readonly policyEvaluator: PolicyEvaluator;
  private readonly clock: ClockPort;
  private readonly isIsolationAvailableProbe?: boolean | (() => Promise<boolean>);
  private readonly connectorService?: GovernedToolConnectorService;
  private readonly approvalControl?: ApprovalControl;
  private readonly telemetry?: EmeraldLifecycleTelemetry;

  constructor(options: ToolExecutionGatewayOptions = {}) {
    this.toolRegistry = options.toolRegistry ?? defaultGovernedToolRegistry;
    this.adapterRegistry = options.adapterRegistry;
    this.coordinator = options.coordinator;
    this.stateStore = options.stateStore;
    this.policyEvaluator = options.policyEvaluator ?? new PolicyEvaluator();
    this.clock = options.clock ?? new SystemClock();
    this.isIsolationAvailableProbe = options.isIsolationAvailable;
    this.connectorService = options.connectorService;
    this.telemetry = options.telemetry;
    const effectiveStore = options.stateStore ?? options.coordinator?.store;
    if (options.approvalControl) {
      this.approvalControl = options.approvalControl;
    } else if (options.enableApprovalGate && effectiveStore?.insertApprovalRequest) {
      this.approvalControl = new ApprovalControl(this.clock, effectiveStore, true);
    }
  }

  get adapters(): ToolAdapterRegistryPort | undefined {
    return this.adapterRegistry;
  }

  /**
   * Resolves the authoritative Run snapshot using coordinator or stateStore.
   */
  private getRun(runId: string): RunSnapshot | null {
    if (this.coordinator) {
      return this.coordinator.getRun(runId);
    }
    if (this.stateStore) {
      return this.stateStore.getRun(runId);
    }
    return null;
  }

  /**
   * Resolves the exact MissionContract using coordinator or stateStore.
   */
  private getContract(contractId: string, version: number): MissionContract | null {
    if (this.coordinator) {
      return this.coordinator.getContract(contractId, version);
    }
    if (this.stateStore) {
      return this.stateStore.getContract(contractId, version);
    }
    return null;
  }

  /**
   * Checks whether sandbox/container isolation is currently available.
   */
  private async isSandboxIsolationAvailable(): Promise<boolean> {
    if (this.isIsolationAvailableProbe === undefined) {
      return true; // Default available unless explicitly probed otherwise
    }
    if (typeof this.isIsolationAvailableProbe === "boolean") {
      return this.isIsolationAvailableProbe;
    }
    if (typeof this.isIsolationAvailableProbe === "function") {
      try {
        return await this.isIsolationAvailableProbe();
      } catch {
        return false;
      }
    }
    return true;
  }

  /**
   * Evaluates the complete deterministic pre-execution authorization pipeline.
   *
   * Executes Stages 1 through 11 in strict unskippable sequence.
   * If any check fails, returns immediately with DENIED/INVALID decision.
   * Does NOT dispatch to adapters and does NOT invoke ExecutionProvider.
   */
  async authorize(
    request: ToolRequest,
    context: TrustedToolInvocationContext
  ): Promise<ToolAuthorizationDecision> {
    // ------------------------------------------------------------------------
    // Stage 1: Resolve ToolDefinition
    // ------------------------------------------------------------------------
    if (
      !request ||
      typeof request !== "object" ||
      typeof request.toolName !== "string" ||
      !isValidToolName(request.toolName)
    ) {
      const toolNameStr = String(request?.toolName ?? "unknown");
      const error = new ToolNotFoundError(toolNameStr);
      return {
        status: "INVALID",
        toolName: undefined,
        errorPayload: error.toPayload(),
        domainError: error,
      };
    }

    const toolDef = this.toolRegistry.getTool(request.toolName);
    if (!toolDef) {
      const error = new ToolNotFoundError(request.toolName);
      return {
        status: "INVALID",
        toolName: request.toolName,
        errorPayload: error.toPayload(),
        domainError: error,
      };
    }

    // ------------------------------------------------------------------------
    // Stage 2: Resolve Authoritative Run & Fencing Check
    // ------------------------------------------------------------------------
    let run: RunSnapshot | null;
    try {
      run = this.getRun(context.runId);
    } catch (err: unknown) {
      if (err instanceof ContractIntegrityError) {
        return {
          status: "DENIED",
          toolName: toolDef.name,
          errorPayload: {
            code: "CAPABILITY_DENIED",
            category: "authorization",
            message: err.message,
          },
          domainError: err,
        };
      }
      if (err instanceof InvalidRunError) {
        const match = /Referenced MissionContract '([^']+)' v(\d+) not found/.exec(
          err.violations?.join(" ") ?? err.message
        );
        if (match) {
          const missingError = new MissingBoundContractError(match[1]!, Number(match[2]!));
          return {
            status: "DENIED",
            toolName: toolDef.name,
            errorPayload: {
              code: "CAPABILITY_DENIED",
              category: "authorization",
              message: missingError.message,
            },
            domainError: missingError,
          };
        }
        return {
          status: "INVALID",
          toolName: toolDef.name,
          errorPayload: {
            code: "INVALID_TOOL_INPUT",
            category: "validation",
            message: err.message,
          },
          domainError: err,
        };
      }
      if (err instanceof DomainError) {
        return {
          status: "DENIED",
          toolName: toolDef.name,
          errorPayload: {
            code: "CAPABILITY_DENIED",
            category: "authorization",
            message: err.message,
          },
          domainError: err,
        };
      }
      const error = new InvalidRunError(context.runId, [err instanceof Error ? err.message : String(err)]);
      return {
        status: "INVALID",
        toolName: toolDef.name,
        errorPayload: {
          code: "INVALID_TOOL_INPUT",
          category: "validation",
          message: error.message,
        },
        domainError: error,
      };
    }
    if (!run) {
      const error = new InvalidRunError(context.runId, ["Run not found in authoritative state store"]);
      return {
        status: "INVALID",
        toolName: toolDef.name,
        errorPayload: {
          code: "INVALID_TOOL_INPUT",
          category: "validation",
          message: error.message,
        },
        domainError: error,
      };
    }

    // Lease fencing check
    if (
      (context.leaseId && run.leaseId !== context.leaseId) ||
      (context.workerId && run.currentWorkerId !== null && run.currentWorkerId !== context.workerId)
    ) {
      const error = new LeaseLostError(run.runId, context.leaseId, run.leaseId);
      return {
        status: "DENIED",
        toolName: toolDef.name,
        errorPayload: {
          code: "CAPABILITY_DENIED",
          category: "authorization",
          message: error.message,
        },
        domainError: error,
      };
    }

    // Terminal state check
    const terminalStatuses: readonly string[] = ["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"];
    if (terminalStatuses.includes(run.status)) {
      const error = new TerminalStateError(run.status, `tool_execution.${toolDef.name}`);
      return {
        status: "DENIED",
        toolName: toolDef.name,
        errorPayload: {
          code: "CAPABILITY_DENIED",
          category: "authorization",
          message: error.message,
        },
        domainError: error,
      };
    }

    // ------------------------------------------------------------------------
    // Stage 3 & 4: Resolve & Verify Bound MissionContract
    // ------------------------------------------------------------------------
    if (!run.contractBinding) {
      const error = new InvalidContractBindingError("Run has no bound MissionContract");
      return {
        status: "DENIED",
        toolName: toolDef.name,
        errorPayload: {
          code: "CAPABILITY_DENIED",
          category: "authorization",
          message: error.message,
        },
        domainError: error,
      };
    }

    const { contractId, version, contentHash: boundContentHash } = run.contractBinding;
    const contract = this.getContract(contractId, version);
    if (!contract) {
      const error = new MissingBoundContractError(contractId, version);
      return {
        status: "DENIED",
        toolName: toolDef.name,
        errorPayload: {
          code: "CAPABILITY_DENIED",
          category: "authorization",
          message: error.message,
        },
        domainError: error,
      };
    }

    // Verify identity & integrity
    let recomputedHash: string;
    try {
      recomputedHash = computeCanonicalHash(contract.spec).contentHash;
    } catch (err: unknown) {
      const error = new ContractIntegrityError(run.runId, boundContentHash, "hash_computation_failed");
      return {
        status: "DENIED",
        toolName: toolDef.name,
        errorPayload: {
          code: "CAPABILITY_DENIED",
          category: "authorization",
          message: error.message,
        },
        domainError: error,
      };
    }

    if (
      contract.spec.contractId !== contractId ||
      contract.spec.version !== version ||
      contract.contentHash !== boundContentHash ||
      recomputedHash !== boundContentHash ||
      recomputedHash !== contract.contentHash
    ) {
      const error = new ContractIntegrityError(run.runId, boundContentHash, recomputedHash);
      return {
        status: "DENIED",
        toolName: toolDef.name,
        errorPayload: {
          code: "CAPABILITY_DENIED",
          category: "authorization",
          message: error.message,
        },
        domainError: error,
      };
    }

    // Task association verification
    if (contract.spec.taskId !== run.taskId || (context.taskId && contract.spec.taskId !== context.taskId)) {
      const error = new MissionContractTaskMismatchError(run.taskId, contract.spec.taskId, contractId);
      return {
        status: "DENIED",
        toolName: toolDef.name,
        errorPayload: {
          code: "CAPABILITY_DENIED",
          category: "authorization",
          message: error.message,
        },
        domainError: error,
      };
    }

    // Lifecycle status verification
    if (contract.lifecycle.status === "REVOKED") {
      const error = new ContractRevokedError(
        contractId,
        version,
        contract.lifecycle.revocationReason
      );
      return {
        status: "DENIED",
        toolName: toolDef.name,
        errorPayload: {
          code: "CAPABILITY_DENIED",
          category: "authorization",
          message: `Bound MissionContract '${contractId}' v${version} has been REVOKED: ${
            contract.lifecycle.revocationReason ?? "revoked"
          }`,
        },
        domainError: error,
      };
    }

    if (contract.lifecycle.status !== "ACTIVE") {
      const error = new ContractNotActiveError(contractId, version, contract.lifecycle.status);
      return {
        status: "DENIED",
        toolName: toolDef.name,
        errorPayload: {
          code: "CAPABILITY_DENIED",
          category: "authorization",
          message: error.message,
        },
        domainError: error,
      };
    }

    // ------------------------------------------------------------------------
    // Stage 5 & 6: Capability Authorization via PolicyEvaluator & System Verification
    // ------------------------------------------------------------------------
    let capabilityAuthorized = false;

    // Check if this action is an authorized system-owned verification action
    if (context.systemVerificationSpecId) {
      const boundVerificationSpecs = contract.spec.verificationSpecs ?? [];
      const matchingSpec = boundVerificationSpecs.find(
        (s) => s.specId === context.systemVerificationSpecId
      );
      if (matchingSpec && matchingSpec.ruleKind === "EXIT_CODE_ZERO") {
        const expected = matchingSpec.expectedValue as Record<string, unknown> | undefined;
        const expectedTool = (expected?.toolName as string) ?? "run_command";
        const expectedArgv = Array.isArray(expected?.argv) ? expected!.argv : undefined;

        // Verify that the requested tool and argv strictly match the authoritative bound spec
        const inputArgv = (request.input as any)?.argv;
        const toolMatches = request.toolName === expectedTool;
        const argvMatches =
          !expectedArgv ||
          (Array.isArray(inputArgv) &&
            inputArgv.length === expectedArgv.length &&
            inputArgv.every((v, i) => v === expectedArgv[i]));

        if (toolMatches && argvMatches) {
          capabilityAuthorized = true;
        }
      }
    }

    if (!capabilityAuthorized) {
      const policyDecision = this.policyEvaluator.evaluateCapability(
        toolDef.requiredCapability,
        contract.spec.policy
      );

      if (policyDecision.status !== "ALLOWED") {
        const error = new ToolCapabilityDeniedError(
          toolDef.name,
          toolDef.requiredCapability,
          policyDecision.message
        );
        return {
          status: "DENIED",
          toolName: toolDef.name,
          errorPayload: error.toPayload(),
          domainError: error,
        };
      }
    }

    // ------------------------------------------------------------------------
    // Stage 7: Resource Authorization (Non-Clamping Governance Model)
    // ------------------------------------------------------------------------
    const rawInput = request.input as Record<string, unknown> | undefined;
    if (rawInput && typeof rawInput === "object") {
      // 1. maxBytes checks
      if (typeof rawInput.maxBytes === "number") {
        const byteCeiling = Math.min(
          run.maxOutputBytes ?? contract.spec.resourceLimits.maxOutputBytes,
          contract.spec.resourceLimits.maxOutputBytes
        );
        if (rawInput.maxBytes > byteCeiling) {
          const error = new ResourceLimitExceededError("maxBytes", rawInput.maxBytes, byteCeiling);
          return {
            status: "DENIED",
            toolName: toolDef.name,
            errorPayload: {
              code: "TOOL_OUTPUT_LIMIT_EXCEEDED",
              category: "resource",
              message: error.message,
            },
            domainError: error,
          };
        }
      }

      // 2. write_file content size check
      if (toolDef.name === "write_file" && typeof rawInput.content === "string") {
        const contentBytes = Buffer.byteLength(rawInput.content, "utf8");
        const byteCeiling = Math.min(
          run.maxOutputBytes ?? contract.spec.resourceLimits.maxOutputBytes,
          contract.spec.resourceLimits.maxOutputBytes
        );
        if (contentBytes > byteCeiling) {
          const error = new ResourceLimitExceededError("maxOutputBytes", contentBytes, byteCeiling);
          return {
            status: "DENIED",
            toolName: toolDef.name,
            errorPayload: {
              code: "TOOL_OUTPUT_LIMIT_EXCEEDED",
              category: "resource",
              message: `Write payload size (${contentBytes} bytes) exceeds contract ceiling (${byteCeiling} bytes)`,
            },
            domainError: error,
          };
        }
      }

      // 3. timeoutMs check
      if (typeof rawInput.timeoutMs === "number") {
        const timeoutCeiling = Math.min(
          run.timeoutMs ?? contract.spec.resourceLimits.timeoutMs,
          contract.spec.resourceLimits.timeoutMs
        );
        if (rawInput.timeoutMs > timeoutCeiling) {
          const error = new ResourceLimitExceededError("timeoutMs", rawInput.timeoutMs, timeoutCeiling);
          return {
            status: "DENIED",
            toolName: toolDef.name,
            errorPayload: {
              code: "TOOL_TIMEOUT",
              category: "resource",
              message: error.message,
            },
            domainError: error,
          };
        }
      }

      // 4. maxOutputBytes check
      if (typeof rawInput.maxOutputBytes === "number") {
        const outputCeiling = Math.min(
          run.maxOutputBytes ?? contract.spec.resourceLimits.maxOutputBytes,
          contract.spec.resourceLimits.maxOutputBytes
        );
        if (rawInput.maxOutputBytes > outputCeiling) {
          const error = new ResourceLimitExceededError("maxOutputBytes", rawInput.maxOutputBytes, outputCeiling);
          return {
            status: "DENIED",
            toolName: toolDef.name,
            errorPayload: {
              code: "TOOL_OUTPUT_LIMIT_EXCEEDED",
              category: "resource",
              message: error.message,
            },
            domainError: error,
          };
        }
      }

      // 5. maxResults safety check
      if (typeof rawInput.maxResults === "number") {
        const maxResultsSafety = toolDef.resourceDescriptor.maxMaxResults ?? 1000;
        if (rawInput.maxResults > maxResultsSafety) {
          const error = new InvalidToolInputError(
            toolDef.name,
            `Requested maxResults (${rawInput.maxResults}) exceeds maximum allowed (${maxResultsSafety})`
          );
          return {
            status: "INVALID",
            toolName: toolDef.name,
            errorPayload: error.toPayload(),
            domainError: error,
          };
        }
      }
    }

    // ------------------------------------------------------------------------
    // Stage 8: Input Schema Validation via Zod
    // ------------------------------------------------------------------------
    const parseResult = toolDef.inputSchema.safeParse(request.input);
    if (!parseResult.success) {
      const reason = parseResult.error.issues.map((i) => i.message).join("; ");
      const error = new InvalidToolInputError(toolDef.name, reason, parseResult.error.issues);
      return {
        status: "INVALID",
        toolName: toolDef.name,
        errorPayload: error.toPayload(),
        domainError: error,
      };
    }

    // ------------------------------------------------------------------------
    // Stage 9: Workspace Assignment & Context Assertion
    // ------------------------------------------------------------------------
    if (toolDef.isolationRequirement === "WORKSPACE" || toolDef.isolationRequirement === "SANDBOX") {
      if (!context.workspace || !context.workspace.workspaceId || !context.workspace.hostPath) {
        const error = new ToolWorkspaceBoundaryViolationError(
          toolDef.name,
          "",
          `Tool '${toolDef.name}' requires ${toolDef.isolationRequirement} isolation, but no workspace is assigned to context`
        );
        return {
          status: "DENIED",
          toolName: toolDef.name,
          errorPayload: error.toPayload(),
          domainError: error,
        };
      }
    }

    // ------------------------------------------------------------------------
    // Stage 10: Isolation Environment Verification & Workload Routing
    // ------------------------------------------------------------------------
    const tenantId = context.tenantId ?? contract.spec.policy.tenantId;
    const trustClassification: WorkloadTrustClassification =
      context.trustClassification ??
      contract.spec.policy.trustClassification ??
      (toolDef.isolationRequirement === "SANDBOX"
        ? (tenantId ? "MULTI_TENANT_WORKLOAD" : "UNTRUSTED_WORKLOAD")
        : "TRUSTED_INTERNAL");

    if (toolDef.isolationRequirement === "SANDBOX") {
      const isAvailable = await this.isSandboxIsolationAvailable();
      const routing = evaluateWorkloadExecutionRouting({
        trustClassification,
        requestedProviderName: "docker",
        isSandboxAvailable: isAvailable,
        isDaemonRootless: isAvailable,
        requireRootlessDaemon: contract.spec.policy.requireRootlessDaemon,
        tenantId,
      });

      if (!routing.allowed) {
        const error = new ToolCapabilityDeniedError(
          toolDef.name,
          toolDef.requiredCapability,
          routing.message
        );
        return {
          status: "DENIED",
          toolName: toolDef.name,
          errorPayload: {
            code: "CAPABILITY_DENIED",
            category: "authorization",
            message: routing.message,
          },
          domainError: error,
        };
      }
    }

    // ------------------------------------------------------------------------
    // Stage 11: Construct Trusted ToolExecutionContext
    // ------------------------------------------------------------------------
    const parsedData = parseResult.data as Record<string, unknown>;
    const requestedTimeout = typeof parsedData?.timeoutMs === "number" ? parsedData.timeoutMs : undefined;
    const defaultTimeout = toolDef.resourceDescriptor.defaultTimeoutMs ?? 10000;
    const contractTimeout = run.timeoutMs ?? contract.spec.resourceLimits.timeoutMs;
    const effectiveTimeoutMs = Math.min(requestedTimeout ?? defaultTimeout, contractTimeout);

    const requestedOutput =
      typeof parsedData?.maxOutputBytes === "number"
        ? parsedData.maxOutputBytes
        : typeof parsedData?.maxBytes === "number"
          ? parsedData.maxBytes
          : undefined;
    const defaultOutput = toolDef.resourceDescriptor.defaultMaxBytes ?? 1048576;
    const contractOutput = run.maxOutputBytes ?? contract.spec.resourceLimits.maxOutputBytes;
    const effectiveMaxOutputBytes = Math.min(requestedOutput ?? defaultOutput, contractOutput);

    const executionContext: ToolExecutionContext = {
      runId: run.runId,
      taskId: run.taskId,
      workerId: context.workerId,
      leaseId: context.leaseId,
      toolName: toolDef.name,
      requiredCapability: toolDef.requiredCapability,
      isolationRequirement: toolDef.isolationRequirement,
      workspace: context.workspace!,
      resourceLimits: {
        timeoutMs: effectiveTimeoutMs,
        maxOutputBytes: effectiveMaxOutputBytes,
      },
      abortSignal: context.abortSignal,
      governedBenchmarkRepairMode: contract.spec.policy.governedBenchmarkRepairMode,
      allowWholeFileReplacement: contract.spec.policy.allowWholeFileReplacement,
      tenantId,
      trustClassification,
    };

    return {
      status: "AUTHORIZED",
      toolName: toolDef.name,
      toolDefinition: toolDef,
      executionContext,
      validatedInput: parseResult.data,
    };
  }

  /**
   * Dispatches a tool request through the authorization pipeline and adapter execution seam.
   *
   * In Task 4.2-A, no real adapters are registered by default.
   * Tests supply spy adapters to verify that unauthorized requests never invoke adapters.
   */
  async execute(
    request: ToolRequest,
    context: TrustedToolInvocationContext,
    options: ExecuteToolOptions = {}
  ): Promise<ToolResult> {
    const startTime = this.clock.now().getTime();
    const decision = await this.authorize(request, context);

    if (decision.status !== "AUTHORIZED") {
      if (options.throwOnError && decision.domainError) {
        throw decision.domainError;
      }
      return {
        requestId: request.requestId,
        toolName: request.toolName,
        status: "FAILED",
        error: decision.errorPayload,
        durationMs: Math.max(0, this.clock.now().getTime() - startTime),
      };
    }

    // Seam: Check if an adapter or connector is registered
    const adapter = this.adapterRegistry?.getAdapter(decision.toolName!);
    const hasConnector = Boolean(this.connectorService?.hasConnector(decision.toolName!));
    if (!adapter && !hasConnector) {
      const error = new ToolProviderUnavailableError(
        decision.toolName!,
        `No adapter registered for tool '${decision.toolName}'`
      );
      if (options.throwOnError) {
        throw error;
      }
      return {
        requestId: request.requestId,
        toolName: request.toolName,
        status: "FAILED",
        error: error.toPayload(),
        durationMs: Math.max(0, this.clock.now().getTime() - startTime),
      };
    }

    // Resolve bound contract and run metadata for approval gate and connector dispatch
    const resolvedRun = this.getRun(context.runId);
    const resolvedContract = resolvedRun?.contractBinding
      ? this.getContract(resolvedRun.contractBinding.contractId, resolvedRun.contractBinding.version)
      : null;
    const effectiveStore = this.stateStore ?? this.coordinator?.store;
    const resolvedTask = effectiveStore ? effectiveStore.getTask(context.taskId) : null;
    const inputRecord =
      decision.validatedInput &&
      typeof decision.validatedInput === "object" &&
      !Array.isArray(decision.validatedInput)
        ? (decision.validatedInput as Record<string, unknown>)
        : {};

    // Human-in-the-loop Approval Gate (fail closed for high-risk ops or explicit requireApproval tasks)
    const taskRequiresApproval =
      Boolean((resolvedTask?.inputPayload as Record<string, unknown> | null | undefined)?.requireApproval === true);
    if (
      this.approvalControl &&
      (taskRequiresApproval || isHighRiskToolOperation(decision.toolName!, inputRecord))
    ) {
      const parametersHash = computeCanonicalHash(inputRecord).contentHash;
      const tenantId =
        decision.executionContext!.tenantId ??
        resolvedContract?.spec.policy.tenantId ??
        "tenant-default";
      const contractHash =
        resolvedRun?.contractBinding?.contentHash ??
        resolvedContract?.contentHash ??
        "";
      const auth = this.approvalControl.authorizeAndConsume({
        runId: context.runId,
        taskId: context.taskId,
        tenantId,
        contractHash,
        operation: decision.toolName!,
        parametersHash,
        consume: true,
      });

      if (!auth.authorized) {
        let approvalId = auth.approvalId;
        if (auth.status === "MISSING") {
          const created = this.approvalControl.requestApproval({
            runId: context.runId,
            taskId: context.taskId,
            tenantId,
            contractHash,
            operation: decision.toolName!,
            parameters: inputRecord,
            riskLevel: "HIGH",
            justification: `Governed tool invocation '${decision.toolName}' requires operator approval`,
            singleUse: true,
          });
          approvalId = created.approvalId;
        }
        const approvalErrorCode =
          auth.status === "REJECTED"
            ? "APPROVAL_REJECTED"
            : auth.status === "EXPIRED"
              ? "APPROVAL_EXPIRED"
              : auth.status === "CONSUMED" || auth.status === "MISMATCH"
                ? "APPROVAL_INVALID"
                : "WAITING_APPROVAL";
        this.telemetry?.recordApprovalDecision({
          action: approvalErrorCode === "WAITING_APPROVAL" ? "requested" : auth.status.toLowerCase(),
          riskLevel: "HIGH",
        });
        return {
          requestId: request.requestId,
          toolName: request.toolName,
          status: "FAILED",
          error: {
            code: approvalErrorCode,
            category: "authorization",
            message: auth.reason,
            details: {
              approvalId,
              approvalStatus: auth.status,
              operation: decision.toolName!,
              parametersHash,
            },
          },
          durationMs: Math.max(0, this.clock.now().getTime() - startTime),
        };
      }
      this.telemetry?.recordApprovalDecision({
        action: "consumed",
        riskLevel: "HIGH",
      });
    }

    // Authorized connector or adapter execution
    try {
      let rawOutput: unknown;
      if (hasConnector && this.connectorService) {
        const allowedCapabilities = resolvedContract?.spec.policy.allowedCapabilities ?? [
          decision.executionContext!.requiredCapability,
        ];
        const connectorResult = await this.connectorService.executeConnector(
          decision.toolName!,
          decision.validatedInput,
          {
            tenantId:
              decision.executionContext!.tenantId ??
              resolvedContract?.spec.policy.tenantId ??
              "tenant-default",
            taskId: context.taskId,
            runId: context.runId,
            contractId: resolvedContract?.spec.contractId ?? "unknown",
            authorizedCapabilities: allowedCapabilities,
            maxOutputBytes: decision.executionContext!.resourceLimits.maxOutputBytes,
            timeoutMs: decision.executionContext!.resourceLimits.timeoutMs,
            abortSignal: decision.executionContext!.abortSignal,
            ...(decision.toolDefinition!.idempotency === "IDEMPOTENT"
              ? { idempotencyKey: request.requestId }
              : {}),
            adapterContext: decision.executionContext!,
          } as WorkspaceConnectorContext
        );
        if (connectorResult.truncated) {
          throw new ToolExecutionFailedError(
            decision.toolName!,
            `Connector output exceeded ceiling of ${decision.executionContext!.resourceLimits.maxOutputBytes} bytes`
          );
        }
        rawOutput = connectorResult.output;
      } else {
        rawOutput = await adapter!.execute(
          decision.executionContext!,
          decision.validatedInput as any
        );
      }

      // Validate output schema
      const outputParsed = decision.toolDefinition!.outputSchema.safeParse(rawOutput);
      if (!outputParsed.success) {
        const error = new ToolExecutionFailedError(
          decision.toolName!,
          `Adapter output failed schema validation: ${outputParsed.error.issues.map((i) => i.message).join("; ")}`,
          outputParsed.error.issues
        );
        if (options.throwOnError) {
          throw error;
        }
        return {
          requestId: request.requestId,
          toolName: request.toolName,
          status: "FAILED",
          error: error.toPayload(),
          durationMs: Math.max(0, this.clock.now().getTime() - startTime),
        };
      }

      return {
        requestId: request.requestId,
        toolName: request.toolName,
        status: "SUCCESS",
        output: outputParsed.data as any,
        durationMs: Math.max(0, this.clock.now().getTime() - startTime),
      };
    } catch (err: unknown) {
      if (options.throwOnError) {
        throw err;
      }
      const errorPayload: ToolErrorPayload =
        err instanceof DomainError && "toPayload" in err && typeof (err as any).toPayload === "function"
          ? (err as any).toPayload()
          : {
              code: "TOOL_EXECUTION_FAILED",
              category: "execution",
              message: err instanceof Error ? err.message : String(err),
            };
      return {
        requestId: request.requestId,
        toolName: request.toolName,
        status: "FAILED",
        error: errorPayload,
        durationMs: Math.max(0, this.clock.now().getTime() - startTime),
      };
    }
  }
}
