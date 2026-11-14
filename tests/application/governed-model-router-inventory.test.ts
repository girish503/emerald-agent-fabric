/**
 * Governed model router — installed-inventory readiness against the real registry.
 *
 * Real: GovernedModelRouterService and the approved registry. Fixture: the provider inventory list
 * (no provider is contacted and no inference is run).
 */
import { describe, expect, it } from "vitest";
import { GovernedModelRouterService } from "../../src/application/governed-model-router.js";
import { APPROVED_OPEN_WEIGHT_MODELS } from "../../src/domain/model-routing.js";

const QWEN = "qwen2.5-coder:1.5b";
const QWEN_DIGEST = "d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668";

describe("governed model router: registered is not the same as installed", () => {
  it("reports only the installed, digest-verified model as routable", () => {
    const router = new GovernedModelRouterService();
    const readiness = router.applyInstalledInventory([
      { name: QWEN, digest: QWEN_DIGEST },
      // Installed locally but never given a verified registry digest: stays unroutable.
      { name: "qwen2.5-coder:7b", digest: "a".repeat(64) },
    ]);
    const byId = new Map(readiness.map((r) => [r.modelId, r]));

    expect(byId.get(QWEN)).toEqual({ modelId: QWEN, installed: true, digestMatches: true, routable: true });
    expect(byId.get("qwen2.5-coder:7b")).toEqual({
      modelId: "qwen2.5-coder:7b",
      installed: true,
      digestMatches: false,
      routable: false,
    });
    for (const profile of APPROVED_OPEN_WEIGHT_MODELS) {
      if (profile.modelId === QWEN) continue;
      expect(byId.get(profile.modelId)?.routable).toBe(false);
    }
  });

  it("accepts a digest with a sha256: prefix and rejects a mismatched digest", () => {
    const router = new GovernedModelRouterService();
    expect(
      router.applyInstalledInventory([{ name: QWEN, digest: `sha256:${QWEN_DIGEST}` }]).find((r) => r.modelId === QWEN)?.routable
    ).toBe(true);
    expect(
      router.applyInstalledInventory([{ name: QWEN, digest: "0".repeat(64) }]).find((r) => r.modelId === QWEN)
    ).toMatchObject({ installed: true, digestMatches: false, routable: false });
  });

  it("marks everything unroutable when nothing registered is installed", () => {
    const router = new GovernedModelRouterService();
    const readiness = router.applyInstalledInventory([{ name: "some-other-model:1b", digest: "a".repeat(64) }]);
    expect(readiness.every((r) => !r.routable)).toBe(true);
  });
});
