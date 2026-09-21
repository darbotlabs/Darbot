import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "vite";
import { collectSwarmAssets } from "../../scripts/swarm-assets";

test("the production plugin emits every referenced PNG without changing its bytes", async () => {
  const entry = "\0swarm-build-contract";
  const built = await build({
    configFile: resolve(import.meta.dir, "..", "vite.config.ts"),
    root: resolve(import.meta.dir, ".."),
    logLevel: "silent",
    plugins: [
      {
        name: "swarm-build-contract-entry",
        resolveId: (id) => (id === entry ? entry : null),
        load: (id) => (id === entry ? "export const ready = true;" : null),
      },
    ],
    build: {
      write: false,
      emptyOutDir: false,
      reportCompressedSize: false,
      rollupOptions: { input: entry },
    },
  });
  if (Array.isArray(built) || !("output" in built)) {
    throw new Error("Expected one production asset bundle");
  }
  const images = built.output.filter(
    (file) =>
      file.type === "asset" && file.fileName.startsWith("assets/swarm/"),
  );
  const sources = collectSwarmAssets();
  expect(images).toHaveLength(sources.size);
  expect(images).toHaveLength(896);
  for (const file of images) {
    if (file.type !== "asset")
      throw new Error("Expected an unchanged image asset");
    const source = sources.get(`/${file.fileName}`);
    expect(source).toBeDefined();
    expect(Buffer.from(file.source)).toEqual(readFileSync(source!));
  }
}, 30_000);
