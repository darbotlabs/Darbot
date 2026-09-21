import { expect, test } from "bun:test";
import {
  CHAT_PREVIEW_LIMIT,
  groupWorkspaceChats,
  mergeHistoryBatch,
  mergeLinkedConversations,
  previewAgentChats,
} from "./copilot-conversations";
import type {
  CopilotHistorySession,
  CopilotWorkspaceChat,
} from "./copilot-types";

function chat(
  sessionId: string,
  agentId = "architect",
  updatedAt = "2026-09-21T00:00:00Z",
): CopilotWorkspaceChat {
  return {
    sessionId,
    agentId,
    agentName: agentId || "Copilot CLI",
    cwd: "C:\\workspace",
    title: `Conversation ${sessionId}`,
    updatedAt,
  };
}

test("linking includes only requested agents and the built-in CLI", () => {
  const history = [
    chat("one"),
    chat("two", "designer"),
    chat("three", ""),
    chat("four", "__unavailable__"),
  ];
  const linked = mergeLinkedConversations([], history, ["architect"], null);
  expect(linked.map((item) => item.sessionId)).toEqual(["one", "three"]);
  expect(history).toHaveLength(4);
});

test("linking all agents preserves exact recorded ownership", () => {
  const ids = Array.from({ length: 100 }, (_, index) => `agent-${index}`);
  const history = ids.flatMap((id) => [
    chat(`${id}-a`, id),
    chat(`${id}-b`, id),
  ]);
  const linked = mergeLinkedConversations([], history, ids, null);
  const groups = groupWorkspaceChats(linked);
  expect(groups.size).toBe(100);
  for (const id of ids) {
    expect(groups.get(id)?.map((item) => item.sessionId)).toEqual([
      `${id}-a`,
      `${id}-b`,
    ]);
  }
});

test("relinking is idempotent and keeps existing and active chat references", () => {
  const existing = [
    chat("active"),
    chat("draft"),
    chat("other", "not-imported"),
  ];
  const history = [
    { ...chat("active", "different"), title: "Historical title" },
    chat("newer", "architect", "2026-09-22T00:00:00Z"),
    chat("older", "architect", "2026-09-20T00:00:00Z"),
  ];
  const linked = mergeLinkedConversations(
    existing,
    history,
    ["architect", "different"],
    "active",
  );
  expect(linked[0]).toEqual(existing[0]);
  expect(linked.find((item) => item.sessionId === "draft")).toEqual(
    existing[1],
  );
  expect(linked.find((item) => item.sessionId === "other")).toEqual(
    existing[2],
  );
  expect(
    mergeLinkedConversations(
      linked,
      history,
      ["architect", "different"],
      "active",
    ),
  ).toEqual(linked);
  expect(linked.map((item) => item.sessionId)).toEqual([
    "active",
    "newer",
    "draft",
    "other",
    "older",
  ]);
});

test("linked references contain metadata only and never copy extra runtime payloads", () => {
  const item = {
    ...chat("one"),
    messages: ["private transcript"],
    token: "not-a-real-token",
  };
  const linked = mergeLinkedConversations([], [item], ["architect"], null);
  expect(Object.keys(linked[0]).sort()).toEqual([
    "agentId",
    "agentName",
    "cwd",
    "sessionId",
    "title",
    "updatedAt",
  ]);
});

test("untitled history does not overwrite an existing useful title", () => {
  const existing = chat("one");
  const item: CopilotHistorySession = {
    ...existing,
    title: null,
    updatedAt: null,
  };
  expect(
    mergeLinkedConversations([existing], [item], ["architect"], null),
  ).toEqual([existing]);
  expect(
    mergeLinkedConversations([], [item], ["architect"], null)[0].title,
  ).toBe("Untitled conversation");
});

test("history batches deduplicate sessions and recount recorded agents", () => {
  const first = mergeHistoryBatch(null, [chat("one"), chat("two", "")]);
  const next = mergeHistoryBatch(first, [
    chat("one", "designer"),
    chat("three", "designer"),
  ]);
  expect(next.sessions).toHaveLength(3);
  expect(next.agents).toEqual([
    { id: "", name: "Copilot CLI", conversationCount: 1 },
    { id: "designer", name: "designer", conversationCount: 2 },
  ]);
  expect(
    first.agents.find((agent) => agent.id === "architect")?.conversationCount,
  ).toBe(1);
});

test("large chat groups stay bounded while the active chat remains visible", () => {
  const chats = Array.from({ length: 3000 }, (_, index) =>
    chat(`chat-${index}`),
  );
  const preview = previewAgentChats(chats, "chat-2999");
  expect(preview).toHaveLength(CHAT_PREVIEW_LIMIT);
  expect(preview[0].sessionId).toBe("chat-2999");
  expect(new Set(preview.map((item) => item.sessionId)).size).toBe(
    CHAT_PREVIEW_LIMIT,
  );
  expect(chats).toHaveLength(3000);
  expect(previewAgentChats(chats, null)).toEqual(
    chats.slice(0, CHAT_PREVIEW_LIMIT),
  );
});
