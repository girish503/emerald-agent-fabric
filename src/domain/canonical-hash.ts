import { createHash } from "node:crypto";

/**
 * Sensitive field name patterns for deterministic key-based redaction.
 * Targets fields whose names clearly indicate secrets, tokens, credentials, or passwords.
 * Avoids matching benign generic keys like 'key' or 'keyboard'.
 */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /token/i,
  /secret/i,
  /password/i,
  /credential/i,
  /authorization/i,
  /api[_-]?key/i,
  /access[_-]?key/i,
  /private[_-]?key/i,
];

/**
 * Checks whether an object property key indicates sensitive data.
 */
export function isSensitiveKey(key: string): boolean {
  if (typeof key !== "string") {
    return false;
  }
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Deterministically redacts sensitive keys from an arbitrary object/array structure.
 * Returns a new object without mutating input.
 *
 * Rule:
 * If an object property key matches sensitive patterns, its value is replaced with "[REDACTED]".
 */
export function redactSensitiveData(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item));
  }

  const result: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);

  for (const [key, val] of entries) {
    if (isSensitiveKey(key)) {
      if (val !== null && typeof val === "object") {
        if (Array.isArray(val)) {
          // If the array contains objects, recurse; if primitives, redact all elements
          result[key] = val.map((item) =>
            typeof item === "object" && item !== null
              ? redactSensitiveData(item)
              : "[REDACTED]"
          );
        } else {
          // Nested object container (e.g. credentials: { ... }): recurse inside
          result[key] = redactSensitiveData(val);
        }
      } else {
        result[key] = "[REDACTED]";
      }
    } else {
      result[key] = redactSensitiveData(val);
    }
  }

  return result;
}

/**
 * Canonical JSON serialization:
 * - Deterministic lexicographical sorting of object keys at all nesting levels.
 * - Array element ordering preserved.
 * - Consistent primitive serialization.
 * - Omits undefined, functions, and symbols.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    const serializedItems = value.map((item) => canonicalJsonStringify(item));
    return `[${serializedItems.join(",")}]`;
  }

  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const serializedEntries: string[] = [];

  for (const key of sortedKeys) {
    const val = obj[key];
    if (val !== undefined && typeof val !== "function" && typeof val !== "symbol") {
      serializedEntries.push(`${JSON.stringify(key)}:${canonicalJsonStringify(val)}`);
    }
  }

  return `{${serializedEntries.join(",")}}`;
}

/**
 * Computes a SHA-256 lowercase hexadecimal digest of a UTF-8 string.
 */
export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Content hashing pipeline:
 * 1. Raw observation -> Redaction
 * 2. Redacted data -> Canonical JSON serialization
 * 3. Canonical JSON -> SHA-256 digest
 *
 * CRITICAL INVARIANT:
 * The persisted contentHash corresponds exactly to the persisted redacted representation.
 */
export function computeCanonicalHash(raw: unknown): {
  readonly redacted: unknown;
  readonly canonicalJson: string;
  readonly contentHash: string;
} {
  const redacted = redactSensitiveData(raw);
  const canonicalJson = canonicalJsonStringify(redacted);
  const contentHash = sha256Hex(canonicalJson);

  return {
    redacted,
    canonicalJson,
    contentHash,
  };
}
