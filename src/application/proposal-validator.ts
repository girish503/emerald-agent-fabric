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
    // Stage 10: Resource Ceiling Bounds Check
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
