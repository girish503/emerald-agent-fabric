/**
 * Tests for Docker Sandbox Security Boundary & Isolation (Track E)
 *
 * Verifies capability dropping, rootless execution, network isolation,
 * filesystem mount restrictions, and Docker socket protection.
 */

import { describe, expect, it } from "vitest";
import { DockerExecutionProvider } from "../../src/adapters/execution/docker-execution-provider.js";
import type { ExecutionRequest } from "../../src/ports/execution-provider.port.js";

describe("Track E — Docker Security Boundary & Isolation", () => {
  it("enforces rootless user 1000:1000 by default", () => {
    const provider = new DockerExecutionProvider();
    expect(provider.config.runAsUser).toBe("1000:1000");
  });

  it("permits custom unprivileged user ID configuration", () => {
    const provider = new DockerExecutionProvider({ runAsUser: "1001:1001" });
    expect(provider.config.runAsUser).toBe("1001:1001");
  });

  it("strictly enforces networkDisabled=true and rejects network enablement", () => {
    expect(() => {
      new DockerExecutionProvider({ networkDisabled: false });
    }).toThrow(/Network access is not available/);
  });

  it("rejects mounting host user home directory", async () => {
    const provider = new DockerExecutionProvider();
    const os = await import("node:os");
    const home = os.homedir();

    const request: ExecutionRequest = {
      runId: "run-security-test",
      taskId: "task-test",
      operationName: "run_command",
      inputPayload: { argv: ["ls", "-la"] },
      workspace: { hostPath: home, containerMountPath: "/workspace" },
      idempotencyToken: "tok-sec-1",
      attemptNumber: 0,
      timeoutMs: 5000,
    };

    const result = await provider.execute(request);
    expect(result.status).toBe("FAILED");
    expect(result.error?.message).toContain("Refusing to mount host user home directory");
  });

  it("rejects mounting sensitive directories like .ssh or .docker", async () => {
    const provider = new DockerExecutionProvider();
    const path = await import("node:path");

    const sensitivePath = path.resolve(process.cwd(), ".ssh");
    const request: ExecutionRequest = {
      runId: "run-security-test",
      taskId: "task-test",
      operationName: "run_command",
      inputPayload: { argv: ["ls"] },
      workspace: { hostPath: sensitivePath, containerMountPath: "/workspace" },
      idempotencyToken: "tok-sec-2",
      attemptNumber: 0,
      timeoutMs: 5000,
    };

    const result = await provider.execute(request);
    expect(result.status).toBe("FAILED");
    expect(result.error?.message).toContain("Refusing to mount sensitive host directory");
  });

  it("rejects mounting host Docker daemon socket", async () => {
    const provider = new DockerExecutionProvider();
    const path = await import("node:path");

    const dockerSockPath = path.resolve("/var/run/docker.sock");
    const request: ExecutionRequest = {
      runId: "run-security-test",
      taskId: "task-test",
      operationName: "run_command",
      inputPayload: { argv: ["docker", "ps"] },
      workspace: { hostPath: dockerSockPath, containerMountPath: "/var/run/docker.sock" },
      idempotencyToken: "tok-sec-3",
      attemptNumber: 0,
      timeoutMs: 5000,
    };

    const result = await provider.execute(request);
    expect(result.status).toBe("FAILED");
    expect(result.error?.message).toContain("Refusing to mount sensitive host directory");
  });

  it("rejects mounting Windows Docker named pipe", async () => {
    const provider = new DockerExecutionProvider();

    const namedPipePath = "\\\\.\\pipe\\docker_engine";
    const request: ExecutionRequest = {
      runId: "run-security-test",
      taskId: "task-test",
      operationName: "run_command",
      inputPayload: { argv: ["docker", "ps"] },
      workspace: { hostPath: namedPipePath, containerMountPath: "/var/run/docker.sock" },
      idempotencyToken: "tok-sec-4",
      attemptNumber: 0,
      timeoutMs: 5000,
    };

    const result = await provider.execute(request);
    expect(result.status).toBe("FAILED");
    expect(result.error?.message).toContain("Refusing to mount sensitive host directory");
  });
});
