/**
 * Phase 87 — Governed Dynamic Tool Composition Policy
 *
 * Deterministic policy evaluator for multi-tool composition pipelines:
 * - Capability intersection enforcement (no union escalation, no transitive escalation)
 * - Scope boundary intersection (workspace and repository scopes)
 * - Cycle detection and recursion defense (A->A, A->B->A, A->B->C->A)
 * - Exact registered tool identity verification (no dynamic discovery or 'latest' lookups)
 * - Immutability enforcement (no dynamic recomposition)
 */

import { canonicalJsonStringify, sha256Hex } from "../domain/canonical-hash.js";
import {
  AllowedToolCapability,
  ALLOWED_TOOL_CAPABILITIES,
  isForbiddenCapability,
} from "../domain/dynamic-tool.js";
import {
  CompositionStageSpec,
  ToolCompositionSpec,
  CompositionResourceLimits,
  DEFAULT_COMPOSITION_RESOURCE_LIMITS,
} from "../domain/dynamic-tool-composition.js";
import { DynamicToolRegistry } from "./dynamic-tool-registry.js";

export interface CompositionValidationReport {
  readonly valid: boolean;
  readonly compositionId: string;
  readonly diagnostics: readonly string[];
  readonly rejectedCapabilities: readonly string[];
  readonly detectedCycles: readonly string[];
  readonly effectiveCapabilities: readonly AllowedToolCapability[];
  readonly effectiveWorkspaceScopes: readonly string[];
  readonly effectiveRepositoryScopes: readonly string[];
  readonly validationDigest: string;
}

export interface WorkflowAuthorityContext {
  readonly workflowId: string;
  readonly allowedCapabilities: readonly AllowedToolCapability[];
  readonly allowedWorkspaceScopes: readonly string[];
  readonly allowedRepositoryScopes: readonly string[];
  readonly isGovernedSystem: boolean;
  readonly isDynamicToolCaller?: boolean;
}

export class DynamicToolCompositionPolicy {
  private readonly registry: DynamicToolRegistry;
  private readonly limits: CompositionResourceLimits;

  constructor(registry: DynamicToolRegistry, customLimits?: Partial<CompositionResourceLimits>) {
    this.registry = registry;
    this.limits = {
      ...DEFAULT_COMPOSITION_RESOURCE_LIMITS,
      ...(customLimits || {}),
    };
  }

  public validateComposition(
    spec: ToolCompositionSpec,
    workflowContext: WorkflowAuthorityContext
  ): CompositionValidationReport {
    const diagnostics: string[] = [];
    const rejectedCapabilities: string[] = [];
    const detectedCycles: string[] = [];

    // Check caller authority (prohibit dynamic tools self-authorizing composition)
    if (workflowContext.isDynamicToolCaller || !workflowContext.isGovernedSystem) {
      diagnostics.push("Self-authorization prohibited: Dynamic tools cannot create or authorize tool compositions.");
    }

    if (spec.workflowId !== workflowContext.workflowId) {
      diagnostics.push(
        `Workflow mismatch: composition workflow '${spec.workflowId}' does not match context workflow '${workflowContext.workflowId}'.`
      );
    }

    // Tool count bound
    if (spec.toolIds.length > this.limits.maxTools) {
      diagnostics.push(`Tool count (${spec.toolIds.length}) exceeds maximum allowed (${this.limits.maxTools}).`);
    }

    // Depth bound
    if (spec.stages.length > this.limits.maxDepth) {
      diagnostics.push(`Pipeline depth (${spec.stages.length}) exceeds maximum depth (${this.limits.maxDepth}).`);
    }

    // Exact tool lookup and registered state verification
    for (const toolId of spec.toolIds) {
      if (!toolId || toolId === "latest" || toolId.includes("*")) {
        diagnostics.push(`Wildcard or mutable tool identity rejected: '${toolId}'.`);
        continue;
      }

      const rec = this.registry.getTool(toolId);
      if (!rec) {
        diagnostics.push(`Tool '${toolId}' is not registered in DynamicToolRegistry.`);
        continue;
      }

      if (rec.state === "REVOKED") {
        diagnostics.push(`Tool '${toolId}' is REVOKED and cannot be part of a composition.`);
      }
      if (rec.state === "EXPIRED") {
        diagnostics.push(`Tool '${toolId}' is EXPIRED and cannot be part of a composition.`);
      }
      if (rec.state === "QUARANTINED") {
        diagnostics.push(`Tool '${toolId}' is QUARANTINED and cannot be part of a composition.`);
      }
      if (rec.state !== "REGISTERED") {
        diagnostics.push(`Tool '${toolId}' is in non-executable state '${rec.state}'.`);
      }
    }

    // Cycle & recursion detection
    this.checkGraphCycles(spec.stages, detectedCycles, diagnostics);

    // Capability intersection & escalation verification
    for (const cap of spec.compositionCapabilities) {
      if (isForbiddenCapability(cap)) {
        rejectedCapabilities.push(cap);
        diagnostics.push(`Forbidden capability requested in composition: '${cap}'.`);
      } else if (!ALLOWED_TOOL_CAPABILITIES.includes(cap as any)) {
        rejectedCapabilities.push(cap);
        diagnostics.push(`Unrecognized capability requested in composition: '${cap}'.`);
      }

      // Must be within workflow permissions
      if (!workflowContext.allowedCapabilities.includes(cap)) {
        rejectedCapabilities.push(cap);
        diagnostics.push(`Composition capability '${cap}' exceeds workflow capability boundary.`);
      }
    }

    // Stage capability verification (effectiveStageCapability ⊆ registeredToolCapability)
    for (const stage of spec.stages) {
      const toolRec = this.registry.getTool(stage.toolId);
      if (toolRec) {
        // Stage capability cannot exceed registered tool's capability set
        for (const stageCap of stage.capabilityScope) {
          if (!toolRec.spec.capabilitySet.includes(stageCap)) {
            rejectedCapabilities.push(stageCap);
            diagnostics.push(
              `Stage '${stage.stageId}' requests capability '${stageCap}' not granted to tool '${stage.toolId}'.`
            );
          }
          if (!spec.compositionCapabilities.includes(stageCap)) {
            rejectedCapabilities.push(stageCap);
            diagnostics.push(
              `Stage '${stage.stageId}' requests capability '${stageCap}' not declared in composition capabilities.`
            );
          }
        }

        // Version integrity binding
        if (stage.toolVersion !== toolRec.spec.toolVersion) {
          diagnostics.push(
            `Tool version mismatch in stage '${stage.stageId}' for tool '${stage.toolId}': expected '${toolRec.spec.toolVersion}', found '${stage.toolVersion}'.`
          );
        }

        // Digest integrity binding
        if (stage.toolSourceDigest !== toolRec.spec.sourceDigest) {
          diagnostics.push(`Tool source digest mismatch in stage '${stage.stageId}' for tool '${stage.toolId}'.`);
        }
        if (stage.toolManifestDigest !== toolRec.spec.manifestDigest) {
          diagnostics.push(`Tool manifest digest mismatch in stage '${stage.stageId}' for tool '${stage.toolId}'.`);
        }

        // Scope intersection
        for (const ws of stage.workspaceScopes) {
          if (!spec.workspaceScopes.includes(ws) || !toolRec.spec.workspaceScopes.includes(ws)) {
            diagnostics.push(`Stage '${stage.stageId}' workspace scope '${ws}' exceeds tool or composition scopes.`);
          }
        }
        for (const repo of stage.repositoryScopes) {
          if (!spec.repositoryScopes.includes(repo) || !toolRec.spec.repositoryScopes.includes(repo)) {
            diagnostics.push(`Stage '${stage.stageId}' repository scope '${repo}' exceeds tool or composition scopes.`);
          }
        }
      }
    }

    // Effective capabilities calculation (intersection of declared and workflow allowed)
    const effectiveCapabilities = spec.compositionCapabilities.filter(
      (c) => workflowContext.allowedCapabilities.includes(c) && !isForbiddenCapability(c)
    );

    const effectiveWorkspaceScopes = spec.workspaceScopes.filter((ws) =>
      workflowContext.allowedWorkspaceScopes.includes(ws)
    );

    const effectiveRepositoryScopes = spec.repositoryScopes.filter((repo) =>
      workflowContext.allowedRepositoryScopes.includes(repo)
    );

    const valid = diagnostics.length === 0 && rejectedCapabilities.length === 0 && detectedCycles.length === 0;

    const reportPayload = {
      compositionId: spec.compositionId,
      valid,
      diagnostics,
      rejectedCapabilities,
      detectedCycles,
      effectiveCapabilities,
      effectiveWorkspaceScopes,
      effectiveRepositoryScopes,
    };
    const validationDigest = sha256Hex(canonicalJsonStringify(reportPayload));

    return {
      valid,
      compositionId: spec.compositionId,
      diagnostics,
      rejectedCapabilities,
      detectedCycles,
      effectiveCapabilities,
      effectiveWorkspaceScopes,
      effectiveRepositoryScopes,
      validationDigest,
    };
  }

  private checkGraphCycles(
    stages: readonly CompositionStageSpec[],
    detectedCycles: string[],
    diagnostics: string[]
  ): void {
    const seenStageIds = new Set<string>();
    const seenSequences = new Set<number>();
    const toolOrder: string[] = [];
    let prevStage: CompositionStageSpec | undefined = undefined;

    for (const s of stages) {
      if (seenStageIds.has(s.stageId)) {
        detectedCycles.push(`DUPLICATE_STAGE_ID:${s.stageId}`);
        diagnostics.push(`Duplicate stage ID detected: '${s.stageId}'.`);
      }
      seenStageIds.add(s.stageId);

      if (seenSequences.has(s.sequenceNumber)) {
        diagnostics.push(`Duplicate sequence number detected: ${s.sequenceNumber}.`);
      }
      seenSequences.add(s.sequenceNumber);

      // Check self-reference in parentStageIds
      if (s.parentStageIds && s.parentStageIds.includes(s.stageId)) {
        detectedCycles.push(`SELF_REFERENCE:${s.stageId}`);
        diagnostics.push(`Direct self-reference cycle detected in stage '${s.stageId}'.`);
      }

      // Check tool repetition cycle patterns (e.g. A -> A, A -> B -> A)
      if (prevStage && prevStage.toolId === s.toolId) {
        detectedCycles.push(`ADJACENT_CYCLE:${s.toolId}`);
        diagnostics.push(`Adjacent tool recursion detected for tool '${s.toolId}'.`);
      }

      if (toolOrder.includes(s.toolId)) {
        // Repeating a tool within a pipeline is flagged as a cycle attempt
        detectedCycles.push(`TOOL_REPETITION_CYCLE:${s.toolId}`);
        diagnostics.push(`Tool repetition cycle detected: '${s.toolId}' appears multiple times.`);
      }
      toolOrder.push(s.toolId);
      prevStage = s;
    }
  }
}
