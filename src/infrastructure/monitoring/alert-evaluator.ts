/**
 * Prometheus Alert Rule Validator & Deterministic Evaluator (Phase 3).
 *
 * Validates alert rules in `infra/monitoring/prometheus-alerts.yml` against known Emerald
 * metric names and evaluates threshold triggers deterministically on live Prometheus text scrapes.
 */

import {
  EMERALD_KNOWN_METRICS,
  EXECUTION_SCOPED_METRICS,
  extractEmeraldMetricsFromPromql,
  hasBalancedPromqlDelimiters,
} from "./dashboard-validator.js";

const PROMETHEUS_DURATION_PATTERN = /^\d+(?:ms|s|m|h|d|w|y)$/;
const ALLOWED_ALERT_SEVERITIES = new Set(["info", "warning", "critical"]);

export interface ParsedPrometheusAlertRule {
  readonly group: string;
  readonly alert: string;
  readonly expr: string;
  readonly forDuration: string;
  readonly severity: string;
  readonly summary: string;
  readonly description: string;
}

export interface AlertValidationReport {
  readonly valid: boolean;
  readonly rules: readonly ParsedPrometheusAlertRule[];
  readonly errors: readonly string[];
}

export interface EvaluatedAlertResult {
  readonly alert: string;
  readonly firing: boolean;
  readonly severity: string;
  readonly value?: number;
  readonly reason: string;
}

/**
 * Lightweight deterministic parser for Prometheus YAML alert rule files without external YAML dependencies.
 */
export function parseAndValidatePrometheusAlertsYaml(yamlText: string): AlertValidationReport {
  const lines = yamlText.split(/\r?\n/);
  const rules: ParsedPrometheusAlertRule[] = [];
  const errors: string[] = [];
  const seenAlerts = new Set<string>();

  let currentGroup = "default";
  let current: {
    alert?: string;
    exprLines: string[];
    forDuration?: string;
    severity?: string;
    summary?: string;
    description?: string;
  } | null = null;
  let inExprBlock = false;
  let exprIndent = 0;

  const flushRule = () => {
    if (!current || !current.alert) return;
    const expr = current.exprLines.join(" ").trim();
    const rule: ParsedPrometheusAlertRule = {
      group: currentGroup,
      alert: current.alert,
      expr,
      forDuration: current.forDuration ?? "",
      severity: current.severity ?? "",
      summary: current.summary ?? "",
      description: current.description ?? "",
    };
    if (seenAlerts.has(rule.alert)) {
      errors.push(`Duplicate alert rule name '${rule.alert}'`);
    } else {
      seenAlerts.add(rule.alert);
    }
    if (!expr) {
      errors.push(`Alert '${rule.alert}' missing expr`);
    } else if (!hasBalancedPromqlDelimiters(expr)) {
      errors.push(`Alert '${rule.alert}' expr has unbalanced delimiters or quotes`);
    }
    if (!rule.forDuration) {
      errors.push(`Alert '${rule.alert}' missing 'for' duration`);
    } else if (!PROMETHEUS_DURATION_PATTERN.test(rule.forDuration)) {
      errors.push(`Alert '${rule.alert}' has invalid Prometheus 'for' duration '${rule.forDuration}'`);
    }
    if (!rule.severity) {
      errors.push(`Alert '${rule.alert}' missing severity label`);
    } else if (!ALLOWED_ALERT_SEVERITIES.has(rule.severity)) {
      errors.push(`Alert '${rule.alert}' has unsupported severity '${rule.severity}'`);
    }
    if (!rule.summary) errors.push(`Alert '${rule.alert}' missing summary annotation`);
    if (!rule.description) errors.push(`Alert '${rule.alert}' missing description annotation`);

    const metrics = extractEmeraldMetricsFromPromql(expr);
    if (metrics.length === 0) {
      errors.push(`Alert '${rule.alert}' expr does not reference any emerald_* metric`);
    }
    let usesExecutionScopedMetric = false;
    for (const m of metrics) {
      if (!EMERALD_KNOWN_METRICS.has(m)) {
        errors.push(`Alert '${rule.alert}' references unknown metric '${m}'`);
      }
      if (EXECUTION_SCOPED_METRICS.has(m)) {
        usesExecutionScopedMetric = true;
      }
    }
    if (usesExecutionScopedMetric && !/\bexecution_mode\s*=/.test(expr)) {
      errors.push(`Alert '${rule.alert}' queries execution-scoped metric without execution_mode="live" isolation`);
    }
    rules.push(rule);
    current = null;
    inExprBlock = false;
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (inExprBlock && current) {
      const indent = rawLine.length - rawLine.trimStart().length;
      if (indent >= exprIndent) {
        current.exprLines.push(trimmed);
        continue;
      } else {
        inExprBlock = false;
      }
    }

    const groupMatch = /^-\s+name:\s*(.+)$/.exec(trimmed);
    if (groupMatch?.[1]) {
      flushRule();
      currentGroup = groupMatch[1].trim().replace(/^["']|["']$/g, "");
      continue;
    }

    const alertMatch = /^-\s+alert:\s*(.+)$/.exec(trimmed);
    if (alertMatch?.[1]) {
      flushRule();
      current = {
        alert: alertMatch[1].trim().replace(/^["']|["']$/g, ""),
        exprLines: [],
      };
      continue;
    }

    if (!current) continue;

    if (trimmed === "expr: |") {
      inExprBlock = true;
      exprIndent = rawLine.length - rawLine.trimStart().length + 2;
    } else if (trimmed.startsWith("expr:")) {
      current.exprLines.push(trimmed.slice(5).trim());
    } else if (trimmed.startsWith("for:")) {
      current.forDuration = trimmed.slice(4).trim();
    } else if (trimmed.startsWith("severity:")) {
      current.severity = trimmed.slice(9).trim();
    } else if (trimmed.startsWith("summary:")) {
      current.summary = trimmed.slice(8).trim().replace(/^["']|["']$/g, "");
    } else if (trimmed.startsWith("description:")) {
      current.description = trimmed.slice(12).trim().replace(/^["']|["']$/g, "");
    }
  }
  flushRule();

  if (rules.length === 0) {
    errors.push("No Prometheus alert rules parsed");
  }

  return {
    valid: errors.length === 0,
    rules,
    errors,
  };
}

/**
 * Validates Prometheus configuration YAML (`prometheus.yml`) rule_files and scrape_configs consistency.
 */
export function validatePrometheusConfigYaml(
  yamlText: string,
  expectedRuleFiles: readonly string[] = ["prometheus-alerts.yml"]
): { readonly valid: boolean; readonly errors: readonly string[] } {
  const errors: string[] = [];
  if (!/^scrape_configs:\s*$/m.test(yamlText)) {
    errors.push("prometheus.yml missing scrape_configs section");
  }
  if (!/metrics_path:\s*["']?\/metrics["']?/.test(yamlText)) {
    errors.push("prometheus.yml missing metrics_path: /metrics");
  }
  if (!/^rule_files:\s*$/m.test(yamlText)) {
    errors.push("prometheus.yml missing rule_files section");
  }
  for (const ruleFile of expectedRuleFiles) {
    const escaped = ruleFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`-\\s*["']?${escaped}["']?`).test(yamlText)) {
      errors.push(`prometheus.yml rule_files does not reference '${ruleFile}'`);
    }
  }
  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Parses Prometheus text exposition v0.0.4 lines into flat metric lookup values.
 */
export function parsePrometheusTextSampleSums(metricsText: string): ReadonlyMap<string, number> {
  const sums = new Map<string, number>();
  for (const line of metricsText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const lastSpace = trimmed.lastIndexOf(" ");
    if (lastSpace <= 0) continue;
    const rawKey = trimmed.slice(0, lastSpace);
    const num = Number(trimmed.slice(lastSpace + 1));
    if (!Number.isFinite(num)) continue;

    const braceIdx = rawKey.indexOf("{");
    const metricName = braceIdx >= 0 ? rawKey.slice(0, braceIdx) : rawKey;
    sums.set(metricName, (sums.get(metricName) ?? 0) + num);
    sums.set(rawKey, num);
  }
  return sums;
}

/**
 * Evaluates core threshold alerts against live parsed metric samples for local verification.
 */
export function evaluateCoreHealthAlerts(metricsText: string): readonly EvaluatedAlertResult[] {
  const samples = parsePrometheusTextSampleSums(metricsText);
  const results: EvaluatedAlertResult[] = [];

  const sqliteBusy = samples.get("emerald_sqlite_busy_errors_total") ?? 0;
  results.push({
    alert: "EmeraldSqliteBusyContention",
    firing: sqliteBusy > 0,
    severity: "warning",
    value: sqliteBusy,
    reason: sqliteBusy > 0 ? `SQLITE_BUSY observed (${sqliteBusy})` : "OK",
  });

  const firewallRejects = samples.get("emerald_memory_truth_firewall_rejections_total") ?? 0;
  results.push({
    alert: "EmeraldTruthFirewallRejections",
    firing: firewallRejects > 0,
    severity: "warning",
    value: firewallRejects,
    reason: firewallRejects > 0 ? `Truth Firewall blocked ${firewallRejects} illegal promotions` : "OK",
  });

  const exportFailures =
    (samples.get("emerald_telemetry_export_failures_total") ?? 0) +
    (samples.get("emerald_langfuse_export_failures_total") ?? 0);
  results.push({
    alert: "EmeraldTelemetryPipelineDegraded",
    firing: exportFailures > 0,
    severity: "warning",
    value: exportFailures,
    reason: exportFailures > 0 ? `Telemetry export failures observed (${exportFailures})` : "OK",
  });

  const rss = samples.get("emerald_process_resident_memory_bytes") ?? 0;
  results.push({
    alert: "EmeraldProcessMemoryHigh",
    firing: rss > 1073741824,
    severity: "critical",
    value: rss,
    reason: rss > 1073741824 ? `RSS ${rss} > 1 GiB` : "OK",
  });

  const diskTotal = samples.get("emerald_disk_total_bytes") ?? 0;
  const diskFree = samples.get("emerald_disk_free_bytes") ?? 0;
  const lowDisk = diskTotal > 0 && diskFree / diskTotal < 0.1;
  results.push({
    alert: "EmeraldDiskSpaceLow",
    firing: lowDisk,
    severity: "critical",
    value: diskTotal > 0 ? Number((diskFree / diskTotal).toFixed(4)) : undefined,
    reason: lowDisk ? `Disk free ratio ${(diskFree / diskTotal).toFixed(3)} < 0.10` : "OK",
  });

  return results;
}
