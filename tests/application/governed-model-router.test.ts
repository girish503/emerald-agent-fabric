/**
 * Governed model router — role-aware routing, evidence, fallback and resource governance.
 *
 * Real: GovernedModelRouterService, the approved registry, gate definitions.
 * Fixture: provider inventories and the `fixtureProfile` models below. Fixture models carry synthetic
 * evidence solely to exercise the routing logic; they are not claims about any real model.
 * No provider is contacted and no inference is run.
 */
import { describe, expect, it } from "vitest";
import {
  GovernedModelRouterService,
  assertModelAssignmentMatches,
} from "../../src/application/governed-model-router.js";
import {
  APPROVED_OPEN_WEIGHT_MODELS,
  CAPABILITY_GATE_DEFINITIONS,
  MODEL_CAPABILITY_GATE_IDS,
  ModelAssignmentViolationError,
  ModelCapabilityGateId,
  ModelRoutingError,
  ModelRoutingRequest,
  NoQualifiedModelError,
  OpenWeightModelProfile,
  ProprietaryModelRejectedError,
  getVerifiedGates,
  toModelAssignment,
} from "../../src/domain/model-routing.js";

const NOW = new Date("2026-11-11T00:00:00.000Z");
const QWEN = "qwen2.5-coder:1.5b";
const QWEN_DIGEST = "d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668";
const CODER_GATES: ModelCapabilityGateId[] = ["G1_STRUCTURED_JSON", "G3_CODE_UNDERSTANDING", "G4_SINGLE_FILE_REPAIR"];

const digestOf = (id: string) => `sha256:${Buffer.from(id).toString("hex").padEnd(64, "0").slice(0, 64)}`;

function fixtureProfile(
  modelId: string,
  gates: readonly ModelCapabilityGateId[],
  overrides: Partial<OpenWeightModelProfile> & { medianMs?: number; expiresAt?: string } = {}
): OpenWeightModelProfile {
  const modelDigest = digestOf(modelId);
  const medianMs = overrides.medianMs ?? 10_000;
  return {
    modelId,
    modelTag: `${modelId}-fixture`,
    modelDigest,
    digestVerified: true,
    parameterCount: "fixture",
    openSourceLicense: "Apache-2.0",
    isProprietaryHosted: false,
    declaredCapabilities: [],
    gateEvidence: gates.map((gateId) => ({
      gateId,
      outcome: "PASSED" as const,
      modelId,
      modelDigest,
      evaluationVersion: "fixture-eval-1",
      evidenceRef: `fixture:${modelId}:${gateId}`,
      summary: "synthetic fixture evidence",
      observedAt: "2026-11-01T00:00:00.000Z",
      expiresAt: overrides.expiresAt ?? "2027-01-01T00:00:00.000Z",
    })),
    contextLimits: { maxInputTokens: 4096, maxOutputTokens: 2048, contextWindowBytes: 16384 },
    latencyProfile: {
      expectedStepLatencyMs: null,
      observed: { sampleCount: 10, minMs: medianMs, medianMs, p90Ms: medianMs, maxMs: medianMs, measuredAt: "2026-11-01T00:00:00.000Z", source: "fixture" },
      timeoutThresholdMs: 150_000,
    },
    hardwareRequirements: { residentMemoryMb: 1000, residentMemoryMeasured: false, quantization: "Q4_K_M", accelerator: "CPU" },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "medianMs" && k !== "expiresAt")),
  } as OpenWeightModelProfile;
}

const request = (overrides: Partial<ModelRoutingRequest> = {}): ModelRoutingRequest => ({
  role: "CODER",
  tenantId: "tenant-a",
  taskId: "task-1",
  contractId: "contract-task-1",
  remainingBudgetMs: 0,
  stepBudgetMs: 0,
  estimatedContextTokens: 2000,
  ...overrides,
});

const routerWith = (models: OpenWeightModelProfile[], installed: OpenWeightModelProfile[] = models) => {
  const router = new GovernedModelRouterService({ customModels: models, now: () => NOW });
  router.applyInstalledInventory(installed.map((m) => ({ name: m.modelId, digest: m.modelDigest! })));
  return router;
};

const reasonsFor = (err: unknown, modelId: string): string[] =>
  (err as NoQualifiedModelError).rejectedCandidates.find((c) => c.modelId === modelId)!.reasons.map((r) => r.code);

const catchRoute = (router: GovernedModelRouterService, req: ModelRoutingRequest): NoQualifiedModelError => {
  try {
    router.routeModel(req);
  } catch (err) {
    expect(err).toBeInstanceOf(NoQualifiedModelError);
    return err as NoQualifiedModelError;
  }
  throw new Error("expected routing to fail closed");
};

describe("registry evidence", () => {
  it("defines every capability gate with meaning, evidence, method and pass criteria", () => {
    expect(MODEL_CAPABILITY_GATE_IDS).toHaveLength(10);
    for (const gateId of MODEL_CAPABILITY_GATE_IDS) {
      const def = CAPABILITY_GATE_DEFINITIONS[gateId];
      for (const field of ["meaning", "requiredEvidence", "testMethod", "passCriteria"] as const) {
        expect(def[field].length).toBeGreaterThan(10);
      }
      expect(def.revalidationDays).toBeGreaterThan(0);
    }
  });

  it("credits qwen2.5-coder:1.5b with G1 only, and records no identity or evidence for unverified models", () => {
    const qwen = APPROVED_OPEN_WEIGHT_MODELS.find((m) => m.modelId === QWEN)!;
    expect(qwen.digestVerified).toBe(true);
    expect(getVerifiedGates(qwen, NOW)).toEqual(["G1_STRUCTURED_JSON"]);
    expect(qwen.latencyProfile.expectedStepLatencyMs).toBeNull();
    expect(qwen.latencyProfile.observed).toMatchObject({ sampleCount: 11, minMs: 52_099, medianMs: 59_128, p90Ms: 82_362, maxMs: 90_699 });

    for (const model of APPROVED_OPEN_WEIGHT_MODELS.filter((m) => m.modelId !== QWEN)) {
      expect(model.modelDigest).toBeNull();
      expect(model.digestVerified).toBe(false);
      expect(model.gateEvidence).toEqual([]);
      expect(model.latencyProfile.observed).toBeNull();
      expect(getVerifiedGates(model, NOW)).toEqual([]);
    }
  });

  it("ignores expired evidence, evidence for another digest, and PASSED evidence superseded by a later FAILED", () => {
    const expired = fixtureProfile("m-expired", CODER_GATES, { expiresAt: "2026-11-10T00:00:00.000Z" });
    expect(getVerifiedGates(expired, NOW)).toEqual([]);

    const base = fixtureProfile("m-digest", CODER_GATES);
    const otherDigest = { ...base, gateEvidence: base.gateEvidence.map((e) => ({ ...e, modelDigest: digestOf("someone-else") })) };
    expect(getVerifiedGates(otherDigest, NOW)).toEqual([]);

    const superseded = {
      ...base,
      gateEvidence: [
        ...base.gateEvidence,
        { ...base.gateEvidence[0]!, outcome: "FAILED" as const, observedAt: "2026-11-05T00:00:00.000Z" },
      ],
    };
    expect(getVerifiedGates(superseded, NOW)).not.toContain("G1_STRUCTURED_JSON");
  });
});

describe("role-aware routing fails closed on the real registry", () => {
  it("routes no role today: the only installed model lacks evidence for every role's gates", () => {
    const router = new GovernedModelRouterService({ now: () => NOW });
    router.applyInstalledInventory([{ name: QWEN, digest: QWEN_DIGEST }]);
    for (const role of ["RESEARCHER", "CODER", "TESTER", "REVIEWER"] as const) {
      const err = catchRoute(router, request({ role }));
      expect(reasonsFor(err, QWEN)).toEqual(["MISSING_GATE_EVIDENCE"]);
      expect(reasonsFor(err, "qwen2.5-coder:7b")).toEqual(expect.arrayContaining(["NOT_INSTALLED", "MISSING_GATE_EVIDENCE", "LATENCY_UNMEASURED"]));
      expect(err.message).toContain(role);
    }
  });

  it("routes nothing before an inventory is applied", () => {
    const router = new GovernedModelRouterService({ customModels: [fixtureProfile("m-a", CODER_GATES)], now: () => NOW });
    expect(reasonsFor(catchRoute(router, request()), "m-a")).toEqual(["INVENTORY_NOT_VERIFIED"]);
  });

  it("rejects an unsupported role, a missing identity field and an unknown gate", () => {
    const router = routerWith([fixtureProfile("m-a", CODER_GATES)]);
    expect(() => router.routeModel(request({ role: "ADMIN" as never }))).toThrowError(/Unsupported agent role/);
    expect(() => router.routeModel(request({ tenantId: "" }))).toThrowError(/tenantId/);
    expect(() => router.routeModel(request({ taskId: " " }))).toThrowError(/taskId/);
    expect(() => router.routeModel(request({ requiredGates: ["G99_MADE_UP" as never] }))).toThrowError(/Unknown capability gate/);
  });
});

describe("selection, audit record and policy", () => {
  it("selects a qualifying model and records digest, evidence and every rejected candidate", () => {
    const router = routerWith([fixtureProfile("m-a", CODER_GATES)]);
    const decision = router.routeModel(request({ runId: "run-1" }));

    expect(decision.selectedModelId).toBe("m-a");
    expect(decision.modelDigest).toBe(digestOf("m-a"));
    expect(decision.requiredGates).toEqual(CODER_GATES);
    expect(decision.evidenceRefs).toHaveLength(3);
    expect(decision.isFallback).toBe(false);
    expect(decision.fallbackChain).toEqual([]);
    expect(decision.rejectedCandidates.map((c) => c.modelId)).toEqual(
      expect.arrayContaining([QWEN, "deepseek-coder:1.3b", "llama3.2:1b", "qwen2.5-coder:7b"])
    );
    expect(decision.request).toMatchObject({ role: "CODER", tenantId: "tenant-a", taskId: "task-1", runId: "run-1" });

    const assignment = toModelAssignment(decision);
    expect(assignment).toMatchObject({ modelId: "m-a", role: "CODER", taskId: "task-1", tenantId: "tenant-a", decisionHash: decision.decisionHash });
  });

  it("is deterministic: the same inputs give the same decision hash, different tasks give different hashes", () => {
    const router = routerWith([fixtureProfile("m-a", CODER_GATES), fixtureProfile("m-b", CODER_GATES, { medianMs: 20_000 })]);
    const first = router.routeModel(request());
    const second = router.routeModel(request());
    expect(second.decisionHash).toBe(first.decisionHash);
    expect(first.selectedModelId).toBe("m-a");
    expect(first.eligibleAlternates).toEqual(["m-b"]);
    expect(router.routeModel(request({ taskId: "task-2" })).decisionHash).not.toBe(first.decisionHash);
  });

  it("lets caller-supplied gates add requirements but never remove a role's requirements", () => {
    const g1Only = fixtureProfile("m-g1", ["G1_STRUCTURED_JSON"]);
    const router = routerWith([g1Only]);
    // Asking for only G1 does not downgrade the CODER contract.
    expect(reasonsFor(catchRoute(router, request({ requiredGates: ["G1_STRUCTURED_JSON"] })), "m-g1")).toEqual(["MISSING_GATE_EVIDENCE"]);

    const coder = fixtureProfile("m-coder", CODER_GATES);
    const strict = routerWith([coder]);
    expect(strict.routeModel(request()).selectedModelId).toBe("m-coder");
    expect(reasonsFor(catchRoute(strict, request({ requiredGates: ["G5_MULTI_FILE_REPAIR"] })), "m-coder")).toEqual(["MISSING_GATE_EVIDENCE"]);
  });

  it("does not route by name or declared capabilities", () => {
    const impostor = fixtureProfile("super-coder-pro-max", [], { declaredCapabilities: ["code.repair", "everything"] });
    expect(reasonsFor(catchRoute(routerWith([impostor]), request()), "super-coder-pro-max")).toEqual(["MISSING_GATE_EVIDENCE"]);
  });
});

describe("inventory and identity", () => {
  it("rejects an uninstalled model, a digest mismatch and an unverified registry digest", () => {
    const a = fixtureProfile("m-a", CODER_GATES);
    const notInstalled = new GovernedModelRouterService({ customModels: [a], now: () => NOW });
    notInstalled.applyInstalledInventory([]);
    expect(reasonsFor(catchRoute(notInstalled, request()), "m-a")).toEqual(["NOT_INSTALLED"]);

    const mismatch = new GovernedModelRouterService({ customModels: [a], now: () => NOW });
    const readiness = mismatch.applyInstalledInventory([{ name: "m-a", digest: "0".repeat(64) }]);
    expect(readiness.find((r) => r.modelId === "m-a")).toMatchObject({ installed: true, digestMatches: false, routable: false });
    expect(reasonsFor(catchRoute(mismatch, request()), "m-a")).toEqual(["DIGEST_MISMATCH"]);

    const unverified = { ...a, modelId: "m-u", digestVerified: false, gateEvidence: a.gateEvidence.map((e) => ({ ...e, modelId: "m-u" })) };
    const r3 = new GovernedModelRouterService({ customModels: [unverified], now: () => NOW });
    r3.applyInstalledInventory([{ name: "m-u", digest: unverified.modelDigest! }]);
    expect(reasonsFor(catchRoute(r3, request()), "m-u")).toEqual(expect.arrayContaining(["DIGEST_UNVERIFIED", "MISSING_GATE_EVIDENCE"]));
  });

  it("rejects a malformed inventory and is left with nothing routable", () => {
    const router = routerWith([fixtureProfile("m-a", CODER_GATES)]);
    expect(router.routeModel(request()).selectedModelId).toBe("m-a");
    expect(() => router.applyInstalledInventory([{ name: "m-a" } as never])).toThrowError(ModelRoutingError);
    expect(() => router.applyInstalledInventory("not-an-array" as never)).toThrowError(ModelRoutingError);
    expect(reasonsFor(catchRoute(router, request()), "m-a")).toEqual(["INVENTORY_NOT_VERIFIED"]);
  });

  it("is not affected by tampering with a profile object after construction, and rejects proprietary profiles", () => {
    const weak = fixtureProfile("m-weak", ["G1_STRUCTURED_JSON"]);
    const router = new GovernedModelRouterService({ customModels: [weak], now: () => NOW });
    router.applyInstalledInventory([{ name: "m-weak", digest: weak.modelDigest! }]);
    const hashBefore = router.registryHash;

    // Tamper with the caller's object: grant itself the missing gates.
    (weak.gateEvidence as unknown[]).push(...fixtureProfile("m-weak", CODER_GATES).gateEvidence);
    expect(reasonsFor(catchRoute(router, request()), "m-weak")).toEqual(["MISSING_GATE_EVIDENCE"]);
    expect(router.registryHash).toBe(hashBefore);
    expect(() => {
      (router.getModelProfile("m-weak")!.gateEvidence as unknown[]).push({});
    }).toThrow();

    expect(
      () => new GovernedModelRouterService({ customModels: [{ ...weak, modelId: "hosted", isProprietaryHosted: true } as never] })
    ).toThrowError(ProprietaryModelRejectedError);
  });
});

describe("resource governance", () => {
  it("rejects on context overflow, memory budget, inference budget and unmeasured latency", () => {
    const a = fixtureProfile("m-a", CODER_GATES, { medianMs: 60_000 });
    const router = routerWith([a]);
    expect(reasonsFor(catchRoute(router, request({ estimatedContextTokens: 5000 })), "m-a")).toEqual(["CONTEXT_OVERFLOW"]);
    expect(reasonsFor(catchRoute(router, request({ availableMemoryMb: 600 })), "m-a")).toEqual(["MEMORY_BUDGET_EXCEEDED"]);
    expect(reasonsFor(catchRoute(router, request({ stepBudgetMs: 30_000 })), "m-a")).toEqual(["LATENCY_EXCEEDS_STEP_BUDGET"]);
    expect(reasonsFor(catchRoute(router, request({ remainingBudgetMs: 45_000 })), "m-a")).toEqual(["LATENCY_EXCEEDS_REMAINING_BUDGET"]);

    const unmeasured = fixtureProfile("m-n", CODER_GATES, {
      latencyProfile: { expectedStepLatencyMs: 5_000, observed: null, timeoutThresholdMs: 150_000 },
    });
    // An expected value is not a measurement and does not make the model routable.
    expect(reasonsFor(catchRoute(routerWith([unmeasured]), request()), "m-n")).toEqual(["LATENCY_UNMEASURED"]);
  });

  it("allows only one distinct model to hold an execution slot", () => {
    const router = routerWith([fixtureProfile("m-a", CODER_GATES), fixtureProfile("m-b", CODER_GATES, { medianMs: 20_000 })]);
    const releaseB = router.acquireExecutionSlot("m-b", "agent-1");
    // m-a would normally be preferred, but another model is loaded.
    const decision = router.routeModel(request());
    expect(decision.selectedModelId).toBe("m-b");
    expect(decision.rejectedCandidates.find((c) => c.modelId === "m-a")!.reasons.map((r) => r.code)).toEqual(["CONCURRENCY_LIMIT"]);
    expect(() => router.acquireExecutionSlot("m-a", "agent-2")).toThrowError(/RESOURCE_EXHAUSTED/);
    // The same model may be shared.
    const releaseB2 = router.acquireExecutionSlot("m-b", "agent-3");
    releaseB();
    releaseB2();
    expect(router.routeModel(request()).selectedModelId).toBe("m-a");
    expect(() => router.acquireExecutionSlot("unknown", "agent-4")).toThrowError(/not registered/);
  });
});

describe("governed fallback", () => {
  it("falls back only to another qualifying model and preserves the request", () => {
    const router = routerWith([fixtureProfile("m-a", CODER_GATES), fixtureProfile("m-b", CODER_GATES, { medianMs: 20_000 })]);
    const first = router.routeModel(request({ runId: "run-9" }));
    const fallback = router.resolveFallback(first, "MODEL_REQUEST_TIMEOUT");

    expect(fallback.selectedModelId).toBe("m-b");
    expect(fallback.isFallback).toBe(true);
    expect(fallback.fallbackChain).toEqual([{ modelId: "m-a", reason: "MODEL_REQUEST_TIMEOUT" }]);
    expect(fallback.request).toEqual(first.request);
    expect(fallback.requiredGates).toEqual(first.requiredGates);
    expect(fallback.rejectedCandidates.find((c) => c.modelId === "m-a")!.reasons.map((r) => r.code)).toEqual(["EXCLUDED_AFTER_FAILURE"]);
    expect(fallback.decisionHash).not.toBe(first.decisionHash);

    // No third candidate: the next fallback is rejected, never widened to an unqualified model.
    expect(() => router.resolveFallback(fallback, "MODEL_REQUEST_TIMEOUT")).toThrowError(NoQualifiedModelError);
    expect(() => router.resolveFallback(first, " ")).toThrowError(/failure reason/);
  });

  it("never falls back to an installed model that lacks the role's evidence", () => {
    const router = routerWith([fixtureProfile("m-a", CODER_GATES), fixtureProfile("m-g1", ["G1_STRUCTURED_JSON"])]);
    const first = router.routeModel(request());
    expect(first.selectedModelId).toBe("m-a");
    expect(() => router.resolveFallback(first, "MODEL_PROVIDER_UNAVAILABLE")).toThrowError(NoQualifiedModelError);
  });
});

describe("assignment verification", () => {
  it("accepts only an assignment for the same task, tenant, role, model and digest", () => {
    const decision = routerWith([fixtureProfile("m-a", CODER_GATES)]).routeModel(request());
    const assignment = toModelAssignment(decision);
    const expected = { taskId: "task-1", tenantId: "tenant-a", role: "CODER", modelId: "m-a", modelDigest: digestOf("m-a") };

    expect(assertModelAssignmentMatches(assignment, expected).modelId).toBe("m-a");
    for (const wrong of [
      { ...expected, taskId: "task-2" },
      { ...expected, tenantId: "tenant-b" },
      { ...expected, role: "REVIEWER" },
      { ...expected, modelId: "m-b" },
      { ...expected, modelDigest: "0".repeat(64) },
    ]) {
      expect(() => assertModelAssignmentMatches(assignment, wrong)).toThrowError(ModelAssignmentViolationError);
    }
    for (const invalid of [undefined, null, "m-a", {}, { modelId: "m-a" }]) {
      expect(() => assertModelAssignmentMatches(invalid, expected)).toThrowError(ModelAssignmentViolationError);
    }
  });
});
