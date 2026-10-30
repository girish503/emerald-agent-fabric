/**
 * Phase 45C — Single Governed Live Repair Trial Test
 *
 * Executes exactly ONE live local Ollama repair trial for EAF-BM-01
 * using qwen2.5-coder:1.5b, exercising the grounded task context (Phase 45B)
 * and stagnation progression control (Phase 45C).
 *
 * Configuration:
 * - Model: qwen2.5-coder:1.5b
 * - maxSteps: 5
 * - Per-step timeout: 120,000 ms
 * - maxProposalRejections: 3
 * - Stagnation threshold: 3 consecutive identical reads
 * - Local Ollama only (http://127.0.0.1:11434)
 * - ₹0 financial cost
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

describe("Phase 45C — Single Governed Live Repair Trial", () => {
  it(
    "executes exactly one governed live trial on EAF-BM-01 with qwen2.5-coder:1.5b",
    async () => {
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
        defaultModel: "qwen2.5-coder:1.5b",
        timeoutMs: 120000,
      });

      // 3. Setup Runner
      const runner = new Phase43BenchmarkRunner();
      const task = runner.getTask("EAF-BM-01");

      console.log("--------------------------------------------------------------------------------");
      console.log("Starting Phase 45C Live Repair Trial");
      console.log(`Task: ${task.taskId} - ${task.title}`);
      console.log("Model: qwen2.5-coder:1.5b");
      console.log(`Timestamp: ${startTimestamp}`);
      console.log("--------------------------------------------------------------------------------");

      // 4. Execute the Single Live Trial
      const result = await runner.executeTrial(task, {
        modelProvider: provider,
        model: "qwen2.5-coder:1.5b",
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
      console.log(
        `Steps: ${result.totalSteps}, Actions: ${result.totalActions}, Proposal Rejections: ${result.totalProposalRejections}`
      );
      console.log(
        `Model Calls: ${result.tokenMetrics.modelCalls}, Prompt Tokens: ${result.tokenMetrics.promptTokens ?? "unmeasured"}, Completion Tokens: ${result.tokenMetrics.evalTokens ?? "unmeasured"}`
      );
      console.log(`Offline Auditor Status: ${result.offlineAudit.status}`);
      console.log("--------------------------------------------------------------------------------");

      // Inspect workspace files to determine final target file content and patch
      async function findFileRecursively(dir: string, targetName: string): Promise<string | null> {
        try {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              const nested = await findFileRecursively(fullPath, targetName);
              if (nested) return nested;
            } else if (entry.name === targetName) {
              return fullPath;
            }
          }
        } catch {
          return null;
        }
        return null;
      }

      let finalTargetContent = "not modified";
      let targetFileFound = false;
      if (result.workspaceHostPath) {
        const targetFilePath = await findFileRecursively(result.workspaceHostPath, "calc.js");
        if (targetFilePath) {
          targetFileFound = true;
          try {
            finalTargetContent = await fs.readFile(targetFilePath, "utf8");
          } catch {
            // Unreadable
          }
        }
      }

      const initialTargetContent = task.initialFiles["src/calc.js"];
      const targetFileModified = targetFileFound && finalTargetContent !== initialTargetContent;

      const verifyEvt = result.evidenceBundle.events.find(
        (e) => e.eventType === "verification.completed"
      );
      const candidatePatchBytes = (verifyEvt?.payload as any)?.details?.candidatePatchBytes ?? 0;
      const candidatePatchHash = (verifyEvt?.payload as any)?.details?.candidatePatchHash ?? "none";

      // 5. Accurate Classification per User Specification
      // A. REPAIR_SUCCESS: A valid patch was applied and independent post-repair verification passed.
      // B. STAGNATION_TERMINATED: The controller halted a redundant read loop before step budget exhausted.
      // C. OTHER_FAILURE: Model stalled, timed out, emitted invalid proposals, failed execution, etc.
      let classification: "REPAIR_SUCCESS" | "STAGNATION_TERMINATED" | "OTHER_FAILURE";

      if (result.verified) {
        classification = "REPAIR_SUCCESS";
      } else if (result.terminalReason === "STAGNATION") {
        classification = "STAGNATION_TERMINATED";
      } else {
        classification = "OTHER_FAILURE";
      }

      // Check whether an advisory was recorded in diagnostics
      const progressAdvisories = result.diagnostics.stepDiagnostics
        .filter((d) => d.progressAdvisory !== undefined)
        .map((d) => ({
          stepNumber: d.stepNumber,
          advisory: d.progressAdvisory,
        }));

      // Check whether write_file action occurred
      const writeActions = result.diagnostics.stepDiagnostics.filter(
        (d) => d.toolName === "write_file"
      );

      // 6. Persist comprehensive trial record to scratch
      const recordPath = path.join(process.cwd(), "scratch", "phase45c-repair-results.json");
      const trialRecord = {
        trial: "Phase 45C Governed Live Repair Trial",
        task: task.taskId,
        taskTitle: task.title,
        model: "qwen2.5-coder:1.5b",
        modelDigest: "d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668",
        classification,
        timestamps: {
          startedAt: startTimestamp,
          completedAt: endTimestamp,
          wallClockDurationMs: perfDurationMs,
        },
        schema: {
          name: "action_proposal",
          branchCount: 7,
          toolsCovered: [
            "read_file",
            "write_file",
            "search_code",
            "git_status",
            "git_diff",
            "run_command",
          ],
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
          writeActionsCount: writeActions.length,
          progressAdvisoriesCount: progressAdvisories.length,
          progressAdvisories,
        },
        workspaceMutation: {
          targetFile: "src/calc.js",
          targetFileFound,
          targetFileModified,
          initialContentLength: initialTargetContent?.length ?? 0,
          finalContentLength: finalTargetContent.length,
          finalTargetFileContent: finalTargetContent,
        },
        patch: {
          candidatePatchBytes,
          candidatePatchHash,
        },
        cleanRoomVerification: result.cleanRoomOutcome ?? null,
        evidenceBundle: {
          bundleId: result.evidenceBundle.bundleId,
          provenanceRoot: result.evidenceBundle.provenanceRoot,
          signaturesCount: result.evidenceBundle.signatures.length,
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
      console.log(`Saved trial record to ${recordPath}`);

      // Basic invariant expectations
      expect(result.evidenceBundle.signatures.length).toBe(2);
      expect(result.offlineAudit.status).toBe("VERIFIED");
      expect(result.totalProposalRejections).toBeLessThanOrEqual(3);
    },
    600000 // 10 minute timeout for vitest
  );
});
