/**
 * Phase 91: Shared Resource Pool Domain Model
 *
 * Implements the shared multi-agent resource pool, hard resource ceilings,
 * pressure level calculation, and invariant verification.
 *
 * INVARIANTS:
 * 1. The shared pool has a hard ceiling.
 * 2. Sum of agent allocations may never exceed the pool capacity.
 * 3. allocated + available === totalCapacity component-wise.
 * 4. Resources cannot be created, double-returned, or double-spent.
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";
import {
  ResourceAllocation,
  ZERO_ALLOCATION,
  addAllocations,
  isWithinCeiling,
  subtractAllocations,
  validateResourceAllocation,
} from "./resource-allocation.js";

export type ResourcePressureLevel = "NORMAL" | "PRESSURE" | "STARVED" | "EXHAUSTED";

export interface SharedResourcePool {
  readonly poolId: string;
  readonly totalCapacity: ResourceAllocation;
  readonly allocated: ResourceAllocation;
  readonly available: ResourceAllocation;
  readonly hardCeiling: ResourceAllocation;
  readonly pressureLevel: ResourcePressureLevel;
  readonly poolDigest: string;
  readonly updatedAt: string;
}

/**
 * Computes the pressure level based on the minimum remaining capacity fraction
 * across key resource dimensions (wall time, tool calls, model calls).
 */
export function calculatePoolPressureLevel(
  total: ResourceAllocation,
  available: ResourceAllocation
): ResourcePressureLevel {
  const dimensions = [
    { total: total.wallTimeMs, avail: available.wallTimeMs },
    { total: total.toolCalls, avail: available.toolCalls },
    { total: total.modelCalls, avail: available.modelCalls },
    { total: total.contextBytes, avail: available.contextBytes },
  ];

  let minFraction = 1.0;
  for (const d of dimensions) {
    if (d.total > 0) {
      const frac = d.avail / d.total;
      if (frac < minFraction) {
        minFraction = frac;
      }
    }
  }

  if (minFraction <= 0.05) return "EXHAUSTED";
  if (minFraction <= 0.25) return "STARVED";
  if (minFraction <= 0.50) return "PRESSURE";
  return "NORMAL";
}

/**
 * Computes a deterministic SHA-256 digest of a shared resource pool.
 */
export function computePoolDigest(pool: {
  readonly poolId: string;
  readonly totalCapacity: ResourceAllocation;
  readonly allocated: ResourceAllocation;
  readonly available: ResourceAllocation;
  readonly hardCeiling: ResourceAllocation;
}): string {
  const canonical = canonicalJsonStringify({
    poolId: pool.poolId,
    totalCapacity: pool.totalCapacity,
    allocated: pool.allocated,
    available: pool.available,
    hardCeiling: pool.hardCeiling,
  });
  return sha256Hex(canonical);
}

/**
 * Factory for creating an initialized SharedResourcePool.
 */
export function createSharedResourcePool(params: {
  readonly poolId: string;
  readonly totalCapacity: ResourceAllocation;
  readonly hardCeiling?: ResourceAllocation;
}): SharedResourcePool {
  const capVal = validateResourceAllocation(params.totalCapacity);
  if (!capVal.valid) {
    throw new Error(`Invalid pool capacity: ${capVal.errors.join("; ")}`);
  }

  const hardCeiling = params.hardCeiling ?? params.totalCapacity;
  if (!isWithinCeiling(params.totalCapacity, hardCeiling)) {
    throw new Error("Pool totalCapacity exceeds hardCeiling");
  }

  const allocated = ZERO_ALLOCATION;
  const available = { ...params.totalCapacity };
  const pressureLevel = calculatePoolPressureLevel(params.totalCapacity, available);
  const poolDigest = computePoolDigest({
    poolId: params.poolId,
    totalCapacity: params.totalCapacity,
    allocated,
    available,
    hardCeiling,
  });

  return {
    poolId: params.poolId,
    totalCapacity: params.totalCapacity,
    allocated,
    available,
    hardCeiling,
    pressureLevel,
    poolDigest,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Allocates resources from the pool.
 * Fails closed if requested delta exceeds available capacity or hard ceiling.
 */
export function allocateFromPool(
  pool: SharedResourcePool,
  delta: Partial<ResourceAllocation>
): {
  readonly success: boolean;
  readonly pool?: SharedResourcePool;
  readonly error?: string;
} {
  const subRes = subtractAllocations(pool.available, delta);
  if (!subRes.success || !subRes.result) {
    return {
      success: false,
      error: `Insufficient available resources in pool: ${subRes.error}`,
    };
  }

  const newAllocated = addAllocations(pool.allocated, delta);
  if (!isWithinCeiling(newAllocated, pool.hardCeiling)) {
    return {
      success: false,
      error: "Requested allocation would breach pool hard ceiling",
    };
  }

  const newAvailable = subRes.result;
  const pressureLevel = calculatePoolPressureLevel(pool.totalCapacity, newAvailable);
  const poolDigest = computePoolDigest({
    poolId: pool.poolId,
    totalCapacity: pool.totalCapacity,
    allocated: newAllocated,
    available: newAvailable,
    hardCeiling: pool.hardCeiling,
  });

  return {
    success: true,
    pool: {
      ...pool,
      allocated: newAllocated,
      available: newAvailable,
      pressureLevel,
      poolDigest,
      updatedAt: new Date().toISOString(),
    },
  };
}

/**
 * Returns unused resources back to the pool.
 * Fails closed if returned delta exceeds allocated resources (no resource inflation).
 */
export function returnToPool(
  pool: SharedResourcePool,
  delta: Partial<ResourceAllocation>
): {
  readonly success: boolean;
  readonly pool?: SharedResourcePool;
  readonly error?: string;
} {
  const subAlloc = subtractAllocations(pool.allocated, delta);
  if (!subAlloc.success || !subAlloc.result) {
    return {
      success: false,
      error: `Return inflation detected: returned delta exceeds allocated pool resources: ${subAlloc.error}`,
    };
  }

  const newAvailable = addAllocations(pool.available, delta);
  if (!isWithinCeiling(newAvailable, pool.totalCapacity)) {
    return {
      success: false,
      error: "Return inflation detected: available resources would exceed total capacity",
    };
  }

  const newAllocated = subAlloc.result;
  const pressureLevel = calculatePoolPressureLevel(pool.totalCapacity, newAvailable);
  const poolDigest = computePoolDigest({
    poolId: pool.poolId,
    totalCapacity: pool.totalCapacity,
    allocated: newAllocated,
    available: newAvailable,
    hardCeiling: pool.hardCeiling,
  });

  return {
    success: true,
    pool: {
      ...pool,
      allocated: newAllocated,
      available: newAvailable,
      pressureLevel,
      poolDigest,
      updatedAt: new Date().toISOString(),
    },
  };
}
