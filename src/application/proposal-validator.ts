/**
 * Governed Action Proposal Validator for Emerald Agent Fabric.
 *
 * Implements the unskippable trust boundary between an untrusted Agent Brain
 * and the authoritative Action domain.
 *
 * Architectural Invariants:
 * 1. Model output is strictly UNTRUSTED.
 * 2. Complete Pipeline: Enforces payload size, schema conformance, forbidden authority fields,
 *    context hash matching, run active status, lease fencing, contract integrity, tool registration,
 *    capability authorization, tool input schemas, and resource ceilings.
 * 3. Zero Provider Execution: Neither tool adapters nor execution providers are ever touched (providerInvocationCount === 0).
 * 4. Zero Direct Mutation: Validating or rejecting a proposal never mutates Actions or Attempts in the database.
 * 5. Authoritative Action Instantiation: Converts validated proposals into Action aggregates with
 *    authoritative runId, sequenceNumber, contractBinding, and maxAttempts.
 */

import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ActionProposalSchema,
  ALLOWED_PROPOSAL_KEYS,
  findForbiddenAuthorityKeys,
  MAX_PROPOSAL_BYTES,
  MAX_RATIONALE_LENGTH,
  ProposalValidationResult,
  ProposalValidationSuccess,
} from "../domain/action-proposal.js";
import { Action } from "../domain/action.js";
import { canonicalJsonStringify } from "../domain/canonical-hash.js";
import { ContextSnapshot } from "../domain/context.js";
import { ActionProposalRejectedError } from "../domain/errors.js";
import { ActionCreatedEvent } from "../domain/events.js";
import { RunSnapshot } from "../domain/invariants.js";
import { MissionContract } from "../domain/mission-contract.js";
import { PolicyEvaluator } from "../domain/policy.js";
import { staticToolRegistry } from "../domain/tool.js";
import { ClockPort, SystemClock } from "../ports/clock.port.js";
import { MissionContractStorePort } from "../ports/mission-contract-store.port.js";
import { StateStorePort } from "../ports/state-store.port.js";
import { ToolRegistryPort } from "../ports/tool-registry.port.js";
import { RunCoordinator } from "./run-coordinator.js";
import { isOversizedWholeFileAnchor } from "./duplicate-proposal-detector.js";

export interface ProposalValidatorOptions {
  readonly toolRegistry?: ToolRegistryPort;
  readonly coordinator?: RunCoordinator;
  readonly stateStore?: StateStorePort;
  readonly contractStore?: MissionContractStorePort;
  readonly policyEvaluator?: PolicyEvaluator;
  readonly clock?: ClockPort;
}

export interface ProposalValidationContext {
  readonly runId: string;
  readonly contextSnapshot: ContextSnapshot;
  readonly workerId?: string;
  readonly leaseId?: string;
  readonly run?: RunSnapshot;
  readonly contract?: MissionContract;
  readonly workspaceHostPath?: string;
  readonly fileExistsChecker?: (relPath: string) => boolean;
  readonly fileContentReader?: (relPath: string) => string | null;
  readonly failedAnchorChecker?: (relPath: string, searchAnchor: string) => boolean;
  readonly duplicateProposalChecker?: (
    toolName: string,
    inputPayload: unknown
  ) => { isDuplicate: boolean; priorStep?: number; priorReason?: string } | boolean;
  readonly ineffectiveMutationChecker?: (
    toolName: string,
    inputPayload: unknown,
    targetPath?: string
  ) => { isIneffective: boolean; priorStep?: number; reason?: string } | boolean;
  readonly postPassMutationChecker?: (
    toolName: string,
    targetPath?: string
  ) => { prohibited: boolean; reason?: string } | boolean;
}

export interface CreateActionFromProposalOptions {
  readonly actionId?: string;
  readonly sequenceNumber?: number;
  readonly now?: string;
  readonly eventIdGenerator?: () => string;
}

export class ProposalValidator {
  private readonly toolRegistry: ToolRegistryPort;
  private readonly coordinator?: RunCoordinator;
  private readonly stateStore?: StateStorePort;
  private readonly contractStore?: MissionContractStorePort;
  private readonly policyEvaluator: PolicyEvaluator;
  private readonly clock: ClockPort;

  constructor(options: ProposalValidatorOptions = {}) {
    this.toolRegistry = options.toolRegistry ?? staticToolRegistry;
    this.coordinator = options.coordinator;
    this.stateStore = options.stateStore;
    this.contractStore = options.contractStore;
    this.policyEvaluator = options.policyEvaluator ?? new PolicyEvaluator();
    this.clock = options.clock ?? new SystemClock();
  }

  private getRun(runId: string): RunSnapshot | null {
    if (this.coordinator) {
      return this.coordinator.getRun(runId);
    }
    if (this.stateStore) {
      return this.stateStore.getRun(runId);
    }
    return null;
  }

  private getContract(contractId: string, version: number): MissionContract | null {
    if (this.coordinator) {
      return this.coordinator.getContract(contractId, version);
    }
    if (this.contractStore) {
      return this.contractStore.getContract(contractId, version);
    }
    if (this.stateStore) {
      return this.stateStore.getContract(contractId, version);
    }
    return null;
  }

  private getNextSequenceNumber(runId: string): number {
    if (this.stateStore) {
      const actions = this.stateStore.getActionsForRun(runId);
      return actions.length + 1;
    }
    return 1;
  }

  /**
   * Validates an untrusted proposal against the complete 11-stage governance pipeline.
   *
   * Pure inspection: creates zero files, executes zero tools, mutates zero database records.
   */
  validate(proposal: unknown, context: ProposalValidationContext): ProposalValidationResult {
    // ------------------------------------------------------------------------
    // Stage 1: Payload Size Ceilings
    // ------------------------------------------------------------------------
    let serialized: string;
    try {
      serialized = canonicalJsonStringify(proposal);
    } catch {
      return {
        valid: false,
        reason: "MALFORMED_PROPOSAL",
        message: "Proposal payload could not be serialized to canonical JSON.",
      };
    }

    const byteLength = Buffer.byteLength(serialized, "utf8");
    if (byteLength > MAX_PROPOSAL_BYTES) {
      return {
        valid: false,
        reason: "PROPOSAL_SIZE_EXCEEDED",
        message: `Proposal payload size (${byteLength} bytes) exceeds maximum limit of ${MAX_PROPOSAL_BYTES} bytes.`,
      };
    }

    // ------------------------------------------------------------------------
    // Stage 2: Structural Verification & Forbidden Authority Fields
    // ------------------------------------------------------------------------
    if (proposal === null || typeof proposal !== "object" || Array.isArray(proposal)) {
      return {
        valid: false,
        reason: "MALFORMED_PROPOSAL",
        message: "Proposal must be a valid non-null JSON object.",
      };
    }

    const forbiddenKeys = findForbiddenAuthorityKeys(proposal);
    if (forbiddenKeys.length > 0) {
      return {
        valid: false,
        reason: "FORBIDDEN_AUTHORITY_FIELD",
        message: `Proposal contains forbidden authority field(s): ${forbiddenKeys.join(", ")}. Models are strictly prohibited from specifying runtime authority.`,
        violations: forbiddenKeys,
      };
    }

    const topLevelKeys = Object.keys(proposal as Record<string, unknown>);
    const unauthorizedKeys = topLevelKeys.filter((k) => !ALLOWED_PROPOSAL_KEYS.has(k));
    if (unauthorizedKeys.length > 0) {
      return {
        valid: false,
        reason: "FORBIDDEN_AUTHORITY_FIELD",
        message: `Proposal contains unrecognized or unauthorized top-level field(s): ${unauthorizedKeys.join(", ")}.`,
        violations: unauthorizedKeys,
      };
    }

    // ------------------------------------------------------------------------
    // Stage 3: Schema Conformance & Bounds Validation
    // ------------------------------------------------------------------------
    const schemaResult = ActionProposalSchema.safeParse(proposal);
    if (!schemaResult.success) {
      const rawRationale = (proposal as Record<string, unknown>).rationale;
      if (typeof rawRationale === "string" && rawRationale.length > MAX_RATIONALE_LENGTH) {
        return {
          valid: false,
          reason: "RATIONALE_TOO_LONG",
          message: `Proposal rationale length (${rawRationale.length} characters) exceeds maximum limit of ${MAX_RATIONALE_LENGTH} characters.`,
          violations: [`rationale length ${rawRationale.length} > ${MAX_RATIONALE_LENGTH}`],
        };
      }

      return {
        valid: false,
        reason: "MALFORMED_PROPOSAL",
        message: `Proposal failed schema validation: ${schemaResult.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join(", ")}`,
        violations: schemaResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      };
    }

    const actionProposal = schemaResult.data;

    // ------------------------------------------------------------------------
    // Stage 4: Context Snapshot Hash Matching
    // ------------------------------------------------------------------------
    if (actionProposal.contextSnapshotHash !== context.contextSnapshot.contextHash) {
      return {
        valid: false,
        reason: "CONTEXT_HASH_MISMATCH",
        message: `Proposal context snapshot hash '${actionProposal.contextSnapshotHash}' does not match active ContextSnapshot hash '${context.contextSnapshot.contextHash}'. Proposal was generated against stale or invalid context.`,
      };
    }

    // ------------------------------------------------------------------------
    // Stage 5: Authoritative Run & Lease Fencing Check
    // ------------------------------------------------------------------------
    const run = context.run ?? this.getRun(context.runId);
    if (!run) {
      return {
        valid: false,
        reason: "RUN_NOT_ACTIVE",
        message: `Run '${context.runId}' not found in authoritative state store.`,
      };
    }

    const terminalStatuses: readonly string[] = ["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"];
    if (terminalStatuses.includes(run.status)) {
      return {
        valid: false,
        reason: "RUN_NOT_ACTIVE",
        message: `Run '${context.runId}' is in terminal status '${run.status}'. New action proposals cannot be accepted.`,
      };
    }

    if (run.status !== "RUNNING") {
      return {
        valid: false,
        reason: "RUN_NOT_ACTIVE",
        message: `Run '${context.runId}' is not in active RUNNING status (current status: '${run.status}').`,
      };
    }

    if (context.leaseId && run.leaseId !== context.leaseId) {
      return {
        valid: false,
        reason: "LEASE_INVALID",
        message: `Lease fencing failed for run '${context.runId}': expected active lease '${run.leaseId}', received '${context.leaseId}'.`,
      };
    }

    if (context.workerId && run.currentWorkerId !== null && run.currentWorkerId !== context.workerId) {
      return {
        valid: false,
        reason: "LEASE_INVALID",
        message: `Worker fencing failed for run '${context.runId}': run is claimed by worker '${run.currentWorkerId}', received '${context.workerId}'.`,
      };
    }

    // ------------------------------------------------------------------------
    // Stage 6: Authoritative Mission Contract Integrity & Lifecycle Status
    // ------------------------------------------------------------------------
    if (!run.contractBinding) {
      return {
        valid: false,
        reason: "CONTRACT_REVOKED",
        message: `Run '${context.runId}' does not have an active Mission Contract binding.`,
      };
    }

    const contract =
      context.contract ??
      this.getContract(run.contractBinding.contractId, run.contractBinding.version);
    if (!contract) {
      return {
        valid: false,
        reason: "CONTRACT_REVOKED",
        message: `Bound MissionContract '${run.contractBinding.contractId}' v${run.contractBinding.version} not found.`,
      };
    }

    if (contract.contentHash !== run.contractBinding.contentHash) {
      return {
        valid: false,
        reason: "CONTRACT_REVOKED",
        message: `Bound MissionContract content hash mismatch: expected '${run.contractBinding.contentHash}', got '${contract.contentHash}'. Contract has been tampered with or corrupted.`,
      };
    }

    if (contract.lifecycle.status !== "ACTIVE") {
      return {
        valid: false,
        reason: "CONTRACT_REVOKED",
        message: `Bound MissionContract '${contract.spec.contractId}' is not ACTIVE (current status: '${contract.lifecycle.status}', revocationReason: '${contract.lifecycle.revocationReason ?? "none"}').`,
      };
    }

    // ------------------------------------------------------------------------
    // Stage 7: Tool Registry Resolution
    // ------------------------------------------------------------------------
    const toolDef = this.toolRegistry.getTool(actionProposal.toolName);
    if (!toolDef) {
      return {
        valid: false,
        reason: "UNKNOWN_TOOL",
        message: `Tool '${actionProposal.toolName}' is not registered in ToolRegistry.`,
      };
    }

    // ------------------------------------------------------------------------
    // Stage 8: Capability Authorization & Policy Evaluation
    // ------------------------------------------------------------------------
    const requiredCapability = toolDef.requiredCapability;
    const policyDecision = this.policyEvaluator.evaluateCapability(requiredCapability, contract.spec.policy);
    if (!policyDecision.allowed) {
      return {
        valid: false,
        reason: "UNAUTHORIZED_CAPABILITY",
        message: `Capability '${requiredCapability}' required for tool '${actionProposal.toolName}' is denied under policy '${contract.spec.policy.policyId}'. Reason: ${policyDecision.reasonCode ?? "DENIED"}.`,
      };
    }

    // ------------------------------------------------------------------------
    // Stage 9: Tool Input Schema Validation
    // ------------------------------------------------------------------------
    const inputParseResult = toolDef.inputSchema.safeParse(actionProposal.inputPayload);
    if (!inputParseResult.success) {
      return {
        valid: false,
        reason: "INVALID_TOOL_INPUT",
        message: `Input payload for tool '${actionProposal.toolName}' failed schema validation: ${inputParseResult.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join(", ")}`,
        violations: inputParseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      };
    }

    const validatedInput = inputParseResult.data as Record<string, unknown>;

    // ------------------------------------------------------------------------
    // Stage 10: Path Traversal & Workspace Containment Checks
    // ------------------------------------------------------------------------
    const targetFilePath = typeof (validatedInput as any).path === "string"
      ? ((validatedInput as any).path as string).trim()
      : undefined;

    if (targetFilePath !== undefined && context.workspaceHostPath) {
      const normalizedHost = path.resolve(context.workspaceHostPath);
      const resolvedTarget = path.resolve(normalizedHost, targetFilePath);
      const rel = path.relative(normalizedHost, resolvedTarget);
      if (
        rel.startsWith("..") ||
        (path.isAbsolute(targetFilePath) && !resolvedTarget.startsWith(normalizedHost))
      ) {
        return {
          valid: false,
          reason: "INVALID_TOOL_INPUT",
          message: `Target path '${targetFilePath}' attempts to escape workspace boundary.`,
        };
      }
    }

    // ------------------------------------------------------------------------
    // Stage 10b: Governed Duplicate Rejected Proposal Prevention
    // ------------------------------------------------------------------------
    if (context.duplicateProposalChecker) {
      const dupCheck = context.duplicateProposalChecker(
        actionProposal.toolName,
        actionProposal.inputPayload ?? validatedInput
      );
      const isDup = typeof dupCheck === "boolean" ? dupCheck : dupCheck?.isDuplicate;
      if (isDup) {
        const priorInfo =
          typeof dupCheck === "object" && dupCheck.priorStep
            ? ` at step ${dupCheck.priorStep}${dupCheck.priorReason ? ` (${dupCheck.priorReason})` : ""}`
            : "";
        return {
          valid: false,
          reason: "DUPLICATE_PROPOSAL_DISALLOWED",
          message: `Proposal for tool '${actionProposal.toolName}' rejected: An identical proposal was already rejected${priorInfo} without any intervening successful actions or state changes. Propose a different action or modify input parameters.`,
        };
      }
    }

    // ------------------------------------------------------------------------
    // Stage 11: Governed File Mutation Policy Check (Protected Oracle Paths & Repair Mode)
    // ------------------------------------------------------------------------
    if (
      (actionProposal.toolName === "write_file" || actionProposal.toolName === "edit_file") &&
      targetFilePath !== undefined
    ) {
      const editFileDef = this.toolRegistry.getTool("edit_file");
      const editFileDecision = editFileDef
        ? this.policyEvaluator.evaluateCapability(editFileDef.requiredCapability, contract.spec.policy)
        : { allowed: false };
      const isEditFileAvailableAndAuthorized = Boolean(editFileDef && editFileDecision.allowed);

      let fileExists = false;
      if (context.fileExistsChecker) {
        fileExists = context.fileExistsChecker(targetFilePath);
      } else if (context.workspaceHostPath) {
        try {
          const normalizedHost = path.resolve(context.workspaceHostPath);
          const resolvedTarget = path.resolve(normalizedHost, targetFilePath);
          fileExists = fs.existsSync(resolvedTarget) && !fs.lstatSync(resolvedTarget).isDirectory();
        } catch {
          fileExists = false;
        }
      }

      const fileOpDecision = PolicyEvaluator.evaluateFileOperation(
        {
          toolName: actionProposal.toolName,
          path: targetFilePath,
          fileExists,
          isEditFileAvailableAndAuthorized,
        },
        contract.spec.policy
      );

      if (!fileOpDecision.allowed) {
        return {
          valid: false,
          reason: "DISALLOWED_FILE_OVERWRITE",
          message: fileOpDecision.message,
        };
      }
    }

    // ------------------------------------------------------------------------
    // Stage 11b: Governed Localized Editing Check (No-Op Edit Prevention)
    // ------------------------------------------------------------------------
    if (actionProposal.toolName === "edit_file") {
      const searchAnchor =
        typeof (validatedInput as any).searchAnchor === "string"
          ? ((validatedInput as any).searchAnchor as string)
          : undefined;
      const replacementText =
        typeof (validatedInput as any).replacementText === "string"
          ? ((validatedInput as any).replacementText as string)
          : undefined;

      if (
        searchAnchor !== undefined &&
        replacementText !== undefined &&
        searchAnchor === replacementText
      ) {
        const isOversized = isOversizedWholeFileAnchor(searchAnchor);
        return {
          valid: false,
          reason: "NOOP_EDIT_DISALLOWED",
          message: isOversized
            ? "edit_file proposal rejected: Entire file or oversized multi-declaration block was submitted as both 'searchAnchor' and 'replacementText'. A localized edit requires a small (1-3 line) searchAnchor around the bug and a distinct replacementText."
            : "edit_file proposal rejected: 'searchAnchor' and 'replacementText' are identical. A localized edit must specify a different 'replacementText' that modifies the target file.",
        };
      }

      // Stage 11c: Governed Localized Editing Check (Repeated Failed Anchor Prevention)
      const targetPath =
        typeof (validatedInput as any).path === "string"
          ? ((validatedInput as any).path as string)
          : undefined;

      if (
        targetPath !== undefined &&
        searchAnchor !== undefined &&
        context.failedAnchorChecker?.(targetPath, searchAnchor)
      ) {
        return {
          valid: false,
          reason: "REPEATED_FAILED_ANCHOR_DISALLOWED",
          message: `edit_file proposal rejected: The searchAnchor has already failed in '${targetPath}' (missing or ambiguous) and no fresh successful read of the file has occurred since the failure. Re-read the file using 'read_file' to obtain current literal source text before proposing edits.`,
        };
      }

      // Stage 11e: Governed Localized Editing Check (Whole-File Search Anchor Prevention)
      if (targetPath !== undefined && searchAnchor !== undefined) {
        let currentFileContent: string | null = null;
        if (context.fileContentReader) {
          currentFileContent = context.fileContentReader(targetPath);
        } else if (context.workspaceHostPath) {
          try {
            const normalizedHost = path.resolve(context.workspaceHostPath);
            const resolvedTarget = path.resolve(normalizedHost, targetPath);
            if (fs.existsSync(resolvedTarget) && !fs.lstatSync(resolvedTarget).isDirectory()) {
              currentFileContent = fs.readFileSync(resolvedTarget, "utf8");
            }
          } catch {
            currentFileContent = null;
          }
        }

        if (typeof currentFileContent === "string") {
          const trimmedAnchor = searchAnchor.trim();
          const trimmedFile = currentFileContent.trim();

          if (trimmedAnchor.length > 0 && trimmedAnchor === trimmedFile) {
            // Narrow, explicit small-file exception:
            // Files with <= 2 non-empty lines cannot be edited without matching the whole file content.
            const fileNonEmptyLines = trimmedFile.split(/\r?\n/).filter((l) => l.trim().length > 0);
            const isSmallFileException = fileNonEmptyLines.length <= 2;

            if (!isSmallFileException) {
              return {
                valid: false,
                reason: "WHOLE_FILE_ANCHOR_DISALLOWED",
                message: `edit_file proposal rejected: The searchAnchor spans the entire file content (${fileNonEmptyLines.length} lines) of '${targetPath}'. Governed benchmark repair requires localized edits (1-3 lines around the defect). Choose an exact snippet from the file containing only the specific lines needing modification.`,
              };
            }
          }
        }
      }
    }

    // ------------------------------------------------------------------------
    // Stage 11d: Post-Pass Verification Target Protection Check
    // ------------------------------------------------------------------------
    if (context.postPassMutationChecker) {
      const checkResult = context.postPassMutationChecker(actionProposal.toolName, targetFilePath);
      const isProhibited =
        typeof checkResult === "boolean" ? checkResult : checkResult?.prohibited;
      if (isProhibited) {
        const msg =
          typeof checkResult === "object" && checkResult?.reason
            ? checkResult.reason
            : `Proposal for tool '${actionProposal.toolName}' rejected: Target file '${targetFilePath ?? "unknown"}' has already passed verification tests and is protected by the post-pass verification latch. Further mutations to this verified file are disallowed to prevent regression. Propose verification tests or conclude the task with isGoalReached: true.`;
        return {
          valid: false,
          reason: "POST_VERIFICATION_MUTATION_DISALLOWED",
          message: msg,
        };
      }
    }

    // ------------------------------------------------------------------------
    // Stage 11e: Governed Ineffective Repeated File Mutation Prevention
    // ------------------------------------------------------------------------
    if (
      (actionProposal.toolName === "edit_file" || actionProposal.toolName === "write_file") &&
      context.ineffectiveMutationChecker
    ) {
      const ineffCheck = context.ineffectiveMutationChecker(
        actionProposal.toolName,
        actionProposal.inputPayload ?? validatedInput,
        targetFilePath
      );
      const isIneff = typeof ineffCheck === "boolean" ? ineffCheck : ineffCheck?.isIneffective;
      if (isIneff) {
        const priorInfo =
          typeof ineffCheck === "object" && ineffCheck.priorStep
            ? ` at step ${ineffCheck.priorStep}`
            : "";
        return {
          valid: false,
          reason: "INEFFECTIVE_MUTATION_DISALLOWED",
          message: `Proposal for tool '${actionProposal.toolName}' rejected: An identical mutation against '${targetFilePath ?? "target file"}' was already executed${priorInfo} and failed intermediate verification, and the target file state has not changed. Re-read the file with 'read_file', inspect the verification failure output, and propose a materially different localized edit.`,
        };
      }
    }

    // ------------------------------------------------------------------------
    // Stage 12: Resource Ceiling Bounds Check
    // ------------------------------------------------------------------------
    const resourceLimits = contract.spec.resourceLimits;

    // Check timeoutMs ceiling
    if (
      typeof (validatedInput as any).timeoutMs === "number" &&
      (validatedInput as any).timeoutMs > resourceLimits.timeoutMs
    ) {
      return {
        valid: false,
        reason: "RESOURCE_LIMIT_EXCEEDED",
        message: `Requested timeout (${(validatedInput as any).timeoutMs}ms) exceeds Mission Contract ceiling of ${resourceLimits.timeoutMs}ms.`,
      };
    }

    // Check maxOutputBytes ceiling
    if (
      typeof (validatedInput as any).maxOutputBytes === "number" &&
      (validatedInput as any).maxOutputBytes > resourceLimits.maxOutputBytes
    ) {
      return {
        valid: false,
        reason: "RESOURCE_LIMIT_EXCEEDED",
        message: `Requested maxOutputBytes (${(validatedInput as any).maxOutputBytes} bytes) exceeds Mission Contract ceiling of ${resourceLimits.maxOutputBytes} bytes.`,
      };
    }

    // Check maxBytes ceiling (e.g., write_file, git_diff, read_file)
    if (
      typeof (validatedInput as any).maxBytes === "number" &&
      (validatedInput as any).maxBytes > resourceLimits.maxOutputBytes
    ) {
      return {
        valid: false,
        reason: "RESOURCE_LIMIT_EXCEEDED",
        message: `Requested maxBytes (${(validatedInput as any).maxBytes} bytes) exceeds Mission Contract ceiling of ${resourceLimits.maxOutputBytes} bytes.`,
      };
    }

    // ------------------------------------------------------------------------
    // Stage 11: Success Decision Construction
    // ------------------------------------------------------------------------
    return {
      valid: true,
      proposal: Object.freeze({
        proposalId: actionProposal.proposalId,
        toolName: actionProposal.toolName,
        inputPayload: Object.freeze(validatedInput),
        contextSnapshotHash: actionProposal.contextSnapshotHash,
        ...(actionProposal.rationale !== undefined ? { rationale: actionProposal.rationale } : {}),
        ...(actionProposal.sequenceHint !== undefined ? { sequenceHint: actionProposal.sequenceHint } : {}),
      }),
      toolDefinition: toolDef,
      requiredCapability,
      contractBinding: run.contractBinding,
      maxAttempts: resourceLimits.maxAttempts,
    };
  }

  /**
   * Validates a proposal and returns the successful result, or throws ActionProposalRejectedError.
   */
  validateOrThrow(proposal: unknown, context: ProposalValidationContext): ProposalValidationSuccess {
    const result = this.validate(proposal, context);
    if (!result.valid) {
      throw new ActionProposalRejectedError(result.reason, result.message, result.violations);
    }
    return result;
  }

  /**
   * Transforms a validated proposal into an authoritative domain Action aggregate.
   *
   * Crucial guarantee: Model proposal does NOT dictate actionId, runId, sequenceNumber,
   * contractBinding, or maxAttempts. All are established authoritatively from the runtime.
   */
  createActionFromProposal(
    validated: ProposalValidationSuccess,
    run: RunSnapshot,
    options: CreateActionFromProposalOptions = {}
  ): { action: Action; event: ActionCreatedEvent } {
    if (!run.contractBinding) {
      throw new ActionProposalRejectedError(
        "CONTRACT_REVOKED",
        `Cannot create Action: Run '${run.runId}' has no bound Mission Contract.`
      );
    }

    const sequenceNumber = options.sequenceNumber ?? this.getNextSequenceNumber(run.runId);
    const actionId = options.actionId ?? crypto.randomUUID();
    const now = options.now ?? this.clock.nowIso();

    return Action.create(
      {
        actionId,
        runId: run.runId,
        sequenceNumber,
        toolName: validated.proposal.toolName,
        inputPayload: validated.proposal.inputPayload,
        contractBinding: run.contractBinding,
        maxAttempts: validated.maxAttempts,
        now,
      },
      options.eventIdGenerator
    );
  }
}
