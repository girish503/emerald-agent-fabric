/**
 * SQLite-backed & In-Memory Tenant Launch Coordinator (ADR-0038).
 *
 * Implements cross-process mutual exclusion for tenant container creation
 * and recovery-owned quiescence verification / workspace disposal.
 */

import { ClockPort, SystemClock } from "../../ports/clock.port.js";
import { StateStorePort } from "../../ports/state-store.port.js";
import {
  AcquireGateParams,
  TenantLaunchCoordinatorPort,
  TenantLaunchGate,
} from "../../ports/tenant-launch-coordinator.port.js";
import {
  TenantLaunchGateConflictError,
  TenantLaunchGateTimeoutError,
} from "../../domain/errors.js";

/** A recorded owner PID is usable evidence only when it is a positive integer. */
function isValidOwnerPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0;
}

export interface SqliteTenantLaunchCoordinatorConfig {
  readonly pollIntervalMs?: number;
}

export class SqliteTenantLaunchCoordinator implements TenantLaunchCoordinatorPort {
  readonly store: StateStorePort;
  private readonly clock: ClockPort;
  private readonly pollIntervalMs: number;

  constructor(
    store: StateStorePort,
    clock?: ClockPort,
    config: SqliteTenantLaunchCoordinatorConfig = {}
  ) {
    this.store = store;
    this.clock = clock ?? new SystemClock();
    this.pollIntervalMs = config.pollIntervalMs ?? 50;
  }

  async acquire(params: AcquireGateParams): Promise<TenantLaunchGate> {
    const timeoutMs = params.timeoutMs ?? 5_000;
    const startMs = Date.now();

    while (true) {
      const nowIso = this.clock.nowIso();
      try {
        return this.store.acquireTenantLaunchGate({
          runId: params.runId,
          holderType: params.holderType,
          holderId: params.holderId,
          leaseId: params.leaseId,
          nowIso,
          ttlMs: params.ttlMs,
          ownerPid: params.ownerPid,
        });
      } catch (err: unknown) {
        if (err instanceof TenantLaunchGateConflictError) {
          const elapsedMs = Date.now() - startMs;
          if (elapsedMs >= timeoutMs) {
            throw new TenantLaunchGateTimeoutError(params.runId, timeoutMs, err.message);
          }
          await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
          continue;
        }
        throw err;
      }
    }
  }

  async release(gate: TenantLaunchGate): Promise<void> {
    const nowIso = this.clock.nowIso();
    this.store.releaseTenantLaunchGate({
      runId: gate.runId,
      token: gate.token,
      nowIso,
    });
  }

  async quarantine(gate: TenantLaunchGate, reason?: string): Promise<void> {
    const nowIso = this.clock.nowIso();
    if (typeof this.store.quarantineTenantLaunchGate === "function") {
      this.store.quarantineTenantLaunchGate({
        runId: gate.runId,
        token: gate.token,
        nowIso,
        reason,
      });
    }
  }

  async markQuiescent(gate: TenantLaunchGate): Promise<void> {
    const nowIso = this.clock.nowIso();
    if (typeof (this.store as any).markQuiescentTenantLaunchGate === "function") {
      (this.store as any).markQuiescentTenantLaunchGate({
        runId: gate.runId,
        token: gate.token,
        nowIso,
      });
    }
  }
}

/**
 * Deterministic in-memory coordination gate for testing and single-process harnesses.
 */
export class InMemoryTenantLaunchCoordinator implements TenantLaunchCoordinatorPort {
  private readonly clock: ClockPort;
  private readonly pollIntervalMs: number;
  private readonly gates = new Map<string, TenantLaunchGate>();

  constructor(clock?: ClockPort, pollIntervalMs = 20) {
    this.clock = clock ?? new SystemClock();
    this.pollIntervalMs = pollIntervalMs;
  }

  async acquire(params: AcquireGateParams): Promise<TenantLaunchGate> {
    const timeoutMs = params.timeoutMs ?? 5_000;
    const startMs = Date.now();
    const ttlMs = params.ttlMs ?? 30_000;

    while (true) {
      const nowIso = this.clock.nowIso();
      const existing = this.gates.get(params.runId);
      // Owner identity is (holderId, ownerPid): the same holderId from a different process is a takeover, not re-entry.
      const isSameOwner =
        !!existing &&
        existing.holderId === params.holderId &&
        existing.holderType === params.holderType &&
        isValidOwnerPid(existing.ownerPid) &&
        existing.ownerPid === params.ownerPid;

      if (existing) {
        if (existing.state === "QUARANTINED") {
          if (params.holderType === "WORKER") {
            throw new TenantLaunchGateConflictError(
              params.runId,
              existing.holderType,
              existing.holderId,
              existing.expiresAt,
              `Tenant execution for run '${params.runId}' is QUARANTINED (prior container termination unverified); worker launch refused.`
            );
          }
          // Recovery can acquire a quarantined gate to probe quiescence
        } else if (existing.state === "QUIESCED") {
          if (params.holderType === "WORKER") {
            throw new TenantLaunchGateConflictError(
              params.runId,
              existing.holderType,
              existing.holderId,
              existing.expiresAt,
              `Tenant execution for run '${params.runId}' is QUIESCED under recovery; worker launch refused.`
            );
          }
          if (!isSameOwner) {
            const nowMs = new Date(nowIso).getTime();
            const expiresMs = new Date(existing.expiresAt).getTime();
            if (!Number.isFinite(nowMs) || !Number.isFinite(expiresMs)) {
              throw new TenantLaunchGateConflictError(
                params.runId,
                existing.holderType,
                existing.holderId,
                existing.expiresAt,
                `Tenant launch gate for run '${params.runId}' has an unparseable expiry or acquisition time; QUIESCED gate takeover refused fail-closed.`
              );
            }
            if (nowMs < expiresMs) {
              const elapsedMs = Date.now() - startMs;
              if (elapsedMs >= timeoutMs) {
                throw new TenantLaunchGateTimeoutError(
                  params.runId,
                  timeoutMs,
                  `Gate held in QUIESCED by ${existing.holderType} '${existing.holderId}' until ${existing.expiresAt}`
                );
              }
              await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
              continue;
            }
            const pid = existing.ownerPid;
            if (!pid || !Number.isInteger(pid) || pid <= 0) {
              throw new TenantLaunchGateConflictError(
                params.runId,
                existing.holderType,
                existing.holderId,
                existing.expiresAt,
                `Recovery supervisor '${existing.holderId}' process identity is unknown or unrecorded; QUIESCED gate takeover refused fail-closed.`
              );
            }

            let isAlive = true;
            try {
              process.kill(pid, 0);
              isAlive = true;
            } catch (err: any) {
              if (err.code === "ESRCH") {
                isAlive = false;
              } else {
                // EPERM or other error: indeterminate, fail closed per Requirement 1
                isAlive = true;
              }
            }
            if (isAlive) {
              throw new TenantLaunchGateConflictError(
                params.runId,
                existing.holderType,
                existing.holderId,
                existing.expiresAt,
                `Recovery supervisor '${existing.holderId}' (PID ${pid}) is still alive; QUIESCED gate takeover refused.`
              );
            }
          }
        } else if (existing.state === "ACQUIRED") {
          if (existing.holderType === "RECOVERY" && params.holderType === "WORKER") {
            throw new TenantLaunchGateConflictError(
              params.runId,
              existing.holderType,
              existing.holderId,
              existing.expiresAt,
              `Tenant launch gate for run '${params.runId}' was held by recovery supervisor '${existing.holderId}'; worker acquisition refused fail-closed.`
            );
          }
          const nowMs = new Date(nowIso).getTime();
          const expiresMs = new Date(existing.expiresAt).getTime();
          // An unparseable expiry or clock is never evidence that the gate has expired.
          if (!Number.isFinite(nowMs) || !Number.isFinite(expiresMs)) {
            throw new TenantLaunchGateConflictError(
              params.runId,
              existing.holderType,
              existing.holderId,
              existing.expiresAt,
              `Tenant launch gate for run '${params.runId}' has an unparseable expiry or acquisition time; takeover refused fail-closed.`
            );
          }
          if (nowMs < expiresMs) {
            const elapsedMs = Date.now() - startMs;
            if (elapsedMs >= timeoutMs) {
              throw new TenantLaunchGateTimeoutError(
                params.runId,
                timeoutMs,
                `Gate held by ${existing.holderType} '${existing.holderId}' until ${existing.expiresAt}`
              );
            }
            await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
            continue;
          }
          if (existing.holderType === "RECOVERY" && params.holderType === "WORKER") {
            throw new TenantLaunchGateConflictError(
              params.runId,
              existing.holderType,
              existing.holderId,
              existing.expiresAt,
              `Tenant launch gate for run '${params.runId}' was held by recovery supervisor '${existing.holderId}'; worker acquisition refused fail-closed.`
            );
          }
          // Expiry is not proof of death (parity with the SQLite store): a different holder may take over
          // only when the recorded owner process is confirmed gone. Missing or indeterminate fails closed.
          if (!isSameOwner) {
            const pid = existing.ownerPid;
            if (!pid || !Number.isInteger(pid) || pid <= 0) {
              throw new TenantLaunchGateConflictError(
                params.runId,
                existing.holderType,
                existing.holderId,
                existing.expiresAt,
                `${existing.holderType} '${existing.holderId}' process identity is unknown or unrecorded; tenant launch gate stealing refused fail-closed.`
              );
            }
            let isAlive = true;
            try {
              process.kill(pid, 0);
            } catch (err: any) {
              isAlive = err?.code !== "ESRCH";
            }
            if (isAlive) {
              throw new TenantLaunchGateConflictError(
                params.runId,
                existing.holderType,
                existing.holderId,
                existing.expiresAt,
                `${existing.holderType} '${existing.holderId}' (PID ${pid}) is still alive; tenant launch gate stealing refused.`
              );
            }
          }
        }
      }

      const expiresAt = new Date(new Date(nowIso).getTime() + ttlMs).toISOString();
      const token = `tok-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const gate: TenantLaunchGate = {
        runId: params.runId,
        holderType: params.holderType,
        holderId: params.holderId,
        leaseId: params.leaseId,
        token,
        acquiredAt: nowIso,
        expiresAt,
        state: "ACQUIRED",
        ownerPid: params.ownerPid,
      };

      this.gates.set(params.runId, gate);
      return gate;
    }
  }

  async release(gate: TenantLaunchGate): Promise<void> {
    const existing = this.gates.get(gate.runId);
    if (existing && existing.token === gate.token && (existing.state === "ACQUIRED" || existing.state === "QUIESCED")) {
      this.gates.set(gate.runId, {
        ...existing,
        state: "RELEASED",
        releasedAt: this.clock.nowIso(),
      });
    }
  }

  async quarantine(gate: TenantLaunchGate, _reason?: string): Promise<void> {
    const existing = this.gates.get(gate.runId);
    if (existing && existing.token === gate.token) {
      this.gates.set(gate.runId, {
        ...existing,
        state: "QUARANTINED",
        releasedAt: this.clock.nowIso(),
      });
    }
  }

  async markQuiescent(gate: TenantLaunchGate): Promise<void> {
    const existing = this.gates.get(gate.runId);
    if (!existing || existing.token !== gate.token || existing.holderType !== "RECOVERY" || (existing.state !== "ACQUIRED" && existing.state !== "QUIESCED")) {
      throw new TenantLaunchGateConflictError(
        gate.runId,
        existing?.holderType ?? "UNKNOWN",
        existing?.holderId ?? "unknown",
        this.clock.nowIso(),
        `Cannot mark tenant launch gate as QUIESCED: invalid token, holderType, incompatible state ('${existing?.state ?? "MISSING"}'), or missing gate for run '${gate.runId}'.`
      );
    }
    this.gates.set(gate.runId, {
      ...existing,
      state: "QUIESCED",
    });
  }

  getGate(runId: string): TenantLaunchGate | undefined {
    return this.gates.get(runId);
  }
}
