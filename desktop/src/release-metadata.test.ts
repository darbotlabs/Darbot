import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const root = fileURLToPath(new URL("../../", import.meta.url));

function read(...parts: string[]): string {
  return readFileSync(join(root, ...parts), "utf8");
}

function version(...parts: string[]): string {
  const value: unknown = JSON.parse(read(...parts));
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    typeof value.version !== "string"
  ) {
    throw new Error(`${parts.join("\\")} has no valid version.`);
  }
  return value.version;
}

test("release checks call the real local reusable CI workflow", () => {
  const workflow = parseDocument(
    read(".github", "workflows", "publish-release.yml"),
  );
  const ci = parseDocument(read(".github", "workflows", "ci.yml"));
  expect(workflow.errors).toEqual([]);
  expect(ci.errors).toEqual([]);
  expect(workflow.getIn(["jobs", "checks", "uses"])).toBe(
    "./.github/workflows/ci.yml",
  );
  expect(existsSync(join(root, ".github", "workflows", "ci.yml"))).toBe(true);
  expect(ci.hasIn(["on", "workflow_call"])).toBe(true);
});

test("native release versions and chart metadata remain aligned", () => {
  const expected = version("package.json");
  expect(expected).toMatch(/^\d+\.\d+\.\d+$/);
  expect(version("desktop", "package.json")).toBe(expected);
  expect(version("desktop", "src-tauri", "tauri.conf.json")).toBe(expected);
  const cargo = read("desktop", "src-tauri", "Cargo.toml");
  expect(cargo.match(/^\[package\][\s\S]*?\r?\nversion = "([^"]+)"/)?.[1]).toBe(
    expected,
  );
  const lock = read("desktop", "src-tauri", "Cargo.lock");
  expect(
    lock.match(
      /\[\[package\]\]\r?\nname = "darbot-desktop"\r?\nversion = "([^"]+)"/,
    )?.[1],
  ).toBe(expected);
  const chart = parseDocument(read("charts", "darbot", "Chart.yaml"));
  expect(chart.errors).toEqual([]);
  expect(chart.get("appVersion")).toBe(expected);
});
