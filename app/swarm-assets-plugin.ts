import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Plugin } from "vite";
import { generateSwarmRegistry } from "../scripts/generate-swarm-registry";
import { collectSwarmAssets, swarmUrlPrefix } from "../scripts/swarm-assets";

/** One canonical source tree; development serves it and release builds emit unchanged PNG bytes. */
export function swarmAssets(): Plugin {
  const assets = collectSwarmAssets();
  return {
    name: "darbot-swarm-assets",
    buildStart() {
      generateSwarmRegistry();
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = (request.url ?? "").split("?")[0];
        if (!url.startsWith(swarmUrlPrefix)) return next();
        const path = assets.get(url);
        if (!path) {
          response.statusCode = 404;
          response.end("Swarm image not found");
          return;
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.statusCode = 405;
          response.setHeader("Allow", "GET, HEAD");
          response.end("Method not allowed");
          return;
        }
        void readFile(path)
          .then((bytes) => {
            response.setHeader("Content-Type", "image/png");
            response.setHeader("Content-Length", bytes.length);
            response.setHeader("Cache-Control", "no-cache");
            response.end(request.method === "HEAD" ? undefined : bytes);
          })
          .catch(next);
      });
    },
    generateBundle() {
      for (const [url, path] of assets) {
        this.emitFile({
          type: "asset",
          fileName: url.slice(1),
          source: readFileSync(path),
        });
      }
    },
  };
}
