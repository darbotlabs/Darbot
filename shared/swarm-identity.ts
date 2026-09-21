import { swarmIdentities } from "../assets/swarm/generated/identities";
import { frameworkBindings } from "./swarm-frameworks";
import type { AgentIdentitySubject, DarbotAgentIdentity } from "./swarm-types";

export { swarmIdentities };
export { frameworkBindings, frameworkIdentityIds } from "./swarm-frameworks";
export type { FrameworkIdentityId } from "./swarm-frameworks";
export type { AgentIdentitySubject, DarbotAgentIdentity } from "./swarm-types";

function normalizedKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

const identitiesByKey = new Map<string, DarbotAgentIdentity>();
for (const identity of swarmIdentities) {
  for (const key of [identity.agentId, identity.identityCode]) {
    const normalized = normalizedKey(key);
    const existing = identitiesByKey.get(normalized);
    if (existing && existing !== identity) {
      throw new Error(`Ambiguous Swarm identity key: ${key}`);
    }
    identitiesByKey.set(normalized, identity);
  }
}

/** Stable semantic or visual identity keys; never raw colors or partial names. */
export function getSwarmIdentity(key: string): DarbotAgentIdentity | undefined {
  return identitiesByKey.get(normalizedKey(key));
}

const frameworksByHost = new Map<string, DarbotAgentIdentity>();
const frameworksByName = new Map<string, DarbotAgentIdentity>();
for (const binding of frameworkBindings) {
  const identity = getSwarmIdentity(binding.agentId);
  if (!identity) {
    throw new Error(`Missing Swarm adapter identity: ${binding.agentId}`);
  }
  frameworksByHost.set(binding.agentId, identity);
  for (const name of [
    binding.label,
    identity.displayName,
    ...binding.aliases,
  ]) {
    const key = normalizedKey(name);
    const existing = frameworksByName.get(key);
    if (existing && existing !== identity) {
      throw new Error(`Ambiguous Swarm framework label: ${name}`);
    }
    frameworksByName.set(key, identity);
  }
}

/**
 * This resolves appearance, not a runtime. Explicit saved keys win; only the historical framework
 * aliases are inferred from display names, so an unrelated custom role keeps its own artwork.
 */
export function resolveAgentIdentity(
  agent: AgentIdentitySubject,
): DarbotAgentIdentity | undefined {
  for (const key of [agent.avatarSeed, agent.id]) {
    const identity = getSwarmIdentity(key);
    if (identity) return identity;
  }

  if (agent.endpoint && URL.canParse(agent.endpoint)) {
    const endpoint = new URL(agent.endpoint);
    if (endpoint.protocol === "http:" || endpoint.protocol === "https:") {
      const identity = frameworksByHost.get(
        endpoint.hostname.split(".")[0] ?? "",
      );
      if (identity) return identity;
    }
  }

  return (
    getSwarmIdentity(agent.name) ??
    frameworksByName.get(normalizedKey(agent.name))
  );
}

export function identityImageSource(
  identity: DarbotAgentIdentity,
  size = 40,
  kind: "auto" | "avatar" | "token" = "auto",
): string {
  const token = kind === "token" || (kind === "auto" && size <= 48);
  if (token) {
    return size > 256
      ? identity.token.png1024
      : size > 128
        ? identity.token.png512
        : identity.token.png256;
  }
  return size > 256 ? identity.avatar.png1024 : identity.avatar.png512;
}
