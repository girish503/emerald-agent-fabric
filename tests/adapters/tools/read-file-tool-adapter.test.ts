import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReadFileToolAdapter } from "../../../src/adapters/tools/read-file.tool-adapter.js";
import { NodeFsWorkspaceAdapter } from "../../../src/adapters/workspace/node-fs-workspace-adapter.js";
import {
  ToolCancelledError,
  ToolExecutionFailedError,
  ToolWorkspaceBoundaryViolationError,
} from "../../../src/domain/errors.js";
import { ToolExecutionContext } from "../../../src/ports/tool-adapter.port.js";
import { ReadFileInput } from "../../../src/domain/tool-schemas.js";

describe("ReadFileToolAdapter — Workspace-Confined File Reading", () => {
  let tempBaseDir: string;
  let workspaceRootDir: string;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let adapter: ReadFileToolAdapter;

  const workspaceId = "ws-read-file-test";
  let workspaceHostPath: string;

  beforeAll(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-tool-test-"));
    workspaceRootDir = path.join(tempBaseDir, "workspaces");
    await fs.mkdir(workspaceRootDir, { recursive: true });

    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: workspaceRootDir });
    adapter = new ReadFileToolAdapter(workspaceAdapter);

    const ws = await workspaceAdapter.provisionWorkspace({
      workspaceId,
      runId: "run-test-1",
      taskId: "task-test-1",
      maxWorkspaceBytes: 50 * 1024 * 1024,
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
    workspaceHostPath = ws.hostPath;

    // Create sample files
    await fs.writeFile(
      path.join(workspaceHostPath, "sample.txt"),
      "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
      "utf8"
    );
    await fs.mkdir(path.join(workspaceHostPath, "sub"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceHostPath, "sub", "nested.txt"),
      "Nested content",
      "utf8"
    );
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
      toolName: "read_file",
      requiredCapability: "workspace.file.read",
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

  function makeReadInput(
    partial: Partial<ReadFileInput> & { path: string }
  ): ReadFileInput {
    return {
      offsetLine: 1,
      limitLines: 500,
      ...partial,
    };
  }

  it("reads an existing file completely with deterministic hash", async () => {
    const res = await adapter.execute(
      makeContext(),
      makeReadInput({
        path: "sample.txt",
      })
    );

    expect(res.path).toBe("sample.txt");
    expect(res.content).toBe("Line 1\nLine 2\nLine 3\nLine 4\nLine 5");
    expect(res.totalLines).toBe(5);
    expect(res.isTruncated).toBe(false);
    expect(res.bytesRead).toBe(Buffer.byteLength(res.content, "utf8"));

    const expectedHash = crypto
      .createHash("sha256")
      .update(res.content, "utf8")
      .digest("hex");
    expect(res.contentHash).toBe(expectedHash);
  });

  it("reads nested files with relative paths", async () => {
    const res = await adapter.execute(
      makeContext(),
      makeReadInput({
        path: "sub/nested.txt",
      })
    );
    expect(res.content).toBe("Nested content");
    expect(res.path).toBe("sub/nested.txt");
  });

  it("applies offsetLine and limitLines windowing correctly", async () => {
    const res = await adapter.execute(
      makeContext(),
      makeReadInput({
        path: "sample.txt",
        offsetLine: 2,
        limitLines: 2,
      })
    );

    expect(res.content).toBe("Line 2\nLine 3");
    expect(res.totalLines).toBe(5);
    expect(res.isTruncated).toBe(true);
  });

  it("enforces maxBytes ceiling and marks output as truncated", async () => {
    const res = await adapter.execute(
      makeContext(),
      makeReadInput({
        path: "sample.txt",
        maxBytes: 10,
      })
    );

    expect(res.bytesRead).toBeLessThanOrEqual(10);
    expect(res.isTruncated).toBe(true);
  });

  it("rejects path traversal escaping the workspace boundary", async () => {
    await expect(
      adapter.execute(
        makeContext(),
        makeReadInput({
          path: "../../etc/passwd",
        })
      )
    ).rejects.toThrow(ToolWorkspaceBoundaryViolationError);
  });

  it("never discloses host absolute path in boundary violation error", async () => {
    try {
      await adapter.execute(
        makeContext(),
        makeReadInput({
          path: "../outside.txt",
        })
      );
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(ToolWorkspaceBoundaryViolationError);
      expect(err.message).not.toContain(workspaceRootDir);
    }
  });

  it("fails cleanly when target is a directory", async () => {
    await expect(
      adapter.execute(
        makeContext(),
        makeReadInput({
          path: "sub",
        })
      )
    ).rejects.toThrow(ToolExecutionFailedError);
  });

  it("fails cleanly when target file does not exist", async () => {
    await expect(
      adapter.execute(
        makeContext(),
        makeReadInput({
          path: "nonexistent.txt",
        })
      )
    ).rejects.toThrow(ToolExecutionFailedError);
  });

  it("aborts execution when AbortSignal is cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Operation cancelled"));

    await expect(
      adapter.execute(
        makeContext({ abortSignal: controller.signal }),
        makeReadInput({
          path: "sample.txt",
        })
      )
    ).rejects.toThrow(ToolCancelledError);
  });
});
