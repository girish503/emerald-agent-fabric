import { ClockPort } from "../ports/clock.port.js";
import { LeaseRecord, StorageTransaction } from "../ports/state-store.port.js";
import { LeaseExpiredError, LeaseLostError } from "../domain/errors.js";

export interface AcquireLeaseParams {
  readonly runId: string;
  readonly workerId: string;
  readonly ttlMs: number;
  readonly nowIso?: string;
  readonly leaseId?: string;
}

export interface RenewLeaseParams {
  readonly leaseId: string;
  readonly runId: string;
  readonly ttlMs: number;
  readonly nowIso?: string;
}

/**
 * LeaseManager coordinates worker lease acquisitions, renewals, expiries, and releases.
 * Operates purely within an atomic StorageTransaction provided by the coordinator.
 */
export class LeaseManager {
  constructor(private readonly clock: ClockPort) {}

  /**
   * Acquires a new active lease for a run.
   */
  acquire(tx: StorageTransaction, params: AcquireLeaseParams): LeaseRecord {
    const nowIso = params.nowIso ?? this.clock.nowIso();
    const expiresAt = new Date(new Date(nowIso).getTime() + params.ttlMs).toISOString();
    const leaseId = params.leaseId ?? crypto.randomUUID();

    const lease: LeaseRecord = {
      leaseId,
      runId: params.runId,
      workerId: params.workerId,
      acquiredAt: nowIso,
      expiresAt,
      releasedAt: null,
      state: "ACTIVE",
    };

    tx.insertLease(lease);
    return lease;
  }

  /**
   * Renews / extends an active lease.
   */
  renew(tx: StorageTransaction, params: RenewLeaseParams): LeaseRecord {
    const nowIso = params.nowIso ?? this.clock.nowIso();
    const lease = tx.getLease(params.leaseId);
    if (!lease) {
      throw new Error(`Lease '${params.leaseId}' not found`);
    }

    if (lease.state !== "ACTIVE") {
      throw new Error(`Cannot renew lease '${params.leaseId}' in state '${lease.state}'`);
    }

    if (new Date(nowIso).getTime() >= new Date(lease.expiresAt).getTime()) {
      throw new LeaseExpiredError(params.leaseId, lease.expiresAt, nowIso);
    }

    const run = tx.getRun(params.runId);
    if (!run || run.leaseId !== params.leaseId || run.currentWorkerId !== lease.workerId) {
      throw new LeaseLostError(params.runId, params.leaseId, run?.leaseId ?? null);
    }

    const newExpiresAt = new Date(new Date(nowIso).getTime() + params.ttlMs).toISOString();
    tx.updateLeaseExpiresAt(params.leaseId, newExpiresAt);
    tx.updateRunLeaseExpiresAt(params.runId, newExpiresAt);

    return {
      ...lease,
      expiresAt: newExpiresAt,
    };
  }

  /**
   * Releases an active lease upon completion or failure.
   */
  release(tx: StorageTransaction, leaseId: string, nowIso?: string): void {
    const now = nowIso ?? this.clock.nowIso();
    tx.updateLeaseState(leaseId, "RELEASED", now);
  }

  /**
   * Marks a lease as expired during sweeper recovery.
   */
  expire(tx: StorageTransaction, leaseId: string, nowIso?: string): void {
    const now = nowIso ?? this.clock.nowIso();
    tx.updateLeaseState(leaseId, "EXPIRED", now);
  }

  /**
   * Evaluates if a given lease has expired against current time.
   */
  isExpired(lease: LeaseRecord, nowIso?: string): boolean {
    const now = nowIso ?? this.clock.nowIso();
    return new Date(now).getTime() >= new Date(lease.expiresAt).getTime();
  }
}
