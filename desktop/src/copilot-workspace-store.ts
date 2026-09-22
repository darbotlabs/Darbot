import type {
  CopilotHistorySession,
  CopilotWorkspaceChat,
} from "./copilot-types";
import type { Problem } from "./Problem";

export const WORKSPACE_SCHEMA_VERSION = 1;
export const WORKSPACE_STORAGE_KEY = "darbot:copilot:workspace";
export const MAX_DRAFT_LENGTH = 32_000;
const LEGACY_STORAGE_KEY = "darbot:copilot:preferences";
const MAX_WORKSPACE_LENGTH = 4_000_000;
const MAX_CONVERSATIONS = 20_000;

export type ConversationWorkspace = {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  activeConversationId: string | null;
  chats: CopilotWorkspaceChat[];
};

export type WorkspaceReadResult =
  | { ok: true; workspace: ConversationWorkspace }
  | { ok: false; problem: Problem };

type WorkspaceStorage = Pick<Storage, "getItem" | "setItem">;

export function emptyConversationWorkspace(): ConversationWorkspace {
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activeConversationId: null,
    chats: [],
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return Object.fromEntries(Object.entries(value));
}

function text(
  value: unknown,
  label: string,
  max: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!allowEmpty && !value.trim())
  ) {
    throw new Error(
      `${label} must be ${allowEmpty ? "at most" : "between 1 and"} ${max} characters.`,
    );
  }
  return value;
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(
      `${label} contains unsupported fields. Stored data was not changed.`,
    );
  }
}

function metadata(value: Record<string, unknown>) {
  const updatedAt = value.updatedAt;
  if (
    updatedAt !== undefined &&
    updatedAt !== null &&
    typeof updatedAt !== "string"
  ) {
    throw new Error("Conversation updatedAt must be a timestamp or null.");
  }
  if (
    typeof updatedAt === "string" &&
    (updatedAt.length > 64 || !Number.isFinite(Date.parse(updatedAt)))
  ) {
    throw new Error("Conversation updatedAt is not a valid timestamp.");
  }
  return {
    cwd: text(value.cwd, "Conversation working folder", 32_768),
    agentId: text(value.agentId, "Conversation agent", 1024, true),
    agentName: text(value.agentName, "Conversation agent name", 1024),
    title: text(value.title, "Conversation title", 32_000),
    updatedAt: updatedAt ?? null,
  };
}

export function conversationFromHistory(
  item: CopilotHistorySession,
): CopilotWorkspaceChat {
  return {
    conversationId: `copilot:${item.sessionId}`,
    sessionId: item.sessionId,
    cwd: item.cwd,
    agentId: item.agentId,
    agentName: item.agentName,
    title: item.title?.trim() || "Untitled conversation",
    updatedAt: item.updatedAt ?? null,
    draft: "",
  };
}

export function createConversationDraft(
  cwd: string,
  agentId: string,
  agentName: string,
): CopilotWorkspaceChat {
  return {
    conversationId: crypto.randomUUID(),
    sessionId: null,
    cwd,
    agentId,
    agentName,
    title: "New conversation",
    updatedAt: new Date().toISOString(),
    draft: "",
  };
}

export function validateConversationWorkspace(
  value: unknown,
): ConversationWorkspace {
  const data = object(value, "Saved Copilot workspace");
  onlyKeys(
    data,
    ["schemaVersion", "activeConversationId", "chats"],
    "Saved Copilot workspace",
  );
  if (data.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
    throw new Error(
      "Unsupported Copilot workspace version. Use the Darbot version that saved it.",
    );
  }
  if (!Array.isArray(data.chats) || data.chats.length > MAX_CONVERSATIONS) {
    throw new Error(
      `Saved Copilot workspace must contain at most ${MAX_CONVERSATIONS} conversations.`,
    );
  }
  const ids = new Set<string>();
  const sessions = new Set<string>();
  const chats = data.chats.map((value: unknown) => {
    const item = object(value, "Saved conversation");
    onlyKeys(
      item,
      [
        "conversationId",
        "sessionId",
        "cwd",
        "agentId",
        "agentName",
        "title",
        "updatedAt",
        "draft",
      ],
      "Saved conversation",
    );
    const conversationId = text(item.conversationId, "Conversation ID", 1024);
    const sessionId =
      item.sessionId === null
        ? null
        : text(item.sessionId, "Runtime session ID", 512);
    if (
      ids.has(conversationId) ||
      (sessionId !== null && sessions.has(sessionId))
    ) {
      throw new Error(
        "Saved Copilot workspace contains duplicate conversation or runtime session IDs.",
      );
    }
    ids.add(conversationId);
    if (sessionId !== null) sessions.add(sessionId);
    return {
      ...metadata(item),
      conversationId,
      sessionId,
      draft: text(item.draft, "Conversation draft", MAX_DRAFT_LENGTH, true),
    };
  });
  const activeConversationId =
    data.activeConversationId === null
      ? null
      : text(data.activeConversationId, "Active conversation ID", 1024);
  if (activeConversationId !== null && !ids.has(activeConversationId)) {
    throw new Error(
      "The active conversation is missing from the saved workspace.",
    );
  }
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activeConversationId,
    chats,
  };
}

export function migrateLegacyConversations(
  value: unknown,
): ConversationWorkspace {
  const preferences = object(value, "Legacy Copilot preferences");
  if (preferences.workspaceChats === undefined)
    return emptyConversationWorkspace();
  if (!Array.isArray(preferences.workspaceChats)) {
    throw new Error(
      "Legacy conversation references are invalid. The original preferences were not changed.",
    );
  }
  const chats = preferences.workspaceChats.map((value: unknown) => {
    const item = object(value, "Legacy conversation");
    onlyKeys(
      item,
      ["sessionId", "cwd", "agentId", "agentName", "title", "updatedAt"],
      "Legacy conversation",
    );
    return conversationFromHistory({
      ...metadata(item),
      sessionId: text(item.sessionId, "Legacy session ID", 512),
    });
  });
  return validateConversationWorkspace({
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activeConversationId: null,
    chats,
  });
}

function parseStoredWorkspace(raw: string): unknown {
  if (raw.length > MAX_WORKSPACE_LENGTH) {
    throw new Error(
      "Saved Copilot workspace exceeds the supported storage size. The original data was not changed.",
    );
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error("Saved Copilot workspace is not valid JSON.");
    throw error;
  }
}

export function readConversationWorkspace(
  storage?: WorkspaceStorage,
): WorkspaceReadResult {
  try {
    const source = storage ?? window.localStorage;
    const raw = source.getItem(WORKSPACE_STORAGE_KEY);
    if (raw !== null)
      return {
        ok: true,
        workspace: validateConversationWorkspace(parseStoredWorkspace(raw)),
      };
    const legacy = source.getItem(LEGACY_STORAGE_KEY);
    return {
      ok: true,
      workspace:
        legacy === null
          ? emptyConversationWorkspace()
          : migrateLegacyConversations(parseStoredWorkspace(legacy)),
    };
  } catch (error) {
    return {
      ok: false,
      problem: {
        said: "Darbot could not open the saved Copilot workspace. Its original data has not been replaced.",
        detail:
          error instanceof Error
            ? error.message
            : "Workspace storage is unavailable.",
      },
    };
  }
}

export function writeConversationWorkspace(
  workspace: ConversationWorkspace,
  storage?: WorkspaceStorage,
): void {
  const serialized = JSON.stringify(validateConversationWorkspace(workspace));
  if (serialized.length > MAX_WORKSPACE_LENGTH) {
    throw new Error(
      "The Copilot workspace exceeds the supported storage size. Existing saved data was kept.",
    );
  }
  (storage ?? window.localStorage).setItem(WORKSPACE_STORAGE_KEY, serialized);
}
