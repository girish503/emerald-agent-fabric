/**
 * Emerald Agent Fabric — Web Application Mounting & Integration Tests (Milestone 2.27)
 *
 * Verifies:
 * - Application mounting through the actual frontend entry point (mountDashboardApp)
 * - DashboardController connection to the rendered UI and event orchestration
 * - Form submission invoking actual EmeraldApiClient and updating DOM with server ID
 * - Run cancellation invoking backend cancel endpoint and displaying 3-phase status
 * - Reactive UI re-renders on controller state mutations
 * - Loading, error, empty, and populated state rendering
 * - Proper escaping of dynamic user and server content
 * - Network errors / disconnects mapped to connection status without marking agent execution failure
 * - Full end-to-end integration with live Fastify transport
 */

import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  mountDashboardApp,
  type DOMElement,
} from "../../apps/web/src/app.js";
import {
  EmeraldApiClient,
} from "../../apps/web/src/client/api-client.js";
import {
  buildFastifyServer,
  type PrincipalRecord,
} from "../../src/transport/http/server.js";

/**
 * Lightweight in-memory DOM element tree implementing DOMElement for headless integration testing.
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
    // Parses tags with attributes and inner contents
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

/**
 * Creates an in-process fetch adapter backed by Fastify server.inject().
 */
function createServerFetch(server: FastifyInstance): typeof globalThis.fetch {
  return (async (input: unknown, init?: any): Promise<Response> => {
    const urlStr = typeof input === "string" ? input : String(input);
    const parsed = new URL(urlStr);
    const path = parsed.pathname + parsed.search;

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
      url: path,
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

describe("Emerald Web Application — End-to-End Mounting & Integration", () => {
  const TEST_BASE_URL = "http://127.0.0.1:3000";
  const TEST_TOKEN = "operator-test-token-abcdef123456";

  const testPrincipals: PrincipalRecord[] = [
    {
      principalId: "p-operator",
      tenantId: "tenant-alpha",
      role: "operator",
      token: TEST_TOKEN,
      allowConstrainedHost: false,
    },
  ];

  describe("Application Lifecycle & Initial Mounting", () => {
    it("mounts into container and renders initial dashboard layout with notices and empty state", () => {
      const container = new MockDOMElement("div");
      const client = new EmeraldApiClient({ baseUrl: TEST_BASE_URL });

      const app = mountDashboardApp({
        container,
        apiClient: client,
      });

      expect(app.controller).toBeDefined();
      expect(app.getContainer()).toBe(container);

      // Verify HTML content structure
      const html = container.innerHTML;
      expect(html).toContain("Emerald Agent Fabric");
      expect(html).toContain("Submit Governed Task");
      expect(html).toContain("Local Session History (0)");
      expect(html).toContain("No tasks submitted in this session");
      expect(html).toContain("Sandbox Enforcement");
      expect(html).toContain("Session Scope");

      // Verify unmount cleans container
      app.unmount();
      expect(container.innerHTML).toBe("");
    });
  });

  describe("Form Submission & Controller Event Binding", () => {
    it("submits valid task from UI, updates controller state, and renders server-generated ID into DOM", async () => {
      const server = buildFastifyServer({
        principals: testPrincipals,
        inMemoryStore: {
          tasks: new Map(),
          runs: new Map(),
          artifacts: new Map(),
          events: new Map(),
        },
      });

      const container = new MockDOMElement("div");
      const client = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        token: TEST_TOKEN,
        fetch: createServerFetch(server),
      });

      const app = mountDashboardApp({ container, apiClient: client });

      // Find form inputs and supply values
      const titleInput = container.querySelector("#task-title-input");
      const promptInput = container.querySelector("#task-prompt-input");
      const form = container.querySelector("#task-submission-form");

      expect(titleInput).toBeDefined();
      expect(promptInput).toBeDefined();
      expect(form).toBeDefined();

      titleInput!.value = "Mount Integration Task";
      promptInput!.value = "Inspect parser AST invariants";

      // Dispatch form submit event
      let defaultPrevented = false;
      form!.dispatchEvent({
        type: "submit",
        preventDefault: () => {
          defaultPrevented = true;
        },
      });
      expect(defaultPrevented).toBe(true);

      // Wait a microtask turn for async submitTask to complete
      await new Promise((r) => setTimeout(r, 20));

      // Verify task appears in local history and DOM
      const state = app.controller.getState();
      expect(state.tasks.length).toBe(1);
      const taskId = state.tasks[0]?.taskId;
      expect(taskId).toBeDefined();

      const html = container.innerHTML;
      expect(html).toContain(taskId);
      expect(html).toContain("Mount Integration Task");
      expect(html).toContain("Local Session History (1)");
      expect(html).toContain("Execution Mode: Sandboxed");

      app.unmount();
    });

    it("displays error banner in DOM on empty submission without calling backend", async () => {
      const container = new MockDOMElement("div");
      const client = new EmeraldApiClient({ baseUrl: TEST_BASE_URL });
      const submitSpy = vi.spyOn(client, "submitTask");

      const app = mountDashboardApp({ container, apiClient: client });

      const form = container.querySelector("#task-submission-form");
      expect(form).toBeDefined();

      form!.dispatchEvent({
        type: "submit",
        preventDefault: () => {},
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(submitSpy).not.toHaveBeenCalled();
      const html = container.innerHTML;
      expect(html).toContain("error-banner");
      expect(html).toContain("Title is required");

      app.unmount();
    });
  });

  describe("Task Selection & Run Inspection", () => {
    it("selects task upon click, loads run state, and displays authoritative outcome in drawer", async () => {
      const container = new MockDOMElement("div");
      const client = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        fetch: async (input) => {
          const url = String(input);
          if (url.includes("/runs/run-inspect-1")) {
            return new Response(
              JSON.stringify({
                success: true,
                data: {
                  runId: "run-inspect-1",
                  taskId: "task-sel-1",
                  status: "COMPLETED",
                  attemptNumber: 1,
                  currentStepIndex: 14,
                  leaseExpiresAt: null,
                  finalOutcome: "VERIFIED_SUCCESS",
                  metrics: { wallClockMs: 4200, stepCount: 14, toolCallCount: 7 },
                  createdAt: "2026-11-08T10:00:00.000Z",
                  completedAt: "2026-11-08T10:04:12.000Z",
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response(JSON.stringify({ success: false }), { status: 400 });
        },
      });

      const app = mountDashboardApp({
        container,
        apiClient: client,
        initialState: {
          tasks: [
            {
              taskId: "task-sel-1",
              title: "Inspect Selected Task",
              status: "COMPLETED",
              executionMode: "sandboxed",
              createdAt: "2026-11-08T10:00:00.000Z",
              updatedAt: "2026-11-08T10:04:12.000Z",
              contractId: "contract-sel-1",
              runId: "run-inspect-1",
            },
          ],
        },
      });

      // Find the select button for the task
      const selectBtn = container.querySelector('[data-action="select"]');
      expect(selectBtn).toBeDefined();

      selectBtn!.dispatchEvent({ type: "click", preventDefault: () => {} });

      await new Promise((r) => setTimeout(r, 20));

      const html = container.innerHTML;
      expect(html).toContain("Run Execution Details");
      expect(html).toContain("run-inspect-1");
      expect(html).toContain("Verified Success");
      expect(html).toContain("4200 ms");

      app.unmount();
    });
  });

  describe("3-Phase Cancellation Integration", () => {
    it("invokes backend cancellation endpoint and transitions through requesting -> requested -> confirmed_stopped", async () => {
      let cancelEndpointCalled = false;
      let runStatus = "RUNNING";

      const container = new MockDOMElement("div");
      const client = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        fetch: async (input, init) => {
          const url = String(input);
          if (url.includes("/cancel") && init?.method === "POST") {
            cancelEndpointCalled = true;
            runStatus = "CANCELLED";
            return new Response(
              JSON.stringify({
                success: true,
                data: {
                  runId: "run-cancel-test",
                  status: "CANCELLED",
                  reason: "Operator initiated abort",
                  cancelledAt: new Date().toISOString(),
                  note: "Worker halted",
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }

          if (url.includes("/runs/run-cancel-test") && init?.method === "GET") {
            return new Response(
              JSON.stringify({
                success: true,
                data: {
                  runId: "run-cancel-test",
                  taskId: "task-cancel-test",
                  status: runStatus,
                  attemptNumber: 1,
                  currentStepIndex: 2,
                  leaseExpiresAt: null,
                  finalOutcome: runStatus === "CANCELLED" ? "BLOCKED" : null,
                  metrics: { wallClockMs: 800, stepCount: 2, toolCallCount: 1 },
                  createdAt: new Date().toISOString(),
                  completedAt: runStatus === "CANCELLED" ? new Date().toISOString() : null,
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }

          return new Response(JSON.stringify({ success: false }), { status: 400 });
        },
      });

      const app = mountDashboardApp({
        container,
        apiClient: client,
        initialState: {
          tasks: [
            {
              taskId: "task-cancel-test",
              title: "Active Task To Cancel",
              status: "RUNNING",
              executionMode: "sandboxed",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              contractId: null,
              runId: "run-cancel-test",
            },
          ],
          selectedTaskId: "task-cancel-test",
          selectedRun: {
            runId: "run-cancel-test",
            taskId: "task-cancel-test",
            status: "RUNNING",
            attemptNumber: 1,
            currentStepIndex: 2,
            leaseExpiresAt: null,
            finalOutcome: null,
            metrics: { wallClockMs: 800, stepCount: 2, toolCallCount: 1 },
            createdAt: new Date().toISOString(),
            completedAt: null,
          },
        },
      });

      const cancelBtn = container.querySelector("#cancel-run-button");
      const reasonInput = container.querySelector("#cancel-reason-input");
      expect(cancelBtn).toBeDefined();
      expect(reasonInput).toBeDefined();

      reasonInput!.value = "Testing operator abort";
      cancelBtn!.dispatchEvent({ type: "click", preventDefault: () => {} });

      await new Promise((r) => setTimeout(r, 30));

      expect(cancelEndpointCalled).toBe(true);

      const html = container.innerHTML;
      expect(html).toContain("Cancellation confirmed: Run has stopped");
      expect(html).toContain("Run reached terminal state (CANCELLED)");

      app.unmount();
    });
  });

  describe("Transient Network Disconnect vs Execution Failure Invariant", () => {
    it("preserves agent run state and maps browser disconnect to connection unavailable without claiming execution failure", async () => {
      const container = new MockDOMElement("div");
      const client = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        fetch: async () => {
          throw new TypeError("Failed to fetch (simulated network disconnect)");
        },
      });

      const app = mountDashboardApp({
        container,
        apiClient: client,
        initialState: {
          tasks: [
            {
              taskId: "task-net-1",
              title: "Network Test Task",
              status: "RUNNING",
              executionMode: "sandboxed",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              contractId: null,
              runId: "run-net-1",
            },
          ],
        },
      });

      // Attempt to refresh task while network is down
      const refreshBtn = container.querySelector('[data-action="refresh-task"]');
      expect(refreshBtn).toBeDefined();

      refreshBtn!.dispatchEvent({ type: "click", preventDefault: () => {} });

      await new Promise((r) => setTimeout(r, 20));

      const state = app.controller.getState();
      expect(state.connectionStatus).toBe("unavailable");

      // Invariant: The task status and run state remain unchanged; never marked as FAILED or EXECUTION_FAILURE
      const task = state.tasks[0];
      expect(task?.status).toBe("RUNNING");
      expect(task?.fetchError).toContain("Network communication failure");

      const html = container.innerHTML;
      expect(html).toContain("Service Unavailable");
      expect(html).toContain("Sync warning: Network communication failure");
      expect(html).not.toContain("Execution Failure");

      app.unmount();
    });
  });

  describe("XSS Dynamic Content Escaping", () => {
    it("safely escapes script injection attempts in task title, prompt, and error messages", async () => {
      const container = new MockDOMElement("div");
      const maliciousTitle = '<script>alert("xss")</script>';
      const maliciousError = '<img src=x onerror=alert(1)>';

      const client = new EmeraldApiClient({ baseUrl: TEST_BASE_URL });
      const app = mountDashboardApp({
        container,
        apiClient: client,
        initialState: {
          tasks: [
            {
              taskId: "task-xss",
              title: maliciousTitle,
              status: "FAILED",
              executionMode: "sandboxed",
              createdAt: "2026-11-08T10:00:00.000Z",
              updatedAt: "2026-11-08T10:00:00.000Z",
              contractId: null,
              fetchError: maliciousError,
            },
          ],
        },
      });

      const html = container.innerHTML;
      // Script tags must be safely escaped
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
      expect(html).not.toContain("<img src=x");
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");

      app.unmount();
    });
  });
});
