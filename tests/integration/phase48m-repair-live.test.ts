import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Phase43BenchmarkRunner } from "../../src/production/benchmark/phase43-benchmark-runner.js";
import { OllamaModelProvider } from "../../src/adapters/models/ollama-model-provider.js";
import { EvidenceSigner, TrustedKeyring } from "../../src/application/evidence-signer.js";
import { OfflineAuditor } from "../../src/application/offline-auditor.js";
import { EvidenceReplayVerifier } from "../../src/application/evidence-replay-verifier.js";

const execFileAsync = promisify(execFile);

describe("Phase 48M — Single Live Trial: Post-Pass Verification Latch Validation", () => {
  const EXPECTED_INITIAL_CALC_HASH =
    "5594898f27a8f06e58c6c9b19fcc55ec58e708ac0f1823a2f3d3abfb82a72f17";
  const EXPECTED_PHASE48J_HASH =
    "3ddddd528e41c0fac114fcae87100b9aad709e32c6b0d4ed1ba9b571f1e82866";
  const RECORD_PATH = path.resolve(process.cwd(), "scratch/phase48m-repair-results.json");
  const PHASE48J_PATH = path.resolve(process.cwd(), "scratch/phase48j-repair-results.json");

  it("Preflight: verifies fixture hash, defect baseline, model availability, Phase 48J preservation, and artifact non-existence", async () => {
    // 1. Verify destination artifact does NOT exist
    let recordExists = false;
    try {
      await fs.access(RECORD_PATH);
      recordExists = true;
    } catch {
      recordExists = false;
    }
    expect(recordExists).toBe(false);

    // 2. Verify Phase 48J artifact remains strictly unchanged
    const phase48jContent = await fs.readFile(PHASE48J_PATH, "utf8");
    const phase48jHash = crypto.createHash("sha256").update(phase48jContent, "utf8").digest("hex");
    expect(phase48jHash).toBe(EXPECTED_PHASE48J_HASH);

    // 3. Verify authoritative fixture content and initial hash
    const runner = new Phase43BenchmarkRunner();
    const task = runner.getTask("EAF-BM-01");
    const initialCalcJs = task.initialFiles["src/calc.js"];
    expect(initialCalcJs).toBeDefined();

    const initialHash = crypto
      .createHash("sha256")
      .update(initialCalcJs, "utf8")
      .digest("hex");
    expect(initialHash).toBe(EXPECTED_INITIAL_CALC_HASH);

    // 4. Verify baseline defect: F2P exits 1, P2P exits 0 on untouched fixture in fresh isolated directory
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-p48m-"));
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

    // 5. Verify local Ollama model availability and digest for qwen2.5-coder:3b
    const tagsRes = await fetch("http://127.0.0.1:11434/api/tags");
    expect(tagsRes.ok).toBe(true);
    const tagsJson = (await tagsRes.json()) as { models?: Array<{ name: string; digest: string }> };
    const qwenModel = tagsJson.models?.find(
      (m) => m.name === "qwen2.5-coder:3b" || m.name.startsWith("qwen2.5-coder:3b")
    );
    expect(qwenModel).toBeDefined();
    expect(qwenModel?.digest).toBe("f72c60cabf6237b07f6e632b2c48d533cef25eda2efbd34bed21c5e9c01e6225");
    console.log(`Preflight: Local 3B model verified: ${qwenModel?.name} (${qwenModel?.digest})`);
  });

  it(
    "executes exactly ONE governed live repair trial on EAF-BM-01 with qwen2.5-coder:3b (Post-Pass Verification Latch Enabled)",
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

      // Pre-warm the model into memory
      console.log("Pre-warming qwen2.5-coder:3b into host memory before trial...");
      const warmStart = performance.now();
      const warmRes = await fetch("http://127.0.0.1:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen2.5-coder:3b",
          prompt: "Pre-warm memory",
          stream: false,
          options: { num_predict: 2 },
        }),
      });
      expect(warmRes.ok).toBe(true);
      const warmDuration = Math.round(performance.now() - warmStart);
      console.log(`Pre-warming completed in ${warmDuration} ms. Model is resident.`);

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

      // 2. Setup Live Ollama Model Provider (Local HTTP only, ₹0 cost, 300,000 ms timeout)
      const provider = new OllamaModelProvider({
        baseURL: "http://127.0.0.1:11434",
        defaultModel: "qwen2.5-coder:3b",
        timeoutMs: 300000,
      });

      // 3. Setup Benchmark Runner
      const runner = new Phase43BenchmarkRunner();
      const task = runner.getTask("EAF-BM-01");

      console.log("================================================================================");
      console.log("Starting Phase 48M Live Repair Trial (3B Model with Post-Pass Verification Latch)");
      console.log(`Task: ${task.taskId} - ${task.title}`);
      console.log("Model: qwen2.5-coder:3b");
      console.log("Tools: read_file, write_file, edit_file, search_code, git_status, git_diff, run_command");
      console.log("Governed Benchmark Repair Mode: ENABLED");
      console.log("Allow Whole File Replacement: FALSE");
      console.log("Dynamic Tool Filtering: ENABLED");
      console.log("Intermediate Test Feedback: ENABLED");
      console.log("Post-Pass Verification Latch: ENABLED");
      console.log("Max Steps: 8, Step Timeout: 300,000 ms, Max Proposal Rejections: 3");
      console.log(`Timestamp: ${startTimestamp}`);
      console.log("================================================================================");

      // 4. Execute the Single Live Trial
      const result = await runner.executeTrial(task, {
        modelProvider: provider,
        model: "qwen2.5-coder:3b",
        signingKeys: { workerKeys, supervisorKeys },
        keyring,
        maxSteps: 8,
        stepTimeoutMs: 300000,
        enableDynamicToolFiltering: true,
        retainWorkspace: true,
        governedBenchmarkRepairMode: true,
        allowWholeFileReplacement: false,
      });

      const perfDurationMs = Math.round(performance.now() - perfStart);
      const endTimestamp = new Date().toISOString();

      console.log("================================================================================");
      console.log(`Phase 48M Live Trial Complete in ${perfDurationMs} ms`);
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
        (s) => s.rejectionReason === "DISALLOWED_FILE_OVERWRITE"
      );
      const noopEditRejections = stepTranscript.filter(
        (s) => s.rejectionReason === "NOOP_EDIT_DISALLOWED"
      );
      const duplicateProposalRejections = stepTranscript.filter(
        (s) => s.rejectionReason === "DUPLICATE_PROPOSAL_DISALLOWED"
      );
      const repeatedFailedAnchorRejections = stepTranscript.filter(
        (s) => s.rejectionReason === "REPEATED_FAILED_ANCHOR_DISALLOWED"
      );
      const postPassMutationRejections = stepTranscript.filter(
        (s) => s.rejectionReason === "POST_VERIFICATION_MUTATION_DISALLOWED"
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
      const getErrorMessage = (err: unknown): string =>
        typeof err === "string" ? err : typeof (err as any)?.message === "string" ? (err as any).message : "";

      const anchorFailures = stepTranscript.filter((s) => {
        if (s.toolName !== "edit_file" || !s.executionError) return false;
        const msg = getErrorMessage(s.executionError);
        return (
          msg.includes("Search anchor not found") ||
          msg.includes("0 occurrences matched") ||
          msg.includes("searchAnchor") ||
          msg.includes("anchor")
        );
      });
      const ambiguousAnchors = stepTranscript.filter((s) => {
        if (s.toolName !== "edit_file" || !s.executionError) return false;
        const msg = getErrorMessage(s.executionError);
        return msg.includes("Multiple occurrences");
      });

      const anchorDetails = editFileAttempts.map((e) => {
        const payload = e.inputPayload as Record<string, unknown> | null;
        const anchor = typeof payload?.searchAnchor === "string" ? payload.searchAnchor : null;
        const replacement = typeof payload?.replacementText === "string" ? payload.replacementText : null;
        const isLineSelector = anchor ? /^line:\d+/i.test(anchor.trim()) : false;
        const isLiteralCode = anchor ? anchor.includes("return") || anchor.includes("function") || anchor.includes("+") : false;
        const isOversized = anchor ? anchor.split(/\r?\n/).filter((l) => l.trim().length > 0).length > 5 : false;
        return {
          step: e.stepNumber,
          proposalValid: e.proposalValid,
          rejectionReason: e.rejectionReason ?? null,
          anchor,
          replacement,
          isLineSelector,
          isLiteralCode,
          isOversized,
          executionStatus: e.actionStatus ?? null,
          executionError: getErrorMessage(e.executionError) || null,
        };
      });

      // Latch snapshot analysis
      const latchSnapshot = result.diagnostics.postPassLatchSnapshot;
      const isLatchActivated = latchSnapshot?.isLatched === true;
      const latchedProtectedPaths = latchSnapshot?.protectedPaths ?? [];

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

      // Conservative outcome classification
      let classification: "VERIFIED_REPAIR" | "SAFE_TERMINATION_WITHOUT_REPAIR" | "REPAIR_ATTEMPT_FAILED" | "EXPERIMENT_INVALID_INCONCLUSIVE";
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
        !unrelatedFilesChanged &&
        result.terminalStatus === "COMPLETED"
      ) {
        classification = "VERIFIED_REPAIR";
      } else if (
        !targetFileModified ||
        (isLatchActivated && !unrelatedFilesChanged && !candidateMatchesGold) ||
        (postPassMutationRejections.length > 0 && !candidateMatchesGold)
      ) {
        classification = "SAFE_TERMINATION_WITHOUT_REPAIR";
      } else {
        classification = "REPAIR_FAILED";
      }

      // Check whether duplicate proposal was submitted and whether it was blocked before adapter
      const repeatedProposalSubmitted = duplicateProposalRejections.length > 0;
      const duplicateBlockedBeforeAdapter = duplicateProposalRejections.every(
        (r) => (r as any).actionId === undefined
      );

      // Assemble Trial Record
      const trialRecord = {
        phase: "Phase 48M",
        task: "EAF-BM-01",
        taskTitle: task.title,
        classification,
        model: {
          name: "qwen2.5-coder:3b",
          digest: "f72c60cabf6237b07f6e632b2c48d533cef25eda2efbd34bed21c5e9c01e6225",
          parameters: "3.1B",
          quantization: "Q4_K_M",
          format: "gguf",
          endpoint: "http://127.0.0.1:11434",
        },
        timing: {
          startedAt: startTimestamp,
          completedAt: endTimestamp,
          wallClockDurationMs: perfDurationMs,
          preWarmDurationMs: warmDuration,
        },
        configuration: {
          governedBenchmarkRepairMode: true,
          allowWholeFileReplacement: false,
          maxSteps: 8,
          stepTimeoutMs: 300000,
          maxWallClockMs: 2400000,
          maxProposalRejections: 3,
          maxConsecutiveIneffectiveEdits: 3,
          dynamicToolFiltering: true,
          intermediateTestFeedback: true,
          postPassVerificationLatch: true,
          sourceGroundedVerificationContext: true,
          failedAnchorGuard: true,
          zeroMatchSearchRecovery: true,
          wholeFileNoOpGuidance: true,
          duplicateProposalGuard: true,
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
          postPassLatchSnapshot: latchSnapshot ?? null,
        },
        postPassLatchTelemetry: {
          isLatched: isLatchActivated,
          latchedAtStep: latchSnapshot?.activationStep ?? null,
          latchedTimestamp: latchSnapshot?.activationTimestamp ?? null,
          protectedPaths: latchedProtectedPaths,
          cleanRoomVerified: latchSnapshot?.cleanRoomVerified ?? false,
          postPassMutationProposalsCount: postPassMutationRejections.length,
          postPassMutationRejectionsCount: postPassMutationRejections.length,
          postPassRejectionDenials: postPassMutationRejections.map((r) => ({
            step: r.stepNumber,
            toolName: r.toolName,
            reason: r.rejectionReason,
            message: r.rejectionMessage,
          })),
        },
        governedEditingTelemetry: {
          editFileAttemptsCount: editFileAttempts.length,
          editFileAcceptedCount: editFileAccepted.length,
          editFileRejectedCount: editFileRejected.length,
          noopEditRejectionsCount: noopEditRejections.length,
          duplicateProposalRejectionsCount: duplicateProposalRejections.length,
          repeatedFailedAnchorRejectionsCount: repeatedFailedAnchorRejections.length,
          repeatedProposalSubmitted,
          duplicateBlockedBeforeAdapter,
          writeFileAttemptsCount: writeFileAttempts.length,
          writeFileExistingDenialsCount: writeFileExistingDenials.length,
          writeFileNewAllowedCount: writeFileNewAllowed.length,
          disallowedFileOverwriteDenials: overwriteRejections.map((r) => ({
            step: r.stepNumber,
            toolName: r.toolName,
            reason: r.rejectionReason,
            message: r.rejectionMessage,
          })),
          noopEditDenials: noopEditRejections.map((r) => ({
            step: r.stepNumber,
            toolName: r.toolName,
            reason: r.rejectionReason,
            message: r.rejectionMessage,
          })),
          duplicateProposalDenials: duplicateProposalRejections.map((r) => ({
            step: r.stepNumber,
            toolName: r.toolName,
            reason: r.rejectionReason,
            message: r.rejectionMessage,
          })),
          repeatedFailedAnchorDenials: repeatedFailedAnchorRejections.map((r) => ({
            step: r.stepNumber,
            toolName: r.toolName,
            reason: r.rejectionReason,
            message: r.rejectionMessage,
          })),
          anchorFailuresCount: anchorFailures.length,
          ambiguousAnchorsCount: ambiguousAnchors.length,
          anchorDetails,
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
        stepTranscript,
      };

      // Write trial record to disk
      await fs.writeFile(RECORD_PATH, JSON.stringify(trialRecord, null, 2), "utf8");
      console.log(`Phase 48M trial results successfully recorded at: ${RECORD_PATH}`);

      // Basic sanity assertions
      expect(result.evidenceBundle).toBeDefined();
      expect(result.evidenceBundle.signatures.length).toBeGreaterThanOrEqual(2);
      expect(independentAudit.status).toBe("VERIFIED");
    },
    2400000 // 40 minute vitest timeout
  );
});
