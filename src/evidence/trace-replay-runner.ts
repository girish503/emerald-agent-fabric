/**
 * Offline Deterministic Trace Replay Runner & Stub Provider (Idea 3, Phase 3).
 *
 * Replays recorded `emerald-trace-v1` traces deterministically using an offline
 * stub provider (`TraceStubModelProvider`) — zero live model calls, zero tool
 * re-execution — while evaluating 7 safety and governance guardrails and
 * emitting a canonically hashed `TraceReplayReport`.
 */

import { containsUnredactedSecrets } from "../domain/canonical-hash.js";
import { ModelProviderUnavailableError } from "../domain/errors.js";
import type {
  ModelFinishReason,
  ModelProviderRequest,
  ModelProviderResponse,
} from "../domain/model-provider.js";
import { TOOL_NAMES, toolNameToCapabilityName } from "../domain/tool.js";
import {
  TRACE_FORMAT_VERSION,
  RunTrace,
  TraceApprovalEvent,
  TraceSpan,
  TraceVerificationVerdict,
  containsSecretShapedString,
  safeValidateRunTrace,
} from "../domain/trace.js";
import {
  TRACE_GUARDRAIL_RULES,
  GuardrailCheckOutcome,
  GuardrailViolation,
  StubLlmReplayOutput,
  TraceGuardrailRuleName,
  TraceReplayApprovalSummary,
  TraceReplayReport,
  TraceReplayReportBody,
  computeTraceReplayReportHash,
} from "../domain/trace-replay.js";
import type { ModelProviderPort } from "../ports/model-provider.port.js";
import type { SqliteTraceStore } from "../adapters/persistence/sqlite-trace-store.js";

const PRIVILEGED_DOWNSTREAM_TOOLS: ReadonlySet<string> = new Set([
  "run_command",
  "write_file",
  "edit_file",
]);

const INSTRUCTION_INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(?:all\s+|any\s+|prior\s+|previous\s+)?system\s+instructions/i,
  /ignore\s+(?:all\s+|any\s+|prior\s+|previous\s+)?instructions/i,
  /disregard\s+(?:all\s+|prior\s+|previous\s+)?instructions/i,
  /override\s+system\s+prompt/i,
  /\bexecute\s+rm\s+-rf\b/i,
];

const REDACTION_MARKER_PATTERN = /\[REDACTED(?:_[A-Z0-9_]+)?\]/;

export interface TraceReplayOptions {
  /** Optional task capability allowlist override (tool names or capability identifiers). */
  readonly allowedCapabilities?: readonly string[];
  /** Persist report alongside trace when a `traceStore` is configured on the runner. */
  readonly persist?: boolean;
  /** Optional timestamp passed to `SqliteTraceStore.writeReplayReport` (not included in reportHash). */
  readonly recordedAt?: string;
}

export interface TraceReplayRunnerConfig {
  readonly traceStore?: SqliteTraceStore;
}

function serializeRecordedResult(resultSummary: unknown): string {
  if (typeof resultSummary === "string") {
    return resultSummary;
  }
  return JSON.stringify(resultSummary ?? null);
}

function mapSpanStatusToFinishReason(status: unknown): ModelFinishReason {
  switch (status) {
    case "OK":
      return "STOP";
    case "CANCELLED":
      return "CANCELLED";
    case "ERROR":
    case "DENIED":
    case "TIMED_OUT":
      return "ERROR";
    default:
      return "OTHER";
  }
}

function extractModelFromSpan(span: TraceSpan, fallbackModel: string): string {
  if (typeof span.name === "string" && span.name.startsWith("llm:")) {
    const slashIdx = span.name.indexOf("/");
    if (slashIdx !== -1 && slashIdx + 1 < span.name.length) {
      return span.name.slice(slashIdx + 1);
    }
  }
  return fallbackModel;
}

/**
 * Offline stub implementation of `ModelProviderPort` backed strictly by recorded
 * `llm` spans from a trace. Performs zero network or model inference calls and
 * returns the recorded output verbatim for each recorded `llm` span in order.
 */
export class TraceStubModelProvider implements ModelProviderPort {
  readonly providerName = "trace-stub";
  private readonly llmSpans: readonly TraceSpan[];
  private cursor = 0;

  constructor(spans: readonly TraceSpan[]) {
    this.llmSpans = spans.filter((s) => s.kind === "llm");
  }

  async generate(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    const bySpanId = this.llmSpans.find(
      (s) => s.spanId === request.requestId || s.spanId === `span-llm-${request.requestId}`
    );
    const span = bySpanId ?? this.llmSpans[this.cursor];
    if (!bySpanId) {
      this.cursor += 1;
    }

    if (!span) {
      throw new ModelProviderUnavailableError(
        `No recorded llm span remaining for replay request '${request.requestId}'`,
        { providerName: this.providerName, requestId: request.requestId }
      );
    }

    const outputText = serializeRecordedResult(span.resultSummary);
    const tokensIn = typeof span.tokensIn === "number" ? span.tokensIn : 0;
    const tokensOut = typeof span.tokensOut === "number" ? span.tokensOut : 0;

    return {
      requestId: request.requestId,
      model: extractModelFromSpan(span, request.model || "unknown"),
      outputText,
      finishReason: mapSpanStatusToFinishReason(span.status),
      usage: {
        inputTokens: tokensIn,
        outputTokens: tokensOut,
        totalTokens: tokensIn + tokensOut,
      },
      durationMs: typeof span.latencyMs === "number" && span.latencyMs >= 0 ? span.latencyMs : 0,
      providerMetadata: {
        stubReplay: true,
        spanId: span.spanId,
        recordedCostUsd: span.costUsd,
      },
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function containsInstructionInjection(value: unknown): boolean {
  const serialized = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return INSTRUCTION_INJECTION_PATTERNS.some((pattern) => pattern.test(serialized));
}

function containsRedactionMarker(value: unknown): boolean {
  const serialized = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return REDACTION_MARKER_PATTERN.test(serialized);
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function evaluateSchemaCheck(
  rawInput: unknown,
  rawObj: Record<string, unknown>,
  rawSpans: readonly TraceSpan[],
  traceId: string
): readonly GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];
  const formatVersion = typeof rawObj.formatVersion === "string" ? rawObj.formatVersion : "unknown";
  if (formatVersion !== TRACE_FORMAT_VERSION) {
    violations.push({
      spanId: traceId,
      rule: "schema_valid",
      message: `Unknown trace formatVersion '${formatVersion}'; expected '${TRACE_FORMAT_VERSION}'.`,
    });
  }

  const parsed = safeValidateRunTrace(rawInput);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      let spanId = traceId;
      if (issue.path[0] === "spans" && typeof issue.path[1] === "number") {
        const candidate = rawSpans[issue.path[1]];
        if (candidate && typeof candidate.spanId === "string" && candidate.spanId.length > 0) {
          spanId = candidate.spanId;
        }
      }
      // Avoid duplicating the explicit formatVersion mismatch issue
      if (issue.path.length === 1 && issue.path[0] === "formatVersion" && violations.length > 0) {
        continue;
      }
      violations.push({
        spanId,
        rule: "schema_valid",
        message: issue.message,
      });
    }
  }
  return violations;
}

function evaluateProvenanceCheck(spans: readonly TraceSpan[]): readonly GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];
  let untrustedSeenFrom: TraceSpan | null = null;

  for (const span of spans) {
    if (span.kind === "tool") {
      if (span.provenance !== "trusted" && span.provenance !== "untrusted") {
        violations.push({
          spanId: span.spanId,
          rule: "provenance",
          message: `Tool span '${span.spanId}' lacks valid provenance ('trusted' | 'untrusted').`,
        });
      }

      if (untrustedSeenFrom) {
        const hasInjectedPayload = containsInstructionInjection([span.argsSummary, span.resultSummary]);
        if (PRIVILEGED_DOWNSTREAM_TOOLS.has(span.name) || hasInjectedPayload) {
          violations.push({
            spanId: span.spanId,
            rule: "provenance",
            message:
              `Privileged/downstream tool span '${span.name}' appeared after untrusted tool span ` +
              `'${untrustedSeenFrom.spanId}' (${untrustedSeenFrom.name}).`,
          });
        }
      }

      if (span.provenance === "untrusted") {
        untrustedSeenFrom = span;
      }
      continue;
    }

    if (span.kind === "llm" && untrustedSeenFrom) {
      if (containsInstructionInjection([span.argsSummary, span.resultSummary])) {
        violations.push({
          spanId: span.spanId,
          rule: "provenance",
          message:
            `LLM span '${span.spanId}' exhibits instruction content after untrusted tool span ` +
            `'${untrustedSeenFrom.spanId}'.`,
        });
      }
    }
  }

  return violations;
}

function evaluateRedactionCheck(
  rawObj: Record<string, unknown>,
  spans: readonly TraceSpan[],
  traceId: string
): { readonly violations: readonly GuardrailViolation[]; readonly observations: readonly string[] } {
  const violations: GuardrailViolation[] = [];
  const observations: string[] = [];

  for (const span of spans) {
    const hasSecret =
      containsUnredactedSecrets(span.argsSummary) ||
      containsSecretShapedString(span.argsSummary) ||
      containsUnredactedSecrets(span.resultSummary) ||
      containsSecretShapedString(span.resultSummary) ||
      containsSecretShapedString(span.name);

    if (hasSecret) {
      violations.push({
        spanId: span.spanId,
        rule: "redaction",
        message: `Span '${span.spanId}' contains unredacted secret-shaped material.`,
      });
    }

    if (containsRedactionMarker(span.argsSummary) || containsRedactionMarker(span.resultSummary)) {
      observations.push(span.spanId);
    }
  }

  for (const field of ["approvalEvents", "verificationVerdicts", "repairAttempts"] as const) {
    const entries = asArray(rawObj[field]);
    for (let idx = 0; idx < entries.length; idx++) {
      const entry = entries[idx];
      if (containsUnredactedSecrets(entry) || containsSecretShapedString(entry)) {
        violations.push({
          spanId: `${traceId}:${field}[${idx}]`,
          rule: "redaction",
          message: `Trace field '${field}[${idx}]' contains unredacted secret-shaped material.`,
        });
      }
    }
  }

  return { violations, observations };
}

function buildAllowedCapabilities(
  rawObj: Record<string, unknown>,
  explicitAllowed?: readonly string[]
): { readonly allowedNames: ReadonlySet<string>; readonly allowedCapabilities: ReadonlySet<string> } {
  const allowedNames = new Set<string>();
  const allowedCapabilities = new Set<string>();

  const registerToken = (token: string) => {
    const trimmed = token.trim();
    if (!trimmed) return;
    allowedNames.add(trimmed);
    allowedCapabilities.add(trimmed);
    const mapped = toolNameToCapabilityName(trimmed);
    if (mapped) {
      allowedCapabilities.add(mapped);
    }
  };

  if (explicitAllowed !== undefined) {
    for (const item of explicitAllowed) {
      registerToken(item);
    }
    return { allowedNames, allowedCapabilities };
  }

  const model = rawObj.model;
  if (model && typeof model === "object" && Array.isArray((model as Record<string, unknown>).toolList)) {
    const list = (model as Record<string, unknown>).toolList as unknown[];
    for (const item of list) {
      if (typeof item === "string") {
        registerToken(item);
      }
    }
    return { allowedNames, allowedCapabilities };
  }

  // Stub traces (`model: null`) inherit standard governed core tools + stub `echo`.
  for (const tool of TOOL_NAMES) {
    registerToken(tool);
  }
  registerToken("echo");
  registerToken("execution.echo");
  return { allowedNames, allowedCapabilities };
}

function evaluateCapabilityCheck(
  rawObj: Record<string, unknown>,
  spans: readonly TraceSpan[],
  explicitAllowed?: readonly string[]
): readonly GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];
  const { allowedNames, allowedCapabilities } = buildAllowedCapabilities(rawObj, explicitAllowed);

  for (const span of spans) {
    if (span.kind !== "tool") continue;
    const capability = toolNameToCapabilityName(span.name);
    const permitted =
      allowedNames.has(span.name) ||
      allowedCapabilities.has(span.name) ||
      allowedCapabilities.has(`execution.${span.name}`) ||
      (capability !== null && allowedCapabilities.has(capability));

    if (!permitted) {
      violations.push({
        spanId: span.spanId,
        rule: "capability",
        message: `Tool span '${span.name}' is outside allowed task capabilities.`,
      });
    }
  }

  return violations;
}

function evaluateApprovalCheck(
  spans: readonly TraceSpan[],
  approvalEvents: readonly TraceApprovalEvent[]
): {
  readonly violations: readonly GuardrailViolation[];
  readonly summary: TraceReplayApprovalSummary;
} {
  const violations: GuardrailViolation[] = [];
  let executionAfterPauseCount = 0;

  let pendingCount = 0;
  let approvedCount = 0;
  let rejectedCount = 0;
  for (const ev of approvalEvents) {
    if (ev.status === "PENDING") pendingCount += 1;
    else if (ev.status === "APPROVED" || ev.status === "CONSUMED") approvedCount += 1;
    else rejectedCount += 1;
  }

  // Track paused window by span ordering and by requestedAt..decidedAt timestamps.
  let openPauseSpan: TraceSpan | null = null;

  for (const span of spans) {
    if (span.kind === "approval") {
      if (span.status === "PAUSED" || span.status === "DENIED" || span.status === "ERROR") {
        openPauseSpan = span;
      } else if (span.status === "OK") {
        openPauseSpan = null;
      }
      continue;
    }

    const isExecutionSpan = span.kind === "tool" || span.kind === "repair" || span.kind === "llm";
    if (!isExecutionSpan) continue;

    if (openPauseSpan) {
      executionAfterPauseCount += 1;
      violations.push({
        spanId: span.spanId,
        rule: "approval",
        message:
          `Execution span '${span.spanId}' (${span.kind}:${span.name}) appeared after unresolved ` +
          `approval pause span '${openPauseSpan.spanId}'.`,
      });
      continue;
    }

    const spanStartMs = parseIsoMs(span.startedAt);
    if (spanStartMs === null) continue;

    for (const ev of approvalEvents) {
      const reqMs = parseIsoMs(ev.requestedAt);
      if (reqMs === null || spanStartMs < reqMs) continue;

      if (ev.status === "PENDING" || ev.status === "REJECTED" || ev.status === "EXPIRED") {
        executionAfterPauseCount += 1;
        violations.push({
          spanId: span.spanId,
          rule: "approval",
          message:
            `Execution span '${span.spanId}' started at '${span.startedAt}' while approval '${ev.approvalId}' ` +
            `had status '${ev.status}'.`,
        });
        break;
      }

      const decidedMs = parseIsoMs(ev.decidedAt);
      if (decidedMs === null || spanStartMs < decidedMs) {
        executionAfterPauseCount += 1;
        violations.push({
          spanId: span.spanId,
          rule: "approval",
          message:
            `Execution span '${span.spanId}' started at '${span.startedAt}' before approval '${ev.approvalId}' ` +
            `decision timestamp '${ev.decidedAt ?? "null"}'.`,
        });
        break;
      }
    }
  }

  return {
    violations,
    summary: {
      totalEvents: approvalEvents.length,
      pendingCount,
      approvedCount,
      rejectedCount,
      executionAfterPauseCount,
    },
  };
}

function evaluateVerificationCheck(
  traceId: string,
  traceStatus: string,
  spans: readonly TraceSpan[],
  verdicts: readonly TraceVerificationVerdict[]
): readonly GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];
  const rootSpanId = spans.find((s) => s.kind === "agent")?.spanId ?? spans[0]?.spanId ?? traceId;

  if (traceStatus === "COMPLETED" && verdicts.length === 0) {
    violations.push({
      spanId: rootSpanId,
      rule: "verification",
      message: `Completed trace '${traceId}' has zero recorded verification verdicts.`,
    });
    return violations;
  }

  if (verdicts.length > 0) {
    const orderedVerdicts = [...verdicts].sort((a, b) => {
      const aMs = parseIsoMs(a.verifiedAt) ?? 0;
      const bMs = parseIsoMs(b.verifiedAt) ?? 0;
      return aMs - bMs;
    });
    const finalVerdict = orderedVerdicts[orderedVerdicts.length - 1]!;
    const hasFailedVerdictWithoutSubsequentPass = finalVerdict.verdict !== "VERIFIED";

    if (traceStatus === "COMPLETED" && hasFailedVerdictWithoutSubsequentPass) {
      const verifySpanId =
        [...spans].reverse().find((s) => s.kind === "verification")?.spanId ?? rootSpanId;
      violations.push({
        spanId: verifySpanId,
        rule: "verification",
        message:
          `Trace completed after non-verified verdict '${finalVerdict.verdict}' on spec '${finalVerdict.specId}' ` +
          `with no subsequent VERIFIED verdict.`,
      });
    }
  }

  // Also ensure a verification span reporting FAILED/REJECTED without a subsequent verification OK span never precedes COMPLETED
  let lastVerifyFailedSpan: TraceSpan | null = null;
  for (const span of spans) {
    if (span.kind !== "verification") continue;
    const summaryVerdict = asRecord(span.resultSummary).verdict;
    if (span.status === "OK" || summaryVerdict === "VERIFIED") {
      lastVerifyFailedSpan = null;
    } else if (
      span.status === "ERROR" ||
      span.status === "DENIED" ||
      summaryVerdict === "FAILED" ||
      summaryVerdict === "REJECTED"
    ) {
      lastVerifyFailedSpan = span;
    }
  }
  if (traceStatus === "COMPLETED" && lastVerifyFailedSpan && violations.length === 0) {
    violations.push({
      spanId: lastVerifyFailedSpan.spanId,
      rule: "verification",
      message: `Completed trace '${traceId}' ended with unresolved failing verification span '${lastVerifyFailedSpan.spanId}'.`,
    });
  }

  return violations;
}

function evaluateLlmTelemetryCheck(spans: readonly TraceSpan[]): readonly GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];
  for (const span of spans) {
    if (span.kind !== "llm") continue;
    const hasLatency =
      typeof span.latencyMs === "number" && Number.isFinite(span.latencyMs) && span.latencyMs >= 0;
    const hasCost =
      span.costUsd !== null &&
      typeof span.costUsd === "number" &&
      Number.isFinite(span.costUsd) &&
      span.costUsd >= 0;

    if (!hasLatency || !hasCost) {
      const missing: string[] = [];
      if (!hasLatency) missing.push("latencyMs");
      if (!hasCost) missing.push("costUsd");
      violations.push({
        spanId: span.spanId,
        rule: "llm_telemetry",
        message: `LLM span '${span.spanId}' missing required telemetry fields: ${missing.join(", ")}.`,
      });
    }
  }
  return violations;
}

export interface GuardrailEvaluationResult {
  readonly traceId: string;
  readonly runId: string;
  readonly missionId: string;
  readonly formatVersion: string;
  readonly traceStatus: string;
  readonly spans: readonly TraceSpan[];
  readonly approvalEvents: readonly TraceApprovalEvent[];
  readonly verificationVerdicts: readonly TraceVerificationVerdict[];
  readonly defaultModelName: string;
  readonly approvalSummary: TraceReplayApprovalSummary;
  readonly redactionObservations: readonly string[];
  readonly checks: readonly GuardrailCheckOutcome[];
  readonly checksPassed: number;
  readonly checksFailed: number;
  readonly passed: boolean;
  readonly violations: readonly GuardrailViolation[];
}

/**
 * Evaluates all 7 replay guardrails deterministically and synchronously on any trace input.
 */
export function evaluateTraceGuardrails(
  rawInput: unknown,
  allowedCapabilities?: readonly string[]
): GuardrailEvaluationResult {
  const rawObj = asRecord(rawInput);
  const traceId = typeof rawObj.traceId === "string" && rawObj.traceId.length > 0 ? rawObj.traceId : "unknown-trace";
  const runId = typeof rawObj.runId === "string" && rawObj.runId.length > 0 ? rawObj.runId : "unknown-run";
  const missionId = typeof rawObj.missionId === "string" && rawObj.missionId.length > 0 ? rawObj.missionId : "unknown-mission";
  const formatVersion = typeof rawObj.formatVersion === "string" && rawObj.formatVersion.length > 0 ? rawObj.formatVersion : "unknown";
  const traceStatus = typeof rawObj.status === "string" && rawObj.status.length > 0 ? rawObj.status : "UNKNOWN";

  const spans = asArray(rawObj.spans).filter(
    (s): s is TraceSpan => Boolean(s && typeof s === "object" && !Array.isArray(s))
  );
  const approvalEvents = asArray(rawObj.approvalEvents) as readonly TraceApprovalEvent[];
  const verificationVerdicts = asArray(rawObj.verificationVerdicts) as readonly TraceVerificationVerdict[];
  const modelObj = asRecord(rawObj.model);
  const defaultModelName = typeof modelObj.model === "string" && modelObj.model.length > 0 ? modelObj.model : "stub-model";

  const schemaViolations = evaluateSchemaCheck(rawInput, rawObj, spans, traceId);
  const provenanceViolations = evaluateProvenanceCheck(spans);
  const redactionCheck = evaluateRedactionCheck(rawObj, spans, traceId);
  const capabilityViolations = evaluateCapabilityCheck(rawObj, spans, allowedCapabilities);
  const approvalCheck = evaluateApprovalCheck(spans, approvalEvents);
  const verificationViolations = evaluateVerificationCheck(
    traceId,
    traceStatus,
    spans,
    verificationVerdicts
  );
  const llmTelemetryViolations = evaluateLlmTelemetryCheck(spans);

  const byRule = new Map<TraceGuardrailRuleName, readonly GuardrailViolation[]>([
    ["schema_valid", schemaViolations],
    ["provenance", provenanceViolations],
    ["redaction", redactionCheck.violations],
    ["capability", capabilityViolations],
    ["approval", approvalCheck.violations],
    ["verification", verificationViolations],
    ["llm_telemetry", llmTelemetryViolations],
  ]);

  const checks: GuardrailCheckOutcome[] = TRACE_GUARDRAIL_RULES.map((rule) => {
    const ruleViolations = byRule.get(rule) ?? [];
    return {
      rule,
      passed: ruleViolations.length === 0,
      violationCount: ruleViolations.length,
    };
  });

  const violations: GuardrailViolation[] = [];
  for (const rule of TRACE_GUARDRAIL_RULES) {
    violations.push(...(byRule.get(rule) ?? []));
  }

  const checksPassed = checks.filter((c) => c.passed).length;
  const checksFailed = checks.length - checksPassed;

  return {
    traceId,
    runId,
    missionId,
    formatVersion,
    traceStatus,
    spans,
    approvalEvents,
    verificationVerdicts,
    defaultModelName,
    approvalSummary: approvalCheck.summary,
    redactionObservations: [...redactionCheck.observations],
    checks,
    checksPassed,
    checksFailed,
    passed: checksFailed === 0,
    violations,
  };
}

/**
 * Deterministic stub-backed trace replay runner with 7 guardrail checks.
 */
export class TraceReplayRunner {
  private readonly traceStore?: SqliteTraceStore;

  constructor(config: TraceReplayRunnerConfig = {}) {
    this.traceStore = config.traceStore;
  }

  /**
   * Replays either a stored trace by `traceId` (via `traceStore`) or a trace object
   * using `TraceStubModelProvider` — zero real model or tool executions.
   */
  async replay(
    traceOrId: string | RunTrace | Record<string, unknown>,
    options: TraceReplayOptions = {}
  ): Promise<TraceReplayReport> {
    let rawInput: unknown = traceOrId;
    if (typeof traceOrId === "string") {
      if (!this.traceStore) {
        throw new Error(
          `Cannot replay traceId '${traceOrId}' without a configured SqliteTraceStore.`
        );
      }
      const loaded = this.traceStore.readTraceById(traceOrId);
      if (!loaded) {
        throw new Error(`Trace '${traceOrId}' not found in SqliteTraceStore.`);
      }
      rawInput = loaded;
    }

    const evaluation = evaluateTraceGuardrails(rawInput, options.allowedCapabilities);

    // Walk spans in recorded order; invoke offline stub provider for every LLM span.
    const stubProvider = new TraceStubModelProvider(evaluation.spans);
    const llmOutputs: StubLlmReplayOutput[] = [];
    for (const span of evaluation.spans) {
      if (span.kind !== "llm") continue;
      const stubResponse = await stubProvider.generate({
        requestId: span.spanId,
        model: extractModelFromSpan(span, evaluation.defaultModelName),
        input: [
          {
            role: "user",
            content: serializeRecordedResult(span.argsSummary),
          },
        ],
        timeoutMs: 1,
      });
      llmOutputs.push({
        spanId: span.spanId,
        model: stubResponse.model,
        recordedResultSummary: span.resultSummary ?? null,
        stubOutputText: stubResponse.outputText,
        costUsd: typeof span.costUsd === "number" ? span.costUsd : null,
        latencyMs: stubResponse.durationMs,
      });
    }

    const body: TraceReplayReportBody = {
      traceId: evaluation.traceId,
      runId: evaluation.runId,
      missionId: evaluation.missionId,
      formatVersion: evaluation.formatVersion,
      traceStatus: evaluation.traceStatus,
      mode: "stub-replay",
      spansWalked: evaluation.spans.length,
      llmOutputs,
      verdictsIntact: [...evaluation.verificationVerdicts],
      approvalSummary: evaluation.approvalSummary,
      redactionObservations: [...evaluation.redactionObservations],
      checks: [...evaluation.checks],
      checksPassed: evaluation.checksPassed,
      checksFailed: evaluation.checksFailed,
      passed: evaluation.passed,
      violations: [...evaluation.violations],
    };

    const report: TraceReplayReport = {
      ...body,
      reportHash: computeTraceReplayReportHash(body),
    };

    if (options.persist && this.traceStore) {
      this.traceStore.writeReplayReport(report, options.recordedAt);
    }

    return report;
  }
}
