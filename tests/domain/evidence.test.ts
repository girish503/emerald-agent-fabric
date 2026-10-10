import { describe, expect, it } from "vitest";
import {
  createEvidence,
  createOutputPayloadEvidence,
  createProcessExitEvidence,
} from "../../src/domain/evidence.js";

describe("Evidence Domain Model", () => {
  it("creates valid immutable evidence with PROVIDER_REPORTED provenance", () => {
    const evidence = createOutputPayloadEvidence("run-123", { sum: 42 });

    expect(evidence.runId).toBe("run-123");
    expect(evidence.source).toBe("PROVIDER_REPORTED");
    expect(evidence.kind).toBe("OUTPUT_PAYLOAD");
    expect(evidence.schemaVersion).toBe(1);
    expect(evidence.contentHash).toHaveLength(64);
    expect(evidence.summary).toEqual({ sum: 42 });
    expect(evidence.observedAt).toBeDefined();

    // Verify genuine immutability
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.summary)).toBe(true);

    expect(() => {
      // @ts-expect-error - testing mutation protection
      evidence.contentHash = "tampered";
    }).toThrow();

    expect(() => {
      // @ts-expect-error - testing mutation protection
      evidence.summary.sum = 999;
    }).toThrow();
  });

  it("wraps non-object raw content into output summary object", () => {
    const evidence = createOutputPayloadEvidence("run-scalar", 42);
    expect(evidence.summary).toEqual({ output: 42 });

    const evidenceArray = createOutputPayloadEvidence("run-array", [1, 2, 3]);
    expect(evidenceArray.summary).toEqual({ output: [1, 2, 3] });
  });

  it("creates process exit evidence", () => {
    const evidence = createProcessExitEvidence("run-proc", { exitCode: 0, signal: null });

    expect(evidence.kind).toBe("PROCESS_EXIT");
    expect(evidence.source).toBe("PROVIDER_REPORTED");
    expect(evidence.summary).toEqual({ exitCode: 0, signal: null });
  });

  it("enforces bounded summary size limit (truncates summary and switches kind to CONTENT_HASH)", () => {
    // Generate large payload (> 1000 bytes)
    const largePayload = {
      data: "x".repeat(2000),
    };

    // Use small maxSummaryBytes limit of 500 bytes
    const evidence = createEvidence({
      runId: "run-large",
      kind: "OUTPUT_PAYLOAD",
      rawContent: largePayload,
      maxSummaryBytes: 500,
    });

    expect(evidence.kind).toBe("CONTENT_HASH");
    expect(evidence.contentHash).toHaveLength(64);
    expect(evidence.summary).toBeDefined();
    expect(evidence.summary!._truncated).toBe(true);
    expect(evidence.summary!._maxBytes).toBe(500);
    expect(evidence.summary!._byteLength).toBeGreaterThan(500);
  });

  it("redacts sensitive keys inside evidence summary", () => {
    const evidence = createOutputPayloadEvidence("run-secret", {
      result: 100,
      api_token: "super-secret-12345",
      nested: {
        password: "plain-password",
      },
    });

    expect(evidence.summary).toEqual({
      result: 100,
      api_token: "[REDACTED]",
      nested: {
        password: "[REDACTED]",
      },
    });
  });
});
