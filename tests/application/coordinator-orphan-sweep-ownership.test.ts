import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { issueOwnership } from "../../src/adapters/workspace/owner-marker.js";
import { RunCoordinator } from "../../src/application/index.js";
import { createDefaultInProcessPolicy } from "../../src/domain/policy.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { computeRecoveryDedupToken } from "../../src/domain/mutation-intent.js";
import { createAndActivateContract } from "./test-helpers.js";

const exists = (p: string) => fs.stat(p).then(() => true, () => false);
const MARKER = ".emerald-owner.json";
const TTL_MS = 10_000;

/**
 * COORDINATOR-LEVEL evidence for the orphan sweep: `RunCoordinator.cleanupOrphanedWorkspacesSafely` with a real
 * SqliteStateStore (run + lease rows) and a real NodeFsWorkspaceAdapter. The adapter-level protocol (move aside,
 * re-verify, restore) is covered separately in tests/adapters/node-fs-workspace-owned-disposal.test.ts; here the
 * subject is the authoritative activity decision made with the ownership marker's own run and lease identity.
 *
 * The workspace under test is deliberately NOT resolvable to a run by id/metadata ("ghost-run"), so the first
 * (identity-less) activity check says "inactive" and only the marker's lease can keep it alive.
 */
describe("Coordinator orphan sweep honours the ownership marker's run and lease", { timeout: 30000 }, () => {
  let root: string;
  let adapter: NodeFsWorkspaceAdapter;
  let clock: SettableClock;
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;

  beforeEach(async () => {
    root = path.join(os.tmpdir(), `emerald-orphan-sweep-${crypto.randomUUID()}`);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    root = await fs.realpath(root);
    adapter = new NodeFsWorkspaceAdapter({ workspaceRoot: root });
    clock = new SettableClock();
    store = new SqliteStateStore();
    coordinator = new RunCoordinator(store, clock, undefined, adapter);
    coordinator.registerWorker({
      workerId: "worker-N",
      hostname: "localhost",
      pid: 1,
      status: "ACTIVE",
      createdAt: clock.nowIso(),
      lastHeartbeatAt: clock.nowIso(),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    store.close();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  /** A real run claimed by worker-N: returns the identity a newer attempt's marker would carry. */
  function claimedAttempt(label: string): { runId: string; leaseId: string } {
    const task = coordinator.createTask({ title: label, inputPayload: { n: 1 } });
    createAndActivateContract(store, task.taskId, { policy: createDefaultInProcessPolicy(`policy-${label}`) });
    const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3 });
    coordinator.queueRun(run.runId);
    const { lease } = coordinator.claimRun(run.runId, "worker-N", TTL_MS);
    return { runId: run.runId, leaseId: lease.leaseId };
  }

  /** A workspace directory whose genuine (authenticated) marker names `owner`, not resolvable to any run by id. */
  async function plantWorkspace(
    workspaceId: string,
    owner: { runId: string; leaseId: string },
    metadataRunId = "ghost-run"
  ): Promise<string> {
    const dir = path.join(root, workspaceId);
    await fs.mkdir(dir, { mode: 0o700 });
    await fs.writeFile(path.join(dir, MARKER), issueOwnership(root, workspaceId, owner));
    await fs.writeFile(path.join(dir, ".emerald-workspace.json"), JSON.stringify({ workspaceId, runId: metadataRunId, taskId: "ghost-task" }));
    await fs.writeFile(path.join(dir, "work.txt"), "newer attempt's data");
    return dir;
  }

  const leftovers = async () => (await fs.readdir(root)).filter((n) => n.startsWith(".disposing-") || n.startsWith(".disposed-"));

  it("a workspace whose marker names a newer, ACTIVE lease is neither deleted nor mutated; the authority is asked with the marker's identity", async () => {
    const newer = claimedAttempt("newer");
    const dir = await plantWorkspace("ws-newer", newer);
    const markerBefore = await fs.readFile(path.join(dir, MARKER), "utf8");
    const spy = vi.spyOn(coordinator, "isWorkspaceAuthoritativelyActive");

    const reclaimed = await coordinator.cleanupOrphanedWorkspacesSafely();

    expect(reclaimed).toEqual([]);
    expect(await fs.readFile(path.join(dir, "work.txt"), "utf8")).toBe("newer attempt's data");
    expect(await fs.readFile(path.join(dir, MARKER), "utf8")).toBe(markerBefore);
    expect(await leftovers()).toEqual([]);
    // first look has no identity (and says inactive); the second look carries the marker's run and lease
    expect(spy.mock.calls.map(([id, owner]) => [id, owner])).toEqual([
      ["ws-newer", undefined],
      ["ws-newer", { runId: newer.runId, leaseId: newer.leaseId }],
    ]);
    expect(spy.mock.results[0]!.value).toBe(false);
    expect(spy.mock.results[1]!.value).toBe(true);
  });

  it("control: once that lease has expired, the same directory IS reclaimed (the check is not vacuous)", async () => {
    const attempt = claimedAttempt("expiring");
    const dir = await plantWorkspace("ws-expiring", attempt);
    clock.advanceMs(TTL_MS + 1000);

    const reclaimed = await coordinator.cleanupOrphanedWorkspacesSafely();

    expect(reclaimed).toEqual(["ws-expiring"]);
    expect(await exists(dir)).toBe(false);
    expect(await leftovers()).toEqual([]);
  });

  it("a marker whose lease belongs to a DIFFERENT run does not count as live (identity must match, not just the lease id)", async () => {
    const attempt = claimedAttempt("real");
    const dir = await plantWorkspace("ws-mismatch", { runId: "some-other-run", leaseId: attempt.leaseId });

    const reclaimed = await coordinator.cleanupOrphanedWorkspacesSafely();

    expect(reclaimed).toEqual(["ws-mismatch"]);
    expect(await exists(dir)).toBe(false);
    // ...and the real attempt's lease was not touched by the sweep
    expect(coordinator.getLease(attempt.leaseId)!.state).toBe("ACTIVE");
  });

  it("an exception from the authoritative FIRST check fails closed: nothing deleted, sweep resolves, failure is reported", async () => {
    const dir = await plantWorkspace("ws-unknown", claimedAttempt("any"));
    vi.spyOn(store, "getRun").mockImplementation(() => {
      throw new Error("state store unavailable");
    });
    const skipped: Array<[string, string]> = [];

    await expect(coordinator.cleanupOrphanedWorkspacesSafely({ onSkipped: (n, r) => skipped.push([n, r]) })).resolves.toEqual([]);

    expect(await fs.readFile(path.join(dir, "work.txt"), "utf8")).toBe("newer attempt's data");
    expect(skipped).toEqual([["ws-unknown", "activity check failed: state store unavailable"]]);
  });

  it("an exception from the lease-tied SECOND check keeps the directory and is reported", async () => {
    const dir = await plantWorkspace("ws-lease-err", claimedAttempt("any"));
    vi.spyOn(store, "getLease").mockImplementation(() => {
      throw new Error("lease table locked");
    });
    const skipped: Array<[string, string]> = [];

    await expect(coordinator.cleanupOrphanedWorkspacesSafely({ onSkipped: (n, r) => skipped.push([n, r]) })).resolves.toEqual([]);

    expect(await exists(dir)).toBe(true);
    expect(skipped).toEqual([["ws-lease-err", "not deleted: lease table locked"]]);
  });
  describe("a crashed run whose workspace mutations are not reconciled still owns its workspace (rollback hold)", () => {
    /** RUNNING run whose lease expired, optionally with an unreconciled COMMITTED mutation intent (what the retry gate holds). */
    function crashedRun(withUnreconciledMutation: boolean): { runId: string; leaseId: string } {
      const attempt = claimedAttempt(withUnreconciledMutation ? "held" : "plain");
      coordinator.startRun(attempt.runId, "worker-N", attempt.leaseId);
      if (withUnreconciledMutation) {
        store.recordIntent({
          mutationId: "m1", runId: attempt.runId, workerLeaseId: attempt.leaseId, relativePath: "x.ts", canonicalPath: path.join(root, "x.ts"),
          parentMutationId: null, pathMutationVersion: 1, baseDigest: "a".repeat(64), expectedResultingDigest: "b".repeat(64),
          snapshotRef: path.join(root, "snap"), recoveryDedupToken: computeRecoveryDedupToken(attempt.runId, "m1", "COMMITTED"),
          lifecycleStatus: "COMMITTED", createdAt: 1, updatedAt: 1,
        });
      }
      clock.advanceMs(TTL_MS + 1000); // the worker lease expires
      return attempt;
    }

    it("the sweep does not discard it, and the retry gate agrees (the run is held, not requeued)", async () => {
      const attempt = crashedRun(true);
      const dir = await plantWorkspace("ws-held", attempt, attempt.runId);

      const reclaimed = await coordinator.cleanupOrphanedWorkspacesSafely();

      expect(reclaimed).toEqual([]);
      expect(await fs.readFile(path.join(dir, "work.txt"), "utf8")).toBe("newer attempt's data");
      expect(coordinator.isWorkspaceAuthoritativelyActive("ws-held")).toBe(true);
      expect(coordinator.recoverExpiredRuns().heldForRollbackRunIds).toContain(attempt.runId);
      expect(await exists(dir)).toBe(true); // still there after the gate too
    });

    it("control: the same expired crashed run WITHOUT unreconciled mutations is an orphan and is reclaimed", async () => {
      const attempt = crashedRun(false);
      const dir = await plantWorkspace("ws-plain", attempt, attempt.runId);

      expect(coordinator.isWorkspaceAuthoritativelyActive("ws-plain")).toBe(false);
      expect(await coordinator.cleanupOrphanedWorkspacesSafely()).toEqual(["ws-plain"]);
      expect(await exists(dir)).toBe(false);
    });
  });
});
