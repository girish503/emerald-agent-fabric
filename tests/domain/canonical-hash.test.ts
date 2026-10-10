import { describe, expect, it } from "vitest";
import {
  canonicalJsonStringify,
  computeCanonicalHash,
  isSensitiveKey,
  redactSensitiveData,
  sha256Hex,
} from "../../src/domain/canonical-hash.js";

describe("Canonical Hashing & Deterministic Redaction", () => {
  describe("isSensitiveKey", () => {
    it("identifies sensitive keys case-insensitively", () => {
      expect(isSensitiveKey("api_token")).toBe(true);
      expect(isSensitiveKey("clientSecret")).toBe(true);
      expect(isSensitiveKey("PASSWORD")).toBe(true);
      expect(isSensitiveKey("user_credential")).toBe(true);
      expect(isSensitiveKey("Authorization")).toBe(true);
      expect(isSensitiveKey("apiKey")).toBe(true);
      expect(isSensitiveKey("access_key")).toBe(true);
      expect(isSensitiveKey("private-key")).toBe(true);
    });

    it("does not match benign generic keys", () => {
      expect(isSensitiveKey("key")).toBe(false);
      expect(isSensitiveKey("keyboard")).toBe(false);
      expect(isSensitiveKey("monkey")).toBe(false);
      expect(isSensitiveKey("idempotencyKey")).toBe(false);
      expect(isSensitiveKey("status")).toBe(false);
      expect(isSensitiveKey("output")).toBe(false);
      expect(isSensitiveKey("credentialScopes")).toBe(false);
      expect(isSensitiveKey("credential_scopes")).toBe(false);
    });
  });

  describe("redactSensitiveData", () => {
    it("redacts sensitive keys at top level and inside nested objects/arrays", () => {
      const raw = {
        userId: "u-123",
        authToken: "super-secret-token",
        credentials: {
          password: "my-password",
          role: "admin",
        },
        items: [
          { name: "item1", secretKey: "abc" },
          { name: "item2", validKey: true },
        ],
      };

      const redacted = redactSensitiveData(raw) as Record<string, unknown>;

      expect(redacted.userId).toBe("u-123");
      expect(redacted.authToken).toBe("[REDACTED]");
      expect((redacted.credentials as Record<string, unknown>).password).toBe("[REDACTED]");
      expect((redacted.credentials as Record<string, unknown>).role).toBe("admin");
      expect(((redacted.items as unknown[])[0] as Record<string, unknown>).secretKey).toBe("[REDACTED]");
      expect(((redacted.items as unknown[])[1] as Record<string, unknown>).validKey).toBe(true);
    });

    it("does not mutate original object", () => {
      const original = { token: "secret-value" };
      const redacted = redactSensitiveData(original) as Record<string, unknown>;
      expect(original.token).toBe("secret-value");
      expect(redacted.token).toBe("[REDACTED]");
    });
  });

  describe("canonicalJsonStringify", () => {
    it("recursively sorts object keys lexicographically", () => {
      const obj1 = { z: 1, a: 2, m: { y: 10, b: 20 } };
      const obj2 = { a: 2, m: { b: 20, y: 10 }, z: 1 };

      const canon1 = canonicalJsonStringify(obj1);
      const canon2 = canonicalJsonStringify(obj2);

      expect(canon1).toBe('{"a":2,"m":{"b":20,"y":10},"z":1}');
      expect(canon1).toBe(canon2);
    });

    it("preserves array ordering", () => {
      const arr = [3, 1, 2];
      expect(canonicalJsonStringify(arr)).toBe("[3,1,2]");
    });

    it("handles primitives correctly", () => {
      expect(canonicalJsonStringify("hello")).toBe('"hello"');
      expect(canonicalJsonStringify(123)).toBe("123");
      expect(canonicalJsonStringify(true)).toBe("true");
      expect(canonicalJsonStringify(null)).toBe("null");
    });
  });

  describe("computeCanonicalHash", () => {
    it("produces identical SHA-256 hash across repeated executions", () => {
      const payload = { result: 42, count: 5 };
      const hash1 = computeCanonicalHash(payload);
      const hash2 = computeCanonicalHash(payload);

      expect(hash1.contentHash).toBe(hash2.contentHash);
      expect(hash1.canonicalJson).toBe('{"count":5,"result":42}');
      expect(hash1.contentHash).toHaveLength(64); // SHA-256 hex length
    });

    it("produces identical hash regardless of key order", () => {
      const p1 = { a: 1, b: 2 };
      const p2 = { b: 2, a: 1 };

      const h1 = computeCanonicalHash(p1);
      const h2 = computeCanonicalHash(p2);

      expect(h1.contentHash).toBe(h2.contentHash);
    });

    it("produces different hash when content changes", () => {
      const h1 = computeCanonicalHash({ val: 1 });
      const h2 = computeCanonicalHash({ val: 2 });

      expect(h1.contentHash).not.toBe(h2.contentHash);
    });

    it("persists hash of REDACTED representation", () => {
      const raw = { password: "original-secret-123", other: "ok" };
      const { redacted, canonicalJson, contentHash } = computeCanonicalHash(raw);

      // Verify canonicalJson contains redacted value, not original
      expect(canonicalJson).toContain('"[REDACTED]"');
      expect(canonicalJson).not.toContain("original-secret-123");

      // Verify contentHash matches hash of canonicalJson
      expect(contentHash).toBe(sha256Hex(canonicalJson));
      expect((redacted as Record<string, unknown>).password).toBe("[REDACTED]");
    });
  });
});
