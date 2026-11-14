/**
 * Grafana Dashboard Schema & PromQL Integrity Validator (Phase 3).
 *
 * Ensures every provisioned dashboard JSON:
 * - conforms to Grafana provisioning structure (uid, title, schemaVersion, panels >= 1)
 * - declares execution_mode separation ("fixture" vs "live") on execution panels
 * - references valid Emerald / Prometheus metric names without high-cardinality labels
 */

export interface GrafanaTargetSpec {
  readonly refId: string;
  readonly expr: string;
  readonly legendFormat?: string;
}

export interface GrafanaPanelSpec {
  readonly id: number;
  readonly title: string;
  readonly type: string;
  readonly gridPos: { readonly h: number; readonly w: number; readonly x: number; readonly y: number };
  readonly targets?: readonly GrafanaTargetSpec[];
}

export interface GrafanaDashboardSpec {
  readonly uid: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly timezone: string;
  readonly schemaVersion: number;
  readonly refresh?: string;
  readonly templating?: {
    readonly list: ReadonlyArray<{
      readonly name: string;
      readonly type: string;
      readonly query?: string;
      readonly current?: { readonly text: string; readonly value: string };
    }>;
  };
  readonly panels: readonly GrafanaPanelSpec[];
}

export interface DashboardValidationResult {
  readonly valid: boolean;
  readonly uid?: string;
  readonly panelCount: number;
  readonly referencedMetrics: readonly string[];
  readonly errors: readonly string[];
}

export const EMERALD_KNOWN_METRICS: ReadonlySet<string> = new Set([
  "emerald_tasks_total",
  "emerald_runs_total",
  "emerald_router_submissions_total",
  "emerald_router_dispatches_total",
  "emerald_router_in_flight_runs",
  "emerald_router_capacity_remaining",
  "emerald_router_dispatch_duration_seconds",
  "emerald_router_dispatch_duration_seconds_bucket",
  "emerald_router_dispatch_duration_seconds_sum",
  "emerald_router_dispatch_duration_seconds_count",
  "emerald_http_requests_total",
  "emerald_http_request_duration_seconds",
  "emerald_http_request_duration_seconds_bucket",
  "emerald_http_request_duration_seconds_sum",
  "emerald_http_request_duration_seconds_count",
  "emerald_http_errors_total",
  "emerald_connector_executions_total",
  "emerald_connector_duration_seconds",
  "emerald_connector_duration_seconds_bucket",
  "emerald_connector_duration_seconds_sum",
  "emerald_connector_duration_seconds_count",
  "emerald_connector_bytes_emitted_total",
  "emerald_model_requests_total",
  "emerald_model_request_duration_seconds",
  "emerald_model_request_duration_seconds_bucket",
  "emerald_model_request_duration_seconds_sum",
  "emerald_model_request_duration_seconds_count",
  "emerald_model_tokens_total",
  "emerald_model_routing_decisions_total",
  "emerald_memory_operations_total",
  "emerald_memory_operation_duration_seconds",
  "emerald_memory_operation_duration_seconds_bucket",
  "emerald_memory_operation_duration_seconds_sum",
  "emerald_memory_operation_duration_seconds_count",
  "emerald_memory_truth_firewall_rejections_total",
  "emerald_memory_expired_purged_total",
  "emerald_sqlite_operations_total",
  "emerald_sqlite_operation_duration_seconds",
  "emerald_sqlite_operation_duration_seconds_bucket",
  "emerald_sqlite_operation_duration_seconds_sum",
  "emerald_sqlite_operation_duration_seconds_count",
  "emerald_sqlite_busy_errors_total",
  "emerald_multi_agent_decompositions_total",
  "emerald_multi_agent_synthesis_total",
  "emerald_multi_agent_subtasks_count",
  "emerald_multi_agent_subtasks_count_bucket",
  "emerald_multi_agent_subtasks_count_sum",
  "emerald_multi_agent_subtasks_count_count",
  "emerald_verifications_total",
  "emerald_verification_stage_duration_seconds",
  "emerald_verification_stage_duration_seconds_bucket",
  "emerald_verification_stage_duration_seconds_sum",
  "emerald_verification_stage_duration_seconds_count",
  "emerald_recovery_runs_total",
  "emerald_recovery_leases_fenced_total",
  "emerald_recovery_worker_leases_expired_observed_total",
  "emerald_recovery_duration_seconds",
  "emerald_recovery_duration_seconds_bucket",
  "emerald_recovery_duration_seconds_sum",
  "emerald_recovery_duration_seconds_count",
  "emerald_process_uptime_seconds",
  "emerald_process_resident_memory_bytes",
  "emerald_process_heap_used_bytes",
  "emerald_process_heap_total_bytes",
  "emerald_process_cpu_seconds_total",
  "emerald_nodejs_eventloop_delay_p95_seconds",
  "emerald_nodejs_eventloop_delay_max_seconds",
  "emerald_disk_total_bytes",
  "emerald_disk_free_bytes",
  "emerald_telemetry_spans_dropped_total",
  "emerald_telemetry_logs_dropped_total",
  "emerald_telemetry_export_failures_total",
  "emerald_telemetry_queue_depth",
  "emerald_telemetry_metric_overflow_total",
  "emerald_telemetry_cardinality_rejections_total",
  "emerald_langfuse_exported_events_total",
  "emerald_langfuse_dropped_events_total",
  "emerald_langfuse_export_failures_total",
]);

const FORBIDDEN_PROMQL_LABELS =
  /\b(taskId|task_id|runId|run_id|userId|user_id|tenantId|tenant_id|principalId|principal_id|agentId|agent_id|parentTaskId|parent_task_id|attemptId|attempt_id|traceId|trace_id|spanId|span_id|errorMessage|error_message|prompt|secret|password)\s*[=!~]/;

export const EXECUTION_SCOPED_METRICS: ReadonlySet<string> = new Set([
  "emerald_tasks_total",
  "emerald_runs_total",
  "emerald_router_submissions_total",
  "emerald_router_dispatches_total",
  "emerald_router_in_flight_runs",
  "emerald_router_capacity_remaining",
  "emerald_router_dispatch_duration_seconds",
  "emerald_router_dispatch_duration_seconds_bucket",
  "emerald_router_dispatch_duration_seconds_sum",
  "emerald_router_dispatch_duration_seconds_count",
  "emerald_connector_executions_total",
  "emerald_connector_duration_seconds",
  "emerald_connector_duration_seconds_bucket",
  "emerald_connector_duration_seconds_sum",
  "emerald_connector_duration_seconds_count",
  "emerald_connector_bytes_emitted_total",
  "emerald_model_requests_total",
  "emerald_model_request_duration_seconds",
  "emerald_model_request_duration_seconds_bucket",
  "emerald_model_request_duration_seconds_sum",
  "emerald_model_request_duration_seconds_count",
  "emerald_model_tokens_total",
  "emerald_model_routing_decisions_total",
  "emerald_memory_operations_total",
  "emerald_memory_operation_duration_seconds",
  "emerald_memory_operation_duration_seconds_bucket",
  "emerald_memory_operation_duration_seconds_sum",
  "emerald_memory_operation_duration_seconds_count",
  "emerald_memory_truth_firewall_rejections_total",
  "emerald_memory_expired_purged_total",
  "emerald_multi_agent_decompositions_total",
  "emerald_multi_agent_synthesis_total",
  "emerald_multi_agent_subtasks_count",
  "emerald_multi_agent_subtasks_count_bucket",
  "emerald_multi_agent_subtasks_count_sum",
  "emerald_multi_agent_subtasks_count_count",
  "emerald_verifications_total",
  "emerald_verification_stage_duration_seconds",
  "emerald_verification_stage_duration_seconds_bucket",
  "emerald_verification_stage_duration_seconds_sum",
  "emerald_verification_stage_duration_seconds_count",
  "emerald_recovery_runs_total",
  "emerald_recovery_leases_fenced_total",
  "emerald_recovery_worker_leases_expired_observed_total",
  "emerald_recovery_duration_seconds",
  "emerald_recovery_duration_seconds_bucket",
  "emerald_recovery_duration_seconds_sum",
  "emerald_recovery_duration_seconds_count",
]);

export function hasBalancedPromqlDelimiters(expr: string): boolean {
  const stack: string[] = [];
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]!;
    if (quote) {
      if (ch === "\\" && i + 1 < expr.length) {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      stack.push(ch);
    } else if (ch === ")" || ch === "]" || ch === "}") {
      const open = stack.pop();
      if (
        (ch === ")" && open !== "(") ||
        (ch === "]" && open !== "[") ||
        (ch === "}" && open !== "{")
      ) {
        return false;
      }
    }
  }
  return quote === null && stack.length === 0;
}

export function extractEmeraldMetricsFromPromql(expr: string): string[] {
  const matches = expr.match(/\bemerald_[a-zA-Z0-9_]+/g) ?? [];
  return [...new Set(matches)];
}

export function validateGrafanaDashboard(raw: unknown): DashboardValidationResult {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") {
    return {
      valid: false,
      panelCount: 0,
      referencedMetrics: [],
      errors: ["Dashboard JSON root must be an object"],
    };
  }

  const dash = raw as Partial<GrafanaDashboardSpec>;
  if (typeof dash.uid !== "string" || !/^[a-z0-9-]{4,40}$/.test(dash.uid)) {
    errors.push("Dashboard uid must match /^[a-z0-9-]{4,40}$/");
  }
  if (typeof dash.title !== "string" || dash.title.trim().length < 4) {
    errors.push("Dashboard title is required");
  }
  if (typeof dash.schemaVersion !== "number" || dash.schemaVersion < 36) {
    errors.push("Dashboard schemaVersion must be >= 36");
  }
  if (!Array.isArray(dash.panels) || dash.panels.length === 0) {
    errors.push("Dashboard must define at least 1 panel");
  }

  const hasExecutionModeVar = Boolean(
    dash.templating?.list?.some((v) => v.name === "execution_mode")
  );
  if (!hasExecutionModeVar) {
    errors.push("Dashboard must define execution_mode template variable for fixture/live separation");
  }

  const referenced = new Set<string>();
  const seenPanelIds = new Set<number>();
  const panels = Array.isArray(dash.panels) ? dash.panels : [];

  for (const panel of panels) {
    if (!panel || typeof panel.title !== "string" || !panel.gridPos) {
      errors.push("Panel missing title or gridPos");
      continue;
    }
    if (!Number.isInteger(panel.id) || panel.id <= 0) {
      errors.push(`Panel '${panel.title}' must have a positive integer id`);
    } else if (seenPanelIds.has(panel.id)) {
      errors.push(`Duplicate panel id '${panel.id}' on '${panel.title}'`);
    } else {
      seenPanelIds.add(panel.id);
    }

    const gp = panel.gridPos;
    if (
      !Number.isFinite(gp.h) || gp.h <= 0 ||
      !Number.isFinite(gp.w) || gp.w <= 0 || gp.w > 24 ||
      !Number.isFinite(gp.x) || gp.x < 0 || gp.x + gp.w > 24 ||
      !Number.isFinite(gp.y) || gp.y < 0
    ) {
      errors.push(`Panel '${panel.title}' has invalid gridPos bounds`);
    }

    const targets = Array.isArray(panel.targets) ? panel.targets : [];
    if (targets.length === 0) {
      errors.push(`Panel '${panel.title}' must declare at least 1 PromQL target`);
      continue;
    }
    for (const target of targets) {
      if (typeof target.expr !== "string" || target.expr.trim().length === 0) {
        errors.push(`Panel '${panel.title}' target missing expr`);
        continue;
      }
      if (!hasBalancedPromqlDelimiters(target.expr)) {
        errors.push(`Panel '${panel.title}' expr has unbalanced delimiters or quotes`);
      }
      if (FORBIDDEN_PROMQL_LABELS.test(target.expr)) {
        errors.push(`Panel '${panel.title}' expr references high-cardinality/sensitive label`);
      }
      const metrics = extractEmeraldMetricsFromPromql(target.expr);
      if (metrics.length === 0) {
        errors.push(`Panel '${panel.title}' expr does not reference any emerald_* metric`);
      }
      let usesExecutionScopedMetric = false;
      for (const metric of metrics) {
        referenced.add(metric);
        if (!EMERALD_KNOWN_METRICS.has(metric)) {
          errors.push(`Panel '${panel.title}' references unknown metric '${metric}'`);
        }
        if (EXECUTION_SCOPED_METRICS.has(metric)) {
          usesExecutionScopedMetric = true;
        }
      }
      if (usesExecutionScopedMetric && !/\bexecution_mode\s*=~?\s*["']/.test(target.expr)) {
        errors.push(`Panel '${panel.title}' queries execution-scoped metric without execution_mode filter`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    uid: typeof dash.uid === "string" ? dash.uid : undefined,
    panelCount: panels.length,
    referencedMetrics: [...referenced].sort(),
    errors,
  };
}

export function validateAllGrafanaDashboards(
  dashboards: ReadonlyArray<{ readonly file: string; readonly spec: unknown }>
): {
  readonly valid: boolean;
  readonly results: ReadonlyArray<DashboardValidationResult & { readonly file: string }>;
  readonly errors: readonly string[];
} {
  const seenUids = new Set<string>();
  const errors: string[] = [];
  const results: Array<DashboardValidationResult & { readonly file: string }> = [];

  for (const item of dashboards) {
    const res = validateGrafanaDashboard(item.spec);
    if (res.uid) {
      if (seenUids.has(res.uid)) {
        errors.push(`Duplicate dashboard uid '${res.uid}' in '${item.file}'`);
      } else {
        seenUids.add(res.uid);
      }
    }
    for (const err of res.errors) {
      errors.push(`${item.file}: ${err}`);
    }
    results.push({ ...res, file: item.file });
  }

  return {
    valid: errors.length === 0,
    results,
    errors,
  };
}
