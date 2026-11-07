/**
 * Durable task submission.
 *
 * Creates, in the supplied (file-backed) state store, everything a worker needs to claim and execute a deterministic
 * operation or governed agent task: a task, an ACTIVE governing MissionContract (policy and bounded resource limits) and a QUEUED
 * run. It reuses RunCoordinator and the domain factories - no run/contract logic is duplicated here.
 *
 * Delivery semantics are unchanged: submission only makes the run durable and claimable. Execution is at-least-once
 * across crash recovery (a recovered run is re-queued and executed again); nothing here claims exactly-once execution.
 */

import {
  createDefaultInProcessPolicy,
  createMissionContract,
  createResourceLimits,
} from "../domain/index.js";
import { createExecutionPolicy, type WorkloadTrustClassification } from "../domain/policy.js";
import { operationNameToCapabilityName } from "../domain/capability.js";
import type { StateStorePort } from "../ports/state-store.port.js";
import type { RunCoordinator } from "./run-coordinator.js";

export interface SubmitDurableTaskParams {
  /** Name of the deterministic operation the execution provider routes to (the task title is the operation name). */
  readonly operation?: string;
  /** Natural-language task description for governed agent execution. */
  readonly task?: string;
  readonly input?: unknown;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  /** A repeated submission with the same key returns the existing run and creates nothing. */
  readonly idempotencyKey?: string;
  /** Explicit allowed tool capabilities for governed agent tasks. */
  readonly capabilities?: readonly string[];
  /**
   * Absolute path of a host repository to copy into the run workspace (governed agent tasks only). It is
   * stored in the task input; the worker performs and audits the copy.
   */
  readonly repositoryPath?: string;
  /**
   * When true the run is left in CREATED and is NOT queued (used by the task router, which admits runs itself
   * under its concurrency cap). Default false preserves the existing behaviour: the run is queued immediately.
   */
  readonly deferQueue?: boolean;
  /**
   * Tenant identifier for multi-tenant isolation and policy binding.
   */
  readonly tenantId?: string;
  /**
   * Workload trust classification determining execution isolation boundaries.
   */
  readonly trustClassification?: WorkloadTrustClassification;
  readonly executionMode?: "sandboxed" | "constrained_host";
  /**
   * Authoritative server-side authorization check. Must be true for constrained_host execution.
   */
  readonly authorizedForConstrainedHost?: boolean;
}

export interface SubmittedTask {
  readonly taskId: string;
  readonly runId: string;
  readonly status: string;
  /** True when an existing run was returned for the idempotency key. */
  readonly deduplicated: boolean;
}

export function submitDurableTask(
  store: StateStorePort,
  coordinator: RunCoordinator,
  params: SubmitDurableTaskParams
): SubmittedTask {
  if (!params.operation && !params.task) {
    throw new Error("submitDurableTask: either operation or task must be provided");
  }
  if (params.operation !== undefined && (typeof params.operation !== "string" || params.operation.trim().length === 0)) {
    throw new Error("submitDurableTask: operation must be a non-empty string");
  }
  if (params.task !== undefined && (typeof params.task !== "string" || params.task.trim().length === 0)) {
    throw new Error("submitDurableTask: task must be a non-empty string");
  }

  if (params.idempotencyKey) {
    const existing = coordinator.getRunByIdempotencyKey(params.idempotencyKey);
    if (existing) {
      return { taskId: existing.taskId, runId: existing.runId, status: existing.status, deduplicated: true };
    }
  }

  const maxAttempts = params.maxAttempts ?? 3;
  const operationName = params.operation ?? "echo";
  const taskDescription = params.task ?? params.operation ?? "";
  if (params.repositoryPath !== undefined) {
    if (!params.task || (params.input !== undefined && params.input !== null)) {
      throw new Error("submitDurableTask: repositoryPath requires a task and cannot be combined with an explicit input");
    }
    if (typeof params.repositoryPath !== "string" || params.repositoryPath.trim().length === 0) {
      throw new Error("submitDurableTask: repositoryPath must be a non-empty string");
    }
  }
  const inputPayload =
    params.input !== undefined && params.input !== null
      ? params.input
      : params.task
      ? { instruction: params.task, ...(params.repositoryPath !== undefined ? { repositoryPath: params.repositoryPath } : {}) }
      : null;

  const task = coordinator.createTask({
    title: operationName,
    description: taskDescription,
    inputPayload,
  });

  const contractId = `contract-${task.taskId}`;
  const version = 1;

  const isConstrainedHost = params.executionMode === "constrained_host";
  if (isConstrainedHost && params.authorizedForConstrainedHost !== true) {
    throw new Error(
      "submitDurableTask: executionMode 'constrained_host' is rejected; caller is not authorized for constrained host execution"
    );
  }

  const isolationRequirement: "IN_PROCESS" | "ISOLATED" = isConstrainedHost ? "IN_PROCESS" : "ISOLATED";
  const trustClassification: WorkloadTrustClassification = isConstrainedHost
    ? (params.trustClassification ?? "TRUSTED_INTERNAL")
    : (params.tenantId ? "MULTI_TENANT_WORKLOAD" : (params.trustClassification ?? "UNTRUSTED_WORKLOAD"));

  let policy;
  const opCap = operationNameToCapabilityName(operationName);
  const extraCaps = opCap ? [opCap] : [];
  const extraOps = opCap ? [operationName, opCap] : [operationName];
  if (params.capabilities && params.capabilities.length > 0) {
    const allowed = Array.from(new Set(["execution.echo", ...extraCaps, ...params.capabilities]));
    policy = createExecutionPolicy({
      policyId: `policy-${task.taskId}`,
      allowedCapabilities: allowed,
      isolationRequirement,
      trustedInProcessOperations: isConstrainedHost ? Array.from(new Set(["echo", "execution.echo", ...extraOps, ...params.capabilities])) : undefined,
      ...(params.tenantId ? { tenantId: params.tenantId } : {}),
      trustClassification,
      requireRootlessDaemon: !isConstrainedHost,
    });
  } else if (params.task) {
    policy = createExecutionPolicy({
      policyId: `policy-${task.taskId}`,
      allowedCapabilities: Array.from(new Set(["execution.echo", ...extraCaps, "workspace.file.read", "workspace.code.search", "git.read"])),
      isolationRequirement,
      trustedInProcessOperations: isConstrainedHost ? Array.from(new Set(["echo", "execution.echo", ...extraOps, "workspace.file.read", "workspace.code.search", "git.read"])) : undefined,
      ...(params.tenantId ? { tenantId: params.tenantId } : {}),
      trustClassification,
      requireRootlessDaemon: !isConstrainedHost,
    });
  } else if (params.tenantId || params.trustClassification || isConstrainedHost) {
    policy = createExecutionPolicy({
      policyId: `policy-${task.taskId}`,
      allowedCapabilities: [
        "execution.echo",
        "execution.sum",
        "execution.slow",
        "execution.fail",
      ],
      isolationRequirement: "IN_PROCESS",
      trustedInProcessOperations: [
        "echo",
        "sum",
        "slow",
        "fail",
        "failing",
        "exploding",
        "output-flood",
        "execution.echo",
        "execution.sum",
        "execution.slow",
        "execution.fail",
      ],
      ...(params.tenantId ? { tenantId: params.tenantId } : {}),
      ...(trustClassification ? { trustClassification } : {}),
    });
  } else {
    policy = createDefaultInProcessPolicy(`policy-${task.taskId}`);
  }

  const timeoutMs = params.timeoutMs ?? (params.task ? 60_000 : 30_000);
  const contract = createMissionContract({
    contractId,
    version,
    taskId: task.taskId,
    policy,
    verificationSpecs: [],
    resourceLimits: createResourceLimits({
      timeoutMs,
      maxAttempts,
      maxOutputBytes: 1_048_576,
    }),
    credentialScopes: [],
  });

  store.insertContract(contract);
  store.activateContract(contractId, version);

  const { run } = coordinator.createRun({
    taskId: task.taskId,
    maxAttempts,
    timeoutMs,
    idempotencyKey: params.idempotencyKey ?? null,
  });
  if (params.deferQueue === true) {
    return { taskId: task.taskId, runId: run.runId, status: run.status, deduplicated: false };
  }
  const queued = coordinator.queueRun(run.runId);
  return { taskId: task.taskId, runId: queued.run.runId, status: queued.run.status, deduplicated: false };
}
