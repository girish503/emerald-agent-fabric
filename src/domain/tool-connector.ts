/**
 * Governed Tool Connector Domain Model for Emerald Agent Fabric.
 *
 * Implements typed schemas, server-side capability authorization, bounded outputs,
 * timeouts, cooperative cancellation, and idempotency controls.
 *
 * Invariants:
 * 1. Server-Side Authorization: Connectors declare required capabilities; execution
 *    is authorized ONLY if the task's MissionContract explicitly includes that capability.
 * 2. Bounded Output: Output payloads exceeding `maxOutputBytes` are deterministically
 *    truncated with a tamper-evident notice, preventing context exhaustion attacks.
 * 3. Cooperative Cancellation: AbortSignals are respected and propagated immediately.
 * 4. Audit Emission: Every invocation generates validated lifecycle events.
 * 5. Idempotent Deduplication: Pure/read-only connector requests can be safely deduplicated.
 */

import { z } from "zod";

export interface ToolConnectorContext {
  readonly tenantId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly contractId: string;
  readonly authorizedCapabilities: readonly string[];
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
  readonly abortSignal?: AbortSignal;
  readonly idempotencyKey?: string;
}

export interface ToolConnectorExecutionResult<T = unknown> {
  readonly success: boolean;
  readonly output?: T;
  readonly error?: string;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly bytesEmitted: number;
  readonly executionHash: string;
  readonly cached?: boolean;
}

export interface GovernedToolConnector<TInput = unknown, TOutput = unknown> {
  readonly connectorId: string;
  readonly name: string;
  readonly description: string;
  readonly requiredCapability: string;
  readonly isIdempotent: boolean;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TOutput>;

  execute(
    input: TInput,
    context: ToolConnectorContext
  ): Promise<ToolConnectorExecutionResult<TOutput>>;
}

export class ConnectorAuthorizationError extends Error {
  constructor(connectorId: string, requiredCapability: string) {
    super(`Connector '${connectorId}' requires capability '${requiredCapability}' which is not authorized on this task contract`);
    this.name = "ConnectorAuthorizationError";
  }
}

export class ConnectorTimeoutError extends Error {
  constructor(connectorId: string, timeoutMs: number) {
    super(`Connector '${connectorId}' timed out after ${timeoutMs}ms`);
    this.name = "ConnectorTimeoutError";
  }
}

export class ConnectorCancelledError extends Error {
  constructor(connectorId: string) {
    super(`Connector '${connectorId}' execution was cancelled`);
    this.name = "ConnectorCancelledError";
  }
}

export class ConnectorSchemaValidationError extends Error {
  constructor(connectorId: string, issues: string) {
    super(`Connector '${connectorId}' input schema validation failed: ${issues}`);
    this.name = "ConnectorSchemaValidationError";
  }
}
