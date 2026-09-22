/**
 * Darbot-scoped preferences for the Copilot workspace: theme, last working folder, last selected
 * agent, imported agent references, legacy chat metadata, last runtime, and scrolling.
 * Versioned conversation identities and local drafts are owned by copilot-workspace-store.ts.
 * Legacy references remain here for non-destructive migration.
 *
 * Chat entries contain session IDs, titles, agents and folders, never message bodies.
 * Never stores a Copilot token, credential, or transcript.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import type { CopilotHistorySession } from "./copilot-types";

type LegacyWorkspaceChat = CopilotHistorySession & { title: string };

const STORAGE_KEY = "darbot:copilot:preferences";

export type ThemePreference = "dark" | "light" | "system";

type StoredPreferences = {
  theme: ThemePreference;
  cwd: string | null;
  agentId: string;
  autoScroll: boolean;
  snapScroll: boolean;
  openCopilot: boolean;
  importedAgentIds: string[] | null;
  workspaceChats: LegacyWorkspaceChat[];
};

const DEFAULTS: StoredPreferences = {
  theme: "dark",
  cwd: null,
  agentId: "",
  autoScroll: true,
  snapScroll: true,
  openCopilot: false,
  importedAgentIds: null,
  workspaceChats: [],
};

function isWorkspaceChat(value: unknown): value is LegacyWorkspaceChat {
  if (!value || typeof value !== "object") return false;
  return (
    "sessionId" in value &&
    typeof value.sessionId === "string" &&
    "cwd" in value &&
    typeof value.cwd === "string" &&
    "agentId" in value &&
    typeof value.agentId === "string" &&
    "agentName" in value &&
    typeof value.agentName === "string" &&
    "title" in value &&
    typeof value.title === "string" &&
    (!("updatedAt" in value) ||
      value.updatedAt == null ||
      typeof value.updatedAt === "string")
  );
}

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "dark" || value === "light" || value === "system";
}

/** Reads the whole blob, tolerating a missing key, unavailable storage, or malformed JSON. */
function readAll(): StoredPreferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULTS };
    const candidate = parsed as Partial<StoredPreferences>;
    return {
      theme: isThemePreference(candidate.theme)
        ? candidate.theme
        : DEFAULTS.theme,
      cwd:
        typeof candidate.cwd === "string" && candidate.cwd.length > 0
          ? candidate.cwd
          : null,
      agentId:
        typeof candidate.agentId === "string"
          ? candidate.agentId
          : DEFAULTS.agentId,
      autoScroll:
        typeof candidate.autoScroll === "boolean"
          ? candidate.autoScroll
          : DEFAULTS.autoScroll,
      snapScroll:
        typeof candidate.snapScroll === "boolean"
          ? candidate.snapScroll
          : DEFAULTS.snapScroll,
      openCopilot: candidate.openCopilot === true,
      importedAgentIds: Array.isArray(candidate.importedAgentIds)
        ? [
            ...new Set(
              candidate.importedAgentIds.filter(
                (id): id is string => typeof id === "string" && id.length > 0,
              ),
            ),
          ]
        : null,
      workspaceChats: Array.isArray(candidate.workspaceChats)
        ? candidate.workspaceChats.filter(isWorkspaceChat)
        : [],
    };
  } catch (error) {
    console.warn("Darbot could not read saved preferences.", error);
    return { ...DEFAULTS };
  }
}

/** Merges a partial update into the stored blob. Storage being unavailable is not fatal. */
function writeAll(patch: Partial<StoredPreferences>): void {
  try {
    const next = { ...readAll(), ...patch };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    console.warn(
      "Darbot preferences apply to this window but could not be saved.",
      error,
    );
  }
}

export function readThemePreference(): ThemePreference {
  return readAll().theme;
}

export function writeThemePreference(value: ThemePreference): void {
  writeAll({ theme: value });
}

export function readStoredCwd(): string | null {
  return readAll().cwd;
}

export function writeStoredCwd(value: string): void {
  writeAll({ cwd: value });
}

export function readStoredAgentId(): string {
  return readAll().agentId;
}

export function writeStoredAgentId(value: string): void {
  writeAll({ agentId: value });
}

export function readAutoScrollPreference(): boolean {
  return readAll().autoScroll;
}

export function writeAutoScrollPreference(value: boolean): void {
  writeAll({ autoScroll: value });
}

export function readSnapScrollPreference(): boolean {
  return readAll().snapScroll;
}

export function writeSnapScrollPreference(value: boolean): void {
  writeAll({ snapScroll: value });
}

export function readOpenCopilot(): boolean {
  return readAll().openCopilot;
}

export function writeOpenCopilot(value: boolean): void {
  writeAll({ openCopilot: value });
}

export function readImportedAgentIds(): string[] | null {
  return readAll().importedAgentIds;
}

export function writeImportedAgentIds(value: string[]): void {
  writeAll({ importedAgentIds: [...new Set(value)] });
}

export function readWorkspaceChats(): LegacyWorkspaceChat[] {
  return readAll().workspaceChats;
}

export function writeWorkspaceChats(value: LegacyWorkspaceChat[]): void {
  writeAll({
    workspaceChats: value.map(
      ({ sessionId, cwd, agentId, agentName, title, updatedAt }) => ({
        sessionId,
        cwd,
        agentId,
        agentName,
        title,
        updatedAt,
      }),
    ),
  });
}

function systemPrefersDark(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/** "system" resolves at read time; "dark"/"light" are already resolved. */
export function resolveTheme(preference: ThemePreference): "dark" | "light" {
  if (preference === "system") return systemPrefersDark() ? "dark" : "light";
  return preference;
}

/**
 * Applies a theme preference to the document: a `data-copilot-theme` attribute that styles.css
 * keys off — for the setup window and the Copilot workspace alike, dark by default — plus the
 * native `color-scheme` hint so browser-drawn chrome (scrollbars, the permission `<dialog>`
 * backdrop, form controls) matches without a flash.
 *
 * Also pushes the same choice to the native window so the OS-drawn titlebar follows it: the
 * resolved value for an explicit "dark"/"light" choice, or `null` for "system" so Tauri leaves the
 * window tracking the OS theme itself rather than freezing it at whatever it resolved to here.
 *
 * The document is always updated, synchronously, before the native call: the CSS theme lands
 * regardless of what the window does. The native step is awaited and its failure is left to
 * propagate (rather than swallowed here) so a caller that can show something — the workspace does,
 * on mount and on every explicit change — surfaces it instead of pretending it worked. A caller
 * with nowhere to show it may still choose to `.catch()` and only log.
 */
export async function applyTheme(preference: ThemePreference): Promise<void> {
  const resolved = resolveTheme(preference);
  document.documentElement.dataset.copilotTheme = resolved;
  document.documentElement.style.colorScheme = resolved;
  // getCurrentWindow() reaches into window.__TAURI_INTERNALS__, which is absent under a plain
  // browser dev preview or the test environment, and throws synchronously rather than rejecting;
  // being inside this async function turns that into the same rejection a caller already awaits.
  await getCurrentWindow().setTheme(preference === "system" ? null : resolved);
}

/**
 * Called once, before the first paint, from main.tsx. Applies whatever theme is already stored
 * (dark by default) and keeps a "system" choice live as the OS preference changes afterward.
 * There is no UI yet at this point to show a failure in, so it is logged rather than dropped; the
 * workspace re-applies the current theme on its own mount and surfaces a failure there properly.
 */
export function bootstrapTheme(): void {
  applyTheme(readThemePreference()).catch((error) => {
    console.warn("Darbot: could not sync the native window theme.", error);
  });
  if (typeof window.matchMedia !== "function") return;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", () => {
    if (readThemePreference() !== "system") return;
    applyTheme("system").catch((error) => {
      console.warn("Darbot: could not sync the native window theme.", error);
    });
  });
}
