/**
 * Governed Tool Connector Dispatcher for Emerald Agent Fabric.
 *
 * Implements server-side authorization gating, input/output validation,
 * bounded output truncation, timeout and cancellation management, audit events,
 * and idempotency caching.
 */

import { canonicalJsonStringify, sha256Hex } from "../domain/canonical-hash.js";
import {
  ConnectorAuthorizationError,
  ConnectorCancelledError,
  ConnectorSchemaValidationError,
  ConnectorTimeoutError,
  GovernedToolConnector,
  ToolConnectorContext,
  ToolConnectorExecutionResult,
} from "../domain/tool-connector.js";
import type { EmeraldLifecycleTelemetry } from "./observability-instrumentation.js";
import type { ToolAdapterRegistryPort, ToolExecutionContext } from "../ports/tool-adapter.port.js";
import type { ToolRegistryPort } from "../ports/tool-registry.port.js";

export interface ToolConnectorAuditEvent {
  readonly eventType: "connector.requested" | "connector.completed" | "connector.failed";
  readonly connectorId: string;
  readonly tenantId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly timestamp: string;
  readonly durationMs?: number;
  readonly bytesEmitted?: number;
  readonly error?: string;
  readonly inputHash: string;
}

export type AuditEventSink = (event: ToolConnectorAuditEvent) => void;

export class GovernedToolConnectorService {
  private readonly connectors = new Map<string, GovernedToolConnector<any, any>>();
  private readonly idempotencyCache = new Map<string, ToolConnectorExecutionResult<any>>();
  private readonly auditSink?: AuditEventSink;
  private readonly telemetry?: EmeraldLifecycleTelemetry;

  constructor(auditSink?: AuditEventSink, telemetry?: EmeraldLifecycleTelemetry) {
    this.auditSink = auditSink;
    this.telemetry = telemetry;
  }

  /**
   * Registers a governed tool connector.
   */
  public registerConnector(connector: GovernedToolConnector<any, any>): void {
    this.connectors.set(connector.connectorId, connector);
  }

  public hasConnector(connectorId: string): boolean {
    return this.connectors.has(connectorId);
  }

  /**
   * Dispatches execution to a governed tool connector under strict policy.
   */
  public async executeConnector<TOutput = unknown>(
    connectorId: string,
    rawInput: unknown,
    context: ToolConnectorContext
  ): Promise<ToolConnectorExecutionResult<TOutput>> {
    const connector = this.connectors.get(connectorId);
    if (!connector) {
      throw new Error(`Connector '${connectorId}' is not registered`);
    }

    const startTime = Date.now();
    const inputHash = sha256Hex(canonicalJsonStringify(rawInput));

    // 1. Audit: requested
    this.emitAudit({
      eventType: "connector.requested",
      connectorId,
      tenantId: context.tenantId,
      taskId: context.taskId,
      runId: context.runId,
      timestamp: new Date().toISOString(),
      inputHash,
    });

    // 2. Server-Side Capability Authorization Check
    if (!context.authorizedCapabilities.includes(connector.requiredCapability)) {
      const err = new ConnectorAuthorizationError(connectorId, connector.requiredCapability);
      this.emitAudit({
        eventType: "connector.failed",
        connectorId,
        tenantId: context.tenantId,
        taskId: context.taskId,
        runId: context.runId,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        error: err.message,
        inputHash,
      });
      throw err;
    }

    // 3. Check Idempotency Cache if applicable
    if (connector.isIdempotent && context.idempotencyKey) {
      const cacheKey = `${context.tenantId}:${connectorId}:${context.idempotencyKey}:${inputHash}`;
      const cached = this.idempotencyCache.get(cacheKey);
      if (cached) {
        return { ...cached, cached: true };
      }
    }

    // 4. Validate Input Schema
    const inputValidation = connector.inputSchema.safeParse(rawInput);
    if (!inputValidation.success) {
      const issues = inputValidation.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      const err = new ConnectorSchemaValidationError(connectorId, issues);
      this.emitAudit({
        eventType: "connector.failed",
        connectorId,
        tenantId: context.tenantId,
        taskId: context.taskId,
        runId: context.runId,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        error: err.message,
        inputHash,
      });
      throw err;
    }

    // 5. Check Cancellation before starting
    if (context.abortSignal?.aborted) {
      const err = new ConnectorCancelledError(connectorId);
      this.emitAudit({
        eventType: "connector.failed",
        connectorId,
        tenantId: context.tenantId,
        taskId: context.taskId,
        runId: context.runId,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        error: err.message,
        inputHash,
      });
      throw err;
    }

    // 6. Execute with Timeout and Cancellation
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(() => {
          reject(new ConnectorTimeoutError(connectorId, context.timeoutMs));
        }, context.timeoutMs);
        if (context.abortSignal) {
          onAbort = () => {
            if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
            reject(new ConnectorCancelledError(connectorId));
          };
          if (context.abortSignal.aborted) {
            onAbort();
          } else {
            context.abortSignal.addEventListener("abort", onAbort, { once: true });
          }
        }
      });

      const execPromise = connector.execute(inputValidation.data, context);
      const rawResult = await Promise.race([execPromise, timeoutPromise]);

      // 7. Validate and Bound Output
      let output = rawResult.output;
      let truncated = rawResult.truncated;

      const rawSerialized = canonicalJsonStringify(output);
      const rawBytes = Buffer.byteLength(rawSerialized, "utf8");

      if (context.maxOutputBytes > 0 && rawBytes > context.maxOutputBytes) {
        truncated = true;
        if (typeof output === "string") {
          output = (output.slice(0, context.maxOutputBytes) + `\n[TRUNCATED: output exceeded ${context.maxOutputBytes} bytes]`) as any;
        } else {
          output = {
            _truncated: true,
            notice: `Output exceeded ceiling of ${context.maxOutputBytes} bytes`,
            sample: rawSerialized.slice(0, Math.min(context.maxOutputBytes, 1024)),
          } as any;
        }
      }

      const durationMs = Date.now() - startTime;
      const finalBytes = Buffer.byteLength(canonicalJsonStringify(output), "utf8");
      const executionHash = sha256Hex(canonicalJsonStringify({ output, inputHash, durationMs }));

      const result: ToolConnectorExecutionResult<TOutput> = {
        success: rawResult.success,
        output,
        truncated,
        durationMs,
        bytesEmitted: finalBytes,
        executionHash,
      };

      // 8. Cache if idempotent
      if (connector.isIdempotent && context.idempotencyKey) {
        const cacheKey = `${context.tenantId}:${connectorId}:${context.idempotencyKey}:${inputHash}`;
        this.idempotencyCache.set(cacheKey, result);
      }

      // 9. Audit: completed
      this.emitAudit({
        eventType: "connector.completed",
        connectorId,
        tenantId: context.tenantId,
        taskId: context.taskId,
        runId: context.runId,
        timestamp: new Date().toISOString(),
        durationMs,
        bytesEmitted: finalBytes,
        inputHash,
      });

      return result;
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      this.emitAudit({
        eventType: "connector.failed",
        connectorId,
        tenantId: context.tenantId,
        taskId: context.taskId,
        runId: context.runId,
        timestamp: new Date().toISOString(),
        durationMs,
        error: err.message,
        inputHash,
      });
      throw err;
    } finally {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (onAbort && context.abortSignal) {
        context.abortSignal.removeEventListener("abort", onAbort);
      }
    }
  }

  private emitAudit(event: ToolConnectorAuditEvent): void {
    this.telemetry?.recordConnectorAuditEvent(event);
    if (this.auditSink) {
      try {
        this.auditSink(event);
      } catch {
        // Fail-safe: monitoring must never break execution
      }
    }
  }
}

export interface WorkspaceConnectorContext extends ToolConnectorContext {
  readonly adapterContext?: ToolExecutionContext;
}

export function createWorkspaceToolConnectorService(params: {
  readonly toolRegistry: ToolRegistryPort;
  readonly adapterRegistry: ToolAdapterRegistryPort;
  readonly telemetry?: EmeraldLifecycleTelemetry;
  readonly auditSink?: AuditEventSink;
}): GovernedToolConnectorService {
  const service = new GovernedToolConnectorService(params.auditSink, params.telemetry);
  for (const toolDef of params.toolRegistry.listTools()) {
    const adapter = params.adapterRegistry.getAdapter(toolDef.name);
    if (!adapter) continue;
    service.registerConnector({
      connectorId: toolDef.name,
      name: toolDef.name,
      description: toolDef.description,
      requiredCapability: toolDef.requiredCapability,
      isIdempotent: toolDef.idempotency === "IDEMPOTENT",
      inputSchema: toolDef.inputSchema,
      outputSchema: toolDef.outputSchema,
      async execute(input, ctx) {
        const execStart = Date.now();
        const adapterCtx = (ctx as WorkspaceConnectorContext).adapterContext;
        if (!adapterCtx) {
          throw new Error(`Workspace connector '${toolDef.name}' invoked without ToolExecutionContext`);
        }
        const rawOutput = await adapter.execute(adapterCtx, input as any);
        return {
          success: true,
          output: rawOutput,
          truncated: false,
          durationMs: Math.max(0, Date.now() - execStart),
          bytesEmitted: 0,
          executionHash: "",
        };
      },
    });
  }
  return service;
}
