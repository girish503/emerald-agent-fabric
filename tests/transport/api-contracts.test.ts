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
  ListTasksQuerySchema,
  ListTasksResponseSchema,
  TaskSummarySchema,
  VerificationSpecInputSchema,
  ALLOWED_VERIFICATION_EXECUTABLES,
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

    it("accepts structured verificationSpecs in task creation", () => {
      const parsed = CreateTaskRequestSchema.parse({
        title: "Test with verification",
        prompt: "Fix bug",
        modelConfig: { modelName: "qwen2.5-coder:7b" },
        verificationSpecs: [
          {
            specId: "vspec-test-1",
            name: "test-suite",
            argv: ["node", "test.js"],
            timeoutMs: 45000,
          },
        ],
      });

      expect(parsed.verificationSpecs).toHaveLength(1);
      expect(parsed.verificationSpecs[0]!.specId).toBe("vspec-test-1");
      expect(parsed.verificationSpecs[0]!.argv).toEqual(["node", "test.js"]);
    });

    it("rejects unallowlisted executable in verificationSpecs", () => {
      expect(() =>
        CreateTaskRequestSchema.parse({
          title: "Test",
          prompt: "Do something",
          modelConfig: { modelName: "qwen2.5-coder:7b" },
          verificationSpecs: [
            {
              argv: ["bash", "-c", "echo exploit"],
            },
          ],
        })
      ).toThrow(/allowlisted/);
    });

    it("rejects shell metacharacters in verificationSpecs argv", () => {
      expect(() =>
        CreateTaskRequestSchema.parse({
          title: "Test",
          prompt: "Do something",
          modelConfig: { modelName: "qwen2.5-coder:7b" },
          verificationSpecs: [
            {
              argv: ["node", "test.js; rm -rf /"],
            },
          ],
        })
      ).toThrow(/metacharacters/);
    });
  });

  describe("VerificationSpecInputSchema (ADR-0043)", () => {
    it("accepts valid structured argv specification", () => {
      const parsed = VerificationSpecInputSchema.parse({
        specId: "vspec-node-1",
        name: "node-runner",
        argv: ["node", "solution.js"],
        timeoutMs: 60000,
        expectedExitCode: 0,
      });

      expect(parsed.specId).toBe("vspec-node-1");
      expect(parsed.argv).toEqual(["node", "solution.js"]);
      expect(parsed.timeoutMs).toBe(60000);
      expect(parsed.expectedExitCode).toBe(0);
    });

    it("accepts valid legacy command specification with allowlisted binary", () => {
      const parsed = VerificationSpecInputSchema.parse({
        name: "test-run",
        command: "npm test",
        timeoutMs: 30000,
      });

      expect(parsed.command).toBe("npm test");
      expect(parsed.timeoutMs).toBe(30000);
    });

    it("rejects shell metacharacters in command string", () => {
      for (const badCmd of [
        "npm test; evil",
        "node test.js && whoami",
        "python3 -c 'print(1)' | grep 1",
        "node `cat /etc/passwd`",
        "pytest $SECRET_ENV",
        "node test.js > out.txt",
        "node test.js < in.txt",
        "node test.js\nevil",
      ]) {
        expect(() =>
          VerificationSpecInputSchema.parse({
            name: "malicious",
            command: badCmd,
          })
        ).toThrow(/metacharacters/);
      }
    });

    it("rejects prohibited executables", () => {
      for (const badExe of ["bash", "sh", "zsh", "curl", "wget", "rm", "sudo", "docker"]) {
        expect(() =>
          VerificationSpecInputSchema.parse({
            name: "prohibited",
            argv: [badExe, "arg"],
          })
        ).toThrow(/allowlisted/);
      }
    });

    it("verifies all allowlisted test runners are accepted with valid operations", () => {
      const sampleArgs: Record<string, string[]> = {
        node: ["node", "test.js"],
        npm: ["npm", "test"],
        npx: ["npx", "vitest"],
        vitest: ["vitest", "run"],
        jest: ["jest"],
        python: ["python", "test.py"],
        python3: ["python3", "test.py"],
        pytest: ["pytest"],
        cargo: ["cargo", "test"],
        go: ["go", "test"],
        ruby: ["ruby", "test.rb"],
        rake: ["rake", "test"],
        rspec: ["rspec"],
        mvn: ["mvn", "test"],
        gradle: ["gradle", "test"],
        dotnet: ["dotnet", "test"],
      };

      for (const exe of ALLOWED_VERIFICATION_EXECUTABLES) {
        const parsed = VerificationSpecInputSchema.parse({
          name: `runner-${exe}`,
          argv: sampleArgs[exe] ?? [exe, "test"],
        });
        expect(parsed.argv?.[0]).toBe(exe);
      }
    });

    it("rejects arbitrary code execution and evaluation flags", () => {
      const forbiddenFlagPayloads = [
        ["node", "-e", "process.exit(0)"],
        ["node", "--eval", "process.exit(0)"],
        ["node", "-r", "malicious.js", "test.js"],
        ["node", "--require", "malicious.js", "test.js"],
        ["node", "--inspect", "test.js"],
        ["node", "--prof", "test.js"],
        ["python3", "-c", "import os; os.system('id')"],
        ["python", "-c", "print(1)"],
        ["python3", "-i", "test.py"],
        ["ruby", "-e", "puts 1"],
      ];

      for (const badArgv of forbiddenFlagPayloads) {
        expect(() =>
          VerificationSpecInputSchema.parse({
            name: "eval-attack",
            argv: badArgv,
          })
        ).toThrow(/forbidden|arbitrary code execution/);
      }
    });

    it("rejects path traversal and absolute paths in verification arguments", () => {
      const traversalPayloads = [
        ["node", "../../etc/passwd"],
        ["node", "..\\Windows\\System32\\cmd.exe"],
        ["python3", "/root/secret.py"],
        ["pytest", "C:\\test\\run.py"],
      ];

      for (const badArgv of traversalPayloads) {
        expect(() =>
          VerificationSpecInputSchema.parse({
            name: "traversal-attack",
            argv: badArgv,
          })
        ).toThrow(/traversal|absolute path/);
      }
    });

    it("rejects disallowed npm subcommands", () => {
      const badNpmPayloads = [
        ["npm", "install", "malicious-pkg"],
        ["npm", "exec", "curl", "evil.com"],
        ["npm", "publish"],
      ];

      for (const badArgv of badNpmPayloads) {
        expect(() =>
          VerificationSpecInputSchema.parse({
            name: "npm-attack",
            argv: badArgv,
          })
        ).toThrow(/restricted to the 'test' subcommand/);
      }
    });

    it("rejects specification without both argv and command for EXIT_CODE_ZERO", () => {
      expect(() =>
        VerificationSpecInputSchema.parse({
          name: "empty-spec",
        })
      ).toThrow(/either non-empty 'argv' or 'command'/);
    });

    it("rejects invalid specId with special characters", () => {
      expect(() =>
        VerificationSpecInputSchema.parse({
          specId: "invalid/id!@#",
          argv: ["node", "test.js"],
        })
      ).toThrow();
    });

    it("rejects unknown properties strictly", () => {
      expect(() =>
        VerificationSpecInputSchema.parse({
          name: "valid",
          argv: ["node", "test.js"],
          unknownProp: "illegal",
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

  describe("ListTasksQuerySchema & ListTasksResponseSchema (Milestone 2.28)", () => {
    it("applies default limit of 20 when limit is omitted", () => {
      const parsed = ListTasksQuerySchema.parse({});
      expect(parsed.limit).toBe(20);
      expect(parsed.cursor).toBeUndefined();
      expect(parsed.status).toBeUndefined();
    });

    it("preprocesses string limit to integer", () => {
      const parsed = ListTasksQuerySchema.parse({ limit: "50" });
      expect(parsed.limit).toBe(50);
    });

    it("accepts valid boundary limits: 1 and 100", () => {
      expect(ListTasksQuerySchema.parse({ limit: 1 }).limit).toBe(1);
      expect(ListTasksQuerySchema.parse({ limit: 100 }).limit).toBe(100);
    });

    it("rejects invalid limits: 0, -1, 101, float, NaN", () => {
      expect(() => ListTasksQuerySchema.parse({ limit: 0 })).toThrow();
      expect(() => ListTasksQuerySchema.parse({ limit: -5 })).toThrow();
      expect(() => ListTasksQuerySchema.parse({ limit: 101 })).toThrow();
      expect(() => ListTasksQuerySchema.parse({ limit: 15.5 })).toThrow();
      expect(() => ListTasksQuerySchema.parse({ limit: "abc" })).toThrow();
    });

    it("rejects caller-supplied tenantId (strict tenant isolation)", () => {
      expect(() => ListTasksQuerySchema.parse({ tenantId: "tenant-other" })).toThrow();
    });

    it("rejects unknown query parameters with strict mode", () => {
      expect(() => ListTasksQuerySchema.parse({ extraParam: "value" })).toThrow();
      expect(() => ListTasksQuerySchema.parse({ sort: "desc" })).toThrow();
    });

    it("accepts valid status filter", () => {
      const parsed = ListTasksQuerySchema.parse({ status: "COMPLETED" });
      expect(parsed.status).toBe("COMPLETED");
    });

    it("rejects invalid status filter", () => {
      expect(() => ListTasksQuerySchema.parse({ status: "UNKNOWN_STATE" })).toThrow();
    });

    it("validates ListTasksResponseSchema and TaskSummarySchema", () => {
      const summary = {
        taskId: "task-001",
        tenantId: "tenant-alpha",
        title: "Test Task",
        status: "CREATED" as const,
        executionMode: "sandboxed" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        contractId: "contract-001",
        runId: "run-001",
      };
      expect(TaskSummarySchema.parse(summary)).toEqual(summary);

      const response = {
        success: true,
        data: [summary],
        nextCursor: "cursor_abc123",
      };
      const parsed = ListTasksResponseSchema.parse(response);
      expect(parsed.success).toBe(true);
      expect(parsed.data).toHaveLength(1);
      expect(parsed.nextCursor).toBe("cursor_abc123");
    });
  });

  describe("FROZEN_API_ROUTES", () => {
    it("declares all required task, run, streaming, and artifact endpoints", () => {
      const urls = FROZEN_API_ROUTES.map((r) => `${r.method} ${r.url}`);
      expect(urls).toContain("GET /api/v1/tasks");
      expect(urls).toContain("POST /api/v1/tasks");
      expect(urls).toContain("GET /api/v1/tasks/:taskId");
      expect(urls).toContain("GET /api/v1/runs/:runId");
      expect(urls).toContain("POST /api/v1/runs/:runId/cancel");
      expect(urls).toContain("GET /api/v1/runs/:runId/events");
      expect(urls).toContain("GET /api/v1/runs/:runId/artifacts");
    });
  });
});
