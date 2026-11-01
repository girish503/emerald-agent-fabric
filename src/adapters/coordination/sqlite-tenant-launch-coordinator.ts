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

export interface SqliteTenantLaunchCoordinatorConfig {
  readonly pollIntervalMs?: number;
}

export class SqliteTenantLaunchCoordinator implements TenantLaunchCoordinatorPort {
  private readonly store: StateStorePort;
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

      if (existing && existing.state === "ACQUIRED") {
        const nowMs = new Date(nowIso).getTime();
        const expiresMs = new Date(existing.expiresAt).getTime();
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
    if (existing && existing.token === gate.token && existing.state === "ACQUIRED") {
      this.gates.set(gate.runId, {
        ...existing,
        state: "RELEASED",
        releasedAt: this.clock.nowIso(),
      });
    }
  }

  getGate(runId: string): TenantLaunchGate | undefined {
    return this.gates.get(runId);
  }
}
