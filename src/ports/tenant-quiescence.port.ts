/**
 * Tenant quiescence (ADR-0037).
 *
 * Recovery must not roll back, restore into or dispose of a run's workspace while a process started for that run's earlier
 * attempts might still be running. This port is how an execution provider proves (or fails to prove) that none remain.
 */

/** What kind of processes an execution provider can leave behind when its worker dies. */
export type TenantModel =
  /** Operations run inside the worker process: a dead worker leaves no tenant. */
  | "NONE"
  /** The provider starts processes/containers outside the worker that can outlive it. */
  | "ISOLATED_PROCESSES";

export type QuiescenceResult =
  /** Verified: no tenant process of this run remains. */
  | { readonly status: "QUIESCENT"; readonly stopped: number }
  /** Could not stop a tenant or could not verify absence. Callers MUST fail closed. */
  | { readonly status: "UNVERIFIED"; readonly reason: string };

export interface TenantQuiescencePort {
  /**
   * Stops every tenant process started for `runId` (any attempt) and returns only after verifying that none remain.
   * Idempotent. A thrown error is treated by callers exactly like UNVERIFIED.
   */
  quiesceRun(runId: string): Promise<QuiescenceResult>;
}

/**
 * A provider that does not declare its tenant model is assumed to leave isolated processes behind: unknown is never "none".
 */
export function resolveProviderTenantModel(provider: { readonly tenantModel?: TenantModel }): TenantModel {
  return provider.tenantModel ?? "ISOLATED_PROCESSES";
}
