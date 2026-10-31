/**
 * Durable task submission.
 *
 * Creates, in the supplied (file-backed) state store, everything a worker needs to claim and execute a deterministic
 * operation: a task, an ACTIVE governing MissionContract (default in-process policy, bounded resource limits) and a QUEUED
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
import type { StateStorePort } from "../ports/state-store.port.js";
import type { RunCoordinator } from "./run-coordinator.js";

export interface SubmitDurableTaskParams {
  /** Name of the deterministic operation the execution provider routes to (the task title is the operation name). */
  readonly operation: string;
  readonly input: unknown;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  /** A repeated submission with the same key returns the existing run and creates nothing. */
  readonly idempotencyKey?: string;
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
  if (!params.operation || typeof params.operation !== "string") {
    throw new Error("submitDurableTask: operation must be a non-empty string");
  }
  if (params.idempotencyKey) {
    const existing = coordinator.getRunByIdempotencyKey(params.idempotencyKey);
    if (existing) {
      return { taskId: existing.taskId, runId: existing.runId, status: existing.status, deduplicated: true };
    }
  }

  const maxAttempts = params.maxAttempts ?? 3;
  const task = coordinator.createTask({ title: params.operation, inputPayload: params.input });
  const contractId = `contract-${task.taskId}`;
  const version = 1;
  const contract = createMissionContract({
    contractId,
    version,
    taskId: task.taskId,
    policy: createDefaultInProcessPolicy(`policy-${task.taskId}`),
    verificationSpecs: [],
    resourceLimits: createResourceLimits({
      timeoutMs: params.timeoutMs ?? 30_000,
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
    timeoutMs: params.timeoutMs,
    idempotencyKey: params.idempotencyKey ?? null,
  });
  const queued = coordinator.queueRun(run.runId);
  return { taskId: task.taskId, runId: queued.run.runId, status: queued.run.status, deduplicated: false };
}
