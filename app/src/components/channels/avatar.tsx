import { memo, useMemo } from "react";
import { AgentAvatar } from "@/components/agents/agent-avatar";
import type { AgentIconIdentity } from "@/lib/agents/icons";
import { cn } from "@/lib/utils";

/**
 * A participant's real profile when the roster carries it — a coworker's actual artwork, not just
 * its id turned into an abstract shape. Falls back to a stable generated avatar, seeded on the id
 * itself, for anyone the roster does not know: a stale list, a participant outside this deployment,
 * or a genuinely unrecognized id. `AgentAvatar` draws that fallback on its own once it fails to
 * resolve a profile, so the synthesized identity below only has to carry the id through.
 */
function identityFor(
  participantId: string,
  agentsById: Map<string, AgentIconIdentity>,
): AgentIconIdentity {
  return (
    agentsById.get(participantId) ?? {
      avatarSeed: participantId,
      endpoint: null,
      id: participantId,
      name: participantId,
    }
  );
}

/**
 * Memoized roster avatar. Row updates usually change preview/timestamp only, and
 * `use-channel-events` preserves participant id arrays for unchanged rows.
 *
 * `agents` is a roster already loaded by the caller (the agent list, a channel's own profiles) —
 * this never fetches on its own; passing nothing simply falls back to generated avatars for every
 * participant rather than issuing a request of its own.
 *
 * `size-full` opts the drawn artwork out of ancestor icon selectors such as
 * `[&_svg:not([class*='size-'])]:size-4`.
 *
 * `typing` overlays a working indicator at the bottom-right — three bouncing dots, so a channel
 * whose agent is mid-turn reads as busy from the roster without moving the row's layout.
 */
export const ChannelAvatar = memo(function ChannelAvatar({
  participantIds,
  agents,
  size = 32,
  typing = false,
}: {
  participantIds: string[];
  agents?: readonly AgentIconIdentity[];
  size?: number;
  typing?: boolean;
}) {
  const agentsById = useMemo(() => {
    const map = new Map<string, AgentIconIdentity>();
    for (const agent of agents ?? []) {
      map.set(agent.id, agent);
    }
    return map;
  }, [agents]);

  const channelSize = participantIds?.length;

  const avatar =
    channelSize === 1 ? (
      <AgentAvatar
        agent={identityFor(participantIds[0], agentsById)}
        className="size-full"
        size={size}
      />
    ) : (
      <div className="flex flex-row items-center size-full">
        {participantIds.slice(0, 3).map((c, i, shown) => (
          <div
            className="shrink-0 border-2 border-sidebar rounded-full flex items-center justify-center"
            key={c}
            style={{
              height: size / (shown.length / 2),
              width: size / (shown.length / 2),
              transform: `translateX(${i * -75}%)`,
            }}
          >
            <AgentAvatar
              agent={identityFor(c, agentsById)}
              className="size-full"
              size={size / (shown.length / 2)}
            />
          </div>
        ))}
      </div>
    );

  return (
    <div className="relative" style={{ height: size, width: size }}>
      {avatar}
      {typing ? <TypingBadge /> : null}
    </div>
  );
});

/**
 * Three bouncing dots in a small badge, ringed in the sidebar's own colour so it sits on the
 * avatar as a badge rather than floating over it. The staggered negative delays start each dot at
 * a different point in the same bounce, which is what makes the three read as one wave.
 */
function TypingBadge() {
  return (
    <div className="absolute -bottom-0.5 -right-0.5 flex items-center gap-0.5 rounded-full bg-sidebar p-0.5 ring-2 ring-sidebar">
      <span className="sr-only">Working…</span>
      <Dot className="[animation-delay:-0.3s]" />
      <Dot className="[animation-delay:-0.15s]" />
      <Dot />
    </div>
  );
}

function Dot({ className }: { className?: string }) {
  return (
    <span
      className={cn("size-1 rounded-full bg-primary animate-bounce", className)}
    />
  );
}
