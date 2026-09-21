import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { AgentAvatar } from "@/components/agents/agent-avatar";
import { AgentCard } from "@/components/agents/agent-card";
import { type AgentIconIdentity, agentIcons } from "@/lib/agents/icons";
import type { AgentProfile } from "@/lib/agents/queries";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const custom: AgentIconIdentity = {
  id: "coworker_123",
  name: "Expense Manager",
  avatarSeed: "expense-manager",
  endpoint: null,
};

test("a framework avatar uses its uploaded icon and announces the coworker's actual name once", () => {
  const view = render(
    <AgentAvatar agent={{ ...custom, avatarSeed: "agent-adk" }} size={80} />,
  );
  const image = view.getByRole("img", { name: custom.name });
  expect(view.getAllByRole("img")).toHaveLength(1);
  expect(image.getAttribute("src")).toBe(agentIcons["agent-adk"].src);
  expect(image.getAttribute("width")).toBe("80");
  expect(image.getAttribute("height")).toBe("80");
  expect(image.className).toContain("bg-black");
});

test("an unknown coworker keeps the same seeded drawing and accessible name", () => {
  const view = render(<AgentAvatar agent={custom} size={36} />);
  // React assigns new mask/filter IDs on remount; the geometry and colors must stay the same.
  const drawing = () =>
    Array.from(
      view.container.querySelectorAll("svg path, svg rect"),
      (shape) => [
        shape.tagName,
        shape.getAttribute("d"),
        shape.getAttribute("fill"),
        shape.getAttribute("transform"),
      ],
    );
  const actual = drawing();
  expect(actual.length).toBeGreaterThan(0);
  view.rerender(
    <AbstractAvatar name={custom.name} seed={custom.avatarSeed} size={36} />,
  );
  expect(actual).toEqual(drawing());
  expect(view.getAllByRole("img")).toHaveLength(1);
  expect(view.getByRole("img", { name: custom.name })).toBeTruthy();
  expect(view.container.querySelector("img")).toBeNull();
});

test("a failed icon is reported and falls back, without poisoning the next coworker's icon", () => {
  const report = spyOn(console, "error").mockImplementation(() => {});
  try {
    const view = render(
      <AgentAvatar agent={{ ...custom, avatarSeed: "agent-adk" }} />,
    );
    fireEvent.error(view.getByRole("img", { name: custom.name }));
    expect(report).toHaveBeenCalledWith(
      "[agents] could not load coworker icon",
      "Google ADK",
    );
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.getByRole("img", { name: custom.name })).toBeTruthy();

    view.rerender(
      <AgentAvatar agent={{ ...custom, avatarSeed: "agent-mastra" }} />,
    );
    expect(
      view.getByRole("img", { name: custom.name }).getAttribute("src"),
    ).toBe(agentIcons["agent-mastra"].identity.token.png256);
  } finally {
    report.mockRestore();
  }
});

function profile(avatarSeed: string): AgentProfile {
  return {
    ...custom,
    avatarSeed,
    title: "Finance",
    roleDescription: "Review receipts and prepare reimbursement reports.",
    visibility: "private",
    endpoint: null,
    builtIn: true,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    systemOwned: false,
    canManage: true,
    mine: true,
  };
}

test("the picker shows the complete icon without changing the card's text or size", () => {
  const agent = profile("agent-adk");
  const view = render(<AgentCard agent={agent} />);
  const image = view.container.querySelector("img");
  expect(image?.getAttribute("src")).toBe(agentIcons["agent-adk"].src);
  expect(image?.getAttribute("width")).toBe("80");
  expect(image?.closest('[aria-hidden="true"]')).toBeTruthy();
  expect(view.queryByRole("img")).toBeNull();
  expect(view.getByText(agent.name)).toBeTruthy();
  expect(view.getByText(agent.roleDescription)).toBeTruthy();
  expect(view.container.firstElementChild?.className).toContain("h-[180px]");
  expect(view.container.firstElementChild?.className).toContain("w-[144px]");
});

test("a custom picker card retains its large generated background avatar", () => {
  const view = render(<AgentCard agent={profile(custom.avatarSeed)} />);
  expect(view.container.querySelector("img")).toBeNull();
  expect(view.container.querySelector("svg")?.getAttribute("width")).toBe(
    "250",
  );
  expect(view.container.querySelector(".bg-background\\/40")).toBeTruthy();
});

test.each([16, 24, 32, 48])(
  "%spx identities use exact token artwork without clipping or CSS recoloring",
  (size) => {
    const view = render(
      <AgentAvatar
        agent={{ ...custom, avatarSeed: "agent-adk" }}
        size={size}
      />,
    );
    const image = view.getByRole("img", { name: custom.name });
    expect(image.getAttribute("src")).toBe(
      agentIcons["agent-adk"].identity.token.png256,
    );
    expect(image.getAttribute("data-swarm-kind")).toBe("token");
    expect(image.getAttribute("width")).toBe(String(size));
    expect(image.className).toContain("object-contain");
    expect(image.className).not.toContain("rounded-full");
    expect(image.className).not.toContain("object-cover");
    expect(image.getAttribute("style")).toBeNull();
  },
);

test("a 64px identity shows the full source avatar and explicit artwork choice remains available", () => {
  const agent = { ...custom, avatarSeed: "agent-adk" };
  const view = render(<AgentAvatar agent={agent} size={64} />);
  expect(view.getByRole("img").getAttribute("src")).toBe(
    agentIcons["agent-adk"].src,
  );
  expect(view.getByRole("img").getAttribute("data-swarm-kind")).toBe("avatar");
  view.rerender(<AgentAvatar agent={agent} kind="token" size={64} />);
  expect(view.getByRole("img").getAttribute("src")).toBe(
    agentIcons["agent-adk"].identity.token.png256,
  );
});
