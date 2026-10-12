import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitStatusToolAdapter } from "../../../src/adapters/tools/git-status.tool-adapter.js";
import { NodeFsWorkspaceAdapter } from "../../../src/adapters/workspace/node-fs-workspace-adapter.js";
import {
  ToolCancelledError,
  ToolExecutionFailedError,
  ToolWorkspaceBoundaryViolationError,
} from "../../../src/domain/errors.js";
import { ToolExecutionContext } from "../../../src/ports/tool-adapter.port.js";
import { createMockGitRepository } from "./git-test-helper.js";

describe("GitStatusToolAdapter — Pure In-Process Git Status", () => {
  let tempBaseDir: string;
  let workspaceRootDir: string;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let adapter: GitStatusToolAdapter;

  const workspaceId = "ws-git-status-test";
  let workspaceHostPath: string;
  let initialCommitSha: string;

  beforeAll(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "git-status-test-"));
    workspaceRootDir = path.join(tempBaseDir, "workspaces");
    await fs.mkdir(workspaceRootDir, { recursive: true });

    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: workspaceRootDir });
    adapter = new GitStatusToolAdapter(workspaceAdapter);

    const ws = await workspaceAdapter.provisionWorkspace({
      workspaceId,
      runId: "run-test-1",
      taskId: "task-test-1",
      maxWorkspaceBytes: 50 * 1024 * 1024,
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
    workspaceHostPath = ws.hostPath;

    // Create an authentic Git repository with 2 committed files
    const repoInfo = await createMockGitRepository(workspaceHostPath, [
      { path: "README.md", content: "# Test Repo\n" },
      { path: "src/main.ts", content: "console.log('hello');\n" },
    ]);
    initialCommitSha = repoInfo.commitSha;
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
      toolName: "git_status",
      requiredCapability: "git.read",
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

  it("reports clean repository with valid currentCommit when unmodified", async () => {
    const res = await adapter.execute(makeContext(), {});

    expect(res.clean).toBe(true);
    expect(res.currentCommit).toBe(initialCommitSha);
    expect(res.modified).toEqual([]);
    expect(res.added).toEqual([]);
    expect(res.deleted).toEqual([]);
    expect(res.untracked).toEqual([]);
  });

  it("detects untracked files added to working tree", async () => {
    const untrackedFile = path.join(workspaceHostPath, "untracked.txt");
    await fs.writeFile(untrackedFile, "new file content\n", "utf8");

    const res = await adapter.execute(makeContext(), {});

    expect(res.clean).toBe(false);
    expect(res.untracked).toContain("untracked.txt");
    expect(res.modified).toEqual([]);

    // Cleanup
    await fs.rm(untrackedFile, { force: true });
  });

  it("detects modified files in working tree", async () => {
    const readmeFile = path.join(workspaceHostPath, "README.md");
    await fs.writeFile(readmeFile, "# Test Repo (Modified)\n", "utf8");

    const res = await adapter.execute(makeContext(), {});

    expect(res.clean).toBe(false);
    expect(res.modified).toContain("README.md");

    // Restore
    await fs.writeFile(readmeFile, "# Test Repo\n", "utf8");
  });

  it("detects deleted files in working tree", async () => {
    const readmeFile = path.join(workspaceHostPath, "README.md");
    await fs.rm(readmeFile, { force: true });

    const res = await adapter.execute(makeContext(), {});

    expect(res.clean).toBe(false);
    expect(res.deleted).toContain("README.md");

    // Restore
    await fs.writeFile(readmeFile, "# Test Repo\n", "utf8");
  });

  it("filters status output by subpath parameter", async () => {
    const untrackedRoot = path.join(workspaceHostPath, "root_untracked.txt");
    const untrackedSub = path.join(workspaceHostPath, "src", "sub_untracked.txt");
    await fs.writeFile(untrackedRoot, "content", "utf8");
    await fs.writeFile(untrackedSub, "content", "utf8");

    const res = await adapter.execute(makeContext(), { path: "src" });

    expect(res.untracked).toContain("src/sub_untracked.txt");
    expect(res.untracked).not.toContain("root_untracked.txt");

    // Cleanup
    await fs.rm(untrackedRoot, { force: true });
    await fs.rm(untrackedSub, { force: true });
  });

  it("rejects path outside workspace boundary", async () => {
    await expect(
      adapter.execute(makeContext(), { path: "../../outside" })
    ).rejects.toThrow(ToolWorkspaceBoundaryViolationError);
  });

  it("rejects directory that is not a git repository", async () => {
    const nonGitWsId = "ws-non-git";
    const nonGitWs = await workspaceAdapter.provisionWorkspace({
      workspaceId: nonGitWsId,
      runId: "run-test-2",
      taskId: "task-test-2",
      maxWorkspaceBytes: 50 * 1024 * 1024,
      maxFileSizeBytes: 10 * 1024 * 1024,
    });

    const nonGitContext = makeContext({
      workspace: {
        workspaceId: nonGitWsId,
        hostPath: nonGitWs.hostPath,
      },
    });

    await expect(adapter.execute(nonGitContext, {})).rejects.toThrow(
      ToolExecutionFailedError
    );
  });

  it("aborts execution when AbortSignal is cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Git status cancelled"));

    await expect(
      adapter.execute(makeContext({ abortSignal: controller.signal }), {})
    ).rejects.toThrow(ToolCancelledError);
  });
});
