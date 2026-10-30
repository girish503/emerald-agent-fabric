/**
 * Phase 48B — Single Governed Live Repair Trial Under Hardened Edit Contracts
 *
 * Executes exactly ONE live local Ollama repair trial for EAF-BM-01
 * using qwen2.5-coder:1.5b under Phase 48A hardened edit contracts:
 * 1. edit_file semantic metadata, minimal EAF-BM-01 example, and line:10 warning projected
 * 2. Stage 11b NOOP_EDIT_DISALLOWED rejection for searchAnchor === replacementText
 * 3. LineAnchoredEditor fail-closed defense-in-depth on identical anchor/replacement
 * 4. Actionable rejection guidance instructing literal code text (NOT line:10)
 * 5. Targeted ACTION_RECOVERY_GUIDANCE observation on missing search anchor
 * 6. Governed benchmark repair mode: true
 * 7. Allow whole file replacement: false
 * 8. Dynamic Context-Aware Tool Filtering: enabled
 * 9. Governed localized editing (edit_file): enabled and authorized
 * 10. Intermediate test feedback: enabled
 * 11. Stagnation control: max 3 consecutive ineffective edits
 *
 * Configuration:
 * - Model: qwen2.5-coder:1.5b (local Ollama HTTP only, ₹0 financial cost)
 * - Task: EAF-BM-01
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
import { EvidenceReplayVerifier } from "../../src/application/evidence-replay-verifier.js";

const execFileAsync = promisify(execFile);

describe("Phase 48B — Governed Live Repair Trial Under Hardened Edit Contracts", () => {
  const EXPECTED_INITIAL_CALC_HASH =
    "5594898f27a8f06e58c6c9b19fcc55ec58e708ac0f1823a2f3d3abfb82a72f17";
  const RECORD_PATH = path.resolve(process.cwd(), "scratch/phase48b-repair-results.json");

  it("Preflight: verifies fixture hash, defect baseline, model availability, and artifact non-existence", async () => {
    // 1. Verify destination artifact does NOT exist
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

    // 3. Verify baseline defect: F2P exits 1, P2P exits 0 on untouched fixture in fresh isolated directory
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-p48b-"));
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
      // Re-verify artifact destination does not exist
      let recordExists = false;
      try {
        await fs.access(RECORD_PATH);
        recordExists = true;
      } catch {
        recordExists = false;
      }
      if (recordExists) {
        throw new Error(`Target record path already exists: ${RECORD_PATH}`);
      }

      const startTimestamp = new Date().toISOString();
      const perfStart = performance.now();

      // 1. Setup cryptographic authorities
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

      // 3. Setup Benchmark Runner
      const runner = new Phase43BenchmarkRunner();
      const task = runner.getTask("EAF-BM-01");

      console.log("================================================================================");
      console.log("Starting Phase 48B Live Repair Trial (Hardened Edit Contracts)");
      console.log(`Task: ${task.taskId} - ${task.title}`);
      console.log("Model: qwen2.5-coder:1.5b");
      console.log("Tools: read_file, write_file, edit_file, search_code, git_status, git_diff, run_command");
      console.log("Governed Benchmark Repair Mode: ENABLED");
      console.log("Allow Whole File Replacement: FALSE");
      console.log("Dynamic Tool Filtering: ENABLED");
      console.log("Intermediate Test Feedback: ENABLED");
      console.log("Max Steps: 8, Max Proposal Rejections: 3, Max Wall Time: 12 minutes");
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
        governedBenchmarkRepairMode: true,
        allowWholeFileReplacement: false,
      });

      const perfDurationMs = Math.round(performance.now() - perfStart);
      const endTimestamp = new Date().toISOString();

      console.log("================================================================================");
      console.log(`Phase 48B Live Trial Complete in ${perfDurationMs} ms`);
      console.log(`Clean-Room Dual-Gate Verified: ${result.verified}`);
      console.log(`Terminal Status: ${result.terminalStatus} (${result.terminalReason})`);
      console.log(
        `Steps: ${result.totalSteps}, Actions: ${result.totalActions}, Proposal Rejections: ${result.totalProposalRejections}`
      );
      console.log(
        `Model Calls: ${result.tokenMetrics.modelCalls}, Prompt Tokens: ${result.tokenMetrics.promptTokens ?? "unmeasured"}, Completion Tokens: ${result.tokenMetrics.evalTokens ?? "unmeasured"}`
      );
      console.log(`Offline Auditor Status: ${result.offlineAudit.status}`);
      console.log("================================================================================");

      // 5. Inspect workspace files to determine final target file content and hash
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
            unrelatedFilesChanged = true;
          }
        }
      }

      // Analyze step diagnostics & telemetry
      const stepTranscript = result.diagnostics.stepDiagnostics;
      const readActions = stepTranscript.filter((s) => s.toolName === "read_file");
      const writeActions = stepTranscript.filter((s) => s.toolName === "write_file");
      const editActions = stepTranscript.filter((s) => s.toolName === "edit_file");

      // Analyze proposal rejections
      const rejectionSteps = stepTranscript.filter((s) => s.proposalValid === false);
      const overwriteRejections = stepTranscript.filter(
        (s) => s.proposalRejectionReason === "DISALLOWED_FILE_OVERWRITE"
      );
      const noopEditRejections = stepTranscript.filter(
        (s) => s.proposalRejectionReason === "NOOP_EDIT_DISALLOWED"
      );
      const editFileAttempts = stepTranscript.filter((s) => s.toolName === "edit_file");
      const editFileAccepted = editFileAttempts.filter((s) => s.proposalValid === true);
      const editFileRejected = editFileAttempts.filter((s) => s.proposalValid === false);

      const writeFileAttempts = stepTranscript.filter((s) => s.toolName === "write_file");
      const writeFileExistingDenials = overwriteRejections;
      const writeFileNewAllowed = writeFileAttempts.filter(
        (s) => s.proposalValid === true && (s.inputPayload as any)?.path !== "src/calc.js"
      );

      // Search-anchor analysis for edit_file
      const anchorFailures = stepTranscript.filter(
        (s) =>
          s.toolName === "edit_file" &&
          s.executionError &&
          (s.executionError.includes("Search anchor not found") ||
            s.executionError.includes("0 occurrences matched") ||
            s.executionError.includes("searchAnchor") ||
            s.executionError.includes("anchor"))
      );
      const ambiguousAnchors = stepTranscript.filter(
        (s) =>
          s.toolName === "edit_file" &&
          s.executionError &&
          s.executionError.includes("Multiple occurrences")
      );

      // Check whether anchor used literal code text vs line-number selectors
      const anchorDetails = editFileAttempts.map((e) => {
        const payload = e.inputPayload as Record<string, unknown> | null;
        const anchor = typeof payload?.searchAnchor === "string" ? payload.searchAnchor : null;
        const replacement = typeof payload?.replacementText === "string" ? payload.replacementText : null;
        const isLineSelector = anchor ? /^line:\d+/i.test(anchor.trim()) : false;
        const isLiteralCode = anchor ? anchor.includes("return") || anchor.includes("function") || anchor.includes("+") : false;
        return {
          step: e.stepNumber,
          proposalValid: e.proposalValid,
          rejectionReason: e.proposalRejectionReason ?? null,
          anchor,
          replacement,
          isLineSelector,
          isLiteralCode,
          executionStatus: e.actionStatus ?? null,
          executionError: e.executionError ?? null,
        };
      });

      // Check whether model re-read source after an anchor failure
      let reReadAfterAnchorFailure = false;
      for (let i = 0; i < stepTranscript.length - 1; i++) {
        const current = stepTranscript[i]!;
        const next = stepTranscript[i + 1]!;
        if (
          current.toolName === "edit_file" &&
          current.actionStatus === "FAILED" &&
          next.toolName === "read_file"
        ) {
          reReadAfterAnchorFailure = true;
          break;
        }
      }

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

      // Replay verification to obtain exact fourfold predicates
      const replayResult = EvidenceReplayVerifier.verify(result.evidenceBundle);
      const fourfold = replayResult.fourfoldOutcome;

      // Verify gold patch match
      const goldHash = crypto
        .createHash("sha256")
        .update(task.goldPatch, "utf8")
        .digest("hex");
      const candidateMatchesGold = finalTargetFileHash === goldHash;

      // Determine classification strictly according to specification:
      let classification: "VERIFIED_REPAIR" | "REPAIR_FAILED" | "STAGNATION_TERMINATED" | "TIMED_OUT" | "BLOCKED";
      const isCleanRoomDualGatePassed =
        result.verified &&
        result.cleanRoomOutcome?.status === "VERIFIED" &&
        result.cleanRoomOutcome?.failToPass?.passed === true &&
        result.cleanRoomOutcome?.passToPass?.passed === true;

      const isAuditPassed =
        independentAudit.status === "VERIFIED" && independentAudit.thresholdSatisfied === true;

      if (
        isCleanRoomDualGatePassed &&
        isAuditPassed &&
        candidateMatchesGold &&
        !unrelatedFilesChanged
      ) {
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
        phase: "Phase 48B",
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
          governedBenchmarkRepairMode: true,
          allowWholeFileReplacement: false,
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
        governedEditingTelemetry: {
          editFileAttemptsCount: editFileAttempts.length,
          editFileAcceptedCount: editFileAccepted.length,
          editFileRejectedCount: editFileRejected.length,
          noopEditRejectionsCount: noopEditRejections.length,
          writeFileAttemptsCount: writeFileAttempts.length,
          writeFileExistingDenialsCount: writeFileExistingDenials.length,
          writeFileNewAllowedCount: writeFileNewAllowed.length,
          disallowedFileOverwriteDenials: overwriteRejections.map((r) => ({
            step: r.stepNumber,
            toolName: r.toolName,
            reason: r.proposalRejectionReason,
            message: r.proposalRejectionMessage,
          })),
          noopEditDenials: noopEditRejections.map((r) => ({
            step: r.stepNumber,
            toolName: r.toolName,
            reason: r.proposalRejectionReason,
            message: r.proposalRejectionMessage,
          })),
          anchorFailuresCount: anchorFailures.length,
          ambiguousAnchorsCount: ambiguousAnchors.length,
          anchorDetails,
          reReadAfterAnchorFailure,
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
            goldHash,
            candidateMatchesGold,
            targetFileModified,
            unrelatedFilesPreserved: !unrelatedFilesChanged,
            finalTargetFileContent: finalTargetContent,
          },
          stageC_verification: {
            cleanRoomStatus: result.cleanRoomOutcome?.status ?? "NONE",
            cleanRoomVerified: result.verified,
            f2pPass: result.cleanRoomOutcome?.failToPass?.passed ?? false,
            p2pPass: result.cleanRoomOutcome?.passToPass?.passed ?? false,
          },
          stageD_evidence: {
            bundleId: result.evidenceBundle.bundleId,
            provenanceRoot: result.evidenceBundle.provenanceRoot,
            signaturesCount: result.evidenceBundle.signatures.length,
            eventsCount: result.evidenceBundle.events.length,
            offlineAuditStatus: independentAudit.status,
            thresholdSatisfied: independentAudit.thresholdSatisfied,
            fourfoldSatisfied: independentAudit.fourfoldSatisfied,
            auditFailures: independentAudit.failures ?? [],
            replayDerivedOutcome: replayResult.terminalOutcome,
            fourfoldPredicates: {
              taskSatisfied: fourfold.taskSatisfied,
              policySatisfied: fourfold.policySatisfied,
              verificationPassed: fourfold.verificationPassed,
              evidenceComplete: fourfold.evidenceComplete,
            },
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
          replayValid: independentAudit.replayValid,
          policyValid: independentAudit.policyValid,
          secretPolicySatisfied: independentAudit.secretPolicySatisfied,
          evidenceComplete: independentAudit.evidenceComplete,
          failures: independentAudit.failures,
        },
        fourfoldPredicates: {
          taskSatisfied: fourfold.taskSatisfied,
          policySatisfied: fourfold.policySatisfied,
          verificationPassed: fourfold.verificationPassed,
          evidenceComplete: fourfold.evidenceComplete,
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
            configuration: "Dynamic schema filtering, whole-file write_file permitted",
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
            behavior: "1 read, 3 whole-file writes (failed F2P and broke P2P), terminated by stagnation",
            terminalStatus: "FAILED",
            terminalReason: "STAGNATION",
            steps: 4,
            actions: 4,
            editActions: 0,
            writeActions: 3,
            verified: false,
          },
          phase47d: {
            configuration: "Phase 47C Governed Overwrite Policy + Dynamic tool filtering + edit_file + intermediate test feedback",
            behavior: "1 read, 1 no-op edit, 1 line:10 anchor failure, 2 write_file overwrite denials (halted by max rejections)",
            terminalStatus: "FAILED",
            terminalReason: "MAX_PROPOSAL_REJECTIONS",
            steps: 5,
            actions: 3,
            editActions: 2,
            writeActions: 1,
            overwriteRejectionsCount: 2,
            verified: false,
          },
          phase48b: {
            configuration: "Phase 48A Hardened Edit Contracts + Governed Overwrite Policy + Dynamic tool filtering + edit_file + recovery guidance",
            behavior: `${readActions.length} reads, ${editActions.length} edits, ${writeActions.length} writes, steps=${result.totalSteps}, terminalReason=${result.terminalReason}`,
            terminalStatus: result.terminalStatus,
            terminalReason: result.terminalReason,
            steps: result.totalSteps,
            actions: result.totalActions,
            editActions: editActions.length,
            writeActions: writeActions.length,
            overwriteRejectionsCount: overwriteRejections.length,
            noopEditRejectionsCount: noopEditRejections.length,
            verified: result.verified,
          },
        },
        workspaceHostPath: result.workspaceHostPath,
        diagnostics: result.diagnostics,
      };

      // Write result only after re-verifying file does not exist
      let finalCheckExists = false;
      try {
        await fs.access(RECORD_PATH);
        finalCheckExists = true;
      } catch {
        finalCheckExists = false;
      }
      if (finalCheckExists) {
        throw new Error(`Target record path already exists: ${RECORD_PATH}`);
      }

      await fs.writeFile(RECORD_PATH, JSON.stringify(trialRecord, null, 2), "utf8");
      console.log(`Saved Phase 48B trial record to ${RECORD_PATH}`);

      // Invariant assertions
      expect(result.evidenceBundle.signatures.length).toBe(2);
      expect(result.offlineAudit.status).toBe("VERIFIED");
      expect(result.totalProposalRejections).toBeLessThanOrEqual(3);
    },
    750000 // 12.5 minute timeout for vitest
  );
});
