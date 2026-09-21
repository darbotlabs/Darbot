import type {
  CopilotHistory,
  CopilotHistorySession,
  CopilotWorkspaceChat,
} from "./copilot-types";

export const CHAT_PREVIEW_LIMIT = 5;

export function mergeHistoryBatch(
  current: CopilotHistory | null,
  batch: readonly CopilotHistorySession[],
): CopilotHistory {
  const sessions = new Map(
    (current?.sessions ?? []).map((session) => [session.sessionId, session]),
  );
  for (const session of batch) sessions.set(session.sessionId, session);
  const agents = new Map<string, CopilotHistory["agents"][number]>();
  for (const session of sessions.values()) {
    const agent = agents.get(session.agentId);
    if (agent) {
      agent.conversationCount += 1;
    } else {
      agents.set(session.agentId, {
        id: session.agentId,
        name: session.agentName,
        conversationCount: 1,
      });
    }
  }
  return {
    sessions: [...sessions.values()],
    agents: [...agents.values()].sort((left, right) => {
      if (!left.id) return right.id ? -1 : 0;
      if (!right.id) return 1;
      return left.name.localeCompare(right.name);
    }),
    warnings: current?.warnings ?? [],
  };
}

export function mergeLinkedConversations(
  current: readonly CopilotWorkspaceChat[],
  history: readonly CopilotHistorySession[],
  importedAgentIds: readonly string[],
  activeSessionId: string | null,
): CopilotWorkspaceChat[] {
  const allowed = new Set(["", ...importedAgentIds]);
  const chats = new Map(current.map((chat) => [chat.sessionId, chat]));
  for (const item of history) {
    if (item.agentId === "__unavailable__" || !allowed.has(item.agentId)) {
      continue;
    }
    const previous = chats.get(item.sessionId);
    if (previous && item.sessionId === activeSessionId) continue;
    chats.set(item.sessionId, {
      sessionId: item.sessionId,
      cwd: item.cwd,
      agentId: item.agentId,
      agentName: item.agentName,
      title: item.title?.trim() || previous?.title || "Untitled conversation",
      updatedAt: item.updatedAt ?? previous?.updatedAt ?? null,
    });
  }
  return [...chats.values()].sort((left, right) => {
    if (left.sessionId === right.sessionId) return 0;
    if (left.sessionId === activeSessionId) return -1;
    if (right.sessionId === activeSessionId) return 1;
    return (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
  });
}

export function groupWorkspaceChats(
  chats: readonly CopilotWorkspaceChat[],
): Map<string, CopilotWorkspaceChat[]> {
  const grouped = new Map<string, CopilotWorkspaceChat[]>();
  for (const chat of chats) {
    const group = grouped.get(chat.agentId);
    if (group) group.push(chat);
    else grouped.set(chat.agentId, [chat]);
  }
  return grouped;
}

export function previewAgentChats(
  chats: readonly CopilotWorkspaceChat[],
  activeSessionId: string | null,
): CopilotWorkspaceChat[] {
  const preview = chats.slice(0, CHAT_PREVIEW_LIMIT);
  const active = chats.find((chat) => chat.sessionId === activeSessionId);
  if (active && !preview.includes(active)) {
    return [active, ...preview.slice(0, CHAT_PREVIEW_LIMIT - 1)];
  }
  return preview;
}
