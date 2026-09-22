import { expect, test } from "bun:test";
import {
  createConversationDraft,
  emptyConversationWorkspace,
  MAX_DRAFT_LENGTH,
  migrateLegacyConversations,
  readConversationWorkspace,
  validateConversationWorkspace,
  WORKSPACE_STORAGE_KEY,
  writeConversationWorkspace,
} from "./copilot-workspace-store";

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

const legacyChat = {
  sessionId: "legacy-runtime",
  cwd: "C:\\workspace",
  agentId: "architect",
  agentName: "Architect",
  title: "Existing chat",
  updatedAt: null,
};

test("local draft identity and text survive round trip without a runtime session", () => {
  const draft = {
    ...createConversationDraft("C:\\workspace", "architect", "Architect"),
    draft: "Do not send yet",
  };
  const workspace = {
    ...emptyConversationWorkspace(),
    chats: [draft],
    activeConversationId: draft.conversationId,
  };
  const store = storage();
  writeConversationWorkspace(workspace, store);
  expect(readConversationWorkspace(store)).toEqual({ ok: true, workspace });
  expect(draft.sessionId).toBeNull();
});

test("legacy migration preserves agent ownership and leaves import none distinct from undecided", () => {
  for (const importedAgentIds of [null, [], ["architect"]]) {
    const old = { importedAgentIds, workspaceChats: [legacyChat] };
    const raw = JSON.stringify(old);
    const store = storage({ "darbot:copilot:preferences": raw });
    const result = readConversationWorkspace(store);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.problem.said);
    expect(result.workspace.chats[0]).toEqual({
      ...legacyChat,
      conversationId: "copilot:legacy-runtime",
      draft: "",
    });
    expect(result.workspace.activeConversationId).toBeNull();
    writeConversationWorkspace(result.workspace, store);
    expect(store.getItem("darbot:copilot:preferences")).toBe(raw);
  }
});

test("runtime association changes do not change a local conversation identity", () => {
  const draft = createConversationDraft("C:\\workspace", "", "Copilot CLI");
  const opened = { ...draft, sessionId: "real-cli-session" };
  const parsed = validateConversationWorkspace({
    ...emptyConversationWorkspace(),
    chats: [opened],
    activeConversationId: draft.conversationId,
  });
  expect(parsed.chats[0].conversationId).toBe(draft.conversationId);
  expect(parsed.chats[0].sessionId).toBe("real-cli-session");
});

test("invalid or future stored workspaces are reported, never silently replaced", () => {
  for (const raw of [
    "{",
    JSON.stringify({ ...emptyConversationWorkspace(), schemaVersion: 99 }),
  ]) {
    const store = storage({ [WORKSPACE_STORAGE_KEY]: raw });
    expect(readConversationWorkspace(store).ok).toBe(false);
    expect(store.getItem(WORKSPACE_STORAGE_KEY)).toBe(raw);
  }
});

test("missing active references and duplicate identities are rejected", () => {
  const draft = createConversationDraft("C:\\workspace", "", "Copilot CLI");
  expect(() =>
    validateConversationWorkspace({
      ...emptyConversationWorkspace(),
      chats: [draft],
      activeConversationId: "missing",
    }),
  ).toThrow("active conversation");
  expect(() =>
    validateConversationWorkspace({
      ...emptyConversationWorkspace(),
      chats: [draft, draft],
    }),
  ).toThrow("duplicate");
  expect(() =>
    validateConversationWorkspace({
      ...emptyConversationWorkspace(),
      chats: [
        { ...draft, sessionId: "same" },
        { ...draft, conversationId: "other", sessionId: "same" },
      ],
    }),
  ).toThrow("duplicate");
});

test("unknown and credential-bearing fields are rejected instead of persisted", () => {
  const draft = createConversationDraft("C:\\workspace", "", "Copilot CLI");
  for (const field of [
    "accessToken",
    "refreshToken",
    "clientSecret",
    "messages",
    "rawInput",
  ]) {
    expect(() =>
      validateConversationWorkspace({
        ...emptyConversationWorkspace(),
        chats: [{ ...draft, [field]: "not-a-real-secret" }],
      }),
    ).toThrow("unsupported fields");
  }
});

test("oversized drafts cannot overwrite existing stored data", () => {
  const store = storage({ [WORKSPACE_STORAGE_KEY]: "original" });
  const draft = {
    ...createConversationDraft("C:\\workspace", "", "Copilot CLI"),
    draft: "x".repeat(MAX_DRAFT_LENGTH + 1),
  };
  expect(() =>
    writeConversationWorkspace(
      { ...emptyConversationWorkspace(), chats: [draft] },
      store,
    ),
  ).toThrow();
  expect(store.getItem(WORKSPACE_STORAGE_KEY)).toBe("original");
});

test("malformed legacy data does not turn into an empty successful workspace", () => {
  expect(() =>
    migrateLegacyConversations({ workspaceChats: "invalid" }),
  ).toThrow();
  expect(() =>
    migrateLegacyConversations({ workspaceChats: [legacyChat, legacyChat] }),
  ).toThrow("duplicate");
  expect(
    readConversationWorkspace(
      storage({
        "darbot:copilot:preferences": JSON.stringify({
          workspaceChats: [{ sessionId: "incomplete" }],
        }),
      }),
    ).ok,
  ).toBe(false);
});

test("storage access failures are explicit", () => {
  const denied = {
    getItem: () => {
      throw new Error("Storage denied");
    },
    setItem: () => {
      throw new Error("Storage denied");
    },
  };
  expect(readConversationWorkspace(denied)).toEqual({
    ok: false,
    problem: {
      said: "Darbot could not open the saved Copilot workspace. Its original data has not been replaced.",
      detail: "Storage denied",
    },
  });
  expect(() =>
    writeConversationWorkspace(emptyConversationWorkspace(), denied),
  ).toThrow("Storage denied");
});
