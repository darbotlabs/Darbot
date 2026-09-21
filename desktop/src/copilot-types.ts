/**
 * Shared TypeScript types for the Copilot ACP contracts exposed by the Tauri backend.
 *
 * One definition per shape, imported by both ProviderPicker (the pre-connection readiness check)
 * and CopilotWorkspace (the live agent workspace), so the two surfaces that talk to
 * `copilot_status` / `copilot_inventory` never drift into two different ideas of what those calls
 * return. `CopilotStatus` mirrors the shape already relied on before this change; the inventory
 * item shapes below replace the previous `unknown[]` placeholders with the fields the backend
 * actually sends.
 */

export type CopilotCapabilities = {
  loadSession: boolean;
  resumeSession: boolean;
  listSessions: boolean;
  closeSession: boolean;
  deleteSession: boolean;
  promptImage: boolean;
  promptEmbeddedContext: boolean;
  mcpHttp: boolean;
  mcpSse: boolean;
};

export type CopilotStatus = {
  version: string;
  protocolVersion: number;
  authentication: "ready" | "required" | "unknown";
  capabilities: CopilotCapabilities;
  sessionCount: number;
  hasMoreSessions: boolean;
  warnings: string[];
};

export type CopilotAgentSummary = {
  id: string;
  name: string;
  description?: string | null;
  model?: string | null;
};

export type CopilotAgentCatalog = {
  agents: CopilotAgentSummary[];
  warnings: string[];
};

export type CopilotSkill = {
  name: string;
  description?: string | null;
  enabled: boolean;
  source?: string | null;
};

export type CopilotPlugin = {
  name: string;
  marketplace?: string | null;
  version?: string | null;
  enabled: boolean;
  source?: string | null;
};

export type CopilotMcpServer = {
  name: string;
  enabled: boolean;
  source?: string | null;
  transport?: string | null;
  toolCount: number;
};

export type CopilotInventory = {
  agents: CopilotAgentSummary[];
  skills: CopilotSkill[];
  plugins: CopilotPlugin[];
  mcpServers: CopilotMcpServer[];
  warnings: string[];
};

/** What `copilot_workspace` and `copilot_pick_directory` both resolve to. */
export type CopilotWorkspaceLocation = {
  cwd: string;
  home: string;
};

export type ConfigOptionValue = {
  value: string;
  name: string;
  description?: string | null;
  _meta?: { copilotEnablement?: string | null } | null;
};

export type ConfigOption = {
  id: string;
  name?: string | null;
  currentValue: string;
  options: ConfigOptionValue[];
};

/**
 * A value counts as disabled only when the runtime explicitly said so. Absence of `_meta` or of
 * `copilotEnablement` is not a disabled signal — only a real, non-"enabled" string is.
 */
export function isConfigValueDisabled(value: ConfigOptionValue): boolean {
  const state = value._meta?.copilotEnablement;
  return typeof state === "string" && state !== "enabled";
}

export function findConfigOption(
  options: ConfigOption[] | null | undefined,
  id: string,
): ConfigOption | null {
  return options?.find((option) => option.id === id) ?? null;
}

export type CopilotSession = {
  sessionId: string;
  cwd: string;
  modes?: unknown;
  configOptions?: ConfigOption[];
};

export type CopilotSessionSummary = {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
};

export type CopilotSessionsPage = {
  sessions: CopilotSessionSummary[];
  nextCursor?: string | null;
};

export type CopilotHistorySession = CopilotSessionSummary & {
  agentId: string;
  agentName: string;
};

export type CopilotWorkspaceChat = CopilotHistorySession & {
  title: string;
};

export type CopilotHistory = {
  sessions: CopilotHistorySession[];
  agents: { id: string; name: string; conversationCount: number }[];
  warnings: string[];
  timings?: {
    connectionMs: number;
    listingMs: number;
    indexingMs: number;
    firstPageMs: number | null;
    totalMs: number;
  };
};

export type CopilotHistoryProgress = {
  requestId: string | null;
  phase: "listing" | "indexing";
  loaded: number;
  sessions?: CopilotHistorySession[];
};

export type CopilotPermissionOption = {
  optionId: string;
  name: string;
  kind: string;
};

export type CopilotPermissionRequest = {
  requestId: string;
  sessionId: string;
  toolCall: unknown;
  options: CopilotPermissionOption[];
};

export type CopilotSessionUpdate = {
  sessionId: string;
  update: Record<string, unknown>;
};

export type CopilotAvailableCommand = {
  name: string;
  description?: string | null;
  input?: { hint?: string | null } | null;
};

export type CopilotPromptResult = {
  stopReason: string;
};

export type CopilotToolActivity = {
  title: string;
  status?: string;
  input?: unknown;
  output?: unknown;
};

export function mergeToolActivity(
  previous: CopilotToolActivity | undefined,
  update: Partial<CopilotToolActivity>,
): CopilotToolActivity {
  return {
    title: update.title?.trim() || previous?.title || "Tool call",
    status: update.status ?? previous?.status,
    input: update.input ?? previous?.input,
    output: update.output ?? previous?.output,
  };
}
