import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  test: { include: ["src/**/*.test.ts", "src/**/*.test.tsx"] },
  esbuild: { jsx: "automatic", jsxImportSource: "@darbotlm/channels-ui" },
  resolve: {
    alias: {
      "@darbotlm/channels-ui/jsx-runtime": fileURLToPath(
        new URL("./src/jsx-runtime.ts", import.meta.url),
      ),
      "@darbotlm/channels-ui/jsx-dev-runtime": fileURLToPath(
        new URL("./src/jsx-dev-runtime.ts", import.meta.url),
      ),
    },
  },
});
