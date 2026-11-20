import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  fleetIdentity,
  studioAgentId,
  type CopilotAgentSummary,
  type CopilotSession,
  type CopilotStatus,
  type StudioAgentSource,
  type StudioSourceStatus,
} from "./copilot-types";
import {
  createConversationDraft,
  emptyConversationWorkspace,
  readConversationWorkspace,
  WORKSPACE_STORAGE_KEY,
  writeConversationWorkspace,
} from "./copilot-workspace-store";
import {
  makeFlashcard,
  parseFlashcard,
  type Feedback,
  type Flashcard,
} from "./agent-flashcard";
import { writeImportedAgentIds } from "./copilot-preferences";
import type { HistoryIndex } from "./history-sources";
import type { HarvestMutation } from "./session-harvest";

type Invocation = { command: string; args?: unknown };
type Listener = (event: { payload: unknown }) => void;
const listeners = new Map<string, Set<Listener>>();
let calls: Invocation[] = [];
let invokeHandler: (command: string, args?: unknown) => Promise<unknown>;
let runtimeSequence = 0;
const nativeLedgers = new Map<string, string>();
type TestLedger = {
  version: 1;
  decisions: [string, Feedback][];
  references: Flashcard[];
};
const emptyLedger = () =>
  JSON.stringify({ version: 1, decisions: [], references: [] });

const core = await import("@tauri-apps/api/core");
const events = await import("@tauri-apps/api/event");
const app = await import("@tauri-apps/api/app");
const windows = await import("@tauri-apps/api/window");

mock.module("@tauri-apps/api/core", () => ({
  ...core,
  invoke: (command: string, args?: unknown) => {
    calls.push({ command, args });
    return invokeHandler(command, args);
  },
}));
mock.module("@tauri-apps/api/event", () => ({
  ...events,
  listen: async (name: string, callback: Listener) => {
    const registered = listeners.get(name) ?? new Set<Listener>();
    registered.add(callback);
    listeners.set(name, registered);
    return () => {
      registered.delete(callback);
    };
  },
}));
mock.module("@tauri-apps/api/app", () => ({
  ...app,
  getVersion: async () => "test",
}));
mock.module("@tauri-apps/api/window", () => ({
  ...windows,
  getCurrentWindow: () => ({ setTheme: async () => {} }),
}));

const { CopilotWorkspace } = await import("./CopilotWorkspace");
const { DesktopWindow } = await import("./DesktopWindow");
const { CopilotExtensionsPanel, ElicitationReview } = await import(
  "./CopilotExtensionsPanel"
);
const { createHarvestStore, draftKey, sessionKey } = await import(
  "./session-harvest"
);

function argument(args: unknown, key: string): string | null {
  if (!args || typeof args !== "object" || !(key in args)) return null;
  const value = Object.entries(args).find(([name]) => name === key)?.[1];
  return typeof value === "string" ? value : null;
}

function emit(name: string, payload: unknown) {
  for (const listener of listeners.get(name) ?? []) listener({ payload });
}

function mutateNativeLedger(agent: string, mutation: HarvestMutation) {
  const raw = nativeLedgers.get(agent);
  if (mutation.kind === "migrate") {
    if (raw === undefined) nativeLedgers.set(agent, mutation.ledger);
  } else {
    const ledger: TestLedger = JSON.parse(raw ?? emptyLedger());
    const decisions = new Map(ledger.decisions);
    switch (mutation.kind) {
      case "toggle-decision": {
        const previous = decisions.get(mutation.row) ?? {
          pinned: false,
          reviewed: false,
          dismissed: false,
        };
        const next = {
          ...previous,
          [mutation.field]: !previous[mutation.field],
        };
        if (Object.values(next).some(Boolean))
          decisions.set(mutation.row, next);
        else decisions.delete(mutation.row);
        break;
      }
      case "promote-draft": {
        const from = draftKey(mutation.conversation);
        const to = sessionKey(mutation.canonicalSession);
        const pending = decisions.get(from);
        if (pending) {
          if (!decisions.has(to)) decisions.set(to, pending);
          decisions.delete(from);
        }
        break;
      }
      case "keep-reference":
        if (
          !ledger.references.some(
            (card) => JSON.stringify(card) === mutation.card,
          )
        )
          ledger.references.push(parseFlashcard(mutation.card));
        break;
      case "forget-reference":
        ledger.references = ledger.references.filter(
          (card) => JSON.stringify(card) !== mutation.card,
        );
        break;
    }
    nativeLedgers.set(
      agent,
      JSON.stringify({ ...ledger, decisions: [...decisions] }),
    );
  }
  const result = nativeLedgers.get(agent);
  if (result === undefined) throw new Error("Test ledger was not written.");
  return result;
}

function session(sessionId: string, agent = ""): CopilotSession {
  return {
    sessionId,
    cwd: "C:\\workspace",
    configOptions: [
      {
        id: "agent",
        currentValue: agent,
        options: [
          { value: "", name: "Copilot CLI" },
          { value: "architect", name: "Architect" },
        ],
      },
    ],
  };
}

const status: CopilotStatus = {
  version: "test",
  protocolVersion: 1,
  authentication: "ready",
  capabilities: {
    loadSession: true,
    resumeSession: true,
    listSessions: true,
    closeSession: true,
    deleteSession: false,
    promptImage: false,
    promptEmbeddedContext: false,
    mcpHttp: false,
    mcpSse: false,
  },
  sessionCount: 0,
  hasMoreSessions: false,
  warnings: [],
};

async function standardInvoke(
  command: string,
  args?: unknown,
): Promise<unknown> {
  switch (command) {
    case "harvest_ledger_read":
      return nativeLedgers.get(argument(args, "agentKey") ?? "") ?? null;
    case "harvest_ledger_mutate": {
      if (!args || typeof args !== "object" || !("mutation" in args))
        throw new Error("Missing Harvest mutation.");
      const agent = argument(args, "agentKey");
      if (!agent) throw new Error("Missing Harvest owner.");
      const result = mutateNativeLedger(
        agent,
        args.mutation as HarvestMutation,
      );
      emit("darbot:harvest-changed", agent);
      return result;
    }
    case "desktop_window_state":
      return { widget: false, pinned: false, wide: false };
    case "desktop_window_present":
      return args;
    case "copilot_workspace":
      return {
        cwd: argument(args, "cwd") ?? "C:\\workspace",
        home: "C:\\workspace",
      };
    case "copilot_status":
      return status;
    case "copilot_inventory":
      return {
        agents: [{ id: "architect", name: "Architect" }],
        skills: [],
        plugins: [],
        mcpServers: [],
        warnings: [],
      };
    case "copilot_history":
      return { sessions: [], agents: [], warnings: [] };
    case "history_sources_index":
      return {
        schemaVersion: 1,
        scannedAt: "2026-11-17T00:00:00Z",
        sources: [],
        sessions: [],
      };
    case "copilot_session_new":
      return session(
        `runtime-${++runtimeSequence}`,
        argument(args, "agent") ?? "",
      );
    case "copilot_session_load":
      return session(
        argument(args, "sessionId") ?? "missing",
        argument(args, "agent") ?? "",
      );
    case "copilot_session_prompt":
      emit("copilot:session-update", {
        sessionId: argument(args, "sessionId"),
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Unit-test reply" },
        },
      });
      return { stopReason: "end_turn" };
    case "copilot_session_close":
    case "copilot_session_cancel":
    case "copilot_permission_respond":
      return null;
    default:
      throw new Error(`Unexpected unit-test invocation: ${command}`);
  }
}

beforeAll(() => GlobalRegistrator.register());
beforeEach(() => {
  localStorage.clear();
  nativeLedgers.clear();
  calls = [];
  listeners.clear();
  runtimeSequence = 0;
  invokeHandler = standardInvoke;
});
afterEach(async () => {
  cleanup();
  await act(async () => {});
});
afterAll(() => GlobalRegistrator.unregister());

async function workspace() {
  const view = render(<CopilotWorkspace onBack={() => {}} />);
  // The composer can become ready before the separate catalog effect has settled.
  await waitFor(() =>
    expect(calls.some((c) => c.command === "copilot_inventory")).toBe(true),
  );
  await waitFor(() =>
    expect(
      view
        .getByRole("button", {
          name: "New chat",
        })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  return view;
}

function saved() {
  const result = readConversationWorkspace();
  if (!result.ok) throw new Error(result.problem.said);
  return result.workspace;
}

function draftInput(view: ReturnType<typeof render>, agent = "Copilot CLI") {
  const element = view.getByRole("textbox", { name: `Message ${agent}` });
  if (!(element instanceof HTMLTextAreaElement)) {
    throw new Error("The native composer must be a textarea.");
  }
  return element;
}

async function clickHarvest(
  scope: ReturnType<typeof within>,
  name: string,
  next: string,
) {
  const button = await scope.findByRole("button", { name });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  fireEvent.click(button);
  await waitFor(() =>
    expect(
      scope.getByRole("button", { name: next }).hasAttribute("disabled"),
    ).toBe(false),
  );
}

test("the CLI AgentCard and its LiveTiles flip independently without losing an SDK task draft", async () => {
  invokeHandler = (command, args) =>
    command === "copilot_extensions_status"
      ? Promise.resolve({
          schemaVersion: 1,
          sdkVersion: "test",
          runtimeVersion: "test",
          protocolVersion: 3,
          connectionId: "test",
          sessionId: "test",
          cwd: "C:\\workspace",
          memoryEnabled: false,
          agents: {
            state: "available",
            data: [{ id: "architect", name: "Architect" }],
          },
          tasks: { state: "available", data: [] },
          plugins: { state: "available", data: [] },
        })
      : standardInvoke(command, args);

  const view = await workspace();
  fireEvent.click(view.getByRole("tab", { name: "Your CLI" }));
  const cli = within(view.getByRole("tabpanel", { name: "Your CLI" }));
  const card = within(cli.getByRole("region", { name: "CLI AgentCard" }));
  const shellFlip = card.getByRole("button", { name: "Flip CLI AgentCard" });
  const activityFlip = card.getByRole("button", {
    name: "Flip Live tool activity",
  });
  const sdkFlip = card.getByRole("button", { name: "Flip Background SDK" });
  const taskName = await card.findByPlaceholderText("Task name");
  fireEvent.change(taskName, { target: { value: "Review layout" } });

  fireEvent.click(activityFlip);
  expect(card.getByRole("heading", { name: "Activity scope" })).toBeTruthy();
  expect(shellFlip.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(sdkFlip);
  expect(card.getByRole("heading", { name: "SDK scope" })).toBeTruthy();
  expect(
    card.queryByRole("button", { name: "Start background task" }),
  ).toBeNull();

  fireEvent.click(shellFlip);
  expect(
    card.getByRole("heading", { name: "CLI AgentCard details" }),
  ).toBeTruthy();
  expect(
    card.queryByRole("button", { name: "Flip Background SDK" }),
  ).toBeNull();
  fireEvent.keyDown(shellFlip, { key: "Escape" });
  expect(shellFlip.getAttribute("aria-pressed")).toBe("false");
  expect(document.activeElement).toBe(shellFlip);
  expect(sdkFlip.getAttribute("aria-pressed")).toBe("true");

  fireEvent.click(sdkFlip);
  expect(card.getByPlaceholderText<HTMLInputElement>("Task name").value).toBe(
    "Review layout",
  );
  expect(activityFlip.getAttribute("aria-pressed")).toBe("true");
  expect(
    calls.filter(({ command }) => command === "copilot_extensions_status"),
  ).toHaveLength(1);
  expect(
    calls.some(({ command }) => command === "copilot_extensions_action"),
  ).toBe(false);
});

test("agent browsing keeps the live session and draft; delayed evidence ranks only its own tiles", async () => {
  const first = {
    ...createConversationDraft("C:\\workspace", "architect", "Architect"),
    sessionId: "older",
    title: "Older design",
    updatedAt: "2025-01-01",
  };
  const second = {
    ...first,
    conversationId: "newer",
    sessionId: "newer",
    title: "Recent design",
    draft: "Review sketch",
    updatedAt: "2026-01-01",
  };
  writeConversationWorkspace({
    ...emptyConversationWorkspace(),
    chats: [first, second],
  });
  let finish!: (value: unknown) => void;
  invokeHandler = (command, args) =>
    command === "copilot_session_evidence"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : standardInvoke(command, args);
  const view = await workspace();
  await userEvent.type(draftInput(view), "First turn");
  fireEvent.click(view.getByRole("button", { name: "Send" }));
  await view.findByText("Unit-test reply");
  await userEvent.type(draftInput(view), "Private unsent text");
  const id = saved().activeConversationId;
  const before = calls.length;
  const select = (name: string) =>
    fireEvent.click(view.getByRole("button", { name }));
  select("Architect");
  const panel = within(
    view.getByRole("region", { name: "Architect dashboard" }),
  );
  expect(panel.getAllByRole("listitem")[0].textContent).toContain(
    "Recent design",
  );
  expect(view.queryByText("Unit-test reply")).toBeNull();
  expect(saved().activeConversationId).toBe(id);
  expect(saved().chats.find((c) => c.conversationId === id)?.draft).toBe(
    "Private unsent text",
  );
  expect(
    calls.slice(before).some((c) => c.command.startsWith("copilot_session_")),
  ).toBe(false);
  fireEvent.click(
    within(panel.getAllByRole("listitem")[1]).getByText(
      "Check commit evidence",
    ),
  );
  select("Copilot CLI");
  await act(async () =>
    finish({
      status: "verified",
      commits: ["abcd"],
      points: 2,
      reason: "Verified locally",
    }),
  );
  expect(view.queryByText("Verified locally")).toBeNull();
  select("Architect");
  const again = within(
    view.getByRole("region", { name: "Architect dashboard" }),
  );
  expect(again.getAllByRole("listitem")[0].textContent).toContain(
    "Older design",
  );
  expect(again.getAllByRole("listitem")[0].textContent).toContain(
    "2 verified points",
  );
  expect(
    calls
      .filter((c) => c.command === "copilot_session_evidence")
      .map((c) => c.args),
  ).toEqual([{ agentId: "architect", cwd: first.cwd, sessionId: "older" }]);
  fireEvent.click(
    again.getByRole("button", { name: "Continue Recent design" }),
  );
  await waitFor(() =>
    expect(draftInput(view, "Architect").value).toBe(second.draft),
  );
  expect(saved().activeConversationId).toBe(second.conversationId);
  expect(
    calls
      .filter((c) => c.command === "copilot_session_load")
      .map((c) => c.args),
  ).toEqual([{ agent: "architect", cwd: second.cwd, sessionId: "newer" }]);
  expect(
    calls.slice(before).some((c) => c.command === "copilot_session_prompt"),
  ).toBe(false);
});

test("refused Continue keeps the selected agent history visible and does not send its draft", async () => {
  const chat = {
    ...createConversationDraft("C:\\workspace", "architect", "Architect"),
    sessionId: "saved",
    title: "Design review",
    draft: "Unsent notes",
  };
  writeConversationWorkspace({
    ...emptyConversationWorkspace(),
    chats: [chat],
  });
  invokeHandler = async (command, args) => {
    if (command === "copilot_session_load")
      throw { said: "CLI refused this agent" };
    return standardInvoke(command, args);
  };
  const view = await workspace();
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Architect" }));
  });
  const dashboard = within(
    view.getByRole("region", { name: "Architect dashboard" }),
  );
  fireEvent.click(
    dashboard.getByRole("button", { name: "Continue Design review" }),
  );
  await view.findByText("CLI refused this agent");
  expect(
    dashboard.getByRole("button", { name: "Continue Design review" }),
  ).toBeDefined();
  expect(saved().chats[0].draft).toBe(chat.draft);
  expect(calls.some((c) => c.command === "copilot_session_prompt")).toBe(false);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Copilot CLI" }));
  });
  expect(view.queryByText("CLI refused this agent")).toBeNull();
});

test("configured cloud agents stay distinct and never enter a local CLI session", async () => {
  const source: StudioAgentSource = {
    provider: "copilot-studio",
    tenantId: "11111111-1111-1111-1111-111111111111",
    environmentId: "22222222-2222-2222-2222-222222222222",
    environmentName: "Development",
    environmentUrl: "https://example.crm.dynamics.com/",
    botId: "33333333-3333-3333-3333-333333333333",
    schemaName: "test_cloud",
    modifiedAt: "2026-11-17T00:00:00Z",
    stateCode: 0,
    lastSyncedAt: 1794873600,
  };
  const second = {
    ...source,
    environmentId: "44444444-4444-4444-4444-444444444444",
    environmentName: "Production",
    declaredDescription: "Schedules production reviews.",
  };
  const cloudAgents: CopilotAgentSummary[] = [source, second].map((item) => ({
    id: studioAgentId(item),
    name: "Shared agent name",
    source: item,
  }));
  const sources: StudioSourceStatus[] = [source, second].map((item) => ({
    tenantId: item.tenantId,
    environmentId: item.environmentId,
    environmentName: item.environmentName,
    environmentUrl: item.environmentUrl,
    state: "ready",
    agentCount: 1,
    lastSyncedAt: item.lastSyncedAt,
    error: null,
  }));
  sources[1].assets = [
    {
      kind: "canvas-app",
      id: "prod-app-id",
      name: "Production scheduling app",
    },
    { kind: "workflow", id: "prod-flow-id", name: "Production approval flow" },
    {
      kind: "model-driven-app",
      id: "prod-model-id",
      name: "Production records",
    },
  ];
  sources[1].assetWarnings = ["Partial inventory"];
  let failRefresh = false;
  invokeHandler = async (command, args) => {
    if (command === "copilot_inventory")
      return {
        agents: cloudAgents,
        sources,
        skills: [],
        plugins: [],
        mcpServers: [],
        warnings: [],
      };
    if (command === "copilot_agents" && failRefresh) {
      throw { said: "Cloud refresh unavailable; retained the last catalog." };
    }
    if (command === "copilot_agents")
      return { agents: cloudAgents, sources, warnings: [] };
    return standardInvoke(command, args);
  };
  const view = await workspace();
  await userEvent.type(draftInput(view), "Keep this local draft");
  await waitFor(() =>
    expect(
      view.container.querySelectorAll(
        ".copilot-sidebar-groups [data-agent-id^='studio:']",
      ),
    ).toHaveLength(2),
  );
  const cloud = view.getByRole("button", {
    name: /Shared agent name.*Development/,
  });
  fireEvent.click(cloud);
  await waitFor(() =>
    expect(
      view.getByRole("dialog", { name: "Shared agent name" }),
    ).toBeTruthy(),
  );
  const dialog = within(
    view.getByRole("dialog", { name: "Shared agent name" }),
  );
  expect(
    dialog.queryByRole("button", { name: "New chat with Shared agent name" }),
  ).toBeNull();
  expect(dialog.getByText(/Catalog reference only/)).toBeTruthy();
  expect(calls.some((call) => call.command === "copilot_session_new")).toBe(
    false,
  );
  expect(saved().chats).toHaveLength(1);
  expect(saved().chats[0].draft).toBe("Keep this local draft");
  fireEvent.click(dialog.getByRole("button", { name: "Close" }));
  fireEvent.click(view.getByRole("tab", { name: "Your canvas" }));
  const canvas = within(view.getByRole("tabpanel", { name: "Your canvas" }));
  const tile = view.container.querySelector<HTMLElement>(
    `.copilot-agent-canvas [data-agent-id="${cloudAgents[1].id}"]`,
  )!;
  const peer = view.container.querySelector<HTMLElement>(
    `.copilot-agent-canvas [data-agent-id="${cloudAgents[0].id}"]`,
  )!;
  expect(within(tile).getByText("Schedules production reviews.")).toBeTruthy();
  expect(within(peer).getByText("No public purpose reported.")).toBeTruthy();
  expect(tile.textContent).not.toContain("Production approval flow");
  expect(tile.textContent).not.toContain("Env. agents");
  expect(canvas.queryByRole("tablist")).toBeNull();
  const toggle = within(tile).getByRole("button", { name: /^Flip AgentCard/ });
  const keyboard = userEvent.setup({ document });
  toggle.focus();
  await keyboard.keyboard("{Enter}");
  fireEvent.click(
    within(peer).getByRole("button", { name: /^Flip AgentCard/ }),
  );
  fireEvent.click(within(peer).getByRole("tab", { name: "environment" }));
  expect(JSON.parse(peer.querySelector("pre")!.textContent!).status).toBe(
    "not-collected",
  );
  const tables = within(tile).getByRole("tab", { name: "tables" });
  tables.focus();
  await keyboard.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(
    within(tile).getByRole("tab", { name: "environment" }),
  );
  const inventory = JSON.parse(tile.querySelector("pre")!.textContent!);
  expect(inventory.scope).toContain("ENVIRONMENT inventory");
  expect(inventory.environmentId).toBe(second.environmentId);
  expect(inventory.status).toBe("partial");
  expect(inventory.assets).toEqual(sources[1].assets);
  fireEvent.click(within(tile).getByRole("button", { name: "Show schema" }));
  const schema = tile.querySelector("pre")!.textContent!;
  expect(JSON.parse(schema).properties.assets).toBeDefined();
  fireEvent.click(within(tile).getByRole("button", { name: "Copy JSON" }));
  await within(tile).findByText("Copied JSON");
  expect(await navigator.clipboard.readText()).toBe(schema);
  fireEvent.click(within(tile).getByRole("button", { name: "Show instance" }));
  fireEvent.click(within(tile).getByRole("tab", { name: "Full card" }));
  const json = JSON.parse(tile.querySelector("pre")!.textContent!);
  expect(json.sourceKey).toBe(cloudAgents[1].id);
  expect(json.tabs.sessions.indexedCount).toBeNull();
  expect(
    json.tabs.relationships.edges.some(
      (edge: { target: string }) => edge.target === "prod-flow-id",
    ),
  ).toBe(false);
  fireEvent.keyDown(within(tile).getByRole("tab", { name: "Full card" }), {
    key: "Escape",
  });
  expect(document.activeElement).toBe(toggle);
  expect(tile.querySelector("pre")).toBeNull();
  expect(
    within(peer)
      .getByRole("tab", { name: "environment" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  const coverage = canvas.getByLabelText("Copilot Studio source coverage");
  expect(coverage.textContent).toContain("Development");
  expect(coverage.textContent).toContain("Production");
  failRefresh = true;
  fireEvent.click(view.getByRole("button", { name: "Refresh agent catalog" }));
  await waitFor(() =>
    expect(
      view.getByText("Cloud refresh unavailable; retained the last catalog."),
    ).toBeTruthy(),
  );
  expect(
    view.container.querySelectorAll(
      ".copilot-sidebar-groups [data-agent-id^='studio:']",
    ),
  ).toHaveLength(2);
});

test("canvas pages and searches unimported definitions; chat actions live on the sessions face", async () => {
  const agents = Array.from({ length: 54 }, (_, i) => {
    const id = `${i % 2 ? "darbot" : "dayour"}-desk-${i}`;
    return {
      id,
      name: `Desk ${i}`,
      definition: {
        declaredId: id,
        file: `local/${id}.md`,
        omittedEntries: 0,
        tools: [],
      },
    };
  });
  invokeHandler = (command, args) =>
    command === "copilot_inventory"
      ? Promise.resolve({
          agents,
          sources: [],
          skills: [],
          plugins: [],
          mcpServers: [],
          warnings: [],
        })
      : standardInvoke(command, args);
  const view = await workspace();
  fireEvent.click(view.getByRole("tab", { name: "Your canvas" }));
  const canvas = within(view.getByRole("tabpanel", { name: "Your canvas" }));
  const grid = canvas.getByRole("list", { name: "Agent cards" });
  expect(grid.children.length).toBe(24);
  expect(grid.querySelector("pre")).toBeNull();
  fireEvent.click(canvas.getByRole("button", { name: "Next" }));
  expect(within(grid).queryByRole("heading", { name: "Desk 0" })).toBeNull();
  await userEvent.type(
    canvas.getByRole("searchbox"),
    "local/darbot-desk-53.md",
  );
  expect(grid.children.length).toBe(1);
  expect(grid.children[0].hasAttribute("data-darbot")).toBe(false);
  expect(within(grid).queryByRole("button", { name: "New chat" })).toBeNull();
  fireEvent.click(
    within(grid).getByRole("button", { name: /^Flip AgentCard/ }),
  );
  fireEvent.click(within(grid).getByRole("tab", { name: "sessions" }));
  fireEvent.click(within(grid).getByRole("button", { name: "New chat" }));
  await waitFor(() =>
    expect(saved().chats.some((chat) => chat.agentId === agents[53].id)).toBe(
      true,
    ),
  );
  expect(calls.some((call) => call.command === "copilot_session_new")).toBe(
    false,
  );
});

test("New chat creates persistent local drafts without allocating CLI sessions", async () => {
  const view = await workspace();
  fireEvent.click(view.getByRole("button", { name: "New chat" }));
  await waitFor(() => expect(saved().chats).toHaveLength(1));
  await userEvent.type(draftInput(view), "First unsent task");
  fireEvent.click(view.getByRole("button", { name: "New chat" }));
  await waitFor(() => expect(saved().chats).toHaveLength(2));
  expect(saved().chats.every((chat) => chat.sessionId === null)).toBe(true);
  expect(
    calls.filter((call) => call.command === "copilot_session_new"),
  ).toHaveLength(0);
  const firstId = saved().chats.find(
    (chat) => chat.draft === "First unsent task",
  )?.conversationId;
  if (!firstId) throw new Error("The first draft was not saved.");
  const buttons = view.getAllByRole("button", {
    name: "Draft: New conversation",
  });
  fireEvent.click(buttons[1]);
  await waitFor(() => expect(draftInput(view).value).toBe("First unsent task"));
  await waitFor(() => expect(saved().activeConversationId).toBe(firstId));
});

test("selected drafts survive a remount without opening or sending", async () => {
  const draft = {
    ...createConversationDraft("C:\\workspace", "architect", "Architect"),
    draft: "Continue drafting, not sending",
  };
  writeConversationWorkspace({
    ...emptyConversationWorkspace(),
    chats: [draft],
    activeConversationId: draft.conversationId,
  });
  const first = await workspace();
  expect(draftInput(first, "Architect").value).toBe(draft.draft);
  first.unmount();
  const second = await workspace();
  expect(draftInput(second, "Architect").value).toBe(draft.draft);
  expect(
    calls.some((call) =>
      [
        "copilot_session_new",
        "copilot_session_load",
        "copilot_session_prompt",
      ].includes(call.command),
    ),
  ).toBe(false);
});

test("opening failure preserves the draft and retry keeps its conversation identity", async () => {
  let fail = true;
  invokeHandler = async (command, args) => {
    if (command === "copilot_session_new" && fail)
      throw { said: "Opening timed out; runtime retired." };
    return standardInvoke(command, args);
  };
  const view = await workspace();
  const composer = draftInput(view);
  await userEvent.type(composer, "Keep this task");
  const id = saved().activeConversationId;
  if (!id) throw new Error("The draft has no stable conversation identity.");
  fireEvent.click(view.getByRole("button", { name: "Send" }));
  await view.findByText("Opening timed out; runtime retired.");
  expect(saved().chats[0].sessionId).toBeNull();
  expect(saved().chats[0].draft).toBe("Keep this task");
  expect(
    calls.filter((call) => call.command === "copilot_session_prompt"),
  ).toHaveLength(0);
  fail = false;
  fireEvent.click(view.getByRole("button", { name: "Send" }));
  await view.findByText("Unit-test reply");
  await waitFor(() => expect(saved().chats[0].draft).toBe(""));
  expect(saved().chats[0].conversationId).toBe(id);
  expect(saved().chats[0].sessionId).toBe("runtime-1");
  expect(
    calls.filter((call) => call.command === "copilot_session_prompt"),
  ).toHaveLength(1);
});

test("recorded-agent replay can be retried without resubmitting its draft", async () => {
  const draft = {
    ...createConversationDraft("C:\\workspace", "architect", "Architect"),
    sessionId: "recorded",
    title: "Saved reference",
    draft: "Unsent follow-up",
  };
  writeConversationWorkspace({
    ...emptyConversationWorkspace(),
    chats: [draft],
    activeConversationId: draft.conversationId,
  });
  let fail = true;
  invokeHandler = async (command, args) => {
    if (command === "copilot_session_load" && fail)
      throw { said: "Replay interrupted; runtime retired." };
    return standardInvoke(command, args);
  };
  const view = await workspace();
  fireEvent.click(view.getByRole("button", { name: "Saved reference" }));
  await view.findByText("Replay interrupted; runtime retired.");
  expect(draftInput(view, "Architect").value).toBe("Unsent follow-up");
  fail = false;
  fireEvent.click(
    view.getByRole("button", { name: "Retry opening conversation" }),
  );
  await waitFor(() =>
    expect(view.queryByText("Replay interrupted; runtime retired.")).toBeNull(),
  );
  expect(
    calls
      .filter((call) => call.command === "copilot_session_load")
      .map((call) => argument(call.args, "agent")),
  ).toEqual(["architect", "architect"]);
  expect(
    calls.filter((call) => call.command === "copilot_session_prompt"),
  ).toHaveLength(0);
  expect(saved().chats[0].conversationId).toBe(draft.conversationId);
  expect(saved().chats[0].draft).toBe("Unsent follow-up");
});

test("missing runtime session is converted into a local draft and can be resent", async () => {
  const draft = {
    ...createConversationDraft("C:\\workspace", "architect", "Architect"),
    sessionId: "missing",
    title: "Transient opening",
    draft: "Keep this draft",
  };
  writeConversationWorkspace({
    ...emptyConversationWorkspace(),
    chats: [draft],
    activeConversationId: draft.conversationId,
  });
  invokeHandler = async (command, args) => {
    if (command === "copilot_session_load")
      throw {
        said: "GitHub Copilot returned a runtime error.",
        detail:
          '{"code":-32002,"message":"Resource not found: Session missing not found"}',
      };
    return standardInvoke(command, args);
  };
  const view = await workspace();
  fireEvent.click(view.getByRole("button", { name: "Transient opening" }));
  await view.findByText(
    "Copilot could not reopen that runtime session. Darbot kept this chat as a local draft; send to start a new session.",
  );
  await waitFor(() => expect(saved().chats[0].sessionId).toBeNull());
  expect(draftInput(view, "Architect").value).toBe("Keep this draft");
  expect(
    view.queryByRole("button", { name: "Retry opening conversation" }),
  ).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Send" }));
  await view.findByText("Unit-test reply");
  expect(
    calls.filter((call) => call.command === "copilot_session_load"),
  ).toHaveLength(1);
  expect(
    calls.filter((call) => call.command === "copilot_session_new"),
  ).toHaveLength(1);
  expect(saved().chats[0].sessionId).toBe("runtime-1");
  expect(saved().chats[0].draft).toBe("");
});

test("all local drafts remain reachable through agent-filtered History", async () => {
  const drafts = Array.from({ length: 7 }, (_, index) => ({
    ...createConversationDraft("C:\\workspace", "architect", "Architect"),
    title: `Draft ${index}`,
  }));
  writeConversationWorkspace({
    ...emptyConversationWorkspace(),
    chats: drafts,
  });
  const view = await workspace();
  fireEvent.click(view.getByRole("button", { name: "Settings for Architect" }));
  fireEvent.click(view.getByRole("button", { name: "Show Architect chats" }));
  fireEvent.click(view.getByRole("button", { name: "View all 7 chats" }));
  const dialog = await view.findByRole("dialog", {
    name: "Agents Conversations",
  });
  await waitFor(() =>
    expect(
      within(dialog).getAllByRole("button", { name: "Open draft" }),
    ).toHaveLength(7),
  );
  const agent = within(dialog).getByRole("combobox", {
    name: "Conversation agent",
  });
  if (!(agent instanceof HTMLSelectElement))
    throw new Error("The agent selector is missing.");
  expect(agent.value).toBe("architect");
});

test("agent chat disclosure moves into icon settings and the choice persists", async () => {
  const drafts = Array.from({ length: 2 }, (_, index) => ({
    ...createConversationDraft("C:\\workspace", "architect", "Architect"),
    title: `Draft ${index}`,
  }));
  writeConversationWorkspace({
    ...emptyConversationWorkspace(),
    chats: drafts,
  });
  const view = await workspace();
  fireEvent.click(view.getByRole("button", { name: "Settings for Architect" }));
  const toggle = view.getByRole("button", { name: "Show Architect chats" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(view.queryByRole("button", { name: "Draft: Draft 0" })).toBeNull();

  fireEvent.click(toggle);
  await view.findByRole("button", { name: "Draft: Draft 0" });
  fireEvent.click(view.getByRole("button", { name: "Settings for Architect" }));
  expect(
    view
      .getByRole("button", { name: "Hide Architect chats" })
      .getAttribute("aria-expanded"),
  ).toBe("true");

  cleanup();
  const remounted = await workspace();
  await remounted.findByRole("button", { name: "Draft: Draft 0" });
  fireEvent.click(
    remounted.getByRole("button", { name: "Settings for Architect" }),
  );
  expect(
    remounted
      .getByRole("button", { name: "Hide Architect chats" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
});

test("an agent with no chats cannot be expanded", async () => {
  const view = await workspace();
  fireEvent.click(
    view.getByRole("button", { name: "Settings for Copilot CLI" }),
  );
  const toggle = view.getByRole("button", { name: "Show Copilot CLI chats" });
  expect(toggle.hasAttribute("disabled")).toBe(true);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(view.queryByText("No chats yet")).toBeNull();
  expect(toggle.hasAttribute("title")).toBe(false);
  const sidebar = view.getByRole("complementary", {
    name: "Agents and chats",
  });
  expect(Array.from(sidebar.children).map((child) => child.tagName)).toEqual([
    "HEADER",
    "NAV",
    "DIV",
  ]);
  expect(
    Array.from(sidebar.querySelector("header")?.children ?? []).map(
      (child) => child.className,
    ),
  ).toEqual(["lockup", "copilot-sidebar-actions"]);
  expect(view.getByRole("navigation", { name: "Agents" }).tabIndex).toBe(0);
});

test("agent icon settings inspect another agent without opening or configuring it", async () => {
  const draft = createConversationDraft(
    "C:\\workspace",
    "architect",
    "Architect",
  );
  writeConversationWorkspace({
    ...emptyConversationWorkspace(),
    chats: [draft],
  });
  const view = await workspace();
  const before = calls.length;
  fireEvent.click(view.getByRole("button", { name: "Settings for Architect" }));
  const dialog = await view.findByRole("dialog", { name: "Architect" });
  expect(
    within(dialog).getByRole("combobox", { name: "Agent" }).getAttribute("id"),
  ).toBe("copilot-inspected-agent");
  expect(
    within(dialog).getByRole("button", { name: "New chat with Architect" }),
  ).toBeDefined();
  expect(within(dialog).queryByRole("combobox", { name: "Model" })).toBeNull();
  expect(calls.slice(before)).toHaveLength(0);
  expect(saved().activeConversationId).toBeNull();
  expect(
    view
      .getByRole("button", { name: "Copilot CLI" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
});

test("widget flipping and pinning preserve the mounted composer and local draft", async () => {
  const view = render(
    <DesktopWindow>
      <CopilotWorkspace onBack={() => {}} />
    </DesktopWindow>,
  );
  await view.findByRole("button", { name: "Widget" });
  await waitFor(() =>
    expect(
      view.getByRole("button", { name: "New chat" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  const composer = draftInput(view);
  await userEvent.type(composer, "Keep this unsent draft");
  await waitFor(() =>
    expect(saved().chats[0].draft).toBe("Keep this unsent draft"),
  );
  const conversationId = saved().activeConversationId;
  fireEvent.click(view.getByRole("button", { name: "Widget" }));
  await view.findByRole("region", { name: "Live agent tile" });
  expect(composer.isConnected).toBe(true);
  expect(composer.closest("[inert]")).not.toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Wide" }));
  await waitFor(() =>
    expect(
      view
        .getByRole("button", { name: "Portrait" })
        .getAttribute("aria-pressed"),
    ).toBe("true"),
  );
  expect(composer.closest(".desktop-widget-wide")).not.toBeNull();
  expect(composer.isConnected).toBe(true);
  fireEvent.click(view.getByRole("button", { name: "Pin" }));
  await waitFor(() =>
    expect(
      view.getByRole("button", { name: "Unpin" }).getAttribute("aria-pressed"),
    ).toBe("true"),
  );
  fireEvent.click(view.getByRole("button", { name: "Flip to workspace" }));
  await waitFor(() => expect(draftInput(view)).toBe(composer));
  expect(composer.value).toBe("Keep this unsent draft");
  fireEvent.click(view.getByRole("button", { name: "Portrait" }));
  await view.findByRole("button", { name: "Wide" });
  expect(composer.closest(".desktop-widget-wide")).toBeNull();
  expect(composer.value).toBe("Keep this unsent draft");
  fireEvent.click(view.getByRole("button", { name: "Expand" }));
  await view.findByRole("button", { name: "Widget" });
  expect(saved().activeConversationId).toBe(conversationId);
  expect(
    calls.filter((call) => call.command === "copilot_session_new"),
  ).toHaveLength(0);
  expect(
    calls.filter((call) => call.command === "copilot_session_prompt"),
  ).toHaveLength(0);
});

const archiveFixture: HistoryIndex = {
  schemaVersion: 1,
  scannedAt: "2026-11-17T17:00:00Z",
  sources: [
    {
      id: "archive",
      label: "Local archive",
      indexed: 3,
      unreadable: 0,
      duplicates: 2,
      unattributed: 0,
      complete: true,
      status: "indexed",
    },
  ],
  sessions: [
    {
      id: "copilot-cli:overlap",
      provider: "copilot-cli",
      nativeId: "overlap",
      agentIds: ["architect"],
      sourceIds: ["archive"],
      updatedAt: null,
    },
    {
      id: "codex:overlap",
      provider: "codex",
      nativeId: "overlap",
      agentIds: ["architect", ""],
      sourceIds: ["archive"],
      updatedAt: "2026-01-02T03:04:05Z",
    },
    {
      id: "codex:elsewhere",
      provider: "codex",
      nativeId: "elsewhere",
      agentIds: ["other"],
      sourceIds: ["archive"],
      updatedAt: null,
    },
  ],
};

test("live/archive union drives count shortcuts, scoped History and card tiles; a failed refresh retains a lower bound", async () => {
  writeImportedAgentIds(["architect"]);
  let release!: (v: HistoryIndex) => void;
  const firstScan = new Promise<HistoryIndex>((resolve) => {
    release = resolve;
  });
  invokeHandler = async (command, args) => {
    if (command === "history_sources_index") {
      if ((args as { refresh: boolean }).refresh) throw Error("offline");
      return firstScan;
    }
    if (command === "copilot_history")
      return {
        agents: [],
        warnings: [],
        sessions: [
          {
            sessionId: "overlap",
            cwd: "C:\\workspace",
            agentId: "architect",
            agentName: "Architect",
            title: "Runtime row",
          },
        ],
      };
    return standardInvoke(command, args);
  };
  const view = await workspace();
  await view.findByRole("button", {
    name: "History sources for Architect: At least 1 session",
  });
  expect(
    view.queryByRole("button", {
      name: "History sources for Copilot CLI: 0 sessions",
    }),
  ).toBeNull();
  await act(async () => release(archiveFixture));
  fireEvent.click(
    await view.findByRole("button", {
      name: "History sources for Architect: 2 sessions",
    }),
  );
  const dialog = within(
    view.getByRole("dialog", { name: "Agents Conversations" }),
  );
  expect(dialog.getByText("Runtime row")).toBeTruthy();
  expect(dialog.getByText("codex:overlap")).toBeTruthy();
  expect(dialog.queryByText("codex:elsewhere")).toBeNull();
  expect(
    dialog.getByText(
      /Source totals: 3 indexed, 2 duplicates, 0 unreadable, 0 unattributed/,
    ).textContent,
  ).toContain("this agent: 2");
  expect(dialog.getByText(archiveFixture.scannedAt)).toBeTruthy();
  const scope = dialog.getByRole("checkbox", { name: /all folders/ });
  fireEvent.click(scope);
  expect(dialog.queryByText("codex:overlap")).toBeNull();
  fireEvent.click(dialog.getByRole("button", { name: "Close" }));
  fireEvent.click(view.getByRole("button", { name: "Architect" }));
  const panel = within(
    view.getByRole("region", { name: "Architect dashboard" }),
  );
  expect(
    panel.getByRole("button", { name: "Continue Runtime row" }),
  ).toBeTruthy();
  expect(
    panel.getByRole("list", { name: "Archive-only references" }).textContent,
  ).toContain("codex:overlap");
  fireEvent.click(view.getByRole("tab", { name: "Your canvas" }));
  const tile = within(
    view.container.querySelector<HTMLElement>(
      '.fleet-tile[data-agent-id="architect"]',
    )!,
  );
  fireEvent.click(
    await tile.findByRole("button", {
      name: "2 sessions · History sources for Architect",
    }),
  );
  expect(
    tile.getByRole("tab", { name: "sessions" }).getAttribute("aria-selected"),
  ).toBe("true");
  const archive = within(
    tile.getByRole("list", { name: "Archive-only references" }),
  );
  expect(archive.getByText("codex:overlap")).toBeTruthy();
  expect(
    archive.queryByRole("button", {
      name: /continue|load|check commit evidence/i,
    }),
  ).toBeNull();
  expect(tile.queryByText("codex:elsewhere")).toBeNull();
  fireEvent.click(tile.getByText(/2 sessions/, { selector: "summary strong" }));
  fireEvent.click(
    tile.getByRole("button", { name: "Refresh history sources" }),
  );
  await tile.findByText(/Archive scan unavailable/);
  expect(
    tile.getByText("At least 2 sessions", { selector: "summary strong" }),
  ).toBeTruthy();
  expect(
    calls
      .filter((c) => c.command === "history_sources_index")
      .map((c) => c.args),
  ).toEqual([{ refresh: false }, { refresh: true }]);
  fireEvent.click(tile.getByRole("tab", { name: "tools" }));
  expect(
    tile.getByRole("region", { name: "Resource diagnostics · Architect" }),
  ).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Resources" }));
  expect(
    within(view.getByRole("dialog", { name: "Resources" })).getByRole(
      "region",
      { name: "Resource diagnostics" },
    ),
  ).toBeTruthy();
  expect(saved().chats).toHaveLength(0);
  expect(calls.some((c) => c.command.startsWith("copilot_session_"))).toBe(
    false,
  );
});

test("an archive flashcard travels only via explicit preview, copy, validation and local save; feedback stays scoped on remount", async () => {
  writeImportedAgentIds(["architect"]);
  invokeHandler = async (command, args) =>
    command === "history_sources_index"
      ? archiveFixture
      : standardInvoke(command, args);
  const view = await workspace();
  fireEvent.click(view.getByRole("button", { name: "Architect" }));
  const panel = within(
    view.getByRole("region", { name: "Architect dashboard" }),
  );
  const row = within(
    panel
      .getByRole("list", { name: "Archive-only references" })
      .querySelector("li")!,
  );
  await clickHarvest(row, "Pin", "Unpin");
  await clickHarvest(row, "Mark reviewed", "Undo reviewed");
  await clickHarvest(row, "Dismiss suggestion", "Restore suggestion");
  expect(panel.queryByText(/Suggested next step:/)?.textContent).not.toContain(
    "codex:overlap",
  );
  fireEvent.click(
    row.getByRole("button", { name: "Preview session flashcard" }),
  );
  fireEvent.click(
    await row.findByRole("button", { name: "Copy numberstring" }),
  );
  await row.findByText(/Copied\. Paste into another agent/);
  const digits = await navigator.clipboard.readText();
  expect(parseFlashcard(digits).observation).toMatchObject({
    sourceFeedback: { pinned: true, dismissed: true, reviewed: true },
    sourceEvidence: null,
    updatedAt: "2026-01-02T03:04:05.000Z",
  });
  fireEvent.click(view.getByRole("button", { name: "Copilot CLI" }));
  const target = within(
    view.getByRole("region", { name: "Copilot CLI dashboard" }),
  );
  expect(target.getByRole("button", { name: "Pin" })).toBeTruthy();
  fireEvent.click(
    await target.findByText(/Agent flashcards · 0 local references/),
  );
  const paste = target.getByRole("textbox", { name: /Paste a flashcard/ });
  const user = userEvent.setup({ document });
  await user.click(paste);
  await user.paste(digits);
  fireEvent.click(target.getByRole("button", { name: "Validate and preview" }));
  expect(
    target.getByRole("button", { name: "Save as local reference" }),
  ).toBeTruthy();
  await user.clear(paste);
  await user.paste('{"tool":"run"}');
  expect(
    target.queryByRole("button", { name: "Save as local reference" }),
  ).toBeNull();
  fireEvent.click(target.getByRole("button", { name: "Validate and preview" }));
  expect(
    target.getByText("Invalid flashcard. No reference saved."),
  ).toBeTruthy();
  await user.clear(paste);
  await user.paste(digits);
  fireEvent.click(target.getByRole("button", { name: "Validate and preview" }));
  fireEvent.click(
    target.getByRole("button", { name: "Save as local reference" }),
  );
  expect(await target.findByText(/Reference saved locally/)).toBeTruthy();
  expect(
    target.getByRole("button", { name: "Dismiss suggestion" }),
  ).toBeTruthy();
  expect(saved().chats).toHaveLength(0);
  cleanup();
  const remounted = await workspace();
  fireEvent.click(await remounted.findByRole("button", { name: "Architect" }));
  const again = within(
    remounted.getByRole("region", { name: "Architect dashboard" }),
  );
  const restoredRow = within(
    again
      .getByRole("list", { name: "Archive-only references" })
      .querySelector("li")!,
  );
  await clickHarvest(restoredRow, "Unpin", "Pin");
  await clickHarvest(restoredRow, "Undo reviewed", "Mark reviewed");
  await clickHarvest(restoredRow, "Restore suggestion", "Dismiss suggestion");
  expect(again.getByText(/Suggested next step:/).textContent).toContain(
    "codex:overlap",
  );
  fireEvent.click(remounted.getByRole("button", { name: "Copilot CLI" }));
  const persisted = within(
    remounted.getByRole("region", { name: "Copilot CLI dashboard" }),
  );
  fireEvent.click(
    await persisted.findByText(/Agent flashcards · 1 local references/),
  );
  expect(persisted.getByText(/Imported reference ·/)).toBeTruthy();
  expect(calls.some((c) => c.command.startsWith("copilot_session_"))).toBe(
    false,
  );
});
test("invalid stored workspace is visible and not overwritten during mount", async () => {
  const original = JSON.stringify({
    ...emptyConversationWorkspace(),
    schemaVersion: 99,
  });
  localStorage.setItem(WORKSPACE_STORAGE_KEY, original);
  const view = render(<CopilotWorkspace onBack={() => {}} />);
  await view.findByText(
    "Darbot could not open the saved Copilot workspace. Its original data has not been replaced.",
  );
  await act(async () => {});
  expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(original);
  expect(calls.some((call) => call.command === "copilot_workspace")).toBe(
    false,
  );
  expect(view.queryByRole("button", { name: "Send" })).toBeNull();
});

test("ACP terminal snapshots bind to their tool calls and preserve final output without persisting it", async () => {
  const view = await workspace();
  await userEvent.type(draftInput(view), "Start activity");
  fireEvent.click(view.getByRole("button", { name: "Send" }));
  await view.findByText("Unit-test reply");
  const sessionId = argument(
    calls.find((call) => call.command === "copilot_session_prompt")?.args,
    "sessionId",
  );
  expect(sessionId).toBeTruthy();
  const snapshot = {
    sessionId,
    terminalId: "terminal-a",
    output: "first\n",
    truncated: false,
  };
  await act(async () => emit("copilot:terminal-output", snapshot));
  await act(async () =>
    emit("copilot:session-update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "build",
        title: "Compile project",
        kind: "execute",
        status: "in_progress",
        content: [{ type: "terminal", terminalId: "terminal-a" }],
      },
    }),
  );
  await act(async () =>
    emit("copilot:terminal-output", {
      ...snapshot,
      output: "Private terminal output ✓\n",
      exitStatus: { exitCode: 0, signal: null },
    }),
  );
  await act(async () =>
    emit("copilot:session-update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "build",
        status: "completed",
      },
    }),
  );
  await act(async () =>
    emit("copilot:terminal-output", {
      ...snapshot,
      sessionId: "other-session",
      output: "foreign output",
    }),
  );
  fireEvent.click(view.getByRole("tab", { name: "Your CLI" }));
  const activity = within(view.getByRole("list", { name: "CLI activity" }));
  expect(activity.getAllByRole("listitem")).toHaveLength(1);
  expect(activity.getByText("Compile project: completed")).toBeTruthy();
  const details = activity.getByText("Tool output and details");
  fireEvent.click(details);
  expect(
    activity.getByText(/Private terminal output ✓/, { selector: "pre" }),
  ).toBeTruthy();
  expect(activity.queryByText(/foreign output/)).toBeNull();
  expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).not.toContain(
    "Private terminal output",
  );
});

test("ACP plan changes replace the plan details rather than leaving a one-shot placeholder", async () => {
  const view = await workspace();
  await userEvent.type(draftInput(view), "Run plan");
  fireEvent.click(view.getByRole("button", { name: "Send" }));
  await view.findByText("Unit-test reply");
  const sessionId = argument(
    calls.find((call) => call.command === "copilot_session_prompt")?.args,
    "sessionId",
  );
  for (const status of ["pending", "completed"]) {
    await act(async () =>
      emit("copilot:session-update", {
        sessionId,
        update: {
          sessionUpdate: "plan",
          entries: [{ content: "Compile target", priority: "high", status }],
        },
      }),
    );
  }
  fireEvent.click(view.getByRole("tab", { name: "Your CLI" }));
  const activity = within(view.getByRole("list", { name: "CLI activity" }));
  expect(activity.getAllByRole("listitem")).toHaveLength(1);
  fireEvent.click(activity.getByText("Tool output and details"));
  const plan = activity.getByText(/Compile target/, {
    selector: "pre",
  }).textContent;
  expect(plan).toContain('"completed"');
  expect(plan).not.toContain('"pending"');
});

test("ACP message IDs remain distinct and compaction patches keep their first timeline position", async () => {
  const view = await workspace();
  await userEvent.type(draftInput(view), "Start context");
  fireEvent.click(view.getByRole("button", { name: "Send" }));
  await view.findByText("Unit-test reply");
  const sessionId = argument(
    calls.find((call) => call.command === "copilot_session_prompt")?.args,
    "sessionId",
  );
  await act(async () => {
    for (const update of [
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "first",
        content: { type: "text", text: "First distinct message" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "second",
        content: { type: "text", text: "Second distinct message" },
      },
      {
        sessionUpdate: "compaction_update",
        compactionId: "compact",
        status: "in_progress",
      },
      {
        sessionUpdate: "plan",
        entries: [
          {
            content: "Plan after compaction",
            status: "pending",
            priority: "low",
          },
        ],
      },
      {
        sessionUpdate: "compaction_summary_chunk",
        compactionId: "compact",
        content: { type: "text", text: "Partial context" },
      },
      {
        sessionUpdate: "compaction_update",
        compactionId: "compact",
        status: "completed",
        summary: [{ type: "text", text: "Final retained context" }],
      },
    ])
      emit("copilot:session-update", { sessionId, update });
  });
  expect(view.getByText("First distinct message")).toBeTruthy();
  expect(view.getByText("Second distinct message")).toBeTruthy();
  fireEvent.click(view.getByRole("tab", { name: "Your CLI" }));
  const list = within(view.getByRole("list", { name: "CLI activity" }));
  const rows = list.getAllByRole("listitem");
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain("Context compaction: completed");
  expect(rows[1].textContent).toContain("Plan");
  fireEvent.click(within(rows[0]).getByText("Tool output and details"));
  expect(rows[0].textContent).toContain("Final retained context");
  expect(rows[0].textContent).not.toContain("Partial context");
});

test("SDK task rejection retains the submitted draft and success clears it only after confirmation", async () => {
  const snapshot = {
    schemaVersion: 1,
    sdkVersion: "test",
    runtimeVersion: "test",
    protocolVersion: 3,
    connectionId: "workspace",
    sessionId: "sdk",
    cwd: "C:\\workspace",
    memoryEnabled: false,
    agents: {
      state: "available",
      data: [{ id: "architect", name: "Architect" }],
    },
    tasks: { state: "available", data: [] },
    plugins: { state: "available", data: [] },
  };
  let approved = false;
  invokeHandler = async (command) => {
    if (command === "copilot_extensions_status") return snapshot;
    if (command === "copilot_extensions_action") {
      if (!approved) throw { said: "The SDK action was not approved." };
      return snapshot;
    }
    throw new Error(`Unexpected operation ${command}`);
  };
  const view = render(<CopilotExtensionsPanel cwd={"C:\\workspace"} />);
  await view.findByPlaceholderText("Task name");
  const taskName = view.getByPlaceholderText("Task name");
  const taskPrompt = view.getByPlaceholderText("Task prompt");
  if (
    !(taskName instanceof HTMLInputElement) ||
    !(taskPrompt instanceof HTMLTextAreaElement)
  )
    throw new Error("SDK task fields must be editable native controls.");
  const user = userEvent.setup({ document });
  await user.selectOptions(view.getByRole("combobox"), "architect");
  await user.type(taskName, "Review");
  await user.type(taskPrompt, "Keep these instructions");
  expect(
    view
      .getByRole("button", { name: "Start background task" })
      .hasAttribute("disabled"),
  ).toBe(false);
  fireEvent.click(view.getByRole("button", { name: "Start background task" }));
  await view.findByText("The SDK action was not approved.");
  expect(taskName.value).toBe("Review");
  expect(taskPrompt.value).toBe("Keep these instructions");
  approved = true;
  fireEvent.click(view.getByRole("button", { name: "Start background task" }));
  await waitFor(() => expect(taskName.value).toBe(""));
  expect(taskPrompt.value).toBe("");
});
test("ACP form elicitation lets the user review defaults and submits typed values only on acceptance", async () => {
  const responses: { action: string; content?: Record<string, unknown> }[] = [];
  const view = render(
    <ElicitationReview
      request={{
        requestId: "form-1",
        sessionId: "session-1",
        mode: "form",
        message: "Choose the review settings.",
        requestedSchema: {
          type: "object",
          required: ["strategy", "attempts", "enabled"],
          properties: {
            strategy: {
              type: "string",
              title: "Strategy",
              enum: ["safe", "fast"],
              default: "safe",
            },
            attempts: {
              type: "integer",
              title: "Attempts",
              minimum: 1,
              default: 2,
            },
            enabled: { type: "boolean", title: "Enabled", default: false },
          },
        },
      }}
      onRespond={async (action, content) => {
        responses.push({ action, content });
      }}
    />,
  );
  expect(responses).toEqual([]);
  await userEvent
    .setup({ document })
    .selectOptions(
      view.getByRole("combobox", { name: /Strategy/ }),
      JSON.stringify("fast"),
    );
  const form = view
    .getByRole("spinbutton", { name: /Attempts/ })
    .closest("form");
  if (!form) throw new Error("Elicitation input has no review form.");
  fireEvent.submit(form);
  await waitFor(() =>
    expect(responses).toEqual([
      {
        action: "accept",
        content: { strategy: "fast", attempts: 2, enabled: false },
      },
    ]),
  );
});

test("ACP URL elicitation displays the destination but never opens it on mount or decline", async () => {
  const responses: { action: string; content?: Record<string, unknown> }[] = [];
  const request = {
    requestId: "url-1",
    mode: "url" as const,
    message: "Authorize in your browser.",
    url: "https://example.com/connect",
    elicitationId: "external-1",
  };
  const view = render(
    <ElicitationReview
      request={request}
      onRespond={async (action, content) => {
        responses.push({ action, content });
      }}
    />,
  );
  expect(view.getByText("example.com")).toBeTruthy();
  expect(view.getByText(request.url)).toBeTruthy();
  expect(calls).toEqual([]);
  fireEvent.click(view.getByRole("button", { name: "Decline" }));
  await waitFor(() =>
    expect(responses).toEqual([{ action: "decline", content: undefined }]),
  );
});

test("ACP elicitation uses the existing consent dialog and drops closed request state", async () => {
  const view = await workspace();
  await userEvent.type(draftInput(view), "Start form");
  fireEvent.click(view.getByRole("button", { name: "Send" }));
  await view.findByText("Unit-test reply");
  const sessionId = argument(
    calls.find((call) => call.command === "copilot_session_prompt")?.args,
    "sessionId",
  );
  const previous = invokeHandler;
  invokeHandler = (command, args) =>
    command === "copilot_elicitation_respond"
      ? Promise.resolve(null)
      : previous(command, args);
  await act(async () =>
    emit("copilot:elicitation-request", {
      requestId: "native-form",
      sessionId,
      mode: "form",
      message: "Review the values.",
      requestedSchema: {
        type: "object",
        properties: {
          note: { type: "string", title: "Note", default: "review only" },
        },
      },
    }),
  );
  const dialog = within(
    view.getByRole("dialog", { name: "Agent information request" }),
  );
  expect(dialog.getByRole("textbox", { name: "Note" })).toBeTruthy();
  fireEvent.click(dialog.getByRole("button", { name: "Cancel request" }));
  await waitFor(() =>
    expect(
      calls.some((call) => call.command === "copilot_elicitation_respond"),
    ).toBe(true),
  );
  expect(
    calls.find((call) => call.command === "copilot_elicitation_respond")?.args,
  ).toEqual({
    requestId: "native-form",
    action: "cancel",
    content: null,
  });
  expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).not.toContain(
    "review only",
  );
  await act(async () =>
    emit("copilot:elicitation-closed", { requestId: "native-form" }),
  );
  expect(
    view.queryByRole("dialog", { name: "Agent information request" }),
  ).toBeNull();
});

test("Harvest migrates the v1 ledger once, keeps its original backup and survives loss of WebView storage", async () => {
  const owner = "migration-agent";
  const original = JSON.stringify({
    version: 1,
    decisions: [
      [draftKey("draft"), { pinned: true, reviewed: false, dismissed: false }],
    ],
    references: [
      await makeFlashcard(owner, {
        known: 0,
        acp: 0,
        archiveOnly: 0,
        coverage: "complete",
      }),
    ],
  });
  let legacy: string | null = original;
  const mutations: HarvestMutation[] = [];
  const port = {
    read: async (agent: string) => nativeLedgers.get(agent) ?? null,
    mutate: async (agent: string, mutation: HarvestMutation) => {
      mutations.push(mutation);
      return mutateNativeLedger(agent, mutation);
    },
    legacy: () => legacy,
  };
  const first = createHarvestStore(port);
  const detach = first.subscribe(owner, () => {});
  await first.refresh(owner);
  expect(mutations).toEqual([{ kind: "migrate", ledger: original }]);
  expect(legacy).toBe(original);
  expect(first.snapshot(owner).references).toHaveLength(1);
  await first.mutate(owner, {
    kind: "promote-draft",
    conversation: "draft",
    canonicalSession: "copilot-cli:recorded",
  });
  expect(first.snapshot(owner).decisions.has(draftKey("draft"))).toBe(false);
  expect(
    first.snapshot(owner).decisions.get(sessionKey("copilot-cli:recorded"))
      ?.pinned,
  ).toBe(true);
  detach();

  legacy = null;
  const restarted = createHarvestStore(port);
  const dispose = restarted.subscribe(owner, () => {});
  await restarted.refresh(owner);
  expect(restarted.snapshot(owner).references).toHaveLength(1);
  expect(
    restarted.snapshot(owner).decisions.has(sessionKey("copilot-cli:recorded")),
  ).toBe(true);
  expect(mutations.filter((m) => m.kind === "migrate")).toHaveLength(1);
  dispose();
});

test("Harvest never replaces native memory with stale or unreadable localStorage", async () => {
  nativeLedgers.set("native", emptyLedger());
  let legacyReads = 0;
  const store = createHarvestStore({
    read: async (agent) => nativeLedgers.get(agent) ?? null,
    mutate: async () => {
      throw new Error("No mutation expected");
    },
    legacy: () => {
      legacyReads++;
      throw new Error("WebView storage denied");
    },
  });
  const dispose = store.subscribe("native", () => {});
  await store.refresh("native");
  expect(store.snapshot("native").available).toBe(true);
  expect(legacyReads).toBe(0);
  dispose();
});

test("invalid legacy memory blocks migration and mutations without erasing its source", async () => {
  for (const legacy of [
    "{",
    '{"version":99,"decisions":[],"references":[]}',
    '{"version":1,"decisions":[],"references":[],"instructions":"unexpected"}',
  ]) {
    let writes = 0;
    const store = createHarvestStore({
      read: async () => null,
      mutate: async () => {
        writes++;
        return emptyLedger();
      },
      legacy: () => legacy,
    });
    const dispose = store.subscribe("corrupt", () => {});
    await expect(store.refresh("corrupt")).rejects.toThrow();
    expect(store.snapshot("corrupt").available).toBe(false);
    expect(store.snapshot("corrupt").problem).toBeTruthy();
    await expect(
      store.mutate("corrupt", {
        kind: "toggle-decision",
        row: "row",
        field: "pinned",
      }),
    ).rejects.toThrow();
    expect(writes).toBe(0);
    dispose();
  }
});

test("native read failures are not disguised as empty memory or localStorage fallback", async () => {
  let legacyReads = 0;
  const store = createHarvestStore({
    read: async () => {
      throw { said: "Native ledger is unreadable" };
    },
    mutate: async () => {
      throw new Error("No mutation expected");
    },
    legacy: () => {
      legacyReads++;
      return emptyLedger();
    },
  });
  const dispose = store.subscribe("denied", () => {});
  await expect(store.refresh("denied")).rejects.toThrow(
    "Native ledger is unreadable",
  );
  expect(store.snapshot("denied")).toMatchObject({
    available: false,
    loading: false,
    problem: "Native ledger is unreadable",
  });
  expect(legacyReads).toBe(0);
  dispose();
});

test("failed migration retains the legacy source and a later attempt can succeed", async () => {
  const legacy = emptyLedger();
  let denied = true;
  const store = createHarvestStore({
    read: async (agent) => nativeLedgers.get(agent) ?? null,
    mutate: async (agent, mutation) => {
      if (denied) throw { said: "Ledger directory is read-only" };
      return mutateNativeLedger(agent, mutation);
    },
    legacy: () => legacy,
  });
  const dispose = store.subscribe("retry", () => {});
  await expect(store.refresh("retry")).rejects.toThrow("read-only");
  expect(nativeLedgers.has("retry")).toBe(false);
  expect(legacy).toBe(emptyLedger());
  denied = false;
  await store.refresh("retry");
  expect(store.snapshot("retry").available).toBe(true);
  expect(nativeLedgers.get("retry")).toBe(legacy);
  dispose();
});

test("Harvest serializes same-agent mutations and leaves other agents untouched", async () => {
  const store = createHarvestStore({
    read: async (agent) => nativeLedgers.get(agent) ?? null,
    mutate: async (agent, mutation) => {
      await Promise.resolve();
      return mutateNativeLedger(agent, mutation);
    },
    legacy: () => null,
  });
  const a = store.subscribe("agent-a", () => {});
  const b = store.subscribe("agent-b", () => {});
  await Promise.all([store.refresh("agent-a"), store.refresh("agent-b")]);
  await Promise.all([
    store.mutate("agent-a", {
      kind: "toggle-decision",
      row: "row",
      field: "pinned",
    }),
    store.mutate("agent-a", {
      kind: "toggle-decision",
      row: "row",
      field: "reviewed",
    }),
    store.mutate("agent-b", {
      kind: "toggle-decision",
      row: "row",
      field: "dismissed",
    }),
  ]);
  expect(store.snapshot("agent-a").decisions.get("row")).toEqual({
    pinned: true,
    reviewed: true,
    dismissed: false,
  });
  expect(store.snapshot("agent-b").decisions.get("row")).toEqual({
    pinned: false,
    reviewed: false,
    dismissed: true,
  });
  a();
  b();
});

test("a failed native mutation retains the last persisted state and does not poison the queue", async () => {
  let denied = true;
  const store = createHarvestStore({
    read: async (agent) => nativeLedgers.get(agent) ?? null,
    mutate: async (agent, mutation) => {
      if (denied) throw { said: "Native write failed" };
      return mutateNativeLedger(agent, mutation);
    },
    legacy: () => null,
  });
  const dispose = store.subscribe("write", () => {});
  await store.refresh("write");
  await expect(
    store.mutate("write", {
      kind: "toggle-decision",
      row: "row",
      field: "pinned",
    }),
  ).rejects.toThrow("Native write failed");
  expect(store.snapshot("write").decisions.size).toBe(0);
  expect(store.snapshot("write").problem).toBe("Native write failed");
  expect(nativeLedgers.has("write")).toBe(false);
  denied = false;
  await store.mutate("write", {
    kind: "toggle-decision",
    row: "row",
    field: "pinned",
  });
  expect(store.snapshot("write").decisions.get("row")?.pinned).toBe(true);
  expect(store.snapshot("write").problem).toBeNull();
  dispose();
});

test("native change notifications refresh only the owning agent and focus restores persisted state", async () => {
  const owner = fleetIdentity({ id: "architect", name: "Architect" });
  const chat = {
    ...createConversationDraft("C:\\workspace", "architect", "Architect"),
    title: "Native feedback",
  };
  writeImportedAgentIds(["architect"]);
  writeConversationWorkspace({
    ...emptyConversationWorkspace(),
    chats: [chat],
  });
  const view = await workspace();
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "Architect" })),
  );
  const panel = within(
    view.getByRole("region", { name: "Architect dashboard" }),
  );
  await waitFor(() =>
    expect(
      panel.getByRole("button", { name: "Pin" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  const before = calls.length;
  await act(async () => emit("darbot:harvest-changed", "another-agent"));
  expect(
    calls.slice(before).some((call) => call.command === "harvest_ledger_read"),
  ).toBe(false);
  mutateNativeLedger(owner, {
    kind: "toggle-decision",
    row: draftKey(chat.conversationId),
    field: "pinned",
  });
  await act(async () => emit("darbot:harvest-changed", owner));
  await panel.findByRole("button", { name: "Unpin" });
  mutateNativeLedger(owner, {
    kind: "toggle-decision",
    row: draftKey(chat.conversationId),
    field: "reviewed",
  });
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(
    await panel.findByRole("button", { name: "Undo reviewed" }),
  ).toBeTruthy();
});

test("failed promotion is visible after sending and never discards draft decisions or an opened conversation", async () => {
  const chat = {
    ...createConversationDraft("C:\\workspace", "", "Copilot CLI"),
    draft: "Keep my feedback",
  };
  const owner = fleetIdentity({ id: "", name: "Copilot CLI" });
  const original = JSON.stringify({
    version: 1,
    decisions: [
      [
        draftKey(chat.conversationId),
        { pinned: true, reviewed: false, dismissed: false },
      ],
    ],
    references: [],
  });
  nativeLedgers.set(owner, original);
  writeConversationWorkspace({
    ...emptyConversationWorkspace(),
    chats: [chat],
    activeConversationId: chat.conversationId,
  });
  let memoryReadOnly = true;
  invokeHandler = async (command, args) => {
    if (command === "harvest_ledger_mutate" && memoryReadOnly)
      throw { said: "Read-only memory" };
    return standardInvoke(command, args);
  };
  const view = await workspace();
  fireEvent.click(view.getByRole("button", { name: "Send" }));
  await view.findByText("Unit-test reply");
  expect(view.getByText(/Could not move draft review decisions/)).toBeTruthy();
  expect(nativeLedgers.get(owner)).toBe(original);
  await waitFor(() =>
    expect(
      saved().chats.find((c) => c.conversationId === chat.conversationId)
        ?.sessionId,
    ).toBeTruthy(),
  );
  memoryReadOnly = false;
  await userEvent.type(
    draftInput(view),
    "Retry the same recorded conversation",
  );
  fireEvent.click(view.getByRole("button", { name: "Send" }));
  await waitFor(() => {
    const raw = nativeLedgers.get(owner);
    if (!raw) throw new Error("Missing native feedback ledger.");
    const ledger: TestLedger = JSON.parse(raw);
    expect(
      ledger.decisions.some(([key]) => key === draftKey(chat.conversationId)),
    ).toBe(false);
    expect(
      ledger.decisions.some(
        ([key, feedback]) => key.startsWith('["session",') && feedback.pinned,
      ),
    ).toBe(true);
  });
});

test("reference saves wait for native persistence and a failed removal retains the reference", async () => {
  writeImportedAgentIds(["architect"]);
  const card = await makeFlashcard("source-agent", {
    known: 0,
    acp: 0,
    archiveOnly: 0,
    coverage: "complete",
  });
  let commit!: () => void;
  invokeHandler = async (command, args) => {
    if (
      command === "harvest_ledger_mutate" &&
      args &&
      typeof args === "object" &&
      "mutation" in args
    ) {
      const mutation = args.mutation as HarvestMutation;
      if (mutation.kind === "keep-reference")
        await new Promise<void>((resolve) => {
          commit = resolve;
        });
      if (mutation.kind === "forget-reference")
        throw { said: "Removal denied by storage" };
    }
    return standardInvoke(command, args);
  };
  const view = await workspace();
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "Architect" })),
  );
  const panel = within(
    view.getByRole("region", { name: "Architect dashboard" }),
  );
  fireEvent.click(
    await panel.findByText(/Agent flashcards · 0 local references/),
  );
  fireEvent.input(panel.getByRole("textbox", { name: /Paste a flashcard/ }), {
    target: { value: JSON.stringify(card) },
  });
  fireEvent.click(panel.getByRole("button", { name: "Validate and preview" }));
  fireEvent.click(
    panel.getByRole("button", { name: "Save as local reference" }),
  );
  await waitFor(() => expect(commit).toBeDefined());
  expect(
    panel.queryByText("Reference saved locally. Nothing sent."),
  ).toBeNull();
  expect(
    panel
      .getByRole("button", { name: "Save as local reference" })
      .hasAttribute("disabled"),
  ).toBe(true);
  await act(async () => commit());
  await panel.findByText("Reference saved locally. Nothing sent.");
  fireEvent.click(panel.getByText(/Imported reference ·/));
  fireEvent.click(panel.getByRole("button", { name: "Remove reference" }));
  await panel.findByText("Removal denied by storage", { selector: "p" });
  expect(panel.getByText(/Agent flashcards · 1 local references/)).toBeTruthy();
  expect(calls.some((call) => call.command === "copilot_session_prompt")).toBe(
    false,
  );
});
