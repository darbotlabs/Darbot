import type {
  CopilotHistory,
  CopilotHistorySession,
  CopilotWorkspaceChat,
} from "./copilot-types";
import { conversationFromHistory } from "./copilot-workspace-store";

export const CHAT_PREVIEW_LIMIT = 5;

export function conversationHistoryRows(
  chats: readonly CopilotWorkspaceChat[],
  history: readonly CopilotHistorySession[],
): CopilotWorkspaceChat[] {
  const bySession = new Map(
    chats
      .filter((chat) => chat.sessionId !== null)
      .map((chat) => [chat.sessionId, chat]),
  );
  const recorded = new Set(history.map((chat) => chat.sessionId));
  return [
    ...chats.filter(
      (chat) => chat.sessionId === null || !recorded.has(chat.sessionId),
    ),
    ...history.map((chat) => {
      const previous = bySession.get(chat.sessionId);
      return {
        ...conversationFromHistory(chat),
        conversationId: previous?.conversationId ?? `copilot:${chat.sessionId}`,
        draft: previous?.draft ?? "",
      };
    }),
  ];
}

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
  activeConversationId: string | null,
): CopilotWorkspaceChat[] {
  const allowed = new Set(["", ...importedAgentIds]);
  const chats = new Map(current.map((chat) => [chat.conversationId, chat]));
  const bySession = new Map(
    current
      .filter((chat) => chat.sessionId !== null)
      .map((chat) => [chat.sessionId, chat]),
  );
  for (const item of history) {
    if (item.agentId === "__unavailable__" || !allowed.has(item.agentId)) {
      continue;
    }
    const previous = bySession.get(item.sessionId);
    if (previous?.conversationId === activeConversationId) continue;
    const conversationId =
      previous?.conversationId ?? `copilot:${item.sessionId}`;
    chats.set(conversationId, {
      ...conversationFromHistory(item),
      conversationId,
      draft: previous?.draft ?? "",
      title: item.title?.trim() || previous?.title || "Untitled conversation",
      updatedAt: item.updatedAt ?? previous?.updatedAt ?? null,
    });
  }
  return [...chats.values()].sort((left, right) => {
    if (left.conversationId === right.conversationId) return 0;
    if (left.conversationId === activeConversationId) return -1;
    if (right.conversationId === activeConversationId) return 1;
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
  activeConversationId: string | null,
): CopilotWorkspaceChat[] {
  const preview = chats.slice(0, CHAT_PREVIEW_LIMIT);
  const active = chats.find(
    (chat) => chat.conversationId === activeConversationId,
  );
  if (active && !preview.includes(active)) {
    return [active, ...preview.slice(0, CHAT_PREVIEW_LIMIT - 1)];
  }
  return preview;
}
