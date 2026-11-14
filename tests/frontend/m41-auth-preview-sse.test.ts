/**
 * Emerald Agent Fabric — M4.1 Workstreams C, E & F Verification Suite
 *
 * Covers:
 * - In-memory Bearer token auth gate (EmeraldApiClient.setAuthToken/clearAuthToken/whoami + DashboardController signInWithToken/signOut + autoLoadHistory=false)
 * - Bounded artifact content retrieval and XSS-safe diff preview in ArtifactViewer + DashboardController.selectArtifact
 * - Canonical SSE_EVENT_TYPES timeline alignment + multi-run summary aggregation across runsById
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import { EmeraldApiClient } from "../../apps/web/src/client/api-client.js";
import { DashboardController } from "../../apps/web/src/components/dashboard-controller.js";
import { renderArtifactViewer } from "../../apps/web/src/components/artifact-viewer.js";
import { renderDashboardHtml, renderSummaryCards } from "../../apps/web/src/components/dashboard-view.js";
import { buildTimelineSteps, isLegacyTimelineEvent } from "../../apps/web/src/components/workspace-views.js";
import { mountDashboardApp, type DOMElement } from "../../apps/web/src/app.js";
import { buildFastifyServer, type PrincipalRecord } from "../../src/transport/http/server.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { SettableClock } from "../../src/ports/clock.port.js";

const TOK_A_OP = "alpha-operator-token-aaaaaaaa1";

const PRINCIPALS: PrincipalRecord[] = [
  { token: TOK_A_OP, principalId: "principal-alpha-op", tenantId: "tenant-alpha", role: "operator" },
];

function createServerFetch(server: FastifyInstance): typeof globalThis.fetch {
  return (async (input: unknown, init?: any): Promise<Response> => {
    const parsed = new URL(typeof input === "string" ? input : String(input));
    const headers: Record<string, string> = {};
    if (init?.headers) {
      if (typeof (init.headers as Headers).forEach === "function") {
        (init.headers as Headers).forEach((v: string, k: string) => {
          headers[k] = v;
        });
      } else {
        Object.assign(headers, init.headers);
      }
    }
    const injectRes = await server.inject({
      method: (init?.method ?? "GET") as any,
      url: parsed.pathname + parsed.search,
      headers,
      payload: typeof init?.body === "string" ? init.body : undefined,
    });
    const responseHeaders = new Headers();
    for (const [k, v] of Object.entries(injectRes.headers ?? {})) {
      if (v !== undefined) responseHeaders.set(k, Array.isArray(v) ? v.join(", ") : String(v));
    }
    return new Response(injectRes.body, { status: injectRes.statusCode, headers: responseHeaders });
  }) as typeof globalThis.fetch;
}

class SimpleMockElement implements DOMElement {
  private _html = "";
  public value = "";
  public readonly listeners = new Map<string, Array<(e: any) => void>>();
  private readonly inputs = new Map<string, SimpleMockElement>();

  get innerHTML(): string {
    return this._html;
  }
  set innerHTML(val: string) {
    this._html = val;
    this.listeners.clear();
    this.inputs.clear();
  }
  querySelector<E extends DOMElement = DOMElement>(selector: string): E | null {
    if (selector === "#auth-token-input") {
      if (!this._html.includes('id="auth-token-input"')) return null;
      let el = this.inputs.get(selector);
      if (!el) {
        el = new SimpleMockElement();
        this.inputs.set(selector, el);
      }
      return el as unknown as E;
    }
    if (selector === "#auth-token-form" && this._html.includes('id="auth-token-form"')) {
      return this.getOrCreateChild(selector) as unknown as E;
    }
    if (selector === "#auth-signout-btn" && this._html.includes('id="auth-signout-btn"')) {
      return this.getOrCreateChild(selector) as unknown as E;
    }
    return null;
  }
  private getOrCreateChild(key: string): SimpleMockElement {
    let el = this.inputs.get(key);
    if (!el) {
      el = new SimpleMockElement();
      this.inputs.set(key, el);
    }
    return el;
  }
  querySelectorAll<E extends DOMElement = DOMElement>(_selector: string): E[] {
    return [];
  }
  addEventListener(event: string, handler: (e: any) => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(handler);
    this.listeners.set(event, arr);
  }
  dispatchEvent(event: any): boolean {
    const arr = this.listeners.get(event?.type) ?? [];
    for (const h of arr) void h(event);
    return true;
  }
  getAttribute(_name: string): string | null {
    return null;
  }
}

describe("M4.1 Frontend Auth Gate, Artifact Content Preview & Canonical SSE Alignment", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  function setupServer() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-m41-fe-"));
    const store = new SqliteStateStore({ location: path.join(tmpDir, "state.db") });
    const clock = new SettableClock("2026-11-12T10:00:00.000Z");
    const broadcaster = new EventEmitter();
    const coordinator = new RunCoordinator(store, clock, undefined, undefined, broadcaster);
    const server = buildFastifyServer({
      store,
      coordinator,
      eventBroadcaster: broadcaster,
      principals: PRINCIPALS,
      corsOrigins: [],
    });
    cleanups.push(async () => {
      await server.close().catch(() => {});
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    return { server, store, tmpDir };
  }

  it("does not fire unauthenticated requests when mounted with autoLoadHistory=false and signs in/out via in-memory token gate", async () => {
    const { server } = setupServer();
    let callCount = 0;
    const baseFetch = createServerFetch(server);
    const wrappedFetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      callCount += 1;
      return baseFetch(input, init);
    }) as typeof globalThis.fetch;

    const client = new EmeraldApiClient({
      baseUrl: "http://localhost:3000",
      fetch: wrappedFetch,
    });
    const container = new SimpleMockElement();
    const app = mountDashboardApp({
      container,
      apiClient: client,
      autoLoadHistory: false,
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(callCount).toBe(0);
    expect(container.innerHTML).toContain('id="auth-token-form"');

    // Attempt invalid token sign-in through form submit
    const form = container.querySelector("#auth-token-form")!;
    const input = container.querySelector("#auth-token-input")!;
    input.value = "wrong-token";
    form.dispatchEvent({ type: "submit" });

    await new Promise((r) => setTimeout(r, 40));
    expect(app.controller.getState().auth?.authenticated).toBe(false);
    expect(await client.getToken()).toBeNull();
    expect(container.innerHTML).toContain('id="auth-error-banner"');

    // Valid token sign-in succeeds via GET /api/v1/auth/whoami and loads history
    const form2 = container.querySelector("#auth-token-form")!;
    const input2 = container.querySelector("#auth-token-input")!;
    input2.value = TOK_A_OP;
    form2.dispatchEvent({ type: "submit" });

    await new Promise((r) => setTimeout(r, 50));
    const authedState = app.controller.getState();
    expect(authedState.auth?.authenticated).toBe(true);
    expect(authedState.auth?.principalId).toBe("principal-alpha-op");
    expect(authedState.auth?.tenantId).toBe("tenant-alpha");
    expect(authedState.auth?.role).toBe("operator");
    expect(container.innerHTML).toContain("principal-alpha-op");
    expect(container.innerHTML).not.toContain(TOK_A_OP);

    // Sign out clears in-memory token & returns to auth gate
    const signOutBtn = container.querySelector("#auth-signout-btn")!;
    signOutBtn.dispatchEvent({ type: "click" });
    expect(await client.getToken()).toBeNull();
    expect(app.controller.getState().auth?.authenticated).toBe(false);
    expect(container.innerHTML).toContain('id="auth-token-form"');

    app.unmount();
  });

  it("retrieves bounded artifact content preview on selectArtifact and escapes XSS payloads", async () => {
    const mockFetch = (async (input: unknown) => {
      const url = new URL(typeof input === "string" ? input : String(input));
      if (url.pathname.endsWith("/content")) {
        const diffBody = `--- a/app.ts\n+++ b/app.ts\n+<script>alert('xss')</script>\n${"+line\n".repeat(12000)}`;
        return new Response(diffBody, {
          status: 200,
          headers: {
            "content-type": "text/x-diff; charset=utf-8",
            etag: `"${"a".repeat(64)}"`,
            "content-disposition": 'attachment; filename="fix.diff"',
          },
        });
      }
      return new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const client = new EmeraldApiClient({
      baseUrl: "http://localhost:3000",
      token: TOK_A_OP,
      fetch: mockFetch,
    });
    const controller = new DashboardController(client, {
      selectedTaskId: "task-1",
      tasks: [
        {
          taskId: "task-1",
          title: "Preview patch",
          status: "COMPLETED",
          executionMode: "sandboxed",
          createdAt: "2026-11-12T10:00:00.000Z",
          updatedAt: "2026-11-12T10:01:00.000Z",
          contractId: "c-1",
          runId: "run-art-1",
        },
      ],
      selectedRun: {
        runId: "run-art-1",
        taskId: "task-1",
        status: "COMPLETED",
        attemptNumber: 1,
        currentStepIndex: 2,
        leaseExpiresAt: null,
        finalOutcome: "VERIFIED_SUCCESS",
        metrics: { wallClockMs: 500, stepCount: 2, toolCallCount: 1 },
        createdAt: "2026-11-12T10:00:00.000Z",
        completedAt: "2026-11-12T10:01:00.000Z",
      },
      artifacts: [
        {
          artifactId: "art-diff-1",
          runId: "run-art-1",
          relativePath: "patches/fix.diff",
          sha256: "a".repeat(64),
          byteSize: 2048,
          contentType: "text/x-diff",
          createdAt: "2026-11-12T10:01:00.000Z",
        },
      ],
    });

    controller.selectArtifact("art-diff-1");
    await new Promise((r) => setTimeout(r, 25));

    const st = controller.getState();
    expect(st.artifactPreviewLoading).toBe(false);
    expect(st.artifactPreview?.artifactId).toBe("art-diff-1");
    expect(st.artifactPreview?.truncated).toBe(true);

    const html = renderArtifactViewer({
      artifacts: st.artifacts,
      selectedArtifactId: st.selectedArtifactId,
      previewContent: st.artifactPreview,
      previewLoading: st.artifactPreviewLoading,
      previewError: st.artifactPreviewError,
    });
    expect(html).toContain('id="artifact-content-preview"');
    expect(html).toContain("Patch Diff Artifact (diff payload only)");
    expect(html).toContain("Truncated Preview");
    expect(html).toContain("&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
  });

  it("aligns buildTimelineSteps with canonical SSE_EVENT_TYPES while preserving isolated legacy event mapping and aggregates multiple runs in summary", () => {
    const canonicalSteps = buildTimelineSteps([
      {
        id: "e1",
        event: "run.queued",
        runId: "run-1",
        sequence: 1,
        timestamp: "2026-11-12T10:00:00.000Z",
        schemaVersion: 1,
        producer: "coordinator",
        data: {},
      },
      {
        id: "e2",
        event: "action.created",
        runId: "run-1",
        sequence: 2,
        timestamp: "2026-11-12T10:00:01.000Z",
        schemaVersion: 1,
        producer: "worker",
        data: { toolName: "read_file", args: { path: "README.md" } },
      },
      {
        id: "e3",
        event: "policy.evaluated",
        runId: "run-1",
        sequence: 3,
        timestamp: "2026-11-12T10:00:02.000Z",
        schemaVersion: 1,
        producer: "policy",
        data: { allowed: true },
      },
      {
        id: "e4",
        event: "action.completed",
        runId: "run-1",
        sequence: 4,
        timestamp: "2026-11-12T10:00:03.000Z",
        schemaVersion: 1,
        producer: "worker",
        data: { exitCode: 0, durationMs: 42 },
      },
      {
        id: "e5",
        event: "run.waiting_approval",
        runId: "run-1",
        sequence: 5,
        timestamp: "2026-11-12T10:00:04.000Z",
        schemaVersion: 1,
        producer: "governance",
        data: { approvalRequestId: "apr-1", reason: "High-risk command" },
      },
      {
        id: "e6",
        event: "verification.started",
        runId: "run-1",
        sequence: 6,
        timestamp: "2026-11-12T10:00:05.000Z",
        schemaVersion: 1,
        producer: "verifier",
        data: { specId: "vitest-check" },
      },
    ]);

    expect(canonicalSteps.length).toBe(3);
    expect(canonicalSteps[0]!.toolCalls[0]).toMatchObject({
      toolName: "read_file",
      approved: true,
      exitCode: 0,
      durationMs: 42,
    });
    expect(canonicalSteps[1]!.thought).toBe("Awaiting Operator Approval");
    expect(canonicalSteps[2]!.thought).toBe("Verification Started");

    expect(isLegacyTimelineEvent("agent.step.started")).toBe(true);
    expect(isLegacyTimelineEvent("verification.started")).toBe(false);

    const client = new EmeraldApiClient({ baseUrl: "http://localhost:3000", token: TOK_A_OP });
    const controller = new DashboardController(client, {
      tasks: [
        {
          taskId: "t1",
          title: "Run 1",
          status: "RUNNING",
          executionMode: "sandboxed",
          createdAt: "2026-11-12T10:00:00.000Z",
          updatedAt: "2026-11-12T10:00:00.000Z",
          contractId: "c1",
          runId: "r1",
        },
        {
          taskId: "t2",
          title: "Run 2",
          status: "COMPLETED",
          executionMode: "sandboxed",
          createdAt: "2026-11-12T10:01:00.000Z",
          updatedAt: "2026-11-12T10:02:00.000Z",
          contractId: "c2",
          runId: "r2",
        },
        {
          taskId: "t3",
          title: "Run 3",
          status: "COMPLETED",
          executionMode: "sandboxed",
          createdAt: "2026-11-12T10:02:00.000Z",
          updatedAt: "2026-11-12T10:03:00.000Z",
          contractId: "c3",
          runId: "r3",
        },
      ],
      selectedRun: {
        runId: "r2",
        taskId: "t2",
        status: "COMPLETED",
        attemptNumber: 1,
        currentStepIndex: 1,
        leaseExpiresAt: null,
        finalOutcome: "VERIFIED_SUCCESS",
        metrics: { wallClockMs: 100, stepCount: 1, toolCallCount: 1 },
        createdAt: "2026-11-12T10:01:00.000Z",
        completedAt: "2026-11-12T10:02:00.000Z",
      },
      runsById: {
        r1: {
          runId: "r1",
          taskId: "t1",
          status: "RUNNING",
          attemptNumber: 1,
          currentStepIndex: 1,
          leaseExpiresAt: null,
          finalOutcome: null,
          metrics: { wallClockMs: 50, stepCount: 1, toolCallCount: 0 },
          createdAt: "2026-11-12T10:00:00.000Z",
          completedAt: null,
        },
        r3: {
          runId: "r3",
          taskId: "t3",
          status: "COMPLETED",
          attemptNumber: 1,
          currentStepIndex: 1,
          leaseExpiresAt: null,
          finalOutcome: "FALSE_COMPLETION",
          metrics: { wallClockMs: 200, stepCount: 1, toolCallCount: 1 },
          createdAt: "2026-11-12T10:02:00.000Z",
          completedAt: "2026-11-12T10:03:00.000Z",
        },
      },
    });

    const summary = controller.getSummary();
    expect(summary.totalTasks).toBe(3);
    expect(summary.runningRuns).toBe(1);
    expect(summary.completedRuns).toBe(2);
    expect(summary.verifiedSuccesses).toBe(1);
    expect(summary.falseCompletions).toBe(1);
    expect(summary.verifiedRate).toBe(0.5);

    const cardsHtml = renderSummaryCards(controller.getState());
    expect(cardsHtml).toContain("50%");
    expect(renderDashboardHtml(controller.getState())).toContain('id="auth-gate-panel"');
  });
});
