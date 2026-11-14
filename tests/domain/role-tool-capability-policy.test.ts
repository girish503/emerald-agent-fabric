/**
 * M4.1 Workstream B — Single Authoritative Role & Tool Capability Policy Tests
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ROLE_CAPABILITY_CONTRACTS,
  validateRoleToolAlignment,
  validateSubtaskCapabilities,
  CapabilityEscalationError,
} from "../../src/domain/super-agent.js";
import { TOOL_CAPABILITY_MAP } from "../../src/domain/tool.js";
import { createWorkspaceToolAdapterRegistry } from "../../src/adapters/tools/tool-adapter-registry.factory.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";

describe("M4.1 Workstream B — Authoritative Role & Tool Capability Policy", () => {
  it("aligns every tool in ROLE_CAPABILITY_CONTRACTS with TOOL_CAPABILITY_MAP and role capabilities", () => {
    expect(() => validateRoleToolAlignment()).not.toThrow();

    expect(ROLE_CAPABILITY_CONTRACTS.RESEARCHER.allowedCapabilities).toEqual([
      "workspace.file.read",
      "workspace.code.search",
      "git.read",
    ]);
    expect(ROLE_CAPABILITY_CONTRACTS.RESEARCHER.allowedTools).toEqual([
      "read_file",
      "search_code",
      "git_status",
      "git_diff",
    ]);
    expect(ROLE_CAPABILITY_CONTRACTS.RESEARCHER.allowedTools).not.toContain("list_files");
    expect(ROLE_CAPABILITY_CONTRACTS.RESEARCHER.allowedCapabilities).not.toContain("workspace.query");

    expect(ROLE_CAPABILITY_CONTRACTS.CODER.allowedCapabilities).toEqual([
      "workspace.file.read",
      "workspace.file.write",
      "git.read",
    ]);
    expect(ROLE_CAPABILITY_CONTRACTS.REVIEWER.allowedCapabilities).toEqual([
      "workspace.file.read",
      "git.read",
    ]);
    expect(ROLE_CAPABILITY_CONTRACTS.TESTER.allowedCapabilities).toEqual([
      "workspace.file.read",
      "process.execute",
    ]);

    for (const contract of Object.values(ROLE_CAPABILITY_CONTRACTS)) {
      for (const tool of contract.allowedTools) {
        const required = TOOL_CAPABILITY_MAP[tool as keyof typeof TOOL_CAPABILITY_MAP];
        expect(required).toBeDefined();
        expect(contract.allowedCapabilities).toContain(required);
      }
    }
  });

  it("constructs ToolAdapterRegistry with full alignment against all role contracts and fails closed if tools are missing", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-m41-role-"));
    try {
      const workspace = new NodeFsWorkspaceAdapter({ workspaceRoot: tmpDir });
      const registryNoCmd = createWorkspaceToolAdapterRegistry(workspace);
      const registeredNoCmd = (registryNoCmd.listAdapters?.() ?? []).map((t) => t.toolName);
      expect(registeredNoCmd.sort()).toEqual([
        "edit_file",
        "git_diff",
        "git_status",
        "read_file",
        "search_code",
        "write_file",
      ]);

      const mockPhysicalProvider = {
        name: "mock-physical",
        providerRole: "PHYSICAL" as const,
        capabilities: new Set(["process.execute"]),
        isAvailable: async () => true,
        execute: async () => ({
          status: "SUCCESS" as const,
          output: {},
          exitCode: 0,
          metrics: { durationMs: 1, outputBytes: 2 },
        }),
      };
      const registryFull = createWorkspaceToolAdapterRegistry(workspace, mockPhysicalProvider as any);
      const registeredFull = (registryFull.listAdapters?.() ?? []).map((t) => t.toolName);
      expect(registeredFull.sort()).toEqual([
        "edit_file",
        "git_diff",
        "git_status",
        "read_file",
        "run_command",
        "search_code",
        "write_file",
      ]);
      expect(() => validateRoleToolAlignment(registeredFull)).not.toThrow();
      expect(() => validateRoleToolAlignment(["read_file"])).toThrow(CapabilityEscalationError);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects RESEARCHER requesting legacy workspace.query capability via validateSubtaskCapabilities", () => {
    expect(() =>
      validateSubtaskCapabilities(
        "RESEARCHER",
        ["workspace.file.read", "workspace.code.search", "git.read", "workspace.query"],
        ["workspace.query"]
      )
    ).toThrow(CapabilityEscalationError);
  });
});
