import { describe, expect, test } from "bun:test";
import { desktopTelemetryProperties } from "./desktop-telemetry";

describe("desktop runtime metadata", () => {
  test("leaves ordinary server deployments untagged", () => {
    expect(desktopTelemetryProperties({})).toEqual({});
    expect(
      desktopTelemetryProperties({ darbot_DISTRIBUTION: "server" }),
    ).toEqual({});
  });

  test("carries only the shell's bounded metadata", () => {
    expect(
      desktopTelemetryProperties({
        darbot_DISTRIBUTION: "desktop",
        darbot_VERSION: "0.0.9",
        darbot_PLATFORM: "macos",
        darbot_ARCH: "aarch64",
        darbot_OS_VERSION: "15.6.1",
        darbot_ENGINE: "podman",
        OPENAI_API_KEY: "synthetic-secret",
        CPK_TELEMETRY_ID: "identity-belongs-in-the-transport",
        HOME: "/Users/private-name",
        darbot_BASE_URL: "https://private.example",
      }),
    ).toEqual({
      darbot_distribution: "desktop",
      darbot_version: "0.0.9",
      darbot_platform: "macos",
      darbot_arch: "aarch64",
      darbot_os_version: "15.6.1",
      darbot_engine: "podman",
    });
  });

  test.each([
    "/Users/private-name",
    "private.example",
    "1.2-private-name",
    "1.2\nsecret",
    "1.2\n",
    "1.2.3.4.5",
    "1".repeat(40),
  ])("rejects arbitrary text in every metadata field: %s", (value) => {
    expect(
      desktopTelemetryProperties({
        darbot_DISTRIBUTION: "desktop",
        darbot_VERSION: value,
        darbot_OS_VERSION: value,
        darbot_PLATFORM: value,
        darbot_ARCH: value,
        darbot_ENGINE: value,
      }),
    ).toEqual({ darbot_distribution: "desktop" });
  });
});
