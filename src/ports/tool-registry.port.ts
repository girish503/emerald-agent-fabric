/**
 * Tool Registry Port for Emerald Agent Fabric.
 *
 * Defines the read-only domain lookup boundary for resolving immutable tool definitions.
 * Prevents dynamic arbitrary runtime registration or unvalidated tool execution.
 */

import { ToolDefinition, ToolName } from "../domain/tool.js";

export interface ToolRegistryPort {
  /**
   * Retrieves a typed tool definition by name, or null if not found.
   */
  getTool<TName extends ToolName>(name: TName): ToolDefinition<TName> | null;
  getTool(name: string): ToolDefinition | null;

  /**
   * Checks whether a tool name is registered.
   */
  hasTool(name: string): boolean;

  /**
   * Returns a snapshot array of all registered tool definitions.
   */
  listTools(): readonly ToolDefinition[];
}
