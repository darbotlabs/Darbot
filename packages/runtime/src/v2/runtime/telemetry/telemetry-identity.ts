export { firstNonBlankTelemetryId } from "@darbotlm/shared";

/** Return the first configured license token without forwarding blank values. */
export function firstNonBlankLicenseToken(
  ...candidates: ReadonlyArray<string | undefined>
): string | undefined {
  return candidates.find((candidate) => candidate?.trim());
}
