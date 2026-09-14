import { useState } from "react";
import { type AgentIconIdentity, resolveAgentIcon } from "@/lib/agents/icons";
import { AbstractAvatar } from "./abstract-avatar";

export function AgentAvatar({
  agent,
  size = 40,
}: {
  agent: AgentIconIdentity;
  size?: number;
}) {
  const icon = resolveAgentIcon(agent);
  const [failedSource, setFailedSource] = useState<string | null>(null);

  if (!icon || failedSource === icon.src) {
    return (
      <AbstractAvatar name={agent.name} seed={agent.avatarSeed} size={size} />
    );
  }

  return (
    <img
      alt={agent.name}
      className="shrink-0 rounded-full bg-black object-contain"
      decoding="async"
      height={size}
      loading="lazy"
      onError={() => {
        console.error("[agents] could not load coworker icon", icon.label);
        setFailedSource(icon.src);
      }}
      src={icon.src}
      width={size}
    />
  );
}
