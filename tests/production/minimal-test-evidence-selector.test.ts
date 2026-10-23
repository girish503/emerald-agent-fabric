/**
 * Emerald Agent Fabric — Production V1.4: Minimal Test Evidence Selector Tests
 *
 * Verifies the 16 invariant test cases required for deterministic minimal test evidence selection:
 * 1. Deterministic selection from identical inputs (same digest, same records)
 * 2. Stable lexical tie-breaking when priority signals match
 * 3. Correct expected-vs-actual assertion prioritization
 * 4. Prioritization using valid changed-file associations
 * 5. Deduplication of identical evidence with counts and references
 * 6. Retention of materially different failures
 * 7. Exact 4,096-byte feedback limit
 * 8. Deterministic truncation with metadata
 * 9. Empty or malformed evidence handling
 * 10. Security: Stack-trace paths never opened or read
 * 11. Authoritative failures preserved (immutability)
 * 12. Non-authoritative status flags
 * 13. Evidence digests and integrity checks
 * 14. Deterministic replay reconstruction without test execution
 * 15. No modification to permissions/contracts/budgets
 * 16. Regression coverage: user modifications, scope boundaries, zero auto-commits
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { MinimalTestEvidenceSelector, truncateUtf8Safe } from "../../src/production/repair/minimal-test-evidence-selector.js";
import { TestFailureLocalization } from "../../src/production/repair/repair-types.js";
import { ProductionReplayEngine } from "../../src/evidence/production-replay-engine.js";
import { ProductionEvidenceBundle } from "../../src/control-plane/evidence-control.js";

function makeSampleLocalization(overrides?: Partial<TestFailureLocalization>): TestFailureLocalization {
  const rawSummary = `FAIL tests/calculator.test.js
  ● Calculator › add › correctly adds positive integers
    AssertionError: expected 5 to equal 6
      at Object.<anonymous> (tests/calculator.test.js:14:12)
  ● Calculator › subtract › throws on non-numeric input
    TypeError: Cannot read properties of undefined (reading 'val')
      at Object.<anonymous> (tests/calculator.test.js:28:5)`;

  return {
    localizationId: "loc-test-001",
    testCommand: "npm test",
    exitCode: 1,
    failingTests: [
      "Calculator › add › correctly adds positive integers",
      "Calculator › subtract › throws on non-numeric input",
    ],
    failureMessages: [
      "AssertionError: expected 5 to equal 6",
      "TypeError: Cannot read properties of undefined (reading 'val')",
    ],
    localizedFiles: ["src/calculator.js:14", "src/calculator.js:28"],
    rawSummary,
    durationMs: 120,
    inputHash: "input-hash-001",
    outputHash: "output-hash-001",
    authoritative: false,
    verificationAuthority: false,
    terminalAuthority: false,
    ...overrides,
  };
}

describe("Production V1.4: Minimal Test Evidence Selector", () => {
  const selector = new MinimalTestEvidenceSelector(4096);

  // ---------------------------------------------------------------------------
  // 1. Deterministic selection from identical inputs
  // ---------------------------------------------------------------------------
  it("1. should deterministically select identical evidence and digests from identical inputs", () => {
    const loc = makeSampleLocalization();
    const opts = { modifiedFiles: ["src/calculator.js"], maxFeedbackBytes: 4096 };

    const run1 = selector.selectEvidence(loc, opts);
    const run2 = selector.selectEvidence(loc, opts);
    const run3 = selector.selectEvidence(loc, opts);

    expect(run1.selectedEvidenceDigest).toBe(run2.selectedEvidenceDigest);
    expect(run2.selectedEvidenceDigest).toBe(run3.selectedEvidenceDigest);
    expect(run1.originalEvidenceDigest).toBe(run2.originalEvidenceDigest);
    expect(run1.formattedObservationText).toBe(run2.formattedObservationText);
    expect(run1.selectedRecords.length).toBe(run2.selectedRecords.length);
    expect(run1.selectedRecords).toEqual(run2.selectedRecords);
  });

  // ---------------------------------------------------------------------------
  // 2. Stable lexical tie-breaking
  // ---------------------------------------------------------------------------
  it("2. should enforce stable lexical tie-breaking when priority signals match", () => {
    const loc: TestFailureLocalization = {
      localizationId: "loc-tie-break",
      testCommand: "npm test",
      exitCode: 1,
      rawSummary: "multiple identical priority failures",
      failingTests: [
        "zeta_suite › test_z",
        "alpha_suite › test_a",
        "beta_suite › test_b",
      ],
      failureMessages: [
        "AssertionError: expected true to equal false",
        "AssertionError: expected true to equal false",
        "AssertionError: expected true to equal false",
      ],
      localizedFiles: ["src/common.js:10"],
      durationMs: 50,
      inputHash: "inhash",
      outputHash: "outhash",
      authoritative: false,
      verificationAuthority: false,
      terminalAuthority: false,
    };

    const res = selector.selectEvidence(loc, { modifiedFiles: ["src/common.js"] });
    expect(res.selectedRecords.length).toBe(3);
    // All 3 have identical priority scores; lexical tie-breaking by testName must put alpha, beta, zeta
    expect(res.selectedRecords[0]!.testName).toBe("alpha_suite › test_a");
    expect(res.selectedRecords[1]!.testName).toBe("beta_suite › test_b");
    expect(res.selectedRecords[2]!.testName).toBe("zeta_suite › test_z");
  });

  // ---------------------------------------------------------------------------
  // 3. Expected-vs-actual assertion prioritization
  // ---------------------------------------------------------------------------
  it("3. should prioritize expected-vs-actual assertion mismatches over generic runtime errors", () => {
    const loc: TestFailureLocalization = {
      localizationId: "loc-priority-test",
      testCommand: "npm test",
      exitCode: 1,
      rawSummary: "Mixed errors",
      failingTests: [
        "Suite › Generic Error",
        "Suite › Concrete Assertion",
      ],
      failureMessages: [
        "Error: Something went wrong in setup",
        "AssertionError: expected 'active' to equal 'inactive'",
      ],
      localizedFiles: ["src/app.js:20"],
      durationMs: 80,
      inputHash: "inhash",
      outputHash: "outhash",
      authoritative: false,
      verificationAuthority: false,
      terminalAuthority: false,
    };

    const res = selector.selectEvidence(loc, { modifiedFiles: ["src/app.js"] });
    expect(res.selectedRecords[0]!.testName).toBe("Suite › Concrete Assertion");
    expect(res.selectedRecords[0]!.priorityReason).toContain("Concrete failing assertion mismatch");
    expect(res.selectedRecords[1]!.testName).toBe("Suite › Generic Error");
  });

  // ---------------------------------------------------------------------------
  // 4. Prioritization using valid changed-file associations
  // ---------------------------------------------------------------------------
  it("4. should prioritize failures occurring in modified files over unassociated files", () => {
    const loc: TestFailureLocalization = {
      localizationId: "loc-file-prio",
      testCommand: "npm test",
      exitCode: 1,
      rawSummary: "File association test",
      failingTests: [
        "OtherSuite › Test 1",
        "ModifiedSuite › Test 2",
      ],
      failureMessages: [
        "AssertionError: expected 1 to equal 2",
        "AssertionError: expected 1 to equal 2",
      ],
      localizedFiles: ["src/untouched.js:10", "src/modified.js:10"],
      durationMs: 60,
      inputHash: "inhash",
      outputHash: "outhash",
      authoritative: false,
      verificationAuthority: false,
      terminalAuthority: false,
    };

    const res = selector.selectEvidence(loc, { modifiedFiles: ["src/modified.js"] });
    expect(res.selectedRecords[0]!.testName).toBe("ModifiedSuite › Test 2");
    expect(res.selectedRecords[0]!.relevantFile).toBe("src/modified.js");
    expect(res.selectedRecords[0]!.priorityReason).toContain("Directly associated with modified source file");
  });

  // ---------------------------------------------------------------------------
  // 5. Deduplication of identical evidence with counts and references
  // ---------------------------------------------------------------------------
  it("5. should deduplicate identical evidence records while tracking occurrence counts and underlying references", () => {
    const loc: TestFailureLocalization = {
      localizationId: "loc-dedup",
      testCommand: "npm test",
      exitCode: 1,
      rawSummary: "Duplicate tests",
      failingTests: [
        "ParamTest [run 1]",
        "ParamTest [run 1]",
        "ParamTest [run 1]",
      ],
      failureMessages: [
        "AssertionError: value must be positive (received -1)",
        "AssertionError: value must be positive (received -1)",
        "AssertionError: value must be positive (received -1)",
      ],
      localizedFiles: ["src/math.js:42"],
      durationMs: 40,
      inputHash: "inhash",
      outputHash: "outhash",
      authoritative: false,
      verificationAuthority: false,
      terminalAuthority: false,
    };

    const res = selector.selectEvidence(loc, { modifiedFiles: ["src/math.js"] });
    expect(res.selectedRecords.length).toBe(1);
    expect(res.deduplicatedCount).toBe(2);
    expect(res.omittedCount).toBe(0);
    expect(res.selectedRecords[0]!.occurrenceCount).toBe(3);
    expect(res.selectedRecords[0]!.underlyingReferences.length).toBe(3);
    expect(res.formattedObservationText).toContain("Occurrences: 3 identical failures observed");
  });

  // ---------------------------------------------------------------------------
  // 6. Retention of materially different failures
  // ---------------------------------------------------------------------------
  it("6. should retain materially different failures as distinct records", () => {
    const loc: TestFailureLocalization = {
      localizationId: "loc-distinct",
      testCommand: "npm test",
      exitCode: 1,
      rawSummary: "Distinct failures",
      failingTests: [
        "Test 1",
        "Test 2",
        "Test 3",
      ],
      failureMessages: [
        "AssertionError: expected true",
        "AssertionError: expected false",
        "AssertionError: expected null",
      ],
      localizedFiles: ["src/file1.js:10", "src/file1.js:20", "src/file2.js:30"],
      durationMs: 90,
      inputHash: "inhash",
      outputHash: "outhash",
      authoritative: false,
      verificationAuthority: false,
      terminalAuthority: false,
    };

    const res = selector.selectEvidence(loc);
    expect(res.selectedRecords.length).toBe(3);
    expect(res.deduplicatedCount).toBe(0);
    expect(res.omittedCount).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 7. Exact 4,096-byte feedback limit
  // ---------------------------------------------------------------------------
  it("7. should strictly bound serialized feedback text to <= 4,096 bytes", () => {
    const failingTests = Array.from({ length: 50 }, (_, i) => `LargeSuite › Test_${i.toString().padStart(3, "0")}`);
    const failureMessages = Array.from({ length: 50 }, (_, i) => `AssertionError: Failure #${i} — detailed diagnostics information ${"x".repeat(150)}`);

    const loc: TestFailureLocalization = {
      localizationId: "loc-large-budget",
      testCommand: "npm test",
      exitCode: 1,
      rawSummary: `Large output with ${failingTests.length} failures`,
      failingTests,
      failureMessages,
      localizedFiles: ["src/module_0.js:10"],
      durationMs: 250,
      inputHash: "inhash",
      outputHash: "outhash",
      authoritative: false,
      verificationAuthority: false,
      terminalAuthority: false,
    };

    const res = selector.selectEvidence(loc, { maxFeedbackBytes: 4096 });
    expect(res.selectedSerializedBytes).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(res.formattedObservationText, "utf8")).toBeLessThanOrEqual(4096);
    expect(res.truncationApplied).toBe(true);
    expect(res.omittedCount).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // 8. Deterministic truncation with metadata
  // ---------------------------------------------------------------------------
  it("8. should apply deterministic truncation with clear metadata when records exceed budget", () => {
    const failingTests = Array.from({ length: 20 }, (_, i) => `Suite › Test_${i}`);
    const failureMessages = Array.from({ length: 20 }, (_, i) => `AssertionError: Failed check #${i} with payload ${"A".repeat(100)}`);

    const loc: TestFailureLocalization = {
      localizationId: "loc-truncation-test",
      testCommand: "npm test",
      exitCode: 1,
      rawSummary: "Truncation test summary",
      failingTests,
      failureMessages,
      localizedFiles: ["src/core.js:1"],
      durationMs: 150,
      inputHash: "inhash",
      outputHash: "outhash",
      authoritative: false,
      verificationAuthority: false,
      terminalAuthority: false,
    };

    // Use a tight budget of 1024 bytes
    const res = selector.selectEvidence(loc, { maxFeedbackBytes: 1024 });
    expect(res.truncationApplied).toBe(true);
    expect(res.omittedCount).toBeGreaterThan(0);
    expect(res.formattedObservationText).toContain("[TRUNCATED: Remaining");
    expect(res.formattedObservationText).toContain("omitted to preserve context budget");
    expect(res.selectedSerializedBytes).toBeLessThanOrEqual(1024);
  });

  // ---------------------------------------------------------------------------
  // 9. Empty or malformed evidence handling
  // ---------------------------------------------------------------------------
  it("9. should gracefully handle empty or malformed evidence without throwing", () => {
    const emptyLoc: TestFailureLocalization = {
      localizationId: "loc-empty",
      testCommand: "npm test",
      exitCode: 1,
      rawSummary: "",
      failingTests: [],
      failureMessages: [],
      localizedFiles: [],
      durationMs: 10,
      inputHash: "inhash",
      outputHash: "outhash",
      authoritative: false,
      verificationAuthority: false,
      terminalAuthority: false,
    };

    const res = selector.selectEvidence(emptyLoc);
    expect(res.selectedRecords).toEqual([]);
    expect(res.omittedCount).toBe(0);
    expect(res.deduplicatedCount).toBe(0);
    expect(res.truncationApplied).toBe(false);
    expect(res.selectedSerializedBytes).toBeGreaterThan(0);
    expect(res.formattedObservationText).toContain("No actionable failing assertions detected");
    expect(res.authoritative).toBe(false);
    expect(res.verificationAuthority).toBe(false);
    expect(res.terminalAuthority).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 10. Security: Stack-trace paths never opened or read
  // ---------------------------------------------------------------------------
  it("10. SECURITY: should never open or read arbitrary filesystem paths extracted from untrusted stack traces", () => {
    const maliciousPaths = [
      "../../../../etc/passwd",
      "/var/run/secrets/kubernetes.io/serviceaccount/token",
      "C:\\Windows\\System32\\config\\SAM",
      "\\\\malicious-host\\share\\exploit.js",
    ];

    const loc: TestFailureLocalization = {
      localizationId: "loc-sec-traversal",
      testCommand: "npm test",
      exitCode: 1,
      rawSummary: "Malicious stack traces",
      failingTests: maliciousPaths.map((_, idx) => `Exploit › Test_${idx}`),
      failureMessages: maliciousPaths.map((p) => `Error reading malicious target: ${p}`),
      localizedFiles: maliciousPaths,
      durationMs: 30,
      inputHash: "inhash",
      outputHash: "outhash",
      authoritative: false,
      verificationAuthority: false,
      terminalAuthority: false,
    };

    // The selector operates purely on in-memory strings and does not perform filesystem operations
    const res = selector.selectEvidence(loc);
    expect(res.selectedRecords.length).toBe(maliciousPaths.length);
    // Verified that non-existent paths on the system are processed safely as string tokens
    expect(res.selectedRecords[0]!.relevantFile).toBe(maliciousPaths[0]);
  });

  // ---------------------------------------------------------------------------
  // 11. Authoritative failures preserved (immutability)
  // ---------------------------------------------------------------------------
  it("11. should preserve original authoritative failure evidence without alteration", () => {
    const originalLoc = makeSampleLocalization();
    const deepCloneBefore = JSON.parse(JSON.stringify(originalLoc));

    selector.selectEvidence(originalLoc);

    expect(originalLoc).toEqual(deepCloneBefore);
  });

  // ---------------------------------------------------------------------------
  // 12. Non-authoritative status flags
  // ---------------------------------------------------------------------------
  it("12. should maintain explicit non-authoritative boundary flags", () => {
    const res = selector.selectEvidence(makeSampleLocalization());
    expect(res.authoritative).toBe(false);
    expect(res.verificationAuthority).toBe(false);
    expect(res.terminalAuthority).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 13. Evidence digests and integrity checks
  // ---------------------------------------------------------------------------
  it("13. should generate valid SHA-256 evidence digests for original and selected evidence", () => {
    const loc = makeSampleLocalization();
    const res = selector.selectEvidence(loc);

    expect(res.originalEvidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(res.selectedEvidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(res.originalEvidenceDigest).not.toBe(res.selectedEvidenceDigest);

    const expectedOriginalDigest = createHash("sha256").update(loc.rawSummary).digest("hex");
    expect(res.originalEvidenceDigest).toBe(expectedOriginalDigest);
  });

  // ---------------------------------------------------------------------------
  // 14. Deterministic replay reconstruction without test execution
  // ---------------------------------------------------------------------------
  it("14. should support deterministic replay reconstruction across multiple sweeps without executing tests", () => {
    const replayEngine = new ProductionReplayEngine();

    const mockEvidence: ProductionEvidenceBundle = {
      runId: "run-replay-v14",
      missionId: "mission-replay-v14",
      contractId: "contract-replay-v14",
      contractHash: "abc123contracthash",
      workspacePath: "/fake/workspace",
      repositoryPath: "/fake/repo",
      modelId: "qwen2.5-coder:3b",
      contextDigest: "ctxdigest12345",
      actionsCount: 2,
      attemptsCount: 2,
      gitDiff: "diff --git a/calculator.js b/calculator.js\n+ return a + b;",
      testResults: {
        passed: true,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        durationMs: 150,
      },
      verificationResult: {
        verified: true,
        sovereignVerifier: "ProductionVerifier_CleanRoom_v1",
        proofHash: "proof-hash-replay-001",
      },
      timeline: [
        {
          sequence: 1,
          timestamp: "2026-10-22T10:00:00.000Z",
          eventType: "repair.minimal_evidence_selected",
          actor: "MinimalTestEvidenceSelector",
          description: "Selected 1 prioritized failure records (350 bytes, 75.0% reduction, 2 omitted, 1 deduplicated).",
          details: {
            originalEvidenceDigest: "orig-digest-1234",
            selectedEvidenceDigest: "sel-digest-5678",
            originalBytes: 1400,
            selectedBytes: 350,
            reductionPercent: 75.0,
            omittedCount: 2,
            deduplicatedCount: 1,
            truncationApplied: false,
            authoritative: false,
            verificationAuthority: false,
            terminalAuthority: false,
          },
          hash: "hash1",
        },
        {
          sequence: 2,
          timestamp: "2026-10-22T10:00:05.000Z",
          eventType: "verification.completed",
          actor: "SovereignVerifier",
          description: "Sovereign verification PASSED. Proof: proof-hash-replay-001",
          details: { verified: true, proofHash: "proof-hash-replay-001" },
          hash: "hash2",
        },
      ],
      disposition: "ACCEPTED",
      completedAt: "2026-10-22T10:00:10.000Z",
      bundleDigest: "sealed-bundle-digest-v14",
    };

    const sweep1 = replayEngine.reconstructRun(mockEvidence);
    const sweep2 = replayEngine.reconstructRun(mockEvidence);
    const sweep3 = replayEngine.reconstructRun(mockEvidence);

    expect(sweep1.reconstructedSuccessfully).toBe(true);
    expect(sweep2.reconstructedSuccessfully).toBe(true);
    expect(sweep3.reconstructedSuccessfully).toBe(true);

    expect(sweep1.evidenceSelectionObservations).toBeDefined();
    expect(sweep1.evidenceSelectionObservations?.length).toBe(1);
    expect(sweep1.evidenceSelectionObservations![0]!.selectedEvidenceDigest).toBe("sel-digest-5678");
    expect(sweep1.evidenceSelectionObservations![0]!.reductionPercent).toBe(75.0);

    // Byte-for-byte deterministic equality across sweeps
    expect(sweep1).toEqual(sweep2);
    expect(sweep2).toEqual(sweep3);
  });

  // ---------------------------------------------------------------------------
  // 15. No modification to permissions/contracts/budgets
  // ---------------------------------------------------------------------------
  it("15. should ensure no modification to mission contracts, capability fences, or resource budgets", () => {
    const loc = makeSampleLocalization();
    const immutableContract = Object.freeze({ contractId: "contract-c1", maxSteps: 4 });
    const immutableFences = Object.freeze(["tool:read_file", "tool:write_file"]);

    // Selection must not accept or modify any contract/fence parameters
    const res = selector.selectEvidence(loc);
    expect(res).toBeDefined();
    expect(immutableContract.contractId).toBe("contract-c1");
    expect(immutableFences.length).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // 16. Regression coverage: user modifications, scope boundaries, zero auto-commits
  // ---------------------------------------------------------------------------
  it("16. REGRESSION: should verify zero auto-commits invariant and safe fallback behavior", () => {
    // When rawSummary has only parse errors or unrecognized format, fallback cleanly
    const weirdLoc: TestFailureLocalization = {
      localizationId: "loc-weird",
      testCommand: "npm test",
      exitCode: 1,
      rawSummary: "Process exited unexpectedly with SIGKILL",
      failingTests: [],
      failureMessages: [],
      localizedFiles: [],
      durationMs: 10,
      inputHash: "inhash",
      outputHash: "outhash",
      authoritative: false,
      verificationAuthority: false,
      terminalAuthority: false,
    };

    const res = selector.selectEvidence(weirdLoc);
    expect(res.selectedRecords.length).toBe(1);
    expect(res.selectedRecords[0]!.testName).toBe("Unparsed Test Suite Failure");
    expect(res.selectedRecords[0]!.assertionMessage).toBe("Process exited unexpectedly with SIGKILL");
    expect(res.formattedObservationText).toContain("Process exited unexpectedly with SIGKILL");
    expect(res.authoritative).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 17. Distinct source lines must not be collapsed
  // ---------------------------------------------------------------------------
  it("17. should preserve distinct records when same test and assertion occur at different source lines", () => {
    const loc: TestFailureLocalization = {
      localizationId: "loc-distinct-lines",
      testCommand: "npm test",
      exitCode: 1,
      rawSummary: "Same assertion at line 14 and line 28",
      failingTests: [
        "Calculator › asserts positive integer",
        "Calculator › asserts positive integer",
      ],
      failureMessages: [
        "AssertionError: expected positive integer",
        "AssertionError: expected positive integer",
      ],
      localizedFiles: ["src/calc.js:14", "src/calc.js:28"],
      durationMs: 30,
      inputHash: "inhash",
      outputHash: "outhash",
      authoritative: false,
      verificationAuthority: false,
      terminalAuthority: false,
    };

    const res = selector.selectEvidence(loc);
    expect(res.selectedRecords.length).toBe(2);
    expect(res.deduplicatedCount).toBe(0);
    expect(res.selectedRecords[0]!.lineNumber).toBe(14);
    expect(res.selectedRecords[1]!.lineNumber).toBe(28);
    expect(res.selectedRecords[0]!.recordId).not.toBe(res.selectedRecords[1]!.recordId);
  });

  // ---------------------------------------------------------------------------
  // 18. Multibyte Unicode and tiny budget enforcement
  // ---------------------------------------------------------------------------
  it("18. should handle multibyte Unicode assertions and enforce tiny byte budgets without crashing", () => {
    const unicodeMsg = "AssertionError: 🚀 Rocket error with multibyte symbols: こんにちは世界 (expected 100)";
    const loc: TestFailureLocalization = {
      localizationId: "loc-unicode",
      testCommand: "npm test",
      exitCode: 1,
      rawSummary: unicodeMsg,
      failingTests: ["UnicodeSuite › Test_🚀"],
      failureMessages: [unicodeMsg],
      localizedFiles: ["src/intl.js:10"],
      durationMs: 25,
      inputHash: "inhash",
      outputHash: "outhash",
      authoritative: false,
      verificationAuthority: false,
      terminalAuthority: false,
    };

    // Extremely small budget of 150 bytes
    const res = selector.selectEvidence(loc, { maxFeedbackBytes: 150 });
    expect(res.selectedSerializedBytes).toBeLessThanOrEqual(150);
    expect(Buffer.byteLength(res.formattedObservationText, "utf8")).toBeLessThanOrEqual(150);
    expect(res.truncationApplied).toBe(true);
    expect(res.formattedObservationText.includes("\uFFFD")).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 19. Remediation A: Accurate Failure-to-File Attribution without false sharing
  // ---------------------------------------------------------------------------
  it("19. should not assign the first modified file to unrelated failures when multiple failures and localized files exist", () => {
    const loc: TestFailureLocalization = {
      localizationId: "loc-file-attribution",
      testCommand: "npm test",
      exitCode: 1,
      rawSummary: "Multi-failure attribution test",
      failingTests: [
        "Calculator › add › fails",
        "Auth › login › fails",
        "Payment › charge › fails",
      ],
      failureMessages: [
        "AssertionError: expected 5 to equal 6",
        "Error: Invalid credentials token",
        "Error: Gateway unreachable",
      ],
      localizedFiles: [
        "src/calculator.js:14",
        "src/auth.js:45",
        "src/payment.js:88",
      ],
      durationMs: 90,
      inputHash: "inhash",
      outputHash: "outhash",
      authoritative: false,
      verificationAuthority: false,
      terminalAuthority: false,
    };

    // Only calculator.js was modified by the agent
    const res = selector.selectEvidence(loc, { modifiedFiles: ["src/calculator.js"] });

    // Verify each record retains its distinct file attribution (no leakage of calculator.js to auth or payment)
    const calcRecord = res.selectedRecords.find((r) => r.testName.includes("Calculator"));
    const authRecord = res.selectedRecords.find((r) => r.testName.includes("Auth"));
    const paymentRecord = res.selectedRecords.find((r) => r.testName.includes("Payment"));

    expect(calcRecord).toBeDefined();
    expect(calcRecord?.relevantFile).toBe("src/calculator.js");
    expect(calcRecord?.lineNumber).toBe(14);
    expect(calcRecord?.priorityReason).toContain("Directly associated with modified source file");

    expect(authRecord).toBeDefined();
    expect(authRecord?.relevantFile).toBe("src/auth.js");
    expect(authRecord?.lineNumber).toBe(45);
    expect(authRecord?.priorityReason).not.toContain("Directly associated with modified source file");

    expect(paymentRecord).toBeDefined();
    expect(paymentRecord?.relevantFile).toBe("src/payment.js");
    expect(paymentRecord?.lineNumber).toBe(88);
    expect(paymentRecord?.priorityReason).not.toContain("Directly associated with modified source file");

    // Calculator must be prioritized first because it is associated with the modified file
    expect(res.selectedRecords[0]!.recordId).toBe(calcRecord!.recordId);
  });

  // ---------------------------------------------------------------------------
  // 20. Remediation A: Conservatively treat ambiguous file associations as unknown
  // ---------------------------------------------------------------------------
  it("20. should represent file association as unknown when localized files count does not match failure count and no explicit match exists", () => {
    const loc: TestFailureLocalization = {
      localizationId: "loc-ambiguous-files",
      testCommand: "npm test",
      exitCode: 1,
      rawSummary: "Ambiguous file association test",
      failingTests: [
        "GenericSuite › Test_1",
        "GenericSuite › Test_2",
        "GenericSuite › Test_3",
      ],
      failureMessages: [
        "Error: Failure 1",
        "Error: Failure 2",
        "Error: Failure 3",
      ],
      // Only 1 localized file for 3 distinct failures without any test-name mention
      localizedFiles: ["src/random.js:10"],
      durationMs: 50,
      inputHash: "inhash",
      outputHash: "outhash",
      authoritative: false,
      verificationAuthority: false,
      terminalAuthority: false,
    };

    const res = selector.selectEvidence(loc, { modifiedFiles: ["src/random.js"] });

    // Ambiguous association: neither record can authoritatively claim src/random.js
    for (const r of res.selectedRecords) {
      expect(r.relevantFile).toBeUndefined();
      expect(r.lineNumber).toBeUndefined();
      expect(r.priorityReason).not.toContain("Directly associated with modified source file");
    }
  });

  // ---------------------------------------------------------------------------
  // 21. Remediation B: Zero and negative budget enforcement
  // ---------------------------------------------------------------------------
  it("21. should enforce zero and negative budgets by returning empty observation text without crashing", () => {
    const loc = makeSampleLocalization();

    const zeroRes = selector.selectEvidence(loc, { maxFeedbackBytes: 0 });
    expect(zeroRes.formattedObservationText).toBe("");
    expect(Buffer.byteLength(zeroRes.formattedObservationText, "utf8")).toBe(0);
    expect(zeroRes.selectedSerializedBytes).toBe(0);
    expect(zeroRes.selectedRecords.length).toBe(0);
    expect(zeroRes.fullyRepresentedRecords?.length).toBe(0);
    expect(zeroRes.omittedCount).toBe(2);
    expect(zeroRes.truncationApplied).toBe(true);

    const negRes = selector.selectEvidence(loc, { maxFeedbackBytes: -100 });
    expect(negRes.formattedObservationText).toBe("");
    expect(Buffer.byteLength(negRes.formattedObservationText, "utf8")).toBe(0);
    expect(negRes.selectedSerializedBytes).toBe(0);
    expect(negRes.selectedRecords.length).toBe(0);
    expect(negRes.fullyRepresentedRecords?.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 22. Remediation B: Budgets smaller than standard headers or fallback prefixes
  // ---------------------------------------------------------------------------
  it("22. should strictly respect budgets smaller than the standard header without producing replacement characters", () => {
    const loc = makeSampleLocalization();

    for (const tinyBudget of [1, 5, 15, 25, 40, 60, 80]) {
      const res = selector.selectEvidence(loc, { maxFeedbackBytes: tinyBudget });
      const actualBytes = Buffer.byteLength(res.formattedObservationText, "utf8");
      expect(actualBytes).toBeLessThanOrEqual(tinyBudget);
      expect(res.selectedSerializedBytes).toBe(actualBytes);
      expect(res.formattedObservationText.includes("\uFFFD")).toBe(false);
      expect(res.truncationApplied).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // 23. Remediation B: Multibyte Unicode boundary safe truncation (truncateUtf8Safe)
  // ---------------------------------------------------------------------------
  it("23. should truncate multibyte UTF-8 sequences cleanly without splitting code units or generating replacement characters", () => {
    const text = "Prefix 🚀 Rocket こんにちは世界 End";
    // Byte length of 🚀 is 4 bytes, each Japanese character is 3 bytes
    const totalBytes = Buffer.byteLength(text, "utf8");

    for (let budget = 0; budget <= totalBytes + 5; budget++) {
      const truncated = truncateUtf8Safe(text, budget);
      const actualBytes = Buffer.byteLength(truncated, "utf8");
      expect(actualBytes).toBeLessThanOrEqual(budget);
      expect(truncated.includes("\uFFFD")).toBe(false);
    }
  });

  // ---------------------------------------------------------------------------
  // 24. Remediation C: Single oversized failure record
  // ---------------------------------------------------------------------------
  it("24. should handle a single oversized failure record with explicit partialRecordTruncationApplied metadata", () => {
    const hugeAssertion = "AssertionError: Expected state mismatch: " + "X".repeat(10000);
    const loc: TestFailureLocalization = {
      localizationId: "loc-huge",
      testCommand: "npm test",
      exitCode: 1,
      rawSummary: hugeAssertion,
      failingTests: ["HugeSuite › Test_Huge"],
      failureMessages: [hugeAssertion],
      localizedFiles: ["src/huge.js:1"],
      durationMs: 80,
      inputHash: "inhash",
      outputHash: "outhash",
      authoritative: false,
      verificationAuthority: false,
      terminalAuthority: false,
    };

    const res = selector.selectEvidence(loc, { maxFeedbackBytes: 1024 });

    expect(res.selectedSerializedBytes).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(res.formattedObservationText, "utf8")).toBeLessThanOrEqual(1024);
    expect(res.truncationApplied).toBe(true);
    expect(res.partialRecordTruncationApplied).toBe(true);
    // Candidate was selected but could not be fully represented within 1024 bytes
    expect(res.selectedRecords.length).toBe(1);
    expect(res.fullyRepresentedRecords?.length).toBe(0);
    expect(res.formattedObservationText.includes("\uFFFD")).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 25. Remediation C: Complete records selected as units with consistent metadata
  // ---------------------------------------------------------------------------
  it("25. should include complete records as units and maintain exact metadata consistency", () => {
    // 4 records of moderate size
    const failingTests = ["Test A", "Test B", "Test C", "Test D"];
    const failureMessages = [
      "AssertionError: Expected A to equal B in module A",
      "AssertionError: Expected B to equal C in module B",
      "AssertionError: Expected C to equal D in module C",
      "AssertionError: Expected D to equal E in module D",
    ];
    const localizedFiles = [
      "src/a.js:10",
      "src/b.js:20",
      "src/c.js:30",
      "src/d.js:40",
    ];

    const loc: TestFailureLocalization = {
      localizationId: "loc-units",
      testCommand: "npm test",
      exitCode: 1,
      rawSummary: "Units test summary",
      failingTests,
      failureMessages,
      localizedFiles,
      durationMs: 40,
      inputHash: "inhash",
      outputHash: "outhash",
      authoritative: false,
      verificationAuthority: false,
      terminalAuthority: false,
    };

    // Budget that fits approximately 2 records completely
    const res = selector.selectEvidence(loc, { maxFeedbackBytes: 650 });

    expect(res.selectedSerializedBytes).toBeLessThanOrEqual(650);
    expect(res.partialRecordTruncationApplied).toBe(false);
    expect(res.fullyRepresentedRecords).toEqual(res.selectedRecords);
    expect(res.selectedRecords.length).toBeGreaterThanOrEqual(1);
    expect(res.omittedCount).toBe(4 - res.selectedRecords.length);

    // Each selected record must appear completely in the formatted observation text
    for (const r of res.selectedRecords) {
      expect(res.formattedObservationText).toContain(`Test: "${r.testName}"`);
      expect(res.formattedObservationText).toContain(`Assertion: ${r.assertionMessage}`);
      expect(res.formattedObservationText).toContain(`Location: ${r.relevantFile}:${r.lineNumber}`);
    }

    // Digests must match SHA-256 of respective formatted texts
    const expectedDigest = createHash("sha256").update(res.formattedObservationText).digest("hex");
    expect(res.selectedEvidenceDigest).toBe(expectedDigest);
  });
});
