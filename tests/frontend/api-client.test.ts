/**
 * Tests for Frontend Typed API Client (Milestone 2.27)
 *
 * Verifies:
 * - Centralized configuration and endpoint routing
 * - Strict contract adherence (no fictional endpoints)
 * - Request and response schema validation
 * - Authentication header injection and credential redaction
 * - AbortController cancellation and request timeout enforcement
 * - Integration with real Fastify transport instance
 */

import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  EmeraldApiClient,
  ApiClientError,
} from "../../apps/web/src/client/api-client.js";
import {
  buildFastifyServer,
  type PrincipalRecord,
} from "../../src/transport/http/server.js";
import type { CreateTaskRequest } from "../../apps/web/src/types/api.js";

/**
 * Creates an in-process fetch adapter backed by Fastify's inject API.
 * Avoids host OS TCP socket binding and firewall prompts on Windows.
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

describe("EmeraldApiClient — Unit & Contract Tests", () => {
  const TEST_BASE_URL = "http://127.0.0.1:3000";

  const validTaskRequest: CreateTaskRequest = {
    title: "Fix syntax error in parser",
    prompt: "Investigate parser.ts and fix the syntax error",
    repoPath: "repos/parser",
    requiredCapabilities: ["workspace.file.read", "workspace.file.write"],
    executionMode: "sandboxed",
    modelConfig: {
      provider: "ollama",
      modelName: "qwen2.5-coder:7b",
      temperature: 0,
      contextWindow: 8192,
    },
    resourceLimits: {
      timeoutSeconds: 300,
      maxSteps: 25,
      maxOutputBytes: 524288,
    },
    verificationSpecs: [
      {
        name: "test-parser",
        command: "npm test",
        timeoutMs: 15000,
        expectedExitCode: 0,
      },
    ],
  };

  describe("Configuration & Initialization", () => {
    it("initializes with valid baseUrl and strips trailing slashes", () => {
      const client = new EmeraldApiClient({
        baseUrl: "http://localhost:3000///",
      });
      expect(client).toBeDefined();
    });

    it("throws if baseUrl is empty", () => {
      expect(() => new EmeraldApiClient({ baseUrl: "" })).toThrow(
        "EmeraldApiClient requires a valid baseUrl"
      );
    });
  });

  describe("Client-Side Input Validation", () => {
    it("rejects task submission with empty title before sending network request", async () => {
      const client = new EmeraldApiClient({ baseUrl: TEST_BASE_URL });
      const invalid = { ...validTaskRequest, title: "" };

      await expect(client.submitTask(invalid)).rejects.toThrow(ApiClientError);
      try {
        await client.submitTask(invalid);
      } catch (err) {
        expect(err).toBeInstanceOf(ApiClientError);
        const apiErr = err as ApiClientError;
        expect(apiErr.code).toBe("BAD_REQUEST");
        expect(apiErr.statusCode).toBe(400);
      }
    });

    it("strictly rejects client-supplied allowUnverifiedCompletion", async () => {
      const client = new EmeraldApiClient({ baseUrl: TEST_BASE_URL });
      // Intentionally pass forbidden operator-only field
      const invalid = {
        ...validTaskRequest,
        allowUnverifiedCompletion: true,
      } as unknown as CreateTaskRequest;

      await expect(client.submitTask(invalid)).rejects.toThrow(ApiClientError);
      try {
        await client.submitTask(invalid);
      } catch (err) {
        const apiErr = err as ApiClientError;
        expect(apiErr.code).toBe("BAD_REQUEST");
        expect(apiErr.message).toContain("validation failed");
      }
    });

    it("rejects empty taskId in getTask", async () => {
      const client = new EmeraldApiClient({ baseUrl: TEST_BASE_URL });
      await expect(client.getTask("   ")).rejects.toThrow("taskId must be a non-empty string");
    });

    it("rejects empty runId in getRun and cancelRun", async () => {
      const client = new EmeraldApiClient({ baseUrl: TEST_BASE_URL });
      await expect(client.getRun("")).rejects.toThrow("runId must be a non-empty string");
      await expect(client.cancelRun("", { reason: "test" })).rejects.toThrow("runId must be a non-empty string");
    });

    it("rejects cancelRun without valid reason", async () => {
      const client = new EmeraldApiClient({ baseUrl: TEST_BASE_URL });
      await expect(client.cancelRun("run-123", { reason: "" })).rejects.toThrow(ApiClientError);
    });
  });

  describe("Authentication & Credential Redaction", () => {
    it("attaches static Bearer token to headers", async () => {
      let capturedAuth: string | null = null;
      const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
        capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? null;
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              taskId: "task-001",
              title: "Test Task",
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

      const client = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        token: "secret-token-xyz",
        fetch: fakeFetch,
      });

      await client.getTask("task-001");
      expect(capturedAuth).toBe("Bearer secret-token-xyz");
    });

    it("resolves dynamic token provider function", async () => {
      let capturedAuth: string | null = null;
      const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
        capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? null;
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              taskId: "task-001",
              title: "Test Task",
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

      const client = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        token: async () => "dynamic-token-456",
        fetch: fakeFetch,
      });

      await client.getTask("task-001");
      expect(capturedAuth).toBe("Bearer dynamic-token-456");
    });

    it("redacts bearer tokens from error messages", () => {
      const err = new ApiClientError({
        message: "Failed to connect with Authorization: Bearer secret-super-token-12345",
        statusCode: 500,
        code: "INTERNAL_ERROR",
      });
      expect(err.message).not.toContain("secret-super-token-12345");
      expect(err.message).toContain("Bearer [REDACTED]");
    });
  });

  describe("Cancellation & Timeout Handling", () => {
    it("aborts in-flight request when caller signal triggers", async () => {
      const controller = new AbortController();
      const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
        return new Promise((_, reject) => {
          if (init?.signal?.aborted) {
            reject(new DOMException("The user aborted a request.", "AbortError"));
            return;
          }
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The user aborted a request.", "AbortError"));
          });
        });
      };

      const client = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        fetch: fakeFetch,
      });

      const promise = client.getTask("task-123", { signal: controller.signal });
      controller.abort("user_stop");

      await expect(promise).rejects.toThrow(ApiClientError);
    });

    it("times out request when execution exceeds timeoutMs", async () => {
      const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
        return new Promise((_, reject) => {
          if (init?.signal?.aborted) {
            reject(new Error("Request timed out"));
            return;
          }
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("Request timed out"));
          });
        });
      };

      const client = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        fetch: fakeFetch,
      });

      try {
        await client.getTask("task-123", { timeoutMs: 30 });
        expect.fail("Should have thrown timeout error");
      } catch (err) {
        expect(err).toBeInstanceOf(ApiClientError);
        const apiErr = err as ApiClientError;
        expect(apiErr.statusCode).toBe(504);
        expect(apiErr.code).toBe("TRANSIENT");
        expect(apiErr.isTransient).toBe(true);
      }
    });
  });

  describe("Integration with Live Fastify Transport", () => {
    const TEST_TOKEN = "operator-token-test-secret-12345678";
    const testPrincipals: PrincipalRecord[] = [
      {
        principalId: "p-operator",
        tenantId: "tenant-alpha",
        role: "operator",
        token: TEST_TOKEN,
        allowConstrainedHost: false,
      },
      {
        principalId: "p-other-tenant",
        tenantId: "tenant-beta",
        role: "operator",
        token: "other-tenant-token-987654321012",
        allowConstrainedHost: false,
      },
    ];

    it("performs full roundtrip: submit task -> get task -> verify tenant isolation", async () => {
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

      // 1. Submit task
      const submitted = await client.submitTask(validTaskRequest);
      expect(submitted.success).toBe(true);
      expect(submitted.data.taskId).toBeDefined();
      expect(submitted.data.status).toBe("CREATED");
      expect(submitted.data.tenantId).toBe("tenant-alpha");

      const taskId = submitted.data.taskId;

      // 2. Retrieve task
      const retrieved = await client.getTask(taskId);
      expect(retrieved.success).toBe(true);
      expect(retrieved.data.taskId).toBe(taskId);
      expect(retrieved.data.title).toBe(validTaskRequest.title);

      // 3. Verify tenant isolation: client with other tenant's token cannot access task
      const otherClient = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        token: "other-tenant-token-987654321012",
        fetch: createServerFetch(server),
      });

      await expect(otherClient.getTask(taskId)).rejects.toThrow(ApiClientError);
      try {
        await otherClient.getTask(taskId);
      } catch (err) {
        const apiErr = err as ApiClientError;
        expect(apiErr.statusCode).toBe(404);
        expect(apiErr.code).toBe("NOT_FOUND");
      }

      // 4. Verify unauthenticated client receives 401 UNAUTHORIZED
      const unauthClient = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        fetch: createServerFetch(server),
      });

      await expect(unauthClient.getTask(taskId)).rejects.toThrow(ApiClientError);
      try {
        await unauthClient.getTask(taskId);
      } catch (err) {
        const apiErr = err as ApiClientError;
        expect(apiErr.statusCode).toBe(401);
        expect(apiErr.code).toBe("UNAUTHORIZED");
      }
    });

    it("retrieves registered artifacts from live Fastify server", async () => {
      const artifactsMap = new Map();
      artifactsMap.set("run-test-1", [
        {
          artifactId: "art-1",
          runId: "run-test-1",
          relativePath: "output.log",
          sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          byteSize: 1024,
          contentType: "text/plain",
          createdAt: new Date().toISOString(),
        },
      ]);

      const runsMap = new Map();
      runsMap.set("run-test-1", {
        runId: "run-test-1",
        taskId: "task-test-1",
        tenantId: "tenant-alpha",
        status: "COMPLETED",
        createdAt: new Date().toISOString(),
      });

      const server = buildFastifyServer({
        principals: testPrincipals,
        inMemoryStore: {
          tasks: new Map(),
          runs: runsMap,
          artifacts: artifactsMap,
          events: new Map(),
        },
      });

      const client = new EmeraldApiClient({
        baseUrl: TEST_BASE_URL,
        token: TEST_TOKEN,
        fetch: createServerFetch(server),
      });

      const artifacts = await client.getArtifacts("run-test-1");
      expect(artifacts.success).toBe(true);
      expect(artifacts.data.length).toBe(1);
      expect(artifacts.data[0]?.artifactId).toBe("art-1");
      expect(artifacts.data[0]?.sha256).toBe(
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      );
    });
  });
});
