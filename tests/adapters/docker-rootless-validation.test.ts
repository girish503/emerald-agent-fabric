/**
 * Tests for Rootless Daemon Inspection & Validation (Track E)
 *
 * Verifies that the Docker daemon configuration (rootless vs rootful) is independently
 * inspected and distinguished from container-level non-root user execution, and that
 * requireRootlessDaemon policy fails closed when the daemon runs as host root.
 */

import { describe, expect, it } from "vitest";
import {
  DockerExecutionProvider,
} from "../../src/adapters/execution/docker-execution-provider.js";
import type { SubprocessRunner } from "../../src/adapters/execution/docker-tenant-quiescence-adapter.js";
import type { ExecutionRequest } from "../../src/ports/execution-provider.port.js";

function createMockRunner(stdout: string, exitCode = 0, stderr = ""): SubprocessRunner {
  return async () => ({
    exitCode,
    stdout,
    stderr,
  });
}

describe("Track E — Docker Rootless vs Rootful Daemon Inspection", () => {
  describe("inspectDaemonSecurity", () => {
    it("detects a genuine rootless Docker daemon via SecurityOptions", async () => {
      const mockRunner = createMockRunner(
        '["name=seccomp,profile=builtin","name=rootless","name=cgroupns"]|24.0.7|/home/user/.local/share/docker'
      );

      const inspection = await DockerExecutionProvider.inspectDaemonSecurity("docker", mockRunner);
      expect(inspection.available).toBe(true);
      expect(inspection.isRootlessDaemon).toBe(true);
      expect(inspection.serverVersion).toBe("24.0.7");
      expect(inspection.dockerRootDir).toBe("/home/user/.local/share/docker");
      expect(inspection.securityOptions).toContain("name=rootless");
    });

    it("detects a standard rootful Docker daemon (rootless option absent)", async () => {
      const mockRunner = createMockRunner(
        '["name=seccomp,profile=builtin","name=cgroupns"]|29.8.0|/var/lib/docker'
      );

      const inspection = await DockerExecutionProvider.inspectDaemonSecurity("docker", mockRunner);
      expect(inspection.available).toBe(true);
      expect(inspection.isRootlessDaemon).toBe(false);
      expect(inspection.serverVersion).toBe("29.8.0");
      expect(inspection.dockerRootDir).toBe("/var/lib/docker");
      expect(inspection.securityOptions).not.toContain("name=rootless");
    });

    it("handles daemon unavailability when command fails", async () => {
      const mockRunner = createMockRunner("", 1, "Cannot connect to the Docker daemon at unix:///var/run/docker.sock");

      const inspection = await DockerExecutionProvider.inspectDaemonSecurity("docker", mockRunner);
      expect(inspection.available).toBe(false);
      expect(inspection.isRootlessDaemon).toBe(false);
      expect(inspection.error).toContain("Cannot connect to the Docker daemon");
    });

    it("handles unexpected runner exception safely", async () => {
      const throwingRunner: SubprocessRunner = async () => {
        throw new Error("Docker binary not found: ENOENT");
      };

      const inspection = await DockerExecutionProvider.inspectDaemonSecurity("docker", throwingRunner);
      expect(inspection.available).toBe(false);
      expect(inspection.isRootlessDaemon).toBe(false);
      expect(inspection.error).toContain("ENOENT");
    });

    it("handles non-JSON or comma-separated SecurityOptions gracefully", async () => {
      const mockRunner = createMockRunner("name=rootless,name=seccomp|26.0.0|/var/run/user/1000/docker");

      const inspection = await DockerExecutionProvider.inspectDaemonSecurity("docker", mockRunner);
      expect(inspection.available).toBe(true);
      expect(inspection.isRootlessDaemon).toBe(true);
      expect(inspection.serverVersion).toBe("26.0.0");
    });
  });

  describe("Distinction Between Rootless Daemon and Container Non-Root User", () => {
    it("distinguishes rootful daemon with non-root container (combination 2)", async () => {
      // Daemon runs as root on host, but container runs as UID 1000:1000
      const mockRunner = createMockRunner(
        '["name=seccomp,profile=builtin"]|29.8.0|/var/lib/docker'
      );
      const inspection = await DockerExecutionProvider.inspectDaemonSecurity("docker", mockRunner);

      const provider = new DockerExecutionProvider({ runAsUser: "1000:1000" });

      expect(inspection.isRootlessDaemon).toBe(false); // Daemon is rootful
      expect(provider.config.runAsUser).toBe("1000:1000"); // Container is non-root
    });

    it("rejects root container user even if daemon is rootless (combination 3)", () => {
      // Even if daemon is rootless, container user UID 0 is strictly rejected
      expect(() => {
        new DockerExecutionProvider({ runAsUser: "0:0" });
      }).toThrow(/Root container execution.*strictly forbidden/);
    });
  });

  describe("Enforcement of requireRootlessDaemon Policy", () => {
    const testRequest: ExecutionRequest = {
      runId: "run-rootless-test",
      taskId: "task-rootless",
      operationName: "echo",
      inputPayload: { test: true },
      idempotencyToken: "tok-rootless",
      attemptNumber: 0,
      timeoutMs: 5000,
    };

    it("fails closed with ROOTLESS_VALIDATION_FAILED when daemon is rootful", async () => {
      const mockRootfulRunner: SubprocessRunner = async (_bin, args) => {
        if (args.includes("info")) {
          return {
            exitCode: 0,
            stdout: '["name=seccomp,profile=builtin"]|29.8.0|/var/lib/docker',
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "mock-id", stderr: "" };
      };

      const provider = new DockerExecutionProvider({
        requireRootlessDaemon: true,
        commandRunner: mockRootfulRunner,
      });

      const result = await provider.execute(testRequest);
      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("ROOTLESS_VALIDATION_FAILED");
      expect(result.error?.message).toContain("Rootless Docker daemon is required by policy");
      expect(result.providerMetadata?.rootlessValidation).toBe("REJECTED_ROOTFUL_DAEMON");
    });

    it("fails closed with DOCKER_UNAVAILABLE when daemon cannot be inspected", async () => {
      const mockFailingRunner: SubprocessRunner = async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "Cannot connect to the Docker daemon",
      });

      const provider = new DockerExecutionProvider({
        requireRootlessDaemon: true,
        commandRunner: mockFailingRunner,
      });

      const result = await provider.execute(testRequest);
      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("DOCKER_UNAVAILABLE");
      expect(result.error?.message).toContain("Docker daemon unavailable for rootless validation");
    });

    it("mandates rootless validation for UNTRUSTED_WORKLOAD even if requireRootlessDaemon is false", async () => {
      const mockRootfulRunner: SubprocessRunner = async (_bin, args) => {
        if (args.includes("info")) {
          return {
            exitCode: 0,
            stdout: '["name=seccomp,profile=builtin"]|29.8.0|/var/lib/docker',
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "mock-id", stderr: "" };
      };

      const provider = new DockerExecutionProvider({
        requireRootlessDaemon: false, // Caller attempts to disable
        commandRunner: mockRootfulRunner,
      });

      const untrustedRequest: ExecutionRequest = {
        ...testRequest,
        trustClassification: "UNTRUSTED_WORKLOAD",
      };

      const result = await provider.execute(untrustedRequest);
      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("ROOTLESS_VALIDATION_FAILED");
      expect(result.error?.message).toContain("Rootless Docker daemon is required by policy");
      expect(result.providerMetadata?.rootlessValidation).toBe("REJECTED_ROOTFUL_DAEMON");
    });

    it("mandates rootless validation for ADVERSARIAL_WORKLOAD even if requireRootlessDaemon is false", async () => {
      const mockRootfulRunner: SubprocessRunner = async (_bin, args) => {
        if (args.includes("info")) {
          return {
            exitCode: 0,
            stdout: '["name=seccomp,profile=builtin"]|29.8.0|/var/lib/docker',
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "mock-id", stderr: "" };
      };

      const provider = new DockerExecutionProvider({
        requireRootlessDaemon: false,
        commandRunner: mockRootfulRunner,
      });

      const adversarialRequest: ExecutionRequest = {
        ...testRequest,
        trustClassification: "ADVERSARIAL_WORKLOAD",
      };

      const result = await provider.execute(adversarialRequest);
      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("ROOTLESS_VALIDATION_FAILED");
    });

    it("fails closed with UNKNOWN_TRUST_CLASSIFICATION when workload trust is UNKNOWN", async () => {
      const provider = new DockerExecutionProvider();
      const unknownRequest: ExecutionRequest = {
        ...testRequest,
        trustClassification: "UNKNOWN",
      };

      const result = await provider.execute(unknownRequest);
      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("UNKNOWN_TRUST_CLASSIFICATION");
      expect(result.error?.message).toContain("Workload trust classification is UNKNOWN");
    });
  });
});
