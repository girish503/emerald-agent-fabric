import { describe, expect, it } from "vitest";
import {
  createCapability,
  isSameCapability,
  isValidCapabilityName,
  KNOWN_CAPABILITIES,
  operationNameToCapabilityName,
} from "../../src/domain/capability.js";

describe("Capability Domain Model", () => {
  describe("Validation & Creation", () => {
    it("creates a valid immutable capability with default version", () => {
      const cap = createCapability("execution.echo");
      expect(cap.name).toBe("execution.echo");
      expect(cap.version).toBe("1.0");
      expect(Object.isFrozen(cap)).toBe(true);
    });

    it("creates a valid immutable capability with custom version", () => {
      const cap = createCapability("execution.sum", "2.1");
      expect(cap.name).toBe("execution.sum");
      expect(cap.version).toBe("2.1");
      expect(Object.isFrozen(cap)).toBe(true);
    });

    it("enforces immutability: modifications are blocked", () => {
      const cap = createCapability("execution.echo");
      expect(() => {
        // @ts-expect-error - testing runtime immutability
        cap.name = "execution.elevated";
      }).toThrow();
    });

    it("rejects invalid capability names", () => {
      expect(() => createCapability("")).toThrow(/Invalid capability name/);
      expect(() => createCapability("ECHO")).toThrow(/Invalid capability name/);
      expect(() => createCapability("execution/echo")).toThrow(/Invalid capability name/);
      expect(() => createCapability("execution..echo")).toThrow(/Invalid capability name/);
      expect(() => createCapability("echo")).toThrow(/Invalid capability name/); // Must be namespaced
      expect(() => createCapability("execution.echo;rm -rf /")).toThrow(/Invalid capability name/);
    });

    it("validates capability names via predicate helper", () => {
      expect(isValidCapabilityName("execution.echo")).toBe(true);
      expect(isValidCapabilityName("execution.sum")).toBe(true);
      expect(isValidCapabilityName("execution.slow")).toBe(true);
      expect(isValidCapabilityName("execution.fail")).toBe(true);

      expect(isValidCapabilityName("")).toBe(false);
      expect(isValidCapabilityName("unnamespaced")).toBe(false);
      expect(isValidCapabilityName("execution.")).toBe(false);
      expect(isValidCapabilityName(".execution")).toBe(false);
      expect(isValidCapabilityName("execution.invalid-hyphen")).toBe(false);
    });
  });

  describe("Equality & Serialization", () => {
    it("compares capabilities deterministically", () => {
      const cap1 = createCapability("execution.echo", "1.0");
      const cap2 = createCapability("execution.echo", "1.0");
      const cap3 = createCapability("execution.echo", "1.1");
      const cap4 = createCapability("execution.sum", "1.0");

      expect(isSameCapability(cap1, cap2)).toBe(true);
      expect(isSameCapability(cap1, cap3)).toBe(false);
      expect(isSameCapability(cap1, cap4)).toBe(false);
      expect(isSameCapability(cap1, null)).toBe(false);
      expect(isSameCapability(undefined, cap2)).toBe(false);
    });

    it("serializes cleanly to and from JSON", () => {
      const cap = createCapability("execution.echo", "1.0");
      const json = JSON.stringify(cap);
      const parsed = JSON.parse(json);

      expect(parsed).toEqual({ name: "execution.echo", version: "1.0" });
    });
  });

  describe("Operation to Capability Mapping", () => {
    it("maps recognized operation aliases to canonical capability names", () => {
      expect(operationNameToCapabilityName("echo")).toBe("execution.echo");
      expect(operationNameToCapabilityName("sum")).toBe("execution.sum");
      expect(operationNameToCapabilityName("slow")).toBe("execution.slow");
      expect(operationNameToCapabilityName("fail")).toBe("execution.fail");
      expect(operationNameToCapabilityName("execution.echo")).toBe("execution.echo");
    });

    it("returns null for unrecognized or arbitrary operations", () => {
      expect(operationNameToCapabilityName("shell.exec")).toBe(null);
      expect(operationNameToCapabilityName("arbitrary_command")).toBe(null);
      expect(operationNameToCapabilityName("")).toBe(null);
      expect(operationNameToCapabilityName("eval")).toBe(null);
    });

    it("contains only the tiny approved initial vocabulary", () => {
      expect(KNOWN_CAPABILITIES).toEqual([
        "execution.echo",
        "execution.sum",
        "execution.slow",
        "execution.fail",
      ]);
    });
  });
});
