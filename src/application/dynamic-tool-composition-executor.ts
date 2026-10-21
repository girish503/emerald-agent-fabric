/**
 * Phase 87 — Governed Dynamic Tool Composition Executor
 *
 * Sequential multi-stage pipeline execution engine for dynamic tools:
 * - Strict lifecycle state machine transitions
 * - Cumulative resource budget tracking & amplification defense
 * - Stage boundary sanitization and authority stripping
 * - Mid-pipeline revocation and expiration fencing
 * - Immutable provenance chain assembly
 * - Subordinate authority: strictly UNTRUSTED OBSERVATION
 */

import { canonicalJsonStringify, sha256Hex, containsUnredactedSecrets } from "../domain/canonical-hash.js";
import {
  CompositionLifecycleState,
  CompositionExecutionStatus,
  ToolCompositionSpec,
  CompositionExecutionResult,
  StageExecutionRecord,
  ToolDataTransfer,
  DEFAULT_COMPOSITION_RESOURCE_LIMITS,
  CompositionResourceLimits,
} from "../domain/dynamic-tool-composition.js";
import { computeDynamicToolIdentity } from "../domain/dynamic-tool.js";
import { DynamicToolRegistry } from "./dynamic-tool-registry.js";
import { DynamicToolExecutor } from "./dynamic-tool-executor.js";
import { DynamicToolCompositionPolicy, WorkflowAuthorityContext } from "./dynamic-tool-composition-policy.js";
import { DynamicToolProvenanceEngine } from "./dynamic-tool-provenance.js";

export interface PipelineExecutionOptions {
  readonly initialInput: Record<string, unknown>;
  readonly targetWorkspace: string;
  readonly targetRepositories: readonly string[];
  readonly workflowContext: WorkflowAuthorityContext;
}

export class DynamicToolCompositionExecutor {
  private readonly registry: DynamicToolRegistry;
  private readonly executor: DynamicToolExecutor;
  private readonly policy: DynamicToolCompositionPolicy;
  private readonly provenanceEngine: DynamicToolProvenanceEngine;
  private readonly limits: CompositionResourceLimits;

  private lifecycleStates = new Map<string, CompositionLifecycleState>();

  constructor(
    registry: DynamicToolRegistry,
    executor: DynamicToolExecutor,
    policy?: DynamicToolCompositionPolicy,
    provenanceEngine?: DynamicToolProvenanceEngine,
    customLimits?: Partial<CompositionResourceLimits>
  ) {
    this.registry = registry;
    this.executor = executor;
    this.policy = policy || new DynamicToolCompositionPolicy(registry);
    this.provenanceEngine = provenanceEngine || new DynamicToolProvenanceEngine();
    this.limits = {
      ...DEFAULT_COMPOSITION_RESOURCE_LIMITS,
      ...(customLimits || {}),
    };
  }

  public getCompositionState(compositionId: string): CompositionLifecycleState {
    return this.lifecycleStates.get(compositionId) || "PROPOSED";
  }

  public async executeComposition(
    spec: ToolCompositionSpec,
    options: PipelineExecutionOptions
  ): Promise<CompositionExecutionResult> {
    const startTime = Date.now();
    const compositionId = spec.compositionId;

    this.lifecycleStates.set(compositionId, "PROPOSED");

    // 1. Validation & Policy Gate
    this.lifecycleStates.set(compositionId, "VALIDATING");
    const valReport = this.policy.validateComposition(spec, options.workflowContext);

    if (!valReport.valid) {
      this.lifecycleStates.set(compositionId, "PIPELINE_ABORTED");
      return this.createErrorResult(
        compositionId,
        spec.workflowId,
        "FAILED",
        startTime,
        0,
        spec.stages.length,
        [],
        [],
        0,
        0,
        `Composition validation failed: ${valReport.diagnostics.join("; ")}`
      );
    }

    this.lifecycleStates.set(compositionId, "AUTHORIZED");

    // 2. Sequential Execution Setup
    const stageRecords: StageExecutionRecord[] = [];
    const transfers: ToolDataTransfer[] = [];

    let currentInput: Record<string, unknown> = { ...options.initialInput };
    let previousToolId: string | undefined = undefined;
    let previousOutput: unknown = undefined;

    let cumulativeInputBytes = Buffer.byteLength(canonicalJsonStringify(currentInput), "utf8");
    let cumulativeOutputBytes = 0;
    let invocationsCount = 0;
    let isAborted = false;
    let abortReason: string | undefined = undefined;

    for (const stage of spec.stages) {
      this.lifecycleStates.set(compositionId, "STAGE_READY");

      // Check cumulative timeout
      const elapsedMs = Date.now() - startTime;
      if (elapsedMs >= this.limits.maxExecutionMs) {
        isAborted = true;
        abortReason = `COMPOSITION_RESOURCE_LIMIT_EXCEEDED: Cumulative timeout (${elapsedMs}ms >= ${this.limits.maxExecutionMs}ms).`;
        break;
      }

      // Check cumulative invocations limit
      invocationsCount++;
      if (invocationsCount > this.limits.maxInvocations) {
        isAborted = true;
        abortReason = `COMPOSITION_RESOURCE_LIMIT_EXCEEDED: Max invocations exceeded (${invocationsCount} > ${this.limits.maxInvocations}).`;
        break;
      }

      // Check mid-pipeline revocation or expiration of tool
      const toolRec = this.registry.getTool(stage.toolId);
      if (!toolRec || toolRec.state === "REVOKED") {
        this.lifecycleStates.set(compositionId, "REVOKED");
        isAborted = true;
        abortReason = `Tool '${stage.toolId}' is REVOKED. Execution rejected.`;
        break;
      }
      if (toolRec.state === "EXPIRED") {
        this.lifecycleStates.set(compositionId, "EXPIRED");
        isAborted = true;
        abortReason = `Tool '${stage.toolId}' is EXPIRED. Execution rejected.`;
        break;
      }
      if (toolRec.state === "QUARANTINED") {
        this.lifecycleStates.set(compositionId, "QUARANTINED");
        isAborted = true;
        abortReason = `Tool '${stage.toolId}' is QUARANTINED. Execution rejected.`;
        break;
      }

      // Check stage input size
      const stageInputBytes = Buffer.byteLength(canonicalJsonStringify(currentInput), "utf8");
      if (stageInputBytes > this.limits.maxStageInputBytes) {
        isAborted = true;
        abortReason = `COMPOSITION_RESOURCE_LIMIT_EXCEEDED: Stage input size (${stageInputBytes} bytes) exceeds limit (${this.limits.maxStageInputBytes} bytes).`;
        break;
      }

      // Stage boundary sanitization of input:
      // Strip path traversal, secrets, or authority fields
      if (containsUnredactedSecrets(currentInput)) {
        isAborted = true;
        abortReason = "SECURITY_DENIED: Unredacted secret detected in stage input.";
        break;
      }

      // Record Data Transfer if preceded by a stage
      if (previousToolId !== undefined) {
        const transfer = this.provenanceEngine.createDataTransfer(
          compositionId,
          previousToolId,
          stage.toolId,
          previousOutput,
          currentInput
        );
        transfers.push(transfer);
      }

      this.lifecycleStates.set(compositionId, "EXECUTING_STAGE");

      const toolIdentity = computeDynamicToolIdentity(toolRec.spec);
      const stageStartTime = Date.now();

      // Execute tool using sandboxed executor
      const stageExecResult = await this.executor.executeTool(stage.toolId, {
        executionId: `exec-${compositionId}-stage-${stage.stageId}`,
        workflowId: spec.workflowId,
        callerIdentity: `composition-${compositionId}`,
        targetWorkspace: stage.workspaceScopes[0] || options.targetWorkspace,
        targetRepositories: stage.repositoryScopes.length > 0 ? stage.repositoryScopes : options.targetRepositories,
        input: currentInput,
        timeoutMs: stage.timeoutMs,
      });

      const stageDurationMs = Math.max(1, Date.now() - stageStartTime);

      // Sanitize stage output
      let sanitizedStageOutput = stageExecResult.output;
      if (typeof sanitizedStageOutput === "object" && sanitizedStageOutput !== null) {
        const copy = { ...(sanitizedStageOutput as Record<string, unknown>) };
        delete copy.authoritative;
        delete copy.policyApproval;
        delete copy.terminalAuthority;
        delete copy.terminalSuccess;
        delete copy.verificationAuthority;
        delete copy.bypassVerification;
        delete copy.missionContract;
        delete copy.credentials;
        sanitizedStageOutput = copy;
      }

      const stageOutputBytes = Buffer.byteLength(canonicalJsonStringify(sanitizedStageOutput), "utf8");
      cumulativeOutputBytes += stageOutputBytes;

      const stageRecordWithoutDigest = {
        stageId: stage.stageId,
        sequenceNumber: stage.sequenceNumber,
        toolId: stage.toolId,
        toolIdentity,
        status: stageExecResult.status === "SUCCESS" ? ("SUCCESS" as const) : ("FAILED" as const),
        durationMs: stageDurationMs,
        inputDigest: stageExecResult.inputDigest,
        outputDigest: stageExecResult.outputDigest,
        output: sanitizedStageOutput,
        error: stageExecResult.error,
      };

      const stageEvidenceDigest = this.provenanceEngine.computeStageEvidenceDigest(stageRecordWithoutDigest);
      const fullStageRecord: StageExecutionRecord = {
        ...stageRecordWithoutDigest,
        stageEvidenceDigest,
      };
      stageRecords.push(fullStageRecord);

      // Cumulative amplification defense:
      if (cumulativeOutputBytes > this.limits.maxCompositionContextBytes) {
        this.lifecycleStates.set(compositionId, "PIPELINE_ABORTING");
        isAborted = true;
        abortReason = `COMPOSITION_RESOURCE_LIMIT_EXCEEDED: Cumulative output bytes (${cumulativeOutputBytes}) exceeds composition context budget (${this.limits.maxCompositionContextBytes}).`;
        break;
      }

      if (stageExecResult.status !== "SUCCESS") {
        this.lifecycleStates.set(compositionId, "STAGE_FAILED");

        if (stage.failurePolicy === "FAIL_FAST" || stage.failurePolicy === "REQUIRED_STAGE") {
          isAborted = true;
          abortReason = `Stage '${stage.stageId}' failed under policy '${stage.failurePolicy}': ${stageExecResult.error}`;
          break;
        } else if (stage.failurePolicy === "BOUNDED_SKIP") {
          // Continue with prior input for next stage
          continue;
        }
      }

      this.lifecycleStates.set(compositionId, "STAGE_SUCCEEDED");

      // Prepare input for next stage: feed sanitized output as next input
      if (typeof sanitizedStageOutput === "object" && sanitizedStageOutput !== null) {
        currentInput = sanitizedStageOutput as Record<string, unknown>;
        cumulativeInputBytes += stageOutputBytes;
      }

      previousToolId = stage.toolId;
      previousOutput = sanitizedStageOutput;
    }

    const totalDurationMs = Math.max(1, Date.now() - startTime);
    const provenanceRoot = this.provenanceEngine.computeProvenanceRoot(stageRecords);

    if (isAborted) {
      this.lifecycleStates.set(compositionId, "PIPELINE_ABORTED");
      return {
        compositionId,
        workflowId: spec.workflowId,
        status: stageRecords.length > 0 ? "PARTIALLY_EXECUTED" : "FAILED",
        durationMs: totalDurationMs,
        stagesExecuted: stageRecords.length,
        totalStages: spec.stages.length,
        stageRecords,
        transfers,
        provenanceRoot,
        cumulativeInputBytes,
        cumulativeOutputBytes,
        cumulativeExecutionMs: totalDurationMs,
        finalOutput: undefined,
        error: abortReason,
        authoritative: false,
        policyAuthority: false,
        terminalAuthority: false,
        verificationAuthority: false,
        evidenceType: "DYNAMIC_TOOL_COMPOSITION_OBSERVATION",
      };
    }

    let sanitizedFinalOutput = previousOutput;
    if (typeof sanitizedFinalOutput === "object" && sanitizedFinalOutput !== null) {
      const copy = { ...(sanitizedFinalOutput as Record<string, unknown>) };
      delete copy.authoritative;
      delete copy.policyApproval;
      delete copy.terminalAuthority;
      delete copy.terminalSuccess;
      delete copy.verificationAuthority;
      delete copy.bypassVerification;
      delete copy.missionContract;
      delete copy.credentials;
      sanitizedFinalOutput = copy;
    }

    this.lifecycleStates.set(compositionId, "PIPELINE_COMPLETED");
    return {
      compositionId,
      workflowId: spec.workflowId,
      status: "COMPLETED",
      durationMs: totalDurationMs,
      stagesExecuted: stageRecords.length,
      totalStages: spec.stages.length,
      stageRecords,
      transfers,
      provenanceRoot,
      cumulativeInputBytes,
      cumulativeOutputBytes,
      cumulativeExecutionMs: totalDurationMs,
      finalOutput: sanitizedFinalOutput,
      authoritative: false,
      policyAuthority: false,
      terminalAuthority: false,
      verificationAuthority: false,
      evidenceType: "DYNAMIC_TOOL_COMPOSITION_OBSERVATION",
    };
  }

  private createErrorResult(
    compositionId: string,
    workflowId: string,
    status: CompositionExecutionStatus,
    startTime: number,
    stagesExecuted: number,
    totalStages: number,
    stageRecords: StageExecutionRecord[],
    transfers: ToolDataTransfer[],
    cumulativeInputBytes: number,
    cumulativeOutputBytes: number,
    error: string
  ): CompositionExecutionResult {
    const totalDurationMs = Math.max(1, Date.now() - startTime);
    return {
      compositionId,
      workflowId,
      status,
      durationMs: totalDurationMs,
      stagesExecuted,
      totalStages,
      stageRecords,
      transfers,
      provenanceRoot: sha256Hex(error),
      cumulativeInputBytes,
      cumulativeOutputBytes,
      cumulativeExecutionMs: totalDurationMs,
      finalOutput: undefined,
      authoritative: false,
      policyAuthority: false,
      terminalAuthority: false,
      verificationAuthority: false,
      evidenceType: "DYNAMIC_TOOL_COMPOSITION_OBSERVATION",
    };
  }
}
