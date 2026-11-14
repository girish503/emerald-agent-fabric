/**
 * Worker host governed model gate — regression tests.
 *
 * Real: runWorkerHost, GovernedModelRouterService, the approved model registry, SqliteStateStore.
 * Fixture: the installed-model inventory (injected; no provider is contacted).
 * No run is queued, so no inference request and no container workload can occur.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { WorkerHostConfigError, type WorkerLogRecord, runWorkerHost } from "../../src/application/worker-host.js";
import type { AgentBrainPort } from "../../src/ports/agent-brain.port.js";

const APPROVED_MODEL = "qwen2.5-coder:1.5b";
const APPROVED_DIGEST = "d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668";

describe("worker host governed model gate", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-model-gate-"));
    dbPath = path.join(dir, "fabric.db");
    new SqliteStateStore({ location: dbPath }).close();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const start = (
    model: string | undefined,
    inventory: () => Promise<readonly { name: string; digest: string }[]>,
    logs: WorkerLogRecord[] = []
  ) =>
    runWorkerHost({
      dbPath,
      once: true,
      modelProvider: "ollama",
      physicalProvider: "none",
      ...(model !== undefined ? { model } : {}),
      modelInventoryProvider: inventory,
      signal: new AbortController().signal,
      log: (record) => logs.push(record),
    });

  it("refuses a model that is not in the approved registry, without consulting the provider", async () => {
    let inventoryCalls = 0;
    const inventory = async () => {
      inventoryCalls++;
      return [{ name: "gpt-4o", digest: "a".repeat(64) }];
    };
    await expect(start("gpt-4o", inventory)).rejects.toThrowError(WorkerHostConfigError);
    await expect(start("qwen2.5-coder:3b", inventory)).rejects.toThrowError(/not in the approved open-weight model registry/);
    await expect(start(undefined, inventory)).rejects.toThrowError(WorkerHostConfigError);
    expect(inventoryCalls).toBe(0);
  });

  it("refuses a registered model that is not installed", async () => {
    await expect(start("qwen2.5-coder:7b", async () => [{ name: APPROVED_MODEL, digest: APPROVED_DIGEST }])).rejects.toThrowError(
      /registered but not installed/
    );
  });

  it("refuses an installed model whose digest differs from the registry", async () => {
    await expect(start(APPROVED_MODEL, async () => [{ name: APPROVED_MODEL, digest: "0".repeat(64) }])).rejects.toThrowError(
      /does not match the approved registry digest/
    );
  });

  it("fails closed when the inventory cannot be read", async () => {
    await expect(
      start(APPROVED_MODEL, async () => {
        throw new Error("connection refused");
      })
    ).rejects.toThrowError(/Cannot confirm that model/);
  });

  it("starts with an approved, installed, digest-matching model and records the decision", async () => {
    const logs: WorkerLogRecord[] = [];
    const result = await start(APPROVED_MODEL, async () => [{ name: APPROVED_MODEL, digest: `sha256:${APPROVED_DIGEST}` }], logs);
    expect(result.runsProcessed).toBe(0);
    expect(result.errors).toBe(0);
    const approval = logs.find((l) => l.event === "worker.model.approved");
    expect(approval).toMatchObject({ model: APPROVED_MODEL, modelDigest: `sha256:${APPROVED_DIGEST}` });
  });

  it("skips the gate when an agent brain is injected (no model is selected by the host)", async () => {
    let inventoryCalls = 0;
    const brain: AgentBrainPort = { proposeAction: async () => ({ finishReason: "GOAL_REACHED" }) };
    const result = await runWorkerHost({
      dbPath,
      once: true,
      modelProvider: "ollama",
      physicalProvider: "none",
      model: "unregistered-model",
      agentBrain: brain,
      modelInventoryProvider: async () => {
        inventoryCalls++;
        return [];
      },
      signal: new AbortController().signal,
      log: () => {},
    });
    expect(result.errors).toBe(0);
    expect(inventoryCalls).toBe(0);
  });
});
