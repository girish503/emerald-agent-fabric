import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { OWNER_KEY_FILE, OWNER_LEDGER_DIR, loadOwnerKey, ownerMac } from "../../src/adapters/workspace/owner-marker.js";
import { WorkspaceOwnershipError } from "../../src/domain/errors.js";
import type { WorkspaceSpec } from "../../src/domain/workspace.js";

const A = { runId: "run-1", leaseId: "lease-A" }; // attempt 1
const B = { runId: "run-1", leaseId: "lease-B" }; // attempt 2 of the SAME run (same workspace id)
const spec = (workspaceId: string): WorkspaceSpec =>
  ({ workspaceId, runId: "run-1", taskId: "t", maxWorkspaceBytes: 1 << 20, maxFileSizeBytes: 1 << 20 }) as WorkspaceSpec;

/**
 * Stale-attempt marker replay. A workspace id is stable per run, so a genuine marker of attempt 1 is a perfectly valid
 * MAC for attempt 2's directory too. Authorization therefore also requires the OWNERSHIP LEDGER entry (outside the workspace)
 * to carry the same per-provisioning nonce; provisioning attempt 2 replaces that entry, which retires every older marker.
 */
describe("ownership ledger defeats replay of an older attempt's genuine marker", () => {
  let root: string;
  let adapter: NodeFsWorkspaceAdapter;
  const markerPath = (id = "ws-1") => path.join(root, id, ".emerald-owner.json");
  const ledgerFile = (id = "ws-1") => path.join(root, OWNER_LEDGER_DIR, `${id}.json`);
  const entries = () => fs.readdirSync(root).filter((n) => n !== OWNER_KEY_FILE && n !== OWNER_LEDGER_DIR).sort();

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "emerald-ledger-")));
    adapter = new NodeFsWorkspaceAdapter({ workspaceRoot: root });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  /** Attempt 1 provisions (its genuine marker is captured), is cleaned up by an unowned crash cleanup; attempt 2 provisions the same id. */
  async function twoAttempts() {
    await adapter.provisionWorkspace(spec("ws-1"), A);
    const oldMarker = fs.readFileSync(markerPath(), "utf8");
    await adapter.disposeWorkspace("ws-1"); // unowned (operator / marker-less path): the ledger entry of attempt 1 survives
    await adapter.provisionWorkspace(spec("ws-1"), B);
    fs.writeFileSync(path.join(root, "ws-1", "b-work.txt"), "B's data");
    return { oldMarker, newMarker: fs.readFileSync(markerPath(), "utf8") };
  }

  const snapshot = () => ({
    work: fs.readFileSync(path.join(root, "ws-1", "b-work.txt"), "utf8"),
    meta: fs.readFileSync(path.join(root, "ws-1", ".emerald-workspace.json"), "utf8"),
    marker: fs.readFileSync(markerPath(), "utf8"),
    ledger: fs.readFileSync(ledgerFile(), "utf8"),
    entries: entries(),
  });

  it("1. the current attempt's marker authorizes disposal of its own workspace, and its ledger entry is retired", async () => {
    await adapter.provisionWorkspace(spec("ws-1"), B);
    expect(fs.existsSync(ledgerFile())).toBe(true);
    await adapter.disposeWorkspace("ws-1", B);
    expect(entries()).toEqual([]);
    expect(fs.existsSync(ledgerFile())).toBe(false);
  });

  it("2. a genuine OLDER-attempt marker replayed into the newer workspace cannot authorize its disposal (async); nothing is touched", async () => {
    const { oldMarker, newMarker } = await twoAttempts();
    expect(oldMarker).not.toBe(newMarker);
    fs.writeFileSync(markerPath(), oldMarker); // the replay: genuine MAC, genuine lease-A identity
    const before = snapshot();

    await expect(adapter.disposeWorkspace("ws-1", A)).rejects.toBeInstanceOf(WorkspaceOwnershipError); // the stale holder
    await expect(adapter.disposeWorkspace("ws-1", B)).rejects.toBeInstanceOf(WorkspaceOwnershipError); // the rightful owner is refused too (marker was tampered)

    expect(snapshot()).toEqual(before); // contents, metadata, marker, ledger entry and root listing all untouched
  });

  it("2b. same replay through the synchronous path (crash cleanup)", async () => {
    const { oldMarker } = await twoAttempts();
    fs.writeFileSync(markerPath(), oldMarker);
    const before = snapshot();
    expect(() => adapter.disposeWorkspaceSync("ws-1", A)).toThrow(WorkspaceOwnershipError);
    expect(() => adapter.disposeWorkspaceSync("ws-1", { ...A, tolerateMissingMarker: true })).toThrow(WorkspaceOwnershipError);
    expect(snapshot()).toEqual(before);
  });

  it("2c. the orphan sweep does not reclaim the replayed directory and reports it", async () => {
    const { oldMarker } = await twoAttempts();
    fs.writeFileSync(markerPath(), oldMarker);
    const skipped: string[] = [];
    const reclaimed = await adapter.cleanupOrphanedWorkspaces(new Set<string>(), { onSkipped: (_n, r) => skipped.push(r) });
    expect(reclaimed).toEqual([]);
    expect(skipped).toEqual([expect.stringMatching(/not authenticated/)]);
    expect(fs.readFileSync(path.join(root, "ws-1", "b-work.txt"), "utf8")).toBe("B's data");
  });

  it("3. copying the old marker together with its nonce, or splicing the new nonce onto the old identity, does not bypass the check", async () => {
    const { oldMarker, newMarker } = await twoAttempts();
    const oldM = JSON.parse(oldMarker);
    const newM = JSON.parse(newMarker);
    const forgeries: Array<[string, object]> = [
      ["old marker verbatim (old nonce)", oldM],
      ["old identity + NEW nonce, old MAC", { ...oldM, nonce: newM.nonce }],
      ["new identity + OLD nonce, new MAC", { ...newM, nonce: oldM.nonce }],
      ["old identity, new nonce and new MAC", { ...newM, leaseId: A.leaseId }],
    ];
    const before = snapshot();
    for (const [name, forged] of forgeries) {
      fs.writeFileSync(markerPath(), JSON.stringify(forged));
      await expect(adapter.disposeWorkspace("ws-1", A), name).rejects.toBeInstanceOf(WorkspaceOwnershipError);
      await expect(adapter.disposeWorkspace("ws-1", B), name).rejects.toBeInstanceOf(WorkspaceOwnershipError);
    }
    fs.writeFileSync(markerPath(), before.marker);
    expect(snapshot()).toEqual(before);
    await adapter.disposeWorkspace("ws-1", B); // and the genuine, current marker still works afterwards
    expect(entries()).toEqual([]);
  });

  it("4. a wrong run id, lease id or workspace id is refused", async () => {
    await adapter.provisionWorkspace(spec("ws-1"), B);
    for (const wrong of [{ runId: "run-other", leaseId: B.leaseId }, { runId: B.runId, leaseId: "lease-other" }, { runId: "run-other", leaseId: "lease-other" }]) {
      await expect(adapter.disposeWorkspace("ws-1", wrong)).rejects.toBeInstanceOf(WorkspaceOwnershipError);
    }
    await adapter.provisionWorkspace(spec("ws-2"), B);
    fs.copyFileSync(markerPath("ws-1"), markerPath("ws-2")); // genuine marker of ANOTHER workspace id
    fs.copyFileSync(ledgerFile("ws-1"), ledgerFile("ws-2")); // and its ledger entry
    await expect(adapter.disposeWorkspace("ws-2", B)).rejects.toBeInstanceOf(WorkspaceOwnershipError);
    expect(entries()).toEqual(["ws-1", "ws-2"]);
  });

  it("5. a marker whose ledger entry is missing, or that predates the nonce, is refused (fail closed) and the directory survives", async () => {
    await adapter.provisionWorkspace(spec("ws-1"), B);
    fs.rmSync(ledgerFile());
    await expect(adapter.disposeWorkspace("ws-1", B)).rejects.toBeInstanceOf(WorkspaceOwnershipError);
    expect(entries()).toEqual(["ws-1"]);

    // a pre-nonce marker: genuine 3-field MAC, valid key, no nonce, no ledger
    const key = loadOwnerKey(root, false)!;
    const legacyMac = crypto.createHmac("sha256", key).update(JSON.stringify(["ws-1", B.runId, B.leaseId])).digest("hex");
    fs.writeFileSync(markerPath(), JSON.stringify({ ...B, mac: legacyMac }));
    await expect(adapter.disposeWorkspace("ws-1", B)).rejects.toBeInstanceOf(WorkspaceOwnershipError);
    expect(() => adapter.disposeWorkspaceSync("ws-1", B)).toThrow(WorkspaceOwnershipError);
    expect(entries()).toEqual(["ws-1"]);
  });

  it("6. the ledger entry itself must authenticate: a tampered ledger entry refuses", async () => {
    await adapter.provisionWorkspace(spec("ws-1"), B);
    const good = fs.readFileSync(ledgerFile(), "utf8");
    const tampered = JSON.parse(good);
    tampered.leaseId = "lease-evil"; // MAC no longer matches
    fs.writeFileSync(ledgerFile(), JSON.stringify(tampered));
    await expect(adapter.disposeWorkspace("ws-1", B)).rejects.toBeInstanceOf(WorkspaceOwnershipError);
    fs.writeFileSync(ledgerFile(), good);
    expect(ownerMac(loadOwnerKey(root, false)!, "ws-1", B.runId, B.leaseId, JSON.parse(good).nonce)).toBe(JSON.parse(good).mac);
    await adapter.disposeWorkspace("ws-1", B); // restored entry: works
    expect(entries()).toEqual([]);
  });

  it("7. legitimate recovery: after attempt 1's crash cleanup and attempt 2's provisioning, attempt 2's own cleanup and a later attempt 3 work", async () => {
    await adapter.provisionWorkspace(spec("ws-1"), A);
    adapter.disposeWorkspaceSync("ws-1", { ...A, tolerateMissingMarker: true }); // coordinator crash cleanup of attempt 1
    expect(fs.existsSync(ledgerFile())).toBe(false);
    await adapter.provisionWorkspace(spec("ws-1"), B);
    await adapter.disposeWorkspace("ws-1", B);
    await adapter.provisionWorkspace(spec("ws-1"), { runId: "run-1", leaseId: "lease-C" });
    expect(entries()).toEqual(["ws-1"]);
  });
});
