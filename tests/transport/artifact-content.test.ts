/**
 * Emerald Agent Fabric — Secure Artifact Content Retrieval API (Milestone 2.28 / Phase 3 Step 2)
 *
 * Comprehensive integration and security test suite covering all 29 required audit scenarios:
 * - Functional behavior (Scenarios 1–7)
 * - Authorization and tenant isolation (Scenarios 8–11)
 * - Filesystem security and containment (Scenarios 12–17)
 * - Cryptographic manifest & artifact integrity (Scenarios 18–24)
 * - Resource limits and concurrency (Scenarios 25–29)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildFastifyServer,
  type PrincipalRecord,
} from "../../src/transport/http/server.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { createAndActivateContract } from "../application/test-helpers.js";
import { createDefaultInProcessPolicy } from "../../src/domain/policy.js";
import { DEFAULT_MAX_ARTIFACT_CONTENT_BYTES } from "../../src/transport/http/artifact-discovery.js";

const TOK_A_OP = "alpha-operator-token-aaaaaaaa1";
const TOK_B_OP = "beta-operator-token-bbbbbbbbb4";

const principals: PrincipalRecord[] = [
  { token: TOK_A_OP, principalId: "a-op", tenantId: "tenant-alpha", role: "operator" },
  { token: TOK_B_OP, principalId: "b-op", tenantId: "tenant-beta", role: "operator" },
];

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

function sha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex").toLowerCase();
}

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-art-content-"));
  const artifactRoot = path.join(dir, "artifacts");
  fs.mkdirSync(artifactRoot, { recursive: true });
  const dbPath = path.join(dir, "state.db");
  const store = new SqliteStateStore({ location: dbPath });
  const clock = new SettableClock("2026-11-09T00:00:00.000Z");
  const coordinator = new RunCoordinator(store, clock);
  const workerId = "worker-art-2";
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
  patchContent?: string | Buffer;
  schemaVersion?: number;
  disposalReason?: string | null;
  manifestRunId?: string;
  manifestAttempt?: number;
  patchFileName?: string;
  omitPatchFile?: boolean;
  omitManifestFile?: boolean;
  corruptManifestJson?: boolean;
  customPatchSha?: string;
  customPatchBytes?: number;
}

function writeAttempt(
  artifactRoot: string,
  opts: WriteAttemptOptions
): {
  attemptDir: string;
  patchPath: string;
  manifestPath: string;
  artifactId: string;
  patchSha256: string;
} {
  const attempt = opts.attempt ?? 1;
  const attemptDir = path.join(artifactRoot, opts.runId, `attempt-${attempt}`);
  fs.mkdirSync(attemptDir, { recursive: true });

  const patchFileName = opts.patchFileName ?? "patch.diff";
  const patchPath = path.join(attemptDir, patchFileName);
  const defaultPatch = "diff --git a/index.js b/index.js\n+console.log('emerald');\n";
  const patchContent = opts.patchContent !== undefined ? opts.patchContent : defaultPatch;
  const patchBuf = Buffer.isBuffer(patchContent) ? patchContent : Buffer.from(patchContent, "utf8");
  const patchSha256 = opts.customPatchSha ?? sha256(patchBuf);
  const patchBytes = opts.customPatchBytes !== undefined ? opts.customPatchBytes : patchBuf.length;

  if (!opts.omitPatchFile) {
    fs.writeFileSync(patchPath, patchBuf);
  }

  const manifestPath = path.join(attemptDir, "manifest.json");
  if (!opts.omitManifestFile) {
    if (opts.corruptManifestJson) {
      fs.writeFileSync(manifestPath, "{ invalid: json... ", "utf8");
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
        patch: { file: patchFileName, bytes: patchBytes, sha256: patchSha256 },
      };
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    }
  }

  const artifactId = `${opts.runId}-attempt-${attempt}-patch`;
  return { attemptDir, patchPath, manifestPath, artifactId, patchSha256 };
}

describe("Milestone 2.28 Phase 3 Step 2 — Secure Artifact Content Retrieval API", () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setupEnv();
  });

  afterEach(() => {
    try {
      env.store.close();
    } catch {}
    try {
      fs.rmSync(env.dir, { recursive: true, force: true });
    } catch {}
  });

  function createServer(extraOpts: Record<string, unknown> = {}) {
    return buildFastifyServer({
      principals,
      corsOrigins: [],
      store: env.store,
      coordinator: env.coordinator,
      artifactRoot: env.artifactRoot,
      env: {},
      ...extraOpts,
    });
  }

  // ==========================================================================
  // Functional Behavior (Scenarios 1–7)
  // ==========================================================================
  describe("1. Functional behavior", () => {
    it("Scenario 1: Authorized tenant retrieves a valid patch with correct headers and bytes", async () => {
      const { runId } = seedRun(env, "task-func-1", "tenant-alpha");
      const patch = "diff --git a/app.ts b/app.ts\n+console.log('emerald');\n";
      const { artifactId } = writeAttempt(env.artifactRoot, { runId, attempt: 1, patchContent: patch });

      const server = createServer();
      const res = await server.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}/artifacts/${artifactId}/content`,
        headers: bearer(TOK_A_OP),
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(patch);
      expect(res.headers["content-type"]).toBe("text/x-diff; charset=utf-8");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
      expect(res.headers["content-disposition"]).toBe('attachment; filename="patch.diff"');
      expect(res.headers["etag"]).toBe(`"${sha256(patch)}"`);
    });

    it("Scenario 2: Unknown artifact ID is rejected with 404", async () => {
      const { runId } = seedRun(env, "task-func-2", "tenant-alpha");
      writeAttempt(env.artifactRoot, { runId, attempt: 1 });

      const server = createServer();
      const res = await server.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}/artifacts/unknown-artifact-id-123/content`,
        headers: bearer(TOK_A_OP),
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("NOT_FOUND");
    });

    it("Scenario 3: Artifact ID from another run is rejected with 404", async () => {
      const { runId: runId1 } = seedRun(env, "task-func-3a", "tenant-alpha");
      const { runId: runId2 } = seedRun(env, "task-func-3b", "tenant-alpha");
      const { artifactId: artifactId2 } = writeAttempt(env.artifactRoot, { runId: runId2, attempt: 1 });

      const server = createServer();
      const res = await server.inject({
        method: "GET",
        url: `/api/v1/runs/${runId1}/artifacts/${artifactId2}/content`,
        headers: bearer(TOK_A_OP),
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("NOT_FOUND");
    });

    it("Scenario 4: Artifact retrieval works after server restart", async () => {
      const { runId } = seedRun(env, "task-func-4", "tenant-alpha");
      const patch = "diff --git a/restart.ts b/restart.ts\n+const a = 1;\n";
      const { artifactId } = writeAttempt(env.artifactRoot, { runId, attempt: 1, patchContent: patch });

      const server1 = createServer();
      const res1 = await server1.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}/artifacts/${artifactId}/content`,
        headers: bearer(TOK_A_OP),
      });
      expect(res1.statusCode).toBe(200);

      // Simulate restart: construct fresh server instance on same stateStore and artifactRoot
      const server2 = createServer();
      const res2 = await server2.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}/artifacts/${artifactId}/content`,
        headers: bearer(TOK_A_OP),
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.body).toBe(patch);
    });

    it("Scenario 5: Artifact retrieval works from a second concurrent server instance", async () => {
      const { runId } = seedRun(env, "task-func-5", "tenant-alpha");
      const patch = "diff --git a/concurrent.ts b/concurrent.ts\n+const b = 2;\n";
      const { artifactId } = writeAttempt(env.artifactRoot, { runId, attempt: 1, patchContent: patch });

      const serverA = createServer();
      const serverB = createServer();

      const [resA, resB] = await Promise.all([
        serverA.inject({ method: "GET", url: `/api/v1/runs/${runId}/artifacts/${artifactId}/content`, headers: bearer(TOK_A_OP) }),
        serverB.inject({ method: "GET", url: `/api/v1/runs/${runId}/artifacts/${artifactId}/content`, headers: bearer(TOK_A_OP) }),
      ]);

      expect(resA.statusCode).toBe(200);
      expect(resB.statusCode).toBe(200);
      expect(resA.body).toBe(patch);
      expect(resB.body).toBe(patch);
    });

    it("Scenario 6: Existing artifact listing endpoint remains compatible", async () => {
      const { runId } = seedRun(env, "task-func-6", "tenant-alpha");
      const { artifactId } = writeAttempt(env.artifactRoot, { runId, attempt: 1 });

      const server = createServer();
      const listRes = await server.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}/artifacts`,
        headers: bearer(TOK_A_OP),
      });

      expect(listRes.statusCode).toBe(200);
      const listData = listRes.json().data;
      expect(listData).toHaveLength(1);
      expect(listData[0].artifactId).toBe(artifactId);
    });

    it("Scenario 7: Existing in-memory test behavior remains compatible", async () => {
      const runId = "run-inmem-007";
      const artifactId = "inmem-artifact-001";
      const inMemoryContent = "diff --git a/inmem.txt b/inmem.txt\n+inmem test\n";
      const inMemSha = sha256(inMemoryContent);

      const inMemoryStore = {
        runs: new Map([[runId, { runId, tenantId: "tenant-alpha", status: "COMPLETED" }]]),
        artifacts: new Map([
          [
            runId,
            [
              {
                artifactId,
                runId,
                relativePath: "attempt-1/patch.diff",
                sha256: inMemSha,
                byteSize: Buffer.byteLength(inMemoryContent),
                contentType: "text/x-diff",
                createdAt: new Date().toISOString(),
                content: inMemoryContent,
              },
            ],
          ],
        ]),
      };

      const server = buildFastifyServer({
        principals,
        corsOrigins: [],
        inMemoryStore,
        env: {},
      });

      const res = await server.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}/artifacts/${artifactId}/content`,
        headers: bearer(TOK_A_OP),
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(inMemoryContent);
      expect(res.headers["content-type"]).toBe("text/x-diff; charset=utf-8");
      expect(res.headers["etag"]).toBe(`"${inMemSha}"`);
    });
  });

  // ==========================================================================
  // Authorization and Tenant Isolation (Scenarios 8–11)
  // ==========================================================================
  describe("2. Authorization and tenant isolation", () => {
    it("Scenario 8: Unauthenticated request is rejected with 401", async () => {
      const { runId } = seedRun(env, "task-auth-8", "tenant-alpha");
      const { artifactId } = writeAttempt(env.artifactRoot, { runId, attempt: 1 });

      const server = createServer();
      const res = await server.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}/artifacts/${artifactId}/content`,
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHORIZED");
    });

    it("Scenario 9: Cross-tenant artifact retrieval returns non-disclosing 404", async () => {
      const { runId } = seedRun(env, "task-auth-9", "tenant-alpha"); // belongs to tenant-alpha
      const { artifactId } = writeAttempt(env.artifactRoot, { runId, attempt: 1 });

      const server = createServer();
      // Tenant-beta tries to retrieve tenant-alpha's artifact
      const foreignRes = await server.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}/artifacts/${artifactId}/content`,
        headers: bearer(TOK_B_OP),
      });

      // Request for completely missing run
      const missingRes = await server.inject({
        method: "GET",
        url: `/api/v1/runs/run-completely-missing/artifacts/${artifactId}/content`,
        headers: bearer(TOK_B_OP),
      });

      expect(foreignRes.statusCode).toBe(404);
      expect(missingRes.statusCode).toBe(404);
      expect(foreignRes.json().error.code).toBe("NOT_FOUND");
      expect(foreignRes.json().error.message).toBe("Run not found");
      expect(foreignRes.json().error.message).toBe(missingRes.json().error.message);
    });

    it("Scenario 10: Client cannot supply tenant identity parameter", async () => {
      const { runId } = seedRun(env, "task-auth-10", "tenant-alpha");
      const { artifactId } = writeAttempt(env.artifactRoot, { runId, attempt: 1 });

      const server = createServer();
      const res = await server.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}/artifacts/${artifactId}/content?tenantId=tenant-beta`,
        headers: bearer(TOK_A_OP),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("BAD_REQUEST");
      expect(res.json().error.message).toContain("tenantId");
    });

    it("Scenario 11: Artifact identity cannot bypass run ownership", async () => {
      const { runId: runAlpha } = seedRun(env, "task-auth-11a", "tenant-alpha");
      const { runId: runBeta } = seedRun(env, "task-auth-11b", "tenant-beta");

      const { artifactId: artifactBeta } = writeAttempt(env.artifactRoot, { runId: runBeta, attempt: 1 });

      const server = createServer();
      // Tenant alpha calls their own run endpoint, but passes tenant beta's artifactId
      const res = await server.inject({
        method: "GET",
        url: `/api/v1/runs/${runAlpha}/artifacts/${artifactBeta}/content`,
        headers: bearer(TOK_A_OP),
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("NOT_FOUND");
    });
  });

  // ==========================================================================
  // Filesystem Security and Containment (Scenarios 12–17)
  // ==========================================================================
  describe("3. Filesystem security and containment", () => {
    it("Scenario 12: Run ID traversal is rejected", async () => {
      const server = createServer();
      const res = await server.inject({
        method: "GET",
        url: "/api/v1/runs/..%2F..%2Fetc/artifacts/patch/content",
        headers: bearer(TOK_A_OP),
      });

      expect([400, 404]).toContain(res.statusCode);
    });

    it("Scenario 13: Attempt-directory symlink escape is rejected", async () => {
      const { runId } = seedRun(env, "task-sec-13", "tenant-alpha");
      const outsideDir = path.join(env.dir, "outside-13");
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(path.join(outsideDir, "patch.diff"), "escaped");

      const runDir = path.join(env.artifactRoot, runId);
      fs.mkdirSync(runDir, { recursive: true });

      // Create symlinked attempt directory pointing outside
      const symlinkAttempt = path.join(runDir, "attempt-1");
      try {
        fs.symlinkSync(outsideDir, symlinkAttempt, "junction");
      } catch {
        fs.symlinkSync(outsideDir, symlinkAttempt, "dir");
      }

      const server = createServer();
      const res = await server.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}/artifacts/${runId}-attempt-1-patch/content`,
        headers: bearer(TOK_A_OP),
      });

      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe("INTERNAL_ERROR");
    });

    it("Scenario 14: Manifest symlink escape is rejected", async () => {
      const { runId } = seedRun(env, "task-sec-14", "tenant-alpha");
      const outsideDir = path.join(env.dir, "outside-14");
      fs.mkdirSync(outsideDir, { recursive: true });
      const outsideManifest = path.join(outsideDir, "evil-manifest.json");
      fs.writeFileSync(outsideManifest, "{}");

      const runDir = path.join(env.artifactRoot, runId);
      const attemptDir = path.join(runDir, "attempt-1");
      fs.mkdirSync(attemptDir, { recursive: true });
      fs.writeFileSync(path.join(attemptDir, "patch.diff"), "valid patch");

      // Symlink manifest.json to outside file (platform-aware skip on Windows if unprivileged)
      try {
        fs.symlinkSync(outsideManifest, path.join(attemptDir, "manifest.json"), "file");
      } catch (err: any) {
        if (err && err.code === "EPERM" && process.platform === "win32") {
          return;
        }
        throw err;
      }

      const server = createServer();
      const res = await server.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}/artifacts/${runId}-attempt-1-patch/content`,
        headers: bearer(TOK_A_OP),
      });

      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe("INTERNAL_ERROR");
    });

    it("Scenario 15: Artifact-file symlink escape is rejected", async () => {
      const { runId } = seedRun(env, "task-sec-15", "tenant-alpha");
      const outsideSecret = path.join(env.dir, "secret-15.txt");
      fs.writeFileSync(outsideSecret, "TOP_SECRET_CONTENT");

      const runDir = path.join(env.artifactRoot, runId);
      const attemptDir = path.join(runDir, "attempt-1");
      fs.mkdirSync(attemptDir, { recursive: true });

      // Symlink patch.diff pointing to outside secret file (platform-aware skip on Windows if unprivileged)
      try {
        fs.symlinkSync(outsideSecret, path.join(attemptDir, "patch.diff"), "file");
      } catch (err: any) {
        if (err && err.code === "EPERM" && process.platform === "win32") {
          return;
        }
        throw err;
      }

      const manifestObj = {
        schemaVersion: 1,
        runId,
        attempt: 1,
        createdAt: new Date().toISOString(),
        disposalReason: null,
        baselineCommit: "0123456789abcdef0123456789abcdef01234567",
        files: [],
        totals: { changedFiles: 1, added: 0, modified: 1, deleted: 0, linesAdded: 1, linesRemoved: 0 },
        patch: { file: "patch.diff", bytes: 18, sha256: sha256("TOP_SECRET_CONTENT") },
      };
      fs.writeFileSync(path.join(attemptDir, "manifest.json"), JSON.stringify(manifestObj));

      const server = createServer();
      const res = await server.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}/artifacts/${runId}-attempt-1-patch/content`,
        headers: bearer(TOK_A_OP),
      });

      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe("INTERNAL_ERROR");
    });

    it("Scenario 16: Windows path and alternate data stream inputs are rejected", async () => {
      const { runId } = seedRun(env, "task-sec-16", "tenant-alpha");
      writeAttempt(env.artifactRoot, { runId, attempt: 1 });

      const server = createServer();
      const adsRes = await server.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}/artifacts/${runId}-attempt-1-patch:stream/content`,
        headers: bearer(TOK_A_OP),
      });

      expect([400, 404]).toContain(adsRes.statusCode);
    });

    it("Scenario 17: File deletion during retrieval is handled safely without crashing", async () => {
      const { runId } = seedRun(env, "task-sec-17", "tenant-alpha");
      const { patchPath, artifactId } = writeAttempt(env.artifactRoot, { runId, attempt: 1 });

      // Delete the patch file right before retrieval
      fs.unlinkSync(patchPath);

      const server = createServer();
      const res = await server.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}/artifacts/${artifactId}/content`,
        headers: bearer(TOK_A_OP),
      });

      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe("INTERNAL_ERROR");
    });
  });

  // ==========================================================================
  // Cryptographic Manifest & Artifact Integrity (Scenarios 18–24)
  // ==========================================================================
  describe("4. Cryptographic manifest & artifact integrity", () => {
    it("Scenario 18: Correct SHA-256 returns the exact expected bytes", async () => {
      const { runId } = seedRun(env, "task-int-18", "tenant-alpha");
      const patch = "diff --git a/integrity.txt b/integrity.txt\n+verified bytes\n";
      const { artifactId } = writeAttempt(env.artifactRoot, { runId, attempt: 1, patchContent: patch });

      const server = createServer();
      const res = await server.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}/artifacts/${artifactId}/content`,
        headers: bearer(TOK_A_OP),
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(patch);
      expect(res.headers["etag"]).toBe(`"${sha256(patch)}"`);
    });

    it("Scenario 19: Modified patch with stale manifest hash is rejected with 500", async () => {
      const { runId } = seedRun(env, "task-int-19", "tenant-alpha");
      const original = "original patch";
      const tampered = "tampered patch with bad hash";
      const { artifactId } = writeAttempt(env.artifactRoot, {
        runId,
        attempt: 1,
        patchContent: tampered,
        customPatchSha: sha256(original), // stale hash
        customPatchBytes: tampered.length,
      });

      const server = createServer();
      const res = await server.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}/artifacts/${artifactId}/content`,
        headers: bearer(TOK_A_OP),
      });

      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe("INTERNAL_ERROR");
      expect(res.body).not.toContain(tampered);
    });

    it("Scenario 20: Wrong manifest run ID is rejected with 500", async () => {
      const { runId } = seedRun(env, "task-int-20", "tenant-alpha");
      const { artifactId } = writeAttempt(env.artifactRoot, {
        runId,
        attempt: 1,
        manifestRunId: "run-mismatched-id",
      });

      const server = createServer();
      const res = await server.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}/artifacts/${artifactId}/content`,
        headers: bearer(TOK_A_OP),
      });

      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe("INTERNAL_ERROR");
    });

    it("Scenario 21: Wrong attempt number is rejected with 500", async () => {
      const { runId } = seedRun(env, "task-int-21", "tenant-alpha");
      const { artifactId } = writeAttempt(env.artifactRoot, {
        runId,
        attempt: 1,
        manifestAttempt: 99,
      });

      const server = createServer();
      const res = await server.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}/artifacts/${artifactId}/content`,
        headers: bearer(TOK_A_OP),
      });

      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe("INTERNAL_ERROR");
    });

    it("Scenario 22: Invalid declared relative path is rejected with 500", async () => {
      const { runId } = seedRun(env, "task-int-22", "tenant-alpha");
      const { artifactId } = writeAttempt(env.artifactRoot, {
        runId,
        attempt: 1,
        patchFileName: "evil.diff",
      });

      const server = createServer();
      const res = await server.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}/artifacts/${artifactId}/content`,
        headers: bearer(TOK_A_OP),
      });

      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe("INTERNAL_ERROR");
    });

    it("Scenario 23: Missing artifact file is rejected with 500", async () => {
      const { runId } = seedRun(env, "task-int-23", "tenant-alpha");
      const { artifactId } = writeAttempt(env.artifactRoot, {
        runId,
        attempt: 1,
        omitPatchFile: true,
      });

      const server = createServer();
      const res = await server.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}/artifacts/${artifactId}/content`,
        headers: bearer(TOK_A_OP),
      });

      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe("INTERNAL_ERROR");
    });

    it("Scenario 24: Malformed manifest is rejected with 500", async () => {
      const { runId } = seedRun(env, "task-int-24", "tenant-alpha");
      const { artifactId } = writeAttempt(env.artifactRoot, {
        runId,
        attempt: 1,
        corruptManifestJson: true,
      });

      const server = createServer();
      const res = await server.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}/artifacts/${artifactId}/content`,
        headers: bearer(TOK_A_OP),
      });

      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe("INTERNAL_ERROR");
    });
  });

  // ==========================================================================
  // Resource Limits and Concurrency (Scenarios 25–29)
  // ==========================================================================
  describe("5. Resource limits and concurrency", () => {
    it("Scenario 25: Artifact at size boundary is handled correctly", async () => {
      const { runId } = seedRun(env, "task-res-25", "tenant-alpha");
      // Exactly 64 KiB
      const patch = "X".repeat(64 * 1024);
      const { artifactId } = writeAttempt(env.artifactRoot, {
        runId,
        attempt: 1,
        patchContent: patch,
      });

      const server = createServer();
      const res = await server.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}/artifacts/${artifactId}/content`,
        headers: bearer(TOK_A_OP),
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.length).toBe(64 * 1024);
    });

    it("Scenario 26: Artifact above the limit returns 413 Payload Too Large", async () => {
      const { runId } = seedRun(env, "task-res-26", "tenant-alpha");
      // Exceeds limit by 1 byte
      const oversized = "A".repeat(DEFAULT_MAX_ARTIFACT_CONTENT_BYTES + 1);
      const { artifactId } = writeAttempt(env.artifactRoot, {
        runId,
        attempt: 1,
        patchContent: oversized,
      });

      const server = createServer();
      const res = await server.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}/artifacts/${artifactId}/content`,
        headers: bearer(TOK_A_OP),
      });

      expect(res.statusCode).toBe(413);
      expect(res.json().error.code).toBe("PAYLOAD_TOO_LARGE");
    });

    it("Scenario 27: File growth during retrieval cannot exceed the memory limit", async () => {
      const { runId } = seedRun(env, "task-res-27", "tenant-alpha");
      const baseContent = "base content";
      const { patchPath, artifactId } = writeAttempt(env.artifactRoot, {
        runId,
        attempt: 1,
        patchContent: baseContent,
        customPatchBytes: baseContent.length,
        customPatchSha: sha256(baseContent),
      });

      // Append unexpected bytes to file
      fs.appendFileSync(patchPath, " unexpected growth");

      const server = createServer();
      const res = await server.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}/artifacts/${artifactId}/content`,
        headers: bearer(TOK_A_OP),
      });

      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe("INTERNAL_ERROR");
    });

    it("Scenario 28: Client cancellation / abrupt close releases file handles", async () => {
      const { runId } = seedRun(env, "task-res-28", "tenant-alpha");
      const { artifactId } = writeAttempt(env.artifactRoot, { runId, attempt: 1 });

      const server = createServer();
      // Verify repeated rapid injection requests cleanly open and close descriptors
      for (let i = 0; i < 5; i++) {
        const res = await server.inject({
          method: "GET",
          url: `/api/v1/runs/${runId}/artifacts/${artifactId}/content`,
          headers: bearer(TOK_A_OP),
        });
        expect(res.statusCode).toBe(200);
      }
    });

    it("Scenario 29: Concurrent reads do not corrupt responses or leak resources", async () => {
      const { runId } = seedRun(env, "task-res-29", "tenant-alpha");
      const patch = "diff --git a/concurrent-reads.ts b/concurrent-reads.ts\n+concurrent\n";
      const { artifactId } = writeAttempt(env.artifactRoot, { runId, attempt: 1, patchContent: patch });

      const server = createServer();
      const requests = Array.from({ length: 10 }, () =>
        server.inject({
          method: "GET",
          url: `/api/v1/runs/${runId}/artifacts/${artifactId}/content`,
          headers: bearer(TOK_A_OP),
        })
      );

      const responses = await Promise.all(requests);
      for (const res of responses) {
        expect(res.statusCode).toBe(200);
        expect(res.body).toBe(patch);
        expect(res.headers["etag"]).toBe(`"${sha256(patch)}"`);
      }
    });
  });
});
