/**
 * Factory for creating the workspace tool adapter registry.
 *
 * Registers the 5 deterministic workspace-confined tool adapters:
 * - read_file
 * - write_file
 * - search_code
 * - git_status
 * - git_diff
 *
 * And when ExecutionProvider is provided:
 * - run_command (SandboxedCommandToolAdapter)
 */

import { ExecutionProvider } from "../../ports/execution-provider.port.js";
import {
  StaticToolAdapterRegistry,
  ToolAdapterRegistryPort,
} from "../../ports/tool-adapter.port.js";
import { WorkspacePort } from "../../ports/workspace.port.js";
import { MutationIntentStorePort } from "../../ports/mutation-intent-store.port.js";
import { EditFileToolAdapter } from "./edit-file.tool-adapter.js";
import { GitDiffToolAdapter } from "./git-diff.tool-adapter.js";
import { GitStatusToolAdapter } from "./git-status.tool-adapter.js";
import { ReadFileToolAdapter } from "./read-file.tool-adapter.js";
import { SandboxedCommandToolAdapter } from "./sandboxed-command.tool-adapter.js";
import { SearchCodeToolAdapter } from "./search-code.tool-adapter.js";
import { WriteFileToolAdapter } from "./write-file.tool-adapter.js";

export interface WorkspaceToolAdapterRegistryOptions {
  readonly mutationStore?: MutationIntentStorePort;
  readonly snapshotBasePath?: string;
}

/**
 * Creates and initializes a tool adapter registry containing workspace tools.
 * If an ExecutionProvider is provided, also registers the SandboxedCommandToolAdapter.
 * If options.mutationStore is provided, configures EditFileToolAdapter with WAMI persistence.
 */
export function createWorkspaceToolAdapterRegistry(
  workspacePort: WorkspacePort,
  executionProvider?: ExecutionProvider,
  options?: WorkspaceToolAdapterRegistryOptions
): ToolAdapterRegistryPort {
  const registry = new StaticToolAdapterRegistry();

  registry.register(new ReadFileToolAdapter(workspacePort));
  registry.register(new WriteFileToolAdapter(workspacePort));
  registry.register(
    new EditFileToolAdapter(
      workspacePort,
      undefined,
      options?.mutationStore,
      options?.snapshotBasePath
    )
  );
  registry.register(new SearchCodeToolAdapter(workspacePort));
  registry.register(new GitStatusToolAdapter(workspacePort));
  registry.register(new GitDiffToolAdapter(workspacePort));

  if (executionProvider) {
    registry.register(new SandboxedCommandToolAdapter(executionProvider, workspacePort));
  }

  return registry;
}
