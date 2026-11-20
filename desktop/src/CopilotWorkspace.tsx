import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  type CSSProperties,
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { CopilotAgentIcon, AgentAttributeIcon } from "./CopilotAgentIcon";
import {
  AgentDashboard,
  ArchiveTiles,
  useSessionEvidence,
} from "./AgentDashboard";
import { HistorySources, useHistorySources } from "./HistorySources";
import {
  acpKey,
  countLabel,
  groupArchive,
  projectAgentHistory,
  type AgentHistory,
} from "./history-sources";
import { promoteDraft } from "./session-harvest";
import { ResourceDiagnostics } from "./ResourceDiagnostics";
import { CopilotAgentImport, StudioSources } from "./CopilotAgentImport";
import {
  CopilotExtensionsPanel,
  ElicitationReview,
  type CopilotElicitationRequest,
} from "./CopilotExtensionsPanel";
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
  type CopilotAgentCatalog,
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
  type CopilotTerminalOutput,
  type CopilotCompaction,
  mergeCompaction,
  terminalDisplayText,
  type CopilotWorkspaceChat,
  type CopilotWorkspaceLocation,
  findConfigOption,
  isConfigValueDisabled,
  mergeToolActivity,
  agentSourceLabel,
  buildFleetCard,
  fleetCardSchema,
  fleetDisplayId,
  fleetIdentity,
  FLEET_TABS,
  type FleetTab,
  isStudioAgentId,
  studioAgentUrl,
} from "./copilot-types";
import {
  type ConversationWorkspace,
  conversationFromHistory,
  createConversationDraft,
  emptyConversationWorkspace,
  MAX_DRAFT_LENGTH,
  readConversationWorkspace,
  sessionScope,
  writeConversationWorkspace,
} from "./copilot-workspace-store";
import { useDesktopWindow } from "./DesktopWindow";
import copilotIconLicense from "./marks/copilot.LICENSE.txt?raw";
import { asProblem, Failure, InlineFailure, type Problem } from "./Problem";
import {
  isSidepaneGroupExpanded,
  readSidepaneDisclosure,
  SIDEPANE_AGENT_LAYER,
  type SidepaneDisclosure,
  type SidepaneRegion,
  setSidepaneGroupExpanded,
  sidepaneRegion,
  writeSidepaneDisclosure,
} from "./sidepane-layers";
import { DESKTOP_SEMANTIC_MODEL } from "./ui-semantic-model";
import { BrandLockup } from "./Welcome";

type Message = {
  id: number;
  role: "user" | "assistant" | "activity";
  text: string;
  /** Dedup key for one-shot activity notices (e.g. "thinking") so repeats don't pile up. */
  activityKey?: string;
  raw?: unknown;
  protocolMessageId?: string;
  toolActivity?: CopilotToolActivity;
};

type DialogKind =
  | "settings"
  | "profile"
  | "resources"
  | "conversations"
  | "import"
  | "create-agent"
  | "agent"
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

function parseRuntimeRpcError(problem: Problem): {
  code: number;
  message: string;
} | null {
  if (!problem.detail) return null;
  try {
    const parsed = JSON.parse(problem.detail);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { code?: unknown }).code === "number" &&
      typeof (parsed as { message?: unknown }).message === "string"
    ) {
      return {
        code: (parsed as { code: number }).code,
        message: (parsed as { message: string }).message,
      };
    }
  } catch {
    // Runtime detail can be non-JSON in other failure paths.
  }
  return null;
}

function isMissingRuntimeSession(problem: Problem): boolean {
  const runtime = parseRuntimeRpcError(problem);
  if (runtime?.code === -32002) {
    const text = runtime.message.toLowerCase();
    return text.includes("session") && text.includes("not found");
  }
  return /session .* not found/i.test(problem.said);
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

const WORKSPACE_SURFACES = DESKTOP_SEMANTIC_MODEL.surfaces;
const WORKSPACE_SIDEPANE = DESKTOP_SEMANTIC_MODEL.sidepane;

type WorkspaceSurface = (typeof WORKSPACE_SURFACES)[number]["id"];

function renderSidepaneRegion(
  region: SidepaneRegion,
  content: Readonly<Record<string, ReactNode>>,
): ReactNode {
  return sidepaneRegion(WORKSPACE_SIDEPANE, region).map((layer) => {
    const node = content[layer.id];
    if (node == null) {
      throw new Error(`Sidepane layer "${layer.id}" needs a renderer.`);
    }
    return <Fragment key={layer.id}>{node}</Fragment>;
  });
}

const CARD_TABS = [...FLEET_TABS, "Full card"] as const;
const FLEET_PAGE_SIZE = 24;

function FleetTile({
  agent,
  build,
  history,
  sessionActions,
  diagnostics,
}: {
  agent: CopilotAgentSummary;
  build: () => ReturnType<typeof buildFleetCard>;
  history: AgentHistory;
  sessionActions: () => ReactNode;
  diagnostics: () => ReactNode;
}) {
  const [back, setBack] = useState(false);
  const [tab, setTab] = useState<FleetTab | "Full card">("overview");
  const [schema, setSchema] = useState(false);
  const [notice, setNotice] = useState("");
  const id = useId();
  const flip = useRef<HTMLButtonElement>(null);
  const cloud = isStudioAgentId(agent.id);
  const card = build();
  const displayId = card.agentcard_ID;
  const {
    overview,
    tools,
    model,
    sessions,
    freshness,
    source,
    runtime,
    facets,
  } = card.tabs;
  const toolNames = [
    ...new Set(
      tools.declarations?.map((t) =>
        t.server ? `${t.server}/${t.name}` : t.name,
      ),
    ),
  ];
  const purpose = overview.description ?? "No public purpose reported.";
  const indexed = countLabel(history.summary);
  const modified =
    freshness.modifiedAt ??
    (freshness.definitionModifiedAtUnix == null
      ? null
      : new Date(freshness.definitionModifiedAtUnix * 1000).toISOString());
  const origin =
    source.definitionFile ?? source.studio?.schemaName ?? "Not reported";
  const facts: [string, string | undefined | null][] = cloud
    ? [
        ["Schema", origin],
        ["Environment", source.studio?.environmentName],
        [
          "Catalog state",
          source.studio
            ? source.studio.stateCode === 0
              ? "Active"
              : "Inactive"
            : null,
        ],
        ["Modified", modified?.slice(0, 10)],
        ["Bot ID", source.studio?.botId],
        ["Sessions", indexed],
      ]
    : [
        [
          runtime.observedModel ? "Session model" : "Declared model",
          runtime.observedModel ?? model.declared,
        ],
        [
          "Tools / MCP",
          toolNames.join(", ") ||
            (tools.status === "inspected" && !tools.withheldCount
              ? "None declared"
              : null),
        ],
        ["Definition", source.definitionFile?.split(/[\\/]/).pop()],
        ["Sessions", indexed],
        [
          "Runtime",
          runtime.activeSessionId
            ? "Open CLI session"
            : runtime.provider
              ? "CLI history"
              : null,
        ],
        ["File modified", modified?.slice(0, 10)],
      ];
  const header = (reverse: boolean) => (
    <header className="fleet-head">
      <div className="fleet-eyebrow">
        {reverse
          ? "Interoperability / back"
          : cloud
            ? "Copilot Studio"
            : "Copilot CLI"}
      </div>
      <div className="fleet-identity">
        <CopilotAgentIcon agent={agent} />
        <h3>{agent.name}</h3>
      </div>
    </header>
  );
  const footer = (
    <footer className="fleet-foot">
      {displayId} · {source.provider}
    </footer>
  );
  const value =
    tab === "Full card"
      ? schema
        ? fleetCardSchema
        : card
      : schema
        ? fleetCardSchema.properties.tabs.properties[tab]
        : card.tabs[tab];
  const json = back ? JSON.stringify(value, null, 2) : "";

  function selectTab(next: typeof tab) {
    setTab(next);
    setNotice("");
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(json);
      setNotice("Copied JSON");
    } catch {
      setNotice("Copy unavailable. Select the JSON to copy it manually.");
    }
  }
  return (
    <li
      className="fleet-tile"
      data-agent-id={agent.id}
      data-back={back}
      data-ui-action="inspect_details"
      onKeyDown={(event) => {
        if (back && event.key === "Escape") {
          event.stopPropagation();
          setBack(false);
          flip.current?.focus();
        }
      }}
    >
      <button
        type="button"
        ref={flip}
        className="quiet fleet-flip"
        data-ui-action="inspect_details"
        aria-expanded={back}
        aria-label={`${back ? "Back to summary" : "Flip AgentCard"}: ${agent.name} ${displayId}`}
        onClick={() => {
          setBack(!back);
          setNotice("");
        }}
      >
        <span>{back ? "← Back" : "Flip card ↻"}</span>
      </button>
      <div className="fleet-rotator">
        <div className="fleet-face fleet-front" inert={back}>
          {header(false)}
          <p className="fleet-story">{purpose}</p>
          <dl className="fleet-metrics">
            {facts.map(([label, fact]) => (
              <div key={label}>
                <dt>
                  <AgentAttributeIcon name={label} />
                  {label}
                </dt>
                <dd title={fact ?? undefined}>
                  {label === "Sessions" ? (
                    <button
                      className="quiet fleet-count"
                      type="button"
                      data-ui-action="inspect_details"
                      aria-label={`${fact} · History sources for ${agent.name}`}
                      onClick={() => {
                        selectTab("sessions");
                        setSchema(false);
                        setBack(true);
                      }}
                    >
                      {fact} · History sources
                    </button>
                  ) : (
                    (fact ?? "Not reported")
                  )}
                </dd>
              </div>
            ))}
          </dl>
          <ul className="fleet-facets" aria-label="Provenance weights">
            {facets.entries.slice(0, 3).map((f) => (
              <li key={f.facet}>
                {f.facet}
                <meter min={0} max={3} value={f.weight} aria-label={f.facet} />
                {f.weight}/3
              </li>
            ))}
          </ul>
          {footer}
        </div>
        {back && (
          <section
            className="fleet-face fleet-back"
            aria-label={`${agent.name} AgentCard`}
          >
            {header(true)}
            <div
              role="tablist"
              aria-label="AgentCard details"
              className="fleet-tabs"
            >
              {CARD_TABS.map((item, index) => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  className="quiet"
                  data-ui-action="inspect_details"
                  aria-selected={tab === item}
                  tabIndex={tab === item ? 0 : -1}
                  id={`${id}-${index}`}
                  aria-controls={`${id}-panel`}
                  onClick={() => selectTab(item)}
                  onKeyDown={(event) => {
                    const n = CARD_TABS.length;
                    const next =
                      event.key === "ArrowRight"
                        ? (index + 1) % n
                        : event.key === "ArrowLeft"
                          ? (index + n - 1) % n
                          : event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? n - 1
                              : -1;
                    if (next < 0) return;
                    event.preventDefault();
                    selectTab(CARD_TABS[next]);
                    document.getElementById(`${id}-${next}`)?.focus();
                  }}
                >
                  {item}
                </button>
              ))}
            </div>
            <div
              role="tabpanel"
              className="fleet-content"
              id={`${id}-panel`}
              aria-labelledby={`${id}-${CARD_TABS.indexOf(tab)}`}
            >
              {tab === "sessions" && !schema && sessionActions()}
              {tab === "tools" && !schema && diagnostics()}
              <div className="fleet-toolbar">
                <button
                  type="button"
                  className="quiet"
                  data-ui-action="inspect_details"
                  aria-pressed={schema}
                  onClick={() => {
                    setSchema(!schema);
                    setNotice("");
                  }}
                >
                  {schema ? "Show instance" : "Show schema"}
                </button>
                <button
                  type="button"
                  className="quiet"
                  data-ui-action="fleet_copy_json"
                  onClick={() => void copy()}
                >
                  Copy JSON
                </button>
              </div>
              {notice && <small role="status">{notice}</small>}
              {!schema && (
                <p className="fleet-detail-note">
                  {tab === "facets"
                    ? facets.rubric
                    : tab === "overview"
                      ? purpose
                      : tab === "environment"
                        ? card.tabs.environment.scope
                        : tab === "sessions"
                          ? `${indexed} · ${sessions.indexScope ?? "No local index scope"}`
                          : tab === "runtime"
                            ? "Runtime observations only; no terminal is inferred."
                            : `${agent.name} · ${tab}`}
                </p>
              )}
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard access to the scrollable JSON document */}
              <pre key={`${tab}-${schema}`} tabIndex={0}>
                {json}
              </pre>
            </div>
            {footer}
          </section>
        )}
      </div>
    </li>
  );
}

function CliFlipCard({
  title,
  badge,
  header,
  reverse,
  children,
}: {
  title: string;
  badge?: string;
  header: ReactNode;
  reverse: ReactNode;
  children: ReactNode;
}) {
  const [back, setBack] = useState(false);
  const flip = useRef<HTMLButtonElement>(null);
  const id = useId();
  return (
    <section
      className={`cli-flipcard ${badge ? "cli-agentcard" : "cli-livetile"}`}
      aria-label={title}
      data-back={back}
      data-ui-action="inspect_details"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !back) return;
        event.stopPropagation();
        setBack(false);
        flip.current?.focus();
      }}
    >
      <header className="cli-flipcard-header">
        <div>{header}</div>
        <button
          ref={flip}
          type="button"
          className="quiet cli-flipcard-pill"
          data-ui-action="inspect_details"
          aria-label={`Flip ${title}`}
          aria-pressed={back}
          aria-controls={id}
          onClick={() => setBack((value) => !value)}
        >
          {badge && (
            <span className="cli-flipcard-badge" aria-hidden="true">
              {badge}
            </span>
          )}
          <span>{back ? "Front" : "Back"}</span>
        </button>
      </header>
      <div className="cli-flipcard-stage" id={id}>
        <div className="cli-flipcard-rotator">
          <div className="cli-flipcard-face" inert={back} aria-hidden={back}>
            {children}
          </div>
          <div
            className="cli-flipcard-face cli-flipcard-reverse"
            inert={!back}
            aria-hidden={!back}
          >
            {reverse}
          </div>
        </div>
      </div>
    </section>
  );
}

export function CopilotWorkspace({
  onBack,
  initialConversationAgentIds = [],
}: {
  onBack: () => void;
  initialConversationAgentIds?: readonly string[];
}) {
  const desktopWindow = useDesktopWindow();
  const { setAvailable, showWorkspace } = desktopWindow;
  const [surface, setSurface] = useState<WorkspaceSurface>("workspace");
  const [location, setLocation] = useState<CopilotWorkspaceLocation | null>(
    null,
  );
  const [locationInput, setLocationInput] = useState("");
  const [locationProblem, setLocationProblem] = useState<Problem | null>(null);
  const [resolvingLocation, setResolvingLocation] = useState(true);

  const [inventory, setInventory] = useState<CopilotInventory | null>(null);
  const [fleetPage, setFleetPage] = useState(0);
  const [fleetSearch, setFleetSearch] = useState("");
  const [refreshingCatalog, setRefreshingCatalog] = useState(false);
  const [catalogProblem, setCatalogProblem] = useState<Problem | null>(null);
  const [studioLinkStatus, setStudioLinkStatus] = useState("");
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
  const [dashboardId, setDashboardId] = useState<string | null>(null);
  const [dashboardProblem, setDashboardProblem] = useState<Problem | null>(
    null,
  );
  const evidence = useSessionEvidence();
  const sources = useHistorySources();
  const archive = useMemo(() => groupArchive(sources.index), [sources.index]);
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
  const [elicitations, setElicitations] = useState<CopilotElicitationRequest[]>(
    [],
  );

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
  const [sidepaneDisclosure, setSidepaneDisclosure] =
    useState<SidepaneDisclosure>(() => readSidepaneDisclosure());

  const [openDialog, setOpenDialog] = useState<DialogKind>(null);
  const [inspectedAgentId, setInspectedAgentId] = useState("");
  useEffect(() => {
    setAvailable(location !== null);
    return () => setAvailable(false);
  }, [location, setAvailable]);
  useEffect(() => {
    if (
      permissions.length > 0 ||
      elicitations.length > 0 ||
      openDialog !== null
    )
      showWorkspace();
  }, [permissions.length, elicitations.length, openDialog, showWorkspace]);
  const [resourceFilter, setResourceFilter] = useState("");
  const [sessionsPage, setSessionsPage] = useState<CopilotHistory | null>(null);
  const historyIndexScope = "all local folders";
  const allRows = useMemo(
    () => conversationHistoryRows(chats, sessionsPage?.sessions ?? []),
    [chats, sessionsPage],
  );
  const rowsByAgent = useMemo(() => groupWorkspaceChats(allRows), [allRows]);
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
  const compactions = useRef(new Map<string, CopilotCompaction>());
  const terminalSnapshots = useRef(new Map<string, CopilotTerminalOutput>());
  const toolTerminals = useRef(new Map<string, string[]>());
  const initialTerminalOutputs = useRef<CopilotTerminalOutput[]>([]);
  const conversationIdRef = useRef(activeConversationId);
  const operationRef = useRef(false);
  const mountedRef = useRef(true);
  const settingsDialogRef = useRef<HTMLDialogElement | null>(null);
  const profileDialogRef = useRef<HTMLDialogElement | null>(null);
  const resourcesDialogRef = useRef<HTMLDialogElement | null>(null);
  const conversationsDialogRef = useRef<HTMLDialogElement | null>(null);
  const importDialogRef = useRef<HTMLDialogElement | null>(null);
  const createAgentDialogRef = useRef<HTMLDialogElement | null>(null);
  const agentDialogRef = useRef<HTMLDialogElement | null>(null);
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

  /** Sidepane disclosure is presentation only: a failed save must never block the workspace. */
  useEffect(() => {
    try {
      writeSidepaneDisclosure(sidepaneDisclosure);
    } catch (error) {
      console.warn("Sidepane disclosure could not be saved.", error);
    }
  }, [sidepaneDisclosure]);

  const toggleAgentChats = useCallback((agentId: string, expanded: boolean) => {
    setSidepaneDisclosure((current) =>
      setSidepaneGroupExpanded(
        current,
        SIDEPANE_AGENT_LAYER,
        agentId || "copilot-cli",
        expanded,
      ),
    );
  }, []);

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
    if (dashboardId !== null) return;
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

  function applyCatalog(catalog: CopilotAgentCatalog) {
    setInventory((current) => ({
      ...(current ?? { skills: [], plugins: [], mcpServers: [] }),
      agents: catalog.agents,
      sources: catalog.sources ?? [],
      warnings: catalog.warnings,
    }));
  }

  async function refreshCatalog() {
    if (refreshingCatalog) return;
    setRefreshingCatalog(true);
    setCatalogProblem(null);
    try {
      const catalog = await invoke<CopilotAgentCatalog>("copilot_agents");
      if (mountedRef.current) applyCatalog(catalog);
    } catch (error) {
      if (mountedRef.current) setCatalogProblem(asProblem(error));
    } finally {
      if (mountedRef.current) setRefreshingCatalog(false);
    }
  }

  async function copyStudioLink(agent: CopilotAgentSummary) {
    setStudioLinkStatus("");
    try {
      await navigator.clipboard.writeText(studioAgentUrl(agent));
      setStudioLinkStatus(`Copied the Copilot Studio link for ${agent.name}.`);
    } catch (error) {
      setFailure(asProblem(error));
    }
  }

  async function rememberChat(
    next: CopilotSession,
    requestedAgent: string,
    conversationId: string,
    title?: string | null,
  ) {
    const option = findConfigOption(next.configOptions, "agent");
    const agentId = requestedAgent;
    let memoryProblem: Problem | null = null;
    if (
      chats.some(
        (chat) =>
          chat.agentId === agentId && chat.conversationId === conversationId,
      )
    ) {
      const owner = fleet.filter((agent) => agent.id === agentId);
      if (owner.length === 1) {
        try {
          await promoteDraft(
            fleetIdentity(owner[0]),
            conversationId,
            acpKey(next.sessionId),
          );
        } catch (error) {
          memoryProblem = {
            said: `Could not move draft review decisions to the recorded session. Existing memory was kept. ${asProblem(error).said}`,
          };
        }
      }
    }
    if (!mountedRef.current) return memoryProblem;
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
            sessionScope(item) !== sessionScope(chat),
        ),
      ];
    });
    return memoryProblem;
  }

  function selectWorkspaceAgent(agentId: string) {
    if (isStudioAgentId(agentId)) {
      openAgentSettings(agentId);
      return;
    }
    if (busy || operationRef.current) return;
    setDashboardId(agentId);
    setDashboardProblem(null);
    setSurface("workspace");
    setSessionsAllFolders(true);
    if (!historyRequestRef.current && (!sessionsPage || sessionsProblem)) {
      void fetchHistory(true);
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
      if (!mountedRef.current) return null;
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
        if (dashboardId !== null) setDashboardProblem(asProblem(error));
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
    compactions.current.clear();
    terminalSnapshots.current.clear();
    toolTerminals.current.clear();
    initialTerminalOutputs.current = [];
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

  function appendActivityOnce(key: string, text: string, raw?: unknown) {
    const id = nextMessageId.current++;
    setMessages((current) => {
      if (current.some((message) => message.activityKey === key)) {
        return raw === undefined
          ? current
          : current.map((message) =>
              message.activityKey === key ? { ...message, text, raw } : message,
            );
      }
      return [
        ...current,
        {
          id,
          role: "activity",
          text,
          activityKey: key,
          ...(raw === undefined ? {} : { raw }),
        },
      ];
    });
  }

  function appendOrMergeAssistantChunk(text: string, messageId?: string) {
    const newId = nextMessageId.current++;
    setMessages((current) => {
      if (messageId) {
        const found = current.find(
          (message) =>
            message.role === "assistant" &&
            message.protocolMessageId === messageId,
        );
        if (found)
          return current.map((message) =>
            message === found
              ? { ...message, text: message.text + text }
              : message,
          );
      }
      const last = current.at(-1);
      if (
        !messageId &&
        last &&
        !last.protocolMessageId &&
        last.role === "assistant" &&
        !last.raw
      ) {
        const next = [...current];
        next[next.length - 1] = { ...last, text: `${last.text}${text}` };
        return next;
      }
      return [
        ...current,
        { id: newId, role: "assistant", text, protocolMessageId: messageId },
      ];
    });
  }

  /** Mirrors appendOrMergeAssistantChunk for a replayed session's historical user turns: deltas
   * for the same turn coalesce into one bubble, and a new one starts once anything else (the
   * assistant's reply to that turn) lands in between. */
  function appendOrMergeUserChunk(text: string, messageId?: string) {
    const newId = nextMessageId.current++;
    setMessages((current) => {
      if (messageId) {
        const found = current.find(
          (message) =>
            message.role === "user" && message.protocolMessageId === messageId,
        );
        if (found)
          return current.map((message) =>
            message === found
              ? { ...message, text: message.text + text }
              : message,
          );
      }
      const last = current.at(-1);
      if (
        !messageId &&
        last &&
        !last.protocolMessageId &&
        last.role === "user" &&
        !last.raw
      ) {
        const next = [...current];
        next[next.length - 1] = { ...last, text: `${last.text}${text}` };
        return next;
      }
      return [
        ...current,
        { id: newId, role: "user", text, protocolMessageId: messageId },
      ];
    });
  }

  function appendToolCallMessage(
    toolCallId: string,
    update: Partial<CopilotToolActivity>,
  ) {
    const id =
      toolCallMessageIds.current.get(toolCallId) ?? nextMessageId.current++;
    toolCallMessageIds.current.set(toolCallId, id);
    const terminalIds = toolTerminals.current.get(toolCallId) ?? [];
    const terminals = terminalIds.flatMap((terminalId) => {
      const snapshot = terminalSnapshots.current.get(terminalId);
      return snapshot ? [snapshot] : [];
    });
    setMessages((current) => {
      current = current.filter(
        (message) =>
          !terminalIds.some(
            (terminalId) => message.activityKey === `terminal:${terminalId}`,
          ),
      );
      const previous = current.find((message) => message.id === id);
      const activity = mergeToolActivity(previous?.toolActivity, {
        ...update,
        ...(terminals.length ? { terminals } : {}),
      });
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

  function handleTerminalOutput(event: CopilotTerminalOutput) {
    if (
      !event ||
      typeof event.terminalId !== "string" ||
      typeof event.output !== "string" ||
      typeof event.truncated !== "boolean"
    ) {
      setFailure({
        said: "The native terminal returned an invalid output event.",
      });
      return;
    }
    const snapshot = { ...event, output: terminalDisplayText(event.output) };
    terminalSnapshots.current.set(event.terminalId, snapshot);
    let linked = false;
    for (const [toolCallId, ids] of toolTerminals.current) {
      if (ids.includes(event.terminalId)) {
        linked = true;
        appendToolCallMessage(toolCallId, {});
      }
    }
    if (!linked) {
      appendActivityOnce(
        `terminal:${event.terminalId}`,
        snapshot.exitStatus ? "Terminal exited" : "Terminal output",
        snapshot,
      );
    }
  }

  function handleSessionUpdate(update: Record<string, unknown>) {
    switch (updateKind(update)) {
      case "agent_message_chunk": {
        const text = updateText(update);
        if (text)
          appendOrMergeAssistantChunk(
            text,
            typeof update.messageId === "string" ? update.messageId : undefined,
          );
        else if (update.content)
          appendActivityOnce(
            `content:${nextMessageId.current}`,
            "Agent content",
            update.content,
          );
        break;
      }
      case "user_message_chunk": {
        // A live turn's echo is already shown optimistically the instant Send is pressed, so
        // only append here while replaying a loaded session, whose historical user turns have
        // no local echo yet.
        if (replayingSessionIdRef.current === sessionIdRef.current) {
          const text = updateText(update);
          if (text)
            appendOrMergeUserChunk(
              text,
              typeof update.messageId === "string"
                ? update.messageId
                : undefined,
            );
          else if (update.content)
            appendActivityOnce(
              `user-content:${nextMessageId.current}`,
              "User content",
              update.content,
            );
        }
        break;
      }
      case "agent_thought_chunk": {
        const text = updateText(update);
        const id = nextMessageId.current++;
        if (text) {
          setMessages((current) => {
            const last = current.at(-1);
            return last?.activityKey === "thinking" &&
              typeof last.raw === "string"
              ? [...current.slice(0, -1), { ...last, raw: last.raw + text }]
              : [
                  ...current,
                  {
                    id,
                    role: "activity",
                    text: "Agent activity",
                    activityKey: "thinking",
                    raw: text,
                  },
                ];
          });
        }
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        const toolCallId = String(update.toolCallId ?? "");
        if (!toolCallId) {
          setFailure({
            said: "An ACP tool update did not identify its tool call.",
          });
          break;
        }
        if (Array.isArray(update.content)) {
          const ids = update.content.flatMap((item: unknown) =>
            item &&
            typeof item === "object" &&
            "type" in item &&
            item.type === "terminal" &&
            "terminalId" in item &&
            typeof item.terminalId === "string"
              ? [item.terminalId]
              : [],
          );
          if (ids.length) toolTerminals.current.set(toolCallId, ids);
        }
        appendToolCallMessage(toolCallId, {
          title: typeof update.title === "string" ? update.title : undefined,
          status: typeof update.status === "string" ? update.status : undefined,
          input: update.rawInput,
          output: update.content ?? update.rawOutput,
          kind: typeof update.kind === "string" ? update.kind : undefined,
          locations: update.locations,
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
        appendActivityOnce("plan", "Plan", update);
        break;
      case "current_mode_update":
        if (typeof update.currentModeId === "string") {
          const mode = update.currentModeId;
          setConfigOptions((options) =>
            options.map((option) =>
              option.id === "mode" &&
              visibleConfigOptionValues(option).some(
                (value) => value.value === mode,
              )
                ? { ...option, currentValue: mode }
                : option,
            ),
          );
        }
        appendActivityOnce("current_mode_update", "Session mode", update);
        break;
      case "usage_update":
        appendActivityOnce("usage_update", "Context usage", update);
        break;
      case "notice":
        if (
          replayingSessionIdRef.current !== sessionIdRef.current &&
          typeof update.title === "string" &&
          typeof update.severity === "string"
        ) {
          appendActivityOnce(
            `notice:${nextMessageId.current}`,
            update.title,
            update,
          );
        }
        break;
      case "compaction_update":
      case "compaction_summary_chunk": {
        try {
          const previous =
            typeof update.compactionId === "string"
              ? compactions.current.get(update.compactionId)
              : undefined;
          const next = mergeCompaction(previous, update);
          compactions.current.set(next.compactionId, next);
          appendActivityOnce(
            `compaction:${next.compactionId}`,
            `Context compaction: ${next.status}`,
            next,
          );
        } catch (error) {
          setFailure(asProblem(error));
        }
        break;
      }
      default:
        break;
    }
  }

  const onSessionUpdate = useEffectEvent(handleSessionUpdate);
  const onTerminalOutput = useEffectEvent(handleTerminalOutput);

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
    const terminalOutputs = listen<CopilotTerminalOutput>(
      "copilot:terminal-output",
      (event) => {
        if (event.payload.sessionId !== sessionIdRef.current) {
          if (creatingSessionRef.current) {
            initialTerminalOutputs.current = [
              ...initialTerminalOutputs.current.filter(
                (output) =>
                  output.terminalId !== event.payload.terminalId ||
                  output.sessionId !== event.payload.sessionId,
              ),
              event.payload,
            ];
          }
          return;
        }
        onTerminalOutput(event.payload);
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
    const elicitationRequests = listen<CopilotElicitationRequest>(
      "copilot:elicitation-request",
      (event) => {
        if (!listening) return;
        if (
          event.payload.sessionId &&
          event.payload.sessionId !== sessionIdRef.current &&
          !creatingSessionRef.current
        )
          return;
        setElicitations((current) =>
          current.some((item) => item.requestId === event.payload.requestId)
            ? current
            : [...current, event.payload],
        );
      },
    );
    const elicitationClosed = listen<{ requestId: string }>(
      "copilot:elicitation-closed",
      (event) => {
        if (listening)
          setElicitations((current) =>
            current.filter(
              (item) => item.requestId !== event.payload.requestId,
            ),
          );
      },
    );
    const runtimeErrors = listen<Problem>("copilot:runtime-error", (event) => {
      setElicitations([]);
      if (!sessionIdRef.current && !creatingSessionRef.current) return;
      setFailure(event.payload);
      sessionIdRef.current = null;
      terminalSnapshots.current.clear();
      toolTerminals.current.clear();
      initialTerminalOutputs.current = [];
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
      terminalOutputs,
      permissionRequests,
      permissionClosed,
      elicitationRequests,
      elicitationClosed,
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
        terminalOutputs,
        permissionRequests,
        permissionClosed,
        elicitationRequests,
        elicitationClosed,
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
    setConfigOptions(sanitizeConfigOptions(options));
  }

  async function verifyOpenedSession(
    next: CopilotSession,
    chat: CopilotWorkspaceChat,
  ) {
    if (
      next.cwd === chat.cwd &&
      (!chat.sessionId || next.sessionId === chat.sessionId) &&
      (findConfigOption(next.configOptions, "agent")?.currentValue ??
        chat.agentId) === chat.agentId
    )
      return;
    sessionIdRef.current = null;
    await invoke("copilot_session_close", {
      sessionId: next.sessionId,
      agent: chat.agentId || null,
    });
    throw new Error(
      "Copilot returned a different agent, folder or session. Check the local CLI configuration before retrying.",
    );
  }

  async function startDraft(agentId: string) {
    if (isStudioAgentId(agentId)) {
      setFailure({
        said: "Open this agent in Copilot Studio. Cloud conversations are not local CLI sessions.",
      });
      openAgentSettings(agentId);
      return;
    }
    if (
      !location ||
      busy ||
      operationRef.current ||
      !savedWorkspace.ok ||
      localBlock(agentId)
    )
      return;
    operationRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      if (!(await closeSessionSafely())) return;
      setDashboardId(null);
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
    if (
      isStudioAgentId(chat.agentId) ||
      (chat.provider && chat.provider !== "copilot-cli")
    ) {
      setFailure({
        said: "This conversation cannot be routed to Copilot CLI.",
      });
      return null;
    }
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
      initialTerminalOutputs.current = [];
      const next = await invoke<CopilotSession>("copilot_session_new", {
        cwd: chat.cwd,
        agent: chat.agentId || null,
      });
      if (!mountedRef.current) return null;
      await verifyOpenedSession(next, chat);
      sessionIdRef.current = next.sessionId;
      setSession(next);
      setSessionAgentId(chat.agentId);
      applySessionConfig(next.configOptions ?? []);
      for (const event of initialUpdatesRef.current) {
        if (event.sessionId === next.sessionId)
          handleSessionUpdate(event.update);
      }
      for (const event of initialTerminalOutputs.current) {
        if (event.sessionId === next.sessionId) handleTerminalOutput(event);
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
      initialTerminalOutputs.current = [];
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
    if (
      !savedWorkspace.ok ||
      isStudioAgentId(target.agentId) ||
      localBlock(target.agentId) ||
      ((busy || operationRef.current) && !sending)
    )
      return null;
    if (!sending) operationRef.current = true;
    const record =
      "conversationId" in target
        ? target
        : (chats.find((item) => sessionScope(item) === sessionScope(target)) ??
          conversationFromHistory(target));
    const chat = record.conversationId.startsWith("record:")
      ? { ...record, conversationId: crypto.randomUUID() }
      : record;
    setSurface("workspace");
    if (
      chat.sessionId !== null &&
      chat.sessionId === session?.sessionId &&
      chat.agentId === sessionAgentId &&
      chat.cwd === session.cwd
    ) {
      setDashboardId(null);
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
    setDashboardProblem(null);
    try {
      const closed = await closeSessionSafely();
      if (!closed) return null;
      if (dashboardId !== null) setDashboardId(chat.agentId);
      selectConversation(chat);
      if (chat.sessionId === null) {
        const nextLocation = await resolveLocation(chat.cwd, true);
        if (!nextLocation)
          throw new Error(
            "The draft's folder could not be opened. Check that the recorded folder exists and retry.",
          );
        setOpenDialog(null);
        setDashboardId(null);
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
        agent: chat.agentId || null,
      });
      if (!mountedRef.current) return null;
      await verifyOpenedSession(next, chat);
      setSession(next);
      setSessionAgentId(chat.agentId);
      applySessionConfig(next.configOptions ?? []);
      const memoryProblem = await rememberChat(
        next,
        chat.agentId,
        chat.conversationId,
        chat.title,
      );
      if (!mountedRef.current) return null;
      if (memoryProblem) setFailure(memoryProblem);
      setPrompt(chat.draft);
      if (location) setLocation({ ...location, cwd: next.cwd });
      setLocationInput(next.cwd);
      writeStoredCwd(next.cwd);
      setOpenDialog(null);
      setDashboardId(null);
      setStatusText("Ready");
      return next;
    } catch (error) {
      if (mountedRef.current) {
        const problem = asProblem(error);
        sessionIdRef.current = null;
        setMessages([]);
        setPermissions((current) =>
          current.filter((request) => request.origin === "background"),
        );
        setAvailableCommands([]);
        toolCallMessageIds.current.clear();
        compactions.current.clear();
        terminalSnapshots.current.clear();
        toolTerminals.current.clear();
        initialTerminalOutputs.current = [];
        if (chat.sessionId !== null && isMissingRuntimeSession(problem)) {
          selectConversation({
            ...chat,
            sessionId: null,
          });
          setStatusText("Draft saved locally");
          setFailure({
            said: "Copilot could not reopen that runtime session. Darbot kept this chat as a local draft; send to start a new session.",
            detail: problem.detail ?? problem.said,
          });
          if (dashboardId !== null) setDashboardProblem(null);
        } else {
          setStatusText("Conversation not opened");
          setFailure(problem);
          if (dashboardId !== null) setDashboardProblem(problem);
        }
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
    if (dashboardId !== null) return;
    setSurface("workspace");
    insertTextAtCursor(`/${name} `);
    setOpenDialog(null);
  }

  async function sendPrompt() {
    const text = prompt.trim();
    if (
      !text ||
      dashboardId !== null ||
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
    const memoryProblem = await rememberChat(
      activeSession,
      chat.agentId,
      chat.conversationId,
      chat.title,
    );
    if (!mountedRef.current) {
      operationRef.current = false;
      return;
    }
    setSurface("workspace");
    const optimisticId = nextMessageId.current++;
    setPrompt("");
    setBusy(true);
    setFailure(memoryProblem);
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
          agent: chat.agentId || null,
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
    // Keep the all-folders ACP snapshot intact when the History dialog filters rows.
    setSessionsAllFolders(allFolders);
    setSessionsLoading(true);
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
        cwd: null,
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
    setSessionsAllFolders(true);
    if (
      !isStudioAgentId(agentId) &&
      !sessionsLoading &&
      (sessionsProblem || !sessionsPage)
    ) {
      void fetchHistory(true);
    }
  }

  function filterHistoryFolders(allFolders: boolean) {
    setSessionsAllFolders(allFolders);
    setHistoryAgent("__all__");
    setVisibleHistoryCount(50);
  }

  function openDialogFrom(kind: Exclude<DialogKind, null>) {
    if (kind === "create-agent") setAgentProblem(null);
    setOpenDialog(kind);
    if (kind === "conversations" && !sessionsLoading) {
      void fetchHistory(sessionsAllFolders);
    }
  }

  function openAgentSettings(agentId: string) {
    setInspectedAgentId(agentId);
    openDialogFrom("agent");
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
    void resolveLocation(activeConversation?.cwd ?? readStoredCwd());
  });
  const linkInitialHistory = useEffectEvent((agentIds?: readonly string[]) =>
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
      initialLinkStartedRef.current
    )
      return;
    initialLinkStartedRef.current = true;
    if (initialConversationAgentIds.length && !conversationIdRef.current)
      setSurface("canvas");
    void linkInitialHistory(
      initialConversationAgentIds.length
        ? initialConversationAgentIds
        : undefined,
    );
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
      ...inventory.agents
        .filter((agent) => !isStudioAgentId(agent.id))
        .map((agent) => agent.id),
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
      ["agent", agentDialogRef.current],
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
    if ((permissions.length > 0 || elicitations.length > 0) && !element.open)
      element.showModal();
    if (permissions.length === 0 && elicitations.length === 0 && element.open)
      element.close();
  }, [permissions.length, elicitations.length]);

  // Follows new messages only while the reader is already at the bottom, so nobody scrolled up
  // to re-read something earlier gets yanked back down mid-read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Appended messages and tab changes require remeasuring the scroll container.
  useEffect(() => {
    if (dashboardId !== null || !autoScrollEnabled || !stickToBottom) return;
    const container = messagesRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [messages, autoScrollEnabled, stickToBottom, surface, dashboardId]);

  const acpComplete =
    !!sessionsPage &&
    !sessionsLoading &&
    !sessionsProblem &&
    !sessionsPage.warnings.length &&
    !rowsByAgent.has("__unavailable__");
  const { index, loading: archiveLoading, failed: archiveFailed } = sources;
  const project = useMemo(() => {
    const cache = new Map<string, AgentHistory>();
    return (agent: CopilotAgentSummary, ambiguous: boolean) => {
      const key = JSON.stringify([
        fleetIdentity(agent),
        agent.id,
        agent.source?.tenantId,
        agent.source?.environmentId,
        agent.source?.botId,
        ambiguous,
      ]);
      let history = cache.get(key);
      if (!history) {
        history = projectAgentHistory(
          agent,
          ambiguous,
          rowsByAgent.get(agent.id) ?? [],
          sessionAgentId === agent.id ? (session?.sessionId ?? null) : null,
          archive,
          { index, failed: archiveFailed, loading: archiveLoading },
          acpComplete,
        );
        cache.set(key, history);
      }
      return history;
    };
  }, [
    rowsByAgent,
    sessionAgentId,
    session?.sessionId,
    archive,
    index,
    archiveFailed,
    archiveLoading,
    acpComplete,
  ]);

  if (!savedWorkspace.ok) {
    return (
      <main className="copilot-main">
        <div className="copilot-workspace copilot-repair">
          <Failure problem={savedWorkspace.problem} />
          <button
            type="button"
            data-ui-action="settings_open_setup"
            onClick={onBack}
          >
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
                    data-ui-action="settings_folder"
                    type="text"
                    value={locationInput}
                    onChange={(event) => setLocationInput(event.target.value)}
                    placeholder="C:\path\to\project"
                  />
                  <button
                    type="button"
                    data-ui-action="settings_folder"
                    onClick={() => void applyLocation()}
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    className="quiet"
                    data-ui-action="settings_browse_folder"
                    onClick={() => void browseLocation()}
                  >
                    Browse...
                  </button>
                  <button
                    type="button"
                    className="quiet"
                    data-ui-action="settings_reset_folder"
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
            [
              ...(inventory?.agents ?? []).filter(
                (agent) => !isStudioAgentId(agent.id),
              ),
              ...createdAgents,
            ].map((agent) => [agent.id, agent]),
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

  const effectiveAgentId =
    dashboardId ?? (session ? sessionAgentId : selectedAgentId);
  const currentAgent: CopilotAgentSummary =
    inventory?.agents.find((agent) => agent.id === effectiveAgentId) ??
    agentChoices.find((agent) => agent.id === effectiveAgentId) ??
    (effectiveAgentId
      ? { id: effectiveAgentId, name: effectiveAgentId }
      : DEFAULT_AGENT_CHOICE);
  const sidebarAgents = [
    ...new Set([
      "",
      ...importedAgentIds,
      ...(inventory?.agents ?? [])
        .filter((agent) => isStudioAgentId(agent.id))
        .map((agent) => agent.id),
      ...chats.map((chat) => chat.agentId),
    ]),
  ].map<CopilotAgentSummary>(
    (id) =>
      (isStudioAgentId(id)
        ? inventory?.agents.find((agent) => agent.id === id)
        : undefined) ??
      agentChoices.find((agent) => agent.id === id) ??
      createdAgents.find((agent) => agent.id === id) ?? {
        id,
        name: chats.find((chat) => chat.agentId === id)?.agentName ?? id,
      },
  );
  // The canvas is an inventory; sidebar imports remain a personal working set.
  const catalogAgents = [...createdAgents, ...(inventory?.agents ?? [])];
  const catalogIds = new Set(catalogAgents.map((a) => a.id));
  const fleet = [
    ...new Map(
      [
        ...[...agentChoices, ...sidebarAgents].filter(
          (a) => !catalogIds.has(a.id),
        ),
        ...catalogAgents,
      ].map((a) => [fleetIdentity(a), a]),
    ).values(),
  ];
  const runtimeCounts = new Map<string, number>();
  for (const agent of fleet)
    runtimeCounts.set(agent.id, (runtimeCounts.get(agent.id) ?? 0) + 1);
  function localBlock(id: string) {
    if (isStudioAgentId(id)) return "Open this cloud agent in Copilot Studio.";
    if (id === "__unavailable__")
      return "The recorded agent is unknown. Choose a known local agent for a new chat.";
    if ((runtimeCounts.get(id) ?? 0) > 1)
      return "Multiple local definitions share this runtime ID. Resolve the duplicate before opening a chat.";
    if (disabledAgentIds.has(id))
      return "The local CLI reports this agent is disabled. Enable it before opening a chat.";
    return null;
  }
  const activeChat = dashboardId === null ? activeConversation : undefined;
  const runtimeContext =
    session && sessionAgentId === effectiveAgentId
      ? [
          `Session ${session.sessionId} · ${session.cwd}`,
          `Commands: ${
            availableCommands
              .filter((c) => !HIDDEN_COMMAND_NAMES.has(c.name))
              .map((c) => c.name)
              .join(", ") || "none reported"
          }`,
          `Observed tool activity: ${[...new Set(messages.flatMap((m) => (m.toolActivity ? [m.toolActivity.title] : [])))].slice(0, 5).join(", ") || "none reported"}`,
          ...configOptions
            .filter((o) => o.id !== "agent")
            .map((o) => `${o.name ?? o.id}: ${o.currentValue}`),
        ].join(" · ")
      : null;
  const visibleStatus = dashboardId === null ? statusText : "Browsing history";
  const fleetQuery = fleetSearch.trim().toLowerCase();
  const matchingFleet = fleetQuery
    ? fleet.filter((a) =>
        [
          a.name,
          a.id,
          a.definition?.declaredId,
          a.definition?.file,
          a.source?.environmentName,
          fleetIdentity(a),
          fleetDisplayId(fleetIdentity(a)),
        ].some((value) => value?.toLowerCase().includes(fleetQuery)),
      )
    : fleet;
  const page = Math.min(
    fleetPage,
    Math.max(0, Math.ceil(matchingFleet.length / FLEET_PAGE_SIZE) - 1),
  );
  const pageStart = page * FLEET_PAGE_SIZE;
  const inspectedAgent =
    sidebarAgents.find((agent) => agent.id === inspectedAgentId) ??
    currentAgent;
  const inspectedChats = chatsByAgent.get(inspectedAgent.id) ?? [];
  const inspectedGroupId = inspectedAgent.id || "copilot-cli";
  const inspectedChatsExpanded =
    inspectedChats.length > 0 &&
    isSidepaneGroupExpanded(
      sidepaneDisclosure,
      SIDEPANE_AGENT_LAYER,
      inspectedGroupId,
      inspectedChats.some(
        (chat) => chat.conversationId === activeConversationId,
      ),
    );

  const currentPermission = permissions[0] ?? null;
  const currentElicitation = elicitations[0] ?? null;
  async function answerElicitation(
    action: "accept" | "decline" | "cancel",
    content?: Record<string, unknown>,
  ) {
    if (!currentElicitation)
      throw new Error("The agent request has already closed.");
    const requestId = currentElicitation.requestId;
    await invoke("copilot_elicitation_respond", {
      requestId,
      action,
      content: content ?? null,
    });
    setElicitations((current) =>
      current.filter((item) => item.requestId !== requestId),
    );
  }
  const historyQuery = historySearch.trim().toLowerCase();
  function historyFor(agent: CopilotAgentSummary) {
    return project(agent, (runtimeCounts.get(agent.id) ?? 0) > 1);
  }
  function dashboard(agent: CopilotAgentSummary, compact = false) {
    return (
      <AgentDashboard
        key={fleetIdentity(agent)}
        agent={agent}
        compact={compact}
        history={historyFor(agent)}
        sources={sources}
        busy={busy || !eventsReady}
        blocked={localBlock(agent.id)}
        loading={!isStudioAgentId(agent.id) && sessionsLoading}
        evidence={evidence}
        runtime={effectiveAgentId === agent.id ? runtimeContext : null}
        onContinue={(chat) => void loadSession(chat)}
        onNew={() => void startDraft(agent.id)}
        onHistory={() => openAgentHistory(agent.id)}
      />
    );
  }
  const historyRows = allRows.filter(
    (item) => sessionsAllFolders || item.cwd === workspace.cwd,
  );
  const historyAgents =
    openDialog === "conversations"
      ? [
          ...new Map([
            ...historyRows.map(
              (row) =>
                [
                  row.agentId,
                  { id: row.agentId, name: row.agentName },
                ] as const,
            ),
            ...fleet.map((agent) => [agent.id, agent] as const),
          ]).values(),
        ].sort((left, right) => left.name.localeCompare(right.name))
      : [];
  const filterAgent = historyAgents.find((a) => a.id === historyAgent);
  const filterProjection = filterAgent && historyFor(filterAgent);
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
  for (const command of runtimeContext ? availableCommands : []) {
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
  const conversationMessages = (dashboardId === null ? messages : []).filter(
    (message) => message.role !== "activity",
  );
  const activityMessages = (dashboardId === null ? messages : []).filter(
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
          data-ui-action="workspace_open_dialog"
          disabled={busy || sessionsLoading}
          onClick={() => openDialogFrom("import")}
        >
          Import agents
        </button>
        <button
          type="button"
          className="quiet"
          data-ui-action="workspace_link_history"
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
  const sessionConfiguration = (
    <section>
      <h3>Session configuration</h3>
      {session &&
      sessionAgentId === inspectedAgent.id &&
      (modelOption || reasoningOption || modeOption) ? (
        [modelOption, reasoningOption, modeOption].map((option) =>
          option ? (
            <Fragment key={option.id}>
              <label htmlFor={`copilot-config-${option.id}`}>
                {option.name ?? configOptionLabel(option.id)}
              </label>
              <select
                id={`copilot-config-${option.id}`}
                data-ui-action="settings_configure_session"
                value={option.currentValue}
                disabled={busy}
                onChange={(event) =>
                  void configureSession(option.id, event.target.value)
                }
              >
                {visibleConfigOptionValues(option).map((value) => (
                  <option
                    key={value.value}
                    value={value.value}
                    disabled={isConfigValueDisabled(value)}
                  >
                    {value.name}
                  </option>
                ))}
              </select>
            </Fragment>
          ) : null,
        )
      ) : (
        <p className="hint">
          Open this agent's conversation to see its negotiated model, reasoning
          and mode settings. These apply to that conversation, not the agent
          definition.
        </p>
      )}
    </section>
  );

  return (
    <main
      className={`copilot-main copilot-flip-stage${desktopWindow.front ? " is-front" : ""}`}
    >
      {desktopWindow.widget && (
        <section
          className="copilot-live-tile"
          aria-label="Live agent tile"
          inert={!desktopWindow.front}
          aria-hidden={!desktopWindow.front}
        >
          <div className="copilot-live-tile-header">
            <BrandLockup />
            <span className="copilot-runtime-state" role="status">
              {dashboardId === null && permissions.length > 0
                ? "Permission needed"
                : busy
                  ? "Working"
                  : visibleStatus}
            </span>
          </div>
          <h1>{currentAgent.name}</h1>
          <p className="copilot-live-tile-summary">
            {activeChat?.title ||
              currentAgent.description ||
              "Ready for your next task."}
          </p>
          <div className="copilot-live-tile-metrics">
            <span>{fleet.length.toLocaleString()} agents</span>
            <span>{chats.length.toLocaleString()} chats</span>
            <span>{activityMessages.length.toLocaleString()} activities</span>
          </div>
          <section
            className="copilot-live-tile-preview"
            aria-label="Latest response"
          >
            {[...conversationMessages]
              .reverse()
              .find((message) => message.role === "assistant")
              ?.text.slice(-320) ||
              (busy
                ? "The agent is working. Open chat to follow its activity."
                : "Open chat to continue this conversation.")}
          </section>
          {dashboardId === null && failure && (
            <InlineFailure problem={failure} />
          )}
          <nav className="copilot-live-tile-agents" aria-label="Widget agents">
            {sidebarAgents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className="quiet"
                data-ui-action="sidebar_select_agent"
                aria-pressed={effectiveAgentId === agent.id}
                disabled={busy}
                title={`${agent.name} / ${agentSourceLabel(agent)}`}
                onClick={() => void selectWorkspaceAgent(agent.id)}
              >
                <CopilotAgentIcon agent={agent} />
                {agent.name}
                {isStudioAgentId(agent.id) && (
                  <span className="copilot-agent-source">
                    {agent.source?.environmentName ?? "Source unavailable"}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <button
            type="button"
            data-ui-action="window_flip"
            onClick={showWorkspace}
          >
            Open chat
          </button>
        </section>
      )}
      <div
        className="copilot-workspace copilot-canvas-workspace"
        inert={desktopWindow.front}
        aria-hidden={desktopWindow.front}
      >
        <aside
          className="copilot-sidebar"
          aria-label={WORKSPACE_SIDEPANE.label}
        >
          <header className="copilot-sidebar-header">
            {renderSidepaneRegion("header", {
              brand: <BrandLockup />,
              compose: (
                <div className="copilot-sidebar-actions">
                  <button
                    type="button"
                    data-ui-action="workspace_open_dialog"
                    disabled={busy || !eventsReady}
                    onClick={() => openDialogFrom("create-agent")}
                  >
                    New agent
                  </button>
                  <button
                    type="button"
                    className="quiet"
                    data-ui-action="workspace_new_chat"
                    disabled={
                      busy || !eventsReady || !!localBlock(effectiveAgentId)
                    }
                    onClick={() => void startDraft(effectiveAgentId)}
                    title={`New chat with ${currentAgent.name}`}
                  >
                    New chat
                  </button>
                </div>
              ),
            })}
          </header>
          {renderSidepaneRegion("body", {
            agents: (
              <nav
                className="copilot-chat-navigation"
                aria-label={SIDEPANE_AGENT_LAYER.title}
                // biome-ignore lint/a11y/noNoninteractiveTabindex: Hidden scrollbar still needs keyboard access.
                tabIndex={0}
              >
                <h2>{SIDEPANE_AGENT_LAYER.title}</h2>
                {(linkingConversations || linkStatus) && (
                  <p className="copilot-chat-link-status" role="status">
                    {linkingConversations ? historyProgress : linkStatus}
                  </p>
                )}
                <ul className="copilot-sidebar-groups">
                  {sidebarAgents.map((agent, layer) => {
                    const agentChats = chatsByAgent.get(agent.id) ?? [];
                    const preview = previewAgentChats(
                      agentChats,
                      activeConversationId,
                    );
                    const groupId = agent.id || "copilot-cli";
                    const holdsActiveChat = agentChats.some(
                      (chat) => chat.conversationId === activeConversationId,
                    );
                    // An agent normally runs one conversation, so groups stay collapsed
                    // until asked for. The active group opens unless explicitly collapsed.
                    const chatsExpanded =
                      agentChats.length > 0 &&
                      isSidepaneGroupExpanded(
                        sidepaneDisclosure,
                        SIDEPANE_AGENT_LAYER,
                        groupId,
                        holdsActiveChat,
                      );
                    const chatsId = `copilot-agent-chats-${groupId}`;
                    const layerStyle: CSSProperties & {
                      "--agent-layer": number;
                    } = { "--agent-layer": sidebarAgents.length - layer };
                    return (
                      <li
                        key={groupId}
                        data-agent-id={agent.id}
                        style={layerStyle}
                      >
                        <div className="copilot-sidebar-agent">
                          <button
                            type="button"
                            className="quiet copilot-agent-icon-button"
                            data-ui-action="workspace_inspect_agent"
                            aria-label={`Settings for ${agent.name}`}
                            aria-haspopup="dialog"
                            title={`Settings for ${agent.name}`}
                            onClick={() => openAgentSettings(agent.id)}
                          >
                            <CopilotAgentIcon agent={agent} />
                          </button>
                          <button
                            type="button"
                            className="quiet copilot-agent-name"
                            data-ui-action="sidebar_select_agent"
                            aria-pressed={effectiveAgentId === agent.id}
                            disabled={busy}
                            title={`${agent.name} / ${agentSourceLabel(agent)}`}
                            onClick={() => void selectWorkspaceAgent(agent.id)}
                          >
                            {agent.name}
                            {isStudioAgentId(agent.id) && (
                              <span className="copilot-agent-source">
                                {agent.source?.environmentName ??
                                  "Source unavailable"}
                              </span>
                            )}
                          </button>
                          <button
                            type="button"
                            className="quiet copilot-chat-count"
                            data-ui-action="workspace_view_agent_history"
                            aria-label={`History sources for ${agent.name}: ${countLabel(historyFor(agent).summary)}`}
                            title={`${countLabel(historyFor(agent).summary)} · History sources`}
                            onClick={() => openAgentHistory(agent.id)}
                          >
                            {historyFor(agent).summary.known === null
                              ? "?"
                              : `${historyFor(agent).summary.coverage === "complete" ? "" : "≥"}${historyFor(agent).summary.known}`}
                          </button>
                        </div>
                        <ul
                          className="copilot-sidebar-chats"
                          id={chatsId}
                          hidden={!chatsExpanded}
                        >
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
                                data-ui-action="workspace_open_chat"
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
                                data-ui-action="workspace_view_agent_history"
                                onClick={() => openAgentHistory(agent.id)}
                              >
                                View all {agentChats.length.toLocaleString()}{" "}
                                chats
                              </button>
                            </li>
                          )}
                        </ul>
                      </li>
                    );
                  })}
                </ul>
              </nav>
            ),
          })}
          {renderSidepaneRegion("footer", {
            tools: (
              <div className="copilot-sidebar-tools">
                <button
                  type="button"
                  className="quiet"
                  data-ui-action="workspace_open_dialog"
                  onClick={() => openDialogFrom("resources")}
                >
                  Resources
                </button>
                <button
                  type="button"
                  className="quiet"
                  data-ui-action="workspace_open_dialog"
                  onClick={() => openDialogFrom("conversations")}
                >
                  History
                </button>
                <button
                  type="button"
                  className="quiet"
                  data-ui-action="workspace_open_dialog"
                  onClick={() => openDialogFrom("settings")}
                >
                  Settings
                </button>
                <button
                  type="button"
                  className="quiet"
                  data-ui-action="workspace_open_dialog"
                  onClick={() => openDialogFrom("profile")}
                >
                  Profile
                </button>
              </div>
            ),
          })}
        </aside>
        <section className="copilot-canvas" aria-label="Copilot workspace">
          <header className="copilot-canvas-header" data-surface={surface}>
            <h1 className="sr-only">Darbot with GitHub Copilot</h1>
            {desktopWindow.widget && (
              <button
                type="button"
                className="quiet copilot-agent-icon-button"
                data-ui-action="workspace_inspect_agent"
                aria-label={`Settings for ${currentAgent.name}`}
                aria-haspopup="dialog"
                title={`Settings for ${currentAgent.name}`}
                onClick={() => openAgentSettings(currentAgent.id)}
              >
                <CopilotAgentIcon agent={currentAgent} />
              </button>
            )}
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
                  data-ui-action="workspace_select_surface"
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
                    {dashboardId !== null
                      ? "Agent dashboard"
                      : session
                        ? currentAgent.name
                        : activeChat?.sessionId
                          ? "Open the saved conversation to continue"
                          : activeChat
                            ? "Draft saved locally; Copilot starts when you send"
                            : "Start a new conversation"}
                  </p>
                </div>
                <span className="copilot-runtime-state" aria-live="polite">
                  {busy
                    ? openingSession
                      ? "Opening"
                      : "Working"
                    : visibleStatus}
                </span>
              </div>
              {dashboardId === null && runtimeContext && (
                <details>
                  <summary data-ui-action="inspect_details">
                    Negotiated session context
                  </summary>
                  <p>{runtimeContext}</p>
                </details>
              )}
              {activeChat?.sessionId && !session && !busy && (
                <button
                  type="button"
                  className="quiet"
                  data-ui-action="workspace_open_chat"
                  disabled={!eventsReady || !!localBlock(activeChat.agentId)}
                  onClick={() => void loadSession(activeChat)}
                >
                  Open selected session: {activeChat.title}
                </button>
              )}
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
                  data-ui-action="workspace_scroll_messages"
                  onScroll={handleMessagesScroll}
                >
                  {dashboardId !== null ||
                  (activeChat?.sessionId && !session && !busy) ? (
                    <>
                      {dashboardId !== null && dashboardProblem && (
                        <InlineFailure problem={dashboardProblem} />
                      )}
                      {dashboardId !== null && dashboardProblem && (
                        <p>
                          Check that Copilot CLI supports this agent and folder,
                          then retry Continue or start a new draft.
                        </p>
                      )}
                      {sessionsProblem && (
                        <>
                          <InlineFailure problem={sessionsProblem} />
                          <button
                            type="button"
                            className="quiet"
                            data-ui-action="workspace_view_agent_history"
                            disabled={sessionsLoading}
                            onClick={() => {
                              setSessionsAllFolders(true);
                              void fetchHistory(true);
                            }}
                          >
                            Retry reading history
                          </button>
                        </>
                      )}
                      {dashboard(currentAgent)}
                    </>
                  ) : conversationMessages.length === 0 ? (
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
                    data-ui-action="workspace_jump_latest"
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
                  data-ui-action="workspace_select_surface"
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
                <h2>Agent fleet</h2>
                <p className="hint">
                  Local agents run in Copilot CLI. Configured cloud agents are
                  indexed here and opened in their own Copilot Studio
                  environment.
                </p>
                <button
                  type="button"
                  className="quiet"
                  data-ui-action="catalog_refresh"
                  disabled={refreshingCatalog}
                  onClick={() => void refreshCatalog()}
                >
                  {refreshingCatalog
                    ? "Refreshing agent sources..."
                    : "Refresh agent catalog"}
                </button>
                {catalogProblem && <InlineFailure problem={catalogProblem} />}
                {!!inventory?.sources?.length && (
                  <details>
                    <summary data-ui-action="inspect_details">
                      Environment coverage ({inventory.sources.length})
                    </summary>
                    <StudioSources sources={inventory.sources} />
                  </details>
                )}
                {studioLinkStatus && <p role="status">{studioLinkStatus}</p>}
                <div className="fleet-searchbar">
                  <label>
                    Find an agent
                    <input
                      type="search"
                      data-ui-action="workspace_filter_fleet"
                      value={fleetSearch}
                      onChange={(event) => {
                        setFleetSearch(event.target.value);
                        setFleetPage(0);
                      }}
                      placeholder="Name, ID or environment"
                    />
                  </label>
                  <p className="hint">
                    {matchingFleet.length} of {fleet.length} cards
                  </p>
                  {matchingFleet.length > FLEET_PAGE_SIZE && (
                    <nav aria-label="Fleet pages" className="fleet-toolbar">
                      <button
                        type="button"
                        className="quiet"
                        data-ui-action="fleet_page"
                        disabled={!page}
                        onClick={() => setFleetPage(page - 1)}
                      >
                        Previous
                      </button>
                      <span>
                        {pageStart + 1}–
                        {Math.min(
                          pageStart + FLEET_PAGE_SIZE,
                          matchingFleet.length,
                        )}
                      </span>
                      <button
                        type="button"
                        className="quiet"
                        data-ui-action="fleet_page"
                        disabled={
                          pageStart + FLEET_PAGE_SIZE >= matchingFleet.length
                        }
                        onClick={() => setFleetPage(page + 1)}
                      >
                        Next
                      </button>
                    </nav>
                  )}
                </div>
              </div>
              <ul className="copilot-agent-canvas" aria-label="Agent cards">
                {surface === "canvas" &&
                  matchingFleet
                    .slice(pageStart, pageStart + FLEET_PAGE_SIZE)
                    .map((agent) => {
                      return (
                        <FleetTile
                          key={fleetIdentity(agent)}
                          agent={agent}
                          history={historyFor(agent)}
                          build={() =>
                            buildFleetCard(
                              agent,
                              fleet,
                              savedWorkspace.ok ? chats : null,
                              sessionsPage,
                              historyIndexScope,
                              !sessionsLoading && !sessionsProblem,
                              inventory?.sources ?? [],
                              session
                                ? {
                                    agentId: sessionAgentId,
                                    sessionId: session.sessionId,
                                    model: modelOption?.currentValue,
                                  }
                                : undefined,
                              historyFor(agent).summary,
                            )
                          }
                          diagnostics={() => (
                            <ResourceDiagnostics
                              inventory={inventory}
                              agent={agent}
                              status={status}
                            />
                          )}
                          sessionActions={() => (
                            <>
                              {dashboard(agent, true)}
                              {isStudioAgentId(agent.id) && (
                                <button
                                  type="button"
                                  className="quiet"
                                  data-ui-action="studio_copy_link"
                                  disabled={!agent.source}
                                  onClick={() => void copyStudioLink(agent)}
                                >
                                  Copy Copilot Studio link
                                </button>
                              )}
                            </>
                          )}
                        />
                      );
                    })}
              </ul>
            </div>
            <div
              id="copilot-panel-cli"
              className="copilot-surface-panel copilot-cli-panel"
              role="tabpanel"
              aria-labelledby="copilot-tab-cli"
              hidden={surface !== "cli"}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: ARIA tab panels need a keyboard entry point for their scrollable content.
              tabIndex={0}
            >
              <CliFlipCard
                title="CLI AgentCard"
                badge="CLI"
                header={
                  <>
                    <h2 className="copilot-provider-label">
                      <span className="copilot-mark" aria-hidden="true" />
                      GitHub Copilot CLI
                    </h2>
                    <p className="hint">
                      Live tool activity and background SDK tools. This is not
                      an interactive shell.
                    </p>
                  </>
                }
                reverse={
                  <>
                    <h3>CLI AgentCard details</h3>
                    <dl className="cli-flipcard-facts">
                      <div>
                        <dt>Conversation activity</dt>
                        <dd>
                          {activityMessages.length.toLocaleString()} tool
                          activity entries
                        </dd>
                      </div>
                      <div>
                        <dt>Workspace folder</dt>
                        <dd>
                          {location?.cwd ?? "No workspace folder selected"}
                        </dd>
                      </div>
                    </dl>
                    <p className="hint">
                      Background SDK work runs separately from the active
                      conversation.
                    </p>
                  </>
                }
              >
                <div className="cli-livetile-grid">
                  <CliFlipCard
                    title="Live tool activity"
                    header={<h3>Live tool activity</h3>}
                    reverse={
                      <>
                        <h4>Activity scope</h4>
                        <p className="hint">
                          Shows tool updates received for the active
                          conversation, separate from chat. Tool output is shown
                          only when supplied by the CLI.
                        </p>
                      </>
                    }
                  >
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
                                <summary data-ui-action="inspect_details">
                                  Tool output and details
                                </summary>
                                <pre>{formatRawPayload(message.raw)}</pre>
                              </details>
                            )}
                          </li>
                        ))}
                      </ol>
                    )}
                  </CliFlipCard>
                  {location && (
                    <CliFlipCard
                      title="Background SDK"
                      header={<h3>Background SDK</h3>}
                      reverse={
                        <>
                          <h4>SDK scope</h4>
                          <dl className="cli-flipcard-facts">
                            <div>
                              <dt>Workspace folder</dt>
                              <dd>{location.cwd}</dd>
                            </div>
                            <div>
                              <dt>Runtime</dt>
                              <dd>Signed-in Copilot CLI profile</dd>
                            </div>
                          </dl>
                          <p className="hint">
                            Agent tasks, plugin inventory and remote session
                            discovery use the separate SDK connection.
                          </p>
                        </>
                      }
                    >
                      <CopilotExtensionsPanel cwd={location.cwd} />
                    </CliFlipCard>
                  )}
                </div>
              </CliFlipCard>
            </div>
            <div className="copilot-composer" hidden={dashboardId !== null}>
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
                  data-ui-action="workspace_open_dialog"
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
                  data-ui-action="workspace_edit_draft"
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
                  data-ui-action="workspace_open_dialog"
                  onClick={() => openDialogFrom("settings")}
                >
                  Settings
                </button>
                <span className="copilot-composer-hint">
                  Enter to send, Shift+Enter for a new line
                </span>
                <button
                  type="button"
                  data-ui-action="workspace_send_prompt"
                  onClick={() => void sendPrompt()}
                  disabled={busy || !eventsReady || !prompt.trim()}
                >
                  Send
                </button>
                {busy && session && (
                  <button
                    type="button"
                    className="quiet"
                    data-ui-action="workspace_cancel_prompt"
                    onClick={() => void cancelPrompt()}
                  >
                    Stop
                  </button>
                )}
              </div>
            </div>
            {dashboardId === null &&
              inventory &&
              inventory.warnings.length > 0 && (
                <details className="copilot-runtime-warnings">
                  <summary data-ui-action="inspect_details">
                    Copilot resource warnings
                  </summary>
                  <ul>
                    {[...new Set(inventory.warnings)].map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </details>
              )}
            {dashboardId === null && failure && (
              <>
                <Failure problem={failure} />
                {activeChat && !session && !busy && (
                  <p className="hint">
                    Check that the folder exists and Copilot CLI supports this
                    agent. Your draft is still saved locally.
                  </p>
                )}
              </>
            )}
            {failure && activeChat?.sessionId && !session && !busy && (
              <button
                type="button"
                className="quiet"
                data-ui-action="workspace_retry_chat"
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
        data-ui-action="workspace_close_dialog"
        className="copilot-dialog copilot-dialog-wide"
        aria-labelledby="copilot-import-title"
        onClose={() => handleDialogClosed("import")}
      >
        <div className="copilot-dialog-body">
          {openDialog === "import" && (
            <CopilotAgentImport
              existingIds={importedAgentIds}
              onCatalogLoaded={applyCatalog}
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
        data-ui-action="workspace_close_dialog"
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
            data-ui-action="workspace_close_dialog"
            disabled={creatingAgent}
            onClick={() => setOpenDialog(null)}
          >
            Cancel
          </button>
        </div>
        <form
          className="copilot-dialog-body"
          data-ui-action="workspace_create_agent"
          onSubmit={(event) => {
            event.preventDefault();
            void createAgent();
          }}
        >
          <section>
            <label htmlFor="copilot-new-agent-name">Agent name</label>
            <input
              id="copilot-new-agent-name"
              data-ui-action="workspace_edit_agent_name"
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
              data-ui-action="workspace_edit_agent_description"
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
              data-ui-action="workspace_edit_agent_instructions"
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
            data-ui-action="workspace_create_agent"
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
        data-ui-action="workspace_close_dialog"
        className="copilot-dialog"
        aria-labelledby="copilot-settings-title"
        onClose={() => handleDialogClosed("settings")}
      >
        <div className="copilot-dialog-header">
          <h2 id="copilot-settings-title">Settings</h2>
          <button
            type="button"
            className="quiet"
            data-ui-action="workspace_close_dialog"
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
              data-ui-action="settings_theme"
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
                data-ui-action="settings_auto_scroll"
                checked={autoScrollEnabled}
                onChange={(event) => changeAutoScroll(event.target.checked)}
              />
              Automatically follow new messages
            </label>
            <label className="copilot-checkbox-row">
              <input
                type="checkbox"
                data-ui-action="settings_snap_scroll"
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
                data-ui-action="settings_folder"
                type="text"
                value={locationInput}
                disabled={busy}
                onChange={(event) => setLocationInput(event.target.value)}
              />
              <button
                type="button"
                data-ui-action="settings_folder"
                disabled={busy}
                onClick={() => void applyLocation()}
              >
                Apply
              </button>
              <button
                type="button"
                className="quiet"
                data-ui-action="settings_browse_folder"
                disabled={busy}
                onClick={() => void browseLocation()}
              >
                Browse...
              </button>
            </div>
            <p className="copilot-folder-home">Home: {workspace.home}</p>
            {locationProblem && <InlineFailure problem={locationProblem} />}
          </section>
          <section>
            <h3>Agent configuration</h3>
            <button
              type="button"
              className="quiet"
              data-ui-action="workspace_inspect_agent"
              onClick={() => openAgentSettings(currentAgent.id)}
            >
              {currentAgent.name} settings
            </button>
          </section>
        </div>
      </dialog>

      <dialog
        ref={agentDialogRef}
        data-ui-action="workspace_close_dialog"
        className="copilot-dialog copilot-agent-dialog"
        aria-labelledby="copilot-agent-settings-title"
        onClose={() => handleDialogClosed("agent")}
      >
        <div className="copilot-dialog-header">
          <CopilotAgentIcon agent={inspectedAgent} />
          <h2 id="copilot-agent-settings-title">{inspectedAgent.name}</h2>
          <button
            type="button"
            className="quiet"
            data-ui-action="workspace_close_dialog"
            onClick={() => setOpenDialog(null)}
          >
            Close
          </button>
        </div>
        <div className="copilot-dialog-body">
          <section>
            <label htmlFor="copilot-inspected-agent">Agent</label>
            <select
              id="copilot-inspected-agent"
              data-ui-action="workspace_inspect_agent"
              value={inspectedAgent.id}
              onChange={(event) => setInspectedAgentId(event.target.value)}
            >
              {sidebarAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
            <p>{inspectedAgent.description || "No description provided."}</p>
            <p className="hint">{agentSourceLabel(inspectedAgent)}</p>
            {inspectedAgent.source && (
              <StudioSources
                sources={(inventory?.sources ?? []).filter(
                  (source) =>
                    source.tenantId === inspectedAgent.source?.tenantId &&
                    source.environmentId ===
                      inspectedAgent.source?.environmentId,
                )}
              />
            )}
            <HistorySources
              history={historyFor(inspectedAgent)}
              sources={sources}
            />
            {inspectedAgent.model && (
              <p className="hint">{inspectedAgent.model}</p>
            )}
            <div className="row">
              {isStudioAgentId(inspectedAgent.id) ? (
                <div>
                  <p>
                    Catalog reference only. Use Copilot Studio for this agent;
                    cloud transcripts have not been imported.
                  </p>
                  {inspectedAgent.source && (
                    <p className="hint">{studioAgentUrl(inspectedAgent)}</p>
                  )}
                  <button
                    type="button"
                    className="quiet"
                    data-ui-action="studio_copy_link"
                    disabled={!inspectedAgent.source}
                    onClick={() => void copyStudioLink(inspectedAgent)}
                  >
                    Copy Copilot Studio link
                  </button>
                  <p role="status">{studioLinkStatus}</p>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    data-ui-action="workspace_new_chat"
                    disabled={
                      busy ||
                      !eventsReady ||
                      disabledAgentIds.has(inspectedAgent.id)
                    }
                    onClick={() => {
                      setOpenDialog(null);
                      void startDraft(inspectedAgent.id);
                    }}
                  >
                    New chat with {inspectedAgent.name}
                  </button>
                  <button
                    type="button"
                    className="quiet"
                    data-ui-action="sidebar_select_agent"
                    disabled={busy || !eventsReady}
                    onClick={() => {
                      setOpenDialog(null);
                      void selectWorkspaceAgent(inspectedAgent.id);
                    }}
                  >
                    View agent dashboard
                  </button>
                  <button
                    type="button"
                    className="quiet"
                    data-ui-action="workspace_view_agent_history"
                    onClick={() => openAgentHistory(inspectedAgent.id)}
                  >
                    History
                  </button>
                  <button
                    type="button"
                    className="quiet"
                    data-ui-action="sidebar_toggle_chats"
                    aria-expanded={inspectedChatsExpanded}
                    aria-controls={`copilot-agent-chats-${inspectedGroupId}`}
                    disabled={inspectedChats.length === 0}
                    onClick={() => {
                      toggleAgentChats(
                        inspectedAgent.id,
                        !inspectedChatsExpanded,
                      );
                      setOpenDialog(null);
                    }}
                  >
                    {inspectedChatsExpanded ? "Hide" : "Show"}{" "}
                    {inspectedAgent.name} chats
                  </button>
                </>
              )}
            </div>
          </section>
          {!isStudioAgentId(inspectedAgent.id) && sessionConfiguration}
          {openDialog === "agent" && failure && (
            <InlineFailure problem={failure} />
          )}
        </div>
      </dialog>

      <dialog
        ref={profileDialogRef}
        data-ui-action="workspace_close_dialog"
        className="copilot-dialog"
        aria-labelledby="copilot-profile-title"
        onClose={() => handleDialogClosed("profile")}
      >
        <div className="copilot-dialog-header">
          <h2 id="copilot-profile-title">Profile</h2>
          <button
            type="button"
            className="quiet"
            data-ui-action="workspace_close_dialog"
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
              data-ui-action="workspace_open_dialog"
              onClick={() => openAgentSettings(currentAgent.id)}
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
                    <summary data-ui-action="inspect_details">Warnings</summary>
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
              data-ui-action="settings_open_setup"
              disabled={busy}
              onClick={() => void handleBack()}
            >
              Open deployment setup
            </button>
          </section>
          <details className="detail-of">
            <summary data-ui-action="inspect_details">
              GitHub Copilot icon license
            </summary>
            <pre>{copilotIconLicense}</pre>
          </details>
        </div>
      </dialog>

      <dialog
        ref={resourcesDialogRef}
        data-ui-action="workspace_close_dialog"
        className="copilot-dialog copilot-dialog-wide"
        aria-labelledby="copilot-resources-title"
        onClose={() => handleDialogClosed("resources")}
      >
        <div className="copilot-dialog-header">
          <h2 id="copilot-resources-title">Resources</h2>
          <button
            type="button"
            className="quiet"
            data-ui-action="workspace_close_dialog"
            onClick={() => setOpenDialog(null)}
          >
            Close
          </button>
        </div>
        <div className="copilot-dialog-body">
          {openDialog === "resources" && (
            <ResourceDiagnostics inventory={inventory} status={status} />
          )}
          <label htmlFor="copilot-resource-filter">Search skills</label>
          <input
            id="copilot-resource-filter"
            data-ui-action="workspace_filter_resources"
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
                    data-ui-action="workspace_insert_resource"
                    disabled={
                      dashboardId !== null ||
                      !resource.enabled ||
                      busy ||
                      !eventsReady
                    }
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
              <summary data-ui-action="inspect_details">
                Plugins ({inventory.plugins.length})
              </summary>
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
              <summary data-ui-action="inspect_details">
                MCP servers ({inventory.mcpServers.length})
              </summary>
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
              <summary data-ui-action="inspect_details">Warnings</summary>
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
        data-ui-action="workspace_close_dialog"
        className="copilot-dialog copilot-dialog-wide"
        aria-labelledby="copilot-history-agents-title copilot-conversations-title"
        onClose={() => handleDialogClosed("conversations")}
      >
        <div className="copilot-dialog-header">
          <h2 id="copilot-history-agents-title">Agents</h2>
          <button
            type="button"
            className="quiet"
            data-ui-action="workspace_close_dialog"
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
              data-ui-action="history_select_agent"
              value={historyAgent}
              onChange={(event) => {
                setHistoryAgent(event.target.value);
                setVisibleHistoryCount(50);
              }}
            >
              <option value="__all__">
                All agents · ACP records and drafts
              </option>
              {historyAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} · {countLabel(historyFor(agent).summary)}
                </option>
              ))}
            </select>
            <p className="hint">
              Recorded conversations keep their initial agent. Local drafts stay
              on this device and start Copilot only when you send.
            </p>
            {filterProjection && (
              <HistorySources
                key={historyAgent}
                history={filterProjection}
                sources={sources}
                expanded
              />
            )}
          </section>
          <h3 id="copilot-conversations-title">Conversations</h3>
          <label className="copilot-checkbox-row">
            <input
              type="checkbox"
              data-ui-action="history_scope_folders"
              checked={sessionsAllFolders}
              disabled={sessionsLoading}
              onChange={(event) => filterHistoryFolders(event.target.checked)}
            />
            Show conversations from all folders
          </label>
          <label htmlFor="copilot-history-search">Search conversations</label>
          <input
            id="copilot-history-search"
            data-ui-action="history_search"
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
              {filteredHistory.length.toLocaleString()} matching ACP records and
              local drafts
            </p>
          )}
          {sessionsPage?.timings && (
            <details className="detail-of">
              <summary data-ui-action="inspect_details">
                History indexing timings
              </summary>
              <p>
                Connection: {sessionsPage.timings.connectionMs} ms. Listing:{" "}
                {sessionsPage.timings.listingMs} ms. Agent metadata:{" "}
                {sessionsPage.timings.indexingMs} ms. First batch:{" "}
                {sessionsPage.timings.firstPageMs ?? "no conversations"} ms.
                Total: {sessionsPage.timings.totalMs} ms.
              </p>
            </details>
          )}
          {filterAgent &&
            filterProjection &&
            (sessionsAllFolders ? (
              <ArchiveTiles
                key={fleetIdentity(filterAgent)}
                identity={fleetIdentity(filterAgent)}
                summary={filterProjection.summary}
                rows={filterProjection.archiveOnly.filter(
                  (row) =>
                    !historyQuery ||
                    [row.id, ...row.sourceIds, filterAgent.name].some((s) =>
                      s.toLowerCase().includes(historyQuery),
                    ),
                )}
              />
            ) : (
              <p className="hint">
                Archive references have no verified folder and are excluded by
                this filter.
              </p>
            ))}
          <ul className="copilot-resource-list copilot-resource-list-plain">
            {filteredHistory.length === 0 && !sessionsLoading ? (
              <li>
                No available ACP records or drafts match this agent, folder and
                search.
              </li>
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
                    data-ui-action="workspace_open_chat"
                    disabled={
                      busy || !eventsReady || !!localBlock(item.agentId)
                    }
                    onClick={() => void loadSession(item)}
                  >
                    {item.sessionId !== null &&
                    item.sessionId === session?.sessionId &&
                    item.agentId === sessionAgentId &&
                    item.cwd === session.cwd
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
              data-ui-action="history_load_more"
              disabled={sessionsLoading}
              onClick={() => setVisibleHistoryCount((count) => count + 50)}
            >
              Load more
            </button>
          )}
          {!!sessionsPage?.warnings.length && (
            <details className="copilot-runtime-warnings">
              <summary data-ui-action="inspect_details">
                History metadata warnings
              </summary>
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
        data-ui-action="workspace_permission_decide"
        className="copilot-dialog"
        aria-labelledby="copilot-permission-title"
        onCancel={(event) => {
          event.preventDefault();
          if (currentPermission) void answerPermission(currentPermission, null);
          else if (currentElicitation)
            void answerElicitation("cancel").catch((error) =>
              setFailure(asProblem(error)),
            );
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
                <summary data-ui-action="inspect_details">
                  Requested action details
                </summary>
                <pre>{formatRawPayload(currentPermission.toolCall)}</pre>
              </details>
              <div className="row">
                {currentPermission.options.map((option) => (
                  <button
                    type="button"
                    key={option.optionId}
                    data-ui-action="workspace_permission_decide"
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
                  data-ui-action="workspace_permission_decide"
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
        {!currentPermission && currentElicitation && (
          <ElicitationReview
            key={currentElicitation.requestId}
            request={currentElicitation}
            onRespond={answerElicitation}
          />
        )}
      </dialog>
    </main>
  );
}
