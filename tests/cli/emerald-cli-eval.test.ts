import { describe, expect, it } from "vitest";
import { EmeraldCli } from "../../src/cli/emerald-cli.js";

describe("CLI: emerald eval command suite", () => {
  const cli = new EmeraldCli();

  it("lists all capability gates G1-G10 in human-readable and JSON format", async () => {
    const textRes = await cli.run(["eval", "list-gates"]);
    expect(textRes.exitCode).toBe(0);
    expect(textRes.output).toContain("G1_STRUCTURED_JSON");
    expect(textRes.output).toContain("G2_REPO_NAVIGATION");
    expect(textRes.output).toContain("G10_COMPLETION_SIGNAL");

    const jsonRes = await cli.run(["eval", "list-gates", "--json"]);
    expect(jsonRes.exitCode).toBe(0);
    const parsed = JSON.parse(jsonRes.output);
    expect(parsed.G1_STRUCTURED_JSON).toBeDefined();
    expect(parsed.G2_REPO_NAVIGATION).toBeDefined();
  });

  it("inspects capability evidence across models", async () => {
    const textRes = await cli.run(["eval", "inspect-evidence", "--model", "qwen2.5-coder:1.5b"]);
    expect(textRes.exitCode).toBe(0);
    expect(textRes.output).toContain("qwen2.5-coder:1.5b");
    expect(textRes.output).toContain("[PASSED]"); // G1 is passed
    expect(textRes.output).toContain("[FAILED]"); // G8, G10 are failed
    expect(textRes.output).toContain("[UNVERIFIED]"); // G2-G7, G9

    const jsonRes = await cli.run(["eval", "inspect-evidence", "--model", "qwen2.5-coder:1.5b", "--json"]);
    expect(jsonRes.exitCode).toBe(0);
    const parsed = JSON.parse(jsonRes.output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].modelId).toBe("qwen2.5-coder:1.5b");
  });

  it("lists benchmark tasks for specific gates and in total", async () => {
    const allRes = await cli.run(["eval", "list-tasks"]);
    expect(allRes.exitCode).toBe(0);
    expect(allRes.output).toContain("g2-nav-01-locate-auth-service");
    expect(allRes.output).toContain("g4-repair-01-fix-math-pow");

    const gateRes = await cli.run(["eval", "list-tasks", "--gate", "G4_SINGLE_FILE_REPAIR"]);
    expect(gateRes.exitCode).toBe(0);
    expect(gateRes.output).toContain("g4-repair-01-fix-math-pow");
    expect(gateRes.output).not.toContain("g2-nav-01");
  });

  it("executes cleanroom dual-gate fixture validation safely", async () => {
    const runRes = await cli.run([
      "eval",
      "run-fixtures",
      "--task",
      "g4-repair-01-fix-math-pow",
      "--trials",
      "1",
    ]);
    expect(runRes.exitCode).toBe(0);
    expect(runRes.output).toContain("[FIXTURE_VALIDATION]");
    expect(runRes.output).toContain("[INDEPENDENT_VERIFICATION]");
    expect(runRes.output).toContain("G4_SINGLE_FILE_REPAIR");
  });

  it("fails closed when run-live is requested without founder authorization", async () => {
    const liveRes = await cli.run(["eval", "run-live"]);
    expect(liveRes.exitCode).toBe(1);
    expect(liveRes.output).toContain("LIVE_MODEL_EVALUATION_BLOCKED");
    expect(liveRes.output).toContain("Founder approval required");
  });

  it("generates markdown and json certification scorecards", async () => {
    const mdRes = await cli.run(["eval", "report"]);
    expect(mdRes.exitCode).toBe(0);
    expect(mdRes.output).toContain("# Emerald Agent Fabric — Capability Certification Scorecard");
    expect(mdRes.output).toContain("`qwen2.5-coder:1.5b`");

    const jsonRes = await cli.run(["eval", "report", "--json"]);
    expect(jsonRes.exitCode).toBe(0);
    const parsed = JSON.parse(jsonRes.output);
    expect(parsed.title).toBeDefined();
    expect(Array.isArray(parsed.models)).toBe(true);
  });

  // ========================================================================
  // CLI CONTRACT COMPATIBILITY & EVIDENCE INTEGRITY TESTS
  // ========================================================================

  it("verifies field-by-field schema integrity of run-fixtures --json output", async () => {
    const jsonRes = await cli.run([
      "eval",
      "run-fixtures",
      "--task",
      "g4-repair-01-fix-math-pow",
      "--trials",
      "1",
      "--json",
    ]);
    expect(jsonRes.exitCode).toBe(0);
    const parsed = JSON.parse(jsonRes.output);

    // Verify top-level structure
    expect(Array.isArray(parsed.trialResults)).toBe(true);
    expect(parsed.trialResults.length).toBe(1);
    expect(typeof parsed.summaries).toBe("object");

    // Verify trialResult required fields and types
    const trial = parsed.trialResults[0];
    expect(typeof trial.trialId).toBe("string");
    expect(typeof trial.trialIndex).toBe("number");
    expect(typeof trial.taskId).toBe("string");
    expect(typeof trial.gateId).toBe("string");
    expect(typeof trial.modelId).toBe("string");
    expect(typeof trial.modelDigest).toBe("string");
    expect(typeof trial.harnessVersion).toBe("string");
    expect(typeof trial.evaluationMode).toBe("string");
    expect(typeof trial.overallPassed).toBe("boolean");
    expect(typeof trial.durationMs).toBe("number");
    expect(typeof trial.observedAt).toBe("string");
    expect(typeof trial.configHash).toBe("string");
    expect(typeof trial.inputHash).toBe("string");
    expect(typeof trial.outputHash).toBe("string");
    expect(typeof trial.trialEvidenceHash).toBe("string");
    expect(typeof trial.stepsExecuted).toBe("number");
    expect(Array.isArray(trial.stepRecords)).toBe(true);

    // Verify GateA and GateB assessments
    expect(typeof trial.gateA.passed).toBe("boolean");
    expect(typeof trial.gateA.score).toBe("number");
    expect(typeof trial.gateB.passed).toBe("boolean");
    expect(typeof trial.gateB.verifierType).toBe("string");

    // Verify GateStatisticalSummary required fields and types
    const summary = parsed.summaries["G4_SINGLE_FILE_REPAIR"];
    expect(summary).toBeDefined();
    expect(typeof summary.gateId).toBe("string");
    expect(typeof summary.modelId).toBe("string");
    expect(typeof summary.modelDigest).toBe("string");
    expect(typeof summary.totalTrials).toBe("number");
    expect(typeof summary.passedTrials).toBe("number");
    expect(typeof summary.failedTrials).toBe("number");
    expect(typeof summary.timedOutTrials).toBe("number");
    expect(typeof summary.gateAPassCount).toBe("number");
    expect(typeof summary.gateBPassCount).toBe("number");
    expect(typeof summary.successRate).toBe("number");
    expect(typeof summary.status).toBe("string");
    expect(Array.isArray(summary.reasons)).toBe(true);

    // If breakdowns are present, assert they are objects
    if (summary.failureBreakdown !== undefined) {
      expect(typeof summary.failureBreakdown).toBe("object");
    }
    if (summary.rootCauseBreakdown !== undefined) {
      expect(typeof summary.rootCauseBreakdown).toBe("object");
    }
  });

  it("safely handles legacy v1.0.0 payloads without diagnostic breakdowns", () => {
    // Representative v1.0.0 payload (prior to ADR-0045 failure taxonomy additions)
    const legacyPayload = {
      trialResults: [
        {
          trialId: "trial-legacy-01",
          trialIndex: 0,
          taskId: "g3-diag-01-off-by-one",
          gateId: "G3_CODE_UNDERSTANDING",
          modelId: "qwen2.5-coder:1.5b",
          modelDigest: "sha256:d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668",
          harnessVersion: "cleanroom-eval-v3.0",
          evaluationMode: "LIVE_MODEL_EVALUATION",
          gateA: { passed: false, score: 0.0, rationale: "timeout", details: [] },
          gateB: { passed: false, verifierType: "CLEANROOM_ORACLE", details: [], independentEvidenceRef: "ref" },
          overallPassed: false,
          durationMs: 30008,
          observedAt: "2026-11-11T13:41:28.000Z",
          configHash: "cf00000000000000000000000000000000000000000000000000000000000000",
          inputHash: "in00000000000000000000000000000000000000000000000000000000000000",
          outputHash: "out0000000000000000000000000000000000000000000000000000000000000",
          trialEvidenceHash: "ev0000000000000000000000000000000000000000000000000000000000000",
          stepsExecuted: 1,
          stepRecords: [],
          // Note: failureClassification and diagnosticRootCause are absent in legacy records
        },
      ],
      summaries: {
        G3_CODE_UNDERSTANDING: {
          gateId: "G3_CODE_UNDERSTANDING",
          modelId: "qwen2.5-coder:1.5b",
          modelDigest: "sha256:d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668",
          harnessVersion: "cleanroom-eval-v3.0",
          evaluationMode: "LIVE_MODEL_EVALUATION",
          totalTrials: 1,
          passedTrials: 0,
          failedTrials: 1,
          timedOutTrials: 0,
          gateAPassCount: 0,
          gateBPassCount: 0,
          successRate: 0.0,
          minLatencyMs: 30008,
          medianLatencyMs: 30008,
          p90LatencyMs: 30008,
          maxLatencyMs: 30008,
          status: "FAILED",
          reasons: ["Success rate (0.0%) is below required threshold (70.0%)"],
          // Note: failureBreakdown and rootCauseBreakdown are undefined
        },
      },
    };

    const serialized = JSON.stringify(legacyPayload);
    const deserialized = JSON.parse(serialized);

    const sum = deserialized.summaries.G3_CODE_UNDERSTANDING;
    expect(sum.failureBreakdown).toBeUndefined();
    expect(sum.rootCauseBreakdown).toBeUndefined();

    // Verify consumer handling: safe fallback
    const fbCount = sum.failureBreakdown ? Object.keys(sum.failureBreakdown).length : 0;
    const rcbCount = sum.rootCauseBreakdown ? Object.keys(sum.rootCauseBreakdown).length : 0;
    expect(fbCount).toBe(0);
    expect(rcbCount).toBe(0);

    // Verify required metrics remain fully functional
    expect(sum.totalTrials).toBe(1);
    expect(sum.status).toBe("FAILED");
  });

  it("confirms run-fixtures output strictly labels fixture mode and disclaims live certification", async () => {
    const textRes = await cli.run([
      "eval",
      "run-fixtures",
      "--task",
      "g4-repair-01-fix-math-pow",
      "--trials",
      "1",
    ]);

    expect(textRes.exitCode).toBe(0);
    expect(textRes.output).toContain("Mode: [FIXTURE_VALIDATION] · Verification: [INDEPENDENT_VERIFICATION]");
    expect(textRes.output).toContain("Note: Fixture validation proves harness execution and independent verification.");
    expect(textRes.output).toContain("Live model certification remains blocked until founder approval is granted.");
    // Assert fixture output does NOT claim live certification passed
    expect(textRes.output).not.toContain("G4 LIVE CERTIFICATION PASSED");
    expect(textRes.output).not.toContain("--- EVIDENCE RECORD ---");
  });
});
