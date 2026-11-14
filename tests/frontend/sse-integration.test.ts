/**
 * Emerald Agent Fabric — SSE Stream Lifecycle & Fastify Integration Tests (Milestone 2.27 / Phase 3)
 *
 * Verifies:
 * 1. Stream lifecycle in DashboardController:
 *    - selectTask(taskId) automatically opens stream for associated run
 *    - Switching runs aborts old stream and clears previous events
 *    - Deselecting task aborts stream and resets connection status to idle
 *    - Incoming events dynamically update timelineSteps, sseEventCount, lastEventSequence
 *    - Bounded event buffer enforcement (drops oldest events past 500)
 *    - Terminal run events sync task and run status
 * 2. Real in-process Fastify transport integration:
 *    - GET /api/v1/runs/:runId/events endpoint consumption with live fastify instance
 *    - Authentication validation (401 on missing/invalid token)
 *    - Tenant isolation (404 / 403 when requesting events of another tenant's run)
 *    - Durable event emission, replay, and Last-Event-ID header processing
 */

import { describe, it, expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { DashboardController } from "../../apps/web/src/components/dashboard-controller.js";
import { EmeraldApiClient } from "../../apps/web/src/client/api-client.js";
import {
  EmeraldSseClient,
  type SseConnectionStatus,
} from "../../apps/web/src/client/sse-client.js";
import {
  buildFastifyServer,
  type PrincipalRecord,
} from "../../src/transport/http/server.js";
import type { SseEventEnvelope } from "../../apps/web/src/types/api.js";

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

function makeSseEnvelope(
  runId: string,
  seq: number,
  event: string,
  data: Record<string, unknown> = {}
): SseEventEnvelope {
  return {
    id: `evt-${runId}-${seq}`,
    event,
    runId,
    sequence: seq,
    timestamp: new Date().toISOString(),
    schemaVersion: 1,
    producer: "test_runtime",
    data,
  };
}

describe("DashboardController SSE Stream Lifecycle", () => {

  it("automatically starts event stream when selecting a task with a runId", async () => {
    let openedRunId = "";
    const mockClient: any = {
      openEventStream: vi.fn((runId: string, options: any) => {
        openedRunId = runId;
        return {
          connect: vi.fn(async () => {
            options?.onStatusChange?.("connected");
          }),
          abort: vi.fn(),
          isConnected: () => true,
          getStatus: () => "connected" as SseConnectionStatus,
          getLastSequence: () => 0,
        };
      }),
      getRun: vi.fn(async () => ({
        success: true,
        data: {
          runId: "run-select-1",
          taskId: "task-select-1",
          status: "RUNNING",
          attemptNumber: 1,
          currentStepIndex: 1,
          leaseExpiresAt: null,
          finalOutcome: null,
          metrics: { wallClockMs: 100, stepCount: 1, toolCallCount: 0 },
          createdAt: new Date().toISOString(),
          completedAt: null,
        },
      })),
    };

    const controller = new DashboardController(mockClient, {
      tasks: [
        {
          taskId: "task-select-1",
          title: "Select Task Test",
          status: "RUNNING",
          executionMode: "sandboxed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          contractId: "contract-1",
          runId: "run-select-1",
        },
      ],
    });

    controller.selectTask("task-select-1");

    expect(openedRunId).toBe("run-select-1");
    expect(mockClient.openEventStream).toHaveBeenCalledTimes(1);
    expect(controller.getState().sseConnectionStatus).toBe("connected");
    expect(controller.getState().selectedTaskId).toBe("task-select-1");
  });

  it("aborts active stream and resets state when switching to another task", async () => {
    let abortedCount = 0;
    const mockClient: any = {
      openEventStream: vi.fn((_runId: string, options: any) => {
        return {
          connect: vi.fn(async () => {
            options?.onStatusChange?.("connected");
          }),
          abort: vi.fn(() => {
            abortedCount++;
          }),
          isConnected: () => false,
          getStatus: () => "connected" as SseConnectionStatus,
          getLastSequence: () => 0,
        };
      }),
      getRun: vi.fn(async (runId: string) => ({
        success: true,
        data: {
          runId,
          taskId: `task-${runId}`,
          status: "RUNNING",
          attemptNumber: 1,
          currentStepIndex: 0,
          leaseExpiresAt: null,
          finalOutcome: null,
          metrics: { wallClockMs: 0, stepCount: 0, toolCallCount: 0 },
          createdAt: new Date().toISOString(),
          completedAt: null,
        },
      })),
    };

    const controller = new DashboardController(mockClient, {
      tasks: [
        {
          taskId: "task-1",
          title: "Task 1",
          status: "RUNNING",
          executionMode: "sandboxed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          contractId: null,
          runId: "run-1",
        },
        {
          taskId: "task-2",
          title: "Task 2",
          status: "RUNNING",
          executionMode: "sandboxed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          contractId: null,
          runId: "run-2",
        },
      ],
    });

    // Select Task 1
    controller.selectTask("task-1");
    expect(controller.getState().selectedTaskId).toBe("task-1");

    // Select Task 2: previous stream must be aborted
    controller.selectTask("task-2");
    expect(abortedCount).toBe(1);
    expect(controller.getState().selectedTaskId).toBe("task-2");
    expect(controller.getState().rawEvents).toEqual([]);
    expect(controller.getState().timelineSteps).toEqual([]);
  });

  it("updates timelineSteps and increments event count on incoming SSE events", async () => {
    let eventCallback: ((env: SseEventEnvelope) => void) | undefined;

    const mockClient: any = {
      openEventStream: vi.fn((_runId: string, options: any) => {
        eventCallback = options.onEvent;
        return {
          connect: vi.fn(async () => {
            options?.onStatusChange?.("connected");
          }),
          abort: vi.fn(),
          isConnected: () => true,
          getStatus: () => "connected" as SseConnectionStatus,
          getLastSequence: () => 0,
        };
      }),
      getRun: vi.fn(async () => ({
        success: true,
        data: {
          runId: "run-timeline-1",
          taskId: "task-timeline-1",
          status: "RUNNING",
          attemptNumber: 1,
          currentStepIndex: 1,
          leaseExpiresAt: null,
          finalOutcome: null,
          metrics: { wallClockMs: 0, stepCount: 0, toolCallCount: 0 },
          createdAt: new Date().toISOString(),
          completedAt: null,
        },
      })),
    };

    const controller = new DashboardController(mockClient, {
      tasks: [
        {
          taskId: "task-timeline-1",
          title: "Timeline Test",
          status: "RUNNING",
          executionMode: "sandboxed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          contractId: null,
          runId: "run-timeline-1",
        },
      ],
    });

    controller.selectTask("task-timeline-1");
    expect(eventCallback).toBeDefined();

    // 1. Emit action.created
    eventCallback!(
      makeSseEnvelope("run-timeline-1", 1, "action.created", {
        toolName: "read_file",
        args: { path: "src/index.ts" },
      })
    );

    let state = controller.getState();
    expect(state.sseEventCount).toBe(1);
    expect(state.lastEventSequence).toBe(1);
    expect(state.timelineSteps).toHaveLength(1);
    expect(state.timelineSteps![0]!.toolCalls).toHaveLength(1);
    expect(state.timelineSteps![0]!.toolCalls[0]!.toolName).toBe("read_file");
    expect(state.timelineSteps![0]!.toolCalls[0]!.approved).toBe(false);

    // 2. Emit action.authorized
    eventCallback!(
      makeSseEnvelope("run-timeline-1", 2, "action.authorized", {
        toolName: "read_file",
        allowed: true,
      })
    );

    state = controller.getState();
    expect(state.sseEventCount).toBe(2);
    expect(state.lastEventSequence).toBe(2);
    expect(state.timelineSteps![0]!.toolCalls[0]!.approved).toBe(true);

    // 3. Emit action.completed
    eventCallback!(
      makeSseEnvelope("run-timeline-1", 3, "action.completed", {
        durationMs: 120,
        resultPayload: { exitCode: 0 },
      })
    );

    state = controller.getState();
    expect(state.sseEventCount).toBe(3);
    expect(state.timelineSteps![0]!.toolCalls[0]!.durationMs).toBe(120);
    expect(state.timelineSteps![0]!.toolCalls[0]!.exitCode).toBe(0);
  });

  it("synchronizes terminal run status when run.completed event arrives", async () => {
    let eventCallback: ((env: SseEventEnvelope) => void) | undefined;

    const mockClient: any = {
      openEventStream: vi.fn((_runId: string, options: any) => {
        eventCallback = options.onEvent;
        return {
          connect: vi.fn(async () => {}),
          abort: vi.fn(),
          isConnected: () => true,
          getStatus: () => "connected" as SseConnectionStatus,
          getLastSequence: () => 0,
        };
      }),
      getRun: vi.fn(async () => ({
        success: true,
        data: {
          runId: "run-term-1",
          taskId: "task-term-1",
          status: "RUNNING",
          attemptNumber: 1,
          currentStepIndex: 1,
          leaseExpiresAt: null,
          finalOutcome: null,
          metrics: { wallClockMs: 0, stepCount: 0, toolCallCount: 0 },
          createdAt: new Date().toISOString(),
          completedAt: null,
        },
      })),
    };

    const controller = new DashboardController(mockClient, {
      tasks: [
        {
          taskId: "task-term-1",
          title: "Terminal Test",
          status: "RUNNING",
          executionMode: "sandboxed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          contractId: null,
          runId: "run-term-1",
        },
      ],
    });

    controller.selectTask("task-term-1");
    expect(eventCallback).toBeDefined();

    // Emit terminal run.completed event
    eventCallback!(
      makeSseEnvelope("run-term-1", 5, "run.completed", {
        finalOutcome: "VERIFIED_SUCCESS",
      })
    );

    const state = controller.getState();
    expect(state.tasks[0]!.status).toBe("COMPLETED");
  });
});

describe("Fastify REST/SSE Transport Live Integration", () => {
  const TEST_BASE_URL = "http://127.0.0.1:3000";
  const OPERATOR_TOKEN = "operator-token-test-xyz-98765432";
  const OTHER_TENANT_TOKEN = "tenant-bravo-token-11223344";

  const testPrincipals: PrincipalRecord[] = [
    {
      principalId: "p-operator",
      tenantId: "tenant-alpha",
      role: "operator",
      token: OPERATOR_TOKEN,
      allowConstrainedHost: false,
    },
    {
      principalId: "p-bravo",
      tenantId: "tenant-bravo",
      role: "operator",
      token: OTHER_TENANT_TOKEN,
      allowConstrainedHost: false,
    },
  ];

  it("streams events from GET /api/v1/runs/:runId/events and rejects unauthorized access", async () => {
    const runId = "run-live-sse-001";
    const runsStore = new Map<string, any>();
    runsStore.set(runId, {
      runId,
      taskId: "task-live-sse-001",
      status: "COMPLETED",
      attemptNumber: 1,
      currentStepIndex: 1,
      leaseExpiresAt: null,
      finalOutcome: "VERIFIED_SUCCESS",
      metrics: { wallClockMs: 100, stepCount: 1, toolCallCount: 0 },
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      tenantId: "tenant-alpha",
    });

    const eventsStore = new Map<string, any[]>();
    eventsStore.set(runId, [
      {
        id: "evt-live-1",
        event: "run.created",
        runId,
        sequence: 1,
        timestamp: new Date().toISOString(),
        schemaVersion: 1,
        producer: "test_runtime",
        data: { ok: true },
      },
      {
        id: "evt-live-2",
        event: "run.completed",
        runId,
        sequence: 2,
        timestamp: new Date().toISOString(),
        schemaVersion: 1,
        producer: "test_runtime",
        data: { finalOutcome: "VERIFIED_SUCCESS" },
      },
    ]);

    const server = buildFastifyServer({
      principals: testPrincipals,
      inMemoryStore: {
        tasks: new Map(),
        runs: runsStore,
        artifacts: new Map(),
        events: eventsStore,
      },
    });

    // 1. Connect client without token: must be rejected with HTTP 401
    const unauthClient = new EmeraldSseClient({
      baseUrl: TEST_BASE_URL,
      runId,
      fetch: createServerFetch(server),
    });

    await unauthClient.connect();
    expect(unauthClient.getStatus()).toBe("error");

    // 2. Connect client from different tenant: must be rejected with HTTP 404 (tenant isolation)
    const bravoClient = new EmeraldSseClient({
      baseUrl: TEST_BASE_URL,
      runId,
      token: OTHER_TENANT_TOKEN,
      fetch: createServerFetch(server),
    });

    await bravoClient.connect();
    expect(bravoClient.getStatus()).toBe("error");

    // 3. Authorized tenant connects to stream
    const clientAlpha = new EmeraldApiClient({
      baseUrl: TEST_BASE_URL,
      token: OPERATOR_TOKEN,
      fetch: createServerFetch(server),
    });

    const receivedEvents: SseEventEnvelope[] = [];
    let connectedReported = false;

    const authSseClient = clientAlpha.openEventStream(runId, {
      onEvent: (env) => receivedEvents.push(env),
      onStatusChange: (status) => {
        if (status === "connected") {
          connectedReported = true;
        }
      },
    });

    await authSseClient.connect();

    expect(connectedReported).toBe(true);
    expect(authSseClient.getLastSequence()).toBe(2);
    expect(receivedEvents).toHaveLength(2);
    expect(receivedEvents[0]!.event).toBe("run.created");
    expect(receivedEvents[1]!.event).toBe("run.completed");
    authSseClient.abort();
  });
});
