/**
 * Adversarial & Isolation Test Suite for Docker Sandbox (Track E)
 *
 * Verifies multi-tenant confinement, image allowlisting, resource limits validation,
 * output limit enforcement, cancellation, and container tenant labeling.
 */

import { describe, expect, it } from "vitest";
import {
  DockerExecutionProvider,
  type DockerChildProcess,
  type DockerSpawn,
} from "../../src/adapters/execution/docker-execution-provider.js";
import type { SubprocessRunner } from "../../src/adapters/execution/docker-tenant-quiescence-adapter.js";
import type { ExecutionRequest } from "../../src/ports/execution-provider.port.js";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("Track E — Adversarial Sandbox & Isolation Tests", () => {
  describe("Multi-Tenant Workspace Confinement", () => {
    it("prohibits Tenant A from mounting Tenant B's workspace", async () => {
      const provider = new DockerExecutionProvider();

      const request: ExecutionRequest = {
        runId: "run-cross-tenant-attack",
        taskId: "task-attack",
        tenantId: "tenant-A",
        operationName: "run_command",
        inputPayload: { argv: ["ls", "-la"] },
        workspace: {
          hostPath: "C:\\emerald\\data\\tenants\\tenant-B\\workspace",
          containerMountPath: "/workspace",
        },
        idempotencyToken: "tok-cross-1",
        attemptNumber: 0,
        timeoutMs: 5000,
      };

      const result = await provider.execute(request);
      expect(result.status).toBe("FAILED");
      expect(result.error?.message).toContain("Cross-tenant mount prohibited");
      expect(result.error?.message).toContain("belongs to tenant 'tenant-B'");
      expect(result.error?.message).toContain("request is for tenant 'tenant-A'");
    });

    it("attaches emerald.tenant label when tenantId is supplied", async () => {
      const allCalls: string[][] = [];
      const mockRunner: SubprocessRunner = async (_bin, args) => {
        allCalls.push([...args]);
        if (args.includes("create")) {
          return { exitCode: 0, stdout: "1122334455667788", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      };

      const mockSpawn: DockerSpawn = () => {
        const ee = new EventEmitter() as unknown as DockerChildProcess;
        (ee as any).stdin = { write: () => {}, end: () => {}, on: () => {} };
        (ee as any).stdout = new EventEmitter();
        (ee as any).stderr = new EventEmitter();
        (ee as any).kill = () => {
          setTimeout(() => (ee as any).emit("close", 0, "SIGKILL"), 10);
        };
        setTimeout(() => (ee as any).emit("close", 0, null), 10);
        return ee;
      };

      const provider = new DockerExecutionProvider({
        commandRunner: mockRunner,
        spawnProcess: mockSpawn,
      });

      const request: ExecutionRequest = {
        runId: "run-label-test",
        taskId: "task-label",
        tenantId: "tenant-finance-prod",
        operationName: "echo",
        inputPayload: { foo: "bar" },
        idempotencyToken: "tok-label",
        attemptNumber: 1,
        timeoutMs: 5000,
      };

      await provider.execute(request);
      const createCall = allCalls.find((call) => call.includes("create"));
      expect(createCall).toBeDefined();
      expect(createCall).toContain("--label");
      expect(createCall).toContain("emerald.tenant=tenant-finance-prod");
    });

    it("rejects MULTI_TENANT_WORKLOAD when tenantId is missing", async () => {
      const provider = new DockerExecutionProvider();
      const request: ExecutionRequest = {
        runId: "run-no-tenant-mt",
        taskId: "task-no-tenant",
        trustClassification: "MULTI_TENANT_WORKLOAD",
        operationName: "run_command",
        inputPayload: { argv: ["echo", "test"] },
        idempotencyToken: "tok-no-tenant",
        attemptNumber: 0,
        timeoutMs: 5000,
      };

      const result = await provider.execute(request);
      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("SANDBOX_CONFIGURATION_INVALID");
      expect(result.error?.message).toContain("MULTI_TENANT_WORKLOAD requires an explicit non-empty tenantId");
    });
  });

  describe("Canonical Filesystem & Symlink Containment (Workstream 4)", () => {
    it("fails closed when workspace mount is a symlink escaping to a sensitive host directory", async () => {
      const provider = new DockerExecutionProvider();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-symlink-test-"));
      const symlinkPath = path.join(tempDir, "escape-link");

      try {
        // Create a symlink pointing to user home or os.tmpdir
        try {
          fs.symlinkSync(os.homedir(), symlinkPath, "dir");
        } catch {
          // If Windows unprivileged user cannot create dir symlinks without developer mode,
          // skip symlink creation and test directory resolution directly
          return;
        }

        const request: ExecutionRequest = {
          runId: "run-symlink-escape",
          taskId: "task-symlink",
          operationName: "run_command",
          inputPayload: { argv: ["ls"] },
          workspace: {
            hostPath: symlinkPath,
            containerMountPath: "/workspace",
          },
          idempotencyToken: "tok-symlink-1",
          attemptNumber: 0,
          timeoutMs: 5000,
        };

        const result = await provider.execute(request);
        expect(result.status).toBe("FAILED");
        expect(result.error?.message).toMatch(/Security violation.*Refusing to mount/);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("fails closed when workspace mount is a broken symlink", async () => {
      const provider = new DockerExecutionProvider();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-broken-link-"));
      const nonExistentTarget = path.join(tempDir, "does-not-exist-" + Date.now());
      const brokenLink = path.join(tempDir, "broken-symlink");

      try {
        try {
          fs.symlinkSync(nonExistentTarget, brokenLink, "file");
        } catch {
          return; // Skip on Windows if permissions prohibit symlinks
        }

        const request: ExecutionRequest = {
          runId: "run-broken-symlink",
          taskId: "task-symlink",
          operationName: "run_command",
          inputPayload: { argv: ["ls"] },
          workspace: {
            hostPath: brokenLink,
            containerMountPath: "/workspace",
          },
          idempotencyToken: "tok-symlink-2",
          attemptNumber: 0,
          timeoutMs: 5000,
        };

        const result = await provider.execute(request);
        expect(result.status).toBe("FAILED");
        expect(result.error?.message).toMatch(/Security violation.*Unable to resolve canonical path/);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("prevents prefix confusion attacks between tenant directories", async () => {
      const mockRootlessRunner: SubprocessRunner = async () => ({
        exitCode: 0,
        stdout: '["name=rootless"]|26.0.0|/home/user/.local/share/docker',
        stderr: "",
      });
      const provider = new DockerExecutionProvider({ commandRunner: mockRootlessRunner });
      const request: ExecutionRequest = {
        runId: "run-prefix-confusion",
        taskId: "task-prefix",
        tenantId: "tenant-alpha",
        trustClassification: "MULTI_TENANT_WORKLOAD",
        operationName: "run_command",
        inputPayload: { argv: ["pwd"] },
        workspace: {
          hostPath: "C:\\emerald\\data\\tenants\\tenant-alpha-secret\\workspace",
          containerMountPath: "/workspace",
        },
        idempotencyToken: "tok-prefix-1",
        attemptNumber: 0,
        timeoutMs: 5000,
      };

      const result = await provider.execute(request);
      expect(result.status).toBe("FAILED");
      expect(result.error?.message).toContain("Cross-tenant mount prohibited");
      expect(result.error?.message).toContain("tenant-alpha-secret");
    });
  });

  describe("Image Allowlist Enforcement", () => {
    it("rejects unapproved container images with IMAGE_POLICY_REJECTED", async () => {
      const provider = new DockerExecutionProvider({
        image: "untrusted-registry.example.com/malicious-container:latest",
        imageAllowlist: ["node:22-alpine", "alpine:latest"],
      });

      const request: ExecutionRequest = {
        runId: "run-unapproved-image",
        taskId: "task-img",
        operationName: "echo",
        inputPayload: { safe: false },
        idempotencyToken: "tok-img",
        attemptNumber: 0,
        timeoutMs: 5000,
      };

      const result = await provider.execute(request);
      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("IMAGE_POLICY_REJECTED");
      expect(result.error?.message).toContain("is not permitted by image allowlist");
      expect(result.providerMetadata?.imageRejected).toBe(
        "untrusted-registry.example.com/malicious-container:latest"
      );
    });
  });

  describe("Resource Limits Pre-Validation at Construction", () => {
    it("rejects non-positive pidsLimit", () => {
      expect(() => new DockerExecutionProvider({ pidsLimit: 0 })).toThrow(/Invalid pidsLimit/);
      expect(() => new DockerExecutionProvider({ pidsLimit: -10 })).toThrow(/Invalid pidsLimit/);
    });

    it("rejects non-positive maxOutputBytes", () => {
      expect(() => new DockerExecutionProvider({ maxOutputBytes: 0 })).toThrow(/Invalid maxOutputBytes/);
      expect(() => new DockerExecutionProvider({ maxOutputBytes: -1024 })).toThrow(/Invalid maxOutputBytes/);
    });

    it("rejects non-positive cpuLimit", () => {
      expect(() => new DockerExecutionProvider({ cpuLimit: "0" })).toThrow(/Invalid cpuLimit/);
      expect(() => new DockerExecutionProvider({ cpuLimit: "-0.5" })).toThrow(/Invalid cpuLimit/);
      expect(() => new DockerExecutionProvider({ cpuLimit: "not-a-number" })).toThrow(/Invalid cpuLimit/);
    });

    it("rejects negative stopGraceSeconds", () => {
      expect(() => new DockerExecutionProvider({ stopGraceSeconds: -1 })).toThrow(/Invalid stopGraceSeconds/);
    });

    it("rejects non-positive terminationTimeoutMs", () => {
      expect(() => new DockerExecutionProvider({ terminationTimeoutMs: 0 })).toThrow(/Invalid terminationTimeoutMs/);
      expect(() => new DockerExecutionProvider({ terminationTimeoutMs: -500 })).toThrow(/Invalid terminationTimeoutMs/);
    });
  });

  describe("Output Limit Flooding & Error Code", () => {
    it("terminates container and returns OUTPUT_LIMIT_EXCEEDED when stdout floods", async () => {
      const mockRunner: SubprocessRunner = async (_bin, args) => {
        if (args.includes("info")) {
          return { exitCode: 0, stdout: '["name=rootless"]|26.0.0|/home/user/.local/share/docker', stderr: "" };
        }
        if (args.includes("create")) {
          return { exitCode: 0, stdout: "abcdef1234567890", stderr: "" };
        }
        if (args.includes("ps")) {
          return { exitCode: 0, stdout: "", stderr: "" }; // Quiescent
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      };

      const mockSpawn: DockerSpawn = () => {
        const ee = new EventEmitter() as unknown as DockerChildProcess;
        (ee as any).stdin = { write: () => {}, end: () => {}, on: () => {} };
        const stdoutEE = new EventEmitter();
        (ee as any).stdout = stdoutEE;
        (ee as any).stderr = new EventEmitter();
        (ee as any).kill = () => {
          setTimeout(() => (ee as any).emit("close", 0, "SIGKILL"), 10);
        };

        setTimeout(() => {
          // Emit a flood exceeding maxOutputBytes (1024 bytes)
          stdoutEE.emit("data", Buffer.alloc(2048, "X"));
        }, 10);

        return ee;
      };

      const provider = new DockerExecutionProvider({
        maxOutputBytes: 1024,
        commandRunner: mockRunner,
        spawnProcess: mockSpawn,
      });

      const request: ExecutionRequest = {
        runId: "run-flood-test",
        taskId: "task-flood",
        operationName: "echo",
        inputPayload: { flood: true },
        idempotencyToken: "tok-flood",
        attemptNumber: 0,
        timeoutMs: 5000,
      };

      const result = await provider.execute(request);
      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("OUTPUT_LIMIT_EXCEEDED");
      expect(result.error?.message).toContain("Output limit of 1024 bytes exceeded");
      expect(result.providerMetadata?.outputLimitExceeded).toBe(true);
      expect(result.providerMetadata?.terminationVerified).toBe(true);
    });
  });

  describe("Pre-Spawn Cancellation", () => {
    it("returns CANCELLED without creating a container if signal is already aborted", async () => {
      let createAttempted = false;
      const mockRunner: SubprocessRunner = async () => {
        createAttempted = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      };

      const provider = new DockerExecutionProvider({ commandRunner: mockRunner });
      const controller = new AbortController();
      controller.abort();

      const request: ExecutionRequest = {
        runId: "run-pre-abort",
        taskId: "task-abort",
        operationName: "echo",
        inputPayload: null,
        signal: controller.signal,
        idempotencyToken: "tok-abort",
        attemptNumber: 0,
        timeoutMs: 5000,
      };

      const result = await provider.execute(request);
      expect(result.status).toBe("CANCELLED");
      expect(result.error?.code).toBe("EXECUTION_CANCELLED");
      expect(result.providerMetadata?.preAborted).toBe(true);
      expect(result.providerMetadata?.containerCreated).toBe(false);
      expect(createAttempted).toBe(false);
    });
  });
});
