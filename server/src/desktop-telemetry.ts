/** Only the desktop shell's closed metadata may join the runtime's existing events. */
export function desktopTelemetryProperties(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (env.darbot_DISTRIBUTION !== "desktop") return {};

  const properties: Record<string, string> = {
    darbot_distribution: "desktop",
  };
  for (const [input, output, allowed] of [
    [
      "darbot_PLATFORM",
      "darbot_platform",
      ["macos", "windows", "linux", "other"],
    ],
    ["darbot_ARCH", "darbot_arch", ["aarch64", "x86_64", "other"]],
    ["darbot_ENGINE", "darbot_engine", ["docker", "podman", "none"]],
  ] as const) {
    const value = env[input];
    if (value && allowed.some((item) => item === value))
      properties[output] = value;
  }
  for (const [input, output] of [
    ["darbot_VERSION", "darbot_version"],
    ["darbot_OS_VERSION", "darbot_os_version"],
  ] as const) {
    const value = env[input];
    if (
      value &&
      value.length <= 32 &&
      value.trim() === value &&
      /^\d+(?:\.\d+){1,3}$/.test(value)
    ) {
      properties[output] = value;
    }
  }
  return properties;
}
