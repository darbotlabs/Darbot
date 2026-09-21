import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  createSwarmIdentities,
  swarmRoot,
  verifySwarmAssets,
} from "./swarm-assets";

export const swarmRegistryPath = resolve(
  swarmRoot,
  "generated",
  "identities.ts",
);

export function swarmRegistrySource(): string {
  const data = JSON.stringify(createSwarmIdentities(), null, 2).replace(
    /[\u0080-\uFFFF]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return [
    "// Generated from the approved cohort manifests. Run bun run generate:swarm; do not edit.",
    'import type { DarbotAgentIdentity } from "../../../shared/swarm-types";',
    "",
    `export const swarmIdentities: readonly DarbotAgentIdentity[] = ${data};`,
    "",
  ].join("\n");
}

export function generateSwarmRegistry(check = false) {
  const result = verifySwarmAssets();
  const source = swarmRegistrySource();
  const current = existsSync(swarmRegistryPath)
    ? readFileSync(swarmRegistryPath, "utf8")
    : null;
  if (check && current !== source) {
    throw new Error("Swarm registry is stale; run bun run generate:swarm");
  }
  if (!check && current !== source) {
    mkdirSync(dirname(swarmRegistryPath), { recursive: true });
    writeFileSync(swarmRegistryPath, source, "utf8");
  }
  return result;
}

if (import.meta.main) {
  const result = generateSwarmRegistry(process.argv.includes("--check"));
  console.log(
    `Swarm: ${result.identityCount} identities, ${result.publicAssetCount} public images, ${result.checksumCount} source checksums verified`,
  );
}
