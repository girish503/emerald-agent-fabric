/**
 * Emerald Agent Fabric — Durable Multi-Agent Orchestrator (Phase 2).
 *
 * Responsibilities:
 * 1. Super Agent Decomposition:
 *    - Decomposes high-level missions into bounded, dependency-aware subtask contracts.
 *    - Validates DAG topological order (no cycles, no duplicate IDs, no self-loops).
 *    - Enforces depth and fan-out ceilings (maxDepth, maxChildrenPerParent).
 *    - Enforces resource limits (aggregate subtask timeout & attempts <= parent mission ceiling).
 * 2. Specialized Subagents & Capability Fencing:
 *    - Enforces narrow role capability profiles (RESEARCHER, CODER, TESTER, REVIEWER).
 *    - Strict Invariant: ChildCapabilities ⊆ ParentCapabilities && ChildCapabilities ⊆ RoleProfile.
 *    - Rejects capability escalation or unauthorized privilege inheritance.
 * 3. Durable Routing & Idempotent Scheduling:
 *    - Submits subtasks to TaskRouterService with deterministic idempotency keys.
 *    - Chains subtask dependencies safely onto the existing durable TaskRouter.
 * 4. Independent Verification & Zero Self-Approval:
 *    - Evaluates each subtask's completion independently against its bound verification specifications.
 *    - Categorizes child outcomes into: VERIFIED, REJECTED, BLOCKED, or UNVERIFIABLE.
 *    - Fail-closed synthesis: Mission synthesis fails if ANY child subtask is not independently VERIFIED.
 *    - No hiding failed or unverifiable children.
 */

import * as crypto from "node:crypto";
import type { ClockPort } from "../ports/clock.port.js";
import type { StateStorePort } from "../ports/state-store.port.js";
import type { RunCoordinator } from "./run-coordinator.js";
import { TaskRouterService } from "./task-router.js";
import type { GovernedModelRouterService } from "./governed-model-router.js";
import { ModelRoutingError, toModelAssignment, type ModelAssignment } from "../domain/model-routing.js";
import { computeCanonicalHash } from "../domain/canonical-hash.js";
import type { EmeraldLifecycleTelemetry } from "./observability-instrumentation.js";
import { ScopedContextMemoryService } from "./scoped-context-memory.js";
import { createExecutionPolicy } from "../domain/policy.js";
import { createMissionContract, createResourceLimits } from "../domain/mission-contract.js";
import { transformVerificationSpecInput } from "./durable-submission.js";
import {
  type SuperAgentRole,
  type SubtaskContractSpec,
  type DecompositionPlanInput,
  type ChildVerificationStatus,
  type SubtaskVerificationReport,
  type MissionSynthesisVerdict,
  type MissionSynthesisReport,
  ROLE_CAPABILITY_CONTRACTS,
  SuperAgentDecompositionError,
  SynthesisVerificationError,
  validateDecompositionDAG,
  validateSubtaskCapabilities,
  validateSubtaskResourceCeilings,
} from "../domain/super-agent.js";

export interface MultiAgentOrchestratorConfig {
  readonly maxDepth?: number;
  readonly maxChildrenPerParent?: number;
  /**
   * Governed model router. When provided, every subtask is routed by its agent role before any child is
   * created; the decision is stored on the child task as its durable model assignment, and a subtask for
   * which no model qualifies rejects the whole decomposition (fail closed).
   */
  readonly modelRouter?: GovernedModelRouterService;
  /** Per-request inference budget used for routing (ms). Default 150,000. */
  readonly modelStepBudgetMs?: number;
  /** Optional fail-safe observability instrumentation facade. */
  readonly telemetry?: EmeraldLifecycleTelemetry;
  /** Optional durable scoped memory service for decomposition & synthesis handoff continuity. */
  readonly scopedMemory?: ScopedContextMemoryService;
}

export interface DecomposedMissionResult {
  readonly missionTaskId: string;
  readonly decompositionHash: string;
  readonly subtaskTaskIds: readonly string[];
  readonly subtasks: readonly SubtaskContractSpec[];
  readonly isDuplicate: boolean;
}

export interface OrchestrationTickResult {
  readonly missionTaskId: string;
  readonly admittedRunIds: readonly string[];
  readonly cancelledRunIds: readonly string[];
  readonly subtaskReports: readonly SubtaskVerificationReport[];
  readonly isComplete: boolean;
  readonly synthesis: MissionSynthesisReport | null;
}

export interface SubtaskHierarchyNode {
  readonly taskId: string;
  readonly subtaskId: string;
  readonly role: SuperAgentRole;
  readonly objective: string;
  readonly runId: string | null;
  readonly runStatus: string | null;
  readonly verificationStatus: ChildVerificationStatus;
  readonly allowedCapabilities: readonly string[];
  readonly dependencies: readonly string[];
  readonly dependsOnTaskIds?: readonly string[];
  readonly children: readonly SubtaskHierarchyNode[];
}

export interface MultiAgentHierarchyReport {
  readonly missionTaskId: string;
  readonly missionTitle: string | null;
  readonly decompositionHash: string | null;
  readonly root: SubtaskHierarchyNode;
  readonly totalSubtasks: number;
}

export class MultiAgentOrchestrator {
  private readonly maxDepth: number;
  private readonly maxChildrenPerParent: number;
  private readonly modelRouter?: GovernedModelRouterService;
  private readonly modelStepBudgetMs: number;
  private readonly telemetry?: EmeraldLifecycleTelemetry;
  private readonly scopedMemory?: ScopedContextMemoryService;

  constructor(
    private readonly stateStore: StateStorePort,
    private readonly coordinator: RunCoordinator,
    private readonly taskRouter: TaskRouterService,
    private readonly clock: ClockPort,
    config?: MultiAgentOrchestratorConfig
  ) {
    this.maxDepth = config?.maxDepth ?? 4;
    this.maxChildrenPerParent = config?.maxChildrenPerParent ?? 8;
    this.modelRouter = config?.modelRouter;
    this.modelStepBudgetMs = config?.modelStepBudgetMs ?? 150_000;
    this.telemetry = config?.telemetry;
    this.scopedMemory =
      config?.scopedMemory ??
      (typeof (this.stateStore as any).getScopedMemoryStore === "function"
        ? new ScopedContextMemoryService((this.stateStore as any).getScopedMemoryStore(), {
            clock: this.clock,
            telemetry: this.telemetry,
          })
        : undefined);
  }

  // ===========================================================================
  // 1. Mission Decomposition
  // ===========================================================================

  /**
   * Decomposes a mission into bounded, dependency-aware subtasks governed by narrow contracts.
   * Performs DAG validation, ceiling checks, capability fencing, and resource budgeting.
   * Idempotent: re-submitting with the same canonical hash returns existing subtasks.
   */
  decomposeMission(input: DecompositionPlanInput): DecomposedMissionResult {
    try {
      const res = this.decomposeMissionCore(input);
      this.telemetry?.recordMultiAgentDecomposition({
        missionTaskId: res.missionTaskId,
        outcome: res.isDuplicate ? "duplicate" : "decomposed",
        subtaskCount: res.subtasks.length,
      });
      return res;
    } catch (err) {
      this.telemetry?.recordMultiAgentDecomposition({
        missionTaskId: input?.missionTaskId ?? "unknown",
        outcome: "rejected",
      });
      throw err;
    }
  }

  private decomposeMissionCore(input: DecompositionPlanInput): DecomposedMissionResult {
    if (!input.missionTaskId || typeof input.missionTaskId !== "string" || input.missionTaskId.trim().length === 0) {
      throw new SuperAgentDecompositionError("missionTaskId must be a non-empty string.");
    }
    const missionTaskId = input.missionTaskId.trim();

    // 1. Topological sort & DAG validation
    const sortedSubtasks = validateDecompositionDAG(input.subtasks);

    // 2. Mission task existence & parent contract lookup
    const missionTask = this.stateStore.getTask(missionTaskId);
    if (!missionTask) {
      throw new SuperAgentDecompositionError(`Mission task '${missionTaskId}' not found.`);
    }

    const contracts = this.stateStore.findContractsByTaskId(missionTaskId, "ACTIVE");
    if (contracts.length !== 1 || !contracts[0]) {
      throw new SuperAgentDecompositionError(
        `Mission task '${missionTaskId}' must have exactly one ACTIVE MissionContract, found ${contracts.length}.`
      );
    }
    const parentContract = contracts[0];

    // 3. Ceilings check: maxChildrenPerParent and maxDepth
    const effectiveMaxChildren = input.maxChildrenPerParent ?? this.maxChildrenPerParent;
    const effectiveMaxDepth = input.maxDepth ?? this.maxDepth;

    const existingChildren = this.stateStore.transaction((tx) => tx.listChildTaskRelations(missionTaskId));
    if (existingChildren.length + sortedSubtasks.length > effectiveMaxChildren) {
      throw new SuperAgentDecompositionError(
        `Decomposition of ${sortedSubtasks.length} subtasks would exceed maxChildrenPerParent (${effectiveMaxChildren}). Currently existing: ${existingChildren.length}.`
      );
    }

    const parentRel = this.stateStore.transaction((tx) => tx.getTaskRelation(missionTaskId));
    const parentDepth = parentRel ? parentRel.depth : 0;
    if (parentDepth + 1 > effectiveMaxDepth) {
      throw new SuperAgentDecompositionError(
        `Subtasks at depth ${parentDepth + 1} would exceed maxDepth ceiling (${effectiveMaxDepth}).`
      );
    }

    // 4. Resource ceiling checks
    validateSubtaskResourceCeilings(sortedSubtasks, parentContract.spec.resourceLimits);

    // 5. Capability fencing checks for all subtasks
    for (const s of sortedSubtasks) {
      validateSubtaskCapabilities(s.role, s.customCapabilities, parentContract.spec.policy.allowedCapabilities);
    }

    // 6. Compute canonical hash for the decomposition plan
    const canonicalPayload = {
      missionTaskId,
      subtasks: sortedSubtasks.map((s) => ({
        subtaskId: s.subtaskId,
        role: s.role,
        objective: s.objective,
        constraints: [...(s.constraints ?? [])].sort(),
        acceptanceCriteria: [...(s.acceptanceCriteria ?? [])].sort(),
        dependencies: [...(s.dependencies ?? [])].sort(),
        verificationSpecs: s.verificationSpecs ?? [],
        resourceLimits: s.resourceLimits ?? {},
        customCapabilities: s.customCapabilities ? [...s.customCapabilities].sort() : null,
      })),
    };
    const decompositionHash = computeCanonicalHash(canonicalPayload).contentHash;

    // 7. Check idempotency: check if the first subtask is already submitted
    const firstSubtask = sortedSubtasks[0];
    if (!firstSubtask) {
      throw new SuperAgentDecompositionError("Decomposition must contain at least one subtask.");
    }
    const firstSubtaskId = firstSubtask.subtaskId;
    const firstChildTaskId = `${missionTaskId}__sub__${firstSubtaskId}`;
    const firstSubmKey = `subtask-subm-${firstChildTaskId}`;
    const priorSubm = this.stateStore.transaction((tx) => tx.getRouterSubmissionByKey(firstSubmKey));

    if (priorSubm) {
      // Already submitted; build and return the compiled subtask records
      const existingTaskIds = sortedSubtasks.map((s) => `${missionTaskId}__sub__${s.subtaskId}`);
      const compiledSubtasks: SubtaskContractSpec[] = sortedSubtasks.map((s) => {
        const allowedCapabilities = validateSubtaskCapabilities(
          s.role,
          s.customCapabilities,
          parentContract.spec.policy.allowedCapabilities
        );
        return {
          subtaskId: s.subtaskId,
          role: s.role,
          objective: s.objective,
          constraints: Object.freeze(s.constraints ?? []),
          acceptanceCriteria: Object.freeze(s.acceptanceCriteria ?? []),
          dependencies: Object.freeze(s.dependencies ?? []),
          verificationSpecs: Object.freeze(s.verificationSpecs ?? []),
          resourceLimits: {
            timeoutMs: s.resourceLimits?.timeoutMs ?? Math.min(parentContract.spec.resourceLimits.timeoutMs, 60_000),
            maxAttempts: s.resourceLimits?.maxAttempts ?? Math.min(parentContract.spec.resourceLimits.maxAttempts, 3),
            maxOutputBytes: s.resourceLimits?.maxOutputBytes ?? parentContract.spec.resourceLimits.maxOutputBytes,
          },
          allowedCapabilities,
          allowedTools: ROLE_CAPABILITY_CONTRACTS[s.role].allowedTools,
          inputPayload: s.inputPayload ?? {},
        };
      });

      return {
        missionTaskId,
        decompositionHash,
        subtaskTaskIds: Object.freeze(existingTaskIds),
        subtasks: Object.freeze(compiledSubtasks),
        isDuplicate: true,
      };
    }

    // 8. Find or establish parent mission router submission so subtasks can link to it
    let missionSubm = this.stateStore.transaction((tx) => tx.getRouterSubmissionByTaskId(missionTaskId));
    const now = this.clock.nowIso();

    if (!missionSubm) {
      let existingRunId: string | null = null;
      try {
        const db = (this.stateStore as any).db ?? (this.stateStore as any).client?.db;
        if (db && typeof db.prepare === "function") {
          const row = db
            .prepare(`SELECT run_id FROM runs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1`)
            .get(missionTaskId) as { run_id: string } | undefined;
          if (row?.run_id) existingRunId = row.run_id;
        }
      } catch {
        // Fallback
      }

      const rootKey = `mission-root-${missionTaskId}`;
      if (existingRunId) {
        const requestHash = computeCanonicalHash({ taskId: missionTaskId, parentTaskId: null }).contentHash;
        this.stateStore.transaction((tx) => {
          tx.insertRouterSubmission({
            submissionKey: rootKey,
            taskId: missionTaskId,
            runId: existingRunId!,
            requestHash,
            createdAt: now,
          });
        });
      } else {
        this.taskRouter.submitTask({
          submissionKey: rootKey,
          taskId: missionTaskId,
        });
      }
      missionSubm = this.stateStore.transaction((tx) => tx.getRouterSubmissionByTaskId(missionTaskId));
    }

    if (missionSubm) {
      this.stateStore.transaction((tx) =>
        tx.appendEvent({
          eventId: crypto.randomUUID(),
          runId: missionSubm!.runId,
          timestamp: now,
          eventType: "subagent.decomposed",
          schemaVersion: 1,
          producer: "MultiAgentOrchestrator",
          payload: {
            missionTaskId,
            decompositionHash,
            totalSubtasks: sortedSubtasks.length,
            subtaskIds: sortedSubtasks.map((s) => s.subtaskId),
          },
        })
      );
    }

    // 9. Persist child tasks, contracts, and router submissions in topological order
    const createdTaskIds: string[] = [];
    const compiledSubtasks: SubtaskContractSpec[] = [];

    // Map subtaskId to child taskId
    const idMap = new Map<string, string>();
    for (const s of sortedSubtasks) {
      idMap.set(s.subtaskId, `${missionTaskId}__sub__${s.subtaskId}`);
    }

    // 8b. Governed model routing: every subtask is routed by role BEFORE any child is created, so a
    // subtask without a qualifying model rejects the whole decomposition and leaves no partial hierarchy.
    const modelAssignments = new Map<string, ModelAssignment>();
    if (this.modelRouter) {
      const routingTenantId = parentContract.spec.policy.tenantId ?? "unscoped";
      for (const s of sortedSubtasks) {
        const childTaskId = idMap.get(s.subtaskId)!;
        try {
          const decision = this.modelRouter.routeModel({
            role: s.role,
            tenantId: routingTenantId,
            taskId: childTaskId,
            contractId: `contract-${childTaskId}`,
            remainingBudgetMs: s.resourceLimits?.timeoutMs ?? 0,
            stepBudgetMs: this.modelStepBudgetMs,
            estimatedContextTokens: 0,
          });
          modelAssignments.set(s.subtaskId, toModelAssignment(decision));
        } catch (err: unknown) {
          if (!(err instanceof ModelRoutingError)) throw err;
          if (missionSubm) {
            this.stateStore.transaction((tx) =>
              tx.appendEvent({
                eventId: crypto.randomUUID(),
                runId: missionSubm!.runId,
                timestamp: now,
                eventType: "model.routing.rejected",
                schemaVersion: 1,
                producer: "MultiAgentOrchestrator",
                payload: {
                  missionTaskId,
                  subtaskId: s.subtaskId,
                  childTaskId,
                  role: s.role,
                  reason: err.message,
                  rejectedCandidates: (err as { rejectedCandidates?: unknown }).rejectedCandidates ?? [],
                },
              })
            );
          }
          throw new SuperAgentDecompositionError(
            `Subtask '${s.subtaskId}' (${s.role}) cannot be assigned a model: ${err.message}`
          );
        }
      }
    }

    for (const s of sortedSubtasks) {
      const childTaskId = idMap.get(s.subtaskId)!;
      createdTaskIds.push(childTaskId);

      const allowedCaps = validateSubtaskCapabilities(
        s.role,
        s.customCapabilities,
        parentContract.spec.policy.allowedCapabilities
      );

      const defaultTimeout = Math.floor(parentContract.spec.resourceLimits.timeoutMs / Math.max(1, sortedSubtasks.length));
      const timeoutMs = s.resourceLimits?.timeoutMs ?? defaultTimeout;
      const maxAttempts = s.resourceLimits?.maxAttempts ?? Math.min(parentContract.spec.resourceLimits.maxAttempts, 3);
      const maxOutputBytes = s.resourceLimits?.maxOutputBytes ?? parentContract.spec.resourceLimits.maxOutputBytes;

      const compiled: SubtaskContractSpec = {
        subtaskId: s.subtaskId,
        role: s.role,
        objective: s.objective,
        constraints: Object.freeze(s.constraints ?? []),
        acceptanceCriteria: Object.freeze(s.acceptanceCriteria ?? []),
        dependencies: Object.freeze(s.dependencies ?? []),
        verificationSpecs: Object.freeze(s.verificationSpecs ?? []),
        resourceLimits: { timeoutMs, maxAttempts, maxOutputBytes },
        allowedCapabilities: allowedCaps,
        allowedTools: ROLE_CAPABILITY_CONTRACTS[s.role].allowedTools,
        inputPayload: s.inputPayload ?? {},
      };
      compiledSubtasks.push(compiled);

      // Create Task
      this.coordinator.createTask({
        taskId: childTaskId,
        title: `[${s.role}] ${s.subtaskId}`,
        description: s.objective,
        inputPayload: {
          subtaskId: s.subtaskId,
          missionTaskId,
          role: s.role,
          objective: s.objective,
          constraints: s.constraints ?? [],
          acceptanceCriteria: s.acceptanceCriteria ?? [],
          dependencies: s.dependencies ?? [],
          ...(s.inputPayload ?? {}),
          // Written last so a client-supplied inputPayload can never set or override the assignment.
          ...(this.modelRouter
            ? { modelAssignment: modelAssignments.get(s.subtaskId)! }
            : { modelAssignment: undefined }),
        },
      });

      // Create narrow MissionContract for subagent
      const childPolicy = createExecutionPolicy({
        policyId: `policy-${childTaskId}`,
        allowedCapabilities: allowedCaps,
        isolationRequirement: parentContract.spec.policy.isolationRequirement,
        trustClassification: parentContract.spec.policy.trustClassification,
        requireRootlessDaemon: parentContract.spec.policy.requireRootlessDaemon,
        ...(parentContract.spec.policy.tenantId ? { tenantId: parentContract.spec.policy.tenantId } : {}),
      });

      const vSpecs = s.verificationSpecs && s.verificationSpecs.length > 0
        ? s.verificationSpecs.map((v, idx) => transformVerificationSpecInput(v, idx))
        : [];

      const childContract = createMissionContract({
        contractId: `contract-${childTaskId}`,
        version: 1,
        taskId: childTaskId,
        policy: childPolicy,
        verificationSpecs: vSpecs,
        resourceLimits: createResourceLimits({ timeoutMs, maxAttempts, maxOutputBytes }),
        credentialScopes: [],
      });

      this.stateStore.insertContract(childContract);
      this.stateStore.activateContract(childContract.spec.contractId, 1, this.clock.nowIso());

      // Determine tree parent in TaskRouter (preserving hierarchy nesting) AND pass ALL
      // resolved DAG predecessor task IDs via dependsOnTaskIds so multi-parent readiness
      // and cascading cancellation are enforced durably in SQLite (WS-B).
      const resolvedDepTaskIds: string[] = [];
      for (const depSubtaskId of s.dependencies ?? []) {
        const depTaskId = idMap.get(depSubtaskId);
        if (depTaskId && !resolvedDepTaskIds.includes(depTaskId)) {
          resolvedDepTaskIds.push(depTaskId);
        }
      }
      let routerParentId = missionTaskId;
      if (resolvedDepTaskIds.length > 0) {
        routerParentId = resolvedDepTaskIds[resolvedDepTaskIds.length - 1]!;
      }

      // Submit to TaskRouter with full multi-parent dependency edge preservation
      const submKey = `subtask-subm-${childTaskId}`;
      const submResult = this.taskRouter.submitTask({
        submissionKey: submKey,
        taskId: childTaskId,
        parentTaskId: routerParentId,
        dependsOnTaskIds: resolvedDepTaskIds.length > 0 ? resolvedDepTaskIds : [missionTaskId],
        timeoutMs,
        maxAttempts,
        maxOutputBytes,
      });

      // Append subagent.spawned event
      this.stateStore.transaction((tx) =>
        tx.appendEvent({
          eventId: crypto.randomUUID(),
          runId: submResult.runId,
          timestamp: this.clock.nowIso(),
          eventType: "subagent.spawned",
          schemaVersion: 1,
          producer: "MultiAgentOrchestrator",
          payload: {
            missionTaskId,
            subtaskId: s.subtaskId,
            childTaskId,
            childRunId: submResult.runId,
            role: s.role,
            allowedCapabilities: allowedCaps,
            dependencies: s.dependencies ?? [],
            ...(modelAssignments.has(s.subtaskId) ? { modelAssignment: modelAssignments.get(s.subtaskId) } : {}),
          },
        })
      );
      // Record scoped handoff summary for child subtask initialization
      if (this.scopedMemory) {
        try {
          const parentTenantId =
            this.stateStore.findContractsByTaskId(missionTaskId, "ACTIVE")[0]?.spec.policy.tenantId ??
            "tenant-default";
          this.scopedMemory.recordEntry(
            parentTenantId,
            childTaskId,
            "CURRENT_TASK_CONTEXT",
            "orchestrator.decompose",
            JSON.stringify({
              missionTaskId,
              subtaskId: s.subtaskId,
              role: s.role,
              objective: s.objective,
              dependencies: s.dependencies ?? [],
            }),
            {
              runId: submResult.runId,
              isModelGenerated: false,
              isIndependentlyVerified: false,
              idempotencyKey: `m42:handoff:${childTaskId}`,
              nowIso: this.clock.nowIso(),
            }
          );
        } catch { /* non-fatal handoff summary */ }
      }
    }

    return Object.freeze({
      missionTaskId,
      decompositionHash,
      subtaskTaskIds: Object.freeze(createdTaskIds),
      subtasks: Object.freeze(compiledSubtasks),
      isDuplicate: false,
    });
  }

  // ===========================================================================
  // 2. Independent Child Verification
  // ===========================================================================

  /**
   * Independently evaluates verification status for a child subtask.
   * Zero self-approval: unverified or failing subtasks are classified fail-closed.
   */
  evaluateChildVerification(childTaskId: string): SubtaskVerificationReport {
    const task = this.stateStore.getTask(childTaskId);
    const subtaskId = (task?.inputPayload as any)?.subtaskId ?? childTaskId;
    const role: SuperAgentRole = (task?.inputPayload as any)?.role ?? "CODER";

    const sub = this.stateStore.transaction((tx) => tx.getRouterSubmissionByTaskId(childTaskId));
    if (!sub) {
      return {
        subtaskId,
        taskId: childTaskId,
        runId: null,
        role,
        runStatus: null,
        status: "BLOCKED",
        verifiedAt: this.clock.nowIso(),
        reason: `Subtask '${childTaskId}' is not routed.`,
        verificationPassed: false,
        evidenceCount: 0,
      };
    }

    const run = this.stateStore.getRun(sub.runId);
    if (!run) {
      return {
        subtaskId,
        taskId: childTaskId,
        runId: sub.runId,
        role,
        runStatus: null,
        status: "BLOCKED",
        verifiedAt: this.clock.nowIso(),
        reason: `Subtask run '${sub.runId}' not found.`,
        verificationPassed: false,
        evidenceCount: 0,
      };
    }

    const runStatus = run.status;

    // In-flight or paused run
    if (
      runStatus === "CREATED" ||
      runStatus === "QUEUED" ||
      runStatus === "LEASED" ||
      runStatus === "RUNNING" ||
      runStatus === "VERIFYING" ||
      runStatus === "WAITING_APPROVAL" ||
      runStatus === "RECOVERING"
    ) {
      return {
        subtaskId,
        taskId: childTaskId,
        runId: run.runId,
        role,
        runStatus,
        status: "BLOCKED",
        verifiedAt: this.clock.nowIso(),
        reason: `Subtask run is currently in state '${runStatus}'.`,
        verificationPassed: false,
        evidenceCount: 0,
      };
    }

    // Failed or cancelled run
    if (runStatus === "FAILED" || runStatus === "TIMED_OUT" || runStatus === "CANCELLED") {
      return {
        subtaskId,
        taskId: childTaskId,
        runId: run.runId,
        role,
        runStatus,
        status: "BLOCKED",
        verifiedAt: this.clock.nowIso(),
        reason: `Subtask terminated with state '${runStatus}'.`,
        verificationPassed: false,
        evidenceCount: 0,
      };
    }

    // Run COMPLETED: verify against authoritative MissionContract specs
    const contracts = this.stateStore.findContractsByTaskId(childTaskId, "ACTIVE");
    const contract = contracts[0];

    if (!contract || contract.spec.verificationSpecs.length === 0) {
      // Zero self-approval: unverified tasks cannot claim completion
      return {
        subtaskId,
        taskId: childTaskId,
        runId: run.runId,
        role,
        runStatus,
        status: "UNVERIFIABLE",
        verifiedAt: this.clock.nowIso(),
        reason: "Subtask contract contains no bound verification specifications. Cannot verify autonomously.",
        verificationPassed: false,
        evidenceCount: 0,
      };
    }

    // Inspect events for independent verification outcome
    const events = this.stateStore.getEventsForRun(run.runId);
    const completedEvent = events.find((e) => e.eventType === "verification.completed");
    const rejectedEvent = events.find((e) => e.eventType === "verification.rejected");
    const evidenceEvents = events.filter((e) => e.eventType === "evidence.recorded");

    const now = this.clock.nowIso();
    const missionTaskId = (task?.inputPayload as any)?.missionTaskId ?? childTaskId;

    if (completedEvent && !rejectedEvent) {
      // Record subagent.verified event
      this.stateStore.transaction((tx) =>
        tx.appendEvent({
          eventId: crypto.randomUUID(),
          runId: run.runId,
          timestamp: now,
          eventType: "subagent.verified",
          schemaVersion: 1,
          producer: "MultiAgentOrchestrator",
          payload: {
            missionTaskId,
            subtaskId,
            childTaskId,
            childRunId: run.runId,
            verificationStatus: "VERIFIED",
            evidenceCount: evidenceEvents.length,
          },
        })
      );

      return {
        subtaskId,
        taskId: childTaskId,
        runId: run.runId,
        role,
        runStatus,
        status: "VERIFIED",
        verifiedAt: now,
        reason: "All bound verification specifications passed successfully.",
        verificationPassed: true,
        evidenceCount: evidenceEvents.length,
      };
    } else {
      // Record subagent.rejected event
      const rejectionReason = (rejectedEvent?.payload as any)?.reason ?? "Verification specifications did not pass.";
      this.stateStore.transaction((tx) =>
        tx.appendEvent({
          eventId: crypto.randomUUID(),
          runId: run.runId,
          timestamp: now,
          eventType: "subagent.rejected",
          schemaVersion: 1,
          producer: "MultiAgentOrchestrator",
          payload: {
            missionTaskId,
            subtaskId,
            childTaskId,
            childRunId: run.runId,
            verificationStatus: "REJECTED",
            reason: rejectionReason,
          },
        })
      );

      return {
        subtaskId,
        taskId: childTaskId,
        runId: run.runId,
        role,
        runStatus,
        status: "REJECTED",
        verifiedAt: now,
        reason: rejectionReason,
        verificationPassed: false,
        evidenceCount: evidenceEvents.length,
      };
    }
  }

  // ===========================================================================
  // 3. Mission Synthesis & Gate Evaluation
  // ===========================================================================

  /**
   * Synthesizes the overall mission outcome from all subtask verification reports.
   * Zero self-approval: ANY rejected, blocked, or unverifiable child blocks mission completion.
   */
  synthesizeMission(missionTaskId: string): MissionSynthesisReport {
    const res = this.synthesizeMissionCore(missionTaskId);
    this.telemetry?.recordMultiAgentSynthesis({
      missionTaskId: res.missionTaskId,
      verdict: res.verdict,
    });
    return res;
  }

  private synthesizeMissionCore(missionTaskId: string): MissionSynthesisReport {
    const missionTask = this.stateStore.getTask(missionTaskId);
    if (!missionTask) {
      throw new SynthesisVerificationError(`Mission task '${missionTaskId}' not found.`);
    }

    const missionSubm = this.stateStore.transaction((tx) => tx.getRouterSubmissionByTaskId(missionTaskId));
    const missionRunId = missionSubm?.runId ?? null;

    // Collect all child tasks in the mission tree
    const allChildTaskIds = this.collectSubtaskTaskIds(missionTaskId);
    const subtaskReports: SubtaskVerificationReport[] = allChildTaskIds.map((id) =>
      this.evaluateChildVerification(id)
    );

    let verifiedCount = 0;
    let rejectedCount = 0;
    let blockedCount = 0;
    let unverifiableCount = 0;

    for (const rep of subtaskReports) {
      if (rep.status === "VERIFIED") verifiedCount++;
      else if (rep.status === "REJECTED") rejectedCount++;
      else if (rep.status === "BLOCKED") blockedCount++;
      else if (rep.status === "UNVERIFIABLE") unverifiableCount++;
    }

    const totalSubtasks = subtaskReports.length;
    let verdict: MissionSynthesisVerdict = "BLOCKED";
    let summary = "";
    let canCompleteMission = false;

    if (totalSubtasks === 0) {
      verdict = "BLOCKED";
      summary = `Mission '${missionTaskId}' has no subtasks registered.`;
      canCompleteMission = false;
    } else if (rejectedCount > 0) {
      verdict = "FAILED";
      const rejected = subtaskReports.find((r) => r.status === "REJECTED")!;
      summary = `Synthesis rejected: subtask '${rejected.subtaskId}' was REJECTED (${rejected.reason}).`;
      canCompleteMission = false;
    } else if (unverifiableCount > 0) {
      verdict = "BLOCKED";
      const unverifiable = subtaskReports.find((r) => r.status === "UNVERIFIABLE")!;
      summary = `Synthesis blocked: subtask '${unverifiable.subtaskId}' is UNVERIFIABLE without verification specifications.`;
      canCompleteMission = false;
    } else if (blockedCount > 0) {
      // Check if any are still in-flight
      const inFlight = subtaskReports.some(
        (r) =>
          r.runStatus &&
          ["CREATED", "QUEUED", "LEASED", "RUNNING", "VERIFYING", "WAITING_APPROVAL", "RECOVERING"].includes(
            r.runStatus
          )
      );
      if (inFlight) {
        verdict = "IN_PROGRESS";
        summary = `Synthesis in progress: ${verifiedCount}/${totalSubtasks} subtasks verified, remainder in flight.`;
      } else {
        const hasFailedSubtask = subtaskReports.some((r) => r.runStatus === "FAILED" || r.runStatus === "CANCELLED");
        verdict = hasFailedSubtask ? "FAILED" : "BLOCKED";
        const blocked = subtaskReports.find((r) => r.status === "BLOCKED")!;
        summary = `Synthesis ${hasFailedSubtask ? "failed" : "blocked"}: subtask '${blocked.subtaskId}' is in non-completed state (${blocked.reason}).`;
      }
      canCompleteMission = false;
    } else if (verifiedCount === totalSubtasks && totalSubtasks > 0) {
      verdict = "SUCCESS";
      summary = `All ${totalSubtasks} subtasks independently verified. Mission synthesis successful.`;
      canCompleteMission = true;
    }

    const now = this.clock.nowIso();

    // Append mission.synthesized event if parent run exists
    if (missionRunId) {
      this.stateStore.transaction((tx) =>
        tx.appendEvent({
          eventId: crypto.randomUUID(),
          runId: missionRunId,
          timestamp: now,
          eventType: "mission.synthesized",
          schemaVersion: 1,
          producer: "MultiAgentOrchestrator",
          payload: {
            missionTaskId,
            verdict,
            totalSubtasks,
            verifiedCount,
            rejectedCount,
            blockedCount,
            summary,
          },
        })
      );
      // Record synthesis outcome in scoped durable memory
      if (this.scopedMemory) {
        try {
          const missionTenantId =
            this.stateStore.findContractsByTaskId(missionTaskId, "ACTIVE")[0]?.spec.policy.tenantId ??
            "tenant-default";
          this.scopedMemory.recordEntry(
            missionTenantId,
            missionTaskId,
            verdict === "SUCCESS" && canCompleteMission ? "VERIFIED_EVIDENCE" : "DURABLE_TASK_HISTORY",
            "orchestrator.synthesize",
            summary,
            {
              runId: missionRunId,
              isModelGenerated: false,
              isIndependentlyVerified: verdict === "SUCCESS" && canCompleteMission,
              idempotencyKey: `m42:synthesize:${missionTaskId}:${verdict}`,
              nowIso: now,
            }
          );
        } catch { /* non-fatal synthesis summary */ }
      }
    }

    return Object.freeze({
      missionTaskId,
      missionRunId,
      verdict,
      totalSubtasks,
      verifiedCount,
      rejectedCount,
      blockedCount,
      unverifiableCount,
      subtaskReports: Object.freeze(subtaskReports),
      synthesizedAt: now,
      summary,
      canCompleteMission,
    });
  }

  // ===========================================================================
  // 4. Orchestration Step / Dispatch Pass
  // ===========================================================================

  /**
   * Advances subtask dispatch via TaskRouterService and evaluates synthesis.
   * If any subtask failed or was rejected, cascades cancellation to dependent descendants.
   */
  stepOrchestration(missionTaskId: string): OrchestrationTickResult {
    // 1. Dispatch tick on TaskRouter
    const tick = this.taskRouter.dispatchTick();

    // 2. Evaluate all subtask verifications
    const allChildTaskIds = this.collectSubtaskTaskIds(missionTaskId);
    const subtaskReports: SubtaskVerificationReport[] = allChildTaskIds.map((id) =>
      this.evaluateChildVerification(id)
    );

    // 3. Failure/cancellation cascading: if any subtask is REJECTED or FAILED/CANCELLED/TIMED_OUT, cancel downstream DAG
    for (const rep of subtaskReports) {
      if (
        rep.status === "REJECTED" ||
        (rep.status === "BLOCKED" &&
          (rep.runStatus === "FAILED" || rep.runStatus === "CANCELLED" || rep.runStatus === "TIMED_OUT"))
      ) {
        try {
          this.taskRouter.cancelTaskTree(rep.taskId, `Cascaded cancellation from failed subtask '${rep.subtaskId}'`);
        } catch {
          // Best-effort cascade
        }
      }
    }

    // 4. Synthesis evaluation
    const synthesis = this.synthesizeMission(missionTaskId);
    const isComplete = synthesis.verdict === "SUCCESS" || synthesis.verdict === "FAILED";

    return Object.freeze({
      missionTaskId,
      admittedRunIds: tick.admittedRunIds,
      cancelledRunIds: tick.cancelledRunIds,
      subtaskReports: Object.freeze(subtaskReports),
      isComplete,
      synthesis,
    });
  }

  // ===========================================================================
  // 5. Hierarchy & Tree Inspection
  // ===========================================================================

  /**
   * Constructs the full tree hierarchy of a mission and all its subtasks.
   */
  getHierarchy(missionTaskId: string): MultiAgentHierarchyReport {
    const missionTask = this.stateStore.getTask(missionTaskId);
    if (!missionTask) {
      throw new SuperAgentDecompositionError(`Mission task '${missionTaskId}' not found.`);
    }

    let decompositionHash: string | null = null;
    const missionSubm = this.stateStore.transaction((tx) => tx.getRouterSubmissionByTaskId(missionTaskId));
    if (missionSubm) {
      const events = this.stateStore.getEventsForRun(missionSubm.runId);
      const decompEvent = events.find((e) => e.eventType === "subagent.decomposed");
      if (decompEvent) {
        decompositionHash = (decompEvent.payload as any)?.decompositionHash ?? null;
      }
    }

    const buildNode = (taskId: string, visited: Set<string>): SubtaskHierarchyNode => {
      if (visited.has(taskId)) {
        throw new SuperAgentDecompositionError(`Cycle detected in hierarchy tree at task '${taskId}'.`);
      }
      visited.add(taskId);

      const t = this.stateStore.getTask(taskId);
      const subtaskId = (t?.inputPayload as any)?.subtaskId ?? taskId;
      const role: SuperAgentRole = (t?.inputPayload as any)?.role ?? "CODER";
      const objective = t?.description ?? "";
      const dependencies = (t?.inputPayload as any)?.dependencies ?? [];
      const durableDepRecords = this.stateStore.transaction((tx) =>
        tx.listTaskDependencies ? tx.listTaskDependencies(taskId) : []
      );
      const dependsOnTaskIds = durableDepRecords.map((d) => d.parentTaskId);

      const sub = this.stateStore.transaction((tx) => tx.getRouterSubmissionByTaskId(taskId));
      const run = sub ? this.stateStore.getRun(sub.runId) : null;
      const runStatus = run?.status ?? null;

      const contracts = this.stateStore.findContractsByTaskId(taskId, "ACTIVE");
      const contract = contracts[0];
      const allowedCapabilities = contract?.spec?.policy?.allowedCapabilities ?? [];

      const verificationReport = taskId === missionTaskId
        ? null
        : this.evaluateChildVerification(taskId);

      const verificationStatus: ChildVerificationStatus = verificationReport
        ? verificationReport.status
        : (runStatus === "COMPLETED" ? "VERIFIED" : "BLOCKED");

      const childRelations = this.stateStore.transaction((tx) => tx.listChildTaskRelations(taskId));
      const children: SubtaskHierarchyNode[] = childRelations.map((rel) =>
        buildNode(rel.childTaskId, new Set(visited))
      );

      return {
        taskId,
        subtaskId,
        role,
        objective,
        runId: sub?.runId ?? null,
        runStatus,
        verificationStatus,
        allowedCapabilities,
        dependencies,
        ...(dependsOnTaskIds.length > 0 ? { dependsOnTaskIds } : {}),
        children: Object.freeze(children),
      };
    };

    const root = buildNode(missionTaskId, new Set());
    const totalSubtasks = this.collectSubtaskTaskIds(missionTaskId).length;

    return Object.freeze({
      missionTaskId,
      missionTitle: missionTask.title,
      decompositionHash,
      root: Object.freeze(root),
      totalSubtasks,
    });
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Recursively collects all child task IDs under a parent task.
   */
  private collectSubtaskTaskIds(parentTaskId: string): readonly string[] {
    const visited = new Set<string>();
    const taskIds: string[] = [];

    const traverse = (currentId: string) => {
      const relations = this.stateStore.transaction((tx) => tx.listChildTaskRelations(currentId));
      for (const r of relations) {
        if (!visited.has(r.childTaskId)) {
          visited.add(r.childTaskId);
          taskIds.push(r.childTaskId);
          traverse(r.childTaskId);
        }
      }
    };

    traverse(parentTaskId);
    return Object.freeze(taskIds);
  }
}
