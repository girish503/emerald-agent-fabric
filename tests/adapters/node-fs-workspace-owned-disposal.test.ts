import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { OWNER_KEY_FILE, OWNER_LEDGER_DIR, issueOwnership } from "../../src/adapters/workspace/owner-marker.js";
import { WorkspaceOwnershipError } from "../../src/domain/errors.js";
import type { WorkspaceSpec } from "../../src/domain/workspace.js";

const exists = (p: string) => fs.stat(p).then(() => true, () => false);
const OWNER_A = { runId: "run-1", leaseId: "lease-A" };
const OWNER_B = { runId: "run-1", leaseId: "lease-B" };

function spec(workspaceId: string): WorkspaceSpec {
  return {
    workspaceId,
    runId: "run-1",
    taskId: "task-1",
    maxWorkspaceBytes: 1024 * 1024,
    maxFileSizeBytes: 1024 * 1024,
  } as WorkspaceSpec;
}

/** Adapter whose protected seams let a test interleave a "concurrent actor" at the two racy points. */
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

describe("NodeFsWorkspaceAdapter ownership-aware disposal", { timeout: 30000 }, () => {
  let root: string;
  let adapter: HookedAdapter;

  beforeEach(async () => {
    root = path.join(os.tmpdir(), `emerald-ws-owned-${crypto.randomUUID()}`);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    root = await fs.realpath(root);
    adapter = new HookedAdapter({ workspaceRoot: root });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  // The per-root ownership key is an adapter file at the root, not a workspace; it is covered by its own tests below.
  const entries = async () => (await fs.readdir(root)).filter((n) => n !== OWNER_KEY_FILE && n !== OWNER_LEDGER_DIR).sort();

  /** A correctly authenticated marker, as provisioning would write it. */
  const signedMarker = (workspaceId: string, owner: { runId: string; leaseId: string }) =>
    issueOwnership(root, workspaceId, owner);

  /** What a newer attempt's provisioning leaves behind. */
  async function plantOwnedDir(workspaceId: string, owner: { runId: string; leaseId: string }, fileContent: string) {
    const dir = path.join(root, workspaceId);
    await fs.mkdir(dir, { mode: 0o700 });
    await fs.writeFile(path.join(dir, ".emerald-owner.json"), signedMarker(workspaceId, owner));
    await fs.writeFile(path.join(dir, "work.txt"), fileContent);
    return dir;
  }

  it("1. the legitimate owner disposes its workspace and no tombstone is left behind", async () => {
    const handle = await adapter.provisionWorkspace(spec("ws-1"), OWNER_A);
    await fs.writeFile(path.join(handle.hostPath, "a.txt"), "data");

    await adapter.disposeWorkspace("ws-1", OWNER_A);

    expect(await entries()).toEqual([]);
  });

  it("2. a stale owner cannot dispose a newer attempt's workspace (marker mismatch): directory and contents survive", async () => {
    await adapter.provisionWorkspace(spec("ws-1"), OWNER_B);

    await expect(adapter.disposeWorkspace("ws-1", OWNER_A)).rejects.toBeInstanceOf(WorkspaceOwnershipError);

    expect(await entries()).toEqual(["ws-1"]);
    expect(JSON.parse(await fs.readFile(path.join(root, "ws-1", ".emerald-owner.json"), "utf8")).leaseId).toBe("lease-B");
  });

  it("3. fail closed: a directory without an ownership marker is not deleted", async () => {
    await fs.mkdir(path.join(root, "ws-1"));
    await fs.writeFile(path.join(root, "ws-1", "keep.txt"), "keep");

    await expect(adapter.disposeWorkspace("ws-1", OWNER_A)).rejects.toBeInstanceOf(WorkspaceOwnershipError);

    expect(await fs.readFile(path.join(root, "ws-1", "keep.txt"), "utf8")).toBe("keep");
  });

  it("4. fail closed: a symlink at the workspace path is refused, not followed or unlinked", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "emerald-outside-"));
    try {
      await fs.writeFile(path.join(outside, "precious.txt"), "precious");
      await fs.symlink(outside, path.join(root, "ws-1"), "junction");
      await expect(adapter.disposeWorkspace("ws-1", OWNER_A)).rejects.toBeInstanceOf(WorkspaceOwnershipError);
      expect(await exists(path.join(outside, "precious.txt"))).toBe(true);
    } finally {
      await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("5. disposing a workspace that no longer exists is an idempotent no-op", async () => {
    await expect(adapter.disposeWorkspace("ws-gone", OWNER_A)).resolves.toBeUndefined();
  });

  it("6. takeover between the marker check and the rename: the newer attempt's directory is moved aside, detected, and restored intact", async () => {
    await adapter.provisionWorkspace(spec("ws-1"), OWNER_A);
    adapter.onAfterOwnerCheck = async (targetDir) => {
      // A's directory vanishes (crash cleanup) and the newer attempt provisions its own at the same path.
      await fs.rm(targetDir, { recursive: true, force: true });
      await plantOwnedDir("ws-1", OWNER_B, "B-data");
    };

    await expect(adapter.disposeWorkspace("ws-1", OWNER_A)).rejects.toBeInstanceOf(WorkspaceOwnershipError);

    expect(await entries()).toEqual(["ws-1"]); // restored, no tombstone
    expect(await fs.readFile(path.join(root, "ws-1", "work.txt"), "utf8")).toBe("B-data");
    expect(JSON.parse(await fs.readFile(path.join(root, "ws-1", ".emerald-owner.json"), "utf8")).leaseId).toBe("lease-B");
  });

  it("7. takeover where the workspace path is taken again before restore: the newer attempt's data is preserved, never deleted", async () => {
    await adapter.provisionWorkspace(spec("ws-1"), OWNER_A);
    adapter.onAfterOwnerCheck = async (targetDir) => {
      await fs.rm(targetDir, { recursive: true, force: true });
      await plantOwnedDir("ws-1", OWNER_B, "B-data");
    };
    adapter.onAfterTombstoneRename = async () => {
      await plantOwnedDir("ws-1", { runId: "run-1", leaseId: "lease-C" }, "C-data"); // path re-provisioned by yet another attempt
    };

    const err = await adapter.disposeWorkspace("ws-1", OWNER_A).catch((e) => e);

    expect(err).toBeInstanceOf(WorkspaceOwnershipError);
    expect((err as WorkspaceOwnershipError).preservedAt).toMatch(/\.disposing-ws-1-/);
    const names = await entries();
    const preserved = names.find((n) => n.startsWith(".disposing-ws-1-"))!;
    expect(preserved).toBeDefined();
    expect(await fs.readFile(path.join(root, preserved, "work.txt"), "utf8")).toBe("B-data");
    expect(await fs.readFile(path.join(root, "ws-1", "work.txt"), "utf8")).toBe("C-data");
  });

  it("8. concurrent disposals by the same owner both resolve and leave nothing behind", async () => {
    await adapter.provisionWorkspace(spec("ws-1"), OWNER_A);
    await Promise.all([adapter.disposeWorkspace("ws-1", OWNER_A), adapter.disposeWorkspace("ws-1", OWNER_A)]);
    expect(await entries()).toEqual([]);
  });

  it("9. concurrent stale and legitimate disposal: the stale one is refused, the owner's workspace is removed once", async () => {
    await adapter.provisionWorkspace(spec("ws-1"), OWNER_B);
    const results = await Promise.allSettled([adapter.disposeWorkspace("ws-1", OWNER_A), adapter.disposeWorkspace("ws-1", OWNER_B)]);
    expect(results[0]!.status).toBe("rejected");
    expect((results[0] as PromiseRejectedResult).reason).toBeInstanceOf(WorkspaceOwnershipError);
    expect(results[1]!.status).toBe("fulfilled");
    expect(await entries()).toEqual([]);
  });

  it("10. crash recovery: a verified `.disposed-*` leftover is finished, an unverified `.disposing-*` leftover is never deleted", async () => {
    await fs.mkdir(path.join(root, ".disposed-ws-1-aaa"));
    await fs.writeFile(path.join(root, ".disposed-ws-1-aaa", "x"), "x");
    await fs.mkdir(path.join(root, ".disposing-ws-2-bbb"));
    await fs.writeFile(path.join(root, ".disposing-ws-2-bbb", "y"), "y");

    const reclaimed = await adapter.cleanupOrphanedWorkspaces(new Set());

    expect(reclaimed).toContain(".disposed-ws-1-aaa");
    expect(await exists(path.join(root, ".disposed-ws-1-aaa"))).toBe(false);
    expect(await fs.readFile(path.join(root, ".disposing-ws-2-bbb", "y"), "utf8")).toBe("y");
  });

  it("11. unowned (operator/recovery) disposal keeps its existing unconditional behaviour", async () => {
    await adapter.provisionWorkspace(spec("ws-1"), OWNER_B);
    await adapter.disposeWorkspace("ws-1");
    expect(await entries()).toEqual([]);
  });
  // ---------------------------------------------------------------------------------------------------------
  // F1: ids in the adapter's reserved tombstone namespace (and over-long ids) are never workspaces
  // ---------------------------------------------------------------------------------------------------------
  describe("reserved and over-long workspace ids (F1)", () => {
    for (const id of [".disposed-x", ".disposing-a-b", ".hidden", "a".repeat(129)]) {
      it(`provisionWorkspace rejects '${id.length > 20 ? `${id.length}-char id` : id}'`, async () => {
        await expect(adapter.provisionWorkspace(spec(id), OWNER_A)).rejects.toThrow();
        expect(await entries()).toEqual([]);
      });
    }

    it("disposeWorkspace and disposeWorkspaceSync reject reserved ids instead of touching the directory", async () => {
      await fs.mkdir(path.join(root, ".disposed-x"));
      await fs.writeFile(path.join(root, ".disposed-x", "keep.txt"), "keep");
      await expect(adapter.disposeWorkspace(".disposed-x")).rejects.toThrow();
      expect(() => adapter.disposeWorkspaceSync(".disposed-x")).toThrow();
      expect(await fs.readFile(path.join(root, ".disposed-x", "keep.txt"), "utf8")).toBe("keep");
    });

    it("the longest accepted id (128 chars) can be provisioned and disposed with an owner", async () => {
      const id = "a".repeat(128);
      await adapter.provisionWorkspace(spec(id), OWNER_A);
      await adapter.disposeWorkspace(id, OWNER_A);
      expect(await entries()).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  // F2: the orphan sweep deletes only what still belongs to the owner it saw
  // ---------------------------------------------------------------------------------------------------------
  describe("marker-aware orphan sweep (F2)", () => {
    it("a directory replaced by a newer attempt between the active check and the delete is NOT reclaimed", async () => {
      await adapter.provisionWorkspace(spec("ws-1"), OWNER_A);
      adapter.onAfterOwnerCheck = async (targetDir) => {
        await fs.rm(targetDir, { recursive: true, force: true });
        await plantOwnedDir("ws-1", OWNER_B, "B-data");
      };

      const reclaimed = await adapter.cleanupOrphanedWorkspaces(new Set());

      expect(reclaimed).not.toContain("ws-1");
      expect(await entries()).toEqual(["ws-1"]);
      expect(await fs.readFile(path.join(root, "ws-1", "work.txt"), "utf8")).toBe("B-data");
    });

    it("reclaims an owned orphan by default; a marker-less directory is skipped and reported unless reclaimUnowned is set", async () => {
      await adapter.provisionWorkspace(spec("ws-2"), OWNER_A);
      await fs.mkdir(path.join(root, "ws-3"));
      await fs.writeFile(path.join(root, "ws-3", "x.txt"), "x");
      const skipped: string[] = [];

      const first = await adapter.cleanupOrphanedWorkspaces(new Set(), { onSkipped: (name) => skipped.push(name) });

      expect(first).toEqual(["ws-2"]);
      expect(skipped).toEqual(["ws-3"]);
      expect(await entries()).toEqual(["ws-3"]); // a live legacy/non-worker workspace is never guessed to be an orphan

      const second = await adapter.cleanupOrphanedWorkspaces(new Set(), { reclaimUnowned: true });
      expect(second).toEqual(["ws-3"]);
      expect(await entries()).toEqual([]);
    });

    it("never touches an active workspace and leaves unverified `.disposing-*` leftovers alone", async () => {
      await adapter.provisionWorkspace(spec("ws-active"), OWNER_A);
      await fs.mkdir(path.join(root, ".disposing-ws-9-zzz"));
      const reclaimed = await adapter.cleanupOrphanedWorkspaces(new Set(["ws-active"]));
      expect(reclaimed).toEqual([]);
      expect((await entries()).sort()).toEqual([".disposing-ws-9-zzz", "ws-active"]);
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  // F3: the synchronous (coordinator) disposal honours ownership too
  // ---------------------------------------------------------------------------------------------------------
  describe("ownership-aware disposeWorkspaceSync (F3)", () => {
    it("the legitimate owner disposes its workspace, leaving no tombstone", async () => {
      await adapter.provisionWorkspace(spec("ws-1"), OWNER_A);
      adapter.disposeWorkspaceSync("ws-1", OWNER_A);
      expect(await entries()).toEqual([]);
    });

    it("a stale owner is refused and the newer attempt's directory is untouched", async () => {
      await adapter.provisionWorkspace(spec("ws-1"), OWNER_B);
      expect(() => adapter.disposeWorkspaceSync("ws-1", OWNER_A)).toThrow(WorkspaceOwnershipError);
      expect(await entries()).toEqual(["ws-1"]);
      expect(JSON.parse(await fs.readFile(path.join(root, "ws-1", ".emerald-owner.json"), "utf8")).leaseId).toBe("lease-B");
    });

    it("tolerateMissingMarker still refuses a marker that names another lease", async () => {
      await adapter.provisionWorkspace(spec("ws-1"), OWNER_B);
      expect(() => adapter.disposeWorkspaceSync("ws-1", { ...OWNER_A, tolerateMissingMarker: true })).toThrow(WorkspaceOwnershipError);
      expect(await entries()).toEqual(["ws-1"]);
    });

    it("a marker-less (legacy) directory: strict owner is refused, tolerateMissingMarker deletes it", async () => {
      await fs.mkdir(path.join(root, "ws-1"));
      await fs.writeFile(path.join(root, "ws-1", "x.txt"), "x");
      expect(() => adapter.disposeWorkspaceSync("ws-1", OWNER_A)).toThrow(WorkspaceOwnershipError);
      expect(await entries()).toEqual(["ws-1"]);
      adapter.disposeWorkspaceSync("ws-1", { ...OWNER_A, tolerateMissingMarker: true });
      expect(await entries()).toEqual([]);
    });

    it("a symlink/junction at the workspace path is refused, not followed or unlinked", async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "emerald-outside-sync-"));
      try {
        await fs.writeFile(path.join(outside, "precious.txt"), "precious");
        await fs.symlink(outside, path.join(root, "ws-1"), "junction");
        expect(() => adapter.disposeWorkspaceSync("ws-1", OWNER_A)).toThrow(WorkspaceOwnershipError);
        expect(await exists(path.join(outside, "precious.txt"))).toBe(true);
      } finally {
        await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("disposing a workspace that is already gone is an idempotent no-op", () => {
      expect(() => adapter.disposeWorkspaceSync("ws-gone", OWNER_A)).not.toThrow();
    });

    it("unowned callers keep the legacy behaviour", async () => {
      await adapter.provisionWorkspace(spec("ws-1"), OWNER_B);
      adapter.disposeWorkspaceSync("ws-1");
      expect(await entries()).toEqual([]);
    });
  });
  // ---------------------------------------------------------------------------------------------------------
  // Round 2 (review of F1-F3): sweep double-check, unprovable markers, atomic provisioning, ids
  // ---------------------------------------------------------------------------------------------------------
  describe("sweep closes the active-check-to-marker-read window (F2)", () => {
    it("a directory replaced by a newer attempt BEFORE the marker is read, which is active on the second look, is not reclaimed", async () => {
      await adapter.provisionWorkspace(spec("ws-1"), OWNER_A);
      let calls = 0;
      const filter = async (id: string) => {
        if (id !== "ws-1") return false;
        calls++;
        if (calls === 1) {
          // first look: the old attempt's directory is inactive; then the old one vanishes and a newer attempt provisions
          await fs.rm(path.join(root, "ws-1"), { recursive: true, force: true });
          await plantOwnedDir("ws-1", OWNER_B, "B-data");
          return false;
        }
        return true; // the newer attempt is active when looked at again
      };

      const reclaimed = await adapter.cleanupOrphanedWorkspaces(filter);

      expect(calls).toBe(2);
      expect(reclaimed).not.toContain("ws-1");
      expect(await fs.readFile(path.join(root, "ws-1", "work.txt"), "utf8")).toBe("B-data");
    });
  });

  describe("an unreadable or invalid marker is never treated as missing", () => {
    for (const [name, write] of [
      ["corrupt JSON", (d: string) => fs.writeFile(path.join(d, ".emerald-owner.json"), "{not json")],
      ["wrong shape", (d: string) => fs.writeFile(path.join(d, ".emerald-owner.json"), JSON.stringify({ runId: 1 }))],
      ["marker is a directory", (d: string) => fs.mkdir(path.join(d, ".emerald-owner.json"))],
    ] as const) {
      it(`${name}: the orphan sweep leaves the directory and sync/async disposal with tolerateMissingMarker refuse it`, async () => {
        const dir = path.join(root, "ws-1");
        await fs.mkdir(dir);
        await fs.writeFile(path.join(dir, "keep.txt"), "keep");
        await write(dir);

        expect(await adapter.cleanupOrphanedWorkspaces(new Set())).toEqual([]);
        expect(() => adapter.disposeWorkspaceSync("ws-1", { ...OWNER_A, tolerateMissingMarker: true })).toThrow(WorkspaceOwnershipError);
        await expect(adapter.disposeWorkspace("ws-1", { ...OWNER_A, tolerateMissingMarker: true })).rejects.toBeInstanceOf(WorkspaceOwnershipError);
        expect(await fs.readFile(path.join(dir, "keep.txt"), "utf8")).toBe("keep");
      });
    }

    it("async disposal with tolerateMissingMarker deletes a genuinely marker-less legacy directory (parity with sync)", async () => {
      await fs.mkdir(path.join(root, "ws-1"));
      await fs.writeFile(path.join(root, "ws-1", "x.txt"), "x");
      await expect(adapter.disposeWorkspace("ws-1", OWNER_A)).rejects.toBeInstanceOf(WorkspaceOwnershipError); // strict: refused
      await adapter.disposeWorkspace("ws-1", { ...OWNER_A, tolerateMissingMarker: true });
      expect(await entries()).toEqual([]);
    });
  });

  describe("owned provisioning never exposes a marker-less directory", () => {
    it("the marker is present from the moment the workspace directory exists, and no staging directory is left", async () => {
      await adapter.provisionWorkspace(spec("ws-1"), OWNER_A);
      expect(await entries()).toEqual(["ws-1"]);
      expect(JSON.parse(await fs.readFile(path.join(root, "ws-1", ".emerald-owner.json"), "utf8"))).toMatchObject(OWNER_A);
    });

    it("provisioning onto an existing directory fails closed and leaves nothing behind", async () => {
      await fs.mkdir(path.join(root, "ws-1"));
      await expect(adapter.provisionWorkspace(spec("ws-1"), OWNER_A)).rejects.toThrow();
      expect(await entries()).toEqual(["ws-1"]);
    });
  });

  describe("workspace id hardening (review round 2)", () => {
    for (const id of ["con", "NUL", "com1", "lpt9", "aux.txt", "ws-trailing."]) {
      it(`rejects '${id}' (Windows device name or trailing dot)`, async () => {
        await expect(adapter.provisionWorkspace(spec(id), OWNER_A)).rejects.toThrow();
        expect(await entries()).toEqual([]);
      });
    }

    it("accepts ordinary ids that merely contain such words", async () => {
      await adapter.provisionWorkspace(spec("ws-con"), OWNER_A);
      await adapter.provisionWorkspace(spec("console"), OWNER_A);
      expect((await entries()).sort()).toEqual(["console", "ws-con"]);
    });

    it("getWorkspaceMetadata(Sync) never reads outside the root for a traversal id", async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "emerald-meta-outside-"));
      try {
        await fs.writeFile(path.join(outside, ".emerald-workspace.json"), JSON.stringify({ runId: "LEAKED" }));
        const id = `../${path.basename(outside)}`;
        expect(await adapter.getWorkspaceMetadata(id)).toBeNull();
        expect(adapter.getWorkspaceMetadataSync(id)).toBeNull();
      } finally {
        await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
      }
    });
  });
  // ---------------------------------------------------------------------------------------------------------
  // Round 3 (review follow-up)
  // ---------------------------------------------------------------------------------------------------------
  describe("the sweep asks about the marker's own lease and reports what it will not touch", () => {
    it("the second activity check receives the marker's {runId, leaseId}; an active lease keeps the workspace", async () => {
      await adapter.provisionWorkspace(spec("ws-1"), OWNER_A);
      const seen: Array<{ runId: string; leaseId: string } | undefined> = [];
      const filter = (_id: string, owner?: { runId: string; leaseId: string }) => {
        seen.push(owner);
        return owner?.leaseId === "lease-A"; // inactive by name, but the marker's lease is still live
      };

      const reclaimed = await adapter.cleanupOrphanedWorkspaces(filter);

      expect(seen).toEqual([undefined, { runId: "run-1", leaseId: "lease-A" }]);
      expect(reclaimed).toEqual([]);
      expect(await entries()).toEqual(["ws-1"]);
    });

    it("reports `.disposing-*` and `.provisioning-*` leftovers without deleting them, and they do not block provisioning", async () => {
      await fs.mkdir(path.join(root, ".disposing-ws-1-aaa"));
      await fs.mkdir(path.join(root, ".provisioning-ws-1-bbb"));
      const leftovers: string[] = [];

      const reclaimed = await adapter.cleanupOrphanedWorkspaces(new Set(), { onUnverifiedLeftover: (n) => leftovers.push(n) });

      expect(reclaimed).toEqual([]);
      expect(leftovers.sort()).toEqual([".disposing-ws-1-aaa", ".provisioning-ws-1-bbb"]);
      expect((await entries()).sort()).toEqual([".disposing-ws-1-aaa", ".provisioning-ws-1-bbb"]);
      await adapter.provisionWorkspace(spec("ws-1"), OWNER_A); // same id still provisions
      expect(await exists(path.join(root, "ws-1", ".emerald-owner.json"))).toBe(true);
    });

    it("reports directories it skipped because the marker is invalid", async () => {
      await fs.mkdir(path.join(root, "ws-1"));
      await fs.writeFile(path.join(root, "ws-1", ".emerald-owner.json"), "{garbage");
      const skipped: Array<[string, string]> = [];
      await adapter.cleanupOrphanedWorkspaces(new Set(), { reclaimUnowned: true, onSkipped: (n, r) => skipped.push([n, r]) });
      expect(skipped).toHaveLength(1);
      expect(skipped[0]![0]).toBe("ws-1");
      expect(skipped[0]![1]).toMatch(/unreadable, invalid or not authenticated/);
      expect(await exists(path.join(root, "ws-1"))).toBe(true);
    });
  });

  describe("unknownLease replaces the magic sentinel string", () => {
    const UNKNOWN = { runId: "run-1", leaseId: "", unknownLease: true, tolerateMissingMarker: true } as const;

    it("refuses every marker-bearing directory, including one whose leaseId is literally 'unknown-lease'", async () => {
      await adapter.provisionWorkspace(spec("ws-lit"), { runId: "run-1", leaseId: "unknown-lease" });
      await adapter.provisionWorkspace(spec("ws-real"), OWNER_A);
      expect(() => adapter.disposeWorkspaceSync("ws-lit", UNKNOWN)).toThrow(WorkspaceOwnershipError);
      expect(() => adapter.disposeWorkspaceSync("ws-real", UNKNOWN)).toThrow(WorkspaceOwnershipError);
      await expect(adapter.disposeWorkspace("ws-lit", UNKNOWN)).rejects.toBeInstanceOf(WorkspaceOwnershipError);
      expect((await entries()).sort()).toEqual(["ws-lit", "ws-real"]);
    });

    it("still cleans a genuinely marker-less directory (tolerateMissingMarker)", async () => {
      await fs.mkdir(path.join(root, "ws-1"));
      adapter.disposeWorkspaceSync("ws-1", UNKNOWN);
      expect(await entries()).toEqual([]);
    });

    it("provisioning rejects an empty runId or leaseId", async () => {
      await expect(adapter.provisionWorkspace(spec("ws-1"), { runId: "run-1", leaseId: "" })).rejects.toThrow();
      await expect(adapter.provisionWorkspace(spec("ws-2"), { runId: "", leaseId: "lease-A" })).rejects.toThrow();
      expect(await entries()).toEqual([]);
    });
  });

  describe("Windows device-name table", () => {
    for (const id of ["prn", "PRN", "Prn.txt", "com0", "COM9", "lpt0", "LPT9", "conin$", "clock$", "CONOUT$", "com\u00b9", "com1.tar.gz", "AUX.x"]) {
      it(`rejects '${id}'`, async () => {
        await expect(adapter.provisionWorkspace(spec(id), OWNER_A)).rejects.toThrow();
        expect(await entries()).toEqual([]);
      });
    }
    for (const id of ["com10", "ws-prn", "printer"]) {
      it(`accepts '${id}'`, async () => {
        await adapter.provisionWorkspace(spec(id), OWNER_A);
        expect(await entries()).toEqual([id]);
      });
    }
  });

  describe("a link swapped in after the owner check never reaches outside the workspace root", () => {
    /** An outside directory with a forged marker and a deliberately READ-ONLY file; chmod(0o600) would make it writable. */
    async function makeOutside() {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "emerald-outside-swap-"));
      await fs.writeFile(path.join(outside, "precious.txt"), "precious");
      await fs.chmod(path.join(outside, "precious.txt"), 0o444);
      await fs.writeFile(path.join(outside, ".emerald-owner.json"), signedMarker("ws-1", OWNER_A)); // even a VALID marker is never read through a link
      return outside;
    }
    const readOnly = async (p: string) => ((await fs.stat(p)).mode & 0o200) === 0;

    it("async disposal: the link is not read through, nothing outside is modified (contents AND permissions), and the call is refused", async () => {
      const outside = await makeOutside();
      try {
        await adapter.provisionWorkspace(spec("ws-1"), OWNER_A);
        adapter.onAfterOwnerCheck = async (targetDir) => {
          await fs.rm(targetDir, { recursive: true, force: true });
          await fs.symlink(outside, targetDir, "junction");
        };

        await expect(adapter.disposeWorkspace("ws-1", OWNER_A)).rejects.toBeInstanceOf(WorkspaceOwnershipError);

        expect(await fs.readFile(path.join(outside, "precious.txt"), "utf8")).toBe("precious");
        expect(await readOnly(path.join(outside, "precious.txt"))).toBe(true); // permissions untouched
        expect(await exists(path.join(outside, ".emerald-owner.json"))).toBe(true);
        expect(await entries()).toEqual(["ws-1"]); // the link was put back, not followed
      } finally {
        await fs.chmod(path.join(outside, "precious.txt"), 0o644).catch(() => {});
        await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("the permission fix-ups refuse a link at the top path and skip link entries (async and sync)", async () => {
      const outside = await makeOutside();
      const inner = path.join(root, "ws-inner");
      try {
        await fs.symlink(outside, path.join(root, "ws-link"), "junction");
        const priv = adapter as unknown as { ensureWritableRecursive(p: string): Promise<void>; ensureWritableRecursiveSync(p: string): void };
        await priv.ensureWritableRecursive(path.join(root, "ws-link"));
        priv.ensureWritableRecursiveSync(path.join(root, "ws-link"));
        expect(await readOnly(path.join(outside, "precious.txt"))).toBe(true);

        // a link INSIDE a real workspace directory must not be chmod'ed through either
        await fs.mkdir(inner);
        await fs.symlink(path.join(outside, "precious.txt"), path.join(inner, "alias.txt"), "file").catch(() => undefined);
        await priv.ensureWritableRecursive(inner);
        priv.ensureWritableRecursiveSync(inner);
        expect(await readOnly(path.join(outside, "precious.txt"))).toBe(true);
      } finally {
        await fs.chmod(path.join(outside, "precious.txt"), 0o644).catch(() => {});
        await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
      }
    });
  });
  describe("disposal never changes the mode of a file that is also linked OUTSIDE the workspace (hard link)", () => {
    const writable = async (p: string) => ((await fs.stat(p)).mode & 0o200) !== 0;

    async function plantLinked(): Promise<{ outside: string; cleanup: () => Promise<void> } | null> {
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "emerald-hardlink-"));
      const outside = path.join(outsideDir, "precious.txt");
      await fs.writeFile(outside, "precious");
      await fs.chmod(outside, 0o444);
      await adapter.provisionWorkspace(spec("ws-1"), OWNER_A);
      try {
        await fs.link(outside, path.join(root, "ws-1", "linked.txt"));
      } catch {
        await fs.rm(outsideDir, { recursive: true, force: true });
        return null; // the filesystem does not support hard links
      }
      await fs.writeFile(path.join(root, "ws-1", "plain-readonly.txt"), "x");
      await fs.chmod(path.join(root, "ws-1", "plain-readonly.txt"), 0o444);
      return { outside, cleanup: () => fs.rm(outsideDir, { recursive: true, force: true }) };
    }

    it("async disposal: the outside file keeps its read-only mode and contents; the workspace is still removed", async () => {
      const planted = await plantLinked();
      if (!planted) return;
      try {
        await adapter.disposeWorkspace("ws-1", OWNER_A);
        expect(await writable(planted.outside)).toBe(false);
        expect(await fs.readFile(planted.outside, "utf8")).toBe("precious");
        expect(await entries()).toEqual([]); // a read-only ordinary file inside did not block removal
      } finally {
        await fs.chmod(planted.outside, 0o644).catch(() => {});
        await planted.cleanup();
      }
    });

    it("sync disposal: same", async () => {
      const planted = await plantLinked();
      if (!planted) return;
      try {
        adapter.disposeWorkspaceSync("ws-1", OWNER_A);
        expect(await writable(planted.outside)).toBe(false);
        expect(await fs.readFile(planted.outside, "utf8")).toBe("precious");
        expect(await entries()).toEqual([]);
      } finally {
        await fs.chmod(planted.outside, 0o644).catch(() => {});
        await planted.cleanup();
      }
    });
  });

  describe("restore never replaces a directory that appeared at the workspace path (POSIX rename-over-empty-directory)", () => {
    it("async: a mismatch is preserved under its .disposing- name when an EMPTY directory now occupies the path", async () => {
      await adapter.provisionWorkspace(spec("ws-1"), OWNER_A);
      adapter.onAfterOwnerCheck = async (targetDir) => {
        await fs.rm(targetDir, { recursive: true, force: true });
        await plantOwnedDir("ws-1", OWNER_B, "B-data");
      };
      adapter.onAfterTombstoneRename = async (_tomb, targetDir) => {
        await fs.mkdir(targetDir); // a third actor's empty directory (POSIX rename would replace it)
      };
      const err = await adapter.disposeWorkspace("ws-1", OWNER_A).catch((e) => e);
      expect(err).toBeInstanceOf(WorkspaceOwnershipError);
      expect(err.preservedAt).toMatch(/\.disposing-ws-1-/);
      expect(await fs.readdir(path.join(root, "ws-1"))).toEqual([]); // the third actor's directory is untouched
      expect(await fs.readFile(path.join(err.preservedAt, "work.txt"), "utf8")).toBe("B-data");
    });
  });

  describe("the ownership marker is authenticated (F6): the tenant-writable file alone proves nothing", () => {
    const markerOf = (id: string) => path.join(root, id, ".emerald-owner.json");

    it("provisioning writes a MAC-bearing marker; the key lives at the root, outside every workspace directory", async () => {
      await adapter.provisionWorkspace(spec("ws-1"), OWNER_A);
      const marker = JSON.parse(await fs.readFile(markerOf("ws-1"), "utf8"));
      expect(marker).toMatchObject(OWNER_A);
      expect(marker.mac).toMatch(/^[0-9a-f]{64}$/);
      expect(await exists(path.join(root, OWNER_KEY_FILE))).toBe(true);
      expect(await exists(path.join(root, "ws-1", OWNER_KEY_FILE))).toBe(false);
    });

    it("a hand-forged (unsigned) marker naming the caller is refused: directory and contents survive", async () => {
      await fs.mkdir(path.join(root, "ws-1"));
      await fs.writeFile(markerOf("ws-1"), JSON.stringify(OWNER_A));
      await fs.writeFile(path.join(root, "ws-1", "work.txt"), "tenant data");
      await expect(adapter.disposeWorkspace("ws-1", OWNER_A)).rejects.toBeInstanceOf(WorkspaceOwnershipError);
      expect(await fs.readFile(path.join(root, "ws-1", "work.txt"), "utf8")).toBe("tenant data");
    });

    it("a tenant that rewrites the lease id in a genuine marker (keeping the old MAC) cannot take ownership", async () => {
      await adapter.provisionWorkspace(spec("ws-1"), OWNER_B);
      const marker = JSON.parse(await fs.readFile(markerOf("ws-1"), "utf8"));
      await fs.writeFile(markerOf("ws-1"), JSON.stringify({ ...marker, leaseId: OWNER_A.leaseId }));
      await expect(adapter.disposeWorkspace("ws-1", OWNER_A)).rejects.toBeInstanceOf(WorkspaceOwnershipError);
      expect(await exists(path.join(root, "ws-1"))).toBe(true);
    });

    it("a genuine marker copied from another workspace does not verify (the MAC binds the workspace id)", async () => {
      await adapter.provisionWorkspace(spec("ws-1"), OWNER_A);
      await fs.mkdir(path.join(root, "ws-2"));
      await fs.copyFile(markerOf("ws-1"), markerOf("ws-2"));
      await expect(adapter.disposeWorkspace("ws-2", OWNER_A)).rejects.toBeInstanceOf(WorkspaceOwnershipError);
      expect(await exists(path.join(root, "ws-2"))).toBe(true);
    });

    it("without the key no marker can be verified: disposal is refused (fail closed), never deleted", async () => {
      await adapter.provisionWorkspace(spec("ws-1"), OWNER_A);
      await fs.rm(path.join(root, OWNER_KEY_FILE));
      await expect(adapter.disposeWorkspace("ws-1", OWNER_A)).rejects.toBeInstanceOf(WorkspaceOwnershipError);
      expect(await exists(path.join(root, "ws-1"))).toBe(true);
    });

    it("the orphan sweep never deletes a forged-marker directory and reports it", async () => {
      await fs.mkdir(path.join(root, "ws-1"));
      await fs.writeFile(markerOf("ws-1"), JSON.stringify(OWNER_A));
      const skipped: Array<[string, string]> = [];
      const reclaimed = await adapter.cleanupOrphanedWorkspaces(new Set<string>(), { onSkipped: (n, r) => skipped.push([n, r]) });
      expect(reclaimed).toEqual([]);
      expect(await exists(path.join(root, "ws-1"))).toBe(true);
      expect(skipped).toEqual([["ws-1", expect.stringMatching(/not authenticated/)]]);
    });
  });

  describe("orphan sweep fails closed and stays observable when it cannot establish safety", () => {
    it("an exception from the FIRST activity check skips that directory (reported), never deletes it, and the sweep continues", async () => {
      await adapter.provisionWorkspace(spec("ws-1"), OWNER_A);
      await adapter.provisionWorkspace(spec("ws-2"), OWNER_A);
      const skipped: Array<[string, string]> = [];
      const reclaimed = await adapter.cleanupOrphanedWorkspaces(
        (id) => {
          if (id === "ws-1") throw new Error("state store unavailable");
          return false;
        },
        { onSkipped: (n, r) => skipped.push([n, r]) }
      );
      expect(reclaimed).toEqual(["ws-2"]);
      expect(await entries()).toEqual(["ws-1"]);
      expect(skipped).toEqual([["ws-1", "activity check failed: state store unavailable"]]);
    });

    it("an async rejection from the first activity check is handled the same way", async () => {
      await adapter.provisionWorkspace(spec("ws-1"), OWNER_A);
      const skipped: string[] = [];
      await expect(
        adapter.cleanupOrphanedWorkspaces(async () => Promise.reject(new Error("boom")), { onSkipped: (_n, r) => skipped.push(r) })
      ).resolves.toEqual([]);
      expect(await entries()).toEqual(["ws-1"]);
      expect(skipped).toEqual(["activity check failed: boom"]);
    });

    it("an exception from the SECOND (marker-lease) check keeps the directory and is reported", async () => {
      await adapter.provisionWorkspace(spec("ws-1"), OWNER_A);
      const skipped: string[] = [];
      const reclaimed = await adapter.cleanupOrphanedWorkspaces(
        (_id, owner) => {
          if (owner) throw new Error("lease lookup failed");
          return false;
        },
        { onSkipped: (_n, r) => skipped.push(r) }
      );
      expect(reclaimed).toEqual([]);
      expect(await entries()).toEqual(["ws-1"]);
      expect(skipped).toEqual(["not deleted: lease lookup failed"]);
    });

    it("a takeover that is only detected at deletion time is reported as preserved", async () => {
      await adapter.provisionWorkspace(spec("ws-1"), OWNER_A);
      adapter.onAfterOwnerCheck = async (targetDir) => {
        await fs.rm(targetDir, { recursive: true, force: true });
        await plantOwnedDir("ws-1", OWNER_B, "B-data");
      };
      const skipped: string[] = [];
      const reclaimed = await adapter.cleanupOrphanedWorkspaces(new Set<string>(), { onSkipped: (_n, r) => skipped.push(r) });
      expect(reclaimed).toEqual([]);
      expect(await fs.readFile(path.join(root, "ws-1", "work.txt"), "utf8")).toBe("B-data");
      expect(skipped).toEqual(["ownership changed before deletion; directory preserved"]);
    });
  });
});
