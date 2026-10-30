/**
 * Phase 47B — Governed Live Repair Trial with Localized Editing & Test-Guided Feedback
 *
 * Executes exactly ONE live local Ollama repair trial for EAF-BM-01
 * using qwen2.5-coder:1.5b, exercising:
 * 1. Governed localized edit operation (edit_file)
 * 2. Intermediate test-guided feedback (failToPass, passToPass executed post-mutation)
 * 3. Stagnation control (max 3 consecutive ineffective edits -> terminalReason: STAGNATION)
 * 4. Dynamic Context-Aware Tool Filtering (derived schema branches)
 *
 * Configuration:
 * - Model: qwen2.5-coder:1.5b (local Ollama HTTP only, ₹0 financial cost)
 * - maxSteps: 8
 * - stepTimeoutMs: 120,000 ms (120 seconds per request)
 * - maxProposalRejections: 3
 * - maxWallClockMs: 720,000 ms (12 minutes)
 * - retainWorkspace: true
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";

import { Phase43BenchmarkRunner } from "../../src/production/benchmark/phase43-benchmark-runner.js";
import { OllamaModelProvider } from "../../src/adapters/models/ollama-model-provider.js";
import {
  EvidenceSigner,
  TrustedKeyring,
} from "../../src/application/evidence-signer.js";
import { OfflineAuditor } from "../../src/application/offline-auditor.js";

const execFileAsync = promisify(execFile);

describe("Phase 47B — Governed Live Repair Trial", () => {
  const EXPECTED_INITIAL_CALC_HASH =
    "5594898f27a8f06e58c6c9b19fcc55ec58e708ac0f1823a2f3d3abfb82a72f17";
  const RECORD_PATH = path.resolve(process.cwd(), "scratch/phase47b-repair-results.json");

  it("Preflight: verifies fixture hash, defect baseline, model availability, and artifact non-existence", async () => {
    // 1. Verify artifact does not already exist
    let recordExists = false;
    try {
      await fs.access(RECORD_PATH);
      recordExists = true;
    } catch {
      recordExists = false;
    }
    expect(recordExists).toBe(false);

    // 2. Verify authoritative fixture content and initial hash
    const runner = new Phase43BenchmarkRunner();
    const task = runner.getTask("EAF-BM-01");
    const initialCalcJs = task.initialFiles["src/calc.js"];
    expect(initialCalcJs).toBeDefined();

    const initialHash = crypto
      .createHash("sha256")
      .update(initialCalcJs, "utf8")
      .digest("hex");
    expect(initialHash).toBe(EXPECTED_INITIAL_CALC_HASH);

    // 3. Verify baseline defect: F2P exits 1, P2P exits 0 on untouched fixture
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-p47b-"));
    try {
      for (const [relPath, content] of Object.entries(task.initialFiles)) {
        const fullPath = path.join(tempDir, relPath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content, "utf8");
      }

      // F2P
      const [f2pCmd, ...f2pArgs] = task.failToPass.testCommand;
      let f2pExitCode = 0;
      try {
        await execFileAsync(f2pCmd, f2pArgs, { cwd: tempDir });
      } catch (err: any) {
        f2pExitCode = err.code ?? 1;
      }
      expect(f2pExitCode).toBe(task.failToPass.expectedBaselineExitCode);

      // P2P
      const [p2pCmd, ...p2pArgs] = task.passToPass.testCommand;
      let p2pExitCode = 0;
      try {
        await execFileAsync(p2pCmd, p2pArgs, { cwd: tempDir });
      } catch (err: any) {
        p2pExitCode = err.code ?? 1;
      }
      expect(p2pExitCode).toBe(task.passToPass.expectedBaselineExitCode);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    // 4. Verify local Ollama model availability
    const tagsRes = await fetch("http://127.0.0.1:11434/api/tags");
    expect(tagsRes.ok).toBe(true);
    const tagsJson = (await tagsRes.json()) as { models?: Array<{ name: string; digest: string }> };
    const qwenModel = tagsJson.models?.find(
      (m) => m.name === "qwen2.5-coder:1.5b" || m.name.startsWith("qwen2.5-coder:1.5b")
    );
    expect(qwenModel).toBeDefined();
    console.log(`Preflight: Local model verified: ${qwenModel?.name} (${qwenModel?.digest})`);
  });

  it(
    "executes exactly ONE governed live repair trial on EAF-BM-01 with qwen2.5-coder:1.5b",
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

      console.log("================================================================================");
      console.log("Starting Phase 47B Live Repair Trial (Governed Localized Editing)");
      console.log(`Task: ${task.taskId} - ${task.title}`);
      console.log("Model: qwen2.5-coder:1.5b");
      console.log("Tools: read_file, write_file, edit_file, search_code, git_status, git_diff, run_command");
      console.log("Dynamic Tool Filtering: ENABLED");
      console.log("Intermediate Test Feedback: ENABLED");
      console.log("Stagnation Limit: 3 consecutive ineffective edits");
      console.log("Max Steps: 8, Max Wall Time: 12 minutes (720,000 ms)");
      console.log(`Timestamp: ${startTimestamp}`);
      console.log("================================================================================");

      // 4. Execute the Single Live Trial
      const result = await runner.executeTrial(task, {
        modelProvider: provider,
        model: "qwen2.5-coder:1.5b",
        signingKeys: { workerKeys, supervisorKeys },
        keyring,
        maxSteps: 8,
        stepTimeoutMs: 120000,
        enableDynamicToolFiltering: true,
        retainWorkspace: true,
      });

      const perfDurationMs = Math.round(performance.now() - perfStart);
      const endTimestamp = new Date().toISOString();

      console.log("================================================================================");
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
      console.log("================================================================================");

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
      let finalTargetFileHash = EXPECTED_INITIAL_CALC_HASH;
      if (result.workspaceHostPath) {
        const targetFilePath = await findFileRecursively(result.workspaceHostPath, "calc.js");
        if (targetFilePath) {
          targetFileFound = true;
          try {
            finalTargetContent = await fs.readFile(targetFilePath, "utf8");
            finalTargetFileHash = crypto
              .createHash("sha256")
              .update(finalTargetContent, "utf8")
              .digest("hex");
          } catch {
            // Unreadable
          }
        }
      }

      const initialTargetContent = task.initialFiles["src/calc.js"];
      const targetFileModified = targetFileFound && finalTargetContent !== initialTargetContent;

      // Check if unrelated files changed
      let unrelatedFilesChanged = false;
      if (result.workspaceHostPath) {
        for (const [relPath, expectedContent] of Object.entries(task.initialFiles)) {
          if (relPath === "src/calc.js") continue;
          const filePath = path.join(result.workspaceHostPath, relPath);
          try {
            const actual = await fs.readFile(filePath, "utf8");
            if (actual !== expectedContent) {
              unrelatedFilesChanged = true;
            }
          } catch {
            // Check if file was deleted
            unrelatedFilesChanged = true;
          }
        }
      }

      const verifyEvt = result.evidenceBundle.events.find(
        (e) => e.eventType === "verification.completed"
      );
      const candidatePatchBytes = (verifyEvt?.payload as any)?.details?.candidatePatchBytes ?? 0;
      const candidatePatchHash = (verifyEvt?.payload as any)?.details?.candidatePatchHash ?? "none";

      // Count actions by tool
      const actionEvents = result.evidenceBundle.events.filter(
        (e) => e.eventType === "agent.action.started" || e.eventType === "action.created"
      );
      const stepTranscript = result.diagnostics.stepDiagnostics;
      const readActions = stepTranscript.filter((s) => s.toolName === "read_file");
      const writeActions = stepTranscript.filter((s) => s.toolName === "write_file");
      const editActions = stepTranscript.filter((s) => s.toolName === "edit_file");
      const testFeedbackDelivered = stepTranscript.filter((s) =>
        s.inputPayload && (s as any).progressAdvisory
      );

      // Re-run offline auditor independently on written bundle
      const bundleFilePath = path.join(
        result.workspaceHostPath || os.tmpdir(),
        `evidence-${result.runId}.json`
      );
      let independentAudit = result.offlineAudit;
      try {
        await fs.writeFile(
          bundleFilePath,
          JSON.stringify(result.evidenceBundle, null, 2),
          "utf8"
        );
        independentAudit = await OfflineAuditor.verifyEvidence(bundleFilePath, {
          keyring,
          thresholdPolicy: { threshold: 2, totalAuthorities: 3 },
        });
      } catch {
        // Fallback to runner's audit result
      }

      // Classification per specification
      let classification: "VERIFIED_REPAIR" | "REPAIR_FAILED" | "STAGNATION_TERMINATED" | "TIMED_OUT" | "BLOCKED";
      if (result.verified && independentAudit.status === "VERIFIED") {
        classification = "VERIFIED_REPAIR";
      } else if (result.terminalReason === "STAGNATION") {
        classification = "STAGNATION_TERMINATED";
      } else if (result.terminalStatus === "TIMED_OUT" || result.terminalReason === "MAX_STEPS") {
        classification = "TIMED_OUT";
      } else {
        classification = "REPAIR_FAILED";
      }

      // Assemble Trial Record
      const trialRecord = {
        phase: "Phase 47B",
        task: "EAF-BM-01",
        taskTitle: task.title,
        classification,
        model: {
          name: "qwen2.5-coder:1.5b",
          digest: "d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668",
          parameters: "1.5B",
          quantization: "Q4_K_M",
          format: "gguf",
          endpoint: "http://127.0.0.1:11434",
        },
        timing: {
          startedAt: startTimestamp,
          completedAt: endTimestamp,
          wallClockDurationMs: perfDurationMs,
        },
        configuration: {
          maxSteps: 8,
          maxWallClockMs: 720000,
          maxProposalRejections: 3,
          maxConsecutiveIneffectiveEdits: 3,
          dynamicToolFiltering: true,
          intermediateTestFeedback: true,
          toolsEnabled: [
            "read_file",
            "write_file",
            "edit_file",
            "run_command",
            "search_code",
            "git_status",
            "git_diff",
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
          readActionsCount: readActions.length,
          writeActionsCount: writeActions.length,
          editActionsCount: editActions.length,
        },
        stageProgression: {
          stageA_proposal: {
            proposedEditFile: editActions.length > 0,
            editProposalsCount: editActions.length,
          },
          stageB_mutation: {
            appliedSuccessfully: targetFileModified,
            targetFile: "src/calc.js",
            initialHash: EXPECTED_INITIAL_CALC_HASH,
            finalHash: finalTargetFileHash,
            targetFileModified,
            unrelatedFilesPreserved: !unrelatedFilesChanged,
            finalTargetFileContent: finalTargetContent,
          },
          stageC_verification: {
            cleanRoomStatus: result.cleanRoomOutcome?.status ?? "NONE",
            cleanRoomVerified: result.verified,
            f2pPass: result.cleanRoomOutcome?.status === "VERIFIED",
            p2pPass: result.cleanRoomOutcome?.status === "VERIFIED",
          },
          stageD_evidence: {
            bundleId: result.evidenceBundle.bundleId,
            signaturesCount: result.evidenceBundle.signatures.length,
            eventsCount: result.evidenceBundle.events.length,
            offlineAuditStatus: independentAudit.status,
            thresholdSatisfied: independentAudit.thresholdSatisfied,
            fourfoldSatisfied: independentAudit.fourfoldSatisfied,
            auditFailures: independentAudit.failures ?? [],
          },
        },
        cleanRoomVerification: result.cleanRoomOutcome ?? null,
        evidenceBundle: {
          bundleId: result.evidenceBundle.bundleId,
          provenanceRoot: result.evidenceBundle.provenanceRoot,
          signaturesCount: result.evidenceBundle.signatures.length,
          eventsCount: result.evidenceBundle.events.length,
        },
        offlineAudit: {
          status: independentAudit.status,
          thresholdSatisfied: independentAudit.thresholdSatisfied,
          fourfoldSatisfied: independentAudit.fourfoldSatisfied,
          failures: independentAudit.failures,
        },
        comparisonWithHistoricalTrials: {
          phase44d: {
            configuration: "Static 7-branch schema, ungrounded task context, no edit_file, no stagnation control",
            behavior: "Repeated read_file 5 times",
            terminalStatus: "TIMED_OUT",
            terminalReason: "MAX_STEPS",
            steps: 5,
            actions: 5,
            editActions: 0,
            writeActions: 0,
            verified: false,
          },
          phase45c: {
            configuration: "Static 7-branch schema, grounded defect context, read stagnation advisory",
            behavior: "Repeated read_file 3 times, halted by stagnation advisory",
            terminalStatus: "FAILED",
            terminalReason: "STAGNATION",
            steps: 3,
            actions: 3,
            editActions: 0,
            writeActions: 0,
            verified: false,
          },
          phase46c: {
            configuration: "Dynamic schema filtering (CT-1..8), whole-file write_file available",
            behavior: "1 read, followed by full-file write_file attempts (syntax error console.log(42))",
            terminalStatus: "FAILED",
            terminalReason: "VERIFICATION_FAILED",
            steps: 5,
            actions: 5,
            editActions: 0,
            writeActions: 4,
            verified: false,
          },
          phase47b: {
            configuration: "Dynamic schema filtering + edit_file + intermediate test feedback + edit stagnation",
            behavior: `${readActions.length} reads, ${editActions.length} edits, ${writeActions.length} writes, steps=${result.totalSteps}, terminalReason=${result.terminalReason}`,
            terminalStatus: result.terminalStatus,
            terminalReason: result.terminalReason,
            steps: result.totalSteps,
            actions: result.totalActions,
            editActions: editActions.length,
            writeActions: writeActions.length,
            verified: result.verified,
          },
        },
        workspaceHostPath: result.workspaceHostPath,
        diagnostics: result.diagnostics,
      };

      await fs.writeFile(RECORD_PATH, JSON.stringify(trialRecord, null, 2), "utf8");
      console.log(`Saved Phase 47B trial record to ${RECORD_PATH}`);

      // Cryptographic and governance invariant expectations
      expect(result.evidenceBundle.signatures.length).toBe(2);
      expect(result.offlineAudit.status).toBe("VERIFIED");
      expect(result.totalProposalRejections).toBeLessThanOrEqual(3);
    },
    750000 // 12.5 minute timeout for vitest
  );
});
