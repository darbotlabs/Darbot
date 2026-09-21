import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { swarmIdentities } from "../shared/swarm-identity";
import { frameworkIdentityIds } from "../shared/swarm-frameworks";
import {
  swarmRegistryPath,
  swarmRegistrySource,
} from "./generate-swarm-registry";
import {
  collectSwarmAssets,
  containedPath,
  createSwarmIdentities,
  swarmRoot,
  validateSwarmIdentities,
  verifySwarmAssets,
} from "./swarm-assets";

describe("approved Swarm source integration", () => {
  test("all supplied checksums and canonical source hashes are intact", () => {
    expect(verifySwarmAssets()).toEqual({
      checksumCount: 1217,
      publicAssetCount: 896,
      identityCount: 128,
    });
  });

  test("the persistent registry is deterministic and contains both complete cohorts", () => {
    expect(readFileSync(swarmRegistryPath, "utf8")).toBe(swarmRegistrySource());
    expect(swarmIdentities).toEqual(createSwarmIdentities());
    expect(
      swarmIdentities.filter((identity) => identity.cohort === "solid64"),
    ).toHaveLength(64);
    expect(
      swarmIdentities.filter((identity) => identity.cohort === "mint-opal64"),
    ).toHaveLength(64);
    expect(swarmIdentities.map((identity) => identity.swarmIndex)).toEqual(
      Array.from({ length: 128 }, (_, index) => index + 1),
    );
  });

  test("all 896 public exports exist at their declared PNG size, with no compact-only missing masters", () => {
    for (const [url, path] of collectSwarmAssets()) {
      const png = readFileSync(path);
      const size = Number(/\/(?:png_)(\d+)/.exec(url)?.[1]);
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
      expect(url).not.toContain("2048");
      if (url.includes("transparent") || url.includes("/tokens/")) {
        expect(png[25]).toBe(6);
      }
    }
  });

  test("17 opal materials retain pattern identity and strength rather than becoming scalar colors", () => {
    const opal = swarmIdentities.filter(
      (identity) => identity.material.kind === "opal-splatter",
    );
    expect(opal).toHaveLength(17);
    for (const identity of opal) {
      expect(identity.material.materialId).toBe(
        "darbot.opal-lightning-splatter.v1",
      );
      expect(identity.material.strength).toBeGreaterThan(0);
      expect(identity.material.strength).toBeLessThanOrEqual(1);
      expect(identity.material.fallbackColorIsApproximation).toBe(true);
      expect(identity.avatar.png512.endsWith(".png")).toBe(true);
    }
  });

  test("only the 15 existing adapter directories are bound; 113 remain perspectives", () => {
    expect(
      swarmIdentities
        .filter((identity) => identity.bindingKind !== "perspective")
        .map((identity) => identity.agentId),
    ).toEqual(frameworkIdentityIds);
    expect(
      swarmIdentities.filter(
        (identity) => identity.bindingKind === "perspective",
      ),
    ).toHaveLength(113);
    for (const id of frameworkIdentityIds) {
      expect(statSync(resolve(import.meta.dir, "..", id)).isDirectory()).toBe(
        true,
      );
    }
  });

  test("duplicate or incomplete registry entries fail instead of silently winning a lookup", () => {
    const identities = createSwarmIdentities();
    expect(() => validateSwarmIdentities(identities.slice(1))).toThrow(
      "exactly 64",
    );
    expect(() =>
      validateSwarmIdentities(
        identities.map((identity, index) =>
          index === 1
            ? { ...identity, agentId: identities[0].agentId }
            : identity,
        ),
      ),
    ).toThrow("Duplicate Swarm agentId");
    expect(() =>
      validateSwarmIdentities(
        identities.map((identity, index) =>
          index === 0 ? { ...identity, perspective: "" } : identity,
        ),
      ),
    ).toThrow("Incomplete Swarm perspective");
  });

  test("the public map is limited to the canonical source tree", () => {
    for (const path of [
      "../secret",
      "tokens/../secret",
      "/absolute",
      "C:/secret",
      "tokens\\secret",
      "tokens/\0.png",
    ]) {
      expect(() => containedPath(swarmRoot, path)).toThrow();
    }
    const identity = createSwarmIdentities()[0];
    expect(() =>
      collectSwarmAssets([
        { ...identity, token: { ...identity.token, png256: "/api/private" } },
      ]),
    ).toThrow("Noncanonical Swarm asset URL");
  });
});
