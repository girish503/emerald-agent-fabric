import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SearchCodeToolAdapter } from "../../../src/adapters/tools/search-code.tool-adapter.js";
import { NodeFsWorkspaceAdapter } from "../../../src/adapters/workspace/node-fs-workspace-adapter.js";
import {
  InvalidToolInputError,
  ToolCancelledError,
  ToolWorkspaceBoundaryViolationError,
} from "../../../src/domain/errors.js";
import { ToolExecutionContext } from "../../../src/ports/tool-adapter.port.js";
import { SearchCodeInput } from "../../../src/domain/tool-schemas.js";

describe("SearchCodeToolAdapter — In-Process Workspace Code Searching", () => {
  let tempBaseDir: string;
  let workspaceRootDir: string;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let adapter: SearchCodeToolAdapter;

  const workspaceId = "ws-search-code-test";
  let workspaceHostPath: string;

  beforeAll(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "search-tool-test-"));
    workspaceRootDir = path.join(tempBaseDir, "workspaces");
    await fs.mkdir(workspaceRootDir, { recursive: true });

    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: workspaceRootDir });
    adapter = new SearchCodeToolAdapter(workspaceAdapter);

    const ws = await workspaceAdapter.provisionWorkspace({
      workspaceId,
      runId: "run-test-1",
      taskId: "task-test-1",
      maxWorkspaceBytes: 50 * 1024 * 1024,
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
    workspaceHostPath = ws.hostPath;

    // Create tree of test files
    await fs.writeFile(
      path.join(workspaceHostPath, "alpha.ts"),
      "function alphaFoo() {\n  return 'target_needle';\n}\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(workspaceHostPath, "beta.ts"),
      "// file beta\nconst needle = 'target_needle';\nconst extra = 'target_needle';\n",
      "utf8"
    );
    await fs.mkdir(path.join(workspaceHostPath, "src"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceHostPath, "src", "gamma.js"),
      "console.log('target_needle');\n",
      "utf8"
    );

    // Metadata & binary files to be ignored
    await fs.mkdir(path.join(workspaceHostPath, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceHostPath, ".git", "config"),
      "target_needle inside git\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(workspaceHostPath, ".tmp.staging"),
      "target_needle in staging\n",
      "utf8"
    );
    // Binary file containing null byte
    const binaryBuf = Buffer.from([0x00, 0x01, 0x74, 0x61, 0x72, 0x67, 0x65, 0x74, 0x5f, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]);
    await fs.writeFile(path.join(workspaceHostPath, "binary.bin"), binaryBuf);
  });

  afterAll(async () => {
    if (tempBaseDir) {
      await fs.rm(tempBaseDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  function makeContext(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
    return {
      runId: "run-test-1",
      taskId: "task-test-1",
      workerId: "worker-test-1",
      leaseId: "lease-test-1",
      toolName: "search_code",
      requiredCapability: "workspace.code.search",
      isolationRequirement: "WORKSPACE",
      workspace: {
        workspaceId,
        hostPath: workspaceHostPath,
      },
      resourceLimits: {
        timeoutMs: 5000,
        maxOutputBytes: 1024 * 1024,
      },
      ...overrides,
    };
  }

  function makeSearchInput(
    partial: Partial<SearchCodeInput> & { query: string }
  ): SearchCodeInput {
    return {
      path: ".",
      isRegex: false,
      filePattern: "*",
      maxResults: 50,
      ...partial,
    };
  }

  it("finds literal matches across files in deterministic order (files ASC, line ASC)", async () => {
    const res = await adapter.execute(
      makeContext(),
      makeSearchInput({
        query: "target_needle",
        isRegex: false,
      })
    );

    expect(res.query).toBe("target_needle");
    expect(res.truncated).toBe(false);
    expect(res.totalMatches).toBe(4);

    expect(res.matches[0]).toEqual({
      file: "alpha.ts",
      line: 2,
      content: "  return 'target_needle';",
    });
    expect(res.matches[1]).toEqual({
      file: "beta.ts",
      line: 2,
      content: "const needle = 'target_needle';",
    });
    expect(res.matches[2]).toEqual({
      file: "beta.ts",
      line: 3,
      content: "const extra = 'target_needle';",
    });
    expect(res.matches[3]).toEqual({
      file: "src/gamma.js",
      line: 1,
      content: "console.log('target_needle');",
    });
  });

  it("ignores VCS (.git), temporary files, and binary files", async () => {
    const res = await adapter.execute(
      makeContext(),
      makeSearchInput({
        query: "target_needle",
      })
    );

    const fileNames = res.matches.map((m) => m.file);
    expect(fileNames.some((f) => f.includes(".git"))).toBe(false);
    expect(fileNames.some((f) => f.includes(".tmp."))).toBe(false);
    expect(fileNames.some((f) => f.includes("binary.bin"))).toBe(false);
  });

  it("filters candidate files by filePattern glob", async () => {
    const res = await adapter.execute(
      makeContext(),
      makeSearchInput({
        query: "target_needle",
        filePattern: "*.ts",
      })
    );

    expect(res.totalMatches).toBe(3);
    expect(res.matches.every((m) => m.file.endsWith(".ts"))).toBe(true);
  });

  it("executes regex searches properly", async () => {
    const res = await adapter.execute(
      makeContext(),
      makeSearchInput({
        query: "alpha[A-Za-z]+",
        isRegex: true,
      })
    );

    expect(res.totalMatches).toBe(1);
    expect(res.matches[0]!.file).toBe("alpha.ts");
    expect(res.matches[0]!.line).toBe(1);
  });

  it("bounds search results with maxResults and marks truncated", async () => {
    const res = await adapter.execute(
      makeContext(),
      makeSearchInput({
        query: "target_needle",
        maxResults: 2,
      })
    );

    expect(res.matches.length).toBe(2);
    expect(res.truncated).toBe(true);
  });

  it("rejects potential catastrophic backtracking regex (ReDoS mitigation)", async () => {
    await expect(
      adapter.execute(
        makeContext(),
        makeSearchInput({
          query: "(a+)+",
          isRegex: true,
        })
      )
    ).rejects.toThrow(InvalidToolInputError);
  });

  it("rejects search path outside workspace boundary", async () => {
    await expect(
      adapter.execute(
        makeContext(),
        makeSearchInput({
          query: "test",
          path: "../../outside",
        })
      )
    ).rejects.toThrow(ToolWorkspaceBoundaryViolationError);
  });

  it("aborts execution when AbortSignal is cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Search cancelled"));

    await expect(
      adapter.execute(
        makeContext({ abortSignal: controller.signal }),
        makeSearchInput({
          query: "target_needle",
        })
      )
    ).rejects.toThrow(ToolCancelledError);
  });
});
