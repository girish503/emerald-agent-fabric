/**
 * Emerald Agent Fabric — Quarantine Diagnostics (Read-Only)
 *
 * Implements read-only operator diagnostic queries over persisted tenant launch-gate records (ADR-0038/ADR-0041).
 * Restricts exposed data strictly to existing SQLite schema fields:
 *   1. run_id
 *   2. holder_type
 *   3. holder_id
 *   4. state
 *   5. acquired_at
 *   6. expires_at
 *   7. released_at
 *   8. owner_pid
 *
 * Under no circumstances does this module mutate the database, acquire/release gates, bypass fencing,
 * trigger recovery sweeps, dispose workspaces, or invoke Docker operations.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { SqliteStateStore } from "../adapters/persistence/sqlite-state-store.js";
import type { TenantLaunchGate } from "../ports/tenant-launch-coordinator.port.js";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync: NodeDatabaseSync } = nodeRequire("node:sqlite") as { DatabaseSync: typeof DatabaseSync };

/**
 * Project-approved diagnostic record containing exclusively the eight existing SQLite schema fields.
 * Internal fields (token, lease_id) and non-existent speculative fields (reason) are strictly excluded.
 */
export interface TenantLaunchGateDiagnostic {
  readonly run_id: string;
  readonly holder_type: string;
  readonly holder_id: string;
  readonly state: string;
  readonly acquired_at: string;
  readonly expires_at: string;
  readonly released_at: string | null;
  readonly owner_pid: number | null;
}

/**
 * Projects a domain TenantLaunchGate record into the 8 diagnostic fields.
 */
export function projectLaunchGateDiagnostic(gate: TenantLaunchGate): TenantLaunchGateDiagnostic {
  return {
    run_id: gate.runId,
    holder_type: gate.holderType,
    holder_id: gate.holderId,
    state: gate.state,
    acquired_at: gate.acquiredAt,
    expires_at: gate.expiresAt,
    released_at: gate.releasedAt ?? null,
    owner_pid: gate.ownerPid ?? null,
  };
}

/**
 * Formats a single diagnostic record into deterministic, human-readable text.
 */
export function formatLaunchGateDiagnostic(d: TenantLaunchGateDiagnostic): string {
  return [
    `run_id:      ${d.run_id}`,
    `holder_type: ${d.holder_type}`,
    `holder_id:   ${d.holder_id}`,
    `state:       ${d.state}`,
    `acquired_at: ${d.acquired_at}`,
    `expires_at:  ${d.expires_at}`,
    `released_at: ${d.released_at !== null ? d.released_at : "none"}`,
    `owner_pid:   ${d.owner_pid !== null ? String(d.owner_pid) : "none"}`,
  ].join("\n");
}

/**
 * Formats multiple diagnostic records into a deterministic report block.
 */
export function formatLaunchGateDiagnostics(records: readonly TenantLaunchGateDiagnostic[]): string {
  if (records.length === 0) {
    return "No tenant launch gates found.";
  }
  const header =
    records.length === 1
      ? "Tenant Launch Gate Status:\n=========================="
      : `Tenant Launch Gate Status (${records.length} records):\n======================================`;
  const formatted = records.map(formatLaunchGateDiagnostic).join("\n--------------------------------------\n");
  return `${header}\n${formatted}`;
}

export type ReadLaunchGateDiagnosticsResult =
  | { readonly status: "OK"; readonly records: readonly TenantLaunchGateDiagnostic[] }
  | { readonly status: "NOT_FOUND"; readonly message: string }
  | { readonly status: "ERROR"; readonly error: string };

/**
 * Reads tenant launch-gate records in strict read-only mode (PRAGMA query_only = ON).
 * Fails closed on any filesystem or SQLite errors without attempting mutation or recovery.
 */
export function readTenantLaunchGateDiagnostics(options: {
  readonly dbPath: string;
  readonly runId?: string;
}): ReadLaunchGateDiagnosticsResult {
  const { dbPath, runId } = options;

  if (!dbPath || typeof dbPath !== "string" || dbPath === ":memory:") {
    return { status: "ERROR", error: "dbPath must be the path of an existing database file (not :memory:)" };
  }

  if (!fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) {
    return { status: "ERROR", error: `Database not found (recovery status never creates one): ${dbPath}` };
  }

  const stat = fs.statSync(dbPath);
  if (stat.size === 0) {
    return { status: "ERROR", error: `Database file is empty: ${dbPath}` };
  }

  let db: DatabaseSync | undefined;
  try {
    db = new NodeDatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA query_only = ON;");

    // Verify table presence before attempting query
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tenant_launch_gates'")
      .get() as { name?: string } | undefined;

    if (!tableExists) {
      if (runId) {
        return { status: "NOT_FOUND", message: `No tenant launch gate found for run '${runId}'.` };
      }
      return { status: "OK", records: [] };
    }

    const store = new SqliteStateStore(db);

    if (runId) {
      const gate = store.getTenantLaunchGate(runId);
      if (!gate) {
        return { status: "NOT_FOUND", message: `No tenant launch gate found for run '${runId}'.` };
      }
      return { status: "OK", records: [projectLaunchGateDiagnostic(gate)] };
    }

    const gates = store.listTenantLaunchGates ? store.listTenantLaunchGates() : [];
    return { status: "OK", records: gates.map(projectLaunchGateDiagnostic) };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "ERROR", error: `Database access failed: ${msg}` };
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore cleanup error on closed handles
    }
  }
}
