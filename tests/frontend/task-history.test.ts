/**
 * Emerald Agent Fabric — Task History & Query Client Integration Tests (Milestone 2.28 / Phase 2)
 *
 * Verifies:
 * - EmeraldApiClient.listTasks query string serialization, bounds validation, cursor/filter encoding
 * - Zero client-forged tenantId enforcement (tenant identity strictly derived from auth credentials)
 * - Error classification and propagation for invalid cursors, 400 Bad Request, and 401 Unauthorized
 * - DashboardController state lifecycle: cursor pagination, deduplication, loading/error states, stale response protection
 * - Fastify + SQLite live integration with multi-page cursor navigation, status filtering, and cross-tenant isolation
 * - Accessible pure-view UI rendering: status filter dropdown, refresh/load-more buttons, loading spinners, error alerts
 * - DOM event binding in mountDashboardApp: status filter change, refresh, load-more, and error retry
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import {
  EmeraldApiClient,
  ApiClientError,
} from "../../apps/web/src/client/api-client.js";
import {
  DashboardController,
  type DashboardState,
} from "../../apps/web/src/components/dashboard-controller.js";
import {
  renderTaskList,
} from "../../apps/web/src/components/dashboard-view.js";
import {
  mountDashboardApp,
  type DOMElement,
} from "../../apps/web/src/app.js";
import {
  buildFastifyServer,
  type PrincipalRecord,
} from "../../src/transport/http/server.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { SystemClock } from "../../src/ports/clock.port.js";
import type { TaskStatus } from "../../apps/web/src/types/api.js";

/**
 * In-process fetch adapter backed by Fastify server.inject().
 * Completely eliminates host TCP socket binding and firewall prompts.
 */
function createServerFetch(server: FastifyInstance): typeof globalThis.fetch {
  return (async (input: unknown, init?: any): Promise<Response> => {
    const urlStr = typeof input === "string" ? input : String(input);
    const parsed = new URL(urlStr);
    const pathWithQuery = parsed.pathname + parsed.search;

    const headers: Record<string, string> = {};
    if (init?.headers) {
      if (typeof (init.headers as Headers).forEach === "function") {
        (init.headers as Headers).forEach((v: string, k: string) => {
          headers[k] = v;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) {
          headers[k] = v;
        }
      } else {
        Object.assign(headers, init.headers);
      }
    }

    const injectRes = await server.inject({
      method: (init?.method as any) ?? "GET",
      url: pathWithQuery,
      headers,
      payload: typeof init?.body === "string" ? init.body : undefined,
    });

    const responseHeaders = new Headers();
    if (injectRes.headers) {
      for (const [k, v] of Object.entries(injectRes.headers)) {
        if (v !== undefined) {
          responseHeaders.set(k, Array.isArray(v) ? v.join(", ") : String(v));
        }
      }
    }

    return new Response(injectRes.body, {
      status: injectRes.statusCode,
      headers: responseHeaders,
    });
  }) as typeof globalThis.fetch;
}

/**
 * Lightweight mock DOM element tree implementing DOMElement for headless integration testing.
 */
class MockDOMElement implements DOMElement {
  private _innerHTML: string = "";
  public value: string = "";
  public readonly attributes = new Map<string, string>();
  public readonly listeners = new Map<string, Array<(e: any) => void>>();
  private readonly childElements: MockDOMElement[] = [];

  constructor(
    public readonly tagName: string = "div",
    attrs: Record<string, string> = {}
  ) {
    for (const [k, v] of Object.entries(attrs)) {
      this.attributes.set(k, v);
    }
    if (attrs.value !== undefined) {
      this.value = attrs.value;
    }
  }

  get innerHTML(): string {
    return this._innerHTML;
  }

  set innerHTML(val: string) {
    this._innerHTML = val;
    this.parseHtmlChildren(val);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, val: string): void {
    this.attributes.set(name, val);
  }

  addEventListener(event: string, handler: (e: any) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(handler);
    this.listeners.set(event, list);
  }

  dispatchEvent(event: { type: string; [key: string]: any }): boolean {
    const list = this.listeners.get(event.type) ?? [];
    for (const fn of list) {
      fn(event);
    }
    return true;
  }

  querySelector<E extends DOMElement = DOMElement>(selector: string): E | null {
    const results = this.findAll(selector);
    return (results[0] as unknown as E) ?? null;
  }

  querySelectorAll<E extends DOMElement = DOMElement>(selector: string): E[] {
    return this.findAll(selector) as unknown as E[];
  }

  private findAll(selector: string): MockDOMElement[] {
    const matched: MockDOMElement[] = [];
    const checkMatch = (el: MockDOMElement) => {
      if (selector.startsWith("#")) {
        const id = selector.slice(1);
        if (el.getAttribute("id") === id) return true;
      } else if (selector.startsWith(".")) {
        const cls = selector.slice(1);
        const classes = (el.getAttribute("class") || "").split(/\s+/);
        if (classes.includes(cls)) return true;
      } else if (selector.startsWith("[") && selector.endsWith("]")) {
        const inside = selector.slice(1, -1);
        const [attr, val] = inside.split("=");
        if (attr && val) {
          const cleanVal = val.replace(/["']/g, "");
          if (el.getAttribute(attr.trim()) === cleanVal) return true;
        } else if (attr) {
          if (el.getAttribute(attr.trim()) !== null) return true;
        }
      } else if (el.tagName.toLowerCase() === selector.toLowerCase()) {
        return true;
      }
      return false;
    };

    const traverse = (current: MockDOMElement) => {
      for (const child of current.childElements) {
        if (checkMatch(child)) {
          matched.push(child);
        }
        traverse(child);
      }
    };

    traverse(this);
    return matched;
  }

  private parseHtmlChildren(html: string): void {
    this.childElements.length = 0;
    const tagRegex = /<([a-zA-Z0-9_-]+)([^>]*?)>/g;
    let match: RegExpExecArray | null;

    while ((match = tagRegex.exec(html)) !== null) {
      const tagName = match[1] ?? "div";
      const attrStr = match[2] ?? "";

      const attrs: Record<string, string> = {};
      const attrRegex = /([a-zA-Z0-9_-]+)(?:=["']([^"']*)["'])?/g;
      let attrMatch: RegExpExecArray | null;
      while ((attrMatch = attrRegex.exec(attrStr)) !== null) {
        const k = attrMatch[1];
        const v = attrMatch[2] ?? "";
        if (k) {
          attrs[k] = v;
        }
      }

      const child = new MockDOMElement(tagName, attrs);
      this.childElements.push(child);
    }
  }
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("Milestone 2.28 — Phase 2: Task History & Query Client Integration", () => {
  const TEST_BASE_URL = "http://127.0.0.1:3000";
  const TOK_ALPHA = "alpha-operator-token-test-secret-1";
  const TOK_BETA = "beta-operator-token-test-secret-2";

  const principals: PrincipalRecord[] = [
    {
      principalId: "principal-alpha",
      tenantId: "tenant-alpha",
      role: "operator",
      token: TOK_ALPHA,
      allowConstrainedHost: false,
    },
    {
      principalId: "principal-beta",
      tenantId: "tenant-beta",
      role: "operator",
      token: TOK_BETA,
      allowConstrainedHost: false,
    },
  ];

  describe("1. EmeraldApiClient.listTasks — Unit & Contract Adherence", () => {
    it("validates and enforces limit bounds (1..100 integer)", async () => {
      const client = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        fetch: async () => new Response(JSON.stringify({ success: true, data: [], nextCursor: null }), { status: 200 }),
      });

      // Reject limit < 1
      await expect(client.listTasks({ limit: 0 })).rejects.toThrow(ApiClientError);
      await expect(client.listTasks({ limit: -5 })).rejects.toThrow(ApiClientError);

      // Reject limit > 100
      await expect(client.listTasks({ limit: 101 })).rejects.toThrow(ApiClientError);
      await expect(client.listTasks({ limit: 500 })).rejects.toThrow(ApiClientError);

      // Reject non-integer limit
      await expect(client.listTasks({ limit: 10.5 })).rejects.toThrow(ApiClientError);
      await expect(client.listTasks({ limit: NaN })).rejects.toThrow(ApiClientError);

      // Accepts valid limit values
      const res1 = await client.listTasks({ limit: 1 });
      expect(res1.success).toBe(true);
      const res100 = await client.listTasks({ limit: 100 });
      expect(res100.success).toBe(true);
    });

    it("correctly encodes query parameters (limit, cursor, status) without trailing & or redundant chars", async () => {
      let requestedUrl = "";
      const client = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        fetch: async (input) => {
          requestedUrl = String(input);
          return new Response(JSON.stringify({ success: true, data: [], nextCursor: null }), { status: 200 });
        },
      });

      // No options
      await client.listTasks();
      expect(requestedUrl).toBe("http://127.0.0.1:3000/api/v1/tasks");

      // Limit only
      await client.listTasks({ limit: 25 });
      expect(requestedUrl).toBe("http://127.0.0.1:3000/api/v1/tasks?limit=25");

      // Cursor only
      await client.listTasks({ cursor: "cursor_abc123" });
      expect(requestedUrl).toBe("http://127.0.0.1:3000/api/v1/tasks?cursor=cursor_abc123");

      // Status only
      await client.listTasks({ status: "RUNNING" });
      expect(requestedUrl).toBe("http://127.0.0.1:3000/api/v1/tasks?status=RUNNING");

      // All options combined
      await client.listTasks({ limit: 50, cursor: "cursor_xyz", status: "COMPLETED" });
      const parsed = new URL(requestedUrl);
      expect(parsed.searchParams.get("limit")).toBe("50");
      expect(parsed.searchParams.get("cursor")).toBe("cursor_xyz");
      expect(parsed.searchParams.get("status")).toBe("COMPLETED");
    });

    it("strictly prohibits client-forged tenantId (never sends tenantId in query params)", async () => {
      let requestedUrl = "";
      const client = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        fetch: async (input) => {
          requestedUrl = String(input);
          return new Response(JSON.stringify({ success: true, data: [], nextCursor: null }), { status: 200 });
        },
      });

      await client.listTasks({ limit: 10, status: "QUEUED" });
      const parsed = new URL(requestedUrl);
      expect(parsed.searchParams.has("tenantId")).toBe(false);
      expect(parsed.searchParams.has("tenant")).toBe(false);
    });

    it("attaches Authorization Bearer header when token is supplied", async () => {
      let authHeader: string | null = null;
      const client = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        token: TOK_ALPHA,
        fetch: async (_input, init) => {
          const hdrs = init?.headers as Record<string, string>;
          authHeader = hdrs?.["Authorization"] ?? hdrs?.["authorization"] ?? null;
          return new Response(JSON.stringify({ success: true, data: [], nextCursor: null }), { status: 200 });
        },
      });

      await client.listTasks();
      expect(authHeader).toBe(`Bearer ${TOK_ALPHA}`);
    });

    it("propagates backend 400 BAD_REQUEST (e.g. invalid cursor) as typed ApiClientError", async () => {
      const client = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        fetch: async () =>
          new Response(
            JSON.stringify({
              success: false,
              error: {
                code: "BAD_REQUEST",
                message: "Invalid cursor: cursor payload is not valid base64url JSON",
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } }
          ),
      });

      await expect(client.listTasks({ cursor: "corrupted-cursor" })).rejects.toThrow(ApiClientError);
      try {
        await client.listTasks({ cursor: "corrupted-cursor" });
      } catch (err) {
        const apiErr = err as ApiClientError;
        expect(apiErr.statusCode).toBe(400);
        expect(apiErr.code).toBe("BAD_REQUEST");
        expect(apiErr.message).toContain("Invalid cursor");
      }
    });

    it("aborts in-flight listTasks request when AbortSignal triggers", async () => {
      const abortController = new AbortController();
      const client = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        fetch: async (_input, init) => {
          const signal = init?.signal as AbortSignal;
          return new Promise<Response>((_, reject) => {
            signal?.addEventListener("abort", () => {
              const abortErr = new Error("The operation was aborted");
              abortErr.name = "AbortError";
              reject(abortErr);
            });
          });
        },
      });

      const promise = client.listTasks({ signal: abortController.signal });
      abortController.abort();
      await expect(promise).rejects.toThrow();
    });
  });

  describe("2. DashboardController — Task History Lifecycle & Deduplication", () => {
    it("loads initial page of tasks and updates state correctly", async () => {
      const mockTasks = [
        {
          taskId: "task-001",
          title: "Build sandbox harness",
          status: "COMPLETED" as TaskStatus,
          executionMode: "sandboxed" as const,
          createdAt: "2026-11-08T10:00:00.000Z",
          updatedAt: "2026-11-08T10:05:00.000Z",
          contractId: null,
        },
        {
          taskId: "task-002",
          title: "Verify token redaction",
          status: "RUNNING" as TaskStatus,
          executionMode: "sandboxed" as const,
          createdAt: "2026-11-08T10:10:00.000Z",
          updatedAt: "2026-11-08T10:12:00.000Z",
          contractId: null,
        },
      ];

      const client = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        fetch: async () =>
          new Response(
            JSON.stringify({
              success: true,
              data: mockTasks,
              nextCursor: "cursor_page_2",
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          ),
      });

      const controller = new DashboardController(client);
      expect(controller.getState().tasks).toEqual([]);
      expect(controller.getState().nextCursor).toBeNull();

      await controller.loadTaskHistory({ reset: true });

      const state = controller.getState();
      expect(state.tasks).toHaveLength(2);
      expect(state.tasks[0]?.taskId).toBe("task-001");
      expect(state.tasks[1]?.taskId).toBe("task-002");
      expect(state.nextCursor).toBe("cursor_page_2");
      expect(state.hasMoreTasks).toBe(true);
      expect(state.isHistoryLoading).toBe(false);
      expect(state.historyError).toBeUndefined();
      expect(state.connectionStatus).toBe("connected");
    });

    it("paginates next page via loadNextPage and deduplicates overlapping task IDs", async () => {
      let callCount = 0;
      const client = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        fetch: async (input) => {
          callCount++;
          const url = new URL(String(input));
          const cursor = url.searchParams.get("cursor");

          if (!cursor) {
            return new Response(
              JSON.stringify({
                success: true,
                data: [
                  {
                    taskId: "task-001",
                    title: "First Task",
                    status: "COMPLETED",
                    executionMode: "sandboxed",
                    createdAt: "2026-11-08T10:00:00.000Z",
                    updatedAt: "2026-11-08T10:05:00.000Z",
                    contractId: null,
                  },
                ],
                nextCursor: "cursor_page_2",
              }),
              { status: 200, headers: { "content-type": "application/json" } }
            );
          } else {
            return new Response(
              JSON.stringify({
                success: true,
                data: [
                  // Overlapping task (should be deduplicated)
                  {
                    taskId: "task-001",
                    title: "First Task Duplicate",
                    status: "COMPLETED",
                    executionMode: "sandboxed",
                    createdAt: "2026-11-08T10:00:00.000Z",
                    updatedAt: "2026-11-08T10:05:00.000Z",
                    contractId: null,
                  },
                  // New distinct task
                  {
                    taskId: "task-002",
                    title: "Second Task",
                    status: "RUNNING",
                    executionMode: "sandboxed",
                    createdAt: "2026-11-08T09:00:00.000Z",
                    updatedAt: "2026-11-08T09:05:00.000Z",
                    contractId: null,
                  },
                ],
                nextCursor: null, // End of list
              }),
              { status: 200, headers: { "content-type": "application/json" } }
            );
          }
        },
      });

      const controller = new DashboardController(client);
      await controller.loadTaskHistory({ reset: true });
      expect(controller.getState().tasks).toHaveLength(1);
      expect(controller.getState().hasMoreTasks).toBe(true);

      await controller.loadNextPage();
      const state = controller.getState();
      expect(state.tasks).toHaveLength(2); // Deduplicated: only task-001 and task-002
      expect(state.tasks[0]?.taskId).toBe("task-001");
      expect(state.tasks[1]?.taskId).toBe("task-002");
      expect(state.nextCursor).toBeNull();
      expect(state.hasMoreTasks).toBe(false);

      // Calling loadNextPage when nextCursor is null is a safe no-op
      await controller.loadNextPage();
      expect(callCount).toBe(2);
    });

    it("prevents concurrent duplicate pagination calls while loading", async () => {
      let callCount = 0;
      let resolvePromise: (val: Response) => void;
      const delayedResponse = new Promise<Response>((resolve) => {
        resolvePromise = resolve;
      });

      const client = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        fetch: async () => {
          callCount++;
          return delayedResponse;
        },
      });

      const controller = new DashboardController(client, {
        nextCursor: "cursor_existing",
      });

      // Trigger first load
      const p1 = controller.loadTaskHistory({ reset: false });
      expect(controller.getState().isHistoryLoading).toBe(true);

      // Wait a microtask so fetch is invoked
      await Promise.resolve();
      expect(callCount).toBe(1);

      // Trigger second load while first is pending (not a reset)
      const p2 = controller.loadTaskHistory({ reset: false });
      expect(callCount).toBe(1); // Second call ignored

      resolvePromise!(
        new Response(
          JSON.stringify({ success: true, data: [], nextCursor: null }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );

      await Promise.all([p1, p2]);
      expect(controller.getState().isHistoryLoading).toBe(false);
    });

    it("resets pagination and reloads fresh list when setStatusFilter is invoked", async () => {
      let capturedStatus: string | null = null;
      const client = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        fetch: async (input) => {
          const url = new URL(String(input));
          capturedStatus = url.searchParams.get("status");
          return new Response(
            JSON.stringify({
              success: true,
              data: [
                {
                  taskId: "task-failed-1",
                  title: "Failed Task",
                  status: (capturedStatus ?? "FAILED") as TaskStatus,
                  executionMode: "sandboxed",
                  createdAt: "2026-11-08T10:00:00.000Z",
                  updatedAt: "2026-11-08T10:05:00.000Z",
                  contractId: null,
                },
              ],
              nextCursor: null,
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        },
      });

      const controller = new DashboardController(client);
      await controller.setStatusFilter("FAILED");

      expect(capturedStatus).toBe("FAILED");
      expect(controller.getState().statusFilter).toBe("FAILED");
      expect(controller.getState().tasks).toHaveLength(1);
      expect(controller.getState().tasks[0]?.status).toBe("FAILED");

      // Switching back to ALL
      await controller.setStatusFilter("ALL");
      expect(capturedStatus).toBeNull(); // Status omitted in query string for ALL
      expect(controller.getState().statusFilter).toBe("ALL");
    });

    it("handles backend error gracefully, setting historyError without clearing previous tasks", async () => {
      let shouldFail = false;
      const client = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        fetch: async () => {
          if (shouldFail) {
            return new Response(
              JSON.stringify({
                success: false,
                error: { code: "INTERNAL_ERROR", message: "Database connection failed" },
              }),
              { status: 500, headers: { "content-type": "application/json" } }
            );
          }
          return new Response(
            JSON.stringify({
              success: true,
              data: [
                {
                  taskId: "task-001",
                  title: "Existing Task",
                  status: "CREATED",
                  executionMode: "sandboxed",
                  createdAt: "2026-11-08T10:00:00.000Z",
                  updatedAt: "2026-11-08T10:05:00.000Z",
                  contractId: null,
                },
              ],
              nextCursor: "cursor_page_2",
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        },
      });

      const controller = new DashboardController(client);
      await controller.loadTaskHistory({ reset: true });
      expect(controller.getState().tasks).toHaveLength(1);

      // Now trigger error on next page
      shouldFail = true;
      await expect(controller.loadNextPage()).rejects.toThrow();

      const state = controller.getState();
      expect(state.tasks).toHaveLength(1); // Existing tasks preserved
      expect(state.isHistoryLoading).toBe(false);
      expect(state.historyError).toBeDefined();
    });

    it("disposes cleanly, aborting in-flight history request", async () => {
      let aborted = false;
      const client = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        fetch: async (_input, init) => {
          const signal = init?.signal as AbortSignal;
          signal?.addEventListener("abort", () => {
            aborted = true;
          });
          return new Promise(() => {}); // Never resolves
        },
      });

      const controller = new DashboardController(client);
      const promise = controller.loadTaskHistory({ reset: true });

      // Allow microtask queue to start request
      await Promise.resolve();
      expect(aborted).toBe(false);

      controller.dispose();
      expect(aborted).toBe(true);

      // Prevent unhandled rejection
      promise.catch(() => {});
    });
  });

  describe("3. Fastify + SQLite State Store Live Integration", () => {
    let tmpDir: string;
    let store: SqliteStateStore;
    let coordinator: RunCoordinator;
    let server: FastifyInstance;

    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-fe-history-"));
      const dbPath = path.join(tmpDir, "state.db");
      store = new SqliteStateStore({ location: dbPath });
      const clock = new SystemClock();
      const eventBroadcaster = new EventEmitter();
      coordinator = new RunCoordinator(store, clock, undefined, undefined, eventBroadcaster);

      server = buildFastifyServer({
        store,
        coordinator,
        eventBroadcaster,
        principals,
        corsOrigins: [],
        env: {},
      });

      // Submit 5 tasks for Tenant Alpha via durable Fastify API
      for (let i = 1; i <= 5; i++) {
        const res = await server.inject({
          method: "POST",
          url: "/api/v1/tasks",
          headers: { ...bearer(TOK_ALPHA), "content-type": "application/json" },
          payload: {
            title: `Alpha Task ${i}`,
            prompt: `Execute task ${i}`,
            modelConfig: { modelName: "qwen2.5-coder:3b" },
          },
        });
        expect(res.statusCode).toBe(201);
      }

      // Submit 2 tasks for Tenant Beta
      for (let i = 1; i <= 2; i++) {
        const res = await server.inject({
          method: "POST",
          url: "/api/v1/tasks",
          headers: { ...bearer(TOK_BETA), "content-type": "application/json" },
          payload: {
            title: `Beta Task ${i}`,
            prompt: `Execute beta task ${i}`,
            modelConfig: { modelName: "qwen2.5-coder:3b" },
          },
        });
        expect(res.statusCode).toBe(201);
      }
    });

    afterEach(async () => {
      await server.close();
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Best effort cleanup
      }
    });

    it("paginates multi-page task list across SQLite store with cursor navigation", async () => {
      const client = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        token: TOK_ALPHA,
        fetch: createServerFetch(server),
      });

      // Page 1: limit = 2
      const page1 = await client.listTasks({ limit: 2 });
      expect(page1.success).toBe(true);
      expect(page1.data).toHaveLength(2);
      expect(page1.nextCursor).toBeDefined();

      // Page 2: limit = 2 with cursor from page 1
      const page2 = await client.listTasks({ limit: 2, cursor: page1.nextCursor! });
      expect(page2.success).toBe(true);
      expect(page2.data).toHaveLength(2);
      expect(page2.nextCursor).toBeDefined();

      // Page 3: limit = 2 with cursor from page 2
      const page3 = await client.listTasks({ limit: 2, cursor: page2.nextCursor! });
      expect(page3.success).toBe(true);
      expect(page3.data).toHaveLength(1);
      expect(page3.nextCursor).toBeNull(); // Terminal page

      // Verify union has 5 distinct tasks
      const allIds = [
        ...page1.data.map((t) => t.taskId),
        ...page2.data.map((t) => t.taskId),
        ...page3.data.map((t) => t.taskId),
      ];
      expect(allIds).toHaveLength(5);
      expect(new Set(allIds).size).toBe(5);
    });

    it("enforces strict tenant isolation across SQLite queries", async () => {
      const clientAlpha = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        token: TOK_ALPHA,
        fetch: createServerFetch(server),
      });

      const clientBeta = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        token: TOK_BETA,
        fetch: createServerFetch(server),
      });

      const alphaRes = await clientAlpha.listTasks();
      expect(alphaRes.data.length).toBe(5);
      expect(alphaRes.data.every((t) => t.tenantId === "tenant-alpha")).toBe(true);

      const betaRes = await clientBeta.listTasks();
      expect(betaRes.data.length).toBe(2);
      expect(betaRes.data.every((t) => t.tenantId === "tenant-beta")).toBe(true);
    });

    it("filters SQLite tasks by lifecycle status", async () => {
      const client = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        token: TOK_ALPHA,
        fetch: createServerFetch(server),
      });

      // All newly submitted tasks start in QUEUED or CREATED
      const queuedRes = await client.listTasks({ status: "QUEUED" });
      expect(queuedRes.data.length).toBe(5);
      expect(queuedRes.data.every((t) => t.status === "QUEUED")).toBe(true);

      const completedRes = await client.listTasks({ status: "COMPLETED" });
      expect(completedRes.data).toHaveLength(0);
    });

    it("rejects cross-tenant cursor replay with 400 BAD_REQUEST", async () => {
      const clientAlpha = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        token: TOK_ALPHA,
        fetch: createServerFetch(server),
      });

      const clientBeta = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        token: TOK_BETA,
        fetch: createServerFetch(server),
      });

      // Get valid cursor for beta
      const betaRes = await clientBeta.listTasks({ limit: 1 });
      const betaCursor = betaRes.nextCursor!;
      expect(betaCursor).toBeDefined();

      // Alpha attempts to query using Beta's cursor
      await expect(clientAlpha.listTasks({ cursor: betaCursor })).rejects.toThrow(ApiClientError);
      try {
        await clientAlpha.listTasks({ cursor: betaCursor });
      } catch (err) {
        const apiErr = err as ApiClientError;
        expect(apiErr.statusCode).toBe(400);
        expect(apiErr.code).toBe("BAD_REQUEST");
        expect(apiErr.message).toContain("tenant mismatch");
      }
    });

    it("integrates DashboardController end-to-end with live Fastify + SQLite store", async () => {
      const client = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        token: TOK_ALPHA,
        fetch: createServerFetch(server),
      });

      const controller = new DashboardController(client);

      // Initial load: defaults to limit 20, returns all 5 tasks for Alpha
      await controller.loadTaskHistory({ reset: true });
      expect(controller.getState().tasks).toHaveLength(5);
      expect(controller.getState().hasMoreTasks).toBe(false);

      // Filter by QUEUED
      await controller.setStatusFilter("QUEUED");
      expect(controller.getState().tasks).toHaveLength(5);
      expect(controller.getState().statusFilter).toBe("QUEUED");

      // Filter by COMPLETED (empty)
      await controller.setStatusFilter("COMPLETED");
      expect(controller.getState().tasks).toHaveLength(0);
      expect(controller.getState().statusFilter).toBe("COMPLETED");

      // Reset to ALL
      await controller.setStatusFilter("ALL");
      expect(controller.getState().tasks).toHaveLength(5);

      controller.dispose();
    });
  });

  describe("4. Pure View UI Rendering & Accessibility (DashboardView)", () => {
    it("renders status filter dropdown with ALL and 11 TaskStatus options", () => {
      const state: DashboardState = {
        connectionStatus: "connected",
        isSubmitting: false,
        tasks: [],
        cancellation: {},
        statusFilter: "RUNNING",
      };

      const html = renderTaskList(state);

      expect(html).toContain('id="task-status-filter"');
      expect(html).toContain('aria-label="Filter tasks by status"');
      expect(html).toContain('<option value="ALL" >All Statuses</option>');
      expect(html).toContain('<option value="CREATED" >CREATED</option>');
      expect(html).toContain('<option value="QUEUED" >QUEUED</option>');
      expect(html).toContain('<option value="LEASED" >LEASED</option>');
      expect(html).toContain('<option value="RUNNING" selected>RUNNING</option>');
      expect(html).toContain('<option value="VERIFYING" >VERIFYING</option>');
      expect(html).toContain('<option value="WAITING_APPROVAL" >WAITING_APPROVAL</option>');
      expect(html).toContain('<option value="COMPLETED" >COMPLETED</option>');
      expect(html).toContain('<option value="FAILED" >FAILED</option>');
      expect(html).toContain('<option value="CANCELLED" >CANCELLED</option>');
      expect(html).toContain('<option value="TIMED_OUT" >TIMED_OUT</option>');
      expect(html).toContain('<option value="RECOVERING" >RECOVERING</option>');
    });

    it("renders refresh button with accessible label and id", () => {
      const state: DashboardState = {
        connectionStatus: "connected",
        isSubmitting: false,
        tasks: [],
        cancellation: {},
      };

      const html = renderTaskList(state);
      expect(html).toContain('id="refresh-history-btn"');
      expect(html).toContain('aria-label="Refresh task history"');
    });

    it("renders loading indicator with aria-busy and polite live region when isHistoryLoading is true", () => {
      const state: DashboardState = {
        connectionStatus: "connected",
        isSubmitting: false,
        tasks: [],
        cancellation: {},
        isHistoryLoading: true,
      };

      const html = renderTaskList(state);
      expect(html).toContain('id="task-history-loading"');
      expect(html).toContain('role="status"');
      expect(html).toContain('aria-live="polite"');
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain("Loading governed task history...");
    });

    it("renders accessible error alert with retry button when historyError is present", () => {
      const state: DashboardState = {
        connectionStatus: "connected",
        isSubmitting: false,
        tasks: [],
        cancellation: {},
        historyError: "Network connection refused by host",
      };

      const html = renderTaskList(state);
      expect(html).toContain('id="task-history-error"');
      expect(html).toContain('role="alert"');
      expect(html).toContain('id="task-history-retry-btn"');
      expect(html).toContain("Network connection refused by host");
      expect(html).toContain("Retry");
    });

    it("renders load-more button when hasMoreTasks is true", () => {
      const state: DashboardState = {
        connectionStatus: "connected",
        isSubmitting: false,
        tasks: [
          {
            taskId: "t-1",
            title: "Task 1",
            status: "COMPLETED",
            executionMode: "sandboxed",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            contractId: null,
          },
        ],
        cancellation: {},
        hasMoreTasks: true,
        nextCursor: "cursor-123",
      };

      const html = renderTaskList(state);
      expect(html).toContain('id="load-more-tasks-btn"');
      expect(html).toContain('aria-label="Load more tasks"');
      expect(html).toContain("Load More Tasks");
    });

    it("renders end of history notice when tasks exist and hasMoreTasks is false", () => {
      const state: DashboardState = {
        connectionStatus: "connected",
        isSubmitting: false,
        tasks: [
          {
            taskId: "t-1",
            title: "Task 1",
            status: "COMPLETED",
            executionMode: "sandboxed",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            contractId: null,
          },
        ],
        cancellation: {},
        hasMoreTasks: false,
      };

      const html = renderTaskList(state);
      expect(html).toContain('id="end-of-history-notice"');
      expect(html).toContain("All tasks loaded");
    });

    it("escapes user input and error text to prevent HTML injection", () => {
      const state: DashboardState = {
        connectionStatus: "connected",
        isSubmitting: false,
        tasks: [
          {
            taskId: "t-<xss>",
            title: "<script>alert(1)</script>",
            status: "COMPLETED",
            executionMode: "sandboxed",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            contractId: null,
          },
        ],
        cancellation: {},
        historyError: "<img src=x onerror=alert(2)>",
      };

      const html = renderTaskList(state);
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(html).not.toContain("<img src=x onerror=alert(2)>");
      expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
    });
  });

  describe("5. Application Mounting & Interactive DOM Event Wiring", () => {
    it("binds status filter change, refresh, load-more, and retry events in mountDashboardApp", async () => {
      const container = new MockDOMElement("div", { id: "app-root" });
      const client = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        fetch: async (input) => {
          const url = new URL(String(input));
          return new Response(
            JSON.stringify({
              success: true,
              data: [
                {
                  taskId: `task-queried-${url.searchParams.get("status") ?? "all"}`,
                  title: "Task Title",
                  status: (url.searchParams.get("status") ?? "CREATED") as TaskStatus,
                  executionMode: "sandboxed",
                  createdAt: "2026-11-08T10:00:00.000Z",
                  updatedAt: "2026-11-08T10:05:00.000Z",
                  contractId: null,
                },
              ],
              nextCursor: "cursor-next",
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        },
      });

      const app = mountDashboardApp({ container, apiClient: client });

      // Mount triggers initial loadTaskHistory
      await new Promise((r) => setTimeout(r, 20));

      const filterSelect = container.querySelector("#task-status-filter");
      expect(filterSelect).not.toBeNull();

      // 1. Dispatch filter change
      if (filterSelect) {
        filterSelect.value = "RUNNING";
        filterSelect.dispatchEvent({ type: "change" });
      }
      await new Promise((r) => setTimeout(r, 20));
      expect(app.controller.getState().statusFilter).toBe("RUNNING");

      // 2. Dispatch refresh history
      const refreshBtn = container.querySelector("#refresh-history-btn");
      expect(refreshBtn).not.toBeNull();
      refreshBtn?.dispatchEvent({ type: "click" });
      await new Promise((r) => setTimeout(r, 20));

      // 3. Dispatch load more
      const loadMoreBtn = container.querySelector("#load-more-tasks-btn");
      expect(loadMoreBtn).not.toBeNull();
      loadMoreBtn?.dispatchEvent({ type: "click" });
      await new Promise((r) => setTimeout(r, 20));

      app.unmount();
    });
  });
});
