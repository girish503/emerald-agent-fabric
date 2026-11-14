/**
 * Pre-Export Telemetry Redaction & Injection Sanitization (Phase 3).
 *
 * Guarantees that secrets, bearer tokens, API keys, PEM private keys, JWTs, URL credentials,
 * control characters, and raw memory/tool payloads are scrubbed BEFORE entering any
 * trace buffer, log buffer, Prometheus label, OTLP batch, or Langfuse ingestion request.
 */

import { isSensitiveKey } from "../../domain/canonical-hash.js";
import type { TelemetryAttributeValue } from "../../ports/observability.port.js";

export const DEFAULT_MAX_TELEMETRY_STRING_CHARS = 512;
export const DEFAULT_MAX_PAYLOAD_DEPTH = 6;

const NON_SENSITIVE_KEY_EXEMPTIONS = new Set([
  "credentialscopes",
  "idempotencytoken",
  "prompttokens",
  "completiontokens",
  "totaltokens",
  "tokencount",
  "inputtokens",
  "outputtokens",
  "tokenusage",
]);

const ADDITIONAL_SENSITIVE_KEY_TERMS = [
  "cookie",
  "setcookie",
  "session",
  "passphrase",
  "password",
  "secret",
  "token",
  "bearer",
  "auth",
  "jwt",
  "credential",
  "privatekey",
  "accesskey",
  "connectionstring",
  "dsn",
  "signingkey",
  "webhookurl",
];

function isSensitiveTelemetryKey(key: string): boolean {
  const normalized = key.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (NON_SENSITIVE_KEY_EXEMPTIONS.has(normalized)) {
    return false;
  }
  if (isSensitiveKey(key)) {
    return true;
  }
  return ADDITIONAL_SENSITIVE_KEY_TERMS.some((term) => normalized.includes(term));
}

const SECRET_STRING_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly replacement: string }> = [
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: "Bearer [REDACTED]" },
  { pattern: /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, replacement: "Basic [REDACTED]" },
  { pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, replacement: "[REDACTED_PRIVATE_KEY]" },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g, replacement: "[REDACTED_JWT]" },
  { pattern: /\b(?:sk|pk)-(?:lf-|proj-|live-|test-)?[A-Za-z0-9_-]{12,}\b/g, replacement: "[REDACTED_API_KEY]" },
  { pattern: /\b(?:github_pat|ghp|gho|ghu|ghs|glpat|xox[a-z])_[A-Za-z0-9_-]{10,}\b/g, replacement: "[REDACTED_TOKEN]" },
  { pattern: /\bxox[a-z]-[A-Za-z0-9-]{10,}\b/g, replacement: "[REDACTED_TOKEN]" },
  { pattern: /\bglpat-[A-Za-z0-9_-]{10,}\b/g, replacement: "[REDACTED_TOKEN]" },
  { pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/g, replacement: "[REDACTED_API_KEY]" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED_ACCESS_KEY]" },
  { pattern: /([a-z][a-z0-9+.-]*:\/\/)([^:@/\s]+):([^@/\s]+)@/gi, replacement: "$1[REDACTED]:[REDACTED]@" },
  { pattern: /(?:[A-Za-z]:\\(?:Users|home|Documents and Settings)\\|\/(?:Users|home|root)\/)[^\s"'`,;)}\]]+/gi, replacement: "[REDACTED_LOCAL_PATH]" },
];

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function mayContainSecretOrPath(value: string): boolean {
  if (value.length < 7) {
    return false;
  }
  if (
    value.includes("://") ||
    value.includes("-----BEGIN") ||
    value.includes("eyJ") ||
    value.includes("sk-") ||
    value.includes("pk-") ||
    value.includes("xox") ||
    value.includes("_") ||
    value.includes("glpat") ||
    value.includes("AIza") ||
    value.includes("AKIA") ||
    value.includes(":\\")
  ) {
    return true;
  }
  if (value.includes("/")) {
    const lower = value.toLowerCase();
    if (lower.includes("/users/") || lower.includes("/home/") || lower.includes("/root/")) {
      return true;
    }
  }
  if (value.includes(" ")) {
    const lower = value.toLowerCase();
    if (lower.includes("bearer ") || lower.includes("basic ")) {
      return true;
    }
  }
  return false;
}

/**
 * Strips control characters (log/header injection defense), scrubs embedded secrets,
 * and truncates strings to a deterministic character bound.
 */
export function sanitizeTelemetryString(
  raw: string,
  maxChars: number = DEFAULT_MAX_TELEMETRY_STRING_CHARS
): string {
  let clean = hasControlChars(raw) ? raw.replace(/[\r\n\u0000-\u001f\u007f]+/g, " ") : raw;
  if (mayContainSecretOrPath(clean)) {
    for (let i = 0; i < SECRET_STRING_PATTERNS.length; i++) {
      const rule = SECRET_STRING_PATTERNS[i]!;
      clean = clean.replace(rule.pattern, rule.replacement);
    }
  }
  if (clean.length > maxChars) {
    return `${clean.slice(0, Math.max(0, maxChars - 12))}[TRUNCATED]`;
  }
  return clean;
}

/**
 * Single-pass recursive telemetry sanitizer:
 * - Circular-reference safe (WeakSet guard)
 * - Throwing-getter / throwing-toString safe
 * - Redacts sensitive keys (while honoring canonical non-secret telemetry fields)
 * - Scrubs embedded secret patterns & OS paths and enforces depth/string ceilings
 */
export function sanitizeTelemetryValue(
  value: unknown,
  options: { readonly maxStringChars?: number; readonly maxDepth?: number } = {},
  depth: number = 0,
  seen: WeakSet<object> = new WeakSet<object>()
): unknown {
  const maxStringChars = options.maxStringChars ?? DEFAULT_MAX_TELEMETRY_STRING_CHARS;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_PAYLOAD_DEPTH;

  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return sanitizeTelemetryString(value, maxStringChars);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[CIRCULAR]";
    }
    if (depth >= maxDepth) {
      return "[MAX_DEPTH_TRUNCATED]";
    }
    seen.add(value);
    try {
      if (value instanceof Date) {
        return Number.isFinite(value.getTime()) ? value.toISOString() : "[INVALID_DATE]";
      }
      if (value instanceof Error) {
        try {
          return {
            name: sanitizeTelemetryString(safeToString(value.name), 64),
            message: sanitizeTelemetryString(safeToString(value.message), maxStringChars),
          };
        } catch {
          return "[UNSERIALIZABLE_ERROR]";
        }
      }
      if (Array.isArray(value)) {
        try {
          const limit = Math.min(value.length, 32);
          const out = new Array<unknown>(limit);
          for (let i = 0; i < limit; i++) {
            try {
              out[i] = sanitizeTelemetryValue(value[i], options, depth + 1, seen);
            } catch {
              out[i] = "[UNSERIALIZABLE_VALUE]";
            }
          }
          return out;
        } catch {
          return "[UNSERIALIZABLE_ARRAY]";
        }
      }
      const out: Record<string, unknown> = {};
      let keys: string[];
      try {
        keys = Object.keys(value as Record<string, unknown>);
      } catch {
        return "[UNSERIALIZABLE_OBJECT]";
      }
      const limit = Math.min(keys.length, 64);
      for (let i = 0; i < limit; i++) {
        const k = keys[i]!;
        const safeKey = sanitizeTelemetryString(k, 128);
        if (isSensitiveTelemetryKey(safeKey)) {
          out[safeKey] = "[REDACTED]";
        } else {
          try {
            const v = (value as Record<string, unknown>)[k];
            out[safeKey] = sanitizeTelemetryValue(v, options, depth + 1, seen);
          } catch {
            out[safeKey] = "[UNSERIALIZABLE_VALUE]";
          }
        }
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }
  return sanitizeTelemetryString(safeToString(value), maxStringChars);
}

function safeToString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[UNSTRINGIFIABLE]";
  }
}

/**
 * Converts arbitrary attribute bags into safe, bounded primitive telemetry attributes.
 */
export function sanitizeTelemetryAttributes(
  raw: Record<string, unknown> = {},
  maxStringChars: number = DEFAULT_MAX_TELEMETRY_STRING_CHARS
): Record<string, TelemetryAttributeValue> {
  const sanitized = sanitizeTelemetryValue(raw, { maxStringChars, maxDepth: 2 });
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    return {};
  }
  const out: Record<string, TelemetryAttributeValue> = {};
  for (const [k, v] of Object.entries(sanitized as Record<string, unknown>)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else if (v !== null && v !== undefined) {
      try {
        out[k] = sanitizeTelemetryString(JSON.stringify(v) ?? "[UNSERIALIZABLE]", maxStringChars);
      } catch {
        out[k] = "[UNSERIALIZABLE]";
      }
    }
  }
  return out;
}
