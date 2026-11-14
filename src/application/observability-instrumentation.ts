/**
 * Emerald Lifecycle Instrumentation Facade (Phase 3).
 *
 * Centralizes non-blocking, zero-authority instrumentation across:
 * - TaskRouterService (submission, dispatch, in-flight/capacity)
 * - GovernedToolConnectorService (execution, capability denials, timeouts, cancellations)
 * - ScopedContextMemoryService (write/read/compile/purge, Truth Firewall rejections)
 * - MultiAgentOrchestrator (decomposition, subtask dispatch, synthesis verdicts)
 * - GovernedModelRouterService & OllamaModelProvider (routing, fallback, inference, token counts, Langfuse correlation)
 * - ProductionVerifier (5-stage verification metrics + Langfuse verification score)
 * - ProductionRecoveryService & RecoverySupervisor (lease expiration observation, fencing, recovery outcomes)
 * - SQLite Store operations (latency, errors, SQLITE_BUSY contention)
 *
 * Invariants:
 * 1. Zero Authority: No observability method alters execution, policy, verification, or recovery truth.
 * 2. Failure Isolation: Every hook executes safely inside try/catch without throwing or delaying execution.
 * 3. Fixture/Live Separation: Every metric includes `execution_mode="fixture"|"live"`.
 * 4. Bounded Cardinality: IDs (tenant/task/run/attempt/agent/trace) belong ONLY on spans/logs, NEVER metric labels.
 */

import type {
  ExecutionModeTag,
  LangfuseTelemetryPort,
  ObservabilityCorrelation,
  ObservabilityPort,
  TelemetrySpanKind,
} from "../ports/observability.port.js";
import type { ToolConnectorAuditEvent } from "./governed-tool-connector.js";

export interface EmeraldLifecycleTelemetryOptions {
  readonly defaultExecutionMode?: ExecutionModeTag;
}

export class EmeraldLifecycleTelemetry {
  public readonly observability: ObservabilityPort;
  public readonly langfuse?: LangfuseTelemetryPort;
  private readonly defaultMode: ExecutionModeTag;

  constructor(
    observability: ObservabilityPort,
    langfuse?: LangfuseTelemetryPort,
    options: EmeraldLifecycleTelemetryOptions = {}
  ) {
    this.observability = observability;
    this.langfuse = langfuse;
    this.defaultMode = options.defaultExecutionMode ?? "live";
  }

  public getDefaultExecutionMode(): ExecutionModeTag {
    return this.defaultMode;
  }

  public withCorrelation<T>(
    correlation: Partial<ObservabilityCorrelation>,
    fn: () => T
  ): T {
    return this.observability.runWithCorrelation(
      {
        executionMode: this.defaultMode,
        ...correlation,
      },
      fn
    );
  }

  public recordRouterSubmission(input: {
    readonly taskId: string;
    readonly runId?: string;
    readonly parentTaskId?: string;
    readonly outcome: "admitted" | "duplicate" | "rejected";
    readonly durationMs: number;
    readonly executionMode?: ExecutionModeTag;
  }): void {
    const mode = input.executionMode ?? this.defaultMode;
    this.safe(() => {
      this.observability.incrementCounter(
        "emerald_router_submissions_total",
        "Total task router submissions by outcome",
        { outcome: input.outcome, execution_mode: mode }
      );
      this.observability.emitLog("INFO", "router.submission", `Task submission ${input.outcome}`, {
        taskId: input.taskId,
        runId: input.runId,
        parentTaskId: input.parentTaskId,
        durationMs: input.durationMs,
        outcome: input.outcome,
      });
    });
  }

  public recordDispatchTick(input: {
    readonly admittedCount: number;
    readonly cancelledCount: number;
    readonly inFlight: number;
    readonly capacity: number;
    readonly durationMs: number;
    readonly executionMode?: ExecutionModeTag;
  }): void {
    const mode = input.executionMode ?? this.defaultMode;
    this.safe(() => {
      if (input.admittedCount > 0) {
        this.observability.incrementCounter(
          "emerald_router_dispatches_total",
          "Total task router dispatch actions",
          { action: "admitted", execution_mode: mode },
          input.admittedCount
        );
      }
      if (input.cancelledCount > 0) {
        this.observability.incrementCounter(
          "emerald_router_dispatches_total",
          "Total task router dispatch actions",
          { action: "cancelled", execution_mode: mode },
          input.cancelledCount
        );
      }
      this.observability.setGauge(
        "emerald_router_in_flight_runs",
        "Current globally admitted in-flight runs",
        input.inFlight,
        { execution_mode: mode }
      );
      this.observability.setGauge(
        "emerald_router_capacity_remaining",
        "Remaining global task router admission slots",
        input.capacity,
        { execution_mode: mode }
      );
      this.observability.observeHistogram(
        "emerald_router_dispatch_duration_seconds",
        "Task router dispatch tick latency in seconds",
        input.durationMs / 1000,
        { execution_mode: mode }
      );
    });
  }

  public recordConnectorAuditEvent(
    event: ToolConnectorAuditEvent,
    executionMode?: ExecutionModeTag
  ): void {
    const mode = executionMode ?? this.defaultMode;
    this.safe(() => {
      let status: string = "requested";
      if (event.eventType === "connector.completed") {
        status = "completed";
      } else if (event.eventType === "connector.failed") {
        const err = (event.error ?? "").toLowerCase();
        if (err.includes("unauthorized") || err.includes("capability")) status = "denied";
        else if (err.includes("timed out") || err.includes("timeout")) status = "timeout";
        else if (err.includes("cancel")) status = "cancelled";
        else if (err.includes("schema") || err.includes("validation")) status = "validation_failed";
        else status = "failed";
      }

      this.observability.incrementCounter(
        "emerald_connector_executions_total",
        "Total governed tool connector lifecycle events",
        { connector_id: event.connectorId, status, execution_mode: mode }
      );

      if (event.durationMs !== undefined && event.eventType !== "connector.requested") {
        this.observability.observeHistogram(
          "emerald_connector_duration_seconds",
          "Governed tool connector execution duration in seconds",
          event.durationMs / 1000,
          { connector_id: event.connectorId, execution_mode: mode }
        );
      }
      if (event.bytesEmitted !== undefined && event.bytesEmitted > 0) {
        this.observability.incrementCounter(
          "emerald_connector_bytes_emitted_total",
          "Total bounded bytes emitted by governed tool connectors",
          { connector_id: event.connectorId, execution_mode: mode },
          event.bytesEmitted
        );
      }

      if (event.eventType !== "connector.requested") {
        this.recordChildSpan(
          `tool.connector.${event.connectorId}`,
          "CLIENT",
          event.durationMs ?? 0,
          event.eventType === "connector.failed" ? "ERROR" : "OK",
          {
            "emerald.connector_id": event.connectorId,
            "emerald.connector_status": status,
            "emerald.input_hash": event.inputHash,
            "emerald.execution_mode": mode,
          },
          event.error
        );

        const corr = this.observability.currentCorrelation();
        const traceId = corr.traceId ?? event.runId ?? event.taskId;
        if (this.langfuse && traceId) {
          const endMs = Date.now();
          const startMs = Math.max(0, endMs - Math.max(0, event.durationMs ?? 0));
          this.langfuse.enqueueSpan({
            id: `${event.connectorId}-${event.runId ?? event.taskId}-${endMs}`,
            traceId,
            parentObservationId: corr.spanId,
            name: `connector.${event.connectorId}`,
            startTime: new Date(startMs).toISOString(),
            endTime: new Date(endMs).toISOString(),
            level: event.eventType === "connector.failed" ? "ERROR" : "DEFAULT",
            statusMessage: event.error,
            input: { inputHash: event.inputHash },
            output: { status, bytesEmitted: event.bytesEmitted ?? 0 },
            metadata: {
              connectorId: event.connectorId,
              tenantId: event.tenantId,
              taskId: event.taskId,
              runId: event.runId,
              executionMode: mode,
            },
          });
        }
      }

      this.observability.emitLog(
        event.eventType === "connector.failed" ? "WARN" : "INFO",
        event.eventType,
        `Connector ${event.connectorId} ${status}`,
        {
          connectorId: event.connectorId,
          tenantId: event.tenantId,
          taskId: event.taskId,
          runId: event.runId,
          status,
          durationMs: event.durationMs,
          inputHash: event.inputHash,
          error: event.error,
        }
      );
    });
  }

  public recordMemoryOperation(input: {
    readonly operation: "write" | "read" | "update" | "delete" | "compile" | "purge";
    readonly scope: string;
    readonly outcome: "ok" | "truth_firewall_rejected" | "expired" | "error";
    readonly durationMs: number;
    readonly purgedCount?: number;
    readonly executionMode?: ExecutionModeTag;
  }): void {
    const mode = input.executionMode ?? this.defaultMode;
    this.safe(() => {
      this.observability.incrementCounter(
        "emerald_memory_operations_total",
        "Scoped durable memory operations by type and outcome",
        {
          operation: input.operation,
          scope: input.scope,
          outcome: input.outcome,
          execution_mode: mode,
        }
      );
      this.observability.observeHistogram(
        "emerald_memory_operation_duration_seconds",
        "Scoped durable memory operation latency in seconds",
        input.durationMs / 1000,
        { operation: input.operation, execution_mode: mode }
      );
      if (input.outcome === "truth_firewall_rejected") {
        this.observability.incrementCounter(
          "emerald_memory_truth_firewall_rejections_total",
          "Truth Firewall blocked unauthorized VERIFIED_EVIDENCE promotions",
          { scope: input.scope, execution_mode: mode }
        );
      }
      if (input.purgedCount && input.purgedCount > 0) {
        this.observability.incrementCounter(
          "emerald_memory_expired_purged_total",
          "Total expired scoped memory entries purged",
          { execution_mode: mode },
          input.purgedCount
        );
      }
    });
  }

  public recordModelRoutingDecision(input: {
    readonly role: string;
    readonly outcome: "assigned" | "rejected" | "blocked" | "fallback";
    readonly modelId?: string;
    readonly fallbackChainLength?: number;
    readonly failureReason?: string;
    readonly executionMode?: ExecutionModeTag;
  }): void {
    const mode = input.executionMode ?? this.defaultMode;
    this.safe(() => {
      this.observability.incrementCounter(
        "emerald_model_routing_decisions_total",
        "Governed model routing decisions by role and outcome",
        { role: input.role, outcome: input.outcome, execution_mode: mode }
      );
      this.observability.emitLog(
        input.outcome === "assigned" ? "INFO" : "WARN",
        "model.routing",
        `Model routing ${input.outcome} for role ${input.role}`,
        {
          role: input.role,
          outcome: input.outcome,
          modelId: input.modelId,
          fallbackChainLength: input.fallbackChainLength,
          failureReason: input.failureReason,
        }
      );
    });
  }

  public recordModelInvocation(input: {
    readonly provider: string;
    readonly model: string;
    readonly status: "ok" | "timeout" | "cancelled" | "unavailable" | "error";
    readonly durationMs: number;
    readonly startTimeIso: string;
    readonly endTimeIso: string;
    readonly requestId: string;
    readonly promptName?: string;
    readonly promptVersion?: number;
    readonly harnessVersion?: string;
    readonly promptTokens?: number;
    readonly completionTokens?: number;
    readonly promptPreview?: unknown;
    readonly outputPreview?: unknown;
    readonly errorMessage?: string;
    readonly executionMode?: ExecutionModeTag;
  }): void {
    const mode = input.executionMode ?? this.defaultMode;
    this.safe(() => {
      this.observability.incrementCounter(
        "emerald_model_requests_total",
        "Total model inference requests by provider, model, and status",
        {
          provider: input.provider,
          model: input.model,
          status: input.status,
          execution_mode: mode,
        }
      );
      this.observability.observeHistogram(
        "emerald_model_request_duration_seconds",
        "Model inference duration in seconds",
        input.durationMs / 1000,
        { provider: input.provider, model: input.model, execution_mode: mode }
      );
      if (input.promptTokens && input.promptTokens > 0) {
        this.observability.incrementCounter(
          "emerald_model_tokens_total",
          "Model tokens observed from runtime usage metadata",
          {
            provider: input.provider,
            model: input.model,
            token_type: "prompt",
            execution_mode: mode,
          },
          input.promptTokens
        );
      }
      if (input.completionTokens && input.completionTokens > 0) {
        this.observability.incrementCounter(
          "emerald_model_tokens_total",
          "Model tokens observed from runtime usage metadata",
          {
            provider: input.provider,
            model: input.model,
            token_type: "completion",
            execution_mode: mode,
          },
          input.completionTokens
        );
      }

      this.recordChildSpan(
        `model.${input.provider}.generate`,
        "CLIENT",
        input.durationMs,
        input.status === "ok" ? "OK" : "ERROR",
        {
          "gen_ai.system": input.provider,
          "gen_ai.request.model": input.model,
          "gen_ai.usage.input_tokens": input.promptTokens ?? 0,
          "gen_ai.usage.output_tokens": input.completionTokens ?? 0,
          "emerald.execution_mode": mode,
        },
        input.errorMessage
      );

      if (this.langfuse) {
        const corr = this.observability.currentCorrelation();
        const traceId = corr.traceId ?? input.requestId;
        this.langfuse.enqueueGeneration({
          id: input.requestId,
          traceId,
          parentObservationId: corr.spanId,
          name: `model.${input.provider}.generate`,
          model: input.model,
          promptName: input.promptName,
          promptVersion: input.promptVersion,
          input: input.promptPreview ?? "[REDACTED_OMITTED]",
          output: input.outputPreview ?? (input.errorMessage ?? "[NO_OUTPUT]"),
          usage: {
            promptTokens: input.promptTokens,
            completionTokens: input.completionTokens,
            totalTokens:
              (input.promptTokens ?? 0) + (input.completionTokens ?? 0) || undefined,
          },
          startTime: input.startTimeIso,
          endTime: input.endTimeIso,
          level: input.status === "ok" ? "DEFAULT" : "ERROR",
          statusMessage: input.errorMessage,
          metadata: {
            executionMode: mode,
            harnessVersion: input.harnessVersion,
            tenantId: corr.tenantId,
            taskId: corr.taskId,
            runId: corr.runId,
            attemptId: corr.attemptId,
          },
        });
      }
    });
  }

  public recordVerificationResult(input: {
    readonly verified: boolean;
    readonly durationMs: number;
    readonly proofHash: string;
    readonly stages: ReadonlyArray<{
      readonly stage: string;
      readonly passed: boolean;
      readonly durationMs: number;
    }>;
    readonly failureReason?: string;
    readonly executionMode?: ExecutionModeTag;
  }): void {
    const mode = input.executionMode ?? this.defaultMode;
    this.safe(() => {
      this.observability.incrementCounter(
        "emerald_verifications_total",
        "Total sovereign verification outcomes",
        { verified: input.verified ? "true" : "false", execution_mode: mode }
      );
      for (const stage of input.stages) {
        this.observability.observeHistogram(
          "emerald_verification_stage_duration_seconds",
          "Sovereign verification stage duration in seconds",
          stage.durationMs / 1000,
          {
            stage: stage.stage,
            passed: stage.passed ? "true" : "false",
            execution_mode: mode,
          }
        );
      }

      this.recordChildSpan(
        "verification.sovereign",
        "INTERNAL",
        input.durationMs,
        input.verified ? "OK" : "ERROR",
        {
          "emerald.verified": input.verified,
          "emerald.proof_hash_prefix": input.proofHash.slice(0, 12),
          "emerald.stage_count": input.stages.length,
          "emerald.execution_mode": mode,
        },
        input.verified ? undefined : (input.failureReason ?? "Verification rejected")
      );

      const corr = this.observability.currentCorrelation();
      if (this.langfuse && corr.traceId) {
        this.langfuse.enqueueScore({
          traceId: corr.traceId,
          observationId: corr.spanId,
          name: "sovereign_verification_passed",
          value: input.verified ? 1 : 0,
          comment: input.verified
            ? `Verified proofHash=${input.proofHash.slice(0, 12)}`
            : input.failureReason ?? "Verification rejected",
        });
      }
    });
  }

  public recordRecoveryOutcome(input: {
    readonly runId: string;
    readonly outcome: string;
    readonly leasesFenced: number;
    readonly workerLeaseExpiredObserved?: boolean;
    readonly durationMs: number;
    readonly executionMode?: ExecutionModeTag;
  }): void {
    const mode = input.executionMode ?? this.defaultMode;
    this.safe(() => {
      this.observability.incrementCounter(
        "emerald_recovery_runs_total",
        "Total crash/lease recovery evaluations by outcome",
        { outcome: input.outcome, execution_mode: mode }
      );
      if (input.leasesFenced > 0) {
        this.observability.incrementCounter(
          "emerald_recovery_leases_fenced_total",
          "Total stale worker capability/execution leases fenced during recovery",
          { execution_mode: mode },
          input.leasesFenced
        );
      }
      if (input.workerLeaseExpiredObserved) {
        this.observability.incrementCounter(
          "emerald_recovery_worker_leases_expired_observed_total",
          "Expired worker leases observed by recovery supervisor (does not alone assert process death)",
          { execution_mode: mode }
        );
      }
      this.observability.observeHistogram(
        "emerald_recovery_duration_seconds",
        "Recovery evaluation duration in seconds",
        input.durationMs / 1000,
        { outcome: input.outcome, execution_mode: mode }
      );
      this.recordChildSpan(
        "recovery.run",
        "INTERNAL",
        input.durationMs,
        "OK",
        {
          "emerald.run_id": input.runId,
          "emerald.recovery_outcome": input.outcome,
          "emerald.leases_fenced": input.leasesFenced,
          "emerald.worker_lease_expired_observed": Boolean(input.workerLeaseExpiredObserved),
          "emerald.execution_mode": mode,
        }
      );
      this.observability.emitLog("INFO", "recovery.outcome", `Run recovery finished: ${input.outcome}`, {
        runId: input.runId,
        outcome: input.outcome,
        leasesFenced: input.leasesFenced,
        workerLeaseExpiredObserved: Boolean(input.workerLeaseExpiredObserved),
        durationMs: input.durationMs,
      });
    });
  }

  public recordMultiAgentDecomposition(input: {
    readonly missionTaskId: string;
    readonly outcome: "decomposed" | "duplicate" | "rejected";
    readonly subtaskCount?: number;
    readonly executionMode?: ExecutionModeTag;
  }): void {
    const mode = input.executionMode ?? this.defaultMode;
    this.safe(() => {
      this.observability.incrementCounter(
        "emerald_multi_agent_decompositions_total",
        "Multi-agent mission decompositions by outcome",
        { outcome: input.outcome, execution_mode: mode }
      );
      if (input.subtaskCount !== undefined) {
        this.observability.observeHistogram(
          "emerald_multi_agent_subtasks_count",
          "Subtasks per multi-agent mission decomposition",
          input.subtaskCount,
          { execution_mode: mode },
          [1, 2, 4, 8, 16, 32]
        );
      }
    });
  }

  public recordMultiAgentSynthesis(input: {
    readonly missionTaskId: string;
    readonly verdict: string;
    readonly executionMode?: ExecutionModeTag;
  }): void {
    const mode = input.executionMode ?? this.defaultMode;
    this.safe(() => {
      this.observability.incrementCounter(
        "emerald_multi_agent_synthesis_total",
        "Multi-agent fail-closed mission synthesis verdicts",
        { verdict: input.verdict, execution_mode: mode }
      );
    });
  }

  public recordSqliteOperation(input: {
    readonly operation: string;
    readonly status: "ok" | "busy" | "error";
    readonly durationMs: number;
  }): void {
    this.safe(() => {
      this.observability.incrementCounter(
        "emerald_sqlite_operations_total",
        "SQLite store operations by operation type and status",
        { operation: input.operation, status: input.status }
      );
      this.observability.observeHistogram(
        "emerald_sqlite_operation_duration_seconds",
        "SQLite operation latency in seconds",
        input.durationMs / 1000,
        { operation: input.operation }
      );
      if (input.status === "busy") {
        this.observability.incrementCounter(
          "emerald_sqlite_busy_errors_total",
          "SQLite BUSY lock contention errors observed",
          { operation: input.operation }
        );
      }
    });
  }

  public recordApprovalDecision(input: {
    readonly action: string;
    readonly riskLevel?: string;
    readonly executionMode?: ExecutionModeTag;
  }): void {
    const mode = input.executionMode ?? this.defaultMode;
    const riskLevel = input.riskLevel ?? "HIGH";
    this.safe(() => {
      this.observability.incrementCounter(
        "emerald_approvals_total",
        "Total approval lifecycle transitions and gate decisions",
        { action: input.action, risk_level: riskLevel, execution_mode: mode }
      );
      this.observability.emitLog("INFO", "approval.decision", `Approval decision: ${input.action}`, {
        action: input.action,
        riskLevel,
        executionMode: mode,
      });
    });
  }

  public recordRepairLifecycle(input: {
    readonly outcome: "started" | "diagnosed" | "patch_proposed" | "stagnation_halted" | "budget_exhausted" | "verified" | "failed";
    readonly category?: string;
    readonly durationMs?: number;
    readonly executionMode?: ExecutionModeTag;
  }): void {
    const mode = input.executionMode ?? this.defaultMode;
    const category = input.category ?? "UNKNOWN";
    this.safe(() => {
      this.observability.incrementCounter(
        "emerald_repair_cycles_total",
        "Bounded repair loop outcomes and failure diagnoses",
        { outcome: input.outcome, category, execution_mode: mode }
      );
      if (input.durationMs !== undefined) {
        this.observability.observeHistogram(
          "emerald_repair_duration_seconds",
          "Bounded repair cycle stage duration in seconds",
          input.durationMs / 1000,
          { outcome: input.outcome, execution_mode: mode }
        );
      }
      this.recordChildSpan(
        `repair.${input.outcome}`,
        "INTERNAL",
        input.durationMs ?? 0,
        input.outcome === "failed" || input.outcome === "budget_exhausted" || input.outcome === "stagnation_halted"
          ? "ERROR"
          : "OK",
        {
          "emerald.repair_outcome": input.outcome,
          "emerald.repair_category": category,
          "emerald.execution_mode": mode,
        }
      );
    });
  }

  public syncLangfuseMetrics(): void {
    if (!this.langfuse) return;
    this.safe(() => {
      const h = this.langfuse!.getHealth();
      this.observability.setGauge(
        "emerald_langfuse_exported_events_total",
        "Total telemetry events exported to self-hosted Langfuse",
        h.exportedEvents
      );
      this.observability.setGauge(
        "emerald_langfuse_dropped_events_total",
        "Total Langfuse telemetry events dropped due to bounds or failure",
        h.droppedEvents
      );
      this.observability.setGauge(
        "emerald_langfuse_export_failures_total",
        "Total self-hosted Langfuse export failures",
        h.exportFailures
      );
    });
  }

  private recordChildSpan(
    name: string,
    kind: TelemetrySpanKind,
    durationMs: number,
    status: "OK" | "ERROR",
    attributes: Record<string, unknown>,
    errorMessage?: string
  ): void {
    const span = this.observability.startSpan(
      name,
      {
        ...attributes,
        "emerald.duration_ms": Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0,
      },
      { kind }
    );
    if (status === "ERROR" && errorMessage) {
      this.observability.recordSpanException?.(span, new Error(errorMessage));
    }
    this.observability.endSpan(span.spanId, status, errorMessage);
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch {
      // Strictly non-disruptive and zero-authority
    }
  }
}
