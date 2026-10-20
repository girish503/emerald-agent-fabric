/**
 * Phase 86 — Governed Dynamic Tool Registry
 *
 * Governed lifecycle management, cryptographic identity registration,
 * status transitions, revocation, quarantine, and scope enforcement
 * for dynamically synthesized tools.
 *
 * INVARIANTS:
 * - Dynamic tools cannot self-register (Zero Self-Registration).
 * - Identity collisions and digest substitutions are rejected.
 * - Stale, revoked, expired, or quarantined tools cannot be executed.
 */

import { canonicalJsonStringify, sha256Hex } from "../domain/canonical-hash.js";
import {
  ToolLifecycleState,
  DynamicToolSpec,
  DynamicToolManifest,
  DynamicToolProposal,
  DynamicToolResourceLimits,
  DEFAULT_DYNAMIC_TOOL_BUDGETS,
  computeToolSourceDigest,
  computeToolManifestDigest,
} from "../domain/dynamic-tool.js";
import { DynamicToolValidator, ToolValidationReport } from "./dynamic-tool-validator.js";

export interface RegisteredToolRecord {
  readonly spec: DynamicToolSpec;
  readonly manifest: DynamicToolManifest;
  readonly sourceCode: string;
  readonly state: ToolLifecycleState;
  readonly validationReport: ToolValidationReport;
  readonly registeredAt: string;
  readonly revocationReason?: string;
  readonly quarantineReason?: string;
  readonly invocationCount: number;
}

export interface RegistrationAuthorityContext {
  readonly isGovernedSystem: boolean;
  readonly isDynamicToolCaller?: boolean;
  readonly callerWorkflowId: string;
}

export class DynamicToolRegistry {
  private readonly records = new Map<string, RegisteredToolRecord>();
  private readonly proposals = new Map<string, DynamicToolProposal>();
  private readonly states = new Map<string, ToolLifecycleState>();
  private readonly validator: DynamicToolValidator;
  private readonly limits: DynamicToolResourceLimits;

  constructor(
    customLimits?: Partial<DynamicToolResourceLimits>,
    validator?: DynamicToolValidator
  ) {
    this.limits = {
      ...DEFAULT_DYNAMIC_TOOL_BUDGETS,
      ...(customLimits || {}),
    };
    this.validator = validator || new DynamicToolValidator(this.limits);
  }

  public proposeTool(proposal: DynamicToolProposal): {
    readonly toolId: string;
    readonly validationReport: ToolValidationReport;
    readonly state: ToolLifecycleState;
  } {
    const toolId = proposal.proposalId;
    this.proposals.set(toolId, proposal);
    this.states.set(toolId, "PROPOSED");

    // Count existing registered tools for workflow
    const existingForWorkflow = Array.from(this.records.values()).filter(
      (r) => r.spec.creationWorkflowId === proposal.workflowId && r.state === "REGISTERED"
    ).length;

    if (existingForWorkflow >= this.limits.maxDynamicToolsPerWorkflow) {
      this.states.set(toolId, "FAILED");
      const errorReport: ToolValidationReport = {
        valid: false,
        toolName: proposal.toolName,
        diagnostics: [
          `Workflow '${proposal.workflowId}' reached max dynamic tool limit (${this.limits.maxDynamicToolsPerWorkflow}).`,
        ],
        rejectedCapabilities: [],
        forbiddenPatternsFound: ["MAX_DYNAMIC_TOOLS_PER_WORKFLOW_EXCEEDED"],
        sourceDigest: sha256Hex(proposal.sourceCode),
        validationDigest: sha256Hex("EXCEEDED"),
      };
      return { toolId, validationReport: errorReport, state: "FAILED" };
    }

    this.states.set(toolId, "VALIDATING");
    const report = this.validator.validateProposal(proposal);

    if (!report.valid) {
      this.states.set(toolId, "FAILED");
      return { toolId, validationReport: report, state: "FAILED" };
    }

    this.states.set(toolId, "AUTHORIZED_FOR_EXECUTION");
    return { toolId, validationReport: report, state: "AUTHORIZED_FOR_EXECUTION" };
  }

  public registerTool(
    toolId: string,
    authorityContext: RegistrationAuthorityContext
  ): DynamicToolSpec {
    // Check self-registration prohibition
    if (authorityContext.isDynamicToolCaller || !authorityContext.isGovernedSystem) {
      throw new Error(`Self-registration prohibited: Tool '${toolId}' cannot register itself.`);
    }

    const proposal = this.proposals.get(toolId);
    if (!proposal) {
      throw new Error(`Proposal not found for toolId: '${toolId}'.`);
    }

    if (authorityContext.callerWorkflowId !== proposal.workflowId) {
      throw new Error(
        `Cross-workflow registration rejected: caller workflow '${authorityContext.callerWorkflowId}' does not match proposal workflow '${proposal.workflowId}'.`
      );
    }

    const currentState = this.states.get(toolId);
    if (currentState !== "AUTHORIZED_FOR_EXECUTION") {
      throw new Error(`Cannot register tool '${toolId}' in state '${currentState}'.`);
    }

    const sourceDigest = computeToolSourceDigest(proposal.sourceCode);
    const runtimeDigest = sha256Hex(process.version + ":" + process.arch + ":dynamic-runtime-v1");
    const inputSchemaDigest = sha256Hex(canonicalJsonStringify(proposal.inputSchema));
    const outputSchemaDigest = sha256Hex(canonicalJsonStringify(proposal.outputSchema));
    const capabilityDigest = sha256Hex(canonicalJsonStringify(proposal.requestedCapabilities));
    const resourceLimitDigest = sha256Hex(canonicalJsonStringify(this.limits));
    const workspaceScopeDigest = sha256Hex(canonicalJsonStringify(proposal.workspaceScopes));
    const repositoryScopeDigest = sha256Hex(canonicalJsonStringify(proposal.repositoryScopes));

    const manifest: DynamicToolManifest = {
      toolId,
      toolVersion: "1.0.0",
      toolName: proposal.toolName,
      toolClass: proposal.toolClass,
      sourceDigest,
      runtimeDigest,
      inputSchemaDigest,
      outputSchemaDigest,
      capabilityDigest,
      resourceLimitDigest,
      workspaceScopeDigest,
      repositoryScopeDigest,
      networkPolicy: "DENY_ALL",
      credentialScopes: [],
    };

    const manifestDigest = computeToolManifestDigest(manifest);

    const spec: DynamicToolSpec = {
      toolId,
      toolVersion: "1.0.0",
      toolName: proposal.toolName,
      toolClass: proposal.toolClass,
      description: proposal.description,
      sourceDigest,
      manifestDigest,
      runtimeDigest,
      inputSchema: proposal.inputSchema,
      outputSchema: proposal.outputSchema,
      capabilitySet: proposal.requestedCapabilities,
      workspaceScopes: proposal.workspaceScopes,
      repositoryScopes: proposal.repositoryScopes,
      resourceLimits: this.limits,
      networkPolicy: "DENY_ALL",
      credentialScopes: [],
      deterministicExpectation: true,
      creatorIdentity: proposal.creatorIdentity,
      creationWorkflowId: proposal.workflowId,
      provenanceCondition: proposal.provenanceCondition,
    };

    // Check collision with existing registered tools
    const existing = this.records.get(toolId);
    if (existing) {
      if (existing.spec.sourceDigest !== sourceDigest || existing.spec.manifestDigest !== manifestDigest) {
        throw new Error(`Tool identity collision detected for '${toolId}'. Tampering or duplicate ID.`);
      }
    }

    const validationReport = this.validator.validateProposal(proposal);

    this.records.set(toolId, {
      spec,
      manifest,
      sourceCode: proposal.sourceCode,
      state: "REGISTERED",
      validationReport,
      registeredAt: new Date().toISOString(),
      invocationCount: 0,
    });
    this.states.set(toolId, "REGISTERED");

    return spec;
  }

  public getTool(toolId: string): RegisteredToolRecord | undefined {
    return this.records.get(toolId);
  }

  public getLifecycleState(toolId: string): ToolLifecycleState {
    return this.states.get(toolId) || "DRAFT";
  }

  public updateLifecycleState(toolId: string, newState: ToolLifecycleState): void {
    this.states.set(toolId, newState);
    const rec = this.records.get(toolId);
    if (rec) {
      this.records.set(toolId, { ...rec, state: newState });
    }
  }

  public incrementInvocation(toolId: string): number {
    const rec = this.records.get(toolId);
    if (!rec) {
      throw new Error(`Tool '${toolId}' not found.`);
    }
    const newCount = rec.invocationCount + 1;
    this.records.set(toolId, { ...rec, invocationCount: newCount });
    return newCount;
  }

  public revokeTool(toolId: string, reason: string): void {
    const rec = this.records.get(toolId);
    if (!rec) {
      throw new Error(`Tool '${toolId}' not found.`);
    }
    this.records.set(toolId, {
      ...rec,
      state: "REVOKED",
      revocationReason: reason,
    });
    this.states.set(toolId, "REVOKED");
  }

  public expireTool(toolId: string): void {
    const rec = this.records.get(toolId);
    if (!rec) {
      throw new Error(`Tool '${toolId}' not found.`);
    }
    this.records.set(toolId, {
      ...rec,
      state: "EXPIRED",
    });
    this.states.set(toolId, "EXPIRED");
  }

  public quarantineTool(toolId: string, reason: string): void {
    const rec = this.records.get(toolId);
    if (!rec) {
      throw new Error(`Tool '${toolId}' not found.`);
    }
    this.records.set(toolId, {
      ...rec,
      state: "QUARANTINED",
      quarantineReason: reason,
    });
    this.states.set(toolId, "QUARANTINED");
  }

  public listTools(workflowId?: string): readonly DynamicToolSpec[] {
    const all = Array.from(this.records.values());
    if (!workflowId) {
      return all.map((r) => r.spec);
    }
    return all.filter((r) => r.spec.creationWorkflowId === workflowId).map((r) => r.spec);
  }
}
