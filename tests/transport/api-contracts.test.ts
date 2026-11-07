/**
 * Tests for Frozen Backend API Contracts (Milestone 2.25 / Track B)
 */

import { describe, expect, it } from "vitest";
import {
  API_VERSION,
  ApiErrorResponseSchema,
  API_ERROR_CODES,
  CreateTaskRequestSchema,
  RunResponseSchema,
  SseEventEnvelopeSchema,
  FROZEN_API_ROUTES,
  AuthorizationHeaderSchema,
  SSE_EVENT_TYPES,
  SSE_TERMINAL_EVENT_TYPES,
  SSE_CONTROL_EVENT_TYPES,
  StreamOverflowPayloadSchema,
  TaskResponseSchema,
} from "../../src/transport/http/api-contracts.js";
import { TRIAL_FINAL_OUTCOMES } from "../../src/domain/evaluation.js";

describe("Track B — Frozen Backend API Contracts", () => {
  it("exports current API version v1", () => {
    expect(API_VERSION).toBe("v1");
  });

  describe("CreateTaskRequestSchema", () => {
    it("accepts valid task submission with defaults", () => {
      const parsed = CreateTaskRequestSchema.parse({
        title: "Repair syntax error in parser.ts",
        prompt: "Fix unexpected token on line 42",
        modelConfig: {
          modelName: "qwen2.5-coder:7b",
        },
      });

      expect(parsed.title).toBe("Repair syntax error in parser.ts");
      expect(parsed.executionMode).toBe("sandboxed");
      expect("allowUnverifiedCompletion" in parsed).toBe(false);
      expect("taskId" in parsed).toBe(false);
      expect(parsed.resourceLimits.timeoutSeconds).toBe(1800);
      expect(parsed.resourceLimits.maxSteps).toBe(50);
      expect(parsed.modelConfig.provider).toBe("ollama");
      expect(parsed.modelConfig.temperature).toBe(0);
    });

    it("rejects task with empty prompt", () => {
      expect(() =>
        CreateTaskRequestSchema.parse({
          title: "Test",
          prompt: "",
          modelConfig: { modelName: "qwen2.5-coder:7b" },
        })
      ).toThrow();
    });

    it("rejects unknown executionMode", () => {
      expect(() =>
        CreateTaskRequestSchema.parse({
          title: "Test",
          prompt: "Do something",
          executionMode: "unrestricted_root",
          modelConfig: { modelName: "qwen2.5-coder:7b" },
        })
      ).toThrow();
    });
  });

  describe("ApiErrorResponseSchema", () => {
    it("validates standard error payload", () => {
      const valid = ApiErrorResponseSchema.parse({
        success: false,
        error: {
          code: "POLICY_DENIED",
          message: "Attempted to access protected path /test/verify.js",
          timestamp: new Date().toISOString(),
          traceId: "trace-abc-123",
        },
      });

      expect(valid.success).toBe(false);
      expect(valid.error.code).toBe("POLICY_DENIED");
    });

    it("includes all required error taxonomy codes", () => {
      expect(API_ERROR_CODES).toContain("TRANSIENT");
      expect(API_ERROR_CODES).toContain("PERMANENT");
      expect(API_ERROR_CODES).toContain("POLICY_DENIED");
      expect(API_ERROR_CODES).toContain("SANDBOX_ERROR");
      expect(API_ERROR_CODES).toContain("MODEL_ERROR");
      expect(API_ERROR_CODES).toContain("PAYLOAD_TOO_LARGE");
      expect(API_ERROR_CODES).toContain("UNSUPPORTED_MEDIA_TYPE");
      expect(API_ERROR_CODES).toContain("SERVICE_UNAVAILABLE");
      expect(API_ERROR_CODES).toContain("TOO_MANY_REQUESTS");
    });
  });

  describe("RunResponseSchema", () => {
    it("validates run with canonical final outcome", () => {
      const parsed = RunResponseSchema.parse({
        success: true,
        data: {
          runId: "run-001",
          taskId: "task-001",
          status: "COMPLETED",
          attemptNumber: 1,
          currentStepIndex: 12,
          leaseExpiresAt: null,
          finalOutcome: "VERIFIED_SUCCESS",
          metrics: {
            wallClockMs: 4250,
            stepCount: 12,
            toolCallCount: 15,
          },
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
      });

      expect(parsed.data.finalOutcome).toBe("VERIFIED_SUCCESS");
    });

    it("verifies all canonical 7 outcomes are supported in finalOutcome", () => {
      for (const outcome of TRIAL_FINAL_OUTCOMES) {
        const parsed = RunResponseSchema.parse({
          success: true,
          data: {
            runId: "run-001",
            taskId: "task-001",
            status: "COMPLETED",
            attemptNumber: 1,
            currentStepIndex: 5,
            leaseExpiresAt: null,
            finalOutcome: outcome,
            metrics: { wallClockMs: 100, stepCount: 5, toolCallCount: 5 },
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          },
        });
        expect(parsed.data.finalOutcome).toBe(outcome);
      }
    });
  });

  describe("SseEventEnvelopeSchema", () => {
    it("validates execution event envelope with monotonic sequence and schemaVersion 1", () => {
      const parsed = SseEventEnvelopeSchema.parse({
        id: "123e4567-e89b-12d3-a456-426614174000",
        event: "verification.completed",
        runId: "run-101",
        sequence: 4,
        timestamp: new Date().toISOString(),
        schemaVersion: 1,
        producer: "verification_runner",
        data: {
          specId: "spec-001",
          passed: true,
          exitCode: 0,
        },
      });

      expect(parsed.sequence).toBe(4);
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.producer).toBe("verification_runner");
    });
  });

  describe("AuthorizationHeaderSchema", () => {
    it("accepts valid Bearer token", () => {
      expect(AuthorizationHeaderSchema.parse("Bearer eyJhbGciOiJIUzI1NiJ9")).toBe(
        "Bearer eyJhbGciOiJIUzI1NiJ9"
      );
    });

    it("rejects non-Bearer format", () => {
      expect(() => AuthorizationHeaderSchema.parse("Basic dXNlcjpwYXNz")).toThrow();
      expect(() => AuthorizationHeaderSchema.parse("Bearer")).toThrow();
    });
  });

  describe("Remediation contract changes (security)", () => {
    const base = { title: "T", prompt: "P", modelConfig: { modelName: "m" } };

    it("rejects a client-supplied allowUnverifiedCompletion (unverified completion is never public)", () => {
      expect(CreateTaskRequestSchema.safeParse({ ...base, allowUnverifiedCompletion: true }).success).toBe(false);
      expect(CreateTaskRequestSchema.safeParse({ ...base, allowUnverifiedCompletion: false }).success).toBe(false);
    });

    it("rejects a client-supplied taskId (ids are server-generated) and any unknown key", () => {
      expect(CreateTaskRequestSchema.safeParse({ ...base, taskId: "123e4567-e89b-42d3-a456-426614174000" }).success).toBe(false);
      expect(CreateTaskRequestSchema.safeParse({ ...base, somethingElse: 1 }).success).toBe(false);
    });

    it("task responses carry no completion-override field and allow a null contractId", () => {
      const parsed = TaskResponseSchema.parse({
        success: true,
        data: {
          taskId: "task-1", title: "t", status: "CREATED", executionMode: "sandboxed",
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), contractId: null,
        },
      });
      expect("allowUnverifiedCompletion" in parsed.data).toBe(false);
    });

    it("declares only events the runtime actually emits: no stream.completed / sandbox.ready / tool.requested", () => {
      for (const never of ["stream.completed", "sandbox.ready", "tool.requested", "agent.step.started"]) {
        expect(SSE_EVENT_TYPES as readonly string[]).not.toContain(never);
      }
      for (const real of ["run.created", "run.completed", "run.timed_out", "verification.rejected", "verification.unverified_completion_authorized"]) {
        expect(SSE_EVENT_TYPES as readonly string[]).toContain(real);
      }
      for (const terminal of SSE_TERMINAL_EVENT_TYPES) expect(SSE_EVENT_TYPES as readonly string[]).toContain(terminal);
    });

    it("declares stream.overflow and stream.error as control events", () => {
      expect(SSE_CONTROL_EVENT_TYPES).toContain("stream.overflow");
      expect(SSE_CONTROL_EVENT_TYPES).toContain("stream.error");
      const parsed = StreamOverflowPayloadSchema.parse({ runId: "r", lastDeliveredSequence: 7, reason: "SLOW_CLIENT_BACKPRESSURE", recovery: "reconnect" });
      expect(parsed.lastDeliveredSequence).toBe(7);
    });
  });

  describe("FROZEN_API_ROUTES", () => {
    it("declares all required task, run, streaming, and artifact endpoints", () => {
      const urls = FROZEN_API_ROUTES.map((r) => `${r.method} ${r.url}`);
      expect(urls).toContain("POST /api/v1/tasks");
      expect(urls).toContain("GET /api/v1/tasks/:taskId");
      expect(urls).toContain("GET /api/v1/runs/:runId");
      expect(urls).toContain("POST /api/v1/runs/:runId/cancel");
      expect(urls).toContain("GET /api/v1/runs/:runId/events");
      expect(urls).toContain("GET /api/v1/runs/:runId/artifacts");
    });
  });
});
