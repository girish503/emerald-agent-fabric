/**
 * REST decomposition with the governed model router supplied by the composition root.
 *
 * Real: buildFastifyServer (default orchestrator), SqliteStateStore, RunCoordinator, GovernedModelRouterService,
 *       createInventoriedModelRouter, the approved registry.
 * Fixture: the installed-model inventory provider; the `m-fixture` model with synthetic gate evidence.
 * No provider is contacted, no inference is run and no worker executes anything.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { submitDurableTask } from "../../src/application/durable-submission.js";
import { GovernedModelRouterService } from "../../src/application/governed-model-router.js";
import { createInventoriedModelRouter } from "../../src/application/model-router-factory.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import type { ModelCapabilityGateId, OpenWeightModelProfile } from "../../src/domain/model-routing.js";
import { SystemClock } from "../../src/ports/clock.port.js";
import { buildFastifyServer, type PrincipalRecord } from "../../src/transport/http/server.js";

const TOKEN = "alpha-operator-token-aaaaaaaa1";
const principals: PrincipalRecord[] = [{ token: TOKEN, principalId: "a-op", tenantId: "tenant-alpha", role: "operator" }];
const QWEN = "qwen2.5-coder:1.5b";
const QWEN_DIGEST = "sha256:d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668";
const FIXTURE_DIGEST = `sha256:${"e".repeat(64)}`;
const GATES: ModelCapabilityGateId[] = ["G1_STRUCTURED_JSON", "G3_CODE_UNDERSTANDING", "G4_SINGLE_FILE_REPAIR"];

const fixtureModel: OpenWeightModelProfile = {
  modelId: "m-fixture",
  modelTag: "m-fixture",
  modelDigest: FIXTURE_DIGEST,
  digestVerified: true,
  parameterCount: "fixture",
  openSourceLicense: "Apache-2.0",
  isProprietaryHosted: false,
  declaredCapabilities: [],
  gateEvidence: GATES.map((gateId) => ({
    gateId,
    outcome: "PASSED" as const,
    modelId: "m-fixture",
    modelDigest: FIXTURE_DIGEST,
    evaluationVersion: "fixture-eval-1",
    evidenceRef: `fixture:${gateId}`,
    summary: "synthetic fixture evidence",
    observedAt: "2026-11-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  })),
  contextLimits: { maxInputTokens: 4096, maxOutputTokens: 2048, contextWindowBytes: 16384 },
  latencyProfile: {
    expectedStepLatencyMs: null,
    observed: { sampleCount: 10, minMs: 1000, medianMs: 1000, p90Ms: 1000, maxMs: 1000, measuredAt: "2026-11-01T00:00:00.000Z", source: "fixture" },
    timeoutThresholdMs: 150_000,
  },
  hardwareRequirements: { residentMemoryMb: 500, residentMemoryMeasured: false, quantization: "Q4_K_M", accelerator: "CPU" },
};

describe("REST decomposition with governed model routing", () => {
  let dir: string;
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;
  let server: FastifyInstance | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-rest-routing-"));
    store = new SqliteStateStore({ location: path.join(dir, "state.db") });
    coordinator = new RunCoordinator(store, new SystemClock());
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const submitMission = () =>
    submitDurableTask(store, coordinator, {
      task: "Implement and verify feature X",
      operation: "feature_x",
      capabilities: ["workspace.file.read", "workspace.file.write", "process.execute", "workspace.query"],
      tenantId: "tenant-alpha",
      timeoutMs: 120_000,
    });

  const decompose = (taskId: string) =>
    server!.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/decompose`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        subtasks: [
          {
            subtaskId: "rest-code",
            role: "CODER",
            objective: "Implement code via REST",
            dependencies: [],
            customCapabilities: ["workspace.file.read", "workspace.file.write"],
            resourceLimits: { timeoutMs: 40_000, maxAttempts: 1 },
          },
        ],
      },
    });

  it("rejects decomposition with the routing reason when the real registry has no qualifying model", async () => {
    const routing = await createInventoriedModelRouter(async () => [{ name: QWEN, digest: QWEN_DIGEST }]);
    expect(routing.inventoryError).toBeNull();
    expect(routing.readiness.filter((r) => r.routable).map((r) => r.modelId)).toEqual([QWEN]);
    server = buildFastifyServer({ store, coordinator, principals, modelRouter: routing.router });

    const mission = submitMission();
    const res = await decompose(mission.taskId);

    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain("cannot be assigned a model");
    expect(res.payload).toContain("MISSING_GATE_EVIDENCE");
    expect(store.getTask(`${mission.taskId}__sub__rest-code`)).toBeNull();
    expect(store.getEventsForRun(mission.runId).some((e) => e.eventType === "model.routing.rejected")).toBe(true);
  });

  it("rejects decomposition when the inventory could not be read (nothing routable)", async () => {
    const routing = await createInventoriedModelRouter(async () => {
      throw new Error("connection refused");
    });
    expect(routing.inventoryError).toBe("connection refused");
    expect(routing.readiness).toEqual([]);
    server = buildFastifyServer({ store, coordinator, principals, modelRouter: routing.router });

    const mission = submitMission();
    const res = await decompose(mission.taskId);
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain("INVENTORY_NOT_VERIFIED");
    expect(store.getTask(`${mission.taskId}__sub__rest-code`)).toBeNull();
  });

  it("treats a malformed inventory as unreadable", async () => {
    const routing = await createInventoriedModelRouter(async () => [{ name: QWEN } as never]);
    expect(routing.inventoryError).toMatch(/string name and digest/);
    expect(() =>
      routing.router.routeModel({
        role: "CODER",
        tenantId: "t",
        taskId: "x",
        contractId: "c",
        remainingBudgetMs: 0,
        stepBudgetMs: 0,
        estimatedContextTokens: 0,
      })
    ).toThrowError(/INVENTORY_NOT_VERIFIED/);
  });

  it("assigns a model to the child when a qualifying model exists", async () => {
    const router = new GovernedModelRouterService({ customModels: [fixtureModel] });
    router.applyInstalledInventory([{ name: "m-fixture", digest: FIXTURE_DIGEST }]);
    server = buildFastifyServer({ store, coordinator, principals, modelRouter: router });

    const mission = submitMission();
    const res = await decompose(mission.taskId);
    expect(res.statusCode).toBe(201);

    const child = store.getTask(`${mission.taskId}__sub__rest-code`);
    expect((child!.inputPayload as { modelAssignment: unknown }).modelAssignment).toMatchObject({
      modelId: "m-fixture",
      modelDigest: FIXTURE_DIGEST,
      role: "CODER",
      tenantId: "tenant-alpha",
      taskId: `${mission.taskId}__sub__rest-code`,
    });
  });
});
