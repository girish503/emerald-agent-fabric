import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import {
  OWNER_KEY_FILE,
  OwnerKeyError,
  OWNER_LEDGER_DIR,
  issueOwnership,
  loadOwnerKey,
  ownerKeyModeProblem,
} from "../../src/adapters/workspace/owner-marker.js";
import type { WorkspaceSpec } from "../../src/domain/workspace.js";

const isWindows = process.platform === "win32";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const OWNER = { runId: "run-1", leaseId: "lease-A" };
const spec = (workspaceId: string): WorkspaceSpec =>
  ({ workspaceId, runId: "run-1", taskId: "t", maxWorkspaceBytes: 1 << 20, maxFileSizeBytes: 1 << 20 }) as WorkspaceSpec;

/**
 * Key-file invariant: an existing key is trusted only if it is a regular, non-link, 32-byte file that (on POSIX) group and
 * others cannot access. Anything else throws OwnerKeyError - never repaired, never overwritten, never used to authenticate or
 * to authorize deletion.
 *
 * Platform honesty: the mode-bit tests that touch real files run only on POSIX (`skipIf(isWindows)`); on Windows the
 * enforcement is exercised ONLY through the pure `ownerKeyModeProblem` with synthetic modes, which proves the rule, not
 * that an OS enforces it. Windows ACLs are not checked at all.
 */
describe("ownership key file validation", () => {
  let root: string;
  const keyPath = () => path.join(root, OWNER_KEY_FILE);

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "emerald-keyfile-")));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  describe("mode rule (pure, any platform)", () => {
    it.each([0o600, 0o400, 0o700, 0o500, 0o100000 | 0o600])("accepts %o on POSIX", (mode) => {
      expect(ownerKeyModeProblem(mode, "linux")).toBeNull();
    });
    it.each([0o640, 0o604, 0o620, 0o602, 0o660, 0o606, 0o644, 0o666, 0o610, 0o601, 0o777])("rejects %o on POSIX (group/other access)", (mode) => {
      expect(ownerKeyModeProblem(mode, "linux")).toMatch(/chmod 600/);
      expect(ownerKeyModeProblem(mode, "darwin")).toMatch(/group\/other/);
    });
    it("performs no mode check on Windows (documented: POSIX bits are meaningless there)", () => {
      expect(ownerKeyModeProblem(0o666, "win32")).toBeNull();
    });
  });

  describe("loading", () => {
    it("a missing key yields null without creating anything; create=true creates a 32-byte key (mode 0600 on POSIX)", () => {
      expect(loadOwnerKey(root, false)).toBeNull();
      expect(fs.existsSync(keyPath())).toBe(false);
      const key = loadOwnerKey(root, true)!;
      expect(key).toHaveLength(32);
      if (!isWindows) expect(fs.statSync(keyPath()).mode & 0o777).toBe(0o600);
      expect(loadOwnerKey(root, false)!.equals(key)).toBe(true); // a securely created key is accepted on reload
      expect(loadOwnerKey(root, true)!.equals(key)).toBe(true); // and create never replaces it
    });

    it.skipIf(isWindows).each([0o640, 0o604, 0o620, 0o602, 0o660, 0o644, 0o666])(
      "POSIX: an existing key with mode %o is refused, not repaired and not overwritten",
      (mode) => {
        const bytes = Buffer.alloc(32, 7);
        fs.writeFileSync(keyPath(), bytes);
        fs.chmodSync(keyPath(), mode);
        for (const create of [false, true]) {
          expect(() => loadOwnerKey(root, create)).toThrow(OwnerKeyError);
        }
        expect(fs.statSync(keyPath()).mode & 0o777).toBe(mode); // not silently chmod'ed
        expect(fs.readFileSync(keyPath()).equals(bytes)).toBe(true); // not rewritten
      }
    );

    it.skipIf(isWindows || isRoot)("POSIX: an unreadable key (mode 000) is refused", () => {
      fs.writeFileSync(keyPath(), Buffer.alloc(32, 7));
      fs.chmodSync(keyPath(), 0o000);
      expect(() => loadOwnerKey(root, false)).toThrow(OwnerKeyError);
      fs.chmodSync(keyPath(), 0o600);
    });

    it.each([
      ["empty", Buffer.alloc(0)],
      ["truncated", Buffer.alloc(5, 1)],
      ["oversized", Buffer.alloc(64, 1)],
    ])("a %s key file is refused (both modes), and left exactly as found", (_name, bytes) => {
      fs.writeFileSync(keyPath(), bytes, { mode: 0o600 });
      for (const create of [false, true]) {
        expect(() => loadOwnerKey(root, create)).toThrow(/cannot be trusted/);
      }
      expect(fs.readFileSync(keyPath()).equals(bytes)).toBe(true);
    });

    it("a directory in place of the key is refused", () => {
      fs.mkdirSync(keyPath());
      expect(() => loadOwnerKey(root, false)).toThrow(OwnerKeyError);
      expect(() => loadOwnerKey(root, true)).toThrow(OwnerKeyError);
    });

    it("a symbolic link to an otherwise valid key is refused (never followed)", () => {
      const real = path.join(root, "real-key");
      fs.writeFileSync(real, Buffer.alloc(32, 9), { mode: 0o600 });
      try {
        fs.symlinkSync(real, keyPath(), "file");
      } catch {
        return; // creating symlinks needs a privilege on Windows; nothing to assert there
      }
      expect(() => loadOwnerKey(root, false)).toThrow(/symbolic link/);
      expect(() => loadOwnerKey(root, true)).toThrow(/symbolic link/);
      expect(fs.readlinkSync(keyPath())).toBe(real); // untouched
    });
  });

  describe("an untrustworthy key never authenticates a marker and never authorizes deletion", () => {
    let adapter: NodeFsWorkspaceAdapter;
    const entries = () => fs.readdirSync(root).filter((n) => n !== OWNER_KEY_FILE && n !== OWNER_LEDGER_DIR).sort();

    beforeEach(() => {
      adapter = new NodeFsWorkspaceAdapter({ workspaceRoot: root });
    });

    /** Provisions with a good key, then damages the key; `how` differs per platform (see callers). */
    async function withDamagedKey(damage: () => void) {
      await adapter.provisionWorkspace(spec("ws-1"), OWNER);
      const marker = fs.readFileSync(path.join(root, "ws-1", ".emerald-owner.json"), "utf8");
      fs.writeFileSync(path.join(root, "ws-1", "tenant.txt"), "data");
      damage();
      return marker;
    }
    const corruptKey = () => fs.writeFileSync(keyPath(), Buffer.alloc(5, 1), { mode: 0o600 }); // any platform
    const widenKey = () => fs.chmodSync(keyPath(), 0o644); // POSIX only

    for (const [name, damage, skip] of [
      ["corrupt key (any platform)", corruptKey, false],
      ["group/other-readable key (POSIX)", widenKey, isWindows],
    ] as const) {
      it.skipIf(skip)(`${name}: async disposal by the rightful owner is refused and nothing is deleted`, async () => {
        await withDamagedKey(damage);
        await expect(adapter.disposeWorkspace("ws-1", OWNER)).rejects.toBeInstanceOf(OwnerKeyError);
        expect(entries()).toEqual(["ws-1"]);
        expect(fs.readFileSync(path.join(root, "ws-1", "tenant.txt"), "utf8")).toBe("data");
      });

      it.skipIf(skip)(`${name}: sync disposal is refused and nothing is deleted`, async () => {
        await withDamagedKey(damage);
        expect(() => adapter.disposeWorkspaceSync("ws-1", OWNER)).toThrow(OwnerKeyError);
        expect(entries()).toEqual(["ws-1"]);
      });

      it.skipIf(skip)(`${name}: the orphan sweep skips the directory with an actionable reason`, async () => {
        await withDamagedKey(damage);
        const skipped: Array<[string, string]> = [];
        const reclaimed = await adapter.cleanupOrphanedWorkspaces(new Set<string>(), { onSkipped: (n, r) => skipped.push([n, r]) });
        expect(reclaimed).toEqual([]);
        expect(entries()).toEqual(["ws-1"]);
        expect(skipped).toHaveLength(1);
        expect(skipped[0]![1]).toMatch(/cannot be trusted/);
      });

      it.skipIf(skip)(`${name}: even with tolerateMissingMarker (crash cleanup) a present marker is not deleted through`, async () => {
        await withDamagedKey(damage);
        expect(() => adapter.disposeWorkspaceSync("ws-1", { ...OWNER, tolerateMissingMarker: true })).toThrow(OwnerKeyError);
        expect(entries()).toEqual(["ws-1"]);
      });

      it.skipIf(skip)(`${name}: provisioning a new owned workspace is refused and creates nothing`, async () => {
        await withDamagedKey(damage);
        await expect(adapter.provisionWorkspace(spec("ws-2"), OWNER)).rejects.toBeInstanceOf(OwnerKeyError);
        expect(entries()).toEqual(["ws-1"]);
      });
    }

    it("a signed marker is still accepted again once the key is valid (nothing was lost by refusing)", async () => {
      const marker = await withDamagedKey(corruptKey);
      await expect(adapter.disposeWorkspace("ws-1", OWNER)).rejects.toBeInstanceOf(OwnerKeyError);
      // the original key bytes are gone; the operator deletes the bad key (invalidating old markers) and the owner re-signs
      fs.rmSync(keyPath());
      fs.writeFileSync(path.join(root, "ws-1", ".emerald-owner.json"), issueOwnership(root, "ws-1", OWNER));
      await adapter.disposeWorkspace("ws-1", OWNER);
      expect(entries()).toEqual([]);
      expect(marker).toContain("mac"); // sanity: the original marker was a signed one
    });
  });
});
