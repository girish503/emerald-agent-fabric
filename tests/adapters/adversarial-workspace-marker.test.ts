/**
 * Emerald Agent Fabric — Adversarial Workspace Marker Mutation Verification
 *
 * Verifies that host workspace disposal and orphan cleanup fail closed under all
 * tenant-side marker tampering scenarios (deletion, truncation, corruption, forgery,
 * replay, and post-rename tombstone tampering).
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as syncFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import {
  OWNER_KEY_FILE,
  OWNER_LEDGER_DIR,
  OWNER_MARKER,
} from "../../src/adapters/workspace/owner-marker.js";
import { WorkspaceOwnershipError } from "../../src/domain/errors.js";
import type { WorkspaceSpec } from "../../src/domain/workspace.js";

const OWNER_A = { runId: "run-1", leaseId: "lease-A" };
const OWNER_B = { runId: "run-1", leaseId: "lease-B" };
const OWNER_OTHER = { runId: "run-2", leaseId: "lease-other" };

function spec(workspaceId: string, runId = "run-1"): WorkspaceSpec {
  return {
    workspaceId,
    runId,
    taskId: "task-1",
    maxWorkspaceBytes: 1024 * 1024,
    maxFileSizeBytes: 1024 * 1024,
  } as WorkspaceSpec;
}

class HookedAdapter extends NodeFsWorkspaceAdapter {
  onAfterOwnerCheck?: (targetDir: string) => Promise<void>;
  onAfterTombstoneRename?: (tombstoneDir: string, targetDir: string) => Promise<void>;

  protected override async afterOwnerCheck(targetDir: string): Promise<void> {
    await this.onAfterOwnerCheck?.(targetDir);
  }

  protected override async afterTombstoneRename(tombstoneDir: string, targetDir: string): Promise<void> {
    await this.onAfterTombstoneRename?.(tombstoneDir, targetDir);
  }
}

describe("Adversarial Workspace Marker Mutation & Trust Boundary Verification", () => {
  let root: string;
  let adapter: HookedAdapter;

  const markerPath = (id: string) => path.join(root, id, OWNER_MARKER);
  const entries = () =>
    syncFs.readdirSync(root).filter((n) => n !== OWNER_KEY_FILE && n !== OWNER_LEDGER_DIR).sort();

  beforeEach(async () => {
    root = syncFs.realpathSync(syncFs.mkdtempSync(path.join(os.tmpdir(), "emerald-adv-marker-")));
    adapter = new HookedAdapter({ workspaceRoot: root });
  });

  afterEach(async () => {
    try {
      syncFs.rmSync(root, { recursive: true, force: true });
    } catch {}
  });

  // ---------------------------------------------------------------------------
  // Case 1: Tenant deletes .emerald-owner.json
  // ---------------------------------------------------------------------------
  it("Case 1: Tenant deletes .emerald-owner.json -> disposal fails closed; victim & peer workspaces survive", async () => {
    await adapter.provisionWorkspace(spec("ws-1"), OWNER_A);
    await adapter.provisionWorkspace(spec("ws-2", "run-2"), OWNER_OTHER);

    await fs.writeFile(path.join(root, "ws-1", "canary-1.txt"), "canary-data-1");
    await fs.writeFile(path.join(root, "ws-2", "canary-2.txt"), "canary-data-2");

    // Tenant in ws-1 deletes the marker
    await fs.unlink(markerPath("ws-1"));
    expect(syncFs.existsSync(markerPath("ws-1"))).toBe(false);

    // Disposal must fail closed
    await expect(adapter.disposeWorkspace("ws-1", OWNER_A)).rejects.toBeInstanceOf(WorkspaceOwnershipError);

    // Both workspaces must survive intact
    expect(syncFs.existsSync(path.join(root, "ws-1", "canary-1.txt"))).toBe(true);
    expect(syncFs.readFileSync(path.join(root, "ws-1", "canary-1.txt"), "utf8")).toBe("canary-data-1");
    expect(syncFs.existsSync(path.join(root, "ws-2", "canary-2.txt"))).toBe(true);
    expect(syncFs.readFileSync(path.join(root, "ws-2", "canary-2.txt"), "utf8")).toBe("canary-data-2");
    expect(entries()).toEqual(["ws-1", "ws-2"]);

    // Orphan cleanup with ws-2 active: must skip ws-1 (unowned / unauthenticated marker) and leave ws-2 untouched
    const skipped: string[] = [];
    const reclaimed = await adapter.cleanupOrphanedWorkspaces(new Set<string>(["ws-2"]), {
      onSkipped: (_name, reason) => skipped.push(reason),
    });
    expect(reclaimed).toEqual([]);
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped).toEqual([expect.stringMatching(/not authenticated|no ownership marker|absent|missing/)]);
    expect(syncFs.existsSync(path.join(root, "ws-1", "canary-1.txt"))).toBe(true);
    expect(syncFs.existsSync(path.join(root, "ws-2", "canary-2.txt"))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Case 2: Tenant truncates or corrupts the marker
  // ---------------------------------------------------------------------------
  it("Case 2: Tenant corrupts or truncates .emerald-owner.json -> disposal fails closed and preserves workspace", async () => {
    await adapter.provisionWorkspace(spec("ws-1"), OWNER_A);
    await fs.writeFile(path.join(root, "ws-1", "canary.txt"), "data");

    // Truncated JSON
    await fs.writeFile(markerPath("ws-1"), '{"runId":"run-1","leaseId":');
    await expect(adapter.disposeWorkspace("ws-1", OWNER_A)).rejects.toBeInstanceOf(WorkspaceOwnershipError);
    expect(syncFs.existsSync(path.join(root, "ws-1", "canary.txt"))).toBe(true);

    // Random non-JSON garbage bytes
    await fs.writeFile(markerPath("ws-1"), crypto.randomBytes(64));
    await expect(adapter.disposeWorkspace("ws-1", OWNER_A)).rejects.toBeInstanceOf(WorkspaceOwnershipError);
    expect(syncFs.existsSync(path.join(root, "ws-1", "canary.txt"))).toBe(true);

    // Empty file
    await fs.writeFile(markerPath("ws-1"), "");
    await expect(adapter.disposeWorkspace("ws-1", OWNER_A)).rejects.toBeInstanceOf(WorkspaceOwnershipError);
    expect(syncFs.existsSync(path.join(root, "ws-1", "canary.txt"))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Case 3: Tenant replaces marker with a forged payload
  // ---------------------------------------------------------------------------
  it("Case 3: Tenant creates forged marker without valid host MAC -> fails closed", async () => {
    await adapter.provisionWorkspace(spec("ws-1"), OWNER_A);
    await fs.writeFile(path.join(root, "ws-1", "canary.txt"), "data");

    // Forged payload with legitimate leaseId but fake MAC
    const forged = {
      runId: "run-1",
      leaseId: "lease-A",
      nonce: crypto.randomBytes(16).toString("hex"),
      mac: crypto.randomBytes(32).toString("hex"),
    };
    await fs.writeFile(markerPath("ws-1"), JSON.stringify(forged));

    await expect(adapter.disposeWorkspace("ws-1", OWNER_A)).rejects.toBeInstanceOf(WorkspaceOwnershipError);
    expect(syncFs.existsSync(path.join(root, "ws-1", "canary.txt"))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Case 4: Stale-marker replay across attempts
  // ---------------------------------------------------------------------------
  it("Case 4: Replaying Attempt 1 marker into Attempt 2 workspace fails closed due to external ledger nonce", async () => {
    // Attempt 1 provisions
    await adapter.provisionWorkspace(spec("ws-1"), OWNER_A);
    const attempt1Marker = await fs.readFile(markerPath("ws-1"), "utf8");

    // Attempt 1 completes/restarts; unowned reset occurs; Attempt 2 provisions ws-1
    await adapter.disposeWorkspace("ws-1"); // unowned dispose
    await adapter.provisionWorkspace(spec("ws-1"), OWNER_B);
    await fs.writeFile(path.join(root, "ws-1", "b-data.txt"), "attempt-2-work");

    // Attacker inside ws-1 overwrites Attempt 2 marker with Attempt 1's authentic marker
    await fs.writeFile(markerPath("ws-1"), attempt1Marker);

    // Stale owner A cannot dispose
    await expect(adapter.disposeWorkspace("ws-1", OWNER_A)).rejects.toBeInstanceOf(WorkspaceOwnershipError);
    // Rightful owner B also fails closed because marker was tampered
    await expect(adapter.disposeWorkspace("ws-1", OWNER_B)).rejects.toBeInstanceOf(WorkspaceOwnershipError);

    // Attempt 2 data survives intact
    expect(syncFs.readFileSync(path.join(root, "ws-1", "b-data.txt"), "utf8")).toBe("attempt-2-work");
    expect(entries()).toEqual(["ws-1"]);
  });

  // ---------------------------------------------------------------------------
  // Case 5: Cleanup encounters invalid marker after workspace rename-to-tombstone
  // ---------------------------------------------------------------------------
  it("Case 5: Marker corrupted after initial check during rename-to-tombstone -> restored/preserved, never deleted", async () => {
    await adapter.provisionWorkspace(spec("ws-1"), OWNER_A);
    await fs.writeFile(path.join(root, "ws-1", "work.txt"), "important-data");

    // Interleave corruption between early check and tombstone inspection
    adapter.onAfterTombstoneRename = async (tombstoneDir: string) => {
      // Attacker or concurrent process corrupts marker inside the private tombstone directory
      await fs.writeFile(path.join(tombstoneDir, OWNER_MARKER), "corrupted-during-rename");
    };

    await expect(adapter.disposeWorkspace("ws-1", OWNER_A)).rejects.toBeInstanceOf(WorkspaceOwnershipError);

    // The directory was either restored to ws-1 or preserved as .disposing-ws-1-*; never deleted!
    const remaining = entries();
    const hasOriginalOrTombstone =
      remaining.includes("ws-1") || remaining.some((n) => n.startsWith(".disposing-ws-1-"));
    expect(hasOriginalOrTombstone).toBe(true);

    const targetDir = remaining.includes("ws-1")
      ? path.join(root, "ws-1")
      : path.join(root, remaining.find((n) => n.startsWith(".disposing-ws-1-"))!);
    expect(syncFs.readFileSync(path.join(targetDir, "work.txt"), "utf8")).toBe("important-data");
  });

  // ---------------------------------------------------------------------------
  // Case 6: Cross-run isolation — invalid marker never authorizes peer deletion
  // ---------------------------------------------------------------------------
  it("Case 6: Marker copied from ws-1 into ws-2 never authorizes deletion of ws-2", async () => {
    await adapter.provisionWorkspace(spec("ws-1", "run-1"), OWNER_A);
    await adapter.provisionWorkspace(spec("ws-2", "run-2"), OWNER_OTHER);

    await fs.writeFile(path.join(root, "ws-1", "data-1.txt"), "data-1");
    await fs.writeFile(path.join(root, "ws-2", "data-2.txt"), "data-2");

    // Attacker copies ws-1 marker into ws-2
    await fs.copyFile(markerPath("ws-1"), markerPath("ws-2"));

    // Attempting disposal of ws-2 under either owner must be rejected
    await expect(adapter.disposeWorkspace("ws-2", OWNER_A)).rejects.toBeInstanceOf(WorkspaceOwnershipError);
    await expect(adapter.disposeWorkspace("ws-2", OWNER_OTHER)).rejects.toBeInstanceOf(WorkspaceOwnershipError);

    // ws-2 is completely preserved
    expect(syncFs.existsSync(path.join(root, "ws-2", "data-2.txt"))).toBe(true);
    expect(syncFs.readFileSync(path.join(root, "ws-2", "data-2.txt"), "utf8")).toBe("data-2");
    expect(entries()).toEqual(["ws-1", "ws-2"]);
  });
});
