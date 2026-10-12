import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WriteFileToolAdapter } from "../../../src/adapters/tools/write-file.tool-adapter.js";
import { NodeFsWorkspaceAdapter } from "../../../src/adapters/workspace/node-fs-workspace-adapter.js";
import {
  ToolCancelledError,
  ToolExecutionFailedError,
  ToolOutputLimitExceededError,
  ToolWorkspaceBoundaryViolationError,
} from "../../../src/domain/errors.js";
import { ToolExecutionContext } from "../../../src/ports/tool-adapter.port.js";

describe("WriteFileToolAdapter — Workspace-Confined Atomic File Writing", () => {
  let tempBaseDir: string;
  let workspaceRootDir: string;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let adapter: WriteFileToolAdapter;

  const workspaceId = "ws-write-file-test";
  let workspaceHostPath: string;

  beforeAll(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-tool-test-"));
    workspaceRootDir = path.join(tempBaseDir, "workspaces");
    await fs.mkdir(workspaceRootDir, { recursive: true });

    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: workspaceRootDir });
    adapter = new WriteFileToolAdapter(workspaceAdapter);

    const ws = await workspaceAdapter.provisionWorkspace({
      workspaceId,
      runId: "run-test-1",
      taskId: "task-test-1",
      maxWorkspaceBytes: 50 * 1024 * 1024,
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
    workspaceHostPath = ws.hostPath;
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
      toolName: "write_file",
      requiredCapability: "workspace.file.write",
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

  it("creates a new file atomically and returns created: true with hash", async () => {
    const res = await adapter.execute(makeContext(), {
      path: "notes.txt",
      content: "Hello Emerald Fabric!",
      overwrite: true,
    });

    expect(res.path).toBe("notes.txt");
    expect(res.created).toBe(true);
    expect(res.bytesWritten).toBe(Buffer.byteLength("Hello Emerald Fabric!", "utf8"));

    const diskContent = await fs.readFile(
      path.join(workspaceHostPath, "notes.txt"),
      "utf8"
    );
    expect(diskContent).toBe("Hello Emerald Fabric!");

    const expectedHash = crypto
      .createHash("sha256")
      .update("Hello Emerald Fabric!", "utf8")
      .digest("hex");
    expect(res.contentHash).toBe(expectedHash);
  });

  it("automatically creates parent directories inside workspace", async () => {
    const res = await adapter.execute(makeContext(), {
      path: "deep/nested/dir/test.txt",
      content: "Deep content",
      overwrite: true,
    });

    expect(res.created).toBe(true);
    const diskContent = await fs.readFile(
      path.join(workspaceHostPath, "deep/nested/dir/test.txt"),
      "utf8"
    );
    expect(diskContent).toBe("Deep content");
  });

  it("overwrites an existing file when overwrite is true", async () => {
    const res = await adapter.execute(makeContext(), {
      path: "notes.txt",
      content: "Updated Content",
      overwrite: true,
    });

    expect(res.created).toBe(false);
    expect(res.bytesWritten).toBe(Buffer.byteLength("Updated Content", "utf8"));
    const diskContent = await fs.readFile(
      path.join(workspaceHostPath, "notes.txt"),
      "utf8"
    );
    expect(diskContent).toBe("Updated Content");
  });

  it("rejects overwrite when overwrite is false", async () => {
    await expect(
      adapter.execute(makeContext(), {
        path: "notes.txt",
        content: "Should Fail",
        overwrite: false,
      })
    ).rejects.toThrow(ToolExecutionFailedError);
  });

  it("rejects writing when content exceeds maxBytes ceiling", async () => {
    await expect(
      adapter.execute(makeContext(), {
        path: "large.txt",
        content: "1234567890",
        maxBytes: 5,
        overwrite: true,
      })
    ).rejects.toThrow(ToolOutputLimitExceededError);
  });

  it("rejects path traversal attempting to escape workspace boundary", async () => {
    await expect(
      adapter.execute(makeContext(), {
        path: "../../escaped.txt",
        content: "Malicious payload",
        overwrite: true,
      })
    ).rejects.toThrow(ToolWorkspaceBoundaryViolationError);
  });

  it("rejects writing to symlinks inside workspace", async () => {
    const targetFile = path.join(workspaceHostPath, "real-target.txt");
    const linkFile = path.join(workspaceHostPath, "link-to-target.txt");
    await fs.writeFile(targetFile, "Original", "utf8");

    try {
      await fs.symlink(targetFile, linkFile);
      await expect(
        adapter.execute(makeContext(), {
          path: "link-to-target.txt",
          content: "Symlink Overwrite Attempt",
          overwrite: true,
        })
      ).rejects.toThrow(ToolWorkspaceBoundaryViolationError);
    } catch (err: any) {
      // If symlinks cannot be created without elevated privileges on Windows, skip gracefully
      if (err.code !== "EPERM") {
        throw err;
      }
    }
  });

  it("aborts execution when AbortSignal is cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Write aborted"));

    await expect(
      adapter.execute(makeContext({ abortSignal: controller.signal }), {
        path: "aborted.txt",
        content: "Will not write",
        overwrite: true,
      })
    ).rejects.toThrow(ToolCancelledError);
  });
});
