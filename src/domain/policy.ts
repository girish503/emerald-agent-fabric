/**
 * Policy & Authorization Boundary for Emerald Agent Fabric.
 *
 * Establishes the boundary answering "Is this execution allowed?"
 * before any execution reaches an ExecutionProvider.
 *
 * Core Architectural Guarantees:
 * 1. Deny-by-default: Any capability not explicitly granted is denied.
 * 2. Immutable: Policies are frozen with ReadonlyArray and cannot be mutated at runtime.
 * 3. Pure Authorization: PolicyEvaluator determines capability permission and required isolation posture.
 *    It has ZERO knowledge of provider implementations, Docker daemons, or execution environments.
 * 4. Orthogonal Isolation: Capability authorization and isolation requirements are separate dimensions.
 * 5. Input Untrusted: Execution requests, operation names, and payloads are treated as untrusted.
 * 6. Auditable: Produces structured decision audit payloads without logging secrets or credentials.
 */

import { ExecutionRequest } from "../ports/execution-provider.port.js";
import { isValidCapabilityName, operationNameToCapabilityName } from "./capability.js";

export type IsolationRequirement = "IN_PROCESS" | "ISOLATED";

export interface ExecutionPolicy {
  readonly policyId: string;
  readonly allowedCapabilities: readonly string[];
  readonly isolationRequirement: IsolationRequirement;
  /**
   * For IN_PROCESS isolation, operations must be explicitly classified as trusted.
   * Untrusted operations are never permitted in-process.
   */
  readonly trustedInProcessOperations?: readonly string[];
}

export interface CreateExecutionPolicyOptions {
  readonly policyId?: string;
  readonly allowedCapabilities: Iterable<string>;
  readonly isolationRequirement: IsolationRequirement;
  readonly trustedInProcessOperations?: Iterable<string>;
}

/**
 * Creates an immutable, validated ExecutionPolicy object.
 */
export function createExecutionPolicy(options: CreateExecutionPolicyOptions): ExecutionPolicy {
  if (!options || typeof options !== "object") {
    throw new Error("Policy options must be a valid object.");
  }

  if (options.isolationRequirement !== "IN_PROCESS" && options.isolationRequirement !== "ISOLATED") {
    throw new Error(
      `Invalid isolation requirement: '${options.isolationRequirement}'. Must be 'IN_PROCESS' or 'ISOLATED'.`
    );
  }

  const allowedSet = new Set<string>();
  if (options.allowedCapabilities) {
    for (const cap of options.allowedCapabilities) {
      if (typeof cap === "string" && cap.trim().length > 0) {
        allowedSet.add(cap.trim());
      }
    }
  }

  const trustedInProcessSet = new Set<string>();
  if (options.trustedInProcessOperations) {
    for (const op of options.trustedInProcessOperations) {
      if (typeof op === "string" && op.trim().length > 0) {
        trustedInProcessSet.add(op.trim());
      }
    }
  }

  return Object.freeze({
    policyId: options.policyId ?? "policy-" + crypto.randomUUID().slice(0, 8),
    allowedCapabilities: Object.freeze(Array.from(allowedSet)),
    isolationRequirement: options.isolationRequirement,
    trustedInProcessOperations: Object.freeze(Array.from(trustedInProcessSet)),
  });
}

/**
 * Creates a Deny-All policy that rejects every capability.
 */
export function createDenyAllPolicy(policyId: string = "deny-all"): ExecutionPolicy {
  return createExecutionPolicy({
    policyId,
    allowedCapabilities: [],
    isolationRequirement: "ISOLATED",
  });
}

/**
 * Creates a default trusted policy for in-process execution of core deterministic operations.
 */
export function createDefaultInProcessPolicy(policyId: string = "default-in-process"): ExecutionPolicy {
  return createExecutionPolicy({
    policyId,
    allowedCapabilities: [
      "execution.echo",
      "execution.sum",
      "execution.slow",
      "execution.fail",
    ],
    isolationRequirement: "IN_PROCESS",
    trustedInProcessOperations: [
      "echo",
      "sum",
      "slow",
      "fail",
      "failing",
      "exploding",
      "output-flood",
      "execution.echo",
      "execution.sum",
      "execution.slow",
      "execution.fail",
    ],
  });
}

/**
 * Creates a default isolated policy for Docker execution of core deterministic operations.
 */
export function createDefaultDockerPolicy(policyId: string = "default-docker-isolated"): ExecutionPolicy {
  return createExecutionPolicy({
    policyId,
    allowedCapabilities: [
      "execution.echo",
      "execution.sum",
      "execution.slow",
      "execution.fail",
    ],
    isolationRequirement: "ISOLATED",
  });
}

export type PolicyDecisionStatus = "ALLOWED" | "DENIED";

export type PolicyDenialReasonCode =
  | "CAPABILITY_NOT_GRANTED"
  | "UNKNOWN_CAPABILITY"
  | "INVALID_REQUEST"
  | "IN_PROCESS_NOT_TRUSTED"
  | "INVALID_POLICY";

export interface PolicyDecision {
  readonly status: PolicyDecisionStatus;
  readonly allowed: boolean;
  readonly capabilityName: string;
  readonly isolationRequirement: IsolationRequirement;
  readonly reasonCode?: PolicyDenialReasonCode;
  readonly message: string;
  readonly evaluatedAt: string;
  readonly policyId: string;
}

/**
 * PolicyEvaluator evaluates ExecutionRequests against an immutable ExecutionPolicy.
 * Completely deterministic, pure, and free of side effects.
 *
 * Answers strictly: "Is this execution allowed, and what isolation is required?"
 * It has ZERO dependency on execution providers, containers, or platform daemons.
 */
export class PolicyEvaluator {
  /**
   * Evaluates an execution request against an execution policy.
   */
  static evaluate(
    request: ExecutionRequest | unknown,
    policy: ExecutionPolicy | unknown
  ): PolicyDecision {
    const evaluatedAt = new Date().toISOString();

    // 1. Validate request structure
    if (!request || typeof request !== "object") {
      return {
        status: "DENIED",
        allowed: false,
        capabilityName: "unknown",
        isolationRequirement: "ISOLATED",
        reasonCode: "INVALID_REQUEST",
        message: "Execution request must be a valid non-null object.",
        evaluatedAt,
        policyId: "unknown",
      };
    }

    const execReq = request as Partial<ExecutionRequest>;

    if (
      typeof execReq.operationName !== "string" ||
      execReq.operationName.trim().length === 0
    ) {
      return {
        status: "DENIED",
        allowed: false,
        capabilityName: "unknown",
        isolationRequirement: "ISOLATED",
        reasonCode: "INVALID_REQUEST",
        message: "Execution request missing or invalid 'operationName'.",
        evaluatedAt,
        policyId: "unknown",
      };
    }

    const operationName = execReq.operationName.trim();

    // 2. Validate policy structure
    if (!policy || typeof policy !== "object") {
      return {
        status: "DENIED",
        allowed: false,
        capabilityName: "unknown",
        isolationRequirement: "ISOLATED",
        reasonCode: "INVALID_POLICY",
        message: "Execution policy is undefined or invalid.",
        evaluatedAt,
        policyId: "unknown",
      };
    }

    const execPolicy = policy as Partial<ExecutionPolicy>;

    if (
      execPolicy.isolationRequirement !== "IN_PROCESS" &&
      execPolicy.isolationRequirement !== "ISOLATED"
    ) {
      return {
        status: "DENIED",
        allowed: false,
        capabilityName: "unknown",
        isolationRequirement: "ISOLATED",
        reasonCode: "INVALID_POLICY",
        message: `Execution policy has invalid isolation requirement: '${String(execPolicy.isolationRequirement)}'.`,
        evaluatedAt,
        policyId: execPolicy.policyId ?? "unknown",
      };
    }

    const isolationRequirement = execPolicy.isolationRequirement;
    const policyId = execPolicy.policyId ?? "unknown";

    if (!Array.isArray(execPolicy.allowedCapabilities)) {
      return {
        status: "DENIED",
        allowed: false,
        capabilityName: "unknown",
        isolationRequirement,
        reasonCode: "INVALID_POLICY",
        message: "Execution policy missing valid 'allowedCapabilities' array.",
        evaluatedAt,
        policyId,
      };
    }

    // 3. Resolve capability from requested operationName
    const capabilityName = operationNameToCapabilityName(operationName);

    if (!capabilityName || !isValidCapabilityName(capabilityName)) {
      return {
        status: "DENIED",
        allowed: false,
        capabilityName: capabilityName ?? "unknown",
        isolationRequirement,
        reasonCode: "UNKNOWN_CAPABILITY",
        message: `Operation '${operationName}' cannot be mapped to a recognized capability.`,
        evaluatedAt,
        policyId,
      };
    }

    // 4. Deny-by-default capability grant check
    if (!execPolicy.allowedCapabilities.includes(capabilityName)) {
      return {
        status: "DENIED",
        allowed: false,
        capabilityName,
        isolationRequirement,
        reasonCode: "CAPABILITY_NOT_GRANTED",
        message: `Capability '${capabilityName}' is not granted by policy '${policyId}'.`,
        evaluatedAt,
        policyId,
      };
    }

    // 5. In-process isolation constraint check:
    // When isolationRequirement is IN_PROCESS, operation must be explicitly classified as trusted
    if (isolationRequirement === "IN_PROCESS") {
      const trustedOps = execPolicy.trustedInProcessOperations;
      const isTrusted =
        Array.isArray(trustedOps) &&
        (trustedOps.includes(operationName) || trustedOps.includes(capabilityName));

      if (!isTrusted) {
        return {
          status: "DENIED",
          allowed: false,
          capabilityName,
          isolationRequirement,
          reasonCode: "IN_PROCESS_NOT_TRUSTED",
          message: `Operation '${operationName}' is not explicitly trusted for IN_PROCESS execution under policy '${policyId}'.`,
          evaluatedAt,
          policyId,
        };
      }
    }

    // 6. Explicitly ALLOWED with required isolation posture
    return {
      status: "ALLOWED",
      allowed: true,
      capabilityName,
      isolationRequirement,
      message: `Capability '${capabilityName}' authorized for execution under policy '${policyId}'.`,
      evaluatedAt,
      policyId,
    };
  }

  /**
   * Pure evaluator for a capability string against an ExecutionPolicy.
   * Answers strictly: Is this capability granted under this policy?
   */
  static evaluateCapability(
    capabilityName: string,
    policy: ExecutionPolicy | unknown
  ): PolicyDecision {
    const evaluatedAt = new Date().toISOString();

    if (
      typeof capabilityName !== "string" ||
      capabilityName.trim().length === 0 ||
      !isValidCapabilityName(capabilityName.trim())
    ) {
      return {
        status: "DENIED",
        allowed: false,
        capabilityName: capabilityName ?? "unknown",
        isolationRequirement: "ISOLATED",
        reasonCode: "UNKNOWN_CAPABILITY",
        message: `Capability '${capabilityName}' is invalid or unparseable.`,
        evaluatedAt,
        policyId: "unknown",
      };
    }

    const normalizedCapability = capabilityName.trim();

    if (!policy || typeof policy !== "object") {
      return {
        status: "DENIED",
        allowed: false,
        capabilityName: normalizedCapability,
        isolationRequirement: "ISOLATED",
        reasonCode: "INVALID_POLICY",
        message: "Execution policy is undefined or invalid.",
        evaluatedAt,
        policyId: "unknown",
      };
    }

    const execPolicy = policy as Partial<ExecutionPolicy>;
    const isolationRequirement = execPolicy.isolationRequirement ?? "ISOLATED";
    const policyId = execPolicy.policyId ?? "unknown";

    if (!Array.isArray(execPolicy.allowedCapabilities)) {
      return {
        status: "DENIED",
        allowed: false,
        capabilityName: normalizedCapability,
        isolationRequirement,
        reasonCode: "INVALID_POLICY",
        message: "Execution policy missing valid 'allowedCapabilities' array.",
        evaluatedAt,
        policyId,
      };
    }

    if (!execPolicy.allowedCapabilities.includes(normalizedCapability)) {
      return {
        status: "DENIED",
        allowed: false,
        capabilityName: normalizedCapability,
        isolationRequirement,
        reasonCode: "CAPABILITY_NOT_GRANTED",
        message: `Capability '${normalizedCapability}' is not granted by policy '${policyId}'.`,
        evaluatedAt,
        policyId,
      };
    }

    return {
      status: "ALLOWED",
      allowed: true,
      capabilityName: normalizedCapability,
      isolationRequirement,
      message: `Capability '${normalizedCapability}' authorized for execution under policy '${policyId}'.`,
      evaluatedAt,
      policyId,
    };
  }

  /**
   * Instance evaluate wrapper delegating to static evaluator.
   */
  evaluate(
    request: ExecutionRequest | unknown,
    policy: ExecutionPolicy | unknown
  ): PolicyDecision {
    return PolicyEvaluator.evaluate(request, policy);
  }

  /**
   * Instance evaluateCapability wrapper delegating to static evaluator.
   */
  evaluateCapability(
    capabilityName: string,
    policy: ExecutionPolicy | unknown
  ): PolicyDecision {
    return PolicyEvaluator.evaluateCapability(capabilityName, policy);
  }
}
