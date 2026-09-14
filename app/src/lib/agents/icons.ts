import adk from "@/assets/agents/065_agent-adk.png";
import ag2 from "@/assets/agents/066_agent-ag2.png";
import agno from "@/assets/agents/067_agent-agno.png";
import bot from "@/assets/agents/068_agent-bot.png";
import claudeSdk from "@/assets/agents/069_agent-claude-sdk.png";
import computer from "@/assets/agents/070_agent-computer.png";
import crewai from "@/assets/agents/071_agent-crewai.png";
import langgraph from "@/assets/agents/072_agent-langgraph.png";
import langgraphAgui from "@/assets/agents/073_agent-langgraph-agui.png";
import langroid from "@/assets/agents/074_agent-langroid.png";
import llamaindex from "@/assets/agents/075_agent-llamaindex.png";
import mastra from "@/assets/agents/076_agent-mastra.png";
import microsoft from "@/assets/agents/077_agent-microsoft.png";
import pydanticAi from "@/assets/agents/078_agent-pydantic-ai.png";
import strands from "@/assets/agents/079_agent-strands.png";
import type { AgentProfile } from "./queries";

export const agentIcons = {
  "agent-adk": { src: adk, label: "Google ADK", alias: "Mint Seed" },
  "agent-ag2": { src: ag2, label: "AG2", alias: "Mint Council" },
  "agent-agno": { src: agno, label: "Agno", alias: "Mint Grove" },
  "agent-bot": { src: bot, label: "Bot", alias: "Mint Relay" },
  "agent-claude-sdk": {
    src: claudeSdk,
    label: "Claude Agent SDK",
    alias: "Mint Forge",
  },
  "agent-computer": {
    src: computer,
    label: "Computer",
    alias: "Mint Pilot",
  },
  "agent-crewai": { src: crewai, label: "CrewAI", alias: "Mint Crew" },
  "agent-langgraph": {
    src: langgraph,
    label: "LangGraph Bot",
    alias: "Mint Branch",
  },
  "agent-langgraph-agui": {
    src: langgraphAgui,
    label: "LangGraph AG-UI",
    alias: "Mint Stream",
  },
  "agent-langroid": {
    src: langroid,
    label: "Langroid",
    alias: "Mint Dialog",
  },
  "agent-llamaindex": {
    src: llamaindex,
    label: "LlamaIndex",
    alias: "Mint Index",
  },
  "agent-mastra": { src: mastra, label: "Mastra", alias: "Mint Flow" },
  "agent-microsoft": {
    src: microsoft,
    label: "Microsoft Agent Framework",
    alias: "Mint Mesh",
  },
  "agent-pydantic-ai": {
    src: pydanticAi,
    label: "Pydantic AI",
    alias: "Mint Contract",
  },
  "agent-strands": {
    src: strands,
    label: "AWS Strands",
    alias: "Mint Thread",
  },
} as const;

export type AgentIconId = keyof typeof agentIcons;
type AgentIcon = (typeof agentIcons)[AgentIconId];

export type AgentIconIdentity = Pick<
  AgentProfile,
  "id" | "name" | "avatarSeed"
> &
  Partial<Pick<AgentProfile, "endpoint">>;

function normalizedName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

const iconsById = new Map<string, AgentIcon>(Object.entries(agentIcons));
const iconsByName = new Map<string, AgentIcon>();
for (const icon of Object.values(agentIcons)) {
  iconsByName.set(normalizedName(icon.label), icon);
  iconsByName.set(normalizedName(icon.alias), icon);
}
const aliases: Array<[string, AgentIconId]> = [
  ["ADK", "agent-adk"],
  ["Claude SDK", "agent-claude-sdk"],
  // The desktop harness named "LangGraph" runs agent-langgraph-agui, not agent-langgraph.
  ["LangGraph", "agent-langgraph-agui"],
  ["LangGraph AGUI", "agent-langgraph-agui"],
  ["Microsoft", "agent-microsoft"],
  ["Strands", "agent-strands"],
  ["Strands Agents", "agent-strands"],
];
for (const [name, id] of aliases) {
  iconsByName.set(normalizedName(name), agentIcons[id]);
}

/** Visual identity only: never infer a framework from a port or a substring in a person's name. */
export function resolveAgentIcon(
  agent: AgentIconIdentity,
): AgentIcon | undefined {
  for (const id of [agent.avatarSeed, agent.id]) {
    const icon = iconsById.get(normalizedName(id));
    if (icon) return icon;
  }

  if (agent.endpoint && URL.canParse(agent.endpoint)) {
    const endpoint = new URL(agent.endpoint);
    if (endpoint.protocol === "http:" || endpoint.protocol === "https:") {
      const icon = iconsById.get(endpoint.hostname.split(".")[0] ?? "");
      if (icon) return icon;
    }
  }

  const name = normalizedName(agent.name);
  return iconsById.get(name) ?? iconsByName.get(name);
}
