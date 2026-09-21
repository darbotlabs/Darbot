/** Presentation bindings only. Adapter IDs, protocols, endpoints, and grants are unchanged. */
export const frameworkBindings = [
  { agentId: "agent-adk", label: "Google ADK", aliases: ["ADK"] },
  { agentId: "agent-ag2", label: "AG2", aliases: [] },
  { agentId: "agent-agno", label: "Agno", aliases: [] },
  { agentId: "agent-bot", label: "Bot", aliases: [] },
  {
    agentId: "agent-claude-sdk",
    label: "Claude Agent SDK",
    aliases: ["Claude SDK"],
  },
  { agentId: "agent-computer", label: "Computer", aliases: [] },
  { agentId: "agent-crewai", label: "CrewAI", aliases: [] },
  { agentId: "agent-langgraph", label: "LangGraph Bot", aliases: [] },
  {
    agentId: "agent-langgraph-agui",
    label: "LangGraph AG-UI",
    // The desktop's LangGraph harness runs this adapter, not agent-langgraph.
    aliases: ["LangGraph", "LangGraph AGUI"],
  },
  { agentId: "agent-langroid", label: "Langroid", aliases: [] },
  { agentId: "agent-llamaindex", label: "LlamaIndex", aliases: [] },
  { agentId: "agent-mastra", label: "Mastra", aliases: [] },
  {
    agentId: "agent-microsoft",
    label: "Microsoft Agent Framework",
    aliases: ["Microsoft"],
  },
  { agentId: "agent-pydantic-ai", label: "Pydantic AI", aliases: [] },
  {
    agentId: "agent-strands",
    label: "AWS Strands",
    aliases: ["Strands", "Strands Agents"],
  },
] as const;

export type FrameworkIdentityId = (typeof frameworkBindings)[number]["agentId"];

export const frameworkIdentityIds: readonly FrameworkIdentityId[] =
  frameworkBindings.map((binding) => binding.agentId);
