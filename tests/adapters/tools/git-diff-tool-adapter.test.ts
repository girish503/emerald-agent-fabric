import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitDiffToolAdapter } from "../../../src/adapters/tools/git-diff.tool-adapter.js";
import { NodeFsWorkspaceAdapter } from "../../../src/adapters/workspace/node-fs-workspace-adapter.js";
import {
  ToolCancelledError,
  ToolExecutionFailedError,
  ToolWorkspaceBoundaryViolationError,
} from "../../../src/domain/errors.js";
import { ToolExecutionContext } from "../../../src/ports/tool-adapter.port.js";
import { GitDiffInput } from "../../../src/domain/tool-schemas.js";
import { createMockGitRepository } from "./git-test-helper.js";

describe("GitDiffToolAdapter — Pure In-Process Git Diff", () => {
  let tempBaseDir: string;
  let workspaceRootDir: string;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let adapter: GitDiffToolAdapter;

  const workspaceId = "ws-git-diff-test";
  let workspaceHostPath: string;

  beforeAll(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "git-diff-test-"));
    workspaceRootDir = path.join(tempBaseDir, "workspaces");
    await fs.mkdir(workspaceRootDir, { recursive: true });

    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: workspaceRootDir });
    adapter = new GitDiffToolAdapter(workspaceAdapter);

    const ws = await workspaceAdapter.provisionWorkspace({
      workspaceId,
      runId: "run-test-1",
      taskId: "task-test-1",
      maxWorkspaceBytes: 50 * 1024 * 1024,
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
    workspaceHostPath = ws.hostPath;

    await createMockGitRepository(workspaceHostPath, [
      { path: "README.md", content: "Line A\nLine B\nLine C\n" },
      { path: "src/main.ts", content: "console.log('original');\n" },
    ]);
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
      toolName: "git_diff",
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

  function makeDiffInput(partial?: Partial<GitDiffInput>): GitDiffInput {
    return {
      staged: false,
      ...partial,
    };
  }

  it("returns clean diff when working tree matches index", async () => {
    const res = await adapter.execute(makeContext(), makeDiffInput());

    expect(res.diff).toBe("");
    expect(res.filesChanged).toBe(0);
    expect(res.insertions).toBe(0);
    expect(res.deletions).toBe(0);
    expect(res.isTruncated).toBe(false);
  });

  it("computes unified diff for modified file", async () => {
    const readme = path.join(workspaceHostPath, "README.md");
    await fs.writeFile(readme, "Line A\nLine B (modified)\nLine C\nLine D\n", "utf8");

    const res = await adapter.execute(makeContext(), makeDiffInput());

    expect(res.filesChanged).toBe(1);
    expect(res.insertions).toBeGreaterThan(0);
    expect(res.deletions).toBeGreaterThan(0);
    expect(res.diff).toContain("diff --git a/README.md b/README.md");
    expect(res.diff).toContain("--- a/README.md");
    expect(res.diff).toContain("+++ b/README.md");
    expect(res.diff).toContain("+Line B (modified)");
    expect(res.diff).toContain("+Line D");
    expect(res.diffHash).toBeDefined();

    // Restore
    await fs.writeFile(readme, "Line A\nLine B\nLine C\n", "utf8");
  });

  it("computes unified diff for deleted file", async () => {
    const readme = path.join(workspaceHostPath, "README.md");
    await fs.rm(readme, { force: true });

    const res = await adapter.execute(makeContext(), makeDiffInput());

    expect(res.filesChanged).toBe(1);
    expect(res.deletions).toBe(3);
    expect(res.insertions).toBe(0);
    expect(res.diff).toContain("diff --git a/README.md b/README.md");
    expect(res.diff).toContain("deleted file mode 100644");
    expect(res.diff).toContain("--- a/README.md");
    expect(res.diff).toContain("+++ /dev/null");

    // Restore
    await fs.writeFile(readme, "Line A\nLine B\nLine C\n", "utf8");
  });

  it("enforces maxBytes ceiling and truncates diff output", async () => {
    const readme = path.join(workspaceHostPath, "README.md");
    await fs.writeFile(readme, "Line A modified\nLine B modified\n", "utf8");

    const res = await adapter.execute(makeContext(), makeDiffInput({ maxBytes: 25 }));

    expect(res.isTruncated).toBe(true);
    expect(Buffer.byteLength(res.diff, "utf8")).toBeLessThanOrEqual(25);

    // Restore
    await fs.writeFile(readme, "Line A\nLine B\nLine C\n", "utf8");
  });

  it("rejects path outside workspace boundary", async () => {
    await expect(
      adapter.execute(makeContext(), makeDiffInput({ path: "../../outside" }))
    ).rejects.toThrow(ToolWorkspaceBoundaryViolationError);
  });

  it("rejects non-git directory", async () => {
    const nonGitWsId = "ws-non-git-diff";
    const nonGitWs = await workspaceAdapter.provisionWorkspace({
      workspaceId: nonGitWsId,
      runId: "run-test-3",
      taskId: "task-test-3",
      maxWorkspaceBytes: 50 * 1024 * 1024,
      maxFileSizeBytes: 10 * 1024 * 1024,
    });

    const nonGitContext = makeContext({
      workspace: {
        workspaceId: nonGitWsId,
        hostPath: nonGitWs.hostPath,
      },
    });

    await expect(adapter.execute(nonGitContext, makeDiffInput())).rejects.toThrow(
      ToolExecutionFailedError
    );
  });

  it("aborts execution when AbortSignal is cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Git diff cancelled"));

    await expect(
      adapter.execute(makeContext({ abortSignal: controller.signal }), makeDiffInput())
    ).rejects.toThrow(ToolCancelledError);
  });
});
