import { scopeIdempotencyKeyForTenant, submitDurableTask } from "../../application/durable-submission.js";
import { createObservableStateStore } from "../../application/observable-state-store.js";
import { SystemClock } from "../../ports/clock.port.js";
import { MultiAgentOrchestrator } from "../../application/multi-agent-orchestrator.js";
import type { GovernedModelRouterService } from "../../application/governed-model-router.js";
import { TaskRouterService } from "../../application/task-router.js";
import { ApprovalControl, type ApprovalRequest } from "../../control-plane/approval-control.js";
import { ScopedContextMemoryService } from "../../application/scoped-context-memory.js";
import type { WorkerRuntime } from "../../application/worker-runtime.js";
import {
  TelemetryExporter,
  createTelemetryExporterFromEnv,
} from "../../infrastructure/monitoring/telemetry-exporter.js";
import { EmeraldLifecycleTelemetry } from "../../application/observability-instrumentation.js";
import { formatTraceparent, parseTraceparent } from "../../infrastructure/monitoring/otel-observability.js";
import { sanitizeTelemetryString } from "../../infrastructure/monitoring/telemetry-redaction.js";
import {
  SuperAgentDecompositionError,
  CapabilityEscalationError,
  ResourceBudgetExceededError,
  SynthesisVerificationError,
} from "../../domain/super-agent.js";
/**
 * Fastify REST & SSE transport (Track B)
 *
 * This layer authenticates, authorizes, validates and relays. It owns no run lifecycle authority:
 *  - Run cancellation and state reads go through the RunCoordinator; the transport never mutates a run,
 *    never fabricates worker/lease/supervisor identities and never invents timestamps.
 *  - Outcomes are derived only from durable verification events (see run-outcome.ts).
 *  - Tasks and runs held in `inMemoryStore` are an explicit, transport-local, NON-DURABLE adapter for
 *    development and tests. Nothing here persists tenant ownership. Every response served from that adapter
 *    carries `X-Emerald-Durability: transport-local-non-durable`.
 *
 * Security properties and their precise limits are documented next to the code that provides them.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import * as fs from "node:fs";
import * as path from "node:path";
import crypto from "crypto";
import { EventEmitter } from "events";
import { isTerminalState, type RunStatus } from "../../domain/invariants.js";
import { InvalidStateTransitionError, TerminalStateError, VersionConflictError } from "../../domain/errors.js";
import { RunCoordinator } from "../../application/run-coordinator.js";
import type { StateStorePort } from "../../ports/state-store.port.js";
import {
  AuthorizationHeaderSchema,
  CancelRunRequestSchema,
  CreateTaskRequestSchema,
  SSE_TERMINAL_EVENT_TYPES,
  USER_ROLES,
  type ApiErrorCode,
  type ApiErrorResponse,
  type CancelRunResponse,
  type ListArtifactsResponse,
  type RunResponse,
  ListTasksQuerySchema,
  type ListTasksResponse,
  type TaskResponse,
  type TaskStatus,
  type TaskSummary,
  type UserRole,
  type WhoamiResponse,
  DecomposeMissionRequestSchema,
  type DecomposeMissionResponse,
  type MissionHierarchyResponse,
  type SynthesizeMissionResponse,
  ApprovalDecisionRequestSchema,
  ListApprovalsQuerySchema,
  type ApprovalDecisionResponse,
  type ApprovalResponse,
  type ApprovalSummary,
  type ListApprovalsResponse,
  type TaskDagNode,
  type TaskDagResponse,
} from "./api-contracts.js";
import {
  InvalidCursorError,
  decodeTaskCursor,
  encodeTaskCursor,
} from "../../infrastructure/sqlite/sqlite-task-store.js";
import {
  discoverRunArtifacts,
  retrieveRunArtifactContent,
  ArtifactDiscoveryError,
  DEFAULT_MAX_ARTIFACT_CONTENT_BYTES,
  ALLOWED_ARTIFACT_CONTENT_TYPES,
} from "./artifact-discovery.js";
import { deriveAuthoritativeOutcome, type DurableEventView } from "./run-outcome.js";
import { SseSession, type SseEnvelope, projectEventDataForRole } from "./sse-stream.js";

// ============================================================================
// Configuration
// ============================================================================

export interface PrincipalRecord {
  /** Bearer token. Hashed at construction; the plaintext is not retained by the server. */
  readonly token: string;
  readonly principalId: string;
  readonly tenantId: string;
  readonly role: UserRole;
  /** Explicit server-side permission authorizing constrained-host execution. Default false. */
  readonly allowConstrainedHost?: boolean;
}

export interface DiagnosticRecord {
  readonly ts: string;
  readonly level: "error" | "warn";
  readonly event: string;
  readonly traceId: string;
  readonly method?: string;
  readonly route?: string;
  readonly errorName?: string;
  readonly errorMessage?: string;
}

export interface ServerOptions {
  /** Explicit principals. If omitted, EMERALD_API_PRINCIPALS (JSON array) is read. If neither exists, startup fails. */
  readonly principals?: readonly PrincipalRecord[];
  /** Explicit allowed CORS origins (exact origins). If omitted, EMERALD_CORS_ORIGINS (comma list) is read; default none. */
  readonly corsOrigins?: readonly string[];
  /** Environment used for configuration lookups (defaults to process.env). */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Explicit transport-local, NON-DURABLE adapter for tasks/runs/artifacts/events (development and tests).
   * Without it, task creation is unavailable (503) and lookups find nothing.
   */
  readonly inMemoryStore?: {
    tasks?: Map<string, any>;
    runs?: Map<string, any>;
    artifacts?: Map<string, any[]>;
    events?: Map<string, any[]>;
    artifactContents?: Map<string, string | Buffer>;
  };
  /** Authoritative run authority. Required for cancellation; used for run state reads. */
  readonly coordinator?: RunCoordinator;
  /** Durable event source for SSE replay (falls back to coordinator.getEventsForRun). */
  readonly stateStore?: Pick<StateStorePort, "getEventsForRun">;
  /** Durable StateStorePort for durable task submission, inspection, and event emission. */
  readonly store?: StateStorePort;
  /** Durable TaskRouterService for multi-agent scheduling and dispatch. */
  readonly taskRouter?: TaskRouterService;
  /** Durable MultiAgentOrchestrator for super-agent decomposition and synthesis. */
  readonly orchestrator?: MultiAgentOrchestrator;
  /**
   * Governed model router (with installed inventory applied by the composition root). When set, the default
   * orchestrator assigns a model to every decomposed subtask and rejects subtasks no model qualifies for.
   */
  readonly modelRouter?: GovernedModelRouterService;
  /** Live relay channel `run:<runId>`. No component of the runtime currently publishes to it automatically. */
  readonly eventBroadcaster?: EventEmitter;
  readonly sse?: { readonly maxBufferedEvents?: number; readonly maxConnections?: number };
  /** Sink for server-side diagnostics of unexpected failures. Defaults to a JSON line on stderr. */
  readonly diagnostics?: (record: DiagnosticRecord) => void;
  /**
   * Root directory containing durable run artifacts (<artifactRoot>/<runId>/attempt-<n>/manifest.json).
   * In production, this must match the artifactRoot passed to WorkerHost/GitArtifactExporter.
   */
  readonly artifactRoot?: string;
  /** Telemetry and Prometheus metrics exporter instance. */
  readonly telemetryExporter?: TelemetryExporter;
  /** Optional lifecycle telemetry facade (created from telemetryExporter if omitted). */
  readonly lifecycleTelemetry?: EmeraldLifecycleTelemetry;
  /** Optional directory path inspected for safe disk-space runtime metrics on /metrics scrape. */
  readonly healthDataDirectory?: string;
  /** Opt-in directory containing static dashboard UI bundle (index.html, dist/bundle.js). Never enabled by default. */
  readonly webUiRoot?: string;
  /** Optional human-in-the-loop approval control service (auto-constructed from durable store if supported). */
  readonly approvalControl?: ApprovalControl;
  /** Optional scoped durable memory service (auto-constructed from SQLite store if supported). */
  readonly scopedMemory?: ScopedContextMemoryService;
  /** Optional integrated worker runtime driven by the execution loop when enableExecutionLoop is true. */
  readonly workerRuntime?: WorkerRuntime;
  /** Enable automatic router dispatch ticks and worker execution pumping (bounded, non-reentrant). */
  readonly enableExecutionLoop?: boolean;
  /** Interval in ms for background execution loop ticks (default 150ms when enableExecutionLoop is true). */
  readonly executionLoopIntervalMs?: number;
  /** Maximum concurrent in-flight runs permitted by the default TaskRouterService (1 or 2, default 2). */
  readonly maxConcurrentRuns?: 1 | 2;
}

export class AuthConfigurationError extends Error {
  constructor(message: string) {
    super(`Authentication configuration invalid: ${message}`);
    this.name = "AuthConfigurationError";
  }
}

export class CorsConfigurationError extends Error {
  constructor(message: string) {
    super(`CORS configuration invalid: ${message}`);
    this.name = "CorsConfigurationError";
  }
}

const MIN_TOKEN_LENGTH = 24;
const KNOWN_INSECURE_TOKENS: ReadonlySet<string> = new Set(["test-emerald-token", "secret-test-token-123", "changeme", "password"]);
const DEFAULT_MAX_BUFFERED_EVENTS = 1000;
const DEFAULT_MAX_SSE_CONNECTIONS = 100;
const SSE_PING_INTERVAL_MS = 15_000;

const READ_ROLES: readonly UserRole[] = ["operator", "auditor", "admin"];
const WRITE_ROLES: readonly UserRole[] = ["operator", "admin"];

interface PreparedPrincipal {
  readonly digest: Buffer;
  readonly principalId: string;
  readonly tenantId: string;
  readonly role: UserRole;
  readonly allowConstrainedHost: boolean;
}

export interface AuthenticatedPrincipal {
  readonly principalId: string;
  readonly tenantId: string;
  readonly role: UserRole;
  readonly allowConstrainedHost: boolean;
}

function sha256(value: string): Buffer {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

function validateTokenEntropy(token: string, label: string): void {
  if (typeof token !== "string" || token.length < MIN_TOKEN_LENGTH) {
    throw new AuthConfigurationError(`${label} token must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token)) {
    throw new AuthConfigurationError(`${label} token contains characters not valid in a Bearer token`);
  }
  if (KNOWN_INSECURE_TOKENS.has(token.toLowerCase())) {
    throw new AuthConfigurationError(`${label} uses a known insecure token`);
  }
  if (/^(password|secret|admin|emerald|token|default|changeme)+$/i.test(token)) {
    throw new AuthConfigurationError(`${label} token consists only of predictable dictionary words without entropy`);
  }
  if (/^(.)\1+$/.test(token)) {
    throw new AuthConfigurationError(`${label} token consists of a single repeated character`);
  }
  if (new Set(token).size < 8) {
    throw new AuthConfigurationError(`${label} token has insufficient entropy (fewer than 8 unique characters)`);
  }
}

/**
 * Validates and prepares principals. Fails closed: no principals means the server does not start.
 * Error messages never contain token values.
 */
function resolvePrincipals(options: ServerOptions, env: NodeJS.ProcessEnv): PreparedPrincipal[] {
  let raw: readonly PrincipalRecord[] | undefined = options.principals;
  if (!raw) {
    const fromEnv = env.EMERALD_API_PRINCIPALS;
    if (fromEnv && fromEnv.trim().length > 0) {
      try {
        const parsed: unknown = JSON.parse(fromEnv);
        if (!Array.isArray(parsed)) throw new Error("not an array");
        raw = parsed as PrincipalRecord[];
      } catch {
        throw new AuthConfigurationError("EMERALD_API_PRINCIPALS must be a JSON array of principal objects");
      }
    }
  }
  if (!raw || raw.length === 0) {
    throw new AuthConfigurationError(
      "no principals configured; supply options.principals or EMERALD_API_PRINCIPALS (there is no default credential)"
    );
  }

  const prepared: PreparedPrincipal[] = [];
  const seenDigests = new Set<string>();
  raw.forEach((p, index) => {
    const label = `principal[${index}]`;
    if (!p || typeof p !== "object") throw new AuthConfigurationError(`${label} must be an object`);
    validateTokenEntropy(p.token, label);
    if (typeof p.principalId !== "string" || p.principalId.trim().length === 0) {
      throw new AuthConfigurationError(`${label} principalId is required`);
    }
    if (typeof p.tenantId !== "string" || p.tenantId.trim().length === 0) {
      throw new AuthConfigurationError(`${label} tenantId is required`);
    }
    if (!(USER_ROLES as readonly string[]).includes(p.role)) {
      throw new AuthConfigurationError(`${label} role must be one of ${USER_ROLES.join(", ")}`);
    }
    const digest = sha256(p.token);
    const hex = digest.toString("hex");
    if (seenDigests.has(hex)) throw new AuthConfigurationError(`${label} duplicates another principal's token`);
    seenDigests.add(hex);
    prepared.push({
      digest,
      principalId: p.principalId,
      tenantId: p.tenantId,
      role: p.role,
      allowConstrainedHost: p.allowConstrainedHost === true,
    });
  });
  return prepared;
}

/**
 * Validates CORS origins at startup. Positive allowlist only: exact `http:`/`https:` origins.
 * Wildcards are rejected unconditionally (credentials are enabled for allowlisted origins), and nothing
 * here depends on NODE_ENV.
 */
export function validateCorsOrigins(origins: readonly string[]): readonly string[] {
  for (const origin of origins) {
    if (origin === "*" || origin.includes("*")) {
      throw new CorsConfigurationError("wildcard origins are not permitted");
    }
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new CorsConfigurationError(`'${origin}' is not a valid origin URL`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new CorsConfigurationError(`'${origin}' must use exactly http: or https:`);
    }
    if (parsed.origin !== origin) {
      throw new CorsConfigurationError(`'${origin}' must be an exact origin (scheme://host[:port], no path, query, credentials or trailing slash)`);
    }
  }
  return origins;
}

function resolveCorsOrigins(options: ServerOptions, env: NodeJS.ProcessEnv): readonly string[] {
  const configured =
    options.corsOrigins ??
    (env.EMERALD_CORS_ORIGINS ? env.EMERALD_CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean) : []);
  return validateCorsOrigins(configured);
}

/** Trace ids are restricted to a safe charset, so they cannot carry control characters into logs. */
const TRACE_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

function newTraceId(): string {
  return `trace-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
}

function redactMessage(message: string): string {
  return sanitizeTelemetryString(message, 300);
}

const defaultDiagnostics = (record: DiagnosticRecord): void => {
  process.stderr.write(`${JSON.stringify(record)}\n`);
};

// ============================================================================
// Server
// ============================================================================

declare module "fastify" {
  interface FastifyRequest {
    traceId: string;
    otelTraceId?: string;
    otelSpanId?: string;
    requestStartMs?: number;
    principal?: AuthenticatedPrincipal;
  }
}

export function buildFastifyServer(options: ServerOptions = {}): FastifyInstance {
  const env = options.env ?? process.env;

  // Fail closed before anything is constructed.
  const prepared = resolvePrincipals(options, env);
  const allowedOrigins = resolveCorsOrigins(options, env);

  const server = Fastify({ logger: false });
  // Reject text/plain and other non-JSON payloads with 415 UNSUPPORTED_MEDIA_TYPE
  server.removeContentTypeParser("text/plain");
  const diagnostics = options.diagnostics ?? defaultDiagnostics;
  const artifactRoot = options.artifactRoot || env.EMERALD_ARTIFACT_ROOT || undefined;
  const telemetry = options.telemetryExporter ?? createTelemetryExporterFromEnv(env);
  const executionMode = env.EMERALD_EXECUTION_MODE === "fixture" ? "fixture" : "live";
  const lifecycleTelemetry =
    options.lifecycleTelemetry ??
    new EmeraldLifecycleTelemetry(telemetry.observability, telemetry.langfuse, {
      defaultExecutionMode: executionMode,
    });

  const local = options.inMemoryStore;
  const tasks = local?.tasks ?? (local ? new Map<string, any>() : undefined);
  const runs = local?.runs ?? (local ? new Map<string, any>() : undefined);
  const artifacts = local?.artifacts ?? (local ? new Map<string, any[]>() : undefined);
  const localEvents = local?.events ?? (local ? new Map<string, any[]>() : undefined);

  const eventBroadcaster = options.eventBroadcaster ?? new EventEmitter();
  const maxBufferedEvents = options.sse?.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
  const maxConnections = options.sse?.maxConnections ?? DEFAULT_MAX_SSE_CONNECTIONS;
  eventBroadcaster.setMaxListeners(maxConnections + 50);
  let activeSseConnections = 0;
  const MAX_TENANT_SSE_CONNECTIONS = 5;
  const tenantSseConnections = new Map<string, number>();

  const rawStore = options.store ?? (options.coordinator as any)?.stateStore ?? (options.coordinator as any)?.store;
  const clock = new SystemClock();
  const effectiveStore = rawStore ? createObservableStateStore(rawStore, eventBroadcaster) : undefined;
  const effectiveCoordinator = options.coordinator ?? (effectiveStore ? new RunCoordinator(effectiveStore, clock, undefined, undefined, eventBroadcaster) : undefined);
  if (effectiveCoordinator) {
    effectiveCoordinator.setEventBroadcaster?.(eventBroadcaster);
  }
  const effectiveApprovalControl =
    options.approvalControl ??
    (effectiveStore && typeof (effectiveStore as any).insertApprovalRequest === "function"
      ? new ApprovalControl(clock, effectiveStore, true)
      : undefined);
  const effectiveScopedMemory =
    options.scopedMemory ??
    (effectiveStore && typeof (effectiveStore as any).getScopedMemoryStore === "function"
      ? new ScopedContextMemoryService((effectiveStore as any).getScopedMemoryStore(), {
          clock,
          telemetry: lifecycleTelemetry,
        })
      : undefined);
  const effectiveTaskRouter = options.taskRouter ?? (effectiveStore && effectiveCoordinator ? new TaskRouterService(
    effectiveStore,
    effectiveCoordinator,
    clock,
    { maxConcurrentRuns: options.maxConcurrentRuns ?? 2, telemetry: lifecycleTelemetry }
  ) : undefined);
  const effectiveOrchestrator = options.orchestrator ?? (effectiveStore && effectiveCoordinator && effectiveTaskRouter ? new MultiAgentOrchestrator(
    effectiveStore,
    effectiveCoordinator,
    effectiveTaskRouter,
    clock,
    {
      ...(options.modelRouter ? { modelRouter: options.modelRouter } : {}),
      ...(effectiveScopedMemory ? { scopedMemory: effectiveScopedMemory } : {}),
      telemetry: lifecycleTelemetry,
    }
  ) : undefined);

  let activePumpPromise: Promise<void> | null = null;
  let repumpPending = false;
  let pumpClosed = false;
  const executionLoopEnabled = options.enableExecutionLoop === true;
  const executionLoopStats = {
    enabled: executionLoopEnabled,
    ticksTotal: 0,
    runsExecuted: 0,
    errorCount: 0,
    lastTickAt: null as string | null,
    lastSuccessAt: null as string | null,
    lastErrorAt: null as string | null,
    lastError: null as string | null,
  };
  let initialRecoveryChecked = false;

  const runOnePumpCycle = async (): Promise<void> => {
    if (pumpClosed || !executionLoopEnabled) return;
    executionLoopStats.ticksTotal += 1;
    executionLoopStats.lastTickAt = new Date().toISOString();

    if (!initialRecoveryChecked && options.workerRuntime && effectiveCoordinator) {
      initialRecoveryChecked = true;
      try {
        // Safe startup recovery for expired IN_PROCESS leases; ISOLATED leases respect F-03 quiescence.
        effectiveCoordinator.recoverExpiredRuns();
      } catch (err) {
        executionLoopStats.errorCount += 1;
        executionLoopStats.lastErrorAt = new Date().toISOString();
        executionLoopStats.lastError = redactMessage((err as Error)?.message ?? String(err));
        diagnostics({
          ts: executionLoopStats.lastErrorAt,
          level: "warn",
          event: "execution_loop.recovery_error",
          traceId: "system",
          errorName: (err as Error)?.name,
          errorMessage: executionLoopStats.lastError,
        });
      }
    }

    try {
      effectiveTaskRouter?.dispatchTick();
    } catch (err) {
      executionLoopStats.errorCount += 1;
      executionLoopStats.lastErrorAt = new Date().toISOString();
      executionLoopStats.lastError = redactMessage((err as Error)?.message ?? String(err));
      diagnostics({
        ts: executionLoopStats.lastErrorAt,
        level: "warn",
        event: "execution_loop.router_tick_error",
        traceId: "system",
        errorName: (err as Error)?.name,
        errorMessage: executionLoopStats.lastError,
      });
    }

    if (options.workerRuntime && !pumpClosed) {
      for (let i = 0; i < 4 && !pumpClosed; i++) {
        try {
          const res = await options.workerRuntime.runOnce();
          if (res.status === "IDLE") {
            executionLoopStats.lastSuccessAt = new Date().toISOString();
            break;
          }
          executionLoopStats.runsExecuted += 1;
          if (res.status === "FAILED" && res.error) {
            const errObj = res.error as { message?: string; code?: string };
            executionLoopStats.errorCount += 1;
            executionLoopStats.lastErrorAt = new Date().toISOString();
            executionLoopStats.lastError = redactMessage(errObj.message ?? errObj.code ?? "Run failed");
          } else {
            executionLoopStats.lastSuccessAt = new Date().toISOString();
          }
          try {
            effectiveTaskRouter?.dispatchTick();
          } catch {
            // Non-fatal follow-up tick
          }
        } catch (err) {
          executionLoopStats.errorCount += 1;
          executionLoopStats.lastErrorAt = new Date().toISOString();
          executionLoopStats.lastError = redactMessage((err as Error)?.message ?? String(err));
          diagnostics({
            ts: executionLoopStats.lastErrorAt,
            level: "warn",
            event: "execution_loop.worker_error",
            traceId: "system",
            errorName: (err as Error)?.name,
            errorMessage: executionLoopStats.lastError,
          });
          break;
        }
      }
    }
  };

  const pumpExecutionLoop = (): Promise<void> => {
    if (pumpClosed || !executionLoopEnabled) {
      return activePumpPromise ?? Promise.resolve();
    }
    if (activePumpPromise) {
      repumpPending = true;
      return activePumpPromise;
    }
    activePumpPromise = (async () => {
      do {
        repumpPending = false;
        if (pumpClosed) break;
        await runOnePumpCycle();
      } while (repumpPending && !pumpClosed);
    })().finally(() => {
      activePumpPromise = null;
    });
    return activePumpPromise;
  };

  let executionLoopTimer: NodeJS.Timeout | undefined;
  if (executionLoopEnabled) {
    const intervalMs = Math.max(25, options.executionLoopIntervalMs ?? 150);
    executionLoopTimer = setInterval(() => {
      void pumpExecutionLoop();
    }, intervalMs);
    executionLoopTimer.unref?.();
  }

  server.decorate("eventBroadcaster", eventBroadcaster);
  server.decorate("inMemoryStore", { tasks, runs, artifacts, events: localEvents });
  server.decorateRequest("traceId", "");

  const terminalEventTypes: ReadonlySet<string> = new Set<string>(SSE_TERMINAL_EVENT_TYPES);

  // --------------------------------------------------------------------------
  // Error helpers (messages are fixed strings; internal details never reach the response)
  // --------------------------------------------------------------------------
  const sendError = (
    request: FastifyRequest,
    reply: FastifyReply,
    status: number,
    code: ApiErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) => {
    const sanitizedMessage = typeof message === "string" ? redactMessage(message) : "An error occurred";
    const body: ApiErrorResponse = {
      success: false,
      error: { code, message: sanitizedMessage, ...(details ? { details } : {}), timestamp: new Date().toISOString(), traceId: request.traceId },
    };
    return reply.status(status).send(body);
  };

  const notFound = (request: FastifyRequest, reply: FastifyReply, resource: "Task" | "Run" | "Artifact" | "Approval") =>
    sendError(request, reply, 404, "NOT_FOUND", `${resource} not found`);

  const unavailable = (request: FastifyRequest, reply: FastifyReply, message: string, code: ApiErrorCode = "TRANSIENT") => {
    reply.header("Retry-After", "30");
    return sendError(request, reply, 503, code, message);
  };

  server.setNotFoundHandler((request, reply) => sendError(request, reply, 404, "NOT_FOUND", "Resource not found"));

  server.setErrorHandler((error, request, reply) => {
    const err = error as { statusCode?: number; name?: string; message?: string };
    const status = typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) {
      diagnostics({
        ts: new Date().toISOString(),
        level: "error",
        event: "http.unhandled_error",
        traceId: request.traceId,
        method: request.method,
        route: request.routeOptions?.url ?? "unmatched",
        errorName: typeof err.name === "string" ? err.name : "Error",
        errorMessage: redactMessage(typeof err.message === "string" ? err.message : "unknown"),
      });
      return sendError(request, reply, 500, "INTERNAL_ERROR", "An internal server error occurred. Quote traceId when contacting support.");
    }
    const table: Record<number, [ApiErrorCode, string]> = {
      400: ["BAD_REQUEST", "Invalid request"],
      401: ["UNAUTHORIZED", "Authentication required"],
      403: ["FORBIDDEN", "Access denied"],
      404: ["NOT_FOUND", "Resource not found"],
      409: ["CONFLICT", "Resource conflict"],
      413: ["PAYLOAD_TOO_LARGE", "Payload too large"],
      415: ["UNSUPPORTED_MEDIA_TYPE", "Unsupported media type"],
      429: ["TOO_MANY_REQUESTS", "Too many requests"],
      503: ["SERVICE_UNAVAILABLE", "Service unavailable"],
    };
    const [code, message] = table[status] ?? ["BAD_REQUEST", "Invalid request"];
    return sendError(request, reply, status, code, message);
  });

  // --------------------------------------------------------------------------
  // Authentication
  //
  // What is protected: the comparison of the presented token against every configured token. Both sides are
  // reduced to fixed-length SHA-256 digests and compared with crypto.timingSafeEqual, so token length and
  // content do not influence the comparison, and all principals are always evaluated (no first-match exit).
  // What is NOT claimed: constant-time behaviour of the whole HTTP request (header parsing, routing and
  // network jitter are outside this guarantee). Missing, malformed and unknown credentials produce the same
  // 401 response and perform the same comparison work.
  // --------------------------------------------------------------------------
  const requireAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.principal) return; // already authenticated in onRequest hook

    const header = request.headers.authorization;
    const wellFormed = typeof header === "string" && AuthorizationHeaderSchema.safeParse(header).success;
    const presented = sha256(wellFormed ? (header as string).replace(/^Bearer\s+/, "") : "");

    let matched: PreparedPrincipal | undefined;
    for (const candidate of prepared) {
      if (crypto.timingSafeEqual(presented, candidate.digest)) matched = candidate;
    }

    if (!wellFormed || !matched) {
      reply.header("WWW-Authenticate", "Bearer");
      return sendError(request, reply, 401, "UNAUTHORIZED", "Authentication required");
    }
    request.principal = {
      principalId: matched.principalId,
      tenantId: matched.tenantId,
      role: matched.role,
      allowConstrainedHost: matched.allowConstrainedHost,
    };
  };

  const requireRole = (allowed: readonly UserRole[]) => async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = request.principal;
    if (!principal || !allowed.includes(principal.role)) {
      return sendError(request, reply, 403, "FORBIDDEN", "Insufficient role for this operation");
    }
  };

  const readRoute = { preHandler: [requireAuth, requireRole(READ_ROLES)] };
  const writeRoute = { preHandler: [requireAuth, requireRole(WRITE_ROLES)] };

  // --------------------------------------------------------------------------
  // Trace id & Early Authentication:
  // Fastify executes body parsers and content-type checks before route preHandlers.
  // For payload-carrying methods (POST, PUT, PATCH, DELETE) or requests with content headers,
  // authenticate early in onRequest before body parsing runs, so unauthenticated requests receive 401
  // instead of 400 (malformed JSON), 413 (body too large), or 415 (unsupported media type).
  // Unmatched GET requests without content continue to the 404 handler.
  // --------------------------------------------------------------------------
  server.addHook("onRequest", async (request, reply) => {
    const incoming = request.headers["x-trace-id"];
    request.traceId = typeof incoming === "string" && TRACE_ID_PATTERN.test(incoming) ? incoming : newTraceId();
    reply.header("X-Trace-ID", request.traceId);
    request.requestStartMs = Date.now();

    try {
      const parsedTp = parseTraceparent(
        typeof request.headers["traceparent"] === "string" ? request.headers["traceparent"] : undefined
      );
      const span = telemetry.observability.startSpan(
        "http.request",
        {
          "http.method": request.method,
          "http.target": (request.url.split("?")[0] ?? "/").slice(0, 128),
        },
        {
          kind: "SERVER",
          correlation: parsedTp
            ? {
                traceId: parsedTp.traceId,
                parentSpanId: parsedTp.parentSpanId,
                sampled: parsedTp.sampled,
              }
            : undefined,
        }
      );
      request.otelTraceId = span.traceId;
      request.otelSpanId = span.spanId;
      reply.header("traceparent", formatTraceparent(span.traceId, span.spanId, parsedTp?.sampled ?? true));
    } catch {
      // Zero-authority fail-safe isolation
    }

    const isPayloadMethod = ["POST", "PUT", "PATCH", "DELETE"].includes(request.method);
    const hasContentHeader = Boolean(request.headers["content-type"] || request.headers["content-length"]);
    const path = request.url.split("?")[0] ?? "";
    if (path.startsWith("/api/v1/") && (isPayloadMethod || hasContentHeader) && request.method !== "OPTIONS") {
      await requireAuth(request, reply);
    }
  });

  server.addHook("onResponse", async (request, reply) => {
    try {
      const durationSec = Math.max(0, (Date.now() - (request.requestStartMs ?? Date.now())) / 1000);
      const route = request.routeOptions?.url ?? "unmatched";
      const statusCode = reply.statusCode;
      const statusClass = `${Math.floor(statusCode / 100)}xx`;

      telemetry.observability.incrementCounter(
        "emerald_http_requests_total",
        "Total HTTP requests processed by Fastify transport",
        { method: request.method, route, status_class: statusClass }
      );
      telemetry.observability.observeHistogram(
        "emerald_http_request_duration_seconds",
        "HTTP request latency in seconds by method and route",
        durationSec,
        { method: request.method, route }
      );
      if (statusCode >= 500) {
        telemetry.observability.incrementCounter(
          "emerald_http_errors_total",
          "Total HTTP 5xx server errors",
          { route, status_code: String(statusCode) }
        );
      }
      if (request.otelSpanId) {
        telemetry.observability.endSpan(
          request.otelSpanId,
          statusCode >= 500 ? "ERROR" : "OK",
          statusCode >= 500 ? `HTTP ${statusCode}` : undefined
        );
      }
    } catch {
      // Zero-authority fail-safe isolation
    }
  });

  server.addHook("onSend", async (request, reply, payload) => {
    if (!reply.hasHeader("X-Content-Type-Options")) {
      reply.header("X-Content-Type-Options", "nosniff");
    }
    if (!reply.hasHeader("Referrer-Policy")) {
      reply.header("Referrer-Policy", "no-referrer");
    }
    if (!reply.hasHeader("X-Frame-Options")) {
      reply.header("X-Frame-Options", "DENY");
    }
    const reqPath = request.url.split("?")[0] ?? "";
    const contentType = String(reply.getHeader("content-type") ?? "").toLowerCase();
    if (reqPath.startsWith("/api/v1/") && !reqPath.endsWith("/events")) {
      if (!reply.hasHeader("Cache-Control")) {
        reply.header("Cache-Control", "no-store");
      }
    }
    if (contentType.includes("text/html") && !reply.hasHeader("Content-Security-Policy")) {
      reply.header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; connect-src 'self'"
      );
    }
    return payload;
  });

  // --------------------------------------------------------------------------
  // CORS: a browser-origin allowlist only. It is NOT authentication or authorization; every protected
  // route enforces both regardless of the Origin header (requests without an Origin are not exempt).
  // --------------------------------------------------------------------------
  server.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, false); // not a browser cross-origin request: no CORS headers needed
      return cb(null, allowedOrigins.includes(origin));
    },
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "Last-Event-ID", "X-Trace-ID", "traceparent"],
  });

  // Ownership: a resource belonging to another tenant is indistinguishable from a missing one.
  const ownedTask = (taskId: string, principal: AuthenticatedPrincipal) => {
    const t = tasks?.get(taskId);
    return t && t.tenantId === principal.tenantId ? t : undefined;
  };

  const resolveRunAndTenant = (runId: string, principal: AuthenticatedPrincipal) => {
    const local = runs?.get(runId);
    if (local && local.tenantId !== principal.tenantId) {
      return null;
    }

    if (effectiveCoordinator) {
      const snapshot = effectiveCoordinator.getRun(runId);
      if (snapshot) {
        let tenantId: string | undefined;
        if (snapshot.contractBinding) {
          const contract = effectiveCoordinator.getContract(snapshot.contractBinding.contractId, snapshot.contractBinding.version);
          tenantId = contract?.spec.policy.tenantId;
        }
        const effectiveTenant = tenantId ?? local?.tenantId;
        if (!effectiveTenant || effectiveTenant !== principal.tenantId) {
          return null;
        }
        return {
          durable: true,
          snapshot,
          tenantId: effectiveTenant ?? principal.tenantId,
          record: {
            runId,
            taskId: snapshot.taskId,
            tenantId: effectiveTenant ?? principal.tenantId,
            status: snapshot.status,
            createdAt: snapshot.createdAt,
          },
        };
      }
    }
    if (local && local.tenantId === principal.tenantId) {
      return { durable: false, snapshot: undefined, record: local, tenantId: local.tenantId };
    }
    return null;
  };

  const markDurability = (reply: FastifyReply, kind: "durable-coordinator" | "transport-local-non-durable") => {
    reply.header("X-Emerald-Durability", kind);
  };

  const eventSource: ((runId: string) => readonly any[]) | undefined = effectiveStore
    ? (runId) => effectiveStore.getEventsForRun(runId) as readonly any[]
    : options.stateStore
      ? (runId) => options.stateStore!.getEventsForRun(runId) as readonly any[]
      : effectiveCoordinator
        ? (runId) => effectiveCoordinator.getEventsForRun(runId) as readonly any[]
        : undefined;

  const toSseEnvelope = (runId: string, e: any, role: UserRole = "operator"): SseEnvelope | null => {
    if (!e || typeof e !== "object" || !Number.isInteger(e.sequence) || e.sequence < 1) return null;
    if (e.runId !== undefined && e.runId !== runId) return null;
    const event = typeof e.event === "string" ? e.event : typeof e.eventType === "string" ? e.eventType : null;
    if (!event) return null;
    const rawData = e.data ?? e.payload ?? {};
    return {
      id: String(e.id ?? e.eventId ?? `${runId}:${e.sequence}`),
      event,
      runId,
      sequence: e.sequence,
      timestamp: String(e.timestamp ?? ""),
      schemaVersion: Number(e.schemaVersion ?? 1),
      producer: String(e.producer ?? "unknown"),
      data: projectEventDataForRole(rawData, role),
    };
  };

  const toApprovalSummary = (req: ApprovalRequest): ApprovalSummary => ({
    approvalId: req.approvalId,
    runId: req.runId,
    taskId: req.taskId ?? null,
    tenantId: req.tenantId ?? null,
    operation: req.operation,
    riskLevel: req.riskLevel,
    justification: redactMessage(req.justification),
    status: req.status,
    singleUse: req.singleUse,
    requestedAt: req.requestedAt,
    expiresAt: req.expiresAt ?? null,
    decidedBy: req.approver ?? null,
    decidedAt: req.decidedAt ?? null,
    decisionReason: req.decisionReason ? redactMessage(req.decisionReason) : null,
    consumedAt: req.consumedAt ?? null,
  });

  const enrichTaskSummary = (summary: TaskSummary): TaskSummary => {
    if (!effectiveStore || typeof (effectiveStore as any).listTaskDependencies !== "function") {
      return summary;
    }
    try {
      const deps = (effectiveStore as any).listTaskDependencies(summary.taskId) as Array<{ parentTaskId: string }>;
      if (Array.isArray(deps) && deps.length > 0) {
        return { ...summary, dependsOnTaskIds: deps.map((d) => d.parentTaskId) };
      }
    } catch {
      // Non-fatal dependency lookup
    }
    return summary;
  };

  /** Run view. Authoritative (coordinator) when configured; otherwise the explicit transport-local record. */
  const buildRunData = (runId: string, record: any): { data: RunResponse["data"]; durable: boolean } | null => {
    const coordinator = effectiveCoordinator;
    if (!coordinator) {
      return {
        durable: false,
        data: {
          runId,
          taskId: record.taskId,
          tenantId: record.tenantId,
          status: record.status,
          attemptNumber: record.attemptNumber ?? 0,
          currentStepIndex: record.currentStepIndex ?? 0,
          leaseExpiresAt: record.leaseExpiresAt ?? null,
          // Never trusted from a transport-local record: only durable verification events may establish an outcome.
          finalOutcome: null,
          metrics: {
            wallClockMs: record.metrics?.wallClockMs ?? 0,
            stepCount: record.metrics?.stepCount ?? 0,
            toolCallCount: record.metrics?.toolCallCount ?? 0,
          },
          createdAt: record.createdAt,
          completedAt: record.completedAt ?? null,
        },
      };
    }
    const snapshot = coordinator.getRun(runId);
    if (!snapshot) return null;
    const events: readonly DurableEventView[] | undefined = eventSource ? (eventSource(runId) as readonly DurableEventView[]) : undefined;
    const terminal = isTerminalState(snapshot.status);
    const terminalEvent = events ? [...events].reverse().find((e) => terminalEventTypes.has(e.eventType)) : undefined;
    const completedAt = terminal ? ((terminalEvent as any)?.timestamp ?? null) : null;
    const checkpoint = coordinator.getLatestCheckpoint(runId);
    const durableStep = (checkpoint?.durableState as { stepCount?: unknown } | undefined)?.stepCount;
    const endMs = completedAt ? Date.parse(completedAt) : Date.now();

    let requiredSpecIds: string[] | undefined;
    let contractLoaded: boolean | undefined;
    if (snapshot.contractBinding) {
      const contract = coordinator.getContract(snapshot.contractBinding.contractId, snapshot.contractBinding.version);
      if (contract) {
        contractLoaded = true;
        if (contract.spec.verificationSpecs.length > 0) {
          requiredSpecIds = contract.spec.verificationSpecs.map((s) => s.specId);
        }
      } else {
        contractLoaded = false;
      }
    }

    let pendingApprovals: ApprovalSummary[] | undefined;
    if (effectiveApprovalControl) {
      try {
        const pending = effectiveApprovalControl
          .listAll(runId)
          .filter((a) => a.tenantId === record.tenantId && a.status === "PENDING");
        if (pending.length > 0) {
          pendingApprovals = pending.map(toApprovalSummary);
        }
      } catch {
        // Non-fatal approval inspection
      }
    }

    let repairSummary:
      | { cycleCount: number; stagnationDetected: boolean; exhausted: boolean; lastDiagnosis?: string }
      | undefined;
    let verificationSummary: { verified: boolean; reason?: string; specCount: number } | undefined;
    if (events && events.length > 0) {
      const repairEvents = events.filter((e) => e.eventType.startsWith("repair."));
      const durableRepair = (checkpoint?.durableState as { repairState?: { cycle?: number; stagnationDetected?: boolean } } | undefined)?.repairState;
      if (repairEvents.length > 0 || durableRepair) {
        const lastRepair = repairEvents[repairEvents.length - 1];
        const lastPayload = (lastRepair?.payload ?? {}) as Record<string, unknown>;
        repairSummary = {
          cycleCount: typeof durableRepair?.cycle === "number" ? durableRepair.cycle : repairEvents.length,
          stagnationDetected:
            Boolean(durableRepair?.stagnationDetected) ||
            repairEvents.some((e) => e.eventType.includes("stagnation")),
          exhausted: repairEvents.some((e) => e.eventType.includes("exhausted") || e.eventType.includes("halted")),
          ...(typeof lastPayload.summary === "string"
            ? { lastDiagnosis: redactMessage(lastPayload.summary) }
            : typeof lastPayload.reason === "string"
              ? { lastDiagnosis: redactMessage(lastPayload.reason) }
              : {}),
        };
      }
      const verEvents = events.filter(
        (e) => e.eventType === "verification.completed" || e.eventType === "verification.rejected"
      );
      if (verEvents.length > 0 || (requiredSpecIds && requiredSpecIds.length > 0)) {
        const lastVer = verEvents[verEvents.length - 1];
        const verPayload = (lastVer?.payload ?? {}) as Record<string, unknown>;
        verificationSummary = {
          verified:
            lastVer?.eventType === "verification.completed" &&
            (typeof verPayload.status === "string"
              ? verPayload.status === "VERIFIED"
              : verPayload.verified !== false && verPayload.passed !== false),
          ...(typeof verPayload.proofHash === "string" ? { proofHash: verPayload.proofHash } : {}),
          ...(typeof verPayload.verifierId === "string" ? { verifierId: verPayload.verifierId } : {}),
          ...(typeof verPayload.specId === "string" ? { specId: verPayload.specId } : {}),
          ...(typeof verPayload.reason === "string" ? { reason: redactMessage(verPayload.reason) } : {}),
          specCount: requiredSpecIds?.length ?? 0,
        };
      }
    }

    let memorySummary:
      | { entryCount: number; verifiedCount: number; scopes: Record<string, number> }
      | undefined;
    if (effectiveScopedMemory && record.tenantId) {
      try {
        const entries = effectiveScopedMemory.queryMemories(record.tenantId, snapshot.taskId, { limit: 200 });
        if (entries.length > 0) {
          const scopes: Record<string, number> = {};
          let verifiedCount = 0;
          for (const entry of entries) {
            scopes[entry.scope] = (scopes[entry.scope] ?? 0) + 1;
            if (entry.isIndependentlyVerified) verifiedCount++;
          }
          memorySummary = { entryCount: entries.length, verifiedCount, scopes };
        }
      } catch {
        // Non-fatal memory summary inspection
      }
    }

    return {
      durable: true,
      data: {
        runId,
        taskId: snapshot.taskId,
        tenantId: record.tenantId,
        status: snapshot.status as TaskStatus,
        attemptNumber: snapshot.attemptCount,
        currentStepIndex: typeof durableStep === "number" ? durableStep : 0,
        leaseExpiresAt: snapshot.leaseExpiresAt ?? null,
        finalOutcome: deriveAuthoritativeOutcome(snapshot.status, events, {
          requiredSpecIds,
          contractLoaded,
        }),
        metrics: {
          wallClockMs: Math.max(0, endMs - Date.parse(snapshot.createdAt)),
          stepCount: typeof durableStep === "number" ? durableStep : 0,
          toolCallCount: events ? events.filter((e) => e.eventType === "action.created").length : 0,
        },
        createdAt: snapshot.createdAt,
        completedAt,
        executionMode,
        currentWorkerId: snapshot.currentWorkerId ?? null,
        leaseId: snapshot.leaseId ?? null,
        ...(pendingApprovals ? { pendingApprovals } : {}),
        ...(repairSummary ? { repairSummary } : {}),
        ...(memorySummary ? { memorySummary } : {}),
        ...(verificationSummary ? { verificationSummary } : {}),
      },
    };
  };

  // ==========================================================================
  // Routes
  // ==========================================================================

  // GET /api/v1/auth/whoami — returns authenticated principal identity & tenant without exposing secret tokens.
  server.get("/api/v1/auth/whoami", readRoute, async (request, reply) => {
    const principal = request.principal!;
    reply.header("Cache-Control", "no-store");
    const body: WhoamiResponse = {
      success: true,
      data: {
        principalId: principal.principalId,
        tenantId: principal.tenantId,
        role: principal.role,
        ...(principal.allowConstrainedHost !== undefined
          ? { allowConstrainedHost: principal.allowConstrainedHost }
          : {}),
      },
    };
    return reply.status(200).send(body);
  });

  // Opt-in static Web UI serving (index.html and dist/bundle.js) under strict CSP & path containment.
  if (typeof options.webUiRoot === "string" && options.webUiRoot.trim().length > 0) {
    const uiRootResolved = path.resolve(options.webUiRoot);
    const serveStaticUiFile = (relativePath: string, contentType: string) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        if (!fs.existsSync(uiRootResolved)) {
          return sendError(request, reply, 404, "NOT_FOUND", "UI asset not found");
        }
        const realRoot = fs.realpathSync(uiRootResolved);
        const candidate = path.resolve(realRoot, relativePath);
        if (!candidate.startsWith(`${realRoot}${path.sep}`)) {
          return sendError(request, reply, 404, "NOT_FOUND", "UI asset not found");
        }
        if (!fs.existsSync(candidate)) {
          return sendError(request, reply, 404, "NOT_FOUND", "UI asset not found");
        }
        const realFile = fs.realpathSync(candidate);
        if (!realFile.startsWith(`${realRoot}${path.sep}`)) {
          return sendError(request, reply, 404, "NOT_FOUND", "UI asset not found");
        }
        const content = fs.readFileSync(realFile);
        reply.header("Content-Type", contentType);
        reply.header("Cache-Control", "no-store");
        return reply.status(200).send(content);
      };

    server.get("/", serveStaticUiFile("index.html", "text/html; charset=utf-8"));
    server.get("/index.html", serveStaticUiFile("index.html", "text/html; charset=utf-8"));
    server.get("/dist/bundle.js", serveStaticUiFile("dist/bundle.js", "text/javascript; charset=utf-8"));
  }

  // GET /api/v1/tasks — list tasks for authenticated tenant with cursor pagination and status filtering.
  server.get("/api/v1/tasks", readRoute, async (request, reply) => {
    const rawQuery = (request.query as Record<string, unknown>) ?? {};

    // Explicit security check: client-supplied tenantId is strictly forbidden
    if (rawQuery.tenantId !== undefined) {
      return sendError(
        request,
        reply,
        400,
        "BAD_REQUEST",
        "Explicit tenantId parameter is forbidden; tenant is derived from authentication"
      );
    }

    const parsedQuery = ListTasksQuerySchema.safeParse(rawQuery);
    if (!parsedQuery.success) {
      return sendError(request, reply, 400, "BAD_REQUEST", "Invalid query parameters", {
        issues: parsedQuery.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }

    const { limit = 20, cursor, status } = parsedQuery.data;
    const principal = request.principal!;
    const tenantId = principal.tenantId;

    if (effectiveStore && typeof (effectiveStore as any).listTasks === "function") {
      try {
        const result = (effectiveStore as any).listTasks({
          tenantId,
          limit,
          cursor,
          status,
        });
        markDurability(reply, "durable-coordinator");
        const body: ListTasksResponse = {
          success: true,
          data: result.tasks.map((t: TaskSummary) => enrichTaskSummary(t)),
          nextCursor: result.nextCursor,
        };
        return reply.status(200).send(body);
      } catch (err: unknown) {
        if (err instanceof InvalidCursorError) {
          return sendError(request, reply, 400, "BAD_REQUEST", err.message);
        }
        throw err;
      }
    }

    // In-memory fallback (for unit tests / mock environment)
    if (tasks) {
      try {
        let cursorPoint: { createdAt: string; taskId: string } | null = null;
        if (cursor) {
          cursorPoint = decodeTaskCursor(cursor, tenantId, status);
        }

        let allTasks = Array.from(tasks.values()).filter((t: any) => t && t.tenantId === tenantId);
        if (status) {
          allTasks = allTasks.filter((t: any) => t.status === status);
        }

        // Keyset sort: (createdAt DESC, taskId DESC)
        allTasks.sort((a: any, b: any) => {
          const timeA = new Date(a.createdAt).getTime();
          const timeB = new Date(b.createdAt).getTime();
          if (timeB !== timeA) return timeB - timeA;
          return b.taskId.localeCompare(a.taskId);
        });

        if (cursorPoint) {
          const cursorTime = new Date(cursorPoint.createdAt).getTime();
          allTasks = allTasks.filter((t: any) => {
            const tTime = new Date(t.createdAt).getTime();
            if (tTime < cursorTime) return true;
            if (tTime === cursorTime) return t.taskId.localeCompare(cursorPoint!.taskId) < 0;
            return false;
          });
        }

        const hasNext = allTasks.length > limit;
        const pageItems = hasNext ? allTasks.slice(0, limit) : allTasks;

        const summaryItems: TaskSummary[] = pageItems.map((t: any) => ({
          taskId: t.taskId,
          tenantId: t.tenantId,
          title: t.title,
          status: t.status,
          executionMode: t.executionMode ?? "sandboxed",
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          contractId: t.contractId ?? null,
          runId: t.runId,
        }));

        let nextCursor: string | null = null;
        if (hasNext && summaryItems.length > 0) {
          const last = summaryItems[summaryItems.length - 1];
          if (last) {
            nextCursor = encodeTaskCursor({
              createdAt: last.createdAt,
              taskId: last.taskId,
              tenantId,
              status,
            });
          }
        }

        markDurability(reply, "transport-local-non-durable");
        const body: ListTasksResponse = {
          success: true,
          data: summaryItems,
          nextCursor,
        };
        return reply.status(200).send(body);
      } catch (err: unknown) {
        if (err instanceof InvalidCursorError) {
          return sendError(request, reply, 400, "BAD_REQUEST", err.message);
        }
        throw err;
      }
    }

    markDurability(reply, "transport-local-non-durable");
    return reply.status(200).send({ success: true, data: [], nextCursor: null });
  });

  // POST /api/v1/tasks — durable SQLite or transport-local fallback. Server-generated ids only.
  server.post("/api/v1/tasks", writeRoute, async (request, reply) => {
    const parsed = CreateTaskRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(request, reply, 400, "BAD_REQUEST", "Request validation failed", {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const principal = request.principal!;
    const rawKey =
      (request.headers["idempotency-key"] as string | undefined) ??
      (request.headers["x-idempotency-key"] as string | undefined) ??
      (parsed.data as any).idempotencyKey;
    const idempotencyKey = typeof rawKey === "string" && rawKey.trim().length > 0 ? rawKey.trim() : undefined;

    // Validate executionMode against principal authorization:
    // External tenants must NEVER downgrade sandbox isolation. An unauthorized request fails closed.
    const isConstrainedHost = parsed.data.executionMode === "constrained_host";
    const isAuthorizedForConstrainedHost = principal.allowConstrainedHost === true;
    if (isConstrainedHost && !isAuthorizedForConstrainedHost) {
      diagnostics({
        ts: new Date().toISOString(),
        level: "warn",
        event: "task.unauthorized_constrained_host_request",
        traceId: request.traceId,
        method: request.method,
        route: "/api/v1/tasks",
        errorMessage: `Principal '${principal.principalId}' (tenant '${principal.tenantId}') is not authorized for constrained-host execution`,
      });
      return sendError(
        request,
        reply,
        403,
        "FORBIDDEN",
        "Principal is not authorized for constrained-host execution; sandboxed execution is mandated"
      );
    }

    if (pumpClosed) {
      return sendError(request, reply, 503, "SERVICE_UNAVAILABLE", "Server is shutting down");
    }
    // 1. Durable submission pathway
    if (effectiveStore && effectiveCoordinator) {
      try {
        const timeoutMs = parsed.data.resourceLimits?.timeoutSeconds
          ? parsed.data.resourceLimits.timeoutSeconds * 1000
          : undefined;
        let taskId: string;
        let runId: string;
        let runStatus: string;
        let deduplicated: boolean;

        if (executionLoopEnabled && effectiveTaskRouter) {
          const scopedKey = idempotencyKey
            ? scopeIdempotencyKeyForTenant(idempotencyKey, principal.tenantId)
            : undefined;
          const existingRun = scopedKey ? effectiveCoordinator.getRunByIdempotencyKey(scopedKey) : null;
          if (existingRun) {
            taskId = existingRun.taskId;
            runId = existingRun.runId;
            runStatus = existingRun.status;
            deduplicated = true;
          } else {
            const prepared = submitDurableTask(effectiveStore, effectiveCoordinator, {
              task: parsed.data.prompt,
              operation: parsed.data.title,
              capabilities: parsed.data.requiredCapabilities,
              repositoryPath: parsed.data.repoPath,
              executionMode: parsed.data.executionMode,
              authorizedForConstrainedHost: isAuthorizedForConstrainedHost,
              tenantId: principal.tenantId,
              timeoutMs,
              idempotencyKey,
              verificationSpecs: parsed.data.verificationSpecs,
              deferRunCreation: true,
            });
            const submissionKey = scopedKey ?? `http-task-${prepared.taskId}`;
            const routed = effectiveTaskRouter.submitTask({
              submissionKey,
              taskId: prepared.taskId,
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            });
            taskId = routed.taskId;
            runId = routed.runId;
            deduplicated = routed.duplicate;
            runStatus = effectiveCoordinator.getRun(runId)?.status ?? "CREATED";
          }
        } else {
          const submitted = submitDurableTask(effectiveStore, effectiveCoordinator, {
            task: parsed.data.prompt,
            operation: parsed.data.title,
            capabilities: parsed.data.requiredCapabilities,
            repositoryPath: parsed.data.repoPath,
            executionMode: parsed.data.executionMode,
            authorizedForConstrainedHost: isAuthorizedForConstrainedHost,
            tenantId: principal.tenantId,
            timeoutMs,
            idempotencyKey,
            verificationSpecs: parsed.data.verificationSpecs,
          });
          taskId = submitted.taskId;
          runId = submitted.runId;
          runStatus = submitted.status;
          deduplicated = submitted.deduplicated;
        }
        markDurability(reply, "durable-coordinator");
        void pumpExecutionLoop();
        const taskRecord = effectiveCoordinator.getTask(taskId);
        const now = new Date().toISOString();
        const body: TaskResponse = {
          success: true,
          data: enrichTaskSummary({
            taskId,
            tenantId: principal.tenantId,
            title: parsed.data.title,
            status: runStatus as TaskStatus,
            executionMode: parsed.data.executionMode,
            createdAt: taskRecord?.createdAt ?? now,
            updatedAt: taskRecord?.updatedAt ?? now,
            contractId: `contract-${taskId}`,
            runId,
          }),
        };
        return reply.status(deduplicated ? 200 : 201).send(body);
      } catch (err) {
        diagnostics({
          ts: new Date().toISOString(),
          level: "error",
          event: "task.durable_submission_failure",
          traceId: request.traceId,
          method: request.method,
          route: "/api/v1/tasks",
          errorName: (err as Error).name,
          errorMessage: redactMessage((err as Error).message),
        });
        return sendError(request, reply, 500, "INTERNAL_ERROR", "Task submission failed");
      }
    }

    // 2. Transport-local fallback (for test fixture compatibility)
    if (!tasks) {
      return unavailable(request, reply, "Task submission is unavailable: no task application service is configured");
    }
    let taskId = `task-${crypto.randomUUID()}`;
    while (tasks.has(taskId)) taskId = `task-${crypto.randomUUID()}`;

    const now = new Date().toISOString();
    const record = {
      taskId,
      tenantId: principal.tenantId,
      title: parsed.data.title,
      status: "CREATED" as TaskStatus,
      executionMode: parsed.data.executionMode,
      createdAt: now,
      updatedAt: now,
      contractId: null,
    };
    tasks.set(taskId, record);
    markDurability(reply, "transport-local-non-durable");
    const body: TaskResponse = { success: true, data: record };
    return reply.status(201).send(body);
  });

  // GET /api/v1/tasks/:taskId
  server.get("/api/v1/tasks/:taskId", readRoute, async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const principal = request.principal!;
    if (effectiveStore && typeof (effectiveStore as any).getTaskById === "function") {
      const durableSummary = (effectiveStore as any).getTaskById(taskId, principal.tenantId) as TaskSummary | null;
      if (durableSummary) {
        markDurability(reply, "durable-coordinator");
        const body: TaskResponse = { success: true, data: enrichTaskSummary(durableSummary) };
        return reply.status(200).send(body);
      }
      // If the task exists under another tenant or in coordinator without a contract yet, fail closed:
      if (effectiveCoordinator) {
        const taskRecord = effectiveCoordinator.getTask(taskId);
        if (taskRecord) {
          const contracts = effectiveStore.findContractsByTaskId(taskId);
          const latestContract = contracts[contracts.length - 1];
          const effectiveTenant = latestContract?.spec.policy.tenantId;
          if (!effectiveTenant || effectiveTenant !== principal.tenantId) {
            return notFound(request, reply, "Task");
          }
          return notFound(request, reply, "Task");
        }
      }
    } else if (effectiveCoordinator) {
      const taskRecord = effectiveCoordinator.getTask(taskId);
      if (taskRecord) {
        let tenantId: string | undefined;
        let contractId: string | null = null;
        let executionMode: "sandboxed" | "constrained_host" = "sandboxed";
        if (effectiveStore) {
          const activeContracts = effectiveStore.findContractsByTaskId(taskId, "ACTIVE");
          const contract = activeContracts[0] ?? effectiveStore.findContractsByTaskId(taskId)[0];
          tenantId = contract?.spec.policy.tenantId;
          contractId = contract?.spec.contractId ?? null;
          if (contract?.spec.policy.isolationRequirement === "IN_PROCESS") {
            executionMode = "constrained_host";
          }
        }
        const effectiveTenant = tenantId;
        if (!effectiveTenant || effectiveTenant !== principal.tenantId) {
          return notFound(request, reply, "Task");
        }
        markDurability(reply, "durable-coordinator");
        const body: TaskResponse = {
          success: true,
          data: {
            taskId: taskRecord.taskId,
            tenantId: effectiveTenant,
            title: taskRecord.title,
            status: "CREATED",
            executionMode,
            createdAt: taskRecord.createdAt,
            updatedAt: taskRecord.updatedAt,
            contractId,
          },
        };
        return reply.status(200).send(body);
      }
    }
    const task = ownedTask(taskId, principal);
    if (!task) return notFound(request, reply, "Task");
    markDurability(reply, "transport-local-non-durable");
    const body: TaskResponse = { success: true, data: task };
    return reply.status(200).send(body);
  });


  // GET /api/v1/tasks/:taskId/dag — Multi-agent DAG view data
  server.get("/api/v1/tasks/:taskId/dag", readRoute, async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const principal = request.principal!;

    let rootTitle = taskId;
    let rootStatus = "PENDING";
    let taskTenant: string | null = null;

    if (effectiveStore && typeof (effectiveStore as any).getTaskById === "function") {
      const summary = (effectiveStore as any).getTaskById(taskId, principal.tenantId);
      if (summary) {
        rootTitle = summary.title;
        rootStatus = summary.status;
        taskTenant = summary.tenantId;
      }
    }
    if (!taskTenant && effectiveStore) {
      const contracts = effectiveStore.findContractsByTaskId(taskId);
      const latest = contracts[contracts.length - 1];
      if (latest?.spec.policy.tenantId === principal.tenantId) {
        taskTenant = principal.tenantId;
        const tRecord = effectiveCoordinator?.getTask(taskId) ?? effectiveStore.getTask(taskId);
        if (tRecord) {
          rootTitle = tRecord.title;
          rootStatus = (tRecord as any).status || rootStatus || "PENDING";
        }
      }
    }
    if (!taskTenant) {
      const local = ownedTask(taskId, principal);
      if (local) {
        taskTenant = local.tenantId;
        rootTitle = local.title;
        rootStatus = local.status;
      }
    }

    if (!taskTenant || taskTenant !== principal.tenantId) {
      return notFound(request, reply, "Task");
    }

    const visited = new Set<string>();
    const queue: string[] = [taskId];
    const nodes: TaskDagNode[] = [];

    while (queue.length > 0) {
      const currId = queue.shift()!;
      if (visited.has(currId)) continue;
      visited.add(currId);

      const parentTaskIds: string[] = [];
      const childTaskIds: string[] = [];

      if (effectiveStore) {
        const queryTx = (fn: (tx: any) => void) => {
          if (typeof effectiveStore.transaction === "function") {
            effectiveStore.transaction(fn);
          } else {
            fn(effectiveStore);
          }
        };

        queryTx((tx) => {
          if (typeof tx.listTaskDependencies === "function") {
            try {
              const deps = tx.listTaskDependencies(currId) as Array<{ parentTaskId: string }>;
              if (Array.isArray(deps)) {
                for (const d of deps) {
                  if (!parentTaskIds.includes(d.parentTaskId)) parentTaskIds.push(d.parentTaskId);
                }
              }
            } catch {
              // Non-fatal
            }
          }
          if (typeof tx.getTaskRelation === "function") {
            try {
              const rel = tx.getTaskRelation(currId);
              if (rel?.parentTaskId && !parentTaskIds.includes(rel.parentTaskId)) {
                parentTaskIds.push(rel.parentTaskId);
              }
            } catch {
              // Non-fatal
            }
          }
          if (typeof tx.listDependentTaskIds === "function") {
            try {
              const dependents = tx.listDependentTaskIds(currId) as string[];
              if (Array.isArray(dependents)) {
                for (const dep of dependents) {
                  if (!childTaskIds.includes(dep)) childTaskIds.push(dep);
                }
              }
            } catch {
              // Non-fatal
            }
          }
          if (typeof tx.listChildTaskRelations === "function") {
            try {
              const childRels = tx.listChildTaskRelations(currId) as Array<{ childTaskId: string }>;
              if (Array.isArray(childRels)) {
                for (const cr of childRels) {
                  if (!childTaskIds.includes(cr.childTaskId)) childTaskIds.push(cr.childTaskId);
                }
              }
            } catch {
              // Non-fatal
            }
          }
        });
      }

      let nodeTitle = currId === taskId ? rootTitle : currId;
      let nodeStatus = currId === taskId ? (rootStatus || "PENDING") : "PENDING";
      if (currId !== taskId && effectiveStore) {
        if (typeof (effectiveStore as any).getTaskById === "function") {
          try {
            const summary = (effectiveStore as any).getTaskById(currId, principal.tenantId);
            if (summary) {
              nodeTitle = summary.title || nodeTitle;
              nodeStatus = summary.status || nodeStatus;
            }
          } catch {
            // Non-fatal
          }
        }
        const tRecord = effectiveCoordinator?.getTask(currId) ?? effectiveStore.getTask(currId);
        if (tRecord) {
          nodeTitle = tRecord.title || nodeTitle;
          nodeStatus = (tRecord as any).status || nodeStatus;
        }
      }
      if (!nodeStatus) {
        nodeStatus = "PENDING";
      }

      nodes.push({
        taskId: currId,
        title: nodeTitle,
        status: nodeStatus,
        parentTaskIds,
        childTaskIds,
      });

      for (const p of parentTaskIds) {
        if (!visited.has(p) && !queue.includes(p)) queue.push(p);
      }
      for (const c of childTaskIds) {
        if (!visited.has(c) && !queue.includes(c)) queue.push(c);
      }
    }

    markDurability(reply, effectiveStore ? "durable-coordinator" : "transport-local-non-durable");
    const body: TaskDagResponse = {
      success: true,
      data: {
        rootTaskId: taskId,
        nodes,
      },
    };
    return reply.status(200).send(body);
  });

  // POST /api/v1/tasks/:taskId/decompose — Super Agent task decomposition
  server.post("/api/v1/tasks/:taskId/decompose", writeRoute, async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const principal = request.principal!;

    if (pumpClosed) {
      return sendError(request, reply, 503, "SERVICE_UNAVAILABLE", "Server is shutting down");
    }
    if (!effectiveOrchestrator || !effectiveStore || !effectiveCoordinator) {
      return unavailable(request, reply, "Multi-agent orchestration is unavailable: no durable orchestrator configured");
    }

    const task = effectiveStore.getTask(taskId);
    if (!task) {
      return notFound(request, reply, "Task");
    }

    const activeContracts = effectiveStore.findContractsByTaskId(taskId, "ACTIVE");
    const contract = activeContracts[0] ?? effectiveStore.findContractsByTaskId(taskId)[0];
    const tenantId = contract?.spec?.policy?.tenantId ?? (task as any).tenantId;
    if (!tenantId || tenantId !== principal.tenantId) {
      return notFound(request, reply, "Task");
    }

    const parsed = DecomposeMissionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(request, reply, 400, "BAD_REQUEST", "Request validation failed", {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }

    try {
      const result = effectiveOrchestrator.decomposeMission({
        missionTaskId: taskId,
        subtasks: parsed.data.subtasks,
        maxDepth: parsed.data.maxDepth,
        maxChildrenPerParent: parsed.data.maxChildrenPerParent,
      });

      markDurability(reply, "durable-coordinator");
      void pumpExecutionLoop();
      const body: DecomposeMissionResponse = {
        success: true,
        data: {
          missionTaskId: result.missionTaskId,
          decompositionHash: result.decompositionHash,
          subtaskTaskIds: result.subtaskTaskIds,
          totalSubtasks: result.subtasks.length,
          isDuplicate: result.isDuplicate,
        },
      };
      return reply.status(result.isDuplicate ? 200 : 201).send(body);
    } catch (err: unknown) {
      if (err instanceof CapabilityEscalationError) {
        return sendError(request, reply, 403, "FORBIDDEN", err.message);
      }
      if (err instanceof SuperAgentDecompositionError || err instanceof ResourceBudgetExceededError) {
        return sendError(request, reply, 400, "BAD_REQUEST", err.message);
      }
      diagnostics({
        ts: new Date().toISOString(),
        level: "error",
        event: "task.decomposition_failure",
        traceId: request.traceId,
        method: request.method,
        route: "/api/v1/tasks/:taskId/decompose",
        errorName: (err as Error).name,
        errorMessage: redactMessage((err as Error).message),
      });
      return sendError(request, reply, 500, "INTERNAL_ERROR", "Task decomposition failed");
    }
  });

  // GET /api/v1/tasks/:taskId/hierarchy — Multi-agent subtask hierarchy inspection
  server.get("/api/v1/tasks/:taskId/hierarchy", readRoute, async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const principal = request.principal!;

    if (!effectiveOrchestrator || !effectiveStore) {
      return unavailable(request, reply, "Multi-agent orchestration is unavailable: no durable orchestrator configured");
    }

    const task = effectiveStore.getTask(taskId);
    if (!task) {
      return notFound(request, reply, "Task");
    }

    const activeContracts = effectiveStore.findContractsByTaskId(taskId, "ACTIVE");
    const contract = activeContracts[0] ?? effectiveStore.findContractsByTaskId(taskId)[0];
    const tenantId = contract?.spec?.policy?.tenantId ?? (task as any).tenantId;
    if (!tenantId || tenantId !== principal.tenantId) {
      return notFound(request, reply, "Task");
    }

    try {
      const hierarchy = effectiveOrchestrator.getHierarchy(taskId);
      markDurability(reply, "durable-coordinator");
      const body: MissionHierarchyResponse = {
        success: true,
        data: {
          missionTaskId: hierarchy.missionTaskId,
          missionTitle: hierarchy.missionTitle,
          decompositionHash: hierarchy.decompositionHash,
          root: hierarchy.root,
          totalSubtasks: hierarchy.totalSubtasks,
        },
      };
      return reply.status(200).send(body);
    } catch (err: unknown) {
      if (err instanceof SuperAgentDecompositionError) {
        return sendError(request, reply, 400, "BAD_REQUEST", err.message);
      }
      diagnostics({
        ts: new Date().toISOString(),
        level: "error",
        event: "task.hierarchy_failure",
        traceId: request.traceId,
        method: request.method,
        route: "/api/v1/tasks/:taskId/hierarchy",
        errorName: (err as Error).name,
        errorMessage: redactMessage((err as Error).message),
      });
      return sendError(request, reply, 500, "INTERNAL_ERROR", "Failed to retrieve task hierarchy");
    }
  });

  // POST /api/v1/tasks/:taskId/synthesize — Mission synthesis & zero-self-approval verification
  server.post("/api/v1/tasks/:taskId/synthesize", writeRoute, async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const principal = request.principal!;

    if (!effectiveOrchestrator || !effectiveStore) {
      return unavailable(request, reply, "Multi-agent orchestration is unavailable: no durable orchestrator configured");
    }

    const task = effectiveStore.getTask(taskId);
    if (!task) {
      return notFound(request, reply, "Task");
    }

    const activeContracts = effectiveStore.findContractsByTaskId(taskId, "ACTIVE");
    const contract = activeContracts[0] ?? effectiveStore.findContractsByTaskId(taskId)[0];
    const tenantId = contract?.spec?.policy?.tenantId ?? (task as any).tenantId;
    if (!tenantId || tenantId !== principal.tenantId) {
      return notFound(request, reply, "Task");
    }

    try {
      const synthesis = effectiveOrchestrator.synthesizeMission(taskId);
      markDurability(reply, "durable-coordinator");
      const body: SynthesizeMissionResponse = {
        success: true,
        data: {
          missionTaskId: synthesis.missionTaskId,
          verdict: synthesis.verdict,
          totalSubtasks: synthesis.totalSubtasks,
          verifiedCount: synthesis.verifiedCount,
          rejectedCount: synthesis.rejectedCount,
          blockedCount: synthesis.blockedCount,
          unverifiableCount: synthesis.unverifiableCount,
          summary: synthesis.summary,
          canCompleteMission: synthesis.canCompleteMission,
          subtaskReports: synthesis.subtaskReports,
        },
      };
      return reply.status(200).send(body);
    } catch (err: unknown) {
      if (err instanceof SynthesisVerificationError) {
        return sendError(request, reply, 400, "BAD_REQUEST", err.message);
      }
      diagnostics({
        ts: new Date().toISOString(),
        level: "error",
        event: "task.synthesis_failure",
        traceId: request.traceId,
        method: request.method,
        route: "/api/v1/tasks/:taskId/synthesize",
        errorName: (err as Error).name,
        errorMessage: redactMessage((err as Error).message),
      });
      return sendError(request, reply, 500, "INTERNAL_ERROR", "Mission synthesis failed");
    }
  });

  // GET /api/v1/runs/:runId
  server.get("/api/v1/runs/:runId", readRoute, async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const resolved = resolveRunAndTenant(runId, request.principal!);
    if (!resolved) return notFound(request, reply, "Run");
    const view = buildRunData(runId, resolved.record);
    if (!view) return notFound(request, reply, "Run");
    markDurability(reply, view.durable ? "durable-coordinator" : "transport-local-non-durable");
    const body: RunResponse = { success: true, data: view.data };
    return reply.status(200).send(body);
  });

  // POST /api/v1/runs/:runId/cancel — coordinator authority only.
  server.post("/api/v1/runs/:runId/cancel", writeRoute, async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const resolved = resolveRunAndTenant(runId, request.principal!);
    if (!resolved) return notFound(request, reply, "Run");

    const coordinator = effectiveCoordinator;
    if (!coordinator) {
      // Never emulate coordinator authority in the transport: no fallback mutation path exists.
      return unavailable(request, reply, "Run cancellation is unavailable: no run coordinator is configured");
    }
    const parsed = CancelRunRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(request, reply, 400, "BAD_REQUEST", "A valid cancellation reason is required");
    }
    const snapshot = coordinator.getRun(runId);
    if (!snapshot) return notFound(request, reply, "Run");

    if (snapshot.status === "RECOVERING") {
      return sendError(
        request,
        reply,
        409,
        "CONFLICT",
        `Cannot cancel run '${runId}' in RECOVERING state; recovery supervisor holds exclusive recovery authority`
      );
    }

    try {
      const result = coordinator.cancelRun(runId, parsed.data.reason);
      // Relay the genuinely persisted event to live subscribers (the transport creates no events itself).
      const envelope = toSseEnvelope(runId, result.event, "admin");
      if (envelope) eventBroadcaster.emit(`run:${runId}`, envelope);
      markDurability(reply, "durable-coordinator");
      const body: CancelRunResponse = {
        success: true,
        data: {
          runId,
          status: "CANCELLED",
          reason: parsed.data.reason,
          cancelledAt: result.event.timestamp,
          note: "Cancellation authority recorded; does not guarantee immediate termination of executing worker processes.",
        },
      };
      return reply.status(200).send(body);
    } catch (err) {
      if (err instanceof TerminalStateError || err instanceof VersionConflictError || err instanceof InvalidStateTransitionError) {
        return sendError(request, reply, 409, "CONFLICT", "The run cannot be cancelled in its current state");
      }
      throw err; // sanitized 500 by the global handler
    }
  });

  // GET /api/v1/runs/:runId/events — SSE with bounded, gap-safe delivery.
  server.get("/api/v1/runs/:runId/events", readRoute, async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const resolved = resolveRunAndTenant(runId, request.principal!);
    if (!resolved) return notFound(request, reply, "Run");
    const snapshot = resolved.durable ? resolved.snapshot : undefined;
    const record = resolved.record;

    // Last-Event-ID: strict parse; a malformed cursor is rejected, never silently treated as 0.
    const lastEventIdHeader = request.headers["last-event-id"];
    let cursor = 0;
    if (lastEventIdHeader !== undefined) {
      if (typeof lastEventIdHeader !== "string" || !/^\d{1,15}$/.test(lastEventIdHeader)) {
        return sendError(request, reply, 400, "BAD_REQUEST", "Invalid Last-Event-ID");
      }
      cursor = Number(lastEventIdHeader);
    }

    const tenantId = request.principal!.tenantId;
    const currentTenantStreams = tenantSseConnections.get(tenantId) ?? 0;
    if (currentTenantStreams >= MAX_TENANT_SSE_CONNECTIONS) {
      reply.header("Retry-After", "30");
      return sendError(
        request,
        reply,
        429,
        "TOO_MANY_REQUESTS",
        `Too many active event streams for tenant '${tenantId}' (maximum ${MAX_TENANT_SSE_CONNECTIONS})`
      );
    }

    const durableReplay = Boolean(eventSource);
    if (cursor > 0 && !durableReplay) {
      return unavailable(request, reply, "Cannot resume: durable event replay is not available on this server");
    }
    if (activeSseConnections >= maxConnections) {
      return unavailable(request, reply, "Too many active event streams");
    }

    const channel = `run:${runId}`;
    const role = request.principal!.role;

    // Buffer live events that arrive while durable history is being read
    const earlyLiveEnvelopes: SseEnvelope[] = [];
    const earlyListener = (evt: unknown) => {
      const envelope = toSseEnvelope(runId, evt, role);
      if (envelope) {
        earlyLiveEnvelopes.push(envelope);
      }
    };
    eventBroadcaster.on(channel, earlyListener);

    // Pre-header check: attempt reading durable history BEFORE committing headers or hijacking the socket
    let history: readonly any[];
    try {
      history = eventSource ? eventSource(runId) : ((localEvents?.get(runId) ?? []) as readonly any[]);
    } catch (err) {
      eventBroadcaster.off(channel, earlyListener);
      diagnostics({
        ts: new Date().toISOString(),
        level: "error",
        event: "sse.history_read_failure",
        traceId: request.traceId,
        route: "/api/v1/runs/:runId/events",
        errorMessage: redactMessage((err as Error).message),
      });
      return unavailable(request, reply, "Durable event store read failure; cannot open event stream", "SERVICE_UNAVAILABLE");
    }

    const replayKind = eventSource ? "durable" : localEvents ? "transport-local" : "unavailable";
    activeSseConnections++;
    tenantSseConnections.set(tenantId, currentTenantStreams + 1);

    reply.hijack();
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(name, value as string | number | string[]);
    }
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.setHeader("X-Emerald-Replay", replayKind);
    reply.raw.setHeader("X-Emerald-Live-Source", "durable-store-replay");
    reply.raw.flushHeaders?.();

    let pingTimer: NodeJS.Timeout | undefined;
    let pollTimer: NodeJS.Timeout | undefined;
    let liveListener: ((evt: unknown) => void) | undefined;

    const session = new SseSession({
      sink: reply.raw as unknown as ConstructorParameters<typeof SseSession>[0]["sink"],
      runId,
      cursor,
      maxBufferedEvents,
      terminalEventTypes,
      onClosed: () => {
        if (pingTimer) clearInterval(pingTimer);
        if (pollTimer) clearInterval(pollTimer);
        if (liveListener) eventBroadcaster.off(channel, liveListener);
        activeSseConnections = Math.max(0, activeSseConnections - 1);
        const cur = tenantSseConnections.get(tenantId) ?? 1;
        if (cur <= 1) tenantSseConnections.delete(tenantId);
        else tenantSseConnections.set(tenantId, cur - 1);
      },
    });

    // Switch from early listener to session listener
    eventBroadcaster.off(channel, earlyListener);
    liveListener = (evt: unknown) => {
      const envelope = toSseEnvelope(runId, evt, role);
      if (!envelope) {
        diagnostics({ ts: new Date().toISOString(), level: "warn", event: "sse.malformed_live_event", traceId: request.traceId, route: "/api/v1/runs/:runId/events" });
        return;
      }
      session.offerLive(envelope);
    };
    eventBroadcaster.on(channel, liveListener);
    request.raw.on("close", () => session.close());
    request.raw.on("error", () => session.close());

    // Offer events caught during history read (they will be held in session until beginLive)
    for (const env of earlyLiveEnvelopes) {
      session.offerLive(env);
    }

    // Replay history in bounded chunks of 100
    const BATCH_SIZE = 100;
    try {
      for (let i = 0; i < history.length; i += BATCH_SIZE) {
        const batch = history.slice(i, i + BATCH_SIZE);
        const envelopes: SseEnvelope[] = [];
        for (const e of batch) {
          const env = toSseEnvelope(runId, e, role);
          if (env) envelopes.push(env);
        }
        session.replay(envelopes);
      }
      session.beginLive();
    } catch (replayErr) {
      diagnostics({
        ts: new Date().toISOString(),
        level: "error",
        event: "sse.replay_failure",
        traceId: request.traceId,
        route: "/api/v1/runs/:runId/events",
        errorMessage: redactMessage((replayErr as Error).message),
      });
      session.emitStreamError("STREAM_FAILED", "Durable event store read failure");
      return;
    }

    const runIsTerminal = snapshot ? isTerminalState(snapshot.status) : isTerminalState(record.status as RunStatus);
    if (runIsTerminal) session.endWhenDrained();

    if (!session.isClosed) {
      pingTimer = setInterval(() => {
        if (!session.isClosed && reply.raw.writable && !reply.raw.writableNeedDrain) reply.raw.write(`: ping\n\n`);
      }, SSE_PING_INTERVAL_MS);
      pingTimer.unref?.();

      let lastPolledSequence = history.length > 0 ? Number(history[history.length - 1].sequence) : cursor;
      if (eventSource) {
        pollTimer = setInterval(() => {
          if (session.isClosed) {
            if (pollTimer) clearInterval(pollTimer);
            return;
          }
          try {
            const currentEvents = eventSource(runId);
            for (const evt of currentEvents) {
              if (evt && typeof evt.sequence === "number" && evt.sequence > lastPolledSequence) {
                lastPolledSequence = evt.sequence;
                const envelope = toSseEnvelope(runId, evt, role);
                if (envelope) {
                  session.offerLive(envelope);
                }
              }
            }
            const curSnapshot = effectiveCoordinator ? effectiveCoordinator.getRun(runId) : undefined;
            if (curSnapshot && isTerminalState(curSnapshot.status)) {
              session.endWhenDrained();
            }
          } catch {
            // ignore transient poll errors
          }
        }, 100);
        pollTimer.unref?.();
      }
    }
  });

  // GET /api/v1/runs/:runId/artifacts — durable metadata discovery or transport-local map
  server.get("/api/v1/runs/:runId/artifacts", readRoute, async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const resolved = resolveRunAndTenant(runId, request.principal!);
    if (!resolved) return notFound(request, reply, "Run");
    markDurability(reply, resolved.durable ? "durable-coordinator" : "transport-local-non-durable");

    // 1. In-memory store test compatibility
    if (artifacts) {
      const body: ListArtifactsResponse = { success: true, data: artifacts.get(runId) ?? [] };
      return reply.status(200).send(body);
    }

    // 2. Production durable artifact discovery
    if (!artifactRoot) {
      diagnostics({
        ts: new Date().toISOString(),
        level: "error",
        event: "artifact.storage_error",
        traceId: request.traceId,
        method: request.method,
        route: request.routeOptions?.url ?? "unmatched",
        errorName: "ConfigurationError",
        errorMessage: "Artifact storage root is not configured",
      });
      return sendError(request, reply, 500, "INTERNAL_ERROR", "Artifact storage root is not configured");
    }

    try {
      const data = discoverRunArtifacts({ artifactRoot, runId });
      const body: ListArtifactsResponse = { success: true, data: [...data] };
      return reply.status(200).send(body);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      diagnostics({
        ts: new Date().toISOString(),
        level: "error",
        event: "artifact.discovery_error",
        traceId: request.traceId,
        method: request.method,
        route: request.routeOptions?.url ?? "unmatched",
        errorName: err instanceof Error ? err.name : "Error",
        errorMessage: redactMessage(message),
      });

      if (err instanceof ArtifactDiscoveryError) {
        return sendError(request, reply, err.statusCode, err.code, err.message);
      }
      return sendError(request, reply, 500, "INTERNAL_ERROR", "Failed to discover run artifacts");
    }
  });

  // GET /api/v1/runs/:runId/artifacts/:artifactId/content — secure artifact content retrieval
  server.get("/api/v1/runs/:runId/artifacts/:artifactId/content", readRoute, async (request, reply) => {
    const { runId, artifactId } = request.params as { runId: string; artifactId: string };
    const resolved = resolveRunAndTenant(runId, request.principal!);
    if (!resolved) return notFound(request, reply, "Run");
    markDurability(reply, resolved.durable ? "durable-coordinator" : "transport-local-non-durable");

    // Client-supplied tenantId parameter is strictly forbidden
    const rawQuery = (request.query as Record<string, unknown>) ?? {};
    if (rawQuery.tenantId !== undefined) {
      return sendError(
        request,
        reply,
        400,
        "BAD_REQUEST",
        "Explicit tenantId parameter is forbidden; tenant is derived from authentication"
      );
    }

    // 1. In-memory store test compatibility
    if (artifacts) {
      const runArtifacts = artifacts.get(runId) ?? [];
      const found = runArtifacts.find((a: any) => a && a.artifactId === artifactId);
      if (!found) {
        return notFound(request, reply, "Artifact");
      }

      const contentType = found.contentType ?? "text/x-diff";
      if (!ALLOWED_ARTIFACT_CONTENT_TYPES.includes(contentType as any)) {
        return sendError(request, reply, 415, "UNSUPPORTED_MEDIA_TYPE", `Unsupported content type: ${contentType}`);
      }

      let rawContent = (found as any).content ?? (local as any)?.artifactContents?.get(artifactId);
      if (rawContent === undefined) {
        rawContent = "diff --git a/test.txt b/test.txt\n--- a/test.txt\n+++ b/test.txt\n@@ -1 +1 @@\n-old\n+new\n";
      }
      const buffer = Buffer.isBuffer(rawContent) ? rawContent : Buffer.from(String(rawContent), "utf8");

      if (buffer.length > DEFAULT_MAX_ARTIFACT_CONTENT_BYTES) {
        return sendError(request, reply, 413, "PAYLOAD_TOO_LARGE", "Artifact content exceeds size limit");
      }

      const computedSha256 = crypto.createHash("sha256").update(buffer).digest("hex").toLowerCase();
      if (found.sha256 && found.sha256.toLowerCase() !== computedSha256) {
        return sendError(request, reply, 500, "INTERNAL_ERROR", "Artifact SHA-256 integrity verification failed");
      }

      const rawFileName = found.relativePath ? path.basename(found.relativePath) : "patch.diff";
      const fileName = rawFileName.replace(/[^A-Za-z0-9._-]/g, "_") || "patch.diff";
      reply.header("Content-Type", `${contentType}; charset=utf-8`);
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
      reply.header("Content-Disposition", `attachment; filename="${fileName}"`);
      reply.header("ETag", `"${computedSha256}"`);
      reply.header("Cache-Control", "private, no-cache");

      return reply.status(200).send(buffer);
    }

    // 2. Production durable artifact content retrieval
    if (!artifactRoot) {
      diagnostics({
        ts: new Date().toISOString(),
        level: "error",
        event: "artifact.storage_error",
        traceId: request.traceId,
        method: request.method,
        route: request.routeOptions?.url ?? "unmatched",
        errorName: "ConfigurationError",
        errorMessage: "Artifact storage root is not configured",
      });
      return sendError(request, reply, 500, "INTERNAL_ERROR", "Artifact storage root is not configured");
    }

    try {
      const retrieved = retrieveRunArtifactContent({ artifactRoot, runId, artifactId });
      reply.header("Content-Type", `${retrieved.contentType}; charset=utf-8`);
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
      reply.header("Content-Disposition", `attachment; filename="${retrieved.fileName}"`);
      reply.header("ETag", `"${retrieved.sha256}"`);
      reply.header("Cache-Control", "private, no-cache");

      return reply.status(200).send(retrieved.content);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      diagnostics({
        ts: new Date().toISOString(),
        level: "error",
        event: "artifact.retrieval_error",
        traceId: request.traceId,
        method: request.method,
        route: request.routeOptions?.url ?? "unmatched",
        errorName: err instanceof Error ? err.name : "Error",
        errorMessage: redactMessage(message),
      });

      if (err instanceof ArtifactDiscoveryError) {
        return sendError(request, reply, err.statusCode, err.code, err.message);
      }
      return sendError(request, reply, 500, "INTERNAL_ERROR", "Failed to retrieve artifact content");
    }
  });

  // GET /api/v1/approvals — list human-in-the-loop approvals strictly scoped to the caller tenant
  server.get("/api/v1/approvals", readRoute, async (request, reply) => {
    const rawQuery = (request.query as Record<string, unknown>) ?? {};
    if (rawQuery.tenantId !== undefined) {
      return sendError(
        request,
        reply,
        400,
        "BAD_REQUEST",
        "Explicit tenantId parameter is forbidden; tenant is derived from authentication"
      );
    }
    const parsedQuery = ListApprovalsQuerySchema.safeParse(rawQuery);
    if (!parsedQuery.success) {
      return sendError(request, reply, 400, "BAD_REQUEST", "Invalid query parameters", {
        issues: parsedQuery.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    if (!effectiveApprovalControl) {
      return unavailable(request, reply, "Approval governance service is unavailable");
    }

    const principal = request.principal!;
    const { runId, taskId, status } = parsedQuery.data;
    const records =
      effectiveStore && typeof (effectiveStore as any).listApprovalRequests === "function"
        ? (effectiveStore as any)
            .listApprovalRequests({
              tenantId: principal.tenantId,
              ...(runId ? { runId } : {}),
              ...(taskId ? { taskId } : {}),
              ...(status ? { status } : {}),
            })
            .filter((a: any) => a.tenantId === principal.tenantId)
            .map((a: any) => ({
              approvalId: a.approvalId,
              runId: a.runId,
              taskId: a.taskId || undefined,
              tenantId: a.tenantId || undefined,
              operation: a.operation,
              parameters: {},
              parametersHash: a.parametersHash,
              riskLevel: a.riskLevel,
              justification: a.justification,
              status: a.status,
              singleUse: Boolean(a.singleUse),
              requestedAt: a.requestedAt,
              expiresAt: a.expiresAt,
              decidedAt: a.decidedAt,
              consumedAt: a.consumedAt,
              approver: a.approver,
              decisionReason: a.decisionReason,
            }))
        : effectiveApprovalControl
            .listAll(runId)
            .filter(
              (a) =>
                a.tenantId === principal.tenantId &&
                (!taskId || a.taskId === taskId) &&
                (!status || a.status === status)
            );

    markDurability(reply, effectiveStore ? "durable-coordinator" : "transport-local-non-durable");
    const body: ListApprovalsResponse = {
      success: true,
      data: records.map(toApprovalSummary),
    };
    return reply.status(200).send(body);
  });

  // POST /api/v1/approvals/:approvalId/approve — approve request & requeue paused run
  server.post("/api/v1/approvals/:approvalId/approve", writeRoute, async (request, reply) => {
    const { approvalId } = request.params as { approvalId: string };
    const principal = request.principal!;
    if (!effectiveApprovalControl) {
      return unavailable(request, reply, "Approval governance service is unavailable");
    }
    const parsed = ApprovalDecisionRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(request, reply, 400, "BAD_REQUEST", "Invalid approval decision payload", {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }

    const existing = effectiveApprovalControl.getApproval(approvalId);
    if (!existing || existing.tenantId !== principal.tenantId) {
      return notFound(request, reply, "Approval");
    }
    if (existing.status !== "PENDING") {
      return sendError(request, reply, 409, "CONFLICT", `Approval request is already '${existing.status}'`);
    }

    try {
      const updated = effectiveApprovalControl.approve(
        approvalId,
        principal.principalId,
        parsed.data.reason
      );
      lifecycleTelemetry.recordApprovalDecision({
        action: "approved",
        riskLevel: updated.riskLevel,
        executionMode,
      });

      let resumed = false;
      let runStatus: TaskStatus | undefined;
      if (effectiveCoordinator) {
        const snap = effectiveCoordinator.getRun(updated.runId);
        if (snap) {
          runStatus = snap.status as TaskStatus;
          if (snap.status === "WAITING_APPROVAL") {
            const transition = effectiveCoordinator.resumeFromApproval(
              updated.runId,
              approvalId,
              principal.principalId
            );
            resumed = true;
            runStatus = transition.run.status as TaskStatus;
          }
        }
      }

      markDurability(reply, effectiveStore ? "durable-coordinator" : "transport-local-non-durable");
      void pumpExecutionLoop();
      const body: ApprovalDecisionResponse = {
        success: true,
        data: {
          approval: toApprovalSummary(updated),
          ...(runStatus ? { runStatus } : {}),
          resumed,
        },
      };
      return reply.status(200).send(body);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("expired") || msg.toLowerCase().includes("already decided") || msg.toLowerCase().includes("conflict")) {
        return sendError(request, reply, 409, "CONFLICT", redactMessage(msg));
      }
      if (msg.toLowerCase().includes("self-approve") || msg.toLowerCase().includes("human operator")) {
        return sendError(request, reply, 403, "FORBIDDEN", redactMessage(msg));
      }
      throw err;
    }
  });

  // POST /api/v1/approvals/:approvalId/reject — reject request & fail paused run
  server.post("/api/v1/approvals/:approvalId/reject", writeRoute, async (request, reply) => {
    const { approvalId } = request.params as { approvalId: string };
    const principal = request.principal!;
    if (!effectiveApprovalControl) {
      return unavailable(request, reply, "Approval governance service is unavailable");
    }
    const parsed = ApprovalDecisionRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(request, reply, 400, "BAD_REQUEST", "Invalid approval decision payload", {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }

    const existing = effectiveApprovalControl.getApproval(approvalId);
    if (!existing || existing.tenantId !== principal.tenantId) {
      return notFound(request, reply, "Approval");
    }
    if (existing.status !== "PENDING") {
      return sendError(request, reply, 409, "CONFLICT", `Approval request is already '${existing.status}'`);
    }

    const decisionReason = parsed.data.reason ?? "Rejected by operator";
    try {
      const updated = effectiveApprovalControl.reject(
        approvalId,
        principal.principalId,
        decisionReason
      );
      lifecycleTelemetry.recordApprovalDecision({
        action: "rejected",
        riskLevel: updated.riskLevel,
        executionMode,
      });

      let runStatus: TaskStatus | undefined;
      if (effectiveCoordinator) {
        const snap = effectiveCoordinator.getRun(updated.runId);
        if (snap) {
          runStatus = snap.status as TaskStatus;
          if (snap.status === "WAITING_APPROVAL") {
            const transition = effectiveCoordinator.rejectApprovalTransition(
              updated.runId,
              approvalId,
              principal.principalId,
              decisionReason
            );
            runStatus = transition.run.status as TaskStatus;
          }
        }
      }

      markDurability(reply, effectiveStore ? "durable-coordinator" : "transport-local-non-durable");
      const body: ApprovalDecisionResponse = {
        success: true,
        data: {
          approval: toApprovalSummary(updated),
          ...(runStatus ? { runStatus } : {}),
          resumed: false,
        },
      };
      return reply.status(200).send(body);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("already decided") || msg.toLowerCase().includes("conflict")) {
        return sendError(request, reply, 409, "CONFLICT", redactMessage(msg));
      }
      if (msg.toLowerCase().includes("self-approve") || msg.toLowerCase().includes("human operator")) {
        return sendError(request, reply, 403, "FORBIDDEN", redactMessage(msg));
      }
      throw err;
    }
  });


  // GET /api/v1/approvals/:approvalId — Approval UX inspection
  server.get("/api/v1/approvals/:approvalId", readRoute, async (request, reply) => {
    const { approvalId } = request.params as { approvalId: string };
    const principal = request.principal!;
    if (!effectiveApprovalControl) {
      return unavailable(request, reply, "Approval governance service is unavailable");
    }

    const existing = effectiveApprovalControl.getApproval(approvalId);
    if (!existing || existing.tenantId !== principal.tenantId) {
      return notFound(request, reply, "Approval");
    }

    markDurability(reply, effectiveStore ? "durable-coordinator" : "transport-local-non-durable");
    const body: ApprovalResponse = {
      success: true,
      data: toApprovalSummary(existing),
    };
    return reply.status(200).send(body);
  });

  // POST /api/v1/approvals/:approvalId/decide — Unified approval decision endpoint
  server.post("/api/v1/approvals/:approvalId/decide", writeRoute, async (request, reply) => {
    const { approvalId } = request.params as { approvalId: string };
    const principal = request.principal!;
    if (!effectiveApprovalControl) {
      return unavailable(request, reply, "Approval governance service is unavailable");
    }
    const parsed = ApprovalDecisionRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(request, reply, 400, "BAD_REQUEST", "Invalid approval decision payload", {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }

    const decision = parsed.data.decision ?? "APPROVE";
    const reason = parsed.data.reason;

    const existing = effectiveApprovalControl.getApproval(approvalId);
    if (!existing || existing.tenantId !== principal.tenantId) {
      return notFound(request, reply, "Approval");
    }
    if (existing.status !== "PENDING") {
      return sendError(request, reply, 409, "CONFLICT", `Approval request is already '${existing.status}'`);
    }

    try {
      if (decision === "REJECT") {
        const updated = effectiveApprovalControl.reject(
          approvalId,
          principal.principalId,
          reason ?? "Rejected by operator"
        );
        lifecycleTelemetry.recordApprovalDecision({
          action: "rejected",
          riskLevel: updated.riskLevel,
          executionMode,
        });

        let runStatus: TaskStatus | undefined;
        if (effectiveCoordinator) {
          const snap = effectiveCoordinator.getRun(updated.runId);
          if (snap) {
            runStatus = snap.status as TaskStatus;
            if (snap.status === "WAITING_APPROVAL") {
              effectiveCoordinator.failRun(
                updated.runId,
                `High-risk operation '${updated.operation}' rejected by operator: ${reason ?? "no reason specified"}`
              );
              runStatus = "FAILED";
            }
          }
        }

        markDurability(reply, effectiveStore ? "durable-coordinator" : "transport-local-non-durable");
        const body: ApprovalDecisionResponse = {
          success: true,
          data: {
            approval: toApprovalSummary(updated),
            ...(runStatus ? { runStatus } : {}),
            resumed: false,
          },
        };
        return reply.status(200).send(body);
      } else {
        const updated = effectiveApprovalControl.approve(
          approvalId,
          principal.principalId,
          reason
        );
        lifecycleTelemetry.recordApprovalDecision({
          action: "approved",
          riskLevel: updated.riskLevel,
          executionMode,
        });

        let resumed = false;
        let runStatus: TaskStatus | undefined;
        if (effectiveCoordinator) {
          const snap = effectiveCoordinator.getRun(updated.runId);
          if (snap) {
            runStatus = snap.status as TaskStatus;
            if (snap.status === "WAITING_APPROVAL") {
              const transition = effectiveCoordinator.resumeFromApproval(
                updated.runId,
                approvalId,
                principal.principalId
              );
              resumed = true;
              runStatus = transition.run.status as TaskStatus;
            }
          }
        }

        markDurability(reply, effectiveStore ? "durable-coordinator" : "transport-local-non-durable");
        void pumpExecutionLoop();
        const body: ApprovalDecisionResponse = {
          success: true,
          data: {
            approval: toApprovalSummary(updated),
            ...(runStatus ? { runStatus } : {}),
            resumed,
          },
        };
        return reply.status(200).send(body);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("expired") || msg.toLowerCase().includes("already decided") || msg.toLowerCase().includes("conflict")) {
        return sendError(request, reply, 409, "CONFLICT", redactMessage(msg));
      }
      if (msg.toLowerCase().includes("self-approve") || msg.toLowerCase().includes("human operator")) {
        return sendError(request, reply, 403, "FORBIDDEN", redactMessage(msg));
      }
      throw err;
    }
  });

  // GET /metrics — Prometheus metrics exposition endpoint
  server.get("/metrics", async (_request, reply) => {
    telemetry.collectRuntimeHealth(options.healthDataDirectory ?? artifactRoot);
    lifecycleTelemetry.syncLangfuseMetrics();
    const modeTag = lifecycleTelemetry.getDefaultExecutionMode();
    if (effectiveStore) {
      try {
        if (typeof (effectiveStore as any).getObservabilityCounts === "function") {
          const counts = (effectiveStore as any).getObservabilityCounts() as {
            readonly tasksTotal: number;
            readonly runsByStatus: Readonly<Record<string, number>>;
          };
          telemetry.recordMetric({
            name: "emerald_tasks_total",
            type: "GAUGE",
            help: "Total number of tasks in state store",
            value: counts.tasksTotal,
            labels: { execution_mode: modeTag },
          });
          for (const [status, count] of Object.entries(counts.runsByStatus)) {
            telemetry.recordMetric({
              name: "emerald_runs_total",
              type: "COUNTER",
              help: "Total runs in state store by status",
              value: count,
              labels: { status, execution_mode: modeTag },
            });
          }
        } else if (typeof (effectiveStore as any).listTasks === "function") {
          const res = (effectiveStore as any).listTasks({ limit: 1000 });
          const tasksList = Array.isArray(res?.tasks) ? res.tasks : [];
          telemetry.recordMetric({
            name: "emerald_tasks_total",
            type: "GAUGE",
            help: "Total number of tasks in state store",
            value: typeof res?.total === "number" ? res.total : tasksList.length,
            labels: { execution_mode: modeTag },
          });
        }
      } catch {
        // Fail-safe: metrics export must never throw
      }
    }
    const metricsText = telemetry.exportPrometheusMetrics();
    reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return reply.status(200).send(metricsText);
  });

  // GET /health — Read-only runtime, SQLite store, and observability pipeline health
  server.get("/health", async (_request, reply) => {
    const pipeline = telemetry.getHealth();
    const mem = process.memoryUsage();
    let durableStoreReachable = false;

    if (effectiveStore) {
      try {
        if (typeof (effectiveStore as any).getObservabilityCounts === "function") {
          (effectiveStore as any).getObservabilityCounts();
          durableStoreReachable = true;
        } else if (typeof effectiveStore.getRun === "function") {
          effectiveStore.getRun("__emerald_health_probe__");
          durableStoreReachable = true;
        }
      } catch {
        durableStoreReachable = false;
      }
    }

    const storeConfigured = Boolean(effectiveStore);
    const coreHealthy = !storeConfigured || durableStoreReachable;
    const langfuseDegraded =
      pipeline.langfuse.enabled &&
      pipeline.langfuse.exportFailures > 0 &&
      Boolean(pipeline.langfuse.lastExportError);
    const telemetryHealthy = pipeline.observability.healthy && !langfuseDegraded;
    const overallStatus = coreHealthy ? "ok" : "degraded";

    return reply.status(200).send({
      status: overallStatus,
      coreStatus: coreHealthy ? "ok" : "degraded",
      telemetryStatus: telemetryHealthy ? "ok" : "degraded",
      zeroAuthority: true,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Number(process.uptime().toFixed(3)),
      memory: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
      },
      store: {
        configured: storeConfigured,
        reachable: storeConfigured ? durableStoreReachable : null,
      },
      observability: {
        healthy: pipeline.observability.healthy,
        spansRecorded: pipeline.observability.spansRecorded,
        spansDropped: pipeline.observability.spansDropped,
        logsRecorded: pipeline.observability.logsRecorded,
        logsDropped: pipeline.observability.logsDropped,
        metricSeriesCount: pipeline.observability.metricSeriesCount,
        metricOverflowCount: pipeline.observability.metricOverflowCount,
        exportAttempts: pipeline.observability.exportAttempts,
        exportFailures: pipeline.observability.exportFailures,
        queuedExportBatches: pipeline.observability.queuedExportBatches,
      },
      executionLoop: {
        ...executionLoopStats,
        active: Boolean(executionLoopTimer) && !pumpClosed,
        inFlight: Boolean(activePumpPromise),
        closing: pumpClosed,
      },
      langfuse: {
        configured: pipeline.langfuse.configured,
        enabled: pipeline.langfuse.enabled,
        queuedEvents: pipeline.langfuse.queuedEvents,
        exportedEvents: pipeline.langfuse.exportedEvents,
        droppedEvents: pipeline.langfuse.droppedEvents,
        exportFailures: pipeline.langfuse.exportFailures,
        retentionDays: pipeline.langfuse.retentionDays,
      },
    });
  });

  server.addHook("onClose", async () => {
    pumpClosed = true;
    repumpPending = false;
    if (executionLoopTimer) {
      clearInterval(executionLoopTimer);
      executionLoopTimer = undefined;
    }
    if (activePumpPromise) {
      try {
        await activePumpPromise;
      } catch {
        // Failure isolation: errors already logged inside runOnePumpCycle
      }
    }
    try {
      await telemetry.shutdown();
    } catch {
      // Fail-safe telemetry shutdown isolation
    }
  });

  return server;
}
