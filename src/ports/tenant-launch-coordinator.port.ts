/**
 * Tenant Launch & Recovery Coordination Port (ADR-0038).
 *
 * Establishes mutual exclusion between tenant process creation (worker)
 * and tenant quiescence verification / workspace disposal (recovery)
 * to close the late-start TOCTOU race.
 */

export interface TenantLaunchGate {
  readonly runId: string;
  readonly holderType: "WORKER" | "RECOVERY";
  readonly holderId: string;
  readonly leaseId: string;
  readonly token: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly releasedAt?: string;
  readonly state: "ACQUIRED" | "RELEASED";
  readonly ownerPid?: number;
}

export interface AcquireGateParams {
  readonly runId: string;
  readonly holderType: "WORKER" | "RECOVERY";
  readonly holderId: string;
  readonly leaseId: string;
  /** Lease TTL in ms. Default: 30_000 (30s). */
  readonly ttlMs?: number;
  /** Maximum wait time in ms before failing closed. Default: 5_000 (5s). */
  readonly timeoutMs?: number;
  /** Operating system process ID of the holder (for process liveness verification). */
  readonly ownerPid?: number;
}

export interface TenantLaunchCoordinatorPort {
  /**
   * Acquires the coordination gate for runId.
   * If held by another active holder, waits up to timeoutMs before throwing TenantLaunchGateTimeoutError.
   * If the gate has expired, it is reclaimed.
   */
  acquire(params: AcquireGateParams): Promise<TenantLaunchGate>;

  /**
   * Releases the coordination gate. Only the current token holder can release.
   */
  release(gate: TenantLaunchGate): Promise<void>;
}
