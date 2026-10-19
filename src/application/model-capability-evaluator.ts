/**
 * Phase 55 — Governed Model Capability Evaluator & Substitution Controller
 *
 * Implements open-weight model capability evaluation, feasibility gating,
 * and capability attribution:
 * 1. Model inventory and hardware feasibility gate (RAM & Latency constraints)
 * 2. Capability gate battery (G1–G6)
 * 3. Authority firewalls & governance invariants (Negative controls N1–N8)
 * 4. Attribution decomposition (model_only_gain, diagnostic_gain, patch_synthesis_gain, orchestration_gain)
 * 5. Strict preservation of frozen clean-room verifier and ₹0 local host constraints
 *
 * Invariants:
 * - Model output is NEVER authoritative.
 * - Model cannot modify verification, contracts, authority, or evidence.
 * - Hardware constraints (7.63 GiB RAM, 120s step ceiling) are strictly fail-closed.
 */

import { canonicalJsonStringify, sha256Hex } from "../domain/canonical-hash.js";

// ============================================================================
// 1. Types & Interfaces
// ============================================================================

export interface ModelFeasibilityRecord {
  readonly modelName: string;
  readonly modelDigest: string;
  readonly parameterCount: number;
  readonly quantization: string;
  readonly architecture: string;
  readonly license: string;
  readonly contextLength: number;
  readonly diskSizeBytes: number;
  readonly memoryFootprintBytes: number;
  readonly measuredProbeLatencyMs: number;
  readonly expectedStepLatencyMs: number;
  readonly feasibilityStatus: "FEASIBLE" | "MODEL_ENVIRONMENTALLY_INFEASIBLE";
  readonly feasibilityFailureReason?: string;
}

export interface CapabilityGateResult {
  readonly gateId: string;
  readonly name: string;
  readonly targetCapability: string;
  readonly testPrompt: string;
  readonly passed: boolean;
  readonly latencyMs: number;
  readonly tokensProduced: number;
  readonly notes?: string;
}

export interface CapabilityAttribution {
  readonly modelOnlyGain: number;
  readonly diagnosticGain: number;
  readonly patchSynthesisGain: number;
  readonly orchestrationGain: number;
  readonly totalDelta: number;
}

export const HOST_CONSTRAINTS = {
  TOTAL_RAM_BYTES: 8192663552, // ~7.63 GiB
  MAX_SAFE_MODEL_RAM_BYTES: 3758096384, // 3.5 GiB max allocation for model weights
  STEP_TIMEOUT_CEILING_MS: 120000, // 120,000 ms
} as const;

// ============================================================================
// 2. Evaluator Implementation
// ============================================================================

export class ModelCapabilityEvaluator {
  /**
   * Evaluates hardware feasibility of a candidate model against host RAM and latency gates.
   */
  public static evaluateFeasibility(record: {
    modelName: string;
    modelDigest: string;
    parameterCount: number;
    quantization: string;
    architecture: string;
    license: string;
    contextLength: number;
    diskSizeBytes: number;
    memoryFootprintBytes: number;
    measuredProbeLatencyMs: number;
    expectedStepLatencyMs: number;
  }): ModelFeasibilityRecord {
    // RAM Gate
    if (record.memoryFootprintBytes > HOST_CONSTRAINTS.MAX_SAFE_MODEL_RAM_BYTES) {
      return {
        ...record,
        feasibilityStatus: "MODEL_ENVIRONMENTALLY_INFEASIBLE",
        feasibilityFailureReason: `Model memory footprint (${(record.memoryFootprintBytes / 1e9).toFixed(2)} GB) exceeds safe host threshold (${(HOST_CONSTRAINTS.MAX_SAFE_MODEL_RAM_BYTES / 1e9).toFixed(2)} GB) on 7.63 GiB RAM host.`,
      };
    }

    // Latency Gate
    if (record.expectedStepLatencyMs > HOST_CONSTRAINTS.STEP_TIMEOUT_CEILING_MS) {
      return {
        ...record,
        feasibilityStatus: "MODEL_ENVIRONMENTALLY_INFEASIBLE",
        feasibilityFailureReason: `Expected step latency (${record.expectedStepLatencyMs} ms) exceeds 120,000 ms step ceiling.`,
      };
    }

    return {
      ...record,
      feasibilityStatus: "FEASIBLE",
    };
  }

  /**
   * Computes canonical hash of model identity record.
   */
  public static computeModelIdentityHash(record: ModelFeasibilityRecord): string {
    const canonicalPayload = {
      modelName: record.modelName,
      modelDigest: record.modelDigest,
      parameterCount: record.parameterCount,
      quantization: record.quantization,
      architecture: record.architecture,
      license: record.license,
      contextLength: record.contextLength,
    };
    return sha256Hex(canonicalJsonStringify(canonicalPayload));
  }

  /**
   * Computes capability attribution decomposition across experimental conditions.
   */
  public static computeAttribution(metrics: {
    condASuccessRate: number; // Baseline Control
    condBSuccessRate: number; // Stronger Model only
    condCSuccessRate: number; // Stronger Model + Diagnostic
    condDSuccessRate: number; // Stronger Model + Patch Synthesis Stack
  }): CapabilityAttribution {
    const modelOnlyGain = Math.max(0, metrics.condBSuccessRate - metrics.condASuccessRate);
    const diagnosticGain = Math.max(0, metrics.condCSuccessRate - metrics.condBSuccessRate);
    const patchSynthesisGain = Math.max(0, metrics.condDSuccessRate - metrics.condCSuccessRate);
    const orchestrationGain = Math.max(0, metrics.condDSuccessRate - metrics.condBSuccessRate);
    const totalDelta = metrics.condDSuccessRate - metrics.condASuccessRate;

    return {
      modelOnlyGain,
      diagnosticGain,
      patchSynthesisGain,
      orchestrationGain,
      totalDelta,
    };
  }

  /**
   * Asserts governance and authority firewalls (N1, N2, N3, N8).
   */
  public static assertModelAuthority(params: {
    claimsTerminalSuccess: boolean;
    modifiesVerification: boolean;
    modifiesAuthority: boolean;
    targetsOutsideSlice: boolean;
    authorizedFiles: readonly string[];
    targetFile: string;
  }): void {
    if (params.modifiesVerification) {
      throw new Error("CAPABILITY_DENIED: Model cannot modify verification policy or parameters.");
    }
    if (params.modifiesAuthority) {
      throw new Error("CAPABILITY_DENIED: Model cannot alter terminal authority or signer keys.");
    }
    if (params.claimsTerminalSuccess) {
      throw new Error("UNVERIFIED_COMPLETION_CLAIM: Model cannot unilaterally declare terminal success.");
    }
    if (params.targetsOutsideSlice || !params.authorizedFiles.includes(params.targetFile)) {
      throw new Error("WORKSPACE_BOUNDARY_VIOLATION: Model attempted to modify file outside authorized slice.");
    }
  }

  /**
   * Detects gold benchmark solution leakage (N7).
   */
  public static detectGoldLeakage(codeContent: string): boolean {
    const forbidden = [
      "__SWE_BENCH_GOLD_PATCH__",
      "__GOLD_SOLUTION_INJECTED__",
      "__REFERENCE_ORACLE_OUTPUT__",
      "__AUTHORITATIVE_TEST_BYPASS__",
    ];
    return forbidden.some((m) => codeContent.includes(m));
  }
}
