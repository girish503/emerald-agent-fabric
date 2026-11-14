/**
 * Emerald Agent Fabric — Typed Frontend API Client (Milestone 2.27)
 *
 * Implements a robust, typed HTTP client matching the frozen Milestone 2.26
 * Fastify REST/SSE transport contracts.
 *
 * Architectural Invariants:
 * 1. Matches Actual Contracts: Only calls real endpoints (/tasks, /tasks/:id, /runs/:id, /runs/:id/cancel, /runs/:id/artifacts).
 * 2. Fail-Closed Security: Strips and redacts credentials from error messages, logs, and URLs.
 * 3. No Privilege Escalation: Client never sends server-owned fields or forged tenant parameters.
 * 4. Bounded Execution: Enforces timeouts via AbortController and supports user cancellation signals.
 * 5. Runtime Validation: Validates server responses against authoritative Zod schemas.
 * 6. Zero Dep: Uses standard fetch, URL, and Zod (already in project dependencies).
 */

import {
  CreateTaskRequestSchema,
  TaskResponseSchema,
  RunResponseSchema,
  CancelRunRequestSchema,
  CancelRunResponseSchema,
  ListArtifactsResponseSchema,
  ApiErrorResponseSchema,
  ListTasksResponseSchema,
  WhoamiResponseSchema,
  type CreateTaskRequest,
  type TaskResponse,
  type RunResponse,
  type CancelRunRequest,
  type CancelRunResponse,
  type ListArtifactsResponse,
  type ListTasksResponse,
  type ListTasksOptions,
  type WhoamiResponse,
  type ArtifactContentResponse,
  type ApiErrorCode,
  type ApiErrorResponse,
} from "../types/api.js";
import { EmeraldSseClient, type SseClientConfig } from "./sse-client.js";

export interface ApiClientConfig {
  /**
   * Base URL of the Emerald backend, e.g. "http://127.0.0.1:3000".
   * Trailing slashes are automatically stripped.
   */
  readonly baseUrl: string;
  /**
   * Access token string or a provider function returning the token.
   * If omitted, no Authorization header is attached.
   */
  readonly token?: string | (() => Promise<string | null | undefined> | string | null | undefined);
  /**
   * Default timeout in milliseconds for all requests. Defaults to 15,000ms.
   */
  readonly defaultTimeoutMs?: number;
  /**
   * Custom fetch implementation (useful for testing or specific runtime environments).
   */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Optional callback for unhandled errors. Token credentials are never passed here.
   */
  readonly onError?: (error: ApiClientError) => void;
}

export interface RequestOptions {
  /** Optional AbortSignal to cancel the request. */
  readonly signal?: AbortSignal;
  /** Optional timeout override in milliseconds for this specific request. */
  readonly timeoutMs?: number;
  /** Optional idempotency key for state-mutating requests (e.g. POST /tasks). */
  readonly idempotencyKey?: string;
  /** Optional custom trace ID for request tracing. */
  readonly traceId?: string;
}

/**
 * Standardized client error wrapping backend ApiErrorResponse or network failure.
 */
export class ApiClientError extends Error {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly traceId?: string;
  readonly details?: Record<string, unknown>;
  readonly isTransient: boolean;

  constructor(options: {
    message: string;
    statusCode: number;
    code: ApiErrorCode;
    traceId?: string;
    details?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(redactSensitive(options.message));
    this.name = "ApiClientError";
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.traceId = options.traceId;
    this.details = options.details;
    this.cause = options.cause;
    this.isTransient =
      options.statusCode === 503 ||
      options.statusCode === 429 ||
      options.code === "TRANSIENT" ||
      options.code === "TOO_MANY_REQUESTS" ||
      options.code === "SERVICE_UNAVAILABLE";
  }
}

/** Redacts Bearer tokens and sensitive keywords from strings. */
function redactSensitive(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/password\s*[:=]\s*\S+/gi, "password=[REDACTED]")
    .replace(/token\s*[:=]\s*\S+/gi, "token=[REDACTED]");
}

export class EmeraldApiClient {
  private readonly baseUrl: string;
  private readonly tokenProvider?: () => Promise<string | null | undefined> | string | null | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly onError?: (error: ApiClientError) => void;
  private runtimeToken: string | null = null;

  constructor(config: ApiClientConfig) {
    if (!config || !config.baseUrl) {
      throw new Error("EmeraldApiClient requires a valid baseUrl");
    }
    // Trim trailing slashes
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 15_000;
    this.fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.onError = config.onError;

    if (typeof config.token === "function") {
      this.tokenProvider = config.token;
    } else if (typeof config.token === "string") {
      const staticToken = config.token;
      this.tokenProvider = () => staticToken;
    }
  }

  /**
   * Stores a Bearer token strictly in memory for the active browser session.
   * Never persisted to localStorage, sessionStorage, or URL parameters.
   */
  setAuthToken(token: string | null): void {
    this.runtimeToken = typeof token === "string" && token.trim().length > 0 ? token.trim() : null;
  }

  clearAuthToken(): void {
    this.runtimeToken = null;
  }

  /**
   * Retrieves current Bearer token, if configured.
   */
  async getToken(): Promise<string | null> {
    if (this.runtimeToken !== null) return this.runtimeToken;
    if (!this.tokenProvider) return null;
    try {
      const res = await this.tokenProvider();
      return typeof res === "string" && res.trim().length > 0 ? res.trim() : null;
    } catch {
      return null;
    }
  }

  /**
   * Validates current session credentials and returns principal identity & tenant.
   * Route: GET /api/v1/auth/whoami
   */
  async whoami(options: RequestOptions = {}): Promise<WhoamiResponse> {
    return this.request("/api/v1/auth/whoami", {
      method: "GET",
      options,
      schema: WhoamiResponseSchema,
    });
  }

  /**
   * Opens an authenticated, reconnectable SSE stream for a given run ID.
   * Route: GET /api/v1/runs/:runId/events
   */
  openEventStream(runId: string, options: Partial<SseClientConfig> = {}): EmeraldSseClient {
    return new EmeraldSseClient({
      baseUrl: this.baseUrl,
      runId,
      token: () => this.getToken(),
      fetch: this.fetchImpl,
      ...options,
    });
  }

  /**
   * Lists tasks for the authenticated tenant with cursor pagination and status filtering.
   * Route: GET /api/v1/tasks
   */
  async listTasks(options: ListTasksOptions = {}): Promise<ListTasksResponse> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) {
      if (typeof options.limit !== "number" || options.limit < 1 || options.limit > 100 || !Number.isInteger(options.limit)) {
        throw new ApiClientError({
          message: "limit must be an integer between 1 and 100",
          statusCode: 400,
          code: "BAD_REQUEST",
        });
      }
      params.set("limit", String(options.limit));
    }
    if (options.cursor !== undefined && options.cursor.trim().length > 0) {
      params.set("cursor", options.cursor.trim());
    }
    if (options.status !== undefined) {
      params.set("status", options.status);
    }
    const qs = params.toString();
    const endpoint = `/api/v1/tasks${qs ? `?${qs}` : ""}`;
    return this.request<ListTasksResponse>(endpoint, {
      method: "GET",
      options: { signal: options.signal },
      schema: ListTasksResponseSchema,
    });
  }

  /**
   * Submits a governed agent task to the durable backend.
   * Route: POST /api/v1/tasks
   */
  async submitTask(request: CreateTaskRequest, options: RequestOptions = {}): Promise<TaskResponse> {
    // Client-side pre-validation against the strict backend schema:
    // Rejects unknown keys or disallowed fields (e.g. allowUnverifiedCompletion) before network transit.
    const validation = CreateTaskRequestSchema.safeParse(request);
    if (!validation.success) {
      const issue = validation.error.issues[0]?.message ?? "Invalid task submission payload";
      throw new ApiClientError({
        message: `Task submission validation failed: ${issue}`,
        statusCode: 400,
        code: "BAD_REQUEST",
        details: { issues: validation.error.issues },
      });
    }

    const headers: Record<string, string> = {};
    if (options.idempotencyKey) {
      headers["Idempotency-Key"] = options.idempotencyKey;
    }

    return this.request<TaskResponse>("/api/v1/tasks", {
      method: "POST",
      body: JSON.stringify(validation.data),
      headers,
      options,
      schema: TaskResponseSchema,
    });
  }

  /**
   * Retrieves task specification and lifecycle status.
   * Route: GET /api/v1/tasks/:taskId
   */
  async getTask(taskId: string, options: RequestOptions = {}): Promise<TaskResponse> {
    if (!taskId || typeof taskId !== "string" || taskId.trim().length === 0) {
      throw new ApiClientError({
        message: "taskId must be a non-empty string",
        statusCode: 400,
        code: "BAD_REQUEST",
      });
    }
    const encodedId = encodeURIComponent(taskId.trim());
    return this.request<TaskResponse>(`/api/v1/tasks/${encodedId}`, {
      method: "GET",
      options,
      schema: TaskResponseSchema,
    });
  }

  /**
   * Retrieves run execution state, step index, lease, and authoritative outcome.
   * Route: GET /api/v1/runs/:runId
   */
  async getRun(runId: string, options: RequestOptions = {}): Promise<RunResponse> {
    if (!runId || typeof runId !== "string" || runId.trim().length === 0) {
      throw new ApiClientError({
        message: "runId must be a non-empty string",
        statusCode: 400,
        code: "BAD_REQUEST",
      });
    }
    const encodedId = encodeURIComponent(runId.trim());
    return this.request<RunResponse>(`/api/v1/runs/${encodedId}`, {
      method: "GET",
      options,
      schema: RunResponseSchema,
    });
  }

  /**
   * Cancels an in-flight run with reason recording.
   * Route: POST /api/v1/runs/:runId/cancel
   */
  async cancelRun(runId: string, request: CancelRunRequest, options: RequestOptions = {}): Promise<CancelRunResponse> {
    if (!runId || typeof runId !== "string" || runId.trim().length === 0) {
      throw new ApiClientError({
        message: "runId must be a non-empty string",
        statusCode: 400,
        code: "BAD_REQUEST",
      });
    }
    const validation = CancelRunRequestSchema.safeParse(request);
    if (!validation.success) {
      throw new ApiClientError({
        message: "Invalid cancel request payload",
        statusCode: 400,
        code: "BAD_REQUEST",
        details: { issues: validation.error.issues },
      });
    }
    const encodedId = encodeURIComponent(runId.trim());
    return this.request<CancelRunResponse>(`/api/v1/runs/${encodedId}/cancel`, {
      method: "POST",
      body: JSON.stringify(validation.data),
      options,
      schema: CancelRunResponseSchema,
    });
  }

  /**
   * Lists registered artifacts and SHA-256 hashes for a run.
   * Route: GET /api/v1/runs/:runId/artifacts
   */
  async getArtifacts(runId: string, options: RequestOptions = {}): Promise<ListArtifactsResponse> {
    if (!runId || typeof runId !== "string" || runId.trim().length === 0) {
      throw new ApiClientError({
        message: "runId must be a non-empty string",
        statusCode: 400,
        code: "BAD_REQUEST",
      });
    }
    const encodedId = encodeURIComponent(runId.trim());
    return this.request<ListArtifactsResponse>(`/api/v1/runs/${encodedId}/artifacts`, {
      method: "GET",
      options,
      schema: ListArtifactsResponseSchema,
    });
  }

  /**
   * Retrieves bounded verified content for a run artifact (e.g. patch diff preview).
   * Route: GET /api/v1/runs/:runId/artifacts/:artifactId/content
   */
  async getArtifactContent(
    runId: string,
    artifactId: string,
    options: RequestOptions & { readonly maxPreviewBytes?: number } = {}
  ): Promise<ArtifactContentResponse> {
    if (!runId || typeof runId !== "string" || runId.trim().length === 0) {
      throw new ApiClientError({
        message: "runId is required to fetch artifact content",
        statusCode: 400,
        code: "BAD_REQUEST",
      });
    }
    if (!artifactId || typeof artifactId !== "string" || artifactId.trim().length === 0) {
      throw new ApiClientError({
        message: "artifactId is required to fetch artifact content",
        statusCode: 400,
        code: "BAD_REQUEST",
      });
    }

    const encodedRunId = encodeURIComponent(runId.trim());
    const encodedArtifactId = encodeURIComponent(artifactId.trim());
    const response = await this.executeHttpRequest(
      `/api/v1/runs/${encodedRunId}/artifacts/${encodedArtifactId}/content`,
      {
        method: "GET",
        headers: { Accept: "text/x-diff, text/plain;q=0.9, application/json;q=0.8, */*;q=0.1" },
        options,
      }
    );

    const rawText = await response.text();
    const byteLength = new TextEncoder().encode(rawText).byteLength;
    const maxPreviewBytes = Math.max(256, options.maxPreviewBytes ?? 65_536);
    const truncated = rawText.length > maxPreviewBytes || byteLength > maxPreviewBytes;
    const content = truncated ? rawText.slice(0, maxPreviewBytes) : rawText;

    const rawEtag = response.headers.get("etag") ?? response.headers.get("ETag") ?? undefined;
    const sha256 = rawEtag ? rawEtag.replace(/^"+|"+$/g, "").trim() || undefined : undefined;
    const contentDisposition =
      response.headers.get("content-disposition") ?? response.headers.get("Content-Disposition") ?? "";
    const fileMatch = /filename="?([^";\r\n]+)"?/i.exec(contentDisposition);
    const fileName = fileMatch?.[1]?.trim() || undefined;
    const contentType =
      response.headers.get("content-type") ?? response.headers.get("Content-Type") ?? "text/plain; charset=utf-8";

    return {
      artifactId: artifactId.trim(),
      runId: runId.trim(),
      content,
      contentType,
      ...(sha256 ? { sha256 } : {}),
      ...(fileName ? { fileName } : {}),
      byteLength,
      truncated,
    };
  }

  /**
   * Internal generic request dispatcher for JSON + Zod-validated endpoints.
   */
  private async request<T>(
    endpoint: string,
    req: {
      method: "GET" | "POST";
      body?: string;
      headers?: Record<string, string>;
      options: RequestOptions;
      schema: { safeParse: (data: unknown) => { success: true; data: T } | { success: false; error: unknown } };
    }
  ): Promise<T> {
    const response = await this.executeHttpRequest(endpoint, {
      method: req.method,
      body: req.body,
      headers: req.headers,
      options: req.options,
    });
    const traceId = response.headers.get("X-Trace-ID") ?? undefined;
    const json = await response.json();
    const parseResult = req.schema.safeParse(json);
    if (!parseResult.success) {
      throw new ApiClientError({
        message: "Server response failed contract schema validation",
        statusCode: 500,
        code: "INTERNAL_ERROR",
        traceId,
        details: { validationError: parseResult.error },
      });
    }
    return parseResult.data;
  }

  /**
   * Shared HTTP execution pipeline handling timeouts, cancellation signals, Bearer tokens, and error mapping.
   */
  private async executeHttpRequest(
    endpoint: string,
    req: {
      method: "GET" | "POST";
      body?: string;
      headers?: Record<string, string>;
      options: RequestOptions;
    }
  ): Promise<Response> {
    const url = `${this.baseUrl}${endpoint}`;
    const timeoutMs = req.options.timeoutMs ?? this.defaultTimeoutMs;

    const controller = new AbortController();
    let isTimedOut = false;
    const timeoutHandle = setTimeout(() => {
      isTimedOut = true;
      controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // Link caller's AbortSignal if provided
    let callerAbortCleanup: (() => void) | undefined;
    if (req.options.signal) {
      if (req.options.signal.aborted) {
        clearTimeout(timeoutHandle);
        throw new ApiClientError({
          message: "Request aborted by caller",
          statusCode: 499,
          code: "USER_ACTION_REQUIRED",
          cause: req.options.signal.reason,
        });
      }
      const onAbort = () => {
        controller.abort(req.options.signal?.reason);
      };
      req.options.signal.addEventListener("abort", onAbort, { once: true });
      callerAbortCleanup = () => req.options.signal?.removeEventListener("abort", onAbort);
    }

    try {
      const token = await this.getToken();

      if (controller.signal.aborted || req.options.signal?.aborted) {
        throw new ApiClientError({
          message: "Request aborted by caller",
          statusCode: 499,
          code: "USER_ACTION_REQUIRED",
          cause: req.options.signal?.reason,
        });
      }

      const headers: Record<string, string> = {
        Accept: "application/json",
        ...(req.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(req.options.traceId ? { "X-Trace-ID": req.options.traceId } : {}),
        ...(req.headers ?? {}),
      };

      const response = await this.fetchImpl(url, {
        method: req.method,
        headers,
        body: req.body,
        signal: controller.signal,
      });

      const traceId = response.headers.get("X-Trace-ID") ?? undefined;

      // Handle non-2xx HTTP responses
      if (!response.ok) {
        let errorData: ApiErrorResponse | undefined;
        let rawErrorObj: any = undefined;
        try {
          const json = await response.json();
          rawErrorObj = json;
          const parsed = ApiErrorResponseSchema.safeParse(json);
          if (parsed.success) {
            errorData = parsed.data;
          }
        } catch {
          // Response body was not JSON
        }

        const statusCode = response.status;
        const code: ApiErrorCode =
          errorData?.error.code ??
          (typeof rawErrorObj?.error?.code === "string"
            ? rawErrorObj.error.code
            : this.httpStatusToErrorCode(statusCode));
        const message =
          errorData?.error.message ??
          (typeof rawErrorObj?.error?.message === "string"
            ? rawErrorObj.error.message
            : `HTTP request failed with status ${statusCode}`);

        const apiError = new ApiClientError({
          message,
          statusCode,
          code,
          traceId: errorData?.error.traceId ?? rawErrorObj?.error?.traceId ?? traceId,
          details: errorData?.error.details ?? rawErrorObj?.error?.details,
        });

        this.onError?.(apiError);
        throw apiError;
      }

      return response;
    } catch (err) {
      if (err instanceof ApiClientError) {
        throw err;
      }

      if (isTimedOut) {
        const timeoutError = new ApiClientError({
          message: `Request timed out after ${timeoutMs}ms`,
          statusCode: 504,
          code: "TRANSIENT",
          cause: err,
        });
        this.onError?.(timeoutError);
        throw timeoutError;
      }

      if (req.options.signal?.aborted) {
        const cancelError = new ApiClientError({
          message: "Request aborted by caller",
          statusCode: 499,
          code: "USER_ACTION_REQUIRED",
          cause: req.options.signal.reason,
        });
        this.onError?.(cancelError);
        throw cancelError;
      }

      const networkError = new ApiClientError({
        message: `Network communication failure: ${(err as Error)?.message ?? "unknown error"}`,
        statusCode: 503,
        code: "TRANSIENT",
        cause: err,
      });
      this.onError?.(networkError);
      throw networkError;
    } finally {
      clearTimeout(timeoutHandle);
      callerAbortCleanup?.();
    }
  }

  private httpStatusToErrorCode(status: number): ApiErrorCode {
    switch (status) {
      case 400: return "BAD_REQUEST";
      case 401: return "UNAUTHORIZED";
      case 403: return "FORBIDDEN";
      case 404: return "NOT_FOUND";
      case 409: return "CONFLICT";
      case 413: return "PAYLOAD_TOO_LARGE";
      case 415: return "UNSUPPORTED_MEDIA_TYPE";
      case 429: return "TOO_MANY_REQUESTS";
      case 503: return "SERVICE_UNAVAILABLE";
      default: return status >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST";
    }
  }
}
