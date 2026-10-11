/**
 * Tool Adapter Port for Emerald Agent Fabric.
 *
 * Establishes the execution contract boundary for typed tool adapters.
 *
 * Architectural Invariants:
 * 1. Least Privilege Context: Adapters receive only the minimal execution context
 *    (runId, taskId, lease fencing tokens, contained workspace paths, resource bounds).
 *    They NEVER receive raw database connections, MissionContract mutators,
 *    or Docker daemon sockets.
 * 2. Typed Dispatch: Each adapter explicitly declares its ToolName and accepts/returns
 *    the strictly validated domain payload types.
 * 3. Autonomous Retry Prohibition: Adapters report execution outcomes or throw.
 *    They MUST NOT perform autonomous retries.
 * 4. Determinism: Zero ambient or stochastic state.
 */

import {
  ToolCapability,
  ToolIsolationRequirement,
  ToolName,
} from "../domain/tool.js";
import { ToolInputMap, ToolOutputMap } from "../domain/tool-schemas.js";

/**
 * Minimal trusted execution context provided to a tool adapter.
 */
export interface ToolExecutionContext {
  readonly runId: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly leaseId: string;
  readonly toolName: ToolName;
  readonly requiredCapability: ToolCapability;
  readonly isolationRequirement: ToolIsolationRequirement;
  readonly workspace: {
    readonly workspaceId: string;
    readonly hostPath: string;
    readonly containerMountPath?: string;
  };
  readonly resourceLimits: {
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
  };
  readonly abortSignal?: AbortSignal;
}

/**
 * Contract for a typed tool execution adapter.
 */
export interface ToolAdapter<TName extends ToolName = ToolName> {
  readonly toolName: TName;
  execute(
    context: ToolExecutionContext,
    input: ToolInputMap[TName]
  ): Promise<ToolOutputMap[TName]>;
}

/**
 * Lookup port for resolving registered tool adapters.
 */
export interface ToolAdapterRegistryPort {
  /**
   * Retrieves an adapter by tool name, or null if not registered.
   */
  getAdapter<TName extends ToolName>(name: TName): ToolAdapter<TName> | null;
  getAdapter(name: string): ToolAdapter | null;

  /**
   * Checks whether an adapter is registered for a tool.
   */
  hasAdapter(name: string): boolean;

  /**
   * Lists all currently registered adapters.
   */
  listAdapters?(): readonly ToolAdapter[];
}

/**
 * In-memory static adapter registry for tests and runtime composition.
 */
export class StaticToolAdapterRegistry implements ToolAdapterRegistryPort {
  private readonly adapters = new Map<string, ToolAdapter>();

  constructor(adapters: readonly ToolAdapter[] = []) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.toolName)) {
        throw new Error(`Duplicate adapter registered for '${adapter.toolName}'`);
      }
      this.adapters.set(adapter.toolName, adapter);
    }
  }

  register(adapter: ToolAdapter): void {
    if (this.adapters.has(adapter.toolName)) {
      throw new Error(`Duplicate adapter registered for '${adapter.toolName}'`);
    }
    this.adapters.set(adapter.toolName, adapter);
  }

  getAdapter<TName extends ToolName>(name: TName): ToolAdapter<TName> | null;
  getAdapter(name: string): ToolAdapter | null;
  getAdapter(name: string): ToolAdapter | null {
    return (this.adapters.get(name) as ToolAdapter | undefined) ?? null;
  }

  hasAdapter(name: string): boolean {
    return this.adapters.has(name);
  }

  listAdapters(): readonly ToolAdapter[] {
    return Array.from(this.adapters.values());
  }
}
