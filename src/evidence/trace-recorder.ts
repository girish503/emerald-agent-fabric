/**
 * Non-Invasive Execution Trace Recorder for Emerald Agent Fabric (Idea 3, Phase 1).
 *
 * Reconstructs a validated, redacted `RunTrace` directly from durable `run_events`,
 * `runs`, `actions`, `attempts`, `approval_requests`, `mission_contracts`, and
 * optional `ProductionEvidenceBundle` records without making any model calls,
 * approval requests, or mutating run execution behavior.
 */

import {
  TRACE_FORMAT_VERSION,
  RunTrace,
  TraceApprovalEvent,
  TraceModelRecord,
  TraceProvenance,
  TraceRepairAttempt,
  TraceSpan,
  TraceSpanStatus,
  TraceVerificationVerdict,
  toRedactedTraceSummary,
  validateRunTrace,
} from "../domain/trace.js";
import type { ActionSnapshot } from "../domain/action.js";
import type { AttemptSnapshot } from "../domain/attempt.js";
import type { RunSnapshot } from "../domain/invariants.js";
import type { MissionContract } from "../domain/mission-contract.js";
import type {
  DurableApprovalRecord,
  PersistedEvent,
  StateStorePort,
} from "../ports/state-store.port.js";
import type { SqliteTraceStore } from "../adapters/persistence/sqlite-trace-store.js";
import type { ProductionEvidenceBundle } from "../control-plane/evidence-control.js";

export interface BuildTraceOptions {
  readonly missionId?: string;
  readonly recordedAt?: string;
  readonly parentTaskIds?: readonly string[];
  readonly evidenceBundle?: ProductionEvidenceBundle;
  readonly modelOverride?: TraceModelRecord | null;
}

export interface TraceBuildSource {
  readonly run: RunSnapshot;
  readonly contract: MissionContract | null;
  readonly events: readonly PersistedEvent[];
  readonly actions: readonly ActionSnapshot[];
  readonly attemptsByActionId: ReadonlyMap<string, readonly AttemptSnapshot[]>;
  readonly approvals: readonly DurableApprovalRecord[];
  readonly parentTaskIds?: readonly string[];
}

function mapRunStatusToSpanStatus(status: string): TraceSpanStatus {
  switch (status) {
    case "COMPLETED":
      return "OK";
    case "WAITING_APPROVAL":
      return "PAUSED";
    case "TIMED_OUT":
      return "TIMED_OUT";
    case "CANCELLED":
      return "CANCELLED";
    case "FAILED":
    case "QUARANTINED":
      return "ERROR";
    default:
      return "UNSET";
  }
}

function mapActionStatusToSpanStatus(status: string): TraceSpanStatus {
  switch (status) {
    case "COMPLETED":
      return "OK";
    case "TIMED_OUT":
      return "TIMED_OUT";
    case "CANCELLED":
      return "CANCELLED";
    case "DENIED":
    case "REJECTED":
      return "DENIED";
    case "FAILED":
      return "ERROR";
    default:
      return "UNSET";
  }
}

function safeIsoTimestamp(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim().length > 0 && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return fallback;
}

function computeLatencyMs(startedAt: string, endedAt: string | null): number {
  if (!endedAt) return 0;
  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(endedAt);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return 0;
  return Math.max(0, endMs - startMs);
}

function inferToolProvenance(
  toolName: string,
  payload: Record<string, unknown> | null
): TraceProvenance {
  const explicit = payload?.provenance;
  if (explicit === "trusted" || explicit === "untrusted") {
    return explicit;
  }
  if (payload?.untrusted === true || payload?.source === "UNTRUSTED_OBSERVATION") {
    return "untrusted";
  }
  if (toolName.startsWith("connector.") || toolName.startsWith("external.")) {
    return "untrusted";
  }
  return "trusted";
}

function extractPinnedModelRecord(
  events: readonly PersistedEvent[],
  contract: MissionContract | null,
  run: RunSnapshot,
  override?: TraceModelRecord | null
): TraceModelRecord | null {
  if (override !== undefined) {
    return override;
  }

  const telemetryEvents = events.filter((e) => e.eventType === "model.inference.telemetry");
  if (telemetryEvents.length === 0) {
    // Stub / in-process execution with no model inference calls.
    return null;
  }

  const firstPayload = (telemetryEvents[0]?.payload ?? {}) as Record<string, unknown>;
  const provider =
    typeof firstPayload.provider === "string" && firstPayload.provider.trim().length > 0
      ? firstPayload.provider
      : "unknown";
  const model =
    typeof firstPayload.model === "string" && firstPayload.model.trim().length > 0
      ? firstPayload.model
      : "unknown";
  const params =
    firstPayload.modelParameters && typeof firstPayload.modelParameters === "object"
      ? (firstPayload.modelParameters as Record<string, unknown>)
      : {};

  const temperature =
    typeof params.temperature === "number" && Number.isFinite(params.temperature)
      ? Math.max(0, Math.min(2, params.temperature))
      : null;
  const seed =
    typeof params.seed === "number" && Number.isInteger(params.seed) ? params.seed : null;
  const toolList = [...(contract?.spec?.policy?.allowedCapabilities ?? [])].sort();

  return {
    provider,
    model,
    temperature,
    seed,
    toolList,
    retryBudget: Math.max(0, run.maxAttempts),
  };
}

/**
 * Deterministically builds and validates a `RunTrace` from existing durable run records.
 */
export function buildTraceFromRunData(
  source: TraceBuildSource,
  options: BuildTraceOptions = {}
): RunTrace {
  const { run, contract, events, actions, attemptsByActionId, approvals } = source;
  const createdAt = safeIsoTimestamp(run.createdAt, new Date().toISOString());
  const traceId = `trace-${run.runId}`;
  const missionId = options.missionId ?? options.evidenceBundle?.missionId ?? run.taskId;
  const tenantId = contract?.spec?.policy?.tenantId ?? "default-tenant";

  const rootSpanId = `span-agent-${run.runId}`;
  const lastEventTs =
    events.length > 0 ? safeIsoTimestamp(events[events.length - 1]!.timestamp, createdAt) : null;
  const isTerminalOrPaused = [
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "TIMED_OUT",
    "QUARANTINED",
    "WAITING_APPROVAL",
  ].includes(run.status);
  const rootEndedAt = isTerminalOrPaused ? safeIsoTimestamp(run.updatedAt, lastEventTs ?? createdAt) : null;

  const childSpans: TraceSpan[] = [];
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let hasTokenCounts = false;
  let totalCostUsd = 0;
  let hasCost = false;

  // 1. LLM spans from model.inference.telemetry events
  for (const event of events) {
    if (event.eventType !== "model.inference.telemetry") continue;
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const requestId = typeof p.requestId === "string" && p.requestId.length > 0
      ? p.requestId
      : `seq-${event.sequence}`;
    const startedAt = safeIsoTimestamp(p.startedAt, safeIsoTimestamp(event.timestamp, createdAt));
    const endedAt = safeIsoTimestamp(p.completedAt, safeIsoTimestamp(event.timestamp, startedAt));
    const latencyMs =
      typeof p.wallClockDurationMs === "number" && p.wallClockDurationMs >= 0
        ? p.wallClockDurationMs
        : computeLatencyMs(startedAt, endedAt);

    const tokensIn =
      typeof p.promptEvalCount === "number" && Number.isInteger(p.promptEvalCount) && p.promptEvalCount >= 0
        ? p.promptEvalCount
        : null;
    const tokensOut =
      typeof p.evalCount === "number" && Number.isInteger(p.evalCount) && p.evalCount >= 0
        ? p.evalCount
        : null;
    const costUsd =
      typeof p.costUsd === "number" && Number.isFinite(p.costUsd) && p.costUsd >= 0
        ? p.costUsd
        : null;

    if (tokensIn !== null) {
      totalTokensIn += tokensIn;
      hasTokenCounts = true;
    }
    if (tokensOut !== null) {
      totalTokensOut += tokensOut;
      hasTokenCounts = true;
    }
    if (costUsd !== null) {
      totalCostUsd += costUsd;
      hasCost = true;
    }

    const outcome = String(p.outcome ?? "ERROR");
    const status: TraceSpanStatus =
      outcome === "SUCCESS"
        ? "OK"
        : outcome === "TIMEOUT"
          ? "TIMED_OUT"
          : outcome === "CANCELLED"
            ? "CANCELLED"
            : "ERROR";

    childSpans.push({
      spanId: `span-llm-${requestId}`,
      parentSpanId: rootSpanId,
      kind: "llm",
      name: `llm:${String(p.provider ?? "unknown")}/${String(p.model ?? "unknown")}`,
      startedAt,
      endedAt,
      latencyMs,
      tokensIn,
      tokensOut,
      costUsd,
      status,
      provenance: null,
      argsSummary: toRedactedTraceSummary({
        stepNumber: p.stepNumber ?? null,
        provider: p.provider ?? null,
        model: p.model ?? null,
        modelParameters: p.modelParameters ?? null,
      }),
      resultSummary: toRedactedTraceSummary({
        outcome,
        finishReason: p.finishReason ?? p.doneReason ?? null,
        error: p.error ?? null,
      }),
    });
  }

  // 2. Tool spans from durable actions + attempts (or tool.* events when actions are absent)
  if (actions.length > 0) {
    for (const action of actions) {
      const attempts = attemptsByActionId.get(action.actionId) ?? [];
      const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : undefined;
      const startedAt = safeIsoTimestamp(
        latestAttempt?.startedAt ?? action.createdAt,
        createdAt
      );
      const endedAt = action.completedAt
        ? safeIsoTimestamp(action.completedAt, startedAt)
        : latestAttempt?.completedAt
          ? safeIsoTimestamp(latestAttempt.completedAt, startedAt)
          : null;
      const latencyMs =
        typeof latestAttempt?.durationMs === "number" && latestAttempt.durationMs >= 0
          ? latestAttempt.durationMs
          : computeLatencyMs(startedAt, endedAt);

      const rawInput =
        action.inputPayload && typeof action.inputPayload === "object"
          ? (action.inputPayload as Record<string, unknown>)
          : null;

      childSpans.push({
        spanId: `span-tool-${action.actionId}`,
        parentSpanId: rootSpanId,
        kind: "tool",
        name: action.toolName,
        startedAt,
        endedAt,
        latencyMs,
        tokensIn: null,
        tokensOut: null,
        costUsd: null,
        status: mapActionStatusToSpanStatus(action.status),
        provenance: inferToolProvenance(action.toolName, rawInput),
        argsSummary: toRedactedTraceSummary(action.inputPayload),
        resultSummary: toRedactedTraceSummary(
          latestAttempt?.outputPayload ??
            action.resultPayload ??
            latestAttempt?.errorPayload ??
            action.errorPayload ??
            null
        ),
      });
    }
  } else {
    // Reconstruct tool spans from tool.requested / tool.completed events if present
    const openToolStarts = new Map<string, PersistedEvent>();
    for (const event of events) {
      const p = (event.payload ?? {}) as Record<string, unknown>;
      if (event.eventType === "tool.requested") {
        const key = String(p.toolCallId ?? p.actionId ?? p.toolName ?? event.sequence);
        openToolStarts.set(key, event);
      } else if (event.eventType === "tool.completed") {
        const key = String(p.toolCallId ?? p.actionId ?? p.toolName ?? event.sequence);
        const startEvent = openToolStarts.get(key);
        openToolStarts.delete(key);
        const toolName = String(p.toolName ?? "tool");
        const startedAt = safeIsoTimestamp(startEvent?.timestamp ?? event.timestamp, createdAt);
        const endedAt = safeIsoTimestamp(event.timestamp, startedAt);
        const startPayload = (startEvent?.payload ?? null) as Record<string, unknown> | null;
        const exitCode = typeof p.exitCode === "number" ? p.exitCode : 0;

        childSpans.push({
          spanId: `span-tool-${event.sequence}`,
          parentSpanId: rootSpanId,
          kind: "tool",
          name: toolName,
          startedAt,
          endedAt,
          latencyMs: computeLatencyMs(startedAt, endedAt),
          tokensIn: null,
          tokensOut: null,
          costUsd: null,
          status: p.denied === true ? "DENIED" : exitCode === 0 ? "OK" : "ERROR",
          provenance: inferToolProvenance(toolName, p),
          argsSummary: toRedactedTraceSummary(startPayload?.args ?? startPayload ?? null),
          resultSummary: toRedactedTraceSummary(p),
        });
      }
    }
  }

  // 3. Approval events & spans
  const approvalEvents: TraceApprovalEvent[] = [];
  const seenApprovalIds = new Set<string>();

  for (const appr of approvals) {
    seenApprovalIds.add(appr.approvalId);
    const requestedAt = safeIsoTimestamp(appr.requestedAt, createdAt);
    const decidedAt = appr.decidedAt ? safeIsoTimestamp(appr.decidedAt, requestedAt) : null;
    const spanStatus: TraceSpanStatus =
      appr.status === "APPROVED" || appr.status === "CONSUMED"
        ? "OK"
        : appr.status === "REJECTED"
          ? "DENIED"
          : appr.status === "EXPIRED"
            ? "TIMED_OUT"
            : "PAUSED";

    approvalEvents.push({
      approvalId: appr.approvalId,
      operation: appr.operation,
      status: appr.status,
      riskLevel: appr.riskLevel,
      requestedAt,
      decidedAt,
      approver: appr.approver ?? null,
      reasonSummary:
        appr.decisionReason !== undefined
          ? String(toRedactedTraceSummary(appr.decisionReason) ?? "")
          : appr.justification
            ? String(toRedactedTraceSummary(appr.justification) ?? "")
            : null,
    });

    childSpans.push({
      spanId: `span-approval-${appr.approvalId}`,
      parentSpanId: rootSpanId,
      kind: "approval",
      name: `approval:${appr.operation}`,
      startedAt: requestedAt,
      endedAt: decidedAt,
      latencyMs: computeLatencyMs(requestedAt, decidedAt),
      tokensIn: null,
      tokensOut: null,
      costUsd: null,
      status: spanStatus,
      provenance: null,
      argsSummary: toRedactedTraceSummary({
        operation: appr.operation,
        riskLevel: appr.riskLevel,
        parameters: appr.parameters,
      }),
      resultSummary: toRedactedTraceSummary({
        status: appr.status,
        approver: appr.approver ?? null,
        reason: appr.decisionReason ?? null,
      }),
    });
  }

  for (const event of events) {
    if (event.eventType !== "run.waiting_approval") continue;
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const approvalId = String(p.approvalId ?? `appr-seq-${event.sequence}`);
    if (seenApprovalIds.has(approvalId)) continue;
    seenApprovalIds.add(approvalId);
    const requestedAt = safeIsoTimestamp(event.timestamp, createdAt);
    const operation = String(p.operation ?? "unknown_operation");

    approvalEvents.push({
      approvalId,
      operation,
      status: "PENDING",
      riskLevel: "HIGH",
      requestedAt,
      decidedAt: null,
      approver: null,
      reasonSummary: null,
    });

    childSpans.push({
      spanId: `span-approval-${approvalId}`,
      parentSpanId: rootSpanId,
      kind: "approval",
      name: `approval:${operation}`,
      startedAt: requestedAt,
      endedAt: null,
      latencyMs: 0,
      tokensIn: null,
      tokensOut: null,
      costUsd: null,
      status: "PAUSED",
      provenance: null,
      argsSummary: toRedactedTraceSummary({ operation }),
      resultSummary: toRedactedTraceSummary({ status: "PENDING" }),
    });
  }

  // 4. Verification verdicts & spans
  const verificationVerdicts: TraceVerificationVerdict[] = [];
  let verificationStartTs: string | null = null;

  for (const event of events) {
    const ts = safeIsoTimestamp(event.timestamp, createdAt);
    if (event.eventType === "verification.started") {
      verificationStartTs = ts;
      continue;
    }

    if (event.eventType === "verification.completed") {
      const p = (event.payload ?? {}) as Record<string, unknown>;
      const rawStatus = String(p.status ?? (p.verified ? "VERIFIED" : "FAILED"));
      const verdict: TraceVerificationVerdict["verdict"] =
        rawStatus === "VERIFIED" || rawStatus === "PASSED" ? "VERIFIED" : "FAILED";
      const specId = String(p.specId ?? "default-spec");
      const verifierId = String(p.verifierId ?? "sovereign-verifier");
      const evidenceIds = Array.isArray(p.evidenceIds)
        ? p.evidenceIds.filter((id): id is string => typeof id === "string" && id.length > 0)
        : [];
      const messageSummary = String(
        toRedactedTraceSummary(p.message ?? `Verification ${verdict}`) ?? ""
      );
      const startedAt = verificationStartTs ?? ts;
      verificationStartTs = null;

      verificationVerdicts.push({
        verifierId,
        specId,
        verdict,
        verifiedAt: ts,
        proofHash: typeof p.proofHash === "string" ? p.proofHash : null,
        messageSummary,
        evidenceIds,
      });

      childSpans.push({
        spanId: `span-verification-${event.sequence}`,
        parentSpanId: rootSpanId,
        kind: "verification",
        name: `verify:${specId}`,
        startedAt,
        endedAt: ts,
        latencyMs: computeLatencyMs(startedAt, ts),
        tokensIn: null,
        tokensOut: null,
        costUsd: null,
        status: verdict === "VERIFIED" ? "OK" : "ERROR",
        provenance: null,
        argsSummary: toRedactedTraceSummary({ specId, verifierId, evidenceIds }),
        resultSummary: toRedactedTraceSummary({ verdict, message: messageSummary }),
      });
    } else if (event.eventType === "verification.rejected") {
      const p = (event.payload ?? {}) as Record<string, unknown>;
      const specId = String(p.specId ?? "completion-gate");
      const verifierId = String(p.verifierId ?? "completion-gate");
      const messageSummary = String(
        toRedactedTraceSummary(p.message ?? p.reason ?? "Verification rejected") ?? ""
      );
      const startedAt = verificationStartTs ?? ts;
      verificationStartTs = null;

      verificationVerdicts.push({
        verifierId,
        specId,
        verdict: "REJECTED",
        verifiedAt: ts,
        proofHash: null,
        messageSummary,
        evidenceIds: [],
      });

      childSpans.push({
        spanId: `span-verification-${event.sequence}`,
        parentSpanId: rootSpanId,
        kind: "verification",
        name: `verify:${specId}`,
        startedAt,
        endedAt: ts,
        latencyMs: computeLatencyMs(startedAt, ts),
        tokensIn: null,
        tokensOut: null,
        costUsd: null,
        status: "DENIED",
        provenance: null,
        argsSummary: toRedactedTraceSummary({ specId, verifierId }),
        resultSummary: toRedactedTraceSummary({ verdict: "REJECTED", message: messageSummary }),
      });
    }
  }

  // 5. Repair attempts & spans
  const repairAttempts: TraceRepairAttempt[] = [];
  let repairCounter = 0;
  for (const event of events) {
    if (event.eventType !== "repair.attempt") continue;
    repairCounter++;
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const startedAt = safeIsoTimestamp(p.startedAt ?? event.timestamp, createdAt);
    const endedAt = p.endedAt ? safeIsoTimestamp(p.endedAt, startedAt) : safeIsoTimestamp(event.timestamp, startedAt);
    const attemptNumber =
      typeof p.attemptNumber === "number" && Number.isInteger(p.attemptNumber) && p.attemptNumber >= 1
        ? p.attemptNumber
        : repairCounter;
    const category = String(p.feedbackCategory ?? p.category ?? "verification_failure");
    const rawStatus = String(p.status ?? "ATTEMPTED");
    const repairStatus: TraceRepairAttempt["status"] =
      rawStatus === "SUCCEEDED" || rawStatus === "FAILED" || rawStatus === "EXHAUSTED"
        ? rawStatus
        : "ATTEMPTED";
    const summary = String(
      toRedactedTraceSummary(p.summary ?? p.message ?? `Repair attempt ${attemptNumber} (${category})`) ?? ""
    );

    repairAttempts.push({
      attemptNumber,
      category,
      status: repairStatus,
      startedAt,
      endedAt,
      summary,
    });

    childSpans.push({
      spanId: `span-repair-${event.sequence}`,
      parentSpanId: rootSpanId,
      kind: "repair",
      name: `repair:${category}`,
      startedAt,
      endedAt,
      latencyMs: computeLatencyMs(startedAt, endedAt),
      tokensIn: null,
      tokensOut: null,
      costUsd: null,
      status: repairStatus === "SUCCEEDED" ? "OK" : repairStatus === "ATTEMPTED" ? "UNSET" : "ERROR",
      provenance: null,
      argsSummary: toRedactedTraceSummary({ attemptNumber, category }),
      resultSummary: toRedactedTraceSummary({ status: repairStatus, summary }),
    });
  }

  const rootSpan: TraceSpan = {
    spanId: rootSpanId,
    parentSpanId: null,
    kind: "agent",
    name: `run:${run.taskId}`,
    startedAt: createdAt,
    endedAt: rootEndedAt,
    latencyMs: computeLatencyMs(createdAt, rootEndedAt),
    tokensIn: hasTokenCounts ? totalTokensIn : null,
    tokensOut: hasTokenCounts ? totalTokensOut : null,
    costUsd: hasCost ? totalCostUsd : null,
    status: mapRunStatusToSpanStatus(run.status),
    provenance: null,
    argsSummary: toRedactedTraceSummary({
      taskId: run.taskId,
      contractId: run.contractBinding?.contractId ?? null,
      maxAttempts: run.maxAttempts,
    }),
    resultSummary: toRedactedTraceSummary(
      run.resultPayload ?? run.errorPayload ?? { status: run.status }
    ),
  };

  const model = extractPinnedModelRecord(events, contract, run, options.modelOverride);

  const rawTrace: RunTrace = {
    traceId,
    runId: run.runId,
    missionId,
    formatVersion: TRACE_FORMAT_VERSION,
    createdAt,
    tenantId,
    status: run.status as RunTrace["status"],
    ...(source.parentTaskIds && source.parentTaskIds.length > 0
      ? { parentTaskIds: [...source.parentTaskIds] }
      : options.parentTaskIds && options.parentTaskIds.length > 0
        ? { parentTaskIds: [...options.parentTaskIds] }
        : {}),
    model,
    spans: [rootSpan, ...childSpans],
    approvalEvents,
    verificationVerdicts,
    repairAttempts,
  };

  return validateRunTrace(rawTrace);
}

/**
 * Reads durable state/events for `runId` from `stateStore`, builds a validated
 * `RunTrace`, and persists it into `traceStore`.
 */
export function recordTraceForRun(
  stateStore: StateStorePort,
  traceStore: SqliteTraceStore,
  runId: string,
  options: BuildTraceOptions = {}
): RunTrace {
  const run = stateStore.getRun(runId);
  if (!run) {
    throw new Error(`Cannot record trace: Run '${runId}' not found.`);
  }

  const contract = run.contractBinding
    ? stateStore.getContract(run.contractBinding.contractId, run.contractBinding.version)
    : null;
  const events = stateStore.getEventsForRun(runId);
  const actions = stateStore.getActionsForRun(runId);
  const attemptsByActionId = new Map<string, readonly AttemptSnapshot[]>();
  for (const action of actions) {
    attemptsByActionId.set(action.actionId, stateStore.getAttemptsForAction(action.actionId));
  }
  const approvals = stateStore.listApprovalRequests
    ? stateStore.listApprovalRequests({ runId })
    : [];
  const storeWithDeps = stateStore as StateStorePort & {
    getTaskDependencies?: (taskId: string) => readonly { readonly parentTaskId: string }[];
  };
  const parentTaskIds = storeWithDeps.getTaskDependencies
    ? storeWithDeps.getTaskDependencies(run.taskId).map((d) => d.parentTaskId)
    : undefined;

  const trace = buildTraceFromRunData(
    {
      run,
      contract,
      events,
      actions,
      attemptsByActionId,
      approvals,
      parentTaskIds,
    },
    options
  );

  return traceStore.writeTrace(trace, options.recordedAt);
}
