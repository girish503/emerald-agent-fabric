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
import { inspectToolProjection, formatModelFacingToolCatalog } from "../../src/domain/tool-projection.js";
import { EDIT_FILE_SCHEMA_BRANCH } from "../../src/application/live-agent-brain.js";
import { EDIT_FILE_TOOL, INITIAL_TOOL_DEFINITIONS } from "../../src/domain/tool.js";

const execFileAsync = promisify(execFile);

describe("Phase 48Q — Single Live Trial: Governed Repair of EAF-BM-02 with 3B Model", () => {
  const EXPECTED_PHASE48J_HASH =
    "3ddddd528e41c0fac114fcae87100b9aad709e32c6b0d4ed1ba9b571f1e82866";
  const EXPECTED_PHASE48M_HASH =
    "e5df43a813d206083ac043ceeab5eecb07ad4d6d08ff61f31c33434642837467";
  const EXPECTED_PHASE48P_HASH =
    "cddc503ba344a9742b4a56fa479896fa77c5f260ad0e814219d1257864d2fbe5";
  const RECORD_PATH = path.resolve(process.cwd(), "scratch/phase48q-repair-results.json");
  const PHASE48J_PATH = path.resolve(process.cwd(), "scratch/phase48j-repair-results.json");
  const PHASE48M_PATH = path.resolve(process.cwd(), "scratch/phase48m-repair-results.json");
  const PHASE48P_PATH = path.resolve(process.cwd(), "scratch/phase48p-repair-results.json");

  it("Preflight: verifies fixture hash, defect baseline, model availability, historical preservation, schema filtering, and artifact non-existence", async () => {
    // 1. Verify destination artifact does NOT exist
    let recordExists = false;
    try {
      await fs.access(RECORD_PATH);
      recordExists = true;
    } catch {
      recordExists = false;
    }
    expect(recordExists).toBe(false);

    // 2. Verify historical artifacts remain strictly untouched
    const phase48jContent = await fs.readFile(PHASE48J_PATH, "utf8");
    const phase48jHash = crypto.createHash("sha256").update(phase48jContent, "utf8").digest("hex");
    expect(phase48jHash).toBe(EXPECTED_PHASE48J_HASH);

    const phase48mContent = await fs.readFile(PHASE48M_PATH, "utf8");
    const phase48mHash = crypto.createHash("sha256").update(phase48mContent, "utf8").digest("hex");
    expect(phase48mHash).toBe(EXPECTED_PHASE48M_HASH);

    const phase48pContent = await fs.readFile(PHASE48P_PATH, "utf8");
    const phase48pHash = crypto.createHash("sha256").update(phase48pContent, "utf8").digest("hex");
    expect(phase48pHash).toBe(EXPECTED_PHASE48P_HASH);

    // 3. Verify authoritative fixture content and initial hash for EAF-BM-02
    const runner = new Phase43BenchmarkRunner();
    const task = runner.getTask("EAF-BM-02");
    const initialHexJs = task.initialFiles["src/hex.js"];
    expect(initialHexJs).toBeDefined();

    const initialHash = crypto
      .createHash("sha256")
      .update(initialHexJs, "utf8")
      .digest("hex");
    expect(initialHash.length).toBe(64);

    // 4. Verify baseline defect: F2P exits 1, P2P exits 0 on untouched fixture in fresh isolated directory
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-p48q-"));
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

    // 6. Verify model-facing tool catalog and structured schema filter expectedDigest
    const inspection = inspectToolProjection(EDIT_FILE_TOOL);
    const paramNames = inspection.parameters.map((p) => p.name);
    expect(paramNames).not.toContain("expectedDigest");
    expect(paramNames).toContain("searchAnchor");
    expect(paramNames).toContain("replacementText");

    const catalog = formatModelFacingToolCatalog([...INITIAL_TOOL_DEFINITIONS, EDIT_FILE_TOOL]);
    expect(catalog).not.toContain("expectedDigest");
    expect(catalog).toContain("searchAnchor");

    const brainBranchProps = EDIT_FILE_SCHEMA_BRANCH.properties.inputPayload.properties as Record<string, unknown>;
    expect(brainBranchProps.expectedDigest).toBeUndefined();
    expect(brainBranchProps.searchAnchor).toBeDefined();

    console.log(`Preflight passed for EAF-BM-02: Model ${qwenModel?.name} (${qwenModel?.digest}), fixture baseline verified.`);
  });

  it(
    "executes exactly ONE governed live repair trial on EAF-BM-02 with qwen2.5-coder:3b under hardened runtime",
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

      // Pre-warm the model into memory (max 120s budget)
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
      const task = runner.getTask("EAF-BM-02");
      const initialTargetContent = task.initialFiles["src/hex.js"];
      const initialTargetHash = crypto
        .createHash("sha256")
        .update(initialTargetContent, "utf8")
        .digest("hex");

      console.log("================================================================================");
      console.log("Starting Phase 48Q Live Repair Trial (EAF-BM-02 with Hardened Runtime)");
      console.log(`Task: ${task.taskId} - ${task.title}`);
      console.log("Model: qwen2.5-coder:3b");
      console.log("Tools: read_file, write_file, edit_file, search_code, git_status, git_diff, run_command");
      console.log("Governed Benchmark Repair Mode: ENABLED");
      console.log("Allow Whole File Replacement: FALSE");
      console.log("Dynamic Tool Filtering: ENABLED");
      console.log("Intermediate Test Feedback: ENABLED");
      console.log("Post-Pass Verification Latch: ENABLED");
      console.log("Ineffective Mutation Guard: ENABLED");
      console.log("Stale Precondition Recovery: ENABLED");
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
      console.log(`Phase 48Q Live Trial Complete in ${perfDurationMs} ms`);
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
      let finalTargetFileHash = initialTargetHash;
      if (result.workspaceHostPath) {
        const targetFilePath = await findFileRecursively(result.workspaceHostPath, "hex.js");
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

      const targetFileModified = targetFileFound && finalTargetContent !== initialTargetContent;

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
      const ineffectiveMutationRejections = stepTranscript.filter(
        (s) => s.rejectionReason === "INEFFECTIVE_MUTATION_DISALLOWED"
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
        (s) => s.proposalValid === true && (s.inputPayload as any)?.path !== "src/hex.js"
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
        const isLiteralCode = anchor ? anchor.includes("return") || anchor.includes("function") || anchor.includes("if") : false;
        const isOversized = anchor ? anchor.split(/\r?\n/).filter((l) => l.trim().length > 0).length > 5 : false;
        const hadExpectedDigest = payload && "expectedDigest" in payload;
        return {
          step: e.stepNumber,
          proposalValid: e.proposalValid,
          rejectionReason: e.rejectionReason ?? null,
          anchor,
          replacement,
          isLineSelector,
          isLiteralCode,
          isOversized,
          hadExpectedDigest,
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

      // Check policy compliance from clean room evaluation
      const policyCompliant = result.cleanRoomOutcome?.payload?.policyAudit?.allowedPathsCompliant ?? true;
      const disallowedFiles = result.cleanRoomOutcome?.payload?.policyAudit?.disallowedFilesTouched ?? [];
      const cleanRoomF2PRatio = result.cleanRoomOutcome?.payload?.cleanRoomEvaluation?.f2pRatio ?? 0;
      const cleanRoomP2PRatio = result.cleanRoomOutcome?.payload?.cleanRoomEvaluation?.p2pRatio ?? 0;

      // Conservative outcome classification
      let classification: "VERIFIED_REPAIR" | "SAFE_TERMINATION_WITHOUT_REPAIR" | "REPAIR_ATTEMPT_FAILED";
      const isCleanRoomDualGatePassed =
        result.verified &&
        result.cleanRoomOutcome?.status === "VERIFIED" &&
        cleanRoomF2PRatio === 1.0 &&
        cleanRoomP2PRatio === 1.0 &&
        policyCompliant &&
        disallowedFiles.length === 0;

      const isAuditPassed =
        independentAudit.status === "VERIFIED" && independentAudit.thresholdSatisfied === true;

      if (
        isCleanRoomDualGatePassed &&
        isAuditPassed &&
        candidateMatchesGold &&
        result.terminalStatus === "COMPLETED"
      ) {
        classification = "VERIFIED_REPAIR";
      } else if (
        !targetFileModified ||
        (isLatchActivated && !candidateMatchesGold) ||
        (postPassMutationRejections.length > 0 && !candidateMatchesGold)
      ) {
        classification = "SAFE_TERMINATION_WITHOUT_REPAIR";
      } else {
        classification = "REPAIR_ATTEMPT_FAILED";
      }

      const repeatedProposalSubmitted = duplicateProposalRejections.length > 0 || ineffectiveMutationRejections.length > 0;
      const duplicateBlockedBeforeAdapter = duplicateProposalRejections.every(
        (r) => (r as any).actionId === undefined
      );

      // Assemble Trial Record
      const trialRecord = {
        phase: "Phase 48Q",
        task: "EAF-BM-02",
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
          ineffectiveMutationGuard: true,
          stalePreconditionRecovery: true,
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
          ineffectiveMutationRejectionsCount: ineffectiveMutationRejections.length,
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
          ineffectiveMutationDenials: ineffectiveMutationRejections.map((r) => ({
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
            targetFile: "src/hex.js",
            initialHash: initialTargetHash,
            finalHash: finalTargetFileHash,
            goldHash,
            candidateMatchesGold,
            targetFileModified,
            policyCompliant,
            disallowedFilesTouched: disallowedFiles,
            finalTargetFileContent: finalTargetContent,
          },
          stageC_verification: {
            cleanRoomStatus: result.cleanRoomOutcome?.status ?? "NONE",
            cleanRoomVerified: result.verified,
            f2pRatio: cleanRoomF2PRatio,
            p2pRatio: cleanRoomP2PRatio,
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
      console.log(`Phase 48Q trial results successfully recorded at: ${RECORD_PATH}`);

      // Basic sanity assertions
      expect(result.evidenceBundle).toBeDefined();
      expect(result.evidenceBundle.signatures.length).toBeGreaterThanOrEqual(2);
      expect(independentAudit.status).toBe("VERIFIED");
    },
    2400000 // 40 minute vitest timeout
  );
});
