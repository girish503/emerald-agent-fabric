/**
 * Model assignment guard for Emerald Agent Fabric.
 *
 * Wraps an AgentBrainPort so that a role-bearing (multi-agent child) task can reach a model only when the
 * task carries a durable model assignment issued by the governed model router, and that assignment names
 * exactly the model identity this worker verified at startup.
 *
 * Fail closed:
 * - a role-bearing task without an assignment is refused;
 * - an assignment for another task, tenant, role, model or digest is refused;
 * - when the worker has no verified model identity (for example an injected brain), any role-bearing or
 *   assigned task is refused, because the identity cannot be proven.
 *
 * The check runs before every proposal request and never calls the model. The assignment is read from the
 * durable task record on each call, so a restart, replay or re-claim re-validates the same stored identity
 * and cannot silently change it.
 */

import {
  ModelAssignmentViolationError,
  SUPER_AGENT_ROLES,
} from "../domain/model-routing.js";
import type { AgentBrainPort, AgentBrainRequest, AgentBrainResult } from "../ports/agent-brain.port.js";
import type { StateStorePort } from "../ports/state-store.port.js";
import { assertModelAssignmentMatches } from "./governed-model-router.js";

export interface VerifiedModelIdentity {
  readonly modelId: string;
  readonly modelDigest: string;
}

export interface ModelAssignmentGuardOptions {
  readonly inner: AgentBrainPort;
  readonly stateStore: Pick<StateStorePort, "getTask" | "getRun" | "getContract">;
  /** The model identity verified at worker startup, or null when the worker cannot prove one. */
  readonly verifiedModel: VerifiedModelIdentity | null;
  /** Receives one record per authorization decision (allowed or refused). */
  readonly onDecision?: (record: {
    readonly taskId: string;
    readonly runId: string;
    readonly allowed: boolean;
    readonly reason: string;
    readonly modelId?: string;
    readonly decisionHash?: string;
  }) => void;
}

export class ModelAssignmentEnforcingBrain implements AgentBrainPort {
  constructor(private readonly options: ModelAssignmentGuardOptions) {}

  async proposeAction(request: AgentBrainRequest): Promise<AgentBrainResult> {
    this.authorize(request);
    return this.options.inner.proposeAction(request);
  }

  private authorize(request: AgentBrainRequest): void {
    const taskId = request.contextSnapshot.taskId;
    const runId = request.runId;
    const refuse = (reason: string): never => {
      this.options.onDecision?.({ taskId, runId, allowed: false, reason });
      throw new ModelAssignmentViolationError(reason);
    };

    const task = this.options.stateStore.getTask(taskId);
    const payload = (task?.inputPayload ?? {}) as Record<string, unknown>;
    const role = typeof payload.role === "string" ? payload.role : null;
    const assignment = payload.modelAssignment;
    const isRoleTask = role !== null && (SUPER_AGENT_ROLES as readonly string[]).includes(role);

    if (!isRoleTask && assignment === undefined) {
      // Single-agent task: governed by the worker's startup approval gate only.
      return;
    }
    if (assignment === undefined) {
      return refuse(`Task '${taskId}' has agent role '${role}' but no governed model assignment`);
    }
    const verified = this.options.verifiedModel;
    if (!verified) {
      return refuse(`Task '${taskId}' has a model assignment, but this worker has no verified model identity`);
    }

    const run = this.options.stateStore.getRun(runId);
    const contract = run?.contractBinding
      ? this.options.stateStore.getContract(run.contractBinding.contractId, run.contractBinding.version)
      : null;
    const tenantId = contract?.spec.policy.tenantId ?? null;

    try {
      const accepted = assertModelAssignmentMatches(assignment, {
        taskId,
        tenantId,
        role,
        modelId: verified.modelId,
        modelDigest: verified.modelDigest,
      });
      this.options.onDecision?.({
        taskId,
        runId,
        allowed: true,
        reason: "model assignment matches the verified worker model",
        modelId: accepted.modelId,
        decisionHash: accepted.decisionHash,
      });
    } catch (err: unknown) {
      refuse(err instanceof Error ? err.message : String(err));
    }
  }
}
