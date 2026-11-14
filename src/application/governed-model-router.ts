/**
 * Governed Model Router Service for Emerald Agent Fabric.
 *
 * Selects a model for an agent role from evidence only:
 * - the model is registered in the approved open-weight registry with a verified digest;
 * - the local provider inventory confirms it is installed with the same digest;
 * - every capability gate the role requires has unexpired PASSED evidence for that digest;
 * - it fits the context, memory and inference-time budgets of the request.
 *
 * Nothing is routable until an installed inventory has been applied (fail closed). A model's name,
 * description and declared capabilities are never consulted. Decisions are deterministic for the same
 * inputs and carry every rejected candidate with its reasons for audit.
 */

import type { EmeraldLifecycleTelemetry } from "./observability-instrumentation.js";

import {
  APPROVED_OPEN_WEIGHT_MODELS,
  HOST_HARDWARE_LIMITS,
  CapabilityCertificationStatus,
  CapabilityGateEvidence,
  ModelAssignment,
  ModelAssignmentViolationError,
  ModelCapabilityGateId,
  ModelRejectionCode,
  ModelRoutingDecision,
  ModelRoutingError,
  ModelRoutingRequest,
  MODEL_CAPABILITY_GATE_IDS,
  NoQualifiedModelError,
  OpenWeightModelProfile,
  ProprietaryModelRejectedError,
  RejectedModelCandidate,
  ROLE_DEFAULT_GATE_REQUIREMENTS,
  SUPER_AGENT_ROLES,
  getGateCertificationStatus,
  getVerifiedGates,
} from "../domain/model-routing.js";
import { canonicalJsonStringify, sha256Hex } from "../domain/canonical-hash.js";

/** Evidence-based readiness of one registered model against the local provider inventory. */
export interface ModelInventoryReadiness {
  readonly modelId: string;
  readonly installed: boolean;
  /** True only when the registry digest is verified and equals the installed digest. */
  readonly digestMatches: boolean;
  readonly routable: boolean;
}

export interface GovernedModelRouterOptions {
  /** Additional profiles (tests, operator-approved additions). Proprietary hosted profiles are rejected. */
  readonly customModels?: readonly OpenWeightModelProfile[];
  /** Clock used for evidence expiry and decision timestamps. */
  readonly now?: () => Date;
  /** Maximum number of distinct models that may hold an execution slot at once. */
  readonly maxConcurrentLoadedModels?: number;
  /** Optional fail-safe observability instrumentation facade. */
  readonly telemetry?: EmeraldLifecycleTelemetry;
}

const normalizeDigest = (digest: string): string => digest.trim().toLowerCase().replace(/^sha256:/, "");

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

export class GovernedModelRouterService {
  private readonly registry = new Map<string, OpenWeightModelProfile>();
  private readonly installedDigests = new Map<string, string>();
  private readonly slotHolders = new Map<string, string>(); // holderId -> modelId
  private inventoryApplied = false;
  private readonly now: () => Date;
  private readonly maxConcurrentLoadedModels: number;
  private readonly telemetry?: EmeraldLifecycleTelemetry;
  private _registryHash: string;
  get registryHash(): string {
    return this._registryHash;
  }

  constructor(options: GovernedModelRouterOptions | readonly OpenWeightModelProfile[] = {}) {
    const opts: GovernedModelRouterOptions = Array.isArray(options)
      ? { customModels: options as readonly OpenWeightModelProfile[] }
      : (options as GovernedModelRouterOptions);
    this.now = opts.now ?? (() => new Date());
    this.maxConcurrentLoadedModels = opts.maxConcurrentLoadedModels ?? HOST_HARDWARE_LIMITS.MAX_CONCURRENT_LOADED_MODELS;
    this.telemetry = opts.telemetry;

    for (const model of [...APPROVED_OPEN_WEIGHT_MODELS, ...(opts.customModels ?? [])]) {
      if ((model as { isProprietaryHosted?: unknown }).isProprietaryHosted) {
        throw new ProprietaryModelRejectedError(model.modelId);
      }
      // Private deep copy: the router's registry cannot be changed by mutating the caller's objects.
      this.registry.set(model.modelId, deepFreeze(JSON.parse(JSON.stringify(model)) as OpenWeightModelProfile));
    }
    this._registryHash = sha256Hex(
      canonicalJsonStringify([...this.registry.values()].sort((a, b) => a.modelId.localeCompare(b.modelId)))
    );
  }

  public getModelProfile(modelId: string): OpenWeightModelProfile | undefined {
    return this.registry.get(modelId);
  }

  public listRegisteredModelIds(): readonly string[] {
    return [...this.registry.keys()].sort();
  }

  /**
   * Authority check: returns the certification status of a capability gate for a registered model.
   */
  public getGateCertificationStatus(modelId: string, gateId: ModelCapabilityGateId): CapabilityCertificationStatus {
    const profile = this.registry.get(modelId);
    if (!profile) return "UNVERIFIED";
    return getGateCertificationStatus(profile, gateId, this.now(), profile.modelDigest);
  }

  /**
   * Applies validated clean-room capability evidence for an approved model.
   * Fails closed if the evidence digest does not match the approved registry digest.
   */
  public applyGateEvidence(evidence: CapabilityGateEvidence): void {
    if (!evidence || typeof evidence.modelId !== "string" || typeof evidence.modelDigest !== "string") {
      throw new ModelRoutingError("Invalid capability gate evidence record");
    }
    const profile = this.registry.get(evidence.modelId);
    if (!profile) {
      throw new ModelRoutingError(`Model '${evidence.modelId}' is not in the approved registry`);
    }
    if (!profile.digestVerified || !profile.modelDigest) {
      throw new ModelRoutingError(`Model '${evidence.modelId}' does not have a verified registry digest`);
    }
    if (normalizeDigest(evidence.modelDigest) !== normalizeDigest(profile.modelDigest)) {
      throw new ModelRoutingError(
        `Evidence digest '${evidence.modelDigest}' does not match verified registry digest for '${evidence.modelId}'`
      );
    }
    if (evidence.evaluationMode === "FIXTURE_VALIDATION") {
      throw new ModelRoutingError(
        `EVALUATION_MODE_VIOLATION: Fixture validation evidence cannot certify live model routing for '${evidence.modelId}'`
      );
    }

    // Filter out prior evidence for this gate and append new evidence
    const updatedEvidence = [
      ...profile.gateEvidence.filter((e) => e.gateId !== evidence.gateId),
      evidence,
    ];
    const updatedProfile: OpenWeightModelProfile = {
      ...profile,
      gateEvidence: deepFreeze(updatedEvidence),
    };

    this.registry.set(evidence.modelId, deepFreeze(updatedProfile));
    this._registryHash = sha256Hex(
      canonicalJsonStringify([...this.registry.values()].sort((a, b) => a.modelId.localeCompare(b.modelId)))
    );
  }

  /**
   * Applies provider inventory evidence (for example the Ollama model list). After this call a registered
   * model is routable only if it is installed and its installed digest equals a verified registry digest.
   * A malformed inventory is rejected and leaves the router with no routable model.
   */
  public applyInstalledInventory(
    installed: readonly { readonly name: string; readonly digest: string }[]
  ): readonly ModelInventoryReadiness[] {
    this.installedDigests.clear();
    this.inventoryApplied = false;
    if (!Array.isArray(installed)) {
      throw new ModelRoutingError("Installed model inventory must be an array");
    }
    for (const entry of installed) {
      if (!entry || typeof entry.name !== "string" || typeof entry.digest !== "string" || entry.name.length === 0) {
        this.installedDigests.clear();
        throw new ModelRoutingError("Installed model inventory contains an entry without a string name and digest");
      }
      this.installedDigests.set(entry.name, normalizeDigest(entry.digest));
    }
    this.inventoryApplied = true;
    return Object.freeze(
      this.listRegisteredModelIds().map((modelId) => {
        const profile = this.registry.get(modelId)!;
        const installedDigest = this.installedDigests.get(modelId);
        const isInstalled = installedDigest !== undefined;
        const digestMatches =
          isInstalled && profile.digestVerified && !!profile.modelDigest && installedDigest === normalizeDigest(profile.modelDigest);
        return Object.freeze({ modelId, installed: isInstalled, digestMatches, routable: digestMatches });
      })
    );
  }

  /** Selects a model for the request, or throws NoQualifiedModelError carrying every rejection reason. */
  public routeModel(request: ModelRoutingRequest): ModelRoutingDecision {
    try {
      const decision = this.decide(request, []);
      this.telemetry?.recordModelRoutingDecision({
        role: request.role,
        outcome: "assigned",
        modelId: decision.selectedModelId,
      });
      return decision;
    } catch (err) {
      this.telemetry?.recordModelRoutingDecision({
        role: request.role,
        outcome: err instanceof NoQualifiedModelError ? "blocked" : "rejected",
      });
      throw err;
    }
  }


  /**
   * Governed fallback after an inference failure of the previously selected model. The original request
   * (role, gates, tenant, task, contract, budgets) is reused unchanged; only models that failed for this
   * request are excluded. It never widens policy and never implies a task-execution retry.
   */
  public resolveFallback(previous: ModelRoutingDecision, failureReason: string): ModelRoutingDecision {
    if (typeof failureReason !== "string" || failureReason.trim().length === 0) {
      throw new ModelRoutingError("A fallback requires a failure reason");
    }
    const chain = [...previous.fallbackChain, { modelId: previous.selectedModelId, reason: failureReason }];
    try {
      const decision = this.decide(previous.request, chain);
      this.telemetry?.recordModelRoutingDecision({
        role: previous.request.role,
        outcome: "fallback",
        modelId: decision.selectedModelId,
        fallbackChainLength: decision.fallbackChain.length,
        failureReason,
      });
      return decision;
    } catch (err) {
      this.telemetry?.recordModelRoutingDecision({
        role: previous.request.role,
        outcome: err instanceof NoQualifiedModelError ? "blocked" : "rejected",
        fallbackChainLength: chain.length,
        failureReason,
      });
      throw err;
    }
  }

  /**
   * Bounded concurrency for model execution. A holder may run a model only while fewer than the configured
   * number of distinct models hold slots (one on the reference host). Returns a release function.
   */
  public acquireExecutionSlot(modelId: string, holderId: string): () => void {
    if (!this.registry.has(modelId)) {
      throw new ModelRoutingError(`Model '${modelId}' is not registered`);
    }
    const active = new Set(this.slotHolders.values());
    if (!active.has(modelId) && active.size >= this.maxConcurrentLoadedModels) {
      throw new ModelRoutingError(
        `RESOURCE_EXHAUSTED: ${active.size} model(s) already loaded for execution (limit ${this.maxConcurrentLoadedModels}); cannot load '${modelId}'`
      );
    }
    this.slotHolders.set(holderId, modelId);
    return () => {
      this.slotHolders.delete(holderId);
    };
  }

  private decide(
    request: ModelRoutingRequest,
    failed: readonly { readonly modelId: string; readonly reason: string }[]
  ): ModelRoutingDecision {
    if (!SUPER_AGENT_ROLES.includes(request.role)) {
      throw new ModelRoutingError(`Unsupported agent role '${String(request.role)}'`);
    }
    for (const field of ["tenantId", "taskId", "contractId"] as const) {
      if (typeof request[field] !== "string" || request[field].trim().length === 0) {
        throw new ModelRoutingError(`Routing request requires a non-empty ${field}`);
      }
    }
    if (!Number.isFinite(request.estimatedContextTokens) || request.estimatedContextTokens < 0) {
      throw new ModelRoutingError("Routing request requires a non-negative estimatedContextTokens");
    }
    for (const g of request.requiredGates ?? []) {
      if (!MODEL_CAPABILITY_GATE_IDS.includes(g)) {
        throw new ModelRoutingError(`Unknown capability gate '${String(g)}'`);
      }
    }
    // Caller-supplied gates can only add to the role's requirements, never replace or reduce them.
    const requiredGates: ModelCapabilityGateId[] = MODEL_CAPABILITY_GATE_IDS.filter(
      (g) => ROLE_DEFAULT_GATE_REQUIREMENTS[request.role].includes(g) || (request.requiredGates ?? []).includes(g)
    );

    const now = this.now();
    const failedIds = new Set(failed.map((f) => f.modelId));
    const loadedModels = new Set(this.slotHolders.values());
    const eligible: OpenWeightModelProfile[] = [];
    const rejected: RejectedModelCandidate[] = [];

    for (const modelId of this.listRegisteredModelIds()) {
      const profile = this.registry.get(modelId)!;
      const reasons: { code: ModelRejectionCode; detail: string }[] = [];
      const reject = (code: ModelRejectionCode, detail: string) => reasons.push({ code, detail });

      if (failedIds.has(modelId)) {
        reject("EXCLUDED_AFTER_FAILURE", "failed earlier for this request");
      }
      if (!this.inventoryApplied) {
        reject("INVENTORY_NOT_VERIFIED", "no installed-model inventory has been applied");
      } else {
        const installedDigest = this.installedDigests.get(modelId);
        if (installedDigest === undefined) {
          reject("NOT_INSTALLED", "not present in the local provider inventory");
        } else if (!profile.digestVerified || !profile.modelDigest) {
          reject("DIGEST_UNVERIFIED", "registry digest has not been verified");
        } else if (installedDigest !== normalizeDigest(profile.modelDigest)) {
          reject("DIGEST_MISMATCH", "installed digest differs from the registry digest");
        }
      }

      const verified = getVerifiedGates(profile, now);
      const missing = requiredGates.filter((g) => !verified.includes(g));
      if (missing.length > 0) {
        reject("MISSING_GATE_EVIDENCE", `no unexpired PASSED evidence for ${missing.join(", ")}`);
      }

      if (request.estimatedContextTokens > profile.contextLimits.maxInputTokens) {
        reject(
          "CONTEXT_OVERFLOW",
          `${request.estimatedContextTokens} tokens exceed the ${profile.contextLimits.maxInputTokens}-token context`
        );
      }

      const memoryCeiling = Math.min(
        HOST_HARDWARE_LIMITS.MAX_RESIDENT_MEMORY_MB,
        request.availableMemoryMb ?? HOST_HARDWARE_LIMITS.MAX_RESIDENT_MEMORY_MB
      );
      if (profile.hardwareRequirements.residentMemoryMb > memoryCeiling) {
        reject("MEMORY_BUDGET_EXCEEDED", `${profile.hardwareRequirements.residentMemoryMb} MB exceeds ${memoryCeiling} MB`);
      }

      // Budget checks use measured latency only: the 90th percentile when available, else the maximum.
      const observed = profile.latencyProfile.observed;
      if (!observed) {
        reject("LATENCY_UNMEASURED", "no latency measurement exists for this host");
      } else {
        const planningLatency = observed.p90Ms ?? observed.maxMs;
        const stepCeiling = Math.min(
          HOST_HARDWARE_LIMITS.MAX_STEP_LATENCY_MS,
          request.stepBudgetMs > 0 ? request.stepBudgetMs : HOST_HARDWARE_LIMITS.MAX_STEP_LATENCY_MS
        );
        if (planningLatency > stepCeiling) {
          reject("LATENCY_EXCEEDS_STEP_BUDGET", `measured ${planningLatency} ms exceeds ${stepCeiling} ms`);
        }
        if (request.remainingBudgetMs > 0 && planningLatency > request.remainingBudgetMs) {
          reject("LATENCY_EXCEEDS_REMAINING_BUDGET", `measured ${planningLatency} ms exceeds ${request.remainingBudgetMs} ms remaining`);
        }
      }

      if (!loadedModels.has(modelId) && loadedModels.size >= this.maxConcurrentLoadedModels) {
        reject("CONCURRENCY_LIMIT", `${loadedModels.size} other model(s) already loaded (limit ${this.maxConcurrentLoadedModels})`);
      }

      if (reasons.length === 0) {
        eligible.push(profile);
      } else {
        rejected.push(Object.freeze({ modelId, reasons: Object.freeze(reasons) }));
      }
    }

    if (eligible.length === 0) {
      throw new NoQualifiedModelError(request.role, requiredGates, Object.freeze(rejected));
    }

    // Deterministic preference: lowest measured median latency, then model id.
    eligible.sort(
      (a, b) =>
        a.latencyProfile.observed!.medianMs - b.latencyProfile.observed!.medianMs || a.modelId.localeCompare(b.modelId)
    );
    const selected = eligible[0]!;
    const evidenceRefs = selected.gateEvidence
      .filter((e) => e.outcome === "PASSED" && requiredGates.includes(e.gateId))
      .map((e) => `${e.gateId}@${e.evaluationVersion}: ${e.evidenceRef}`);

    const content = {
      request: {
        role: request.role,
        tenantId: request.tenantId,
        taskId: request.taskId,
        contractId: request.contractId,
        runId: request.runId ?? null,
        remainingBudgetMs: request.remainingBudgetMs,
        stepBudgetMs: request.stepBudgetMs,
        estimatedContextTokens: request.estimatedContextTokens,
        availableMemoryMb: request.availableMemoryMb ?? null,
      },
      selectedModelId: selected.modelId,
      modelDigest: selected.modelDigest,
      requiredGates,
      evidenceRefs,
      rejectedCandidates: rejected,
      eligibleAlternates: eligible.slice(1).map((p) => p.modelId),
      fallbackChain: failed,
      registryHash: this.registryHash,
    };

    return Object.freeze({
      request: Object.freeze({ ...request }),
      selectedModelId: selected.modelId,
      modelDigest: selected.modelDigest!,
      modelProfile: selected,
      requiredGates: Object.freeze(requiredGates),
      evidenceRefs: Object.freeze(evidenceRefs),
      rejectedCandidates: Object.freeze(rejected),
      eligibleAlternates: Object.freeze(content.eligibleAlternates),
      isFallback: failed.length > 0,
      fallbackChain: Object.freeze([...failed]),
      routingReason:
        `Selected '${selected.modelId}' for role '${request.role}': installed with a verified digest, ` +
        `evidence for [${requiredGates.join(", ")}], measured median latency ${selected.latencyProfile.observed!.medianMs} ms` +
        (failed.length > 0 ? `; fallback after ${failed.map((f) => `${f.modelId} (${f.reason})`).join(", ")}` : ""),
      decidedAt: now.toISOString(),
      decisionHash: sha256Hex(canonicalJsonStringify(content)),
    });
  }
}

/**
 * Checks a task's durable model assignment against the model a worker is authorized to run.
 * Throws ModelAssignmentViolationError on any mismatch; never returns a partial approval.
 */
export function assertModelAssignmentMatches(
  assignment: unknown,
  expected: {
    readonly taskId: string;
    readonly tenantId?: string | null;
    readonly role?: string | null;
    readonly modelId: string;
    readonly modelDigest: string;
  }
): ModelAssignment {
  const a = assignment as Partial<ModelAssignment> | null | undefined;
  if (!a || typeof a !== "object" || typeof a.modelId !== "string" || typeof a.modelDigest !== "string") {
    throw new ModelAssignmentViolationError(`Task '${expected.taskId}' has no valid model assignment`);
  }
  if (a.taskId !== expected.taskId) {
    throw new ModelAssignmentViolationError(
      `Model assignment was issued for task '${String(a.taskId)}', not '${expected.taskId}'`
    );
  }
  if (expected.tenantId && a.tenantId !== expected.tenantId) {
    throw new ModelAssignmentViolationError(`Model assignment for task '${expected.taskId}' belongs to a different tenant`);
  }
  if (expected.role && a.role !== expected.role) {
    throw new ModelAssignmentViolationError(
      `Model assignment role '${String(a.role)}' does not match task role '${expected.role}'`
    );
  }
  if (a.modelId !== expected.modelId) {
    throw new ModelAssignmentViolationError(
      `Task '${expected.taskId}' is assigned model '${a.modelId}', but this worker runs '${expected.modelId}'`
    );
  }
  if (normalizeDigest(a.modelDigest) !== normalizeDigest(expected.modelDigest)) {
    throw new ModelAssignmentViolationError(
      `Assigned digest for model '${a.modelId}' does not match the digest this worker verified`
    );
  }
  return a as ModelAssignment;
}
