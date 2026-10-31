/**
 * Workspace ownership marker (authenticated).
 *
 * The marker `.emerald-owner.json` names the run/lease that provisioned a workspace directory. It lives INSIDE the
 * workspace, i.e. in a directory the tenant (code running in the workspace) can write, so its bytes alone prove nothing.
 * Each marker therefore carries an HMAC-SHA256 over (workspaceId, runId, leaseId, nonce), keyed by a per-root secret stored in
 * `<workspaceRoot>/.emerald-owner-key` - a file OUTSIDE every workspace directory (the workspace root is not mounted
 * into container-isolated tools). A marker without a valid MAC is "invalid": never treated as a proven owner, so a
 * forged, edited, truncated or copied-from-another-workspace marker can only cause a refusal, never a deletion.
 *
 * Trust assumptions (not a security boundary against every tenant):
 *  - Holds only if tenant code cannot read the key file. That is true for container-isolated execution (only the
 *    workspace is mounted); it is NOT true for a tool running natively as the same OS user, which can read the key
 *    and forge a marker. Such a tenant can only harm its own run's workspace and still cannot make a different
 *    workspace id verify (the MAC binds the workspace id).
 *  - Replay of an older attempt's genuine marker (same workspace id, same run) is defeated by the OWNERSHIP LEDGER: every
 *    owned provisioning draws a fresh random nonce, puts it in the marker AND records the same authenticated entry in
 *    `<workspaceRoot>/.emerald-owner-ledger/<workspaceId>.json`, which like the key lies outside every workspace directory.
 *    A marker authenticates only if the ledger entry for that workspace id carries the identical (run, lease, nonce), so an
 *    old marker - nonce included - no longer matches once a newer attempt provisioned the same id. The expected current
 *    ownership therefore comes from the ledger, never from the tenant-writable directory. A native same-user tenant that
 *    can read the key can still forge BOTH files; the ledger shares the key's trust boundary, no more.
 *  - Markers written before the nonce existed (3-field MAC, no ledger entry) are "invalid" and are refused (fail closed):
 *    their workspaces are never deleted automatically and need operator cleanup. A missing ledger entry is also refused.
 *  - The MAC authenticates who provisioned the directory; it does not make the check-then-delete sequence atomic.
 *
 * Key file invariant (enforced by loadOwnerKey on EVERY load, i.e. before any marker is authenticated and so before any
 * destructive cleanup): the key must be a regular file (never a symbolic link), exactly 32 bytes, and on POSIX must not be
 * accessible to group or others (no 0o077 mode bits). A key that violates this is never trusted, never repaired and never
 * overwritten: loadOwnerKey throws OwnerKeyError, callers refuse to authenticate or delete, and an operator must fix it
 * (`chmod 600 <key>`, or delete it to invalidate every existing marker). Windows has no POSIX mode bits: there the mode
 * check is NOT performed and the key's protection rests on the directory ACL of the workspace root, which is not verified.
 * Keys created by earlier versions already have mode 0600 on POSIX and remain valid; markers are unchanged.
 */
import * as crypto from "node:crypto";
import * as syncFs from "node:fs";
import * as path from "node:path";

export const OWNER_MARKER = ".emerald-owner.json";
export const OWNER_KEY_FILE = ".emerald-owner-key";
const KEY_BYTES = 32;

export const OWNER_LEDGER_DIR = ".emerald-owner-ledger";
const NONCE_HEX = /^[0-9a-f]{32}$/;

export type OwnerMarkerRead =
  | { state: "absent" }
  | { state: "invalid" }
  | { state: "owner"; runId: string; leaseId: string; nonce: string };

export function ownerMac(key: Buffer, workspaceId: string, runId: string, leaseId: string, nonce: string): string {
  return crypto.createHmac("sha256", key).update(JSON.stringify([workspaceId, runId, leaseId, nonce])).digest("hex");
}

export function serializeOwnerMarker(key: Buffer, workspaceId: string, owner: { runId: string; leaseId: string }, nonce: string): string {
  return JSON.stringify({
    runId: owner.runId,
    leaseId: owner.leaseId,
    nonce,
    mac: ownerMac(key, workspaceId, owner.runId, owner.leaseId, nonce),
  });
}

/** Returns `owner` only for a well-formed marker whose MAC verifies for exactly this workspace id. */
export function verifyOwnerMarkerText(key: Buffer | null, workspaceId: string, text: string): OwnerMarkerRead {
  if (!key) return { state: "invalid" };
  try {
    const parsed = JSON.parse(text) as { runId?: unknown; leaseId?: unknown; nonce?: unknown; mac?: unknown };
    if (
      typeof parsed.runId !== "string" ||
      typeof parsed.leaseId !== "string" ||
      typeof parsed.nonce !== "string" ||
      !NONCE_HEX.test(parsed.nonce) ||
      typeof parsed.mac !== "string"
    ) {
      return { state: "invalid" };
    }
    const expected = Buffer.from(ownerMac(key, workspaceId, parsed.runId, parsed.leaseId, parsed.nonce), "hex");
    const actual = Buffer.from(parsed.mac, "hex");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return { state: "invalid" };
    return { state: "owner", runId: parsed.runId, leaseId: parsed.leaseId, nonce: parsed.nonce };
  } catch {
    return { state: "invalid" };
  }
}

/** The key exists but must not be trusted (insecure permissions, link, wrong size, unreadable). Always fail closed. */
export class OwnerKeyError extends Error {
  constructor(
    readonly keyPath: string,
    readonly reason: string
  ) {
    super(`Workspace ownership key '${keyPath}' cannot be trusted: ${reason}. Nothing was authenticated or deleted.`);
    this.name = "OwnerKeyError";
  }
}

/** Problem with a key file's mode on this platform, or null when acceptable. Pure, so it is testable on any OS. */
export function ownerKeyModeProblem(mode: number, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "win32") return null; // POSIX mode bits are meaningless on Windows (see the invariant above)
  return (mode & 0o077) === 0
    ? null
    : `mode ${(mode & 0o777).toString(8).padStart(3, "0")} allows group/other access; run 'chmod 600' on it (or delete it to invalidate all markers)`;
}

/**
 * Reads the key through ONE file descriptor: it is opened without following a link (O_NOFOLLOW where the platform has
 * it), and the type, mode and size that are checked are those of the very file whose bytes are returned, so there is no
 * gap between validation and use. Returns null only when the file does not exist.
 */
function readKeyFile(keyPath: string): Buffer | null {
  let lst: syncFs.Stats;
  try {
    lst = syncFs.lstatSync(keyPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new OwnerKeyError(keyPath, `cannot be inspected (${(err as NodeJS.ErrnoException).code ?? "error"})`);
  }
  if (lst.isSymbolicLink()) throw new OwnerKeyError(keyPath, "it is a symbolic link");
  let fd: number;
  try {
    fd = syncFs.openSync(keyPath, syncFs.constants.O_RDONLY | (syncFs.constants.O_NOFOLLOW ?? 0));
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new OwnerKeyError(keyPath, code === "ELOOP" ? "it is a symbolic link" : `cannot be opened (${code ?? "error"})`);
  }
  try {
    const st = syncFs.fstatSync(fd);
    if (!st.isFile()) throw new OwnerKeyError(keyPath, "it is not a regular file");
    const modeProblem = ownerKeyModeProblem(st.mode);
    if (modeProblem) throw new OwnerKeyError(keyPath, modeProblem);
    if (st.size !== KEY_BYTES) throw new OwnerKeyError(keyPath, `it is ${st.size} bytes, expected ${KEY_BYTES} (corrupt or truncated)`);
    const key = Buffer.alloc(KEY_BYTES);
    if (syncFs.readSync(fd, key, 0, KEY_BYTES, 0) !== KEY_BYTES) throw new OwnerKeyError(keyPath, "it could not be read completely");
    return key;
  } finally {
    syncFs.closeSync(fd);
  }
}

/**
 * Loads the per-root key. With `create`, a missing key is generated (published atomically by hard link, so a
 * concurrent reader never sees a partial key and two creators converge on one key). Without `create` a MISSING key yields
 * null (callers then treat every marker as invalid: fail closed). An existing key that violates the invariant throws
 * OwnerKeyError in both modes and is never replaced.
 */
export function loadOwnerKey(root: string, create: boolean): Buffer | null {
  const keyPath = path.join(root, OWNER_KEY_FILE);
  const existing = readKeyFile(keyPath);
  if (existing || !create) return existing;
  const tmp = path.join(root, `${OWNER_KEY_FILE}.${crypto.randomUUID()}.tmp`);
  try {
    syncFs.writeFileSync(tmp, crypto.randomBytes(KEY_BYTES), { mode: 0o600, flag: "wx" });
    try {
      syncFs.linkSync(tmp, keyPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  } finally {
    try {
      syncFs.unlinkSync(tmp);
    } catch {
      // best effort: a leftover .tmp file is inert (not a directory, ignored by the sweep)
    }
  }
  const key = readKeyFile(keyPath);
  if (!key) throw new OwnerKeyError(keyPath, "it is missing right after creation");
  return key;
}

function ledgerPath(root: string, workspaceId: string): string {
  return path.join(root, OWNER_LEDGER_DIR, `${workspaceId}.json`);
}

/**
 * Starts a new ownership generation for `workspaceId`: draws a fresh nonce, atomically (re)writes the authenticated ledger
 * entry outside the workspace directory, and returns the marker text to place INSIDE the workspace. Any marker of an earlier
 * generation stops authenticating the moment this returns.
 */
export function issueOwnership(root: string, workspaceId: string, owner: { runId: string; leaseId: string }): string {
  const key = loadOwnerKey(root, true)!;
  const nonce = crypto.randomBytes(16).toString("hex");
  const text = serializeOwnerMarker(key, workspaceId, owner, nonce);
  const dir = path.join(root, OWNER_LEDGER_DIR);
  syncFs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `${workspaceId}.${crypto.randomUUID()}.tmp`);
  try {
    syncFs.writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    syncFs.renameSync(tmp, ledgerPath(root, workspaceId));
  } catch (err: unknown) {
    try {
      syncFs.unlinkSync(tmp);
    } catch {
      // nothing to clean
    }
    throw err;
  }
  return text;
}

/**
 * Authenticates marker text found at `workspaceId` and cross-checks it against the ledger: the result is `owner` only when
 * the marker's MAC verifies AND the ledger holds an authenticated entry with the identical run, lease and nonce.
 * Throws OwnerKeyError for an untrustworthy key. A missing, unreadable, link, malformed or different ledger entry is "invalid".
 */
export function readAuthenticatedOwner(root: string, workspaceId: string, markerText: string): OwnerMarkerRead {
  const key = loadOwnerKey(root, false);
  const marker = verifyOwnerMarkerText(key, workspaceId, markerText);
  if (marker.state !== "owner") return marker;
  try {
    const p = ledgerPath(root, workspaceId);
    const st = syncFs.lstatSync(p);
    if (!st.isFile() || st.isSymbolicLink()) return { state: "invalid" };
    const entry = verifyOwnerMarkerText(key, workspaceId, syncFs.readFileSync(p, "utf8"));
    return entry.state === "owner" && entry.runId === marker.runId && entry.leaseId === marker.leaseId && entry.nonce === marker.nonce
      ? marker
      : { state: "invalid" };
  } catch {
    return { state: "invalid" };
  }
}

/** Removes the ledger entry after a verified disposal, only if it still names the generation that was disposed. */
export function clearOwnership(root: string, workspaceId: string, nonce: string): void {
  try {
    const p = ledgerPath(root, workspaceId);
    const entry = verifyOwnerMarkerText(loadOwnerKey(root, false), workspaceId, syncFs.readFileSync(p, "utf8"));
    if (entry.state === "owner" && entry.nonce === nonce) syncFs.unlinkSync(p);
  } catch {
    // best effort: a stale entry is harmless, the next provisioning of this id replaces it
  }
}
