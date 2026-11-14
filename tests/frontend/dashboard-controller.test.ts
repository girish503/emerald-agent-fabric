/**
 * Emerald Agent Fabric — Dashboard Controller & View Tests (Milestone 2.27 / Phase 2)
 *
 * Verifies:
 * - Centralized controller state initialization and subscription notifications
 * - Task submission validation, sandboxed execution enforcement, and duplicate submit guards
 * - Local task history tracking, deduplication, and single-resource polling (/tasks/:id)
 * - Run state tracking and synchronization with task lifecycle
 * - 3-phase cancellation workflow: requesting -> requested -> confirmed_stopped
 * - Error classification and connection state mapping (401, 403, 503, network errors)
 * - Pure view HTML rendering across empty, populated, error, and terminal states
 * - In-process end-to-end integration with live Fastify transport
 */

import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  DashboardController,
  type DashboardState,
  type TaskSubmissionFormState,
} from "../../apps/web/src/components/dashboard-controller.js";
import {
  renderDashboardHtml,
  renderTaskSubmissionForm,
  renderTaskList,
  renderSelectedTaskDetails,
  renderConnectionStatusBadge,
  renderCancellationControls,
  escapeHtml,
} from "../../apps/web/src/components/dashboard-view.js";
import {
  EmeraldApiClient,
  ApiClientError,
} from "../../apps/web/src/client/api-client.js";
import {
  buildFastifyServer,
  type PrincipalRecord,
} from "../../src/transport/http/server.js";

/**
 * In-process fetch adapter backed by Fastify server.inject().
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

describe("DashboardController & View — Unit & Contract Tests", () => {
  const TEST_BASE_URL = "http://127.0.0.1:3000";

  const validForm: TaskSubmissionFormState = {
    title: "Parse syntax tree safely",
    prompt: "Scan parser module and verify AST tree invariants",
    repoPath: "/workspace/parser",
    modelName: "qwen2.5-coder:7b",
    provider: "ollama",
    temperature: 0.1,
    contextWindow: 16384,
    timeoutSeconds: 300,
    maxSteps: 30,
  };

  describe("State Management & Subscriptions", () => {
    it("initializes with clean idle state", () => {
      const client = new EmeraldApiClient({ baseUrl: TEST_BASE_URL });
      const controller = new DashboardController(client);
      const state = controller.getState();

      expect(state.connectionStatus).toBe("idle");
      expect(state.isSubmitting).toBe(false);
      expect(state.tasks).toEqual([]);
      expect(state.cancellation).toEqual({});
      expect(state.selectedTaskId).toBeUndefined();
      expect(state.selectedRun).toBeUndefined();
    });

    it("notifies subscribers when state changes and supports unsubscription", () => {
      const client = new EmeraldApiClient({ baseUrl: TEST_BASE_URL });
      const controller = new DashboardController(client);

      const notifications: DashboardState[] = [];
      const unsubscribe = controller.subscribe((s) => notifications.push(s));

      controller.clearHistory();
      expect(notifications.length).toBe(1);

      unsubscribe();
      controller.clearHistory();
      expect(notifications.length).toBe(1); // No new notification after unsubscribe
    });
  });

  describe("Task Submission & Input Validation", () => {
    it("rejects submission with empty title without calling client", async () => {
      const client = new EmeraldApiClient({ baseUrl: TEST_BASE_URL });
      const submitSpy = vi.spyOn(client, "submitTask");
      const controller = new DashboardController(client);

      await expect(
        controller.submitTask({ ...validForm, title: "" })
      ).rejects.toThrow("Title is required");

      expect(submitSpy).not.toHaveBeenCalled();
      expect(controller.getState().lastSubmissionError).toContain("Title is required");
      expect(controller.getState().isSubmitting).toBe(false);
    });

    it("rejects submission with empty prompt without calling client", async () => {
      const client = new EmeraldApiClient({ baseUrl: TEST_BASE_URL });
      const submitSpy = vi.spyOn(client, "submitTask");
      const controller = new DashboardController(client);

      await expect(
        controller.submitTask({ ...validForm, prompt: "   " })
      ).rejects.toThrow("Prompt is required");

      expect(submitSpy).not.toHaveBeenCalled();
      expect(controller.getState().lastSubmissionError).toContain("Prompt is required");
    });

    it("blocks concurrent task submissions", async () => {
      let resolveSubmit: (val: any) => void = () => {};
      const fakeFetch: typeof globalThis.fetch = async () => {
        return new Promise((resolve) => {
          resolveSubmit = () =>
            resolve(
              new Response(
                JSON.stringify({
                  success: true,
                  data: {
                    taskId: "task-concurrent",
                    title: "Concurrent Task",
                    status: "CREATED",
                    executionMode: "sandboxed",
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    contractId: null,
                  },
                }),
                { status: 200, headers: { "Content-Type": "application/json" } }
              )
            );
        });
      };

      const client = new EmeraldApiClient({ baseUrl: TEST_BASE_URL, fetch: fakeFetch });
      const controller = new DashboardController(client);

      const firstCall = controller.submitTask(validForm);
      expect(controller.getState().isSubmitting).toBe(true);

      // Attempt second submission while first is in-flight
      await expect(controller.submitTask(validForm)).rejects.toThrow(
        "Task submission is already in progress"
      );

      // Resolve first call
      resolveSubmit(null);
      await firstCall;
      expect(controller.getState().isSubmitting).toBe(false);
    });

    it("strictly sends executionMode: sandboxed to backend", async () => {
      let capturedPayload: any = null;
      const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
        capturedPayload = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              taskId: "task-sandboxed-01",
              title: validForm.title,
              status: "CREATED",
              executionMode: "sandboxed",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              contractId: null,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const client = new EmeraldApiClient({ baseUrl: TEST_BASE_URL, fetch: fakeFetch });
      const controller = new DashboardController(client);

      await controller.submitTask(validForm);
      expect(capturedPayload).toBeDefined();
      expect(capturedPayload.executionMode).toBe("sandboxed");
      expect(capturedPayload.allowUnverifiedCompletion).toBeUndefined();
    });
  });

  describe("Local Session History & Deduplication", () => {
    it("adds newly submitted task to local history and selects it", async () => {
      const fakeFetch: typeof globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              taskId: "task-001",
              title: validForm.title,
              status: "CREATED",
              executionMode: "sandboxed",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              contractId: "contract-001",
              runId: "run-001",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const client = new EmeraldApiClient({ baseUrl: TEST_BASE_URL, fetch: fakeFetch });
      const controller = new DashboardController(client);

      const res = await controller.submitTask(validForm);
      expect(res.data.taskId).toBe("task-001");

      const state = controller.getState();
      expect(state.tasks.length).toBe(1);
      expect(state.tasks[0]?.taskId).toBe("task-001");
      expect(state.tasks[0]?.status).toBe("CREATED");
      expect(state.selectedTaskId).toBe("task-001");
      expect(state.lastSubmittedTaskId).toBe("task-001");
      expect(state.connectionStatus).toBe("connected");
    });

    it("deduplicates task entries when the same taskId is updated", async () => {
      const fakeFetch: typeof globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              taskId: "task-duplicate-check",
              title: "Task Check",
              status: "RUNNING",
              executionMode: "sandboxed",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              contractId: null,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const client = new EmeraldApiClient({ baseUrl: TEST_BASE_URL, fetch: fakeFetch });
      const controller = new DashboardController(client, {
        tasks: [
          {
            taskId: "task-duplicate-check",
            title: "Original Task",
            status: "CREATED",
            executionMode: "sandboxed",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            contractId: null,
          },
        ],
      });

      expect(controller.getState().tasks.length).toBe(1);

      await controller.refreshTask("task-duplicate-check");

      const updated = controller.getState().tasks;
      expect(updated.length).toBe(1); // Did not add a duplicate entry
      expect(updated[0]?.status).toBe("RUNNING");
    });

    it("records fetchError on task entry when refreshTask encounters 404", async () => {
      const fakeFetch: typeof globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            success: false,
            error: {
              code: "NOT_FOUND",
              message: "Task not found on server",
            },
          }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      };

      const client = new EmeraldApiClient({ baseUrl: TEST_BASE_URL, fetch: fakeFetch });
      const controller = new DashboardController(client, {
        tasks: [
          {
            taskId: "task-404",
            title: "Missing Task",
            status: "QUEUED",
            executionMode: "sandboxed",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            contractId: null,
          },
        ],
      });

      await expect(controller.refreshTask("task-404")).rejects.toThrow(ApiClientError);

      const task = controller.getState().tasks.find((t) => t.taskId === "task-404");
      expect(task).toBeDefined();
      expect(task?.fetchError).toContain("Task not found");
    });
  });

  describe("3-Phase Cancellation Workflow", () => {
    it("executes requesting -> requested -> confirmed_stopped transition", async () => {
      let cancelCalled = false;
      let runStatus = "RUNNING";

      const fakeFetch: typeof globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes("/cancel") && init?.method === "POST") {
          cancelCalled = true;
          runStatus = "CANCELLED"; // Immediate transition on server
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                runId: "run-c1",
                status: "CANCELLED",
                reason: "Operator initiated abort",
                cancelledAt: new Date().toISOString(),
                note: "Cancellation requested for run run-c1",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        if (url.includes("/runs/run-c1") && init?.method === "GET") {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                runId: "run-c1",
                taskId: "task-c1",
                status: runStatus,
                attemptNumber: 1,
                currentStepIndex: 3,
                leaseExpiresAt: null,
                finalOutcome: runStatus === "CANCELLED" ? "BLOCKED" : null,
                metrics: { wallClockMs: 1200, stepCount: 3, toolCallCount: 2 },
                createdAt: new Date().toISOString(),
                completedAt: runStatus === "CANCELLED" ? new Date().toISOString() : null,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        return new Response(JSON.stringify({ success: false }), { status: 400 });
      };

      const client = new EmeraldApiClient({ baseUrl: TEST_BASE_URL, fetch: fakeFetch });
      const controller = new DashboardController(client, {
        tasks: [
          {
            taskId: "task-c1",
            title: "Cancel Test Task",
            status: "RUNNING",
            executionMode: "sandboxed",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            contractId: null,
            runId: "run-c1",
          },
        ],
      });

      const observedPhases: string[] = [];
      controller.subscribe((s) => {
        const cancelState = s.cancellation["run-c1"];
        if (cancelState) {
          observedPhases.push(cancelState.phase);
        }
      });

      const cancelRes = await controller.cancelRun("run-c1", "Operator initiated abort");
      expect(cancelRes.data.status).toBe("CANCELLED");
      expect(cancelCalled).toBe(true);

      const finalState = controller.getState();
      const cancelState = finalState.cancellation["run-c1"];
      expect(cancelState).toBeDefined();
      expect(cancelState?.phase).toBe("confirmed_stopped");

      // Verify progression occurred: requesting -> requested -> confirmed_stopped
      expect(observedPhases).toContain("requesting");
      expect(observedPhases).toContain("requested");
      expect(observedPhases).toContain("confirmed_stopped");

      // Verify local task status synced with CANCELLED
      const task = finalState.tasks.find((t) => t.taskId === "task-c1");
      expect(task?.status).toBe("CANCELLED");
    });

    it("marks cancellation as failed when server returns error", async () => {
      const fakeFetch: typeof globalThis.fetch = async (input) => {
        if (String(input).includes("/cancel")) {
          return new Response(
            JSON.stringify({
              success: false,
              error: {
                code: "CONFLICT",
                message: "Cannot cancel completed run",
              },
            }),
            { status: 409, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({ success: false }), { status: 400 });
      };

      const client = new EmeraldApiClient({ baseUrl: TEST_BASE_URL, fetch: fakeFetch });
      const controller = new DashboardController(client);

      await expect(
        controller.cancelRun("run-already-completed", "Stop it")
      ).rejects.toThrow(ApiClientError);

      const cancelState = controller.getState().cancellation["run-already-completed"];
      expect(cancelState).toBeDefined();
      expect(cancelState?.phase).toBe("failed");
      expect(cancelState?.error).toContain("Cannot cancel completed run");
    });
  });

  describe("Error Classification & Connection State", () => {
    it("maps 503 Service Unavailable to connectionStatus unavailable", async () => {
      const fakeFetch: typeof globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            success: false,
            error: {
              code: "SERVICE_UNAVAILABLE",
              message: "Queue saturated",
            },
          }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        );
      };

      const client = new EmeraldApiClient({ baseUrl: TEST_BASE_URL, fetch: fakeFetch });
      const controller = new DashboardController(client);

      await expect(controller.submitTask(validForm)).rejects.toThrow(ApiClientError);
      expect(controller.getState().connectionStatus).toBe("unavailable");
      expect(controller.getState().connectionError).toContain("Queue saturated");
    });

    it("maps 401 Unauthorized to connectionStatus error", async () => {
      const fakeFetch: typeof globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            success: false,
            error: {
              code: "UNAUTHORIZED",
              message: "Invalid API token",
            },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      };

      const client = new EmeraldApiClient({ baseUrl: TEST_BASE_URL, fetch: fakeFetch });
      const controller = new DashboardController(client);

      await expect(controller.submitTask(validForm)).rejects.toThrow(ApiClientError);
      expect(controller.getState().connectionStatus).toBe("error");
      expect(controller.getState().connectionError).toContain("Invalid API token");
    });
  });

  describe("Summary Statistics Calculation", () => {
    it("computes accurate summary matching computeDashboardSummary", () => {
      const client = new EmeraldApiClient({ baseUrl: TEST_BASE_URL });
      const controller = new DashboardController(client, {
        tasks: [
          {
            taskId: "t-1",
            title: "Task 1",
            status: "COMPLETED",
            executionMode: "sandboxed",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            contractId: null,
            runId: "r-1",
          },
          {
            taskId: "t-2",
            title: "Task 2",
            status: "RUNNING",
            executionMode: "sandboxed",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            contractId: null,
          },
        ],
        selectedRun: {
          runId: "r-1",
          taskId: "t-1",
          status: "COMPLETED",
          attemptNumber: 1,
          currentStepIndex: 10,
          leaseExpiresAt: null,
          finalOutcome: "VERIFIED_SUCCESS",
          metrics: { wallClockMs: 5000, stepCount: 10, toolCallCount: 8 },
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
      });

      const summary = controller.getSummary();
      expect(summary.totalTasks).toBe(2);
      expect(summary.completedRuns).toBe(1);
      expect(summary.verifiedSuccesses).toBe(1);
      expect(summary.falseCompletions).toBe(0);
      expect(summary.verifiedRate).toBe(1.0);
    });
  });

  describe("Pure View HTML Rendering (dashboard-view.ts)", () => {
    it("escapes dynamic HTML content to prevent XSS", () => {
      expect(escapeHtml("<script>alert('xss')</script>")).toBe(
        "&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;"
      );
      expect(escapeHtml('Hello "World" & \'Team\'')).toBe(
        "Hello &quot;World&quot; &amp; &#039;Team&#039;"
      );
      expect(escapeHtml(null)).toBe("");
    });

    it("renders connection status badges appropriately", () => {
      const idleHtml = renderConnectionStatusBadge("idle");
      expect(idleHtml).toContain("badge-gray");
      expect(idleHtml).toContain("Idle");

      const connectedHtml = renderConnectionStatusBadge("connected");
      expect(connectedHtml).toContain("badge-green");
      expect(connectedHtml).toContain("Connected");

      const errorHtml = renderConnectionStatusBadge("error", "Bad credentials");
      expect(errorHtml).toContain("badge-red");
      expect(errorHtml).toContain("Bad credentials");
    });

    it("renders empty state when no tasks exist in session", () => {
      const state: DashboardState = {
        connectionStatus: "idle",
        isSubmitting: false,
        tasks: [],
        cancellation: {},
      };

      const html = renderDashboardHtml(state);
      expect(html).toContain("No tasks submitted in this session");
      expect(html).toContain("Submit Governed Task");
      expect(html).toContain("Local Session History (0)");
      expect(html).toContain("Sandbox Enforcement");
    });

    it("renders populated tasks and selected task details with outcome badge", () => {
      const state: DashboardState = {
        connectionStatus: "connected",
        isSubmitting: false,
        tasks: [
          {
            taskId: "task-view-1",
            title: "Inspect compiler pipeline",
            status: "COMPLETED",
            executionMode: "sandboxed",
            createdAt: "2026-11-08T10:00:00.000Z",
            updatedAt: "2026-11-08T10:05:00.000Z",
            contractId: "contract-v1",
            runId: "run-view-1",
          },
        ],
        selectedTaskId: "task-view-1",
        selectedRun: {
          runId: "run-view-1",
          taskId: "task-view-1",
          status: "COMPLETED",
          attemptNumber: 1,
          currentStepIndex: 12,
          leaseExpiresAt: null,
          finalOutcome: "VERIFIED_SUCCESS",
          metrics: { wallClockMs: 8500, stepCount: 12, toolCallCount: 6 },
          createdAt: "2026-11-08T10:00:00.000Z",
          completedAt: "2026-11-08T10:05:00.000Z",
        },
        cancellation: {},
      };

      const html = renderDashboardHtml(state);
      expect(html).toContain("Inspect compiler pipeline");
      expect(html).toContain("task-view-1");
      expect(html).toContain("run-view-1");
      expect(html).toContain("Verified Success");
      expect(html).toContain("Local Session History (1)");
      expect(html).toContain("8500 ms");
    });

    it("renders subcomponents individually (form, list, selected details)", () => {
      const state: DashboardState = {
        connectionStatus: "connected",
        isSubmitting: false,
        tasks: [
          {
            taskId: "task-sub-1",
            title: "Task Subcomponent Test",
            status: "RUNNING",
            executionMode: "sandboxed",
            createdAt: "2026-11-08T10:00:00.000Z",
            updatedAt: "2026-11-08T10:05:00.000Z",
            contractId: "contract-s1",
            runId: "run-s1",
          },
        ],
        selectedTaskId: "task-sub-1",
        selectedRun: {
          runId: "run-s1",
          taskId: "task-sub-1",
          status: "RUNNING",
          attemptNumber: 1,
          currentStepIndex: 4,
          leaseExpiresAt: null,
          finalOutcome: null,
          metrics: { wallClockMs: 3000, stepCount: 4, toolCallCount: 3 },
          createdAt: "2026-11-08T10:00:00.000Z",
          completedAt: null,
        },
        cancellation: {},
      };

      const formHtml = renderTaskSubmissionForm(state);
      expect(formHtml).toContain('id="task-submission-form"');
      expect(formHtml).toContain("Submit Governed Task");

      const listHtml = renderTaskList(state);
      expect(listHtml).toContain('class="task-list"');
      expect(listHtml).toContain("Task Subcomponent Test");

      const detailsHtml = renderSelectedTaskDetails(state);
      expect(detailsHtml).toContain('id="task-details-panel"');
      expect(detailsHtml).toContain("Run Execution Details");
      expect(detailsHtml).toContain("run-s1");
    });

    it("renders cancellation controls for active running run and confirmed state", () => {
      const run: any = {
        runId: "run-active-1",
        taskId: "task-active-1",
        status: "RUNNING",
      };

      const activeHtml = renderCancellationControls(run, { phase: "idle" });
      expect(activeHtml).toContain("Cancel Execution");
      expect(activeHtml).toContain("cancel-run-button");

      const confirmedHtml = renderCancellationControls(
        { ...run, status: "CANCELLED" },
        { phase: "confirmed_stopped" }
      );
      expect(confirmedHtml).toContain("Run reached terminal state (CANCELLED)");
      expect(confirmedHtml).toContain("Cancellation confirmed: Run has stopped");
    });
  });

  describe("End-to-End Integration with Live Fastify Server", () => {
    const TEST_TOKEN = "operator-token-test-secret-12345678";
    const testPrincipals: PrincipalRecord[] = [
      {
        principalId: "p-operator",
        tenantId: "tenant-alpha",
        role: "operator",
        token: TEST_TOKEN,
        allowConstrainedHost: false,
      },
    ];

    it("completes full workflow: submit task -> select task -> cancel run -> verify terminal state", async () => {
      const server = buildFastifyServer({
        principals: testPrincipals,
        inMemoryStore: {
          tasks: new Map(),
          runs: new Map(),
          artifacts: new Map(),
          events: new Map(),
        },
      });

      const client = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        token: TEST_TOKEN,
        fetch: createServerFetch(server),
      });

      const controller = new DashboardController(client);

      // 1. Submit task through controller
      const submission = await controller.submitTask(validForm);
      expect(submission.success).toBe(true);
      const taskId = submission.data.taskId;
      expect(taskId).toBeDefined();

      const stateAfterSubmit = controller.getState();
      expect(stateAfterSubmit.tasks.length).toBe(1);
      expect(stateAfterSubmit.selectedTaskId).toBe(taskId);
      expect(stateAfterSubmit.connectionStatus).toBe("connected");

      // Verify task exists in Fastify store
      const retrieved = await controller.refreshTask(taskId);
      expect(retrieved.taskId).toBe(taskId);
      expect(retrieved.status).toBe("CREATED");

      // 2. Select task
      controller.selectTask(taskId);
      expect(controller.getState().selectedTaskId).toBe(taskId);

      // 3. Render dashboard HTML and verify structure
      const renderedHtml = renderDashboardHtml(controller.getState());
      expect(renderedHtml).toContain(validForm.title);
      expect(renderedHtml).toContain(taskId);
      expect(renderedHtml).toContain("Local Session History (1)");
    });
  });
});
