import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  GovernedToolConnectorService,
  ToolConnectorAuditEvent,
} from "../../src/application/governed-tool-connector.js";
import {
  ConnectorAuthorizationError,
  ConnectorCancelledError,
  ConnectorSchemaValidationError,
  ConnectorTimeoutError,
  GovernedToolConnector,
  ToolConnectorContext,
} from "../../src/domain/tool-connector.js";

describe("Governed Tool Connector Infrastructure", () => {
  const auditEvents: ToolConnectorAuditEvent[] = [];
  const service = new GovernedToolConnectorService((e) => auditEvents.push(e));

  const sampleConnector: GovernedToolConnector<{ query: string; limit?: number }, { matches: string[] }> = {
    connectorId: "code_search_connector",
    name: "Code Search Connector",
    description: "Searches codebase for pattern",
    requiredCapability: "workspace.query",
    isIdempotent: true,
    inputSchema: z.object({
      query: z.string().min(1),
      limit: z.number().int().positive().optional(),
    }),
    outputSchema: z.object({
      matches: z.array(z.string()),
    }),
    execute: async (input) => {
      return {
        success: true,
        output: { matches: [`file1.ts: match for ${input.query}`, `file2.ts: match for ${input.query}`] },
        truncated: false,
        durationMs: 15,
        bytesEmitted: 100,
        executionHash: "hash-1",
      };
    },
  };

  service.registerConnector(sampleConnector);

  const baseContext: ToolConnectorContext = {
    tenantId: "tenant-alpha",
    taskId: "task-200",
    runId: "run-200",
    contractId: "contract-200",
    authorizedCapabilities: ["workspace.query", "workspace.file.read"],
    maxOutputBytes: 1024,
    timeoutMs: 5000,
    idempotencyKey: "idem-key-1",
  };

  it("executes connector successfully when capability is authorized", async () => {
    const result = await service.executeConnector(
      "code_search_connector",
      { query: "UserController" },
      baseContext
    );

    expect(result.success).toBe(true);
    expect((result.output as any)?.matches.length).toBe(2);
    expect(result.truncated).toBe(false);

    // Verify audit events
    const completed = auditEvents.find((e) => e.eventType === "connector.completed");
    expect(completed).toBeDefined();
    expect(completed?.connectorId).toBe("code_search_connector");
  });

  it("rejects execution fail-closed when task lacks authorized capability", async () => {
    const unauthorizedContext: ToolConnectorContext = {
      ...baseContext,
      authorizedCapabilities: ["workspace.file.read"], // lacks workspace.query
    };

    await expect(
      service.executeConnector("code_search_connector", { query: "secret" }, unauthorizedContext)
    ).rejects.toThrow(ConnectorAuthorizationError);

    const failed = auditEvents.find((e) => e.eventType === "connector.failed" && e.error?.includes("workspace.query"));
    expect(failed).toBeDefined();
  });

  it("rejects input that fails schema validation", async () => {
    await expect(
      service.executeConnector("code_search_connector", { query: "" }, baseContext)
    ).rejects.toThrow(ConnectorSchemaValidationError);
  });

  it("enforces output truncation when response exceeds maxOutputBytes", async () => {
    const smallCeilingContext: ToolConnectorContext = {
      ...baseContext,
      maxOutputBytes: 30, // tiny limit
    };

    const result = await service.executeConnector(
      "code_search_connector",
      { query: "big_search" },
      smallCeilingContext
    );

    expect(result.truncated).toBe(true);
    expect(result.output).toBeDefined();
  });

  it("serves cached result on identical idempotent call with idempotencyKey", async () => {
    const result1 = await service.executeConnector(
      "code_search_connector",
      { query: "cached_query" },
      baseContext
    );
    expect(result1.cached).toBeUndefined();

    const result2 = await service.executeConnector(
      "code_search_connector",
      { query: "cached_query" },
      baseContext
    );
    expect(result2.cached).toBe(true);
  });

  it("enforces timeout on long-running connectors", async () => {
    const slowConnector: GovernedToolConnector<{ delayMs: number }, { done: boolean }> = {
      connectorId: "slow_connector",
      name: "Slow Connector",
      description: "Deliberately slow connector",
      requiredCapability: "workspace.query",
      isIdempotent: false,
      inputSchema: z.object({ delayMs: z.number() }),
      outputSchema: z.object({ done: z.boolean() }),
      execute: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, input.delayMs));
        return {
          success: true,
          output: { done: true },
          truncated: false,
          durationMs: input.delayMs,
          bytesEmitted: 20,
          executionHash: "hash-slow",
        };
      },
    };

    service.registerConnector(slowConnector);

    const quickTimeoutContext: ToolConnectorContext = {
      ...baseContext,
      timeoutMs: 50, // 50ms timeout
    };

    await expect(
      service.executeConnector("slow_connector", { delayMs: 200 }, quickTimeoutContext)
    ).rejects.toThrow(ConnectorTimeoutError);
  });

  it("observes cooperative cancellation via AbortSignal", async () => {
    const controller = new AbortController();
    controller.abort(); // already aborted

    const cancelledContext: ToolConnectorContext = {
      ...baseContext,
      abortSignal: controller.signal,
    };

    await expect(
      service.executeConnector("code_search_connector", { query: "cancelled" }, cancelledContext)
    ).rejects.toThrow(ConnectorCancelledError);
  });
});
