import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  getSwarmIdentity,
  identityImageSource,
} from "../../shared/swarm-identity";
import type { Harness } from "./HarnessPicker";

type Invoke = (command: string, args?: unknown) => Promise<unknown>;

let invokeCalls: Array<{ command: string; args?: unknown }> = [];
let invokeHandler: Invoke = async () => {
  throw new Error("invoke handler was not installed");
};

mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => {
    invokeCalls.push({ command, args });
    return invokeHandler(command, args);
  },
}));

const { HarnessPicker } = await import("./HarnessPicker");

// A small, controlled row set rather than the real thirteen-row catalogue: enough to exercise
// "adapter directory matches a registered identity", "a different row matches a different
// identity" (so the first case cannot be a coincidence), and "nothing resolves" (the address-your-
// own row, whose real name is long enough that the existing Mark fallback already renders no tile
// for it — that must stay true).
const rows: Harness[] = [
  {
    id: "langgraph",
    name: "LangGraph",
    summary: "Default Bot",
    image: "agent-langgraph-agui",
    health_path: null,
    credential: "any-provider",
    maintainer: "first-party",
    mark: null,
    port: 8000,
  },
  {
    id: "crewai",
    name: "CrewAI",
    summary: "A crew of agents.",
    image: "agent-crewai",
    health_path: null,
    credential: "any-provider",
    maintainer: "first-party",
    mark: "crewai",
    port: 8010,
  },
  {
    id: "byo-url",
    name: "An agent you already run",
    summary: "Point darbot at any AG-UI endpoint.",
    image: null,
    health_path: null,
    credential: "their-endpoint",
    maintainer: "community",
    mark: null,
    port: null,
  },
];

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  invokeCalls = [];
  cleanup();
});
afterAll(() => GlobalRegistrator.unregister());

function rowImage(view: ReturnType<typeof render>, name: RegExp) {
  const radio = view.getByRole("radio", { name });
  return radio.closest("label")?.querySelector("img") ?? null;
}

async function renderPicker(onChoose: (choice: unknown) => void = () => {}) {
  invokeHandler = async (command) => {
    if (command === "harnesses") return rows;
    throw new Error(`unexpected command ${command}`);
  };

  let view!: ReturnType<typeof render>;
  await act(async () => {
    // Opened on a non-default choice so the disclosure holding the rows starts open, matching how
    // HarnessPicker itself decides to show the list without a click standing in for it here.
    view = render(
      <HarnessPicker
        chosen={{ id: "crewai" }}
        onChoose={onChoose}
        onContinue={() => {}}
        onBack={() => {}}
      />,
    );
  });
  await view.findByRole("radio", { name: /LangGraph/ });
  return view;
}

test("a row resolves to its registered identity's own token artwork instead of the vendor mark", async () => {
  const view = await renderPicker();

  const identity = getSwarmIdentity("agent-langgraph-agui");
  expect(identity).toBeDefined();

  const image = rowImage(view, /LangGraph/);
  expect(image).not.toBeNull();
  expect(image?.getAttribute("src")).toBe(
    identityImageSource(identity!, 32, "token"),
  );
  // Decorative like the vendor mark it replaces: the name is already read from tile-name text.
  expect(image?.getAttribute("alt")).toBe("");
  expect(image?.getAttribute("aria-hidden")).toBe("true");
  expect(image?.closest(".mark-tile")).not.toBeNull();
});

test("resolution is per row, not one hardcoded identity", async () => {
  const view = await renderPicker();

  const identity = getSwarmIdentity("agent-crewai");
  expect(identity).toBeDefined();

  const image = rowImage(view, /CrewAI/);
  expect(image?.getAttribute("src")).toBe(
    identityImageSource(identity!, 32, "token"),
  );
});

test("a row with no registered identity keeps today's vendor mark fallback", async () => {
  const view = await renderPicker();

  const radio = view.getByRole("radio", { name: /An agent you already run/ });
  // Mark itself renders nothing for an unrecognised name this long; that must still hold, not just
  // "no swarm image".
  expect(radio.closest("label")?.querySelector(".mark-tile")).toBeNull();
});

test("choosing a row is unaffected by which artwork it shows", async () => {
  const choices: unknown[] = [];
  const view = await renderPicker((choice) => choices.push(choice));

  await userEvent.click(view.getByRole("radio", { name: /LangGraph/ }));

  expect(choices).toEqual([{ id: "langgraph" }]);
  expect(invokeCalls.map((call) => call.command)).toEqual(["harnesses"]);
});
