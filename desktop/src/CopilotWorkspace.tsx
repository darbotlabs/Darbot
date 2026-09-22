import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { CopilotAgentImport } from "./CopilotAgentImport";
import { CopilotExtensionsPanel } from "./CopilotExtensionsPanel";
import {
  conversationHistoryRows,
  groupWorkspaceChats,
  mergeHistoryBatch,
  mergeLinkedConversations,
  previewAgentChats,
} from "./copilot-conversations";
import {
  applyTheme,
  readAutoScrollPreference,
  readImportedAgentIds,
  readSnapScrollPreference,
  readStoredAgentId,
  readStoredCwd,
  readThemePreference,
  type ThemePreference,
  writeAutoScrollPreference,
  writeImportedAgentIds,
  writeSnapScrollPreference,
  writeStoredAgentId,
  writeStoredCwd,
  writeThemePreference,
} from "./copilot-preferences";
import {
  type ConfigOption,
  type ConfigOptionValue,
  type CopilotAgentSummary,
  type CopilotAvailableCommand,
  type CopilotHistory,
  type CopilotHistoryProgress,
  type CopilotHistorySession,
  type CopilotInventory,
  type CopilotPermissionRequest,
  type CopilotPromptResult,
  type CopilotSession,
  type CopilotSessionUpdate,
  type CopilotStatus,
  type CopilotToolActivity,
  type CopilotWorkspaceChat,
  type CopilotWorkspaceLocation,
  findConfigOption,
  isConfigValueDisabled,
  mergeToolActivity,
} from "./copilot-types";
import {
  type ConversationWorkspace,
  conversationFromHistory,
  createConversationDraft,
  emptyConversationWorkspace,
  MAX_DRAFT_LENGTH,
  readConversationWorkspace,
  writeConversationWorkspace,
} from "./copilot-workspace-store";
import copilotIconLicense from "./marks/copilot.LICENSE.txt?raw";
import { asProblem, Failure, InlineFailure, type Problem } from "./Problem";
import { BrandLockup } from "./Welcome";

type Message = {
  id: number;
  role: "user" | "assistant" | "activity";
  text: string;
  /** Dedup key for one-shot activity notices (e.g. "thinking") so repeats don't pile up. */
  activityKey?: string;
  raw?: unknown;
  toolActivity?: CopilotToolActivity;
};

type DialogKind =
  | "settings"
  | "profile"
  | "resources"
  | "conversations"
  | "import"
  | "create-agent"
  | null;

/** Config options the runtime negotiates but that Darbot deliberately never surfaces. */
const HIDDEN_CONFIG_IDS = new Set(["allow_all"]);

/** Autopilot exists in the protocol's mode vocabulary; Darbot only ever offers the other two. */
const SAFE_MODE_VALUES = new Set([
  "agent",
  "plan",
  "https://agentclientprotocol.com/protocol/session-modes#agent",
  "https://agentclientprotocol.com/protocol/session-modes#plan",
]);

/**
 * CLI commands that manage permission scope, directory trust, or authentication rather than doing
 * conversational work (the CLI's own "Permissions" help group, plus login/logout and autopilot).
 * One-click insertion is meant for skills and ordinary commands; these instead grant tool access,
 * change trust boundaries, or start an auth flow, so Darbot never lists them as suggestions even
 * though the runtime reports them in available_commands_update.
 */
const HIDDEN_COMMAND_NAMES = new Set([
  "permissions",
  "allow-all",
  "add-dir",
  "list-dirs",
  "cwd",
  "reset-allowed-tools",
  "autopilot",
  "login",
  "logout",
]);

const CONFIG_LABELS: Record<string, string> = {
  model: "Model",
  reasoning_effort: "Reasoning effort",
  mode: "Mode",
};

const CAPABILITY_LABELS: Record<string, string> = {
  loadSession: "Load session",
  resumeSession: "Resume session",
  listSessions: "List sessions",
  closeSession: "Close session",
  deleteSession: "Delete session",
  promptImage: "Image prompts",
  promptEmbeddedContext: "Embedded context",
  mcpHttp: "MCP over HTTP",
  mcpSse: "MCP over SSE",
};

const DEFAULT_AGENT_CHOICE: CopilotAgentSummary = {
  id: "",
  name: "Copilot CLI",
  description: "The default Copilot agent.",
};

function updateKind(update: Record<string, unknown>): string {
  return typeof update.sessionUpdate === "string"
    ? update.sessionUpdate
    : "activity";
}

function updateText(update: Record<string, unknown>): string | null {
  const content = update.content;
  if (
    content &&
    typeof content === "object" &&
    "text" in content &&
    typeof (content as Record<string, unknown>).text === "string"
  ) {
    return (content as Record<string, unknown>).text as string;
  }
  if (typeof update.message === "string") return update.message;
  if (typeof update.title === "string") return update.title;
  return null;
}

function describeStopReason(reason: string): string {
  switch (reason) {
    case "end_turn":
      return "Ready";
    case "cancelled":
      return "Cancelled";
    case "max_tokens":
      return "Stopped: reached the max token limit";
    case "refusal":
      return "Declined to continue";
    default:
      return reason ? `Stopped: ${reason}` : "Ready";
  }
}

function formatRawPayload(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function describePermissionTitle(toolCall: unknown): string {
  if (toolCall && typeof toolCall === "object" && "title" in toolCall) {
    const title = (toolCall as Record<string, unknown>).title;
    if (typeof title === "string" && title.length > 0) {
      return `Allow this action: ${title}`;
    }
  }
  return "Review the requested action before allowing it.";
}

function configOptionLabel(id: string): string {
  if (CONFIG_LABELS[id]) return CONFIG_LABELS[id];
  return id.length > 0
    ? id[0].toUpperCase() + id.slice(1).replace(/_/g, " ")
    : id;
}

/** Filters the runtime's own option list down to what Darbot is willing to show for this field. */
function visibleConfigOptionValues(option: ConfigOption): ConfigOptionValue[] {
  if (option.id !== "mode") return option.options;
  return option.options.filter((value) => SAFE_MODE_VALUES.has(value.value));
}

type InsertableResource = {
  key: string;
  name: string;
  description: string | null;
  enabled: boolean;
  group: "Command" | "Skill";
};

const WORKSPACE_SURFACES = [
  { id: "workspace", label: "Your workspace" },
  { id: "canvas", label: "Your canvas" },
  { id: "cli", label: "Your CLI" },
] as const;

type WorkspaceSurface = (typeof WORKSPACE_SURFACES)[number]["id"];

export function CopilotWorkspace({
  onBack,
  initialConversationAgentIds = [],
}: {
  onBack: () => void;
  initialConversationAgentIds?: readonly string[];
}) {
  const [surface, setSurface] = useState<WorkspaceSurface>("workspace");
  const [location, setLocation] = useState<CopilotWorkspaceLocation | null>(
    null,
  );
  const [locationInput, setLocationInput] = useState("");
  const [locationProblem, setLocationProblem] = useState<Problem | null>(null);
  const [resolvingLocation, setResolvingLocation] = useState(true);

  const [inventory, setInventory] = useState<CopilotInventory | null>(null);
  const [status, setStatus] = useState<CopilotStatus | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [availableCommands, setAvailableCommands] = useState<
    CopilotAvailableCommand[]
  >([]);
  const [importedAgentIds, setImportedAgentIds] = useState(
    () => readImportedAgentIds() ?? [],
  );
  const [createdAgents, setCreatedAgents] = useState<CopilotAgentSummary[]>([]);
  const [savedWorkspace] = useState(readConversationWorkspace);
  const [conversationWorkspace, setConversationWorkspace] =
    useState<ConversationWorkspace>(() =>
      savedWorkspace.ok
        ? savedWorkspace.workspace
        : emptyConversationWorkspace(),
    );
  const [workspaceProblem, setWorkspaceProblem] = useState<Problem | null>(
    null,
  );
  const { chats, activeConversationId } = conversationWorkspace;
  const activeConversation = chats.find(
    (chat) => chat.conversationId === activeConversationId,
  );
  const chatsByAgent = useMemo(() => groupWorkspaceChats(chats), [chats]);
  const [agentName, setAgentName] = useState("");
  const [agentDescription, setAgentDescription] = useState("");
  const [agentInstructions, setAgentInstructions] = useState("");
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [agentProblem, setAgentProblem] = useState<Problem | null>(null);

  const [selectedAgentId, setSelectedAgentId] = useState(
    () => activeConversation?.agentId ?? readStoredAgentId(),
  );
  const [session, setSession] = useState<CopilotSession | null>(null);
  const [sessionAgentId, setSessionAgentId] = useState("");
  const [configOptions, setConfigOptions] = useState<ConfigOption[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [prompt, setPrompt] = useState(activeConversation?.draft ?? "");
  const [busy, setBusy] = useState(false);
  const [openingSession, setOpeningSession] = useState(false);
  const [eventsReady, setEventsReady] = useState(false);
  const [statusText, setStatusText] = useState(
    activeConversation?.sessionId
      ? "Not opened"
      : activeConversation
        ? "Draft saved locally"
        : "Ready",
  );
  const [failure, setFailure] = useState<Problem | null>(null);

  const [permissions, setPermissions] = useState<CopilotPermissionRequest[]>(
    [],
  );
  const [respondingPermission, setRespondingPermission] = useState(false);

  const [theme, setThemeState] = useState<ThemePreference>(() =>
    readThemePreference(),
  );
  const [themeSyncWarning, setThemeSyncWarning] = useState<Problem | null>(
    null,
  );
  const [autoScrollEnabled, setAutoScrollEnabledState] = useState(() =>
    readAutoScrollPreference(),
  );
  const [snapScrollEnabled, setSnapScrollEnabled] = useState(
    readSnapScrollPreference,
  );
  const [stickToBottom, setStickToBottom] = useState(true);

  const [openDialog, setOpenDialog] = useState<DialogKind>(null);
  const [resourceFilter, setResourceFilter] = useState("");
  const [sessionsPage, setSessionsPage] = useState<CopilotHistory | null>(null);
  const [sessionsProblem, setSessionsProblem] = useState<Problem | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsAllFolders, setSessionsAllFolders] = useState(true);
  const [historyAgent, setHistoryAgent] = useState("__all__");
  const [historySearch, setHistorySearch] = useState("");
  const [visibleHistoryCount, setVisibleHistoryCount] = useState(50);
  const [historyProgress, setHistoryProgress] = useState("");
  const [linkingConversations, setLinkingConversations] = useState(false);
  const [linkStatus, setLinkStatus] = useState("");
  const historyRequestRef = useRef<string | null>(null);
  const historyLinkAgentIdsRef = useRef<readonly string[] | null>(null);
  const initialLinkStartedRef = useRef(false);

  /** The session whose events currently matter, set before invoking new/load so a load's replay
   * cannot arrive before the listener is ready to recognise it. */
  const sessionIdRef = useRef<string | null>(null);
  /** Set to a sessionId only for the span of that session's copilot_session_load call, during
   * which user_message_chunk carries historical turns with no local echo yet (unlike a live
   * turn's chunk, which mirrors an optimistic echo already on screen and stays suppressed). */
  const replayingSessionIdRef = useRef<string | null>(null);
  const creatingSessionRef = useRef(false);
  const initialUpdatesRef = useRef<CopilotSessionUpdate[]>([]);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const activeChatRef = useRef<HTMLButtonElement | null>(null);
  const nextMessageId = useRef(1);
  const toolCallMessageIds = useRef(new Map<string, number>());
  const conversationIdRef = useRef(activeConversationId);
  const operationRef = useRef(false);
  const mountedRef = useRef(true);
  const settingsDialogRef = useRef<HTMLDialogElement | null>(null);
  const profileDialogRef = useRef<HTMLDialogElement | null>(null);
  const resourcesDialogRef = useRef<HTMLDialogElement | null>(null);
  const conversationsDialogRef = useRef<HTMLDialogElement | null>(null);
  const importDialogRef = useRef<HTMLDialogElement | null>(null);
  const createAgentDialogRef = useRef<HTMLDialogElement | null>(null);
  const permissionDialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      historyRequestRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!savedWorkspace.ok) return;
    try {
      writeConversationWorkspace(conversationWorkspace);
      setWorkspaceProblem(null);
    } catch (error) {
      setWorkspaceProblem({
        said: "This conversation could not be saved on this device. Keep the window open and copy your draft before leaving.",
        detail: asProblem(error).said,
      });
    }
  }, [conversationWorkspace, savedWorkspace.ok]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Selection and newly linked rows change the active row's scroll position.
  useEffect(() => {
    activeChatRef.current?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [activeConversationId, chats.length]);

  const setChats = useCallback(
    (
      update:
        | CopilotWorkspaceChat[]
        | ((current: CopilotWorkspaceChat[]) => CopilotWorkspaceChat[]),
    ) => {
      setConversationWorkspace((current) => ({
        ...current,
        chats: typeof update === "function" ? update(current.chats) : update,
      }));
    },
    [],
  );

  function selectConversation(chat: CopilotWorkspaceChat | null) {
    conversationIdRef.current = chat?.conversationId ?? null;
    setConversationWorkspace((current) => ({
      ...current,
      activeConversationId: chat?.conversationId ?? null,
      chats: chat
        ? [
            chat,
            ...current.chats.filter(
              (item) => item.conversationId !== chat.conversationId,
            ),
          ]
        : current.chats,
    }));
    setPrompt(chat?.draft ?? "");
    if (chat) {
      setSelectedAgentId(chat.agentId);
      writeStoredAgentId(chat.agentId);
    }
  }

  function updateDraft(text: string) {
    if (text.length > MAX_DRAFT_LENGTH) {
      setFailure({
        said: `Drafts are limited to ${MAX_DRAFT_LENGTH.toLocaleString()} characters. Shorten the draft before adding more text.`,
      });
      return;
    }
    setPrompt(text);
    if (!savedWorkspace.ok || !location) return;
    if (!activeConversation) {
      const agent = inventory?.agents.find(
        (item) => item.id === selectedAgentId,
      );
      const draft = createConversationDraft(
        location.cwd,
        selectedAgentId,
        agent?.name ?? (selectedAgentId || "Copilot CLI"),
      );
      selectConversation({ ...draft, draft: text });
      return;
    }
    const id = activeConversation.conversationId;
    setChats((current) =>
      current.map((chat) =>
        chat.conversationId === id ? { ...chat, draft: text } : chat,
      ),
    );
  }

  function addImportedAgents(ids: string[]) {
    const next = [...new Set([...importedAgentIds, ...ids])];
    writeImportedAgentIds(next);
    setImportedAgentIds(next);
    if (ids.length > 0) {
      setSurface("canvas");
      void fetchHistory(true, next);
    }
  }

  function rememberChat(
    next: CopilotSession,
    requestedAgent: string,
    conversationId: string,
    title?: string | null,
  ) {
    const option = findConfigOption(next.configOptions, "agent");
    const agentId = option?.currentValue ?? requestedAgent;
    const agentName = !agentId
      ? "Copilot CLI"
      : (option?.options.find((value) => value.value === agentId)?.name ??
        inventory?.agents.find((agent) => agent.id === agentId)?.name ??
        agentId);
    setChats((current) => {
      const previous = current.find(
        (chat) => chat.conversationId === conversationId,
      );
      const chat: CopilotWorkspaceChat = {
        conversationId,
        sessionId: next.sessionId,
        cwd: next.cwd,
        agentId,
        agentName,
        title:
          title ||
          previous?.title ||
          `Chat ${current.filter((item) => item.agentId === agentId).length + 1}`,
        updatedAt: new Date().toISOString(),
        draft: previous?.draft ?? "",
      };
      return [
        chat,
        ...current.filter(
          (item) =>
            item.conversationId !== conversationId &&
            item.sessionId !== next.sessionId,
        ),
      ];
    });
  }

  async function selectWorkspaceAgent(agentId: string) {
    if (busy) return;
    const recent = chats.find((chat) => chat.agentId === agentId);
    if (recent) {
      await loadSession(recent);
    } else if (await closeSessionSafely()) {
      selectConversation(null);
      setSelectedAgentId(agentId);
      writeStoredAgentId(agentId);
    }
  }

  async function createAgent() {
    if (creatingAgent) return;
    setCreatingAgent(true);
    setAgentProblem(null);
    try {
      const agent = await invoke<CopilotAgentSummary>("copilot_agent_create", {
        name: agentName.trim(),
        description: agentDescription.trim(),
        instructions: agentInstructions.trim(),
      });
      if (!mountedRef.current) return;
      setCreatedAgents((current) => [...current, agent]);
      addImportedAgents([agent.id]);
      setSelectedAgentId(agent.id);
      writeStoredAgentId(agent.id);
      setAgentName("");
      setAgentDescription("");
      setAgentInstructions("");
      setOpenDialog(null);
      await startDraft(agent.id);
    } catch (error) {
      if (mountedRef.current) setAgentProblem(asProblem(error));
    } finally {
      if (mountedRef.current) setCreatingAgent(false);
    }
  }

  async function resolveLocation(
    candidate: string | null,
    silent?: boolean,
  ): Promise<CopilotWorkspaceLocation | null> {
    if (!silent) setResolvingLocation(true);
    setLocationProblem(null);
    try {
      const next = await invoke<CopilotWorkspaceLocation>("copilot_workspace", {
        cwd: candidate,
      });
      if (!mountedRef.current) return next;
      setLocation(next);
      setLocationInput(next.cwd);
      writeStoredCwd(next.cwd);
      return next;
    } catch (error) {
      if (!mountedRef.current) return null;
      setLocationProblem(asProblem(error));
      return null;
    } finally {
      if (mountedRef.current) setResolvingLocation(false);
    }
  }

  async function closeSessionSafely(): Promise<boolean> {
    const current = session;
    const currentAgent = sessionAgentId;
    if (current) {
      try {
        await invoke("copilot_session_close", {
          sessionId: current.sessionId,
          agent: currentAgent || null,
        });
      } catch (error) {
        setFailure(asProblem(error));
        return false;
      }
    }
    setSession(null);
    setSessionAgentId("");
    setConfigOptions([]);
    setMessages([]);
    setPermissions([]);
    setAvailableCommands([]);
    setPrompt("");
    sessionIdRef.current = null;
    toolCallMessageIds.current.clear();
    return true;
  }

  async function applyLocation() {
    const candidate = locationInput.trim();
    if (!candidate) {
      setLocationProblem({ said: "Choose an existing working folder." });
      return;
    }
    setBusy(true);
    setLocationProblem(null);
    try {
      const next = await invoke<CopilotWorkspaceLocation>("copilot_workspace", {
        cwd: candidate,
      });
      if (next.cwd !== location?.cwd && !(await closeSessionSafely())) return;
      if (!mountedRef.current) return;
      setLocation(next);
      if (next.cwd !== location?.cwd) selectConversation(null);
      setLocationInput(next.cwd);
      writeStoredCwd(next.cwd);
    } catch (error) {
      if (mountedRef.current) setLocationProblem(asProblem(error));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function browseLocation() {
    setLocationProblem(null);
    try {
      const picked = await invoke<CopilotWorkspaceLocation | null>(
        "copilot_pick_directory",
        {},
      );
      if (!picked || !mountedRef.current) return;
      const closed = await closeSessionSafely();
      if (!closed) return;
      selectConversation(null);
      setLocation(picked);
      setLocationInput(picked.cwd);
      writeStoredCwd(picked.cwd);
    } catch (error) {
      if (mountedRef.current) setLocationProblem(asProblem(error));
    }
  }

  async function resetLocationToHome() {
    const closed = await closeSessionSafely();
    if (!closed) return;
    selectConversation(null);
    await resolveLocation(null);
  }

  function appendActivityOnce(key: string, text: string) {
    setMessages((current) => {
      if (current.some((message) => message.activityKey === key))
        return current;
      return [
        ...current,
        {
          id: nextMessageId.current++,
          role: "activity",
          text,
          activityKey: key,
        },
      ];
    });
  }

  function appendOrMergeAssistantChunk(text: string) {
    setMessages((current) => {
      const last = current.at(-1);
      if (last && last.role === "assistant" && !last.raw) {
        const next = [...current];
        next[next.length - 1] = { ...last, text: `${last.text}${text}` };
        return next;
      }
      return [
        ...current,
        { id: nextMessageId.current++, role: "assistant", text },
      ];
    });
  }

  /** Mirrors appendOrMergeAssistantChunk for a replayed session's historical user turns: deltas
   * for the same turn coalesce into one bubble, and a new one starts once anything else (the
   * assistant's reply to that turn) lands in between. */
  function appendOrMergeUserChunk(text: string) {
    setMessages((current) => {
      const last = current.at(-1);
      if (last && last.role === "user" && !last.raw) {
        const next = [...current];
        next[next.length - 1] = { ...last, text: `${last.text}${text}` };
        return next;
      }
      return [...current, { id: nextMessageId.current++, role: "user", text }];
    });
  }

  function appendToolCallMessage(
    toolCallId: string,
    update: Partial<CopilotToolActivity>,
  ) {
    const id =
      toolCallMessageIds.current.get(toolCallId) ?? nextMessageId.current++;
    toolCallMessageIds.current.set(toolCallId, id);
    setMessages((current) => {
      const previous = current.find((message) => message.id === id);
      const activity = mergeToolActivity(previous?.toolActivity, update);
      const text = activity.status
        ? `${activity.title}: ${activity.status}`
        : activity.title;
      if (previous) {
        return current.map((message) =>
          message.id === id
            ? { ...message, text, raw: activity, toolActivity: activity }
            : message,
        );
      }
      return [
        ...current,
        { id, role: "activity", text, raw: activity, toolActivity: activity },
      ];
    });
  }

  function handleSessionUpdate(update: Record<string, unknown>) {
    switch (updateKind(update)) {
      case "agent_message_chunk": {
        const text = updateText(update);
        if (text) appendOrMergeAssistantChunk(text);
        break;
      }
      case "user_message_chunk": {
        // A live turn's echo is already shown optimistically the instant Send is pressed, so
        // only append here while replaying a loaded session, whose historical user turns have
        // no local echo yet.
        if (replayingSessionIdRef.current === sessionIdRef.current) {
          const text = updateText(update);
          if (text) appendOrMergeUserChunk(text);
        }
        break;
      }
      case "agent_thought_chunk":
        appendActivityOnce("thinking", "Thinking...");
        break;
      case "tool_call":
      case "tool_call_update": {
        const toolCallId = String(update.toolCallId ?? "");
        if (!toolCallId) break;
        appendToolCallMessage(toolCallId, {
          title: typeof update.title === "string" ? update.title : undefined,
          status: typeof update.status === "string" ? update.status : undefined,
          input: update.rawInput,
          output: update.content ?? update.rawOutput,
        });
        break;
      }
      case "available_commands_update": {
        const commands = update.availableCommands;
        if (Array.isArray(commands)) {
          setAvailableCommands(commands as CopilotAvailableCommand[]);
        }
        break;
      }
      case "config_option_update": {
        const options = update.configOptions;
        if (Array.isArray(options)) {
          applySessionConfig(options as ConfigOption[]);
        }
        break;
      }
      case "session_info_update": {
        const id = conversationIdRef.current;
        if (id && typeof update.title === "string" && update.title.trim()) {
          const title = update.title.trim();
          setChats((current) =>
            current.map((chat) =>
              chat.conversationId === id ? { ...chat, title } : chat,
            ),
          );
        }
        break;
      }
      case "plan":
        appendActivityOnce("plan", "Updated plan.");
        break;
      default:
        break;
    }
  }

  const onSessionUpdate = useEffectEvent(handleSessionUpdate);

  // Registered once on mount. Session-scoped events are filtered by sessionIdRef, which callers
  // update before invoking session-new/session-load so replayed history is never missed.
  useEffect(() => {
    let listening = true;
    const sessionUpdates = listen<CopilotSessionUpdate>(
      "copilot:session-update",
      (event) => {
        if (event.payload.sessionId !== sessionIdRef.current) {
          if (creatingSessionRef.current)
            initialUpdatesRef.current.push(event.payload);
          return;
        }
        onSessionUpdate(event.payload.update);
      },
    );
    const permissionRequests = listen<CopilotPermissionRequest>(
      "copilot:permission-request",
      (event) => {
        if (
          event.payload.sessionId !== sessionIdRef.current &&
          !creatingSessionRef.current &&
          event.payload.origin !== "background"
        )
          return;
        setPermissions((current) =>
          current.some(
            (request) => request.requestId === event.payload.requestId,
          )
            ? current
            : [...current, event.payload],
        );
      },
    );
    const permissionClosed = listen<{ requestId: string }>(
      "copilot:permission-closed",
      (event) => {
        setPermissions((current) =>
          current.filter(
            (request) => request.requestId !== event.payload.requestId,
          ),
        );
      },
    );
    const runtimeErrors = listen<Problem>("copilot:runtime-error", (event) => {
      setFailure(event.payload);
      sessionIdRef.current = null;
      setSession(null);
      setPermissions([]);
      setConfigOptions([]);
      setStatusText("Connection interrupted");
    });
    const historyUpdates = listen<CopilotHistoryProgress>(
      "copilot:history-progress",
      (event) => {
        if (
          !listening ||
          historyRequestRef.current === null ||
          event.payload.requestId !== historyRequestRef.current
        )
          return;
        setHistoryProgress(
          `${event.payload.phase === "indexing" ? "Linking agents" : "Reading conversations"}: ${event.payload.loaded.toLocaleString()}`,
        );
        const batch = event.payload.sessions;
        if (batch?.length) {
          setSessionsPage((current) => mergeHistoryBatch(current, batch));
          const agentIds = historyLinkAgentIdsRef.current;
          if (agentIds) {
            setChats((current) =>
              mergeLinkedConversations(
                current,
                batch,
                agentIds,
                conversationIdRef.current,
              ),
            );
          }
        }
      },
    );
    Promise.all([
      sessionUpdates,
      permissionRequests,
      permissionClosed,
      runtimeErrors,
      historyUpdates,
    ])
      .then(() => {
        if (listening) setEventsReady(true);
      })
      .catch((error) => {
        if (listening) setFailure(asProblem(error));
      });

    return () => {
      listening = false;
      for (const registration of [
        sessionUpdates,
        permissionRequests,
        permissionClosed,
        runtimeErrors,
        historyUpdates,
      ]) {
        registration
          .then((off) => off())
          .catch((error) => {
            console.warn(
              "Darbot could not release a Copilot event listener.",
              error,
            );
          });
      }
    };
  }, [setChats]);

  function sanitizeConfigOptions(options: ConfigOption[]): ConfigOption[] {
    return options.filter((option) => !HIDDEN_CONFIG_IDS.has(option.id));
  }

  function applySessionConfig(options: ConfigOption[]) {
    const visible = sanitizeConfigOptions(options);
    setConfigOptions(visible);
    const agent = findConfigOption(visible, "agent");
    if (agent) {
      setSessionAgentId(agent.currentValue);
      setSelectedAgentId(agent.currentValue);
      writeStoredAgentId(agent.currentValue);
    }
  }

  async function startDraft(agentId: string) {
    if (!location || operationRef.current || !savedWorkspace.ok) return;
    operationRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      if (!(await closeSessionSafely())) return;
      const agent =
        inventory?.agents.find((item) => item.id === agentId) ??
        createdAgents.find((item) => item.id === agentId);
      selectConversation(
        createConversationDraft(
          location.cwd,
          agentId,
          agent?.name ?? (agentId || "Copilot CLI"),
        ),
      );
      setSurface("workspace");
      setStatusText("Draft saved locally");
    } finally {
      operationRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }

  async function startSession(
    chat: CopilotWorkspaceChat,
  ): Promise<CopilotSession | null> {
    setSurface("workspace");
    setBusy(true);
    setFailure(null);
    try {
      const closed = await closeSessionSafely();
      if (!closed) return null;
      setPrompt(chat.draft);
      setOpeningSession(true);
      setStatusText("Opening conversation");
      creatingSessionRef.current = true;
      initialUpdatesRef.current = [];
      const next = await invoke<CopilotSession>("copilot_session_new", {
        cwd: chat.cwd,
        agent: chat.agentId || null,
      });
      if (!mountedRef.current) return next;
      sessionIdRef.current = next.sessionId;
      setSession(next);
      setSessionAgentId(chat.agentId);
      applySessionConfig(next.configOptions ?? []);
      for (const event of initialUpdatesRef.current) {
        if (event.sessionId === next.sessionId)
          handleSessionUpdate(event.update);
      }
      setStatusText("Ready");
      return next;
    } catch (error) {
      if (mountedRef.current) {
        setStatusText("Conversation not opened");
        setFailure(asProblem(error));
      }
      return null;
    } finally {
      creatingSessionRef.current = false;
      initialUpdatesRef.current = [];
      if (mountedRef.current) {
        setOpeningSession(false);
        setBusy(false);
      }
    }
  }

  async function loadSession(
    target: CopilotHistorySession | CopilotWorkspaceChat,
    sending = false,
  ): Promise<CopilotSession | null> {
    if (!savedWorkspace.ok || (operationRef.current && !sending)) return null;
    if (!sending) operationRef.current = true;
    const chat =
      "conversationId" in target
        ? target
        : (chats.find((item) => item.sessionId === target.sessionId) ??
          conversationFromHistory(target));
    setSurface("workspace");
    if (chat.sessionId !== null && chat.sessionId === session?.sessionId) {
      setOpenDialog(null);
      activeChatRef.current?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
      if (!sending) operationRef.current = false;
      return session;
    }
    setBusy(true);
    setFailure(null);
    try {
      const closed = await closeSessionSafely();
      if (!closed) return null;
      selectConversation(chat);
      if (chat.sessionId === null) {
        const nextLocation = await resolveLocation(chat.cwd, true);
        if (!nextLocation) return null;
        setOpenDialog(null);
        setStatusText("Draft saved locally");
        return null;
      }
      setOpeningSession(true);
      setStatusText("Opening conversation");
      // Set before invoking so a replay burst starting mid-load is never missed.
      sessionIdRef.current = chat.sessionId;
      // Cleared in `finally` below: replay for this sessionId only spans the invoke call.
      replayingSessionIdRef.current = chat.sessionId;
      const next = await invoke<CopilotSession>("copilot_session_load", {
        sessionId: chat.sessionId,
        cwd: chat.cwd,
        agent: chat.agentId === "__unavailable__" ? null : chat.agentId,
      });
      if (!mountedRef.current) return null;
      setSession(next);
      setSessionAgentId(chat.agentId);
      applySessionConfig(next.configOptions ?? []);
      rememberChat(next, chat.agentId, chat.conversationId, chat.title);
      setPrompt(chat.draft);
      if (location) setLocation({ ...location, cwd: next.cwd });
      setLocationInput(next.cwd);
      writeStoredCwd(next.cwd);
      setOpenDialog(null);
      setStatusText("Ready");
      return next;
    } catch (error) {
      if (mountedRef.current) {
        sessionIdRef.current = null;
        setMessages([]);
        setPermissions((current) =>
          current.filter((request) => request.origin === "background"),
        );
        setAvailableCommands([]);
        toolCallMessageIds.current.clear();
        setStatusText("Conversation not opened");
        setFailure(asProblem(error));
      }
      return null;
    } finally {
      if (!sending) operationRef.current = false;
      replayingSessionIdRef.current = null;
      if (mountedRef.current) {
        setOpeningSession(false);
        setBusy(false);
      }
    }
  }

  async function configureSession(configId: string, value: string) {
    if (!session) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await invoke<{ configOptions: ConfigOption[] }>(
        "copilot_session_configure",
        { sessionId: session.sessionId, configId, value },
      );
      if (!mountedRef.current) return;
      applySessionConfig(result.configOptions ?? []);
    } catch (error) {
      if (mountedRef.current) setFailure(asProblem(error));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  function insertTextAtCursor(text: string) {
    const textarea = promptRef.current;
    if (!textarea) {
      updateDraft(`${prompt}${text}`);
      return;
    }
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const next = `${textarea.value.slice(0, start)}${text}${textarea.value.slice(end)}`;
    updateDraft(next);
    requestAnimationFrame(() => {
      textarea.focus();
      const caret = start + text.length;
      textarea.setSelectionRange(caret, caret);
    });
  }

  /** Inserting a skill never creates a runtime session or submits a prompt. */
  async function insertMention(name: string) {
    setSurface("workspace");
    insertTextAtCursor(`/${name} `);
    setOpenDialog(null);
  }

  async function sendPrompt() {
    const text = prompt.trim();
    if (
      !text ||
      !location ||
      busy ||
      !eventsReady ||
      operationRef.current ||
      !savedWorkspace.ok
    )
      return;
    operationRef.current = true;
    const chat = activeConversation ?? {
      ...createConversationDraft(
        location.cwd,
        selectedAgentId,
        inventory?.agents.find((item) => item.id === selectedAgentId)?.name ??
          (selectedAgentId || "Copilot CLI"),
      ),
      draft: text,
    };
    if (!activeConversation) selectConversation(chat);
    const activeSession =
      session ??
      (chat.sessionId
        ? await loadSession(chat, true)
        : await startSession(chat));
    if (!activeSession) {
      setPrompt(text);
      operationRef.current = false;
      return;
    }
    rememberChat(activeSession, chat.agentId, chat.conversationId, chat.title);
    setSurface("workspace");
    const optimisticId = nextMessageId.current++;
    setPrompt("");
    setBusy(true);
    setFailure(null);
    setMessages((current) => [
      ...current,
      { id: optimisticId, role: "user", text },
    ]);
    try {
      const result = await invoke<CopilotPromptResult>(
        "copilot_session_prompt",
        {
          sessionId: activeSession.sessionId,
          prompt: text,
          agent:
            findConfigOption(activeSession.configOptions, "agent")
              ?.currentValue || null,
        },
      );
      if (mountedRef.current) {
        setStatusText(describeStopReason(result.stopReason));
        setChats((current) =>
          current.map((item) =>
            item.conversationId === chat.conversationId
              ? { ...item, draft: "" }
              : item,
          ),
        );
      }
    } catch (error) {
      if (mountedRef.current) {
        setFailure(asProblem(error));
        setMessages((current) =>
          current.filter((message) => message.id !== optimisticId),
        );
        setPrompt(text);
      }
    } finally {
      operationRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }

  async function cancelPrompt() {
    if (!session) return;
    const cancelledSessionId = session.sessionId;
    try {
      await invoke("copilot_session_cancel", {
        sessionId: session.sessionId,
        agent: sessionAgentId || null,
      });
      setPermissions((current) =>
        current.filter((request) => request.sessionId !== cancelledSessionId),
      );
    } catch (error) {
      if (mountedRef.current) setFailure(asProblem(error));
    }
  }

  /** Removes only the answered request by id, so answering one never erases a later queued one. */
  async function answerPermission(
    request: CopilotPermissionRequest,
    optionId: string | null,
  ) {
    if (respondingPermission) return;
    setRespondingPermission(true);
    try {
      await invoke("copilot_permission_respond", {
        requestId: request.requestId,
        optionId,
        agent: sessionAgentId || null,
      });
      setPermissions((current) =>
        current.filter((item) => item.requestId !== request.requestId),
      );
    } catch (error) {
      if (mountedRef.current) setFailure(asProblem(error));
    } finally {
      if (mountedRef.current) setRespondingPermission(false);
    }
  }

  async function handleBack() {
    if (busy) return;
    if (workspaceProblem) {
      setFailure(workspaceProblem);
      return;
    }
    setPermissions([]);
    const closed = await closeSessionSafely();
    if (!closed) return;
    onBack();
  }

  async function fetchHistory(
    allFolders: boolean,
    linkAgentIds?: readonly string[],
  ) {
    const request = crypto.randomUUID();
    historyRequestRef.current = request;
    historyLinkAgentIdsRef.current = linkAgentIds ?? null;
    setSessionsLoading(true);
    setSessionsPage(null);
    setSessionsProblem(null);
    setHistoryProgress("Reading conversation history...");
    setVisibleHistoryCount(50);
    if (linkAgentIds) {
      setLinkingConversations(true);
      setLinkStatus("");
      setSessionsAllFolders(true);
    }
    try {
      const page = await invoke<CopilotHistory>("copilot_history", {
        cwd: allFolders ? null : (location?.cwd ?? null),
        requestId: request,
      });
      if (!mountedRef.current || request !== historyRequestRef.current) return;
      setSessionsPage(page);
      if (linkAgentIds) {
        setChats((current) =>
          mergeLinkedConversations(
            current,
            page.sessions,
            linkAgentIds,
            conversationIdRef.current,
          ),
        );
        const allowed = new Set(["", ...linkAgentIds]);
        const linked = page.sessions.filter(
          (item) =>
            item.agentId !== "__unavailable__" && allowed.has(item.agentId),
        );
        const agentCount = new Set(linked.map((item) => item.agentId)).size;
        setLinkStatus(
          `Linked ${linked.length.toLocaleString()} conversations across ${agentCount.toLocaleString()} agents.${page.warnings.length ? " Some metadata is unavailable; see History." : ""}`,
        );
      }
    } catch (error) {
      if (mountedRef.current && request === historyRequestRef.current) {
        setSessionsProblem(asProblem(error));
        if (linkAgentIds)
          setLinkStatus(
            "Conversation linking stopped. Existing links were kept; retry in Settings.",
          );
      }
    } finally {
      if (mountedRef.current && request === historyRequestRef.current) {
        historyRequestRef.current = null;
        historyLinkAgentIdsRef.current = null;
        setSessionsLoading(false);
        setLinkingConversations(false);
      }
    }
  }

  function openAgentHistory(agentId: string) {
    setHistoryAgent(agentId);
    setHistorySearch("");
    setVisibleHistoryCount(50);
    setOpenDialog("conversations");
    if (!sessionsLoading && (!sessionsPage || !sessionsAllFolders)) {
      setSessionsAllFolders(true);
      void fetchHistory(true);
    }
  }

  function setAllFoldersAndRefetch(allFolders: boolean) {
    setSessionsAllFolders(allFolders);
    setHistoryAgent("__all__");
    setSessionsPage(null);
    void fetchHistory(allFolders);
  }

  function openDialogFrom(kind: Exclude<DialogKind, null>) {
    if (kind === "create-agent") setAgentProblem(null);
    setOpenDialog(kind);
    if (kind === "conversations" && !sessionsLoading) {
      void fetchHistory(sessionsAllFolders);
    }
  }

  /** Wired to each `<dialog>`'s native `close` event so Escape stays in sync with React state. */
  function handleDialogClosed(kind: Exclude<DialogKind, null>) {
    setOpenDialog((current) => (current === kind ? null : current));
  }

  function handleMessagesScroll() {
    const container = messagesRef.current;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    setStickToBottom(distanceFromBottom < 48);
  }

  function jumpToLatest() {
    const container = messagesRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    setStickToBottom(true);
  }

  function changeTheme(next: ThemePreference) {
    setThemeState(next);
    writeThemePreference(next);
  }

  function changeAutoScroll(next: boolean) {
    setAutoScrollEnabledState(next);
    writeAutoScrollPreference(next);
  }

  const resolveInitialLocation = useEffectEvent(() => {
    if (!savedWorkspace.ok) return;
    void resolveLocation(readStoredCwd());
  });
  const linkInitialHistory = useEffectEvent((agentIds: readonly string[]) =>
    fetchHistory(true, agentIds),
  );

  useEffect(() => {
    resolveInitialLocation();
  }, []);

  useEffect(() => {
    if (
      !eventsReady ||
      !savedWorkspace.ok ||
      !location ||
      initialLinkStartedRef.current ||
      initialConversationAgentIds.length === 0
    )
      return;
    initialLinkStartedRef.current = true;
    setSurface("canvas");
    void linkInitialHistory(initialConversationAgentIds);
  }, [eventsReady, location, initialConversationAgentIds, savedWorkspace.ok]);

  // main.tsx already applied this theme before first paint, but had no UI yet to show a failure
  // in. Re-applying the same value here is a harmless no-op on success and, on failure, gives the
  // native window-sync problem an actual place to surface instead of staying silent.
  useEffect(() => {
    let current = true;
    setThemeSyncWarning(null);
    applyTheme(theme).catch((error) => {
      if (current && mountedRef.current) setThemeSyncWarning(asProblem(error));
    });
    return () => {
      current = false;
    };
  }, [theme]);

  useEffect(() => {
    getVersion()
      .then((version) => {
        if (mountedRef.current) setAppVersion(version);
      })
      .catch((error) => {
        if (mountedRef.current) setFailure(asProblem(error));
      });
    invoke<CopilotStatus>("copilot_status", {})
      .then((result) => {
        if (mountedRef.current) setStatus(result);
      })
      .catch((error) => {
        if (mountedRef.current) setFailure(asProblem(error));
      });
  }, []);

  useEffect(() => {
    if (!location) return;
    let current = true;
    invoke<CopilotInventory>("copilot_inventory", { cwd: location.cwd })
      .then((result) => {
        if (current && mountedRef.current) setInventory(result);
      })
      .catch((error) => {
        if (current && mountedRef.current) setFailure(asProblem(error));
      });
    return () => {
      current = false;
    };
  }, [location]);

  // Falls back to the default Copilot agent if a previously stored choice no longer exists in
  // this workspace's inventory. Only applies before a session exists; once one does, the
  // negotiated configOptions become the sole authority over what "selected" means.
  useEffect(() => {
    if (!inventory || session || activeConversationId !== null) return;
    const validIds = new Set([
      "",
      ...inventory.agents.map((agent) => agent.id),
      ...createdAgents.map((agent) => agent.id),
    ]);
    setSelectedAgentId((current) => (validIds.has(current) ? current : ""));
  }, [inventory, session, createdAgents, activeConversationId]);

  useEffect(() => {
    const entries: Array<
      [Exclude<DialogKind, null>, HTMLDialogElement | null]
    > = [
      ["settings", settingsDialogRef.current],
      ["profile", profileDialogRef.current],
      ["resources", resourcesDialogRef.current],
      ["conversations", conversationsDialogRef.current],
      ["import", importDialogRef.current],
      ["create-agent", createAgentDialogRef.current],
    ];
    for (const [kind, element] of entries) {
      if (!element) continue;
      if (openDialog === kind && !element.open) element.showModal();
      if (openDialog !== kind && element.open) element.close();
    }
  }, [openDialog]);

  useEffect(() => {
    const element = permissionDialogRef.current;
    if (!element) return;
    if (permissions.length > 0 && !element.open) element.showModal();
    if (permissions.length === 0 && element.open) element.close();
  }, [permissions.length]);

  // Follows new messages only while the reader is already at the bottom, so nobody scrolled up
  // to re-read something earlier gets yanked back down mid-read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Appended messages and tab changes require remeasuring the scroll container.
  useEffect(() => {
    if (!autoScrollEnabled || !stickToBottom) return;
    const container = messagesRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [messages, autoScrollEnabled, stickToBottom, surface]);

  if (!savedWorkspace.ok) {
    return (
      <main className="copilot-main">
        <div className="copilot-workspace copilot-repair">
          <Failure problem={savedWorkspace.problem} />
          <button type="button" onClick={onBack}>
            Back
          </button>
        </div>
      </main>
    );
  }

  if (!location) {
    return (
      <main className="copilot-main">
        <div className="copilot-workspace copilot-repair">
          <header className="copilot-header">
            <BrandLockup />
            <div>
              <h1>Darbot with GitHub Copilot</h1>
              <p className="lede">Choose the folder Copilot should work in.</p>
            </div>
          </header>
          <section className="copilot-repair-body">
            {resolvingLocation ? (
              <p>Finding your working folder...</p>
            ) : (
              <>
                <label htmlFor="copilot-location-input">Working folder</label>
                <div className="row">
                  <input
                    id="copilot-location-input"
                    type="text"
                    value={locationInput}
                    onChange={(event) => setLocationInput(event.target.value)}
                    placeholder="C:\path\to\project"
                  />
                  <button type="button" onClick={() => void applyLocation()}>
                    Apply
                  </button>
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => void browseLocation()}
                  >
                    Browse...
                  </button>
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => void resetLocationToHome()}
                  >
                    Use home folder
                  </button>
                </div>
                {locationProblem && <InlineFailure problem={locationProblem} />}
              </>
            )}
            {failure && <Failure problem={failure} />}
          </section>
        </div>
      </main>
    );
  }

  const workspace = location;

  const agentConfigOption =
    configOptions.find((option) => option.id === "agent") ?? null;
  const modelOption =
    configOptions.find((option) => option.id === "model") ?? null;
  const reasoningOption =
    configOptions.find((option) => option.id === "reasoning_effort") ?? null;
  const modeOption =
    configOptions.find((option) => option.id === "mode") ?? null;

  const agentChoices: CopilotAgentSummary[] = agentConfigOption
    ? agentConfigOption.options.map((value) => ({
        id: value.value,
        name: value.value === "" ? "Copilot CLI" : value.name,
        description: value.description ?? null,
      }))
    : [
        DEFAULT_AGENT_CHOICE,
        ...Array.from(
          new Map(
            [...(inventory?.agents ?? []), ...createdAgents].map((agent) => [
              agent.id,
              agent,
            ]),
          ).values(),
        ),
      ];

  const disabledAgentIds = new Set(
    agentConfigOption
      ? agentConfigOption.options
          .filter(isConfigValueDisabled)
          .map((value) => value.value)
      : [],
  );

  const effectiveAgentId = session ? sessionAgentId : selectedAgentId;
  const currentAgent: CopilotAgentSummary =
    agentChoices.find((agent) => agent.id === effectiveAgentId) ??
    (effectiveAgentId
      ? { id: effectiveAgentId, name: effectiveAgentId }
      : DEFAULT_AGENT_CHOICE);
  const sidebarAgents = [
    ...new Set(["", ...importedAgentIds, ...chats.map((chat) => chat.agentId)]),
  ].map<CopilotAgentSummary>(
    (id) =>
      agentChoices.find((agent) => agent.id === id) ??
      createdAgents.find((agent) => agent.id === id) ?? {
        id,
        name: chats.find((chat) => chat.agentId === id)?.agentName ?? id,
      },
  );
  const activeChat = activeConversation;

  const currentPermission = permissions[0] ?? null;
  const historyQuery = historySearch.trim().toLowerCase();
  const historyRows = conversationHistoryRows(
    chats,
    sessionsPage?.sessions ?? [],
  ).filter((item) => sessionsAllFolders || item.cwd === workspace.cwd);
  const historyAgents = Array.from(
    groupWorkspaceChats(historyRows),
    ([id, conversations]) => ({
      id,
      name: conversations[0].agentName,
      count: conversations.length,
    }),
  ).sort((left, right) => left.name.localeCompare(right.name));
  const filteredHistory = historyRows.filter(
    (item) =>
      (historyAgent === "__all__" || item.agentId === historyAgent) &&
      (!historyQuery ||
        [item.title ?? "", item.cwd, item.agentName].some((text) =>
          text.toLowerCase().includes(historyQuery),
        )),
  );

  const resourceFilterLower = resourceFilter.trim().toLowerCase();
  const resourceByName = new Map<string, InsertableResource>();
  for (const command of availableCommands) {
    if (HIDDEN_COMMAND_NAMES.has(command.name)) continue;
    resourceByName.set(command.name.toLowerCase(), {
      key: `command:${command.name}`,
      name: command.name,
      description: command.description ?? command.input?.hint ?? null,
      enabled: true,
      group: "Command",
    });
  }
  for (const skill of inventory?.skills ?? []) {
    if (HIDDEN_COMMAND_NAMES.has(skill.name)) continue;
    const existing = resourceByName.get(skill.name.toLowerCase());
    resourceByName.set(skill.name.toLowerCase(), {
      key: `skill:${skill.name}`,
      name: existing?.name ?? skill.name,
      description: existing?.description ?? skill.description ?? null,
      enabled: skill.enabled,
      group: "Skill",
    });
  }
  const insertableResources = [...resourceByName.values()];
  const filteredResources = resourceFilterLower
    ? insertableResources.filter(
        (resource) =>
          resource.name.toLowerCase().includes(resourceFilterLower) ||
          (resource.description ?? "")
            .toLowerCase()
            .includes(resourceFilterLower),
      )
    : insertableResources;
  const conversationMessages = messages.filter(
    (message) => message.role !== "activity",
  );
  const activityMessages = messages.filter(
    (message) => message.role === "activity",
  );
  const agentManagement = (
    <section>
      <h3>Agents</h3>
      <p>
        Import personal agent references and link their existing conversations.
        Definitions and message bodies stay with Copilot.
      </p>
      <div className="row">
        <button
          type="button"
          className="quiet"
          disabled={busy || sessionsLoading}
          onClick={() => openDialogFrom("import")}
        >
          Import agents
        </button>
        <button
          type="button"
          className="quiet"
          disabled={busy || sessionsLoading || !eventsReady}
          onClick={() => void fetchHistory(true, importedAgentIds)}
        >
          Link existing conversations
        </button>
      </div>
      {(linkingConversations || linkStatus) && (
        <p className="hint" role="status">
          {linkingConversations ? historyProgress : linkStatus}
        </p>
      )}
      {sessionsProblem && <InlineFailure problem={sessionsProblem} />}
    </section>
  );

  return (
    <main className="copilot-main">
      <div className="copilot-workspace copilot-canvas-workspace">
        <aside className="copilot-sidebar" aria-label="Agents and chats">
          <header className="copilot-sidebar-header">
            <BrandLockup />
            <div className="copilot-sidebar-actions">
              <button
                type="button"
                disabled={busy || !eventsReady}
                onClick={() => openDialogFrom("create-agent")}
              >
                New agent
              </button>
              <button
                type="button"
                className="quiet"
                disabled={
                  busy || !eventsReady || disabledAgentIds.has(effectiveAgentId)
                }
                onClick={() => void startDraft(effectiveAgentId)}
                title={`New chat with ${currentAgent.name}`}
              >
                New chat
              </button>
            </div>
          </header>
          <nav className="copilot-chat-navigation" aria-label="Workspace chats">
            <h2>Agents</h2>
            {(linkingConversations || linkStatus) && (
              <p className="copilot-chat-link-status" role="status">
                {linkingConversations ? historyProgress : linkStatus}
              </p>
            )}
            <ul className="copilot-sidebar-groups">
              {sidebarAgents.map((agent) => {
                const agentChats = chatsByAgent.get(agent.id) ?? [];
                const preview = previewAgentChats(
                  agentChats,
                  activeConversationId,
                );
                return (
                  <li key={agent.id || "copilot-cli"} data-agent-id={agent.id}>
                    <div className="copilot-sidebar-agent">
                      <button
                        type="button"
                        className="quiet"
                        aria-pressed={effectiveAgentId === agent.id}
                        disabled={busy}
                        title={agent.description || agent.name}
                        onClick={() => void selectWorkspaceAgent(agent.id)}
                      >
                        {agent.name}
                      </button>
                      <button
                        type="button"
                        className="quiet copilot-new-chat"
                        aria-label={`New chat with ${agent.name}`}
                        disabled={
                          busy || !eventsReady || disabledAgentIds.has(agent.id)
                        }
                        onClick={() => void startDraft(agent.id)}
                      >
                        New
                      </button>
                    </div>
                    {agentChats.length ? (
                      <ul className="copilot-sidebar-chats">
                        {preview.map((chat) => (
                          <li key={chat.conversationId}>
                            <button
                              ref={
                                chat.conversationId === activeConversationId
                                  ? activeChatRef
                                  : null
                              }
                              type="button"
                              className="quiet"
                              aria-current={
                                chat.conversationId === activeConversationId
                                  ? "true"
                                  : undefined
                              }
                              disabled={busy || !eventsReady}
                              title={chat.title}
                              onClick={() => void loadSession(chat)}
                            >
                              {chat.sessionId === null
                                ? `Draft: ${chat.title}`
                                : chat.title}
                            </button>
                          </li>
                        ))}
                        {agentChats.length > preview.length && (
                          <li>
                            <button
                              type="button"
                              className="quiet"
                              onClick={() => openAgentHistory(agent.id)}
                            >
                              View all {agentChats.length.toLocaleString()}{" "}
                              chats
                            </button>
                          </li>
                        )}
                      </ul>
                    ) : (
                      <p className="hint">No chats yet</p>
                    )}
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="copilot-sidebar-tools">
            <button
              type="button"
              className="quiet"
              onClick={() => openDialogFrom("resources")}
            >
              Resources
            </button>
            <button
              type="button"
              className="quiet"
              onClick={() => openDialogFrom("conversations")}
            >
              History
            </button>
            <button
              type="button"
              className="quiet"
              onClick={() => openDialogFrom("settings")}
            >
              Settings
            </button>
            <button
              type="button"
              className="quiet"
              onClick={() => openDialogFrom("profile")}
            >
              Profile
            </button>
          </div>
        </aside>
        <section className="copilot-canvas" aria-label="Copilot workspace">
          <header className="copilot-canvas-header">
            <h1 className="sr-only">Darbot with GitHub Copilot</h1>
            <div
              className="copilot-surface-tabs"
              role="tablist"
              aria-label="Workspace surfaces"
            >
              {WORKSPACE_SURFACES.map((item, index) => (
                <button
                  key={item.id}
                  id={`copilot-tab-${item.id}`}
                  type="button"
                  role="tab"
                  className="quiet"
                  aria-selected={surface === item.id}
                  aria-controls={`copilot-panel-${item.id}`}
                  tabIndex={surface === item.id ? 0 : -1}
                  onClick={() => setSurface(item.id)}
                  onKeyDown={(event) => {
                    const nextIndex =
                      event.key === "ArrowRight"
                        ? (index + 1) % WORKSPACE_SURFACES.length
                        : event.key === "ArrowLeft"
                          ? (index + WORKSPACE_SURFACES.length - 1) %
                            WORKSPACE_SURFACES.length
                          : event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? WORKSPACE_SURFACES.length - 1
                              : null;
                    if (nextIndex === null) return;
                    event.preventDefault();
                    const next = WORKSPACE_SURFACES[nextIndex];
                    setSurface(next.id);
                    document.getElementById(`copilot-tab-${next.id}`)?.focus();
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </header>
          <section className="copilot-conversation">
            <div
              id="copilot-panel-workspace"
              className="copilot-surface-panel copilot-chat-panel"
              role="tabpanel"
              aria-labelledby="copilot-tab-workspace"
              hidden={surface !== "workspace"}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: ARIA tab panels need a keyboard entry point for their scrollable content.
              tabIndex={0}
            >
              <div className="copilot-conversation-title">
                <div>
                  <h2>{activeChat?.title ?? currentAgent.name}</h2>
                  <p>
                    {session
                      ? currentAgent.name
                      : activeChat?.sessionId
                        ? "Open the saved conversation to continue"
                        : activeChat
                          ? "Draft saved locally; Copilot starts when you send"
                          : "Start a new conversation"}
                  </p>
                </div>
                <span className="copilot-runtime-state" aria-live="polite">
                  {busy ? (openingSession ? "Opening" : "Working") : statusText}
                </span>
              </div>
              <div className="copilot-messages-wrap">
                <div
                  ref={messagesRef}
                  className={
                    busy || !snapScrollEnabled
                      ? "copilot-messages copilot-no-snap"
                      : "copilot-messages"
                  }
                  aria-live="polite"
                  aria-busy={busy}
                  onScroll={handleMessagesScroll}
                >
                  {conversationMessages.length === 0 ? (
                    <div className="copilot-empty">
                      <h2>
                        {busy
                          ? "Opening your conversation..."
                          : `What should ${currentAgent.name} work on?`}
                      </h2>
                      <p>
                        {openingSession
                          ? "Copilot is opening this conversation and initializing its configured tools. Slow MCP servers can delay this step; Darbot waits up to five minutes."
                          : currentAgent.description ||
                            "Describe a task below. Your agents and chats stay in the sidebar."}
                      </p>
                    </div>
                  ) : (
                    conversationMessages.map((message) => (
                      <div
                        key={message.id}
                        className={`copilot-message ${message.role}`}
                      >
                        <strong>
                          {message.role === "user" ? "You" : currentAgent.name}
                        </strong>
                        <p>{message.text}</p>
                      </div>
                    ))
                  )}
                </div>
                {!stickToBottom && conversationMessages.length > 0 && (
                  <button
                    type="button"
                    className="copilot-jump-latest"
                    onClick={jumpToLatest}
                  >
                    Jump to latest
                  </button>
                )}
              </div>
              {activityMessages.length > 0 && (
                <button
                  type="button"
                  className="quiet copilot-activity-link"
                  onClick={() => setSurface("cli")}
                >
                  View CLI activity ({activityMessages.length})
                </button>
              )}
            </div>
            <div
              id="copilot-panel-canvas"
              className="copilot-surface-panel"
              role="tabpanel"
              aria-labelledby="copilot-tab-canvas"
              hidden={surface !== "canvas"}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: ARIA tab panels need a keyboard entry point for their scrollable content.
              tabIndex={0}
            >
              <div className="copilot-surface-heading">
                <h2>Your agents and conversations</h2>
                <p className="hint">
                  Open a conversation or start a new task with an agent.
                </p>
              </div>
              <ul className="copilot-agent-canvas">
                {sidebarAgents.map((agent) => {
                  const agentChats = chatsByAgent.get(agent.id) ?? [];
                  const preview = previewAgentChats(
                    agentChats,
                    activeConversationId,
                  );
                  return (
                    <li
                      key={agent.id || "copilot-cli"}
                      data-agent-id={agent.id}
                    >
                      <h3>{agent.name}</h3>
                      <p>{agent.description || "Copilot agent"}</p>
                      <ul className="copilot-canvas-chats">
                        {preview.map((chat) => (
                          <li key={chat.conversationId}>
                            <button
                              type="button"
                              className="quiet"
                              title={chat.title}
                              disabled={busy || !eventsReady}
                              onClick={() => void loadSession(chat)}
                            >
                              {chat.sessionId === null
                                ? `Draft: ${chat.title}`
                                : chat.title}
                            </button>
                          </li>
                        ))}
                      </ul>
                      {agentChats.length === 0 && (
                        <p className="hint">No linked conversations yet.</p>
                      )}
                      {agentChats.length > preview.length && (
                        <button
                          type="button"
                          className="quiet"
                          onClick={() => openAgentHistory(agent.id)}
                        >
                          View all {agentChats.length.toLocaleString()} chats
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={
                          busy || !eventsReady || disabledAgentIds.has(agent.id)
                        }
                        onClick={() => void startDraft(agent.id)}
                      >
                        New chat
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div
              id="copilot-panel-cli"
              className="copilot-surface-panel"
              role="tabpanel"
              aria-labelledby="copilot-tab-cli"
              hidden={surface !== "cli"}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: ARIA tab panels need a keyboard entry point for their scrollable content.
              tabIndex={0}
            >
              <div className="copilot-surface-heading">
                <h2 className="copilot-provider-label">
                  <span className="copilot-mark" aria-hidden="true" />
                  GitHub Copilot CLI
                </h2>
                <p className="hint">
                  Live tool activity for this conversation, separate from chat.
                  This is an activity viewer, not an interactive shell.
                </p>
              </div>
              {activityMessages.length === 0 ? (
                <p className="copilot-empty">
                  No tool activity in this conversation yet.
                </p>
              ) : (
                <ol
                  className="copilot-cli-activity"
                  aria-label="CLI activity"
                  aria-live="polite"
                >
                  {activityMessages.map((message) => (
                    <li key={message.id}>
                      <p>{message.text}</p>
                      {message.raw != null && (
                        <details className="detail-of">
                          <summary>Tool output and details</summary>
                          <pre>{formatRawPayload(message.raw)}</pre>
                        </details>
                      )}
                    </li>
                  ))}
                </ol>
              )}
              {location && <CopilotExtensionsPanel cwd={location.cwd} />}
            </div>
            <div className="copilot-composer">
              <label htmlFor="copilot-prompt">
                Message{" "}
                {currentAgent.name.replace(/^./, (letter) =>
                  letter.toUpperCase(),
                )}
              </label>
              <div className="copilot-composer-input">
                <button
                  type="button"
                  className="quiet copilot-composer-add"
                  aria-label="Add a skill or command"
                  title="Add a skill or command"
                  onClick={() => openDialogFrom("resources")}
                  disabled={busy || !eventsReady}
                >
                  +
                </button>
                <textarea
                  ref={promptRef}
                  id="copilot-prompt"
                  value={prompt}
                  onChange={(event) => updateDraft(event.target.value)}
                  maxLength={MAX_DRAFT_LENGTH}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      if (!busy) void sendPrompt();
                    }
                  }}
                  disabled={busy || !eventsReady}
                  placeholder="Describe what you want to do"
                />
              </div>
              <div className="row">
                <button
                  type="button"
                  className="quiet"
                  onClick={() => openDialogFrom("settings")}
                >
                  Settings
                </button>
                <span className="copilot-composer-hint">
                  Enter to send, Shift+Enter for a new line
                </span>
                <button
                  type="button"
                  onClick={() => void sendPrompt()}
                  disabled={busy || !eventsReady || !prompt.trim()}
                >
                  Send
                </button>
                {busy && session && (
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => void cancelPrompt()}
                  >
                    Stop
                  </button>
                )}
              </div>
            </div>
            {inventory && inventory.warnings.length > 0 && (
              <details className="copilot-runtime-warnings">
                <summary>Copilot resource warnings</summary>
                <ul>
                  {[...new Set(inventory.warnings)].map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </details>
            )}
            {failure && <Failure problem={failure} />}
            {failure && activeChat?.sessionId && !session && !busy && (
              <button
                type="button"
                className="quiet"
                onClick={() => void loadSession(activeChat)}
              >
                Retry opening conversation
              </button>
            )}
            {workspaceProblem && <InlineFailure problem={workspaceProblem} />}
          </section>
        </section>
      </div>

      <dialog
        ref={importDialogRef}
        className="copilot-dialog copilot-dialog-wide"
        aria-labelledby="copilot-import-title"
        onClose={() => handleDialogClosed("import")}
      >
        <div className="copilot-dialog-body">
          {openDialog === "import" && (
            <CopilotAgentImport
              existingIds={importedAgentIds}
              onComplete={(ids) => {
                addImportedAgents(ids);
                setOpenDialog(null);
              }}
              onBack={() => setOpenDialog(null)}
            />
          )}
        </div>
      </dialog>

      <dialog
        ref={createAgentDialogRef}
        className="copilot-dialog"
        aria-labelledby="copilot-create-agent-title"
        onClose={() => handleDialogClosed("create-agent")}
        onCancel={(event) => {
          if (creatingAgent) event.preventDefault();
        }}
      >
        <div className="copilot-dialog-header">
          <h2 id="copilot-create-agent-title">Create an agent</h2>
          <button
            type="button"
            className="quiet"
            disabled={creatingAgent}
            onClick={() => setOpenDialog(null)}
          >
            Cancel
          </button>
        </div>
        <form
          className="copilot-dialog-body"
          onSubmit={(event) => {
            event.preventDefault();
            void createAgent();
          }}
        >
          <section>
            <label htmlFor="copilot-new-agent-name">Agent name</label>
            <input
              id="copilot-new-agent-name"
              type="text"
              value={agentName}
              onChange={(event) => setAgentName(event.target.value)}
              placeholder="workspace-guide"
              pattern="[a-z0-9][a-z0-9_-]{0,63}"
              maxLength={64}
              required
              disabled={creatingAgent}
            />
            <p className="hint">
              Lowercase letters, numbers, hyphens and underscores. This is also
              the Copilot agent name.
            </p>
          </section>
          <section>
            <label htmlFor="copilot-new-agent-description">Description</label>
            <input
              id="copilot-new-agent-description"
              type="text"
              value={agentDescription}
              onChange={(event) => setAgentDescription(event.target.value)}
              maxLength={1000}
              required
              disabled={creatingAgent}
            />
          </section>
          <section>
            <label htmlFor="copilot-new-agent-instructions">Instructions</label>
            <textarea
              id="copilot-new-agent-instructions"
              value={agentInstructions}
              onChange={(event) => setAgentInstructions(event.target.value)}
              rows={5}
              maxLength={30000}
              required
              disabled={creatingAgent}
              placeholder="Describe this agent's purpose, working style and boundaries."
            />
          </section>
          <p className="hint">
            Saved as a new personal .agent.md file in your configured Copilot
            home. Existing files are never replaced. Tool permissions stay under
            Copilot's control.
          </p>
          {agentProblem && <InlineFailure problem={agentProblem} />}
          <button
            type="submit"
            disabled={
              creatingAgent ||
              !agentName.trim() ||
              !agentDescription.trim() ||
              !agentInstructions.trim()
            }
          >
            {creatingAgent ? "Creating agent..." : "Create agent"}
          </button>
        </form>
      </dialog>

      <dialog
        ref={settingsDialogRef}
        className="copilot-dialog"
        aria-labelledby="copilot-settings-title"
        onClose={() => handleDialogClosed("settings")}
      >
        <div className="copilot-dialog-header">
          <h2 id="copilot-settings-title">Settings</h2>
          <button
            type="button"
            className="quiet"
            onClick={() => setOpenDialog(null)}
          >
            Close
          </button>
        </div>
        <div className="copilot-dialog-body">
          {agentManagement}
          <section>
            <h3>Appearance</h3>
            <label htmlFor="copilot-theme">Theme</label>
            <select
              id="copilot-theme"
              value={theme}
              onChange={(event) =>
                changeTheme(event.target.value as ThemePreference)
              }
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="system">Match system</option>
            </select>
            {themeSyncWarning && <InlineFailure problem={themeSyncWarning} />}
            <label className="copilot-checkbox-row">
              <input
                type="checkbox"
                checked={autoScrollEnabled}
                onChange={(event) => changeAutoScroll(event.target.checked)}
              />
              Automatically follow new messages
            </label>
            <label className="copilot-checkbox-row">
              <input
                type="checkbox"
                checked={snapScrollEnabled}
                onChange={(event) => {
                  setSnapScrollEnabled(event.target.checked);
                  writeSnapScrollPreference(event.target.checked);
                }}
              />
              Snap to messages when not streaming
            </label>
          </section>
          <section>
            <h3>Working folder</h3>
            <label htmlFor="copilot-folder-input">Folder</label>
            <div className="row">
              <input
                id="copilot-folder-input"
                type="text"
                value={locationInput}
                disabled={busy}
                onChange={(event) => setLocationInput(event.target.value)}
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => void applyLocation()}
              >
                Apply
              </button>
              <button
                type="button"
                className="quiet"
                disabled={busy}
                onClick={() => void browseLocation()}
              >
                Browse...
              </button>
            </div>
            <p className="copilot-folder-home">Home: {workspace.home}</p>
            {locationProblem && <InlineFailure problem={locationProblem} />}
          </section>
          {session && (modelOption || reasoningOption || modeOption) && (
            <section>
              <h3>Session configuration</h3>
              {modelOption && (
                <>
                  <label htmlFor="copilot-model">
                    {modelOption.name ?? configOptionLabel(modelOption.id)}
                  </label>
                  <select
                    id="copilot-model"
                    value={modelOption.currentValue}
                    disabled={busy}
                    onChange={(event) =>
                      void configureSession("model", event.target.value)
                    }
                  >
                    {modelOption.options.map((value) => (
                      <option
                        key={value.value}
                        value={value.value}
                        disabled={isConfigValueDisabled(value)}
                      >
                        {value.name}
                      </option>
                    ))}
                  </select>
                </>
              )}
              {reasoningOption && (
                <>
                  <label htmlFor="copilot-reasoning">
                    {reasoningOption.name ??
                      configOptionLabel(reasoningOption.id)}
                  </label>
                  <select
                    id="copilot-reasoning"
                    value={reasoningOption.currentValue}
                    disabled={busy}
                    onChange={(event) =>
                      void configureSession(
                        "reasoning_effort",
                        event.target.value,
                      )
                    }
                  >
                    {reasoningOption.options.map((value) => (
                      <option
                        key={value.value}
                        value={value.value}
                        disabled={isConfigValueDisabled(value)}
                      >
                        {value.name}
                      </option>
                    ))}
                  </select>
                </>
              )}
              {modeOption && (
                <>
                  <label htmlFor="copilot-mode">
                    {modeOption.name ?? configOptionLabel(modeOption.id)}
                  </label>
                  <select
                    id="copilot-mode"
                    value={modeOption.currentValue}
                    disabled={busy}
                    onChange={(event) =>
                      void configureSession("mode", event.target.value)
                    }
                  >
                    {visibleConfigOptionValues(modeOption).map((value) => (
                      <option
                        key={value.value}
                        value={value.value}
                        disabled={isConfigValueDisabled(value)}
                      >
                        {value.name}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </section>
          )}
          {!session && (
            <p className="hint">
              Model and reasoning settings appear once a conversation starts.
            </p>
          )}
        </div>
      </dialog>

      <dialog
        ref={profileDialogRef}
        className="copilot-dialog"
        aria-labelledby="copilot-profile-title"
        onClose={() => handleDialogClosed("profile")}
      >
        <div className="copilot-dialog-header">
          <h2 id="copilot-profile-title">Profile</h2>
          <button
            type="button"
            className="quiet"
            onClick={() => setOpenDialog(null)}
          >
            Close
          </button>
        </div>
        <div className="copilot-dialog-body">
          <p>Darbot desktop {appVersion ?? "version unavailable"}</p>
          {agentManagement}
          <section>
            <h3>Model providers</h3>
            <h4 className="copilot-provider-label">
              <span className="copilot-mark" aria-hidden="true" />
              GitHub Copilot
            </h4>
            <p>
              Copilot CLI owns this connection and its authentication. Models
              and reasoning options come from the current conversation.
              Additional native provider connections are not available yet.
            </p>
            <button
              type="button"
              className="quiet"
              onClick={() => openDialogFrom("settings")}
            >
              Conversation model settings
            </button>
            {status ? (
              <>
                <p>
                  Copilot CLI {status.version} (protocol{" "}
                  {status.protocolVersion})
                </p>
                <p>Authentication: {status.authentication}</p>
                <h3>Copilot runtime capabilities</h3>
                <ul className="copilot-capability-list">
                  {Object.entries(status.capabilities).map(([key, value]) => (
                    <li key={key} className={value ? "good" : "bad"}>
                      {CAPABILITY_LABELS[key] ?? key}:{" "}
                      {value ? "Available" : "Not available"}
                    </li>
                  ))}
                </ul>
                <p>
                  Known conversations: {status.sessionCount}
                  {status.hasMoreSessions ? "+" : ""}
                </p>
                {status.warnings.length > 0 && (
                  <details className="copilot-runtime-warnings">
                    <summary>Warnings</summary>
                    <ul>
                      {[...new Set(status.warnings)].map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            ) : (
              <p>Reading Copilot status...</p>
            )}
          </section>
          <section>
            <h3>Current agent</h3>
            <p>
              <strong>{currentAgent.name}</strong>
              {currentAgent.model ? ` - ${currentAgent.model}` : ""}
            </p>
            <p>{currentAgent.description || "No description provided."}</p>
          </section>
          <section>
            <h3>Other runtimes</h3>
            <p>
              Container-based deployments use their own setup and model
              connections.
            </p>
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => void handleBack()}
            >
              Open deployment setup
            </button>
          </section>
          <details className="detail-of">
            <summary>GitHub Copilot icon license</summary>
            <pre>{copilotIconLicense}</pre>
          </details>
        </div>
      </dialog>

      <dialog
        ref={resourcesDialogRef}
        className="copilot-dialog copilot-dialog-wide"
        aria-labelledby="copilot-resources-title"
        onClose={() => handleDialogClosed("resources")}
      >
        <div className="copilot-dialog-header">
          <h2 id="copilot-resources-title">Resources</h2>
          <button
            type="button"
            className="quiet"
            onClick={() => setOpenDialog(null)}
          >
            Close
          </button>
        </div>
        <div className="copilot-dialog-body">
          <label htmlFor="copilot-resource-filter">Search skills</label>
          <input
            id="copilot-resource-filter"
            type="text"
            value={resourceFilter}
            onChange={(event) => setResourceFilter(event.target.value)}
            placeholder="Filter by name or description"
          />
          <ul className="copilot-resource-list">
            {filteredResources.length === 0 ? (
              <li className="copilot-resource-empty">No matching skills.</li>
            ) : (
              filteredResources.map((resource) => (
                <li key={resource.key}>
                  <button
                    type="button"
                    className="copilot-resource-item"
                    disabled={!resource.enabled || busy || !eventsReady}
                    onClick={() => void insertMention(resource.name)}
                    title={resource.description ?? undefined}
                  >
                    <span className="copilot-resource-name">
                      /{resource.name}
                    </span>
                    <span className="copilot-resource-desc">
                      {resource.description ?? "No description"}
                    </span>
                    {!resource.enabled && (
                      <span className="copilot-resource-flag">disabled</span>
                    )}
                  </button>
                </li>
              ))
            )}
          </ul>
          {inventory && inventory.plugins.length > 0 && (
            <details>
              <summary>Plugins ({inventory.plugins.length})</summary>
              <ul className="copilot-resource-list copilot-resource-list-plain">
                {inventory.plugins.map((plugin) => (
                  <li key={plugin.name}>
                    {plugin.name}
                    {plugin.version ? ` (${plugin.version})` : ""}
                    {!plugin.enabled ? " - disabled" : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {inventory && inventory.mcpServers.length > 0 && (
            <details>
              <summary>MCP servers ({inventory.mcpServers.length})</summary>
              <ul className="copilot-resource-list copilot-resource-list-plain">
                {inventory.mcpServers.map((server) => (
                  <li key={server.name}>
                    {server.name} - {server.toolCount} tools
                    {!server.enabled ? " - disabled" : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {inventory && inventory.warnings.length > 0 && (
            <details className="copilot-runtime-warnings">
              <summary>Warnings</summary>
              <ul>
                {[...new Set(inventory.warnings)].map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </dialog>

      <dialog
        ref={conversationsDialogRef}
        className="copilot-dialog copilot-dialog-wide"
        aria-labelledby="copilot-history-agents-title copilot-conversations-title"
        onClose={() => handleDialogClosed("conversations")}
      >
        <div className="copilot-dialog-header">
          <h2 id="copilot-history-agents-title">Agents</h2>
          <button
            type="button"
            className="quiet"
            onClick={() => setOpenDialog(null)}
          >
            Close
          </button>
        </div>
        <div className="copilot-dialog-body">
          <section aria-label="Conversation agents">
            <label htmlFor="copilot-history-agent">Conversation agent</label>
            <select
              id="copilot-history-agent"
              value={historyAgent}
              onChange={(event) => {
                setHistoryAgent(event.target.value);
                setVisibleHistoryCount(50);
              }}
            >
              <option value="__all__">
                All agents ({historyRows.length.toLocaleString()} conversations)
              </option>
              {historyAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} ({agent.count.toLocaleString()})
                </option>
              ))}
            </select>
            <p className="hint">
              Recorded conversations keep their initial agent. Local drafts stay
              on this device and start Copilot only when you send.
            </p>
          </section>
          <h3 id="copilot-conversations-title">Conversations</h3>
          <label className="copilot-checkbox-row">
            <input
              type="checkbox"
              checked={sessionsAllFolders}
              disabled={sessionsLoading}
              onChange={(event) =>
                setAllFoldersAndRefetch(event.target.checked)
              }
            />
            Show conversations from all folders
          </label>
          <label htmlFor="copilot-history-search">Search conversations</label>
          <input
            id="copilot-history-search"
            type="text"
            value={historySearch}
            onChange={(event) => {
              setHistorySearch(event.target.value);
              setVisibleHistoryCount(50);
            }}
            placeholder="Search titles, folders or agents"
          />
          {sessionsLoading && <p role="status">{historyProgress}</p>}
          {sessionsProblem && <InlineFailure problem={sessionsProblem} />}
          {sessionsPage && !sessionsLoading && (
            <p className="hint">
              {filteredHistory.length.toLocaleString()} matching conversations
            </p>
          )}
          {sessionsPage?.timings && (
            <details className="detail-of">
              <summary>History indexing timings</summary>
              <p>
                Connection: {sessionsPage.timings.connectionMs} ms. Listing:{" "}
                {sessionsPage.timings.listingMs} ms. Agent metadata:{" "}
                {sessionsPage.timings.indexingMs} ms. First batch:{" "}
                {sessionsPage.timings.firstPageMs ?? "no conversations"} ms.
                Total: {sessionsPage.timings.totalMs} ms.
              </p>
            </details>
          )}
          <ul className="copilot-resource-list copilot-resource-list-plain">
            {filteredHistory.length === 0 && !sessionsLoading ? (
              <li>No conversations match this agent, folder and search.</li>
            ) : (
              filteredHistory.slice(0, visibleHistoryCount).map((item) => (
                <li key={item.conversationId} className="copilot-session-row">
                  <div>
                    <span className="copilot-history-agent">
                      {item.agentName}
                    </span>
                    <strong>{item.title ?? "Untitled conversation"}</strong>
                    <p>{item.cwd}</p>
                  </div>
                  <button
                    type="button"
                    disabled={
                      busy ||
                      (item.sessionId !== null &&
                        item.sessionId === session?.sessionId)
                    }
                    onClick={() => void loadSession(item)}
                  >
                    {item.sessionId !== null &&
                    item.sessionId === session?.sessionId
                      ? "Active"
                      : item.sessionId === null
                        ? "Open draft"
                        : "Load"}
                  </button>
                </li>
              ))
            )}
          </ul>
          {filteredHistory.length > visibleHistoryCount && (
            <button
              type="button"
              className="quiet"
              disabled={sessionsLoading}
              onClick={() => setVisibleHistoryCount((count) => count + 50)}
            >
              Load more
            </button>
          )}
          {!!sessionsPage?.warnings.length && (
            <details className="copilot-runtime-warnings">
              <summary>History metadata warnings</summary>
              <ul>
                {sessionsPage.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </dialog>

      <dialog
        ref={permissionDialogRef}
        className="copilot-dialog"
        aria-labelledby="copilot-permission-title"
        onCancel={(event) => {
          event.preventDefault();
          if (currentPermission) void answerPermission(currentPermission, null);
        }}
      >
        {currentPermission && (
          <>
            <div className="copilot-dialog-header">
              <h2 id="copilot-permission-title">Permission requested</h2>
              {permissions.length > 1 && (
                <span className="copilot-queue-badge">
                  1 of {permissions.length}
                </span>
              )}
            </div>
            <div className="copilot-dialog-body">
              <p>{describePermissionTitle(currentPermission.toolCall)}</p>
              <details className="copilot-permission-detail">
                <summary>Requested action details</summary>
                <pre>{formatRawPayload(currentPermission.toolCall)}</pre>
              </details>
              <div className="row">
                {currentPermission.options.map((option) => (
                  <button
                    type="button"
                    key={option.optionId}
                    disabled={respondingPermission}
                    onClick={() =>
                      void answerPermission(currentPermission, option.optionId)
                    }
                  >
                    {option.name}
                  </button>
                ))}
                <button
                  type="button"
                  className="quiet"
                  disabled={respondingPermission}
                  onClick={() => void answerPermission(currentPermission, null)}
                >
                  Cancel request
                </button>
              </div>
              {failure && <InlineFailure problem={failure} />}
            </div>
          </>
        )}
      </dialog>
    </main>
  );
}
