/**
 * Tests for Workload Trust Routing & Sandbox Security Policy (Track E)
 *
 * Verifies that untrusted and adversarial workloads are strictly routed to the Docker sandbox
 * and can never fall back to the host execution provider, and that non-root user enforcement
 * is strictly validated.
 */

import { describe, expect, it } from "vitest";
import { DockerExecutionProvider } from "../../src/adapters/execution/docker-execution-provider.js";
import {
  createSandboxSecurityPolicy,
  evaluateWorkloadExecutionRouting,
} from "../../src/domain/policy.js";

describe("Track E — Workload Trust Routing & Policy Controls", () => {
  describe("evaluateWorkloadExecutionRouting", () => {
    it("permits TRUSTED_INTERNAL workloads to use requested provider when available", () => {
      const decision = evaluateWorkloadExecutionRouting({
        trustClassification: "TRUSTED_INTERNAL",
        requestedProviderName: "in-process",
        isSandboxAvailable: false,
      });

      expect(decision.allowed).toBe(true);
      expect(decision.requiredProvider).toBe("in-process");
    });

    it("routes UNTRUSTED_WORKLOAD to docker provider when Docker is available", () => {
      const decision = evaluateWorkloadExecutionRouting({
        trustClassification: "UNTRUSTED_WORKLOAD",
        requestedProviderName: "docker",
        isSandboxAvailable: true,
      });

      expect(decision.allowed).toBe(true);
      expect(decision.requiredProvider).toBe("docker");
    });

    it("strictly FAILS CLOSED and prohibits host fallback when Docker is unavailable for UNTRUSTED_WORKLOAD", () => {
      const decision = evaluateWorkloadExecutionRouting({
        trustClassification: "UNTRUSTED_WORKLOAD",
        requestedProviderName: "docker",
        isSandboxAvailable: false,
      });

      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe("DOCKER_UNAVAILABLE");
      expect(decision.message).toContain("Host fallback is prohibited");
    });

    it("strictly FAILS CLOSED and prohibits host fallback for ADVERSARIAL_WORKLOAD", () => {
      const decision = evaluateWorkloadExecutionRouting({
        trustClassification: "ADVERSARIAL_WORKLOAD",
        requestedProviderName: "docker",
        isSandboxAvailable: false,
      });

      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe("DOCKER_UNAVAILABLE");
      expect(decision.message).toContain("Host fallback is prohibited");
    });

    it("prohibits host provider for MULTI_TENANT_WORKLOAD even if requested", () => {
      const decision = evaluateWorkloadExecutionRouting({
        trustClassification: "MULTI_TENANT_WORKLOAD",
        requestedProviderName: "in-process",
        isSandboxAvailable: true,
      });

      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe("HOST_FALLBACK_DISALLOWED");
    });

    it("rejects UNKNOWN trust classification unconditionally", () => {
      const decision = evaluateWorkloadExecutionRouting({
        trustClassification: "UNKNOWN",
        requestedProviderName: "docker",
        isSandboxAvailable: true,
      });

      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe("UNKNOWN_TRUST_CLASSIFICATION");
    });
  });

  describe("createSandboxSecurityPolicy", () => {
    it("creates default policy with non-root 1000:1000 and network disabled", () => {
      const policy = createSandboxSecurityPolicy({ trustClassification: "UNTRUSTED_WORKLOAD" });
      expect(policy.runAsUser).toBe("1000:1000");
      expect(policy.networkPolicy).toBe("NONE");
      expect(policy.readOnlyRootfs).toBe(true);
      expect(policy.requireNonRootUser).toBe(true);
    });

    it("permits custom unprivileged UID", () => {
      const policy = createSandboxSecurityPolicy({
        trustClassification: "UNTRUSTED_WORKLOAD",
        runAsUser: "2000:2000",
      });
      expect(policy.runAsUser).toBe("2000:2000");
    });

    it("rejects root user '0'", () => {
      expect(() => {
        createSandboxSecurityPolicy({
          trustClassification: "UNTRUSTED_WORKLOAD",
          runAsUser: "0",
        });
      }).toThrow(/Refusing to create policy with root container user/);
    });

    it("rejects root user '0:0'", () => {
      expect(() => {
        createSandboxSecurityPolicy({
          trustClassification: "UNTRUSTED_WORKLOAD",
          runAsUser: "0:0",
        });
      }).toThrow(/Refusing to create policy with root container user/);
    });

    it("rejects root user 'root'", () => {
      expect(() => {
        createSandboxSecurityPolicy({
          trustClassification: "UNTRUSTED_WORKLOAD",
          runAsUser: "root",
        });
      }).toThrow(/Refusing to create policy with root container user/);
    });
  });

  describe("DockerExecutionProvider.validateRunAsUser", () => {
    it("accepts valid non-root UID:GID", () => {
      expect(() => DockerExecutionProvider.validateRunAsUser("1000:1000")).not.toThrow();
      expect(() => DockerExecutionProvider.validateRunAsUser("1001:1001")).not.toThrow();
    });

    it("strictly rejects UID 0 / root formats", () => {
      expect(() => DockerExecutionProvider.validateRunAsUser("0")).toThrow(/Root container execution.*strictly forbidden/);
      expect(() => DockerExecutionProvider.validateRunAsUser("0:0")).toThrow(/Root container execution.*strictly forbidden/);
      expect(() => DockerExecutionProvider.validateRunAsUser("root")).toThrow(/Root container execution.*strictly forbidden/);
      expect(() => DockerExecutionProvider.validateRunAsUser("0:1000")).toThrow(/Root container execution.*strictly forbidden/);
    });

    it("strictly rejects empty or malformed user strings", () => {
      expect(() => DockerExecutionProvider.validateRunAsUser("")).toThrow(/user string must not be empty/);
      expect(() => DockerExecutionProvider.validateRunAsUser("   ")).toThrow(/user string must not be empty/);
      expect(() => DockerExecutionProvider.validateRunAsUser("non-numeric")).toThrow(/Invalid or root UID/);
    });
  });
});
