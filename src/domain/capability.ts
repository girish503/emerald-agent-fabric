/**
 * Capability Domain Model for Emerald Agent Fabric.
 *
 * A Capability represents a specific, explicitly named, immutable class of action
 * that an execution may request.
 *
 * Architectural Contracts:
 * - Explicitly named: No wildcard permissions or dynamic privilege escalation.
 * - Immutable: Frozen representation with no mutable state.
 * - Comparable: Deterministic equality based on name and version.
 * - Serializable: Clean JSON object structure.
 * - Tiny initial vocabulary: Confined strictly to deterministic execution primitives
 *   (execution.echo, execution.sum, execution.slow, execution.fail).
 */

export const KNOWN_CAPABILITIES = [
  "execution.echo",
  "execution.sum",
  "execution.slow",
  "execution.fail",
] as const;

export type KnownCapabilityName = (typeof KNOWN_CAPABILITIES)[number];

const CAPABILITY_NAME_REGEX = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

export interface Capability {
  readonly name: string;
  readonly version: string;
}

/**
 * Validates whether a capability name conforms to strict lowercase namespaced format.
 */
export function isValidCapabilityName(name: string): boolean {
  if (typeof name !== "string" || name.length === 0 || name.length > 128) {
    return false;
  }
  return CAPABILITY_NAME_REGEX.test(name);
}

/**
 * Creates an immutable, validated Capability object.
 * Defaults version to "1.0" if omitted.
 */
export function createCapability(name: string, version: string = "1.0"): Capability {
  if (!isValidCapabilityName(name)) {
    throw new Error(
      `Invalid capability name: '${name}'. Must be lowercase namespaced format (e.g. 'execution.echo').`
    );
  }
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error("Capability version must be a non-empty string.");
  }

  return Object.freeze({
    name,
    version: version.trim(),
  });
}

/**
 * Compares two capabilities for deterministic equality.
 */
export function isSameCapability(a: Capability | null | undefined, b: Capability | null | undefined): boolean {
  if (!a || !b) return false;
  return a.name === b.name && a.version === b.version;
}

/**
 * Maps an operational name (or short action name) to a normalized Capability name.
 * Returns null if the operation cannot be mapped to a known capability.
 */
export function operationNameToCapabilityName(operationName: string): string | null {
  if (typeof operationName !== "string" || operationName.trim().length === 0) {
    return null;
  }

  const normalized = operationName.trim();

  // If already namespaced as a known capability
  if ((KNOWN_CAPABILITIES as readonly string[]).includes(normalized)) {
    return normalized;
  }

  // Handle standard test/short operation aliases
  switch (normalized) {
    case "echo":
      return "execution.echo";
    case "sum":
      return "execution.sum";
    case "slow":
      return "execution.slow";
    case "fail":
    case "failing":
    case "exploding":
      return "execution.fail";
    case "output-flood":
      return "execution.echo"; // Evaluated under deterministic execution primitive
    default:
      return null;
  }
}
