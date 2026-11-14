/**
 * Frontend Component Logic & State Transformers (Track C)
 *
 * Implements pure state formatting and transformation logic for:
 * - Dashboard overview
 * - Live execution timeline
 * - Tool inspector
 * - Verification evidence viewer
 * - Model evaluation comparison
 */

import type {
  ExecutionEvent,
  SseEventEnvelope,
  RunRecord,
  TaskRecord,
  TrialFinalOutcome,
  TaskStatus,
  ExecutionMode,
  CreateTaskRequest,
} from "../types/api.js";

export interface TimelineStepView {
  readonly stepIndex: number;
  readonly timestamp: string;
  readonly thought?: string;
  readonly toolCalls: Array<{
    readonly toolName: string;
    readonly args: Record<string, unknown>;
    readonly approved: boolean;
    readonly durationMs?: number;
    readonly exitCode?: number;
  }>;
}

const LEGACY_TIMELINE_EVENT_MAP: Readonly<Record<string, string>> = {
  "agent.step.started": "legacy.step.started",
  "tool.requested": "legacy.tool.requested",
  "policy.checked": "legacy.policy.checked",
  "tool.completed": "legacy.tool.completed",
};

/**
 * Separates deprecated Milestone 2.x fixture event names from canonical
 * `SSE_EVENT_TYPES` while preserving backward-compatible timeline parsing.
 */
export function isLegacyTimelineEvent(eventType: string): boolean {
  return Object.prototype.hasOwnProperty.call(LEGACY_TIMELINE_EVENT_MAP, eventType);
}

export function buildTimelineSteps(
  events: readonly (ExecutionEvent | SseEventEnvelope)[]
): TimelineStepView[] {
  const steps: TimelineStepView[] = [];
  let currentStep: TimelineStepView | null = null;

  const ensureStep = (timestamp: string, thought?: string): TimelineStepView => {
    if (!currentStep) {
      currentStep = {
        stepIndex: steps.length + 1,
        timestamp,
        thought,
        toolCalls: [],
      };
    }
    return currentStep;
  };

  const pushStandaloneMilestone = (
    timestamp: string,
    thought: string,
    toolName: string,
    args: Record<string, unknown>,
    approved: boolean,
    exitCode?: number
  ) => {
    if (currentStep) {
      steps.push(currentStep);
      currentStep = null;
    }
    steps.push({
      stepIndex: steps.length + 1,
      timestamp,
      thought,
      toolCalls: [
        {
          toolName,
          args,
          approved,
          exitCode,
        },
      ],
    });
  };

  for (const rawEvt of events) {
    const evt = rawEvt as any;
    const eventType: string = evt.event || "";
    const data: Record<string, unknown> =
      evt.data && typeof evt.data === "object"
        ? (evt.data as Record<string, unknown>)
        : evt.payload && typeof evt.payload === "object"
        ? (evt.payload as Record<string, unknown>)
        : {};
    const timestamp: string = evt.timestamp || new Date().toISOString();

    // Canonical SSE_EVENT_TYPES handling
    if (eventType === "run.queued" || eventType === "worker.claimed") {
      ensureStep(
        timestamp,
        eventType === "run.queued" ? "Run queued for worker dispatch" : "Worker claimed run lease"
      );
    } else if (eventType === "run.started" || eventType === "attempt.started") {
      ensureStep(timestamp);
    } else if (eventType === "action.created") {
      const step = ensureStep(timestamp);
      const toolName =
        (data.toolName as string) ||
        (data.action as any)?.toolName ||
        (data.action as any)?.tool ||
        "action";
      const args =
        (data.args as Record<string, unknown>) ||
        (data.action as any)?.args ||
        (data.inputHash ? { inputHash: data.inputHash } : {});
      step.toolCalls.push({
        toolName,
        args,
        approved: false,
      });
    } else if (eventType === "policy.evaluated" || eventType === "action.authorized") {
      if (currentStep && currentStep.toolCalls.length > 0) {
        const lastTool = currentStep.toolCalls[currentStep.toolCalls.length - 1];
        const isApproved = data.allowed !== undefined ? Boolean(data.allowed) : true;
        (lastTool as { approved: boolean }).approved = isApproved;
      }
    } else if (eventType === "action.completed") {
      if (currentStep && currentStep.toolCalls.length > 0) {
        const lastTool = currentStep.toolCalls[currentStep.toolCalls.length - 1];
        const resultPayload = (data.resultPayload ?? (data as any).result) as any;
        const exitCode =
          typeof resultPayload?.exitCode === "number"
            ? resultPayload.exitCode
            : typeof (data as any).exitCode === "number"
            ? (data as any).exitCode
            : 0;
        (lastTool as { exitCode?: number }).exitCode = exitCode;
        if (typeof (data as any).durationMs === "number") {
          (lastTool as { durationMs?: number }).durationMs = (data as any).durationMs;
        }
      }
    } else if (
      eventType === "action.failed" ||
      eventType === "action.timed_out" ||
      eventType === "action.cancelled"
    ) {
      if (currentStep && currentStep.toolCalls.length > 0) {
        const lastTool = currentStep.toolCalls[currentStep.toolCalls.length - 1];
        (lastTool as { exitCode?: number }).exitCode =
          typeof (data as any).exitCode === "number" ? (data as any).exitCode : 1;
      }
    } else if (eventType === "run.waiting_approval") {
      pushStandaloneMilestone(
        timestamp,
        "Awaiting Operator Approval",
        "governance:approval_gate",
        {
          approvalRequestId: data.approvalRequestId ?? data.requestId,
          reason: data.reason ?? "Approval required before resuming execution",
        },
        false
      );
    } else if (eventType === "verification.started") {
      pushStandaloneMilestone(
        timestamp,
        "Verification Started",
        `verify:${(data.verifierId as string) || (data.specId as string) || "verifier"}`,
        {
          specId: data.specId,
          status: "IN_PROGRESS",
        },
        true
      );
    } else if (eventType === "verification.completed") {
      pushStandaloneMilestone(
        timestamp,
        "Verification Evaluation",
        `verify:${(data.verifierId as string) || (data.specId as string) || "verifier"}`,
        {
          specId: data.specId,
          message: data.message,
        },
        true,
        data.status === "VERIFIED" || data.passed === true ? 0 : 1
      );
    } else if (eventType === "verification.rejected") {
      pushStandaloneMilestone(
        timestamp,
        "Verification Rejected Completion Claim",
        "verify:rejection",
        {
          reason: data.reason ?? "UNVERIFIED_COMPLETION_CLAIM",
          message: data.message,
        },
        false,
        1
      );
    } else if (
      eventType === "run.completed" ||
      eventType === "run.failed" ||
      eventType === "run.cancelled" ||
      eventType === "run.timed_out"
    ) {
      if (currentStep) {
        steps.push(currentStep);
        currentStep = null;
      }
      steps.push({
        stepIndex: steps.length + 1,
        timestamp,
        thought: `Run terminal transition: ${eventType}`,
        toolCalls: [],
      });
    } else if (isLegacyTimelineEvent(eventType)) {
      // Explicit legacy Milestone 2.x fixture mapping (kept isolated from canonical SSE_EVENT_TYPES)
      const legacyKind = LEGACY_TIMELINE_EVENT_MAP[eventType];
      if (legacyKind === "legacy.step.started") {
        if (currentStep) {
          steps.push(currentStep);
        }
        currentStep = {
          stepIndex: (data.stepIndex as number) || steps.length + 1,
          timestamp,
          thought: typeof data.thought === "string" ? data.thought : undefined,
          toolCalls: [],
        };
      } else if (legacyKind === "legacy.tool.requested") {
        const step = ensureStep(timestamp);
        step.toolCalls.push({
          toolName: (data.toolName as string) || "unknown",
          args: (data.args as Record<string, unknown>) || {},
          approved: false,
        });
      } else if (legacyKind === "legacy.policy.checked") {
        if (currentStep && currentStep.toolCalls.length > 0) {
          const lastTool = currentStep.toolCalls[currentStep.toolCalls.length - 1];
          (lastTool as { approved: boolean }).approved = Boolean(data.approved);
        }
      } else if (legacyKind === "legacy.tool.completed") {
        if (currentStep && currentStep.toolCalls.length > 0) {
          const lastTool = currentStep.toolCalls[currentStep.toolCalls.length - 1];
          (lastTool as { durationMs?: number }).durationMs = data.durationMs as number | undefined;
          (lastTool as { exitCode?: number }).exitCode = data.exitCode as number | undefined;
        }
      }
    }
  }

  if (currentStep) {
    steps.push(currentStep);
  }

  return steps;
}

export interface OutcomeBadge {
  readonly label: string;
  readonly color: "green" | "red" | "yellow" | "gray" | "blue";
  readonly description: string;
}

export function formatOutcomeBadge(outcome: TrialFinalOutcome | null): OutcomeBadge {
  switch (outcome) {
    case "VERIFIED_SUCCESS":
      return {
        label: "Verified Success",
        color: "green",
        description: "Task independently verified against objective workspace criteria",
      };
    case "FALSE_COMPLETION":
      return {
        label: "False Completion",
        color: "red",
        description: "Agent claimed completion, but objective verification failed",
      };
    case "COMPLETION_UNVERIFIABLE":
      return {
        label: "Unverifiable",
        color: "yellow",
        description: "Verification specification missing or verifier unavailable",
      };
    case "LOOP_DETECTED":
      return {
        label: "Loop Detected",
        color: "yellow",
        description: "Execution halted due to repeated ineffective action cycles",
      };
    case "EXECUTION_FAILURE":
      return {
        label: "Execution Failure",
        color: "red",
        description: "Unhandled runtime, container, or action failure",
      };
    case "TIMEOUT":
      return {
        label: "Timed Out",
        color: "gray",
        description: "Execution step or wall-clock budget exhausted",
      };
    case "BLOCKED":
      return {
        label: "Governance Blocked",
        color: "blue",
        description: "Policy gate denied action or recovery-interrupted",
      };
    default:
      return {
        label: "Pending",
        color: "gray",
        description: "Execution currently in progress",
      };
  }
}

export interface SummarizableTaskLike {
  readonly taskId: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly executionMode: ExecutionMode;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly contractId?: string | null;
  readonly runId?: string | null;
}

export interface SummarizableRunLike {
  readonly runId: string;
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly attemptNumber: number;
  readonly currentStepIndex: number;
  readonly leaseExpiresAt: string | null;
  readonly finalOutcome: TrialFinalOutcome | null;
  readonly metrics: {
    readonly wallClockMs: number;
    readonly stepCount: number;
    readonly toolCallCount: number;
  };
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export function summarizeDashboardState(input: {
  readonly tasks: readonly SummarizableTaskLike[];
  readonly runsById?: Readonly<Record<string, SummarizableRunLike>>;
  readonly selectedRun?: SummarizableRunLike;
}) {
  const tasks: TaskRecord[] = input.tasks.map((t) => ({
    taskId: t.taskId,
    title: t.title,
    status: t.status,
    executionMode: t.executionMode,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    contractId: t.contractId ?? null,
    runId: t.runId ?? undefined,
  }));

  const runsMap = new Map<string, RunRecord>();
  const addRun = (r: SummarizableRunLike) => {
    runsMap.set(r.runId, {
      runId: r.runId,
      taskId: r.taskId,
      status: r.status,
      attemptNumber: r.attemptNumber,
      currentStepIndex: r.currentStepIndex,
      leaseExpiresAt: r.leaseExpiresAt,
      finalOutcome: r.finalOutcome,
      metrics: {
        wallClockMs: r.metrics.wallClockMs,
        stepCount: r.metrics.stepCount,
        toolCallCount: r.metrics.toolCallCount,
      },
      createdAt: r.createdAt,
      completedAt: r.completedAt,
    });
  };

  if (input.runsById) {
    for (const r of Object.values(input.runsById)) {
      if (r && r.runId) {
        addRun(r);
      }
    }
  }

  if (input.selectedRun) {
    addRun(input.selectedRun);
  }

  for (const t of input.tasks) {
    if (t.runId && !runsMap.has(t.runId)) {
      runsMap.set(t.runId, {
        runId: t.runId,
        taskId: t.taskId,
        status: t.status,
        attemptNumber: 1,
        currentStepIndex: 0,
        leaseExpiresAt: null,
        finalOutcome: null,
        metrics: { wallClockMs: 0, stepCount: 0, toolCallCount: 0 },
        createdAt: t.createdAt,
        completedAt: null,
      });
    }
  }

  return computeDashboardSummary(tasks, Array.from(runsMap.values()));
}

export function computeDashboardSummary(
  tasks: readonly TaskRecord[],
  runs: readonly RunRecord[]
) {
  const totalTasks = tasks.length;
  const runningRuns = runs.filter((r) => r.status === "RUNNING").length;
  const completedRuns = runs.filter((r) => r.status === "COMPLETED").length;
  const verifiedSuccesses = runs.filter((r) => r.finalOutcome === "VERIFIED_SUCCESS").length;
  const falseCompletions = runs.filter((r) => r.finalOutcome === "FALSE_COMPLETION").length;

  return {
    totalTasks,
    runningRuns,
    completedRuns,
    verifiedSuccesses,
    falseCompletions,
    verifiedRate: completedRuns > 0 ? verifiedSuccesses / completedRuns : 0,
  };
}

export function formatTaskStatusBadge(status: TaskStatus): OutcomeBadge {
  switch (status) {
    case "CREATED":
    case "QUEUED":
      return {
        label: status,
        color: "blue",
        description: "Task queued for worker assignment",
      };
    case "LEASED":
    case "RUNNING":
      return {
        label: status,
        color: "yellow",
        description: "Worker actively executing mission steps",
      };
    case "VERIFYING":
      return {
        label: status,
        color: "yellow",
        description: "Evaluating objective completion verification specs",
      };
    case "COMPLETED":
      return {
        label: status,
        color: "green",
        description: "Task reached terminal completion",
      };
    case "FAILED":
      return {
        label: status,
        color: "red",
        description: "Task execution or verification failed",
      };
    case "CANCELLED":
      return {
        label: status,
        color: "gray",
        description: "Task was cancelled by operator",
      };
    case "TIMED_OUT":
      return {
        label: status,
        color: "gray",
        description: "Task exhausted execution budget or lease",
      };
    case "RECOVERING":
      return {
        label: status,
        color: "yellow",
        description: "Recovery supervisor evaluating lease resumption",
      };
    case "WAITING_APPROVAL":
      return {
        label: status,
        color: "blue",
        description: "Awaiting human operator approval",
      };
    default:
      return {
        label: status,
        color: "gray",
        description: "Unknown task lifecycle status",
      };
  }
}

export function formatExecutionModeBadge(mode: ExecutionMode): OutcomeBadge {
  switch (mode) {
    case "sandboxed":
      return {
        label: "Sandboxed (OCI/Docker)",
        color: "green",
        description: "Isolated non-root execution container with dropped capabilities and no-new-privileges",
      };
    case "constrained_host":
      return {
        label: "Constrained Host",
        color: "yellow",
        description: "Internal trusted execution mode reserved strictly for server-authorized principals",
      };
    default:
      return {
        label: mode,
        color: "gray",
        description: "Unknown execution environment",
      };
  }
}

export function validateTaskSubmissionInput(input: Partial<CreateTaskRequest>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (!input.title || input.title.trim().length === 0) {
    errors.push("Title is required and must not be empty.");
  } else if (input.title.length > 256) {
    errors.push("Title must not exceed 256 characters.");
  }

  if (!input.prompt || input.prompt.trim().length === 0) {
    errors.push("Prompt is required and must not be empty.");
  } else if (input.prompt.length > 65536) {
    errors.push("Prompt must not exceed 65,536 characters.");
  }

  if (input.executionMode && input.executionMode !== "sandboxed") {
    errors.push("External tenant submission must use sandboxed execution mode.");
  }

  if ("allowUnverifiedCompletion" in (input as Record<string, unknown>)) {
    errors.push("allowUnverifiedCompletion is forbidden in public task submissions.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
