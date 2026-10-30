/**
 * Phase 44C — Single Local Structured-Output Preflight Trial Test
 *
 * Executes exactly ONE live model inference request on EAF-BM-01
 * using qwen2.5-coder:1.5b against the locally installed Ollama daemon,
 * using the promoted 7-branch production ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA.
 *
 * Fixed Constraints:
 * - Exactly 1 model request (maxSteps: 1).
 * - Per-step timeout: 120,000 ms.
 * - Endpoint: http://127.0.0.1:11434 (local-first, ₹0 cost).
 * - Completely isolated ephemeral workspace; zero mutation to repo or benchmarks.
 * - Authoritative ProposalValidator and PolicyEvaluator remain authoritative.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";

import { Phase43BenchmarkRunner } from "../../src/production/benchmark/phase43-benchmark-runner.js";
import { OllamaModelProvider } from "../../src/adapters/models/ollama-model-provider.js";
import {
  EvidenceSigner,
  TrustedKeyring,
} from "../../src/application/evidence-signer.js";
import { ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA } from "../../src/application/live-agent-brain.js";

describe("Phase 44C — Single Local Structured-Output Preflight", () => {
  it("executes exactly ONE live request with promoted schema on EAF-BM-01 and records classification", async () => {
    const startTimestamp = new Date().toISOString();
    const perfStart = performance.now();

    // 1. Setup threshold cryptographic authorities
    const workerKeys = EvidenceSigner.generateKeyPair();
    const supervisorKeys = EvidenceSigner.generateKeyPair();

    const keyring = new TrustedKeyring();
    keyring.registerKey({
      authorityId: "auth-worker-p44c",
      keyId: "key-worker-p44c",
      role: "WORKER_PRODUCER",
      publicKey: workerKeys.publicKey,
      status: "TRUSTED",
    });
    keyring.registerKey({
      authorityId: "auth-supervisor-p44c",
      keyId: "key-supervisor-p44c",
      role: "SUPERVISOR",
      publicKey: supervisorKeys.publicKey,
      status: "TRUSTED",
    });

    // 2. Setup Live Ollama Model Provider (Local HTTP only, ₹0 cost)
    const provider = new OllamaModelProvider({
      baseURL: "http://127.0.0.1:11434",
      defaultModel: "qwen2.5-coder:1.5b",
      timeoutMs: 120000,
    });

    // 3. Setup Runner and Task
    const runner = new Phase43BenchmarkRunner();
    const task = runner.getTask("EAF-BM-01");

    console.log("================================================================================");
    console.log("Starting Phase 44C Live Structured-Output Preflight");
    console.log(`Task: ${task.taskId} - ${task.title}`);
    console.log(`Model: qwen2.5-coder:1.5b`);
    console.log(`Promoted Schema Branches: ${ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA.jsonSchema.anyOf.length}`);
    console.log(`Step Timeout: 120,000 ms | Max Steps: 1 (Exactly ONE model call)`);
    console.log(`Timestamp: ${startTimestamp}`);
    console.log("================================================================================");

    let trialError: unknown = null;
    let result: any = null;

    try {
      // 4. Execute the Single Preflight Step (maxSteps: 1 enforces exactly ONE model invocation)
      result = await runner.executeTrial(task, {
        modelProvider: provider,
        model: "qwen2.5-coder:1.5b",
        signingKeys: { workerKeys, supervisorKeys },
        keyring,
        maxSteps: 1,
        stepTimeoutMs: 120000,
        retainWorkspace: true,
      });
    } catch (err: unknown) {
      trialError = err;
      console.error("Trial execution threw an uncaught error:", err);
    }

    const perfDurationMs = Math.round(performance.now() - perfStart);
    const endTimestamp = new Date().toISOString();

    console.log("================================================================================");
    console.log(`Preflight Request Completed in ${perfDurationMs} ms`);

    // Extract completion & diagnostic details
    const rawCompletion = result?.diagnostics?.rawCompletions?.[0];
    const rawOutput = rawCompletion?.rawOutput ?? "NO_RAW_OUTPUT";
    const durationMs = rawCompletion?.durationMs ?? perfDurationMs;
    const promptTokens = result?.tokenMetrics?.promptTokens ?? rawCompletion?.promptTokens ?? null;
    const evalTokens = result?.tokenMetrics?.evalTokens ?? rawCompletion?.evalTokens ?? null;
    const totalTokens = result?.tokenMetrics?.totalTokens ?? null;
    const modelCalls = result?.tokenMetrics?.modelCalls ?? (rawCompletion ? 1 : 0);

    const stepDiag = result?.diagnostics?.stepDiagnostics?.[0];
    const proposalRejection = result?.diagnostics?.proposalRejections?.[0];

    // Determine classification
    let classification:
      | "PREFLIGHT_PASS"
      | "PREFLIGHT_SCHEMA_FAILURE"
      | "PREFLIGHT_TIMEOUT"
      | "PREFLIGHT_INVALID_OUTPUT"
      | "PREFLIGHT_INFRASTRUCTURE_FAILURE";

    if (trialError) {
      const errStr = String(trialError);
      if (errStr.includes("Timeout") || errStr.includes("timed out")) {
        classification = "PREFLIGHT_TIMEOUT";
      } else if (errStr.includes("schema") || errStr.includes("format") || errStr.includes("grammar")) {
        classification = "PREFLIGHT_SCHEMA_FAILURE";
      } else {
        classification = "PREFLIGHT_INFRASTRUCTURE_FAILURE";
      }
    } else if (result?.terminalReason === "TIMEOUT_EXCEEDED" || result?.tokenMetrics?.modelFailures > 0 && perfDurationMs >= 120000) {
      classification = "PREFLIGHT_TIMEOUT";
    } else if (stepDiag?.proposalValid === true) {
      classification = "PREFLIGHT_PASS";
    } else if (stepDiag?.proposalValid === false) {
      classification = "PREFLIGHT_INVALID_OUTPUT";
    } else if (result?.terminalReason === "STEP_LIMIT_EXCEEDED" && result?.totalActions > 0) {
      classification = "PREFLIGHT_PASS";
    } else {
      classification = "PREFLIGHT_INVALID_OUTPUT";
    }

    console.log(`Classification: ${classification}`);
    console.log(`Model Calls: ${modelCalls}`);
    console.log(`Raw Completion: ${rawOutput.slice(0, 500)}`);
    console.log(`Proposal Valid: ${stepDiag?.proposalValid ?? "unknown"}`);
    if (proposalRejection) {
      console.log(`Rejection Reason: ${proposalRejection.rejectionReason}`);
      console.log(`Rejection Message: ${proposalRejection.validatorMessage}`);
    }
    console.log(`Terminal Status: ${result?.terminalStatus ?? "ERROR"}`);
    console.log(`Terminal Reason: ${result?.terminalReason ?? (trialError ? String(trialError) : "UNKNOWN")}`);
    console.log("================================================================================");

    // Persist preflight record to scratch
    const recordPath = path.join(process.cwd(), "scratch", "phase44c-preflight-results.json");
    const preflightRecord = {
      trial: "Phase 44C Preflight",
      task: task.taskId,
      model: "qwen2.5-coder:1.5b",
      modelDigest: "d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668",
      classification,
      timestamps: {
        startedAt: startTimestamp,
        completedAt: endTimestamp,
        wallClockDurationMs: perfDurationMs,
      },
      schema: {
        name: ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA.name,
        branchCount: ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA.jsonSchema.anyOf.length,
        toolsCovered: ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA.jsonSchema.anyOf.slice(1).map((b: any) => b.properties.toolName.enum[0]),
      },
      telemetry: {
        modelCalls,
        modelFailures: result?.tokenMetrics?.modelFailures ?? (trialError ? 1 : 0),
        promptTokens,
        evalTokens,
        totalTokens,
        durationMs,
      },
      execution: {
        stepCount: result?.totalSteps ?? 0,
        actionCount: result?.totalActions ?? 0,
        proposalRejectionCount: result?.totalProposalRejections ?? 0,
        terminalStatus: result?.terminalStatus ?? "ERROR",
        terminalReason: result?.terminalReason ?? (trialError ? String(trialError) : "ERROR"),
      },
      rawOutput,
      stepDiagnostic: stepDiag ?? null,
      proposalRejection: proposalRejection ?? null,
      evidenceBundle: result?.evidenceBundle
        ? {
            bundleId: result.evidenceBundle.bundleId,
            provenanceRoot: result.evidenceBundle.provenanceRoot,
            signaturesCount: result.evidenceBundle.signatures?.length ?? 0,
            eventsCount: result.evidenceBundle.events?.length ?? 0,
          }
        : null,
      offlineAudit: result?.offlineAudit ?? null,
    };

    await fs.writeFile(recordPath, JSON.stringify(preflightRecord, null, 2), "utf8");

    // Assert that trial concluded deterministically and recorded results
    expect(classification).toBeDefined();
    expect(modelCalls).toBeLessThanOrEqual(1);
    if (result) {
      expect(result.evidenceBundle?.signatures?.length).toBe(2);
    }
  }, 180000); // 3-minute overall vitest timeout for single 120s step
});
