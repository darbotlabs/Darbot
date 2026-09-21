import { useState } from "react";
import {
  type AgentIconIdentity,
  identityImageSource,
  resolveAgentIcon,
} from "@/lib/agents/icons";
import { cn } from "@/lib/utils";
import { AbstractAvatar } from "./abstract-avatar";

export function AgentAvatar({
  agent,
  size = 40,
  kind = "auto",
  className,
}: {
  agent: AgentIconIdentity;
  size?: number;
  kind?: "auto" | "avatar" | "token";
  className?: string;
}) {
  const icon = resolveAgentIcon(agent);
  const source = icon ? identityImageSource(icon.identity, size, kind) : null;
  const [failedSource, setFailedSource] = useState<string | null>(null);

  if (!icon || !source || failedSource === source) {
    return (
      <AbstractAvatar name={agent.name} seed={agent.avatarSeed} size={size} />
    );
  }

  return (
    <img
      alt={agent.name}
      className={cn("shrink-0 rounded-md bg-black object-contain", className)}
      data-swarm-identity={icon.identity.identityCode}
      data-swarm-kind={
        kind === "auto" ? (size <= 48 ? "token" : "avatar") : kind
      }
      decoding="async"
      height={size}
      loading="lazy"
      onError={() => {
        console.error("[agents] could not load coworker icon", icon.label);
        setFailedSource(source);
      }}
      src={source}
      width={size}
    />
  );
}
