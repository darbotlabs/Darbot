import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type AgentIconId,
  type AgentIconIdentity,
  agentIcons,
  resolveAgentIcon,
} from "@/lib/agents/icons";

const custom: AgentIconIdentity = {
  id: "coworker_123",
  name: "Expense Manager",
  avatarSeed: "expense-manager",
  endpoint: null,
};

const expectedIds = [
  "agent-adk",
  "agent-ag2",
  "agent-agno",
  "agent-bot",
  "agent-claude-sdk",
  "agent-computer",
  "agent-crewai",
  "agent-langgraph",
  "agent-langgraph-agui",
  "agent-langroid",
  "agent-llamaindex",
  "agent-mastra",
  "agent-microsoft",
  "agent-pydantic-ai",
  "agent-strands",
] satisfies AgentIconId[];

describe("shipped agent icons", () => {
  test("contains exactly the 15 requested identities, not the proposed specialists", () => {
    expect(Object.keys(agentIcons)).toEqual(expectedIds);
    expect(
      new Set(Object.values(agentIcons).map((icon) => icon.src)).size,
    ).toBe(15);
  });

  test.each(expectedIds)(
    "%s binds by canonical seed, id, name, and Mint alias",
    (id) => {
      const icon = agentIcons[id];
      expect(resolveAgentIcon({ ...custom, avatarSeed: id })).toBe(icon);
      expect(resolveAgentIcon({ ...custom, id })).toBe(icon);
      expect(resolveAgentIcon({ ...custom, name: id })).toBe(icon);
      expect(resolveAgentIcon({ ...custom, name: icon.alias })).toBe(icon);
      expect(resolveAgentIcon({ ...custom, name: icon.label })).toBe(icon);
    },
  );

  test.each(expectedIds)(
    "%s ships a real 256px PNG in the app bundle",
    (id) => {
      const index = expectedIds.indexOf(id) + 65;
      const image = readFileSync(
        new URL(
          `../src/assets/agents/${String(index).padStart(3, "0")}_${id}.png`,
          import.meta.url,
        ),
      );
      expect(image.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(image.readUInt32BE(16)).toBe(256);
      expect(image.readUInt32BE(20)).toBe(256);
    },
  );
});

describe("coworker icon resolution", () => {
  test("an explicit avatar seed wins over id, endpoint, and name", () => {
    expect(
      resolveAgentIcon({
        id: "agent-mastra",
        avatarSeed: "agent-adk",
        endpoint: "http://agent-crewai:4202",
        name: "Pydantic AI",
      }),
    ).toBe(agentIcons["agent-adk"]);
  });

  test("the canonical id wins over endpoint and name", () => {
    expect(
      resolveAgentIcon({
        ...custom,
        id: "agent-langgraph",
        endpoint: "http://agent-langgraph-agui:4206",
        name: "LangGraph",
      }),
    ).toBe(agentIcons["agent-langgraph"]);
  });

  test("a canonical endpoint host binds an arbitrarily named coworker", () => {
    for (const endpoint of [
      "http://agent-crewai:4202/ag-ui",
      "https://agent-crewai.internal.example/run",
    ]) {
      expect(resolveAgentIcon({ ...custom, endpoint })).toBe(
        agentIcons["agent-crewai"],
      );
    }
  });

  test("framework names match whole labels with normalized casing and spacing", () => {
    expect(resolveAgentIcon({ ...custom, name: "  GOOGLE   ADK " })).toBe(
      agentIcons["agent-adk"],
    );
    expect(resolveAgentIcon({ ...custom, name: "claude-agent-sdk" })).toBe(
      agentIcons["agent-claude-sdk"],
    );
    expect(resolveAgentIcon({ ...custom, name: "Pydantic_AI" })).toBe(
      agentIcons["agent-pydantic-ai"],
    );
    expect(resolveAgentIcon({ ...custom, name: "AWS Strands" })).toBe(
      agentIcons["agent-strands"],
    );
  });

  test("the desktop LangGraph label resolves to its AG-UI harness", () => {
    expect(resolveAgentIcon({ ...custom, name: "LangGraph" })).toBe(
      agentIcons["agent-langgraph-agui"],
    );
    expect(resolveAgentIcon({ ...custom, name: "Mint Branch" })).toBe(
      agentIcons["agent-langgraph"],
    );
  });

  test("custom agents and proposed specialist identities keep their generated avatar", () => {
    expect(resolveAgentIcon(custom)).toBeUndefined();
    for (const name of [
      "My LangGraph assistant",
      "Microsoft Finance",
      "agent-mcp",
      "constructor",
      "toString",
      "__proto__",
    ]) {
      expect(resolveAgentIcon({ ...custom, name })).toBeUndefined();
    }
  });

  test("ports, paths, invalid endpoints, and vendor domains are not framework evidence", () => {
    for (const endpoint of [
      "not a URL",
      "http://localhost:4208",
      "https://example.com/agent-adk",
      "https://example.com?host=agent-adk",
      "https://agent-adk@example.com",
      "https://my-agent-adk.example.com",
      "https://microsoft.com/run",
      "file://agent-adk/run",
      "javascript:alert('agent-adk')",
    ]) {
      expect(resolveAgentIcon({ ...custom, endpoint })).toBeUndefined();
    }
  });
});
