import { describe, expect, it } from "vitest";
import { ScopedContextMemoryService } from "../../src/application/scoped-context-memory.js";
import { SqliteScopedMemoryStore } from "../../src/adapters/persistence/sqlite-scoped-memory-store.js";

describe("Scoped Context and Memory Continuity Engine", () => {
  const memoryService = new ScopedContextMemoryService(new SqliteScopedMemoryStore({ location: ":memory:" }));

  it("records entries across scopes and enforces tenant isolation", () => {
    // Tenant Alpha records verified evidence
    memoryService.recordEntry(
      "tenant-alpha",
      "task-301",
      "VERIFIED_EVIDENCE",
      "DeterministicVerifier",
      "npm test exited with code 0. All 14 tests passed.",
      { isIndependentlyVerified: true }
    );

    // Tenant Alpha records project knowledge
    memoryService.recordEntry(
      "tenant-alpha",
      "task-301",
      "PROJECT_KNOWLEDGE",
      "RepositoryScanner",
      "Project uses TypeScript with ESM modules and Fastify HTTP transport."
    );

    // Tenant Beta records something else
    memoryService.recordEntry(
      "tenant-beta",
      "task-beta-1",
      "VERIFIED_EVIDENCE",
      "DeterministicVerifier",
      "Tenant Beta secret data"
    );

    // Query Tenant Alpha memories
    const alphaMemories = memoryService.queryMemories("tenant-alpha", "task-301");
    expect(alphaMemories.length).toBe(2);
    expect(alphaMemories.every((m) => m.tenantId === "tenant-alpha")).toBe(true);

    // Verify Tenant Beta memories are invisible to Tenant Alpha
    const crossTenantMemories = memoryService.queryMemories("tenant-alpha", "task-beta-1");
    expect(crossTenantMemories.length).toBe(0);
  });

  it("enforces truth firewall: model-generated memories cannot claim independent verification", () => {
    const entry = memoryService.recordEntry(
      "tenant-alpha",
      "task-302",
      "UNTRUSTED_OBSERVATION",
      "OllamaModelProvider",
      "I have completed all tests successfully and the goal is achieved.",
      {
        isModelGenerated: true,
        isIndependentlyVerified: true, // Should be coerced to false by Truth Firewall
      }
    );

    expect(entry.isModelGenerated).toBe(true);
    expect(entry.isIndependentlyVerified).toBe(false); // Truth firewall enforced
  });

  it("compiles prioritized context within token ceilings", () => {
    // Add verified evidence
    memoryService.recordEntry(
      "tenant-alpha",
      "task-303",
      "VERIFIED_EVIDENCE",
      "DeterministicVerifier",
      "AssertionError: Expected 200 received 500 at server.ts:45"
    );

    // Add noisy observations
    for (let i = 0; i < 10; i++) {
      memoryService.recordEntry(
        "tenant-alpha",
        "task-303",
        "UNTRUSTED_OBSERVATION",
        "tool:run_command",
        `Verbose log line ${i} with very long padding text ..................................`
      );
    }

    const compiled = memoryService.compileContextForPrompt("tenant-alpha", "task-303", {
      maxTokens: 150,
      role: "CODER",
    });

    expect(compiled.compiledPrompt).toContain("VERIFIED_EVIDENCE");
    expect(compiled.totalTokens).toBeLessThanOrEqual(150);
    expect(compiled.itemsIncluded).toBeGreaterThan(0);
  });
});
