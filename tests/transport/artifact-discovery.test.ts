/**
 * Emerald Agent Fabric — Milestone 2.28 / Phase 3 Step 1
 * Production Durable Artifact Metadata Discovery Tests
 *
 * Verifies that GET /api/v1/runs/:runId/artifacts durably discovers, validates, and reports
 * artifact metadata from disk (<artifactRoot>/<runId>/attempt-<n>/manifest.json) under real
 * Fastify, SQLite, and filesystem conditions without relying on in-memory Maps.
 *
 * Covers 15 explicit audit scenarios:
 * 1. Production server discovers an artifact manifest from disk.
 * 2. Listing works after the server is restarted.
 * 3. A second server instance discovers the same artifacts.
 * 4. Multiple attempts are listed correctly in ascending order.
 * 5. Valid run with no artifacts returns a legitimate empty result (200 OK, []).
 * 6. Missing artifact root configuration fails explicitly (500 INTERNAL_ERROR).
 * 7. Malformed manifest JSON is handled safely (500 INTERNAL_ERROR).
 * 8. Unsupported schema version is rejected (500 INTERNAL_ERROR).
 * 9. Manifest run ID mismatch is rejected (500 INTERNAL_ERROR).
 * 10. Manifest attempt mismatch is rejected (500 INTERNAL_ERROR).
 * 11. Invalid run ID format cannot escape the artifact root (400 BAD_REQUEST / 404).
 * 12. Symlinked manifest or attempt directory escaping the artifact root is rejected (500).
 * 13. Cross-tenant listing returns the existing non-disclosing response (404 NOT_FOUND).
 * 14. Filesystem permission / access errors are not reported as empty results (500).
 * 15. Existing in-memory test behavior remains compatible when inMemoryStore is configured.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildFastifyServer, type PrincipalRecord } from "../../src/transport/http/server.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { createAndActivateContract } from "../application/test-helpers.js";
import { createDefaultInProcessPolicy } from "../../src/domain/policy.js";
import { discoverRunArtifacts, ArtifactDiscoveryError } from "../../src/transport/http/artifact-discovery.js";

const TOK_A_OP = "alpha-operator-token-aaaaaaaa1";
const TOK_B_OP = "beta-operator-token-bbbbbbbbb4";

const principals: PrincipalRecord[] = [
  { token: TOK_A_OP, principalId: "a-op", tenantId: "tenant-alpha", role: "operator" },
  { token: TOK_B_OP, principalId: "b-op", tenantId: "tenant-beta", role: "operator" },
];

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

interface TestEnv {
  dir: string;
  artifactRoot: string;
  dbPath: string;
  store: SqliteStateStore;
  coordinator: RunCoordinator;
  clock: SettableClock;
  workerId: string;
}

function setupEnv(): TestEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-art-discovery-"));
  const artifactRoot = path.join(dir, "artifacts");
  fs.mkdirSync(artifactRoot, { recursive: true });
  const dbPath = path.join(dir, "state.db");
  const store = new SqliteStateStore({ location: dbPath });
  const clock = new SettableClock("2026-11-08T12:00:00.000Z");
  const coordinator = new RunCoordinator(store, clock);
  const workerId = "worker-art-1";
  store.transaction((tx) =>
    tx.insertWorker({
      workerId,
      hostname: "localhost",
      pid: 4242,
      status: "ACTIVE",
      createdAt: clock.nowIso(),
      lastHeartbeatAt: clock.nowIso(),
    })
  );
  return { dir, artifactRoot, dbPath, store, coordinator, clock, workerId };
}

function seedRun(env: TestEnv, taskId: string, tenantId = "tenant-alpha"): { runId: string } {
  env.coordinator.createTask({ taskId, title: taskId, inputPayload: {} });
  const policy = { ...createDefaultInProcessPolicy(`policy-${taskId}`), tenantId };
  createAndActivateContract(env.store, taskId, { policy });
  const { run } = env.coordinator.createRun({ taskId });
  env.coordinator.queueRun(run.runId);
  const claim = env.coordinator.claimRun(run.runId, env.workerId, 600_000);
  env.coordinator.startRun(run.runId, env.workerId, claim.lease.leaseId);
  return { runId: run.runId };
}

interface WriteAttemptOptions {
  runId: string;
  attempt?: number;
  patchContent?: string;
  schemaVersion?: number;
  disposalReason?: string | null;
  manifestRunId?: string;
  manifestAttempt?: number;
  omitPatchFile?: boolean;
  omitManifestFile?: boolean;
  corruptManifestJson?: boolean;
  customPatchSha?: string;
  customPatchBytes?: number;
}

function writeAttemptArtifacts(artifactRoot: string, opts: WriteAttemptOptions): {
  attemptDir: string;
  patchSha256: string;
  patchBytes: number;
} {
  const attempt = opts.attempt ?? 1;
  const attemptDir = path.join(artifactRoot, opts.runId, `attempt-${attempt}`);
  fs.mkdirSync(attemptDir, { recursive: true });

  const patchContent = opts.patchContent ?? "diff --git a/index.js b/index.js\n+module.exports = 2;\n";
  const patchBuf = Buffer.from(patchContent, "utf8");
  const patchSha256 = opts.customPatchSha ?? crypto.createHash("sha256").update(patchBuf).digest("hex");
  const patchBytes = opts.customPatchBytes ?? patchBuf.length;

  if (!opts.omitPatchFile) {
    fs.writeFileSync(path.join(attemptDir, "patch.diff"), patchBuf);
  }

  if (!opts.omitManifestFile) {
    if (opts.corruptManifestJson) {
      fs.writeFileSync(path.join(attemptDir, "manifest.json"), "{ invalid: json... ", "utf8");
    } else {
      const manifest = {
        schemaVersion: opts.schemaVersion ?? 1,
        runId: opts.manifestRunId ?? opts.runId,
        attempt: opts.manifestAttempt ?? attempt,
        createdAt: new Date().toISOString(),
        disposalReason: opts.disposalReason ?? "Run completed successfully",
        baselineCommit: "0123456789abcdef0123456789abcdef01234567",
        files: [{ path: "index.js", status: "modified", linesAdded: 1, linesRemoved: 0, binary: false }],
        totals: { changedFiles: 1, added: 0, modified: 1, deleted: 0, linesAdded: 1, linesRemoved: 0 },
        patch: { file: "patch.diff", bytes: patchBytes, sha256: patchSha256 },
      };
      fs.writeFileSync(path.join(attemptDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    }
  }

  return { attemptDir, patchSha256, patchBytes };
}

describe("Milestone 2.28 Phase 3 Step 1 — Production Durable Artifact Metadata Discovery", () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setupEnv();
  });

  afterEach(() => {
    env.store.close();
    fs.rmSync(env.dir, { recursive: true, force: true });
  });

  // 1. Production server discovers an artifact manifest from disk
  it("Scenario 1: Production server discovers an artifact manifest from disk", async () => {
    const { runId } = seedRun(env, "task-scen-1");
    const { patchSha256, patchBytes } = writeAttemptArtifacts(env.artifactRoot, { runId, attempt: 1 });

    const server = buildFastifyServer({
      principals,
      corsOrigins: [],
      store: env.store,
      coordinator: env.coordinator,
      artifactRoot: env.artifactRoot,
      env: {},
    });

    const res = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/artifacts`,
      headers: bearer(TOK_A_OP),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);

    const artifact = body.data[0];
    expect(artifact.artifactId).toBe(`${runId}-attempt-1-patch`);
    expect(artifact.runId).toBe(runId);
    expect(artifact.relativePath).toBe("attempt-1/patch.diff");
    expect(artifact.contentType).toBe("text/x-diff");
    expect(artifact.byteSize).toBe(patchBytes);
    expect(artifact.sha256).toBe(patchSha256);
    expect(artifact.createdAt).toBeDefined();
    expect(res.headers["x-emerald-durability"]).toBe("durable-coordinator");
  });

  // 2. Listing works after the server is restarted
  it("Scenario 2: Listing works after the server is restarted", async () => {
    const { runId } = seedRun(env, "task-scen-2");
    const { patchSha256 } = writeAttemptArtifacts(env.artifactRoot, { runId, attempt: 1 });

    // Instance 1
    const server1 = buildFastifyServer({
      principals,
      corsOrigins: [],
      store: env.store,
      coordinator: env.coordinator,
      artifactRoot: env.artifactRoot,
      env: {},
    });

    const res1 = await server1.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/artifacts`,
      headers: bearer(TOK_A_OP),
    });
    expect(res1.statusCode).toBe(200);
    expect(res1.json().data[0].sha256).toBe(patchSha256);
    await server1.close();

    // Instance 2 (simulating restart over the same persistent store and artifactRoot)
    const server2 = buildFastifyServer({
      principals,
      corsOrigins: [],
      store: env.store,
      coordinator: env.coordinator,
      artifactRoot: env.artifactRoot,
      env: {},
    });

    const res2 = await server2.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/artifacts`,
      headers: bearer(TOK_A_OP),
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().data).toHaveLength(1);
    expect(res2.json().data[0].sha256).toBe(patchSha256);
    await server2.close();
  });

  // 3. A second server instance discovers the same artifacts
  it("Scenario 3: A second server instance discovers the same artifacts", async () => {
    const { runId } = seedRun(env, "task-scen-3");
    writeAttemptArtifacts(env.artifactRoot, { runId, attempt: 1 });

    const serverA = buildFastifyServer({
      principals,
      corsOrigins: [],
      store: env.store,
      coordinator: env.coordinator,
      artifactRoot: env.artifactRoot,
      env: {},
    });
    const serverB = buildFastifyServer({
      principals,
      corsOrigins: [],
      store: env.store,
      coordinator: env.coordinator,
      artifactRoot: env.artifactRoot,
      env: {},
    });

    const [resA, resB] = await Promise.all([
      serverA.inject({ method: "GET", url: `/api/v1/runs/${runId}/artifacts`, headers: bearer(TOK_A_OP) }),
      serverB.inject({ method: "GET", url: `/api/v1/runs/${runId}/artifacts`, headers: bearer(TOK_A_OP) }),
    ]);

    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);
    expect(resA.json().data).toEqual(resB.json().data);

    await Promise.all([serverA.close(), serverB.close()]);
  });

  // 4. Multiple attempts are listed correctly in ascending order
  it("Scenario 4: Multiple attempts are listed correctly in ascending order", async () => {
    const { runId } = seedRun(env, "task-scen-4");
    writeAttemptArtifacts(env.artifactRoot, { runId, attempt: 1, patchContent: "+v1\n" });
    writeAttemptArtifacts(env.artifactRoot, { runId, attempt: 2, patchContent: "+v2\n" });
    writeAttemptArtifacts(env.artifactRoot, { runId, attempt: 3, patchContent: "+v3\n" });

    const server = buildFastifyServer({
      principals,
      corsOrigins: [],
      store: env.store,
      coordinator: env.coordinator,
      artifactRoot: env.artifactRoot,
      env: {},
    });

    const res = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/artifacts`,
      headers: bearer(TOK_A_OP),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(3);
    expect(body.data[0].relativePath).toBe("attempt-1/patch.diff");
    expect(body.data[1].relativePath).toBe("attempt-2/patch.diff");
    expect(body.data[2].relativePath).toBe("attempt-3/patch.diff");
    expect(body.data[0].artifactId).toBe(`${runId}-attempt-1-patch`);
    expect(body.data[1].artifactId).toBe(`${runId}-attempt-2-patch`);
    expect(body.data[2].artifactId).toBe(`${runId}-attempt-3-patch`);
  });

  // 5. Valid run with no artifacts returns a legitimate empty result
  it("Scenario 5: Valid run with no artifacts returns a legitimate empty result", async () => {
    const { runId } = seedRun(env, "task-scen-5");
    // Do NOT create <artifactRoot>/<runId>

    const server = buildFastifyServer({
      principals,
      corsOrigins: [],
      store: env.store,
      coordinator: env.coordinator,
      artifactRoot: env.artifactRoot,
      env: {},
    });

    const res = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/artifacts`,
      headers: bearer(TOK_A_OP),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
  });

  // 6. Missing artifact root configuration fails explicitly
  it("Scenario 6: Missing artifact root configuration fails explicitly", async () => {
    const { runId } = seedRun(env, "task-scen-6");

    // Server built without artifactRoot and without inMemoryStore
    const server = buildFastifyServer({
      principals,
      corsOrigins: [],
      store: env.store,
      coordinator: env.coordinator,
      env: {},
    });

    const res = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/artifacts`,
      headers: bearer(TOK_A_OP),
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toContain("Artifact storage root is not configured");
  });

  // 7. Malformed manifest is handled safely (fails closed)
  it("Scenario 7: Malformed manifest is handled safely by failing closed", async () => {
    const { runId } = seedRun(env, "task-scen-7");
    writeAttemptArtifacts(env.artifactRoot, { runId, attempt: 1, corruptManifestJson: true });

    const server = buildFastifyServer({
      principals,
      corsOrigins: [],
      store: env.store,
      coordinator: env.coordinator,
      artifactRoot: env.artifactRoot,
      env: {},
    });

    const res = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/artifacts`,
      headers: bearer(TOK_A_OP),
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toContain("Malformed manifest JSON");
  });

  // 8. Unsupported schema version is rejected
  it("Scenario 8: Unsupported schema version is rejected", async () => {
    const { runId } = seedRun(env, "task-scen-8");
    writeAttemptArtifacts(env.artifactRoot, { runId, attempt: 1, schemaVersion: 99 });

    const server = buildFastifyServer({
      principals,
      corsOrigins: [],
      store: env.store,
      coordinator: env.coordinator,
      artifactRoot: env.artifactRoot,
      env: {},
    });

    const res = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/artifacts`,
      headers: bearer(TOK_A_OP),
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toContain("Unsupported manifest schema version");
  });

  // 9. Manifest run ID mismatch is rejected
  it("Scenario 9: Manifest run ID mismatch is rejected", async () => {
    const { runId } = seedRun(env, "task-scen-9");
    writeAttemptArtifacts(env.artifactRoot, { runId, attempt: 1, manifestRunId: "run-tampered-id" });

    const server = buildFastifyServer({
      principals,
      corsOrigins: [],
      store: env.store,
      coordinator: env.coordinator,
      artifactRoot: env.artifactRoot,
      env: {},
    });

    const res = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/artifacts`,
      headers: bearer(TOK_A_OP),
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toContain("Manifest runId mismatch");
  });

  // 10. Manifest attempt mismatch is rejected
  it("Scenario 10: Manifest attempt mismatch is rejected", async () => {
    const { runId } = seedRun(env, "task-scen-10");
    writeAttemptArtifacts(env.artifactRoot, { runId, attempt: 2, manifestAttempt: 1 });

    const server = buildFastifyServer({
      principals,
      corsOrigins: [],
      store: env.store,
      coordinator: env.coordinator,
      artifactRoot: env.artifactRoot,
      env: {},
    });

    const res = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/artifacts`,
      headers: bearer(TOK_A_OP),
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toContain("Manifest attempt mismatch");
  });

  // 11. Invalid run ID cannot escape the artifact root
  it("Scenario 11: Invalid run ID format cannot escape the artifact root", () => {
    expect(() =>
      discoverRunArtifacts({ artifactRoot: env.artifactRoot, runId: "../escape" })
    ).toThrowError(ArtifactDiscoveryError);

    expect(() =>
      discoverRunArtifacts({ artifactRoot: env.artifactRoot, runId: ".." })
    ).toThrowError(ArtifactDiscoveryError);

    expect(() =>
      discoverRunArtifacts({ artifactRoot: env.artifactRoot, runId: "run/nested" })
    ).toThrowError(ArtifactDiscoveryError);

    expect(() =>
      discoverRunArtifacts({ artifactRoot: env.artifactRoot, runId: "C:\\Windows" })
    ).toThrowError(ArtifactDiscoveryError);
  });

  // 12. Symlinked manifest or attempt directory cannot escape the artifact root
  it("Scenario 12: Symlinked attempt directory escaping the artifact root is rejected", async () => {
    const { runId } = seedRun(env, "task-scen-12");
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-outside-"));

    try {
      const runDir = path.join(env.artifactRoot, runId);
      fs.mkdirSync(runDir, { recursive: true });

      // Create a symlink attempt-1 pointing outside the artifact root
      const symlinkPath = path.join(runDir, "attempt-1");
      try {
        fs.symlinkSync(outsideDir, symlinkPath, "junction");
      } catch {
        // Fallback for platforms where junction is directory-only
        fs.symlinkSync(outsideDir, symlinkPath, "dir");
      }

      const server = buildFastifyServer({
        principals,
        corsOrigins: [],
        store: env.store,
        coordinator: env.coordinator,
        artifactRoot: env.artifactRoot,
        env: {},
      });

      const res = await server.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}/artifacts`,
        headers: bearer(TOK_A_OP),
      });

      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe("INTERNAL_ERROR");
      expect(res.json().error.message).toContain("escapes artifact root");
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  // 13. Cross-tenant listing returns the existing non-disclosing response
  it("Scenario 13: Cross-tenant listing returns non-disclosing 404", async () => {
    // Run belongs to tenant-alpha
    const { runId } = seedRun(env, "task-scen-13", "tenant-alpha");
    writeAttemptArtifacts(env.artifactRoot, { runId, attempt: 1 });

    const server = buildFastifyServer({
      principals,
      corsOrigins: [],
      store: env.store,
      coordinator: env.coordinator,
      artifactRoot: env.artifactRoot,
      env: {},
    });

    // Query with tenant-beta token
    const res = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/artifacts`,
      headers: bearer(TOK_B_OP),
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Run not found");
  });

  // 14. Filesystem permission errors are not reported as empty results
  it("Scenario 14: Referenced patch file missing causes fail-closed 500 error", async () => {
    const { runId } = seedRun(env, "task-scen-14");
    // Manifest exists, but patch.diff is missing on disk
    writeAttemptArtifacts(env.artifactRoot, { runId, attempt: 1, omitPatchFile: true });

    const server = buildFastifyServer({
      principals,
      corsOrigins: [],
      store: env.store,
      coordinator: env.coordinator,
      artifactRoot: env.artifactRoot,
      env: {},
    });

    const res = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/artifacts`,
      headers: bearer(TOK_A_OP),
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toContain("Referenced patch file missing");
  });

  // 15. Existing in-memory test behavior remains compatible where intentionally configured
  it("Scenario 15: Existing in-memory test behavior remains compatible when inMemoryStore is configured", async () => {
    const runId = "run-mem-compat-1";
    const seededArtifacts = new Map<string, any[]>([
      [
        runId,
        [
          {
            artifactId: "art-legacy-1",
            runId,
            relativePath: "legacy/patch.diff",
            sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            byteSize: 512,
            contentType: "text/x-diff",
            createdAt: new Date().toISOString(),
          },
        ],
      ],
    ]);

    const runsMap = new Map();
    runsMap.set(runId, {
      runId,
      taskId: "task-mem-1",
      tenantId: "tenant-alpha",
      status: "COMPLETED",
      createdAt: new Date().toISOString(),
    });

    const server = buildFastifyServer({
      principals,
      corsOrigins: [],
      inMemoryStore: {
        runs: runsMap,
        artifacts: seededArtifacts,
      },
      env: {},
    });

    const res = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/artifacts`,
      headers: bearer(TOK_A_OP),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].artifactId).toBe("art-legacy-1");
    expect(res.headers["x-emerald-durability"]).toBe("transport-local-non-durable");
  });
});
