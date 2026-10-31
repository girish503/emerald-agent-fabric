import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import {
  InvalidWorkspaceError,
  InvalidWorkspacePathError,
  WorkspacePathOutsideBoundaryError,
  WorkspaceStateError,
} from "../../src/domain/errors.js";
import { WorkspaceSpec } from "../../src/domain/workspace.js";

describe("NodeFsWorkspaceAdapter — Local Filesystem Workspace & Security Boundary", () => {
  let testBaseDir: string;
  let workspaceRootDir: string;
  let externalDir: string;
  let adapter: NodeFsWorkspaceAdapter;

  beforeAll(async () => {
    testBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "emerald-ws-test-"));
    workspaceRootDir = path.join(testBaseDir, "workspaces");
    externalDir = path.join(testBaseDir, "external-target");

    await fs.mkdir(workspaceRootDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(externalDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(externalDir, "secret.txt"), "TOP_SECRET_DATA", "utf8");

    adapter = new NodeFsWorkspaceAdapter({
      workspaceRoot: workspaceRootDir,
    });
  });

  afterAll(async () => {
    if (testBaseDir) {
      await fs.rm(testBaseDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  /**
   * Helper to create directory junctions (Windows) or symlinks (POSIX).
   * Directory junctions on Windows can be created without elevated privileges.
   */
  async function createDirectoryLink(target: string, linkPath: string): Promise<boolean> {
    try {
      const linkType = process.platform === "win32" ? "junction" : "dir";
      await fs.symlink(target, linkPath, linkType);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Helper to create file symlinks (may require Developer Mode on Windows).
   */
  async function createFileLink(target: string, linkPath: string): Promise<boolean> {
    try {
      await fs.symlink(target, linkPath, "file");
      return true;
    } catch {
      return false;
    }
  }

  describe("1. Workspace Root Validation & Protection", () => {
    it("rejects non-absolute workspace root", () => {
      expect(() => {
        new NodeFsWorkspaceAdapter({ workspaceRoot: "relative/path" });
      }).toThrowError(InvalidWorkspacePathError);
    });

    it("rejects empty or whitespace workspace root", () => {
      expect(() => {
        new NodeFsWorkspaceAdapter({ workspaceRoot: "" });
      }).toThrowError(InvalidWorkspacePathError);

      expect(() => {
        new NodeFsWorkspaceAdapter({ workspaceRoot: "   " });
      }).toThrowError(InvalidWorkspacePathError);
    });

    it("rejects user home directory as workspace root", () => {
      expect(() => {
        new NodeFsWorkspaceAdapter({ workspaceRoot: os.homedir() });
      }).toThrowError(InvalidWorkspacePathError);
    });

    it("rejects current repository root as workspace root", () => {
      expect(() => {
        new NodeFsWorkspaceAdapter({ workspaceRoot: process.cwd() });
      }).toThrowError(InvalidWorkspacePathError);
    });
  });

  describe("2. Workspace Provisioning", () => {
    const spec1: WorkspaceSpec = {
      workspaceId: "ws-001",
      runId: "run-001",
      taskId: "task-001",
      maxWorkspaceBytes: 100 * 1024 * 1024,
      maxFileSizeBytes: 10 * 1024 * 1024,
    };

    it("provisions a valid workspace and returns an immutable WorkspaceHandle", async () => {
      const handle = await adapter.provisionWorkspace(spec1);

      expect(handle.workspaceId).toBe("ws-001");
      expect(handle.runId).toBe("run-001");
      expect(handle.containerMountPath).toBe("/workspace");
      expect(handle.maxWorkspaceBytes).toBe(100 * 1024 * 1024);
      expect(Object.isFrozen(handle)).toBe(true);

      const stat = await fs.lstat(handle.hostPath);
      expect(stat.isDirectory()).toBe(true);
      expect(adapter.isWorkspaceActive("ws-001")).toBe(true);
      expect(adapter.getWorkspaceHandle("ws-001")).toEqual(handle);
    });

    it("rejects duplicate provisioning of the same workspaceId", async () => {
      await expect(adapter.provisionWorkspace(spec1)).rejects.toThrowError(WorkspaceStateError);
    });

    it("rejects invalid workspaceId containing traversal or slashes", async () => {
      const invalidSpec: WorkspaceSpec = {
        workspaceId: "../malicious",
        runId: "run-bad",
        taskId: "task-bad",
        maxWorkspaceBytes: 1000,
        maxFileSizeBytes: 100,
      };

      await expect(adapter.provisionWorkspace(invalidSpec)).rejects.toThrowError(
        InvalidWorkspaceError
      );
    });

    it("fails closed if the target directory already exists on disk", async () => {
      const preExistingDir = path.join(workspaceRootDir, "ws-pre-existing");
      await fs.mkdir(preExistingDir, { recursive: true });

      const conflictSpec: WorkspaceSpec = {
        workspaceId: "ws-pre-existing",
        runId: "run-conflict",
        taskId: "task-conflict",
        maxWorkspaceBytes: 1000,
        maxFileSizeBytes: 100,
      };

      await expect(adapter.provisionWorkspace(conflictSpec)).rejects.toThrowError(
        WorkspaceStateError
      );
    });
  });

  describe("3. Path Resolution & Lexical Boundary Verification", () => {
    it("resolves workspace root when path is '.'", async () => {
      const hostPath = await adapter.resolvePath("ws-001", ".");
      const expectedHost = adapter.getWorkspaceHandle("ws-001")!.hostPath;
      expect(hostPath).toBe(expectedHost);
    });

    it("resolves safe existing file inside workspace", async () => {
      const wsHandle = adapter.getWorkspaceHandle("ws-001")!;
      const filePath = path.join(wsHandle.hostPath, "src", "index.ts");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "console.log('hello');", "utf8");

      const resolved = await adapter.resolvePath("ws-001", "src/index.ts");
      expect(resolved).toBe(await fs.realpath(filePath));
    });

    it("rejects lexical parent directory traversal escaping workspace", async () => {
      await expect(adapter.resolvePath("ws-001", "../secret.txt")).rejects.toThrowError(
        WorkspacePathOutsideBoundaryError
      );

      await expect(
        adapter.resolvePath("ws-001", "src/../../outside.txt")
      ).rejects.toThrowError(WorkspacePathOutsideBoundaryError);
    });

    it("rejects absolute POSIX and Windows paths", async () => {
      await expect(adapter.resolvePath("ws-001", "/etc/passwd")).rejects.toThrowError(
        WorkspacePathOutsideBoundaryError
      );

      await expect(adapter.resolvePath("ws-001", "C:\\Windows\\System32")).rejects.toThrowError(
        WorkspacePathOutsideBoundaryError
      );
    });

    it("rejects null bytes and Windows device names", async () => {
      await expect(adapter.resolvePath("ws-001", "file\0.txt")).rejects.toThrowError(
        InvalidWorkspacePathError
      );

      await expect(adapter.resolvePath("ws-001", "CON.txt")).rejects.toThrowError(
        InvalidWorkspacePathError
      );
    });

    it("rejects resolution for unprovisioned workspaceId", async () => {
      await expect(adapter.resolvePath("ws-nonexistent", "file.txt")).rejects.toThrowError(
        WorkspaceStateError
      );
    });
  });

  describe("4. Nonexistent Paths (Future Write Targets)", () => {
    it("resolves safe nonexistent file in workspace root", async () => {
      const wsHandle = adapter.getWorkspaceHandle("ws-001")!;
      const resolved = await adapter.resolvePath("ws-001", "new-file.ts");
      expect(resolved).toBe(path.join(wsHandle.hostPath, "new-file.ts"));
    });

    it("resolves safe nonexistent file in existing subdirectory", async () => {
      const wsHandle = adapter.getWorkspaceHandle("ws-001")!;
      const resolved = await adapter.resolvePath("ws-001", "src/new-component.tsx");
      expect(resolved).toBe(path.join(wsHandle.hostPath, "src", "new-component.tsx"));
    });

    it("resolves safe nonexistent file in nonexistent nested directories", async () => {
      const wsHandle = adapter.getWorkspaceHandle("ws-001")!;
      const resolved = await adapter.resolvePath("ws-001", "deep/nested/sub/file.json");
      expect(resolved).toBe(path.join(wsHandle.hostPath, "deep", "nested", "sub", "file.json"));
    });
  });

  describe("5. Prefix Collision Defense (ws-1 vs ws-10)", () => {
    it("prevents false containment when workspace IDs share prefix", async () => {
      const specA: WorkspaceSpec = {
        workspaceId: "ws-1",
        runId: "run-1",
        taskId: "task-1",
        maxWorkspaceBytes: 1000,
        maxFileSizeBytes: 100,
      };

      const specB: WorkspaceSpec = {
        workspaceId: "ws-10",
        runId: "run-10",
        taskId: "task-10",
        maxWorkspaceBytes: 1000,
        maxFileSizeBytes: 100,
      };

      await adapter.provisionWorkspace(specA);
      await adapter.provisionWorkspace(specB);

      const handleB = adapter.getWorkspaceHandle("ws-10")!;
      await fs.writeFile(path.join(handleB.hostPath, "b-secret.txt"), "DATA_B", "utf8");

      // Verify that ws-1 cannot resolve into ws-10 via relative path
      await expect(
        adapter.resolvePath("ws-1", "../ws-10/b-secret.txt")
      ).rejects.toThrowError(WorkspacePathOutsideBoundaryError);
    });
  });

  describe("6. Cross-Workspace Isolation", () => {
    it("guarantees Workspace A cannot access Workspace B files", async () => {
      const handleA = adapter.getWorkspaceHandle("ws-1")!;
      const handleB = adapter.getWorkspaceHandle("ws-10")!;

      expect(handleA.workspaceId).not.toBe(handleB.workspaceId);
      expect(handleA.hostPath).not.toBe(handleB.hostPath);

      // Even if a directory junction is placed in ws-1 pointing to ws-10
      const linkPath = path.join(handleA.hostPath, "link_to_ws10");
      const created = await createDirectoryLink(handleB.hostPath, linkPath);

      if (created) {
        // Attempting to resolve through the symlink must FAIL closed
        await expect(
          adapter.resolvePath("ws-1", "link_to_ws10/b-secret.txt")
        ).rejects.toThrowError(WorkspacePathOutsideBoundaryError);
      }
    });
  });

  describe("7. Symlink & Junction Escape Defense", () => {
    it("rejects existing file accessed through external directory symlink/junction", async () => {
      const wsHandle = adapter.getWorkspaceHandle("ws-001")!;
      const linkPath = path.join(wsHandle.hostPath, "external_link");
      const created = await createDirectoryLink(externalDir, linkPath);

      if (created) {
        // Lexically inside ws-001, but realpath points to externalDir
        await expect(
          adapter.resolvePath("ws-001", "external_link/secret.txt")
        ).rejects.toThrowError(WorkspacePathOutsideBoundaryError);
      }
    });

    it("rejects nonexistent file beneath external directory symlink/junction", async () => {
      const wsHandle = adapter.getWorkspaceHandle("ws-001")!;
      const linkPath = path.join(wsHandle.hostPath, "external_link");

      // Ensure directory link exists
      await createDirectoryLink(externalDir, linkPath).catch(() => {});

      // Target does not exist, but parent ancestor is an external symlink!
      await expect(
        adapter.resolvePath("ws-001", "external_link/new-outside-file.txt")
      ).rejects.toThrowError(WorkspacePathOutsideBoundaryError);
    });

    it("rejects direct file symlink pointing outside workspace", async () => {
      const wsHandle = adapter.getWorkspaceHandle("ws-001")!;
      const targetFile = path.join(externalDir, "secret.txt");
      const linkFile = path.join(wsHandle.hostPath, "symlink_secret.txt");

      const created = await createFileLink(targetFile, linkFile);
      if (created) {
        await expect(
          adapter.resolvePath("ws-001", "symlink_secret.txt")
        ).rejects.toThrowError(WorkspacePathOutsideBoundaryError);
      }
    });

    it("rejects nested multi-level symlink escaping workspace", async () => {
      const wsHandle = adapter.getWorkspaceHandle("ws-001")!;
      const intermediateDir = path.join(wsHandle.hostPath, "intermediate");
      await fs.mkdir(intermediateDir, { recursive: true });

      const linkPath = path.join(intermediateDir, "jump");
      const created = await createDirectoryLink(externalDir, linkPath);

      if (created) {
        await expect(
          adapter.resolvePath("ws-001", "intermediate/jump/secret.txt")
        ).rejects.toThrowError(WorkspacePathOutsideBoundaryError);
      }
    });
  });

  describe("8. Safe Workspace Disposal", () => {
    it("disposes an active workspace, recursively removing host directory", async () => {
      const specDisp: WorkspaceSpec = {
        workspaceId: "ws-dispose-1",
        runId: "run-disp-1",
        taskId: "task-disp-1",
        maxWorkspaceBytes: 1000,
        maxFileSizeBytes: 100,
      };

      const handle = await adapter.provisionWorkspace(specDisp);
      // Create nested directories and files
      const subDir = path.join(handle.hostPath, "build", "dist");
      await fs.mkdir(subDir, { recursive: true });
      await fs.writeFile(path.join(subDir, "bundle.js"), "var app=1;", "utf8");

      expect(adapter.isWorkspaceActive("ws-dispose-1")).toBe(true);

      await adapter.disposeWorkspace("ws-dispose-1");

      expect(adapter.isWorkspaceActive("ws-dispose-1")).toBe(false);

      // Verify directory no longer exists on disk
      await expect(fs.lstat(handle.hostPath)).rejects.toThrow();
    });

    it("disposes workspace containing read-only files without failure", async () => {
      const specRo: WorkspaceSpec = {
        workspaceId: "ws-readonly-1",
        runId: "run-ro-1",
        taskId: "task-ro-1",
        maxWorkspaceBytes: 1000,
        maxFileSizeBytes: 100,
      };

      const handle = await adapter.provisionWorkspace(specRo);
      const roFile = path.join(handle.hostPath, "read-only.txt");
      await fs.writeFile(roFile, "IMMUTABLE_ARTIFACT", "utf8");
      // Set read-only
      await fs.chmod(roFile, 0o444).catch(() => {});

      await adapter.disposeWorkspace("ws-readonly-1");
      await expect(fs.lstat(handle.hostPath)).rejects.toThrow();
    });

    it("handles repeated disposal idempotently", async () => {
      await expect(adapter.disposeWorkspace("ws-dispose-1")).resolves.not.toThrow();
    });

    it("rejects disposal with invalid workspaceId", async () => {
      await expect(adapter.disposeWorkspace("")).rejects.toThrowError(InvalidWorkspaceError);
      await expect(adapter.disposeWorkspace("../escape")).rejects.toThrowError(
        InvalidWorkspaceError
      );
    });

    it("defends against symlink substitution attack on workspace directory", async () => {
      // Scenario: An attacker removes ws-sym-sub on disk and replaces it with a symlink to externalDir
      const subSpec: WorkspaceSpec = {
        workspaceId: "ws-sym-sub",
        runId: "run-sub",
        taskId: "task-sub",
        maxWorkspaceBytes: 1000,
        maxFileSizeBytes: 100,
      };

      const handle = await adapter.provisionWorkspace(subSpec);
      // Remove the directory
      await fs.rm(handle.hostPath, { recursive: true, force: true });

      // Substitute with a symlink pointing to externalDir
      const substituted = await createDirectoryLink(externalDir, handle.hostPath);
      if (substituted) {
        // Disposing ws-sym-sub must UNLINK the symlink, NOT recursively delete externalDir!
        await adapter.disposeWorkspace("ws-sym-sub");

        // The symlink must be removed
        await expect(fs.lstat(handle.hostPath)).rejects.toThrow();

        // The externalDir MUST STILL EXIST intact!
        const externalStat = await fs.lstat(externalDir);
        expect(externalStat.isDirectory()).toBe(true);
        const secretContent = await fs.readFile(path.join(externalDir, "secret.txt"), "utf8");
        expect(secretContent).toBe("TOP_SECRET_DATA");
      }
    });
  });

  describe("9. Safe Orphan Workspace Cleanup", () => {
    it("reclaims unleased orphaned directories while protecting active ones", async () => {
      const activeSpec: WorkspaceSpec = {
        workspaceId: "ws-active-99",
        runId: "run-active-99",
        taskId: "task-active-99",
        maxWorkspaceBytes: 1000,
        maxFileSizeBytes: 100,
      };

      const handleActive = await adapter.provisionWorkspace(activeSpec);

      // Create an orphaned directory on disk (simulating crashed worker)
      const orphanDir = path.join(workspaceRootDir, "ws-orphan-crash-1");
      await fs.mkdir(orphanDir, { recursive: true });
      await fs.writeFile(path.join(orphanDir, "leftover.log"), "crash dump", "utf8");

      // Active set contains only ws-active-99
      const activeIds = new Set(["ws-active-99"]);

      const reclaimed = await adapter.cleanupOrphanedWorkspaces(activeIds, { reclaimUnowned: true });

      expect(reclaimed).toContain("ws-orphan-crash-1");
      expect(reclaimed).not.toContain("ws-active-99");

      // Orphan directory was deleted
      await expect(fs.lstat(orphanDir)).rejects.toThrow();

      // Active directory remains intact
      const activeStat = await fs.lstat(handleActive.hostPath);
      expect(activeStat.isDirectory()).toBe(true);

      // Clean up active
      await adapter.disposeWorkspace("ws-active-99");
    });
  });
});
