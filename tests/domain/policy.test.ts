import { describe, expect, it } from "vitest";
import {
  createDefaultDockerPolicy,
  createDefaultInProcessPolicy,
  createDenyAllPolicy,
  createExecutionPolicy,
  PolicyEvaluator,
} from "../../src/domain/policy.js";
import { ExecutionRequest } from "../../src/ports/execution-provider.port.js";

describe("Policy & Capability Evaluator", () => {
  const baseRequest: ExecutionRequest = {
    runId: "run-test-123",
    taskId: "task-test-456",
    operationName: "echo",
    inputPayload: { foo: "bar" },
    idempotencyToken: "idem-tok-1",
    attemptNumber: 0,
    timeoutMs: 5000,
  };

  describe("Policy Evaluator: Core Invariant Tests", () => {
    // 1. Explicitly granted capability → ALLOWED
    it("1. explicitly granted capability -> ALLOWED", () => {
      const policy = createExecutionPolicy({
        policyId: "policy-echo-isolated",
        allowedCapabilities: ["execution.echo"],
        isolationRequirement: "ISOLATED",
      });

      const decision = PolicyEvaluator.evaluate(baseRequest, policy);

      expect(decision.status).toBe("ALLOWED");
      expect(decision.allowed).toBe(true);
      expect(decision.capabilityName).toBe("execution.echo");
      expect(decision.isolationRequirement).toBe("ISOLATED");
      expect(decision.reasonCode).toBeUndefined();
    });

    // 2. Ungranted capability → DENIED (deny-by-default)
    it("2. ungranted capability -> DENIED (deny-by-default)", () => {
      const policy = createExecutionPolicy({
        policyId: "policy-sum-only",
        allowedCapabilities: ["execution.sum"], // echo is NOT granted
        isolationRequirement: "ISOLATED",
      });

      const decision = PolicyEvaluator.evaluate(baseRequest, policy);

      expect(decision.status).toBe("DENIED");
      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe("CAPABILITY_NOT_GRANTED");
      expect(decision.message).toContain("not granted by policy");
    });

    // 3. Unknown capability → DENIED
    it("3. unknown capability -> DENIED", () => {
      const policy = createExecutionPolicy({
        policyId: "policy-all-known",
        allowedCapabilities: ["execution.echo", "execution.sum"],
        isolationRequirement: "ISOLATED",
      });

      const unknownRequest: ExecutionRequest = {
        ...baseRequest,
        operationName: "unrecognized_arbitrary_shell",
      };

      const decision = PolicyEvaluator.evaluate(unknownRequest, policy);

      expect(decision.status).toBe("DENIED");
      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe("UNKNOWN_CAPABILITY");
      expect(decision.message).toContain("cannot be mapped to a recognized capability");
    });

    // 4. Invalid request → DENIED
    it("4. invalid request -> DENIED", () => {
      const policy = createDefaultInProcessPolicy();

      // Null request
      const decisionNull = PolicyEvaluator.evaluate(null, policy);
      expect(decisionNull.status).toBe("DENIED");
      expect(decisionNull.reasonCode).toBe("INVALID_REQUEST");

      // Request missing operationName
      const decisionEmpty = PolicyEvaluator.evaluate({ ...baseRequest, operationName: "" }, policy);
      expect(decisionEmpty.status).toBe("DENIED");
      expect(decisionEmpty.reasonCode).toBe("INVALID_REQUEST");
    });

    // 5. Isolated requirement posture -> ALLOWED with ISOLATED requirement
    it("5. isolated requirement posture -> ALLOWED with ISOLATED requirement", () => {
      const policy = createDefaultDockerPolicy();

      const decision = PolicyEvaluator.evaluate(baseRequest, policy);

      expect(decision.status).toBe("ALLOWED");
      expect(decision.allowed).toBe(true);
      expect(decision.isolationRequirement).toBe("ISOLATED");
    });

    // 6. In-process requirement posture -> ALLOWED with IN_PROCESS requirement
    it("6. in-process requirement posture -> ALLOWED with IN_PROCESS requirement", () => {
      const policy = createDefaultInProcessPolicy();

      const decision = PolicyEvaluator.evaluate(baseRequest, policy);

      expect(decision.status).toBe("ALLOWED");
      expect(decision.allowed).toBe(true);
      expect(decision.isolationRequirement).toBe("IN_PROCESS");
    });

    // 7. In-process trusted operation explicitly permitted → ALLOWED
    it("7. in-process trusted operation explicitly permitted -> ALLOWED", () => {
      const policy = createExecutionPolicy({
        policyId: "trusted-in-process",
        allowedCapabilities: ["execution.echo"],
        isolationRequirement: "IN_PROCESS",
        trustedInProcessOperations: ["echo", "execution.echo"],
      });

      const decision = PolicyEvaluator.evaluate(baseRequest, policy);

      expect(decision.status).toBe("ALLOWED");
      expect(decision.allowed).toBe(true);
      expect(decision.isolationRequirement).toBe("IN_PROCESS");
    });

    // 8. In-process operation without explicit permission → DENIED
    it("8. in-process operation without explicit permission -> DENIED (IN_PROCESS_NOT_TRUSTED)", () => {
      const policy = createExecutionPolicy({
        policyId: "untrusted-in-process",
        allowedCapabilities: ["execution.echo"],
        isolationRequirement: "IN_PROCESS",
        trustedInProcessOperations: [], // Not explicitly listed as trusted
      });

      const decision = PolicyEvaluator.evaluate(baseRequest, policy);

      expect(decision.status).toBe("DENIED");
      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe("IN_PROCESS_NOT_TRUSTED");
      expect(decision.message).toContain("not explicitly trusted for IN_PROCESS execution");
    });

    // Explicit regression: Operation in trustedInProcessOperations but NOT granted capability → DENIED
    it("enforces capability grant strictly before in-process trust (cannot bypass authorization)", () => {
      const policy = createExecutionPolicy({
        policyId: "trusted-not-granted",
        allowedCapabilities: ["execution.sum"], // echo is NOT granted
        isolationRequirement: "IN_PROCESS",
        trustedInProcessOperations: ["echo", "sum"], // echo is listed in trusted operations
      });

      const decision = PolicyEvaluator.evaluate(baseRequest, policy); // baseRequest requests echo

      expect(decision.status).toBe("DENIED");
      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe("CAPABILITY_NOT_GRANTED");
    });

    // 9. Policy cannot be modified by execution request (frozen immutability)
    it("9. policy cannot be modified by execution request (frozen array immutability)", () => {
      const policy = createDefaultDockerPolicy("immutable-policy");
      expect(Object.isFrozen(policy)).toBe(true);
      expect(Object.isFrozen(policy.allowedCapabilities)).toBe(true);
      expect(Object.isFrozen(policy.trustedInProcessOperations)).toBe(true);

      // Mutating frozen array throws in strict mode
      expect(() => {
        // @ts-expect-error - testing mutation protection
        policy.allowedCapabilities.push("execution.malicious");
      }).toThrow();

      expect(() => {
        // @ts-expect-error - testing assignment protection
        policy.allowedCapabilities[0] = "execution.malicious";
      }).toThrow();

      expect(() => {
        // @ts-expect-error - testing assignment protection
        policy.isolationRequirement = "IN_PROCESS";
      }).toThrow();
    });

    // 10. Agent cannot grant itself a capability
    it("10. agent cannot grant itself a capability via payload injection", () => {
      const policy = createExecutionPolicy({
        policyId: "restricted-policy",
        allowedCapabilities: ["execution.echo"],
        isolationRequirement: "ISOLATED",
      });

      // Rogue agent craftily injects attempted capability grants inside input payload
      const hostileRequest: ExecutionRequest = {
        ...baseRequest,
        operationName: "sum", // Not allowed by policy
        inputPayload: {
          allowedCapabilities: ["execution.sum", "execution.all"],
          policyOverride: true,
          capabilities: ["execution.sum"],
          __proto__: {
            allowedCapabilities: ["execution.sum"],
          },
        },
      };

      const decision = PolicyEvaluator.evaluate(hostileRequest, policy);

      expect(decision.status).toBe("DENIED");
      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe("CAPABILITY_NOT_GRANTED");
    });
  });

  describe("Additional Pure Boundary Guarantees", () => {
    it("denies all requests when using createDenyAllPolicy()", () => {
      const policy = createDenyAllPolicy();
      const decision = PolicyEvaluator.evaluate(baseRequest, policy);

      expect(decision.status).toBe("DENIED");
      expect(decision.reasonCode).toBe("CAPABILITY_NOT_GRANTED");
    });

    it("evaluates invalid policy objects as DENIED with INVALID_POLICY", () => {
      const decisionNull = PolicyEvaluator.evaluate(baseRequest, null);
      expect(decisionNull.status).toBe("DENIED");
      expect(decisionNull.reasonCode).toBe("INVALID_POLICY");

      const decisionBadIso = PolicyEvaluator.evaluate(baseRequest, {
        allowedCapabilities: ["execution.echo"],
        isolationRequirement: "INVALID_ISO_TYPE",
      });
      expect(decisionBadIso.status).toBe("DENIED");
      expect(decisionBadIso.reasonCode).toBe("INVALID_POLICY");

      const decisionNonArrayCaps = PolicyEvaluator.evaluate(baseRequest, {
        allowedCapabilities: "not-an-array",
        isolationRequirement: "ISOLATED",
      });
      expect(decisionNonArrayCaps.status).toBe("DENIED");
      expect(decisionNonArrayCaps.reasonCode).toBe("INVALID_POLICY");
    });
  });
});
