import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(root, "packages");

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

function manifest(path: string) {
  return object(JSON.parse(readFileSync(path, "utf8")));
}

const workspaces = readdirSync(packagesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({
    directory: join(packagesRoot, entry.name),
    manifest: manifest(join(packagesRoot, entry.name, "package.json")),
  }));

const required = [
  ["react-core", "src/v2/index.ts"],
  ["runtime", "src/v2/index.ts"],
  ["a2ui-renderer", "src/index.ts"],
  ["aimock", "src/index.ts"],
] as const;

describe("local SDK workspace contracts", () => {
  test("the four SDK implementations are private workspaces with real source and licenses", () => {
    expect(manifest(join(root, "package.json")).workspaces).toContain(
      "packages/*",
    );
    for (const [name, entry] of required) {
      const directory = join(packagesRoot, name);
      const pkg = manifest(join(directory, "package.json"));
      expect(pkg.name).toBe(`@darbotlm/${name}`);
      expect(pkg.private).toBe(true);
      expect(pkg.license).toBe("MIT");
      expect(existsSync(join(directory, entry))).toBe(true);
      expect(readFileSync(join(directory, "LICENSE"), "utf8")).toContain(
        "Permission is hereby granted",
      );
    }
  });

  test("app, server, and test dependencies resolve only through workspace references", () => {
    for (const [file, field, names] of [
      ["package.json", "devDependencies", ["@darbotlm/aimock"]],
      [
        "app/package.json",
        "dependencies",
        ["@darbotlm/react-core", "@darbotlm/a2ui-renderer"],
      ],
      ["server/package.json", "dependencies", ["@darbotlm/runtime"]],
      ["server/package.json", "devDependencies", ["@darbotlm/aimock"]],
    ] as const) {
      const dependencies = object(manifest(join(root, file))[field]);
      for (const name of names) {
        expect(dependencies[name]).toBe("workspace:*");
      }
    }
  });

  test("every internal SDK dependency has a local implementation", () => {
    const names = new Set(
      workspaces.map((workspace) => workspace.manifest.name),
    );
    expect(names.size).toBe(workspaces.length);
    for (const workspace of workspaces) {
      expect(workspace.manifest.private).toBe(true);
      for (const field of [
        "dependencies",
        "optionalDependencies",
        "devDependencies",
        "peerDependencies",
      ]) {
        const dependencies = object(workspace.manifest[field] ?? {});
        for (const [name, version] of Object.entries(dependencies)) {
          if (name.startsWith("@darbotlm/") || names.has(name)) {
            expect(version).toBe("workspace:*");
            expect(names.has(name)).toBe(true);
          }
        }
      }
    }
  });

  test("the GraphQL client declares the local runtime schema producer as a build dependency", () => {
    const client = manifest(
      join(packagesRoot, "runtime-client-gql", "package.json"),
    );
    expect(object(client.devDependencies)["@darbotlm/runtime"]).toBe(
      "workspace:*",
    );
    expect(object(client.scripts).build).toBe(
      "bun run --cwd ../runtime generate-graphql-schema && bun run graphql-codegen && tsdown",
    );
  });

  test("the SDK and protocol share one RxJS implementation", () => {
    const protocolDirectory = dirname(
      Bun.resolveSync("@ag-ui/client", join(root, "server")),
    );
    const expected = realpathSync(Bun.resolveSync("rxjs", protocolDirectory));
    for (const name of [
      "core",
      "react-core",
      "runtime",
      "channels-slack",
      "channels-teams",
      "channels-intelligence",
    ]) {
      expect(
        realpathSync(Bun.resolveSync("rxjs", join(packagesRoot, name))),
      ).toBe(expected);
    }
  });

  test("the inspector generates its stylesheet before bundling it", () => {
    const inspector = manifest(
      join(packagesRoot, "web-inspector", "package.json"),
    );
    expect(object(inspector.scripts).build).toBe("bun run build:css && tsdown");
  });

  test("the app and React SDKs share one React implementation", () => {
    const expected = realpathSync(Bun.resolveSync("react", join(root, "app")));
    for (const name of ["react-core", "a2ui-renderer"]) {
      expect(
        realpathSync(Bun.resolveSync("react", join(packagesRoot, name))),
      ).toBe(expected);
    }
  });

  test("runtime dependency resolution loads JavaScript rather than declaration files", async () => {
    const entry = Bun.resolveSync(
      "@remix-run/node-fetch-server",
      join(packagesRoot, "runtime"),
    );
    expect(entry.endsWith(".d.ts")).toBe(false);
    const bridge = await import(entry);
    expect(typeof bridge.createRequest).toBe("function");
    expect(typeof bridge.sendResponse).toBe("function");
  });

  test("the container combines compiled SDK files with production dependency links", () => {
    const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("COPY packages packages");
    expect(dockerfile).toContain("COPY packages /prod/packages");
    expect(dockerfile).toContain(
      "COPY --from=deps /prod/server/node_modules server/node_modules",
    );
    expect(dockerfile).toContain(
      "tar -C packages --exclude=node_modules -cf /tmp/darbot-sdk.tar .",
    );
    const production = dockerfile.indexOf(
      "COPY --from=deps /prod/packages packages",
    );
    const compiled = dockerfile.indexOf(
      "COPY --from=app-build /built-sdk packages",
    );
    expect(production).toBeGreaterThan(-1);
    expect(compiled).toBeGreaterThan(production);
  });

  test.each([
    ["app", "@darbotlm/react-core/v2", "react-core"],
    ["app", "@darbotlm/react-core/v2/context", "react-core"],
    ["app", "@darbotlm/react-core/v2/styles.css", "react-core"],
    ["app", "@darbotlm/a2ui-renderer", "a2ui-renderer"],
    ["server", "@darbotlm/runtime/v2", "runtime"],
    ["server", "@darbotlm/runtime/v2/hono", "runtime"],
    ["server", "@darbotlm/aimock", "aimock"],
    ["server", "@darbotlm/aimock/agui", "aimock"],
    ["server", "@darbotlm/aimock/mcp", "aimock"],
  ])(
    "%s resolves %s from its local source package",
    (consumer, specifier, name) => {
      const entry = realpathSync(
        Bun.resolveSync(specifier, join(root, consumer)),
      );
      const within = relative(realpathSync(join(packagesRoot, name)), entry);
      expect(isAbsolute(within)).toBe(false);
      expect(within).not.toBe("..");
      expect(within.startsWith(`..${sep}`)).toBe(false);
      expect(existsSync(entry)).toBe(true);
    },
  );
});
