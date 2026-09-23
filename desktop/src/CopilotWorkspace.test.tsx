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
import type { CopilotSession, CopilotStatus } from "./copilot-types";
import {
  createConversationDraft,
  emptyConversationWorkspace,
  readConversationWorkspace,
  WORKSPACE_STORAGE_KEY,
  writeConversationWorkspace,
} from "./copilot-workspace-store";

type Invocation = { command: string; args?: unknown };
type Listener = (event: { payload: unknown }) => void;
const listeners = new Map<string, Set<Listener>>();
let calls: Invocation[] = [];
let invokeHandler: (command: string, args?: unknown) => Promise<unknown>;
let runtimeSequence = 0;

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

function argument(args: unknown, key: string): string | null {
  if (!args || typeof args !== "object" || !(key in args)) return null;
  const value = Object.entries(args).find(([name]) => name === key)?.[1];
  return typeof value === "string" ? value : null;
}

function emit(name: string, payload: unknown) {
  for (const listener of listeners.get(name) ?? []) listener({ payload });
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
  calls = [];
  listeners.clear();
  runtimeSequence = 0;
  invokeHandler = standardInvoke;
});
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

async function workspace() {
  const view = render(<CopilotWorkspace onBack={() => {}} />);
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
  expect(saved().activeConversationId).toBe(firstId);
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

test("agent chats collapse behind a disclosure arrow and the choice persists", async () => {
  const drafts = Array.from({ length: 2 }, (_, index) => ({
    ...createConversationDraft("C:\\workspace", "architect", "Architect"),
    title: `Draft ${index}`,
  }));
  writeConversationWorkspace({
    ...emptyConversationWorkspace(),
    chats: drafts,
  });
  const view = await workspace();
  const toggle = view.getByRole("button", { name: "Show Architect chats" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(view.queryByRole("button", { name: "Draft: Draft 0" })).toBeNull();

  fireEvent.click(toggle);
  await view.findByRole("button", { name: "Draft: Draft 0" });
  expect(
    view
      .getByRole("button", { name: "Hide Architect chats" })
      .getAttribute("aria-expanded"),
  ).toBe("true");

  cleanup();
  const remounted = await workspace();
  await remounted.findByRole("button", { name: "Draft: Draft 0" });
  expect(
    remounted
      .getByRole("button", { name: "Hide Architect chats" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
});

test("an agent with no chats cannot be expanded", async () => {
  const view = await workspace();
  const toggle = view.getByRole("button", { name: "Show Copilot CLI chats" });
  expect(toggle.hasAttribute("disabled")).toBe(true);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(view.getByText("No chats yet")).toBeDefined();
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
