/**
 * Phase 43 — Gate B.4: Single Live Ollama Trial Test
 *
 * Executes exactly ONE live governed benchmark trial on EAF-BM-01
 * using the locally installed open-weights model qwen2.5-coder:3b
 * with active structured proposal-rejection feedback and Rule 3 prompt clarification.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";

import {
  Phase43BenchmarkRunner,
} from "../../src/production/benchmark/phase43-benchmark-runner.js";
import { OllamaModelProvider } from "../../src/adapters/models/ollama-model-provider.js";
import {
  EvidenceSigner,
  TrustedKeyring,
} from "../../src/application/evidence-signer.js";

describe("Phase 43 — Gate B.4 Single Live Ollama Trial (3B Model)", () => {
  it("executes exactly one live trial for EAF-BM-01 with qwen2.5-coder:3b and audits outcome", async () => {
    const startTimestamp = new Date().toISOString();
    const perfStart = performance.now();

    // 1. Setup threshold cryptographic authorities
    const workerKeys = EvidenceSigner.generateKeyPair();
    const supervisorKeys = EvidenceSigner.generateKeyPair();

    const keyring = new TrustedKeyring();
    keyring.registerKey({
      authorityId: "auth-worker-p43",
      keyId: "key-worker-p43",
      role: "WORKER_PRODUCER",
      publicKey: workerKeys.publicKey,
      status: "TRUSTED",
    });
    keyring.registerKey({
      authorityId: "auth-supervisor-p43",
      keyId: "key-supervisor-p43",
      role: "SUPERVISOR",
      publicKey: supervisorKeys.publicKey,
      status: "TRUSTED",
    });

    // 2. Setup Live Ollama Model Provider (Local HTTP only, ₹0 cost)
    const provider = new OllamaModelProvider({
      baseURL: "http://127.0.0.1:11434",
      defaultModel: "qwen2.5-coder:3b",
      timeoutMs: 120000,
    });

    // 3. Setup Runner
    const runner = new Phase43BenchmarkRunner();
    const task = runner.getTask("EAF-BM-01");

    console.log("--------------------------------------------------------------------------------");
    console.log(`Starting Phase 43 Gate B.4 Live Trial`);
    console.log(`Task: ${task.taskId} - ${task.title}`);
    console.log(`Model: qwen2.5-coder:3b`);
    console.log(`Timestamp: ${startTimestamp}`);
    console.log("--------------------------------------------------------------------------------");

    // 4. Execute the Single Live Trial
    const result = await runner.executeTrial(task, {
      modelProvider: provider,
      model: "qwen2.5-coder:3b",
      signingKeys: { workerKeys, supervisorKeys },
      keyring,
      maxSteps: 5,
      stepTimeoutMs: 120000,
      retainWorkspace: true,
    });

    const perfDurationMs = Math.round(performance.now() - perfStart);
    const endTimestamp = new Date().toISOString();

    console.log("--------------------------------------------------------------------------------");
    console.log(`Live Trial Complete in ${perfDurationMs} ms`);
    console.log(`Verified Clean-Room Dual-Gate: ${result.verified}`);
    console.log(`Authoritative Status: ${result.terminalStatus} (${result.terminalReason})`);
    console.log(`Steps: ${result.totalSteps}, Actions: ${result.totalActions}, Proposal Rejections: ${result.totalProposalRejections}`);
    console.log(`Model Calls: ${result.tokenMetrics.modelCalls}, Prompt Tokens: ${result.tokenMetrics.promptTokens ?? "unmeasured"}, Completion Tokens: ${result.tokenMetrics.evalTokens ?? "unmeasured"}`);
    console.log(`Offline Auditor Status: ${result.offlineAudit.status}`);
    console.log("--------------------------------------------------------------------------------");

    // Extract applied patch if target file was written
    let finalTargetContent = "not modified";
    if (result.workspaceHostPath) {
      try {
        finalTargetContent = await fs.readFile(
          path.join(result.workspaceHostPath, task.targetFile),
          "utf8"
        );
      } catch {
        // Not modified or deleted
      }
    }

    const verifyEvt = result.evidenceBundle.events.find((e) => e.eventType === "verification.completed");
    const candidatePatchBytes = (verifyEvt?.payload as any)?.details?.candidatePatchBytes ?? 0;
    const candidatePatchHash = (verifyEvt?.payload as any)?.details?.candidatePatchHash ?? "none";

    // 5. Persist comprehensive trial record to scratch
    const recordPath = path.join(process.cwd(), "scratch", "phase43-gate-b4-trial-results.json");
    const trialRecord = {
      trial: "Gate B.4",
      task: task.taskId,
      model: "qwen2.5-coder:3b",
      modelDigest: "f72c60cabf6237b07f6e632b2c48d533cef25eda2efbd34bed21c5e9c01e6225",
      timestamps: {
        startedAt: startTimestamp,
        completedAt: endTimestamp,
        wallClockDurationMs: perfDurationMs,
      },
      telemetry: {
        modelCalls: result.tokenMetrics.modelCalls,
        modelFailures: result.tokenMetrics.modelFailures,
        promptTokens: result.tokenMetrics.promptTokens ?? null,
        evalTokens: result.tokenMetrics.evalTokens ?? null,
        totalTokens: result.tokenMetrics.totalTokens ?? null,
      },
      execution: {
        verified: result.verified,
        terminalStatus: result.terminalStatus,
        terminalReason: result.terminalReason,
        totalSteps: result.totalSteps,
        totalActions: result.totalActions,
        totalProposalRejections: result.totalProposalRejections,
      },
      patch: {
        candidatePatchBytes,
        candidatePatchHash,
        finalTargetFileContent: finalTargetContent,
      },
      cleanRoomVerification: verifyEvt?.payload ?? null,
      evidenceBundle: {
        bundleId: result.evidenceBundle.bundleId,
        provenanceRoot: result.evidenceBundle.provenanceRoot,
        signaturesCount: result.evidenceBundle.signatures?.length ?? 0,
        eventsCount: result.evidenceBundle.events.length,
      },
      offlineAudit: {
        status: result.offlineAudit.status,
        thresholdSatisfied: result.offlineAudit.thresholdSatisfied,
        fourfoldSatisfied: result.offlineAudit.fourfoldSatisfied,
        failures: result.offlineAudit.failures,
      },
      workspaceHostPath: result.workspaceHostPath,
      diagnostics: result.diagnostics,
    };

    await fs.writeFile(recordPath, JSON.stringify(trialRecord, null, 2), "utf8");

    expect(result.evidenceBundle.bundleId).toBeDefined();
    expect(result.evidenceBundle.signatures?.length).toBe(2);
    expect(result.offlineAudit.status).toBe("VERIFIED");
  }, 300000); // 5 minute overall timeout
});
