import { submitDurableTask } from "../../application/durable-submission.js";
import { createObservableStateStore } from "../../application/observable-state-store.js";
import { SystemClock } from "../../ports/clock.port.js";
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
  type TaskResponse,
  type TaskStatus,
  type UserRole,
} from "./api-contracts.js";
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
  };
  /** Authoritative run authority. Required for cancellation; used for run state reads. */
  readonly coordinator?: RunCoordinator;
  /** Durable event source for SSE replay (falls back to coordinator.getEventsForRun). */
  readonly stateStore?: Pick<StateStorePort, "getEventsForRun">;
  /** Durable StateStorePort for durable task submission, inspection, and event emission. */
  readonly store?: StateStorePort;
  /** Live relay channel `run:<runId>`. No component of the runtime currently publishes to it automatically. */
  readonly eventBroadcaster?: EventEmitter;
  readonly sse?: { readonly maxBufferedEvents?: number; readonly maxConnections?: number };
  /** Sink for server-side diagnostics of unexpected failures. Defaults to a JSON line on stderr. */
  readonly diagnostics?: (record: DiagnosticRecord) => void;
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
  return message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").replace(/[\r\n\u0000-\u001f]+/g, " ").slice(0, 300);
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
  const effectiveStore = rawStore ? createObservableStateStore(rawStore, eventBroadcaster) : undefined;
  const effectiveCoordinator = options.coordinator ?? (effectiveStore ? new RunCoordinator(effectiveStore, new SystemClock(), undefined, undefined, eventBroadcaster) : undefined);
  if (effectiveCoordinator) {
    effectiveCoordinator.setEventBroadcaster?.(eventBroadcaster);
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
    const body: ApiErrorResponse = {
      success: false,
      error: { code, message, ...(details ? { details } : {}), timestamp: new Date().toISOString(), traceId: request.traceId },
    };
    return reply.status(status).send(body);
  };

  const notFound = (request: FastifyRequest, reply: FastifyReply, resource: "Task" | "Run") =>
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

    const isPayloadMethod = ["POST", "PUT", "PATCH", "DELETE"].includes(request.method);
    const hasContentHeader = Boolean(request.headers["content-type"] || request.headers["content-length"]);
    const path = request.url.split("?")[0] ?? "";
    if (path.startsWith("/api/v1/") && (isPayloadMethod || hasContentHeader) && request.method !== "OPTIONS") {
      await requireAuth(request, reply);
    }
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
    allowedHeaders: ["Authorization", "Content-Type", "Last-Event-ID", "X-Trace-ID"],
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
        if (effectiveTenant && effectiveTenant !== principal.tenantId) {
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
      },
    };
  };

  // ==========================================================================
  // Routes
  // ==========================================================================

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

    // 1. Durable submission pathway
    if (effectiveStore && effectiveCoordinator) {
      try {
        const timeoutMs = parsed.data.resourceLimits?.timeoutSeconds
          ? parsed.data.resourceLimits.timeoutSeconds * 1000
          : undefined;
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
        });
        markDurability(reply, "durable-coordinator");
        const taskRecord = effectiveCoordinator.getTask(submitted.taskId);
        const now = new Date().toISOString();
        const body: TaskResponse = {
          success: true,
          data: {
            taskId: submitted.taskId,
            tenantId: principal.tenantId,
            title: parsed.data.title,
            status: submitted.status as TaskStatus,
            executionMode: parsed.data.executionMode,
            createdAt: taskRecord?.createdAt ?? now,
            updatedAt: taskRecord?.updatedAt ?? now,
            contractId: `contract-${submitted.taskId}`,
            runId: submitted.runId,
          },
        };
        return reply.status(submitted.deduplicated ? 200 : 201).send(body);
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
    if (effectiveCoordinator) {
      const taskRecord = effectiveCoordinator.getTask(taskId);
      if (taskRecord) {
        let tenantId: string | undefined;
        if (effectiveStore) {
          const activeContracts = effectiveStore.findContractsByTaskId(taskId, "ACTIVE");
          const contract = activeContracts[0] ?? effectiveStore.findContractsByTaskId(taskId)[0];
          tenantId = contract?.spec.policy.tenantId;
        }
        if (tenantId && tenantId !== principal.tenantId) {
          return notFound(request, reply, "Task");
        }
        markDurability(reply, "durable-coordinator");
        const body: TaskResponse = {
          success: true,
          data: {
            taskId: taskRecord.taskId,
            tenantId: tenantId ?? principal.tenantId,
            title: taskRecord.title,
            status: "CREATED",
            executionMode: "sandboxed",
            createdAt: taskRecord.createdAt,
            updatedAt: taskRecord.updatedAt,
            contractId: `contract-${taskId}`,
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

  // GET /api/v1/runs/:runId/artifacts — transport-local, non-durable.
  server.get("/api/v1/runs/:runId/artifacts", readRoute, async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const resolved = resolveRunAndTenant(runId, request.principal!);
    if (!resolved) return notFound(request, reply, "Run");
    markDurability(reply, resolved.durable ? "durable-coordinator" : "transport-local-non-durable");
    const body: ListArtifactsResponse = { success: true, data: artifacts?.get(runId) ?? [] };
    return reply.status(200).send(body);
  });

  return server;
}
