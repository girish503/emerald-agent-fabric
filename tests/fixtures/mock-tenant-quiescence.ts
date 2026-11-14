import type { TenantQuiescencePort, QuiescenceResult } from "../../src/ports/tenant-quiescence.port.js";

/**
 * Default mock TenantQuiescencePort for test fixtures and test doubles.
 * Fulfills the M4.1 Tenant Quiescence requirement without external Docker or subprocess dependencies.
 */
export const defaultMockTenantQuiescencePort: TenantQuiescencePort = {
  async quiesceRun(_runId: string): Promise<QuiescenceResult> {
    return { status: "QUIESCENT", stopped: 0 };
  },
};
