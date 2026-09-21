import {
  type AgentIdentitySubject,
  type DarbotAgentIdentity,
  type FrameworkIdentityId,
  frameworkBindings,
  resolveAgentIdentity,
  swarmIdentities,
} from "../../../../shared/swarm-identity";

export {
  frameworkIdentityIds,
  getSwarmIdentity,
  identityImageSource,
  resolveAgentIdentity,
  swarmIdentities,
} from "../../../../shared/swarm-identity";
export type { DarbotAgentIdentity } from "../../../../shared/swarm-identity";

export type AgentIconId = FrameworkIdentityId;
export type AgentIconIdentity = AgentIdentitySubject;
type AgentIcon = {
  src: string;
  label: string;
  alias: string;
  identity: DarbotAgentIdentity;
};

const iconsByIdentity = new Map<DarbotAgentIdentity, AgentIcon>(
  swarmIdentities.map((identity) => [
    identity,
    {
      src: identity.avatar.png512,
      label:
        frameworkBindings.find(
          (binding) => binding.agentId === identity.agentId,
        )?.label ?? identity.displayName,
      alias: identity.displayName,
      identity,
    },
  ]),
);

/** Compatibility inventory for the original 15 adapters; resolution covers both full cohorts. */
export const agentIcons = Object.fromEntries(
  [...iconsByIdentity.entries()]
    .filter(([identity]) => identity.bindingKind !== "perspective")
    .map(([identity, icon]) => [identity.agentId, icon]),
);

export function resolveAgentIcon(
  agent: AgentIconIdentity,
): AgentIcon | undefined {
  const identity = resolveAgentIdentity(agent);
  return identity ? iconsByIdentity.get(identity) : undefined;
}
