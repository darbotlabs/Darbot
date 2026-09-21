import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import solid from "../assets/swarm/cohort-01-solid64/manifest/darbot_swarm_agent_perspectives.v2.json";
import mint from "../assets/swarm/cohort-02-mint-opal64/manifest/agent-perspectives.json";
import { frameworkIdentityIds } from "../shared/swarm-frameworks";
import type { DarbotAgentIdentity } from "../shared/swarm-types";

// Vite preserves import.meta.url when bundling its config, but not Bun's import.meta.dir.
export const swarmRoot = fileURLToPath(new URL("../assets/swarm", import.meta.url));
export const swarmUrlPrefix = "/assets/swarm/";
export const cohortDirectories = [
  "cohort-01-solid64",
  "cohort-02-mint-opal64",
] as const;

export function containedPath(root: string, relative: string): string {
  if (
    relative.includes("\\") ||
    relative.includes("\0") ||
    relative.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Invalid Swarm asset path: ${relative}`);
  }
  const path = resolve(root, ...relative.split("/"));
  if (!path.startsWith(`${resolve(root)}${sep}`)) {
    throw new Error(`Swarm asset escapes its source directory: ${relative}`);
  }
  return path;
}

function assetUrl(cohort: (typeof cohortDirectories)[number], path: string) {
  containedPath(resolve(swarmRoot, cohort), path);
  if (!/^(agents|tokens)\/[a-z0-9_]+\/[a-zA-Z0-9_-]+\.png$/.test(path)) {
    throw new Error(`Unsupported Swarm image path: ${path}`);
  }
  return `${swarmUrlPrefix}${cohort}/${path}`;
}

function materialKind(kind: string): DarbotAgentIdentity["material"]["kind"] {
  if (kind === "solid" || kind === "opal-splatter") return kind;
  throw new Error(`Unsupported Swarm material: ${kind}`);
}

export function createSwarmIdentities(): DarbotAgentIdentity[] {
  const solidIdentities: DarbotAgentIdentity[] = solid.agents.map(
    ({ agent, color, assets }) => {
      const url = (path: string) => assetUrl("cohort-01-solid64", path);
      return {
        agentId: agent.agent_id,
        identityCode: color.token_id,
        swarmIndex: agent.index,
        displayName: agent.persona,
        domain: agent.domain,
        role: agent.persona,
        perspective: agent.perspective,
        group: agent.group,
        cohort: "solid64",
        paletteToken: color.token_id,
        fallbackHex: color.hex,
        material: {
          kind: "solid",
          materialId: null,
          strength: 0,
          fallbackColorIsApproximation: false,
        },
        avatar: {
          png1024: url(assets.agent_png_1024_dark),
          png512: url(assets.agent_png_512_dark),
          transparent1024: url(assets.agent_png_1024_transparent),
        },
        token: {
          png1024: url(assets.token_png_1024_transparent),
          png512: url(assets.token_png_512_transparent),
          png256: url(assets.token_png_256_transparent),
        },
        bindingKind: "perspective",
      };
    },
  );
  const mintIdentities: DarbotAgentIdentity[] = mint.agents.map((agent) => {
    const url = (path: string) => assetUrl("cohort-02-mint-opal64", path);
    const { assets, visual } = agent;
    return {
      agentId: agent.agent_id,
      identityCode: agent.identity_code,
      swarmIndex: agent.swarm_index,
      displayName: agent.display_name,
      domain: agent.domain,
      role: agent.role,
      perspective: agent.perspective,
      group: agent.group,
      cohort: "mint-opal64",
      paletteToken: visual.palette_token,
      fallbackHex: visual.fallback_hex,
      material: {
        kind: materialKind(visual.material.kind),
        materialId: visual.material.material_id,
        strength: visual.material.strength,
        fallbackColorIsApproximation:
          visual.material.fallback_color_is_approximation,
      },
      avatar: {
        png1024: url(assets.agent_1024_black),
        png512: url(assets.agent_512_black),
        png256: url(assets.agent_256_transparent),
        transparent1024: url(assets.agent_1024_transparent),
        transparent512: url(assets.agent_512_transparent),
      },
      token: {
        png1024: url(assets.token_1024),
        png512: url(assets.token_512),
        png256: url(assets.token_256),
      },
      bindingKind: agent.requested
        ? agent.binding_kind === "framework"
          ? "framework"
          : "interaction"
        : "perspective",
      ...(agent.framework_reference
        ? { frameworkReference: agent.framework_reference }
        : {}),
    };
  });
  const identities = [...solidIdentities, ...mintIdentities];
  validateSwarmIdentities(identities);
  return identities;
}

export function validateSwarmIdentities(
  identities: readonly DarbotAgentIdentity[],
): void {
  if (
    identities.length !== 128 ||
    identities.filter((identity) => identity.cohort === "solid64").length !==
      64 ||
    identities.filter((identity) => identity.cohort === "mint-opal64")
      .length !== 64
  ) {
    throw new Error(
      "Swarm requires exactly 64 identities from each approved cohort",
    );
  }
  for (const key of [
    "agentId",
    "identityCode",
    "swarmIndex",
    "paletteToken",
  ] as const) {
    if (new Set(identities.map((identity) => identity[key])).size !== 128) {
      throw new Error(`Duplicate Swarm ${key}`);
    }
  }
  for (const [index, identity] of identities.entries()) {
    if (identity.swarmIndex !== index + 1) {
      throw new Error(`Unexpected Swarm index for ${identity.agentId}`);
    }
    if (!identity.agentId || !identity.displayName || !identity.perspective) {
      throw new Error(`Incomplete Swarm perspective at index ${index + 1}`);
    }
    if (!/^#[0-9A-F]{6}$/.test(identity.fallbackHex)) {
      throw new Error(`Invalid Swarm fallback color: ${identity.agentId}`);
    }
  }
  const boundIds = identities
    .filter((identity) => identity.bindingKind !== "perspective")
    .map((identity) => identity.agentId);
  if (JSON.stringify(boundIds) !== JSON.stringify(frameworkIdentityIds)) {
    throw new Error(
      "Swarm adapter bindings must preserve the 15 existing machine IDs",
    );
  }
}

export function collectSwarmAssets(
  identities: readonly DarbotAgentIdentity[] = createSwarmIdentities(),
): ReadonlyMap<string, string> {
  const assets = new Map<string, string>();
  for (const identity of identities) {
    for (const url of [
      ...Object.values(identity.avatar),
      ...Object.values(identity.token),
    ]) {
      if (!url) continue;
      if (!url.startsWith(swarmUrlPrefix)) {
        throw new Error(`Noncanonical Swarm asset URL: ${url}`);
      }
      assets.set(
        url,
        containedPath(swarmRoot, url.slice(swarmUrlPrefix.length)),
      );
    }
  }
  return assets;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const canonicalHashes = {
  "darbot_logo_approved_2048.png":
    "c888224ba1bd3a961794f34896cd31fcb325d892b768abd2b64e76c0f314cc44",
  "darbot_token_master_2048_transparent.png":
    "f177188e829b54313f6b502f6769aa9f6ab93bdf92a54ffd0b5e065d319858d2",
  "darbot_token_raster.svg":
    "962ecbe3aa1620558807b6ad5cc38e1139d5c1b0bdc1c0b1530dce04b72a13fd",
  "darbot_token_mask_safe_dark.png":
    "2107b7a73e015a53b39f18be690f8a84a5610e2876826a9d781580ebee6f6948",
  "opal_lightning_reference.png":
    "3488038fdadc33612fdef4cb8a43f27d9043c7a2c93f0227da1e120af9342dd9",
} as const;

export function verifySwarmAssets() {
  let checksumCount = 0;
  const checkedFiles = new Set<string>();
  for (const cohort of cohortDirectories) {
    const root = resolve(swarmRoot, cohort);
    const lines = readFileSync(resolve(root, "SHA256SUMS.txt"), "utf8")
      .trimEnd()
      .split(/\r?\n/);
    for (const line of lines) {
      const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line);
      if (!match) throw new Error(`Invalid checksum entry in ${cohort}`);
      const path = containedPath(root, match[2]);
      if (checkedFiles.has(path))
        throw new Error(`Duplicate checksum entry: ${path}`);
      if (sha256(path) !== match[1]) {
        throw new Error(`Approved Swarm asset checksum mismatch: ${path}`);
      }
      checkedFiles.add(path);
      checksumCount++;
    }
  }
  for (const [name, expected] of Object.entries(canonicalHashes)) {
    const path = resolve(swarmRoot, "canonical", name);
    if (sha256(path) !== expected) {
      throw new Error(`Canonical Darbot source checksum mismatch: ${name}`);
    }
  }
  const alphaHash = sha256(
    resolve(swarmRoot, "cohort-01-solid64", solid.source_lock.token_alpha_file),
  );
  if (
    alphaHash !==
    "85b34e4b08a648f642520d745a0834c0bd95ff807b4564d18f515501438fd133"
  ) {
    throw new Error("The approved token alpha master has changed");
  }
  for (const chest of [
    solid.source_lock.token_placement.bbox_xyxy,
    mint.source_lock.chest_bbox,
  ]) {
    if (JSON.stringify(chest) !== "[768,984,1280,1513]") {
      throw new Error("The approved Darbot chest placement has changed");
    }
  }
  const publicAssets = collectSwarmAssets();
  for (const path of publicAssets.values()) {
    if (!checkedFiles.has(path)) {
      throw new Error(`Unverified or unavailable Swarm export: ${path}`);
    }
  }
  return {
    checksumCount,
    publicAssetCount: publicAssets.size,
    identityCount: 128,
  };
}
