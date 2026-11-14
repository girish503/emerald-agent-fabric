/**
 * Composition helpers for the governed model router.
 *
 * A composition root (worker host, REST server) uses these to obtain a router whose availability reflects
 * the local provider's installed-model inventory. Reading the inventory is a metadata request only; it never
 * runs inference. If the inventory cannot be read the router is still returned, with no inventory applied,
 * so that nothing is routable (fail closed) and the caller can report why.
 */

import { GovernedModelRouterService, type ModelInventoryReadiness } from "./governed-model-router.js";

export type ModelInventory = readonly { readonly name: string; readonly digest: string }[];
export type ModelInventoryProvider = () => Promise<ModelInventory>;

/** Reads the installed-model inventory from a local Ollama runtime (GET /api/tags; no inference). */
export async function fetchOllamaModelInventory(baseUrl: string): Promise<ModelInventory> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) {
    throw new Error(`model inventory request returned HTTP ${response.status}`);
  }
  const body = (await response.json()) as { models?: unknown };
  if (!Array.isArray(body.models)) {
    throw new Error("model inventory response has no 'models' array");
  }
  const inventory: { name: string; digest: string }[] = [];
  for (const entry of body.models as Record<string, unknown>[]) {
    if (typeof entry?.name === "string" && typeof entry?.digest === "string") {
      inventory.push({ name: entry.name, digest: entry.digest });
    }
  }
  return inventory;
}

export interface InventoriedModelRouter {
  readonly router: GovernedModelRouterService;
  /** Per-model readiness; empty when the inventory could not be read. */
  readonly readiness: readonly ModelInventoryReadiness[];
  /** Set when the inventory could not be read or was malformed; the router then routes nothing. */
  readonly inventoryError: string | null;
}

/** Builds a router and applies the provider inventory to it. Never throws for an inventory failure. */
export async function createInventoriedModelRouter(inventoryProvider: ModelInventoryProvider): Promise<InventoriedModelRouter> {
  const router = new GovernedModelRouterService();
  try {
    const readiness = router.applyInstalledInventory(await inventoryProvider());
    return { router, readiness, inventoryError: null };
  } catch (err: unknown) {
    return { router, readiness: [], inventoryError: err instanceof Error ? err.message : String(err) };
  }
}
