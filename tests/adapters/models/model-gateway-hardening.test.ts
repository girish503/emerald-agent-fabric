import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  OllamaModelProvider,
  OpenAICompatibleModelProvider,
  retryIdempotentRead,
} from "../../../src/adapters/models/index.js";
import {
  ModelProviderError,
  ModelProviderUnavailableError,
  ModelRateLimitedError,
  ModelRequestInvalidError,
  ModelRequestTimeoutError,
  ModelResponseInvalidError,
} from "../../../src/domain/errors.js";
import { EmeraldLifecycleTelemetry } from "../../../src/application/observability-instrumentation.js";
import { EmeraldObservability } from "../../../src/infrastructure/monitoring/otel-observability.js";
import { LiveAgentBrain } from "../../../src/application/live-agent-brain.js";
import {
  ContextSnapshot,
  DEFAULT_CONTEXT_BUDGET,
  Observation,
  computeContextHash,
} from "../../../src/domain/context.js";
import { READ_FILE_TOOL } from "../../../src/domain/tool.js";
import { OllamaModelAdapter } from "../../../src/production/benchmark/ollama-model-adapter.js";
import type { ModelProviderPort, ModelProviderRequest } from "../../../src/ports/model-provider.port.js";
import { SqliteStateStore } from "../../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator, WorkerRuntime } from "../../../src/application/index.js";
import { BoundedRepairLoopController } from "../../../src/application/bounded-repair-loop.js";
import {
  GovernedModelRouterService,
  MAX_RATE_LIMIT_RETRIES_CAP,
  dispatchWithRateLimitRetry,
} from "../../../src/application/governed-model-router.js";
import { createVerificationSpec } from "../../../src/domain/verification.js";
import { SettableClock } from "../../../src/ports/clock.port.js";
import type { ExecutionProvider, ExecutionResult } from "../../../src/ports/execution-provider.port.js";
import { createAndActivateContract } from "../../application/test-helpers.js";

function makeRequest(overrides: Partial<ModelProviderRequest> = {}): ModelProviderRequest {
  return {
    requestId: "req-gw-1",
    traceId: "trace-gw-1",
    model: "qwen2.5:1.5b",
    input: [{ role: "user", content: "Hello" }],
    timeoutMs: 5000,
    ...overrides,
  };
}

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("Idea 3 Phase 2 — Model Gateway Hardening", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "EMERALD_MODEL_PROVIDER",
    "EMERALD_MODEL_BASE_URL",
    "OPENAI_BASE_URL",
    "EMERALD_MODEL_NAME",
    "EMERALD_API_KEY",
    "OPENAI_API_KEY",
    "EMERALD_ALLOWED_MODELS",
    "OLLAMA_ALLOWED_MODELS",
    "EMERALD_SPEND_CAP_USD",
    "EMERALD_STRICT_ENV_CONFIG",
    "OLLAMA_BASE_URL",
    "OLLAMA_MODEL",
  ];

  for (const k of envKeys) {
    savedEnv[k] = process.env[k];
  }

  afterEach(() => {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = savedEnv[k];
      }
    }
  });

  describe("1. Env-only config & no silent cloud fallback", () => {
    it("OpenAICompatibleModelProvider fails closed when baseURL is unset instead of silently falling back to Groq/OpenAI", async () => {
      delete process.env.EMERALD_MODEL_BASE_URL;
      delete process.env.OPENAI_BASE_URL;
      let fetchCalls = 0;

      const provider = new OpenAICompatibleModelProvider({
        apiKey: "test-key-local",
        defaultModel: "qwen2.5:1.5b",
        spendCapUsd: 1,
        fetch: async () => {
          fetchCalls++;
          return new Response("{}", { status: 200 });
        },
      });

      await expect(provider.generate(makeRequest())).rejects.toThrow(ModelProviderUnavailableError);
      expect(fetchCalls).toBe(0);
    });

    it("OpenAICompatibleModelProvider reads endpoint, model, allowlist, key, and spendCap strictly from env", async () => {
      process.env.EMERALD_MODEL_PROVIDER = "local-vllm";
      process.env.EMERALD_MODEL_BASE_URL = "http://127.0.0.1:8000/v1";
      process.env.EMERALD_MODEL_NAME = "qwen2.5:1.5b";
      process.env.EMERALD_API_KEY = "local-dummy-token";
      process.env.EMERALD_ALLOWED_MODELS = "qwen2.5:1.5b";
      process.env.EMERALD_SPEND_CAP_USD = "1.5";

      let calledUrl = "";
      const provider = new OpenAICompatibleModelProvider({
        fetch: async (input) => {
          calledUrl = String(input);
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        },
      });

      expect(provider.providerName).toBe("local-vllm");
      const res = await provider.generate(makeRequest({ model: "qwen2.5:1.5b" }));
      expect(calledUrl).toBe("http://127.0.0.1:8000/v1/chat/completions");
      expect(res.outputText).toBe("ok");
    });

    it("OllamaModelProvider under EMERALD_STRICT_ENV_CONFIG=true fails closed if OLLAMA_BASE_URL is unset", async () => {
      process.env.EMERALD_STRICT_ENV_CONFIG = "true";
      delete process.env.OLLAMA_BASE_URL;
      let fetchCalls = 0;

      const provider = new OllamaModelProvider({
        defaultModel: "qwen2.5:1.5b",
        fetch: async () => {
          fetchCalls++;
          return new Response("{}", { status: 200 });
        },
      });

      await expect(provider.generate(makeRequest())).rejects.toThrow(ModelProviderUnavailableError);
      expect(fetchCalls).toBe(0);
    });
  });

  describe("2. Allowlist enforcement (fail-closed)", () => {
    it("OllamaModelProvider rejects unknown/unallowlisted models before dispatch", async () => {
      let fetchCalls = 0;
      const provider = new OllamaModelProvider({
        allowedModels: ["qwen2.5:1.5b"],
        fetch: async () => {
          fetchCalls++;
          return new Response("{}", { status: 200 });
        },
      });

      await expect(provider.generate(makeRequest({ model: "gpt-4o" }))).rejects.toThrow(
        ModelRequestInvalidError
      );
      expect(fetchCalls).toBe(0);
    });

    it("OpenAICompatibleModelProvider rejects unallowlisted models before dispatch", async () => {
      let fetchCalls = 0;
      const provider = new OpenAICompatibleModelProvider({
        baseURL: "http://127.0.0.1:8000/v1",
        apiKey: "local-dummy-token",
        allowedModels: ["qwen2.5:1.5b"],
        spendCapUsd: 1,
        fetch: async () => {
          fetchCalls++;
          return new Response("{}", { status: 200 });
        },
      });

      await expect(provider.generate(makeRequest({ model: "claude-3-7-sonnet" }))).rejects.toThrow(
        ModelRequestInvalidError
      );
      expect(fetchCalls).toBe(0);
    });
  });

  describe("3. Spend-cap enforcement (fail-closed)", () => {
    it("OpenAICompatibleModelProvider rejects immediately when spendCapUsd is 0", async () => {
      let fetchCalls = 0;
      const provider = new OpenAICompatibleModelProvider({
        baseURL: "http://127.0.0.1:8000/v1",
        apiKey: "local-dummy-token",
        allowedModels: ["qwen2.5:1.5b"],
        spendCapUsd: 0,
        fetch: async () => {
          fetchCalls++;
          return new Response("{}", { status: 200 });
        },
      });

      await expect(provider.generate(makeRequest())).rejects.toThrow(ModelProviderError);
      expect(fetchCalls).toBe(0);
    });

    it("OpenAICompatibleModelProvider halts fail-closed on the call after cumulative spend reaches spendCapUsd", async () => {
      let fetchCalls = 0;
      const provider = new OpenAICompatibleModelProvider({
        baseURL: "http://127.0.0.1:8000/v1",
        apiKey: "local-dummy-token",
        allowedModels: ["qwen2.5:1.5b"],
        spendCapUsd: 0.0005,
        fetch: async () => {
          fetchCalls++;
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
              // 1000 input ($0.00015) + 1000 output ($0.00060) = $0.00075 > $0.0005
              usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        },
      });

      await provider.generate(makeRequest({ requestId: "req-cap-1" }));
      expect(fetchCalls).toBe(1);
      expect(provider.cumulativeSpend.costUsd).toBeGreaterThan(0.0005);

      await expect(provider.generate(makeRequest({ requestId: "req-cap-2" }))).rejects.toThrow(
        /Spend cap/
      );
      expect(fetchCalls).toBe(1);
    });

    it("rejects malformed/NaN EMERALD_SPEND_CAP_USD fail-closed in constructor", () => {
      process.env.EMERALD_SPEND_CAP_USD = "not-a-number";
      expect(
        () =>
          new OpenAICompatibleModelProvider({
            baseURL: "http://127.0.0.1:8000/v1",
            apiKey: "local-dummy-token",
          })
      ).toThrow(ModelProviderError);
    });
  });

  describe("4. Per-request timeout & single-attempt (no POST retries)", () => {
    it("OpenAICompatibleModelProvider enforces timeoutMs fail-closed with ModelRequestTimeoutError", async () => {
      const provider = new OpenAICompatibleModelProvider({
        baseURL: "http://127.0.0.1:8000/v1",
        apiKey: "local-dummy-token",
        allowedModels: ["qwen2.5:1.5b"],
        spendCapUsd: 1,
        fetch: async (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(init.signal?.reason ?? new Error("Aborted"));
            });
          }),
      });

      await expect(provider.generate(makeRequest({ timeoutMs: 25 }))).rejects.toThrow(
        ModelRequestTimeoutError
      );
    });

    it("OpenAICompatibleModelProvider never retries mutating POST calls on HTTP 429", async () => {
      let fetchCalls = 0;
      const provider = new OpenAICompatibleModelProvider({
        baseURL: "http://127.0.0.1:8000/v1",
        apiKey: "local-dummy-token",
        allowedModels: ["qwen2.5:1.5b"],
        spendCapUsd: 1,
        fetch: async () => {
          fetchCalls++;
          return new Response("rate limited", { status: 429 });
        },
      });

      await expect(provider.generate(makeRequest())).rejects.toThrow(ModelRateLimitedError);
      expect(fetchCalls).toBe(1);
    });

    it("retryIdempotentRead retries bounded times for idempotent reads only", async () => {
      let attempts = 0;
      const res = await retryIdempotentRead(
        "idempotent_read",
        async () => {
          attempts++;
          if (attempts < 3) throw new Error("transient");
          return "ok";
        },
        { maxRetries: 2, baseDelayMs: 10 }
      );
      expect(res).toBe("ok");
      expect(attempts).toBe(3);

      await expect(
        retryIdempotentRead("mutating_post" as unknown as "idempotent_read", async () => "no")
      ).rejects.toThrow(/idempotent read/);
    });
  });

  describe("5. Tokens, cost, latency logged with traceId and zero secret leakage", () => {
    it("logs tokens, costUsd, durationMs, and traceId on success and failure without leaking API keys or prompts", async () => {
      const obs = new EmeraldObservability({ logToStderr: false });
      const logs: Array<Record<string, unknown>> = [];
      const origEmitLog = obs.emitLog.bind(obs);
      obs.emitLog = (severity, event, message, attributes) => {
        logs.push({ severity, event, message, attributes });
        origEmitLog(severity, event, message, attributes);
      };
      const telemetry = new EmeraldLifecycleTelemetry(obs, undefined, {
        defaultExecutionMode: "fixture",
      });

      const secretApiKey = "sk-proj-UltraSecretGatewayKey987654";
      const secretPromptText = "Here is a secret token ghp_SuperSecretPromptToken123456";

      const provider = new OpenAICompatibleModelProvider({
        baseURL: "http://127.0.0.1:8000/v1",
        apiKey: secretApiKey,
        allowedModels: ["qwen2.5:1.5b"],
        spendCapUsd: 1,
        telemetry,
        fetch: async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "done" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ),
      });

      await provider.generate(
        makeRequest({
          requestId: "req-log-1",
          traceId: "trace-run-xyz",
          input: [{ role: "user", content: secretPromptText }],
        })
      );

      // Force a failure call too (HTTP 500 leaking a secret in body)
      const failingProvider = new OpenAICompatibleModelProvider({
        baseURL: "http://127.0.0.1:8000/v1",
        apiKey: secretApiKey,
        allowedModels: ["qwen2.5:1.5b"],
        spendCapUsd: 1,
        telemetry,
        fetch: async () =>
          new Response(`upstream failed with Bearer ${secretApiKey}`, { status: 500 }),
      });

      await expect(
        failingProvider.generate(
          makeRequest({
            requestId: "req-log-2",
            traceId: "trace-run-err",
          })
        )
      ).rejects.toThrow(ModelProviderUnavailableError);

      const modelLogs = logs.filter((l) => l.event === "model.invocation");
      expect(modelLogs).toHaveLength(2);

      const okAttrs = modelLogs[0]!.attributes as Record<string, unknown>;
      expect(okAttrs.traceId).toBe("trace-run-xyz");
      expect(okAttrs.promptTokens).toBe(100);
      expect(okAttrs.completionTokens).toBe(50);
      expect(typeof okAttrs.costUsd).toBe("number");
      expect(okAttrs.costUsd).toBeGreaterThan(0);
      expect(typeof okAttrs.durationMs).toBe("number");

      const errAttrs = modelLogs[1]!.attributes as Record<string, unknown>;
      expect(errAttrs.traceId).toBe("trace-run-err");
      expect(errAttrs.status).toBe("unavailable");
      expect(errAttrs.costUsd).toBe(0);

      const serializedAll = JSON.stringify(logs);
      expect(serializedAll).not.toContain(secretApiKey);
      expect(serializedAll).not.toContain("ghp_SuperSecretPromptToken123456");
    });

    it("LiveAgentBrain propagates traceId onto ModelProviderRequest", async () => {
      let capturedTraceId: string | undefined;
      const fakeProvider: ModelProviderPort = {
        providerName: "fake",
        async generate(req) {
          capturedTraceId = req.traceId;
          return {
            requestId: req.requestId,
            model: req.model,
            outputText: JSON.stringify({ isGoalReached: true, rationale: "done" }),
            finishReason: "STOP",
            durationMs: 1,
          };
        },
      };

      const brain = new LiveAgentBrain({
        modelProvider: fakeProvider,
        model: "qwen2.5:1.5b",
      });

      const observations: Observation[] = [
        {
          observationId: "obs-gw-1",
          category: "RUN_STATE",
          provenance: {
            entityKind: "Run",
            entityId: "run-trace-prop-1",
            runId: "run-trace-prop-1",
            timestamp: "2026-11-26T10:00:00.000Z",
            isAuthoritativeRuntimeFact: true,
          },
          freshness: "CURRENT",
          priority: 100,
          content: { status: "RUNNING" },
          contentHash: "a".repeat(64),
          estimatedTokens: 10,
          estimatedBytes: 32,
          isMandatory: true,
        },
      ];
      const snapshot: ContextSnapshot = {
        snapshotId: "snap-gw-1",
        runId: "run-trace-prop-1",
        taskId: "task-trace-prop-1",
        policyVersion: "context-policy-v1",
        createdAt: "2026-11-26T10:00:00.000Z",
        budget: DEFAULT_CONTEXT_BUDGET,
        observations,
        omittedObservationsCount: 0,
        omittedObservationsSummary: [],
        totalEstimatedTokens: 10,
        totalBytes: 32,
        contextHash: computeContextHash({
          runId: "run-trace-prop-1",
          taskId: "task-trace-prop-1",
          policyVersion: "context-policy-v1",
          budget: DEFAULT_CONTEXT_BUDGET,
          observations,
        }),
      };

      await brain.proposeAction({
        runId: "run-trace-prop-1",
        contextSnapshot: snapshot,
        availableTools: [READ_FILE_TOOL],
        sequenceNumber: 1,
      });

      expect(capturedTraceId).toBe("trace-run-trace-prop-1");
    });
  });

  describe("6. Fail-closed provider errors & zero bypass outside src/adapters/models", () => {
    it("OpenAICompatibleModelProvider fails closed on malformed choices without returning fake text", async () => {
      const provider = new OpenAICompatibleModelProvider({
        baseURL: "http://127.0.0.1:8000/v1",
        apiKey: "local-dummy-token",
        allowedModels: ["qwen2.5:1.5b"],
        spendCapUsd: 1,
        fetch: async () =>
          new Response(JSON.stringify({ choices: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      });

      await expect(provider.generate(makeRequest())).rejects.toThrow(ModelResponseInvalidError);
    });

    it("OllamaModelAdapter routes proposeAction through ModelProviderPort (/api/chat)", async () => {
      let calledUrl = "";
      const adapter = new OllamaModelAdapter(
        "qwen2.5:1.5b",
        "http://127.0.0.1:11434",
        5000,
        false,
        async (url) => {
          calledUrl = String(url);
          return new Response(
            JSON.stringify({
              model: "qwen2.5:1.5b",
              message: {
                role: "assistant",
                content: JSON.stringify({
                  thought: "inspect",
                  toolName: "read_file",
                  toolInput: { path: "README.md" },
                }),
              },
              done: true,
              done_reason: "stop",
              prompt_eval_count: 15,
              eval_count: 8,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
      );

      const proposal = await adapter.proposeAction("read README.md");
      expect(calledUrl).toBe("http://127.0.0.1:11434/api/chat");
      expect(proposal.toolName).toBe("read_file");
    });

    it("no-bypass: zero direct model inference HTTP calls exist in src/ outside src/adapters/models/", () => {
      const srcRoot = path.resolve(process.cwd(), "src");
      const modelsDir = path.join(srcRoot, "adapters", "models");
      const files = collectSourceFiles(srcRoot);
      const bypasses: string[] = [];

      const modelEndpointPattern = /\/api\/(?:chat|generate)\b|\/chat\/completions\b/;

      for (const file of files) {
        if (file.startsWith(modelsDir)) continue;
        const content = fs.readFileSync(file, "utf8");
        if (content.includes("fetch(") && modelEndpointPattern.test(content)) {
          bypasses.push(path.relative(process.cwd(), file));
        }
      }

      expect(bypasses).toEqual([]);
    });

    it("no fake NOOP model fallback stub remains in worker-runtime.ts", () => {
      const wrPath = path.resolve(process.cwd(), "src/application/worker-runtime.ts");
      const content = fs.readFileSync(wrPath, "utf8");
      expect(content).not.toContain('reasoning: "Fallback"');
    });

    it("WorkerRuntime repair execution without modelAdapter returns MODEL_PROVIDER_UNAVAILABLE, concludes verification, and stops run with no fake action", async () => {
      const clock = new SettableClock();
      const store = new SqliteStateStore();
      const coordinator = new RunCoordinator(store, clock);

      const executeSpy = vi.fn<ExecutionProvider["execute"]>().mockResolvedValue({
        status: "SUCCESS",
        output: { sum: 99 },
        durationMs: 5,
        providerMetadata: { provider: "in-process", exitCode: 0 },
      } as ExecutionResult);

      const executionProvider: ExecutionProvider = {
        name: "in-process",
        tenantModel: "NONE",
        quiescence: {
          async quiesceRun() {
            return { status: "QUIESCENT", stopped: 0 };
          },
        },
        execute: executeSpy as ExecutionProvider["execute"],
      };

      const repairController = new BoundedRepairLoopController({ maxRepairIterations: 3 });
      const concludeSpy = vi.spyOn(repairController, "concludeVerification");
      const executeRepairSessionSpy = vi.fn();

      const worker = new WorkerRuntime({
        workerId: "worker-missing-adapter",
        coordinator,
        clock,
        executionProvider,
        repairController,
        repairOrchestrator: { executeRepairSession: executeRepairSessionSpy } as any,
      });

      const task = coordinator.createTask({
        title: "echo",
        inputPayload: { missionId: "mission-missing-adapter-1" },
      });
      const verificationSpec = createVerificationSpec({
        specId: "spec-expect-5",
        ruleKind: "EXACT_OUTPUT_MATCH",
        expectedValue: { sum: 5 },
      });
      createAndActivateContract(store, task.taskId, { verificationSpecs: [verificationSpec] });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);

      const result = await worker.runOnce(run.runId);

      expect(result.status).toBe("FAILED");
      if (result.status !== "FAILED") {
        throw new Error(`Expected FAILED status, got ${result.status}`);
      }
      const errPayload = result.error as { code?: string; message?: string };
      expect(errPayload.code).toBe("MODEL_PROVIDER_UNAVAILABLE");
      expect(errPayload.message).toContain("has no modelAdapter");
      expect(concludeSpy).toHaveBeenCalledTimes(1);
      expect(concludeSpy).toHaveBeenCalledWith(expect.objectContaining({ runId: run.runId }), 1);
      expect(executeRepairSessionSpy).not.toHaveBeenCalled();
      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(coordinator.getRun(run.runId)?.status).toBe("FAILED");
    });
  });

  describe("7. Router/Caller-level bounded 429 & non-processed 5xx retry", () => {
    it("OpenAICompatibleModelProvider.generate() remains single-attempt on 429 and attaches parsed Retry-After ms", async () => {
      let fetchCalls = 0;
      const provider = new OpenAICompatibleModelProvider({
        baseURL: "http://127.0.0.1:8000/v1",
        apiKey: "local-dummy-token",
        allowedModels: ["qwen2.5:1.5b"],
        spendCapUsd: 1,
        fetch: async () => {
          fetchCalls++;
          return new Response(JSON.stringify({ error: { message: "rate limit" } }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": "1.5" },
          });
        },
      });

      let thrown: unknown;
      try {
        await provider.generate(makeRequest());
      } catch (err) {
        thrown = err;
      }

      expect(fetchCalls).toBe(1);
      expect(thrown).toBeInstanceOf(ModelRateLimitedError);
      expect((thrown as ModelRateLimitedError).retryAfterMs).toBe(1500);
    });

    it("429 with Retry-After retries at router/caller level and succeeds", async () => {
      let fetchCalls = 0;
      const sleptMs: number[] = [];
      const provider = new OpenAICompatibleModelProvider({
        baseURL: "http://127.0.0.1:8000/v1",
        apiKey: "local-dummy-token",
        allowedModels: ["qwen2.5:1.5b"],
        spendCapUsd: 1,
        fetch: async () => {
          fetchCalls++;
          if (fetchCalls === 1) {
            return new Response(JSON.stringify({ error: { message: "rate limit" } }), {
              status: 429,
              headers: { "Content-Type": "application/json", "Retry-After": "0.25" },
            });
          }
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: "recovered after 429" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        },
      });

      const router = new GovernedModelRouterService();
      const response = await router.executeWithRateLimitRetry(
        () => provider.generate(makeRequest({ timeoutMs: 10_000 })),
        {
          timeoutMs: 10_000,
          baseBackoffMs: 50,
          retryAfterPaddingMs: 500,
          jitterWindowMs: 100,
          randomFn: () => 0.5,
          sleepFn: async (ms) => {
            sleptMs.push(ms);
          },
        }
      );

      expect(fetchCalls).toBe(2);
      expect(sleptMs).toHaveLength(1);
      // Honors Retry-After (250ms) + padding (500ms) = 750ms > expBackoff (2*50 + 50 = 150ms)
      expect(sleptMs[0]).toBe(750);
      expect(response.outputText).toBe("recovered after 429");
    });

    it("429 past bound fails closed with ModelRateLimitedError", async () => {
      let fetchCalls = 0;
      const sleptMs: number[] = [];
      const provider = new OpenAICompatibleModelProvider({
        baseURL: "http://127.0.0.1:8000/v1",
        apiKey: "local-dummy-token",
        allowedModels: ["qwen2.5:1.5b"],
        spendCapUsd: 1,
        fetch: async () => {
          fetchCalls++;
          return new Response(JSON.stringify({ error: { message: "persistent 429" } }), {
            status: 429,
            headers: { "Content-Type": "application/json", "x-ratelimit-reset-requests": "100ms" },
          });
        },
      });

      await expect(
        dispatchWithRateLimitRetry(() => provider.generate(makeRequest({ timeoutMs: 10_000 })), {
          timeoutMs: 10_000,
          baseBackoffMs: 20,
          retryAfterPaddingMs: 50,
          jitterWindowMs: 10,
          randomFn: () => 0,
          sleepFn: async (ms) => {
            sleptMs.push(ms);
          },
        })
      ).rejects.toThrow(ModelRateLimitedError);

      // Bounded at MAX_RATE_LIMIT_RETRIES_CAP (3 retries = 4 total attempts)
      expect(MAX_RATE_LIMIT_RETRIES_CAP).toBe(3);
      expect(fetchCalls).toBe(4);
      expect(sleptMs).toHaveLength(3);
    });

    it("non-429 errors (400, plain 500 without non-processing header, timeout) do not retry", async () => {
      for (const scenario of [
        { status: 400, expectedError: ModelRequestInvalidError },
        { status: 500, expectedError: ModelProviderUnavailableError },
      ]) {
        let calls = 0;
        const provider = new OpenAICompatibleModelProvider({
          baseURL: "http://127.0.0.1:8000/v1",
          apiKey: "local-dummy-token",
          allowedModels: ["qwen2.5:1.5b"],
          spendCapUsd: 1,
          fetch: async () => {
            calls++;
            return new Response(JSON.stringify({ error: { message: "non-retryable failure" } }), {
              status: scenario.status,
              headers: { "Content-Type": "application/json" },
            });
          },
        });

        await expect(
          dispatchWithRateLimitRetry(() => provider.generate(makeRequest()), {
            timeoutMs: 5000,
            sleepFn: async () => {},
          })
        ).rejects.toThrow(scenario.expectedError);
        expect(calls).toBe(1);
      }

      let timeoutCalls = 0;
      await expect(
        dispatchWithRateLimitRetry(
          async () => {
            timeoutCalls++;
            throw new ModelRequestTimeoutError("timed out", { timeoutMs: 100 });
          },
          { timeoutMs: 5000, sleepFn: async () => {} }
        )
      ).rejects.toThrow(ModelRequestTimeoutError);
      expect(timeoutCalls).toBe(1);
    });

    it("5xx with explicit provider non-processing confirmation retries and retry wait stays inside timeoutMs", async () => {
      let calls = 0;
      const provider = new OpenAICompatibleModelProvider({
        baseURL: "http://127.0.0.1:8000/v1",
        apiKey: "local-dummy-token",
        allowedModels: ["qwen2.5:1.5b"],
        spendCapUsd: 1,
        fetch: async () => {
          calls++;
          if (calls === 1) {
            return new Response("upstream overloaded before processing", {
              status: 503,
              headers: { "x-request-not-processed": "true" },
            });
          }
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: "ok after un-processed 503" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        },
      });

      const res = await dispatchWithRateLimitRetry(() => provider.generate(makeRequest()), {
        timeoutMs: 5000,
        baseBackoffMs: 10,
        jitterWindowMs: 5,
        sleepFn: async () => {},
      });
      expect(calls).toBe(2);
      expect(res.outputText).toBe("ok after un-processed 503");

      // Total time stays strictly inside request timeoutMs (Retry-After exceeds timeout -> fails fast)
      let slowCalls = 0;
      const sleepSpy = vi.fn(async () => {});
      await expect(
        dispatchWithRateLimitRetry(
          async () => {
            slowCalls++;
            throw new ModelRateLimitedError("rate limit", { retryAfterMs: 2000 });
          },
          {
            timeoutMs: 500,
            retryAfterPaddingMs: 500,
            sleepFn: sleepSpy,
          }
        )
      ).rejects.toThrow(ModelRateLimitedError);
      expect(slowCalls).toBe(1);
      expect(sleepSpy).not.toHaveBeenCalled();
    });
  });
});
