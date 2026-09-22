import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");

function packageManifest(path: string) {
  return JSON.parse(
    readFileSync(join(repositoryRoot, path, "package.json"), "utf8"),
  ) as {
    name: string;
  };
}

function rootManifest() {
  return JSON.parse(
    readFileSync(join(repositoryRoot, "package.json"), "utf8"),
  ) as { workspaces: string[]; scripts: Record<string, string> };
}

function packagesStartedBy(script: string, workspaces: string[]): string[] {
  const filters = [
    ...script.matchAll(/--filter\s+(?:'([^']*)'|"([^"]*)"|(\S+))/g),
  ].map((match) => match[1] ?? match[2] ?? match[3]);
  return workspaces.filter((workspace) =>
    filters.some((filter) => filter === "*" || filter === workspace),
  );
}

describe("darbot workspace", () => {
  test("defines the deployable packages and local SDK workspaces", () => {
    const manifest = rootManifest();

    expect(manifest.workspaces).toEqual([
      "app",
      "server",
      "worker",
      "packages/*",
    ]);

    for (const packageName of ["app", "server", "worker"]) {
      expect(existsSync(join(repositoryRoot, packageName))).toBe(true);
      expect(packageManifest(packageName).name).toBe(packageName);
    }
    const sdkPackages = readdirSync(join(repositoryRoot, "packages"), {
      withFileTypes: true,
    }).filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(
          join(repositoryRoot, "packages", entry.name, "package.json"),
        ),
    );
    expect(sdkPackages.length).toBeGreaterThan(0);
    const names = sdkPackages.map(
      (entry) => packageManifest(join("packages", entry.name)).name,
    );
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("@darbotlm/runtime");
    expect(names).toContain("@darbotlm/react-core");
    expect(names).toContain("tsconfig");
  });

  test("dev starts the app and the server, and not the routines worker", () => {
    const manifest = rootManifest();

    expect(
      packagesStartedBy(manifest.scripts.dev, manifest.workspaces),
    ).toEqual(["app", "server"]);
  });

  test("build still covers every workspace, including the worker", () => {
    const manifest = rootManifest();

    expect(
      packagesStartedBy(manifest.scripts.build, manifest.workspaces),
    ).toEqual(manifest.workspaces);
  });

  test("scripts/start.sh is what starts the routines worker", () => {
    const startScript = readFileSync(
      join(repositoryRoot, "scripts", "start.sh"),
      "utf8",
    );

    expect(startScript).toContain("bun worker/src/index.ts");
    expect(startScript).toContain("WORKER_SHARED_SECRET=");
  });
});
