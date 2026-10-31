import { ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { OWNER_KEY_FILE, OWNER_LEDGER_DIR } from "../../src/adapters/workspace/owner-marker.js";
import type { WorkspaceSpec } from "../../src/domain/workspace.js";

const isWindows = process.platform === "win32";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const OWNER = { runId: "run-1", leaseId: "lease-A" };
const spec = (workspaceId: string): WorkspaceSpec =>
  ({ workspaceId, runId: "run-1", taskId: "t", maxWorkspaceBytes: 1 << 28, maxFileSizeBytes: 1 << 28 }) as WorkspaceSpec;

/**
 * Disposal against a LIVE tenant (a process that still has its working directory inside the workspace). POSIX only: on
 * Windows a live handle makes the rename-aside fail outright (measured), and these tests are SKIPPED there - they have not been
 * run by vitest on POSIX in this repository's history so far; see docs/HANDOFF.md for the container-level evidence.
 *
 * What is asserted is deliberately outcome-agnostic: against a live tenant disposal may succeed or fail closed, but it may
 * NEVER change or delete anything outside the workspace root, and a failure must leave only the verified tombstone, which a
 * later sweep removes once the tenant is gone. This does NOT make disposal safe against a live tenant (rename-aside does not
 * stop one); the contract that disposal only runs after the attempt's processes are verifiably gone is still missing.
 */
describe.skipIf(isWindows)("POSIX: disposal with a live tenant process", { timeout: 120_000 }, () => {
  let base: string;
  let root: string;
  let outside: string;
  let adapter: NodeFsWorkspaceAdapter;
  const children: ChildProcess[] = [];
  const TENANT = `
    const fs = require("node:fs");
    const [ws, out] = process.argv.slice(1);
    process.chdir(ws);
    process.stdout.write("ready\\n");
    for (;;) for (let i = 0; i < 40; i++) {
      const d = "s" + i;
      try { fs.rmSync(d, { recursive: true, force: true }); fs.symlinkSync(out, d); fs.unlinkSync(d); fs.mkdirSync(d); fs.writeFileSync(d + "/f", "x"); } catch {}
    }`;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "emerald-livetenant-")));
    root = path.join(base, "root");
    outside = path.join(base, "outside");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    adapter = new NodeFsWorkspaceAdapter({ workspaceRoot: root });
  });
  afterEach(async () => {
    for (const c of children.splice(0)) {
      if (c.exitCode === null && c.signalCode === null) {
        c.kill("SIGKILL");
        await new Promise((r) => c.once("exit", r));
      }
    }
    try {
      fs.chmodSync(outside, 0o755);
    } catch {
      // already removed
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  async function startTenant(cwd: string): Promise<ChildProcess> {
    const child = spawn(process.execPath, ["-e", TENANT, cwd, outside], { stdio: ["ignore", "pipe", "ignore"] });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once("data", () => resolve());
      child.once("exit", () => reject(new Error("tenant exited early")));
    });
    return child;
  }
  const kill = async (c: ChildProcess) => {
    c.kill("SIGKILL");
    await new Promise((r) => c.once("exit", r));
  };

  it("a tenant swapping directories for symlinks while disposal runs never changes or deletes anything outside the root", async () => {
    const TRIALS = 15;
    const sentinels = Array.from({ length: 50 }, (_, i) => path.join(outside, `keep${i}`));
    for (const s of sentinels) {
      fs.writeFileSync(s, "precious");
      fs.chmodSync(s, 0o444);
    }
    fs.chmodSync(outside, 0o755);

    // a NEWER attempt's workspace (different id) that must be untouched throughout
    await adapter.provisionWorkspace(spec("ws-newer"), { runId: "run-2", leaseId: "lease-N" });
    const newerMarker = fs.readFileSync(path.join(root, "ws-newer", ".emerald-owner.json"), "utf8");
    const newerLedger = fs.readFileSync(path.join(root, OWNER_LEDGER_DIR, "ws-newer.json"), "utf8");

    for (let t = 0; t < TRIALS; t++) {
      adapter = new NodeFsWorkspaceAdapter({ workspaceRoot: root }); // a failed disposal keeps the id registered in THIS instance
      const h = await adapter.provisionWorkspace(spec("ws-1"), OWNER);
      for (let i = 0; i < 40; i++) {
        fs.mkdirSync(path.join(h.hostPath, `s${i}`));
        for (let j = 0; j < 20; j++) fs.writeFileSync(path.join(h.hostPath, `s${i}`, `f${j}`), "x");
      }
      const tenant = await startTenant(h.hostPath);
      await adapter.disposeWorkspace("ws-1", OWNER).then(
        () => undefined,
        () => undefined // failing closed against a live tenant is an acceptable outcome
      );
      await kill(tenant);

      for (const s of sentinels) {
        expect(fs.existsSync(s), `trial ${t}: outside file deleted`).toBe(true);
        expect(fs.statSync(s).mode & 0o222, `trial ${t}: outside file mode changed`).toBe(0);
      }
      expect(fs.statSync(outside).mode & 0o777, `trial ${t}: outside directory mode changed`).toBe(0o755);

      // whatever disposal left is only the verified tombstone; once the tenant is gone a sweep finishes it
      const left = fs.readdirSync(root).filter((n) => ![OWNER_KEY_FILE, OWNER_LEDGER_DIR, "ws-newer"].includes(n));
      expect(left.every((n) => n.startsWith(".disposed-")), `trial ${t}: unexpected residue ${left.join(",")}`).toBe(true);
      await adapter.cleanupOrphanedWorkspaces(new Set<string>(["ws-newer"]));
      expect(fs.readdirSync(root).filter((n) => ![OWNER_KEY_FILE, OWNER_LEDGER_DIR, "ws-newer"].includes(n))).toEqual([]);
    }
    expect(fs.readFileSync(path.join(root, "ws-newer", ".emerald-owner.json"), "utf8")).toBe(newerMarker);
    expect(fs.readFileSync(path.join(root, OWNER_LEDGER_DIR, "ws-newer.json"), "utf8")).toBe(newerLedger);
  });

  it.skipIf(isRoot)("a read-only DIRECTORY inside the workspace makes disposal fail closed (no chmod walk); the tombstone and ledger are kept, and an operator fix lets a sweep finish", async () => {
    const h = await adapter.provisionWorkspace(spec("ws-1"), OWNER);
    fs.mkdirSync(path.join(h.hostPath, "ro"));
    fs.writeFileSync(path.join(h.hostPath, "ro", "f"), "x");
    fs.chmodSync(path.join(h.hostPath, "ro"), 0o555);

    await expect(adapter.disposeWorkspace("ws-1", OWNER)).rejects.toThrow(/EACCES|EPERM/);
    const tombstones = fs.readdirSync(root).filter((n) => n.startsWith(".disposed-"));
    expect(tombstones).toHaveLength(1);
    expect(fs.existsSync(path.join(root, tombstones[0]!, "ro", "f"))).toBe(true);

    const skipped: string[] = [];
    await adapter.cleanupOrphanedWorkspaces(new Set<string>(), { onSkipped: (_n, r) => skipped.push(r) });
    expect(skipped).toEqual([expect.stringMatching(/tombstone not removable yet/)]); // reported, not silent

    fs.chmodSync(path.join(root, tombstones[0]!, "ro"), 0o755); // the operator's fix
    expect(await adapter.cleanupOrphanedWorkspaces(new Set<string>())).toEqual(tombstones);
    expect(fs.readdirSync(root).filter((n) => n.startsWith(".disposed-"))).toEqual([]);
  });
});
